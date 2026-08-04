import {
  MSG, BTN, EKIND, ESTATE, Writer, Reader, writeInput, writeHello,
  PROTOCOL_VERSION, REFUSE, readRefuse, REFUSE_DETAIL_MAX,
} from './Protocol.js';
import { ClientTransport } from './Transport.js';
import { SnapshotBuffer, ClockSync, INTERP_DELAY, lerpAngle } from './Snapshot.js';

/**
 * Non-authoritative client.
 *
 * Runs the same Engine, but with `ctx.authority === false`, which every
 * simulation-owning system checks before doing anything the host owns
 * (spawning, damage resolution, item rolls, stage transitions). The client's
 * job is: sample input, predict its own player, interpolate everyone else, and
 * play the effects the host tells it about.
 *
 * Prediction covers only the local player's movement. Combat is deliberately
 * NOT predicted — a mispredicted hit that gets rolled back reads far worse than
 * one that simply arrives 60ms late, and prediction of damage is where most
 * amateur netcode turns into visible lying.
 */

const INPUT_HISTORY = 128;
// Above this, a correction is a genuine desync (or a teleport/knockback the
// client never saw) and should snap. Below it, the error is smoothed away over
// a few frames so small corrections are invisible.
const SNAP_THRESHOLD = 2.0;

export class NetClient {
  constructor() {
    this.transport = new ClientTransport();
    this.buffer = new SnapshotBuffer();
    this.clock = new ClockSync();
    this.writer = new Writer(256);
    this.peer = null;

    this.tick = 0;
    this.myPeerId = -1;
    this.myNetId = 0;
    this.connected = false;

    // Unacknowledged commands, replayed after every correction.
    this.history = [];
    // Residual prediction error, bled off visually rather than snapped.
    this.errorX = 0; this.errorY = 0; this.errorZ = 0;

    this.views = new Map();      // netId -> view object
    this.viewFactories = new Map();
    this._sample = {};
    this._pingAccum = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.net = this;
    ctx.authority = false;
    ctx.netRole = 'client';
    // The tick origin changes here. `fixedUpdate` below stamps commands from
    // `this.tick`, which opens at 0, while the player's `_lastCmdTick` still
    // holds however far single-player got — and `Player.applyCommand` reads a
    // tick at or below that mark as a replay. Without this reset a joining
    // client spends its first `_lastCmdTick` ticks with dead projectiles, dead
    // placeables, no scheduled volleys and no jump impulse: 364 ticks, 6.1 s,
    // measured off a 5 s idle, and it scales with how long they played first.
    // Reset at the role transition rather than at WELCOME so it is done before
    // the first command is built.
    ctx.player?.resetCommandEpoch?.();
  }

  /** A view factory turns a replicated entity into something renderable. */
  registerViewFactory(kind, factory) { this.viewFactories.set(kind, factory); }

  async join(inviteBlob) {
    const { blob, connected } = await this.transport.join(inviteBlob);
    connected.then((peer) => {
      this.peer = peer;
      this.connected = true;
      // Say who we are before anything else. The host has already built this
      // peer's pawn out of its *own* survivor by the time this lands — it spawns
      // on channel open, which is strictly before the first byte — so this is
      // what re-stats it. Reliable channel: a dropped HELLO would leave the peer
      // playing the host's survivor for the whole session, silently.
      this._sendHello();
      peer.onMessage = (data) => this._onMessage(data);
      peer.onClose = () => { this.connected = false; this.ctx.events.emit('netDisconnected', {}); };
    });
    return blob; // caller shows this to the player to send back to the host
  }

  /**
   * The survivor this machine is actually playing.
   *
   * `ctx.player.survivorId` rather than `ctx.survivorId`: the former is what the
   * local simulation is running on right now, the latter is what the menu last
   * wrote. They agree in every normal flow, and where they do not, the one
   * predicting our movement is the one the host has to simulate.
   */
  _sendHello() {
    const id = this.ctx?.player?.survivorId ?? this.ctx?.survivorId ?? '';
    const w = new Writer(64);
    writeHello(w, { survivorId: id });
    this.peer?.sendEvent(w.bytes());
  }

  /**
   * The client half of the host's isolation, for the same reason and with the
   * same shape (`NetHost._onMessage`): `readEntity` and `r.json()` size their
   * reads from the wire exactly as `readHello` does, and this method is wired
   * straight into `ch.onmessage` with nothing else on the path. A malformed
   * snapshot must cost one snapshot, not the session — and it is logged, not
   * swallowed, because it is still a bug.
   */
  _onMessage(data) {
    try {
      this._handleMessage(data);
    } catch (err) {
      console.error('[net] client dropped a malformed message from the host', err);
    }
  }

