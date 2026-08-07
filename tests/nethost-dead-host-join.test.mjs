/**
 * The host that is dead on its death screen, and the peers that arrive at it.
 *
 *   node tests/nethost-dead-host-join.test.mjs
 *
 * Same harness idea as `nethost-hello-gate.test.mjs` — a fake ctx and a fake
 * peer, no transport — plus a frame loop in `Engine._frame`'s real order:
 * fixed steps only while `!ctx.paused` (`Engine.js:246`), then every system's
 * `update`, always. The whole subject of this file is *which* callback gets to
 * run under a pause, so modelling that order is the point.
 *
 * Three things are gated here:
 *
 *  1. **A peer that joins a dead, paused host gets a live world.** This was
 *     reported as a defect and is not one — `_holdSession` already releases the
 *     pause the moment `hasLivePeer()` turns true, and `_onPeer` spawns the
 *     pawn from a transport callback that no pause can gate. It is gated
 *     anyway, because it is the behaviour the report assumed was missing and
 *     the one a future change to `_holdSession` would most easily take away.
 *  2. **Both ends of HOLD_GRACE.** The just-died peer still receives the
 *     snapshot carrying its own death, and the world pauses once the grace
 *     expires rather than running unattended for ever.
 *  3. **The pawnless peer on a paused host is still refused.** This one *was*
 *     broken: the HELLO deadline sweep only ran from `fixedUpdate`.
 */
import { NetHost } from '../src/net/NetHost.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A pawn, as far as `hasLivePeer` and `writeEntity` are concerned. */
function makePawn() {
  return {
    isPlayer: true, alive: true, health: 100, maxHealth: 100, shield: 0,
    position: { x: 0, y: 0, z: 0 }, yaw: 0,
    applyCommand() {}, lastCommand: null,
  };
}

function makeCtx({ pawns = true } = {}) {
  const ctx = {
    authority: true, netRole: 'host', time: 0, seed: 1, paused: false,
    hud: { menus: { screen: null } },
    input: { enabled: true },
    events: { on() {}, emit() {} },
    combat: { entities: [] },
    progression: { stageIndex: 0 },
    artifacts: { netPack: () => ({ mask: 0, difficulty: 1 }) },
    spawnRemotePlayer() {
      if (!pawns) return null;
      const p = makePawn();
      ctx.combat.entities.push(p);
      return p;
    },
    despawnRemotePlayer(p) {
      const i = ctx.combat.entities.indexOf(p);
      if (i >= 0) ctx.combat.entities.splice(i, 1);
    },
  };
  return ctx;
}

/**
 * A host on a clock this file owns. `_now()` is the seam every age gate in
 * NetHost reads — including `_holdSession`'s HOLD_GRACE, which is the only
 * reason the grace can be asserted here at all.
 */
function makeHost(ctx) {
  const host = new NetHost({ maxPlayers: 4 });
  host._t = 0;
  host._now = () => host._t;
  host.init(ctx);
  return host;
}

/** A peer whose channels are open, counting what it was sent. */
function makePeer(id = 1) {
  const p = {
    id, states: 0, events_: 0, closed: false,
    events: { readyState: 'open', bufferedAmount: 0 },
    sendState() { p.states++; },
    sendEvent() { p.events_++; },
    pumpSim() {},
    // `Peer.close` fires `onClose`, which is what carries a refusal through to
    // `_onPeerLeave`. Without it the fake would report a peer that was closed
    // and never left, which is not a state the real transport can produce.
    close() { if (p.closed) return; p.closed = true; p.onClose?.(); },
  };
  return p;
}

/** `Engine._frame`: fixed steps only when unpaused, then update, always. */
function frame(host, ctx, dt = 1 / 60) {
  host._t += dt;
  if (!ctx.paused) {
    ctx.time += dt;
    host.fixedUpdate(ctx, dt);
  }
  host.update(ctx, dt);
}

/** The host died. `Menus.open` (Menus.js:993) is the only writer of this pair. */
function hostDies(ctx) {
  ctx.hud.menus.screen = 'death';
  ctx.paused = true;
}

