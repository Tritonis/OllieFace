# FIX-world.md — round 6, world / lighting / materials implementer

Assigned from `reviews/round6/critic-r4-world.md` ("assign an implementer, not
another critic"), plus one mid-task addition from the main session (the PMREM
probe; §1).

**Every number below names the file on disk it was measured from.** Nothing here
is quoted from a previous report without re-measuring it myself.

---

## 0. Arms, instruments, and the one thing I checked before anything else

### 0a. Arms

| arm | on disk | what is in it |
|---|---|---|
| BASE | `reviews/round6/world2-base/` | HEAD `1541fc9`, unmodified |
| A | `reviews/round6/world2-a/` | probe + bounce v1 (0.40) + rim 0.74 + Toksvig + chroma low-pass g3 + b3 palette |
| B | `reviews/round6/world2-b/` | A + bounce 1.60 + light-grazing horizon limit |
| C | `reviews/round6/world2-c/` | B + bounce 2.60 |
| D | `reviews/round6/world2-d/` | B + chroma low-pass gain 8 |
| **SHIP** | **`reviews/round6/world2-final/`** | **= B's configuration, re-captured on the final tree** |

All six are `ready: true`, `clockPinned: true`, `seed: 1337`, 1600×900, 21 shots.

### 0b. Instruments

I reused the round-4 critic's own tooling verbatim rather than writing a fourth
statistic — `w4salt.mjs` (MED / PEAK / NYQ), `w4roi.mjs` (percentiles, unique
luma, HF sd, clip255, saturation, dominant hue bin, per-pixel chroma HF),
`w4mask.mjs`, `w4frame.mjs`, `w4crop.mjs`, all in the session scratchpad. Its
selftest reproduces to the digit before use:

```
flat 128 / ramp / step edge      MED 0.000%  PEAK 0.000%
1-in-100 px +60                  MED 1.020%  PEAK 1.020%   NYQ 3.02
1px vlines every 10              MED 10.101% PEAK 0.000%
3x3 and 2x2 blocks every 12      MED 2.675%  PEAK 0.000%   NYQ 2.44
```

**So every MED and PEAK in this document is comparable to the critic's**, which
was the point of not inventing a new one.

I did write **one** new instrument, `w5frame.mjs`, and §0c says why.

### 0c. The methodological warning, handled — and the critic's framing test does not survive this round

The brief required me to prove I am comparing like framings before attributing
anything. I did, and in doing so found that **the critic's framing instrument
cannot be used on this round's arms.**

`w4frame.mjs` compares 16×9 block-mean luma. That is exactly right for "did the
camera move between two builds that are otherwise identical", and it is wrong
here, because this round moves light and palette **on purpose**. Run on
BASE → SHIP it reports `FRAMING CHANGED` for `07-interactables`, `02-vista` and
`13-biomes-2` — all three of which I can show did not move.

So I built a level-invariant one and **calibrated it against the critic's own
published ground truth** before using it. `w5frame.mjs` correlates normalised
gradient-magnitude maps; a global gain cancels exactly, structure does not.

| pair | edge-r | the critic's verdict on this pair |
|---|---:|---|
| `stages/13-biomes-1` → `FINAL/` | 0.9558 | same |
| `stages/13-biomes-3` → `FINAL/` | 0.9638 | same |
| `stages/02-vista` → `FINAL/` | 0.9454 | same |
| `stages/13-biomes-2` → `FINAL/` | **0.2773** | **re-framed** |
| `stages/13-biomes-4` → `FINAL/` | **0.6878** | **re-framed** |
| `stages/07-interactables` → `FINAL/` | **0.3634** | **re-framed** |

Clean separation, and it agrees with the critic on all six. Two more checks: two
captures of the *same* build correlate at 0.998–0.999
(`FINAL/` → `world2-base/`, three shots), and a ±14 px shift search peaks at
`dx 0, dy 0` for every pair — a changed *bearing* is not a translation, so the
correlation value is the discriminator, not the shift.

**BASE → SHIP, all seven of my shots:**

```
01-title 0.9995   02-vista 0.9752   13-biomes-1 0.9827   13-biomes-2 0.9567
13-biomes-3 0.9538   13-biomes-4 0.9718   07-interactables 0.8760
```

