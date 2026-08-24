/**
 * The alignment commitment ledger (issue #169).
 *
 * Live corruption answers "how dangerous is the world right now". It is the
 * wrong number to ask "what did this run become", and the 2026-08-23 audit
 * showed exactly why: cleansing drops the live gauge, but `_peak` survives, the
 * blight stacks survive, the void marks survive, and the finale gate reads the
 * live band at checkout. A player can descend for everything corruption mints,
 * ward the gauge back to Pristine, and walk into the clean route holding both
 * halves. Mixed is a superset rather than a compromise.
 *
 * The ledger is the second number. It records *acts of commitment* — the
 * decisions that bought the run its character — and it never falls. Cleansing
 * still buys down live danger; it cannot buy back history.
 *
 * This module is data and pure functions only: definitions, weights, and the
 * queries that read a ledger. It knows nothing about systems, events or the
 * world, which is what lets `Corruption` own the mutation while everything from
 * route gates to the logbook reads the same answers.
 *
 * ## Invariants
 *
 * 1. **Commitment is monotone.** Every write goes through one verb (`commit`,
 *    in `systems/Corruption.js`) that only ever adds. There is no path — no
 *    font, no sanctuary, no bleed, no net message — that lowers a class total.
 *    Live corruption falling and commitment holding is the whole point.
 *
 * 2. **Capstone eligibility is mutually exclusive BY CONSTRUCTION.** Not by two
 *    thresholds that happen not to overlap — by a partition. `alignmentOf` is a
 *    single-valued function of the ledger, and each capstone requires that
 *    function to have returned *its* value. A both-eligible ledger would
 *    require one call to return two values, so no reachable state can be one,
 *    and no future re-tuning of the weights or the thresholds can make one.
 *
 * 3. **Route history answers from the ledger, never from the live band.** The
 *    queries here take a ledger and nothing else. A caller that wants to know
 *    what a run committed to cannot accidentally ask the gauge instead.
 *
 * 4. **Totals are authoritative; `history` is advisory.** The entry log is
 *    capped (`HISTORY_MAX`) and drops its oldest entries, so a very long run's
 *    history is a window. The class totals are separate counters and stay exact
 *    and monotone regardless. Never re-derive a total by summing `history`.
 *
 * Nothing in the game consumes these queries yet. #169 defines and exposes;
 * #171 (finale routing), #170 (mutual constraint) and #173-179 (new sources)
 * adopt. Gameplay is deliberately unchanged by this file existing.
 */

/** The three commitment classes a source can pay into. */
export const COMMITMENT = {
  corrupt: 'corrupt',
  pure: 'pure',
  /** Deliberate hybridisation — a Tempering that *replaces* both parents (#179). */
  mixed: 'mixed',
};

/** What a ledger reads as. One of these, never two — see invariant 2. */
export const ALIGNMENT = {
  neutral: 'neutral',
  pure: 'pure',
  corrupt: 'corrupt',
  mixed: 'mixed',
};

/**
 * Every act that commits a run, what it commits to, and what it is worth.
 *
 * `per` is the weight of one act, except where `perUnit` is set: those are
 * priced per point of the amount handed to `commit` (warding is the only one
 * today — it arrives as corruption removed, not as a countable act).
 *
 * `wired: false` entries are the extension point for the tickets that own those
 * mechanics. They are declared here, priced here, and accepted by `commit`
 * here — a downstream ticket adds one call site and nothing else. Declaring
 * them is not dead code: it is the contract those tickets are written against,
 * and `tests/alignment-ledger.test.mjs` holds the table to it.
 */
export const SOURCES = {
  // --- Corrupt commitment: acts that took the void's side. ------------------
  /** A chest forced open on void credit (`itemOffer` outcome 'corrupt'). */
  corruptChest: { class: COMMITMENT.corrupt, per: 3, wired: true },
  /** A held stack converted to its blight counterpart at a band crossing. */
  blightMutation: { class: COMMITMENT.corrupt, per: 4, wired: true },
  /** Void Bargains, by kind. A reroll is a nudge; a pact is a covenant. */
  bargainReroll: { class: COMMITMENT.corrupt, per: 1, wired: true },
  bargainSynergy: { class: COMMITMENT.corrupt, per: 4, wired: true },
  bargainPact: { class: COMMITMENT.corrupt, per: 5, wired: true },
  /** RUIN — the one-way door. Priced above the capstone floor on purpose: a
   *  run that let the void all the way in has committed, and one act says so. */
  ruin: { class: COMMITMENT.corrupt, per: 24, wired: true },
  /** A Wound fed rather than sealed (#178). */
  woundFed: { class: COMMITMENT.corrupt, per: 5, wired: false },
  /** A Vow broken (#177) — the cost of having made one. */
  vowBroken: { class: COMMITMENT.corrupt, per: 6, wired: false },

  // --- Pure commitment: acts that took it back. -----------------------------
  /** Corruption removed by a player's own hand, per point. One mote's worth
   *  (MOTE.per = 40) is 2 — so warding is real commitment, but a handful of
   *  incidental Voidtouched kills stays inside the tolerance below. */
  warded: { class: COMMITMENT.pure, perUnit: 0.05, wired: true },
  /** A Sanctuary window bought. */
  sanctuary: { class: COMMITMENT.pure, per: 2, wired: true },
  /** A Consecration — three motes, purity's most expensive press. */
  consecration: { class: COMMITMENT.pure, per: 5, wired: true },
  /** A blight stack stabilised back to its base form. */
  stabilised: { class: COMMITMENT.pure, per: 3, wired: true },
  /** A Wound sealed (#178). */
  woundSealed: { class: COMMITMENT.pure, per: 5, wired: false },
  /** A Vow kept to the end of its scope (#177). */
  vowKept: { class: COMMITMENT.pure, per: 6, wired: false },

  // --- Mixed commitment: acts that are neither side's. ----------------------
  /** A Tempering: one argent and one blight effect spent for a third thing
   *  (#179). Its own class because it is a *choice against both capstones,
   *  not a halfway point between them. */
  tempered: { class: COMMITMENT.mixed, per: 8, wired: false },
};

