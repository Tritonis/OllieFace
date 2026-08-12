# acolyte-silhouette — the crook, measured

Slice `2026-08-12-acolyte-silhouette`. This directory answers the finding
`reviews/round9/README.md` §Finding 3 recorded and refused to fix under cover of
the run that found it: `familyIoU brood/acolyte` at **0.7966** against a 0.78
ceiling, admitted to the exemption list at its measured value because two
hunched tier-2 casters had flattened to the same normalised posture and the
honest answer was art rather than a moved bar.

## What shipped

Three primitives appended to the `'aco.robe'` merged list in `buildAcolyte`
(`src/entities/EnemyMeshes.js`), on the existing `dark` material: a 2.6 m
tapered shaft at x +0.66, a crook ring at its head, and a short cross-piece.
Nine lines, one file, commit **`d546161`**. No card, no rig, no animation, no
threshold.

The exemption was **deleted**, not relaxed — `tools/silhouette-metrics.mjs` now
carries eighteen entries and a `RETIRED:` note in place of the nineteenth.

## `reviews/round9/readability-gate.json` — the gate, re-measured

Produced by:

    node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json

The tool hardcodes port **5201** and takes no `--port`. Renderer **d3d11** — the
real adapter, not SwiftShader; seed `1337`, range `40 m`, 1600x900, `fov` read
off the live camera. `514/514 checks passed`, **18 EXEMPT lines**, exit 0.

| | before (`04421d2`) | after (`d546161`) |
|---|---|---|
| `familyIoU brood/acolyte` | **0.7966**, exempt at its own value | **0.5551**, no exemption behind it |
| ceiling | 0.78 raw (0.804566 with the 1 % exemption slack) | 0.78 raw |
| exemptions in `READABILITY` | 19 | **18** |
| checks | 514, all `ok` | 514, all `ok` |

**One geometry iteration, and it is worth saying so.** The task carried three
candidate staff sizes and a prediction of ~0.5-0.6 for the first. The first
measured 0.5551 — inside the prediction — so no second or third pass was run and
no dimension was tuned against the metric. A number that had been walked down
by three attempts would be a number fitted to this gate; this one is not.

### Every acolyte family pair, closest first

Ceiling 0.78 on all 24. All `ok`, none exempt, on both trees.

| pair | after | before | | pair | after | before |
|---|---|---|---|---|---|---|
| `brood/acolyte` | **0.5551** | 0.7966 | | `acolyte/matron` | 0.3965 | 0.5808 |
| `acolyte/mortar` | 0.5024 | 0.5254 | | `shriver/acolyte` | 0.3953 | 0.6138 |
| `acolyte/maw` | 0.4972 | 0.6203 | | `mite/acolyte` | 0.3863 | 0.3979 |
| `acolyte/thunderhead` | 0.4800 | 0.5219 | | `acolyte/redoubt` | 0.3803 | 0.5334 |
| `warden/acolyte` | 0.4745 | 0.6606 | | `skink/acolyte` | 0.3774 | 0.5529 |
| `charger/acolyte` | 0.4704 | 0.7001 | | `acolyte/sentinel` | 0.3761 | 0.6202 |
| `burrower/acolyte` | 0.4585 | 0.6403 | | `spitling/acolyte` | 0.3529 | 0.5712 |
| `mote/acolyte` | 0.4398 | 0.4602 | | `harrier/acolyte` | 0.3141 | 0.2707 |
| `acolyte/wyrm` | 0.4357 | 0.4862 | | `scarab/acolyte` | 0.2934 | 0.4751 |
| `acolyte/hulk` | 0.4323 | 0.6312 | | `stalker/acolyte` | 0.2664 | 0.3917 |
| `acolyte/vizier` | 0.4135 | 0.6482 | | `shrike/acolyte` | 0.2405 | 0.3811 |
| `acolyte/lasher` | 0.4106 | 0.5653 | | | | |
| `acolyte/colossus` | 0.4012 | 0.6043 | | | | |

