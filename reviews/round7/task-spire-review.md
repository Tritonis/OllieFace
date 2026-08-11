# REVIEW — 13-biomes-2 far-spire fix (`fineFade` 400→110, canyon `terrain.roughness` 0.70→0.82)

Worktree: `.claude/worktrees/agent-a9e014c6be17bd207`, commit `2f4c700`, based on `39bf2bc`.
Implementer report reviewed: `reviews/round7/FIX-spire.md` (in worktree).

## Verdicts

- **SPEC: CONFIRMED** — the diagnosis's claimed PEAK collapse at the current ROI, the
  frame-wide de-aliasing, the b1 far-mountain non-reopen, and the "no shot regressed
  beyond floor" claim all reproduce independently, including on a screenshot capture
  I took myself in a separate browser session.
- **QUALITY: READY** — two-constant diff, no RNG touch, tests and build both green,
  visual inspection shows no flattening. One report-accuracy defect found (see Finding 1)
  that does not change the merge verdict but should be corrected before the report is
  trusted as a record.

**My independently-measured PEAK at the current ROI (x240-560 y120-420, `13-biomes-2`,
own capture, port 5318): 0.024%** (23/96000 hits) — against the claimed 0.026% and the
0.202%/0.209% pre-fix pair. Delta from the implementer's own post-fix number: 0.002 pp,
well inside the declared 0.0026 pp same-tree floor.

**Worst collateral regression found: none beyond the declared floor.** The only shots
that moved upward in my own independent frame-wide comparison against the noise floor
are the two the brief pre-flags as unreliable/known-red (`06-loaded-hud`, `19-overkill`);
every shot with far-field terrain in frame improved in my capture too. Detail in Finding 2.

**Severity counts: 0 critical, 1 major, 1 minor.**

**Tests: 47/47 test files passed. Build: green.**

---

## 1. Diff scope (independently confirmed)

`git show 2f4c700 --stat` in the worktree:

```
reviews/round7/FIX-spire.md                           |  217 +++++
reviews/round7/captures/fix-spire-ctrlA/manifest.json  | 4371 ++++...
reviews/round7/captures/fix-spire-ctrlB/manifest.json  | 4371 ++++...
reviews/round7/captures/fix-spire/manifest.json        | 4371 ++++...
reviews/round7/tools/fixcompare.mjs                    |   42 ++
src/world/Materials.js                                 |   38 +-
```

`src/world/Materials.js`'s 38 changed lines are almost entirely new comment prose;
the only two lines that change an emitted value are:

- `Materials.js:327` (in the diff, was `:310` at old HEAD) — `DETAIL.terrain.fineFade`
  400 → 110.
- `Materials.js:1323` (was `:1296`) — canyon `matTune.terrain.roughness` 0.70 → 0.82.

Confirmed `0.82` is exactly `MAT_TUNE_BASE.terrain.roughness` (`Materials.js:1160`), so
the claim that this "restores the base value for the terrain rung only" is accurate —
the canyon's `rock` (0.58), `cliff`, and `wetStone` matTune entries are untouched.

`grep -n "Math\.random\|rng\.\|ctx\.rng\|fxRng\|Random(" src/world/Materials.js` →
no matches. Confirmed no RNG reference exists in this file, so the "no shared-stream
ordering moved" claim has no surface to violate.

## 2. Instrument calibration (independently run)

`node reviews/round7/tools/lattice.mjs --selftest` in the worktree:

```
flat 128                 PEAK 0.000%   expect 0.000%
ramp                     PEAK 0.000%   expect 0.000%
1-in-100 specks +60      PEAK 1.020%   expect 1.020%
2x2 blocks every 12      PEAK 0.000%   expect 0.000%
3x3 blocks every 12      PEAK 0.000%   expect 0.000%
white noise              peak lag x=4 (0.020)  y=11 (0.020)
grid period 10           peak lag x=10 (0.999)  y=10 (0.999)
```

All 5 PEAK cases reproduce to the digit; PEAK reads 0.000% on resolved 2x2/3x3 relief
exactly as the instrument's own convention requires. Calibration holds.

