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
// Octave-gated fbm. k retires the two upper octaves as the pixel footprint
// closes on them: below about two pixels an octave has stopped being structure
// and become noise, which is the same gate the metre-scale detail field applies
// at src/world/Materials.js:393. The normaliser is the octave sum at the k in
// force, not a constant, so the field keeps its range and its mean as octaves
// retire — a mean that drifted with distance would be the very defect this
// pass exists to remove.
float bmFbmK(vec2 p, float k) {
  float o0 = bmNoise(p) * 0.5;
  float o1 = bmNoise(p * 2.03 + vec2(17.3, 5.1)) * 0.25 * k;
  float o2 = bmNoise(p * 4.11 + vec2(41.7, 23.9)) * 0.125 * k * k;
  return (o0 + o1 + o2) / (0.5 + 0.25 * k + 0.125 * k * k);
}
float bmFbm(vec2 p) { return bmFbmK(p, 1.0); }

// The corruption's own field, sampled in **metres** on the three world planes
// and blended by the surface normal — the same triplanar construction, and the
// same ^4 blend, that src/world/Materials.js:439 uses for surface identity.
//
// This is what keeps the Void a claim rather than a colour. A mask read from a
// UV-locked map is retired by the near-field fade (uv 0.5, uvFade 20-60 m at
// src/world/Materials.js:303), so past the fade's end the corruption would have
// no structure left and a blighted object would resolve to a flat violet
// silhouette — the Void reading as a palette, which style-guide rule 2 exists
// to forbid. A field carrying its own world-space scale is not subject to that
// fade at all: its features shrink on screen as you walk away, the way real
// relief does, and they are still there at 200 m. It also decouples the
// corruption from UV authoring entirely, which matters because externally
// authored meshes arrive with whatever UVs their author felt like.
//
// The weight floor is subtracted before renormalising, so the partition of
// unity survives and the two planes a ground fragment does not need are skipped
// outright. Branching is safe here in a way it is not in the detail pass: these
// are arithmetic octaves, not texture fetches, so no mip derivative depends on
// the control flow.
float bmTri(vec3 wp, vec3 wn, vec2 warp, float freq, float k) {
  vec3 b = abs(wn); b *= b; b *= b;
  b = max(b - 0.004, vec3(0.0));
  b /= max(b.x + b.y + b.z, 1e-4);
  float v = 0.0;
  if (b.x > 0.0) v += b.x * bmFbmK(vec2(wp.z, wp.y) * freq + warp, k);
  if (b.y > 0.0) v += b.y * bmFbmK(vec2(wp.x, wp.z) * freq + warp, k);
  if (b.z > 0.0) v += b.z * bmFbmK(vec2(wp.x, wp.y) * freq + warp, k);
  return v;
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
    // Cheap reject before the transcendentals. Without it every terrain and
    // prop fragment on screen pays 8 atan + 32 sin for a result of 0 as soon as
    // eight patches exist anywhere in the stage. The bite only ever chews
    // *inward* (edge = p.z * (1.0 - bite), bite in [0, 0.10]), so 1.15x the
    // radius is a conservative bound outside which the term is provably 0 —
    // and distant terrain rejects a whole warp at a time, so the branch does
    // not pay for itself in divergence.
    if (d > p.z * 1.15) continue;
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
  // Both derivatives are taken HERE, above the coverage branch, and that
  // placement is the whole of their correctness: a derivative taken inside
  // the bm > 0.001 test would be a derivative in non-uniform control flow, which GLSL
  // leaves undefined — the same rule the detail pass keeps its noise fetches
  // out of a per-plane branch for (src/world/Materials.js:453-456).
  //
  // bmFW is the world extent of one pixel in metres, the one quantity that
  // knows about distance and about grazing foreshortening at once.
  vec3 bmDX = dFdx(vBlightWorld), bmDY = dFdy(vBlightWorld);
  float bmFW = max(length(bmDX), length(bmDY));
  // Geometric face normal, for the triplanar blend only. Taken from the world
  // position rather than carried as a varying because the blend is a ^4 hard
  // partition and cannot see the faceting, and because a varying would need
  // objectNormal in the vertex shader — which not every material this hook
  // attaches to is guaranteed to have declared.
  vec3 bmX = cross(bmDX, bmDY);
  vec3 bmN = length(bmX) > 1e-12 ? normalize(bmX) : vec3(0.0, 1.0, 0.0);
  float bm = blightMask(vBlightWorld);
  if (bm > 0.001) {
    // Linear-space void family (see file header). As sRGB, the two constants
    // below are fill #3a2349 and vein #6d48bc - which is what a human or an
    // agent asked "what colour is the Void" should read off this file.
    // docs/art/ASSET-SPEC.md quotes #3c284a / #6e4aba, eyeballed approximations
    // that land within a couple of levels; the spec is right. The values this
    // comment used to name (#2b1340 / #7a46c8) were reachable from neither the
    // sRGB transfer function nor a plain 2.2 gamma, and were simply stale.
    const vec3 BM_TINT = vec3(0.0419, 0.0166, 0.0665);
    const vec3 BM_VEIN = vec3(0.1522, 0.0640, 0.5040);
    vec2 bp = vBlightWorld.xz;
    // The patch shader's own domain warp, at the same frequencies, so veins on
    // a boulder continue the veins on the ground under it instead of starting a
    // second pattern. Left planar on purpose: at a 3.3 m period a warp has
    // nothing to stretch on a wall, and two octaves saved here pay for the
    // three planes of the field it warps.
    vec2 bw = vec2(bmFbm(bp * 0.30 + vec2(0.0, uBlightTime * 0.060)),
                   bmFbm(bp * 0.30 + vec2(4.7, -uBlightTime * 0.045)));
    // 1 / (0.55 * 4.11) = 0.442 m, the world period of the field's finest
    // octave. Full strength above ~5 px of it, retired below ~2.
    float bk = 1.0 - smoothstep(0.20, 0.55, bmFW / 0.442);
    float bn = bmTri(vBlightWorld, bmN, (bw - 0.5) * 2.6, 0.55, bk);
    float vein = smoothstep(0.045, 0.006, abs(bn - 0.5)) * bm;
    // One field, two reads. The filaments are its ridge; the *claim* is its
    // body — how much of the void this fragment has been taken by. The tint
    // used to be a flat 0.80 everywhere inside the coverage falloff, so all the
    // structure a blighted surface had came from the base material's near-field
    // map, and past that map's fade the object went to a structureless violet
    // wash. Modulating the same 0.80 by a metre-scale field puts the structure
    // in the corruption itself, where distance cannot take it away.
    //
    // The band is centred on 0.80, so the mean strength of the corruption is
    // exactly what it was; and it stops short of 1.0, so the base material is
    // never fully erased anywhere. Rule 2: the ochre object with the void's
    // claim over it, not a violet object.
    float claim = smoothstep(0.30, 0.70, bn);
    diffuseColor.rgb = mix(diffuseColor.rgb, BM_TINT, bm * mix(0.64, 0.96, claim));
    totalEmissiveRadiance += BM_VEIN * vein * (0.35 + 0.10 * uBlightBand);
  }
}
`;

const VERT_VARYING = /* glsl */ `#include <common>
varying vec3 vBlightWorld;`;

// Known duplication: eight of the nine library materials already carry
// `vDetW`, which Materials.js builds from the same product in the same chunk.
// Reusing it would need a define handshake between two independently attached
// hooks (crystal and every non-library material have no vDetW), so the two
// interpolators are the deliberate price of the hooks staying independent.
//
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
  // Idempotent: a second attach would inject a second `varying vec3
  // vBlightWorld;` (a GLSL redeclaration error, i.e. a black world) and append
  // a second `|blightmask` to the cache key.
  if (material.userData.blightMask) return material;
  material.userData.blightMask = true;
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
