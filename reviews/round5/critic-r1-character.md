# Round 5 — Character read & survivor identity

Domain: rubric axis 4 (silhouette & form) primary, axes 7 (UI craft) and 8
(readability) as they bear on the player character.
Shots judged: `03-thirdperson`, `09-survivors`, `14-survivor-select`, `04-combat`.

`shots/manifest.json`: `ready: true`, `partial: false`, `errors: []`, and every
shot's `engine.frameErrors` is 0 with `newErrors: []`. No crash to report. The
capture is clean; the pixels are not.

---

## AXIS SCORES

```
AXIS SCORES 03-thirdperson:    1:5 2:5 3:6 4:3 5:4 6:5 7:6 8:4 9:5 10:6   mean 4.9
AXIS SCORES 09-survivors:      1:6 2:4 3:6 4:3 5:4 6:5 7:6 8:4 9:5 10:6   mean 4.9
AXIS SCORES 14-survivor-select:1:3 2:4 3:6 4:3 5:4 6:5 7:5 8:5 9:6 10:5   mean 4.6
AXIS SCORES 04-combat:         1:3 2:2 3:4 4:3 5:3 6:3 7:6 8:2 9:4 10:5   mean 3.5
```

**VERDICT: FAIL** (all four shots; axis 4 is 3/10 on every one of them)

---

## The four questions, answered

### 1. Are the four survivors distinguishable as pure black silhouettes?

**No.** I thresholded them rather than eyeballing it. Method: crop each survivor
out of `09-survivors.png`, 4-connected flood from the crop border with a
Manhattan RGB tolerance of 12, everything not reached = black. All four rendered
to one canvas, feet-aligned, at true relative scale.

Measured bounding boxes (largest connected component, native pixels):

| survivor | bbox | area | fill | aspect w/h |
|---|---|---|---|---|
| RANGER  | 124 × 228 | 12719 | 0.45 | 0.54 |
| ANVIL   | 159 × 239 | 14252 | 0.38 | 0.67 |
| KESTREL | 136 × 310 | 14090 | 0.33 | 0.44 |
| ROOK    | 131 × 206 | 10963 | 0.41 | 0.64 |

What the black shapes actually read as:

- **KESTREL — passes.** The only one. Cone head above the shoulder line, a rifle
  held at ~50° breaking the outline, narrow column body. Tallest by 30% and
  the only figure whose pose puts a limb away from the torso.
- **RANGER and ANVIL — FAIL, this is the colliding pair.** Both read as *lump on
  top of a brick on top of a column*. Neither has a head that clears the
  shoulder line, so neither silhouette has a head/neck notch; both have arms
  pinned flush to the torso, so neither has a single pixel of negative space
  between arm and body; both have legs that fuse into one solid block from hip
  to ankle. The only difference in black is that ANVIL is 28% wider
  (0.67 vs 0.54 aspect). At 09's staging that is a 35 px difference in width —
  and at `03`'s actual gameplay distance (player body measures ~215 px tall,
  ~60 px wide) it is ~10 px. That is not an identity, that is a size slider.
  They also share a base material: RANGER's torso plate averages RGB
  (124, 94, 98), ANVIL's averages (129, 99, 84). Same warm mid-grey. So they do
  not separate on value, on hue, or on shape — only on accent trim, and
  RANGER's orange sits next to ANVIL's amber.
- **ROOK — FAIL, worst of the four.** Its threshold is a formless amoeba with a
  single spike on top: no head, no shoulder line, no arm, no leg. Two causes,
  both visible: (a) a green emissive wash over the head/chest that flattens the
  whole upper body into one bright value — 3.42% of ROOK's bbox is above
  L=200 against KESTREL's 0.75% — and (b) it is staged standing behind a rock
  ledge, so the legs are simply gone from the roster shot that exists to compare
  legs.

Role read (question 3): **1 of 4.** ANVIL reads heavy — correct for "Breach
Crew". KESTREL reads lean and long — correct for "Long Watch". RANGER, billed
"Line Infantry", is a robed figure with an oversized faceted dome head and a
flared coat hem as its widest point: it reads *acolyte*, not infantry. ROOK,
billed "Field Engineer", reads as nothing at all — no backpack mass, no tool
silhouette, no laden asymmetry survives the threshold.

All four also stand in the **identical rest pose** — arms down, feet together,
weapon slung. A roster line-up is the one frame where per-survivor idle stances
are free score, and it spends none of it.

### 2. Is the player instantly findable in `04-combat.png` among 16 enemy types?

**The question cannot be asked of this shot: there are zero enemies in it.**

`tools/capture.mjs:118` calls `combat({ enemies: 24 })`. I gamma-lifted the
frame (γ 0.35) to rule out enemies buried in shadow — nothing. Not one body,
flying or ground, anywhere in 1600×900. What *is* in frame is a tracer that
terminates in mid-air at the crosshair, a ring of white impact sparks around
that terminus, and the crosshair itself pinned dead still. The shot is
photographing rounds landing on an entity that is not being drawn.

