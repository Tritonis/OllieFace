# Blight Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The blight looks incredible or the hook doesn't exist — the world *inside* a blight patch corrupts (ground and props take void material variants with emissive veins), the sky and fog sicken per band, the patch edge breathes particulate and shimmer, and the corruption gets a voice. Phase 3 slice 1 of the launch design (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md` §3 workstream 1, plus the §1 world-state audio layer that Phase 1 deferred).

**Phase 3 slice split** (this plan is slice 1): 1. blight ceiling (this plan) · 2. readability gate + combat juice (silhouette gate, hitstop, corpse launch, kill VFX, damage-type sparks) · 3. diegetic UI treatment · 4. shot library / trailer pipeline formalization. Slices 2–4 get their own plans.

**Architecture:** A shared shader chunk (`src/shaders/BlightMask.js`) is injected into every cached stage material via `onBeforeCompile`, driven by one shared uniform set that `Blight` writes per frame with the 8 nearest live patches — so terrain and every instanced prop inside a patch radius shades as its own void-corrupted variant with no material duplication and no per-biome program fork. `Blight` also grows three new expressions: per-band sky/fog interpolation against a baseline `Environment.applyBiome` now records, rim motes through `ctx.vfx.particles`, and up-to-4 screen-projected rim shimmer records into a new GradeShader snippet (same pattern as `DistortShader`). `Audio` gains a band-keyed void layer on the ambient bus.

**Tech Stack:** three.js `onBeforeCompile` injection (following `RimStandardMaterial`, `src/entities/CharacterMesh.js:283`), GradeShader snippet composition (following `src/shaders/DistortShader.js`), WebAudio node graph (following the drone block, `src/systems/Audio.js:384-411`).

## Global Constraints

- **Zero `ctx.rng` draws anywhere in this plan.** All variation is `ctx.fxRng` or WebAudio-local noise (`NETCODE.md`: cosmetic draws must never advance the shared stream). Tests probe this with a throwing `ctx.rng`.
- One-way rule: Corruption emits, presentation listens. Nothing in gameplay may read blight/mask/sky state.
- Systems never import each other (`CONTRACTS.md`). Blight reaches VFX only as `ctx.vfx`, Environment only as `ctx.environment`, the pipeline only as `ctx.pipeline`. Importing from `src/shaders/` and `src/fx/ParticleSystem.js`'s `FRAME` constant is data/module reuse, not a system import (existing precedent: Blight already imports `three` + `MathUtil`; VFX imports `FRAME`).
- Missing subsystems never throw: no `ctx.vfx` → no motes; no `ctx.environment.biomeBaseline` → no sky shift; no `passes.grade.uniforms.uRimCount` → no shimmer; headless ctx with no scene stays inert. Guard with `?.`.
- Every value that reads as tuning lives in exported constants so tests pin behaviour and designers turn dials.
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code, LCG fixture — same shape as `tests/blight-system.test.mjs`. three.js constructs materials headless; no GL compile is attempted in tests.
- sp-equivalence and existing test suites stay green. Baselines regenerated only in Task 7, named and committed per the repo's baseline-capture convention (the on-disk source of any before/after number must be committed).
- Palette continuity: all void colours derive from the Blight patch shader family (`src/systems/Blight.js:121-125`) — `#1b0c26 / #2b1340` fills, `#7a46c8 / #b64ad0` veins, `#c8379b` rim. Sky/fog hexes below are authored sRGB and converted with `.convertSRGBToLinear()` exactly as `Environment.applyBiome` does (`src/world/Environment.js:367-369`).
- Bash tool is ASCII-only in this environment; any file content with non-ASCII goes through Write/Edit, never heredocs.

---

### Task 1: BlightMask shader chunk — shared uniforms, GLSL, material attach

**Files:**
- Create: `src/shaders/BlightMask.js`
- Test: `tests/blight-mask.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (later tasks rely on these exact names):
  - `MAX_MASK = 8` — patch slots.
  - `MASK_UNIFORMS` — the **shared singleton** uniform object `{ uBlightCount, uBlightPatches, uBlightTime, uBlightBand }`. One writer (Blight, Task 3), many reader programs. `uBlightPatches` is a flat array of `MAX_MASK * 4` numbers: `x, z, radius, phase` per patch.
  - `attachBlightMask(material) -> material` — chains onto any existing `onBeforeCompile` (the cached stage materials already carry `attachDetail` hooks) and appends `|blightmask` to `customProgramCacheKey`.

- [ ] **Step 1: Write the failing test**

```js
// tests/blight-mask.test.mjs
import * as THREE from 'three';
import { MAX_MASK, MASK_UNIFORMS, attachBlightMask } from '../src/shaders/BlightMask.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('shared uniform contract');
{
  ok(MAX_MASK === 8, 'eight patch slots');
  ok(MASK_UNIFORMS.uBlightPatches.value.length === MAX_MASK * 4, 'flat vec4 array sized to MAX_MASK');
  ok(MASK_UNIFORMS.uBlightCount.value === 0, 'count starts at zero');
  ok(typeof MASK_UNIFORMS.uBlightTime.value === 'number', 'time uniform is scalar');
  ok(typeof MASK_UNIFORMS.uBlightBand.value === 'number', 'band uniform is scalar');
}