## 3. PEAK at the current ROI — reproduced on the implementer's committed captures AND on my own independent capture

First, reran `lattice.mjs` directly against the three capture directories already
committed in the branch (`fix-spire-ctrlA`, `fix-spire-ctrlB`, `fix-spire`), ROI
x240-560 y120-420 on `13-biomes-2`:

| capture | my re-measurement | report's claim |
|---|---:|---:|
| ctrlA (pre-fix) | 0.202% (194) | 0.202% (194) |
| ctrlB (pre-fix) | 0.209% (201) | 0.209% (201) |
| fix-spire (post-fix) | 0.026% (25) | 0.026% (25) |

Exact match to the digit on the implementer's own artifacts.

Then I took my **own capture**, independent browser session, port 5318, seed 1337
(`node tools/capture.mjs --out reviews/round7/captures/review-spire --port 5318 --seed
1337`, run from the worktree, junctioned `node_modules`, junction removed afterward —
see §6). Same ROI on my `13-biomes-2.png`:

```
reviews/round7/captures/review-spire/13-biomes-2.png  ROI 240 120 560 420  n=96000
  PEAK 0.024%  (23)
```

**0.024%, against the report's 0.026% — 0.002 pp apart, inside the declared 0.0026 pp
same-tree floor.** This is the strongest evidence in the review: a completely separate
capture run, not touching any file the implementer produced, lands within noise of the
claimed number.

## 4. b1's far mountain and 02-vista's right cliff — premise checked, not just the after-state

Task brief asked to check the premise of "0 hits before and after," not just trust it.
Reran `lattice.mjs` on the **pre-fix** `ctrlA`/`ctrlB` captures directly:

| ROI | ctrlA (pre) | ctrlB (pre) | report's claim |
|---|---:|---:|---|
| b1 far mountain x300-425 y422-456 | 0.000% (0) | 0.000% (0) | "0 hits before" |
| b1 far right range x1050-1550 y280-560 | 0.024% (33) | 0.022% (31) | 0.024%(33) / 0.022%(31) |

Both match exactly — the premise holds, it was genuinely 0 hits pre-fix, not an
assumed zero. Then on my own independent post-fix capture:

| ROI | my post-fix measurement | report's post-fix claim |
|---|---:|---|
| b1 far mountain | 0.000% (0) | 0.000% (0) — "holds, not a rounded zero" |
| b1 far right range | 0.005% (7) | 0.005% (7) — "improved 4.4x" |
| 02-vista right cliff x900-1500 y520-880 | 0.001% (3) | 0.001% (3) — "unchanged, identical hit count" |

All three reproduce exactly on my own capture. The far-mountain claim is well-founded:
zero hits both sides means there was no headroom for an invisible regression, and my
independent run confirms it is still genuinely zero, not a coincidentally-rounded value.

Also independently reran the stale round-6 ROI (x1000-1180 y30-260) against `ctrlA`:
0.010% (4 hits) — matches the report's claim exactly, confirming that box now sits on
an aqueduct pier rather than the fin.

## 5. Collateral-gains table and worst-regression claim

Recomputed the frame-wide PEAK table from the implementer's own committed manifests
with their own `fixcompare.mjs` (not trusted from the table — regenerated):

```
node reviews/round7/tools/fixcompare.mjs reviews/round7/captures/fix-spire-ctrlA reviews/round7/captures/fix-spire ctrlA fix-spire
```

Output matched the report's §3 table to all four decimal places on every one of the 23
shots, including the "no shot regressed beyond 0.0026 pp" claim: the three shots that
moved upward (`13-biomes-4` +0.0013, `19-overkill` +0.0020, `06-loaded-hud` +0.0006) are
all under the measured 0.0026 pp control floor (`10-inventory`, confirmed independently
as the largest ctrlA/ctrlB delta by rerunning `fixcompare.mjs` on the two pre-fix
captures directly).

