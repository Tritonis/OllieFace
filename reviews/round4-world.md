# PETRICHOR — Round 4 critique: WORLD / LIGHTING (FINAL ROUND)

Critic domain: axes 1 (lighting & shadow), 2 (composition & depth), 3 (colour & grade),
5 (material believability), 9 (post-processing), 10 (cohesion) — scored across all ten.
Reference target: Risk of Rain 2 — Titanic Plains / Abandoned Aqueduct / Rallypoint Delta.
Shots judged: `shots/01-title.png`, `shots/02-vista.png`, `shots/07-interactables.png`
(seed 1337, 1600×900).

`shots/manifest.json`: `ready: true`, `errors: []`, `partial: false`; every judged shot
`frameErrors: 0`, `newErrors: []`. **No crash to report.** Every figure below is measured off
the PNGs with a hand-written decoder. **`tools/capture.mjs` was not run. No project file was
modified.**

Measurement convention unchanged from round 3: `L = 0.2126R + 0.7152G + 0.0722B` on the
sRGB-encoded 8-bit values. Where a figure is quoted "non-HUD", six HUD rectangles totalling
26,175 px are masked.

Per the rubric's stopping condition this is the last round. Section 3 is the honest
per-axis ledger; section 4 is what is left and whether it is a code problem or an
asset-authoring problem.

---

## 1. Axis scores

| # | Axis | 01-title | 02-vista | 07-interactables |
|---|------|:--------:|:--------:|:----------------:|
| 1 | Lighting & shadow | 7 | 7 | 8 |
| 2 | Composition & depth | 7 | 7 | 5 |
| 3 | Colour & grade | 6 | 7 | 6 |
| 4 | Silhouette & form | 7 | 6 | 5 |
| 5 | Material believability | 6 | 7 | 6 |
| 6 | VFX quality | 4 | 4 | 3 |
| 7 | UI/HUD craft | 8 | 7 | 7 |
| 8 | Readability under load | 8 | 6 | 6 |
| 9 | Post-processing | 6 | 8 | 8 |
| 10 | Cohesion | 7 | 7 | 5 |
| | **mean** | **6.6** | **6.6** | **5.9** |

