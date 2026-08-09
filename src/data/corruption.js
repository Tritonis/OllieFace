/**
 * Corruption tuning. One number drives the run's second economy: corruption is
 * the price tag on greed, and the player always chose it (see
 * docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md).
 *
 * Every value here is a playtest dial, not a law. The Phase-1 gate is "does
 * 'should we open that chest' become a real decision" — tune toward that.
 */

/** World-corruption thresholds. A band is entered at `at` and holds until the next. */
export const BANDS = [
  { id: 0, name: 'Pristine', at: 0 },
  { id: 1, name: 'Seeded', at: 20 },
  { id: 2, name: 'Blighted', at: 55 },
  { id: 3, name: 'Overrun', at: 110 },
  { id: 4, name: 'Consumed', at: 190 },
];

export const SOURCES = {
  // Paid chest opens: gold price unchanged, plus this tithe.
  chestTithe: { small: 2, large: 5, legendary: 12 },
  // Forced opens with no gold: the void extends credit, at a steep multiple.
  voidCredit: { small: 10, large: 22, legendary: 45 },
  // Per item that lands in an inventory, by tier. Unknown tiers fall back to 1.
  itemFeed: { common: 1, uncommon: 2, legendary: 5, boss: 5, lunar: 8, blight: 8, equipment: 2 },
  // Feeds after the teleporter event completes are multiplied by this.
  greedMult: 2.0,
};

export function bandOf(world) {
  let band = 0;
  for (let i = 0; i < BANDS.length; i++) if (world >= BANDS[i].at) band = i;
  return band;
}

/**
 * Voidtouched spawn economy. The void's bank is separate from the Director's
 * credits by design: its rate is a function of World Corruption alone, so a
 * pristine run never pays a single frame of cost for the feature existing.
 * `refund` is the counterplay valve — each Voidtouched kill returns this
 * fraction of the *current* world corruption, so the refund is worth most
 * exactly when the party is deepest in the red.
 */
export const VOIDTOUCHED = {
  affix: 'voidtouched',
  ratePerWorld: 0.012,   // void credits per second per point of World Corruption
  maxBank: 90,           // ~2 queued elites; the void saves, it does not flood
  interval: 4,           // seconds between spend attempts
  telegraph: 1.1,        // seconds of warning ring before the unit surfaces
  spawnRing: { min: 2.5, max: 6.5 },  // metres from the chosen seed
  minPlayerDist: 12,     // never surfaces in someone's face
  refund: 0.03,          // fraction of World Corruption returned per kill
};

/**
 * Item mutation — the gauge reaching into the inventory. Each upward band
 * crossing at or above `minBand` converts one randomly chosen held stack into
 * its blight counterpart (data/items.js BLIGHT_BY_BASE). Band 1 is exempt for
 * the same reason band 1 has no screen grade: Seeded is the warning, Blighted
 * is when the world starts taking.
 */
export const MUTATION = { minBand: 2 };

/**
 * The cleansing font (Argent Font) — counterplay, costly, never free. One use
 * bleeds `cleanseAmount(world)` — a fraction of the current debt with a flat
 * floor — attributed to the user, for gold that climbs per use and per stage.
 * The gold price is the point: cleansing competes with the chest you were
 * about to open.
 *
 * Re-priced after the 2026-08-08 playtest: a flat 30 against an unbounded
 * world meant a Consumed party's font was a rounding error — three uses moved
 * a 400-point debt by 22% of one band. The fraction mirrors how the
 * Voidtouched refund already scales, worth most exactly when the party is
 * deepest in, and the floor keeps an early font from selling nothing.
 * `guaranteeBand`: from this band up, every stage places at least one font —
 * staying clean has to be *achievable*, not merely priced.
 */
export const CLEANSE = {
  gold: 60,          // base cost on stage 0
  goldGrowth: 1.25,  // per-stage cost multiplier (the populate scale curve)
  amount: 30,        // floor: world corruption bled per use, minimum
  fraction: 0.22,    // of current world corruption, when above the floor
  maxUses: 3,
  costClimb: 1.4,    // per-use multiplier, same curve as the Auric Cairn
  guaranteeBand: 2,
};

/** What one use of a font is worth against a world this deep in the red. */
export function cleanseAmount(world) {
  return Math.max(CLEANSE.amount, Math.round(Math.max(0, world) * CLEANSE.fraction));
}

/**
 * The pact shrine (Covenant Stone) — co-op's social valve. A volunteer takes
 * this share of the most-corrupted teammate's ledger onto their own. World
 * corruption does not move: the pact re-attributes blame, it does not absolve
 * the party. Solo runs lose nothing — the stone simply refuses (spec §2).
 */
export const PACT = { share: 0.35, maxUses: 1 };

export function voidCreditRate(world) {
  return VOIDTOUCHED.ratePerWorld * Math.max(0, world);
}
