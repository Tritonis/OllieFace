/**
 * The warm-time realm probe does not touch the world (#183).
 *
 *   node tests/realm-warm-probe.test.mjs
 *
 * Entering a realm used to cost ~4.7 s, and the fix is to do the expensive half
 * — the reflection-probe bake and the arena's first shader compile — while the
 * door is still being walked towards. The danger in that is obvious: the probe
 * has to be photographed under the *realm's* air, and the realm's air on the
 * world stage for even one presented frame is a visible glitch.
 *
 * So the bake is detached — its own scene, its own sky dome, its own four
 * lights — and this file is what holds that shape in place. It checks three
 * things, in the order they matter:
 *
 *  1. dressing the probe rig in realm air writes nothing whatsoever to the
 *     live one, field by field;
 *  2. the check is *capable of failing* — the same comparison run after the
 *     live rig is deliberately dressed in realm air must report a difference,
 *     which is what stops this from being a test that passes because it is
 *     looking at nothing (the characteristic failure in this repo);
 *  3. a parked arena is genuinely absent from the scene graph until `attach`,
 *     because an arena that is merely *drawable* at `REALM_ORIGIN_X` is a
 *     measured fourteen-second frame — a "fix" that traded 4.7 s for 14 s.
 */
import * as THREE from 'three';
import { Environment } from '../src/world/Environment.js';
import { BIOMES } from '../src/world/Materials.js';
import { REALM_BY_ID } from '../src/data/realms.js';
import { RealmStage } from '../src/world/realms/RealmStage.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --------------------------------------------------------------- the fixture

/**
 * An Environment with everything but the GPU.
 *
 * `_buildSky` skips the PMREM generator when there is no renderer and
 * `_bakeEnvironment` then returns immediately, so every *value* the biome
 * writes is exercised and only the photograph itself is absent — which is the
 * half that cannot contaminate anything anyway.
 */
function makeEnvironment() {
  const scene = new THREE.Scene();
  const ctx = { scene, pipeline: null };
  const env = Object.create(Environment.prototype);
  env.ctx = ctx;
  env.sunDir = new THREE.Vector3(0, 1, 0);
  env._buildSky(ctx);
  env._buildLights(scene);
  env.dustMaterial = { color: new THREE.Color(), opacity: 0 };
  const b0 = BIOMES[0];
  scene.fog = new THREE.FogExp2(0x808080, b0.fog.density);
  env.applyBiome(b0);
  return { env, scene };
}

/** Every number the world's atmosphere is made of, flattened. */
function snapshot(env, scene) {
  const out = {};
  for (const [k, u] of Object.entries(env.skyUniforms)) {
    const v = u.value;
    if (v && v.isColor) out[`sky.${k}`] = `${v.r},${v.g},${v.b}`;
    else if (v && v.isVector3) out[`sky.${k}`] = `${v.x},${v.y},${v.z}`;
    else if (typeof v === 'number') out[`sky.${k}`] = v;
  }
  for (const name of ['key', 'hemi', 'rim', 'bounce']) {
    const l = env[name];
    out[`${name}.color`] = l.color.getHex();
    out[`${name}.intensity`] = l.intensity;
    out[`${name}.position`] = `${l.position.x},${l.position.y},${l.position.z}`;
    if (l.groundColor) out[`${name}.groundColor`] = l.groundColor.getHex();
  }
  out['sunDir'] = `${env.sunDir.x},${env.sunDir.y},${env.sunDir.z}`;
  out['fog.color'] = scene.fog.color.getHex();
  out['fog.density'] = scene.fog.density;
  out['scene.environmentIntensity'] = scene.environmentIntensity;
  return out;
}

/** Which fields moved between two snapshots. */
function diff(a, b) {
  return Object.keys(a).filter((k) => a[k] !== b[k]);
}

// ------------------------------------------------- 1. the detached bake is detached

const { env, scene } = makeEnvironment();
const realmAir = REALM_BY_ID.get('crucible').air;
ok(realmAir != null, 'the crucible declares its own air');

const before = snapshot(env, scene);
const center = new THREE.Vector3(4000, 0, 0);
const rig = env._probeRigFor(realmAir, center);
const after = snapshot(env, scene);

const moved = diff(before, after);
ok(moved.length === 0, `dressing the probe rig leaves the world untouched (moved: ${moved.join(', ') || 'nothing'})`);

ok(rig.scene !== scene, 'the probe rig stands in a scene of its own');
ok(rig.key !== env.key && rig.hemi !== env.hemi && rig.rim !== env.rim && rig.bounce !== env.bounce,
  'the probe rig owns its four lights rather than borrowing the world\'s');
ok(rig.uniforms !== env.skyUniforms, 'the probe rig owns its sky uniforms');
ok(rig.key.castShadow === false,
  'the probe key casts no shadow — the live bake photographs an arena outside the shadow frustum anyway');
ok(rig.sky.position.x === center.x,
  'the probe sky is concentric with the probe, or a 900u dome clips away at 4km');

