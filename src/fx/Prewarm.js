import * as THREE from 'three';
import {
  ENEMY_IDS, ELITE, acquireRig, releaseRig,
  makeProjectile, makeShockwave, makeTelegraph,
} from '../entities/EnemyMeshes.js';
import { makeCharacterMats } from '../entities/CharacterMesh.js';
import { applyDissolve, makeDissolvable } from '../shaders/DissolveShader.js';

/**
 * Boot-time shader prewarm.
 *
 * three compiles a program the first time a material permutation is actually
 * drawn, and a GLSL compile+link is a synchronous multi-hundred-millisecond
 * stall on the render thread. Anything that first appears mid-fight — an enemy
 * rig, an elite aura, a beam, a dissolving corpse — therefore lands as a freeze
 * at the worst possible moment.
 *
 * So we build one of every material permutation the game can produce, hand the
 * lot to `renderer.compile()` against the live scene (so the light counts,
 * shadow type and fog baked into the cache key match gameplay exactly), and
 * throw the proxies away. Rigs go back into the enemy pool rather than being
 * discarded, so this doubles as a pool warm.
 *
 * This is only worth anything if the permutation count is *stable*. The other
 * half of the fix lives in `VFX.LightPool`: a light going visible/invisible
 * changes every program's cache key, and no amount of prewarming covers that.
 */

/** Enough colours to hit every distinct `projMat` branch once. */
const PROJECTILE_COLOURS = [0xff5a12, 0x22d3ff, 0xff3566];

/** Stand-in geometry for materials harvested without one (the character set). */
const _unit = new THREE.BoxGeometry(1, 1, 1);

/** Far enough below the world that a proxy can be drawn without ever being
 *  visible. Culling is off so the draw still happens — which is the point. */
const PREWARM_Y = -10000;

const _kept = [];

export function prewarmShaders(renderer, scene, camera) {
  const cat = new THREE.Group();
  const seen = new Set();
  const rigs = [];
  const affixes = [null, ...Object.keys(ELITE)];

  // Enemy rigs: body / dark / accent / eye per palette, plus the elite aura
  // shell, the aura bits, the additive beam quads and the white flash swap.
  // The rig is re-dressed as we go, so it has to be re-collected each time.
  for (const id of ENEMY_IDS) {
    const rig = acquireRig(id);
    rigs.push(rig);
    for (const affix of affixes) {
      rig.setAffix(affix);
      collect(cat, seen, rig.root);
    }
    rig.setFlash(true);
    collect(cat, seen, rig.root);
    rig.setFlash(false);
  }

  for (const c of PROJECTILE_COLOURS) {
    collect(cat, seen, makeProjectile(c));
    collect(cat, seen, makeShockwave(c));
    collect(cat, seen, makeTelegraph(c));
  }

  // Dissolve variants: a patched clone of every rig material. `makeDissolvable`
  // pools these, so warming here also seeds the pool with its first entry.
  const handles = [];
  for (const rig of rigs) {
    const h = makeDissolvable(rig.root);
    handles.push(h);
    collect(cat, seen, rig.root);
  }

  // The character rig can dissolve too, and its double-sided cloth is a
  // permutation nothing else in the game produces. The live player already
  // warmed the plain rim programs, so only the patched ones are new — these are
  // throwaway copies, existing purely to get the program into the cache.
  // Held forever on purpose: three drops a program from its cache when the last
  // material referencing it is disposed, so the warm copies have to outlive us.
  const charMats = makeCharacterMats();
  _kept.push(charMats);
  for (const key of Object.keys(charMats)) {
    const m = charMats[key];
    applyDissolve(m);
    seen.add(m);
    const mesh = new THREE.Mesh(_unit, m);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    cat.add(mesh);
  }

  // Compiling gets the programs into the cache; actually drawing the catalogue
  // once is what uploads the vertex buffers and links the shadow-depth variants,
  // and it has to happen inside the real scene so the light setup matches.
  cat.position.y = PREWARM_Y;
  scene.add(cat);
  renderer.compile(cat, camera, scene);
  renderer.render(scene, camera);
  scene.remove(cat);

  for (const h of handles) h.release();
  for (const rig of rigs) releaseRig(rig);
  cat.clear();
}

/** Snapshot the materials currently dressed on `root` as proxy meshes. */
function collect(cat, seen, root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (seen.has(m)) continue;
      seen.add(m);
      // Keep the real geometry: the prewarm draw then also uploads every rig's
      // vertex buffers, which is the other half of the first-wave hitch.
      const mesh = new THREE.Mesh(o.geometry, m);
      mesh.castShadow = o.castShadow;
      mesh.frustumCulled = false;
      cat.add(mesh);
    }
  });
}