  _handleMessage(data) {
    const r = new Reader(data);
    const kind = r.u8();
    const now = performance.now() / 1000;

    switch (kind) {
      case MSG.WELCOME: {
        // The host's protocol version, which until now was read into a discard.
        // It is the first field after the kind byte in every version of this
        // message, so it is the one field a build of any age can trust — and
        // reading past it on a mismatch is exactly what garbles a session:
        // WELCOME's own trailing fields moved at 2 and the entity record moved
        // at 3, so a skewed pairing mis-frames every entity after the first.
        const hostVersion = r.u16();
        if (hostVersion !== PROTOCOL_VERSION) {
          this._refused(REFUSE.VERSION, `theirs ${hostVersion}, ours ${PROTOCOL_VERSION}`);
          return;
        }
        this.myPeerId = r.u16();
        const seed = r.u32();
        const stageIndex = r.u16();
        this.myNetId = r.u16();
        const time = r.f32();
        // The host's artifact set and difficulty (PROTOCOL_VERSION 2). Read
        // defensively: a 1.x host sends no trailing bytes, and joining it with
        // vanilla rules is a far better failure than throwing out of the one
        // message that tells this client who it is.
        // The local survivor is the one entity with no view, so without this it
        // is the one entity a forwarded event cannot name. Stamping the id on
        // it lets `_resolve` hand listeners the real player object for events
        // about this client — its own damage, its own death — instead of a bare
        // `{ netId }` they cannot recognise as themselves.
        if (this.ctx?.player) this.ctx.player.netId = this.myNetId;
        const artifactMask = r.remaining >= 5 ? r.u32() : 0;
        const difficulty = r.remaining >= 1 ? r.u8() : 1;
        // Regenerate the world locally from the host's seed instead of
        // streaming geometry — the stage is fully deterministic from it, so
        // this costs one number instead of megabytes.
        this.ctx.events.emit('netWelcome', {
          seed, stageIndex, time, myNetId: this.myNetId, artifactMask, difficulty,
        });
        break;
      }
      case MSG.SNAPSHOT:
        this.buffer.ingest(r, now);
        this._reconcile();
        break;
      case MSG.EVENT: {
        const name = r.str();
        const payload = r.json();
        // Re-emit locally so VFX/HUD react exactly as they do on the host.
        this.ctx.events.emit(name, this._resolve(payload));
        break;
      }
      case MSG.PONG: {
        const sentAt = r.f32();
        const hostTime = r.f32();
        this.clock.addSample(sentAt, hostTime, now);
        break;
      }
      case MSG.REFUSE: {
        const { reason, detail } = readRefuse(r, {});
        this._refused(reason, detail);
        break;
      }
      default:
        // The host's counterpart, for the host's reason (`NetHost._handleMessage`):
        // an unrecognised kind is protocol drift or a probe, and this switch had
        // no default at all, so four distinct malformed shots were dropped in
        // total silence in the round that added a version check to make drift
        // visible.
        console.warn(`[net] client ignored an unknown message kind ${kind} from the host`);
    }
  }

  /**
   * The join is off, and the player is told which one it was.
   *
   * Emitted before the close so the reason arrives ahead of the bare
   * `netDisconnected` that `onClose` produces — the lobby renders the last
   * status it was handed, and "disconnected" on top of a real reason would
   * replace an explanation with a shrug.
   */
  _refused(reason, detail) {
    // The other direction of the same bound `NetHost._refuse` applies. A host is
    // no more trusted than a joiner here: this string is rendered into the
    // client's own co-op panel by `refusalText`, and it arrived over the wire.
    this.ctx?.events?.emit('netRefused', {
      reason: String(reason ?? '').slice(0, REFUSE_DETAIL_MAX),
      detail: String(detail ?? '').slice(0, REFUSE_DETAIL_MAX),
    });
    this.connected = false;
    this.peer?.close?.();
  }

  /** Turn `{ netId }` references back into local view objects. */
  _resolve(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    for (const [k, v] of Object.entries(payload)) {
      if (v && typeof v === 'object' && v.netId !== undefined && Object.keys(v).length === 1) {
        // This client's own entity is predicted, not interpolated, so it has no
        // view — resolve it to the player itself. Every listener that reads
        // `target`/`victim` expects an entity, and `{ netId }` is not one.
        if (v.netId === this.myNetId && this.ctx?.player) payload[k] = this.ctx.player;
        else payload[k] = this.views.get(v.netId) ?? v;
      }
    }
    return payload;
  }

