/**
 * Purity needs a verb (issue #36).
 *
 * The clean route's entire action set was: do not press the thing; pay gold at
 * a font whose price scales with the debt; and kill a Voidtouched elite, which
 * bled the world and minted nothing. Only the third is a verb at all, and it
 * paid in a smaller number. `bandBoons.js` had no Pristine entry — band 0 was a
 * hole in the table — so the reward for playing clean was the absence of a
 * punishment.
 *
 * Warding fills the hole. Corruption bled *by a player's own hand* accumulates,
 * mints argent motes, and a mote buys Sanctuary: a window in which feeding is
 * free. The shape that matters is the cycle — motes come from cleaning up a
 * mess, so the purity player is one who goes in and comes back, not one who
 * abstains — and these pin that the currency cannot be minted any other way.
 */
import { Corruption } from '../src/systems/Corruption.js';
import { MOTE, motesMinted } from '../src/data/bandBoons.js';
import { VOIDTOUCHED } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const l = new Map();
  const seen = [];
  const ctx = {
    authority: true,
    player: { isPlayer: true },
    events: {
      emit(n, p) { seen.push([n, p]); for (const fn of [...(l.get(n) || [])]) fn(p); },
      on(n, fn) { if (!l.has(n)) l.set(n, []); l.get(n).push(fn); return () => {}; },
    },
  };
  ctx.seen = seen;
  return ctx;
}

console.log('motesMinted is the mirror of marksMinted, and just as tolerant');
ok(motesMinted(MOTE.per - 1) === 0, 'short of the first boundary is no mote');
ok(motesMinted(MOTE.per) === 1, 'exactly the boundary is one');
ok(motesMinted(MOTE.per * 3.7) === 3, 'and it floors rather than rounds');
ok(motesMinted(NaN) === 0 && motesMinted(-5) === 0, 'junk reads as nothing warded');

console.log('warding is the verb: only a bleed the player caused mints');
{
  const ctx = makeCtx();
  const cor = new Corruption();
  cor.init(ctx);
  cor.feed(ctx.player, 300);
  ok(cor.motes === 0, 'feeding the void mints no motes, however deep it goes');

  cor.bleed(ctx.player, MOTE.per);
  ok(cor.warded === MOTE.per, `the ledger of warding counts the bleed (${cor.warded})`);
  ok(cor.motes === 1, 'and one mote is minted by it');

  // A bleed clamps to what exists, and warding must count what was actually
  // taken rather than what was asked for — the alternative mints a mote for
  // cleaning a world that was already clean.
  const c2 = makeCtx();
  const cor2 = new Corruption();
  cor2.init(c2);
  cor2.feed(c2.player, 10);
  cor2.bleed(c2.player, 500);
  ok(cor2.warded === 10, `an over-large bleed counts only what it took (${cor2.warded})`);

  // The mint is announced, so a HUD could one day render it.
  const minted = ctx.seen.filter(([n]) => n === 'argentMotesChanged');
  ok(minted.length === 1, `the mint fires exactly one event (${minted.length})`);
  ok(minted[0][1].motes === 1, 'carrying the new balance');
}

console.log('a Voidtouched kill is the verb in the field');
{
  const ctx = makeCtx();
  const cor = new Corruption();
  cor.init(ctx);
  cor.feed(ctx.player, 1000);
  const before = cor.warded;
  ctx.events.emit('kill', { victim: { affix: VOIDTOUCHED.affix }, source: ctx.player });
  ok(cor.warded > before, `killing a Voidtouched wards (${before} -> ${cor.warded})`);
  ok(cor.motes >= 1, 'and at this depth one kill is already worth a mote');
}

