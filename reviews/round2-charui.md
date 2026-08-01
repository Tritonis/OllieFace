# PETRICHOR — Round 2 critique: CHARACTER READ + HUD/UI

Critic domain: rubric axis 4 (player silhouette & form) and axis 7 (UI/HUD craft).
Judged against Risk of Rain 2's HUD and character presentation.
Shots: seed 1337, 1600x900. `shots/manifest.json` → `ready: true`, `errors: []`,
every shot `frameErrors: 0`. No crash to report; visual scores stand.

All measurements below were taken by decoding the PNGs to a canvas and sampling
pixels (scratchpad probes), not by eye.

---

## 1. Axis scores

| Axis | 03-thirdperson | 06-loaded-hud | 01-title (UI layer) |
|---|---|---|---|
| 1 Lighting & shadow | 4 | 4 | 4 |
| 2 Composition & depth | 5 | 3 | 4 |
| 3 Colour & grade | 7 | 5 | 6 |
| 4 **Silhouette & form (player)** | **3** | **3** | 4 |
| 5 Material believability | 4 | 4 | 4 |
| 6 VFX quality | 5 | 5 | 3 |
| 7 **UI/HUD craft** | **6** | **4** | **6** |
| 8 Readability under load | 5 | 3 | 6 |
| 9 Post-processing | 5 | 3 | 4 |
| 10 Cohesion | 6 | 5 | 5 |
| **Mean** | **5.0** | **3.9** | **4.6** |

```
AXIS SCORES 03: 1:4 2:5 3:7 4:3 5:4 6:5 7:6 8:5 9:5 10:6
AXIS SCORES 06: 1:4 2:3 3:5 4:3 5:4 6:5 7:4 8:3 9:3 10:5
AXIS SCORES 01: 1:4 2:4 3:6 4:4 5:4 6:3 7:6 8:6 9:4 10:5
VERDICT: FAIL
```

**VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. My two owned
axes score 3/3/4 (silhouette) and 6/4/6 (HUD). Neither clears. Three separate
*state* failures are visible in the pixels — the level readout, the boss name, and
the damage numerals — where the HUD is confidently displaying wrong or placeholder
information at 22 minutes into a fully-loaded run.

