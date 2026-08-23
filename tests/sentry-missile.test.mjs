/**
 * Rook's sentry fires a missile, and only a missile (issue #190).
 *
 *   node tests/sentry-missile.test.mjs
 *
 * The change was cosmetic by decision: the turret was hitscan with a bare green
 * tracer and stays hitscan with a missile drawn over the same line — since #198
 * the very missile Ranger's Suppressive Salvo fires, in Rook's green and a size
 * down. Cosmetic changes are exactly the ones that quietly stop being cosmetic,
 * so the claims that could rot are asserted rather than promised:
 *
 *  1. the shot still resolves through `combat.hitscan` on the same call that
 *     draws it, with the same damage, and nothing is queued, stepped or spawned
 *     as a projectile in between. Introduce travel time and this fails.
 *  2. the body arrives effectively instantly *at every range* — its flight is
 *     a constant, not a function of distance — so the visual can never drift
 *     behind the damage it illustrates on a long shot.
 *  3. the body really is the projectile renderer's body and not a lookalike,
 *     and the pool drawing it has no gameplay surface to grow one from.
 *
 * The first two drive the real methods against stub pools; none re-type the
 * code.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PlaceablePool } from '../src/entities/Placeables.js';
import { VFX } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n         got  ${got}\n         want ${want}`);

/* ------------------------------------------------ 1. the shot still hitscans */

console.log('the sentry resolves on the frame it draws, with no projectile in between');
{
  const calls = [];
  const target = {
    isEnemy: true, alive: true, team: 'enemy', height: 1.8,
    position: new THREE.Vector3(0, 0, 12),
  };
  const ctx = {
    enemies: { list: [target], items: [target] },
    combat: { hitscan: (from, dir, range, opts) => calls.push({ kind: 'hitscan', to: from.clone(), dir: dir.clone(), range, opts }) },
    projectiles: { spawn: (...a) => calls.push({ kind: 'projectile', a }) },
    vfx: {
      sentryMissile: (from, to) => calls.push({ kind: 'missile', from: from.clone(), to: to.clone() }),
      tracer: () => calls.push({ kind: 'tracer' }),
      muzzleFlash: () => {},
    },
  };
  const p = {
    kind: 'turret', alive: true, timer: 0, period: 0.6, damage: 17, proc: 1, range: 30,
    position: new THREE.Vector3(0, 0, 0), target, owner: { alive: true, isPlayer: true },
    rig: {}, life: 1, maxLife: 20,
  };

  PlaceablePool.prototype._stepTurret.call(Object.create(PlaceablePool.prototype), ctx, p, 0.016);

  const kinds = calls.map((c) => c.kind);
  ok(kinds.includes('hitscan'), `the shot resolves as a hitscan (${kinds.join(', ') || 'nothing fired'})`);
  ok(kinds.includes('missile'), 'and is dressed as a missile');
  ok(!kinds.includes('tracer'), 'the bare tracer is gone, not merely joined');
  ok(!kinds.includes('projectile'),
    'and nothing was spawned as a travelling projectile — the change is visual');

  const hit = calls.find((c) => c.kind === 'hitscan');
  eq(hit.opts.damage, 17, 'the damage carried is the turret\'s own, untouched');
  eq(hit.opts.type, 'hitscan', 'and it is still declared hitscan to combat');

  // Ordering is the load-bearing half: the visual must not be able to gate the
  // damage. The hitscan is emitted first and unconditionally.
  ok(kinds.indexOf('hitscan') < kinds.indexOf('missile'),
    'damage resolves before the effect is asked for, so the effect cannot delay it');

  // And the effect really tracks the shot rather than being fired at a fixture.
  const shot = calls.find((c) => c.kind === 'missile');
  ok(shot.to.distanceTo(new THREE.Vector3(0, 0, 12)) < 2,
    `the streak is drawn to where the shot landed (${shot.to.toArray().map((n) => n.toFixed(1)).join(',')})`);

  // A turret with no target does nothing at all, visual included.
  const idle = [];
  const q = { ...p, target: null, timer: 0 };
  const idleCtx = { ...ctx, enemies: { list: [], items: [] }, vfx: { sentryMissile: () => idle.push(1) } };
  PlaceablePool.prototype._stepTurret.call(Object.create(PlaceablePool.prototype), idleCtx, q, 0.016);
  eq(idle.length, 0, 'and a sentry with nothing to shoot draws no missile');
}

/* ------------------------------------------- 2. the streak arrives instantly */

/** The real `sentryMissile` against stub pools, recording every emit and dart. */
function emitVfx() {
  const v = Object.create(VFX.prototype);
  const emits = [];
  const flicks = [];
  const darts = [];
  v.particles = { emit: (e) => emits.push({ life: e.life, speed: e.speed, delay: e.delay, count: e.count, stretch: e.stretch }) };
  v.lights = { flick: () => flicks.push(1) };
  v.darts = { fire: (from, to, o) => darts.push({ from: from.clone(), to: to.clone(), ...o }) };
  v._ep = () => ({
    position: new THREE.Vector3(), dir: new THREE.Vector3(),
    color0: new THREE.Color(), color1: new THREE.Color(),
    delay: 0, count: 1,
  });
  return { v, emits, flicks, darts };
}

