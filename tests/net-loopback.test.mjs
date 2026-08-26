/**
 * Headless loopback: the wire proves itself without a browser.
 *
 *   node tests/net-loopback.test.mjs
 *
 * Three properties, no WebRTC, no DOM:
 *   1. Entity round-trip — writeEntity/readEntity agree with each other on
 *      every EKIND, every ESTATE, and the quantisation extremes, exactly.
 *   2. Snapshot pipeline determinism — the same host state produces the same
 *      bytes every time, and SnapshotBuffer's interpolation lands on the
 *      analytic midpoint whether it arrives on time or under simulated lag.
 *   3. Reliable-event ordering under sim — a jittered reliable channel still
 *      delivers every event exactly once, in send order (extends
 *      tests/netlag.test.mjs's pump-order proof from channel level to
 *      protocol level).
 */
import { Peer, MAX_SIM_QUEUE } from '../src/net/Transport.js';
import {
  Writer, Reader, MSG, EKIND, ESTATE,
  writeEntity, readEntity, packPos, unpackPos, packAngle, unpackAngle,
} from '../src/net/Protocol.js';
import { SnapshotBuffer } from '../src/net/Snapshot.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --- fixtures, copied from tests/netlag.test.mjs:14-28 ----------------------

function fakePc() { return { close() {}, addEventListener() {}, removeEventListener() {} }; }

function chan() {
  const sent = [];
  return { readyState: 'open', bufferedAmount: 0, send: (b) => sent.push(b), sent };
}

function peerWith(sim) {
  const p = new Peer(fakePc(), 1);
  p.state = chan();
  p.events = chan();
  if (sim) p.installSim(sim, () => p._t);
  p._t = 0;
  return p;
}

// --- new fixture: a paired channel whose send() delivers into the other
// side's onmessage, synchronously by default; with installSim, on the
// simulated clock (Peer wires channel.onmessage itself via `_wire` — attach
// with `_wire` after pairing, the same seam `installSim` uses for delay). ---

function pair() {
  const a = chan(), b = chan();
  a.send = (bytes) => b.onmessage?.({ data: bytes });
  b.send = (bytes) => a.onmessage?.({ data: bytes });
  return [a, b];
}

