// src/world/itemTransaction.js
import { BANDS, MUTATION, bandOf } from '../data/corruption.js';
import { BLIGHT_BY_BASE, ITEM_BY_ID, blightGrace } from '../data/items.js';
import { OFFER, premiumFor, salvageFor } from '../data/itemOffers.js';
import { marksMinted, motesMinted } from '../data/bandBoons.js';
import { classOf, weightOf } from '../data/alignment.js';
import { Items, describeBlight } from '../systems/Items.js';
import { pricedPrompt, tierFeed } from './corruptionPrice.js';

/**
 * The item transaction (issue #174, audit Priority 2).
 *
 * The 2026-08-23 audit's standing complaint about the reward loop is that there
 * is no decision in it: an item feeds corruption whether or not the player
 * wanted the debt, and walking away earns nothing at all, so "take everything"
 * is not a strategy but the absence of one. This module is the contract that
 * replaces that — one offer, three resolvable outcomes, every one of them
 * quoted in full before the press:
 *
 *   'safe'    — the item lands, no corruption is fed, nothing is committed.
 *   'corrupt' — the item's blight counterpart lands where one exists, bought
 *               with the tier feed *plus* a premium, and a corrupt commitment.
 *   'salvage' — the item is forgone; the run wards `salvageFor(tier)` points
 *               back out and commits pure.
 *
 * It is a contract module and a set of hooks, and nothing in the game opens one
 * yet: chests (#175) and shops (#176) adopt it. Wiring it into every reward
 * source in this ticket would have meant changing the economy and the API in
 * one diff, with no way to tell which of the two a regression came from.
 *
 * ## What this module guarantees
 *
 * **Exactly one charge.** A resolution feeds corruption once, itself, through
 * `Corruption.feed`, and then grants the item marked `safe` so the automatic
 * `itemPickup` feed does not charge it again. The safe outcome feeds nothing at
 * all — not a reduced amount, not a deferred amount: `Corruption.feed` is never
 * called on that path and the grant carries the same bypass.
 *
 * **Host authority.** `resolve` and `lapse` are no-ops off the host, so a
 * client's press cannot half-settle a transaction. A quote is host-free on
 * purpose — a client must be able to *read* the offer it is about to ask for,
 * and reading moves nothing. (What a client's quote shows is stale for the same
 * reason every corruption prompt is: the gauge is host-local. See
 * `corruptionPrice.js`'s co-op caveat.)
 *
 * **Per-player attribution.** Every offer names an owner. The feed, the bleed,
 * the grant and the orb's `ownerPawn` all take that pawn, so a teammate's
 * transaction is written against a teammate's ledger and delivered into a
 * teammate's pack.
 *
 * **Determinism.** No `ctx.rng` draw, no derived stream, no `Math.random`, and
 * no dependence on frame count: the corrupted reward is a pure function of the
 * item offered (`BLIGHT_BY_BASE`), the salvage payoff a pure function of its
 * tier, and the window is driven by accumulated `dt`, not by ticks. There is
 * nothing here to roll, which is a stronger guarantee than rolling carefully.
 */

/** The outcomes an offer can resolve to. 'cancel' is a non-resolution. */
export const OUTCOMES = ['safe', 'corrupt', 'salvage'];

/**
 * Identifiers for open offers, so a surface that paints one can tell whether
 * the resolution it just heard is the one it is looking at. Monotone, minted
 * here, never random: it takes no draw from any stream, which is the same rule
 * `Items._openMutationChoice`'s nonce follows and for the same reason.
 */
let _offerSeq = 0;
const nextOfferId = () => ++_offerSeq;

/**
 * What the corrupted outcome of offering `itemId` hands over — or `null` where
 * there is nothing corrupt to hand over at all.
 *
 * Only 11 of the catalogue's items have a blight counterpart. For the other 91
 * an untargeted "corruption" was the *same item* for a real corruption charge
 * and a real corrupt commitment: a strictly dominated button, and worse than
 * useless — it is a way to buy corrupt alignment with no power attached, which
 * is exactly the incoherent transaction this ticket exists to remove. So the
 * outcome is not offered rather than offered empty (integration review m2).
 */
export function corruptRewardFor(itemId) {
  const blight = BLIGHT_BY_BASE.get(itemId);
  return blight ? { itemId: blight.id, targeted: true } : null;
}

/** Which outcomes `itemId` can actually be resolved to. Pure. */
export function offeredOutcomes(itemId) {
  return corruptRewardFor(itemId) ? [...OUTCOMES] : OUTCOMES.filter((o) => o !== 'corrupt');
}

