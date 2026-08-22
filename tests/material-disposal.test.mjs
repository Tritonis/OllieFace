// tests/material-disposal.test.mjs
//
// #137. The shared material library has no production caller for its release
// path and deliberately keeps none (Materials.disposeMaterials's own comment
// says why: disposing at the stage seam buys a multi-second recompile). What
// this guards is that the function stays *correct* for the in-process callers
// that do want a clean slate - tests, probe tools - rather than quietly rotting
// into a partial release that leaves 4K uploads behind.
import * as THREE from 'three';
import { getMaterials, getTextureSets, disposeMaterials } from '../src/world/Materials.js';
import { isPbrOn } from '../src/world/PbrEval.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// Every texture the library can reach, whatever slot or stash it hides in.
function reachable(mats, sets) {
  const out = new Set();
  for (const m of Object.values(mats)) {
    for (const k of ['map', 'roughnessMap', 'normalMap', 'metalnessMap', 'aoMap',
                     'emissiveMap', 'alphaMap']) if (m[k]) out.add(m[k]);
    const orig = m.userData?.pbrOrig;
    if (orig) for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap']) if (orig[k]) out.add(orig[k]);
  }
  for (const set of Object.values(sets)) for (const t of Object.values(set)) out.add(t);
  return out;
}

console.log('disposeMaterials releases everything the library holds, once each');
{
  const mats = getMaterials();
  const sets = getTextureSets();
  const live = reachable(mats, sets);
  ok(live.size > 0, 'library holds textures to release');

  // Count three's own release event rather than trusting a call: a second
  // dispose on the same texture fires it twice, which is the double-release
  // the dedup in disposeMaterials exists to prevent.
  const hits = new Map();
  for (const t of live) t.addEventListener('dispose', () => hits.set(t, (hits.get(t) || 0) + 1));

  disposeMaterials();

  const missed = [...live].filter((t) => !hits.has(t));
  const twice = [...hits.entries()].filter(([, n]) => n > 1);
  ok(missed.length === 0, `every reachable texture disposed (missed ${missed.length})`);
  ok(twice.length === 0, `none disposed twice (double ${twice.length})`);

  // The lazy singletons reset, so the next consumer gets a live library rather
  // than materials whose GPU handles have already gone back to the driver.
  const again = getMaterials();
  ok(again !== mats, 'a fresh library is built after disposal');
  ok(again.terrain.map !== mats.terrain.map, 'and it carries fresh textures');
  disposeMaterials();
}

console.log('the aoMap and pbrOrig stash a swap leaves behind are released too');
{
  // applyPbrTextures parks the pre-swap originals in userData.pbrOrig and puts
  // clones in the slots. Before #137 the release path saw neither the stash nor
  // the aoMap slot, so a swapped library leaked both.
  const mats = getMaterials();
  const px = new Uint8Array([255, 255, 255, 255]);
  const tex = () => { const t = new THREE.DataTexture(px, 1, 1); t.needsUpdate = true; return t; };
  const clones = [];
  const target = mats.rock;
  target.userData.pbrOrig = {
    map: target.map, normalMap: target.normalMap,
    roughnessMap: target.roughnessMap, aoMap: tex(),
    aoMapIntensity: 1,
  };
  clones.push(target.userData.pbrOrig.aoMap);
  target.aoMap = tex();
  clones.push(target.aoMap);

  const hits = new Set();
  for (const t of clones) t.addEventListener('dispose', () => hits.add(t));
  disposeMaterials();
  ok(hits.size === clones.length, 'the aoMap slot and the pbrOrig stash both released');
  ok(typeof isPbrOn === 'function', 'PbrEval is the swap this covers');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
