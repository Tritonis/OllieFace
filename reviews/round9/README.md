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
that. Anything new, and anything that degrades, is red.

Re-run the command after any change to `src/entities/EnemyMeshes.js`,
`src/data/enemies.js` or the elite table.

## What the committed record is

| Field | Value | Why it is here |
|---|---|---|
| `renderer` | `d3d11` | The real adapter, not SwiftShader. `tools/silhouette.mjs --software` produces a record marked `swiftshader`; two records from different renderers are not directly comparable and a reader diffing them needs to know that before concluding the roster moved. |
| `commit` | `c363868` | The tree whose art was measured. This task changed only `tools/` and `tests/` — nothing under `src/` — so the geometry in this record is exactly `src/` at `c363868`. |
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
