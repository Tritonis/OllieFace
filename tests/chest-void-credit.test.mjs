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
      rollItem() { return 'syringe'; },
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
  ok(ctx.corruption.seeds.length === 0, 'a paid open plants no seed');
  ok(ctx.interactables.orbs.length === 1, 'the item came out');
  ok(chest.used === true, 'chest consumed');
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
