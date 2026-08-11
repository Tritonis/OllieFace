// tests/dissolve-recycle.test.mjs
//
// Two halves of one seam, and they pull against each other.
//
// The dissolve is the signature death read: a hot rim crawls up the corpse and
// takes it. It ends by hiding what is left, because the corpse is reaped at
// DEATH_TIME = 1.5 s (src/entities/Enemy.js:25) but the dissolve finishes at
// 0.85 s (src/systems/VFX.js:786), and a body that snapped back to fully
// opaque for the last 0.65 s would undo the whole effect.
//
// The other half: `d.mesh` is `rig.root`, and rigs are pooled. `Director.clear`
// (src/systems/Director.js:966, run on every stage change) despawns
// immediately regardless of `finished`, which hands the rig straight back to
// `POOL` — so kill something, transition inside 0.85 s, and the dissolve's
// closing `visible = false` lands on a live, damageable monster wearing the
// recycled rig. Nothing sets it back until that monster itself dies
// (`S.DIE.enter`, src/entities/Enemy.js:1776). That is the invisible-enemy
// shape DIAG-invisible-enemies.md hunted for, recorded in its section 5.
//
// This file holds both halves down at once: the effect must finish its corpse,
// and it must never touch a rig that has changed hands. Real rigs from the
// real pool, because the pooling *is* the bug.
import * as THREE from 'three';
import { VFX } from '../src/systems/VFX.js';
import { acquireRig, releaseRig } from '../src/entities/EnemyMeshes.js';
import { Enemy } from '../src/entities/Enemy.js';
import { Combat } from '../src/systems/Combat.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A VFX wired far enough to run `_onKill` and `_updateDissolves` headless. */
function makeVfx() {
  const v = new VFX();
  v.ctx = {
    time: 0,
    // A cosmetic effect may never draw from the simulation stream.
    rng: { next() { throw new Error('ctx.rng drawn from presentation'); },
           range() { throw new Error('ctx.rng drawn from presentation'); } },
    fxRng: { next: () => 0.5, range: (a, b) => (a + b) * 0.5 },
  };
  v.particles = { emitted: 0, emit() { this.emitted++; } };
  v.rings = { spawn() {} };
  v.lights = { flick() {} };
  v._shakeAt = () => {};
  v._hitstop = () => {};
  return v;
}

/** An Enemy-shaped victim: `rig.root` and none of the player's aliases. */
const makeVictim = (rig) => ({
  position: new THREE.Vector3(3, 0, -2),
  maxHealth: 100, alive: false, isElite: false, isBoss: false,
  rig,
});

const kill = (vfx, victim) => vfx._onKill({
  victim, source: null, position: victim.position,
  isElite: false, isBoss: false, overkill: 0, type: 'hit', status: null,
});

const run = (vfx, seconds) => { for (let i = 0; i < Math.round(seconds * 60); i++) vfx._updateDissolves(1 / 60); };

console.log('a kill on an Enemy-shaped victim actually starts a dissolve');
{
  // The half that was dead code for the whole of rounds 1-6: `resolveObject`
  // could not see `rig.root`, so the signature effect never ran on a monster.
  const vfx = makeVfx();
  const rig = acquireRig('mite');
  kill(vfx, makeVictim(rig));
  ok(vfx._dissolving.length === 1, 'the kill registered a dissolve');
  ok(vfx._dissolving[0]?.mesh === rig.root, 'and it is dissolving the rig root');
  ok(vfx._dissolving[0]?.bags.length > 0,
     `and it patched real materials to drive (${vfx._dissolving[0]?.bags.length} bags)`);
  releaseRig(rig);
}

