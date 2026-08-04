import {
  MSG, EKIND, ESTATE, Writer, Reader, readInput, readHello, writeEntity, PROTOCOL_VERSION,
  REFUSE, writeRefuse, REFUSE_DETAIL_MAX,
} from './Protocol.js';
import { HostTransport } from './Transport.js';
import { SURVIVOR_BY_ID } from '../data/survivors.js';

/**
 * Authoritative host.
 *
 * The host runs the game exactly as single-player does — same Engine, same
 * fixedUpdate, same systems, `ctx.authority === true`. Networking is layered on
 * top rather than woven in: the only things this system does are (1) drive
 * remote players' input into their pawns before the sim step, and (2) publish
 * the resulting state afterwards.
 *
 * That ordering is the whole design. If snapshots were built before remote
 * input was applied, every client would see its own actions a full tick late on
 * top of the network delay.
 */

const SNAPSHOT_HZ = 20;
// Beyond this, a client is so far behind that catching up would let it act in
// the past. Discard and let it resync from the next snapshot.
const MAX_INPUT_BACKLOG = 12;
// How long the authority keeps running after the last live peer dies, so the
// snapshot carrying that peer's death can reach it. Three snapshot intervals
// plus a frame, rounded up; see `_holdSession`.
const HOLD_GRACE = 1.5;
// How old a peer's pawn may be, in host ticks (60Hz), when its HELLO lands and
// still be re-stated from it. Two seconds is far past any real join — the
// message is the first thing a client sends on the reliable channel — and it is
// the difference between "re-stat a pawn nothing has happened to yet" and
// "re-stat a pawn somebody has been playing", which is a free full heal.
const HELLO_MAX_PAWN_AGE = 120;
// How long the refusal is given to leave the reliable channel before the peer
// is closed under it: 8 tries at 16 ms, so ~128 ms and never longer. See
// `_closeWhenFlushed`.
const REFUSE_FLUSH_MS = 16;
const REFUSE_FLUSH_TRIES = 8;

export class NetHost {
  constructor({ maxPlayers = 4 } = {}) {
    this.maxPlayers = maxPlayers;
    this.transport = new HostTransport();
    this.clients = new Map();   // peerId -> { peer, pawn, inputs[], lastTick, name }
    this.writer = new Writer(16384);
    this.eventWriter = new Writer(4096);
    this.tick = 0;
    this.accum = 0;
    this._nextNetId = 1;
    this._scratchInput = {};
    // Whether `_holdSession` is currently keeping the world running under a
    // local menu. Only used to know when to hand `ctx.paused` back.
    this._holding = false;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.net = this;
    ctx.authority = true;   // host simulates everything
    ctx.netRole = 'host';

    this.transport.onPeer = (peer) => this._onPeer(peer);
    this.transport.onPeerLeave = (peer) => this._onPeerLeave(peer);

    // Forward one-shot facts clients can't derive from snapshots. Cosmetic
    // events are deliberately excluded — clients generate their own VFX from
    // the events they do receive, which avoids paying bandwidth for particles.
    // `goldChanged` matters as much as `itemPickup`: gold is host-authoritative
    // and carried in no snapshot field, so without forwarding it a client's
    // purse sits at 0 forever and it can never buy anything.
    // `realmEnter`/`realmExit` belong on this list for the same reason
    // `stageStart` does: a client cannot derive "we are all somewhere else now"
    // from a snapshot, and the arenas are authored, so the realm id is the
    // whole of the state it needs to build the same room.
    for (const name of ['kill', 'itemPickup', 'goldChanged', 'teleporterCharging', 'teleporterComplete',
                        'stageStart', 'bossSpawn', 'bossDead', 'playerDead', 'levelUp',
                        'realmEnter', 'realmExit']) {
      ctx.events.on(name, (payload) => this._forward(name, payload));
    }

    // Damage feedback for a remote player's *own* survivor.
    //
    // `playerHurt` and `shieldBroken` are deliberately emitted only for
    // `ctx.player` (Combat.js:461, Combat.js:491) — they mean "this machine's
    // survivor was hurt", and broadcasting them would tell every client that
    // somebody, somewhere, took a hit. But a client resolves no damage of its
    // own (`Combat.js:382` returns for a non-authority), so without a per-owner
    // forward it never learns it was hit at all: `Items._lastHurt` never moves,
    // `timeSinceHurt()` sits at its sentinel forever and every `onDamaged` card
    // — Field Dressing, Siege Battery, Mineral Lick, Barb Snare, Iron
    // Thornplate, Kinetic Recycler, Sunken Vertebra — is dead for that player.
    // `damage` is emitted for every target including pawns, so the owner's copy
    // is reconstructed from it and sent to exactly one peer.
    ctx.events.on('damage', (e) => this._forwardHurt(e));
  }

