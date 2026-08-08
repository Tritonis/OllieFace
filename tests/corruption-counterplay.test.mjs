// tests/corruption-counterplay.test.mjs
// Counterplay is costly, never free (launch spec §1): the Argent Font bleeds
// world corruption for climbing gold, the Covenant Stone moves a teammate's
// burden onto a volunteer, and neither is a greed act — no seeds, no feeds.
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { CLEANSE, PACT } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true });

function makeCorruption({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const c = new Corruption();
  c.init(ctx);
  return { ctx, c, emitted };
}

console.log('the tuning constants exist and are sane');
{
  ok(CLEANSE.gold > 0 && CLEANSE.amount > 0 && CLEANSE.maxUses >= 1 && CLEANSE.costClimb > 1 && CLEANSE.goldGrowth > 1, 'CLEANSE shape');
  ok(PACT.share > 0 && PACT.share < 1 && PACT.maxUses >= 1, 'PACT shape');
}

console.log('transfer moves attribution and nothing else');
{
  const { c, emitted } = makeCorruption();
  const donor = P(), volunteer = P();
  c.feed(donor, 100);
  const worldBefore = c.world, bandBefore = c.band;
  const eventsBefore = emitted.length;
  const moved = c.transfer(donor, volunteer, 35);
  ok(moved === 35, 'returns what it moved');
  ok(c.corruptionOf(donor) === 65 && c.corruptionOf(volunteer) === 35, 'both ledgers moved');
  ok(c.world === worldBefore && c.band === bandBefore, 'world and band untouched');
  const pacts = emitted.slice(eventsBefore).filter((e) => e.name === 'corruptionPact');
  ok(pacts.length === 1 && pacts[0].payload.from === donor && pacts[0].payload.to === volunteer && pacts[0].payload.amount === 35, 'one pact event, correctly attributed');
  ok(!emitted.slice(eventsBefore).some((e) => e.name === 'corruptionChanged' || e.name === 'corruptionBand'), 'no world-change events for a move that changed no world');
}

console.log('transfer clamps, and refuses nonsense');
{
  const { c } = makeCorruption();
  const donor = P(), volunteer = P();
  c.feed(donor, 10);
  ok(c.transfer(donor, volunteer, 50) === 10, 'clamped to what the donor holds');
  ok(c.transfer(donor, volunteer, 5) === 0, 'an empty donor moves nothing');
  ok(c.transfer(volunteer, volunteer, 5) === 0, 'self-pact refused');
  ok(c.transfer(null, volunteer, 5) === 0 && c.transfer(donor, null, 5) === 0, 'null parties refused');
  ok(c.transfer(volunteer, donor, 0) === 0 && c.transfer(volunteer, donor, -3) === 0 && c.transfer(volunteer, donor, NaN) === 0, 'zero, negative, NaN refused');
  const enemy = { isPlayer: false, alive: true };
  c.feed(donor, 10);
  ok(c.transfer(donor, enemy, 5) === 0, 'a non-player cannot receive a pact');
  ok(c.transfer(enemy, volunteer, 5) === 0, 'a non-player cannot hand one over');
  ok(c.corruptionOf(donor) === 10 && c.corruptionOf(enemy) === 0, 'the refused pact moved nothing');
}

console.log('the ledgers stay reconciled with the world through a bleed');
{
  const sum = (c, players) => players.reduce((s, p) => s + c.corruptionOf(p), 0);
  {
    // (a) a font-style bleed paid for by someone who caused almost none of it.
    const { c } = makeCorruption();
    const payer = P(), sinnerA = P(), sinnerB = P();
    c.feed(payer, 10);
    c.feed(sinnerA, 60);
    c.feed(sinnerB, 30);
    const taken = c.bleed(payer, CLEANSE.amount);
    ok(taken === CLEANSE.amount, 'the bleed took the tuned amount from the world');
    ok(Math.abs(sum(c, [payer, sinnerA, sinnerB]) - c.world) < 1e-9,
      `Σ per-player === world after the bleed (${sum(c, [payer, sinnerA, sinnerB])} vs ${c.world})`);
    ok(c.corruptionOf(payer) === 0, 'the payer\'s own row paid first, to zero');
    const rest = CLEANSE.amount - 10;                     // spread across 60 : 30
    ok(Math.abs(c.corruptionOf(sinnerA) - (60 - rest * (60 / 90))) < 1e-9, 'the heavier sinner paid two thirds of the remainder');
    ok(Math.abs(c.corruptionOf(sinnerB) - (30 - rest * (30 / 90))) < 1e-9, 'the lighter sinner paid one third');
  }
  {
    // (b) covered entirely by the payer's own ledger — nobody else is touched.
    const { c } = makeCorruption();
    const payer = P(), mate = P();
    c.feed(payer, 80);
    c.feed(mate, 40);
    ok(c.bleed(payer, 50) === 50, 'the bleed took what was asked');
    ok(c.corruptionOf(payer) === 30, 'the payer alone was debited');
    ok(c.corruptionOf(mate) === 40, 'a covered bleed touches no one else');
    ok(Math.abs(sum(c, [payer, mate]) - c.world) < 1e-9, 'Σ per-player === world');
  }
  {
    // And draining the world empties every row: no orphan attribution left.
    const { c } = makeCorruption();
    const payer = P(), mate = P();
    c.feed(payer, 20);
    c.feed(mate, 80);
    ok(c.bleed(payer, 999) === 100, 'clamped to the world');
    ok(c.world === 0 && c.corruptionOf(payer) === 0 && c.corruptionOf(mate) === 0, 'a drained world drains every ledger');
  }
}

console.log('a client cannot transfer');
{
  const { c } = makeCorruption({ authority: false });
  const a = P(), b = P();
  ok(c.transfer(a, b, 5) === 0, 'transfer returns 0 without authority');
}

console.log('— interactables —');
const { ArgentFont, CovenantStone } = await import('../src/world/Interactables.js');

function makeWorldCtx({ gold = 1000, roster = null } = {}) {
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
    },
    vfx: null, audio: null,
  };
  if (roster) ctx.roster = roster;
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

