# Critic — Round 1, hidden realms / finale / endings

Nine shots in `shots/realms/`, manifest `ready: true`, `errorCount: 0`,
`subjectsOk: true`, `subjectFailures: []`. No shot crashed, no frame is black,
no frame is single-colour. So the rubric's automatic-fail conditions do not
apply and every frame gets scored on its pixels.

**Method.** I did not run capture (instructed not to). Every number below is
decoded from the shipped PNGs in `shots/realms/` and, for the base game,
`shots/`. Colour statistics are taken over a HUD-free mask (top 115 rows, the
HP bar, the ability bar and the stage-label block removed). Manifest `frac`
values are directly screen fractions — the subject mask is 480×270
(`src/core/Harness.js:1176`), the same aspect as the 1600×900 frame.

**Overall: FAIL.** Mean axis score across the nine shots is **4.5/10**. Best
frame is `24-realm-vault` at 5.4; worst are `21-realm-gateways` and
`23-realm-crucible` at 3.9. Nothing here reaches the 7-on-every-axis bar, and
seven of the nine shots have at least one axis at 3.

---

## The five questions, answered with numbers

### 1. Do the three realms read as genuinely different places? **No — measurably not.**

Mean-colour dE76 over the HUD-free frame:

| pair | dE76 |
|---|---|
| Hollow Market ↔ Crucible | **11.0** |
| Crucible ↔ Gilded Vault | **11.2** |
| Hollow Market ↔ Gilded Vault | **15.4** |
| *realm mean* | **12.5** |
| ordinary biome 1 ↔ 2 | 25.1 |
| ordinary biome 1 ↔ 3 | 38.3 |
| ordinary biome 1 ↔ 4 | 15.8 |
| ordinary biome 2 ↔ 3 | 41.6 |
| ordinary biome 2 ↔ 4 | 21.9 |
| ordinary biome 3 ↔ 4 | 28.5 |
| *ordinary biome mean* | **28.5** |

The three realms are **less than half as distinct from one another as the four
ordinary biomes already are.** And each realm is *closer to ordinary biome 4*
than any two ordinary biomes are to each other: Market→B4 **9.8**,
Crucible→B4 **8.8**, Vault→B4 **9.7**.

Dominant hue (saturation·value-weighted circular mean): Market **330°**,
Crucible **358.7°**, Vault **18.8°** — one 49° arc through magenta→red→amber,
which is the base game's own dominant band (biome 1 = 11.1°, biome 4 = 352.8°).
Compositionally all three are the same room: a circular floor with a concentric
inlay ring, a curving back wall, a dark cone ceiling, warm point lights at wall
height. RoR2's Bazaar Between Time (blue/gold), Void Fields (black/red) and
Gilded Coast (white/gold) share no key at all. These three share one.

Only the finale escapes: `25/26/27` sit at hue 249–260°, saturation 0.64–0.68,
dE 62.3 from ordinary biome 1. **The Fracture is the one place in this
submission that is unmistakably somewhere else.**

### 2. Does the Hollow Market read as safe? **No.**

Against the Crucible, on the identical HUD-free mask:

| | meanL | medianL | p10 | p90 | frac L<20 |
|---|---|---|---|---|---|
| 22 Hollow Market (no combat) | 52.5 | 48.8 | 37.1 | 66.3 | 0.001 |
| 23 Crucible (a walled kill-pit) | **52.4** | **51.1** | 35.3 | 65.7 | 0.000 |

The safe hub and the combat pit are photometrically indistinguishable — 0.2%
apart in mean luminance, and the *pit is marginally brighter at the median*.
Hue 330° vs 358.7°, dE 11.0. The only thing in `22` that says "safe" is the
HUD string `SPEND WHAT YOU HAVE, THEN TAKE THE PORTAL` and the absence of a
monster. That is a UI label doing the work light, colour and composition were
supposed to do.

### 3. Does the Herald read as a FINAL boss? **Distinct, yes. Final, no.**

The silhouette-family claim holds: it hovers, it has no legs, and none of the
six teleporter bosses can make that shape. Apparent scale is genuinely large —
in `25` the Herald masses 329×338 px against a survivor at 61×118 px that is
*nearer the camera*, so the true world ratio exceeds the measured 2.9×.

