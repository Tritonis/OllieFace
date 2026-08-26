// tests/txn-adoption.test.mjs
//
// Issue #176: every non-chest item-granting interactable adopts the explicit
// item transaction (#174/#175) instead of leaning on the automatic global
// `itemPickup` feed. Real `Corruption` and real `Items` on one bus throughout
// — the property under test is a property of the *seam* between them, and a
// stubbed one cannot show it. Two arms (MultishopTerminal, HollowChime) are
// driven red-then-green: first a `BlindCorruption` that re-enables the old
// unconditional per-tier feed, proving the safe-claim assertion actually can
// fail, then the real `Corruption` showing the adopted contract holds it at
// zero.
import * as THREE from 'three';
import { MultishopTerminal, AuricCairn, GildedSnare, HollowChime } from '../src/world/Interactables.js';
import { MarketStall, VaultChest, Refinery } from '../src/world/realms/RealmProps.js';
import { TrialController } from '../src/world/realms/Realms.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { SOURCES } from '../src/data/corruption.js';
import { ITEM_BY_ID } from '../src/data/items.js';
import { premiumFor } from '../src/data/itemOffers.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const BASE = 'adrenal-syringe';        // common, has a blight counterpart
const FACE = SOURCES.itemFeed.common + premiumFor('common');

/** A `Corruption` with #174's bypass undone — the mutation every red arm runs. */
class BlindCorruption extends Corruption {
  init(ctx) {
    super.init(ctx);
    ctx.events.on('itemPickup', ({ id, count = 1, delta, reason, owner }) => {
      if (reason === 'corrupt') return;
      const change = delta === undefined ? count : delta;
      if (!(change > 0)) return;
      this.feed(owner || ctx.player, (SOURCES.itemFeed[ITEM_BY_ID.get(id)?.tier] ?? 1) * change);
    });
  }
}

function makeWorld({ gold = 1000, CorruptionClass = Corruption } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    seed: 1,
    time: 0,
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    rng: { pick: (a) => a[0], range: () => 0 },
    fxRng: { range: () => 0 },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    interactables: {
      spawned: [],
      spawnOrb(position, itemId, arc, ownerPawn) {
        const orb = { position, itemId, arc, ownerPawn };
        this.spawned.push(orb);
        return orb;
      },
      deliver() {
        for (const o of this.spawned) Items.of(ctx, o.ownerPawn)?.give(o.itemId, 1);
        this.spawned = [];
      },
    },
    audio: null, vfx: null,
  };
  new Items().init(ctx);
  ctx.items.gold = gold;
  ctx.items.rollItem = () => BASE;
  const cor = new CorruptionClass();
  cor.init(ctx);
  return { ctx, cor };
}

// ------------------------------------------------------- MultishopTerminal

console.log('the terminal: gold buys the lid, the item is a separate safe claim');
{
  const { ctx, cor } = makeWorld();
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  shop.itemId = BASE;
  ok(shop.interact(ctx.player) === true, 'the purchase succeeds');
  ok(ctx.items.gold === 1000 - 44, 'gold was spent');
  ok(ctx.interactables.spawned.length === 0, 'no orb yet — the item is offered, not handed over');
  ok(shop.openOffer() !== null, 'the terminal holds an open offer');
  const r = shop.answer('safe');
  ok(r?.outcome === 'safe', 'the safe card resolves');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 1, 'the item landed');
  ok(cor.world === 0, `the safe claim fed NOTHING for the item (world ${cor.world})`);
}

console.log('-- and that guard CAN fail: blind the feed and the same press charges --');
{
  const { ctx, cor } = makeWorld({ CorruptionClass: BlindCorruption });
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  shop.itemId = BASE;
  shop.interact(ctx.player);
  shop.answer('safe');
  ctx.interactables.deliver();
  ok(cor.world === SOURCES.itemFeed.common,
    `a blinded gate charges ${SOURCES.itemFeed.common} for the same safe claim (got ${cor.world}) `
    + '- so "world === 0" above is a guard that can go red');
}

console.log('the terminal\'s corrupted claim charges once, not twice');
{
  const { ctx, cor } = makeWorld();
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  shop.itemId = BASE;
  shop.interact(ctx.player);
  const r = shop.answer('corrupt');
  ok(r?.outcome === 'corrupt', 'the corrupted card resolves');
  ok(cor.world === FACE, `charged exactly the face price once (world ${cor.world}, want ${FACE})`);
  ctx.interactables.deliver();
  ok(cor.world === FACE, 'delivering the orb did not charge a second time');
}

// ---------------------------------------------------------------- HollowChime

