// tests/corruption-counterplay.test.mjs
// Counterplay is costly, never free (launch spec §1): the Argent Font bleeds
// world corruption for climbing gold, the Covenant Stone moves a teammate's
// burden onto a volunteer, and neither is a greed act — no seeds, no feeds.
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { CLEANSE, PACT, cleanseAmount, cleanseCost } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true });

function makeCorruption({ authority = true } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  const c = new Corruption();
  c.init(ctx);
  return { ctx, c, emitted };
}

console.log('the tuning constants exist and are sane');
{
  ok(CLEANSE.gold > 0 && CLEANSE.amount > 0 && CLEANSE.maxUses >= 1 && CLEANSE.costClimb > 1 && CLEANSE.goldGrowth > 1, 'CLEANSE shape');
  ok(PACT.share > 0 && PACT.share < 1 && PACT.maxUses >= 1, 'PACT shape');
}

console.log('cleanse scales with the debt');
{
  ok(cleanseAmount(0) === CLEANSE.amount, 'floor holds at zero world');
  ok(cleanseAmount(100) === CLEANSE.amount, '22% of 100 is under the 30 floor');
  ok(cleanseAmount(200) === 44, '22% of 200');
  ok(cleanseAmount(400) === 88, 'deep red bleeds proportionally — the playtest font could never move a Consumed party');
  ok(cleanseAmount(-50) === CLEANSE.amount, 'a negative world cannot bleed below the floor');
  ok(cleanseAmount(NaN) === CLEANSE.amount && cleanseAmount(Infinity) === CLEANSE.amount,
    'a non-finite world reads as pristine — the prompt never quotes NaN');
  ok(CLEANSE.maxUses === 3, 'three uses per font');
  ok(CLEANSE.guaranteeBand === 2, 'guaranteed font from Blighted up');
}

console.log('and so does the price — the exit is not cheaper the deeper you are');
{
  ok(CLEANSE.goldPerWorld === 1.5, 'the world term is the tuned dial');
  ok(cleanseCost(0, 0, 0) === CLEANSE.gold, 'a pristine world at stage 0 on the first use is the base price');
  ok(cleanseCost(4, 0, 0) === Math.round(CLEANSE.gold * Math.pow(CLEANSE.goldGrowth, 4)),
    'the stage ladder is untouched');
  ok(cleanseCost(0, 2, 0) === Math.round(CLEANSE.gold * Math.pow(CLEANSE.costClimb, 2)),
    'so is the per-use climb');
  // The finding this closes: at world 400 the flat curve sold a whole
  // laundering visit for about 24 seconds of that same run's income.
  ok(cleanseCost(0, 0, 400) - cleanseCost(0, 0, 0) === 600,
    'a Consumed world puts 600 gold on the bill it did not used to');
  ok(cleanseCost(4, 0, 400) > cleanseCost(4, 0, 190) && cleanseCost(4, 0, 190) > cleanseCost(4, 0, 85),
    'and the price falls as the debt does — you are charged for what you are retiring');
  ok(cleanseCost(NaN, NaN, NaN) === CLEANSE.gold && cleanseCost(-1, -1, -1) === CLEANSE.gold,
    'nonsense reads as a pristine first use at stage 0 — the prompt never quotes NaN');
}

console.log('transfer moves attribution and nothing else');
{
  const { c, emitted } = makeCorruption();
  const donor = P(), volunteer = P();
  c.feed(donor, 100);
  const worldBefore = c.world, bandBefore = c.band;
  const eventsBefore = emitted.length;
  const moved = c.transfer(donor, volunteer, 35);
  ok(moved === 35, 'returns what it moved');
  ok(c.corruptionOf(donor) === 65 && c.corruptionOf(volunteer) === 35, 'both ledgers moved');
  ok(c.world === worldBefore && c.band === bandBefore, 'world and band untouched');
  const pacts = emitted.slice(eventsBefore).filter((e) => e.name === 'corruptionPact');
  ok(pacts.length === 1 && pacts[0].payload.from === donor && pacts[0].payload.to === volunteer && pacts[0].payload.amount === 35, 'one pact event, correctly attributed');
  ok(!emitted.slice(eventsBefore).some((e) => e.name === 'corruptionChanged' || e.name === 'corruptionBand'), 'no world-change events for a move that changed no world');
}

