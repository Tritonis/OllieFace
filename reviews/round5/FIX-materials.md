# FIX — materials (round 5, critic round 2)

Work list: `reviews/round5/critic-r2-stages.md` §5 defects 1 and 2, plus the round-4
leftovers the same critique left open (achromatic metal, basin, arch).

Everything below is measured with the **critic's own round-2 scripts**, unmodified
except that the shots directory is read from `$SHOTS` so I could capture to a private
directory while five other agents were writing to `shots/`. The scripts are the ones
the critic listed in its §7 and they are still in the shared session scratchpad:
`r2_sky.mjs` (sky-corrected tile census), `r2_period.mjs` (autocorrelation dominant
period), `f_comp.mjs` (24-bin sat-weighted hue histogram L1).

**Baseline** = a byte copy of the shipped `shots/` the critic judged, taken before I
touched anything. Re-running the critic's scripts against it reproduces its published
numbers **exactly** (47.2 / 20.7 / 52.1 / 52.8 / 73.0 / 60.6 texture-free; hue matrix
1.744 / 1.508 / 0.803 / 1.782 / 1.823 / 1.400), so the before/after below is a like-for-like
comparison and not a re-derivation.

---

## 1. Headline: texture-free fraction, before → after

Critic's `r2_sky.mjs`, corrected sky mask, criterion **<40%**.

Measured on the **shipped `shots/`** written by the final `node tools/capture.mjs` run.

| shot | round 2 (shipped) | **now** | Δ | <40%? |
|---|---:|---:|---:|:--:|
| 13-biomes-1 | 47.2% | **50.3%** | +3.1 | ✗ |
| 13-biomes-2 | 20.7% | **16.6%** | −4.1 | **✓** |
| 13-biomes-3 | 52.1% | **25.3%** | **−26.8** | **✓** |
| 13-biomes-4 | 52.8% | **37.4%** | **−15.4** | **✓** |
| 02-vista | 73.0% | **36.9%** | **−36.1** | **✓** |
| 07-interactables | 60.6% | **59.7%** | −0.9 | ✗ |

(A second full capture of the identical build read 49.7 / 16.6 / 25.0 / 34.5 / 36.4 /
59.9 — the shot-to-shot spread on this metric is ±3 points and every number here should
be read with that band on it.)

**Four of six now meet the criterion, against one before.** `02-vista` was the worst
shot in the build and is now inside it.

**Two honest caveats, stated before the credit.**

1. **`13-biomes-1` did not improve.** Across nine captures of this shot during the
   round it measured 43.6 / 46.1 / 46.3 / 46.9 / 46.9 / 47.9 / 48.0 / 49.5 / 49.7 —
   a ±3 point spread with the baseline's 47.2 sitting in the middle of it. The honest
   statement is *unchanged, inside measurement noise*, not "improved". Its remaining
   flat tiles are the lit mesa caps and the hazed far ranges, not the near surfaces.
2. **`07-interactables` is not the same picture the critic judged.** The harness
   re-picks its biome between runs; the critic's capture was a stage-4 framing with
   1435 world tiles and 22.7% sky, mine is a stage-1 chest close-up with 1867 tiles
   and 5.4% sky. **The 59.9% is not comparable to the 60.6% and should not be read as
   a result either way.** Its chest now reads as ribbed wood plank under iron bands,
   which is a visible improvement, but I have no comparable number for it.

---

## 2. What actually changed, and why the previous root cause is now closed

The critic's defect 1 was precise: *"the build has exactly one texture and applies it
to every material at a fixed screen-space frequency"* — 7–13 px on natural rock, hewn
masonry, wood, a hand-authored arch and a mountain ten times further away.

The cause is structural, not a tuning value. Every map in `buildSets()` is sampled
through **mesh UVs**. A UV-locked map's screen-space period is a property of the mesh
and the screen, not of the world, so it cannot fall off with distance; and one shared
`stone` set drove terrain, boulders, columns, arcades and the hero arch alike, so the
five material classes had no way to differ in *feature scale* at all.

### 2a. A world-space triplanar detail field (`Materials.js`, `DETAIL` + `attachDetail`)

