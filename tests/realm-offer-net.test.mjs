/**
 * Client-side realm warming (#229).
 *
 *   node tests/realm-offer-net.test.mjs
 *
 * `realmOffer` used to be a host-only fact: it drove `RealmWarm.offer()` on
 * the host so the arena behind a door was warm by the time anyone walked
 * into it, but a client never heard the door existed until `realmEnter`,
 * which arrives at the moment the door is *taken* -- too late to warm
 * anything. Three properties, no WebRTC and no DOM:
 *
 *   1. wire round trip -- `NetHost` forwards `realmOffer` to every peer, the
 *      same broadcast shape as `realmEnter`/`realmExit`.
 *   2. `RealmWarm.offer()` is authority-agnostic: nothing in it or its
 *      scheduler reads `ctx.authority`, so the identical spread-per-frame
 *      mechanism that warms the host also warms a client that receives the
 *      offer over the wire.
 *   3. an offer for a realm the guest never enters is released cleanly by
 *      `clear()` (the same path a stage change already drives) rather than
 *      leaking a parked stage and its probe.
 */
import { Peer } from '../src/net/Transport.js';
import { Writer, Reader, MSG, PROTOCOL_VERSION } from '../src/net/Protocol.js';
import { NetHost } from '../src/net/NetHost.js';
import { RealmWarm } from '../src/world/realms/RealmWarm.js';
import { REALM_BY_ID } from '../src/data/realms.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakePc() { return { close() {}, addEventListener() {}, removeEventListener() {} }; }
function chan() {
  const sent = [];
  return { readyState: 'open', bufferedAmount: 0, send: (b) => sent.push(b), sent };
}
function wiredPeer(id = 1) {
  const p = new Peer(fakePc(), id);
  p.state = chan();
  p.events = chan();
  return p;
}
function readEvent(bytes) {
  const r = new Reader(bytes);
  const kind = r.u8();
  return { kind, name: r.str(), payload: r.json() };
}

function hostWithBus() {
  const host = new NetHost();
  const handlers = new Map();
  const ctx = {
    authority: true, seed: 1, time: 0,
    events: {
      on: (n, f) => { (handlers.get(n) ?? handlers.set(n, []).get(n)).push(f); },
      emit: (n, p) => { for (const f of handlers.get(n) ?? []) f(p); },
    },
    combat: { entities: [] },
  };
  host.init(ctx);
  const peer = wiredPeer(1);
  host.transport.peers.set(1, peer);
  host.clients.set(1, { peer, pawn: null, inputs: [], lastTick: 0 });
  return { host, ctx, peer };
}

// ============================================================================
console.log('protocol version was bumped for the new realmOffer vocabulary');
// ============================================================================
{
  ok(PROTOCOL_VERSION >= 14, `PROTOCOL_VERSION is at least 14 (got ${PROTOCOL_VERSION})`);
}

// ============================================================================
console.log('NetHost forwards realmOffer to every peer, like realmEnter/realmExit');
// ============================================================================
{
  const { ctx, peer } = hostWithBus();
  const realmId = [...REALM_BY_ID.keys()][0];
  ctx.events.emit('realmOffer', { id: realmId, kind: 'gateway', stage: 2, cost: 40 });

  ok(peer.events.sent.length === 1, `one realmOffer reached the peer (got ${peer.events.sent.length})`);
  if (peer.events.sent.length === 1) {
    const ev = readEvent(peer.events.sent[0]);
    ok(ev.kind === MSG.EVENT, 'it is an EVENT message');
    ok(ev.name === 'realmOffer', `named realmOffer (got ${ev.name})`);
    ok(ev.payload?.id === realmId, `carries the realm id (got ${ev.payload?.id})`);
    ok(ev.payload?.kind === 'gateway' && ev.payload?.stage === 2 && ev.payload?.cost === 40,
      'carries kind/stage/cost intact');
  } else {
    fail += 4; // keep the assertion count stable when the wire arm is red
  }
}

// ============================================================================
console.log('RealmWarm.offer/step are authority-agnostic — the client path is the host path');
// ============================================================================
{
  const realmId = [...REALM_BY_ID.keys()][0];
  // No `ctx.authority` anywhere in this fixture: a client-shaped ctx that only
  // has a renderer, exactly what `RealmWarm.offer` gates on.
  const ctx = { pipeline: { renderer: {} }, scene: null, stage: null, realms: null };
  const warm = new RealmWarm(ctx);
  ctx.realms = { inRealm: false };

  warm.offer(realmId);
  ok(warm.records.has(realmId), 'offer() recorded the realm with no authority check');
  ok(warm.records.get(realmId).step === 'build', 'starts at the build step, same as the host path');
}

// ============================================================================
console.log('an offer for a realm never entered is released without leaking');
// ============================================================================
{
  const realmId = [...REALM_BY_ID.keys()][0];
  const ctx = { pipeline: { renderer: {} }, scene: null, stage: null, realms: null };
  const warm = new RealmWarm(ctx);
  ctx.realms = { inRealm: false };
  warm.offer(realmId);

  let disposed = 0;
  const rec = warm.records.get(realmId);
  rec.stage = { dispose: () => { disposed++; } };
  rec.rt = { dispose: () => { disposed++; } };

  warm.clear();
  ok(warm.records.size === 0, 'clear() drops the record for a door never taken');
  ok(disposed === 2, `clear() disposed the parked stage and its probe (got ${disposed})`);
}

// ============================================================================
console.log('the frame budget guard can fail — disabling the client warm path leaves the client cold');
// ============================================================================
{
  // Demonstrates the guard is not vacuously green: a ctx with no renderer
  // (the "client warm path disabled" case) must never accept an offer, and a
  // real ctx must. Both branches of `offer()`'s gate are exercised.
  const realmId = [...REALM_BY_ID.keys()][0];
  const disabledCtx = { pipeline: { renderer: null }, scene: null, stage: null, realms: { inRealm: false } };
  const warmDisabled = new RealmWarm(disabledCtx);
  warmDisabled.offer(realmId);
  ok(warmDisabled.records.size === 0, 'with the client warm path disabled (no renderer), the offer is dropped');

  const enabledCtx = { pipeline: { renderer: {} }, scene: null, stage: null, realms: { inRealm: false } };
  const warmEnabled = new RealmWarm(enabledCtx);
  warmEnabled.offer(realmId);
  ok(warmEnabled.records.size === 1, 'with the path enabled, the same offer is recorded');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
