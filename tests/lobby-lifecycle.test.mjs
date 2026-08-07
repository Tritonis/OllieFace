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
