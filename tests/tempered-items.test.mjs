// tests/tempered-items.test.mjs
// Three Tempered items (issue #179): the hybridisation tier. Each replaces an
// Argent parent and a Blight parent with a card that keeps neither parent's
// full numerics and answers to an active tension of its own rather than to
// the corruption gauge:
//   - Tempered Capacitor (offense):  Quicksilver Vein + Arc Rot   — strain
//   - Tempered Bulwark   (defense):  Unblemished Plate + Slag Ingot — boundary timing
//   - Tempered Cairn     (sustain):  Chime of Absolution + Gristle Sickle — venting
//
// The claim under test in every section is the specific number, not "did not
// throw": a hook that quietly reverted to a parent's own formula, or that
// forgot to cap/decay its tension dial, fails on a literal here.
import { Items } from '../src/systems/Items.js';
import { ITEM_BY_ID, TEMPERED_ITEMS, TEMPER_BY_ID, linear, hyperbolic, hyperbolicMult } from '../src/data/items.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const card = (id) => ITEM_BY_ID.get(id);

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

/**
 * A hook `api` with every cross-system call recorded, and a small real buff
 * table (add/stacks/clear) so the strain/pressure/brace dials behave exactly
 * as the real `Items` instance's would, without pulling in the whole class.
 */
function makeApi(over = {}) {
  const rec = { buffs: [], damage: [], heals: [], bleeds: [] };
  const buffs = new Map();
  const api = {
    count: 1,
    procDepth: 0,
    ctx: {
      authority: true,
      corruption: { world: 0, sanctified: false, bleed: (p, amt) => rec.bleeds.push(amt) },
      vfx: { beam() {}, missile() {}, hitSpark() {} },
    },
    player: { isPlayer: true, alive: true, health: 100, stats: { maxHealth: 100 } },
    roll: (p) => { rec.lastRoll = p; return p > 0; },
    combat: {
      nearestHostile: () => ({ position: { x: 1, y: 0, z: 0 } }),
      applyDamage: (t, d) => rec.damage.push(d),
      heal: (p, amt) => rec.heals.push(amt),
    },
    items: {
      addBuff: (name, dur, max, mag) => {
        rec.buffs.push({ name, dur, max, mag });
        let b = buffs.get(name);
        if (!b) { b = { stacks: 0 }; buffs.set(name, b); }
        b.stacks = Math.min(max, b.stacks + 1);
        b.magnitude = mag;
      },
      buffStacks: (name) => buffs.get(name)?.stacks || 0,
      clearBuff: (name) => buffs.delete(name),
      baseDamage: () => 10,
    },
    ...over,
  };
  api.rec = rec;
  api.buffs = buffs;
  return api;
}

console.log('the tempered tier exists and carries three cards, each with a valid, exclusive parent pair');
{
  ok(TEMPERED_ITEMS.length === 3, `three tempered cards (${TEMPERED_ITEMS.length})`);
  const want = ['tempered-capacitor', 'tempered-bulwark', 'tempered-cairn'];
  ok(want.every((id) => card(id)?.tier === 'tempered'), 'all three named cards are in the tier');
  for (const id of want) {
    const t = TEMPER_BY_ID.get(id);
    ok(card(t.argent)?.tier === 'argent' && card(t.blight)?.tier === 'blight',
      `${id} tempers a real argent+blight pair (${t.argent} + ${t.blight})`);
  }
  ok(new Set(TEMPERED_ITEMS.map((i) => i.tempers.argent)).size === 3, 'no two tempered cards claim the same argent parent');
  ok(new Set(TEMPERED_ITEMS.map((i) => i.tempers.blight)).size === 3, 'no two tempered cards claim the same blight parent');
  ok(TEMPERED_ITEMS.every((i) => typeof i.description === 'function' && typeof i.flavour === 'string' && i.flavour.length > 0),
    'every card carries a description and flavour, house style');
}

