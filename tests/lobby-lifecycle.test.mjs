/**
 * C-2 and C-10 — the two Lobby lifecycle defects.
 *
 *   node tests/lobby-lifecycle.test.mjs
 *
 * Self-contained: fakes the engine, the event bus and the transport, and
 * imports the real `src/net/Lobby.js`.
 */
import { Lobby } from '../src/net/Lobby.js';
// The real Engine imports `three` but builds nothing that needs a GL context —
// Scene/PerspectiveCamera/Clock all construct headless — so `add`/`remove` can
// be exercised against the real contract rather than a stand-in.
import { Engine } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const handlers = new Map();
  return {
    netRole: 'single',
    authority: true,
    events: {
      on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
  };
}

// Mirrors the real Engine's registration contract (src/core/Engine.js): `add`
// keeps the system in `systems` and runs `init(ctx)`, `remove` takes it back
// out. Registration is what the leave-then-rehost leak is measured in, so the
// fake has to hold the list rather than just hand the system back.
const makeEngine = (ctx) => ({
  systems: [],
  add(s) { this.systems.push(s); if (s.init) s.init(ctx); return s; },
  remove(s) { const i = this.systems.indexOf(s); if (i >= 0) this.systems.splice(i, 1); return s; },
});

console.log('C-2 — leave() restores ctx.netRole');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(ctx), ctx);
  // Stand in for what NetClient.init does at src/net/NetClient.js:57.
  ctx.netRole = 'client';
  ctx.authority = false;
  lobby.mode = 'client';
  lobby.net = { close() {} };

  lobby.leave();

  ok(ctx.netRole === 'single', `netRole reset to 'single' (got '${ctx.netRole}')`);
  ok(ctx.authority === true, 'authority restored');
  ok(lobby.mode === 'single', 'mode restored');
}

console.log('C-2 — a Lobby that never joined is untouched (other end of the range)');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(ctx), ctx);
  lobby.leave();
  ok(ctx.netRole === 'single', 'netRole still single');
}

console.log('C-10 — acceptAnswer sets peerConnecting before the join can land');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(ctx), ctx);
  const seen = [];
  lobby.onStatus = (s) => seen.push(s);

  // The real `invite.accept` resolves the transport's `ready` promise, which
  // fires onPeer -> netPlayerJoined -> the host's "connected" status. Model
  // that as a status set that happens *during* the await.
  lobby.pendingInvites.set(7, {
    accept: async () => { lobby._set('peerJoined'); },
  });
  lobby._inviteIdFor = () => 7;

  await lobby.acceptAnswer('irrelevant-blob');

  const iConnecting = seen.indexOf('peerConnecting');
  const iJoined = seen.indexOf('peerJoined');
  ok(iConnecting >= 0 && iJoined >= 0, `both statuses seen (${JSON.stringify(seen)})`);
  ok(iConnecting < iJoined, `peerConnecting precedes peerJoined (${JSON.stringify(seen)})`);
  ok(lobby.status === 'peerJoined', `final status is the join, not the placeholder (got '${lobby.status}')`);
}

console.log('leave() deregisters the net system and clears ctx.net');
{
  const ctx = makeCtx();
  const engine = makeEngine(ctx);
  const lobby = new Lobby(engine, ctx);
  const net = lobby.startHost();

  ok(engine.systems.includes(net), 'precondition: hosting registers the NetHost');
  ok(ctx.net === net, 'precondition: NetHost.init published itself as ctx.net');

  lobby.leave();

  ok(!engine.systems.includes(net), `net system deregistered (systems: ${engine.systems.length})`);
  ok(!ctx.net, 'ctx.net cleared — it pointed at the closed instance');
}

console.log('host -> leave -> host again leaves exactly one NetHost registered');
{
  const ctx = makeCtx();
  const engine = makeEngine(ctx);
  const lobby = new Lobby(engine, ctx);
  lobby.startHost();
  lobby.leave();
  const second = lobby.startHost();

  const hosts = engine.systems.filter((s) => s.constructor.name === 'NetHost');
  ok(hosts.length === 1, `exactly one NetHost registered (got ${hosts.length})`);
  ok(hosts[0] === second, 'the registered host is the live one, not the closed one');
  ok(ctx.net === second, 'ctx.net points at the live host');
}

