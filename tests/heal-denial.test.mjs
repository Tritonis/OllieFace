/**
 * Per-player healing denial, and spawn placement that respects every player.
 *
 *   node tests/heal-denial.test.mjs
 */
import { Director } from '../src/systems/Director.js';
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

console.log('spawn distance respects every player, not just the first');
{
  const near = P(0, 0), far = P(200, 0);
  const { roster } = fresh(far, near);
  // A point 40 m from `far` but 160 m from `near` is fine; a point 5 m from
  // `near` must be rejected however far it is from `far`.
  ok(roster.distanceToNearest({ x: 5, z: 0 }) < 34, 'a point beside the second player reads as close');
  ok(roster.distanceToNearest({ x: 100, z: 0 }) >= 34, 'a point between both reads as far');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
