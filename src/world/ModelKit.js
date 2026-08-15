import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, attachWorldSurface } from './Materials.js';

/**
 * The import seam for externally-authored meshes (issue #59).
 *
 * Everything visible in this game is hand-built geometry — `Props.js`,
 * `EnemyMeshes.js`, `CharacterMesh.js` — and until this file there was no path
 * by which a mesh authored somewhere else could reach the screen at all. This
 * is that path, and it is deliberately narrow: geometry comes in, the authored
 * material never does.
 *
 * ## Why a plain glTF load is the wrong shape
 *
 * Style-guide rule 3 says incoming assets never ship their materials: every
 * world surface is built by `Materials.js` and passed through
 * `attachWorldSurface`, which pulls maps from the shared procedural texture
 * sets via `getTextureSets()` / `withRepeat`. The obvious import — load the
 * glTF, keep the geometry, bind one of those textured materials — produces
 * garbage, and the reason is UV semantics rather than taste.
 *
 * Every CC0 kit worth having (KayKit, Quaternius, Kenney) UV-maps its models
 * into a **palette atlas**: the texture is a grid of flat-ish gradient swatches
 * and a face's UV is a *point sample* into one swatch, not a parameterisation of
 * the surface. Measured on `KayKit Dungeon Remastered`'s `chest.glb`, the whole
 * model is one glTF material named `texture`, its UVs occupy u 0.13-0.60,
 * v 0.02-0.24 of a 1024x1024 atlas, and every face lands in one of exactly two
 * cells of an 8x4 grid — cell (1,0), the blue-grey column, on 416 faces, and
 * cell (4,0), the warm brown column, on 312. Bind a repeating procedural
 * texture to coordinates like those and you get one texel smeared over a strap.
 * Re-UVing is the alternative, and it is per-model work across 200-330 models
 * per pack, which is not viable.
 *
 * ## What this file does instead
 *
 * It reads the atlas cell as what it actually is: **a per-face material index
 * the pack already carries.** A face's UV names a swatch; the manifest names
 * which `PALETTE` surface that swatch maps to; the loader sorts faces into
 * geometry groups by surface and binds one real `Materials.js` material per
 * group. The chest arrives as it was authored — an iron-banded timber chest —
 * except the iron and the timber are this game's iron and timber.
 *
 * Three consequences worth stating, because they decide what a mesh pack is
 * worth here:
 *
 *  - **No authored texture is ever fetched, decoded or uploaded.** The
 *    `KitPaletteMaterials` plugin answers glTF's `loadMaterial` hook before the
 *    parser can, so the parser never asks for a texture dependency. Rule 3 is
 *    enforced structurally rather than cleaned up afterwards, and a `.gltf`
 *    with a sidecar atlas costs zero extra requests.
 *  - **The imported mesh is not flat-shaded.** It goes through
 *    `attachWorldSurface` like every other world surface, so it gets the
 *    metre-scale triplanar detail field (relief, cavity, roughness break, tooled
 *    joints) and the corruption mask. Both are sampled in world space and
 *    neither reads the mesh's UVs, so neither cares that the UVs are atlas
 *    lookups. What is lost is the *near-field UV map* — the authored texel
 *    variation that `ART-ASSETS.md` names as the fix for axis 5's
 *    detail-starvation half. That half, and only that half, needs re-UVing.
 *  - **`uv` and `tangent` are dropped after classification** (unless
 *    `keepUV` is set). No kit material binds a UV-space map, so those two
 *    attributes are pure payload once the faces are sorted.
 *
 * ## The bookkeeping, and where it stops being free
 *
 * `surveyKitGeometry` reports the cells a model actually touches, so writing a
 * manifest for a new model is: run the survey, name each cell. An unmapped cell
 * is a **throw**, not a silent default — rule 1 requires naming which `PALETTE`
 * entry each colour maps to, and a fallback colour is exactly the bookkeeping
 * this seam exists to force.
 *
 * `ROUTES` below is the honest boundary. Route `atlas` is the one that makes a
 * palette-atlas pack usable. Route `slots` covers the simpler case of a model
 * with real, named material slots. There is no route for a mesh with genuine
 * tiling UVs yet, because no pack in `model-kits.md`'s shortlist ships one.
 */

