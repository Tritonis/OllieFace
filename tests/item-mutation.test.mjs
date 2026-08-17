// tests/item-mutation.test.mjs
// Real Items + real Corruption, real item data. The axis under test: the
// gauge's upward threshold crossings convert one held base stack into its
// blight counterpart, deterministically, off the shared rng, without charging.
//
// The toll is *queued* by the band crossing and paid in `Items.fixedUpdate`
// (see the `corruptionBand` listener), so every arm below drives one fixed step
// after the feed that crosses. That deferral is the point of the last strip arm:
// a pickup can cross the threshold itself, and the mutation must not run inside
// that pickup's own `itemPickup` dispatch.
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Progression } from '../src/systems/Progression.js';
import { BLIGHT_BY_BASE, ITEM_BY_ID } from '../src/data/items.js';
import { HUD } from '../src/ui/HUD.js';
import { TIER_ORDER } from '../src/ui/Icons.js';
import { MUTATION, BANDS, SOURCES } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';
import { Engine } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority, seed: 424242, rng: new RNG(777), time: 0,
    player: { isPlayer: true, alive: true },
    // Only `Progression` (in the stats arm) reaches for this; `Items` and
    // `Corruption` never touch the scene graph.
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  return { ctx, items, corruption, emitted };
}

// Two distinct base items that blight cards corrupt — from the real data, so
// the test never goes stale against the catalogue.
const bases = [...BLIGHT_BY_BASE.keys()].sort();
const baseA = bases[0], baseB = bases[1];
const blightOf = (id) => BLIGHT_BY_BASE.get(id).id;
/** One fixed step — where a crossed band's toll is actually collected. */
const step = (ctx, items) => items.fixedUpdate(ctx, 1 / 60);

console.log('crossing into minBand mutates exactly one eligible stack');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  items.give(baseB, 2);
  const worldBefore = corruption.world;
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - worldBefore);  // cross into minBand once
  step(ctx, items);
  // Two eligible stacks is a field worth choosing from, so the toll offers the
  // lever first (issue #33); refusing it is the void's own path, which is what
  // every assertion below is about.
  ok(!!items.mutationChoice(), 'the threshold offered the choice window');
  items.refuseMutation();
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 1, 'one mutation for one threshold');
  const { baseId, blightId, count, band } = mut[0].payload;
  ok(baseId === baseA || baseId === baseB, 'a held base was chosen');
  ok(blightId === blightOf(baseId), 'into its own counterpart');
  ok(band === MUTATION.minBand, 'stamped with the threshold that fired');
  ok(items.count(baseId) === 0, 'base stack gone');
  ok(items.count(blightId) === count && count > 0, 'blight stack holds the moved copies');
}

console.log('the pick ignores the shared rng stream');
{
  const a = makeCtx();
  const b = makeCtx();
  for (let i = 0; i < 7; i++) b.ctx.rng.next();          // displace B's shared stream
  for (const w of [a, b]) {
    w.items.give(baseA, 3);
    w.items.give(baseB, 2);
    w.corruption.feed(w.ctx.player, BANDS[MUTATION.minBand].at + 1);
    step(w.ctx, w.items);
    w.items.refuseMutation();                             // the void's own pick
  }
  const pick = (w) => w.emitted.find((e) => e.name === 'itemMutated')?.payload.baseId;
  ok(pick(a) !== undefined && pick(a) === pick(b), 'identical pick despite displaced ctx.rng');
}

console.log('mutation itself never feeds the gauge');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  const beforeFeed = corruption.world;                    // the give's own tier feed
  const fed = BANDS[MUTATION.minBand].at + 1 - beforeFeed;
  corruption.feed(ctx.player, fed);
  step(ctx, items);
  // Any wrongful charge for the mutation's 'corrupt' writes would land inside
  // the fixed step that pays the toll, so the only honest check is arithmetic:
  // world === exactly what was fed.
  ok(emitted.some((e) => e.name === 'itemMutated'), 'a mutation happened');
  ok(Math.abs(corruption.world - (beforeFeed + fed)) < 1e-9, 'world is exactly the feeds — the conversion charged nothing');
}

