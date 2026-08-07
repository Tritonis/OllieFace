/**
 * waitForIce — the non-trickle gathering wait both sides of a join block on.
 *
 *   node tests/ice-quiescence.test.mjs
 *
 * This file exists to pin a refusal. An "optimization" that resolved the wait
 * once candidates went quiet was tried and refuted by measurement: it turned a
 * 4/4-success four-player probe into 0/2 failures with 10-14 s joins, because
 * Chromium's host candidates are mDNS names a remote peer may not resolve, so
 * the blob is not trustworthy until the reflexive candidate lands — the *last*
 * thing gathering produces. Full evidence with the captured failed session:
 * reviews/audit-fixes/ice-quiescence-refuted.md.
 *
 * The third case below is the regression gate: candidates going quiet MUST NOT
 * resolve the wait early. If someone reintroduces the quiet-period exit, that
 * case fails.
 */
import { waitForIce } from '../src/net/Transport.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakePc(state = 'gathering') {
  const listeners = new Map();
  return {
    iceGatheringState: state,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, ev = {}) { for (const fn of [...(listeners.get(type) ?? [])]) fn(ev); },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timed(promise) {
  const t0 = Date.now();
  await promise;
  return Date.now() - t0;
}

// Short cap through the test seam so the whole file runs in under a second;
// the shipped call sites leave it at the 4000 ms default.
const CAP = 300;

{
  console.log('already complete resolves immediately');
  const ms = await timed(waitForIce(fakePc('complete'), CAP));
  ok(ms < 30, `resolved in ${ms}ms without waiting`);
}

{
  console.log("'complete' event resolves promptly, before the cap");
  const pc = fakePc();
  const p = timed(waitForIce(pc, CAP));
  await sleep(20);
  pc.iceGatheringState = 'complete';
  pc.emit('icegatheringstatechange');
  const ms = await p;
  ok(ms < CAP - 50, `resolved in ${ms}ms on the state change`);
  ok(pc.listenerCount('icegatheringstatechange') === 0, 'state listener removed');
}

{
  console.log('REGRESSION GATE — candidates going quiet do not resolve early; only complete or the cap do');
  const pc = fakePc();
  const p = timed(waitForIce(pc, CAP));
  await sleep(10);
  pc.emit('icecandidate', { candidate: { candidate: 'a=host' } });
  await sleep(10);
  pc.emit('icecandidate', { candidate: { candidate: 'a=host2' } });
  // A long quiet follows — far longer than any plausible quiet-period
  // heuristic — and the wait must still hold to the cap.
  const ms = await p;
  ok(ms >= CAP - 10, `held to the ${CAP}ms cap through candidate silence (${ms}ms)`);
}

{
  console.log('no candidate at all also holds to the cap');
  const pc = fakePc();
  const ms = await timed(waitForIce(pc, CAP));
  ok(ms >= CAP - 10, `held to the cap (${ms}ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
