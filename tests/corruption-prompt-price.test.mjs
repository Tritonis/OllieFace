// Issue #30: every corruption-feeding prompt must price the decision at the
// moment it is made — gain now, debt added, next consequence.
//
// This asserts prompt *text*, which nothing else in the suite did. That is the
// point: the whole acceptance criterion is what a player can read off the
// screen before pressing E, so the string is the contract and a test that only
// checked the transaction would pass on a silent prompt.
//
// Every expectation below is composed from `data/corruption.js` and
// `data/realms.js` directly, never from the helper under test — a test that
// asked the implementation what the answer was would agree with any bug.
import * as THREE from 'three';
import {
  Chest, MultishopTerminal, AuricCairn, HollowChime, GildedSnare,
  IchorFont, FallowVault, MarrowKiln,
} from '../src/world/Interactables.js';
import { MarketStall, Refinery, VaultChest } from '../src/world/realms/RealmProps.js';
import { Corruption } from '../src/systems/Corruption.js';
import { BANDS, SOURCES } from '../src/data/corruption.js';
import { BOON } from '../src/data/bandBoons.js';
import { ITEM_BY_ID, ITEMS_BY_TIER } from '../src/data/items.js';
import { CAPRICE_TIERS } from '../src/data/artifacts.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n         got  ${got}\n         want ${want}`);

const FEED = SOURCES.itemFeed;
// The tiers one roll off a bias table can land on. `Items.rollTier` drops any
// zero weight and folds corruption's blight share into every table that can
// pay an ordinary tier — and blight is the most expensive tier there is, so a
// quote that omits it under-prices the worst case the player is buying.
function rangeOf(...tiers) {
  const feeds = [...tiers, 'blight'].map((t) => FEED[t] ?? 1);
  return { min: Math.min(...feeds), max: Math.max(...feeds) };
}
const SMALL_ITEM = rangeOf('common', 'uncommon', 'legendary');   // TIER_BIAS.small
const LARGE_ITEM = rangeOf('uncommon', 'legendary');             // TIER_BIAS.large
const LEG_ITEM = rangeOf('legendary');                           // TIER_BIAS.legendary
const SNARE_ITEM = rangeOf('uncommon', 'legendary');             // the Snare's own table

const SHOP_ITEM = 'adrenal-syringe';

function makeCtx({ gold = 1000, world = 0, greed = false } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    time: 0,
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    rng: { pick: (a) => a[0], range: () => 0 },
    fxRng: { range: () => 0 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    items: {
      gold,
      spendGold(cost) { if (this.gold < cost) return false; this.gold -= cost; return true; },
      addGold(n) { this.gold += n; },
      rollItem() { return SHOP_ITEM; },
      inventory() { return []; },
    },
    interactables: { orbs: [], spawnOrb(pos, id) { this.orbs.push(id); } },
    audio: null,
  };
  const cor = new Corruption();
  cor.init(ctx);
  // World first, greed second: seeding the debt through a doubled feed would
  // not put the world where the caller asked for it.
  if (world > 0) cor.feed(ctx.player, world);
  if (greed) ctx.events.emit('teleporterComplete', {});
  return ctx;
}

/** The third part, built the way a player would read the band table. */
function nextPart(world, added) {
  let band = 0;
  for (let i = 0; i < BANDS.length; i++) if (world >= BANDS[i].at) band = i;
  const next = BANDS[band + 1];
  if (!next) return `${BANDS[BANDS.length - 1].name} - no line left to cross`;
  const effect = ['', 'blight takes root', 'an item mutates',
    'an item mutates, clean route closes', 'an item mutates'][next.id];
  const gap = next.at - world;
  return added >= gap ? `${next.name} now: ${effect}` : `${next.name} in ${gap}: ${effect}`;
}

const MARK_PER = BOON.markPer;
const amount = (lo, hi) => (lo === hi ? `+${lo}` : `+${lo}-${hi}`);
/** The whole three-part line, as it reaches the HUD. */
function priced(gain, lo, hi, { world = 0, qualifier = '', greed = false, peak = null } = {}) {
  let debt = `${amount(lo, hi)} corruption`;
  if (qualifier) debt += ` ${qualifier}`;
  if (greed) debt += ` (x${SOURCES.greedMult} greed time)`;
  // The mint clause (issue #36, second pass). Re-derived here rather than
  // imported, like every other expectation in this file: the point is to state
  // the line independently of the code that formats it. It rides `hi` — the
  // best case of the range, already multiplied — because that is the press the
  // player is hoping for, and it rides the *peak*, which in these fixtures is
  // whatever the fixture fed the real `Corruption` to get to `world`.
  const p = peak === null ? world : peak;
  const mints = Math.floor((p + hi) / MARK_PER) - Math.floor(p / MARK_PER);
  debt += mints > 0
    ? ` -> mints ${mints === 1 ? 'a void mark' : `${mints} void marks`}`
    : ` (${MARK_PER - ((p + hi) % MARK_PER)} to the next void mark)`;
  return `${gain} | ${debt} | ${nextPart(world, lo)}`;
}

