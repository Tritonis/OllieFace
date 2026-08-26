/**
 * The Tempering Anvil (issue #208) — the world-side door onto `Items.temper()`
 * (#179), which existed for four rounds with no way to reach it in real play.
 *
 * The red arm this file stands in for: before this ticket, nothing in
 * `src/world/Interactables.js` ever called `items.temper`, and the shrine bag
 * (`_populateShrines`) had no entry that could. A press against any shrine in
 * the pre-#208 tree either does nothing to a held argent/blight pair or opens
 * some *other* shrine's window — never a forge. `TemperingAnvil` is the new
 * class; the assertions below are the ones that would have failed against the
 * tree before it existed (no such export, no such prompt, no such window, no
 * consumption of the parents) and now pass against the real path.
 */
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { Interactables, TemperingAnvil, Chest } from '../src/world/Interactables.js';
import { openItemOffer } from '../src/world/itemTransaction.js';
import { ITEMS_BY_TIER, TEMPERED_ITEMS } from '../src/data/items.js';
import { OFFER } from '../src/data/itemOffers.js';
import { ANVIL } from '../src/data/items.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ seed = 4242 } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true, seed, time: 0, netRole: 'single',
    rng: new RNG(9001),
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const inter = new Interactables();
  inter.init(ctx);
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, items, inter };
}

const anvilAt = (f) => new TemperingAnvil(f.ctx, new THREE.Vector3());
const recipe = (n) => TEMPERED_ITEMS[n].tempers;
const recipeId = (n) => TEMPERED_ITEMS[n].id;

// -------------------------------------------------------- surface & no-op

console.log('the anvil is a real, exported, host-populatable shrine');
{
  ok(typeof TemperingAnvil === 'function', 'TemperingAnvil is exported');
  const f = makeCtx();
  const anvil = anvilAt(f);
  ok(anvil.available() === true, 'it is available with nothing pressed');
  ok(/needs a warded card/.test(anvil.prompt()), 'the prompt states what tempering needs, empty-handed');
}

console.log('a press with no eligible recipe is a no-op, not a wrongful forge');
{
  const f = makeCtx();
  const anvil = anvilAt(f);
  const pawn = f.ctx.player;
  ok(anvil.interact(pawn) === false, 'the press is refused');
  ok(f.ctx.items.hasChoiceWindow() === false, 'no window opened');
  for (const t of TEMPERED_ITEMS) ok(f.ctx.items.count(t.id) === 0, `${t.id} was not granted`);
}

// ------------------------------------------------ eligibility & progress (#221)

console.log('the prompt surfaces a known-but-short recipe\'s progress without spoiling the rest');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const { argent, blight: argentUnusedBlight } = recipe(0);
  items.give(argent, 1);
  // A minimal profile stub: only the argent parent of recipe 0 has ever been
  // met. `isDiscovered` is the only surface the anvil reads.
  f.ctx.profile = { isDiscovered: (kind, id) => kind === 'item' && id === argent };
  const anvil = anvilAt(f);
  const text = anvil.prompt();
  ok(!/needs a warded card/.test(text), 'the empty-handed generic line is gone once something is known');
  ok(text.includes(TEMPERED_ITEMS[0].name), 'the known recipe is named');
  const other = TEMPERED_ITEMS.find((t) => t.id !== recipeId(0));
  ok(!text.includes(other.name), 'a recipe nobody has met stays out of the prompt entirely');
  ok(!anvil._states().some((r) => r.id === other.id), 'the state model itself omits the undiscovered recipe');
}

console.log('an undiscovered ledger with no items held keeps the generic, spoiler-free prompt');
{
  const f = makeCtx();
  f.ctx.profile = { isDiscovered: () => false };
  const anvil = anvilAt(f);
  ok(/needs a warded card/.test(anvil.prompt()), 'nothing known, nothing named');
  ok(anvil._states().length === 0, 'the state model surfaces nothing');
}

console.log('holding both parents is eligible and takes priority over any known-but-short line');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const { argent, blight } = recipe(0);
  items.give(argent, 1);
  items.give(blight, 1);
  f.ctx.profile = { isDiscovered: () => false };
  const anvil = anvilAt(f);
  const text = anvil.prompt();
  ok(/forge/.test(text), 'an eligible recipe reads as forgeable');
  ok(text.includes(TEMPERED_ITEMS[0].name), 'names the eligible recipe');
  ok(anvil._states().find((r) => r.id === recipeId(0)).state === 'eligible', 'the state model agrees it is eligible');
}

