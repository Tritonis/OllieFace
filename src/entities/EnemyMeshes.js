// Procedural enemy rigs + procedural animation.
//
// No external models. Every monster is assembled from primitives, and rigid
// clusters (a torso and its plates, a shin and its foot) are pre-merged into a
// single cached BufferGeometry so a 60-strong horde costs ~10 draw calls per
// unit instead of ~30. Geometries and materials are shared across every
// instance; only the Object3D hierarchy is per-instance, and that is pooled.
//
// Rig layout is always:
//   root   — owned by Enemy (world position + facing yaw)
//   pivot  — owned by the animator (lean, sink, squash, death collapse)
//   parts  — the animated hierarchy
//
// Animation is driven by a plain `anim` struct the Enemy fills each frame, so
// the mesh code never reaches back into gameplay state.
//
// The animation language is deliberately RoR2-ish: every attack has a legible
// ANTICIPATION (pull back, crouch, glow builds) before the commit, and a
// FOLLOW-THROUGH (overshoot, recoil, settle) after it. That contrast is what
// makes a horde readable instead of noisy.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp } from '../core/MathUtil.js';

// ---------------------------------------------------------------------------
// geometry cache
// ---------------------------------------------------------------------------

const GEO = new Map();
function cache(key, make) {
  let g = GEO.get(key);
  if (!g) { g = make(); GEO.set(key, g); }
  return g;
}

const box = (w, h, d) => cache(`b${w}_${h}_${d}`, () => new THREE.BoxGeometry(w, h, d));
const sph = (r, s = 10, t = 7) => cache(`s${r}_${s}_${t}`, () => new THREE.SphereGeometry(r, s, t));
const hemi = (r, s = 12, t = 6) =>
  cache(`h${r}_${s}_${t}`, () => new THREE.SphereGeometry(r, s, t, 0, Math.PI * 2, 0, Math.PI * 0.5));