// The rig really did take the realm's air on, so the comparison above was
// looking at a rig that had something to leak.
ok(rig.uniforms.uZenith.value.getHex() !== env.skyUniforms.uZenith.value.getHex()
   || rig.key.intensity !== env.key.intensity,
  'the probe rig is actually wearing the realm\'s air, not the world\'s');

// ---------------------------------------- 2. the check can fail (positive control)

env._dress(env._liveRig, realmAir);
const contaminated = snapshot(env, scene);
const leaked = diff(before, contaminated);
ok(leaked.length > 0,
  `the same comparison catches realm air on the world rig (${leaked.length} fields moved)`);
ok(leaked.includes('fog.density') || leaked.includes('key.intensity') || leaked.some((k) => k.startsWith('sky.')),
  'and the fields it catches are the ones the eye would see');

// ---------------------------------------------------------- 3. a parked arena is parked

{
  const s2 = new THREE.Scene();
  const ctx2 = { scene: s2 };
  const def = REALM_BY_ID.get('crucible');

  const parked = new RealmStage(ctx2, def, { parked: true });
  ok(parked.root.parent === null, 'a parked stage is not in the scene graph');
  ok(!s2.children.includes(parked.root), 'and the scene has never heard of it');
  parked.attach();
  ok(s2.children.includes(parked.root), 'attach() puts it in');
  parked.attach();
  ok(s2.children.filter((c) => c === parked.root).length === 1, 'attach() twice is still once');

  const live = new RealmStage(ctx2, def);
  ok(s2.children.includes(live.root), 'the ordinary constructor still adds itself, unchanged');
}

// ------------------------------------------- 4. the warm walks, it does not sprint

{
  const { RealmWarm } = await import('../src/world/realms/RealmWarm.js');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const compiles = [];
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget() {},
    compileAsync(root, cam, target) {
      // What the scene looked like at the one moment that decides the cache
      // key. `root.parent` is the fourteen-second trap; `pointLights` is the
      // double-count one — three walks the target scene *and* this root.
      let pointLights = 0;
      target.traverseVisible((o) => { if (o.isPointLight) pointLights++; });
      compiles.push({ rootInScene: root.parent === target, pointLights, env: target.environment });
      return Promise.resolve();
    },
  };
  const probe = { texture: { probe: true }, dispose() {} };
  const ctx = {
    scene,
    camera,
    realms: { inRealm: false },
    pipeline: { renderer, composer: { renderTarget1: {} } },
    environment: { bakeDetachedProbe: () => probe },
    stage: { terrainMesh: new THREE.Mesh(), propsGroup: new THREE.Group() },
  };
  scene.environment = { world: true };

  const warm = new RealmWarm(ctx);
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  warm.offer('crucible');
  warm.offer('crucible');
  ok(warm.records.size === 1, 'a door offered twice is warmed once');

  warm.step();
  const rec = warm.records.get('crucible');
  ok(rec.stage != null && rec.step === 'bake', 'step one builds the arena and stops');
  ok(rec.stage.root.parent === null, 'and leaves it out of the scene');
  ok(!scene.children.includes(rec.stage.root), 'the live scene never sees a warming arena');

  warm.step();
  ok(rec.rt === probe && rec.step === 'compile', 'step two bakes the probe and stops');

  for (let i = 0; i < 12 && rec.step !== 'ready'; i++) { warm.step(); await flush(); }
  ok(rec.step === 'ready', 'the compile spread runs itself out and reports ready');
  ok(warm.ready('crucible'), 'and ready() agrees');

  ok(compiles.length >= 2, `the compile covers a spread of light counts (${compiles.length} passes)`);
  ok(compiles.every((c) => !c.rootInScene),
    'the arena is never in the scene during a compile — three counts its lights from the root argument, and a drawable arena at REALM_ORIGIN_X is a 14 s frame');
  ok(new Set(compiles.map((c) => c.pointLights)).size === compiles.length,
    `each pass warms a different light count (${compiles.map((c) => c.pointLights).join(', ')})`);
  ok(compiles.every((c) => c.env === probe.texture),
    'every pass is keyed to the realm\'s own probe, not the world\'s');

  ok(scene.environment.world === true, 'and the world gets its own probe back afterwards');
  ok(ctx.stage.terrainMesh.visible === true && ctx.stage.propsGroup.visible === true,
    'the world is left visible — the entry pose lasts one synchronous call and no longer');
  let stands = 0;
  scene.traverse((o) => { if (o.name === 'realm-warm-stand-in') stands++; });
  ok(stands === 0, 'no stand-in light is left behind in the scene');

  const taken = warm.take('crucible');
  ok(taken?.stage === rec.stage && taken.rt === probe, 'entry takes the arena and its probe');
  ok(warm.records.size === 0, 'and the warm forgets it, so the exit owns the teardown');
  ok(warm.take('crucible') === null, 'a second take finds nothing');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  realm-warm-probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
