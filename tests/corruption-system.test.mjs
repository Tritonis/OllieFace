// tests/corruption-system.test.mjs
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { BANDS, SOURCES, VOIDTOUCHED } from '../src/data/corruption.js';
import { ITEM_BY_ID } from '../src/data/items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    events: {
      emit(name, payload) {
        emitted.push({ name, payload });
        for (const fn of listeners.get(name) || []) fn(payload);
      },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
    },
  };
  return { ctx, emitted };
}

const P = () => ({ isPlayer: true, alive: true });

console.log('feeds accumulate per player and sum to world');
{
  const { ctx } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  ok(ctx.corruption === c, 'init claims ctx.corruption');
  const a = P(), b = P();
  ok(c.feed(a, 10) === 10, 'feed returns what it added');
  c.feed(b, 5);
  ok(c.corruptionOf(a) === 10 && c.corruptionOf(b) === 5, 'attribution is per player');
  ok(c.world === 15, 'world is the sum');
  ok(c.corruptionOf(P()) === 0, 'an unknown player reads zero');
}

console.log('a client cannot mutate corruption');
{
  const { ctx } = makeCtx({ authority: false });
  const c = new Corruption();
  c.init(ctx);
  ok(c.feed(P(), 50) === 0, 'feed returns 0 without authority');
  ok(c.world === 0, 'nothing accumulated');
}

console.log('bad input is inert');
{
  const { ctx } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  ok(c.feed(null, 10) === 0, 'null player');
  ok(c.feed(P(), 0) === 0, 'zero amount');
  ok(c.feed(P(), -4) === 0, 'negative amount');
  ok(c.feed(P(), NaN) === 0, 'NaN amount');
  ok(c.world === 0, 'world untouched by all of it');
}

console.log('band events fire exactly on threshold crossings');
{
  const { ctx, emitted } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  const p = P();
  c.feed(p, BANDS[1].at - 1);
  ok(c.band === 0, 'still Pristine just under T1');
  ok(!emitted.some((e) => e.name === 'corruptionBand'), 'no band event yet');
  c.feed(p, 1);
  ok(c.band === 1, 'entered Seeded');
  const bandEvents = emitted.filter((e) => e.name === 'corruptionBand');
  ok(bandEvents.length === 1, 'exactly one band event');
  ok(bandEvents[0].payload.band === 1 && bandEvents[0].payload.prev === 0, 'payload carries band and prev');
  c.feed(p, BANDS[4].at); // vaults several bands at once
  const last = emitted.filter((e) => e.name === 'corruptionBand').pop();
  ok(last.payload.band === 4, 'a vaulting feed lands on the final band');
  const changed = emitted.filter((e) => e.name === 'corruptionChanged');
  ok(changed.length === 3, 'corruptionChanged fired once per non-zero feed');
  ok(changed.every((e) => typeof e.payload.world === 'number' && typeof e.payload.band === 'number'),
    'corruptionChanged carries world and band');
}

console.log('greed time multiplies feeds between teleporterComplete and stageStart');
{
  const { ctx } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  const p = P();
  c.feed(p, 10);
  ctx.events.emit('teleporterComplete', {});
  ok(c.feed(p, 10) === 10 * SOURCES.greedMult, 'post-completion feed pays the greed multiplier');
  ctx.events.emit('stageStart', { index: 1, name: 'x' });
  ok(c.feed(p, 10) === 10, 'a new stage resets greed time');
}

console.log('seeds are recorded, broadcast, and capped');
{
  const { ctx, emitted } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  c.seed({ x: 3, y: 0, z: -7 }, 2);
  ok(c.seeds.length === 1 && c.seeds[0].x === 3 && c.seeds[0].z === -7 && c.seeds[0].strength === 2,
    'seed stores x, z, strength');
  ok(emitted.some((e) => e.name === 'blightSeed' && e.payload.x === 3), 'blightSeed event emitted');
  for (let i = 0; i < 100; i++) c.seed({ x: i, y: 0, z: 0 }, 1);
  ok(c.seeds.length === 64, 'seed list capped at 64');
  ok(c.seeds[0].x === 36, 'oldest seeds dropped first');
}

console.log('greed time deepens every seed, and the event carries the bumped strength');
{
  const { ctx, emitted } = makeCtx();
  const c = new Corruption();
  c.init(ctx);
  ctx.events.emit('teleporterComplete', {});
  c.seed({ x: 5, y: 0, z: 5 }, 2);
  ok(c.seeds[0]?.strength === 3, 'a greed-time seed is one deeper than asked');
  const ev = emitted.filter((e) => e.name === 'blightSeed').pop();
  ok(ev?.payload.strength === 3, 'the broadcast agrees with the record');
  ctx.events.emit('stageStart', { index: 1, name: 'n' });
  c.seed({ x: 6, y: 0, z: 6 }, 2);
  ok(c.seeds[1]?.strength === 2, 'a new stage plants at face value again');
}

console.log('item pickups feed by tier through the itemPickup event');
{
  const { ctx } = makeCtx();
  ctx.player = P();
  const c = new Corruption();
  c.init(ctx);
  // Find one real item of a known tier so the test tracks the live item table.
  const common = [...ITEM_BY_ID.values()].find((i) => i.tier === 'common');
  // Production shapes, copied from Items.js:_set — count is the absolute new
  // stack total, delta is the actual change. Two sequential real pickups of
  // the same item look like this on the wire.
  ctx.events.emit('itemPickup', { id: common.id, count: 1, tier: common.tier, delta: 1 });
  ctx.events.emit('itemPickup', { id: common.id, count: 2, tier: common.tier, delta: 1 });
  ok(c.world === SOURCES.itemFeed.common * 2, `two sequential real pickups feed ${SOURCES.itemFeed.common * 2} (got ${c.world})`);
  // A removal (e.g. the Marrow Kiln burning one item) must not raise corruption.
  const before = c.world;
  ctx.events.emit('itemPickup', { id: common.id, count: 1, tier: common.tier, delta: -1 });
  ok(c.world === before, 'a removal (negative delta) does not increase corruption');
  ctx.events.emit('itemPickup', { id: 'not-a-real-item', count: 1 });
  ok(c.world === before + 1, 'unknown items feed the fallback 1');
}

