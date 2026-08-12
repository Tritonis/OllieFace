# launch-retune — the percentile gate, measured

Slice `2026-08-11-overkill-launch-retune`. This directory answers the finding
`reviews/round9/README.md` §(a) recorded and refused to fix under cover of the
run that found it: with `LAUNCH.minOverkillFrac` alone, **90.1 %** of late-run
kills threw a body, at maximum power, every time — the launch had stopped being
a signal and become the ambient behaviour of dying.

## What shipped

`src/systems/LaunchGate.js` — `GATE = { window: 32, warmup: 8, percentile: 0.70 }`,
wired into `VFX._onKill`. A common kill launches only if its overkill fraction
clears **both** the 0.35 floor **and** the 70th percentile of the last 32 kill
fractions. Elites and bosses bypass the percentile. Under 8 recorded samples the
floor alone decides. No RNG, no clock, no per-frame state: the ring buffer lives
on `VFX`, the decision is a pure function.

## `juice-probe-after.json` — how often the juice actually happens now

Produced by:

    node tools/juiceprobe.mjs --kills 200 --port 5215 \
      --out reviews/launch-retune/juice-probe-after.json

Measures commit `e595bc2`, renderer **d3d11**, seed 1337, 0 page errors, 0
console errors. The baseline it is read against is
`reviews/round9/juice-probe.json` at commit `c6795cb`, renderer **d3d11** —
same tool, same two arms, same seed, same kill target. `--costBefore` /
`--costAfter` are absent because this slice ships no shader and no geometry;
the cost question is round 9's and is not re-asked here.

Both arms landed on the same fixture the baseline did, which is what makes the
two records the same measurement:

| Fixture | game time | survivor | items | director lvl | healthMult | sample |
|---|---|---|---|---|---|---|
| `mid` | 587 s | L14 | 11 | 11 | 4.0 | 118 kills (frame-budget-limited) |
| `late` | 1333 s | L39 | 97 | 50 | 15.7 | 202 kills |

### The field rename, and why the baseline's numbers still line up

Under the floor-only rule, clearing the threshold **was** launching, so the
probe's one statistic was honestly called `launchedCount` / `launchedFraction`.
Under the gate those are two different populations, so this record splits them:

- **`clearedFraction`** — kills that beat `minOverkillFrac` (0.35). The
  *eligible* population. **This field is what the c6795cb baseline called
  `launchedFraction`**; compare it to the baseline like-for-like.
- **`launchedFraction`** — kills that actually threw a body, counted by
  wrapping the real `VFX.corpseLaunch` on the live page (the same wrap-the-real-
  call technique the probe already used for `deathDissolve` and `emit`), not
  inferred from a re-implemented rule. The *launched* population, and a subset
  of the eligible one.

A record that had kept the old name for the eligible number would have reported
"90.1 % unchanged" for a slice whose whole point is that the number moved.

### The result

| Fixture | eligible (cleared the 0.35 floor) | launched, baseline c6795cb | launched, this tree |
|---|---|---|---|
| `mid` | 37 / 118 = 31.4 % (unmoved) | 37 / 118 = **31.4 %** | 37 / 118 = **31.4 %** |
| `late` | 182 / 202 = 90.1 % (unmoved) | 182 / 202 = **90.1 %** | 77 / 202 = **38.1 %** |

The floor is untouched, so the eligible column is byte-identical to the
baseline in both arms — the gate did not move the threshold, it added a second
question on top of it. The `mid` arm is unchanged end to end: its kill
distribution is wide enough that the kills clearing 0.35 are already the kills
that beat their own recent p70, so the gate is invisible where the launch was
already a reward. The `late` arm falls from 90.1 % to 38.1 %, inside the
brief's `[10 %, 70 %]` band, and roughly the top third of kills now throw a
body — which is what a run-relative percentile is *for*: the late run's median
overkill is 13x the victim's entire health pool, and no fixed constant can be
low enough for `mid` and high enough for `late` at the same time.

The launch distances, the median and p90 fraction columns, and the element
histogram are all unmoved from round 9 and are not re-tabulated here; the
per-kill source for every number above is `raw.kills` in the record, as before.

### Percentile sensitivity

