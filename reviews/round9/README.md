# round9 — readability gate and combat-juice evidence

## `readability-gate.json`

Produced by:

    node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json

Every enemy card the director can spawn (`SPAWN_CARDS` + `BOSS_CARDS`) rendered
twice: once flat black in a shared orthographic box at true relative scale, and
once at `range` metres through the live camera's own FOV at the capture
harness's 1600x900. The first pass answers "is this a different shape from
everything else"; the second answers "is there enough of it on screen at 40 m
to read at all". Six affixes on three representative hosts add the elite pass,
graded on both outline delta and mean colour delta, since a silhouette cannot
see a tint and the tint is half of what an affix is.

`checks` is the graded result. `ok: false` on any non-exempt check exits the
tool non-zero. Exemptions live in `READABILITY.exemptions`
(`tools/silhouette-metrics.mjs`), each carrying the value measured when it was
admitted; the gate passes an exempted check only while it is no worse than
that, plus 1 % of relative slack (a whole pixel, for `px40`) so that a
rasteriser changing its mind does not turn a knife-edge exemption red. Every
exemption was copied from this record at full precision, so without that
epsilon every one of them sat exactly on its own bar. Anything new, and
anything that degrades past the epsilon, is still red — the slack is three
orders of magnitude under the smallest regression any of these checks could
describe.

`tests/readability-gate.test.mjs` re-grades this file on every `npm test` run,
with no GPU and no browser: `gradeRoster` over the stored units against the
current `READABILITY`, asserting `ok === true` and that the stored `checks`
array matches a fresh grade. So the nineteen hand-copied exemptions and the
record they were copied from cannot drift apart unnoticed.

Re-run the command after any change to `src/entities/EnemyMeshes.js`,
`src/data/enemies.js` or the elite table.

## What the committed record is

| Field | Value | Why it is here |
|---|---|---|
| `renderer` | `d3d11` | The real adapter, not SwiftShader. `tools/silhouette.mjs --software` produces a record marked `swiftshader`; two records from different renderers are not directly comparable and a reader diffing them needs to know that before concluding the roster moved. |
| `units[].bands` | ten `{ w, fill, runs }` | Ten horizontal samples crown-to-feet. `runs` is the direct measure of *daylight through the outline* — a band at 1.00 run is a solid bar, arms welded to a torso or legs fused into one column — and it is the metric that can argue about Finding 2 below, where `minHoles` sees only *enclosed* space and reads zero across most of this roster. The record originally kept the widths alone and threw `fill` and `runs` away to the console, which meant the question the exemption note raises could not be answered from committed data without re-running the whole GPU pass. |
| `commit` | `8ff3eb4` | The tree whose art was measured — the HEAD the tool ran against, recorded by the tool itself. **Re-run at the end of the slice** (Task 6 Step 2), and `git diff --stat` on the record showed *only this field moving*: all 514 checks, all 19 exemptions and every measured value are byte-identical to the run at `baa495c`. That is the gate doing its job — Tasks 3-5 are damage, launch and VFX changes, none of which may touch a rig or a mesh, and if one had, a check would have gone red here. The original run at `baa495c` is in this file's history; the commit that first added it (`4a88cfa`) changed only `tools/`, `tests/` and `reviews/`. The final re-run at `8ff3eb4` — the one that added `bands[].fill` and `bands[].runs` — moved `commit`, the band records, and the `floor`/`ceiling` bars of the nineteen exempted checks (the 1 % slack, above). **Every measured value and every check verdict is unchanged**: 25 units and 514 `{id, kind, value, ok, exempt}` tuples compare equal against the previous record, so no number in this README moved with it. |
| `seed` / `range` | `1337` / `40` | The `--seed` and `--range` the run used. |
| `width` / `height` / `fov` | `1600` / `900` / `58` | The 40 m frame. 1600x900 is `tools/capture.mjs`'s own default (`:31`) and is the basis `READABILITY.minPx40` is defined against; `fov` is read off the live camera rather than written down, so the record measures this game's lens. |

