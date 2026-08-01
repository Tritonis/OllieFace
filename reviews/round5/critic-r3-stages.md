# PETRICHOR — Round 5, critic **round 3 of max 4**: STAGES / LIGHTING / MATERIALS

Domain: axes 1, 2, 3, 5, 10. All ten scored per `RUBRIC.md`.
Shots judged: the **shipped PNGs in `shots/` as captured 2026-08-01 15:15–15:16**
(`13-biomes-1..4`, `02-vista`, `07-interactables`).

**Manifest check.** `ready: true`, `partial: false`, `errors: []`, `subjectsOk: true`,
`subjectFailures: []`, `clockPinned: true`, `seed 1337`. All six judged shots
`frameErrors: 0`, `newErrors: []`. No crash to report. Scoring proceeds on the pixels.

**Method.** My own round-2 scripts, re-run **unmodified**, plus new round-3 instruments
(§7). The fix agent's `matbase/` byte-copy baseline was audited first: re-running
`r2_sky.mjs` against it returns **47.2 / 20.7 / 52.1 / 52.8 / 73.0 / 60.6** and
`f_comp.mjs` returns **1.744 / 1.508 / 0.803 / 1.782 / 1.823 / 1.400** — my published
round-2 figures, to the digit. `diff`ing the agent's `m_*.mjs` copies against my
originals shows a **single changed line each** (`const D=process.env.SHOTS||…`). The
baseline is honest and the before/after below is like-for-like. No project file was
modified; `tools/capture.mjs` was not run.

**Scope note.** The shipped capture postdates *two* fix agents — `FIX-materials.md`
(15:08) and `FIX-harness2.md` (15:10). Bearings on `13-biomes-1..4` and `02-vista` are
unchanged from `matbase` (verified by overlay and by ROI reproduction); `07-interactables`
is a different framing and biome again. Where a defect belongs to the harness rather than
to materials I say so.

---

## 1. Axis scores, round 1 → round 2 → round 3

| # | Axis | b-1 | b-2 | b-3 | b-4 | 02-vista | 07-inter |
|---|------|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 | Lighting & shadow | 6→6→6 | 6→6→6 | 6→7→7 | 6→6→6 | 5→5→**6 (+1)** | 5→6→**3 (−3)** |
| 2 | Composition & depth | 6→7→7 | 5→5→5 | 5→5→5 | 6→6→**7 (+1)** | 3→4→**5 (+1)** | 4→5→**4 (−1)** |
| 3 | Colour & grade | 7→7→**6 (−1)** | 6→7→7 | 5→4→4 | 5→5→5 | 4→4→**5 (+1)** | 5→6→**5 (−1)** |
| 4 | Silhouette & form | 6→6→6 | 5→5→5 | 5→6→6 | 6→6→6 | 5→5→5 | 4→4→**6 (+2)** |
| 5 | **Material believability** | 5→6→**7 (+1)** | 5→6→6 | 5→5→**6 (+1)** | 5→5→**6 (+1)** | 4→4→**5 (+1)** | 3→5→5 |
| 6 | VFX quality | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | 3→3→3 |
| 7 | UI/HUD craft | 8→8→8 | 8→8→8 | 8→8→8 | 8→8→8 | 7→7→7 | 7→7→7 |
| 8 | Readability under load | 6→6→6 | 5→5→5 | 5→5→5 | 5→5→5 | 5→5→5 | 6→6→**3 (−3)** |
| 9 | Post-processing | 8→7→**6 (−1)** | 5→7→**5 (−2)** | 7→7→**6 (−1)** | 4→7→7 | 6→6→6 | 7→7→**4 (−3)** |
| 10 | Cohesion | 7→7→7 | 7→7→7 | 6→6→6 | 6→6→6 | 5→5→**6 (+1)** | 4→5→**4 (−1)** |
| | **mean r3** | **6.3** | **5.8** | **5.7** | **6.0** | **5.4** | **4.4** |
| | r2 mean | 6.4 | 6.0 | 5.7 | 5.8 | 4.9 | 5.4 |
| | r1 mean | 6.3 | 5.6 | 5.6 | 5.5 | 4.8 | 4.8 |
| | **Δ r2→r3** | **−0.1** | **−0.2** | **0.0** | **+0.2** | **+0.5** | **−1.0** |

