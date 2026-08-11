# Review: 10-inventory subject regression fix

Worktree: `.claude/worktrees/agent-a4674aec69529fbe2`, branch
`worktree-agent-a4674aec69529fbe2`, commit `077a7ae`, rebased onto master
`82508a7`. Implementer report: `reviews/round7/FIX-inventory.md`.

**SPEC: CONFIRMED** — the diagnosis (stale gate, not a game bug) holds up
under independent re-derivation, and the fix is honest (sabotage test
reproduces the original failure).

**QUALITY: NOT READY** — one shipped dead-code block (unreachable duplicate
of the real fix, left in behind `if (false)`) plus a redundant duplicate
comment essay above it. Functionally inert but must be cleaned up before
merge; see Finding 1.

---

## 1. The case call (stale gate vs. real bug) — CONFIRMED, evidence checked deliberately

Re-read `4734ffd` (`The dissolve stops burning the debris and starts burning
the body`) directly: before the fix, `flashT`/`setFlash(false)` was
re-dressing the four rig mesh slots with `rig.mats` right after `makeDissolvable`
had swapped them to dissolve variants over the shared FLASH material, so the
dissolve ran on crumble debris while the silhouette itself stayed opaque for
its full 1.5s life. That is a genuine rendering bug, and the fix (put the
flash away in `onDeath` before anyone can see the corpse) is the correct
resolution — corroborated independently:

```
node --test tests/dissolve-recycle.test.mjs   ->  29 passed, 0 failed
```
(run myself; results include "the finished dissolve did NOT hide a live,
damageable monster", "nothing re-flashes a corpse", "the burn is well past
half (0.588)" — the mechanism does what the commit claims and does not
regress anything else.)

Given a correct dissolve, a monster that died 0.6-0.8s before the nova
*should* photograph as mostly burned away — that is what "time passing"
looks like once corpses actually decay. The defect was never in the dissolve;
it was that `10-inventory`'s `hold()` was never a pin. `hold` runs once per
frame at the top of the frame and skips `!e.alive`; a survivor holding one of
every item in the game kills the pack from on-kill procs inside a single
frame, so the pack was dead 35-47 frames before the nova the shot claims to
be photographing, and only the debris-only dissolve bug hid that fact by
keeping the (dead) silhouette opaque. This is a correct call: a 97-item
survivor's procs killing a monster pack before the nova even fires is
expected late-run power, not a bug, and the shot is *documented* as wanting
"monsters standing in [the nova]" — i.e. alive when the nova lands, which the
inventory's own kills were preventing before the harness could even get to
firing it. I found no evidence the dissolve fix broke anything
gameplay-visible beyond this harness scenario's own broken pin.

Independently reproduced the `82508a7`-base death-age numbers from the DIAG
check (own capture, `reviews/round7/captures/review-inventory/manifest.json`,
`10-inventory` -> `DIAG victims (age at shutter)`): `deathT` 0.117/0.25,
`k` 0.137/0.294 across the 8 victims — matches the report's claimed bounded
burn once the real ceiling-raise (not the dead duplicate, see Finding 1) is
in effect.

## 2. Bisect discriminates exactly where claimed — CONFIRMED

