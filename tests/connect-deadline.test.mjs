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
import { HostTransport, ClientTransport } from '../src/net/Transport.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
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
  const pc = {
    channels,
    connectionState: 'new',
    iceGatheringState: 'complete',
    localDescription: { type: 'offer', sdp: 'v=0' },
    createDataChannel(label) { const c = fakeChannel(label); channels.push(c); return c; },
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0' }; },
    async setLocalDescription() {},
    async setRemoteDescription() {},
    addEventListener() {}, removeEventListener() {},
    /**
     * Drive the browser's own connection-state signal.
     *
     * `close()` routes through here rather than being inert, because that is
     * what a real `RTCPeerConnection` does: closing fires
     * `onconnectionstatechange` with `closed` from inside the call. That
     * re-entry is not incidental — it is the reason both transports' handlers
     * have to be idempotent and the reason `NetClient._reportDisconnect` has a
     * once-only guard at all. A stub with an inert `close()` cannot reach any
     * of it.
     */
    _setState(s) {
      if (pc.connectionState === s) return;
      pc.connectionState = s;
      pc.onconnectionstatechange?.();
    },
    close() { pc._setState('closed'); },
  };
  return pc;
}

const pcs = [];
globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
  const pc = fakePc();
  pcs.push(pc);
  return pc;
};
/** The `RTCPeerConnection` the transport under test just built. */
const lastPc = () => pcs[pcs.length - 1];

/** The answer blob the host expects back for `invite`. */
const answerFor = (invite) =>
  btoa(JSON.stringify({ v: 1, role: 'answer', id: invite.id, sdp: { type: 'answer', sdp: 'v=0' } }));

/** A host invite blob, from the joiner's point of view. */
const offerBlob = (id) =>
  btoa(JSON.stringify({ v: 1, role: 'offer', id, sdp: { type: 'offer', sdp: 'v=0' } }));

/** Yield to the macrotask queue, so promise chains and node's own unhandled-rejection reporting run. */
const turn = (ms = 0) => new Promise((r) => setTimeout(r, ms));

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

/* --------------------------------------------------------------------------
 * I2 — the host's *failure* signal, as distinct from its deadline.
 *
 * The deadline above is the backstop for a connection that never fails and
 * never opens. It is not the signal for one that fails: ICE can fail in three
 * seconds, and until the host rejected `ready` on it the co-op panel went on
 * reading "Reply accepted — connecting…" for the remaining seventeen — while
 * the console had already logged the drop. Every arm below therefore uses a
 * deadline long enough that reaching it is itself the failure.
 * ------------------------------------------------------------------------ */

console.log('I2 — the host settles on the connection failure, not on the deadline');
{
  const t = new HostTransport();
  t._connectTimeoutMs = () => 5000;   // if this arm waits for the deadline, it fails
  const left = [];
  t.onPeerLeave = (p) => left.push(p.id);

  const invite = await t.createInvite();
  const accepted = invite.accept(answerFor(invite));
  await turn();                        // let `accept` arm the deadline first
  lastPc()._setState('failed');        // ICE gives up, well inside the window

  const outcome = await settleWithin(accepted, 300);   // a sixteenth of the deadline
  ok(outcome.startsWith('rejected'), `accept settled on the failure (got '${outcome}')`);
  ok(/connection failed/.test(outcome), `and says what happened (got '${outcome}')`);
  ok(left.length === 1, `the peer was dropped through onPeerLeave exactly once (got ${left.length})`);
  ok(!t.peers.has(invite.id), 'and is gone from transport.peers');
}

console.log('I2 — the other end: a join that already succeeded is not retroactively failed');
{
  const t = new HostTransport();
  t._connectTimeoutMs = () => 5000;
  const left = [];
  t.onPeerLeave = (p) => left.push(p.id);

  const invite = await t.createInvite();
  const accepted = invite.accept(answerFor(invite));
  const peer = t.peers.get(invite.id);
  peer.state.open();
  peer.events.open();
  ok(await settleWithin(accepted, 300) === 'resolved', 'the healthy join resolves');

  // The session ends later, the way every session ends. `ready` is already
  // settled, so the new reject is a no-op — but the drop still has to happen.
  lastPc()._setState('failed');
  ok(left.length === 1, `the later drop still reaches onPeerLeave (got ${left.length})`);
  ok(await settleWithin(accepted, 100) === 'resolved',
     'and the completed join is still resolved, not rewritten into a rejection');
}

