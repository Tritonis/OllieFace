# PETRICHOR — Round 3 critique: CHARACTER READ + HUD/UI

Critic domain: rubric axis 4 (player silhouette & form) and axis 7 (UI/HUD craft).
Shots: seed 1337, 1600×900. `shots/manifest.json` → `ready: true`, `errors: []`,
`partial: false`, every shot `frameErrors: 0`, `newErrors: []`. No crash to
report; the visual scores stand.

Every number below was measured by decoding the PNGs to a canvas and sampling
pixels (headless Chromium probes in the scratchpad), not by eye. Where I ran a
test and found no defect I say so — §6 lists what I checked and dropped.

---

## 1. Axis scores

| Axis | 03-thirdperson | 06-loaded-hud | 01-title (UI layer) |
|---|---|---|---|
| 1 Lighting & shadow | 6 | 6 | 5 |
| 2 Composition & depth | 5 | 5 | 5 |
| 3 Colour & grade | 7 | 6 | 7 |
| 4 **Silhouette & form (player)** | **6** | **5** | 7 |
| 5 Material believability | 5 | 5 | 5 |
| 6 VFX quality | 5 | 5 | 4 |
| 7 **UI/HUD craft** | **7** | **6** | **7** |
| 8 Readability under load | 7 | 5 | 8 |
| 9 Post-processing | 6 | 5 | 6 |
| 10 Cohesion | 7 | 7 | 7 |
| **Mean** | **6.1** | **5.5** | **6.1** |

(Round 2 means, same three shots: 5.0 / 3.9 / 4.6.)

