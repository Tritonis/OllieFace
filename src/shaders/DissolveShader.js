import * as THREE from 'three';
import { cloneCharacterBlightMaterial } from './CharacterBlight.js';

/**
 * Noise dissolve, applied by patching an existing material rather than
 * replacing it.
 *
 * Rewriting a MeshStandardMaterial as a custom ShaderMaterial would mean
 * reimplementing the entire PBR + shadow + fog stack, and would silently break
 * every enemy that uses a slightly different material setup. Instead we splice
 * a discard and an emissive edge into the stock program via `onBeforeCompile`,
 * so lighting, shadows and fog keep working untouched and any
 * MeshStandardMaterial in the game can dissolve.
 *
 * The cut sweeps bottom-to-top and the surviving rim is pushed into
 * `totalEmissiveRadiance`, which means it goes through bloom for free — that
 * hot orange edge crawling up a corpse is the whole RoR2 death read.
 */

const DISSOLVE_CHUNK = /* glsl */ `
varying vec3 vDissolveWorld;
varying vec3 vDissolveLocal;
uniform float uDissolve;
uniform float uDissolveEdge;
uniform float uDissolveScale;
uniform float uDissolveEdgeIntensity;
uniform vec3  uDissolveColor;
uniform vec2  uDissolveBounds;

float dHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.7, 0.4));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float dNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dHash(i + vec3(0,0,0)), dHash(i + vec3(1,0,0)), f.x),
        mix(dHash(i + vec3(0,1,0)), dHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(dHash(i + vec3(0,0,1)), dHash(i + vec3(1,0,1)), f.x),
        mix(dHash(i + vec3(0,1,1)), dHash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

float dFbm(vec3 p) {
  return dNoise(p) * 0.6 + dNoise(p * 2.17) * 0.27 + dNoise(p * 4.6) * 0.13;
}
`;

export const DissolveDefaults = {
  edge: 0.12,
  scale: 5.5,
  edgeIntensity: 9.0,
  color: 0xff6a1e,
};

/**
 * Patches `material` in place. Returns the uniform bag — drive
 * `uniforms.uDissolve.value` from 0 (intact) to 1 (gone).
 *
 * Pass the mesh's world-space Y bounds so the sweep is normalised per model;
 * without that a tall boss dissolves at a wildly different rate to a small
 * monster and the effect stops reading as one thing.
 */
export function applyDissolve(material, opts = {}) {
  if (material.userData.dissolveUniforms) return material.userData.dissolveUniforms;

  const o = { ...DissolveDefaults, ...opts };
  const uniforms = {
    uDissolve: { value: 0 },
    uDissolveEdge: { value: o.edge },
    uDissolveScale: { value: o.scale },
    uDissolveEdgeIntensity: { value: o.edgeIntensity },
    uDissolveColor: { value: new THREE.Color(o.color) },
    uDissolveBounds: { value: new THREE.Vector2(o.minY ?? 0, o.maxY ?? 2) },
  };

  material.userData.dissolveUniforms = uniforms;

  // Bound: on a material class that implements onBeforeCompile as a prototype
  // method (RimStandardMaterial), calling it bare loses `this`.
  const prev = material.onBeforeCompile?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DISSOLVE_CHUNK}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vDissolveLocal = transformed;
        vDissolveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DISSOLVE_CHUNK}\nfloat gDissolveRim;`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        {
          float h = clamp(
            (vDissolveWorld.y - uDissolveBounds.x) /
            max(uDissolveBounds.y - uDissolveBounds.x, 0.001), 0.0, 1.0);
          float n = dFbm(vDissolveWorld * uDissolveScale);
          // Height biases the field so the burn crawls upward instead of
          // punching random holes all over the model at once.
          float field = n * 0.55 + h * 0.45;
          // Overshoot the sweep range so uDissolve=0 is fully intact and
          // uDissolve=1 is fully gone regardless of the noise distribution.
          float cut = uDissolve * 1.35 - 0.175;
          if (field < cut) discard;
          gDissolveRim = 1.0 - smoothstep(cut, cut + uDissolveEdge, field);
          gDissolveRim *= step(0.001, uDissolve);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += uDissolveColor * (gDissolveRim * gDissolveRim) * uDissolveEdgeIntensity;`
      );
  };

  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `dissolve|${key ? key() : ''}`;
  material.needsUpdate = true;
  return uniforms;
}

/**
 * Free-list of patched clones, keyed by the shared source material. A dying
 * instance cannot use the prefab material directly (it would dissolve every
 * living enemy that shares it), but cloning per death leaked one material per
 * corpse forever and left the recycled rig wearing a dead clone. So each source
 * material keeps a small pool sized to the peak number of *simultaneous*
 * dissolves of that material, and everything is handed back on completion.
 */
const _pool = new WeakMap();

function acquireVariant(source) {
  let free = _pool.get(source);
  if (!free) { free = []; _pool.set(source, free); }
  if (free.length) return free.pop();
  // `Material.copy` round-trips userData through JSON and copies no
  // own-property hook, so a clone of an already-patched material inherits dead
  // uniform bags. The corruption pass has the same problem and its own repair
  // (a live per-rig anchor is not optional — the binder writes into it every
  // frame), so a blighted source is re-cloned through that instead.
  const m = source.userData.charBlight ? cloneCharacterBlightMaterial(source) : source.clone();
  delete m.userData.dissolveUniforms;
  applyDissolve(m);
  return m;
}

function releaseVariant(source, variant) {
  const free = _pool.get(source);
  if (free) free.push(variant);
}

/** Point a pooled variant's uniforms at this particular corpse. */
function retune(variant, o) {
  const u = variant.userData.dissolveUniforms;
  u.uDissolve.value = 0;
  u.uDissolveEdge.value = o.edge ?? DissolveDefaults.edge;
  u.uDissolveScale.value = o.scale ?? DissolveDefaults.scale;
  u.uDissolveEdgeIntensity.value = o.edgeIntensity ?? DissolveDefaults.edgeIntensity;
  u.uDissolveColor.value.set(o.color ?? DissolveDefaults.color);
  u.uDissolveBounds.value.set(o.minY ?? 0, o.maxY ?? 2);
  return u;
}

/**
 * Swaps a mesh's material tree for pooled dissolve variants, so the dying
 * instance never mutates a material shared with living enemies.
 *
 * Returns a handle: drive `bags[*].uDissolve.value` 0..1, then call `release()`
 * to put the variants back and restore the originals.
 */
export function makeDissolvable(mesh, opts = {}) {
  const bags = [];
  const restore = [];
  mesh.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    if (Array.isArray(child.material)) {
      const src = child.material;
      const swapped = src.map((m) => acquireVariant(m));
      for (const v of swapped) bags.push(retune(v, opts));
      restore.push({ child, src, swapped });
      child.material = swapped;
    } else {
      const src = child.material;
      const swapped = acquireVariant(src);
      bags.push(retune(swapped, opts));
      restore.push({ child, src, swapped });
      child.material = swapped;
    }
  });
  return {
    bags,
    release() {
      for (const r of restore) {
        // Only give the material back if nothing else has re-dressed the mesh
        // in the meantime (a pooled rig respawning mid-dissolve).
        if (r.child.material === r.swapped) r.child.material = r.src;
        if (Array.isArray(r.src)) {
          for (let i = 0; i < r.src.length; i++) releaseVariant(r.src[i], r.swapped[i]);
        } else {
          releaseVariant(r.src, r.swapped);
        }
      }
      restore.length = 0;
      bags.length = 0;
    },
  };
}
