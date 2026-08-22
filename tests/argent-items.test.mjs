// tests/argent-items.test.mjs
// The Argent Reliquary's card pool (issue #36, third pass; plan §5, Lane B).
//
// Six claims, and the first two are the ones that make the lane mergeable on
// its own:
//   1. `argent` is a tier no ordinary roll can reach — not from any entry in
//      `DROP_TABLES`, not from a bare bias object, not over 10 000 draws.
//   2. `grace` reads LIVE world corruption, so every payoff has to ride a hook
//      rather than `stat()`, which is frame-cached behind `_dirty`. The proof
//      is a payoff that changes when the gauge moves and nothing else does —
//      no pickup, no buff, no cache invalidation of any kind.
//   3. Each card fades to nothing at Overrun and pays in full at Pristine.
//   4. The Chime is dead outside a Sanctuary and off the host.
//   5. Pale Standard's pair bonus is exactly 1.5x its own multiplier bonus.
//   6. `rollArgent()` is host-only and draws nothing on a client.
import { Items, DROP_TABLES } from '../src/systems/Items.js';
import {
  ARGENT, grace, ITEM_BY_ID, ITEMS_BY_TIER, TIERS, linear, hyperbolic,
} from '../src/data/items.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(over = {}) {
  const listeners = new Map();
  return {
    authority: true,
    seed: 4242,
    rng: new RNG(4242),
    time: 0,
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    audio: null,
    ...over,
  };
}

const card = (id) => ITEM_BY_ID.get(id);

/**
 * A hook `api` with every cross-system call recorded rather than performed.
 * `ctx.corruption.world` is a plain mutable field so a test can move the gauge
 * between two calls of the same hook and nothing else changes.
 */
function makeApi(over = {}) {
  const rec = { buffs: [], damage: [], bleeds: [], gold: 0 };
  const api = {
    count: 1,
    procDepth: 0,
    ctx: {
      authority: true,
      corruption: { world: 0, sanctified: false, bleed: (p, amt) => rec.bleeds.push(amt) },
      vfx: { beam() {} },
    },
    player: { isPlayer: true },
    roll: (p) => { rec.lastRoll = p; return p > 0.5; },
    combat: {
      nearestHostile: () => ({ position: { x: 0, y: 0, z: 0 } }),
      applyDamage: (t, d) => rec.damage.push(d),
    },
    items: {
      _held: new Map(),
      addBuff: (name, dur, max, mag) => rec.buffs.push({ name, dur, max, mag }),
      baseDamage: () => 10,
      count: (id) => api.items._held.get(id) || 0,
      addGold: (n) => { rec.gold += n; },
    },
    ...over,
  };
  api.rec = rec;
  return api;
}

console.log('the argent tier exists in both tables and carries five cards');
{
  ok(TIERS.argent?.weight === 0, 'argent sits at weight 0 in the tier table');
  // #140's silver, replacing the interim pale blue. The three-table agreement
  // is proved in `tests/readability-gate`; this literal is here so that a
  // change to the data layer alone still trips something local.
  ok(TIERS.argent?.css === '#9fa5a6', `and takes the silver (${TIERS.argent?.css})`);
  const pool = ITEMS_BY_TIER.argent || [];
  ok(pool.length === 5, `five argent cards (${pool.length})`);
  const want = ['wardens-tally', 'quicksilver-vein', 'unblemished-plate', 'chime-of-absolution', 'pale-standard'];
  ok(want.every((id) => card(id)?.tier === 'argent'), 'all five named cards are in the tier');
  // The frame-cache rule, asserted over the whole pool rather than card by
  // card, so a sixth card added later cannot quietly opt into `stat()`.
  ok(pool.every((i) => typeof i.stat !== 'function'),
     'no argent card defines stat() — every payoff rides a hook');
  ok(pool.every((i) => i.hooks && Object.keys(i.hooks).length > 0), 'and every one of them has hooks');
}

