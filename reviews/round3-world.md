# PETRICHOR — Round 3 critique: WORLD / LIGHTING

Critic domain: axes 1 (lighting & shadow), 2 (composition & depth), 3 (colour & grade),
5 (material believability), 9 (post-processing), 10 (cohesion) — scored across all ten.
Reference target: Risk of Rain 2 — Titanic Plains / Abandoned Aqueduct / Rallypoint Delta.
Shots judged: `shots/01-title.png`, `shots/02-vista.png`, `shots/07-interactables.png`
(seed 1337, 1600×900, freshly captured).

`shots/manifest.json`: `ready: true`, `errors: []`, `partial: false`; every judged shot
`frameErrors: 0`, `newErrors: []`. **No crash to report.** Every defect below is a look
defect measured off the pixels.

### Measurement convention — state this before comparing to round 2

All luminance figures are **Rec.709 on the sRGB-encoded 8-bit values**, no linearisation:

```
L = 0.2126·R + 0.7152·G + 0.0722·B        (R,G,B in 0..255)
```

Round 2 did not state its weighting, so every sub-luma-24 figure below is also given under
Rec.601 (`0.299/0.587/0.114`) to bound the comparison. Figures are quoted twice where it
matters: **all pixels** (comparable with round 2, which included the HUD) and **non-HUD**
(six HUD rectangles masked: gold chip, objective banner, timer block, health bar, stage
label + ability row, crosshair — 26,175 px of 1,440,000).

---

## 1. Axis scores

| # | Axis | 01-title | 02-vista | 07-interactables |
|---|------|:--------:|:--------:|:----------------:|
| 1 | Lighting & shadow | 4 | 4 | 3 |
| 2 | Composition & depth | 6 | 6 | 2 |
| 3 | Colour & grade | 5 | 6 | 3 |
| 4 | Silhouette & form | 6 | 5 | 4 |
| 5 | Material believability | 4 | 5 | 3 |
| 6 | VFX quality | 4 | 4 | 3 |
| 7 | UI/HUD craft | 7 | 7 | 7 |
| 8 | Readability under load | 7 | 5 | 5 |
| 9 | Post-processing | 5 | 6 | 4 |
| 10 | Cohesion | 7 | 6 | 3 |
| | **mean** | **5.5** | **5.4** | **3.7** |

