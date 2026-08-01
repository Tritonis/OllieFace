# PETRICHOR — Round 2 critique (round 5 loop): UI/HUD craft, VFX, post, cohesion

Domain: rubric axes **7** (UI/HUD), **6** (VFX), **9** (post), **10** (cohesion). Other axes
scored from the pixels for completeness.

`shots/manifest.json` read first: `ready: true`, `partial: false`, `errors: []`,
`subjectsOk: true`, `subjectFailures: []`, all 18 shots `frameErrors: 0` / `newErrors: []`.
**No crash to report.** Shot mtimes 13:37–13:38 postdate HEAD (`34cc8c4`, 13:36:47), so the
captures are of the fixed build.

Every number below was produced by decoding the shipped PNGs with Pillow/numpy and reading
pixels. `tools/capture.mjs` was not executed. No project file was modified.

---

## 1. Axis scores — round 1 → round 2

| Axis | 01-title | 04-combat | 06-hud | 08-explosion | 10-inventory | 15-logbook | 16-summary | 17-artifacts |
|---|---|---|---|---|---|---|---|---|
| 1 Lighting | 4 → 4 | 5 → 5 | 5 → 5 | 5 → 5 | 5 → **4** | 4 → 4 | 4 → 4 | 4 → 4 |
| 2 Composition | 5 → 5 | 4 → **5** | 4 → 4 | 4 → 4 | 4 → 4 | 3 → **4** | 3 → **4** | 4 → **5** |
| 3 Colour & grade | 7 → 7 | 6 → 6 | 7 → 7 | 6 → 6 | 5 → **4** | 5 → 5 | 5 → **6** | 5 → **6** |
| 4 Silhouette | 6 → 6 | 6 → **5** | 6 → 6 | 6 → 6 | 5 → **4** | 6 → 6 | 6 → 6 | 4 → **7** |
| 5 Material | 4 → 4 | 4 → 4 | 4 → 4 | 4 → 4 | 4 → 4 | 4 → 4 | 4 → 4 | 4 → 4 |
| **6 VFX** | 4 → 4 | 3 → **5** | 4 → **5** | 3 → **6** | 4 → 4 | 4 → 4 | 4 → 4 | 4 → 4 |
| **7 UI/HUD** | 8 → 8 | 7 → 7 | 7 → 7 | 7 → 7 | 6 → **5** | 5 → 5 | 5 → **6** | 4 → **7** |
| 8 Readability | 8 → 8 | 6 → **5** | 6 → 6 | 6 → 6 | 4 → 4 | 7 → 7 | 7 → 7 | 7 → **8** |
| **9 Post** | 6 → 6 | 5 → 5 | 7 → 7 | 5 → **6** | 4 → 4 | 6 → 6 | 6 → 6 | 6 → 6 |
| **10 Cohesion** | 7 → 7 | 6 → 6 | 7 → 7 | 6 → **7** | 6 → **5** | 5 → 5 | 4 → **6** | 4 → **7** |
| **Mean** | 5.9 → **5.9** | 5.2 → **5.3** | 5.7 → **5.8** | 5.2 → **5.7** | 4.7 → **4.2** | 4.9 → **5.0** | 4.8 → **5.3** | 4.6 → **5.8** |