console.log('the dissolve runs the corpse out and takes it');
{
  const vfx = makeVfx();
  const rig = acquireRig('beetle');
  const victim = makeVictim(rig);
  const originals = [];
  rig.root.traverse((c) => { if (c.isMesh) originals.push([c, c.material]); });
  kill(vfx, victim);

  const d = vfx._dissolving[0];
  ok(originals.every(([c, m]) => c.material !== m), 'every mesh is wearing a dissolve variant');

  const track = [];
  // 45 frames = 0.75 s, deliberately short of `dur` (0.85 s): the handle empties
  // `bags` when it retires, so a loop that ran past the end would read off a
  // cleared array rather than measuring the sweep.
  const bag = d.bags[0];
  for (let i = 0; i < 45; i++) { vfx._updateDissolves(1 / 60); track.push(bag.uDissolve.value); }
  ok(track.every((v, i) => i === 0 || v >= track[i - 1]), 'the cut only ever sweeps forward');
  ok(track[10] > 0 && track[10] < 1, `and it is mid-burn at 0.18 s (${track[10].toFixed(3)})`);
  ok(vfx.particles.emitted > 0, `embers peel off the front (${vfx.particles.emitted} emissions)`);

  run(vfx, 0.6);
  ok(vfx._dissolving.length === 0, 'the dissolve retires itself');
  ok(rig.root.visible === false, 'and the corpse is gone before the reaper takes the rig');
  ok(originals.every(([c, m]) => c.material === m), 'the shared materials are handed back intact');
  releaseRig(rig);
}

console.log('a rig that changed hands mid-dissolve is never touched again');
{
  // The trap. Kill, transition inside the dissolve's 0.85 s, let the dissolve
  // finish, and check the monster now wearing that rig.
  const vfx = makeVfx();
  const rig = acquireRig('lemurian');
  const originals = [];
  rig.root.traverse((c) => { if (c.isMesh) originals.push([c, c.material]); });

  kill(vfx, makeVictim(rig));
  run(vfx, 0.2);
  ok(vfx._dissolving.length === 1, 'the dissolve is still mid-burn at 0.2 s');

  // Exactly what `Director.clear` -> `Enemy.despawn` does, followed by the new
  // stage's first spawn: `Enemy.spawn` -> `acquireRig`.
  releaseRig(rig);
  const reused = acquireRig('lemurian');
  ok(reused === rig, 'the pool handed the same rig to the next enemy');
  ok(reused.root.visible === true, 'which starts its life visible');

  run(vfx, 1.2);
  ok(vfx._dissolving.length === 0, 'the dissolve is finished and off the list');
  ok(reused.root.visible === true,
     'the finished dissolve did NOT hide a live, damageable monster');

  // The second invisible path on the same seam, and the quieter one.
  // `resetRig` -> `setAffix(null)` -> `applyMats` only re-dresses the four
  // catalogued slots (body/dark/accent/eye, :725-730); every mesh outside them
  // is still wearing the corpse's dissolve variant, whose `uDissolve` this loop
  // drives to 1 -- i.e. `discard` on every fragment. Those parts of a live
  // monster are gone from the picture just as completely as `visible = false`
  // would have made the whole of it.
  ok(originals.every(([c, m]) => c.material === m),
     'and the living rig is wearing its own shared materials, not a corpse shader');
  releaseRig(reused);
}

console.log('the recycled dissolve lets go at once, not at the end of its clock');
{
  // Holding the entry to term would keep emitting embers at a bounding box on
  // a stage that no longer exists, and keep the pooled material variants out
  // of circulation for the first second of the new fight.
  const vfx = makeVfx();
  const rig = acquireRig('wisp');
  const originals = [];
  rig.root.traverse((c) => { if (c.isMesh) originals.push([c, c.material]); });
  kill(vfx, makeVictim(rig));
  run(vfx, 0.2);
  releaseRig(rig);
  const reused = acquireRig('wisp');
  const before = vfx.particles.emitted;
  vfx._updateDissolves(1 / 60);
  ok(vfx._dissolving.length === 0, 'the entry is dropped on the first frame after the handover');
  ok(vfx.particles.emitted === before, 'and emits nothing on its way out');
  ok(originals.every(([c, m]) => c.material === m),
     'the corpse shaders are off the live rig within one frame, not 0.65 s later');
  releaseRig(reused);
}

console.log('the guard is a token on the rig, not a guess about the object');
{
  // A dissolve on something that is not a pooled rig - the player mesh, a prop
  // - has no token on either side, and must behave exactly as it always did.
  const vfx = makeVfx();
  const loose = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial());
  loose.add(m);
  vfx.deathDissolve(loose);
  ok(vfx._dissolving.length === 1, 'a plain Object3D still dissolves');
  run(vfx, 1.0);
  ok(loose.visible === false, 'and is still hidden at the end');
}