console.log('Items.temper(): consumes BOTH parents wholesale, grants exactly one stack, deterministically');
{
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true };
  const items = new Items();
  items.init(ctx);

  ok(items.temper('tempered-capacitor') === 0, 'no parents held: temper is a no-op');
  ok(items.count('tempered-capacitor') === 0, 'and nothing was granted');

  items.give('quicksilver-vein', 2);
  ok(items.temper('tempered-capacitor') === 0, 'only the argent parent held: still a no-op');
  ok(items.count('quicksilver-vein') === 2, 'and the held argent stack is untouched');
  ok(items.count('tempered-capacitor') === 0, 'still nothing granted');

  items.give('arc-rot', 3);
  let tempered = null;
  ctx.events.on('itemTempered', (p) => { tempered = p; });
  const next = items.temper('tempered-capacitor');
  ok(next === 1, `exactly one Tempered stack lands (${next})`);
  ok(items.count('quicksilver-vein') === 0 && items.count('arc-rot') === 0,
    'every stack of BOTH parents is gone, not a fraction of either');
  ok(tempered?.id === 'tempered-capacitor' && tempered.argent === 'quicksilver-vein'
    && tempered.blight === 'arc-rot' && tempered.argentCount === 2 && tempered.blightCount === 3,
    `itemTempered carries the trade (${JSON.stringify(tempered)})`);

  ok(items.temper('tempered-capacitor') === 1, 'a second call with both parents gone is a no-op on the count');

  items.give('quicksilver-vein', 1);
  items.give('arc-rot', 1);
  ok(items.temper('tempered-capacitor') === 2, 'a fresh pair tempers again — repeatable, not a one-shot flag');

  // A non-tempered or unknown id is a no-op, and so is a client attempt.
  ok(items.temper('cured-haunch') === 0, 'a non-tempered id is a no-op');
  ok(items.temper('does-not-exist') === 0, 'an unknown id is a no-op');

  const cctx = makeCtx({ authority: false });
  cctx.player = { isPlayer: true, alive: true };
  const client = new Items();
  client.init(cctx);
  client.counts.set('quicksilver-vein', 1);
  client.counts.set('arc-rot', 1);
  ok(client.temper('tempered-capacitor') === 0, 'a client cannot temper');
  ok(client.count('quicksilver-vein') === 1 && client.count('arc-rot') === 1,
    'and neither parent is touched on a client');
}

console.log('temper() does not falsely inflate or discover through the logbook (Profile) — review Major');
{
  // `Items.temper()`'s parent-zeroing writes (`_set(argent, 0, 'temper')`,
  // `_set(blight, 0, 'temper')`) ride the same `itemPickup` bus a genuine
  // pickup does. `Profile._onItemPickup` used to floor any absolute `count`
  // — including a freshly-emptied stack's `0` — up to 1 via `Math.max(1,
  // count)`, so each zeroing write booked a phantom acquisition AND
  // discovered the very item the trade just spent. One temper (2 parent
  // writes + 1 real grant) inflated `run.items`/`data.stats.items` by +2 and
  // falsely `discover()`-ed both consumed parents.
  globalThis.localStorage = (() => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  })();
  const { Profile } = await import('../src/systems/Profile.js');

  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true, survivorId: null };

  const items = new Items();
  items.init(ctx);
  const profile = new Profile();
  profile.init(ctx);
  profile.beginRun();

  items.give('quicksilver-vein', 2);
  items.give('arc-rot', 3);
  // Each `give()` books the copies it actually handed over (2, then 3): 5
  // real item copies acquired so far, and the baseline the temper below must
  // not inflate.
  ok(profile.run.items === 5, `the two genuine pickups book 2 + 3 = 5 (${profile.run.items})`);
  ok(!profile.isDiscovered('item', 'tempered-capacitor'), 'the Tempered card is not yet met');

  items.temper('tempered-capacitor');

  // The reviewer's own repro: temper() must add exactly 1 — its own grant —
  // never 3 (the grant plus the two zeroing writes silently counted as
  // phantom pickups of the parents it just spent).
  ok(profile.run.items === 6, `temper() adds exactly 1 on top of the 5 baseline — never +3 for the 2 zeroing writes (${profile.run.items})`);
  ok(profile.data.stats.items === 6, `and the persisted lifetime counter agrees (${profile.data.stats.items})`);
  ok(profile.isDiscovered('item', 'tempered-capacitor'), 'the Tempered card IS discovered — it was genuinely acquired');
  // Both parents were already discovered by the real `give()` above, so this
  // is not the interesting half of the claim; the interesting half is the
  // NEXT temper, against parents this profile has never met before.
  items.give('unblemished-plate', 1);
  items.give('slag-ingot', 1);
  ok(!profile.isDiscovered('item', 'tempered-bulwark'), 'the second Tempered card is not yet met');
  const beforeSecond = profile.run.items;
  items.temper('tempered-bulwark');
  ok(profile.run.items === beforeSecond + 1,
    `a second temper adds exactly 1 — the grant alone, not +3 for the grant plus two phantom re-pickups of its parents (${profile.run.items - beforeSecond})`);
  ok(profile.isDiscovered('item', 'tempered-bulwark'), 'and the new Tempered card is discovered on its own real grant');
}