```
AXIS SCORES 01-title:       1:4 2:5 3:7 4:6 5:4 6:4 7:8 8:8 9:6 10:7
AXIS SCORES 04-combat:      1:5 2:5 3:6 4:5 5:4 6:5 7:7 8:5 9:5 10:6
AXIS SCORES 06-loaded-hud:  1:5 2:4 3:7 4:6 5:4 6:5 7:7 8:6 9:7 10:7
AXIS SCORES 08-explosion:   1:5 2:4 3:6 4:6 5:4 6:6 7:7 8:6 9:6 10:7
AXIS SCORES 10-inventory:   1:4 2:4 3:4 4:4 5:4 6:4 7:5 8:4 9:4 10:5
AXIS SCORES 15-logbook:     1:4 2:4 3:5 4:6 5:4 6:4 7:5 8:7 9:6 10:5
AXIS SCORES 16-run-summary: 1:4 2:4 3:6 4:6 5:4 6:4 7:6 8:7 9:6 10:6
AXIS SCORES 17-artifacts:   1:4 2:5 3:6 4:7 5:4 6:4 7:7 8:8 9:6 10:7
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass needs 7+ on every axis with none below 6. Axis 6 still tops out at
**6** (on `08-explosion` only) and sits at **4** on four shots. `10-inventory` **regressed**
on five axes and is now the worst frame in the set at 4.2.

The wave's two genuine wins: `17-artifacts` moved +1.2 mean and is no longer a third idiom,
and `08-explosion` moved +0.5 on the strength of a flash core that is finally alive. Neither
gets any axis to a pass.

---

## 2. Claim verification

| # | Claim | Ruling | Evidence |
|---|---|---|---|
| 1a | Flash core contributes **+135.0 L at r=0** (was +0.0), monotonic to +24.5 L at r=190 | **VERIFIED** | I re-ran the A/B myself on `shots-vfxprobe/08-{full,no-flash}.png`. Locating the diff's own peak independently: centre (792,186), **+134.0 L at r=0, +135.2 at r=10, +122.9 at 20, +92.5 at 60, +56.6 at 120, +26.6 at 190** — monotone after r=10. Diff peak **+143.2 L at (805,196)**, the agent's stated coordinate to the pixel. In the *shipped* `shots/08-explosion.png` the core is present at (706,236): **mean L 219.5 at r=0** falling to 98.0 at r=190, against surrounding sky at L 36–72. |
| 1b | Root cause was a shutter at t=0.207 s, not the documented 0.09 s | **VERIFIED (code)** | `src/systems/VFX.js:415-448` carries the constants and the reasoning; core life 0.20→0.42, pip 0.16→0.28, `alphaPow` 1.5→1.7 / 1.1→1.35. I cannot re-time the shutter without running the harness, but the *consequence* — a live core at the shutter — is confirmed above. |
| 2 | Debris stretches along instantaneous velocity, not spawn velocity | **VERIFIED** | `ParticleShader.js:120` now reads `vec3 vv = (modelViewMatrix * vec4(term + (aVel - term) * e, 0.0)).xyz;` (was `vec4(aVel,0.0)`). I checked the calculus: position is `aSpawn + term*t + (aVel-term)*(1-e)/k` with `e=exp(-kt)`, so `dp/dt = term + (aVel-term)*e`. **The derivative is correct.** Pixels agree: 124 debris components in the sky window around the blast, **median aspect 2.75, 43 % above 3:1, longest streak 106 px**; of the 48 unambiguous streaks the **median deviation from the radial direction is 27°, with 42 % above 40°** — spawn-velocity stretch would put every streak on the radial. Round 1's "no motion streaking" is refuted in the pixels. (Caveat: turbulence is added to position but not to the differentiated velocity, so heavily-turbulent emitters still streak slightly off-tangent. Not visible at this scale.) |
| 3a | Light layer present | **VERIFIED** | My own diff `08-full` − `08-no-light`: **645,785 px changed, max +205.9 L at (675,642)** — the agent's coordinate exactly. (Their 307,892 px figure is the same signal at a higher threshold.) |
| 3b | Distortion layer present | **VERIFIED (probe) / NOT VISIBLE (shipped)** | Diff vs `08-no-distort`: **126,277 px displaced, range −167.5 … +134.0** — range matches their report to 0.1 L. But I cannot see it in `shots/08-explosion.png`: the mountain silhouette behind the ring is not measurably warped, because the ring is now so faint (see defect 4). The layer exists; the shipped frame does not show it doing anything. |
| 3c | Soft depth fade present | **VERIFIED** | Diff vs `08-no-soft`: 26,192 px, **mean −18.6 L, deepest cut −125.4** — negative-only, the correct sign for a depth fade. Confirmed independently in the shipped frame: at 6× magnification (x 780–900, y 180–330) the shockwave band crosses the mountain face and **fades out over it** rather than clipping. Round 1's "hard-cut by the dark pillar with zero depth fade" is **refuted**. |
| 4 | Artifact marks are drawn glyphs, not Unicode dingbats | **VERIFIED** | `src/data/artifacts.js` carries `mark:` keys (`command`, `sacrifice`, `swarms`, `glass`, `caprice`, `honour`, `evolution`) into `Icons.js:588` `MARKS` / `:706` `markIcon()`, consumed at `Menus.js:674`. Pixels: seven vector marks in `17-artifacts`, **max per-mark chroma 14–128 with no colour-emoji signature**, ink heights 34/35/34/34 px inside a fixed 30 px box. No fallback-font metrics. |
| 5 | Title stagger fixed by a `<button>` flex change; 370/377/377/385 → all 370 | **VERIFIED** | `hud.css:2041-2050` — `display:flex; flex-direction:column; justify-content:flex-start` on `.art`, plus `hud.css:2067` `.art-mark { width:30px; height:30px; line-height:0 }`. Measured title ink-top in row 1: **369 / 369 / 370 / 369** (1 px span, antialias). Row 2: **515 / 514 / 514**. The 15 px stagger is gone. The agent's root-cause correction (UA button centring, not font fallback) is right — round 1's diagnosis was wrong and its prescribed fix would not have worked alone. |

---

## 3. The icon-collision dispute — independent ruling

**Both parties are partly wrong, and the fix agent's stated reason is refuted.**

I re-measured from scratch on the shipped composite. Grid located by keyline scan
(16 columns, pitch 42.7 px from x₀=456; 6 rows, pitch 42.8 px from y₀=466 — the same
geometry round 1 states), 83 tiles, tier read from each tile's own border ring
(28 white / 26 green / 15 red / 7 gold / 7 blue), glyph band inset 5 px with the bottom
9 rows dropped to exclude the count chip, resampled to 34×34, all **850** same-tier pairs.

| capture | instrument | floor |
|---|---|---|
| `shots/16-run-summary.png` (current) | full glyph band → 34×34, 1156 bits | **8.04 %** |
| `shots/16-run-summary.png` (current) | round 1's own 22×20 upper-left band, 440 bits | **14.32 %** |
| `shots-uivfx-before/16-run-summary.png` (pre-fix) | full glyph band → 34×34 | **5.80 %** |

**1. Round 1's 5.7 % was a correct measurement of the build it saw.** My independent
instrument returns **5.80 %** on the pre-fix capture — round 1's number to within a tenth of
a point. Its tightest pair on that capture is white `r0c9` vs `r0c12`: **the plain diamond
against the faceted gem**, which is one of the four pairs round 1 named.

**2. The number changed because the code changed, not because round 1 mis-measured.**
`git diff f9d85cf HEAD -- src/data/items.js` is **158 lines**, and it rewrites exactly the
glyphs round 1 named. From that diff's own comments:

```
+    // Tougher Times — a hollow shell that took the hit. Hollowing it is the
+    // only thing that separates it from `shield`, `saltcube`, `pouch` and
+    // `diamond`, all of which are convex commons of the same optical area.
+    case 'hex': ... g.fillStyle = '#0d0f14'; poly(g, 6, r * 0.58, 0); g.fill(); ...
+      // Facets in the *plate* colour, not white. A white facet line has the same
+      // luminosity as the white outline, so it added no mask difference at all
+      // and the brooch measured 5.8% from a bare `diamond`.
+    // Bison Steak ... As a bare teardrop it measured 5.2% from `plug` — the
+    // tightest same-tier pair in the set.
```

That work landed in **`5618f22`** — the same commit that first added
`reviews/round5/critic-r1-ui-vfx.md` to the repo. Visual confirmation: in the pre-fix
capture, white row 1 columns 5/6/10 are a bare hexagon, a bare shield and a bare rhombus;
in the current capture they are a hollowed hex nut, a domed shield with rivets, and a
seamed charge with a lit fuse.

**3. The fix agent's git check looked in the wrong place.** FIX-ui-vfx.md §4 states *"no
item glyph in `Icons.js` and no `glyph:` field in `items.js` was touched between the
critic's read and this measurement."* Both halves are literally true and both miss the
change: the item drawings are in **`drawGlyph()` in `src/data/items.js`**, not `Icons.js`,
and the `glyph:` fields are string keys, not drawings. The conclusion — *"recorded as a
measurement error in the critique, not a defect"* — is **REFUTED**. It was a real defect
that a predecessor had already fixed.

**4. Round 1 did make one real error.** `battery` vs `canister`, "green", 6.4 % cannot
exist: `battery` belongs to `siege-battery` (`items.js:805`, **legendary**) and `canister`
to `frostbite-canister` (`equipment.js:182`, **equipment**). Not the same tier, and not
green. The fix agent's catch on that pair is correct (their wording "no `canister` glyph in
the set" is itself slightly wrong — it exists, on an equipment item).

**5. The fix agent's own 11.04 % PASS does not describe the shipped tile either.**
`tools/glyphdist.mjs` renders `itemArt` in isolation at 34 px into a 616-bit mask and gates
CI at ≥10 %. The shipped composite measures **8.04 %** — below their own gate. The gate is
green while the pixels a player sees are not. Two same-tier pairs sit under 10 %: green
`battery` vs green `cell` (8.04 %) and white `pinecone` vs white `watch` (9.95 %). Rendered
at 40 px side by side both are **visually distinguishable** — the battery has a terminal nub
and horizontal bands where the cell has two top clips and a bolt — so I am **not** raising
this as a defect. But the CI gate should measure the composite, not the isolated render, or
it will keep reporting PASS on a number nobody is looking at.

**Settled:** round 1's finding stands as measured and is now obsolete; the fix agent's
decision to change no code was correct; its attribution to critic error was not.

---

## 4. The two escalated findings

**A. Blown-white `glacial` affix hexagons erasing enemy silhouettes in `04-combat` —
CONFIRMED, and worse than escalated.**

Connected-component scan of the 3D layer for near-white desaturated pixels (`L > 195`,
chroma `< 40`), HUD excluded:

| blob | px | bbox | mean L | peak L | chroma |
|---|---|---|---|---|---|
| 1 | **3,737** | x 701–793 (**93**) × y 435–506 (**72**) | **230.0** | 243.0 | **13.3** |
| 2 | 2,852 | x 1124–1179 × y 325–443 | 219.9 | 252.9 | 20.1 |
| 3 | 1,188 | x 594–635 × y 332–370 | **250.9** | 254.1 | 17.2 |
| 4 | 718 | x 671–700 × y 405–480 | 228.1 | 253.9 | 22.9 |
| 5 | 505 | x 539–566 × y 335–358 | **250.0** | 254.0 | 18.7 |

Frame mean is **L 77.0**. Blob 1 is a 93 × 72 px opaque near-neutral mass at L 230 sitting
on a monster; at 4× magnification the only trace of the creature is red fragments leaking
out at the top-right and along the base — **the silhouette is completely erased**. Blobs 3
and 5 are at L 250–251, i.e. effectively paper white. Source confirmed in
`src/systems/VFX.js:71` (`glacial: { tip: 0xe6ffff, frame: FRAME.HEX, rate: 22 }`) and `:80`
(`freeze: { tip: 0xffffff, frame: FRAME.HEX, rate: 14 }`) — two near-white tips on the same
additive HEX frame, stacking to neutral white. This is the rubric's axis-8 4-marker
verbatim and it costs axis 4 and 6 as well.

**B. HUD ↔ run-summary cohesion — PARTIALLY REFUTED. The specific claim is wrong; a
narrower one survives.**

Round 1: *"HUD: tier-coloured plate, white glyph… Summary: near-black plate, tier-coloured
glyph… two mutually exclusive rules for what the tier colour means."* Measured plate and
glyph on matched tiles:

| | plate RGB (chroma) | glyph RGB (chroma) |
|---|---|---|
| HUD `06` white tier | 63,69,77 (14) | 129,135,143 (14) |
| Summary `16` white tier | 30,36,44 (14) | 124,130,138 (14) |
| HUD `06` green tier | 0,53,3 (53) | 166,215,169 (48) |
| Summary `16` green tier | 0,47,3 (47) | 167,218,170 (51) |
| HUD `06` red tier | 112,30,18 (94) | 222,129,117 (104) |
| Summary `16` red tier | 72,9,1 (71) | 217,135,124 (93) |

**Identical system on both screens** — tier-tinted plate, tier-tinted glyph, within a few
units on every channel. Nothing is inverted. The absolute plate brightness differs because
the HUD strip composites over a lit 3D frame. This also held in the pre-fix capture, so the
claim was wrong when written. **Withdrawn.**

What survives, measured: the HUD groups items into shrink-wrapped per-tier rows with
coloured rules; the summary is one continuous 16-wide wrap and **tier boundaries fall
mid-row four times, with no rules and no gaps**:

```
row0  WWWWWWWWWWWWWWWW
row1  WWWWWWWWWWWW|GGGG      white -> green at column 12
row2  GGGGGGGGGGGGGGGG
row3  GGGGGG|RRRRRRRRRR      green -> red at column 6
row4  RRRRR|YYYYYYY|BBBB     red -> gold at 5, gold -> blue at 12
row5  BBB.............
```

That is a real, narrower cohesion defect and it is defect 5 below.

---

## 5. Top defects, ranked (6 max)

### 1. `src/systems/VFX.js:71,80` — a 93 × 72 px white mass erases a monster in `04-combat`

Measurements in §4A. `glacial.tip = 0xe6ffff` and `freeze.tip = 0xffffff` are both
near-white on an additive `FRAME.HEX`; two or three overlapping quads saturate to
neutral L 230–251 and the creature underneath stops existing.

**Fix:** (a) pull both tips off white — `glacial.tip` to `0x9fd8f0` and `freeze.tip` to
`0xbfe8ff`, so the aura stays hue-identified rather than clipping to neutral; (b) cap the
per-emitter additive contribution so N overlapping hexes cannot exceed ~1.4× one hex
(clamp in the fragment shader, not by lowering `rate`, or the aura thins out); (c) scale
`size0/size1` from the host entity's projected bounding-box height so the aura can never be
larger than the monster it dresses — blob 1 is 93 px against enemies whose measured
footprints in the manifest are 67–985 px total.

### 2. `10-inventory` — the equipment nuke doubles the whole frame's exposure

Same stage, same camera as `06`. The 3D viewport (x 520–1180, y 110–780) measures
**mean L 123.0 in `10` against 62.1 in `06`**, and the mean colour goes from
RGB 80,56,70 (violet dusk) to **RGB 135,122,98** — a milky yellow-green wash over terrain,
water, trees and sky alike. 2.42 % of the frame is over L 220 (highest in the set). Round 1's
axis-9 findings on this shot are *both fixed* and I withdraw them: the 32 × 470 left column
now measures mean **50.3** (was 145.3), and the 6 px prismatic split at y=118 is gone —
R, G and B all place their strongest edge at **x = 37**. What replaced them is worse,
because it is frame-wide.

**Fix:** the equipment flash is driving the tone-mapper's exposure, not just its own
pixels. Exclude the equipment/nuke emissive from the auto-exposure histogram (or clamp
adaptation velocity so a sub-second flash cannot move the key), and let the flash blow out
locally against a correctly-keyed scene.

### 3. `HUD damage numerals` — 27 px cap, 174 px wide, drawn over the crosshair (round-4 N8, 4th round)

Four `27118!` runs in `10-inventory`. Measured ink extents: x 391–544, x 680–853,
x 1180–1338, x 1364–1489, each **cap 27 px**. The centre run at **x 680–853 × y 410–437**
lands on the player *and buries the top tick of the crosshair* — at 3.5× the reticle's upper
stroke is behind the `1`/`8`. A fifth run, `18!` at x 185–269 × y 170–195, composites over
the white-tier rows of the inventory strip. At 27 px this is still the largest type in the
game (objective banner 10 px, clock 23 px, item counts 9 px).

**Fix (unchanged from round 3, still not applied):** reserve a no-draw rect around the
crosshair and reject any numeral spawn whose box intersects it — push it up the stack
instead; cap concurrent numerals; shrink the type ~30 % so one run cannot exceed the
player's own footprint; and clip the numeral layer out of the inventory strip's rect.

### 4. `08-explosion` — the core is alive but the effect has no structure: no smoke, and the ring is now lost inside the bloom

The layers are all present and measurable (§2) and this is the wave's real technical win.
It still does not read as an explosion. In the shipped frame the blast disc (r < 120 about
(706,236)) is **mean L 160.3 with only 3.99 % over L 220 and zero fully-clipped pixels** —
i.e. a large soft warm haze, not a hot core with a defined edge. The shockwave ring, which
round 1 measured as an opaque 740 px torus, is now a pale band barely above the sky it sits
on; it is the layer that gave the effect its silhouette and the core has washed it out.
There is **no smoke column and no dust plume at all** — the four layers the probe measures
are flash, light, distortion and depth-fade, and none of them is opacity. Compounding it,
the blast sits in empty sky at y=236 with its lower half behind a foreground rock, and the
shot is captured at `00:11`, `EASY ×1.6`, `$6`, `LVL 1`.

**Fix, in order:** (a) add an opaque smoke/dust layer — a short-lived dark plume rising
from the blast centre with a soft-particle fade, so the effect has a silhouette instead of
only luminance; (b) push the ring's alpha back up now that the core no longer needs to
carry the read, or narrow the core's `size1` from `r*1.5` so the ring clears it; (c) move
the blast lower and unoccluded and re-seed to a late-run moment — this is `Harness.js`, and
it is the single change that would make the layer work visible.

### 5. `16-run-summary` — tier grouping abandoned; boundaries fall mid-row four times

Map in §4B. The HUD earned its density score by shrink-wrapping each tier into its own rows
with a coloured rule; the summary throws that away and wraps 83 tiles into a flat 16-column
grid, so `white → green` breaks at column 12 of row 1, `green → red` at column 6 of row 3,
and row 4 carries **three tiers**. The tile *system* matches (§4B) — this is purely the
grouping.

**Fix:** render the haul as one block per tier, each shrink-wrapped to its own row run and
separated by the HUD's tier-coloured rule (`hud.css` already has the rule; reuse it). Cost
is a few rows of height in a card that has 82.5 % of the frame outside it.

### 6. `15-logbook` — a bare Chrome scrollbar, `0 / 16 RECORDED` over 16 fully-rendered entries, and an 88 %-empty model box

Unchanged from round 1 and untouched by the wave (the fix agent states `Menus.js`/`hud.css`
were contended and out of scope, which is fair — it is still shipped).

- **UA scrollbar.** Column means at x 470–494 in `15-logbook`: `13 13 13 13 13 13 | 61 61 61 61 61 61 | 43 | 13 …` — a flat 6 px thumb at L 61 on an invisible L 13 track. `hud.css:2095` styles the thumb only. It is the one browser default in the product.
- **Counter contradicts content.** The header reads `0 / 16 RECORDED` while all 16 entries render full names, tiers, stats and lore, and no locked or redacted state appears anywhere.
- **Two casing systems in one panel.** `SURVIVORS / ITEMS / EQUIPMENT / MONSTERS` and `HEALTH / DAMAGE / SPEED / REACH` uppercase, beside `Lemurian`, `Blind Pest`, `Ridgeback Charger` in Title Case and an italic mixed-case lore line.
- **Model viewer.** The 890 × 250 box holds a golem ~110 px wide; the box is ~88 % empty.

**Fix:** (a) delete the `::-webkit-scrollbar` rules and draw the rail in the panel's own
language — a 2 px accent bar in a chamfered track; (b) either wire the counter to a real
locked state (silhouette the model, redact the stats) or delete it; (c) add
`text-transform: uppercase` to `.book-row-name` (`hud.css:2117`) so one casing rule governs
the panel; (d) frame the viewer camera to the subject's bounding box.

---

## 6. Round-1 claims I am withdrawing or correcting

Listed because a critic who only defends its predecessor is not being measured.

- **"The tile system is inverted between the HUD and the run summary."** Measured on
  matched tiles: same plate hue, same glyph hue, chroma within a few units on all three
  tiers, on both the current and the pre-fix capture. **Withdrawn** (§4B).
- **"Ribbons are hard-cut by the dark pillar with zero depth fade."** The shockwave band
  fades over the mountain face at 6×; the A/B shows a negative-only −18.6 L mean.
  **Withdrawn.**
- **"Debris are flat aliased quads with no motion streaking."** Median aspect 2.75, 43 %
  over 3:1, longest streak 106 px. **Withdrawn.**
- **"A 32 × 470 px column at x 0–32 is blown to mean L 145.3."** Now mean **50.3**.
  **Withdrawn — fixed.**
- **"6 px of channel separation at y=118 in `10-inventory`."** R, G and B strongest edges
  all at x=37. **Withdrawn — fixed.**
- **"The equipment charge row is all-dark, peak L 82."** Peaks at 255 in both `06` and
  `10`. **Withdrawn — fixed.**
- **"`.hp-shieldnum` is cyan-on-cyan at 2.02 : 1."** Now **3.31 : 1** in `06` and
  **3.34 : 1** in `10` (ink 117,218,252 on plate 201,51,41 — the barrier numeral now lands
  on the red fill, not the cyan). Improved but still under the 4.5 : 1 threshold.
  **Half-withdrawn**, folded down out of the top-6.
- **"The 95-glyph set's same-tier floor regressed to 5.7 %."** Correct as measured, now
  obsolete; the glyphs were redrawn. See §3. **Superseded, not withdrawn.**
- **"`battery` vs `canister`, green, 6.4 %."** Not a same-tier pair and neither is green.
  **Withdrawn as an error.**
- **`308 / 307` in `06-loaded-hud`** — current HP printed above maximum — is still present
  and still unfixed (`10` correctly prints `384 / 384 +191`). Below the top-6 cut but not
  withdrawn.
- **`17-artifacts` axis 7 = 4 ("default sans, no hierarchy").** Superseded by the fix; now 7.

Nothing in §5 of the round-1 critique was re-raised.

## 7. Commands and evidence

- `shots/manifest.json` read first; `git log -1 --format=%ci HEAD` vs `ls --time-style` on
  `shots/*.png` to confirm the captures postdate the fix.
- Pillow 12.3.0 + numpy 2.5.1 decoding each PNG to RGB. Scratchpad scripts: `p.py`
  (frame stats), `core2.py` (shipped radial profile), `ab.py` (independent A/B of the five
  `shots-vfxprobe` variants), `debris2.py` (connected-component streak analysis with
  major-axis vs radial-direction test), `coll2.py` / `before.py` (850-pair same-tier
  collision measurement under two crop geometries, current and pre-fix), `art.py`
  (artifact card ink profiles), `coh.py` (HUD vs summary tile probe, tier map, scrollbar
  column profile), `glacial.py` (near-white desaturated blob labelling), `hud.py`
  (WCAG contrast by ink/plate percentile split), `inv.py` (viewport exposure, edge
  aberration, numeral extents), `crop.py` (nearest-neighbour magnification).
- Magnified crops inspected: blast 2.6× and 6× at the geometry intersection, HUD inventory
  3×, summary grid 2.4×, pre-fix summary grid 2×, tight glyph pairs 7×, glacial mass 4×,
  damage numeral 3.5×, artifact cards at 1×.
- Source read for attribution only: `VFX.js`, `ParticleShader.js`, `items.js` (`drawGlyph`),
  `Icons.js`, `artifacts.js`, `equipment.js`, `hud.css`, `Menus.js`, `RUBRIC.md`.
- `git diff f9d85cf HEAD -- src/data/items.js src/ui/Icons.js`,
  `git show 5618f22 -- src/ui/Icons.js`, `git show a06c6fe`, `git log --oneline
  --diff-filter=A -- reviews/round5/critic-r1-ui-vfx.md` for the collision-dispute timeline.
- `02`, `03`, `05`, `07`, `09`, `11`, `12`, `13-*`, `14`, `18` not inspected — out of the
  stated domain and shot list.
- No project file was modified. This report is the only file written.