// ------------------------------------------------------------------- chests

console.log('a paid chest prices the tithe, the item and the line ahead');
{
  const ctx = makeCtx({ gold: 100 });
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  const t = SOURCES.chestTithe.small;
  eq(chest.prompt(),
    priced('Chest ($25)', t + SMALL_ITEM.min, t + SMALL_ITEM.max),
    'small chest: gold price, tithe + item range, distance to Seeded');

  const large = new Chest(ctx, new THREE.Vector3(), 'large', 60);
  const tl = SOURCES.chestTithe.large;
  eq(large.prompt(),
    priced('Large Chest ($60)', tl + LARGE_ITEM.min, tl + LARGE_ITEM.max),
    'large chest quotes its own tithe and its own loot table');

  // Its own purse: the two opens above spent from the one above them, and a
  // chest the player cannot afford quotes the credit price instead.
  const rich = makeCtx({ gold: 500 });
  const leg = new Chest(rich, new THREE.Vector3(), 'legendary', 400);
  const tg = SOURCES.chestTithe.legendary;
  eq(leg.prompt(),
    priced('Legendary Chest ($400)', tg + LEG_ITEM.min, tg + LEG_ITEM.max),
    'a legendary chest quotes the legendary tithe');
}

console.log('a chest the player cannot afford prices the void credit instead');
{
  const ctx = makeCtx({ gold: 3 });
  const chest = new Chest(ctx, new THREE.Vector3(), 'large', 60);
  const v = SOURCES.voidCredit.large;
  eq(chest.prompt(),
    priced('Large Chest — pay in corruption', v + LARGE_ITEM.min, v + LARGE_ITEM.max),
    'the forced open quotes the credit price, not the tithe');
  ok(chest.prompt().includes(String(v + LARGE_ITEM.min)),
    'and that number is the steep one the player is actually consenting to');
}

console.log('after the teleporter, every quote is the doubled one');
{
  const ctx = makeCtx({ gold: 100, greed: true });
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  const t = SOURCES.chestTithe.small;
  const g = SOURCES.greedMult;
  eq(chest.prompt(),
    priced('Chest ($25)', (t + SMALL_ITEM.min) * g, (t + SMALL_ITEM.max) * g, { greed: true }),
    'greed time is in the number and named beside it');
}

// -------------------------------------------------------- the line ahead

console.log('the third part says how far the next threshold is and what it does');
{
  // Deep enough into Seeded that Blighted is the line ahead, far enough from
  // it that the cheapest outcome does not reach it.
  const world = BANDS[2].at - 10;
  const near = makeCtx({ gold: 100, world });
  const chest = new Chest(near, new THREE.Vector3(), 'small', 25);
  const t = SOURCES.chestTithe.small;
  eq(chest.prompt(),
    priced('Chest ($25)', t + SMALL_ITEM.min, t + SMALL_ITEM.max, { world }),
    'inside a band, the distance to the next one is quoted');
  ok(chest.prompt().includes('an item mutates'),
    'and what that band does is named, not left to be discovered');
}

console.log('a press that certainly crosses says so');
{
  const world = BANDS[1].at - 1;
  const ctx = makeCtx({ gold: 100, world });
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  ok(chest.prompt().includes(`${BANDS[1].name} now:`),
    'when the cheapest outcome already crosses the line, the prompt says now');
}

console.log('at the deepest band there is no next line to quote');
{
  const world = BANDS[BANDS.length - 1].at + 10;
  const ctx = makeCtx({ gold: 100, world });
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  ok(chest.prompt().endsWith(`${BANDS[BANDS.length - 1].name} - no line left to cross`),
    'Consumed is the floor of the warning, and the prompt stays three parts');
}

// -------------------------------------------------- the rest of the feeders

console.log('a shop terminal knows exactly which item it sells, so it quotes exactly');
{
  const ctx = makeCtx({ gold: 1000 });
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  const def = ITEM_BY_ID.get(shop.itemId);
  const f = FEED[def.tier] ?? 1;
  eq(shop.prompt(), priced(`${def.name} ($44)`, f, f),
    'a known item is a single exact number, never a range');
}

