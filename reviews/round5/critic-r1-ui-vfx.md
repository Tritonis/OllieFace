# PETRICHOR — Round 5 critique: UI/HUD craft, VFX, post-processing, cohesion

Critic domain: rubric axes **7** (UI/HUD craft), **6** (VFX quality), **9** (post-processing),
**10** (cohesion). Axes 1–5 and 8 are scored from the pixels for completeness and marked
out-of-domain where they drive a verdict.

`shots/manifest.json` read first: `ready: true`, `partial: false`, `errors: []`, and all
**18** shots carry `frameErrors: 0` / `newErrors: []`. **No crash to report; the visual
scores stand.**

Every number below was measured by decoding the shipped PNGs with Pillow and reading
pixels. `tools/capture.mjs` was not executed. No project file was modified; this report is
the only file written. Source was read for attribution only.

---

## 1. Axis scores

| Axis | 01-title | 04-combat | 06-loaded-hud | 08-explosion | 10-inventory | 15-logbook | 16-run-summary | 17-artifacts |
|---|---|---|---|---|---|---|---|---|
| 1 Lighting & shadow | 4 | 5 | 5 | 5 | 5 | 4 | 4 | 4 |
| 2 Composition & depth | 5 | 4 | 4 | 4 | 4 | 3 | 3 | 4 |
| 3 Colour & grade | 7 | 6 | 7 | 6 | 5 | 5 | 5 | 5 |
| 4 Silhouette & form | 6 | 6 | 6 | 6 | 5 | 6 | 6 | 4 |
| 5 Material believability | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| 6 **VFX quality** | **4** | **3** | **4** | **3** | **4** | **4** | **4** | **4** |
| 7 **UI/HUD craft** | **8** | **7** | **7** | **7** | **6** | **5** | **5** | **4** |
| 8 Readability under load | 8 | 6 | 6 | 6 | 4 | 7 | 7 | 7 |
| 9 **Post-processing** | **6** | **5** | **7** | **5** | **4** | **6** | **6** | **6** |
| 10 **Cohesion** | **7** | **6** | **7** | **6** | **6** | **5** | **4** | **4** |
| **Mean** | **5.9** | **5.2** | **5.7** | **5.2** | **4.7** | **4.9** | **4.8** | **4.6** |

