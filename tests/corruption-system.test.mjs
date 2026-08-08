// tests/corruption-system.test.mjs
import { Corruption } from '../src/systems/Corruption.js';
import { BANDS, SOURCES } from '../src/data/corruption.js';
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

console.log('item pickups feed by tier through the itemPickup event');
{
  const { ctx } = makeCtx();
  ctx.player = P();
  const c = new Corruption();
  c.init(ctx);
  // Find one real item of a known tier so the test tracks the live item table.
  const common = [...ITEM_BY_ID.values()].find((i) => i.tier === 'common');
  ctx.events.emit('itemPickup', { id: common.id, count: 2 });
  ok(c.world === SOURCES.itemFeed.common * 2, `two commons feed ${SOURCES.itemFeed.common * 2} (got ${c.world})`);
  ctx.events.emit('itemPickup', { id: 'not-a-real-item', count: 1 });
  ok(c.world === SOURCES.itemFeed.common * 2 + 1, 'unknown items feed the fallback 1');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
