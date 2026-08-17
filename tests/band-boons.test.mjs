// tests/band-boons.test.mjs
// Every band gives something back (issue #36). Each band's upside has to be
// *reachable* and has to be a decision: a price paid in a currency only the
// debt mints, an effect stated before the press, and something else the same
// mark could have bought instead.
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { BOON, PACTS, RUIN, SYNERGIES, marksMinted, synergyPlan } from '../src/data/bandBoons.js';
import { BANDS } from '../src/data/corruption.js';
import { ArgentFont, MultishopTerminal, VoidBargain } from '../src/world/Interactables.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true });

/**
 * A world with a real `Corruption` and an `Items` stub carrying only what the
 * altar touches: the inventory queries, the conversion, the buff slot and the
 * purse. The stub records buffs so a test can assert the effect landed rather
 * than only that the press returned true.
 */
function makeCtx({ blight = [], bases = [], gold = 500 } = {}) {
  const listeners = new Map();
  const events = [];
  const buffs = new Map();
  const held = new Map(bases.map((id) => [id, 1]));
  const items = {
    gold,
    buffs,
    corrupted: [],
    spendGold(c) { if (this.gold < c) return false; this.gold -= c; return true; },
    blightHeld: () => new Set(blight),
    convertibleStacks: () => new Map(held.size ? [...held.keys()].map((id) => [id, CONVERT[id]]) : []),
    corruptStack(id) { if (!held.has(id)) return false; held.delete(id); blight.push(CONVERT[id]); this.corrupted.push(id); return true; },
    addBuff(name, duration, maxStacks = 1, magnitude = 1) { buffs.set(name, { duration, maxStacks, magnitude }); },
    stabilise() {},
    rollItem: () => 'cured-haunch',
  };
  const ctx = {
    authority: true,
    seed: 12345,
    player: P(),
    events: {
      emit(name, p) { events.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    items,
    interactables: { list: [] },
    vfx: null, audio: null,
  };
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, items, events };
}

// The base -> blight pairing the stub needs, taken from the real catalogue so
// the fixture cannot drift from `BLIGHT_BY_BASE`.
const { BLIGHT_BY_BASE } = await import('../src/data/items.js');
const CONVERT = Object.fromEntries([...BLIGHT_BY_BASE].map(([base, b]) => [base, b.id]));

const altar = (ctx) => new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 0);
/** Push the world to the start of `band` and return the ctx. */
const toBand = (ctx, band) => { ctx.corruption.feed(ctx.player, BANDS[band].at); return ctx; };

console.log('the currency is minted by the debt and by nothing else');
{
  ok(marksMinted(0) === 0 && marksMinted(BOON.markPer - 1) === 0, 'a shallow run holds nothing');
  ok(marksMinted(BOON.markPer) === 1 && marksMinted(BOON.markPer * 3.9) === 3, 'one mark per markPer of debt');
  ok(marksMinted(-40) === 0 && marksMinted(NaN) === 0 && marksMinted(Infinity) === 0,
    'nonsense mints nothing rather than NaN marks');

  const { ctx } = makeCtx();
  ok(ctx.corruption.marks === 0, 'a pristine run has no purse');
  ctx.corruption.feed(ctx.player, 100);
  ok(ctx.corruption.marks === marksMinted(100), 'feeding mints');
  // The point of a *peak* mint: laundering does not refund the descent.
  ctx.corruption.bleed(ctx.player, 100);
  ok(ctx.corruption.world === 0 && ctx.corruption.marks === marksMinted(100),
    'cleansing back to pristine keeps what the descent minted');
  ok(ctx.corruption.spendMarks(2) === true && ctx.corruption.marks === marksMinted(100) - 2, 'spending debits');
  ok(ctx.corruption.spendMarks(99) === false, 'and cannot overdraw');
  ctx.corruption.feed(ctx.player, 400);
  ok(ctx.corruption.marks === marksMinted(400) - 2, 'a deeper peak mints more, and the spend stays spent');
}

