# #224 — current-HEAD dense-combat capture and effect-budget baseline

Three full `npm run shots` runs (never `--only`), same tree, same seed (1337),
serial and headed (d3d11). Manifests: `reviews/224-baseline/run-1/manifest.json`,
`run-2/manifest.json`, `run-3/manifest.json` (PNGs alongside them are
gitignored per repo convention; the manifests are the artefact).

All three: `ready: true`, `infra: {bootFailed:false, shotErrors:[], consoleErrors:[]}`,
`clockPinned: true`, `frameDt` exactly `1/60`, `frameTimeouts: 0`. No infrastructure
failures across any run — the only non-green field is `subjectsOk: false`
(the `21-dense-combat` `horde` pixel-legibility check; see "Not a framing
shot" below), which is advisory per house rules and does not bear on this
baseline.

Commit captured at: see `commit` and `dirty` fields in each manifest — one
commit per run (`tools/capture.mjs` now records `dirty` alongside `commit`,
so a run's manifest is only trusted as reproducible from its stated sha when
`dirty: false`; each manifest here was committed before the next run started
specifically so every one of the three reads `dirty: false` against its own
HEAD). This re-anchors the original `#224` baseline: those three manifests
all stated `commit: d12a49a` with no dirty check, but that tree predates the
`21-dense-combat` scenario — the original runs were captured out of a lane
worktree carrying uncommitted work, so the stated anchor was never actually
reproducible (found in integration review M2). Settings: `difficulty: "fracture"`,
`survivor: "ranger"`, `seed: 1337`, `software: false`. Renderer (identical
across all three runs): ANGLE (NVIDIA, NVIDIA GeForce RTX 2070, Direct3D11
vs_5_0 ps_5_0, D3D11), WebGL2.

## Scenario: `21-dense-combat`

Registered in `tools/capture.mjs`, implemented in `src/core/Harness.js`
(`__HARNESS__.denseCombat`). Denser than `04-combat` on both axes this
baseline measures:

|                     | 04-combat | 21-dense-combat |
|---------------------|-----------|-----------------|
| enemies spawned     | 24        | 48              |
| elite frequency     | 1 in 6    | 1 in 3          |
| held-trigger burst  | 0.45 s    | 1.2 s           |

Unlike `04-combat` it is not a framing shot — no declutter pass, no
per-object pixel tuning. Its job is a reproducible *load*: same seed, same
crowd, same burst, every run. The `horde` subject check is a floor only (some
of the crowd must be alive and rendered, so an empty-arena boot regression
would still show as a subject failure); it fails on all three runs because
the sustained burst kills all but one of the 48 before the shutter — expected
under `invulnerable()` (player only) with a doubled crowd and a much longer
hold, and not a defect in the scenario. `enemyCount` at the shutter reads 1
on all three runs, which is itself perfectly reproducible.

## Budget metrics (new, #224)

Read off real game state via `Combat.procBudgetSnapshot()`,
`Combat.statusOverlapStats()` and `Audio.voiceBudgetSnapshot()` — all
read-only additions (see `src/systems/Combat.js`, `src/systems/Audio.js`;
unit-tested in `tests/combat-budget-metrics.test.mjs` and
`tests/audio-voice-budget-metrics.test.mjs`). Sampled once, at the shutter,
after the burst and settle.

| metric                              | run-1 | run-2 | run-3 | median | spread | verdict |
|--------------------------------------|-------|-------|-------|--------|--------|---------|
| proc budget: peak used / 512         | 19    | 19    | 19    | 19     | 0      | **stable** |
| proc budget: rejections              | 0     | 0     | 0     | 0      | 0      | **stable** |
| voice budget: peak world / 44 (cap)  | 44    | 44    | 44    | 44     | 0      | **stable** — saturated every run |
| voice budget: world refusals         | 2637  | 2600  | 2612  | 2612   | 37 (~1.4%) | **stable** (sub-2% run-to-run noise, consistent with `harness-not-bit-exact` memory) |
| voice budget: takes                  | 3326  | 3313  | 3329  | 3326   | 16 (~0.5%) | **stable** |
| status overlap: entities w/ statuses | 0     | 0     | 0     | 0      | 0      | **stable, but a floor, not a ceiling** — see below |
| status overlap: total stacks         | 0     | 0     | 0     | 0      | 0      | same caveat |
| status overlap: max stacks on one    | 0     | 0     | 0     | 0      | 0      | same caveat |

### Re-anchor vs the original (superseded) numbers

The original `d12a49a`-stated baseline read: proc peak 19/512 (0 rejections),
voice peak 44/44, refusals 2629 median (spread 66, ~2.5%), takes 3314 median
(spread 30, ~0.9%). Deltas against this re-anchored run: proc and voice-peak
figures are unchanged; refusals median moved -17 (~0.6%) with a narrower
spread; takes median moved +12 (~0.4%). All within the run-to-run noise this
harness already carries (see `harness-not-bit-exact` memory) — no shift is
large enough to flag, which is itself evidence the original measurements were
sound even though their stated provenance was not.

### Reading the numbers

- **Proc-dispatch circuit breaker has enormous headroom.** 19/512 peak used,
  zero rejections, identical on all three runs — the per-step breaker
  (`PROC_BUDGET = 512` in `src/systems/Combat.js`) is nowhere near the
  pressure a 48-enemy elite-heavy fight can put on it. #225/#226 should not
  expect proc-budget exhaustion to be a live constraint at this density; if a
  future scenario needs to actually test the breaker, it will need far more
  simultaneous on-hit/on-kill chains than a base-weapon burst produces.
- **The audio world-voice bucket is the real constraint.** Saturated at the
  44-voice cap on every run, with ~2600 refusals out of ~3300 takes (roughly
  80% of world-sound requests refused during the burst). This is the budget
  #225/#226 should look at first — it is already at its ceiling under
  current-HEAD density, well before the proc-dispatch breaker is stressed.
- **Status overlap reads zero because this scenario never applies a status.**
  The player's base weapon in this harness path deals kinetic damage without
  a DoT/slow/shock rider, so `Combat.statuses` never gains an entry — this is
  a **measurement gap in the scenario, not evidence that dense fights don't
  stack statuses.** Flagged explicitly rather than reported as "0 status
  overlap in dense combat," which would be a false negative. A follow-up
  wanting a real status-overlap reading needs a scenario that grants an
  elemental weapon or an on-hit status item before the burst — out of scope
  here (#224 measures with what exists today; #225/#226 act on findings).

## Provenance fix (this re-anchor)

`tools/capture.mjs` now also stamps `dirty` onto every manifest (`git status
--porcelain` non-empty at capture start) alongside `commit`, so a manifest can
never again claim a clean anchor it didn't have. Each of the three runs above
was committed before the next run started so all three independently satisfy
`commit === $(git rev-parse HEAD)` with `dirty: false`.

This re-anchor also exercises the merged 15-logbook showcase path
(`await openLogbook`) for the first time under this scenario set — the
`15-logbook` shot ran clean on all three runs (`frameErrors: 0`,
`newErrors: []`), no infrastructure failure.

## Gate record

`node tools/gates.mjs status --record capture --verdict pass` — recorded
per house rules (renders ADVISORY, not RED, on the manifest's own
`subjectsOk: false`, per the 2026-08-20 decision that capture never blocks).

## 2026-08-26 — eviction changes what "refusals" means (#226)

From commit f4b60dc (`slice/226-sfx-dense-probe`, priority-reserve and
world-bucket eviction) onward, the refusal rate on this scenario is no longer
comparable to the run-1..3 numbers above **by mechanism**, not by drift: a
critical priority cue (`playerHurt`, `playerDowned`, `playerRevived`, the
sustained downed-marker beacon) that finds the reserve full now evicts the
oldest feedback-tier voice instead of being refused, and a windup whose own
sub-budget has room now evicts the oldest ordinary world voice instead of
going silent. Both count as a GRANT (`_takes`, plus their own
`worldEvictions`/`feedbackEvictions` in `voiceBudgetSnapshot()`), never a
refusal.

Reviewer-reproduced delta on the same saturated windup sequence: pre-#226,
30 refused / 0 granted-by-eviction; post-#226, 16 refused / 14
granted-by-eviction. Refusals fall not because contention eased but because
some of what used to be silently refused is now audibly evicted-and-granted.

The run-1..3 refusal figures above (2600-2637, ~2600 median) are therefore
**pre-eviction-era** — comparable only to each other, never to a post-#226
capture. No capture was re-run to produce this note (house rule: captures are
not re-run on request). Any future baseline claiming to supersede run-1..3
must be struck fresh against the post-eviction mechanism and must not be
diffed against these numbers.