So: yes, the player is findable in 0.2 s, because it is the only object in the
picture. That is a void result, and axis 8 scores 2 because the shot documented
as "Judges VFX layering, enemy legibility, HUD under load" contains no enemy, no
legibility test and no load.

Worth noting the same failure appears in `05-boss.png`, which carries a
"STONE TITAN" boss health bar across the top of a frame with no titan in it — so
this is not a one-shot fluke of `combat()`.

Separately, the framing of `04` is broken on its own terms. The camera pitch is
far steeper and the standoff far shorter than `03`: the player measures ~350 px
tall (39% of frame height) here against ~215 px (24%) in `03`. At that pitch the
survivor is foreshortened into an unreadable pile — head is a small box on top,
the coat is a large trapezoid at the bottom, no arms, no legs, no facing. You
cannot tell which of the four survivors it is.

### 3. Covered above — 1 of 4 silhouettes communicates its role.

### 4. Does survivor-select read as AAA, or as a web form with a 3D model in it?

Neither, quite. The **chrome is better than a web form** — the roster rows are
sheared parallelograms with an accent bar on the leading edge, the ability tiles
have clipped corners, the keybinds are chips, cooldowns are right-aligned in a
consistent column. Somebody built a UI language here.

It fails on the three things that would make it read as a game's front door:

- **The roster list has no imagery.** Four text rows. Nothing tells you what
  RANGER looks like until you click him. RoR2's survivor select is character
  art first, text second. Here the *only* character content on the screen is one
  small untextured model.
- **The stat bars are broken and I measured them.** Track runs x=1174→1358
  (184 px). Fills: HEALTH 97 px (53%), DAMAGE 184 px (100%), SPEED 184 px
  (100%), ARMOR 0 px, CRIT 184 px (100%). Three of five bars are pegged
  identically at maximum. `src/ui/Menus.js:483` computes
  `frac = value / max(across roster)` with no zero-floor, so whichever survivor
  tops a stat gets a full bar — and KESTREL happens to top three. The reader
  learns nothing, and a sniper showing max damage *and* max speed *and* max crit
  reads as a bug.
- **The primary CTA is invisible.** Measured mean luminance: "BEGIN RUN" fill
  L=26.5, "BACK" fill L=17.5, panel background L=10.9. The most important
  control on the screen is 15 levels above its background and 9 levels above the
  secondary button. Nothing on this screen is bright enough to read as "press
  this". It also introduces a cyan accent for the CTA and the "DROP ▶" hint
  while the entire rest of the screen is on KESTREL's purple — two accents, no
  hierarchy.
- The portrait viewport is 652 × 388 (landscape 1.68:1) holding a 232 × 318
  vertical figure — the subject fills 82% of the height but only 36% of the
  width, leaving ~64% of the box as empty gradient. The model has flat frontal
  fill only: no key direction, no rim, no cast shadow, only a 1 px purple line
  under the feet. Axis 1 = 3 on this shot is entirely the portrait's lighting.
- **Cohesion:** the menu frame is orthogonal — square corners, a 2 px lavender
  top rule, plain rectangles — while the in-game HUD is all shears and chamfers
  (health slab is a parallelogram, ability tiles are corner-clipped). Two design
  languages in one product.

---

## Strengths (not scored, but real)

- The in-game HUD is the best-crafted surface in the set: sheared segmented
  health slab, XP rail, chamfered ability tiles with keybind chips and labels,
  a top-centre objective banner with a distance readout, a stage tag. It never
  covers the action in any of the four shots. Axis 7 = 6 is doing work.
- KESTREL is a genuinely good silhouette. Whatever produced the cone head above
  the shoulder line and the raised weapon is the recipe the other three need.
- The loadout panel in `14` (icon tile + name + keybind chip + description +
  cooldown) is clean, scannable and consistent.
- Accent colours are per-survivor and the purple grade in `14` is disciplined.

---

## TOP DEFECTS (ranked)

1. **`src/entities/CharacterMesh.js:421-713` (Ranger), `:714-937` (Anvil) —
   RANGER and ANVIL threshold to the same shape: a headless lump on a brick on a
   fused leg column, differing only in width (aspect 0.54 vs 0.67), and sharing
   a base plate colour ((124,94,98) vs (129,99,84)).** Neither silhouette
   contains one pixel of negative space. **Fix:** put daylight through both
   outlines. (a) Raise each head so its underside clears the shoulder plane by
   ≥0.12 m and make the two heads read as different primitives in black — Anvil
   a wide flat wedge, Ranger a tall narrow box, not two rounded lumps. (b) Rotate
   the shoulder pivots outward so there is a visible gap between upper arm and
   torso for the full length of the humerus — ~4-6 px of background at gameplay
   distance, per side. (c) Split the legs: stance width ≥ 0.9 × hip width so the
   inner leg gap survives thresholding. (d) Push the two plate albedos apart —
   Anvil warm rust, Ranger cool steel — so they separate on value even when the
   accent trim is out of frame.