  /** Returns { id, blob, accept } — hand `blob` to the joining player. */
  createInvite() {
    if (this.clients.size >= this.maxPlayers - 1) throw new Error('Lobby is full');
    return this.transport.createInvite();
  }

  get playerCount() { return 1 + this.clients.size; }

  _onPeer(peer) {
    peer.onMessage = (data, channel) => this._onMessage(peer, data, channel);
    peer.onClose = () => this._onPeerLeave(peer);

    // Spawn a pawn for the remote player. It is an ordinary Player-shaped
    // entity driven by network input instead of local input, so every gameplay
    // system treats it identically to the host's own player.
    const pawn = this.ctx.spawnRemotePlayer?.(peer.id) ?? null;
    // `joinTick` is the pawn's birthday in this system's own clock, and the only
    // honest measure of its age: `Player._localTick` advances in
    // `_sampleCommand`, which a pawn never runs, so it reads 0 on a pawn for the
    // whole session. See `_onHello`.
    this.clients.set(peer.id, {
      peer, pawn, inputs: [], lastTick: 0, name: `Player ${peer.id + 1}`,
      joinTick: this.tick, helloSeen: false, survivorId: null,
    });

    const w = this.writer.reset();
    w.u8(MSG.WELCOME);
    w.u16(PROTOCOL_VERSION);
    w.u16(peer.id);
    w.u32(this.ctx.seed >>> 0);
    w.u16(this.ctx.progression?.stageIndex ?? 0);
    // Assign the net id now rather than letting the first snapshot do it
    // lazily: WELCOME is what tells the client which entity is *itself*, and a
    // 0 here makes it build an interpolated view of its own player and then
    // fight its own prediction for the rest of the session.
    w.u16(pawn ? this._netId(pawn) : 0);
    w.f32(this.ctx.time);
    // The run's rules. A client must play the host's artifacts and difficulty,
    // not its own — its stat block, its loot and the monsters it is looking at
    // are all the host's simulation. Packed as a bitmask over `ARTIFACTS` order
    // plus the difficulty index; see `Artifacts.netPack`.
    const rules = this.ctx.artifacts?.netPack?.() ?? { mask: 0, difficulty: 1 };
    w.u32(rules.mask);
    w.u8(rules.difficulty);
    peer.sendEvent(w.bytes());

    this.ctx.events.emit('netPlayerJoined', { id: peer.id, pawn });
  }

  _onPeerLeave(peer) {
    const c = this.clients.get(peer.id);
    if (!c) return;
    this.clients.delete(peer.id);
    if (c.pawn) this.ctx.despawnRemotePlayer?.(c.pawn);
    this.ctx.events.emit('netPlayerLeft', { id: peer.id });
  }

  /**
   * Every inbound byte on the host crosses this method, and every one of them
   * was written by somebody else's machine.
   *
   * `Reader.str` sizes a `Uint8Array` from a peer-controlled length prefix, so a
   * five-byte HELLO claiming a 200-byte string threw `Invalid typed array
   * length: 200` straight out of `ch.onmessage` (`Transport.js:44`) with nothing
   * on the path to catch it. Isolating the message is the same call this build
   * already makes for event dispatch (`Engine.emit`): one bad input must not be
   * able to reach past itself, and it is logged rather than swallowed because a
   * malformed message is still a bug and this must not be the reason nobody
   * finds it.
   */
  _onMessage(peer, data) {
    try {
      this._handleMessage(peer, data);
    } catch (err) {
      console.error('[net] host dropped a malformed message from peer ' + peer?.id, err);
    }
  }

