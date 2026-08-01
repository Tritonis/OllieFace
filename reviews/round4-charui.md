# PETRICHOR — Round 4 (FINAL) critique: CHARACTER READ + HUD/UI

Critic domain: rubric axis 4 (player silhouette & form) and axis 7 (UI/HUD craft).
Shots: seed 1337, 1600×900. `shots/manifest.json` → `ready: true`, `partial: false`,
`errors: []`, all 8 shots `frameErrors: 0`, `newErrors: []`. No crash to report;
the visual scores stand.

Every number below was measured by decoding the shipped PNGs in headless Chromium
and reading `getImageData`, not by eye. Nothing was re-run through the engine;
`tools/capture.mjs` was not executed and no project file was modified.

This is round 4 of 4. Per `RUBRIC.md`'s stopping condition, §3 is the honest final
statement of which axes clear and which do not, and why.

---

## 1. Axis scores

| Axis | 03-thirdperson | 06-loaded-hud | 01-title (UI layer) |
|---|---|---|---|
| 1 Lighting & shadow | 6 | 6 | 5 |
| 2 Composition & depth | 5 | 5 | 5 |
| 3 Colour & grade | 7 | 6 | 7 |
| 4 **Silhouette & form (player)** | **7** | **6** | **7** |
| 5 Material believability | 5 | 5 | 5 |
| 6 VFX quality | 5 | 5 | 4 |
| 7 **UI/HUD craft** | **7** | **7** | **8** |
| 8 Readability under load | 7 | 6 | 8 |
| 9 Post-processing | 6 | 5 | 6 |
| 10 Cohesion | 7 | 7 | 7 |
| **Mean** | **6.2** | **5.8** | **6.2** |

(Round 3 means, same three shots: 6.1 / 5.5 / 6.1. Round 2: 5.0 / 3.9 / 4.6.)