// ---------------------------------------------------------------------------
// The kit ladder
//
// Every colour here is a `PALETTE` entry verbatim rather than a derived shade.
// That is deliberate for the first version of this seam: rule 1 permits derived
// siblings by a stated relationship, but a seam whose whole claim is "the pack
// arrives in this game's palette" should be checkable by reading one table
// against `Materials.js:23-69`, with no relationship to argue about.
//
// `kind` is the detail class, and the *Part rungs are the right ones: a kit
// prop is 0.1-1.5 m like an interactable, not 2-40 m like terrain, so it wants
// the same world feature sizes `Interactables.js` uses and not the terrain-scale
// ones. `crystal` is deliberately absent — it is the one emissive surface in the
// stage and the value cap in rule 4 belongs to the game, not to an imported prop.
// ---------------------------------------------------------------------------

export const KIT_SURFACES = {
  kitStone: {
    color: PALETTE.terrain.rock, kind: 'stonePart',
    roughness: 0.88, metalness: 0.0, envMapIntensity: 0.9, flatShading: true,
  },
  kitStoneCool: {
    color: PALETTE.terrain.cliff, kind: 'stonePart',
    roughness: 0.84, metalness: 0.0, envMapIntensity: 1.0, flatShading: true,
  },
  kitWood: {
    color: PALETTE.accent.wood, kind: 'woodPart',
    roughness: 0.80, metalness: 0.0, envMapIntensity: 0.7, flatShading: true,
  },
  kitIron: {
    color: PALETTE.accent.metal, kind: 'ironPart',
    roughness: 0.30, metalness: 0.55, envMapIntensity: 2.4, flatShading: true,
  },
  kitMoss: {
    color: PALETTE.terrain.moss, kind: 'moss',
    roughness: 0.96, metalness: 0.0, envMapIntensity: 0.5, flatShading: true,
  },
  kitSand: {
    color: PALETTE.terrain.sand, kind: 'sand',
    roughness: 0.92, metalness: 0.0, envMapIntensity: 0.8, flatShading: true,
  },
};

export const KIT_ROUTES = ['atlas', 'slots'];

const _kitMats = new Map();

/**
 * One shared material per named surface, for the same reason `Interactables.js`
 * caches its ladder: a stage may carry dozens of kit props and they are all the
 * same six substances. Stamped `userData.shared` so a stage teardown that walks
 * an imported group steps over them.
 */
export function kitMaterial(name) {
  let m = _kitMats.get(name);
  if (m) return m;
  const s = KIT_SURFACES[name];
  if (!s) {
    throw new Error(`ModelKit: unknown kit surface "${name}". Known: ${Object.keys(KIT_SURFACES).join(', ')}`);
  }
  // No map, normalMap or roughnessMap: an atlas-UV mesh cannot carry one. The
  // substance comes from the detail pass `attachWorldSurface` installs, which is
  // sampled in metres and never touches these coordinates.
  m = attachWorldSurface(new THREE.MeshStandardMaterial({
    color: s.color,
    roughness: s.roughness,
    metalness: s.metalness,
    envMapIntensity: s.envMapIntensity,
    flatShading: s.flatShading,
  }), s.kind);
  m.name = name;
  m.userData.shared = true;
  _kitMats.set(name, m);
  return m;
}

export function disposeKitMaterials() {
  for (const m of _kitMats.values()) m.dispose();
  _kitMats.clear();
}

// ---------------------------------------------------------------------------
// Atlas classification
// ---------------------------------------------------------------------------

/**
 * Which cell of a `cols` x `rows` swatch grid a coordinate lands in, as the
 * `"col,row"` key the manifest is written against.
 *
 * glTF UV origin is top-left and three's `GLTFLoader` sets `flipY = false` to
 * match, so `v` indexes rows downward with no flip. Getting that backwards is
 * silent — it reports plausible-looking cells from the wrong end of the atlas —
 * so it is asserted in `tests/model-kit.test.mjs` rather than left to a comment.
 */
