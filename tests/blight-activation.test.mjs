// tests/blight-activation.test.mjs
// The blight activation curve — the other half of `grace` (issue #170).
//
// The audit of 2026-08-23 filed one Critical: a mixed inventory could hold
// full-strength Argent *and* full-strength Blight at the same time, because
// only one of the two tiers had ever been wired to live world corruption. The
// claims here are the fix, and each one is written so that it can fail:
//
//   1. The two curves never both read full. Enumerated at the audit's own
//      checkpoints (0, 25, 55, 110, 190), not at a single convenient value.
//   2. Cleansing — the gauge moving *down* — measurably relinquishes a blight
//      hook's output and a bought synergy's output.
//   3. Drawbacks are charged in full at every band. This is the documented
//      decision, not an oversight: scaling both halves together would leave the
//      card's ratio identical at every world value and constrain nothing.
//   4. `Items.stats()` is memoised behind `_dirty`, and the curve moves without
//      anybody touching the inventory. The cache must follow the gauge.
import { Items } from '../src/systems/Items.js';
import {
  ARGENT, BLIGHT, grace, blightGrace, ITEM_BY_ID, ITEMS_BY_TIER, linear,
} from '../src/data/items.js';
import { SYNERGY_BY_ID } from '../src/data/bandBoons.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const CHECKPOINTS = [0, 25, 55, 110, 190];
const card = (id) => ITEM_BY_ID.get(id);
const at = (world) => ({ corruption: { world } });

function makeCtx(over = {}) {
  const listeners = new Map();
  return {
    authority: true,
    seed: 4242,
    rng: new RNG(4242),
    time: 0,
    paused: false,
    player: { isPlayer: true, alive: true, health: 100, shield: 0, stats: { maxHealth: 100, damage: 12 } },
    scene: { add() {}, remove() {} },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    audio: null,
    corruption: { world: 0 },
    ...over,
  };
}

const BASE = {
  maxHealth: 100, healthRegen: 1, moveSpeed: 7, attackSpeed: 1, damage: 12,
  critChance: 0.01, critMult: 2, armor: 0, cooldownMult: 1, jumpCount: 1,
};

/** A live Items whose gauge a test can move, with the cache watch pumped. */
function pack(over = {}) {
  const ctx = makeCtx(over);
  const items = new Items();
  items.init(ctx);
  return { ctx, items, stats: () => { items.fixedUpdate(ctx, 1 / 60); return items.stats({ ...BASE }); } };
}

/** A hook `api` that records instead of performing, gauge included. */
function makeApi(world, over = {}) {
  const rec = { damage: [], heals: [], explosions: [], health: [] };
  const api = {
    count: 1,
    procDepth: 0,
    ctx: { authority: true, corruption: { world }, vfx: { beam() {}, missile() {}, hitSpark() {} } },
    player: { isPlayer: true, health: 100, stats: { maxHealth: 100 } },
    roll: () => true,
    combat: {
      MAX_PROC_DEPTH: 4,
      nearestHostile: () => ({ position: { x: 0, y: 0, z: 0 } }),
      applyDamage: (t, d) => rec.damage.push(d),
      explode: (p, r, d) => rec.explosions.push(d),
      heal: (p, amt) => rec.heals.push(amt),
      hasStatus: () => false,
    },
    items: { baseDamage: () => 10, addBuff() {}, count: () => 0 },
    ...over,
  };
  api.rec = rec;
  return api;
}