console.log('a join that fails after registering its client releases it');
{
  const ctx = makeCtx();
  const engine = makeEngine(ctx);
  const lobby = new Lobby(engine, ctx);

  // A malformed invite blob: `NetClient.join` rejects, after `engine.add` has
  // already registered the client and its `init` has taken authority away.
  let threw = null;
  try { await lobby.joinManual('not-an-invite-blob'); } catch (e) { threw = e; }

  ok(threw !== null, 'the failed join still rejects');
  ok(engine.systems.length === 0, `failed client deregistered (systems: ${engine.systems.length})`);
  ok(!ctx.net, 'ctx.net cleared');
  ok(lobby.net === null, 'a retry is not blocked by a dead session');
  ok(ctx.netRole === 'single' && ctx.authority === true, `role restored (got '${ctx.netRole}')`);
}

/* ==========================================================================
 * leave() racing an in-flight createInvite (#10)
 *
 * `createInvite()` is a long await — an offer, and on a non-trickle relay a
 * full ICE gather — and Leave is a button the player can press in the middle of
 * one. Everything below drives that window directly: the mint is held open by a
 * promise the test resolves by hand, so the interleaving is exact rather than
 * hoped for.
 * ======================================================================= */

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  /** Deliver a server message; returns the handler's promise so tests can await it. */
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
}
globalThis.WebSocket = FakeWS;

/**
 * The live session's count of invites being minted right now.
 *
 * Read through a helper because the count moved when this bug was fixed: it was
 * a field on the Lobby, which is precisely what let `leave()` reset it out from
 * under a mint that was still going to decrement it. Reading both shapes is
 * what makes these assertions *fail* against the unfixed code rather than throw
 * on a missing property, and a guard that has never been seen red is not
 * evidence of anything.
 */
const minting = (l) => (l._session ? l._session.minting : l._minting);

/** A relay-hosting lobby, parked at roomOpen with its minting under test control. */
async function hostingLobby() {
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(ctx), ctx);
  const open = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD', v: 2 });
  await open;

  // Stand in for `HostTransport.createInvite`, which is the only part of the
  // real transport this race is about: a promise the test decides when to
  // settle, over a `peers` map the test can inspect for what was left in it.
  const cancelled = [];
  const pending = [];
  lobby.net.createInvite = () => new Promise((resolve) => pending.push(resolve));
  lobby.net.transport.cancelInvite = (id) => { cancelled.push(id); return true; };
  return { ctx, lobby, ws, cancelled, pending };
}

const anInvite = (id) => ({ id, blob: `blob-${id}`, onIceCandidate() {}, addIceCandidate() {} });

console.log('#10 — a mint that resolves after leave() is discarded, and the count comes back to zero');
{
  const { lobby, ws, cancelled, pending } = await hostingLobby();

  const inFlight = ws.recv({ type: 'joinRequest', clientId: 3 });
  ok(minting(lobby) === 1, `the claim is taken before the await (got ${minting(lobby)})`);

  lobby.leave();
  pending[0](anInvite('late'));
  await inFlight;

  ok(minting(lobby) === 0, `the ceiling is back where it started, not below it (got ${minting(lobby)})`);
  ok(lobby.pendingInvites.size === 0,
     `the late invite was not written into the cleared map (got ${lobby.pendingInvites.size})`);
  ok(lobby._invitesByClient.size === 0,
     `nor into the client index (got ${lobby._invitesByClient.size})`);
  ok(ws.ofType('offer').length === 0,
     `nor sent down a socket this lobby has closed (got ${ws.ofType('offer').length})`);
  ok(cancelled.includes('late'),
     `and its peer connection was given up rather than left in the closed transport (got ${JSON.stringify(cancelled)})`);
}

