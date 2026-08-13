/**
 * The ?netlag= / ?netloss= rig.
 *
 *   node tests/netlag.test.mjs
 *
 * Checks the two properties that matter: it is exactly a no-op when off, and
 * when on it delays without reordering and drops only the unreliable channel.
 *
 * The rig simulates flight time on the **receive** side — a send goes on the
 * wire immediately, and the delay is applied to the arrival — so every block
 * below drives `ch.onmessage`, which is the seam `Peer._wire` owns, and asserts
 * on what reached `peer.onMessage`. See `installSim`'s header for why the delay
 * cannot live on the send side: it made the wire wait on the sender's frame
 * loop, and no co-op join could form at a delay of one frame or more.
 */
import { Peer, MAX_SIM_QUEUE } from '../src/net/Transport.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakePc() { return { close() {}, addEventListener() {}, removeEventListener() {} }; }

function chan() {
  const sent = [];
  return { readyState: 'open', bufferedAmount: 0, send: (b) => sent.push(b), sent };
}

function peerWith(sim) {
  const p = new Peer(fakePc(), 1);
  p.state = p._wire(chan(), 'state');
  p.events = p._wire(chan(), 'events');
  p.got = { state: [], events: [] };
  p.onMessage = (data, label) => p.got[label].push(data);
  if (sim) p.installSim(sim, () => p._t);
  p._t = 0;
  return p;
}

/** One packet arriving off the wire on `label`. */
const arrive = (p, label, data) => p[label].onmessage({ data });

console.log('off — arrivals deliver immediately and pumpSim is inert');
{
  const p = peerWith(null);
  arrive(p, 'state', new Uint8Array([1]));
  arrive(p, 'events', new Uint8Array([2]));
  ok(p.got.state.length === 1, 'state delivered immediately');
  ok(p.got.events.length === 1, 'event delivered immediately');
  p.pumpSim();
  ok(p.got.state.length === 1, 'pumpSim added nothing');
  // The other half of "exactly a no-op when off": sends still go straight out.
  p.sendState(new Uint8Array([3]));
  p.sendEvent(new Uint8Array([4]));
  ok(p.state.sent.length === 1 && p.events.sent.length === 1, 'sends land immediately');
}

console.log('on — a delayed arrival is held, then released in order');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  arrive(p, 'state', new Uint8Array([1]));
  arrive(p, 'state', new Uint8Array([2]));
  ok(p.got.state.length === 0, 'nothing delivered yet');
  p._t = 0.049; p.pumpSim();
  ok(p.got.state.length === 0, 'still held just under the delay');
  p._t = 0.051; p.pumpSim();
  ok(p.got.state.length === 2, `both released (got ${p.got.state.length})`);
  ok(p.got.state[0][0] === 1 && p.got.state[1][0] === 2, 'released in order');
}

console.log('on — a send is never held: the wire does not wait on this page');
{
  // The property the receive-side inversion exists to guarantee, and the one
  // the old send-side rig could not: whatever the local frame loop is doing,
  // an outbound packet is on the wire in the same call. A join handshake dies
  // if this is not true — measured at 3.9 s of held HELLO, see installSim.
  const p = peerWith({ on: true, lagMs: 90, jitterMs: 0, lossPct: 100 });
  p._t = 0;
  p.sendEvent(new Uint8Array([1]));
  p.sendState(new Uint8Array([2]));
  ok(p.events.sent.length === 1, 'reliable send went out immediately, undelayed');
  ok(p.state.sent.length === 1, 'unreliable send went out immediately, undropped');
  ok(p._simQueue.length === 0, `and nothing outbound was queued (got ${p._simQueue.length})`);
}