console.log('below minBand nothing mutates; downward crossings never mutate');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  corruption.feed(ctx.player, BANDS[1].at + 1);           // into band 1 only
  step(ctx, items);
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'band 1 is below the mutation floor');
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at - corruption.world + 1);  // into band 2
  step(ctx, items);
  ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'band 2 mutates');
  corruption.bleed(ctx.player, corruption.world);         // bleed to zero — bands walk down
  items.give(baseB, 2);
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1);  // reclimb into band 2
  step(ctx, items);
  ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'a reclaimed band never mutates twice');
}

console.log('a band jump crosses two thresholds and mutates twice');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  items.give(baseB, 2);
  corruption.feed(ctx.player, BANDS[3].at + 1);           // 0 -> band 3 in one lump
  // One open offer at a time: band 2 asks, and band 3 waits in the queue until
  // that answer lands rather than stacking a second card on top of it.
  step(ctx, items);
  ok(!!items.mutationChoice() && items.mutationChoice().band === 2, 'band 2 asked first');
  items.refuseMutation();
  step(ctx, items);                                       // band 3, now a field of one
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 2, 'bands 2 and 3 each took a stack');
  ok(mut[0].payload.band === 2 && mut[1].payload.band === 3, 'in threshold order');
  ok(mut[0].payload.baseId !== mut[1].payload.baseId, 'two different stacks (both were eligible)');
}

console.log('nothing eligible, nothing mutated — and no event');
{
  const { ctx, items, corruption, emitted } = makeCtx();   // empty inventory
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1);
  step(ctx, items);
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'no eligible stack, no event');
}

console.log('a client never mutates');
{
  const { ctx, items, corruption, emitted } = makeCtx({ authority: false });
  items.counts.set(baseA, 3);                              // mirror state, set directly
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
  step(ctx, items);
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'authority-gated');
  ok(items.counts.get(baseA) === 3, 'mirror untouched');
}

