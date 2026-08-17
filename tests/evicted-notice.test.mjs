/**
 * An evicted joiner is told, and only an unconnected one listens — issue #8.
 *
 *   node tests/evicted-notice.test.mjs
 *
 * The host bounds its pending invites and evicts oldest-first under a burst of
 * joins. Before this file existed, the joiner that lost its invite was told
 * nothing: it sat out the full `RELAY_OFFER_TIMEOUT_MS` and was then handed the
 * deadline's guess — "the host never sent an invite" — which is the one
 * explanation that is certainly wrong, because the host sent one and then took
 * it back.
 *
 * Three claims, and the second is the one that decides whether the first is
 * allowed to exist:
 *
 *   1. an evicted joiner is told, and fails in milliseconds;
 *   2. a joiner that has already connected IGNORES the message. The room code
 *      is a bearer token every invited friend holds, so a message that can end
 *      a join must never be able to end a *session* — and the same holds in the
 *      window where the join is neither waiting nor finished, with `joinManual`
 *      mid-await, which is where `joined` alone cannot see;
 *   3. a halted host sends no such message, like every other send in `Lobby`
 *      (issue #75), and neither does one at a relay too old to carry it.
 *
 * Everything is asserted on the wire or on the joiner's own promise — which
 * frames reached the socket, whether the join settled and with what. A flag
 * being set would pass against code that sets it and talks anyway.
 */
import { Engine } from '../src/core/Engine.js';
import { Lobby } from '../src/net/Lobby.js';
import { validate } from '../tools/signal-server.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const turn = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------
 * The fakes. Same shapes as tests/trickle-ice.test.mjs and
 * tests/halt-hosting.test.mjs: a socket whose messages the test delivers by
 * hand, and a peer connection that never finishes gathering.
 * ---------------------------------------------------------------------- */
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.attempts = []; FakeWS.last = this; }
  // Two logs, and the difference between them is load-bearing.
  //
  // `sent` is what the relay receives: a closed socket carries nothing, which is
  // the browser's behaviour and the whole cost of tearing one down under a live
  // connection — `send` on a CLOSED WebSocket does not queue, so a candidate
  // gathered afterwards is simply lost. A fake that recorded it anyway would let
  // "the session survived" pass while its trickle had silently stopped.
  //
  // `attempts` is what the page TRIED to say, closed or not, and it is the only
  // way to ask the #75 question honestly. The rule there is that a halted page
  // attempts no send; `_quiet` also closes the socket, so a halt test that read
  // `sent` alone would pass against a host with no halt gate at all — the guard
  // would be green because the layer below it swallowed the message, which is
  // exactly the blindness the rule exists to forbid. Verified: with `_halted()`
  // taken out of `_tellEvicted`, `sent` notices nothing and `attempts` fails.
  send(s) { this.attempts.push(JSON.parse(s)); if (this.closed) return; this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
  triedOfType(t) { return this.attempts.filter((m) => m.type === t); }
}
globalThis.WebSocket = FakeWS;

function fakeChannel(label) {
  return {
    label, readyState: 'connecting', bufferedAmount: 0, binaryType: '',
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send() {}, close() {},
  };
}

/** ms of delay inside `setRemoteDescription`, for the interleaving block only. */
let slowSetRemote = 0;

const pcs = [];
globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
  const listeners = new Map();
  const pc = {
    connectionState: 'new', iceGatheringState: 'gathering',
    localDescription: null, remoteDescription: null,
    onicecandidate: null,
    createDataChannel: (l) => fakeChannel(l),
    async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; },
    async setLocalDescription(d) { pc.localDescription = d ?? { type: 'answer', sdp: 'v=0 answer' }; },
    // Widened on demand. `joinManual`'s await chain always yields the event loop
    // — that is what opens the interleaving window at all — but a microtask-only
    // gap is a fragile thing to time a test against, so the race block gives
    // this one step a real duration and drives the ordering by hand.
    async setRemoteDescription(d) { if (slowSetRemote) await turn(slowSetRemote); pc.remoteDescription = d; },
    async addIceCandidate() {},
    addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    emitCandidate(candidate) { pc.onicecandidate?.({ candidate }); },
    close() { pc.connectionState = 'closed'; pc.onconnectionstatechange?.(); },
  };
  pcs.push(pc);
  return pc;
};
const lastPc = () => pcs[pcs.length - 1];

const offerBlob = (id) =>
  btoa(JSON.stringify({ v: 1, role: 'offer', id, sdp: { type: 'offer', sdp: 'v=0' } }));

