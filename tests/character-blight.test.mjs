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
import { attachCharacterBlight, cloneCharacterBlightMaterial, characterBlightAnchor } from '../src/shaders/CharacterBlight.js';
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
  ok(/vCbCover\s*=\s*blightMask\(uCbAnchor\)/.test(v),
     'coverage is the blight field evaluated at the rig anchor, one world point per figure');
  ok(/uniform vec3 uCbAnchor;/.test(v), 'the anchor is a uniform, so every vertex of a rig reads the same one');
  ok(!/modelMatrix \* cbw/.test(v),
     'coverage is NOT rebuilt per vertex from the world position — that was the #101 split');
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

console.log('the anchor is per RIG, which no shader-text assertion can see');
{
  // The failure this guards is invisible to a compile-text check and invisible
  // to a single-rig check: with materials SHARED across the horde, every rig
  // writes the one anchor uniform and the whole horde renders with whichever
  // rig drew last. So the assertion is made against two rigs at once, in the
  // order three would draw them.
  const { acquireRig, ENEMY_IDS } = await import('../src/entities/EnemyMeshes.js');
  const id = ENEMY_IDS[0];
  const rigs = [acquireRig(id), acquireRig(id)];
  rigs[0].root.position.set(-30, 0, -30);
  rigs[1].root.position.set(40, 0, 12);

  const meshesOf = (rig) => { const out = []; rig.root.traverse((o) => { if (o.isMesh && characterBlightAnchor(o.material)) out.push(o); }); return out; };
  const wp = (m) => m.getWorldPosition(new THREE.Vector3());
  const anchorOf = (m) => characterBlightAnchor(m.material).value.clone();

  const sets = rigs.map((r) => { r.root.updateMatrixWorld(true); return meshesOf(r); });
  ok(sets[0].length > 1 && sets[1].length > 1, `both rigs expose blighted meshes (${sets[0].length}, ${sets[1].length})`);
  // Draw the horde: every mesh of rig 0, then every mesh of rig 1.
  for (const set of sets) for (const m of set) m.onBeforeRender();

  const a0 = anchorOf(sets[0][0]);
  const b0 = anchorOf(sets[1][0]);
  ok(a0.distanceTo(b0) > 1,
     `two rigs 78 m apart resolve DIFFERENT anchors (${a0.distanceTo(b0).toFixed(1)} m apart)`);
  ok(a0.distanceTo(rigs[0].root.position) < 1e-6 && b0.distanceTo(rigs[1].root.position) < 1e-6,
     'and each anchor is its own rig root, not the other rig\'s');

  // The other half: one rig is one claim. Pick the two meshes of rig 0 that sit
  // furthest apart in the world and require them to agree exactly.
  const s = sets[0];
  let far = [s[0], s[0]], d = 0;
  for (const m of s) for (const n of s) { const e = wp(m).distanceTo(wp(n)); if (e > d) { d = e; far = [m, n]; } }
  ok(d > 0.3, `the two chosen surfaces are ${d.toFixed(2)} m apart on the same body`);
  ok(anchorOf(far[0]).equals(anchorOf(far[1])),
     'two surfaces far apart on ONE rig resolve the SAME anchor — no limb-by-limb split');
}

console.log('a re-cloned material is still a working one');
{
  // VFX.hitFlash clones every material on a rig and keeps the clone forever.
  // `Material.copy` JSON-flattens userData and copies no own-property hook, so
  // a bare clone arrives with the pass stripped and the anchor turned into a
  // plain {x,y,z} — which the capture run caught as a thrown frame and five
  // shots with no monsters in them.
  const src = attachCharacterBlight(new THREE.MeshStandardMaterial());
  const bare = src.clone();
  ok(characterBlightAnchor(bare) === undefined,
     'a BARE clone loses the anchor — this is the trap, asserted so it stays known');

  const good = cloneCharacterBlightMaterial(src);
  ok(good !== src && good.userData.charBlight === true, 'the re-clone carries the pass');
  ok(characterBlightAnchor(good)?.value instanceof THREE.Vector3, 'and a live anchor of its own');
  ok(characterBlightAnchor(good) !== characterBlightAnchor(src), 'which is NOT the template\'s');
  ok(good.customProgramCacheKey() === src.customProgramCacheKey(),
     'same cache key as its template, so the clones share one compiled program');
  const s = compile(good);
  ok(s.uniforms.uCbAnchor === characterBlightAnchor(good), 'and the program reads that anchor');
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
  ok(band < hi, `the coverage band at the smallest patch (${band.toFixed(2)} m) is NARROWER than the widest rig — which is why coverage cannot be per-vertex (#101)`);

  // Survivors get the same anchoring, and by a different route: their material
  // sets are already per-CharacterMesh, so only the binding in `_finish` stands
  // between them and the horde bug.
  const one = new CharacterMesh('ranger'), two = new CharacterMesh('ranger');
  one.group.position.set(-8, 0, 3); two.group.position.set(17, 0, -9);
  const firstBlighted = (c) => {
    c.group.updateMatrixWorld(true);
    let hit = null;
    c.group.traverse((o) => { if (!hit && o.isMesh && characterBlightAnchor(o.material)) hit = o; });
    hit.onBeforeRender();
    return characterBlightAnchor(hit.material).value.clone();
  };
  const pa = firstBlighted(one), pb = firstBlighted(two);
  ok(pa.distanceTo(pb) > 1, `two survivors resolve DIFFERENT anchors (${pa.distanceTo(pb).toFixed(1)} m apart)`);
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