console.log('attach injects into a standard-material shader and chains');
{
  const mat = new THREE.MeshStandardMaterial();
  let prevRan = false;
  mat.onBeforeCompile = () => { prevRan = true; };
  attachBlightMask(mat);
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <emissivemap_fragment>\n}',
  };
  mat.onBeforeCompile(shader, null);
  ok(prevRan, 'pre-existing onBeforeCompile still runs');
  ok(shader.uniforms.uBlightPatches === MASK_UNIFORMS.uBlightPatches, 'program shares the singleton uniform objects');
  ok(shader.vertexShader.includes('vBlightWorld'), 'vertex carries the world-position varying');
  ok(shader.vertexShader.includes('USE_INSTANCING'), 'instanced props resolve their own world position');
  ok(shader.fragmentShader.includes('blightMask('), 'fragment declares the mask function');
  ok(shader.fragmentShader.indexOf('blightMask(') < shader.fragmentShader.indexOf('diffuseColor.rgb = mix'), 'decl precedes use');
  ok(shader.fragmentShader.includes('uBlightCount > 0'), 'zero-patch frames skip the whole block');
  ok(mat.customProgramCacheKey().includes('blightmask'), 'program cache key forks for patched materials');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/blight-mask.test.mjs`
Expected: FAIL — cannot find module `../src/shaders/BlightMask.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/shaders/BlightMask.js
/**
 * The corrupted-variant pass: one shader chunk, injected into every cached
 * stage material, that re-shades any fragment lying inside a live blight
 * patch — terrain, boulders, ruins, wood, crystal alike become their own
 * void-warped variant. This is what "corrupted material variants per biome
 * palette" costs when the materials are a shared cached library: nothing is
 * duplicated, the biome palette stays the base layer, and the corruption is
 * a function applied on top of whatever the biome put there.
 *
 * One shared uniform set drives every patched program (three.js uploads
 * uniform *objects* by reference, so a single writer updates all readers).
 * Blight (src/systems/Blight.js) is the only writer.
 *
 * Colours are GLSL constants in linear space, the same ACES-solved family the
 * patch shader documents at src/systems/Blight.js:94-110 — the ground inside
 * a patch and the patch itself must land in one palette on screen.
 */
export const MAX_MASK = 8;

export const MASK_UNIFORMS = {
  uBlightCount: { value: 0 },
  // x, z, radius (current, not cap), phase — phase is the patch's seedNoise so
  // the ragged edge here chews in the same rhythm as the patch's own rim.
  uBlightPatches: { value: Array.from({ length: MAX_MASK }, () => [0, 0, 0, 0]).flat() },
  uBlightTime: { value: 0 },
  uBlightBand: { value: 0 },
};

/** Fragment declarations — goes after `#include <common>`. */
export const MASK_DECL = /* glsl */ `
uniform int uBlightCount;
uniform vec4 uBlightPatches[${MAX_MASK}];
uniform float uBlightTime;
uniform float uBlightBand;
varying vec3 vBlightWorld;

// Same hash/noise family as the patch shader, prefixed to dodge collisions
// with chunks other hooks may have injected into this program.
float bmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bmNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bmHash(i), bmHash(i + vec2(1.0, 0.0)), f.x),
             mix(bmHash(i + vec2(0.0, 1.0)), bmHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float bmFbm(vec2 p) {
  return (bmNoise(p) * 0.5 + bmNoise(p * 2.03 + vec2(17.3, 5.1)) * 0.25
        + bmNoise(p * 4.11 + vec2(41.7, 23.9)) * 0.125) / 0.875;
}

// Coverage in [0,1]: 0 outside every patch, 1 deep inside the nearest one.
// The edge chews inward by an animated per-angle bite like the patch's own
// rim (an approximation of it, not a byte-match — the two noises live in
// different domains; at the 0.72 feather width the residue is invisible).
float blightMask(vec3 wp) {
  float m = 0.0;
  for (int i = 0; i < ${MAX_MASK}; i++) {
    if (i >= uBlightCount) break;
    vec4 p = uBlightPatches[i];
    if (p.z <= 0.0) continue;
    vec2 d2 = wp.xz - p.xy;
    float d = length(d2);
    float ang = atan(d2.y, d2.x);
    float bite = bmNoise(vec2(ang * 2.55, (uBlightTime + p.w) * 0.35)) * 0.10;
    float edge = p.z * (1.0 - bite);
    m = max(m, smoothstep(edge, edge * 0.72, d));
  }
  return m;
}
`;

/** Fragment application — goes after `#include <emissivemap_fragment>`,
 *  where `diffuseColor` and `totalEmissiveRadiance` both exist and lighting
 *  has not yet consumed either (same anchor RimStandardMaterial uses). */
export const MASK_APPLY = /* glsl */ `
if (uBlightCount > 0) {
  float bm = blightMask(vBlightWorld);
  if (bm > 0.001) {
    // Linear-space void family (see file header): fill #2b1340, vein #7a46c8.
    const vec3 BM_TINT = vec3(0.0419, 0.0166, 0.0665);
    const vec3 BM_VEIN = vec3(0.1522, 0.0640, 0.5040);
    vec2 bp = vBlightWorld.xz;
    // The patch shader's own domain-warped filament field, at the same
    // frequencies, so veins on a boulder continue the veins on the ground
    // under it instead of starting a second pattern.
    vec2 bw = vec2(bmFbm(bp * 0.30 + vec2(0.0, uBlightTime * 0.060)),
                   bmFbm(bp * 0.30 + vec2(4.7, -uBlightTime * 0.045)));
    float bn = bmFbm(bp * 0.55 + (bw - 0.5) * 2.6);
    float vein = smoothstep(0.045, 0.006, abs(bn - 0.5)) * bm;
    diffuseColor.rgb = mix(diffuseColor.rgb, BM_TINT, bm * 0.80);
    totalEmissiveRadiance += BM_VEIN * vein * (0.35 + 0.10 * uBlightBand);
  }
}
`;

const VERT_VARYING = /* glsl */ `#include <common>
varying vec3 vBlightWorld;`;

// `transformed` exists after begin_vertex; project_vertex has already folded
// instanceMatrix into mvPosition but does not expose a world position, so the
// chunk rebuilds it — including the instance transform, or every boulder in an
// instanced batch would corrupt by the *batch* origin instead of its own.
const VERT_WORLD = /* glsl */ `#include <project_vertex>
{
  vec4 bwp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    bwp = instanceMatrix * bwp;
  #endif
  vBlightWorld = (modelMatrix * bwp).xyz;
}`;