A second relief layer is added by `onBeforeCompile` on all eight standard materials
plus the six interactable rungs. It is sampled **triplanar in metres**, not in UVs:

- two octaves of a baked tileable value-noise-plus-gradient texture, projected on the
  three world planes and blended by `|n|^4`;
- an **anisotropy** term that stretches the field along each plane's second axis;
- a **ridge** fold for creased natural stone;
- a **running-bond mortar course** — straight, world-periodic grooves — for hewn stone
  and for plate seams on metal;
- a **distance fade** on the old UV normal so it retires before it drops under a pixel
  of period, with the metre-scale field carrying the surface behind it.

Triplanar also removes the planar stretching on the terrain, whose UVs are a per-face
XZ/ZY/XY projection (`TerrainGen.js:529-538`) and therefore smear on every sheer face.

### 2b. Per-material feature scale — the authored numbers

`fine` and `coarse` are world feature sizes **in metres**. This is the table the
critic asked for; it spans **96×** from wood grain to steel panel seam:

| class | fine (m) | coarse (m) | anisotropy | ridge | joints | what it is |
|---|---:|---:|---:|---:|---|---|
| wood (chest, trunks) | **0.060** | 0.60 | **9.0×** | 0.20 | — | grain: 60 mm across, 0.54 m along |
| woodPart (interactable) | **0.024** | 0.24 | 8.0× | 0.20 | — | plank grain at prop scale |
| stonePart (interactable) | 0.075 | 0.45 | 1.0× | 0.0 | 0.34 m course | tooled block, prop scale |
| ironPart (interactable) | 0.14 | 0.60 | 3.6× | 0.0 | 0.42 m panel | cast iron, prop scale |
| cliff (**hewn stone**) | **0.22** | 1.8 | 1.0× | 0.0 | **1.70 m course** | chisel between mortar joints |
| sand / silt | 0.25 | 2.2 | 3.2× | 0.0 | — | crosswind ripple over dune |
| moss / organic | 0.30 | 1.4 | 0.85× | 0.0 | — | clumping, no directional bias |
| rock (**natural**) | **0.30** | 1.6 | 1.25× | **0.22** | — | ridged pitting, no straight lines |
| terrain (ground) | 0.46 | 2.2 | 1.0× | 0.0 | — | broad swell |
| wetStone / water | 0.80 | 3.5 | 2.6× | 0.0 | — | long shallow swell along flow |
| metalRuin (**plate**) | **1.20** | 4.0 | **4.5×** | 0.0 | **2.30 m panel** | near-flat between vertical seams |

Roughness modulation is also per class and deliberately widest on metal (0.26) and
narrowest on sand (0.04): what makes metal read as metal is that its specular *breaks*
along the seams, not that it is uniformly shiny.

### 2c. Measured surface-character spread, one frame, same lighting

`r2_period.mjs` HF sd on named surfaces, after:

| surface | HF sd |
|---|---:|
| b3 boulder, natural rock | **31.69** |
| 02-vista lit arch, hewn stone | 25.93 |
| b2 near cliff, natural rock | 25.50 |
| b2 column, hewn stone | 20.99 |
| b1 arch, hewn stone | 19.25 |
| b4 near industrial rock | 8.60 |
| 07 chest lid, iron | 3.57 |
| 07 chest body, wood/iron | **2.72** |

**11.6× spread across rock / hewn stone / metal / wood** against the critic's ≥4×
criterion. In round 2 the same set spanned 4.46–30.36 (6.8×) but with *no* correlation
to material class — the chest was low because it was small, not because it was metal.

### 2d. Distant surfaces gained relief, near surfaces did not lose it

HF sd, before → after, split by distance:

| surface | before | after |
|---|---:|---:|
| b2 **far** peak (~5× distance) | 9.93 | **11.11** |
| b4 **far** mountain range | 7.07 | **7.80** |
| b1 **far** mountain right | 9.32 | **11.29** |
| b3 **far** ground | 10.40 | **14.77** |
| b1 near mesa face | 17.60 | 18.39 |
| b2 masonry block | 15.10 | 15.66 |
| b2 column | 16.29 | 20.99 |
| 02-vista lit arch | 25.37 | 25.93 |
| b3 boulder | 30.17 | 31.69 |
| b2 near cliff | 30.36 | 25.50 |
| b1 arch | 28.59 | 19.25 |

