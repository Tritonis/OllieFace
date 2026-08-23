// tests/enemy-hurtbox.test.mjs
//
// #187: player shots slide past flyers and small distant kinds. The fix is a
// per-kind `hurtbox` multiplier in the data table that ONLY player-fired
// projectiles test. Two things have to stay true and neither is self-evident
// from the diff:
//
//   1. The kinds the complaint is about still declare forgiveness. A silent
//      regression to 1.0 is invisible in play until someone reports #187
//      again, so the roster is re-derived from the data here (isFlyer, body
//      radius, behaviour) rather than listed by hand: a NEW flyer added to
//      enemies.js without a hurtbox fails this file.
//   2. The forgiveness is one-directional. A shot that misses the body by
//      less than the margin hits a flyer, misses a standard grounded kind,
//      and — fired by a monster rather than the player — misses the flyer too.
//
// The geometry assertions drive the real `hits` path through the pool's
// `_entityAt`, not a re-implementation of it; a re-implemented capsule test
// would pass against a `hits` that had been deleted.
import { ENEMIES, ENEMY_BY_ID } from '../src/data/enemies.js';
import { ProjectilePool } from '../src/entities/Projectile.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const hurtR = (d) => d.hurtbox?.radius ?? 1;
const hurtH = (d) => d.hurtbox?.height ?? 1;

console.log('the hard-to-hit classes are forgiven, and the roster is derived from the data');
{
  const flyers = ENEMIES.filter((e) => e.isFlyer);
  ok(flyers.length >= 6, `${flyers.length} flying kinds found in the table`);
  for (const e of flyers) {
    ok(hurtR(e) > 1, `${e.id}: a flyer declares radius forgiveness (${hurtR(e)}x)`);
  }
  // The small flyers are the complaint proper; the two large ones (r >= 2) are
  // already easy to hit and get only a token bump.
  for (const e of flyers.filter((f) => f.radius < 1.5)) {
    ok(hurtR(e) >= 1.5, `${e.id}: a small flyer is forgiven at least 1.5x (${hurtR(e)}x)`);
    ok(hurtH(e) > 1, `${e.id}: a small flyer is forgiven vertically too (${hurtH(e)}x)`);
  }

  // Small, fast, grounded — the other half of "hard to hit". The speed line is
  // 7 m/s and not 6: the skink is a 0.5 m x 1.7 m melee closer at 6.2 m/s that
  // walks onto the crosshair, and forgiving it would be the global fattening
  // #187 explicitly rejected. Above 7 the unit crosses the reticle faster than
  // a shot's flight time and the miss is the engine's, not the player's.
  const smallFast = ENEMIES.filter((e) => !e.isFlyer && e.radius <= 0.5 && e.moveSpeed >= 7);
  ok(smallFast.length >= 2, `${smallFast.length} small fast grounded kinds found`);
  for (const e of smallFast) ok(hurtR(e) > 1, `${e.id}: small and fast, forgiven (${hurtR(e)}x)`);

  // Habitually distant by design.
  for (const e of ENEMIES.filter((x) => !x.isFlyer && x.behavior === 'kiter' && x.radius < 0.6)) {
    ok(hurtR(e) > 1, `${e.id}: a small kiter fights at range, forgiven (${hurtR(e)}x)`);
  }
}

console.log('standard grounded kinds are untouched, and nothing is absurd');
{
  for (const id of ['scarab', 'skink', 'charger', 'warden', 'sentinel', 'hulk', 'colossus']) {
    const e = ENEMY_BY_ID[id] || ENEMY_BY_ID.get?.(id);
    ok(!!e, `${id} exists`);
    ok(hurtR(e) === 1 && hurtH(e) === 1, `${id}: a standard grounded kind stays at 1.0`);
  }
  for (const e of ENEMIES) {
    ok(hurtR(e) >= 1 && hurtR(e) <= 1.8, `${e.id}: radius multiplier within 1.0-1.8`);
    ok(hurtH(e) >= 1 && hurtH(e) <= 1.8, `${e.id}: height multiplier within 1.0-1.8`);
  }
}

// --- geometry: the real collision path -------------------------------------

/** A target entity shaped like a registered Enemy, with the hurtbox resolved
 *  exactly as `Enemy` resolves it (metres, not multipliers). */