```
AXIS SCORES 01-title:       1:4 2:5 3:7 4:6 5:4 6:4 7:8 8:8 9:6 10:7
AXIS SCORES 04-combat:      1:5 2:4 3:6 4:6 5:4 6:3 7:7 8:6 9:5 10:6
AXIS SCORES 06-loaded-hud:  1:5 2:4 3:7 4:6 5:4 6:4 7:7 8:6 9:7 10:7
AXIS SCORES 08-explosion:   1:5 2:4 3:6 4:6 5:4 6:3 7:7 8:6 9:5 10:6
AXIS SCORES 10-inventory:   1:5 2:4 3:5 4:5 5:4 6:4 7:6 8:4 9:4 10:6
AXIS SCORES 15-logbook:     1:4 2:3 3:5 4:6 5:4 6:4 7:5 8:7 9:6 10:5
AXIS SCORES 16-run-summary: 1:4 2:3 3:5 4:6 5:4 6:4 7:5 8:7 9:6 10:4
AXIS SCORES 17-artifacts:   1:4 2:4 3:5 4:4 5:4 6:4 7:4 8:7 9:6 10:4
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Axis 6 never reaches
5 in any shot. Axis 7 — the game's strongest axis going in — falls to **4** on
`17-artifacts` and **5** on the logbook and run summary.

---

## 2. Direct answers to the six questions

**1. Do the new screens share one visual identity with the HUD?**
**No. A second idiom shipped, and on `17-artifacts` a third.**
`14-survivor-select` is the exception and is genuinely cohesive — it reuses the HUD's key
chips, its authored ability glyphs, its shear and its accent system. The logbook, the run
summary and the artifact screen do not. Elements that read as default web controls:
- **A bare user-agent scrollbar.** `hud.css:2095-2096` styles only the thumb
  (`::-webkit-scrollbar { width: 6px }`, thumb `rgba(148,182,214,0.35)`). Measured in
  `15-logbook`: a 6 px column at **x 476–481, thumb y 330–626, flat L=70.4**, on an
  invisible track. No shear, no chamfer, no accent — the one Chrome default in the product.
- **Two casing systems inside one panel.** `.tabbtn` (`hud.css:2072`) is
  `text-transform: uppercase`; `.book-row-name` (`hud.css:2117`) and `.art-name`
  (`hud.css:2010`) have none. So `SURVIVORS / ITEMS / MONSTERS` and `HEALTH / DAMAGE`
  sit beside `Lemurian`, `Blind Pest`, `Artifact of the Edict` in Title Case, plus an
  italic mixed-case description line — three treatments in one card.
- **A plain bordered 3×3 HTML table** on `16-run-summary` (`SURVIVOR|DIFFICULTY|ARTIFACTS`
  over `TIME|STAGES|LEVEL` over `KILLS|DAMAGE|ITEMS`): 1 px grey rules, square corners, no
  shear, no chamfer, no tier colour. Nothing marks it as this game's.
- **The tier grouping is abandoned.** Round 4's D8 gave the HUD shrink-wrapped tier rows
  with coloured rules. The summary grid is one continuous 16-wide wrap: tier boundaries
  fall **mid-row four times** (white→green at row 2 col 12, green→red at row 4 col 6,
  red→gold at row 5 col 5, gold→cyan at row 5 col 11), with no rules and no gaps.
- **The tile system is inverted between the two screens.** HUD: tier-coloured *plate*,
  white glyph, white outlined count. Summary: near-black plate, tier-coloured *glyph*, and
  the count on a solid tier-coloured chip. Same 95 icons, two mutually exclusive rules for
  what the tier colour means. That is the cohesion failure, stated exactly.

**2. Is the 95-glyph icon set cohesive, and legible at HUD size?**
**Cohesive as drawing — yes. As an identity system — it regressed.** One hand is clearly
visible: consistent ~2 px white stroke, consistent optical weight, consistent centring,
consistent chamfered tile. That is a real achievement across 95 glyphs and it is why axis
7 does not fall below 6 on the HUD shots.

But round 4's headline D3 result — *minimum same-tier Hamming distance 42/494 = 8.5 %* —
**does not survive the expansion.** I re-ran the same test on the full set using
`16-run-summary`, whose grid renders all 95 glyphs at one size under flat light (16-column
grid, pitch 42.73 px, rows at y = 466 + 42.8r; glyph band `x0+4…x0+26`, `y0+4…y0+24` →
440-bit mask; tier read from each tile's own keyline):

| pair | tier | XOR | vs round-4 floor (8.5 %) |
|---|---|---|---|
| filled hexagon vs isometric cube | **white** | **25/440 = 5.7 %** | **new floor, 33 % tighter** |
| battery vs canister | **green** | 28/440 = 6.4 % | below |
| plain diamond vs faceted gem | **white** | 34/440 = 7.7 % | below |
| hexagon vs shield (**round-4 N11**) | **white** | 37/440 = 8.4 % | below — **not fixed** |

Three *new* same-tier pairs now sit under the floor round 4 established, and round 4's own
named survivor is still there. At the HUD's 34 px tile the glyph renders ~20 px, so the
isometric cube's two internal edges and the gem's facet lines are 1 px each — the
discriminating detail is at the resolution limit. Separately, the red jellyfish and the
gold jellyfish are **XOR 2/440 = 0.5 %**, i.e. the same drawing in two hues; cross-tier
reuse is permitted by round 4's contract, but 99.5 % identity is the extreme end of it.

**3. Does the equipment slot read as distinct without looking bolted on?**
**Yes — this is the clearest win of the wave.** Measured in `06-loaded-hud`: the F tile
spans **x 1192–1263 (72 px)** against ~55 px skill tiles, carries an amber keyline and an
amber inner glow where the skills carry a cool slate plate with a pale-blue keyline, takes
an amber `F` key chip where the skills take pale-blue `M1/M2/Q/R`, and is fenced by a
vertical rule. All five tiles key at **exactly y = 756** (see §3, N2). It reads as a
different *kind* of thing in the same language. No defect on the slot's identity.

**4. Is `08-explosion` layered, or flat stickers?**
**Neither — there is no explosion in the frame.** What is present is a set of concentric
opaque orange tori, the largest spanning **x ≈ 560–1300 (46 % of the frame width)**, whose
notional centre (~900, 210) is empty sky. There is no core flash, no fireball, no smoke
column, no debris cloud. The ribbons have hard, constant-opacity edges and are **hard-cut
by the dark pillar at x ≈ 900 with zero depth fade** — the soft-particle test fails
outright. The debris are opaque cream quads, 2–8 px, with aliased edges and uniform
brightness regardless of depth, and no motion streaking. The terrain immediately beneath
the ring is lit by the scene key only — **no light contribution**. The mountain silhouette
behind the ring is geometrically undistorted — **no distortion**. Of the rubric's four
layers (flash + particles + distortion + light) only *particles* is present, and as flat
quads. `04-combat` is the same story with tan smoke: opaque, hard-edged, coffee-stain
blobs, and **zero enemies in a shot documented as "mid-fight with a horde"**.

**5. Post: bloom on emissives only? Jaggies, banding, mush?**
**Mostly fixed on the HUD shots; badly broken on `10-inventory`.** Round 4's central axis-9
complaint (786 clipped px in `06`, a leg band 34 % over L220) is genuinely resolved: `06`
now carries 783 clipped pixels of which **678 (87 %) are HUD text and glyph strokes and
only 105 are in the 3D viewport**, and the frame sits at mean L 34.2 with 0.95 % over 220.
That earns `06` a 7 on axis 9.

`10-inventory` does not. A **32 × 470 px column at the extreme left of the frame (x 0–32,
y 90–560) is blown to mean L 145.3, peak 254.2** — against a frame mean of 45.4 and the
same column below y 600 at mean 31.1 — by an off-screen glare with no visible source. On
top of it sits a **hard three-band prismatic split**: scanning y = 118, the blue edge lands
at x ≈ 15, green at x ≈ 18 and red at x ≈ 21 — **6 px of channel separation**, producing
discrete rainbow bands rather than a fringe. `RenderPipeline.js:392` caps aberration at
0.004 with the comment *"so stacked hits can never separate the channels into visible
colour"*; `:400` then adds a 0.0016 floor. At maximum radius the cap does not achieve its
stated goal. The same 3-band split is visible on the frame-edge rock in `08-explosion`
(x 1585–1600, y 105–135). AA is otherwise clean and grain is unobtrusive — the failure is
edge aberration and glare, not the pass list.

**6. Does the HUD ever obscure the action?**
**Yes — the damage-number layer does.** In `10-inventory` six damage numbers and a crit
mark composite into one contiguous run measuring **x 549–757 (208 px) × y 476–502 (27 px
cap)**, reading `135557!` — indistinguishable from a single number 135,557. At 27 px cap it
is the **largest type in the game** (objective banner 10 px, clock digits 23 px, item
counts 9 px), and it lands **directly over the player and the explosion**. This is round
4's N8 unfixed for a third consecutive round, and worse: round 4 measured `4 (444` and
`4111`; this is a clean 7-glyph run. The panelled HUD itself does not occlude: the
inventory occupies 14.4 % of the frame in the left gutter and clears the player.

---

## 3. Round-4 UI defect register — what actually landed

| ID | Round-4 defect | Status | Pixel evidence (round 5) |
|---|---|---|---|
| **N1** | `.money` drops to **1.94 : 1** over a bright sky | **LANDED** | `$4,266` in `06` now measures **11.07 : 1** (ink 201.2 / plate 20.8). `10`: 10.15 : 1. `08`: 11.24 : 1. The plate is genuinely opaque. |
| **N2** | M1 slot sits **6 px** lower than its three siblings | **LANDED** | First bright pixel per slot in `06`: F **756**, M1 **756**, M2 **756**, Q **756**, R **756**. Perfect register across all five, including the new equipment slot. |
| **N3** | `PHASE ROU…` permanently truncated | **LANDED** | Reads `PHASE ROUND` in full in `06`, `10`, `04` and `08`. No ellipsis anywhere in the set. |
| **N5** | `HARD` at **2.09 : 1**; clock plate translucent | **LANDED** | `22:01` now **17.72 : 1** (ink 240.1 / plate 6.7); `VERY HARD` **9.30 : 1**; objective banner 14.65 : 1. The translucent-plate failure class is closed on every element round 4 named. |
| **N6** | `+N` chip collides with the last charge pip | **LANDED** | `06` and `10`: the `+1` / `+4` chips clear the pip run with visible gap on M2, Q, R and F. |
| **N7** | Stack counts sit **on** their glyphs | **LANDED** | `Icons.js:515-516` now reads `ART_CENTRE_Y = 0.38`, `ART_RADIUS = 0.27` — round 4's specified numbers exactly. Measured row profiles across `06`'s white row: glyph ink ends at tile row ~20, count ink runs rows 21–29. **Butted, not overlapping.** See §5 — I withdrew this claim after measuring. |
| **N11** | Tougher Times (`hex`) ≡ Repulsion Armor Plate (`shield`) | **NOT LANDED** | **XOR 37/440 = 8.4 %**, still adjacent in the white row, still two bare grey polygons. The specified fix (a band or rivet row across the shield) was not applied. |
| **N8** | Damage numerals composite into unreadable piles | **NOT LANDED (3rd round)** | `135557!` — see question 6. |
| D3 | 37 same-tier glyphs distinct, floor 8.5 % | **REGRESSED** | Expanded to 95 glyphs; same-tier floor now **5.7 %**, three new pairs under the old floor. |

**Score: 6 LANDED · 2 NOT LANDED · 1 REGRESSED.**

### Did axis 7 regress against its 7–8 baseline?

**Yes — but only on the new screens, and the HUD held.**

- **The HUD did not regress.** Round 4 scored axis 7 at **7 / 7 / 8** on
  `03 / 06 / 01`. Round 5 scores `06` at **7**, `01` at **8**, `04` and `08` at **7**. Five
  of round 4's six named HUD defects are fixed and verified above, and the equipment slot
  was added without breaking the row's register. That is a clean piece of work.
- **`10-inventory` falls to 6** — the first HUD-bearing shot below 7 since round 3 — on the
  `+179` contrast failure, the unreadable equipment charge row, and the damage-number run.
- **The new menus land at 5 / 5 / 4.** `17-artifacts` at **4** is a three-point drop
  against the baseline and matches the rubric's 4-marker almost word for word: *"rounded
  default boxes, default sans stack, inconsistent spacing, no hierarchy."*

The regression is real, it is confined to content the wave added, and it is concentrated in
the artifact screen.

---

## 4. Top defects, ranked

Ranked by score cost. A fix agent should work this list top-down.

### 1. `src/data/artifacts.js` (`icon:` fields) + `src/ui/hud.css:2009` — the artifact icons are OS Unicode dingbats in a fallback font, and they knock the card grid out of alignment

The ten artifact/difficulty `icon:` values are raw codepoints from **six different Unicode
blocks**: `U+2318 ⌘` (Misc Technical), `U+2020 †` and `U+2042 ⁂` (General Punctuation),
`U+25C8 ◈` (Geometric Shapes), `U+2756 ❖` (Dingbats), `U+265B ♛` (Misc Symbols),
`U+27C1` (Misc Math A), plus `U+2602 ☂` / `U+2601 ☁` / `U+26C8 ⛈` on the difficulties.
**None exist in the `--font` stack** (`hud.css:10-11`: Bahnschrift / DIN Alternate /
Roboto Condensed / Liberation Sans Narrow / Franklin Gothic Medium / Arial Narrow /
Helvetica Neue / system-ui / sans-serif), so every one falls through to whatever symbol
font the OS supplies. In a game whose 95 item glyphs are authored canvas vectors
(`Icons.js`), the artifact screen is drawn by Segoe UI Symbol.

It shows in the pixels twice over. The marks render at incompatible sizes and heights —
measured ink extent as an offset from the card top (332):

| card | mark | ink top | ink height |
|---|---|---|---|
| Edict | `⌘` | +10 | 18 px |
| Tithe | `†` | +20 | 9 px |
| Spate | `⁂` | +20 | 11 px |

And because `.art-mark` (`hud.css:2009`, `font-size: 1.5em; line-height: 1`) inherits each
glyph's fallback-font metrics, everything below it shifts. Four sibling cards in **one row
of one grid**, all with identical card boxes (top 332, bottom 459), put their titles on
**three different baselines spanning 15 px**:

```
Edict  title top y=370  (+38 from card top)
Tithe  title top y=377  (+45)
Spate  title top y=377  (+45)
Filament title top y=385 (+53)
```

Row 2 repeats it: Caprice +39, Regalia +39, Mimicry +46.

**Fix:** route the artifact and difficulty marks through `Icons.js`'s `drawGlyph` as
authored vectors like every other icon in the game, and give `.art-mark` a fixed
`height`/`line-height` in px so the title's offset cannot depend on the glyph. Both halves
are required — pinning the height alone leaves the OS font.

### 2. `08-explosion` / VFX subsystem — the peak-impact shot contains no impact

Axis 6 is the lowest axis in the set (never above 4, twice at 3) and this shot is why.
Per question 4: opaque orange tori 740 px wide with an empty centre, no core flash, no
smoke, no distortion, no light contribution, hard-cut by geometry with zero depth fade, and
flat aliased debris quads with no motion streaking. Of flash / particles / distortion /
light, one layer is present.

Compounding it, the shot is captured at **`00:11`, `EASY ×1.6`, `$6`, `LVL 1`, `110/110`
HP** against three small enemies — the weakest moment a run has. Whatever the VFX does at
scale, this frame cannot show it.

**Fix, in order:** (a) add a soft-particle depth fade so ribbons and debris fade against
intersecting geometry instead of clipping; (b) give the blast an actual core — a
short-lived additive flash plus a smoke plume at the ring's centre — and scale the ring
radius to the damage instance rather than to the arena; (c) attach a decaying point light
to the blast so the ground under it brightens; (d) re-seed the shot to a late-run,
high-difficulty moment so the effect is captured doing its job.

### 3. `10-inventory` — six damage numbers composite into `135557!` over the player (round-4 N8, third round unfixed)

208 × 27 px, the largest type in the game, dead centre, over the player and the explosion,
and unreadable as anything but a single six-digit number. Round 3 specified the fix, round
4 restated it, and `CameraRig`-style neglect has now cost axis 8 three rounds running
(`10-inventory` axis 8 = 4).

**Fix (unchanged from round 3):** deterministic per-spawn screen-space jitter from `fxRng`,
plus a proximity reject that pushes a colliding spawn up the stack instead of drawing it on
its neighbour's baseline. Additionally cap the concurrent numeral count and shrink the type
by ~30 % so a full stack cannot exceed the player's own footprint.

### 4. `src/ui/Icons.js` glyph set — the 95-icon expansion drove the same-tier collision floor from 8.5 % to 5.7 %

Four same-tier pairs measured below round 4's floor (table in question 2), of which round
4's own N11 is one. At 20 px HUD render the separating detail on the tightest pair — the
isometric cube's two internal edges against a filled hexagon — is 1 px.

**Fix:** (a) apply round 4's unimplemented N11 fix — a horizontal band or rivet row across
the `shield` so it is not a bare polygon; (b) break the `hex`/`cube` collision by hollowing
the hexagon or giving the cube a visible open face; (c) add a facet-count or a fill/stroke
difference between `diamond` and `gem`, and a cap or gauge to the green `canister` so it is
not a plain rounded rectangle; (d) add the XOR test to CI with a floor of 10 % so the next
content wave cannot regress it silently.

### 5. `src/ui/hud.css:709-715` (`.hp-shieldnum`) — the barrier readout is cyan-on-cyan at 2.02 : 1, and the equipment charge row is unreadable

Round 4's translucent-plate failure class was fixed on every element it named and then
reappeared on an element it did not. `.hp-shieldnum` is `color: var(--shield)` (`#74dcff`)
and the barrier fill it sits on is the same hue (`hud.css:672`). Measured on `10-inventory`:
**ink 216.9 / plate 152.9 = 2.02 : 1** — statistically the same failure as round 4's `HARD`
at 2.09 : 1 and `.money` at 1.94 : 1. In `06`, where `+109` happens to land on the red
fill, it measures 4.31 : 1; the element is only ever legible by luck of fill length.

In the same frame the equipment charge row (x 1196–1245, y 866–876) measures **mean L 26.7,
peak 82.2** — all five pips dark — while the overflow chip beside it reads `+4`. The shot
whose stated job is *"equipment effect quality"* cannot show the equipment's charge state.

Also in this frame: `06-loaded-hud` prints **`308 / 307`** — current HP above maximum. The
bar geometry is internally correct (red 72.8 % of trough against 307/(307+109) = 73.8 %,
so the trough silently rescales to include the barrier), but the printed denominator does
not correspond to the end of the bar and the printed current exceeds it.

**Fix:** give `.hp-shieldnum` the opaque chip treatment `.money` and `.slot-name` already
have (`background: rgba(4,7,12,0.72)`; `box-shadow: inset 0 0 0 1px rgba(0,0,0,0.85)`), or
move it outboard of the fill. Render unfilled equipment pips as outlined rather than dark
so a zero-charge state is distinguishable from an absent one. Clamp the HP readout to max.

### 6. `15-logbook` / `16-run-summary` — a default scrollbar, two casing systems, and two-thirds of each screen is dead

The evidence is in question 1. The measurements that set the scores:

| | measured |
|---|---|
| logbook model viewer (880 × 253) | **92.1 % of pixels below L26**; the golem is **132 px wide = 15 % of the box** |
| run-summary frame | **82.5 % below L14**; side gutters **99.8 % dead**; the content card is 746 px = **47 % of frame width** |
| logbook scrollbar | 6 px UA thumb, x 476–481, flat L 70.4, no track |
| logbook header | `0 / 16 RECORDED` — while all 16 entries render with full names, tiers, stats and lore, and no locked or redacted state appears anywhere |

**Fix:** (a) delete the `::-webkit-scrollbar` rules and draw the rail in the panel's own
language — a 2 px accent-coloured bar in a chamfered track; (b) add
`text-transform: uppercase` to `.book-row-name` and `.art-name`, or drop it from `.tabbtn`
and the stat labels, so one casing rule governs each panel; (c) frame the model viewer to
the subject (or shrink the box) so the detail pane is not 92 % empty; (d) reconcile the
`N / 16 RECORDED` counter with a real locked state — silhouette the model and redact the
stats for unrecorded entries, which is what the counter is promising; (e) group the
run-summary grid into shrink-wrapped tier rows with the HUD's coloured rules, and pick one
of the two tile systems.

---

## 5. Claims I checked and dropped

Listed because a critic who only reports hits is not being measured.

- **"Stack counts still sit on their glyphs (N7 persists)."** This is what the 4× crops
  look like, and it is what I first wrote down. It is wrong. `Icons.js:515-516` carries
  round 4's specified constants exactly (`ART_CENTRE_Y = 0.38`, `ART_RADIUS = 0.27`), and
  per-row ink profiles across `06`'s white row show glyph ink terminating at tile row ~20
  with count ink running rows 21–29 — **butted with ~1 px clearance, not overlapping**. It
  reads as touching only under nearest-neighbour magnification, where the glyph's
  antialiased skirt meets the count's black outline. **Withdrawn — N7 landed.**
- **"`ARTIFACTS: NONE` contradicts the `ARTIFACT OF THE FILAMENT` chip on the same
  screen."** It does not: the stat cell reports artifacts *active during the run*, the chip
  reports a challenge *unlocked by* the run. Two different facts. **Withdrawn.**
- **"The HP bar is decorative — 06 shows full HP with a 73 % fill."** The trough represents
  `maxHP + barrier`. Measured: red 72.8 % vs 307/416 = 73.8 %; cyan 27.0 % vs 109/416 =
  26.2 %. `10` fits the same model (red 19.3 % vs 113/554 = 20.4 %; cyan 33.0 % vs 32.3 %).
  The bar is driven by the real numbers. Only the printed `308 / 307` and the mismatched
  denominator survive, folded into defect 5. **Half withdrawn.**
- **"Chromatic aberration is being applied over the HUD layer."** Round 4 withdrew this
  twice; I tested it a third time on the strongest candidate — the `10-inventory` item
  tiles sitting on the blown left column. Sampled glyph and count edges are clean neutral;
  the fringing is the 3D layer beside and behind the panel. **Withdrawn again.** The
  aberration defect in §4 is about the 3D frame edge, not the HUD.
- **"The right edge of `08-explosion` contains rendering garbage."** Magnified: they are
  terrain fragments clipped by the frame edge. Only the 3-band prismatic fringe on them is
  a defect, and it is folded into the post-processing finding. **Reattributed.**
- **"White-tier `leaf` ≡ `watch` (XOR 28) and `hexagon` ≡ `basket` (XOR 32)."** The mask
  distance is low because both members of each pair are small centred blobs of similar
  area. Rendered at 3× side by side they are unmistakable. Only pairs that also fail
  visually are listed in question 2. **Withdrawn.**
- **"The equipment slot's cooldown language is inconsistent with the skills' radial
  sweep."** No skill is on cooldown in `06`, and in `10` the equipment shows a dimmed plate
  plus a `16` numeral. I have no frame in this set where both are on cooldown
  simultaneously, so I cannot compare. **Not tested — not scored.**
- **Difficulty-select screen.** `U+2602 ☂`, `U+2601 ☁` and `U+26C8 ⛈` are emoji-presentation
  codepoints that Windows renders in colour, which would be a severe cohesion break. There
  is **no difficulty-select shot in the manifest**, so this is a code-located risk only.
  **Not scored.** Recommend adding the shot.

---

## 6. Commands and evidence

- `shots/manifest.json` read first: `ready: true`, `partial: false`, `errors: []`,
  `frameErrors: 0` and `newErrors: []` on all 18 shots.
- Pixel probes: Pillow 12.3.0 decoding each PNG to RGB and reading pixels directly
  (scratchpad `probe.py` + 18 query scripts). No engine run; `tools/capture.mjs` untouched.
- **Contrast** computed by splitting each element's own box into ink (top 14 %) and plate
  (bottom 45 %) populations and applying the WCAG relative-luminance ratio — never by
  eyeballing a peak. 11 elements across 3 shots.
- **Artifact grid geometry** derived from the frame: card extents by column luminance
  profile at x = 545 / 1015 / 1245; title baselines by per-row ink counts at two thresholds
  (the low-threshold re-run in §4 corrected my first pass, which had confused mark rows
  with title rows on two cards).
- **Icon collision test:** `16-run-summary` grid located by keyline scan (16 columns,
  pitch 42.733 px from x0 = 465; 6 rows, pitch 42.8 px from y0 = 466), 83 tiles extracted,
  tier classified from each tile's own keyline hue, glyph band thresholded to a 440-bit
  mask, all 931 same-tier pairs XOR-ed; the 8 tightest rendered side by side at 3× and
  judged visually before any was reported.
- **Exposure/clipping** swept at 2 px stride across all 8 shots for fully-clipped (255,255,255),
  near-clipped (≥250) and L>220 populations; clipped pixels then localised to HUD zones vs
  3D viewport.
- **Aberration** measured as per-channel edge position along horizontal scanlines at
  several radii in `08`, `04` and `10`.
- Magnified crops written and inspected: ability cluster 3× in `06` and `10`, HP bar 3× in
  both, money 5×, clock 4×, inventory tier rows 4×, explosion 1.9× and 4×, damage numerals
  3×, frame edges 4–5×, run-summary grid 2.2×, stat table 2×, glyph pairs 3×.
- CodeGraph (`codegraph_explore`) used for the artifact-screen flow
  (`renderArtifacts → artifactList → Artifacts.list`) and `RenderPipeline`.
- Source read for attribution only: `hud.css`, `Icons.js`, `HUD.js`, `Menus.js`,
  `artifacts.js`, `Artifacts.js`, `RenderPipeline.js`, `RUBRIC.md`,
  `reviews/round4-charui.md`.
- `02`, `05`, `07`, `09`, `11`, `12`, `13-*` not inspected this round — out of the stated
  domain. `14-survivor-select` inspected but not scored in the table; it is referenced in
  question 1 as the wave's cohesion success.
- No project file was modified. This report is the only file written.
