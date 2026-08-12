# Overkill Launch Retune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the corpse launch a reward again in the late run. `reviews/round9/README.md` §(a) measured it at **90.1% of late-run kills** (median overkill 13.08× the victim's pool, every launch at max power) against its own healthy band of 10–70%; mid-run sits at a healthy 31.4%. That file explicitly reserves the retune for a follow-up slice: "Retuning `LAUNCH.minOverkillFrac` is the next slice's argument to have against this file."

**Architecture:** A constant retune cannot work — the argument to have against the record: late-run median overkill is 13× the pool, so any threshold low enough to keep mid-run alive (mid p90 is 0.92) launches essentially every late kill, and any threshold high enough to starve the late run (>13) kills mid-run stone dead. The gate needs a shape, not a number: keep the absolute floor `LAUNCH.minOverkillFrac = 0.35` exactly as-is, and add a **rolling-percentile condition** — a common kill launches only if its overkill fraction also beats the 70th percentile of the last 32 kills' fractions. Self-normalising: whatever the current damage profile, roughly the top ~30% of kills launch, which is what "reward" means. Elites and bosses bypass the percentile (they are rare, cannot saturate, and are exactly the kills that should always pay off). A warm-up rule (window < 8 samples → floor only) keeps behaviour identical early and keeps the `19-overkill` money shot deterministic. The percentile logic lives in a new pure module (`src/systems/LaunchGate.js`, the `ResolutionMath.js` precedent) so it is unit-testable without THREE or a browser.

**Tech Stack:** Vanilla ES modules; `node tests/run.mjs`; `tools/juiceprobe.mjs` (Playwright, d3d11) as the before/after instrument; `tools/capture.mjs --only 19-overkill` as the money-shot gate; `tests/sp-equivalence.mjs` + `npm run gate:elite` as the simulation-untouched gates.

## Global Constraints

- **The launch stays cosmetic by construction.** It must never write `Enemy.position`/`velocity` or draw from `ctx.rng` (the shared simulation stream) — `tests/corpse-launch.test.mjs` enforces the RNG rule with a throwing stub, and the gate must stay deterministic (no `Math.random`, no `fxRng`): same kill stream in, same launch decisions out.
- **`LAUNCH.minOverkillFrac` stays `0.35` and stays exported from `src/systems/VFX.js:79`** — `tools/juiceprobe.mjs:141-143` imports it from the game and the committed baseline `reviews/round9/juice-probe.json` is denominated in it.
- **Simulation fingerprints must not move:** `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` → `no fields moved`; `npm run gate:elite` → same. Run both at the end of every task that touches `src/`.
- **The named baseline for every before/after claim is `reviews/round9/juice-probe.json` (commit `c6795cb`)** — cite it by path, per the name-the-baseline rule. Do not regenerate or edit it.
- **Bash tool is ASCII-only** on this box — file content with non-ASCII goes through Write/Edit, never a shell heredoc. **Never run bare `npx`.** Probe ports: juiceprobe `--port 5215`, capture `--port 5216`.
- **Commit style:** single evocative sentences (see `git log --oneline`), with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: The pure gate — `src/systems/LaunchGate.js`

**Files:**
- Create: `src/systems/LaunchGate.js`
- Create: `tests/launch-gate.test.mjs`
- Modify: `tests/run.mjs` only if test files are enumerated by hand (check first — if it globs `tests/*.test.mjs`, no change).

**Interfaces:**
- Produces (Task 2 consumes exactly these):

```javascript
export const GATE = { window: 32, warmup: 8, percentile: 0.70 };
/** q-th quantile (0..1) of `values` by linear interpolation; values need not be sorted. */
export function quantile(values, q)
/**
 * Should this kill's overkill fraction launch the corpse?
 * `frac`   — overkill / victim maxHealth, this kill.
 * `recent` — overkill fractions of prior kills, oldest first, NOT including this one.
 * `floor`  — the absolute threshold (LAUNCH.minOverkillFrac).
 * `always` — elite/boss: bypass the percentile, floor still applies.
 * Deterministic, no state, no RNG.
 */
export function shouldLaunch(frac, recent, floor, always = false, gate = GATE)
```