console.log('marks are host-authoritative like every other corruption state');
{
  const { ctx } = makeCtx();
  ctx.corruption.feed(ctx.player, 200);
  ctx.authority = false;
  const before = ctx.corruption.marks;
  ok(ctx.corruption.spendMarks(1) === false && ctx.corruption.marks === before, 'a client cannot spend');
  ok(ctx.corruption.ruin() === false && ctx.corruption.ruined === false, 'nor ruin the run');
}

console.log('Pristine offers nothing, and says so instead of pretending');
{
  const { ctx } = makeCtx();
  const a = altar(ctx);
  ok(a.offer() === null, 'no offer below Seeded');
  ok(a.available() === false, 'and the altar is not lit');
  ok(a.interact() === false, 'a press on a dormant altar does nothing');
  ok(a.prompt().includes('dormant'), `the prompt says why ("${a.prompt()}")`);
}

console.log('Seeded: a mark re-draws the terminals');
{
  const { ctx } = makeCtx();
  toBand(ctx, 1);
  ctx.corruption.feed(ctx.player, 10);   // over the first markPer threshold
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(3, 0, 0), 25, [], 0);
  ctx.interactables.list.push(shop);
  const a = altar(ctx);
  const offer = a.offer();
  ok(offer?.kind === 'reroll' && offer.marks === BOON.reroll.marks, 'Seeded offers the reroll');
  ok(a.prompt().includes('re-draw') && a.prompt().includes('mark'),
    `the prompt names the effect and the price ("${a.prompt().split('\n')[0]}")`);
  shop.itemId = 'pry-bar';
  const marks = ctx.corruption.marks;
  ok(a.interact(ctx.player) === true, 'the press succeeds');
  ok(ctx.corruption.marks === marks - BOON.reroll.marks, 'and costs exactly the quoted mark');
  ok(shop.itemId === 'cured-haunch', 'the terminal is holding something else now');
  ok(a.offer() === null, 'and with the purse empty there is no second reroll');
  ok(ctx.items.gold === 500, 'no gold anywhere in the bargain - this is the corruption-only currency');
}

console.log('Blighted: the synergy is named before anything is converted');
{
  const syn = SYNERGIES[0];
  const [have, want] = syn.needs;
  const base = [...BLIGHT_BY_BASE].find(([, b]) => b.id === want)[0];
  const { ctx, items } = makeCtx({ blight: [have], bases: [base] });
  toBand(ctx, 2);
  const a = altar(ctx);
  const offer = a.offer();
  ok(offer?.kind === 'synergy' && offer.plan.synergy.id === syn.id, 'the plan finds the one-step synergy');
  const text = a.prompt();
  ok(text.includes(syn.name) && text.includes(syn.blurb) && text.toLowerCase().includes('corrupts'),
    `the preview names the synergy, what it does and what it costs ("${text.replace(/\n/g, ' / ')}")`);
  ok(items.corrupted.length === 0, 'and nothing has been converted by looking at it');
  const marks = ctx.corruption.marks;
  ok(a.interact(ctx.player) === true, 'the press succeeds');
  ok(items.corrupted[0] === base, 'the previewed stack, and only it, was converted');
  ok(ctx.corruption.marks === marks - BOON.synergy.marks, 'at the quoted price');
  const b = items.buffs.get(syn.grant.buff);
  ok(!!b && b.magnitude === syn.grant.magnitude, 'and the synergy is live');
}

console.log('a Blighted pack with no completable set is refused, not sold a lie');
{
  const { ctx } = makeCtx({ blight: [], bases: [] });
  toBand(ctx, 2);
  const a = altar(ctx);
  ok(a.offer() === null && a.interact() === false, 'nothing one step away, nothing on offer');
  ok(synergyPlan(new Set(), new Map()) === null, 'and the planner says so rather than guessing');
}

