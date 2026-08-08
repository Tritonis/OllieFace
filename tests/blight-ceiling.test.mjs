import * as THREE from 'three';
import { Blight, SHIMMER, BAND_SKY, VOID_SKY } from '../src/systems/Blight.js';
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

console.log('per-band sky and fog shift, and byte-for-byte restore');
{
  ok(Array.isArray(BAND_SKY) && BAND_SKY.length === 5 && BAND_SKY[0] === 0 && BAND_SKY[1] === 0, 'bands 0-1 leave the sky alone');
  ok(BAND_SKY[2] < BAND_SKY[3] && BAND_SKY[3] < BAND_SKY[4], 'weight is monotonic in band');

  const ctx = makeCtx();
  const mkC = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  const baseline = {
    zenith: mkC(0x2a3a5e), horizon: mkC(0xc9885a), haze: mkC(0xe8b06a),
    fogColor: mkC(0x8a7a6a), fogDensity: 0.0036,
  };
  const sky = {
    uZenith: { value: baseline.zenith.clone() },
    uHorizon: { value: baseline.horizon.clone() },
    uHaze: { value: baseline.haze.clone() },
  };
  ctx.environment = { biomeBaseline: baseline, skyUniforms: sky };
  ctx.scene = { fog: { color: baseline.fogColor.clone(), density: baseline.fogDensity } };

  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
  for (let i = 0; i < 600; i++) b.update(ctx, 1 / 60);   // 10s >> GRADE_BLEND
  ok(ctx.scene.fog.density > baseline.fogDensity * 1.5, 'band 4 thickens the fog by over half');
  const vf = mkC(VOID_SKY.fog);
  ok(ctx.scene.fog.color.g < baseline.fogColor.g, 'fog colour has moved toward the void');
  ok(Math.abs(sky.uHorizon.value.r - baseline.horizon.r) > 1e-3, 'horizon has left its baseline');
  void vf;

  ctx.events.emit('corruptionBand', { band: 0, prev: 4 });
  for (let i = 0; i < 900; i++) b.update(ctx, 1 / 60);
  ok(sky.uHorizon.value.equals(baseline.horizon), 'horizon restored byte-for-byte');
  ok(sky.uZenith.value.equals(baseline.zenith), 'zenith restored byte-for-byte');
  ok(ctx.scene.fog.color.equals(baseline.fogColor), 'fog colour restored byte-for-byte');
  ok(ctx.scene.fog.density === baseline.fogDensity, 'fog density restored exactly');
}

console.log('rim motes: budgeted, fxRng-only, on the rim, paused-gated');
{
  // Dynamic so a missing export reads as `undefined` here rather than failing
  // the whole module link and taking the suites above down with it.
  const { MOTES } = await import('../src/systems/Blight.js');
  ok(MOTES && MOTES.perPatchPerSecond > 0 && MOTES.maxPatches > 0 && MOTES.range > 0,
     'MOTES budget exported');

  const ctx = makeCtx();
  const emitted = [];
  // makeCtx already carries a real THREE.Scene, so _build produces a real mesh
  // headless and uRadius is the live animated radius the motes must ride.
  ctx.vfx = { particles: { emit: (o) => emitted.push({ x: o.position.x, y: o.position.y, z: o.position.z }) } };
  ctx.stage = { sampleHeight: () => 2 };

  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 5, z: -3, strength: 2 });
  ok(b.patches[0]?.mesh != null, 'the seeded patch built a mesh headless');

  // Two seconds at 60Hz. strength 2 at world 0 puts radiusOf at its target from
  // frame one, so uRadius is constant across the window and the rim band the
  // motes must land in is a fixed annulus.
  for (let i = 0; i < 120; i++) { ctx.time += 1 / 60; b.update(ctx, 1 / 60); }

  const expect = MOTES.perPatchPerSecond * 2;
  ok(emitted.length >= expect * 0.5 && emitted.length <= expect * 1.5,
     `~${expect} motes over 2s (got ${emitted.length})`);

  const r = b.patches[0].mesh.material.uniforms.uRadius.value;
  let offRim = 0, offGround = 0;
  for (const m of emitted) {
    const d = Math.hypot(m.x - 5, m.z + 3);
    if (!(d <= r * 1.01 && d >= r * 0.75)) offRim++;
    if (!(Math.abs(m.y - 2.15) < 0.5)) offGround++;
  }
  ok(emitted.length > 0 && offRim === 0, `every mote sits in the rim band (${offRim} strays)`);
  ok(emitted.length > 0 && offGround === 0, `every mote sits at sampled ground height (${offGround} strays)`);

  // Framerate independence: the same two seconds in 20Hz steps buys the same
  // budget, because emission is accumulator driven rather than per-frame.
  const ctxB = makeCtx();
  const slow = [];
  ctxB.vfx = { particles: { emit: () => slow.push(1) } };
  ctxB.stage = { sampleHeight: () => 2 };
  const b2 = new Blight();
  b2.init(ctxB);
  ctxB.events.emit('blightSeed', { x: 5, z: -3, strength: 2 });
  for (let i = 0; i < 40; i++) { ctxB.time += 1 / 20; b2.update(ctxB, 1 / 20); }
  ok(Math.abs(slow.length - emitted.length) <= 1, `20Hz spends the same budget (${slow.length} vs ${emitted.length})`);

  // No camera at all: still emits. The headless assertions above depend on the
  // cull being skipped rather than defaulting to "cull everything".
  const ctxC = makeCtx();
  const blind = [];
  ctxC.camera = null;
  ctxC.vfx = { particles: { emit: () => blind.push(1) } };
  const b3 = new Blight();
  b3.init(ctxC);
  ctxC.events.emit('blightSeed', { x: 400, z: 400, strength: 2 });
  for (let i = 0; i < 120; i++) { ctxC.time += 1 / 60; b3.update(ctxC, 1 / 60); }
  ok(blind.length > 0, 'no camera means no cull');

  // With a camera, a patch past MOTES.range spends nothing.
  const ctxD = makeCtx();
  const far = [];
  ctxD.vfx = { particles: { emit: () => far.push(1) } };
  const b4 = new Blight();
  b4.init(ctxD);
  ctxD.events.emit('blightSeed', { x: MOTES.range + 200, z: 0, strength: 2 });
  for (let i = 0; i < 120; i++) { ctxD.time += 1 / 60; b4.update(ctxD, 1 / 60); }
  ok(far.length === 0, 'a patch beyond MOTES.range is culled');

  // No vfx subsystem at all must not throw.
  const ctxE = makeCtx();
  const b5 = new Blight();
  b5.init(ctxE);
  ctxE.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  let threw = false;
  try { b5.update(ctxE, 1 / 60); } catch { threw = true; }
  ok(!threw, 'a ctx without vfx never throws');

  const before = emitted.length;
  ctx.paused = true;
  for (let i = 0; i < 60; i++) b.update(ctx, 1 / 60);
  ok(emitted.length === before, 'a paused frame emits nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
