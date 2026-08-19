// #116 retune: sweep SOFT_HOLD_TAU headlessly.
// Writes reviews/115-retune/tau-sweep.json
// Usage: node tools/camera-tau-sweep.mjs 0 0.15 0.30 0.40 0.55
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rigSrc = path.join(here, '..', 'src', 'core', 'CameraRig.js');
const original = fs.readFileSync(rigSrc, 'utf8');

const taus = (process.argv.slice(2).length ? process.argv.slice(2) : ['0']).map(Number);
const STAGES = (process.env.STAGES || '0,1,2,3,4').split(',').map(Number);
const SEED = 1234, FRAMES = 900, SPEED = 9;
const PITCHES = (process.env.PITCHES || '-0.17').split(',').map(Number);

async function loadRig(tau) {
  const patched = original.replace(/const SOFT_HOLD_TAU = [0-9.]+;/,
    `const SOFT_HOLD_TAU = ${tau};`);
  if (!/const SOFT_HOLD_TAU = [0-9.]+;/.test(original)) throw new Error('tau substitution failed');
  const tmp = path.join(here, '..', 'src', 'core', `__tau_${String(tau).replace('.', '_')}.js`);
  fs.writeFileSync(tmp, patched);
  const mod = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);
  return mod.CameraRig;
}

const { Stage } = await import('../src/world/Stage.js');
function buildStage(index) {
  const ctx = { scene: new THREE.Scene(), seed: SEED, settings: {},
    camera: new THREE.PerspectiveCamera(), input: null };
  const stage = new Stage();
  stage.init(ctx); stage.build(index);
  return { ctx, stage };
}
const heading = (a) => (a / 16) * Math.PI * 2;

const stages = new Map(STAGES.map((s) => [s, buildStage(s)]));
const out = { taus: [] };
for (const tau of taus) {
  const Rig = await loadRig(tau);
  const rec = { tau, stages: [] };
  for (const s of STAGES) {
    const { ctx, stage } = stages.get(s);
    const spawn = stage.spawnPoint();
    for (const pitch of PITCHES) {
      let worst = 0, worstInfo = null, distSum = 0, distN = 0, bigCount = 0;
      let winWorst = 0;
      for (let a = 0; a < 16; a++) {
        const yaw = heading(a);
        const dx = Math.sin(yaw), dz = Math.cos(yaw);
        const rig = new Rig(); rig.init(ctx);
        rig.yaw = yaw + Math.PI; rig.pitch = pitch;
        const player = {
          position: new THREE.Vector3(spawn.x - dx * 60, 0, spawn.z - dz * 60),
          velocity: new THREE.Vector3(dx * SPEED, 0, dz * SPEED),
          horizontalSpeed: SPEED, sprintBlend: 1, dashT: 0, dashRoll: 0,
        };
        ctx.player = player;
        const dt = 1 / 60;
        let prev = null;
        const deltas = [];
        for (let f = 0; f < FRAMES; f++) {
          player.position.x += dx * SPEED * dt;
          player.position.z += dz * SPEED * dt;
          player.position.y = stage.sampleHeight(player.position.x, player.position.z);
          rig.lateUpdate(ctx, dt);
          distSum += rig.distance; distN++;
          if (prev) {
            const d = rig.camPos.distanceTo(prev);
            deltas.push(d);
            if (d > 1) bigCount++;
            if (d > worst) { worst = d; worstInfo = `h${a} f${f}`; }
          }
          prev = rig.camPos.clone();
        }
        // #115 windowed arm (stage 3, pitch -0.17 only)
        if (s === 3 && pitch === -0.17) {
          for (const { aa, at } of [{ aa: 0, at: 71 }, { aa: 14, at: 232 }]) {
            if (aa !== a) continue;
            const m = Math.max(...deltas.slice(at - 12, at + 6));
            if (m > winWorst) winWorst = m;
          }
        }
      }
      rec.stages.push({ stage: s, pitch, worst: +worst.toFixed(3), worstInfo,
        big: bigCount, meanBoom: +(distSum / distN).toFixed(3),
        windowed: s === 3 && pitch === -0.17 ? +winWorst.toFixed(3) : null });
      console.log(`tau=${tau} stage=${s} pitch=${pitch} worst=${worst.toFixed(3)} big=${bigCount} meanBoom=${(distSum/distN).toFixed(3)}` +
        (s === 3 && pitch === -0.17 ? ` windowed=${winWorst.toFixed(3)}` : ''));
    }
  }
  out.taus.push(rec);
}
fs.mkdirSync(path.join(here, '..', 'reviews', '115-retune'), { recursive: true });
fs.writeFileSync(path.join(here, '..', 'reviews', '115-retune', process.env.OUT || 'tau-sweep.json'), JSON.stringify(out, null, 2));
console.log('done');
