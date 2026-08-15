// src/world/corruptionPrice.js
import { BANDS, SOURCES, bandOf } from '../data/corruption.js';
import { ITEM_BY_ID, ITEMS_BY_TIER } from '../data/items.js';
import { ORDINARY_TIERS } from '../systems/Items.js';

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
 * The face-value range one roll off a `TIER_BIAS`-shaped table can feed.
 *
 * Mirrors `Items.rollTier` deliberately, in both of its rules: a zero weight
 * is not on the table at all, and any table that can pay an ordinary tier also
 * carries corruption's blight share. Blight is the joint most expensive tier
 * there is, so a range that omitted it would under-quote the worst case the
 * player is actually buying — which is the one they need before pressing E.
 */
export function biasFeedRange(bias) {
  const tiers = [];
  for (const tier in bias) if (bias[tier] > 0) tiers.push(tier);
  if (tiers.some((t) => ORDINARY_TIERS.includes(t)) && ITEMS_BY_TIER.blight?.length) tiers.push('blight');
  if (!tiers.length) return { min: 0, max: 0 };
  const feeds = tiers.map(tierFeed);
  return { min: Math.min(...feeds), max: Math.max(...feeds) };
}

/**
 * What crossing into each band actually does, in the fewest words that stay
 * true. Every upward crossing at or above `MUTATION.minBand` (2) converts one
 * held stack into its blight counterpart; band 3 additionally shuts the
 * ordinary Fracture, because `data/realms.js` caps that route at band 2 — so
 * Overrun is the line past which the clean ending is no longer on offer.
 */
const BAND_EFFECT = [
  '',
  'blight takes root',
  'an item mutates',
  'an item mutates, clean route closes',
  'an item mutates',
];

/** Prompt numbers are read at a glance: whole where possible, one place otherwise. */
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/** Distance to the next threshold, and what that threshold does. */
function nextLine(world, added) {
  const deepest = BANDS[BANDS.length - 1];
  const next = BANDS[bandOf(world) + 1];
  if (!next) return `${deepest.name} - no line left to cross`;
  const gap = next.at - world;
  // When even the cheapest outcome already clears the gap, the crossing is not
  // a risk being quoted — it is a thing about to happen, and it says so.
  return added >= gap
    ? `${next.name} now: ${BAND_EFFECT[next.id]}`
    : `${next.name} in ${fmt(gap)}: ${BAND_EFFECT[next.id]}`;
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
  return `${gain} | ${debt} | ${nextLine(cor.world ?? 0, lo)}`;
}