**It is deterministic.** Two consecutive runs of the same tree produced a
byte-identical file, `commit` included — verified with `diff`. A gate that
moves between two runs of one tree is measuring the wall clock.

**It has been failed on purpose**, which is the only evidence that a gate is
one — and in this case not by sabotage, but on arrival. The first run, before
any exemption existed, is the whole reason the exemption list has nineteen
entries in it:

```
$ node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json
495/514 checks passed
  FAIL px40 mite: 74 vs floor 219
  FAIL holes mite: 0.0002 vs floor 0.004
  ... (16 more holes failures)
  FAIL familyIoU brood/acolyte: 0.7966 vs ceiling 0.78
exit 1
```

With those nineteen admitted at their measured values it reads `514/514 checks
passed`, exit 0. **No threshold in `READABILITY` was changed to get there** —
the thresholds are the design intent and the exemptions are the debt, and
collapsing the two loses the distinction the ratchet is made of.

## The 514 checks, and the three findings

| Kind | Checks | Exemptions | Result |
|---|---|---|---|
| `px40` | 25 | 1 | 24 clear the floor outright. `mite` at 74 px is exempted. |
| `holes` | 25 | 17 | 8 clear the floor outright. |
| `familyIoU` | 300 | 1 | 299 clear the ceiling outright. `brood/acolyte` at 0.7966 is exempted. |
| `foeFriendIoU` | 125 | 0 | All clear. Worst is `matron/anvil` at 0.586, against a 0.72 ceiling. |
| `tierArea` | 3 | 0 | All clear: 2.848x (tier 1 to 2), 4.346x (2 to 3), 1.648x (3 to 4), against a 1.6 floor. |
| `eliteDelta` | 18 | 0 | All clear. Worst is `golem:warded` at 0.2691, against a 0.10 floor. |
| `eliteChroma` | 18 | 0 | All clear. Worst is `golem:withering` at 0.1797, against a 0.06 floor. |
| **total** | **514** | **19** | |

Every number in that table is recomputable from `readability-gate.json`; the
`checks` array in the file is the source.

### Finding 1 — the mite cannot be read at 40 m

74 px against a 219 floor, a third of what the bestiary shot's own per-object
floor asks for. The mite is 0.5 m tall and spawns in packs of five to nine, so
it may well be meant to read as a cloud rather than as an individual — but that
is a design decision nobody has written down, and until it is, this is the
roster's one genuine range failure. Content work.

### Finding 2 — seventeen of twenty-five silhouettes have no daylight in them

This is the largest thing the gate found. Eight of the seventeen — `lemurian`,
`wisp`, `pest`, `harrier`, `brood`, `hulk`, `titan` and `wyrm` — read *exactly
zero* enclosed negative space, and the last three of those are the biggest
masks in the record (`titan` 858x737 px of bounding box, `wyrm` 540x760,
`hulk` 332x452), with tens of thousands of pixels available to find a hole in.

It is not the instrument failing, and the same run proves it: `thunderhead`
reads 14.03%, `acolyte` 3.72%, `vizier` 2.12%, `warden` 1.95%. Enclosed space
is detected wherever it exists. What the zeros say is that most of this
roster's outlines are *closed* — the gaps that exist are between legs or beside
an arm, open at the boundary, and the flood fill correctly declines to count
them.

One caveat belongs on the small end of the list rather than the large: the
orthographic box is sized to the tallest card in the roster, so `mite` occupies
a 65x66 mask and a 0.4% hole in it is about 17 pixels. That is a real
sensitivity limit for the smallest cards. It does not touch the finding at the
top of the list, where the masks are hundreds of pixels on a side.

Which raises the question of whether `minHoles` is the right operator for
"daylight" at all — enclosed space is a *subset* of daylight, and this roster's
gaps are open at the boundary. The metric that answers it is `units[].bands`,
now recorded in full: `runs` counts how many separate spans of the silhouette a
scanline crosses, so a limb that has genuinely separated from a torso reads
above 1.00 there whether or not the flood fill can reach it. The threshold is
deliberately *not* retuned here — the exemptions are the debt and moving the
bar would erase it — but the next slice can now argue the question against
committed data instead of re-running the GPU pass to recover it.

