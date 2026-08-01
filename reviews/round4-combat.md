# PETRICHOR — Round 4 critic report: COMBAT / VFX domain (FINAL)

Reference target: Risk of Rain 2 (Hopoo/Gearbox), Titanic Plains / Abandoned Aqueduct.
Shots judged: `shots/04-combat.png`, `shots/05-boss.png`, `shots/08-explosion.png`.
Seed 1337, 1600x900. This is the final round per `RUBRIC.md`'s stopping condition.

`shots/manifest.json`: `ready: true`, `errors: []`, `partial: false`, all eight shots
`frameErrors: 0`, `lastFrameError: null`. **No crash to report.** The pixels are the
whole case, as before.

Full-frame statistics, 2-px stride, 360,000 samples per shot:

| | 04-combat | 05-boss | 08-explosion |
|---|---|---|---|
| mean luma | 61.9 | 61.8 | 78.1 |
| sub-luma-24 coverage | 3.27% | 5.78% | 2.11% |
| clipped white (R,G,B all >250) | 0.006% | 0.006% | 0.005% |
| cool/teal coverage | 3.31% | 3.31% | 2.44% |

Exposure is healthy in all three. Round 2's crushed black (29–46%) and round 3's
blown white in 08 (1.09%) are both gone and stayed gone.

---

## 1. Axis scores

| Axis | 04-combat | 05-boss | 08-explosion | (r3 → r4) |
|---|---|---|---|---|
| 1 Lighting & shadow | 6 | 6 | 5 | 5/5/4 → 6/6/5 |
| 2 Composition & depth | 6 | 6 | 5 | 5/5/5 → 6/6/5 |
| 3 Colour & grade | 7 | 6 | 6 | 6/6/5 → 7/6/6 |
| **4 Silhouette & form** | **6** | **6** | **5** | 4/3/4 → 6/6/5 |
| 5 Material believability | 4 | 4 | 4 | 4/4/3 → 4/4/4 |
| **6 VFX quality** | **5** | **5** | **5** | 4/4/3 → 5/5/5 |
| 7 UI/HUD craft | 8 | 8 | 8 | 7/7/7 → 8/8/8 |
| **8 Readability under load** | **6** | **6** | **6** | 5/4/3 → 6/6/6 |
| 9 Post-processing | 7 | 7 | 5 | 6/6/3 → 7/7/5 |
| 10 Cohesion | 6 | 6 | 5 | 6/5/5 → 6/6/5 |
| **mean** | **6.1** | **6.0** | **5.4** | 5.2 / 4.9 / 4.2 |

