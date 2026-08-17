// tests/character-blight.test.mjs
//
// The figure-space corruption pass. The readability gate cannot see any of
// this — tools/silhouette.mjs renders every entity through a flat-black
// scene.overrideMaterial (:95, :224), so its IoU numbers are structurally
// blind to a tint. These assertions are therefore written against the shader
// three actually compiles, and they assert CONSUMPTION (the coverage value
// reaching the diffuse write, the object-space varying reaching the field)
// rather than mere attachment.
import * as THREE from 'three';
import { MASK_UNIFORMS } from '../src/shaders/BlightMask.js';
import { attachCharacterBlight } from '../src/shaders/CharacterBlight.js';
import { makeCharacterMats } from '../src/entities/CharacterMesh.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const compile = (material) => {
  const src = THREE.ShaderLib.physical;
  const shader = { uniforms: {}, vertexShader: src.vertexShader, fragmentShader: src.fragmentShader };
  material.onBeforeCompile(shader, { capabilities: {} });
  return shader;
};

console.log('the pass chains rather than clobbers');
{
  const mat = new THREE.MeshStandardMaterial();
  let prevRan = false;
  mat.onBeforeCompile = () => { prevRan = true; };
  mat.customProgramCacheKey = () => 'prior';
  attachCharacterBlight(mat);
  const shader = compile(mat);
  ok(prevRan, 'a pre-existing onBeforeCompile still runs');
  ok(mat.customProgramCacheKey() === 'prior|charblight', 'a pre-existing cache key is preserved and forked');

  attachCharacterBlight(mat);
  const twice = compile(mat);
  ok(twice.vertexShader.split('varying float vCbCover;').length === 2, 'second attach does not redeclare the varying');
  ok(mat.customProgramCacheKey().split('|charblight').length === 2, 'second attach does not double the cache key');
}

console.log('the corruption value reaches the program');
{
  const mat = attachCharacterBlight(new THREE.MeshStandardMaterial());
  const shader = compile(mat);
  ok(shader.uniforms.uBlightPatches === MASK_UNIFORMS.uBlightPatches,
     'the program shares Blight.js\'s singleton uniform objects by reference');
  const before = MASK_UNIFORMS.uBlightCount.value;
  MASK_UNIFORMS.uBlightCount.value = 3;
  ok(shader.uniforms.uBlightCount.value === 3, 'a write by the blight system is visible to a character program');
  MASK_UNIFORMS.uBlightCount.value = before;
}