// ----------------------------------------------------------- single recipe

console.log('exactly one eligible recipe opens a confirm-style window with a forge and a decline card');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const pawn = f.ctx.player;
  const { argent, blight } = recipe(0);
  items.give(argent, 1);
  items.give(blight, 1);
  const anvil = anvilAt(f);
  ok(/forge Tempered/.test(anvil.prompt()) || anvil.prompt().includes(TEMPERED_ITEMS[0].name),
    'the prompt names the forgeable recipe');
  ok(anvil.interact(pawn) === true, 'the press opens the window');
  ok(items.choiceWindowKind() === 'temper', 'a temper window is standing');
  const offer = items.mutationChoice();
  ok(offer.offers.length === 2, 'two cards: forge, and decline');
  ok(offer.offers.includes(recipeId(0)), 'the forge card names the recipe');
  ok(offer.offers.includes('temper:decline'), 'the decline card is present');
  // Nothing spent yet — a window standing is not a purchase made.
  ok(items.count(argent) === 1 && items.count(blight) === 1, 'both parents are still held while the window stands');
}

console.log('confirming the forge consumes both parents, grants the tempered card, and fires itemTempered');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const pawn = f.ctx.player;
  const { argent, blight } = recipe(1);
  items.give(argent, 3);
  items.give(blight, 2);
  const anvil = anvilAt(f);
  ok(anvil.interact(pawn) === true, 'the press opens the window');
  let tempered = null;
  const off = f.ctx.events.on('itemTempered', (e) => { tempered = e; });
  ok(items.chooseMutation(recipeId(1)) === true, 'the forge card is chosen');
  off();
  ok(items.count(argent) === 0, 'the argent parent is fully consumed');
  ok(items.count(blight) === 0, 'the blight parent is fully consumed');
  ok(items.count(recipeId(1)) === 1, 'the tempered card is granted');
  ok(tempered?.id === recipeId(1), 'itemTempered fired for the right recipe');
  ok(items.hasChoiceWindow() === false, 'the window is closed');
}

console.log('declining leaves the pack exactly as it was');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const pawn = f.ctx.player;
  const { argent, blight } = recipe(2);
  items.give(argent, 1);
  items.give(blight, 1);
  const anvil = anvilAt(f);
  ok(anvil.interact(pawn) === true, 'the press opens the window');
  ok(items.chooseMutation('temper:decline') === true, 'the decline card is chosen');
  ok(items.count(argent) === 1 && items.count(blight) === 1, 'both parents are untouched');
  ok(items.count(recipeId(2)) === 0, 'nothing was forged');
  ok(items.hasChoiceWindow() === false, 'the window is closed');
}

console.log('a lapsed window (silence) also leaves the pack untouched');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const pawn = f.ctx.player;
  const { argent, blight } = recipe(0);
  items.give(argent, 1);
  items.give(blight, 1);
  const anvil = anvilAt(f);
  ok(anvil.interact(pawn) === true, 'the press opens the window');
  for (let i = 0; i < 60 * (ANVIL.choiceSeconds + 1); i++) items.fixedUpdate(f.ctx, 1 / 60);
  ok(items.hasChoiceWindow() === false, 'the window lapsed');
  ok(items.count(argent) === 1 && items.count(blight) === 1, 'both parents are still held');
  ok(items.count(recipeId(0)) === 0, 'nothing was forged by silence');
}

// --------------------------------------------------------- multiple recipes

console.log('multiple eligible recipes open one card per recipe');
{
  const f = makeCtx();
  const items = f.ctx.items;
  const pawn = f.ctx.player;
  const r0 = recipe(0), r1 = recipe(1);
  items.give(r0.argent, 1); items.give(r0.blight, 1);
  items.give(r1.argent, 1); items.give(r1.blight, 1);
  const anvil = anvilAt(f);
  ok(anvil.interact(pawn) === true, 'the press opens the window');
  const offer = items.mutationChoice();
  ok(offer.offers.includes(recipeId(0)) && offer.offers.includes(recipeId(1)),
    'both eligible recipes have a card');
  ok(items.chooseMutation(recipeId(0)) === true, 'the first recipe is chosen');
  ok(items.count(recipeId(0)) === 1, 'it is forged');
  ok(items.count(r1.argent) === 1 && items.count(r1.blight) === 1,
    'the untouched recipe\'s parents are unaffected');
}

