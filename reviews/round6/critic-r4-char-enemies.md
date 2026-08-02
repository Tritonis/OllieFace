# Round 6 / critic round 4 (FINAL) — Character read, enemies, readability

Domain: rubric axes **4** (silhouette & form) and **8** (readability under load)
primarily; all ten scored. Shots judged: `03-thirdperson`, `04-combat`, `05-boss`,
`09-survivors`, `11-bestiary`, `12-boss-phases`.

**Round 4 of a maximum 4. There is no round 5 for this domain.** The last section —
*the honest per-axis ledger* — is the part of this document that is meant to survive.

Everything below was measured this session on
`C:\Users\tpzap\source\repos\OllieFace\reviews\round6\FINAL\*.png` at native
1600×900. Two earlier on-disk captures are used as before-states and are named
every time they are quoted:

- `reviews/round5/base-r4/` — round 3's evidence artifact. Confirmed: its
  `manifest.json` records `04-combat` survivor `lum 45.5 / bgLum 117.7 /
  contrast 0.442 / sepP50 0.59 / legible 0.915`, which is verbatim what round 3
  quoted. `clockPinned: true`, `subjectsOk: true`.
- `reviews/round6/base/` — this round's baseline. `clockPinned: true`.

Nothing is credited from `FIX-*.md`, `shots/`, or any agent report. No project file
was modified and `tools/capture.mjs` was not run.

---

## Manifest check (RUBRIC requires this first)

`reviews/round6/FINAL/manifest.json`: `seed 1337`, **`ready: true`**, `partial: false`,
`clockPinned: true`, `determinism.frameDt 0.016666…`, `determinism.frameTimeouts: 0`.
**No crash, no boot failure, no black frame.** There is no defect #1 of the kind
RUBRIC reserves that slot for.

`subjectsOk: false`, four failing shots — `04-combat` (horde), `06-loaded-hud`,
`08-explosion`, `11-bestiary` (spawn roster). Two are mine and both are the known,
in-progress failures named in the dispatch. Per instruction I judge the pixels:

| shot | gate detail | vs. `base-r4` |
|---|---|---|
| `04-combat` horde | `20/24` visible, `perPx` zeros at i=0,7,23 and i=14 at 1 px | `18/24` and six zeros — **improved** |
| `11-bestiary` roster | `16/16` visible, one object fails on `sepP50 0.17` | `16/16`, six failing objects — **improved** |

Neither failure is a regression and neither is scored as one.

---

## AXIS SCORES

```
AXIS SCORES 03-thirdperson:  1:4 2:4 3:6 4:7 5:3 6:5 7:7 8:6 9:5 10:6   mean 5.3
AXIS SCORES 04-combat:       1:5 2:5 3:5 4:4 5:4 6:5 7:7 8:4 9:4 10:6   mean 4.9
AXIS SCORES 05-boss:         1:5 2:6 3:6 4:7 5:4 6:5 7:7 8:6 9:5 10:7   mean 5.8
AXIS SCORES 09-survivors:    1:5 2:4 3:6 4:8 5:4 6:5 7:6 8:6 9:4 10:6   mean 5.4
AXIS SCORES 11-bestiary:     1:4 2:4 3:5 4:7 5:4 6:6 7:7 8:6 9:5 10:7   mean 5.5
AXIS SCORES 12-boss-phases:  1:5 2:6 3:6 4:6 5:4 6:4 7:7 8:5 9:5 10:7   mean 5.5

DOMAIN MEAN PER AXIS:        1:4.7 2:4.8 3:5.7 4:6.5 5:3.8 6:5.0 7:6.8 8:5.5 9:4.7 10:6.5

VERDICT: FAIL
```

Pass is 7+ on every axis with nothing below 6. **No axis clears 7 as a domain mean.**
**Axis 4 clears 7 on four of six shots** — `03` (7), `05` (7), `09` (8), `11` (7) —
which is the most shots it has ever cleared on, from an opening score of 3/10.

### Movement against round 3

| shot | r3 mean | **r4 mean** | Δ | axis 4 | axis 8 |
|---|---|---|---|---|---|
| 03-thirdperson | 5.4 | **5.3** | −0.1 | 7 → 7 | 6 → 6 |
| 04-combat | 4.5 | **4.9** | +0.4 | 4 → 4 | 4 → 4 |
| 05-boss | 4.0 | **5.8** | **+1.8** | 2 → **7** | 3 → **6** |
| 09-survivors | 5.4 | **5.4** | 0.0 | 7 → **8** | 6 → 6 |
| 11-bestiary | 5.6 | **5.5** | −0.1 | 7 → 7 | 6 → 6 |
| 12-boss-phases | 5.7 | **5.5** | −0.2 | 5 → 6 | 5 → 5 |

`05-boss` is the largest single-shot movement recorded in this domain in any round.
The three shots that moved backwards moved by 0.1–0.2, which is inside my own
scoring resolution; I do not claim those as regressions.

### The one structural fact that frames all of the above

Pixel diff of `FINAL` against the two on-disk before-states, fraction of pixels
differing by >8 levels in any channel:

| shot | vs `round5/base-r4` | vs `round6/base` |
|---|---|---|
| **03-thirdperson** | **3.7%** (mean \|Δ\| 1.4) | 18.4% |
| 04-combat | 93.5% | 93.2% |
| 05-boss | 83.3% | 81.7% |
| 09-survivors | 64.8% | 62.9% |
| 11-bestiary | 88.4% | 89.0% |
| 12-boss-phases | 85.0% | 81.8% |

