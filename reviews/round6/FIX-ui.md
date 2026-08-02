# FIX-ui — the damage-numeral layer, and the tractable UI residuals

Work order: `reviews/round6/critic-r4-ui-vfx.md`. Files touched, all inside the
brief's ownership list: `src/systems/VFX.js`, `src/ui/HUD.js`, `src/ui/Menus.js`,
`src/ui/Logbook.js`, `src/ui/hud.css`. `src/core/Harness.js`, `tools/capture.mjs`
and `src/world/*` were **read and not edited** (one accidental edit to
`tools/capture.mjs` was made during debugging and reverted with
`git checkout --` inside the same minute; `git status` confirms it clean).

Commits: `b5dff68` (numeral layer), `7ea873b` (Blight colour, run-summary tier
grouping, logbook chrome, and the RNG revision described in §1.6).

---

## 0. Arms on disk, and why the control is not `FINAL`

The tree is being edited by two other agents while I work. `reviews/round6/FINAL`
is a frozen capture of `1541fc9`; the tree I built on is `fba0a91` plus the world
and harness agents' in-flight work, and their edits alone changed the failing-shot
set from four (`04-combat`, `06-loaded-hud`, `08-explosion`, `11-bestiary`) to two.
Measuring my delta against `FINAL` would credit me with their changes, which is
the exact failure mode round 5 died of.

So every before/after below is a **pair of full captures on one tree**, my five
files reverted to `fba0a91` for the control and restored for the fix — the
isolation pattern `VERIFIED.md` records as the house standard.

| arm | directory | what it is | `clockPinned` | failing shots |
|---|---|---|---|---|
| PRE (control) | `reviews/round6/uictrl2/` | current tree, my 5 files at `fba0a91` | true | `04-combat`, `11-bestiary` |
| POST (shipped) | `reviews/round6/uifinal/` | current tree, my work | true | `04-combat`, `11-bestiary` |
| reference | `reviews/round6/FINAL/` | the critic's judged set, `1541fc9` | true | 4 (documented) |

Both arms `ready: true`, `partial: false`. **No shot fails in POST that does not
fail in PRE.** Intermediate arms named where they carry evidence:
`reviews/round6/uictrl/` (an earlier control), `uifix2`–`uifix9` (iterations).

### Instrument

`numinst.py` (scratchpad), reusing the critic's §2b mask definition verbatim:
gold ink `R 228–252, G 188–226, B 72–128`, connected components grouped into runs
by a horizontal dilation, footprint = ink dilated by 3 px.

**Calibration.** On `reviews/round6/FINAL/10-inventory.png` — the exact file the
critic measured — it returns **7 runs and 62 glyph components**, reproducing both
published counts to the digit, and its seven run boxes match six of the critic's
seven listed runs by x-extent (its `1048!` pair is returned as one component
because those two runs *abut*, which is the defect). Its footprint on that file is
13,953 px against the critic's 18,483 — a 0.755× ratio, from a different dilation
kernel. **Where a critic-comparable number matters below I state both.**

Two deliberate deviations, recorded because they change the numbers:

1. **The inventory strip is not masked out.** A run rendering behind it is the
   defect under test; masking it would let the fix hide its own evidence.
   Only HUD chrome carrying gold text of its own (`y<100`, `y>820`, `x>1560`) is
   removed.
2. **A run must be numeral-shaped**: ≥200 px of ink, ≤32 px tall, ≥3× wider than
   tall. Without this the mask also returns the equipment nova's own gold core
   and a gold tree canopy — both present identically in every arm, neither a
   readout. This is why my run counts differ from the critic's by ±1 on some
   files.

### Instrument warnings from the brief

Both honoured. I did not use a `y ∈ [90,470]` band and did not use a per-ray
gradient median anywhere. I did not re-measure or re-tune the nova wash, the
nova alpha floor, or chromatic aberration.

---

## 1. Target 1 — the damage-numeral layer

### 1.1 The headline numbers

All from the two named full captures, one instrument, one definition.