### Finding 3 — brood and acolyte are close to the same shape

0.7966 against a 0.78 ceiling — over by 0.0166, so marginal rather than
alarming. Both are tall, narrow, hunched tier-2 casters (`brood` at aspect
0.500, `acolyte` at 0.602) and at bbox-normalised scale their postures nearly
coincide. The next-worst pair in the whole roster is `charger/brood` at 0.734,
comfortably under the bar. Content work: one of the two needs a distinguishing
feature that survives being flattened.

## Two things the gate does not cover

**`special` cards are not measured.** `SPAWN_CARDS` and `BOSS_CARDS` both
filter `!e.special`, which excludes `anchor`, `warden_vault` and `herald`. The
first two share a `meshFactory` with a card that *is* measured (`brood` and
`warden` respectively), so they would have read at IoU ~1.0 against their
hosts; they are absent rather than exempted. No two measured cards share a
`meshFactory` — verified directly against the card list — so there are no
same-rig pairs in the 300 family comparisons.

**One pose, one angle.** Every rig is settled 150 steps at 1/60 into its own
idle at zero speed and turned 0.24 rad off-axis. Readability during an attack
windup, in death, or from behind is not measured by this record.

---

# The combat-juice evidence (slice `2026-08-08-readability-juice`, Task 6)

Everything below was produced on **d3d11**, the real adapter, at commit
`c6795cb` unless a row says otherwise. A record taken under SwiftShader is not
comparable to one taken here — `tools/juiceprobe.mjs` and `tools/capture.mjs`
both stamp `renderer` into their output for exactly that reason.

## What this slice did **not** touch: `reviews/round8/baseline-HEAD.json`

**The single-player equivalence baseline is untouched by this slice and was not
regenerated.** Every change in the slice is presentation — two additive payload
fields, a colour lookup, a transform offset written on top of the owner's, and
a tool — so the fingerprint has to be clean, and it is:

```
$ node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json
NOTE: this window contains no elite (no "<id>+<affix>" damage source).
      A change to ELITE_STATS cannot move this fingerprint. Run `npm run gate:elite`,
      which is the gate that does have power over it.
single-player unchanged vs reviews/round8/baseline-HEAD.json — no fields moved
exit 0

$ npm run gate:elite
elite damage unchanged vs reviews/round8/elite-baseline-HEAD.json — no fields moved
exit 0
```

`reviews/round8/README.md`'s rule applies unchanged and is worth restating
here, because this directory now contains four new records: *a re-baseline with
no on-disk record of what it absorbed is how a real regression hides inside an
accepted one.* Nothing here is a re-baseline. Every file below is a first
capture of a new instrument.

There is a second, independent corroboration of the same claim in this
directory, and it was not designed to be one: the two `--mode cost` probe runs
below drive an identical fixture on the pre-slice tree and on this one and both
kill **exactly 458 monsters in 3,000 frames**, with the same director level and
the same health multiplier. That is the simulation being bit-for-bit
indifferent to everything this slice shipped.

## `juice-probe.json` — how often the juice actually happens

Produced by:

    node tools/juiceprobe.mjs --kills 200 --port 5205 \
      --costBefore reviews/round9/juice-cost-preslice.json \
      --costAfter reviews/round9/juice-cost-head.json \
      --out reviews/round9/juice-probe.json

Measures commit `c6795cb`. Two arms, because overkill rate and element coverage
are properties of a *damage profile* and the profile moves enormously across a
run. Both pin `ctx.time` before they start, so neither inherits the other's
difficulty. `raw.kills` in the file is the per-kill source for every number in
the tables below.

| Fixture | game time | survivor | items | director lvl | healthMult | sample |
|---|---|---|---|---|---|---|
| `mid` | 587 s | L14 | 11 | 11 | 4.0 | 118 kills (frame-budget-limited) |
| `late` | 1333 s | L39 | 97 | 50 | 15.7 | 202 kills |

### (a) Overkill rate — the launch is a late-run default, not a reward

`LAUNCH.minOverkillFrac` is **0.35**.

