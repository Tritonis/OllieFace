// #115 works-biome camera sweep. Writes reviews/camera-115/sweep-<tag>.json
import * as THREE from 'three';
import fs from 'node:fs';
import { Stage } from '../src/world/Stage.js';
import { CameraRig } from '../src/core/CameraRig.js';

const tag = process.argv[2] || 'run';
const SEED = 1234, WORKS = 3, FRAMES = 900, SPEED = 9;
const PITCHES = [-0.17, 0.5, 1.05];

function buildStage(index) {
  const ctx = { scene: new THREE.Scene(), seed: SEED, settings: {},
    camera: new THREE.PerspectiveCamera(), input: null };
  const stage = new Stage();
  stage.init(ctx); stage.build(index);
  return { ctx, stage };
}

const { ctx, stage } = buildStage(WORKS);
const spawn = stage.spawnPoint();
const heading = (a) => (a / 16) * Math.PI * 2;

const out = { tag, pitches: [] };
for (const pitch of PITCHES) {
  let worst = 0, worstInfo = null, sum = 0, n = 0;
  let pen = 0, penInfo = null, buried = 0, buriedInfo = null;
  let floorFrames = 0, distSum = 0, distN = 0;
  const bigs = [];
  for (let a = 0; a < 16; a++) {
    const yaw = heading(a);
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const rig = new CameraRig(); rig.init(ctx);
    rig.yaw = yaw + Math.PI; rig.pitch = pitch;
    const player = {
      position: new THREE.Vector3(spawn.x - dx * 60, 0, spawn.z - dz * 60),
      velocity: new THREE.Vector3(dx * SPEED, 0, dz * SPEED),
      horizontalSpeed: SPEED, sprintBlend: 1, dashT: 0, dashRoll: 0,
    };
    ctx.player = player;
    const dt = 1 / 60;
    let prev = null, prevD = null;
    for (let f = 0; f < FRAMES; f++) {
      player.position.x += dx * SPEED * dt;
      player.position.z += dz * SPEED * dt;
      player.position.y = stage.sampleHeight(player.position.x, player.position.z);
      rig.lateUpdate(ctx, dt);
      // NOT an anti-clipping measurement, despite reading like one. lateUpdate
      // ends with `Math.min(target, allowed)`, so `distance <= allowedDistance`
      // holds by construction and this counter is 0.00e+0 on the unfixed rig as
      // readily as on the fixed one -- 172,800 frames of each without a single
      // trip. What it actually guards is narrower and worth keeping: that the
      // rig obeys the reach it computed. Delete that final clamp and it goes
      // red at 4.73 m, so it is a live guard on the clamp ordering and nothing
      // more. It says nothing about whether the reach was *right*: the suite's
      // stage-2 arm prints this same clean bill over a camera 24.82 m inside a
      // cliff, because that arm hides the geometry from the rig entirely.
      // `buried` below is the instrument that speaks to geometry.
      const p = rig.distance - rig.allowedDistance;
      if (p > pen) { pen = p; penInfo = `h${a} f${f}`; }
      const b = stage.sampleHeight(rig.camPos.x, rig.camPos.z) - rig.camPos.y;
      if (b > buried) { buried = b; buriedInfo = `h${a} f${f}`; }
      if (rig.distance <= 0.7001) floorFrames++; distSum += rig.distance; distN++;
      if (prev) {
        const d = rig.camPos.distanceTo(prev);
        sum += d; n++;
        if (d > worst) { worst = d; worstInfo = `h${a} f${f}`; }
        if (d > 1.0) bigs.push({ h: a, f, d: +d.toFixed(3), from: +prevD.toFixed(3), to: +rig.distance.toFixed(3), allowed: +rig.allowedDistance.toFixed(3) });
      }
      prev = rig.camPos.clone(); prevD = rig.distance;
    }
  }
  bigs.sort((x, y) => y.d - x.d);
  out.pitches.push({ pitch, worst: +worst.toFixed(4), worstInfo, mean: +(sum / n).toFixed(4),
    frames: n, floorFrames, meanDist: +(distSum / distN).toFixed(4), bigCount: bigs.length, bigs: bigs.slice(0, 12),
    clampOrderViolation: +pen.toExponential(3), penInfo, buried: +buried.toFixed(3), buriedInfo });
  console.log(`pitch ${pitch}: worst=${worst.toFixed(4)} (${worstInfo}) mean=${(sum / n).toFixed(4)} ratio=${(worst / (sum / n)).toFixed(1)} big>1m=${bigs.length} floor=${floorFrames} meanDist=${(distSum/distN).toFixed(3)} clampOrder=${pen.toExponential(2)} buried=${buried.toFixed(3)}`);
}
fs.mkdirSync(new URL('../reviews/camera-115/', import.meta.url), { recursive: true });
const path = new URL(`../reviews/camera-115/sweep-${tag}.json`, import.meta.url);
fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.log('wrote', path.pathname ?? path);