console.log('on — under jitter, release stays in arrival order even when a later packet is due sooner');
{
  // jitterMs:0 above ties both packets' due times, so a broken sort-by-due
  // release would pass that check too (stable sort on equal keys). Force
  // distinct delays by mocking Math.random so the FIRST-arrived packet draws
  // the LONGER delay and the SECOND-arrived packet draws the SHORTER one — a
  // due-sorted implementation would then release the second packet first.
  const p = peerWith({ on: true, lagMs: 0, jitterMs: 100, lossPct: 0 });
  p._t = 0;
  const realRandom = Math.random;
  const draws = [0.99, 0.01]; // packet A -> due 0.099s, packet B -> due 0.001s
  let di = 0;
  Math.random = () => draws[di++];
  try {
    arrive(p, 'state', new Uint8Array([10])); // A: arrived first, due later
    arrive(p, 'state', new Uint8Array([11])); // B: arrived second, due sooner
  } finally {
    Math.random = realRandom;
  }
  p._t = 0.05; p.pumpSim();
  ok(p.got.state.length === 0, `B's earlier due time does not jump the still-held A (got ${p.got.state.length})`);
  p._t = 0.10; p.pumpSim();
  ok(
    p.got.state.length === 2 && p.got.state[0][0] === 10 && p.got.state[1][0] === 11,
    `both released in arrival order despite B being due first (got ${p.got.state.map((b) => b[0])})`
  );
}