| Fixture | cleared the threshold | median `overkill/maxHealth` | median launch | p90 frac | p90 launch |
|---|---|---|---|---|---|
| `mid` | 37 / 118 = **31.4%** | 0.188 | **0 m** (under the threshold) | 0.920 | **5.24 m** |
| `late` | 182 / 202 = **90.1%** | 13.08 | **6.82 m** (capped) | 106.5 | **6.82 m** |

Launch distance is derived from the game's own kinematics rather than measured
off one corpse: `speed = maxSpeed * k`, `vy = speed * 0.62`, flight time
`2*vy/gravity` capped by `LAUNCH.dur`, so full power (`k = 1`) reaches 6.82 m.

**The finding.** The brief's own reading is that under ~10% the threshold is
too high to be felt and over ~70% the launch is the default rather than the
reward. `mid` sits at 31.4% — healthy, and the median kill there is *not*
launched, which is what makes a launch mean something. `late` sits at **90.1%,
past the "default" line**, and its median overkill is **13x the victim's entire
health pool**, so `k` clamps to 1 and essentially every late-run kill throws the
body the maximum distance at the maximum speed. The effect stops being a signal
and becomes the ambient behaviour of dying.

**This is recorded, not fixed.** Retuning `LAUNCH.minOverkillFrac` is the next
slice's argument to have against this file. A quiet edit here, under cover of
the run that discovered it, is exactly the move this record exists to make
visible.

### (b) Element coverage — `void` is a table entry with no consumer

`elementOf(type, status)` over every kill in each arm:

| Fixture | kinetic | fire | ice | shock | nature | void | blast |
|---|---|---|---|---|---|---|---|
| `mid` (118) | 4 | – | – | 66 | – | **–** | 48 |
| `late` (202) | 23 | 123 | 16 | 26 | 11 | **–** | 3 |
| cost arm (458) | 56 | 283 | 19 | 36 | 54 | **–** | 10 |

**Two findings.**

