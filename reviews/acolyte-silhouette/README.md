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

The before-tree is a **checkout-restore of one file**, not a worktree: a fresh
worktree here has no `node_modules` and installing one is forbidden in this
repo's flow. Only `EnemyMeshes.js` differs between the two trees for capture
purposes — `tools/silhouette-metrics.mjs` and the JSON record have no path into
a screenshot — and the restore was verified with `git status --short` before
either after-run.

### The three runs agree on every verdict

| | after | before | after2 |
|---|---|---|---|
| `subjectFailures` | `[]` | `[]` | `[]` |
| `subjectsOk` / `subjectsOkFresh` | true / true | true / true | true / true |
| `errorCount` | 0 | 0 | 0 |
| `skippedShots` | `19-overkill`, `20-blight-edge` (only-path-enforced) | same | same |
| `toleratedAbsences` | the same three lines | same | same |
| `perf` | 87 programs, 700 geometries, 53 textures, 395 scene objects | **identical** | **identical** |

**The pre-registered expectation was the set `{19-overkill}` and the measured set
is empty — because the harness moved, not because the shot got better.** Commit
`82508a7` made `19-overkill` and `20-blight-edge` `onlyPath: true`, so a full run
now *skips* them with a reason in `skippedShots` instead of gating an arrangement
nobody supports and reporting red for it. That change is upstream of this slice
and is identical on both trees. `06-loaded-hud` — the regression this pair was
watching for — is **green on all three runs**.

### Cross-tree against same-tree, per shot

`tools/shotdiff.mjs` has no exit gate, by its own docblock: `capture.mjs` is
deterministic in simulation and not byte-deterministic in output, so a
cross-tree figure means nothing without a same-tree control taken the same
night. Both files are in this directory; the columns are mean channel delta and
the percentage of pixels over a delta of 8.

| shot | cross-tree mean / %>8 | same-tree mean / %>8 | acolyte on screen |
|---|---|---|---|
| `04-combat` | 2.241 / 5.04 | 1.670 / 2.39 | **yes** (1 of 24, `i:13`) |
| `08-explosion` | 4.388 / 12.54 | 2.944 / 7.37 | unknown |
| `10-inventory` | 2.165 / 4.30 | 1.505 / 1.80 | unknown |
| `06-loaded-hud` | 1.387 / 1.48 | 1.117 / 0.67 | unknown |
| `11-bestiary` | 1.112 / 0.55 | 1.016 / 0.43 | **yes** (1 of 25, `i:14`) |
| `13-biomes-3` | 1.025 / 0.51 | 1.026 / 0.51 | unknown |
| `05-boss` | 0.928 / 0.19 | 0.929 / 0.18 | unknown |
| `09-survivors` | 0.959 / 0.17 | 0.960 / 0.17 | unknown |
| `12-boss-phases` | 0.904 / 0.17 | 0.913 / 0.17 | unknown |
| `03-thirdperson` | 0.953 / 0.02 | 0.952 / 0.02 | unknown |
| `02-vista` / `07-interactables` / `13-biomes-1,2,4` | 0.89-0.99 / ≤0.25 | 0.88-0.99 / ≤0.24 | unknown |
| every menu shot (`01`, `14`-`18`) | ≤ 0.224 / 0.00 | ≤ 0.182 / 0.00 | **no** |
| **aggregate** | **1.012 / 1.224** | **0.865 / 0.688** | |

**Read this table honestly.** Round 9's control had every cross-tree figure
*below* its same-tree twin; this one does not. Five shots read above their noise
floor, and they are exactly the five with live particle systems or a monster
field in them — while the six shots with no fight in frame (`01`, `14`-`18`) and
every quieter scene below them (`03`, `05`, `09`, `12`, the biome plates,
`02`, `07`) sit on their controls to two or three decimal places. That pattern is what a
one-monster mesh change should look like, and it is *consistent with* the staff
being the cause; it is not proof, because a single run pair cannot separate an
extra 150 lit pixels from a VFX phase that landed one frame differently. The
instrument that *can* attribute it is the manifest, below.

### The attribution the manifest can make

Two shots enumerate every enemy by id with its own pixel measurement, so the
acolyte's contribution is not inferred from a whole-frame mean. In both, the
two same-tree runs are **exactly equal, to the pixel and to the bounding box** —
a zero noise floor on the one number that matters — and the cross-tree
difference is the staff:

| shot / subject | before | after | after2 | same-tree delta |
|---|---|---|---|---|
| `04-combat`, acolyte px | 1002 | **1176** (+17.4 %) | 1176 | **0** |
| `04-combat`, acolyte bbox top | 0.454 | **0.398** | 0.398 | **0** |
| `11-bestiary`, acolyte px | 722 | **885** (+22.6 %) | 885 | **0** |
| `11-bestiary`, acolyte bbox top | 0.357 | **0.287** | 0.287 | **0** |

The box grows **upward** in both — 5.6 % and 7.0 % of frame height of new
silhouette above where the hood used to end — which is the crook standing clear
of the head, photographed in the game's own camera rather than in the gate's
orthographic box. Neither shot's screen position (`sx`, `sy`, `d`) moved: the
same enemy, in the same place, wearing more.

## What did **not** change

| claim | covering evidence |
|---|---|
| no gameplay card moved | `git diff 125eb19 d546161 -- src/` touches **one file, `EnemyMeshes.js`, +9 lines**. `src/data/enemies.js` is untouched: same health, damage, `attackRange 18`, `maxAlive 2`, `packMax 2`, `behavior: 'support'` |
| no damage or draw-order consequence | `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` at `d546161` moves exactly the two pre-adjudicated `lemurian`→`skink` id-rename fields and nothing else; `npm run gate:elite` reads `no fields moved` |
| no animation moved | the acolyte is the one rig in the roster with no per-frame IK at all (`src/entities/EnemyMeshes.js:2820`); the staff is static geometry in the robe group, not a bone |
| no draw call was added | all three capture manifests read **700 geometries, 87 programs, 53 textures, 395 scene objects** — identical on both trees. The three primitives went into the *existing* `aco.robe` merge, so one merged geometry got bigger and the count did not move. A staff parented as its own mesh would have shown here |
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
and `11-bestiary` enumerate enemies by id in their manifests; the other fight
shots (`05-boss`, `06-loaded-hud`, `08-explosion`, `10-inventory`,
`12-boss-phases`) draw from the full `SPAWN_CARDS` pool through the shared RNG
stream and record no per-enemy ids, so this record does **not** claim to know
whether one is in frame. What it does know is that the draw is seed-fixed and
mesh construction consumes no RNG, so whatever those scenes contain, they
contain the same monsters in the same places on both trees.

**The 0.5551 is one number from one instrument.** `familyIoU` compares
bbox-normalised flat masks; it cannot see colour, and the acolyte's teal accent
is half of how it actually reads on screen. The gate says the two shapes are no
longer the same shape. Whether a player at 40 m in a fight tells a Grave Acolyte
from a Brood Sac is a playtest question, and this record does not answer it.

**The capture pair is one pair.** Three runs of ~2 minutes each on one machine
on one night. The same-tree control is what makes the cross-tree column
readable at all, and it is a single control — `reviews/round9/README.md`'s own
noise-floor table, taken on the same harness, disagrees with this one by enough
that neither should be quoted as *the* noise level of this instrument.
