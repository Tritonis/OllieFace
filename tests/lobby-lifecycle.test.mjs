/**
 * C-2 and C-10 — the two Lobby lifecycle defects.
 *
 *   node tests/lobby-lifecycle.test.mjs
 *
 * Self-contained: fakes the engine, the event bus and the transport, and
 * imports the real `src/net/Lobby.js`.
 */
import { Lobby } from '../src/net/Lobby.js';

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

// The engine only has to hand back whatever system it was given.
const makeEngine = () => ({ add: (s) => s });

console.log('C-2 — leave() restores ctx.netRole');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(), ctx);
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
  const lobby = new Lobby(makeEngine(), ctx);
  lobby.leave();
  ok(ctx.netRole === 'single', 'netRole still single');
}

console.log('C-10 — acceptAnswer sets peerConnecting before the join can land');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(), ctx);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