export function atlasCell(u, v, cols, rows) {
  const cx = Math.min(cols - 1, Math.max(0, Math.floor(u * cols)));
  const cy = Math.min(rows - 1, Math.max(0, Math.floor(v * rows)));
  return `${cx},${cy}`;
}

function faceCount(geometry) {
  const index = geometry.getIndex();
  return (index ? index.count : geometry.attributes.position.count) / 3;
}

function faceCells(geometry, cols, rows) {
  const uv = geometry.attributes.uv;
  if (!uv) throw new Error('ModelKit: atlas route needs a uv attribute; this geometry has none');
  const index = geometry.getIndex();
  const n = faceCount(geometry);
  const out = new Array(n);
  for (let f = 0; f < n; f++) {
    let u = 0, v = 0;
    for (let k = 0; k < 3; k++) {
      const vi = index ? index.getX(f * 3 + k) : f * 3 + k;
      u += uv.getX(vi); v += uv.getY(vi);
    }
    // The centroid, not a corner: a face's three corners sit at the edges of its
    // swatch and a corner sample can fall into the neighbouring cell.
    out[f] = atlasCell(u / 3, v / 3, cols, rows);
  }
  return out;
}

/**
 * The discovery pass. Returns `[[cell, faces], ...]` sorted by face count, which
 * is what an author reads to write a manifest for a model nobody has imported
 * before. Pure: no loader, no GPU, no network.
 */
