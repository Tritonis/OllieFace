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
    compileAsync(cat, cam, target) {
      // What the scene looked like at the one moment that decides the cache
      // key. `inScene` is the fourteen-second trap — nothing being compiled may
      // be reachable from the live scene, arena root included. `pointLights` is
      // the double-count one: three walks the target scene *and* this argument.
      let pointLights = 0;
      target.traverseVisible((o) => { if (o.isPointLight) pointLights++; });
      let root = cat;
      while (root.parent) root = root.parent;
      const kinds = new Set();
      const names = new Set();
      cat.traverse((o) => {
        if (o.material) kinds.add(o.material.type || 'patched');
        if (o.name) names.add(o.name);
      });
      // The other half of the double-count trap, from the catalogue's side: it
      // must offer three the live scene's *materials* and never its lights.
      const catLights = [];
      cat.traverseVisible((o) => { if (o.isPointLight) catLights.push(o.name || 'arena'); });
      compiles.push({
        inScene: root === target,
        meshes: cat.children.length,
        kinds: [...kinds],
        names: [...names],
        catLights,
        pointLights,
        env: target.environment,
      });
      return Promise.resolve();
    },
  };
  const probe = { texture: { probe: true }, dispose() {} };
  const ctx = {
    scene,
    camera,
    realms: { inRealm: false },
    pipeline: {
      renderer,
      composer: { renderTarget1: {} },
      passes: { gtao: { normalMaterial: new THREE.MeshNormalMaterial() } },
    },
    environment: { bakeDetachedProbe: () => probe },
    stage: { terrainMesh: new THREE.Mesh(), propsGroup: new THREE.Group() },
  };
  scene.environment = { world: true };

  // #192: the live scene is half the catalogue now. Three things stand in it —
  // one drawn, one hidden by the author, and the world terrain the entry pose
  // hides — and only the first may reach the compile.
  const liveDrawn = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  liveDrawn.name = 'live-drawn';
  const liveHidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  liveHidden.name = 'live-hidden';
  liveHidden.visible = false;
  ctx.stage.terrainMesh.name = 'live-terrain';
  ctx.stage.terrainMesh.geometry = new THREE.BoxGeometry();
  ctx.stage.terrainMesh.material = new THREE.MeshStandardMaterial();
  const liveLight = new THREE.PointLight(0xffffff, 1);
  liveLight.name = 'live-light';
  scene.add(liveDrawn, liveHidden, ctx.stage.terrainMesh, liveLight);

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
  ok(rec.rt === probe && rec.step === 'props', 'step two bakes the probe and stops');

  warm.step();
  ok(warm._props?.length > 0 && rec.step === 'compile',
    `step three stands up the realm's props and stops (${warm._props?.length} of them)`);

  for (let i = 0; i < 12 && rec.step !== "ready"; i++) { warm.step(); await flush(); }
  ok(rec.step === 'ready', 'the compile spread runs itself out and reports ready');
  ok(warm.ready('crucible'), 'and ready() agrees');

  ok(compiles.length >= 2, `the compile covers a spread of light counts (${compiles.length} passes)`);
  ok(compiles.every((c) => !c.inScene),
    'nothing being compiled is reachable from the live scene — three counts lights from the compile argument too, and a drawable arena at REALM_ORIGIN_X is a 14 s frame');
  ok(rec.stage.root.parent === null, 'and the arena is back where it was parked afterwards');
  ok(compiles.every((c) => c.kinds.includes('MeshNormalMaterial')),
    'every pass warms GTAO\'s normal-pass override too — compile only ever sees an object\'s own material, and the AO pass redraws the scene through an override');
  ok(compiles.every((c) => c.meshes > 1),
    `the catalogue carries the realm's props and geometry proxies, not just the arena (${compiles[0].meshes} entries)`);
  ok(new Set(compiles.map((c) => c.pointLights)).size === compiles.length,
    `each pass warms a different light count (${compiles.map((c) => c.pointLights).join(', ')})`);

  // #192. The entry frame goes on drawing the world's own interactables at the
  // realm's raised light count, and until this they were never warmed at all.
  const sawName = (n) => compiles.some((c) => c.names.includes(n));
  ok(sawName('live-drawn'),
    'the posed live scene is in the catalogue — what the entry frame keeps drawing is what #192 was');
  ok(!sawName('live-hidden'),
    'but only what is actually drawn: an author-hidden object is not warmed');
  ok(!sawName('live-terrain'),
    'and not the terrain, which the entry pose hides — warming it at a realm light count warms a program no frame asks for');

  // #194: the live half used to ride along on every one of the four
  // light-count passes, recompiling the world's own heaviest materials three
  // times over for counts the entry frame never draws at. It is now offered on
  // exactly the pass `liveMatchStep` names — step 0 for crucible, a trial, not
  // a finale — never on the others.
  ok(compiles.filter((c) => c.names.includes('live-drawn')).length === 1,
    `the live half is offered on exactly one pass, not on every light count (saw it on ${compiles.filter((c) => c.names.includes('live-drawn')).length})`);
  ok(compiles[0].names.includes('live-drawn'),
    'and it is step 0 for an ordinary (non-finale) realm — the fake portal already in `posed` is the true delta');
  ok(!compiles[1].names.includes('live-drawn') && !compiles[2].names.includes('live-drawn') && !compiles[3].names.includes('live-drawn'),
    'so the check above is looking at something: the later passes really do skip the live half');

  ok(compiles.every((c) => !c.catLights.includes('live-light')),
    'the catalogue offers the live scene for materials and never for lights — three already walks the target scene, and offering them twice warms a key nothing draws');
  ok(compiles.some((c) => c.catLights.length > 0),
    'and it does still offer the arena\'s own braziers, so the check above is looking at something');
  ok(compiles.every((c) => c.env === probe.texture),
    'every pass is keyed to the realm\'s own probe, not the world\'s');

  ok(scene.environment.world === true, 'and the world gets its own probe back afterwards');
  ok(ctx.stage.terrainMesh.visible === true && ctx.stage.propsGroup.visible === true,
    'the world is left visible — the entry pose lasts one synchronous call and no longer');
  let stands = 0;
  scene.traverse((o) => { if (o.name === 'realm-warm-stand-in') stands++; });
  ok(stands === 0, 'no stand-in light is left behind in the scene');

  // Prop ids reach clients by number and a client never warms, so a warm that
  // consumed ids would shift every subsequent id on the host alone.
  {
    const { warmPropSet, Obelisk } = await import('../src/world/realms/RealmProps.js');
    const at = new THREE.Vector3();
    const idBefore = new Obelisk(ctx, at).id;
    const set = warmPropSet(ctx, at);
    const idAfter = new Obelisk(ctx, at).id;
    ok(set.length > 0, `warmPropSet stands up the realm's prop classes (${set.length})`);
    ok(idAfter === idBefore + 1,
      `and hands the id counter back untouched (${idBefore} -> ${idAfter}, ${set.length} props built in between)`);
  }

  // #194, the other half of the check: a finale never places the shared
  // portal `posed` already counted, and instead lights its own two-light
  // regalia unconditionally — so its live half belongs one step later, not at
  // step 0. A fresh `RealmWarm` on the same fixture, warming `fracture`
  // instead, is the cheapest way to drive that without reaching into
  // `liveMatchStep` directly.
  {
    compiles.length = 0;
    const fWarm = new RealmWarm(ctx);
    fWarm.offer('fracture');
    for (let i = 0; i < 3; i++) fWarm.step();      // build, bake, props
    const frec = fWarm.records.get('fracture');
    for (let i = 0; i < 12 && frec.step !== 'ready'; i++) { fWarm.step(); await flush(); }
    ok(frec.step === 'ready', 'the finale warms out to ready the same as any other realm');
    ok(!compiles[0].names.includes('live-drawn') && compiles[1].names.includes('live-drawn'),
      `a finale's live half lands on step 1, not step 0 (saw it on ${compiles.map((c, i) => c.names.includes('live-drawn') ? i : null).filter((i) => i !== null).join(',')})`);
  }

  const taken = warm.take('crucible');
  ok(taken?.stage === rec.stage && taken.rt === probe, 'entry takes the arena and its probe');
  ok(warm.records.size === 0, 'and the warm forgets it, so the exit owns the teardown');
  ok(warm.take('crucible') === null, 'a second take finds nothing');
}

