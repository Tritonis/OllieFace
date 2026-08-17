/**
 * Side-realm acceptance statistics over run records (issue #38).
 *
 * The whole file exists for one number, and the number is defined by an
 * author's decision recorded on the issue on 2026-08-17:
 *
 *   acceptance = visits / offers the player could ACTUALLY TAKE
 *
 * where "actually take" means the gateway's cost was affordable and the realm
 * had not already been visited this run. The rationale is that an offer nobody
 * could afford was not a choice they declined; counting it dilutes the rate and
 * hides the tension-free case the >75% rule exists to catch.
 *
 * Two consequences shape everything below.
 *
 * The first is that the denominator is a *filter*, and a filter that cannot be
 * evaluated must never quietly pass. Run records at `version < 2` carry no gold
 * at offer time, so affordability of a priced gateway is simply unknown in
 * them. Those offers are counted into `unknown` and the summary refuses to
 * publish an acceptance rate at all while any exist — a rate computed off an
 * approximated denominator would be indistinguishable from a real one at the
 * point where it drives a balance change.
 *
 * The second is that "already used" is derived here rather than trusted from
 * the record. It is recoverable from `realmVisits` alone — a realm visited
 * before an offer's timestamp was already spent — so deriving it keeps this
 * half of the denominator working on records of any version.
 */

/** Records at or above this version carry gold and band at offer time. */
export const MIN_AFFORDABILITY_VERSION = 2;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (n, d) => (d > 0 ? n / d : null);

/**
 * Every offer in a run, annotated with the two denominator predicates and the
 * visit (if any) that answered it.
 *
 * `affordable` is deliberately tri-state: `null` means the record does not say,
 * which is a different fact from "no". The gold read is `goldMax` — the most
 * gold held while the offer stood — rather than gold at the instant the door
 * appeared, because a gateway stands for a whole stage and a player who walks
 * past it, kills for ninety seconds and comes back could always afford it. The
 * offer-instant value is kept beside it as `goldAtOffer` for anyone who wants
 * the stricter reading.
 */
export function annotateOffers(run) {
  const offers = Array.isArray(run?.realmOffers) ? run.realmOffers : [];
  const visits = Array.isArray(run?.realmVisits) ? run.realmVisits : [];
  const sorted = offers.map((o, i) => ({ ...o, _i: i })).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

  return sorted.map((o) => {
    const cost = num(o.cost) ?? 0;
    const goldMax = num(o.goldMax);
    const goldAtOffer = num(o.gold);
    const purse = goldMax ?? goldAtOffer;
    // A free door is affordable without knowing anything about the purse, which
    // is what keeps altar and finale offers classifiable in old records.
    const affordable = cost <= 0 ? true : (purse === null ? null : purse >= cost);

    const priorVisits = visits.filter((v) => v.id === o.id && (v.enteredAt ?? 0) < (o.t ?? 0));
    const repeat = priorVisits.length > 0;

    // The visit that answered this offer: the first visit of the realm at or
    // after the offer, and before the same realm was offered again.
    const nextSame = sorted.find((x) => x.id === o.id && (x.t ?? 0) > (o.t ?? 0));
    const until = nextSame ? (nextSame.t ?? Infinity) : Infinity;
    const visit = visits.find((v) => v.id === o.id
      && (v.enteredAt ?? 0) >= (o.t ?? 0) && (v.enteredAt ?? 0) < until) ?? null;

    const eligible = !repeat && affordable === true;
    const unknown = !repeat && affordable === null;
    return {
      ...o, cost, goldMax, goldAtOffer, affordable, repeat, eligible, unknown,
      accepted: !!visit, visit,
    };
  });
}

/** Seconds from leaving a realm to entering the next stage, when both are known. */
function timeToNextStage(run, visit) {
  const stages = Array.isArray(run?.stages) ? run.stages : [];
  const out = num(visit?.exitedAt);
  if (out === null || visit?.stage === null || visit?.stage === undefined) return null;
  const next = stages
    .filter((s) => num(s.index) !== null && s.index > visit.stage && num(s.enteredAt) !== null)
    .sort((a, b) => a.index - b.index)[0];
  return next ? next.enteredAt - out : null;
}

/**
 * Aggregate one bucket of annotated offers plus the visits they produced.
 *
 * `acceptance` is null — not zero, and not an approximation — whenever any
 * offer in the bucket could not be classified. See the header.
 */
