/**
 * The survivor can always walk out of a slow.
 *
 *   node tests/player-slow-agency.test.mjs
 *
 * Two faults made sustained enemy fire an inescapable stun-lock (#135):
 *
 *   1. Slow stacks compounded on the player. Each stack multiplies speed by
 *      0.6, so two shells is 36% and three pins the survivor on the 0.25 floor
 *      in `speedMultiplier`. A 2.0 s duration re-applied by every shell in a
 *      volley never expires, so the run ends with the player at a quarter speed
 *      and no way out.
 *   2. The rider ignored i-frames. `applyDamage` refuses a second hit inside
 *      `iframeDuration`, but every rider site applied its status unconditionally
 *      after the damage call - so the hits a mercy window refused still slowed.
 *
 * The fix is one stack for the player, refreshed rather than added, and a rider
 * that only lands when the hit did. Monsters keep the uncapped RoR2 behaviour,
 * which is the third arm below: it is what stops the fix being a global nerf.
 */
import * as THREE from 'three';
import { Combat } from '../src/systems/Combat.js';
import { Projectiles } from '../src/systems/Director.js';
import { Enemy } from '../src/entities/Enemy.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

function makeWorld() {
  const ctx = {
    rng: { next: () => 0.99, range: (a, b) => a, pick: (a) => a[0] },
    time: 100,
    authority: true,
    scene: new THREE.Scene(),
    events: { emit() {}, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45, height: 1.6,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
    health: 1000, maxHealth: 1000, shield: 0,
    stats: { armor: 0 },
    iframeDuration: 0.1, _iframeUntil: 0,
    takeDamage(a) { this.health -= a; },
  };
  const monster = {
    alive: true, team: 'monster', radius: 0.5, height: 1.6,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
    health: 1000, maxHealth: 1000, shield: 0, armor: 0,
    takeDamage(a) { this.health -= a; },
  };
  ctx.player = player;
  combat.register(player);
  combat.register(monster);
  const shooter = { team: 'monster', damage: 12, position: new THREE.Vector3(3, 0, 0), alive: true };
  return { ctx, combat, player, monster, shooter };
}

// ---------------------------------------------------------------------------

console.log('a volley of slows cannot pin the survivor');
{
  const { combat, player, shooter } = makeWorld();
  for (let i = 0; i < 12; i++) combat.applyStatus(player, 'slow', shooter, 1);
  ok(combat.statusStacks(player, 'slow') === 1, 'twelve applications leave one stack');
  ok(near(combat.speedMultiplier(player), 0.6),
     `the survivor keeps 60% speed, not the 25% floor (got ${combat.speedMultiplier(player).toFixed(3)})`);
  ok(combat.speedMultiplier(player) > 0.5, 'and never falls to half speed or below');
}

console.log('but the slow still lasts as long as the fire does');
{
  const { ctx, combat, player, shooter } = makeWorld();
  combat.applyStatus(player, 'slow', shooter, 1);
  const list = combat.statuses.get(player);
  list[0].remaining = 0.2;                         // 1.8 s of it has burned off
  combat.applyStatus(player, 'slow', shooter, 1);  // the next shell in the volley
  ok(near(list[0].remaining, 2.0), 'a fresh hit refreshes the timer to full');
  ok(combat.statusStacks(player, 'slow') === 1, 'and still does not add a stack');
  ok(near(combat.speedMultiplier(player), 0.6), 'held at 60%, indefinitely, while under fire');
  void ctx;
}

console.log('monsters keep the uncapped stacking the player build is bought for');
{
  const { combat, monster, shooter } = makeWorld();
  for (let i = 0; i < 3; i++) combat.applyStatus(monster, 'slow', shooter, 1);
  ok(combat.statusStacks(monster, 'slow') === 3, 'three stacks stay three stacks on a monster');
  ok(near(combat.speedMultiplier(monster), 0.25), 'and still bottom out on the 25% floor');
}

console.log('a rider only lands when the hit does');
{
  const { ctx, combat, player, shooter } = makeWorld();
  combat.explode(player.position, 3, 20, shooter, { status: 'slow', proc: 0 });
  ok(combat.statusStacks(player, 'slow') === 1, 'the blast that landed applied its slow');
  const hp = player.health;
  // Same instant, inside the 0.1 s mercy window: applyDamage refuses this one.
  combat.statuses.delete(player);
  combat.explode(player.position, 3, 20, shooter, { status: 'slow', proc: 0 });
  ok(player.health === hp, 'the second blast dealt no damage (i-frames held)');
  ok(combat.statusStacks(player, 'slow') === 0, 'and left no slow behind either');
}

console.log('a monster in the same blast is not gated by anything');
{
  const { combat, monster, shooter } = makeWorld();
  combat.explode(monster.position, 3, 20, shooter, { status: 'slow', proc: 0, team: 'player' });
  ok(combat.statusStacks(monster, 'slow') === 1, 'the monster takes the rider as before');
}

console.log("an enemy shell's rider rides the shell's hit");
{
  const { ctx, combat, player, shooter } = makeWorld();
  const shells = Object.create(Projectiles.prototype);
  const def = { damage: 1, radius: 0.3, status: 'slow', color: 0xff7a1e };
  const shell = () => ({ pos: new THREE.Vector3(0, 0.9, 0), def, owner: shooter, color: def.color, mesh: null });
  shells.detonate(ctx, shell());
  ok(combat.statusStacks(player, 'slow') === 1, 'the shell that connected slowed the player');
  combat.statuses.delete(player);
  shells.detonate(ctx, shell());   // same instant, i-frames still up
  ok(combat.statusStacks(player, 'slow') === 0, 'the shell the mercy window refused did not');
}

console.log("an elite's melee affix rides the swing that connected");
{
  const { ctx, combat, player } = makeWorld();
  player.position.set(0, 0, 1);
  const brute = Object.create(Enemy.prototype);
  Object.assign(brute, {
    alive: true, team: 'monster', damage: 12, yaw: 0, radius: 0.5,
    position: new THREE.Vector3(0, 0, 0), velocity: new THREE.Vector3(),
    targetPlayer: player, distToPlayer: 1, elite: { slow: true, burn: true, burnTick: 3 },
    atk: { kind: 'melee', range: 2, arc: 1, lunge: 0 },
  });
  brute.fireAttack(ctx);
  ok(combat.statusStacks(player, 'slow') === 1, 'the swing that landed slowed the player');
  ok(combat.statusStacks(player, 'burn') === 2, 'and lit the affix burn too');
  const hp = player.health;
  combat.statuses.delete(player);
  brute.fireAttack(ctx);   // same instant, i-frames still up
  ok(player.health === hp, 'the second swing dealt no damage (i-frames held)');
  ok(combat.statusStacks(player, 'slow') === 0, 'the swing the mercy window refused left no slow');
  ok(combat.statusStacks(player, 'burn') === 0, 'and no fire either');
}

console.log('an emberclad aura only burns on the tick that connected');
{
  const { ctx, combat, player } = makeWorld();
  const ember = Object.create(Enemy.prototype);
  Object.assign(ember, {
    alive: true, team: 'monster', damage: 12, auraT: 0,
    position: new THREE.Vector3(0, 0, 0), targetPlayer: player, distToPlayer: 0,
    elite: { auraDps: 0.5, auraRadius: 3, burnTick: 3 },
  });
  ember.emberTick(ctx, 0.016);
  ok(combat.statusStacks(player, 'burn') === 1, 'the tick that landed applied its burn');
  const hp = player.health;
  combat.statuses.delete(player);
  ember.auraT = 0;
  ember.emberTick(ctx, 0.016);   // same instant, i-frames still up
  ok(player.health === hp, 'the second tick dealt no damage (i-frames held)');
  ok(combat.statusStacks(player, 'burn') === 0, 'and left no burn behind either');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