The feared failure mode was trading one collision for another — a robed figure
with a staff is what `vizier` and `warden` already are. It did not happen and
the record says which direction it went instead: `acolyte/vizier` **0.6482 →
0.4135**, `warden/acolyte` **0.6606 → 0.4745**. The acolyte's *worst* pair after
the change (0.5551) sits below what its **second**-worst read before (0.7001).

Two checks moved the wrong way and neither is near a bar:
`familyIoU harrier/acolyte` 0.2707 → 0.3141 (ceiling 0.78, 0.466 of margin
left), and `holes acolyte` 0.0372 → 0.0323 against a 0.004 floor — 8.1x over,
and arithmetic rather than lost daylight, because the staff adds solid mask to
the denominator while the enclosed space under the mantle is untouched. The
acolyte still prints the third-highest holes reading in the roster.

`px40 acolyte` **737 → 883** against a 219 floor: the crook is a 40 m read, not
just a bestiary-lineup read.

### The end-of-slice re-run, and what its one moved line proves

The record Task 1 committed was written by a tool run that finished *before* the
commit existed, so it stamped the pre-staff HEAD. Re-run at the art's own commit:

    $ node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json
    514/514 checks passed ... exit 0

    $ git diff --stat reviews/round9/readability-gate.json
     reviews/round9/readability-gate.json | 2 +-
     1 file changed, 1 insertion(+), 1 deletion(-)

    -  "commit": "125eb19d912bd4e1b2341c1e2500b7dc1cefa3a6",
    +  "commit": "d54616170cf94662793f207eb32c5f1970d83da4",

**One line. The `commit` field, and nothing else.** All 514 checks, all 25 unit
records, every band, every measured value and every verdict are byte-identical
across two independent GPU runs on two different days — which is the same
determinism claim round 9 made for this file, re-earned rather than inherited.
`commit` now names `d546161`, the commit that contains the art it measured.

## The capture pair — nothing else in the library moved

Three full-library captures, all **d3d11**, all on port **5219**, all into
scratch (the PNG trees are ~40 MB each and are not committed; the three
manifests are, under `manifests/`):

    # after: this tree, the acolyte carrying its crook
    node tools/capture.mjs --out <scratch>/shots-aco-after  --port 5219
    # before: src/entities/EnemyMeshes.js restored to the slice base
    git checkout 125eb19 -- src/entities/EnemyMeshes.js
    node tools/capture.mjs --out <scratch>/shots-aco-before --port 5219
    git checkout d546161 -- src/entities/EnemyMeshes.js     # verified clean before proceeding
    # noise floor: a SECOND capture of this tree
    node tools/capture.mjs --out <scratch>/shots-aco-after2 --port 5219

    node tools/shotdiff.mjs <scratch>/shots-aco-after <scratch>/shots-aco-before  > shot-diff-cross-tree.txt
    node tools/shotdiff.mjs <scratch>/shots-aco-after <scratch>/shots-aco-after2  > shot-diff-noise-floor.txt

Three more runs were added after the first review of this record, to settle the
question the first three could not (below): `shots-aco-before2` and
`shots-aco-before3` on the base tree, `shots-aco-after3` on this one, each with
the same checkout-restore and the same `git status --short` verification. **Six
full captures in all — three per tree — and the runs alternate trees**, so no
noise pair is ever the two runs closest together in time and temporal drift
cannot flatter a control. All six manifests are committed under `manifests/`.

The before-tree is a **checkout-restore of one file**, not a worktree: a fresh
worktree here has no `node_modules` and installing one is forbidden in this
repo's flow. Only `EnemyMeshes.js` differs between the two trees for capture
purposes — `tools/silhouette-metrics.mjs` and the JSON record have no path into
a screenshot — and the restore was verified with `git status --short` before
every following run.

### All six runs agree on every verdict