// ------------------------------------------------------ window discipline

console.log('the anvil press does not repaint a live chest offer out of the slot');
{
  const f = makeCtx();
  const pawn = f.ctx.player;
  const { argent, blight } = recipe(0);
  f.ctx.items.give(argent, 1);
  f.ctx.items.give(blight, 1);
  const anvil = anvilAt(f);
  const offer = openItemOffer(f.ctx, { itemId: ITEMS_BY_TIER.common[0].id, owner: pawn, seconds: OFFER.windowSeconds });
  const holder = {
    group: new THREE.Group(), position: new THREE.Vector3(), radius: 1, enabled: true,
    available: () => false, openOffer: () => (offer.resolved ? null : offer),
    answer: (outcome) => offer.resolve(outcome), update() {}, fixedUpdate() {}, dispose() {},
  };
  f.inter.list.push(holder);
  ok(f.inter.openOfferFor(pawn) === offer, 'a chest offer is standing');
  ok(anvil.interact(pawn) === false, 'the anvil press is refused while it stands');
  ok(f.ctx.items.hasChoiceWindow() === false, 'no temper window was opened over it');

  for (let i = 0; i < 60 * (OFFER.windowSeconds + 1); i++) offer.update(1 / 60);
  ok(offer.resolved === true, 'the chest offer lapses on its own clock');
  ok(anvil.interact(pawn) === true, 'the same press now succeeds — no deadlock');
  ok(f.ctx.items.choiceWindowKind() === 'temper', 'and opens the temper window');
}

console.log('a chest press does not repaint a standing temper window');
{
  const f = makeCtx();
  const pawn = f.ctx.player;
  const items = f.ctx.items;
  const { argent, blight } = recipe(0);
  items.give(argent, 1);
  items.give(blight, 1);
  const anvil = anvilAt(f);
  ok(anvil.interact(pawn) === true, 'the anvil press succeeds');
  ok(items.choiceWindowKind() === 'temper', 'a temper window is standing');

  const chest = new Chest(f.ctx, new THREE.Vector3(), 'small', 0);
  f.inter.list.push(chest);
  items.addGold?.(500);
  const goldBefore = items.gold;
  ok(chest.interact(pawn) === false, 'the chest press is refused while it stands');
  ok(items.gold === goldBefore, 'and charged no gold');
  ok(items.choiceWindowKind() === 'temper', 'the temper window is still standing');

  ok(items.chooseMutation('temper:decline') === true, 'the temper window is answered');
  ok(items.hasChoiceWindow() === false, 'the slot is free');
  ok(chest.interact(pawn) === true, 'the same chest press now succeeds — no deadlock');
}

// ------------------------------------------------------------------ co-op

console.log('a remote pawn\'s press forges for the presser only');
{
  const f = makeCtx();
  const pawn1 = f.ctx.player;
  const items1 = f.ctx.items;
  const pawn2 = { isPlayer: true, alive: true, position: new THREE.Vector3() };
  const items2 = new Items(pawn2);
  items2.init(f.ctx);
  pawn2.items = items2;

  const { argent, blight } = recipe(0);
  items1.give(argent, 1); items1.give(blight, 1);
  // pawn2 holds nothing.

  const anvil = anvilAt(f);
  ok(anvil.interact(pawn1) === true, 'pawn 1 opens the window on their own pack');
  ok(items1.choiceWindowKind() === 'temper', "pawn 1's pack has the window");
  ok(items2.choiceWindowKind() === null, "pawn 2's pack is untouched");
  ok(anvil.interact(pawn2) === false, 'pawn 2 has nothing eligible — refused');

  ok(items1.chooseMutation(recipeId(0)) === true, 'pawn 1 forges');
  ok(items1.count(recipeId(0)) === 1, 'pawn 1 holds the tempered card');
  ok(items2.count(recipeId(0)) === 0, "pawn 2's pack is untouched by pawn 1's forge");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