**Five of my six shots were restaged wholesale. `03-thirdperson` is 96.3%
pixel-identical to round 3's own evidence artifact.** Its score is therefore
essentially round 3's score, and correctly so — nothing in that frame changed.

---

## Instrument, and its calibration

Rebuilt from scratch (`r4lib.py`), calibrated on synthetic shapes **before** any
frame was scored, so my numbers can be compared to round 2's and round 3's:

| calibration pair | round 2 | round 3 | **this round** |
|---|---|---|---|
| perfect disc vs perfect square | 0.777 | 0.787 | **0.799** |
| perfect disc vs 1:4 tall bar | — | 0.320 | **0.305** |
| perfect square vs 1:4 tall bar | — | 0.255 | **0.245** |
| disc at 102 px vs disc at 80 px (self-identity) | — | — | **0.988** |

Three independent implementations agree to within 0.022 on the reference pair and
mine returns 0.988 on a shape against itself at a different scale, so the
normalisation is not destroying information. **Collapse threshold = 0.799**; round
3's 0.787 is reported alongside every verdict so the two are directly comparable.

Method: per-subject local background from a 12 px cell-median taken **only from the
ring outside the hand-placed box**, nearest-filled and bilinearly upsampled;
residual `D = ‖I−B‖₂` at threshold `TH`; 3×3 closing then 2×2 opening; components
touching the central 50% and ≥8% of the largest kept; uniform-scale normalisation
(longest side → 102 px) onto a centroid-centred 128×128; IoU maximised over ±6 px
translation. Subject boxes were read off a 100 px coordinate grid rendered over each
shipped PNG and every mask was inspected at 2–6× nearest-neighbour.

Every silhouette verdict was recomputed at `TH` = 18, 30, 45, 60. **Unlike round 3,
one verdict is threshold-dependent this round and I report it as such rather than
picking the flattering threshold** (§2).

---

## 1. `09-survivors` — the strongest result in the domain

Border-independent ring-background masks, threshold-swept.

| survivor | area | w × h | fill | cplx | mask foot y | harness `footY` |
|---|---|---|---|---|---|---|
| RANGER | 17787 | 138×280 | 0.46 | 3.81 | 576 | 576 |
| ANVIL | 17944 | 196×242 | 0.38 | 4.75 | 586 | 576 |
| KESTREL | 11984 | 104×289 | 0.40 | 3.97 | 577 | 576 |
| ROOK | 20200 | 141×250 | 0.57 | 4.14 | 586 | 576 |

Pairwise IoU (TH 30 / TH 18 / TH 45):

```
RANGER/ANVIL   0.360 / 0.428 / 0.278      ANVIL/KESTREL  0.331 / 0.257 / 0.281
RANGER/KESTREL 0.367 / 0.393 / 0.229      ANVIL/ROOK     0.450 / 0.486 / 0.373
RANGER/ROOK    0.388 / 0.462 / 0.349      KESTREL/ROOK   0.314 / 0.277 / 0.279
```

**Worst pair 0.486 at the most permissive threshold, against a 0.799 calibration.**
Round 3's worst was 0.559. Disc IoU 0.181 (KESTREL) to 0.387 (ROOK). The harness's
own `all four on one footline` probe reads `spreadPx: 0`, `footY [576,576,576,576]`,
and `perSurvivor [1,1,1,1]` on the occlusion probe.

**This is the best character-silhouette separation ever measured in this project and
it holds at every threshold I tried.** Axis 4 = 8.

Round 3's defect 5 (KESTREL's forearm detached, coat held by 2 px struts) **does not
reproduce as a topological fault**: KESTREL resolves as **one** connected component
at TH 18, 30 and 45. At 6× the coat's side seams are still hairline highlight edges,
but the rig is continuous.

What still costs this shot:

- **ROOK's outline has no value edge on 59.0% of its length.** Median inside:outside
  luminance ratio along the upper 62% of the boundary: RANGER **1.99:1**, ANVIL
  **2.36:1**, KESTREL **1.76:1**, ROOK **1.26:1**; fraction below 1.5:1 = 42.3 / 16.4
  / 42.3 / **59.0** %. Round 3 measured ROOK at 1.48:1 and 51.4% and called it a
  regression from round 2's 1.83:1. It has regressed again. ROOK is a mid-value olive
  figure standing on a bright warm ground plane; it is held together by hue alone.
- **The roster comparison shot ships the live HUD**, the crosshair at (800,450) and a
  cyan pickup arrow at (718,430). Raised in round 2 and round 3. Untouched.

---

## 2. `11-bestiary` — 16 of 16 resolvable, and a threshold-dependent verdict

Sixteen hand-placed subjects, all individually resolvable.

