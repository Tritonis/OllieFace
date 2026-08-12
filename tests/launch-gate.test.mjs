// tests/launch-gate.test.mjs
//
// The corpse launch's percentile gate. reviews/round9/juice-probe.json
// measured the old floor-only rule at 90.1% of late-run kills (median
// overkill 13x the pool) - the launch had become the ambient behaviour of
// dying. The gate is pure and deterministic: same kill stream in, same
// launch decisions out. These tests are the spec.
import { GATE, quantile, shouldLaunch } from '../src/systems/LaunchGate.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const close = (a, b) => Math.abs(a - b) < 1e-9;

console.log('quantile');
{
  ok(close(quantile([], 0.7), 0), 'empty window reads 0 (permissive, not a crash)');
  ok(close(quantile([5], 0.7), 5), 'single element is every quantile of itself');
  ok(close(quantile([1, 2, 3, 4, 5], 0.5), 3), 'median of five');
  ok(close(quantile([1, 2, 3, 4, 5], 0.75), 4), 'p75 of five lands on the fourth order statistic');
  ok(close(quantile([1, 3], 0.5), 2), 'interpolates between order statistics');
  ok(close(quantile([3, 1, 2], 0.0), 1) && close(quantile([3, 1, 2], 1.0), 3), 'does not require sorted input');
}

console.log('shouldLaunch: the floor is absolute');
{
  ok(!shouldLaunch(0.2, [], 0.35), 'under the floor, empty window: no launch');
  ok(!shouldLaunch(0.34, Array(32).fill(0.01), 0.35), 'under the floor, weak window: still no launch');
  ok(!shouldLaunch(0.2, [], 0.35, true), 'under the floor, even an elite stays down');
}

console.log('shouldLaunch: warm-up is today\'s behaviour');
{
  ok(shouldLaunch(0.4, [], 0.35), 'first kill of a run launches on the floor alone');
  ok(shouldLaunch(0.4, Array(GATE.warmup - 1).fill(9), 0.35), 'window one short of warm-up: floor alone, however hot the window');
  ok(!shouldLaunch(0.4, Array(GATE.warmup).fill(9), 0.35), 'window at warm-up: the percentile takes over');
}

console.log('shouldLaunch: the percentile is the reward');
{
  // A saturated late-run window: every recent kill massively overkilled.
  const late = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
  ok(!shouldLaunch(12, late, 0.35), 'a median-for-the-window kill does not launch');
  ok(shouldLaunch(24, late, 0.35), 'a standout kill does');
  ok(shouldLaunch(12, late, 0.35, true), 'an elite at the same fraction launches anyway');
  // A mid-run window: most kills barely clear the floor.
  const mid = [0.05, 0.1, 0.1, 0.2, 0.2, 0.3, 0.4, 0.5, 0.6, 0.9];
  ok(shouldLaunch(0.9, mid, 0.35), 'a hot mid-run kill clears its window');
  ok(!shouldLaunch(0.36, mid, 0.35), 'a barely-over-floor kill in a hotter window does not');
}

console.log('determinism');
{
  const w = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const a = shouldLaunch(5, w, 0.35), b = shouldLaunch(5, w, 0.35);
  ok(a === b, 'same inputs, same answer');
  ok(JSON.stringify(w) === '[1,2,3,4,5,6,7,8,9]', 'the window is not mutated');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