Identical on all six manifests, byte for byte including the reason strings:

| field | value |
|---|---|
| `subjectFailures` | `[]` |
| `subjectsOk` / `subjectsOkFresh` | true / true |
| `errorCount`, `errors`, `partial` | 0, `[]`, false |
| `skippedShots` | `19-overkill: only-path-enforced`, `20-blight-edge: only-path-enforced` |
| `toleratedAbsences` | the same three shot/reason lines; the embedded `perPx` arrays differ, see below |
| `determinism` | `clockPinned: true`, `frameDt` 1/60, `frameTimeouts: 0` |
| `perf` | 87 programs, 700 geometries, 53 textures, 395 scene objects |

**The pre-registered expectation was the set `{19-overkill}` and the measured set
is empty — because the harness moved, not because the shot got better.** Commit
`82508a7` made `19-overkill` and `20-blight-edge` `onlyPath: true`, so a full run
now *skips* them with a reason in `skippedShots` instead of gating an arrangement
nobody supports and reporting red for it. That change is upstream of this slice
and is identical on both trees. `06-loaded-hud` — the regression this pair was
watching for — is **green on all six runs, with zero cross-tree delta on any
metric it records.**

### Cross-tree against same-tree, per shot

`tools/shotdiff.mjs` has no exit gate, by its own docblock: `capture.mjs` is
deterministic in simulation and not byte-deterministic in output, so a
cross-tree figure means nothing without a same-tree control taken the same
night. Both files are in this directory; the columns are mean channel delta and
the percentage of pixels over a delta of 8.

**One pair of runs could not settle this, so there are six.** The first three
runs (after, before, after2) gave one cross pair and one same-tree control, and
that control read *lower* than the cross pair on five shots — the opposite of
round 9's result on the same harness, and not something an N=1 estimate of a
variance can adjudicate. Three more runs were taken, interleaved the same way
(before2, after3, before3), giving the base tree its **own** noise pair and a
**second, independent cross pair**:

    node tools/shotdiff.mjs <before2> <before3>  > shot-diff-base-noise.txt     # base tree vs itself
    node tools/shotdiff.mjs <after3>  <before2>  > shot-diff-cross-tree-2.txt   # second cross pair

| shot | cross 1 | cross 2 | noise (head tree) | noise (base tree) |
|---|---|---|---|---|
| `04-combat` | 2.241 / 5.04 | **1.325 / 1.06** | 1.670 / 2.39 | 1.859 / 3.24 |
| `08-explosion` | 4.388 / 12.54 | **1.812 / 2.63** | 2.944 / 7.37 | 3.203 / 8.41 |
| `10-inventory` | 2.165 / 4.30 | **1.055 / 0.48** | 1.505 / 1.80 | 1.645 / 2.31 |
| `06-loaded-hud` | 1.387 / 1.48 | **0.934 / 0.27** | 1.117 / 0.67 | 1.179 / 0.84 |
| `11-bestiary` | **1.112 / 0.55** | **1.100 / 0.54** | 1.016 / 0.43 | 1.009 / 0.39 |
| `05-boss` | 0.928 / 0.19 | 0.933 / 0.19 | 0.929 / 0.18 | 0.937 / 0.19 |
| `09-survivors` | 0.959 / 0.17 | 0.968 / 0.17 | 0.960 / 0.17 | 0.953 / 0.16 |
| `12-boss-phases` | 0.904 / 0.17 | 0.913 / 0.16 | 0.913 / 0.17 | 0.901 / 0.15 |
| `03-thirdperson` | 0.953 / 0.02 | 0.957 / 0.02 | 0.952 / 0.02 | 0.957 / 0.02 |
| `02-vista`, `07-interactables`, `13-biomes-1..4` | 0.89-1.03 / ≤0.51 | 0.89-1.02 / ≤0.49 | 0.88-1.03 / ≤0.51 | 0.89-1.00 / ≤0.42 |
| every menu shot (`01`, `14`-`18`) | ≤ 0.224 / 0.00 | ≤ 0.154 / 0.00 | ≤ 0.182 / 0.00 | ≤ 0.186 / 0.00 |
| **aggregate** | **1.012 / 1.224** | **0.768 / 0.322** | **0.865 / 0.688** | **0.895 / 0.802** |

