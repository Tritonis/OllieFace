// tests/elite-aura-cadence.test.mjs
//
// An elite's aura ring is a *hazard* ring: one held boundary, renewed just
// longer than its own tick so it never blinks. The withering ring was spawned
// one nesting level above its cadence gate and so was renewed every frame —
// measured at 60.3 spawns a second against emberclad's and voidtouched's 2.3,
// which is 29 coincident additive rings defeating the class's 0.62 opacity
// ceiling and 60 scene-graph mutations a second per elite.
//
// The three auras are asserted together on purpose: the claim is that they
// share one cadence discipline, and a single-affix test would pass on a ring
// that merely happened to be slow.
//
// Falsification: hoisting the withering `spawnTelegraph` back above its
// `if (this.auraT <= 0)` reds the withering rows at 181 spawns.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 7) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

const H = 1 / 60;
const SECONDS = 3;

// One elite, standing next to the player, run through the real `fixedUpdate`
// for three seconds. Only the telegraph spawns are counted; the ring's life is
// read off the call so "peak concurrent" is the same number a renderer sees.
function auraRun(affix) {
  const rings = [];
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 4000, maxHealth: 4000,
    takeDamage() { return 0; },
  };
  const roster = new Roster();
  roster.init(ctx);
  ctx.player = player;
  roster.add(player);
  ctx.director = {
    spawnTelegraph(x, z, radius, life) { rings.push({ t: ctx.time, life }); },
    denyHealing() {}, healingDeniedFor() { return false; },
  };
  ctx.audio = {
    windupVoice() { return { active: true, move() {}, release() {} }; },
    elementTick() {}, elementTransient() {}, elementBeam() {},
  };
  ctx.vfx = { beams: { spawn() {} }, lights: { flick() {} }, healDenied() {}, hitSpark() {}, status() {}, explosion() {} };
  ctx.combat = { wouldHit() { return true; } };

  const def = ENEMIES.find((e) => e.id === 'scarab');
  const e = new Enemy();
  e.spawn(ctx, def, { x: 1.2, y: 0, z: 0 }, { affix });
  e._ctx = ctx;
  e.targetPlayer = player;
  for (let i = 0; i < SECONDS / H; i++) {
    ctx.time += H;
    e.fixedUpdate(ctx, H);
  }
  // Peak coincident rings: how many were still alive at any spawn moment.
  let peak = 0;
  for (const r of rings) {
    const live = rings.filter((o) => o.t <= r.t && o.t + o.life > r.t).length;
    if (live > peak) peak = live;
  }
  return { count: rings.length, rate: rings.length / SECONDS, peak };
}

for (const affix of ['withering', 'emberclad', 'voidtouched']) {
  console.log(`${affix}: one boundary, renewed on its own tick`);
  const r = auraRun(affix);
  ok(r.count > 0, `the boundary is drawn at all (${r.count} in ${SECONDS}s)`);
  ok(r.rate <= 3, `at tick cadence, not frame cadence (${r.rate.toFixed(1)}/s)`);
  ok(r.peak <= 3, `and never stacks into a filled disc (peak ${r.peak} coincident)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