| subject | area | w × h | fill | cplx | foot y | max IoU | partner | disc IoU |
|---|---|---|---|---|---|---|---|---|
| mite (gold crab) | 4373 | 88×111 | 0.45 | 2.06 | 750 | 0.551 | blocky biped | 0.433 |
| beetle (khaki) | 20529 | 213×157 | 0.61 | 1.80 | 772 | 0.656 | beetle (green) | 0.565 |
| **beetle (green, emissive)** | 16939 | 142×162 | 0.74 | **1.37** | 755 | **0.810** | WITHERING | **0.790** |
| quadruped A (tan) | 9634 | 151×122 | 0.52 | 1.85 | 540 | 0.591 | beetle (khaki) | 0.499 |
| quadruped B (tan) | 15664 | 140×163 | 0.69 | 1.79 | 551 | 0.785 | beetle (green) | 0.694 |
| spitling (red) | 9616 | 96×130 | 0.77 | 2.85 | 520 | 0.757 | WITHERING | 0.675 |
| **WARDED** (purple + cage) | 27195 | 170×216 | 0.74 | 2.29 | 426 | 0.776 | beetle (green) | 0.709 |
| blocky biped (brown) | 16641 | 108×184 | 0.84 | 2.49 | 398 | 0.732 | crystal (teal) | 0.595 |
| **WITHERING** (mint golem) | 39894 | 186×258 | 0.83 | 2.68 | 463 | **0.810** | beetle (green) | 0.710 |
| golem (orange) | 30209 | 152×240 | 0.83 | 2.77 | 408 | 0.727 | fleshy (green) | 0.611 |
| jellyfish (pink) | 27970 | 176×238 | 0.67 | 4.20 | 538 | 0.672 | WITHERING | 0.580 |
| elite (rust cloak + bits) | 13195 | 128×163 | 0.63 | 4.51 | 363 | 0.611 | golem (orange) | 0.540 |
| **crystal (teal)** | 15431 | 113×173 | 0.79 | 1.88 | 528 | **0.799** | fleshy (green) | 0.610 |
| **fleshy (green)** | 20529 | 132×204 | 0.76 | 2.74 | 526 | **0.799** | crystal (teal) | 0.593 |
| column (lavender) | 10866 | 56×228 | 0.85 | 2.28 | 333 | 0.520 | husk | 0.261 |
| husk (behind golem) | 1201 | 50×73 | 0.33 | 2.72 | 269 | 0.520 | column | 0.282 |

Threshold sweep, pairs at or above the 0.799 calibration, out of 120:

| TH | 18 | **30** | 45 | 60 |
|---|---|---|---|---|
| pairs ≥ 0.799 | **10** | **2** | 0 | 0 |
| pairs ≥ 0.787 (r3) | 14 | 2 | 0 | 0 |
| worst pair | 0.866 | 0.810 | 0.767 | 0.752 |

**Round 3 reported 0 of 120 at all four thresholds. I get 0 of 120 at TH 45 and 60,
and 2–10 at TH 18–30.** The difference is not instrument drift — my calibration is
within 0.012 of round 3's — it is that this is a completely different staging (88.4%
of pixels moved) shot at 2.5× the subject scale, and at low thresholds the masks grow
into each subject's bloom halo. **What collapses the silhouettes is the glow, not the
geometry.** The clearest evidence is the green emissive beetle: it is the same rig as
the khaki beetle, and its perimeter complexity is **1.37 against the khaki beetle's
1.80**, its disc IoU **0.790 against 0.565**. The emissive core rounds its own
outline into a blob.

**Four of sixteen subjects have essentially no value edge against the background.**
Michelson contrast of the median boundary-inside vs boundary-outside luminance, and
the fraction of the outline below a 1.3:1 ratio:

| subject | inside L | outside L | Michelson | outline < 1.3:1 |
|---|---|---|---|---|
| **WITHERING (mint golem)** | 102.1 | 102.5 | **0.002** | 62.6% |
| golem (orange) | 106.7 | 95.0 | 0.058 | 69.3% |
| elite (rust cloak) | 73.7 | 64.5 | 0.066 | 52.2% |
| **beetle (green, emissive)** | 119.3 | 99.2 | 0.092 | **81.9%** |
| *(best in the roster)* quadruped A | 112.1 | 46.9 | 0.411 | 33.9% |

RUBRIC axis 4's literal test is "shapes readable as pure black silhouettes." Those
four are not: threshold this frame and they merge into the terrain. They read by
hue only.

**The shot is still not a rank.** Its own `doc` string says "the whole spawn roster
in one rank, small to large." Ground-contact y spans **269 → 772 (503 px)** on a
camera where subjects are 73–348 px tall, and mask area is non-monotonic in x at
almost every step (khaki beetle 20,529 px at x392 sits beside quadruped A 9,634 px at
x450 and WARDED 27,195 px at x456). Round 2 defect 6, round 3's "below the cap"
item — untouched, and the depth spread is now 1.7× worse than round 3's 293 px.
On-screen size therefore carries no information about world scale.

Against that: the harness's own numbers moved a long way. `base-r4` → `FINAL`,
roster `px 7908 → 19472` (2.46×), `sepP50 0.47 → 0.71`, `legible 0.894 → 0.925`,
failing objects 6 → 1.

---

## 3. `05-boss` — round 3's defect 1 is closed, decisively

This is the one place where a round-3 top defect can be shown dead against its own
published numbers.

| measurement | round 3 (on `shots/`) | **FINAL** |
|---|---|---|
| dark-column fraction (L<45) x950–1000, y230–540 | **85.3%** | **1.8%** |
| dark-column fraction x700–750 | 33.0% | **0.0%** |
| boss visible silhouette | 175 × 286 px @ 0.58 fill | **328 × 348 px @ 0.65 fill** |
| connected components | head cut flat by canopy at y195 | **1**, head intact |
| harness `px` (`base-r4` → `FINAL`) | 2730 | **7094** (2.60×) |

The boss is photographed whole: two arms out, two legs, both feet on the ground, no
trunk crossing it. At 3× the head, torso, shoulder plates and feet are all separable.
**The framing half of round 3's defect 1 is fixed.**