  // --- prediction ----------------------------------------------------------

  fixedUpdate(ctx, h) {
    if (!this.connected || !ctx.player) return;
    this.tick++;

    const cmd = this._sampleInput(ctx);
    cmd.tick = this.tick;

    // Predict locally, then record the command AND the resulting state so a
    // correction can replay from a known point.
    ctx.player.applyCommand?.(cmd, h);
    this.history.push({ cmd, state: ctx.player.getNetState?.() });
    if (this.history.length > INPUT_HISTORY) this.history.shift();

    writeInput(this.writer.reset(), cmd);
    this.peer?.sendState(this.writer.bytes());
  }

  _sampleInput(ctx) {
    const i = ctx.input;
    const m = i.moveAxis();
    let buttons = 0;
    if (i.down('Space')) buttons |= BTN.JUMP;
    if (i.down('ShiftLeft')) buttons |= BTN.SPRINT;
    if (i.mouse.left) buttons |= BTN.FIRE;
    if (i.mouse.right) buttons |= BTN.SECONDARY;
    if (i.down('KeyQ')) buttons |= BTN.UTILITY;
    if (i.down('KeyR')) buttons |= BTN.SPECIAL;
    if (i.down('KeyE')) buttons |= BTN.INTERACT;
    return {
      tick: 0, moveX: m.x, moveZ: m.z, buttons,
      yaw: ctx.cameraRig?.yaw ?? 0,
      pitch: ctx.cameraRig?.pitch ?? 0,
    };
  }

  /**
   * Rewind the local player to the host's authoritative state for the last
   * acknowledged command, then replay every command the host hasn't seen yet.
   * Without the replay step the player would be yanked back by a full RTT of
   * movement on every single snapshot.
   */
  _reconcile() {
    const ctx = this.ctx;
    const player = ctx.player;
    if (!player?.setNetState || !this.myNetId) return;

    const acked = this.buffer.latestAckedInput;
    const authoritative = this.buffer.liveIds()?.get(this.myNetId);
    if (!authoritative) return;

    // Health and liveness, before any of the position-error early-outs below.
    //
    // Nothing else on a client ever writes its own survivor's health:
    // `Combat.applyDamage` returns at the authority check, `update` skips
    // `myNetId` because the local entity is predicted rather than interpolated,
    // and the position reconcile writes x/y/z only. So a client's health bar
    // read full from join to death — and worse than stale, since local regen
    // kept climbing it while the host's copy of the same pawn fell (measured:
    // host 143 -> 103.4 while the client read 114.8 -> 116.5). The player could
    // not judge a single risk, and the run simply stopped.
    //
    // `healthFrac` is the one health field the snapshot carries, so the local
    // `maxHealth` scales it. That is only sound while the two maxima agree, and
    // until PROTOCOL_VERSION 3 they did not: the host built this peer's pawn
    // from its own survivor, so a `ranger` host and an `anvil` client mapped a
    // fraction of 110 onto 170 and the two ends read 70.92 against 109.60 —
    // 38.68 points apart, for ever. The HELLO body is what makes the premise
    // true; do not weaken it without re-reading that. Applied here rather than in `setNetState` on
    // purpose: `setNetState` is also the rewind point for a prediction replay,
    // and health is not predicted.
    this._applyAuthoritativeHealth(player, authoritative);

    const idx = this.history.findIndex((h) => h.cmd.tick === acked);
    if (idx === -1) return;                       // too old to reconcile from

    const predicted = this.history[idx].state;
    const dx = authoritative.x - predicted.x;
    const dy = authoritative.y - predicted.y;
    const dz = authoritative.z - predicted.z;
    const err = Math.hypot(dx, dy, dz);

    // Under a few centimetres the host and client agree closely enough that
    // replaying would cost more than it fixes.
    if (err < 0.02) { this.history.splice(0, idx + 1); return; }

    player.setNetState({ x: authoritative.x, y: authoritative.y, z: authoritative.z });

    const pending = this.history.slice(idx + 1);
    this.history = [];
    for (const { cmd } of pending) {
      player.applyCommand?.(cmd, 1 / 60);
      this.history.push({ cmd, state: player.getNetState?.() });
    }

    if (err < SNAP_THRESHOLD) {
      // Carry the correction as a render-space offset that decays, so the
      // camera never jolts even though the simulation moved.
      const after = player.getNetState?.();
      this.errorX += predicted.x - after.x;
      this.errorY += predicted.y - after.y;
      this.errorZ += predicted.z - after.z;
    } else {
      this.errorX = this.errorY = this.errorZ = 0;
    }
  }