**What is genuinely good, so the fixes don't destroy it:** the angular
`clip-path` language of the health bar, clock, skill slots and toast log is real
and it is consistent; the difficulty ladder (`HARD x3.2`, 4/10 notches) is
correct and legible; the inventory *is* present and dense in 06 (37 tiles across
4 tier rows with counts — the brief's top-priority check passes); the palette in
03 is a disciplined amber/magenta/maroon with one cyan accent. The failures below
are specific, not systemic taste problems.

---

## 2. Ranked defects

Ranked by rubric cost. Area tags: **A** = player mesh/silhouette
(`CharacterMesh`), **E** = HUD/menus/icons/CSS (`src/ui/*`), **F** = camera
framing (`CameraRig`, `Harness`).

---

### U1 — Damage numerals render upside-down [AREA E] — `src/systems/VFX.js:1790` + `:1623`

**Pixels.** In `06-loaded-hud.png` every floating damage numeral is mirrored about
the horizontal axis. Zoom on the number at (185–300, 385–420): the glyphs read
`ꓶ ɘ ꓶ`. I rendered `161` in the same font stack (`bold "Arial Black", Impact`)
under `scaleX(-1)`, `scaleY(-1)` and `rotate(180deg)` and compared: the game's
`1` carries its flag at the **bottom-left** with the base bar on **top**, which
matches `scaleY(-1)` and rules out a horizontal mirror or a 180° rotation. Every
numeral in the frame — `161`, `1301`, `60`, `10`, `40` — is affected. The single
most-used numeric feedback channel in the game is unreadable.

**Cause.** `makeGlyphAtlas()` sets `tex.flipY = false` (VFX.js:1790), so texture V
runs top-to-bottom of the canvas. The vertex shader then builds
`vUv = (uv + tileOffset) / uAtlasCols` (VFX.js:1623) from `PlaneGeometry`'s
default UVs, where `v = 0` is the quad's **bottom**. Bottom of quad samples top of
tile → every glyph is flipped.

**Fix.** In `NumberVert` (VFX.js:1623), flip v before the tile offset:
`vUv = (vec2(uv.x, 1.0 - uv.y) + vec2(mod(aGlyph.x, uAtlasCols), floor(aGlyph.x / uAtlasCols))) / uAtlasCols;`

**Aggravating.** Chromatic aberration is applied at full strength over this layer.
At native resolution these glyphs are ~10px tall and the RGB split is ~3px, so the
number at (100–160, 545–585) has dissolved into a pure rainbow smear with no
recoverable shape at all. Damage numerals should be excluded from the aberration
pass, or drawn at ≥18px. Also: the numerals in 06 are scattered across the
*empty black terrain* in the left half of the frame, tens of metres from any
enemy — the arc in `NumberVert:1610` throws them along `aVel` with no screen-space
clamp toward the hit point.

---

### U2 — Level readout is hard-stuck at "LVL 1" with an empty XP bar at 22 minutes [AREA E] — `src/ui/HUD.js:387-406`

**Pixels.** `06-loaded-hud.png` bottom-left: `625 / 625` health, `LVL 1`, and an
XP bar that is a completely empty lime outline with zero fill. The same frame
shows `22:01` on the clock, `HARD x3.2`, `$5,058`, and 37 stacked items. A
level-1 survivor with 46 minutes of item stacks is an incoherent HUD state and it
is the first thing an RoR2 player will notice. In real RoR2 this reads ~level
20–30 with a partially filled bar.

**Cause.** `updateExperience()` reads `p.level`, `p.xp ?? p.experience`, and
`p.xpToNext ?? p.xpNext ?? p.experienceToNext`. `grep -n "level|xp|experience"
src/entities/Player.js` returns **zero matches** — Player carries none of these
fields. Every fallback resolves to the defaults (`1`, `0`, `100`), so the block is
a permanent placeholder that can never change. The `is-up` level-up flash
(hud.css:692) and the `Level N` toast (HUD.js:402) are therefore dead code.

**Fix.** Either give `Player` a real `level`/`xp`/`xpToNext` driven off the kill
XP that `Combat` already computes, or — if levelling is out of scope — delete
`.xprow` from the template (HUD.js:843-846) and `updateExperience` entirely. A HUD
must not display a number it cannot compute. Do not ship the placeholder.

---

### U3 — Boss bar shows the literal placeholder string "BOSS" [AREA E] — `src/ui/HUD.js:210` / `src/entities/Enemy.js:166`

**Pixels.** Top-centre of `06-loaded-hud.png`: a full-width yellow bar headed
`BOSS`, sub-labelled `TELEPORTER BOSS`, with `100%` at the right. Two labels, both
generic, neither naming the thing that is trying to kill you. RoR2 shows
`STONE TITAN` here. Reading `BOSS / TELEPORTER BOSS` is reading a template that
was never filled in.

**Cause.** `setBoss()` does
`enemy.displayName || enemy.name || 'Boss'`. `Enemy` stores the spawn card as
`this.def = def` (Enemy.js:166) and never copies `def.name` onto the entity, and
has no `displayName`. `enemies.js:159` has `name: 'Stone Titan'` sitting unused.
Both operands are `undefined` → the literal `'Boss'` fallback ships.

**Fix.** `HUD.js:210` → `(enemy.displayName || enemy.def?.name || enemy.name || 'Boss').toUpperCase()`.

**Secondary.** The bar fill is `#ffd162` — the same gold as the money counter
(`#5c4813` chip at (52,42)) and the difficulty notches. Enemy health, player
currency and difficulty escalation all share one hue, so the top band of the
screen has no colour hierarchy. Give the boss track its own hue (RoR2 uses a
desaturated purple/crimson) and reserve gold for currency.

---

### U4 — Player silhouette is two stacked bells with no head, arm or weapon read [AREA A] — `src/entities/CharacterMesh.js:222-228`, `:259-271`, `:277-282`

**Pixels.** `03-thirdperson.png`, player bounding box measured at
x 686–789, y 380–634 (103 × 254 px). Threshold the region and the read is:
a wide pale trapezoid (the cape) sitting on a wide dark trapezoid (the coat),
topped by a jagged crown of shards where a head should be. Two flat rectangles
float clear of the body mass on the upper right — those are the arms, and they do
not connect to the silhouette. Nothing in the shape says "person holding a gun".
The rubric's 4-point description — "blobby primitives, player indistinguishable"
— is literally what is on screen.

**Cause.** The cape (`CylinderGeometry(0.22, 0.33, 0.52, 5, …)`, CharacterMesh.js:222)
hangs from the chest and the coat (`CylinderGeometry(0.24, 0.30, 0.58, 7, …)`,
:261) hangs from the pelvis. Both are wider at the bottom than the shoulder pivot
offset (`0.20 * side`, :314), so the cloth swallows the upper arms entirely and
the two shells stack into one continuous cone from chest to hem. The helmet is
`IcosahedronGeometry(0.16)` (:277) at neck height, i.e. a 0.32-wide head against a
0.66-wide cape bottom, and it barely clears the cape's 0.22 top radius.

**Fix.** Narrow the cape's bottom radius to ≤0.24 and shorten it to ~0.34 so it
stops at the ribs; push `shoulder` out to `0.26 * side` so the upper arms clear
the cloth outline; raise the helmet ~0.06 and widen it to ~0.19 so the head/neck
notch exists in the outline. The test to run: render the rig as pure black at
254px tall and check that head, shoulders, both arms and the leg gap are all
separable.

---

### U5 — The slung carbine punches a black hole through the middle of the body [AREA A] — `src/entities/CharacterMesh.js:246-257`, `:53`

**Pixels.** Sample a vertical column through the player centre (x = 730) in
`03-thirdperson.png`:

```
y  460 470 480 490 500 510 520 530 540 550 560 570 580 590
L  153  87  94  84   1   1  85  93   1   1   1   1 170  94
```

Luminance drops to **1/255** across y 500–510 and y 540–570 — while the
surrounding terrain sits at **5.8–9.2/255**. The weapon is *darker than the
background it is silhouetted against*. In the pixels the torso is not a mass; it
is a light patch, a hole, a light patch, a bigger hole, a light patch. The code
comment at :242-245 asserts this slab is "the strongest single line in the
silhouette" — it is the opposite: it is subtractive, and it merges with the void.

**Cause.** `slingBody = boxMesh(0.10, 0.62, 0.14, M.gun)` where
`COL.gunmetal = 0x232a33` with `metalness: 0.8, rimStrength: 0.45` (:163). At 0.8
metalness with no environment map and no key light reaching the character's back,
the diffuse term is ~zero and the fresnel rim only lights the grazing edges — so a
0.62m slab renders at 1/255. It is also a bare box: no barrel taper, no stock, no
sight, no muzzle.

**Fix.** Two changes. (a) Raise `COL.gunmetal` to ~`0x3d4753` and drop
`metalness` to ~0.45 so the weapon holds a mid value against a black stage.
(b) Silhouette it *outward*: rotate the sling so the barrel breaks the body
outline (currently `rotation.set(0.16, 0, -0.55)` keeps it inside the cape
footprint) and add a stock/muzzle step so the shape reads as a weapon rather than
a rectangle.

---

### U6 — Item icons are rounded rectangles inside an all-angular HUD [AREA E] — `src/data/items.js:487-497`

**Pixels.** Every one of the 37 item tiles in `06-loaded-hud.png` has visibly
rounded corners and a rounded tier stroke. They sit inside `.inv-group` plates
that are chamfered polygons, next to skill slots that are notched octagons, above
a health bar sheared `-16deg`, next to keycaps that are parallelograms. The
inventory is the only rounded thing in the entire interface. Rubric axis 7's
4-point description names this exactly: "rounded default boxes".

**Cause.** `HUD.js:184` calls `itemArt(id, tier)`; `Icons.js:290-294` forwards to
`items.itemIcon()`, which draws its plate with
`roundRect(g, s*0.04, s*0.04, s*0.92, s*0.92, s*0.14)` (items.js:487) and its
border with the same at radius `s*0.13` (:493). Meanwhile `Icons.js:171-200`
already contains a correct angular `drawPlate()` with chamfered corners and
machined corner ticks — it is used for `tierFrame()` and `itemIcon()` and is
simply not the code path the HUD takes.

**Fix.** Point `Icons.itemArt` (Icons.js:290) at `Icons.itemIcon` instead of
`itemArtCanvas`, or replace the two `roundRect` calls in `items.js:487/493` with
`platePath`. One-line change; deletes the single largest style break in the HUD.

---

### U7 — Item glyph fill is a random hash hue, which destroys tier colour coding [AREA E] — `src/data/items.js:556` (+ `:506`)

**Pixels.** The common/white row of `06-loaded-hud.png` contains, left to right:
gold bars, a **mint-green** triangle, a **lime** leaf, a **red-orange** circle, a
**blue** hexagon, a **violet** shield, a **green** cross, a **cyan** triangle, an
**amber** ring, a **purple** diamond, a **teal** leaf. Eleven unrelated hues in a
row that is supposed to communicate one thing: *these are all white-tier items*.
The tier is carried only by a 2px border while the loud, saturated interior is
noise. Two rows down, the legendary row is doing the same thing in different
random hues. Axis 3's 4-point case — "oversaturated rainbow with no hierarchy" —
inside an otherwise disciplined palette.

**Cause.** `itemIcon()` passes `hashHue(item.id)` (a hash of the id string mod
360) into `drawGlyph`, which sets `g.fillStyle = hsl(${hue} 70% 62%)`
(items.js:556). The hue is deterministic but semantically meaningless — it
correlates with the item's *spelling*, nothing else.

**Fix.** Derive the glyph fill from the tier: `tier.css` for the body, a 55%-black
mix for the interior shadow (the `colors.main/deep/plate` ramp `Icons.js:213`
already builds is the right model). Let *shape* carry item identity and *colour*
carry tier — that is the RoR2 contract.

---

### U8 — Stack-count badges are the loudest element in the top-left, and they live outside their tiles [AREA E] — `src/ui/hud.css:354-368`

**Pixels.** The `x8 / x3 / x10 / x5 / x12 …` chips in `06-loaded-hud.png` are
solid `#e6ecf4` (near-white) rectangles with near-black text — brighter than the
gold counter above them and far brighter than the dark item plates they annotate.
Scanning the panel, the eye reads a row of white chips *before* it reads a single
item. They are also positioned in the gutter, not in the tile: `right: -0.15em;
bottom: -0.35em` against a `.inv-group` gap of `0.28em`, so each chip eats ~54% of
the space between its tile and the next and overhangs below the group's padding,
so the first row's chips crowd the second row's tiles.

**Fix.** Move the chip inside the tile (`right: 0.1em; bottom: 0.1em`), drop the
solid tier-coloured plate for plain white text with a 1px black outline (which is
what RoR2 does), and drop the size to ~0.7em. Counts are secondary information and
must not out-value the icons.

---

### U9 — Inventory tier plates stretch to full width, leaving large dead translucent slabs over the scene [AREA E] — `src/ui/hud.css:309-327`

**Pixels.** Scanning row y = 150 of `06-loaded-hud.png` (the white tier's second
row): icon content ends at x ≈ 150, but the translucent blurred plate continues to
x ≈ 483. That is a **~330 × 90 px empty frosted rectangle** hanging off the right
of the white group, and the green group repeats it. The red and equipment groups
shrink-wrap correctly, so the four tier rows have four different widths and the
panel reads as broken layout rather than a designed strip. Total top-left
occlusion is ~460 × 175 px of blurred, darkened gameplay.

**Cause.** `.inv-group` is a flex item of `.inventory` (`max-width: min(34vw,
460px)`) with `flex-wrap: wrap`. A group with 14 items fills the container's full
line width; the 3 leftovers wrap to a second line, but the *plate* keeps the full
line box.

**Fix.** Give `.inv-group` `width: max-content; max-width: 100%` so the plate
shrink-wraps its content, or (better, and closer to RoR2) drop
`background`/`backdrop-filter` from `.inv-group` entirely and let the icons sit on
the scene, using only the 2px tier rule as the separator. RoR2's inventory strip
has no backing panel at all.

---

### U10 — Charge pips overflow the slot and read as a strip of dashed noise under the skill bar [AREA E] — `src/ui/hud.css:840-846` + `src/ui/HUD.js:483-485`

**Pixels.** In `06-loaded-hud.png`, below the `DOUBLE TAP / PHASE ROUND / TACT.
DIVE / SUPP. SALVO` labels there is a ragged band of white parallelograms running
the full 320px width of the ability cluster and trailing off into faint ghost
dashes past the right edge. It is not identifiable as a meter — it reads as a
rendering artifact sitting on top of the `.abilities::before` rail. In
`03-thirdperson.png` the same element is two lone dashes floating under `SUPP.
SALVO` with a bare grey line beneath, which is equally unreadable.

**Cause.** `renderPips()` emits one `<i>` per `maxCharges` into a plain
`display:flex` row with no wrap and no cap. `.slot` is `width: 5.2em` with no
`overflow: hidden`, so with the loaded run's cooldown/charge items stacked, the
pip count exceeds what 5.2em holds and the row spills across neighbouring slots.

**Fix.** Cap the rendered pips (`min(max, 5)` plus a `+N` label), add
`flex-wrap: wrap; justify-content: center; max-width: 5.2em` to `.slot-pips`, and
give `.slot` `overflow: visible` only for the glow. Also raise the off pip from
`rgba(120,150,180,0.22)` — at that alpha over a bright scene the empty pips
disappear entirely, so the player cannot tell 2-of-6 from 2-of-2.

---

### U11 — The primary ability slot goes to a black box with no cooldown readout [AREA E] — `src/ui/hud.css:778-786` + `src/ui/HUD.js:474-476`

**Pixels.** Measured peak luminance inside the M1 icon box (1290–1330, 780–825):
**232** in `03-thirdperson.png`, **72** in `06-loaded-hud.png` — the icon loses 69%
of its peak value. Tile mean in 06 is 12.2/255. There is no numeral over it. The
slot the player looks at most reads as disabled/broken rather than "firing".

**Cause.** `.slot-sweep` is `rgba(3,6,10,0.82)` full-slot at `scaleY(1)`, and
`updateAbilities` suppresses the numeral whenever `a.rem < 1` (HUD.js:474). The
primary's cooldown is sub-second, so it gets the full blackout and never gets the
compensating number.

**Fix.** Drop the sweep to `rgba(3,6,10,0.55)` and add
`filter: brightness(0.75)` on `.slot-icon` while cooling instead of occluding it,
so the icon stays identifiable — the CSS comment at hud.css:800 claims this is
already true and the measurement says it is not. RoR2 never blacks out the
primary.

---

### U12 — All the authored front-facing value structure is invisible from the gameplay camera [AREA A] — `src/entities/CharacterMesh.js:206-215`, `:291-293`

**Pixels.** Measured mean luminance down the player in `03-thirdperson.png`:
head **80.5**, upper cape **74.7**, coat **63.1**, legs **51.2** — a 29-point band
out of 255, i.e. the entire character occupies **11% of the value range**, flat,
against a background at 6–9. There is no light/dark break anywhere on the body.

**Cause.** The bright `yoke` (`y +0.20`), `plate` (`z +0.13`), `stripe`
(`z +0.19`) and the emissive `visor` (`z +0.11`) are all on the **+Z front**. The
default camera sits directly behind (`CameraRig.js:30-32`). Every element the code
comment at :201-205 nominates as "what makes the form legible" is 100% occluded
in the only view the player ever has. What the back actually gets is cloak +
spine trim + a canister + the black sling of U5.

**Fix.** Move the value break to the back: split the cape into a pale upper
shoulder yoke (`M.plate`, 0xcbcec9) over a near-black lower cape (`M.coatDark`,
0x121a24), and wrap the orange `accent` hem up the cape's centre seam. A 3:1
light/dark ratio across the back is what makes RoR2 survivors readable at 5m.

---

### U13 — Head and cape are the same value, so the character has no head in the outline [AREA A] — `src/entities/CharacterMesh.js:47`, `:49`, `:277`

**Pixels.** Head 80.5 vs upper cape 74.7 — a **7% luminance difference**, well
inside the noise of the flat-shaded facets. In the crop the helmet, the shoulder
pads and the cape are one continuous lilac mass; the only thing marking the top of
the character is a thin cyan antenna spike.

**Cause.** `COL.plate = 0xcbcec9` (L≈81%) and `COL.cloak = 0xb6bcbc` (L≈73%) are
adjacent values, and both materials sit at high roughness with weak rim
(`rimStrength: 0.18` and `0.22`), so nothing separates them.

**Fix.** Take the cloak down to ~`0x5a646c` (L≈40%) and keep the helmet at
`0xcbcec9`, or invert — either way open the head/body value gap to ≥30 points.
Free bonus: rotate the `visor` (:291-293, `emissiveIntensity: 2.4`) to be partly
visible from behind, or add a matching emissive nape strip, so the head has the
brightest pixel on the model as the comment at :273-274 intends.

---

### U14 — No equipment slot exists in the HUD [AREA E] — `src/ui/HUD.js:850-866`

**Pixels.** Bottom-right of both `03` and `06` contains four ability tiles and
nothing else. In `06-loaded-hud.png` the player holds three equipment-tier items
(the yellow row, top-left, `x11 / x6 / —`), but there is no equipment box, no
cooldown ring, and no `E` binding anywhere on screen. RoR2 puts the equipment
slot immediately right of the skill row with its own charge ring — it is the one
HUD element a survivor watches as closely as their health.

**Cause.** The `zone--br` template contains only `.log` and `.abilities`. No
equipment markup exists.

**Fix.** Add a fifth, visually distinct tile to `.abilities` (larger frame,
`--t-equipment` #ff9a3c border, a radial cooldown arc reusing the `.tp-arc`
stroke-dashoffset technique already in the file at hud.css/HUD.js:569-573) and
drive it from the equipped item.

---

### U15 — Objective banner contradicts the boss bar directly above it [AREA E] — `src/ui/HUD.js:79`, `:130-147`

**Pixels.** `06-loaded-hud.png` top-centre stacks, in 60 vertical pixels:
`BOSS — TELEPORTER BOSS — 100%` and, immediately beneath it,
`◆ FIND AND ACTIVATE THE TELEPORTER  55M`. The HUD is simultaneously telling the
player that a teleporter boss is at full health and that they have not found the
teleporter yet. Two competing instructions in the same glance region.

**Cause.** The objective string only changes on `teleporterCharging`,
`teleporterComplete` and `stageStart` (HUD.js:130-147). `bossSpawn` sets the boss
bar but never touches the objective.

**Fix.** In the `bossSpawn` handler (HUD.js:149) call
`this.setObjective('Defeat the teleporter boss')` and suppress the distance
readout while a boss is live. Also hide the `55M` distance once the teleporter has
been reached — it is stale in this frame.

---

### U16 — Camera FOV is 70° *vertical*, an extreme wide angle for third person [AREA F] — `src/core/CameraRig.js:27`

**Pixels.** `FOV_BASE = 70` is fed to `THREE.PerspectiveCamera.fov`, which is
vertical — that is ~**106° horizontal** at 16:9. The consequence is visible in
both gameplay shots: the foreground rocks at the right of `03` and the boulder
that eats the lower-right quadrant of `06` balloon far out of scale relative to
the midground, and the player's near geometry stretches toward the frame edge.
RoR2 ships ~60° horizontal-equivalent; the distortion here is why the composition
reads as fisheye rather than as a game camera.

**Fix.** `FOV_BASE = 55` (vertical), and pull `DIST` from 5.4 to ~7.0 to keep the
character at the same on-screen height (measured 254px / 28% of frame; that ratio
is actually correct and should be preserved). Reduce `FOV_SPRINT` to ~6 to match.

---

### U17 — Shoulder offset is too small; the crosshair grazes the player silhouette [AREA F] — `src/core/CameraRig.js:31`

**Pixels.** In `03-thirdperson.png` the measured player bounding box is
x 686–789. The reticle centre is at x 800 and its west arm reaches to x ≈ 785 —
**the crosshair's left arm overlaps the player's silhouette bounds**. The
character occupies the region the player must read to aim.

**Cause.** `SHOULDER = 0.65` at `DIST = 5.4` gives only ~62px of screen-space
separation between the player centre and the reticle, and the cape (U4) widens the
body enough to close it.

**Fix.** Raise `SHOULDER` to ~1.0 and, when U16's FOV change lands, re-check that
the character's right edge clears the reticle's outer arm by ≥40px. RoR2 keeps a
clear cone around the reticle at all times.

---

### U18 — The player has no ground contact [AREA A / F]

**Pixels.** Terrain immediately below the feet in `03-thirdperson.png` measures
mean luminance **6.1** (rgb 3,5,7); terrain to the left measures **5.8**. The
surface the character stands on is at ~2% of the value range, so a cast shadow on
it is mathematically invisible — and none is visible. The character's boots simply
end and black begins. Nothing anchors the survivor to the world, which is half of
why the silhouette reads as a floating cutout.

**Fix.** Two options, both cheap. (a) Add a dedicated contact-shadow decal under
the player — a soft dark ellipse composited *below* the terrain's own shading so
it survives a black floor (RoR2 does exactly this). (b) Lift the terrain's ambient
floor so the ground the player occupies is never below ~18/255. (a) is in this
domain; (b) belongs to the lighting critic but is the real root cause.

---

### U19 — Pickup log is text-only, breaking the icon language established two inches away [AREA E] — `src/ui/HUD.js:265-276`

**Pixels.** Right side of `06-loaded-hud.png`: six stacked rows —
`FROST RELIC`, `CEREMONIAL DAGGER`, `BRAINSTALKS`, `TITANIC KNURL`, `PLANULA`,
`QUEEN'S GLAND` — each with a small tier-coloured diamond and a coloured right
spine. No item icon anywhere. The same run is simultaneously showing 37 item
*icons* in the top-left, so the player has to learn two unrelated representations
of the same object. RoR2's pickup toast leads with the icon.

**Cause.** `toast()` builds `<i class="toast-mark"></i><span>text</span>` — a
generic diamond, not the item art. `itemArt(id, tier)` is already imported and
cached in the same file.

**Fix.** In `onItemPickup` (HUD.js:198), pass the id through to `toast()` and
render `<img src="${itemArt(id, tier)}">` in place of `.toast-mark`. Also: all six
entries are fully opaque with no age falloff — `updateToasts` only adds `is-out`
in the last 0.6s of a 5s life, so six pickups pile up at full strength. Stagger the
opacity by age.

---

### U20 — Clock panel has ~40% dead space and the difficulty meter is wider than the clock [AREA E] — `src/ui/hud.css:533-545`, `:573-580`

**Pixels.** In `06-loaded-hud.png` the clock plate spans roughly x 1420–1580.
`22:01` and `HARD x3.2` are right-aligned and begin at x ≈ 1490, but the notch row
starts at x ≈ 1445 — so the widest child is the meter, the panel sizes to it, and
the left ~40% of the plate under the numerals is empty frosted rectangle. The
result is a lopsided slab rather than a tight instrument.

**Cause.** `.clock` is `align-items: flex-end` with `padding: 0.5em 0.9em 0.6em
1.6em` and a `1.1em` clip chamfer; `.diffmeter` renders 10 notches at
`width: 0.85em; gap: 2px` ≈ 10.5em, wider than the `2.5em`-tall time string.

**Fix.** Drop the notch width to `0.55em` (meter ≈ 7em) so the meter and the
`22:01` string are within ~1em of each other, and cut the left padding from 1.6em
to 1.0em. Also `x3.2` is `var(--ink-faint)` (#5f6e80) — the difficulty *coefficient*
is the number an experienced player reads, and it is currently the dimmest text on
the panel. Promote it to `var(--ink-dim)`.

---

### U21 — Title screen: two different skew languages, and the tagline is a placeholder [AREA E] — `src/ui/hud.css:1031-1053`, `:1075-1080`; `src/ui/Menus.js:73`

**Pixels + cause**, four issues in one element:

1. **Skew mismatch.** `.title-word` and `.title-rule` use `skewX(-7deg)`
   (hud.css:1041, :1059) while every in-game HUD element uses `--skew: -16deg`
   (hud.css:37). `.mbtn` uses a third angle again — a right-edge-only clip
   (`calc(100% - 1.3em)`, :1084), where `.slot-key` chamfers both edges and
   `.item-stack` chamfers only the left. Four chamfer conventions in one design
   system; the menu and the HUD do not look like the same product.
   **Fix:** one shear token (`--skew`) and one chamfer helper used everywhere.
2. **Tagline.** `A Risk of Rain 2 alike` (Menus.js:73) is rendered as the
   kicker above the wordmark, in the accent colour, on the first frame the player
   sees. That is a dev note shipping as brand copy.
   **Fix:** replace with a real tagline.
3. **Scale gap.** The `PETRICHOR` wordmark measures 833px wide (x 382–1215);
   the button column measures 307px. A 2.7:1 jump with no intermediate step, and
   the bottom ~230px of the frame is completely empty. The type shouts and the
   interaction whispers.
   **Fix:** cap `.title-word` at `clamp(3.2rem, 8vw, 7rem)` and widen
   `.menu-list` to `min(30em, 70vw)`.
4. **Seed line.** `SEED 1337` is `var(--ink-faint)` `#5f6e80` at 0.85em over a
   near-black plate — measured barely above the detection floor and effectively
   invisible at 100% zoom. **Fix:** `var(--ink-dim)`.

---

### U22 — Title scrim crushes the live background to a flat 9% grey with only 3px of blur [AREA E] — `src/ui/hud.css:978-988`

**Pixels.** Mean luminance across the whole of `01-title.png` is **23.5/255**
(9%). The comment at hud.css:976-977 states the scrim "has to sit behind the type
rather than erase the shot" — the measurement says it erases the shot. The
horizontal wash (0.88 → 0.18) is stacked with a *second* vertical gradient at
0.55 top / 0.60 bottom, so the region where the wordmark actually sits gets
~0.95 combined opacity. The right third that does survive is blurred by only 3px,
so the low-poly terrain edges stay aliased and crunchy — neither sharp enough to
read as scenery nor soft enough to read as a backdrop.

**Fix.** Drop the vertical band to 0.30/0.35, pull the horizontal wash to
0.72 → 0.10, and raise the blur to 8–10px so the background becomes a clean
value field. Target a whole-frame mean of ~45–55/255. (The 3D content itself is
another critic's; this is purely the UI layer's treatment of it.)

---

## 3. Defect counts by area

| Area | Count | IDs |
|---|---|---|
| **A** — player mesh / silhouette (`CharacterMesh`) | 5 | U4, U5, U12, U13, U18* |
| **E** — HUD, menus, icons, CSS (`src/ui/*`, `src/data/items.js`, damage-number readout in `VFX.js`) | 14 | U1, U2, U3, U6, U7, U8, U9, U10, U11, U14, U15, U19, U20, U21, U22 |
| **F** — camera framing (`CameraRig`, `Harness`) | 3 | U16, U17, U18* |

`*` U18 (no ground contact) is counted in both A and F; its root cause is stage
lighting, which is outside this domain — the fix listed here is the character-side
contact decal. E count is 15 rows / 14 unique subsystems.

## 4. Commands and evidence

- `shots/manifest.json` read first: `ready: true`, 0 frame errors, 0 engine errors.
- PNG pixel probes (canvas `getImageData` via headless Chromium) for: player
  bounding box, per-region mean luminance, the y=730 luminance column, skill-tile
  edge positions in both gameplay shots, inventory plate extents at y=150, HUD
  colour samples, title-screen frame mean.
- Glyph-orientation control: rendered `161` in `bold "Arial Black", Impact` under
  `scaleX(-1)`, `scaleY(-1)` and `rotate(180deg)` and matched against a 12x zoom
  of the numerals in `06-loaded-hud.png`. Match = `scaleY(-1)`.
- Source read: `HUD.js`, `hud.css`, `Menus.js`, `Icons.js`, `items.js`,
  `CharacterMesh.js`, `CameraRig.js`, `Harness.js`, `VFX.js` (DamageNumbers),
  `Enemy.js`, `CONTRACTS.md`.
- `grep -n "level|xp|experience" src/entities/Player.js` → **no matches**
  (evidence for U2).
- No project files were modified. `tools/capture.mjs` was not run.

## 5. Claims I checked and withdrew

Listed for honesty, since a critic who only reports hits is not being measured.

- **"Skill tiles are vertically misaligned."** Measured tile top edges in
  `03-thirdperson.png` at x = 1310/1386/1461/1537 → **763, 763, 763, 763**, and
  left edges at 1276/1351/1427/1503 (pitch 75–76px, widths 67–68px). Perfectly
  aligned and uniform. The apparent offset was the cooldown sweep darkening one
  tile.
- **"Item icons collide with 16 shared glyph shapes."** `Icons.js:207` does have
  only 16 glyphs for 37 items, but the HUD's actual path (`Icons.itemArt` →
  `items.itemIcon`) uses the per-item `glyph` field, of which all 37 are unique.
  The legibility problem is real but its cause is the random hue (U7) and the 33px
  render size, not shape collision.
- **"Title wordmark and button column are on different centre axes."** Measured
  wordmark glyph extent x 382–1215 (centre 798.5) vs button column centre ≈ 794.
  A 4px difference. Not a defect.
- **"Gold is wrong — harness gives 4200 but HUD shows $5,058."** `Harness.js:128`
  adds 4200 on top of whatever the run had already earned across the preceding
  captures. Correct behaviour.
- **"Boss bar stuck at 100% is a bug."** Shot 06 is captured at t=1322s after
  shot 05 spawned the boss at t=8s with the player made invulnerable and not
  firing. 100% is consistent.
