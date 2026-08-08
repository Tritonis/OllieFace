// tests/item-mutation.test.mjs
// Real Items + real Corruption, real item data. The axis under test: the
// gauge's upward threshold crossings convert one held base stack into its
// blight counterpart, deterministically, off the shared rng, without charging.
import { Items } from '../src/systems/Items.js';
import { Corruption } from '../src/systems/Corruption.js';
import { BLIGHT_BY_BASE } from '../src/data/items.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
