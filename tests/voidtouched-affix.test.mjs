// tests/voidtouched-affix.test.mjs
// A real Enemy, driven headless, with the voidtouched affix — same fixture
// shape as tests/enemy-targeting.test.mjs. No ctx.combat: hurtPlayer falls
// back to victim.takeDamage, which is what the recorder below is.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES, ELITE_STATS } from '../src/data/enemies.js';

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

function makePlayer(x, z) {
  const hits = [];
  return {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x, y: 0, z }, velocity: { x: 0, y: 0, z: 0 },
    health: 110, maxHealth: 110, hits,
    takeDamage(amount, info) { hits.push({ amount, type: info?.type }); this.health -= amount; return amount; },
  };
}

function makeWorld(px, pz) {
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const roster = new Roster();
  roster.init(ctx);
  const player = makePlayer(px, pz);
  ctx.player = player;
  roster.add(player);
  return { ctx, player };
}

const beetle = ENEMIES.find((e) => e.id === 'beetle');
const S = ELITE_STATS.voidtouched;
const H = 1 / 60;

console.log('inside the ring, the siphon ticks and the unit feeds');
{
  const { ctx, player } = makeWorld(2, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, { affix: 'voidtouched' });
  ok(e.affix === 'voidtouched' && e.isElite, 'affix took');
  e.health = e.maxHealth * 0.5;
  const h0 = e.health;
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);   // 0.66 s — at least one 0.5 s tick
  const drained = player.hits.filter((x) => x.type === 'void');
  ok(drained.length >= 1, 'at least one void tick landed');
  ok(Math.abs(drained[0].amount - e.damage * S.siphonDps) < 1e-6, 'tick is damage x siphonDps');
  ok(e.health > h0, 'the unit healed off the drain');
  ok(Math.abs(e.health - h0 - drained.length * e.maxHealth * S.siphonHeal) < 1e-6, 'heal is maxHealth x siphonHeal per connecting tick');
}

console.log('outside the ring, nothing happens');
{
  const { ctx, player } = makeWorld(S.siphonRadius + 3, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, { affix: 'voidtouched' });
  e.health = e.maxHealth * 0.5;
  const h0 = e.health;
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);
  ok(player.hits.filter((x) => x.type === 'void').length === 0, 'no drain at range');
  ok(e.health === h0, 'and no free healing');
}

console.log('a plain beetle is untouched by the new block');
{
  const { ctx, player } = makeWorld(2, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, {});
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);
  ok(player.hits.filter((x) => x.type === 'void').length === 0, 'no affix, no siphon');
}

console.log('submerged, the siphon goes quiet — and resumes when it surfaces');
{
  const { ctx, player } = makeWorld(2, 0);
  const e = new Enemy();
  e.spawn(ctx, beetle, { x: 0, y: 0, z: 0 }, { affix: 'voidtouched' });
  e.health = e.maxHealth * 0.5;
  const h0 = e.health;
  e.submerged = true;
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);
  ok(player.hits.filter((x) => x.type === 'void').length === 0, 'no drain while submerged');
  ok(e.health === h0, 'no self-heal while submerged');
  e.submerged = false;
  for (let i = 0; i < 40; i++) e.fixedUpdate(ctx, H);
  ok(player.hits.filter((x) => x.type === 'void').length >= 1, 'drain resumes once surfaced');
  ok(e.health > h0, 'self-heal resumes once surfaced');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