/**
 * Patch one material. Chains any hook already installed (the material library
 * attaches detail maps through onBeforeCompile — clobbering that would strip
 * the metre-scale identity pass off every surface in the game).
 */
export function attachBlightMask(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, MASK_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_VARYING)
      .replace('#include <project_vertex>', VERT_WORLD);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + MASK_DECL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + MASK_APPLY);
  };
  const prevKey = typeof material.customProgramCacheKey === 'function'
    ? material.customProgramCacheKey.bind(material) : null;
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|blightmask';
  return material;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/blight-mask.test.mjs`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shaders/BlightMask.js tests/blight-mask.test.mjs
git commit -m "One chunk to corrupt them all: the void variant is a function over any material"
```

---

### Task 2: Patch the material library

**Files:**
- Modify: `src/world/Materials.js` (end of `buildMaterials`, around line 1024-1028)
- Test: extend `tests/blight-mask.test.mjs`

**Interfaces:**
- Consumes: `attachBlightMask` (Task 1).
- Produces: every material returned by `getMaterials()` carries the mask hook — terrain, rock, cliff, moss, wetStone, metalRuin, sand, wood, crystal. Props and terrain both draw from this cache (`src/world/Props.js`, `src/world/TerrainGen.js`), so "void-warped prop swaps" costs exactly this loop.

- [ ] **Step 1: Write the failing test** — append to `tests/blight-mask.test.mjs` before the exit lines:

```js
console.log('the whole material library is patched');
{
  const { getMaterials } = await import('../src/world/Materials.js');
  const mats = getMaterials();
  const names = ['terrain', 'rock', 'cliff', 'moss', 'wetStone', 'metalRuin', 'sand', 'wood', 'crystal'];
  for (const n of names) {
    ok(typeof mats[n]?.customProgramCacheKey === 'function'
       && mats[n].customProgramCacheKey().includes('blightmask'), `${n} carries the mask`);
  }
}
```

If `getMaterials()` needs a DOM canvas headless (texture synthesis draws to canvas), and the import throws in node, wrap in try/catch and assert instead on `buildMaterials` being unreachable headless — check first: `node -e "import('./src/world/Materials.js').then(m => m.getMaterials())"`. If headless import is impossible, replace this test block with one that greps the source: read `src/world/Materials.js` with `fs.readFileSync` and assert it contains `attachBlightMask(` applied over the nine names (string containment on the loop line below). Either way the assertion must run and fail before the change.

- [ ] **Step 2: Run to verify the new block fails**

Run: `node tests/blight-mask.test.mjs`
Expected: the new assertions FAIL; earlier blocks still pass.

- [ ] **Step 3: Implement** — in `src/world/Materials.js`, import at top:

```js
import { attachBlightMask } from '../shaders/BlightMask.js';
```

and at the end of `buildMaterials` (after the `attachDetail` loop at line 1024-1026, before `return`):

```js
  // The void's claim on every surface. After attachDetail, so the hook chain
  // runs detail first and corruption last — the mask re-shades the detailed
  // fragment, not the other way round.
  const lib = { terrain, rock, cliff, moss, wetStone, metalRuin, sand, wood, crystal };
  for (const k in lib) attachBlightMask(lib[k]);

  return lib;
```

(This replaces the existing `return { terrain, rock, ... }` object literal — same nine keys, byte-identical set.)

- [ ] **Step 4: Run tests**

Run: `node tests/blight-mask.test.mjs` — PASS. Then `npm test` — everything green (the hook is inert until a patch writes `uBlightCount`).

- [ ] **Step 5: Commit**

```bash
git add src/world/Materials.js tests/blight-mask.test.mjs
git commit -m "Nine materials learn a tenth state: everything the library builds can sicken"
```

---

### Task 3: Blight drives the mask and the rim shimmer

**Files:**
- Create: `src/shaders/BlightShimmer.js`
- Modify: `src/shaders/GradeShader.js` (uniforms spread + two GLSL insertions)
- Modify: `src/systems/Blight.js` (`update` gains `_mask` and `_shimmer`)
- Test: `tests/blight-ceiling.test.mjs`

**Interfaces:**
- Consumes: `MASK_UNIFORMS`, `MAX_MASK` (Task 1); `ctx.camera`, `ctx.pipeline.passes.grade.uniforms`.
- Produces:
  - `BlightShimmer.js` exports `MAX_RIMS = 4`, `shimmerUniforms()` (fresh objects per call, like `distortUniforms`), `SHIMMER_DECL`, `SHIMMER_APPLY`.
  - `Blight` exports `SHIMMER = { near: 14, far: 55, strength: 0.0055 }`.
  - GradeShader carries `uRimCount / uRims / uRimAspect`.

- [ ] **Step 1: Write the failing test**

```js
// tests/blight-ceiling.test.mjs
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/blight-ceiling.test.mjs`
Expected: FAIL — no `BlightShimmer.js`, `SHIMMER` not exported.

- [ ] **Step 3: Implement `src/shaders/BlightShimmer.js`**

```js
// src/shaders/BlightShimmer.js
/**
 * Blight rim shimmer — the "refraction" of the crawling edge, priced the way
 * DistortShader prices the blast shockwave: as a snippet composed into
 * GradeShader, which already taps the frame, so the layer costs zero extra
 * fullscreen reads. Records are (screenU, screenV, uvRadius, strength),
 * written per frame by Blight from the patches nearest the camera.
 *
 * Unlike the blast shell this is a standing effect, so the displacement
 * oscillates along the ring instead of pushing one way — heat-haze over a
 * wound in the ground, not a lens.
 */
export const MAX_RIMS = 4;

/** Fresh objects per call — three.js mutates uniform values in place and two
 *  materials must never share one (same contract as distortUniforms). */
export function shimmerUniforms() {
  return {
    uRimCount: { value: 0 },
    uRims: { value: Array.from({ length: MAX_RIMS }, () => [0, 0, 0, 0]).flat() },
    uRimAspect: { value: 1 },
  };
}

/** Declarations — goes above `void main()`. Uses the host's uTime. */
export const SHIMMER_DECL = /* glsl */ `
uniform int uRimCount;
uniform vec4 uRims[${MAX_RIMS}];
uniform float uRimAspect;

