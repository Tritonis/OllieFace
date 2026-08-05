/**
 * The ?netlag= / ?netloss= rig.
 *
 *   node tests/netlag.test.mjs
 *
 * Checks the two properties that matter: it is exactly a no-op when off, and
 * when on it delays without reordering and drops only the unreliable channel.
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
  p.state = chan();
  p.events = chan();
  if (sim) p.installSim(sim, () => p._t);
  p._t = 0;
  return p;
}

console.log('off — sends land immediately and pumpSim is inert');
{
  const p = peerWith(null);
  p.sendState(new Uint8Array([1]));
  p.sendEvent(new Uint8Array([2]));
  ok(p.state.sent.length === 1, 'state sent immediately');
  ok(p.events.sent.length === 1, 'event sent immediately');
  p.pumpSim();
  ok(p.state.sent.length === 1, 'pumpSim added nothing');
}

console.log('on — a delayed packet is held, then released in order');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  p.sendState(new Uint8Array([1]));
  p.sendState(new Uint8Array([2]));
  ok(p.state.sent.length === 0, 'nothing sent yet');
  p._t = 0.049; p.pumpSim();
  ok(p.state.sent.length === 0, 'still held just under the delay');
  p._t = 0.051; p.pumpSim();
  ok(p.state.sent.length === 2, `both released (got ${p.state.sent.length})`);
  ok(p.state.sent[0][0] === 1 && p.state.sent[1][0] === 2, 'released in order');
}

console.log('on — under jitter, release stays in send order even when a later packet is due sooner');
{
  // jitterMs:0 above ties both packets' due times, so a broken sort-by-due
  // release would pass that check too (stable sort on equal keys). Force
  // distinct delays by mocking Math.random so the FIRST-sent packet draws
  // the LONGER delay and the SECOND-sent packet draws the SHORTER one — a
  // due-sorted implementation would then release the second packet first.
  const p = peerWith({ on: true, lagMs: 0, jitterMs: 100, lossPct: 0 });
  p._t = 0;
  const realRandom = Math.random;
  const draws = [0.99, 0.01]; // packet A -> due 0.099s, packet B -> due 0.001s
  let di = 0;
  Math.random = () => draws[di++];
  try {
    p.sendState(new Uint8Array([10])); // A: sent first, due later
    p.sendState(new Uint8Array([11])); // B: sent second, due sooner
  } finally {
    Math.random = realRandom;
  }
  p._t = 0.05; p.pumpSim();
  ok(p.state.sent.length === 0, `B's earlier due time does not jump the still-held A (got ${p.state.sent.length})`);
  p._t = 0.10; p.pumpSim();
  ok(
    p.state.sent.length === 2 && p.state.sent[0][0] === 10 && p.state.sent[1][0] === 11,
    `both released in send order despite B being due first (got ${p.state.sent.map((b) => b[0])})`
  );
}

console.log('on — loss applies to the unreliable channel only');
{
  const p = peerWith({ on: true, lagMs: 0, jitterMs: 0, lossPct: 100 });
  p._t = 0;
  for (let i = 0; i < 10; i++) p.sendState(new Uint8Array([i]));
  for (let i = 0; i < 10; i++) p.sendEvent(new Uint8Array([i]));
  p._t = 1; p.pumpSim();
  ok(p.state.sent.length === 0, `every state packet dropped (got ${p.state.sent.length})`);
  ok(p.events.sent.length === 10, `no event packet dropped (got ${p.events.sent.length})`);
}

// The queue is shared by both channels, so its overflow policy is a statement
// about the reliable channel whether or not it was written as one. An
// unqualified `shift()` here drops a queued `events` packet — a HELLO, a
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
    for (let i = 0; i < n; i++) p.sendEvent(i);
  } finally {
    console.warn = realWarn;
  }
  p._t = 1; p.pumpSim();
  ok(p.events.sent.length === n, `every reliable packet survived the cap (got ${p.events.sent.length} of ${n})`);
  ok(
    p.events.sent[0] === 0 && p.events.sent[n - 1] === n - 1,
    `and in order, oldest first (got ${p.events.sent[0]}..${p.events.sent[n - 1]})`
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
  for (let i = 0; i < events; i++) p.sendEvent(i);
  for (let i = 0; i < MAX_SIM_QUEUE; i++) p.sendState(i);
  ok(p._simQueue.length === MAX_SIM_QUEUE, `queue held at the cap (got ${p._simQueue.length})`);
  p._t = 1; p.pumpSim();
  ok(p.events.sent.length === events, `no event evicted to make room (got ${p.events.sent.length})`);
  ok(
    p.state.sent.length === MAX_SIM_QUEUE - events,
    `exactly ${events} state packets paid for them (got ${MAX_SIM_QUEUE - p.state.sent.length})`
  );
  ok(p.state.sent[0] === events, `and they were the oldest, not the newest (got ${p.state.sent[0]}, want ${events})`);
}

console.log('overflow — a state-only stall is still bounded by the cap');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  const over = 64;
  for (let i = 0; i < MAX_SIM_QUEUE + over; i++) p.sendState(i);
  ok(p._simQueue.length === MAX_SIM_QUEUE, `queue never grows past the cap (got ${p._simQueue.length})`);
  p._t = 1; p.pumpSim();
  ok(p.state.sent[0] === over, `the oldest ${over} were dropped (first survivor ${p.state.sent[0]}, want ${over})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