```
01-title          AXIS SCORES: 1:7 2:7 3:6 4:7 5:6 6:4 7:8 8:8 9:6 10:7   VERDICT: FAIL
02-vista          AXIS SCORES: 1:7 2:7 3:7 4:6 5:7 6:4 7:7 8:6 9:8 10:7   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:8 2:5 3:6 4:5 5:6 6:3 7:7 8:6 9:8 10:5   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6.
Round-2 means 4.3 / 4.6 / 2.8 → round-3 5.5 / 5.4 / 3.7 → **round-4 6.6 / 6.6 / 5.9**.
That is the largest single-round movement of the four, and it is concentrated exactly where
round 3 said the gap was: axis 1 went from 4/4/3 to 7/7/8.

### What is now genuinely good — do not break it

- **`07` has real cast shadows and they are the best thing in the build.** Eight dead trees
  and a metal monolith lay long, branch-articulated, raking shadows across a sunlit dune.
  Measured on one tan facet, lit (1230,290) L=152.4 hue 31° against shadow (1205,290)
  L=43.7 hue 273° — **3.49:1 with a fully complementary shadow hue**. The penumbra widens
  correctly with distance from the caster: 1–2 px at y=280 near a trunk, ~17 px at y=320
  further out (`x 1193→1210: L 73→44`, hue sliding 4°→279° monotonically).
- **A real terminator exists.** Gold monolith in 02-vista, same prop, same material:
  lit (450,600) L=191.4 hue 32° vs shadow (330,600) L=39.9 hue 317° — **4.80:1**; at
  (440,760)/(340,760), **4.74:1**. Round 3 measured 1.35–1.95:1 with two hero surfaces
  brighter on their shadow side.
- **Bounce/complementary colour in shadow is now real,** not a claim: every shadow probe in
  both world shots rotates from a 28–34° amber key into a 260–320° violet ambient.
- **The sky is a sky.** Top of frame at (760,2) RGB(114,134,176) hue **221°** (round 3: 354°,
  red). 21.0% of the y<200 sky band falls in the 190–240° hue window at sat > 0.05 (round 3:
  0.007%; target was ≥ 6%).
- **Metal reads as metal.** The monolith at (1176,321) in 07 peaks at **L 254.2**,
  RGB(255,255,244), with a cloudy roughness-map break down its lit face and a deep blue
  shadow face. Round 3's "black cutout" is gone.
- **Post is clean.** 02-vista 0.006% clipped white, **zero** near-white pixels in the world;
  bloom confined to 0.82% of the frame above L 235; longest identical-colour run down the sky
  gradient is 4 px (mean 1.21) — dithered, no banding; vignette measured flat.
- **The HUD and the title lockup remain the most confident authorship in the build,** and the
  round-3 contrast failure is fixed.

---

## 2. Round-3 defect register — LANDED / PARTIAL / NOT LANDED / REGRESSED

**Summary: 7 LANDED, 1 LANDED-THEN-OVERSHOT, 3 PARTIAL, 1 NOT VERIFIABLE, 0 REGRESSED.**

| ID | Round-3 defect | Verdict | Pixel evidence measured this round |
|---|---|---|---|
| **X1** | Shrine of Blood's spike is a flat channel-clipped red triangle | **NOT VERIFIABLE** | The shrine is **not in any judged frame**. `07` chose a chest this time. Red-cone mask `R>150 ∧ G<60 ∧ B<90` returns 0.263% in 02-vista (scattered ochre terrace pixels, no connected cone), 0.030% in 07, 0.000% in 01-title. Round 3's cone was a single contiguous 12,535 px component. See ruling below. |
| **X2** | A quarter of `07` is one featureless flat wedge | **PARTIAL** | The stated criterion (no single connected same-hue region > 12% of frame) is **met**: largest connected low-detail region is **6.14%** (bb 10,10–546,293). But the four largest such regions — 6.14 / 5.30 / 4.80 / 3.32% — are mutually adjacent and form one contiguous dead foreground zone of **≈19.6%** across the lower-left. Visually it is three enormous untextured triangles, unchanged in kind from round 3. |
| **X3** | `07` has no value ladder (11-luma band across three depths) | **LANDED** | Near FG wedge L 45.6 → chest L 129.8 → sunlit slope L 157.8. Span **112 luma** against round 3's 10.3. Frame mean L 39.1 → **88.1**. Largest 16-bucket occupancy 48.8% → **27.6%** (criterion was < 30%). Note the ladder runs foreground→right rather than foreground→back: the far-left backdrop measures L 44.3, i.e. as dark as the foreground, so aerial perspective is not what carries it. |
| **X4** | Still no cast shadow in the establishing shot | **PARTIAL — mechanism LANDED, 02-vista's basin floor did not** | Shadows demonstrably render (X4's carrier claim is now closed — see 07 above, and boulders casting onto the monolith's lit face at (425–475, 355–395)). In 02-vista itself the left terrace carries a genuine soft shadow edge: at y=590 luma slides **92→37 over 15 px** with hue rotating continuously 13°→288°, repeated at y=620/660/700 at the same x≈148–158. Flat-shaded terrain steps; a 15 px continuous ramp is a penumbra. **But** the round-3 acceptance criterion is still missed: the basin floor (≈30% of the frame) contains no contiguous sub-L34 region whose long axis runs along the projected −sunDir; it is one undifferentiated ambient mass, and the shadow that does exist reads as an amorphous dark hill because no caster is identifiable. |
| **X5** | Key light no longer carries the modelling; fill ≈ 40% of it | **LANDED** | `Environment.js:91-96` is now a scale (`hemiScale 0.32/min 0.12`, `envScale 0.82/min 0.34`, `rimScale 0.29/min 0.22`), `:109` `KEY_GAIN = 2.5`, `:390` rim 1.45 × 0.29 = 0.42. Criterion "≥ 2.6:1 on at least two props" — met at **4.80** and **4.74** (monolith), plus 3.49 (07 tan slope) and 2.01 (02 left terrace). Criterion "no lit face darker than its own shadow face" — no valid same-prop pair inverts; my two apparent inversions on first pass were cross-object probes and are withdrawn. |
| **X6** | Zenith blue absent from the sky | **LANDED, overshot the claim** | `SkyShader.js:98-99` is the prescribed three-stop with the zenith weight capped at 0.62. Measured 190–240° at sat > 0.05 over the y<200 band: **21.01%** (claim 7.14%, target ≥ 6%, round 3 0.007%). 180–260° is 68.1% of the band. Top-of-frame hue 354° → **221–264°**. |
| **X7** | The one accent colour is invisible | **LANDED then OVERSHOT** | Teal (round-2 mask) 0.090% → **2.549%** in 02-vista and **4.416%** in 07. Target was 0.6%. See §2b. |
| **X8** | Vignette takes 21% off the corners | **LANDED** | `GradeShader.js:21` `uVignette 0.16`, `:115` `smoothstep(1.14, 0.52, …)` — exactly as prescribed. Flat-field radius sweeps: 07's purple foreground wedge r 0.15→0.85 gives L 35.04→35.96, **+2.6%**; 07's tan wedge r 0.25→0.75 gives 98.30→96.90, **−1.4%**. Criterion was < 8%. |
| **X9** | Metal renders as matte black | **LANDED** | 07's metal monolith peaks at **L 254.2** RGB(255,255,244) at (1176,321) with a visible cloudy specular sweep and a distinct blue shadow face. Criterion was "a highlight above L 140 must be findable" — beaten by 114 luma. |
| **X10** | `07` background reads as a field of random shards | **LANDED** | The slope behind the subject now reads as a coherent dune with gentle facet gradation. 24 px-adjacent sample disagreement > 25 luma: **11.0%** on the upper-left background (criterion ≤ 15%). The upper-right slope measures 35.1%, but that region is where the tree shadows fall and the shadows are the discontinuity, not the terrain. |
| **X11** | Title is 64% in the bottom two luminance buckets | **PARTIAL** | Bottom-2/16 63.68% → **49.82%**; the target was < 35%. Frame mean RGB (47.1,31.0,31.9) L 34.5 → **(47.3,37.0,40.3) L 39.4**; `hud.css:1046`'s own stated target is 45–55/255. Both criteria still missed, though the frame now reads as a place rather than as a black plate. |
| **X12** | Title's menu button labels fail contrast | **LANDED** | PLAY glyph RGB(234,241,249) on fill RGB(28,36,52) = **13.65:1**; BEGIN-A-RUN RGB(91,208,236) on RGB(12,12,20) = **10.83:1**. Round 3 measured 2.60:1; the floor is 4.5:1. Wordmark-vs-plate re-measured at four plate samples: 12.34 / 15.60 / 17.97 / 18.81:1. |

### 2a. Ruling on the two corrections to my round-3 report

**Correction 1 — "you reported the cast-shadow fix landed on a tier the capture never uses".
The correction is RIGHT and my round-3 finding X4(a) was wrong. I withdraw it.**

Verified in source, not taken on trust:

- `tools/capture.mjs:190` — `page.goto('…/?seed=${SEED}&quality=3&harness=1')`.
- `src/main.js:22-23` — `const pinnedQuality = params.has('quality'); const quality = pinnedQuality ? Number(params.get('quality')) : QUALITY.HIGH;`
- `src/main.js:30, 40` — `new RenderPipeline(canvas, quality)` then `pipeline.detect({ pinned: pinnedQuality })`.
- `src/core/RenderPipeline.js:153-155` — `detect({ pinned = false })` … `if (!pinned) this.quality = this.gpu.quality;`

So quality is pinned to 3 and the GPU tier is never adopted. `Environment.js:52-62`
`SHADOW_TIERS[3]` = `{ map: 4096, ext: 110, vsm: true }`. **The capture does run ULTRA.**
My round-3 error was specific and avoidable: I read `RenderPipeline.js:155` and asserted
"the harness does not pin it" without opening `capture.mjs`. That is on me.

Two qualifications, so the correction is not over-credited:

1. My round-3 *pixel* finding was correct. There was no readable cast shadow in 02-vista's
   ground band, and there still is not one on the basin floor. The observation stood; only
   the cause attribution was wrong.
2. I cannot independently re-run the `key.castShadow=false` differencing experiment (I may
   not run `capture.mjs`), so I take the 26%-of-pixels / 1.58× figures as unverified. What I
   *can* verify is that they are corroborated by outcome: round 4 changed the light *balance*
   only — `FILL` from floor to scale, `KEY_GAIN 2.5`, rim 1.45→0.42 — and did not touch the
   shadow tier, yet cast shadows went from invisible to unmistakable. A fill change alone
   cannot conjure a shadow map that was not reaching. The mechanism claim holds.

**Verdict on the framing "W4 and the key/fill overcorrection were ONE defect, the fill was
eating the key": substantially right, about 80%.** Cutting the fill made the existing shadows
read, exactly as claimed, and that is the single change that moved axis 1 from 4 to 7–8. It
is not fully one defect, because the residual in 02-vista is not a contrast problem: the
basin floor has no shadow *shape* on it at any contrast, which is a caster-placement and
camera-bearing problem, not a light-ratio one.

**Correction 2 — the key/fill rebalance: LANDED, claims broadly reproduce.**

| claimed | measured this round |
|---|---|
| lit:shadow p50 1.61 → 2.38 | not directly reproducible (no per-material segmentation), but every valid same-prop pair lands at 2.01–4.80; median of the seven valid pairs ≈ 2.7 |
| p90 2.43 → 4.01 | monolith mid/low at **4.80 / 4.74** — consistent |
| cast-shadow luma removal 1.58× → 2.0× | **2.6–3.5×** measured across tree-shadow edges in 07 (147→43, 152→44, 116→44); **2.5×** across the 02-vista terrace penumbra (92→37). Beaten. |
| sub-L24 held: 07 19.97% → 2.58% | **2.880% all-px, 1.590% non-HUD.** Reproduces. |
| sub-L24 held: 02-vista 1.45% → 1.04% | **does not reproduce.** I measure **1.581% all-px** (1.479% Rec.601). The world got brighter — non-HUD went 0.41% → **0.137%** — but all-px ticked *up*, and the residual is HUD panel interiors, not world. Directionally right, the specific figure is not. |
| — | ≤RGB(6,6,6) non-HUD: **0.0000%** (02-vista), **0.0011%** (07). No crush anywhere. |

### 2b. OVERCORRECTION — the teal accent. **CONFIRMED, and it is the largest new defect.**

`src/world/Materials.js:481` — `crystalClusters: 12, crystalPer: [8,12], crystalScale: [2.4, 6.2]`
(was `[1.2, 4.2]`) — plus the 48-instance hero vein at `src/world/Props.js:682-701`, whose
own scale ramps to `crystalScale[1]` = 6.2 u. That is ~145–190 crystal instances at up to
6.2 u in one arena.

Measured coverage (round-2 mask `g>90 ∧ b>90 ∧ g>1.35r ∧ b>1.2r`):

| | round 3 | round 4 | target |
|---|---|---|---|
| 02-vista, all px | 0.090% | **2.549%** (2.684% non-HUD) | 0.6% |
| 07-interactables, all px | — | **4.416%** (4.817% non-HUD) | 0.6% |
| 01-title, all px | — | **1.039%** | — |

That is **28× round 3 in 02-vista, not the ~6.9× the fixer estimated**, and 4.2×/7.4× *over*
the target it was aiming at. Roughly 0.94% of the 02-vista figure is the teleporter beam
(components at x 618–728, y 29–285), so crystal-only coverage there is ≈1.6% — still 2.7×
over.

The reason it reads as too loud is not coverage alone, it is **hierarchy inversion**:

```
07-interactables   teal mask: 61,745 px, mean L 202.7, mean sat 0.36
                   rest of frame:        mean L  82.9, mean sat 0.47
                   largest single teal component: 48,027 px = 3.3% of the frame
                   the subject (chest):  mean L 131.4, sat 0.11