The scale half is also met. Boss mask 348 px tall (feet y563), survivor mask 144 px
tall (feet y649) → **on-screen ratio 2.42×**. The survivor is nearer the camera, so
that understates the world ratio. Correcting with a pinhole ground-plane model,
`depth ∝ 1/(y − y_horizon)`, over a horizon range y_h ∈ [170, 230] read off the
frame's terrain line: depth ratio 1.22–1.26, giving a **world-height ratio of
2.9–3.1×**. Against the project's stated 3× target: **met**. Against RoR2's Stone
Titan at roughly 5×: still short, but that was never the declared target and I do not
score it as a defect.

What holds `05-boss` back is now photometric, not geometric: harness `contrast`
fell **0.732 → 0.502** and `legible` **0.987 → 0.782** across the same two manifests.
At 3× the cause is visible and measurable — a blown emissive core occupies the
Colossus's chest and pelvis, `L>200` covers 3.26% of the 3D frame, and any-channel
clipping runs **2.715%**. The boss's own charge glow is eating the middle third of
the body it is meant to sit on.

---

## 4. `04-combat` — the occlusion is fixed and the contrast was traded away for it

**Fixed, and I confirm it.** The harness's `survivor unoccluded by the final lens`
probe reads `{ vis: 1, boom: 7.1, need: 0.6 }`; round 3 measured it at `vis 0.583`
and correctly called the shot for cutting the player off at the waist. At 4× the
player is whole — head, torso, both legs, both boots, ground contact. Round 3's
defect 2, part (a): **closed.** Object census also improved: `20/24` visible with
three zeros and one 1-px object, against `18/24` and six zeros in `base-r4`.

**The defect that replaced it is worse for the shot's stated job.** Same probe,
same two manifests:

| `04-combat` survivor | `round5/base-r4` | `round6/base` | **FINAL** |
|---|---|---|---|
| `lum` / `bgLum` | 45.5 / 117.7 | 45.6 / 117.9 | **48.8 / 58.3** |
| `contrast` | 0.442 | 0.442 | **0.088** |
| `legible` | 0.915 | 0.915 | **0.783** |
| `sepP50` | 0.59 | 0.59 | **0.41** |
| horde `sepP50` | 0.61 | 0.61 | **0.45** |

The player used to be a dark figure against a bright ground; it is now a mid-value
figure against a mid-value ground. My own raw region census agrees: player bbox
p50 L **180.4**, the ground bloom disc it stands on p50 L **204.7** — Michelson
0.063. At 4× the cause is unambiguous: the player's legs and hips sit against a
**pink translucent dome of almost exactly the player's own value**, a sun flare sits
beside its head, and two dark foreground spikes cross its boots.

**The harness records `contrast: 0.088` and passes the subject**, because the
survivor check gates on `minPx`, `minSep` and `legibleOk` and does not gate contrast
at all. The one number that says "you cannot find the player" is written to disk and
ignored.

Second axis-8 problem: **this is not photographed as a horde.** Of 24 spawned
objects, only three exceed 100 px in either on-screen dimension:

```
red hulk          230 × 224 px   area 41070
pale crystal A    140 × 186 px   area 22122
pale crystal B     92 × 156 px   area 11509
salmon quadruped  108 × 108 px   area  8781
green small        74 ×  70 px   area  3836
teal small (L)     55 ×  58 px   area  2103
olive small (L)    58 ×  30 px   area   420
```

and **44.4% of the 3D frame is sky above y400 with nothing in it**. The action is
compressed into a y400–620 band while the shot's own `doc` promises "mid-fight with
a horde." Axis 4 = 4 here is not a form failure; it is a staging failure — you cannot
score silhouettes that are 30 px tall.

Frame-wide, `04-combat` runs **3.488% any-channel clipping** in the 3D area against
round 3's measured 1.92%, and carries **56,656 near-white px** (L>195, chroma<0.40),
of which the largest single blob is **22,902 px of blown ground** at
x192–657 y485–654 — no longer enemy body geometry, as it was in round 3, but a
white-out plate under the player.

---

## 5. `12-boss-phases` — the ring is finally framed, and it still says nothing

**Improved:** the telegraph's left arc sits at **x63** and its right arc at **x1538**,
both inside the frame. Round 3 measured it running off "the bottom and both sides."
Only the bottom arc still leaves the frame (865 pale pixels on row 899).

**Unchanged for the third round: the ring carries no fill and no hue.**

Six radial scans across the ring band:

| scan | peak L | thickness | peak RGB | chroma |
|---|---|---|---|---|
| bottom | 225.4 | 19 px | (208,230,228) | **0.094** |
| top | 168.2 | 8 px | (157,171,173) | **0.095** |
| left | 193.5 | 72 px | (180,197,196) | **0.089** |
| right | 189.1 | 68 px | (177,192,193) | **0.083** |

Round 3 measured chroma 0.04–0.08 on the same subject. It is still a colourless
white-cyan line.

Fill test, done properly — ground immediately **inside** the ring against ground
immediately **outside** it, sampled 16–56 px either side of the located ring band so
the band itself is excluded:

| arc | inside L p50 | outside L p50 | ratio |
|---|---|---|---|
| left, y600–660 | 44.9 | 44.7 | **1.00** |
| right, y600–660 | 44.5 | 42.0 | **1.06** |
| left, y700–740 | 38.4 | 47.9 | 0.80 |
| right, y700–740 | 35.3 | 108.6 | 0.33 |