vec2 rimShimmer(vec2 p, float t) {
  vec2 off = vec2(0.0);
  for (int i = 0; i < ${MAX_RIMS}; i++) {
    if (i >= uRimCount) break;
    vec4 b = uRims[i];
    vec2 d = vec2((p.x - b.x) * uRimAspect, p.y - b.y);
    float dist = length(d);
    if (dist < 1e-5) continue;
    // Gaussian band sitting on the projected rim, wider than the blast shell:
    // a standing shimmer needs area to read at all.
    float w = max(b.z * 0.30, 0.010);
    float e = (dist - b.z) / w;
    float shell = exp(-e * e);
    // Two incommensurate spatial frequencies along the ring, drifting against
    // each other, so the wobble never reads as a loop.
    float wob = sin(dist * 90.0 + t * 5.1) * 0.6 + sin(dist * 53.0 - t * 3.7) * 0.4;
    off += (d / dist) * shell * b.w * wob;
  }
  off.x /= uRimAspect;
  return off;
}
`;

/** The one line that applies it, given `uv` and `uTime` in scope. */
export const SHIMMER_APPLY = /* glsl */ `
  if (uRimCount > 0) uv = clamp(uv + rimShimmer(uv, uTime), vec2(0.001), vec2(0.999));
`;
```

- [ ] **Step 4: Compose into `src/shaders/GradeShader.js`**

Import next to the distort import at the top:

```js
import { shimmerUniforms, SHIMMER_DECL, SHIMMER_APPLY } from './BlightShimmer.js';
```

In `uniforms`, after `...distortUniforms(),` add:

```js
    ...shimmerUniforms(),
```

In the fragment shader string: after the `${DISTORT_DECL}` line add a `${SHIMMER_DECL}` line; after the `${DISTORT_APPLY}` line (the blast displacement, before the aberration block) add:

```glsl
      // --- blight rim shimmer: same free ride on this pass's one tap --------
${SHIMMER_APPLY}
```

- [ ] **Step 5: Implement the writers in `src/systems/Blight.js`**

Imports at top:

```js
import { MASK_UNIFORMS, MAX_MASK } from '../shaders/BlightMask.js';
import { MAX_RIMS } from '../shaders/BlightShimmer.js';
```

Exported tuning next to `GROW_RATE`:

```js
// Rim shimmer only near the camera: it is an edge read for the player standing
// at the edge, and a distant ellipse projected as a screen-space circle is
// wrong enough to notice. Strength is deliberately under half a blast's.
export const SHIMMER = { near: 14, far: 55, strength: 0.0055 };
```

Module-scope scratch (top of file, after constants):

```js
const _proj = new THREE.Vector3();
const _v3 = new THREE.Vector3();
```

At the end of `update(ctx, dt)`, after `this._grade(ctx, dt);`:

```js
    this._mask(ctx);
    this._shimmer(ctx);
```

New methods after `_grade`:

```js
  /**
   * Publish the live patches into the shared material-mask uniforms. One
   * writer, every patched program a reader — see BlightMask.js. Slots go to
   * the patches nearest the camera (fall back to world origin headless): the
   * mask exists to corrupt what the player is looking at, and with more live
   * patches than slots the far ones are the right ones to drop.
   */
  _mask(ctx) {
    const u = MASK_UNIFORMS;
    const cam = ctx.camera;
    const cx = cam ? cam.position.x : 0, cz = cam ? cam.position.z : 0;
    const live = [];
    for (const p of this.patches) {
      if (!p.mesh) continue;
      const dx = p.x - cx, dz = p.z - cz;
      live.push([dx * dx + dz * dz, p]);
    }
    live.sort((a, b) => a[0] - b[0]);
    const n = Math.min(live.length, MAX_MASK);
    const arr = u.uBlightPatches.value;
    for (let i = 0; i < n; i++) {
      const p = live[i][1];
      const o = i * 4;
      arr[o] = p.x;
      arr[o + 1] = p.z;
      arr[o + 2] = p.mesh.material.uniforms.uRadius.value;
      arr[o + 3] = p.seedNoise;
    }
    u.uBlightCount.value = n;
    u.uBlightTime.value = ctx.time;
    u.uBlightBand.value = this.band;
  }

  /**
   * Project the nearest patch rims into GradeShader's shimmer slots — the
   * same world-radius-to-UV math VFX._updateDistortion uses for blasts.
   * Skipped for a patch the camera stands inside (the rim surrounds the
   * screen; a projected circle would shimmer the centre of the view), for
   * rims beyond SHIMMER.far, and for anything behind the camera.
   */
  _shimmer(ctx) {
    const pass = ctx.pipeline?.passes?.grade;
    const cam = ctx.camera;
    if (!pass?.uniforms?.uRims || !cam) return;
    const u = pass.uniforms.uRims.value;
    let n = 0;
    for (const p of this.patches) {
      if (n >= MAX_RIMS) break;
      const m = p.mesh;
      if (!m) continue;
      const r = m.material.uniforms.uRadius.value;
      const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
      const flat = Math.sqrt(dx * dx + dz * dz);
      if (flat < r + 1.5) continue;            // camera inside or on the rim
      if (flat - r > SHIMMER.far) continue;    // too far to read
      const y = this.ctx.stage?.sampleHeight ? this.ctx.stage.sampleHeight(p.x, p.z) : 0;
      _proj.set(p.x, y, p.z).project(cam);
      if (_proj.z > 1) continue;               // behind the camera: NDC wraps
      _v3.set(p.x, y, p.z);
      const dist = Math.max(1, cam.position.distanceTo(_v3));
      const halfH = Math.tan((cam.fov * Math.PI) / 360) * dist;
      const uvR = r / (halfH * 2);
      // Full strength at the near line, gone at far — the shimmer walks in.
      const k = 1 - Math.min(Math.max((flat - r - SHIMMER.near) / (SHIMMER.far - SHIMMER.near), 0), 1);
      const o = n * 4;
      u[o] = (_proj.x + 1) * 0.5;
      u[o + 1] = (_proj.y + 1) * 0.5;
      u[o + 2] = uvR;
      u[o + 3] = SHIMMER.strength * k * (0.6 + 0.1 * this.band);
      n++;
    }
    pass.uniforms.uRimCount.value = n;
    pass.uniforms.uRimAspect.value = (globalThis.innerWidth || 1) / (globalThis.innerHeight || 1);
  }
```

