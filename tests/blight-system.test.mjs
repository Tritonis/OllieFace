import * as THREE from 'three';
import { Blight, radiusOf, RADIUS, MAX_PATCHES, buildPatchGeometry, makeBlightMaterial, GROW_RATE, BAND_GRADE, GRADE_BLEND } from '../src/systems/Blight.js';

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
  const ctx = {
    fxRng: makeRng(),
    corruption: { world: 0 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  return ctx;
}

console.log('radiusOf is monotonic in both inputs and capped');
{
  ok(radiusOf(1, 0) === RADIUS.base + RADIUS.perStrength, 'strength-1 seed at zero world');
  ok(radiusOf(3, 0) > radiusOf(1, 0), 'stronger seeds start bigger');
  ok(radiusOf(1, 100) > radiusOf(1, 10), 'world corruption grows every patch');
  ok(radiusOf(3, 10000) === RADIUS.cap, 'cap holds');
}

console.log('seeds become patch records via the event');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  ok(ctx.blight === b, 'init claims ctx.blight');
  ctx.events.emit('blightSeed', { x: 4, z: -9, strength: 2 });
  ok(b.patches.length === 1, 'one patch');
  const p = b.patches[0];
  ok(p.x === 4 && p.z === -9 && p.strength === 2, 'position and strength carried');
  ok(p.seedNoise >= 0 && p.seedNoise < 100, 'per-patch cosmetic noise drawn from fxRng');
  ok(p.maxR === RADIUS.cap, 'max radius reserved for growth headroom');
}

console.log('the patch list is capped and clears on stageStart');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  for (let i = 0; i < MAX_PATCHES + 20; i++) ctx.events.emit('blightSeed', { x: i, z: 0, strength: 1 });
  ok(b.patches.length === MAX_PATCHES, `capped at ${MAX_PATCHES}`);
  ok(b.patches[0].x === 20, 'oldest patches dropped first');
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  ok(b.patches.length === 0, 'a new stage starts clean');
}

console.log('a malformed seed is dropped rather than built');
{
  // A NaN x builds a NaN bounding sphere (never culled) and a NaN uRadius,
  // which disables the shader's radius discard — and none of it throws, so
  // nothing else would ever surface it.
  const ctx = makeCtx();
  ctx.scene = new THREE.Scene();
  ctx.stage = { sampleHeight: () => 0 };
  const b = new Blight();
  b.init(ctx);
  const junk = [
    ['NaN x', { x: NaN, z: 0, strength: 1 }],
    ['Infinity z', { x: 0, z: Infinity, strength: 1 }],
    ['NaN strength', { x: 0, z: 0, strength: NaN }],
    ['negative strength', { x: 0, z: 0, strength: -3 }],
    ['zero strength', { x: 0, z: 0, strength: 0 }],
    ['no fields', {}],
    ['no payload', undefined],
  ];
  let threw = null;
  for (const [name, payload] of junk) {
    try { ctx.events.emit('blightSeed', payload); } catch (e) { threw = `${name}: ${e.message}`; }
  }
  ok(threw === null, `no malformed payload throws (${threw || 'none'})`);
  ok(b.patches.length === 0, 'and none of them became a patch');
  ok(ctx.scene.children.length === 0, 'so no mesh reached the scene');

  // The guard rejects, it does not clamp: a good seed either side still lands.
  ctx.events.emit('blightSeed', { x: 3, z: 3, strength: 1 });
  ok(b.patches.length === 1, 'a well-formed seed still builds');
  ok(Number.isFinite(b.patches[0].mesh.material.uniforms.uRadius.value), 'with a finite radius');

  // Same family: a bandless corruptionBand must not write undefined into uBand.
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
  ctx.events.emit('corruptionBand', {});
  ok(b.band === 4, 'a bandless corruptionBand leaves the last good band standing');
}

console.log('band tracking follows corruptionBand');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  ok(b.band === 0, 'starts Pristine');
  ctx.events.emit('corruptionBand', { band: 3, prev: 2 });
  ok(b.band === 3, 'adopts the event band');
}

console.log('patch geometry conforms to the heightfield');
{
  const slope = (x, z) => x * 0.5;                       // a plane tilted in x
  const geo = buildPatchGeometry(10, 0, 6, slope);
  const pos = geo.getAttribute('position');
  let okConform = true;
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i), wy = pos.getY(i);
    if (Math.abs(wy - (wx * 0.5 + 0.06)) > 1e-4) { okConform = false; break; }
  }
  ok(okConform, 'every vertex sits 0.06 above the sampled terrain');
  ok(pos.count > 32, 'enough vertices to bend over terrain');
  geo.dispose();
}