function bytesEqual(a, b) {
  const ua = new Uint8Array(a), ub = new Uint8Array(b);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

// Same clamp-and-round writeEntity applies to health/shield fractions.
const frac = (v, max) => Math.max(0, Math.min(65535, Math.round((v / Math.max(1, max)) * 65535))) / 65535;

// ============================================================================
console.log('entity round-trip — every EKIND, every ESTATE, quantisation extremes');
// ============================================================================
{
  // POS extremes, straight from packPos's own scale/limit: ±32767 / 64.
  const POS_MAX = 32767 / 64;   // 511.984375
  const POS_MIN = -32767 / 64;  // -511.984375
  const QUANTUM = 1 / 64;       // smallest representable position step

  const entities = [
    { netId: 1, kind: EKIND.PLAYER, typeId: 0, position: { x: POS_MAX, y: POS_MAX, z: POS_MAX },
      yaw: 0, health: 100, maxHealth: 100, shield: 0, netState: ESTATE.ALIVE }, // healthFrac boundary: 1
    { netId: 2, kind: EKIND.ENEMY, typeId: 3, position: { x: POS_MIN, y: POS_MIN, z: POS_MIN },
      yaw: Math.PI, health: 0, maxHealth: 50, shield: 0, netState: ESTATE.DEAD, affixId: 1 }, // healthFrac boundary: 0, affix #228
    { netId: 3, kind: EKIND.PROJECTILE, typeId: 7, position: { x: 0, y: 0, z: 0 },
      yaw: -Math.PI, health: 12.5, maxHealth: 25, shield: 10, netState: ESTATE.SPAWNING },
    { netId: 4, kind: EKIND.INTERACTABLE, typeId: 2, position: { x: 123.456, y: -45.6, z: 7.8 },
      yaw: 1.2345, health: 80, maxHealth: 80, shield: 40, netState: ESTATE.ALIVE },
    { netId: 5, kind: EKIND.PLAYER, typeId: 1, position: { x: -200.1, y: 50.25, z: -10 },
      yaw: 2.71828, health: 0, maxHealth: 170, shield: 0, netState: ESTATE.DEAD },
    { netId: 6, kind: EKIND.ENEMY, typeId: 9, position: { x: 99.99, y: -99.99, z: QUANTUM },
      yaw: -1.5708, health: 33, maxHealth: 99, shield: 0, netState: ESTATE.SPAWNING, corrupted: true }, // #228: corrupted, no affix
    { netId: 7, kind: EKIND.PROJECTILE, typeId: 4, position: { x: QUANTUM, y: QUANTUM, z: -QUANTUM },
      yaw: 3.0, health: 1, maxHealth: 1, shield: 0.5, netState: ESTATE.ALIVE },
    { netId: 8, kind: EKIND.ENEMY, typeId: 12, position: { x: 1, y: 2, z: 3 },
      yaw: 0.1, health: 10, maxHealth: 10, shield: 0, netState: ESTATE.ALIVE, affixId: 6 }, // #228: max affixId (voidtouched), fits low 7 bits alongside the high bit
    { netId: 65535, kind: EKIND.INTERACTABLE, typeId: 0, position: { x: 500, y: -500, z: 500 },
      yaw: 0.0001, health: 0, maxHealth: 1, shield: 0, netState: ESTATE.DEAD },
  ];

  ok(new Set(entities.map((e) => e.kind)).size === 4, 'fixture covers every EKIND');
  ok(new Set(entities.map((e) => e.netState)).size === 3, 'fixture covers every ESTATE');

  const w = new Writer();
  for (const e of entities) {
    w.reset();
    writeEntity(w, e);
    const r = new Reader(w.bytes());
    const out = readEntity(r, {});

    const exp = {
      netId: e.netId,
      kind: e.kind,
      typeId: e.typeId,
      x: unpackPos(packPos(e.position.x)),
      y: unpackPos(packPos(e.position.y)),
      z: unpackPos(packPos(e.position.z)),
      yaw: unpackAngle(packAngle(e.yaw)),
      healthFrac: frac(e.health, e.maxHealth),
      shieldFrac: frac(e.shield, e.maxHealth),
      state: e.netState,
      affixId: e.affixId ?? 0,
      corrupted: !!e.corrupted,
    };

    ok(out.netId === exp.netId, `netId ${e.netId}: round-trips`);
    ok(out.kind === exp.kind, `netId ${e.netId}: kind round-trips`);
    ok(out.typeId === exp.typeId, `netId ${e.netId}: typeId round-trips`);
    ok(out.x === exp.x && out.y === exp.y && out.z === exp.z, `netId ${e.netId}: position round-trips to pack precision (got ${out.x},${out.y},${out.z})`);
    ok(out.yaw === exp.yaw, `netId ${e.netId}: yaw round-trips to pack precision`);
    ok(out.healthFrac === exp.healthFrac, `netId ${e.netId}: healthFrac round-trips (got ${out.healthFrac}, want ${exp.healthFrac})`);
    ok(out.shieldFrac === exp.shieldFrac, `netId ${e.netId}: shieldFrac round-trips (got ${out.shieldFrac}, want ${exp.shieldFrac})`);
    ok(out.state === exp.state, `netId ${e.netId}: state round-trips`);
    ok(out.affixId === exp.affixId, `netId ${e.netId}: affixId round-trips (got ${out.affixId}, want ${exp.affixId})`);
    ok(out.corrupted === exp.corrupted, `netId ${e.netId}: corrupted round-trips (got ${out.corrupted}, want ${exp.corrupted})`);
  }

  // #228: an affix and the corrupted flag pack into the same trailing byte's
  // low/high bits and must not interfere with each other, or with typeId/state
  // on either side of them.
  {
    const w = new Writer();
    writeEntity(w, { netId: 42, kind: EKIND.ENEMY, typeId: 5,
      position: { x: 1, y: 1, z: 1 }, yaw: 0, health: 10, maxHealth: 10, shield: 0,
      netState: ESTATE.ALIVE, affixId: 3, corrupted: true });
    const out = readEntity(new Reader(w.bytes()), {});
    ok(out.affixId === 3 && out.corrupted === true, 'affixId and corrupted both survive when set together');
    ok(out.typeId === 5 && out.state === ESTATE.ALIVE, 'affix byte does not corrupt its neighbours');
  }

  // #228 removal: an affix going away (elite -> no elite, or corrupted tint
  // clearing) must round-trip back to 0/false, not linger from a prior write.
  {
    const w = new Writer();
    writeEntity(w, { netId: 43, kind: EKIND.ENEMY, typeId: 5,
      position: { x: 1, y: 1, z: 1 }, yaw: 0, health: 10, maxHealth: 10, shield: 0,
      netState: ESTATE.ALIVE, affixId: 0, corrupted: false });
    const out = readEntity(new Reader(w.bytes()), {});
    ok(out.affixId === 0 && out.corrupted === false, 'affix removal round-trips to none/uncorrupted');
  }
}

// ============================================================================
console.log('snapshot pipeline determinism — bytes are stable, interpolation hits the analytic midpoint');
// ============================================================================

// Hand-built 3-entity host state, positions advanced by a fixed delta between
// tick N and tick N+1.
function hostEntities(dx, dy, dz) {
  return [
    { netId: 1, kind: EKIND.PLAYER, typeId: 0, position: { x: 10 + dx, y: 0 + dy, z: -5 + dz }, yaw: 0.5, health: 100, maxHealth: 100, shield: 20, netState: ESTATE.ALIVE },
    { netId: 2, kind: EKIND.ENEMY, typeId: 3, position: { x: -20 + dx, y: 0 + dy, z: 30 + dz }, yaw: -1.0, health: 40, maxHealth: 60, shield: 0, netState: ESTATE.ALIVE },
    { netId: 3, kind: EKIND.PROJECTILE, typeId: 1, position: { x: 5 + dx, y: 1 + dy, z: 5 + dz }, yaw: 3.1, health: 1, maxHealth: 1, shield: 0, netState: ESTATE.ALIVE },
  ];
}

const TICK_N = 100, TICK_N1 = 101, ACK_INPUT = 7;
const DX = 1.0, DY = 0.25, DZ = -0.5; // fixed per-tick delta

function buildSnapshot(tick, ackInput, entities) {
  const w = new Writer();
  w.u8(MSG.SNAPSHOT);
  w.u32(tick);
  w.u32(ackInput);
  w.u16(entities.length);
  for (const e of entities) writeEntity(w, e);
  return w.bytes();
}

function ingestBytes(buffer, bytes, recvTime) {
  const r = new Reader(bytes);
  r.u8(); // MSG.SNAPSHOT
  return buffer.ingest(r, recvTime);
}

{
  // -- determinism: build twice from scratch, expect byte-identical output --
  const bytesN_run1 = buildSnapshot(TICK_N, ACK_INPUT, hostEntities(0, 0, 0));
  const bytesN1_run1 = buildSnapshot(TICK_N1, ACK_INPUT, hostEntities(DX, DY, DZ));
  const bytesN_run2 = buildSnapshot(TICK_N, ACK_INPUT, hostEntities(0, 0, 0));
  const bytesN1_run2 = buildSnapshot(TICK_N1, ACK_INPUT, hostEntities(DX, DY, DZ));
  ok(bytesEqual(bytesN_run1, bytesN_run2), 'tick N snapshot bytes are identical run to run');
  ok(bytesEqual(bytesN1_run1, bytesN1_run2), 'tick N+1 snapshot bytes are identical run to run');

  // -- direct ingest: sample at the midpoint equals the analytic midpoint --
  const T0 = 0, T1 = 0.1;
  const direct = new SnapshotBuffer();
  ingestBytes(direct, bytesN_run1, T0);
  ingestBytes(direct, bytesN1_run1, T1);

  const renderTimeDirect = (T0 + T1) / 2;
  const sampledDirect = direct.sample(1, renderTimeDirect, {});

  // Analytic midpoint: quantised endpoints, linearly interpolated at t=0.5,
  // exactly what SnapshotBuffer.sample computes.
  const eA = hostEntities(0, 0, 0)[0], eB = hostEntities(DX, DY, DZ)[0];
  const ax = unpackPos(packPos(eA.position.x)), bx = unpackPos(packPos(eB.position.x));
  const ay = unpackPos(packPos(eA.position.y)), by = unpackPos(packPos(eB.position.y));
  const az = unpackPos(packPos(eA.position.z)), bz = unpackPos(packPos(eB.position.z));
  const expectedMid = { x: ax + (bx - ax) * 0.5, y: ay + (by - ay) * 0.5, z: az + (bz - az) * 0.5 };

  ok(sampledDirect.x === expectedMid.x && sampledDirect.y === expectedMid.y && sampledDirect.z === expectedMid.z,
    `direct sample lands on the analytic midpoint (got ${sampledDirect.x},${sampledDirect.y},${sampledDirect.z})`);

  // -- through a pair() with installSim({lag:50}), stepping a fake clock:
  //    same final sampled state, later (lag-tolerance) --
  const [hostState, clientState] = pair();
  const host = new Peer(fakePc(), 1);
  host.state = hostState;
  const client = new Peer(fakePc(), 2);
  client.state = clientState;
  client._wire(client.state, 'state');

  const lagged = new SnapshotBuffer();
  let t = 0;
  client.onMessage = (bytes, label) => {
    if (label !== 'state') return;
    ingestBytes(lagged, bytes, t);
  };
  // The rig lives on the *receiving* peer: the host's send goes on the wire at
  // once and the flight time is charged where it is felt. See `installSim`.
  client.installSim({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 }, () => t);

  // Pump strictly past each due time — `due` is `_simClock() + lagMs/1000`,
  // and 0.1 + 0.05 lands one float ULP above 0.15, so pumping at exactly 0.15
  // would miss it. A small margin keeps this a test of the pipeline, not of
  // IEEE 754 addition.
  t = 0; host.sendState(bytesN_run1);
  t = 0.06; client.pumpSim(); // tick N arrives, ~50ms later
  t = 0.1; host.sendState(bytesN1_run1);
  t = 0.16; client.pumpSim(); // tick N+1 arrives, ~50ms later

  const T0_LAGGED = 0.06, T1_LAGGED = 0.16;
  const renderTimeLagged = (T0_LAGGED + T1_LAGGED) / 2; // same 0.1s span, shifted by the 50ms lag
  const sampledLagged = lagged.sample(1, renderTimeLagged, {});

  ok(renderTimeLagged > renderTimeDirect, `lagged sample happens later than the direct one (${renderTimeLagged} > ${renderTimeDirect})`);
  // Both buffers interpolate at t=0.5 of the same pack-quantised endpoints, so
  // they agree to well beyond pack precision — but the two runs reach t=0.5
  // through different floating-point subtractions (0.1-0 vs 0.15-0.05), which
  // differ in the last ULP. That's IEEE 754 timeline noise, not a protocol
  // defect, so the comparison tolerates it at a scale far finer than anything
  // pack/unpack or interpolation itself would ever produce.
  const EPS = 1e-9;
  const near = (a, b) => Math.abs(a - b) < EPS;
  ok(
    near(sampledLagged.x, sampledDirect.x) && near(sampledLagged.y, sampledDirect.y) && near(sampledLagged.z, sampledDirect.z) &&
    near(sampledLagged.yaw, sampledDirect.yaw) && near(sampledLagged.healthFrac, sampledDirect.healthFrac) &&
    near(sampledLagged.shieldFrac, sampledDirect.shieldFrac) && sampledLagged.state === sampledDirect.state,
    `lagged sample matches the direct sample to float precision, just later (dx=${sampledLagged.x - sampledDirect.x}, dy=${sampledLagged.y - sampledDirect.y}, dz=${sampledLagged.z - sampledDirect.z})`
  );
}

// ============================================================================
console.log('reliable-event ordering under sim — 20 jittered events, exactly once, in send order');
// ============================================================================
{
  ok(20 < MAX_SIM_QUEUE, `fixture size stays well under MAX_SIM_QUEUE (${MAX_SIM_QUEUE}), so no eviction is exercised here`);

  const [hostEvents, clientEvents] = pair();
  const host = new Peer(fakePc(), 1);
  host.events = hostEvents;
  const client = new Peer(fakePc(), 2);
  client.events = clientEvents;
  client._wire(client.events, 'events');

  const received = [];
  client.onMessage = (bytes, label) => {
    if (label !== 'events') return;
    const r = new Reader(bytes);
    r.u8(); // MSG.EVENT
    const name = r.str();
    const payload = r.json();
    received.push({ name, payload });
  };

  let t = 0;
  // On the receiver, as above: the delay is flight time, not send-side holding.
  client.installSim({ on: true, lagMs: 20, jitterMs: 80, lossPct: 0 }, () => t);

  // Fixed pseudo-random sequence so the jittered delays are reproducible.
  const realRandom = Math.random;
  let seed = 12345;
  const nextRandom = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  Math.random = nextRandom;
  try {
    for (let i = 0; i < 20; i++) {
      const w = new Writer();
      w.u8(MSG.EVENT);
      w.str(`evt${i}`);
      w.json({ i });
      host.sendEvent(w.bytes());
    }
  } finally {
    Math.random = realRandom;
  }

  // Step the sim clock past the worst case (lag + jitter = 100ms), pumping
  // along the way — the queue is append-ordered, so a later-due packet under
  // jitter never jumps an earlier-sent one still in flight.
  for (t = 0; t <= 0.2; t += 0.01) client.pumpSim();
  t = 1; client.pumpSim();

  ok(received.length === 20, `every event arrived exactly once (got ${received.length})`);
  let inOrder = true;
  for (let i = 0; i < received.length; i++) {
    if (received[i].name !== `evt${i}` || received[i].payload.i !== i) inOrder = false;
  }
  ok(inOrder, `events arrived in send order (got ${received.map((e) => e.name).join(',')})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
