// tests/blight-mask.test.mjs
import * as THREE from 'three';
import { MAX_MASK, MASK_UNIFORMS, attachBlightMask, patchedCount } from '../src/shaders/BlightMask.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('shared uniform contract');
{
  ok(MAX_MASK === 8, 'eight patch slots');
  ok(MASK_UNIFORMS.uBlightPatches.value.length === MAX_MASK * 4, 'flat vec4 array sized to MAX_MASK');
  ok(MASK_UNIFORMS.uBlightCount.value === 0, 'count starts at zero');
  ok(typeof MASK_UNIFORMS.uBlightTime.value === 'number', 'time uniform is scalar');
  ok(typeof MASK_UNIFORMS.uBlightBand.value === 'number', 'band uniform is scalar');
}

console.log('attach injects into a standard-material shader and chains');
{
  const mat = new THREE.MeshStandardMaterial();
  let prevRan = false;
  mat.onBeforeCompile = () => { prevRan = true; };
  attachBlightMask(mat);
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <emissivemap_fragment>\n}',
  };
  mat.onBeforeCompile(shader, null);
  ok(prevRan, 'pre-existing onBeforeCompile still runs');
  ok(shader.uniforms.uBlightPatches === MASK_UNIFORMS.uBlightPatches, 'program shares the singleton uniform objects');
  ok(shader.vertexShader.includes('vBlightWorld'), 'vertex carries the world-position varying');
  ok(shader.vertexShader.includes('USE_INSTANCING'), 'instanced props resolve their own world position');
  ok(shader.fragmentShader.includes('blightMask('), 'fragment declares the mask function');
  ok(shader.fragmentShader.indexOf('blightMask(') < shader.fragmentShader.indexOf('diffuseColor.rgb = mix'), 'decl precedes use');
  ok(shader.fragmentShader.includes('uBlightCount > 0'), 'zero-patch frames skip the whole block');
  ok(mat.customProgramCacheKey().includes('blightmask'), 'program cache key forks for patched materials');

  // Idempotent: a second attach would redeclare vBlightWorld (a GLSL error,
  // i.e. a black world) and double the cache-key suffix.
  attachBlightMask(mat);
  const twice = { uniforms: {}, vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
                  fragmentShader: '#include <common>\nvoid main() {\n#include <emissivemap_fragment>\n}' };
  mat.onBeforeCompile(twice, null);
  ok(twice.vertexShader.split('varying vec3 vBlightWorld;').length === 2, 'second attach does not redeclare the varying');
  ok(mat.customProgramCacheKey().split('|blightmask').length === 2, 'second attach does not double the cache key');
}

console.log('the hooks inject into three\'s real physical shader chunks');
{
  // The synthetic four-line shader above proves the .replace calls fire; it
  // cannot prove the anchors still exist in what three actually compiles, nor
  // that attachDetail's own rewrites leave them intact. Run the *shipped*
  // terrain hook — detail chained under blight — against the real ShaderLib.
  const { getMaterials } = await import('../src/world/Materials.js');
  const src = THREE.ShaderLib.physical;
  const shader = { uniforms: {}, vertexShader: src.vertexShader, fragmentShader: src.fragmentShader };
  const terrain = getMaterials().terrain;
  terrain.onBeforeCompile(shader, { capabilities: {} });
  ok(shader.vertexShader.includes('varying vec3 vBlightWorld;'), 'real vertex chunk carries the varying');
  ok(shader.vertexShader.includes('vBlightWorld = (modelMatrix * bwp).xyz;'), 'real vertex chunk assigns the world position');
  ok(shader.fragmentShader.includes('float blightMask(vec3 wp)'), 'real fragment chunk declares the mask');
  ok(shader.fragmentShader.includes('diffuseColor.rgb = mix(diffuseColor.rgb, BM_TINT'), 'real fragment chunk applies the mask');
  ok(shader.fragmentShader.indexOf('float blightMask(vec3 wp)') < shader.fragmentShader.indexOf('diffuseColor.rgb = mix(diffuseColor.rgb, BM_TINT'),
     'decl precedes use in the real chunk');
  // The chain: detail ran too, on the same shader, and neither hook ate the
  // other's anchor. This is the assertion that bites if three renames a chunk.
  ok(shader.vertexShader.includes('vDetW'), 'attachDetail survived underneath the blight hook');
  ok(shader.fragmentShader.includes('uDetNoise'), 'detail fragment pass survived too');
}