console.log('a client cannot plant seeds either');
{
  const { ctx, emitted } = makeCtx({ authority: false });
  const c = new Corruption();
  c.init(ctx);
  c.seed({ x: 9, y: 0, z: -3 }, 2);
  ok(c.seeds.length === 0, 'no seed stored without authority');
  ok(!emitted.some((e) => e.name === 'blightSeed'), 'no blightSeed event without authority');
}

console.log('the blight transform does not re-charge stacks already paid for');
{
  // Real Items + real Corruption on one bus — the double-charge this arm exists
  // for lived in the seam between them, and a synthetic itemPickup cannot show
  // it: only the real `_settleBlight` emits the re-stack write.
  const { ctx } = makeCtx();
  ctx.player = P();
  ctx.rng = () => { throw new Error('the corruption path must draw no rng'); };
  new Items().init(ctx);
  const c = new Corruption();
  c.init(ctx);

  for (let i = 0; i < 5; i++) ctx.items.give('adrenal-syringe', 1);
  ok(c.world === SOURCES.itemFeed.common * 5, `five commons cost ${SOURCES.itemFeed.common * 5} (got ${c.world})`);

  // Spasm Gland eats every syringe held. The card's own pickup is the whole
  // price; the five syringes were already paid for at common on arrival.
  ctx.items.give('spasm-gland', 1);
  const expected = SOURCES.itemFeed.common * 5 + SOURCES.itemFeed.blight;
  ok(c.world === expected, `the transform costs only the card: ${expected} (got ${c.world})`);
  ok(ctx.items.count('spasm-gland') === 6 && ctx.items.count('adrenal-syringe') === 0,
    'the inventory still converted all five stacks');

  // A genuine second copy of the same blight card is a real pickup and pays.
  ctx.items.give('spasm-gland', 1);
  ok(c.world === expected + SOURCES.itemFeed.blight,
    `a later real pickup of the blight card still feeds ${SOURCES.itemFeed.blight} (got ${c.world - expected})`);
}

console.log('bleed drains the gauge and walks bands back down');
{
  const { ctx } = makeCtx();
  ctx.player = P();
  const c = new Corruption();
  c.init(ctx);
  c.feed(ctx.player, 120);                       // band 3 (Overrun, at 110)
  const events = [];
  ctx.events.on('corruptionBand', (p) => events.push(p));
  const taken = c.bleed(ctx.player, 70);
  ok(taken === 70, 'bleed returns what it took');
  ok(c.world === 50, 'world dropped');
  ok(c.band === 1, 'band recomputed downward (50 is Seeded)');
  ok(events.length === 1 && events[0].band === 1 && events[0].prev === 3, 'downward crossing emitted');
  ok(c.corruptionOf(ctx.player) === 50, 'attribution followed');
  ok(c.bleed(ctx.player, 999) === 50, 'clamped to what exists');
  ok(c.world === 0, 'floor is zero');
  ok(c.bleed(ctx.player, -5) === 0 && c.bleed(ctx.player, NaN) === 0, 'junk refused');
}

console.log('a Hollowed kill refunds a fraction of the world');
{
  const { ctx } = makeCtx();
  ctx.player = P();
  const c = new Corruption();
  c.init(ctx);
  c.feed(ctx.player, 100);
  ctx.events.emit('kill', { victim: { affix: 'voidtouched' }, source: ctx.player, position: null, isElite: true, isBoss: false });
  ok(Math.abs(c.world - 100 * (1 - VOIDTOUCHED.refund)) < 1e-9, 'refund is refund-fraction of current world');
  const w = c.world;
  ctx.events.emit('kill', { victim: { affix: 'emberclad' }, source: ctx.player, position: null, isElite: true, isBoss: false });
  ctx.events.emit('kill', { victim: null, source: ctx.player, position: null, isElite: false, isBoss: false });
  ok(c.world === w, 'other kills refund nothing');
}

console.log('the refund is 8% of the world, and an artifact can bend it');
{
  const { ctx } = makeCtx();
  ctx.player = P();
  const c = new Corruption();
  c.init(ctx);
  c.feed(ctx.player, 100);
  ok(VOIDTOUCHED.refund === 0.08, 'refund re-priced to 0.08');
  ctx.events.emit('kill', { victim: { affix: 'voidtouched' }, source: ctx.player, position: null, isElite: true, isBoss: false });
  ok(Math.abs(c.world - 92) < 1e-9, `a kill against a 100-point world bleeds 8 (got ${c.world})`);

  // The artifact modifier multiplies the same fraction — the listener reads it
  // per kill, so a doubling artifact bleeds 16 off the next 100.
  const { ctx: ctx2 } = makeCtx();
  ctx2.player = P();
  ctx2.artifacts = { corruptionMods: () => ({ feed: 1, refund: 2 }) };
  const c2 = new Corruption();
  c2.init(ctx2);
  c2.feed(ctx2.player, 100);
  ctx2.events.emit('kill', { victim: { affix: 'voidtouched' }, source: ctx2.player, position: null, isElite: true, isBoss: false });
  ok(Math.abs(c2.world - (100 - 100 * VOIDTOUCHED.refund * 2)) < 1e-9,
    `the artifact refund modifier scales the bleed (got ${c2.world})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
