// tests/corpse-launch.test.mjs
//
// A corpse launch is the one piece of juice in this slice that moves
// something the player can see moving, which makes it the one most likely to
// be mistaken for physics. It is not: it is an offset VFX writes on top of a
// transform Enemy rewrites from `this.position` every frame, so it touches no
// entity state, no FSM, and nothing `tests/sp-equivalence.mjs` fingerprints.
// These assertions exist mostly to keep it that way.
import * as THREE from 'three';
import { VFX, LAUNCH } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A stand-in for the rig root: the only thing a launch is allowed to touch. */
function makeCorpse() {
  const o = new THREE.Object3D();
  o.position.set(4, 0, -3);
  return o;
}

/** The bare ctx a launch needs. `rng` throws: a cosmetic launch may never
 *  draw from the shared stream. */
function makeCtx() {
  return {
    time: 0,
    rng: { next() { throw new Error('ctx.rng drawn from presentation'); },
           range() { throw new Error('ctx.rng drawn from presentation'); } },
    fxRng: { next: () => 0.5, range: (a, b) => (a + b) * 0.5 },
  };
}

console.log('the launch constants are exported and sane');
{
  ok(LAUNCH.minOverkillFrac > 0 && LAUNCH.minOverkillFrac < 1, 'a threshold, not a certainty');
  ok(LAUNCH.maxSpeed > 0 && LAUNCH.gravity > 0 && LAUNCH.dur > 0, 'speed, gravity, life');
  // Corpses are reaped at DEATH_TIME = 1.5s (src/entities/Enemy.js:25). A
  // launch that outlives its corpse is animating an object that is gone.
  ok(LAUNCH.dur <= 1.5, 'the launch cannot outlive the corpse');
}

console.log('a launch offsets the rig root and never accumulates into it');
{
  const vfx = new VFX();
  const corpse = makeCorpse();
  const home = corpse.position.clone();

  vfx.corpseLaunch(corpse, 1, 0, 1);
  ok(vfx._launches.length === 1, 'the launch is registered');

  // Each frame the owner rewrites the transform from its own position, exactly
  // as Enemy.updateRig does, and VFX re-applies the offset on top.
  const step = (dt) => { corpse.position.copy(home); vfx._updateLaunches(dt); };

  step(1 / 60);
  const first = corpse.position.clone();
  ok(first.x > home.x, 'the body has moved along the launch direction');
  ok(first.y > home.y, 'and off the ground');

  for (let i = 0; i < 20; i++) step(1 / 60);
  ok(corpse.position.x > first.x, 'it keeps travelling');
  ok(corpse.rotation.x !== 0 || corpse.rotation.z !== 0, 'and tumbles');

  // The property that makes this cosmetic: stop re-applying and the object is
  // exactly where its owner put it, with no residue at all.
  for (let i = 0; i < 200; i++) step(1 / 60);
  ok(vfx._launches.length === 0, 'the launch retires itself');
  ok(corpse.rotation.x === 0 && corpse.rotation.z === 0,
     'and hands the tumble back — no residue on a transform nobody else rewrites');
  corpse.position.copy(home);
  vfx._updateLaunches(1 / 60);
  ok(corpse.position.equals(home), 'a retired launch writes nothing');
}

console.log('the arc rises then falls, and lands');
{
  const vfx = new VFX();
  const corpse = makeCorpse();
  const home = corpse.position.clone();
  const step = (dt) => { corpse.position.copy(home); vfx._updateLaunches(dt); return corpse.position.y - home.y; };
  vfx.corpseLaunch(corpse, 0, 1, 1);
  let peak = 0, ys = [];
  for (let i = 0; i < 90; i++) { const y = step(1 / 60); ys.push(y); if (y > peak) peak = y; }
  ok(peak > 0.5, `the body actually leaves the ground (peak ${peak.toFixed(2)}m)`);
  ok(ys[ys.length - 1] <= peak, 'and comes back down');
  ok(ys.every((y) => y >= -0.001), 'it never sinks through the floor it started on');
}