function mkLobby() {
  const handlers = new Map();
  const ctx = {
    netRole: 'single', authority: true,
    events: {
      on: (n, f) => { (handlers.get(n) ?? handlers.set(n, []).get(n)).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
  };
  return new Lobby({ add: (s) => s, remove: () => {} }, ctx);
}

/** The invite shape `_dropInvite` and the offer branch actually touch. */
const anInvite = (id) => ({ id, blob: `blob-${id}`, onIceCandidate() {}, addIceCandidate() {} });

/**
 * A relay-hosting lobby parked at roomOpen, with minting under test control so
 * a burst of joinRequests is a burst rather than a real ICE gather.
 */
async function hostingLobby(lobby = mkLobby(), v = 3) {
  const open = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD2345', v });
  await open;
  let n = 0;
  lobby.net.createInvite = async () => anInvite(`inv-${++n}`);
  lobby.net.transport.cancelInvite = () => true;
  return { lobby, ws };
}

/* ==========================================================================
 * 1 — the host tells the joiner it evicted
 * ======================================================================= */

console.log('#8 — evicting a joiner puts its name on the wire');
{
  const { lobby, ws } = await hostingLobby();

  // MAX_PENDING_INVITES is 8, so nine joins in a row is one eviction and the
  // victim is the first: oldest-first is what `_admitJoiner` promises.
  for (let i = 1; i <= 9; i++) await ws.recv({ type: 'joinRequest', clientId: i });

  const told = ws.ofType('evicted');
  ok(told.length === 1, `exactly one joiner was told (got ${told.length}: ${JSON.stringify(told)})`);
  ok(told[0]?.clientId === 1,
     `and it is the joiner whose invite was actually given up (got ${JSON.stringify(told[0]?.clientId)})`);
  ok(ws.ofType('offer').length === 9,
     `every join still got its offer — this adds a message, it does not remove one (got ${ws.ofType('offer').length})`);
  ok(lobby.pendingInvites.size === 8,
     `and the ceiling still holds (got ${lobby.pendingInvites.size})`);
}

console.log('#8 — and nothing at all at a relay too old to carry it');
{
  // Not politeness. An unknown type is `bad-type` at the relay, and `reject`
  // charges that to the SENDER: twenty of them close the host's own socket with
  // 1008 and the room goes with it. Evictions arrive in exactly the sustained
  // flood the ceiling exists to survive, so twenty is reachable. The joiner
  // keeps its 20 s wait against an old relay, which is what shipped before this
  // message existed and is worth far less than the host's room.
  const { lobby, ws } = await hostingLobby(mkLobby(), 2);
  for (let i = 1; i <= 9; i++) await ws.recv({ type: 'joinRequest', clientId: i });
  ok(lobby.pendingInvites.size === 8, 'the eviction still happened (the precondition)');
  ok(ws.triedOfType('evicted').length === 0,
     `and a v2 relay was never even asked to forward it (got ${ws.triedOfType('evicted').length})`);
}

console.log('#8 — a host with nothing to evict says nothing (the control)');
{
  const { ws } = await hostingLobby();
  for (let i = 1; i <= 8; i++) await ws.recv({ type: 'joinRequest', clientId: i });
  ok(ws.ofType('evicted').length === 0,
     `eight joins inside the ceiling produce no eviction notice (got ${ws.ofType('evicted').length})`);
}

/* ==========================================================================
 * 2 — the joiner acts on it, fast
 * ======================================================================= */

console.log('#8 — an evicted joiner fails in milliseconds instead of waiting out the deadline');
{
  const lobby = mkLobby();
  // The deadline is left at its real twenty seconds ON PURPOSE. The claim is
  // that this join settles without it, so borrowing the seam that shortens it
  // would let the old behaviour pass.
  const p = lobby.joinViaRelay('ABCD2345', 'ws://relay.test');
  const ws = FakeWS.last;
  ws.open();

  const t0 = Date.now();
  await ws.recv({ type: 'evicted' });
  const settled = await Promise.race([
    p.then(() => 'RESOLVED', (e) => e.message),
    turn(500).then(() => 'STILL WAITING'),
  ]);
  const ms = Date.now() - t0;

  ok(settled !== 'STILL WAITING', `the join settles at once (got '${settled}')`);
  ok(ms < 500, `and in ${ms}ms, not the twenty seconds the deadline would have cost`);
  ok(/too many joins/.test(settled) && /try the code again/i.test(settled),
     `with a truthful reason and something to do about it (got '${settled}')`);
  ok(ws.closed === true, 'and the socket is given back rather than left answering the relay');
  ok(lobby.net === null && lobby.mode === 'single',
     `the lobby is clean enough to retry immediately (net=${lobby.net}, mode=${lobby.mode})`);
}

/* ==========================================================================
 * 3 — THE SECURITY CASE: a connected joiner ignores it
 *
 * The relay only forwards `evicted` from a host, but the room code is a bearer
 * token: any invited friend can host a room of their own, and a host that has
 * legitimately evicted someone is also a host that can send this at a session
 * which is already up. Once the joiner is connected the relay is no longer part
 * of that session, so the only correct answer is to drop the frame.
 * ======================================================================= */

console.log('#8 — a connected joiner IGNORES an evicted message');
{
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e?.message ?? e));
  process.on('unhandledRejection', onUnhandled);
  try {
    const lobby = mkLobby();
    const p = lobby.joinViaRelay('ABCD2345', 'ws://relay.test');
    const ws = FakeWS.last;
    ws.open();
    await ws.recv({ type: 'offer', blob: offerBlob(77), trickle: true });
    await p;
    ok(lobby.net !== null && lobby.mode === 'client',
       `the joiner is connected before the attack (net=${!!lobby.net}, mode=${lobby.mode})`);
    const iceBefore = ws.ofType('ice').length;

    // The hostile frame.
    let threw = null;
    try { await ws.recv({ type: 'evicted' }); } catch (e) { threw = e; }
    await turn(20);

    ok(threw === null, `it does not throw out of the handler (got ${threw?.message})`);
    ok(unhandled.length === 0, `and leaves nothing unhandled (got ${JSON.stringify(unhandled)})`);
    ok(ws.closed !== true,
       'the established session keeps the socket its trickled candidates ride');
    ok(lobby.net !== null && lobby.mode === 'client',
       `and is still a session at all (net=${!!lobby.net}, mode=${lobby.mode})`);
    lastPc().emitCandidate({ candidate: 'candidate:after-the-attack' });
    ok(ws.ofType('ice').length === iceBefore + 1,
       `and candidates still reach the host afterwards (got ${ws.ofType('ice').length} after ${iceBefore})`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

console.log('#8 — an eviction landing DURING joinManual leaves no half-connected lobby');
{
  // The window `joined` cannot see. `joined` flips only after `joinManual`
  // resolves, and that await chain yields the event loop several times over
  // (`setRemoteDescription`, `createAnswer`, `setLocalDescription`, `waitForIce`).
  // `ws.onmessage` is async and nothing serialises it, so a second message
  // delivered in that gap runs to completion while the first is parked — with
  // `joined` still false.
  //
  // A benign host cannot produce this pair: `_admitJoiner` only ever evicts
  // OTHER, older invites, never the one it is answering. A hostile one can, and
  // a hostile host is the threat model this message's own guard names. So the
  // messages are interleaved directly, without awaiting the offer — awaiting it
  // is what makes the post-connect case a different case.
  slowSetRemote = 20;
  try {
    const lobby = mkLobby();
    const p = lobby.joinViaRelay('ABCD2345', 'ws://relay.test');
    // Attached NOW, not after the interleaving: the rejection lands mid-block
    // and an unhandled one takes the whole process down before any assertion
    // runs, which reads as a crash rather than as the failure it is.
    const outcome = p.then(() => 'RESOLVED', (e) => e.message);
    const ws = FakeWS.last;
    ws.open();

    const offering = ws.recv({ type: 'offer', blob: offerBlob(99), trickle: true });
    await turn(0);                       // the offer handler is now parked inside joinManual
    await ws.recv({ type: 'evicted' });  // and this one runs to completion in that gap
    await offering;
    await turn(30);

    const settled = await outcome;
    ok(/too many joins/.test(settled), `the caller is told the join failed (got '${settled}')`);
    // The invariant: the Lobby's state and the promise's answer must agree.
    // Publishing `net`/`mode` on top of a rejected attempt leaves the co-op
    // screen saying it failed while the Lobby believes it is connected over the
    // socket the rejection already closed — and the retry the player is invited
    // to make then dies on 'Already networked' until a reload.
    ok(lobby.net === null,
       `and the lobby holds no connection built after that answer (net=${!!lobby.net})`);
    ok(lobby.mode === 'single',
       `nor is it left in client mode over a closed socket (mode=${lobby.mode})`);
    ok(ws.closed === true, 'the socket is closed, as the rejection says it is');
    ok(ws.ofType('answer').length === 0,
       `and no answer was sent for an attempt that had already been given up (got ${ws.ofType('answer').length})`);

    // The retry that the old behaviour locked out. This is the player-visible
    // cost, so it is asserted rather than argued.
    let retryThrew = null;
    await lobby.joinManual(offerBlob(100), { trickle: true }).catch((e) => { retryThrew = e; });
    ok(!/Already networked/.test(retryThrew?.message ?? ""),
       `a retry is not locked out by the abandoned attempt (got '${retryThrew?.message}')`);
  } finally {
    slowSetRemote = 0;
  }
}

/* ==========================================================================
 * 4 — a halted host sends nothing, this message included (#75)
 * ======================================================================= */

class Doomed {
  static critical = true;
  update() { throw new Error('the world came apart'); }
}

console.log('#8 x #75 — a halted host attempts no eviction notice');
{
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  const lobby = new Lobby(engine, engine.ctx);
  const { ws } = await hostingLobby(lobby);

  // The control, on the live host: eight joins fill the ceiling and the ninth
  // evicts and tells. Without this the block below could pass because nothing
  // was ever evicted at all.
  for (let i = 1; i <= 9; i++) await ws.recv({ type: 'joinRequest', clientId: i });
  ok(ws.ofType('evicted').length === 1,
     `a live host on a real Engine does send the notice (got ${ws.ofType('evicted').length})`);

  engine.add(new Doomed());
  engine._frame();
  ok(engine.fatal, 'the engine halted on a critical throw — the precondition, not an assumption');

  // `_quiet` empties the invite maps on its way out, so the halted host is put
  // back into the state a flood finds it in. Written directly because a halted
  // page's `onmessage` returns long before this code, and going through the
  // socket would test only that earlier gate.
  for (let i = 1; i <= 8; i++) {
    lobby.pendingInvites.set(`halted-${i}`, anInvite(`halted-${i}`));
    lobby._invitesByClient.set(100 + i, lobby.pendingInvites.get(`halted-${i}`));
  }
  const atHalt = ws.triedOfType('evicted').length;
  // The socket handed back to the halted lobby, deliberately — and this line is
  // the difference between a guard and a decoration.
  //
  // `_quiet` sets `this.ws = null`, so on the shipped path this send cannot
  // reach a socket whether or not anything checks `_halted()`: with the check
  // deleted, the test still passes. That is precisely the shape #75 warns
  // against, and it is not hypothetical here — the offer branch's
  // `onIceCandidate` callback holds its `ws` in a CLOSURE, which `this.ws = null`
  // does not reach, which is why that send carries its own `_halted()` check
  // too. A live reference surviving a halt is the case the check exists for, so
  // the test supplies one. Verified: with `_halted()` removed from
  // `_tellEvicted`, the assertion below fails.
  lobby.ws = ws;
  lobby._admitJoiner();
  await turn(0);

  ok(lobby.pendingInvites.size < 8,
     `the eviction itself still happens on a halted host (got ${lobby.pendingInvites.size} of 8)`);
  // On `attempts`, not `sent`: see FakeWS. The halted page must not reach for
  // the socket at all, rather than be saved by the socket being shut.
  ok(ws.triedOfType('evicted').length === atHalt,
     `and the halted host does not even attempt to say so (${ws.triedOfType('evicted').length - atHalt} attempts after the halt)`);
}

/* ==========================================================================
 * 5 — the relay's own validation
 *
 * The forwarding rule ("host role only") is exercised end to end against a live
 * relay in tests/signal-hardening.test.mjs, alongside the same rule for `offer`.
 * ======================================================================= */

console.log('#8 — the relay validates the message it is now asked to carry');
{
  ok(validate({ type: 'evicted', clientId: 7 }).ok === true, 'a well-formed eviction is valid');
  ok(validate({ type: 'evicted', clientId: 7 }).msg.clientId === 7, 'and keeps the joiner it names');
  ok(validate({ type: 'evicted' }).reason === 'bad-client-id', 'one naming nobody is refused');
  ok(validate({ type: 'evicted', clientId: 'all' }).reason === 'bad-client-id', 'and so is one naming everybody');
  // Nothing else survives the re-spelling, so there is no field to stuff.
  const stuffed = validate({ type: 'evicted', clientId: 7, blob: 'x'.repeat(5000) });
  ok(stuffed.ok === true && stuffed.msg.blob === undefined,
     `a stuffed eviction carries none of it onward (got ${JSON.stringify(Object.keys(stuffed.msg))})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