Semantics to implement and test:
1. `frac < floor` → `false`, always (unchanged from today, every path).
2. `always === true` and `frac >= floor` → `true` (elite/boss bypass).
3. `recent.length < gate.warmup` and `frac >= floor` → `true` (warm-up = today's behaviour).
4. Otherwise → `frac >= quantile(recent, gate.percentile)`.
5. `quantile([], q)` returns `0` (so an accidental empty-window call is permissive, not a crash); `quantile` of one element returns that element; interpolation is linear between order statistics (`idx = q * (n - 1)`).

- [ ] **Step 1: Write the failing tests**

Create `tests/launch-gate.test.mjs` in the repo's test idiom (`pass/fail` counters, `ok()` lines, exit through the shared runner):

```javascript
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
```

(Match the exit convention of the neighbouring test files — read one first; if the runner collects `process.exitCode` differently, follow it.)

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.mjs 2>&1 | tail -5`
Expected: the new file fails to import (`LaunchGate.js` does not exist).

- [ ] **Step 3: Implement `src/systems/LaunchGate.js`**

```javascript
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
 * whatever the current damage profile, roughly the top third of kills throw
 * a body. Elites and bosses bypass the percentile (rare by construction,
 * and exactly the kills that should always pay off). Under `warmup` samples
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/run.mjs`
Expected: all files pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/systems/LaunchGate.js tests/launch-gate.test.mjs
git commit -m "The launch learns what the rest of the run has been like"
```

---

### Task 2: Wire the gate into `VFX._onKill`

**Files:**
- Modify: `src/systems/VFX.js:1397-1411` (`_onKill`'s launch block) and the constructor/reset site that owns per-run VFX state (find where `_dissolving`/launch arrays are initialised and add the ring buffer beside them).
- Modify: `tests/corpse-launch.test.mjs` (extend; existing assertions must keep passing).

**Interfaces:**
- Consumes: `GATE`, `shouldLaunch` from Task 1 (exact signatures above); existing `LAUNCH`, `corpseLaunch`, `p.isElite` / `p.isBoss` on the kill payload (both already read in `_onKill` at `src/systems/VFX.js:1413`).
- Produces: `VFX` gains `_overkillRecent` (array of the last `GATE.window` overkill fractions, oldest first). The launch call itself and the power formula `k = clamp((over - LAUNCH.minOverkillFrac) / (1 - LAUNCH.minOverkillFrac), 0, 1)` are unchanged.

- [ ] **Step 1: Extend the corpse-launch test (failing first)**

Read `tests/corpse-launch.test.mjs` in full. It drives `VFX` instances through kill events (or calls `corpseLaunch` directly — follow whichever it does). Add a block that:

1. Builds a `VFX` the same way the existing tests do, feeds it `GATE.warmup` kill payloads with `overkill` at 20× `maxHealth` each (via whatever entry point the file already uses for `_onKill` — the event or the method), then one more at 0.4× — and asserts the 0.4× kill does **not** start a launch while a 25× kill after the same history **does**. **Use a fresh victim object for every kill payload** — `corpseLaunch` dedupes per object (`src/systems/VFX.js:816`), so a reused fixture makes later launches fail for the wrong reason. Count launches the way the file already observes them (number of active launch entries, or a wrapped `corpseLaunch`).
2. Asserts a payload with `isElite: true` and the same 0.4× fraction after the same hot history **does** launch.
3. Asserts the first kill of a fresh `VFX` at 0.5× launches (warm-up preserved).

If `_onKill` is not reachable without a full ctx, wrap `vfx.corpseLaunch` with a counting stub — the file already builds minimal ctx objects with throwing `rng` stubs; reuse that fixture.

- [ ] **Step 2: Run to verify the new block fails**

Run: `node tests/run.mjs 2>&1 | grep -c FAIL`
Expected: the saturation assertion fails (everything still launches).

- [ ] **Step 3: Implement**

In `src/systems/VFX.js`:

1. Import: `import { GATE, shouldLaunch } from './LaunchGate.js';`
2. In the constructor where launch/dissolve state is initialised (`src/systems/VFX.js:198-199`), add `this._overkillRecent = [];`. The constructor IS the per-run reset — every restart in this game is a `location.reload()` (pre-flight verified) — so no other reset path needs the clear.
3. Replace the launch condition in `_onKill`:

```javascript
    const pool = Math.max(1, p.victim?.maxHealth ?? 0);
    const over = (p.overkill ?? 0) / pool;
    // The floor alone saturated the late run - 90.1% of kills launched at
    // max power (reviews/round9/juice-probe.json). The gate also asks the
    // kill to stand out against the run's own recent history; elites and
    // bosses, rare by construction, keep the floor-only rule.
    const launch = obj && shouldLaunch(
      over, this._overkillRecent, LAUNCH.minOverkillFrac, !!(p.isElite || p.isBoss));
    this._overkillRecent.push(over);
    if (this._overkillRecent.length > GATE.window) this._overkillRecent.shift();
    if (launch) {
      const src = p.source?.position;
      let dx = 0, dz = 1;
      if (src) {
        dx = _h1.x - src.x; dz = _h1.z - src.z;
        if (dx * dx + dz * dz < 1e-6) { dx = 0; dz = 1; }
      }
      this.corpseLaunch(obj, dx, dz,
        clamp((over - LAUNCH.minOverkillFrac) / (1 - LAUNCH.minOverkillFrac), 0, 1));
    }
```

The current kill's fraction is pushed **after** the decision — the window is prior kills only, so a lone standout in a cold field still launches.

- [ ] **Step 4: Run the unit battery**

Run: `node tests/run.mjs`
Expected: all pass — the new block, the pre-existing corpse-launch assertions (cosmetic-by-construction, RNG-throwing stubs), and everything else.

- [ ] **Step 5: Run the simulation gates**

Start nothing by hand — both commands manage their own server:
- `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` → expected `no fields moved`, exit 0.
- `npm run gate:elite` → expected `no fields moved`, exit 0.
Paste both verdict lines into the task report.

- [ ] **Step 6: Commit**

```bash
git add src/systems/VFX.js tests/corpse-launch.test.mjs
git commit -m "A body flies when the kill stood out, not whenever the run got strong"
```

---

### Task 3: Measure it — juiceprobe after-arms, money shot, and the record

**Files:**
- Modify: `tools/juiceprobe.mjs` (add a real-launch counter beside the threshold-cleared stat)
- Create: `reviews/launch-retune/juice-probe-after.json` (probe output)
- Create: `reviews/launch-retune/README.md`
- Modify: `reviews/round9/README.md` (one closing pointer under §(a): the finding this slice answers, and where the answer lives)

**Interfaces:**
- Consumes: the wired gate from Task 2; the committed baseline `reviews/round9/juice-probe.json` (commit `c6795cb`) — read-only.
- Produces: the after-record and its README; the acceptance numbers below.

**Acceptance gates (the slice's whole point — these numbers, not vibes):**
- `late` arm: **launched fraction in [0.10, 0.70]** (was 90.1% threshold-cleared ≙ launched under the old rule).
- `mid` arm: **launched fraction in [0.10, 0.70]** (was 31.4%).
- `19-overkill` money shot: `--only` run exits 0, `subjectsOk: true`, `liftMetres > 0.25`.
- Both arms report `renderer: d3d11` — a SwiftShader record is not comparable to the baseline (its own README says so).

- [ ] **Step 1: Add the real-launch counter to the probe**

`tools/juiceprobe.mjs` already wraps `deathDissolve` (`:191-202`) to count real calls. Add the identical wrap for the launch, in the same `page.evaluate` block:

```javascript
    // How many kills actually threw a body. Under the percentile gate the
    // threshold-cleared count (kept below, denominated in the same
    // minOverkillFrac as the c6795cb baseline) is the *eligible* population;
    // this is the *launched* one. Both go in the record.
    J.launchCalls = 0;
    if (vfx?.corpseLaunch) {
      const innerL = vfx.corpseLaunch.bind(vfx);
      vfx.corpseLaunch = (...a) => { J.launchCalls++; return innerL(...a); };
    }
```

**Naming trap (pre-flight I1):** the probe's existing threshold-cleared stat is already named `launchedCount` / `launchedFraction` (`tools/juiceprobe.mjs:377-378`) — under the old rule cleared WAS launched, so the name was honest; under the gate it is only the *eligible* population and keeping the name would poison every reader. In the arm summary, rename the eligible stat to `clearedCount` / `clearedFraction`, report the real wrap-counted numbers as `launchedCount` / `launchedFraction`, and put one sentence in the record and the README stating the mapping to the c6795cb baseline's field names (baseline `launchedFraction` ≙ this record's `clearedFraction`). Reset `J.launchCalls = 0` at the start of each arm (find where `J.kills` is reset per arm and reset beside it).

- [ ] **Step 2: Run the two arms**

Run: `node tools/juiceprobe.mjs --kills 200 --port 5215 --out reviews/launch-retune/juice-probe-after.json`
(Use the exact arm flags the baseline run used — they are printed in `reviews/round9/README.md` §"juice-probe.json"; `--costBefore/--costAfter` are NOT needed, this slice ships no shader or geometry.)
Expected: record written; both arms `renderer: d3d11`; per-arm `launchedFrac` inside the gates above. If a gate misses, this is a tuning finding, not a fudge-the-record moment: adjust `GATE.percentile` (one knob, in Task 1's file, with its unit tests updated to the new constant), re-run `node tests/run.mjs`, re-run the probe, and disclose every attempt in the task report.

- [ ] **Step 3: The money shot still fires**

Run: `node tools/capture.mjs --only 19-overkill --out <scratchpad>/shots-overkill --port 5216 --seed 1337`
Expected: exit 0, `subjectsOk: true`, `liftMetres > 0.25` in the manifest (baseline was 0.924 m at `54d7470`). Copy the manifest's subject table into the task report, then delete the output directory.

- [ ] **Step 4: Re-run every gate that touched src/ this slice**

- `node tests/run.mjs` → all pass.
- `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` → `no fields moved`.
- `npm run gate:elite` → `no fields moved`.

- [ ] **Step 5: Write the record**

`reviews/launch-retune/README.md` must carry, in the round-9 README's idiom:
- The exact commands run, ports, commit hash measured, `renderer` of each record.
- The before/after table: baseline `reviews/round9/juice-probe.json` (c6795cb) cleared-fractions 31.4% / 90.1% vs this tree's launched-fractions, per arm, with the eligible (threshold-cleared) population beside them.
- The `19-overkill` manifest numbers.
- What the gate does NOT change: floor, power curve, elite/boss behaviour, warm-up window — each with the test that proves it (`tests/launch-gate.test.mjs`, `tests/corpse-launch.test.mjs`).
- One honest-limitations paragraph: the probe's two fixtures are pinned-clock scripted arms, not play; the 70th percentile is a chosen constant and the record states the sensitivity (what launched-frac the *other* candidate percentiles measured, if Step 2 iterated).

In `reviews/round9/README.md`, under the §(a) finding paragraph ("This is recorded, not fixed."), append one sentence: the retune landed in slice `2026-08-11-overkill-launch-retune`; the argument and the after-record are in `reviews/launch-retune/README.md`.

- [ ] **Step 6: Commit**

```bash
git add tools/juiceprobe.mjs reviews/launch-retune/ reviews/round9/README.md
git commit -m "The late run earns its launches again, and the record shows the earning"
```
