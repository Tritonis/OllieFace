/**
 * Unit checks for the Blight (corruption) tier — the parts a screenshot cannot
 * show: the catalogue's pairing rules, the balance rule that no corrupted card
 * is strictly better than the card it eats, the transform's idempotency and
 * order-independence, the client mirror, and the measured drop rate.
 *
 *   node reviews/round6/C2-corruption.test.mjs
 *
 * Self-contained — fakes the event bus and the audio system, and imports the
 * real `systems/Items.js`, the real `data/items.js` and the real `core/RNG`.
 */
import { Items, DROP_TABLES } from '../../src/systems/Items.js';
import { ITEMS, ITEM_BY_ID, ITEMS_BY_TIER, TIERS, BLIGHT_ITEMS, BLIGHT_BY_BASE } from '../../src/data/items.js';
import { RNG } from '../../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

// --- fakes -----------------------------------------------------------------

function makeCtx({ authority = true, seed = 1337 } = {}) {
  const handlers = new Map();
  const log = [];
  const ctx = {
    authority,
    time: 0,
    rng: new RNG(seed),
    events: {
      on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
      emit: (n, p) => { log.push([n, p]); (handlers.get(n) || []).forEach((f) => f(p)); },
    },
    audio: { play() {} },
    player: { alive: true, health: 100, stats: {} },
  };
  ctx.log = log;
  return ctx;
}

function freshItems(opts) {
  const ctx = makeCtx(opts);
  const items = new Items();
  items.init(ctx);
  return { ctx, items };
}

/** The whole inventory as a plain sorted object, for comparing two orderings. */
const snapshot = (items) => Object.fromEntries([...items.counts.entries()].sort());

// --- 1. catalogue -----------------------------------------------------------

console.log('\n[1] catalogue');
ok(BLIGHT_ITEMS.length >= 8 && BLIGHT_ITEMS.length <= 10, `${BLIGHT_ITEMS.length} corrupted items (8-10)`);
ok(!!TIERS.blight, 'the tier exists in TIERS');
eq(TIERS.blight.weight, 0, 'blight carries no generic ladder weight');
eq(ITEMS_BY_TIER.blight.length, BLIGHT_ITEMS.length, 'every card lands in the blight pool');
ok(BLIGHT_BY_BASE.size === BLIGHT_ITEMS.length, 'one card per base — no base corrupted twice');
ok(new Set(ITEMS.map((i) => i.id)).size === ITEMS.length, 'every item id in the game is still unique');

for (const b of BLIGHT_ITEMS) {
  const base = ITEM_BY_ID.get(b.corrupts);
  ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.id), `"${b.id}" is stable kebab-case`);
  ok(!!b.name && !!b.glyph && !!b.flavour && typeof b.description === 'function',
    `"${b.id}" has name/glyph/flavour/description`);
  ok(!!base && base.tier !== 'blight', `"${b.id}" corrupts a real ordinary item ("${b.corrupts}")`);
  ok(String(b.description(1)).includes(base.name),
    `"${b.id}" names the item it consumes in its own description`);
  ok(!!(b.stat || b.hooks), `"${b.id}" actually does something`);
}
ok(new Set(BLIGHT_ITEMS.map((i) => i.glyph)).size === BLIGHT_ITEMS.length, 'every card has its own glyph');
ok(BLIGHT_ITEMS.every((i) => !ITEMS.some((o) => o !== i && o.glyph === i.glyph)),
  'no card reuses an existing item glyph');

// Branding: the tier and its cards must not borrow the reference game's names.
// See reviews/round6/BRANDING-LEDGER.md — this suite is the regression guard.
const FORBIDDEN = ['void', 'needle tick', 'safer spaces', 'newly hatched zoea', 'weeping fungus',
  'benthic bloom', "lost seer's lenses", 'plasma shrimp', 'singularity band', 'tentabauble',
  'polylute', 'voidsent flame'];
const surface = [TIERS.blight.name, ...BLIGHT_ITEMS.map((i) => `${i.id} ${i.name} ${i.flavour}`)]
  .join(' ').toLowerCase();
