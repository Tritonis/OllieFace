# PETRICHOR — Round 6, critic **round 4 of max 4 (FINAL)**: WORLD / LIGHTING / MATERIALS

Domain axes: 1, 2, 3, 5, 9, 10. All ten scored per `RUBRIC.md`.
Judged: **`reviews/round6/FINAL/*.png` with `reviews/round6/FINAL/manifest.json` only.**
Shots: `01-title`, `02-vista`, `07-interactables`, `13-biomes-1..4`.
Seed 1337, 1600×900, `clockPinned: true`. `shots/` was not opened.
**No project file was modified. `tools/capture.mjs` was not run.**

**Manifest check.** `ready: true`, `partial: false`, `clockPinned: true`, `seed: 1337`.
`subjectsOk: false` with 4 failing shots — `04-combat`, `06-loaded-hud`, `08-explosion`,
`11-bestiary`. **None of them is mine.** All seven of my shots record `frameErrors: 0`,
`newErrors: []`, and `subject.ok: true`. No crash to report; scoring proceeds on pixels.

---

## 0. My instrument, and what it is blind to

Written from scratch for this review — a dependency-free PNG decoder
(`w4png.mjs`) and a three-statistic filter (`w4salt.mjs`). It shares no code with
`reviews/round6/tools-stages/`. Scratchpad:
`…/0b1c8b51-0e0a-4c66-afea-a339e10a9b45/scratchpad/`.

| stat | definition |
|---|---|
| **MED** | `L − median(8 neighbours) > 25`, % of pixels considered. The round-3 critic's and the stages agent's definition, reimplemented for comparability. |
| **PEAK** | `L − **max**(8 neighbours) > 25`. Fires **only on single-pixel peaks**. |
| **NYQ** | RMS of the diagonal-Nyquist kernel `[[1,−1],[−1,1]]/4`. Threshold-free energy at the highest representable frequency. |

**Calibration, run before every session** (`node w4salt.mjs --selftest`):

```
flat 128               MED   0.000%   PEAK   0.000%   NYQ 0.00
ramp 0..255            MED   0.000%   PEAK   0.000%   NYQ 0.00
step edge              MED   0.000%   PEAK   0.000%   NYQ 0.00
1-in-100 px +60        MED   1.020%   PEAK   1.020%   NYQ 3.02
1-in-100 px +20        MED   0.000%   PEAK   0.000%   NYQ 1.01
1px vlines every 10    MED  10.101%   PEAK   0.000%   NYQ 0.00
3x3 blocks every 12    MED   2.675%   PEAK   0.000%   NYQ 2.44
2x2 blocks every 12    MED   2.675%   PEAK   0.000%   NYQ 2.44
white noise sd~8       MED   0.000%   PEAK   0.000%   NYQ 4.11
```

Two things follow, and they govern every number below.

1. **MED reproduces the stages agent's published selftest to the digit** (1.020 /
   0.000 / 0.000 / 10.101 / ~2.7 vs its 2.778 — my 2.675 is the same construction
   with border blocks excluded). So MED is a like-for-like third reading of its
   statistic.
2. **PEAK closes the blind spot the stages agent disclosed and could not close.**
   Its §0b states plainly that a *resolved* 3×3 feature scores 2.778 % on MED, so
   "the statistic cannot separate detail from aliasing on a near surface". **PEAK
   scores that same case 0.000 %**, and 0.000 % on 2×2 blocks, on 1px lines, on
   ramps and on step edges, while still recovering isolated single-pixel specks at
   1.020 %. A non-zero PEAK is therefore **positive evidence of sub-pixel
   aliasing**, on near surfaces as well as far ones. This is the one instrument
   capability neither round 3 nor the stages agent had.

**What PEAK is blind to, stated up front:** it returns 0 on 1px *lines* and on any
feature ≥2 px in both axes, so it under-reports coherent aliasing (moiré, crawling
seams). It is a lower bound on aliasing, never an upper one. It also cannot fire
where the whole neighbourhood is clipped at 255.

**What none of my three can do:** separate illumination from material. Round 2's
critic in this domain withdrew a root cause over exactly that confound and round 3
withdrew its `≥4×` HF-sd criterion for it. I do not use HF sd for any
cross-material claim in this document.

---

## 1. THE CLAIM — independently measured. **CONFIRMED, to the digit.**

The claim under test, from `FIX-stages.md` §1/§3, accepted-unverified in
`VERIFIED.md`:

> b1 far mountain ROI (x 300–425, y 422–456): **2.000 % → 0.471 %**, against a
> detail-off floor of 0.400 %. 5.0× above the floor becomes 1.18×.

My decode of the named files, ROI x 300–425 y 422–456, n = 4250 px in every arm:

| arm | file on disk | MED | PEAK | NYQ |
|---|---|---:|---:|---:|
| OFF (floor) | `reviews/round6/base/13-biomes-1.png` | **0.400 %** (17/4250) | 0.024 % (1) | 3.088 |
| CTRL (2nd OFF arm) | `reviews/round6/ctrl/13-biomes-1.png` | **0.400 %** (17/4250) | 0.024 % (1) | 3.251 |
| PRE — no gates | `reviews/round6/detPRE/13-biomes-1.png` | **3.176 %** (135/4250) | 0.188 % (8) | 4.833 |
| ON — predecessor's gates | `reviews/round6/detON/13-biomes-1.png` | **2.000 %** (85/4250) | 0.071 % (3) | 4.202 |
| FIX (agent's arm) | `reviews/round6/stages/13-biomes-1.png` | **0.471 %** (20/4250) | 0.000 % (0) | 3.247 |
| **SHIPPED** | `reviews/round6/FINAL/13-biomes-1.png` | **0.353 %** (15/4250) | **0.000 %** (0) | 2.996 |

**Every figure the agent published reproduces exactly** — 0.400, 3.176, 2.000,
0.471, and the raw counts 17 / 135 / 85 / 20 out of 4250. Nothing was rounded in
its favour. My MED is a third instrument and it agrees with round 3's 5.3× and the
agent's 5.0× (I measure 2.000/0.400 = **5.00×**).

**Two things I can add that the agent could not:**

**(a) The mechanism is confirmed by an instrument that only fires on aliasing.**
PEAK on this ROI goes **8 → 3 → 0** single-pixel peaks across PRE → ON → FIX. NYQ
energy goes 4.833 → 4.202 → **3.247**, and the shipped arm at **2.996** sits
*below* the detail-off floor of 3.088. A roughness term that converts sub-pixel
normal variance into lobe width should suppress exactly Nyquist-band energy and
exactly isolated peaks, and it did both. **The specular-aliasing root cause is
correct, and it is the right fix for it.**

**(b) It generalises to a surface the agent never named.** I picked my own ROI —
b1's far right mountain range, x 1050–1550 y 280–560, 140 000 px, a surface absent
from `FIX-stages.md`:

| arm | file | MED | PEAK | NYQ |
|---|---|---:|---:|---:|
| ON | `reviews/round6/detON/13-biomes-1.png` | 1.147 % (1606) | 0.094 % (132) | 2.486 |
| **SHIPPED** | `reviews/round6/FINAL/13-biomes-1.png` | **0.511 %** (716) | **0.020 %** (28) | **1.957** |

A 2.2× cut and a 4.7× cut in single-pixel peaks, on a surface chosen after the fix
was written. This is not curve-fitting to the agent's own ROI.

**VERDICT ON THE CLAIM: CONFIRMED.** Numbers reproduce, mechanism is corroborated
by an orthogonal statistic, and the effect generalises. This is the best-evidenced
fix in six rounds of this project, and the shipped build is marginally *better*
than the arm the agent measured (0.353 % vs 0.471 %).

### 1b. …and what the claim does not cover, which is most of the build

The agent was explicit that frame-wide salt does not return to `base/` and that
near surfaces are outside its statistic's reach. **PEAK reaches them, and the
answer is that two shots still alias badly.**

| ROI (all from `reviews/round6/FINAL/`) | MED | **PEAK** | NYQ |
|---|---:|---:|---:|
| b1 far mountain (the fixed surface) | 0.353 % | **0.000 %** | 2.996 |
| b1 far right range | 0.511 % | 0.020 % | 1.957 |
| b4 far ridge x150–450 y200–330 | 0.279 % | 0.015 % | 1.177 |
| 02-vista right cliff x900–1500 y520–880 | 1.130 % | 0.004 % | 2.438 |
| b3 upper rock x900–1400 y40–320 | 1.800 % | 0.082 % | 2.892 |
| **b2 near spire face x480–760 y60–560** | 2.765 % | **0.103 %** | 3.399 |
| **b2 far right spire x1000–1180 y30–260** | **4.734 %** | **0.220 %** | 4.075 |
| **07 background x0–520 y0–300** | **4.191 %** | **0.133 %** | 3.879 |

**b2's *far* spire — the surface that should carry the least detail of anything in
that frame — is the noisiest surface in the build, at 0.220 % single-pixel peaks.**
By calibration PEAK returns 0.000 % on resolved 2×2 and 3×3 relief, so that 0.220 %
cannot be explained as "detail the filter can't tell from aliasing". It is
aliasing, on a distant surface, after the fix. The crop
(`scratchpad/c_b2far.png`, x 400–800 y 20–220 at 3×) reads as crushed foil, not
rock.

The fix landed on b1 and did not land on b2. That is not a flaw in the diagnosis —
it is unfinished work at the same root cause.

---

## 2. A capture fact that invalidates three shot-to-shot comparisons

**`13-biomes-2`, `13-biomes-4` and `07-interactables` are different framings in
`FINAL/` than in `stages/`.** Measured with a 16×9 block-mean luma signature
(`w4frame.mjs`), which is insensitive to per-pixel noise and sensitive to framing:

| shot | `stages/` → `FINAL/` mean L | L1 per block | worst block | verdict |
|---|---|---:|---:|---|
| `13-biomes-1` | 92.01 → 92.14 | 0.242 | 7.00 | same bearing |
| `13-biomes-3` | 72.45 → 72.45 | 0.254 | 5.12 | **same** |
| `02-vista` | 63.42 → 63.43 | 0.244 | 3.61 | **same** |
| `13-biomes-2` | 96.26 → **87.92** | 21.373 | 78.02 | **CHANGED** |
| `13-biomes-4` | 65.44 → **61.34** | 7.863 | 25.98 | **CHANGED** |
| `07-interactables` | 45.48 → **72.91** | 35.677 | 128.63 | **CHANGED** |

Consequences, and they are load-bearing:

- **`FINAL/13-biomes-2` at frame MED 3.247 % versus `stages/` at 2.153 % is not a
  regression caused by the stages fix.** It is a different, nearer view of the
  same biome. Nobody should attribute it to `Materials.js`.
- Same for `FINAL/07-interactables` at 2.418 % versus `stages/` 0.493 %.
- **My per-shot scores for b2, b4 and 07 are therefore not comparable to round 3's
  per-shot scores** for those three. Only b1, b3 and 02-vista are like-for-like
  across the round-6 arms. I say so rather than presenting a delta table that
  would be false.

---

## 3. Axis scores

| # | Axis | 01-title | 02-vista | 07-inter | b-1 | b-2 | b-3 | b-4 |
|---|------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | Lighting & shadow | 6 | 5 | **3** | 6 | 5 | 5 | 6 |
| 2 | Composition & depth | 8 | 5 | **3** | **7** | 4 | 5 | 6 |
| 3 | Colour & grade | 8 | 6 | 4 | 6 | **7** | **4** | **7** |
| 4 | Silhouette & form | 7 | 5 | 5 | 6 | 4 | 6 | 6 |
| 5 | **Material believability** | 5 | 5 | **3** | 6 | 4 | 5 | 4 |
| 6 | VFX quality | 5 | 4 | 3 | 4 | 4 | 4 | 4 |
| 7 | UI/HUD craft | **9** | 7 | 7 | 8 | 8 | 8 | 8 |
| 8 | Readability under load | 8 | 5 | **3** | 6 | 4 | 4 | 6 |
| 9 | Post-processing | 7 | 6 | **3** | 6 | 4 | 5 | 6 |
| 10 | Cohesion | 8 | 6 | 4 | 7 | 6 | 6 | 7 |
| | **mean** | **7.1** | **5.4** | **3.8** | **6.2** | **5.0** | **5.2** | **6.0** |

```
01-title          AXIS SCORES: 1:6 2:8 3:8 4:7 5:5 6:5 7:9 8:8 9:7 10:8   VERDICT: FAIL
02-vista          AXIS SCORES: 1:5 2:5 3:6 4:5 5:5 6:4 7:7 8:5 9:6 10:6   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:3 2:3 3:4 4:5 5:3 6:3 7:7 8:3 9:3 10:4   VERDICT: FAIL
13-biomes-1       AXIS SCORES: 1:6 2:7 3:6 4:6 5:6 6:4 7:8 8:6 9:6 10:7   VERDICT: FAIL
13-biomes-2       AXIS SCORES: 1:5 2:4 3:7 4:4 5:4 6:4 7:8 8:4 9:4 10:6   VERDICT: FAIL
13-biomes-3       AXIS SCORES: 1:5 2:5 3:4 4:6 5:5 6:4 7:8 8:4 9:5 10:6   VERDICT: FAIL
13-biomes-4       AXIS SCORES: 1:6 2:6 3:7 4:6 5:4 6:4 7:8 8:6 9:6 10:7   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. No
shot clears it; `01-title` comes closest and is held down by axes 5 and 6, which
its content barely exercises. Mean over my seven shots **5.5**; over the six
comparable to round 3, **5.3** against round 3's 5.6 — but see §2: three of those
six are different framings, so that delta is not a measurement of anything.

---

## 4. THE HONEST PER-AXIS LEDGER

This is the section the round-4 brief asked for. For each axis: does it clear 7,
and is the residual a **code** problem someone could still fix or an **asset**
problem no shader work will close.

### Axis 1 — Lighting & shadow. **Does not clear 7 anywhere. Tops out at 6. CODE.**

`02-vista`'s right cliff, x 900–1500 y 520–880, **216 000 px**:
`P10–P90 = 30–35`. **Five luma values across 24 % of the establishing shot.**
(`FINAL/02-vista.png`.)

The decisive new evidence is that **PEAK on that ROI is 0.004 % and NYQ is 2.438,
identical to `detON/`'s 0.004 % / 2.441.** The stages fix did not touch it —
correctly, because there is nothing there to alias. That surface is not noisy, not
over-detailed, not mis-textured. **It is unlit.** It receives key = 0, bounce = 0,
rim = 0, and one flat hemisphere fill.

This is a `world/Environment.js` problem and nothing else. Two rounds of material
work reached it and moved it by 0.003 percentage points on every statistic I have.
**It is code, it is unambiguous, and it is the single highest-value unfixed item
in this domain.** Round 3 named it as defect 3; it is unchanged.

Corroborating: `07`'s subject sits at mean L **35.0** against a background at
**106.9** — the hero prop is 3× darker than its surround with zero fill light.
The manifest records this itself (`lum 4.3`, `bgLum 36.6`) and passes the shot.

> **Verify:** inside the largest connected sub-L40 region of any shot,
> **P10–P90 ≥ 15 luma**; and no shot's named subject at mean luma below 0.7× its
> own `bgLum`.

### Axis 2 — Composition & depth. **Clears 7 on `13-biomes-1` (7) and `01-title` (8). Nowhere else. CODE.**

Where it works it is measurable. b1's near/mid/far mean luma ladder is
**68.8 → 94.8 → 115.0**, monotonic across 46 luma (ROIs x500–900 y640–780 /
x930–1010 y470–650 / x300–425 y422–456, `FINAL/13-biomes-1.png`). That is real
aerial perspective and the arch is a real focal point.

Where it fails it is also measurable. b2: **83.0 → 90.0 → 108.9**, 26 luma across
the whole depth of frame, with twelve near-identical tapered spires and no
landmark reading as a focus. b4's ladder is **non-monotonic** (56.4 near → 75.8
mid → 61.8 far).

This is bearing selection in `src/game/Harness.js`, not lighting and not material.
**Code, and cheap.**

One caveat against my own reading: b1's saturation goes **0.489 → 0.560 → 0.571**
with distance. Real aerial perspective *desaturates* with depth. b2 gets this right
(0.295 → 0.243 → 0.172) and b1 gets it backwards, which is why b1's depth reads on
value alone.

### Axis 3 — Colour & grade. **Clears 7 on `13-biomes-2` (7), `13-biomes-4` (7), `01-title` (8). CODE.**

Dominant 15° hue bin as a share of saturated weight, whole frame,
`FINAL/*.png`:

| shot | dominant bin | share | mean sat | clip255 |
|---|---|---:|---:|---:|
| `13-biomes-2` | 210° | **20.3 %** | 0.249 | 0.451 % |
| `13-biomes-1` | 15° | **28.8 %** | 0.465 | 0.782 % |
| `13-biomes-4` | 0° | **29.0 %** | 0.385 | 0.463 % |
| `02-vista` | 240° | 32.5 % | 0.418 | 0.494 % |
| `13-biomes-3` | 240° | **34.8 %** | 0.492 | **1.635 %** |

Round 3's cap was ≤30 %. **b1 and b4 now pass it** — b4 came from 39.2 %. That is
real progress and it should be recorded as such.

**b3 is the outlier and it is one constant.** Magenta mask (hue 290–345°,
sat > 0.35) covers **10.41 % of the whole frame** against round 3's < 4 % target,
and b3 clips 1.635 % of its pixels — the highest in the build. b2 measures
**0.00 %** on the same mask, so the fix is a palette edit in
`src/world/Materials.js`, demoting magenta to crystals and leaving the rock
grey-violet. **Code, one constant.**

**Second, smaller, and visible:** round 3's §5 asked for the sky-visibility weight
to be **low-passed, not removed**, because it produces a per-pixel blue/red chroma
checker on b1's up-facing mesa top. It was not actioned. Per-pixel chroma HF on
that ROI (x 520–880 y 540–620) is **6.25 (`detON`) → 5.66 (`FINAL`)** — a 9 %
move. The crop `scratchpad/c_mesa.png` (x 480–800 y 520–660 at 3×) shows the mesa
top as blue/rust stripes that read as a broken texture, on the establishing frame
of biome 1. **Code, and round 3 wrote the fix out.**

### Axis 5 — Material believability. **Does not clear 7 anywhere. Tops out at 6 on `13-biomes-1`. SPLIT — and the code half is larger than `ART-ASSETS.md` says.**

Three separate things are being called "axis 5" and they have different answers.

**(a) Material *identity* — CODE, and it now works. Do not break it.**
`scratchpad/c_arch.png` (`FINAL/13-biomes-1.png`, x 660–1000 y 140–480 at 2×)
shows running-bond masonry with offset vertical joints and mortar shadow on the
hero arch, clearly distinct from the natural mesa beside it. It survived the
roughness increase intact. This is the one genuine axis-5 win the project has and
it was produced entirely in code with no assets.

**(b) `ART-ASSETS.md`'s central premise is wrong, and it matters.** It states the
roughness ladder "cannot express itself, because the PMREM environment in
`world/Environment.js` is a featureless analytic gradient", and concludes "four
rounds of tuning those numbers were wasted work". In source:

- `src/shaders/SkyShader.js:151-161` renders a **hard sun disc**
  (`smoothstep(0.9976, 0.9990, sd)` × **15.0**) plus a three-lobe glow.
- `:177-199` renders a **warped-fbm cloud deck** with lit and shaded sides.
- `src/world/Environment.js:390` bakes the PMREM **from that sky scene**
  (`_pmrem.fromScene(this._probeScene, …)`), **per stage build**, not once at boot
  from defaults.

The disc subtends ≈4° — about 11 px on a 256 px cube face — so it survives into
the low-roughness mips. **The environment is not featureless and the ladder does
express itself.** The pixel evidence that it does is unflattering: `07`'s
background is a warm-hued (dom 15°, matching the key) hard-clipped specular field
at MED 4.191 % / clip255 1.178 %, which is a near-mirror rung
(`Materials.js:1174`, `wetStone roughness 0.045, env 3.4`) reflecting that disc
through a perturbed normal. **The ladder is not silent; its lowest rung is
screaming.**

I did not render the PMREM myself, so I am asserting this from source plus
consistent pixel evidence, not from a decoded probe. But the "featureless
gradient" premise is refuted by the shader source alone, and **an HDRI purchase
justified by that premise should not be made until someone re-derives the
diagnosis.**

**(c) Detail starvation — ASSET, and this half is real.** No shader closes these:

| surface (`FINAL/`) | px | unique luma | HF sd | NYQ |
|---|---:|---:|---:|---:|
| `07` chest body x600–1050 y560–820 | 117 000 | **67** | 1.82 | **0.708** |
| `02-vista` right cliff x900–1500 y520–880 | 216 000 | (P10–P90 = 5 luma) | — | 2.438 |
| `13-biomes-4` far ridge x150–450 y200–330 | 39 000 | 129 | 2.98 | 1.177 |

The chest is the sharpest statement of it: **NYQ 0.708 on the hero prop against
3.879 on its own background — a 5.5× high-frequency ratio pointing the wrong
way.** The subject of the shot is the flattest thing in it. That is what
`ART-ASSETS.md` calls detail starvation and it is correctly diagnosed.

**(d) There is still no metal — CODE, not asset.** b4's shipping containers
(x 330–700 y 600–700, `FINAL/13-biomes-4.png`): HF sd 5.91, **clip255 0.003 %**,
P10–P90 45–75, uniform matte red (`scratchpad/c_cont.png` at 3×). The material is
authored `metalRuin roughness 0.34 / metalness 0.56 / env 2.2`. Metalness kills
the diffuse and a 0.34-roughness GGX lobe over a 3–10 px facet is spread too wide
to read as a highlight, so the result is a colour, not a metal. **Fix is a
roughness drop plus an anisotropic break along the 2.30 m panel seams — code.**
Round 3 called this defect 4 and it is unchanged.

**Honest split: roughly (a)+(b)+(d) code, (c) asset.** The code half is not small
and is not exhausted.

### Axis 9 — Post-processing. **Does not clear 7 anywhere. Tops out at 7 on `01-title`. CODE.**

Frame-wide, `FINAL/`: MED / PEAK / clip255 —
b1 **1.213 / 0.023 / 0.782 %** · b2 **3.247 / 0.114 / 0.451 %** ·
b3 **2.489 / 0.079 / 1.635 %** · b4 **0.663 / 0.013 / 0.463 %** ·
02-vista **0.741 / 0.014 / 0.494 %** · **07 2.418 / 0.068 / 1.631 %** ·
01-title 0.303 / 0.000 / —.

b1, b4 and 02-vista are clean. **b2 and 07 are not, and their PEAK values prove
sub-pixel aliasing rather than resolved relief.** The teleporter beam is the
second axis-9 item: measured column-by-column
(`w4col.mjs`), it spans **68 / 81 / 71 / 80 / 73 %** of frame height in
b1 / b2 / b3 / b4 / 02-vista at **1.7–2.6× frame mean**, with **no falloff** — in
b1, b3, b4 and 02-vista the top quarter is *brighter* than the bottom quarter. My
locator's run also crosses background, so treat the spans as approximate; the
crops are unambiguous. Round 3's verify line (≤35 % of frame height, ≤1.6× frame
mean) is missed in all five. **Code, in `src/world/Interactables.js`.**

### Axis 10 — Cohesion. **Clears 7 on `13-biomes-1`, `13-biomes-4` (7) and `01-title` (8). CODE.**

Each biome reads as one authored place, and the four read as four places. The two
things that break it are both single objects: the **raw untextured green cube**
item pickup (visible in `07` and `13-biomes-4`) sitting in a build that now has
running-bond masonry and planked wood, and the beam bar. Both are code, both are
small, and neither has been touched across two rounds.

### Axes outside my domain, scored as required

- **Axis 4 (silhouette)** — 4 to 7. b4's crane against the sunset is the only true
  black-silhouette read in the build. b2's twelve near-identical tapered spires are
  the worst. Structural, not material — `ART-ASSETS.md` §"A silhouette rule" is
  right about this.
- **Axis 6 (VFX)** — 3 to 5, never above. Nothing in my seven shots exercises it
  fairly; do not read my numbers as a VFX verdict.
- **Axis 7 (UI/HUD)** — 7 to 9. **The only axis that clears 7 build-wide.**
  `01-title` is the best frame in the product: angular chamfered plates, one cyan
  accent, deliberate hierarchy, a blurred live stage behind.
- **Axis 8 (readability)** — 3 to 8. `07` meets the rubric's literal 4-point row.

---

## 5. TOP DEFECTS (ranked — work top-down)

**1. `07-interactables`: the hero prop is 3× darker than a hard-clipped glitter field. Axes 1 (3), 2 (3), 5 (3), 8 (3), 9 (3).**
`src/world/Environment.js` (fill/bounce) · `src/game/Harness.js` (07 bearing) · `src/world/Materials.js:1174` (`wetStone` rung)
Chest mean L **35.0** (x600–1050 y560–820) against background mean L **106.9**
(x0–520 y0–300). Background MED **4.191 %**, PEAK **0.133 %**, clip255 **1.178 %**,
NYQ 3.879; chest NYQ **0.708** with **67 unique luma over 117 000 px**. The
manifest passes this shot while recording `lum 4.3` vs `bgLum 36.6`.
**Fix:** (i) reject an establishing bearing whose subject mean luma falls below
0.7× `bgLum`, or add a complement-hue fill; (ii) the background is a near-mirror
`wetStone` rung point-sampling the sky's 15× sun disc — raise its floor roughness
or fold `fwidth`-derived variance into it the way `13-biomes-1` now does;
(iii) give the green cube pickup the chest's material family.
**Verify:** subject mean L ≥ 0.7 × `bgLum`; frame clip255 ≤ 0.6 %; background-quadrant PEAK ≤ 0.03 %.

**2. `02-vista`'s right cliff: 216 000 px at five luma of range, and it is a lighting hole, not a material one. Axes 1 (5), 2 (5), 5 (5).**
`src/world/Environment.js` (bounce / rim terms)
x 900–1500 y 520–880: `P10–P90 = 30–35`. **PEAK 0.004 % and NYQ 2.438, identical
to `detON/`'s 0.004 % / 2.441** — the stages fix passed straight over it because
there is nothing there to alias. Round 3 called this and it has not moved.
**Fix:** a sky-hue rim on the top edge and a warm bounce from the lit basin.
**Do not use a grade lever** (round 2 §4 stands).
**Verify:** inside the largest connected sub-L40 region, **P10–P90 ≥ 15 luma**.

**3. `13-biomes-2` still aliases after the fix, worst on its most distant surface. Axes 5 (4), 9 (4), 8 (4).**
`src/world/Materials.js` (the same variance term that fixed b1)
Far right spire x1000–1180 y30–260: MED **4.734 %**, **PEAK 0.220 %**, NYQ 4.075 —
the noisiest surface in the build, on the geometry that should carry the least
detail. Near spire face x480–760 y60–560: MED 2.765 %, PEAK 0.103 %. **PEAK returns
0.000 % on resolved 2×2 and 3×3 relief by calibration**, so this is not "detail the
statistic can't distinguish". The stages fix took b1's far mountain to PEAK 0.000 %
and left b2 at 0.220 %; whatever term is saturating there is the remaining work.
**Verify:** every ROI at >40 m depth in all four biomes at **PEAK ≤ 0.03 %** with the b1 arch's masonry spectrum unchanged.

**4. There is still no metal. Axis 5, `13-biomes-4`.**
`src/world/Materials.js` (`metalRuin` roughness / seam anisotropy)
Containers x330–700 y600–700: HF sd 5.91, **clip255 0.003 %**, uniform matte red.
Authored `metalness 0.56 / roughness 0.34` and reads as plastic.
**Verify:** a specular lobe with ≥25 luma peak-to-plateau contrast and a roughness break along the 2.30 m panel seams.

**5. `13-biomes-3` is a magenta field. Axis 3 (4), 8 (4).**
`src/world/Materials.js` (biome-3 palette)
Magenta mask (hue 290–345°, sat > 0.35) = **10.41 % of frame** against a < 4 %
target; dominant 240° bin **34.8 %** against a 30 % cap; **clip255 1.635 %**, the
highest in the build. b2 measures **0.00 %** on the same mask, so the counter-example
ships in the same build.
**Verify:** magenta mask < 4 % of frame; no 15° bin above 30 % of saturated weight; clip255 ≤ 0.8 %.

**6. The teleporter beam is a frame-spanning bar in five of five world shots, and it got worse. Axes 2, 9, 10.**
`src/world/Interactables.js` (shaft emissive) · `src/game/Harness.js` (bearing rejection)
68–81 % of frame height at 1.7–2.6× frame mean with no falloff — brighter at the
top than the bottom in four of five. Round 3 measured b1 at 30 % / 1.60× (passing);
it is now ~68 % / 1.9×.
**Verify:** ≤35 % of frame height and ≤1.6× frame mean in all four biomes; zero overlap with the landmark bbox in `02-vista`.

**7. b1's mesa top is still a per-pixel blue/red chroma checker. Axis 3 (−1), 5.**
`src/world/Materials.js` (sky-visibility weight input)
chroma-HF on x520–880 y540–620: **6.25 → 5.66**, a 9 % move on a fix round 3
specified in full ("do not remove the term; low-pass its input"). Visible in
`scratchpad/c_mesa.png` at 3×.
**Verify:** per-pixel chroma HF on that ROI ≤ 2.5 with the ROI's luma HF sd unchanged.

---

## 6. THE ANSWER TO "KEEP GRINDING OR STOP" — and it is not the expected one

**Which axes clear 7:**

| | clears 7 build-wide | clears 7 in some frames | never clears 7 anywhere |
|---|---|---|---|
| | **7 (UI)** | 2 (b1, title) · 3 (b2, b4, title) · 10 (b1, b4, title) · 4 (title) | **1, 5, 6, 8, 9** |

**The conclusion I did not expect to reach: of the residual holding this build
under 7, the large majority is *code*, not assets.**

- Axis 1's ceiling is one unlit mass in `Environment.js`, and I can now prove it is
  not a material or aliasing problem because PEAK and NYQ on it are **bit-for-bit
  unchanged** between the pre-fix and shipped arms.
- Axis 2's ceiling is bearing selection in `Harness.js`.
- Axis 3's ceiling is one palette constant and one un-actioned low-pass.
- Axis 9's ceiling is one shader term that already works on b1 and hasn't been
  extended to b2, plus one emissive falloff.
- Axis 10's ceiling is one untextured cube and one beam.

**Axis 5 is the only axis where `ART-ASSETS.md` is right that no shader closes it**
— and even there, only the detail-starvation half (§4c). Its stated root cause for
the *other* half, that the PMREM is a featureless gradient, is refuted by
`SkyShader.js:151-199` and `Environment.js:390`.

So the honest answer is neither "keep grinding" nor "stop". It is:

> **The loop is not failing to find fixes. It is failing to land them.** Round 3
> named defects 3, 4, 5 and the chroma-checker low-pass with file paths and verify
> lines. Three rounds later, defect 3 has moved 0.003 pp, defect 4 has not moved,
> defect 5 has got **worse**, and the low-pass moved 9 %. Meanwhile the one defect
> that *was* assigned to an agent this round — the salt — was root-caused
> correctly, fixed, and independently verified to the digit.
>
> The constraint is dispatch, not diagnosis, and not assets. **If there is a round
> 5 for this domain it should assign defects 2, 4, 6 and 7 above to an
> implementer, not another critic.** A fifth critic will re-derive this list.

The one thing worth buying is the thing `ART-ASSETS.md` gets right for the right
reason: **hand-authored surface detail for props** — the chest at 67 luma values
over 117 000 px is not reachable from a shader. Everything else on this page is.

---

## 7. Withdrawn, corrected, or declined from earlier rounds

- **Round 3's per-shot deltas for `13-biomes-2`, `13-biomes-4` and `07-interactables`
  cannot be carried into round 4** — those three are different framings in `FINAL/`
  (§2). I decline to publish a delta for them rather than publish a false one.
- **`ART-ASSETS.md`'s "featureless analytic gradient" premise — challenged** on
  source evidence (§4b). I have not decoded the PMREM itself; someone should,
  before an HDRI is bought on that reasoning.
- **Round 3's `≥3×` first-zero and `≥4×` HF-sd criteria remain withdrawn.** I used
  neither. I make no cross-material HF-sd claim anywhere in this document, for the
  reason round 2 gave.
- **My own PEAK statistic is a lower bound on aliasing, not an upper one** (§0). A
  PEAK of 0.000 % on b1's far mountain does not prove that surface is free of
  coherent aliasing — only of isolated-peak aliasing. Do not build a pass gate on
  PEAK alone; pair it with MED and NYQ as I have.

## 8. Evidence

All instruments written for this review, in
`…/0b1c8b51-0e0a-4c66-afea-a339e10a9b45/scratchpad/`:
`w4png.mjs` (PNG decoder + synthetic-image builder for calibration),
`w4salt.mjs` (MED / PEAK / NYQ + `--selftest`), `w4run.mjs` (batch ROI),
`w4roi.mjs` (percentiles, unique-luma census, HF sd, clip255, saturation,
dominant-hue bin, per-pixel chroma HF), `w4frame.mjs` (16×9 framing signature),
`w4mask.mjs` (hue-band mask fraction), `w4col.mjs` / `w4beam3.mjs` (beam column
profile), `w4crop.mjs` (PNG crop/zoom writer).

Crops inspected: `c_arch.png` (b1 arch, 2× — the masonry), `c_mesa.png` (b1 mesa
top, 3× — the chroma checker), `c_cont.png` (b4 containers, 3× — the absent
metal), `c_b2far.png` (b2 spires, 3× — the stipple).

Files decoded: `reviews/round6/FINAL/{01-title,02-vista,07-interactables,13-biomes-1..4}.png`
and `manifest.json`; and for the claim verification only,
`reviews/round6/{base,ctrl,detPRE,detON,stages}/{13-biomes-1..4,02-vista,07-interactables,01-title}.png`.
Source read (not modified): `src/world/Environment.js`, `src/world/Materials.js`,
`src/world/Props.js`, `src/shaders/SkyShader.js`.
`shots/` was not opened. `tools/capture.mjs` was not run.