const cyl = (rt, rb, h, s = 8) => cache(`c${rt}_${rb}_${h}_${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s));
const cone = (r, h, s = 7) => cache(`k${r}_${h}_${s}`, () => new THREE.ConeGeometry(r, h, s));
const ico = (r, d = 0) => cache(`i${r}_${d}`, () => new THREE.IcosahedronGeometry(r, d));
const ring = (r, t, s = 5, ts = 24) => cache(`t${r}_${t}_${s}_${ts}`, () => new THREE.TorusGeometry(r, t, s, ts));
// 8 length segments so the near-plane taper in the beam shader has vertices to
// bend; unit-sized, the mesh scale carries width and length.
const quad = () => cache('q1', () => new THREE.PlaneGeometry(1, 1, 1, 8));

/** Piece descriptor for `merged()`. Built once at load, never at runtime. */
function P(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return { g, x, y, z, rx, ry, rz, sx, sy, sz };
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _p3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

/** Bake a list of transformed primitives into one shared geometry. */
function merged(key, pieces) {
  return cache(`m:${key}`, () => {
    const list = [];
    for (const p of pieces) {
      const c = p.g.index ? p.g.toNonIndexed() : p.g.clone();
      _eu.set(p.rx, p.ry, p.rz);
      _q.setFromEuler(_eu);
      _m4.compose(_p3.set(p.x, p.y, p.z), _q, _s3.set(p.sx, p.sy, p.sz));
      c.applyMatrix4(_m4);
      list.push(c);
    }
    const out = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) for (const c of list) c.dispose();
    return out;
  });
}

/** Mirror a piece list across X (for the left-hand side of a body). */
function mirror(pieces) {
  const out = [];
  for (const p of pieces) out.push(P(p.g, -p.x, p.y, p.z, p.rx, -p.ry, -p.rz, p.sx, p.sy, p.sz));
  return out;
}

// ---------------------------------------------------------------------------
// palettes + materials
// ---------------------------------------------------------------------------

const PALETTE = {
  lemurian: { body: 0x8a3f2c, dark: 0x38180f, accent: 0xff5a12, eye: 0xffc23a },
  beetle:   { body: 0x77705a, dark: 0x2b2820, accent: 0xc4d044, eye: 0xe9ff5a },
  wisp:     { body: 0x2c1a34, dark: 0x120a18, accent: 0xff7a1e, eye: 0xffd9a0 },
  golem:    { body: 0x646b78, dark: 0x282c34, accent: 0x22d3ff, eye: 0xa8f2ff },
  pest:     { body: 0xa03f7e, dark: 0x3a1330, accent: 0xff3566, eye: 0xffd0e2 },
  titan:    { body: 0x6d7480, dark: 0x2c3038, accent: 0xffa514, eye: 0xffe08a },
};

/** RoR2's tier-1 elite affixes. Each one repaints the whole silhouette. */
export const ELITE = {
  blazing:     { tint: 0xff3a08, aura: 0xff6a10, glow: 2.6, name: 'Blazing' },
  overloading: { tint: 0x2f5cff, aura: 0x74a6ff, glow: 2.8, name: 'Overloading' },
  glacial:     { tint: 0xa8e6ff, aura: 0x8fe4ff, glow: 2.2, name: 'Glacial' },
};

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
function mixHex(a, b, t) {
  _c1.setHex(a);
  _c2.setHex(b);
  return _c1.lerp(_c2, t).getHex();
}

const MATS = new Map();
function matsFor(id, affix) {
  const key = `${id}:${affix || '-'}`;
  let m = MATS.get(key);
  if (m) return m;
  const p = PALETTE[id] || PALETTE.beetle;
  const e = affix ? ELITE[affix] : null;
  const bodyC = e ? mixHex(p.body, e.tint, 0.78) : p.body;
  const darkC = e ? mixHex(p.dark, e.tint, 0.45) : p.dark;
  const accC = e ? e.aura : p.accent;
  const eyeC = e ? mixHex(p.eye, e.aura, 0.8) : p.eye;
  m = {
    body: new THREE.MeshStandardMaterial({
      color: bodyC, roughness: 0.82, metalness: 0.04, flatShading: true,
      emissive: e ? e.tint : 0x000000, emissiveIntensity: e ? 0.5 : 0,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: darkC, roughness: 0.9, metalness: 0.02, flatShading: true,
      emissive: e ? e.tint : 0x000000, emissiveIntensity: e ? 0.28 : 0,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: accC, roughness: 0.4, metalness: 0, emissive: accC,
      emissiveIntensity: e ? e.glow : 1.7,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: eyeC, roughness: 0.3, metalness: 0, emissive: eyeC,
      emissiveIntensity: e ? e.glow * 1.2 : 2.4,
    }),
  };
  MATS.set(key, m);
  return m;
}

// One shared white material for the hit flash — swapping material references is
// free, whereas mutating a shared material would flash the whole horde.
const FLASH = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });

const AURA = new Map();
function auraMat(affix) {
  let m = AURA.get(affix);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({
    color: ELITE[affix] ? ELITE[affix].aura : 0xffffff,
    transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.BackSide, fog: false,
  });
  AURA.set(affix, m);
  return m;
}
function bitMat(affix) {
  const k = `bit:${affix}`;
  let m = AURA.get(k);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({
    color: ELITE[affix] ? ELITE[affix].aura : 0xffffff,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.95, fog: false,
  });
  AURA.set(k, m);
  return m;
}

const BEAM = new Map();

// A beam is a camera-facing quad, not a tube: a scaled solid cylinder shows its
// polygon silhouette the moment it gets near the lens, and an attack aimed at
// the player is aimed at the camera by definition. The quad is billboarded
// around its own axis in the vertex shader, and its half-width is clamped to a
// fixed on-screen angle so the near end tapers instead of filling the frame.
const BEAM_MAX_HALF_ANGLE = Math.tan(6 * Math.PI / 180);
// Hard ceiling on world diameter. The widest gameplay beam hitbox is 1.5 radius
// and the visual should read thinner than its hitbox, never wider.
const BEAM_MAX_WIDTH = 1.2;

const BEAM_VERT = /* glsl */`
uniform float uMaxAngle;
varying vec2 vBeamUv;
varying float vDist;
void main() {
  // Centreline point for this vertex's position along the beam.
  vec3 center = (modelMatrix * vec4(0.0, position.y, 0.0, 1.0)).xyz;
  vec3 dir = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 toCam = cameraPosition - center;
  float dist = length(toCam);
  vec3 side = cross(dir, toCam / max(dist, 1e-4));
  float sl = length(side);
  if (sl < 1e-4) {
    vec3 up = abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    side = normalize(cross(dir, up));
  } else {
    side /= sl;
  }
  float halfW = 0.5 * length((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  halfW = min(halfW, uMaxAngle * dist);
  vec3 p = center + side * (position.x * 2.0 * halfW);
  vBeamUv = vec2(position.x * 2.0, position.y + 0.5);
  vDist = dist;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const BEAM_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vBeamUv;
varying float vDist;
void main() {
  float r = min(abs(vBeamUv.x), 1.0);
  float edge = pow(1.0 - r, 2.2);           // soft radial falloff — no hard rim
  float core = pow(1.0 - r, 14.0);          // white-hot filament down the middle
  float along = mix(1.0, 0.32, vBeamUv.y);  // hot at the muzzle, cooling to the tip
  float near = smoothstep(0.5, 2.4, vDist); // fade out rather than swallow the lens
  float a = edge * along * near * uOpacity;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.85) * 1.25, a);
}`;

export function beamMat(id) {
  let m = BEAM.get(id);
  if (m) return m;
  const p = PALETTE[id] || PALETTE.golem;
  m = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(p.accent) },
      uOpacity: { value: 0.85 },
      uMaxAngle: { value: BEAM_MAX_HALF_ANGLE },
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  BEAM.set(id, m);
  return m;
}

// ---------------------------------------------------------------------------
// rig scaffolding
// ---------------------------------------------------------------------------

function newRig(id) {
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.add(pivot);
  const rig = {
    id, root, pivot,
    parts: {},
    body: [], dark: [], accent: [], eye: [],
    beams: [],
    crumble: [],
    aura: null, auraBits: null,
    affix: null, flashing: false,
    mats: matsFor(id, null),
    centerY: 1, height: 2, animate: null,
    setAffix, setFlash, beginDeath, resetRig,
  };
  return rig;
}

function add(rig, parent, slot, geo, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, rig.mats[slot]);
  m.position.set(x, y, z);
  rig[slot].push(m);
  parent.add(m);
  return m;
}

function grp(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/** A soft additive quad pointing +Z, scaled along its length at runtime. */
function beam(rig, parent, y = 0, z = 0) {
  const m = new THREE.Mesh(quad(), beamMat(rig.id));
  m.rotation.x = Math.PI * 0.5;
  m.position.set(0, y, z);
  m.visible = false;
  // Billboarded in the vertex shader, so the CPU-side bounds are meaningless.
  m.frustumCulled = false;
  rig.beams.push(m);
  parent.add(m);
  return m;
}

/** `width` is the beam's world-space diameter. */
function setBeam(m, length, width, on) {
  m.visible = on && length > 0.2 && width > 0.001;
  if (!m.visible) return;
  m.scale.set(Math.min(width, BEAM_MAX_WIDTH), length, 1);
  m.position.z = length * 0.5;
}

/** Register a part for the death-collapse crumble pass. */
function crumbles(rig, obj) {
  rig.crumble.push({ o: obj, b: obj.position.clone(), d: new THREE.Vector3(), s: new THREE.Vector3() });
  return obj;
}

function makeAura(rig, radius) {
  const a = new THREE.Mesh(ico(1, 2), auraMat('blazing'));
  a.scale.setScalar(radius);
  a.position.y = rig.centerY;
  a.visible = false;
  a.frustumCulled = false;
  rig.pivot.add(a);
  rig.aura = a;

  const bits = new THREE.Group();
  bits.position.y = rig.centerY;
  bits.visible = false;
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(ico(radius * 0.11, 0), bitMat('blazing'));
    const ang = (i / 5) * Math.PI * 2;
    b.position.set(Math.cos(ang) * radius, 0, Math.sin(ang) * radius);
    bits.add(b);
  }
  rig.pivot.add(bits);
  rig.auraBits = bits;
}

function applyMats(rig, m) {
  for (const x of rig.body) x.material = m.body;
  for (const x of rig.dark) x.material = m.dark;
  for (const x of rig.accent) x.material = m.accent;
  for (const x of rig.eye) x.material = m.eye;
}

function setAffix(affix) {
  this.affix = affix && ELITE[affix] ? affix : null;
  this.mats = matsFor(this.id, this.affix);
  if (!this.flashing) applyMats(this, this.mats);
  if (this.aura) {
    const on = !!this.affix;
    this.aura.visible = on;
    this.auraBits.visible = on;
    if (on) {
      this.aura.material = auraMat(this.affix);
      const bm = bitMat(this.affix);
      for (const b of this.auraBits.children) b.material = bm;
    }
  }
}

function setFlash(on) {
  if (on === this.flashing) return;
  this.flashing = on;
  if (on) {
    for (const x of this.body) x.material = FLASH;
    for (const x of this.dark) x.material = FLASH;
    for (const x of this.accent) x.material = FLASH;
    for (const x of this.eye) x.material = FLASH;
  } else {
    applyMats(this, this.mats);
  }
}

function beginDeath(rng) {
  for (const c of this.crumble) {
    c.d.set(rng.range(-1, 1), rng.range(-0.2, 1), rng.range(-1, 1)).normalize().multiplyScalar(rng.range(0.1, 0.35));
    c.s.set(rng.range(-2.4, 2.4), rng.range(-2.4, 2.4), rng.range(-2.4, 2.4));
  }
}

function resetRig() {
  this.pivot.position.set(0, 0, 0);
  this.pivot.rotation.set(0, 0, 0);
  this.pivot.scale.set(1, 1, 1);
  this.root.rotation.set(0, 0, 0);
  this.root.scale.set(1, 1, 1);
  this.root.visible = true;
  this.flashing = false;
  for (const c of this.crumble) {
    c.o.position.copy(c.b);
    c.o.rotation.set(0, 0, 0);
  }
  for (const b of this.beams) b.visible = false;
  this.setAffix(null);
}

// ---------------------------------------------------------------------------
// two-bone IK — the backbone of all the legwork
// ---------------------------------------------------------------------------

/**
 * Point a hip/knee pair at a target expressed in the hip's local frame
 * (`tz` forward, `ty` down-negative). `bend` +1 puts the knee forward,
 * -1 backward (digitigrade / insectoid).
 */
function solveLeg(hip, knee, l1, l2, tz, ty, bend) {
  let d = Math.hypot(tz, ty);
  const max = (l1 + l2) * 0.995;
  if (d > max) { const k = max / d; tz *= k; ty *= k; d = max; }
  if (d < 1e-3) d = 1e-3;
  const theta = Math.atan2(tz, -ty);
  const alpha = Math.acos(clamp((d * d + l1 * l1 - l2 * l2) / (2 * d * l1), -1, 1));
  const beta = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
  hip.rotation.x = -(theta + alpha * bend);
  knee.rotation.x = (Math.PI - beta) * bend;
}

/** Foot target for a walk cycle: forward while planted, lifted while swinging. */
function stepZ(phase, stride) { return Math.cos(phase) * stride; }
function stepY(phase, lift) { return Math.max(0, -Math.sin(phase)) * lift; }

/** Snappy attack curve: fast strike (0..0.22) then a slower settle. */
function strike(t) { return t < 0.22 ? t / 0.22 : 1 - (t - 0.22) / 0.78; }
/** Anticipation easing — slow build so the tell is readable. */
function anticipate(t) { return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------------------
// shared per-frame pass: hurt shove, death collapse, elite aura
// ---------------------------------------------------------------------------

function common(rig, a) {
  const pv = rig.pivot;
  const d = a.death;

  if (d > 0) {
    // Ragdoll-ish collapse: buckle, tip over, squash, and let the merged
    // clusters drift apart so heavy units read as "crumbling".
    const e = d * d;
    pv.rotation.x = a.fallX * Math.min(1.35, d * 1.6);
    pv.rotation.z = a.fallZ * Math.min(1.0, d * 1.3);
    pv.position.y = -rig.centerY * 0.42 * e;
    pv.scale.set(1 + 0.18 * e, Math.max(0.08, 1 - 0.55 * e), 1 + 0.18 * e);
    for (const c of rig.crumble) {
      c.o.position.set(c.b.x + c.d.x * e, c.b.y + c.d.y * e, c.b.z + c.d.z * e);
      c.o.rotation.x += c.s.x * 0.016 * (1 - d);
      c.o.rotation.z += c.s.z * 0.016 * (1 - d);
    }
  } else {
    // Hit reaction: a short shove back plus a squash, decayed by the Enemy.
    const hu = a.hurt;
    pv.position.set(0, 0, -hu * 0.14 * rig.centerY);
    pv.rotation.set(hu * 0.18, 0, a.lean * 0.35);
    pv.scale.set(1 + hu * 0.1, 1 - hu * 0.12, 1 + hu * 0.1);
  }

  if (rig.aura && rig.aura.visible) {
    const pulse = 1 + Math.sin(a.t * 5.5) * 0.05 + a.windup * 0.12;
    rig.aura.scale.setScalar(rig.auraR * pulse);
    rig.aura.material.opacity = (0.16 + a.windup * 0.14) * (1 - a.death);
    const bits = rig.auraBits;
    bits.rotation.y = a.t * 1.4;
    for (let i = 0; i < bits.children.length; i++) {
      const b = bits.children[i];
      b.position.y = Math.sin(a.t * 3 + i * 1.7) * rig.auraR * 0.5;
      b.scale.setScalar(0.7 + Math.sin(a.t * 6 + i) * 0.3);
    }
  }
}

// ---------------------------------------------------------------------------
// LEMURIAN — bipedal lizard. Long horizontal S-curve, heavy tail counterweight.
// Silhouette cue: low forward-leaning body with a tail as long as the torso.
// ---------------------------------------------------------------------------

const LEM_HIP = 1.0, LEM_L1 = 0.5, LEM_L2 = 0.5;

function buildLemurian() {
  const rig = newRig('lemurian');
  rig.centerY = 0.95;
  rig.height = 1.7;
  rig.auraR = 1.35;

  const spine = grp(rig.pivot, 0, LEM_HIP, 0);
  rig.parts.spine = spine;

  add(rig, spine, 'body', merged('lem.torso', [
    P(box(0.5, 0.5, 0.55), 0, 0, -0.14),
    P(box(0.56, 0.5, 0.8), 0, 0.05, 0.42),
    P(box(0.44, 0.3, 0.3), 0, 0.02, 0.82),
    P(cone(0.09, 0.3), 0, 0.3, 0.5, -0.25),
    P(cone(0.1, 0.34), 0, 0.31, 0.14, -0.1),
    P(cone(0.09, 0.3), 0, 0.28, -0.2, 0.15),
  ]));

  const neck = grp(spine, 0, 0.18, 0.78);
  rig.parts.neck = neck;
  add(rig, neck, 'body', merged('lem.neck', [
    P(cyl(0.13, 0.18, 0.4, 7), 0, 0.04, 0.16, Math.PI * 0.5),
  ]));

  const head = grp(neck, 0, 0.1, 0.36);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'body', merged('lem.head', [
    P(box(0.3, 0.26, 0.38), 0, 0, 0.15),
    P(box(0.21, 0.16, 0.32), 0, -0.04, 0.44),
    P(box(0.34, 0.07, 0.18), 0, 0.14, 0.2),
    P(cone(0.05, 0.24), 0.12, 0.19, 0.04, -0.5),
    P(cone(0.05, 0.24), -0.12, 0.19, 0.04, -0.5),
  ]));
  add(rig, head, 'eye', merged('lem.eyes', [
    P(ico(0.05, 0), 0.125, 0.07, 0.24),
    P(ico(0.05, 0), -0.125, 0.07, 0.24),
  ]));

  const jaw = grp(head, 0, -0.09, 0.14);
  rig.parts.jaw = jaw;
  add(rig, jaw, 'dark', merged('lem.jaw', [
    P(box(0.2, 0.1, 0.42), 0, -0.04, 0.22),
    P(cone(0.03, 0.1), 0.06, 0.04, 0.36, Math.PI),
    P(cone(0.03, 0.1), -0.06, 0.04, 0.36, Math.PI),
  ]));

  // Fireball charge orb — the ranged tell. Hidden unless charging.
  const orb = add(rig, head, 'accent', ico(0.14, 1), 0, -0.02, 0.5);
  orb.visible = false;
  rig.parts.orb = orb;

  // Tail: three nested segments, animated with a lagged sine so it whips.
  let t = spine;
  rig.parts.tail = [];
  const tailGeo = ['lem.tail0', 'lem.tail1', 'lem.tail2'];
  const tailR = [[0.13, 0.1, 0.44], [0.1, 0.07, 0.42], [0.07, 0.02, 0.4]];
  for (let i = 0; i < 3; i++) {
    t = grp(t, 0, i === 0 ? 0.04 : 0, i === 0 ? -0.34 : -0.4);
    const r = tailR[i];
    add(rig, t, 'body', merged(tailGeo[i], [P(cyl(r[0], r[1], r[2], 6), 0, 0, -r[2] * 0.5, -Math.PI * 0.5)]));
    rig.parts.tail.push(t);
  }

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.24 * sx, -0.06, 0.02);
    add(rig, hip, 'body', merged('lem.thigh', [P(cyl(0.15, 0.11, LEM_L1, 6), 0, -LEM_L1 * 0.5, 0)]));
    const knee = grp(hip, 0, -LEM_L1, 0);
    add(rig, knee, 'dark', merged('lem.shin', [
      P(cyl(0.09, 0.07, LEM_L2, 6), 0, -LEM_L2 * 0.5, 0),
      P(box(0.17, 0.08, 0.32), 0, -LEM_L2, 0.08),
      P(cone(0.03, 0.12), 0, -LEM_L2 - 0.01, 0.24, Math.PI * 0.5),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  rig.parts.arm = [];
  const armR = [
    P(cyl(0.075, 0.06, 0.3, 5), 0, -0.15, 0),
    P(cyl(0.06, 0.05, 0.28, 5), 0, -0.4, 0.09, -0.45),
    P(cone(0.05, 0.14), 0, -0.53, 0.16, Math.PI * 0.9),
  ];
  merged('lem.armR', armR);
  merged('lem.armL', mirror(armR));
  for (let i = 0; i < 2; i++) {
    const sx = i === 0 ? 1 : -1;
    const sh = grp(spine, 0.27 * sx, 0.16, 0.52);
    add(rig, sh, 'dark', merged(i === 0 ? 'lem.armR' : 'lem.armL', i === 0 ? armR : mirror(armR)));
    rig.parts.arm.push(sh);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animLemurian;
  return rig;
}

function animLemurian(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = a.windup;
  const sw = a.swing;
  const fire = a.attack === 'fireball';
  const bite = sw > 0 && !fire ? strike(sw) : 0;
  const spit = sw > 0 && fire ? strike(sw) : 0;

  // Torso: crouches into a bite, rears up for a fireball, bobs when walking.
  const crouch = fire ? -0.12 * anticipate(w) : 0.14 * anticipate(w);
  p.spine.position.y = LEM_HIP - crouch + Math.sin(a.stride * 2) * 0.045 * sp + Math.sin(a.t * 2.3) * 0.018 * (1 - sp);
  p.spine.position.z = bite * 0.28 - anticipate(w) * (fire ? 0 : 0.14);
  p.spine.rotation.x = -0.22 * sp - anticipate(w) * (fire ? -0.28 : 0.26) + bite * 0.34;
  p.spine.rotation.z = Math.sin(a.stride) * 0.07 * sp;

  // Neck/head: pull back to load the bite, rear back to load the fireball.
  const neckPull = fire ? -0.7 * anticipate(w) : 0.55 * anticipate(w);
  p.neck.rotation.x = 0.12 - neckPull + bite * -1.0 + spit * 0.9 + a.pitch * 0.35;
  p.neck.rotation.y = a.lookY * 0.5;
  p.head.rotation.x = -p.neck.rotation.x * 0.45 + a.pitch * 0.3;
  p.head.rotation.y = a.lookY * 0.4;
  p.jaw.rotation.x = 0.06 + (fire ? 0.5 : 0.95) * anticipate(w) + (bite > 0 ? (1 - bite) * 0.6 : 0) + spit * 0.7;

  const charging = fire && (w > 0 || spit > 0);
  p.orb.visible = charging;
  if (charging) {
    const k = spit > 0 ? 1 - sw : anticipate(w);
    p.orb.scale.setScalar(0.25 + k * 1.15 + Math.sin(a.t * 34) * 0.08 * k);
  }

  // Tail whips with a lag per segment — the counterweight that sells the lunge.
  const whip = Math.sin(a.stride * 0.5) * 0.25 * sp + (bite + spit) * 0.5;
  for (let i = 0; i < 3; i++) {
    const seg = p.tail[i];
    seg.rotation.y = Math.sin(a.t * 2.6 - i * 0.8) * (0.1 + 0.16 * sp) + whip * 0.3;
    seg.rotation.x = 0.1 - anticipate(w) * 0.3 - (bite + spit) * 0.35 + Math.sin(a.t * 2.2 - i * 0.7) * 0.05;
  }

  if (a.lod > 0) return common(rig, a);

  const stride = 0.34 * sp + 0.06;
  const reach = -(LEM_HIP - 0.06) + crouch;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    solveLeg(p.hip[i], p.knee[i], LEM_L1, LEM_L2,
      stepZ(ph, stride) * sp, reach + stepY(ph, 0.3) * sp, 1);
  }
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    p.arm[i].rotation.x = -0.3 - Math.sin(a.stride + i * Math.PI) * 0.4 * sp - anticipate(w) * 0.6 + (bite + spit) * 0.9;
    p.arm[i].rotation.z = s * (0.25 + anticipate(w) * 0.35);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// BEETLE — low, wide, armoured dome on six legs. Reads as a swarm unit because
// the silhouette is short and horizontal: nothing else in the roster is.
// ---------------------------------------------------------------------------

function buildBeetle() {
  const rig = newRig('beetle');
  rig.centerY = 0.45;
  rig.height = 0.95;
  rig.auraR = 0.95;

  const body = grp(rig.pivot, 0, 0.44, 0);
  rig.parts.body = body;

  add(rig, body, 'body', merged('bee.shell', [
    P(hemi(0.5, 12, 5), 0, -0.02, -0.06, 0, 0, 0, 1.3, 0.72, 1.5),
    P(box(0.08, 0.18, 1.12), 0, 0.3, -0.06),
    P(box(0.5, 0.1, 0.34), 0.3, 0.18, -0.5, 0, 0, -0.35),
    P(box(0.5, 0.1, 0.34), -0.3, 0.18, -0.5, 0, 0, 0.35),
  ]));
  add(rig, body, 'dark', merged('bee.underside', [
    P(box(0.9, 0.16, 1.15), 0, -0.12, -0.04),
  ]));

  const head = grp(body, 0, -0.04, 0.6);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'dark', merged('bee.head', [
    P(box(0.36, 0.26, 0.3), 0, 0, 0.02),
    P(box(0.42, 0.1, 0.12), 0, 0.12, 0.06),
  ]));
  add(rig, head, 'eye', merged('bee.eyes', [
    P(ico(0.055, 0), 0.15, 0.06, 0.1),
    P(ico(0.055, 0), -0.15, 0.06, 0.1),
  ]));

  const mandR = [P(cyl(0.06, 0.02, 0.4, 5), 0.02, 0, 0.2, Math.PI * 0.5, 0, 0.18)];
  rig.parts.mand = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const g = grp(head, 0.12 * s, -0.08, 0.12);
    add(rig, g, 'dark', merged(i === 0 ? 'bee.mandR' : 'bee.mandL', i === 0 ? mandR : mirror(mandR)));
    rig.parts.mand.push(g);
  }

  // Six legs, each one merged cluster hanging off a hip group.
  const legR = [
    P(cyl(0.055, 0.045, 0.38, 5), 0.16, -0.06, 0, 0, 0, -1.15),
    P(cyl(0.042, 0.026, 0.44, 5), 0.33, -0.32, 0, 0, 0, -0.24),
    P(cone(0.03, 0.1), 0.4, -0.52, 0.02, Math.PI),
  ];
  merged('bee.legR', legR);
  merged('bee.legL', mirror(legR));
  rig.parts.leg = [];
  const zs = [0.34, 0.0, -0.34];
  for (let i = 0; i < 6; i++) {
    const right = i < 3;
    const s = right ? 1 : -1;
    const hip = grp(body, 0.32 * s, -0.08, zs[i % 3]);
    add(rig, hip, 'dark', merged(right ? 'bee.legR' : 'bee.legL', right ? legR : mirror(legR)));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animBeetle;
  return rig;
}

// Alternating tripod: {R-front, R-back, L-mid} vs {R-mid, L-front, L-back}.
const BEE_PHASE = [0, Math.PI, 0, Math.PI, 0, Math.PI];

function animBeetle(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const hit = a.swing > 0 ? strike(a.swing) : 0;

  // Anticipation: rears back on the hind legs before the headbutt.
  p.body.position.y = 0.44 + w * 0.22 + Math.sin(a.stride * 2) * 0.035 * sp - hit * 0.06;
  p.body.position.z = -w * 0.16 + hit * 0.5;
  p.body.rotation.x = -w * 0.62 + hit * 0.5 - 0.05 * sp;
  p.body.rotation.z = Math.sin(a.stride) * 0.09 * sp;

  p.head.rotation.x = w * 0.3 - hit * 0.3;
  p.head.rotation.y = a.lookY * 0.5;
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    p.mand[i].rotation.y = -s * (0.15 + w * 0.85 - hit * 0.9);
    p.mand[i].rotation.x = Math.sin(a.t * 7 + i) * 0.05;
  }

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 6; i++) {
    const ph = a.stride * 1.4 + BEE_PHASE[i];
    const leg = p.leg[i];
    leg.rotation.x = Math.cos(ph) * (0.15 + 0.45 * sp) - w * 0.5;
    leg.rotation.z = -Math.max(0, -Math.sin(ph)) * 0.5 * sp * (i < 3 ? 1 : -1);
    leg.rotation.y = (i < 3 ? 1 : -1) * (0.1 + w * 0.2);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// WISP — a floating ember core inside a cracked-open shell. No legs, no ground
// contact; the shell contracting is the entire attack tell.
// ---------------------------------------------------------------------------

function buildWisp() {
  const rig = newRig('wisp');
  rig.centerY = 0;
  rig.height = 1.1;
  rig.auraR = 1.0;

  const core = add(rig, rig.pivot, 'accent', ico(0.32, 1), 0, 0, 0);
  rig.parts.core = core;

  const shell = grp(rig.pivot, 0, 0, 0);
  rig.parts.shell = shell;
  const plates = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    plates.push(P(box(0.16, 0.5, 0.34), Math.cos(ang) * 0.46, 0, Math.sin(ang) * 0.46, 0, -ang, 0.2));
  }
  add(rig, shell, 'dark', merged('wisp.shell', plates));

  const emb = grp(rig.pivot, 0, 0, 0);
  rig.parts.embers = emb;
  add(rig, emb, 'eye', merged('wisp.embers', [
    P(ico(0.085, 0), 0.78, 0.1, 0),
    P(ico(0.07, 0), -0.4, -0.14, 0.66),
    P(ico(0.06, 0), -0.38, 0.2, -0.66),
  ]));

  rig.parts.tendril = [];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.4;
    const g = grp(rig.pivot, Math.cos(ang) * 0.2, -0.22, Math.sin(ang) * 0.2);
    add(rig, g, 'dark', merged('wisp.tendril', [
      P(cone(0.07, 0.6, 5), 0, -0.3, 0, Math.PI),
    ]));
    rig.parts.tendril.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animWisp;
  return rig;
}

function animWisp(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const fired = a.swing > 0 ? 1 - a.swing : 0;

  // Idle: lazy bob + counter-rotating shell. Windup: shell clamps shut on a
  // swelling core, so the whole thing gets brighter and smaller — unmistakable.
  const bob = Math.sin(a.t * 1.7) * 0.09;
  p.core.position.y = bob;
  p.core.scale.setScalar(1 + w * 0.75 + fired * 0.5 + Math.sin(a.t * 9) * 0.04);
  p.core.rotation.y = a.t * 0.8;
  p.core.rotation.x = a.t * 0.5;

  p.shell.position.y = bob;
  p.shell.rotation.y = -a.t * (0.7 + w * 5.5);
  p.shell.rotation.x = Math.sin(a.t * 1.2) * 0.12;
  const s = 1 - w * 0.34 + fired * 0.7;
  p.shell.scale.set(s, 1 - w * 0.12, s);

  p.embers.position.y = bob * 0.6;
  p.embers.rotation.y = a.t * (1.6 + w * 6);
  p.embers.rotation.z = Math.sin(a.t * 0.9) * 0.4;
  const es = 1 - w * 0.45 + fired * 0.8;
  p.embers.scale.setScalar(es);

  for (let i = 0; i < 4; i++) {
    const g = p.tendril[i];
    g.position.y = -0.22 + bob;
    g.rotation.x = Math.sin(a.t * 2.4 - i * 0.9) * 0.35 - a.speed * 0.6 - w * 0.5;
    g.rotation.z = Math.cos(a.t * 2.1 - i * 0.9) * 0.3;
    g.scale.y = 1 - w * 0.3;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// GOLEM — a slab of rock on stubby legs with one enormous eye. The targeting
// beam is the tell: a thin line appears, tracks you, then thickens and fires.
// ---------------------------------------------------------------------------

const GOL_HIP = 1.9, GOL_L1 = 0.9, GOL_L2 = 0.9;

function buildGolem() {
  const rig = newRig('golem');
  rig.centerY = 1.9;
  rig.height = 3.6;
  rig.auraR = 2.3;

  const spine = grp(rig.pivot, 0, GOL_HIP, 0);
  rig.parts.spine = spine;
  add(rig, spine, 'body', merged('gol.torso', [
    P(box(1.5, 1.3, 0.95), 0, 0.28, 0),
    P(box(1.05, 0.55, 0.85), 0, -0.52, 0),
    P(box(0.55, 0.6, 0.78), 0.92, 0.58, 0, 0, 0, -0.14),
    P(box(0.55, 0.6, 0.78), -0.92, 0.58, 0, 0, 0, 0.14),
    P(box(1.2, 0.22, 0.3), 0, 0.9, -0.4),
  ]));
  add(rig, spine, 'accent', merged('gol.cracks', [
    P(ico(0.26, 0), 0, 0.3, 0.48),
    P(box(0.07, 0.5, 0.06), 0.24, 0.62, 0.47),
    P(box(0.07, 0.42, 0.06), -0.2, 0.0, 0.47, 0, 0, 0.4),
  ]));

  const head = grp(spine, 0, 1.02, 0.16);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'body', merged('gol.head', [
    P(box(0.58, 0.48, 0.55), 0, 0, 0),
    P(box(0.66, 0.14, 0.24), 0, 0.24, 0.2),
    P(cone(0.1, 0.32), 0.22, 0.3, -0.05, -0.3),
    P(cone(0.1, 0.32), -0.22, 0.3, -0.05, -0.3),
  ]));
  rig.parts.eye = add(rig, head, 'eye', ico(0.17, 1), 0, -0.01, 0.3);
  rig.parts.beam = beam(rig, head, -0.01, 0.34);

  const armR = [
    P(cyl(0.27, 0.22, 0.85, 6), 0, -0.42, 0),
  ];
  const foreR = [
    P(cyl(0.24, 0.3, 0.8, 6), 0, -0.4, 0),
    P(box(0.46, 0.46, 0.46), 0, -0.86, 0.02),
  ];
  rig.parts.arm = [];
  rig.parts.elbow = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const sh = grp(spine, 0.98 * s, 0.6, 0);
    add(rig, sh, 'body', merged('gol.upper', armR));
    const el = grp(sh, 0, -0.85, 0);
    add(rig, el, 'body', merged('gol.fore', foreR));
    crumbles(rig, el);
    rig.parts.arm.push(sh);
    rig.parts.elbow.push(el);
  }

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.44 * s, -0.78, 0);
    add(rig, hip, 'dark', merged('gol.thigh', [P(cyl(0.31, 0.26, GOL_L1, 6), 0, -GOL_L1 * 0.5, 0)]));
    const knee = grp(hip, 0, -GOL_L1, 0);
    add(rig, knee, 'dark', merged('gol.shin', [
      P(cyl(0.26, 0.32, GOL_L2, 6), 0, -GOL_L2 * 0.5, 0),
      P(box(0.54, 0.24, 0.76), 0, -GOL_L2 - 0.02, 0.1),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animGolem;
  return rig;
}

function animGolem(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const fire = a.swing > 0 ? 1 - a.swing : 0;

  // Heavy plod: big lateral sway, long slow stride.
  p.spine.position.y = GOL_HIP + Math.sin(a.stride * 2) * 0.09 * sp - w * 0.1;
  p.spine.rotation.x = -w * 0.2 + fire * 0.26;
  p.spine.rotation.z = Math.sin(a.stride) * 0.12 * sp;
  p.spine.rotation.y = Math.sin(a.stride) * 0.08 * sp;

  p.head.rotation.y = a.lookY * 0.7;
  p.head.rotation.x = a.pitch * 0.8 - w * 0.12 + fire * 0.4;
  // Charging eye is the anticipation; the recoil snap is the follow-through.
  p.eye.scale.setScalar(1 + w * 1.5 + fire * 1.2 + Math.sin(a.t * 26) * 0.1 * w);
  // World diameter, not a scale factor: a thin charge line that snaps to a
  // ~0.45u lance on the shot. The gameplay hitbox is 0.9 radius, so the visual
  // sits comfortably inside it.
  setBeam(p.beam, a.beamLen, 0.06 + w * 0.06 + fire * 0.33, a.beamOn);

  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    p.arm[i].rotation.x = Math.sin(a.stride + i * Math.PI) * 0.3 * sp - w * 0.5 + fire * 0.7;
    p.arm[i].rotation.z = s * (0.16 + w * 0.5);
    p.elbow[i].rotation.x = -0.3 - w * 0.5 + fire * 0.3;
  }

  if (a.lod > 0) return common(rig, a);

  const stride = 0.5 * sp + 0.05;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    solveLeg(p.hip[i], p.knee[i], GOL_L1, GOL_L2,
      stepZ(ph, stride) * sp, -(GOL_HIP - 0.78) + stepY(ph, 0.32) * sp, 1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// PEST — a jellyfish bell with a swelling detonation sac. Erratic, aerial,
// and it broadcasts its suicide run by strobing and hauling its tentacles up.
// ---------------------------------------------------------------------------

function buildPest() {
  const rig = newRig('pest');
  rig.centerY = 0;
  rig.height = 1.0;
  rig.auraR = 0.95;

  const bell = grp(rig.pivot, 0, 0.06, 0);
  rig.parts.bell = bell;
  add(rig, bell, 'body', merged('pest.bell', [
    P(hemi(0.5, 12, 6), 0, 0, 0, 0, 0, 0, 1, 0.95, 1),
    P(cyl(0.52, 0.42, 0.14, 12), 0, -0.05, 0),
    P(cone(0.08, 0.26), 0.3, 0.34, 0, 0, 0, -0.5),
    P(cone(0.08, 0.26), -0.3, 0.34, 0, 0, 0, 0.5),
  ]));
  rig.parts.sac = add(rig, rig.pivot, 'accent', ico(0.27, 1), 0, -0.02, 0);
  add(rig, bell, 'eye', merged('pest.spots', [
    P(ico(0.05, 0), 0.24, 0.26, 0.3),
    P(ico(0.05, 0), -0.24, 0.26, 0.3),
    P(ico(0.045, 0), 0, 0.34, -0.36),
  ]));

  rig.parts.tendril = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const g = grp(rig.pivot, Math.cos(ang) * 0.34, -0.1, Math.sin(ang) * 0.34);
    add(rig, g, 'dark', merged('pest.tendril', [
      P(cyl(0.05, 0.012, 0.8, 5), 0, -0.4, 0),
      P(ico(0.035, 0), 0, -0.8, 0),
    ]));
    rig.parts.tendril.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animPest;
  return rig;
}

function animPest(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  // Priming strobes faster and faster — the classic "get away from it" tell.
  const rate = 3.2 + w * 26;
  const pulse = Math.sin(a.t * rate);
  const contract = 0.5 + 0.5 * pulse;

  p.bell.scale.set(1 + contract * 0.14 - w * 0.1, 1 - contract * 0.2 + w * 0.22, 1 + contract * 0.14 - w * 0.1);
  p.bell.position.y = 0.06 + contract * 0.05;
  p.bell.rotation.x = a.pitch * 0.4 + a.speed * 0.35;
  p.bell.rotation.z = Math.sin(a.t * 1.9) * 0.16;

  p.sac.scale.setScalar(0.9 + w * 1.5 + contract * 0.12);
  p.sac.rotation.y = a.t * 1.6;

  for (let i = 0; i < 5; i++) {
    const g = p.tendril[i];
    const lag = a.t * rate - i * 0.5;
    g.rotation.x = Math.sin(lag) * (0.28 - w * 0.2) - a.speed * 0.75 - w * 0.9;
    g.rotation.z = Math.cos(lag * 0.8) * 0.22;
    g.scale.y = 1 - w * 0.45 + contract * 0.1;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// TITAN — the teleporter boss. Eight metres of stone with a glowing core, two
// fists it raises over its head, and eye lasers it sweeps across the arena.
// ---------------------------------------------------------------------------

const TIT_HIP = 4.0, TIT_L1 = 1.9, TIT_L2 = 1.9;

function buildTitan() {
  const rig = newRig('titan');
  rig.centerY = 4.0;
  rig.height = 7.6;
  rig.auraR = 4.6;

  const spine = grp(rig.pivot, 0, TIT_HIP, 0);
  rig.parts.spine = spine;
  add(rig, spine, 'body', merged('tit.torso', [
    P(box(3.2, 2.3, 1.9), 0, 0.65, 0),
    P(box(2.2, 1.05, 1.6), 0, -0.75, 0),
    P(box(1.25, 1.3, 1.5), 1.95, 1.3, 0, 0, 0, -0.2),
    P(box(1.25, 1.3, 1.5), -1.95, 1.3, 0, 0, 0, 0.2),
    P(box(2.6, 0.4, 0.5), 0, 1.75, -0.75),
    P(cone(0.3, 1.3), 0.85, 2.1, -0.7, -0.35),
    P(cone(0.3, 1.3), -0.85, 2.1, -0.7, -0.35),
    P(cone(0.24, 1.0), 0, 2.2, -0.9, -0.5),
  ]));
  add(rig, spine, 'dark', merged('tit.plates', [
    P(box(2.4, 0.35, 0.4), 0, -0.1, 0.95),
    P(box(1.8, 0.3, 0.4), 0, 1.55, 0.9),
  ]));
  rig.parts.core = add(rig, spine, 'accent', ico(0.55, 1), 0, 0.6, 1.02);
  add(rig, spine, 'accent', merged('tit.veins', [
    P(box(0.12, 1.1, 0.1), 0.7, 1.3, 0.98, 0, 0, -0.3),
    P(box(0.12, 1.0, 0.1), -0.62, -0.05, 0.98, 0, 0, 0.35),
    P(box(0.12, 0.8, 0.1), 0.2, -0.4, 0.98, 0, 0, 0.15),
  ]));

  const head = grp(spine, 0, 1.95, 0.3);
  rig.parts.head = head;
  add(rig, head, 'body', merged('tit.head', [
    P(box(1.05, 0.9, 1.0), 0, 0, 0),
    P(box(1.2, 0.26, 1.1), 0, 0.52, 0),
    P(box(1.15, 0.2, 0.3), 0, 0.16, 0.42),
  ]));
  rig.parts.eyes = [];
  rig.parts.beam = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const g = grp(head, 0.29 * s, 0.0, 0.5);
    rig.parts.eyes.push(add(rig, g, 'eye', ico(0.2, 1), 0, 0, 0));
    rig.parts.beam.push(beam(rig, g, 0, 0.06));
  }

  const upper = [P(cyl(0.58, 0.5, 1.7, 7), 0, -0.85, 0), P(box(0.7, 0.5, 0.9), 0, -0.1, 0)];
  const fore = [
    P(cyl(0.5, 0.64, 1.6, 7), 0, -0.8, 0),
    P(box(1.1, 1.0, 1.05), 0, -1.8, 0.05),
    P(cone(0.2, 0.5), 0.42, -2.2, 0.4, 1.2),
    P(cone(0.2, 0.5), -0.42, -2.2, 0.4, 1.2),
  ];
  rig.parts.arm = [];
  rig.parts.elbow = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const sh = grp(spine, 2.05 * s, 1.3, 0);
    add(rig, sh, 'body', merged('tit.upper', upper));
    const el = grp(sh, 0, -1.7, 0);
    add(rig, el, 'body', merged('tit.fore', fore));
    crumbles(rig, el);
    rig.parts.arm.push(sh);
    rig.parts.elbow.push(el);
  }

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.92 * s, -1.15, 0);
    add(rig, hip, 'dark', merged('tit.thigh', [P(cyl(0.66, 0.56, TIT_L1, 7), 0, -TIT_L1 * 0.5, 0)]));
    const knee = grp(hip, 0, -TIT_L1, 0);
    add(rig, knee, 'dark', merged('tit.shin', [
      P(cyl(0.56, 0.68, TIT_L2, 7), 0, -TIT_L2 * 0.5, 0),
      P(box(1.15, 0.5, 1.6), 0, -TIT_L2 - 0.05, 0.2),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animTitan;
  return rig;
}

function animTitan(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const rel = a.swing > 0 ? strike(a.swing) : 0;
  const slam = a.attack === 'slam' ? 1 : 0;
  const stomp = a.attack === 'stomp' ? 1 : 0;
  const barrage = a.attack === 'barrage' ? 1 : 0;
  const rage = a.phase > 1 ? 1 : 0;

  const hipY = TIT_HIP - w * (slam * 0.35 + stomp * 0.15) - rel * slam * 0.9;
  p.spine.position.y = hipY + Math.sin(a.stride * 2) * 0.16 * sp;
  p.spine.position.z = rel * slam * 0.5;
  p.spine.rotation.x = -w * (slam * 0.32 + barrage * 0.18) + rel * (slam * 0.55 + stomp * 0.25);
  p.spine.rotation.z = Math.sin(a.stride) * 0.1 * sp + w * stomp * 0.22 - rel * stomp * 0.2;
  p.spine.rotation.y = Math.sin(a.stride) * 0.06 * sp;

  // The core is the health-bar you can see across the arena.
  p.core.scale.setScalar(1 + rage * 0.3 + w * 0.55 + Math.sin(a.t * (2.4 + rage * 3)) * (0.06 + rage * 0.06));

  p.head.rotation.y = a.lookY * 0.6 + a.sweep;
  p.head.rotation.x = a.pitch * 0.6 - w * barrage * 0.25 + rel * slam * 0.4;

  const eyeGlow = 1 + rage * 0.25 + w * (barrage * 1.6 + 0.25) + rel * barrage * 0.9;
  p.eyes[0].scale.setScalar(eyeGlow);
  p.eyes[1].scale.setScalar(eyeGlow);
  for (let i = 0; i < 2; i++) {
    // 0.26 was this beam's old cylinder diameter; the profile is unchanged, it
    // is just expressed in world units now that setBeam takes a diameter.
    setBeam(p.beam[i], a.beamLen,
      a.beamOn ? 0.26 * (a.windup > 0 ? 0.25 + w * 0.5 : 1.6 + Math.sin(a.t * 40) * 0.2) : 0, a.beamOn);
  }

  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    if (slam) {
      // Both fists overhead — the single most readable pose in the fight.
      p.arm[i].rotation.x = -w * 2.6 + rel * 3.1;
      p.arm[i].rotation.z = s * (0.12 + w * 0.35 - rel * 0.3);
      p.elbow[i].rotation.x = -w * 0.9 + rel * 0.7;
    } else if (barrage) {
      p.arm[i].rotation.x = -w * 0.5;
      p.arm[i].rotation.z = s * (0.2 + w * 1.0);
      p.elbow[i].rotation.x = -0.3 - w * 0.4;
    } else {
      p.arm[i].rotation.x = Math.sin(a.stride + i * Math.PI) * 0.3 * sp - w * stomp * 0.4;
      p.arm[i].rotation.z = s * (0.14 + w * 0.3);
      p.elbow[i].rotation.x = -0.25 - Math.abs(Math.sin(a.stride + i * Math.PI)) * 0.2 * sp;
    }
  }

  if (a.lod > 0) return common(rig, a);

  const stride = 0.95 * sp + 0.08;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    // The stomp lifts the right leg to the chest, then drives it down.
    const lift = stomp && i === 0 ? w * 1.5 - rel * 1.6 : 0;
    solveLeg(p.hip[i], p.knee[i], TIT_L1, TIT_L2,
      stepZ(ph, stride) * sp + lift * 0.5,
      -(TIT_HIP - 1.15) + stepY(ph, 0.6) * sp + Math.max(0, lift) * 1.7 + (TIT_HIP - hipY), 1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// shared VFX primitives owned by the enemy stack (projectiles / shockwaves)
// ---------------------------------------------------------------------------

const PROJ_MAT = new Map();
function projMat(color) {
  let m = PROJ_MAT.get(color);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  PROJ_MAT.set(color, m);
  return m;
}

/** A glowing core + a loose outer husk that spins — cheap but reads hot. */
export function makeProjectile(color) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(ico(0.18, 1), projMat(color));
  const husk = new THREE.Mesh(ico(0.34, 0), projMat(color));
  husk.material = projMat(mixHex(color, 0xffffff, 0.5));
  g.add(core, husk);
  g.userData.core = core;
  g.userData.husk = husk;
  g.frustumCulled = false;
  return g;
}

/** Expanding ground ring used by slams, stomps and death novas. */
export function makeShockwave(color) {
  const m = new THREE.Mesh(ring(1, 0.09, 4, 32), projMat(color));
  m.rotation.x = -Math.PI * 0.5;
  m.frustumCulled = false;
  return m;
}

/** Flat decal ring that marks where an AoE is about to land. */
export function makeTelegraph(color) {
  const m = new THREE.Mesh(ring(1, 0.05, 3, 40), projMat(color));
  m.rotation.x = -Math.PI * 0.5;
  m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------------------
// factory table + rig pool
// ---------------------------------------------------------------------------

const BUILDERS = {
  lemurian: buildLemurian,
  beetle: buildBeetle,
  wisp: buildWisp,
  golem: buildGolem,
  pest: buildPest,
  titan: buildTitan,
};

/** Every rig the game can build. Drives the boot-time shader prewarm. */
export const ENEMY_IDS = Object.keys(BUILDERS);

const POOL = new Map();

/** Take a rig from the pool (or build one). Always returns it in a clean pose. */
export function acquireRig(id) {
  let list = POOL.get(id);
  if (!list) { list = []; POOL.set(id, list); }
  const rig = list.length ? list.pop() : BUILDERS[id]();
  rig.resetRig();
  return rig;
}

export function releaseRig(rig) {
  if (!rig) return;
  if (rig.root.parent) rig.root.parent.remove(rig.root);
  rig.resetRig();
  const list = POOL.get(rig.id);
  if (list) list.push(rig); else POOL.set(rig.id, [rig]);
}

/** Warm the pool so the first wave doesn't hitch mid-fight. */
export function prewarm(id, count) {
  const list = POOL.get(id) || [];
  while (list.length < count) {
    const rig = BUILDERS[id]();
    rig.resetRig();
    list.push(rig);
  }
  POOL.set(id, list);
}

/** Shadow policy: only the biggest cluster of each rig casts. */
export function configureShadows(rig) {
  for (const m of rig.body) m.castShadow = true;
  for (const m of rig.dark) m.castShadow = false;
  for (const m of rig.accent) m.castShadow = false;
  for (const m of rig.eye) m.castShadow = false;
}

/** The struct every animator reads. One per Enemy, allocated once. */
export function makeAnim() {
  return {
    t: 0, state: '', stateT: 0,
    speed: 0, stride: 0,
    windup: 0, swing: 0, attack: '',
    hurt: 0, death: 0, phase: 1,
    pitch: 0, lookY: 0, lean: 0, sweep: 0,
    beamOn: false, beamLen: 0,
    fallX: 1, fallZ: 0,
    lod: 0,
  };
}

export { lerp, clamp };
