# PETRICHOR — Round 2 critique: WORLD / LIGHTING

Critic domain: axes 1 (lighting & shadow), 2 (composition & depth), 3 (colour & grade),
5 (material believability), 9 (post-processing), 10 (cohesion).
Reference target: Risk of Rain 2 — Titanic Plains / Abandoned Aqueduct / Rallypoint Delta.
Shots judged: `shots/01-title.png`, `shots/02-vista.png`, `shots/07-interactables.png` (seed 1337, 1600x900).

`shots/manifest.json`: `ready: true`, `errors: []`, every judged shot `frameErrors: 0`,
`newErrors: []`. **No crash to report.** Every defect below is a look defect, measured
off the pixels.

---

## 1. Axis scores

| # | Axis | 01-title | 02-vista | 07-interactables |
|---|------|:--------:|:--------:|:----------------:|
| 1 | Lighting & shadow | 3 | 4 | 2 |
| 2 | Composition & depth | 4 | 5 | 2 |
| 3 | Colour & grade | 3 | 4 | 2 |
| 4 | Silhouette & form | 3 | 5 | 2 |
| 5 | Material believability | 3 | 3 | 2 |
| 6 | VFX quality | 4 | 4 | 4 |
| 7 | UI/HUD craft | 7 | 7 | 6 |
| 8 | Readability under load | 7 | 4 | 2 |
| 9 | Post-processing | 5 | 6 | 3 |
| 10 | Cohesion | 4 | 4 | 3 |
| | **mean** | **4.3** | **4.6** | **2.8** |