console.log('no ordinary roll can reach the tier');
{
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true };
  const items = new Items();
  items.init(ctx);

  const tables = [...Object.keys(DROP_TABLES), null, { common: 1, uncommon: 1, legendary: 1 }, { legendary: 4 }];
  let draws = 0, argent = 0;
  const seen = new Set();
  for (const t of tables) {
    for (let i = 0; i < 10000; i++) {
      const tier = items.rollTier(t);
      draws++;
      seen.add(tier);
      if (tier === 'argent') argent++;
    }
  }
  ok(argent === 0, `argent never came off ${draws} rolls across ${tables.length} tables (${argent})`);
  ok(seen.has('blight'), 'and blight did, so the draw is live and the zero is not a dead loop');
  // `rollItem` is the other funnel; a tier it cannot name it cannot pay.
  let items10k = 0;
  for (let i = 0; i < 10000; i++) if (card(items.rollItem())?.tier === 'argent') items10k++;
  ok(items10k === 0, `rollItem paid no argent card over 10 000 draws (${items10k})`);
}

console.log('rollArgent is the only door, and it is host-only');
{
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true };
  const items = new Items();
  items.init(ctx);
  const id = items.rollArgent();
  ok(card(id)?.tier === 'argent', `the host draws an argent id (${id})`);

  const cctx = makeCtx({ authority: false });
  cctx.player = { isPlayer: true, alive: true };
  const cItems = new Items();
  cItems.init(cctx);
  // The RNG cursor is the thing under test: a client that drew would desync
  // the gameplay stream, so `RNG.s` must be exactly where it was left.
  const before = cctx.rng.s;
  ok(cItems.rollArgent() === null, 'a client gets null');
  ok(cctx.rng.s === before, `and never advanced ctx.rng (${before} -> ${cctx.rng.s})`);
  // The guard can fail: the same cursor, drawn from once, moves.
  cctx.rng.next();
  ok(cctx.rng.s !== before, 'and that cursor does move when something does draw from it');
}

console.log('grace is the fade, and it lands on the band boundary');
{
  ok(ARGENT.fadeAt === 110 && ARGENT.reliquary.motes === 3, 'the two dials are 110 and 3');
  const g = (w) => grace({ corruption: { world: w } });
  ok(g(0) === 1, 'Pristine pays full');
  ok(Math.abs(g(55) - 0.5) < 1e-9, `Blighted pays half (${g(55)})`);
  ok(g(110) === 0, 'Overrun pays nothing');
  ok(g(400) === 0, 'and nothing below it either');
  ok(grace(null) === 1 && grace({}) === 1, 'a missing ctx reads as clean rather than throwing');
}

console.log('grace is LIVE: the same hook pays differently when only the gauge moved');
{
  // This is the frame-cache claim, stated as an experiment. Nothing is picked
  // up, no buff changes, no `_dirty` is set, no `stats()` is called — the only
  // thing that moves between the two calls is `ctx.corruption.world`.
  const api = makeApi();
  const plate = card('unblemished-plate').hooks.onDamaged;

  plate({}, api);
  const clean = api.rec.buffs.at(-1).mag;
  api.ctx.corruption.world = 55;
  plate({}, api);
  const dirty = api.rec.buffs.at(-1).mag;
  api.ctx.corruption.world = 110;
  plate({}, api);
  const dead = api.rec.buffs.at(-1).mag;

  ok(clean === 14, `14 armour at world 0 (${clean})`);
  ok(Math.abs(dirty - 7) < 1e-9, `7 at world 55, with no cache invalidation of any kind (${dirty})`);
  ok(dead === 0, `and 0 at world 110 (${dead})`);

  // Pale Standard, the always-on card, said the same way.
  const standard = card('pale-standard').hooks.outgoing;
  const a2 = makeApi();
  const at = (w) => { a2.ctx.corruption.world = w; return standard(100, {}, {}, a2); };
  ok(at(0) === 130 && Math.abs(at(55) - 115) < 1e-9 && at(110) === 100,
     `130 / 115 / 100 across the gauge (${at(0)}, ${at(55)}, ${at(110)})`);
}

