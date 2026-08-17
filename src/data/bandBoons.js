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

/** One mark per `markPer` of peak debt. Non-finite and negative read as none. */
export function marksMinted(peak) {
  const p = Number.isFinite(peak) ? Math.max(0, peak) : 0;
  return Math.floor(p / BOON.markPer);
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
 * A `voidRuin` event is emitted for a finale consumer that DOES NOT EXIST YET:
 * nothing subscribes to it, and a ruined run's finale rite is currently
 * identical to an unruined one. The irreversible consequences that have
 * actually shipped are the two above, both of which land before the finale.
 * Wiring the rite to it is issue #99 - do not read this event's existence as
 * evidence that the finale diverges.
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
