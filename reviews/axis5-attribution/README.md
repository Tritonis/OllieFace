# Issue #107 — the clipping mesa-top pixels belong to the `sand` rung

`13-biomes-1`'s mesa-top ROI (`x520-880 y540-620`, the box
`reviews/axis5-specular/measure.mjs` uses) clips at ~1.60%. This run attributes those
pixels to a named material rung.

**Answer: `sand`** — the shared library's sand rung, `0xead093` at
`roughness 0.94 / metalness 0.00 / envMapIntensity 0.60` (`Materials.js:1166`, the
*base* tune: Cindergrass Flats declares no `sand` entry in its `matTune`, so this rung
is the one rung on the mesa running entirely un-retuned). It reaches the frame through
the slab prop kit (`Props.js:990`, `M.sand`, ochre's `slabs: 90`), which is what the
mesa caps are built from.

Not the terrain material (that is the `0xffffff` vertex-coloured rung, and blacking it
moves clip255 by 0.024pp while dropping ROI mean luma 82.3 -> 70.0 — a large area that
owns almost none of the clipping). Not `wetStone`, which Cindergrass Flats does not
even retune. Both of those were already ruled out by #102's `rMin` probe; this run says
what the answer *is*.

## Method

`rung-blackout.mjs`. One page boot, one composed `biomeVista({ index: 0 })` frame, then
every distinct material instance in the scene is blacked out in turn (albedo 0,
roughness 1, metalness 0, `envMapIntensity` 0, all maps and emissive removed), re-rendered
and re-shot. A blackened rung still occludes, so each shot is a clean subtraction.

Doing it inside a single boot is the point: the harness is not bit-exact and drifts up to
~0.68% per shot *across* boots, which is larger than most of the deltas below. Within one
boot the camera, seed and stage are the same objects. The run shoots a baseline before the
sweep and another after every mutation is restored; that pair is the measured noise floor.

**These are partial-run numbers** — one scenario, not a full capture. They buy an
attribution and cannot accept a fix.

## Numbers (partial run, one boot, seed 1337)

Stage name read from the running build: **Cindergrass Flats**. `baseline-start` clip255
**1.601%**, which is `reviews/axis5-rescore/SCORE.md:54-55` to three decimals.

| rung blacked out | ROI clip255 | delta |
|---|---|---|
| **`sand` `#ead093` r0.94 m0 env0.60** | **0.038%** | **-1.563pp** |
| `rock` `#b58248` r0.70 m0.04 env1.35 | 1.538% | -0.063pp |
| `#d9dfe8` r0.42 m0.28 (interactables) | 1.569% | -0.031pp |
| `BRASS` `#a8794a` r0.22 m0.72 env2.8 | 1.573% | -0.028pp |
| `terrain` `#ffffff` r0.90 m0.01 env0.85 | 1.576% | -0.024pp (mean luma 82.3 -> 70.0) |
| `IRON` `#4c545f` r0.24 m0.62 env2.6 | 1.580% | -0.021pp |
| `cliff` `#6c5a4c` r0.66 m0.03 env1.22 | 1.594% | -0.007pp |
| ...41 further rungs | 1.538%-1.608% | within +-0.07pp |

Within-boot noise floor: baseline start 1.601% -> end 1.594%, |d| **0.007pp**.

The winning delta is **22x** the next largest and **223x** the measured noise floor. It is
also larger than the ~0.68% cross-boot drift by a factor of 2.3, so the attribution does
not depend on the single-boot construction to survive.

## The barrel (#39, `00b2677`) is in frame and is not the answer

`EquipmentBarrel`'s `BRASS()` (`#a8794a`, 15 meshes) and `IRON()` (`#4c545f`, 21 meshes)
are both present in the composed scene, so the warm-metal candidate was live and was
tested rather than assumed away. Neither owns any of the ROI's clipping pixels
(-0.028pp and -0.021pp). And `baseline-start` reproduces the pre-barrel 1.601% exactly,
so the barrel has not moved this measurement.

## Shot naming

There is no off-by-one to fix. `13-biomes-N` photographs `BIOMES[N-1]`, which is what
the scenario's own doc string says ("biome N of 4"), and the running build confirms it.
#102's error was assuming the opposite. Documented at `tools/capture.mjs` beside the
mapping rather than renamed, since the names are correct.

## Not done here

No remedy. #107 buys the attribution only.