1. **`void` never appears — in any arm, across 778 kills.** `KILL_SIGNATURE.void`
   is the one signature the whole slice reasoned hardest about (it is the single
   ringless death, and Task 5's review moved `ring` to match that narrative),
   and nothing in a normal run can produce it. `TYPE_ELEMENT` maps only the
   literal type string `'void'`, and no item, ability or enemy in
   `src/data/items.js` / `src/data/abilities.js` writes `type: 'void'` on a
   damage info object. The projection is correct; it has no caller. Either a
   void damage source needs to exist or the row is dead code with a comment on
   it — a decision for the content pass, not for a quiet map edit.
2. **The fear that a run would be 95% kinetic is refuted, and the DOT channel is
   live.** `late` reads 11% kinetic; the rest is real elemental spread. The
   per-`type+status` histogram in the file carries **`fire+burn: 12`** — the
   status channel Task 3 added at `src/data/abilities.js` reaching a live kill
   event, which is precisely the gap the pre-flight review found and which no
   unit test could have caught.

Also on the record, because it is a fixture property and not a game property:
`mid` reads only three families, because a twelve-item survivor simply does not
own the vocabulary. Do not read that row as coverage.

## `juice-cost-preslice.json` / `juice-cost-head.json` — (c) cost

Produced by the same tool in its cost mode, once per tree:

    # in a worktree at baa495c^ (the commit before the slice)
    node tools/juiceprobe.mjs --mode cost --port 5206 \
      --out reviews/round9/juice-cost-preslice.json
    # on this tree
    node tools/juiceprobe.mjs --mode cost --port 5205 \
      --out reviews/round9/juice-cost-head.json

The cost arm is the **only** arm of its own run, and that is what makes the two
readings comparable: `renderer.info.programs` counts what a page has compiled so
far, so it measures what has been drawn *before* the reading as much as what the
tree contains. A draft that ran the cost arm after another arm read 72 programs
against the pre-slice tree's 71, and the whole difference was the meshes the
earlier arm had already walked past.

| | `c363868` (pre-slice) | `c6795cb` (this tree) | delta |
|---|---|---|---|
| kills in 3,000 frames | 458 | 458 | **0** |
| programs at fight start | 71 | 71 | **0** |
| programs at peak | 71 | 71 | **0** |
| programs at end | 71 | **72** | **+1** |
| geometries | 418 / 421 | 418 / 421 | **0** |
| textures | 53 | 53 | **0** |
| sprites emitted | 264,915 | 310,715 | **+17.3%** |
| peak sprites / 30 frames | 5,148 | 6,434 | **+25.0%** |

**The program count moved, and the mechanism is measured rather than inferred.**
The brief's expectation was flat, so the +1 is a finding. Both records carry a
`corpseDissolve` block counting calls into `VFX.deathDissolve` and how many of
them actually started a dissolve: **pre-slice 0 / 0, this tree 458 / 458.**
`deathDissolve` builds a dissolve *material variant* through `makeDissolvable`,
and before this slice `resolveObject` could not see an enemy rig at all (commit
`d980a17`, "every corpse died unthrown and undissolved"), so the call was made
and did nothing. The extra program is a **shipped shader reaching the GPU for
the first time**, not a fork: one program, not seven, and no new geometry or
texture. The same mechanism is the whole of the particle rise — dissolving
corpses emit, and 458 of them now do.

**On the particle numbers.** They are *emission*, not liveness. `ParticleSystem`
has no live counter: `layers.*.live` is initialised at
`src/fx/ParticleSystem.js:141` and never written again, because the system is a
GPU-time ring buffer with no CPU-side liveness. The probe wraps the real
`particles.emit` and sums `count`, which is the honest proxy and is labelled as
such in both records.

### (d) No shared-stream draw

Not measured by the probe, deliberately. The claim is the sp-equivalence
fingerprint at the top of this section — `no fields moved` against
`reviews/round8/baseline-HEAD.json`, which is exact where a probe would be
indicative. The probe's record carries the command and the file rather than a
restatement of the result.

## `money-shot/` — `19-overkill`

Produced by:

    node tools/capture.mjs --out reviews/round9/money-shot --only 19-overkill --port 5203

Measures commit `54d7470` (the commit that adds the scenario). **Exit 0,
`subjectsOk: true`, `frameErrors: 0`** — which is the gate; a plausible-looking
image with an absent subject is the specific failure the manifest design exists
to prevent.

A Slag Hulk killed by a fire blow with four pools of damage to spare, four
beetles flanking, photographed 12 frames after the killing blow with the corpse
mid-arc and the fire kill signature live.

| Subject | gate | measured |
|---|---|---|
| the launched corpse (its rig root) | `minPixels 900` | **1,717 px**, 1,406 carried |
| the kill burst | `minPixels 150`, `minCarriedPx 120`, aggregate | **269 px**, 216 carried, per-pool `[53, 0, 0, 220]` |
| the survivor | `minPixels 400` | **976 px**, 915 carried |
| the corpse is off the ground it died on | `> 0.25 m` | **0.924 m** (ground 2.347, root 3.271) |

**Why 12 frames and not the 6 the plan derived.** Six frames (0.1 s) is the
right answer for the *arc* — 0.57 m up and rising hard — and the wrong one for
the burst, which at 6 frames is still inside the body it came from: it is
emitted at the victim's position in a 0.35 m shell, and a hulk is 4.2 m tall
with a 1.25 m radius. Measured from the survivor's own third-person boom the
burst contributed **1 px at 6 frames and 43 at 10**. Twelve frames (0.2 s) puts
the corpse 0.924 m up — 87% of the 1.057 m apex, still rising — with the burst
clear of the body.

**The lens is chosen rather than inherited**, which is this scenario's one
departure from `08-explosion`'s idiom, and it was chosen off a grid run on a
**fresh page per cell** (3 standoffs x 4 shutter delays; the table is in the
task report). Fresh matters: an earlier sweep that reused one page read the
burst at 400-2,600 px and every one of those numbers was contaminated — the
particle and ring pools are shared, the previous arm's corpses sat on nearly the
same spot, and the region was counting *their* deaths.

**The floors are set from that grid, not from taste** — the same rule
`MIN_SEPARATION` is set by. A frame with no burst reads 1 px; the grid's worst
legitimate cell reads 78 carried px and its best 220. The floor is 120, in the
empty band between those populations and nearer the failure than the pass.

**One honest limitation.** `minCarriedPx` on the burst buys an aggregate over
four shared pools, and `manifest.toleratedAbsences` carries the reason
(`aggregateWhy`) plus the per-pool counts. `vfx.trails` and `vfx.beams`
contribute **0** on this frame and are published as zeros rather than hidden
inside a sum — a monster kill fires neither.

## `shot-diff-control.txt` / `shot-diff-noise-floor.txt` — the appended scenario displaced nothing

`19-overkill` is appended **dead last** in `tools/capture.mjs`'s `SCENARIOS`,
after `16-run-summary`, because every scenario draws from the shared RNG stream
and one inserted in the middle displaces every shot below it. That is the
claim, and this is the measurement rather than the assertion.

Two full-library captures, both d3d11, both into scratch directories (the PNG
trees are ~40 MB each and are not committed; their manifests are, under
`shot-control-manifests/`):

    # this tree, with 19-overkill appended — commit 54d7470
    node tools/capture.mjs --out <scratch>/shots-after --port 5204
    # a git worktree at HEAD~ (caa8082), before the scenario and the append existed
    node tools/capture.mjs --out <scratch>/shots-before --port 5204
    # a SECOND capture of this tree, for the noise floor
    node tools/capture.mjs --out <scratch>/shots-after2 --port 5204

    node tools/shotdiff.mjs <scratch>/shots-after <scratch>/shots-before  > reviews/round9/shot-diff-control.txt
    node tools/shotdiff.mjs <scratch>/shots-after <scratch>/shots-after2  > reviews/round9/shot-diff-noise-floor.txt

**The two trees compared are `54d7470` and `caa8082`.** There is still no single
committed shot-library directory at the repo root — that is slice 4's job — so
this is the fallback path the plan named, and both captures use the same
renderer, because a d3d11 capture diffed against a SwiftShader one fails every
shot and tells you nothing about the scenario it exists to check.

**The noise floor is the point.** `tools/shotdiff.mjs` has no exit gate — read
its own docblock: `capture.mjs` is deterministic in simulation and *not*
byte-deterministic in output, so any "unchanged" claim has to be made against a
same-tree control. Both diffs are below, side by side, and every cross-tree
figure is **smaller than the same-tree noise on the same shot**:

| shot | cross-tree mean / %>8 | same-tree mean / %>8 |
|---|---|---|
| `04-combat` | 3.22 / 8.89 | **5.20 / 14.53** |
| `06-loaded-hud` | 2.40 / 5.24 | **5.56 / 16.34** |
| `08-explosion` | 5.49 / 16.21 | **12.58 / 34.90** |
| `10-inventory` | 2.35 / 5.16 | **5.18 / 15.67** |
| `11-bestiary` | 1.03 / 0.41 | 1.03 / 0.42 |
| every menu shot (`14`-`18`) | ≤ 0.14 / 0.00 | ≤ 0.30 / 0.02 |
| **aggregate** | **1.18 / 1.80** | **2.09 / 4.69** |

Two runs of one tree differ *more* than the two trees differ. The appended
scenario displaced nothing that this instrument can distinguish from run-to-run
GPU and VFX-phase noise, and the four shots that move at all are exactly the
four with live particle systems in them.

**`06-loaded-hud` fails its subject check on both trees**, identically
(`shot-control-manifests/shots-before.manifest.json` and
`shots-after.manifest.json`). It is the open regression documented in
`Harness.lateRun`'s own docblock and predates this slice; it is named here so
nobody reads it as fallout.

**`19-overkill` fails on a full run, by design and as the plan predicted.**
`16-run-summary` runs immediately before it and has already killed the player,
so the scenario begins from a dead run and the hulk never dies: the manifest
records `liftMetres: 0`. The supported path is `--only 19-overkill` against a
fresh page, which is how `money-shot/` above was taken, and which exits 0. The
scenario's placement comment in `tools/capture.mjs` says so at the append site.
