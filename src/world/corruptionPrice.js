// src/world/corruptionPrice.js
import { BANDS, MUTATION, SOURCES, bandOf, pressureAt } from '../data/corruption.js';
import { ITEM_BY_ID, ITEMS_BY_TIER } from '../data/items.js';
import { CAPRICE_TIERS } from '../data/artifacts.js';
import { premiumFor, salvageFor } from '../data/itemOffers.js';
import { ORDINARY_TIERS } from '../systems/Items.js';
import { mintForecast } from '../data/bandBoons.js';

/**
 * The price tag every corruption-feeding prompt wears (issue #30).
 *
 * Nearly every acquisition in the run feeds the void — chest tithes, void
 * credit, the tier of whatever lands in the pack, doubled once the teleporter
 * is done — and none of it was priced at the moment of the decision. A cost
 * that only shows up on the gauge afterwards teaches one lesson, which is that
 * engaging with rewards is simply wrong. So every feeder now says three things
 * in the same order, in one line:
 *
 *   <gain now> | <debt added> | <next consequence>
 *
 * One formatter, read by all of them, so the three parts cannot drift apart
 * and a new feeder cannot quietly ship unpriced.
 *
 * The debt half is quoted through `Corruption.priceOf`, which is the same
 * expression `feed` charges through — so greed time and the artifact economy
 * are in the number rather than in a footnote, and the quote cannot disagree
 * with the transaction.
 *
 * That identity is only as good as the pipeline the range models, and the range
 * has to model *all* of it: `Items.rollItem` is `rollTier` followed by Caprice,
 * and quoting only the first half let the Refinery advertise +2-5 while the
 * bowl handed out lunars at 8. `feedRangeOf` folds the second half in.
 *
 * The third clause is the other place the quote can drift from the transaction,
 * and for the opposite reason: it describes a *future* crossing, and whether
 * that crossing charges a blight toll depends on what the run has already paid.
 * It reads `Items.nextTollBand()` rather than the world, for which see
 * `bandEffect`.
 *
 * Co-op caveat, the same one `ArgentFont.prompt` already carries: `Corruption`
 * is not replicated and `feed` is authority-gated, so a client's world reads 0
 * and its distance-to-the-next-band is the host's, stale. That is stale
 * display, not a stale transaction — the press still resolves on the host at
 * the host's numbers. Replicating the gauge is a net-layer change.
 */

/** Face-value corruption one item of `tier` feeds — Corruption's itemPickup rule. */
export function tierFeed(tier) {
  return SOURCES.itemFeed[tier] ?? 1;
}

/** Face-value corruption the named item ids feed when they all land in a pack. */
export function idsFeed(ids) {
  let sum = 0;
  for (const id of ids || []) sum += tierFeed(ITEM_BY_ID.get(id)?.tier);
  return sum;
}

/**
 * The face-value range a set of candidate tiers can feed, once the *rest* of
 * the roll pipeline has had its say.
 *
 * `Items.rollTier` is only the first half of `Items.rollItem`. The second half
 * is Caprice, which — while the artifact is held — throws away whatever tier
 * was chosen and draws a fresh one off `CAPRICE_TIERS` instead, for every roll
 * that did not come up blight. A quote that stopped at `rollTier` was quoting a
 * pipeline the game does not run: the Refinery, which passes an explicit tier
 * and therefore never even reaches `rollTier`, quoted a flat +2-5 while Caprice
 * handed out lunars at 8. Modelling `CAPRICE_TIERS` rather than widening to the
 * whole `itemFeed` table keeps the mirror a mirror — re-tune the artifact's
 * shelf and the quote moves with it, and a shelf that dropped lunar would stop
 * quoting lunar instead of over-quoting it forever.
 */
function rolledTiers(tiers, ctx) {
  let rolled = tiers;
  if (ctx?.artifacts?.has?.('caprice')) {
    // A corruption already rolled survives Caprice (`Items.rollItem`); every
    // other outcome is replaced wholesale, so the pre-Caprice tiers are gone.
    rolled = [...(tiers.includes('blight') ? ['blight'] : []), ...CAPRICE_TIERS.map((e) => e.tier)];
  }
  return rolled;
}