console.log('Overrun: a pact costs marks and fresh debt, and can carry you deeper');
{
  const { ctx, items } = makeCtx();
  toBand(ctx, 3);
  const a = altar(ctx);
  const offer = a.offer();
  ok(offer?.kind === 'pact' && PACTS.includes(offer.pact), 'Overrun offers one named pact');
  ok(a.prompt().includes(offer.pact.name) && a.prompt().includes(`+${BOON.pact.debt} corruption`),
    `the prompt prices the debt half too ("${a.prompt().split('\n')[0]}")`);
  const world = ctx.corruption.world;
  ok(a.interact(ctx.player) === true, 'the press succeeds');
  // Against the mint rather than against the old purse: the pact's own debt
  // deepens the peak, so it partly re-mints what it just charged. That is the
  // honest reading of a bargain paid for in corruption, and it is why the
  // assertion is written against `marksMinted(peak)`.
  ok(ctx.corruption.marks === marksMinted(ctx.corruption.peak) - BOON.pact.marks, 'the marks are spent');
  ok(ctx.corruption.world === world + BOON.pact.debt, 'and the debt is charged - a pact is not free');
  const b = items.buffs.get(offer.pact.buff);
  ok(!!b && b.duration === BOON.pact.seconds, 'the pact is temporary, exactly as long as it says');
  ok(ctx.corruption.seeds.length === 1, 'a pact is a greed act and leaves a mark on the ground');
}

console.log('Consumed: the last chance is free, total, and one-way');
{
  const { ctx, items, events } = makeCtx();
  toBand(ctx, 4);
  const a = altar(ctx);
  ok(a.offer()?.kind === 'ruin', 'Consumed offers only ruin - the shallower bargains are gone');
  ok(a.prompt().includes('final') && a.prompt().includes('no cleansing after this'),
    'and the prompt states the irreversible half before the press');
  const marks = ctx.corruption.marks;
  ok(a.interact(ctx.player) === true, 'the press succeeds');
  ok(ctx.corruption.marks === marks, 'ruin costs no marks - it is charged in the run');
  for (const b of RUIN.buffs) ok(items.buffs.get(b.buff)?.magnitude === b.magnitude, `${b.buff} is live`);
  ok(events.some((e) => e.name === 'voidRuin'), 'the finale is told (issue #37 reads this)');
  ok(a.interact(ctx.player) === false && a.available() === false, 'and it happens exactly once');

  // The consequence, where it stops being prompt text.
  const font = new ArgentFont(ctx, new THREE.Vector3(2, 0, 0), 0);
  ok(font.available() === false, 'a ruined run has no Argent Font');
  ok(font.interact(ctx.player) === false && ctx.items.gold === 500, 'and the press is refused before the gold');
  ok(ctx.corruption.ruin() === false, 'the door does not re-open');
}

console.log('the offers replace each other rather than stacking into a menu');
{
  const seen = new Set();
  for (const band of [1, 2, 3, 4]) {
    const syn = SYNERGIES[0];
    const base = [...BLIGHT_BY_BASE].find(([, b]) => b.id === syn.needs[1])[0];
    const { ctx } = makeCtx({ blight: [syn.needs[0]], bases: [base] });
    // Mint a purse deep enough for any price, then cleanse back to the band
    // under test: the peak keeps the marks, so this isolates the band from the
    // purse rather than confounding the two.
    ctx.corruption.feed(ctx.player, BANDS[BANDS.length - 1].at);
    ctx.corruption.bleed(ctx.player, ctx.corruption.world - BANDS[band].at);
    ctx.interactables.list.push(new MultishopTerminal(ctx, new THREE.Vector3(3, 0, 0), 25, [], 0));
    const kind = altar(ctx).offer()?.kind;
    ok(!!kind && !seen.has(kind), `band ${band} (${BANDS[band].name}) offers its own bargain: ${kind}`);
    seen.add(kind);
  }
  ok(seen.size === 4, 'four bands, four distinct upsides');
}

console.log('wire values are appended, never renumbered');
{
  const { ctx } = makeCtx();
  ok(altar(ctx).typeId === 15, 'voidBargain is wire value 15');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