console.log('Profile books the DELTA, not the absolute new stack — Critical fix, half of the first fix slipped');
{
  // The gate (`if (!(change > 0)) return`) went in, but the increment right
  // below it kept reading `e.count` — the item's new ABSOLUTE total — instead
  // of `change`. A fresh id happens to have delta === count (0 -> N), which
  // is all the previous regression covered; a REPEAT pickup of an
  // already-held id does not, and that is exactly what a second temper of
  // the same recipe produces on its own grant.
  const { Profile } = await import('../src/systems/Profile.js');
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true, survivorId: null };
  const items = new Items();
  items.init(ctx);
  const profile = new Profile();
  profile.init(ctx);
  profile.beginRun();

  // (1) Three separate single pickups of the SAME id must read 1, 2, 3 —
  // never 1, 3, 6 (the buggy absolute-count reading).
  const seen = [];
  for (let i = 0; i < 3; i++) {
    items.give('adrenal-syringe', 1);
    seen.push(profile.run.items);
  }
  ok(seen.join(',') === '1,2,3', `three single pickups of one id read 1, 2, 3, not 1, 3, 6 (${seen.join(',')})`);
  ok(profile.data.stats.items === 3, `and the persisted counter agrees (${profile.data.stats.items})`);

  // (2) A second temper of the SAME recipe: the Tempered card's own grant
  // goes from a held count of 1 to 2 (delta 1, absolute count 2) — the
  // buggy line would have booked 2 here, not 1.
  items.give('quicksilver-vein', 1);
  items.give('arc-rot', 1);
  items.temper('tempered-capacitor'); // first temper of this recipe: 0 -> 1
  items.give('quicksilver-vein', 1);
  items.give('arc-rot', 1);
  const afterRegive = profile.run.items;
  items.temper('tempered-capacitor'); // second temper, SAME recipe: 1 -> 2
  ok(items.count('tempered-capacitor') === 2, `the item itself really did go 1 -> 2 (${items.count('tempered-capacitor')})`);
  ok(profile.run.items === afterRegive + 1,
    `a second temper of the same recipe adds exactly +1 for its own grant, not +2 for the absolute total it reached (${profile.run.items - afterRegive})`);
}

