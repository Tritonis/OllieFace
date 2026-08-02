# PETRICHOR — Round 4 (FINAL) critique: UI/HUD craft, VFX, readability under load, post

Domain: rubric axes **6** (VFX), **7** (UI/HUD), **8** (readability under load), **9** (post).
All ten axes scored from the pixels. Round **4 of a maximum 4 — there is no round 5.**

Judged set: `reviews/round6/FINAL/*.png` + `reviews/round6/FINAL/manifest.json` only.
Seed 1337, 1600×900, `clockPinned: true`, frozen capture of `1541fc9`
(`2026-08-01 20:35:09 -0500`, "Fix 5 of 6 confirmed defects from the f9b47c4 audit").
`shots/` was decoded **once**, as a negative control for provenance (§0), and scored nowhere.
`tools/capture.mjs` was not executed. No project file was modified. This report is the only
file written.

---

## 0. Manifest first, and instrument calibration

`reviews/round6/FINAL/manifest.json`: `seed 1337`, `ready: true`, `partial: false`,
`clockPinned: true`, `determinism.frameDt 0.0166667`, `frameTimeouts: 0`, `subjectsOk: false`,
**4 errors — exactly the four documented failures** (`04-combat` horde, `06-loaded-hud`
monsters under load, `08-explosion` the blast, `11-bestiary` spawn roster). No crash, no
fifth failure, no new error class. **No defect #1 from the manifest.**

Of my eight shots, `10-inventory` and `16-run-summary` now report `subject.ok: true`, and
`10-inventory`'s strip assertion has been repaired to a self-consistent form
(`{"shown":83,"held":83,"floor":60,"catalogue":92}` — it no longer compares against an
unreachable catalogue count). `08-explosion`'s "damage numbers" subject passes.

**Instrument.** Pillow 12.3.0 / numpy 2.5.1 / scipy 1.18.0, decoding each PNG to RGB,
Rec.709 luminance throughout. Calibrated against known inputs **before** it was used to
score anything. Every calibration target below reproduced **to the digit**:

| target | published by | file | published | my instrument |
|---|---|---|---|---|
| blast core RGB / R-clip / disc L / %>220 / annulus step | round-3 critic §4.1; `FIX-vfx.md` §0 | `reviews/round5/base-r4/08-explosion.png` @ (568,306) | 255.0, 253.6, 237.5 / 100 % / 229.2 / 72.66 % / 6.6 L @ r 84 | **255.0, 253.6, 237.5 / 100.0 % / 229.2 / 72.66 % / 6.6 L @ r 84** |
| per-ray gradient median / p75 | `FIX-vfx.md` §1 (PRE) | same | 21.5 / 32.9 L | **21.5 / 32.9 L** |
| viewport L / %>220 / RGB | round-3 critic §2 | `reviews/round5/base-r4/10-inventory.png` x 520–1180, y 110–780 | 132.3 / 7.26 % / 149,130,106 | **132.33 / 7.26 % / 149.5,129.9,105.9** |
| control viewport | round-3 critic §2 | `reviews/round5/base-r4/06-loaded-hud.png` same box | 63.3 / 0.51 % | **63.33 / 0.51 %** |
| whole-frame / right-third L | `AUDIT-f9b47c4`, reproduced in `FIX-audit.md` §0 | `reviews/round6/base/08-explosion.png` | 93.84 / 118.71 | **93.84 / 118.71** |
| nova quad edge steps at y 700 / y 780 | round-3 critic §4.3 | `reviews/round5/base-r4/10-inventory.png` | +54.3 L / −28.6 L | **+54.3 L at x 798 / −28.6 L at x 738** |

Six independent calibration points across three authors. The instrument is trusted from here.

**Provenance note, recorded because a claim died on this last round.** The round-3 critic's
`10-inventory` numbers do **not** reproduce on today's `shots/10-inventory.png` (108.88 /
3.18 %) because `shots/` was re-captured at 17:54 and is stale, exactly as briefed. They
reproduce exactly on `reviews/round5/base-r4/`, which `FIX-vfx.md` §0 names as "the frames the
round-3 critic measured". That directory is used as PRE throughout. `reviews/round6/audfix/`
and `reviews/round6/FINAL/` differ by ≤ 1.13 mean abs on my shots (0 on `16-run-summary`), so
`FINAL` is the `audfix` tree.

---

## 1. Axis scores — round 1 → 2 → 3 → **4**