console.log('the Argent Font bleeds the world for climbing gold');
{
  const ctx = makeWorldCtx({ gold: 1000 });
  ctx.corruption.feed(ctx.player, 100);
  const font = new ArgentFont(ctx, new THREE.Vector3(1, 0, 1), 0);
  const cost0 = font.cost;
  ok(cost0 === Math.round(CLEANSE.gold * Math.pow(CLEANSE.goldGrowth, 0)), 'stage-0 price is the base price');
  ok(font.interact() === true, 'a paid cleanse succeeds');
  ok(ctx.corruption.world === 100 - CLEANSE.amount, 'the world bled by the tuned amount');
  ok(ctx.items.gold === 1000 - cost0, 'and the gold is gone');
  ok(font.cost === Math.round(cost0 * CLEANSE.costClimb), 'the price climbed');
  ok(ctx.corruption.seeds.length === 0, 'cleansing is not a greed act — no seed');
  for (let i = font.uses; i < CLEANSE.maxUses; i++) font.interact();
  ok(font.available() === false, 'spent after maxUses');
}

console.log('the font refuses a pristine world and an empty purse');
{
  const ctx = makeWorldCtx({ gold: 1000 });
  const font = new ArgentFont(ctx, new THREE.Vector3(0, 0, 0), 0);
  ok(font.interact() === false, 'nothing to bleed, nothing charged');
  ok(ctx.items.gold === 1000, 'gold untouched by the refusal');
  ctx.corruption.feed(ctx.player, 50);
  ctx.items.gold = 1;
  ok(font.interact() === false, 'no gold, no cleanse');
  ok(ctx.corruption.world === 50, 'the world did not bleed for free');
}

console.log('the Covenant Stone moves the heaviest ledger onto the volunteer');
{
  const mateA = { isPlayer: true, alive: true, position: { x: 0, z: 0 } };
  const mateB = { isPlayer: true, alive: true, position: { x: 1, z: 0 } };
  const ctx = makeWorldCtx({ roster: { count: 3, all: [] } });
  ctx.roster.all = [ctx.player, mateA, mateB];
  ctx.corruption.feed(mateA, 40);
  ctx.corruption.feed(mateB, 80);
  const stone = new CovenantStone(ctx, new THREE.Vector3(2, 0, 2));
  ok(stone.interact() === true, 'the pact is struck');
  const share = 80 * PACT.share;
  ok(Math.abs(ctx.corruption.corruptionOf(mateB) - (80 - share)) < 1e-9, 'the heaviest teammate is relieved');
  ok(Math.abs(ctx.corruption.corruptionOf(ctx.player) - share) < 1e-9, 'the volunteer carries it now');
  ok(Math.abs(ctx.corruption.corruptionOf(mateA) - 40) < 1e-9, 'the lighter teammate untouched');
  ok(ctx.corruption.world === 120, 'world unchanged — blame moved, not absolved');
  ok(stone.available() === false, 'one covenant per stone');
  ok(ctx.corruption.seeds.length === 0, 'a pact is not a greed act — no seed');
}

console.log('solo, or a party with nothing to shoulder, is refused');
{
  const ctx = makeWorldCtx({ roster: { count: 1, all: [] } });
  ctx.roster.all = [ctx.player];
  const stone = new CovenantStone(ctx, new THREE.Vector3(0, 0, 0));
  ok(stone.interact() === false, 'no teammate, no pact');
  const ctx2 = makeWorldCtx({ roster: { count: 2, all: [] } });
  const mate = { isPlayer: true, alive: true, position: { x: 1, z: 0 } };
  ctx2.roster.all = [ctx2.player, mate];
  const stone2 = new CovenantStone(ctx2, new THREE.Vector3(0, 0, 0));
  ok(stone2.interact() === false, 'a clean teammate has nothing to hand over');
  ok(stone2.uses === 0, 'a refusal consumes no use');
}

console.log('wire values are appended, never renumbered');
{
  const font = new ArgentFont(makeWorldCtx(), new THREE.Vector3(), 0);
  const stone = new CovenantStone(makeWorldCtx(), new THREE.Vector3());
  ok(font.typeId === 13, 'argentFont is wire value 13');
  ok(stone.typeId === 14, 'covenantStone is wire value 14');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
