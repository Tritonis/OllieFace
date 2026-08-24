/**
 * What each corruption band gives back (issue #36).
 *
 * Every band before this file applied pressure and nothing else, which made the
 * whole signature system a tax: the optimal line was to stay Pristine and never
 * touch it. A band now also *opens* something, and each opening is a decision
 * rather than a number — one scarce currency, and four bargains that spend it
 * on different things, so taking one is visibly declining the others.
 *
 * The currency is the spine. Void marks are minted by the debt itself — one per
 * `markPer` points of the run's *peak* world corruption — so the only way to
 * hold one is to have gone deeper, and there is no gold price anywhere in this
 * file. Peak, not live: a mark is minted by having been that deep, and bleeding
 * back down at an Argent Font does not un-mint it. (It also cannot un-*spend*
 * it, which is what stops "corrupt, buy, launder" from being free.)
 *
 * The bargains themselves live on one interactable, `VoidBargain`, whose offer
 * is whatever the current band has opened. That is deliberate: the deeper offer
 * *replaces* the shallower one, so descending is not a strictly-growing menu but
 * a series of trades, and a Consumed party can no longer buy the Seeded reroll.
 */

/** Tuning dials. Playtest numbers, not laws (see data/corruption.js). */
export const BOON = {
  // One void mark per this much peak world corruption. 25 puts the first mark
  // just inside Seeded (band 1 opens at 20), a pact's worth of three marks at
  // 75 — comfortably inside Blighted — and about seven marks on a run that
  // reaches Consumed, which is enough for a handful of bargains and never a
  // shopping trip.
  markPer: 25,
  // Seeded: re-draw the terminals. Cheap, repeatable, and the one bargain that
  // competes with saving up rather than with another purchase.
  reroll: { band: 1, marks: 1 },
  // Blighted: buy a corrupted synergy, previewed before the conversion.
  synergy: { band: 2, marks: 2 },
  // Overrun: a pact — marks *and* fresh debt, for a window of real power.
  pact: { band: 3, marks: 3, seconds: 20, debt: 40 },
  // Consumed: no price, because the price is the run. See `RUIN`.
  ruin: { band: 4 },
};

/**
 * Pristine's entry — the hole in this table, and the reason purity read as a
 * fun tax even after every other band was paid back (issue #36, second pass).
 *
 * The clean route had no verb. Its complete action set was: do not press the
 * thing; pay gold at a font whose price scales with the debt; and kill a
 * Voidtouched elite, which bled the world and minted nothing. Only the last is
 * something a player *does*, and it paid in a smaller number.
 *
 * So warding is now a verb with a currency behind it. Corruption bled by a
 * player's own hand — a Voidtouched kill, an Argent Font press; there is no
 * passive decay and nothing else calls `bleed` — accumulates on
 * `Corruption._warded` and mints one argent mote per `per` points.
 *
 * Note what that forces, because it is the design rather than an accident:
 * Voidtouched elites exist at a rate proportional to World Corruption, so a
 * player who never corrupts anything never wards anything either and mints no
 * motes. The clean route is a *cycle* — go in, bring it back out — not a
 * refusal to play, and abstinence is deliberately not the way to farm this.
 *
 * A mote buys Sanctuary: `sanctuarySeconds` in which `Corruption.priceOf`
 * returns zero and every chest, pickup and second of greed time is free. It is
 * the pact's mirror — the pact spends marks on power and charges debt for it;
 * sanctuary spends motes on greed and charges nothing — and it is a *timing*
 * decision with a wrong answer, because greed time already doubles the price a
 * sanctuary is waiving.
 *
 * Both numbers are first guesses. `per: 40` puts a mote at roughly one
 * Voidtouched kill's refund at Blighted depth (`refund: 0.08` of a world near
 * 500), which is the shape wanted: a mote is a thing you went and got, not a
 * thing that accrued. Neither has been playtested.
 */
export const MOTE = { per: 40, sanctuarySeconds: 12, motes: 1 };