| Axis | 01-title | 06-hud | 08-explosion | 10-inventory | 14-survivor | 15-logbook | 16-summary | 17-artifacts |
|---|---|---|---|---|---|---|---|---|
| 1 Lighting | 4→4→4→**4** | 5→5→5→**5** | 5→5→5→**5** | 5→4→4→**5** | — → — → — →**4** | 4→4→4→**4** | 4→4→4→**4** | 4→4→4→**4** |
| 2 Composition | 5→5→5→**5** | 4→4→4→**5** | 4→4→5→**5** | 4→4→4→**4** | — → — → — →**5** | 3→4→4→**4** | 3→4→4→**4** | 4→5→5→**5** |
| 3 Colour & grade | 7→7→7→**7** | 7→7→7→**7** | 6→6→5→**6** | 5→4→4→**6** | — → — → — →**6** | 5→5→5→**5** | 5→6→6→**6** | 5→6→6→**6** |
| 4 Silhouette | 6→6→6→**6** | 6→6→6→**6** | 6→6→6→**6** | 5→4→4→**4** | — → — → — →**5** | 6→6→6→**6** | 6→6→6→**5** | 4→7→7→**7** |
| 5 Material | 4→4→4→**4** | 4→4→4→**4** | 4→4→4→**4** | 4→4→4→**4** | — → — → — →**4** | 4→4→4→**4** | 4→4→4→**4** | 4→4→4→**4** |
| **6 VFX** | 4→4→4→**4** | 4→5→5→**5** | 3→6→5→**4** | 4→4→4→**5** | — → — → — →**4** | 4→4→4→**4** | 4→4→4→**4** | 4→4→4→**4** |
| **7 UI/HUD** | 8→8→8→**8** | 7→7→7→**7** | 7→7→7→**7** | 6→5→5→**5** | — → — → — →**7** | 5→5→5→**5** | 5→6→6→**5** | 4→7→7→**7** |
| **8 Readability** | 8→8→8→**8** | 6→6→6→**6** | 6→6→6→**6** | 4→4→4→**4** | — → — → — →**8** | 7→7→7→**7** | 7→7→7→**7** | 7→8→8→**8** |
| **9 Post** | 6→6→6→**6** | 7→7→7→**7** | 5→6→4→**6** | 4→4→4→**6** | — → — → — →**6** | 6→6→6→**6** | 6→6→6→**6** | 6→6→6→**6** |
| **10 Cohesion** | 7→7→7→**7** | 7→7→7→**7** | 6→7→6→**6** | 6→5→5→**5** | — → — → — →**7** | 5→5→5→**5** | 4→6→6→**5** | 4→7→7→**7** |
| **Mean** | 5.9→5.9→5.9→**5.9** | 5.7→5.8→5.8→**5.9** | 5.2→5.7→5.3→**5.5** | 4.7→4.2→4.2→**4.8** | —→—→—→**5.6** | 4.9→5.0→5.0→**5.0** | 4.8→5.3→5.3→**5.0** | 4.6→5.8→5.8→**5.8** |