Note `u[o + 3]` max = `SHIMMER.strength * 1 * (0.6 + 0.1 * band)`; at band 4 that is `strength * 1.0` — the cap the test asserts.

- [ ] **Step 6: Run tests**

Run: `node tests/blight-ceiling.test.mjs` — PASS. Then `node tests/blight-system.test.mjs` (must stay green; the new methods no-op against its ctx which has no camera/pipeline rims) and `npm test`.

- [ ] **Step 7: Commit**

```bash
git add src/shaders/BlightShimmer.js src/shaders/GradeShader.js src/systems/Blight.js tests/blight-ceiling.test.mjs
git commit -m "The ground under the greed corrupts for real: mask on every material, heat over every rim"
```

---

### Task 4: Per-band sky and fog

**Files:**
- Modify: `src/world/Environment.js` (`applyBiome` records a baseline)
- Modify: `src/systems/Blight.js` (`_grade` extended; new exported constants)
- Test: extend `tests/blight-ceiling.test.mjs`

**Interfaces:**
- Consumes: `ctx.environment.biomeBaseline` (new), `ctx.scene.fog`, `ctx.environment.skyUniforms`.
- Produces:
  - `Environment.applyBiome` sets `this.biomeBaseline = { zenith, horizon, haze, fogColor: THREE.Color clones (linear, post-convert), fogDensity: number }`.
  - Blight exports `BAND_SKY = [0, 0, 0.30, 0.60, 1.0]` (blend weight per band) and `VOID_SKY = { zenith: 0x120b26, horizon: 0x3a1b52, haze: 0x7a2fae, fog: 0x241236, fogBoost: 0.55 }` (sRGB hexes; fog density multiplies by `1 + fogBoost * w`).

- [ ] **Step 1: Write the failing test** — append to `tests/blight-ceiling.test.mjs` before the exit lines:

```js
console.log('per-band sky and fog shift, and byte-for-byte restore');
{
  const { BAND_SKY, VOID_SKY } = await import('../src/systems/Blight.js');
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/blight-ceiling.test.mjs`
Expected: the new block FAILS (`BAND_SKY` undefined).

- [ ] **Step 3: Record the baseline in `src/world/Environment.js`** — at the end of `applyBiome` (after the dust block, still inside the method):

```js
    // What this biome's atmosphere actually is, post-conversion — the anchor
    // the corruption bands blend away from and hand back exactly. Presentation
    // systems (Blight) read it; nothing here consumes it.
    this.biomeBaseline = {
      zenith: this.skyUniforms.uZenith.value.clone(),
      horizon: this.skyUniforms.uHorizon.value.clone(),
      haze: this.skyUniforms.uHaze.value.clone(),
      fogColor: scene.fog ? scene.fog.color.clone() : null,
      fogDensity: scene.fog ? scene.fog.density : 0,
    };
```

- [ ] **Step 4: Blend in `src/systems/Blight.js`** — exported constants next to `BAND_GRADE`:

```js
/**
 * Sky/fog shift per band, as a blend weight toward VOID_SKY. Bands 0-1 are
 * null for the same reason BAND_GRADE's are: the atmosphere is the loudest
 * instrument this system owns, and it must not play before the world is
 * actually in trouble.
 */
export const BAND_SKY = [0, 0, 0.30, 0.60, 1.0];
export const VOID_SKY = { zenith: 0x120b26, horizon: 0x3a1b52, haze: 0x7a2fae, fog: 0x241236, fogBoost: 0.55 };
```

Module scope, after the scratch vectors:

```js
// Authored sRGB, converted once — the same convention applyBiome uses for the
// biome's own colours, so a blend between the two spaces never mixes gammas.
const VOID_ZENITH = new THREE.Color(VOID_SKY.zenith).convertSRGBToLinear();
const VOID_HORIZON = new THREE.Color(VOID_SKY.horizon).convertSRGBToLinear();
const VOID_HAZE = new THREE.Color(VOID_SKY.haze).convertSRGBToLinear();
const VOID_FOG = new THREE.Color(VOID_SKY.fog).convertSRGBToLinear();
```

Constructor state, next to `this._vig = 0;`:

```js
    this._skyW = 0;
```

In `_grade(ctx, dt)`, the method keeps its existing body and gains a tail (after `pipe.vignetteBoost = ...`):

```js
    // --- sky and fog: blend toward the void against the biome's own anchor.
    // Absolute mix from the recorded baseline every frame, never incremental:
    // applyBiome rewrites the live values on every stage build, and a system
    // that added offsets would corrupt the new biome by the old one's delta.
    // One frame after a rebuild the mix simply re-lands on the same weight.
    const env = ctx.environment;
    const base = env?.biomeBaseline;
    const target = BAND_SKY[Math.min(this.band, BAND_SKY.length - 1)] || 0;
    const prevW = this._skyW;
    this._skyW = settle(this._skyW, target, dt);
    if (!base || (this._skyW === 0 && prevW === 0)) return;
    const w = this._skyW;
    const sky = env.skyUniforms;
    if (sky?.uZenith) {
      sky.uZenith.value.copy(base.zenith).lerp(VOID_ZENITH, w * 0.60);
      sky.uHorizon.value.copy(base.horizon).lerp(VOID_HORIZON, w * 0.85);
      sky.uHaze.value.copy(base.haze).lerp(VOID_HAZE, w * 0.85);
    }
    const fog = ctx.scene?.fog;
    if (fog && base.fogColor) {
      fog.color.copy(base.fogColor).lerp(VOID_FOG, w * 0.80);
      fog.density = base.fogDensity * (1 + VOID_SKY.fogBoost * w);
    }
```