function summariseBucket(rows) {
  const eligible = rows.filter((r) => r.offer.eligible);
  const unknown = rows.filter((r) => r.offer.unknown);
  const accepted = eligible.filter((r) => r.offer.accepted);
  const durations = accepted.map((r) => num(r.offer.visit?.duration)).filter((x) => x !== null);
  const items = accepted.map((r) => num(r.offer.visit?.items)).filter((x) => x !== null);
  const toNext = accepted.map((r) => timeToNextStage(r.run, r.offer.visit)).filter((x) => x !== null);
  const runsWithVisit = new Set(accepted.map((r) => r.run));
  const won = [...runsWithVisit].filter((r) => r.outcome?.won === true).length;

  return {
    offers: rows.length,
    eligibleOffers: eligible.length,
    unclassifiableOffers: unknown.length,
    visits: accepted.length,
    acceptance: unknown.length ? null : rate(accepted.length, eligible.length),
    meanDuration: mean(durations),
    meanItems: mean(items),
    meanTimeToNextStage: mean(toNext),
    postRealmWinRate: runsWithVisit.size ? won / runsWithVisit.size : null,
  };
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return Object.fromEntries([...out].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([k, v]) => [k, summariseBucket(v)]));
}

/** The build a run was: survivor plus the artifacts it ran under. */
export function buildKey(run) {
  const arts = Array.isArray(run?.artifacts) ? [...run.artifacts].sort() : [];
  return `${run?.survivor ?? 'unknown'}${arts.length ? ` +${arts.join('+')}` : ''}`;
}

/**
 * The whole report: overall, per realm, per build, per corruption band at the
 * moment of the offer, and per difficulty.
 *
 * `offerRate` is offers per stage reached, which is the "how often does this
 * even come up" half of the question; acceptance is the other half.
 */
export function summarise(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const rows = [];
  let stages = 0;
  for (const run of list) {
    stages += Array.isArray(run?.stages) ? run.stages.length : 0;
    for (const offer of annotateOffers(run)) rows.push({ run, offer });
  }
  // Finale doors are the route question (#37), not the detour question: they
  // end the run rather than costing time inside it, and folding them in would
  // put a door with no opportunity cost into a rate about opportunity cost.
  const detours = rows.filter((r) => r.offer.kind !== 'finale');
  const stale = list.filter((r) => (r.version ?? 1) < MIN_AFFORDABILITY_VERSION).length;

  return {
    runs: list.length,
    staleRuns: stale,
    stages,
    offerRate: rate(detours.length, stages),
    overall: summariseBucket(detours),
    byRealm: groupBy(detours, (r) => r.offer.id ?? 'unknown'),
    byBuild: groupBy(detours, (r) => buildKey(r.run)),
    byBand: groupBy(detours, (r) => `band ${r.offer.band ?? 'unknown'}`),
    byDifficulty: groupBy(detours, (r) => r.run?.difficulty ?? 'unknown'),
    finale: summariseBucket(rows.filter((r) => r.offer.kind === 'finale')),
  };
}

/**
 * The verdict the issue asks for, or an honest refusal.
 *
 * The threshold is the issue's own: acceptance above roughly 75% *regardless of
 * build or run state* means the choice carries no tension. "Regardless" is read
 * strictly — every bucket with enough offers to mean anything must clear it,
 * because one build that declines is exactly the tension the rule looks for.
 */
export function verdict(report, { threshold = 0.75, minOffers = 10 } = {}) {
  if (report.overall.unclassifiableOffers > 0) {
    return {
      verdict: 'NO VERDICT',
      why: `${report.overall.unclassifiableOffers} of ${report.overall.offers} offers cannot be `
        + 'classified as affordable or not: the records predate gold-at-offer capture. '
        + 'Fresh runs on record version 2 or later are needed.',
    };
  }
  const buckets = [
    ...Object.entries(report.byBuild).map(([k, v]) => [`build ${k}`, v]),
    ...Object.entries(report.byBand).map(([k, v]) => [k, v]),
  ].filter(([, v]) => v.eligibleOffers >= minOffers);

  if (!buckets.length || report.overall.eligibleOffers < minOffers) {
    return { verdict: 'NO VERDICT', why: `fewer than ${minOffers} eligible offers in any bucket` };
  }
  const below = buckets.filter(([, v]) => (v.acceptance ?? 0) <= threshold);
  if (below.length) {
    return {
      verdict: 'HAS TENSION',
      why: `${below.length} bucket(s) accept at or below ${threshold}: `
        + below.map(([k, v]) => `${k} ${(v.acceptance * 100).toFixed(0)}%`).join(', '),
    };
  }
  return {
    verdict: 'NO TENSION',
    why: `every bucket with >=${minOffers} eligible offers exceeds ${threshold}; `
      + `overall ${(report.overall.acceptance * 100).toFixed(0)}%. The detour needs a cost.`,
  };
}
