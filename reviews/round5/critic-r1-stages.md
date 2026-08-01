# PETRICHOR — Round 5, critic 1: STAGES / LIGHTING / MATERIALS

Domain: axes 1 (lighting & shadow), 2 (composition & depth), 3 (colour & grade),
5 (material believability), 10 (cohesion). All ten scored per the rubric's verdict format.
Reference target: Risk of Rain 2 — Titanic Plains / Abandoned Aqueduct / Rallypoint Delta /
Abyssal Depths.

Shots judged: `13-biomes-1..4`, `02-vista`, `07-interactables` (seed 1337, 1600×900).

**Manifest check.** `shots/manifest.json`: `ready: true`, `errors: []`, `partial: false`.
All six judged shots report `frameErrors: 0`, `lastFrameError: null`, `newErrors: []`.
**No crash to report.** Scoring proceeds on the pixels.

Every figure below is decoded from the PNGs with a hand-written decoder (Node `zlib` +
Paeth/Sub/Up/Average unfilter). Luminance is `L = 0.2126R + 0.7152G + 0.0722B` on
sRGB-encoded 8-bit values. **`tools/capture.mjs` was not run. No project file was modified.**
Source was read for `file:line` attribution only.

---

## 1. Axis scores

| # | Axis | b-1 mesa | b-2 canyon | b-3 cavern | b-4 works | 02-vista | 07-inter |
|---|------|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | Lighting & shadow | 6 | 6 | 6 | 6 | 5 | 5 |
| 2 | Composition & depth | 6 | 5 | 5 | 6 | 3 | 4 |
| 3 | Colour & grade | 7 | 6 | 5 | 5 | 4 | 5 |
| 4 | Silhouette & form | 6 | 5 | 5 | 6 | 5 | 4 |
| 5 | **Material believability** | **5** | **5** | **5** | **5** | **4** | **3** |
| 6 | VFX quality | 4 | 4 | 4 | 4 | 4 | 3 |
| 7 | UI/HUD craft | 8 | 8 | 8 | 8 | 7 | 7 |
| 8 | Readability under load | 6 | 5 | 5 | 5 | 5 | 6 |
| 9 | Post-processing | 8 | 5 | 7 | 4 | 6 | 7 |
| 10 | Cohesion | 7 | 7 | 6 | 6 | 5 | 4 |
| | **mean** | **6.3** | **5.6** | **5.6** | **5.5** | **4.8** | **4.8** |