  _handleMessage(peer, data) {
    const r = new Reader(data);
    const kind = r.u8();
    const c = this.clients.get(peer.id);
    if (!c) return;

    if (kind === MSG.INPUT) {
      const cmd = readInput(r, {});
      // Reject replays and reordered duplicates outright — the unreliable
      // channel delivers both, and applying an old command would teleport the
      // pawn backwards.
      if (cmd.tick <= c.lastTick) return;
      c.inputs.push(cmd);
      if (c.inputs.length > MAX_INPUT_BACKLOG) c.inputs.splice(0, c.inputs.length - MAX_INPUT_BACKLOG);
    } else if (kind === MSG.HELLO) {
      this._onHello(peer, c, r);
    } else if (kind === MSG.PING) {
      const sentAt = r.f32();
      const w = new Writer(16);
      w.u8(MSG.PONG).f32(sentAt).f32(performance.now() / 1000);
      peer.sendState(w.bytes());
    } else {
      // Silence here is the same failure `PROTOCOL_VERSION` exists to prevent,
      // arriving one message at a time instead of all at once: an unrecognised
      // kind is either drift between two builds or a peer probing, and both are
      // things somebody needs to be able to see. Warn rather than refuse — a
      // kind this build does not know is inert, and dropping a session over one
      // stray byte is worse than the byte.
      console.warn(`[net] host ignored an unknown message kind ${kind} from peer ${peer?.id}`);
    }
  }

  /**
   * The one thing only the joiner knows: which survivor it picked.
   *
   * The pawn already exists — `_onPeer` builds it on channel open, which is
   * before any byte can arrive — and it was built from this machine's own
   * `ctx.survivorId`. `setSurvivor` is the existing runtime swap, and on a pawn
   * a few ticks old its destructive half (clear placeables, clear projectiles,
   * refill health, rebuild the rig) is all no-ops.
   *
   * Three things enforce "a few ticks old", because nothing did and the round-3
   * comment that asserted it was the whole of the argument:
   *
   *  · **The latch.** HELLO is once. Replayed on a live pawn, `setSurvivor` runs
   *    `_applyCard`, which sets `health = base.maxHealth` (`Player.js:306`) — a
   *    full heal, on the one machine that owns that number. Measured: a pawn at
   *    35/110 was restored to 170/170 four times by five bytes each.
   *  · **The age gate.** The latch makes a *replay* impossible; the gate makes a
   *    deliberately *withheld* first HELLO impossible too. `_localTick` is not
   *    the age of a pawn — it only advances in `_sampleCommand`, so it is 0 on a
   *    pawn forever — so the age is measured in this system's own ticks from the
   *    one at which the pawn was spawned.
   *  · **The catalogue check.** An id this build does not have used to resolve
   *    to the *default* survivor (`getSurvivor`, survivors.js:240) and silently
   *    re-stat the pawn to it, which is precisely the divergence HELLO exists to
   *    remove: a peer playing `anvil` at 170 simulated as `ranger` at 110, with
   *    its health bar reading a fraction of one maximum against the other.
   *
   *  · **Parsing.** Rounds 4 and 5 both learned the same thing from opposite
   *    ends: every value in `hello` is either the peer's or a substitute
   *    `readHello` invented for it, and a substitute that reaches a decision is
   *    indistinguishable from a fact. A HELLO that throws, one too short to
   *    carry the fields at all, and one carrying an empty id are three
   *    different failures and none of them is a survivor.
   *
   * All four failures refuse the peer rather than degrading, and refusing is
   * told, not silent — see `_refuse`.
   */
  _onHello(peer, c, r) {
    // The latch is armed before anything can fail, so a peer cannot buy a
    // second attempt by making the first one throw. `_onMessage`'s try/catch
    // would have logged a parse failure and returned with `helloSeen` still
    // false, leaving the peer connected on the host's survivor *and* free to
    // try again — the two halves of this method's job both undone by one bad
    // length prefix.
    if (c.helloSeen) return this._refuse(peer, REFUSE.HELLO, 'a second identity message');
    c.helloSeen = true;

    let hello;
    try {
      hello = readHello(r, {});
    } catch {
      // `Reader.str` sizes its read from a peer-controlled length prefix. A
      // HELLO that cannot be parsed is not a HELLO, and the peer that sent it
      // does not get simulated on a guess.
      return this._refuse(peer, REFUSE.HELLO, 'its identity message did not parse');
    }
    if (hello.malformed) {
      // Distinct from a version mismatch on purpose. `readHello` reports 0 for
      // a version field that is not there, and refusing that as "theirs 0, ours
      // 4" told the player their friend was on a different build and to go and
      // match it — a remedy for a fault they do not have.
      return this._refuse(peer, REFUSE.HELLO, 'its identity message was truncated');
    }
    if (hello.version !== PROTOCOL_VERSION) {
      return this._refuse(peer, REFUSE.VERSION, `theirs ${hello.version}, ours ${PROTOCOL_VERSION}`);
    }
    // Before `!c.pawn`, and with no `hello.survivorId` short-circuit in front of
    // it. The catalogue check used to sit below `if (!c.pawn || !hello.survivorId) return;`,
    // so an *empty* id never reached validation at all: five well-formed bytes
    // at the correct version left the peer connected and simulated as the
    // host's survivor — `ranger` at 110 under a client playing `anvil` at 170 —
    // with no console line, no page error and both lobbies reading "connected".
    // That is the exact divergence this message exists to remove, re-entered
    // through the door built to close it. One rule, no exceptions: a peer that
    // cannot name a survivor this build has does not get simulated.
    if (!SURVIVOR_BY_ID[hello.survivorId]) {
      return this._refuse(peer, REFUSE.SURVIVOR, hello.survivorId || '(none)');
    }
    if (!c.pawn) return;
    if (this.tick - (c.joinTick ?? 0) > HELLO_MAX_PAWN_AGE) {
      return this._refuse(peer, REFUSE.HELLO, 'it arrived too late to re-stat the pawn safely');
    }

    c.survivorId = hello.survivorId;
    c.pawn.setSurvivor?.(hello.survivorId);
  }