| | PRE `uictrl2/10-inventory.png` | POST `uifinal/10-inventory.png` |
|---|---|---|
| concurrent numeral runs | **7** | **4** |
| glyph components | 49 | 22 |
| numeral ink | 4,207 px | 1,568 px |
| **numeral footprint (ink + 3 px outline)** | **14,171 px (0.98 % of frame)** | **5,642 px (0.39 %)** |
| **monster px** (manifest, `monsters standing in it`) | **2,400** | **2,426** |
| **numeral : monster** | **5.90×** | **2.33×** |

**−60 % of numeral area; the ratio falls 5.90× → 2.33×.**

Stated in the critic's own units, by scaling my footprint by the 0.755×
calibration ratio established above: PRE ≈ 18,770 px, POST ≈ 7,473 px against
2,426 px of monster — **7.7× → 3.1×** on the critic's instrument. The 7.7× it
published for `FINAL` reproduces on my PRE arm to within 2 %.

`06-loaded-hud`, the paired control shot, reads **0 numeral runs in both arms** —
the fix does not disturb the frame the critic used as the normal case.

### 1.2 The four sub-defects, individually

| critic's sub-defect | PRE, on `uictrl2/10-inventory.png` | POST, on `uifinal/10-inventory.png` |
|---|---|---|
| **1. Runs collide** | runs at `x 962–1084` and `x 1091–1213`, both `y 420–438` — a **7 px gap**, returned by the instrument as one component, i.e. the `1048!1048!` string the critic photographed | four runs; smallest horizontal gap between two runs sharing a y-band is **93 px** (`x 888` → `x 981`). No two components merge. |
| **2. A run is clipped by the HUD** | run at `x 349–495, y 301–320` lies inside the strip rect `x 29–488, y 64–470` | leftmost run starts at `x 524`, clear of the strip's right edge at 488. No numeral ink from a readout inside the rect. |
| **3. No merge rule — `24012` printed three times** | 7 runs from 8 simultaneous nova hits | 4 runs; the shipped frame reads `8004!`, `26933!`, `1048!` and one low readout — all distinct, and `26933` is an accumulated total, not a single hit |
| **4. Scale relative to the subject** | 5.90× (7.7× critic-equivalent) | **2.33×** (3.1× critic-equivalent) |

### 1.3 Root cause — why three rounds of work never touched it

`DamageNumbers.spawn` already carried a concurrency gate (`NUM_MAX_RUNS = 5`
inside a 0.42 s window). **Crits bypassed it outright**, and every one of the
seven runs the critic listed ends in `!` — they are all crits. The gate had never
fired once on the shot it was written for. That single line is defects 1, 3 and 4.

### 1.4 What was implemented (`src/systems/VFX.js`)

1. **Budget over all runs, crits included.** `NUM_MAX_RUNS = 4`. A crit gets
   priority rather than a pass: it may retire the oldest live non-crit, or a run
   that has had its minimum time on screen (`NUM_MIN_SHOW = 0.22 s`). Ordinary
   hits never evict. Runs are now tracked as records — slots, trajectory, value,
   target — instead of a ring of start times.
2. **Merge rule.** Two hits on one target inside `NUM_MERGE_WINDOW = 0.6 s`
   accumulate into a single readout: the live run is retired and respawned
   carrying the sum. `target` is threaded through `_onDamage → damageNumber →
   spawn`.
3. **Spatial reservation.** A spawn's projected NDC box is tested against every
   live run's box *as it stands now* — `_box`/`_collides` reimplement
   `NumberVert`'s ballistic integration and its minimum-pixel floor on the CPU so
   the two agree — with a `NUM_SEP_PX = 30` margin. A collision is lifted
   (`NUM_LIFTS = [0, 1.0, 2.0]` m, up, with the motion, exactly as the reticle
   exclusion reasons) and dropped if no lift clears it.