/** A director stub that hands back `n` enemies which start alive and never act. */
function stubDirector(ctx) {
  let nextId = 1;
  const enemies = [];
  ctx.director = {
    enemies,
    populationCap: 999,
    fillerCard: () => ({}),
    spawnOne: () => { const e = { id: nextId++, alive: true }; enemies.push(e); return e; },
    spawnTelegraph: () => {},
  };
  ctx.stage = { sampleHeight: () => 0 };
}

console.log('the Hollow Chime: two guaranteed drops land safe, off one open transaction each');
{
  const { ctx, cor } = makeWorld();
  stubDirector(ctx);
  const chime = new HollowChime(ctx, new THREE.Vector3(), 0);
  ok(chime.interact(ctx.player) === true, 'the ring opens');
  ok(chime.state === 'ringing', 'the shrine is mid-fight');
  for (const h of chime.pending) h.e.alive = false;   // the ambush is cleared
  chime.update(1 / 60);
  ok(chime.state === 'ready', 'the ring resolved and the shrine is ready again');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 2, 'both drops landed');
  ok(cor.world === 0, `the ambush was the whole price — NOTHING was fed for either drop (world ${cor.world})`);
}

console.log('-- and that guard CAN fail: blind the feed and both drops charge --');
{
  const { ctx, cor } = makeWorld({ CorruptionClass: BlindCorruption });
  stubDirector(ctx);
  const chime = new HollowChime(ctx, new THREE.Vector3(), 0);
  chime.interact(ctx.player);
  for (const h of chime.pending) h.e.alive = false;
  chime.update(1 / 60);
  ctx.interactables.deliver();
  ok(cor.world === SOURCES.itemFeed.common * 2,
    `a blinded gate charges ${SOURCES.itemFeed.common} per drop, ${SOURCES.itemFeed.common * 2} total `
    + `(got ${cor.world}) - so "world === 0" above is a guard that can go red`);
}

// --------------------------------------------------- the rest of the adopters

console.log('the Auric Cairn: a win opens a real offer, unresolved is uncounted');
{
  const { ctx, cor } = makeWorld();
  const cairn = new AuricCairn(ctx, new THREE.Vector3(), 25);
  ctx.items.roll = () => true;   // force the win branch, off the payer's own stream
  ok(cairn.interact(ctx.player) === true, 'the roll succeeds');
  ok(cairn.openOffer() !== null, 'the win opens an offer rather than handing the item over');
  ok(cairn.answer('safe')?.outcome === 'safe', 'the safe claim resolves');
  ok(cor.world === 0, 'the gold and the luck were the whole price');
}

console.log('the Gilded Snare: the item is a real offer, the hunter is the cost');
{
  const { ctx, cor } = makeWorld();
  const snare = new GildedSnare(ctx, new THREE.Vector3(), 0);
  stubDirector(ctx);
  ok(snare.interact(ctx.player) === true, 'the offering lands');
  ok(snare.openOffer() !== null, 'the item is offered, not handed over');
  ok(snare.answer('safe')?.outcome === 'safe', 'the safe claim resolves');
  ok(cor.world === 0, 'the hunter was the whole price');
}

console.log('the market stall: gold buys the lid, the item is a separate safe claim');
{
  const { ctx, cor } = makeWorld();
  const stall = new MarketStall(ctx, new THREE.Vector3(), BASE, 90, 0);
  ok(stall.interact(ctx.player) === true, 'the purchase succeeds');
  ok(stall.openOffer() !== null, 'the item is offered, not handed over');
  ok(stall.answer('safe')?.outcome === 'safe', 'the safe claim resolves');
  ok(cor.world === 0, 'the safe claim fed nothing for the item');
}

console.log('the vault: every drop the warden owed lands safe');
{
  const { ctx, cor } = makeWorld();
  const drops = [BASE, BASE];
  const vault = new VaultChest(ctx, new THREE.Vector3(), drops);
  vault.unseal();
  ok(vault.interact(ctx.player) === true, 'the vault opens');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 2, 'both drops landed');
  ok(cor.world === 0, `the warden was the whole price (world ${cor.world})`);
}

console.log('the refinery: the burn and the gold are the price, the upgrade is a separate safe claim');
{
  const { ctx, cor } = makeWorld();
  ctx.items.give(BASE, 1);   // something in the common/uncommon pool to burn
  const before = cor.world;
  const refinery = new Refinery(ctx, new THREE.Vector3(), 120);
  ok(refinery.interact(ctx.player) === true, 'the burn succeeds');
  ok(cor.world === before, 'burning the stack and paying gold fed nothing more');
  ok(refinery.openOffer() !== null, 'the upgrade is offered, not handed over');
  ok(refinery.answer('safe')?.outcome === 'safe', 'the safe claim resolves');
  ctx.interactables.deliver();
  ok(cor.world === before, `the safe claim fed nothing for the upgrade either (world ${cor.world})`);
}

