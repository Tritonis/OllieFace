# PETRICHOR — Round 5, critic **round 2 of max 4**: STAGES / LIGHTING / MATERIALS

Domain: axes 1, 2, 3, 5, 10. All ten scored per `RUBRIC.md`.
Shots judged: `13-biomes-1..4`, `02-vista`, `07-interactables` — **the shipped PNGs in `shots/`
as captured 2026-08-01 13:37–13:38** against `34cc8c4`.

**Manifest check.** `ready: true`, `partial: false`, `errors: []`, `subjectsOk: true`,
`subjectFailures: []`. All six judged shots `frameErrors: 0`, `newErrors: []`. No crash to
report. Scoring proceeds on the pixels.

**Method.** PNGs decoded with the round-1 hand-written decoder (`png.mjs`). Round-1's own
scripts (`e_surf`, `f_comp`, `k_last`, `l_r4`) were re-run **unmodified** for strict
comparability; where round-1's hand-set sky mask is invalidated by the new camera bearings I
also report a corrected number from a flood-fill sky mask I wrote and **visually verified by
overlay** (`crops/mask_*.png`). No project file was modified; `tools/capture.mjs` was not run.
Round-1 numbers and the fix agent's numbers were re-derived, not credited.

**One caveat stated up front, because it decides several claims:** the harness re-picks camera
bearings between builds and `07-interactables` changes biome between runs. The fix agent
measured a *different capture* than the one shipped. Where its numbers do not reproduce, I
judge the shipped pixels — that is the rubric's rule — and say so.

---

## 1. Axis scores, round 1 → round 2

| # | Axis | b-1 | b-2 | b-3 | b-4 | 02-vista | 07-inter |
|---|------|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | Lighting & shadow | 6 (=) | 6 (=) | **7 (+1)** | 6 (=) | 5 (=) | **6 (+1)** |
| 2 | Composition & depth | **7 (+1)** | 5 (=) | 5 (=) | 6 (=) | **4 (+1)** | **5 (+1)** |
| 3 | Colour & grade | 7 (=) | **7 (+1)** | **4 (−1)** | 5 (=) | 4 (=) | **6 (+1)** |
| 4 | Silhouette & form | 6 (=) | 5 (=) | **6 (+1)** | 6 (=) | 5 (=) | 4 (=) |
| 5 | **Material believability** | **6 (+1)** | **6 (+1)** | 5 (=) | 5 (=) | 4 (=) | **5 (+2)** |
| 6 | VFX quality | 4 (=) | 4 (=) | 4 (=) | 4 (=) | 4 (=) | 3 (=) |
| 7 | UI/HUD craft | 8 (=) | 8 (=) | 8 (=) | 8 (=) | 7 (=) | 7 (=) |
| 8 | Readability under load | 6 (=) | 5 (=) | 5 (=) | 5 (=) | 5 (=) | 6 (=) |
| 9 | Post-processing | **7 (−1)** | **7 (+2)** | 7 (=) | **7 (+3)** | 6 (=) | 7 (=) |
| 10 | Cohesion | 7 (=) | 7 (=) | 6 (=) | 6 (=) | 5 (=) | **5 (+1)** |
| | **mean** | **6.4** | **6.0** | **5.7** | **5.8** | **4.9** | **5.4** |
| | round-1 mean | 6.3 | 5.6 | 5.6 | 5.5 | 4.8 | 4.8 |
| | **Δ** | **+0.1** | **+0.4** | **+0.1** | **+0.3** | **+0.1** | **+0.6** |

