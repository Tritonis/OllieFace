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

console.log('the body stays where it landed until the dissolve has taken it');
{
  // The defect this arm exists for: the launch used to retire on ground
  // contact, which dropped the whole `vx*t` offset in the single frame the arc
  // ended. At full power that is a 6.8 m teleport back onto the death spot, at
  // an apparent 400 m/s, while `deathDissolve` (0.85 s) is only three quarters
  // through and the corpse is still on screen. The throw undid itself in the
  // frame it finished.
  const vfx = new VFX();
  const corpse = makeCorpse();
  const home = corpse.position.clone();
  const step = (dt) => { corpse.position.copy(home); vfx._updateLaunches(dt); };
  vfx.corpseLaunch(corpse, 1, 0, 1);

  // Walk to the frame after touchdown and record the reach.
  let landed = 0, reach = 0, spinAtLand = 0;
  for (let i = 0; i < 60 && !landed; i++) {
    step(1 / 60);
    if (vfx._launches[0]?.land) { landed = i + 1; reach = corpse.position.x - home.x; spinAtLand = corpse.rotation.z; }
  }
  ok(landed > 0, `the arc lands (frame ${landed})`);
  ok(reach > 5, `and it has travelled by then (${reach.toFixed(2)}m)`);
  ok(Math.abs(corpse.position.y - home.y) < 1e-9, 'on the ground the owner writes, not under it');

  // The next frame is the one that used to teleport.
  step(1 / 60);
  ok(Math.abs((corpse.position.x - home.x) - reach) < 1e-9,
     'the frame after touchdown holds the landing offset instead of discarding it');

  // And it is still held while the dissolve is running (0.85 s from the kill).
  let heldThroughDissolve = true;
  while (vfx._launches.length && vfx._launches[0].t < 0.85) {
    step(1 / 60);
    if (vfx._launches.length && Math.abs((corpse.position.x - home.x) - reach) > 1e-9) heldThroughDissolve = false;
  }
  ok(heldThroughDissolve, 'and holds it unmoved for every frame the corpse is still visible');
  ok(vfx._launches.length === 1, 'the launch is still alive at the end of the dissolve');
  // The tumble is walked back across the hold rather than snapped at the end.
  // A throw down +x spins about z, so z is the axis that carries it — asserted
  // on the axis that actually moves, because `rotation.x` is identically zero
  // here and would pass this for the wrong reason.
  ok(Math.abs(spinAtLand) > 1, `the body landed mid-tumble (${spinAtLand.toFixed(3)} rad)`);
  const mid = corpse.rotation.z;
  ok(Math.abs(mid) > 1e-6 && Math.abs(mid) < Math.abs(spinAtLand),
     `and the tumble is easing back, not held or snapped (${mid.toFixed(3)} rad)`);

  // ...and it does let go, well before the rig is recycled at DEATH_TIME.
  let monotone = true, prev = Math.abs(mid);
  for (let i = 0; i < 30 && vfx._launches.length; i++) {
    step(1 / 60);
    if (vfx._launches.length) {
      const now = Math.abs(corpse.rotation.z);
      if (now > prev + 1e-9) monotone = false;
      prev = now;
    }
  }
  ok(monotone, 'the ease only ever walks the tumble toward home');
  ok(vfx._launches.length === 0, 'the hold ends of its own accord');
  ok(vfx._launches.length === 0 && LAUNCH.hold < 1.5, 'and ends before the corpse is reaped');
  corpse.position.copy(home);
  corpse.rotation.set(0, 0, 0);
  vfx._updateLaunches(1 / 60);
  ok(corpse.position.equals(home) && corpse.rotation.x === 0 && corpse.rotation.z === 0,
     'a held launch leaves no more residue than a retired one did');
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
