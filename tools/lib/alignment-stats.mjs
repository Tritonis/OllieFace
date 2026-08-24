/**
 * Alignment statistics over run records (issue #166).
 *
 * The corruption economy's audit asks two questions that a run cannot answer
 * on its own and a hundred runs can:
 *
 *   1. Do players still take every available reward? If the corrupt open is
 *      taken whenever the gold open is not affordable, and chests are never
 *      left standing, then "pay in corruption" is not a decision — it is a
 *      delay before the same outcome.
 *   2. Do mixed inventories dominate? A run that ends holding both argent and
 *      blight has not chosen a pole, and if that is the common ending then the
 *      two poles are not in tension with each other at all.
 *
 * Everything here is derived from the record and nothing is trusted from a
 * summary field, for the reason `realm-stats.mjs` states at length: a silently
 * miscomputed rate is the input to a balance change.
 *
 * ## Absence is not zero
 *
 * Records below version 3 carry no `itemOffers`, no `mutationChoices` and no
 * `chestsLeft`. Those runs are counted into `stale` and excluded from the
 * arithmetic entirely rather than folded in as runs where nothing happened —
 * an old export read as "the player left every chest" is exactly the quiet
 * wrong conclusion this tooling exists to prevent. The same rule applies one
 * level down: a *stage* whose `chestsLeft` is null contributes nothing to the
 * left count, and the run says so via `unknownStages`.
 */

/**
 * ## A guest's record is not a record of anyone's decisions
 *
 * A co-op client's `Corruption` is written by the host's replicated events, so
 * its `fed`, `peakWorld`, `crossings` and marks are the *host's* trajectory
 * wearing the guest's name — the same run counted once per peer. Worse in the
 * direction that matters here: `Interactables` gates `interact` on authority,
 * so a guest raises no `itemOffer` at all while still contributing every chest
 * left standing on its stages, which drags the take rate toward zero in
 * proportion to the size of the lobby rather than to anything a player did.
 * One guest measurably moved it from 0.50 to 0.33.
 *
 * So client-role runs are excluded from the verdicts outright and reported as
 * `remote`. Filtering is on the *role*, deliberately, and never on the shape of
 * the numbers: a pattern filter ("marks minted with nothing spent") would also
 * throw away the single-player runs that are the design's own refutation
 * condition, which is the finding this tooling exists to be able to see.
 *
 * Absence is includable. A record written before the role was stamped reliably
 * cannot be a guest's, because it predates the replication that made a guest's
 * corruption someone else's — so `netRole` missing means the pre-co-op reality
 * and is scored.
 */

/** Records at or above this version carry the alignment fields. */
export const MIN_ALIGNMENT_VERSION = 3;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rate = (n, d) => (d > 0 ? n / d : null);
const arr = (v) => (Array.isArray(v) ? v : []);

/** The five outcomes a mutation window can end in, plus the two odd ones. */
export const MUTATION_OUTCOMES = [
  'explicit-choice', 'refusal', 'timeout', 'superseded', 'death', 'run-end', 'unknown',
];

/** Does this record carry the #166 fields at all? */
export function hasAlignment(run) {
  return (num(run?.version) ?? 0) >= MIN_ALIGNMENT_VERSION;
}

/**
 * Was this run played as a co-op guest? Only the exact role string counts —
 * anything else, including absence, is a run whose decisions were its own.
 */
export function isRemote(run) {
  return run?.netRole === 'client';
}

/**
 * The alignment shape a run *ended* in: the last boundary snapshot it wrote.
 *
 * Stages are the spine, so the last stage's `alignOut` is the answer; a run
 * that ended inside a realm may only have the realm's, and a run that ended
 * before any boundary closed has none. Null, never a zeroed stand-in.
 */
export function finalAlign(run) {
  const stages = arr(run?.stages);
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i]?.alignOut) return stages[i].alignOut;
  }
  const visits = arr(run?.realmVisits);
  for (let i = visits.length - 1; i >= 0; i--) {
    if (visits[i]?.alignOut) return visits[i].alignOut;
  }
  return null;
}

/**
 * Which pole a shelf sits on. `mixed` is the finding the second question is
 * about; `neither` is a run that held no card of either tier, which is a real
 * outcome (a short run) and not a missing measurement.
 */
export function poleOf(align) {
  if (!align) return null;
  const a = num(align.argent) ?? 0;
  const b = num(align.blight) ?? 0;
  if (a > 0 && b > 0) return 'mixed';
  if (a > 0) return 'argent';
  if (b > 0) return 'blight';
  return 'neither';
}