```
01-title          AXIS SCORES: 1:3 2:4 3:3 4:3 5:3 6:4 7:7 8:7 9:5 10:4   VERDICT: FAIL
02-vista          AXIS SCORES: 1:4 2:5 3:4 4:5 5:3 6:4 7:7 8:4 9:6 10:4   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:2 2:2 3:2 4:2 5:2 6:4 7:6 8:2 9:3 10:3   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Fourteen
axes across the three shots score 4 or lower. `07-interactables` is close enough to the
rubric's "black, empty or single-colour frame" clause to be an automatic fail on its own:
20.2% of its pixels are at or below RGB(6,6,6), and 19.7% of the judged area carries
*zero* local detail — the shader's own film grain is invisible there because the value has
been clamped to floor.

### What is genuinely working (so the fixer does not break it)
- **No banding.** A 190-row sky column in 02-vista carries 137 distinct colours, longest
  flat run 3px. The luma-weighted grain in `GradeShader.js:85-87` is doing its job.
- **Edges resolve.** Mountain/sky boundaries transition over 1–2px. SMAA is working.
- **Bloom is restrained.** 0.01% clipped-white in 02-vista; the threshold-above-1.0
  design in `RenderPipeline.js:22` is correct and should not be touched.
- **The near→far value ramp exists.** Median value 48 (foreground ground) → 74 (midground)
  → 127 (far massif). That is a real aerial-perspective *value* ladder. The problem is the
  *hue* on top of it (W5).
- **The HUD is the most confident thing on screen** in all three shots.

---

## 2. Ranked defect list

Ranked by rubric cost. `AREA C` = lighting / post / grade / sky / environment.
`AREA D` = terrain / props / materials / interactables. `AREA F` = camera framing.

---

### W1 — `07-interactables` has no interactable in it. **[AREA F]**
`src/core/Harness.js:132-152`

**Pixels:** the shot whose stated job is "chest / shrine / item pickup close-up" contains
no chest, no shrine and no chest-like prop. The centre of frame (x 545–880, y 110–830,
~17% of the image) is one blank tan quad 1–2m from the near plane — a prop the camera is
standing inside. The only interactable-ish object in the frame is a glowing blue drone at
(390–500, 285–350) — 0.4% of the image, jammed against the bottom edge of the inventory
panel. Nothing in the frame is on the axis the crosshair points at.

**Cause:** `interactables()` picks the interactable nearest the *player* (lines 135-141),
then parks the camera at a hardcoded `t + (4.5, 2.6, 4.5)` with `lookAt(t + (0,0.8,0))` at
FOV 45. There is no line-of-sight test and no minimum standoff, so any target with a
boulder, pillar or terrace riser on its +X/+Z diagonal produces this frame. `ctx.stage`
already exposes `raycast(origin, dir, maxDist)` (CONTRACTS.md).

**Fix:** prefer a *chest* over "nearest anything" (filter the list by kind). Then sweep
16 azimuths at radius 5.5 and elevation 2.4, and accept the first whose
`ctx.stage.raycast(camPos, normalize(target − camPos), dist)` returns null or a hit beyond
`dist − 0.3`. Bias the accepted azimuth toward `+environment.sunDir` so the chest is
cross-lit, not backlit. If no azimuth is clear, walk the radius out to 9 before giving up.

---

### W2 — Shadow side of the world clips to pure black; there is no ambient floor. **[AREA C]**
`src/world/Environment.js:250, 277, 285-289` · `src/shaders/GradeShader.js:89`

**Pixels:** in 07, a 300×100 sample of shadowed terrain at (900,750) averages
RGB(4.2, 4.5, 11.5) — 2% luminance — with a maximum of (9,9,19). The whole right-hand
wedge (400×300 at (1050,300)) averages (16,14,35). 20.2% of the frame is at or under
RGB(6,6,6). The proof that this is *clipping* and not merely darkness: the grade adds
animated grain everywhere at up to ~2.5/255 in shadows, yet a 11px local min/max sweep
finds a luminance range **below 2** across 19.7% of the judged area — the grain has been
clamped off at `clamp(col, 0.0, 1.0)` (GradeShader.js:89). The rubric's 4-point
description of axis 1 is "shadows absent or uniformly grey"; this is worse — uniformly
black, with no bounce hue, no rim, and no crevice detail because there is no value left to
carry it. RoR2's Abandoned Aqueduct interiors never fall below ~8% value; the shadow side
is *blue*, not empty.

**Cause:** hemisphere at 0.50 (`Environment.js:277`) + `environmentIntensity` 0.55
(`:250`) + a single non-shadow-casting rim at 1.45 (`:285`) is the entire fill budget, and
the rim only lights surfaces facing `-sunDir`. Surfaces facing away from *both* get
hemisphere alone at grazing incidence, which lands under 1% linear. The 0.42 vignette
(`RenderPipeline.js:388`) then takes another 20–42% off anything away from centre.

**Fix:** three changes, all uniform-level so no shader is invalidated.
1. Raise `hemiIntensity` 0.50 → 0.85 and `envIntensity` 0.55 → 0.80 in `BIOMES[0].light`
   (`Materials.js:356-359`). This is the fill the key has to carve into; the current value
   was tuned against a frame that had no dark side in it.
2. Warm the ground half of the hemisphere: `hemiGround` 0x6b4638 is nearly black in linear
   (linear ~0.15,0.07,0.04). Lift to ~0x8a5c46 so the bounce reads as bounce.
3. Add a shadow lift in the grade: `uLift` is currently (0.006, 0.010, 0.022) — a 2% floor.
   Raise the blue/violet lift to ~(0.012, 0.016, 0.040) so the darkest surface in frame
   lands at ~4% value *in the sky's own hue* rather than at 0. Verify by re-running the
   flat-area metric: the near-black fraction of 07 must drop below 3%.

---

### W3 — The title screen is a black frame with a logo on it. **[AREA C]**
`src/ui/hud.css:981-987` · `src/ui/Menus.js:531-542`

**Pixels:** 61.6% of `01-title` sits in the bottom 1/16 luminance bucket and 84.4% in the
bottom 2/16. Frame mean is RGB(24.4, 22.5, 26.0). Samples: (100,100)=(7,7,10),
(200,700)=(4,4,9), (800,850)=(2,3,7), and even at the *lightest* corner of the scrim
(1540,450)=(8,11,19). The CSS comment on line 978 says "the scrim has to sit behind the
type rather than erase the shot" — it erases the shot. Boosting the frame by gamma 2.0
reveals a perfectly serviceable warm vista underneath: mountains, floating islands, a lake,
a lit basin. None of it is visible at authored exposure. RoR2's menu shows a readable,
moving environment with the panel as a *layer over* it, not a blackout.

**Cause:** the title scrim runs `rgba(2,4,7,0.88)` at the left stop and `0.18` at the right,
multiplied by a second vertical pass of `0.55` top / `0.60` bottom. Combined alpha at the
top-left exceeds 0.94, so 6% of the scene survives.

**Fix:** cut the horizontal gradient to `0.72 / 0.52 / 0.16 / 0.00` and drop the vertical
pass to `0.30 / transparent 40% / transparent 62% / 0.34`. The title lockup already carries
its own dark plate behind the wordmark (visible at 320–1210, 235–410) and does not need the
scrim for contrast. Target: the 01-title frame mean above 55/255 and under 35% of pixels in
the bottom 2/16 buckets, with the wordmark still passing 4.5:1 against what is behind it.
Additionally, `Menus.js:533` orbits at `dt * 0.06` rad/s starting at angle 0 — at t=0 the
camera sits at `centre + (34, 16, 0)` looking down-sun, which is the flattest bearing
available. Offset the start angle by ~2.2 rad so the first frame the player ever sees is
cross-lit.

---

### W4 — The establishing shot has no cast shadow in it. **[AREA C + AREA F]**
`src/world/Environment.js:28, 35, 52-57` · `src/core/Harness.js:81-93`

**Pixels:** 02-vista contains a 27m monolith, six floating islands, four stone arches, a
field of ~260 boulders and ~110 dead trees. Not one of them lays a readable shadow on the
ground. Boosting the foreground (0,470)-(800,900) by gamma 1.45 shows only per-triangle
value scatter — no long-axis dark shape anywhere, no contact darkening under a single
boulder, no shadow pool under any of the floating islands. This is the literal axis-1
failure text: "everything equally lit". RoR2's Titanic Plains at low sun is *defined* by the
long shadows the rock spires throw across the grass.

**Cause is a stack, not one line:**
- `SHADOW_EXT = 80` half-extent is centred on the **player** (`Environment.js:353-357`),
  not on the camera frustum. The vista camera sits 60m from the player looking *away*, so
  a large part of what the frame shows is outside the shadow frustum entirely.
- Sun elevation 18° gives a 3:1 shadow, but the floating islands sit 16–40m above ground
  (`Materials.js:346`); their shadows land 50–120m from their own footprint, which is
  outside a ±80 box in almost every case.
- The `Environment.js:24-27` comment claims this sun angle "leaves the vista camera
  cross-lit"; the horizontal angle between the vista view vector and the sun azimuth is
  73.6°, which is cross-lit *on paper*, but the shadow-frustum coverage above means none of
  it lands in frame.

**Fix:** centre the shadow frustum on a point ahead of the *camera* rather than on the
player — `focus = camera.position + camForward * (SHADOW_EXT * 0.55)`, projected to ground
— keeping the existing texel snap. Then widen the ULTRA tier to `ext: 110, map: 4096`
(0.054 u/texel, still sharper than the pre-fix 0.115) so island shadows land inside the
box. Verify by re-shooting the vista and confirming at least one contiguous dark region
>4000px whose long axis runs along the projected `-sunDir` ground vector.

---

### W5 — The far massif is steel blue on a magenta sky; the fog and the sky are different paintings. **[AREA C]**
`src/world/Materials.js:35` (fog `0x9fb0c6`) vs `src/shaders/SkyShader.js:71-96`

**Pixels:** in 02-vista, sky directly above the central peak at (640,205) is
RGB(167,79,92) — hue 352°, magenta-red. The peak body 45px below at (640,250) is
RGB(99,109,124) — hue 213°, cool blue. The two are 139° apart in hue and the *mountain is
lighter* than the sky above it (L 108 vs 99). Result: the massif reads as pale blue paper
cut out and pasted onto a pink backdrop, not as distance. Hue histogram of a 180×120 block
of the far massif: 56% of saturated pixels in the 210–240° bucket. Aerial perspective is
supposed to converge distant geometry *toward the sky behind it*; at sunset that means the
far ridges go warm-pink near the horizon and only cool as they rise.

**Cause:** `PALETTE.fog` is a fixed cool `0x9fb0c6` for every view direction and every
altitude (`Environment.js:77`, `Materials.js:35`), while the sky in the same band is a
magenta/amber mix. The comment at `Materials.js:32-35` describes the intent honestly; the
pixels show the intent producing a hue collision because the fog does not track the sky.

**Fix:** the cheapest correct version, and the one that costs no shader fork, is to warm the
fog toward the sky's horizon band and let the sky's own horizon glow carry the rest:
set `BIOMES[0].fog.color` to ~`0xc9a9b4` (a desaturated warm mauve halfway between the sky's
magenta band and the current blue) and drop `density` 0.0036 → 0.0030 so the massif keeps a
little of its own hue. Verify: the hue delta between the sky sample at (640,205) and the
peak body at (640,250) must fall under 45°, and the massif must sit *darker* than the sky
directly above it, not lighter.

---

### W6 — The terrain is per-facet hue confetti: warm and cool alternating at the 1.4m facet scale. **[AREA D]**
`src/world/TerrainGen.js:326-327` (`cliffT = invLerp(0.40, 0.72, slope)`)

**Pixels:** a 360×180 block of foreground ground in 02-vista (200,600) splits its saturated
pixels **37% into the 0–30° ochre bucket and 57% into the 240–360° blue-violet buckets**,
with no dominant family, at a spatial frequency of a few pixels. Boosting the foreground
makes this unmistakable: adjacent triangles jump between warm ochre and cold violet with no
form-following pattern, so the landform under them is unreadable and the key light's
modelling is buried in the noise. Worse for depth: the far massif is also 56% blue
(210–240°), so foreground and background share the *same* hue family — the palette comment
at `Materials.js:8-11` promises "near/mid/far separate by hue as well as by value" and the
pixels deliver separation by value only.

**Cause:** the cliff colour `0x5a5060` (violet, 277°) is bound to `slope`, which is
computed from the **raw face normal** of a 1.375m triangle (`TerrainGen.js:253`). The
terrace pass (`:176`, step 3.0m, blend 0.2) and the detail octave (`:164`, amplitude 1.9m
at ~13m wavelength) both flip the per-facet slope past the 0.40 band edge every couple of
triangles. So a 100%-hue-shift is being driven by the noisiest signal in the mesh.

**Fix:** drive `cliffT` from a *smoothed* slope. In `emit()` (`:239-258`), replace the
per-face `slope` passed to `_faceColor` with one derived from a wider stencil — e.g.
`1 - this.sampleNormal(mx, mz).y` using a step of `3 * this.step` — so the cliff band
follows sustained steep ground rather than individual risers. Then narrow the band from
`invLerp(0.40, 0.72)` to `invLerp(0.55, 0.80)`. Verify: the foreground block's dominant hue
bucket must reach ≥60% of saturated pixels.

---

### W7 — Every surface in the world is the same matte; there is no roughness contrast and no specular anywhere. **[AREA D]**
`src/world/Materials.js:208-283` · `src/world/Props.js:250-263`

**Pixels:** 02-vista contains stone terrain, "wet stone", corroded metal ruin, dead wood and
sand, and there is not one specular highlight in the frame at any of them — no bright edge
on the arch metal, no wet sheen, no grazing hotspot on any rock. `wetStone` is authored at
roughness 0.28 and `metalRuin` at metalness 0.85 / roughness 0.52 (`Materials.js:247-263`),
i.e. the code has the contrast; the frame does not show it, because the only bright source
is a 18°-elevation key that is behind the camera in this framing (W4) and a 0.55-intensity
IBL. The rubric's 4-point text is "uniform matte plastic on every surface" — that is the
frame.

The worst single offender is the **hero monolith**, the largest object in the establishing
shot. A 7x zoom of its lit face (900–1040, 310–370) shows a smooth airbrushed orange
gradient with soft blurry blotches and *no rock incident at all* — no strata, no chips, no
colour break, no facet reads. `monolithGeo` (`Props.js:250-263`) is a `BoxGeometry(1,1,1,3,10,3)`
deformed by 0.055 of a unit — 5.5% wobble on a 27m form, i.e. ~1.5m, invisible at this
scale — and its material tiles the stone set at `repeat 1.6` (`Materials.js:219`) over a
27m object, putting one noise cycle every ~17m. That is why the surface reads as a soft
gradient. Meanwhile the terrain beside it is hard-faceted. They read as two different art
styles in the same frame (axis 10).

**Fix:**
1. Give the hero props their own UV scale. `facet(geo, uvScale)` already takes one
   (`Props.js:68`); `monolithGeo` passes 0.25. Because the monolith is placed at scale ~27,
   the effective world tiling is 27/0.25 ≈ 100m. Pass `facet(g, 4.0)` for the monolith (and
   the hero arch) so the stone cycle lands at ~7m — several facets wide at vista range and
   still readable up close.
2. Raise `deform(g, noise3, 0.055 → 0.13, 2.4 → 4.5, …)` on `monolithGeo` and bump the box
   segments from `3,10,3` to `4,16,4`, so the silhouette gains chips and the faces gain
   plane breaks.
3. Reduce `wetStone` roughness 0.28 → 0.20 and *place* wetStone props where the key can
   actually rake them (currently indistinguishable from `rock` in every judged shot).
   Verify: a specular hotspot above 200/255 must be findable on at least one non-emissive
   prop in the re-shot vista.

---

### W8 — The palette's one accent colour is absent. **[AREA D]**
`src/world/Materials.js:42-43, 344` (`crystalClusters: 6`)

**Pixels:** the palette declares exactly one accent — crystal teal `0x39d6d2` with an
emissive `0x1fa9b4` at intensity 1.9. In 02-vista, pixels matching a teal test
(`g>90 && b>90 && g>1.35r && b>1.2r`) come to **0.098% of the frame** — two or three
specks, none of them a focal point. The rubric's 9-point text is "a limited harmonious
palette with **one accent**"; the accent has to be visible for that to be worth anything.
RoR2 uses its blue crystal/aqueduct-teal as a wayfinding beacon, at readable size, in the
composition.

**Fix:** raise `crystalClusters` from 6 to 12 and `crystalScale` from `[0.8, 3.0]` to
`[1.2, 4.2]` in `PROPS_DEFAULT` (`Materials.js:344`), and bias their placement toward the
basin rim so a camera anywhere in the arena has one in frame. Because the crystal material
is emissive above the bloom threshold, this also gives the frame the one legitimate bloom
source it currently lacks. Verify: teal fraction of the re-shot vista ≥ 0.6%, with at least
one cluster subtending >40px.

---

### W9 — Damage-number ghosts read through solid geometry, mirrored, across the whole 07 frame. **[out of my areas — logged for the VFX owner]**

**Pixels:** a high-pass of `07-interactables` shows numeric glyphs ("1972", "1358", "431",
"1207"-shaped) rendered **mirrored** and at very low contrast in at least three places:
across the top of the centre slab (600–970, 150–195), across the slab and the black wedge
at (830–970, 445–565), and on the orange terrace at the left at (140–340, 385–500). They
appear over surfaces at three different depths and are legible *through* the opaque centre
slab. Two failures at once: the sprite is not billboarded (we are seeing the back of the
quad, hence mirrored) and it is not depth-tested against world geometry.

Not in AREA C/D/F — this belongs to whoever owns `src/systems/VFX.js` (the damage-number
sprite path, around `VFX.js:1780-1795`). Flagged because it costs axis 9 and axis 10 on the
shot and would otherwise be scored against the world domain.

---

### W10 — The vignette takes 17% off the frame edges and it is stacked on an already-dark image. **[AREA C]**
`src/core/RenderPipeline.js:388` (`uVignette = 0.42 + boost`) · `src/shaders/GradeShader.js:79-80`

**Pixels:** across a flat sky row at y=130 in 02-vista, luminance peaks at frame centre
(x=800, L=77.7) and falls **symmetrically** to both edges (x=40, L=64.7; x=1350, L=66.2) —
a −17% dark rim. Symmetry about the centre rules out the sky's own azimuth variation. On a
clean gradient this reads as a visible ring, and on 07 it is a multiplier on top of the
black crush (W2): at the corners `mix(1, vig, 0.42)` bottoms out at 0.58.

**Fix:** drop the base from 0.42 to 0.26 and open the inner stop:
`smoothstep(0.95, 0.22, …)` → `smoothstep(1.02, 0.40, …)` so the falloff starts outside the
action-safe area instead of at 40% of the radius. Leave `vignetteBoost` alone — a punchy
vignette on a hit is correct; a permanent one is not. Verify: the centre-to-edge luminance
delta on a flat sky row must fall under 8%.

---

### W11 — The sky never shows the zenith blue the palette promises, and its clouds are invisible. **[AREA C]**
`src/shaders/SkyShader.js:71, 105-108` · `src/world/Materials.js:24-29`

**Pixels:** a vertical scan of the 02-vista sky at x=640: y=110 (126,57,84), y=150
(142,65,88), y=190 (160,75,91), y=210 (170,81,93). Every sample is a pink/mauve with
R > B > G. `PALETTE.sky.zenith` is `0x2f7fb2` — a saturated blue that appears **nowhere in
the frame**. The comment at `SkyShader.js:67-71` says the curve is compressed to `pow(hh,0.30)`
"so the blue has already arrived by the top of that slice"; it hasn't — mixing a saturated
amber against a saturated blue in linear space at 62% lands on a desaturated mauve
(≈0.35,0.28,0.30 linear), and the haze term then pushes R further up. The result is a
single pink→orange ramp from the top of the frame to the horizon with no colour event in
it. RoR2's evening skies keep a genuine blue upper hemisphere against the warm band.

Separately: `uCloudAmount` is 0.74, and the frame contains **one** faint wisp (a thin
blue-grey streak around (525–610, 275–295)). At the vista framing the top of frame reaches
~29° elevation (h ≈ 0.48), well inside the cloud band's `smoothstep(0.006,0.055,h)` window,
so clouds should be everywhere and they are not — the cloud colour `uCloud*0.70` is too
close to the sky it is mixed over to separate.

**Fix:** (a) split the gradient into three stops instead of two — introduce an explicit mid
colour so amber→blue passes through a controlled band rather than through neutral mud:
`col = mix(mix(uHorizon, uHaze, …), uZenith, smoothstep(0.10, 0.55, hh))` with the zenith
weight reaching 1.0 by h≈0.5 so the blue actually lands inside a gameplay frame.
(b) raise the cloud body to `uCloud * 1.05` and darken its shadow side by mixing toward
`uZenith * 0.6` so the deck has internal value contrast. Verify: at least 6% of the
02-vista sky area must fall in the 190–240° hue bucket, and the cloud deck must be visible
as distinct shapes without boosting.

---

### W12 — Stitched black seam along the floating-island rims. **[AREA D]**
`src/world/Props.js:209-214` (`islandSlabGeo`), `:196-204` (`islandDiscGeo`)

**Pixels:** at 9x zoom, the island at (360–490, 185–240) in 02-vista carries a clean
**1px dotted black line** running the full width of its top plate and terminating in a
black notch at the silhouette tip. Column scans across it are non-monotonic
(`80 79 77 74 64 39 55 41 33 30`) — alternating lit/black pixel by pixel, which is stipple,
not antialiasing. It reads as a scratch on the render.

**Cause:** `islandSlabGeo` merges cylinder `a` (half-height 0.21, top cap at y = +0.21) with
cylinder `b` translated to y = +0.44 (half-height 0.25, bottom cap at y = +0.19). Two
opaque caps end up **0.02 local units apart, with b's bottom cap buried inside a**. At
island scale 3.5–9.5 that is 0.03–0.14 world units of coincidence, which is inside the VSM
shadow bias envelope (`Environment.js:270`, `normalBias 0.25`) and stipples.
(I checked the depth buffer is not the cause: three r185 allocates `DEPTH_COMPONENT24` for
the composer target, giving ~2mm resolution at 60m — the seam is not depth-precision.)

**Fix:** raise `b.translate`'s Y from `0.44` to `0.62` so the two shells are cleanly
separated by 0.16, and give `a` a matching treatment in `islandDiscGeo` where `top`'s cap
and the keel's rim coincide. Better still, strip the interior caps before
`mergeGeometries` so no buried face exists to fight. Verify at 9x: no alternating-pixel run
anywhere on an island rim.

---

### W13 — Small unlit props read as dirt specks against bright faces. **[AREA D]**
`src/world/Props.js:244-248` (`debrisGeo`), placement in `_buildFloatingIslands`

**Pixels:** a hard-edged dark sliver sits on the monolith's lit face at (940–975, 332–342)
in 02-vista, measuring RGB(70,24,16) against a face at RGB(184,104,48) — 62% darker than
its background and only ~35×10px. At this size and contrast it reads as a dead-pixel
cluster or a smudge on the lens, not as a floating rock. Several more of these hang off
island keels elsewhere in the frame.

**Cause:** hanging debris is instanced from `debrisGeo` — an `IcosahedronGeometry(1,0)` at
scale 0.6–1.4 — using the same `rock` material, but at that size it never catches the key
and falls entirely to the (near-zero, see W2) fill. Fixing W2 will improve this; it will
not fix the silhouette.

**Fix:** cap the count of debris that can be placed *in front of* a hero prop (or simply
halve the debris count and raise the per-piece scale range to `[1.1, 2.2]`) so each piece is
large enough to read as a rock. Verify: no unlit prop under 20px on its long axis appears
in front of a hero silhouette in the re-shot vista.

---

### W14 — Both vista framings put the horizon dead centre and the subject in dead space. **[AREA F]**
`src/core/Harness.js:81-93` (vista) and `:143-149` (interactables)

**Pixels:** in 02-vista the horizon line sits at y≈470 of 900 — 52%, dead centre — and the
crosshair at (800,450) sits in empty sky. The monolith is a vertical slab centred at x≈930
that splits the frame without being the focal point, and the player (the notional subject)
is a 12px white speck at (800,595). There is no foreground element framing the shot, so the
image has three horizontal bands of equal weight and nothing telling the eye where to land.
The rubric's 4-point text for axis 2 is "subject centred in dead space".

**Fix:** in `vista()`, pitch the camera so the horizon sits at ~0.38 of frame height
(`lookAt` y ≈ p.y + 6 rather than p.y + 12), and move the camera bearing so the monolith
lands near a third rather than at 58% width — `camera.position.set(p.x - 46, p.y + 15, p.z + 34)`
puts it left of the vertical third with the massif opening to the right. Verify: the horizon
falls between 0.32 and 0.42 of frame height, and the largest silhouette's centroid lands
within 6% of a vertical third.

---

## 3. Defect index by area

| Area | Defects |
|---|---|
| **AREA C** (lighting / post / grade / sky / environment) | W2, W3, W4, W5, W10, W11 — 6 |
| **AREA D** (terrain / props / materials / interactables) | W6, W7, W8, W12, W13 — 5 |
| **AREA F** (camera framing / composition) | W1, W4 (shared), W14 — 2 owned + 1 shared |
| out of domain (VFX) | W9 — 1 |

---

## 4. Method / evidence commands

All measurements were taken by decoding the PNGs directly (no re-capture; the screenshot
harness was **not** run, per the dispatch). Scripts live in the session scratchpad:

- `stats.mjs` — frame min/max/mean, 16-bucket luminance histogram, clipped-white and
  near-black fractions.
- `probe.mjs` / `vig.mjs` — box and point sampling for the crush, vignette and sky scans.
- `hue.mjs` — HSV hue histogram (12 × 30° buckets, saturation > 0.08) and value percentiles
  per screen block.
- `flat.mjs` — fraction of judged area whose 11px local luminance range is under 2
  (detects grain-free, i.e. clamped, regions). 02-vista 1.9% / 07-interactables 19.7%.
- `edge.mjs` — per-column luminance scans across silhouette boundaries (AA and stipple).
- `ghost.mjs` / `ghost2.mjs` — unsharp high-pass to surface the sub-threshold ghost text.
- `crops.mjs` / `z.mjs` / `dash.mjs` / `oval.mjs` — gamma-boosted and magnified crops.

Source read for cause attribution: `RenderPipeline.js`, `GradeShader.js`, `SkyShader.js`,
`Environment.js`, `TerrainGen.js`, `Props.js`, `Materials.js`, `Harness.js`,
`ui/hud.css`, `ui/Menus.js`, `core/Engine.js`, and `node_modules/three@0.185.1` for the
depth-format check in W12. **No project file was modified.**

Incidental, non-visual: `src/world/Props.js.bak` is checked into the tree.