The `w === 0 && prevW === 0` early-out is the byte-for-byte restore: `settle` snaps to exactly 0, the frame it lands writes `lerp(…, 0)` — which `THREE.Color.lerp` resolves to a pure copy of the baseline — and every later frame stops touching the uniforms entirely, so `applyBiome`'s own values stand untouched at band 0. (At `w === 0` on the *landing* frame `prevW > 0`, so the copy still runs once.)

- [ ] **Step 5: Run tests**

Run: `node tests/blight-ceiling.test.mjs` and `node tests/blight-system.test.mjs` — both PASS (`blight-system`'s ctx has no environment; the tail returns immediately). Then `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/world/Environment.js src/systems/Blight.js tests/blight-ceiling.test.mjs
git commit -m "The sky learns which band it is under: every biome keeps an anchor the void pulls against"
```

---

### Task 5: Edge particulate — motes off the rims

**Files:**
- Modify: `src/systems/Blight.js` (`update` gains `_motes`; new exported constant)
- Test: extend `tests/blight-ceiling.test.mjs`

**Interfaces:**
- Consumes: `ctx.vfx.particles.emit(o)` (`src/fx/ParticleSystem.js:169` — reads, never retains), `FRAME.EMBER` from `src/fx/ParticleSystem.js`, `ctx.stage?.sampleHeight`, `ctx.fxRng`.
- Produces: `MOTES = { perPatchPerSecond: 2.5, maxPatches: 6, range: 55 }` exported from Blight.

- [ ] **Step 1: Write the failing test** — append before the exit lines:

```js
console.log('rim motes: budgeted, fxRng-only, on the rim, paused-gated');
{
  const { MOTES } = await import('../src/systems/Blight.js');
  const ctx = makeCtx();
  const emitted = [];
  ctx.vfx = { particles: { emit: (o) => emitted.push({ x: o.position.x, y: o.position.y, z: o.position.z }) } };
  ctx.stage = { sampleHeight: () => 2 };
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('blightSeed', { x: 5, z: -3, strength: 2 });
  for (let i = 0; i < 120; i++) { ctx.time += 1 / 60; b.update(ctx, 1 / 60); }  // 2 seconds
  const expect = MOTES.perPatchPerSecond * 2;
  ok(emitted.length >= expect * 0.5 && emitted.length <= expect * 1.5, `~${expect} motes over 2s (got ${emitted.length})`);
  const r = b.patches[0].mesh ? b.patches[0].mesh.material.uniforms.uRadius.value : radiusOfLive(b);
  function radiusOfLive() { return 0; }
  for (const m of emitted) {
    const d = Math.hypot(m.x - 5, m.z + 3);
    ok2(d <= (r || 99) * 1.01 && d >= (r || 0) * 0.75, m);
    ok2(Math.abs(m.y - 2.15) < 0.5, m);
  }
  let rimOk = true;
  function ok2(cond) { if (!cond) rimOk = false; }
  ok(rimOk, 'every mote sits on the rim band at ground height');

  const before = emitted.length;
  ctx.paused = true;
  for (let i = 0; i < 60; i++) b.update(ctx, 1 / 60);
  ok(emitted.length === before, 'a paused frame emits nothing');
}
```

Note: `makeCtx`'s throwing `ctx.rng` is the fxRng-only probe — a single `ctx.rng` draw anywhere in the mote path explodes the run. The headless `blight-system` ctx has no `ctx.vfx`, so that suite must stay green untouched.

**Test-design caveat for the implementer:** the patch in this ctx has no scene, so `_build` returns before creating a mesh and `uRadius` does not exist — the rim-distance assertion must therefore read the radius from `radiusOf(patch.strength, world)` growth math instead if `p.mesh` is null. Simplest correct form: give `makeCtx` a scene stub `{ add() {}, remove() {} }` in this block only (`ctx.scene = { add() {}, remove() {} }` set *before* `b.init`), so patches build real meshes headless (three constructs meshes without GL) and `uRadius` is real. Write the test that way from the start; the sketch above shows the assertions, the scene stub is required for them to bite.

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/blight-ceiling.test.mjs`
Expected: new block FAILS (`MOTES` undefined, no motes emitted).

- [ ] **Step 3: Implement** — import at top of `Blight.js`:

```js
import { FRAME } from '../fx/ParticleSystem.js';
```

Exported constant next to `SHIMMER`:

```js
// Rim particulate. Steady-state cost at the cap: 6 patches x 2.5/s x ~2s life
// = ~30 live sprites — noise against the particle budget, and the additive
// layer evicts by ring anyway.
export const MOTES = { perPatchPerSecond: 2.5, maxPatches: 6, range: 55 };
```

In `update`, after `this._shimmer(ctx);`:

```js
    if (!ctx.paused) this._motes(ctx, dt);
```

New method after `_shimmer`:

```js
  /**
   * The edge breathes: embers of the vein palette drift up off each rim.
   * Emission is per-patch accumulator driven, so rate is framerate-independent;
   * patches beyond MOTES.range of the camera don't spend budget. Everything
   * rolls on fxRng — one ctx.rng draw here would desync every later loot roll.
   */
  _motes(ctx, dt) {
    const particles = ctx.vfx?.particles;
    if (!particles) return;
    const cam = ctx.camera;
    const fx = ctx.fxRng;
    let considered = 0;
    for (const p of this.patches) {
      if (considered >= MOTES.maxPatches) break;
      const m = p.mesh;
      if (!m) continue;
      if (cam) {
        const dx = p.x - cam.position.x, dz = p.z - cam.position.z;
        if (dx * dx + dz * dz > MOTES.range * MOTES.range) continue;
      }
      considered++;
      p.moteAcc = (p.moteAcc || 0) + MOTES.perPatchPerSecond * dt;
      while (p.moteAcc >= 1) {
        p.moteAcc -= 1;
        const r = m.material.uniforms.uRadius.value * fx.range(0.82, 1.0);
        const a = fx.range(0, Math.PI * 2);
        const x = p.x + Math.cos(a) * r;
        const z = p.z + Math.sin(a) * r;
        const y = ctx.stage?.sampleHeight ? ctx.stage.sampleHeight(x, z) : 0;
        particles.emit({
          count: 1,
          position: { x, y: y + 0.15, z },
          dir: { x: 0, y: 1, z: 0 }, spread: 0.35,
          speed: 0.5, speedVar: 0.5,
          life: 1.8, lifeVar: 0.4,
          size0: 0.06, size1: 0.015,
          color0: 0x9a5fe0, color1: 0xc8379b,   // vein-to-rim family
          frame: FRAME.EMBER,
          gravity: -0.35,                        // rises: the void exhales
          drag: 0.6, turbulence: 0.45,
          fadeIn: 0.25, alphaPow: 1.2,
        });
      }
    }
  }
```

(`particles.emit` reads `o.dir` via `_v.copy(o.dir)` — a plain `{x,y,z}` satisfies `Vector3.copy`. `position` likewise is read field-by-field. Verify both against the live `emit`; they are true of the source shown in this plan's recon.)

- [ ] **Step 4: Run tests**

Run: `node tests/blight-ceiling.test.mjs`, `node tests/blight-system.test.mjs`, `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Blight.js tests/blight-ceiling.test.mjs
git commit -m "The wound exhales: embers off every rim, priced in advance and paid from the cosmetic stream"
```

---

### Task 6: The corruption gets a voice — band-keyed void layer

**Files:**
- Modify: `src/systems/Audio.js` (init node graph + update tail + two exports)
- Test: `tests/corruption-audio.test.mjs`

**Interfaces:**
- Consumes: `this.ambient` bus (`src/systems/Audio.js:359`), `ctx.corruption?.band` (`src/systems/Corruption.js:73`).
- Produces: exported `VOID_LAYER = [0, 0, 0.05, 0.11, 0.18]` and `voidLayerGain(band) -> number` (pure, clamped, non-finite-safe).

- [ ] **Step 1: Write the failing test**

```js
// tests/corruption-audio.test.mjs
import { VOID_LAYER, voidLayerGain } from '../src/systems/Audio.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('void layer gain curve');
{
  ok(VOID_LAYER.length === 5, 'five bands');
  ok(voidLayerGain(0) === 0 && voidLayerGain(1) === 0, 'silent through band 1 — the audio must not spend itself early');
  ok(voidLayerGain(2) > 0, 'audible from band 2');
  ok(voidLayerGain(3) > voidLayerGain(2) && voidLayerGain(4) > voidLayerGain(3), 'monotonic');
  ok(voidLayerGain(99) === VOID_LAYER[4], 'clamps high');
  ok(voidLayerGain(-3) === 0, 'clamps low');
  ok(voidLayerGain(NaN) === 0, 'non-finite reads as band 0');
  ok(voidLayerGain(2.7) === VOID_LAYER[2], 'fractional bands floor');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/corruption-audio.test.mjs`
Expected: FAIL — exports missing. **Check first that importing `Audio.js` headless does not throw at module scope** (it should not — the AudioContext is built in `init`, not at import). If it does throw, the constants move to `src/data/corruption.js` instead and the test imports from there; keep the names identical.

- [ ] **Step 3: Implement the exports** — top of `src/systems/Audio.js`, near other module constants:

```js
/**
 * The world-state audio layer (launch design §1, world state): gain per
 * corruption band on the void shimmer bed. Zero through band 1 for the same
 * reason BAND_GRADE's early entries are zero — an atmosphere that sickens
 * before the world does spends the effect before it means anything.
 */
export const VOID_LAYER = [0, 0, 0.05, 0.11, 0.18];

export function voidLayerGain(band) {
  const b = Number.isFinite(band) ? Math.floor(band) : 0;
  return VOID_LAYER[Math.max(0, Math.min(b, VOID_LAYER.length - 1))];
}
```

- [ ] **Step 4: Build the node graph** — in `init`, immediately after the drone block (after `this.droneGain = droneGain;` around line 411), following the drone's construction idiom:

```js
    // --- void layer: the corruption band as sound. A glassy tritone pair over
    // band-passed noise — an interval that never resolves, breathing through a
    // slow filter LFO. Sits on the ambient bus (it is world state, not music,
    // so the music-off setting leaves the world still audibly wrong).
    const voidGain = ac.createGain();
    voidGain.gain.value = 0.0;
    const voidFilter = ac.createBiquadFilter();
    voidFilter.type = 'bandpass';
    voidFilter.frequency.value = 2400;
    voidFilter.Q.value = 1.4;
    voidFilter.connect(voidGain);
    voidGain.connect(this.ambient);
    const vbuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const vd = vbuf.getChannelData(0);
    for (let i = 0; i < vd.length; i++) vd[i] = Math.random() * 2 - 1;
    const vnoise = ac.createBufferSource();
    vnoise.buffer = vbuf;
    vnoise.loop = true;
    const vng = ac.createGain();
    vng.gain.value = 0.5;
    vnoise.connect(vng).connect(voidFilter);
    vnoise.start();
    for (const [freq, det, g0] of [[523.25, -14, 0.30], [739.99, 11, 0.22]]) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.detune.value = det;
      const g = ac.createGain();
      g.gain.value = g0;
      o.connect(g).connect(voidFilter);
      o.start();
    }
    const vlfo = ac.createOscillator();
    vlfo.frequency.value = 0.11;
    const vlfoGain = ac.createGain();
    vlfoGain.gain.value = 500;
    vlfo.connect(vlfoGain).connect(voidFilter.frequency);
    vlfo.start();
    this.voidGain = voidGain;
```

Two implementer verifications against the live file: (1) if `Audio.js` already builds looping noise through a seeded/local RNG rather than `Math.random`, use that source instead — the buffer is cosmetic and never touches any shared stream either way; (2) if the drone block's locals are structured differently than the recon excerpt (lines 384-411), match the file's actual idiom while keeping this node topology.

- [ ] **Step 5: Drive it** — in `update(ctx, dt)`, next to the existing drone-gain write (around line 1283):

```js
    if (this.voidGain) {
      // 2.0s time constant lands in the same felt window as the visual
      // GRADE_BLEND — the world sickens in one motion, not two.
      this.voidGain.gain.setTargetAtTime(voidLayerGain(ctx.corruption?.band), ac.currentTime, 2.0);
    }
```

(Place it inside whatever guard gives `ac` scope there — the drone write at 1283 shows the pattern. Deliberately NOT gated on `this._musicOff`: the layer is world state on the ambient bus, not music.)

- [ ] **Step 6: Run tests**

Run: `node tests/corruption-audio.test.mjs` — PASS. `npm test` — green.

- [ ] **Step 7: Commit**

```bash
git add src/systems/Audio.js tests/corruption-audio.test.mjs
git commit -m "The band gets a voice: a tritone that never resolves, silent until the world earns it"
```

---

### Task 7: Gates, money shot, baselines

**Files:**
- Modify: none expected; baseline artifacts as the repo's convention dictates.

- [ ] **Step 1: Full suite**

Run: `npm test` — every suite green, including `tests/sp-equivalence.mjs` (nothing in this plan draws `ctx.rng`, so equivalence must hold with **zero** baseline changes; if sp-equivalence moved, that is a bug in the slice, not a baseline to regenerate).

- [ ] **Step 2: Live probe** (headless-probe if interactive play is impossible, following `tools/voidprobe.mjs` conventions): on a run with corruption on the gauge, force a chest (void credit) and stand at the patch: ground and props inside the radius shade violet with veins; walk to the rim: motes rise and the air past the rim wobbles; push the band to 2+ (or drive `corruptionBand` from the console): sky/fog shift in over ~2.5s and the void layer fades up; drop to band 0: everything restores. Record exactly which checks were performed and how.

- [ ] **Step 3: Money shot** (spec §3.4 — every feature milestone ends with its money shot). Locate the capture harness's CLI by reading `tools/capture.mjs`'s header, then capture the trailer thesis framing this slice makes possible: a blight edge in the foreground spreading toward camera, corrupted props inside, clean biome beyond. Commit the shot wherever the existing shot manifests live (follow `reviews/` manifest convention if no dedicated library exists yet — the shot library formalization is slice 4's job, not this one's). Name the capture per the repo's baseline-capture convention so any later before/after claim has an on-disk source.

- [ ] **Step 4: Shot-harness baselines** — if the shot harness's existing baseline scenes contain blight patches or band-2+ corruption states, regenerate those baselines once, named and committed per convention; scenes without corruption must be pixel-identical (the mask early-outs at `uBlightCount == 0`, the shimmer at `uRimCount == 0` — a diff in a clean scene is a regression).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "Phase 3 opens on the blight: the ceiling shot exists and the gates held"
```

---

## Self-review notes

- **Spec coverage (this slice):** crawling corruption edge — refraction ✓ (Task 3 shimmer, priced the DistortShader way), emissive veins ✓ (already shipped; Task 1 extends them onto surfaces), particulate ✓ (Task 5); corrupted material variants per biome palette ✓ (Tasks 1-2 — variant-as-function over the biome's own base, which is what "per biome palette" means with a cached library); void-warped prop swaps ✓ (Task 2 — props share the patched library; the "swap" is the mask crossing the prop, so it is exactly aligned with the blight radius); per-band skybox/fog/grade ✓ (Task 4 + grade already shipped); §1 world-state audio layer ✓ (Task 6). Deferred deliberately: readability/juice, diegetic UI, shot-library formalization (slices 2-4); co-op replication of blight for hot-joins (net slice, unchanged); re-baking the environment probe on band change (reflections keep the clean sky — invisible at these roughness floors, noted in Task 4's territory but not worth a per-band PMREM bake).
- **Type consistency:** `MASK_UNIFORMS` field names identical across Tasks 1/2/3; `uBlightPatches` layout `x, z, radius, phase` written in Task 3 exactly as Task 1's comment declares; `shimmerUniforms()` fresh-per-call in GradeShader vs `MASK_UNIFORMS` shared-singleton is deliberate and documented in both files (one writer/many programs vs per-material mutation); `SHIMMER`/`MOTES`/`BAND_SKY`/`VOID_SKY`/`VOID_LAYER` export names match between implementation and tests.
- **Known execution-time checks (deliberate):** whether `getMaterials()` imports headless in node (Task 2 offers the grep fallback); whether `Audio.js` module scope imports headless and whether it has an existing noise-buffer RNG convention (Task 6 steps 2/4); the exact drone-write guard shape at `Audio.js:1283` (Task 6 step 5); `tools/capture.mjs` CLI and the current shot-manifest location (Task 7). The implementer verifies against live files.
- **Cost honesty:** the mask adds ~12 noise evaluations per fragment on stage materials *only when `uBlightCount > 0`*; the adaptive-resolution controller (`RenderPipeline._adapt`) is the existing backstop if a low tier chokes on a blighted vista, and the uniform branch keeps clean stages at zero cost. The shimmer rides GradeShader's existing tap (zero extra fullscreen reads). Motes cap at ~30 live sprites.