/**
 * The reliquary's rung (issue #36, third pass, plan §5). Three motes buys one
 * argent item, and the deeper rung *replaces* Sanctuary rather than joining it:
 * spend at one mote and you never bank to three, which is the recurring
 * decision the purity route has never had.
 *
 * Only the *price* lives here, beside the other purse. The argent tier itself —
 * the `ARGENT` table, `grace`, and the five cards — lives in `data/items.js`
 * with the pool it prices; the altar deliberately does not import it, so the
 * spend surface reads, tests and merges with no pool in the tree at all.
 * `fadeAt` is duplicated rather than imported for exactly that reason, and it
 * is Overrun's own `at` (`data/corruption.js` BANDS) in both places.
 */
export const RELIQUARY = { motes: 3, fadeAt: 110, choices: 3 };

/** One mote per `per` of corruption warded. The mirror of `marksMinted`. */
export function motesMinted(warded) {
  const w = Number.isFinite(warded) ? Math.max(0, warded) : 0;
  return Math.floor(w / MOTE.per);
}

/**
 * How far the warding is through the mote it is currently earning, 0..1.
 *
 * The whole of issue #154's first complaint is that this number exists and has
 * never been on screen: warding accumulates silently for forty points and then
 * a toast appears out of nowhere. Pure and exported so the gauge, the world cue
 * and the tests all read one arithmetic rather than three copies of `% per`.
 *
 * Non-finite and negative read as 0, the same degradation `motesMinted` takes.
 */
export function wardedProgress(warded) {
  const w = Number.isFinite(warded) ? Math.max(0, warded) : 0;
  return (w % MOTE.per) / MOTE.per;
}

/** One mark per `markPer` of peak debt. Non-finite and negative read as none. */
export function marksMinted(peak) {
  const p = Number.isFinite(peak) ? Math.max(0, peak) : 0;
  return Math.floor(p / BOON.markPer);
}

/**
 * What a press about to add `added` points would *earn*, given the run's
 * current peak (issue #36, second pass).
 *
 * The first pass minted marks inside `Corruption.feed` and told nobody. The one
 * surface a player reads before every corrupting press — `pricedPrompt` — quoted
 * three clauses and all three were costs, so the whole upside economy was
 * invisible at exactly the moment it was supposed to be arguing. This is the
 * other half of that sentence.
 *
 * Pure, and expressed in terms of `marksMinted` rather than a second copy of
 * the arithmetic, so the number the prompt promises and the number `feed` mints
 * are the same function evaluated twice. `added` must already carry the greed
 * multiplier and the artifact economy — the caller quotes through
 * `Corruption.priceOf` for the same reason the debt clause does, or the prompt
 * would under-promise on greed time by exactly the factor that makes greed time
 * worth taking.
 *
 * `toNext` is the distance from where this press *lands* to the next boundary,
 * not from where the run stands now: the question a player is asking at a chest
 * is how much more greed the mark needs, and answering it from the pre-press
 * peak over-quotes by exactly the press being considered. Meaningful only when
 * `mints` is 0 — a minting press has already arrived.
 */
export function mintForecast(peak, added) {
  const p = Number.isFinite(peak) ? Math.max(0, peak) : 0;
  const a = Number.isFinite(added) ? Math.max(0, added) : 0;
  const mints = marksMinted(p + a) - marksMinted(p);
  return { mints, toNext: BOON.markPer - ((p + a) % BOON.markPer) };
}

/**
 * Corrupted-item synergies — the Blighted band's offer.
 *
 * Each names two blight cards that do something together that neither does
 * alone, and the bargain's whole point is that it says which one it would
 * complete, and what completing it grants, *before* it converts anything. A
 * synergy is bought with a clean stack: the conversion is the price.
 *
 * `grant` is an existing buff slot (`Items.addBuff` / `Items.stats`), applied
 * for the rest of the run. Nothing new renders, which is what makes this a
 * prototype: the decision is the feature, and the effect only has to be worth
 * the stack it costs.
 */
