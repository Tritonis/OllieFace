/**
 * The corpse-launch percentile gate.
 *
 * reviews/round9/juice-probe.json (commit c6795cb) measured the floor-only
 * rule at 90.1% of late-run kills launched, median overkill 13x the victim's
 * pool - the launch had stopped being a signal and become the ambient
 * behaviour of dying. No constant can fix that: late-run overkill fractions
 * sit an order of magnitude above the whole mid-run distribution, so any
 * floor low enough to keep the mid run alive saturates the late run.
 *
 * So the gate normalises against the run itself: a common kill launches only
 * if it also beats the `percentile` of the last `window` kills' fractions -
 * whatever the current damage profile, roughly the top third of *non-elite*
 * kills throw a body (see reviews/launch-retune/README.md "Honest
 * limitations" - the measured fixtures carry ~1% elite density against a
 * real eliteChance of up to 0.38, so real play launches a substantially
 * larger overall share). Elites and bosses bypass the percentile (rare by
 * construction, and exactly the kills that should always pay off). Under `warmup` samples
 * the floor alone decides, which keeps the first kills of a run - and the
 * capture harness's single-kill scenarios - on the old, deterministic rule.
 *
 * Pure and deterministic on purpose: no RNG, no clock, no state. VFX owns
 * the ring buffer; this module owns the decision.
 */
export const GATE = { window: 32, warmup: 8, percentile: 0.70 };

/** q-th quantile (0..1) of `values`, linear interpolation, input unsorted. */
export function quantile(values, q) {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(1, Math.max(0, q)) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Decide a launch. See the header comment; the five rules are the spec. */
export function shouldLaunch(frac, recent, floor, always = false, gate = GATE) {
  if (!(frac >= floor)) return false;
  if (always) return true;
  if (recent.length < gate.warmup) return true;
  return frac >= quantile(recent, gate.percentile);
}