export function surveyKitGeometry(geometry, { cols, rows }) {
  const counts = new Map();
  for (const c of faceCells(geometry, cols, rows)) counts.set(c, (counts.get(c) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Per-face surface names, or a throw naming every cell the manifest is missing.
 * The throw is the point: an unnamed swatch is content whose colour maps to no
 * `PALETTE` entry, and rule 1 rejects that rather than adjusting it later.
 */
export function classifyKitGeometry(geometry, { cols, rows, cells }) {
  const found = faceCells(geometry, cols, rows);
  const missing = new Set();
  const out = new Array(found.length);
  for (let f = 0; f < found.length; f++) {
    const name = cells[found[f]];
    if (!name) { missing.add(found[f]); continue; }
    out[f] = name;
  }
  if (missing.size) {
    const survey = surveyKitGeometry(geometry, { cols, rows })
      .filter(([c]) => missing.has(c)).map(([c, n]) => `${c} (${n} faces)`).join(', ');
    throw new Error(`ModelKit: atlas cells with no PALETTE mapping: ${survey}. `
      + 'Add them to the manifest cells table, or reject the model.');
  }
  return out;
}

/**
 * Sort the index buffer so each surface's faces are contiguous, emit one
 * geometry group per surface, and return the surface names in group order — the
 * order `mesh.material` must be an array in.
 *
 * Reordering the index rather than the vertex buffers keeps every attribute and
 * every vertex exactly as authored; only the triangle order changes.
 */
export function groupBySurface(geometry, faceSurfaces) {
  const index = geometry.getIndex();
  const n = faceSurfaces.length;
  const read = index ? (i) => index.getX(i) : (i) => i;
  const order = [];
  for (const s of faceSurfaces) if (!order.includes(s)) order.push(s);
  const out = [];
  geometry.clearGroups();
  order.forEach((name, mi) => {
    const start = out.length;
    for (let f = 0; f < n; f++) {
      if (faceSurfaces[f] !== name) continue;
      out.push(read(f * 3), read(f * 3 + 1), read(f * 3 + 2));
    }
    geometry.addGroup(start, out.length - start, mi);
  });
  geometry.setIndex(out);
  return order;
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function dropUnusedAttributes(geometry) {
  let bytes = 0;
  for (const name of ['uv', 'uv1', 'uv2', 'tangent']) {
    const a = geometry.attributes[name];
    if (!a) continue;
    bytes += a.array.byteLength;
    geometry.deleteAttribute(name);
  }
  return bytes;
}

/**
 * Rebind one mesh. Returns the per-mesh report entry.
 */
function bindKitMesh(mesh, manifest) {
  const geo = mesh.geometry;
  const entry = { mesh: mesh.name, faces: faceCount(geo), route: manifest.route, surfaces: [] };

  if (manifest.route === 'slots') {
    const slot = mesh.userData.kitSlot;
    const name = manifest.slots?.[slot];
    if (!name) {
      throw new Error(`ModelKit: material slot "${slot}" has no PALETTE mapping in the manifest`);
    }
    mesh.material = kitMaterial(name);
    entry.surfaces = [name];
  } else {
    const order = groupBySurface(geo, classifyKitGeometry(geo, manifest.atlas));
    mesh.material = order.map(kitMaterial);
    entry.surfaces = order;
    entry.groups = geo.groups.map((g) => ({ surface: order[g.materialIndex], count: g.count }));
  }

  if (!manifest.keepUV) entry.attributeBytesDropped = dropUnusedAttributes(geo);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return entry;
}

/**
 * Walk a loaded glTF scene and put every mesh in it through the pipeline.
 *
 * Separated from the loader so the binding half is testable without a browser,
 * a GPU or a network: `tests/model-kit.test.mjs` builds geometry by hand and
 * calls this directly.
 */
export function bindKitScene(root, manifest) {
  if (!KIT_ROUTES.includes(manifest.route)) {
    throw new Error(`ModelKit: unknown route "${manifest.route}". Known: ${KIT_ROUTES.join(', ')}`);
  }
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const report = { route: manifest.route, meshes: meshes.map((m) => bindKitMesh(m, manifest)) };
  report.faces = report.meshes.reduce((a, m) => a + m.faces, 0);
  report.attributeBytesDropped = report.meshes.reduce((a, m) => a + (m.attributeBytesDropped || 0), 0);
  report.surfaces = [...new Set(report.meshes.flatMap((m) => m.surfaces))].sort();
  if (manifest.scale && manifest.scale !== 1) root.scale.setScalar(manifest.scale);
  return report;
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

// One inert material for every glTF material in the file. It is never rendered:
// `bindKitScene` replaces it before the group reaches a scene. Its purpose is to
// answer the parser's `loadMaterial` hook so the parser never resolves a texture
// dependency — which is how the authored atlas avoids being fetched, decoded and
// uploaded for a mesh that will not sample it.
const _placeholder = new THREE.MeshStandardMaterial({ name: 'kit-placeholder' });

class KitPaletteMaterials {
  constructor(parser) {
    this.parser = parser;
    this.name = 'TV_kit_palette_materials';
  }

  loadMaterial(materialIndex) {
    // Carried onto the mesh below, because the slots route maps by the authored
    // slot *name* and this is the only place that name is still visible.
    const authored = this.parser.json.materials?.[materialIndex]?.name ?? String(materialIndex);
    const m = _placeholder.clone();
    m.userData.kitSlot = authored;
    return Promise.resolve(m);
  }
}

let _loader = null;

export function kitLoader() {
  if (!_loader) {
    _loader = new GLTFLoader();
    _loader.register((parser) => new KitPaletteMaterials(parser));
  }
  return _loader;
}

/**
 * Load a mesh and hand back a group that is already in the pipeline.
 *
 * `manifest`:
 *   route     'atlas' | 'slots'
 *   atlas     { cols, rows, cells: { 'col,row': kitSurface } }   (route 'atlas')
 *   slots     { authoredMaterialName: kitSurface }               (route 'slots')
 *   scale     uniform scale applied to the returned group
 *   keepUV    keep the uv/tangent attributes (default: drop them)
 *
 * Returns `{ group, report }`. The report is evidence, not decoration: it names
 * every surface bound and every attribute byte dropped, which is what a payload
 * budget (#28) has to be built from.
 */
export async function loadKitModel(url, manifest) {
  const gltf = await kitLoader().loadAsync(url);
  // three copies userData from the glTF node, not from the material, so the
  // authored slot name is moved onto the mesh before the placeholder is dropped.
  gltf.scene.traverse((o) => {
    if (o.isMesh && o.material?.userData?.kitSlot) o.userData.kitSlot = o.material.userData.kitSlot;
  });
  const report = bindKitScene(gltf.scene, manifest);
  return { group: gltf.scene, report };
}
