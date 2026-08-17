# Axis 5 (material believability) — re-score against current master

Issue #100. Supersedes round 6's axis-5 score, which was taken against `1541fc9`,
75 minutes before `b09c3d4` ("World: reflections finally contain the world").

## Rubric

`RUBRIC.md:16`, unchanged and used verbatim:

> **5 — Material believability.** Pass: surface variation, roughness contrast between
> rock/metal/organic, real specular response. Fail: uniform matte plastic on every surface.

Scored 0-10 per shot, "clears 7" as the pass bar, matching round 6's phrasing
(`reviews/round6/critic-r4-world.md:295`). Round 6 split the axis into four parts —
(a) material identity, (b) the PMREM premise, (c) detail starvation, (d) no metal —
and this re-score answers the same four so the two are comparable.

## Instrument

`reviews/round6/tools-stages/png.mjs` reused verbatim for decoding and luma; MED
reimplemented from the same file; PEAK and NYQ reimplemented from round 6's stated
formulas (`critic-r4-world.md:§0`). Calibrated against round 6's published selftest
table before use:

```
flat 128               MED 0.000%  PEAK 0.000%  NYQ 0.00
ramp 0..255            MED 0.000%  PEAK 0.000%  NYQ 0.00
step edge              MED 0.000%  PEAK 0.000%  NYQ 0.00
1-in-100 px +60        MED 1.020%  PEAK 1.020%  NYQ 3.03   (round 6: 1.020 / 1.020 / 3.02)
1-in-100 px +20        MED 0.000%  PEAK 0.000%  NYQ 1.01
1px vlines every 10    MED 9.596%  PEAK 0.000%  NYQ 0.00   (round 6: 10.101, border handling)
3x3 blocks every 12    MED 2.669%  PEAK 0.000%  NYQ 2.45   (round 6: 2.675 / 0.000 / 2.44)
```

Source frames: a single **full** `node tools/capture.mjs --port 5251` run on this
branch. `ready: true`, `partial: false`, `subjectsOk: true`, `subjectFailures: []`,
`errorCount: 0`. `19-overkill` / `20-blight-edge` skipped only-path-enforced, as in
every full run. Recorded with `node tools/gates.mjs status --record capture`.

**What the instruments cannot see, stated up front.** `tools/silhouette.mjs` renders
through a flat-black `overrideMaterial` and is blind to materials and reflections
entirely — none of its output is evidence here. The capture gate's `subjectsOk` is a
presence-and-separation check, not a material check; its green says nothing about this
axis. Two of round 6's fixed ROIs no longer land on their subjects (below), and where
that is true the number is discarded rather than reported.

## Measurements (fresh full capture)

| shot | ROI | px | uniq luma | HF sd | NYQ | clip255 |
|---|---|---:|---:|---:|---:|---:|
| `07-interactables` | chest body 600-1050 x 560-820 | 117 000 | **220** | 34.15 | 1.131 | 0.253 % |
| `07-interactables` | background 60-500 x 100-380 | 123 200 | 190 | 29.24 | 1.436 | 0.000 % |
| `02-vista` | right cliff 900-1500 x 520-880 | 216 000 | 253 | 23.58 | 2.366 | 0.364 % |
| `13-biomes-1` | hero arch 660-1000 x 140-480 | 115 600 | 228 | 38.47 | 3.205 | 0.005 % |
| `13-biomes-1` | mesa top 520-880 x 540-620 | 28 800 | 219 | 38.87 | 3.238 | **1.601 %** |

ROI validity: `07`'s chest ROI is confirmed on-subject — the manifest records the
interactable's bbox as `[0.349, 0.439, 0.651, 0.95]`, i.e. x 558-1042 y 395-855 at
1600x900, which contains the ROI. **`13-biomes-4`'s two round-6 ROIs are discarded**:
the containers have moved right of x 700 and the `330-700 x 600-700` box now lands on
terrain, and `150-450 x 200-330` lands on the left mesa and sky rather than the far
ridge. Those two rows are judged from pixels, not from a stale box.

## Findings against round 6's four parts

