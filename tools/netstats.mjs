/**
 * The reduction shared by the transport measurements, and the verdict.
 *
 * `tools/netbaseline.mjs` carries its own copy of `pct`/`dist` and cannot import
 * this one: that reducer runs inside `page.evaluate`, in the browser, where this
 * file does not exist. The copies must therefore agree by assertion rather than
 * by construction, and `tests/steam-smoke.test.mjs` pins the algorithm — ceil,
 * clamped, on a copy of the sample — with the same numbers on both sides.
 *
 * Two transports whose latency figures were reduced by different statistics are
 * not comparable, and comparing them is the entire point of the Steam arm.
 */

/**
 * The p-th percentile by nearest-rank on a sorted copy: index `ceil(p/100 * n) - 1`,
 * clamped into range. `null` for an empty sample, because a distribution of
 * nothing has no quantile and inventing 0 would read as "instant".
 */
export const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};

const round = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

/** The shape every latency figure in a record takes. Milliseconds, to 3 places. */
export const dist = (arr) => ({
  n: arr.length,
  p50: round(pct(arr, 50)),
  p95: round(pct(arr, 95)),
  p99: round(pct(arr, 99)),
  max: round(arr.length ? Math.max(...arr) : null),
  mean: round(arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null),
});

/**
 * The pass criterion agreed on issue #52 before any Steam run existed, applied
 * to a `totals` block of the shape both tools produce.
 *
 * Four checks, and the choice of which four is the substance:
 *
 * - **Reliable delivery** is absolute. The `events` channel promises exactly
 *   once, in order; a single loss, duplicate or inversion is a failure at any
 *   latency.
 * - **p99, never max.** The WebRTC baseline's p99 came in at 2.0 ms on all three
 *   runs while its `max` swung 3.3 / 5.4 / 3.6 ms. A gate written against `max`
 *   fails on noise.
 * - **Non-vacuity.** A run that sent nothing lost nothing, so "zero lost" is
 *   green on a send loop that never started. Both channels must have carried
 *   traffic for the other checks to mean anything.
 * - **Unreliable loss is recorded, not gated.** The `state` channel is
 *   unreliable by design on both transports; the baseline lost none only because
 *   loopback is lossless, and turning that accident into a threshold would fail
 *   the first honestly-impaired run.
 *
 * `limits` are milliseconds: `{ stateP99Ms, eventsP99Ms }`. The comparison is
 * `<=` — a figure landing exactly on the limit passes, because the limit is a
 * decision about what the game can absorb, not a coin toss.
 */
export function verdict(totals, limits) {
  const s = totals?.state;
  const e = totals?.events;

  const checks = [
    {
      name: 'traffic',
      ok: (s?.sent ?? 0) > 0 && (e?.sent ?? 0) > 0,
      detail: `state sent ${s?.sent ?? 0}, events sent ${e?.sent ?? 0}`,
    },
    {
      name: 'reliable delivery',
      ok: !!e && e.sent > 0 && e.lost === 0 && e.duplicates === 0 && e.outOfOrder === 0,
      detail: e
        ? `${e.received}/${e.sent} received, ${e.lost} lost, ${e.duplicates} duplicated, ${e.outOfOrder} out of order`
        : 'no events totals',
    },
    {
      name: 'state p99',
      ok: typeof s?.latencyMs?.p99 === 'number' && s.latencyMs.p99 <= limits.stateP99Ms,
      detail: `${s?.latencyMs?.p99 ?? 'none'} ms (limit ${limits.stateP99Ms} ms)`,
    },
    {
      name: 'events p99',
      ok: typeof e?.latencyMs?.p99 === 'number' && e.latencyMs.p99 <= limits.eventsP99Ms,
      detail: `${e?.latencyMs?.p99 ?? 'none'} ms (limit ${limits.eventsP99Ms} ms)`,
    },
  ];

  return { ok: checks.every((c) => c.ok), checks, limits };
}
