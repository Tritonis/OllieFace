// Every greed act leaves a mark (spec §1): the item-granting and shrine
// interactables plant a strength-1 blight seed on successful use, through the
// same Corruption.seed path the chests use — so greed time deepens these too.
// Real Corruption, stubbed Items — the axis under test is the mark, not the
// payout. The shrine classes are exported from Interactables.js purely so this
// test can construct them without dragging in the whole world, exactly as
// Chest already is for tests/chest-void-credit.test.mjs.
//
// HollowChime and GildedSnare also mark (their success paths call the same
// base helper) but need a live Director to summon, so they are covered by the
// helper's contract rather than constructed here.
import * as THREE from 'three';
import { MultishopTerminal, AuricCairn, IchorFont, FallowVault, MarrowKiln } from '../src/world/Interactables.js';
import { Corruption } from '../src/systems/Corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ gold = 1000 } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    player: { isPlayer: true, alive: true, health: 100, maxHealth: 100 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    items: {
      gold,
      spendGold(cost) { if (this.gold < cost) return false; this.gold -= cost; return true; },
      addGold(n) { this.gold += n; },
      rollItem() { return 'syringe'; },
      roll() { return false; },
      inventory() { return [{ id: 'syringe', count: 3, def: { id: 'syringe', tier: 'common', name: 'Syringe' } }]; },
      take() {},
    },
    interactables: { orbs: [], spawnOrb(pos, id) { this.orbs.push(id); } },
    combat: { applyDamage(target, amount) { target.health -= amount; } },
    progression: { commitToVault() {} },
    vfx: null,
    audio: null,
  };
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

console.log('a multishop purchase leaves the mark');
{
  const ctx = makeCtx({ gold: 100 });
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(2, 0, 3), 25, [], 0);
  ok(shop.interact() === true, 'purchase succeeds');
  ok(ctx.corruption.seeds.length === 1, 'one seed planted');
  ok(ctx.corruption.seeds[0]?.strength === 1, 'at chest-paid strength');
  ok(ctx.corruption.seeds[0]?.x === 2 && ctx.corruption.seeds[0]?.z === 3, 'where the terminal stands');
}

console.log('shrine uses mark the ground: cairn, font, vault, kiln');
{
  const ctx = makeCtx({ gold: 500 });
  const cairn = new AuricCairn(ctx, new THREE.Vector3(1, 0, 1), 40);
  ok(cairn.interact() === true, 'cairn use succeeds');
  const font = new IchorFont(ctx, new THREE.Vector3(2, 0, 2), 0);
  ok(font.interact() === true, 'font use succeeds');
  const vault = new FallowVault(ctx, new THREE.Vector3(3, 0, 3), 0);
  ok(vault.interact() === true, 'vault commit succeeds');
  const kiln = new MarrowKiln(ctx, new THREE.Vector3(4, 0, 4), 0);
  ok(kiln.interact() === true, 'kiln burn succeeds');
  ok(ctx.corruption.seeds.length === 4, 'four uses, four seeds');
  ok(ctx.corruption.seeds.every((s) => s.strength === 1), 'all at strength 1');
}

console.log('a refused use leaves no mark');
{
  const ctx = makeCtx({ gold: 3 });
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 25, [], 0);
  ok(shop.interact() === false, 'broke player refused');
  ctx.player.health = 10;
  const font = new IchorFont(ctx, new THREE.Vector3(), 0);
  ok(font.interact() === false, 'dying player refused by the font');
  ok(ctx.corruption.seeds.length === 0, 'no seed for a refusal');
}

console.log('greed time deepens shrine marks like chest marks');
{
  const ctx = makeCtx({ gold: 100 });
  ctx.events.emit('teleporterComplete', {});
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(5, 0, 5), 25, [], 0);
  ok(shop.interact() === true, 'greed-time purchase succeeds');
  ok(ctx.corruption.seeds[0]?.strength === 2, 'and its mark is one deeper');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