**`06-loaded-hud` and `08-explosion`: variance, and the record now says so
rather than hedging.** The first cross pair put them 1.24x and 1.49x above their
control. The second cross pair puts them *below* both controls — `06` at 0.934
against noise arms of 1.117 and 1.179; `08` at 1.812 against 2.944 and 3.203 —
and the base tree's own noise pair reads *higher* than the head tree's on both
shots. Two runs of one tree differ more than the two trees differ, which is
round 9's finding reproduced. The same flip covers `04-combat` and
`10-inventory` at the whole-frame level: cross 2 is under every control. The
excess in the first pair was the shutter phase of a particle system, not the
staff, and the aggregate agrees — **0.768 cross against 0.865 and 0.895 noise**.

**`11-bestiary` is the exception, and it is the one that should be.** It is the
only shot whose cross-tree excess *reproduces*: 1.112 and 1.100 across two
independent cross pairs, against 1.016 and 1.009 across two independent noise
pairs. It is also the only static, particle-free scene with a proven acolyte in
it — a lineup of the whole roster at 19 m with nothing moving. A signal that
survives both noise arms in the one shot that can hold still is the staff.

### The attribution the manifests can make

The whole-frame mean is the blunt instrument here; the manifests are the sharp
one. Partitioning every leaf of the six committed manifests (paths and timings
excluded) into *deterministic cross-tree* — all three head runs equal, all three
base runs equal, and the two differing — versus *within-tree wobble*:

```
DETERMINISTIC CROSS-TREE : 63 leaves, in exactly three shots
WITHIN-TREE WOBBLE       : 32 leaves
06-loaded-hud, 08-explosion : zero deterministic cross-tree leaves; 08 also zero
                              within-tree wobble, 06 carries exactly one wobble leaf
                              (subject.checks[1].perSep[5], 0.63 on one of three head
                              runs vs 0.65 elsewhere) - more head-tree noise, which
                              reinforces the variance verdict rather than weakening it
```

The change's entire measurable footprint across the shot library is **the
acolyte and the two objects it now geometrically touches.**

| shot | subject | before → after (all three runs each side) | mechanism |
|---|---|---|---|
| `04-combat` | `i:13` **acolyte** | px 1002 → **1176** (+17.4 %); box top 0.454 → 0.398, right 0.711 → 0.720; `sepP50` 0.29 → 0.31 | the staff |
| `04-combat` | `i:14` **sentinel** | px 1334 → **1276** (−58, −4.3 %); `legible` 0.786 → **0.780**; `sep` 0.366 → 0.361; centroid 0.642,0.416 → 0.639,0.414 | **occlusion.** The sentinel stands at `d` 14.7, *behind* the acolyte's 12.2, and its box `[0.401,0.013,0.726,0.598]` and centroid both fall inside the acolyte's grown box `[0.639,0.398,0.720,0.620]`. Its own box, distance and world position did not move by any amount — it lost a sliver of silhouette to a taller neighbour |
| `04-combat` | the horde, aggregate | px 10304 → **10420** (+116); `legible` 0.844 → 0.841 | +174 acolyte, −58 sentinel. **The arithmetic closes exactly**, which is the cleanest statement available that nothing else in that frame moved |
| `11-bestiary` | `i:14` **acolyte** | px 722 → **885** (+22.6 %); box top 0.357 → 0.287, right 0.828 → 0.847; `sep` 0.561 → **0.504**, `legible` 0.932 → **0.852** | the staff — and see below, this one is a cost |
| `11-bestiary` | `i:9` **charger** | px **unchanged** at 2300; `sep` 0.648 → 0.643; `bgLum` 13.0 → 13.3; `legible` 0.977 → 0.976 | **background-ring overlap.** The charger's box `[0.768,0.476,0.916,0.698]` intersects the acolyte's grown box over `x [0.768,0.847] × y [0.476,0.528]`, so the ring the separation metric samples around the charger now contains a little more acolyte and a little less ground. No pixel of the charger itself was taken |
| `11-bestiary` | the roster, aggregate | px 26218 → **26373** (+155) against the acolyte's +163; `legible` 0.954 → 0.952 | the 8-pixel shortfall is neighbour overlap in the union mask |
| `10-inventory` | the equipment blast | `legible` 0.881 → **0.880** — the single leaf | one more occluder inside a screen-covering effect |