// The HUD end of the wire. `HUD.bind` is registration only, so it runs on a
// hand-built `this` the way tests/hud-strip-hold.test.mjs drives
// `updateStripRect` — the two DOM touches at the tail of `bind` are the only
// things stubbed, and `toast` is replaced so the assertion is on the arguments
// the handler chose rather than on rendered markup.
console.log('the HUD turns the event into a blight-tier toast');
{
  const toasts = [];
  const self = Object.create(HUD.prototype);
  self.toast = (text, tier, id) => toasts.push({ text, tier, id });
  self.refs = { inventory: { addEventListener() {} } };
  globalThis.addEventListener ??= () => {};

  const listeners = new Map();
  self.bind({
    events: {
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  });
  const fire = (p) => { for (const fn of listeners.get('itemMutated') || []) fn(p); };

  ok((listeners.get('itemMutated') || []).length === 1, 'HUD subscribes to itemMutated');

  const blightId = blightOf(baseA);
  fire({ baseId: baseA, blightId, count: 3, band: 2 });
  ok(toasts.length === 1, 'one toast per mutation');
  ok(toasts[0].tier === 'blight', `blight tier (got "${toasts[0].tier}")`);
  ok(toasts[0].id === blightId, 'the emblem is the blight card, not the base');
  const base = ITEM_BY_ID.get(baseA), blight = ITEM_BY_ID.get(blightId);
  ok(toasts[0].text.includes(base.name), `names the base ("${toasts[0].text}")`);
  ok(toasts[0].text.includes(blight.name), 'names the blight card it became');
  ok(toasts[0].text.includes('3x'), 'carries the stack size');

  // A payload naming a card that is not in the catalogue must stay silent
  // rather than toast "undefined".
  fire({ baseId: baseA, blightId: 'no-such-card', count: 1, band: 3 });
  ok(toasts.length === 1, 'an unknown blight id is refused, not printed');
}

// The strip end of the same wire. Same prototype-driving idiom, one step
// further: `onItemPickup` builds real elements, so it runs against a document
// stub holding only the DOM surface that method touches (plus a no-op canvas,
// because `itemArt` rasterises its emblem). The mutation is driven by real
// Items + real Corruption — the HUD sees exactly the two `'corrupt'` writes
// and the `itemMutated` the game emits, in the order it emits them.
function fakeDom() {
  const noop = new Proxy(function () {}, {
    get: (t, k) => (k === 'canvas' ? noop : noop),
    set: () => true,
    apply: () => noop,
  });
  const makeEl = (tag) => ({
    tagName: tag, className: '', dataset: {}, innerHTML: '', offsetWidth: 0,
    width: 0, height: 0, children: [], parent: null, _badge: null,
    classList: {
      _s: new Set(),
      add(...c) { for (const x of c) this._s.add(x); },
      remove(...c) { for (const x of c) this._s.delete(x); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    get parentElement() { return this.parent; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    get childElementCount() { return this.children.length; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() {
      const p = this.parent;
      if (p) p.children.splice(p.children.indexOf(this), 1);
      this.parent = null;
    },
    querySelector(sel) {
      if (sel !== '.item-stack') return null;
      return (this._badge ??= makeEl('b'));
    },
    getContext: () => noop,
    toDataURL: () => 'data:,',
  });
  globalThis.document ??= { createElement: (tag) => makeEl(tag) };
  globalThis.requestAnimationFrame ??= () => {};
  globalThis.addEventListener ??= () => {};
  return makeEl;
}

/** Every tile currently on the strip, walked from the tier groups. */
function stripTiles(self) {
  const out = [];
  for (const group of Object.values(self.refs.tierGroups)) {
    for (const row of group.children) for (const el of row.children) out.push(el);
  }
  return out;
}

/**
 * A HUD bound to a real game's event bus. `bind` is driven on a hand-built
 * `this` and its subscriptions are collected, then only the two inventory
 * events are forwarded from the real bus — the rest of the HUD's listeners
 * have no refs to paint into and are not what this arm is about.
 */
function bindHud(ctx, makeEl) {
  const toasts = [], cards = [];
  const self = Object.create(HUD.prototype);
  self.inv = new Map();
  self.refs = {
    inventory: { addEventListener() {} },
    tierGroups: Object.fromEntries(TIER_ORDER.map((t) => [t, makeEl('div')])),
  };
  self.menus = { showPickup: (c) => cards.push(c) };
  self.toast = (text, tier, id) => toasts.push({ text, tier, id });

  const listeners = new Map();
  // `player` rides along because the inventory listeners are owner-filtered
  // (`isLocalOwner`): the strip paints the viewer's pack, and the events the
  // real bus carries name the pawn they belong to.
  self.bind({
    player: ctx.player,
    events: { on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
  });
  for (const name of ['itemPickup', 'itemMutated']) {
    for (const fn of listeners.get(name) || []) ctx.events.on(name, fn);
  }
  return { self, toasts, cards };
}

console.log('the strip converts the stack — the zeroed tile leaves, the blight tile takes its place');
{
  const makeEl = fakeDom();
  const { ctx, items, corruption } = makeCtx();
  const { self } = bindHud(ctx, makeEl);
  const blightId = blightOf(baseA);

  items.give(baseA, 3);
  ok(self.inv.has(baseA) && self.inv.get(baseA).count === 3, 'the base stack is on the strip to begin with');

  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - corruption.world);
  step(ctx, items);

  ok(items.count(baseA) === 0 && items.count(blightId) === 3, 'the game converted the stack');
  ok(!self.inv.has(baseA), 'the zeroed base tile left the strip map');
  const ids = stripTiles(self).map((el) => el.dataset.id);
  ok(!ids.includes(baseA), `no stale base element in the strip structure (tiles: ${ids.join(', ') || 'none'})`);
  const blight = self.inv.get(blightId);
  ok(blight && blight.count === 3, 'the blight tile holds the moved copies');
  ok(blight && blight.badge.textContent === 'x3', 'and its badge reads the moved stack size');
  ok(ids.includes(blightId), 'the blight element is in the strip structure');
}

console.log('a corrupt write is not an acquisition — the mutation speaks once');
{
  const makeEl = fakeDom();
  const { ctx, items, corruption } = makeCtx();
  const { self, toasts, cards } = bindHud(ctx, makeEl);

  items.give(baseA, 3);
  const toastsBefore = toasts.length, cardsBefore = cards.length;

  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - corruption.world);
  step(ctx, items);

  const during = toasts.slice(toastsBefore);
  ok(during.length === 1, `exactly one toast for the mutation (got ${during.length}: ${during.map((t) => t.text).join(' | ')})`);
  ok(during[0]?.tier === 'blight', 'and it is the blight toast, not a pickup toast');
  ok(cards.length === cardsBefore, 'no pickup card raised for either corrupt write');
  ok(self.inv.get(blightOf(baseA))?.count === 3, 'while the strip still repainted the arriving stack');
}

// The other side of the owner filter the strip listeners now carry. On a host
// this bus also carries every remote pawn's economy (`Items.of`), and the strip
// paints one pack: the viewer's.
console.log('a teammate\'s pack never reaches the viewer\'s strip');
{
  const makeEl = fakeDom();
  const { ctx, items } = makeCtx();
  const { self, toasts, cards } = bindHud(ctx, makeEl);
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  const remoteItems = new Items(remote);
  remoteItems.init(ctx);

  remoteItems.give(baseA, 4);
  ok(!self.inv.has(baseA), 'no tile for a stack the viewer does not hold');
  ok(toasts.length === 0 && cards.length === 0, 'no toast and no pickup card for a teammate\'s loot');

  ctx.events.emit('itemMutated', {
    baseId: baseA, blightId: blightOf(baseA), count: 4, band: MUTATION.minBand, owner: remote,
  });
  ok(toasts.length === 0, 'nor for a teammate\'s pack festering');

  // …and the viewer's own writes still land, so the filter is not simply off.
  items.give(baseA, 1);
  ok(self.inv.get(baseA)?.count === 1 && toasts.length === 1, 'the viewer\'s own pickup still paints and toasts');
}

console.log('a give still toasts and still cards — non-corrupt writes are untouched');
{
  const makeEl = fakeDom();
  const { ctx, items } = makeCtx();
  const { toasts, cards } = bindHud(ctx, makeEl);
  const blightId = blightOf(baseA);

  items.give(baseA, 2);
  ok(toasts.length === 1 && cards.length === 1, 'a plain give toasts and raises its card');
  // A blight card taken on its own is an acquisition: it announces itself even
  // though settling it fires 'corrupt' writes underneath.
  items.give(blightId, 1);
  ok(toasts.some((t) => t.id === blightId), 'a taken blight card still toasts for itself');
}

// The path the whole deferral exists for: item pickups are a primary corruption
// source, so the ordinary way to cross a threshold is *on* a pickup — and the
// stack that crossed it is then the likeliest thing the band takes. Mutating
// inside that pickup's own `itemPickup` dispatch put the 'corrupt' writes in
// front of the 'give' the HUD had not seen yet, which left a tile for an item
// the player held none of, a pickup card for it, and the toasts in reverse.
console.log('a pickup that crosses the band and is then eaten by it leaves nothing behind');
{
  const makeEl = fakeDom();
  const { ctx, items, corruption } = makeCtx();
  const { self, toasts, cards } = bindHud(ctx, makeEl);
  const blightId = blightOf(baseA);

  // Park the gauge half a point under the threshold on an empty pack, so the
  // crossing is caused by the very pickup whose stack is then the only thing
  // eligible to be taken.
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at - 0.5 - corruption.world);
  const perCopy = SOURCES.itemFeed[ITEM_BY_ID.get(baseA).tier] ?? 1;
  ok(perCopy * 3 > 0.5, 'the pickup alone is enough to cross');
  items.give(baseA, 3);
  ok(corruption.band === MUTATION.minBand, 'the pickup itself crossed the threshold');
  step(ctx, items);

  ok(items.count(baseA) === 0 && items.count(blightId) === 3, 'the band took the stack that fed it');
  ok(!self.inv.has(baseA), 'no ghost entry for the emptied base');
  const ids = stripTiles(self).map((el) => el.dataset.id);
  ok(!ids.includes(baseA), `no ghost tile in the strip structure (tiles: ${ids.join(', ') || 'none'})`);
  ok(ids.includes(blightId) && self.inv.get(blightId)?.count === 3, 'the blight tile carries the moved copies');
  ok(cards.length === 1 && cards[0]?.id === baseA, `one pickup card, for the pickup that really happened (got ${cards.map((c) => c.id).join(', ') || 'none'})`);
  ok(toasts.length === 2, `two toasts: the pickup, then the mutation (got ${toasts.length}: ${toasts.map((t) => t.text).join(' | ')})`);
  ok(toasts[0]?.id === baseA && toasts[1]?.tier === 'blight',
    `in causal order (got ${toasts.map((t) => `${t.id}:${t.tier}`).join(' -> ')})`);
}

// Global Constraint 3 downstream: 'corrupt' is not an acquisition for anything
// that counts acquisitions either. `Progression` is driven here rather than
// transcribed, so the arm goes stale if that listener moves.
console.log('the run item counter does not score a mutation as an acquisition');
{
  const { ctx, items, corruption } = makeCtx();
  const prog = new Progression();
  prog.init(ctx);

  items.give(baseA, 3);
  const afterGive = prog.stats.items;
  ok(afterGive === 1, `a real pickup counts once (got ${afterGive})`);

  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - corruption.world);
  step(ctx, items);
  ok(items.count(baseA) === 0, 'the mutation ran');
  ok(prog.stats.items === afterGive,
    `the two 'corrupt' writes added nothing to the run's item count (got ${prog.stats.items})`);
}

// ---------------------------------------------------------------- the lever
// Issue #33. The scar is unchanged — something festers at every threshold —
// but at a threshold with a field worth choosing from the local player is
// offered two or three of the stacks and a short window to name one. Refusing
// it, ignoring it, dying inside it or crossing another band on top of it all
// fall through to exactly the pick the void made before the lever existed,
// which is what the determinism arms below pin down.

/** The pick `_mutateAt` makes when nobody chooses — recomputed, not observed. */
const voidPick = (seed, band, eligible) =>
  new RNG(((seed >>> 0) ^ (0x6b2f8d43 * (band + 1))) >>> 0 || 1).pick([...eligible].sort());

/** A world holding `n` distinct eligible stacks, parked one crossing from the toll. */
function atThreshold(n = 4) {
  const w = makeCtx();
  const held = bases.slice(0, n);
  for (const id of held) w.items.give(id, 2);
  w.corruption.feed(w.ctx.player, BANDS[MUTATION.minBand].at + 1 - w.corruption.world);
  step(w.ctx, w.items);
  return { ...w, held };
}

console.log('the threshold offers a choice: eligible only, at most three');
{
  ok(bases.length >= 4, `the catalogue has more eligible bases than the offer cap (${bases.length})`);
  const { items, emitted, held } = atThreshold(4);
  const offer = emitted.find((e) => e.name === 'mutationChoiceOffered');
  ok(!!offer, 'the window opened instead of paying immediately');
  const ids = offer.payload.offers.map((o) => o.baseId);
  ok(ids.length === MUTATION.choiceOffers, `capped at ${MUTATION.choiceOffers} (got ${ids.length})`);
  ok(new Set(ids).size === ids.length, 'no stack offered twice');
  ok(ids.every((id) => held.includes(id) && items.count(id) > 0), 'every offer is a held, eligible stack');
  ok(ids.every((id) => BLIGHT_BY_BASE.has(id)), 'and every one of them has a counterpart to become');
  ok(offer.payload.seconds === MUTATION.choiceSeconds, 'the window carries its own duration');
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'nothing has festered while the offer stands');
  // The card must say what the stack *becomes*: the counterpart's own effect
  // text at the stack size the player is actually holding.
  const first = offer.payload.offers[0];
  const blight = ITEM_BY_ID.get(first.blightId);
  ok(first.blightName === blight.name, 'the offer names the card it would become');
  ok(first.blightDescription && first.blightDescription === blight.description(first.count),
    `and quotes its live effect text ("${first.blightDescription}")`);
}

console.log('a field of one is no choice — a lone stack festers outright');
{
  const { items, emitted } = atThreshold(1);
  ok(!emitted.some((e) => e.name === 'mutationChoiceOffered'), 'no window for an inevitability');
  ok(emitted.some((e) => e.name === 'itemMutated'), 'the toll was paid on the spot');
  ok(!items.mutationChoice(), 'and nothing is left open');
}

console.log('choosing converts the chosen stack and only it');
{
  const { items, emitted, held } = atThreshold(4);
  const offered = emitted.find((e) => e.name === 'mutationChoiceOffered').payload.offers.map((o) => o.baseId);
  // Choose something the void would not have taken, so "the chosen stack" and
  // "the random stack" cannot be the same answer by luck.
  const dice = voidPick(424242, MUTATION.minBand, held);
  const mine = offered.find((id) => id !== dice) ?? offered[0];
  ok(mine !== dice, `the chosen stack is not the one the void wanted (${mine} vs ${dice})`);
  ok(items.chooseMutation(mine) === true, 'the choice was accepted');
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 1 && mut[0].payload.baseId === mine, 'the chosen stack is the one that festered');
  ok(mut[0].payload.chosen === true, 'and the event says the player owned it');
  ok(items.count(mine) === 0 && items.count(BLIGHT_BY_BASE.get(mine).id) === 2, 'the chosen stack moved whole');
  for (const id of held) if (id !== mine) ok(items.count(id) === 2, `${id} was left alone`);
  ok(!items.mutationChoice(), 'the window closed on the answer');
  ok(items.chooseMutation(offered[0]) === false, 'and a second answer changes nothing');
}