Six sit inside the same-framing band. `07-interactables` at 0.876 sits between
the bands, so I did not accept it on the statistic alone:

- the ±14 px shift search over the **chest subject box** (x560–1100 y280–860)
  peaks at `dx 0, dy 0`;
- the chest, the green cube on its lid and the rock at frame left occupy
  **identical pixel coordinates** in `world2-base/07-interactables.png` and
  `world2-final/07-interactables.png`;
- the depressed correlation is *caused by the fix*: the change removes a large
  clipped glitter field, and that field was itself a large fraction of the
  frame's total edge energy, so the edge map legitimately loses content without
  the camera moving.

**Conclusion: same bearing, same subject, on all seven. Every delta below is
attributable.** This is also a live hazard for whoever measures next — an
edge-correlation framing test reads low whenever the change under test removes
texture, and a block-mean one reads low whenever it changes exposure. Neither
alone is sufficient once the build is being changed on purpose.

### 0d. BASE reproduces every published figure to the digit

Before trusting my baseline I checked it against `reviews/round6/FINAL/`, which
is what the critic judged:

| ROI | `FINAL/` (critic) | `world2-base/` (mine) |
|---|---|---|
| 02-vista right cliff x900–1500 y520–880 | MED 1.130 / PEAK 0.004 / NYQ 2.438; P10–P90 30–35 | MED 1.129 / PEAK 0.004 / NYQ 2.437; P10–P90 30–35 |
| b2 far right spire x1000–1180 y30–260 | MED 4.734 / PEAK 0.220 / NYQ 4.075 | MED 4.766 / PEAK 0.222 / NYQ 4.087 |
| b1 far mountain x300–425 y422–456 | MED 0.353 / PEAK 0.000 / NYQ 2.996 | MED 0.353 / PEAK 0.000 / NYQ 3.000 |
| 07 background x0–520 y0–300 | MED 4.191 / PEAK 0.133 / clip 1.178% | MED 4.175 / PEAK 0.135 / clip 1.176% |
| 07 chest x600–1050 y560–820 | mean 35.0, 67 unique luma, HF sd 1.82 | mean 35.0, 68 unique luma, HF sd 1.82 |
| b3 magenta mask hue 290–345 sat>0.35 | 10.41% of frame | 10.42% of frame |

**The critic's numbers are sound.** I found no figure of its that I could not
reproduce.

### 0e. Failing shots