No consistent direction; where it differs it tracks a bright terrain glint, not a
fill. **Nothing in this frame tells a player which side of the line is lethal.**
Round 2 defect 4 → round 3 defect 4 → open.

Worse, the marker and the threat share a colour. Boss body mean RGB **(123,135,135)**,
mean L 132.5, chroma 0.238; ring peak RGB (208,230,228), chroma 0.083–0.095. The
lethal-zone indicator is the same pale desaturated blue-grey as the thing that will
kill you, in a frame where `L>200` already covers **7.85%** of the 3D area — the
highest in this domain.

Scale is fine: Iron Vizier mask 178×296 (feet y593), survivor 43×46 (feet y461);
depth-corrected over a horizon range y_h ∈ [250, 330] gives **3.2–4.0×**, above the
3× target.

---

## 6. `03-thirdperson` — unchanged for three capture generations

96.3% of pixels are within 8 levels of round 3's own artifact. Every measurement I
took reproduces round 2's and round 3's to within instrument noise:

| measurement | round 2 | round 3 | **round 4 (FINAL)** | **round 4 on `base-r4`** |
|---|---|---|---|---|
| frame DR p05 / p50 / p95, rows 0–760, every 2nd px | 31 / 35 / 64 | 31 / 36 / 63 | **31 / 35 / 62** | **31 / 36 / 63** |

**90% of the frame lives in a 31-level luminance band.** All-channel clipping
0.0004%. The survivor is 86 × 231 px, **0.60% of the frame**, with a body p50 of
**125.5 against the frame's own p95 of 58.8** — it is still the only thing above the
frame's 95th percentile, and it is still carrying the picture alone. Depth-band
medians run **34, 33, 33, 33, 34, 39, 45, 46** from background to foreground: a
13-level range across the entire depth stack, i.e. no aerial perspective at all.

The character itself is good — disc IoU **0.203**, one connected component, helm,
rifle, coat and boots all separable at 5×. Axis 4 = 7. Everything else in the frame
is dead, and has been for three rounds.

The one genuinely dead surface I could isolate anywhere in this domain is here: the
canyon wall at x150–450, y200–500 — **90,000 px, luminance std 2.1, N80 = 4, and its
top four rounded luma values cover 89.7% of its area.** That is a flat colour
occupying most of the shot whose declared job is "judges character read and camera."

---

## 7. Lighting: no figure in this domain is grounded

Contact band, median luminance in the 10 px strip immediately below each figure's
foot line (width 40 px), against the ground 120–200 px to either side at the same y:

| shot | figure | under | beside | under/beside |
|---|---|---|---|---|
| 09-survivors | RANGER | 39.1 | 41.5 | 0.94 |
| 09-survivors | ANVIL | 96.6 | 41.8 | **2.31** |
| 09-survivors | KESTREL | 42.2 | 43.3 | 0.97 |
| 09-survivors | ROOK | 115.0 | 110.9 | **1.04** |
| 05-boss | Basalt Colossus | 49.5 | 48.7 | **1.02** |
| 05-boss | survivor | 41.4 | 43.7 | 0.95 |
| 11-bestiary | teal crystal | 42.7 | 43.2 | 0.99 |
| 11-bestiary | green fleshy | 34.5 | 43.3 | 0.80 |
| 11-bestiary | quadruped A | 49.8 | 53.4 | 0.93 |
| 03-thirdperson | survivor | 40.2 | 50.0 | 0.80 |
| 12-boss-phases | Iron Vizier | 109.5 | 59.3 | **1.85** |

**Deepest contact darkening anywhere in the domain: 0.80×. Three figures — including
a 348 px boss — stand on ground that is brighter under them than beside them.** A
real contact shadow or ambient occlusion term sits at 0.4–0.6×.

Widened to a horizontal profile in 40 px bins out to ±320 px from each foot centre,
no figure produces a dip: the Basalt Colossus reads 47–52 across its whole ±200 px
neighbourhood and 45–38 out at ±240–280; the `03` survivor reads 45 at offset 0 and
43–53 across ±320.

Scope note, stated so this is not over-read: biome 1's sun is at **15° elevation**
(`Materials.js:1039`), which at `09-survivors`' scale (≈139 px/m) throws the *far end*
of a 1.8 m figure's cast shadow roughly 930 px from its foot — outside my probe and
possibly outside the frame. What I have measured is **grounding**: the contact
occlusion and near shadow that make a figure sit on a surface. There is none.

This is not a missing feature. `RenderPipeline.js:129-130` sets
`shadowMap.enabled = true` with `VSMShadowMap`; `Environment.js:428` sets
`key.castShadow = true`; `TerrainGen.js:598` sets `receiveShadow = true`;
`CharacterMesh.js` sets `castShadow` on 25 separate meshes and
`EnemyMeshes.js:4005` sets it on every rig body. The machinery is all there and
produces a ≤20% darkening. Candidate causes, none of which I can separate from
pixels alone: `Environment.js:439 normalBias = 0.10` walking the shadow off its own
base (the comment at :432-436 documents exactly this failure mode at 0.25); the
combined fill floor — `environmentIntensity 0.55`, `HemisphereLight 0.50`, a
`1.45` rim — leaving no darkness for a shadow to carve into; or VSM light-bleeding
at `radius 1.6 / blurSamples 8`.

---

## 8. Findings I withdraw

Withdrawing is the loop working. Four of my own measurements did not survive:

1. **"RANGER's head detaches again in `03-thirdperson`."** With my hand-placed box
   (636,400,724,652) the mask split into 8484 + 1106 px components at TH 24 and
   7181 + 989 at TH 34, the smaller being the helmet. With a box derived from the
   subject itself, **both `FINAL` and `reviews/round5/base-r4/03-thirdperson.png`
   return one component at TH 24 and TH 34.** The split is an artefact of where I put
   the box, present identically in round 3's own artifact. **Withdrawn. Round 3's
   "fixed" verdict stands.**

2. **My axis-5 "luma level richness" metric (`material2.py`).** It reports N80 = 55–124
   for character and enemy bodies against 36–53 for terrain, which would say bodies are
   *richer* than terrain. Its own calibration kills it: a pure smooth ramp scores
   **N80 = 72**. The metric measures tonal range, not surface detail, and cannot tell
   a gradient from a texture. **Withdrawn.** What it does establish is negative and
   worth keeping: RUBRIC's "uniform matte plastic on every surface" is *not* what
   these frames contain — bodies carry 38–62 L of standard deviation.

3. **My chromatic-aberration instrument.** Locating the R and B gradient centroids in
   a 120 px margin band returned **−35.59 px on `11-bestiary`**, which is physically
   impossible; the two channels lock onto different edges when the content differs.
   **Withdrawn.** I cannot test the round-6 VFX agent's 4 px → 1 px claim and do not
   score axis 9 on aberration.

4. **My `04-combat` survivor outline-contrast figure (1.05:1, 89.9% below 1.5:1).**
   The mask over-grew to fill 0.687 of its box because it captured the bloom around
   the figure — the identical failure that made round 3 withdraw the same measurement.
   **Withdrawn.** The harness's own hide-and-diff (`contrast 0.088`, `sepP50 0.41`,
   `legible 0.783`) is the honest figure for that subject and is what §4 uses.

---

## 9. Strengths — measured, not credited on assertion

1. **`05-boss` framing and scale. Round 3's #1 defect is dead.** 85.3% → 1.8% on its
   own published column measurement; boss silhouette 175×286 @ 0.58 → 328×348 @ 0.65;
   depth-corrected 2.9–3.1× against a 3× target.
2. **`04-combat` occlusion. Round 3's #2(a) is dead.** Harness `vis` 0.583 → 1.0,
   confirmed at 4×: whole figure, both boots, ground contact.
3. **`09-survivors` silhouette separation is the best in the project's history.**
   Worst pair 0.486 at the most permissive of four thresholds against a 0.799
   calibration; `spreadPx: 0`; `perSurvivor [1,1,1,1]`.
4. **`11-bestiary` restaging.** Roster `px` 7908 → 19472, `sepP50` 0.47 → 0.71,
   `legible` 0.894 → 0.925, failing objects 6 → 1, 16 of 16 individually resolvable
   at four thresholds.
5. **`12-boss-phases` telegraph containment.** Left arc x63, right arc x1538 — both
   inside the frame, where round 3 had it off both sides.
6. **`05-boss` and `12-boss-phases` now have real depth.** Background-to-foreground
   median luminance runs 126→43 and 180→39 respectively — genuine aerial perspective,
   which no shot in this domain had in round 3.
7. **KESTREL's rig is continuous.** Round 3's defect 5 does not reproduce as a
   component split at any threshold.
8. **The evidence chain is auditable.** `clockPinned: true` on all three captures I
   used, `frameTimeouts: 0`, and every number in this document names the file it came
   from. Two of my four withdrawals were only possible *because* round 3's artifact
   was still on disk.

---

# THE HONEST PER-AXIS LEDGER

Round 4 of 4. This is the part that is meant to outlive the review. For each axis:
does it clear 7, and if not, is the residual a **code** problem someone could still
fix or an **asset** problem no shader work will close.

| # | Axis | Domain mean | Clears 7? | Residual is | The measurement that decides it |
|---|---|---|---|---|---|
| 1 | Lighting & shadow | 4.7 | **No** | **Code (fill tuning), plus asset** | Contact darkening 0.80–1.04× beside-ground; three figures brighter under than beside. All shadow machinery already enabled in source. |
| 2 | Composition & depth | 4.8 | **No** | **Code (harness cameras)** | `05` 126→43 and `12` 180→39 prove the renderer *can* stack depth; `03` 34→46 and `09` 56→40 prove two cameras still don't. |
| 3 | Colour & grade | 5.7 | **No** | **Code (palette discipline)** | 4–6 hue families ≥8% of coloured area per shot; `04` at 6 is the worst. |
| 4 | **Silhouette & form** | **6.5** | **On 4 of 6 shots** | **Code (staging + one rig)** | Worst survivor pair 0.486, worst bestiary pair 0.810, both against 0.799. The two failures are `04` (3 of 24 enemies over 100 px) and `12` (blocky boss), not form. |
| 5 | **Material believability** | **3.8** | **No — and never will by tuning** | **ASSET** | `Environment.js:361-364` bakes the PMREM probe from a sky sphere and nothing else. |
| 6 | VFX quality | 5.0 | **No** | **Code (~20 lines)** | Telegraph fill ratio 1.00 / 1.06 / 0.80 / 0.33 — no fill, third round. Chroma 0.083–0.095 — no hue, third round. |
| 7 | UI/HUD craft | 6.8 | **Nearly — 5 of 6 shots** | **Code (one line)** | Only `09` drops below, and only for shipping the live HUD + crosshair + pickup arrow over a roster comparison. |
| 8 | Readability under load | 5.5 | **No** | **Code (gate + hue)** | `04` survivor `contrast 0.088` written to the manifest and not gated; 4 of 16 bestiary subjects at Michelson ≤0.092. |
| 9 | Post-processing | 4.7 | **No** | **Code (mid-field roughness)** | `09` hillside band: **893** bright components, HF std **18.39**, p99 **95.96** — worse than round 3's 767 / 16.7 / 88. `04` any-channel clipping 1.92% → **3.488%**. |
| 10 | Cohesion | 6.5 | **No, but close** | **Code (palette + bloom)** | Nothing reads as a different era; what breaks it is `04`'s pink dome and the roster's rainbow, not mixed assets. |