**(a) Material identity — still the axis's one genuine win, and it has widened.**
The b1 hero arch holds running-bond masonry at NYQ 3.205 with mortar shadow, distinct
from the mesa beside it. Round 6's read survives.

**(b) The PMREM premise — refuted, and the fix is visible in pixels, not just source.**
`bakeProbe` (`src/world/Environment.js:558`) calls `_pmrem.fromScene(scene, 0.05, 0.5,
2000, {position: center})` at `:585` against the real scene, excluding only the dust
motes and re-centring the sky dome on the probe. Reflections now contain world geometry.
Round 6's "sky-only gradient" finding is dead and no purchase follows from it.

**(c) Detail starvation — materially improved, no longer the dominant defect.**
The chest went from **67 unique luma / HF sd 1.82 / NYQ 0.708** to **220 / 34.15 /
1.131** on the same ROI. Round 6's headline statistic — a 5.5x high-frequency ratio
pointing the wrong way (chest 0.708 vs its background 3.879) — is now **1.27x**
(1.131 vs 1.436). The hero prop is still marginally flatter than its backdrop, so the
ratio still points the wrong way, but it is a rounding error beside round 6's figure.
The world-space triplanar relief block (`src/world/Materials.js:256-263` and following)
is the plausible cause: detail resolved in metres rather than texels.

**(d) There is still no metal. Unchanged since round 3, and this is now the leg.**
`13-biomes-4`'s shipping containers read as uniform matte red-orange paint: no
specular lobe anywhere on them, no roughness break along the 2.30 m panel seams, only
faint AO at the corners. Authored `metalRuin metalness 0.56 / roughness 0.34`.
Metalness kills the diffuse and a 0.34-roughness GGX lobe spread over a 3-10 px facet
never resolves as a highlight, so the result is a colour. Round 6's verify line — a
specular lobe with >=25 luma peak-to-plateau contrast plus a seam roughness break —
is still missed.

**(e) New, and not in round 6's split: the lowest rung is still screaming, and now it
is the loudest material defect in the build.** `07`'s ground plane is a hard-clipped
gold specular crinkle that reads as crumpled foil rather than wet rock; b1's mesa top
carries **clip255 1.601 %**, the highest figure measured here. This is the
`wetStone roughness 0.045` near-mirror rung reflecting a 15x sun disc. Making the
probe contain the world did not tame it — it gave the same over-bright rung more to
reflect.

## Score

```
AXIS 5: 6 on 13-biomes-1 (hero arch), 5 on 07-interactables and 02-vista,
        4 on 13-biomes-4 (the containers). Does not clear 7 anywhere.
VERDICT: FAIL
```

Round 6 scored this axis at "tops out at 6 on `13-biomes-1`, does not clear 7
anywhere". **The score is unchanged — but the composition of the failure has
inverted.** In round 6 detail starvation was the asset-shaped half and "no metal" was
a secondary code defect. On current master detail starvation has largely closed in
code, and what holds the axis under 7 is specular behaviour at both ends of the
roughness ladder: no lobe at all on the metal, and a blown, clipping lobe on wet stone.

## Answers to #100

- **Does axis 5 still fail on current master?** Yes, at 4-6 against a bar of 7.
- **Is the remaining leg detail starvation?** **No.** That was the leg #80 carried
  forward, and it is the half that has actually moved: the chest's wrong-way HF ratio
  fell from 5.5x to 1.27x. The remaining leg is **specular response** — defects (d)
  and (e) — and both are code, in `src/world/Materials.js`.
- **Consequence for spend.** The carried-forward justification for a PBR texture set
  (`ART-ASSETS.md:130-134`) rested on the 67-unique-luma chest, and that measurement
  no longer reproduces. Nothing measured here is answered by buying a texture set, and
  the ~$500 envelope stays untouched. The free answers already delivered in
  `terrain-pbr.md` and `prop-pbr.md` are not urgent either.
- **Recommendation.** Two code fixes, both previously specified and never landed:
  a roughness drop plus an anisotropic seam break on `metalRuin`, and a floor under
  `wetStone`'s roughness (or a cap on its env intensity) so the lowest rung stops
  hard-clipping. Re-score after those, not after a purchase.