console.log("Warden's Tally pays the verb, and only the verb");
{
  const tally = card('wardens-tally').hooks.onKill;
  const api = makeApi();
  tally({ victim: { affix: 'voidtouched' } }, api);
  ok(api.rec.buffs.length === 1, 'a Voidtouched kill grants a buff');
  const b = api.rec.buffs[0];
  ok(b.name === 'frenzy' && b.dur === 8 && b.max === 3 && Math.abs(b.mag - 0.12) < 1e-9,
     `frenzy 8s x3 at 12% (${b.name} ${b.dur} ${b.max} ${b.mag})`);

  tally({ victim: { affix: null } }, api);
  tally({ victim: undefined }, api);
  tally({}, api);
  ok(api.rec.buffs.length === 1, 'an ordinary kill grants nothing');

  // Explicitly NOT grace-scaled: the rate limiter is that Voidtouched only
  // exist in a dirty world, so fading it too would be the same brake twice.
  api.ctx.corruption.world = 110;
  tally({ victim: { affix: 'voidtouched' } }, api);
  ok(Math.abs(api.rec.buffs.at(-1).mag - 0.12) < 1e-9,
     'and it still pays 12% at Overrun — this card is not grace-scaled');

  api.count = 3;
  api.ctx.corruption.world = 0;
  tally({ victim: { affix: 'voidtouched' } }, api);
  ok(Math.abs(api.rec.buffs.at(-1).mag - linear(0.12, 3)) < 1e-9, 'three stacks pay 36%');
}

console.log('Quicksilver Vein rolls a grace-scaled chance and arcs when it lands');
{
  const vein = card('quicksilver-vein').hooks.onHit;
  const rolls = [];
  const api = makeApi({ roll: (p) => { rolls.push(p); return p > 0; } });
  api.ctx.corruption.world = 0;
  vein({ position: { x: 0, y: 0, z: 0 } }, api);
  ok(Math.abs(rolls[0] - hyperbolic(0.08, 1)) < 1e-9, `full chance at Pristine (${rolls[0]})`);
  ok(api.rec.damage.length === 2 && api.rec.damage.every((d) => Math.abs(d - 16) < 1e-9),
     `two bounces at 160% of base damage (${api.rec.damage.join(', ')})`);

  api.ctx.corruption.world = 55;
  vein({ position: { x: 0, y: 0, z: 0 } }, api);
  ok(Math.abs(rolls[1] - hyperbolic(0.08, 1) * 0.5) < 1e-9, `half chance at Blighted (${rolls[1]})`);

  api.ctx.corruption.world = 110;
  api.rec.damage.length = 0;
  vein({ position: { x: 0, y: 0, z: 0 } }, api);
  ok(rolls[2] === 0 && api.rec.damage.length === 0, 'zero chance and no arc at Overrun');
}

console.log('the Chime rings only in consecrated air, and only on the host');
{
  const chime = card('chime-of-absolution').hooks.onKill;
  const api = makeApi();
  api.ctx.corruption.world = 60;

  chime({ victim: {} }, api);
  ok(api.rec.bleeds.length === 0, 'no Sanctuary, no bleed');

  api.ctx.corruption.sanctified = true;
  chime({ victim: {} }, api);
  ok(api.rec.bleeds.length === 1 && Math.abs(api.rec.bleeds[0] - 1.5) < 1e-9,
     `one bleed of 1.5 per kill inside the window (${api.rec.bleeds.join(', ')})`);

  api.count = 2;
  chime({ victim: {} }, api);
  ok(Math.abs(api.rec.bleeds[1] - 3) < 1e-9, 'two stacks ward 3');

  api.ctx.authority = false;
  chime({ victim: {} }, api);
  ok(api.rec.bleeds.length === 2, 'a client wards nothing — bleed is a host-side write');

  // A corruption system that is not there at all must not throw a kill.
  const bare = makeApi();
  bare.ctx.corruption = undefined;
  let threw = false;
  try { chime({ victim: {} }, bare); } catch { threw = true; }
  ok(!threw && bare.rec.bleeds.length === 0, 'and a run with no corruption system is inert, not fatal');
}

console.log('Pale Standard is the pair, at exactly 1.5x its own bonus');
{
  const standard = card('pale-standard').hooks.outgoing;
  const api = makeApi();
  const alone = standard(100, {}, {}, api);
  api.items._held.set('wardens-tally', 1);
  const paired = standard(100, {}, {}, api);
  ok(alone === 130, `30% alone (${alone})`);
  ok(paired === 145, `45% paired (${paired})`);
  ok(Math.abs((paired - 100) - (alone - 100) * 1.5) < 1e-9,
     'the pair bonus is exactly 1.5x the unpaired multiplier bonus');

  // The pair multiplies the *bonus*, so it fades with it.
  api.ctx.corruption.world = 110;
  ok(standard(100, {}, {}, api) === 100, 'and at Overrun even the pair pays nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
