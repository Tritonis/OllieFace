# Axis-4 restage attempt, #79 — full-run manifests, before and after

Autonomous run 2026-08-17/18. **The restaging in this experiment was refuted by its own acceptance
run and reverted**; no staging change reached master. These two manifests are kept because they are
the only full-run pair either side of the attempt, and because `79-full-before/` is a full capture of
**unmodified master `785f156`** — which is red.

PNGs were deleted; manifests only.

| | `79-full-before/` | `79-full-after/` |
|---|---|---|
| tree | unmodified master `785f156` | the reverted staging experiment |
| `subjectFailures` | `['11-bestiary: the whole spawn roster']` | `04-combat` + `11-bestiary` |
| `04-combat` above 100 px | 10/24, median 74.7 px | 9/24, median 75.1 px |
| `11-bestiary` foot-Y span | 416.7 px | 420.3 px |
| skipped | `19-overkill`, `20-blight-edge` (by design) | same |
| `clockPinned` / `frameTimeouts` | true / 0 | true / 0 |

## What was tried, and why it was reverted

In `src/core/Harness.js`: `spawnRing` (:761) gained a default-preserving `depth` option; `combat()`
(:3110) spawned on an 11-24 m band instead of 13-46; `declutter` at :3120 and :3175 went 12→9 with
`maxDist` 30→24.

Result: subjects above 100 px went **10/24 → 9/24** and median height 74.7 → 75.1 px — inside noise —
while `04-combat`'s `horde` gate went green → **red** (object 6 `sepP50` 0.21 against `marginSep`
0.27, absences 2→3). A wash on the metric it targeted and a regression on a gate. Reverted.

## Three findings that outlived the experiment

1. **The `--only` and full regimes frame `04-combat` materially differently** — 7/24 vs 10/24 above
   100 px *on the same commit*. Partial runs cannot steer this shot, so every candidate staging costs
   a full run. Any future attempt needs a run budget stated in full runs.
2. **`04-combat`'s staging is chaotic in its parameters.** An 11 m versus 10 m spawn radius moved the
   median from 90 px to 57 px. Tuning it is a search, not an edit.
3. **Two `--only` runs of an identical config reproduced byte-identically** (median 56.7, px 6490), so
   the shot itself is deterministic. The before/after difference above is real, not drift.

## Why the acceptance criterion could not be met as written

#79 asks for axis 4 re-scored "with the same review method as round 6". That method is not
reproducible from the repository: round 6's translation-searched IoU scripts (`s09.py`, `s11.py`)
lived in a session scratchpad and were never committed, and `reviews/round6/FINAL/*.png` have been
deleted. Only the round-6 manifest survives. The IoU spread the issue cites (0.486-0.810 against a
0.799 threshold) therefore cannot be recomputed from anything on disk.

See #79 for the parked decision.
