// tests/voidtouched-director.test.mjs
// A real Director, driven headless. Short sims on purpose: the normal spawn
// path first fires at spawnT = 2.0 s, so everything below stays under that and
// the only spawns in play are the void path's own.
import * as THREE from 'three';
import { Director } from '../src/systems/Director.js';
import { Roster } from '../src/systems/Roster.js';
import { RNG } from '../src/core/MathUtil.js';
import { VOIDTOUCHED } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeEvents() {
  const listeners = new Map();
  return {
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
  };
}

function makePlayer(x, z) {
  return {
    isPlayer: true, alive: true, team: 'player', radius: 0.45, health: 110, maxHealth: 110,
    position: { x, y: 0, z }, velocity: { x: 0, y: 0, z: 0 },
    takeDamage() { return 0; },
  };
}

function makeWorld({ world = 0, seedRng = 777 } = {}) {
  const ctx = {
    rng: new RNG(seedRng), seed: 424242, time: 0, authority: true, netRole: 'single',
    scene: new THREE.Scene(), events: makeEvents(),
    stage: { sampleHeight: () => 0 },
    corruption: { world },
  };
  const roster = new Roster();
  roster.init(ctx);
  const player = makePlayer(100, 100);          // far from any seed at the origin
  ctx.player = player;
  roster.add(player);
  const d = new Director();
  d.init(ctx);
  return { ctx, d, player };
}

const H = 1 / 60;
const step = (ctx, d, seconds) => { for (let i = 0; i < Math.round(seconds / H); i++) { ctx.time += H; d.fixedUpdate(ctx, H); } };
const voids = (d) => d.enemies.filter((e) => e.affix === 'voidtouched');

console.log('a pristine world never touches the void path');
{
  const { ctx, d } = makeWorld({ world: 0 });
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  step(ctx, d, 1.9);
  ok(d.voidCredits === 0, 'no accrual at world 0');
  ok(voids(d).length === 0, 'no spawns');
}

console.log('no seeds, no spawns — corruption alone is not enough');
{
  const { ctx, d } = makeWorld({ world: 150 });
  step(ctx, d, 1.9);
  ok(d.voidCredits === 0, 'the bank only runs where greed left a mark');
  ok(voids(d).length === 0, 'no spawns');
}

console.log('world + seed = a Hollowed unit surfaces on the ring, telegraphed');
{
  const { ctx, d } = makeWorld({ world: 150 });
  const spawnEvents = [];
  ctx.events.on('voidtouchedSpawn', (p) => spawnEvents.push(p));
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = VOIDTOUCHED.maxBank;          // skip the accrual wait; spend logic is under test
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  const v = voids(d);
  ok(v.length === 1, 'exactly one surfaced');
  ok(spawnEvents.length === 1 && spawnEvents[0].id === v[0].def.id, 'voidtouchedSpawn event fired with the card id');
  const r = Math.hypot(v[0].position.x, v[0].position.z);
  ok(r >= VOIDTOUCHED.spawnRing.min - 0.01 && r <= VOIDTOUCHED.spawnRing.max + 0.01, `on the ring (got ${r.toFixed(2)} m)`);
  ok(!v[0].def.isFlyer && v[0].def.eliteEligible, 'a ground card the affix is legal on');
  ok(d.voidCredits < VOIDTOUCHED.maxBank, 'the spawn was paid for');
}

console.log('placement draws nothing from the shared stream');
{
  const a = makeWorld({ world: 150 });
  const b = makeWorld({ world: 150 });
  for (let i = 0; i < 5; i++) b.ctx.rng.next();  // displace B's shared stream
  for (const w of [a, b]) {
    w.ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
    w.d.voidCredits = VOIDTOUCHED.maxBank;
    step(w.ctx, w.d, VOIDTOUCHED.telegraph + 0.4);
  }
  const va = voids(a.d)[0], vb = voids(b.d)[0];
  ok(!!va && !!vb, 'both worlds surfaced one');
  ok(va.position.x === vb.position.x && va.position.z === vb.position.z,
    'identical surfacing point despite a displaced ctx.rng — every roll came from the derived stream');
  ok(va.def.id === vb.def.id, 'and the same card');
}

console.log('it will not surface in your face');
{
  const { ctx, d, player } = makeWorld({ world: 150 });
  player.position.x = 0; player.position.z = 0;   // standing ON the seed
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = VOIDTOUCHED.maxBank;
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  ok(voids(d).length === 0, 'every candidate inside minPlayerDist was refused');
}

console.log('stageStart wipes seeds, pending surfacings and the bank');
{
  const { ctx, d } = makeWorld({ world: 150 });
  ctx.events.emit('blightSeed', { x: 0, z: 0, strength: 2 });
  d.voidCredits = VOIDTOUCHED.maxBank;
  step(ctx, d, 0.2);                              // telegraph queued, not yet surfaced
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  step(ctx, d, VOIDTOUCHED.telegraph + 0.4);
  ok(voids(d).length === 0, 'the pending surfacing died with the stage');
  ok(d._voidSeeds.length === 0 && d.voidCredits === 0, 'seeds and bank cleared');
}

console.log('the bank is capped');
{
  const { ctx, d } = makeWorld({ world: 10000 });
  ctx.events.emit('blightSeed', { x: 500, z: 500, strength: 1 });  // far seed: accrual runs, spends fail (no walkable check needed — ring points are fine, but keep the player 100,100 far so spends succeed; cap still binds first at this rate)
  step(ctx, d, 1.5);
  ok(d.voidCredits <= VOIDTOUCHED.maxBank + 1e-9, 'maxBank holds');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