console.log('an offer the window never made is refused, not honoured');
{
  const { items, emitted, held } = atThreshold(4);
  const offered = emitted.find((e) => e.name === 'mutationChoiceOffered').payload.offers.map((o) => o.baseId);
  const notOffered = held.find((id) => !offered.includes(id));
  ok(items.chooseMutation(notOffered) === false, `a stack that was not on the table (${notOffered}) is refused`);
  ok(items.count(notOffered) === 2 && !!items.mutationChoice(), 'the stack survives and the window stands');
}

console.log('refusal, lapse and interruption are all the old random path');
{
  const expected = (w) => voidPick(424242, MUTATION.minBand, w.held);

  const refused = atThreshold(4);
  refused.items.refuseMutation();
  const a = refused.emitted.find((e) => e.name === 'itemMutated').payload;
  ok(a.baseId === expected(refused), `refusing takes the void's own pick (${a.baseId})`);
  ok(a.chosen === false, 'and says the player did not own it');

  // The lapse: fixed steps until the clock runs out, with nobody answering.
  const lapsed = atThreshold(4);
  for (let t = 0; t < MUTATION.choiceSeconds * 60 + 2 && lapsed.items.mutationChoice(); t++) {
    step(lapsed.ctx, lapsed.items);
  }
  ok(!lapsed.items.mutationChoice(), 'the window lapsed on its own clock');
  const b = lapsed.emitted.find((e) => e.name === 'itemMutated').payload;
  ok(b.baseId === expected(lapsed), `a lapsed window takes the same pick (${b.baseId})`);
  const closed = lapsed.emitted.find((e) => e.name === 'mutationChoiceClosed');
  ok(closed?.payload.reason === 'timeout', `and says why it closed (${closed?.payload.reason})`);
  // Not one frame early: the offer must survive the second-to-last step.
  const held = atThreshold(4);
  for (let t = 0; t < MUTATION.choiceSeconds * 60 - 2; t++) step(held.ctx, held.items);
  ok(!!held.items.mutationChoice(), 'and it does not close before its stated duration');

  // Pause-honest display clock: `Menus`' countdown reads `remaining` straight
  // off `mutationChoice()` rather than ticking its own clock, so the number a
  // paused game shows must be exactly the window's own, unmoving. The real
  // protection lives in `Engine`'s own fixed-step gate (`if (!ctx.paused)`,
  // src/core/Engine.js:603) — `Items.fixedUpdate` has no pause opinion of its
  // own — so drive a real `Engine` through real frames rather than mirroring
  // that gate with a hand-rolled `if` the test controls itself.
  const engine = new Engine({ canvas: null, seed: 424242 });
  engine.running = true;
  engine.ctx.player = { isPlayer: true, alive: true };
  const pausedItems = engine.add(new Items());
  const pausedCorruption = engine.add(new Corruption());
  const pausedHeld = bases.slice(0, 4);
  for (const id of pausedHeld) pausedItems.give(id, 2);
  pausedCorruption.feed(engine.ctx.player, BANDS[MUTATION.minBand].at + 1 - pausedCorruption.world);
  const engineStep = () => { engine.accumulator = 1 / 60; engine._frame(); };
  engineStep();
  ok(!!pausedItems.mutationChoice(), 'the threshold opened a window on the real engine too');
  const remainingAtPause = pausedItems.mutationChoice().remaining;
  engine.ctx.paused = true;
  for (let t = 0; t < 30; t++) engineStep();
  ok(pausedItems.mutationChoice().remaining === remainingAtPause,
    'remaining does not move across 30 paused engine frames');
  engine.ctx.paused = false;
  engineStep();
  ok(pausedItems.mutationChoice().remaining < remainingAtPause,
    'and resumes ticking once the engine unpauses');

  // A fresh threshold on top of an open one pays the older band the void's way
  // rather than stranding it in the queue forever.
  const spiked = atThreshold(4);
  spiked.corruption.feed(spiked.ctx.player, BANDS[3].at + 1 - spiked.corruption.world);
  step(spiked.ctx, spiked.items);
  const c = spiked.emitted.filter((e) => e.name === 'itemMutated').map((e) => e.payload);
  ok(c[0]?.band === MUTATION.minBand && c[0].baseId === expected(spiked),
    'the superseded band was paid the void\'s way');
  ok(spiked.emitted.some((e) => e.name === 'mutationChoiceClosed' && e.payload.reason === 'superseded'),
    'and said so');

  // Death and the run's end both leave the offer unanswerable.
  for (const [name, payload, reason] of [['playerDead', {}, 'death'], ['runEnd', { won: false }, 'runEnd']]) {
    const w = atThreshold(4);
    w.ctx.events.emit(name, payload);
    ok(!w.items.mutationChoice(), `${name} closes the window`);
    const d = w.emitted.find((e) => e.name === 'itemMutated')?.payload;
    ok(d?.baseId === expected(w), `${name} pays the void's pick (${d?.baseId})`);
    ok(w.emitted.some((e) => e.name === 'mutationChoiceClosed' && e.payload.reason === reason),
      `${name} closed for the stated reason`);
  }
}