  /**
   * Tell the peer why, then drop it.
   *
   * The message goes on the reliable channel and the close waits for it to
   * drain — a closed channel sends nothing, and a client that is dropped
   * without a reason shows "Disconnected from the host", which is true and
   * useless. `onClose` runs `_onPeerLeave`, so the pawn is despawned and the
   * lobby's player list is corrected by the existing path.
   *
   * Two things this method got wrong, both of which end with the player being
   * told nothing:
   *
   *  · **`detail` was unbounded and it is the peer's own string.** A 60 000
   *    character survivor id was echoed back onto the wire *and* rendered
   *    verbatim in the host's own co-op panel — the host being the party that
   *    did nothing wrong. It is truncated once, here, so the bound covers the
   *    wire, the host's status line and the event payload from a single place.
   *  · **`setTimeout(0)` is not a flush.** It defers the close by one macrotask,
   *    which is a bet on the send having drained in that time, and at 60 KB the
   *    bet lost on loopback with zero latency: measured, the refusal was
   *    delivered at 300 bytes and dropped at 60 000, leaving the joiner reading
   *    the generic shrug this whole path exists to replace. `bufferedAmount` is
   *    the actual question, so ask it — under a cap, because a peer that never
   *    drains must not keep the connection open for ever.
   */
  _refuse(peer, reason, detail = '') {
    const short = String(detail ?? '').slice(0, REFUSE_DETAIL_MAX);
    const w = new Writer(128);
    writeRefuse(w, reason, short);
    peer.sendEvent(w.bytes());
    this.ctx?.events?.emit('netPeerRefused', { id: peer.id, reason, detail: short });
    this._closeWhenFlushed(peer);
  }

  /**
   * Close `peer` once its reliable channel has drained, or after `REFUSE_FLUSH_TRIES`
   * turns, whichever comes first. The cap is what stops a peer that stops
   * reading from holding a connection open by doing nothing.
   */
  _closeWhenFlushed(peer, tries = 0) {
    const ch = peer?.events;
    const drained = !ch || ch.readyState !== 'open' || ch.bufferedAmount === 0;
    if (drained || tries >= REFUSE_FLUSH_TRIES) return void peer.close();
    setTimeout(() => this._closeWhenFlushed(peer, tries + 1), REFUSE_FLUSH_MS);
  }

  /**
   * Drive remote pawns from queued input, then let the rest of the engine's
   * fixedUpdate run normally. Exactly one command is consumed per pawn per
   * tick so remote players can never gain an action-rate advantage by flooding.
   */
  fixedUpdate(ctx, h) {
    this.tick++;
    for (const c of this.clients.values()) {
      if (!c.pawn) continue;
      const cmd = c.inputs.shift();
      if (cmd) {
        c.lastTick = cmd.tick;
        c.pawn.applyCommand?.(cmd, h);
      } else {
        // Starved: repeat the last command rather than freezing, so a single
        // dropped packet doesn't produce a visible stutter for everyone else.
        c.pawn.applyCommand?.(c.pawn.lastCommand ?? null, h);
      }
    }
  }

  /** Is any connected peer still playing? A dead pawn is not one. */
  hasLivePeer() {
    for (const c of this.clients.values()) if (c.pawn?.alive) return true;
    return false;
  }

