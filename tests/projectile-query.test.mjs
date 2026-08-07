/**
 * The projectile hit query, and the selection rule it is not allowed to move.
 *
 *   node tests/projectile-query.test.mjs
 *
 * `ProjectilePool._entityAt` answers "which entity is this projectile touching
 * right now". It used to answer it with a linear scan of the whole combat
 * registry; it now asks Combat's 8 m spatial hash instead. The scan and the
 * hash do not visit entities in the same order, so every case below is stated
 * twice — once against a combat that has no hash (the linear fallback) and once
 * against a real `Combat` — and both are required to return the *same* entity,
 * not merely a plausible one.
 *
 * That is the whole point: this repo has a fixed-seed equivalence gate, and the
 * survivor's aim is re-derived from enemy positions every step, so picking a
 * different — equally-overlapping — enemy rewrites the run. The rule these
 * tests pin is:
 *
 *   the FIRST entity in combat registry order that passes the overlap test.
 *
 * `_entityAt` touches no pool state, so it is exercised off the prototype
 * rather than through a constructed pool, which would want a scene and 96
 * meshes to say nothing more.
 */
import { ProjectilePool } from '../src/entities/Projectile.js';
import { Combat } from '../src/systems/Combat.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const pool = Object.create(ProjectilePool.prototype);
const entityAt = (ctx, p) => pool._entityAt(ctx, p);

/** An enemy as the query sees it: a tag, a team, a capsule. */
const E = (tag, x, y, z, extra = {}) => ({
  tag, alive: true, team: 'monster', radius: 0.5, height: 1.6,
  position: { x, y, z }, ...extra,
});

const P = (x, y, z, extra = {}) => ({
  position: { x, y, z }, radius: 0.22, owner: null, ...extra,
});

/**
 * Runs one scenario down both routes with the *same* entity objects, so a
 * divergence can only come from the query. `expect` is a tag, or null for "no
 * hit". `mutate` runs after registration: it is how the stale-hash cases move
 * an entity without reindexing it.
 */
function both(msg, enemies, projectile, expect, mutate) {
  const combat = new Combat();
  for (const e of enemies) combat.register(e);
  if (mutate) mutate(combat);

  const viaList = entityAt({ combat: { entities: enemies } }, projectile);
  const viaHash = entityAt({ combat }, projectile);
  const tagOf = (e) => (e ? e.tag : null);
  ok(tagOf(viaList) === expect, `${msg} — linear scan picks ${expect === null ? 'nothing' : expect} (got ${tagOf(viaList)})`);
  ok(tagOf(viaHash) === expect, `${msg} — spatial hash picks ${expect === null ? 'nothing' : expect} (got ${tagOf(viaHash)})`);
  ok(viaList === viaHash, `${msg} — both routes return the identical object`);
}

console.log('the winner among several overlapping enemies is the first REGISTERED, not the nearest');
{
  // 'far' is registered first and is further away; the rule is list order, so
  // it wins anyway. A nearest-wins query would answer 'near' here.
  const far = E('far', 0.6, 0, 0);
  const near = E('near', 0.05, 0, 0);
  both('two overlapping', [far, near], P(0, 0.8, 0), 'far');
  // Registration order reversed, same geometry: the answer follows the list.
  const far2 = E('far', 0.6, 0, 0);
  const near2 = E('near', 0.05, 0, 0);
  both('two overlapping, order swapped', [near2, far2], P(0, 0.8, 0), 'near');
}

console.log('list order beats cell order across a cell boundary');
{
  // The case that fails if the hash returns whichever candidate a bucket walk
  // reaches first. Cells are 8 m and walked in ascending x, so 'lowcell' is
  // visited first — but 'highcell' is registered first and must still win.
  const highcell = E('highcell', 8.2, 0, 0);   // cell x = 1
  const lowcell = E('lowcell', 7.9, 0, 0);     // cell x = 0
  both('straddling x = 8', [highcell, lowcell], P(8.0, 0.8, 0), 'highcell');
}

console.log('an enemy in the neighbouring cell is still found');
{
  // The classic spatial-hash off-by-one: 0.31 m apart, opposite sides of a
  // cell boundary. Anything that only reads the projectile's own cell misses.
  both('neighbour across x = 8', [E('over', 8.3, 0, 0)], P(7.99, 0.8, 0), 'over');
  both('neighbour across z = 8', [E('over', 0, 0, 8.3)], P(0, 0.8, 7.99), 'over');
  both('neighbour across x = -8', [E('over', -8.3, 0, 0)], P(-7.99, 0.8, 0), 'over');
  both('diagonal neighbour', [E('over', 8.3, 0, 8.3)], P(7.99, 0.8, 7.99), 'over');
}

