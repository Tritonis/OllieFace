# Blight Field Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blight seeds become visible: corrupted ground patches that grow with World Corruption, plus per-band screen grading — the map remembers where you were greedy.

**Architecture:** One new system, `src/systems/Blight.js`, listens to `blightSeed` / `corruptionBand` / `stageStart` and owns a pool of terrain-conforming patch meshes with a custom ShaderMaterial (visible radius is a uniform, so growth costs no re-tessellation). Band shifts drive the existing `GradeShader` uniforms on `ctx.pipeline`. Everything is cosmetic: no gameplay reads blight, `ctx.rng` is never touched, and all variation comes from `ctx.fxRng`.

**Tech Stack:** three.js ShaderMaterial (following `src/fx/Decals.js`), terrain conformity via `ctx.stage.sampleHeight` (following `Telegraphs`, `src/systems/Director.js:1110-1160`), grade uniforms via `src/core/RenderPipeline.js` GradeShader.

## Global Constraints

- Systems are classes with `init(ctx)` + update hooks; no system-to-system imports (`CONTRACTS.md`). Blight reads `ctx.corruption`, `ctx.stage`, `ctx.pipeline` — never imports them.
- **Zero `ctx.rng` draws.** Cosmetic jitter uses `ctx.fxRng` only (`NETCODE.md`: a client's particle jitter must never advance the shared stream).
- Blight is presentation: nothing in gameplay may read blight state. The one-way rule — Corruption emits, Blight listens.
- Patches are per-stage: `stageStart` clears every live patch. Seeds are consumed from events, not from scanning `ctx.corruption.seeds` (exception: `init`-time adoption is out of scope; a mid-run hot-join client has no blight until the co-op replication slice).
- Events consumed (exact payloads, per `CONTRACTS.md`): `blightSeed { x, z, strength }`, `corruptionBand { band, prev }`, `stageStart { index, name }`.
- Palette continuity: patch/vein colors come from the HUD band ramp already shipped — `#7a4fd0`, `#9a3fe0`, `#c72fd6`, `#ff2fb0` (`src/ui/hud.css`).
- Every value that reads as tuning lives in exported constants so tests pin behaviour and designers turn dials.
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code, LCG fixture — same shape as `tests/corruption-system.test.mjs`. three.js constructs meshes/materials headless; no GL compile is attempted in tests.
- Missing subsystems never throw: no `ctx.stage` → patches skip terrain conformity (flat at y=0); no `ctx.pipeline` → no grading; no `ctx.scene` → system stays inert. Guard with the codebase's `?.` idiom.

---

### Task 1: Blight system core — registry, events, growth math

**Files:**
- Create: `src/systems/Blight.js`
- Test: `tests/blight-system.test.mjs`

**Interfaces:**
- Consumes: `blightSeed` / `corruptionBand` / `stageStart` events; `ctx.corruption?.world`; `ctx.fxRng.range(a, b)`.
- Produces (later tasks rely on these exact names):
  - `ctx.blight` set by `init(ctx)`.
  - `patches` — array of live patch records `{ x, z, strength, seedNoise, maxR, mesh }` (`mesh` null until Task 2).
  - `radiusOf(strength, world) -> metres` — exported pure function.
  - `MAX_PATCHES = 48`, `RADIUS = { base: 2.0, perStrength: 1.5, perWorld: 0.04, cap: 14 }` — exported.
  - `band` — the system's copy of the current band (0 default, updated by `corruptionBand`).

- [ ] **Step 1: Write the failing test**

```js
// tests/blight-system.test.mjs
import { Blight, radiusOf, RADIUS, MAX_PATCHES } from '../src/systems/Blight.js';

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

console.log('band tracking follows corruptionBand');
{
  const ctx = makeCtx();
  const b = new Blight();
  b.init(ctx);
  ok(b.band === 0, 'starts Pristine');
  ctx.events.emit('corruptionBand', { band: 3, prev: 2 });
  ok(b.band === 3, 'adopts the event band');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/blight-system.test.mjs`
Expected: FAIL to load — `Cannot find module '../src/systems/Blight.js'`

- [ ] **Step 3: Write the system core**

```js
// src/systems/Blight.js
import * as THREE from 'three';

/**
 * Blight fields — the visible consequence of greed. Corruption records where
 * greed happened (`blightSeed`); this system grows a corrupted ground patch
 * at each seed, sized by the seed's strength and the party's World Corruption.
 *
 * Strictly presentation. Gameplay never reads blight; Corruption never knows
 * it is drawn. All variation comes off ctx.fxRng — a patch is cosmetic, and a
 * cosmetic draw on the shared stream would desync every later loot roll.
 */
export const MAX_PATCHES = 48;
export const RADIUS = { base: 2.0, perStrength: 1.5, perWorld: 0.04, cap: 14 };

export function radiusOf(strength, world) {
  return Math.min(RADIUS.base + RADIUS.perStrength * strength + RADIUS.perWorld * world, RADIUS.cap);
}

export class Blight {
  constructor() {
    this.patches = [];
    this.band = 0;
    this.ctx = null;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.blight = this;
    ctx.events.on('blightSeed', (s) => this._addPatch(s));
    ctx.events.on('corruptionBand', ({ band }) => { this.band = band; });
    ctx.events.on('stageStart', () => this._clear());
  }

  _addPatch({ x, z, strength }) {
    const patch = {
      x, z, strength,
      // Phase offset for the crawl shader — per-patch so a field of patches
      // never pulses in unison. Cosmetic, so fxRng.
      seedNoise: this.ctx.fxRng.range(0, 100),
      maxR: RADIUS.cap,
      mesh: null,
    };
    this.patches.push(patch);
    if (this.patches.length > MAX_PATCHES) this._recycle(this.patches.shift());
    this._build(patch);
  }

  _clear() {
    for (const p of this.patches) this._recycle(p);
    this.patches.length = 0;
  }

  // Mesh lifecycle lands in Task 2 — the registry is real either way.
  _build(patch) {}
  _recycle(patch) {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/blight-system.test.mjs`
Expected: PASS, `13 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add src/systems/Blight.js tests/blight-system.test.mjs
git commit -m "Blight gets a ledger of its own: seeds become patch records"
```

---

### Task 2: The patch mesh — terrain-conforming geometry and the crawl shader

**Files:**
- Modify: `src/systems/Blight.js` (fill `_build` / `_recycle`, add the material and geometry builders)
- Test: extend `tests/blight-system.test.mjs`

**Interfaces:**
- Consumes: `ctx.stage?.sampleHeight(x, z)`, `ctx.scene`, `ctx.fxRng`.
- Produces: `patch.mesh` — a `THREE.Mesh` whose geometry is a radial grid conformed to the heightfield at build time out to `maxR`, whose material exposes uniforms `uTime`, `uRadius`, `uMaxR`, `uNoise`, `uBand`. Mesh pooling: `_meshPool` array, `_build` reuses, `_recycle` returns and detaches from scene. Exported for tests: `buildPatchGeometry(x, z, maxR, sampleHeight) -> BufferGeometry` (rings × segments radial grid, vertex y = sampleHeight(worldX, worldZ) + 0.06, positions in world space with the mesh itself at origin), `makeBlightMaterial() -> ShaderMaterial`.

- [ ] **Step 1: Write the failing test — append before the summary lines**

Add `buildPatchGeometry, makeBlightMaterial` to the import from `../src/systems/Blight.js`, and `import * as THREE from 'three';` at the top. Then:

```js
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
```

- [ ] **Step 2: Run test to verify the new arms fail**

Run: `node tests/blight-system.test.mjs`
Expected: new arms FAIL (missing exports); Task 1 arms still pass.

- [ ] **Step 3: Implement geometry, material, and mesh lifecycle**

Add to `src/systems/Blight.js`:

```js
const RINGS = 10;
const SEGMENTS = 24;

/**
 * A radial grid draped over the heightfield at build time. The mesh sits at
 * the origin with world-space vertices, so growth never re-tessellates: the
 * shader masks the visible radius with uRadius while the geometry already
 * covers maxR. 10 rings x 24 segments = 241 verts, built once per seed.
 */
export function buildPatchGeometry(x, z, maxR, sampleHeight) {
  const verts = [];
  const uvs = [];
  const idx = [];
  verts.push(x, (sampleHeight ? sampleHeight(x, z) : 0) + 0.06, z);
  uvs.push(0, 0);
  for (let r = 1; r <= RINGS; r++) {
    const rad = (r / RINGS) * maxR;
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const wx = x + Math.cos(a) * rad;
      const wz = z + Math.sin(a) * rad;
      verts.push(wx, (sampleHeight ? sampleHeight(wx, wz) : 0) + 0.06, wz);
      uvs.push(rad / maxR, a);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) idx.push(0, 1 + s, 1 + ((s + 1) % SEGMENTS));
  for (let r = 0; r < RINGS - 1; r++) {
    const a0 = 1 + r * SEGMENTS, b0 = 1 + (r + 1) * SEGMENTS;
    for (let s = 0; s < SEGMENTS; s++) {
      const s1 = (s + 1) % SEGMENTS;
      idx.push(a0 + s, b0 + s, b0 + s1, a0 + s, b0 + s1, a0 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * The crawl: a dark violet fill, emissive veins that pulse along the radius,
 * and an edge band that flickers — the "alive at the border" read is the
 * whole point, it is what says this is spreading, not painted. uv.x carries
 * normalized radius, uv.y the angle, so the fragment shader needs no world
 * math. Colors are the HUD band ramp so gauge and ground agree.
 */
export function makeBlightMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: 2 },
      uMaxR: { value: RADIUS.cap },
      uNoise: { value: 0 },
      uBand: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uRadius, uMaxR, uNoise, uBand;
      varying vec2 vUv;
      // Cheap periodic hash — good enough for crawl flicker, no texture fetch.
      float n2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float r = vUv.x * uMaxR;               // metres from the seed
        float edge = uRadius;
        if (r > edge) discard;
        float t = uTime + uNoise;
        // Edge band: the outer 18% flickers and brightens with band.
        float band = smoothstep(edge * 0.82, edge, r);
        float crawl = n2(vec2(vUv.y * 12.0, floor(t * 6.0))) * 0.5 + 0.5;
        // Veins: angular ridges pulsing outward.
        float vein = pow(abs(sin(vUv.y * 14.0 + sin(r * 1.7 - t * 1.4))), 8.0);
        vec3 fill = mix(vec3(0.10, 0.05, 0.19), vec3(0.23, 0.09, 0.38), r / max(edge, 0.001));
        vec3 veinC = mix(vec3(0.48, 0.25, 0.82), vec3(0.78, 0.18, 0.84), min(uBand / 4.0, 1.0));
        vec3 edgeC = vec3(1.0, 0.18, 0.69);
        vec3 col = fill + veinC * vein * 0.6 + edgeC * band * crawl * (0.5 + uBand * 0.12);
        float alpha = 0.78 - r / max(edge, 0.001) * 0.12 + band * 0.2;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}
```

Replace `_build` / `_recycle`:

```js
  _build(patch) {
    const ctx = this.ctx;
    if (!ctx.scene) return;
    const sample = ctx.stage?.sampleHeight ? (x, z) => ctx.stage.sampleHeight(x, z) : null;
    const mesh = this._meshPool?.pop() || new THREE.Mesh(undefined, makeBlightMaterial());
    if (mesh.geometry) mesh.geometry.dispose();
    mesh.geometry = buildPatchGeometry(patch.x, patch.z, patch.maxR, sample);
    mesh.material.uniforms.uNoise.value = patch.seedNoise;
    mesh.material.uniforms.uRadius.value = radiusOf(patch.strength, ctx.corruption?.world || 0);
    mesh.renderOrder = 1;   // over terrain, under transparent VFX bursts
    ctx.scene.add(mesh);
    patch.mesh = mesh;
  }

  _recycle(patch) {
    const mesh = patch.mesh;
    if (!mesh) return;
    this.ctx.scene?.remove(mesh);
    if (!this._meshPool) this._meshPool = [];
    if (this._meshPool.length < 16) this._meshPool.push(mesh);
    else { mesh.geometry.dispose(); mesh.material.dispose(); }
    patch.mesh = null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/blight-system.test.mjs`
Expected: PASS, all arms.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Blight.js tests/blight-system.test.mjs
git commit -m "The blight patch drapes the terrain and crawls at its edge"
```

---

### Task 3: Growth and animation — the update loop

**Files:**
- Modify: `src/systems/Blight.js` (add `update(ctx, dt)`)
- Test: extend `tests/blight-system.test.mjs`

**Interfaces:**
- Consumes: `ctx.corruption?.world`, `ctx.time`.
- Produces: per-frame uniform writes — `uTime = ctx.time`, `uBand = this.band`, and `uRadius` easing toward `radiusOf(strength, world)` at `GROW_RATE = 1.2` m/s (export it). Growth is one-way: a patch never shrinks (cleansing, when it exists, bleeds the gauge — the scar stays).

- [ ] **Step 1: Write the failing test — append before the summary lines**

```js
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
```

Add `GROW_RATE` to the test's import list.

- [ ] **Step 2: Run test to verify the new arm fails**

Run: `node tests/blight-system.test.mjs` — new arm FAILS (`GROW_RATE` undefined / no update method).

- [ ] **Step 3: Implement**

```js
export const GROW_RATE = 1.2;   // metres per second — visible spread, not a pop
```

```js
  update(ctx, dt) {
    const world = ctx.corruption?.world || 0;
    for (let i = 0; i < this.patches.length; i++) {
      const p = this.patches[i];
      const m = p.mesh;
      if (!m) continue;
      const u = m.material.uniforms;
      const target = radiusOf(p.strength, world);
      if (u.uRadius.value < target) {
        u.uRadius.value = Math.min(target, u.uRadius.value + GROW_RATE * dt);
      }
      u.uTime.value = ctx.time;
      u.uBand.value = this.band;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/blight-system.test.mjs` — all arms PASS.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Blight.js tests/blight-system.test.mjs
git commit -m "Blight spreads at walking pace and never gives ground back"
```

---

### Task 4: Band grading — the world state you can feel

**Files:**
- Modify: `src/systems/Blight.js` (extend `update` with grade blending; add `BAND_GRADE` export)
- Test: extend `tests/blight-system.test.mjs`

**Interfaces:**
- Consumes: `ctx.pipeline` — `passes.grade.uniforms.uSaturation.value` / `uLift.value` shape (verify exact uniform names against `GradeShader` in `src/core/RenderPipeline.js` at execution time; the recon found `uVignette`, `uSaturation`, `uContrast`, `uLift`, `uGain`, `uToe`) and the writable `vignetteBoost` property.
- Produces: `BAND_GRADE` — five entries `{ sat, vignette }`: band 0 `{ sat: 0, vignette: 0 }`, band 1 `{ sat: 0, vignette: 0 }` (the gauge and patches carry the news; the screen stays honest until it's *real*), band 2 `{ sat: -0.06, vignette: 0.05 }`, band 3 `{ sat: -0.12, vignette: 0.11 }`, band 4 `{ sat: -0.2, vignette: 0.2 }`. Applied as *offsets* blended in over `GRADE_BLEND = 2.5` seconds, never as absolute overwrites — the pipeline's own values are the baseline, captured once on first application.

- [ ] **Step 1: Write the failing test — append before the summary lines**

```js
console.log('band grading offsets the pipeline baseline, blended over time');
{
  const ctx = makeCtx();
  ctx.time = 0;
  ctx.pipeline = {
    vignetteBoost: 0,
    passes: { grade: { uniforms: { uSaturation: { value: 1.0 } } } },
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
  ctx.events.emit('corruptionBand', { band: 0, prev: 4 });
  for (let i = 0; i < 20; i++) b.update(ctx, 0.5);
  ok(Math.abs(ctx.pipeline.passes.grade.uniforms.uSaturation.value - 1.0) < 1e-3, 'band 0 restores the baseline exactly');
}
```

Add `BAND_GRADE` to the test's import list.

- [ ] **Step 2: Run test to verify the new arm fails**

Run: `node tests/blight-system.test.mjs` — new arm FAILS.

- [ ] **Step 3: Implement**

```js
export const BAND_GRADE = [
  { sat: 0, vignette: 0 },
  { sat: 0, vignette: 0 },
  { sat: -0.06, vignette: 0.05 },
  { sat: -0.12, vignette: 0.11 },
  { sat: -0.2, vignette: 0.2 },
];
export const GRADE_BLEND = 2.5;   // seconds to settle after a band change
```

In `update`, after the patch loop:

```js
    const pipe = ctx.pipeline;
    const gradeU = pipe?.passes?.grade?.uniforms;
    if (gradeU?.uSaturation) {
      if (this._satBase == null) this._satBase = gradeU.uSaturation.value;
      const g = BAND_GRADE[Math.min(this.band, BAND_GRADE.length - 1)];
      const k = Math.min(1, dt / GRADE_BLEND * 3);   // exponential-ish settle
      this._sat = (this._sat ?? 0) + ((g.sat) - (this._sat ?? 0)) * k;
      this._vig = (this._vig ?? 0) + ((g.vignette) - (this._vig ?? 0)) * k;
      gradeU.uSaturation.value = this._satBase + this._sat;
      pipe.vignetteBoost = this._vig;
    }
```

Adapt the exact uniform handle to the real `GradeShader` pass layout in `RenderPipeline` (the recon says grade uniforms exist; find how passes are keyed — `this.passes` is a plain object on the pipeline). If `vignetteBoost` is consumed additively per-frame by the pipeline rather than held (check its consumption site), write the blended value each update — that is what the property is for (`src/systems/VFX.js:199-200` already writes it).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/blight-system.test.mjs` — all arms PASS.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Blight.js tests/blight-system.test.mjs
git commit -m "The screen itself sickens: band grading rides the existing grade pass"
```

---

### Task 5: Registration, live verification, and the money shot

**Files:**
- Modify: `src/main.js` (register Blight after Corruption)
- Create: `shots-blight/` captures via the existing tooling

**Interfaces:**
- Consumes: everything above; `tools/capture.mjs` conventions.
- Produces: the system running in the real game, and the first blight entries in the shot library (trailer-first workstream).

- [ ] **Step 1: Register in main.js**

```js
import { Blight } from './systems/Blight.js';
```

Register immediately after the Corruption system's registration line (Blight listens to events Corruption emits same-frame; system update order between them is irrelevant since patches react on events, but registration proximity keeps the pairing legible). Match the neighbouring registration call shape exactly.

- [ ] **Step 2: Verify by playing**

Run `npm run dev`, start a run, and confirm:
- Force-open a chest broke (void credit) → a violet patch appears under the chest and visibly crawls at its edge.
- Open several paid chests to climb the gauge → existing patches widen (walking-pace growth, no pops).
- Reach band 2+ → screen desaturates subtly and vignettes; band label and ground and screen all agree.
- Slopes: force a void credit on a hillside chest — the patch drapes the slope, no floating rim, no z-fighting shimmer.
- New stage → clean ground, gauge band grading persists (band is a run property, patches are a stage property).
- Console: zero errors; `npm test` still green.

If driving the game interactively is impossible in this environment, verify what is checkable headlessly and report exactly which checks were not performed.

- [ ] **Step 3: Capture the shot**

Use `tools/capture.mjs` conventions to capture: a mid-band stage with 3+ patches visible, one at a slope, HUD gauge in frame. Store under `shots-blight/`. This is the trailer thesis shot's first draft — fighting at a blight edge comes when enemies can stand next to one.

- [ ] **Step 4: Full suite + commit**

Run: `npm test` — all files green (now including the extended blight test).

```bash
git add src/main.js shots-blight
git commit -m "Blight reaches the world: the map now remembers where you were greedy"
```

---

### Task 6: Verification gate

- [ ] **Step 1:** `npm test` — full suite green.
- [ ] **Step 2:** `npm run gate:elite` — must report no fields moved (Blight draws zero `ctx.rng`; this proves it).
- [ ] **Step 3:** Confirm `git status --short` clean.

---

## Self-review notes

- **Spec coverage (this slice):** blight fields grow from seeds ✓ (Tasks 1–3), crawling edge ✓ (Task 2 shader), per-band screen shift ✓ (Task 4 — grade/vignette; skybox/fog uniforms deliberately deferred: the recon found no runtime sky-mutation precedent, and the grade pass gives the read at a fraction of the risk; a sky pass can be its own follow-up), per-band audio layer deferred to the audio pass, prop material swaps deferred (needs per-biome corrupted variants — presentation plan workstream 1 continues there). Deferred items restated here deliberately.
- **Type consistency:** `radiusOf(strength, world)`, patch record `{ x, z, strength, seedNoise, maxR, mesh }`, uniforms `uTime/uRadius/uMaxR/uNoise/uBand`, exports `MAX_PATCHES/RADIUS/GROW_RATE/BAND_GRADE/GRADE_BLEND` used consistently across tasks.
- **Known execution-time checks (deliberate):** exact GradeShader pass key and `vignetteBoost` consumption semantics (Task 4 Step 3 note); registration call shape in main.js (Task 5). The implementer verifies against live files.