console.log('power scales the throw, and zero power throws nothing');
{
  const vfx = new VFX();
  const weak = makeCorpse(), strong = makeCorpse();
  const hw = weak.position.clone(), hs = strong.position.clone();
  vfx.corpseLaunch(weak, 1, 0, 0.2);
  vfx.corpseLaunch(strong, 1, 0, 1);
  // Six frames, not twelve: a 0.2-power launch lands at t = 2*vy/g = 0.124s,
  // i.e. frame 8. Compared after it had already retired, this block would
  // pass by measuring an offset of zero against a real one, which is a test
  // that goes green for the wrong reason.
  for (let i = 0; i < 6; i++) {
    weak.position.copy(hw); strong.position.copy(hs);
    vfx._updateLaunches(1 / 60);
  }
  ok(strong.position.x - hs.x > weak.position.x - hw.x, 'more overkill throws further');

  const still = makeCorpse();
  const h = still.position.clone();
  const before = vfx._launches.length;
  vfx.corpseLaunch(still, 1, 0, 0);
  ok(vfx._launches.length === before, 'zero power registers nothing');
  vfx.corpseLaunch(null, 1, 0, 1);
  ok(vfx._launches.length === before, 'and neither does a missing object');
  void h;
}

console.log('the same corpse is never launched twice');
{
  const vfx = new VFX();
  const corpse = makeCorpse();
  vfx.corpseLaunch(corpse, 1, 0, 1);
  vfx.corpseLaunch(corpse, -1, 0, 1);
  ok(vfx._launches.length === 1, 'a second kill event on the same body is ignored');
}

console.log('a real kill event reaches the launch through _onKill');
{
  // The block that matters. Everything above drives `corpseLaunch` directly
  // with a bare Object3D, which is exactly how a dead feature passes its own
  // tests: the trigger in `_onKill` resolves the victim through
  // `resolveObject`, and an `Enemy` is not shaped like an `Object3D` and not
  // shaped like a `Player`. Its only handle on its scene node is `rig.root`
  // (`Enemy.spawn`), so this victim carries `rig.root` and deliberately
  // carries none of the `.mesh`/`.group`/`.root`/`.object3D` aliases the
  // player path happens to provide. If `resolveObject` stops understanding
  // that shape, no corpse in the shipped game is ever thrown again and this is
  // the only assertion in the suite that would notice.

  /** An Enemy-shaped victim: `rig.root` and nothing else to resolve through. */
  const makeEnemy = (maxHealth) => ({
    position: new THREE.Vector3(4, 0, -3),
    maxHealth, alive: false, isElite: false, isBoss: false,
    rig: { root: makeCorpse() },
  });

  /** A VFX wired far enough to run `_onKill` headless. The pooled visuals
   *  below the launch gate need a live ctx; `ctx.rng` throwing is the real
   *  probe now that it is installed on the instance rather than declared and
   *  forgotten — the whole kill path is covered by it, not just the launch. */
  const makeVfx = () => {
    const v = new VFX();
    v.ctx = makeCtx();
    v.rings = { spawn() {} };
    v.lights = { flick() {} };
    v._shakeAt = () => {};
    v._hitstop = () => {};
    return v;
  };

  const vfx = makeVfx();
  const victim = makeEnemy(100);
  vfx._onKill({
    victim, source: { position: new THREE.Vector3(0, 0, -3) },
    position: victim.position, isElite: false, isBoss: false,
    overkill: 100, type: 'hit', status: null,
  });
  ok(vfx._launches.length === 1, 'an Enemy-shaped victim resolves and is launched');
  ok(vfx._launches[0]?.obj === victim.rig.root, 'and what was launched is its rig root');
  ok(vfx._launches[0]?.vx > 0, 'thrown away from the source, not toward it');

  // The same event under the threshold must stay put, so the assertion above
  // is testing the gate and not merely that `_onKill` touches `_launches`.
  const quiet = makeVfx();
  const grazed = makeEnemy(100);
  quiet._onKill({
    victim: grazed, source: { position: new THREE.Vector3(0, 0, -3) },
    position: grazed.position, isElite: false, isBoss: false,
    overkill: 1, type: 'hit', status: null,
  });
  ok(quiet._launches.length === 0, 'a kill with nothing left over leaves the body where it fell');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