/**
 * Off-class commitment this small is forgiven when reading alignment.
 *
 * Without it the partition is brittle in a way that would be read as a bug: a
 * corrupted run that happens to kill two Voidtouched elites has warded
 * something, and "one incidental kill costs you the capstone" is not the
 * decision this system is for. A tolerance keeps the crispness where it
 * matters — a deliberate act on the other side still counts — and, crucially,
 * changing these numbers cannot break invariant 2, because exclusivity comes
 * from the partition and not from the thresholds.
 */
export const TOLERANCE = { corrupt: 3, pure: 3, mixed: 0 };

/** Commitment in a class needed before its capstone is on the table. */
export const CAPSTONE = { corrupt: 20, pure: 20 };

/** How many history entries a ledger keeps. See invariant 4. */
export const HISTORY_MAX = 256;

/** A run that has committed to nothing. The shape every consumer can assume. */
export function emptyLedger() {
  return { corrupt: 0, pure: 0, mixed: 0, history: [] };
}

/** What one act of `source` is worth for `amount`. Pure; 0 for anything unknown. */
export function weightOf(source, amount = 1) {
  const def = SOURCES[source];
  if (!def) return 0;
  const n = Number.isFinite(amount) ? amount : 0;
  if (def.perUnit !== undefined) return n > 0 ? def.perUnit * n : 0;
  return n > 0 ? def.per * n : 0;
}

/** Which class `source` pays into, or null if it is not a commitment source. */
export function classOf(source) {
  return SOURCES[source]?.class ?? null;
}

function totals(ledger) {
  return {
    corrupt: Math.max(0, Number(ledger?.corrupt) || 0),
    pure: Math.max(0, Number(ledger?.pure) || 0),
    mixed: Math.max(0, Number(ledger?.mixed) || 0),
  };
}

/** The class totals, defensively normalised. Pure — never touches `ledger`. */
export function commitmentTotals(ledger) {
  return totals(ledger);
}

/**
 * What this run has become. The partition — see invariant 2. Single-valued by
 * construction, which is the only reason the capstone predicates below can be
 * proved exclusive rather than merely observed to be.
 *
 * A deliberate Tempering reads as mixed on its own, because that is what
 * choosing it means; otherwise, commitment on both sides past their tolerances
 * is mixed, one side alone is that side, and neither is neutral.
 */
export function alignmentOf(ledger) {
  const t = totals(ledger);
  const c = t.corrupt > TOLERANCE.corrupt;
  const p = t.pure > TOLERANCE.pure;
  const m = t.mixed > TOLERANCE.mixed;
  if (m || (c && p)) return ALIGNMENT.mixed;
  if (c) return ALIGNMENT.corrupt;
  if (p) return ALIGNMENT.pure;
  return ALIGNMENT.neutral;
}

/**
 * Is the full-Corrupted capstone open to this run?
 *
 * Reads the partition first, so this cannot hold at the same time as
 * `pureCapstoneEligible` — one `alignmentOf` call cannot answer both.
 */
export function corruptCapstoneEligible(ledger) {
  return alignmentOf(ledger) === ALIGNMENT.corrupt
    && totals(ledger).corrupt >= CAPSTONE.corrupt;
}

/** Is the full-Pure capstone open? The mirror, and exclusive with it. */
export function pureCapstoneEligible(ledger) {
  return alignmentOf(ledger) === ALIGNMENT.pure
    && totals(ledger).pure >= CAPSTONE.pure;
}

/**
 * What this run committed to, in order — invariant 3's answer to "which route
 * did they actually walk", as opposed to "which band are they standing in".
 *
 * Returns a defensive copy: callers get a snapshot they cannot use to reach
 * back into the live ledger. `sinceStage` narrows to a stage boundary for the
 * per-stage questions (#177's vow scopes) without a second accessor.
 */
export function routeHistory(ledger, { source = null, cls = null, sinceStage = null } = {}) {
  const rows = Array.isArray(ledger?.history) ? ledger.history : [];
  const out = [];
  for (const e of rows) {
    if (!e) continue;
    if (source && e.source !== source) continue;
    if (cls && e.class !== cls) continue;
    if (sinceStage !== null && !(Number(e.stage) >= sinceStage)) continue;
    out.push({ ...e });
  }
  return out;
}

/** Has this run ever committed `source` (or, with no source, anything at all)? */
export function hasCommitted(ledger, source = null) {
  if (source) return routeHistory(ledger, { source }).length > 0;
  const t = totals(ledger);
  return t.corrupt > 0 || t.pure > 0 || t.mixed > 0;
}

/**
 * Read a persisted ledger back into the canonical shape. Anything absent,
 * malformed, or hostile becomes a neutral run rather than a throw — old saves
 * predate every field here and must load unchanged (`Profile` normalisation).
 */
export function sanitizeLedger(raw) {
  const t = totals(raw);
  const rows = Array.isArray(raw?.history) ? raw.history : [];
  const history = [];
  for (const e of rows) {
    if (!e || !SOURCES[e.source]) continue;
    history.push({
      t: Number(e.t) || 0,
      stage: Number.isFinite(e.stage) ? e.stage : null,
      source: e.source,
      class: SOURCES[e.source].class,
      amount: Math.max(0, Number(e.amount) || 0),
    });
    if (history.length >= HISTORY_MAX) break;
  }
  return { ...t, history };
}
