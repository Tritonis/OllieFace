// tests/model-kit.test.mjs
//
// The import seam for externally-authored meshes (#59). Everything below runs
// without a browser, a GPU or a network: the loader half is one thin wrapper
// around GLTFLoader, and every decision worth pinning lives in the binding half,
// which takes a plain BufferGeometry.
import * as THREE from 'three';
import { PALETTE } from '../src/world/Materials.js';
import {
  KIT_SURFACES, atlasCell, surveyKitGeometry, classifyKitGeometry, groupBySurface,
  bindKitScene, kitMaterial,
} from '../src/world/ModelKit.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const throws = (fn, re, msg) => {
  try { fn(); ok(false, msg + ' (did not throw)'); } catch (e) { ok(re.test(e.message), `${msg} — ${e.message}`); }
};

/**
 * A stand-in for a palette-atlas model: six triangles, three of them pointing
 * at atlas cell (1,0) and three at (4,0), which is exactly the shape KayKit's
 * `chest.glb` has (one glTF material, two swatch columns, 728 faces).
 */
function atlasGeometry(cellsPerFace) {
  const n = cellsPerFace.length;
  const pos = new Float32Array(n * 9);
  const uv = new Float32Array(n * 6);
  const tan = new Float32Array(n * 12);
  for (let f = 0; f < n; f++) {
    const [cx, cy] = cellsPerFace[f];
    // Centre of the cell in an 8x4 grid, so no corner sample can drift out of it.
    const u = (cx + 0.5) / 8, v = (cy + 0.5) / 4;
    for (let k = 0; k < 3; k++) {
      pos[f * 9 + k * 3] = f + k; pos[f * 9 + k * 3 + 1] = 0; pos[f * 9 + k * 3 + 2] = k;
      uv[f * 6 + k * 2] = u; uv[f * 6 + k * 2 + 1] = v;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex([...Array(n * 3).keys()]);
  g.computeVertexNormals();
  return g;
}

const CHEST_CELLS = [[1, 0], [1, 0], [1, 0], [4, 0], [4, 0], [1, 0]];
const MANIFEST = {
  route: 'atlas',
  atlas: { cols: 8, rows: 4, cells: { '1,0': 'kitIron', '4,0': 'kitWood' } },
};

console.log('atlas cell addressing');
{
  ok(atlasCell(0.0, 0.0, 8, 4) === '0,0', 'origin is the top-left cell');
  // glTF UV origin is top-left and GLTFLoader sets flipY=false to match, so v
  // indexes rows downward with no flip. Reading this backwards is silent: it
  // reports plausible cells from the wrong end of the atlas, which is how the
  // KayKit chest first surveyed as a greyscale model when it is a brown one.
  ok(atlasCell(0.19, 0.10, 8, 4) === '1,0', 'v is not flipped: v 0.10 is row 0, not row 3');
  ok(atlasCell(0.19, 0.90, 8, 4) === '1,3', 'v 0.90 is the bottom row');
  ok(atlasCell(0.55, 0.20, 8, 4) === '4,0', 'the chest timber column is (4,0)');
  ok(atlasCell(1.0, 1.0, 8, 4) === '7,3', 'a coordinate exactly on the far edge clamps inside the grid');
  ok(atlasCell(-0.2, -5, 8, 4) === '0,0', 'coordinates below the atlas clamp rather than index negatively');
}

console.log('the survey an author writes a manifest from');
{
  const survey = surveyKitGeometry(atlasGeometry(CHEST_CELLS), { cols: 8, rows: 4 });
  ok(survey.length === 2, 'two distinct cells found');
  ok(survey[0][0] === '1,0' && survey[0][1] === 4, 'sorted by face count, biggest first');
  ok(survey[1][0] === '4,0' && survey[1][1] === 2, 'second cell carries the rest');
  ok(survey.reduce((a, s) => a + s[1], 0) === CHEST_CELLS.length, 'every face is accounted for');
}

console.log('an unmapped swatch is a rejection, not a default colour');
{
  const geo = atlasGeometry([...CHEST_CELLS, [6, 2]]);
  throws(() => classifyKitGeometry(geo, MANIFEST.atlas), /6,2 \(1 faces\)/,
    'the throw names the missing cell and how many faces sit on it');
  // Rule 1 is "name which PALETTE entry each colour maps to". A fallback colour
  // would satisfy the loader and fail the rule, silently, for every model.
  throws(() => classifyKitGeometry(geo, MANIFEST.atlas), /no PALETTE mapping/,
    'and says why it is a rejection');
}

console.log('faces are sorted into contiguous groups by surface');
{
  const geo = atlasGeometry(CHEST_CELLS);
  const before = [...geo.getIndex().array];
  const order = groupBySurface(geo, classifyKitGeometry(geo, MANIFEST.atlas));
  ok(order.length === 2 && order[0] === 'kitIron' && order[1] === 'kitWood',
    'group order is first-seen surface order');
  ok(geo.groups.length === 2, 'one group per surface');
  ok(geo.groups[0].start === 0 && geo.groups[0].count === 12, 'iron group covers its four faces');
  ok(geo.groups[1].start === 12 && geo.groups[1].count === 6, 'timber group covers the other two');
  ok(geo.groups.reduce((a, g) => a + g.count, 0) === before.length,
    'the groups together cover every index, so no face is dropped');
  const after = [...geo.getIndex().array];
  ok(after.length === before.length && [...after].sort((a, b) => a - b).join() === [...before].sort((a, b) => a - b).join(),
    'reordering is a permutation: the same vertices, no additions or losses');
  // Triangles must move as units, or the mesh is shredded rather than sorted.
  const tri = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]].join();
  const beforeTris = new Set([...Array(6).keys()].map((i) => tri(before, i)));
  ok([...Array(6).keys()].every((i) => beforeTris.has(tri(after, i))),
    'every triangle survives intact, only its position in the buffer changed');
}