**Two gated subjects other than the acolyte moved, and both moved the wrong
way.** The sentinel is 4.3 % less silhouette and 0.006 less legible; the charger
is 0.005 less separated. Neither is near any bar and neither is a capture-gate
failure — every subject check on every one of the six runs is green — but this
is a readability record, and a second monster losing a sliver of its outline to
a new staff is a readability consequence in the same currency the rest of this
document is written in. It is the price of the crook, it is small, and it is
here rather than left for a reader's own diff to find.

**The acolyte's own bestiary legibility fell too**, 0.932 → 0.852, and that is
not occlusion but the same overlap seen from the other side: the taller mask now
reaches into its neighbours' backgrounds, so `sep` drops even as `px` rises — and
partly the staff's own pixels: it carries the `dark` slot, and the subject's
median luminance fell 65 → 61 as its background's rose 14 → 17. At 19 m in a
lineup this is the crowded end of the trade. The gate that grades this
roster measures each unit alone in an orthographic box and reads the change the
other way — `px40 acolyte` 737 → 883 — so both numbers are true and they answer
different questions: *is there enough of it* versus *is it standing clear of the
thing beside it*.

**What the six runs also refute.** A three-run read had suggested three more
cross-tree deltas; the base tree's own repeats show they are not.
`07-interactables` px 6515 → 6518 and `10-inventory`'s blast px 95233 → 95238
appear on the *base* tree too (`before2`/`before3` read 6518 and 95238), and
`05-boss`'s survivor `sep` 0.651 → 0.653 wobbles inside both trees. Three runs
were enough to see a difference; six were needed to know which tree it belonged
to. `10-inventory`'s blast `carriedPx` is the honest borderline case: 83809
three times on this tree against 83900 / 83900 / **83905** on the base one, so
the −91 is real and the base tree's own spread on it is 5.

**And the reading that would have been alarming is affirmatively refuted, not
merely unobserved.** This harness has a *measured* signature for a displaced RNG
stream: `tools/capture.mjs:191-195` records re-seating `04-combat`'s monsters as
**19,488 → 57,049 px**, and `src/systems/VFX.js:2689-2699` records a numeral-only
change re-jittering `fxRng` as **21,486 → 56,735 px on this exact `10-inventory`
blast**. Measured here: that blast moves **5 px** and `04-combat`'s horde **116**,
of which 174 is the acolyte itself and −58 the neighbour it now stands in front
of. Four orders of magnitude below the known signature, and the wrong shape.
`src/entities/EnemyMeshes.js` contains no `Math.random` and imports no RNG; the
merge is a pure matrix bake. Every enemy's `d`, `sx`, `sy`, `at` and `box` in
both enumerated shots is byte-identical cross-tree **except the acolyte's own
box** — nothing was re-seated.

## What did **not** change

