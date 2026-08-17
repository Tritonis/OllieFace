/**
 * #73 — `createInvite` has an overall deadline, so a hung mint cannot hold its
 * join-amplification claim for the life of the session.
 *
 *   node tests/mint-timeout.test.mjs
 *
 * #10 made the mint accounting balanced by construction: a claim is taken from
 * the session that admitted it and released to that same session, so it can
 * never go negative and never leaks across a `leave()`. What that could not buy
 * is a claim that never sits above zero on the *live* session — the release is a
 * `finally`, and a `finally` on a promise that never settles never runs. So the
 * counter is only as bounded as `HostTransport.createInvite` is, which is why
 * the fix is in `Transport.js` and why the decisive test below is about a real
 * `Lobby`'s claim rather than about a timer existing.
 *
 * The hang is modelled at `setLocalDescription`: a browser WebRTC call that
 * neither resolves nor rejects. That is upstream of `waitForIce`, so its 4 s cap
 * cannot rescue it — exactly the pathological shape the issue describes.
 */
import { HostTransport } from '../src/net/Transport.js';
import { Lobby } from '../src/net/Lobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// An abandoned mint throws inside a promise chain whose caller has already
// settled, which is exactly the shape that leaks an unhandled rejection if the
// wiring is wrong. Collected rather than fatal so the assertion can name it.
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

/* A peer connection whose `setLocalDescription` never comes back. */
function hungPc() {
  const pc = {
    connectionState: 'new',
    iceGatheringState: 'gathering',
    localDescription: null,
    closed: false,
    onicecandidate: null,
    onconnectionstatechange: null,
    createDataChannel: (label) => ({
      label, readyState: 'connecting', bufferedAmount: 0, binaryType: '',
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send() {}, close() {},
    }),
    async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; },
    setLocalDescription() { return new Promise(() => {}); },   // the hang
    async setRemoteDescription() {},
    async addIceCandidate() {},
    addEventListener() {},
    removeEventListener() {},
    close() {
      pc.closed = true;
      if (pc.connectionState !== 'closed') { pc.connectionState = 'closed'; pc.onconnectionstatechange?.(); }
    },
  };
  return pc;
}

const pcs = [];
globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
  const pc = hungPc();
  pcs.push(pc);
  return pc;
};
const lastPc = () => pcs[pcs.length - 1];

// Short enough to test, and set through the same seam shape `_connectTimeoutMs`
// uses. The production value is asserted separately below, because a seam that
// hides a wrong default is a test that proves nothing about what ships.
const CAP = 80;

/* ==========================================================================
 * 1 — the decisive one: the claim comes back
 * ======================================================================= */

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = FakeWS;

const makeCtx = () => {
  const handlers = new Map();
  return {
    netRole: 'single',
    authority: true,
    events: {
      on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
  };
};
const makeEngine = (ctx) => ({
  systems: [],
  add(s) { this.systems.push(s); if (s.init) s.init(ctx); return s; },
  remove(s) { const i = this.systems.indexOf(s); if (i >= 0) this.systems.splice(i, 1); return s; },
});

// Reads both shapes for the same reason tests/lobby-lifecycle.test.mjs does:
// the count has moved once already, and an assertion that throws on a missing
// property is not the same assertion as one that fails.
const minting = (l) => (l._session ? l._session.minting : l._minting);

console.log('#73 — a mint that never settles releases its claim at the cap');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(ctx), ctx);
  const open = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD', v: 2 });
  await open;

  // No stand-in for the transport this time: the real `HostTransport` is the
  // subject, reached through the real `NetHost.createInvite`. Only the deadline
  // is shortened.
  lobby.net.transport._mintTimeoutMs = () => CAP;

  const inFlight = ws.recv({ type: 'joinRequest', clientId: 3 }).catch(() => {});
  ok(minting(lobby) === 1, `the claim is taken before the await (got ${minting(lobby)})`);

  await wait(CAP * 4);
  await inFlight;

  ok(minting(lobby) === 0,
     `the hung mint's claim was RELEASED, so the ceiling is back where it started (got ${minting(lobby)})`);
  ok(lobby._admitJoiner() === true, 'and the session can still admit a legitimate joiner');
  ok(lastPc().closed === true, 'the half-built peer connection was given up rather than leaked');
  ok(lobby.net.transport.peers.size === 0,
     `nothing was left in the transport's peer map (got ${lobby.net.transport.peers.size})`);
}

