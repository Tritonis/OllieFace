/**
 * One panel slot, two systems that can fill it (integration review M3).
 *
 * `Menus` paints exactly one choice window. Three things open one — the blight
 * toll, the chest's three-way claim, and the Argent altar's consecration — and
 * whichever opens last paints over whichever was there. #175 made that harmless
 * for the pair it knew about by giving every window an id and making the *older*
 * decision lapse into its own safe outcome. The two windows this lane added
 * broke that symmetry, because their safe outcomes are not equal:
 *
 *  · A **blight toll** pays the same whether it is answered or not. Painting
 *    over it costs the choice and nothing else, and it arrives on the void's
 *    clock rather than a press — so it is adjudicated to paint over anything
 *    (Menus.js:2474) and nothing blocks on it. Blocking would shut the stage's
 *    loot for six seconds every band crossing.
 *  · A **chest offer** lapses to the safe claim: the item, unfed. Painting over
 *    it costs the choice, and the lid is already bought.
 *  · A **consecration** is already PAID IN MOTES when its window opens. Painting
 *    over it lapses it to card 1 — the purse spent and the choice taken away,
 *    with no way to re-offer it, because the altar is `spent`.
 *
 * So the two voluntary presses guard against each other, and the guards are
 * refusals rather than settles: the presser keeps their gold, their motes and
 * their press, and can try again a second later. The arms below check both
 * directions and — the thing a pair of mutual refusals gets wrong — that
 * neither one deadlocks: when the standing window ends, the other press works.
 *
 * Blind either guard and one arm goes red:
 *  · drop `openOfferFor(pawn)` from the altar's guard (Interactables.js ~2365)
 *    → 'the altar press is refused while a chest offer stands' goes red;
 *  · drop `choiceWindowKind() === 'argent'` from `Chest.interact`
 *    → 'the chest press is refused while a consecration stands' goes red.
 */
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { Interactables, VoidBargain, Chest } from '../src/world/Interactables.js';
import { openItemOffer } from '../src/world/itemTransaction.js';
import { MOTE, RELIQUARY } from '../src/data/bandBoons.js';
import { ITEMS_BY_TIER } from '../src/data/items.js';
import { OFFER } from '../src/data/itemOffers.js';
import { MUTATION } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A ctx with a real `Corruption`, a real `Items` and a real `Interactables`. */
function makeCtx({ seed = 4242 } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority: true, seed, time: 0, netRole: 'single',
    rng: new RNG(9001),
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { emitted.push({ name, p }); for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const inter = new Interactables();
  inter.init(ctx);
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, emitted, items, inter };
}

/** Enough motes for the reliquary rung, minted the way a run mints them. */
function withMotes(f, motes = RELIQUARY.motes) {
  f.ctx.corruption.feed(f.ctx.player, MOTE.per * motes);
  f.ctx.corruption.bleed(f.ctx.player, MOTE.per * motes);
  return f;
}

/** A chest-shaped holder for a transaction opened outside a real lid, so
 *  `_offerHolder` finds it the way it finds one. */
function holder(offer) {
  return {
    group: new THREE.Group(),
    position: new THREE.Vector3(),
    radius: 1, enabled: true,
    available: () => false,
    openOffer: () => (offer.resolved ? null : offer),
    answer: (outcome) => offer.resolve(outcome),
    update() {}, fixedUpdate() {}, dispose() {},
  };
}

const altarAt = (f, stage = 0) => new VoidBargain(f.ctx, new THREE.Vector3(), stage);

// ----------------------------------------------------------- direction one

console.log('an altar press does not repaint a live chest offer out of the slot');
{
  const f = withMotes(makeCtx());
  const altar = altarAt(f);
  const pawn = f.ctx.player;
  const offer = openItemOffer(f.ctx, {
    itemId: ITEMS_BY_TIER.common[0].id, owner: pawn, seconds: OFFER.windowSeconds,
  });
  f.inter.list.push(holder(offer));
  ok(f.inter.openOfferFor(pawn) === offer, 'a chest offer is standing');
  ok(altar.consecrationPreview().length > 1, 'and the altar has a real table to offer');

  const motesBefore = f.ctx.corruption.motes;
  ok(altar.interact(pawn) === false, 'the altar press is refused while a chest offer stands');
  ok(f.ctx.corruption.motes === motesBefore, 'and charged nothing');
  ok(altar.spent === false, 'the altar is still standing');
  ok(f.ctx.items.hasChoiceWindow() === false, 'no consecration window was opened');
  ok(f.inter.openOfferFor(pawn) === offer, "and the chest's own offer is untouched");
  ok(offer.resolved === false, 'it was not settled behind the player\'s back either');

  // ...and it is a refusal, not a deadlock: the offer's own lapse frees the slot.
  for (let i = 0; i < 60 * (OFFER.windowSeconds + 1); i++) offer.update(1 / 60);
  ok(offer.resolved === true, 'the chest offer lapses on its own clock');
  ok(f.inter.openOfferFor(pawn) === null, 'and the slot is free');
  ok(altar.interact(pawn) === true, 'the same press now succeeds — no deadlock');
  ok(f.ctx.items.hasChoiceWindow() === true, 'and opens the consecration window');
}

