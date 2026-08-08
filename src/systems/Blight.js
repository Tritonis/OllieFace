// src/systems/Blight.js
import * as THREE from 'three';
import { damp } from '../core/MathUtil.js';

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
export const GROW_RATE = 1.2;   // metres per second — visible spread, not a pop

/**
 * What each band does to the frame, as *offsets* from whatever grade the
 * pipeline is already running — never absolute values. Bands 0 and 1 are
 * deliberately null: the gauge and the ground patches carry the news that
 * early, and a screen that desaturates before the world is actually in trouble
 * spends the effect before it means anything.
 */
export const BAND_GRADE = [
  { sat: 0, vignette: 0 },
  { sat: 0, vignette: 0 },
  { sat: -0.06, vignette: 0.05 },
  { sat: -0.12, vignette: 0.11 },
  { sat: -0.20, vignette: 0.20 },
];
export const GRADE_BLEND = 2.5;   // seconds for a band change to settle
// Per-second damp rate that lands 97% of the way home in GRADE_BLEND seconds.
// Derived rather than tuned so the constant above is the only knob.
const GRADE_RATE = 1 - Math.pow(0.03, 1 / GRADE_BLEND);
// Below this the offset is snapped to zero, so dropping back to band 0 hands
// the pipeline its own baseline back byte-for-byte instead of an asymptote.
const GRADE_EPS = 1e-4;

export function radiusOf(strength, world) {
  return Math.min(RADIUS.base + RADIUS.perStrength * strength + RADIUS.perWorld * world, RADIUS.cap);
}

/** Frame-rate-independent approach, snapped once it is close enough to land on. */
function settle(v, target, dt) {
  const next = damp(v, target, GRADE_RATE, dt);
  return Math.abs(target - next) < GRADE_EPS ? target : next;
}

// A radial grid this dense is 275 verts and two dozen triangles per ring — a
// rounding error against the terrain it lies on, and fine enough to follow a
// stage's slopes without the rim floating off a ridge.
const RINGS = 10;
const SEGMENTS = 24;
// The pool never needs to hold more than a stage transition's worth of meshes;
// past that, disposing is cheaper than the retained GPU buffers.
const POOL_MAX = 16;
// The mesh sits this far above the sampled ground — enough to clear terrain
// z-fighting, low enough that the patch still reads as painted on.
const LIFT = 0.06;

/**
 * Where the draped grid stops being a drape.
 *
 * The grid samples the heightfield on a ~1.4 m ring pitch. Over continuous
 * ground that is plenty — a measured 0.71-gradient hillside conforms to five
 * decimals. But where the terrain *steps* (cliff lips, ruin walls, pit rims)
 * the same quad has one edge on the lip and the other on the floor, and it
 * renders as a near-vertical sheet standing up the cliff face. Those are the
 * "curtains".
 *
 * So every vertex measures the local rise-over-run against its own grid
 * neighbours and carries the result as `aTear`, which the fragment shader
 * fades out. The window is chosen to sit clear of both cases rather than
 * split the difference: `lo` is 50 degrees, well above any slope a player
 * walks (the 0.71 drape case scores 0 here with room to spare), and `hi` is
 * 69 degrees, below which nothing that reads as ground can be. A cliff that
 * drops 10 m across one ring scores ~7 — off the top of the scale, fully
 * dissolved. The patch pools on what is flat and lets go of what is not.
 */
const TEAR = { lo: 1.2, hi: 2.6 };   // rise over run

const BlightVert = /* glsl */ `
attribute float aTear;
varying vec2 vUv;
varying float vTear;
void main() {
  vUv = uv;
  vTear = aTear;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Colours are authored as the linear-space value that *lands* on the intended
 * screen colour, not as the intended colour itself.
 *
 * The patch draws into the composer's HalfFloat target, and `RenderPipeline`'s
 * output pass tonemaps that whole buffer through ACES at exposure 1.10 and
 * then encodes sRGB. Writing `0.23, 0.09, 0.38` — which reads as a dark violet
 * when you type it — therefore puts `#9759b7` on screen: a bright lavender.
 * That was the wash. Each constant below is the numeric solution of
 * `sRGB(ACES(x)) = target` for the target in its comment, so the swatch in the
 * comment is what a player actually sees.
 *
 * Everything stays far below the 1.25 bloom threshold. The veins read against
 * a fill that is genuinely dark — a 10x contrast ratio — rather than by being
 * bright, which is the only kind of emissive restraint that survives a
 * pre-tonemap bloom pass.
 */