console.log('the two curves are each other, and never both full');
{
  ok(BLIGHT.activeAt === ARGENT.fadeAt,
    `both tiers pivot on the same 110 (${BLIGHT.activeAt} / ${ARGENT.fadeAt})`);
  for (const w of CHECKPOINTS) {
    const a = grace(at(w));
    const b = blightGrace(at(w));
    ok(!(a >= 1 && b >= 1),
      `world ${w}: argent ${(a * 100).toFixed(0)}% / blight ${(b * 100).toFixed(0)}% — not both full`);
    ok(a + b <= 1 + BLIGHT.floor + 1e-9,
      `world ${w}: the pair sums to ${(a + b).toFixed(2)}, never above 1 + the blight floor`);
  }
  // The audit's balance table: Blighted is the crossing point, 50/50.
  ok(Math.abs(grace(at(55)) - 0.5) < 1e-9 && Math.abs(blightGrace(at(55)) - 0.5) < 1e-9,
    'at Blighted (55) each side pays exactly half — the curves cross on the band line');
  ok(blightGrace(at(0)) === BLIGHT.floor && grace(at(0)) === 1,
    `Pristine is argent's ceiling and blight's floor (${BLIGHT.floor})`);
  ok(blightGrace(at(190)) === 1 && grace(at(190)) === 0,
    'Consumed is the mirror of that, and neither curve runs past its end');
  // The guard has to be able to fail. Standing in for "the blight curve was
  // never wired": a payoff that ignores the gauge is the constant 1, and the
  // enumeration above must reject it at every checkpoint where argent is full.
  const unwired = () => 1;
  const wouldFail = CHECKPOINTS.filter((w) => grace(at(w)) >= 1 && unwired() >= 1);
  ok(wouldFail.length > 0,
    `RED CONTROL: with the curve removed (a constant 1) the pair reads full at ${wouldFail.join(', ')} — the enumeration above is not vacuous`);
}

console.log('a cleanse relinquishes blight power, hook by hook');
{
  // Gorging Tooth's kill heal, at Overrun and then after warding back to Seeded.
  const hook = card('gorge-tooth').hooks.onKill;
  const deep = makeApi(190); hook({}, deep);
  const clean = makeApi(20); hook({}, clean);
  ok(deep.rec.heals[0] > clean.rec.heals[0],
    `Gorging Tooth heals ${deep.rec.heals[0].toFixed(1)} at Consumed and ${clean.rec.heals[0].toFixed(1)} once warded down`);
  ok(Math.abs(clean.rec.heals[0] / deep.rec.heals[0] - blightGrace(at(20))) < 1e-9,
    'and the ratio is exactly the curve, not an unrelated nerf');

  // Rupture Gall's detonation, same shape on the damage side.
  const gall = card('rupture-gall').hooks.onHit;
  const gDeep = makeApi(110); gall({ amount: 100, position: {}, type: 'hit' }, gDeep);
  const gClean = makeApi(0); gall({ amount: 100, position: {}, type: 'hit' }, gClean);
  ok(gClean.rec.explosions[0] < gDeep.rec.explosions[0],
    `Rupture Gall detonates for ${gDeep.rec.explosions[0]} at Overrun and ${gClean.rec.explosions[0]} at Pristine`);

  // Splinter Bar's `outgoing` — a multiplier rather than a payload.
  const out = card('splinter-bar').hooks.outgoing;
  const tgt = { health: 100, maxHealth: 100 };
  const hi = out(100, tgt, {}, makeApi(190));
  const lo = out(100, tgt, {}, makeApi(0));
  ok(lo < hi, `Splinter Bar's opener pays ${hi} deep and ${lo} clean`);
  // The other end of the same card is the drawback, and it must not have moved.
  const weak = { health: 10, maxHealth: 100 };
  ok(out(100, weak, {}, makeApi(190)) === out(100, weak, {}, makeApi(0)),
    'while its execute penalty is identical at both ends of the gauge');
}

console.log('drawbacks are charged in full at every band — the documented decision');
{
  // Spasm Gland: attack speed is the payoff, the health cut is the price.
  const p = pack();
  p.items.counts.set('spasm-gland', 1);
  p.items._dirty = true;
  const clean = { ...p.stats() };
  p.ctx.corruption.world = 190;
  const deep = p.stats();
  ok(deep.attackSpeed > clean.attackSpeed,
    `the payoff followed the gauge (${clean.attackSpeed.toFixed(3)} -> ${deep.attackSpeed.toFixed(3)})`);
  ok(Math.abs(deep.maxHealth - clean.maxHealth) < 1e-9,
    `and the health cost did not (${clean.maxHealth.toFixed(1)} at both) — a cleansed blight card is weaker, not cheaper`);
  // The cost is real at the clean end rather than nominal.
  ok(clean.maxHealth < BASE.maxHealth,
    `a Pristine world still pays the full price (${clean.maxHealth.toFixed(1)} of ${BASE.maxHealth})`);
}