console.log('the overlap test itself, from both sides');
{
  // r = enemy 0.5 + projectile 0.22 = 0.72, compared in XZ only.
  both('just inside the radius', [E('in', 0.71, 0, 0)], P(0, 0.8, 0), 'in');
  both('just outside the radius', [E('out', 0.73, 0, 0)], P(0, 0.8, 0), null);
  // Vertical extent is |dy| < half-height + projectile radius = 1.02, measured
  // from the capsule centre at y + 0.8.
  both('just inside the capsule top', [E('in', 0, 0, 0)], P(0, 1.81, 0), 'in');
  both('just above the capsule', [E('out', 0, 0, 0)], P(0, 1.83, 0), null);
  both('just below the capsule', [E('out', 0, 0, 0)], P(0, -0.23, 0), null);
}

console.log('dead, own, and friendly entities are skipped — and skipping yields the next in list order');
{
  const dead = E('dead', 0, 0, 0, { alive: false });
  const live = E('live', 0.1, 0, 0);
  both('a dead enemy is not a hit', [dead, live], P(0, 0.8, 0), 'live');
  both('a dead enemy alone is no hit', [E('dead', 0, 0, 0, { alive: false })], P(0, 0.8, 0), null);

  const owner = { team: 'player', position: { x: 0, y: 0, z: 0 } };
  const self = E('self', 0, 0, 0, { team: 'player' });
  const mate = E('mate', 0.05, 0, 0, { team: 'player' });
  const foe = E('foe', 0.1, 0, 0);
  both('the shooter and its team are skipped', [self, mate, foe], P(0, 0.8, 0, { owner }), 'foe');
  // Without an owner nothing is filtered by team, so the first in list wins.
  const self2 = E('self', 0, 0, 0, { team: 'player' });
  const foe2 = E('foe', 0.1, 0, 0);
  both('an ownerless projectile hits either team', [self2, foe2], P(0, 0.8, 0), 'self');
}

console.log('a big enemy is found from outside its cell');
{
  // Reach is the enemy radius, not the projectile radius: a 3 m boss centred
  // two cells away in the hash still overlaps a projectile at the boundary.
  both('radius 3 boss across a boundary', [E('boss', 10.5, 0, 0, { radius: 3, height: 4 })], P(8.0, 2.0, 0), 'boss');
}

console.log('an entity that moved since the hash was built is still found');
{
  // `Combat` reindexes once per fixed step, so by the time projectiles tick an
  // entity can sit under a stale key. The linear scan never had this problem;
  // the hash must not introduce it.
  const drifter = E('drifter', 0, 0, 0);
  both('moved within its cell', [drifter], P(0.4, 0.8, 0), 'drifter', () => { drifter.position.x = 0.4; });

  const crosser = E('crosser', 7.9, 0, 0);   // indexed in cell x = 0
  both('moved across a cell boundary', [crosser], P(8.4, 0.8, 0), 'crosser', () => { crosser.position.x = 8.4; });

  // A full cell of staleness — more than any unit travels in a step, and the
  // reason the candidate query widens its cell range by one on each side
  // instead of taking exactly the cells its radius covers. Without the widening
  // this entity is indexed two cells from where the search looks and is missed.
  const jumper = E('jumper', 7.0, 0, 0);     // indexed in cell x = 0
  both('a full cell of stale key', [jumper], P(16.4, 0.8, 0), 'jumper', () => { jumper.position.x = 16.4; });
  const jumperZ = E('jumper', 0, 0, 7.0);
  both('a full cell of stale key in z', [jumperZ], P(0, 0.8, 16.4), 'jumper', () => { jumperZ.position.z = 16.4; });
}

console.log('degenerate registries answer null rather than throwing');
{
  ok(entityAt({}, P(0, 0.8, 0)) === null, 'no combat at all');
  ok(entityAt({ combat: {} }, P(0, 0.8, 0)) === null, 'a combat with no registry');
  ok(entityAt({ combat: { entities: [] } }, P(0, 0.8, 0)) === null, 'an empty registry');
  ok(entityAt({ combat: { entities: [null, undefined] } }, P(0, 0.8, 0)) === null, 'holes in the registry');
}

console.log('a registry the hash does not back is still scanned linearly');
{
  // `enemyList` also accepts `combat.enemies` and `combat.all()`. Those lists
  // are not what the hash contains, so the query must not consult it for them.
  const combat = new Combat();
  const indexed = E('indexed', 0, 0, 0);
  combat.register(indexed);
  const other = E('other', 0.1, 0, 0);
  combat.enemies = [other];
  ok(entityAt({ combat }, P(0, 0.8, 0)) === indexed, 'combat.entities wins when it exists');

  const noEntities = { enemies: [other] };
  ok(entityAt({ combat: noEntities }, P(0, 0.8, 0)) === other, 'combat.enemies is scanned when there is no entities array');
  const fn = { all: () => [other] };
  ok(entityAt({ combat: fn }, P(0, 0.8, 0)) === other, 'combat.all() is scanned too');
}

console.log('a registry the hash cannot hold falls back to the scan');
{
  // Over the candidate buffer's capacity the query has to answer from the
  // registry, and the answer must not change.
  const enemies = [];
  for (let i = 0; i < 400; i++) enemies.push(E(`e${i}`, (i % 20) * 0.05, 0, Math.floor(i / 20) * 0.05));
  both('400 entities piled into one cell', enemies, P(0, 0.8, 0), 'e0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
