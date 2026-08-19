# Capture legibility: 08-explosion and 10-inventory

Four FULL capture runs plus a same-boot control, 2026-08-19, against master `a562d26`. The staging
changes they tested were **not merged**; this directory is the evidence and the diagnosis. Every
number below is from a FULL run — no `--only` run was used, and none can accept or reject anything
here.

## The manifests

| file | what it is |
|---|---|
| `baseline-master-a562d26.json` | master, unmodified. The reference. |
| `control-unmodified-same-boot.json` | master again, same boot, changes stashed. Proves the deltas below are real and not cross-boot drift. |
| `after-run1-ring-widened.json` | 08-explosion ring widened to 0.24 x 0.11. **Refuted.** |
| `after-run2-arc.json` | 08-explosion victims on a 150-degree arc, plus 10-inventory ring 0.34. |
| `after-10inv-only.json` | 10-inventory ring 0.34 alone, 08-explosion reverted. The isolation run. |
| `after-10inv-wider.json` | 10-inventory ring 0.42. **Refuted.** |

Read them with `node tools/margin-survey.mjs <path>`.

## What was established

**1. 08-explosion is fixable, and by a large margin — but not safely.**

Sorted by bearing, the baseline splits cleanly. Victims outboard of the fireball read `sepP50`
0.71-0.95; victims over the plume read 0.15-0.37. `cos(a) > 0` is outboard of the fireball at screen
x 0.666; `cos(a) < 0` is over the plume, where the object's own pixels *are* the plume's pixels, so
the difference frame has nothing to find.

Seating the whole cast on the readable arc took the shot from **0.15 to 0.73** (`after-run2-arc`).
That also removes the #122 gated-set trap rather than dodging it: with no member over the plume,
there is no bad member for the pixel-count ranking to promote.

**Refuted first attempt:** merely widening the circle to 0.24 x 0.11 lifted object i=3 to 0.21 but
dropped it out of the gated set (374 -> 104 px), which promoted i=5 — also inboard — and the shot
stayed at exactly 0.15. Fixing the measured object is not the same as fixing the shot.

**Why it was not merged:** reseating 08-explosion's victims perturbs shots downstream of it.
08-explosion runs at `execIndex` 15; `11-bestiary` (16) went 0.25 -> 0.23 and became a floor failure
rather than a margin one, and `06-loaded-hud` (18) went **0.35 -> 0.15**, turning a green shot red.
This is #114's first defect. Both regressions appeared under two entirely different 08 stagings, so
the leak is structural to reseating that cast at all.

**2. The leak is solely 08-explosion's.**

`after-10inv-only` reverts 08 and keeps only the 10-inventory ring: `06-loaded-hud` returns to
**0.35**, `11-bestiary` to **0.25** with `objectFailures: []`, `04-combat` to 0.25, and every other
subject lands within 4 px of baseline. Nothing else in the run leaks this way.

**3. 10-inventory is NOT fixable by the ring.** Response curve, three FULL runs:

| ring radius | i6 `sepP50` | shot `worstGatedSep` |
|---|---|---|
| 0.26 x 0.11 (shipped) | 0.19 | 0.19 |
| 0.34 x 0.17 | 0.21 | 0.21 |
| 0.42 x 0.21 | 0.19 | **0.17** |

The curve turns over. A linear fit through the first two points predicts 0.23 at 0.42 and puts the
radius needed for 0.27 at **0.58 — wider than the frame**; the measured value came in below even
that prediction.

Two independent reasons 0.34 is where the constant stops:

- **Seating validity.** At 0.42, five of eight victims took the blind world-space fallback, including
  both gated objects — `groundAtScreen` finds no ground that far out within `maxDist: 30`. Past
  roughly 0.34 the ring is no longer what places the pack, so any score earned out there describes a
  different photograph.
- **Composition.** At 0.42 the subject box spread to `[0.051, 0.38, 0.845, 0.802]` and `bgLum` rose
  to 64.8 against subject `lum` 50. The pack is flung to the frame edges and is darker than its
  surround. That is no longer monsters standing in a loaded inventory scene.

**What actually limits it:** not radius. i6 and i7 are the bodies nearest the player's own screen
column, and their background is the nova's own near volume. Moving them out in screen space moves
them further away in depth, where the nova is brighter still and their pixel share shrinks. The
signature is `lum 50` against `bgLum 64.8` — the subject is darker than what it stands in, so the
difference frame finds little regardless of where on the ground it sits. The remaining levers are the
nova's own render or the shutter, and the shutter is a documented, measured decision that was not
re-litigated here.

## Also recorded

`after-run2-arc`'s 10-inventory reading of 0.39 was **contaminated and is not attributable to the
ring**. 10-inventory inherits its backdrop from `06-loaded-hud`'s late-run state, and 06 was itself
perturbed by the 08 change in that same run. The isolation run is what caught this; the honest
ring-only figure is 0.21.

`04-combat` and `11-bestiary` were deliberately out of scope throughout: both sit at exactly 0.25,
clearing the 0.25 floor and failing only the 0.02 margin.