```
01-title          AXIS SCORES: 1:4 2:6 3:5 4:6 5:4 6:4 7:7 8:7 9:5 10:7   VERDICT: FAIL
02-vista          AXIS SCORES: 1:4 2:6 3:6 4:5 5:5 6:4 7:7 8:5 9:6 10:6   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:3 2:2 3:3 4:4 5:3 6:3 7:7 8:5 9:4 10:3   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Round-2 means
were 4.3 / 4.6 / 2.8; round-3 means are 5.5 / 5.4 / 3.7. That is real, measurable movement
on every shot — `02-vista` in particular is now a photograph of a world rather than of a
render bug — but nine of the ten axes still fail on at least one shot, and `07-interactables`
fails eight of ten.

### What is genuinely working — do not break it

- **The black crush is gone, and it is gone properly.** Pixels ≤ RGB(6,6,6): 0.001% of
  02-vista, 0.002% of 07 (non-HUD). More importantly the *grain survives everywhere*: the
  fraction of the frame whose 11 px local luminance range is under 2 — the round-2 test that
  proved clamping rather than darkness — is now 0.03% (02-vista) and 0.24% (07), against
  1.9% and 19.7% in round 2. The toe in `GradeShader.js:92-93` is a display-space floor and
  it does exactly what it says.
- **Fog and sky are the same painting now.** Sky above the central ridge (640,205) is hue 2°;
  the ridge body 45 px below is hue 8°. Round 2 measured those two 139° apart.
- **The terrain hue confetti is fixed.** A 360×180 foreground block at (200,600) is now 79.8%
  in one 30° hue bucket, against round 2's 37/57 warm/cool split.
- **The island rim stipple is fixed.** Twenty consecutive scanlines across the top-left
  island's plate junction contain no alternating lit/black run.
- **Clouds exist.** The sky band at y ≈ 100-165 now carries visible lavender-grey wisps
  across x 200-1300 without boosting. Round 2 had one.
- **No banding, clean AA, restrained bloom.** 0.007% clipped white in 02-vista.
- **The HUD is still the most confident thing in the build**, and the title lockup is
  genuinely good design.

---

## 2. Round-2 defect register — LANDED / PARTIAL / NOT LANDED / REGRESSED

Every row carries my own measurement. Where the fixer published an estimate, the estimate is
shown next to the measured value.

| ID | Round-2 defect | Verdict | Pixel evidence (measured this round) |
|---|---|---|---|
| **W1** | `07` contains no interactable | **LANDED** | The frame now contains a Shrine of Blood: plinth, basin ring with four buttresses and central spike, 0.87% of frame for the spike alone, centred under the crosshair, unoccluded. `Harness.js:564-619` rewrite works. |
| **W2** | Shadow side clips to pure black | **LANDED** | See table below. Claim beaten, not just met. |
| **W3** | Title is a black frame with a logo | **PARTIAL** | Scrim is exactly as prescribed (`hud.css:1047-1055`, `0.72/0.52/0.16/0` × `0.30/–/–/0.34`). Bottom-1/16 bucket 61.6% → **7.89%**. But frame mean RGB (24.4,22.5,26.0) → **(47.1, 31.0, 31.9)**, mean L **34.5** — the round-2 target was mean > 55 and the CSS comment at `hud.css:1046` sets its own target at "45-55/255". Bottom-2/16 84.4% → **63.68%**; target was < 35%. Both acceptance criteria missed. |
| **W4** | Establishing shot has no cast shadow | **NOT LANDED** | The frustum re-centre is in the code (`Environment.js:408-419`) and is correct. The pixels are unchanged: crop (480,470)-(1040,770) contains eleven dead trees, two stone arches, ~15 boulders and a 27 m monolith, **none of which casts anything and none of which has contact darkening**. In this framing the sun's ground vector projects to |dot| = 0.999 against screen-right, so a cast shadow would be an unmistakable horizontal band — there is none. The only sub-L34 components > 1500 px are the right mesa's own shaded faces (largest 29,619 px, bbox 1195,551–1599,719, aspect 2.4). Compounding: the ULTRA widening at `Environment.js:61` is on a tier the capture never uses — `RenderPipeline.js:155` adopts the GPU's tier, which here is HIGH → `ext 80` (`Environment.js:55`). |
| **W5** | Fog and sky are different paintings | **LANDED** | Hue delta sky→ridge at (640,205)/(640,250) = **6°** (target < 45°, round 2 = 139°). Far-massif block (180,200) 180×120 is 94.8% in the 0-30° bucket, i.e. it now agrees with the sky band's 79.8%. Secondary criterion "massif darker than the sky above it" holds on the broad sample (far massif L 98.8 vs sky band L 105-120) though not at the single round-2 probe (83.5 vs 75.9). |
| **W6** | Per-facet hue confetti | **LANDED** (with a note) | Foreground block (200,600) 360×180: dominant hue bucket **79.8%** (target ≥ 60%; claimed 86.3%; round 2 was a 37/57 split). Note: the far massif is now 94.8% in that *same* bucket, so `Materials.js`' promise of "near/mid/far separate by hue as well as by value" is still unmet — separation is now carried by saturation (0.70 near → 0.37 far) and value alone. Midground does hold a mauve at 337°, so it is not a total collapse. |
| **W7** | No roughness contrast, no specular | **PARTIAL** | Code ladder is real (`Materials.js:291-389`: organic 0.98 / stone 0.84-0.90 / metal 0.26 + metalnessMap / crystal 0.08, envMapIntensity 0.4-2.2). Visible gains: the hero arch now carries real rock grain and strata with a 1.35:1 lit/dark break, and the monolith has plane breaks instead of an airbrushed gradient. But the round-2 acceptance test fails: **no specular hotspot above 200/255 exists on any non-emissive prop.** Brightest pixel anywhere on the arch (search box 845-940 × 245-340) is L = 180 at (915,339). Every one of the 477 pixels above L 195 below y = 240 is either a crystal emissive (128,217,215 family) or an additive dust mote (239,189,134 family) — 22 distinct 16 px cells, zero speculars. |
| **W8** | The one accent colour is absent | **NOT LANDED — claimed fix did not reach the pixels** | `crystalClusters` 6 → 12 and `crystalScale` [0.8,3.0] → [1.2,4.2] landed in code (`Materials.js:445`). On-screen teal fraction (round-2's own test, `g>90 && b>90 && g>1.35r && b>1.2r`, all pixels): round 2 **0.098%** → round 3 **0.090%**. Statistically unchanged, 6.7× under the 0.6% target. 452 teal pixels below y = 240 in 10 32-px cells; the largest cluster totals 177 px (≈15 px on its long axis). Target was one cluster > 40 px. The clusters were doubled; the *placement* half of the round-2 fix ("bias toward the basin rim so a camera anywhere has one in frame") was not done. |
| **W9** | Mirrored damage-number ghosts in 07 | **LANDED / GONE** | A gamma-2.0 boost of the whole 07 frame shows no glyph forms anywhere. |
| **W10** | Vignette takes 17% off the edges | **PARTIAL** | `uVignette` 0.26 and `smoothstep(1.02, 0.40, …)` are in place (`GradeShader.js:21, 104`). Measured on the one true flat field in any shot — 07's single-facet purple wedge — mean luma falls **39.05 at radius 0.25 → 30.85 at radius 0.70, −21.0%**, which matches the shader model's predicted 0.773 multiplier to within 2%. The round-2 configuration predicts −40% over the same radii, so the effect is roughly halved; but the acceptance criterion (< 8% centre-to-edge) is met only at the mid-height frame edge (−8.1% by model) and is missed by ~2.6× at the corners (−23%). |
| **W11a** | Sky never shows zenith blue | **NOT LANDED — claimed fix did not reach the pixels** | Over the whole 02-vista sky band (y < 200, non-HUD, 320,000 px) exactly **23 pixels — 0.007%** — fall in the 180-260° hue window at sat > 0.05, and the most saturated of those is a dust mote at (1437,132). Twelve-bucket hue histogram of the band: 79.8% at 0-30°, 15.5% at 330-360°, 3.4% at 300-330°, **0.00% at 180-240°**. Target was ≥ 6%. Top of frame at (760,2) is RGB(181,79,89) — hue **354°, red**. |
| **W11b** | Clouds invisible | **LANDED** | Visible lavender-grey deck at y ≈ 100-165 across x 200-1300 with internal value contrast, no boosting required. |
| **W12** | Stitched black seam on island rims | **LANDED** | Scanlines y 126-145 across x 350-420 (top-left island plate junction) show at most one isolated 2-3 px dip per row; the second island (x 1030-1110, y 232-240) is monotone. Round 2's signature run `80 79 77 74 64 39 55 41 33 30` does not reproduce anywhere. |
| **W13** | Small unlit props read as dirt specks | **LANDED** | No hard-edged sub-20 px dark sliver on the monolith's lit face. Island-keel debris reads as rock at 6×. Residual: a few 2-3 px dark dots along the top-left island rim (x 358-379, y 129-133, dipping to L 70 against L 105) — minor, on a rim, not on a hero silhouette. |
| **W14** | Horizon dead centre, subject in dead space | **LANDED (overshot)** | The frame now has a genuine near/mid/far stack (near L 69.3 → mid L 43.4 → far 86-99) with the monolith off the centre line and a foreground terrace framing the left edge. But the skyline now averages y = **99, i.e. 11.0% of frame height** against a target window of 0.32-0.42. The shot documented as judging "terrain, lighting, fog, sky" now gives the sky one ninth of the frame. |

### W2 — measured vs claimed, in detail

| metric | 02-vista | 07-interactables | 01-title |
|---|---|---|---|
| sub-luma-24, **Rec.709, all px** | **1.45%** | **19.98%** | **38.77%** |
| sub-luma-24, **Rec.601, all px** | 1.31% | 17.57% | 34.60% |
| sub-luma-24, Rec.709, **non-HUD** | **0.41%** | **17.34%** | 38.82% |
| *round-2 figure* | *16.6%* | *69.5%* | — |
| *fixer's static estimate* | *2.8%* | *32.8%* | — |
| ≤ RGB(6,6,6), all px | **0.015%** | **0.009%** | **0.000%** |
| ≤ RGB(6,6,6), non-HUD | 0.001% | 0.002% | 0.000% |
| *round-2 / claimed* | *— / 0.0%* | *20.2% / 0.0%* | *— / 0.0%* |
| pure RGB(0,0,0) | 0.006% | 0.003% | 0.000% |
| 11 px local range < 2 ("clamped") | **0.03%** | **0.24%** | — |
| *round-2 figure* | *1.9%* | *19.7%* | — |
| frame mean luma | 72.1 | 39.1 | 34.5 |

**The static estimate was pessimistic and the fix over-delivered on the metric it targeted.**
02-vista landed at 1.45% against a claimed 2.8%; 07 landed at 19.98% against a claimed 32.8%.
The near-zero pure-black pixels that remain are HUD panel interiors, not world. W2 is
**LANDED** and should be treated as closed.

The residual — 07 still spending 48.8% of its pixels in the single 32-48 luma bucket and
17.3% under L 24 — is no longer a *grade* problem. It is a framing and key-light problem;
see X3 and X5.

---

## 3. Ranked new-defect list

Ranked by rubric cost. `AREA C` = lighting / post / grade / sky / environment.
`AREA D` = terrain / props / materials / interactables. `AREA F` = camera framing.

---

### X1 — The Shrine of Blood's spike is a flat, unshaded, channel-clipped red triangle. **[AREA D]**
`src/world/Interactables.js:442-448` · `src/shaders/GradeShader.js:96-97`

**Pixels.** Mask `R>150 && G<60 && B<90` over the cone bounding box selects 12,535 px, 0.87%
of the frame. Across that mask:

```
R  mean 205.7  sd 14.40  min/max 151/221
G  mean  3.08  sd  7.74  min/max   0/59      61.7% of cone pixels have G == 0
B  mean  51.4  sd  3.70  min/max  38/65
left-half (x<795) mean R = 205.2      right-half (x>805) mean R = 205.1
```

A cone lit by a directional key has a Lambert gradient from lit side to terminator. This one
has a **left-to-right mean difference of 0.1/255 — 0.05%**. Horizontal scanlines confirm it:
at y = 480 the run across the whole cone width is `202,215,212,209,213,209,211,210,211`.
Vertically, tip to base is 219 → 196, a 10% falloff over the entire 230 px height. It is a
2-D vector triangle sitting in a 3-D frame — the single most cohesion-destroying object in
any of the three shots (axis 10) and the reason axis 4 cannot go above 4 on this shot.

**Cause.** `emissive: 0xd0203a, emissiveIntensity: 0.5` is linear (0.3053, 0.0072, 0.0211).
The lit term — `color: 0x8a1f2c` at metalness 0.35, in a pit where nothing reaches the key —
lands under 0.04 linear. So ~88% of every pixel on the cone is a normal-independent emissive
constant, and `flatShading: true` has nothing to shade. Then `uSaturation 1.06` applied after
the toe (`GradeShader.js:97`) pushes the already ~0.05 green channel below zero and
`clamp(col, 0.0, 1.0)` (`:114`) takes it to hard 0.

**Fix.** Drop `emissiveIntensity` 0.5 → 0.12 and raise `color` to ~`0xb8323f` so the *lit*
term carries the read; keep the emissive only as a rim-glow contribution. Verify: left-half
vs right-half mean R must differ by ≥ 18%, and `G == 0` must fall under 1% of the cone mask.

---

### X2 — A quarter of `07-interactables` is one featureless flat wedge of near-camera terrain. **[AREA F]**
`src/core/Harness.js:192-231, 606-616`

**Pixels.** A single terrain facet fills the left third of frame, roughly x 0-430 from y 120
to the bottom edge. Samples: (60,200) RGB(45,25,49) hue 291° sat 0.49; (150,400) (54,30,59)
hue 289°; (250,600) (58,32,63) hue 290°; (350,750) (58,31,61) hue 293°. Within each 20×20
sample the min/max luma spread is **4** — it is one plane with no incident, no texture read
and no silhouette. Masking `hue 275-305° ∧ sat > 0.4 ∧ value < 0.30` counts **25.59% of the
non-HUD frame**. That is the axis-2 four-point text ("subject centred in dead space") plus a
quarter of the image spent on nothing.

**Cause.** `clearCam` (`Harness.js:192-231`) tests occlusion *of the subject* along three
height probes and requires backdrop depth *behind* it. Nothing tests what the near half of
the frustum contains. The comment at `Harness.js:611-615` claims the 32° lens "crops the dead
foreground wedge that a low, close camera on sloping ground always picks up" — it did not; the
long lens narrowed the field but the camera is still low on a slope, so the slope simply fills
more of the narrower field.

**Fix.** After `clearCam` returns a candidate, sample a 4×4 grid of rays through the frustum's
lower-left and lower-right quadrants and reject the bearing if more than ~12% of them hit
terrain closer than 0.35× the subject distance. Verify: no single connected same-hue-bucket
region may exceed 12% of the frame.

---

### X3 — `07` has no value ladder: foreground, midground and background sit inside an 11-luma band. **[AREA C + AREA F]**
`src/core/Harness.js:583-600` · `src/world/Environment.js:118`

**Pixels.** Three 120×120 / 120×60 boxes at the three depths:

```
FG purple wedge (200,500)   RGB(58,32,63)   L = 39.4
MG shrine plinth (760,600)  RGB(35,29,62)   L = 32.4
BG terrain (450,150)        RGB(75,34,30)   L = 42.7
```

Foreground to background spans **10.3 luma**, and the midground is the *darkest* of the three.
48.8% of the whole frame lands in the single 32-48 luma bucket; the frame mean is L 39.1.
There is no sky in the frame at all (1.15% of pixels are bright and warm, and those are tan
terrace slabs). Aerial perspective cannot help here — `Environment.js:118` gives
`FogExp2(density 0.0036 × 0.85 = 0.00306)`, which over the 6-14 m this shot spans contributes
under 4%.

This is not a fog defect. The camera-placement search picks a subject and a bearing with no
regard for whether the *sun* reaches either. The chosen shrine sits in a pit; nothing in frame
is key-lit; the whole image is fill.

**Fix.** Add a lighting test to the subject ranking at `Harness.js:576-579`: reject any
candidate for which `stage.raycast(o.position + sunDir*0.5, sunDir, 200)` returns a hit, so
the shot can only choose a subject the sun actually reaches. Verify: background mean luma must
exceed foreground mean luma by ≥ 25, and the frame's 16-bucket luma histogram must have no
single bucket above 30%.

---

### X4 — Still no cast shadow anywhere in the establishing shot. **[AREA C]** (carry-over W4)
`src/world/Environment.js:52-62, 79, 408-419` · `src/core/RenderPipeline.js:155`

**Pixels.** Crop (480,470)-(1040,770) of 02-vista at 2× with a 1.5 gamma boost: eleven dead
trees standing on open ground, two 6 m stone arches, ~15 boulders and the base of a 27 m
monolith. Not one lays a shadow; not one has contact darkening at its base. Connected-component
analysis of sub-L34 regions in the ground band y 430-820 finds six components > 1500 px, of
which the top two (29,619 px at bbox 1195,551–1599,719 and 20,802 px at 1335,488–1599,588) are
the right mesa's own shaded side faces, not ground shadows. The sun's projected ground vector
in this framing is almost exactly screen-horizontal (|dot| = 0.999 with the screen-right axis),
so a real cast shadow would be unmissable.

**Cause is two things, both still live.** (a) The reach fix was applied only to the ULTRA tier
(`Environment.js:61`, `ext 110 / map 4096`), but `RenderPipeline.js:155` adopts the GPU's own
tier unless pinned, and the harness does not pin it — the capture runs HIGH (`Environment.js:55`,
`ext 80`), so the "islands sit 16-40 m up, their shadows land 50-120 m out" reasoning is
untouched for the shot that exists to prove it. (b) See X5: the terminator contrast is now too
low for a shadow to read even where one lands.

**Fix.** Pin the capture to ULTRA in `installHarness` (`Harness.js:38`, alongside the existing
`setAdaptive(false, 1)`), or lift the HIGH tier to `ext 100`. Verify by the round-2 criterion:
at least one contiguous sub-L34 region > 4000 px whose long axis runs within 20° of the
projected `−sunDir` ground vector, located on the basin floor rather than on a cliff face.

---

### X5 — The key light no longer carries the modelling; the fill is now roughly 40% of it. **[AREA C]**
`src/world/Environment.js:79` (`FILL = { hemiMin: 0.85, envMin: 0.78, groundBoost: 1.45 }`)

**Pixels.** Lit face versus shadow face on the same material, 02-vista:

```
right mesa  top (1230,330)  L 80.1   side (1230,400)  L 41.2   ratio 1.95
hero arch   lit (880,262)   L 85.9   dark (700,290)   L 63.5   ratio 1.35
left terrace top (60,340)   L 117.1  side (60,420)    L 129.2  ratio 0.91  <- shadow side brighter
monolith    face A (800,330) L 63.8  face B (818,330) L 75.6   ratio 0.84  <- shadow side brighter
```

Two of the four hero surfaces in the frame are **brighter on their shadow side than on their
lit side**. A golden-hour key should be carving a 3:1 or 4:1 terminator; 1.35:1 is fill light
with a warm tint on it. This is what the rubric's axis-1 four-point text means by "everything
equally lit", and it is the reason the frame reads as illustration rather than as lighting.

**Cause.** `FILL` raised the hemisphere floor to 0.85, the IBL floor to 0.78 and warmed the
hemisphere ground by 1.45×. That was the round-2 W2 prescription, and it worked — but the
*toe* is what actually solved the crush (see the W2 table: the flat fraction collapsed from
19.7% to 0.24%, which is a display-space effect, not a scene-light one). The fill lift is now
paying for a problem the toe already fixed, and the bill is the terminator.

**Fix.** Pull `hemiMin` 0.85 → 0.55 and `envMin` 0.78 → 0.55, keeping `groundBoost` and keeping
the toe exactly as it is. Re-measure the W2 metrics afterwards; if sub-luma-24 in 07 rises,
raise `uToe` (`GradeShader.js:32`) rather than the fill. Verify: lit:shadow on the same
material must reach ≥ 2.6:1 on at least two props, and **no lit face may measure darker than
its own shadow face**.

---

### X6 — Zenith blue is still absent from the sky. **[AREA C]** (carry-over W11a)
`src/shaders/SkyShader.js:77-85`

**Pixels.** Sky band y < 200, non-HUD: **0.00%** in the 180-240° hue bucket; 23 pixels total
(0.007%) anywhere in 180-260° at sat > 0.05, the most saturated of which is a dust mote.
Vertical scan at the top of frame:

```
(200,2) 184,85,67 h9    (500,2) 185,81,82 h359   (760,2) 181,79,89 h354
(200,40) 198,96,63 h15  (760,40) 205,92,83 h4    (1100,40) 206,97,78 h9
```

The top of the frame is red. `PALETTE.sky.zenith = 0x2f7fb2` still appears nowhere.

**Cause.** The rewrite kept the failure mode round 2 named. `SkyShader.js:85` still ends in
`mix(warm, uZenith, smoothstep(0.10, 0.55, hh))` — a straight linear cross of a saturated
amber against a saturated blue — and only moved the window. The vista camera sits 57 m out
pitched ~8.9° down at FOV 58 (`Harness.js:400-403`), so `hh` maxes near 0.34 and the zenith
weight never exceeds ~0.56 against an 0.87-linear amber. 0.44·(0.87,0.37,0.09) +
0.56·(0.027,0.216,0.451) = (0.398, 0.287, 0.377) — R still dominant, a desaturated red-mauve,
exactly what the pixels show.

**Fix.** Stop crossing through the mid. Introduce a real third *colour* stop — a controlled
cool-cyan band (~`0x6a8fa8`) between warm and zenith — and reach it by `hh ≈ 0.20`, then go to
`uZenith` above that: `mix(mix(warm, uMid, smoothstep(0.03,0.20,hh)), uZenith, smoothstep(0.18,0.40,hh))`.
Verify by the round-2 criterion: ≥ 6% of the 02-vista sky band in the 190-240° hue bucket.

---

### X7 — The palette's one accent is still invisible. **[AREA D]** (carry-over W8)
`src/world/Materials.js:445`

Teal fraction (round-2 test, all pixels): 0.098% → **0.090%**. Largest cluster 177 px in one
32-px cell, ≈ 15 px on its long axis. Cluster *count* doubled as prescribed; cluster
*placement* was not touched, so the extra clusters landed outside the vista frustum. **Fix:**
place at least four clusters on the basin rim ring at radius 0.55-0.75 of `basinRadius` and at
`crystalScale` ≥ 3.0. Verify: teal ≥ 0.6% of the re-shot vista with one cluster subtending
> 40 px.

---

### X8 — The vignette still takes 21% off the corners. **[AREA C]** (carry-over W10)
`src/shaders/GradeShader.js:21, 104-105`

Measured on 07's flat wedge, luma versus normalised radius from frame centre:

```
r 0.25  n 814   L 39.05        r 0.50  n 5874  L 34.80
r 0.35  n 4025  L 38.82        r 0.60  n  968  L 31.66
r 0.45  n 6264  L 36.64        r 0.70  n   39  L 30.85     -> -21.0%
```

The shader model predicts a 0.773 multiplier at r 0.70 against 1.000 at r 0.25; measured
0.790. The model is confirmed, so the number is not an artefact of the surface. **Fix:** drop
`uVignette` 0.26 → 0.16 and move the inner stop to `smoothstep(1.14, 0.52, …)`. Verify:
< 8% on the same flat-field radius sweep.

---

### X9 — Metal renders as matte black. **[AREA D]**
`src/world/Materials.js:341-350` · `src/world/Interactables.js:438`

**Pixels.** The Shrine of Blood's basin ring is `IRON_DARK` (roughness 0.26, metalness 1.0,
envMapIntensity 2.0) — the sharpest, most reflective material in the whole ladder. It measures
RGB(62,38,35) L 43.3 on its left arc and RGB(33,29,38) L 30.3 on its right, with no pixel above
L 169 anywhere in a 30×25 box and no highlight shape at all. At `metalness 1.0` the diffuse
term is identically zero, so the entire appearance of the ring comes from the IBL — and the IBL
in a pit is the dark ground half of the sky dome. The result is a black cutout where the
build's one genuinely reflective material should be.

**Fix.** Cap the metalness map's ceiling at ~0.8 so a dielectric diffuse floor survives, and
raise `envMapIntensity` for interactable metal to 3.0. Verify: a highlight above L 140 must be
findable on the basin ring.

---

### X10 — `07`'s background terrain reads as a field of random shards, not landform. **[AREA D]**
`src/world/TerrainGen.js:163` (`detailAmp` octave) · `:165-171` (basin damping)

**Pixels.** The gamma-2.0 boost of the full 07 frame shows the slope behind the shrine as
roughly forty thin, sharply pointed triangles of alternating tan and brown, radiating in
inconsistent directions with no ridgeline, no strata and no continuity between adjacent
facets. At the ~10-20 m the shot spans, the detail octave's amplitude is a large fraction of
the local relief, so every triangle is its own spike rather than a facet of a landform. The
same generator reads well at vista range (where the octave is sub-pixel) and badly at prop
range — the two shots look like two different terrains.

**Fix.** Halve `detailAmp` and roughly double `detailFreq`'s wavelength so the octave sits
below the triangle size at 10 m rather than above it; or damp the detail octave inside the
basin the same way the terrace pass is damped at `TerrainGen.js:171` (`1 - basin*0.8`).
Verify: at the 07 framing, no more than 15% of visible background triangles may differ from
their immediate neighbour by more than 25 luma.

---

### X11 — The title frame is still 64% in the bottom two luminance buckets. **[AREA C]** (carry-over W3)
`src/ui/hud.css:1047-1055`

Frame mean RGB (47.1, 31.0, 31.9), mean L 34.5 — against the CSS's own stated target of
"a clean value field at roughly 45-55/255" (`hud.css:1046`) and round 2's target of > 55.
Bottom-2/16 63.68% against a target of < 35%. The scrim itself is exactly as prescribed; the
combined alpha at the top-left is now 1 − (1−0.72)(1−0.30) = 0.804, so 20% of the scene
survives, but the scene behind it is itself dark. **Fix:** cut the horizontal stops again to
`0.56 / 0.40 / 0.10 / 0` and drop the vertical pass to `0.20 / – / – / 0.24`, then re-check the
wordmark. Headroom exists: the whitest glyph pixel is RGB(255,255,255) and glyph-to-plate
contrast currently measures 6.58:1 and 18.58:1 at two plate samples, well above the 4.5:1 floor.

---

### X12 — The title's menu button labels fail contrast. **[AREA C, adjacent to UI]**
`src/ui/hud.css` (menu button label colour)

PLAY/CO-OP/SETTINGS/QUIT labels measure RGB(83,86,93) on a button field of RGB(18,15,21) —
a contrast ratio of **2.60:1**, below the 4.5:1 floor for body-size type, and the only place
in the build where the otherwise excellent UI drops below its own standard. **Fix:** raise the
label colour to ~RGB(190,196,204). Verify: CR ≥ 4.5:1 against the button fill.

---

## 4. Which axes now clear 7, and which do not

**Clears 7 on every judged shot — one axis.**

- **Axis 7, UI/HUD craft (7 / 7 / 7).** Dense angular identity, real hierarchy, deliberate
  letterspacing, consistent spacing, never obscures the action. The title lockup is the best
  single piece of authorship in the build. X12 is the one blemish and it is a colour value.

**Clears 7 on one shot only — one axis.**

- **Axis 8, readability (7 / 5 / 5)** on `01-title` alone, and only because a menu has nothing
  to read *under*. In 02-vista the player is a 14 px white speck at (802,510) against a
  busy mid-value field; in 07 the subject is findable only because it is channel-clipped.

**Does not clear 7 anywhere — eight axes.**

- **Axis 1, lighting & shadow (4 / 4 / 3)** — the hard blocker. Zero cast shadows in any
  judged frame, and a lit:shadow ratio of 1.35-1.95:1 with two hero surfaces brighter on their
  shadow side. X4 + X5 are the whole gap.
- **Axis 5, material believability (4 / 5 / 3)** — the ladder exists in code and reads on the
  arch; it does not produce a single specular highlight on a non-emissive prop anywhere, and
  the one metalness-1.0 surface in frame renders black (X9).
- **Axis 6, VFX quality (4 / 4 / 3)** — outside my area, but nothing in these three frames
  layers; the dust motes are the only effect present.
- **Axis 3, colour & grade (5 / 6 / 3)** — 02-vista is close: harmonious, complementary,
  no clipping, no banding. It is held under 7 by the missing accent (X7) and a sky that is one
  warm ramp with no colour event in it (X6). 07 is held at 3 by 0.412% hard channel clipping.
- **Axis 2, composition & depth (6 / 6 / 2)** — both wide shots now have real depth stacks
  and are within reach; 07 has an 11-luma range across all three depths (X3) and spends a
  quarter of itself on one flat wedge (X2).
- **Axis 4, silhouette & form (6 / 5 / 4)** — the shrine now has a readable silhouette, which
  is genuine progress; the spike inside it does not (X1) and the mountain field is repetitive.
- **Axis 9, post-processing (5 / 6 / 4)** — AA, grain and bloom are all correct. Held under 7
  by a −21% corner vignette (X8) and, on 07, by channel clipping.
- **Axis 10, cohesion (7 / 6 / 3)** — 01-title reaches 7. 02-vista is one authored world.
  07 is dragged to 3 by a flat vector triangle sitting in a 3-D frame (X1) and by terrain that
  reads as a different generator at prop range than at vista range (X10).

**Shortest path to a pass on `02-vista`:** X4 and X5 together (cast shadows plus a real
terminator) move axis 1 and lift 4, 5 and 10 with it; X7 and X6 move axis 3. Four fixes, all
`AREA C` except one.

**`07-interactables` needs a different shot, not a better grade.** X2, X3 and X1 are the three
that matter, and two of them are camera decisions.

---

## 5. Defect index by area

| Area | Defects |
|---|---|
| **AREA C** (lighting / post / grade / sky / environment) | X3 (shared), X4, X5, X6, X8, X11, X12 — 6 owned + 1 shared |
| **AREA D** (terrain / props / materials / interactables) | X1, X7, X9, X10 — 4 |
| **AREA F** (camera framing) | X2, X3 (shared) — 1 owned + 1 shared |

Round-2 register: **7 LANDED** (W1, W2, W5, W6, W9, W11b, W12, W13 — 8 counting W13),
**3 PARTIAL** (W3, W7, W10), **3 NOT LANDED** (W4, W8, W11a), **0 REGRESSED**, 1 LANDED-with-overshoot
(W14). No claimed fix made anything worse in the pixels.

---

## 6. Method / evidence

All measurements were taken by decoding the three PNGs directly with a hand-written PNG
decoder (Node `zlib` + Paeth/Sub/Up/Average unfilter). **`tools/capture.mjs` was not run.**
Scripts live in the session scratchpad at
`…/9f539f6c-a8b6-45cf-b2ff-5f87e3b6c23d/scratchpad/r3/`:

- `png.mjs` — PNG decode to RGBA, Rec.709 / Rec.601 luma, RGB→HSV.
- `stats.mjs` — frame min/max/mean, 16-bucket luma histogram, sub-luma-24 under both
  weightings, ≤RGB6 / ≤RGB3 / pure-black and clipped-white fractions.
- `probe.mjs` — HUD mask (6 rectangles), box sampling, 12-bucket 30° hue histograms.
- `run1.mjs` — vignette row profiles, fog/sky hue probes, sky hue histogram, foreground and
  far-massif hue histograms, teal fraction, horizon column profile.
- `run2.mjs` — flattest-row search, island rim scanline dumps, connected-component analysis of
  sub-L34 regions in the ground band, shrine-cone scanline dumps, purple-wedge probes.
- `run3.mjs` — top-of-frame sky RGB grid, blue-pixel search over the sky band, 20-row island
  seam scan, specular search (L > 195 below y = 240), purple-wedge area and luma-vs-radius fit,
  sky/terrain break detection, title wordmark contrast.
- `run4.mjs` — cone mask statistics with left/right half means, channel-clipping census,
  11 px local-range flatness maps (per-region and whole-frame), arch specular search.
- `run5.mjs` / `run6.mjs` — lit-vs-shadow face ratios, depth value ramps, crystal cluster
  sizing, 07 per-third and per-depth means.
- `crop.mjs` / `crop2.mjs` — PNG encoder plus nearest-neighbour magnification and gamma boost;
  produced the 2×/3×/5×/6× inspection crops and the gamma-1.5/1.9/2.0/2.2 boosts referenced
  above.

Source read for cause attribution only: `RenderPipeline.js`, `GradeShader.js`, `SkyShader.js`,
`Environment.js`, `TerrainGen.js`, `Props.js`, `Materials.js`, `Interactables.js`,
`Harness.js`, `ui/hud.css`, `CONTRACTS.md`. **No project file was modified.**

Incidental, non-visual and unchanged since round 2: `src/world/Props.js.bak` is still checked
into the tree.
