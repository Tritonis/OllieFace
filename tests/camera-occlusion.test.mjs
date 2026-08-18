// tests/camera-occlusion.test.mjs
//
// The camera's occlusion fan, replayed headless against a real Stage.build(2)
// — the Pale Vault, where 63.7% of the stalagmite instances carry no player
// collider and the survivor therefore runs straight through them.
//
// Two claims, and they pull in opposite directions:
//
//  1. A spire grazing the ray fan must not collapse the boom to its 0.7 m
//     floor. That is issue #110: a ~7 m camera translation inside one 16 ms
//     frame, ~40x the free-flight per-frame delta.
//  2. A wall the survivor is pressed against must still clamp the boom, even
//     though it too reports a tiny ray distance. The obvious patch for (1) —
//     ignore any hit inside CAM_RADIUS — buys (1) by breaking (2), and this
//     file exercises that patch directly rather than describing it.
import * as THREE from 'three';
import { Stage } from '../src/world/Stage.js';
import { CameraRig } from '../src/core/CameraRig.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const CAM_RADIUS = 0.34;   // must track CameraRig's own constant
const SEED = 1234;
const STAGE = 2;
const WORKS = 3;   // Ferrous Muster, the only biome with precast barriers

function buildStage(index = STAGE) {
  const ctx = {
    scene: new THREE.Scene(), seed: SEED, settings: {},
    camera: new THREE.PerspectiveCamera(), input: null,
  };
  const stage = new Stage();
  stage.init(ctx);
  stage.build(index);
  return { ctx, stage };
}

/**
 * Run `frames` of lateUpdate with the survivor travelling in a straight line at
 * `speed`, and return every per-frame camera translation.
 */
function sprint(ctx, stage, { x, z, yaw, frames = 900, speed = 9 }) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  const rig = new CameraRig();
  rig.init(ctx);
  // Facing along travel: the boom trails behind, which is the #106 repro.
  rig.yaw = yaw + Math.PI;
  const player = {
    position: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(dx * speed, 0, dz * speed),
    horizontalSpeed: speed, sprintBlend: 1, dashT: 0, dashRoll: 0,
  };
  ctx.player = player;
  const dt = 1 / 60;
  const deltas = [];
  let prev = null;
  for (let f = 0; f < frames; f++) {
    player.position.x += dx * speed * dt;
    player.position.z += dz * speed * dt;
    player.position.y = stage.sampleHeight(player.position.x, player.position.z);
    rig.lateUpdate(ctx, dt);
    if (prev) deltas.push(rig.camPos.distanceTo(prev));
    prev = rig.camPos.clone();
  }
  return deltas;
}

const { ctx, stage } = buildStage();
const spawn = stage.spawnPoint();
const heading = (a) => (a / 16) * Math.PI * 2;
// Each run starts 60 m back along its own heading and crosses the basin.
const start = (a) => ({
  x: spawn.x - Math.sin(heading(a)) * 60,
  z: spawn.z - Math.cos(heading(a)) * 60,
  yaw: heading(a),
});

console.log('#110 repro: straight-line sprint through uncollidered stalagmites');
{
  // Heading 0 is the frame-302 collapse from the issue: 6.85 m in one frame,
  // 40x the free-flight mean, boom pinned at its 0.700 floor.
  const d = sprint(ctx, stage, start(0));
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const max = Math.max(...d);
  console.log(`    mean=${mean.toFixed(4)} max=${max.toFixed(3)} ratio=${(max / mean).toFixed(1)}`);
  // Unfixed this is 6.845 (ratio 40.1). A genuine obstruction crossing the
  // boom is allowed to snap the camera in — that is the rig's anti-clipping
  // guarantee — but not by the whole boom length.
  ok(max <= 2.0, `no frame translates the camera more than 2 m (was ${max.toFixed(3)})`);
  ok(max / mean <= 10, `worst frame within 10x the free-flight mean (${(max / mean).toFixed(1)}x)`);
}

console.log('sixteen headings across the same stage');
{
  let worst = 0, worstA = -1;
  for (let a = 0; a < 16; a++) {
    const d = sprint(ctx, stage, start(a));
    const max = Math.max(...d);
    if (max > worst) { worst = max; worstA = a; }
  }
  console.log(`    worst=${worst.toFixed(3)} on heading ${worstA}`);
  // Unfixed: 6.845. The survivors of the fix are all thick geometry (0.86-2.0 m
  // along the boom, or solid past the boom end) clamping the camera to a normal
  // 3.5-4.8 m boom, which is the rig working as designed.
  ok(worst <= 4.5, `no heading collapses the boom to its floor (worst ${worst.toFixed(3)})`);
}

// --- the rejected fix ------------------------------------------------------
//
// A spot on the boundary cliff where the survivor stands with rock at his back:
// all five fan rays report a hit inside CAM_RADIUS, and the far end of an
// unclamped boom is underground.
const WALL = { x: -100, z: -4, yaw: 1.309 };