console.log('I2 — a failure before the answer is pasted is dropped, not thrown into the void');
{
  // `ready`'s rejection now exists from `createInvite`, which is before any
  // caller holds a promise — the host is still waiting for a human to paste a
  // code. Without the rejection handler on the internal `onPeer` chain that is
  // an unhandled rejection on a machine that has done nothing wrong.
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e?.message ?? e));
  process.on('unhandledRejection', onUnhandled);
  try {
    const t = new HostTransport();
    const left = [];
    t.onPeerLeave = (p) => left.push(p.id);
    const invite = await t.createInvite();
    lastPc()._setState('failed');
    await turn(20);                    // node reports unhandled rejections a turn later
    ok(left.length === 1 && left[0] === invite.id,
       `the peer left through onPeerLeave (got ${JSON.stringify(left)})`);
    ok(unhandled.length === 0, `and nothing was left unhandled (got ${JSON.stringify(unhandled)})`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

/* --------------------------------------------------------------------------
 * I3 — the joiner's half of the same fix, which had no test at all.
 * ------------------------------------------------------------------------ */

console.log('I3 — a client whose connection fails rejects `connected` rather than hanging');
{
  const c = new ClientTransport();
  const reports = [];
  c.onDisconnected = () => reports.push(1);

  const { connected } = await c.join(offerBlob(11));
  // No `ondatachannel` ever fires: the channels are the host's to create and
  // this connection dies before it carries one.
  lastPc()._setState('failed');

  const outcome = await settleWithin(connected, 300);
  ok(outcome.startsWith('rejected'), `the join settles (got '${outcome}')`);
  ok(/connection to the host failed/.test(outcome), `and says so (got '${outcome}')`);
  // The measurement the guard in `NetClient._reportDisconnect` exists for, made
  // rather than asserted from the source: the handler calls `peer.close()`,
  // which re-enters it with state `closed`, so the transport reports the same
  // dead connection twice.
  ok(reports.length === 2,
     `onDisconnected fires twice — peer.close() re-enters the handler (got ${reports.length})`);
}

console.log('I3 — the joiner says "disconnected" once when both report paths are live');
{
  const client = new NetClient();
  const emitted = [];
  client.ctx = { events: { emit: (n) => emitted.push(n) } };
  const peer = { id: 1, sendEvent() {}, onMessage: null, onClose: null };
  // A transport stand-in, because what is under test is `join`'s wiring of the
  // two report paths, not the transport it wires them to.
  client.transport = { join: async () => ({ blob: 'b', connected: Promise.resolve(peer) }) };

  await client.join('irrelevant-blob');
  await turn();
  ok(client.connected === true, 'the client came up');
  ok(typeof peer.onClose === 'function', 'and the peer-close path is wired');

  peer.onClose();                     // a peer that connected and then dropped…
  client.transport.onDisconnected();  // …reported by both live sources
  ok(emitted.filter((n) => n === 'netDisconnected').length === 1,
     `netDisconnected emitted exactly once (got ${JSON.stringify(emitted)})`);
  ok(client.connected === false, 'and the client knows it is down');
}

console.log('I3 — the other end: a client that never connected still says it once');
{
  const client = new NetClient();
  const emitted = [];
  client.ctx = { events: { emit: (n) => emitted.push(n) } };
  // The failure the previous NetClient arm cannot reach: `connected` rejects,
  // so `onClose` is never wired and the transport is the only source — firing
  // the two times the real `ClientTransport` was just measured firing.
  client.transport = { join: async () => ({ blob: 'b', connected: Promise.reject(new Error('failed')) }) };

  await client.join('irrelevant-blob');
  await turn();
  client.transport.onDisconnected();
  client.transport.onDisconnected();
  ok(emitted.filter((n) => n === 'netDisconnected').length === 1,
     `netDisconnected emitted exactly once (got ${JSON.stringify(emitted)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
