# FIX-realms — round 6

Every number below names the PNG it was decoded from. Decoder: a minimal
PNG inflate + CIE-Lab/hue probe written for this pass (scratchpad, not
committed); `dE76` is over the **whole 1600×900 frame's mean Lab** unless the
line says `crop`, where `crop` = the middle 70 % × 68 % of frame (HUD excluded).

## Where the "before" numbers come from, and a correction to the brief

The five defects in the brief were measured on **pre-`f9b47c4` code**. The
round-6 baseline (`reviews/round6/base/`, code = `fba0a91` = `f9b47c4`) already
contains a predecessor's unreported partial fix to `src/data/realms.js`,
`src/world/realms/*` and `src/ui/hud.css`. Re-measuring the five against
`reviews/round6/base/` — which is what the hard constraint requires — **three of
them no longer reproduce.** They were fixed in `f9b47c4` and never written up.

Baseline capture reproduced independently: `reviews/round6/realms-pre1/`
(my own run, unmodified code) matches `reviews/round6/base/realms/` to within
0.4 dE76 on all four realm frames. Two full runs of the final code
(`reviews/round6/realms/`, `reviews/round6/realms-rep/`) are identical to 0.0
dE76 and byte-identical on every `perPx`.

> **Caveat on `base/realmsA` and `base/realmsB`.** Those two of the five
> baseline realm runs disagree wildly with the other three — `22-realm-bazaar`
> ranges L 31.4 / 46.1 / 64.2 across `realmsA` / `realms` / `realmsB` at an
> identical engine clock (1.883 s) and seed. `realmsA`'s frame is a visibly
> different room (no ceiling, no columns, half the light). Nothing I ran on this
> machine reproduced that spread — six consecutive runs all landed on the
> `realms` value — so I have used `base/realms` throughout and flagged the other
> two rather than averaging a distribution I cannot reproduce. **If `realmsA`/`B`
> were captured on this code, the realm capture is non-deterministic on some
> machines and every realm colour number in this repo is soft.** That is worth
> one agent-hour to settle and I did not have it.

## Verdict on each of the five

| # | defect | verdict |
|---|---|---|
| 1 | realms 12.5 dE apart vs biomes 28.5 | **partially reproduced, partially fixed** |
| 2 | hub and kill-pit photometrically identical | **did not reproduce** |
| 3 | three endings, one headline | **did not reproduce** |
| 4 | anchors colour-match the floor, not the Herald | **reproduced and fixed** |
| 5 | the Fracture commits (reference, not a defect) | **reproduced, confirmed** |

---

### 1. Inter-realm separation — partially reproduced, partially fixed

**The headline claim does not reproduce.** Decoded from
`reviews/round6/base/realms/{22-realm-bazaar,23-realm-crucible,24-realm-vault}.png`
and `reviews/round6/base/13-biomes-{1,2,3,4}.png`:

| | claimed | measured on the round-6 baseline |
|---|---|---|
| mean inter-realm dE76 | 12.5 | **26.3** |
| mean inter-biome dE76 | 28.5 | **26.5** |

The realms already sit as far apart as the biomes do. **The sub-claim does
reproduce**: the tightest realm pair and the vault's distance to biome 4 were
both under the biomes' own tightest pair (`13-biomes-1` ~ `13-biomes-4`, 13.7).

| pair | before (`base/realms/`) | after (`reviews/round6/realms/`) |
|---|---|---|
| crucible ~ vault | **18.0** (tightest realm pair) | **29.2** |
| bazaar ~ vault | 26.9 | 23.8 |
| bazaar ~ crucible | 34.2 | 33.7 |
| **mean inter-realm** | **26.3** | **28.9** |
| vault → biome 4 | 9.8 | 9.8 |
| vault → biome 4, crop | 13.9 | 10.4 |

Fixed: the tightest realm pair, 18.0 → 29.2, and the mean, 26.3 → 28.9 (vs 26.5
between biomes). **Not fixed: the vault is still 9.8 dE76 from biome 4**, still
under the 13.7 biome-to-biome floor, and on the HUD-excluded crop it got
*worse* (13.9 → 10.4). Reported as a partial fix, not a fix.

**The cause, which is worth more than the number.** The vault's walls are
authored `0x0d0b0a` — true black, deliberately, so the gold reads against them.
`src/shaders/GradeShader.js` carries a cool-shadow pedestal,
`uLift = (0.016, 0.020, 0.048)` applied as `col*uGain + uLift*(1-col)`. A
surface with no light of its own therefore does not render black; **it renders
the lift**. Decoded from `reviews/round6/base/realms/24-realm-vault.png`, wall
band `[100,230]-[500,450]`: RGB 37,33,57, **hue 247.5**, b\* −15.4. Forty-odd
per cent of a gold treasury's frame was the shader's blue pedestal. Same crop in
`reviews/round6/realms/24-realm-vault.png`: RGB 112,83,32, **hue 40.6**,
b\* +33.5. Whole-frame b\* −2.4 → +7.9. The room is now gold instead of navy,
which is the part of this defect that is about identity.