for (const word of FORBIDDEN) ok(!surface.includes(word), `nothing in the tier says "${word}"`);

// --- 2. balance: no corrupted card is strictly better than its base ----------
//
// "Strictly better" is checkable: build the stat block for n copies of the
// corrupted card and for n copies of its base, and require at least one field
// to come out *worse*. A card whose whole cost lives in a hook instead of the
// stat block (Arc Rot bills health per proc) has to say so in its own text.

console.log('\n[2] balance — every card pays for itself');
const BASE_BLOCK = () => ({
  maxHealth: 100, healthRegen: 1, moveSpeed: 7, attackSpeed: 1, damage: 12,
  critChance: 0.01, critMult: 2, armor: 0, cooldownMult: 1, jumpCount: 1,
  blockChance: 0, flatReduction: 0, extraCharges: 0, luck: 0, procBonus: 0,
  equipCooldownMult: 1, equipCharges: 0, noDefensive: false, noRegen: false,
  damageMult: 1, healthMult: 1, critEdge: 1,
});
// Bigger is better for all of these; anything that goes down is a cost.
const GOOD_UP = ['maxHealth', 'healthRegen', 'moveSpeed', 'attackSpeed', 'damage', 'critChance',
  'critMult', 'armor', 'blockChance', 'flatReduction', 'extraCharges', 'luck', 'procBonus',
  'damageMult', 'healthMult', 'critEdge'];

for (const b of BLIGHT_ITEMS) {
  const base = ITEM_BY_ID.get(b.corrupts);
  let paid = false;
  for (const n of [1, 3, 10]) {
    const a = BASE_BLOCK(); const c = BASE_BLOCK();
    b.stat?.(n, a);
    base.stat?.(n, c);
    if (b.stat) a.critMult = 1 + (a.critMult - 1) * a.critEdge;
    if (GOOD_UP.some((k) => a[k] < c[k]) || (a.noRegen && !c.noRegen) || (a.noDefensive && !c.noDefensive)) paid = true;
  }
  if (!paid) paid = /cost|reduced|no longer|down to/i.test(String(b.description(1)));
  ok(paid, `"${b.id}" is worse than "${b.corrupts}" on at least one axis`);
}
// The specific trap the tier exists to avoid: a card that only adds.
ok(BLIGHT_ITEMS.every((b) => /cost|reduce|no longer|more damage|-\d|less/i.test(String(b.description(1)))),
  'every card states a drawback in its own description');

// --- 3. the transform -------------------------------------------------------

console.log('\n[3] transform — both directions land in the same place');
const CARD = BLIGHT_ITEMS[0];
const BASE = CARD.corrupts;

