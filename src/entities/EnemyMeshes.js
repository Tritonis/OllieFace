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
import { RimStandardMaterial } from './CharacterMesh.js';
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

// Eye colours are *saturated*, never pale. A near-white eye at a high emissive
// intensity clips to 255,255,246 through bloom on every species at once, which
// is how six different monsters ended up wearing the same white disc. A hue at
// emissive 1.1 survives tone-mapping and reads hotter than a clipped 2.4,
// because the eye is then the only saturated thing in its neighbourhood.
const PALETTE = {
  skink: { body: 0x8a3f2c, dark: 0x38180f, accent: 0xff5a12, eye: 0xff8a00 },
  scarab:   { body: 0x77705a, dark: 0x2b2820, accent: 0xc4d044, eye: 0xb4ff10 },
  mote:     { body: 0x2c1a34, dark: 0x120a18, accent: 0xff7a1e, eye: 0xff5a00 },
  sentinel:    { body: 0x646b78, dark: 0x282c34, accent: 0x22d3ff, eye: 0x00d0ff },
  shrike:     { body: 0xa03f7e, dark: 0x3a1330, accent: 0xff3566, eye: 0xff2f7a },
  // Stone, not putty. 0x6d7480 was a near-neutral mid grey, and a near-neutral
  // mid grey has no pigment of its own to resist the stage light — under this
  // warm key the whole eight-metre boss rendered #905c71, a flat mauve. A
  // darker, distinctly cool slate keeps its hue under the same light, holds the
  // orange core as the only warm thing on the model, and gives the plates room
  // to be lighter than the joints instead of everything landing on one value.
  colossus:    { body: 0x424a58, dark: 0x1c2029, accent: 0xffa514, eye: 0xffb020 },

  // The expanded roster. Each species owns a hue no neighbour in its tier uses,
  // because at combat range colour is the second identifier after silhouette —
  // and two units that share both are the same monster as far as the player's
  // reflexes are concerned.
  mite:     { body: 0x8c7a3e, dark: 0x2e2712, accent: 0xd8e04a, eye: 0xe8ff3a },
  spitling: { body: 0x5d7a34, dark: 0x1e2a12, accent: 0x9be035, eye: 0xc4ff4a },
  harrier:  { body: 0x7a4326, dark: 0x2a160c, accent: 0xffb648, eye: 0xffd166 },
  charger:  { body: 0x6b5240, dark: 0x261c14, accent: 0xffd166, eye: 0xffc04a },
  burrower: { body: 0x7d6a4c, dark: 0x2a2318, accent: 0xd8a860, eye: 0xffcc7a },
  brood:    { body: 0x4a5c3a, dark: 0x18200f, accent: 0x8ee06a, eye: 0xb4ff8a },
  warden:   { body: 0x4c5b6e, dark: 0x1a2029, accent: 0x7fd4ff, eye: 0x9fe8ff },
  stalker:  { body: 0x3a2c4e, dark: 0x150f20, accent: 0xb98cff, eye: 0xd0b0ff },
  acolyte:  { body: 0x2f4a44, dark: 0x101c1a, accent: 0x74ffc8, eye: 0x9affd8 },
  mortar:   { body: 0x5a4a44, dark: 0x1e1814, accent: 0xff8a3c, eye: 0xffa860 },
  hulk:     { body: 0x4e3a34, dark: 0x1c1210, accent: 0xff5a12, eye: 0xff7a2a },

  // Round 7. Same rule as the block above — each takes a hue no neighbour in
  // its own tier is using, because tier is what decides which units the player
  // sees standing next to each other.
  //
  // Tier 1 was five warm species and one magenta, so the Shriver is the only
  // *cold* thing in the opening roster; that is deliberate beyond palette
  // hygiene, since it is also the only unit in the tier whose hit does something
  // other than damage, and it should not look like the things around it.
  shriver:  { body: 0x2e3560, dark: 0x11142a, accent: 0x6f8cff, eye: 0x9fb4ff },
  // Tier 2 had green (brood), blue (warden), violet (stalker), teal (acolyte),
  // grey-blue (sentinel) and burnt orange (mortar) — no red at all. The Lasher's
  // own attack colours match this accent so the reel and the thorn volley are
  // legibly *its*.
  lasher:   { body: 0x5e2a34, dark: 0x1f0d12, accent: 0xff6a7a, eye: 0xff8a9a },
  // Pale gold, which nothing else on the roster runs: the Redoubt has to be
  // identifiable from behind at a glance, because "get behind it" is the whole
  // fight and the player needs to know which side they are looking at from
  // across the arena.
  redoubt:  { body: 0x6a6250, dark: 0x25211a, accent: 0xffd8a0, eye: 0xffe8b8 },

  wyrm:        { body: 0x9a8f74, dark: 0x332e22, accent: 0xe8d6a8, eye: 0xfff0c0 },
  thunderhead: { body: 0x3a4458, dark: 0x141a26, accent: 0x9fd0ff, eye: 0xc9b5ff },
  matron:      { body: 0x6a3a2e, dark: 0x241010, accent: 0xff6a12, eye: 0xff9a3c },
  vizier:      { body: 0x54606e, dark: 0x1a2028, accent: 0x9fe8ff, eye: 0xbfe4ff },
  maw:         { body: 0x4a5e2e, dark: 0x18220e, accent: 0x9be035, eye: 0xd8ff7a },
  // The finale. Violet is the one hue no spawn card and no other boss owns, and
  // it is the Fracture's own sky colour — the last fight is meant to look like
  // it belongs to the place it is standing in and to nothing before it.
  herald:      { body: 0x3b2f5e, dark: 0x140e26, accent: 0xd050ff, eye: 0xff4ad0 },
};

/**
 * Elite affixes. Each one repaints the whole silhouette.
 *
 * `tier` 2 affixes are gated behind run progress by the director, and they are
 * deliberately the two loudest entries in this table: the entire point of a
 * tier-2 elite is that you identify it across the arena and change plan before
 * it reaches you. Each carries its own aura *signature* — bit count, bit shape,
 * orbit style and whether it wears a barrier shell — not just a different tint,
 * because at a distance a tint is the first thing tone mapping takes away.
 */
/*
 * Round-5 rebuild. The previous table shipped a filled additive sphere
 * (`ico(1,2)` at the unit's whole aura radius) as every affix's carrier, and
 * measurement killed it: `warded` and `withering` came back at 0.91 IoU against
 * a *perfect circle* and 0.88 against each other, and in `04-combat` the
 * emberclad and galvanic spheres photographed as ~150x140 px opaque balls with
 * blown white cores covering half the host's torso. Not one of the five
 * declared orbiting bits was visible in either — additive bits drawn inside an
 * additive shell that is already at the clip point add nothing.
 *
 * So the shell is gone. The carrier is now `bands` thin torus rings at `tilt`,
 * which cover ~5% of the disc the sphere covered, plus the bits, which are
 * finally on top of something they can be seen against. Silhouette
 * information now passes *through* the affix instead of being replaced by it.
 *
 * The signature triple is bands x bits x orbit style, and no two rows share it:
 *   emberclad      1 flat halo,  4 shards rising and recycling  (fire climbs)
 *   galvanic  3 crossed,    6 icos on a fast flat ring     (a gyroscope)
 *   rimebound      2 shallow,    6 shards nearly static         (a frozen orrery)
 *   withering    0,            9 spikes on a slow helix       (infection spreads)
 *   warded       0,            0, a faceted barrier instead   (an actual shell)
 */
export const ELITE = {
  emberclad:     { tint: 0xff3a08, aura: 0xff6a10, glow: 2.6, name: 'Emberclad', bands: 1, tilt: 0, bits: 4, shape: 'shard', bitScale: 0.20, rise: 1, bandAlpha: 0.75 },
  galvanic: { tint: 0x2f5cff, aura: 0x74a6ff, glow: 2.8, name: 'Galvanic', bands: 3, tilt: 1.15, bits: 6, shape: 'ico', bitScale: 0.14, spin: 3.4, bandAlpha: 0.55 },
  // The one tint in the table pale enough to blow out: at the old 0xa8e6ff it
  // mixed 78% into the body albedo *and* drove a 0.5 emissive, which measured
  // as a 94x101 px matte lump at mean L 232 with no internal structure — the
  // host's form was gone even though its outline was not. Pulled down to a
  // saturated ice blue that still reads as ice at a value the grade can hold.
  // `aura` pulled off 0x8fe4ff for the same reason as `tint`: it drives the
  // bands, the bits, the accents and the eyes, and at that value three of them
  // overlapping measured 24% of the host's own footprint as near-neutral white.
  // A saturated cyan additively stacked stays cyan; a pale one becomes paper.
  rimebound:     { tint: 0x4fb8e8, aura: 0x46c4f0, glow: 2.2, name: 'Rimebound', bands: 2, tilt: 0.5, bits: 6, shape: 'shard', bitScale: 0.18, spin: 0.3, bandAlpha: 0.45 },
  // A cloud of thorns on a sick green body. Nine bits in a slow vertical helix
  // rather than a ring: the read is "infected", and infection spreads
  // rather than orbiting.
  withering:   { tint: 0x2fbf6a, aura: 0x86ffb4, glow: 2.4, name: 'Withering', tier: 2, bands: 0, bits: 9, shape: 'spike', bitScale: 0.15, helix: 1 },
  // No bits at all — a hard faceted barrier instead, which is the one
  // silhouette change in the table that alters the unit's actual outline. It is
  // allowed to, but it is now a wireframe crystal rather than a filled sphere,
  // so what it adds is facets and not a disc.
  warded:      { tint: 0x6a4ad0, aura: 0xc9a8ff, glow: 3.0, name: 'Warded', tier: 2, bands: 0, bits: 0, ward: 1 },
  // The void's family. Blight-ramp magenta pulled toward black: the read is
  // "eaten", not "empowered". Two slow bands plus seven shards — ringed like
  // the tier-1s so it still reads elite at 40 m, but in the one hue family no
  // other affix owns, which is what lets the ground and the monster agree.
  voidtouched: { tint: 0x8a2fd0, aura: 0xff2fb0, glow: 2.7, name: 'Hollowed', bands: 2, tilt: 0.9, bits: 7, shape: 'shard', bitScale: 0.16, spin: 1.1, bandAlpha: 0.6 },
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
  const p = PALETTE[id] || PALETTE.scarab;
  const e = affix ? ELITE[affix] : null;
  // 0.78 / 0.45 flooded the whole unit with the affix tint and left no species
  // value range underneath it — a pale affix turned its host into one matte
  // patch. Half the mix keeps the affix hue unmistakable while the palette's
  // own body/dark split survives to carry form.
  const bodyC = e ? mixHex(p.body, e.tint, 0.52) : p.body;
  const darkC = e ? mixHex(p.dark, e.tint, 0.26) : p.dark;
  const accC = e ? e.aura : p.accent;
  const eyeC = e ? mixHex(p.eye, e.aura, 0.8) : p.eye;
  // Every body surface carries a faint species-coloured emissive plus a fresnel
  // rim, so a monster standing on shadowed rock is still a shape and not a hole
  // in the frame. The rim is the RoR2 read: the silhouette edge lights itself,
  // which is what lets you count a horde against terrain of the same value.
  //
  // The rim alone was not enough: it is a 1-2 px edge at combat range, and two
  // facets of the same torso 40 deg apart measured under 6/255 apart, so the
  // bodies were flat rectangles with a lit outline. `hemiStrength` tilts albedo
  // by world up-ness (up-facing plates lighter, undersides darker) so a faceted
  // body separates without depending on the key direction — monsters get more
  // of it than the player because they are lit worse and seen smaller.
  //
  // `body` and `dark` are also split on specular now, not just on value: plate
  // is smooth and slightly metallic, the joints and underside it hangs off are
  // matte. A rock's plates and its recesses should not share a highlight.
  m = {
    body: new RimStandardMaterial({
      color: bodyC, roughness: 0.55, metalness: 0.22, flatShading: true,
      // An elite's emissive used to be 0.5 of its tint on every body facet,
      // which is a flat lift applied equally to lit and shadowed plates — it
      // adds brightness and *subtracts* shading, so the higher it goes the less
      // form the unit has. The affix read comes from the rim, the accents and
      // the bands; the body only needs enough to say "this one is charged".
      emissive: e ? e.tint : accC, emissiveIntensity: e ? 0.20 : 0.12,
      rimColor: accC, rimStrength: e ? 0.85 : 0.6, rimPower: 3.0,
      hemiStrength: 0.34,
    }),
    dark: new RimStandardMaterial({
      color: darkC, roughness: 0.92, metalness: 0.02, flatShading: true,
      emissive: e ? e.tint : accC, emissiveIntensity: e ? 0.12 : 0.1,
      rimColor: accC, rimStrength: e ? 0.9 : 0.7, rimPower: 2.8,
      hemiStrength: 0.30,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: accC, roughness: 0.4, metalness: 0, emissive: accC,
      emissiveIntensity: e ? e.glow * 0.62 : 1.35,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: eyeC, roughness: 0.3, metalness: 0, emissive: eyeC,
      emissiveIntensity: e ? e.glow * 0.5 : 1.1,
    }),
  };
  MATS.set(key, m);
  return m;
}

// One shared white material for the hit flash — swapping material references is
// free, whereas mutating a shared material would flash the whole horde.
const FLASH = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });

const AURA = new Map();
/**
 * Band material. Higher opacity than the sphere it replaces and still far less
 * total light: a torus of tube radius 0.055 covers roughly a twentieth of the
 * projected disc a filled shell covers, so the band can be bright enough to
 * read across the arena without being anything the host has to be seen through.
 * FrontSide, not BackSide — a band has no interior to look into, and drawing
 * both faces doubled it wherever the ring turned edge-on.
 */
