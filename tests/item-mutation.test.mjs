// tests/item-mutation.test.mjs
// Real Items + real Corruption, real item data. The axis under test: the
// gauge's upward threshold crossings convert one held base stack into its
// blight counterpart, deterministically, off the shared rng, without charging.
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { BLIGHT_BY_BASE, ITEM_BY_ID } from '../src/data/items.js';
import { HUD } from '../src/ui/HUD.js';
import { TIER_ORDER } from '../src/ui/Icons.js';
import { MUTATION, BANDS } from '../src/data/corruption.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority, seed: 424242, rng: new RNG(777), time: 0,
    player: { isPlayer: true, alive: true },
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

console.log('crossing into minBand mutates exactly one eligible stack');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  items.give(baseB, 2);
  const worldBefore = corruption.world;
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1 - worldBefore);  // cross into minBand once
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
  // Any wrongful charge for the mutation's 'corrupt' writes would land
  // synchronously inside this feed (the mutation runs inside the band event),
  // so the only honest check is arithmetic: world === exactly what was fed.
  ok(emitted.some((e) => e.name === 'itemMutated'), 'a mutation happened');
  ok(Math.abs(corruption.world - (beforeFeed + fed)) < 1e-9, 'world is exactly the feeds — the conversion charged nothing');
}

console.log('below minBand nothing mutates; downward crossings never mutate');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  corruption.feed(ctx.player, BANDS[1].at + 1);           // into band 1 only
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'band 1 is below the mutation floor');
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at - corruption.world + 1);  // into band 2
  ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'band 2 mutates');
  corruption.bleed(ctx.player, corruption.world);         // bleed to zero — bands walk down
  items.give(baseB, 2);
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1);  // reclimb into band 2
  ok(emitted.filter((e) => e.name === 'itemMutated').length === 1, 'a reclaimed band never mutates twice');
}

console.log('a band jump crosses two thresholds and mutates twice');
{
  const { ctx, items, corruption, emitted } = makeCtx();
  items.give(baseA, 3);
  items.give(baseB, 2);
  corruption.feed(ctx.player, BANDS[3].at + 1);           // 0 -> band 3 in one lump
  const mut = emitted.filter((e) => e.name === 'itemMutated');
  ok(mut.length === 2, 'bands 2 and 3 each took a stack');
  ok(mut[0].payload.band === 2 && mut[1].payload.band === 3, 'in threshold order');
  ok(mut[0].payload.baseId !== mut[1].payload.baseId, 'two different stacks (both were eligible)');
}

console.log('nothing eligible, nothing mutated — and no event');
{
  const { ctx, corruption, emitted } = makeCtx();          // empty inventory
  corruption.feed(ctx.player, BANDS[MUTATION.minBand].at + 1);
  ok(!emitted.some((e) => e.name === 'itemMutated'), 'no eligible stack, no event');
}

console.log('a client never mutates');
{
  const { ctx, items, corruption, emitted } = makeCtx({ authority: false });
  items.counts.set(baseA, 3);                              // mirror state, set directly
  ctx.events.emit('corruptionBand', { band: 4, prev: 0 });
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
  self.bind({ events: { on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } } });
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

  const during = toasts.slice(toastsBefore);
  ok(during.length === 1, `exactly one toast for the mutation (got ${during.length}: ${during.map((t) => t.text).join(' | ')})`);
  ok(during[0]?.tier === 'blight', 'and it is the blight toast, not a pickup toast');
  ok(cards.length === cardsBefore, 'no pickup card raised for either corrupt write');
  ok(self.inv.get(blightOf(baseA))?.count === 3, 'while the strip still repainted the arriving stack');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