**Four configurations measured, because the intuitive direction is wrong.**

| config | file | full L | full b\* | dE76 → biome 4 | crop dE76 |
|---|---|---|---|---|---|
| baseline | `base/realms/24-realm-vault.png` | 21.5 | −2.4 | 9.7 | 13.9 |
| + gilding, weak washes | `realms-w1/24-realm-vault.png` | 23.6 | −1.6 | 8.7 | 13.4 |
| + strong wall/roof washes | `realms-w2/24-realm-vault.png` | 25.8 | +3.9 | **6.4** | 9.7 |
| dim gilding, key 150 | `realms-w4/24-realm-vault.png` | 22.2 | −4.0 | 10.7 | **15.3** |
| **shipped** | `realms/24-realm-vault.png` | 27.4 | +7.9 | 9.8 | 10.4 |

Two findings in that table. **Every lumen added to the vault walks it toward
biome 4**, because biome 4 is itself a mid-dark warm frame (L 28.7, a\* 14.2,
b\* 1.3) — `w2` lit the room properly and scored the *worst* distance of any
configuration. And **`w4` scores best on the crop metric by being bluer**
(b\* −4.0), i.e. by keeping more of the pedestal: the metric rewards the defect.
I shipped the configuration that fixes the wall's hue and the tightest realm
pair rather than the one that scores best, and I am flagging that trade rather
than burying it.

### 2. The hub and the kill-pit — did not reproduce

Claimed: meanL 52.5 (hub) vs 52.4 (pit), pit brighter at the median.
Decoded from `reviews/round6/base/realms/22-realm-bazaar.png` and
`.../23-realm-crucible.png`:

| | hub | pit | gap |
|---|---|---|---|
| mean L\* | 46.1 | 18.1 | **28.0** |
| mean luma (0-255) | 110.9 | 43.0 | **67.9** |
| median luma | 89.7 | 38.1 | 51.6 |
| p90 luma | 179.7 | 55.8 | 123.9 |

The hub is 2.6× the pit's light level and brighter at every percentile. Already
fixed in `f9b47c4` (`src/data/realms.js`, the bazaar/crucible `air()` blocks).
Unchanged by me; after (`reviews/round6/realms/`): gap 27.6 L\*, 67.0 luma.

### 3. Three endings, one headline — did not reproduce

Claimed identical within 0.5/255. Brightest 0.4 % of the upper-centre band of
`reviews/round6/base/realms/28-finale-victory.png`,
`.../29-ending-obliterate.png` and `reviews/round6/base/16-run-summary.png`:

| pair | dE76 | max channel delta | Δluma |
|---|---|---|---|
| victory ~ obliterate | 90.0 | 121.3 / 255 | 74.4 |
| victory ~ death | 74.0 | 139.3 / 255 | 113.0 |
| obliterate ~ death | 32.2 | 112.8 / 255 | 38.6 |

Victory is magenta (197,108,211), obliterate is pale teal (135,230,224), death
is white-red. The smallest separation between any two is 112.8/255, not 0.5.
Fixed in `f9b47c4` (`src/ui/hud.css` `[data-ending]` block) — another agent's
file, untouched. Re-measured after on `reviews/round6/realms/28`, `/29` and
`reviews/round6/realms-main/16-run-summary.png`: identical to three digits.

### 4. Rift Anchors colour-match the floor — reproduced and fixed

Reproduced in weakened form. Chroma-weighted mean hue over fixed crops of
`reviews/round6/base/realms/26-finale-phase2.png` → `reviews/round6/realms/26-finale-phase2.png`:

| crop | before | after | floor | Herald |
|---|---|---|---|---|
| left anchor `[365,390]-[460,480]` | **258.5°** | **275.0°** | 251.6° → 251.7° | 277.0° → 270.7° |
| right anchor `[995,350]-[1075,420]` | 279.8° | 285.4° | | |
| near anchor `[960,690]-[1140,890]` | **255.0°** | **271.7°** | | |

Before: two of three anchors sat 3.3° and 6.8° from the floor they stand on and
18–22° from the Herald they ward. After: all three are 20–34° off the floor and
1.0–14.7° from the Herald.

The engine telemetry says the same thing, from
`reviews/round6/base/realms/manifest.json` → `reviews/round6/realms/manifest.json`,
subject `the rift anchors` on `26-finale-phase2`:

| | before | after |
|---|---|---|
| union px | 2770 | **4463** |
| perPx | [2020, 466, **284**] | [3370, 698, **395**] |
| perSep (median separation) | [0.31, 0.31, **0.13**] | [0.77, 0.83, **0.55**] |
| check | **fails** (`minPerPx` 200, `minSep` 0.25) | **passes** |

Cause: the anchor's body is an ordinary `warded` elite and wears that affix's
tint, `ELITE.warded.tint = 0x6a4ad0` (`src/entities/EnemyMeshes.js:189`) — hue
256, which is the *floor's* hue. The Herald-coloured crown existed but was
parented to `stage.root`, so it was neither part of the object the harness
measures (`anchor.rig.root`) nor visually attached to the anchor.

Fix (`src/world/realms/FinalBoss.js`): the crown is parented to the anchor's own
rig, enlarged, and joined by an additive faceted shell at `HERALD_HOT` drawn
over the body. The shared elite materials every other warded monster in the game
uses are not touched. `_updateWardArt` loses its per-frame position copy (the
crown now rides the rig, including its spawn-scale ramp).

### 5. The Fracture commits — reproduced, confirmed as the reference

`reviews/round6/base/realms/25-finale-phase1.png` against the four biomes:
dE76 24.6 / 49.3 / 55.3 / 65.6. Its *nearest* biome is further away than the
bazaar's (12.3) or the vault's (9.8), and its furthest is 65.6 — the same order
as the 62.3 in the brief. After (`reviews/round6/realms/25-finale-phase1.png`):
25.3 / 50.0 / 56.0 / 66.2, unchanged, as intended.

---

## Also fixed (not one of the five)

**`24-realm-vault` certified a survivor at zero pixels.** From
`reviews/round6/base/realms/manifest.json`: subject `the survivor`, `px: 0`,
`present: false`, `minPx: 250`. The survivor was placed at radius 19 on the
camera's own bearing with the lens at 20.5 — a metre and a half behind it and
above its head. A treasury shot with no person in it has no scale cue; the chest
is only "enormous" against something. `src/world/realms/RealmHarness.js` now
places it at mid-room, a third of a radian off the camera line.
After (`reviews/round6/realms/manifest.json`): **`px: 518`, `sepP50: 0.41`,
passes**, with the chest unmoved (1852 → 1809 px against a 1400 floor) and the
warden at 2680 px against 700.

## Gates

**Realms capture** (`reviews/round6/realms/manifest.json`, two identical runs,
the second at `reviews/round6/realms-rep/`): failing shots **3 → 1**.
Closed: `26-finale-phase2` (the rift anchors), `24-realm-vault` (the survivor).
Still failing: `23-realm-crucible`, subject `the trial wave`, `perPx
[2184, 116, 1026]` against `minPerPx` 210 — one wave member is a half-metre mite
at ~10 m. Pre-existing, unchanged by this work, not one of the five, not touched.

**Main capture** — `node tools/capture.mjs --out reviews/round6/realms-main
--port 5205`. `reviews/round6/realms-main/manifest.json` vs
`reviews/round6/base/manifest.json`: **4 failing shots before, 4 after**, the
same four (`04-combat`, `08-explosion`, `09-survivors`, `11-bestiary`) with the
same failing subjects. No regression.

**Build**: `npx vite build` green.

## Files changed

- `src/world/realms/FinalBoss.js` — ward art parented to the anchor rig, enlarged, Herald-hue shell.
- `src/world/realms/RealmArena.js` — `buildVault`: emitted gilding (fillets + frieze), key reach pulled in, and a comment block recording the four measured configurations and why lighting the wall is the wrong direction.
- `src/world/realms/RealmHarness.js` — `realmVault` survivor placement.

Nothing outside the ownership list was edited. `src/data/realms.js` was
considered (the vault's `air()` hemisphere) and deliberately left alone: the
same effect was reachable from `RealmArena.js`, which is unambiguously mine.

## Note for whoever runs next

The captures in this report were taken from a **detached worktree at `fba0a91`**
with only my three files patched in, because `src/world/Materials.js` in the
main tree was mid-edit and unparseable (`node --check` → `SyntaxError: missing )
after argument list` at line 589) for the duration of this pass — the same class
of block that killed my predecessor. The worktree is at
`C:\Users\tpzap\source\repos\OllieFace-r6realms` and the three patched files
there are byte-identical to the main tree's. Since the round-6 baseline was also
captured at `fba0a91`, this makes the comparison cleaner, not dirtier: my numbers
and the baseline's differ by my three files and nothing else.