const BlightFrag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uRadius;
uniform float uMaxR;
uniform float uNoise;
uniform float uBand;
varying vec2 vUv;
varying float vTear;

const vec3 FILL_IN   = vec3(0.0253, 0.0115, 0.0360);   // #1b0c26 on screen
const vec3 FILL_OUT  = vec3(0.0419, 0.0166, 0.0665);   // #2b1340
const vec3 VEIN_COOL = vec3(0.1522, 0.0640, 0.5040);   // #7a46c8
const vec3 VEIN_HOT  = vec3(0.3424, 0.0637, 0.5814);   // #b64ad0
const vec3 RIM       = vec3(0.4428, 0.0433, 0.2485);   // #c8379b

// Cheap hash / value noise. No texture fetch, no derivatives.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// The angular variant wraps its x axis so the seam at 0 = 2pi matches instead
// of tearing. Only the rim needs this; the vein field is cartesian and seamless
// by construction.
float anoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  const float W = 16.0;                        // angular period, in cells
  float x0 = mod(i.x, W), x1 = mod(i.x + 1.0, W);
  return mix(mix(hash(vec2(x0, i.y)), hash(vec2(x1, i.y)), f.x),
             mix(hash(vec2(x0, i.y + 1.0)), hash(vec2(x1, i.y + 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  return (vnoise(p) * 0.5
        + vnoise(p * 2.03 + vec2(17.3, 5.1)) * 0.25
        + vnoise(p * 4.11 + vec2(41.7, 23.9)) * 0.125) / 0.875;
}

void main() {
  if (vTear > 0.92) discard;                   // spanning a drop, not lying on ground
  float r = vUv.x * uMaxR;                     // metres from the seed
  if (r > uRadius) discard;                    // uRadius is the hard outer bound
  float ang = vUv.y / 6.2831853;               // turns, 0..1
  float t = uTime + uNoise;

  // The rim eats inward by an animated, per-angle amount, so the border is
  // ragged and creeping rather than a compass circle. It only ever bites in,
  // which keeps uRadius exactly the reach the sim thinks the patch has.
  float bite = anoise(vec2(ang * 16.0, t * 0.35)) * 0.10
             + anoise(vec2(ang * 32.0, t * 0.7)) * 0.05;
  float edge = uRadius * (1.0 - bite);
  if (r > edge) discard;

  float rn = r / max(edge, 0.001);             // 0 at the seed, 1 at the rim

  // Veins. The old field was two sin(angle) ridges, which is constant along
  // every ray from the seed — so however it drifted it could only ever resolve
  // into spokes. This one lives in the patch's own cartesian metres, where no
  // direction is special: a domain-warped ridged fbm, i.e. filaments running
  // along the level sets of a warped noise field. They meander, branch and
  // close loops because the field does, and they have no idea where the centre
  // is. The two warp axes drift at different rates and against each other, so
  // the field kneads rather than sliding past as a rigid pattern.
  vec2 p = vec2(cos(vUv.y), sin(vUv.y)) * r;
  vec2 warp = vec2(fbm(p * 0.30 + vec2(0.0, t * 0.060)),
                   fbm(p * 0.30 + vec2(4.7, -t * 0.045)));
  float n = fbm(p * 0.55 + (warp - 0.5) * 2.6);
  // A filament is the level set of that field, taken at a fixed width in field
  // units. The obvious pow(ridge, k) does not work here: an fbm of value noise
  // piles up around 0.5, so the ridge term is near 1 across most of the disc
  // and floods the interior with emissive instead of drawing lines. Distance to
  // the level set gives filaments the same thickness wherever the field is
  // locally flat, which is what makes them read as veins rather than as glow.
  float d = abs(n - 0.5);
  // A pulse that travels *along* the filaments: driven by the field value, so
  // it runs down a vein rather than sweeping across the patch.
  float pulse = 0.55 + 0.45 * vnoise(vec2(n * 7.0 - t * 0.85, t * 0.2));
  float vein = smoothstep(0.055, 0.008, d) * pulse * (0.30 + 0.70 * rn);

  // Edge band: the outer eighth, lit by a noise field that slides around the
  // rim. This "alive at the border" read is what says spreading, not painted.
  // It is deliberately dim — a rim bright enough to notice on its own turns the
  // patch into a glowing ring with a hole in it.
  float band = smoothstep(0.86, 1.0, rn);
  float crawl = 0.45 + 0.55 * anoise(vec2(ang * 16.0 + t * 0.6, t * 1.1));

  // The same warped field mottles the fill, so the interior pools and thins
  // instead of reading as one flat disc of colour.
  vec3 fill = mix(FILL_IN, FILL_OUT, rn) * (0.70 + 0.60 * n);
  vec3 veinC = mix(VEIN_COOL, VEIN_HOT, min(uBand / 4.0, 1.0));
  vec3 col = fill + veinC * vein + RIM * band * crawl * (0.18 + uBand * 0.05);

  // Nearly opaque in the middle, thinning outward. The fill is darker than most
  // ground it lands on, so every point of alpha it gives away reads directly as
  // the patch getting brighter — the opacity is a colour control here as much
  // as a blend one, and it is also what makes the middle read as pooled.
  float alpha = (0.90 - rn * 0.12 + vein * 0.10 + band * crawl * 0.12)
              * (1.0 - vTear);                 // dissolve where the grid stands up
  gl_FragColor = vec4(col, alpha);
}
`;

/**
 * A radial grid draped over the heightfield at build time. The mesh sits at
 * the origin with world-space vertices, so growth never re-tessellates: the
 * shader masks the visible radius with uRadius while the geometry already
 * covers maxR.
 *
 * Two details earn their vertices. The seam column is duplicated (uv.y runs
 * 0..2pi inclusive) so the last wedge interpolates the angle forward instead
 * of unwinding the whole turn across one quad. And ring 0 is a degenerate ring
 * of coincident centre vertices rather than a triangle fan, so every wedge
 * carries its own angle right down to the seed instead of pinwheeling into a
 * single uv.y = 0.
 *
 * Each vertex also carries `aTear` — how steeply the sheet leans to reach its
 * own neighbours (see TEAR). The geometry still drapes everywhere; the
 * attribute is what lets the shader stop *drawing* the spans that are leaning
 * rather than lying, which is cheaper and less brittle than decimating the
 * grid and keeps the mesh a fixed size for pooling.
 */
export function buildPatchGeometry(x, z, maxR, sampleHeight) {
  const verts = [];
  const uvs = [];
  const idx = [];
  const ground = [];                    // sampled height per vertex, for the tear pass
  const cols = SEGMENTS + 1;
  const ringStep = maxR / RINGS;
  for (let r = 0; r <= RINGS; r++) {
    const rad = (r / RINGS) * maxR;
    for (let s = 0; s < cols; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const wx = x + Math.cos(a) * rad;
      const wz = z + Math.sin(a) * rad;
      const h = sampleHeight ? sampleHeight(wx, wz) : 0;
      ground.push(h);
      verts.push(wx, h + LIFT, wz);
      uvs.push(rad / maxR, a);
    }
  }

  // How steeply the sheet has to lean to reach each neighbour it is joined to.
  // The steepest such span is what decides whether this vertex is part of a
  // drape or part of a curtain, so it is a max, not an average: one vertical
  // edge is enough to stand a quad up, and averaging would hide it behind
  // three flat ones.
  const tear = new Float32Array(ground.length);
  const span = 1 / Math.max(TEAR.hi - TEAR.lo, 1e-6);
  for (let r = 0; r <= RINGS; r++) {
    // Chord between adjacent columns on this ring — zero on the degenerate
    // centre ring, where the angular neighbours are the same point and carry
    // no slope information.
    const chord = 2 * Math.sin(Math.PI / SEGMENTS) * (r / RINGS) * maxR;
    for (let s = 0; s < cols; s++) {
      const i = r * cols + s;
      let slope = 0;
      if (r > 0) slope = Math.max(slope, Math.abs(ground[i] - ground[i - cols]) / ringStep);
      if (r < RINGS) slope = Math.max(slope, Math.abs(ground[i] - ground[i + cols]) / ringStep);
      if (chord > 1e-6) {
        if (s > 0) slope = Math.max(slope, Math.abs(ground[i] - ground[i - 1]) / chord);
        if (s < cols - 1) slope = Math.max(slope, Math.abs(ground[i] - ground[i + 1]) / chord);
      }
      const u = Math.min(Math.max((slope - TEAR.lo) * span, 0), 1);
      tear[i] = u * u * (3 - 2 * u);     // smoothstep, so the dissolve has no hard step
    }
  }

  for (let r = 0; r < RINGS; r++) {
    const a0 = r * cols, b0 = (r + 1) * cols;
    for (let s = 0; s < SEGMENTS; s++) {
      idx.push(a0 + s, b0 + s, b0 + s + 1, a0 + s, b0 + s + 1, a0 + s + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aTear', new THREE.BufferAttribute(tear, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The crawl: a dark violet fill, emissive filament veins, and a ragged edge
 * that creeps. uv.x carries normalized radius, uv.y the angle, so the fragment
 * shader needs no world math — it rebuilds patch-local cartesian metres from
 * the two when it needs a direction-free field.
 *
 * Colours are the ACES-solved derivation of the HUD band ramp, not the ramp's
 * own hex values. The gauge is a DOM element that draws its ramp straight to
 * screen; the patch draws through a tonemapped HDR buffer, so the two cannot
 * share literals and agree. Each constant below is solved so the *screen*
 * colour is the ramp's family, and the darker landing is deliberate — the
 * ground is lit by nothing and read at a glance, the gauge is a lit UI chip:
 *
 *   ramp `#7a4fd0` -> VEIN_COOL `#7a46c8`   (as near as the fit lands)
 *   ramp `#c72fd6` -> VEIN_HOT  `#b64ad0`
 *   ramp `#ff2fb0` -> RIM       `#c8379b`   (~22% darker, on purpose: a rim at
 *                                            full ramp value blooms and eats
 *                                            the vein contrast it frames)
 *
 * So changing `hud.css`'s ramp will NOT move the ground. The two are matched by
 * eye at band 4, not by a shared constant, and re-matching is a manual step.
 */
export function makeBlightMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: RADIUS.base },
      uMaxR: { value: RADIUS.cap },
      uNoise: { value: 0 },
      uBand: { value: 0 },
    },
    vertexShader: BlightVert,
    fragmentShader: BlightFrag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // Draped over arbitrary terrain and seen from a roaming camera; culling by
    // winding buys nothing here and costs a vanished patch on a back slope.
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

export class Blight {
  constructor() {
    this.patches = [];
    this.band = 0;
    this.ctx = null;
    // Recycled meshes keep their material and shader program; only the draped
    // geometry is rebuilt per seed.
    this._meshPool = [];
    // Grade blend state. `_satBase` is the pipeline's own saturation, latched
    // the first time we touch it; `_sat` / `_vig` are the offsets currently
    // blended in, never the absolute values.
    this._satBase = null;
    this._sat = 0;
    this._vig = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.blight = this;
    ctx.events.on('blightSeed', (s) => this._addPatch(s));
    ctx.events.on('corruptionBand', (e) => { if (Number.isFinite(e?.band)) this.band = e.band; });
    ctx.events.on('stageStart', () => this._clear());
  }

  /**
   * A malformed seed is dropped, not clamped. A non-finite x/z builds a NaN
   * bounding sphere — and since every comparison against NaN is false, the
   * frustum reports it visible on every frame forever — plus a NaN `uRadius`,
   * which turns the fragment shader's `r > uRadius` discard *off* and shades
   * the full cap-sized disc. Nothing throws on that path, so nothing would
   * surface it. `Corruption.seed` cannot produce one today; the moment blight
   * seeds cross the wire, the payload stops being trusted.
   */
  _addPatch(seed) {
    const x = seed?.x, z = seed?.z, strength = seed?.strength;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (!Number.isFinite(strength) || strength <= 0) return;
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

  // Headless runs (tests, servers) have no scene: the registry is real either
  // way, and the patch simply never grows a mesh.
  _build(patch) {
    const ctx = this.ctx;
    if (!ctx.scene) return;
    const sample = ctx.stage?.sampleHeight ? (x, z) => ctx.stage.sampleHeight(x, z) : null;
    const mesh = this._meshPool.pop() || new THREE.Mesh(undefined, makeBlightMaterial());
    mesh.geometry?.dispose();
    mesh.geometry = buildPatchGeometry(patch.x, patch.z, patch.maxR, sample);
    const u = mesh.material.uniforms;
    u.uNoise.value = patch.seedNoise;
    u.uMaxR.value = patch.maxR;
    u.uRadius.value = radiusOf(patch.strength, ctx.corruption?.world || 0);
    u.uBand.value = this.band;
    mesh.renderOrder = 1;   // over terrain, under transparent VFX bursts
    mesh.name = 'blight.patch';
    ctx.scene.add(mesh);
    patch.mesh = mesh;
  }

  update(ctx, dt) {
    const world = ctx.corruption?.world || 0;
    for (let i = 0; i < this.patches.length; i++) {
      const p = this.patches[i];
      const m = p.mesh;
      if (!m) continue;
      const u = m.material.uniforms;
      const target = radiusOf(p.strength, world);
      // The spread is gameplay time, not wall clock. `update` runs every frame
      // regardless of `ctx.paused` (the Engine gates only the fixedUpdate
      // accumulator), and `uTime` rides `ctx.time`, which does freeze — so
      // growing on the raw frame `dt` would spend the whole 2 -> 14 m crawl
      // behind an open menu while the crawl *animation* stood still.
      if (!ctx.paused && u.uRadius.value < target) {
        u.uRadius.value = Math.min(target, u.uRadius.value + GROW_RATE * dt);
      }
      u.uTime.value = ctx.time;
      u.uBand.value = this.band;
    }
    this._grade(ctx, dt);
  }

  /**
   * The screen itself sickens. Rides the existing grade pass rather than adding
   * one: saturation comes off `passes.grade`, the vignette off the pipeline's
   * own `vignetteBoost` (which is what feeds `uVignette` — writing that uniform
   * directly would be overwritten by the pipeline on the same frame).
   *
   * Two rules keep this a good neighbour. Everything is an offset from a
   * baseline latched on first touch, so no other system's grade is destroyed
   * and band 0 gives it back exactly. And the vignette is a *floor*
   * (`Math.max`), not an assignment: `RenderPipeline.update` damps
   * `vignetteBoost` toward zero every frame and VFX writes absolute spikes into
   * it (0.9 on death), so assigning would stomp a death vignette mid-fade and
   * summing would ratchet against the damp into a value nobody chose. A floor
   * lets the loudest writer win and re-asserts the band's own level once the
   * transient has decayed past it.
   *
   * The cost, stated exactly because it is easy to mis-round: the band floor is
   * written in the `update` phase, and `RenderPipeline.update` then applies its
   * own `damp(vignetteBoost, 0, 0.98, dt)` before reading the result into
   * `uVignette`. So one frame of decay always eats part of the floor, and the
   * bite is frame-rate dependent — the damp retains `1 - 0.02^dt` per frame:
   *
   *   60Hz -> 93.7% retained -> band 4 lands 0.187 against a nominal 0.20 (6.4% under)
   *   30Hz -> 87.7% retained -> the same band lands ~12% under
   *
   * That is a real coupling between the player's frame rate and the band's
   * on-screen intensity, not a rounding artifact. It is left in: the alternative
   * is pre-compensating by the damp's own constant, which would couple this
   * system to a pipeline internal it currently only writes through, and the
   * magnitude is well under what the 2.5 s blend makes perceptible. Anyone
   * tuning `BAND_GRADE` should read the vignette numbers as nominal-minus-6%.
   */
  _grade(ctx, dt) {
    const pipe = ctx.pipeline;
    const gradeU = pipe?.passes?.grade?.uniforms;
    if (!gradeU?.uSaturation) return;
    if (this._satBase == null) this._satBase = gradeU.uSaturation.value;

    const g = BAND_GRADE[Math.min(this.band, BAND_GRADE.length - 1)] || BAND_GRADE[0];
    this._sat = settle(this._sat, g.sat, dt);
    this._vig = settle(this._vig, g.vignette, dt);

    gradeU.uSaturation.value = this._satBase + this._sat;
    pipe.vignetteBoost = Math.max(pipe.vignetteBoost || 0, this._vig);
  }

  _recycle(patch) {
    const mesh = patch.mesh;
    if (!mesh) return;
    this.ctx.scene?.remove(mesh);
    if (this._meshPool.length < POOL_MAX) this._meshPool.push(mesh);
    else { mesh.geometry.dispose(); mesh.material.dispose(); }
    patch.mesh = null;
  }
}
