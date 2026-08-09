/**
 * A hit the shield fully absorbs must still arm the shield-regen delay.
 *
 *   node tests/shield-regen-delay.test.mjs
 *
 * The regen gate lives in `Enemy.fixedUpdate`: while `shieldTimer > 0` the
 * shield holds, otherwise it refills at 50% of the pool per second. The only
 * thing that armed the timer was `takeDamage` — which Combat only calls once
 * damage gets *past* the shield (`applyDamage` gates it on `amount > 0`). So
 * a hit the barrier ate whole never started the delay, the shield regenerated
 * at full rate while under fire, and any build whose DPS fell below half the
 * pool per second could never break a Galvanic or Warded elite at all.
 *
 * Headless is real, not mocked: real `Enemy`, real `Combat`, real rig in a
 * real `THREE.Scene` — same harness as tests/shrike-detonate.test.mjs.
 */
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Combat } from '../src/systems/Combat.js';
import { ENEMIES } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeRng(seed = 12345) {
  let n = seed >>> 0;
  const r = {
    next() { n = (n * 1664525 + 1013904223) >>> 0; return n / 4294967296; },
    range(a, b) { return a + r.next() * (b - a); },
    pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
  };
  return r;
}

const byName = (name) => {
  const d = ENEMIES.find((e) => e.name === name);
  if (!d) throw new Error(`no enemy card named ${name}`);
  return d;
};

function makeWorld() {
  const ctx = {
    rng: makeRng(),
    time: 0,
    authority: true,
    scene: new THREE.Scene(),
    events: { emit() {}, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
  };
  ctx.player = player;
  return { ctx, combat, player };
}

function galvanicEnemy(ctx) {
  const e = new Enemy();
  e.spawn(ctx, byName('Blind Shrike'), new THREE.Vector3(2, 0, 0), { affix: 'overloading' });
  return e;
}

// ---------------------------------------------------------------------------

console.log('a fully-absorbed hit arms the shield-regen delay');
{
  const { ctx, combat, player } = makeWorld();
  const e = galvanicEnemy(ctx);
  ok(e.maxShield > 0, `the affix really grants a shield (got ${e.maxShield})`);
  ok(e.shieldTimer === 0, 'the delay starts unarmed');

  // A chip hit far below the pool: the shield eats all of it.
  const dealt = combat.applyDamage(e, e.maxShield * 0.1, { source: player, position: e.position });
  ok(dealt > 0, `the hit landed (got ${dealt})`);
  ok(e.shield < e.maxShield, `the shield paid for it (${e.shield}/${e.maxShield})`);
  ok(e.health === e.maxHealth, 'nothing reached health — the hit was fully absorbed');
  ok(e.shieldTimer > 0, `the regen delay is armed (got ${e.shieldTimer})`);
}

console.log('a hit that breaks through still arms the delay (control arm)');
{
  const { ctx, combat, player } = makeWorld();
  const e = galvanicEnemy(ctx);
  combat.applyDamage(e, e.maxShield + e.maxHealth * 0.5, { source: player, position: e.position });
  ok(e.shield === 0, 'the shield broke');
  ok(e.health < e.maxHealth, 'the remainder reached health');
  ok(e.shieldTimer > 0, `the regen delay is armed (got ${e.shieldTimer})`);
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