```
13-biomes-1       AXIS SCORES: 1:6 2:7 3:6 4:6 5:7 6:4 7:8 8:6 9:6 10:7   VERDICT: FAIL
13-biomes-2       AXIS SCORES: 1:6 2:5 3:7 4:5 5:6 6:4 7:8 8:5 9:5 10:7   VERDICT: FAIL
13-biomes-3       AXIS SCORES: 1:7 2:5 3:4 4:6 5:6 6:4 7:8 8:5 9:6 10:6   VERDICT: FAIL
13-biomes-4       AXIS SCORES: 1:6 2:7 3:5 4:6 5:6 6:4 7:8 8:5 9:7 10:6   VERDICT: FAIL
02-vista          AXIS SCORES: 1:6 2:5 3:5 4:5 5:5 6:4 7:7 8:5 9:6 10:6   VERDICT: FAIL
07-interactables  AXIS SCORES: 1:3 2:4 3:5 4:6 5:5 6:3 7:7 8:3 9:4 10:4   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass needs 7+ on every axis with none below 6. No shot clears
it. Build mean 5.6 against round 2's 5.7 — flat.

**But "flat" is the wrong summary and I want to be precise about why.** This round bought
the single largest *artistic* win in six rounds and paid for it with a *technical*
regression that neither the agent nor my own round-2 criteria could see. Axis 5 moved
**+1 in four of six shots** and reaches **7 for the first time anywhere in the project**
(`13-biomes-1`). Axis 9 fell in four of six for one reason, measured in §4. And
`07-interactables` collapsed a full point on a framing the material agent did not choose.

### What is good, and must not be broken

- **The arch is coursed masonry now, and it is unmistakable.** `crops/r3_b1arch.png` at
  3× shows running-bond brick with offset vertical joints and real mortar shadow. Round-2
  defect 1's decisive complaint — "hewn aqueduct masonry is indistinguishable from the
  natural cliff behind it" — is **dead in the pixels**, and §3 measures it dead.
- **`13-biomes-4` is now the best-composed frame in the build.** Near L54 → mid L63 → far
  L100 with genuine haze separation, a crane silhouette against a sunset, and 291→**103**
  flat tiles. Axis 2 hits 7. Its 107-flat-tile foreground mountain cell is down to 34.
- **`02-vista` is up +0.5, the biggest per-shot gain of the round**, on four axes at once.
  Its dominant 240° hue bin fell **38.1% → 31.4%** and its flat tiles **722 → 305**.
- **The chest is properly modelled.** Plank slats, iron corner posts, a banded dome lid,
  legible wood grain (`crops/r3_07chest.png`). Round-2 defect 5(a) (lid at 1.9× body) and
  5(b) (cream boxes interpenetrating the lid) are both **fixed outright**.
- **Blow-out is down across the board.** `L>215`: 0.68→0.54 / 1.13→**0.45** / 1.00→0.90 /
  0.21→0.18 / 0.37→0.34 %. b2's near cliff went from 12.61% of its pixels above L200 to
  **1.35%**. The round-2 "crinkled foil" is genuinely less blown.
- **The agent's reporting is straight.** Its baseline reproduces mine exactly, it flagged
  its own b1 non-improvement, its own 07 incomparability, its own missed criteria and its
  own hue regression before I asked. Two of its numbers do not reproduce (§2, claims 2
  and 5); neither is a case of dressing anything up.

---

## 2. Claim verification — VERIFIED / REFUTED / PARTIAL

| # | Claim | Verdict | My measurement on the shipped pixels |
|---|---|---|---|
| 1 | Texture-free 50.3 / **16.6** / **25.3** / **37.4** / **36.9** / 59.7; 4 of 6 now pass vs 1 | **VERIFIED** | `r2_sky.mjs` unmodified on shipped: **48.3 / 17.8 / 24.3 / 36.5 / 35.8 / 60.2**. Every figure within **1.2 points** of the claim. Four pass `<40%`, up from one. Baseline reproduces round 2 to the digit. |
| 1b | (my own correction, favourable to the agent on b1 and unfavourable on 07) | — | The `<40%` denominator is *single-surface tiles*, not frame tiles, and it is unstable. **b1's flat-tile count fell 137 → 73** while the ratio rose, because the denominator halved (290 → 151). On the denominator-free measure — flat tiles ÷ all non-sky non-HUD tiles — every biome shot improved: **9.6→5.1 · 1.8→1.3 · 8.1→2.7 · 19.7→7.0 · 50.6→21.4 %**. **b1 did better than the agent claimed.** `07` went **10.0 → 17.4%**, i.e. worse, on a framing that is not comparable. |
| 2 | Cross-material HF-sd spread **11.6×** vs my ≥4× criterion | **PARTIAL — the number reproduces, the evidence does not** | My spread: b3 boulder **36.41** → 07 chest body **3.33** = **10.9×**. But HF sd scales with illumination, and this build contains a **9.7× *within*-material lighting spread in one frame**: `07` ground lit-dapple HF **13.64** vs `07` ground in shadow HF **1.40**, same material, same shot. b3 boulder lit 36.41 vs shade 26.41 is another. A 10.9× cross-material spread is barely above what one material achieves by shading alone. **My ≥4× HF-sd criterion was confounded and I withdraw it.** Material identity is real — see §3 for evidence that actually isolates it. |
| 3 | Running-bond mortar courses at a fixed **1.70 m** world period on hewn stone | **VERIFIED, with a correction** | Visible without instruments at 3× on b1's arch and 02-vista's arch. Measured: b1's near arch leg carries a **new** vertical spectral peak at **12.0 px holding 59.7% of in-band (4–40 px) power**; in `matbase` the same ROI was **28.3 px at 26.3%** — no course at all. Correction: `Materials.js:319` is `joint:[0.55, 1.70, 0.45, 0.170]` and `detJoint` (`Materials.js:381`) sets row height = period × aspect = **0.765 m**, so the *courses* are 0.765 m apart and 1.70 m is the block length. The comment at `Materials.js:314` still says "1.15 m course" against a shipped 1.70 — stale, and it is the number the FIX doc quotes. |
| 4 | Hue matrix down on all six pairs, worst **−0.146** on b2↔b3 | **VERIFIED exactly** | `f_comp.mjs`: **1.694 / 1.466 / 0.775 / 1.637 / 1.776 / 1.379**. Worst pair −0.145. Ruling in §5: **the trade was worth it.** |
| 5 | Monolith specular saturation **0.149** (from 0.059) against my 0.15 | **REFUTED** | The ROI that reproduces round 2's baseline *exactly* — peak `RGB(255,255,240)` at **(626,407)**, sat **0.059** — gives shipped **peak `RGB(253,253,225)` at (636,228), sat 0.111**. Not 0.149. Criterion missed by **26%**, not by one thousandth. The agent's clipping figure *does* reproduce (ROI hard-clipped px **695 → 301**, −57%) and the improvement is real — saturation roughly doubled — but the headline number is not on these pixels. Hue still **60°** against a ~33° key. |
| 6 | The ≥3× near/far period criterion is missed; the first-zero statistic is saturated by its own 15-tap high-pass | **VERIFIED — and I withdraw the criterion. See §3.** | Confirmed and strengthened. World-locking re-tested with a sound instrument and **VERIFIED**. |
| 7 | (agent's disclosure) `02-vista` dark cliff still open at HF 1.34 vs ≥6.0; basin untouched | **VERIFIED** | HF sd **1.15 → 1.41**; P10–P90 **32–36, four luma** over 600×400 px; γ2.2 boost (`crops/r3_02dark.png`) shows one violet value plane with faint mottling and no form. **270 of the shot's 305 remaining flat tiles (89%) sit in that one quadrant.** Round-2 defect 2 stands, on that surface, essentially untouched. |
| 8 | (round-2 defect 5) chest silhouette and neighbours | **VERIFIED FIXED** | Lid ≤1.2× body, faceted banded dome, no prop intersecting the convex hull, plank slats and iron posts legible at 2×. Round-2 defect 5(a)(b)(c) all closed. |
| 9 | **NOT DISCLOSED — new finding.** The detail pass aliases | **REFUTED as harmless** | Frame-wide isolated-bright fraction (a pixel exceeding its 8-neighbour median by >25 luma) rose in **all six shots at identical bearings**: **0.74→1.47 · 2.20→3.58 · 1.11→2.18 · 0.45→0.65 · 0.56→0.76 · 0.30→1.49 %**. Worst per-surface where it should be least: b1 far mountain **0.12→0.64 (5.3×)**, b2 hewn column **0.55→2.14 (3.9×)**, b1 near mesa **1.87→6.47 (3.5×)**, b4 far range **0.59→1.67 (2.8×)**. Defect 2. |
| 10 | (brief) the harness is now deterministic; 14/16 pixel subjects bit-identical | **PARTIAL — statistically yes, bit-wise no** | **0 of 21 full frames are pixel-identical** between `detA` (15:13) and the shipped capture (15:15), nor between `det-a`/`det-b` (14:58/14:59). Residual is grain-scale: world shots differ on 53–57% of channels at **meanΔ 0.68/255**; UI shots at maxΔ 1–2. **Statistical reproducibility is confirmed and is what mattered** — my independent re-measurement landed within ±1.2 points of the agent's on all six texture-free figures and reproduced its baseline to the digit. **Do not build a round-4 acceptance test on byte equality.** |

---

## 3. RULING — the ≥3× near/far period criterion is **unsound**, and I withdraw it

The agent reports the criterion missed (1.63× → 1.32×) and argues the instrument is
saturated. **I rule for the agent, on its reason plus a worse one it did not give, and the
error is mine.**

**(a) The agent's reason is correct.** `r2_period.mjs` high-passes each row by subtracting
a **15-tap moving average** before autocorrelating. That filter attenuates everything
above ~15 px of period, so the first zero crossing is bounded near the filter's own
bandwidth on *every* surface, by construction.

**(b) The worse reason.** The first zero crossing of an autocorrelation measures a
**correlation length**, not a dominant period. On broadband content it returns the
analysis filter's bandwidth and nothing about the surface. Round 2 measured **7–13 px on
thirteen surfaces** because that is what the filter returns — not because thirteen
surfaces agreed. **My round-2 inference "the detail is locked to the screen, not to the
world" was not supported by the statistic I drew it from, and I withdraw it.** The
*visual* half of that finding — hewn masonry indistinguishable from natural cliff — was
sound and independently confirmed by crops; the numeric half was an artefact of my own
filter. This is the third finding of mine this project has overturned by measurement, and
correctly so.

**The replacement, run.** The agent's proposal is the right instrument — a known
world-periodic feature at two distances — and the arch is now exactly that. Vertical
power spectrum of column-averaged luma, Hann-windowed, restricted to the 4–40 px band:

| ROI (same object, same material) | `matbase` dominant / concentration | **shipped** |
|---|---|---|
| b1 arch, **near** right leg | 28.3 px / 26.3% | **12.0 px / 59.7%** |
| b1 arch, **far** left leg (upper) | — | **8.2 px / 33%** |
| b1 **natural** mesa face | 28.2 px / 64.6% | 28.2 px / 52.5% |
| b1 **natural** far mountain | 27.8 px / 75.3% | 27.8 px / 67.8% |

Two results:

1. **World-locking VERIFIED.** Near leg **12.0 px**, far leg **8.2 px** — ratio **1.46×**
   — against a distance proxy from the two legs' screen widths of **1.34×**. Consistent
   to within 9%. The course scales inversely with distance; it is in the world.
2. **The round-2 root cause is measured closed.** In `matbase`, the hand-authored hewn
   arch (28.3 px) and the natural mesa beside it (28.2 px) were **1.00× apart** — the
   exact complaint. They are now **2.35× apart** (12.0 vs 28.2), and the arch's spectral
   concentration more than doubled (26.3% → 59.7%): natural rock stayed broadband, hewn
   stone acquired a sharp single peak. **Periodic-vs-broadband, not amplitude, is what
   separates tooled stone from raw rock, and that separation now exists.** Axis 5 reaches
   7 in `13-biomes-1` on this evidence.

**Round 4 should use this instrument and drop both of my round-2 verify lines** (`≥3×`
first-zero spread; `≥4×` HF-sd spread). Replacement:

> On hewn stone, the 4–40 px vertical spectrum must show a peak holding **≥40% of in-band
> power**, and natural rock in the same frame must hold **<30%** in its strongest peak.
> Today: b1 arch 59.7% / b1 mesa 52.5% — the arch passes, the rock does not yet
> (natural rock still carries too much single-scale content). That is the next target.

---

## 4. The undisclosed cost — **the detail pass aliases, and my own criterion paid for it**

`13-biomes-2` was, in round 2, "the best-looking frame in the product". Look at it now
(`crops/r3_b2far.png`, 4×): the distant spires are a field of near-white specks at 2–3 px,
with the baked noise texture's **tiling seams faintly visible as a grid**. `13-biomes-1`'s
mesa top (`crops/r3_b1ground.png`, 3×) is a per-pixel **blue/red chroma checker** over
rust — that is the new sky-visibility weight modulating at the noise field's frequency on
an up-facing surface, and it reads as compression noise, not cinder. `07`'s background
(`crops/r3_07glit.png`, 4×) is near-binary: lit fragments at L>200 against near-black with
no midtone at all.

Measured, at identical bearings, `matbase` → shipped:

| shot | salt% (px >25L above 8-nbr median) | L>215 | L>240 |
|---|---|---|---|
| 13-biomes-1 | 0.74 → **1.47** | 0.68 → 0.54 | 0.14 → 0.11 |
| 13-biomes-2 | 2.20 → **3.58** | 1.13 → 0.45 | 0.15 → 0.10 |
| 13-biomes-3 | 1.11 → **2.18** | 1.00 → 0.90 | 0.17 → 0.16 |
| 13-biomes-4 | 0.45 → **0.65** | 0.21 → 0.18 | 0.10 → 0.09 |
| 02-vista | 0.56 → **0.76** | 0.37 → 0.34 | 0.11 → 0.11 |
| 07-interactables † | 0.30 → **1.49** | 0.88 → **2.46** | 0.34 → **0.58** |

† different framing; direction is nonetheless what the crop shows.

**This is my fault as much as the agent's.** "Texture-free fraction < 40%" counts
high-frequency *energy* with no upper frequency bound. Per-pixel glitter scores
identically to authored relief. I set a criterion that a sufficiently aggressive normal
perturbation can satisfy by aliasing, and it partly did. The agent optimised the
criterion it was briefed on, disclosed everything it measured, and this is not in its
table because nothing it was given could see it.

**Where it comes from, in the code.** `detField` (`Materials.js:396`) fades only the fine
octave with distance — `fineK` at line 403 multiplies `uDetA.y` at line 412 and nothing
else. The coarse/ridge octave (`uDetA.w`, line 426) and the joints (`uDetC.x`, line 447)
have **no distance term and no grazing term at all**. And `detJoint` (`Materials.js:380`)
is pure analytic `floor`/`fract`/`sign` with a fixed world groove width — it has no filter
width, so its grooves alias unconditionally once the groove falls under a pixel. The
baked-texture mip chain protects the noise octaves and nothing protects the rest.

**Replacement acceptance criterion for round 4:**

> Texture-free < 40% **and** frame-wide salt fraction **≤ the round-2 baseline**
> (0.74 / 2.20 / 1.11 / 0.45 / 0.56 / 0.30 %). Detail that raises the second number to buy
> the first is rejected.

---

## 5. RULING — the hue regression: **worth it. Accept it and do not spend round 4 on it.**

Verified exactly: **1.694 / 1.466 / 0.775 / 1.637 / 1.776 / 1.379**, all six down, worst
−0.145 on b2↔b3.

**Judgement of what it cost:**

- **Magnitude is small on a 0–2 scale.** The worst pair lost 8% of its value. Five of six
  pairs remain inside the 1.36–1.78 band I protected in round 2. The sixth, b1↔b4, was
  already the weak seam and moved −0.028 — noise.
- **It is invisible.** b2 is olive-green, b3 is magenta-violet, b1 is sunset-orange, b4 is
  industrial red. Nobody looking at the four frames would guess a palette metric moved.
  The protected win — "the four biomes read as four places" — is intact by inspection.
- **What it bought is not small.** The same indirect-lighting term is the mechanism
  behind `02-vista`'s dominant 240° bin falling **38.1% → 31.4%** — that is *my own defect
  6's metric*, on the frame that was worst on it, moving 6.7 points in the right
  direction. It is also behind `02-vista` texture-free 73.0→35.8 and b3 52.1→24.3, the
  two largest material gains of the round.
- The agent tried three counter-measures, kept the one that recovered a tenth of the loss,
  and reverted two that made other pairs worse. That is the correct process, and I confirm
  the two reverted levers should stay reverted.

**Trade accepted.** Round 4 must not chase this back — every remaining lever is a palette
change and would cost the material gains that paid for it.

**One cost the agent did not measure, though.** The sky-visibility weight is being applied
per-pixel at the *detail field's* frequency, and on b1's near-horizontal mesa top that
produces the blue/red chroma checker in `crops/r3_b1ground.png` — visible chroma noise, and
a −1 on b1's axis 3. **Do not remove the term; low-pass its input.** Drive it from the
geometric normal blended a fixed fraction toward the perturbed normal, or clamp its
per-pixel variation, so it produces a gradient across a face rather than a dither within
one.

---

## 6. TOP DEFECTS (ranked — work top-down)

**1. `07-interactables`: half the frame is a hard-clipped glitter field and the hero prop is unlit inside it. Axes 1 (3), 8 (3), 9 (4), 10 (4).**
`src/game/Harness.js` (07 bearing / biome pick) · `src/world/Materials.js` (grazing-angle normal amplitude)
The chest sits at mean L **36.0** while the surrounding terrain blows to **L>215 on 2.46%
of frame** and **L>240 on 0.58%** — both roughly 3× every other shot. `crops/r3_07glit.png`
at 4× shows the background is not a material: it is near-binary lit/unlit fragments at
4–8 px with **no midtone**, produced by the detail normal flipping the N·L sign under a
low grazing key. Manifest's own subject check records `lum 4.1` vs `bgLum 43.5`. The
rubric's four-point row for axis 8 — "screen is undifferentiated noise" — is met
literally: an enemy or a pickup anywhere in the upper-left would be invisible. Compounding
it, a **raw flat-shaded green cube at sat 0.67** (the item pickup) sits on a 254° violet
chest against a 27° orange field: three unrelated hues, no hierarchy, and an untextured
primitive in a build that now has coursed masonry and planked wood.
**Fix:** (i) clamp the perturbed normal's deviation from the geometric normal as
`dot(V, N_geom)` falls — at grazing incidence a height field's visible slope is
horizon-limited and today it is not; (ii) reject the establishing bearing when the
subject's mean luma falls below the background's, or add a complement-hue fill so the
chest is not contre-jour; (iii) give the pickup cube the chest's material family.
**Verify:** subject mean luma ≥ 0.8 × background mean luma; `L>215` ≤ 1.0% of frame;
salt ≤ 0.6%; no prop in the frame at `HF sd < 2` with `sat > 0.6`.

**2. The detail pass aliases: frame-wide isolated-bright fraction up 1.4–2.0× at identical bearings, worst on the most distant surfaces. Axes 9, 5. All six shots.**
`src/world/Materials.js:396` (`detField`, distance/grazing gating) · `:380` (`detJoint`, no filter width)
salt%: **0.74→1.47 · 2.20→3.58 · 1.11→2.18 · 0.45→0.65 · 0.56→0.76 · 0.30→1.49**. Per
surface it is inverted from what it should be — b1 **far** mountain **0.12→0.64 (5.3×)**,
b4 **far** range 0.59→1.67, b2 hewn column 0.55→2.14 — i.e. worst where the field should
have retired. `fineK` (line 403) gates only `uDetA.y` (line 412); the coarse/ridge octave
(line 426) and the joints (line 447) have **no distance and no grazing term**, and
`detJoint` is analytic `floor`/`fract`/`sign` with a fixed world groove width and
therefore no filter width at all. The baked mip chain protects the noise and nothing
protects the rest. In a static PNG it reads as glitter; in motion it will crawl.
**Fix:** compute the field's screen-space period from `fwidth(vDetW)` and fade `gradW`
to zero as it falls under ~4 px; extend that fade to `uDetA.w` and `uDetC.x`, not just
`uDetA.y`; widen `detJoint`'s groove by `fwidth` so a sub-pixel groove becomes a tint
rather than an edge.
**Verify:** salt fraction ≤ round-2 baseline (0.74 / 2.20 / 1.11 / 0.45 / 0.56 / 0.30 %)
**with** texture-free still < 40% in the four shots that now pass.

**3. `02-vista`'s right cliff: a quarter of the establishing shot is still one plane with four luma of range. Axes 2 (5), 5 (5).**
`src/game/Harness.js` (bearing) · `src/world/Environment.js` (bounce/rim terms)
HF sd **1.15 → 1.41** against my ≥6.0 criterion; P10–P90 **32–36** over 600×400 px; γ2.2
boost shows one violet plane with faint mottling and no form (`crops/r3_02dark.png`).
**270 of the shot's 305 remaining flat tiles — 89% — are in that quadrant**, so the frame's
whole 722→305 gain came from the basin side and this surface took none of it. The basin
itself (round-4 defect #4) is likewise untouched at HF 1.95, P10–P90 40–49. The agent
correctly declined to claim either.
**Fix:** the bearing genuinely is the first half — re-pick so the right third is not one
mass's shade side. Independently, this cliff needs a sky-hue rim on its top edge and a warm
bounce from the lit basin; both are lighting, not material, and no material lever reached
them across two rounds. **Do not use a grade lever** (round-2 §4 stands).
**Verify:** inside the largest connected sub-L40 region, **P5–P95 ≥ 20 luma**, and ≥2
sub-regions each ≥3% of frame with means ≥15 luma apart.

**4. There is still no metal in the build. Axis 5, `13-biomes-4` and `02-vista`.**
`src/world/Materials.js` (`metalRuin` metalness/env) · biome material assignment
b4's shipping containers: HF sd **9.45**, sat 0.51, hue 346°, **no specular break anywhere
on them** — matte plastic in an industrial biome. The build's only specular highlight
remains `02-vista`'s monolith, now at peak sat **0.111** (up from 0.059, but 26% under the
0.15 criterion) at hue **60°** against a ~33° key, with **301 hard-clipped pixels** still
in the ROI. The agent's per-class roughness modulation is doing real work — clipping is
down 57% — but a dielectric highlight cannot be tinted, and that is the point: this needs
`metalness ≥ 0.7` on the container and crane materials so the highlight takes the *metal's*
colour, not the light's.
**Verify:** b4 containers show a specular lobe with ≥25 luma of peak-to-plateau contrast
and a roughness break along the 2.30 m panel seams; monolith peak sat ≥0.15 with **no**
channel at 255 and hue within 25° of the key.

**5. The teleporter beam is a frame-spanning bar in two shots. Axes 2, 8, 10.**
`src/world/Interactables.js` (shaft emissive) · `src/game/Harness.js` (bearing rejection)
Geometric locator on shipped: height as % of frame / beam-to-frame-mean ratio —
b1 **30% / 1.60×** (passes both), b2 18% / 1.92×, b3 32% / 1.65×, **b4 53% / 2.23×**,
**02-vista 44% / 2.22×**, 07 9% / 2.02×. b4's is a flat cream bar 476 px tall with no
falloff and no glow, dead centre-right; 02-vista's still runs down through the hero arch.
Hue remains a clean win — 253° / 134° / 319° / 25° / 271° across biomes.
Not the material agent's file; carried forward unchanged from round-2 defect 4.
**Fix:** fade the shaft emissive with **screen-space height** — full at the base collar,
zero by 40% of frame height. Add landmark-bbox rejection to the establishing bearing.
**Verify:** ≤1.6× frame mean and ≤35% of frame height in all four biomes; zero overlap
with the landmark bbox in `02-vista`.

**6. `13-biomes-3` is still a magenta field and `13-biomes-4` a red bath. Axis 3 (4 / 5).**
`src/world/Materials.js` (per-biome palettes)
b3 puts **15.4% of the whole frame** into hot magenta at mean sat 0.50 (round 2: 16.1% —
essentially unmoved) with its dominant 15° bin at **36.3%** of saturated weight: roughly
ninety magenta objects, so there is no accent left, only a field, and anything spawned in
that frame is unfindable. b4's dominant 0° bin is **39.2%**, marginally worse than 38.5%.
The counter-example is in the build: `13-biomes-2` at **14.7% / mean sat 0.27** is the most
restrained frame and the only one passing the cap. `02-vista` came from 38.1% to **31.4%**
this round, which shows the cap is reachable.
**Verify:** no 15° bin above **30%** of saturated weight in any shot; b3 magenta-mask
fraction below **4%** of frame, with magenta demoted to crystals only and the rock left
grey-violet.

---

## 7. Withdrawn or corrected from my own earlier rounds

- **Round-2 defect 1's *numeric* half — withdrawn.** "Every surface carries the same detail
  at 7–13 px, a 1.9× spread" was an artefact of the 15-tap high-pass in `r2_period.mjs`,
  which bounds the first-zero statistic near its own bandwidth on any broadband surface.
  The visual finding it accompanied was sound; the statistic could not have shown
  otherwise. The agent was right to challenge it. **§3.**
- **My `≥3× near/far first-zero` verify line — withdrawn**, replaced by the world-periodic
  feature test in §3, which the arch now passes.
- **My `≥4× HF-sd spread across material classes` verify line — withdrawn.** HF sd
  confounds illumination with material: this build shows a **9.7× within-material spread**
  from shading alone in a single frame. Replaced by the spectral-concentration test in §3.
- **My `texture-free < 40%` criterion — amended, not withdrawn.** It has no upper frequency
  bound, so aliasing scores as relief. Must now be paired with the salt ceiling in §4.
- Round-2's withdrawal of the b4 contour-stripe finding stands.

## 8. Evidence / scripts

Round-1/2 scripts re-run **unmodified**: `png.mjs`, `r2_sky.mjs`, `r2_roi.mjs`,
`r2_beam.mjs`, `r2_where.mjs`, `f_comp.mjs`, `crop.mjs`. New round-3 instruments, all in
the session scratchpad `…/a0777b2c-…/scratchpad/`:

- `r3_sky.mjs` — texture-free census reported with **absolute flat-tile counts and a
  denominator-free flat/area ratio**, which is what exposed the b1 denominator artefact.
- `r3_spk.mjs` — per-ROI mean / HF sd / P1–P99 / `L>200` / **salt fraction** / saturation,
  run side-by-side over two shot directories.
- `r3_glob.mjs` — frame-wide `L>215`, `L>240`, `L<24`, salt fraction.
- `r3_spec2.mjs` — Hann-windowed vertical power spectrum of column-averaged luma,
  restricted to a 4–40 px band; the mortar-course instrument of §3.
- `r3_peak.mjs` — spectral **concentration** (three-bin peak ÷ in-band total), two
  directories side by side.
- `r3_mono.mjs` — monolith peak RGB / saturation / hue / hard-clipped-pixel census.
- `r3_hue.mjs` — dominant 15° bin share, magenta-mask fraction, mean saturation.
- `r3_px.mjs` — full-frame **pixel**-level (not byte-level) diff between two captures; the
  determinism audit of claim 10.
- `r3_where.mjs`, `r3_diff.mjs`, `r3_view.mjs`, `r3_course.mjs` — spatial flat-tile
  histogram, sky-fraction/mean-luma comparison, downscaled framing check, vertical
  autocorrelation.

Crops produced and inspected: `r3_b1arch` (3×, the coursing), `r3_b1ground` (3×, the chroma
checker), `r3_b2far` / `r3_b2near` (4×, the speckle and the tiling seams), `r3_07glit` (4×,
the binary lit/unlit background), `r3_07chest` (2×), `r3_02dark` (2×, γ2.2),
`r3_02arch` (4×), `r3_base02` / `r3_baseb2` (framing verification against `matbase`).

Baselines used: `matbase/` (the fix agent's byte copy of the round-2 shipped shots,
audited against my published figures and confirmed exact), `det-a` / `det-b` and `detA`
(determinism audit). No project file was modified; `tools/capture.mjs` was not run;
`shots/manifest.json` read for the crash check and the 07 subject figures only.