```
AXIS SCORES 03: 1:6 2:5 3:7 4:7 5:5 6:5 7:7 8:7 9:6 10:7
AXIS SCORES 06: 1:6 2:5 3:6 4:6 5:5 6:5 7:7 8:6 9:5 10:7
AXIS SCORES 01: 1:5 2:5 3:7 4:7 5:5 6:4 7:8 8:8 9:6 10:7
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Six axes are
still under 7 in at least one shot, and axis 9 sits at 5 in `06`.

**But the two axes I own both moved, and one of them cleared its last shot.**

- **Axis 7 (UI/HUD craft) now clears 7 in all three shots, including
  `06-loaded-hud`** — the dense late-run frame it has failed in every previous
  round. That is the specific question I was asked and the answer is yes.
- **Axis 4 (player silhouette) clears 7 in `03` for the first time.** It does not
  clear in `06`, and the reason is not the mesh — see D-N4.

Nine of the twelve round-3 defects landed. Two never landed in three consecutive
rounds. The rest of this document is evidence.

---

## 2. Round-3 defect register

| ID | Round-3 defect | Status | Pixel evidence |
|---|---|---|---|
| D1 | Arms are detached slabs; 4 px of pure background between torso and right arm; left shoulder SD 50.7 | **LANDED** (attachment) / **PARTIAL** (declutter) | See D1 below. |
| D2 | `LVL 3` at 22:00 with 37 items | **LANDED** | `06` reads `LVL 20`, `760 / 1253`, XP bar 48.6 % full. |
| D3 | Tier-uniform colour exposed 7 same-tier duplicate glyphs | **LANDED** | Independent XOR of all 37 shipped tiles: min same-tier distance **42 px / 494**; all three named pairs visually distinct at 6×. |
| D4 | Ultimate slot at 40 % brightness with no numeral | **LANDED** | `06` R slot carries `0.7` at peak 255 over a partial sweep. Round 3: peak 93.5, no numeral. |
| D5 | REGRESSION — contact "shadow" is a bright ring 3.3× ground | **LANDED** | No pixel inside the blob footprint exceeds surrounding ground. Round 3's 165-peak annulus is gone. |
| D6 | Stack counts at ~5 px cap height, on top of the glyph | **PARTIAL** | Cap height now **9 px**. Still overlaps the glyph on most tiles. |
| D7 | Ability labels at 1.02–1.29 : 1 over snow; illegible `+N` | **LANDED** | All four `.slot-name` chips measure **5.9 – 6.8 : 1**. `+21` / `+22` legible white-on-black. |
| D8 | Tier rules overhang content by 40 px on wrapped rows | **LANDED** | Every rule now shrink-wraps its row to within 3–5 px. |
| D9 | 1.3× overscan crops wide glyphs flush into the tile border | **LANDED** | `ART_OVERSCAN` deleted; min right margin across 37 tiles is **3 px**, most 6–13 px. |
| D10.1 | Damage numerals composite into unreadable piles | **NOT LANDED** | `06` still shows `4 (444` and `4111`. |
| D10.2 | Camera framing untouched (FOV 70 / DIST 5.4 / SHOULDER 0.65) | **NOT LANDED** | `CameraRig.js:27,30,31` byte-identical for the third round running. |
| D10.3 | Stale `55M` chip next to a boss objective | **NOT TESTED** | `05-boss` was out of scope this round. |
| D11 | Title: four menu entries of identical weight; 5 px focus tick | **LANDED** | Hierarchy now measurable on four independent channels. |

**Score: 8 LANDED · 2 PARTIAL · 2 NOT LANDED · 1 not tested · 0 regressions.**
Round 3 had two regressions; round 4 introduced none.

---

### D1 — Arm/torso attachment: LANDED. Articulation and declutter: PARTIAL.

Round 3's measurement was a luminance row scan at `y = 470`, `x 740→789`, which
found luminance dropping to 23–24 at `x 748–751` — a value it matched to the
terrain reference `meanBox(600,600,660,640) = 24.4` and called "a 4-pixel-wide
window of pure background".

Same scan on the round-4 shot:

```
x   736 740 744 747 748 750 752 753 756 760 763 764 768 775
L   106 105 107  90  35  33  32  64 102 104 103  67  47  47
```

The dark band at `x 748–752` survives, so a luminance-only test would report the
same defect. It is not the same pixel. **Hue separates them:**

| sample | round-4 hex | family |
|---|---|---|
| `(748,470)` `(750,470)` `(752,470)` | `#242040` `#1f1f40` `#1e1e3f` | coat navy |
| `(750,473)` `(751,475)` | `#1e1a39` `#1e1a39` | coat navy |
| `(768,470)` `(775,470)` `(780,480)` | `#422933` `#422834` `#402b30` | terrain maroon |
| `(744,470)` `(756,470)` | `#78657c` `#776070` | lit plate |

The seam is `#1e1e3f` — the coat's own dark navy, 32–35 lum against a *local*
background of 46–48. It is darker than the terrain behind it, not equal to it.
The band is an armpit shadow between the yoke and the upper arm, and a column
scan at `x = 750` shows it bounded above by the yoke (102–105 at `y 454–467`) and
below by the arm (78–127 at `y 478–500`). One row up, at `y = 465`, there is no
break at all: 98–105 continuously from `x 736` to `x 766`.

**In outline the arm is attached.** Round 3's specific, named defect is fixed.

What did not land:

- **The arm has no articulation.** At 12× (`x 725–795, y 440–500`) the limb is a
  single mauve wedge projecting right and slightly down from the pauldron and
  terminating in nothing. There is no elbow, no forearm, no hand. The **left arm
  does not exist in the silhouette at all** — everything left of the cloak in that
  band is rifle stock and sling. A back-view survivor with one plank arm is a
  better silhouette than round 3's floating lozenge, but it is not a 9.
- **The left shoulder is still cluttered.** Round 3 measured `meanBox(676,418,706,500)`
  = 66.4 with SD 50.7 and set a target of SD < 25. Round 4 measures **mean 60.6,
  SD 39.2** — a 23 % reduction, well short. At 12× the box still contains a hard
  specular blowout, a cyan antenna, an orange helmet chip, a cyan lamp bar and the
  rifle's white edge highlight.

**Fix (final):** give the arm a forearm segment and a hand block so the outline
has one convex break between shoulder and weapon; mirror a visible left upper arm
outboard of the cloak. Kill the specular blowout on the helmet's left facet
(clamp the plate material's specular or drop `emissiveIntensity`), which is what
is driving most of the residual SD.

---

### D2 — LANDED, fully.

`06-loaded-hud.png` bottom-left reads `760 / 1253` and `LVL 20`.

- HP fill runs `x 30 → 300` in a trough `x 30 → 474` = **60.8 %**. `760 / 1253 =
  60.7 %`. The bar is driven by the real number, not a decorative width.
- XP fill runs `x 102 → 276` in a trough `x 102 → 460` = **48.6 %**.
  `Harness.js:896` seeds `seedLevel(20, 0.42)`; the extra ~6 % is the level-up that
  fires during settle, which is corroborated by the `◆ LEVEL 20` toast at the
  bottom of the pickup log. Three independent readouts of one live number.
- Same frame: `22:01`, `HARD X3.2`, `$4,378`, 37 stacked tiles. This finally reads
  as one coherent late-run state.

---

### D3 — LANDED. Independently verified against the shipped PNG, not the probe.

I did not take the implementer's headless probe on trust. I extracted all **37
tiles from `06-loaded-hud.png`** at the measured grid (pitch 38 px, 34 px tiles;
white row 1 `y 75`, white row 2 `y 113`, green rows `y 162 / 200`, red+gold row
`y 247` starting `x 33` and `x 274`), thresholded each glyph region
(`x0+5 … x0+30`, `y0+2 … y0+20` — the band above the count shelf) into a 26×19
1-bit mask, and XOR-ed all 200 same-tier pairs.

**Result: minimum same-tier Hamming distance = 42 px / 494 (8.5 %).** Round 3
found a 0-px pair. The ten tightest pairs:

```
gold#0 vs gold#1    42    white#7 vs white#10  48    white#2 vs white#7   55
green#1 vs green#9  55    white#9 vs white#10  57    white#9 vs white#12  57
white#4 vs white#5  59    green#1 vs green#12  63    green#0 vs green#9   64
green#2 vs green#9  65
```

The XOR floor is low in absolute terms only because every glyph is a centred blob
of similar area; the discriminating question is whether they *read* differently.
Cropped at 6× they do. The three pairs round 3 named:

| round-3 collision | round-4 shipped tiles |
|---|---|
| **Crowbar** (`cross`) ≡ **Medkit** (`plus`) | Crowbar is now an angular pry-bar with a canted hook (`x0=261`); Medkit is a plain plus (`x0=71, y0=113`). Nothing in common. |
| **Tri-Tip Dagger** (`blade`) ≡ **Harvester's Scythe** (`scythe`) | Blade is a thin canted slash with a spine highlight; scythe is a curved hook on a haft. |
| **Afterburner** (`wing`) ≡ **Wax Quail** (`feather`) ≡ **Hopoo Feather** (`plume`) | Three distinct shapes: a bell/jellyfish with trailing filaments, a narrow spined leaf, and a three-blade sprout. Round 3's "three virtually identical vertical feathers" is gone. |

**One residual near-collision, minor:** **Tougher Times** (`hex`, `x0=185`) and
**Repulsion Armor Plate** (`shield`, `x0=223`) sit adjacent in the common row and
are both filled grey polygons of near-identical area (XOR 59/494). At 6× the
flat-top hexagon and the pointed-apex shield separate; at 1:1 they are 2–3 px
apart. Not the round-3 defect, but the tightest thing left.

**Cross-tier duplicates are correct and I am not scoring them.** Brainstalks
(legendary, `stalk`) and Queen's Gland (boss, `hive`) draw near-identical ribcage
forms, as do Bison Steak (`drop`) and Planula (`polyp`) — in each case the tier
colour is the separator, which is exactly the shape-carries-identity /
colour-carries-tier contract.

---

### D4 — LANDED.

`06` R-slot icon box (`x 1508–1568, y 765–815`): **peak 255**, and the peak is the
`0.7` numeral itself. Round 3 measured peak 93.5 with no numeral at all. The
sweep boundary sits at ~79 % of the tile height, consistent with 0.7 s remaining
on a ~0.9 s cooldown.

`HUD.js:560,566` now derives both from one quantity:

```js
const sweeping = a.cd >= SWEEP_MIN_CD && a.rem > TIMER_MIN;
const timer = !sweeping ? '' : a.rem >= 1 ? String(Math.ceil(a.rem)) : a.rem.toFixed(1);
```

The invariant round 3 asked for — *a darkened slot always carries a readout* — is
structurally enforced, not coincidentally satisfied.

---

### D5 — LANDED (the regression is removed). Ground contact is now near-invisible.

Round 3's acceptance test was: **no pixel inside the blob footprint may exceed the
surrounding ground luminance.** Luminance grid under the feet in `03`, `x 664→796`
step 12, `y 620→660` step 4:

```
y\x   664  676  688  700  712  724  736  748  760  772  784  796
620   123  115   98   80   66   82   69   41   46   52   51   51
632   118  113   98   74   25   26   27   26   34   50   50   49
640   111   26   27   26   25   26   27   28   27   29   26   28
648    27   26   26   24   25   25   24   26   25   27   27   27
656    27   25   26   25   26   25   25   26   25   25   25   25
```

There is no annulus. The maximum inside the footprint is 183.2 at `(741,630)`,
which is the right boot's cyan sole highlight — character geometry, not the decal.
Round 3's 165-peak grey ring at `(740,638)` with hex `#4f4e58` is gone; that pixel
now reads 27. `BLOB_FRAG` is a true multiply
(`blendSrc: DstColorFactor, blendDst: OneMinusSrcAlphaFactor`, premultiplied), so
the `<= dst` property holds algebraically at every alpha. **The regression is
closed.**

**The cost:** the decal is now essentially invisible in `03`. The ground under the
boots reads 24–27 against a reference of 29.9 — a 3–5 point delta on a 30-value
floor. At 8× it is a faint smudge on the lit ledge to the *left* of the boots,
and the character's actual contact point coincides with the terrain's own large
cast shadow. Round 2 logged "no ground contact" as U18; on dark ground that is
where it stands again — this time honestly rather than inverted.

The decal is provably present, because in `06` — where the character stands on
snow at mean luminance 239 — it renders as a large soft ellipse whose core reads
**128 against 239** (54 % multiply). That ellipse spans roughly `x 610 → 840`
(≈230 px) against a character ~105 px wide. `CharacterMesh.js:562` sets
`blob.scale.setScalar(0.8)`, so most of that footprint is the level-up burst's own
ground ring, not the blob — but the composite reads as a crater rather than a
contact shadow.

---

### D6 — PARTIAL. Size fixed; the count still sits on the glyph.

`hud.css:390` raised `.item-stack` from `0.7em` to `0.95em` with a 4-way black
outline. Measured on the shipped PNG (Paul's Goat Hoof tile, `x0=71, y0=75`), the
`X8` glyph body occupies `y 96 → 104` — a **9 px cap height**, up from round 3's
5 px. At 1:1 the counts are readable; at 6× they are crisp. That is a real fix.

The CSS comment at `hud.css:386-389` claims `ART_CENTRE_Y` / `ART_RADIUS` "leave
this corner free, so the count owns it". The pixels disagree on the wider glyphs.
At 6× on the common row: `X7` sits across the Crowbar's lower shaft, `X9` across
the Lens-Maker's ring, `X11` across Gasoline's flame base, `X4` across Sticky
Bomb's diamond corner, `X6` across Monster Tooth's lower-right point. The glyph
mask for Roll of Pennies shows the count starting at tile row 21 while the coin
stack still occupies rows 20–22.

Legible because of the outline, not because of the layout. **Fix:** the shelf that
comment describes does not exist in `platePath` — cut it, or drop `ART_RADIUS`
from 0.30 to 0.27 and lift `ART_CENTRE_Y` from 0.41 to 0.38.

---

### D7 — LANDED, and it is the single biggest win of the round.

`hud.css:883-897` gave `.slot-name` its own opaque chip
(`background: rgba(4,7,12,0.72)`), a black keyline
(`inset 0 0 0 1px rgba(0,0,0,0.85)`), a sheared `clip-path` and a double
text-shadow. Measured on the shipped `06` frame over snow, classifying each chip's
pixels into text (brightest 18 %) and plate (darkest 40 %):

| label | chip box | text | plate | contrast | round 3 |
|---|---|---|---|---|---|
| `DOUBLE TAP` | 1279–1337, 852–861 | 210.6 | 33.6 | **6.26 : 1** | 1.29 : 1 |
| `PHASE ROU…` | 1352–1416, 846–855 | 207.1 | 32.7 | **6.34 : 1** | 1.07 : 1 |
| `TACT. DIVE` | 1435–1485, 846–855 | 205.1 | 34.5 | **5.94 : 1** | 1.02 : 1 |
| `SUPP. SALVO` | 1505–1566, 846–855 | 208.7 | 30.6 | **6.81 : 1** | — |

Local background above and below the chips runs 186–214, so the plate is holding
a 6:1 island inside a near-white field. `SUPP. SALVO`, which round 3 called
"mathematically gone" at 1.02:1, is now the highest-contrast of the four.

`.pip-more` went from `0.62em --ink-dim` to `0.85em` white on a 4-way black
outline (`hud.css:925`). Rasterised from the shipped frame the M2 chip reads `+21`
and the R chip reads `+22`, both unambiguous at ~8 px. Round 3 could not tell `+2`
from `+22` at 8× zoom.

**Not extended far enough** — see N1 and N5. The same translucent-plate failure
still governs `.money` and the difficulty row.

---

### D8 — LANDED.

`HUD.js:212` now emits non-wrapping `.inv-row` chunks inside a
`flex-direction: column` `.inv-group` (`hud.css:336-353`), so `max-content`
resolves to the widest *row* rather than the unwrapped width of every child.

Measured rule runs and last-tile right edges in `06`:

| tier | rule run | tiles in row | last tile ends | overhang |
|---|---|---|---|---|
| white | `x 29 → 488` (`#e6ecf4`) | 12 | 484 | **4 px** |
| green | `x 29 → 488` (`#63e06a`) | 12 | 484 | **4 px** |
| red | `x 29 → 261` (`#ff5b45`) | 6 | 256 | **5 px** |
| gold | `x 269 → 387` | 3 | 383 | **4 px** |

Round 3: white and green rules ran to 488 against last tiles at 448 and 444 — a
40 px overhang. Four rules of four different lengths, all content-derived. The
ragged right edge is gone.

---

### D9 — LANDED.

`ART_OVERSCAN` no longer exists. `Icons.js:337-342` translates to
`(s/2, s*ART_CENTRE_Y)` and calls `drawGlyph(g, item.glyph, s*ART_RADIUS, 0)`
directly onto the already-clipped, already-plated canvas at `ART_RADIUS = 0.30` —
which is exactly the fix round 3 specified.

Verified in the pixels: I measured every glyph's bounding box against its tile
interior across all 37 tiles. **Minimum right margin is 3 px** (Medkit's plus);
the median is 8 px and the widest-margin glyphs run to 13 px. Round 3's named
offenders now measure: Stun Grenade (`burst`) R5, Runald's Band (`snowflake`) R6,
Soldier's Syringe (`bars`) R10 with a 3 px top margin. Nothing is cut flush.

---

### D10.1 / D10.2 — NOT LANDED.

**Numeral pile-up.** `06-loaded-hud.png` at `(770–880, 420–450)` and
`(600–700, 500–530)`, rasterised at 4×, still shows separate damage numbers
composited at the same screen position into `4 (444` and `4111`. Each glyph is
individually upright and correctly stroked — round 3's U1 fix holds — but there is
no spawn-time screen-space separation, so the primary combat feedback channel is
unreadable in the loaded frame. This costs axis 8, not axis 7.

**Camera.** `CameraRig.js:27` `FOV_BASE = 70`, `:30` `DIST = 5.4`, `:31`
`SHOULDER = 0.65` — byte-identical to round 2 and round 3. Clearance between the
player's rightmost lit pixel and the crosshair's west arm in `03` measures **8 px**
(round 3: 3 px), and that improvement came from the mesh, not the rig. The
~106° horizontal FOV is the reason axis 2 has been pinned at 5 for three rounds.

---

### D11 — LANDED.

`01-title.png`, measured:

| channel | PLAY | CO-OP | SETTINGS | QUIT |
|---|---|---|---|---|
| label peak | **240.1** | 240.1 | 240.1 | **165.0** |
| subtitle peak | **193.2** (cyan `#4ba8c0`) | 101.4 | 101.4 | 102.0 |
| plate mean (left third) | **39.9** | 38.4 | 46.0 | **18.5** |
| focus tick peak | **193.2** @ (605,502) | — | — | 63.3 |

Four independent channels now separate the default action from the destructive
one, where round 3 had a single 5×7 px wedge. The dead 74 % of every plate carries
a right-aligned subtitle — `BEGIN A RUN ▶`, `HOST OR JOIN`, `VIDEO & INPUT`,
`EXIT` — so each button reads as a justified two-column unit instead of a word in
an empty box. QUIT is demoted on both label (165 vs 240) and plate (18.5 vs 39.9).

Type scale is a clean three-step: wordmark peak 255, tagline 194.2, seed 165.
Whole-frame mean rose 34.5 → **39.4** and the bottom band 25.8 → 33.6; the stated
45–55 target is still unmet, but menu legibility was never the cost — button text
sits at 6–16:1 over its plate.

**Residual (minor):** the cyan focus tick is still a ~5×10 px wedge at PLAY's
lower-left, not the full-height rule round 3 asked for; the plate wash and cyan
subtitle are doing the work. And the plates are translucent enough that an orange
terrain streak reads through CO-OP and SETTINGS.

---

## 3. FINAL PER-AXIS VERDICT

For each axis: does it clear 7 in this domain, and is the gap fixable in code or
is it a hand-authored-asset ceiling? Axes outside my domain are marked and scored
from the pixels only.

| # | Axis | Clears 7? | Honest reason | Gap type |
|---|---|---|---|---|
| 1 | Lighting & shadow | **No** (6/6/5) | One committed key direction and a long raking terrain shadow are present, and the character takes a real rim. What is missing is ambient occlusion in crevices and any bounce colour in shadow: the terrain's cast shadow is a flat navy block, and the character's own contact decal is a 3–5 point delta on a 30-value floor — invisible. | **Code.** AO is a render-pipeline feature (SSAO/GTAO pass), and the contact decal needs a floor-relative strength rather than a fixed multiply. Neither needs authored art. Not my domain. |
| 2 | Composition & depth | **No** (5/5/5) | `FOV_BASE = 70` (≈106° horizontal), `DIST = 5.4`, `SHOULDER = 0.65` — unchanged for three rounds. A foreground boulder fills the lower-right of `03` at wide-angle scale; the fog gradient barely separates the far ridge from the near one. On the title, the content box is ~756×430 in a 1600×900 frame with a 235 px dead band beneath it (mean 36.2). | **Code — three constants.** Round 2 proposed `FOV_BASE = 55`, `DIST ≈ 7.0`, `SHOULDER ≈ 1.0` and it has never been tried. This is the cheapest unclaimed point on the whole rubric. |
| 3 | Colour & grade | **Yes in 03/01** (7/6/7), no in 06 | Limited warm-key / cool-shadow palette with one cyan accent; gold is reserved for currency, the boss track has its own violet, item tiers own their hues. `06` loses the point because the snow field sits at mean 239 and the top-left sky at 210+, so ~40 % of the frame is a near-clipped light region with no filmic rolloff. | **Code.** A tone-mapping curve / exposure clamp on the snow material. |
| 4 | **Silhouette & form (player)** | **Yes in 03 (7). No in 06 (6).** | **03:** head steps clear of the shoulder line, helmet:cloak value break is 2.6:1 (helmet 123.3, yoke 93.0, gun 69.5, cloak 47.4), the slung rifle breaks the outline on both diagonals, the legs separate with a clean background gap (`x 723–730` across `y 576–628`), and the arm is now attached in outline rather than floating. That is a readable black silhouette. It does not go past 7 because there is one arm, it is an unarticulated plank with no forearm or hand, and the left shoulder still measures SD 39.2 against a target of 25. **06:** the mesh is *not* the problem — the upper body reads better against snow than anywhere else in the set (helmet 162.6 / yoke 112.5 / cloak 81.0). The lower third is erased: 34.2 % of the leg band is over luminance 220 and 19.6 % over 240. You cannot find the character's feet. | **Code for the 06 failure** (clamp the level-up VFX bloom — see N4). **Partly asset ceiling for the 03 residual:** a jointed arm with a hand is a modelling job, and this rig is procedural box geometry. An outboard left upper-arm block and deleting three left-shoulder props are code and would get it to 8; a genuinely articulated limb is where the hand-authored ceiling starts. |
| 5 | Material believability | **No** (5/5/5) | Flat matte across cloth, plate, rock and metal. The gun's metalness lift raised its value but not its roughness contrast; there is no specular *response* anywhere, only a hard blowout on the helmet's left facet. Rock and cloth are the same surface with different albedo. | **Mostly asset ceiling.** Roughness/normal variation is authored texture work. A roughness-map-free engine can fake some of it with triplanar noise, but "real specular response between rock/metal/organic" is the one axis on this rubric that genuinely wants hand-authored maps. |
| 6 | VFX quality | **No** (5/5/4) | Dust motes and glow sprites are flat billboards with no soft-particle depth fade. The one layered effect in the set — the level-up burst in `06` — has rings plus a core plus a ground decal, so the layering intent is there, but it clips to white with hard edges and its dark ground disc reads as a hole rather than a shadow. The title layer has no VFX at all. | **Code.** Soft-particle depth fade is a shader uniform; the clipping is an intensity clamp. Not my domain. |
| 7 | **UI/HUD craft** | **YES — 7 / 7 / 8. Clears in all three shots, including `06-loaded-hud`.** | The angular language is complete and consistent (one `--skew` token across wordmark, rule, buttons, key chips, item tiles and pips). Hierarchy is real and measurable, not asserted. The late-run frame specifically: 37 tiles in four shrink-wrapped tier groups with correct rules, 37 distinct same-tier glyphs, 9 px outlined counts, ability labels at 5.9–6.8:1 over snow, a swept ultimate that carries its readout, a segmented HP bar whose fill matches its own numerals to 0.1 %, an aged toast log that leads with tier-coloured art, and a tight clock instrument. Round 3 held this at 6 for four legibility failures; all four are fixed and verified. It stops at 7 rather than 8 for the five defects in §4 — `.money` at 1.94:1, the 6 px slot misalignment, the permanent ellipsis, the pip/`+N` collision, and counts that still sit on their glyphs. | **All code, all small.** Nothing here needs authored art. §4 is ranked in fix order. |
| 8 | Readability under load | **Yes in 03/01** (7/8), no in 06 (6) | The HUD half of this axis improved sharply — every readout in `06` except `.money` and `HARD` now survives its background. What holds it under 7 is the 3D half: damage numerals still composite into `4 (444` and `4111`, so the primary combat feedback channel is unreadable exactly when it matters, and the player's legs are gone. | **Code.** Deterministic spawn jitter plus a live-number proximity reject (round 3 specified it); bloom clamp for the legs. |
| 9 | Post-processing | **No** (6/5/6) | `06` carries 786 fully-clipped pixels, a leg band 34 % over 220, and chromatic aberration at full strength over a frame whose lower half is already near-white. The helmet specular in `03` is a hard 4–5 px pure-white wedge with no rolloff. AA is clean and grain is unobtrusive — the failure is bloom and exposure, not the pass list. | **Code.** Bloom threshold on emissives only; scale aberration by radius and by scene luminance. Not my domain. |
| 10 | Cohesion | **Yes** (7/7/7) | Menu, HUD, item art and character all share one shear angle, one palette and one value language; the survivor reads as belonging to the stage rather than pasted onto it. It does not go past 7 because the flat-matte material treatment (axis 5) is what is unifying it — cohesion by absence of variation is cheaper than cohesion by authorship. | **Follows axis 5.** |

**Summary: 2 axes clear 7 in every shot (7, 10). 3 more clear in two of three
(3, 4, 8). 5 never clear (1, 2, 5, 6, 9).**

Of the five that never clear, **four are pure code** (1, 2, 6, 9) and three of
those four are single-constant or single-pass changes that have never been
attempted. **Axis 5 is the only genuine hand-authored-asset ceiling on this
rubric**, and axis 4's last two points are partly one too.

The most valuable unclaimed work in the whole project is still
`CameraRig.js:27,30,31`. Axis 2 has been scored 5 in nine consecutive shot
evaluations across three rounds for the same three numbers.

---

## 4. Remaining defects, ranked

Ranked by rubric cost. **A** = player mesh, **E** = HUD/menus/CSS, **F** = camera,
**G** = VFX/post (out of my domain, listed because they cost my axes).

### N1 — The currency readout drops to 1.94:1 over a bright sky [E] — `src/ui/hud.css` (`.money` plate)

`.slot-name` got an opaque chip this round. `.money` did not, and it is the number
an RoR2 player checks most.

Measured inside the chip interior (`x 42–130, y 30–53`), classifying gold glyph
pixels (`r>180, g>140, b<120, r−b>90`) against everything else:

| shot | gold glyph | chip plate | contrast |
|---|---|---|---|
| `03-thirdperson` (dark stage) | 193.8 | 44.0 | **4.40 : 1** |
| `06-loaded-hud` (bright sky) | 193.5 | 99.6 | **1.94 : 1** |

The glyph value is identical in both frames; only the plate moves. Plate hex
samples in `06` — `#7d6b46`, `#84714b`, `#7c6a46` — are roughly half the sky
(`#efd1a1`) mixed with the intended dark. The plate is translucent, so gold ink
lands on tan.

**Fix:** give `.money` the same treatment `.slot-name` just received —
`background: rgba(4,7,12,0.72)` plus `inset 0 0 0 1px rgba(0,0,0,0.85)`. Two
lines, and it is the highest-value HUD fix left.

### N2 — The M1 slot sits 6 px lower than its three siblings [E] — `src/ui/hud.css` (`.abilities` / `.slot` alignment)

`06-loaded-hud.png`, measured on the shipped frame:

| slot | tile keyline top | label chip band |
|---|---|---|
| M1 | **759** | **852 – 861** |
| M2 | 753 | 846 – 855 |
| Q | 753 | 846 – 855 |
| R | — (swept) | 846 – 855 |

Four sibling controls in one row, one of them 6 px out of register on both its
tile and its label. It does not happen in `03` (M1 and Q both key at 761) because
there M1, M2 and Q all lack a pip row. In `06` the stacked cooldown build gives
M2/Q/R a `.slot-pips` row and M1 none, and the column's bottom alignment pushes
the short stack down.

"Inconsistent spacing" is literally the rubric's 4-marker for axis 7. This is the
one structural craft break left in the cluster.

**Fix:** reserve the pip row's height on every slot (`.slot-pips { min-height }`
is already 0.4em but the element is absent, not empty when there are no pips —
emit it unconditionally), or switch `.abilities` to `align-items: flex-start` and
let the tiles top-align.

### N3 — `PHASE ROU…` is permanently truncated [E] — `src/ui/hud.css:889-891`

`.slot-name` carries `overflow: hidden; text-overflow: ellipsis; max-width: 100%`.
The chip is width-bounded by the 55 px slot tile, and "PHASE ROUND" does not fit
while "SUPP. SALVO" — the same 11 characters in narrower glyphs — does. Rasterised
from both `03` and `06`, the label reads `PHASE ROU` followed by an ellipsis. It
is not a transient state; the ability's name is unreadable in every frame of the
game.

**Fix:** the row has horizontal slack between slots — drop `max-width: 100%` and
let the chip overhang its tile, or step `.slot-name` from `0.66em` to `0.62em`.
Either is one line.

### N4 — The player's legs are erased by the level-up burst in `06` [G, costs axis 4 and 8]

Leg band `x 700–760, y 573–632` in `06`: mean **200.5**, **34.2 % of pixels over
luminance 220**, 19.6 % over 240, against the same band in `03` at mean 84.2 with
**0 %** over 220. The boots, the leg gap and the hem's lower edge are all gone,
replaced by three vertical white beams and a bloom core.

This is the single reason axis 4 does not clear 7 in `06`. The mesh is not at
fault — the upper body reads better here than in any other shot in the set.

**Fix:** clamp the level-up VFX to a bloom threshold that emissives can reach and
scene highlights cannot, and do not spawn the burst's core inside the character's
own bounding box. Separately, the harness should not fire a full-screen VFX at the
shutter for the one shot whose stated job is *"judges UI density and hierarchy"* —
`Harness.js:896` `seedLevel(20, 0.42)` triggers the level-up during settle. Seed
the level before `begin()`, or add a settle delay long enough for the burst to
decay.

### N5 — `HARD` reads at 2.09:1; the clock plate is translucent over a sunlit cliff [E]

`06` clock chip, same classification method as N1:

| element | text | plate | contrast | `03` contrast |
|---|---|---|---|---|
| `22:01` digits | 232.6 | 63.8 | 3.64 : 1 | 6.09 : 1 |
| `HARD` (yellow) | 203.5 | 97.4 | **2.09 : 1** | — |
| `X3.2` | 150.8 | 53.7 | 2.81 : 1 | 4.75 : 1 |
| difficulty pips (filled / empty) | 140.5 / 43.4 | 65.0 | — | — |

The gold sunlit cliff behind the clock reads straight through the plate, complete
with chromatic-aberration fringing, and the difficulty row lands on top of it.
Same failure class as N1, same one-line fix.

### N6 — The `+N` overflow chip collides with the last charge pip [E] — `src/ui/hud.css` (`.slot-pips` / `.pip-more`)

At 5× on `06`, the `+21` chips under M2 and Q sit directly on top of the fifth
pip, and R's `+22` overlaps a partially-drawn outlined pip. Both round-3 fixes
landed independently (the cap of 5, and the legible white-on-black `+N`) and then
collided with each other. Cosmetic, but it is the newest element in the cluster.

**Fix:** `gap` on `.slot-pips` does not apply between the `i` run and the `b`;
give `.pip-more` a `margin-left: 4px` and drop `flex-wrap` now that the cap makes
it unreachable.

### N7 — Stack counts still sit on their glyphs [E] — see D6

9 px and outlined, so legible; but `X7`/`X9`/`X11`/`X4`/`X6` all overlap glyph
strokes on the common row, contradicting `hud.css:386-389`. Lowest-cost item on
this list.

### N8 — Damage numerals composite into unreadable piles [E/G] — third round unfixed

`4 (444`, `4111`. Costs axis 8, not axis 7. Round 3's specified fix (deterministic
`fxRng` jitter plus a proximity reject that pushes a colliding spawn up the stack)
still stands unimplemented.

### N9 — Camera framing untouched [F] — `CameraRig.js:27,30,31` — third round unfixed

The largest single unclaimed score on the rubric. See §3, axis 2.

### N10 — The contact decal is invisible on dark ground [A] — `CharacterMesh.js:178-191`

A consequence of correctly fixing D5, not a regression: a pure multiply on a
luminance-30 floor can only remove 30 points, and it removes 4. The character in
`03` has no visible ground contact.

**Fix:** the shader already reasons about hue rather than value
(`vec3(0.06, 0.09, 0.16)`); take that further and let the decal's strength scale
with the floor's own luminance, so a dark floor gets a cool *chromatic* contact
rather than an imperceptible luminance one. The invariant (`<= dst` on every
channel) survives, because attenuating red hard and blue lightly is still
attenuation.

### N11 — Tougher Times and Repulsion Armor Plate near-collide [E] — `src/data/items.js` (`hex` / `shield`)

Adjacent tiles in the common row, both filled grey polygons of near-identical
area, XOR 59/494. The tightest same-tier pair that survives the D3 fix.

**Fix:** put a horizontal band or a rivet row across the shield so it is not a
bare polygon.

---

## 5. Defect counts by area

| Area | Count | IDs |
|---|---|---|
| **E** — HUD / menus / CSS / icons | **7** | N1, N2, N3, N5, N6, N7, N11 (+ N8 shared) |
| **A** — player mesh | **2** | D1 residual (one plank arm, SD 39.2), N10 |
| **G** — VFX / post | **1** | N4 |
| **F** — camera | **1** | N9 |

Zero regressions this round. Round 3 had two.

---

## 6. Commands and evidence

- `shots/manifest.json` read first: `ready: true`, `partial: false`, `errors: []`,
  `frameErrors: 0` and `newErrors: []` on all 8 shots.
- Pixel probes: headless Chromium via the repo's own Playwright, decoding each PNG
  to a canvas and reading `getImageData` (scratchpad `r4/probe.mjs` + 24 query
  scripts). No engine run; `tools/capture.mjs` untouched.
- **Inventory geometry** derived from the frame, not assumed: tier-keyline runs at
  `y 75/76`, `113/114`, `162/163`, `248/249` gave 12/2/12/2/6/3 tiles at a 38 px
  pitch with 34 px tiles at `x0 = 33 + 38i` (gold at `x0 = 274 + 38i`); rule runs
  measured by colour-matched contiguous scan.
- **D3 verification:** all 37 tiles extracted, glyph band `x0+5…x0+30` ×
  `y0+2…y0+20` thresholded to 26×19 1-bit masks, all 200 same-tier pairs XOR-ed;
  the 5 tightest rendered side by side as ASCII; the 3 named pairs cropped at 6×.
- **Contrast measurements** (`.slot-name` ×4, `.money`, clock digits, `HARD`,
  `X3.2`, objective banner, 6 toast rows, 4 menu buttons) all computed by
  splitting each element's own box into text and plate populations by percentile
  or by hue, never by eyeballing a peak.
- Magnified crops written and inspected: inventory panel 3×, each tier row 6×,
  ability cluster 5× in both `03` and `06`, toast log 4×, clock 6×, money chip 6×,
  menu buttons 3×, player 5× in both shots, left shoulder 12×, shoulder/arm 12×,
  ground under feet 7× (`03`) and 4× (`06`), damage numerals 4×, crosshair 10×.
- Silhouette key of the player in `03` rendered as a two-tone hue mask
  (`b >= r-2 && L > 26`, plus orange-accent and bright-plate terms) over
  `x 674–796, y 404–640`.
- Source read for attribution only: `hud.css`, `HUD.js`, `Icons.js`, `items.js`,
  `CharacterMesh.js`, `CameraRig.js`, `Harness.js`, `EnemyMeshes.js`,
  `RUBRIC.md`, `reviews/round3-charui.md`.
- `05-boss.png` not inspected this round; D10.3 is therefore marked NOT TESTED
  rather than claimed either way.
- No project file was modified. This report is the only file written.

## 7. Claims I checked and dropped

Listed because a critic who only reports hits is not being measured.

- **"The tier rules still overhang."** They read `29 → 488` in both round 3 and
  round 4, which looked like no change. It is not: the rows are now 12 tiles wide
  instead of wrapping, so the last tile ends at 484 and the rule ends 4 px past it.
  I measured every tile edge to confirm. **Withdrawn — D8 landed.**
- **"The arm is still detached; the 4 px gap is still there at y=470."** A
  luminance-only scan reproduces round 3's reading exactly. Sampling hex shows the
  band is `#1e1e3f` coat navy against `#422933` terrain — darker than the
  background, not equal to it, and continuous at `y = 465`. **Withdrawn.**
- **"The blob shadow is still a bright artefact."** The 86 px grey annulus that
  peaked at 165 in round 3 now reads 27 at the same pixel. Peak inside the
  footprint is the boot's own sole highlight. **Withdrawn — D5 landed.**
- **"The huge dark ellipse under the player in `06` is the blob decal gone
  wrong."** It spans ~230 px against a 105 px character;
  `CharacterMesh.js:562` scales the blob to 0.8 world units. It is the level-up
  burst's ground ring, not the contact decal. **Reattributed to N4, not charged to
  the mesh.**
- **"Chromatic aberration is being applied over the HUD layer."** Re-tested on the
  clock and toast plates, which show the strongest fringing in the set: sampled
  glyph edges on `22:01`, `$4,378`, `SUPP. SALVO` and the item counts are clean
  neutral. The fringing is the 3D layer through translucent panels. **Withdrawn
  for the second round running.**
- **"The stack badges are clipped by the tile chamfer."** Re-cropped at 6×; they
  render complete inside the tile. The remaining problem is that they overlap the
  glyph (N7), not that they are cut. **Withdrawn.**
- **"Glyphs are still cropped flush to the tile border."** Measured every glyph's
  bounding box against its tile: minimum right margin 3 px, median 8 px.
  **Withdrawn — D9 landed.**
- **"The `+N` chip is illegible."** Rasterised at threshold: `+21` and `+22` read
  unambiguously at ~8 px, white on a 4-way black outline. Only the collision with
  the last pip survives (N6). **Half withdrawn.**
- **"The XP bar is decorative."** HP fill is 60.8 % of its trough against a stated
  `760 / 1253` = 60.7 %. The bar is driven by the number. **Withdrawn.**
- **"The oldest toast at 1.86:1 is a legibility defect."** It is a deliberate age
  fade on a row that is one frame from disappearing, and the gradient across the
  six rows is monotonic (9.26 → 9.17 → 6.52 → 4.42 → 2.94 → 1.86). Intent, not
  failure. **Withdrawn.**
- **"Brainstalks and Queen's Gland draw the same glyph."** They do — and they are
  different tiers, so colour separates them, which is the design contract D3
  established. Cross-tier shape reuse is correct. **Withdrawn.**
