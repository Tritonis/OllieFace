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
  // Re-priced 2026-08-08: the void must outscale what it feeds. Rate up from
  // 0.012, and the bank now deepens with the world so a Consumed party faces
  // waves rather than a metronome. Both are functions of World Corruption
  // alone, so a pristine run is byte-identical to one without the feature.
  ratePerWorld: 0.02,    // void credits per second per point of World Corruption
  bankBase: 90,          // the pristine bank — ~2 queued elites, unchanged
  bankPerWorld: 0.5,     // extra bank per point of World Corruption
  maxBank: 240,          // the ceiling the deepening bank saturates at
  interval: 4,           // seconds between spend attempts
  telegraph: 1.1,        // seconds of warning ring before the unit surfaces
  spawnRing: { min: 2.5, max: 6.5 },  // metres from the chosen seed
  minPlayerDist: 12,     // never surfaces in someone's face
  // A Voidtouched kill is counterplay, not income: it pays a quarter of a
  // normal elite's gold and XP, and returns more than double the old refund.
  refund: 0.08,          // fraction of World Corruption returned per kill
  rewardMult: 0.25,      // gold/XP multiplier on a Voidtouched victim
};

/** How deep the void is allowed to save at this world corruption. */
export function voidBankCap(world) {
  const w = Number.isFinite(world) ? Math.max(0, world) : 0;
  return Math.min(VOIDTOUCHED.maxBank, VOIDTOUCHED.bankBase + w * VOIDTOUCHED.bankPerWorld);
}

/**
 * Is this victim a Voidtouched elite? Pure and null-tolerant — callers pass
 * whatever the death event carries. The affix id lives on the enemy itself
 * (`Enemy.spawn`: `this.affix = opts.affix || null`); `victim.elite` is the
 * ELITE_STATS *stats* record and carries no id, which is why this reads
 * `.affix` and why `Corruption`'s kill listener already does the same.
 */
export function isVoidtouched(victim) {
  return !!victim && victim.affix === VOIDTOUCHED.affix;
}

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
  goldPerWorld: 1.5, // and the debt itself is on the bill: see `cleanseCost`
  guaranteeBand: 2,
};

/**
 * What one use of a font is worth against a world this deep in the red.
 *
 * Non-finite reads as a pristine world and returns the floor, the same idiom
 * `voidLayerGain` uses: the result is user-visible prompt text, and an
 * artifact `corruptionMods().feed` returning NaN would otherwise poison
 * `_world` and quote the player "bleed NaN corruption".
 */
export function cleanseAmount(world) {
  const w = Number.isFinite(world) ? Math.max(0, world) : 0;
  return Math.max(CLEANSE.amount, Math.round(w * CLEANSE.fraction));
}

/**
 * What one use of a font *costs*, at a stage, after `uses` presses, against a
 * world this deep in the red.
 *
 * The stage and per-use terms are the shrine price ladder every other shrine
 * rides. The world term is the one this slice added, and it is the point: the
 * price of the exit has to scale with the debt being retired, or corrupting all
 * run and laundering at the door is strictly dominant — every other number in
 * that loop (gold income, loot, the Herald's own stats) already scales with the
 * world, so a fixed price is a discount that grows with greed. At world 400 the
 * term is +600 gold per press, which is real chest money rather than the ~24
 * seconds of income the flat curve charged.
 *
 * A consequence worth stating: a deep visit's price *falls* across its three
 * presses, because each press retires part of the debt faster than `costClimb`
 * climbs. That is the honest reading — the second press is cleaning a smaller
 * world — and it is what the tests pin.
 *
 * Non-finite reads as pristine, the same idiom as `cleanseAmount`, because this
 * number is prompt text before it is a transaction.
 */
export function cleanseCost(stageIndex, uses = 0, world = 0) {
  const s = Number.isFinite(stageIndex) ? Math.max(0, stageIndex) : 0;
  const u = Number.isFinite(uses) ? Math.max(0, uses) : 0;
  const w = Number.isFinite(world) ? Math.max(0, world) : 0;
  return Math.round(CLEANSE.gold * Math.pow(CLEANSE.goldGrowth, s) * Math.pow(CLEANSE.costClimb, u)
    + w * CLEANSE.goldPerWorld);
}

/**
 * The pact shrine (Covenant Stone) — co-op's social valve. A volunteer takes
 * this share of the most-corrupted teammate's ledger onto their own. World
 * corruption does not move: the pact re-attributes blame, it does not absolve
 * the party. Solo runs lose nothing — the stone simply refuses (spec §2).
 */
export const PACT = { share: 0.35, maxUses: 1 };

/**
 * World corruption feeds the Director (2026-08-08 direction): the same number
 * that buys blight and Voidtouched now buys everyone's health and damage.
 * 0.004/world means Consumed-at-400 adds ~1.6 coefficient before the stage
 * multiplier — about five Director levels at minute ten. A pristine run adds
 * exactly zero, which is what keeps sp-equivalence and the "never a fun-tax
 * for the cautious" promise intact.
 */
export const PRESSURE = { perWorld: 0.004 };

export function voidCreditRate(world) {
  return VOIDTOUCHED.ratePerWorld * Math.max(0, world);
}