/** One run's alignment behaviour, or null when the record cannot say. */
export function annotateRun(run) {
  if (!hasAlignment(run) || isRemote(run)) return null;

  const offers = arr(run.itemOffers);
  const takenNormally = offers.filter((o) => o.outcome === 'taken-normally').length;
  const takenCorrupted = offers.filter((o) => o.outcome === 'taken-corrupted').length;

  const stages = arr(run.stages);
  let left = 0;
  let unknownStages = 0;
  for (const s of stages) {
    const n = num(s?.chestsLeft);
    if (n === null) unknownStages++; else left += n;
  }

  const mutations = {};
  for (const k of MUTATION_OUTCOMES) mutations[k] = 0;
  for (const m of arr(run.mutationChoices)) {
    const k = MUTATION_OUTCOMES.includes(m?.outcome) ? m.outcome : 'unknown';
    mutations[k]++;
  }

  const align = finalAlign(run);
  return {
    id: run.id ?? null,
    complete: !!run.complete,
    takenNormally,
    takenCorrupted,
    taken: takenNormally + takenCorrupted,
    left,
    unknownStages,
    // The purified arm of the taxonomy: a blight stack bought back into its
    // base. It is a salvage of an item already taken, so it is counted beside
    // the offer outcomes and never inside them.
    purifiedSalvaged: arr(run.stabilisations).length,
    mutations,
    align,
    pole: poleOf(align),
  };
}

/**
 * The whole picture over many runs. Deterministic in the runs given: no clock,
 * no environment, and every list walked in the order the export holds it.
 */
export function summarise(runs) {
  const all = arr(runs);
  const annotated = [];
  let stale = 0;
  let remote = 0;
  for (const r of all) {
    // Counted apart from `stale`: an old export is a run this build cannot
    // read, a guest's is a run that must not be read, and a reader deciding
    // whether to go and play more runs needs to know which they have.
    if (isRemote(r)) { remote++; continue; }
    const a = annotateRun(r);
    if (a) annotated.push(a); else stale++;
  }

  const sum = (f) => annotated.reduce((acc, a) => acc + f(a), 0);
  const takenNormally = sum((a) => a.takenNormally);
  const takenCorrupted = sum((a) => a.takenCorrupted);
  const taken = takenNormally + takenCorrupted;
  const left = sum((a) => a.left);
  const unknownStages = sum((a) => a.unknownStages);
  const purifiedSalvaged = sum((a) => a.purifiedSalvaged);

  const mutations = {};
  for (const k of MUTATION_OUTCOMES) mutations[k] = sum((a) => a.mutations[k]);
  const mutationTotal = MUTATION_OUTCOMES.reduce((acc, k) => acc + mutations[k], 0);

  const poles = { mixed: 0, argent: 0, blight: 0, neither: 0, unknown: 0 };
  for (const a of annotated) poles[a.pole ?? 'unknown']++;
  const poleKnown = poles.mixed + poles.argent + poles.blight + poles.neither;

  return {
    runs: all.length,
    scored: annotated.length,
    stale,
    remote,
    offers: {
      takenNormally, takenCorrupted, taken, left,
      resolved: taken + left,
      unknownStages,
      takeRate: rate(taken, taken + left),
      corruptShare: rate(takenCorrupted, taken),
      purifiedSalvaged,
    },
    mutations: { ...mutations, total: mutationTotal, choiceRate: rate(mutations['explicit-choice'], mutationTotal) },
    poles: { ...poles, known: poleKnown, mixedShare: rate(poles.mixed, poleKnown) },
  };
}

/**
 * The two verdicts, each against a stated rule and each willing to say NO
 * VERDICT. The thresholds are the audit's own reading and are parameters here
 * so a re-reading does not need a code change to test.
 *
 *  · rewards — "take rate" is chests opened over chests resolved (opened plus
 *    left standing at a stage close). Above `takeThreshold` means the offer is
 *    never declined, which is the tension-free case.
 *  · inventories — the share of scored runs ending holding both poles.
 */
export function verdict(report, { takeThreshold = 0.9, mixedThreshold = 0.5, minOffers = 20, minRuns = 10 } = {}) {
  const o = report.offers;
  const p = report.poles;

  let rewards;
  if (o.resolved < minOffers || o.takeRate === null) {
    rewards = { verdict: 'NO VERDICT', why: `${o.resolved} resolved chest offer(s); ${minOffers} are needed before a take rate means anything` };
  } else if (o.takeRate >= takeThreshold) {
    rewards = { verdict: 'TAKES EVERYTHING', why: `${(o.takeRate * 100).toFixed(0)}% of offered chests were opened, ${(o.corruptShare * 100).toFixed(0)}% of them on corruption — the offer is not being declined` };
  } else {
    rewards = { verdict: 'DECLINES SOME', why: `${(o.takeRate * 100).toFixed(0)}% of offered chests were opened; ${o.left} were left standing` };
  }

  let inventories;
  if (report.scored < minRuns || p.mixedShare === null) {
    inventories = { verdict: 'NO VERDICT', why: `${report.scored} scored run(s); ${minRuns} are needed before a shelf mix means anything` };
  } else if (p.mixedShare >= mixedThreshold) {
    inventories = { verdict: 'MIXED DOMINANT', why: `${(p.mixedShare * 100).toFixed(0)}% of runs ended holding both argent and blight — the poles are not in tension` };
  } else {
    inventories = { verdict: 'POLES HOLD', why: `${(p.mixedShare * 100).toFixed(0)}% of runs ended mixed; ${p.argent} ended argent-only and ${p.blight} blight-only` };
  }

  return { rewards, inventories };
}
