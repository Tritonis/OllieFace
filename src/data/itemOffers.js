/**
 * The three-way item offer's price list (issue #174, audit Priority 2).
 *
 * The 2026-08-23 audit's High finding is that ordinary loot taxes the player
 * automatically and refusing it earns nothing, so "take everything" is never a
 * decision. The fix is a transaction with three resolvable outcomes, and this
 * is the only table it prices from:
 *
 *   safe     — the item, at no corruption and no commitment. The baseline.
 *   corrupt  — the item's blight counterpart where one exists (a *targeted*
 *              outcome, not a random festering), bought with the item's own
 *              tier feed PLUS the premium below, and a corrupt commitment.
 *   salvage  — the item is forgone; the void gives back `salvage` points of
 *              world corruption and the run commits pure.
 *
 * Deliberately small and flat: every number here is a first-guess playtest dial
 * (the audit's Priority 8 asks for measured cohorts before tuning), and a flat
 * per-tier table is the shape the rest of `data/corruption.js` already uses —
 * `SOURCES.itemFeed` is the sibling this sits beside.
 *
 * No RNG is priced here, and none is drawn anywhere in the transaction: the
 * corrupted outcome is a deterministic function of the item offered, and the
 * salvage payoff is a deterministic function of its tier. That is not an
 * accident of the current values — an offer that rolled would have to derive a
 * stream (see `Items._mutateAt`), and having nothing to roll is cheaper than
 * having a derived stream to keep honest.
 */

/** Seconds an offer stands before it lapses into the safe claim. */
export const OFFER = {
  // Between the mutation window's 6 s and the ~8 s three cards need to read:
  // this offer quotes five clauses per outcome, so it sits at the top of that
  // range. Lapsing is not a punishment — see `windowDefault`.
  windowSeconds: 8,
  /** What lapsing resolves as. The harmless outcome, never the priced one. */
  windowDefault: 'safe',
  /** Extra corruption a corrupted upgrade costs ON TOP of the item's tier feed. */
  premium: {
    common: 2, uncommon: 3, legendary: 6, boss: 6, lunar: 8, blight: 8, equipment: 3,
  },
  premiumDefault: 2,
  /** World corruption warded back by forgoing the item, by tier. */
  salvage: {
    common: 4, uncommon: 6, legendary: 12, boss: 12, lunar: 16, blight: 16, equipment: 6,
  },
  salvageDefault: 4,
};

/** The corrupted upgrade's premium for `tier`. Unknown tiers fall back. */
export function premiumFor(tier) {
  return OFFER.premium[tier] ?? OFFER.premiumDefault;
}

/** The salvage payoff for `tier`, in points of world corruption warded. */
export function salvageFor(tier) {
  return OFFER.salvage[tier] ?? OFFER.salvageDefault;
}
