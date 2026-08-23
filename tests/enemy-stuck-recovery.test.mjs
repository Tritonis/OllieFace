// tests/enemy-stuck-recovery.test.mjs
//
// #186: on the canyon profile the water channels carve pits an enemy can walk
// into and never walk out of. There is no navmesh, so local steering cannot
// reason its way out; the fix is a liveness watch (`STUCK`) that notices a unit
// making no progress and burrows it to a validated point on the player's level.
//
// The trap here is a real one: a synthetic stage whose capsule solver refuses
// to let anything climb the channel wall, exactly as the real solver refuses a
// surface past the walkable slope limit. The enemy is driven through its own
// `fixedUpdate` — real FSM, real steering, real integration.
//
// The test is built so it CAN fail, three ways:
//   * `STUCK.time = Infinity` disables the detector and the same enemy is
//     asserted to be STILL in the pit at the end. If the pit were not a real
//     trap — if the harness let it walk out — that case goes red;
//   * a stationary card in the same pit must never be rescued (it is doing its
//     job);
//   * a unit held in a long wind-up must never be rescued, and must not even
//     accumulate stuck time.
// Falsification run by hand before committing: deleting the `trackStuck` call
// in `applyMovement` turns the recovery assertions red and leaves the three
// non-trigger assertions green.
import * as THREE from 'three';
import { Enemy, STUCK } from '../src/entities/Enemy.js';
import { S } from '../src/ai/StateMachine.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const PIT_HALF = 3;      // a closed pocket of channel: |x| < 3 and |z| < 3
const PIT_FLOOR = -6;

function makeRng(seed = 99) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    int(a, b) { return a + Math.floor(r.next() * (b - a + 1)); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

const inPit = (x, z) => Math.abs(x) < PIT_HALF && Math.abs(z) < PIT_HALF;
const heightAt = (x, z) => (inPit(x, z) ? PIT_FLOOR : 0);

/**
 * A stage with one impassable channel. `capsuleResolve` integrates normally
 * except that it will not carry anything across the lip: from inside, the wall
 * is a wall.
 */
function makeStage() {
  return {
    sampleHeight: (x, z) => heightAt(x, z),
    isWalkable: () => true,
    raycast: () => null,
    capsuleResolve(position, radius, height, velocity, h) {
      let x = position.x + velocity.x * h;
      let z = position.z + velocity.z * h;
      let y = position.y + velocity.y * h;
      if (inPit(position.x, position.z)) {
        // Pinned against the pit wall: the offending axis is eaten, and so is
        // the velocity that was driving it, the same as a real wall contact.
        if (!inPit(x, position.z)) { x = position.x; velocity.x = 0; }
        if (!inPit(x, z)) { z = position.z; velocity.z = 0; }
      }
      const g = heightAt(x, z);
      let grounded = false;
      if (y <= g) { y = g; if (velocity.y < 0) velocity.y = 0; grounded = true; }
      return { position: new THREE.Vector3(x, y, z), velocity, grounded };
    },
  };
}

function makeWorld(playerX = 12) {
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x: playerX, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 110, maxHealth: 110,
    takeDamage() { return 0; },
  };
  const roster = new Roster();
  roster.init(ctx);
  ctx.player = player;
  roster.add(player);
  ctx.stage = makeStage();
  ctx.director = { enemies: [], spawnTelegraph() {}, spawnWave() {} };
  ctx.audio = { windupVoice: () => ({ active: true, move() {}, release() {} }), elementTick() {}, elementTransient() {}, elementBeam() {} };
  ctx.vfx = { beams: { spawn: () => {} }, lights: { flick: () => {} } };
  return { ctx, player };
}

function card(id) { return ENEMIES.find((e) => e.id === id); }

/** Drop a unit on the channel floor and run it at 60 Hz for `seconds`. */
function trap(def, seconds, onStep) {
  const w = makeWorld();
  const e = new Enemy();
  e.spawn(w.ctx, def, { x: 0, y: PIT_FLOOR, z: 0 }, {});
  w.ctx.director.enemies.push(e);
  const h = 1 / 60;
  const steps = Math.round(seconds / h);
  let sawExtract = false;
  let recoveredAt = -1;
  for (let i = 0; i < steps; i++) {
    w.ctx.time += h;
    e.fixedUpdate(w.ctx, h);
    if (e.fsm.state === S.EXTRACT) sawExtract = true;
    // Recovered means all of it: above ground, out of the pit, back in a state
    // that can fight, and no longer flagged as underground.
    if (recoveredAt < 0 && sawExtract && e.fsm.state !== S.EXTRACT
      && !e.submerged && !inPit(e.position.x, e.position.z)) recoveredAt = i * h;
    if (onStep) onStep(e, w, i);
  }
  return { e, w, sawExtract, recoveredAt };
}