console.log('#73 — a mint that answers AFTER its deadline is abandoned, not registered');
{
  // The race the never-settling case above cannot reach: the browser does come
  // back, just too late. By then the caller has been told the mint failed and
  // has released its claim, so the peer must not be registered — `peers` is
  // where an invite's connection lives and nothing would ever close it again.
  const late = hungPc();
  late.iceGatheringState = 'complete';                  // so waitForIce is not the wait
  late.setLocalDescription = (d) => new Promise((resolve) => setTimeout(() => {
    late.localDescription = d ?? { type: 'offer', sdp: 'v=0 offer' };
    resolve();
  }, CAP * 3));                                         // resolves well after the deadline
  globalThis.RTCPeerConnection = function () { return late; };

  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(ctx), ctx);
  const open = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD', v: 2 });
  await open;
  lobby.net.transport._mintTimeoutMs = () => CAP;

  const inFlight = ws.recv({ type: 'joinRequest', clientId: 5 }).catch(() => {});
  ok(minting(lobby) === 1, `the claim is taken (got ${minting(lobby)})`);

  await wait(CAP * 8);                                  // past both the deadline and the late answer
  await inFlight;

  ok(minting(lobby) === 0, `the claim was released at the deadline (got ${minting(lobby)})`);
  ok(lobby.net.transport.peers.size === 0,
     `the late answer did not register a peer nobody would ever close (got ${lobby.net.transport.peers.size})`);
  ok(late.closed === true, 'and its connection is closed rather than leaked');
  ok(lobby.pendingInvites.size === 0,
     `nor did a dead invite reach the pending map (got ${lobby.pendingInvites.size})`);
  ok(unhandled.length === 0,
     `no unhandled rejection escaped the abandoned mint (got ${unhandled.map((e) => e?.message).join('; ')})`);

  globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
    const pc = hungPc(); pcs.push(pc); return pc;
  };
}

/* ==========================================================================
 * 2 — the transport's own contract
 * ======================================================================= */

console.log('#73 — createInvite rejects at the cap with a named, distinguishable error');
{
  const t = new HostTransport();
  t._mintTimeoutMs = () => CAP;
  const t0 = Date.now();
  let err = null;
  await t.createInvite().catch((e) => { err = e; });
  const ms = Date.now() - t0;

  ok(err !== null, 'the mint rejected rather than hanging');
  ok(err?.name === 'InviteMintTimeout',
     `the failure is named apart from an ordinary rejection (got '${err?.name}')`);
  ok(ms >= CAP && ms < CAP * 10, `and it rejected at the cap, not later (took ${ms}ms)`);
  ok(t.peers.size === 0, `no peer was registered (got ${t.peers.size})`);
}

console.log('#73 — an ordinary mint is untouched by the deadline');
{
  // A pc that behaves: local description lands and gathering is already done,
  // so `waitForIce` returns immediately and the mint is far inside the cap.
  const good = hungPc();
  good.iceGatheringState = 'complete';
  good.setLocalDescription = async (d) => { good.localDescription = d ?? { type: 'offer', sdp: 'v=0 offer' }; };
  globalThis.RTCPeerConnection = function () { return good; };

  const t = new HostTransport();
  t._mintTimeoutMs = () => CAP;
  const invite = await t.createInvite();
  ok(typeof invite.blob === 'string', 'a healthy mint still returns its blob');
  ok(t.peers.size === 1, `and its peer is registered (got ${t.peers.size})`);
  ok(good.closed === false, 'and nothing was closed under it');

  globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
    const pc = hungPc(); pcs.push(pc); return pc;
  };
}

console.log('#73 — the shipped cap clears the inner waitForIce cap');
{
  // A deadline at or below `waitForIce`'s 4000 ms would make that cap dead: a
  // manual mint whose gathering legitimately used its whole allowance would be
  // cancelled just as the complete offer became available.
  const shipped = new HostTransport()._mintTimeoutMs();
  ok(shipped > 4000, `the mint cap (${shipped}ms) is above waitForIce's 4000ms`);
  ok(shipped <= 30000, `and is still a bound a player would wait out (${shipped}ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
