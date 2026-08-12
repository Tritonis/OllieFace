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
console errors. The record's `commit` field is a bare `git rev-parse HEAD` with
no dirty flag, so it names the *game* tree only: the run was taken with the
launch counter added to `tools/juiceprobe.mjs` but not yet committed, and the
tool as it produced this record landed in `6b74643`. `src/` is byte-identical at
`e595bc2` and `6b74643`, so **`6b74643` alone reproduces the record** — tool and
game tree together. (A later commit on this branch added a `wrappedRealLaunch`
disclosure flag to the probe's summary and reworded a comment; it changes
nothing that is counted, so a re-run at branch HEAD reproduces every number
here and adds that one field.) The baseline it is read against is
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
- **`launchedFraction`** — **gate-passed launch calls**: every kill on which
  `VFX._onKill` decided to launch and called `corpseLaunch`, counted by wrapping
  the real method on the live page (the same wrap-the-real-call technique the
  probe already used for `deathDissolve` and `emit`), not inferred from a
  re-implemented rule. The *launched* population, and a subset of the eligible
  one. It is calls rather than bodies in flight by a hair: `corpseLaunch`
  returns without registering on zero power and on a corpse already in flight
  (`src/systems/VFX.js:820-821`). Neither path fired in this record — replaying
  the gate with a `power > 0` guard gives the same 37 and 77 — but the field
  name means "asked", the way the dissolve wrap's `calls` does.

A record that had kept the old name for the eligible number would have reported
"90.1 % unchanged" for a slice whose whole point is that the number moved.

### The result

| Fixture | eligible (cleared the 0.35 floor) | launched, baseline c6795cb | launched, this tree |
|---|---|---|---|
| `mid` | 37 / 118 = 31.4 % (unmoved) | 37 / 118 = **31.4 %** | 37 / 118 = **31.4 %** |
| `late` | 182 / 202 = 90.1 % (unmoved) | 182 / 202 = **90.1 %** | 77 / 202 = **38.1 %** |

The floor is untouched, so the eligible column is byte-identical to the
baseline in both arms — every per-kill field the eligibility question reads
(`frac`, `overkill`, `maxHealth`, `type`, `status`, `element`, `isElite`) is
identical entry for entry, the sole exception being `raw.kills[].id`, where 79
entries carry today's enemy-id migration (pest→shrike, beetle→scarab,
lemurian→skink, wisp→mote, golem→sentinel) and nothing else moves. The gate did
not move the threshold, it added a second
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
what the alternatives measure. `reviews/launch-retune/replay.mjs` — committed
beside this file, run it — replays the **shipped** `src/systems/LaunchGate.js`
over the baseline's `raw.kills` in emission order (same floor, same 32-kill
window, same elite bypass, decision taken before the push exactly as
`src/systems/VFX.js:1411-1414` does). It reports the sweep under both
**ring-reset conventions**, because that convention — not the percentile — is
the assumption that changes the answer, and a table that leaves it unsaid is
not reproducible:

- **carried**: one ring across both arms, which is what the probe ran (`VFX`
  allocates `_overkillRecent` once, at `src/systems/VFX.js:204`, and the two
  arms share one page). This is the column that is apples-to-apples with the
  measurement.
- **fresh**: a ring per arm — a single-fixture run, or a session that only ever
  has one damage profile.

| `percentile` | `mid` (both models) | `late` carried | `late` fresh |
|---|---|---|---|
| 0.60 | 31.4 % | 47.5 % | 44.1 % |
| 0.65 | 31.4 % | 40.1 % | 38.6 % |
| **0.70 (shipped)** | **31.4 %** | **38.1 %** — the measured value | 36.6 % |
| 0.75 | 31.4 % | 35.2 % | 34.2 % |
| 0.80 | 31.4 % | 30.7 % | 28.7 % |

Every candidate in the range clears the band under **either** model, so the
choice is not knife-edge and no knob was turned to make the numbers land: 0.70
was picked before the run and the run was taken once. The `mid` column does not
move at all across the whole sweep — and is identical under both models, `mid`
being the first arm — which is the strongest single piece of evidence that the
gate is inert on a healthy damage profile.

The carried column at 0.70 reproduces the live counters **exactly** — 37 and
77, to the integer, not within tolerance — because the record carries per-kill
order and `isElite`, so the shipped rule can be re-run over the recorded stream.
That exactness is also what makes the 38.1 %-vs-36.6 % gap a known quantity
rather than instrument noise: it is three specific kills (`late` indices 9, 10
and 16), and the mechanism is the shared ring, described as a fixture artefact
under Honest limitations below.

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
needs.

**Two arms on one page is a fixture artefact, and it is in the headline
number.** `VFX` allocates its 32-slot ring once and never resets it, so when the
`late` arm opens, the window is still full of `mid`'s fractions — a p70 of
**0.888** against a late run whose median kill overkills by 13x its victim's
whole pool, where a cold `late` window prices the same percentile in the tens.
`late`'s early kills
therefore face an artificially low bar until the window has refilled with
late-run fractions. It is worth exactly three launches: kills at `late` indices
9, 10 and 16 launch under the carried ring and would not under a fresh one, so
the measured **77/202 = 38.1 %** would read **74/202 = 36.6 %** had the arm
started cold. Both sit deep inside the band and neither changes any verdict, but
the 38.1 % is a two-arms-one-page number, not a property of a late run in
isolation. (A real session shares the artefact in kind — the ring genuinely does
carry a run's whole history — but a real session arrives at its late profile
gradually rather than in one step, so the effect there is smeared across
minutes instead of concentrated in seventeen kills.) Nothing about a corpse rig
is involved: the record's `corpseDissolve.calls` reads 118 and 202, equal to the
sample in both arms, so `resolveObject` returned a rig for every kill and the
`obj` guard never removed a launch.

The 70th percentile is a chosen constant: the sweep above is its
sensitivity, and it is a *shape* argument (roughly the top third of a run's own
kills) rather than a number derived from anything. The window of 32 is likewise
chosen — long enough that one burst of trash does not redefine "standing out",
short enough to track a damage profile that moves as fast as this one does.
Neither is a tuned fit to these 320 kills, and neither should be re-tuned
against them; the next reading that argues with this one should be a playtest.