Every far surface is up; every near surface is up except two, where the metre-scale
field replaced part of the old sub-pixel crinkle with larger, better-filtered relief.

---

## 3. The one criterion I did **not** meet, stated plainly

The critic's verify line for defect 1 was: *"on the same material, a near ROI and a
5×-distant ROI differ in dominant screen-space period by ≥3×"*.

`r2_period.mjs` dominant period, before → after:

| shot | surface | before | after |
|---|---|---:|---:|
| b2 | near cliff, natural rock | 8.1 px | 9.0 px |
| b2 | far peak, same rock ≈5× distance | 13.2 px | 11.9 px |
| b2 | masonry block, hewn | 10.7 px | 11.0 px |
| b2 | column, hewn | 12.4 px | 12.0 px |
| b4 | near industrial rock | 11.1 px | 9.9 px |
| b4 | far mountain range | 9.3 px | 9.4 px |
| b1 | near mesa face | 9.8 px | 8.4 px |
| b1 | hand-authored arch | 7.0 px | 7.4 px |
| b1 | far mountain right | 11.7 px | 11.5 px |
| b3 | boulder | 7.8 px | 9.2 px |
| b3 | far ground | 11.1 px | 10.7 px |
| 02 | lit arch stone | 9.0 px | 9.8 px |
| 02 | dark cliff | 12.2 px | 10.4 px |

**Near-to-far ratio on the critic's own pair: 1.63× before, 1.32× now. The ≥3×
criterion is missed, and on this statistic the spread got slightly narrower
(1.91× → 1.65× across the whole set).** I am not going to dress that up.

Two things are true at once and both belong on the record:

- **The detail genuinely is world-locked now.** It is sampled from world position in
  metres in `detField()`; there is no mesh UV in that path at all. The mortar course
  on the aqueduct columns is a fixed 1.70 m in the world and is visibly a *course* —
  the round-2 complaint that "hewn aqueduct masonry is indistinguishable from the
  natural cliff behind it" is dead in the pixels, and that is the change that matters
  most artistically.
- **The statistic cannot show it.** `r2_period.mjs` takes the first zero crossing of
  the autocorrelation of luma high-passed with a **15-tap moving average**. That
  filter suppresses everything above roughly 15 px of period, so the measurement is
  saturated at the top: any surface carrying broadband fine content lands at 7–13 px
  and any surface without it cannot be measured at all, because the tile then reads as
  texture-free and fails the *other* criterion. The two verify lines — "≥3× period
  spread" and "texture-free <40%" — pull against each other on distant terrain under
  this instrument. I chose the texture-free criterion, because that is the one this
  round was briefed on and the one that tracks what the frame looks like.

If round 3 wants to re-test world-locking, the honest instrument is a **known
world-periodic feature at two distances** (the 1.70 m mortar course is now exactly
that), not the first-zero statistic.

---

## 4. Defect 2 — the normal map dying in ambient-only regions

The critic's fix note asked to "sample the IBL per-pixel with the normal-mapped normal
rather than the geometric normal". **That is already what three.js does** —
`normal_fragment_maps` runs before `lights_fragment_begin`, and `geometryNormal` at
`lights_fragment_begin:17` is the perturbed normal. So the stated fix was a no-op and
the real mechanism is different: hemisphere and IBL irradiance are both very nearly
*linear* in the normal, and this build's hemisphere ends sit close together in value,
so tilting a facet on a shade-side surface returns almost exactly what the flat face
beside it returns. The tilt is there; the lighting has nothing to do with it.

Three terms now address that, all on the **indirect** lighting only, so no terminator
ratio and no lit-side value moves:

1. **Sky-visibility gradient** — indirect diffuse is re-weighted by how far the
   perturbed normal turned toward world up. Signed and centred on 1.0, so it moves no
   surface's mean.