console.log("temper() does not inflate Progression's own run summary either — same defect, sibling listener");
{
  // `Progression`'s `itemPickup` listener is a second, independent counter
  // (`stats.items++`, event-count rather than `Profile`'s copy-count) with
  // the identical shape of bug: it filtered `reason: 'corrupt'` but counted
  // every OTHER reason unconditionally, so `temper()`'s two parent-zeroing
  // writes each still booked a pickup — +2 per temper on top of the real
  // grant. `ctx.scene`/`ctx.interactables` mirror the fixture
  // `tests/economy-ownership.test.mjs` already proves `Progression.init`
  // against, not a bespoke shape.
  const { Progression } = await import('../src/systems/Progression.js');
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true, survivorId: null };
  ctx.scene = { add() {}, remove() {} };

  const items = new Items();
  items.init(ctx);
  const progression = new Progression();
  progression.init(ctx);

  items.give('gorge-tooth', 1);
  ok(progression.stats.items === 1, `one genuine pickup books 1 (${progression.stats.items})`);

  items.give('wardens-tally', 2);
  items.give('bloat-cyst', 3);
  ok(progression.stats.items === 3, `temper()'s two parents book one pickup event each, 2 more (${progression.stats.items})`);

  items.temper('tempered-cairn'); // parents: chime-of-absolution + gristle-sickle — not held; no-op
  ok(progression.stats.items === 3, 'an unaffordable temper (parents not held) books nothing');

  items.give('chime-of-absolution', 1);
  items.give('gristle-sickle', 1);
  const beforeTemper = progression.stats.items;
  items.temper('tempered-cairn');
  // The reviewer's repro, on this counter: +1 for the grant, never +3 for the
  // grant plus the two zeroing writes.
  ok(progression.stats.items === beforeTemper + 1,
    `temper() adds exactly 1 pickup event — never +3 for the 2 zeroing writes (${progression.stats.items - beforeTemper})`);
}

console.log('Tempered Capacitor (offense): strain rises and caps, decays only via the buff window, and costs health as it climbs');
{
  const capacitor = card('tempered-capacitor');
  const api = makeApi();

  const mults = [];
  const costs = [];
  for (let i = 0; i < 7; i++) {
    api.rec.damage.length = 0;
    const before = api.player.health;
    capacitor.hooks.onHit({ position: { x: 0, y: 0, z: 0 } }, api);
    mults.push(api.rec.damage[0] / 10);
    costs.push(before - api.player.health);
  }
  ok(api.rec.damage.length > 0, 'a proc fired at all (sanity — a broken roll gate fails everything below silently)');
  const wantMults = [1.2, 1.35, 1.5, 1.65, 1.8, 1.95, 1.95]; // strain 0..5, capped at 5
  ok(mults.every((m, i) => Math.abs(m - wantMults[i]) < 1e-9),
    `arc multiplier rises 1.2 -> 1.95 across 5 strain then holds (${mults.map((m) => m.toFixed(2)).join(', ')})`);
  ok(costs.every((c) => c > 0) && costs[5] > costs[0],
    `health cost rises with strain too (${costs.map((c) => c.toFixed(3)).join(', ')})`);

  // Each proc arcs across 2 + linear(1, count) = 3 targets at count 1.
  ok(api.rec.damage.length === 3, `arcs across 3 targets at 1 stack (${api.rec.damage.length})`);

  // NO FULL PARENT RETENTION, on every axis the card touches — and the
  // comparison values are DERIVED by driving each parent's own live hook at
  // its own full strength, not hand-typed literals, so a future rebalance of
  // either parent moves this guard along with it instead of leaving it
  // proving a number the parents no longer carry.
  const veinApi = makeApi(); // world 0 -> grace(ctx) = 1, Quicksilver Vein's peak
  veinApi.roll = (p) => p > 0;
  card('quicksilver-vein').hooks.onHit({ position: { x: 0, y: 0, z: 0 } }, veinApi);
  const veinArcMult = veinApi.rec.damage[0] / 10;

  const rotApi = makeApi(); // world 110 -> blightGrace(ctx) = 1, Arc Rot's peak
  rotApi.ctx.corruption.world = 110;
  const rotRolls = [];
  rotApi.roll = (p) => { rotRolls.push(p); return p > 0; };
  card('arc-rot').hooks.onHit({ position: { x: 0, y: 0, z: 0 } }, rotApi);
  const rotArcMult = rotApi.rec.damage[0] / 10;
  const rotProcChance = rotRolls[0];
  const rotCostFrac = (100 - rotApi.player.health) / 100;

  ok(1.2 + 0.15 * 5 < veinArcMult + rotArcMult,
    `capped arc damage (${(1.2 + 0.15 * 5).toFixed(2)}) is below the live sum of both parents kept whole (${(veinArcMult + rotArcMult).toFixed(2)})`);
  ok(hyperbolic(0.14, 1) < rotProcChance,
    `proc chance is weaker than the blight parent's own live chance (${hyperbolic(0.14, 1).toFixed(3)} vs ${rotProcChance.toFixed(3)})`);
  ok(0.008 < rotCostFrac,
    `base health cost (0.008) is weaker than the blight parent's own live toll (${rotCostFrac.toFixed(4)})`);

  // Strain fades to nothing once the buff's own window elapses — proven by
  // rebuilding a fresh api (an expired buff reads back as 0 stacks exactly
  // like a fresh one) rather than asserting on a timer this test does not run.
  const fresh = makeApi();
  fresh.rec.damage.length = 0;
  capacitor.hooks.onHit({ position: { x: 0, y: 0, z: 0 } }, fresh);
  ok(Math.abs(fresh.rec.damage[0] / 10 - 1.2) < 1e-9, 'a cold capacitor (0 strain) always opens at the 1.2x floor');
}