console.log('#10 — the ceiling still holds after a leave lands mid-flood');
{
  const { lobby, ws, pending } = await hostingLobby();

  // Three at once, which is what an unserialised `ws.onmessage` delivers, and a
  // Leave landing in the middle of all three.
  const flight = [0, 1, 2].map((i) => ws.recv({ type: 'joinRequest', clientId: i }));
  ok(minting(lobby) === 3, `three concurrent claims (got ${minting(lobby)})`);

  lobby.leave();
  ok(minting(lobby) === 0, `leave() starts the next session at zero (got ${minting(lobby)})`);

  pending.forEach((resolve, i) => resolve(anInvite(`stale-${i}`)));
  await Promise.all(flight);

  ok(minting(lobby) === 0,
     `three stale releases did not drive it to -3 (got ${minting(lobby)})`);
  ok(lobby._admitJoiner() === true,
     'and the next session can still admit a joiner');
}

console.log('#10 — the manual createInvite path discards the same way');
{
  const { lobby, cancelled, pending } = await hostingLobby();

  const p = lobby.createInvite();
  lobby.leave();
  pending[0](anInvite('manual-late'));

  let threw = null;
  await p.catch((e) => { threw = e; });

  ok(threw !== null, 'the caller is told there is no invite rather than handed a dead one');
  ok(lobby.pendingInvites.size === 0,
     `nothing written into the cleared map (got ${lobby.pendingInvites.size})`);
  ok(cancelled.includes('manual-late'), `its connection was given up (got ${JSON.stringify(cancelled)})`);
}

console.log('#10 — an ordinary mint, with no leave, still counts and still lands');
{
  const { lobby, ws, cancelled, pending } = await hostingLobby();

  const inFlight = ws.recv({ type: 'joinRequest', clientId: 8 });
  pending[0](anInvite('good'));
  await inFlight;

  ok(minting(lobby) === 0, `the claim was released (got ${minting(lobby)})`);
  ok(lobby.pendingInvites.get('good') !== undefined, 'the invite is pending');
  ok(lobby._invitesByClient.get(8)?.id === 'good', 'and indexed by the joiner it was minted for');
  ok(ws.ofType('offer').length === 1, `the offer went out (got ${ws.ofType('offer').length})`);
  ok(cancelled.length === 0, `and nothing was cancelled (got ${JSON.stringify(cancelled)})`);
}

console.log('#10 — a mint that throws releases its claim, before and after a leave');
{
  const { lobby, ws } = await hostingLobby();
  lobby.net.createInvite = async () => { throw new Error('Lobby is full'); };

  await ws.recv({ type: 'joinRequest', clientId: 1 }).catch(() => {});
  ok(minting(lobby) === 0, `a throw inside the session releases (got ${minting(lobby)})`);

  const net = lobby.net;
  let release;
  net.createInvite = () => new Promise((_, reject) => { release = reject; });
  const inFlight = ws.recv({ type: 'joinRequest', clientId: 2 });
  lobby.leave();
  release(new Error('transport closed'));
  await inFlight.catch(() => {});
  ok(minting(lobby) === 0, `and a throw after a leave leaves the new session at zero (got ${minting(lobby)})`);
}

console.log('Engine.remove — the deregistration half of add()');
{
  const engine = new Engine({ canvas: null, seed: 1 });
  let updated = 0;
  const sys = { update() { updated++; } };

  engine.add(sys);
  ok(engine.systems.includes(sys), 'added system is registered');

  engine.remove(sys);
  ok(!engine.systems.includes(sys), 'removed system is out of the update set');

  // A double leave() calls remove twice; the second must not throw or evict
  // anything else.
  const other = engine.add({ update() {} });
  let threw = null;
  try { engine.remove(sys); } catch (e) { threw = e; }
  ok(threw === null, `removing a system that is not present is a no-op (threw: ${threw && threw.message})`);
  ok(engine.systems.length === 1 && engine.systems[0] === other, 'the no-op removed nothing else');

  engine._frame();
  ok(updated === 0, `a removed system is not updated (ran ${updated} times)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
