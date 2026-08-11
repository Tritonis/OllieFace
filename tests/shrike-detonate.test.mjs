/**
 * A suicide dive must be lethal to the diver, whatever it is wearing.
 *
 *   node tests/shrike-detonate.test.mjs
 *
 * The Blind Shrike (`shrike`) is `eliteEligible`, and its dive resolves through
 * `detonate()`, which self-kills via `Combat.applyDamage(this, this.health)`.
 * That routes the suicide through the full mitigation pipeline — armour curve,
 * then the elite shield pool absorbs first. A Warded elite carries a shield of
 * 1.1x max health plus ward armour while it is up, so the detonation damage
 * never reaches health at all: the Shrike explodes on screen, survives, its
 * shield regenerates (a fully-absorbed hit never calls `takeDamage`, so the
 * regen delay is never armed), and it dives again three seconds later.
 * Forever. A Galvanic elite (shield 0.5x) survives its first dive the same
 * way. Both read to the player as a broken hitbox on an unkillable enemy.
 *
 * Headless is real, not mocked: real `Enemy`, real `Combat`, real rigs in a
 * real `THREE.Scene`. Only the stage and presentation systems are absent,
 * which both classes tolerate by design.
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
  const kills = [];
  const ctx = {
    rng: makeRng(),
    time: 0,
    authority: true,
    scene: new THREE.Scene(),
    events: { emit(name, payload) { if (name === 'kill') kills.push(payload); }, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
  };
  ctx.player = player;
  return { ctx, combat, player, kills };
}

/** Spawn a Shrike, arm its dive, and detonate it — the end of every real dive. */
function detonatedShrike(ctx, player, affix) {
  const e = new Enemy();
  e.spawn(ctx, byName('Blind Shrike'), new THREE.Vector3(2, 0, 0), affix ? { affix } : {});
  e.targetPlayer = player;
  e.atk = e.def.attacks[0];
  e.detonate(ctx);
  return e;
}

// ---------------------------------------------------------------------------

console.log('a plain Shrike dies to its own detonation (control arm)');
{
  const { ctx, player, kills } = makeWorld();
  const e = detonatedShrike(ctx, player, null);
  ok(!e.alive, 'the diver is dead');
  ok(kills.length === 1, `exactly one kill event (got ${kills.length})`);
}

console.log('a Galvanic elite Shrike dies to its own detonation despite its shield');
{
  const { ctx, player } = makeWorld();
  const e = detonatedShrike(ctx, player, 'galvanic');
  ok(e.maxShield > 0, `the affix really grants a shield (got ${e.maxShield})`);
  ok(!e.alive, `the diver is dead (health ${e.health}/${e.maxHealth}, shield ${e.shield})`);
}

console.log('a Warded elite Shrike dies to its own detonation despite shield + ward armour');
{
  const { ctx, player, kills } = makeWorld();
  const e = detonatedShrike(ctx, player, 'warded');
  ok(e.maxShield > e.maxHealth, `the shield pool really exceeds health (${e.maxShield} vs ${e.maxHealth})`);
  ok(!e.alive, `the diver is dead (health ${e.health}/${e.maxHealth}, shield ${e.shield})`);
  ok(kills.length === 1, `the kill event fired so procs and the tally are paid (got ${kills.length})`);
}

console.log('the pre-image loop cannot happen: a second detonation is a no-op on a corpse');
{
  const { ctx, player, kills } = makeWorld();
  const e = detonatedShrike(ctx, player, 'warded');
  e.atk = e.def.attacks[0];
  e.detonate(ctx);
  ok(!e.alive, 'still dead');
  ok(kills.length === 1, `no double kill event (got ${kills.length})`);
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