{ // base first, then the corruption
  const { items } = freshItems();
  items.give(BASE, 3);
  eq(items.count(BASE), 3, 'base stacks up normally before any corruption is held');
  items.give(CARD.id, 1);
  eq([items.count(BASE), items.count(CARD.id)], [0, 4], 'base -> corruption on pickup');
  ok(!items.counts.has(BASE), 'the consumed id is deleted, not left at zero');
}
{ // corruption first, then the base
  const { items } = freshItems();
  items.give(CARD.id, 1);
  items.give(BASE, 3);
  eq([items.count(BASE), items.count(CARD.id)], [0, 4], 'corruption -> base converts on arrival');
}
{ // idempotency: repeat pickups in every combination
  const { items } = freshItems();
  items.give(BASE, 2);
  items.give(CARD.id, 1);
  items.give(CARD.id, 1);          // second copy, nothing left to eat
  eq([items.count(BASE), items.count(CARD.id)], [0, 4], 'a second corrupted copy just adds a stack');
  items.give(BASE, 5);             // later base pickups still convert
  eq([items.count(BASE), items.count(CARD.id)], [0, 9], 'a later base pickup still converts');
  const before = snapshot(items);
  items._settleBlight(CARD.id);
  items._settleBlight(CARD.id);
  eq(snapshot(items), before, 'settling again is a no-op');
}
{ // order-independence across the whole tier, over every permutation of a set
  const plan = [];
  for (const b of BLIGHT_ITEMS) { plan.push([b.corrupts, 2], [b.id, 1]); }
  const reference = (() => { const { items } = freshItems(); for (const [id, n] of plan) items.give(id, n); return snapshot(items); })();
  let stable = true;
  const rng = new RNG(99);
  for (let trial = 0; trial < 200; trial++) {
    const shuffled = plan.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const { items } = freshItems();
    for (const [id, n] of shuffled) items.give(id, n);
    if (JSON.stringify(snapshot(items)) !== JSON.stringify(reference)) { stable = false; break; }
  }
  ok(stable, '200 random pickup orders of all 9 pairs reach one identical inventory');
  ok(BLIGHT_ITEMS.every((b) => reference[b.id] === 3 && reference[b.corrupts] === undefined),
    'and that inventory holds only the corrupted cards');
}
{ // the stat block does not depend on pickup order either
  const both = (order) => {
    const { items } = freshItems();
    for (const id of order) items.give(id, 2);
    return items.stats(BASE_BLOCK());
  };
  const ids = BLIGHT_ITEMS.map((b) => b.id);
  const a = JSON.stringify(both([...ids, ...ids.map((_, i) => BLIGHT_ITEMS[i].corrupts)]));
  const b = JSON.stringify(both([...ids.map((_, i) => BLIGHT_ITEMS[i].corrupts), ...ids].reverse()));
  eq(a, b, 'the resulting stat block is identical under both orders');
}
{ // a client mirrors the host rather than transforming anything itself
  const { ctx, items } = freshItems({ authority: false });
  ctx.events.emit('itemPickup', { id: BASE, count: 4 });
  eq(items.count(BASE), 4, 'client adopts the host total');
  ctx.events.emit('itemPickup', { id: BASE, count: 0 });
  ok(!items.counts.has(BASE), 'a zero from the host removes the entry rather than storing a 0');
  eq(items.give(CARD.id, 1), 0, 'a client never transforms anything locally');
}

// --- 4. drop plumbing -------------------------------------------------------

console.log('\n[4] drop rates — measured, not asserted');
const N = 200000;
const rate = (bias) => {
  const { items } = freshItems();
  items.ctx.rng = new RNG(20260801);
  let hits = 0;
  for (let i = 0; i < N; i++) if (items.rollTier(bias) === 'blight') hits++;
  return hits / N;
};
const TARGET = 0.04;
for (const [label, bias] of [
  ['small chest  (object bias)', { common: 80, uncommon: 20, legendary: 1 }],
  ['large chest  (object bias)', { common: 0, uncommon: 80, legendary: 8 }],
  ['red chest    (object bias)', { common: 0, uncommon: 0, legendary: 1 }],
  ['named "small"', 'small'],
  ['named "large"', 'large'],
  ['named "legendary"', 'legendary'],
]) {
  const r = rate(bias);
  ok(Math.abs(r - TARGET) < 0.002, `${label}: blight ${(r * 100).toFixed(2)}% (target 4.00%)`);
}
for (const [label, bias] of [['named "boss"', 'boss'], ['named "lunar"', 'lunar']]) {
  ok(rate(bias) === 0, `${label}: blight 0.00% — single-source pools stay clean`);
}
ok(!!DROP_TABLES.blight, 'DROP_TABLES.blight exists for a deliberate hand-out');
{ // the roll consumes exactly one number from the gameplay stream, as before
  const { items } = freshItems();
  const rng = items.ctx.rng = new RNG(7);
  const s0 = rng.s; rng.next(); const oneDraw = rng.s;
  rng.s = s0;
  items.rollTier({ common: 80, uncommon: 20, legendary: 1 });
  eq(rng.s, oneDraw, 'rollTier still advances the RNG by exactly one draw');
}
{ // and a rolled id is a real member of the pool it claims
  const { items } = freshItems();
  let seen = 0;
  for (let i = 0; i < 5000; i++) {
    const id = items.rollItem(null, 'small');
    const def = ITEM_BY_ID.get(id);
    if (def?.tier === 'blight') seen++;
    if (!def) { seen = -1; break; }
  }
  ok(seen > 0, `rollItem returns real corrupted ids off a small chest (${seen} of 5000)`);
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
