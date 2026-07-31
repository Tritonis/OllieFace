import * as THREE from 'three';

/**
 * Projected decals on a fixed budget.
 *
 * One InstancedMesh, one draw call, a ring buffer of oriented quads. Age-out
 * and fade are computed in the vertex shader from a spawn timestamp, so a decal
 * costs exactly one matrix write at placement and nothing thereafter.
 *
 * These are oriented quads snapped to the surface normal rather than true
 * box-projected decals. On stylised terrain the difference is invisible and it
 * saves a per-decal geometry clip.
 */

const ATLAS_COLS = 4;
const ATLAS_TILE = 128;

export const DECAL = {
  BULLET: { frame: 0, variants: 2, size: 0.22, life: 30, color: 0x141014 },
  CRACK: { frame: 2, variants: 2, size: 0.5, life: 25, color: 0x18161c },
  SCORCH: { frame: 4, variants: 3, size: 1.6, life: 26, color: 0x0d0a09 },
  BLOOD: { frame: 8, variants: 4, size: 0.75, life: 22, color: 0x5a0a10 },
  SPLAT: { frame: 12, variants: 2, size: 1.3, life: 22, color: 0x47070d },
  GLOW: { frame: 14, variants: 2, size: 1.0, life: 3, color: 0xff8844 },
};

const DecalVert = /* glsl */ `
attribute float aFrame;
attribute vec3 aTint;
attribute vec2 aTime;
uniform float uTime;
uniform float uAtlasCols;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float age = uTime - aTime.x;
  if (age < 0.0 || age >= aTime.y || aTime.y <= 0.0) {
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float k = age / aTime.y;
  float a = smoothstep(0.0, 0.015, k) * (1.0 - smoothstep(0.55, 1.0, k));
  vColor = vec4(aTint, a);
  float cols = uAtlasCols;
  float f = floor(aFrame + 0.5);
  vUv = (uv + vec2(mod(f, cols), floor(f / cols))) / cols;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const DecalFrag = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uIntensity;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vColor.a;
  if (a < 0.006) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb * uIntensity, a);
}
`;

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _roll = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _color = new THREE.Color();
const _dir = new THREE.Vector3();

export class Decals {
  constructor({ capacity = 192 } = {}) {
    this.capacity = capacity;
    this.head = 0;
    this.time = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    const map = makeDecalAtlas();
    const geo = new THREE.PlaneGeometry(1, 1);

    this.aFrame = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.aTime = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2);
    for (const a of [this.aFrame, this.aTint, this.aTime]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFrame', this.aFrame);
    geo.setAttribute('aTint', this.aTint);
    geo.setAttribute('aTime', this.aTime);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uTime: { value: 0 },
        uAtlasCols: { value: ATLAS_COLS },
        uIntensity: { value: 1 },
      },
      vertexShader: DecalVert,
      fragmentShader: DecalFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.mat, this.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'vfx.decals';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // Park every slot as expired so nothing shows before the first placement.
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    ctx.scene.add(this.mesh);
  }

  /**
   * Place a decal at a known surface point.
   * `kind` is a DECAL entry; `opts` overrides size / life / colour.
   */
  place(point, normal, kind = DECAL.BULLET, opts = {}) {
    if (!this.mesh) return;
    const rng = this.ctx.rng;
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;

    _n.copy(normal);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0); else _n.normalize();
    _q.setFromUnitVectors(_up, _n);
    _roll.setFromAxisAngle(_up, rng.next() * Math.PI * 2);
    _q.multiply(_roll);

    const size = (opts.size ?? kind.size) * (0.8 + rng.next() * 0.45);
    _scale.set(size, size, size);
    _pos.copy(point).addScaledVector(_n, 0.025);
    _m.compose(_pos, _q, _scale);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.aFrame.array[i] = kind.frame + (kind.variants > 1 ? rng.int(0, kind.variants - 1) : 0);
    _color.set(opts.color ?? kind.color);
    this.aTint.array[i * 3] = _color.r;
    this.aTint.array[i * 3 + 1] = _color.g;
    this.aTint.array[i * 3 + 2] = _color.b;
    this.aTime.array[i * 2] = this.time;
    this.aTime.array[i * 2 + 1] = (opts.life ?? kind.life) * (0.85 + rng.next() * 0.3);

    this.aFrame.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.aTime.needsUpdate = true;
  }

  /**
   * Drop a decal onto whatever the world puts under `origin` along `dir`.
   * Silently does nothing if the world isn't up yet or nothing was hit.
   */
  project(origin, dir, kind = DECAL.SCORCH, opts = {}) {
    const stage = this.ctx?.stage;
    if (!stage?.raycast) return;
    _dir.copy(dir);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, -1, 0); else _dir.normalize();
    const hit = stage.raycast(origin, _dir, opts.maxDist ?? 6);
    if (!hit) return;
    this.place(hit.point, hit.normal, kind, opts);
  }

  update(ctx, dt) {
    this.time += dt;
    if (this.mat) this.mat.uniforms.uTime.value = this.time;
  }
}