/** The face-value feed range of a candidate tier list, post-Caprice. */
function feedRangeOf(tiers, ctx) {
  const feeds = rolledTiers(tiers, ctx).map(tierFeed);
  return { min: Math.min(...feeds), max: Math.max(...feeds) };
}

/**
 * The tiers a `TIER_BIAS`-shaped table can actually pay out, after Caprice has
 * had its say — `biasFeedRange`'s own candidate list, exported because the
 * chest's per-outcome quote prices two different tables off it (the item's tier
 * feed, and `itemOffers`' premium and salvage) and re-deriving the list beside
 * this one is how the two halves of a quote drift apart.
 */
export function biasTiers(bias, ctx = null) {
  const tiers = [];
  for (const tier in bias) if (bias[tier] > 0) tiers.push(tier);
  if (tiers.some((t) => ORDINARY_TIERS.includes(t)) && ITEMS_BY_TIER.blight?.length) tiers.push('blight');
  if (!tiers.length) return [];
  return rolledTiers(tiers, ctx);
}

/**
 * What each of a chest's three claim outcomes costs, before the lid moves
 * (issue #175).
 *
 * The chest no longer feeds anything for the item it pays out — the claim is a
 * transaction now (`itemTransaction.js`), and the safe outcome feeds zero — so
 * the honest quote is not one range but three: nothing for the safe claim, the
 * tier feed *plus* the offer premium for the corrupted one, and a ward for
 * forgoing the item entirely. Face values: `pricedPrompt` applies `priceOf`.
 */
export function claimOutcomeRange(bias, ctx = null) {
  const tiers = biasTiers(bias, ctx);
  if (!tiers.length) return { safe: 0, corrupt: { min: 0, max: 0 }, salvage: { min: 0, max: 0 } };
  const corrupt = tiers.map((t) => tierFeed(t) + premiumFor(t));
  const salvage = tiers.map((t) => salvageFor(t));
  return {
    safe: 0,
    corrupt: { min: Math.min(...corrupt), max: Math.max(...corrupt) },
    salvage: { min: Math.min(...salvage), max: Math.max(...salvage) },
  };
}

/**
 * The face-value range one roll off an explicit tier list can feed — the
 * Refinery's shape, where the caller names the tiers rather than a table.
 */
export function tierFeedRange(tiers, ctx = null) {
  if (!tiers?.length) return { min: 0, max: 0 };
  return feedRangeOf(tiers, ctx);
}

/**
 * The face-value range one roll off a `TIER_BIAS`-shaped table can feed.
 *
 * Mirrors `Items.rollTier` deliberately, in both of its rules: a zero weight
 * is not on the table at all, and any table that can pay an ordinary tier also
 * carries corruption's blight share. Blight is the joint most expensive tier
 * there is, so a range that omitted it would under-quote the worst case the
 * player is actually buying — which is the one they need before pressing E.
 *
 * An empty table rolls nothing at all, so it short-circuits before the Caprice
 * fold: an artifact cannot re-roll a draw that never happened.
 */
export function biasFeedRange(bias, ctx = null) {
  const tiers = biasTiers(bias, ctx);
  if (!tiers.length) return { min: 0, max: 0 };
  const feeds = tiers.map(tierFeed);
  return { min: Math.min(...feeds), max: Math.max(...feeds) };
}

/**
 * What crossing into each band does *besides* charging its blight toll, in the
 * fewest words that stay true. Band 1 is the warning and takes nothing; band 3
 * additionally shuts the ordinary Fracture, because `data/realms.js` caps that
 * route at band 2 — so Overrun is the line past which the clean ending is no
 * longer on offer, whether or not a stack blights on the way through. Bands 2
 * and 4 have nothing standing of their own: strip the toll and what is left is
 * the Director pressure every point of world is buying anyway.
 *
 * The toll clause is deliberately *not* in this table, because it is not a
 * property of the band. A paid threshold never re-arms, so whether crossing
 * band 2 mutates an item is a fact about the run, not about band 2.
 */
const BAND_STANDING = ['', 'blight takes root', '', 'clean route closes', ''];

