/**
 * The ?netlag= / ?netloss= rig.
 *
 *   node tests/netlag.test.mjs
 *
 * Checks the two properties that matter: it is exactly a no-op when off, and
 * when on it delays without reordering and drops only the unreliable channel.
 */
import { Peer } from '../src/net/Transport.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