console.log('the memoised stat block follows the gauge');
{
  const p = pack();
  p.items.counts.set('bloat-cyst', 1);
  p.items._dirty = true;
  const first = p.stats().maxHealth;
  // Nothing below touches the inventory: no pickup, no buff, no explicit
  // invalidation. Only the world moves. This is the exact hazard the `grace`
  // note warned about, and the reason blight `stat` reads need the watch.
  p.ctx.corruption.world = 110;
  const after = p.stats().maxHealth;
  ok(after > first, `Bloat Cyst grew from ${first.toFixed(1)} to ${after.toFixed(1)} on a gauge move alone`);
  // RED CONTROL: with the watch bypassed the cache hands back the stale block.
  const q = pack();
  q.items.counts.set('bloat-cyst', 1);
  q.items._dirty = true;
  const before = q.items.stats({ ...BASE }).maxHealth;
  q.ctx.corruption.world = 110;
  ok(q.items.stats({ ...BASE }).maxHealth === before,
    'RED CONTROL: without pumping fixedUpdate the memoised block is stale, so the assertion above is testing the watch and not a coincidence');
}

console.log('a bought synergy is a live reading, not a frozen number');
{
  const syn = SYNERGY_BY_ID.get('rotting-chorus');
  const p = pack({ corruption: { world: 190 } });
  const baseline = p.stats().attackSpeed;
  ok(p.items.grantSynergy(syn) === true, 'the altar records the synergy against the pack');
  const deep = p.stats().attackSpeed;
  ok(deep > baseline, `and it pays at Consumed (${baseline.toFixed(3)} -> ${deep.toFixed(3)})`);
  // The cleanse. Same run, same pack, same permanent synergy.
  p.ctx.corruption.world = 0;
  const cleansed = p.stats().attackSpeed;
  ok(cleansed < deep,
    `warding the world clean relinquishes it (${deep.toFixed(3)} -> ${cleansed.toFixed(3)})`);
  ok(cleansed > baseline,
    'without deleting it — the purchase is permanent, its strength is not');
  const expect = syn.grant.magnitude * syn.grant.maxStacks * BLIGHT.floor;
  ok(Math.abs((cleansed - baseline) - expect) < 1e-9,
    `and what survives is exactly the floor (${expect.toFixed(3)})`);
  ok(p.items.synergies().includes(syn.id), 'the pack still owns it by id');
}

console.log('every blight card is wired, and no argent card was disturbed');
{
  // Enumerated over the whole tier rather than the cards this file happens to
  // exercise: a fourteenth blight card added without a curve is the failure
  // this catches, and it is the shape the audit's own advice warns about.
  const src = ITEMS_BY_TIER.blight.map((d) => ({
    id: d.id,
    text: `${d.stat?.toString() ?? ''}${Object.values(d.hooks ?? {}).map((f) => f.toString()).join('')}`,
    desc: d.description(1),
  }));
  const unwired = src.filter((s) => !s.text.includes('blightGrace'));
  ok(unwired.length === 0, `all ${src.length} blight cards read the curve (${unwired.map((s) => s.id).join(', ') || 'none missing'})`);
  const silent = src.filter((s) => !/corrupt the world/.test(s.desc));
  ok(silent.length === 0, `and every one of them says so on the card (${silent.map((s) => s.id).join(', ') || 'none silent'})`);
  const argent = ITEMS_BY_TIER.argent.filter((d) => (d.stat?.toString() ?? '').includes('blightGrace'));
  ok(argent.length === 0, 'and nothing leaked into the argent pool');
  // Warden's Tally is still the one deliberate exception on the other side.
  ok(!card('wardens-tally').hooks.onKill.toString().includes('grace('),
    "Warden's Tally still ignores the gauge, as its own note says it must");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
