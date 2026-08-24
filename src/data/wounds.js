// src/data/wounds.js
/**
 * Blight Wounds (#178) — the prototype that gives a blight patch a verb.
 *
 * A patch is scenery: it grows where greed happened and the run walks around
 * it. A Wound is the same ground with a decision standing on it, and the three
 * answers are the whole feature:
 *
 *   Seal   — hold the ground for a fixed window. The patch closes, the void
 *            stops surfacing there, the ledger records a pure commitment and
 *            the world gives some corruption back.
 *   Feed   — take the void's money now. The patch spreads, the corruption it
 *            charges mints marks against the descent, and the ledger records a
 *            corrupt commitment.
 *   Ignore — the absence of a press. The hazard simply stays, which is what a
 *            blight patch has always been. Nothing here implements it.
 *
 * Everything below is a bound. The prototype's failure mode is a stage that
 * grows wounds without limit — three seeds promoted per patch, a fed patch
 * spreading to the cap and then past it — so the caps are data, they are
 * asserted in `tests/wounds.test.mjs`, and every consumer clamps against them
 * rather than trusting its caller.
 */
export const WOUND = {
  /** Hard cap on promoted wounds per stage. Three is a circuit; four is chores. */
  max: 3,
  /** Only a real greed mark is worth a decision — a strength-1 scuff is not. */
  minStrength: 2,
  /** Metres between two wounds, so the stage never offers the same press twice over. */
  minSpacing: 16,
  /** Interaction radius of the prop. */
  radius: 3.2,

  // --- Seal ---------------------------------------------------------------
  /** Seconds of holding the ground. Voidtouched keep surfacing at the seed
   *  the whole time — the seed is still in the Director's void list — so the
   *  window is the pressure, and nothing has to be spawned to make it one. */
  sealWindow: 12,
  /** How far the sealer may stray before the window resets. */
  sealHold: 4.0,
  /** Corruption handed back on a seal. Committed separately as `warded`. */
  sealWard: 8,

  // --- Feed ---------------------------------------------------------------
  /** Corruption taken on a feed. It is the payout as well as the price: the
   *  mint rides `peak`, so a feed buys marks toward the altar's bargains at
   *  the same instant it makes the ground round here worse. */
  feedCorruption: 18,
  /** Strength added to the patch on a feed, and the hard ceiling on it.
   *  `Blight` clamps the event's own number against `expandCap`, so a caller
   *  that asks for 99 gets `expandCap` and the patch cannot run away. */
  feedExpand: 2,
  expandCap: 3,

  // --- The press ----------------------------------------------------------
  /** Seconds the seal/feed window stands before it lapses into the seal. */
  choiceSeconds: 10,
};

/**
 * The two tokens the choice window answers with (#178, integration M2).
 *
 * They ride the `baseId` field the blight toll and the argent altar already
 * use, so the panel, `chooseMutation` and the reply path need no second
 * vocabulary — the same reason #204 gave for reusing it. Namespaced so a token
 * can never collide with a real item id.
 */
export const WOUND_PICK = { seal: 'wound:seal', feed: 'wound:feed' };

/**
 * Whether the `ordinal`-th blight seed of this stage is promoted to a Wound.
 *
 * Pure, and salted-then-avalanched rather than salted alone — the same
 * correction `data/vows.js selectVow` documents at length. A raw
 * `seed ^ (k * n)` differs only in its low bits across neighbouring seeds and
 * ordinals, and a one-in-three predicate read off those low bits is exactly
 * where that bias becomes "this run never grows a wound". fmix32 makes every
 * bit of the answer depend on every bit of (seed, stage, ordinal).
 *
 * Never `ctx.rng`: promotion is decided while the stage is running, and a
 * single draw on the shared stream would displace every later loot roll and
 * every director spawn relative to a greed-free run of the same seed — the
 * sp-equivalence argument `Director.spendVoidCredits` and
 * `Interactables._populateShrines` both make.
 */
export function promoteWound(seed, stageIndex, ordinal) {
  let h = (((seed >>> 0) ^ (Math.imul(0x9e3779b9, stageIndex + 1) >>> 0)) >>> 0);
  h = (h ^ (Math.imul(0x85ebca6b, ordinal + 1) >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % 3 === 0;
}