Then ran the same comparison against **my own independent capture** (`review-spire`,
different browser session than the implementer's):

```
node reviews/round7/tools/fixcompare.mjs reviews/round7/captures/fix-spire-ctrlA reviews/round7/captures/review-spire ctrlA review-spire
```

Collateral improvements reproduce closely: `13-biomes-2` -73.3% (report: -72.5%),
`12-boss-phases` -41.6% (-42.1%), `11-bestiary` -36.0% (-37.0%), `05-boss` -36.2%
(-36.2%, exact), `13-biomes-1` -14.3% (-15.7%). `13-biomes-4` (the one terrain shot
that doesn't improve) is +5.1% in my run vs. the report's +6.9% — same direction, same
order of magnitude, both comfortably under the 0.0026 pp floor in absolute terms
(mine: +0.0010 pp vs. the report's +0.0013 pp).

`06-loaded-hud` and `19-overkill` diverge more in my run than in the report's own
control pair (`06-loaded-hud` +0.0026 pp vs. the report's +0.0006 pp; `19-overkill`
swings the *other direction*, -34.0% vs. the report's +27.4%). Both shots are
pre-flagged in the brief as known-red/ignore (`19-overkill` an only-path shot by
construction, `06-loaded-hud` pending a fix on another branch) — my numbers, if
anything, reinforce that these two shots are too noisy cross-session to judge this fix
by, which is consistent with the brief's instruction to disregard them rather than a
sign this fix destabilizes them. No shot outside those two moved against the fix in
either capture.

**Conclusion: no shot regressed beyond the noise floor in either my independent
capture or the implementer's own manifests.** This is the load-bearing claim the task
asked me to prioritize, and it holds under a genuinely independent re-run, not just a
recomputation of the implementer's numbers.

## 6. Tests, build, and environment hygiene

- `node tests/run.mjs` → **47/47 test files passed, 0 failed.**
- Build: `node_modules` was absent in the worktree. Created a junction to the main
  repo's `node_modules` — the first attempt (via `cmd //c mklink` invoked through the
  Bash tool) produced a corrupted target path (`/c/C:/Users/...`) that silently
  resolved to nothing; the build failed with `Cannot find module '...vite/bin/vite.js'`
  until I removed and recreated the junction correctly. Once fixed:
  `node node_modules/vite/bin/vite.js build` → **green, built in 1.20s.** The
  junction was removed at the end of the review (`rm node_modules`, confirmed gone).

## 7. Visual judgment

Compared `fix-spire-ctrlA/13-biomes-2.png` (pre) against `fix-spire/13-biomes-2.png`
(post) directly. Pre-fix: the canyon's far wall fins carry a dense field of bright
white specular flecks — the "crushed foil" sparkle the round-4 critic described.
Post-fix: those same fins read as smooth damp stone with intact silhouette, shading
gradient, and forms — no visible loss of large-scale shape, no flattening to a matte
plate.

Compared `02-vista.png` pre vs. post (mid-ground terrain: the orange ground plane and
the dark cliff face the player stands beside) — the two are visually indistinguishable
at this distance. The near-field ground the player is standing on shows no mushiness
or loss of detail, consistent with `fineFade` 110 keeping full amplitude out to
~49.5 m and the near band being where the player always is. No regression by eye.

## Findings

### Finding 1 (major) — report's "only manifest error" claim is false on its own artifacts

`reviews/round7/FIX-spire.md:38-39`: *"All three: seed 1337, `clockPinned: true`, 23
shots, and the only manifest error in any of them is `06-loaded-hud` (known-red,
below)."*

Checking `manifest.json.errors` in all three committed capture directories
(`fix-spire-ctrlA`, `fix-spire-ctrlB`, `fix-spire`) directly:

```js
errors: [
  "[harness] 06-loaded-hud: subject missing or illegible — monsters under load ...",
  "[harness] 10-inventory: subject missing or illegible — monsters standing in it ...",
  "[harness] 19-overkill: subject missing or illegible — the launched corpse ...",
]
```

**All three captures carry three manifest errors, not one** — `06-loaded-hud`,
`10-inventory`, and `19-overkill`, and the text is byte-for-byte identical across all
three captures (down to the per-object pixel counts), which is itself useful evidence:
it confirms these are pre-existing, capture-harness-level subject-legibility failures
unrelated to this change (present identically before either edit), not something this
fix caused. `19-overkill` is later correctly named as known-red in §3 of the same
report ("red on full runs by construction"), so the document is internally
inconsistent — §1 undercounts to one error while §3 correctly treats a second one as
known-red, and `10-inventory`'s identical failure is never mentioned anywhere in the
report.

This does not change the merge verdict: the failure is pre-existing and identical
pre/post-fix, so it carries no signal about this change. But it is a directly
falsifiable claim in the report's own noise-floor section that is simply wrong when
checked against the artifacts the report itself cites, and a reader relying on "the
only manifest error is X" would miss that two other scenarios are also failing
subject-legibility checks on every capture in this branch (a preexisting condition
worth someone's attention independent of this fix).

**Recommendation:** correct §1's sentence to name all three, or drop the specific
count and just say "no new manifest errors relative to the pre-fix pair."

### Finding 2 (minor) — cross-session capture variance on two known-noisy shots is larger than the report's within-session control floor implies

Not a defect in the fix, but worth recording for future reviewers reusing this
methodology: the report's 0.0026 pp control floor was measured from two captures in
the *same* implementer session (`ctrlA` vs `ctrlB`). When I compared `ctrlA` against a
capture taken in a **separate session** (mine, `review-spire`), `06-loaded-hud` and
`19-overkill` — both already flagged as unreliable/known-red — moved by more than that
floor (+0.0026 pp and a full sign-reversal from the report's own post-fix number,
respectively). Every other shot, including the target (`13-biomes-2`) and all the
collateral-improvement shots, stayed close to the report's numbers even across
sessions. This suggests the 0.0026 pp floor is a same-session lower bound, not a
cross-session one, and that `06-loaded-hud`/`19-overkill` in particular should not be
used as evidence either way until their own known issues are fixed — which matches
the task brief's instruction to ignore both, but the report doesn't call out that
these two are also the ones most likely to mislead a reviewer who reruns the capture
independently.

## Commands run

```
git show 2f4c700 --stat / (full diff)
grep -n "Math\.random\|rng\.\|ctx\.rng\|fxRng\|Random(" src/world/Materials.js
node reviews/round7/tools/lattice.mjs --selftest
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlA/13-biomes-2.png 240 120 560 420
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlB/13-biomes-2.png 240 120 560 420
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire/13-biomes-2.png 240 120 560 420
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlA/13-biomes-1.png 300 422 425 456
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlB/13-biomes-1.png 300 422 425 456
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlA/13-biomes-1.png 1050 280 1550 560
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlB/13-biomes-1.png 1050 280 1550 560
node reviews/round7/tools/lattice.mjs reviews/round7/captures/fix-spire-ctrlA/13-biomes-2.png 1000 30 1180 260   # stale round-6 ROI
node reviews/round7/tools/fixcompare.mjs reviews/round7/captures/fix-spire-ctrlA reviews/round7/captures/fix-spire ctrlA fix-spire
node reviews/round7/tools/fixcompare.mjs reviews/round7/captures/fix-spire-ctrlA reviews/round7/captures/fix-spire-ctrlB ctrlA ctrlB
node tests/run.mjs
node node_modules/vite/bin/vite.js build
node tools/capture.mjs --out reviews/round7/captures/review-spire --port 5318 --seed 1337   # my own independent capture
node reviews/round7/tools/lattice.mjs reviews/round7/captures/review-spire/13-biomes-2.png 240 120 560 420
node reviews/round7/tools/lattice.mjs reviews/round7/captures/review-spire/13-biomes-1.png 300 422 425 456
node reviews/round7/tools/lattice.mjs reviews/round7/captures/review-spire/13-biomes-1.png 1050 280 1550 560
node reviews/round7/tools/lattice.mjs reviews/round7/captures/review-spire/02-vista.png 900 520 1500 880
node reviews/round7/tools/fixcompare.mjs reviews/round7/captures/fix-spire-ctrlA reviews/round7/captures/review-spire ctrlA review-spire
```

My independent capture is preserved at
`reviews/round7/captures/review-spire/` in the worktree (23 shots + manifest.json,
port 5318, seed 1337) for any future reviewer who wants a second cross-session data
point without rerunning the harness.
