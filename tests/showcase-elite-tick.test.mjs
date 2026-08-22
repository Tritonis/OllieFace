// tests/showcase-elite-tick.test.mjs
//
// The showcase's elite entries claim to fire each modifier's aura on demand.
// The first version of that claim was false for exactly the three modifiers
// whose aura is the whole card: `Enemy.fixedUpdate` recomputes `distToPlayer`
// from the real player position before any aura block reads it, so writing the
// field was writing to a variable about to be overwritten, and the elite stood
// ~5 m away — outside Emberclad's 3.2 m ring and the void's 3.6 m. Nothing
// threw. Nothing happened either.
//
// So this test refuses "no exception" as evidence and asks for the damage. It
// drives a real Enemy through `forceAuraTick` itself — the same function the
// showcase calls, not a re-implementation of its recipe — and insists a tick of
// the right type landed on the player.
//
// Fixture shape borrowed from tests/voidtouched-affix.test.mjs: no ctx.combat,
// so hurtPlayer falls back to victim.takeDamage, which is the recorder here.
import * as THREE from 'three';
import { Enemy } from '../src/entities/Enemy.js';
import { Roster } from '../src/systems/Roster.js';
import { ENEMIES, ELITE_STATS } from '../src/data/enemies.js';
import { forceAuraTick } from '../src/core/Showcase.js';

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

function makeWorld() {
  const hits = [];
  const ctx = { rng: makeRng(), time: 0, scene: new THREE.Scene(), events: { emit() {}, on() {} } };
  const player = {
    isPlayer: true, alive: true, team: 'player', radius: 0.45,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    health: 110, maxHealth: 110, hits,
    takeDamage(amount, info) { hits.push({ amount, type: info?.type }); this.health -= amount; return amount; },
  };
  const roster = new Roster();
  roster.init(ctx);
  ctx.player = player;
  roster.add(player);
  // Withering asks the Director to lock healing; record the ask rather than
  // stubbing it away, since that call *is* the modifier's player-facing effect.
  const denials = [];
  ctx.director = { denyHealing: (t, who) => denials.push({ t, who }) };
  return { ctx, player, denials };
}

const scarab = ENEMIES.find((e) => e.id === 'scarab');

/**
 * Where the showcase actually stands its elite: 12 m ahead of a camera boomed
 * ~7.1 m behind the player, i.e. a bit under 5 m out. That distance is the
 * whole bug, so the fixture reproduces it rather than starting the unit
 * conveniently close.
 */
const SHOWCASE_RANGE = 4.9;

console.log('the three draining modifiers each land a tick from showcase range');
for (const [affix, type] of [['emberclad', 'burn'], ['withering', 'wither'], ['voidtouched', 'void']]) {
  const { ctx, player, denials } = makeWorld();
  const e = new Enemy();
  e.spawn(ctx, scarab, { x: SHOWCASE_RANGE, y: 0, z: 0 }, { affix });
  const before = player.health;

  const took = forceAuraTick(ctx, e, player);

  ok(took, `${affix}: forceAuraTick reports it has an aura to take`);
  const landed = player.hits.filter((x) => x.type === type);
  ok(landed.length >= 1,
    `${affix}: a '${type}' tick landed (${landed.length}), from ${SHOWCASE_RANGE} m out`);
  ok(landed[0] && landed[0].amount > 0, `${affix}: and it carried real damage`);
  ok(player.health === before, `${affix}: the evaluator's health is handed back afterwards`);
  ok(Math.abs(e.position.x - SHOWCASE_RANGE) < 1e-6 && Math.abs(e.position.z) < 1e-6,
    `${affix}: the unit is back where the lens is pointed`);
  if (affix === 'withering') ok(denials.length >= 1, 'withering: and the healing lock was asked for');
}

console.log('\nline of sight is pinned, not gambled');
{
  const { ctx, player } = makeWorld();
  const e = new Enemy();
  e.spawn(ctx, scarab, { x: SHOWCASE_RANGE, y: 0, z: 0 }, { affix: 'emberclad' });
  // A stage that reports every ray blocked. The staggered re-check would flip
  // hasLOS false on any step it fires, which is ~15% of them — a showcase that
  // works six times in seven is a showcase nobody trusts.
  ctx.stage = { raycast: () => ({ distance: 0.1 }) };
  e.losT = 0;
  forceAuraTick(ctx, e, player);
  ok(player.hits.some((x) => x.type === 'burn'),
    'the forced tick fires even on the step the LOS stagger would have re-tested');
}

console.log('\nmodifiers with no aura are reported, not faked');
for (const affix of ['galvanic', 'rimebound', 'warded']) {
  const { ctx, player } = makeWorld();
  const e = new Enemy();
  e.spawn(ctx, scarab, { x: SHOWCASE_RANGE, y: 0, z: 0 }, { affix });
  ok(forceAuraTick(ctx, e, player) === false,
    `${affix}: no aura to force — its signature is its corpse`);
  ok(player.hits.length === 0, `${affix}: and nothing was invented to stand in for one`);
}

console.log('\nthe aura set matches the table');
{
  const aura = Object.entries(ELITE_STATS)
    .filter(([, s]) => s.auraDps || s.denyRadius || s.siphonDps).map(([k]) => k);
  ok(aura.length === 3 && aura.join() === 'emberclad,withering,voidtouched',
    `exactly ${aura.length} modifiers drain: ${aura.join(', ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