But it is the **least-resolved character in the game**. The body is one flat
pink value (mean L 113.5, p99 210.9) with no shading separating shell, mantle
and crown, and the brightest thing in the entire frame is a near-grey bead
strip under it: 205×50 px, meanL **209.9**, p99 **251.6**, **31% of it above
L245**, mean saturation **0.151** inside a frame graded at 0.67 saturation.
Compare `12-boss-phases.png` — the Iron Vizier is an articulated biped with
pauldrons, a sword, a shield, a lit core and clean value modelling. The boss
that is supposed to top six of those is a blob with a white bar under it.

Silhouette aspect (w/h) across the three phase shots: **0.97 → 0.85 → 0.64**.
That is not a family; that is three different reads of one unstable mass.

### 4. Are the phase transitions legible in the pixels? **No — they are legible in the objective line.**

`26-finale-phase2` shows a floor that has just fallen from 34 m to 22 m as a
**clean, unbroken, machined magenta tube** (`p2_rim_left` crop): no fracture,
no serration, no falling slab, no debris, no dust plane, no crack propagation,
and no void visible anywhere except a sliver at the top of frame. A collapse
that leaves the rim looking lathed is not a collapse.

The three anchors that gate the fight measure **hue 245.9°, L 66.3**. The floor
they stand on measures **hue 249.3°, L 43.3** — 3.4° away. The Herald they are
warding measures **hue 294.3°, L 129.9** — **48° away**. The report's claim that
`warded` "repaints them violet (they read as pieces of the boss)" is refuted by
the pixels: they colour-match the ground, and they render as dark polyhedra
with thin white wireframe edges that read as a debug gizmo.

A player looking at `26` with the HUD off would not know the floor had moved or
that anything needed destroying.

### 5. Do the ending screens land? **The string bug is gone. The screen is not.**

`YOU DIED` over a victory is confirmed fixed — `28` reads `THE HERALD FALLS`,
`29` reads `OBLITERATED`. Withdraw nothing there.

But the headline colour, sampled over each screen's own headline band:

| screen | n px | mean RGB |
|---|---|---|
| `28-finale-victory` (THE HERALD FALLS) | 29,500 | **(249.3, 57.8, 39.5)** |
| `29-ending-obliterate` (OBLITERATED) | 23,327 | **(249.0, 57.8, 39.4)** |
| `16-run-summary` (YOU DIED) | 14,863 | **(249.5, 58.0, 39.4)** |

**Identical to within 0.5/255 on every channel.** Same typeface, same tracking,
same hairline rule, same panel, same two buttons, same `RESTART RUN`. The
victory and the death screen differ by their words and nothing else. A run that
ends in triumph is being announced in the alarm red the game uses for failure.

### 6. Cohesion — bolt-on or the same authored world?

Mixed, and mostly for the wrong reason. The three realms are cohesive with the
base game because they are *the same colour as it* (dE 8.8–9.8 from biome 4) —
that is cohesion by failure to differentiate, not by authorship. The finale is
the opposite: it commits to a violet key nothing else in the game owns and it
earns that. Two concrete breaks: the flat cyan UI arrow floating unmoored in the
3D scene in `21`, and the anchors in `26` sharing no visual language with the
boss they belong to.

---

## Per-shot verdicts

### 21-realm-gateways
```
AXIS SCORES: 1:3 2:4 3:3 4:3 5:4 6:4 7:6 8:4 9:4 10:4
VERDICT: FAIL   (mean 3.9)
```
The muddiest frame measured anywhere in this submission: mean L **20.7**,
Lstd **8.7**, p5–p95 = **13.1–29.9** — the whole image lives inside 17 luma
units. Three gateways that are three copies of one stone slab distinguished
only by the colour of a ring decal; the Gilded Beacon's decal is blown into a
featureless white halo you cannot read the icon through. A flat cyan arrow
sprite floats in the scene with no world grounding.

### 22-realm-bazaar
```
AXIS SCORES: 1:4 2:3 3:4 4:3 5:4 6:4 7:6 8:6 9:4 10:5
VERDICT: FAIL   (mean 4.3)
```
The "ten-bay column arcade with lintels" is a painted backdrop: the columns
have near-zero value separation from the wall plane, there is no AO at a single
column/wall junction and no column casts a shadow. The "hung lanterns" are flat
white diamond billboards with no chain, no bracket and no housing — and some
carry a bloom halo while others do not, so one asset reads two ways in one
frame. The "market stalls" are item pedestals with a coloured billboard plate:
no counter, no awning, no goods. Smallest stall = **216 mask px**.