  /**
   * The authority does not stop while somebody else is still playing.
   *
   * `ctx.paused` is written in exactly one place — `Menus.open` — and it means
   * "this machine has a screen up". On a host that is also a decision about
   * everyone else's world, because `Engine._frame` runs no fixed step while
   * paused and `NetHost.fixedUpdate` is the only thing that builds a snapshot.
   * So the host's own death used to stop the simulation for every surviving
   * client: measured, a client's `serverTick` ran 301 → 333 → 363 → 393 and then
   * sat at 396 for four seconds with `connected: true`, alive in a world that
   * would never move again, unable to finish, die or end the run.
   *
   * The choice made here is the one that agrees with the guard round 2 added
   * (`isLocalVictim`): **a death ends exactly one run, the dead player's.** The
   * host that dies gets its own death screen, its own committed record and its
   * own end — and the world it is hosting keeps running for the people still in
   * it, with the host watching. It is the pause menu's rule too: on a host with
   * a live peer, a menu is an overlay, not a pause.
   *
   * Two consequences worth stating rather than discovering:
   *  · Local input is muted while that overlay is up, because the simulation it
   *    would drive is still running. Nothing else in the build reads
   *    `input.enabled`, and `Player._sampleCommand` is the one consumer.
   *  · Enemies chase `ctx.player` and nothing else (`Enemy.js:449`), so with the
   *    host down they gather on its body and ignore the survivor. That is a
   *    pre-existing hole — no enemy has ever targeted a pawn in this build — and
   *    it is why "the run continues" currently means "the run continues, easier".
   *    Named in round 3's report as held, not fixed.
   *
   * Re-evaluated every frame rather than once at `Menus.open`, so the release
   * case needs no state: when the last live peer dies, the host's already-open
   * death screen pauses the world on the next frame, exactly as single-player.
   */
  _holdSession(ctx) {
    const screen = ctx.hud?.menus?.screen ?? null;
    const now = performance.now() / 1000;
    const live = this.hasLivePeer();
    if (live) this._lastLivePeer = now;
    // The grace window is not padding. `SnapshotBuffer.ingest` drops any
    // snapshot whose tick is not newer than the last, and `this.tick` only
    // advances in `fixedUpdate` — so the instant the world pauses, every
    // further send is discarded by every client. A peer that has just died
    // still needs one more snapshot: the one carrying `ESTATE.DEAD`, which is
    // the only thing that puts its own player into its own death state
    // (`NetClient._applyAuthoritativeHealth`). Pausing in the same frame as the
    // kill left that peer on a death screen reading `alive: true, health: 221`
    // in three of five measured arms — the same "died but not dead" split the
    // frozen authority produced, at one-second scale instead of forever.
    const hold = !!screen && (now - (this._lastLivePeer ?? -1e9)) < HOLD_GRACE;
    if (hold) {
      ctx.paused = false;
      // The grace and the input mute answer different questions, so they are
      // computed from different predicates. The grace exists so a peer that has
      // just died still gets the snapshot carrying its own death; muting the
      // host exists because the world it is looking at is still being played by
      // somebody. Tied together, the last peer's death left the host simulated
      // in the arena, targeted by everything in it (`Enemy.js:449`) and unable
      // to move, dodge or shoot for a measured 1.68 s. `hasLivePeer()` is the
      // question the mute is actually asking.
      if (ctx.input) ctx.input.enabled = !live;
    } else if (this._holding) {
      ctx.paused = !!screen;
      if (ctx.input) ctx.input.enabled = true;
    }
    this._holding = hold;
  }

  update(ctx, dt) {
    this._holdSession(ctx);
    if (this.clients.size === 0) return;
    // Nothing useful can be sent from a paused world: `this.tick` advances only
    // in `fixedUpdate`, and a client discards any snapshot that is not newer
    // than the last one it took. Sending them anyway is bandwidth spent to be
    // thrown away at the far end.
    if (ctx.paused) return;
    this.accum += dt;
    const step = 1 / SNAPSHOT_HZ;
    if (this.accum < step) return;
    this.accum %= step;
    this._broadcastSnapshot(ctx);
  }

  /** Assign net ids lazily so single-player pays nothing for this. */
  _netId(entity) {
    if (entity.netId === undefined || entity.netId === 0) entity.netId = this._nextNetId++;
    return entity.netId;
  }