### The three things to stop grinding on

**1. Axis 5. Stop tuning `world/Materials.js`.** This is the only axis in the ledger
whose ceiling is set by something that is not in anyone's power to shader-fix, and
the reason is verifiable in source at the reviewed commit rather than inferred from
pixels. `Environment.js:359-371` constructs `_probeScene` containing exactly one
mesh — a sphere carrying the sky material — and `_bakeEnvironment()` at :389-396
renders `scene.environment` from that probe alone. The environment map is therefore
an analytic sky gradient plus a sun disc, with no structure anywhere in it. A
roughness ladder is a ladder of *blur applied to reflections*; blurring a smooth
gradient produces the same gradient. **Roughness 0.12 and roughness 0.90 are the same
pixel.** `ART-ASSETS.md` reached this conclusion in round 5 and it is still true at
`1541fc9`. Six rounds of flatness is not six rounds of insufficient effort; it is one
missing asset. One HDRI in `scene.environment` unblocks every surface in the game
simultaneously, and until it lands, **every hour spent on the roughness ladder is
wasted and the axis-5 score is not information about anyone's work.**

I will add one honest caveat the project should carry: my own attempts to measure
"material detail" in pixels failed twice (§8, items 2 and 3). I cannot demonstrate
from these six frames that characters are *flat*; the standard deviation on their
bodies is 38–62 L. What I can demonstrate is the precondition, in source. Treat axis
5 as **blocked**, not as **failed**, and stop scoring it as though it were a
performance measure.

**2. The Stone Titan / Basalt Colossus framing.** Closed. Round 3 ranked it #1 and
it now measures 1.8% where it measured 85.3%. It should not appear on another defect
list.

**3. `04-combat`'s occlusion probe.** Closed. `vis 0.583 → 1.0`. What replaced it is
a different defect with a different fix.

### The five things that are still worth doing, cheapest first

Each of these is code, each has a measurement attached, and none of them needs an art
purchase.

1. **`src/world/Environment.js:428-440` + the fill floor at :370, :446 — figures do
   not sit on the ground.** Measured: contact darkening 0.80–1.04× the adjacent
   ground on eleven figures across five shots; the Basalt Colossus at 1.02× and the
   Iron Vizier at 1.85×. Every mechanism is already enabled — this is a
   `normalBias`/fill-level trade, not a feature. **Fix:** drop `normalBias` toward
   0.03 and re-measure the peter-panning the 0.10 comment was defending against; if
   the trade is real, add an explicit small contact-shadow decal under every character
   and enemy root (the blob pool at `EnemyMeshes.js:476-483` already exists and is
   drawing nothing measurable). **Assert it:** require the 10 px band under each
   subject's foot line to read ≤0.70× the ground 120–200 px to its side, in
   `09-survivors` and `05-boss`. This is the single cheapest point on the board — it
   moves axis 1 and axis 4 together, because a grounded figure reads as a solid.

2. **`src/entities/EnemyMeshes.js:3676` + `src/systems/Director.js:1023-1034` — the
   boss telegraph still says only "there is a circle."** Third round, unchanged in
   every measurable respect: chroma 0.083–0.095, inside/outside ground ratio 1.00,
   1.06, 0.80, 0.33. **Fix, restated from round 2 and round 3 because it has never
   been attempted:** hold the radius at the true blast from frame one and animate a
   low-alpha *fill* 0→1 across the wind-up, in the attack's declared hue at roughly
   0.6× the frame's highlight luminance — the disc is the "where," the fill is the
   "when." It must not be the boss's own pale blue-grey: boss body mean RGB
   (123,135,135) against a ring at (208,230,228) is a 0.09-chroma difference between
   the threat and its warning. **Assert it:** require inside/outside ground luminance
   ratio ≥1.25 at three arcs, and ring-vs-boss hue separation ≥30°.

