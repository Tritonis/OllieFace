/**
 * Wire protocol.
 *
 * Two channels with different guarantees, because snapshots and events want
 * opposite things:
 *   - `state`  — unreliable, unordered. Input and snapshots. A dropped snapshot
 *                is worthless a frame later, so retransmitting it only adds
 *                latency. Never put anything non-idempotent here.
 *   - `events` — reliable, ordered. Item pickups, kills, stage transitions.
 *                These are one-shot facts a client can't reconstruct.
 *
 * Everything is hand-rolled binary rather than JSON: a 24-player-visible
 * snapshot at 20Hz is ~40x smaller packed, and JSON.parse on every snapshot
 * would allocate hard enough to show up as GC hitches during fights.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = {
  HELLO: 1,       // client -> host
  WELCOME: 2,     // host   -> client
  INPUT: 3,       // client -> host  (state channel)
  SNAPSHOT: 4,    // host   -> client (state channel)
  EVENT: 5,       // host   -> client (events channel)
  PING: 6,
  PONG: 7,
  BYE: 8,
};

// Button bits packed into the input word.
export const BTN = {
  JUMP: 1 << 0,
  SPRINT: 1 << 1,
  FIRE: 1 << 2,
  SECONDARY: 1 << 3,
  UTILITY: 1 << 4,
  SPECIAL: 1 << 5,
  INTERACT: 1 << 6,
};

// Entity kinds that appear in snapshots. Anything purely cosmetic (particles,
// decals, damage numbers) is NEVER replicated — clients spawn those locally
// from events, which is both cheaper and looks better under latency.
export const EKIND = {
  PLAYER: 1,
  ENEMY: 2,
  PROJECTILE: 3,
  INTERACTABLE: 4,
};

export const ESTATE = { ALIVE: 0, DEAD: 1, SPAWNING: 2 };

// --- quantisation -----------------------------------------------------------
// Stage is ~220 units across; ±512 with 1/64 unit precision fits i16 exactly and
// is ~1.5cm, well below what interpolation smooths over anyway.
const POS_SCALE = 64;
const POS_LIMIT = 32767;

export const packPos = (v) => Math.max(-POS_LIMIT, Math.min(POS_LIMIT, Math.round(v * POS_SCALE)));
export const unpackPos = (q) => q / POS_SCALE;

// Angles as i16 over [-PI, PI] — 0.01° precision, far finer than perceptible.
const ANG_SCALE = 32767 / Math.PI;
export const packAngle = (a) => {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return Math.round(x * ANG_SCALE);
};
export const unpackAngle = (q) => q / ANG_SCALE;

// --- sizes ------------------------------------------------------------------
export const INPUT_SIZE = 1 + 4 + 1 + 1 + 2 + 2 + 2; // kind,tick,mx,mz,buttons,yaw,pitch
export const ENTITY_SIZE = 2 + 1 + 1 + 6 + 2 + 2 + 1; // id,kind,type,pos,yaw,health,state
export const SNAPSHOT_HEADER = 1 + 4 + 4 + 2;         // kind,tick,ackInput,count

/**
 * Growable writer. Reused across sends by the caller so steady-state
 * networking allocates nothing.
 */
export class Writer {
  constructor(capacity = 8192) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.off = 0;
  }
  reset() { this.off = 0; return this; }
  _need(n) {
    if (this.off + n <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.off + n));
    new Uint8Array(next).set(new Uint8Array(this.buf));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(v) { this._need(1); this.view.setUint8(this.off, v); this.off += 1; return this; }
  i8(v) { this._need(1); this.view.setInt8(this.off, v); this.off += 1; return this; }
  u16(v) { this._need(2); this.view.setUint16(this.off, v, true); this.off += 2; return this; }
  i16(v) { this._need(2); this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  u32(v) { this._need(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; return this; }
  f32(v) { this._need(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  str(s) {
    const bytes = new TextEncoder().encode(s);
    this.u16(bytes.length);
    this._need(bytes.length);
    new Uint8Array(this.buf, this.off, bytes.length).set(bytes);
    this.off += bytes.length;
    return this;
  }
  json(o) { return this.str(JSON.stringify(o)); }
  // Copy out — DataChannel.send() must not be handed a view over a buffer we
  // are about to overwrite on the next tick.
  bytes() { return this.buf.slice(0, this.off); }
}

export class Reader {
  constructor(buf) {
    this.view = new DataView(buf);
    this.buf = buf;
    this.off = 0;
  }
  get remaining() { return this.view.byteLength - this.off; }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i8() { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  str() {
    const n = this.u16();
    const s = new TextDecoder().decode(new Uint8Array(this.buf, this.off, n));
    this.off += n;
    return s;
  }
  json() { return JSON.parse(this.str()); }
}

// --- input ------------------------------------------------------------------

export function writeInput(w, cmd) {
  w.u8(MSG.INPUT);
  w.u32(cmd.tick);
  w.i8(Math.round(cmd.moveX * 127));
  w.i8(Math.round(cmd.moveZ * 127));
  w.u16(cmd.buttons);
  w.i16(packAngle(cmd.yaw));
  w.i16(packAngle(cmd.pitch));
  return w;
}

export function readInput(r, out = {}) {
  out.tick = r.u32();
  out.moveX = r.i8() / 127;
  out.moveZ = r.i8() / 127;
  out.buttons = r.u16();
  out.yaw = unpackAngle(r.i16());
  out.pitch = unpackAngle(r.i16());
  return out;
}

// --- snapshots --------------------------------------------------------------

export function writeEntity(w, e) {
  w.u16(e.netId);
  w.u8(e.kind);
  w.u8(e.typeId ?? 0);
  w.i16(packPos(e.position.x));
  w.i16(packPos(e.position.y));
  w.i16(packPos(e.position.z));
  w.i16(packAngle(e.yaw ?? 0));
  // Health as a 0..65535 fraction of max — max is derived from typeId
  // client-side, so scaling changes don't need their own field.
  w.u16(Math.max(0, Math.min(65535, Math.round((e.health / Math.max(1, e.maxHealth)) * 65535))));
  w.u8(e.netState ?? ESTATE.ALIVE);
}

export function readEntity(r, out = {}) {
  out.netId = r.u16();
  out.kind = r.u8();
  out.typeId = r.u8();
  out.x = unpackPos(r.i16());
  out.y = unpackPos(r.i16());
  out.z = unpackPos(r.i16());
  out.yaw = unpackAngle(r.i16());
  out.healthFrac = r.u16() / 65535;
  out.state = r.u8();
  return out;
}