  _broadcastSnapshot(ctx) {
    const entities = ctx.combat?.entities ?? [];
    const w = this.writer.reset();
    w.u8(MSG.SNAPSHOT);
    w.u32(this.tick);
    const ackOffset = w.off;
    w.u32(0);                 // patched per-client below
    const countOffset = w.off;
    w.u16(0);

    let count = 0;
    for (const e of entities) {
      if (!e || e.replicated === false) continue;
      // Dead entities stay in one final snapshot so clients can play the death
      // effect, then drop out.
      if (!e.alive && e.netState !== ESTATE.DEAD) continue;
      this._netId(e);
      e.kind = e.isPlayer ? EKIND.PLAYER : (e.kind ?? EKIND.ENEMY);
      writeEntity(w, e);
      count++;
    }
    for (const it of ctx.interactables?.replicable?.() ?? []) {
      this._netId(it);
      it.kind = EKIND.INTERACTABLE;
      writeEntity(w, it);
      count++;
    }
    w.view.setUint16(countOffset, count, true);

    // Each client needs its own input ack, so patch that field per send. The
    // rest of the buffer is shared — rebuilding it per client would triple the
    // encode cost for no benefit.
    for (const c of this.clients.values()) {
      w.view.setUint32(ackOffset, c.lastTick >>> 0, true);
      c.peer.sendState(w.bytes());
    }
  }

  /**
   * Send a client the two events its own survivor's damage would have raised
   * locally, and only to the peer that owns the pawn.
   *
   * The split matches Combat's: `shieldBroken` is what a barrier ate,
   * `playerHurt` is health actually lost, and a fully-absorbed hit raises only
   * the first — so the client's `_lastHurt`, its music duck and its `onDamaged`
   * hooks all pay for the same thing they would pay for on a host.
   */
  _forwardHurt(e) {
    const target = e?.target;
    if (!target || !target.isPlayer || this.clients.size === 0) return;
    let owner = null;
    for (const c of this.clients.values()) if (c.pawn === target) { owner = c; break; }
    if (!owner) return;   // the host's own player, or a pawn with no peer

    const dealt = e.toHealth ?? e.amount ?? 0;
    const absorbed = e.absorbed ?? 0;
    if (absorbed > 0) {
      this._send(owner.peer, 'shieldBroken', { target, remaining: target.shield, absorbed });
    }
    if (dealt > 0) {
      this._send(owner.peer, 'playerHurt', {
        target, source: e.source, amount: dealt, absorbed, remaining: target.health,
      });
    }
  }

  /** One event, one peer. `_forward`'s body without the broadcast. */
  _send(peer, name, payload) {
    const w = this.eventWriter.reset();
    w.u8(MSG.EVENT);
    w.str(name);
    w.json(sanitise(payload));
    peer.sendEvent(w.bytes());
  }

  _forward(name, payload) {
    if (this.clients.size === 0) return;
    const w = this.eventWriter.reset();
    w.u8(MSG.EVENT);
    w.str(name);
    // Strip object references — only plain data survives the wire. Entities
    // become their netIds so the client can resolve them against its own views.
    w.json(sanitise(payload));
    this.transport.broadcastEvent(w.bytes());
  }

  close() { this.transport.close(); }
}

/** Recursively reduce an event payload to wire-safe primitives. */
function sanitise(payload, depth = 0) {
  if (payload == null || depth > 3) return null;
  if (typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map((v) => sanitise(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === 'object') {
      // A position crosses as `{x, y, z}`, not as an array. Every consumer on
      // the far side reads `.x`/`.y`/`.z` off it — `Audio.death` -> `_out`,
      // `VFX._onKill` -> `Vector3.copy` — and an array gave all of them
      // `undefined`, which reached the Web Audio graph as `NaN` and *threw*
      // `AudioParam ... non-finite`. That aborted the rest of the dispatch
      // (see `EventBus.emit`), so on every replicated enemy death a client lost
      // its kill particles, its death sound and everything registered after
      // `Audio` — its HUD kill counter among them. A plain object is the same
      // three numbers on the wire and is what the reader already expects.
      if (v.isVector3) out[k] = { x: round2(v.x), y: round2(v.y), z: round2(v.z) };
      else if (v.netId !== undefined) out[k] = { netId: v.netId };
      // An entity with no netId yet — an enemy that has not appeared in a
      // snapshot — must not be walked field by field: that serialises its whole
      // stat block into a per-hit unicast, and the receiver cannot resolve the
      // result to anything anyway.
      else if (typeof v.takeDamage === 'function') out[k] = null;
      else out[k] = sanitise(v, depth + 1);
    } else if (typeof v !== 'function') {
      out[k] = typeof v === 'number' ? round2(v) : v;
    }
  }
  return out;
}
const round2 = (n) => Math.round(n * 100) / 100;
