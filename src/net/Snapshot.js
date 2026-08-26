import { readEntity, ESTATE } from './Protocol.js';

/**
 * Client-side snapshot buffer and interpolator.
 *
 * Remote entities are rendered ~100ms in the past, between the two snapshots
 * that straddle that render time. This is the standard trade: a constant, small,
 * *invisible* delay on other players' positions in exchange for perfectly smooth
 * motion. The alternative — extrapolating to "now" — produces rubber-banding
 * every time a remote player changes direction, which reads far worse than
 * 100ms of lag ever does.
 *
 * The local player is NOT interpolated; it is predicted. See NetClient.
 */

// Two snapshots at 20Hz = 100ms, so this always has a pair to work with even if
// one packet is lost. Raise it on bad connections rather than dropping to
// extrapolation.
export const INTERP_DELAY = 0.1;

const MAX_SNAPSHOTS = 32;

export class SnapshotBuffer {
  constructor() {
    this.snapshots = [];        // ascending by tick
    this.latestAckedInput = 0;
    this.serverTick = 0;
    // Reused scratch so decoding a snapshot allocates nothing per entity.
    this._scratch = {};
  }

  /** Decode a SNAPSHOT payload (reader positioned after the message kind byte). */
  ingest(reader, recvTime) {
    const tick = reader.u32();
    const ackInput = reader.u32();
    const count = reader.u16();

    // Late/duplicate packets are common on an unreliable channel; ignore rather
    // than inserting out of order.
    if (this.snapshots.length && tick <= this.snapshots[this.snapshots.length - 1].tick) return null;

    const entities = new Map();
    for (let i = 0; i < count; i++) {
      const e = readEntity(reader, {});
      entities.set(e.netId, e);
    }

    const snap = { tick, time: recvTime, entities };
    this.snapshots.push(snap);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();

    this.serverTick = tick;
    this.latestAckedInput = Math.max(this.latestAckedInput, ackInput);
    return snap;
  }

  /**
   * State for `netId` at `renderTime` (= now - INTERP_DELAY), or null if the
   * entity isn't covered by the buffer.
   */
  sample(netId, renderTime, out = {}) {
    const s = this.snapshots;
    if (s.length === 0) return null;

    // Find the pair straddling renderTime.
    let b = -1;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].time <= renderTime) { b = i; break; }
    }

    // Ahead of the buffer (starved) — hold the newest rather than extrapolate.
    if (b === -1) {
      const e = s[0].entities.get(netId);
      return e ? Object.assign(out, e, { t: 0 }) : null;
    }
    if (b === s.length - 1) {
      const e = s[b].entities.get(netId);
      return e ? Object.assign(out, e, { t: 0 }) : null;
    }

    const A = s[b], B = s[b + 1];
    const ea = A.entities.get(netId);
    const eb = B.entities.get(netId);
    if (!ea) return eb ? Object.assign(out, eb, { t: 0 }) : null;
    if (!eb) return Object.assign(out, ea, { t: 0 });

    const span = B.time - A.time;
    const t = span > 1e-6 ? (renderTime - A.time) / span : 0;

    out.netId = netId;
    out.kind = eb.kind;
    out.typeId = eb.typeId;
    out.x = ea.x + (eb.x - ea.x) * t;
    out.y = ea.y + (eb.y - ea.y) * t;
    out.z = ea.z + (eb.z - ea.z) * t;
    out.yaw = lerpAngle(ea.yaw, eb.yaw, t);
    out.healthFrac = ea.healthFrac + (eb.healthFrac - ea.healthFrac) * t;
    out.shieldFrac = (ea.shieldFrac ?? 0) + ((eb.shieldFrac ?? 0) - (ea.shieldFrac ?? 0)) * t;
    // Discrete state must never be blended — snap to the newer one. Affix is
    // the same kind of field: an elite's affix mid-transition is a fact, not
    // a gradient, so a removal (or a new elite roll) must appear on the
    // interpolated frame it actually crossed rather than fading in.
    out.state = eb.state;
    out.affixId = eb.affixId;
    out.corrupted = eb.corrupted;
    out.t = t;
    return out;
  }

  /** netIds present in the newest snapshot, for spawn/despawn reconciliation. */
  liveIds() {
    const last = this.snapshots[this.snapshots.length - 1];
    return last ? last.entities : null;
  }

  isAlive(netId) {
    const last = this.snapshots[this.snapshots.length - 1];
    const e = last?.entities.get(netId);
    return e ? e.state !== ESTATE.DEAD : false;
  }

  clear() {
    this.snapshots.length = 0;
    this.serverTick = 0;
    this.latestAckedInput = 0;
  }
}

/** Shortest-arc angle lerp — naive lerp spins the long way around ±PI. */
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Estimates the offset between our clock and the host's, so `renderTime` sits
 * in the same frame of reference as snapshot arrival times. Uses the minimum
 * observed offset over a window, which is robust against one-off latency
 * spikes in a way a running average is not.
 */
export class ClockSync {
  constructor(window = 40) {
    this.samples = [];
    this.window = window;
    this.offset = 0;
    this.rtt = 0;
  }
  addSample(sentAt, hostTime, recvAt) {
    const rtt = recvAt - sentAt;
    const offset = hostTime + rtt / 2 - recvAt;
    this.samples.push({ offset, rtt });
    if (this.samples.length > this.window) this.samples.shift();
    let best = Infinity, bestOffset = this.offset;
    for (const s of this.samples) if (s.rtt < best) { best = s.rtt; bestOffset = s.offset; }
    this.rtt = best;
    // Ease toward the new estimate; a hard set makes remote entities jump.
    this.offset += (bestOffset - this.offset) * 0.15;
  }
  hostNow(localNow) { return localNow + this.offset; }
}