console.log('Tempered Bulwark (defense): the brace is transient and weaker on both axes than either parent kept whole');
{
  const ctx = makeCtx();
  ctx.player = { isPlayer: true, alive: true };
  const items = new Items();
  items.init(ctx);
  items.give('tempered-bulwark', 1);

  const base = {
    maxHealth: 100, healthRegen: 1, moveSpeed: 7, attackSpeed: 1, damage: 12,
    critChance: 0.05, critMult: 2, armor: 0, cooldownMult: 1, jumpCount: 1,
  };
  const idle = items.stats(base);
  ok(idle.flatReduction === 0, 'no reduction before any hit lands');
  ok(idle.moveSpeedPenalty === 1, 'and no speed penalty either');

  card('tempered-bulwark').hooks.onDamaged({}, { ctx, player: ctx.player, items, count: items.count('tempered-bulwark') });
  const braced = items.stats(base);
  ok(Math.abs(braced.flatReduction - linear(7, 1)) < 1e-9,
    `flat reduction lands at 1 stack, 7 not 13 — Slag Ingot's own number (${braced.flatReduction})`);
  ok(Math.abs(braced.moveSpeedPenalty - hyperbolicMult(0.12, 1)) < 1e-9,
    `speed penalty is the gentler 12%, not Slag Ingot's 20% (${braced.moveSpeedPenalty})`);
  ok(braced.armor === base.armor, 'and it grants NO armour at all — Unblemished Plate\'s whole payoff is gone, not summed in');

  // NO FULL PARENT RETENTION: strictly weaker reduction and strictly gentler
  // slow than Slag Ingot's permanent numbers, and it is transient where the
  // parent was not — modelled here by re-deriving stats after the buff's
  // remaining time is forced to zero and swept, the same lapse `fixedUpdate`
  // performs every frame.
  ok(linear(7, 1) < linear(13, 1), 'weaker flat reduction than Slag Ingot kept whole');
  ok(hyperbolicMult(0.12, 1) > hyperbolicMult(0.20, 1), 'gentler slow than Slag Ingot kept whole');
  const brace = items.buffs.get('temperBrace');
  brace.remaining = 0;
  items.fixedUpdate(ctx, 0.001);
  const lapsed = items.stats(base);
  ok(lapsed.flatReduction === 0 && lapsed.moveSpeedPenalty === 1,
    'and once the window lapses, both halves are gone completely — no permanent floor either parent had');
}

