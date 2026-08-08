import * as THREE from 'three';
import { Blight, SHIMMER } from '../src/systems/Blight.js';
import { MASK_UNIFORMS, MAX_MASK } from '../src/shaders/BlightMask.js';
import { shimmerUniforms, MAX_RIMS, SHIMMER_DECL, SHIMMER_APPLY } from '../src/shaders/BlightShimmer.js';
import { GradeShader } from '../src/shaders/GradeShader.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 4242) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
  };
  return r;
}

function makeCtx() {
  const listeners = new Map();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(0, 8, 30);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const ctx = {
    time: 0,
    paused: false,
    fxRng: makeRng(),
    // The tripwire: any gameplay-stream draw explodes the test.
    rng: { next() { throw new Error('ctx.rng drawn from presentation'); },
           range() { throw new Error('ctx.rng drawn from presentation'); } },
    camera,
    // Patches only exist as meshes when there is a scene to hang them on, and
    // both writers read the *animated* radius off the mesh material.
    scene: new THREE.Scene(),
    corruption: { world: 0 },
    pipeline: { passes: { grade: { uniforms: { uSaturation: { value: 1.06 }, ...shimmerUniforms() } } }, vignetteBoost: 0 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  return ctx;
}

console.log('GradeShader carries the shimmer snippet');
{
  ok('uRims' in GradeShader.uniforms && 'uRimCount' in GradeShader.uniforms, 'uniforms merged');
  ok(GradeShader.fragmentShader.includes('rimShimmer'), 'fragment applies the shimmer');
  ok(MAX_RIMS === 4 && shimmerUniforms().uRims.value.length === MAX_RIMS * 4, 'four rim slots');
  ok(shimmerUniforms().uRims !== shimmerUniforms().uRims, 'fresh uniform objects per call');
  ok(SHIMMER_DECL.includes('rimShimmer') && SHIMMER_APPLY.includes('uRimCount > 0'), 'decl/apply pair exported');
}

console.log('Blight writes the mask uniforms from live patches');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  MASK_UNIFORMS.uBlightCount.value = 0;
  for (let i = 0; i < 11; i++) ctx.events.emit('blightSeed', { x: i * 3, z: 0, strength: 1 });
  b.update(ctx, 0.016);
  ok(MASK_UNIFORMS.uBlightCount.value === MAX_MASK, 'count caps at MAX_MASK with 11 live patches');
  const u = MASK_UNIFORMS.uBlightPatches.value;
  ok(u[2] > 0, 'slot 0 carries a positive radius');
  ok(MASK_UNIFORMS.uBlightTime.value === ctx.time, 'time rides ctx.time');
  // Nearest-to-camera wins the slots: seed a far patch and a near one.
  const b2 = new Blight();
  const ctx2 = makeCtx();
  b2.init(ctx2);
  ctx2.events.emit('blightSeed', { x: 500, z: 500, strength: 3 });
  ctx2.events.emit('blightSeed', { x: 0, z: 25, strength: 1 });
  b2.update(ctx2, 0.016);
  const v = MASK_UNIFORMS.uBlightPatches.value;
  ok(Math.abs(v[0] - 0) < 1e-6 && Math.abs(v[1] - 25) < 1e-6, 'nearest patch takes slot 0');
}

console.log('shimmer records: near rims project, inside/far/behind are skipped');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 3 });   // ~28m ahead of camera at z=30
  b.update(ctx, 0.016);
  const g = ctx.pipeline.passes.grade.uniforms;
  ok(g.uRimCount.value === 1, 'one visible rim projected');
  const r = g.uRims.value;
  ok(r[0] > 0 && r[0] < 1 && r[1] > 0 && r[1] < 1, 'rim centre lands in UV space');
  ok(r[2] > 0, 'rim carries a UV radius');
  ok(r[3] > 0 && r[3] <= SHIMMER.strength + 1e-9, 'strength positive and capped');

  // Camera inside the patch: shimmer is an edge phenomenon seen from outside.
  ctx.camera.position.set(0, 2, 1);
  ctx.camera.updateMatrixWorld(true);
  b.update(ctx, 0.016);
  ok(g.uRimCount.value === 0, 'camera inside the patch writes no rim');

  // Far beyond SHIMMER.far: skipped.
  ctx.camera.position.set(0, 8, SHIMMER.far + 60);
  ctx.camera.lookAt(0, 0, 0);
  ctx.camera.updateMatrixWorld(true);
  b.update(ctx, 0.016);
  ok(g.uRimCount.value === 0, 'rim beyond SHIMMER.far writes nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
