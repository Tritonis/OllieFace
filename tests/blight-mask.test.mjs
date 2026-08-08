// tests/blight-mask.test.mjs
import * as THREE from 'three';
import { MAX_MASK, MASK_UNIFORMS, attachBlightMask } from '../src/shaders/BlightMask.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