02-vista           teal mask: 34,403 px, mean L 173.4  vs  rest mean L 77.1
```

In the shot whose documented job is "judges prop modelling and pickup VFX", **the accent is
71 luma brighter and 3× more saturated than the subject**, occupies one contiguous 3.3% blob
immediately left of it, and wins the eye. In 02-vista the accent forms a continuous hedge
across the midground (12 of 32 50-px column bands carry > 200 teal px). `Props.js:689-691`
anticipates precisely this — "an accent that fills a third of the frame has stopped being an
accent" — and the limiter it installed was not tight enough.

The *placement* half of the fix is correct and should be kept: the vein does sit on the
composition axis (teal concentrates in the x 600–800 band, where the beam, the player and the
arch are). It is count and scale that overshot.

**Fix:** `Materials.js:481` → `crystalClusters: 5, crystalPer: [5, 8], crystalScale: [1.8, 4.6]`,
and cap the `Props.js:682` vein at 20 instances. Verify: teal 0.5–1.0% of 02-vista and
< 1.5% of 07, no single connected component above 1.2% of frame, and in 07 the subject's mean
luma must exceed the accent's.

---

## 3. FINAL PER-AXIS VERDICT — does it clear 7 in this domain?

Ruling convention: "clears" means 7+ on **every** judged shot.

### Axis 1 — Lighting & shadow (7 / 7 / 8) — **YES. Cleared.**
Round 3's hard blocker is closed. There is one committed key direction, a 4.8:1 terminator on
the same material, complementary violet in every shadow probe, genuine contact darkening at
boulder/prop bases, and in `07` the long raking articulated cast shadows the rubric's
nine-point text asks for. It is not a 9 in 02-vista because the basin floor — the largest
single surface in the establishing shot — carries no shadow *shape*, and because the frame's
central hero prop, the stone arch, measures crown-top L 119.5 against crown-underside L 101.5
(**1.18:1**) and reads flat-lit. **Gap to 9 is fixable in code**: pick the establishing
bearing so the sun rakes across the basin rather than along it, and give the arch a
self-shadowing under-surface.

### Axis 2 — Composition & depth (7 / 7 / 5) — **NO.**
Both wide shots now have a real four-plane stack (02-vista: near L 41.3 → mid 54.0 → far 88.9
→ sky 65.1, skyline median at y 354 = **39.3%** of frame height, inside the 32–42% window that
round 3's W14 overshot at 11.0%). `07` fails: ≈19.6% of the frame is a contiguous dead
foreground of three untextured triangles, and its background (L 44.3) is darker than its
foreground (L 45.6), so aerial perspective runs backwards. **Fixable in code** — this is the
camera-bearing rejection test round 3 prescribed at `Harness.js:192-231` and it was not built.

### Axis 3 — Colour & grade (6 / 7 / 6) — **NO.**
02-vista clears: limited amber/violet complementary palette, filmic rolloff, 0.006% clipping,
no banding, and now one accent instead of none. It is held to 7 rather than 8 by the accent's
uniform synthetic cyan. `07` and `01-title` sit at 6 for two different reasons: 07 because the
subject is a desaturated cool grey (sat **0.11**, hue 261°) belonging to no part of the
palette *and* the accent outshouts it; the title because at frame mean L 39.4 and 49.8% of
pixels in the bottom two buckets it still reads muddy in its lower half. **Both fixable in
code** (crystal budget; chest albedo; one more cut to the title scrim stops).

### Axis 4 — Silhouette & form (7 / 6 / 5) — **NO.**
Genuine wins: varied scale is now real in 02-vista (27 m monolith / 6 m arch / boulders /
floating islands / a 1.8 m player), and 07's dead trees read as pure black silhouettes with
articulated branches. Two failures hold it: (a) the chest is a rounded slab whose outline is
one convex blob — the lid/body/hinge break exists only in its interior, never on the
silhouette; (b) the crystals are ~150 instances of the same spike shape with the scale ramp
being the only variation, which is the rubric's four-point "everything the same size" locally.
(a) is a **hand-authored-asset ceiling** — no shader or parameter makes a procedurally
extruded chest read; it needs modelling. (b) is fixable in code with 2–3 geometry variants.

### Axis 5 — Material believability (6 / 7 / 6) — **NO.**
This axis moved further than any except 1. The roughness ladder now *reads*: metal peaks at
L 254 with a cloudy roughness-map break, the stone arch carries real grain and strata, terrain
is unambiguously matte beside it, and specular above L 200 exists on non-emissive props in
both world shots (16,856 px on the 02-vista monolith alone). Held under 7 by the chest, which
is uniform smooth-shaded plastic with no texture, no fittings and no wear, in the one shot
documented as judging prop modelling — and secondarily by the arch reading matte and by the
metal's specular being achromatic white (255,255,244) under a 34°-hue sun when it should carry
the light's colour. The white-specular part is **fixable in code**; the chest is an
**asset ceiling**.

### Axis 6 — VFX quality (4 / 4 / 3) — **NO.** *(outside this domain's area)*
Nothing in these three frames layers. 02-vista has a hard-edged single-layer additive
teleporter column whose base does not interact with the ground, plus dust motes; 07 has dust
motes and a 12 px interact glyph; the title has nothing. No distortion pass, no soft-particle
depth fade, no motion arcs. Fixable in code, but not by the world/lighting workstream — it
belongs to whoever owns the VFX area and was never in scope for these four rounds.

### Axis 7 — UI/HUD craft (8 / 7 / 7) — **YES. Cleared.**
Dense angular identity, real hierarchy, deliberate letterspacing, consistent spacing, never
obscures the action. The round-3 blemish (2.60:1 labels) is fixed to 13.65:1 / 10.83:1. This
is the only axis that has cleared in all four rounds.

### Axis 8 — Readability under load (8 / 6 / 6) — **NO.**
Held at 6 on both world shots by the same cause, and it is the accent. In 07 the accent
out-values the subject by 71 luma; in 02-vista the player is a ~14 px near-white figure
standing directly in front of the brightest column in the frame with the crystal hedge behind
him. **Fixable in code** and it is the same one-line fix as §2b.

### Axis 9 — Post-processing (6 / 8 / 8) — **NO by the strict rule; effectively yes for the world.**
Both world shots are an 8: bloom on emissives and the sun only (0.82% / 0.32% above L 235,
zero near-white world pixels), clean AA, no banding (max identical-colour run 4 px down the
sky gradient), grain surviving into the shadows, and a vignette measured at −1.4% to +2.6%
across a flat field. The axis is held off a clear only by `01-title`, whose background blur
shows hard directional streak artefacts around the teal mass at x 1331–1483 rather than a
clean bokeh. **Fixable in code** (the title backdrop blur kernel).

### Axis 10 — Cohesion (7 / 7 / 5) — **NO.**
02-vista is one authored world — terrain, props, sky, fog and grade all agree in hue and in
value, and the round-3 charge of "a flat vector triangle in a 3-D frame" no longer applies to
anything in it. `07` is dragged to 5 by a single object: the chest is smooth-shaded, neutral,
untextured and cool, in a world of hard-faceted saturated warm rock. It is round 3's X1
defect relocated to a different prop. **Asset ceiling**, mostly: the chest needs to be
authored to the same faceted vocabulary as everything around it.

### Ledger
- **Cleared 7 on every judged shot: axes 1 and 7.** (Round 3: axis 7 only.)
- **Effectively cleared for the world, blocked by one non-world shot: axis 9.**
- **Within one point on at least two shots: axes 2, 3, 5, 10.**
- **Still far: axes 4, 6, 8.** Of these only 6 is out of area.

---

## 4. Remaining defects, ranked

**1. The teal accent is 4–7× over budget and out-values the subject. [AREA D]**
`src/world/Materials.js:481` · `src/world/Props.js:682-701`
Teal 4.416% of 07 (one 48,027 px component, mean L 202.7) against a subject at L 131.4;
2.549% of 02-vista. Costs axes 3, 4, 8 and 10 on 07 and holds axis 3 off 8 on 02-vista.
**Fix:** `crystalClusters: 5, crystalPer: [5,8], crystalScale: [1.8,4.6]`; cap the hero vein
at 20. **Verify:** teal 0.5–1.0% of 02-vista, < 1.5% of 07, no component > 1.2% of frame, and
the subject's mean luma must exceed the accent's in 07.

**2. The chest is an untextured neutral slab in a faceted warm world. [AREA D]**
Subject mean sat **0.11**, hue **261°** against a frame hue of 19°; one convex silhouette with
no lid/hinge/lock break on the outline; zero surface incident. Single biggest cost to axes 4,
5 and 10 on 07. **Fix:** author it to the same vocabulary — flat-shaded facets, a warm
metal band with `IRON_DARK`'s roughness so it catches the same specular the monolith does, and
an albedo inside the palette. **Verify:** at least three distinct luma plateaus across the
body, one specular above L 180 on the banding, and a silhouette with ≥ 2 concave features.
*This one is an asset-authoring job, not a parameter.*

**3. `07`'s lower-left ≈19.6% is three untextured triangles. [AREA F]** (carry-over X2)
`src/core/Harness.js:192-231`
Largest connected low-detail region 6.14%, but 6.14 + 5.30 + 4.80 + 3.32% are adjacent and
read as one dead zone. The round-3 prescription — reject a bearing if > 12% of lower-quadrant
rays hit terrain closer than 0.35× the subject distance — was not implemented.
**Verify:** total low-detail area below y = 500 and left of x = 650 under 8% of frame.

**4. 02-vista's basin floor still carries no shadow shape. [AREA C]** (carry-over X4)
≈30% of the establishing frame is one ambient mass. The mechanism works; the geometry does
not put a caster where the sun can throw one across the visible floor. **Fix:** in the vista
bearing selection, prefer an azimuth where `dot(sunGroundVector, cameraRight)` is between 0.3
and 0.8 so shadows rake across the frame rather than along the sight line, and place two or
three tall casters on the basin's sun-side rim. **Verify:** one contiguous sub-L45 region
> 4000 px on the basin floor whose long axis lies within 20° of the projected −sunDir.

**5. The stone arch, 02-vista's centre-frame hero prop, is flat-lit. [AREA C/D]**
Crown top L 119.5 / crown underside L 101.5 = **1.18:1**, against 4.80:1 on the monolith
30 m away. It reads as a cardboard cut-out at the exact point the crosshair sits.
**Fix:** it is a thin curved shell whose underside sees almost the same hemisphere as its top;
thicken it or add an AO-darkened inner face. **Verify:** ≥ 2.2:1 top-to-underside.

**6. `01-title` is still 49.8% in the bottom two luminance buckets. [AREA C]** (carry-over X11)
`src/ui/hud.css:1046-1055`
Frame mean L 39.4 against the file's own stated 45–55 target and round 2's > 55. Contrast
headroom is enormous (plate-to-glyph 12.3–18.8:1), so the scrim can come down again.
**Fix:** horizontal stops to `0.44 / 0.30 / 0.06 / 0`, vertical to `0.14 / – / – / 0.18`.
**Verify:** frame mean L ≥ 50 and bottom-2/16 < 35% with glyph CR still ≥ 4.5:1.

**7. Metal's specular is achromatic. [AREA D]**
RGB(255,255,244) at L 254 under a hue-34° sun. A dielectric highlight should carry the
light's colour and a conductor should carry its own. Cheap and visible.

**8. `01-title`'s background blur streaks. [AREA C]**
Hard directional streak artefacts around the teal mass at x 1331–1483; the only thing holding
axis 9 off a clear.

**9. The crystal geometry is one repeated spike. [AREA D]**
~150 instances, one mesh, scale as the sole variation. Two or three `crystalGeo` variants
would cost nothing and buy axis 4.

**10. `src/world/Props.js.bak` is still checked into the tree.** Non-visual; noted for the
fourth round running.

---

## 5. Honest closing statement, per the rubric's stopping condition

Four rounds moved this from 4.3 / 4.6 / 2.8 to **6.6 / 6.6 / 5.9**. Two axes now clear 7 on
every judged shot (lighting & shadow, UI/HUD) where round 3 had one, and a third
(post-processing) clears on both world shots. **The build does not pass**, and it will not
pass on the remaining axes for two different kinds of reason, which are worth separating:

- **Axes 2, 3, 8 and 9 fall short for reasons that are entirely fixable in code**, and three of
  the four trace to a single overcorrected parameter block (`Materials.js:481` /
  `Props.js:682`) plus one unimplemented camera test (`Harness.js:192-231`). These are the
  cheapest points left on the board by a wide margin.
- **Axes 4, 5 and 10 are capped by hand-authored asset quality**, and specifically by one
  object: an interactable chest with no modelling, no material and no silhouette, sitting at
  frame centre of the shot that exists to judge prop modelling. No lighting or grading change
  reaches it. The same ceiling applies more mildly to the arch and to the single crystal mesh.
- **Axis 6 was never in this workstream's scope** and has not moved in four rounds; nothing in
  any judged frame layers a VFX effect.

The lighting subsystem's own work is, in my assessment, done. The terminator, the cast
shadows, the sky, the vignette, the specular ladder and the shadow-side colour are all at or
above the bar, and I was wrong in round 3 about why the shadows were missing — the tier was
never the problem, the fill was. What is left standing between this build and a pass is
mostly art assets and one camera heuristic, not light.

---

## 6. Method / evidence

Three PNGs decoded directly with a hand-written decoder (Node `zlib` + Paeth/Sub/Up/Average
unfilter). Scripts in the session scratchpad at `…/9f539f6c-…/scratchpad/r4c/`:

- `a_stats.mjs` — frame means, 16-bucket luma histograms, sub-L24 (Rec.709 and Rec.601, all-px
  and non-HUD), ≤RGB6 / pure-black / clipped-white fractions, 12-bucket hue histograms.
- `b_sky_teal.mjs` — skyline detection, sky-band hue histograms and the 190–240° window,
  top-of-frame and vertical sky probes, teal mask + connected-component sizing on all three
  shots.
- `c_shadow.mjs` — lit/shadow pair sampling, connected-component analysis with second-moment
  elongation and principal-axis angle.
- `d_crop.mjs` / `g_crop2.mjs` — PNG encoder, nearest-neighbour magnification and gamma boost;
  produced the 11 + 6 inspection crops referenced above.
- `e_profiles.mjs` — row/column luma profiles across shadow boundaries, shadow-vs-lit colour,
  specular census by 40 px cell, per-prop maxima.
- `f_misc.mjs` — vignette luma-vs-radius on three flat fields, 11 px local-range flatness maps,
  low-detail area, depth ladders, HUD-masked specular hunt, red-cone census, WCAG contrast.
- `h_shadowtest.mjs` — local-p95 shadow-candidate mask plus components.
- `i_penumbra.mjs` — per-pixel scans across shadow edges with hue, penumbra widths.
- `j_final.mjs` / `k_last.mjs` — same-prop lit:shadow pairs, facet disagreement, largest
  connected low-detail region, skyline height, bloom census, banding run-lengths, subject-vs-
  accent salience, teal column distribution.

Source read for attribution only, no file modified: `tools/capture.mjs`, `src/main.js`,
`src/core/RenderPipeline.js`, `src/world/Environment.js`, `src/world/Materials.js`,
`src/world/Props.js`, `src/shaders/SkyShader.js`, `src/shaders/GradeShader.js`.