/** Prompt numbers are read at a glance: whole where possible, one place otherwise. */
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/**
 * What crossing into `band` costs, given the lowest band that still owes a
 * blight toll.
 *
 * `tollBand` comes from `Items.nextTollBand()` — the same number the
 * `corruptionBand` listener uses for its loop bound and the Argent Font for its
 * toll clock, so the line that promises a mutation and the code that collects
 * it read one authority. A party that spiked into Blighted and bled back down
 * with a font is looking up at a mark it has already paid; promising it a
 * mutation there is a falsehood the font, correctly, contradicts on the same
 * frame. Where nothing is owed the clause states what the crossing *does*
 * charge rather than going silent.
 */
function bandEffect(band, tollBand) {
  const standing = BAND_STANDING[band] || '';
  if (band >= tollBand) return standing ? `an item mutates, ${standing}` : 'an item mutates';
  return standing || `enemy scale +${pressureAt(BANDS[band].at).toFixed(2)}`;
}

/** Distance to the next threshold, and what that threshold does. */
function nextLine(world, added, tollBand) {
  const deepest = BANDS[BANDS.length - 1];
  const next = BANDS[bandOf(world) + 1];
  if (!next) return `${deepest.name} - no line left to cross`;
  const gap = next.at - world;
  const effect = bandEffect(next.id, tollBand);
  // When even the cheapest outcome already clears the gap, the crossing is not
  // a risk being quoted — it is a thing about to happen, and it says so.
  return added >= gap
    ? `${next.name} now: ${effect}`
    : `${next.name} in ${fmt(gap)}: ${effect}`;
}

/**
 * The three-part prompt. `gain` is the interactable's own line — what you get
 * and what gold it costs. `min`/`max` are the *face-value* corruption this
 * press would feed; the greed and artifact multipliers are applied here, once.
 * `qualifier` names a condition on the payout ("if it pays", "when cleared")
 * for the feeders whose item is not certain.
 *
 * A world with no corruption system (stub contexts, the pre-corruption
 * surface) gets the bare gain line back, unchanged.
 */
export function pricedPrompt(ctx, gain, min, max = min, qualifier = '') {
  const cor = ctx?.corruption;
  if (!cor || !(max > 0)) return gain;
  // `priceOf` is the honest quote; a fixture that stubs corruption without it
  // still gets face value rather than a crash, the same tolerance every other
  // prompt in this file already extends to stub contexts.
  const price = (n) => (typeof cor.priceOf === 'function' ? cor.priceOf(n) : n);
  const lo = price(min);
  const hi = price(max);
  let debt = `${lo === hi ? `+${fmt(lo)}` : `+${fmt(lo)}-${fmt(hi)}`} corruption`;
  if (qualifier) debt += ` ${qualifier}`;
  if (cor.greed) debt += ` (x${fmt(SOURCES.greedMult)} greed time)`;
  // The other half of the transaction (issue #36, second pass). Every clause of
  // this prompt was a cost, including the one describing a press that mints the
  // currency the whole upside economy runs on. The forecast is quoted off the
  // *best* case of the range — the press the player is hoping for — and off the
  // already-multiplied `hi`, because `feed` mints against what it charged and
  // not against face value. A corruption stub with no `peak` (older fixtures,
  // and a co-op client before replication) gets no clause at all rather than a
  // mark quoted off `undefined`.
  // ...except inside a Sanctuary window, where the clause is true and useless:
  // `priceOf` returns 0, so the forecast is always "(25 to the next void mark)"
  // - a free press mints nothing - and it reads as a scolding in the one
  // moment the design wants the player unleashed. The design note leaves this
  // call to review (2026-08-21 plan, section 4, last paragraph); this is the
  // review taking it. The prompt inside a window is the gain and the free
  // press, with no ledger attached.
  if (Number.isFinite(cor.peak) && !cor.sanctified) {
    const { mints, toNext } = mintForecast(cor.peak, hi);
    debt += mints > 0
      ? ` -> mints ${mints === 1 ? 'a void mark' : `${mints} void marks`}`
      : ` (${fmt(toNext)} to the next void mark)`;
  }
  // The toll floor is `Items`' answer, never a second derivation here. Absent
  // an item system (stub contexts) it degrades to `MUTATION.minBand`, which is
  // the right answer for a run that has crossed nothing.
  const toll = ctx?.items?.nextTollBand?.() ?? MUTATION.minBand;
  return `${gain} | ${debt} | ${nextLine(cor.world ?? 0, lo, Number.isFinite(toll) ? toll : MUTATION.minBand)}`;
}