| claim | covering evidence |
|---|---|
| no gameplay card moved | `git diff 125eb19 d546161 -- src/` touches **one file, `EnemyMeshes.js`, +9 lines**. `src/data/enemies.js` is untouched: same health, damage, `attackRange 18`, `maxAlive 2`, `packMax 2`, `behavior: 'support'` |
| no damage or draw-order consequence | `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` at `d546161` moves exactly the two pre-adjudicated `lemurian`→`skink` id-rename fields and nothing else; `npm run gate:elite` reads `no fields moved` |
| no animation moved | the acolyte is the one rig in the roster with no per-frame IK at all (`src/entities/EnemyMeshes.js:2820`); the staff is static geometry in the robe group, not a bone |
| no draw call was added | all six capture manifests read **700 geometries, 87 programs, 53 textures, 395 scene objects** — identical on both trees. The three primitives went into the *existing* `aco.robe` merge, so one merged geometry got bigger and the count did not move. A staff parented as its own mesh would have shown here |
| the gate itself was not loosened | no `READABILITY` threshold was touched; the exemption list went 19 → 18 by deletion. `tests/readability-gate.test.mjs` re-grades the committed record against the live list on every `npm test` and agrees |

## Honest limitations

**One pose, one angle** — round 9's own caveat, and it still binds. Every rig in
the gate is settled 150 steps at 1/60 into its idle at zero speed and turned
0.24 rad off-axis. The 0.5551 is that pose. The acolyte's **attack windup is
unmeasured**: `support` behaviour animates the arms, the crook is fixed to the
robe group and travels with the body rather than with a hand, and nothing here
says what the pair reads during a cast. It is the same blind spot the exemption
had before, neither widened nor closed.

**Only two shots in the library are proven to contain an acolyte.** `04-combat`
(**1 of 24** gated horde members, `i:13`) and `11-bestiary` (**1 of 19**
enumerated roster objects, `i:14` — 19, not the gate's 25, because the lineup
check counts what it can see) name enemies by id in their manifests. The other
fight shots (`05-boss`, `06-loaded-hud`, `08-explosion`, `10-inventory`,
`12-boss-phases`) draw from the full `SPAWN_CARDS` pool through the shared RNG
stream and record no per-enemy ids, so this record does **not** claim to know
whether one is in frame. What it does know is that the draw is seed-fixed and
mesh construction consumes no RNG, so whatever those scenes contain, they
contain the same monsters in the same places on both trees — and that `06` and
`08` carry zero cross-tree delta on every metric they *do* record. The permanent
fix is to give those checks the same per-object `DIAG` enumeration `04-combat`
and `11-bestiary` already have; that would retire this caveat for every future
art slice rather than for this one, and it is not this slice's to build.

**The 0.5551 is one number from one instrument.** `familyIoU` compares
bbox-normalised flat masks; it cannot see colour, and the acolyte's teal accent
is half of how it actually reads on screen. The gate says the two shapes are no
longer the same shape. Whether a player at 40 m in a fight tells a Grave Acolyte
from a Brood Sac is a playtest question, and this record does not answer it.

**Six runs is enough to adjudicate this change and not enough to characterise
this instrument.** Three per tree, ~2 minutes each, one machine, one night. Two
noise pairs are enough to show that the first cross pair's excess on `06` and
`08` did not survive replication; they are not enough to state a noise
*distribution*, and the two arms here already differ from each other (aggregate
0.865 against 0.895) and from `reviews/round9/README.md`'s table on the same
harness. No number from any of these tables should be quoted as *the* noise
level of `tools/shotdiff.mjs`. What can be quoted is the manifest layer, which
across six runs put **zero** wobble on any `px` count in the two enumerated
shots and reproduced all 63 cross-tree leaves three times on each side.

**The record's `commit` field is a convention, not an invariant.**
`reviews/round9/readability-gate.json` names `d546161` while living at a later
commit, deliberately — that is the tree whose art the GPU run measured — but
`tests/readability-gate.test.mjs:180` only asserts the field is a string of
seven characters or more. Nothing mechanical will notice if a future
regeneration leaves it naming a tree whose art has moved. Until something does,
this paragraph and the round-9 record table are the only things holding the
field to its meaning.