/**
 * The threshold clause: what `added` corruption does to the world's bands.
 *
 * Reads `nextTollBand()` for the same reason `corruptionPrice.bandEffect` does
 * — whether a crossing costs a mutation is a fact about what the run has
 * already paid, not about the band — and degrades to `MUTATION.minBand` in a
 * context with no item system.
 *
 * Off the OWNER's own `Items`, never the viewer singleton (integration review
 * m4). The toll is per-inventory: a remote pawn whose stacks have already
 * festered through band 2 owes nothing there, and quoting the host's history at
 * them promises a mutation that their own `_mutePeak` will not collect. `of`
 * resolves the singleton for the local player and null-owner alike, so a
 * single-player quote is the same call it was.
 */
function thresholdOf(ctx, added, owner = null) {
  const world = ctx?.corruption?.world ?? 0;
  const after = Math.max(0, world + added);
  const from = bandOf(world);
  const to = bandOf(after);
  const tollRaw = ctx ? Items.of(ctx, owner)?.nextTollBand?.() : undefined;
  const toll = Number.isFinite(tollRaw) ? tollRaw : MUTATION.minBand;
  const next = BANDS[from + 1] || null;
  return {
    world, after,
    band: from, bandAfter: to,
    crosses: to > from,
    // A crossing that takes the world down a band is the salvage outcome's
    // clause and reads as its own thing rather than as a negative "crosses".
    recedes: to < from,
    next: next ? { id: next.id, name: next.name, at: next.at, gap: next.at - world } : null,
    mutates: to > from && to >= toll,
    tollBand: toll,
  };
}

/** The void-mark and argent-mote movement `added`/`warded` would produce. */
function mintOf(ctx, { added = 0, warded = 0 } = {}) {
  const cor = ctx?.corruption;
  const peak = Number.isFinite(cor?.peak) ? cor.peak : 0;
  const wardedNow = Number.isFinite(cor?.warded) ? cor.warded : 0;
  const afterPeak = Math.max(peak, (cor?.world ?? 0) + added);
  return {
    marks: Math.max(0, marksMinted(afterPeak) - marksMinted(peak)),
    motes: Math.max(0, motesMinted(wardedNow + Math.max(0, warded)) - motesMinted(wardedNow)),
  };
}

/** The commitment clause for one alignment source, or the empty one. */
function commitmentOf(source, amount = 1) {
  if (!source) return { source: null, class: null, amount: 0 };
  return { source, class: classOf(source), amount: weightOf(source, amount) };
}

/**
 * Quote all three outcomes for `itemId`, before anything is resolved.
 *
 * Every clause the ticket requires is a field, not prose: the exact reward, the
 * corruption charged (through `priceOf`, so greed time and a Sanctuary window
 * are already in it and the quote cannot disagree with the charge), the mark
 * and mote movement, the threshold consequence, and the alignment commitment.
 * `line` is the same three-part prompt string every other feeder wears, for the
 * surfaces that want one — it is derived from these numbers, never beside them.
 *
 * Pure: it moves nothing, takes no authority, and is safe to call every frame.
 */
