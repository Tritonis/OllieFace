/**
 * Downed-and-revive tuning. One table for the co-op death fork: how long a
 * downed body has, how long a teammate must stand over it, and how much health
 * either ending hands back.
 *
 * Every value here is a playtest dial, not a law. The Phase-1 gate is "does a
 * teammate going down change what you are doing right now" — tune toward that.
 * Solo never reads any of it: with a roster of one, lethal damage is still a
 * plain death (see `Combat._kill`).
 */
export const REVIVE = {
  /** Seconds a downed pawn has before `finishDowned` kills it for real. */
  BLEEDOUT_S: 40,
  /** Seconds of uninterrupted proximity to complete a revive. */
  REVIVE_S: 4,
  /** Metres (2D) a reviver may stand from the downed body. */
  REVIVE_RADIUS: 4,
  /** Fraction of max health a revived pawn stands up with. */
  REVIVE_HEALTH_FRAC: 0.4,
  /** Fraction of max health a pawn returns at when a new stage starts. */
  RETURN_HEALTH_FRAC: 0.5,
};
