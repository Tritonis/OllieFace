/**
 * The photographed-surface evaluation set (#109 step 3).
 *
 * Three downloaded PBR sets are bound over the procedural material library so
 * the two can be compared in one boot: worn rock on the stone classes,
 * corrugated iron on the ruin metal, and a cracked riverbed's relief on the
 * corruption overlay. Nothing here is on by default and nothing here is
 * fetched until it is: `?pbr=1` at boot, or `__HARNESS__.setPbr(true)` at
 * runtime, is the only thing that reaches the network. Flag-off the game
 * builds exactly the textures it built yesterday.
 *
 * The files live in `assets-staging/`, which is gitignored — no binary enters
 * the tree until #26 closes and a pack is actually chosen. That is also why
 * this module is a *swap over* the library rather than a replacement of it:
 * delete the directory and the game still runs, it simply refuses the flag.
 *
 * What is deliberately NOT bound:
 *
 *  - **Albedo on the overlay.** The corruption owns its colour: the void tint
 *    mixes into `diffuseColor` inside BlightMask, and a photographed mud
 *    albedo underneath it would be a second palette arguing with the first.
 *    The set was downloaded without a diff map for exactly this reason.
 *  - **Displacement, everywhere.** `displacementMap` is a vertex-stage
 *    operation and every surface it would land on here is tessellated for its
 *    silhouette, not for relief: terrain is a heightfield sampled at metres,
 *    props are hand-built boxes of eight vertices. Displacing eight vertices
 *    by a 4K height field is not relief, it is a random rigid offset. The disp
 *    PNGs are downloaded and unused, and step 4 (parallax/POM, or a
 *    tessellated near plate) is where they get their hearing.
 *
 * The incoming albedo maps do NOT bypass the palette: they arrive as
 * `map` under the material's existing `color` tint, which is the same
 * multiply the procedural set has always been read through, so
 * docs/ART-STYLE-GUIDE.md's palette rule still governs the result.
 */
import * as THREE from 'three';
import { getMaterials } from './Materials.js';
import { setOverlayMaps } from '../shaders/BlightMask.js';

const ROOT = 'assets-staging';

export const SETS = {
  rock: {
    dir: `${ROOT}/terrain/worn_rock_natural_01`,
    stem: 'worn_rock_natural_01',
    maps: { map: 'diff', normalMap: 'nor_gl', roughnessMap: 'rough', aoMap: 'ao' },
  },
  metal: {
    dir: `${ROOT}/props/corrugated_iron_03`,
    stem: 'corrugated_iron_03',
    maps: { map: 'diff', normalMap: 'nor_gl', roughnessMap: 'rough', aoMap: 'ao' },
  },
  overlay: {
    dir: `${ROOT}/overlay/mud_cracked_dry_riverbed_002`,
    stem: 'mud_cracked_dry_riverbed_002',
    maps: { normalMap: 'nor_gl', roughnessMap: 'rough', aoMap: 'ao' },
  },
};

/** Which library material takes which photographed set. */
export const ASSIGNMENT = {
  terrain: 'rock', rock: 'rock', cliff: 'rock', wetStone: 'rock',
  metalRuin: 'metal',
};

let _loaded = null;   // Promise<{rock,metal,overlay}> — the one fetch, ever.
let _on = false;

export function isPbrOn() { return _on; }

function loadSets() {
  if (_loaded) return _loaded;
  const loader = new THREE.TextureLoader();
  const one = (url, srgb) => new Promise((res, rej) => {
    loader.load(url, (t) => {
      // `map` is colour and must be decoded; normal/roughness/AO are data and
      // must not be, or the roughness ladder shifts under a gamma curve.
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      res(t);
    }, undefined, rej);
  });
  _loaded = (async () => {
    const out = {};
    for (const [name, spec] of Object.entries(SETS)) {
      const set = {};
      await Promise.all(Object.entries(spec.maps).map(async ([slot, kind]) => {
        const ext = kind === 'disp' ? 'png' : 'jpg';
        set[slot] = await one(`${spec.dir}/${spec.stem}_${kind}_4k.${ext}`, slot === 'map');
      }));
      out[name] = set;
    }
    return out;
  })();
  return _loaded;
}

/**
 * Swap one material's maps, preserving the tiling the procedural set was
 * authored at. `withRepeat` in Materials.js is the central tiling scalar and
 * it has already run — the repeat living on the material's current map is the
 * per-class world scale, so the photographed texture inherits it rather than
 * arriving at 1:1 and reading as a different-sized world.
 */
function swap(mat, set) {
  if (!mat) return;
  if (!mat.userData.pbrOrig) {
    mat.userData.pbrOrig = {
      map: mat.map, normalMap: mat.normalMap,
      roughnessMap: mat.roughnessMap, aoMap: mat.aoMap,
      aoMapIntensity: mat.aoMapIntensity,
    };
  }
  const rep = mat.userData.pbrOrig.normalMap?.repeat
           ?? mat.userData.pbrOrig.map?.repeat;
  for (const [slot, tex] of Object.entries(set)) {
    const t = tex.clone();
    if (rep) t.repeat.copy(rep);
    t.needsUpdate = true;
    mat[slot] = t;
  }
  // AO reads uv1 in three r15x. The world meshes carry one UV channel, so
  // three falls back to `uv` — which is what we want here (the AO is the same
  // projection as the albedo) but it means aoMapIntensity has to stay modest
  // or the cavity double-counts against the metre-scale detail pass's own.
  if (set.aoMap) mat.aoMapIntensity = 0.6;
  mat.needsUpdate = true;
}

function restore(mat) {
  const o = mat?.userData?.pbrOrig;
  if (!o) return;
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
    if (mat[slot] && mat[slot] !== o[slot]) mat[slot].dispose();
    mat[slot] = o[slot];
  }
  mat.aoMapIntensity = o.aoMapIntensity;
  mat.needsUpdate = true;
}

/**
 * Turn the evaluation set on or off in a live session. Returns when the swap
 * is actually on the materials, so a capture harness can await it and shoot
 * the next frame.
 *
 * The A/B is deliberately a *material* swap and not a uniform: uniforms on
 * these materials are rewritten every frame by the detail and blight update
 * paths, and a toggle that lives in one of them is silently undone before the
 * next present.
 */
export async function setPbr(on) {
  const want = !!on;
  const mats = getMaterials();
  if (want) {
    const sets = await loadSets();
    for (const [key, which] of Object.entries(ASSIGNMENT)) swap(mats[key], sets[which]);
    setOverlayMaps(sets.overlay);
  } else {
    for (const key of Object.keys(ASSIGNMENT)) restore(mats[key]);
    setOverlayMaps(null);
  }
  _on = want;
  return want;
}

/**
 * Hang the swap off the capture harness, the way `RealmHarness` does.
 *
 * It is installed from here rather than written into `core/Harness.js` because
 * `src/core/` may not import `src/world/` — the layering rule the architecture
 * test enforces — and this seam is world state that the harness merely drives.
 *
 * Cross-boot capture numbers do not compare in this repo (the shutter phase
 * drifts and the gated statistic is boot-unstable, #122), so the only
 * admissible comparison is two shutters in one session. This awaits the fetch
 * on the first `true`, so a caller may shoot the very next frame.
 */
export function installPbrHarness(ctx) {
  const H = globalThis.__HARNESS__;
  if (!H) return;
  H.setPbr = async (on) => {
    const v = await setPbr(on);
    await ctx.audio?.setPbrRumble?.(v);
    return v;
  };
  H.pbr = () => _on;
}