```
13-biomes-1       AXIS SCORES: 1:6 2:7 3:7 4:6 5:6 6:4 7:8 8:6 9:7 10:7   VERDICT: FAIL
13-biomes-2       AXIS SCORES: 1:6 2:5 3:7 4:5 5:6 6:4 7:8 8:5 9:7 10:7   VERDICT: FAIL
13-biomes-3       AXIS SCORES: 1:7 2:5 3:4 4:6 5:5 6:4 7:8 8:5 9:7 10:6   VERDICT: FAIL
13-biomes-4       AXIS SCORES: 1:6 2:6 3:5 4:6 5:5 6:4 7:8 8:5 9:7 10:6   VERDICT: FAIL
02-vista          AXIS SCORES: 1:5 2:4 3:4 4:5 5:4 6:4 7:7 8:5 9:6 10:5   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:6 2:5 3:6 4:4 5:5 6:3 7:7 8:6 9:7 10:5   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass needs 7+ on every axis with none below 6. No shot clears it.

**But this is the first round in six in which axis 5 moved.** It reaches 6 in `13-biomes-1`
and `13-biomes-2` and jumps 3→5 in `07-interactables`. That movement is earned and measured,
not conceded. It reaches 7 nowhere, for a reason that is now precisely nameable (defects 1 and
2 below) and is **a different reason than round 1's**. Round 1's root cause — a featureless
PMREM against which a roughness ladder could not express itself — is **closed**. The
replacement failure is that the build now has exactly one texture and applies it to everything
at a fixed screen-space frequency.

### What is good, and must not be broken

- **The chest is the single largest material win in the build.** Round 1: HF sd 0.666, **8
  distinct luma values in 2,025 px**, one convex blob. Now: body wood HF sd **7.33** with
  **1,899 distinct colours**, three genuine luma plateaus (lid stone L72.9 / body wood L74.7 /
  orange band L55.6 sd 4.78) and concave rail features. Round-4 defect #2 is dead.
- **`13-biomes-2` is now the best-looking frame in the product** and it wins by restraint:
  mean saturation **0.27**, dominant 15° hue bin only **16.5%** of saturated weight — half of
  every other shot. Texture-free fraction **20.7%**, the only shot meeting round 1's own <40%
  criterion. Its blown-white shard field is gone (L>215 **7.60% → 1.04%**).
- **`13-biomes-3` is the only shot in the build with long raking cast shadows** — the spires
  throw real directional shadows across the ground plane. That is Titanic Plains behaviour and
  the other five shots should copy it.
- **`13-biomes-1` finally has aerial perspective.** Skyline |ΔL| median **31.4 → 10.4**. The
  far ranges now sit behind the mesa instead of beside it.
- **The four biomes still read as four places** — verified below, and it survived a round that
  touched palettes.
- **`07`'s dappled tree shadows on the orange slope are the best cast-shadow work anywhere in
  the build.**
- **Post is clean.** Clipped white 0.014% in all six; hue-channel saturation `s>0.90` at
  0.0–0.1%; no banding; no `≤2` channel crush anywhere.

---

## 2. Claim verification — VERIFIED / REFUTED / PARTIAL

| # | Claim | Verdict | My measurement on the shipped pixels |
|---|---|---|---|
| 1 | `02-vista` sub-L24 **12.52% → 1.61%**, fixed | **VERIFIED** | **1.69%** all-pixel (round-1's `f_comp.mjs`, unmodified). Criterion <3% met. All six shots now 1.39–1.81%. |
| 2 | `02-vista` connected sub-L40 blob **33.5% → 30.1%**, still open | **VERIFIED** | **30.0%** all-pixel / **25.9%** HUD-masked. Criterion <8%. Still the dominant fact of the frame. |
| 3 | Beam **2.07–3.29× → 1.68–2.54×** frame mean | **PARTIAL** | **1.67–2.29×** by geometric locator. Genuinely improved from round 1's 2.19–3.45×; criterion ≤1.6× still missed in all six. b4's shaft is **540 px = 60% of frame height** at 2.29×. |
| 4 | Beam is now four biome hues, not one cyan | **VERIFIED** | Saturation-weighted circular-mean hue of the located shaft: b1 **262°**, b2 **134°**, b3 **319°**, b4 **26°** (and 02-vista **298°**). Round 1: 185–190° in all four. Fixed outright. |
| 5 | Biome hue-distance preserved or improved | **VERIFIED (magnitude REFUTED)** | b1↔b2 1.711→**1.744**, b1↔b3 1.462→**1.508**, b2↔b3 1.359→**1.782**, b2↔b4 1.736→**1.823**, b3↔b4 1.438→**1.400**. Four up, one down 0.038. **The claimed b2↔b3 = 1.890 does not reproduce; it is 1.782** — still a large real gain. The protected win holds. |
| 5b | (agent's own flag) b1↔b4 weak seam at 0.879 | **REFUTED — worse** | **0.803.** Two warm sunset biomes, the weakest pair in the set and now below the agent's figure. |
| 6 | R4 #1 teal accent — fixed | **VERIFIED** | Round-4's own mask, all six: **0.080–0.842%**, largest component **≤0.13%**. Criterion <1.5% met everywhere. Was 2.549 / 4.416 / 7.211%. |
| 7 | R4 #2 chest — fixed | **VERIFIED** | Three plateaus, HF 0.666→**7.33**, 8→**1,899** colours, orange banding, concave rails. *A new and different defect has replaced it — see defect 5.* |
| 8 | R4 #9 crystal — fixed | **VERIFIED** | 4× crop shows two independent silhouette families (needles + faceted wedge clusters) with independent rotation, not one scaled spike. |
| 9 | R4 #5 arch — partial at **1.26:1** | **VERIFIED PARTIAL** | Vertical scan x[520..600]: crown plateau **L101** (y226–250), soffit trough **L80** (y262–268) = **1.26:1** exactly. Round 1: 1.00:1. Criterion 2.2:1 missed. `13-biomes-1`'s arch: crown L96 / soffit L70 = **1.37:1**, up from 1.12:1. Both arches now read as mass; neither meets the ratio. |
| 10 | R4 #3 `07` lower-left **13.8%** vs 8%, still open | **REFUTED** | Round-4's own script on the shipped shot: **3.3% of frame.** The criterion is met. The agent measured a capture that is not what shipped. **The defect nevertheless exists in a different place** — `07` carries a **19.0%** connected sub-L40 region, bbox **1185×684 anchored at [0,0]**, i.e. the entire upper-left. Round-4's metric no longer catches where the dead zone moved to. |
| 11 | R4 #4 `02-vista` basin — still open | **VERIFIED** | Basin floor ROI [150,700]–[400,790]: L45.0, sd 3.00, HF sd **1.345** (grain floor 0.59), P10–P90 **42–49 — 7 luma**. No shadow form, no edge. Untouched since round 4. |
| 12 | R4 #7 metal specular achromatic, sat 0.06 | **VERIFIED** | Monolith peak **RGB(255,255,240)** at (626,407), L253.9, hue 60°, **sat 0.06**, under a hue-14° key. Two channels hard-clipped to 255. Unchanged since round 4. |
| 13 | b4 contour stripes — metric worse but measuring the wrong thing | **VERIFIED — and I withdraw the round-1 finding** | Reversals 84→**94**, mean |dL/dy| 2.24→**4.04**. A 4× magnification of [1250,250]–[1500,440] shows **ridge/chevron normal-map relief, not a periodic terrace**. My round-1 defect #6a called this a heightfield quantisation artefact. It is not, and it is not one now. **Withdrawn.** |
| 14 | b2 blown to near-white — fixed | **VERIFIED** | L>215 **7.60% → 1.04%**, criterion <2.5%; no connected component near 1.0%. |
| 15 | Axis 5 texture-free fell but criterion <40% met nowhere | **PARTIAL** | Improvement is large and real; the "nowhere" is wrong by one shot. See §3. The agent's per-shot figures do not reproduce on the shipped pixels at all. |

---

## 3. AXIS 5 — the improvement is real, the criterion is still missed, and the cause has changed

### 3a. The improvement — verified twice

Round-1's `e_surf.mjs` re-run **unmodified**, then re-run with a sky mask I built and verified
by overlay (round-1's hand-set `SKYMAX` constants are invalidated by the new bearings — in
`13-biomes-2`, `13-biomes-3` and `07` it masked *nothing*, counting flat sky as flat surface;
in `13-biomes-4` it masked far too little):

| shot | round 1 (as published) | round 2, **identical script** | round 2, **corrected sky mask** | <40%? |
|---|---:|---:|---:|:--:|
| 13-biomes-1 | 79.9% | 66.5% | **47.2%** | ✗ |
| 13-biomes-2 | 77.9% | 54.6% | **20.7%** | **✓** |
| 13-biomes-3 | 75.0% | 60.4% | **52.1%** | ✗ |
| 13-biomes-4 | 72.8% | 57.5% | **52.8%** | ✗ |
| 02-vista | 85.6% | 76.6% | **73.0%** | ✗ |
| 07-interactables | 91.5% | 81.8% | **60.6%** | ✗ |

**Both halves of the fix agent's headline claim are upheld**, with one correction: the
criterion *is* met, in `13-biomes-2`. It is missed in the other five. The improvement is
13–26 points on the strictly comparable measure and larger on the corrected one, and it is
visible without instruments — named-surface HF sd went from **0.60–1.01 across the board** in
round 1 to **4.5–31.7** now. The chest went from 8 distinct luma values to 1,899 colours. **The
PMREM work is real.** It is also the reason round 1's stated root cause is now closed and no
longer the thing to fix.

The agent's own per-shot figures (64.5 / 74.8 / 62.4 / 70.5 / 76.7 / 61.1) **do not reproduce
on the shipped pixels under either mask** — its b2 of 74.8% is 54.6% or 20.7% here, its 07 of
61.1% is 81.8% or 60.6%. This is the camera-re-pick caveat, not dishonesty, but it means its
table cannot be used as a baseline for round 3. Use the two columns above.

### 3b. The new root cause: **one texture, screen-space-locked, on everything**

Horizontal autocorrelation of high-passed luma; first zero crossing gives the dominant
screen-space period. Surfaces chosen to span five material classes and >10× in distance:

| shot | surface | HF sd | **dominant screen-space period** |
|---|---|---:|---:|
| b2 | near cliff, natural rock | 30.4 | **8.1 px** |
| b2 | far peak, same rock, ≈5× the distance | 9.9 | **13.2 px** |
| b2 | masonry block, *hewn* stone | 15.1 | **10.7 px** |
| b2 | aqueduct column, *hewn* stone | 16.3 | **12.4 px** |
| b4 | near industrial rock | 10.4 | **11.1 px** |
| b4 | far mountain range | 7.1 | **9.3 px** |
| b1 | near mesa face | 17.6 | **9.8 px** |
| b1 | hand-authored arch | 28.6 | **7.0 px** |
| b1 | far mountain right | 9.3 | **11.7 px** |
| b3 | boulder | 30.2 | **7.8 px** |
| 07 | chest lid | 9.1 | **6.9 px** |
| 07 | chest body, *wood* | 4.5 | **10.1 px** |
| 02 | lit arch stone | 25.4 | **9.0 px** |

**Every surface in the product — natural rock, hewn masonry, wood, a hand-authored landmark,
and a mountain range at ten times the distance — carries the same detail at 7–13 px of screen
space, a 1.9× spread.** If this detail were a property of the surfaces, its screen-space period
would scale inversely with distance, giving a ≥10× spread across this set. It does not. The
detail is locked to the screen, not to the world.

Two consequences read directly in the pixels: `13-biomes-2`'s hewn aqueduct masonry is
indistinguishable from the natural cliff behind it (10.7 vs 8.1 px, and the 2× crop shows the
identical crinkle on both) — RoR2's Abandoned Aqueduct separates tooled block from raw rock at
a glance; and a 300 m mountain in `13-biomes-4` carries the same per-pixel relief as a rock
three metres from camera, which is why the far ranges refuse to sit back.

**The rubric's four-point line has not been escaped, only restated.** "Uniform matte plastic on
every surface" has become uniform crinkled foil on every surface. Roughness *contrast between
rock / metal / organic* — the actual nine-point description — still does not exist anywhere,
and `13-biomes-4` remains an industrial biome with no metal in it (containers sat 0.48 hue
348°, no specular break; the build's only specular highlight is `02-vista`'s monolith at
**sat 0.06**).

### 3c. The second residual: **ambient-only surfaces go flat**

Texture-free fraction split by tile brightness (corrected sky mask):

| shot | dark tiles (L<40) | mid (L40–90) | lit (L>90) |
|---|---:|---:|---:|
| 13-biomes-1 | 55% flat (11 t) | 33% (206 t) | 86% (73 t) |
| 13-biomes-2 | 7% (15 t) | 23% (133 t) | 0% (2 t) |
| 13-biomes-3 | 44% (108 t) | 58% (153 t) | — |
| 13-biomes-4 | — | 53% (490 t) | 48% (61 t) |
| **02-vista** | **82% (594 t)** | 59% (385 t) | 70% (10 t) |
| 07-interactables | 41% (44 t) | 65% (190 t) | 50% (2 t) |

And the decisive same-frame pair: in `02-vista`, lit arch stone measures HF sd **25.4**; the
right-hand cliff measures HF sd **1.18** — at the film-grain floor of 0.59 — a **21× collapse**
on rock in the same shot. Elsewhere the same material survives shade at ~40% strength
(b3 boulder lit 31.7 / shade 13.6; b1 arch leg lit 28.7 / shade 12.1), so 02-vista's cliff is
an order of magnitude below even that. A gamma-2.2 boost of the region proves the detail *is*
authored — it is present at roughly **one luma of amplitude**. The normal map's contribution is
scaling with the key light and vanishing where only ambient reaches.

**This directly contradicts "the dead third is a camera problem."** See §4.

Spatially, where the flat tiles live (24×24 tiles, 4×3 frame grid):

- `02-vista` — **722 flat tiles, mean L 39**, concentrated x>800 across the whole frame height
  plus the entire lower band. The right cliff and the basin floor.
- `13-biomes-4` — **291 flat tiles**, **107 of them in one cell** (x 0–400, y 300–600): the
  near-left foreground mountain, HF sd **2.31**, P10–P90 **51–58 (7 luma)**.
- `07` — 143 flat tiles concentrated x>800 in the lower two thirds: the sloped right ground.

---

## 4. The reverted trade-off — **the right call, for a better reason than the one given**

The agent found that lifting the grade toe (0.108/0.113/0.198 → 0.140/0.146/0.226) takes
`02-vista`'s sub-L40 blob from 28.0% to **0.1%** — the criterion, met outright — at a cost of
texture-free rising 64.6/74.1/62.3/71.2% → 73.4/81.9/69.5/75.9%. It reverted it, framing this
as paying for a composition metric with material detail.

**Reverting was correct. Say so plainly: yes, that was the right call.** But the framing is
wrong in a way that matters for round 3, and the correction is favourable to the agent:

**It was not a trade-off at all. It was a refusal to game a metric.** I measured the blob's
internals: 432,406 px, bbox 884×753 at [715,146], internal luma **P5 29.2 → P95 37.5 — 8.3
luma of range across a quarter of the frame**, at HF sd 1.18. A toe lift does not add a value
plane, an edge, a rim or a bounce to that region. It slides a featureless mass from L33 to
L55 and the connected-component threshold stops counting it. The frame would score better and
look identical: a grey hole instead of a violet hole. Meanwhile the cost is real and lands on
the *other* five shots, where the shadow-side halves of genuinely-newly-textured surfaces
would be crushed — that is defect #1 and the axis that has been stuck for six rounds. Paying a
real cost for a cosmetic gain is not a close call, and the agent's instinct was right even
though its stated reason understates its own case.

**The metric is at fault and I am replacing it.** "Largest connected sub-L40 region < 8%" is
satisfiable by any monotonic display-space curve, which makes it worthless as an acceptance
test. Round 3 should use, in its place:

> Inside the largest connected sub-L40 region: internal **P5–P95 ≥ 20 luma**, **and** the
> region must decompose into ≥2 sub-regions each ≥3% of frame whose means differ by ≥15 luma.

Today that reads 8.3 luma and one sub-region. No grade curve can move it.

**The other half of the agent's conclusion — "camera problem, not a lighting one" — is
PARTIALLY REFUTED.** The bearing genuinely is bad: the sun sits behind the arch, the right
third is one mass's shade side, and the beam runs straight through the hero landmark. Fixing
the bearing is worth doing and it does live in `Harness.js`. But a shade-side cliff in RoR2 is
not featureless — it carries AO gradient, a sky rim on its top edge, bounce from the lit ground
below, and visible relief. This one carries **HF sd 1.18 and 5 luma of range over 200×90 px**
while rock in the same frame carries 25.4. That is a lighting/material failure (§3c), it is
reproducible in `13-biomes-4`'s left mountain at HF 2.31 with no camera involved, and no
bearing change will fix it. Both fixes are needed; only one of them was correctly diagnosed.

I also confirm the three levers the agent measured and rejected — IBL floor, hemisphere scale,
fog density — should stay rejected. Its hemisphere finding in particular (b2 column terminator
2.16:1 → 1.07:1) is the failure the existing comment in `Environment.js` already records.
**Do not redo any of the six experiments in its no-go table.**

---

## 5. TOP DEFECTS (ranked — work top-down)

**1. Axis 5: the build has exactly one texture and applies it to every material at a fixed screen-space frequency. All six shots.**
`src/world/Materials.js` (detail-normal assignment) · `src/world/TerrainGen.js` (terrain UVs)
Autocorrelation dominant period: near cliff **8.1 px**, the same rock at ≈5× distance **13.2 px**,
hewn masonry **10.7 px**, wood **10.1 px**, a hand-authored arch **7.0 px**, a 300 m mountain
**9.3 px** — a **1.9× spread over a >10× distance range and five material classes**. Hewn
aqueduct block is visually identical to natural cliff; distant ranges carry near-camera relief
and refuse to recede. No metal exists in the metal biome (b4 containers sat 0.48, no specular
break); the build's only specular highlight is `02-vista`'s monolith at **sat 0.06**.
**Fix:** drive the detail normal from **world-space triplanar UVs at a fixed world scale**, not
screen/mesh UVs, so period falls off with distance; give each material class its own octave mix
and amplitude — fine chisel + mortar joints on hewn stone, broad low-frequency swell on natural
cliff, directional grain on wood, near-flat on metal with `metalness ≥ 0.7` and a specular
tinted to the key hue.
**Verify:** on the same material, a near ROI and a 5×-distant ROI differ in dominant screen-space
period by **≥3×**; HF sd spread across rock / hewn stone / metal / wood **≥4×**; monolith peak
saturation **≥0.15** with hue within 25° of the key and no channel at 255.

**2. Axis 5 / 1: the normal map's contribution scales with the key and dies to nothing in ambient-only regions.**
`src/world/Environment.js` (IBL sampling) · `src/world/Materials.js`
`02-vista`: lit arch stone HF sd **25.4**, right cliff HF sd **1.18** — the grain floor is 0.59.
A 21× collapse on rock in one frame. P10–P90 on that cliff is **33–38, five luma over 200×90 px**.
`13-biomes-4`'s left foreground mountain: HF **2.31**, P10–P90 **51–58**, **107 flat tiles in one
grid cell**. `02-vista`'s basin: HF **1.345**, 7 luma (round-4 defect #4, untouched). 82% of
`02-vista`'s L<40 tiles are texture-free. Gamma-2.2 boost proves the detail is authored and
present at ~1 luma — it is the *lighting* of it that is missing.
**Fix:** sample the IBL per-pixel with the **normal-mapped** normal rather than the geometric
normal, and multiply the ambient term by a cavity/AO factor derived from the same height field,
so shade-side surfaces keep their break. Add a sky-hue rim term on up-facing shade edges.
**Verify:** `02-vista` right cliff HF sd **≥6.0** and P10–P90 **≥15 luma**; texture-free fraction
*among L<40 tiles* below **40%** in every shot (today 82% / 55% / 44% / 41%).

**3. `02-vista`: a quarter of the establishing shot is one connected region with 8 luma of internal range. Axes 2 (4), 3 (4), 5 (4), 10 (5).**
`src/game/Harness.js` (establishing bearing) · plus defect 2
sub-L24 is genuinely fixed (**12.52% → 1.69%**) — credit given. The failure moved from
crushed-black to flat-violet: **25.9%** of frame (30.0% all-px), bbox **884×753 at [715,146]**,
internal **P5 29.2 → P95 37.5**. Dominant hue bin 240° is now **44.9%** of all saturated weight,
**up from round 1's 37.3%** — one violet bath, worse than before. Near→mid value step still ~4 luma.
**Fix:** re-pick the bearing so the right third is not one mass's shade side and so the beam does
not cross the arch's bbox; independently, give that cliff two authored value planes, a sky-hue
rim on its top edge, and a warm bounce term from the lit basin. **Do not use a grade lever** — see §4.
**Verify (replaces the gameable metric):** inside the largest connected sub-L40 region,
**P5–P95 ≥ 20 luma**, and ≥2 sub-regions each ≥3% of frame with means ≥15 luma apart; no single
15° hue bin above **30%** of saturated weight.

**4. The teleporter beam: hue is fixed, value and height are not. Axes 2, 8, 10, all world shots.**
`src/world/Interactables.js` (shaft emissive) · `src/game/Harness.js` (bearing rejection)
Hue is a clean win — **262° / 134° / 319° / 26°** across four biomes where round 1 had one cyan
at 185–190°. Value: **1.67–2.29×** frame mean against a ≤1.6× criterion, improved from 2.19–3.45×.
`13-biomes-4`'s shaft is **540 px = 60% of frame height**; in `02-vista` it still runs straight
down through the hero arch's centre.
**Fix:** fade the shaft emissive with **screen-space height** — full at the base collar, zero by
40% of frame height — rather than dimming it uniformly, which preserves 200 m findability at the
base while removing the frame-spanning bar. Add landmark-bbox rejection to the establishing bearing.
**Verify:** beam mean ≤**1.6×** frame mean in all four biomes; shaft height ≤**35%** of frame; zero
overlap with the landmark bbox in `02-vista`.

**5. `07`: the chest's surface is fixed; its silhouette and its neighbours are not. Axes 4 (4), 10 (5), 2 (5).**
`src/world/Interactables.js` (chest geometry, lid proportion) · prop placement
Round-4 defect #2 is genuinely dead (HF 0.666→**7.33**, 8→**1,899** colours, three plateaus,
orange banding). Three new problems in its place, all visible at 4×:
(a) the lid is an oversized rounded mass roughly **1.9× the body's height** — it reads as a
boulder resting on a crate, not a lid, and the manifest's own subject check records
**contrast 0.149** (lum 17.4 vs bg 12.9);
(b) **two pale cream boxes (L149.5, sat 0.26 against a scene at sat 0.56) intersect the lid
symmetrically at exactly crosshair height**, each cut off flush by the lid's silhouette — the
right one occluding the lid in front. That is geometry interpenetration, and it belongs to no
palette in the frame;
(c) the lid's normal is a fine directional streak that reads as pelt, not stone;
(d) **19.0%** of the frame is one connected sub-L40 region, bbox **1185×684 at [0,0]** — the dead
zone moved to the upper-left, where round-4's lower-left metric (now **3.3%**, passing) cannot see it.
**Fix:** cap the lid at **≤1.2×** the body's height and flatten its top into a faceted plane;
delete the cream boxes or re-material them to the chest's warm metal and move them outside the
lid's convex hull; swap the lid's streak normal for the body's chisel; put a fill or a bounce
into the upper-left mass.
**Verify:** lid height ≤1.2× body; **zero** prop geometry intersecting the chest's convex hull;
largest connected sub-L40 region **<8%** of frame; subject-vs-background contrast ≥0.35.

**6. Axis 3: two frames are a single-hue bath, and `13-biomes-3` has promoted its accent to a field.**
`src/world/Materials.js` (per-biome palettes)
Dominant 15° hue bin as a share of saturated weight: `02-vista` **44.9%** (round 1: 37.3% —
regressed), `13-biomes-4` **42.1%**, `07` 37.1%, `13-biomes-1` 33.9%, `13-biomes-3` 30.3%.
`13-biomes-3` additionally puts **13.8% of the whole frame** into hot magenta at mean saturation
**0.50** — roughly ninety magenta objects, so there is no accent left, only a field, and any
enemy or pickup in that frame is unfindable (axis 8). The counter-example is in the build:
`13-biomes-2` at **16.5% / sat 0.27** is the best-looking frame here.
**Fix:** cap any single 15° hue bin at **30%** of saturated weight per biome. In `02-vista` push
the shade-side cliff off the sky's 240° toward ~200° and warm the basin bounce, so shadow and
light are complementary rather than the same hue at two values. In `13-biomes-3` demote magenta
to crystals only (**≤4% of frame**) and let the rock hold grey-violet.
**Verify:** no 15° bin above 30% in any shot; b3 magenta-mask fraction below 4%; `13-biomes-1`↔
`13-biomes-4` hue-histogram L1 above **1.10** (today **0.803**, the weakest seam in the set).

---

## 6. Withdrawn from round 1

- **b4 contour stripes (round-1 defect #6a) — withdrawn.** I called the 4 px vertical ripple on
  b4's distant ranges a heightfield/contour quantisation artefact. A 4× magnification of
  [1250,250]–[1500,440] shows chevron normal-map relief with no fixed period, and the reversal
  count (84→94) is measuring surface noise, not terracing. The fix agent's read was correct and
  mine was not. b4's axis 9 goes 4 → 7.
- **`07` lower-left dead zone (round-4 #3) — the criterion is met on the shipped pixels**
  (**3.3%** vs <8%), against both round 1's 13.9% and the fix agent's 13.8%. The underlying
  compositional problem persists but has moved to the upper-left, where the metric is blind;
  it is folded into defect 5(d) with a metric that can see it.

---

## 7. Evidence / scripts

Round-1 scripts re-run unmodified for comparability: `e_surf.mjs`, `f_comp.mjs`, `k_last.mjs`,
`l_r4.mjs`, `crop.mjs`. New round-2 scripts, all in the session scratchpad
`…/a0777b2c-…/scratchpad/`:

- `r2_sky.mjs` — flood-fill sky mask (per-pixel |ΔL|<1.6, |Δ(r−b)|<2.5 from the top edge) +
  sky-corrected 24×24 texture census with a per-shot film-grain floor from pure-sky tiles.
- `r2_mask.mjs` — magenta sky-mask overlays (`crops/mask_*.png`) used to **visually verify** the
  mask before trusting any number derived from it; the first tolerance leaked into b4's hazed
  ranges and was tightened until the overlay was clean.
- `r2_a.mjs` — texture-free split by tile brightness; world-band P10/P50/P90 deciles.
- `r2_beam.mjs` — geometric beam locator (tallest bright vertical run with width ≤26 px at
  mid-height), saturation-weighted circular-mean hue, beam-to-frame-mean ratio.
- `r2_roi.mjs` — 28 named-surface probes: mean/sd/HF-residual/hue/sat/distinct-colours/P10–P90.
- `r2_scan.mjs` — arch vertical crown scans, largest-blob bbox and internal percentiles,
  b4 stripe reversal counts, shadow-edge 10–90 transition widths.
- `r2_period.mjs` — horizontal autocorrelation of high-passed luma, first-zero lag → dominant
  screen-space texture period (§3b, the round's decisive measurement).
- `r2_where.mjs` — spatial 4×3 histogram of texture-free tile locations.

Crops produced and inspected: `r2_chest`, `r2_slab` (4×), `r2_arch1`, `r2_arch2` (3×),
`r2_darkthird` (γ2.2), `r2_b4mtn` (4×), `r2_b3crys`, `r2_b2`, and three mask overlays.

No project file was modified. `shots/manifest.json` read for the crash check only.