```
AXIS SCORES 03: 1:6 2:5 3:7 4:6 5:5 6:5 7:7 8:7 9:6 10:7
AXIS SCORES 06: 1:6 2:5 3:6 4:5 5:5 6:5 7:6 8:5 9:5 10:7
AXIS SCORES 01: 1:5 2:5 3:7 4:7 5:5 6:4 7:7 8:8 9:6 10:7
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. My two owned
axes are 6/5/7 (silhouette) and 7/6/7 (HUD craft). Axis 7 now clears 7 in
`03-thirdperson` and `01-title` — that is a genuine first — but it does not clear
in `06-loaded-hud`, which is the shot the HUD exists to survive. Axis 4 clears
nowhere.

**This round moved a long way and I want that on the record before the defect
list.** Round 2's three *state* failures are all gone from the pixels: the level
readout is real, the boss is named, the damage numerals are upright. The item
inventory went from the single largest style break in the interface to the best
thing in it. The player went from "two stacked bells" to a survivor with a head,
a weapon, a hem and a 3.5:1 value break. Fifteen of the twenty-two round-2
defects landed fully. What follows is what is still wrong, plus one genuine
regression the fixes introduced.

---

## 2. Round-2 defect ledger

| ID | Round-2 defect | Status | Pixel evidence |
|---|---|---|---|
| U1 | Damage numerals upside-down | **LANDED** | `06` (730–860, 405–445) reads `37!` upright at 10× zoom; the `1`'s flag is top-left, base bar on the bottom. Crit `!` gold. |
| U2 | `LVL 1` + empty XP bar at 22:01 | **PARTIAL** | `06` bottom-left reads `LVL 3` with the lime bar filled to ~36% (fill ends x≈250 of a 92→478 trough). Mechanism works. But `LVL 3` at `22:00` / `$4,514` / 37 items is still an incoherent late-run state — see D2. |
| U3 | Boss bar reads literal `BOSS` | **LANDED** | `05-boss` top-centre reads **`STONE TITAN`**, sub-line `TELEPORTER BOSS`. Track is violet (`#c86ef0`-family), not gold — gold is now reserved for currency. |
| U4 | Player = two stacked bells, no head/arm/weapon read | **PARTIAL** | Head now steps out of the shoulder line and the weapon breaks the outline. Arms still float: see D1. |
| U5 | Slung carbine is a black hole (lum 1/255) | **LANDED** | Gun band (742–772, 495–520) mean **55.4** against ground **24.4**. It is now the second-brightest mass on the back and it breaks the outline at the lower right. |
| U6 | Item icons are rounded rects in an angular HUD | **LANDED** | Every tile in `06` has a chamfered top-left and bottom-right corner with a machined edge tick. Zero rounded corners in the panel. |
| U7 | Glyph fill is a random hash hue | **LANDED** | White row is uniformly grey, green row uniformly green, red row red, equipment gold. `Icons.js:333` `globalCompositeOperation='color'` takes hue+sat from the tier. — but see the **REGRESSION**, D3. |
| U8 | Stack badges outside the tile, brightest thing in the corner | **PARTIAL** | Chip is inside the tile now and no longer a solid near-white plate. But it is rendered at **~5 px cap height** and sits on top of the glyph: see D6. |
| U9 | `.inv-group` plates stretch full width | **PARTIAL** | The frosted plate and `backdrop-filter` are gone — the ~330×90 px dead slab is gone, which was the bigger half. But the tier *rule* still runs to **x=488** on the white and green rows while their last tile ends at **x≈448** — a 40 px overhang, and only on the two wrapped rows. See D8. |
| U10 | Charge pips overflow into a strip of dashed noise | **PARTIAL** | Cap of 5 landed; wrap + `max-width: 5.2em` landed; the off-pip is now a legible outlined parallelogram (round 2's 0.22-alpha ghost is fixed). The `+N` overflow label is illegible: see D7. |
| U11 | Primary slot goes to a black box with no readout | **PARTIAL** | M1 fixed and verified: icon peak **231.9** in `06` (round 2: 72), identical to its ready value in `03`. But the same hole reopened on **R**: see D4. |
| U12 | All front-facing value structure invisible from the camera | **LANDED** | Back-view value band in `03`: yoke **120.0**, head **92.3**, legs **86.8**, gun **55.4**, cloak **36.7**. Spread **83 pts** (round 2: 29). Yoke:cloak = **3.3:1**. Orange hem and centre seam are on the back and visible. |
| U13 | Head and cape are the same value | **LANDED** | Helmet mean **130.6** / peak **222.3** vs cloak **36.7** → **3.6:1**. The emissive nape lamp peaks at **231.2** and is the brightest pixel band on the model, as intended. |
| U14 | No equipment slot | *(accepted content gap — not scored)* | — |
| U15 | Objective banner contradicts the boss bar | **LANDED** | `05-boss` objective now reads `DEFEAT THE TELEPORTER BOSS`. Minor residue: the `55M` distance chip is still printed next to it (D10). |
| U16 | FOV 70° vertical (≈106° horizontal) | **NOT LANDED** | `CameraRig.js:27` still `FOV_BASE = 70`; `:30` still `DIST = 5.4`. Visible: the boulder in `03` occupies the lower-right quadrant at ~1.9× its midground-consistent size. |
| U17 | Crosshair grazes the player silhouette | **NOT LANDED** | `CameraRig.js:31` still `SHOULDER = 0.65`. Measured: player's rightmost lit pixel x=**776** (row 475); reticle west arm outer edge x=**779**. **3 px of clearance.** |
| U18 | No ground contact | **REGRESSED** | A contact decal now exists — and it renders as a **bright** ring. See D5. This is the one place round 3 is worse than round 2. |
| U19 | Pickup log is text-only | **LANDED** | All five item toasts in `06` lead with the tier-coloured item icon, and age falloff is real — the oldest row (`CEREMONIAL DAGGER`) is visibly dimmer than the newest (`QUEEN'S GLAND`). |
| U20 | Clock has ~40% dead space; `x3.2` is the dimmest text | **LANDED** | Clock plate spans x 1465–1583; `22:00` starts x≈1470, the notch row starts x≈1466. Dead space is now ~5%, down from ~40%. `X3.2` is `--ink-dim` and legible. |
| U21 | Title: skew mismatch, placeholder tagline, scale gap, invisible seed | **LANDED** | Tagline is now `THE SMELL OF RAIN ON DEAD GROUND` (peak 194.2, cyan). `SEED 1337` peak **165** over a 24 plate — was near the detection floor. Wordmark 630 px vs button column 390 px = **1.6:1** (was 2.7:1). `--skew` token is used by `.title-word`, `.title-rule` and `.mbtn` (`hud.css:1101, 1125, 1247`). |
| U22 | Title scrim crushes the frame to 9% grey | **PARTIAL** | Whole-frame mean **34.5/255**, up from 23.5 — but the stated target was 45–55 and the bottom band (y 680–900) still sits at **25.8**. **Menu legibility was NOT cost**, which is the thing I was asked to check: button plate mean **15.5**, button text peak **240.1** — a ~13:1 contrast, unchanged in quality from round 2. |

**Score: 15 LANDED · 6 PARTIAL · 2 NOT LANDED · 1 REGRESSED · 1 accepted gap.**

---

## 3. Verification of the specific claims I was handed

| Claim | Verdict |
|---|---|
| "HUD shows a real level and a partially-filled XP bar in 06" | **TRUE.** `LVL 3`, bar at ~36%, plus a `LEVEL 3` toast in the log. |
| "2600 XP → LVL 21, 770 HP, 60 dmg" | **FALSE in the shipped shot.** `06` reads `LVL 3` and `350 / 692`. `Harness.js:536-550` (`lateRun`) sets `ctx.time = 22*60`, gives 37 items and 4200 gold, and **never calls `addExperience`** — so the level in the beauty shot is only whatever incidental kills the preceding captures produced. The system is right; the shot is not. (D2.) |
| "Boss track given its own violet so gold stays reserved for currency" | **TRUE.** Verified in `05-boss`. |
| "`Icons.itemArt` overscan fixed; shape carries identity, colour carries tier" | **HALF TRUE.** The plate/stroke fix landed and the tier recolour landed. `ART_OVERSCAN` is still **1.3** at `Icons.js:311` — it is now load-bearing (it is how the rounded source plate is pushed off the clip), but it also crops the wider glyphs into the tile border. (D9.) |
| "U8 stack badge moved inside the tile" | **TRUE**, but the badge is now 5 px tall. (D6.) |
| "U9 `.inv-group` to `max-content`" | **PRESENT IN CSS, INEFFECTIVE.** `hud.css:328-330` sets `width: max-content; max-width: 100%`, but on a `flex-wrap: wrap` group `max-content` resolves to the *unwrapped* width, which clamps to `max-width` — so a wrapped group is exactly the container width. (D8.) |
| "U10 pip cap of 5 with `+N`" | **TRUE**, but `+N` is illegible. (D7.) |
| "U11 cooldown sweep 0.82→0.55, no sweep under 0.75s" | **TRUE in CSS, wrong threshold.** (D4.) |
| "U19 toasts lead with the icon" | **TRUE**, with age falloff as a bonus. |
| "U20/U21/U22 menu typography, shear token, wordmark cap" | **TRUE.** |
| "Cape rebuilt, cloak darkened, helmet enlarged with a head/neck notch, nape lamp, sling canted, gun metalness 0.45, Fresnel rim" | **TRUE except the notch.** All measured above. The head *steps* out of the shoulder line but there is no negative-space notch — the helmet's lower edge and the yoke's upper edge are contiguous. |
| "Per-player blob shadow" | **EXISTS AND IS BACKWARDS.** (D5.) |
| "Title scrim lift did not cost menu legibility" | **CONFIRMED — no defect.** |

---

## 4. Ranked new defect list

Ranked by rubric cost. **A** = player mesh (`CharacterMesh`), **E** = HUD / menus /
icons / CSS, **F** = camera framing (`CameraRig`, `Harness`).

---

### D1 — The arms are still detached slabs with a hole between them and the torso [AREA A] — `src/entities/CharacterMesh.js` (shoulder pivot / arm boxes)

**Pixels.** `03-thirdperson.png`, luminance scan along row **y = 470**, x 740→789:

```
x   740 742 744 746 748 750 752 754 756 758 760 762 764 766 768 770 772
L   150 151 150 152  77  24  33  60  59  62  60  92 146 147 148 168  29
```

The torso ends at **x = 747**. From **748 to 751** the luminance drops to **23–24**
— which is the terrain background value, measured independently at `meanBox(600,600,660,640) = 24.4`.
Then the arm resumes at 752 and peaks at 168.

**There is a 4-pixel-wide window of pure background between the torso and the
right arm.** In a pure-black silhouette test the arm is a floating rectangle. I
rendered the region as a two-tone key (`lum > 58 || B > R`) and confirmed it: the
shoulder band reads as one continuous horizontal bar from the left frame edge to
x≈782 with a detached lozenge on its right end, and no arm articulation anywhere
in the outline. Round-2's U4 said exactly this and it is unchanged.

The left shoulder is worse. Region (676–706, 418–500) measures mean **66.4** with
standard deviation **50.7** — a variance of **76% of the mean** inside a 30×82 px
patch. That is six competing shapes (sling stock, pauldron, canister, orange chip,
cyan trim, spine rail) in an area 30 px wide. At 1:1 it is not a shoulder, it is
static.

**Fix.** (a) Push the shoulder pivot outboard until the upper arm overlaps the
torso silhouette by ≥3 px instead of clearing it by 4 — the arm must be *attached*
in outline, then read as separate by value, not by a gap. (b) Delete or merge the
left-shoulder props: keep the sling stock and one pauldron plane, remove the
canister, the orange chip and the cyan trim rail. Target: the same SD probe under
25. The test to run: key the player to pure black at 240 px tall and confirm that
head, both shoulders, one arm, the weapon and the leg gap are each separable.

---

### D2 — The "late-run HUD" shot ships `LVL 3` at 22:00 with 37 items and $4,514 [AREA E] — `src/core/Harness.js:536-550`

**Pixels.** `06-loaded-hud.png` bottom-left: `350 / 692`, `LVL 3`, XP bar ~36%.
Same frame: `22:00`, `HARD X3.2`, `$4,514`, 37 stacked item tiles.

The level system is real and correct — that is round 2's top defect properly
fixed, and I want that credited. The problem is that the one shot whose entire
purpose is "late-run HUD with a full inventory and high difficulty" still shows a
level a player would hit in the first ninety seconds. `lateRun()` fast-forwards
the clock, hands out items and hands out gold, but never awards XP, so the
displayed level is an artefact of whatever the preceding captures happened to
kill. An RoR2 player reads `LVL 3 · 22:00 · 37 items` as a broken HUD whether or
not the code is right.

`Progression.js:44` `xpForLevel = 5·level^1.35` is a per-level cost, so
Σ(1..19) ≈ **2 290 XP** reaches level 20. That matches the claimed 2600 → ~21.

**Fix.** One line in `Harness.js:540`, next to the existing `ctx.time` and
`addGold` seeds: `ctx.progression?.addExperience?.(2600)`. Then re-verify that the
health readout moves off 692 and that the bar lands partially filled rather than
at a level boundary.

---

### D3 — REGRESSION: making colour carry tier exposed seven items that draw an identical glyph inside their own tier [AREA E] — `src/data/items.js:570-571`, `:599`, `:632`

**Pixels.** In `06-loaded-hud.png`, white tier row 1 position 7 (x 258–291,
y 72–105) and white tier row 2 position 3 (x 108–141, y 112–145) are **the same
picture**: an identical filled mid-grey plus, same stroke weight, same plate
gradient, same chamfer. The only difference in the two tiles is the stack count
(`x7` vs `x8`). I cropped both at 20× and compared — they are indistinguishable.
Those are **Crowbar** (`items.js:112`, `glyph: 'cross'`) and **Medkit**
(`items.js:193`, `glyph: 'plus'`).

The cause is a shared switch case:

- `items.js:570` — `case 'plus': case 'cross':` → **crowbar ≡ medkit** (both common)
- `items.js:599` — `case 'blade': case 'scythe':` → **tri-tip ≡ harvester's-scythe** (both uncommon)
- `items.js:632` — `case 'wing': case 'feather': case 'plume':` → **afterburner ≡ wax-quail ≡ hopoo-feather** (all three uncommon)

That last one is visible without zooming: the green row's final three tiles in
`06` are three virtually identical vertical feathers.

**Why this is a regression and not a pre-existing bug.** Round 2's critic tested
this exact claim and correctly withdrew it, because at the time `hashHue(item.id)`
gave every item its own fill — two items sharing a shape still read as two items.
U7's fix replaced that hue with a tier-uniform composite. Shape is now the *only*
identity channel, and seven items no longer have a unique one. The fix was right;
it just landed without auditing what it made load-bearing.

**Fix.** Split the shared cases in `drawGlyph`. `cross` gets a diagonal X or an
offset pry-bar; `scythe` gets a curved blade with a haft; `feather` and `plume`
need a barb count or a spine offset that survives at 33 px. Then assert at boot:
render all 37 glyphs at 33 px and reject any two within the same tier whose
1-bit masks differ by fewer than N pixels.

---

### D4 — The ultimate slot goes to 40% brightness with no numeral, for its entire cooldown [AREA E] — `src/ui/HUD.js:535` + `:543`

**Pixels.** `06-loaded-hud.png`, R slot icon box (1511–1566, 765–820): peak
luminance **93.5**, mean **28.8**. The same box in `03-thirdperson.png` (R ready):
peak **232.1**, mean **55.4**. The slot loses **60% of its peak value**, there is
no numeral over it, and the `.slot-sweep` bottom rule is sitting at ~98% of the
tile height — so this is a *nearly full* cooldown, not a nearly finished one.

This is round-2's U11 reproduced on a different slot. The two guards do not line
up:

- `HUD.js:535` — sweep is gated on `a.cd >= SWEEP_MIN_CD` (0.75 s), i.e. on the
  ability's **total** cooldown.
- `HUD.js:543` — the numeral is gated on `a.rem >= 1`, i.e. on the **remaining**
  time.

For any ability whose total cooldown falls in roughly `[0.75 s, 1.3 s]` — which is
precisely what a loaded run's stacked cooldown items produce — the two windows
never overlap. The tile is swept for its whole cooldown and the numeral never
appears once. The CSS comment at `hud.css:797-799` claims "the icon stays
identifiable underneath it"; the measurement says it renders at 93/255.

**Fix.** Gate both on the same quantity. Either suppress the sweep whenever no
numeral will show (`const sweeping = a.rem >= 1`) or print one decimal below one
second (`a.rem >= 0.2 ? a.rem.toFixed(1) : ''`). The invariant to hold: *a
darkened slot always carries a readout.*

---

### D5 — REGRESSION: the contact "shadow" renders as a bright ring 3.3× the ground value [AREA A] — `src/entities/CharacterMesh.js:144-154` (`BLOB_FRAG`), specifically `:151` and `:153`

**Pixels.** `03-thirdperson.png`, luminance grid under the feet. Reference ground,
sampled twice away from the player: **24** and **24**.

```
y\x  676  700  712  724  736  748  760  772  784
636   22   21   17   19   19   44   77   70   24
640   23   46   43   48   66   80   75   35   25
644   25   77   77   78   80   72   33   35   23
648   23   57   61   60   44   26   24   24   23
652   27   20   17   17   18   16   19   16   18
```

Peak inside the blob footprint: **165** at (740, 638). Sampled hex at (700,644)
`#4f4e58`, at (720,644) `#504b57` — a neutral blue-grey against a `#201524`
maroon ground. That is `vec3(0.30, 0.34, 0.42)` from `BLOB_FRAG:153` verbatim.

So the thing that is supposed to plant the survivor on the rock is, in the
pixels, **an 86-px-wide grey annulus three and a half times brighter than the
floor it sits on**, offset up-and-right of the boots, reading as a dust puff or a
render artefact. The subtractive core does exist — 12–19 against 24 — but a 5-to-12
point darkening on a 24-value floor is invisible, so the only part of the decal
the player ever sees is the halo. The shader comment at `:138-140` states the
intent ("the ring lifts the floor around the feet instead"); the intent is what
is wrong.

Round 2 scored "no ground contact" as a defect. Round 3 has ground contact that
is *inverted*, and it is the brightest object on the ground plane in the lower
half of the frame — it pulls the eye off the character it was added to anchor.
That is a worse frame than round 2's.

**Fix.** Make the decal purely subtractive and let the lighting critic's ambient
floor carry the visibility:
`gl_FragColor = vec4(vec3(0.0), (core * 0.55 + ring * 0.08) * uFade);`
If a rim is still wanted for crushed-black terrain, cap it at
`vec3(0.10,0.12,0.16) * ring * 0.35`. The acceptance test is one line of the probe
above: **no pixel inside the blob footprint may exceed the surrounding ground
luminance.** Also recentre it — the ring's centroid measures x≈735 against a foot
centroid of x≈726.

---

### D6 — Stack counts are rendered at ~5 px cap height, on top of the glyph [AREA E] — `src/ui/hud.css:370-383`

**Pixels.** `06-loaded-hud.png`. Item tiles measure **33 × 33 px**. The `x8` chip
on the Medkit tile (x 108–141) spans **y 133–138** — a **5-pixel** cap height.
Cropped at 16× and 20× it resolves to a black-and-white checkerboard; at 1:1 it is
a smudge. Every one of the 30 chips in the frame is at this size. The chip also
sits directly over the glyph — `x10` lands on the Roll-of-Pennies ring, `x8` on
the Leeching-Seed drop, `x10` on the shield — so the two pieces of information
fight for the same 12×8 px.

`.item-stack { font-size: 0.7em }` against a `.item` of `2.6em` (≈12.7 px root)
gives an ~8.9 px font, ~5.5 px caps. RoR2's stack counts sit at 10–12 px.

This is a real improvement over round 2 — the near-white gutter chips are gone and
they no longer out-value the icons. It is now the opposite failure.

**Fix.** Raise `.item-stack` to `0.95em` and give it a home instead of an overlap:
extend the tile's bottom-right chamfer into a dedicated 12×9 px count shelf in
`platePath` (`Icons.js`), so the glyph is drawn inside a 33×24 safe area and the
count owns the shelf. Keep the 1 px black outline.

---

### D7 — Ability name labels are invisible over bright terrain; the `+N` pip overflow is unreadable [AREA E] — `src/ui/hud.css:856-859` (`.slot-name`), `:890-897` (`.pip-more`), `:753` (`.abilities`)

**Pixels.** `06-loaded-hud.png`, the ability cluster sits over the pale snow
ripple. Measured text peak vs local background:

| label | text peak | local bg | contrast |
|---|---|---|---|
| `DOUBLE TAP` | 219.1 | 194.6 | **1.29 : 1** |
| `PHASE ROUND` | 200.6 | 191.7 | **1.07 : 1** |
| `SUPP. SALVO` | 180.1 | 176.7 | **1.02 : 1** |

`SUPP. SALVO` is mathematically gone. The cause is structural: `.slot-name` is
`color: var(--ink-dim)` = `#97a7ba` (luminance 165) with **no plate, no scrim and
no text-shadow**, and `.abilities` (`hud.css:753`) has no background of its own —
unlike `.money`, `.clock`, `.log` and `.objective`, which all carry plates. Over a
dark stage the labels are fine (verified in `03`, where they read cleanly); over
snow, sand or sky they cease to exist. A HUD element must be legible over every
background the game can put behind it.

Same region, the `+N` overflow chip after the five pips: glyph pixels measure
86–165 against a 176–185 background, at ~8 px tall. Most of the glyph body sits at
140–165, i.e. ~1.2:1. At 8× zoom I cannot read whether it says `+2` or `+22`.

**Fix.** (a) Give `.abilities` the same treatment the other four zones already
have — either a `linear-gradient(transparent, rgba(4,7,12,0.55))` scrim behind the
cluster, or `text-shadow: 0 1px 0 #000, 0 0 6px rgba(0,0,0,0.9)` on `.slot-name`
and `.pip-more`. (b) Raise `.pip-more` from `0.62em` to `0.85em` and set it to
`#fff` on a black outline; at 2 characters it costs nothing.

---

### D8 — Tier rules overhang their content by 40 px on the two wrapped rows [AREA E] — `src/ui/hud.css:328-330`

**Pixels.** `06-loaded-hud.png`. The white rule (`#e6ecf4`, row y=69) spans
**x 29 → 488**; the white group's last tile ends at **x ≈ 448**. The green rule
(`#63e06a`, row y=156) spans **x 29 → 488**; its last tile ends at **x ≈ 444**. The
red and gold groups shrink-wrap correctly (rule ends ~6 px past the last tile).

So the panel still shows four rules of four different lengths, two of which are
content-derived and two of which are container-derived, and the ragged right edge
round 2 complained about is still there — just without the frosted slab behind it,
which was the larger half of the problem.

`width: max-content` on a `flex-wrap: wrap` container resolves to the *unwrapped*
width of all 14 children, which then clamps to `max-width: 100%`. The group is
therefore always exactly the container width whenever it wraps.

**Fix.** Stop wrapping inside the group. In `HUD.js`, chunk each tier into
explicit rows of N tiles and emit one non-wrapping `.inv-row` per chunk with its
own `width: max-content` — then `max-content` is the true content width and the
rule ends where the icons do. (Alternatively keep one row per tier and let
`.inventory` scroll, which is what RoR2 does with a long strip.)

---

### D9 — The 1.3× overscan crops wide glyphs flush into the tile border [AREA E] — `src/ui/Icons.js:311`, `:326`

**Pixels.** `06-loaded-hud.png`, green tier row 1 position 4 (Stun Grenade,
`glyph: 'burst'`, x ≈ 143–176): the eight spokes run into the tile's left and
right edges and are cut off square, with zero margin. Position 5 (Runald's Band,
`snowflake`) does the same. White row 1 position 1 (Soldier's Syringe, `bars`)
has its three bars touching both the top and bottom edges. Meanwhile the bolt,
spiral and shield glyphs sit with generous margin. Nine of the 37 glyphs draw to
`r * 1.1` or `r * 2` and blow through the frame; the rest do not.

The overscan is deliberate and it is doing real work — it is how `items.js`'s
rounded plate and rounded stroke are pushed outside the `platePath` clip, which is
what made U6 possible. But it scales the glyph too, and the glyph is the thing the
whole design now hangs on.

**Fix.** Export `drawGlyph` from `items.js` and have `Icons.itemArt` call it
directly onto the already-clipped, already-plated canvas at `r = s * 0.30`. Then
`ART_OVERSCAN` can go to 1.0 and no glyph is ever clipped. If that is too invasive,
drop `ART_OVERSCAN` to **1.12** and raise `PLATE_CUT` slightly to compensate — the
source's rounded plate radius is `s*0.14`, so 1.12 is still enough to clear it.

---

### D10 — Damage numerals stack into unreadable composites; camera framing unchanged [AREA E / AREA F]

Three smaller items, grouped because each is cheap:

1. **Numeral pile-up [E].** `06-loaded-hud.png` at (750–890, 470–505) shows three
   or four separate numbers rendered at the same screen position, compositing into
   `1 1160008!`. The same happens at (245–320, 480) → `333 3` and at (330–410,
   520) → `56 162`. Individually each glyph is now correctly oriented (U1 is
   fixed) — they simply have no screen-space separation. **Fix:** on spawn, offset
   each number by a small deterministic jitter derived from `fxRng` *and* reject a
   spawn position within N px of a live number, pushing it up the stack instead.

2. **Camera untouched [F].** `CameraRig.js:27` `FOV_BASE = 70`, `:30` `DIST = 5.4`,
   `:31` `SHOULDER = 0.65` — all identical to round 2. Consequences measured
   above: 3 px of clearance between the player's right arm (x=776) and the
   crosshair's west arm (x=779), and a foreground boulder in `03` filling the
   lower-right quadrant at wide-angle scale. Round 2's fix (`FOV_BASE = 55`,
   `DIST ≈ 7.0`, `SHOULDER ≈ 1.0`) still stands unimplemented.

3. **Stale `55M` next to a boss objective [E].** `05-boss.png`: the banner now
   correctly reads `DEFEAT THE TELEPORTER BOSS` — but the cyan `55M` distance chip
   is still printed after it. Distance-to-teleporter is meaningless once the boss
   is live and the player is standing in the ring. **Fix:** hide the distance chip
   while `progression.bossAlive`.

---

### D11 — Title: four menu entries with identical visual weight, and a 5 px focus tick [AREA E] — `src/ui/hud.css:1150-1190`

**Pixels.** `01-title.png`: `PLAY`, `CO-OP`, `SETTINGS` and `QUIT` are rendered at
identical plate value (mean 15.5), identical text peak (240), identical size and
identical chamfer. The only thing distinguishing the default action from the
destructive one is a **cyan wedge roughly 5 × 7 px** at PLAY's lower-left corner.
Each plate is 390 px wide with text ending at ~100 px — **74% of every button is
empty**. The whole interactive column occupies 390 × 210 px in a 1600 × 900 frame,
with a 220 px dead band beneath it measuring mean **25.8**.

The scrim work landed and legibility is excellent. What is missing is hierarchy:
the first frame of the game does not tell you where to click.

**Fix.** Promote the focused entry — 1 px cyan left rule at full plate height plus
a `rgba(120,200,255,0.10)` plate wash, and a right-aligned `▶` or `ENTER` glyph in
the plate's dead 74%. Demote `QUIT` to `--ink-dim`. Give the empty right half of
each plate a purpose (a one-line subtitle: `PLAY — begin a run`, `CO-OP — host or
join`).

---

## 5. Defect counts by area

| Area | Count | IDs |
|---|---|---|
| **A** — player mesh / silhouette (`CharacterMesh.js`) | **2** | D1, **D5 (regression)** |
| **E** — HUD, menus, icons, CSS, harness state | **8** | D2, **D3 (regression)**, D4, D6, D7, D8, D9, D11 (+ D10.1, D10.3) |
| **F** — camera framing (`CameraRig.js`) | **1** | D10.2 |

**Two regressions**, both introduced by otherwise-correct round-2 fixes:
**D5** (the new contact decal renders as a bright halo) and **D3** (tier-uniform
colour removed the only thing separating seven duplicate glyph shapes).

---

## 6. Axes: what clears 7 and what does not

**Clears 7 now:**

- **Axis 7 (UI/HUD craft)** in `03-thirdperson` and `01-title`. The angular
  language is complete and consistent, the clock is a tight instrument, the item
  panel is dense and tier-legible, the toast log leads with art and ages, the
  menu has real typography and a real tagline. This is the first round it has
  cleared anywhere.
- **Axis 8 (readability)** in `03` and `01`. Menu contrast is ~13:1; the gameplay
  HUD over dark terrain is clean.
- **Axis 3 (colour)** in `03` and `01`. Gold is now reserved for currency, the
  boss track has its own violet, item tiers own their hues.
- **Axis 10 (cohesion)** in all three. Menu and HUD share one shear token; the
  character reads as belonging to the stage.
- **Axis 4** in `01` only, and that is the wordmark, not the character.

**Does not clear 7:**

- **Axis 4 (player silhouette)** — 6 / 5 / —. Blocked by D1 (arms detached by a
  measured 4 px of background; left shoulder SD 50.7) and D5 (the bright contact
  ring). The value work is done and is genuinely good; the outline work is not.
- **Axis 7 in `06-loaded-hud`** — 6. Blocked by D7 (ability labels at 1.02:1),
  D4 (ultimate at 40% with no readout), D6 (5 px counts), D3 (duplicate glyphs).
  Every one of these is a *legibility-over-a-real-background* failure rather than
  a taste failure, which is a much better class of problem than round 2 had.
- **Axis 2 (composition)** — 5 everywhere. Owned by camera (`FOV_BASE = 70`,
  `SHOULDER = 0.65`, both unchanged) and by the title's 46%-of-frame content box.
- **Axis 5 (material)** — 5 everywhere. Flat-shaded matte across cloth, plate and
  metal; the gun fix raised its value but not its roughness contrast.
- **Axis 9 (post)** in `06` — 5. Chromatic aberration is at full strength over the
  frame, and the level-up ring blows the player's legs to clipping.

**Highest-leverage three fixes for round 4, in order:** D5 (one shader line,
removes a regression and fixes ground contact), D7 (one scrim, raises axis 7 and
axis 8 in `06` together), D1 (shoulder pivot outboard + delete the left-shoulder
props, which is the last thing keeping axis 4 under 7).

---

## 7. Commands and evidence

- `shots/manifest.json` read first: `ready: true`, `partial: false`, `errors: []`,
  0 frame errors on all 8 shots.
- PNG pixel probes via headless Chromium `getImageData` (scratchpad `r3/px.mjs`,
  `r3/crop.mjs`, `r3/sil.mjs`): player bounding box and value bands; the y=470 arm
  row scan; the 9×5 blob luminance grid plus hex samples; ability-label peak/bg
  pairs; slot icon peak/mean in both `03` and `06`; inventory tier-rule runs at
  y=69 and y=156; `+N` glyph raster dump; whole-frame and per-third means on
  `01-title`; UI bright-box extents.
- Magnified crops (4×–20×) written for: inventory white/green/red groups, a single
  badge at 16×, the Crowbar and Medkit tiles at 20× side by side, the R slot at
  10×, the pip row at 8×, the toast log at 4×, the clock at 6×, the player at 5×,
  the ground under the feet at 8×, the menu buttons at 3×, damage numerals at 10×.
- Two-tone silhouette key of the player region (`lum > 58 || B > R`) to run the
  black-silhouette test.
- Source read: `HUD.js`, `hud.css`, `Menus.js`, `Icons.js`, `items.js`,
  `CharacterMesh.js`, `CameraRig.js`, `Harness.js`, `Progression.js`, `Player.js`,
  `Enemy.js`, `CONTRACTS.md`, `RUBRIC.md`, `reviews/round2-charui.md`.
- `05-boss.png` was inspected solely to verify U3 and U15 (the boss bar is absent
  from `06`); it is not scored here.
- No project files were modified. `tools/capture.mjs` was not run.

## 8. Claims I checked and dropped

Listed because a critic who only reports hits is not being measured.

- **"The title scrim lift cost menu legibility."** This is what I was asked to
  check hardest. Button plate mean **15.5**, button text peak **240.1**, tagline
  peak **194.2**, seed peak **165** over a 24 plate. Nothing on the menu got
  harder to read; the seed line got substantially easier. **No defect.**
- **"The stack badge is clipped by the tile's bottom-right chamfer."** It looked
  that way at 16×. Re-cropped the green tier's second row at 12× with headroom:
  the badges render complete, inside the tile, with the plate intact. The badge
  problem is size (D6), not clipping. **Withdrawn.**
- **"Chromatic aberration is being applied over the HUD layer."** The fringing
  around the toast plates and the clock is the 3D layer showing through
  translucent panels; sampled glyph edges on `QUEEN'S GLAND`, `22:00` and the
  item tiles are clean neutral. The HUD is a DOM overlay and is not in the pass.
  **Withdrawn.**
- **"The white and green tier groups still have a translucent backing plate."**
  Sampled between tiles in both groups: the background terrain reads through at
  full value with no blur and no darkening. `background` and `backdrop-filter`
  really are gone from `.inv-group`. Only the rule width is wrong (D8).
  **Half withdrawn.**
- **"M1 is still blacked out."** Peak **231.9** in `06`, identical to `03`. Round
  2's headline HUD measurement is properly fixed. **No defect.**
- **"The boss bar is stuck / the boss name is still a placeholder."** `05-boss`
  reads `STONE TITAN` in violet. **No defect.**
- **"The XP bar is a decorative element with no backing state."** `LVL 3`, a 36%
  fill, and a matching `LEVEL 3` entry in the toast log — three independent
  readouts of the same live number. The system is real. Only the harness seed is
  missing (D2). **Reclassified, not withdrawn.**
- **"The player's legs don't separate."** They do — there is a clean vertical
  background gap between the boots in both the raw crop and the silhouette key.
  Round 2 did not claim this; I tested it and it holds. **No defect.**
