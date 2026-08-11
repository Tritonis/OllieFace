// Real Corruption, stubbed Items — the axis under test is who pays what, not
// the loot table. Chest is exported from Interactables.js purely so this test
// can construct one without dragging in the whole world; the export changes no
// behaviour.
import * as THREE from 'three';
import { Chest } from '../src/world/Interactables.js';
import { Corruption } from '../src/systems/Corruption.js';
import { SOURCES } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ gold = 1000 } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    items: {
      gold,
      spendGold(cost) { if (this.gold < cost) return false; this.gold -= cost; return true; },
      rollItem() { return 'adrenal-syringe'; },
    },
    interactables: { orbs: [], spawnOrb(pos, id) { this.orbs.push(id); } },
    audio: null,
  };
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

console.log('a paid open spends gold and pays the tithe');
{
  const ctx = makeCtx({ gold: 100 });
  const chest = new Chest(ctx, new THREE.Vector3(4, 0, 9), 'small', 25);
  ok(chest.interact() === true, 'open succeeds');
  ok(ctx.items.gold === 75, 'gold was spent');
  ok(ctx.corruption.world === SOURCES.chestTithe.small, 'the tithe landed');
  ok(ctx.corruption.seeds.length === 1, 'every greed act plants a seed — paid opens included');
  ok(ctx.corruption.seeds[0]?.strength === 1, 'a paid open is the gentlest mark');
  ok(ctx.corruption.seeds[0]?.x === 4 && ctx.corruption.seeds[0]?.z === 9, 'planted where it happened');
  ok(ctx.interactables.orbs.length === 1, 'the item came out');
  ok(chest.used === true, 'chest consumed');
}

console.log('greed time deepens the mark on both open paths');
{
  const ctx = makeCtx({ gold: 100 });
  ctx.events.emit('teleporterComplete', {});
  const paid = new Chest(ctx, new THREE.Vector3(1, 0, 1), 'small', 25);
  ok(paid.interact() === true, 'paid open succeeds during greed time');
  ok(ctx.corruption.seeds[0]?.strength === 2, 'greed-time paid seed is strength 1 + 1');
  ctx.items.gold = 0;
  const forced = new Chest(ctx, new THREE.Vector3(2, 0, 2), 'large', 60);
  ok(forced.interact() === true, 'void credit still opens during greed time');
  ok(ctx.corruption.seeds[1]?.strength === 3, 'greed-time large void seed is strength 2 + 1');
  ctx.events.emit('stageStart', { index: 1, name: 'next' });
  ctx.items.gold = 100;
  const fresh = new Chest(ctx, new THREE.Vector3(3, 0, 3), 'small', 25);
  ok(fresh.interact() === true, 'open on the new stage');
  ok(ctx.corruption.seeds[2]?.strength === 1, 'a new stage plants gentle seeds again');
}

console.log('a broke player forces the chest open on void credit');
{
  const ctx = makeCtx({ gold: 3 });
  const chest = new Chest(ctx, new THREE.Vector3(-2, 0, 6), 'legendary', 400);
  ok(chest.interact() === true, 'the void opens it');
  ok(ctx.items.gold === 3, 'no gold taken');
  ok(ctx.corruption.world === SOURCES.voidCredit.legendary, 'the full credit price landed');
  ok(ctx.corruption.seeds.length === 1, 'and the void remembers where');
  ok(ctx.corruption.seeds[0].strength === 3, 'legendary seeds are the strongest');
  ok(ctx.interactables.orbs.length === 1, 'the item still came out');
}

console.log('the prompt tells the player which price they are about to pay');
{
  const ctx = makeCtx({ gold: 100 });
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  ok(chest.prompt().includes('$25'), 'affordable chest quotes gold');
  ctx.items.gold = 3;
  ok(/corruption/i.test(chest.prompt()), 'unaffordable chest says corruption');
}

console.log('without a corruption system, behaviour is exactly the old one');
{
  const ctx = makeCtx({ gold: 3 });
  ctx.corruption = null;
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  ok(chest.interact() === false, 'a broke player is refused, as before');
  ok(chest.used === false, 'chest untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
