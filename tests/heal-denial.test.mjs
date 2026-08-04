/**
 * Per-player healing denial, and spawn placement that respects every player.
 *
 *   node tests/heal-denial.test.mjs
 */
import { Director, MIN_SPAWN_DIST, MAX_SPAWN_DIST } from '../src/systems/Director.js';
import { Roster } from '../src/systems/Roster.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = (x, z) => ({ isPlayer: true, alive: true, health: 100, position: { x, y: 0, z } });

function fresh(...players) {
  const roster = new Roster();
  const ctx = { time: 0, player: players[0] ?? null };
  roster.init(ctx);
  players.forEach((p) => roster.add(p));
  const d = new Director();
  d.ctx = ctx;
  return { d, ctx, roster, players };
}

console.log('denial is scoped to the named victim');
{
  const a = P(0, 0), b = P(50, 0);
  const { d } = fresh(a, b);
  d.denyHealing(2, a);
  ok(d.healingDeniedFor(a) === true, 'the named victim is denied');
  ok(d.healingDeniedFor(b) === false, 'the other player is not');
}

console.log('a call with no victim is a no-op, not a global');
{
  const a = P(0, 0), b = P(50, 0);
  const { d } = fresh(a, b);
  d.denyHealing(2);
  ok(d.healingDeniedFor(a) === false && d.healingDeniedFor(b) === false,
     'nobody is denied — silently falling back to everyone is the bug being fixed');
}

console.log('overlapping elites top the same victim up');
{
  const a = P(0, 0);
  const { d, ctx } = fresh(a);
  d.denyHealing(2, a);
  ctx.time = 1;
  d.denyHealing(2, a);        // expires at 3, not 2
  ctx.time = 2.5;
  ok(d.healingDeniedFor(a) === true, 'still denied after the first window would have lapsed');
  ctx.time = 3.5;
  ok(d.healingDeniedFor(a) === false, 'lapses at the later expiry');
}

console.log('enforcement caps only the denied player');
{
  const a = P(0, 0), b = P(50, 0);
  const { d, ctx } = fresh(a, b);
  d.denyHealing(5, a);
  d.enforceHealDenial(ctx);
  a.health = 150; b.health = 150;
  d.enforceHealDenial(ctx);
  ok(a.health === 100, `denied player cannot heal (got ${a.health})`);
  ok(b.health === 150, `undenied player heals normally (got ${b.health})`);
}

console.log('damage lowers the ceiling for the denied player');
{
  const a = P(0, 0);
  const { d, ctx } = fresh(a);
  d.denyHealing(5, a);
  d.enforceHealDenial(ctx);
  a.health = 40;                   // took a hit
  d.enforceHealDenial(ctx);
  a.health = 90;                   // tried to heal
  d.enforceHealDenial(ctx);
  ok(a.health === 40, `ceiling followed the damage down (got ${a.health})`);
}

console.log('a revive inside a live denial window is not pinned to the old ceiling');
{
  const a = P(0, 0);
  const { d, ctx } = fresh(a);
  d.denyHealing(5, a);
  a.health = 12;
  d.enforceHealDenial(ctx);       // ceiling settles at 12
  a.alive = false;
  d.enforceHealDenial(ctx);       // dead: the ceiling has to be dropped, not held
  a.alive = true; a.health = 100; // revived, still inside the denial window
  d.enforceHealDenial(ctx);
  ok(a.health === 100, `revived health survives the still-live denial (got ${a.health})`);
  ok(d.healingDeniedFor(a) === true, 'and the denial itself is still running');
}

// --------------------------------------------------------------------------
// Spawn placement. These drive `Director.findSpawnPoint` itself rather than
// `Roster.distanceToNearest` underneath it: the point of the change is the
// acceptance test inside that loop, and a block that only asks the roster for
// a distance passes just as happily with the loop reverted to its one-player
// form. `tests/roster.test.mjs` already owns the distance query.
// --------------------------------------------------------------------------

/**
 * A context `findSpawnPoint` can run in headless.
 *
 * `camera` is null so the frustum test is skipped and `visible` is false,
 * which makes the first accepted candidate return immediately — the loop then
 * measures the acceptance test and nothing else. `rng` throws on every draw,
 * which is a standing assertion that this change adds no RNG draw: the only
 * `ctx.rng.next()` in the loop is on the on-screen far-spawn branch, which a
 * null camera can never reach.
 */
function spawnCtx(candidate, ...players) {
  const roster = new Roster();
  const ctx = {
    time: 0,
    player: players[0] ?? null,
    camera: null,
    stage: { randomWalkablePoint: () => ({ ...candidate }) },
    rng: new Proxy({}, { get: (_, k) => () => {
      throw new Error(`findSpawnPoint drew ctx.rng.${String(k)}() — the acceptance test must not consume the RNG`);
    } }),
  };
  roster.init(ctx);
  players.forEach((p) => roster.add(p));
  const d = new Director();
  d.ctx = ctx;
  return { d, ctx, roster };
}

console.log('spawn placement respects every player, not just the anchor');
{
  const at = MIN_SPAWN_DIST + 6;                 // 40 m: comfortably inside the window
  const candidate = { x: at, y: 0, z: 0 };

  const host = P(0, 0);
  const sp = spawnCtx(candidate, host);
  const solo = sp.d.findSpawnPoint(sp.ctx);
  ok(!!solo && Math.abs(solo.x - at) < 1e-9,
     `single-player: a point ${at} m out is accepted (got ${solo && solo.x})`);

  // Same anchor, same candidate, same RNG — but a guest is standing on it.
  const host2 = P(0, 0), guest = P(at + 5, 0);
  const co = spawnCtx(candidate, host2, guest);
  const near = co.d.findSpawnPoint(co.ctx);
  ok(near === null,
     `co-op: rejected because a guest is 5 m away (got ${near && near.x})`);

  // ...and accepted again once that guest has walked off.
  const host3 = P(0, 0), farGuest = P(200, 0);
  const away = spawnCtx(candidate, host3, farGuest);
  const okPoint = away.d.findSpawnPoint(away.ctx);
  ok(!!okPoint && Math.abs(okPoint.x - at) < 1e-9,
     `co-op: accepted again once the guest is far away (got ${okPoint && okPoint.x})`);

  // A dead guest has no say: `distanceToNearest` skips non-targetable pawns.
  const host4 = P(0, 0), corpse = P(at, 0);
  corpse.alive = false;
  const dead = spawnCtx(candidate, host4, corpse);
  ok(!!dead.d.findSpawnPoint(dead.ctx), 'a dead guest does not veto a spawn on top of them');

  // The anchor's own outer bound is unchanged and still measured from the
  // anchor alone — a guest cannot make a too-distant point legal.
  const farCandidate = { x: MAX_SPAWN_DIST + 10, y: 0, z: 0 };
  const host5 = P(0, 0), midGuest = P(MAX_SPAWN_DIST + 10 - 40, 0);
  const tooFar = spawnCtx(farCandidate, host5, midGuest);
  ok(tooFar.d.findSpawnPoint(tooFar.ctx) === null,
     'beyond MAX_SPAWN_DIST from the anchor is still rejected');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