2. **World-scale cavity** — the same height field that drives the relief also darkens
   the indirect term in its troughs, and the mortar grooves are its deepest feature.
3. **Micro-cavity, free** — `1 − dot(normal, nonPerturbedNormal)` is the local slope of
   the near-field map, i.e. the wall of a crevice; it occludes at exactly the scale the
   map works at, and it fades on the same distance ramp as the map.

Both indirect terms are floored **together** at 0.45. Multiplied independently they
bottomed out near 0.04×, which read as a hole rather than a crevice and pulled the
biome hue histograms toward their shade colour.

**Measured.** `02-vista` right cliff HF sd **1.18 → 1.34** against the critic's ≥6.0
criterion: **not met, and only marginally moved.** What did move is the whole-frame
number for that shot — texture-free **73.0% → 36.4%** — so the term is working
everywhere except on that one surface. A γ2.2 boost of the region shows large blocky
relief present at 30–80 px, i.e. the detail is there but at a scale the 9×9 high-pass
cannot see; the region's problem is that it is a single value plane at one distance
under one light, which is the compositional failure the critic assigned to the
establishing **bearing** in `Harness.js`, outside my ownership. **The basin (round-4
defect #4) is likewise still open** — I did not give it authored value planes and it
should not be scored as fixed.

---

## 5. Achromatic metal (round-4 defect #7)

`02-vista` monolith peak, same ROI, before → after:

| | before | after |
|---|---|---|
| peak RGB | (255, 255, 240) | **(255, 254, 217)** |
| saturation | **0.059** | **0.149** |
| hue | 60° | 58° |
| hard-clipped-channel px in ROI | 698 | **300** |

Criterion is sat ≥0.15 with **no** channel at 255 and hue within 25° of the key.
**Saturation is at 0.149 — one thousandth short — and the clipping is down 57% but not
gone, so the criterion is missed.** The hue is still 58° against a ~33° key.

The mechanism is worth recording because it was misdiagnosed for two rounds: this is a
*dielectric* highlight, so its colour is the key's colour by construction and there is
nothing to tint. It read as achromatic because it was **clipped** — a clipped pixel has
no hue. The gain above comes entirely from the per-class roughness modulation breaking
the highlight up. I also tried raising b1's `cliff` roughness 0.58 → 0.66 with env
1.45 → 1.22; it changed the peak by nothing measurable (sat 0.122 → 0.118 in a paired
capture) and cost gloss on the biome's hero stone, so **I reverted it — do not redo it.**

---

## 6. The protected win — biome hue distance, re-measured

`f_comp.mjs`, 24-bin saturation-weighted hue histogram, L1 in the world band, max 2.0.

| pair | critic r2 | **now** | Δ |
|---|---:|---:|---:|
| b1↔b2 | 1.744 | **1.694** | −0.050 |
| b1↔b3 | 1.508 | **1.466** | −0.042 |
| b1↔b4 | 0.803 | **0.775** | −0.028 |
| b2↔b3 | 1.782 | **1.636** | **−0.146** |
| b2↔b4 | 1.823 | **1.776** | −0.047 |
| b3↔b4 | 1.400 | **1.379** | −0.021 |

**All six pairs are down. This is a regression against the brief's "do not let any
pair regress" and I am reporting it as one.** The four biomes still read as four
places — five of six pairs remain inside the critic's protected 1.36–1.78 band, and
b1↔b4 remains what it already was, the weak seam — but the direction is wrong.

**Cause, measured rather than guessed.** A bin-level diff isolates it to one bin:
`13-biomes-2`'s 225° (blue-violet) weight grows from 6.2% to 11.8% of its saturated
weight, and a spatial histogram puts those pixels in the shadowed foreground ground and
water, not in the sky. That is the sky-visibility term working as designed: up-tilted
micro-facets on a shade-side surface now pick up more of the cool hemisphere, which is
literally the "sky-hue rim on up-facing shade edges" the critic asked for in defect 2.
It costs distance against `13-biomes-3`, which is violet.

**Three counter-measures tried and measured; all reverted:**

| attempt | result |
|---|---|
| b2 `hemiSky` 0xa8c8d8 → 0x9ccac2 (toward teal) | b2↔b3 1.648 → 1.647. Nothing. |
| b4 ground desaturated ~45% (rock/sand toward steel) | b3↔b4 1.393 → **1.361**, b1↔b4 0.773 → **0.763**. Worse on two pairs. |
| sky-gradient strength 2.2 → 1.3 | b2↔b3 1.645 → 1.662 (+0.017) and texture-free slightly better, so this one I **kept** — it is in the shipped tuning. It recovers a tenth of the loss. |

I did not chase it further, because every remaining lever was a palette change and the
brief's own ranking puts the protected win above defect 6.

---

## 7. Verification

- **`npx vite build` clean.** (`npm run build` runs the same thing; `npm install` was
  never run.) The build was blocked for ~90 s mid-round by an unterminated template
  literal another agent left in `src/shaders/ParticleShader.js:106` — not my file, not
  touched, and it cleared on its own.
- **`node tools/capture.mjs` — 21 shots**, `ready: true`, `partial: false`,
  `frameErrors: []` on every shot, `subjectFailures: []`.
- **`node tools/perf.mjs` — `combat-24` median 18.6 ms, p95 24.3, worst 30.4.** Inside
  the 17–26 ms band. Programs **62, unchanged** — every consumer of the pass shares one
  `customProgramCacheKey`, so it adds no shader permutations.
  Perf was a real risk and it was measured as one. The first working version cost
  **7.8 ms** a frame (28.4 ms with the pass, 20.6 ms with `attachDetail` stubbed out in
  the same session). Two fixes brought it down: per-plane gating of the arithmetic-only
  joint term, and — the one that mattered — **baking the value-noise-and-gradient field
  to a 256² texture** instead of evaluating 24 hashes per pixel. Baking also buys
  correct mip filtering, which is worth more here than the arithmetic was: an
  unfiltered world-space field is exactly the sub-pixel aliasing this pass exists to
  end. Measured cost after: ~4 ms under identical contention, ~2 ms on an idle machine.
- **Determinism holds and no golden re-baseline is needed from this change.** I added
  no `rng` call and changed no geometry; `archGeo`'s stream shift from the previous
  round is unaffected. Camera bearings on `13-biomes-1..4` and `02-vista` are identical
  before and after, which is what makes the fixed-pixel probes above comparable.
- **The PNGs were looked at**, not just measured — that is how the coarse-octave ridge
  artefact (thin bright creases on b4's distant ranges) and the mortar-groove sparkle on
  02-vista's arch were both found and fixed, neither of which any of these metrics saw.

## 8. Files changed

- `src/world/Materials.js` — the `DETAIL` table, `detailNoiseTexture()`,
  `attachDetail()` and its GLSL; one comment-documented `matTune` note. No biome
  palette was changed in the shipped state.
- `src/world/Interactables.js` — one import and six `attachDetail(...)` wrappers on the
  existing shared material factories. No behaviour, geometry or colour changed.

## 9. Still open, ranked

1. **`13-biomes-1` texture-free 50.3%** and **`07` 59.7%** miss <40%. b1's flat tiles
   are lit mesa caps and hazed far ranges; 07's number is not comparable to the
   critic's and needs a re-judge on a stable framing.
2. **`02-vista`'s dark cliff** — HF 1.34 vs a ≥6.0 criterion, and the **basin is
   untouched**. Both need the bearing (`Harness.js`) plus authored value planes; no
   material lever reached them.
3. **Monolith specular** at sat 0.149 / hue 58°, still one thousandth under the
   criterion with 300 clipped pixels left.
4. **The hue matrix is down on all six pairs**, worst −0.146 on b2↔b3. Cause isolated
   to b2's 225° bin; three counters tried, two reverted.
5. **The ≥3× near/far period criterion is missed** and the instrument cannot show the
   change that was made. See §3 for the replacement measurement I suggest.
6. **The arch is still contre-jour** (round-4 #5, 1.26:1) and `07`'s upper-left dead
   zone is untouched. Both are camera/composition, not material.
