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
export const GROW_RATE = 1.2;   // metres per second — visible spread, not a pop

export function radiusOf(strength, world) {
  return Math.min(RADIUS.base + RADIUS.perStrength * strength + RADIUS.perWorld * world, RADIUS.cap);
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

const BlightVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BlightFrag = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uRadius;
uniform float uMaxR;
uniform float uNoise;
uniform float uBand;
varying vec2 vUv;

// Cheap hash / value noise, wrapped in the angular axis so the seam at 0 = 2pi
// matches instead of tearing. No texture fetch, no derivatives.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  const float W = 16.0;                        // angular period, in cells
  float x0 = mod(i.x, W), x1 = mod(i.x + 1.0, W);
  float a = hash(vec2(x0, i.y));
  float b = hash(vec2(x1, i.y));
  float c = hash(vec2(x0, i.y + 1.0));
  float d = hash(vec2(x1, i.y + 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float r = vUv.x * uMaxR;                     // metres from the seed
  if (r > uRadius) discard;                    // uRadius is the hard outer bound
  float ang = vUv.y / 6.2831853;               // turns, 0..1
  float t = uTime + uNoise;

  // The rim eats inward by an animated, per-angle amount, so the border is
  // ragged and creeping rather than a compass circle. It only ever bites in,
  // which keeps uRadius exactly the reach the sim thinks the patch has.
  float bite = vnoise(vec2(ang * 16.0, t * 0.35)) * 0.10
             + vnoise(vec2(ang * 32.0, t * 0.7)) * 0.05;
  float edge = uRadius * (1.0 - bite);
  if (r > edge) discard;

  float rn = r / max(edge, 0.001);             // 0 at the seed, 1 at the rim

  // Veins: two angular ridge fields drifting outward at different rates, so
  // the crawl never resolves into a spoke pattern.
  float v1 = pow(abs(sin(vUv.y * 7.0 + r * 1.1 - t * 0.9)), 8.0);
  float v2 = pow(abs(sin(vUv.y * 13.0 - r * 1.9 + t * 1.5)), 12.0);
  float vein = (v1 * 0.7 + v2 * 0.5) * (0.35 + 0.65 * rn);

  // Edge band: the outer fifth, lit by a noise field that slides around the
  // rim. This "alive at the border" read is what says spreading, not painted.
  float band = smoothstep(0.80, 1.0, rn);
  float crawl = 0.45 + 0.55 * vnoise(vec2(ang * 16.0 + t * 0.6, t * 1.1));

  vec3 fill = mix(vec3(0.10, 0.05, 0.19), vec3(0.23, 0.09, 0.38), rn);
  vec3 veinC = mix(vec3(0.48, 0.25, 0.82), vec3(0.78, 0.18, 0.84), min(uBand / 4.0, 1.0));
  vec3 edgeC = vec3(1.0, 0.18, 0.69);
  vec3 col = fill + veinC * vein * 0.6 + edgeC * band * crawl * (0.5 + uBand * 0.12);

  float alpha = 0.78 - rn * 0.12 + band * crawl * 0.22;
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
 */
export function buildPatchGeometry(x, z, maxR, sampleHeight) {
  const verts = [];
  const uvs = [];
  const idx = [];
  const cols = SEGMENTS + 1;
  for (let r = 0; r <= RINGS; r++) {
    const rad = (r / RINGS) * maxR;
    for (let s = 0; s < cols; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const wx = x + Math.cos(a) * rad;
      const wz = z + Math.sin(a) * rad;
      verts.push(wx, (sampleHeight ? sampleHeight(wx, wz) : 0) + LIFT, wz);
      uvs.push(rad / maxR, a);
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
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The crawl: a dark violet fill, emissive veins that pulse along the radius,
 * and a ragged edge that creeps. uv.x carries normalized radius, uv.y the
 * angle, so the fragment shader needs no world math. Colors are the HUD band
 * ramp so gauge and ground agree.
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
      if (u.uRadius.value < target) {
        u.uRadius.value = Math.min(target, u.uRadius.value + GROW_RATE * dt);
      }
      u.uTime.value = ctx.time;
      u.uBand.value = this.band;
    }
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