### 23-realm-crucible
```
AXIS SCORES: 1:4 2:4 3:4 4:3 5:4 6:3 7:6 8:2 9:4 10:5
VERDICT: FAIL   (mean 3.9)
```
Captioned `WAVE 4 OF 5` over one gold quadruped. The manifest's own numbers:
`px: 440` = **0.34% of frame**, `perPx: [141, 0, 299]`, `visibleObjects: 2`
of 3 — one member of the wave is at **literally zero pixels**. Axis 8 asks
whether the frame is readable under load; there is no load. The four cover
blocks are unlit navy slabs whose drop shadows are the same value as the blocks,
so they read as holes in the floor rather than as things to stand behind. The
caption honesty fix from the report is real and holds.

### 24-realm-vault — best frame in the submission
```
AXIS SCORES: 1:6 2:6 3:6 4:4 5:5 6:5 7:6 8:5 9:5 10:6
VERDICT: FAIL   (mean 5.4)
```
The one composition with intent: prize centred and lit on its dais, the warden
physically between the player and it, a gold-on-black key that is the only
committed grade among the three realms. It fails on its antagonist — the Vault
Warden is a red rectangular slab with a stick arm and a cone leg, and its
`frontArmor 0.7` shielded arc, the entire reason the encounter is a fight
rather than a footrace, has **no visual representation at all**. The survivor
is also jammed into the bottom-right corner underneath the ability bar.

### 25-finale-phase1
```
AXIS SCORES: 1:5 2:3 3:5 4:3 5:3 6:3 7:6 8:5 9:4 10:5
VERDICT: FAIL   (mean 4.2)
```
The shot exists to show "the full 34 m arena" and shows a sliver of it at the
bottom edge — roughly 60% of the frame is empty violet gradient. The Herald is
a 0.97-aspect blob in one flat pink value with a near-white bead strip under it
(31% above L245, saturation 0.151) that is brighter than any part of the boss
itself, plus a stray lens spark sitting inside the silhouette.

### 26-finale-phase2
```
AXIS SCORES: 1:4 2:5 3:5 4:4 5:4 6:3 7:7 8:5 9:4 10:4
VERDICT: FAIL   (mean 4.5)
```
The rule change of the whole fight, communicated by a line of yellow HUD text.
Machined rim, no collapse evidence, no void in frame, anchors at the floor's
hue and 48° from the boss's. Axis 7 scores well precisely because the HUD is
carrying information the render refused to.

### 27-finale-phase3
```
AXIS SCORES: 1:4 2:5 3:5 4:4 5:3 6:3 7:6 8:4 9:4 10:5
VERDICT: FAIL   (mean 4.3)
```
The clearest arena read of the three — the whole ellipse framed with void all
round. But the 14 m core is one untextured flat value, the three islands read
as background scenery rather than as the only other ground, healing suppression
has no visual whatsoever, and the survivor is a 19×50 px figure alone on a
large empty disc.

### 28-finale-victory
```
AXIS SCORES: 1:6 2:6 3:3 4:6 5:6 6:5 7:4 8:7 9:6 10:3
VERDICT: FAIL   (mean 5.2)
```
Headline (249.3, 57.8, 39.5) — the death screen's red to within half a level.
`ITEMS COLLECTED` is printed twice: once as a stat tile reading `0` and again
immediately below as a list reading `NONE`.

### 29-ending-obliterate
```
AXIS SCORES: 1:6 2:6 3:3 4:6 5:6 6:5 7:4 8:7 9:6 10:3
VERDICT: FAIL   (mean 5.2)
```
Same panel, same red (249.0, 57.8, 39.4), same duplicated label. The copy is
the best-written line in the submission — "YOU STEPPED INTO THE OBELISK AND
UNMADE YOURSELF. THE RUN ENDS ON YOUR TERMS." — and it is set in the typography
of failure.

---

## TOP DEFECTS (ranked, capped at 6)