export function quoteItemOffer(ctx, itemId, { owner = null } = {}) {
  const def = ITEM_BY_ID.get(itemId);
  if (!def) return null;
  const cor = ctx?.corruption;
  const pawn = owner || ctx?.player || null;
  const price = (n) => (typeof cor?.priceOf === 'function' ? cor.priceOf(n) : n);

  const corruptReward = corruptRewardFor(itemId);
  const faceFeed = tierFeed(def.tier) + premiumFor(def.tier);
  const corruptCharge = price(faceFeed);
  const salvage = salvageFor(def.tier);
  // What a bleed would actually take: it clamps to the world that exists, and
  // quoting the ask rather than the take would promise a pristine run a payoff
  // it cannot collect. The same rule `Corruption.bleed` mints against.
  const salvageTaken = Math.min(Math.max(0, cor?.world ?? 0), salvage);

  const outcomes = {
    safe: {
      outcome: 'safe',
      reward: { itemId, count: 1, targeted: false },
      corruption: 0,
      mint: mintOf(ctx, {}),
      threshold: thresholdOf(ctx, 0, pawn),
      commitment: commitmentOf(null),
    },
    // Null where the item has no blight counterpart — see `corruptRewardFor`.
    // A null outcome is a *closed* outcome, not a missing field: `resolve`
    // refuses it and `offeredOutcomes` leaves it off the list, so an adopter
    // that renders `q[name]` for each of `offeredOutcomes` renders two buttons
    // there and three here without knowing why.
    corrupt: null,
    salvage: {
      outcome: 'salvage',
      reward: { itemId: null, count: 0, warded: salvageTaken },
      corruption: -salvageTaken,
      ask: salvage,
      mint: mintOf(ctx, { warded: salvageTaken }),
      threshold: thresholdOf(ctx, -salvageTaken, pawn),
      // The decision commits ONLY when it actually warded something
      // (integration review M1). A decline against a clean world is a decline,
      // not an act of purity: banking a flat 3 for it meant two no-op salvages
      // flipped a fully corrupt run to mixed and shut its capstone, and eight
      // of them opened the pure capstone to a run that had never taken a single
      // point back out. The audit's pure sources are warding, Vows and sealed
      // Wounds — things done — and restraint gets its own verb in #177, not a
      // free rider on this one.
      commitment: salvageTaken > 0 ? commitmentOf('salvaged') : commitmentOf(null),
      // `warded` is billed separately, by `bleed` itself, and is quoted here
      // because a press's total pure commitment is both halves.
      warding: commitmentOf('warded', salvageTaken),
    },
  };

  if (corruptReward) {
    const blightDef = ITEM_BY_ID.get(corruptReward.itemId);
    outcomes.corrupt = {
      outcome: 'corrupt',
      reward: {
        itemId: corruptReward.itemId, count: 1, targeted: true,
        // What the card is worth *right now*. Blight strength rides live world
        // corruption (#170's `blightGrace`), so a Pristine buyer is paying full
        // price for a floored effect — the one number that decides whether this
        // press is a good deal, and the quote said nothing about it
        // (integration review m1). The description is the catalogue's own
        // stack-aware line, the same one the mutation choice card prints.
        description: describeBlight(blightDef, 1),
        grace: blightGrace(ctx),
      },
      corruption: corruptCharge,
      face: faceFeed,
      mint: mintOf(ctx, { added: corruptCharge }),
      threshold: thresholdOf(ctx, corruptCharge, pawn),
      commitment: commitmentOf('corruptUpgrade'),
    };
  }

  const name = def.name || itemId;
  outcomes.safe.line = `Take ${name}`;
  if (outcomes.corrupt) {
    const corruptName = ITEM_BY_ID.get(corruptReward.itemId)?.name || corruptReward.itemId;
    const grace = outcomes.corrupt.reward.grace;
    outcomes.corrupt.line = pricedPrompt(
      ctx, `Corrupt into ${corruptName} (at ${Math.round(grace * 100)}% strength)`, faceFeed, faceFeed
    );
  }
  outcomes.salvage.line = `Salvage ${name} | -${salvageTaken} corruption warded`
    + (outcomes.salvage.mint.motes > 0 ? ' -> mints an argent mote' : '');

  return {
    itemId, tier: def.tier, owner: pawn,
    outcomes: offeredOutcomes(itemId),
    ...outcomes,
  };
}

/**
 * Open an offer over `itemId`.
 *
 * The returned handle is inert until something resolves it: it holds no timer
 * of its own (the caller drives `update(dt)` from whatever loop owns the
 * prompt), takes no authority to construct, and never resolves twice — the
 * first of `resolve`, `cancel` or a lapse wins and every later call returns
 * null. That is what makes "a corrupted claim charges exactly once" a property
 * of this object rather than of every caller's discipline.
 *
 * `position` opts into item-orb delivery: with one, the reward is tossed as an
 * orb owned by the offer's owner and lands through the same claim path every
 * chest drop uses; without one it is granted directly. Either way the grant
 * carries the `safe` marker, because the corruption was settled here.
 */