```
AXIS SCORES 01-title:        1:4 2:5 3:7 4:6 5:4 6:4 7:8 8:8 9:6 10:7
AXIS SCORES 06-loaded-hud:   1:5 2:5 3:7 4:6 5:4 6:5 7:7 8:6 9:7 10:7
AXIS SCORES 08-explosion:    1:5 2:5 3:6 4:6 5:4 6:4 7:7 8:6 9:6 10:6
AXIS SCORES 10-inventory:    1:5 2:4 3:6 4:4 5:4 6:5 7:5 8:4 9:6 10:5
AXIS SCORES 14-survivor-select: 1:4 2:5 3:6 4:5 5:4 6:4 7:7 8:8 9:6 10:7
AXIS SCORES 15-logbook:      1:4 2:4 3:5 4:6 5:4 6:4 7:5 8:7 9:6 10:5
AXIS SCORES 16-run-summary:  1:4 2:4 3:6 4:5 5:4 6:4 7:5 8:7 9:6 10:5
AXIS SCORES 17-artifacts:    1:4 2:5 3:6 4:7 5:4 6:4 7:7 8:8 9:6 10:7
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass needs 7+ on every axis with none below 6. Axis **5 is 4 on every shot
in the set, in all four rounds**. Axis **1 tops out at 5**. Axis **6 tops out at 5** and its
headline shot went *down*. Axis **2 tops out at 5**.

Net movement across the six shots I have scored before: `06` +0.1, `08` +0.2, **`10` +0.6**,
`15` 0.0, `16` −0.3, `17` 0.0, `01` 0.0. **`10-inventory` moved for the first time in four
rounds**, and §2 is the whole argument for why, and for why it did not move further.

---

## 2. `10-inventory` — the diagnosis

**Finding: the round-1→3 diagnosis was right about the cause and is now largely resolved; the
score did not move because it was never the whole cause. `10-inventory` was pinned at 4.2 by
two independent problems in two different layers, and only one of them was ever worked on.**

`10-inventory` and `06-loaded-hud` are the same stage, the same camera height, the same
survivor and the same HUD. `06` has scored 5.7–5.9 for four rounds; `10` scored 4.2 for
three. That 1.6-point gap is *entirely* attributable to what `10` adds, and there are
exactly two additions: **the equipment nova**, and **the damage-numeral storm**. Everything
below names the file it was decoded from.

### 2a. The nova — the layer that was worked on. Largely fixed.

Viewport `x 520–1180, y 110–780`, the round-3 critic's own box:

| capture | file | mean L | %>L220 | %>L250 | mean RGB | control `06` |
|---|---|---|---|---|---|---|
| PRE | `reviews/round5/base-r4/10-inventory.png` | **132.33** | 7.26 | 1.09 | 149,130,106 | **63.33** |
| `fba0a91` | `reviews/round6/base/10-inventory.png` | 108.88 | 3.18 | 0.71 | 126,105,93 | 66.30 |
| VFX arm | `reviews/round6/vfx/10-inventory.png` | 108.78 | 3.42 | 0.70 | 125,106,94 | 66.39 |
| **SHIPPED** | **`reviews/round6/FINAL/10-inventory.png`** | **103.13** | **1.59** | **0.30** | **129,97,85** | **70.88** |

Excess over the control fell from **+69.0 L to +32.3 L (−53 %)**. The ratio fell from
**2.09× to 1.455×**. `%>L220` fell **7.26 → 1.59** while the control moved 0.51 → 0.27. The
milky yellow-green wash over the whole viewport is gone: the water is purple again
(x 900–1150 / y 620–800 reads 61,39,59 against `06`'s 40,32,64) and the sky is violet.

Round-3 defect 3's second half — "the nova's screen-filling additive quads are showing their
own straight boundaries" — is also substantially fixed, at the two coordinates it named:

| measurement (x 600–1000) | PRE `base-r4/10-inventory.png` | **FINAL** |
|---|---|---|
| max 1-px step at y = 700 | **+54.3 L** at x 798 | **−15.2 L** |
| max 1-px step at y = 780 | **−28.6 L** at x 738 | **−11.0 L** |
| 1-px steps > 40 L, water band x 510–1200 / y 620–810 | **402** | **127** (−68 %) |

And the aberration is gone — see §3, where the fix turns out to be *larger* than its own
report claimed.

**So the entire VFX/post half of the round-2/3 case against this shot is closed.** Axes 1, 3,
6 and 9 move up on this shot for the first time: **+1, +2, +1, +2.**

### 2b. The damage-numeral layer — never worked on. The residual cause.

Round-3 ranked this defect **fifth**; the round-6 fix agents took defects 1 and 2. Nothing in
it was implemented, and it is present verbatim in the shipped frame. Tight gold-ink mask
(R 228–252, G 188–226, B 72–128 — the numeral gold peaks at 245,211,99; terrain gold carries
B > 150 and is excluded), HUD rects removed, connected components grouped into runs:

| | `base-r4/10-inventory.png` | **`FINAL/10-inventory.png`** | `FINAL/06-loaded-hud.png` |
|---|---|---|---|
| concurrent runs | 7 | **7** | 0 |
| glyph components outside the HUD | 47 | **62** | **8** |
| numeral footprint (ink + 3 px outline) | 16,617 px | **18,483 px (1.28 % of frame)** | **1,695 px (0.12 %)** |

The seven runs in the shipped frame, with their read values:
`24012!` (x 345–450, y 302) · `8004!` (x 510–608, y 419) · `25634!` (x 735–840, y 396) ·
`1048!` (x 1008–1089, y 420) · `1048!` (x 1103–1196, y 420) · `24012!` (x 1192–1297, y 254) ·
`24012!` (x 1356–1460, y 437).

Four defects, all of them the ones round 3 named:

1. **Runs collide.** The two `1048!` runs at y 419–437 abut with a 14 px gap and read as the
   single ten-character string **`1048!1048!`**. A third, fading run overlaps them to the
   right at x ≈ 1230–1320 and is unreadable. Crop from `FINAL/10-inventory.png` at
   (980, 400) 360×70, 3×.
2. **A run is clipped by the HUD.** A fading `24012!` at y ≈ 228–245 renders **behind** the
   green and red tier rows; what ships is a band of digit-tops peeking out between the green
   row and the red rule. Crop at (240, 220) 320×120, 3×. Round 3 reported exactly this; the
   z-order is still under the strip and the numeral layer is still not clipped out of the
   strip's rect.
3. **No merge rule.** Four distinct values across seven runs — `24012` is printed **three
   times**, `1048` twice. The same hit is spawning a run per instance.
4. **Scale relative to the subject.** The numeral layer covers **18,483 px**. The manifest's
   own instrument measures every monster in the frame at **2,401 px** across 8 objects
   (`perPx [44,435,147,454,126,387,216,592]`), and the paired shot's survivor at **834 px**.
   **The damage numerals occupy 7.7× the screen area of every living creature in the frame
   combined.** That is the rubric's axis-8 four-marker stated as a ratio.

### 2c. The strip — the second thing `06` also has, but at a different cost here

The item strip's tier rules span `x 29–488` at `y 69 / 156 / 242 / 329 / 378 / 426`; the block
runs `y 64–470`. That is **186,354 px = 12.94 % of the frame**, opaque, in the upper-left
quadrant, over the 3D. `06` carries the same block and scores 5.9, so the strip alone is not
the problem — but in `10` it is what the clipped run at (2) hides behind, and it is why the
frame has no focal point: 12.9 % HUD block upper-left, seven gold runs scattered across the
remaining space, and the actual subject (the nova) bottom-centre behind the player.

### 2d. What I ruled out

- **The 165.4 baseline.** Confirmed non-reproducible, as round 3 found. No further work.
- **The nova alpha floor as the cause.** `FIX-audit.md` §2's arms reproduce on my instrument
  in shape (its 0.18-vs-0.05 arm difference is +3.7 L on a shot whose *total* excess is
  32.3 L), and its own honest statement that the layer-split effect is "under 0.2 L on the
  shipped shots" holds. **The constant was never the cause and tuning it further will not
  move this shot.**
- **RNG draw counts and `hud.css`.** Cleared by `FIX-audit`; I did not re-open them, and
  nothing in the pixels contradicts the clearance.
- **The strip assertion.** Repaired; the strip renders 83 of 83 held items in both `06` and
  `10`, so the shot is photographing what it claims to.

### 2e. The answer

**`10-inventory` was held at 4.2 by a HUD-layer defect that three rounds of VFX and post work
could not touch.** Round 2 and round 3 correctly photographed the nova wash and correctly
ranked it first; it has now been reduced by 53 %, and the shot moved 4.2 → 4.8 as a direct
result. It did not move further because axes **2, 4, 7, 8 and 10 — every axis that did not
move — are scored on the damage-numeral layer, the tier polarity and the strip density,
none of which is shader work.**

This is a **code** problem, not an asset one, and it is small: round 3 named the exact
mechanism (a spatial reservation rect, the same machinery the reticle exclusion already
proves exists) and it was never dispatched. On my scoring, implementing (1)–(3) above would
move axes 7 and 8 by 2 each and axis 2 by 1, i.e. **`10-inventory` to ≈ 5.3**. Nothing in
the VFX pipeline will do that.

---

## 3. Claim verification

| # | claim | ruling | evidence |
|---|---|---|---|
| 1 | `FIX-vfx.md` §2: chromatic aberration fixed by `f9b47c4`; margins at 1 px | **VERIFIED, and understated** | See §3a. On genuine 3D surfaces the fix is **6 px → 1 px** on `10-inventory`, not the 0 → 0 the report shows. |
| 2 | `FIX-vfx.md` §2 measures on a "3D-only band `y ∈ [90,470]`" | **REFUTED for `10-inventory` and `06-loaded-hud`** | The band excludes the top and bottom HUD but **not the item strip**, which occupies `x 29–488, y 64–470` — i.e. the entire left margin window. All 8,909 left-margin samples in `FINAL/10-inventory.png` are HUD tile edges. §3a. |
| 3 | `FIX-vfx.md` §1: per-ray gradient 21.5 → 57.4 L, "a 24 % larger typical edge" | **REFUTED — the instrument does not discriminate** | The same measure run at ordinary scenery scores *higher* than the blast it certifies. §3b. |
| 4 | `FIX-vfx.md` §1: annulus-mean step "moves only 6.6 → 9.2 L … a ring is close to invisible to it" | **VERIFIED as a number, REJECTED as an excuse** | 6.6 / 8.1 / 9.2 reproduce exactly. But the shipped frame's blast profile falls 220.3 → 184.9 L across 60 px (0.6 L/px) with a max annulus step of 11.2 L — there is still no edge, and §3c shows why. |
| 5 | `FIX-audit.md` §1b: `08-explosion`'s "the blast" gate is frozen across five captures | **VERIFIED, and extended to six** | `FINAL/manifest.json` returns `px 640, carriedPx 357, lum 32.7, bgLum 18.6, sep 0.236, legible 0.558` — bit-identical to all five rows in `FIX-audit.md` §1b, on a frame whose camera, scenario and blast have all changed since. Sixth data point. Gate ignored throughout, as briefed. |
| 6 | Round-3 §5: `308/307` and `384/383` — current HP printed above maximum | **WITHDRAWN — fixed** | `FINAL/10-inventory.png` reads `29 / 29 +14`; `FINAL/06-loaded-hud.png` reads `44 / 44 +22`. Both consistent. |
| 7 | Round-3 defect 5: numeral collisions, HUD clipping, density | **VERIFIED — entirely unfixed** | §2b. All four sub-defects present in `FINAL/10-inventory.png`. |
| 8 | Round-3 defect 6: `16-run-summary` tier grouping abandoned | **VERIFIED — and worse** | Tier map read from `FINAL/16-run-summary.png` pixels now breaks mid-row **five** times, against round 2/3's four. §4.3. |
| 9 | Round-3 §5: `15-logbook` unchanged since round 1 | **VERIFIED — 0.27 % of pixels changed since round 5** | Max-channel diff `base-r4` → `FINAL`: 3,920 px > 8 (0.27 %), mean abs 0.57 — the branding rename and nothing else. Scrollbar column profile at y 380–420 still `18 18 18 | 13 13 13 | 71 71 71 | 13 13 …` — a 6 px UA thumb at L 71 on an L 13 track on an L 13 panel. `0 / 16 RECORDED` still sits above 11 rendered entries. Model box 890×260 at **11.8 %** occupancy. |

### 3a. The aberration fix is real, and its own report measured it in the wrong place

The brief warns that the round-3 critic once cleared aberration by sampling a HUD chamfer.
The round-6 fix report guarded against that with a `y ∈ [90,470]` band. **That band is not
3D-only in two of the four shots it is quoted on**, because the inventory strip is a *left-side*
HUD block spanning `y 64–470`.

Per-channel strongest-gradient R−B separation, `FIX-vfx.md`'s own method, my reimplementation:

| window in `10-inventory` | what is actually there | PRE `base-r4` | **FINAL** |
|---|---|---|---|
| x 0–220, y 90–470 (the report's left margin) | **item-strip tiles, 100 %** | median 0, p90 4, n=9313 | median 0, p90 2, n=8909 |
| **x 0–220, y 560–800 (3D water, below the strip)** | **3D** | **median +6, p90 10, absMed 6** | **median +1, p90 2, absMed 1** |
| x 1380–1600, y 150–470 (3D sky/ridge) | 3D | median −4, p90 4, absMed 5 | median −1, p90 5, absMed 2 |

So the honest `10-inventory` figure is **6 px → 1 px**, not the report's `0 → 0`. The
conclusion survives and the win is bigger than claimed. `08-explosion` and `02-vista` carry no
strip and their reported figures stand: `08` left median +3 (p90 8) → +1 (p90 4), right −3 →
0; `02` 1 px throughout. **Round-3 defect 2 is withdrawn: chromatic aberration is fixed.**
The band needs the strip rect subtracted before it is quoted again.

### 3b. The per-ray gradient instrument does not measure a blast

`FIX-vfx.md`'s headline VFX claim rests on a per-ray max-gradient measure introduced because
the annulus mean "averages a ring away". I ran that measure at control centres containing no
VFX at all:

| file | centre | what is there | per-ray median |
|---|---|---|---|
| `reviews/round6/base/08-explosion.png` | (568, 306) | **the blast** | **46.2** |
| `reviews/round6/base/08-explosion.png` | (1350, 600) | ordinary terrain, same frame | **54.2** |
| `reviews/round6/FINAL/08-explosion.png` | (985, 390) | **the blast** | **54.0** |
| `reviews/round6/FINAL/08-explosion.png` | (700, 250) | trees + arch, same frame | **88.4** |
| `reviews/round6/FINAL/06-loaded-hud.png` | (985, 390) | **no blast at all** | **113.3** |
| `reviews/round6/FINAL/06-loaded-hud.png` | (250, 300) | item strip + rock, no blast | **216.3** |

In its own frames, ordinary scenery scores 1.6–4.0× the blast the instrument was built to
certify; a shot with **no explosion in it** scores 113.3 at the identical coordinate where the
explosion scores 54.0. The measure answers "is there any high-contrast structure within 160 px
of this point", which in a game frame is always yes. **The 21.5 → 57.4 L headline is not
evidence that the blast gained an edge.** The critic's own annulus instrument — which moved
6.6 → 8.1 → 9.2 L — was right, and the reason it barely moved is §3c.

### 3c. Why the blast still has no edge: it is additive-only

`FINAL/08-explosion.png`, disc `r < 120` about the blast at (985, 390), against a background
ring `r 200–270`:

- disc median L **166.8**, ring median L **55.0** — a **3.0× lift over 45,213 px**;
- 4-px annulus means fall **220.3 → 184.9 L across 60 px** (0.6 L/px), max step 11.2 L;
- **392 of 45,213 disc pixels (0.87 %) are below the ring median.**

That last number is the whole story. An effect that can only brighten cannot have a
silhouette. Round-3 fix (c) asked for "the opacity layer — a short-lived dark smoke/dust plume
with soft-particle fade — so the effect has a silhouette instead of only luminance". It was
not done, and it is the only thing that will move axis 6. What ships instead is 115 additive
ember blobs (median area 25 px, max 2,999 px) and a set of hard-edged debris slivers over a
structureless warm veil. At 3× (crop (880,280) 240×220) the veil fogs the wall, the stairs and
the trees behind it and terminates nowhere.

---

## 4. Top defects, ranked

### 1. `08-explosion` — the blast is now a veil with no body, and axis 6 went down

Round 2 photographed a soft haze. Round 3 photographed a clipped white sun and asked for four
things. Three were done well (the clip is gone — viewport `L>250` fell **5,958 → 252 px**,
−96 %; the hue is preserved; the aberration is fixed) and the fourth was not, and the fourth
was the one that mattered.

The shipped frame's explosion has **no core, no shockwave ring, no smoke, no dust, and no
distortion**. It is a broad additive veil (0.87 % of it darker than background, §3c) with 115
round ember stickers on it. The frame's brightest object is not the blast — the brightest
0.2 % of the upper two-thirds centroids at **(246, 433)**, the pale rock terrace on the left.
That is the rubric's axis-6 four-marker read literally: "flat billboard puffs … single-layer
effects".

**Fix, in order:** (a) add the opacity layer — an alpha-blended dark smoke/dust emitter on the
same frame budget as the embers, so the effect occludes rather than only sums; (b) restore a
camera-facing shockwave rim with a *hard inner edge* and verify it on the **annulus-mean**
instrument, not the per-ray one; (c) replace the per-ray gradient in `tools/vfxmeasure.mjs`
with a background-relative measure, or delete it — §3b shows it certifies frames with no
explosion in them; (d) fix the frozen "the blast" gate before any VFX constant is tuned
against it again (six identical captures now, §3 claim 5).

### 2. `10-inventory` — the damage-numeral layer, fourth round of asking

§2b in full. **18,483 px of numeral against 2,401 px of monster.** Two runs abut into
`1048!1048!`; a third overlaps at low alpha; a fourth ships as a row of digit-tops behind the
inventory strip; `24012` prints three times.

**Fix (unchanged from round 3, still not dispatched):** (a) a spatial reservation — reject or
displace a numeral whose box intersects a live run's box, the same mechanism the reticle
exclusion rect already implements; (b) clip the numeral layer out of the strip's rect
(`x 29–488, y 64–470`) instead of z-ordering under it; (c) merge concurrent hits on one target
into a single accumulating readout. This is the highest-value unbought item in the build: it is
the only ranked defect whose mechanism is already written down, already proven to exist in the
codebase, and still worth +0.5 on the worst shot in the set.

### 3. The Blight tier ships with inverted glyph polarity and a duplicated rule colour

New this round; it arrived with the new tier. Measured on tile interior bands in
`FINAL/10-inventory.png` (`x 30–300`), dark span = median − p10, bright span = p90 − median:

| tier row | median L | dark span | bright span | polarity |
|---|---|---|---|---|
| white | 51.1 | 34.6 | **149.8** | light glyph on dark plate |
| green | 52.8 | 33.4 | **121.8** | light on dark |
| red | 69.9 | 57.6 | **113.2** | light on dark |
| gold | 82.0 | 65.2 | **103.4** | light on dark |
| blue | 67.0 | 49.3 | **121.1** | light on dark |
| **magenta (Blight)** | **86.1** | **79.3** | 52.6 | **dark glyph on light plate** |

Reproduced independently in `FINAL/16-run-summary.png` (magenta row dark 77.9 / bright 54.2;
every other tier the inverse). Rendered as pure silhouettes the sixth tier inverts against the
other five — the axis-4 test, failed inside the one UI element the shot exists to judge.

Compounding it, the tier rules: white `(230,236,244)`, green `(99,224,106)`, red
`(255,91,69)`, gold `(255,212,79)`, blue `(95,216,246)`, **Blight `(234,241,249)`** — the
Blight rule is white, within 4/5/5 of the common tier's. Two tiers, one rule colour, in a
strip whose entire job is tier legibility.

**Fix:** give the Blight plate the same dark base as the other five and draw its glyph in the
tier hue; give it a magenta rule.

### 4. `16-run-summary` — five mid-row tier breaks, and the two screens disagree about tier order

Tier map read from `FINAL/16-run-summary.png` pixels (16 columns, top keylines at
y 479/522/565/608/651/694, pitch 42.9):

```
row0  MMMMMMMMM|WWWWWWW      magenta -> white at column 9
row1  WWWWWWWWWWWWWWWW
row2  W|GGGGGGGGGGGGGGG      white -> green at column 1
row3  GGGGGGGG|RRRRRRRR      green -> red at column 8
row4  RRRRR|YYYYYYY|BBBB     red -> gold at 5, gold -> blue at 12
row5  BBB
```

**Five** boundaries fall mid-row, against round 2/3's four. Round 3's fix (a) — one
shrink-wrapped block per tier — is unimplemented for the third round running, on a card that
uses 31.6 % of the frame with a flat backdrop occupying the rest.

New: this screen orders the haul **magenta-first**, while `10-inventory`'s HUD strip orders the
identical 83-item haul **magenta-last**. Two screens, one haul, opposite tier order. And
`ITEMS COLLECTED` is used twice — once as a stat label reading `1087`, once as the header of a
grid of 83 tiles.

### 5. No anti-aliasing anywhere in the 3D layer

Strong-edge transition widths, viewport `x 510–1600, y 110–800`, edges with |ΔL| > 60:

| file | strong edges | complete in 1 px | 2 px | ≥3 px |
|---|---|---|---|---|
| `FINAL/06-loaded-hud.png` | 5,548 | **58.9 %** | 37.9 % | 3.2 % |
| `FINAL/02-vista.png` | 3,017 | **54.6 %** | 41.4 % | 3.9 % |
| `FINAL/08-explosion.png` | 3,175 | **45.1 %** | 49.2 % | 5.7 % |
| `FINAL/10-inventory.png` | 4,350 | 33.1 % | 57.5 % | 9.4 % |
| `base-r4/06-loaded-hud.png` | 4,345 | 61.0 % | 37.1 % | 1.9 % |

The majority of silhouette edges in the build resolve in a single pixel — there is no AA
resolve in the post stack, and it has not moved since round 5. The rubric's axis-9 four-marker
names "jaggies" explicitly, and this is the reason axis 9 stops at 7 on its best shot now that
aberration is fixed. Confirmed at 5× on the survivor's rifle barrel in `FINAL/06-loaded-hud.png`
(crop (630,420) 100×240).

**Fix:** an FXAA or SMAA resolve at the end of the post chain. This is the single cheapest
remaining point in my domain.

### 6. `15-logbook` — untouched for four rounds, and still the one browser default in the product

3,920 changed pixels (0.27 %) since round 5, all of them the `Stone Golem → Basalt Sentinel`
rename. The scrollbar is still the bare UA thumb (6 px at L 71 on an L 13 track on an L 13
panel); `0 / 16 RECORDED` still sits above 11 fully rendered entries; entry names are still
Title Case beside uppercase tabs and an uppercase header; the model viewer is 890×260 holding a
304×199 subject at **11.8 % occupancy**, and the subject is lit flat (p5–p95 L 11.4–121.8, no
key). Both previous fix agents declared it out of scope, which was fair each time. Four rounds
is no longer an oversight; it is a decision, and it should be recorded as one.

---

## 5. Honest per-axis ledger — the deliverable for round 4

For each axis: does it clear 7 anywhere in my set, does it clear 7 *across* the set, and is the
residual a **code** problem someone could still fix or an **asset-authoring** problem no shader
work will close.

| # | axis | best in set | clears 7? | residual is | the measurement that says so |
|---|---|---|---|---|---|
| 1 | Lighting & shadow | **5** (`06`,`08`,`10`) | **No** | **CODE** | No contact shadow: under the survivor in `FINAL/06-loaded-hud.png` (x 640–720, y 640–665) mean L **35.7** against open water at **34.6** — a **1.1 L** shadow. `08` manages 4.1 L. There is no AO/contact term in the pipeline; adding one is shader work, not art. |
| 2 | Composition & depth | **5** (`01`,`06`,`08`,`14`,`17`) | **No** | **ASSET** | `17-artifacts` panel is **28.1 %** of the frame against a backdrop whose p1–p99 spans **9.3–21.3 L** over 313×900. `01-title`'s backdrop has mean \|dL/dx\| **0.198** (max 2.1) over a 420×300 patch — the blur has erased the composition. `15`'s model box is 88 % empty. Camera and layout decisions; no code closes them. |
| 3 | Colour & grade | **7** (`01`,`06`) | **No** (6 or below on five shots) | **ASSET** | The grade itself now works: `10-inventory` %>L220 **7.26 → 1.59** while its control moved 0.51 → 0.27. What is left is per-screen palette authoring — `15-logbook` at 5 is four hues of blue-grey. |
| 4 | Silhouette & form | **7** (`17`) | **No** | **ASSET** | The Blight tier's polarity inversion (dark span 79.3 vs bright 52.6, against every other tier's inverse) and the `14-survivor-select` model's stick-leg pose are art. One code sliver: `06`'s framing puts object 0 at **6 px**. |
| 5 | Material believability | **4** on all eight shots, all four rounds | **No** | **ASSET** | Measured across `06`/`08`/`10`: no roughness contrast between rifle metal, cloth and rock — a 5× crop of the survivor shows every facet at one specular response. `VERIFIED.md` records the specular-aliasing root cause and its fix; that removes salt, it does not create material variation. **There are no roughness/metalness maps for a shader to contrast.** No shader work closes this axis; it is the reason the build cannot pass. |
| 6 | **VFX quality** | **5** (`06`,`10`) | **No — and its headline shot went 5 → 4** | **CODE** | `FINAL/08-explosion.png`: **0.87 %** of the blast disc is below background — the effect is additive-only and has no opacity layer, no smoke, no shockwave, no distortion. That is a missing emitter and blend mode. `10-inventory` earned +1 for the quad-edge fix (402 → 127 hard steps), which proves the pipeline responds when it is worked on. |
| 7 | **UI/HUD craft** | **8** (`01`); 7 on `06`,`08`,`14`,`17` | **Clears 7 on five of eight** | **CODE** | The three failures are all DOM/JS with named mechanisms: `10`'s numeral reservation and clip rect (§2b), `15`'s scrollbar and counter, `16`'s tier-grouped wrap. None needs an artist. **This is the axis closest to passing and the cheapest to close.** |
| 8 | **Readability under load** | **8** (`01`,`14`,`17`) | **Clears 7 on the three menu shots; fails on all three gameplay shots** | **CODE** for `10`, **CODE+ASSET** for `06`/`08` | `10`: 18,483 px of numeral vs 2,401 px of monster = **7.7×**. `06`: the manifest's own instrument puts 3 of 10 monsters under 30 px. `08`: the blast lifts 45,213 px of mid-ground to **3.0×** background. |
| 9 | **Post-processing** | **7** (`06`) | **No — but it moved furthest** | **CODE** | Aberration independently verified fixed: `10-inventory` 3D water margin **+6 px (p90 10) → +1 px (p90 2)**; `08` 4 px → 1 px. Clipping: `10` viewport L>250 **4,918 → 1,369 px**; `08` **5,958 → 252 px**. What blocks 7 is **no AA** (33–59 % of strong edges resolve in 1 px, §4.5) and an unthresholded bloom. Both are pipeline code. |
| 10 | Cohesion | **7** (`01`,`06`,`14`,`17`) | **Clears 7 on four of eight** | **ASSET/SPEC** | The Blight tier ships with a rule colour `(234,241,249)` within 5 of the common tier's `(230,236,244)`, inverted glyph polarity, and opposite ordering in the strip vs the summary. That is a data/CSS authoring gap in one new tier, not an engine problem. |

**Summary of the ledger.** Four axes are **code** problems that are still open and still
tractable: **6** (add the opacity layer), **7** (the numeral reservation — the single highest-
value item left), **9** (add an AA resolve), and **1** (add a contact-shadow term). Four are
**asset-authoring** problems that no shader round will close: **2**, **3**, **4**, **10**. One,
**axis 5**, is an asset problem in the strongest sense — the surfaces carry no roughness or
metalness data for any material response to be built on, and it has read 4 on every shot in
this domain for four consecutive rounds. **Axis 5 is why this build cannot pass the rubric,
and it will not be closed by shader work.**

---

## 6. Positions I am revising

- **Round-3 defect 2, "frame-wide radial chromatic aberration at 4–6 px, peaking near 10 px" —
  WITHDRAWN. It is fixed.** Verified on 3D-only surfaces with the item strip excluded, in the
  shot where the fix report's own band failed to exclude it. My withdrawal is not the round-2
  error repeated: the round-2 withdrawal was made on a HUD chamfer; this one is made on 3D
  water at `x 0–220, y 560–800` and 3D sky at `x 1380–1600, y 150–470`, in the same shot,
  against a PRE frame that reads +6 px on the same windows.
- **Round-3 §5, "`308/307` and `384/383` — current HP printed above maximum" — WITHDRAWN.**
  `FINAL` reads `29 / 29` and `44 / 44`.
- **Round-3's `10-inventory` score of 4.2 — REVISED UP to 4.8**, and the four axes that moved
  (1, 3, 6, 9) are exactly the four the VFX and post work owned. Round 3's *cause* was correct
  and its *ranking* was wrong: it ranked the numeral layer fifth, and the numeral layer is what
  was left.
- **Round-3's `08-explosion` axis 6 of 5 — REVISED DOWN to 4.** Not because the frame is worse
  overall (it is better: no clipping, no aberration, hue preserved) but because the specific
  thing axis 6 scores — layering, a body, a silhouette — is measurably absent (0.87 %).
- **Round-3's `16-run-summary` of 5.3 — REVISED DOWN to 5.0** on axes 4, 7 and 10, all three
  cuts caused by the new Blight tier's polarity, rule colour and ordering.
- **`FIX-vfx.md` is upheld on its substance and corrected on two instruments.** Its aberration
  claim is true and understated; its blast-clipping claim is true; its per-ray gradient claim
  does not survive a control (§3b). I record that the report's discipline — three named on-disk
  states, credit given to `f9b47c4` rather than itself, the 0.6 % re-clip declared as a trade —
  is why its errors were findable at all.

---

## 7. Commands and evidence

- `reviews/round6/FINAL/manifest.json` read first (§0). Provenance:
  `git log -1 --format='%H %ci %s' 1541fc9`; `ls -la --time-style=long-iso` across
  `reviews/round5/base-r4/`, `reviews/round6/{base,vfx,audfix,FINAL}/`, `shots/`.
- Python 3.14.4 + Pillow 12.3.0 + numpy 2.5.1 + scipy 1.18.0 `ndimage`, decoding each PNG to
  RGB. All statistics Rec.709 luminance. Scratchpad module `inst.py` reimplements
  `tools/vfxmeasure.mjs`'s `blastAt` (4 px annuli to r 160, 180-ray gradient, core r<40,
  disc r<120) and `aberr` (per-channel strongest-gradient on G-edge local maxima, ±7 px
  search, both outer channels required to show ≥12) from the source, then calibrated against
  six published figures from three authors (§0) before scoring anything.
- Measurements run: viewport exposure across five capture arms; region statistics (water,
  sky, far ridge, near ground, contact shadow) on `06`/`08`/`10`; blast radial profile and
  per-ray gradient at the blast **and at four VFX-free control centres per frame**;
  aberration on the report's band and on four hand-verified 3D-only windows; tight gold-ink
  numeral extraction with HUD exclusion, connected components, run grouping and dilated
  footprint across four captures; tier-rule detection and per-tier glyph-polarity spans in
  `10-inventory` and `16-run-summary`; run-summary tier map at 16 columns × 6 rows;
  strong-edge transition-width histogram on five frames; sky-gradient flat-run banding;
  backdrop gradient energy on `01`/`17`/`15`/`14`; model-viewer occupancy and subject
  luminance range on `15`/`14`; logbook scrollbar column profile; panel-bounds detection by
  column/row mean steps; max-channel diff `base-r4` → `FINAL` on all eight shots.
- Magnified crops inspected: `10` numeral collision 3× at (980,400); `10` numeral-under-strip
  3× at (240,220); `10` item strip 2× at (20,60); `10` nova 3× at (600,540); `08` blast 2× at
  (840,250) and 3× at (880,280); `08` base-arm blast 2× at (400,150); `06` survivor 5× at
  (630,420); `16` item grid 2× at (450,470).
- `tools/vfxmeasure.mjs` was **read** (for its algorithm) and **not executed and not edited**.
  `tools/capture.mjs`, `tools/vfxprobe.mjs`, `tools/glyphdist.mjs` were neither read nor run.
  No project file was modified.
- `02-vista` decoded for the aberration control only. `03`, `04`, `05`, `07`, `09`, `11`,
  `12`, `13-*`, `18` not scored — outside the stated shot list.