console.log('a client is never asked, and neither is a teammate\'s pack');
{
  const { ctx, items, emitted } = makeCtx({ authority: false });
  items.counts.set(baseA, 3);
  items.counts.set(baseB, 2);
  ctx.events.emit('corruptionBand', { band: MUTATION.minBand, prev: 0 });
  step(ctx, items);
  ok(!emitted.some((e) => e.name === 'mutationChoiceOffered'), 'a client opens no window');
  ok(!items.mutationChoice() && items.chooseMutation(baseA) === false, 'and has nothing to answer');

  // Host-side satellite: a remote pawn's toll keeps the void-chooses path,
  // because there is no wire for a remote answer to come back on.
  const host = makeCtx();
  const remote = { isPlayer: true, alive: true, peerId: 2 };
  const sat = new Items(remote);
  sat.init(host.ctx);
  sat.give(baseA, 3);
  sat.give(baseB, 2);
  host.ctx.events.emit('corruptionBand', { band: MUTATION.minBand, prev: 0 });
  step(host.ctx, sat);
  ok(!host.emitted.some((e) => e.name === 'mutationChoiceOffered'), 'no window for a remote pawn');
  const m = host.emitted.find((e) => e.name === 'itemMutated' && e.payload.owner === remote);
  ok(!!m && m.payload.chosen === false, 'the remote toll was paid the void\'s way, and says so');
}