console.log('the Auric Cairn prices the roll it might pay');
{
  const ctx = makeCtx({ gold: 1000 });
  const cairn = new AuricCairn(ctx, new THREE.Vector3(), 25);
  eq(cairn.prompt(),
    priced('Auric Cairn ($25)', SMALL_ITEM.min, SMALL_ITEM.max, { qualifier: 'if it pays' }),
    'a gamble is quoted as conditional rather than as certain');
}

console.log('the Hollow Chime prices both drops it owes on a clear');
{
  const ctx = makeCtx({ gold: 1000 });
  const chime = new HollowChime(ctx, new THREE.Vector3(), 0);
  eq(chime.prompt(),
    priced(`Hollow Chime (free — ${chime.maxUses} left)`,
      LARGE_ITEM.min * 2, LARGE_ITEM.max * 2, { qualifier: 'when cleared' }),
    'free at the till is not free of debt, and the prompt says so');
  chime.state = 'ringing';
  eq(chime.prompt(), 'Hollow Chime — answer it',
    'a chime mid-fight is an instruction, not an offer, and stays unpriced');
}

console.log('the Gilded Snare prices the offering it hands over unconditionally');
{
  const ctx = makeCtx({ gold: 1000 });
  const snare = new GildedSnare(ctx, new THREE.Vector3(), 0);
  eq(snare.prompt(),
    priced('Gilded Snare (take it — something answers)', SNARE_ITEM.min, SNARE_ITEM.max),
    'the free shrine is the one that most needed a price');
}

console.log('the market and the vault price their known goods');
{
  const ctx = makeCtx({ gold: 1000 });
  const stall = new MarketStall(ctx, new THREE.Vector3(), SHOP_ITEM, 90, 0);
  const def = ITEM_BY_ID.get(SHOP_ITEM);
  const f = FEED[def.tier] ?? 1;
  eq(stall.prompt(), priced(`${def.name} — ${def.tier} ($90)`, f, f),
    'a market stall quotes the tier it is holding up');

  const drops = [SHOP_ITEM, ITEMS_BY_TIER.legendary[0].id];
  const vault = new VaultChest(ctx, new THREE.Vector3(), drops);
  eq(vault.prompt(), 'Sealed — the warden holds the key',
    'a sealed vault offers nothing, so it prices nothing');
  vault.unseal();
  const total = drops.reduce((s, id) => s + (FEED[ITEM_BY_ID.get(id).tier] ?? 1), 0);
  eq(vault.prompt(), priced('Open the vault', total, total),
    'an unsealed vault sums every drop it is about to pay');

  const refinery = new Refinery(ctx, new THREE.Vector3(), 120);
  eq(refinery.prompt(),
    priced('Refinery — upgrade one item a tier ($120)', FEED.uncommon, FEED.legendary),
    'the refinery quotes both tiers a step can land on');
}

// ------------------------------------------------------------ what is exempt

console.log('interactables that feed nothing are left alone');
{
  const ctx = makeCtx({ gold: 1000 });
  eq(new IchorFont(ctx, new THREE.Vector3(), 0).prompt(), 'Ichor Font (pay 40% health)',
    'the Ichor Font pays gold for blood and feeds no corruption');
  eq(new FallowVault(ctx, new THREE.Vector3(), 0).prompt(),
    `Fallow Vault (commit $1000 — returns $${Math.round(1000 * 2.2)} next stage)`,
    'the Fallow Vault moves gold only');
  eq(new MarrowKiln(ctx, new THREE.Vector3(), 0).prompt(), 'Marrow Kiln (nothing to burn)',
    'the kiln takes an item away, so nothing lands in a pack');
}