console.log('coverage and the object-space field are CONSUMED, not merely declared');
{
  const shader = compile(attachCharacterBlight(new THREE.MeshStandardMaterial()));
  const v = shader.vertexShader, f = shader.fragmentShader;

  // Coverage: computed from the world position of the vertex, and it must
  // actually gate both the diffuse claim and the vein.
  ok(/vCbCover\s*=\s*blightMask\(/.test(v), 'coverage is the blight field evaluated in the vertex shader');
  ok(/modelMatrix \* cbw/.test(v), 'coverage is evaluated at the WORLD position (patches live in world space)');
  const diffuse = f.match(/diffuseColor\.rgb = mix\(diffuseColor\.rgb, CB_TINT[^;]*;/)?.[0] ?? '';
  ok(diffuse.includes('vCbCover'), 'the diffuse claim is scaled by coverage — outside a patch the write is a no-op');
  const vein = f.match(/totalEmissiveRadiance \+= CB_VEIN[^;]*;/)?.[0] ?? '';
  ok(/cbVein/.test(vein) && /vCbCover/.test(f.match(/float cbVein = [^;]*;/)?.[0] ?? ''),
     'the vein emissive is scaled by coverage too');

  // The whole point of this pass: the pattern is sampled in OBJECT space, so a
  // walking figure carries its corruption instead of swimming through it.
  ok(/vCbObj\s*=\s*transformed;/.test(v), 'the field varying is object-space `transformed`, taken before modelMatrix');
  ok(!/vCbObj\s*=\s*\(?\s*modelMatrix/.test(v), 'the field varying is never built from a world position');
  const field = f.match(/float cbF = bmTri\([^;]*;/)?.[0] ?? '';
  ok(field.includes('vCbObj'), 'the noise field is sampled from the object-space varying');
  ok(/vec2 cbP = vCbObj\.xz;/.test(f), 'the domain warp is object-space too — a world-space warp reintroduces the swim');

  // Silhouette safety: no vertex displacement, and no write outside the surface.
  ok(!/transformed\s*[+\-*]=/.test(v.slice(v.indexOf('vCbObj'))), 'the pass never displaces geometry');

  // Derivative correctness: dFdx/dFdy must sit above the interpolated-coverage
  // branch, or they are derivatives in non-uniform control flow.
  ok(f.indexOf('dFdx(vCbObj)') < f.indexOf('if (vCbCover > 0.001)'),
     'derivatives are taken above the non-uniform coverage branch');
}

console.log('every survivor material carries the pass, under the rim hook');
{
  const set = makeCharacterMats();
  const names = Object.keys(set);
  ok(names.length >= 8, `the survivor set has ${names.length} materials`);
  const missing = names.filter((n) => !set[n]?.userData?.charBlight);
  ok(missing.length === 0, `every survivor material takes the pass (missing: ${missing.join(', ') || 'none'})`);

  // Both hooks inject at <emissivemap_fragment>; this is the assertion that
  // bites if one ever eats the other's anchor.
  const shader = compile(set.coat);
  ok(shader.fragmentShader.includes('uRimStrength'), 'the rim/hemi hook survived underneath');
  ok(shader.fragmentShader.includes('diffuseColor.rgb *= mix(1.0 - uHemi'), 'the hemi tilt survived too');
  ok(shader.fragmentShader.includes('CB_TINT'), 'and the corruption pass applied');
  ok(shader.fragmentShader.indexOf('float bmTri(') < shader.fragmentShader.indexOf('bmTri(vCbObj'),
     'decl precedes use in the real chunk');
}

console.log('all four enemy materials carry the pass, on a real rig');
{
  const { acquireRig, ENEMY_IDS } = await import('../src/entities/EnemyMeshes.js');
  const rig = acquireRig(ENEMY_IDS[0]);
  const mats = rig.mats ?? {};
  for (const k of ['body', 'dark', 'accent', 'eye']) {
    ok(mats[k]?.userData?.charBlight === true, `enemy ${k} material takes the pass`);
  }
  const shader = compile(mats.body);
  ok(shader.fragmentShader.includes('uRimStrength') && shader.fragmentShader.includes('CB_TINT'),
     'an enemy body compiles with both hooks present');
}

console.log('the rig-footprint number the pass reasons from is real');
{
  // CharacterBlight.js's header justifies per-vertex world coverage with a
  // measured footprint range. An earlier draft asserted "~0.6 m across" from no
  // measurement at all and was wrong by up to 2.4x, so the number now lives
  // here, where it fails loudly if a body kit changes it. It is deliberately
  // NOT a "this is safe" assertion — the comment states the opposite, that the
  // coverage band can be narrower than the figure (issue #101).
  const { CharacterMesh } = await import('../src/entities/CharacterMesh.js');
  const { RADIUS } = await import('../src/systems/Blight.js');
  let lo = Infinity, hi = 0;
  for (const key of ['ranger', 'anvil', 'kestrel', 'rook', 'cinder']) {
    const rig = new CharacterMesh(key);
    rig.group.updateMatrixWorld(true);
    const s = new THREE.Box3().setFromObject(rig.group).getSize(new THREE.Vector3());
    lo = Math.min(lo, s.x, s.z); hi = Math.max(hi, s.x, s.z);
  }
  ok(lo >= 0.75 && hi <= 1.60, `survivor XZ footprints span ${lo.toFixed(2)}-${hi.toFixed(2)} m (header says 0.82-1.49)`);
  // The band `blightMask` feathers over at the smallest patch: edge -> 0.72*edge.
  const band = RADIUS.base * (1 - 0.72);
  ok(band < hi, `the coverage band at the smallest patch (${band.toFixed(2)} m) is NARROWER than the widest rig — the split the header warns about is real`);
}

console.log('world surfaces keep the world pass and never take both');
{
  const { getMaterials } = await import('../src/world/Materials.js');
  const terrain = getMaterials().terrain;
  attachCharacterBlight(terrain);
  ok(!terrain.userData.charBlight, 'a material already carrying the world mask refuses the character pass');
  ok(!terrain.customProgramCacheKey().includes('charblight'), 'and its cache key is untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