console.log('the HUD raises and drops the panel on the local seat only');
{
  const shown = [], hidden = [];
  const self = Object.create(HUD.prototype);
  self.toast = () => {};
  self.refs = { inventory: { addEventListener() {} } };
  self.menus = {
    showMutationChoice: (c) => shown.push(c),
    hideMutationChoice: () => hidden.push(true),
  };
  globalThis.addEventListener ??= () => {};

  const chosen = [];
  const player = { isPlayer: true };
  const listeners = new Map();
  self.bind({
    player,
    items: { chooseMutation: (id) => chosen.push(id), refuseMutation: () => chosen.push(null) },
    events: { on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
  });
  const fire = (name, p) => { for (const fn of listeners.get(name) || []) fn(p); };

  fire('mutationChoiceOffered', {
    owner: { isPlayer: true, peerId: 9 }, seconds: 6,
    offers: [{ baseId: baseA, blightId: blightOf(baseA) }],
  });
  ok(shown.length === 0, 'a teammate\'s offer never reaches this screen');

  fire('mutationChoiceOffered', {
    owner: player, seconds: MUTATION.choiceSeconds,
    offers: [{ baseId: baseA, blightId: blightOf(baseA), blightName: 'x', blightDescription: 'y', count: 2 }],
  });
  ok(shown.length === 1 && shown[0].seconds === MUTATION.choiceSeconds, 'the local offer raises the panel');
  shown[0].onPick(baseA);
  shown[0].onRefuse();
  ok(chosen[0] === baseA && chosen[1] === null, 'its buttons speak to Items, not to the panel');

  fire('mutationChoiceClosed', { owner: player, reason: 'timeout' });
  ok(hidden.length === 1, 'and the system that owns the decision closes it');
}

console.log('the mutation toast says what the pack became, not only what it lost');
{
  const toasts = [];
  const self = Object.create(HUD.prototype);
  self.toast = (text, tier, id) => toasts.push({ text, tier, id });
  self.refs = { inventory: { addEventListener() {} } };
  self.menus = { showMutationChoice() {}, hideMutationChoice() {} };
  globalThis.addEventListener ??= () => {};
  const listeners = new Map();
  self.bind({ events: { on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } } });

  const blightId = blightOf(baseA);
  const why = ITEM_BY_ID.get(blightId).description(3);
  for (const fn of listeners.get('itemMutated') || []) {
    fn({ baseId: baseA, blightId, count: 3, band: 2, chosen: true, blightDescription: why });
  }
  ok(toasts.length === 1 && toasts[0].text.includes(why), `the toast carries the effect text ("${toasts[0].text}")`);
  ok(toasts[0].text.includes('you feed the blight'), 'and reads as a decision the player made');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