export const SYNERGIES = [
  {
    id: 'rotting-chorus',
    name: 'Rotting Chorus',
    needs: ['spasm-gland', 'arc-rot'],
    blurb: 'the gland keeps firing between arcs',
    grant: { buff: 'frenzy', magnitude: 0.22, maxStacks: 2 },
  },
  {
    id: 'slag-heart',
    name: 'Slag Heart',
    needs: ['slag-ingot', 'rupture-gall'],
    blurb: 'every rupture leaves plate behind',
    grant: { buff: 'aegis', magnitude: 12, maxStacks: 1 },
  },
  {
    id: 'gorging-hunt',
    name: 'Gorging Hunt',
    needs: ['gorge-tooth', 'gristle-sickle'],
    blurb: 'the tooth pays for what the sickle took',
    grant: { buff: 'preyfoot', magnitude: 0.25, maxStacks: 1 },
  },
];

export const SYNERGY_BY_ID = new Map(SYNERGIES.map((s) => [s.id, s]));

/**
 * Which synergy this inventory is one conversion away from, and which stack
 * that conversion would cost.
 *
 * Pure, and deliberately ignorant of `Items`: `held` is the set of blight ids
 * already in the pack, `convertible` maps a held *base* id to the blight id it
 * would become. That keeps the preview the prompt paints and the conversion the
 * press performs reading one answer — the Argent Font's `stabilisable` rule,
 * applied to the other direction.
 *
 * Returns null when nothing is one step away, which is a real state and says so
 * rather than offering a bargain that cannot be struck. Ties break on
 * `SYNERGIES` order so the preview is stable across frames.
 */
export function synergyPlan(held, convertible) {
  for (const syn of SYNERGIES) {
    const missing = syn.needs.filter((id) => !held.has(id));
    if (missing.length !== 1) continue;
    for (const [baseId, blightId] of convertible) {
      if (blightId === missing[0]) return { synergy: syn, baseId, blightId };
    }
  }
  return null;
}

/**
 * Pacts — the Overrun band's offer. A pact is not bought with marks alone: it
 * charges `BOON.pact.debt` of fresh corruption on top, so taking one drives the
 * gauge toward Consumed. That is the decision the band is for. Which pact a
 * given altar offers is fixed per stage (`VoidBargain`), so the choice is
 * "this one, now, at this price" rather than a menu.
 */
export const PACTS = [
  { id: 'famine', name: 'Pact of Famine', buff: 'berzerk', magnitude: 0.45, line: 'attack and move faster' },
  { id: 'haste', name: 'Pact of Haste', buff: 'nocooldown', magnitude: 1, line: 'skills cost no cooldown' },
  { id: 'hide', name: 'Pact of Hide', buff: 'aegis', magnitude: 30, line: 'armour against everything' },
];

/**
 * Consumed's last-chance state. Deliberately broken — that is the brief — and
 * deliberately one-way: `Corruption.ruined` never clears, the Argent Font stops
 * answering (the clean exit is not merely priced out, it is gone).
 *
 * The third consequence lands at the finale (#99): phase 3 reads
 * `Corruption.ruined` when the rite opens and runs `ruinedRite` instead
 * (`data/realms.js`) - erosion 1.75x, and no floor recovery on either route.
 * The arena a ruined run fights the Herald on only ever gets smaller. A
 * `voidRuin` event is still emitted for anything that wants the moment itself;
 * the rite does not use it, because the rite needs the *state* at phase 3 and
 * not a notification that may have fired forty minutes earlier.
 *
 * The duration is the rest of the run rather than a window, because a
 * last-chance power that lapses is a window, not a last chance.
 */
export const RUIN = {
  seconds: 1e9,
  buffs: [
    { buff: 'berzerk', magnitude: 0.8, maxStacks: 1 },
    { buff: 'nocooldown', magnitude: 1, maxStacks: 1 },
    { buff: 'frenzy', magnitude: 0.5, maxStacks: 4 },
  ],
};
