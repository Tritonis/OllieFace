import {
  MSG, EKIND, ESTATE, Writer, Reader, readInput, writeEntity, PROTOCOL_VERSION,
} from './Protocol.js';
import { HostTransport } from './Transport.js';

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
    for (const name of ['kill', 'itemPickup', 'goldChanged', 'teleporterCharging', 'teleporterComplete',
                        'stageStart', 'bossSpawn', 'bossDead', 'playerDead', 'levelUp']) {
      ctx.events.on(name, (payload) => this._forward(name, payload));
    }
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
    this.clients.set(peer.id, { peer, pawn, inputs: [], lastTick: 0, name: `Player ${peer.id + 1}` });

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

  _onMessage(peer, data) {
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
    } else if (kind === MSG.PING) {
      const sentAt = r.f32();
      const w = new Writer(16);
      w.u8(MSG.PONG).f32(sentAt).f32(performance.now() / 1000);
      peer.sendState(w.bytes());
    }
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

  update(ctx, dt) {
    if (this.clients.size === 0) return;
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
      if (v.isVector3) out[k] = [round2(v.x), round2(v.y), round2(v.z)];
      else if (v.netId !== undefined) out[k] = { netId: v.netId };
      else out[k] = sanitise(v, depth + 1);
    } else if (typeof v !== 'function') {
      out[k] = typeof v === 'number' ? round2(v) : v;
    }
  }
  return out;
}
const round2 = (n) => Math.round(n * 100) / 100;