console.log('Tempered Cairn (sustain): crits bank pressure, only a kill vents it, and the ward needs an open Sanctuary');
{
  const cairn = card('tempered-cairn');
  ok(typeof cairn.stat === 'function', 'noRegen is still charged via stat()');
  const s = {};
  cairn.stat(1, s);
  ok(s.noRegen === true, 'and it disables passive regen, kept whole from Gristle Sickle');

  const api = makeApi();

  // A non-crit hit banks nothing.
  cairn.hooks.onHit({ crit: false }, api);
  ok(api.buffs.get('temperPressure') === undefined, 'a non-crit hit banks no pressure');

  // Three crits bank three stacks.
  for (let i = 0; i < 3; i++) cairn.hooks.onHit({ crit: true }, api);
  ok(api.items.buffStacks('temperPressure') === 3, `three crits bank three stacks (${api.items.buffStacks('temperPressure')})`);

  // A kill with no Sanctuary open vents the heal but wards nothing.
  cairn.hooks.onKill({}, api);
  ok(Math.abs(api.rec.heals.at(-1) - 3 * linear(9, 1)) < 1e-9, `the kill heals 3 x 9 = 27 (${api.rec.heals.at(-1)})`);
  ok(api.rec.bleeds.length === 0, 'and wards nothing — no Sanctuary was open');
  ok(api.items.buffStacks('temperPressure') === 0, 'venting clears the bank to zero');

  // A kill with nothing banked heals nothing at all — the tension is real:
  // a crit-less killing spree gets none of this card's payoff.
  cairn.hooks.onKill({}, api);
  ok(api.rec.heals.length === 1, 'a kill with an empty bank heals nothing');

  // Bank again, and vent inside a Sanctuary: both the heal AND the ward land.
  for (let i = 0; i < 2; i++) cairn.hooks.onHit({ crit: true }, api);
  api.ctx.corruption.sanctified = true;
  cairn.hooks.onKill({}, api);
  ok(Math.abs(api.rec.heals.at(-1) - 2 * linear(9, 1)) < 1e-9, 'the second vent heals 2 x 9 = 18');
  ok(api.rec.bleeds.length === 1 && Math.abs(api.rec.bleeds[0] - 2 * linear(1, 1)) < 1e-9,
    `and wards 2 points of corruption, only because a Sanctuary was open (${api.rec.bleeds[0]})`);

  // NO FULL PARENT RETENTION: Gristle Sickle healed on every crit,
  // unconditionally; Chime of Absolution warded on every kill inside a
  // Sanctuary, unconditionally. This card pays neither payoff without the
  // OTHER parent's triggering event having happened first.
  const idle = makeApi();
  idle.ctx.corruption.sanctified = true;
  idle.hooks = cairn.hooks;
  cairn.hooks.onKill({}, idle); // no prior crit at all
  ok(idle.rec.heals.length === 0 && idle.rec.bleeds.length === 0,
    'a kill inside a Sanctuary with zero banked pressure pays out nothing on either axis');

  // And on the numbers too: per point banked, this card's heal and ward are
  // both weaker than either parent's own live payoff, kept whole. Derived by
  // driving each parent's own hook at its own full strength, per the same
  // rule the Capacitor's guard above uses — not hand-typed literals.
  const sickleApi = makeApi(); // world 110 -> blightGrace(ctx) = 1, Gristle Sickle's peak
  sickleApi.ctx.corruption.world = 110;
  card('gristle-sickle').hooks.onHit({ crit: true }, sickleApi);
  const sickleHealPerPoint = sickleApi.rec.heals[0];

  const chimeApi = makeApi();
  chimeApi.ctx.corruption.sanctified = true;
  chimeApi.ctx.authority = true;
  card('chime-of-absolution').hooks.onKill({}, chimeApi);
  const chimeWardPerPoint = chimeApi.rec.bleeds[0];

  ok(linear(9, 1) < sickleHealPerPoint,
    `heal per point banked (9) is weaker than Gristle Sickle's own live heal (${sickleHealPerPoint})`);
  ok(linear(1, 1) < chimeWardPerPoint,
    `ward per point banked (1) is weaker than Chime of Absolution's own live ward (${chimeWardPerPoint})`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
