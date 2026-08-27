// tests/peer-silence-race.test.mjs
// Issue #214: `peerSilenceFor` is consulted from `Items.fixedUpdate` while
// `lastSeen` is stamped from an async `onMessage` callback. Two different
// clocks, and the failure mode the review worried about is a host whose own
// fixed step stalls (a slow frame, a GC pause, a blocked main thread) getting
// mistaken for a peer that actually stopped talking.
//
// `tests/mutation-remote-choice.test.mjs`'s silence arms fake
// `ctx.net.peerSilenceFor` directly — useful for `Items`' own contract, but
// blind to exactly the bug this issue names: they never touch the real
// `NetHost.peerSilenceFor` or the real `_handleMessage` stamp, so a broken
// wiring between the two would still read green there. This file drives both
// for real, against a `NetHost` built the same way
// `mutation-remote-choice.test.mjs`'s own last section builds one — `new
// NetHost()` + `init(ctx)` + a hand-set `clients` entry — with `_now`
// monkey-patched to a fake clock, which is the seam `NetHost` itself names:
// "Seconds, monotonic. A seam so the age gates are testable." (NetHost.js:251).
import { NetHost } from '../src/net/NetHost.js';
import { Writer, writeInput, MSG } from '../src/net/Protocol.js';
import { MUTATION } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const THRESHOLD = MUTATION.disconnectSilenceSeconds;

function makeCtx() {
  const listeners = new Map();
  return {
    authority: true, seed: 1, time: 0,
    events: {
      emit(name, p) { for (const fn of (listeners.get(name) || []).slice()) fn(p); },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
        return () => { const a = listeners.get(name); a.splice(a.indexOf(fn), 1); };
      },
    },
  };
}

/** A host whose `_now()` reads a clock this test drives by hand, with one
 * client wired in exactly the shape `_onPeer` would have left it. Returns the
 * host, the fake peer, the pawn stand-in, and a `send(atClock)` helper that
 * moves the clock to `atClock` and then runs a real INPUT message through the
 * real `_handleMessage` — the same path an actual peer's traffic takes,
 * stamping `lastSeen` for real rather than by test fiat. */
function rig() {
  const ctx = makeCtx();
  const net = new NetHost();
  net.init(ctx);
  let clock = 0;
  net._now = () => clock;
  const peer = { id: 1, sendState() {}, sendEvent() {} };
  const pawn = { isPlayer: true };
  net.clients.set(1, {
    peer, pawn, inputs: [], lastTick: 0, name: 'Player 2',
    joinTick: 0, joinedAt: 0, lastSeen: 0, helloSeen: false, survivorId: null,
  });
  let inputTick = 0;
  const send = (atClock) => {
    clock = atClock;
    const bytes = writeInput(new Writer(32), {
      tick: ++inputTick, moveX: 0, moveZ: 0, buttons: 0, yaw: 0, pitch: 0,
    }).bytes();
    net._handleMessage(peer, bytes);
  };
  const advanceClockOnly = (atClock) => { clock = atClock; };
  return { net, pawn, send, advanceClockOnly };
}

console.log('a stalled host fixedUpdate does not read as peer silence while traffic kept arriving');
{
  // Traffic arrives steadily right up to just before the stall ends — the
  // shape a real peer's continuous INPUT/PING stream takes while the host's
  // own fixed step is the thing that stopped running, not the peer.
  const { net, pawn, send } = rig();
  for (const t of [0, 0.5, 1.0, 1.5, 2.0, 2.5, 2.9]) send(t);
  // fixedUpdate finally gets to run again at clock 3.0, a jump that alone
  // would look like a 3s gap if measured from the stall's start rather than
  // from the last real stamp.
  const silence = (() => { net._now = () => 3.0; return net.peerSilenceFor(pawn); })();
  ok(silence < THRESHOLD, `silence since the last real message is small (${silence.toFixed(2)}s < ${THRESHOLD}s)`);
  ok(Math.abs(silence - 0.1) < 1e-9, `it reads from the last stamp (2.9s), not the stall's start (${silence})`);
}

console.log('a peer that genuinely stops talking is read as silent once the threshold passes');
{
  const { net, pawn, send, advanceClockOnly } = rig();
  send(0); // one message, then nothing ever again
  advanceClockOnly(3.0);
  const silence = net.peerSilenceFor(pawn);
  ok(silence >= THRESHOLD, `real silence crosses the threshold (${silence.toFixed(2)}s >= ${THRESHOLD}s)`);
}

console.log('a message that lands mid-stall is measured from where it landed, not from the stall\'s start');
{
  const { net, pawn, send, advanceClockOnly } = rig();
  send(0);
  // A message arrives partway through what would otherwise read as a long
  // gap — the exact race the review worried about: the async onMessage
  // callback fires and stamps lastSeen while fixedUpdate itself is still
  // stalled and has not yet observed anything.
  send(1.5);
  advanceClockOnly(4.0);
  const silence = net.peerSilenceFor(pawn);
  ok(Math.abs(silence - 2.5) < 1e-9, `measured from the mid-stall stamp (4.0 - 1.5 = 2.5), not from tick 0 (got ${silence})`);
  ok(silence >= THRESHOLD, 'and that reading still crosses the threshold on its own account (2.5s), not because it was measured wrong');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
