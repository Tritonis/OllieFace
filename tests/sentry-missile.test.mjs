/**
 * Rook's sentry fires a missile, and only a missile (issue #190).
 *
 *   node tests/sentry-missile.test.mjs
 *
 * The change was cosmetic by decision: the turret was hitscan with a bare green
 * tracer and stays hitscan with a missile-styled streak drawn over the same
 * line. Cosmetic changes are exactly the ones that quietly stop being cosmetic,
 * so the two claims that could rot are asserted rather than promised:
 *
 *  1. the shot still resolves through `combat.hitscan` on the same call that
 *     draws it, with the same damage, and nothing is queued, stepped or spawned
 *     as a projectile in between. Introduce travel time and this fails.
 *  2. the streak arrives effectively instantly *at every range* — its flight is
 *     a constant, not a function of distance — so the visual can never drift
 *     behind the damage it illustrates on a long shot.
 *
 * Both drive the real methods against stub pools; neither re-types the code.
 */
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

/** The real `sentryMissile` against stub pools, recording every emit. */
function emitVfx() {
  const v = Object.create(VFX.prototype);
  const emits = [];
  const flicks = [];
  v.particles = { emit: (e) => emits.push({ life: e.life, speed: e.speed, delay: e.delay, count: e.count, stretch: e.stretch }) };
  v.lights = { flick: () => flicks.push(1) };
  v._ep = () => ({
    position: new THREE.Vector3(), dir: new THREE.Vector3(),
    color0: new THREE.Color(), color1: new THREE.Color(),
    delay: 0, count: 1,
  });
  return { v, emits, flicks };
}

console.log('\nthe streak arrives effectively instantly, at any range');
{
  const at = (metres) => {
    const { v, emits } = emitVfx();
    v.sentryMissile(new THREE.Vector3(), new THREE.Vector3(0, 0, metres), 0xbfff7a);
    return emits;
  };

  const near = at(4);
  const far = at(30);
  ok(near.length >= 3, `a shot draws a body, a wake and an impact (${near.length} emits)`);

  // The flight is a constant. If it were derived from distance — the shape the
  // stock `missile` uses — these two would differ and a long shot would visibly
  // lag its own damage.
  eq(near[0].life, far[0].life,
    'the body\'s flight is the same at 4 m and at 30 m — a constant, not a function of range');
  ok(near[0].life <= 0.08,
    `and it is inside a few frames (${near[0].life}s), which is what "instant" has to mean`);

  // Which means the speed IS a function of range: same time, more ground.
  ok(far[0].speed > near[0].speed * 5,
    'so the body covers the longer gap faster rather than taking longer');

  // The terminal spark waits exactly the flight, so arrival and impact coincide.
  const impact = far.find((e) => e.delay > 0);
  ok(impact, 'the impact spark is delayed rather than firing at the muzzle');
  eq(impact.delay, far[0].life, 'and delayed by precisely the flight — arrival IS the impact');

  // Cheapness is a requirement here, not a nicety: a field of sentries fires
  // this several times a second.
  const total = far.reduce((n, e) => n + e.count, 0);
  ok(total <= 12, `the whole shot costs ${total} particles`);

  ok(emitVfx().v.sentryMissile(null, new THREE.Vector3()) === undefined,
    'and a missing endpoint is declined rather than thrown');
  const zero = emitVfx();
  zero.v.sentryMissile(new THREE.Vector3(), new THREE.Vector3());
  eq(zero.emits.length, 0, 'as is a zero-length shot');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