// -------------------------------------------------------------- the trial

function stubRealms() {
  return { ctx: {}, active: { stage: { origin: new THREE.Vector3() } } };
}

console.log('the trial payout: three guaranteed drops land safe, the waves were the price');
{
  const { ctx, cor } = makeWorld();
  const trial = new TrialController(stubRealms(), {});
  trial._payout(ctx);
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 3, 'all three drops landed');
  ok(cor.world === 0, `the waves were the whole price — NOTHING was fed for any drop (world ${cor.world})`);
}

console.log('-- and that guard CAN fail: blind the feed and the trial payout charges --');
{
  const { ctx, cor } = makeWorld({ CorruptionClass: BlindCorruption });
  const trial = new TrialController(stubRealms(), {});
  trial._payout(ctx);
  ctx.interactables.deliver();
  ok(cor.world === SOURCES.itemFeed.common * 3,
    `a blinded gate charges ${SOURCES.itemFeed.common} per drop, ${SOURCES.itemFeed.common * 3} total `
    + `(got ${cor.world}) - so "world === 0" above is a guard that can go red`);
}

// ------------------------------------------------- review A1: quote vs charge
//
// The guard that was missing: nothing compared a fixed-item feeder's own
// quoted max against what `resolve('corrupt')` actually charges, so
// `MultishopTerminal`/`MarketStall` shipped a quote ~5x the real price and the
// suite stayed green (both a bias-table `claimOutcomeRange` fold and the test
// file's own `claimOf` helper independently always append a 'blight' branch,
// so they agreed with each other and with the bug). This section compares the
// PRINTED number against the REAL charge, off the real modules, for both
// feeders whose item is fixed at construction rather than rolled at claim
// time.

/** The `+N` or `+N-M corruption` clause's ceiling, off the printed prompt. */
function quotedMax(line) {
  const m = line.match(/\+(\d+)(?:-(\d+))?\s+corruption/);
  return m ? Number(m[2] ?? m[1]) : NaN;
}

console.log('-- red: the pre-fix formula (blight always folded into a fixed item) does NOT match the real charge --');
{
  // Reproduces exactly what `claimOutcomeRange({ [tier]: 1 })` computed before
  // the fix — the tier's own face price AND corruption's blight share, ceiling
  // taken over both. `adrenal-syringe` is common, and this is the review's own
  // reproduction: quoted max 16 against an actual charge of 3.
  const buggyMax = Math.max(
    SOURCES.itemFeed.common + premiumFor('common'),
    SOURCES.itemFeed.blight + premiumFor('blight'),
  );
  const { ctx, cor } = makeWorld();
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  shop.itemId = BASE;
  shop.interact(ctx.player);
  shop.answer('corrupt');
  ok(buggyMax !== cor.world,
    `the old blight-folded formula quoted ${buggyMax} while the real charge is ${cor.world} `
    + '- that mismatch is exactly what the assertions below must catch, and did not before this fix');
}

console.log('green: the terminal\'s quoted max is exactly what a corrupted claim charges');
{
  const { ctx, cor } = makeWorld();
  const shop = new MultishopTerminal(ctx, new THREE.Vector3(), 44, [], 0);
  shop.itemId = BASE;
  const max = quotedMax(shop.prompt());
  ok(Number.isFinite(max), 'the prompt names a corruption ceiling');
  ok(shop.interact(ctx.player) === true, 'the purchase succeeds');
  ok(shop.answer('corrupt')?.outcome === 'corrupt', 'the corrupted card resolves');
  ok(cor.world === max, `the quoted max (${max}) is exactly what landed (${cor.world}), no re-roll premium included`);
}

console.log('green: the market stall\'s quoted max is exactly what a corrupted claim charges');
{
  const { ctx, cor } = makeWorld();
  const stall = new MarketStall(ctx, new THREE.Vector3(), BASE, 90, 0);
  const max = quotedMax(stall.prompt());
  ok(Number.isFinite(max), 'the prompt names a corruption ceiling');
  ok(stall.interact(ctx.player) === true, 'the purchase succeeds');
  ok(stall.answer('corrupt')?.outcome === 'corrupt', 'the corrupted card resolves');
  ok(cor.world === max, `the quoted max (${max}) is exactly what landed (${cor.world}), no re-roll premium included`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
