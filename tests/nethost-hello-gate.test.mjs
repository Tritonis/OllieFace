/**
 * C-7 and C-1 — the HELLO age unit, and the peer that never sends one.
 *
 *   node tests/nethost-hello-gate.test.mjs
 *
 * Drives NetHost's client bookkeeping directly rather than standing up a
 * transport: the defect is entirely in when the age gate fires.
 */
import { NetHost } from '../src/net/NetHost.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeHost() {
  const host = new NetHost({ maxPlayers: 4 });
  const emitted = [];
  host.ctx = {
    authority: true, netRole: 'host', time: 0, seed: 1,
    events: { on() {}, emit: (n, p) => emitted.push([n, p]) },
    combat: { entities: [] },
  };
  host.emitted = emitted;
  return host;
}

/** A client record shaped exactly as `_onPeer` builds one. */
function addClient(host, { helloSeen = false, joinedAt = 0, joinTick = 0 } = {}) {
  const refusals = [];
  const peer = { id: 1, sendEvent() {}, sendState() {}, close() {}, refusals };
  host.clients.set(peer.id, {
    peer, pawn: null, inputs: [], lastTick: 0, name: 'Player 2',
    joinTick, joinedAt, helloSeen, survivorId: null,
  });
  host._refuse = (p, reason, detail) => { refusals.push({ reason, detail }); host.clients.delete(p.id); };
  return { peer, refusals };
}

console.log('C-7 — the age gate is counted in seconds, not ticks');
{
  const host = makeHost();
  const { refusals } = addClient(host, { joinedAt: 0 });
  // 3 real seconds have passed but only 20 ticks — a throttled host. The gate
  // must fire on the clock, not the frame counter.
  host._now = () => 3.0;
  host.tick = 20;
  host._checkHelloDeadlines();
  ok(refusals.length === 1, `refused after 3 s at 20 ticks (got ${refusals.length})`);
}

console.log('C-7 — the other end: many ticks, little time, no refusal');
{
  const host = makeHost();
  const { refusals } = addClient(host, { joinedAt: 0 });
  // 300 ticks in 0.5 s — a fast host. Under the old tick gate this refused.
  host._now = () => 0.5;
  host.tick = 300;
  host._checkHelloDeadlines();
  ok(refusals.length === 0, `not refused at 0.5 s despite 300 ticks (got ${refusals.length})`);
}

console.log('C-1 — a peer that never sends a HELLO is refused');
{
  const host = makeHost();
  const { refusals } = addClient(host, { helloSeen: false, joinedAt: 0 });
  host._now = () => 99;
  host._checkHelloDeadlines();
  ok(refusals.length === 1, 'silent peer refused');
  ok(/identity/i.test(refusals[0]?.detail ?? ''), `refusal names the identity message (got '${refusals[0]?.detail}')`);
}

console.log('C-1 — the other end: a peer that did send one is left alone');
{
  const host = makeHost();
  const { refusals } = addClient(host, { helloSeen: true, joinedAt: 0 });
  host._now = () => 99;
  host._checkHelloDeadlines();
  ok(refusals.length === 0, 'peer with a HELLO is not refused');
}

console.log('C-1 — the sweep is actually reachable from the tick loop');
{
  const host = makeHost();
  const { refusals } = addClient(host, { helloSeen: false, joinedAt: 0 });
  host._now = () => 99;
  // Engine._frame calls `s.fixedUpdate(ctx, FIXED)` with FIXED = 1/60
  // (src/core/Engine.js:16, :236) — drive it with that real shape rather
  // than calling `_checkHelloDeadlines()` directly, so this assertion fails
  // if the wiring is ever removed from `fixedUpdate`, not just if the swept
  // logic itself regresses.
  host.fixedUpdate(host.ctx, 1 / 60);
  ok(refusals.length === 1, `silent peer refused via fixedUpdate, not just the direct call (got ${refusals.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