// ------------------------------- 5. the gateway survives the real emit order
//
// The bug this section exists for (integration review 2026-08-23, MAJOR-1): a
// gateway's warm record was created by `Realms.onStagePopulated` and destroyed
// by the `stageStart` emitted on the very next line of `Progression._openStage`,
// so the ordinary hidden-realm door was never warmed once. Both instruments
// written for #183/#192 injected `realmOffer` by hand and never drove a stage,
// which is exactly why neither could see it. So this drives the *real*
// `_openStage` and the *real* `_startTransition` on a real `Realms`, and the
// order of the emits comes from the source rather than from this file.
{
  const { Realms } = await import('../src/world/realms/Realms.js');
  const { Progression } = await import('../src/systems/Progression.js');

  const makeBus = () => {
    const m = new Map();
    return {
      on(n, f) { if (!m.has(n)) m.set(n, new Set()); m.get(n).add(f); return () => m.get(n).delete(f); },
      emit(n, p) { for (const f of [...(m.get(n) ?? [])]) f(p); },
    };
  };

  const offered = [];
  const at = new THREE.Vector3(30, 0, 30);
  const ctx = {
    events: makeBus(),
    authority: true,
    // Truthy renderer only: `RealmWarm.offer` refuses to record anything
    // headless, and the record is the whole subject here. Nothing compiles —
    // `step()` is never pumped in this section.
    pipeline: { renderer: {} },
    scene: new THREE.Scene(),
    rng: { next: () => 0, pick: (a) => a[0] },
    player: { position: new THREE.Vector3() },
    stage: { landmarks: [], randomWalkablePoint: () => at.clone() },
    interactables: { list: [], add() {}, populate: () => ({ position: new THREE.Vector3() }), clear() {} },
    audio: { play() {} },
  };
  ctx.events.on('realmOffer', (e) => offered.push(e.id));

  const realms = new Realms();
  realms.init(ctx);

  const prog = Object.create(Progression.prototype);
  prog.ctx = ctx;
  prog.vault = null;
  prog.interactables = ctx.interactables;
  prog.transition = null;
  // Keep the transition incremental so `_startTransition` returns without
  // building a stage this fixture does not have.
  prog.stretchTransitions = true;

  prog._openStage(3);

  const gateways = [...realms.warm.records.keys()];
  ok(offered.length > 0, `the real stage populate offers at least one gateway (${offered.join(', ') || 'none'})`);
  ok(gateways.length === offered.length && offered.every((id) => realms.warm.records.has(id)),
    `and every gateway offered is still warm after the stageStart that follows it (records: ${gateways.join(', ') || 'none'})`);

  // The positive control for the assertion above: put the clear back where it
  // was and the same sequence must lose the record. Without this the check
  // above passes on a fixture that simply never offered anything.
  {
    const ctx2 = { ...ctx, events: makeBus(), interactables: { ...ctx.interactables } };
    const realms2 = new Realms();
    realms2.init(ctx2);
    ctx2.events.on('stageStart', () => realms2.warm.clear());   // the old wiring
    const prog2 = Object.create(Progression.prototype);
    Object.assign(prog2, prog, { ctx: ctx2, interactables: ctx2.interactables });
    prog2._openStage(3);
    ok(realms2.warm.records.size === 0,
      'and clearing on stageStart instead loses it — the check can fail');
  }

  // The other half of the move: the record must still die when the stage it
  // belongs to does, and that is the *start* of the transition away from it.
  prog._startTransition(4, true);
  ok(realms.warm.records.size === 0,
    'the transition off the stage takes its warmed arenas with it');

  // A realm round trip raises neither event, so the doors still standing on
  // this stage keep their records across a visit. Documented, not new.
  realms.warm.offer('crucible');
  realms.warm.offer('vault');
  realms.warm.take('crucible');
  ok(realms.warm.records.has('vault'),
    'entering one door leaves its siblings on the same stage warm');
}