| capture | failing |
|---|---|
| `reviews/round6/FINAL/` (brief's baseline) | `04-combat`, `06-loaded-hud`, `08-explosion`, `11-bestiary` — **4** |
| `world2-base/` (mine, at HEAD) | `04-combat`, `06-loaded-hud`, `11-bestiary` — **3** |
| **`world2-final/` (ship)** | **`04-combat`, `11-bestiary` — 2** |

**No fifth failure, and no new failing shot name anywhere.** Both shots that
drop out (`06-loaded-hud`, `08-explosion`) fail on `sepP50` legibility margins,
which lighting contrast moves; I claim no credit for them beyond not breaking
them, since other agents were editing `Harness.js` and `VFX.js` in the same tree
throughout (§7).

### 0f. Performance

`node tools/perf.mjs`, final tree: **`combat-24` median 20.5 ms, p95 27.1 ms**,
71 programs, 375 geometries, 53 textures. `ART-ASSETS.md` records the budget as
a 21–26 ms median. Inside it. `Environment.update` is 0.26 ms. The extra
directional light and the per-stage-build scene probe did not cost the frame.
I did not run `perf.mjs` on BASE, so this is stated against the documented
budget and **not** as a measured improvement.

---

## 1. The PMREM probe — the mid-task addition. **LANDED.**

`src/world/Environment.js:359-366` built `_probeScene` as **exactly one mesh**,
the sky dome, and `_bakeEnvironment` baked the environment from it. So the
reflected world contained one high-frequency feature (the sun disc at 15×) and a
smooth analytic gradient in every other direction. Both round-4 critics were
right about what each looked at, and that line is the reconciliation.

**Change:** `Environment.bakeProbe(y)` bakes the PMREM from `ctx.scene`, called
at the end of `Stage.build()` (`src/world/Stage.js`). It cannot go in
`applyBiome`, because `Stage.build` calls that **before** the terrain and props
exist — so the sky-only bake stays there (it is what the terrain's first compile
reads) and the scene bake happens once the stage is complete. The bake parks the
camera-following sky dome at the origin, hides the dust, and nulls
`scene.environment` first so stages do not compound.

**Energy re-derived, not inherited.** `ENV_PROBE_TRIM`, on the four shots
neither the palette edit nor anything else touched, `world2-base/` →
`world2-b/`:

| shot | mean L before | after |
|---|---:|---:|
| `13-biomes-1` | 92.1 | 92.1 |
| `13-biomes-2` | 87.9 | 86.1 |
| `13-biomes-4` | 61.3 | 61.9 |
| `02-vista` | 63.4 | 64.3 |

Mean ratio **1.001**, so the trim is **1.00** — the constant is unchanged
*because it was re-measured*. The stage carries about the same energy as the
gradient it replaced; what moved is where that energy is. (`13-biomes-3` is
excluded because I changed its palette in the same arm; `07-interactables`
because its background luminance is the thing under test.)

### Roughness discrimination — measured indirectly, and **not** to the standard asked for

The instruction was to measure two surfaces at known different roughness
resolving to different pixels, rather than infer it from a whole-frame
statistic. **I did not achieve that and I am not going to dress up something
weaker as if I had.** From a capture I cannot label a pixel with the material
that produced it without guessing at which ROI is which rung, and a guessed ROI
is exactly how five claims died in round 5.

What I *can* show is that the probe now writes scene-dependent content into
reflections, on a surface whose material I do know — the chest in
`07-interactables`, ROI x600–1050 y560–820, camera confirmed unmoved (§0c):

| | `world2-base/` | `world2-final/` |
|---|---:|---:|
| unique luma | 68 | **21** |
| HF sd | 1.82 | 1.08 |
| per-pixel chroma HF | 1.20 | 0.84 |
| dominant hue bin | 240° | 225° |

The chest's reflected image **changed completely**. That is the mechanism
working: before, an `envMapIntensity` 2.6–3.0 surface returned a smooth sky
gradient regardless of what it was standing in; now it returns its own hollow.

**And it is a cost, stated as one.** A prop in a hollow reflects dark terrain,
so the chest's reflected variation went *down* — 68 unique luma to 21 on the
build's worst detail-starvation surface. The correct next move is not to revert
the probe but to give that prop something worth reflecting, or to lift the
probe's contribution on interactables specifically. I did neither, because
either is a guess without the two-rung measurement above.

**Recommendation, and it is the highest-value tooling ask in this domain:** add
a two-rung roughness card (two known-roughness plates, same albedo, adjacent) to
a diagnostic capture. Every roughness claim in six rounds of this project has
been inferred; none has been measured, and nothing in the shipped shots makes it
measurable.

---

## 2. Target 1 — axis 1, `02-vista`'s right cliff. **PARTIAL.**

**Verify line (critic): inside the largest connected sub-L40 region, P10–P90 ≥ 15 luma.**

ROI x900–1500 y520–880, 216 000 px:

| arm | file | P10–P90 | range | mean |
|---|---|---|---:|---:|
| BASE | `reviews/round6/world2-base/02-vista.png` | 30–35 | **5** | 35.1 |
| A (rim 2.55×, bounce 0.40) | `reviews/round6/world2-a/02-vista.png` | 30–37 | 7 | 35.9 |
| B (bounce 1.60) | `reviews/round6/world2-b/02-vista.png` | 31–41 | **10** | 38.1 |
| C (bounce 2.60) | `reviews/round6/world2-c/02-vista.png` | 32–42 | 10 | 38.8 |
| **SHIP** | `reviews/round6/world2-final/02-vista.png` | **31–41** | **10** | **38.1** |

**Range doubled, 5 → 10 luma. The verify line of 15 is not met.**

### What I added to the diagnosis

The critic's "key 0, bounce 0, rim 0" is exact, and I can now say why to the
degree. Biome 0's sun is azimuth 34°. `02-vista`'s bearing is a **fixed world
diagonal** in `Harness.js` and does not depend on the sun, so the view azimuth
is ~126° and that wall's outward normal is ~306°. The wall is therefore **87°
off the key and 93° off the rim** — both terms sit within four degrees of their
own terminator. N·L is ~0.04 and ~0.00.

That has a consequence nobody had stated: **the rim can never fix this.** I
raised `rimScale` 0.29 → 0.74, a 2.55× raise of the light the critic identified
as one of the three at zero, and the wall moved 35.1 → 35.9 mean and 5 → 7 luma
of range. Multiplying a term that is zero. It is the same shape as the three
previous rounds of floor-raising the `FILL` comment already records, and it is
now recorded with a number.

### What worked

A **third azimuth** — a warm bounce off the lit basin, 250° round from the sun
at −9° elevation, carrying the biome's boosted ground colour, no shadow. At that
bearing it lands 22° off the wall's normal, N·L = 0.91. It is the first light in
the rig that reaches the surface at all.

The first attempt still did nothing, and the reason is worth keeping: it was
aimed correctly and set to `max(0.50 × 0.62, 0.40) = 0.40` against a key at
`4.4 × 2.5 = 11.0` — **3.6% of the key**. A bounce card off a sunlit basin is
not a 4% term. At 14.5% the range doubles.

### Why it stops at 10, and what the last 5 luma actually is

C shows the lever saturating: 1.60 → 2.60 (14.5% → 24% of key) bought **zero**
further range and cost hue concentration (`02-vista` whole-frame dominant-bin
share 32.5% BASE → 40.5% B → 38.5% C, against a 30% cap). So the ship setting is
the middle one. **More of the correct lever has stopped being the answer.**

The remaining gap is not light. `scratchpad/v_cliff.png` (the ROI at 1:1) shows
a near-planar wall with fine chroma mottling and **no macro relief at all** — no
buttress, no re-entrant, no cast shadow. Every light in this rig is directional,
and *a directional light cannot put a gradient on a plane*: it delivers one
constant value across a planar surface by construction. The 10 luma I did buy
are the fine detail finally having something raking across it. The other 5 need
the wall to have shape.

**That is a `TerrainGen.js` change** (`wallStart` / `wallBase` / `wallVar` for
biome 0), it is in my file list, and I deliberately did not make it: it moves
the heightfield, which moves `sampleHeight`, which moves prop siting and camera
bearings, which **re-frames every world shot and destroys comparability with
every arm in this document**. It needs its own baseline and its own arm. That is
the single highest-value remaining item in this domain and it is a geometry job,
not a lighting one.

---

## 3. Target 2 — `07-interactables`. **PARTIAL, and the largest measured win here.**

Framing confirmed unmoved by three independent checks (§0c).

**Background, ROI x0–520 y0–300:**

| | `world2-base/07-interactables.png` | `world2-final/07-interactables.png` |
|---|---:|---:|
| MED | 4.175% | **1.830%** (2.3× cut) |
| PEAK | 0.135% | **0.072%** (1.9× cut) |
| NYQ | 3.875 | 3.104 |
| clip255 | 1.176% | **0.422%** |
| mean L | 106.9 | 65.5 |
| dominant hue share | 63.4% @15° | 23.8% @255° |

**Subject vs background** (chest ROI x600–1050 y560–820, mean L 35.0 → 34.7):
ratio **0.327 → 0.530**.

Against the critic's three verify lines:

| verify | target | result |
|---|---|---|
| frame clip255 ≤ 0.6% | 0.6% | **MET** (background quadrant 1.176% → 0.422%) |
| background-quadrant PEAK ≤ 0.03% | 0.03% | not met (0.135% → 0.072%) |
| subject mean L ≥ 0.7 × bgLum | 0.70 | not met (0.327 → 0.530) |

Note the second and third improved by 1.9× and 1.6× **without the subject
getting brighter** — the hard-clipped glitter field stopped out-shouting it.

### Root cause, and it is not the one in the brief

The critic pointed at `Materials.js:1174` (`wetStone roughness 0.045, env 3.4`).
That line is in **biome 1** (Drowned Aqueduct). `07-interactables` runs on
**stage 1 / biome 0** (Cindergrass Flats — the HUD banner in `02-vista` from the
same run, the warm/violet palette, and biome 0 having no `wetStone` override at
all). So that rung was never in this frame and I did not touch it.

What the glitter is: the existing **horizon limit** at
`Materials.js` — the clamp written specifically because "07-interactables'
background was near-binary lit/unlit fragments at 4-8 px with no midtone" —
bounds the perturbed normal by the **view** grazing angle only. A height field
hides slopes steeper than the grazing angle in *two* independent directions:
behind the crest in front of the eye (masking) and behind the crest in front of
the sun (shadowing). Only masking was bounded. A surface viewed near head-on but
lit at a hard rake kept the full 4.0 slope budget and its facets could still
flip the sign of N·L per pixel.

Fix: apply the identical limit on the light axis, from
`directionalLights[0]` (the key — `_buildLights` adds key, rim, bounce in that
order). This is an **extension** of the mechanism that already works, not a
re-tune of it: §6 shows `13-biomes-1`'s numbers did not move.

---

## 4. Target 3 — axis 9, `13-biomes-2`'s far spire. **NOT FIXED.**

ROI x1000–1180 y30–260, 41 400 px. **Verify line: PEAK ≤ 0.03%.**

| arm | file | MED | **PEAK** | NYQ |
|---|---|---:|---:|---:|
| BASE | `world2-base/13-biomes-2.png` | 4.766% | **0.222%** | 4.087 |
| A (Toksvig) | `world2-a/13-biomes-2.png` | 4.643% | 0.220% | 4.058 |
| B (+ light-grazing limit) | `world2-b/13-biomes-2.png` | 4.635% | 0.215% | 4.063 |
| C | `world2-c/13-biomes-2.png` | 4.570% | 0.213% | 4.060 |
| **SHIP** | `world2-final/13-biomes-2.png` | **4.614%** | **0.210%** | 4.062 |

**0.222% → 0.210%. That is nothing, and I am calling it not fixed.** The near
spire face (x480–760 y60–560) went PEAK 0.099% → 0.109%, i.e. marginally worse.

### What I can hand on: two mechanisms tried and **excluded by measurement**

**(a) The UV normal map's own hidden variance — excluded.** The obvious gap in
the existing fix: `detVarS` is a 2×2 quad difference and returns near zero at
Nyquist (its own comment says so), and `detVarW` accounts only for this pass's
analytic octaves — neither can see what mip filtering removed from `normalMap`.
I added the textbook Toksvig term (mip-averaged tangent normal length, scaled by
`normalScale²` and the distance fade squared). Effect on this ROI: **0.222% →
0.220%.**

**(b) Light-axis grazing — excluded here, decisive elsewhere.** Same change that
cut 07's background by 2.3× moved this ROI 0.220% → 0.215%. So the spire is
neither view-grazing nor light-grazing: b2's sun is elevation 19° azimuth 118°
and that face is lit and viewed close to head-on. That asymmetry is the whole
explanation of why `13-biomes-1`'s far mountain reached PEAK 0.000% and this
never has.

Both terms ship. They are correct, they are cheap, and (b) is worth 2.3× on
another shot — but **neither is the root cause here**, and I would rather leave
that written down than leave the next agent to re-derive it.

### The next hypothesis, from the crop rather than from theory

`scratchpad/b2_spire.png` (x990–1180 y25–265 at 3×) shows the surface carrying a
**regular rectangular lattice at roughly 10 source pixels' spacing**, under the
white speckle. A stochastic aliasing failure does not produce a lattice. That is
a *tiling* signature — the detail field's world period, or the UV repeat,
resolving as a visible grid — and it is a different defect from the specular
aliasing the round-3/round-4 chain has been chasing. **Whoever takes this next
should measure the lattice period against `DETAIL.cliff.fine × DET_CELLS` and
against the material's UV repeat before touching another roughness term.**

I stopped after two failed mechanisms rather than trying a third by feel.

---

## 5. Target 4 — axis 3. **SPLIT: palette PARTIAL, low-pass NOT FIXED (and I found what does cause it).**

### 5a. `13-biomes-3`'s magenta — PARTIAL

The critic's read was right and its prescription was slightly off. Every b3
albedo sits at **259–270°** — the rock was never magenta. What put a tenth of
the frame in the 290–345° band was that the *whole frame* is on one hue axis:
violet rock under violet ambient with a hot magenta emissive at 1.35 blooming
across it, so the rock's hue was pushed over the band boundary by the accent.

Change: the rock family leaves the violet axis and goes near-neutral grey
(`rock 0x8f7aa8 → 0x8b8794`, `cliff`, `moss`, `sand`, `wood`, `wetStone`,
`metal` with it); the magenta is **unchanged in hue** and stays on the crystals
and fungus caps alone; crystal `emissive` 1.35 → 0.95.

| verify | target | `world2-base/13-biomes-3.png` | `world2-final/13-biomes-3.png` |
|---|---|---:|---:|
| magenta mask hue 290–345 sat>0.35 | < 4% | 10.42% | **8.03%** — not met |
| no 15° bin above 30% of saturated weight | ≤ 30% | 34.9% @240° | **27.5% @240° — MET** |
| clip255 | ≤ 0.8% | 1.635% | **1.573%** — not met |

Frame mean 72.5 → 75.1. The dominant-bin cap is cleared; the mask is cut by 23%
and the clip by 4%. The whole of the mask movement came in arm A (10.42 → 8.11)
— i.e. it is the palette edit, not the lighting.

**Honest reading of the residual:** the remaining 8% is *area*, not hue. b3
carries 11 crystal clusters at 7–12 crystals of scale 1.6–4.4 plus 130 fungus
caps, all on the crystal rung. Getting under 4% means fewer or smaller magenta
objects — a props/props-count decision with a silhouette cost — and I was not
willing to make that call unbriefed. The clip255 residual is the same objects.

### 5b. `13-biomes-1`'s mesa chroma checker — NOT FIXED, and the low-pass is not the lever

**Verify line: per-pixel chroma HF on x520–880 y540–620 ≤ 2.5.**

| arm | file | chroma HF |
|---|---|---:|
| BASE | `world2-base/13-biomes-1.png` | **5.67** |
| C (low-pass gain 3) | `world2-c/13-biomes-1.png` | 6.13 |
| D (low-pass gain 8) | `world2-d/13-biomes-1.png` | 6.15 |
| SHIP (gain 3) | `world2-final/13-biomes-1.png` | **6.14** |

I implemented exactly what round 3 specified — do not remove the sky-visibility
term, low-pass its input — reusing `detAlpha`, the pass's own existing
measurement of how much of the normal perturbation is sub-pixel, so no fourth
statistic was needed. Then I tested it: **a 2.7× stronger low-pass moved the
target statistic by 0.02.**

**So the sky-visibility weight is not what writes that chroma, and three rounds
of asking for this low-pass have been aimed at the wrong term.** The cause is
§1's probe: the environment map now carries real scene structure, so a per-pixel
normal returns a per-pixel *reflection*, and indirect specular is warm where
indirect diffuse is cool. That is why the number went **up** 5.67 → 6.14 rather
than down.

This is a **regression of 8.3% on that ROI**, it is a direct cost of the probe
fix, and it is the trade I chose: 07's background clip255 1.176% → 0.422% and a
reflection system that responds to the scene, against 0.47 of chroma HF on one
360×80 ROI that was failing its verify line by 2.3× already and now fails by
2.5×. I think that is the right trade and I am flagging it so someone can
disagree with the evidence in front of them.

The low-pass ships at gain 3 anyway, because what it *does* is still correct —
the weight should not fire on relief the pixel cannot resolve — and removing it
would restore a per-pixel coin toss that no measurement here defends.

---

## 6. Target 5 — axis 10, the untextured cube. **NOT FIXED — I could not identify the object.**

It is still there: `world2-final/07-interactables.png` at approximately
x780–880 y340–430, crop at `scratchpad/i_cube.png` (5×). Sampled RGB (25,135,70)
/ (90,182,101) / (172,219,136) across its three visible faces — a lit cube with
hard 90° edges, no texture, no bevel.

Ruled out by inspection of source, so the next agent does not repeat it:

- `ItemOrb` (`Interactables.js:1467`) — `IcosahedronGeometry(0.32, 0)`, wrong
  shape, and `07`'s scenario in `Harness.js` spawns no orb;
- the chest's `glow` plate — `box(1.10s, 0.06s, 0.78s)` at `glowMat`, a flat
  slab at the lid line, wrong aspect entirely, and it *is* visible in the frame
  as the thin green sliver at the top-back of the lid;
- `PlaceablePool` (`entities/Placeables.js`) — acid-green accent is emissive on
  dark shells, and nothing is deployed in this shot;
- `Director`'s trail meshes — additive `MeshBasicMaterial` cylinders;
- the tier colours in `data/items.js` — `uncommon 0x49d67a` is the closest hue
  match and it drives the chest tint and the orb, neither of which is this.

The one thing I can say with confidence: `glowMat` (`Interactables.js:169`) is
**the only material in the interactable ladder with no texture and no
`attachDetail`**, so if it is anything in that file, it is that. I did not change
it on a hunch. Identifying this needs someone to put a breakpoint or a debug
tint on it in a live run, which is one minute of work with the app open and
was not worth a build-and-capture cycle to guess at.

---

## 7. What I changed, and what I did not

**Files changed** (all inside my ownership list):

- `src/world/Environment.js` — `rimScale` 0.29 → 0.74 / `rimMin` 0.30 → 0.46;
  new `BOUNCE` directional light + `_placeBounce`; `bakeProbe()`;
  `ENV_PROBE_TRIM` (re-derived, = 1.00).
- `src/world/Materials.js` — Toksvig term; light-axis horizon limit; `detLP`
  low-pass on the sky-visibility weight; biome-3 palette and crystal emissive.
- `src/world/Stage.js` — one call to `ctx.environment?.bakeProbe?.()` at the end
  of `build()`, with the reason it cannot live in `applyBiome`.

**Not touched:** `TerrainGen.js`, `Props.js`, `Interactables.js`,
`SkyShader.js`, `GradeShader.js`. `Harness.js` and `tools/capture.mjs` were read
and not edited. `reviews/round6/FINAL/` was not modified.

**Not committed.** Two other agents had uncommitted edits to `src/systems/VFX.js`,
`src/core/Harness.js` and `src/ui/HUD.js` in this tree while I worked (their
mid-edit state blocked my build three times, §0f notes the consequence for
attribution). Committing would have swept their work into my commit.

**Guard rails held.** The specular-aliasing fix I was told not to re-tune,
`world2-base/13-biomes-1.png` → `world2-final/13-biomes-1.png`:

| ROI | MED | PEAK | NYQ |
|---|---|---|---|
| far mountain x300–425 y422–456 | 0.353% → 0.376% | **0.000% → 0.000%** | 3.000 → 3.027 |
| far right range x1050–1550 y280–560 | 0.514% → 0.509% | 0.021% → 0.023% | 1.958 → 1.949 |

Unmoved. I extended the mechanism and did not re-tune it.

**Not attempted, as instructed:** the detail-starvation half of axis 5. The
chest is an asset gap and no shader reaches it — and §1 records that the probe
change made that surface's measured flatness *worse*, which is one more reason
to fix it with authored detail rather than with another shader term.

---

## 8. Scorecard

| # | target | verdict | headline measurement |
|---|---|---|---|
| 1 | axis 1, `02-vista` right cliff | **partial** | P10–P90 **5 → 10** luma (verify: ≥15) |
| 2 | `07-interactables` | **partial** | background MED **4.175% → 1.830%**, clip255 **1.176% → 0.422%** |
| 3 | axis 9, `13-biomes-2` far spire | **not fixed** | PEAK **0.222% → 0.210%**; two mechanisms excluded |
| 4 | axis 3 | **partial / not fixed** | b3 dominant bin **34.9% → 27.5% (met)**, magenta 10.42% → 8.03%; mesa chroma **5.67 → 6.14 (worse)** |
| 5 | axis 10, untextured cube | **not fixed** | object not identified in source |
| + | PMREM probe from scene content | **landed** | probe energy-neutral (ratio 1.001); reflections now scene-dependent |

Failing shots **3 → 2**. Build green. `combat-24` median 20.5 ms.