// ----------------------------------------------------------- direction two

console.log('a chest press does not repaint a consecration that is already paid for');
{
  const f = withMotes(makeCtx());
  const altar = altarAt(f);
  const pawn = f.ctx.player;
  const table = altar.consecrationPreview().map((c) => c.id);
  ok(table.length > 1, 'the altar offers a table');
  ok(altar.interact(pawn) === true, 'the altar press succeeds');
  ok(f.ctx.items.choiceWindowKind() === 'argent', 'an argent window is standing');
  ok(f.ctx.corruption.motes === 0, 'and the motes are already spent on it');

  const chest = new Chest(f.ctx, new THREE.Vector3(), 'small', 0);
  f.inter.list.push(chest);
  f.ctx.items.addGold?.(500);
  const goldBefore = f.ctx.items.gold;
  ok(chest.interact(pawn) === false, 'the chest press is refused while a consecration stands');
  ok(f.ctx.items.gold === goldBefore, 'and charged no gold');
  ok(chest.used !== true, 'the lid is still shut');
  ok(chest.openOffer() === null, 'no item offer was opened');
  ok(f.ctx.items.choiceWindowKind() === 'argent', 'the paid window is still standing');
  ok(table.every((id) => f.ctx.items.count(id) === 0), 'and no card has been handed over yet');

  // ...and no deadlock here either: answering the window frees the slot.
  ok(f.ctx.items.chooseMutation(table[1]) === true, 'the consecration is answered');
  ok(f.ctx.items.count(table[1]) === 1, 'the chosen card is granted');
  ok(f.ctx.items.hasChoiceWindow() === false, 'the slot is free');
  ok(chest.interact(pawn) === true, 'the same chest press now succeeds — no deadlock');
  ok(chest.openOffer() !== null, 'and its own offer is standing');
}

console.log('a lapsed consecration frees the slot too, not only an answered one');
{
  const f = withMotes(makeCtx());
  const altar = altarAt(f);
  const pawn = f.ctx.player;
  ok(altar.interact(pawn) === true, 'the altar press succeeds');
  const chest = new Chest(f.ctx, new THREE.Vector3(), 'small', 0);
  f.inter.list.push(chest);
  f.ctx.items.addGold?.(500);
  ok(chest.interact(pawn) === false, 'the chest is refused');
  for (let i = 0; i < 60 * (RELIQUARY.choiceSeconds + 1); i++) f.ctx.items.fixedUpdate(f.ctx, 1 / 60);
  ok(f.ctx.items.hasChoiceWindow() === false, 'the consecration lapses');
  ok(chest.interact(pawn) === true, 'and the chest opens after it');
}

// ------------------------------------------- the adjudicated exception

console.log('the involuntary blight toll blocks neither press');
{
  const f = makeCtx();
  const pawn = f.ctx.player;
  const items = f.ctx.items;
  // Four convertible stacks, one band crossing, one fixed step: a toll window.
  const { BLIGHT_BY_BASE } = await import('../src/data/items.js');
  for (const id of [...BLIGHT_BY_BASE.keys()].sort().slice(0, 4)) items.give(id, 2);
  f.ctx.events.emit('corruptionBand', { band: MUTATION.minBand, prev: 0 });
  items.fixedUpdate(f.ctx, 1 / 60);
  ok(items.choiceWindowKind() === 'blight', 'a blight toll is standing');

  const chest = new Chest(f.ctx, new THREE.Vector3(), 'small', 0);
  f.inter.list.push(chest);
  items.addGold?.(500);
  ok(chest.interact(pawn) === true, 'a chest still opens under it — the toll pays either way');
  ok(chest.openOffer() !== null, 'and its offer stands');
}

// --------------------------------------------------------------- m3

console.log("a stage teardown clears a guest's shadow of an open offer");
{
  const listeners = new Map();
  const ctx = {
    authority: false, seed: 1, time: 0, netRole: 'client',
    rng: new RNG(1),
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const inter = new Interactables();
  inter.init(ctx);
  ctx.events.emit('itemOfferOpened', {
    kind: 'chest', itemId: ITEMS_BY_TIER.common[0].id, offerId: 91, owner: null, seconds: 8, quote: {},
  });
  ok(inter.openOfferFor(ctx.player)?.offerId === 91, 'the guest has an offer open');
  inter.clear();
  ok(inter.openOfferFor(ctx.player) === null,
    'and the stage transition takes it down with the chest that held it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