// ------------------------------------- 6. clear() hands the compile lock back
{
  const { RealmWarm } = await import('../src/world/realms/RealmWarm.js');
  // A renderer whose `compileAsync` never settles — the exact shape minor-2
  // described, where the only thing that ever released `_busy` never runs.
  let settle;
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    realms: { inRealm: false },
    pipeline: {
      renderer: {
        getRenderTarget: () => null,
        setRenderTarget() {},
        compileAsync: () => new Promise((r) => { settle = r; }),
      },
      composer: { renderTarget1: {} },
      passes: {},
    },
    environment: { bakeDetachedProbe: () => ({ texture: {}, dispose() {} }) },
    stage: {},
  };
  const warm = new RealmWarm(ctx);
  warm.offer('crucible');
  for (let i = 0; i < 4; i++) warm.step();     // build, bake, props, compile
  ok(warm._busy === true, 'a compile in flight holds the warm lock');

  const orphan = settle;   // the promise the cleared record left in flight
  settle = null;
  warm.clear();
  ok(warm._busy === false, 'and clear() hands it back rather than wedging the session');

  warm.offer('vault');
  warm.step();
  ok(warm.records.get('vault')?.stage != null,
    'so warming works again after a stage change landed mid-compile');

  // The orphaned promise finally settles. It must not touch the lock the new
  // generation is holding.
  const rec = warm.records.get('vault');
  for (let i = 0; i < 3; i++) { warm.step(); }
  const busyBefore = warm._busy;
  orphan?.();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  ok(warm._busy === busyBefore && rec.step !== 'ready',
    'the orphaned compile releases nothing and promotes nothing');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  realm-warm-probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
