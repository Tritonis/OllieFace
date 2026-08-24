// tests/item-transaction.test.mjs
//
// The three-way item offer (issue #174). Real `Items` and real `Corruption` on
// one bus throughout: the whole contract lives in the seam between them — a
// safe claim is only safe because the automatic `itemPickup` feed declined to
// charge it — and a synthetic event bus cannot show that seam at all.
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { SOURCES } from '../src/data/corruption.js';
import { ITEM_BY_ID } from '../src/data/items.js';
import { OFFER, premiumFor, salvageFor } from '../src/data/itemOffers.js';
import { weightOf } from '../src/data/alignment.js';
import {
  OUTCOMES, corruptRewardFor, openItemOffer, quoteItemOffer,
} from '../src/world/itemTransaction.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true });

/** A common base with a blight counterpart, and one without. */
const BASE = 'adrenal-syringe';
const BLIGHT = 'spasm-gland';
const PLAIN = 'cloven-hoof';
const FACE = SOURCES.itemFeed.common + premiumFor('common');

function makeWorld({ authority = true, orbs = false } = {}) {
  const listeners = new Map();
  const emitted = [];
  const ctx = {
    authority,
    seed: 1234,
    player: P(),
    rng: () => { throw new Error('the transaction must draw no rng'); },
    fxRng: { range: () => { throw new Error('no fx rng in these arms'); } },
    events: {
      emit(name, p) { emitted.push({ name, payload: p }); for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  new Items().init(ctx);
  const cor = new Corruption();
  cor.init(ctx);
  if (orbs) {
    ctx.interactables = {
      spawned: [],
      spawnOrb(position, itemId, arc, ownerPawn, giveOpts) {
        const orb = { position, itemId, arc, ownerPawn, giveOpts };
        this.spawned.push(orb);
        return orb;
      },
      /** Land every orb the way `Interactables.fixedUpdate` does. */
      deliver() {
        for (const o of this.spawned) Items.of(ctx, o.ownerPawn)?.give(o.itemId, 1, o.giveOpts);
        this.spawned = [];
      },
    };
  }
  return { ctx, cor, emitted };
}

console.log('the safe claim grants the item and feeds nothing');
{
  const { ctx, cor, emitted } = makeWorld();
  const offer = openItemOffer(ctx, { itemId: BASE });
  const r = offer.resolve('safe');
  ok(r.outcome === 'safe', 'it resolves as safe');
  ok(ctx.items.count(BASE) === 1, 'the item landed');
  ok(cor.world === 0, `NO corruption was fed (world ${cor.world})`);
  ok(cor.corruptionOf(ctx.player) === 0, 'and none was attributed to the claimant');
  ok(cor.ledger.corrupt === 0 && cor.ledger.pure === 0 && cor.ledger.mixed === 0,
    'and nothing at all was committed');
  ok(cor.alignment === 'neutral', 'the run is still neutral');
  ok(!emitted.some((e) => e.name === 'alignmentCommitted'), 'no commitment was even announced');
}

console.log('-- and that guard CAN fail: re-enable the feed and it goes red --');
{
  // The mutation the brief asks for, run in-process rather than by hand: a
  // Corruption whose #174 bypass has been undone by re-registering the old
  // unconditional listener. Every other line is identical to the arm above. If
  // this world charges nothing, the assertion above is passing while blind and
  // proves nothing about the gate.
  class BlindCorruption extends Corruption {
    init(ctx) {
      super.init(ctx);
      ctx.events.on('itemPickup', ({ id, count = 1, delta, reason, owner }) => {
        if (reason === 'corrupt') return;                 // the ONE clause left intact
        const change = delta === undefined ? count : delta;
        if (!(change > 0)) return;
        this.feed(owner || ctx.player, (SOURCES.itemFeed[ITEM_BY_ID.get(id)?.tier] ?? 1) * change);
      });
    }
  }
  const listeners = new Map();
  const ctx = {
    authority: true, seed: 1, player: P(),
    events: {
      emit(n, p) { for (const fn of listeners.get(n) || []) fn(p); },
      on(n, fn) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); },
    },
  };
  new Items().init(ctx);
  const blind = new BlindCorruption();
  blind.init(ctx);
  openItemOffer(ctx, { itemId: BASE }).resolve('safe');
  ok(blind.world === SOURCES.itemFeed.common,
    `a blinded gate charges ${SOURCES.itemFeed.common} for the same safe claim (got ${blind.world}) `
    + '- so "world === 0" above is a guard that can go red');
}

console.log('the corrupted upgrade is targeted, priced once, and commits corrupt');
{
  const { ctx, cor, emitted } = makeWorld();
  ok(corruptRewardFor(BASE).itemId === BLIGHT && corruptRewardFor(BASE).targeted,
    'the corrupted reward is the item\'s own blight counterpart, not a roll');
  ok(corruptRewardFor(PLAIN).itemId === PLAIN && !corruptRewardFor(PLAIN).targeted,
    'an item with no counterpart corrupts into itself and says so');

  const offer = openItemOffer(ctx, { itemId: BASE });
  const quoted = offer.quote().corrupt;
  const r = offer.resolve('corrupt');
  ok(ctx.items.count(BLIGHT) === 1 && ctx.items.count(BASE) === 0, 'the blight card landed instead');
  ok(cor.world === FACE, `charged exactly once, at the quoted ${FACE} (world ${cor.world})`);
  ok(quoted.corruption === FACE, 'and the quote said so before the press');
  ok(r.corruption === FACE, 'the result reports what it charged');
  ok(cor.ledger.corrupt === weightOf('corruptUpgrade'), 'corrupt commitment is exactly one act');
  ok(cor.ledger.pure === 0, 'and nothing pure');
  const feeds = emitted.filter((e) => e.name === 'corruptionChanged');
  ok(feeds.length === 1, `exactly one corruption movement, not two (${feeds.length})`);
}

console.log('the corrupted charge is not doubled by the blight card being a blight tier');
{
  // The double-feed this arm exists for: `spasm-gland` is tier 'blight', which
  // the automatic listener prices at 8. If the grant were not marked safe the
  // world would read FACE + 8.
  const { cor } = (() => {
    const w = makeWorld();
    openItemOffer(w.ctx, { itemId: BASE }).resolve('corrupt');
    return w;
  })();
  ok(cor.world === FACE, `blight-tier delivery adds nothing on top (world ${cor.world}, want ${FACE})`);
}

console.log('salvage forgoes the item, wards, and commits pure');
{
  const { ctx, cor } = makeWorld();
  cor.feed(ctx.player, 50);                     // a world there is something to clean
  const before = cor.world;
  const offer = openItemOffer(ctx, { itemId: BASE });
  const quoted = offer.quote().salvage;
  const r = offer.resolve('salvage');
  ok(ctx.items.count(BASE) === 0 && ctx.items.count(BLIGHT) === 0, 'no item was granted');
  ok(cor.world === before - salvageFor('common'), `the world came down by ${salvageFor('common')}`);
  ok(quoted.reward.warded === salvageFor('common'), 'the quote named the payoff');
  ok(r.corruption === -salvageFor('common'), 'the result reports a negative charge');
  ok(cor.warded === salvageFor('common'), 'warding progress was credited');
  ok(cor.ledger.pure === weightOf('salvaged') + weightOf('warded', salvageFor('common')),
    `pure commitment is the act plus its warding (${cor.ledger.pure})`);
  ok(cor.ledger.corrupt === 0, 'and nothing corrupt');
}

console.log('salvage against a pristine world quotes what it can actually pay');
{
  const { ctx, cor } = makeWorld();
  const q = quoteItemOffer(ctx, BASE);
  ok(q.salvage.reward.warded === 0, 'a clean world has nothing to give back, and the quote admits it');
  openItemOffer(ctx, { itemId: BASE }).resolve('salvage');
  ok(cor.warded === 0, 'and the bleed took nothing');
  ok(cor.ledger.pure === weightOf('salvaged'), 'the decision still commits — the payoff did not');
}

console.log('every outcome is quoted in full before resolution');
{
  const { ctx, cor } = makeWorld();
  cor.feed(ctx.player, 18);                     // one point short of Seeded
  const q = quoteItemOffer(ctx, BASE);
  for (const name of OUTCOMES) {
    const o = q[name];
    ok(!!o.reward, `${name} quotes a reward`);
    ok(typeof o.corruption === 'number', `${name} quotes a corruption amount`);
    ok(o.mint && Number.isFinite(o.mint.marks) && Number.isFinite(o.mint.motes),
      `${name} quotes mark and mote progress`);
    ok(o.threshold && Number.isFinite(o.threshold.bandAfter),
      `${name} quotes the threshold consequence`);
    ok(o.commitment && 'class' in o.commitment, `${name} quotes its alignment commitment`);
    ok(typeof o.line === 'string' && o.line.length > 0, `${name} renders a prompt line`);
  }
  ok(q.corrupt.threshold.crosses && q.corrupt.threshold.bandAfter === 1,
    'the corrupted quote warns that this press crosses into Seeded');
  ok(!q.safe.threshold.crosses, 'the safe quote crosses nothing');
  ok(q.safe.commitment.class === null && q.safe.commitment.amount === 0,
    'the safe quote commits to nothing, and says so rather than staying silent');
  ok(q.corrupt.commitment.class === 'corrupt' && q.salvage.commitment.class === 'pure',
    'the two priced outcomes name opposite sides');
}

console.log('a quote reads the live gauge: greed time re-prices an open offer');
{
  const { ctx, cor } = makeWorld();
  const offer = openItemOffer(ctx, { itemId: BASE });
  ok(offer.quote().corrupt.corruption === FACE, 'quoted at face before the teleporter');
  ctx.events.emit('teleporterComplete', {});
  ok(offer.quote().corrupt.corruption === FACE * SOURCES.greedMult, 'and doubled on greed time');
  offer.resolve('corrupt');
  ok(cor.world === FACE * SOURCES.greedMult, 'the charge agrees with the quote it replaced');
}

console.log('cancellation grants nothing and commits nothing');
{
  const { ctx, cor, emitted } = makeWorld();
  cor.feed(ctx.player, 50);
  const offer = openItemOffer(ctx, { itemId: BASE });
  const r = offer.cancel();
  ok(r.outcome === 'cancelled', 'it reports a cancellation');
  ok(ctx.items.count(BASE) === 0, 'no item');
  ok(cor.world === 50 && cor.warded === 0, 'the gauge did not move in either direction');
  ok(cor.ledger.pure === 0 && cor.ledger.corrupt === 0,
    'and walking away is NOT a cheaper salvage — it commits nothing');
  ok(emitted.some((e) => e.name === 'itemOfferResolved' && e.payload.outcome === 'cancelled'),
    'the cancellation is still announced');
  ok(offer.resolve('corrupt') === null && offer.cancel() === null, 'and the offer is spent');
}

console.log('a lapsed window resolves as the safe claim');
{
  const { ctx, cor } = makeWorld();
  const offer = openItemOffer(ctx, { itemId: BASE, seconds: 1 });
  ok(offer.update(0.4) === null && !offer.resolved, 'still open partway through');
  const r = offer.update(0.7);
  ok(r && r.outcome === OFFER.windowDefault && r.outcome === 'safe', 'lapsing takes the safe claim');
  ok(ctx.items.count(BASE) === 1 && cor.world === 0, 'so the item lands free');
  ok(cor.ledger.corrupt === 0 && cor.ledger.pure === 0, 'and a lapse commits to nothing');
  ok(offer.update(5) === null, 'and the window cannot lapse twice');
}

console.log('the window is driven by dt, not by tick count');
{
  const slow = makeWorld(); const fast = makeWorld();
  const a = openItemOffer(slow.ctx, { itemId: BASE, seconds: 2 });
  const b = openItemOffer(fast.ctx, { itemId: BASE, seconds: 2 });
  for (let i = 0; i < 4; i++) a.update(0.5);
  for (let i = 0; i < 120; i++) b.update(1 / 60);
  ok(a.resolved && b.resolved, 'a 8 Hz caller and a 60 Hz caller lapse the same offer');
}

console.log('resolution is host-only');
{
  const { ctx, cor } = makeWorld({ authority: false });
  const offer = openItemOffer(ctx, { itemId: BASE });
  ok(offer.resolve('corrupt') === null, 'a client cannot resolve');
  ok(offer.resolved === false, 'and the offer stays open for the host to answer');
  ok(cor.world === 0 && ctx.items.count(BASE) === 0 && ctx.items.count(BLIGHT) === 0,
    'nothing moved');
  ok(quoteItemOffer(ctx, BASE) !== null, 'but a client can still READ the quote');
}

console.log('an unknown outcome is refused rather than guessed');
{
  const { ctx, cor } = makeWorld();
  const offer = openItemOffer(ctx, { itemId: BASE });
  ok(offer.resolve('bargain') === null && !offer.resolved, 'an outcome off the list resolves nothing');
  ok(offer.resolve('safe').outcome === 'safe', 'and the offer is still answerable');
  ok(cor.world === 0, 'with the safe claim still free');
}

console.log('co-op: the transaction is written against the offer\'s owner');
{
  const { ctx, cor } = makeWorld();
  const mate = P();
  mate.peerId = 7;
  mate.items = new Items(mate);
  mate.items.init(ctx);

  openItemOffer(ctx, { itemId: BASE, owner: mate }).resolve('corrupt');
  ok(mate.items.count(BLIGHT) === 1, 'the teammate\'s own pack received it');
  ok(ctx.items.count(BLIGHT) === 0, 'and the local viewer\'s did not');
  ok(cor.corruptionOf(mate) === FACE, `the teammate's ledger carries the ${FACE}`);
  ok(cor.corruptionOf(ctx.player) === 0, 'the local player owes nothing for it');
  ok(cor.world === FACE, 'but the world paid, because corruption is the world\'s number');

  // And the safe claim on a teammate is free for everyone.
  openItemOffer(ctx, { itemId: PLAIN, owner: mate }).resolve('safe');
  ok(mate.items.count(PLAIN) === 1, 'the safe claim landed in the same pack');
  ok(cor.world === FACE, 'and charged nobody');
}

console.log('orb delivery carries the settlement, so the courier does not re-charge');
{
  const { ctx, cor } = makeWorld({ orbs: true });
  const position = { x: 0, y: 0, z: 0 };
  openItemOffer(ctx, { itemId: BASE, position }).resolve('safe');
  ok(ctx.interactables.spawned.length === 1, 'the reward was tossed as an orb');
  const orb = ctx.interactables.spawned[0];
  ok(orb.ownerPawn === ctx.player, 'owned by the claimant');
  ok(orb.giveOpts?.safe === true, 'and carrying the settled marker');
  ok(ctx.items.count(BASE) === 0 && cor.world === 0, 'nothing has landed or been charged yet');
  ctx.interactables.deliver();
  ok(ctx.items.count(BASE) === 1, 'the orb landed the item');
  ok(cor.world === 0, `and the delivery fed nothing (world ${cor.world})`);
}

console.log('legacy pickups are untouched by the bypass existing');
{
  const { ctx, cor } = makeWorld();
  ctx.items.give(BASE, 1);
  ok(cor.world === SOURCES.itemFeed.common,
    'an ordinary give still feeds exactly as it did before #174');
  ctx.items.give(PLAIN, 2);
  ok(cor.world === SOURCES.itemFeed.common * 3, 'and so does a stack of two');
}

console.log('a bad offer is refused at the door');
{
  const { ctx } = makeWorld();
  ok(openItemOffer(ctx, { itemId: 'no-such-item' }) === null, 'an unknown id opens no offer');
  ok(quoteItemOffer(ctx, 'no-such-item') === null, 'and quotes nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