  /**
   * Write the host's copy of this client's own health and liveness onto the
   * predicted local player.
   *
   * Death is applied through `Player.onDeath` rather than by setting `alive`,
   * so the pawn stops moving, drops its projectiles and placeables and clears
   * its buffs exactly as it does on the host. The `playerDead` event is *not*
   * synthesised here: the host emits it and `NetHost` forwards it, so raising a
   * second one locally would double every death cue and — since `_endRun` is
   * idempotent — hide which of the two the record came from.
   */
  _applyAuthoritativeHealth(player, e) {
    const frac = e?.healthFrac;
    if (typeof frac === 'number' && Number.isFinite(frac)) {
      const max = player.maxHealth || 100;
      const next = Math.max(0, Math.min(max, frac * max));
      // A client resolves no damage of its own, so nothing local ever reset its
      // regen delay — leaving `_updateRegen` free to climb back up between
      // snapshots and fight the authority 20 times a second. The host's own
      // survivor pays the delay on every hit; so does this one.
      //
      // Kept, but not on the strength of a measured effect. Reverting this line
      // alone on loopback WebRTC moved the worst host/client disagreement over
      // eight samples from 0.04 to 0.06 — the 20 Hz overwrite dominates whatever
      // regen adds between snapshots, so at zero lag the line buys nothing
      // observable. It is a correctness statement (a hit delays regen) whose
      // payoff scales with RTT, and nobody has run it under real RTT.
      if (next < player.health - 0.001) player.sinceDamage = 0;
      player.health = next;
    }
    // The barrier, from the same authority and for the same reason.
    //
    // A client's `onDamaged` cards fire locally (round 1's F-10 forward is what
    // makes them fire at all) and Sunken Vertebra and friends granted it a
    // barrier the host had never heard of: measured 28.02 points on the client's
    // bar — and the HUD extends the health track by it, so the player is asked
    // to spend risk against it — while the host resolved every hit against the
    // same pawn with `shield 0.00`. Local barrier is now a prediction like
    // position is, and this is the correction.
    //
    // What it does NOT do is make the barrier real: the host does not run a
    // pawn's `onDamaged` hooks (`data/items.js`'s `e.local === false` gate,
    // round 1's F-7), so for now this mostly replaces an invisible lie with a
    // visible zero. That is the honest reading of the same gap K-4 defers.
    const sfrac = e?.shieldFrac;
    if (typeof sfrac === 'number' && Number.isFinite(sfrac)) {
      player.shield = Math.max(0, Math.min(player.maxShield ?? Infinity, sfrac * (player.maxHealth || 100)));
    }
    if (e?.state === ESTATE.DEAD) {
      if (player.alive !== false) { player.health = 0; player.onDeath?.(); }
    }
  }

  // --- interpolation of everyone else --------------------------------------

  update(ctx, dt) {
    this.peer?.pumpSim();
    if (!this.connected) return;

    this._pingAccum += dt;
    if (this._pingAccum > 1) {
      this._pingAccum = 0;
      const w = new Writer(16);
      w.u8(MSG.PING).f32(performance.now() / 1000);
      this.peer?.sendState(w.bytes());
    }

    // Decay the visual correction offset over ~150ms.
    const k = Math.pow(0.001, dt / 0.15);
    this.errorX *= k; this.errorY *= k; this.errorZ *= k;
    if (ctx.player?.setRenderOffset) ctx.player.setRenderOffset(this.errorX, this.errorY, this.errorZ);

    const renderTime = performance.now() / 1000 - INTERP_DELAY;
    const live = this.buffer.liveIds();
    if (!live) return;

    // Spawn views for anything new.
    for (const [netId, e] of live) {
      if (netId === this.myNetId) continue;    // local player is predicted, not interpolated
      if (this.views.has(netId)) continue;
      const factory = this.viewFactories.get(e.kind);
      const view = factory?.(e, ctx);
      if (view) { view.netId = netId; this.views.set(netId, view); }
    }

    // Update / retire.
    for (const [netId, view] of this.views) {
      const s = this.buffer.sample(netId, renderTime, this._sample);
      if (!s || !live.has(netId)) {
        view.dispose?.(ctx);
        this.views.delete(netId);
        continue;
      }
      if (s.state === ESTATE.DEAD && !view.dying) {
        view.dying = true;
        view.onDeath?.(ctx);
      }
      view.applyNetState?.(s, dt);
    }
  }

  close() { this.peer?.close(); }
}