/** Hold still at `spot` for 30 frames and return the settled camera position. */
function stand(ctx, stage, spot) {
  const rig = new CameraRig();
  rig.init(ctx);
  rig.yaw = spot.yaw;
  if (spot.pitch !== undefined) rig.pitch = spot.pitch;
  ctx.player = {
    position: new THREE.Vector3(spot.x, stage.sampleHeight(spot.x, spot.z), spot.z),
    velocity: new THREE.Vector3(), horizontalSpeed: 0, sprintBlend: 0, dashT: 0, dashRoll: 0,
  };
  ctx.input = null;
  for (let f = 0; f < 30; f++) rig.lateUpdate(ctx, 1 / 60);
  return { pos: rig.camPos.clone(), distance: rig.distance };
}

const buried = (p) => stage.sampleHeight(p.x, p.z) - p.y;

console.log('pressed against a wall: the shipped rule still clamps');
const shipped = stand(ctx, stage, WALL);
{
  console.log(`    distance=${shipped.distance.toFixed(3)} buriedBy=${buried(shipped.pos).toFixed(3)}`);
  ok(shipped.distance <= 1.5, `boom clamps hard against the wall (${shipped.distance.toFixed(3)} m)`);
}

console.log('pressed against a wall: `if (d > CAM_RADIUS)` clips through it');
{
  // Exactly that patch, imposed from outside the rig: every hit inside the
  // cast sphere is discarded before CameraRig ever sees it.
  const real = stage.raycastDistance.bind(stage);
  stage.raycastDistance = (o, d, m) => { const r = real(o, d, m); return r > CAM_RADIUS ? r : -1; };
  const rejected = stand(ctx, stage, WALL);
  stage.raycastDistance = real;
  console.log(`    distance=${rejected.distance.toFixed(3)} buriedBy=${buried(rejected.pos).toFixed(3)}`);
  ok(rejected.distance > 6.5, 'the boom never pulls in — every hit was thrown away');
  ok(buried(rejected.pos) > 1, `the camera ends up inside the cliff (${buried(rejected.pos).toFixed(2)} m under)`);
  // This cliff is steep enough that even the 0.7 m floor does not fully clear
  // it — that is the rig's pre-existing MIN_DIST, unchanged here. What matters
  // is the ratio: the shipped rule stays at the survivor's shoulder, the
  // rejected one is most of a boom deep in solid rock.
  ok(buried(rejected.pos) > buried(shipped.pos) * 10,
     `rejected fix buries the camera ${(buried(rejected.pos) / buried(shipped.pos)).toFixed(0)}x deeper`);
}

// --- the works biome, where SLIVER_MAX is closest to real geometry ---------
//
// `barrierGeo` is a Jersey barrier 0.44 m deep in local Z, instanced at scale
// 0.902-1.598, so its head-on world depth runs 0.397-0.703 m. That straddles
// SLIVER_MAX as a *whole object* rather than as an edge graze, which makes the
// works biome the one place where the threshold has to be exactly right: too
// high and a barrier the survivor is standing behind stops constraining the
// boom at all.
//
// The first version of this arm sprinted past barriers on sixteen headings and
// could not fail — at pitch 1.05 the boom grazes the downslope terrain, the
// reverse cast returns -1 every time, and SLIVER_MAX is never even compared
// against. Raising it to 50.0 changed nothing. So this arm instead parks the
// survivor at a fixed standoff *facing* specific barrier instances, at
// configurations chosen offline as ones that flip: each of these clamps the
// boom at SLIVER_MAX 0.5 and runs out to the full 7.1 m at 0.8.
const BARRIERS = [
  { x: -53.972, z: 22.623, yaw: 0.1870, pitch: 0.3, depth: 0.649 },
  { x: -61.344, z: -32.791, yaw: 1.8537, pitch: -0.3, depth: 0.650 },
  { x: -15.598, z: 32.736, yaw: 2.1256, pitch: 0.9, depth: 0.638 },
  { x: 53.621, z: 41.916, yaw: 1.2057, pitch: -0.3, depth: 0.702 },
  { x: 42.268, z: 26.680, yaw: 1.1154, pitch: 0.9, depth: 0.680 },
  { x: 37.433, z: 68.975, yaw: 1.1002, pitch: 0.0, depth: 0.672 },
];

console.log('works biome: barriers thicker than SLIVER_MAX still clamp the boom');
{
  const w = buildStage(WORKS);
  let clamped = 0;
  for (const b of BARRIERS) {
    const { distance } = stand(w.ctx, w.stage, b);
    if (distance < 7.0) clamped++;
    console.log(`    depth=${b.depth.toFixed(3)} distance=${distance.toFixed(3)}`);
  }
  // All six are 0.58-0.70 m deep, i.e. above SLIVER_MAX and below the 0.8 the
  // reviewer tried. At 0.5 every one clamps; at 0.8 every one reads as a sliver
  // and the boom stays at its full 7.1 m, which is what makes this arm able to
  // go red on a mis-calibration rather than merely describe one.
  ok(clamped === BARRIERS.length,
     `all ${BARRIERS.length} above-threshold barriers constrain the boom (${clamped} did)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