console.log('\nthe shot is a missile body, and it arrives instantly at any range');
{
  const at = (metres) => {
    const rig = emitVfx();
    rig.v.sentryMissile(new THREE.Vector3(), new THREE.Vector3(0, 0, metres));
    return rig;
  };

  const near = at(4);
  const far = at(30);

  // 1. It is drawn the way a homing projectile is drawn: a pooled mesh body
  //    with a ribbon trail, not a stretched particle pretending to be one.
  eq(far.darts.length, 1, 'exactly one missile body is sent down the shot line');
  const dart = far.darts[0];
  ok(dart.to.distanceTo(new THREE.Vector3(0, 0, 30)) < 1e-6,
    'and it flies to where the hitscan landed, not to a fixed distance');
  ok(dart.scale > 0 && dart.scale < 1,
    `the body is smaller than a Suppressive Salvo missile (scale ${dart.scale})`);
  eq(dart.trailColour, 0xbfff7a, 'the ribbon is Rook\'s green');
  eq(dart.colour, 0x9dff5a, 'and the body carries the accent');
  ok(dart.width > 0 && dart.trailLife > 0, 'the ribbon has a width and a lifetime');

  ok(near.emits.length >= 2, `plus a launch puff and an impact (${near.emits.length} emits)`);

  // 2. The flight is a constant. If it were derived from distance — the shape
  //    the stock `missile` uses — these two would differ and a long shot would
  //    visibly lag its own damage.
  eq(near.darts[0].life, dart.life,
    'the body\'s flight is the same at 4 m and at 30 m — a constant, not a function of range');
  ok(dart.life <= 0.08,
    `and it is inside a few frames (${dart.life}s), which is what "instant" has to mean`);

  // The terminal spark waits exactly the flight, so arrival and impact coincide.
  const impact = far.emits.find((e) => e.delay > 0);
  ok(impact, 'the impact spark is delayed rather than firing at the muzzle');
  eq(impact.delay, dart.life, 'and delayed by precisely the flight — arrival IS the impact');

  // Cheapness is a requirement here, not a nicety: a field of sentries fires
  // this several times a second.
  const total = far.emits.reduce((n, e) => n + e.count, 0);
  ok(total <= 12, `the whole shot costs ${total} particles beside the one body`);

  const missing = emitVfx();
  ok(missing.v.sentryMissile(null, new THREE.Vector3()) === undefined,
    'and a missing endpoint is declined rather than thrown');
  eq(missing.darts.length, 0, 'with no body sent');
  const zero = emitVfx();
  zero.v.sentryMissile(new THREE.Vector3(), new THREE.Vector3());
  eq(zero.emits.length + zero.darts.length, 0, 'as is a zero-length shot');
}

/* ------------------------------------ 3. the body is the projectile's body */

/**
 * The dart pool is not a second projectile renderer wearing the first one's
 * clothes — it is meant to be the *same* clothes. If `ProjectilePool` re-cuts
 * its missile silhouette and this does not follow, the sentry stops matching
 * the Salvo it was styled after and nobody finds out by eye.
 *
 * It is also the mutation guard for "no projectile is spawned": the pool has no
 * velocity, no damage and no collision to give one, so a dart can never quietly
 * become a shot that hurts something.
 */
console.log('\nthe missile body is the projectile renderer\'s body');
{
  const src = readFileSync(new URL('../src/systems/VFX.js', import.meta.url), 'utf8');
  const proj = readFileSync(new URL('../src/entities/Projectile.js', import.meta.url), 'utf8');

  const cone = /new THREE\.ConeGeometry\(0\.12, 0\.46, 6\)/;
  ok(cone.test(proj), 'the projectile pool still builds its body from a 0.12 x 0.46 six-sided cone');
  ok(cone.test(src), 'and the dart pool builds the identical geometry');

  const emissive = /emissiveIntensity: 2\.2/;
  ok(emissive.test(proj) && emissive.test(src),
    'both light the body with the same emissive standard material');

  const dartClass = src.slice(src.indexOf('class DartPool'), src.indexOf('class LightPool'));
  ok(dartClass.length > 200, 'the dart pool is where this test thinks it is');
  ok(/trails\?\.spawn\(/.test(dartClass), 'a dart drags one of the shared ribbon trails');
  ok(/coreColor/.test(dartClass), 'with a white core, as a Salvo missile\'s does');
  for (const gameplay of ['damage', 'velocity', 'radius', 'owner', 'hitscan', 'splash']) {
    ok(!new RegExp(`\\b${gameplay}\\b`).test(dartClass),
      `and knows nothing about \`${gameplay}\` — it cannot become a projectile`);
  }
  // Allocation-free: `fire` may only flip flags on pre-built entries.
  ok(!/\bfire\([\s\S]*?\n  \}/.exec(dartClass)?.[0].includes('new THREE.'),
    'firing one allocates nothing — a field of sentries must not churn the heap');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