export function openItemOffer(ctx, {
  itemId, owner = null, position = null, arc = 1.5, seconds = OFFER.windowSeconds, kind = 'item',
} = {}) {
  if (!ITEM_BY_ID.has(itemId)) return null;
  const pawn = owner || ctx?.player || null;

  const offerId = nextOfferId();
  const offer = {
    kind,
    itemId,
    /** This offer's identity, for the surface painting it. */
    offerId,
    owner: pawn,
    /** Seconds left before the window lapses into the safe claim. */
    remaining: seconds > 0 ? seconds : 0,
    resolved: false,
    outcome: null,
    /** The quote, re-read live: the gauge can move under an open offer. */
    quote() { return quoteItemOffer(ctx, itemId, { owner: pawn }); },

    /**
     * Drive the window. Returns the resolution if this tick lapsed it, else
     * null. Accumulated `dt`, never a tick count — a 30 Hz host and a 144 Hz
     * one lapse the same offer at the same moment.
     */
    update(dt) {
      if (offer.resolved || !(offer.remaining > 0)) return null;
      offer.remaining -= (Number.isFinite(dt) ? dt : 0);
      // Epsilon, not `> 0`: summing 120 frames of 1/60 leaves ~4e-16 of the
      // window standing, so a 60 Hz caller would hold an offer open one whole
      // extra frame past an 8 Hz caller's. The window is a wall-clock promise
      // to the player and must not depend on how the caller slices it.
      if (offer.remaining > 1e-9) return null;
      offer.remaining = 0;
      return offer.resolve(OFFER.windowDefault, { lapsed: true });
    },

    /**
     * Walk away entirely. Not an outcome: nothing is granted, nothing is fed,
     * nothing is committed, and no salvage is paid — a cancel is the player
     * closing the prompt, and it must not be a cheaper route to the pure
     * commitment that `salvage` charges an item for.
     */
    cancel() {
      if (offer.resolved) return null;
      offer.resolved = true;
      offer.outcome = 'cancelled';
      const result = { outcome: 'cancelled', itemId, owner: pawn, corruption: 0, granted: null };
      ctx?.events?.emit?.('itemOfferResolved', { ...result, kind, offerId, lapsed: false });
      return result;
    },

    /**
     * Settle the transaction. Host-only: a client's call moves nothing and
     * leaves the offer open, which is the same shape `Corruption.feed` and
     * `Items.give` already take.
     */
    resolve(outcome, { lapsed = false } = {}) {
      if (offer.resolved || !offeredOutcomes(itemId).includes(outcome)) return null;
      if (!ctx?.authority) return null;
      offer.resolved = true;
      offer.outcome = outcome;
      const q = quoteItemOffer(ctx, itemId, { owner: pawn });
      const cor = ctx.corruption;
      let corruption = 0;
      let granted = null;

      if (outcome === 'safe') {
        // The whole point of the ticket: no `feed` call on this path, and the
        // grant marked so the automatic listener does not make one either.
        granted = grant(ctx, itemId, pawn, position, arc);
      } else if (outcome === 'corrupt') {
        // Charged here, once, at face value — `feed` applies `priceOf` itself,
        // which is the same expression the quote read.
        corruption = cor?.feed?.(pawn, q.corrupt.face ?? 0) ?? 0;
        granted = grant(ctx, q.corrupt.reward.itemId, pawn, position, arc);
      } else {
        // Salvage: no item at all. `bleed` clamps, mints the mote and commits
        // `warded` on its own; the act's own commitment rides the event below.
        corruption = -(cor?.bleed?.(pawn, q.salvage.ask ?? 0) ?? 0);
      }

      const result = {
        outcome, itemId, owner: pawn, corruption, granted,
        // What the salvage actually took back out, which is what the ledger
        // gate reads (integration review M1): a decline that wards nothing
        // must commit nothing, and the listener cannot tell the difference
        // from the outcome name alone.
        warded: outcome === 'salvage' ? -corruption : 0,
        reward: q[outcome].reward, commitment: q[outcome].commitment,
      };
      // The ledger's hook. `Corruption` listens and commits — an event rather
      // than a direct `commit` call so this module stays ignorant that the
      // ledger exists, the same one-way rule every other source here follows.
      ctx.events?.emit?.('itemOfferResolved', { ...result, kind, offerId, lapsed });
      return result;
    },
  };

  ctx?.events?.emit?.('itemOfferOpened', {
    kind, itemId, offerId, owner: pawn, seconds: offer.remaining, quote: offer.quote(),
  });
  return offer;
}

/**
 * Deliver a transacted reward. Orb when the caller named a place for it to come
 * from, direct grant otherwise; `safe: true` on both, because this item's
 * corruption was settled by the transaction that produced it.
 */
function grant(ctx, itemId, pawn, position, arc) {
  if (!itemId) return null;
  if (position && ctx?.interactables?.spawnOrb) {
    const orb = ctx.interactables.spawnOrb(position, itemId, arc, pawn, { safe: true });
    if (orb) return { itemId, delivery: 'orb' };
  }
  Items.of(ctx, pawn)?.give(itemId, 1, { safe: true });
  return { itemId, delivery: 'direct' };
}