**1. `Progression.finishRun` summary headline / `src/ui/*` — a victory is
rendered in the death screen's exact red.** Sampled headline RGB:
`28` (249.3, 57.8, 39.5), `29` (249.0, 57.8, 39.4), `16-run-summary` "YOU DIED"
(249.5, 58.0, 39.4) — identical within 0.5/255, with the same typeface,
tracking, hairline rule, panel, and `LOGBOOK` / `RESTART RUN` buttons. The
`YOU DIED`-over-a-victory *string* bug is genuinely fixed; the *visual language*
of failure is 100% intact.
**Fix:** give the two victory endings their own treatment — headline in the
Herald's violet (≈`#C864D4`) or a warm gold, the hairline rule recoloured to
match, `RESTART RUN` → `NEW RUN`, and one victory-only element the death screen
never shows (an ending seal, or a `TIME TO THE FRACTURE` stat). Separately, drop
the duplicated `ITEMS COLLECTED` — it appears as a stat tile reading `0` and
again as a list reading `NONE`.

**2. `src/world/realms/RealmArena.js` — the three realms are less separated from
each other than the four ordinary biomes are.** Mean-colour dE76: realms
11.0 / 11.2 / 15.4 (mean **12.5**); ordinary biomes 15.8–41.6 (mean **28.5**).
Every realm is closer to ordinary biome 4 (8.8–9.8) than any two ordinary
biomes are to each other. Dominant hues 330° / 358.7° / 18.8° — one 49° amber-
magenta arc, which is the base game's own band.
**Fix:** commit one key per realm that no ordinary stage owns. Hollow Market →
cool teal/ivory ambient with the lanterns as the sole warm accent (RoR2's Bazaar
is blue-and-gold, not amber-on-amber). Crucible → desaturated iron grey with the
under-floor seam as the only chroma in frame. Vault → keep the gold, push the
walls to true black (L < 10) so the gold has something to read against. Target
≥ 25 dE between any two realms.

**3. `src/world/realms/RealmArena.js` (bazaar) — nothing in the Hollow Market
says "safe", and the architecture is a backdrop.** Market meanL **52.5** vs
Crucible **52.4**; median 48.8 vs **51.1** (the pit is brighter). p10 37.1/35.3,
p90 66.3/65.7. Whole-frame Lstd 9.9. The arcade columns have near-zero value
separation from the wall, no AO at any junction and cast no shadows; the
lanterns are flat diamond billboards with no chain, bracket or housing, some
haloed and some not.
**Fix:** raise the room to meanL ≥ 75 with a soft overhead fill, split lantern
light warm against a cool ambient, model an actual fixture on each lantern
(bracket + chain + housing), and give the columns a ≥2.5:1 value step from the
wall plane with contact AO at the base.

**4. `src/entities/EnemyMeshes.js buildHerald` — the final boss is the
least-resolved character in the game, and the blown band the report says it
removed is still there.** In `25`: body one flat pink value (mean L 113.5,
p99 210.9, no shading separating shell/mantle/crown), aspect 0.97, and a
205×50 px near-grey bead strip under it at meanL 209.9, p99 251.6, **31% above
L245**, saturation **0.151** in a 0.67-saturation frame — the brightest element
in the shot, and brighter than the boss. Aspect across phases: 0.97 → 0.85 →
0.64. Against `12-boss-phases.png` the Iron Vizier is an articulated biped with
pauldrons, sword, shield and a lit core.
**Fix:** drive the band's emissive to the violet key at ≤0.4 intensity or delete
the mesh; split the body into three value tiers so crown/shell/mantle separate
as pure black silhouettes; add one asymmetric read (a long trailing spar, a
broken ring) that survives rotation so the silhouette is stable across phases.

**5. `src/world/realms/FinalBoss.js` — the phase transitions exist only in the
HUD text.** The "collapsed" rim in `26` is a clean, unbroken, machined magenta
tube: no fracture, no debris, no dust, no falling slab, and no void visible in
frame. The three gating anchors measure hue **245.9°** / L 66.3 against a floor
at hue **249.3°** / L 43.3 (3.4° apart) and the Herald at hue **294.3°**
(48° apart) — the report's "repaints them violet, they read as pieces of the
boss" is refuted; they read as pieces of the floor, drawn as dark polyhedra with
white wireframe edges that look like a debug gizmo.
**Fix:** emit the anchors at the Herald's exact 294° magenta with a visible
tether beam to the boss so the ward is a drawn relationship; make the collapse
leave a serrated/broken rim ring, spawn falling slab geometry and a settling
dust plane at the moment `setFloorRadius` runs, and hold a persistent void
gradient below the lip so the shrink is visible without reading the objective
line.