```
13-biomes-1       AXIS SCORES: 1:6 2:6 3:7 4:6 5:5 6:4 7:8 8:6 9:8 10:7   VERDICT: FAIL
13-biomes-2       AXIS SCORES: 1:6 2:5 3:6 4:5 5:5 6:4 7:8 8:5 9:5 10:7   VERDICT: FAIL
13-biomes-3       AXIS SCORES: 1:6 2:5 3:5 4:5 5:5 6:4 7:8 8:5 9:7 10:6   VERDICT: FAIL
13-biomes-4       AXIS SCORES: 1:6 2:6 3:5 4:6 5:5 6:4 7:8 8:5 9:4 10:6   VERDICT: FAIL
02-vista          AXIS SCORES: 1:5 2:3 3:4 4:5 5:4 6:4 7:7 8:5 9:6 10:5   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:5 2:4 3:5 4:4 5:3 6:3 7:7 8:6 9:7 10:4   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Not one of the
six shots clears a single one of my five domain axes on every frame. Axis 5 does not reach 6
anywhere.

**`02-vista` has regressed hard against round 4** (6.6 → 4.8). Round 4 scored it 2:7 3:7 5:7;
it is now 3 / 4 / 4. The regression is measured in §3.

### What is genuinely good — do not break it

- **The four biomes are four places, not four palettes.** This is the wave's real win and it
  is not a marginal one. Sat-weighted 24-bin hue-histogram L1 distance (max 2.0) over the
  world band y 180–820: b1↔b2 **1.711**, b2↔b4 **1.736**, b1↔b3 **1.462**, b3↔b4 **1.438**,
  b2↔b3 **1.359**. Terrain profile, prop kit and landmark differ independently of colour: a
  flat-capped mesa + freestanding arch; a column forest under sheer walls; a spiked field
  under a boulder; a terraced yard under a crane. **Q1 answered: they do not collapse.**
- **The key light is committed and its shadow colour is real.** Same-surface terminators:
  b3 boulder **4.74:1** with a **159°** hue rotation, b1 mesa tower **3.52:1** / 67°,
  07 background wall **3.80:1** / 73°, 02 monolith **2.82:1** / 141°, b4 terrace **2.79:1** /
  112°. Every shadow probe in all six frames rotates from a 4–34° amber key into a 200–330°
  violet ambient. Round 4's axis-1 win is retained on props.
- **b4's crane is the best landmark in the build.** A true black-silhouette read against sky,
  placed on the frame's vertical third, with articulated lattice. It anchors the frame.
- **b2 is the only shot with real aerial perspective.** near L58 s0.38 → mid L64 s0.34 → far
  L132 s0.15; median terrain-vs-sky |ΔL| at the detected skyline is **7.5 luma**. That is
  Abandoned Aqueduct behaviour and the other five shots should copy it.
- **b1's arch carries a genuine chiselled normal map** — the single best material surface in
  the build, and proof the map pipeline works when it is actually applied.
- **Post is clean where it is clean.** Clipped white 0.014% in every shot (that figure is the
  teleporter core alone); no banding; sky gradients dithered.
- **HUD is untouched and still the most confident authorship in the product.**

---

## 2. AXIS 5 — the four-round defect. The claim is REFUTED.

The wave claims a per-biome roughness tuning block (`src/world/Materials.js:490-514`
`MAT_TUNE_BASE`, per-biome `matTune` from `:567`, applied at `:870` `m.envMapIntensity = t.env`)
fixes "uniform matte plastic on every surface". **It does not. The defect is not merely
present, it is the dominant condition of every frame.**

### Method

For every 24×24 tile outside the HUD and outside sky, I compute the high-pass residual sd
(tile luma minus its own 9×9 box blur). This isolates surface detail — roughness break,
albedo mottle, normal-map grain — from both flat shading and geometry edges. A tile is
counted as *single-surface* when its intra-tile luma range is < 20 (no hard facet edge inside
it), so the measure describes **material**, not silhouette. The film-grain noise floor,
measured on flat sky in each shot, is HF sd **0.58–1.64**.

### Result

| shot | single-surface tiles | **texture-free (HF < 1.3)** | textured (HF ≥ 2.5) |
|---|---:|---:|---:|
| 13-biomes-1 | 37.8% of world | **79.9%** | 3.9% |
| 13-biomes-2 | 21.2% | **77.9%** | 2.6% |
| 13-biomes-3 | 25.6% | **75.0%** | 1.8% |
| 13-biomes-4 | 45.1% | **72.8%** | 6.5% |
| 02-vista | 65.6% | **85.6%** | 1.3% |
| 07-interactables | 60.6% | **91.5%** | 2.4% |

**Between 73% and 92% of every unbroken surface in the shipped frames carries no
high-frequency detail whatsoever — at or below the film grain that is laid over the whole
image.** Between 1.3% and 6.5% carries measurable surface texture. That is the rubric's
four-point description verbatim.

### Named surfaces, 45×45 px patches entirely inside one surface

| shot | patch | mean L | sd | HF sd | **distinct luma values in 2,025 px** |
|---|---|---:|---:|---:|---:|
| 07 | sky (grain floor) | 38.7 | 9.63 | 1.641 | 50 |
| 07 | **CHEST body front** (800,690) | 55.7 | 1.45 | **0.666** | **8** |
| 07 | CHEST body side-lit (950,660) | 55.6 | 1.51 | 0.656 | 10 |
| 07 | GROUND purple lit (1300,450) | 79.9 | 2.78 | 0.834 | 14 |
| 07 | GROUND shadow (250,620) | 49.6 | 0.92 | 0.852 | 6 |
| 02 | sky (grain floor) | 82.6 | 1.03 | 0.605 | 6 |
| 02 | **CLIFF right** (1200,600) | 27.7 | 1.00 | 0.971 | **6** |
| b1 | sky (grain floor) | 93.0 | 3.85 | 0.584 | 17 |
| b1 | **CLIFF face lit** (620,700) | 67.1 | 1.96 | 0.927 | **14** |
| b2 | sky (grain floor) | 130.4 | 5.61 | 0.758 | 25 |
| b2 | **WATER pool** (1000,830) | 34.4 | 2.10 | **1.010** | **13** |
| b3 | GROUND lilac shadow (250,780) | 55.9 | 1.84 | 0.887 | 18 |
| b4 | **MTN left dark** (200,400) | 46.1 | 1.26 | 0.842 | **11** |

The chest body and 07's ground are **flatter than the sky**. Their HF residual (0.67, 0.83)
is below the sky's own grain (1.64). The renderer is putting more variation into empty air
than into the objects.

### Q4 answered, bluntly

**There is no roughness contrast between rock, metal, organic and water. It is uniform matte
plastic, and it has now survived five rounds.** Specifically:

- **Water does not read as water.** `13-biomes-2` is documented as "flooded channels" and
  titled *Drowned Aqueduct*. Its water is an opaque plane at HF sd 1.010, sd 2.10, **13
  distinct luma values**, with no specular lobe, no reflection of the columns standing in it,
  no ripple normal and no depth attenuation. `Materials.js:509` authors `wetStone` at
  roughness 0.12 / env 2.40 — none of that reaches the pixels.
- **Metal does not read as metal.** `13-biomes-4` is the industrial biome. Its containers
  measure sat 0.52 hue 353° with no specular break; `Materials.js:510` authors `metalRuin` at
  roughness 0.20 / metalness 0.78 / env 2.80. The only metal highlight anywhere is 02-vista's
  monolith at RGB(255,255,241) — **sat 0.05, hue 60°, achromatic white under a 34°-hue sun**.
  That is round-4 defect #7 unmoved.
- **The likely root cause, stated so the fix agent does not re-tune numbers that cannot
  work.** `src/world/Environment.js:324-332` builds the PMREM environment from `SkyShader`,
  which is a smooth analytic gradient. A roughness ladder is only *visible* as differing
  blur of reflected environment structure. Reflecting a featureless gradient, a roughness-0.12
  surface and a roughness-0.90 surface return the same near-constant colour, so the entire
  0.08→0.99 ladder collapses to one value. Compounding it, materials are authored
  `flatShading: true` throughout (`Materials.js`, `Placeables.js:58`,
  `EnemyMeshes.js:191-207`): with a constant normal per facet, the specular lobe is constant
  per facet, so a highlight has nowhere to form. **No further roughness-number tuning will
  move this axis.** What moves it is (a) putting structure in the environment the smooth
  materials reflect — cloud banding, a horizon band, a ground-bounce term — and (b) letting
  the normal map perturb the flat-shaded normal so a lobe can travel across a facet.

---

## 3. `02-vista` — REGRESSION against round 4

Round 4 graded this shot 2:7 3:7 5:7 and called its four-plane value stack a win. Measured now:

| metric | round 4 | **round 5** | direction |
|---|---:|---:|---|
| sub-L24, all-px | 1.581% | **12.52%** | **8× worse** |
| frame mean L (non-HUD) | — | 70.9 | — |
| largest connected sub-L40 region | 6.14% (as low-detail) | **33.5% of frame** | **5× worse** |
| near→mid value step | 41.3 → 54.0 | **39 → 44** (5 luma) | collapsed |
| arch crown top : underside | 1.18:1 (defect #5) | **1.00:1** | **worse** |
| right cliff top : face | — | 1.23:1 at L27.9 vs L22.7 | flat |
| dominant hue share | — | 240° = **37.3%** of saturated px | one violet bath |

**One third of the establishing shot is a single connected near-black blob** — the right-hand
cliff plus the lower-left — carrying six distinct luma values across a 45×45 patch. At a 2.2
gamma boost it still shows three barely-separated facets. That is not a silhouette, a shadow,
or a value plane; it is a hole in the frame, and it is where the rubric's four-point
"everything at one depth, subject centred in dead space" lives.

The basin scan at y=660 confirms round-4 defect #4 is untouched: L slides 49→27 over a
**73 px** 10–90 transition with no edge and no shape. There is still no cast-shadow *form*
on the basin floor.

---

## 4. Round-4 defect ledger — what is actually fixed

Verified against round 4's own stated acceptance criteria, not against fix claims.

| R4 # | Defect | Verdict | Evidence measured this round |
|---|---|---|---|
| **1** | Teal accent 4–7× over budget | **PARTIAL — fixed in 07, worse in 02-vista, and re-created elsewhere** | R4's own mask (`g>90 ∧ b>90 ∧ g>1.35r ∧ b>1.2r`): 07 **4.416% → 0.086%** (target <1.5%) — genuinely fixed. 02-vista **2.549% → 3.548%** (target 0.5–1.0%), largest component **1.56%** (criterion <1.2%). Both criteria still missed and the number moved the wrong way. b3 hits 7.211% (largest comp 3.56%). *Caveat, stated so it is not over-charged: b2's 15.686% is mostly its pale sage cliff, not crystal — that mask over-reads on this biome.* |
| **2** | Chest is an untextured neutral slab | **NOT FIXED — verbatim** | Body HF sd 0.666 / **8 luma values** / sd 1.45. Lid is one 25,729 px uniform bright mass and the brightest object in frame. Criterion was "three distinct luma plateaus, one specular above L180 on banding, ≥2 concave silhouette features" — zero of three. Subject sat 0.12–0.14 hue 16–21° against ground hue 312–316°. |
| **3** | 07's lower-left is a dead zone | **NOT FIXED** | Criterion: low-detail area below y=500 and left of x=650 under 8% of frame. Measured **13.9%** — 74% over. |
| **4** | 02-vista basin carries no shadow shape | **NOT FIXED** | y=660 scan: 73 px soft transition, no contiguous sub-L45 region with a principal axis. See §3. |
| **5** | Arch (centre-frame hero) is flat-lit | **NOT FIXED — regressed** | Criterion ≥2.2:1 top-to-underside. 02-vista arch measures **1.00:1** (R4: 1.18:1). b1's arch legs measure **1.12:1** with a **2°** hue rotation — the same defect reproduced on the new hand-authored landmark. |
| **7** | Metal specular is achromatic | **NOT FIXED** | Monolith peak RGB(255,255,241), **sat 0.05**, hue 60°, under a hue-34° key. |
| **9** | Crystal is one repeated spike mesh | **NOT FIXED** | b3 carries ~50 instances of one pink spike and ~40 of one mushroom cap, scale as the only variation. |
| **10** | `src/world/Props.js.bak` checked in | **FIXED** | `src/world/` now contains only the six live modules. |

**1 of 8 clean, 1 partial, 6 not fixed.** Round-4 defects #6 and #8 target `01-title`, which is
outside this shot set.

---

## 5. Answers to the remaining commissioned questions

**Q2 — one committed key with long raking shadows, or flat ambient?**
Committed key, yes — and the shadow *colour* work from round 4 survives intact (see §1).
But the key models **props only**. Terrain and hand-authored landmarks are flat-lit: b1 arch
1.12:1, 02 arch 1.00:1, 02 right cliff 1.23:1, b4 left range 1.17:1, b3 ground 1.07:1. And
the shadows are no longer raking — they are washes. The 10–90 transition width across the
main shadow edge measures **77 px** in 07 and **73 px** in 02-vista, against round 4's
measured 1–17 px penumbras. b3's mushroom shadows read at **1.28:1** with a 0 px transition.
A shadow you cannot find the edge of is not a raking shadow; it is a gradient.

**Q3 — real fog/value depth separation?**
Only in **b2** (skyline |ΔL| 7.5, sat 0.38→0.15) and partially **b4** (near L51 → mid 68 →
far 105). **b1 runs backwards or flat** — skyline |ΔL| median **31.4**, terrain-minus-sky
saturation **−0.01**, i.e. distant ranges are as saturated as the foreground and sit against
the sky with a hard undiminished edge. **b3 has none at all** — near L105 → mid L113 → far
L73 with saturation pinned at 0.45–0.47 across every depth. **02-vista's near and mid are 5
luma apart** (39 vs 44), both crushed.

**Q5 — do the landmarks anchor the frame?**
Two of four do. **b4's crane is a genuine focal point** — silhouetted, on a third, scale-legible.
**b3's boulder** reads, though it is dead-centre. **b1's arch** is well placed but is flat-lit
to 1.12:1, so it reads as a cut-out rather than a mass, and the crosshair sits in empty sky
beneath it. **b2 has no landmark at all in frame** — the shot is a field of ~8 near-identical
columns with a blown-white cliff behind, which is the rubric's "undifferentiated noise".

**Q6 — does the teleporter beam wreck composition?**
Yes, and it is the largest single cohesion break in the build.

| shot | beam mask | mean L (beam) | mean L (rest) | ratio | tallest column | rows touched |
|---|---:|---:|---:|---:|---:|---:|
| b1 | 0.64% | 217 | 99 | 2.19× | 282 px (31% of height) | 78% |
| b2 | **4.60%** | 196 | 107 | 1.83× | 399 px (44%) | 82% |
| b3 | 1.97% | 198 | 87 | 2.28× | 284 px (32%) | 84% |
| b4 | 0.98% | 221 | 64 | **3.45×** | 520 px (**58%**) | 81% |
| 02-vista | 1.72% | 196 | 67 | 2.93× | 530 px (**59%**) | 67% |

In every world shot the brightest element in the frame is the same hard-edged cyan bar. It
touches 67–84% of the frame's rows. In **02-vista it runs straight down through the stone
arch**, bisecting the hero landmark. In **b2 it is 4.6% of the frame** and its bloom washes
the entire midground. Its hue (≈185–190°) sits 150–180° from the dominant hue of b1 (15°)
and b4 (0°) — it is the one element identical across four biomes that are otherwise
successfully distinct, so it reads as HUD chrome standing in the world.

---

## 6. TOP DEFECTS (ranked — work top-down)

**1. Materials: 73–92% of every unbroken surface has zero high-frequency detail. Axis 5, all six shots.**
`src/world/Environment.js:324-332` (PMREM source) · `src/world/Materials.js:490-514, 870`
Measured HF residual sd at or below the film-grain floor on 79.9 / 77.9 / 75.0 / 72.8 / 85.6 /
91.5% of single-surface tiles. Chest body **8 distinct luma values in 2,025 px**; 02-vista's
right cliff **6**; b2's water **13**. Water shows no specular, reflection or ripple; metal's
only highlight is achromatic (sat 0.05) under an amber sun.
**Fix — and do not re-tune roughness numbers, they cannot express themselves against a
featureless environment:** (a) give the PMREM source structure to reflect — a horizon band,
cloud banding and a ground-bounce hemisphere in `SkyShader`, so a roughness-0.12 surface and a
roughness-0.90 surface return visibly different reflections; (b) let the normal map perturb
the shading normal on flat-shaded materials so a specular lobe can travel across a facet
instead of being constant per triangle; (c) tint the specular by the key colour.
**Verify:** texture-free single-surface fraction below **40%** in every shot; b2's water patch
above HF sd 4.0 with a compact lobe ≥40 px; monolith peak saturation ≥ 0.15 with hue within
25° of the key.

**2. `02-vista` has regressed to a near-black hole. Axes 2 (3), 3 (4), 5 (4), 10 (5).**
33.5% of the frame is **one connected sub-L40 region**; sub-L24 went 1.581% → **12.52%**;
near→mid value step collapsed to 5 luma; 240° is 37.3% of all saturated pixels.
**Fix:** lift the shadow-side floor of the right cliff and break it with two value planes and a
rim; re-pick the establishing bearing so the right third is not one unlit face; restore the
round-4 four-plane ladder (near 41 → mid 54 → far 89).
**Verify:** no connected sub-L40 region above 8% of frame; sub-L24 all-px below 3%; near→mid
step ≥ 12 luma.

**3. Both hero arches are flat-lit; shadows have become 73–77 px washes. Axis 1, all shots.**
02-vista arch **1.00:1** top-to-underside (round-4 defect #5, criterion 2.2:1, was 1.18:1 —
now worse). b1 arch legs **1.12:1** at **2°** hue rotation. Main shadow-edge 10–90 transitions
measure **77 px** (07) and **73 px** (02-vista) against round 4's 1–17 px; b3's ground shadows
are **1.28:1**.
**Fix:** thicken the arch shells or add an AO-darkened inner face so the underside sees a
different hemisphere; tighten the shadow filter radius / raise the shadow-map resolution at
these distances so the penumbra reads as an edge.
**Verify:** ≥ 2.2:1 top-to-underside on both arches; 10–90 shadow transition under 20 px on the
primary caster in 07 and 02-vista.

**4. The teleporter beam is the brightest object in every world frame and belongs to no biome. Axes 2, 3, 8, 10.**
Up to **3.45×** the frame mean, 520–530 px tall, touching 67–84% of frame rows, hue 150–180°
away from b1's and b4's palettes, and in 02-vista it bisects the hero arch.
**Fix:** drop the beam core to no more than 1.6× the frame mean; tint the shaft toward each
biome's key hue instead of one fixed cyan; taper the top so it does not reach frame edge; and
in the establishing bearing reject any camera where the beam overlaps the primary landmark's
bounding box.
**Verify:** beam mean L ≤ 1.6× frame mean in all four biomes; beam mask below 1.5% of frame in
b2; zero overlap with the landmark bbox in 02-vista.

**5. `07-interactables`: the chest is unchanged and the framing is dead. Axes 5 (3), 2 (4), 4 (4), 10 (4).**
Round-4 defect #2 verbatim — body HF sd 0.666, 8 luma values, one convex silhouette, zero of
three acceptance criteria met. Round-4 defect #3 also open: low-detail area in the lower-left
measures **13.9%** against a criterion of 8%. Background is one enormous untextured tan wall;
subject sits dead centre, flat-on, in a neutral cream that belongs to no palette
(sat 0.12 hue 16° against ground hue 316°).
**Fix:** author the chest to the same flat-shaded faceted vocabulary as the world — a warm
metal band at `metalRuin` roughness, three luma plateaus across the body, ≥2 concave silhouette
features; re-frame off-centre with the background wall broken by a value plane.
**Verify:** three plateaus, one specular above L180 on the banding, lower-left low-detail
below 8%.

**6. `13-biomes-4`'s distant ranges carry a 4 px contour-stripe artefact; `13-biomes-2`'s background is blown to near-white. Axis 9 (4 / 5), 10, 2.**
b4 at x=1350, y 260–430: mean |dL/dy| **2.24** with **84 direction reversals over 170 px** —
a ~4 px periodic terrace ripple across every peak in roughly the top-right third of the frame.
That is a heightfield/contour quantisation artefact, not strata. Separately, b2 puts **7.60%**
of its frame above L215 in a single **43,625 px** near-white shard field at [1331,110–1599,484]
that out-values every subject by ~74 luma.
**Fix:** filter or LOD-out the terrace/strata term with distance in `TerrainGen` so it falls
below one pixel of period before it aliases; pull b2's background exposure down and let its
own fog carry the depth read rather than the value.
**Verify:** b4 direction reversals under 20 over the same 170 px scan; b2 above-L215 fraction
below 2.5% with no connected component over 1.0% of frame.

---

## 7. Method / evidence

Six PNGs decoded with a hand-written decoder. Scripts in the session scratchpad at
`…/a0777b2c-…/scratchpad/`:

- `png.mjs` — PNG decoder (IHDR/PLTE/IDAT, all five filter types), luma and HSV helpers.
- `a_stats.mjs` — HUD-masked frame means, 16-bucket luma histograms, sub-L24, clipping,
  24-bin saturated-hue histograms.
- `b_mat.mjs` — per-ROI mean/sd/percentiles, circular-mean hue, 5×5 local-range flatness.
- `c_tex.mjs` — 45×45 patch high-pass residual vs 9×9 box blur, distinct-luma-value counts,
  sky noise-floor calibration.
- `d_grid.mjs` / `e_surf.mjs` — 24×24 tiling of every frame, sky masking, single-surface
  classification by intra-tile range, texture-free vs textured census (the §2 table).
- `f_comp.mjs` — all-pixel round-4 comparison basis, teleporter-beam mask + column/row extent,
  near/mid/far/sky depth probes, biome hue-histogram L1 distances.
- `g_fog.mjs` — per-column skyline detection, terrain-vs-sky |ΔL| and Δsaturation at the
  skyline, vertical autocorrelation of detrended background terrain.
- `h_light.mjs` — same-surface lit/shadow pair probes with hue rotation, striping column
  profiles, L>200 connected-component specular census.
- `i_spec.mjs` — 31 px ring-median top-hat specular-lobe detector with compactness filter.
- `j_shad.mjs` — horizontal scans across shadow boundaries: contrast, hue at extrema,
  10–90 penumbra width.
- `k_last.mjs` — sub-L40 and above-L215 fractions with largest-connected-component sizing,
  hue-family coverage.
- `l_r4.mjs` — round-4's exact teal mask and acceptance criteria for defects #1, #3, #7.
- `crop.mjs` — PNG encoder + nearest-neighbour magnification and gamma boost; produced the
  inspection crops of the chest, 02-vista's dark third, b4's striped range, b2's blown cliff
  and water, and b1's arch and far ranges.

Source read for attribution only, no file modified: `src/world/Materials.js`,
`src/world/Environment.js`, `src/world/Interactables.js`, `src/world/Props.js`,
`src/entities/EnemyMeshes.js`, `src/entities/Placeables.js`, `shots/manifest.json`.
