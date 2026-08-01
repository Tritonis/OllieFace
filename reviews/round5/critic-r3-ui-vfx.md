# PETRICHOR — Round 3 critique (round 5 loop): UI/HUD craft, VFX, post, cohesion

Domain: rubric axes **7** (UI/HUD), **6** (VFX), **9** (post), **10** (cohesion). Other axes
scored from the pixels for completeness. Round **3 of a maximum 4**.

`shots/manifest.json` read first: `seed 1337`, `ready: true`, `partial: false`, `errors: []`,
`subjectsOk: true`, `subjectFailures: []`, `clockPinned: true`,
`determinism.frameTimeouts: 0`, all 21 shots `frameErrors: 0` / `newErrors: []`.
**No crash to report.**

Provenance checked before scoring: `shots/*.png` are stamped 15:15–15:16 and HEAD
(`2a782a0`) is 15:17:04, i.e. the capture *predates* the commit by two minutes. That is
benign here — `git status` is clean and `find src tools -newermt "15:14"` returns **nothing**,
so no source file changed between the capture and the commit. The captures are of HEAD.

Every number below was produced by decoding the shipped PNGs with Pillow 12.3.0 / numpy
2.5.1 and reading pixels. `tools/capture.mjs` was not executed. No project file was modified.
This report is the only file written.

---

## 1. Axis scores — round 1 → round 2 → round 3

| Axis | 01-title | 04-combat | 06-hud | 08-explosion | 10-inventory | 15-logbook | 16-summary | 17-artifacts | 18-difficulty |
|---|---|---|---|---|---|---|---|---|---|
| 1 Lighting | 4→4→4 | 5→5→5 | 5→5→5 | 5→5→5 | 5→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | — → — → **4** |
| 2 Composition | 5→5→5 | 4→5→5 | 4→4→4 | 4→4→**5** | 4→4→4 | 3→4→4 | 3→4→4 | 4→5→5 | — → — → **4** |
| 3 Colour & grade | 7→7→7 | 6→6→6 | 7→7→7 | 6→6→**5** | 5→4→4 | 5→5→5 | 5→6→6 | 5→6→6 | — → — → **6** |
| 4 Silhouette | 6→6→6 | 6→5→**4** | 6→6→6 | 6→6→6 | 5→4→4 | 6→6→6 | 6→6→6 | 4→7→7 | — → — → **4** |
| 5 Material | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | — → — → **4** |
| **6 VFX** | 4→4→4 | 3→5→5 | 4→5→5 | 3→6→**5** | 4→4→4 | 4→4→4 | 4→4→4 | 4→4→4 | — → — → **4** |
| **7 UI/HUD** | 8→8→8 | 7→7→7 | 7→7→7 | 7→7→7 | 6→5→5 | 5→5→5 | 5→6→6 | 4→7→7 | — → — → **6** |
| 8 Readability | 8→8→8 | 6→5→**4** | 6→6→6 | 6→6→6 | 4→4→4 | 7→7→7 | 7→7→7 | 7→8→8 | — → — → **8** |
| **9 Post** | 6→6→6 | 5→5→5 | 7→7→7 | 5→6→**4** | 4→4→4 | 6→6→6 | 6→6→6 | 6→6→6 | — → — → **6** |
| **10 Cohesion** | 7→7→7 | 6→6→6 | 7→7→7 | 6→7→6 | 6→5→5 | 5→5→5 | 4→6→6 | 4→7→7 | — → — → **7** |
| **Mean** | 5.9→5.9→**5.9** | 5.2→5.3→**5.1** | 5.7→5.8→**5.8** | 5.2→5.7→**5.3** | 4.7→4.2→**4.2** | 4.9→5.0→**5.0** | 4.8→5.3→**5.3** | 4.6→5.8→**5.8** | —→—→**5.3** |