console.log('the dissolve survives the blow that caused it');
{
  /* The defect that made this effect invisible in the shipped game, and it is
   * not the one DIAG section 5 recorded.
   *
   * Every hit sets `flashT = FLASH_TIME` (src/entities/Enemy.js:432), and
   * `updateRig` re-derives the flash from it every frame
   * (:1370) -- so on the killing blow the body, dark, accent and eye meshes are
   * all wearing the shared white `FLASH` material. `Combat._kill` runs
   * `onDeath()` and *then* emits `kill` (src/systems/Combat.js:608-610), which
   * is what builds the dissolve. Built over `FLASH`, the dissolve was pulled
   * straight back off by the next `setFlash(false)`, whose restore path
   * re-dresses exactly those four slots from `rig.mats`
   * (src/entities/EnemyMeshes.js:735). What was left dissolving was the crumble
   * debris and nothing else: measured on a hulk at seed 1337 on the GPU path,
   * the corpse held an unchanging 2,081 px with `uDissolve` driven from 0 to 5
   * (reviews/round7/dissolve/probe-dissolve.mjs).
   *
   * Real Enemy, real Combat, real rig, real kill event. */
  const rng = (() => { let n = 12345 >>> 0;
    const r = { next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
                range(a, b) { return a + r.next() * (b - a); },
                pick(a) { return a[Math.floor(r.next() * a.length)]; } };
    return r; })();

  const vfx = makeVfx();
  const ctx = {
    rng, fxRng: vfx.ctx.fxRng, time: 0, authority: true,
    scene: new THREE.Scene(),
    events: { emit(name, p) { if (name === 'kill') vfx._onKill(p); }, on() {} },
  };
  vfx.ctx.rng = rng;
  const combat = new Combat();
  combat.init(ctx);
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
  };
  ctx.player = player;
  const roster = new Roster();
  roster.init(ctx);
  roster.add(player);
  ctx.roster = roster;

  const card = ENEMIES.find((e) => e.id === 'beetle') ?? ENEMIES[0];
  const e = new Enemy();
  e.spawn(ctx, card, new THREE.Vector3(0, 0, 6), {});
  const rig = e.rig;
  const slots = [...rig.body, ...rig.dark, ...rig.accent, ...rig.eye];
  ok(slots.length > 0, `the rig has ${slots.length} meshes in the four re-dressed slots`);

  // A graze first, so the unit is already mid-flash when the killing blow
  // lands. Without this the arm can pass on an enemy that was never flashing.
  combat.applyDamage(e, 1, { source: player, position: player.position.clone(), type: 'hit' });
  e.update(ctx, 1 / 60);
  ok(rig.flashing === true, 'the graze put the rig in its hit flash');

  combat.applyDamage(e, e.maxHealth * 5, { source: player, position: player.position.clone(), type: 'hit' });
  ok(vfx._dissolving.length === 1, 'the kill built a dissolve');
  ok(rig.flashing === false, 'and the corpse is no longer flashing');
  ok(slots.every((m) => m.material?.userData?.dissolveUniforms),
     'every re-dressed slot is wearing a dissolve variant at the moment it is built');

  // Now run the frames the flash used to survive into. `FLASH_TIME` is well
  // under the dissolve's 0.85 s, so this is the window the effect died in.
  for (let i = 0; i < 30; i++) { e.fixedUpdate(ctx, 1 / 60); e.update(ctx, 1 / 60); vfx._updateDissolves(1 / 60); ctx.time += 1 / 60; }
  ok(rig.flashing === false, 'nothing re-flashes a corpse');
  ok(slots.every((m) => m.material?.userData?.dissolveUniforms),
     'and the body is still dissolving half a second later, not re-dressed out of it');
  ok(vfx._dissolving[0]?.bags[0].uDissolve.value > 0.4,
     `the burn is well past half (${vfx._dissolving[0]?.bags[0].uDissolve.value.toFixed(3)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