/* ------------------------------------------------------------------ */

function makeDecalAtlas() {
  const size = ATLAS_COLS * ATLAS_TILE;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');

  const drawers = [
    (c, s) => bulletHole(c, s, 11),
    (c, s) => bulletHole(c, s, 77),
    (c, s) => crackStar(c, s, 5),
    (c, s) => crackStar(c, s, 91),
    (c, s) => scorch(c, s, 3),
    (c, s) => scorch(c, s, 41),
    (c, s) => scorch(c, s, 202),
    (c, s) => scorch(c, s, 808),
    (c, s) => splat(c, s, 12, 0.55),
    (c, s) => splat(c, s, 33, 0.6),
    (c, s) => splat(c, s, 64, 0.5),
    (c, s) => splat(c, s, 128, 0.65),
    (c, s) => splat(c, s, 256, 0.8),
    (c, s) => splat(c, s, 512, 0.85),
    (c, s) => glowRing(c, s),
    (c, s) => glowBlob(c, s),
  ];

  for (let i = 0; i < 16; i++) {
    const x = (i % ATLAS_COLS) * ATLAS_TILE;
    const y = Math.floor(i / ATLAS_COLS) * ATLAS_TILE;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, ATLAS_TILE, ATLAS_TILE);
    g.clip();
    drawers[i](g, ATLAS_TILE);
    g.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function lcg(seed) {
  let h = seed >>> 0 || 1;
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

function bulletHole(g, s, seed) {
  const r = s * 0.5;
  const rnd = lcg(seed);
  const grad = g.createRadialGradient(r, r, 0, r, r, r * 0.62);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.92)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r * 0.62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.4)';
  g.lineWidth = s * 0.012;
  for (let i = 0; i < 7; i++) {
    const a = rnd() * Math.PI * 2;
    const l = r * (0.3 + rnd() * 0.6);
    g.beginPath();
    g.moveTo(r + Math.cos(a) * r * 0.22, r + Math.sin(a) * r * 0.22);
    g.lineTo(r + Math.cos(a) * l, r + Math.sin(a) * l);
    g.stroke();
  }
}

function crackStar(g, s, seed) {
  const r = s * 0.5;
  const rnd = lcg(seed);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineCap = 'round';
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + rnd() * 0.4;
    let x = r, y = r;
    g.lineWidth = s * (0.022 - i * 0.0008);
    g.beginPath();
    g.moveTo(x, y);
    const segs = 3;
    for (let k = 1; k <= segs; k++) {
      const l = (r * 0.92 * k) / segs;
      const aa = a + (rnd() - 0.5) * 0.5;
      x = r + Math.cos(aa) * l;
      y = r + Math.sin(aa) * l;
      g.lineTo(x, y);
    }
    g.stroke();
  }
}

function scorch(g, s, seed) {
  const rnd = lcg(seed);
  const r = s * 0.5;
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * r * 0.42;
    const cx = r + Math.cos(a) * d, cy = r + Math.sin(a) * d;
    const rr = r * (0.22 + rnd() * 0.34);
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    grad.addColorStop(0, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.16)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, rr, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  // Feather the border so tiled scorch never shows a square edge.
  const fade = g.createRadialGradient(r, r, r * 0.55, r, r, r);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = fade;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
}

function splat(g, s, seed, spread) {
  const rnd = lcg(seed);
  const r = s * 0.5;
  g.fillStyle = 'rgba(255,255,255,1)';
  // Main irregular body.
  g.beginPath();
  const pts = 13;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const rr = r * (0.34 + rnd() * 0.28) * (1 + spread * 0.2);
    const x = r + Math.cos(a) * rr, y = r + Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  // Satellite droplets sell it as a splat rather than a stain.
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2;
    const d = r * (0.35 + rnd() * 0.6 * spread);
    const rr = s * (0.006 + rnd() * 0.03);
    if (d + rr > r) continue;
    g.globalAlpha = 0.45 + rnd() * 0.55;
    g.beginPath();
    g.ellipse(r + Math.cos(a) * d, r + Math.sin(a) * d, rr, rr * (0.6 + rnd() * 0.8), a, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

function glowRing(g, s) {
  const r = s * 0.5;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.1)');
  grad.addColorStop(0.85, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}

function glowBlob(g, s) {
  const r = s * 0.5;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.3)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}