console.log('the report — a peer joins while the host is dead on its death screen');
{
  const ctx = makeCtx();
  const host = makeHost(ctx);
  hostDies(ctx);
  for (let i = 0; i < 60; i++) frame(host, ctx);   // a second of frozen world first
  const tickAtJoin = host.tick;
  ok(ctx.paused === true && tickAtJoin === 0, 'the lone dead host is frozen before the join');

  // Channels open. `_onPeer` is a transport callback (`Transport.js:332`), so
  // it runs regardless of `ctx.paused` — the pawn is created here, on channel
  // open, not on HELLO.
  const peer = makePeer(1);
  host._onPeer(peer);
  ok(host.clients.get(1)?.pawn?.alive === true, 'the pawn exists and is alive host-side');
  ok(peer.events_ > 0, 'WELCOME went out under the pause');

  for (let i = 0; i < 12; i++) frame(host, ctx);
  ok(ctx.paused === false, `the world un-paused for the joining peer (paused=${ctx.paused})`);
  ok(host.tick > tickAtJoin, `the world stepped after the join (tick ${tickAtJoin} -> ${host.tick})`);
  ok(peer.states > 0, `the joiner received snapshots (got ${peer.states})`);
}

console.log('\nthe other end — a host alone on a menu still pauses single-player-equivalently');
{
  const ctx = makeCtx();
  const host = makeHost(ctx);
  hostDies(ctx);
  for (let i = 0; i < 600; i++) frame(host, ctx);   // 10 s
  ok(ctx.paused === true, `a host alone on its death screen stays paused (paused=${ctx.paused})`);
  ok(host.tick === 0, `and steps nothing (tick=${host.tick})`);
}

console.log('\nthe other end — HOLD_GRACE still delivers the just-died peer its own death');
{
  const ctx = makeCtx();
  const host = makeHost(ctx);
  const peer = makePeer(1);
  host._onPeer(peer);
  for (let i = 0; i < 60; i++) frame(host, ctx);
  hostDies(ctx);
  for (let i = 0; i < 60; i++) frame(host, ctx);
  ok(ctx.paused === false, 'a host with a live peer does not pause its world');

  // The peer dies. The grace is what lets the snapshot carrying `ESTATE.DEAD`
  // reach it — `this.tick` only advances in `fixedUpdate`, and a client drops
  // any snapshot that is not newer than the last.
  host.clients.get(1).pawn.alive = false;
  const before = peer.states;
  for (let i = 0; i < 30; i++) frame(host, ctx);   // 0.5 s, inside the 1.5 s grace
  ok(ctx.paused === false, 'the world is still running inside the hold grace');
  ok(peer.states > before, `snapshots still reach the just-died peer (${before} -> ${peer.states})`);

  for (let i = 0; i < 90; i++) frame(host, ctx);   // now 2.0 s, past it
  ok(ctx.paused === true, `the world pauses once the grace expires (paused=${ctx.paused})`);
  const settled = host.tick;
  for (let i = 0; i < 120; i++) frame(host, ctx);
  ok(host.tick === settled, `and stays paused — no unattended world (tick=${host.tick})`);
}

console.log('\nthe other end — the death screen does not un-pause for the dead host itself');
{
  const ctx = makeCtx();
  const host = makeHost(ctx);
  hostDies(ctx);
  const peer = makePeer(1);
  host._onPeer(peer);
  for (let i = 0; i < 12; i++) frame(host, ctx);
  ok(ctx.paused === false, 'the world runs for the joiner');
  ok(ctx.input.enabled === false, 'the dead host on a screen has its own input muted');
}

console.log('\nthe fix — a pawnless peer on a paused host is still refused');
{
  const ctx = makeCtx({ pawns: false });
  const host = makeHost(ctx);
  hostDies(ctx);
  const peer = makePeer(1);
  host._onPeer(peer);
  ok(host.clients.get(1)?.pawn === null, 'the peer joined without a pawn');

  // HELLO_MAX_AGE_SEC is 2.5. Ten seconds is four deadlines.
  for (let i = 0; i < 600; i++) frame(host, ctx);
  ok(ctx.paused === true, 'nothing un-paused for it — `hasLivePeer()` is false');
  ok(host.tick === 0, 'so `fixedUpdate` never ran and could not have swept');
  ok(!host.clients.has(1), 'the peer was refused anyway, from `update`');
  ok(peer.closed === true, 'and closed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