`GATE.percentile = 0.70` is a chosen constant, and the record owes the reader
what the alternatives measure. Replaying the shipped gate over the baseline's
`raw.kills` (same floor, same 32-kill window, same elite bypass) gives:

| `percentile` | `mid` launched | `late` launched |
|---|---|---|
| 0.60 | 31.4 % | 44.1 % |
| 0.65 | 31.4 % | 38.6 % |
| **0.70 (shipped)** | **31.4 %** | **36.6 %** (predicted) / **38.1 %** (measured) |
| 0.75 | 31.4 % | 34.2 % |
| 0.80 | 31.4 % | 28.7 % |

Every candidate in that range clears the band, so the choice is not knife-edge
and no knob was turned to make the numbers land: 0.70 was picked before the run
and the run was taken once. The `mid` column does not move at all across the
whole sweep, which is the strongest single piece of evidence that the gate is
inert on a healthy damage profile. The measured late number sits 1.5 points
above the replay because the replay reads the event stream (`overkill` per kill)
while the game also requires a resolvable corpse rig and carries its ring buffer
across the arm boundary — the replay is an estimate of the rule, the record is
the game.

## `19-overkill` — the money shot still fires

Produced by:

    node tools/capture.mjs --only 19-overkill --out <scratch>/shots-overkill \
      --port 5216 --seed 1337

Exit **0**, `subjectsOk: true`, `subjectsOkFresh: true`, `audioOk: true`,
`errorCount: 0`, `subjectFailures: []`, clock pinned, 0 frame timeouts. The
scenario is a single scripted hulk kill at `overkillFrac 4`, so it is under the
8-sample warm-up and the gate hands it to the floor — deliberately, so the
capture suite keeps testing the launch itself rather than the run history it
does not have.

| subject | kind | ok | px | frac | contrast | sep | min px |
|---|---|---|---|---|---|---|---|
| the launched corpse | pixels | true | 1717 | 0.01325 | 0.918 | 0.896 | 900 |
| the kill burst | pixels | true | 269 | 0.00208 | 0.402 | 0.272 | 150 |
| the survivor | pixels | true | 978 | 0.00755 | 0.593 | 0.544 | 400 |
| the corpse is off the ground it died on | dom | true | – | – | – | – | – |

`detail`: `id: hulk`, **`liftMetres: 0.924`**, `launchFrames: 12`,
`overkillFrac: 4` — the same 0.924 m the shot measured at `54d7470`, against a
bar of 0.25 m. `perf`: 71 programs, 419 geometries, 53 textures. The output
directory was deleted after these numbers were copied; the shot is reproducible
from the command above.

## What the gate does not change

| claim | proven by |
|---|---|
| the 0.35 floor still rejects everything under it | `tests/launch-gate.test.mjs` — a sub-floor fraction is refused whatever the history and whatever the elite flag |
| the power curve is untouched — a launched kill flies exactly as far as it did | `tests/corpse-launch.test.mjs`; and the record's own unmoved launch-metres columns |
| elites and bosses launch on the floor alone | `tests/launch-gate.test.mjs` — the `always` arm bypasses the percentile |
| the first 8 kills of a run use the old, deterministic rule | `tests/launch-gate.test.mjs` — under `warmup` samples the quantile is not consulted; and `19-overkill` above, which is one such kill |
| no draw-order, damage or elite-damage consequence | `node tests/sp-equivalence.mjs` (the two-field id-migration set, and nothing else) and `npm run gate:elite` (`no fields moved`) |

## Honest limitations

The two arms are **pinned-clock scripted fixtures, not play**. They pin the
survivor's health, top the field up to 14 monsters on the director's own spawn
path, and hold the fire button down; a human moves, retreats, and picks
different items, and their kill distribution will not be either of these two.
What the fixtures do give is the two ends of the range the profile actually
travels, measured the same way on both trees, which is what a before/after
needs. The 70th percentile is a chosen constant: the sweep above is its
sensitivity, and it is a *shape* argument (roughly the top third of a run's own
kills) rather than a number derived from anything. The window of 32 is likewise
chosen — long enough that one burst of trash does not redefine "standing out",
short enough to track a damage profile that moves as fast as this one does.
Neither is a tuned fit to these 320 kills, and neither should be re-tuned
against them; the next reading that argues with this one should be a playtest.
