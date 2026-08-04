/**
 * The Roster — registration, and the one query enemies use to pick a target.
 *
 *   node tests/roster.test.mjs
 */
import { Roster } from '../src/systems/Roster.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = (x, z, extra = {}) => ({ isPlayer: true, alive: true, position: { x, y: 0, z }, ...extra });

function fresh() {
  const ctx = { player: null };
  const r = new Roster();
  r.init(ctx);
  return { r, ctx };
}

console.log('registration');
{
  const { r, ctx } = fresh();
  ok(ctx.roster === r, 'publishes itself on ctx');
  const a = P(0, 0);
  r.add(a);
  r.add(a);
  ok(r.count === 1, `adding twice registers once (got ${r.count})`);
  r.remove(a);
  ok(r.count === 0, 'remove works');
  r.remove(a);
  ok(r.count === 0, 'removing twice is harmless');
}

console.log('nearest — the empty and single cases');
{
  const { r } = fresh();
  ok(r.nearest({ x: 0, z: 0 }) === null, 'empty roster returns null');
  ok(r.distanceToNearest({ x: 0, z: 0 }) === Infinity, 'empty roster distance is Infinity');
  const solo = P(3, 4);
  r.add(solo);
  ok(r.nearest({ x: 0, z: 0 }) === solo, 'single-entry roster returns that entry');
  ok(Math.abs(r.distanceToNearest({ x: 0, z: 0 }) - 5) < 1e-9, 'horizontal distance is 3-4-5');
}

console.log('distance — the same formula Enemy.dist2D uses, to the last bit');
{
  // Not a style preference. `dist2D` in Enemy.js is `Math.hypot(dx, dz)`, and
  // `Math.sqrt(dx * dx + dz * dz)` is a different function on doubles — it
  // disagrees on 38.5% of coordinate pairs in a +/-60 m arena, by up to 2 ulp.
  // Task 6 picks a target through this file and then measures engagement range
  // with dist2D, so the two must be bit-identical or an enemy compares one
  // player's arithmetic against another's, on a value tested against tuned
  // thresholds. This pair is one where the two formulations genuinely differ,
  // so the assertion fails if anyone "simplifies" horizDist back to sqrt.
  const { r } = fresh();
  const X = 7.933275623733294, Z = 9.444902771776412;
  const hypot = Math.hypot(X, Z);
  const naive = Math.sqrt(X * X + Z * Z);
  ok(hypot !== naive, `the chosen pair really does distinguish the two formulas (${hypot} vs ${naive})`);
  r.add(P(X, Z));
  ok(r.distanceToNearest({ x: 0, z: 0 }) === hypot, 'distanceToNearest is exactly Math.hypot, as dist2D is');
}

console.log('nearest — picks the nearer, ignores height');
{
  const { r } = fresh();
  const near = P(2, 0);
  const far = P(20, 0);
  far.position.y = -500;
  r.add(far); r.add(near);
  ok(r.nearest({ x: 0, z: 0 }) === near, 'nearer wins regardless of insertion order');
  ok(r.nearest({ x: 30, z: 0 }) === far, 'query point decides, not registration order');
}

console.log('targetable — dead and downed are excluded');
{
  const { r } = fresh();
  const dead = P(1, 0, { alive: false });
  const downed = P(2, 0, { downed: true });
  const up = P(50, 0);
  r.add(dead); r.add(downed); r.add(up);
  ok(r.nearest({ x: 0, z: 0 }) === up, 'skips dead and downed even though they are far nearer');
  ok(r.count === 3, 'but they stay registered');
  ok(r.alive.length === 1, `alive lists only the targetable one (got ${r.alive.length})`);
}

console.log('targetable — a roster where nobody is targetable');
{
  const { r } = fresh();
  r.add(P(1, 0, { alive: false }));
  r.add(P(2, 0, { downed: true }));
  ok(r.nearest({ x: 0, z: 0 }) === null, 'returns null rather than a dead player');
  ok(r.distanceToNearest({ x: 0, z: 0 }) === Infinity, 'distance is Infinity');
}

console.log('nearest — ties are stable');
{
  const { r } = fresh();
  const first = P(5, 0);
  const second = P(-5, 0);
  r.add(first); r.add(second);
  ok(r.nearest({ x: 0, z: 0 }) === first, 'an exact tie resolves to the earlier registration');
  ok(r.nearest({ x: 0, z: 0 }) === first, 'and does so repeatably');
}

console.log('nearest — the out parameter allocates nothing');
{
  const { r } = fresh();
  const p = P(3, 4);
  r.add(p);
  const out = { player: null, dist: 0 };
  const got = r.nearest({ x: 0, z: 0 }, out);
  ok(got === p, 'still returns the player');
  ok(out.player === p && Math.abs(out.dist - 5) < 1e-9, 'fills the out object');
}

console.log('local');
{
  const { r, ctx } = fresh();
  const me = P(0, 0);
  r.add(me);
  ok(r.local === null, 'null before ctx.player exists');
  ctx.player = me;
  ok(r.local === me, 'tracks ctx.player');
}

console.log('forEachTargetable');
{
  const { r } = fresh();
  r.add(P(0, 0)); r.add(P(1, 0, { alive: false })); r.add(P(2, 0));
  const seen = [];
  r.forEachTargetable((p) => seen.push(p.position.x));
  ok(seen.length === 2 && seen[0] === 0 && seen[1] === 2, `visits only targetable, in order (got ${JSON.stringify(seen)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