function target(id, x, z) {
  const d = ENEMY_BY_ID[id] || ENEMY_BY_ID.get?.(id);
  return {
    alive: true, team: 'monster',
    position: { x, y: 0, z, distanceTo: () => 99, distanceToSquared: () => 99 * 99 },
    radius: d.radius, height: d.height,
    hurtRadius: d.radius * hurtR(d), hurtHeight: d.height * hurtH(d),
    def: d,
  };
}

/** Fires the shared accept test through the pool's own `_entityAt`, with a
 *  registry the hash path deliberately does not recognise so the linear scan
 *  runs. `combat` is present but is not the hash owner.
 *
 *  A monster-fired shot needs a hostile target or the friendly-fire guard
 *  answers before the geometry does, so the same body is re-teamed for that
 *  arm. In play the target of a monster shot is the survivor, who declares no
 *  hurtbox at all; re-teaming an enemy body is how the *branch* gets exercised
 *  on geometry we can compare like for like. */
function shotHits(ownerTeam, e, x, y, z, r = 0.22) {
  const tgt = ownerTeam === 'player' ? e : { ...e, team: 'player' };
  const ps = Object.create(ProjectilePool.prototype);
  const ctx = { combat: { entities: [tgt] } };
  const p = { position: { x, y, z }, radius: r, owner: { team: ownerTeam } };
  return ps._entityAt(ctx, p) === tgt;
}

console.log('a near miss on the body lands on a flyer and not on a grounded standard');
{
  const harrier = ENEMY_BY_ID.harrier || ENEMY_BY_ID.get?.('harrier');
  const scarab = ENEMY_BY_ID.scarab || ENEMY_BY_ID.get?.('scarab');
  const shotR = 0.22;

  // A lateral offset inside the harrier's forgiveness but outside its body.
  const h = target('harrier', 0, 0);
  const yMid = h.height * 0.5;
  const near = harrier.radius + shotR + 0.12;          // clears the body
  ok(near < h.hurtRadius + shotR, 'the probe offset is inside the hurtbox and outside the body');

  ok(shotHits('player', h, near, yMid, 0), 'a player shot inside the margin hits the harrier');
  ok(!shotHits('monster', h, near, yMid, 0), 'the same geometry from a monster shot misses: forgiveness is one-way');
  ok(shotHits('player', h, 0, yMid, 0), 'a dead-centre player shot still hits');
  ok(shotHits('monster', h, 0, yMid, 0), 'a dead-centre monster shot still hits: the body is unchanged');
  ok(!shotHits('player', h, h.hurtRadius + shotR + 0.2, yMid, 0), 'past the margin a player shot still misses');

  // The same absolute offset against a grounded standard kind must miss: the
  // margin is per-kind, not a global fattening (the rejected alternative).
  const s = target('scarab', 0, 0);
  const sMid = s.height * 0.5;
  const sNear = scarab.radius + shotR + 0.12;
  ok(!shotHits('player', s, sNear, sMid, 0), 'the same near miss on a scarab is still a miss');
  ok(shotHits('player', s, 0, sMid, 0), 'a centred shot on a scarab hits');

  // Vertical: a shot passing over a mite. The mite is 0.5 m tall, so this is
  // the axis the complaint is actually lost on.
  const m = target('mite', 0, 0);
  const bodyHalf = m.height * 0.5;
  const above = bodyHalf + bodyHalf + shotR + 0.03;    // clears body top by a hair
  ok(!shotHits('monster', m, 0, above, 0), 'a monster shot at that height passes over the mite');
  ok(shotHits('player', m, 0, above, 0), 'a player shot at that height clips the mite anyway');
}

console.log('mutation check: zeroing the hurtbox reverts the behaviour');
{
  const h = target('harrier', 0, 0);
  const yMid = h.height * 0.5;
  const harrier = ENEMY_BY_ID.harrier || ENEMY_BY_ID.get?.('harrier');
  const near = harrier.radius + 0.22 + 0.12;
  const before = shotHits('player', h, near, yMid, 0);
  h.hurtRadius = h.radius; h.hurtHeight = h.height;
  const after = shotHits('player', h, near, yMid, 0);
  ok(before && !after, 'the geometric assertion CAN fail — it tracks the hurtbox, not the code path');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
