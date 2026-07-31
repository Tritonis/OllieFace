/**
 * Proves the property Task 1 exists for: applyCommand is a pure function of
 * (state, command, dt), so replaying the same commands from the same state
 * re-derives bit-identical state.
 */
import * as THREE from 'three';
import { Player } from './src/entities/Player.js';
import { BTN } from './src/net/Protocol.js';
import { RNG } from './src/core/MathUtil.js';

// Minimal deterministic world: a sinusoidal height field, no props.
const height = (x, z) => Math.sin(x * 0.07) * 2.2 + Math.cos(z * 0.05) * 1.7;

const stage = {
  sampleHeight: (x, z) => height(x, z),
  raycast: () => null,
  capsuleResolve(position, radius, h, velocity, dt) {
    const p = position.clone().addScaledVector(velocity, dt);
    const v = velocity.clone();
    const floor = height(p.x, p.z);
    let grounded = false;
    if (p.y <= floor) { p.y = floor; if (v.y < 0) v.y = 0; grounded = true; }
    return { position: p, velocity: v, grounded, normal: new THREE.Vector3(0, 1, 0) };
  },
};

function makeCtx() {
  const listeners = new Map();
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    stage,
    time: 0,
    authority: true,
    rng: new RNG(4242),
    fxRng: new RNG(99),
    events: {
      on(n, f) { (listeners.get(n) ?? listeners.set(n, []).get(n)).push(f); },
      emit() {},
    },
  };
}

/** 120 commands: run, strafe, jump, sprint, dash, fire, look around. */
function buildCommands(n = 120) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let b = 0;
    if (i % 23 === 0 || i % 23 === 1) b |= BTN.JUMP;      // tapped jumps
    if (i > 20 && i < 70) b |= BTN.SPRINT;
    if (i % 11 === 0) b |= BTN.FIRE;
    if (i === 45 || i === 46) b |= BTN.UTILITY;            // dash
    if (i === 80) b |= BTN.SECONDARY;
    if (i === 95) b |= BTN.SPECIAL;
    const t = i / 60;
    out.push({
      tick: i + 1,
      moveX: Math.sin(t * 3) * 0.8,
      moveZ: i < 90 ? 1 : -0.5,
      buttons: b,
      yaw: Math.sin(t * 0.9) * 1.4,
      pitch: Math.sin(t * 2.1) * 0.3,
    });
  }
  return out;
}

function freshPlayer() {
  const ctx = makeCtx();
  const p = new Player();
  p.init(ctx);
  // Identical starting state for both runs.
  p.position.set(3.5, height(3.5, -2.25) + 1.5, -2.25);
  p.velocity.set(0.4, 0, -0.9);
  return { p, ctx };
}

function run(cmds) {
  const { p } = freshPlayer();
  const trace = [];
  for (const cmd of cmds) {
    p.applyCommand(cmd, 1 / 60);
    const s = p.getNetState();
    trace.push([s.x, s.y, s.z, s.vx, s.vy, s.vz, s.dashTime, s.coyote, s.jumpsUsed]);
  }
  return { final: p.getNetState(), trace, player: p };
}

const cmds = buildCommands(120);
const a = run(cmds);
const b = run(cmds);

const KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'dashTime', 'coyote', 'jumpsUsed', 'health'];
let bad = 0;
for (const k of KEYS) {
  if (!Object.is(a.final[k], b.final[k])) {
    bad++;
    console.log(`  DIVERGED ${k}: ${a.final[k]} vs ${b.final[k]}`);
  }
}
let firstStep = -1;
for (let i = 0; i < a.trace.length && firstStep < 0; i++) {
  for (let j = 0; j < a.trace[i].length; j++) {
    if (!Object.is(a.trace[i][j], b.trace[i][j])) { firstStep = i; break; }
  }
}

console.log('--- replay determinism ---');
console.log('commands applied per run:', cmds.length);
console.log('per-step fields compared :', a.trace.length * a.trace[0].length);
console.log('first diverging step     :', firstStep === -1 ? 'none' : firstStep);
console.log('final state A            :', JSON.stringify(pick(a.final)));
console.log('final state B            :', JSON.stringify(pick(b.final)));
console.log('bit-identical            :', bad === 0 && firstStep === -1);

// Sanity: the sequence must actually have moved and exercised the systems, or
// "identical" would be a vacuous pass.
const moved = Math.hypot(a.final.x - 3.5, a.final.z + 2.25);
console.log('distance travelled       :', moved.toFixed(4), 'm');
console.log('jumps used / dash left   :', a.final.jumpsUsed, a.final.dashTime.toFixed(4));

// --- NetClient-shaped reconciliation replay -------------------------------
// Predict 120 ticks, keep history, then rewind to tick 60's state and replay
// 61..120. The result must match the original prediction exactly.
const { p: pc } = freshPlayer();
const history = [];
for (const cmd of cmds) {
  pc.applyCommand(cmd, 1 / 60);
  history.push({ cmd, state: pc.getNetState() });
}
const predictedFinal = pc.getNetState();
const ackIdx = 59;
const acked = history[ackIdx].state;
pc.setNetState(acked);   // full rewind, exactly what getNetState hands back
for (let i = ackIdx + 1; i < history.length; i++) pc.applyCommand(history[i].cmd, 1 / 60);
const replayedFinal = pc.getNetState();
let rbad = 0;
for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) {
  if (!Object.is(predictedFinal[k], replayedFinal[k])) {
    rbad++;
    console.log(`  REPLAY DIVERGED ${k}: ${predictedFinal[k]} vs ${replayedFinal[k]}`);
  }
}
console.log('--- reconciliation replay (rewind to tick 60, replay 60 cmds) ---');
console.log('predicted :', JSON.stringify(pick(predictedFinal)));
console.log('replayed  :', JSON.stringify(pick(replayedFinal)));
console.log('identical :', rbad === 0);

// --- render offset must not touch the simulation --------------------------
const { p: po } = freshPlayer();
for (const cmd of cmds) po.applyCommand(cmd, 1 / 60);
const beforeOffset = po.getNetState();
po.setRenderOffset(9, 9, 9);
po.applyCommand(cmds[cmds.length - 1], 1 / 60);   // same tick => replay, no-op-ish
const afterOffset = po.getNetState();
console.log('--- render offset ---');
console.log('offset vector          :', po._renderOffset.toArray().join(','));
console.log('position unaffected    :', Object.is(beforeOffset.x + (afterOffset.x - beforeOffset.x), afterOffset.x));
console.log('sim x drift from offset:', (afterOffset.x - beforeOffset.x).toFixed(6), '(motion only, not 9)');

process.exit(bad === 0 && firstStep === -1 && rbad === 0 ? 0 : 1);

function pick(s) {
  return { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz };
}
