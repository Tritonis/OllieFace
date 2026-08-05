/**
 * I1 — the join window between "answer accepted" and "channels open".
 *
 *   node tests/connect-deadline.test.mjs
 *
 * `ready` resolves only when both data channels open. On a peer whose
 * connection never forms it neither resolved nor rejected, so
 * `HostTransport`'s `accept`, `Lobby.acceptAnswer` and the `await` in the co-op
 * panel all waited for ever — reaching neither their success path nor their
 * `catch`. Every refusal door `NetHost` owns is downstream of `_onPeer`, so the
 * whole failure was silent on both machines.
 *
 * Stands up the real `HostTransport` against a fake `RTCPeerConnection` — the
 * defect is in the promise wiring, so the wiring is what has to be driven — and
 * shortens the deadline through the `_connectTimeoutMs()` seam, the same shape
 * `NetHost._now()` uses so the HELLO age gate is testable.
 */
import { HostTransport } from '../src/net/Transport.js';
import { NetHost } from '../src/net/NetHost.js';
import { Lobby } from '../src/net/Lobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakeChannel(label) {
  return {
    label, readyState: 'connecting', bufferedAmount: 0, binaryType: '',
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send() {}, close() {},
    open() { this.readyState = 'open'; this.onopen?.(); },
  };
}

function fakePc() {
  const channels = [];
  return {
    channels,
    connectionState: 'new',
    iceGatheringState: 'complete',
    localDescription: { type: 'offer', sdp: 'v=0' },
    createDataChannel(label) { const c = fakeChannel(label); channels.push(c); return c; },
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    addEventListener() {}, removeEventListener() {},
    close() {},
  };
}

globalThis.RTCPeerConnection = function RTCPeerConnectionStub() { return fakePc(); };

/** The answer blob the host expects back for `invite`. */
const answerFor = (invite) =>
  btoa(JSON.stringify({ v: 1, role: 'answer', id: invite.id, sdp: { type: 'answer', sdp: 'v=0' } }));

/**
 * Await `p`, but never longer than `ms`.
 *
 * Without this the deliberate-failure exercise (remove the deadline, watch the
 * assertion fail) hangs the process instead of printing a FAIL line — and a
 * gate whose failure mode is a hang cannot be demonstrated.
 */
function settleWithin(p, ms) {
  return Promise.race([
    p.then(() => 'resolved', (e) => 'rejected: ' + e.message),
    new Promise((r) => setTimeout(() => r('never settled'), ms)),
  ]);
}

console.log('I1 — a peer whose channels never open makes `accept` reject, not hang');
{
  const t = new HostTransport();
  t._connectTimeoutMs = () => 20;   // the seam, not a 20 s test
  const left = [];
  t.onPeerLeave = (p) => left.push(p.id);

  const invite = await t.createInvite();
  const outcome = await settleWithin(invite.accept(answerFor(invite)), 2000);

  ok(outcome.startsWith('rejected'), `accept settled on the deadline (got '${outcome}')`);
  ok(/never finished connecting/.test(outcome), `and says so in words a player can report (got '${outcome}')`);
  ok(left.length === 1, `the peer was dropped through onPeerLeave (got ${left.length})`);
  ok(!t.peers.has(invite.id), 'and is gone from transport.peers');
}

console.log('I1 — the other end of the range: a join that opens in time is untouched');
{
  const t = new HostTransport();
  t._connectTimeoutMs = () => 2000;   // long enough that a healthy join wins
  const left = [];
  t.onPeerLeave = (p) => left.push(p.id);
  const opened = [];
  t.onPeer = (p) => opened.push(p.id);

  const invite = await t.createInvite();
  const accepted = invite.accept(answerFor(invite));
  // The channels open the way a real connection does: after the answer, before
  // the deadline.
  const peer = t.peers.get(invite.id);
  peer.state.open();
  peer.events.open();

  const outcome = await settleWithin(accepted, 2000);
  ok(outcome === 'resolved', `a healthy join still resolves (got '${outcome}')`);
  ok(left.length === 0, `and is not dropped by the deadline (got ${left.length} leaves)`);
  ok(opened.length === 1, 'onPeer fired exactly once');
}

console.log('I1 — a peer that dies before `_onPeer` is logged, not swallowed');
{
  const host = new NetHost({ maxPlayers: 4 });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    // Exactly the shape `HostTransport._drop` passes on for a peer that never
    // reached `clients`.
    host._onPeerLeave({ id: 3 });
  } finally {
    console.warn = realWarn;
  }
  ok(warns.length === 1, `the drop is recorded (got ${warns.length} lines)`);
  ok(/peer 3/.test(warns[0] ?? ''), `and names the peer (got '${warns[0]}')`);
}

console.log('I1 — the other end: a peer that did join leaves through the normal path, silently');
{
  const host = new NetHost({ maxPlayers: 4 });
  const emitted = [];
  host.ctx = { events: { emit: (n, p) => emitted.push([n, p]) } };
  host.clients.set(5, { peer: { id: 5 }, pawn: null, inputs: [], lastTick: 0 });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    host._onPeerLeave({ id: 5 });
  } finally {
    console.warn = realWarn;
  }
  ok(warns.length === 0, `no warning for an ordinary leave (got ${warns.length})`);
  ok(emitted.some(([n]) => n === 'netPlayerLeft'), 'netPlayerLeft still emitted');
}

console.log('I1 — Lobby surfaces the failure and does not keep the spent invite');
{
  const handlers = new Map();
  const ctx = {
    netRole: 'single', authority: true,
    events: {
      on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
  };
  const lobby = new Lobby({ add: (s) => s }, ctx);
  const seen = [];
  lobby.onStatus = (s) => seen.push(s);
  lobby.pendingInvites.set(7, {
    accept: async () => { throw new Error('That player never finished connecting.'); },
  });
  lobby._inviteIdFor = () => 7;

  let caught = null;
  await lobby.acceptAnswer('irrelevant-blob').catch((e) => { caught = e; });

  ok(caught !== null, 'acceptAnswer rejects rather than resolving quietly');
  ok(lobby.status === 'peerFailed', `the panel stops saying "connecting…" (got '${lobby.status}')`);
  ok(seen.indexOf('peerConnecting') < seen.indexOf('peerFailed'), `in that order (${JSON.stringify(seen)})`);
  ok(!lobby.pendingInvites.has(7), 'the spent invite is dropped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