// A `Peer` enters `HostTransport.peers` at *invite* time, seconds or minutes
// before its channels open, and `NetHost._forward` broadcasts over `peers`. The
// shipped transport drops those sends — `sendEvent` checks `readyState` — and
// the send-side rig used to queue them first and release the whole pre-connect
// backlog in one burst on the first pump after open: goldChanged, levelUp,
// kill, stageStart, bossSpawn, playerDead and a stale realmEnter/realmExit
// pair, none of which the shipped game delivers. With the rig on the receive
// side that burst is structurally impossible — a send is never queued at all —
// and this is the regression test that says so.
console.log('on — a send on a channel that is not open is dropped, exactly as when off');
{
  const p = peerWith({ on: true, lagMs: 60, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  p.events.readyState = 'connecting';
  p.state.readyState = 'connecting';
  for (let i = 0; i < 40; i++) p.sendEvent(new Uint8Array([i]));
  for (let i = 0; i < 40; i++) p.sendState(new Uint8Array([i]));
  ok(p._simQueue.length === 0, `nothing queued while connecting (got ${p._simQueue.length})`);
  ok(p.events.sent.length === 0 && p.state.sent.length === 0, 'and nothing was sent on a closed channel');

  // The channels open, as they do the instant the peer actually connects.
  p.events.readyState = 'open';
  p.state.readyState = 'open';
  p._t = 10; p.pumpSim();
  ok(p.events.sent.length === 0, `no event burst on open (got ${p.events.sent.length})`);
  ok(p.state.sent.length === 0, `no snapshot burst on open (got ${p.state.sent.length})`);
}

console.log('on — the other end: an arrival is delayed, not dropped');
{
  const p = peerWith({ on: true, lagMs: 60, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  arrive(p, 'events', new Uint8Array([1]));
  ok(p._simQueue.length === 1, `a reliable arrival goes through the rig (got ${p._simQueue.length})`);
  p._t = 0.07; p.pumpSim();
  ok(p.got.events.length === 1, `and is delivered after the delay (got ${p.got.events.length})`);
}

console.log('on — every held packet is delivered exactly once, however often it is pumped');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  for (let i = 0; i < 8; i++) arrive(p, 'events', new Uint8Array([i]));
  for (let t = 0; t <= 0.2; t += 0.005) { p._t = t; p.pumpSim(); }
  p._t = 5; p.pumpSim(); p.pumpSim();
  ok(p.got.events.length === 8, `eight arrivals, eight deliveries (got ${p.got.events.length})`);
  ok(p.got.events.every((b, i) => b[0] === i), `each exactly once, in order (got ${p.got.events.map((b) => b[0])})`);
}

console.log('on — loss applies to the unreliable channel only');
{
  const p = peerWith({ on: true, lagMs: 0, jitterMs: 0, lossPct: 100 });
  p._t = 0;
  for (let i = 0; i < 10; i++) arrive(p, 'state', new Uint8Array([i]));
  for (let i = 0; i < 10; i++) arrive(p, 'events', new Uint8Array([i]));
  p._t = 1; p.pumpSim();
  ok(p.got.state.length === 0, `every state packet dropped (got ${p.got.state.length})`);
  ok(p.got.events.length === 10, `no event packet dropped (got ${p.got.events.length})`);
}

console.log('clock — an injected clock means the caller pumps; no clock means the peer pumps itself');
{
  const driven = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  ok(driven._simTimer == null, 'a peer given a clock arms no timer — the test drives time');

  const selfDriven = new Peer(fakePc(), 2);
  selfDriven.state = selfDriven._wire(chan(), 'state');
  selfDriven.installSim({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  ok(selfDriven._simTimer != null, 'a peer given no clock arms its own pump');
  selfDriven.close();
  ok(selfDriven._simTimer == null, 'and clears it on close — no leaked interval');
}

// The queue is shared by both channels, so its overflow policy is a statement
// about the reliable channel whether or not it was written as one. An
// unqualified `shift()` here drops a held `events` packet — a HELLO, a
// WELCOME, a forwarded event — silently, and the rig then measures a transport
// the game does not ship. These three cover the whole policy: reliable is never
// lost, state is what pays, and the cap still bounds a state-only stall.
console.log('overflow — a reliable backlog past the cap loses nothing');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  const n = MAX_SIM_QUEUE + 64;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    for (let i = 0; i < n; i++) arrive(p, 'events', i);
  } finally {
    console.warn = realWarn;
  }
  p._t = 1; p.pumpSim();
  ok(p.got.events.length === n, `every reliable packet survived the cap (got ${p.got.events.length} of ${n})`);
  ok(
    p.got.events[0] === 0 && p.got.events[n - 1] === n - 1,
    `and in order, oldest first (got ${p.got.events[0]}..${p.got.events[n - 1]})`
  );
  ok(warns.length === 1, `growing past the cap warns exactly once, not per packet (got ${warns.length})`);
}

console.log('overflow — with both channels queued, state is what gets evicted');
{
  // The events go in FIRST and the state after, so the oldest entries in the
  // queue are the reliable ones. That ordering is the whole point: a plain
  // `shift()` looks correct when state happens to be at the front, so a test
  // that fills state-then-events would pass against the bug it exists to catch.
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  const events = 64;
  for (let i = 0; i < events; i++) arrive(p, 'events', i);
  for (let i = 0; i < MAX_SIM_QUEUE; i++) arrive(p, 'state', i);
  ok(p._simQueue.length === MAX_SIM_QUEUE, `queue held at the cap (got ${p._simQueue.length})`);
  p._t = 1; p.pumpSim();
  ok(p.got.events.length === events, `no event evicted to make room (got ${p.got.events.length})`);
  ok(
    p.got.state.length === MAX_SIM_QUEUE - events,
    `exactly ${events} state packets paid for them (got ${MAX_SIM_QUEUE - p.got.state.length})`
  );
  ok(p.got.state[0] === events, `and they were the oldest, not the newest (got ${p.got.state[0]}, want ${events})`);
}

console.log('overflow — a state-only stall is still bounded by the cap');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  const over = 64;
  for (let i = 0; i < MAX_SIM_QUEUE + over; i++) arrive(p, 'state', i);
  ok(p._simQueue.length === MAX_SIM_QUEUE, `queue never grows past the cap (got ${p._simQueue.length})`);
  p._t = 1; p.pumpSim();
  ok(p.got.state[0] === over, `the oldest ${over} were dropped (first survivor ${p.got.state[0]}, want ${over})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