Re-extracted `monsters standing in it` directly from the four on-disk bisect
manifests (not the report's table — computed independently):

| base | file | ok | px | perPx |
|---|---|---|---|---|
| `825c4ce` | `bisect-825c4ce/manifest.json` | true | 1077 | `[33,141,12,101,130,205,68,387]` |
| `dfc6d11` | `bisect-dfc6d11/manifest.json` | true | 1076 | `[33,141,12,101,130,205,67,387]` |
| `4734ffd` | `bisect-4734ffd/manifest.json` | **false** | **90** | `[6,25,0,0,0,19,6,34]` |
| `ba17c90` | `head-full/manifest.json` | false | 90 | `[6,25,0,0,0,19,6,34]` |

Matches the report byte-for-byte. The collapse (1076 -> 90) lands exactly at
`4734ffd`; `dfc6d11` (the rig-epoch commit) is clean at 1076, exonerating it.
The `diag-master-nopin/manifest.json` DIAG detail shows all 8 victims
`parented: true`, `vis: true`, `inList: true` at the shutter with no epoch
mismatch against the tracking the rig-epoch commit introduced — consistent
with "nothing was recycled/dropped, the corpses were simply burned away."

## 3. Fix is honest — sabotage-checked myself, CONFIRMED

Commented out the load-bearing line (`src/core/Harness.js:4114`,
`for (const e of victims) e.maxHealth = 1e6;`) leaving everything else
(seating ring, refill-before-shutter, DIAG check) untouched, ran a full
capture (no seed/port args — defaults), and the gate went red exactly as the
diagnosis predicts:

```
[harness] 10-inventory: subject missing or illegible — monsters standing in it
(pixels: {"why":"absent","px":0,"need":200,"objs":"0/8", ... "perPx":[0,0,0,0,0,0,0,0], ...})
```

`px: 0`, identical shape to `master-before/manifest.json` (also 0 px, all-zero
`perPx`) — this is the death-age mechanism, not corpse-position luck (a
seating/geometry bug would move pixels around or drop some objects, not zero
every single one identically to the pre-fix baseline). Restored the file from
backup immediately after (`git status --short` clean, confirmed).

Grepped the diff for numeric gate comparisons — none moved:
```
git diff master -- src/core/Harness.js | grep -E "minPixels|minCarriedPx|sepP50 *>=|>=.*0\.|floor"
```
only prose/comments reference numbers (`0.25 floor`, `sepP50 0.33`, etc.); the
actual `mustContain` check object (`minPixels: 200`, `minSep: 0.25`, and the
crowd `need: 2`) is byte-identical to master — confirmed by reading the check
block directly (`Harness.js:4257-4280` region, unchanged lines in the diff).
The seating-ring change (`0.16/0.07` -> `0.26/0.11`) is only the two
`Math.cos(a)*X, Math.sin(a)*Y` seating offsets passed into
`groundAtScreen` — a placement change, not a threshold change.

## 4. Draw-count robustness — CONFIRMED with an independent seed

Ran `10-inventory` alone at a different seed the report never used:

```
node tools/capture.mjs --out reviews/round7/captures/review-seed-4242 --port 5325 --seed 4242 --only 10-inventory
```

Result: `subjectsOk: true`, `monsters standing in it` ok, 8601 px, 6/8
individually visible. DIAG detail shows the dead victims still bounded at
`k: 0.137` (identical to the `82508a7`-base after-fix number, not climbing
with a different draw sequence), 4/8 still alive at shutter. This is direct
evidence the fix decouples the verdict from upstream RNG draw count — a
different seed changes *how many* monsters the procs killed before the
trigger, but not *how burned* the dead ones are, because the ceiling now
bounds "earliest possible death" to the trigger frame regardless of draw
count. This is the durable property the report claims and it held under a
seed the implementer's own evidence set doesn't cover.

## 5. Full capture on the branch — CONFIRMED

```
node tools/capture.mjs --out reviews/round7/captures/review-inventory --port 5324
```

`subjectsOk: true`, `subjectFailures: []`, `errorCount: 0`, `audioOk: true`.
`06-loaded-hud` subject `ok: true`; `19-overkill` / `20-blight-edge` both
`SKIPPED (only-path-enforced)` as expected. `10-inventory` -> `monsters
standing in it`: `ok: true`, `px: 4257`, `perPx:
[147,615,257,1003,95,809,157,1172]`, `sepP50: 0.33` — byte-identical to the
report's `after-A`/`after-B` numbers, independently reproduced on a fresh
port. Visually inspected `10-inventory.png` from this run: the pack is
visibly present (an orange spiked creature and other silhouettes) amid the
blast with large damage numbers, consistent with "monsters standing in the
nova" rather than an empty frame.

`audio.musicPeak` on this run: 0.0546 — inside the report's documented
0.0007-0.1247 flake band, `audioOk: true`. Per instructions, noted and not
held against the review.

## 6. Tests / build — CONFIRMED

```
node tests/run.mjs        -> 47/47 test files, 41 assertions in the last file, 0 failed
node node_modules/vite/bin/vite.js build   -> built in 994ms, no errors
```
`node_modules` junctioned in from the main repo for this session and left in
place per instructions (should be removed by whoever cleans up the worktree,
per the hazard note — I did not remove it since the task said "REMOVE after"
without specifying by whom the capture artifacts I generated should also be
cleaned; noting here: this review added
`reviews/round7/captures/review-inventory/`,
`reviews/round7/captures/review-seed-4242/`, and a `node_modules` junction
under the worktree — none of these were committed).

---

## Findings

### Finding 1 (MAJOR) — dead code shipped: unreachable duplicate of the real fix

`src/core/Harness.js:4114-4138`. The real fix is the unconditional line at
4114 (`for (const e of victims) e.maxHealth = 1e6;`). Immediately after it,
lines 4115-4136 repeat a *second*, near-verbatim copy of the same
before/after/why essay already given in the comment block at 4066-4113
("Refilling the bar once a frame is not a pin, and it never was one...").
Line 4137-4138 then reads:

```js
      // DIAGARM
      if (false) for (const e of victims) e.maxHealth = 1e6;
```

This is unreachable code — `if (false)` never executes — left in the shipped
diff with no explanation of what "DIAGARM" means or why a second, disabled
copy of the fix sits directly beneath the working one. It does not affect
behavior (confirmed: tests pass, capture passes, sabotage-testing the *real*
line at 4114 — not this dead one — reproduces the original failure as
expected), but it is a genuine cleanliness defect: a future reader has no way
to tell from the code alone whether this is an intentional toggle, a merge
artifact, or a forgotten experiment, and the duplicated 20-line essay next to
it makes the block harder to read than the single clean copy at 4066-4113
would be alone. There is no lint step in this repo (`package.json` has no
`lint` script) that would have caught this mechanically; it needs to be
removed by hand before merge.

No other stray debug markers (`TODO`, `FIXME`, `XXX`, stray `console.log`)
found elsewhere in the diff (`grep -n "TODO\|FIXME\|XXX" src/core/Harness.js`
outside this block: no other hits).

---

## Verdict

**SPEC: CONFIRMED.** The stale-gate diagnosis is correct and independently
re-derived, not just re-read: the dissolve fix (`4734ffd`) is a legitimate
rendering correctness fix (own test run, 29/29 pass), the bisect collapse is
reproduced exactly at that commit from the on-disk manifests, the harness fix
is sabotage-honest (disabling the real pin reproduces the original 0-px
failure, run myself), no gate thresholds moved (grepped the diff), the fix is
robust to upstream RNG draw-count drift (verified with an untested seed,
4242, not in the implementer's own evidence set), and a fresh full capture on
the branch reproduces `subjectsOk: true` end-to-end with numbers
byte-identical to the report's `after-A`/`after-B`. Tests 47/47, build green.

**QUALITY: NOT READY**, on one Major finding: a dead, unreachable duplicate
of the fix (`if (false) for (...) e.maxHealth = 1e6;`, labeled only
`// DIAGARM`) plus a redundant duplicate comment block ship in
`src/core/Harness.js:4115-4138`. This should be deleted (keep the single
clean essay at 4066-4113 and the one live line at 4114) before merge. No
other quality issues found; this is a one-line fix wave, not a broader
re-review.

Severity counts: **0 critical, 1 major, 0 minor.**

Commands run (for reproduction): see sections 1-6 above; capture artifacts
this review generated live under
`reviews/round7/captures/review-inventory/` and
`reviews/round7/captures/review-seed-4242/` inside the worktree (uncommitted).