console.log('spending, and Sanctuary');
{
  const ctx = makeCtx();
  const cor = new Corruption();
  cor.init(ctx);
  cor.feed(ctx.player, 500);
  cor.bleed(ctx.player, MOTE.per * 2);
  ok(cor.motes === 2, 'two motes warded');

  ok(cor.spendMotes(3) === false, 'a purse that is short refuses, all or nothing');
  ok(cor.motes === 2, 'and takes nothing on the way out');
  ok(cor.spendMotes(1) === true, 'a purse that can pay does');
  ok(cor.motes === 1, 'and is one lighter');

  // Bleeding more cannot un-spend a mote, the same honesty `_spent` gives marks.
  cor.bleed(ctx.player, MOTE.per);
  ok(cor.motes === 2, `a later ward mints on top of the spend rather than refunding it (${cor.motes})`);

  // Sanctuary: the window in which the void takes nothing.
  const face = 20;
  ok(cor.priceOf(face) === face, 'outside sanctuary a feed costs face value');
  cor.sanctuary();
  ok(cor.sanctified === true, 'the window is open');
  ok(cor.priceOf(face) === 0, 'and inside it a feed is free');

  const worldBefore = cor.world;
  cor.feed(ctx.player, 100);
  ok(cor.world === worldBefore, `a feed inside sanctuary moves the world not at all (${cor.world})`);

  // It is a window, not a state: it closes on its own.
  cor.update(ctx, MOTE.sanctuarySeconds + 1);
  ok(cor.sanctified === false, 'and it closes when the clock runs out');
  ok(cor.priceOf(face) === face, 'after which the void charges again');
}

console.log('sanctuary is inert until someone opens it');
{
  const ctx = makeCtx();
  const cor = new Corruption();
  cor.init(ctx);
  // The one property `gate:sp` cares about: a run that never wards is the run
  // it was before this existed. `update` on a closed window touches nothing.
  cor.update(ctx, 0.016);
  ok(cor.sanctified === false && cor.motes === 0 && cor.warded === 0,
    'an untouched Corruption is exactly where it started after a frame');
  ok(cor.priceOf(7) === 7, 'and prices the same');
}

// -------------------------------------------------- the altar makes the offer

console.log('the dormant altar has something to say to a player who warded');
{
  const THREE = await import('three');
  const { VoidBargain } = await import('../src/world/Interactables.js');

  const ctx = makeCtx();
  ctx.seed = 999;
  ctx.interactables = { list: [] };
  ctx.vfx = null; ctx.audio = null;
  const cor = new Corruption();
  cor.init(ctx);
  const altar = new VoidBargain(ctx, new THREE.Vector3(), 0);

  ok(altar.offer() === null, 'a run that has neither corrupted nor warded is offered nothing');
  ok(/dormant until Seeded/.test(altar.prompt()), 'and the altar says so');

  // Go in, and come back out — the cycle the design is built around.
  cor.feed(ctx.player, 400);
  cor.bleed(ctx.player, 400);
  ok(cor.world === 0, 'the world is clean again');
  ok(cor.motes >= 1, `and the warding paid for it (${cor.motes} motes)`);

  const offer = altar.offer();
  ok(offer?.kind === 'sanctuary', `the altar now offers Sanctuary (${offer?.kind})`);
  const text = altar.prompt();
  ok(/Sanctuary/.test(text) && /argent mote/.test(text), `priced in its own currency: ${text.split('\n')[0]}`);
  ok(/feeds the void/.test(text), 'and states the effect before the press');
  ok(/worth double/.test(text), 'and names the timing decision, which is the whole choice');

  const motesBefore = cor.motes;
  ok(altar.interact(ctx.player) === true, 'the press resolves');
  ok(cor.motes === motesBefore - 1, 'one mote is spent');
  ok(cor.sanctified === true, 'and the window is open');
  const bargains = ctx.seen.filter(([n]) => n === 'voidBargain');
  ok(bargains.length === 1 && bargains[0][1].kind === 'sanctuary',
    'the run export hears about it through the same event every other bargain uses');

  // The offer must not muscle in front of the void's own bargains: a Seeded
  // party that can afford the reroll is still offered the reroll.
  const c2 = makeCtx();
  c2.seed = 4; c2.interactables = { list: [] }; c2.vfx = null; c2.audio = null;
  const cor2 = new Corruption();
  cor2.init(c2);
  const a2 = new VoidBargain(c2, new THREE.Vector3(), 0);
  cor2.feed(c2.player, 400);
  cor2.bleed(c2.player, 300);          // Seeded-ish, marks and motes both held
  ok(cor2.marks >= 1 && cor2.motes >= 1, 'both purses are full');
  // No terminals on the stage, so the reroll cannot be struck and sanctuary is
  // the honest fallback rather than a null offer.
  ok(a2.offer()?.kind === 'sanctuary', 'with no terminal to re-draw, sanctuary fills the gap');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