3. **`src/core/Harness.js` — the manifest already knows `04-combat` is unreadable and
   passes it.** `checks[1]` records `contrast: 0.088` (against `base-r4`'s 0.442) and
   `legible: 0.783` (0.915), and `ok: true`, because the survivor check gates only on
   `minPx`, `minSep` and `legibleOk`. **Fix:** gate `contrast` — fail below ~0.25 —
   and gate `legible` below ~0.85. Both numbers are already computed and written; only
   the comparison is missing. This is the fourth time in this project's review history
   that an aggregate has hidden an absence, and it is the cheapest of the four to
   close.

4. **Mid-field terrain specular aliasing — the stages fix does not reach these
   frames.** `09-survivors` hillside band x560–1350 y120–470: **11.74% above L140 in
   893 connected components** of median 2 px (803 under 30 px), high-frequency
   residual against a 7 px median at **std 18.39 / p99 95.96**. Round 3 measured the
   same band at 767 components / std 16.7 / p99 88 — **component count and
   high-frequency energy are both up.** `11-bestiary` 854 components, `12-boss-phases`
   521, `05-boss` 533. At 4× (`09-survivors` crop 980,150–1300,370) these are bloomed
   specular streaks covering an entire hillside directly behind KESTREL. The round-6
   stages agent stated plainly that its Toksvig-style fix was scoped to the far ROI
   and that near-field raking contrast was outside it; this measurement is the
   confirmation. **Fix:** extend the same normal-variance-to-roughness conversion to
   the mid-distance band, or drop terrain specular intensity toward zero beyond ~20 m.
   **Assert it:** count connected components above L140 in a ground band and fail above
   ~150.

5. **`src/core/Harness.js` `combat()` and `bestiary()` — the two shots that fail their
   own gates fail on staging, and staging is what caps axis 4.** In `04-combat`, three
   of 24 objects exceed 100 px on screen and 44.4% of the 3D frame is empty sky above
   y400; in `11-bestiary`, ground-contact y spans 269–772 against a `doc` string that
   promises "one rank, small to large," and mask area is non-monotonic in x at almost
   every step. Axis 4 scores 4 and 7 on these two shots and 7–8 on the other four:
   **the difference is entirely where the camera and the spawns were put.** **Fix:**
   for `combat()`, lower and close the lens until the median enemy exceeds ~80 px of
   on-screen height, and assert `median(perPx) ≥ 4 × minPerPx` rather than only a
   floor; for `bestiary()`, place the roster on one ground line sorted by world height
   and assert both `max(footY) − min(footY) ≤ 60 px` and monotonic area in x.

### What a fifth round would and would not have bought

It would have bought items 1–5 above, all of which are code, all of which have
assertions attached, and three of which are one-file changes. It would **not** have
bought axis 5, and it would not have bought the parts of axis 1 and axis 9 that
depend on there being something in the environment map to reflect. **If this project
runs one more pass on this domain, run it on the ledger's five code items and leave
axis 5 alone until an HDRI lands.** Scoring axis 5 again before then measures the
absence of an asset, not the quality of anyone's work, and it has now consumed six
rounds of critic attention to say the same thing six times.

---

## Commands / method

- Python 3.14.4, numpy 2.5.1, Pillow 12.3.0, scipy 1.18.0. All measurements on the
  shipped PNGs at native 1600×900, mode `RGB`. Working files in the session
  scratchpad, not the repo. **No project file was modified; no capture was run.**
- Luminance `0.2126R + 0.7152G + 0.0722B` on 8-bit sRGB, reported 0–255.
  Chroma `(max − min)/max`, 0–1.
- Scripts: `r4lib.py` (ring background model, uniform-scale normalisation,
  translation-searched IoU, calibration shapes), `s11.py` (bestiary 16 boxes,
  segmentation, 120-pair IoU matrix, threshold sweep), `s09.py` (survivor masks,
  pairwise IoU, outline contrast, threshold sweep), `s05.py` (Colossus/survivor
  extents, trunk column profile, horizon probe), `s12.py` / `s12b.py` (telegraph
  radial scans, fill test across the ring boundary, frame containment, boss/ring
  colour separation, scale), `s04.py` (region census, near-white census, clipping),
  `shadow.py` / `shadow2.py` (contact band and horizontal ground profiles),
  `speckle.py` (residual models, speckle component census), `grade.py` (hue census,
  depth-band ladder, bloom chroma), `material2.py` / `material3.py` (axis-5
  instruments, both withdrawn — see §8), `post.py` (aberration, withdrawn; enemy
  on-screen sizes, kept), `detect.py`, `g_stats.py`.
- Calibration run before any verdict: disc vs square **0.799**, disc vs 1:4 bar
  0.305, square vs 1:4 bar 0.245, disc-vs-itself-at-another-scale 0.988.
- Threshold sensitivity: every silhouette verdict recomputed at TH 18 / 30 / 45 / 60.
  Where the verdict flips, both results are printed (§2) rather than one being chosen.
- Visual confirmation at 2–6× nearest-neighbour on: the bestiary middle cluster, right
  group, bottom row and lavender column; KESTREL and ROOK in `09`; the `09` hillside
  speckle field; the Basalt Colossus in `05`; the `04` survivor; the `03` survivor.
- On-disk before-states diffed against `FINAL`: `reviews/round5/base-r4/` and
  `reviews/round6/base/`, both `clockPinned: true`.
- Read-only source cross-checks at `1541fc9` (`git log` confirms HEAD):
  `src/world/Environment.js:52-62` (shadow tiers), `:191-226` (`applyQuality`),
  `:340-371` (sky mesh, PMREM probe scene, `environmentIntensity`), `:375-396`
  (`_bakeEnvironment`), `:422-455` (key light, `normalBias`, hemisphere, rim);
  `src/core/RenderPipeline.js:129-130` (shadow map enabled, VSM);
  `src/world/TerrainGen.js:598`, `src/entities/CharacterMesh.js` (25 `castShadow`
  sites), `src/entities/EnemyMeshes.js:476-483` (blob-shadow pool) and `:4003-4009`
  (`configureShadows`); `src/world/Materials.js:1039` (biome-1 sun at 15°).
  `DET_KILL` is confirmed absent from `src/world/Materials.js` at this commit.