2. **`src/core/Harness.js:719-737` (`combat`) with `stageTargets` at `:544-566`
   — `04-combat.png` contains 0 of its 24 spawned enemies.** The crosshair is
   pinned to an entity that is not rendered; the tracer terminates in empty air
   and the impact sparks fire against nothing. `05-boss.png` shows the same
   class of failure (a STONE TITAN health bar over a frame with no titan). This
   voids axis 8 entirely and drags axes 2, 6 and 5 with it. **Fix:** after
   `stageTargets`/`declutter`, project every live enemy through the camera and
   count how many land inside the frustum with a clear raycast; if fewer than 6,
   re-place along the yaw and re-check, and fail the capture loudly (push to
   `newErrors`) rather than shipping an empty frame that reads as ready.

3. **`03-thirdperson.png` — the player has no value separation from the terrain
   it stands on.** Measured 8-bit luminance: player torso mean 57.7
   (range 19.8-197.7), player coat/legs ~20-64, terrain immediately left 33.7
   (12.7-63.0), terrain behind the head 32.5. The coat is *darker* than the
   ground behind it and the ranges overlap completely — a border-flood threshold
   of the player region merges the head and upper body into the cliff face
   behind it. **Fix:** the rim shader exists (`CharacterMesh.js:216-221`,
   `uRimStrength`) but is not earning its keep against terrain at this value.
   Either raise `rimStrength` on `coat`/`coatDark` so the outline holds a ≥2.5:1
   luminance ratio against whatever is behind it, or give the survivor its own
   dedicated fill light attached to the camera rig, +0.6 EV over ambient, so the
   player never sits at the same value as the stage.

4. **`src/entities/CharacterMesh.js:1156+` (Rook) plus the `09` staging —
   ROOK thresholds to a formless amoeba.** Green emissive wash flattens the
   whole upper body into one value (3.42% of its bbox above L=200 vs Kestrel's
   0.75%), and in the roster shot it stands behind a rock ledge so its legs are
   occluded out of the comparison. **Fix:** (a) drop `visorBase` from 2.2 and the
   `cell` `emissiveIntensity` from 1.6 to roughly Kestrel's level, and confine
   the green to small discrete lamps rather than large panels, so the plate
   values under it can read again. (b) Give it the engineer read it is billed
   for: a backpack mass that breaks the outline behind the shoulders and a
   deployable/tool held away from the body. (c) In `Harness`, ground-test the
   roster line-up so all four stand on the same clear plane with no terrain
   between them and the lens.

5. **`14-survivor-select.png` portrait — the one piece of character content on
   the screen is unlit and badly staged.** 232 × 318 subject in a 652 × 388
   landscape viewport (36% of the width, ~64% dead gradient), flat frontal fill,
   no key, no rim, no cast shadow, a 1 px line for a floor. **Fix:** narrow the
   viewport toward 3:4 or push the model to ~65% of the width; add a three-point
   rig (key 45° camera-left and above, cool rim from behind camera-right, weak
   ambient) and a real contact shadow on a visible plinth; tint the viewport
   background with the survivor's accent so the model separates from it.

6. **`src/ui/Menus.js:483` and the footer — stat bars carry no information and
   the primary CTA has no weight.** DAMAGE, SPEED and CRIT all render at exactly
   184/184 px because `frac = v / rosterMax` has no zero-floor; ARMOR renders at
   0. "BEGIN RUN" fill is L=26.5 against a panel at L=10.9, only 9 levels above
   the secondary "BACK" at L=17.5, and it introduces a cyan accent against the
   screen's purple. **Fix:** scale each bar over a fixed design range (e.g. 0 to
   1.25 × rosterMax, or an explicit per-stat `[min,max]` in `STAT_BARS`) so no
   bar ever pegs and every survivor shows a distinct profile; and give the CTA
   a filled accent-coloured plate at ≥L 90 with dark text, in the *selected
   survivor's* accent, so there is exactly one brightest object on the screen
   and it is the button you want pressed.

---

## Commands / method

- `python` + Pillow 12.3.0 (no numpy in this env). All measurements on the
  shipped PNGs at native 1600×900, `RGB`.
- Silhouettes: 4-connected border flood, Manhattan RGB tolerance 12 (and 20 and
  34 for comparison), inverted to black-on-white, nearest-neighbour upscaled 3×.
- Component measurement: iterative 4-connected largest-component labelling over
  the inverted mask; bbox, area and fill ratio reported above.
- Luminance: `0.2126R + 0.7152G + 0.0722B` on 8-bit sRGB values (not
  linearised), reported as 0-255. Region means over explicit pixel boxes.
- Hidden-content check on `04-combat` and `05-boss`: per-channel LUT
  `255 * (i/255)^0.35` gamma lift, then visual inspection at 1× and 3×.
- Working images written to the session scratchpad, not the repo.