console.log('transfer clamps, and refuses nonsense');
{
  const { c } = makeCorruption();
  const donor = P(), volunteer = P();
  c.feed(donor, 10);
  ok(c.transfer(donor, volunteer, 50) === 10, 'clamped to what the donor holds');
  ok(c.transfer(donor, volunteer, 5) === 0, 'an empty donor moves nothing');
  ok(c.transfer(volunteer, volunteer, 5) === 0, 'self-pact refused');
  ok(c.transfer(null, volunteer, 5) === 0 && c.transfer(donor, null, 5) === 0, 'null parties refused');
  ok(c.transfer(volunteer, donor, 0) === 0 && c.transfer(volunteer, donor, -3) === 0 && c.transfer(volunteer, donor, NaN) === 0, 'zero, negative, NaN refused');
  const enemy = { isPlayer: false, alive: true };
  c.feed(donor, 10);
  ok(c.transfer(donor, enemy, 5) === 0, 'a non-player cannot receive a pact');
  ok(c.transfer(enemy, volunteer, 5) === 0, 'a non-player cannot hand one over');
  ok(c.corruptionOf(donor) === 10 && c.corruptionOf(enemy) === 0, 'the refused pact moved nothing');
}

console.log('the ledgers stay reconciled with the world through a bleed');
{
  const sum = (c, players) => players.reduce((s, p) => s + c.corruptionOf(p), 0);
  {
    // (a) a font-style bleed paid for by someone who caused almost none of it.
    const { c } = makeCorruption();
    const payer = P(), sinnerA = P(), sinnerB = P();
    c.feed(payer, 10);
    c.feed(sinnerA, 60);
    c.feed(sinnerB, 30);
    const taken = c.bleed(payer, CLEANSE.amount);
    ok(taken === CLEANSE.amount, 'the bleed took the tuned amount from the world');
    ok(Math.abs(sum(c, [payer, sinnerA, sinnerB]) - c.world) < 1e-9,
      `Σ per-player === world after the bleed (${sum(c, [payer, sinnerA, sinnerB])} vs ${c.world})`);
    ok(c.corruptionOf(payer) === 0, 'the payer\'s own row paid first, to zero');
    const rest = CLEANSE.amount - 10;                     // spread across 60 : 30
    ok(Math.abs(c.corruptionOf(sinnerA) - (60 - rest * (60 / 90))) < 1e-9, 'the heavier sinner paid two thirds of the remainder');
    ok(Math.abs(c.corruptionOf(sinnerB) - (30 - rest * (30 / 90))) < 1e-9, 'the lighter sinner paid one third');
  }
  {
    // (b) covered entirely by the payer's own ledger — nobody else is touched.
    const { c } = makeCorruption();
    const payer = P(), mate = P();
    c.feed(payer, 80);
    c.feed(mate, 40);
    ok(c.bleed(payer, 50) === 50, 'the bleed took what was asked');
    ok(c.corruptionOf(payer) === 30, 'the payer alone was debited');
    ok(c.corruptionOf(mate) === 40, 'a covered bleed touches no one else');
    ok(Math.abs(sum(c, [payer, mate]) - c.world) < 1e-9, 'Σ per-player === world');
  }
  {
    // And draining the world empties every row: no orphan attribution left.
    const { c } = makeCorruption();
    const payer = P(), mate = P();
    c.feed(payer, 20);
    c.feed(mate, 80);
    ok(c.bleed(payer, 999) === 100, 'clamped to the world');
    ok(c.world === 0 && c.corruptionOf(payer) === 0 && c.corruptionOf(mate) === 0, 'a drained world drains every ledger');
  }
}

console.log('a client cannot transfer');
{
  const { c } = makeCorruption({ authority: false });
  const a = P(), b = P();
  ok(c.transfer(a, b, 5) === 0, 'transfer returns 0 without authority');
}

console.log('— interactables —');
const { ArgentFont, CovenantStone } = await import('../src/world/Interactables.js');