**6. `src/core/Harness.js:1287` + `:1432` — the gate that certifies these shots
is aggregate-only, so `subjectsOk: true` is not evidence of legibility.**
`sepP50` is computed from the *union* mask of all objects (`const all =
count(_maskB, true)` at `:1287`); the per-object pass at `:1291–1301` produces
only `perPx` / `visibleObjects` and is never separation-checked, and `:1432`
tests `rep.px >= c.minPx` against the *sum*. Consequences in this manifest:
`23-realm-crucible` passes its `minPixels: 420` on a sum of 440 with
`perPx: [141, 0, 299]` and `visibleObjects: 2/3` — one wave member at zero
pixels, the whole "live wave" at 0.34% of frame; `22-realm-bazaar` passes
`minPixels: 900` on a sum of 1520 whose first stall is 216 px;
`26-finale-phase2` passes with one anchor carrying 2097 of 2892 px while the
smallest carries 313.
**Fix:** when `perObject: true`, apply `minPixels` *and* `minSeparation` per
object; set `minObjects` to `objects.length` for fixed-count subjects (3 stalls,
3 anchors, 3 gateways); add a `minFrac` on encounter-level subjects so a "wave"
shot cannot certify at a third of a percent of frame.

---

## Withdrawn — claims I made on first look and could not reproduce

Listed because a critic who does not withdraw is not measuring.

* **"Blown/clipped highlights in the 3D frames."** Outside the HUD gutters,
  every 3D shot has **5–10 pixels** at ≥250 on all channels. There is no
  clipping. The Herald's band is bright but tops out at (255, 253, 249) on a
  handful of pixels; the vault's floor hotspot maxes at (240, 228, 176), has
  **0%** above L240 and is only **1.3×** its surrounding floor. My eye read
  "blown" from local contrast against a dark surround. Defect 4 is restated as
  *near-grey and brighter than the subject*, which the numbers do support.
* **"The floor confetti / specular speckle is a realms defect."** Chroma
  high-frequency confetti fraction on matched floor patches: Crucible 0.081,
  Vault 0.045, Market 0.027 — against base `13-biomes-1` **0.082**,
  `13-biomes-4` 0.056, `04-combat` 0.038. The realms are equal to or *cleaner
  than* the shipped base stages. Inherited engine behaviour, not introduced
  here. Not counted against this work.
* **"The rift veins hang out over the void in phase 2."** The magenta arc across
  `26` is the *far* rim; everything below it in screen space is floor nearer the
  camera. The veins stay on the disc. The report's fix #2 holds.
* **"The three realms share one arena mesh."** My per-column floor-line
  correlation returned r = 0.04 / −0.05 / 0.09 — inconclusive in both
  directions. The shared *composition* (circular floor, concentric inlay ring,
  curved wall, cone ceiling, wall-height point lights) is visible in the frames
  and is claimed; identical geometry is not.

---

## Is this a destination, or three more stages?

**Structurally, a destination. Visually, three more stages and one real place.**

The design underneath is right and it is the part of this submission that
deserves to survive: a hub you spend in, a pit you gamble in, a vault you fight
for, a final stage that changes its own rules twice, and two ways to end a run
on purpose. `realmprobe`'s organic path — two portals at the loot window, the
teleporter still the same object on return, six chests still shut — is the
correct shape for an end-game, and it is more than most of this genre ships.

But a destination is a thing you *recognise on arrival*, and the pixels do not
let you. The Hollow Market is the same luminance as the arena where things try
to kill you (52.5 vs 52.4) and sits 9.8 dE from an ordinary biome. The Crucible
is a room with one animal in it. The Gilded Vault is the only realm that
photographs as somewhere — and its warden, the reason the room exists, is a red
rectangle whose defining mechanic is invisible. Three optional places that
average 12.5 dE apart are not three places; they are one room dressed three
ways, and the run's climax is announced in the same red as its failure.

The finale is the exception and it is worth saying plainly: The Fracture commits
to a key nothing else in the game owns (62.3 dE from ordinary biome 1, hue 249°,
saturation 0.67) and `27` is a genuinely striking frame. That commitment is the
proof this team can make a destination look like one. It has not been spent on
the three realms, and the Herald standing at the centre of it is a flat pink
mass with a white bar under it.

Fix defects 1, 3 and 4 — the victory screen, the market's light, and the boss's
form — and this becomes an end-game you can see. Until then the structure is a
destination and the render is a detour.

---

**Round 1 of a maximum 4.**