console.log('enemy stuck recovery (#186)');

// --- the rescue itself -----------------------------------------------------
{
  // Budget: the detection window, the underground travel cap, and a beat, plus
  // an allowance for the pauses. A unit that can still shoot from the pit stops
  // the watch's clock while it swings, and a skink lobs a fireball every five
  // seconds, so wall-clock detection runs roughly double the window. Observed
  // on this trap: 13.1s.
  const budget = STUCK.time * 2 + STUCK.extractMax + 6;
  const { e, sawExtract, recoveredAt } = trap(card('skink'), budget + 2);
  ok(sawExtract, 'a trapped melee unit passes through the EXTRACT state');
  ok(recoveredAt >= 0 && recoveredAt <= budget,
    `it is out of the pit and fighting again within ${budget.toFixed(1)}s (at ${recoveredAt.toFixed(2)}s)`);
  ok(!inPit(e.position.x, e.position.z), `and stays out (x=${e.position.x.toFixed(2)}, z=${e.position.z.toFixed(2)})`);
  ok(e.position.y > -1, 'it surfaced on the player\'s level, not the pit floor');
  ok(!e.submerged && !e.invuln, 'the underground flags were cleared on the way out');
}

// --- mutation check: with the detector off, the trap holds ------------------
{
  const saved = STUCK.time;
  STUCK.time = Infinity;
  try {
    const budget = saved * 2 + STUCK.extractMax + 8;
    const { e, sawExtract } = trap(card('skink'), budget);
    ok(!sawExtract, 'detector disabled: no rescue fires');
    ok(inPit(e.position.x, e.position.z), 'detector disabled: the unit is still in the channel — the trap is real');
  } finally {
    STUCK.time = saved;
  }
}

// --- non-trigger: a stationary card is not stuck, it is stationary ----------
{
  const { e, sawExtract } = trap(card('brood'), STUCK.time + STUCK.extractMax + 2);
  ok(!sawExtract, 'a stationary personality is never rescued');
  ok(e.stuckT === 0, 'and never accumulates stuck time');
}

// --- non-trigger: a wind-up is a commitment, not a stall -------------------
{
  // The longest shipping wind-up is under two seconds, so the window is widened
  // here rather than waited out: the assertion is about the state gate, and a
  // gate that is only ever tested below its own threshold is not tested.
  const base = card('skink');
  const long = { ...base, attacks: base.attacks.map((a, i) => (i === 0 ? { ...a, windup: 8 } : a)) };
  let held = 0;
  const { e, sawExtract } = trap(long, STUCK.time + 2, (en, w, i) => {
    if (i === 0) en.beginAttack(w.ctx, 0);
    if (en.fsm.state === S.WINDUP) held++;
  });
  ok(held > 60, `the unit really was held in WINDUP (${held} steps)`);
  ok(!sawExtract, 'a wind-up never trips the stuck watch');
  ok(e.stuckT === 0, 'and no stuck time accumulates during it');
}

// --- non-trigger: open ground, and a player it can never catch --------------
{
  // The expensive false positive. A unit chasing a player who is simply faster
  // never closes the distance and never will, and rescuing it would teleport
  // monsters onto a kiting survivor - deleting the counterplay that kiting is.
  // Flat ground, no walls, player walking away at 1.2x the unit's speed.
  const w = makeWorld(6);
  w.ctx.stage = {
    sampleHeight: () => 0,
    isWalkable: () => true,
    raycast: () => null,
    capsuleResolve(position, radius, height, velocity, h) {
      const p = new THREE.Vector3(position.x + velocity.x * h, 0, position.z + velocity.z * h);
      if (velocity.y < 0) velocity.y = 0;
      return { position: p, velocity, grounded: true };
    },
  };
  const e = new Enemy();
  e.spawn(w.ctx, card('skink'), { x: 0, y: 0, z: 0 }, {});
  w.ctx.director.enemies.push(e);
  const h = 1 / 60;
  let sawExtract = false;
  for (let i = 0; i < Math.round(25 / h); i++) {
    w.ctx.time += h;
    w.player.position.x += e.moveSpeed * 1.2 * h;
    w.player.velocity.x = e.moveSpeed * 1.2;
    e.fixedUpdate(w.ctx, h);
    if (e.fsm.state === S.EXTRACT) sawExtract = true;
  }
  ok(!sawExtract, 'a unit running flat out after a faster player is never rescued');
  ok(e.position.x > 20, `and it really was running (x=${e.position.x.toFixed(1)})`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