function makeWorldCtx({ gold = 1000, roster = null } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    player: { isPlayer: true, alive: true, health: 100, maxHealth: 100 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    items: {
      gold,
      spendGold(cost) { if (this.gold < cost) return false; this.gold -= cost; return true; },
    },
    vfx: null, audio: null,
  };
  if (roster) ctx.roster = roster;
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

console.log('the Argent Font bleeds the world for climbing gold');
{
  const ctx = makeWorldCtx({ gold: 1000 });
  ctx.corruption.feed(ctx.player, 100);
  const font = new ArgentFont(ctx, new THREE.Vector3(1, 0, 1), 0);
  const cost0 = font.cost;
  ok(cost0 === cleanseCost(0, 0, 100), 'the live price is cleanseCost(stage, uses, world)');
  ok(font.interact() === true, 'a paid cleanse succeeds');
  ok(ctx.corruption.world === 100 - CLEANSE.amount, 'the world bled by the tuned amount');
  ok(ctx.items.gold === 1000 - cost0, 'and the gold is gone — at the price quoted before the press');
  ok(font.cost === cleanseCost(0, 1, ctx.corruption.world), 'the price re-reads the use count and the debt');
  ok(ctx.corruption.seeds.length === 0, 'cleansing is not a greed act — no seed');
  for (let i = font.uses; i < CLEANSE.maxUses; i++) font.interact();
  ok(font.available() === false, 'spent after maxUses');
}

console.log('the font refuses a pristine world and an empty purse');
{
  const ctx = makeWorldCtx({ gold: 1000 });
  const font = new ArgentFont(ctx, new THREE.Vector3(0, 0, 0), 0);
  ok(font.interact() === false, 'nothing to bleed, nothing charged');
  ok(ctx.items.gold === 1000, 'gold untouched by the refusal');
  ctx.corruption.feed(ctx.player, 50);
  ctx.items.gold = 1;
  ok(font.interact() === false, 'no gold, no cleanse');
  ok(ctx.corruption.world === 50, 'the world did not bleed for free');
}

console.log('the font bleeds a share of the debt when the debt is deep');
{
  const ctx = makeWorldCtx({ gold: 100000 });
  ctx.corruption.feed(ctx.player, 400);
  const font = new ArgentFont(ctx, new THREE.Vector3(1, 0, 1), 4);
  ok(font.prompt().includes('88'), `the prompt quotes what a use is worth now (${font.prompt()})`);
  // The live price the player is shown, and it is a real bill: at stage 4 and
  // world 400 the world term alone is 600 gold.
  ok(font.cost === cleanseCost(4, 0, 400), 'the font quotes cleanseCost at its stage, use and world');
  ok(font.prompt().includes(`$${font.cost}`), 'and the prompt quotes that same number');
  const goldBefore = ctx.items.gold, priced = font.cost;
  ok(font.interact() === true, 'a deep-red cleanse succeeds');
  ok(ctx.items.gold === goldBefore - priced, 'the press charged the quoted price');
  ok(ctx.corruption.world === 400 - 88, 'the world bled 22% of the debt, not the flat floor');
  ok(font.interact() === true, 'and again');
  ok(ctx.corruption.world === 312 - cleanseAmount(312), 'the second use re-reads the debt it just shrank');
  ok(font.prompt().includes(String(cleanseAmount(ctx.corruption.world))), 'the prompt tracks the shrinking debt');
}

console.log('the Covenant Stone moves the heaviest ledger onto the volunteer');
{
  const mateA = { isPlayer: true, alive: true, position: { x: 0, z: 0 } };
  const mateB = { isPlayer: true, alive: true, position: { x: 1, z: 0 } };
  const ctx = makeWorldCtx({ roster: { count: 3, all: [] } });
  ctx.roster.all = [ctx.player, mateA, mateB];
  ctx.corruption.feed(mateA, 40);
  ctx.corruption.feed(mateB, 80);
  const stone = new CovenantStone(ctx, new THREE.Vector3(2, 0, 2));
  ok(stone.interact() === true, 'the pact is struck');
  const share = 80 * PACT.share;
  ok(Math.abs(ctx.corruption.corruptionOf(mateB) - (80 - share)) < 1e-9, 'the heaviest teammate is relieved');
  ok(Math.abs(ctx.corruption.corruptionOf(ctx.player) - share) < 1e-9, 'the volunteer carries it now');
  ok(Math.abs(ctx.corruption.corruptionOf(mateA) - 40) < 1e-9, 'the lighter teammate untouched');
  ok(ctx.corruption.world === 120, 'world unchanged — blame moved, not absolved');
  ok(stone.available() === false, 'one covenant per stone');
  ok(ctx.corruption.seeds.length === 0, 'a pact is not a greed act — no seed');
}

console.log('solo, or a party with nothing to shoulder, is refused');
{
  const ctx = makeWorldCtx({ roster: { count: 1, all: [] } });
  ctx.roster.all = [ctx.player];
  const stone = new CovenantStone(ctx, new THREE.Vector3(0, 0, 0));
  ok(stone.interact() === false, 'no teammate, no pact');
  const ctx2 = makeWorldCtx({ roster: { count: 2, all: [] } });
  const mate = { isPlayer: true, alive: true, position: { x: 1, z: 0 } };
  ctx2.roster.all = [ctx2.player, mate];
  const stone2 = new CovenantStone(ctx2, new THREE.Vector3(0, 0, 0));
  ok(stone2.interact() === false, 'a clean teammate has nothing to hand over');
  ok(stone2.uses === 0, 'a refusal consumes no use');
}

console.log('wire values are appended, never renumbered');
{
  const font = new ArgentFont(makeWorldCtx(), new THREE.Vector3(), 0);
  const stone = new CovenantStone(makeWorldCtx(), new THREE.Vector3());
  ok(font.typeId === 13, 'argentFont is wire value 13');
  ok(stone.typeId === 14, 'covenantStone is wire value 14');
}

console.log('— the clean path is stocked, and stocking it costs a pristine run nothing —');
{
  const { Interactables } = await import('../src/world/Interactables.js');
  const { RNG } = await import('../src/core/MathUtil.js');

  // A stage with real landmarks and a *rejecting* isWalkable, because that is
  // what makes `_nearLandmark` loop: it retries the annulus until it finds a
  // walkable point, so each siting costs a *variable* number of draws. Without
  // a stage the helper short-circuits before drawing anything and every siting
  // costs a flat 2 — which would hide exactly the divergence class this block
  // exists to catch. Only what `_nearLandmark`/`_point` actually read.
  const STAGE = () => ({
    bound: 44,
    landmarks: [{ x: -14, z: 6, r: 5 }, { x: 12, z: -9, r: 7 }, { x: 2, z: 18, r: 4 }],
    isWalkable: (x, z) => x * x + z * z > 36 && Math.sin(x * 0.31) + Math.cos(z * 0.27) > -1.2,
    sampleHeight: (x, z) => Math.sin(x * 0.11) * 0.7 + Math.cos(z * 0.09) * 0.5,
  });

  // A populate-level ctx: the stage above, no artifacts, a *counted* ctx.rng we
  // can re-seed identically per run, and a stubbed corruption gauge so band and
  // world can be dialled without feeding anything. The counter is the point —
  // a leaked draw that happened to land the same position would still move the
  // count, and the count is pinned below.
  function populated(stageIndex, corruption, seed = 1234) {
    const raw = new RNG(seed);
    let draws = 0;
    const rng = {
      next: () => (draws++, raw.next()),
      range: (a, b) => (draws++, raw.range(a, b)),
      int: (a, b) => (draws++, raw.int(a, b)),
      pick: (a) => (draws++, raw.pick(a)),
      weighted: (a, w) => (draws++, raw.weighted(a, w)),
    };
    const ctx = {
      seed, rng, stage: STAGE(),
      scene: new THREE.Group(),
      player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
      events: { emit() {}, on() {} },
      // The shop terminals roll an item on construction; the stub takes one
      // ctx.rng draw as the real roller does, so the shared stream reaches
      // _populateShrines at a realistic offset.
      items: { gold: 0, spendGold: () => false },
      time: 0,
    };
    ctx.items.rollItem = () => { ctx.rng.next(); return 'syringe'; };
    if (corruption) ctx.corruption = corruption;
    const inter = new Interactables();
    inter.init(ctx);
    inter.populate(stageIndex);
    return { inter, draws: () => draws };
  }
  // Positions to 6dp plus type, in placement order: the whole draw sequence.
  const layout = (p) => p.inter.list.map((i) =>
    `${i.constructor.name}@${i.position.x.toFixed(6)},${i.position.z.toFixed(6)}`).join('|');
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const fonts = (p) => p.inter.list.filter((i) => i instanceof ArgentFont).length;

  // The guarantee: from Blighted up, every stage carries a font.
  let missing = 0;
  for (let s = 1; s <= 6; s++) {
    if (fonts(populated(s, { band: 3, world: 150 })) < 1) missing++;
  }
  ok(missing === 0, `every stage from Blighted up sells absolution (${6 - missing}/6 stages)`);
  ok(fonts(populated(1, { band: 2, world: 60 })) >= 1, 'the guarantee opens at the tuned band');

  // And it costs a pristine run nothing. This is the anchor, so it is pinned
  // against the code that existed *before* the guarantee, not against a second
  // run of the same code: `[seed, stage, ctx.rng draws, layout hash]` captured
  // from b1979c3 through this exact harness. Comparing band 0 to "no gauge"
  // alone would pass for any change that shifted both arms together — this
  // cannot. A future conditional draw at band 0 moves the count, the hash, or
  // both, and the numbers are regenerable: check out b1979c3's Interactables
  // and re-run this block.
  const GOLDEN_B1979C3 = [
    [1234, 0, 68, '1576708f'], [1234, 1, 95, '90eb9ca4'], [1234, 2, 110, '98b60237'],
    [1234, 3, 121, 'b918879f'], [1234, 4, 140, '36b9f4d0'], [1234, 5, 162, 'cb332085'],
    [1234, 6, 186, '03057e76'],
    [1337, 0, 76, 'c494c9e5'], [1337, 1, 93, 'b2fac454'], [1337, 2, 116, 'c740cb49'],
    [1337, 3, 133, '2744d0cf'], [1337, 4, 150, 'd22cb99f'], [1337, 5, 179, 'fe0f4259'],
    [1337, 6, 194, 'dd78453d'],
  ];
  let countDrift = 0, hashDrift = 0;
  for (const [seed, s, draws, hash] of GOLDEN_B1979C3) {
    const p = populated(s, { band: 0, world: 0 }, seed);
    if (p.draws() !== draws) countDrift++;
    if (fnv(layout(p)) !== hash) hashDrift++;
  }
  ok(countDrift === 0, `a pristine stage takes the pre-change number of ctx.rng draws (${GOLDEN_B1979C3.length} cases)`);
  ok(hashDrift === 0, 'and lays out identically to the pre-change code — band 0 is untouched by the guarantee');

  let drift = 0;
  for (let s = 0; s <= 6; s++) {
    if (layout(populated(s, { band: 0, world: 0 })) !== layout(populated(s, null))) drift++;
  }
  ok(drift === 0, 'a gauge reading Pristine is indistinguishable from no gauge at all');

  // The sharper guard, and the one with teeth at every band: the teleporter is
  // sited from ctx.rng *after* the shrines, so if the guarantee had taken a
  // single draw off the shared stream the teleporter would move. It must not,
  // on the very stages where the guarantee is provably doing work. Looped over
  // four seeds so the discriminating margin is not one stage on one seed.
  let moved = 0, fired = 0, seedsThatFired = 0, cases = 0;
  const tp = (p) => `${p.inter.teleporter.position.x.toFixed(6)},${p.inter.teleporter.position.z.toFixed(6)}`;
  for (const seed of [1234, 1337, 7, 99991]) {
    let firedHere = 0;
    for (let s = 1; s <= 6; s++) {
      const clean = populated(s, { band: 0, world: 0 }, seed);
      const deep = populated(s, { band: 3, world: 150 }, seed);
      cases++;
      if (tp(clean) !== tp(deep) || clean.draws() !== deep.draws()) moved++;
      if (fonts(clean) === 0 && fonts(deep) >= 1) firedHere++;
    }
    if (firedHere) seedsThatFired++;
    fired += firedHere;
  }
  ok(fired > 0 && seedsThatFired === 4,
    `the guarantee provably placed a font the bag had not, on every seed (${fired} stages across 4 seeds)`);
  ok(moved === 0, `and the teleporter never moved, nor the draw count (${cases} cases) — nothing was taken off ctx.rng`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