// -------------------------------------------- the third clause reads the run
//
// The third part is the one that describes a *future* crossing, so unlike the
// first two it depends on what the run has already paid. Every upward crossing
// at or above the live toll floor blights a stack; a threshold once paid never
// re-arms. Deriving the clause from world corruption alone made every priced
// prompt promise a mutation the game would refuse to collect, from the first
// press of the guaranteed Argent Font onward.
console.log('a priced prompt asks Items what toll is still owed');
{
  const toll = (n) => {
    const ctx = makeCtx({ gold: 100, world: 30 });
    ctx.items.nextTollBand = () => n;
    return new Chest(ctx, new THREE.Vector3(), 'small', 25).prompt().split(' | ')[2];
  };
  // Composed from the tuning, not from the helper under test.
  const PRESSURE_AT_BLIGHTED = `enemy scale +${(0.004 * BANDS[2].at).toFixed(2)}`;

  eq(toll(2), `Blighted in ${BANDS[2].at - 30}: an item mutates`,
    'a run that still owes the Blighted toll is warned about it, exactly as before');
  eq(toll(3), `Blighted in ${BANDS[2].at - 30}: ${PRESSURE_AT_BLIGHTED}`,
    'a run that has paid it is told what the crossing does charge instead — pressure, not a mutation');
  ok(toll(3).includes(`in ${BANDS[2].at - 30}`),
    'the distance clause is unchanged: the line is still exactly where the band table puts it');

  // Overrun shuts the ordinary Fracture whether or not a stack blights on the
  // way through, so that clause survives a paid toll and the mutation does not.
  const deep = (n) => {
    const ctx = makeCtx({ gold: 100, world: 60 });
    ctx.items.nextTollBand = () => n;
    return new Chest(ctx, new THREE.Vector3(), 'small', 25).prompt().split(' | ')[2];
  };
  eq(deep(3), `Overrun in ${BANDS[3].at - 60}: an item mutates, clean route closes`, 'an owed Overrun toll states both consequences');
  eq(deep(4), `Overrun in ${BANDS[3].at - 60}: clean route closes`,
    'a paid one drops the mutation and keeps the route fact, which was never about the toll');

  const bare = makeCtx({ gold: 100, world: 30 });
  ok(new Chest(bare, new THREE.Vector3(), 'small', 25).prompt().includes('an item mutates'),
    'a context whose items cannot answer falls back to the tuning floor rather than going silent');
}

// ------------------------------------------------------------------ Caprice
//
// `Items.rollItem` is `rollTier` *then* Caprice, and the quote only mirrored
// the first half. Caprice throws the chosen tier away and draws off
// CAPRICE_TIERS instead, which reaches lunar at 8 — so the Refinery, which
// passes an explicit tier and got no range at all, advertised a flat +2-5 for
// a bowl that could hand back 8.
console.log('the quote models the whole roll pipeline, Caprice included');
{
  const caprice = (ctx) => {
    ctx.artifacts = { has: (id) => id === 'caprice', capriceTier: () => 'lunar' };
    return ctx;
  };
  const CAP = CAPRICE_TIERS.map((e) => FEED[e.tier] ?? 1);
  const capLo = Math.min(...CAP), capHi = Math.max(...CAP);
  ok(capHi === FEED.lunar && capLo === FEED.common,
    `the artifact's shelf spans ${capLo} to ${capHi} — common to lunar`);

  const plain = makeCtx({ gold: 1000 });
  const held = caprice(makeCtx({ gold: 1000 }));

  eq(new Refinery(plain, new THREE.Vector3(), 120).prompt(),
    priced('Refinery — upgrade one item a tier ($120)', FEED.uncommon, FEED.legendary),
    'without the artifact the refinery quotes the two tiers a step can land on, unchanged');
  eq(new Refinery(held, new THREE.Vector3(), 120).prompt(),
    priced('Refinery — upgrade one item a tier ($120)', capLo, capHi),
    'with it the bowl quotes the shelf it will actually draw from — the under-quoted ceiling is the point');

  // The bias-table feeders kept their ceiling only by coincidence (the folded
  // blight share is 8 and lunar is also 8); their floors were breached in
  // every case, because `TIER_BIAS.large` and `.legendary` carry `common: 0`.
  const tl = SOURCES.chestTithe.large;
  eq(new Chest(held, new THREE.Vector3(), 'large', 60).prompt(),
    priced('Large Chest ($60)', tl + capLo, tl + Math.max(capHi, LARGE_ITEM.max)),
    'a large chest can pay a common while the artifact is held, so its floor comes down to it');
  eq(new Chest(caprice(makeCtx({ gold: 1000 })), new THREE.Vector3(), 'small', 25).prompt(),
    priced('Chest ($25)', SOURCES.chestTithe.small + SMALL_ITEM.min, SOURCES.chestTithe.small + SMALL_ITEM.max),
    'a small chest already spanned common to blight, so the artifact moves nothing');

  // A fixed id is spawned directly and never goes near `rollItem`, so Caprice
  // cannot reach it and the quote must not pretend otherwise.
  eq(new MarketStall(caprice(makeCtx({ gold: 1000 })), new THREE.Vector3(), SHOP_ITEM, 90, 0).prompt(),
    new MarketStall(makeCtx({ gold: 1000 }), new THREE.Vector3(), SHOP_ITEM, 90, 0).prompt(),
    'a stall selling one named item quotes that item, artifact or no artifact');
}

console.log('without a corruption system the prompts are exactly what they were');
{
  const ctx = makeCtx({ gold: 100 });
  ctx.corruption = null;
  const chest = new Chest(ctx, new THREE.Vector3(), 'small', 25);
  eq(chest.prompt(), 'Chest ($25)', 'no gauge, no price tag, no change');
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  ok(!shop.prompt().includes('corruption'), 'and the same for every other feeder');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