```
AXIS SCORES 01-title:       1:4 2:5 3:7 4:6 5:4 6:4 7:8 8:8 9:6 10:7
AXIS SCORES 04-combat:      1:5 2:5 3:6 4:4 5:4 6:5 7:7 8:4 9:5 10:6
AXIS SCORES 06-loaded-hud:  1:5 2:4 3:7 4:6 5:4 6:5 7:7 8:6 9:7 10:7
AXIS SCORES 08-explosion:   1:5 2:5 3:5 4:6 5:4 6:5 7:7 8:6 9:4 10:6
AXIS SCORES 10-inventory:   1:4 2:4 3:4 4:4 5:4 6:4 7:5 8:4 9:4 10:5
AXIS SCORES 15-logbook:     1:4 2:4 3:5 4:6 5:4 6:4 7:5 8:7 9:6 10:5
AXIS SCORES 16-run-summary: 1:4 2:4 3:6 4:6 5:4 6:4 7:6 8:7 9:6 10:6
AXIS SCORES 17-artifacts:   1:4 2:5 3:6 4:7 5:4 6:4 7:7 8:8 9:6 10:7
AXIS SCORES 18-difficulty:  1:4 2:4 3:6 4:4 5:4 6:4 7:6 8:8 9:6 10:7
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass needs 7+ on every axis with none below 6. Axis **5 is 4 on every
shot in the set, in all three rounds.** Axis **6 now tops out at 5** — `08-explosion` gave
back the point it earned in round 2. Axis **1 tops out at 5.** `10-inventory` is unmoved at
**4.2** and is still the worst frame in the set.

Net movement this wave across the eight shots I have scored three times: **−0.6, +0.1,
0.0** on the three shots that changed, i.e. **−0.5 total**. The wave's real wins are
elsewhere and are real: `18-difficulty` ships and is cohesive (5.3 on first scoring, above
`10`, `15` and `16`); the damage-numeral size cut and the reticle exclusion both work; the
harness *is* now deterministic and its own reported numbers are honest. None of that moves
an axis to a pass, and two of the three headline VFX claims do not survive contact with the
shipped frame.

---

## 2. Was the round-2 `10-inventory` regression real, or an artefact of the harness?

**The regression was REAL. The magnitude was noise. The direction, the cause and the defect
were all correctly photographed, and the frame has not recovered.**

This is the question I was sent to answer, so here is the whole evidence base. Viewport
`x 520–1180, y 110–780`, Rec.709 luminance, the same box the fix agent used:

| capture | mtime | build | mean L | % over L220 | mean RGB |
|---|---|---|---|---|---|
| `shots-vfx2-before/10-inventory` | 14:05 | pre-VFX-fix | **121.5** | 3.23 % | 132,120,101 |
| *(round-2 critique's own read)* | 13:37 | pre-VFX-fix | *123.0* | *2.42 %* | *135,122,98* |
| *(FIX-vfx2 §3 "before")* | — | pre-VFX-fix | *165.4* | *22.15 %* | *183,164,131* |
| `shots-vfx2-c/10-inventory` | 14:37 | mid-fix | 123.8 | 7.11 % | 139,121,105 |
| `shots-vfx2-final/10-inventory` | 14:49 | post-VFX-fix | **116.4** | 4.99 % | 124,115,104 |
| **`shots/10-inventory` (SHIPPED)** | 15:16 | post-harness-fix | **132.3** | **7.26 %** | 149,130,106 |
| `shots/06-loaded-hud` (control) | 15:16 | shipped | **63.3** | 0.51 % | 80,58,66 |

Three findings fall out of that table.

1. **My round-2 number was not an outlier.** I measured 123.0; an independent pre-fix
   capture taken 28 minutes later measures 121.5. Two samples, 1.5 L apart. What I
   photographed was the population, not its tail.

2. **The `165.4` baseline the fix was justified against is not reproducible on any capture
   on disk.** `shots-vfx2-before/` is the fix agent's own stated baseline
   (*"full 21-shot baseline captured before any of this landed"*) and it reads 121.5 / 3.23 %.
   The 165.4 / 22.15 % figure is a single draw from exactly the distribution
   `FIX-harness2.md` §2 documents as swinging 26,130 px → 1,523 px on the same seed. So the
   headline **165.4 → 116.4 (−49 L)** is a comparison between one bad draw and one good
   draw. Measured against a baseline that reproduces, the improvement is **121.5 → 116.4,
   −5.1 L**.

3. **The shipped frame is brighter than anything the fix agent measured, and brighter than
   the frame I failed in round 2.** 132.3 against a 63.3 control on the same stage and
   camera — the viewport is still at **2.09× the exposure of `06`**, and 7.26 % of it is
   over L 220, the highest figure in this table apart from the unreproducible one. The
   harness change (shutter moved to a pinned 0.1167 s, hitstop held at zero) landed after
   `shots-vfx2-final` and moved the number back up by 16 L.

So: round 2's axis cuts on `10-inventory` (1, 3, 4, 7, 10) were correctly awarded and I am
**not** withdrawing them. The score stays at 4.2 because the defect that produced it is
still in the pixels, larger than when I scored it.

What the non-determinism *did* corrupt is anyone's ability to attribute a delta. That is
now fixed and it is the wave's most valuable change — but it also means the fix agent's
own before/after table is retrospectively unusable, and this is the first round in which
a claim of the form "X → Y" can be trusted at all.

---

## 3. Claim verification

| # | Claim | Ruling | Evidence |
|---|---|---|---|
| 1 | `10-inventory` viewport **165.4 → 116.4**, % over L220 **22.15 → 4.99** | **PARTIAL (baseline refuted, after-figure verified, shipped frame refutes both)** | `shots-vfx2-final` reproduces 116.40 / 4.99 % **exactly** on my instrument — that measurement is honest. The `165.4` baseline is not reproducible: the agent's own `shots-vfx2-before` reads **121.5 / 3.23 %**. And the **shipped** frame reads **132.3 / 7.26 %**. §2. |
| 2 | `06-loaded-hud` unmoved (62.3 → 61.8) as a deliberate control | **VERIFIED** | Their capture reproduces at 61.81 / 0.49 %. Shipped reads **63.33 / 0.51 %** — 1.5 L, inside capture-to-capture drift. The control did its job. |
| 3 | Distortion **14,473 px (1.01 %) → 96,596 px (6.71 %)** displaced | **VERIFIED (probe) / NOT TRANSFERABLE (shipped)** | I re-ran the A/B myself on `shots-vfxprobe/`. At the threshold that reproduces their other three layers (`\|dL\| > 3`) I count **102,370 px** displaced, range **−135.0 … +153.8** — their range to 0.1 L. Their soft-fade figure reproduces to **1 pixel** (10,573 vs 10,575). The numbers are honest. **But the probe photographs a frame that no longer ships**: probe bright-centroid **(604, 621)**, frame mean L **62.1**; shipped **(583, 327)**, mean L **91.1**. The composition changed after the probe was taken, so "now visible" cannot be carried across. In the shipped frame I cannot find a refraction shell; what I can find at the shell's radius is a **hard-edged 2 px double line at y 317–325 running the full frame width** (688 columns ≥ +18 L over local background, runs up to 106 px) that crosses *in front of* the midground tree canopy at a constant screen y — a flat billboard read edge-on, not refraction. |
| 4a | `08-explosion` blast **5,126 → 20,635 px**, 14,444 carrying an edge | **VERIFIED (harness's own instrument)** | `manifest.shots[08].subject` — `px: 20635`, `carriedPx: 14444`, `minCarried: 1200`, `sepP50: 0.27`. Not independently reproducible without the engine's mask; I accept it as an internal metric, and note `sepP50 0.27` is the *lowest* of any solid subject in the set. |
| 4b | Centre moved out of the sky | **REFUTED** | `manifest` reports `y: 0.341` against the shot's own 0.34–0.66 band — it clears its own lower bound by **one thousandth**. In pixels the disc `r < 120` about (568, 306) spans **y 186–426**, and the local water/terrain line at that part of the frame is at **y ≈ 425–435**. The core is in the sky; only the last few pixels of the disc reach ground. |
| 4c | Survivor turned away from the sun | **REFUTED as an outcome** | Not directly resolvable from one frame, but the stated *purpose* — an additive blast reading against a dark background — is not achieved. Sky column-means at y 20–60 (≥ 240 px above the blast): **x 473 → 196.2, x 900 → 49.0**. The blast is composited on the brightest quadrant of the sky by a factor of 4. In the frame it reads as a sun, not as an explosion. |
| 5 | Damage numerals cut ~20 % with a reticle exclusion rect | **VERIFIED** | One instrument, three captures, tight gold-ink connected components grouped into runs. Pre-fix `shots-vfx2-before/10`: runs **147 / 125 / 122 px** wide at cap **20–22 px**. Post-fix `shots-vfx2-final/10`: **105 / 104 px** at cap **17–18 px** — **−29 % width, −18 % cap**. Shipped `shots/10`: 6-glyph runs **130 / 130 / 117 px** at cap **18–19 px**. The reticle exclusion also works: the crosshair at (800, 450) is **completely clear** in `10-inventory`, `06` and `08`, where round 2 measured a numeral over its top tick. Both halves of the claim hold. (The *consequences* do not — defect 5.) |
| 6a | The icon collision floor — is it still 8.04 %? | **REFUTED — it is 9.69 %, and still under the gate** | Re-measured from scratch on the shipped composite. Grid located independently (16 columns, pitch **42.75 px** from x₀ = 456; 6 rows, pitch **43.5 px** from y₀ = 477.5), **83 tiles**, tier read from each tile's own border ring: **28 white / 26 green / 15 red / 7 gold / 7 blue** — round 2's counts to the tile. Glyph band inset 5 px, bottom 9 rows dropped, resampled 34×34 = 1156 bits, all **850** same-tier pairs (round 2's pair count exactly). **FLOOR = 9.69 %**, gold `r4c6` vs `r4c11`. **One** pair remains under the project's own 10 % gate (round 2: two). Under three neighbouring crop geometries the floor reads 8.01–8.65 %, so the instrument's own spread is ±1 pt and I will not claim the 8.04 → 9.69 move is a real improvement — the shot photographs a different run with a different item multiset. |
| 6b | Is the gate still measuring the wrong thing? | **VERIFIED — unchanged** | `tools/glyphdist.mjs:44–52` still builds a fresh `34 × 34` canvas, calls `itemArt` in isolation, and takes the band `x 3–31, y 2–24` = **616 bits**. It never touches a composited tile, a tier keyline, a stack chip or the panel background. Default `--floor 10`. The shipped composite is **9.69 %** — the gate is green on a number nobody looks at, exactly as in round 2. |
| 7 | Run summary abandons tier grouping; boundaries fall mid-row four times | **VERIFIED — entirely unfixed** | Tier map read from the shipped pixels is **identical to round 2's, tile for tile**. |
| 8 | `18-difficulty`'s icons are emoji-presentation codepoints Windows renders in colour | **REFUTED — fixed** | Each icon is a **single-hue** drawn vector cloud: drizzle hue **200–204°** (cyan), rainstorm **117–122°** (green), monsoon **0–6°** (red); one hue bucket each, 53–62 chroma-bearing pixels per icon. A Segoe colour emoji cannot produce that. Verified at 4× — three drawn clouds with stroke rain and a lightning bolt, in the artifact-mark idiom. **The cohesion break I flagged in round 2 is gone.** |

```
row0  WWWWWWWWWWWWWWWW
row1  WWWWWWWWWWWW|GGGG      white -> green at column 12
row2  GGGGGGGGGGGGGGGG
row3  GGGGGG|RRRRRRRRRR      green -> red at column 6
row4  RRRRR|YYYYYYY|BBBB     red -> gold at 5, gold -> blue at 12
row5  BBB.............
```

---

## 4. Top defects, ranked (6 max)

### 1. `08-explosion` — the blast is a clipped, edgeless white bloom that reads as the sun

Round 2's complaint was the opposite (disc mean L 160.3, 3.99 % over L220, no clipped
pixels — "a large soft warm haze"). It has been driven straight past the target.

Radial profile about the manifest's own centre (568, 306):

| ring | mean L | % over L220 | ≥1 channel clipped |
|---|---|---|---|
| r 0–20 | **253.5** | 100 % | **100 %** |
| r 20–40 | 252.5 | 100 % | **100 %** |
| r 40–60 | 245.7 | 100 % | 46.8 % |
| r 60–80 | 236.1 | 99.0 % | 1.1 % |
| r 80–100 | 221.9 | 79.1 % | 2.4 % |
| r 100–120 | 214.6 | 28.2 % | 2.5 % |

Whole disc `r < 120`: **mean L 229.2, 72.66 % over L220.** Core `r < 40`: mean RGB
**(255.0, 253.6, 237.5)** — **R clipped on 100 % of pixels**, G on 22 %. Frame-wide, 6,057 px
exceed L 250 against 2,075 px in the probe frame.

The decisive number is the gradient: sampled in 4 px annuli, the **largest luminance step
anywhere in the falloff is 6.6 L**, at r = 80. There is no edge anywhere on this object. It
is a pure gaussian, so it is read as a light source, not as a body of burning gas. At 3× the
crop shows no shockwave ring, **no smoke and no dust plume** — the same absence round 2
recorded, unaddressed. Compounding it, the sky it is composited on is the brightest quadrant
of the frame (claim 4c), so even the silhouette that clipping would give it is unavailable.

**Fix, in order:** (a) cap the core's additive accumulation below clip — target ≤ 8 % of the
disc at ≥ L 250 instead of the inner 80 px at 100 %, so the core has a value range to shape
with; (b) restore the shockwave ring's alpha now that the core no longer needs to carry the
read, and give it a hard inner edge; (c) add the opacity layer — a short-lived dark
smoke/dust plume with soft-particle fade — so the effect has a silhouette instead of only
luminance; (d) require the search in `Harness.js` to place the centre **against terrain**,
not merely inside a 0.34–0.66 band it clears by 0.001.

### 2. Frame-wide radial chromatic aberration at 4–6 px, peaking near 10 px

Post-process CA on the 3D layer, measured by per-channel strongest-gradient position on
every strong vertical edge in a margin window, median over ~30–50 edges per shot:

| shot | left margin (R−B) | right margin | centre |
|---|---|---|---|
| `08-explosion` | **+6 px** (p90 +8) | **−6 px** | 0 |
| `04-combat` | +4 px | **−6 px** | 0 |
| `10-inventory` | +1 px (p90 +9) | −3 px | 0 |
| `06-loaded-hud` | 0 (p90 **+12**) | −2 px (p90 +8) | 0 |
| `02-vista` | +2 px (p90 +9) | −1 px | 0 |

A single named edge, `08-explosion` top-left rock at y 120–180: strongest gradient at
**R x=31, G x=24, B x=21** — a **10 px** R→B spread. Zero at the optical centre in every
shot, symmetric in sign left vs right: this is a deliberate radial CA, not a decode artifact.

It is not subtle and it is not serving mood. At 6× the top-left corner shows **full rainbow
fringing** on cloud edges and a rainbow-banded debris sliver; at 5× the mountain ridge and
rock texture at x 260–330 are a red/cyan speckle field. Damage numerals, which are 3D-space
particles and therefore receive the pass, carry visible red/blue fringes on their digits.
The rubric's axis-9 nine is "subtle aberration serving mood"; the reference build runs about
a pixel.

I flagged a narrower version of this in round 1 ("6 px of channel separation at y=118 in
`10-inventory`") and **withdrew it in round 2** on the evidence that R, G and B all placed
their strongest edge at x = 37. **That withdrawal was wrong and I am withdrawing the
withdrawal.** x = 37 in `10-inventory` is the money plate's chamfer — a HUD element,
composited *after* post — so I measured the one class of edge in the frame that cannot show
the defect. Re-raising it is not a loop; it is a correction to my own error, with a new
instrument and five shots of evidence.

**Fix:** scale the aberration to ≤ 1.5 px at the frame corner (roughly a 6× reduction),
sample it with three taps along the radius rather than a per-channel UV scale so it does not
alias on high-frequency rock texture, and run it **before** bloom so the fringes are not
themselves bloomed.

### 3. `10-inventory` — the equipment nova still doubles the frame's exposure, and shows its own polygon edges

Measurements and provenance in §2: viewport mean **L 132.3 against a 63.3 control**, **7.26 %
over L 220**, mean RGB 149,130,106 — still the milky yellow-green wash over terrain, water,
trees and sky alike, and still frame-wide rather than local to the effect.

New this round, at 2× on the lower-centre: the nova's screen-filling additive quads are
**showing their own straight boundaries**. Two hard diagonal edges cut across the water from
about (830, 660) to (660, 905); sampled across the boundary they are **single-pixel steps of
+54.3 L at y = 700 and −28.6 L at y = 780**. That is the rubric's axis-6 four-marker
verbatim — "flat billboard puffs, hard-clipped particle edges". The lens fade added in
`ParticleShader` ramps alpha but does not soften the quad's silhouette, so a quad that now
fades to 0.18 simply shows its outline at 0.18 instead of at 1.0.

**Fix:** (a) the light cap needs to go further — the target is the control, so cap the
equipment blast's contribution such that the viewport lands under ~85 L, not 132; (b) fade
the additive quads **radially in UV** as well as by subtense so the polygon edge is never the
alpha edge; (c) if the nova is meant to blow out, blow out *locally* — mask it to its own
radius rather than lifting the water, the trees and the far ridge with it.

### 4. `04-combat` — the near-white masses are larger and brighter than when I failed them in round 2

Connected-component scan for near-white desaturated pixels (`L > 195`, chroma `< 40`), HUD
excluded. Frame mean L 66.7.

| | round 2 (worst blob) | shipped (worst blob) |
|---|---|---|
| area | 3,737 px | **6,969 px** |
| bbox | 93 × 72 | **110 × 99** |
| mean L | 230.0 | **236.9** |
| peak L | 243.0 | 254.2 |

Second and third blobs: 4,145 px (89 × 108, mean 233.3) and 3,533 px (75 × 79, mean 238.1).
**Total near-white area 18,094 px against 17,999 px on the pre-fix capture** — statistically
unmoved. `FIX-vfx2.md` §6.1 is candid that the affix furniture is 0.5 % of this and that the
rest is enemy body material out of its scope, and its own A/B is honest. I am recording it
anyway because it is in a shot in my list and it is what costs `04-combat` axes 4 and 8: the
survivor measures **814 px** in a frame where three separate pale masses each measure four to
nine times his area at L 233–238. The rubric's axis-8 four-marker is "can't find the player";
at 1× you find him because he is the only dark thing in the pile.

**Fix (unchanged, still owned by the enemy-material brief):** clamp enemy body albedo against
the stage's own terrain luminance histogram so no monster plate can exceed ~L 190 on a frame
whose mean is 67, and pull the `combat()` camera out of the horde.

### 5. `10-inventory` — seven concurrent damage runs, two of them overlapping into an unreadable string

The size cut and the reticle exclusion both **work** (claim 5). What they have not fixed is
everything else about this layer, and the shipped frame is worse than the one I scored:

- **Runs collide.** At y 515–580 two `26407!` runs occupy x 670–962 and x 811–1175. At 3×
  they interleave into **`26407!407!`** — neither number is readable. There is no
  de-overlap rule; the concurrency gate (5 non-crit starts in 0.42 s, crits exempt) limits
  *when* runs spawn, not *where*.
- **A run is clipped by the HUD.** The run at x ≈ 300–470, y ≈ 265–300 renders **behind** the
  inventory strip; the tiles occlude the top half of every digit and what ships is a row of
  digit-bottoms hanging off the strip's lower edge. Round 2's complaint was the inverse
  (numerals *over* the strip). The z-order was corrected; the clip was not.
- **Density.** I count **five to eight** concurrent runs in the frame against round 2's four.

**Fix:** (a) a spatial reservation — reject or displace a numeral whose box intersects a live
run's box, the same mechanism the reticle rect already uses, which proves the machinery
exists; (b) clip the numeral layer out of the inventory strip's rect entirely rather than
z-ordering under it, so a half-glyph never ships; (c) merge concurrent hits on the same
target into one accumulating readout instead of spawning a run per hit.

### 6. `16-run-summary` — tier grouping still abandoned, and the collision gate still measures the wrong render

Third round of asking, and the tier map read from the shipped pixels is **identical to round
2's, tile for tile** (§3, claim 7): 83 tiles wrapped into a flat 16-column grid, so
`white → green` breaks at column 12 of row 1, `green → red` at column 6 of row 3, and row 4
carries **three tiers**. The HUD in `06` and `10` does the opposite on the same data — each
tier shrink-wrapped into its own rows under a tier-coloured rule — so the two screens
disagree about what the tier system is *for*, in one product, on one item haul.

Alongside it, the instrument question I raised in round 2 §3.5 is settled and unchanged:
`tools/glyphdist.mjs:44–52` renders `itemArt` onto a bare 34 px canvas and measures a 616-bit
band. The shipped composite measures **9.69 %** across 850 same-tier pairs, with one pair
under the tool's own `--floor 10`. The CI number and the player's number are different
numbers and only one of them has ever been green.

**Fix:** (a) render the haul as one block per tier, each shrink-wrapped to its own row run
and separated by the HUD's existing tier rule — the card has 82 % of the frame outside it, so
the height is free; (b) point `glyphdist.mjs` at a composited tile (keyline, plate tint,
stack chip and all) or accept that it is measuring a render nobody sees.

---

## 5. Below the cut — recorded, not ranked

- **`18-difficulty` photographs a different selection than it asserts.** `Harness.js:3199`
  deliberately picks the *hardest* rung — `menus.setDifficulty('monsoon')` — and the manifest
  reports `a selected rung → detail: "monsoon"`. The shipped pixels light **RAINSTORM**:
  marker mean L **80.5**, max chroma **102** (green), left accent bar L **111.0**, against
  L 27.8 / chroma 24 for MONSOON and L 28.5 / chroma 25 for DRIZZLE. The cause is
  `Harness.js:3218` — `if (before) menus.setDifficulty(before)` restores the previous rung
  **inside the scenario, before the shutter**, and the DOM repaints. This is the same
  restore-ordering bug `FIX-harness2.md` §5 fixed for the biome caption on `04-combat`, one
  screen over. The assertion cannot catch it because it only tests
  `querySelector('[data-difficulty].is-on')` — *any* lit rung passes. **Not a visual defect**
  (the frame does show a valid selected/unselected pair, which is what the shot is scored
  on), so it stays below the cut — but the manifest is describing a frame that was never
  taken.
- **`308 / 307` in `06-loaded-hud` — current HP printed above maximum — is still shipped, and
  has now spread**: `10-inventory` reads `384 / 383 +191`, where in round 2 it correctly read
  `384 / 384 +191`. Two of two gameplay HUD shots now print an impossible number.
- **`15-logbook` is byte-for-byte the same set of defects as round 1 and round 2.** The
  scrollbar column profile at x 462–499 reads
  `18×8 | 13 13 13 13 13 13 | 65 65 65 65 65 65 | 42 | 13 …` — the identical bare UA thumb,
  6 px at L 65 on an invisible L 13 track. `0 / 16 RECORDED` still sits above 11 fully
  rendered entries. `Lemurian` / `Stone Golem` still Title Case beside uppercase tabs. The
  model viewer is now 890 × 258 holding a 132 × 199 subject — **92.7 % empty**, worse than
  round 2's 88 %. Both fix agents state this file was out of scope, which is fair; it is
  still shipped and it is still the one browser default in the product.
- **`17-artifacts` and `18-difficulty` share a framing problem.** The artifact card occupies
  28 % of the frame and the difficulty card **20 %**; the rest is a near-featureless blurred
  backdrop (18-difficulty frame mean L 23.0, p99 L 73.0). Both are 4 on axis 2 for the same
  reason, and neither is close to the top-6.
- **`18-difficulty`'s three icons differ mainly by hue.** All three are the same cloud
  silhouette in a 20 px box; drizzle vs rainstorm differ by three stroke marks. Rendered
  greyscale they would be near-identical — the same failure mode as the item-glyph collision
  floor, one screen over, and the reason axis 4 is 4 there.

---

## 6. Round-2 positions I am revising

Listed because a critic who only defends its predecessor is not being measured.

- **"6 px of channel separation at y=118 in `10-inventory`" — withdrawn in round 2 as fixed.
  The withdrawal is itself withdrawn.** I measured a HUD chamfer, which is composited after
  post and cannot carry the defect. The 3D layer runs 4–6 px median and up to 10 px. Defect 2.
- **"`10-inventory` regressed 4.7 → 4.2 in round 2."** Challenged as possible sampling noise;
  **upheld** on two independent pre-fix captures 1.5 L apart, and the shipped frame is worse
  than either. §2.
- **"The blast is a large soft warm haze with no clipped pixels" (round 2, defect 4).**
  Superseded, not withdrawn — the direction reversed completely and overshot. Defect 1.
- **"`18-difficulty`'s icons are colour emoji."** Flagged unscored in round 2. **Refuted —
  they are single-hue drawn vectors.** Fixed.
- **"Two same-tier pairs sit under 10 % and both are visually distinguishable, so I am not
  raising it."** Position unchanged and now one pair; still not a ranked defect. The
  *instrument* complaint is ranked, as defect 6.
- **"Numerals are 27 px cap / 174 px wide."** My round-2 extents were measured with a loose
  `L > 205` threshold that includes the dark halo. Under a tight ink mask the same frame
  family reads 20–22 px cap / 122–147 px wide, and the shipped frame 18–19 px / 117–130 px.
  The *relative* claim (they were oversized, they are now smaller) survives; my absolute
  numbers in round 2 were inflated and I am correcting them.

Nothing in §5 of the round-1 critique was re-raised, and none of the six round-2 withdrawals
made on the grounds that the pixels were genuinely fixed (soft depth fade, debris streaking,
the x 0–32 blown column, the equipment charge row, the HUD/summary tile-system inversion,
`17-artifacts` axis 7) has been revisited.

---

## 7. Commands and evidence

- `shots/manifest.json` read first. Provenance: `ls --time-style=long-iso shots/*.png`
  (15:15–15:16) vs `git log -3 --format='%h %ci %s'` (HEAD `2a782a0`, 15:17:04) and
  `find src tools -newermt "2026-08-01 15:14"` (empty) plus `git status --porcelain` (clean).
- Pillow 12.3.0 + numpy 2.5.1 + scipy `ndimage`, decoding each PNG to RGB. All statistics
  Rec.709 luminance unless stated. Scratchpad scripts covered: viewport exposure across all
  12 `shots*/` directories; radial profile and per-channel clipping of the `08` blast;
  independent A/B of the five `shots-vfxprobe` variants with a threshold sweep to locate the
  fix agent's own cut-off; per-channel strongest-gradient chromatic-aberration measurement
  over 30–50 edges per margin per shot; tight gold-ink connected-component numeral extraction
  and run grouping across three captures; near-white desaturated blob labelling on
  `04-combat` across three captures; run-summary grid fit, per-tile tier classification by
  border hue, and the 850-pair 34×34 same-tier collision measurement under four crop
  geometries; logbook scrollbar column profile and model-box occupancy; difficulty-row marker
  and accent-bar chroma; full-width horizontal-streak extent test on `08`.
- Magnified crops inspected: `08` blast 3×, `08` top-left corner 4×, `08` ring/canopy
  intersection 5×, `10` numeral collision 3×, `10` numeral-under-strip 4×, `10` nova 2×,
  `16` item grid 4×, `18` difficulty rows 4×.
- Source read for attribution only, nothing modified: `tools/glyphdist.mjs`,
  `src/core/Harness.js` (`difficulty()` only).
- `tools/capture.mjs`, `tools/vfxprobe.mjs`, `tools/affixprobe.mjs` and `tools/glyphdist.mjs`
  were **not executed** — the shipped PNGs and the on-disk probe sets are the evidence.
  Consequence: the fix agent's *current* isolated-render collision number is unverified; I
  report the composite, which is what a player sees.
- `02`, `03`, `05`, `07`, `09`, `11`, `12`, `13-*`, `14` not scored — outside the stated
  domain and shot list. `02-vista` was decoded for the aberration measurement only.