```
04-combat     AXIS SCORES: 1:6 2:6 3:7 4:6 5:4 6:5 7:8 8:6 9:7 10:6   VERDICT: FAIL
05-boss       AXIS SCORES: 1:6 2:6 3:6 4:6 5:4 6:5 7:8 8:6 9:7 10:6   VERDICT: FAIL
08-explosion  AXIS SCORES: 1:5 2:5 3:6 4:5 5:4 6:5 7:8 8:6 9:5 10:5   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Only
axis 7 clears 7 in every frame. Axes 3 and 9 clear 7 in some frames. Axes 5 (4/4/4)
and 6 (5/5/5) are the two that hold the build down everywhere.

This is nevertheless the largest single-round move of the four: **+0.9 / +1.1 / +1.2**
on the shot means, and **every one of the ten axes went up or held** in at least two
frames. Nothing regressed.

### The five direct questions, answered

**(a) Damage numbers — present, upright, legible against the brightest VFX: YES.**
This is the round's best fix. `08` carries `105` at (735–815, 288–318) sitting on top
of the outer shockwave ring, the brightest non-HUD object in the frame: white glyph
body inside a near-black navy keyline with a dilated halo, fully readable at 1:1 with
no zoom. Four more readouts at (755–830, 375–412). `04` carries four at (665–745,
370–398); `05` carries five, on the Titan's own body at (800–895, 285–315) and
(758–790, 362–382). All upright, all ~18 px of ink. Round 3's 5–16/255 contrast is
gone. *Defect that remains:* simultaneous readouts land at nearly the same screen
position with no stagger, so `04` reads `1313` and `05`/`08` read `13|13|3` —
individually legible, collectively ambiguous.

**(b) Blob shadows darken rather than brighten: YES, proven — but the cue is not
delivered.** `EnemyMeshes.js:346-350` now emits premultiplied colour into
`blendSrc = DstColorFactor, blendDst = OneMinusSrcAlphaFactor`, so the composite is
`dst * (1 - a*(1 - SHADE))` with `SHADE = (0.06, 0.09, 0.16)` — mathematically ≤ `dst`
on every channel at every alpha. Confirmed in pixels: **the 286×7 px bright bar that
crossed `05-boss` is gone.** Row scans at y = 596 / 606 / 616 / 626 across x = 620→1000
find no thin bright band; the 210–226 R runs in those rows migrate leftward as y
increases, which is a sloped lit terrain facet, not a screen-aligned artefact.
Nothing anywhere in three frames is brighter under a body than beside it.
**But:** the Titan's `shadowR = 3` disc should project to roughly 260×50 px under its
feet at 33 m, and rows y = 596–616 across x = 700–850 show *no* dip at all — the
terrain there is 67–72 R, brighter than the 44–51 R to its left. There is no readable
contact shadow under the player in `04` (best measurable dip at y = 642 is 33 → 25 R,
a 24% attenuation with no elliptical footprint), none under the player in `08`, and
none under the Titan in `05`. The strongest one I could isolate is under the beetle in
`05` at y = 546, x = 576–585: the lit ledge drops 158 → 116 R (27%) and recovers. So:
**the regression is fixed; the grounding cue it was supposed to provide is not there.**

**(c) The Titan reads as a colossus with mass and a readable silhouette: MOSTLY YES —
but not as *stone*.** Measured: torso column at x = 790 is solid from y = 240 to y = 580
(340 px); raised fists reach y ≈ 215 (365 px total). Player at x = 995 runs y = 457 →
567 (110 px). **Ratio 3.1–3.3x**, versus round 3's 1.33x. (The claimed 3.9x is not
supported by the pixels; `Harness.js:762` itself predicts 3.1x, and 3.1x is what the
frame contains.) The rig is complete and grounded: hips, two legs, two feet resolving
on terrain at (730–817, 555–585) with no gap between body and ground, a tapered torso
prism stack, a glowing gold core in the waist gap at (740–830, 375–420), and two
raised arms. Facet shading is real — 65,34,42 through 131,69,29 to 211,132,64 on the
same body. R3-3 is comprehensively dead. **What still fails:** (i) the head is a flat
wide box tucked between the shoulders with two gold eye-pills facing up-left — it does
not separate as a lobe in silhouette, so the colossus's top edge is a plate;
(ii) the arms are featureless two-segment planks that terminate in a box corner, so
the "fists" carry no mass; (iii) the body is flat matte cream/tan with zero surface
variation and its lit facets (211,132,64) are indistinguishable in hue and value from
the lit terrain ramp it stands on (225,121,56) — it reads as painted plywood, not
weathered stone.

**(d) The explosion has fireball, rings and smoke rather than a flashbulb: NO — it
has rings and embers and no fireball.** It is no longer a flashbulb: clipped white in
`08` fell from 1.09% to 0.005%, and the core (`VFX.js` life 0.07 s) is correctly dead
by the 0.09 s shutter. What is visible at the blast locus is: three or four thin
concentric elliptical ring arcs, a broad diffuse warm band, ember dots, debris
streaks, a scorch/ground ring, and shake. **There is no fireball body.** At the blast
centre (790, 337) the frame reads 153,96,59 and the terrain crest and the cyan crystal
spikes behind it are *fully legible straight through the explosion*; crop
`(620,250,360,200)` at 4x shows ring lines and ~30 ember dots over unobstructed
background. The 30-blob fireball at `VFX.js` (speed 30·s, drag 7, size 0.6r→1.05r)
should be an opaque mass roughly 500 px across at that distance and is not in the
image at any measurable alpha. Nor is the smoke: there is no dark mass anywhere to
silhouette the hot layers against. Round 3 photographed all core and no layers; round
4 photographs all layers and no core — the blast now under-reads as a *ripple*, and
its two shockwave rings have expanded to ~8 m (ease-out `e = 1-(1-k)^2.6` at k = 0.2)
so they span the whole frame width and read as horizontal bands rather than as a wave
leaving a point.

**(e) Enemies distinguishable by species at a glance: YES, with one qualification.**
In `04` I can name five species by colour and shape without zooming: teal blocky
bipeds (golem) at (950–1045, 425–575) and (335–425, 335–500); magenta jellyfish with
tendrils at (60–160, 480–560); crimson spiked pest at (760–785, 448–470); orange
crab-form at (295–350, 553–620); sage-green lump at (988–1032, 585–620). `05` adds a
pink-capped/green-bodied beetle at (578–640, 478–535). Species now carry *both* hue and
silhouette. **The qualification is the crystal collision** — see the overcorrection
section below.

---

## 2. Round-3 defect register

| ID | Status | Pixel evidence |
|---|---|---|
| **R3-1** 08 is a white flashbulb | **PARTIAL** | Shutter moved to a sim-time budget (`Harness.js:1001`, `blastSeconds = 0.09`). Core gone, clipped white 1.09% → **0.005%**, rings/embers/debris/scorch all visible. **But no fireball body and no smoke mass:** blast centre (790,337) = `153,96,59` with terrain and crystals fully readable through it. The blast has layers but no *substance*. |
| **R3-2** contact shadow brighter than ground | **LANDED** (regression) / **cue not delivered** | Multiply blend, `EnemyMeshes.js:346-350`: `dst * (1 - a*(1-SHADE))` ≤ `dst` at every alpha, proven. 286×7 px bright bar **gone** — rows y=596/606/616/626 across x=620–1000 in `05` contain no screen-aligned bright band. Nothing brightens anywhere. But no blob is readable under the player (04, 08) or under the Titan (05); best measured attenuation is 27% under the beetle at 05 y=546. |
| **R3-3** Titan is a legless mauve slab | **LANDED** | Full rig: torso y=240→580 at x=790, feet on terrain at (730–817, 555–585), no body/ground gap, waist core at (740–830, 375–420), arms raised, facet range 65→211 R. |
| **R3-4** boss reads 1.33x the player | **LANDED (measured 3.1–3.3x, not the claimed 3.9x)** | Titan 340 px torso / 365 px with fists; player 110 px (y 457→567 at x=995). `Harness.js:763` `STANDOFF = 24`, `:789` `r = 9 + ring*2`, fov 36. |
| **R3-5** explosion core clipped hueless white | **LANDED** | Clipped-white coverage 0.005–0.006% in all three frames. No hueless mass anywhere. *Carve-out:* two hexagonal muzzle sprites in `04` still read `255,253,240` — see D3. |
| **R3-6** blast light erases the golem | **LANDED** | `08` golem internal contrast now spans `9,93,123` → `190,196,219` (>180/255) versus round 3's <3/255 across the whole body. Species colour survives inside the blast. |
| **R3-7** 04/05 contain no hit feedback | **LANDED** | Four readouts in `04`, five in `05` landing on the Titan itself, five in `08`. Muzzle flash visible on the player's weapon in `05` at (985–1030, 455–482). |
| **R3-8** beams are hairline wires exiting frame | **LANDED** | Full four-border scan of `04` for cyan: **zero beam pixels on any frame edge** (the 121 hits at x=1599 are crystal, `155,221,217`). The `05` beam (250,440)→(700,405) now has a hot core, a soft halo and a muzzle bulb at the golem, and terminates on the Titan. |
| **R3-9** damage numbers near-white on white | **LANDED — best fix of the round** | `105` at 08 (735–815, 288–318): white body, near-black navy keyline, dilated halo, legible at 1:1 over the brightest VFX in the build. |
| **R3-10** 6–7 px chromatic aberration | **PARTIAL** | `04` right edge shows no per-channel offset at all; `05` shows one green pixel at x=1554. `08` still splits: y=200 x=1582–1585 = `241,29,27` (pure red band) beside a yellow band; y=130 R leads G by 3 px. **~3–4 px separation remains in the shake frame** against a target of under 1 px. |
| **R3-11** 700-px hard-edged star flare | **LANDED** | No star sprite anywhere in `08`. Flare is now `r*1.15` with `soft = 1.5`; the spoked lens sticker is gone. |
| **R3-12** unattributed disc on the player's head | **NOT LANDED** | Still present in `04`, barely moved: a ~55 px soft translucent blue-grey sphere containing a pale spire and small cubes at **(628–672, 402–442)**, immediately left of the player's helm. Crop `(600,380,110,80)` at 8x. Second-highest-contrast object in the centre of frame; it reads as a lens smudge. |
| **R3-13** enemies take no shading | **LANDED** | `04` golem facets: `148,226,230` / `105,135,143` / `17,88,118` — >130/255 range on one body, versus round 3's ≤6/255. |
| **R3-14** declutter fuses enemy with player | **PARTIAL** | The red pest on the shoulder is gone, but a teal golem at (752–800, 455–555) still touches the player's right pauldron and a crimson pest cap pokes out between them at **(764–783, 451–467)** — at 1:1 it reads as a red growth on the survivor's armour. Crop `(690,420,130,130)` at 7x. |

**Score: 10 LANDED, 3 PARTIAL (R3-1, R3-10, R3-14), 1 NOT LANDED (R3-12).**
Nothing regressed. R3-2 is counted LANDED because the defect as written — a shadow
brighter than its ground — is provably eliminated; the follow-on is filed as D2.

---

## 3. Overcorrection check — the teal crystal accent

**Your read is CONFIRMED in placement and ratio, REFUTED in raw quantity.**

Measured cool/teal coverage, 2-px stride:

| | total teal | bright teal (luma > 150 — crystal props) | mid teal (enemy bodies) | thirds L / C / R |
|---|---|---|---|---|
| 04 | 3.31% | **2.17%** | 1.14% | 2035 / 3810 / **6074** |
| 05 | 3.31% | **2.72%** | 0.59% | **7426** / 931 / 3556 |
| 08 | 2.44% | 1.65% | 0.79% | 1851 / 2239 / **4708** |

3.3% of frame is not, by area, an excessive accent — one cool accent in a warm world
is correct and it is doing real work for the palette (axis 3 in `04` is the highest
non-HUD score in the build partly because of it). **What is overcorrected is the
ratio and the placement:**

1. **Environment teal outweighs enemy teal 1.9:1 in `04` and 4.6:1 in `05`.** The
   colour that identifies a species is now mostly furniture. Crystal `136,218,216`
   versus golem `93,165,183` is the same hue family at 1.4x the value — the props are
   *louder* than the monsters wearing the species colour.
2. **The clusters stack.** `04` carries five distinct crystal masses — (786–885,
   316–405), (895–968, 332–402), (1232–1330, 468–566), (1288–1420, 540–662),
   (1408–1600, 505–706) — three of them in the right third, and the last **bleeds off
   the right frame edge for 121 consecutive rows** (x=1599, y=538–546 and 581–700+).
   The pair at (786–968, 316–405) sits directly behind the player and under the
   crosshair, in the frame's focal area, where at 1:1 the spikes read as a spiky
   creature.
3. **They are the brightest non-VFX objects in a mean-luma-62 image** (crystal
   192,238,226 → luma 224). Value that high should be reserved for the player, the
   enemies and the threats.

Concrete fix: drop the crystal emissive/albedo so props sit at luma ≤ 140 (below the
golem's lit facets), keep clusters out of the horizontal 40–60% band of the frame in
`combat`, and cap them at two per frame. This costs the palette nothing and buys back
axis 8 and axis 4.

No other overcorrection found. The core-radius change (r*1.7 → r*0.7–1.25) did not
overshoot into invisibility — the core is simply *expired* at the chosen shutter,
which is a timing issue, not a sizing one. The blob-shadow change *did* overshoot:
the correction from "too bright" landed on "not present" (D2).

---

## 4. FINAL PER-AXIS VERDICT — does it clear 7 in this domain?

| # | Axis | Clears 7? | Honest reason, and what it would take |
|---|---|---|---|
| 1 | Lighting & shadow | **NO** (6/6/5) | The key direction is committed and enemies finally take real directional shading (R3-13 landed, >130/255 across a golem). Two things hold it at 6: **no ambient occlusion anywhere** in three frames — no darkening in any crevice, at any object/ground junction, or under any overhang — and **no readable contact shadow** (D2). **Fully code-fixable.** AO is a shader/generator problem (SSAO in the pipeline, or vertex AO baked by the terrain generator, which is free at runtime); the contact shadow needs its alpha and radius raised and the grazing fade relaxed. Neither needs an authored asset. |
| 2 | Composition & depth | **NO** (6/6/5) | Fog/value separation on the distant mountains is genuinely good and the floating islands give a real midground. Held at 6 by clutter and dead space, not by depth: `04` gives ~25% of the frame to featureless dark ground in the lower left, `05` is slashed by three pure-black dead trees through the right half, `08` has three competing VFX centres (blast rings, player level-up aura, ground ring) with no single locus. **Code-fixable** — this is scenario framing (`Harness.js`) and prop placement, not art. |
| 3 | Colour & grade | **NO** — clears 7 in `04` only (7/6/6) | The warm-ochre / violet-shadow split is right, the accent is right, and there is no clipping (0.005–0.006%) and no crush (2–6%). `05` loses a point because it is *too* limited — the Titan, the ground, the cliff and the sky are all one ochre family and separation is by value alone. `08` loses one to the wide orange band flattening the upper third to a single value and to the edge fringing. **Code-fixable** (push a secondary hue into the boss's material set; clamp the aberration). |
| 4 | Silhouette & form | **NO** (6/6/5) | The largest gain of the round — the player reads at a glance, the Titan reads as a colossus at 3.1x, species carry distinct forms. Three things keep it off 7: the Titan's **head does not separate in silhouette** (a flat plate between the shoulders) and its **arms are planks with no fist mass**; the crystal props mimic enemy silhouettes at higher value than the enemies; the unattributed sphere at (628–672, 402–442). **Mostly code-fixable** — the Titan is a procedurally assembled rig, so a neck offset and a fist box are edits to `EnemyMeshes.js`, not to a mesh file. The residual — a colossus whose plate joints and shoulder mass have hand-authored intent — is the asset ceiling. |
| 5 | Material believability | **NO** (4/4/4) — the domain's floor | Every surface in three frames is one matte fill. Rock, the Titan's body, monster plates and crystal all have the same specular response (which is: none). The only material read in the build is the terrain's lit-edge rake. This did not move in four rounds. **This is the one axis that is substantially a hand-authored-asset ceiling.** Flat-shaded untextured primitives cannot deliver roughness contrast; RoR2's low-poly rock reads as rock because it carries hand-painted albedo and normal detail. That said, roughly half the gap *is* code-reachable and has never been attempted: an environment probe or matcap so metal gets a specular highlight, a per-species roughness/metalness split (the round-3 note about `dark` at 0.9 and `body` at 0.82 being indistinguishable is still true), and a cheap triplanar noise break-up on the terrain roughness. Those would plausibly buy 4 → 6. Getting to 7 needs authored texture. |
| 6 | VFX quality | **NO** (5/5/5) | Real progress: tracers taper, beams have a core + halo + muzzle bulb, damage numbers are a properly layered mark, embers and debris are dense, nothing is a lens sticker any more. Held at 5 by two things. First, **the peak-VFX frame has no fireball** — an explosion whose centre you can see the terrain through is not an explosion (D1). Second, **the muzzle flashes are hard-edged clipped-white hexagons** (D3) — the rubric's literal 4-point description, present twice in `04`. **Entirely code-fixable.** The fireball is a particle-parameter and shutter-timing problem; the hexagon is a sprite-atlas/alpha-falloff problem. |
| 7 | UI/HUD craft | **YES** (8/8/8) | The only axis at target, and it went up again. Angular segmented health bar with level rail, difficulty meter with segment ticks, objective ribbon, boss bar with `TELEPORTER BOSS` subtitle and a segmented fill, ability tray with keybind chips, gold readout, stage tag. Dense, hierarchical, consistently styled, never over the action, and it holds up over the brightest frame in the build. Do not touch it. |
| 8 | Readability under load | **NO** (6/6/6) — the closest miss | Moved 5/4/3 → 6/6/6. Player findable instantly in all three, species colour-coded and shaded, threats visible, damage numbers legible over the brightest VFX. It misses 7 on four specific things, all small: the crystal/golem hue collision at a 1.9:1 area ratio, overlapping readouts producing `1313`, the golem fused to the player's pauldron with a pest between them (R3-14 partial), and the unattributed sphere. **All four are code/data fixes.** This is the axis most likely to clear 7 in one more pass. |
| 9 | Post-processing | **NO** — clears 7 in `04` and `05` (7/7/5) | Bloom is restrained and on emissives, AA is clean, no banding, no clipping, grain and vignette are subtle. `08` alone fails on **~3–4 px of RGB separation at the frame edge** — a saturated `241,29,27` red band beside a yellow band at (1582–1585, 200), R leading G by 3 px at (1568–1573, 130). Round 3's 6–7 px was halved but not fixed; the target is under 1 px. **Code-fixable in one clamp** (`RenderPipeline.js` aberration cap, and the shake coefficient that lets `addShake(0.5)` alone saturate it). |
| 10 | Cohesion | **NO** (6/6/5) | Better than round 3 now that monsters take shading and the Titan shares the terrain's palette. Three things still read as different asset sets: the crystal props (bright, synthetic, higher value than any creature), the pure-black unshaded dead trees in `05`, and the blast's thin ring-line vocabulary in `08` against an otherwise volumetric world. **Mixed** — the crystals and trees are shading/palette fixes in code; a world that reads as one authored place at a 9 needs art direction applied to assets. |

**Summary: 1 axis of 10 clears 7 in every frame (7). 2 more clear it in some frames
(3 in `04`; 9 in `04` and `05`). 7 axes clear it nowhere.**

**The honest closing position after four rounds:** the domain went 4.6/4.0/3.7 →
6.1/6.0/5.4. Every defect that was a *bug* — an inverted shadow, a buried rig, a
mis-timed shutter, an unclamped beam, invisible text, a blown-out light — has been
found and, with two exceptions, fixed. What remains splits cleanly in two:

- **Fixable in code, not attempted or not finished:** AO (axis 1), the fireball body
  (axis 6), the hexagon sprites (axis 6/9), the aberration clamp (axis 9), the
  crystal placement and value (axes 3/4/8/10), the blob's delivered strength (axis 1),
  scenario framing dead space (axis 2), the Titan's head and fists (axis 4). Any one
  more round targeting these would plausibly land axes 1, 2, 4, 8, 9 at 7.
- **An asset ceiling:** axis 5, and the top third of axis 10. Untextured flat-shaded
  primitives cannot produce roughness contrast or surface story, and no shader trick
  fully substitutes for hand-painted albedo and normal detail. Axis 5 has not moved
  in four rounds for that reason, and it is the reason a PASS is not reachable from
  code alone.

---

## 5. Remaining defects, ranked

### D1 — `08-explosion` has no fireball body — axes 6, 4, 2, 10
`src/systems/VFX.js` fireball emitter (30 blobs, `speed = 30*s`, `drag = 7`,
`size0 = r*0.6`, `size1 = r*1.05`, `FRAME.SMOKE`) and smoke column
(`fadeIn = 0.028`, `alpha0 = 0.62`), against `src/core/Harness.js:1001`
(`blastSeconds = 0.09`).

**Pixels.** Blast centre (790, 337) reads `153,96,59`. Crop `(620,250,360,200)` at 4x:
the terrain crest, the two cyan crystal clusters at (636–722, 362–478) and
(712–768, 392–448), and the far rock spire are all fully legible *through* the
explosion. Horizontal profile at y=330: `740:141` `780:142` `820:100` `860:74`
`900:67` — the warm mass is ~140 px wide. By the emitter's own arithmetic the blobs
are 3.0 m out at 0.09 s at ~4.1 m diameter, which at that distance is a ~500 px
opaque mass. It is not in the image. There is likewise no dark smoke mass anywhere.

**Fix.** Two things, in order. (1) Find out why the fireball is not compositing —
check the additive ceiling in `ParticleShader` against 30 overlapping sprites, the
`soft = 1.2` depth fade against a blast 4.5 m off the ground, and `alphaPow`. A layer
that the math says is a 500 px opaque ball and that measures 140 px of haze is not a
tuning problem, it is a layer that is being suppressed. (2) Once it composites, move
`blastSeconds` to 0.11–0.13 as the code's own comment recommends, so the blobs are
lobed rather than a single sphere.

### D2 — No contact shadow is readable under anything — axes 1, 4, 8
`src/entities/EnemyMeshes.js:346` (`a = (core*0.62 + ring*0.16) * vFade *
smoothstep(0.05, 0.22, vGraze)`), `:432` (`fade = 0.85 * k*k * (1 - a.death) * scale`),
`src/entities/CharacterMesh.js:562` (`blob.scale.setScalar(0.8)`).

**Pixels.** No blob is identifiable under the player in `04` or `08`, nor under the
Titan in `05` where a `shadowR = 3` disc should be a ~260×50 px ellipse — rows
y = 596/606/616 across x = 700–850 measure 67–72 R against 44–51 R further left, i.e.
brighter, not darker. Best measurable attenuation in three frames is 27% under the
`05` beetle at y = 546.

**Fix.** The blend is right; the strength is not. Raise the core term (`0.62` → ~0.85),
darken `SHADE` toward `(0.03, 0.04, 0.09)`, drop the grazing fade's lower knee to
`smoothstep(0.02, 0.12, vGraze)` — the bar it was written to kill was a shader bug,
not a low-elevation camera — and widen the player's blob from `0.8` to ~1.3 so it is
proportional to the character's footprint. Verify against this exact `05` frame: the
Titan's disc must produce a measurable dip at y = 596–616, x = 700–850.

### D3 — Enemy muzzle flashes are clipped-white hard-edged hexagons — axes 6, 9, 8
Two in `04`, at (192–235, 323–352) and (487–523, 393–420). Crop `(175,305,90,70)`
at 10x: a **geometrically hexagonal** sprite at `255,253,240` with a hard six-sided
alpha edge and an untapered trapezoid skirt below it. These are the brightest objects
in the frame and they are not threats, targets or feedback. They are round 2's V5
defect, now visible for the first time.

**Fix.** Give the flash sprite a radial alpha falloff so its edge is not the polygon
boundary, and bring its emitted colour under the additive ceiling so it tints hot
instead of clipping — the same fix that worked on the explosion core.

### D4 — Crystal props out-shout the enemies wearing the same colour — axes 8, 4, 3, 10
Five clusters in `04`, one bleeding off the right frame edge for 121 rows; bright teal
2.17% of frame versus 1.14% for every enemy body combined. Crystal `192,238,226`
(luma 224) is brighter than any monster in a mean-luma-62 image. Fix: cap prop
luminance below the golem's lit facets, cap cluster count, and keep them out of the
central 20% of the frame in `combat`.

### D5 — R3-12: the unattributed translucent sphere is still beside the player's head
`04` at (628–672, 402–442). Crop `(600,380,110,80)` at 8x: a ~55 px soft blue-grey
sphere containing a pale spire and small cubes. Four rounds, three reports, still
unowned. Whatever it is, it must not be drawn in the centre 20% of the frame behind
the player.

### D6 — R3-14 partial: golem fused to the player's pauldron, pest between them
`04`: golem at (752–800, 455–555) touching the player's right shoulder plate, with a
crimson pest cap at (764–783, 451–467) reading as a growth on his armour. The screen-
overlap rejection in `declutter` needs a larger radius than the player's own
silhouette, and it needs to push in azimuth, not only in depth.

### D7 — R3-10 partial: 3–4 px RGB separation at the edges of `08`
`(1582–1585, 200)` = `241,29,27` beside a yellow band; R leads G by 3 px at
`(1568–1573, 130)`. Halved from round 3, still 3–4x over a "subtle lens" budget, and
only in the shake frame — so the shake coefficient, not the base, is the term to cut.

### D8 — Simultaneous damage readouts stack into ambiguous strings
`04` reads `1313`, `05` and `08` read `13|13|3`. Individually legible, collectively
unparseable. Fix: jitter spawn azimuth and rise speed per readout, or merge readouts
landing within ~20 px into one accumulated number.

### D9 — The Titan's head does not separate in silhouette; its fists carry no mass
`05`, crop `(700,200,340,140)` at 4x: the head is a low wide box between the
shoulders with two gold eye-pills facing up-left, and each arm is a two-segment plank
terminating in a bare box corner. A colossus reads by a head lobe over a shoulder mass
and by hands heavier than forearms. Both are edits to the procedural rig.

---

## Appendix — commands run

Read-only throughout. **No project file was modified. `tools/capture.mjs` was NOT run.**

- `Read` on `RUBRIC.md`, `reviews/round3-combat.md`, `shots/manifest.json`, and the
  three PNGs.
- `Read` / `Grep` on `src/entities/EnemyMeshes.js` (shadow shader, blend state,
  `updateShadow`, `newRig`), `src/entities/CharacterMesh.js` (player blob),
  `src/systems/VFX.js` (`explosion`, `RingPool`, `RingVert`/`RingFrag`, number scale
  constants), `src/core/Harness.js` (`ahead`, `declutter`, `boss`, `explosion`,
  `camAt`, `STANDOFF`, ring radius, `waitSim`).
- PowerShell + `System.Drawing` nearest-neighbour crops at 2–10x into the session
  scratchpad: Titan (whole / head-and-arms / feet), the `05` player, the `05` beam,
  the `05` beetle, the `04` player, the `04` golem, the `04` shoulder fusion, the
  `04` head sphere, the `04` hexagon muzzle flash, the `04` left-third beams, the
  `04`/`05`/`08` ground bands, the `08` golem, the `08` blast (wide and 4x core),
  the `08` right-edge fringing, and all six damage-number groups.
- PowerShell + `GetPixel` point sampling at 80+ named coordinates; horizontal row
  scans at y = 628/630/634/636/640/642/648/650 (`04`), y = 534/538/542/546 and
  560/596/600/606/616/626 (`05`), y = 612/625/730 (`08`); vertical profiles at
  x = 730/990 (`04`), x = 790/995 (`05`), x = 1000 (`08`).
- 1-px row scans across high-contrast edges at (1560–1590, y=130), (1555–1585, y=200)
  and (95–125, y=780) in `08`, and (1480–1520, y=200) in `04`, (0–40, y=300) and
  (1530–1570, y=250) in `05`, for the chromatic-aberration measurements.
- Full-frame statistics, 2-px stride, 360,000 samples per shot: mean luma, sub-luma-24
  coverage, clipped-white coverage, cool/teal coverage, teal split by luma 150 and by
  horizontal third.
- Full four-border cyan scan of `04` (all 900 rows of x=0 and x=1599, all 1600 columns
  of y=0 and y=899) — the proof that no attack beam exits the frame.