console.log('the kit ladder is PALETTE verbatim and goes through the world seam');
{
  for (const [name, s] of Object.entries(KIT_SURFACES)) {
    const flat = { ...PALETTE.terrain, ...PALETTE.accent };
    ok(Object.values(flat).includes(s.color),
      `${name} colour 0x${s.color.toString(16)} is a PALETTE entry verbatim`);
  }
  const m = kitMaterial('kitIron');
  ok(m.color.getHex() === PALETTE.accent.metal, 'kitIron carries PALETTE.accent.metal');
  // attachWorldSurface = attachDetail + attachBlightMask. Both must be on, and
  // both are world-space samplers, which is the whole reason an atlas-UV mesh
  // can take them at all.
  ok(m.userData.det != null, 'the metre-scale detail pass is attached');
  ok(m.userData.detKind === 'ironPart', 'at the interactable-scale rung, not the terrain one');
  ok(/blightmask/.test(m.customProgramCacheKey()), 'the corruption mask is attached');
  // The premise of the seam: no UV-space map is bound, because the mesh's UVs
  // are atlas lookups and a repeating texture on them is garbage.
  ok(!m.map && !m.normalMap && !m.roughnessMap && !m.aoMap,
    'no UV-space map is bound to a kit surface');
  ok(kitMaterial('kitIron') === m, 'materials are shared, not rebuilt per mesh');
  throws(() => kitMaterial('kitPlastic'), /unknown kit surface/, 'an unknown surface is a throw');
}

console.log('binding a whole loaded scene');
{
  const root = new THREE.Group();
  const a = new THREE.Mesh(atlasGeometry(CHEST_CELLS));
  a.name = 'chest';
  const b = new THREE.Mesh(atlasGeometry([[1, 0], [1, 0]]));
  b.name = 'chest_lid';
  root.add(a, b);
  const uvBytes = a.geometry.attributes.uv.array.byteLength
    + a.geometry.attributes.tangent.array.byteLength
    + b.geometry.attributes.uv.array.byteLength
    + b.geometry.attributes.tangent.array.byteLength;

  const report = bindKitScene(root, MANIFEST);
  ok(report.meshes.length === 2, 'every mesh in the scene is bound');
  ok(Array.isArray(a.material) && a.material.length === 2, 'a two-swatch mesh gets two materials');
  ok(a.material[0].name === 'kitIron' && a.material[1].name === 'kitWood', 'in group order');
  ok(!Array.isArray(b.material) || b.material.length === 1, 'a one-swatch mesh gets one');
  ok(a.material[0] === b.material[0], 'both meshes share the one iron material');
  ok(report.faces === 8 && report.surfaces.join() === 'kitIron,kitWood', 'the report totals the scene');
  ok(a.castShadow && a.receiveShadow, 'imported meshes cast and receive like every other prop');
  // uv/tangent are pure payload once the faces are classified: no kit material
  // samples them. Dropping them is the only asset-size win this seam has.
  ok(!a.geometry.attributes.uv && !a.geometry.attributes.tangent, 'uv and tangent are dropped');
  ok(report.attributeBytesDropped === uvBytes, `report names the bytes dropped (${uvBytes})`);

  const kept = new THREE.Group();
  kept.add(new THREE.Mesh(atlasGeometry(CHEST_CELLS)));
  bindKitScene(kept, { ...MANIFEST, keepUV: true });
  ok(kept.children[0].geometry.attributes.uv != null, 'keepUV holds them for a model that will be re-UVed');
}

console.log('routes');
{
  const root = new THREE.Group();
  const m = new THREE.Mesh(atlasGeometry([[0, 0]]));
  m.userData.kitSlot = 'texture';
  root.add(m);
  bindKitScene(root, { route: 'slots', slots: { texture: 'kitStone' } });
  ok(m.material.name === 'kitStone', 'the slots route binds by authored material name');

  const bad = new THREE.Group();
  const m2 = new THREE.Mesh(atlasGeometry([[0, 0]]));
  m2.userData.kitSlot = 'Wood.001';
  bad.add(m2);
  throws(() => bindKitScene(bad, { route: 'slots', slots: {} }), /Wood\.001/,
    'an unmapped slot names itself');
  throws(() => bindKitScene(new THREE.Group(), { route: 'tiled' }), /unknown route/,
    'there is no tiling route yet, and asking for one says so');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