console.log('the whole material library is patched');
{
  const { getMaterials } = await import('../src/world/Materials.js');
  const mats = getMaterials();
  const names = ['terrain', 'rock', 'cliff', 'moss', 'wetStone', 'metalRuin', 'sand', 'wood', 'crystal'];
  for (const n of names) {
    ok(typeof mats[n]?.customProgramCacheKey === 'function'
       && mats[n].customProgramCacheKey().includes('blightmask'), `${n} carries the mask`);
  }
}

console.log('the prop ladders outside the library are patched too');
{
  // Materials.js is not the only place world surfaces are built: Interactables
  // and the two realm prop sets keep parallel ladders, and a chest standing in
  // untouched ochre iron inside a violet patch is the failure this covers.
  // Emissive quads (collar glow, shop screen, rift light) stay deliberately
  // clean — their own light is their identity, not a surface to corrupt.
  const { Chest, ArgentFont, CovenantStone } = await import('../src/world/Interactables.js');
  const { VaultChest, Obelisk } = await import('../src/world/realms/RealmProps.js');
  const ctx = {
    events: { on() {}, emit() {} }, scene: new THREE.Scene(),
    rng: { next: () => 0.5, range: (a, b) => (a + b) / 2, int: (a) => a, pick: (a) => a[0] },
    corruption: { world: 0, feed() {} },
  };
  const pos = new THREE.Vector3();
  const count = (group) => {
    let masked = 0;
    group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (m?.userData?.blightMask) masked++;
      }
    });
    return masked;
  };
  for (const [n, C] of [['Chest', Chest], ['ArgentFont', ArgentFont], ['CovenantStone', CovenantStone],
                        ['VaultChest', VaultChest], ['Obelisk', Obelisk]]) {
    ok(count(new C(ctx, pos).group) > 0, `${n}'s substrate takes the mask`);
  }
}

// #137: realm rungs allocate their own materials per visit and dispose them
// (RealmArena.js:29, RealmProps.js:100). Before the release path existed the
// patch registry kept every one of them alive forever, and post-#109 each pins
// 4K maps. A disposed material must leave the registry.
console.log('a disposed material leaves the patch registry');
{
  const before = patchedCount();
  const mats = [];
  for (let i = 0; i < 5; i++) mats.push(attachBlightMask(new THREE.MeshStandardMaterial()));
  ok(patchedCount() === before + 5, 'five throwaway rungs register while alive');
  for (const m of mats) m.dispose();
  ok(patchedCount() === before, 'all five are released on dispose');

  const visit = () => {
    const v = [];
    for (let i = 0; i < 4; i++) v.push(attachBlightMask(new THREE.MeshStandardMaterial()));
    for (const m of v) m.dispose();
  };
  visit();
  const afterFirst = patchedCount();
  visit();
  ok(patchedCount() === afterFirst, 'registry does not grow across repeated visits');

  // The registry emptying is not the whole of the leak. three keeps a
  // material's listener array for the life of the material, so a `dispose`
  // handler that never unhooks leaves a dead closure behind after it fires and
  // stacks a fresh one every time the same material is patched again. The
  // handler must remove itself.
  const m = attachBlightMask(new THREE.MeshStandardMaterial());
  const listeners = () => (m._listeners?.dispose || []).length;
  ok(listeners() === 1, `one dispose listener while patched (${listeners()})`);
  m.dispose();
  ok(listeners() === 0, `and none once it has fired (${listeners()})`);
  // A second dispose, and a re-patch of the same material, must not accumulate.
  m.dispose();
  for (let i = 0; i < 3; i++) { attachBlightMask(m); m.dispose(); }
  ok(listeners() === 0, `no accumulation across re-patch and double dispose (${listeners()})`);
  ok(patchedCount() === afterFirst, 'and the registry is still clean');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