function auraMat(affix) {
  let m = AURA.get(affix);
  if (m) return m;
  m = new THREE.MeshBasicMaterial({
    color: ELITE[affix] ? ELITE[affix].aura : 0xffffff,
    transparent: true, opacity: ELITE[affix]?.bandAlpha ?? 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.FrontSide, fog: false,
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
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.82, fog: false,
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
// ...and a FLOOR on the same angle. A sentinel tracking from 35 m drew its 0.06 m
// charge line at ~1 px wide, which is not a beam, it is a hairline scratch
// ruling the composition into wedges — 455 px of it crossed 04. Below ~4 px the
// quad has no mass anywhere along its length and reads as a render artefact.
const BEAM_MIN_HALF_ANGLE = Math.tan(0.18 * Math.PI / 180);
// Hard ceiling on world diameter. The widest gameplay beam hitbox is 1.5 radius
// and the visual should read thinner than its hitbox, never wider.
const BEAM_MAX_WIDTH = 1.2;
// Hard ceiling on drawn length. The gameplay ray still reaches `attackRange`
// (55 m for the colossus); the *visual* stops at 14 m so the shot reads as a bolt
// leaving the muzzle rather than a wire spanning the frame.
export const BEAM_MAX_LEN = 14;

const BEAM_VERT = /* glsl */`
uniform float uMaxAngle;
uniform float uMinAngle;
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
  halfW = clamp(halfW, uMinAngle * dist, uMaxAngle * dist);
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
  // Hot at the muzzle, gone by the tip. A linear mix to 0.32 only decayed to
  // 32% over the whole run, which at 455 px is a constant-brightness wire with
  // no direction — you could not tell which end it came out of.
  float along = pow(1.0 - vBeamUv.y, 1.6);
  float near = smoothstep(0.5, 2.4, vDist); // fade out rather than swallow the lens
  float a = edge * along * near * uOpacity;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(mix(uColor, vec3(1.0), core * 0.85) * 1.25, a);
}`;

export function beamMat(id) {
  let m = BEAM.get(id);
  if (m) return m;
  const p = PALETTE[id] || PALETTE.sentinel;
  m = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(p.accent) },
      uOpacity: { value: 0.85 },
      uMaxAngle: { value: BEAM_MAX_HALF_ANGLE },
      uMinAngle: { value: BEAM_MIN_HALF_ANGLE },
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
// contact shadows
// ---------------------------------------------------------------------------
//
// The stage's shadow map is one cascade over a large arena, so under a horde it
// resolves to nothing at the point that matters most — the few pixels where a
// monster meets the ground. Without that cue you cannot depth-order a horde:
// a hovering shrike and a shrike on the ridge behind it are the same picture.
//
// So every rig gets a projected blob. The whole horde is ONE InstancedMesh and
// therefore one draw call total, not one per enemy: slots are handed out for
// the life of a rig (rigs are pooled, never destroyed) and an unused slot is
// simply drawn at zero size with zero alpha.

const SHADOW_MAX = 192;

const SHADOW_VERT = /* glsl */`
attribute float aFade;
varying vec2 vBlobUv;
varying float vFade;
varying float vGraze;
void main() {
  vBlobUv = uv;
  vFade = aFade;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  // Camera elevation over this point of the disc, for the grazing-angle fade.
  vGraze = abs(normalize(cameraPosition - wp.xyz).y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// MULTIPLY decal, not a composite. The previous version answered "a subtractive
// blob is invisible on luma-6 ground" by *adding* a grey ring, and on the lit
// grade that ships now the ring measured 2.4x the floor luma under the player
// and, on the boss's 3 m disc seen edge-on, a 286x7 px bright bar clean across
// the midground. A contact decal may only ever attenuate what is under it.
//
// `gl_FragColor.rgb` is premultiplied by `a`, so with (DstColor, OneMinusSrcAlpha)
// the result is dst * (1 - a * (1 - SHADE)) — never above dst on any channel at
// any alpha. Visibility on near-black ground comes from HUE, not value: red is
// attenuated hardest and blue least, so deeper contact goes cool rather than
// grey, and the floor's own texture survives instead of being flattened.
//
// STRENGTH — kept in lockstep with CharacterMesh.BLOB_FRAG, see the long note
// there. Short version: the multiply lands in the linear HDR buffer, so the
// dip you see is the linear one raised to ~1/2.2. The old constants gave a
// linear 0.48 = a 29% sRGB dip, which measured 24-27% in the shipped frames and
// was not readable as contact under anything. These give linear 0.27 = a ~45%
// sRGB dip (luma 60 ground -> ~33 under the disc), tuned against the current
// grade. `a` is clamped under 1 because the per-rig fade carries the rig's
// scale, and a boss at scale > 1.2 would otherwise push `a * (1 - SHADE)` past
// 1 and clamp its disc to flat black.
const SHADOW_FRAG = /* glsl */`
varying vec2 vBlobUv;
varying float vFade;
varying float vGraze;
void main() {
  float r = length(vBlobUv - 0.5) * 2.0;
  float core = smoothstep(1.00, 0.14, r);
  float ring = smoothstep(0.48, 0.80, r) * smoothstep(1.02, 0.82, r);
  // A ground disc seen near edge-on projects to an all-annulus sliver a few
  // pixels tall, which reads as a rendering glitch and not as contact. The knee
  // only has to cover the genuinely edge-on case now (under ~1.7 deg): the
  // artefact it was written to kill was a *bright* bar, and this shader cannot
  // produce one at any alpha.
  float a = (core * 0.86 + ring * 0.18) * vFade * smoothstep(0.03, 0.14, vGraze);
  a = min(a, 0.92);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vec3(0.03, 0.05, 0.11) * a, a);
}`;

let SHADOW = null;

function shadowPool() {
  if (SHADOW) return SHADOW;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI * 0.5);
  const fade = new Float32Array(SHADOW_MAX);
  geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(fade, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: SHADOW_VERT,
    fragmentShader: SHADOW_FRAG,
    transparent: true,
    depthWrite: false,
    // Multiply, so the decal can only darken the floor it lands on.
    blending: THREE.CustomBlending,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    fog: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, SHADOW_MAX);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -1;              // under every transparent effect
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SHADOW_MAX; i++) mesh.setMatrixAt(i, zero);
  SHADOW = { mesh, fade, attr: geo.attributes.aFade, next: 0 };
  return SHADOW;
}

/**
 * Hand the blob pool's mesh to the boot prewarm.
 *
 * The pool builds itself lazily on the first live rig, which puts its GLSL
 * compile+link on the frame the first enemy appears — exactly the mid-fight
 * hitch `fx/Prewarm.js` exists to prevent. Building it at boot instead costs
 * one InstancedMesh that the game was going to allocate anyway.
 */
export function shadowPrewarmMesh() {
  return shadowPool().mesh;
}

/** One slot per rig, held for the rig's life. -1 once the pool is full. */
function acquireShadowSlot() {
  const s = shadowPool();
  return s.next < SHADOW_MAX ? s.next++ : -1;
}

const _shq = new THREE.Quaternion();

function setShadow(slot, x, y, z, radius, fade) {
  if (slot < 0) return;
  const s = SHADOW;
  _m4.compose(_p3.set(x, y, z), _shq, _s3.set(radius * 2, 1, radius * 2));
  s.mesh.setMatrixAt(slot, _m4);
  s.mesh.instanceMatrix.needsUpdate = true;
  s.fade[slot] = fade;
  s.attr.needsUpdate = true;
}

/**
 * Project a rig's blob onto the ground. `a.ground` is the terrain height under
 * the unit; when it is null (a replicated view that never sampled the terrain)
 * a walker's own root height is the ground by definition, and a flyer simply
 * goes without rather than dragging a shadow through the air with it.
 */
function updateShadow(rig, a) {
  const slot = rig.shadow;
  if (slot < 0) return;
  // The pool has no owner to init it, so it adopts whatever scene the first
  // live rig is parented into (and re-adopts one if a stage swap drops it).
  if (SHADOW.mesh.parent === null) {
    let o = rig.root;
    while (o.parent) o = o.parent;
    if (o !== rig.root) o.add(SHADOW.mesh);
  }
  const p = rig.root.position;
  const gy = a.ground != null ? a.ground : (rig.flyer ? null : p.y);
  if (gy == null || !rig.root.visible) { setShadow(slot, 0, 0, 0, 0, 0); return; }
  const scale = rig.root.scale.x;
  const lift = Math.max(0, p.y - gy);
  // Blurs out and dims with altitude, which is what encodes hover height.
  const k = 1 - clamp(lift / 3.2, 0, 1);
  const fade = 0.85 * k * k * (1 - a.death) * scale;
  const r = rig.shadowR * scale * (1 + lift * 0.2);
  // The decal is a flat plane on faceted ground, so the bigger the disc the more
  // of it the terrain's own relief buries by depth test — which is why the boss,
  // whose disc is the widest in the game, was the one unit with no measurable
  // dip under it at all. Lifting it in proportion to its radius clears ordinary
  // facet relief; at the boss's 3 m it is 0.15 m, which is ~2 px of gap at the
  // standoff the boss shot uses.
  setShadow(slot, p.x, gy + 0.04 + r * 0.05, p.z, r, fade);
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
    // Contact shadow: slot in the shared instanced pool, footprint radius, and
    // whether this species ever touches the ground at all.
    shadow: acquireShadowSlot(), shadowR: 0.7, flyer: false,
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

/**
 * A warded elite's barrier.
 *
 * Front-facing rather than back-facing (the aura shell is BackSide, so it only
 * ever tints the body from behind) and low-opacity additive, so it reads as a
 * faceted pane of light *in front of* the monster. That is the whole job: the
 * player has to see that there is something between them and the target.
 */
const WARD = new Map();
function wardMat(kind) {
  let m = WARD.get(kind);
  if (m) return m;
  const c = ELITE.warded.aura;
  // The fill used to be 0.16 additive over a 80-face `ico(1,1)` — near enough a
  // sphere that the barrier measured 0.91 IoU against a perfect disc and its
  // host stopped having a shape. It is now a token wash under a bright
  // wireframe on a 20-face crystal: the edges say "there is a barrier here",
  // and everything between them is the monster.
  m = kind === 'edge'
    ? new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    : new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide, fog: false });
  WARD.set(kind, m);
  return m;
}

// Max bits and bands any affix asks for. Built once per rig and hidden down to
// the counts the current affix wants, so switching affix never allocates.
const AURA_BITS = 9;
const AURA_BANDS = 3;

// Unit-radius ring, scaled by the rig's aura radius at dress time. 0.055 tube
// on a radius of 1 is the thinnest band that still survives mip-down to ~25 m.
const BAND_GEO = () => ring(1, 0.055, 4, 30);

function bitGeo(shape, r) {
  if (shape === 'spike') return cone(r * 0.55, r * 2.6, 4);
  if (shape === 'shard') return cone(r * 0.7, r * 2.0, 3);
  return ico(r, 0);
}

function makeAura(rig, radius) {
  // The carrier: up to three thin rings. See the note on ELITE for why this is
  // not the filled shell it replaced.
  const a = new THREE.Group();
  a.position.y = rig.centerY;
  a.visible = false;
  for (let i = 0; i < AURA_BANDS; i++) {
    const b = new THREE.Mesh(BAND_GEO(), auraMat('emberclad'));
    b.scale.setScalar(radius);
    b.frustumCulled = false;
    a.add(b);
  }
  rig.pivot.add(a);
  rig.aura = a;

  const bits = new THREE.Group();
  bits.position.y = rig.centerY;
  bits.visible = false;
  for (let i = 0; i < AURA_BITS; i++) {
    const b = new THREE.Mesh(bitGeo('ico', radius * 0.14), bitMat('emberclad'));
    const ang = (i / AURA_BITS) * Math.PI * 2;
    b.position.set(Math.cos(ang) * radius, 0, Math.sin(ang) * radius);
    bits.add(b);
  }
  rig.pivot.add(bits);
  rig.auraBits = bits;

  // The barrier: a 20-face crystal drawn as a bright wireframe over a token
  // fill, and scaled taller than it is wide so its own outline is not a circle.
  const ward = new THREE.Group();
  const shell = new THREE.Mesh(ico(1, 0), wardMat('fill'));
  const edge = new THREE.Mesh(ico(1.006, 0), wardMat('edge'));
  ward.add(shell, edge);
  ward.scale.set(radius * 0.98, radius * 1.28, radius * 0.98);
  ward.position.y = rig.centerY;
  ward.visible = false;
  ward.frustumCulled = false;
  rig.pivot.add(ward);
  rig.ward = ward;
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
    const e = this.affix ? ELITE[this.affix] : null;
    const on = !!e;
    this.aura.visible = on && (e.bands || 0) > 0;
    this.auraBits.visible = on && (e.bits || 0) > 0;
    if (this.ward) this.ward.visible = on && !!e.ward;
    if (on) {
      const am = auraMat(this.affix);
      const nb = e.bands || 0;
      for (let i = 0; i < this.aura.children.length; i++) {
        const band = this.aura.children[i];
        band.visible = i < nb;
        if (!band.visible) continue;
        band.material = am;
        // Bands are laid out as a fan about the vertical: one band is a flat
        // halo, two are a shallow cross, three are a gyroscope cage. The tilt
        // is the affix's, so the *pose* of the rings is part of the signature
        // and not only their count.
        const t = nb === 1 ? 0 : (i / (nb - 1)) * 2 - 1;
        band.rotation.set(-Math.PI * 0.5 + t * (e.tilt || 0), 0, (i * Math.PI * 2) / Math.max(1, nb));
      }
      const bm = bitMat(this.affix);
      const n = e.bits || 0;
      const shape = e.shape || 'ico';
      const r = this.auraR * (e.bitScale || 0.11);
      for (let i = 0; i < this.auraBits.children.length; i++) {
        const b = this.auraBits.children[i];
        b.visible = i < n;
        if (!b.visible) continue;
        b.material = bm;
        // Geometries are cached by shape+radius, so re-dressing a pooled rig
        // for a different affix costs a property write and nothing else.
        b.geometry = bitGeo(shape, r);
        const ang = (i / Math.max(1, n)) * Math.PI * 2;
        b.position.set(Math.cos(ang) * this.auraR, 0, Math.sin(ang) * this.auraR);
      }
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
  // The rig is changing hands, so anything still holding it from its last life
  // has to be able to find that out. Presentation effects outlive the kill they
  // were fired by -- `deathDissolve` runs 0.85 s and ends by hiding what is
  // left -- but `Director.clear` (src/systems/Director.js:966, every stage
  // change) despawns immediately regardless of `finished`, which drops the rig
  // straight back into `POOL` for the next stage's first spawn. An effect that
  // could not tell those two lives apart finished by hiding a live, damageable
  // monster that nothing would make visible again until it died. This counter
  // is the only handle on that: capture it when you take the root, compare it
  // before you write to the root, and drop yourself when it no longer matches.
  this.root.userData.rigEpoch = (this.root.userData.rigEpoch | 0) + 1;
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
  setShadow(this.shadow, 0, 0, 0, 0, 0);
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

  updateShadow(rig, a);

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

  const affixDef = rig.affix ? ELITE[rig.affix] : null;
  if (rig.aura && rig.aura.visible && affixDef) {
    // Bands only breathe; they never grow into the host. The whole point of
    // replacing the shell was that the affix stops competing with the body for
    // the same pixels, and a band that swells on the wind-up would walk it
    // straight back.
    const pulse = 1 + Math.sin(a.t * 5.5) * 0.04 + a.windup * 0.08;
    const spin = affixDef.spin ?? 0.9;
    rig.aura.rotation.y = a.t * spin;
    rig.aura.scale.setScalar(pulse * (1 - a.death * 0.5));
  }
  const bits = rig.auraBits;
  if (bits && bits.visible && affixDef) {
    const e = affixDef;
    bits.rotation.y = a.t * (e.helix ? 0.9 : (e.spin ?? 1.4));
    const n = bits.children.length;
    for (let i = 0; i < n; i++) {
      const b = bits.children[i];
      if (!b.visible) continue;
      if (e.helix) {
        // Thorns climb a slow helix and point outward — a rising column of
        // spines rather than a ring of sparks, which is what separates a
        // withering elite from an emberclad one at fifty metres.
        const k = ((a.t * 0.22 + i / n) % 1);
        b.position.y = (k - 0.5) * rig.auraR * 2.1;
        b.rotation.z = -Math.PI * 0.5;
        b.rotation.y = k * Math.PI * 2;
        b.scale.setScalar(0.6 + Math.sin(k * Math.PI) * 0.7);
      } else if (e.rise) {
        // Embers: shards climb the outside of the unit, taper as they go and
        // recycle at the feet. Emberclad is the only affix whose bits have a
        // direction, which is what stops it reading as galvanic in orange.
        const k = ((a.t * 0.55 + i / n) % 1);
        b.position.y = (k - 0.35) * rig.auraR * 1.9;
        b.position.x = Math.cos(a.t * 0.6 + (i / n) * Math.PI * 2) * rig.auraR * (1 - k * 0.35);
        b.position.z = Math.sin(a.t * 0.6 + (i / n) * Math.PI * 2) * rig.auraR * (1 - k * 0.35);
        b.rotation.set(0, 0, 0);
        b.scale.setScalar(0.5 + (1 - k) * 0.9);
      } else {
        b.position.y = Math.sin(a.t * 3 + i * 1.7) * rig.auraR * 0.5;
        b.rotation.x = a.t * 2 + i;
        b.scale.setScalar(0.7 + Math.sin(a.t * 6 + i) * 0.3);
      }
    }
  }
  if (rig.ward && rig.ward.visible) {
    // Slow tumble, and it swells on the wind-up so the barrier is loudest at
    // exactly the moment the unit is about to be dangerous. Non-uniform on
    // purpose — a crystal taller than it is wide is not a disc.
    rig.ward.rotation.y = a.t * 0.55;
    rig.ward.rotation.x = Math.sin(a.t * 0.4) * 0.3;
    const s = (1.02 + Math.sin(a.t * 3.1) * 0.03 + a.windup * 0.1) * (1 - a.death * 0.6);
    rig.ward.scale.set(rig.auraR * 0.98 * s, rig.auraR * 1.28 * s, rig.auraR * 0.98 * s);
  }
}

// ---------------------------------------------------------------------------
// LEMURIAN — bipedal lizard. Long horizontal S-curve, heavy tail counterweight.
// Silhouette cue: low forward-leaning body with a tail as long as the torso.
// ---------------------------------------------------------------------------

const LEM_HIP = 1.0, LEM_L1 = 0.5, LEM_L2 = 0.5;

function buildSkink() {
  const rig = newRig('skink');
  rig.centerY = 0.95;
  rig.height = 1.7;
  rig.auraR = 1.35;
  rig.shadowR = 0.7;

  const spine = grp(rig.pivot, 0, LEM_HIP, 0);
  rig.parts.spine = spine;

  // Narrow in X, long in Z, and crested: as a black shape the skink has to
  // be the *lean* biped, distinct from the sentinel's slab at any distance. The
  // dorsal blades are the cue that survives once the head is a few pixels.
  add(rig, spine, 'body', merged('lem.torso', [
    P(box(0.42, 0.5, 0.55), 0, 0, -0.14),
    P(box(0.48, 0.5, 0.8), 0, 0.05, 0.42),
    P(box(0.38, 0.3, 0.3), 0, 0.02, 0.82),
    P(cone(0.2, 0.56), 0, 0.42, 0.48, -0.22, 0, 0, 0.3, 1, 1),
    P(cone(0.22, 0.64), 0, 0.46, 0.12, -0.08, 0, 0, 0.3, 1, 1),
    P(cone(0.2, 0.54), 0, 0.4, -0.24, 0.14, 0, 0, 0.3, 1, 1),
    P(cone(0.15, 0.38), 0, 0.3, -0.5, 0.3, 0, 0, 0.3, 1, 1),
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
    P(box(0.2, 0.16, 0.44), 0, -0.04, 0.5),
    P(box(0.34, 0.07, 0.18), 0, 0.14, 0.2),
    P(cone(0.05, 0.24), 0.12, 0.19, 0.04, -0.5),
    P(cone(0.05, 0.24), -0.12, 0.19, 0.04, -0.5),
  ]));
  // Angled slits, not discs. The eye shape is half of what identifies a
  // species at the distance where the body is one value.
  add(rig, head, 'eye', merged('lem.eyes', [
    P(box(0.13, 0.035, 0.05), 0.115, 0.075, 0.25, 0, 0, -0.28),
    P(box(0.13, 0.035, 0.05), -0.115, 0.075, 0.25, 0, 0, 0.28),
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
  rig.animate = animSkink;
  return rig;
}

function animSkink(rig, a) {
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

function buildScarab() {
  const rig = newRig('scarab');
  rig.centerY = 0.45;
  rig.height = 0.95;
  rig.auraR = 0.95;
  rig.shadowR = 0.78;

  const body = grp(rig.pivot, 0, 0.44, 0);
  rig.parts.body = body;

  add(rig, body, 'body', merged('bee.shell', [
    P(hemi(0.5, 12, 5), 0, -0.02, -0.06, 0, 0, 0, 1.42, 0.66, 1.5),
    P(box(0.08, 0.18, 1.12), 0, 0.3, -0.06),
    // Flared rear plates — the widest point is behind the middle, which is
    // what makes the scarab read as a wedge rather than a lump.
    P(box(0.62, 0.11, 0.4), 0.34, 0.16, -0.52, 0, 0, -0.4),
    P(box(0.62, 0.11, 0.4), -0.34, 0.16, -0.52, 0, 0, 0.4),
  ]));
  add(rig, body, 'dark', merged('bee.underside', [
    P(box(0.9, 0.16, 1.15), 0, -0.12, -0.04),
  ]));

  const head = grp(body, 0, -0.04, 0.6);
  rig.parts.head = head;
  crumbles(rig, head);
  // Rhino horn. It is the one vertical line on an otherwise entirely
  // horizontal animal, so a scarab is identifiable as a black shape from any
  // angle — and it points where the headbutt is going.
  add(rig, head, 'dark', merged('bee.head', [
    P(box(0.36, 0.26, 0.3), 0, 0, 0.02),
    P(box(0.42, 0.1, 0.12), 0, 0.12, 0.06),
    P(cone(0.075, 0.62, 6), 0, 0.3, 0.1, -0.5),
    P(cone(0.04, 0.3, 5), 0.19, 0.12, 0.06, -0.75),
    P(cone(0.04, 0.3, 5), -0.19, 0.12, 0.06, -0.75),
  ]));
  // Compound eye: a cluster of small facets, never one disc.
  add(rig, head, 'eye', merged('bee.eyes', [
    P(ico(0.045, 0), 0.16, 0.06, 0.1),
    P(ico(0.033, 0), 0.185, 0.0, 0.05),
    P(ico(0.03, 0), 0.13, 0.11, 0.07),
    P(ico(0.045, 0), -0.16, 0.06, 0.1),
    P(ico(0.033, 0), -0.185, 0.0, 0.05),
    P(ico(0.03, 0), -0.13, 0.11, 0.07),
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
  rig.animate = animScarab;
  return rig;
}

// Alternating tripod: {R-front, R-back, L-mid} vs {R-mid, L-front, L-back}.
const BEE_PHASE = [0, Math.PI, 0, Math.PI, 0, Math.PI];

function animScarab(rig, a) {
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

function buildMote() {
  const rig = newRig('mote');
  rig.centerY = 0;
  rig.height = 1.1;
  rig.auraR = 1.0;
  rig.shadowR = 0.6;
  rig.flyer = true;

  const core = add(rig, rig.pivot, 'accent', ico(0.32, 1), 0, 0, 0);
  rig.parts.core = core;

  // Tall, narrow, spired — a vertical diamond. The shrike is the other floating
  // ~1 m unit in the roster and it is a wide flat dome; these two must never
  // resolve to the same blob.
  const shell = grp(rig.pivot, 0, 0, 0);
  rig.parts.shell = shell;
  const plates = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    plates.push(P(box(0.15, 0.78, 0.3), Math.cos(ang) * 0.38, 0, Math.sin(ang) * 0.38, 0, -ang, 0.2));
  }
  plates.push(P(cone(0.19, 0.6, 5), 0, 0.62, 0));
  plates.push(P(cone(0.16, 0.44, 5), 0, -0.52, 0, Math.PI));
  /* `dark`, and it stays `dark` — **repainting this shell is REFUTED, do not
   * re-apply it.**
   *
   * `mote` is the only build in this file that never uses its own `body` colour
   * (`0x2c1a34` is declared and unreferenced), and the shell is the whole
   * silhouette, so `add(rig, shell, 'body', ...)` looks like an obvious repair —
   * especially against `11-bestiary`, where object 4's median masked pixel reads
   * luminance **19 against a background of 17** for `sepP50 0.15` against the
   * 0.25 floor (`reviews/round6/lastdiag2/manifest.json`, `DIAG roster`).
   *
   * It was applied, captured full to `reviews/round6/wispA/manifest.json`, and it
   * traded one failing shot for two. `11-bestiary` did pass (object 4 `sepP50`
   * 0.15 -> 0.25, `lumP50` 19 -> 31) — and on the same capture:
   *
   *   - `06-loaded-hud` -> `monsters under load` started failing, object 4
   *     `perSep` **0.27 -> 0.23**;
   *   - `08-explosion` -> `monsters standing in it` started failing, object 4
   *     `perSep` **0.33 -> 0.17**.
   *
   * `perPx` is byte-identical in both, so nothing moved and nothing was hidden:
   * the same lift that pulled the shell *away* from a dark backdrop pushed it
   * *into* a bright one. Separation is a distance from the background, not a
   * brightness, and this rig is photographed against both. A single albedo
   * cannot satisfy all three frames, so the frame that is the outlier gets
   * fixed instead — see the flyer-hover clamp in `Harness.js` `bestiary()`.
   *
   * Reverted. Three failing shots against a documented two. */
  add(rig, shell, 'dark', merged('mote.shell', plates));

  const emb = grp(rig.pivot, 0, 0, 0);
  rig.parts.embers = emb;
  add(rig, emb, 'eye', merged('mote.embers', [
    P(ico(0.085, 0), 0.78, 0.1, 0),
    P(ico(0.07, 0), -0.4, -0.14, 0.66),
    P(ico(0.06, 0), -0.38, 0.2, -0.66),
  ]));

  rig.parts.tendril = [];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.4;
    const g = grp(rig.pivot, Math.cos(ang) * 0.2, -0.22, Math.sin(ang) * 0.2);
    add(rig, g, 'dark', merged('mote.tendril', [
      P(cone(0.07, 0.6, 5), 0, -0.3, 0, Math.PI),
    ]));
    rig.parts.tendril.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animMote;
  return rig;
}

function animMote(rig, a) {
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

function buildSentinel() {
  const rig = newRig('sentinel');
  rig.centerY = 1.9;
  rig.height = 3.6;
  rig.auraR = 2.3;
  rig.shadowR = 1.35;

  // Wide, shallow, top-heavy: the sentinel is a slab carried on stubby legs, and
  // the shoulder line has to be the widest thing in the horde short of the
  // colossus. Deep-set head under an overhanging brow, no neck.
  const spine = grp(rig.pivot, 0, GOL_HIP, 0);
  rig.parts.spine = spine;
  add(rig, spine, 'body', merged('gol.torso', [
    P(box(1.9, 1.35, 0.8), 0, 0.3, 0),
    P(box(1.15, 0.5, 0.75), 0, -0.55, 0),
    P(box(0.62, 0.72, 0.9), 1.12, 0.62, 0, 0, 0, -0.18),
    P(box(0.62, 0.72, 0.9), -1.12, 0.62, 0, 0, 0, 0.18),
    P(box(1.6, 0.26, 0.34), 0, 0.95, -0.34),
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
    P(box(0.58, 0.44, 0.5), 0, -0.04, 0),
    P(box(0.98, 0.24, 0.46), 0, 0.26, 0.1),
    P(cone(0.1, 0.32), 0.34, 0.36, -0.05, -0.3),
    P(cone(0.1, 0.32), -0.34, 0.36, -0.05, -0.3),
  ]));
  // The one species that keeps a single big disc — and it only reads as
  // "cyclops" because nothing else in the roster has one any more.
  rig.parts.eye = add(rig, head, 'eye', ico(0.19, 1), 0, -0.04, 0.28);
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
    const sh = grp(spine, 1.14 * s, 0.6, 0);
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
  rig.animate = animSentinel;
  return rig;
}

function animSentinel(rig, a) {
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

function buildShrike() {
  const rig = newRig('shrike');
  rig.centerY = 0;
  rig.height = 1.0;
  rig.auraR = 0.95;
  rig.shadowR = 0.62;
  rig.flyer = true;

  // Wide and flat — a parasol. Against the mote's vertical spire this is the
  // horizontal floating shape, and the overhang is what the long tendrils hang
  // off so the whole thing reads top-heavy.
  const bell = grp(rig.pivot, 0, 0.06, 0);
  rig.parts.bell = bell;
  add(rig, bell, 'body', merged('shrike.bell', [
    P(hemi(0.5, 12, 6), 0, 0, 0, 0, 0, 0, 1.26, 0.62, 1.26),
    P(cyl(0.63, 0.46, 0.1, 12), 0, -0.04, 0),
    P(cone(0.08, 0.34), 0.4, 0.16, 0, 0, 0, -0.9),
    P(cone(0.08, 0.34), -0.4, 0.16, 0, 0, 0, 0.9),
    P(cone(0.08, 0.34), 0, 0.16, 0.4, 0.9),
  ]));
  rig.parts.sac = add(rig, rig.pivot, 'accent', ico(0.27, 1), 0, -0.02, 0);
  // A row of spots around the rim rather than a pair of headlights.
  add(rig, bell, 'eye', merged('shrike.spots', [
    P(ico(0.05, 0), 0.2, 0.2, 0.44),
    P(ico(0.05, 0), -0.2, 0.2, 0.44),
    P(ico(0.04, 0), 0.44, 0.16, 0.24),
    P(ico(0.04, 0), -0.44, 0.16, 0.24),
    P(ico(0.045, 0), 0, 0.25, -0.46),
  ]));

  rig.parts.tendril = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const g = grp(rig.pivot, Math.cos(ang) * 0.44, -0.08, Math.sin(ang) * 0.44);
    add(rig, g, 'dark', merged('shrike.tendril', [
      P(cyl(0.05, 0.012, 1.05, 5), 0, -0.52, 0),
      P(ico(0.035, 0), 0, -1.05, 0),
    ]));
    rig.parts.tendril.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animShrike;
  return rig;
}

function animShrike(rig, a) {
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

// Proportions. The old rig hung a 3.8 m leg chain off a 2.85 m hip, and the leg
// IK only runs at `lod === 0` — so any colossus the LOD system skipped stood on
// dead-straight legs with 1.25 m of shin and both feet buried under the world.
// In the shot that exists to judge it, the body stopped 32 px above its own
// contact shadow with nothing bridging the gap: a floating slab.
//
// The chain is now 2.72 m against a 2.65 m hip, so the REST pose — legs
// straight, no animator — already plants the ankles on the ground plane, and
// the IK only ever bends from there. Short thick legs under an enormous upper
// body is also the correct read: a colossus is not a man scaled up, it is
// bottom-heavy, and the old 1.9 + 1.9 spindles were what made this thing look
// like a monolith on stilts.
const TIT_HIP = 3.6, TIT_L1 = 1.40, TIT_L2 = 1.32;
const TIT_HIP_DROP = 0.95;   // hip joint below the spine origin

function buildColossus() {
  const rig = newRig('colossus');
  rig.centerY = 3.6;
  rig.height = 7.6;
  rig.auraR = 4.4;
  rig.shadowR = 2.6;

  const spine = grp(rig.pivot, 0, TIT_HIP, 0);
  rig.parts.spine = spine;

  // The body is a STACK of differently-proportioned masses, never one box. A
  // 3.2 x 2.3 slab presents one flat quad to the camera, and one quad takes one
  // value no matter how good the lighting is — which is precisely how eight
  // metres of stone photographed as a sheet of mauve cardboard. Hex prisms and
  // icosahedral boulders put six-to-twenty differently-angled facets where the
  // slab had one face, and the hemispheric albedo term then separates them.
  add(rig, spine, 'body', merged('tit.torso', [
    // Pelvic girdle — wide, heavy, and the thing the legs actually hang off.
    // Its top face is at -0.525 and the ribcage's underside at +0.07, which
    // leaves a deliberate 0.6 m gap: that gap is the waist, and the waist is
    // where the core lives.
    P(cyl(1.62, 1.42, 1.25, 6), 0, -1.15, 0, 0, Math.PI / 6, 0, 1.12, 1, 0.92),
    // Ribcage: a tapered hex barrel, narrow at the waist and flaring up to the
    // deck. The taper is the whole reason the torso reads as a wedge and not a
    // rectangle when it is keyed to pure black.
    P(cyl(2.05, 1.30, 1.90, 6), 0, 1.02, 0, 0, Math.PI / 6, 0, 1.06, 1, 0.86),
    // Shoulder deck. Narrower than the arms hang, deliberately: if the deck is
    // the widest thing on the rig then the arms live inside the torso outline
    // and the whole colossus keys to one undifferentiated block.
    P(box(3.9, 0.8, 2.05), 0, 2.28, -0.05),
    // Shoulder crags — asymmetric on purpose. Matched pauldrons read as a
    // machine; a colossus is a rock formation, and the left/right mismatch is
    // what stops the top of the silhouette being a straight line.
    P(ico(1.05, 0), 1.92, 2.42, -0.1, 0.3, 0.7, 0.2, 1, 0.85, 1),
    P(ico(0.88, 0), -2.02, 2.28, 0.05, -0.2, 1.4, -0.3, 1, 0.9, 1.1),
    P(ico(0.58, 0), 1.28, 2.92, -0.5, 0.5, 0.2, 0),
    // Back ridge + spines, irregularly spaced and pitched.
    P(box(2.5, 0.5, 0.6), 0, 2.05, -1.05),
    P(cone(0.36, 1.75), 0.72, 2.75, -0.95, -0.42),
    P(cone(0.30, 1.35), -0.95, 2.60, -0.90, -0.30, 0, 0.2),
    P(cone(0.26, 1.15), -0.05, 2.90, -1.20, -0.55),
  ]));

  // Recesses, joints and the underside the plates hang off. `dark` is matte and
  // non-metallic against a smooth semi-metallic `body`, so the panel breaks
  // separate on specular response as well as on value.
  add(rig, spine, 'dark', merged('tit.plates', [
    // Constricted waist spine, bridging the gap. The chest and the hips are
    // both ~4 m wide; cinching the middle to 1.9 is what makes the mass above
    // read as mass, and it is the collar the core is clamped in.
    P(cyl(0.90, 0.98, 1.05, 6), 0, -0.24, 0, 0, Math.PI / 6, 0),
    // Panel breaks. Every one of these had to be pushed out past the hex
    // prism's flat-face distance (0.866 * r * depth-scale) or it renders inside
    // the mass it is supposed to be sitting on and does nothing at all.
    P(box(3.5, 0.3, 0.35), 0, 1.90, 1.42),
    P(box(2.7, 0.28, 0.32), 0, -1.30, 1.15),
    P(box(0.55, 1.5, 0.5), 1.62, 2.05, 1.05, 0, 0, -0.18),
    P(box(0.55, 1.5, 0.5), -1.62, 2.05, 1.05, 0, 0, 0.18),
  ]));

  // THE CORE. It used to be a 0.55 ico pinned to the chest at +Z 1.02, i.e. one
  // hemisphere of it, on the front only — and the boss has been photographed
  // side-on and back-on for three rounds, so the single feature that was
  // supposed to anchor the eye had never appeared in a frame. It now sits IN
  // the waist gap, proud of the 0.95 collar on every side: chest above, hips
  // below, glowing furnace clamped between them. There is no camera angle from
  // which it is occluded.
  // A 2.2 m furnace in a 0.6 m gap: chest above, hips below, and roughly a
  // third of the sphere exposed all the way round. Nothing occludes it from any
  // bearing, which is the whole point — it is the eye anchor and the readable
  // health state, and for three rounds it was never once in frame.
  rig.parts.core = add(rig, spine, 'accent', ico(1.00, 1), 0, -0.23, 0);
  // Cracks radiating off the core: front, back and both flanks, so the heat
  // reaches the outline from every angle too. Each one is placed just proud of
  // its host prism's face, not at a plausible-looking depth.
  add(rig, spine, 'accent', merged('tit.veins', [
    P(box(0.17, 0.95, 0.16), 0.60, 1.10, 1.30, 0, 0, -0.28),
    P(box(0.15, 0.80, 0.15), -0.52, 1.28, 1.30, 0, 0, 0.32),
    P(box(0.17, 0.95, 0.16), 0.28, 1.10, -1.30, 0, 0, 0.22),
    P(box(0.15, 0.85, 0.15), -0.66, 1.20, -1.30, 0, 0, -0.26),
    P(box(0.15, 1.05, 0.14), 1.62, 0.80, 0.20, 0, 0, -0.30),
    P(box(0.15, 1.05, 0.14), -1.62, 0.80, 0.20, 0, 0, 0.30),
    P(box(0.16, 0.65, 0.15), 0.35, -0.95, 1.25, 0, 0, 0.20),
    P(box(0.16, 0.65, 0.15), -0.40, -0.95, -1.25, 0, 0, -0.20),
  ]));

  // Head: brow-heavy, sunk between the shoulder crags so the outline has a
  // notch on each side of it. A boss whose head is a lump on top of a rectangle
  // has no head.
  const head = grp(spine, 0, 2.62, 0.42);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'body', merged('tit.head', [
    P(cyl(0.62, 0.78, 0.95, 6), 0, 0, 0, 0, Math.PI / 6, 0, 1.15, 1, 1.0),
    // Overhanging brow — the eyes read as *set back under* something.
    P(box(1.42, 0.42, 1.15), 0, 0.55, 0.12, -0.16),
    P(cone(0.2, 0.62), 0.6, 0.82, -0.1, -0.25, 0, 0.35),
    P(cone(0.2, 0.62), -0.6, 0.82, -0.1, -0.25, 0, -0.35),
  ]));
  add(rig, head, 'dark', merged('tit.jaw', [
    P(box(1.05, 0.42, 0.9), 0, -0.48, 0.1),
  ]));
  // Furnace mouth. The head gets its own warm source so it holds the eye even
  // when the fists are up and the core is behind an arm.
  add(rig, head, 'accent', merged('tit.maw', [
    P(box(0.75, 0.16, 0.15), 0, -0.34, 0.58),
    P(box(0.12, 0.22, 0.15), 0.26, -0.46, 0.56),
    P(box(0.12, 0.22, 0.15), -0.26, -0.46, 0.56),
  ]));
  rig.parts.eyes = [];
  rig.parts.beam = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const g = grp(head, 0.34 * s, 0.08, 0.5);
    // Wide lenses rather than balls — a boss face has to read as a face at
    // 30 m, and two round dots at that size are two more white bloom blobs.
    rig.parts.eyes.push(add(rig, g, 'eye',
      merged('tit.eye', [P(ico(0.2, 1), 0, 0, 0, 0, 0, 0, 1.9, 0.6, 1)]), 0, 0, 0));
    rig.parts.beam.push(beam(rig, g, 0, 0.06));
  }

  // Arms hang to knee height and end in fists you can actually identify. The
  // old hand was a 1.1 cube on the end of a 3.3 m arm — at boss distance that
  // is four pixels of nothing, on a rig whose own comment sells "two fists it
  // raises over its head".
  const upper = [
    P(cyl(0.78, 0.64, 1.55, 7), 0, -0.78, 0),
    P(ico(0.86, 0), 0, 0.12, 0, 0.2, 0.6, 0, 1, 0.9, 1),
  ];
  const fore = [
    P(cyl(0.62, 0.82, 1.45, 7), 0, -0.72, 0),
    // Fist: a blocky mass with three knuckle wedges over the top of it, so the
    // hand has a direction and the raised-fist pose reads as a threat.
    P(box(1.55, 1.35, 1.5), 0, -2.05, 0.05),
    P(box(1.62, 0.34, 0.42), 0, -1.55, 0.52, -0.2),
    P(cone(0.3, 0.7), 0.5, -1.35, 0.45, -0.5),
    P(cone(0.3, 0.7), -0.02, -1.28, 0.5, -0.5),
    P(cone(0.3, 0.7), -0.54, -1.35, 0.45, -0.5),
  ];
  rig.parts.arm = [];
  rig.parts.elbow = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const sh = grp(spine, 2.62 * s, 2.05, 0);
    add(rig, sh, 'body', merged('tit.upper', upper));
    const el = grp(sh, 0, -1.55, 0);
    add(rig, el, 'body', merged('tit.fore', fore));
    // Knuckle heat, so a raised fist is legible against the sky.
    add(rig, el, 'accent', merged('tit.knuckle', [
      P(box(1.25, 0.14, 0.16), 0, -1.42, 0.6),
    ]));
    crumbles(rig, el);
    rig.parts.arm.push(sh);
    rig.parts.elbow.push(el);
  }

  // Legs: short, thick, splayed. Base wider than the head is most of what makes
  // a thing read as a colossus rather than a standing stone.
  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 1.25 * s, -TIT_HIP_DROP, 0);
    add(rig, hip, 'dark', merged('tit.thigh', [
      P(cyl(0.98, 0.82, TIT_L1, 7), 0, -TIT_L1 * 0.5, 0),
    ]));
    const knee = grp(hip, 0, -TIT_L1, 0);
    add(rig, knee, 'dark', merged('tit.shin', [
      P(cyl(0.80, 0.98, TIT_L2, 7), 0, -TIT_L2 * 0.5, 0),
      // Foot sits ON the ankle, not a metre below it.
      P(box(1.7, 0.5, 2.2), 0, -TIT_L2 + 0.2, 0.3),
      P(box(1.5, 0.3, 0.5), 0, -TIT_L2 + 0.12, 1.35),
    ]));
    add(rig, knee, 'body', merged('tit.knee', [
      P(ico(0.62, 0), 0, -0.05, 0.28, 0.2, 0.4, 0),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animColossus;
  return rig;
}

function animColossus(rig, a) {
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

  // The core is the health-bar you can see across the arena. Smaller swing than
  // before: it is a 1.02 furnace clamped in a 0.95 waist collar now, not a 0.55
  // badge stuck on the chest, so it does not need to double in size to be seen.
  p.core.scale.setScalar(1 + rage * 0.18 + w * 0.35 + Math.sin(a.t * (2.4 + rage * 3)) * (0.05 + rage * 0.05));

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
      p.arm[i].rotation.z = s * (0.20 + w * 0.35 - rel * 0.3);
      p.elbow[i].rotation.x = -w * 0.9 + rel * 0.7;
    } else if (barrage) {
      p.arm[i].rotation.x = -w * 0.5;
      p.arm[i].rotation.z = s * (0.28 + w * 1.0);
      p.elbow[i].rotation.x = -0.3 - w * 0.4;
    } else {
      p.arm[i].rotation.x = Math.sin(a.stride + i * Math.PI) * 0.3 * sp - w * stomp * 0.4;
      // Splayed enough that the forearm clears the ribcage by ~0.2 m: an arm
      // tucked inside the torso outline contributes nothing to the silhouette
      // no matter how well it is modelled.
      p.arm[i].rotation.z = s * (0.26 + w * 0.3);
      p.elbow[i].rotation.x = -0.25 - Math.abs(Math.sin(a.stride + i * Math.PI)) * 0.2 * sp;
    }
  }

  if (a.lod > 0) return common(rig, a);

  // Shorter stride and lower lift to match the shorter chain — the old numbers
  // were sized for 3.8 m legs and would clamp against the IK's reach every step.
  const stride = 0.62 * sp + 0.06;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    // The stomp lifts the right leg to the chest, then drives it down.
    const lift = stomp && i === 0 ? w * 1.5 - rel * 1.6 : 0;
    solveLeg(p.hip[i], p.knee[i], TIT_L1, TIT_L2,
      stepZ(ph, stride) * sp + lift * 0.4,
      -(TIT_HIP - TIT_HIP_DROP) + stepY(ph, 0.4) * sp + Math.max(0, lift) * 1.1 + (TIT_HIP - hipY), 1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// MITE — knee-high chaff. Half a metre tall with a tail spike held vertical:
// the roster's smallest silhouette, and the only one whose read is "there are
// nine of these" rather than "there is one of these".
// ---------------------------------------------------------------------------

function buildMite() {
  const rig = newRig('mite');
  rig.centerY = 0.26;
  rig.height = 0.5;
  rig.auraR = 0.5;
  rig.shadowR = 0.34;

  const body = grp(rig.pivot, 0, 0.24, 0);
  rig.parts.body = body;

  // A grain of rice with armour. The two rear scutes flare wider than the
  // shoulders so even at four pixels the shape has a taper.
  add(rig, body, 'body', merged('mite.shell', [
    P(hemi(0.22, 8, 4), 0, -0.01, 0, 0, 0, 0, 1.15, 0.9, 1.6),
    P(box(0.26, 0.07, 0.2), 0, 0.09, -0.14, 0.3),
    P(box(0.2, 0.06, 0.16), 0.12, 0.05, -0.2, 0, 0, -0.5),
    P(box(0.2, 0.06, 0.16), -0.12, 0.05, -0.2, 0, 0, 0.5),
  ]));
  add(rig, body, 'dark', merged('mite.belly', [P(box(0.3, 0.08, 0.44), 0, -0.09, -0.02)]));

  const head = grp(body, 0, -0.02, 0.24);
  rig.parts.head = head;
  add(rig, head, 'dark', merged('mite.head', [
    P(box(0.16, 0.12, 0.16), 0, 0, 0.02),
    P(cone(0.035, 0.16, 4), 0.06, 0.02, 0.12, -1.2),
    P(cone(0.035, 0.16, 4), -0.06, 0.02, 0.12, -1.2),
  ]));
  add(rig, head, 'eye', merged('mite.eyes', [
    P(ico(0.03, 0), 0.06, 0.05, 0.06),
    P(ico(0.03, 0), -0.06, 0.05, 0.06),
  ]));

  // Tail spike, carried up. It is the whole reason a mite is not just a small
  // scarab as a black shape: a vertical line off a horizontal body.
  const tail = grp(body, 0, 0.04, -0.22);
  rig.parts.tail = tail;
  add(rig, tail, 'body', merged('mite.tail', [
    P(cyl(0.05, 0.03, 0.22, 5), 0, 0.1, -0.04, 0.5),
    P(cone(0.045, 0.2, 5), 0, 0.26, -0.12, 0.2),
  ]));
  add(rig, tail, 'accent', merged('mite.sting', [P(ico(0.035, 0), 0, 0.36, -0.15)]));

  const legR = [
    P(cyl(0.024, 0.018, 0.19, 4), 0.07, -0.05, 0, 0, 0, -1.0),
    P(cyl(0.02, 0.012, 0.2, 4), 0.15, -0.16, 0, 0, 0, -0.2),
  ];
  merged('mite.legR', legR);
  merged('mite.legL', mirror(legR));
  rig.parts.leg = [];
  const zs = [0.14, -0.12];
  for (let i = 0; i < 4; i++) {
    const right = i < 2;
    const hip = grp(body, 0.13 * (right ? 1 : -1), -0.05, zs[i % 2]);
    add(rig, hip, 'dark', merged(right ? 'mite.legR' : 'mite.legL', right ? legR : mirror(legR)));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animMite;
  return rig;
}

const MITE_PHASE = [0, Math.PI, Math.PI, 0];

function animMite(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const hit = a.swing > 0 ? strike(a.swing) : 0;

  // Everything about a mite is twitchy: a fast scurry bob and a tail that
  // snaps forward with the bite.
  p.body.position.y = 0.24 + Math.sin(a.stride * 2) * 0.03 * sp + w * 0.06;
  p.body.position.z = hit * 0.24 - w * 0.06;
  p.body.rotation.x = -w * 0.5 + hit * 0.55 - 0.08 * sp;
  p.body.rotation.z = Math.sin(a.stride) * 0.14 * sp;

  p.head.rotation.x = w * 0.35 - hit * 0.4;
  p.head.rotation.y = a.lookY * 0.6;
  p.tail.rotation.x = -0.3 - w * 0.8 + hit * 1.5 + Math.sin(a.t * 6) * 0.12;
  p.tail.rotation.z = Math.sin(a.t * 4.3) * 0.18;

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 4; i++) {
    const ph = a.stride * 2.1 + MITE_PHASE[i];
    const leg = p.leg[i];
    leg.rotation.x = Math.cos(ph) * (0.2 + 0.6 * sp);
    leg.rotation.z = -Math.max(0, -Math.sin(ph)) * 0.5 * sp * (i < 2 ? 1 : -1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// SPITLING — a pressurised bile sac on three stubby legs with a stubby mortar
// snout. Squat and top-heavy: the sac is more than half the silhouette and it
// visibly INFLATES before the shot, which is the entire tell.
// ---------------------------------------------------------------------------

function buildSpitling() {
  const rig = newRig('spitling');
  rig.centerY = 0.55;
  rig.height = 1.0;
  rig.auraR = 0.9;
  rig.shadowR = 0.6;

  const body = grp(rig.pivot, 0, 0.52, 0);
  rig.parts.body = body;

  add(rig, body, 'dark', merged('spit.hull', [
    P(hemi(0.4, 10, 5), 0, -0.12, 0, 0, 0, 0, 1.2, 0.7, 1.15),
    P(cyl(0.44, 0.5, 0.16, 8), 0, -0.16, 0),
    // Vent ribs around the waist — the pressure vessel reads as a pressure
    // vessel because it is visibly banded.
    P(ring(0.44, 0.05, 4, 14), 0, 0.02, 0, Math.PI * 0.5),
  ]));
  // The sac. `accent` so it self-illuminates and the swell is legible at range.
  rig.parts.sac = add(rig, body, 'accent', ico(0.34, 1), 0, 0.2, -0.06);
  add(rig, body, 'body', merged('spit.plates', [
    P(box(0.16, 0.3, 0.34), 0.34, 0.1, -0.04, 0, 0, -0.5),
    P(box(0.16, 0.3, 0.34), -0.34, 0.1, -0.04, 0, 0, 0.5),
    P(box(0.3, 0.24, 0.16), 0, 0.16, -0.36, 0.4),
  ]));

  // Snout: a short upward-angled barrel, so the arc of the lob is implied by
  // the geometry before anything is fired.
  const snout = grp(body, 0, -0.02, 0.32);
  rig.parts.snout = snout;
  add(rig, snout, 'dark', merged('spit.snout', [
    P(cyl(0.13, 0.17, 0.36, 7), 0, 0.06, 0.14, -1.25),
    P(ring(0.14, 0.035, 4, 12), 0, 0.19, 0.28, -1.25),
  ]));
  rig.parts.muzzle = add(rig, snout, 'accent', ico(0.09, 0), 0, 0.2, 0.3);
  add(rig, body, 'eye', merged('spit.eyes', [
    P(ico(0.05, 0), 0.16, 0.06, 0.3),
    P(ico(0.05, 0), -0.16, 0.06, 0.3),
    P(ico(0.035, 0), 0, 0.14, 0.34),
  ]));

  const legR = [
    P(cyl(0.06, 0.05, 0.28, 5), 0.1, -0.14, 0, 0, 0, -0.6),
    P(cyl(0.05, 0.03, 0.3, 5), 0.24, -0.36, 0, 0, 0, 0.2),
    P(box(0.14, 0.05, 0.2), 0.22, -0.5, 0.04),
  ];
  merged('spit.legR', legR);
  merged('spit.legL', mirror(legR));
  rig.parts.leg = [];
  const spots = [[1, 0.18], [-1, 0.18], [0, -0.32]];
  for (let i = 0; i < 3; i++) {
    const [sx, z] = spots[i];
    const hip = grp(body, 0.2 * sx, -0.16, z);
    hip.rotation.y = sx === 0 ? Math.PI : 0;
    add(rig, hip, 'dark', merged(sx >= 0 ? 'spit.legR' : 'spit.legL', sx >= 0 ? legR : mirror(legR)));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animSpitling;
  return rig;
}

function animSpitling(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const fired = a.swing > 0 ? 1 - a.swing : 0;

  // Squats and swells to load, then kicks back off its own recoil.
  p.body.position.y = 0.52 - w * 0.12 + fired * 0.1 + Math.sin(a.stride * 2) * 0.04 * sp;
  p.body.position.z = -fired * 0.18;
  p.body.rotation.x = w * 0.22 - fired * 0.45;
  p.body.rotation.z = Math.sin(a.stride) * 0.1 * sp;

  p.sac.scale.setScalar(1 + w * 0.8 - fired * 0.45 + Math.sin(a.t * (3 + w * 20)) * (0.03 + w * 0.06));
  p.snout.rotation.x = -w * 0.3 + fired * 0.6 + a.pitch * 0.3;
  p.muzzle.visible = w > 0.02 || fired > 0.02;
  if (p.muzzle.visible) p.muzzle.scale.setScalar(0.4 + w * 1.4 + fired * 1.6);

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 3; i++) {
    const ph = a.stride * 1.6 + i * 2.09;
    const leg = p.leg[i];
    leg.rotation.x = Math.cos(ph) * (0.16 + 0.4 * sp) + w * 0.3;
    leg.rotation.z = -Math.max(0, -Math.sin(ph)) * 0.34 * sp;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// HARRIER — a swept delta with a beak and twin thrusters. The other flyers are
// a vertical spire (mote) and a flat parasol (shrike); this one is an arrowhead
// and it is the only flyer that reads as *pointing somewhere*.
// ---------------------------------------------------------------------------

function buildHarrier() {
  const rig = newRig('harrier');
  rig.centerY = 0;
  rig.height = 1.3;
  rig.auraR = 1.3;
  rig.shadowR = 0.8;
  rig.flyer = true;

  const body = grp(rig.pivot, 0, 0, 0);
  rig.parts.body = body;

  add(rig, body, 'body', merged('har.fuselage', [
    P(cyl(0.13, 0.3, 1.5, 6), 0, 0, 0.1, Math.PI * 0.5),
    P(box(0.34, 0.3, 0.5), 0, 0.06, -0.42),
    // Dorsal fin — the vertical the shrike and mote do not have.
    P(cone(0.16, 0.72, 4), 0, 0.42, -0.5, -0.35, 0, 0, 0.28, 1, 1),
  ]));
  add(rig, body, 'dark', merged('har.keel', [
    P(box(0.24, 0.14, 0.9), 0, -0.18, 0.02),
    P(cone(0.12, 0.4, 5), 0, -0.1, 0.78, Math.PI * 0.5),
  ]));

  // Wings on their own pivots: they sweep back on the strafing run, which is
  // the tell, and they beat slowly the rest of the time.
  rig.parts.wing = [];
  const wingR = [
    P(box(1.05, 0.07, 0.44), 0.55, 0, -0.06, 0, 0.22, 0.06),
    P(cone(0.1, 0.5, 4), 1.05, 0, -0.2, 0, 1.9, 0.1, 0.5, 1, 1),
    P(box(0.36, 0.05, 0.2), 0.72, -0.04, -0.3, 0, 0.5, 0),
  ];
  merged('har.wingR', wingR);
  merged('har.wingL', mirror(wingR));
  for (let i = 0; i < 2; i++) {
    const right = i === 0;
    const g = grp(body, 0.16 * (right ? 1 : -1), 0.06, -0.04);
    add(rig, g, 'body', merged(right ? 'har.wingR' : 'har.wingL', right ? wingR : mirror(wingR)));
    add(rig, g, 'accent', merged(right ? 'har.emitR' : 'har.emitL',
      right ? [P(box(0.5, 0.04, 0.06), 0.62, 0.05, -0.02)] : mirror([P(box(0.5, 0.04, 0.06), 0.62, 0.05, -0.02)])));
    rig.parts.wing.push(g);
  }

  // Thrusters: two hot points at the tail, which is what makes a fast flyer
  // legible when it is going *away* from you.
  add(rig, body, 'accent', merged('har.thrust', [
    P(ico(0.09, 0), 0.15, 0.04, -0.68),
    P(ico(0.09, 0), -0.15, 0.04, -0.68),
  ]));

  const head = grp(body, 0, -0.02, 0.66);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'dark', merged('har.beak', [
    P(cone(0.11, 0.44, 5), 0, 0, 0.18, Math.PI * 0.5),
    P(box(0.24, 0.1, 0.18), 0, 0.08, -0.04),
  ]));
  add(rig, head, 'eye', merged('har.eyes', [
    P(box(0.09, 0.05, 0.05), 0.1, 0.06, 0.02, 0, 0, -0.3),
    P(box(0.09, 0.05, 0.05), -0.1, 0.06, 0.02, 0, 0, 0.3),
  ]));
  rig.parts.beam = beam(rig, head, 0, 0.3);

  makeAura(rig, rig.auraR);
  rig.animate = animHarrier;
  return rig;
}

function animHarrier(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const fire = a.swing > 0 && a.beamOn ? 1 : 0;

  // Banks into its own turn and pitches nose-down onto the strafing line.
  p.body.rotation.x = a.pitch * 0.5 + a.speed * 0.22 + w * 0.2 - fire * 0.12;
  p.body.rotation.z = a.lean * 1.6 + Math.sin(a.t * 1.4) * 0.08 - a.lookY * 0.5;
  p.body.position.y = Math.sin(a.t * 2.1) * 0.08;

  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    // Beat while loitering, locked back while attacking.
    const beat = Math.sin(a.t * 3.4 + i * 0.2) * 0.22 * (1 - w);
    p.wing[i].rotation.z = s * (beat - w * 0.5 - fire * 0.6);
    p.wing[i].rotation.y = s * (w * 0.45 + fire * 0.5);
  }
  p.head.rotation.x = -a.pitch * 0.3;
  p.head.rotation.y = a.lookY * 0.45 + a.sweep * 0.5;
  setBeam(p.beam, a.beamLen, 0.05 + w * 0.05 + fire * 0.34, a.beamOn);
  common(rig, a);
}

// ---------------------------------------------------------------------------
// CHARGER — a quadruped battering ram. Massive shielded head carried LOW with
// the haunches high, so the silhouette is a wedge pointed at the player, and
// the pose already says which way it is about to go.
// ---------------------------------------------------------------------------

function buildCharger() {
  const rig = newRig('charger');
  rig.centerY = 1.0;
  rig.height = 1.6;
  rig.auraR = 1.5;
  rig.shadowR = 1.0;

  const body = grp(rig.pivot, 0, 1.0, 0);
  rig.parts.body = body;

  add(rig, body, 'body', merged('chg.torso', [
    // Haunches: the tallest point of the animal is its hips, which is the
    // opposite of every other quadruped in the roster.
    P(cyl(0.55, 0.44, 0.9, 6), 0, 0.06, -0.5, 0, Math.PI / 6, Math.PI * 0.5),
    P(cyl(0.4, 0.5, 0.85, 6), 0, -0.06, 0.35, 0, Math.PI / 6, Math.PI * 0.5),
    P(box(0.5, 0.3, 0.5), 0, 0.34, -0.62, -0.25),
    // Spine ridge — irregular, so the top line is not a straight edge.
    P(cone(0.13, 0.44, 4), 0, 0.5, -0.3, -0.2),
    P(cone(0.11, 0.36, 4), 0, 0.46, 0.02, -0.1),
    P(cone(0.09, 0.28, 4), 0, 0.4, 0.28, 0.05),
  ]));
  add(rig, body, 'dark', merged('chg.belly', [
    P(box(0.66, 0.24, 1.5), 0, -0.34, -0.06),
  ]));

  const neck = grp(body, 0, -0.1, 0.7);
  rig.parts.neck = neck;
  add(rig, neck, 'dark', merged('chg.neck', [P(cyl(0.3, 0.34, 0.44, 6), 0, -0.06, 0.18, -1.3)]));

  const head = grp(neck, 0, -0.16, 0.4);
  rig.parts.head = head;
  crumbles(rig, head);
  // The ram plate. One big angled slab plus a pair of forward horns: this is
  // the part that is going to hit you and it is modelled to look like it.
  add(rig, head, 'body', merged('chg.head', [
    P(box(0.62, 0.5, 0.44), 0, 0, 0.06),
    P(box(0.78, 0.16, 0.5), 0, 0.24, 0.14, -0.3),
    P(cone(0.14, 0.62, 5), 0.3, 0.16, 0.3, -1.35, 0, 0.25),
    P(cone(0.14, 0.62, 5), -0.3, 0.16, 0.3, -1.35, 0, -0.25),
    P(cone(0.1, 0.34, 5), 0, 0.34, 0.02, -0.6),
  ]));
  add(rig, head, 'accent', merged('chg.brand', [
    P(box(0.42, 0.06, 0.07), 0, 0.16, 0.3),
    P(box(0.06, 0.18, 0.07), 0, 0.06, 0.3),
  ]));
  add(rig, head, 'eye', merged('chg.eyes', [
    P(ico(0.055, 0), 0.24, 0.02, 0.18),
    P(ico(0.055, 0), -0.24, 0.02, 0.18),
  ]));

  const legR = [
    P(cyl(0.14, 0.11, 0.5, 5), 0, -0.25, 0),
    P(cyl(0.1, 0.09, 0.44, 5), 0, -0.68, 0.06, -0.25),
    P(box(0.24, 0.12, 0.3), 0, -0.9, 0.12),
  ];
  merged('chg.legR', legR);
  merged('chg.legL', mirror(legR));
  rig.parts.leg = [];
  const zs = [0.62, -0.6];
  for (let i = 0; i < 4; i++) {
    const right = i < 2;
    const hip = grp(body, 0.34 * (right ? 1 : -1), -0.16, zs[i % 2]);
    add(rig, hip, 'dark', merged(right ? 'chg.legR' : 'chg.legL', right ? legR : mirror(legR)));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animCharger;
  return rig;
}

const CHG_PHASE = [0, Math.PI, Math.PI, 0];

function animCharger(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const ch = a.charge;
  const hit = a.swing > 0 && !ch ? strike(a.swing) : 0;

  // Wind-up is a plant: head goes down, hindquarters go UP, and the whole
  // animal coils backward before it goes anywhere.
  p.body.position.y = 1.0 - w * 0.14 + Math.sin(a.stride * 2) * 0.06 * sp;
  p.body.position.z = -w * 0.3 + ch * 0.2;
  p.body.rotation.x = w * 0.3 + ch * 0.18 - 0.04 * sp + hit * 0.3;
  p.body.rotation.z = Math.sin(a.stride) * 0.09 * sp;

  p.neck.rotation.x = 0.1 + w * 0.55 + ch * 0.35 - hit * 0.5;
  p.neck.rotation.y = a.lookY * 0.35 * (1 - ch);
  p.head.rotation.x = -0.1 + w * 0.35 + ch * 0.25 - hit * 0.7;
  p.head.rotation.y = a.lookY * 0.3 * (1 - ch);

  if (a.lod > 0) return common(rig, a);

  // Legs cycle off `stride`, which the Enemy already drives from real speed —
  // so the gallop during a 26 m/s dash comes out of the same code as the walk.
  for (let i = 0; i < 4; i++) {
    const ph = a.stride * 1.15 + CHG_PHASE[i];
    const leg = p.leg[i];
    // Front pair paws the ground during the wind-up.
    const paw = i < 2 ? w * Math.sin(a.t * 11) * 0.45 : 0;
    leg.rotation.x = Math.cos(ph) * (0.12 + 0.7 * sp) + paw;
    leg.rotation.z = -Math.max(0, -Math.sin(ph)) * 0.3 * sp * (i < 2 ? 1 : -1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// BURROWER — a digging animal: two enormous fossorial claws carried in front
// of a segmented body that tapers to nothing. Blind, so no eyes at all — the
// sensory band is a ring of accent pits around the snout, and the absence of
// eyes is itself the identifier.
// ---------------------------------------------------------------------------

function buildBurrower() {
  const rig = newRig('burrower');
  rig.centerY = 0.7;
  rig.height = 1.4;
  rig.auraR = 1.25;
  rig.shadowR = 0.85;

  const body = grp(rig.pivot, 0, 0.66, 0);
  rig.parts.body = body;

  // Three tapering segments, front to back. The body is a wedge driven point
  // first, which is what makes it read as a thing that lives underground.
  add(rig, body, 'body', merged('bur.hull', [
    P(cyl(0.44, 0.5, 0.6, 7), 0, 0, 0.34, Math.PI * 0.5),
    P(cyl(0.36, 0.44, 0.5, 7), 0, -0.02, -0.18, Math.PI * 0.5),
    P(cyl(0.22, 0.34, 0.5, 7), 0, -0.06, -0.6, Math.PI * 0.5),
    P(cone(0.2, 0.4, 6), 0, -0.08, -0.98, -Math.PI * 0.5),
    // Segment collars, so the taper has joints instead of being a smooth cone.
    P(ring(0.46, 0.06, 4, 12), 0, 0, 0.06, Math.PI * 0.5),
    P(ring(0.36, 0.05, 4, 12), 0, -0.04, -0.42, Math.PI * 0.5),
  ]));
  add(rig, body, 'dark', merged('bur.plate', [
    P(box(0.7, 0.16, 0.9), 0, 0.3, 0.1, -0.12),
    P(box(0.5, 0.12, 0.6), 0, 0.26, -0.5, -0.05),
  ]));

  const head = grp(body, 0, -0.02, 0.6);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'dark', merged('bur.snout', [
    P(cone(0.3, 0.55, 7), 0, 0, 0.2, Math.PI * 0.5),
    P(box(0.5, 0.2, 0.24), 0, 0.12, -0.02, -0.2),
  ]));
  // Sensory pits, not eyes.
  add(rig, head, 'accent', merged('bur.pits', [
    P(ico(0.04, 0), 0.18, 0.06, 0.16),
    P(ico(0.04, 0), -0.18, 0.06, 0.16),
    P(ico(0.035, 0), 0.1, -0.1, 0.24),
    P(ico(0.035, 0), -0.1, -0.1, 0.24),
    P(ico(0.03, 0), 0, 0.16, 0.12),
  ]));

  // The claws. Comically oversized on purpose — they are two thirds of the
  // frontal silhouette and they are what the eruption animation swings.
  const clawR = [
    P(cyl(0.13, 0.1, 0.4, 5), 0, -0.16, 0.06, -0.5),
    P(box(0.34, 0.42, 0.16), 0.06, -0.46, 0.3, -0.35),
    P(cone(0.06, 0.42, 4), 0.02, -0.62, 0.52, -0.9),
    P(cone(0.06, 0.4, 4), 0.16, -0.6, 0.48, -0.9, 0, -0.2),
    P(cone(0.055, 0.36, 4), -0.08, -0.6, 0.5, -0.9, 0, 0.2),
  ];
  merged('bur.clawR', clawR);
  merged('bur.clawL', mirror(clawR));
  rig.parts.claw = [];
  for (let i = 0; i < 2; i++) {
    const right = i === 0;
    const g = grp(body, 0.42 * (right ? 1 : -1), 0.06, 0.4);
    add(rig, g, 'body', merged(right ? 'bur.clawR' : 'bur.clawL', right ? clawR : mirror(clawR)));
    crumbles(rig, g);
    rig.parts.claw.push(g);
  }

  const legR = [P(cyl(0.07, 0.05, 0.34, 5), 0.08, -0.16, 0, 0, 0, -0.9)];
  merged('bur.legR', legR);
  merged('bur.legL', mirror(legR));
  rig.parts.leg = [];
  const zs = [0.1, -0.4];
  for (let i = 0; i < 4; i++) {
    const right = i < 2;
    const hip = grp(body, 0.3 * (right ? 1 : -1), -0.3, zs[i % 2]);
    add(rig, hip, 'dark', merged(right ? 'bur.legR' : 'bur.legL', right ? legR : mirror(legR)));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animBurrower;
  return rig;
}

function animBurrower(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const hit = a.swing > 0 ? strike(a.swing) : 0;
  const digging = a.attack === 'erupt' || a.attack === 'surface';

  // Dig tell: it hunches and its claws come up over the snout. Erupt: the
  // whole body throws itself up and the claws fly apart.
  p.body.position.y = 0.66 - w * (digging ? 0.3 : 0.1) + hit * 0.5 + Math.sin(a.stride * 2) * 0.04 * sp;
  p.body.rotation.x = w * 0.45 - hit * 0.75 - 0.06 * sp;
  p.body.rotation.z = Math.sin(a.stride) * 0.08 * sp;

  p.head.rotation.x = -w * 0.3 + hit * 0.4;
  p.head.rotation.y = a.lookY * 0.4;

  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const c = p.claw[i];
    c.rotation.x = -0.2 - w * 1.2 + hit * 1.6 + Math.sin(a.stride + i * Math.PI) * 0.25 * sp;
    c.rotation.z = s * (0.2 + w * 0.5 - hit * 0.9);
    c.rotation.y = s * (w * 0.4 - hit * 0.6);
  }

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 4; i++) {
    const ph = a.stride * 1.5 + (i % 2 ? Math.PI : 0) + (i < 2 ? 0 : Math.PI * 0.5);
    p.leg[i].rotation.x = Math.cos(ph) * (0.2 + 0.5 * sp);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// BROOD SAC — a stationary egg cluster on a splayed root. It never walks, so
// the whole silhouette budget goes into being unmistakably *organic and wrong*
// against a roster of armoured animals: a bulb on a stalk with a crown that
// splits open to hatch.
// ---------------------------------------------------------------------------

function buildBrood() {
  const rig = newRig('brood');
  rig.centerY = 1.2;
  rig.height = 2.4;
  rig.auraR = 1.8;
  rig.shadowR = 1.15;

  const base = grp(rig.pivot, 0, 0, 0);
  rig.parts.base = base;
  // Roots: six splayed buttresses. They are what stop it reading as a barrel
  // sitting on the floor, and they are wide enough to sell "cannot be moved".
  const roots = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    roots.push(P(cyl(0.12, 0.06, 0.9, 5), Math.cos(ang) * 0.42, 0.24, Math.sin(ang) * 0.42, 0.75, -ang, 0));
  }
  roots.push(P(hemi(0.5, 10, 4), 0, 0.02, 0, 0, 0, 0, 1.2, 0.7, 1.2));
  add(rig, base, 'dark', merged('brd.roots', roots));

  const stalk = grp(base, 0, 0.4, 0);
  rig.parts.stalk = stalk;
  add(rig, stalk, 'dark', merged('brd.stalk', [
    P(cyl(0.3, 0.42, 0.75, 7), 0, 0.36, 0),
    P(ring(0.32, 0.06, 4, 12), 0, 0.5, 0, Math.PI * 0.5),
  ]));

  const sac = grp(stalk, 0, 0.86, 0);
  rig.parts.sac = sac;
  // The bulb: a fat ovoid with four heavy rind plates over it, so the gaps
  // between the plates are where the light gets out.
  add(rig, sac, 'body', merged('brd.rind', [
    P(sph(0.62, 12, 8), 0, 0.1, 0, 0, 0, 0, 1, 1.15, 1),
    P(box(0.34, 0.9, 0.3), 0.42, 0.12, 0, 0, 0, -0.28),
    P(box(0.34, 0.9, 0.3), -0.42, 0.12, 0, 0, 0, 0.28),
    P(box(0.3, 0.86, 0.34), 0, 0.12, 0.44, 0.28),
    P(box(0.3, 0.86, 0.34), 0, 0.12, -0.44, -0.28),
  ]));
  rig.parts.core = add(rig, sac, 'accent', ico(0.4, 1), 0, 0.1, 0);
  add(rig, sac, 'eye', merged('brd.pores', [
    P(ico(0.07, 0), 0.3, 0.5, 0.3),
    P(ico(0.06, 0), -0.34, 0.42, 0.2),
    P(ico(0.06, 0), 0.1, 0.46, -0.42),
    P(ico(0.05, 0), -0.16, 0.62, 0.14),
  ]));

  // Crown petals — they peel back to hatch, which is the whole tell.
  rig.parts.petal = [];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2;
    const g = grp(sac, Math.cos(ang) * 0.2, 0.62, Math.sin(ang) * 0.2);
    g.rotation.y = -ang;
    add(rig, g, 'body', merged('brd.petal', [
      P(box(0.3, 0.5, 0.14), 0, 0.22, 0.06, -0.2),
      P(cone(0.1, 0.32, 4), 0, 0.5, 0.1, -0.3),
    ]));
    crumbles(rig, g);
    rig.parts.petal.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animBrood;
  return rig;
}

function animBrood(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const burst = a.swing > 0 ? strike(a.swing) : 0;
  const hatching = a.attack === 'hatch';

  // A slow peristaltic breath at rest; a hard contraction on the hatch.
  const breath = Math.sin(a.t * 1.3) * 0.05;
  p.sac.scale.set(1 + breath + w * 0.2 - burst * 0.3, 1 - breath * 0.6 - w * 0.1 + burst * 0.35, 1 + breath + w * 0.2 - burst * 0.3);
  p.sac.rotation.y = a.t * 0.15;
  p.stalk.rotation.x = Math.sin(a.t * 0.8) * 0.05 + w * 0.12;
  p.stalk.rotation.z = Math.cos(a.t * 0.7) * 0.05;

  p.core.scale.setScalar(1 + w * 0.75 + burst * 0.9 + Math.sin(a.t * (2.6 + w * 18)) * (0.05 + w * 0.1));

  for (let i = 0; i < 4; i++) {
    const g = p.petal[i];
    // Petals only open for the hatch, and they open in sequence.
    const open = hatching ? Math.max(w, burst) : w * 0.3;
    g.rotation.x = -open * (1.1 + i * 0.06) - Math.sin(a.t * 1.1 + i) * 0.04;
    g.scale.setScalar(1 + open * 0.15);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// AEGIS WARDEN — a bipedal wall. The tower shield is deliberately the widest
// single plane in the whole roster and it hangs off ONE side, so the unit is
// asymmetric from every bearing: you can tell at a glance which side of it is
// safe to shoot, which is the entire mechanic.
// ---------------------------------------------------------------------------

const WAR_HIP = 1.35, WAR_L1 = 0.62, WAR_L2 = 0.6;

function buildWarden() {
  const rig = newRig('warden');
  rig.centerY = 1.4;
  rig.height = 2.5;
  rig.auraR = 1.7;
  rig.shadowR = 0.95;

  const spine = grp(rig.pivot, 0, WAR_HIP, 0);
  rig.parts.spine = spine;
  add(rig, spine, 'body', merged('war.torso', [
    P(cyl(0.5, 0.38, 0.85, 6), 0, 0.3, 0, 0, Math.PI / 6, 0, 1.1, 1, 0.8),
    P(box(1.0, 0.24, 0.5), 0, 0.7, -0.02),
    P(box(0.46, 0.3, 0.42), 0, -0.2, 0),
    P(box(0.28, 0.5, 0.24), 0.42, 0.42, -0.16, 0, 0, -0.3),
    P(box(0.28, 0.5, 0.24), -0.42, 0.42, -0.16, 0, 0, 0.3),
  ]));
  add(rig, spine, 'dark', merged('war.skirt', [
    P(cyl(0.44, 0.56, 0.44, 7), 0, -0.42, 0),
    P(box(0.7, 0.1, 0.16), 0, -0.6, 0.3, -0.3),
  ]));
  add(rig, spine, 'accent', merged('war.sigil', [
    P(box(0.1, 0.34, 0.06), 0, 0.3, 0.3),
    P(box(0.3, 0.08, 0.06), 0, 0.36, 0.3),
  ]));

  const head = grp(spine, 0, 0.86, 0.04);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'body', merged('war.helm', [
    P(cyl(0.24, 0.3, 0.38, 6), 0, 0.02, 0, 0, Math.PI / 6, 0),
    P(box(0.44, 0.12, 0.34), 0, 0.16, 0.04, -0.2),
    P(cone(0.08, 0.34, 4), 0, 0.34, -0.02, -0.15),
  ]));
  // A visor slit, not eyes. It is the only warm thing above the shield line.
  add(rig, head, 'eye', merged('war.visor', [P(box(0.3, 0.045, 0.05), 0, 0.0, 0.24)]));

  // THE SHIELD. Slab, boss, and a rim that overhangs the arm on all four sides.
  const shieldArm = grp(spine, 0.62, 0.44, 0.1);
  rig.parts.shield = shieldArm;
  add(rig, shieldArm, 'dark', merged('war.shieldArm', [P(cyl(0.14, 0.12, 0.6, 5), 0, -0.28, 0)]));
  add(rig, shieldArm, 'body', merged('war.shield', [
    P(box(0.16, 1.9, 1.15), 0.28, -0.35, 0.12),
    P(box(0.1, 2.05, 0.24), 0.34, -0.35, 0.12),
    P(box(0.1, 0.3, 1.25), 0.34, 0.5, 0.12),
    P(box(0.1, 0.3, 1.25), 0.34, -1.2, 0.12),
    P(ico(0.24, 0), 0.4, -0.3, 0.14, 0, 0, 0, 0.6, 1, 1),
  ]));
  add(rig, shieldArm, 'accent', merged('war.shieldGlow', [
    P(box(0.05, 1.2, 0.07), 0.42, -0.32, 0.12),
    P(box(0.05, 0.08, 0.8), 0.42, -0.32, 0.12),
  ]));
  crumbles(rig, shieldArm);

  // Mace arm — short, heavy, and on the opposite side so the two halves of the
  // body never read as a mirror.
  const maceArm = grp(spine, -0.6, 0.5, 0);
  rig.parts.mace = maceArm;
  add(rig, maceArm, 'dark', merged('war.maceArm', [
    P(cyl(0.15, 0.12, 0.62, 5), 0, -0.3, 0),
    P(cyl(0.12, 0.1, 0.5, 5), 0, -0.82, 0.06, -0.3),
  ]));
  add(rig, maceArm, 'body', merged('war.maceHead', [
    P(ico(0.28, 0), 0, -1.14, 0.1),
    P(cone(0.08, 0.24, 4), 0, -1.14, 0.36, Math.PI * 0.5),
    P(cone(0.08, 0.24, 4), 0.24, -1.14, 0.1, 0, 0, -Math.PI * 0.5),
    P(cone(0.08, 0.24, 4), -0.24, -1.14, 0.1, 0, 0, Math.PI * 0.5),
  ]));
  crumbles(rig, maceArm);

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.26 * s, -0.5, 0);
    add(rig, hip, 'dark', merged('war.thigh', [P(cyl(0.19, 0.15, WAR_L1, 6), 0, -WAR_L1 * 0.5, 0)]));
    const knee = grp(hip, 0, -WAR_L1, 0);
    add(rig, knee, 'dark', merged('war.shin', [
      P(cyl(0.15, 0.2, WAR_L2, 6), 0, -WAR_L2 * 0.5, 0),
      P(box(0.32, 0.16, 0.5), 0, -WAR_L2 - 0.02, 0.1),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animWarden;
  return rig;
}

function animWarden(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const hit = a.swing > 0 ? strike(a.swing) : 0;
  const quake = a.attack === 'quake' ? 1 : 0;

  p.spine.position.y = WAR_HIP + Math.sin(a.stride * 2) * 0.05 * sp - w * (0.1 + quake * 0.2);
  p.spine.rotation.x = -w * (0.12 + quake * 0.25) + hit * (0.3 + quake * 0.3);
  p.spine.rotation.z = Math.sin(a.stride) * 0.08 * sp;
  // Turns its shielded shoulder toward the player as it walks — the pose that
  // teaches the player to go around.
  p.spine.rotation.y = 0.32 + a.lookY * 0.15 - hit * 0.5;

  p.head.rotation.y = a.lookY * 0.5 - 0.2;
  p.head.rotation.x = a.pitch * 0.5;

  // Shield stays planted and rises into a brace on the wind-up; on a quake it
  // is what comes down.
  p.shield.rotation.x = -0.1 - w * (quake ? 1.3 : 0.35) + hit * (quake ? 1.8 : 0.4);
  p.shield.rotation.z = -0.12 - w * 0.2;
  p.mace.rotation.x = -0.2 - w * (quake ? 0.4 : 1.5) + hit * (quake ? 0.6 : 2.2)
    + Math.sin(a.stride + Math.PI) * 0.25 * sp;
  p.mace.rotation.z = -0.12 - w * 0.3;

  if (a.lod > 0) return common(rig, a);

  const stride = 0.3 * sp + 0.04;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    solveLeg(p.hip[i], p.knee[i], WAR_L1, WAR_L2,
      stepZ(ph, stride) * sp, -(WAR_HIP - 0.5) + stepY(ph, 0.22) * sp, 1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// RIFT STALKER — tall, thin and wrong. Elongated blade arms that hang below
// the knees and a halo of rift shards that collapses into the body when it
// blinks. The only humanoid in the roster with no mass at all: the silhouette
// is four lines and a cluster of floating chips.
// ---------------------------------------------------------------------------

const STK_HIP = 1.25, STK_L1 = 0.58, STK_L2 = 0.62;

function buildStalker() {
  const rig = newRig('stalker');
  rig.centerY = 1.2;
  rig.height = 1.9;
  rig.auraR = 1.4;
  rig.shadowR = 0.62;

  const spine = grp(rig.pivot, 0, STK_HIP, 0);
  rig.parts.spine = spine;
  add(rig, spine, 'body', merged('stk.torso', [
    P(cyl(0.2, 0.13, 0.7, 5), 0, 0.28, 0),
    P(box(0.56, 0.14, 0.2), 0, 0.56, -0.02),
    P(box(0.2, 0.3, 0.18), 0, -0.1, 0.02),
    // Blade fins off the spine, swept back — the only wide feature it has.
    P(cone(0.1, 0.6, 3), 0.18, 0.42, -0.2, -0.9, 0, 0.3, 0.4, 1, 1),
    P(cone(0.1, 0.6, 3), -0.18, 0.42, -0.2, -0.9, 0, -0.3, 0.4, 1, 1),
  ]));
  add(rig, spine, 'accent', merged('stk.spineGlow', [
    P(box(0.05, 0.55, 0.05), 0, 0.3, -0.11),
  ]));

  const head = grp(spine, 0, 0.68, 0.02);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'dark', merged('stk.head', [
    P(cone(0.15, 0.44, 5), 0, 0.06, 0.02, 0.25),
    P(box(0.22, 0.1, 0.24), 0, -0.02, 0.06),
  ]));
  add(rig, head, 'eye', merged('stk.eyes', [
    P(box(0.04, 0.13, 0.05), 0.07, 0.0, 0.13, 0, 0, 0.22),
    P(box(0.04, 0.13, 0.05), -0.07, 0.0, 0.13, 0, 0, -0.22),
  ]));

  // Blade arms: upper, forearm, and a blade longer than the forearm.
  const armR = [P(cyl(0.08, 0.06, 0.55, 5), 0, -0.28, 0)];
  const bladeR = [
    P(cyl(0.06, 0.045, 0.5, 5), 0, -0.25, 0),
    P(box(0.07, 0.9, 0.2), 0.01, -0.9, 0.06, 0.12),
    P(cone(0.06, 0.34, 3), 0.01, -1.42, 0.1, Math.PI),
  ];
  merged('stk.armR', armR); merged('stk.armL', mirror(armR));
  merged('stk.bladeR', bladeR); merged('stk.bladeL', mirror(bladeR));
  rig.parts.arm = [];
  rig.parts.blade = [];
  for (let i = 0; i < 2; i++) {
    const right = i === 0;
    const s = right ? 1 : -1;
    const sh = grp(spine, 0.28 * s, 0.5, 0);
    add(rig, sh, 'dark', merged(right ? 'stk.armR' : 'stk.armL', right ? armR : mirror(armR)));
    const el = grp(sh, 0, -0.55, 0);
    add(rig, el, 'body', merged(right ? 'stk.bladeR' : 'stk.bladeL', right ? bladeR : mirror(bladeR)));
    add(rig, el, 'accent', merged(right ? 'stk.edgeR' : 'stk.edgeL',
      right ? [P(box(0.03, 0.8, 0.05), 0.04, -0.9, 0.14)] : mirror([P(box(0.03, 0.8, 0.05), 0.04, -0.9, 0.14)])));
    crumbles(rig, el);
    rig.parts.arm.push(sh);
    rig.parts.blade.push(el);
  }

  // Rift halo: five shards behind the shoulders. They spin up before a blink
  // and snap inward when it goes, which is the read the player is given.
  const halo = grp(spine, 0, 0.5, -0.3);
  rig.parts.halo = halo;
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const m = new THREE.Mesh(merged('stk.shard', [P(cone(0.08, 0.4, 3), 0, 0, 0)]), rig.mats.accent);
    m.position.set(Math.cos(ang) * 0.5, Math.sin(ang) * 0.5, 0);
    m.rotation.z = -ang;
    rig.accent.push(m);
    halo.add(m);
  }

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.16 * s, -0.36, 0);
    add(rig, hip, 'dark', merged('stk.thigh', [P(cyl(0.1, 0.075, STK_L1, 5), 0, -STK_L1 * 0.5, 0)]));
    const knee = grp(hip, 0, -STK_L1, 0);
    add(rig, knee, 'dark', merged('stk.shin', [
      P(cyl(0.07, 0.05, STK_L2, 5), 0, -STK_L2 * 0.5, 0),
      P(cone(0.06, 0.3, 4), 0, -STK_L2 - 0.06, 0.08, Math.PI * 0.6),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animStalker;
  return rig;
}

function animStalker(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const ch = a.charge;
  const hit = a.swing > 0 && !ch ? strike(a.swing) : 0;

  p.spine.position.y = STK_HIP + Math.sin(a.stride * 2) * 0.05 * sp - w * 0.16 + ch * 0.1;
  p.spine.rotation.x = -0.08 - w * 0.3 + ch * 0.5 + hit * 0.45;
  p.spine.rotation.z = Math.sin(a.stride) * 0.06 * sp + a.lean * 0.4;
  p.spine.rotation.y = a.lookY * 0.2;

  p.head.rotation.y = a.lookY * 0.55;
  p.head.rotation.x = a.pitch * 0.5 - w * 0.2;

  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    // Arms cross over the chest to load a blink, then throw wide on arrival.
    p.arm[i].rotation.x = -0.2 - w * 1.5 + hit * 1.8 + ch * 0.6 + Math.sin(a.stride + i * Math.PI) * 0.3 * sp;
    p.arm[i].rotation.z = s * (0.18 + w * 0.9 - hit * 0.8 - ch * 0.4);
    p.blade[i].rotation.x = -0.15 - w * 0.6 + hit * 1.1;
    p.blade[i].rotation.z = s * (w * 0.5 - hit * 0.5);
  }

  // The halo: spins up on the wind-up, collapses to a point during the blink.
  const collapse = ch;
  p.halo.rotation.z = a.t * (0.8 + w * 9 + ch * 20);
  p.halo.scale.setScalar(Math.max(0.05, 1 + w * 0.35 - collapse * 0.95));
  for (let i = 0; i < p.halo.children.length; i++) {
    p.halo.children[i].scale.setScalar(0.7 + Math.sin(a.t * 5 + i * 1.3) * 0.25 + w * 0.5);
  }

  if (a.lod > 0) return common(rig, a);

  const stride = 0.36 * sp + 0.05;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    solveLeg(p.hip[i], p.knee[i], STK_L1, STK_L2,
      stepZ(ph, stride) * sp, -(STK_HIP - 0.36) + stepY(ph, 0.3) * sp, -1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// GRAVE ACOLYTE — a hooded cone with no legs at all. Its whole read is
// "different species, do not treat this like the others": a smooth robe
// silhouette in a roster of limbs and plates, with a halo of glyph plates that
// only lights when it is actually channelling.
// ---------------------------------------------------------------------------

function buildAcolyte() {
  const rig = newRig('acolyte');
  rig.centerY = 1.1;
  rig.height = 2.0;
  rig.auraR = 1.5;
  rig.shadowR = 0.7;

  const robe = grp(rig.pivot, 0, 0, 0);
  rig.parts.robe = robe;
  // Cone skirt with panel breaks, so the silhouette has a hem rather than
  // being a smooth party hat.
  add(rig, robe, 'dark', merged('aco.robe', [
    P(cone(0.62, 1.5, 8), 0, 0.72, 0),
    P(cone(0.66, 0.36, 8), 0, 0.2, 0),
    P(box(0.14, 1.3, 0.14), 0.42, 0.62, 0.3, 0, 0, -0.16),
    P(box(0.14, 1.3, 0.14), -0.42, 0.62, 0.3, 0, 0, 0.16),
    P(box(0.14, 1.2, 0.14), 0, 0.6, -0.48),
  ]));
  add(rig, robe, 'body', merged('aco.mantle', [
    P(cyl(0.4, 0.5, 0.34, 7), 0, 1.42, 0),
    P(box(0.9, 0.16, 0.44), 0, 1.5, -0.06, 0.2),
    P(box(0.24, 0.5, 0.2), 0.4, 1.3, 0.1, 0, 0, -0.4),
    P(box(0.24, 0.5, 0.2), -0.4, 1.3, 0.1, 0, 0, 0.4),
  ]));

  const hood = grp(robe, 0, 1.6, 0);
  rig.parts.hood = hood;
  crumbles(rig, hood);
  add(rig, hood, 'body', merged('aco.hood', [
    P(cone(0.3, 0.62, 6), 0, 0.16, -0.04, 0.12),
    P(box(0.42, 0.3, 0.2), 0, 0.02, 0.16, -0.2),
  ]));
  // A void under the hood with two lights in it — no face, which is a much
  // stronger read at range than any amount of modelled face would be.
  add(rig, hood, 'eye', merged('aco.eyes', [
    P(ico(0.05, 0), 0.08, 0.0, 0.2),
    P(ico(0.05, 0), -0.08, 0.0, 0.2),
  ]));

  // Channel focus: a ring held in front of the chest that opens into a glyph
  // wheel while mending.
  const focus = grp(robe, 0, 1.18, 0.42);
  rig.parts.focus = focus;
  add(rig, focus, 'accent', merged('aco.ring', [P(ring(0.26, 0.05, 4, 16), 0, 0, 0)]));
  rig.parts.glyph = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const m = new THREE.Mesh(merged('aco.glyph', [P(box(0.12, 0.12, 0.03), 0, 0, 0)]), rig.mats.accent);
    m.position.set(Math.cos(ang) * 0.4, Math.sin(ang) * 0.4, 0);
    m.rotation.z = -ang;
    m.visible = false;
    rig.accent.push(m);
    focus.add(m);
    rig.parts.glyph.push(m);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animAcolyte;
  return rig;
}

function animAcolyte(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const chan = a.swing > 0 ? 1 - Math.abs(a.swing - 0.5) * 2 : 0;

  // Glides rather than walks: the robe sways off the movement and the whole
  // body rides a slow hover bob.
  p.robe.position.y = Math.sin(a.t * 1.4) * 0.06 + w * 0.14;
  p.robe.rotation.x = -a.speed * 0.12 - w * 0.1;
  p.robe.rotation.z = Math.sin(a.t * 1.1) * 0.05 + a.lean * 0.5;
  p.robe.rotation.y = Math.sin(a.t * 0.6) * 0.1 + a.lookY * 0.25;

  p.hood.rotation.x = 0.06 + a.pitch * 0.4 - w * 0.25;
  p.hood.rotation.y = a.lookY * 0.4;

  const open = Math.max(w, chan);
  p.focus.rotation.z = a.t * (0.6 + open * 5);
  p.focus.scale.setScalar(0.7 + open * 0.9);
  p.focus.position.y = 1.18 + Math.sin(a.t * 2.2) * 0.04 + open * 0.2;
  for (let i = 0; i < p.glyph.length; i++) {
    const g = p.glyph[i];
    g.visible = open > 0.05;
    if (!g.visible) continue;
    g.scale.setScalar(0.4 + open * 1.0 + Math.sin(a.t * 7 + i) * 0.12);
  }
  // No legs to solve — the acolyte is the one rig with no per-frame IK at all,
  // which is also why it is cheap enough to be a common tier-2 card.
  common(rig, a);
}

// ---------------------------------------------------------------------------
// SIEGE BOMBARD — a squat quadruped carrying a mortar tube taller than it is.
// The barrel ELEVATES through the wind-up, so from any angle you can see the
// gun coming up before the shell exists.
// ---------------------------------------------------------------------------

function buildMortar() {
  const rig = newRig('mortar');
  rig.centerY = 1.4;
  rig.height = 2.8;
  rig.auraR = 2.0;
  rig.shadowR = 1.15;

  const body = grp(rig.pivot, 0, 1.15, 0);
  rig.parts.body = body;
  add(rig, body, 'body', merged('mor.hull', [
    P(cyl(0.72, 0.62, 1.3, 6), 0, 0, 0, 0, Math.PI / 6, Math.PI * 0.5, 1, 1, 0.85),
    P(box(1.3, 0.3, 0.9), 0, 0.44, -0.1),
    P(box(0.4, 0.5, 0.5), 0.62, 0.2, -0.2, 0, 0, -0.3),
    P(box(0.4, 0.5, 0.5), -0.62, 0.2, -0.2, 0, 0, 0.3),
  ]));
  add(rig, body, 'dark', merged('mor.belly', [
    P(box(1.0, 0.3, 1.4), 0, -0.44, 0),
    P(ring(0.66, 0.08, 4, 12), 0, 0.04, 0.5, Math.PI * 0.5),
  ]));

  // The tube, on a trunnion. Long, banded, and it dominates the silhouette.
  const trunnion = grp(body, 0, 0.5, -0.1);
  rig.parts.trunnion = trunnion;
  add(rig, trunnion, 'dark', merged('mor.tube', [
    P(cyl(0.26, 0.34, 1.7, 8), 0, 0.85, 0),
    P(ring(0.3, 0.06, 4, 12), 0, 0.5, 0, Math.PI * 0.5),
    P(ring(0.28, 0.06, 4, 12), 0, 1.1, 0, Math.PI * 0.5),
    P(cyl(0.4, 0.34, 0.22, 8), 0, 0.08, 0),
  ]));
  rig.parts.muzzle = add(rig, trunnion, 'accent', ico(0.2, 1), 0, 1.7, 0);
  add(rig, trunnion, 'accent', merged('mor.heat', [
    P(box(0.06, 0.7, 0.07), 0.26, 0.8, 0),
    P(box(0.06, 0.7, 0.07), -0.26, 0.8, 0),
  ]));

  const head = grp(body, 0, -0.06, 0.72);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'dark', merged('mor.head', [
    P(box(0.56, 0.4, 0.44), 0, 0, 0.06),
    P(box(0.7, 0.12, 0.3), 0, 0.2, 0.1, -0.25),
    P(cone(0.09, 0.3, 4), 0.26, 0.24, 0.02, -0.7),
    P(cone(0.09, 0.3, 4), -0.26, 0.24, 0.02, -0.7),
  ]));
  add(rig, head, 'eye', merged('mor.eyes', [
    P(box(0.1, 0.05, 0.05), 0.16, 0.02, 0.26, 0, 0, -0.25),
    P(box(0.1, 0.05, 0.05), -0.16, 0.02, 0.26, 0, 0, 0.25),
  ]));

  const legR = [
    P(cyl(0.16, 0.13, 0.5, 5), 0.06, -0.24, 0, 0, 0, -0.4),
    P(cyl(0.12, 0.1, 0.44, 5), 0.22, -0.66, 0, 0, 0, 0.25),
    P(box(0.34, 0.14, 0.42), 0.16, -0.88, 0.04),
  ];
  merged('mor.legR', legR);
  merged('mor.legL', mirror(legR));
  rig.parts.leg = [];
  const zs = [0.5, -0.5];
  for (let i = 0; i < 4; i++) {
    const right = i < 2;
    const hip = grp(body, 0.6 * (right ? 1 : -1), -0.3, zs[i % 2]);
    add(rig, hip, 'dark', merged(right ? 'mor.legR' : 'mor.legL', right ? legR : mirror(legR)));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animMortar;
  return rig;
}

function animMortar(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const fired = a.swing > 0 ? 1 - a.swing : 0;

  // Braces down on its legs to fire; the recoil rocks the whole chassis back.
  p.body.position.y = 1.15 - w * 0.16 + Math.sin(a.stride * 2) * 0.05 * sp + fired * 0.1;
  p.body.rotation.x = w * 0.1 - fired * 0.3;
  p.body.rotation.z = Math.sin(a.stride) * 0.07 * sp;

  // Elevation is the tell: the tube swings from stowed to near-vertical.
  p.trunnion.rotation.x = 0.55 - w * 0.62 + fired * 0.2;
  p.trunnion.rotation.z = Math.sin(a.t * 0.7) * 0.03;
  p.muzzle.visible = w > 0.02 || fired > 0.02;
  if (p.muzzle.visible) p.muzzle.scale.setScalar(0.3 + w * 1.1 + fired * 2.2);

  p.head.rotation.y = a.lookY * 0.5;
  p.head.rotation.x = a.pitch * 0.4 + w * 0.2;

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 4; i++) {
    const ph = a.stride + (i % 2 ? Math.PI : 0) + (i < 2 ? 0 : Math.PI * 0.5);
    p.leg[i].rotation.x = Math.cos(ph) * (0.12 + 0.35 * sp) + w * 0.25;
    p.leg[i].rotation.z = (i < 2 ? 1 : -1) * w * 0.12;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// SLAG HULK — a hunched, asymmetric brute: one enormous molten forelimb it
// walks on and one small one, with a vent stack down its back. Deliberately
// lopsided, so it never reads as "a bigger sentinel".
// ---------------------------------------------------------------------------

const HLK_HIP = 2.15, HLK_L1 = 0.95, HLK_L2 = 0.95;

function buildHulk() {
  const rig = newRig('hulk');
  rig.centerY = 2.1;
  rig.height = 4.2;
  rig.auraR = 2.7;
  rig.shadowR = 1.55;

  const spine = grp(rig.pivot, 0, HLK_HIP, 0);
  rig.parts.spine = spine;
  add(rig, spine, 'body', merged('hlk.torso', [
    // Hunched: the shoulder mass sits FORWARD of the hips and above them.
    P(cyl(1.05, 0.85, 1.25, 6), 0, 0.55, 0.25, 0.25, Math.PI / 6, 0, 1.1, 1, 0.9),
    P(cyl(0.8, 0.95, 0.8, 6), 0, -0.35, -0.05, 0, Math.PI / 6, 0),
    P(box(1.9, 0.5, 1.0), 0, 1.05, 0.2, 0.15),
    // Vent stack — six chimneys of different heights down the spine.
    P(cyl(0.16, 0.2, 0.62, 5), 0.42, 1.35, -0.45),
    P(cyl(0.14, 0.18, 0.5, 5), -0.3, 1.3, -0.5),
    P(cyl(0.12, 0.16, 0.72, 5), 0.08, 1.42, -0.62),
    P(cyl(0.11, 0.15, 0.42, 5), -0.62, 1.2, -0.4),
  ]));
  add(rig, spine, 'dark', merged('hlk.hide', [
    P(box(1.5, 0.36, 0.4), 0, 0.1, 0.85, -0.2),
    P(box(1.2, 0.3, 0.3), 0, -0.6, 0.6),
  ]));
  // Molten seams. The hulk's heat is on its BACK and its big arm, not its
  // chest, so it stays identifiable while it is walking away from you.
  rig.parts.core = add(rig, spine, 'accent', ico(0.42, 1), 0, 0.15, 0.72);
  add(rig, spine, 'accent', merged('hlk.vents', [
    P(ico(0.13, 0), 0.42, 1.66, -0.45),
    P(ico(0.11, 0), -0.3, 1.55, -0.5),
    P(ico(0.1, 0), 0.08, 1.78, -0.62),
    P(box(0.1, 0.9, 0.1), 0.7, 0.5, 0.3, 0, 0, -0.3),
    P(box(0.1, 0.7, 0.1), -0.7, 0.4, 0.3, 0, 0, 0.3),
  ]));

  const head = grp(spine, 0, 1.15, 0.62);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'body', merged('hlk.head', [
    P(cyl(0.34, 0.44, 0.5, 6), 0, 0, 0, 0.3, Math.PI / 6, 0),
    P(box(0.85, 0.22, 0.55), 0, 0.2, 0.08, -0.3),
    P(cone(0.13, 0.5, 4), 0.32, 0.3, -0.1, -0.4, 0, 0.3),
    P(cone(0.13, 0.5, 4), -0.32, 0.3, -0.1, -0.4, 0, -0.3),
  ]));
  add(rig, head, 'accent', merged('hlk.maw', [
    P(box(0.5, 0.1, 0.12), 0, -0.2, 0.3),
    P(box(0.1, 0.16, 0.12), 0.16, -0.26, 0.28),
    P(box(0.1, 0.16, 0.12), -0.16, -0.26, 0.28),
  ]));
  add(rig, head, 'eye', merged('hlk.eyes', [
    P(ico(0.09, 0), 0.19, 0.02, 0.24),
    P(ico(0.09, 0), -0.19, 0.02, 0.24),
    P(ico(0.06, 0), 0, 0.1, 0.28),
  ]));

  // The big arm — thick enough to knuckle-walk on, and it is where the spray
  // comes from, so the muzzle is part of the hand.
  const bigSh = grp(spine, 1.15, 0.85, 0.2);
  rig.parts.bigArm = bigSh;
  add(rig, bigSh, 'body', merged('hlk.bigUpper', [
    P(cyl(0.42, 0.36, 1.0, 6), 0, -0.5, 0),
    P(ico(0.5, 0), 0, 0.06, 0, 0.2, 0.5, 0),
  ]));
  const bigEl = grp(bigSh, 0, -1.0, 0);
  rig.parts.bigElbow = bigEl;
  add(rig, bigEl, 'body', merged('hlk.bigFore', [
    P(cyl(0.36, 0.52, 0.95, 6), 0, -0.46, 0),
    P(box(0.95, 0.7, 0.9), 0, -1.15, 0.06),
    P(cone(0.2, 0.5, 4), 0.3, -1.45, 0.3, -0.6),
    P(cone(0.2, 0.5, 4), -0.3, -1.45, 0.3, -0.6),
  ]));
  add(rig, bigEl, 'accent', merged('hlk.bigVent', [
    P(box(0.7, 0.1, 0.12), 0, -0.9, 0.42),
    P(ico(0.18, 0), 0, -1.2, 0.44),
  ]));
  crumbles(rig, bigEl);

  // Small arm — half the length, tucked. The asymmetry is the point.
  const smSh = grp(spine, -0.95, 0.9, 0.3);
  rig.parts.smallArm = smSh;
  add(rig, smSh, 'dark', merged('hlk.smallArm', [
    P(cyl(0.2, 0.15, 0.6, 5), 0, -0.3, 0),
    P(cyl(0.15, 0.13, 0.5, 5), 0, -0.78, 0.14, -0.5),
    P(box(0.3, 0.26, 0.34), 0, -1.02, 0.32),
  ]));
  crumbles(rig, smSh);

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.6 * s, -0.85, -0.1);
    add(rig, hip, 'dark', merged('hlk.thigh', [P(cyl(0.44, 0.36, HLK_L1, 6), 0, -HLK_L1 * 0.5, 0)]));
    const knee = grp(hip, 0, -HLK_L1, 0);
    add(rig, knee, 'dark', merged('hlk.shin', [
      P(cyl(0.34, 0.44, HLK_L2, 6), 0, -HLK_L2 * 0.5, 0),
      P(box(0.8, 0.3, 1.1), 0, -HLK_L2 + 0.06, 0.2),
      P(cone(0.1, 0.3, 4), 0.22, -HLK_L2 + 0.02, 0.72, Math.PI * 0.5),
      P(cone(0.1, 0.3, 4), -0.22, -HLK_L2 + 0.02, 0.72, Math.PI * 0.5),
    ]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animHulk;
  return rig;
}

function animHulk(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const rel = a.swing > 0 ? strike(a.swing) : 0;
  const crush = a.attack === 'crush' ? 1 : 0;
  const spray = a.attack === 'spray' ? 1 : 0;
  const vent = a.attack === 'vent' ? 1 : 0;

  p.spine.position.y = HLK_HIP - w * (crush * 0.4 + vent * 0.25) - rel * crush * 0.6
    + Math.sin(a.stride * 2) * 0.1 * sp;
  p.spine.rotation.x = 0.12 - w * (crush * 0.3 + spray * 0.15) + rel * (crush * 0.5 + vent * 0.3);
  p.spine.rotation.z = Math.sin(a.stride) * 0.13 * sp;
  p.spine.rotation.y = Math.sin(a.stride) * 0.07 * sp - w * spray * 0.25;

  p.core.scale.setScalar(1 + w * 0.5 + rel * 0.7 + Math.sin(a.t * 2.8) * 0.06);
  p.head.rotation.y = a.lookY * 0.6;
  p.head.rotation.x = a.pitch * 0.5 - w * 0.15 + rel * crush * 0.4;

  // Big arm: overhead for the crush, levelled and pointed for the spray.
  if (crush) {
    p.bigArm.rotation.x = -w * 2.4 + rel * 3.0;
    p.bigArm.rotation.z = 0.15 + w * 0.3 - rel * 0.25;
    p.bigElbow.rotation.x = -w * 0.8 + rel * 0.6;
  } else if (spray) {
    p.bigArm.rotation.x = -1.05 - w * 0.35;
    p.bigArm.rotation.z = 0.5 + w * 0.2;
    p.bigElbow.rotation.x = 0.5 + w * 0.3 - rel * 0.5;
  } else {
    // Knuckle-walks on it: the big arm swings low and plants.
    p.bigArm.rotation.x = Math.sin(a.stride) * 0.4 * sp - 0.1;
    p.bigArm.rotation.z = 0.2;
    p.bigElbow.rotation.x = -0.15 - Math.abs(Math.sin(a.stride)) * 0.2 * sp;
  }
  p.smallArm.rotation.x = -0.5 - w * 0.6 + rel * 0.5 + Math.sin(a.stride + Math.PI) * 0.3 * sp;
  p.smallArm.rotation.z = -0.3 - w * 0.2;

  if (a.lod > 0) return common(rig, a);

  const stride = 0.5 * sp + 0.05;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    solveLeg(p.hip[i], p.knee[i], HLK_L1, HLK_L2,
      stepZ(ph, stride) * sp, -(HLK_HIP - 0.85) + stepY(ph, 0.34) * sp, 1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// OSSUARY WYRM — a boss that is a CURVE. Seven tapering segments arching out
// of the ground into a splayed four-part jaw, with the tail end never leaving
// the dirt. Nothing else in the game is a line rather than a mass, which is
// what makes it identifiable at boss distance from any bearing.
// ---------------------------------------------------------------------------

const WYRM_SEGS = 7;

function buildWyrm() {
  const rig = newRig('wyrm');
  rig.centerY = 2.6;
  rig.height = 5.4;
  rig.auraR = 3.4;
  rig.shadowR = 2.1;

  // Spoil ring: the ground it came up through, so the body has something to
  // emerge FROM instead of ending in mid-air at the terrain line.
  add(rig, rig.pivot, 'dark', merged('wym.spoil', [
    P(cyl(2.3, 2.9, 0.5, 9), 0, 0.1, 0),
    P(ico(0.7, 0), 1.9, 0.3, 0.8, 0.3, 0.4, 0.2),
    P(ico(0.6, 0), -1.6, 0.25, -1.4, 0.1, 1.2, 0.4),
    P(ico(0.5, 0), 0.4, 0.28, -2.2, 0.5, 0.2, 0),
    P(ico(0.55, 0), -2.1, 0.22, 0.9, 0.2, 0.8, 0.3),
  ]));

  // The chain. Each segment is a ribbed barrel that is both narrower and
  // shorter than the one below it, and each is pre-rotated so the REST pose is
  // already an arch — the animator only adds the undulation.
  let node = grp(rig.pivot, 0, 0.35, 0);
  rig.parts.seg = [];
  for (let i = 0; i < WYRM_SEGS; i++) {
    const t = i / (WYRM_SEGS - 1);
    const r = lerp(1.35, 0.62, t);
    const len = lerp(0.95, 0.62, t);
    const key = `wym.seg${i}`;
    add(rig, node, 'body', merged(key, [
      P(cyl(r * 0.88, r, len, 8), 0, len * 0.5, 0),
      // Rib collar between segments, so the body reads as vertebrae.
      P(ring(r * 0.95, r * 0.16, 4, 12), 0, len * 0.92, 0, Math.PI * 0.5),
      // Dorsal blades, alternating side to side down the spine.
      P(cone(r * 0.3, r * 1.15, 4), 0, len * 0.55, -r * 0.8,
        -0.5, i % 2 ? 0.4 : -0.4, 0, 0.35, 1, 1),
    ]));
    if (i % 2 === 0) {
      add(rig, node, 'accent', merged(`wym.vein${i}`, [
        P(box(r * 0.2, len * 0.7, r * 0.12), r * 0.72, len * 0.5, 0, 0, 0, -0.2),
        P(box(r * 0.2, len * 0.7, r * 0.12), -r * 0.72, len * 0.5, 0, 0, 0, 0.2),
      ]));
    }
    const next = grp(node, 0, len * 0.98, 0);
    // Pre-bend: the arch. Front-loaded so the base leaves the ground steeply
    // and the head ends up levelled at the player rather than pointing at the
    // sky.
    next.rotation.x = lerp(0.30, 0.14, t);
    crumbles(rig, node);
    rig.parts.seg.push(node);
    node = next;
  }

  // Head: a splayed four-part jaw around a lit gullet. No eyes — it is blind
  // like the burrower, and the family resemblance is deliberate.
  const head = node;
  rig.parts.head = head;
  add(rig, head, 'body', merged('wym.skull', [
    P(cyl(0.66, 0.58, 0.7, 8), 0, 0.3, 0),
    P(ring(0.7, 0.14, 4, 14), 0, 0.1, 0, Math.PI * 0.5),
    P(ico(0.45, 0), 0, 0.66, -0.28, 0.4, 0, 0),
  ]));
  rig.parts.gullet = add(rig, head, 'accent', ico(0.42, 1), 0, 0.5, 0);

  rig.parts.jaw = [];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const g = grp(head, Math.cos(ang) * 0.5, 0.62, Math.sin(ang) * 0.5);
    g.rotation.y = -ang;
    add(rig, g, 'dark', merged('wym.jaw', [
      P(box(0.42, 0.95, 0.3), 0, 0.42, 0.04, 0.1),
      P(cone(0.16, 0.7, 4), 0, 0.95, 0.06, 0.14),
      // Inward-facing tooth row.
      P(cone(0.07, 0.26, 3), 0.1, 0.5, -0.16, -1.4),
      P(cone(0.07, 0.26, 3), -0.1, 0.72, -0.16, -1.4),
      P(cone(0.06, 0.22, 3), 0.02, 0.28, -0.16, -1.4),
    ]));
    crumbles(rig, g);
    rig.parts.jaw.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animWyrm;
  return rig;
}

function animWyrm(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const rel = a.swing > 0 ? strike(a.swing) : 0;
  const rage = a.phase > 1 ? 1 : 0;

  // The body is one travelling wave. Rearing back on the wind-up steepens the
  // whole arch; the strike straightens it into a lunge.
  for (let i = 0; i < p.seg.length; i++) {
    const seg = p.seg[i];
    const t = i / (p.seg.length - 1);
    const wave = Math.sin(a.t * (1.5 + rage * 0.6) - i * 0.7) * (0.05 + 0.04 * t);
    seg.rotation.z = wave + Math.sin(a.t * 0.8 - i * 0.4) * 0.03;
    seg.rotation.x = (i === 0 ? 0 : 0) + wave * 0.3 - w * 0.11 * (1 - t) + rel * 0.16 * (1 - t * 0.5);
    seg.rotation.y = Math.sin(a.t * 1.1 - i * 0.55) * 0.06 + a.lookY * 0.14;
  }

  p.head.rotation.x = -w * 0.5 + rel * 0.9 + a.pitch * 0.35;
  p.head.rotation.y = a.lookY * 0.3;
  p.gullet.scale.setScalar(1 + w * 0.9 + rel * 0.6 + rage * 0.2 + Math.sin(a.t * (3 + rage * 4)) * 0.07);

  for (let i = 0; i < 4; i++) {
    // The jaw splays wide through the wind-up and snaps shut on the strike —
    // a four-way iris opening is a tell you can read from behind the boss.
    const open = w * 1.1 - rel * 1.35;
    p.jaw[i].rotation.x = -0.12 - open;
    p.jaw[i].rotation.z = Math.sin(a.t * 2.2 + i * 1.6) * 0.05;
    p.jaw[i].position.y = 0.62 + open * 0.12;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// THUNDERHEAD — a flying boss made of nothing but rings. Three counter-rotating
// plate rings around a storm core, with conductor spines hanging under it. The
// only silhouette in the game built out of circles, and the ring tilt reads at
// any distance because it is 6 m across.
// ---------------------------------------------------------------------------

function buildThunderhead() {
  const rig = newRig('thunderhead');
  rig.centerY = 0;
  rig.height = 5.0;
  rig.auraR = 3.2;
  rig.shadowR = 2.0;
  rig.flyer = true;

  rig.parts.core = add(rig, rig.pivot, 'accent', ico(1.05, 2), 0, 0, 0);
  // Core cage: a dark shell in pieces so the light escapes between them rather
  // than the core being a bare glowing ball.
  add(rig, rig.pivot, 'dark', merged('thd.cage', [
    P(box(0.34, 1.9, 0.34), 0.95, 0, 0, 0, 0, -0.25),
    P(box(0.34, 1.9, 0.34), -0.95, 0, 0, 0, 0, 0.25),
    P(box(0.34, 1.9, 0.34), 0, 0, 0.95, 0.25),
    P(box(0.34, 1.9, 0.34), 0, 0, -0.95, -0.25),
    P(hemi(1.15, 10, 5), 0, 0.5, 0, 0, 0, 0, 1, 0.7, 1),
    P(hemi(1.15, 10, 5), 0, -0.5, 0, Math.PI, 0, 0, 1, 0.7, 1),
  ]));

  // Three rings. Different radii, different tilts, counter-rotating: that is
  // the whole identity, and the plate teeth on each keep them from reading as
  // smooth hoops.
  rig.parts.ring = [];
  const ringSpec = [[2.4, 0.0, 10], [1.95, 0.7, 8], [2.85, -0.5, 12]];
  for (let i = 0; i < 3; i++) {
    const [rad, tilt, teeth] = ringSpec[i];
    const g = grp(rig.pivot, 0, 0, 0);
    g.rotation.z = tilt;
    const pieces = [P(ring(rad, 0.12, 4, 20), 0, 0, 0, Math.PI * 0.5)];
    for (let k = 0; k < teeth; k++) {
      const ang = (k / teeth) * Math.PI * 2;
      pieces.push(P(box(0.34, 0.16, 0.5), Math.cos(ang) * rad, 0, Math.sin(ang) * rad, 0, -ang, 0));
      if (k % 3 === 0) {
        pieces.push(P(cone(0.14, 0.5, 4), Math.cos(ang) * (rad + 0.3), 0, Math.sin(ang) * (rad + 0.3),
          0, -ang, -Math.PI * 0.5));
      }
    }
    add(rig, g, 'body', merged(`thd.ring${i}`, pieces));
    add(rig, g, 'accent', merged(`thd.ringGlow${i}`, [
      P(ring(rad * 0.96, 0.04, 3, 20), 0, 0, 0, Math.PI * 0.5),
    ]));
    crumbles(rig, g);
    rig.parts.ring.push(g);
  }

  // Conductor spines under the core — where the ground beam comes from, and
  // the only downward feature, so the boss has an underside.
  rig.parts.spine = [];
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const g = grp(rig.pivot, Math.cos(ang) * 0.7, -0.9, Math.sin(ang) * 0.7);
    add(rig, g, 'dark', merged('thd.spine', [
      P(cyl(0.16, 0.07, 1.5, 5), 0, -0.75, 0),
      P(ico(0.13, 0), 0, -1.55, 0),
    ]));
    rig.parts.spine.push(g);
  }
  add(rig, rig.pivot, 'eye', merged('thd.nodes', [
    P(ico(0.16, 0), 0, -1.55, 0),
    P(ico(0.12, 0), 0.5, 0.9, 0.5),
    P(ico(0.12, 0), -0.5, 0.9, -0.5),
  ]));

  const head = grp(rig.pivot, 0, -0.2, 0);
  rig.parts.head = head;
  rig.parts.beam = beam(rig, head, 0, 0.9);

  makeAura(rig, rig.auraR);
  rig.animate = animThunderhead;
  return rig;
}

function animThunderhead(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const fire = a.swing > 0 ? 1 - a.swing : 0;
  const rage = a.phase > 1 ? 1 : 0;

  // Rings spin up hard through the wind-up and settle after the discharge —
  // the machine winding is the tell, and it is visible from every angle.
  const spin = 0.35 + w * 4.5 + rage * 0.5 + fire * 2.0;
  p.ring[0].rotation.y = a.t * spin;
  p.ring[1].rotation.y = -a.t * spin * 1.35;
  p.ring[2].rotation.y = a.t * spin * 0.7;
  p.ring[1].rotation.z = 0.7 + Math.sin(a.t * 0.6) * 0.12 - w * 0.3;
  p.ring[2].rotation.z = -0.5 - Math.sin(a.t * 0.45) * 0.1 + w * 0.25;
  for (let i = 0; i < 3; i++) p.ring[i].scale.setScalar(1 + w * 0.06 - fire * 0.1);

  p.core.scale.setScalar(1 + rage * 0.15 + w * 0.7 + fire * 0.9 + Math.sin(a.t * (4 + rage * 5)) * 0.05);
  p.core.rotation.y = a.t * 1.1;
  p.core.rotation.x = a.t * 0.7;

  for (let i = 0; i < p.spine.length; i++) {
    const g = p.spine[i];
    // Spines swing inward and point down as the ground sweep charges.
    g.rotation.x = Math.sin(a.t * 1.6 - i * 0.8) * 0.12 + w * 0.25;
    g.rotation.z = Math.cos(a.t * 1.4 - i * 0.8) * 0.12;
    g.scale.y = 1 + w * 0.3;
  }

  p.head.rotation.y = a.lookY * 0.4 + a.sweep;
  p.head.rotation.x = clamp(a.pitch, -1.2, 0.4) - 0.35;
  setBeam(p.beam, a.beamLen, a.beamOn ? (a.windup > 0 ? 0.1 + w * 0.2 : 0.8 + Math.sin(a.t * 36) * 0.12) : 0, a.beamOn);
  common(rig, a);
}

// ---------------------------------------------------------------------------
// PYRE MATRON — brood-mother. Four legs ARCHED OVER the body so the outline is
// a cage of angles with a low thorax slung under it, plus an abdomen full of
// lit eggs that is bigger than the rest of her put together.
// ---------------------------------------------------------------------------

function buildMatron() {
  const rig = newRig('matron');
  rig.centerY = 2.2;
  rig.height = 5.8;
  rig.auraR = 3.6;
  rig.shadowR = 2.3;

  const body = grp(rig.pivot, 0, 2.0, 0);
  rig.parts.body = body;

  add(rig, body, 'body', merged('mat.thorax', [
    P(hemi(1.15, 12, 6), 0, -0.1, 0.35, 0, 0, 0, 1.35, 0.85, 1.5),
    P(cyl(0.95, 1.15, 0.7, 7), 0, -0.15, -0.5, 0, Math.PI / 6, Math.PI * 0.5),
    P(box(0.4, 0.5, 1.1), 0, 0.55, 0.1, -0.25),
    P(cone(0.28, 0.9, 4), 0.62, 0.5, -0.2, -0.5, 0.3, 0.2, 0.5, 1, 1),
    P(cone(0.28, 0.9, 4), -0.62, 0.5, -0.2, -0.5, -0.3, -0.2, 0.5, 1, 1),
  ]));

  // Abdomen: the mass. Hangs behind and below, with rind plates and lit egg
  // clusters showing between them.
  const abdomen = grp(body, 0, -0.1, -1.5);
  rig.parts.abdomen = abdomen;
  add(rig, abdomen, 'body', merged('mat.abdomen', [
    P(sph(1.35, 12, 9), 0, 0, -0.6, 0, 0, 0, 1, 0.95, 1.25),
    P(box(0.7, 1.5, 1.9), 0.85, 0.1, -0.6, 0, 0, -0.3),
    P(box(0.7, 1.5, 1.9), -0.85, 0.1, -0.6, 0, 0, 0.3),
    P(cone(0.5, 1.1, 5), 0, -0.2, -2.0, -Math.PI * 0.5),
  ]));
  add(rig, abdomen, 'accent', merged('mat.eggs', [
    P(ico(0.3, 1), 0.55, 0.5, -0.35),
    P(ico(0.26, 1), -0.5, 0.6, -0.7),
    P(ico(0.28, 1), 0.15, 0.75, -1.1),
    P(ico(0.22, 1), -0.2, 0.35, -1.55),
    P(ico(0.24, 1), 0.62, 0.15, -1.2),
  ]));
  crumbles(rig, abdomen);

  const head = grp(body, 0, 0.1, 1.15);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'dark', merged('mat.head', [
    P(cyl(0.5, 0.62, 0.7, 7), 0, 0, 0.1, Math.PI * 0.5),
    P(box(1.0, 0.28, 0.5), 0, 0.3, -0.05, -0.25),
  ]));
  // Six eyes in two rows — the arachnid read, and it survives being three
  // pixels tall because the cluster is a shape.
  add(rig, head, 'eye', merged('mat.eyes', [
    P(ico(0.13, 0), 0.24, 0.16, 0.42),
    P(ico(0.13, 0), -0.24, 0.16, 0.42),
    P(ico(0.09, 0), 0.42, 0.02, 0.34),
    P(ico(0.09, 0), -0.42, 0.02, 0.34),
    P(ico(0.07, 0), 0.14, -0.06, 0.5),
    P(ico(0.07, 0), -0.14, -0.06, 0.5),
  ]));
  // The pyre spout, between the mandibles.
  rig.parts.spout = add(rig, head, 'accent', ico(0.26, 1), 0, -0.2, 0.55);
  rig.parts.mand = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const g = grp(head, 0.3 * s, -0.28, 0.4);
    add(rig, g, 'dark', merged(i === 0 ? 'mat.mandR' : 'mat.mandL',
      i === 0
        ? [P(cyl(0.14, 0.05, 0.8, 5), 0.04, -0.1, 0.3, 1.25, 0, 0.3)]
        : mirror([P(cyl(0.14, 0.05, 0.8, 5), 0.04, -0.1, 0.3, 1.25, 0, 0.3)])));
    rig.parts.mand.push(g);
  }

  // Legs: coxa arcs UP and out, femur comes back DOWN. That inversion is what
  // puts the knees above the body and gives the boss its cage outline.
  rig.parts.coxa = [];
  rig.parts.femur = [];
  const zs = [0.9, 0.2, -0.5, -1.2];
  for (let i = 0; i < 8; i++) {
    const right = i < 4;
    const s = right ? 1 : -1;
    const cx = grp(body, 0.9 * s, 0.1, zs[i % 4]);
    add(rig, cx, 'dark', merged(right ? 'mat.coxaR' : 'mat.coxaL',
      right
        ? [P(cyl(0.24, 0.18, 1.5, 5), 0.5, 0.6, 0, 0, 0, -0.72)]
        : mirror([P(cyl(0.24, 0.18, 1.5, 5), 0.5, 0.6, 0, 0, 0, -0.72)])));
    const fm = grp(cx, 1.0 * s, 1.2, 0);
    add(rig, fm, 'dark', merged(right ? 'mat.femR' : 'mat.femL',
      right
        ? [
            P(cyl(0.18, 0.1, 1.9, 5), 0.42, -0.9, 0, 0, 0, 0.42),
            P(cone(0.09, 0.5, 4), 0.8, -1.85, 0.06, Math.PI * 0.92),
          ]
        : mirror([
            P(cyl(0.18, 0.1, 1.9, 5), 0.42, -0.9, 0, 0, 0, 0.42),
            P(cone(0.09, 0.5, 4), 0.8, -1.85, 0.06, Math.PI * 0.92),
          ])));
    rig.parts.coxa.push(cx);
    rig.parts.femur.push(fm);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animMatron;
  return rig;
}

const MAT_PHASE = [0, Math.PI, 0, Math.PI, Math.PI, 0, Math.PI, 0];

function animMatron(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const rel = a.swing > 0 ? strike(a.swing) : 0;
  const fire = a.attack === 'pyre' ? 1 : 0;
  const hatch = a.attack === 'brood' ? 1 : 0;
  const rage = a.phase > 1 ? 1 : 0;

  // Rears up to fire (the spout has to clear her own legs) and hunches down
  // over the abdomen to hatch.
  p.body.position.y = 2.0 + w * (fire * 0.5 - hatch * 0.35) + Math.sin(a.stride * 2) * 0.09 * sp;
  p.body.rotation.x = -w * fire * 0.34 + w * hatch * 0.3 + rel * fire * 0.4;
  p.body.rotation.z = Math.sin(a.stride) * 0.07 * sp;
  p.body.rotation.y = Math.sin(a.stride * 0.5) * 0.05 * sp;

  // Abdomen pumps hard while hatching; eggs light up with the phase.
  const pump = hatch ? (w + rel) : 0;
  p.abdomen.scale.set(1 + pump * 0.2 + rage * 0.06, 1 - pump * 0.14, 1 + pump * 0.2 + rage * 0.06);
  p.abdomen.rotation.x = 0.1 + Math.sin(a.t * 1.2) * 0.05 + w * hatch * 0.4 - rel * hatch * 0.3;

  p.head.rotation.x = a.pitch * 0.4 - w * fire * 0.5 + rel * fire * 0.7;
  p.head.rotation.y = a.lookY * 0.45;
  p.spout.scale.setScalar(0.5 + w * fire * 2.2 + rel * fire * 2.6 + Math.sin(a.t * 5) * 0.06);
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    p.mand[i].rotation.y = -s * (0.2 + w * 0.7 - rel * 0.6);
    p.mand[i].rotation.x = Math.sin(a.t * 3 + i) * 0.06 - w * 0.2;
  }

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 8; i++) {
    const ph = a.stride * 1.1 + MAT_PHASE[i];
    const s = i < 4 ? 1 : -1;
    // The cage flexes: coxae lift on the wind-up so she visibly braces.
    p.coxa[i].rotation.z = -s * (Math.max(0, -Math.sin(ph)) * 0.28 * sp + w * 0.16);
    p.coxa[i].rotation.x = Math.cos(ph) * (0.1 + 0.24 * sp);
    p.femur[i].rotation.x = -Math.cos(ph) * (0.14 + 0.3 * sp);
    p.femur[i].rotation.z = s * w * 0.12;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// IRON VIZIER — the armoured one. A tower shield taller than a Skink on one
// side and a bladed haft on the other, under a crowned helm. Phase 1 fights
// from behind the shield; the phase break drops it, and the pose change is the
// most legible thing in the fight.
// ---------------------------------------------------------------------------

const VIZ_HIP = 3.4, VIZ_L1 = 1.3, VIZ_L2 = 1.25;

function buildVizier() {
  const rig = newRig('vizier');
  rig.centerY = 3.2;
  rig.height = 6.4;
  rig.auraR = 3.8;
  rig.shadowR = 2.1;

  const spine = grp(rig.pivot, 0, VIZ_HIP, 0);
  rig.parts.spine = spine;

  add(rig, spine, 'body', merged('viz.torso', [
    P(cyl(1.25, 0.9, 1.9, 6), 0, 0.75, 0, 0, Math.PI / 6, 0, 1.08, 1, 0.78),
    P(cyl(1.0, 1.2, 0.9, 6), 0, -0.7, 0, 0, Math.PI / 6, 0),
    // Gorget deck, canted forward.
    P(box(2.5, 0.5, 1.2), 0, 1.75, 0.1, 0.12),
    P(box(0.9, 1.1, 0.7), 1.15, 1.5, 0.0, 0, 0, -0.35),
    P(box(0.9, 1.1, 0.7), -1.15, 1.5, 0.0, 0, 0, 0.35),
    // Back banner mast — asymmetric, and the tallest thing on the rig.
    P(cyl(0.14, 0.11, 2.6, 5), -0.5, 2.2, -0.75, 0.22),
    P(box(0.9, 1.4, 0.08), -0.5, 2.6, -1.15, 0.22),
  ]));
  add(rig, spine, 'dark', merged('viz.fauld', [
    P(box(1.9, 0.9, 0.5), 0, -1.35, 0.55, 0.2),
    P(box(0.8, 1.1, 0.4), 0.95, -1.4, 0.35, 0, 0, -0.25),
    P(box(0.8, 1.1, 0.4), -0.95, -1.4, 0.35, 0, 0, 0.25),
    P(box(1.7, 0.7, 0.4), 0, -1.3, -0.6, -0.2),
  ]));
  rig.parts.core = add(rig, spine, 'accent', ico(0.55, 1), 0, 0.5, 0.78);
  add(rig, spine, 'accent', merged('viz.filigree', [
    P(box(0.12, 1.5, 0.08), 0.5, 0.9, 0.75, 0, 0, -0.2),
    P(box(0.12, 1.5, 0.08), -0.5, 0.9, 0.75, 0, 0, 0.2),
    P(box(1.6, 0.1, 0.08), 0, 1.62, 0.66),
  ]));

  const head = grp(spine, 0, 2.1, 0.12);
  rig.parts.head = head;
  crumbles(rig, head);
  add(rig, head, 'body', merged('viz.helm', [
    P(cyl(0.46, 0.56, 0.85, 6), 0, 0.05, 0, 0, Math.PI / 6, 0),
    P(box(1.0, 0.28, 0.7), 0, 0.42, 0.06, -0.22),
    // Crown points, uneven heights.
    P(cone(0.14, 0.8, 4), 0, 0.85, -0.05, -0.1),
    P(cone(0.12, 0.6, 4), 0.34, 0.75, -0.08, -0.15, 0, 0.3),
    P(cone(0.12, 0.68, 4), -0.34, 0.78, -0.08, -0.15, 0, -0.3),
  ]));
  add(rig, head, 'eye', merged('viz.visor', [
    P(box(0.62, 0.07, 0.07), 0, -0.02, 0.42),
    P(box(0.08, 0.2, 0.07), 0.2, -0.12, 0.4),
    P(box(0.08, 0.2, 0.07), -0.2, -0.12, 0.4),
  ]));
  rig.parts.beam = [];
  for (let i = 0; i < 2; i++) {
    const g = grp(head, 0.2 * (i === 0 ? 1 : -1), -0.02, 0.44);
    rig.parts.beam.push(beam(rig, g, 0, 0.05));
  }

  // Tower shield.
  const shield = grp(spine, 1.55, 1.3, 0.25);
  rig.parts.shield = shield;
  add(rig, shield, 'dark', merged('viz.shieldArm', [P(cyl(0.3, 0.26, 1.3, 5), 0, -0.65, 0)]));
  add(rig, shield, 'body', merged('viz.shield', [
    P(box(0.3, 3.6, 2.0), 0.62, -0.9, 0.1),
    P(box(0.18, 3.85, 0.4), 0.74, -0.9, 0.1),
    P(box(0.18, 0.5, 2.2), 0.74, 0.85, 0.1),
    P(cone(0.5, 1.0, 4), 0.68, -2.95, 0.1, Math.PI, 0, 0, 1, 1, 2.0),
    P(ico(0.45, 0), 0.82, -0.9, 0.12, 0, 0, 0, 0.7, 1.2, 1.2),
  ]));
  add(rig, shield, 'accent', merged('viz.shieldGlow', [
    P(box(0.08, 2.6, 0.12), 0.84, -0.9, 0.12),
    P(box(0.08, 0.12, 1.5), 0.84, -0.9, 0.12),
  ]));
  crumbles(rig, shield);

  // Haft: a long pole weapon held low and angled back, so it extends the
  // silhouette past the shoulder on the unshielded side.
  const haft = grp(spine, -1.5, 1.35, 0.2);
  rig.parts.haft = haft;
  add(rig, haft, 'dark', merged('viz.haft', [
    P(cyl(0.16, 0.14, 3.6, 5), 0, -1.2, 0, 0.35),
  ]));
  add(rig, haft, 'body', merged('viz.blade', [
    P(box(0.14, 1.5, 0.6), 0, 0.55, -0.5, 0.35),
    P(cone(0.3, 1.1, 4), 0, 1.3, -0.75, 0.35, 0, 0, 0.5, 1, 1),
  ]));
  add(rig, haft, 'accent', merged('viz.edge', [P(box(0.06, 1.3, 0.1), 0.02, 0.55, -0.72, 0.35)]));
  crumbles(rig, haft);

  rig.parts.hip = [];
  rig.parts.knee = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? 1 : -1;
    const hip = grp(spine, 0.7 * s, -1.2, 0);
    add(rig, hip, 'dark', merged('viz.thigh', [
      P(cyl(0.5, 0.4, VIZ_L1, 6), 0, -VIZ_L1 * 0.5, 0),
      P(box(0.6, 0.7, 0.5), 0.02, -0.3, 0.18),
    ]));
    const knee = grp(hip, 0, -VIZ_L1, 0);
    add(rig, knee, 'dark', merged('viz.shin', [
      P(cyl(0.38, 0.5, VIZ_L2, 6), 0, -VIZ_L2 * 0.5, 0),
      P(box(0.9, 0.34, 1.35), 0, -VIZ_L2 + 0.12, 0.25),
      P(box(0.7, 0.22, 0.35), 0, -VIZ_L2 + 0.06, 0.9),
    ]));
    add(rig, knee, 'body', merged('viz.knee', [P(ico(0.36, 0), 0, -0.04, 0.22, 0.2, 0.4, 0)]));
    rig.parts.hip.push(hip);
    rig.parts.knee.push(knee);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animVizier;
  return rig;
}

function animVizier(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const rel = a.swing > 0 ? strike(a.swing) : 0;
  const ch = a.charge;
  const sunder = a.attack === 'sunder' ? 1 : 0;
  const edict = a.attack === 'edict' ? 1 : 0;
  // Phase 1 fights from behind the shield. Every later phase has dropped it.
  const guard = a.phase > 1 ? 0 : 1;

  p.spine.position.y = VIZ_HIP - w * (sunder * 0.4 + ch * 0.2) - rel * sunder * 0.5
    + Math.sin(a.stride * 2) * 0.12 * sp;
  p.spine.position.z = ch * 0.35;
  p.spine.rotation.x = -w * (sunder * 0.25 + edict * 0.12) + rel * sunder * 0.45 + ch * 0.3;
  p.spine.rotation.z = Math.sin(a.stride) * 0.09 * sp;
  // Shoulder turned into the guard while the shield is up, squared off once
  // it drops — you can read the phase from the stance alone.
  p.spine.rotation.y = guard * (0.34 - ch * 0.5) + a.lookY * 0.12;

  p.head.rotation.y = a.lookY * 0.55 + a.sweep;
  p.head.rotation.x = a.pitch * 0.5 - w * edict * 0.2;
  // Modest swing: it is a 0.55 m emissive sphere on a 6.4 m boss and at 1.65x
  // it bloomed into a featureless white disc over the chest.
  p.core.scale.setScalar(1 + (1 - guard) * 0.14 + w * 0.18 + rel * 0.16 + Math.sin(a.t * 2.6) * 0.04);

  // Shield: braced high in phase 1, hanging dead at its side afterwards.
  p.shield.rotation.x = guard ? (-0.15 - w * (ch ? 0.5 : 0.25) + rel * 0.3) : 0.9;
  p.shield.rotation.z = guard ? (-0.1 - w * 0.15 - ch * 0.25) : -0.55;
  p.shield.position.y = 1.3 - (1 - guard) * 0.5;

  // Haft: swings on the sunder, levels into a two-handed guard for the edict.
  p.haft.rotation.x = edict ? (-0.9 - w * 0.5 + rel * 0.4)
    : (-0.15 - w * (sunder * 1.9) + rel * sunder * 2.6 + Math.sin(a.stride + Math.PI) * 0.2 * sp);
  p.haft.rotation.z = 0.1 + w * (edict ? 0.5 : 0.25) - rel * 0.3 + (1 - guard) * 0.2;
  p.haft.rotation.y = edict ? (0.5 + w * 0.4) : 0;

  for (let i = 0; i < 2; i++) {
    setBeam(p.beam[i], a.beamLen,
      a.beamOn ? 0.22 * (a.windup > 0 ? 0.3 + w * 0.6 : 1.5 + Math.sin(a.t * 38) * 0.2) : 0, a.beamOn);
  }

  if (a.lod > 0) return common(rig, a);

  const stride = 0.6 * sp + 0.06;
  for (let i = 0; i < 2; i++) {
    const ph = a.stride + i * Math.PI;
    solveLeg(p.hip[i], p.knee[i], VIZ_L1, VIZ_L2,
      stepZ(ph, stride) * sp, -(VIZ_HIP - 1.2) + stepY(ph, 0.36) * sp, 1);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// VERDANT MAW — a boss that is a hole in the ground. Six petal plates around a
// toothed throat, ringed by tendrils, rooted into a crater. It never moves, so
// every bit of its budget went into being enormous and WIDE: the only boss
// whose silhouette is horizontal.
// ---------------------------------------------------------------------------

function buildMaw() {
  const rig = newRig('maw');
  rig.centerY = 1.6;
  rig.height = 5.2;
  rig.auraR = 3.8;
  rig.shadowR = 3.0;

  // Crater rim: eight buttress roots of uneven size lifting the mouth clear of
  // the ground so it has a lip rather than being a decal.
  const rim = grp(rig.pivot, 0, 0, 0);
  rig.parts.rim = rim;
  const roots = [P(cyl(2.5, 3.1, 1.0, 10), 0, 0.42, 0)];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const r = 2.6 + (i % 3) * 0.35;
    const h = 1.1 + (i % 4) * 0.4;
    roots.push(P(cyl(0.34, 0.62, h, 5), Math.cos(ang) * r, h * 0.4, Math.sin(ang) * r, 0.34, -ang, 0));
    roots.push(P(ico(0.5 + (i % 3) * 0.14, 0), Math.cos(ang) * (r + 0.6), 0.3, Math.sin(ang) * (r + 0.6),
      i * 0.4, ang, 0.2));
  }
  add(rig, rim, 'dark', merged('maw.rim', roots));

  // The throat: nested tooth rings going down into the lit gullet.
  const throat = grp(rig.pivot, 0, 0.7, 0);
  rig.parts.throat = throat;
  add(rig, throat, 'dark', merged('maw.throat', [
    P(cyl(1.7, 0.85, 1.5, 10), 0, -0.55, 0),
    P(ring(1.75, 0.2, 4, 16), 0, 0.15, 0, Math.PI * 0.5),
    P(ring(1.25, 0.16, 4, 14), 0, -0.55, 0, Math.PI * 0.5),
  ]));
  rig.parts.gullet = add(rig, throat, 'accent', ico(0.95, 1), 0, -0.7, 0);
  const teeth = [];
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2;
    teeth.push(P(cone(0.16, 0.7, 4), Math.cos(ang) * 1.55, 0.15, Math.sin(ang) * 1.55, 0.5, -ang, 0));
    if (i % 2 === 0) {
      teeth.push(P(cone(0.12, 0.5, 4), Math.cos(ang + 0.26) * 1.15, -0.4, Math.sin(ang + 0.26) * 1.15, 0.7, -ang, 0));
    }
  }
  add(rig, throat, 'body', merged('maw.teeth', teeth));

  // Petals. They are the silhouette: six wide plates that open outward as the
  // fight escalates, so the boss visibly gets *bigger* every phase.
  rig.parts.petal = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const g = grp(rig.pivot, Math.cos(ang) * 1.5, 0.85, Math.sin(ang) * 1.5);
    g.rotation.y = -ang + Math.PI * 0.5;
    const long = i % 2 === 0;
    add(rig, g, 'body', merged(long ? 'maw.petalA' : 'maw.petalB', [
      P(box(1.5, 0.34, long ? 2.9 : 2.3), 0, long ? 1.35 : 1.05, 0, -0.28),
      P(cone(0.55, long ? 1.5 : 1.1, 4), 0, long ? 2.8 : 2.2, -0.6, -0.28, 0, 0, 1, 1, 0.5),
      P(box(0.28, 0.5, long ? 2.6 : 2.0), 0.66, long ? 1.3 : 1.0, 0, -0.28, 0, -0.2),
      P(box(0.28, 0.5, long ? 2.6 : 2.0), -0.66, long ? 1.3 : 1.0, 0, -0.28, 0, 0.2),
    ]));
    add(rig, g, 'accent', merged(long ? 'maw.veinA' : 'maw.veinB', [
      P(box(0.12, 0.1, long ? 2.4 : 1.9), 0, long ? 1.5 : 1.2, 0.14, -0.28),
    ]));
    crumbles(rig, g);
    rig.parts.petal.push(g);
  }

  // Tendrils around the rim — the only fast-moving part, so the boss still has
  // life in it while the petals hold still.
  rig.parts.tendril = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + 0.4;
    const g = grp(rig.pivot, Math.cos(ang) * 2.3, 0.9, Math.sin(ang) * 2.3);
    g.rotation.y = -ang;
    add(rig, g, 'dark', merged('maw.tendril', [
      P(cyl(0.2, 0.13, 1.2, 5), 0, 0.6, 0, -0.2),
      P(cyl(0.13, 0.06, 1.1, 5), 0, 1.7, 0.35, -0.55),
      P(ico(0.12, 0), 0, 2.2, 0.85),
    ]));
    rig.parts.tendril.push(g);
  }
  add(rig, rig.pivot, 'eye', merged('maw.ocelli', [
    P(ico(0.16, 0), 1.1, 1.5, 1.9),
    P(ico(0.16, 0), -1.1, 1.5, 1.9),
    P(ico(0.12, 0), 1.9, 1.3, -1.3),
    P(ico(0.12, 0), -1.9, 1.3, -1.3),
  ]));

  const head = grp(rig.pivot, 0, 1.2, 0);
  rig.parts.head = head;
  rig.parts.beam = beam(rig, head, 0, 0.5);

  makeAura(rig, rig.auraR);
  rig.animate = animMaw;
  return rig;
}

function animMaw(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const rel = a.swing > 0 ? strike(a.swing) : 0;
  // Each phase leaves the flower further open. The boss is literally bigger in
  // phase 3 than in phase 1, which is the read a stationary fight needs.
  const bloom = clamp((a.phase - 1) * 0.4, 0, 0.8);
  const drawing = a.attack === 'draw' ? 1 : 0;

  const breath = Math.sin(a.t * 0.9) * 0.05;
  p.throat.rotation.y = a.t * 0.12;
  p.throat.scale.set(1 + breath - w * 0.08, 1 + w * 0.12 + rel * 0.1, 1 + breath - w * 0.08);
  p.gullet.scale.setScalar(1 + bloom * 0.3 + w * 0.8 + rel * 0.9 + Math.sin(a.t * (2.2 + bloom * 4)) * 0.07);

  for (let i = 0; i < 6; i++) {
    const g = p.petal[i];
    // Clamps shut on the wind-up and flings open on the release: a six-petal
    // iris is a tell that reads from directly overhead as well as side on.
    const open = bloom + w * -0.35 + rel * 0.9 + drawing * w * 0.5;
    g.rotation.x = -0.15 - open + Math.sin(a.t * 0.7 + i) * 0.03;
    g.rotation.z = Math.sin(a.t * 0.55 + i * 1.1) * 0.04;
  }

  for (let i = 0; i < 8; i++) {
    const g = p.tendril[i];
    const lag = a.t * (1.6 + bloom * 1.5) - i * 0.6;
    g.rotation.x = Math.sin(lag) * 0.3 - w * 0.5 + rel * 0.7;
    g.rotation.z = Math.cos(lag * 0.8) * 0.28;
    g.rotation.y = -Math.sin(lag * 0.5) * 0.2;
    g.scale.y = 1 + w * 0.25 + drawing * 0.3;
  }

  p.head.rotation.y = a.lookY * 0.5;
  setBeam(p.beam, a.beamLen, a.beamOn ? 0.9 + Math.sin(a.t * 20) * 0.15 : 0, a.beamOn);
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

/**
 * Flat decal ring that marks where an AoE is about to land.
 *
 * Unlike projectiles and shockwaves this gets its OWN material instance rather
 * than the shared `projMat`: a telegraph's opacity is its countdown, and six
 * shells in the air at different times have to be able to be at six different
 * points of that countdown. Sharing the material made them all read the fill
 * level of whichever one updated last. They are pooled by the Director, so the
 * instance count is bounded by concurrent rings, not by shots fired.
 */
export function makeTelegraph(color) {
  const mat = new THREE.MeshBasicMaterial({
    color, blending: THREE.AdditiveBlending, depthWrite: false,
    transparent: true, opacity: 0.85, fog: false, side: THREE.DoubleSide,
  });
  // Thin tube on purpose. The mesh is scaled uniformly by the telegraph's
  // radius, so the tube thickness scales with it: at 0.05 a boss nova's 17 m
  // ring came out as a 0.85 m band of additive light that bloomed into a white
  // bar across the whole frame. 0.028 keeps a 3 m ring visible and an 18 m one
  // a line rather than a wall.
  const m = new THREE.Mesh(ring(1, 0.028, 3, 40), mat);
  m.rotation.x = -Math.PI * 0.5;
  m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------------------
// factory table + rig pool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HERALD OF THE RIFT — the finale. A hovering colossus with no legs at all.
//
// Every other boss in the game is a walker or a burrower, so the silhouette cue
// here is the one thing none of them can do: it *floats*, and the space under
// it is empty. Vertically it reads top-heavy — a crown of shards over a broken
// shell over a tapering mantle that comes to a point — which is the inverse of
// the colossus's wide-shouldered pyramid, and it is the only unit in the roster
// whose widest point is above its middle.
//
// The shell is the animated tell: it is *shut* at rest, cracks open on the
// wind-up to show the core, and slams closed on the follow-through. Nothing
// about the pose depends on the ground, because it never touches it.
// ---------------------------------------------------------------------------

const HER_MID = 3.4;

function buildHerald() {
  const rig = newRig('herald');
  rig.centerY = HER_MID;
  rig.height = 6.8;
  rig.auraR = 3.6;
  rig.shadowR = 2.4;
  rig.flyer = true;

  // Mantle: a long tapered skirt hanging under the core. It is what gives the
  // unit its 6.8 m of height without a single leg, and its point is what makes
  // "hovering" read from a silhouette rather than from the shadow.
  const body = grp(rig.pivot, 0, HER_MID, 0);
  rig.parts.body = body;
  crumbles(rig, add(rig, body, 'body', merged('her.mantle', [
    P(cyl(1.5, 0.34, 3.2, 8), 0, -2.0, 0),
    P(cone(0.4, 1.4, 6), 0, -4.1, 0, Math.PI),
    // No collar here. A short wide cylinder seen edge-on is all fresnel, and
    // through the rim term it rendered as a blown white bar across the middle
    // of the boss - the brightest thing in the finale's first frame.
    P(cyl(1.55, 1.42, 0.34, 8), 0, -0.42, 0),
    // Four buttress fins down the skirt: at 40 m the mantle is one dark mass
    // and the fins are the only thing breaking its outline.
    P(box(0.22, 2.6, 1.0), 1.15, -1.7, 0, 0, 0, 0.16),
    P(box(0.22, 2.6, 1.0), -1.15, -1.7, 0, 0, 0, -0.16),
    P(box(1.0, 2.6, 0.22), 0, -1.7, 1.15, 0.16, 0, 0),
    P(box(1.0, 2.6, 0.22), 0, -1.7, -1.15, -0.16, 0, 0),
  ])));

  // The core: the only bright mass on the unit, and the thing the shell hides.
  const core = add(rig, body, 'accent', ico(1.25, 1));
  rig.parts.core = core;
  rig.parts.eye = add(rig, body, 'eye', merged('her.eye', [
    P(ico(0.42, 0), 0, 0.1, 1.05),
    P(box(1.5, 0.13, 0.13), 0, 0.55, 0.95),
  ]));

  // Shell: six heavy plates on their own groups so they can hinge outward.
  rig.parts.plates = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const g = grp(body, 0, 0, 0);
    g.rotation.y = a;
    const plate = add(rig, g, 'dark', merged('her.plate', [
      P(box(1.5, 2.3, 0.5), 0, 0, 1.5),
      P(box(1.1, 0.6, 0.34), 0, 1.35, 1.5),
      P(box(1.1, 0.6, 0.34), 0, -1.35, 1.5),
    ]));
    crumbles(rig, plate);
    rig.parts.plates.push(g);
  }

  // Crown: five shards angled outward over the shell. The widest point of the
  // whole unit, which is what makes the silhouette top-heavy.
  const crown = grp(body, 0, 2.1, 0);
  rig.parts.crown = crown;
  const shards = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const h = 2.0 + (i % 2) * 0.9;
    shards.push(P(cone(0.32, h, 5), Math.cos(a) * 1.35, h * 0.4, Math.sin(a) * 1.35, 0.30 * Math.sin(a), -a, -0.30 * Math.cos(a)));
  }
  crumbles(rig, add(rig, crown, 'body', merged('her.crown', shards)));
  add(rig, crown, 'accent', ring(1.55, 0.10, 5, 28)).rotation.x = Math.PI * 0.5;

  // Arms: two long spars reaching down and out, ending in a claw. They carry
  // the lance and give the wind-up somewhere to travel.
  rig.parts.arms = [];
  for (const s of [-1, 1]) {
    const g = grp(body, s * 1.9, 0.5, 0);
    crumbles(rig, add(rig, g, 'body', merged('her.arm', [
      P(cyl(0.34, 0.22, 3.0, 6), 0, -1.4, 0, 0, 0, -0.22),
      P(box(0.5, 0.5, 0.5), 0.32, -2.9, 0),
      P(cone(0.16, 1.1, 5), 0.32, -3.6, 0.3, 0.5),
      P(cone(0.16, 1.1, 5), 0.32, -3.6, -0.3, -0.5),
    ])));
    rig.parts.arms.push(g);
  }

  rig.parts.beam = beam(rig, body, 0.2, 1.4);
  makeAura(rig, rig.auraR);
  rig.animate = animHerald;
  return rig;
}

function animHerald(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const fire = a.swing > 0 ? 1 - a.swing : 0;
  // Phase read, straight off the health gates: the whole unit rises, spins
  // faster and burns hotter as the fight escalates, so a glance says which
  // third of the fight this is.
  const rage = clamp((a.phase - 1) / 2, 0, 1);

  const bob = Math.sin(a.t * (0.9 + rage * 0.6)) * (0.22 + rage * 0.1);
  p.body.position.y = HER_MID + bob + rage * 0.4;
  p.body.rotation.y = a.t * (0.16 + rage * 0.22);
  p.body.rotation.x = a.pitch * 0.2 + w * 0.12;

  // Core swells and brightens through the wind-up, then snaps back on release.
  p.core.scale.setScalar(1 + w * 0.5 + fire * 0.85 + Math.sin(a.t * (3 + rage * 6)) * 0.05);
  p.core.rotation.y = -a.t * (0.9 + rage);
  p.core.rotation.x = a.t * 0.4;
  p.eye.scale.setScalar(1 + w * 0.9 + fire * 1.2);

  // The shell opens on the tell. This is the readable half of the boss: plates
  // hinge out and up, the core is exposed, and they slam shut on the follow
  // through — the same anticipation/overshoot language the rest of the roster
  // speaks, at boss scale.
  const open = w * 0.85 + fire * 0.5 + rage * 0.18;
  for (let i = 0; i < p.plates.length; i++) {
    const g = p.plates[i];
    const ph = a.t * (0.5 + rage * 0.7) + i * 1.05;
    g.rotation.x = -open * (0.55 + (i % 2) * 0.2) + Math.sin(ph) * 0.05;
    g.rotation.z = Math.sin(ph * 0.7) * 0.04;
    g.position.y = open * 0.5 * (i % 2 ? 1 : -1) + Math.sin(ph) * 0.06;
    g.scale.setScalar(1 + open * 0.16);
  }

  p.crown.rotation.y = -a.t * (0.5 + rage * 0.8);
  p.crown.position.y = 2.1 + w * 0.4 + Math.sin(a.t * 1.6) * 0.1;
  p.crown.scale.setScalar(1 + w * 0.12);

  // Arms sweep forward on the wind-up and recoil past their rest pose after —
  // the follow-through is what stops a 7 m boss looking weightless.
  for (let i = 0; i < 2; i++) {
    const g = p.arms[i];
    const s = i ? 1 : -1;
    g.rotation.x = -w * 1.05 + fire * 0.55 + Math.sin(a.t * 1.3 + i) * 0.07;
    g.rotation.z = s * (0.16 + w * 0.5 - fire * 0.3);
    g.position.x = s * (1.9 + open * 0.35);
  }

  setBeam(p.beam, a.beamLen,
    a.beamOn ? (a.windup > 0 ? 0.14 + w * 0.4 : 1.3 + Math.sin(a.t * 34) * 0.18) : 0, a.beamOn);
  common(rig, a);
}

// ---------------------------------------------------------------------------
// GLOOMSHRIVER — a suspended bell with a shroud and a clapper.
//
// The three tier-1 flyers already occupy a vertical spire (mote), a wide flat
// parasol (shrike) and a horizontal arrowhead (harrier). A bell is the fourth
// shape none of them makes: narrow at the top, flared hard at the bottom, and
// *hollow* — the only silhouette in the roster you can see through. The tell is
// the flare, which opens and rings before every shot, so the wind-up is a change
// in the outline rather than a change in brightness.
// ---------------------------------------------------------------------------

function buildShriver() {
  const rig = newRig('shriver');
  rig.centerY = 0;
  rig.height = 1.2;
  rig.auraR = 1.05;
  rig.shadowR = 0.6;
  rig.flyer = true;

  const bell = grp(rig.pivot, 0, 0.1, 0);
  rig.parts.bell = bell;
  // Open-ended cone would be ideal, but `cone()` is cached closed; the rim
  // torus underneath is what sells the opening, and it costs one draw against a
  // custom geometry that nothing else could share.
  add(rig, bell, 'body', merged('shr.bell', [
    P(cone(0.46, 0.72, 7), 0, -0.04, 0, Math.PI),
    P(cyl(0.14, 0.2, 0.24, 6), 0, 0.42, 0),
    // Three ribs down the outside. A smooth cone is a party hat; the ribs are
    // what make it read as cast metal at 20 m.
    P(box(0.06, 0.66, 0.06), 0.3, -0.06, 0.16, 0, 0, -0.35),
    P(box(0.06, 0.66, 0.06), -0.24, -0.06, -0.26, 0, 0, 0.35),
    P(box(0.06, 0.66, 0.06), 0.02, -0.06, -0.32, 0, 0, 0.05),
  ]));
  rig.parts.rim = add(rig, bell, 'accent', ring(0.44, 0.045, 4, 18), 0, -0.36, 0);
  rig.parts.rim.rotation.x = Math.PI * 0.5;

  // The clapper hangs *below the rim*, i.e. outside the body, so the unit's
  // outline has a detached dot under it — the one piece of the shape that keeps
  // moving when the bell is still.
  const clapper = grp(bell, 0, -0.34, 0);
  rig.parts.clapper = clapper;
  add(rig, clapper, 'dark', merged('shr.clapper', [
    P(cyl(0.03, 0.03, 0.3, 5), 0, -0.15, 0),
  ]));
  rig.parts.knell = add(rig, clapper, 'eye', ico(0.11, 0), 0, -0.32, 0);

  // Shroud: four ragged panels hanging off the crown, well outside the cone.
  // They are the reason the unit does not resolve to a clean triangle.
  rig.parts.shroud = [];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.5;
    const g = grp(bell, Math.cos(ang) * 0.34, 0.2, Math.sin(ang) * 0.34);
    g.rotation.y = -ang;
    add(rig, g, 'dark', merged('shr.rag', [
      P(box(0.24, 0.6, 0.04), 0, -0.3, 0, 0, 0, 0.12),
      P(box(0.14, 0.26, 0.04), 0.06, -0.68, 0, 0, 0, -0.2),
    ]));
    rig.parts.shroud.push(g);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animShriver;
  return rig;
}

function animShriver(rig, a) {
  const p = rig.parts;
  const w = anticipate(a.windup);
  const fired = a.swing > 0 ? 1 - a.swing : 0;

  // Idle: a slow pendulum swing on the whole bell, which is what a hanging
  // object does and no other flyer in the roster is doing.
  const bob = Math.sin(a.t * 1.3) * 0.1;
  p.bell.position.y = 0.1 + bob - w * 0.12;
  p.bell.rotation.z = Math.sin(a.t * 1.1) * 0.16 + a.lean * 0.4;
  p.bell.rotation.x = Math.cos(a.t * 0.9) * 0.1 + w * 0.2 - fired * 0.3;
  p.bell.rotation.y = a.lookY * 0.3;

  // The wind-up FLARES the bell — a scale on X/Z only, so the outline widens
  // without the unit getting bigger. That is the tell, and it survives being
  // seen against a bright sky where a brightness cue would not.
  const flare = 1 + w * 0.42 - fired * 0.2;
  p.bell.scale.set(flare, 1 - w * 0.1, flare);
  p.rim.scale.setScalar(1 + w * 0.3 + fired * 0.5);

  // The clapper swings hard on the release and rings afterwards.
  const ring = fired > 0 ? Math.sin(fired * 34) * fired * 0.7 : Math.sin(a.t * 1.9) * 0.14;
  p.clapper.rotation.z = ring;
  p.clapper.rotation.x = Math.cos(a.t * 1.5) * 0.1;
  p.knell.scale.setScalar(0.7 + w * 1.5 + fired * 1.2);

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 4; i++) {
    const g = p.shroud[i];
    const ph = a.t * 2.0 + i * 1.57;
    g.rotation.x = Math.sin(ph) * 0.22 - a.speed * 0.5 - w * 0.3;
    g.rotation.z = Math.cos(ph * 0.8) * 0.18 + w * 0.35;
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// BRAMBLE LASHER — a thin trunk carrying a wide crown of tendrils.
//
// Every other ground unit in tier 2 keeps its mass low or central (the sentinel's
// slab, the warden's tower, the mortar's quadruped chassis, the acolyte's cone).
// This one is almost all *crown*: a narrow stem with six long arms whipping off
// the top, so it reads as a plant and its outline is mostly gaps. The reel is
// telegraphed by every arm hauling backwards at once — a whole-silhouette
// anticipation, which it needs, because the attack does not travel and there is
// no projectile for the player to read instead.
// ---------------------------------------------------------------------------

function buildLasher() {
  const rig = newRig('lasher');
  rig.centerY = 1.4;
  rig.height = 2.6;
  rig.auraR = 1.6;
  rig.shadowR = 0.75;

  // Root ball and stem. Kept deliberately thin (0.24 at the waist) — the crown
  // is only wide if the thing under it is not.
  add(rig, rig.pivot, 'dark', merged('lsh.root', [
    P(hemi(0.62, 9, 5), 0, 0.02, 0, 0, 0, 0, 1.1, 0.5, 1.1),
    P(cyl(0.2, 0.34, 0.5, 6), 0, 0.28, 0),
    // Buttress roots: three low fins, which is what stops the base being a bare
    // dome next to the Brood Sac.
    P(box(0.14, 0.26, 0.7), 0.34, 0.1, 0.1, 0, 0.5, 0),
    P(box(0.14, 0.26, 0.7), -0.34, 0.1, 0.1, 0, -0.5, 0),
    P(box(0.14, 0.26, 0.62), 0, 0.1, -0.4),
  ]));

  const stem = grp(rig.pivot, 0, 0.5, 0);
  rig.parts.stem = stem;
  add(rig, stem, 'body', merged('lsh.stem', [
    P(cyl(0.16, 0.24, 1.5, 6), 0, 0.75, 0),
    P(ring(0.2, 0.05, 4, 12), 0, 0.5, 0, Math.PI * 0.5),
    P(ring(0.18, 0.045, 4, 12), 0, 1.05, 0, Math.PI * 0.5),
  ]));

  const crown = grp(stem, 0, 1.55, 0);
  rig.parts.crown = crown;
  add(rig, crown, 'body', merged('lsh.head', [
    P(hemi(0.34, 8, 5), 0, 0, 0),
    P(cyl(0.3, 0.36, 0.24, 7), 0, -0.1, 0),
  ]));
  // The maw the reel drags you toward, and the only bright thing on the unit —
  // so the player can see what the suction is pointing at.
  rig.parts.maw = add(rig, crown, 'eye', ico(0.19, 1), 0, 0.06, 0.24);

  // Six tendrils, each two segments so the whip has an elbow. `merged` keys are
  // shared across all six: one geometry, six meshes.
  const seg1 = [P(cyl(0.055, 0.085, 0.7, 5), 0, -0.35, 0)];
  const seg2 = [
    P(cyl(0.03, 0.055, 0.62, 5), 0, -0.31, 0),
    P(cone(0.05, 0.2, 4), 0, -0.68, 0, Math.PI),
  ];
  rig.parts.arm = [];
  rig.parts.tip = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.3;
    const sh = grp(crown, Math.cos(ang) * 0.26, 0.02, Math.sin(ang) * 0.26);
    sh.rotation.y = -ang;
    add(rig, sh, 'dark', merged('lsh.seg1', seg1));
    const el = grp(sh, 0, -0.7, 0);
    add(rig, el, 'dark', merged('lsh.seg2', seg2));
    const barb = add(rig, el, 'accent', ico(0.06, 0), 0, -0.7, 0);
    crumbles(rig, el);
    rig.parts.arm.push(sh);
    rig.parts.tip.push(barb);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animLasher;
  return rig;
}

function animLasher(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  // `pull` holds `swing` across a long active window, so the reel is read off
  // the *active* phase rather than off the recovery snap the strike-frame
  // attacks use — otherwise the arms would relax during the two seconds the
  // suction is actually running.
  const reel = a.attack === 'reel' && a.swing > 0 ? 1 : 0;
  const fired = a.swing > 0 ? 1 - a.swing : 0;

  // A stem sways. It never bobs — a plant with a walk cycle is a biped.
  p.stem.rotation.x = Math.sin(a.t * 0.8) * 0.06 + sp * 0.18 - w * 0.26 + reel * 0.2;
  p.stem.rotation.z = Math.sin(a.t * 0.65) * 0.07 + a.lean * 0.6;
  p.crown.rotation.y = a.lookY * 0.5;
  p.crown.rotation.x = a.pitch * 0.5 + w * 0.3;
  p.maw.scale.setScalar(0.8 + w * 1.4 + reel * (1.1 + Math.sin(a.t * 18) * 0.18) + fired * 0.6);

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 6; i++) {
    const ph = a.t * 1.5 + i * 1.05;
    const sh = p.arm[i];
    // Idle: a lazy independent drift per arm. Wind-up: every arm hauls
    // *outward and back* together, which is the whole-silhouette tell. Reel:
    // they curl inward toward the maw, pointing at what is being dragged.
    sh.rotation.x = Math.sin(ph) * 0.2 - w * 0.7 + reel * 0.55 + sp * 0.25;
    sh.rotation.z = Math.cos(ph * 0.8) * 0.16 + (0.35 + w * 0.5 - reel * 0.6);
    sh.rotation.y = Math.sin(ph * 0.5) * 0.12;
    p.tip[i].scale.setScalar(0.7 + w * 1.2 + reel * 1.0);
  }
  common(rig, a);
}

// ---------------------------------------------------------------------------
// FERRITE REDOUBT — a squat drum behind a slab of shield, on three stubby legs.
//
// The unit is designed to be identified *by which face you are looking at*,
// because the entire fight is getting round to the other one. So the two halves
// are made as different as a single silhouette allows: the front is one flat
// unbroken plate with a single lens in it, and the back is an open frame of
// exposed ribs, vents and a hot core. Front reads as a wall, back reads as
// machinery, and at 25 m the player can tell which they are facing without
// having to shoot it first.
// ---------------------------------------------------------------------------

const RDT_BODY = 1.55;

function buildRedoubt() {
  const rig = newRig('redoubt');
  rig.centerY = 1.5;
  rig.height = 2.9;
  rig.auraR = 1.9;
  rig.shadowR = 1.05;

  const hull = grp(rig.pivot, 0, RDT_BODY, 0);
  rig.parts.hull = hull;
  // Wide and shallow: 2.3 across, 0.9 deep. The sentinel is the other wide tier-2
  // slab and it is a *tall* one on legs; this sits low and reads as a bunker.
  add(rig, hull, 'body', merged('rdt.drum', [
    P(cyl(0.78, 0.86, 1.0, 7), 0, 0, 0, Math.PI * 0.5, 0, 0, 1, 1.35, 1),
    P(box(1.5, 0.34, 0.8), 0, 0.62, -0.1),
  ]));

  // The shield. One flat plate, no ornament, deliberately larger than the hull
  // it protects — the reason a frontal shot is the wrong idea has to be visible.
  const shield = grp(hull, 0, -0.05, 0.62);
  rig.parts.shield = shield;
  add(rig, shield, 'body', merged('rdt.shield', [
    P(box(2.2, 1.9, 0.16), 0, 0, 0),
    P(box(2.34, 0.2, 0.3), 0, 0.9, -0.04),
    P(box(0.24, 1.9, 0.3), 1.06, 0, -0.06),
    P(box(0.24, 1.9, 0.3), -1.06, 0, -0.06),
  ]));
  // The one aperture. Small, central, and the beam comes out of it.
  rig.parts.lens = add(rig, shield, 'eye', ico(0.2, 1), 0, 0.06, 0.14);
  rig.parts.beam = beam(rig, shield, 0.06, 0.2);
  // Two shutters that clamp over the lens between shots and peel back through
  // the wind-up. The beam is a 1.7 s charge and the tell has to run the whole
  // length of it, which brightness alone cannot do.
  rig.parts.shutter = [];
  for (let i = 0; i < 2; i++) {
    const s = i ? 1 : -1;
    const g = grp(shield, 0, 0.06, 0.16);
    add(rig, g, 'dark', merged('rdt.shutter', [P(box(0.34, 0.5, 0.07), 0.17, 0, 0)]));
    g.rotation.z = s * Math.PI * 0.5;
    rig.parts.shutter.push(g);
  }

  // The open back. Exposed ribs and a hot core — this is the half the player is
  // meant to be shooting, so it is the half with something to aim at.
  const rear = grp(hull, 0, 0, -0.55);
  rig.parts.rear = rear;
  add(rig, rear, 'dark', merged('rdt.frame', [
    P(box(0.12, 1.5, 0.12), 0.6, 0, 0),
    P(box(0.12, 1.5, 0.12), -0.6, 0, 0),
    P(box(1.4, 0.12, 0.12), 0, 0.72, 0),
    P(box(1.4, 0.12, 0.12), 0, -0.72, 0),
    P(box(0.9, 0.12, 0.5), 0, 0, -0.2),
  ]));
  rig.parts.core = add(rig, rear, 'accent', ico(0.32, 1), 0, 0, -0.02);
  // Vent stacks off the back corners, canted outward. They are what makes the
  // rear outline ragged where the front is one clean rectangle.
  add(rig, rear, 'dark', merged('rdt.vents', [
    P(cyl(0.11, 0.15, 0.62, 6), 0.66, 0.62, -0.16, 0.3, 0, -0.3),
    P(cyl(0.11, 0.15, 0.62, 6), -0.66, 0.62, -0.16, 0.3, 0, 0.3),
  ]));

  // Three legs, not four: an odd count reads as a tripod emplacement rather
  // than as a walker, which is the correct impression for something that barely
  // moves and cannot turn.
  rig.parts.leg = [];
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2 + Math.PI;
    const hip = grp(rig.pivot, Math.sin(ang) * 0.62, RDT_BODY - 0.55, Math.cos(ang) * 0.62);
    hip.rotation.y = ang;
    add(rig, hip, 'dark', merged('rdt.leg', [
      P(cyl(0.16, 0.12, 0.6, 5), 0, -0.3, 0, 0, 0, -0.24),
      P(cyl(0.11, 0.09, 0.62, 5), 0.22, -0.86, 0, 0, 0, 0.12),
      P(box(0.34, 0.12, 0.42), 0.28, -1.18, 0),
    ]));
    rig.parts.leg.push(hip);
  }

  makeAura(rig, rig.auraR);
  rig.animate = animRedoubt;
  return rig;
}

function animRedoubt(rig, a) {
  const p = rig.parts;
  const sp = a.speed;
  const w = anticipate(a.windup);
  const fire = a.swing > 0 ? 1 - a.swing : 0;

  // Barely animates while walking, on purpose: the unit's whole identity is
  // that it does not reposition, and a lively gait would argue with that.
  p.hull.position.y = RDT_BODY + Math.sin(a.stride * 2) * 0.05 * sp - w * 0.06;
  p.hull.rotation.x = -w * 0.1 + fire * 0.16;
  p.hull.rotation.z = Math.sin(a.stride) * 0.05 * sp;

  // Recoil rocks the shield back on the shot rather than the body — the plate
  // is the heaviest thing on the unit and it should be the thing that moves.
  p.shield.rotation.x = -w * 0.14 + fire * 0.3;
  p.shield.position.z = 0.62 - fire * 0.18;
  p.lens.scale.setScalar(1 + w * 1.6 + fire * 1.4 + Math.sin(a.t * 24) * 0.1 * w);
  setBeam(p.beam, a.beamLen, 0.05 + w * 0.05 + fire * 0.3, a.beamOn);

  // The shutters peel from closed (edge-on across the lens) to fully open over
  // the wind-up. Half a right angle each, so at rest they overlap the aperture.
  for (let i = 0; i < 2; i++) {
    const s = i ? 1 : -1;
    p.shutter[i].rotation.z = s * (Math.PI * 0.5 - (w + fire * 0.6) * Math.PI * 0.42);
  }

  // The core breathes with the charge — the rear read, so a player who is
  // already behind it can still see the attack coming.
  p.core.scale.setScalar(1 + w * 0.6 + fire * 0.5 + Math.sin(a.t * 2.2) * 0.06);
  p.rear.rotation.y = Math.sin(a.t * 0.5) * 0.03;

  if (a.lod > 0) return common(rig, a);

  for (let i = 0; i < 3; i++) {
    const ph = a.stride + i * 2.09;
    const leg = p.leg[i];
    leg.rotation.x = Math.cos(ph) * (0.06 + 0.24 * sp);
    leg.rotation.z = -Math.max(0, -Math.sin(ph)) * 0.18 * sp - w * 0.08;
  }
  common(rig, a);
}

const BUILDERS = {
  herald: buildHerald,
  skink: buildSkink,
  scarab: buildScarab,
  mote: buildMote,
  sentinel: buildSentinel,
  shrike: buildShrike,
  colossus: buildColossus,
  // Round 5 roster.
  mite: buildMite,
  spitling: buildSpitling,
  harrier: buildHarrier,
  charger: buildCharger,
  burrower: buildBurrower,
  brood: buildBrood,
  warden: buildWarden,
  stalker: buildStalker,
  acolyte: buildAcolyte,
  mortar: buildMortar,
  hulk: buildHulk,
  wyrm: buildWyrm,
  thunderhead: buildThunderhead,
  matron: buildMatron,
  vizier: buildVizier,
  maw: buildMaw,
  // Round 7 roster. Registering here is what puts them in `ENEMY_IDS`, which is
  // what `fx/Prewarm.js` walks — a rig missing from this table compiles its
  // materials the first time one spawns, i.e. mid-fight.
  shriver: buildShriver,
  lasher: buildLasher,
  redoubt: buildRedoubt,
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
    windup: 0, swing: 0, attack: '', charge: 0,
    hurt: 0, death: 0, phase: 1,
    pitch: 0, lookY: 0, lean: 0, sweep: 0,
    beamOn: false, beamLen: 0,
    fallX: 1, fallZ: 0,
    lod: 0,
    // Terrain height under the unit, for the contact shadow. Null means "not
    // sampled" — see updateShadow.
    ground: null,
  };
}

export { lerp, clamp };