4. **Strip clip, not z-order.** `NumberFrag` fades alpha to zero inside the
   strip's rect, carried as NDC (`vNdc`) so it is independent of the render
   target's size. `HUD.updateStripRect` measures `.inventory`'s live bounding
   rect and publishes it as `ctx.hud.stripRect`; it is `width: max-content` over
   a variable haul, so it is measured, never assumed, and re-measured for one
   second after any pickup or resize rather than every frame.
5. **Crit size.** The minimum-pixel floor scaled 1:1 with the size class, putting
   a crit's floor at `30 × (0.49/0.30) = 49 px` of glyph height — the largest
   type in the game and the single largest contributor to the footprint. Now
   `30 × mix(1, 1.633, 0.5) = 39 px`: still above every other numeral on screen,
   ~35 % less ink area. The halo plate is raised (`NUM_HALO_PX` 12 → 13, still
   inside the tile's ~14.4 texel padding) and its coverage 0.82 → 0.92 to hold
   legibility at the smaller size — see §1.5.

### 1.5 A regression I introduced and closed

The size cut alone broke `08-explosion`'s own `damage numbers` subject:
`reviews/round6/uifix2/manifest.json` records `sepP50 0.23` against a `0.25`
floor, `lum 63.1` against `bgLum 64.2` — a numeral landing on the fireball with a
one-point separation. The plate is what carries that separation, and it is
specified in atlas texels so it shrank with the glyph. Raising its coverage
recovers it: `reviews/round6/uifinal/manifest.json` reads `sepP50 0.25`,
**passing**. That shot's check passes in PRE and in POST.

### 1.6 The shared-RNG hazard, hit for the third time in this project

My first working version gave `DamageNumbers` a private RNG stream. That looked
correct and was wrong in an instructive way: **the original drew from the shared
cosmetic stream `ctx.fxRng`, so removing those draws shifted the phase of every
particle in the frame.** Measured, same scenario, same seed:

| arm | `10-inventory` equipment-blast px | `monsters standing in it` |
|---|---|---|
| `reviews/round6/uictrl/manifest.json` (control) | 21,486 | ok |
| `reviews/round6/uifix4/manifest.json` (numeral change, gated draws) | **56,735** | **FAIL** — perSep `0.03` on object 2 |
| `reviews/round6/uifix7/manifest.json` (private stream) | 58,988 | **FAIL** |
| `reviews/round6/uifinal/manifest.json` (shipped) | 19,488 | ok |

A numeral-only change was moving the blast's measured extent by 2.9× and pushing
that shot's monster check under its bar. The hazard is not that the layer shares
the stream — cosmetic jitter belongs on the cosmetic stream. **The hazard is that
the draw count depended on presentation gating.** The shipped version takes its
two draws immediately after the distance cull and *before* any gate, so the count
is a function of how many in-range damage events occurred and of nothing this
layer decides. `VERIFIED.md` names `archGeo` and the shrine roll as the first two
instances; this is the third, and the general rule it suggests is: **a draw from a
shared stream must never sit downstream of a decision you intend to change.**

---

## 2. Target 2 — the tractable residuals

### 2.1 Blight tier rule colour — axes 4, 10. **Fixed.**

`hud.css` had no `--t-blight`, so `.t-blight` did not exist and the tier's
`border-top: 2px solid currentColor` inherited near-white, drawing the rule at
(234,241,249) against the common tier's (230,236,244). Two tiers, one rule colour.
Added `--t-blight: #e05aa8` (matching `TIERS.blight.color` in `Icons.js`) and the
`.t-blight` rule. Visible on `reviews/round6/uifinal/10-inventory.png` (strip,
bottom tier row) and `uifinal/16-run-summary.png` (sixth block).

### 2.2 `16-run-summary` tier grouping — axes 4, 7, 10. **Fixed.**

The grid was one wrapping row of `stats.items` in pickup order. The critique read
the shipped card at 16 columns and found **five of six** tier boundaries mid-row,
and noted this screen ordered the haul magenta-first while `10-inventory`'s strip
ordered the identical haul magenta-last.

Now one shrink-wrapped block per tier, driven off the same `TIER_ORDER` the strip
uses, blocks wrapping as units so small tiers share a line, explicit rows inside a
block (`DEATH_ROW = 8`) for the `width: max-content` reason `HUD.onItemPickup`
documents. On `reviews/round6/uifinal/16-run-summary.png`: six blocks, six rules,
**zero mid-row boundaries**, magenta last on both screens.

Cost, and how it was paid: grouping adds a row and six rules, and at the old
2.9em tile the card grew past the viewport — `reviews/round6/uifix6/16-run-summary.png`
shows the headline cropped and both buttons off the bottom. Tiles are 2.2em and
the gaps tightened; `uifinal/16-run-summary.png` has the headline, the card and
both buttons on screen.

### 2.3 `ITEMS COLLECTED` used twice — axis 7. **Fixed.**

Once as a stat tile reading 1087 (stacks), once as the heading of a grid of 83
distinct items. The tile is now `Item pickups`.

### 2.4 `15-logbook` — axis 7. **Fixed** (three of the critique's four items).

On `reviews/round6/uifinal/15-logbook.png`:

- `0 / 16 RECORDED` above sixteen fully rendered entries — a counter contradicting
  the list under it — is now `16 CATALOGUED · 0 ENCOUNTERED`, which names both
  figures so neither can be read as the other.
- Entry names were the one Title Case block on a screen of uppercase tabs and an
  uppercase header. Now uppercase.
- The scrollbar (the critique's "one browser default left in the product": a 6 px
  UA thumb at L 71 on an L 13 track on an L 13 panel) now has a recessed track, a
  cut-corner thumb in the panel accent, and a Firefox `scrollbar-color`.

**Not fixed:** the model viewer's 11.8 % occupancy and its flat key. That is
camera framing and lighting in `ModelPreview`, not chrome, and I did not want to
re-frame every rig in the book on the last capture of the round.

### 2.5 Axis 6 — the explosion opacity layer. **Not worked, and the premise is refuted.**

The critique's #1 fix reads "(a) add the opacity layer — an alpha-blended dark
smoke/dust emitter … It was not done". **It is in the code**: `VFX.explosion`
emits *two* alpha-layer emitters, a 26-particle smoke column (`layer: 'alpha'`,
`alpha0 0.82`, `fadeIn 0.028`) and an 18-particle dust skirt (`layer: 'alpha'`,
`alpha0 0.55`, `soft 1.6`), the second commented as "the *opacity* layer, and the
one this effect never had". So the residual is not a missing emitter; it is that
the additive sum swamps the alpha layer at the shutter, and 0.87 % of the disc
being below background is the symptom of that, not of an absence.

That is a re-diagnosis, and my brief is explicit that this round is for landing,
not diagnosing. I did not guess at it. **Recorded as the finding, not attempted as
a fix** — and it should be the first thing the next VFX pass measures, because the
named fix has already been implemented once and did not move the number.

### 2.6 Axes 9 and 1 — **out of my file ownership.**

The critique's residual list marks 6, 7, 9 and 1 as code. Axis 9's fix is an
FXAA/SMAA resolve at the end of the post chain (`RenderPipeline.js`) and axis 1's
is a contact-shadow/AO term in the lighting pipeline. Neither file is in my
ownership list and I did not touch them.

### 2.7 Axis 5 — **not attempted, by instruction, and correctly so.**

No roughness/metalness maps exist for a shader to contrast. Nothing in this
report claims movement on axis 5.

---

## 3. Escalation: the Blight glyph polarity is a contested decision, not a bug

The critique's defect 3 has two halves. The rule colour (§2.1) is an unambiguous
defect and is fixed. The other half — "dark glyph on light plate, inverted against
the other five tiers, the axis-4 test failed" — is **a deliberate design decision
with its rationale written down**, in `Icons.js`:

> "A corrupted item has to be findable in a strip of eighty tiles *without*
> adding anything to the strip … this tier changes no elements at all and inverts
> the two it has … the tiles read as holes in the row because they are the
> photographic negative of every tile beside them."

Two agents disagree: the tier's author chose inversion for findability; the critic
scores it as an axis-4 failure. I did not overrule either.

**Options.** (a) Leave it — keeps the findability property, keeps the axis-4 and
axis-10 marks the critic took off `10-inventory` and `16-run-summary`. (b) Route
Blight through the ordinary `itemArt` path — dark plate, magenta glyph — costs the
negative-space read, gains the two axes. (c) Keep the inversion but reduce its
extremity so the tier still reads as itself without inverting the silhouette test.

**My recommendation is (b).** The findability argument is now weaker than when it
was made: with §2.1's magenta rule the tier is already the only magenta object in
the strip, so the block is findable without inverting the tiles inside it, and the
axis it costs is scored on two of the eight shots in this domain. It is roughly a
five-line change. **Not made** — it reverses another agent's documented decision
and belongs with whoever owns that call.

---

## 4. Residual axis ledger

| axis | verdict | evidence |
|---|---|---|
| **7 UI/HUD craft** | **fixed** on all three named failures | `10`'s numeral reservation and clip (§1.2); `15`'s counter, casing and scrollbar (§2.4); `16`'s tier-grouped wrap (§2.2) |
| **8 Readability under load** | **fixed** on `10-inventory` | numeral:monster **5.90× → 2.33×** (§1.1); `06` and `08` untouched, and `08`'s own damage-number legibility check still passes |
| **2 Composition & depth** | **partial** on `10-inventory` | the numeral layer no longer scatters seven gold runs across the frame; the strip's 12.9 % block and the nova's placement are unchanged and are not code |
| **4 Silhouette & form** | **partial** | Blight rule colour fixed; the polarity inversion escalated unchanged (§3) |
| **10 Cohesion** | **partial** | rule colour fixed, tier ordering now identical across strip and summary; polarity escalated |
| **6 VFX quality** | **not fixed**, premise refuted | §2.5 — the opacity layer the critique asked for is already implemented |
| **9 Post-processing** | **not fixed** — out of ownership | §2.6, `RenderPipeline.js` |
| **1 Lighting & shadow** | **not fixed** — out of ownership | §2.6 |
| **3 Colour & grade** | not attempted — asset | critique's own classification |
| **5 Material believability** | **not attempted, by instruction** | §2.7 |

---

## 5. Verification

- `node node_modules/vite/bin/vite.js build` — green. `npx` was never run.
- `node tools/capture.mjs --out reviews/round6/uictrl2 --port 5269` (control) and
  `--out reviews/round6/uifinal --port 5273` (shipped). Both `clockPinned: true`,
  `ready: true`, `partial: false`.
- **Failing shots: `04-combat`, `11-bestiary` — the same two in both arms.** No
  fifth failure, and no third: the world/harness agents' in-flight work had
  already taken the documented four down to two before I started, which the
  control arm on the same tree establishes.
- `08-explosion`'s subject checks in POST: the blast ok, monsters ok
  (`sepP50 0.61`), damage numbers ok (`sepP50 0.25`). Its "the blast" gate verdict
  was ignored as briefed.
- The `deathDissolve` trap was not touched: `resolveObject` at `VFX.js` is
  unchanged, no sibling guard, no half-fix.
- Frames inspected at full size: `uifinal/10-inventory.png`,
  `uifinal/16-run-summary.png`, `uifinal/15-logbook.png`,
  `uictrl/16-run-summary.png`, `uifix6/16-run-summary.png`.

### Numbers I am *not* claiming

- I did not reproduce the critic's 18,483 px footprint exactly; my instrument
  reads 13,953 px on the same file, and every comparison above is my instrument
  against itself with the 0.755× ratio stated wherever the critic's units are used.
- `10-inventory`'s subject measurements are phase-sensitive to `fxRng` — §1.6
  shows the same scenario measuring 19,488 / 21,486 / 58,988 px of blast across
  arms. The shipped arm passes; I am not claiming that verdict is robust to
  unrelated changes, and the instability is pre-existing and documented in
  `Harness.js`' own comments.