console.log('the patch pools on ground and tears loose where the ground drops away');
{
  // `aTear` is the headless half of the cliff-curtain fix: the shader fades by
  // it, but whether it is 0 or 1 in the right places is decided at build time
  // and is testable against a synthetic heightfield.
  const tearsOf = (geo) => geo.getAttribute('aTear');

  // 1. Flat ground, and the tilted plane the drape check already uses: nothing
  //    tears. A patch on ground a player walks must be exactly as solid as it
  //    was before this attribute existed.
  for (const [name, h] of [['flat', () => 0], ['gentle plane (slope 0.5)', (x) => x * 0.5],
                           ['the measured 0.71 hillside', (x) => x * 0.71]]) {
    const geo = buildPatchGeometry(0, 0, 7, h);
    const t = tearsOf(geo);
    let max = 0;
    for (let i = 0; i < t.count; i++) max = Math.max(max, t.getX(i));
    ok(max === 0, `${name}: no vertex tears (max ${max})`);
    geo.dispose();
  }

  // 2. A cliff: flat at 0 west of the step, flat at 12 east of it. Same drape,
  //    but the ring that spans the step is a vertical sheet. The step sits off
  //    the vertex grid so no vertex is sampled exactly on the discontinuity,
  //    where float32 rounding of x would decide which shelf it is on.
  const CLIFF_X = 10.37, DROP = 12;
  const cliff = (x) => (x < CLIFF_X ? 0 : DROP);
  const geo = buildPatchGeometry(10, 0, 7, cliff);
  const pos = geo.getAttribute('position');
  const t = tearsOf(geo);
  ok(t !== undefined && t.count === pos.count, 'every vertex carries a tear value');

  let maxFar = 0, farN = 0, spanning = 0, offCliffMax = 0;
  for (let i = 0; i < t.count; i++) {
    const dx = Math.abs(pos.getX(i) - CLIFF_X);
    const v = t.getX(i);
    // Ring pitch is 0.7 m and the widest angular chord is ~1.8 m, so beyond
    // 2.5 m from the step every neighbour is on the same shelf.
    if (dx > 2.5) { farN++; maxFar = Math.max(maxFar, v); }
    if (v > 0.999) spanning++;
    offCliffMax = Math.max(offCliffMax, v);
  }
  ok(farN > 40, `enough vertices sit well clear of the step (${farN})`);
  ok(maxFar === 0, `ground away from the drop stays fully painted (max tear ${maxFar})`);
  ok(offCliffMax === 1, 'the steepest spans are fully dissolved, not merely dimmed');
  ok(spanning > 8, `the whole span across the drop lets go, not one vertex (${spanning})`);

  // 3. The drape itself is untouched — this fix hides spans, it does not move
  //    geometry, so the conformance guarantee above still holds on a cliff.
  let conforms = true;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getY(i) - (cliff(pos.getX(i)) + 0.06)) > 1e-4) { conforms = false; break; }
  }
  ok(conforms, 'vertices still sit 0.06 above the heightfield, cliff or not');
  geo.dispose();
}

console.log('the material exposes the animation contract');
{
  const m = makeBlightMaterial();
  ok(m.isShaderMaterial === true, 'ShaderMaterial, per the Decals precedent');
  for (const u of ['uTime', 'uRadius', 'uMaxR', 'uNoise', 'uBand']) {
    ok(m.uniforms[u] !== undefined, `uniform ${u} present`);
  }
  ok(m.transparent === true && m.depthWrite === false, 'blends over terrain without z-fighting the fill');
  m.dispose();
}

console.log('meshes attach on build and detach on stage clear');
{
  const ctx = makeCtx();
  ctx.scene = new THREE.Scene();
  ctx.stage = { sampleHeight: () => 0 };
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 1 });
  ok(b.patches[0].mesh !== null, 'patch built a mesh');
  ok(ctx.scene.children.includes(b.patches[0].mesh), 'mesh is in the scene');
  ctx.events.emit('stageStart', { index: 1, name: 'n' });
  ok(ctx.scene.children.length === 0, 'stage clear detached it');
}

console.log('no scene, no crash');
{
  const ctx = makeCtx();                                  // no scene, no stage
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 1, z: 1, strength: 1 });
  ok(b.patches.length === 1, 'registry still records the seed');
  ok(b.patches[0].mesh === null, 'and simply skips the mesh');
}

console.log('update grows patches toward their target and never shrinks them');
{
  const ctx = makeCtx();
  ctx.scene = new THREE.Scene();
  ctx.stage = { sampleHeight: () => 0 };
  ctx.time = 0;
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 1 });
  const u = b.patches[0].mesh.material.uniforms;
  const r0 = u.uRadius.value;
  ctx.corruption.world = 200;                     // target leaps to the cap
  ctx.time = 0.5; b.update(ctx, 0.5);
  ok(u.uRadius.value > r0, 'radius grew');
  ok(u.uRadius.value <= r0 + GROW_RATE * 0.5 + 1e-9, 'growth is rate-limited, not a snap');
  ctx.corruption.world = 0;                       // gauge bled down (future cleansing)
  const r1 = u.uRadius.value;
  ctx.time = 1.0; b.update(ctx, 0.5);
  ok(u.uRadius.value === r1, 'the scar never shrinks');
  ok(u.uTime.value === 1.0, 'uTime tracks ctx.time');
  ctx.events.emit('corruptionBand', { band: 4, prev: 3 });
  b.update(ctx, 0.016);
  ok(u.uBand.value === 4, 'uBand tracks the band');
}

console.log('growth freezes while the game is paused');
{
  // `update` runs every frame regardless of ctx.paused, so the gate has to be
  // in here — otherwise the spread finishes behind an open menu while the
  // crawl animation (which rides the frozen ctx.time) stands still.
  const ctx = makeCtx();
  ctx.scene = new THREE.Scene();
  ctx.stage = { sampleHeight: () => 0 };
  ctx.time = 0;
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 1 });
  ctx.corruption.world = 200;                     // target leaps to the cap
  const u = b.patches[0].mesh.material.uniforms;
  const r0 = u.uRadius.value;
  ctx.paused = true;
  for (let i = 0; i < 60; i++) b.update(ctx, 0.5);   // 30 s of menu
  ok(u.uRadius.value === r0, 'a paused patch does not spread');
  ctx.paused = false;
  b.update(ctx, 0.5);
  ok(u.uRadius.value > r0, 'and picks up again on unpause');
}

console.log('band grading offsets the pipeline baseline, blended over time');
{
  const ctx = makeCtx();
  ctx.time = 0;
  ctx.pipeline = {
    vignetteBoost: 0,
    passes: { grade: { uniforms: { uSaturation: { value: 1.0 }, uVignette: { value: 0.16 } } } },
  };
  const b = new Blight();
  b.init(ctx);
  b.update(ctx, 0.016);
  ok(ctx.pipeline.passes.grade.uniforms.uSaturation.value === 1.0, 'band 0 changes nothing');
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
  b.update(ctx, 0.5);
  const mid = ctx.pipeline.passes.grade.uniforms.uSaturation.value;
  ok(mid < 1.0 && mid > 1.0 + BAND_GRADE[4].sat, 'saturation easing down, not snapped');
  for (let i = 0; i < 20; i++) b.update(ctx, 0.5);
  const settled = ctx.pipeline.passes.grade.uniforms.uSaturation.value;
  ok(Math.abs(settled - (1.0 + BAND_GRADE[4].sat)) < 1e-3, 'settles on baseline + offset');
  ok(Math.abs(ctx.pipeline.vignetteBoost - BAND_GRADE[4].vignette) < 1e-3, 'vignette rides along');
  ok(ctx.pipeline.passes.grade.uniforms.uVignette.value === 0.16, 'unrelated grade uniforms untouched');
  ctx.events.emit('corruptionBand', { band: 0, prev: 4 });
  for (let i = 0; i < 20; i++) b.update(ctx, 0.5);
  ok(ctx.pipeline.passes.grade.uniforms.uSaturation.value === 1.0, 'band 0 restores the baseline exactly');
}

console.log('the vignette write is a floor, so transients from other systems survive');
{
  const ctx = makeCtx();
  ctx.time = 0;
  ctx.pipeline = { vignetteBoost: 0, passes: { grade: { uniforms: { uSaturation: { value: 1.0 } } } } };
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
  for (let i = 0; i < 20; i++) b.update(ctx, GRADE_BLEND);
  ctx.pipeline.vignetteBoost = 0.9;                 // VFX's death spike, written absolutely
  b.update(ctx, 0.016);
  ok(ctx.pipeline.vignetteBoost === 0.9, 'a bigger transient is not stomped back to the band floor');
  // Two frames, not one: Blight can put its *own* level back when nothing else
  // has written, so the invariant is only really pinned by a frame that runs
  // after Blight has already seen the foreign value once. A version that
  // records the channel's value instead of its own passes frame 1 and retracts
  // VFX's spike on frame 2.
  b.update(ctx, 0.016);
  ok(ctx.pipeline.vignetteBoost === 0.9, 'and it is still not stomped a frame later');
  ctx.pipeline.vignetteBoost = 0;                   // the pipeline damped it away
  b.update(ctx, 0.016);
  ok(Math.abs(ctx.pipeline.vignetteBoost - BAND_GRADE[4].vignette) < 1e-3, 'the band floor is re-asserted every frame');
  ctx.events.emit('corruptionBand', { band: 0, prev: 4 });
  for (let i = 0; i < 20; i++) b.update(ctx, GRADE_BLEND);
  ctx.pipeline.vignetteBoost = 0;
  b.update(ctx, 0.016);
  ok(ctx.pipeline.vignetteBoost === 0, 'band 0 stops holding the vignette up at all');
}

console.log('no pipeline, no crash');
{
  const ctx = makeCtx();
  ctx.time = 0;
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('corruptionBand', { band: 3, prev: 0 });
  b.update(ctx, 0.016);
  ok(b.band === 3, 'headless update survives a pipeline-less ctx');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
