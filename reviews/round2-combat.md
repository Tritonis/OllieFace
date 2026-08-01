# PETRICHOR — Round 2 critic report: COMBAT / VFX domain

Reference target: Risk of Rain 2 (Hopoo/Gearbox), Titanic Plains / Abandoned Aqueduct.
Shots judged: `shots/04-combat.png`, `shots/05-boss.png`, `shots/08-explosion.png`.
Seed 1337, 1600x900. `shots/manifest.json`: `ready: true`, `errors: []`, every shot
`frameErrors: 0`. No crash to report — the frames are honest output, so the pixels
are the whole case.

Domain axes owned: **4 (silhouette & form)**, **6 (VFX quality)**, **8 (readability
under load)**. All ten axes are scored per the rubric; defects are confined to the
owned domain plus the framing/composition axis the orchestrator assigned (AREA F).

---

## 1. Axis scores

| Axis | 04-combat | 05-boss | 08-explosion |
|---|---|---|---|
| 1 Lighting & shadow | 5 | 4 | 4 |
| 2 Composition & depth | 5 | 3 | 3 |
| 3 Colour & grade | 6 | 6 | 5 |
| **4 Silhouette & form** | **3** | **2** | **2** |
| 5 Material believability | 4 | 4 | 4 |
| **6 VFX quality** | **4** | **4** | **2** |
| 7 UI/HUD craft | 6 | 6 | 7 |
| **8 Readability under load** | **3** | **2** | **2** |
| 9 Post-processing | 4 | 4 | 3 |
| 10 Cohesion | 6 | 5 | 5 |
| **mean** | **4.6** | **4.0** | **3.7** |

```
04-combat     AXIS SCORES: 1:5 2:5 3:6 4:3 5:4 6:4 7:6 8:3 9:4 10:6   VERDICT: FAIL
05-boss       AXIS SCORES: 1:4 2:3 3:6 4:2 5:4 6:4 7:6 8:2 9:4 10:5   VERDICT: FAIL
08-explosion  AXIS SCORES: 1:4 2:3 3:5 4:2 5:4 6:2 7:7 8:2 9:3 10:5   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Every
shot has three axes at 2–3. The domain axes (4, 6, 8) are the worst-scoring axes in
all three frames.

### What is actually working (so the fixes don't destroy it)

- The warm-key / cool-shadow split is real and consistent across all three frames —
  amber sun rake on the left ridges against blue-violet shade. That is the one thing
  in this build that genuinely reads as Risk of Rain 2 and axis 3 earns its 5–6.
- Aerial perspective on the far mountains is convincing; depth in the *background* is
  the strongest compositional element present.
- HUD chrome (angular health bar with segment ticks, the difficulty meter, the ability
  tray, the item grid in `08`) is dense, hierarchical, and consistently styled. It is
  the highest-scoring element in the build and none of the fixes below should touch it.
- The layering *intent* in `src/systems/VFX.js` is correct — flash + sparks + smoke +
  light + shake per hit. The failures below are execution (sprite edges, tone, timing),
  not architecture.

### Orchestrator's starting observations — adjudicated

| Claim | Verdict | Evidence |
|---|---|---|
| Damage numbers ("400", "133") depth-clipped by world geometry | **REFUTED — but a worse bug found.** `VFX.js:1690` sets `depthTest: false` and `renderOrder 20`; the numbers draw over everything, and in `04-combat` the "400" visibly overprints the teleporter beam. What is actually wrong: **every damage number is rendered upside-down.** See V1. | 04 (740,300); 05 (700,315) |
| Muzzle flashes / impact sparks are blown-out flat white discs | **CONFIRMED, cause reassigned.** Cores measure 255,255,245 with no hue (V8) — but the *repeated* white discs are mostly the enemies' own emissive eye meshes at `emissiveIntensity 2.4` (V4), not muzzle flashes. Separately, several sprites really are hard-edged flat polygons (V5). | 04 (1105,510) = 255,254,245; 04 (895,455) = 255,255,247 |
| Enemies read as indistinguishable blobs | **CONFIRMED.** See V4, V9, V12. | 04 (1000,480)–(1300,700); 05 (950,400)–(1350,650) |
| In 05-boss the boss is poorly framed / partially out of frame | **CONFIRMED and worse.** The boss is not in the frame at all. The `BOSS 100%` bar is displayed over an empty arena. See V2. | 05, full frame |

---

## 2. Defect list, ranked by rubric cost

### V1 — Every damage number is rendered upside-down [AREA B] — axes 6, 8, 7

`src/systems/VFX.js:1790` (`tex.flipY = false`) with `src/systems/VFX.js:1623`
(`vUv = (uv + vec2(mod(aGlyph.x, uAtlasCols), floor(aGlyph.x / uAtlasCols))) / uAtlasCols;`)

**Pixels.** In `04-combat` the number over the teleporter beam at (735,300)–(830,335)
reads `⌐00`; the pair at (700,375) and (710,405) read `⌐3`. In `05-boss` at
(700,310)–(790,345) three numbers read `⌐3`. The leading glyph is not a `4` or a `1` —
it is a vertically mirrored one. Zeros survive because they are symmetric about the
horizontal axis, which is exactly why the bug reads as "clipped/garbled" rather than
"flipped".

**Reproduction (no engine run needed).** Crop `05-boss.png` at `(700,310,90,50)`, apply
`RotateNoneFlipY`, and the region resolves cleanly to `13  13` / `13`. Verified with
System.Drawing; the flipped crop is unambiguous. A vertical flip of the *screen region*
recovering legible text is proof the glyph quads sample the atlas tile inverted in V.

**Why.** With `flipY = false` the canvas's top row uploads to `t = 0`. Tile row `r`
therefore occupies `t ∈ [r/4, (r+1)/4]` measured top-down, but the quad's `uv.y = 0` is
at the quad's *bottom*, so the bottom of the quad samples the top of the tile.
`ParticleSystem.js:399` makes the identical assumption; it is invisible there only
because 14 of the 16 particle sprites are vertically symmetric.

**Fix.** In `NumberVert` (`VFX.js:1623`):
```glsl
vUv = (vec2(uv.x, 1.0 - uv.y) + vec2(mod(aGlyph.x, uAtlasCols), floor(aGlyph.x / uAtlasCols))) / uAtlasCols;
```
Do the same in `ParticleVertexShader` (`src/shaders/ParticleShader.js:134`) so the two
atlases stay consistent, and add a boot assertion that renders glyph index 1 and checks
the top-half alpha mass exceeds the bottom-half (a `1` is top-heavy in Arial Black).

This is defect #1 because the damage number is the single most-repeated piece of combat
feedback in the game and it is wrong in **100% of frames that contain one**.

---

### V2 — `05-boss` contains no boss [AREA F] — axes 4, 2, 8, 7

`src/core/Harness.js:116` — `const at = new THREE.Vector3(p.x + 14, p.y + 2, p.z + 14);`

**Pixels.** The `BOSS / TELEPORTER BOSS / 100%` bar spans the top of frame. The Titan
is `radius 2.2, height 7.6` (`src/data/enemies.js:167-168`) — eight metres, described in
`EnemyMeshes.js:1003` as "eight metres of stone with a glowing core, two fists it raises
over its head". At the intended ~20 m it would occupy roughly a third of frame height.
Nothing of that description exists anywhere in `05-boss.png`. The tallest things in
frame are two ~1 m purple `pest` bells at (810,380) and (835,610), a `golem` box at
(1100,500), and a maroon `lemurian` slab filling (150,350)–(500,470). The shot whose
stated purpose is "judges scale, boss silhouette, boss HUD" contains zero of the three.

**Why.** `spawnRing` (`Harness.js:57-76`) is careful — it fans spawns across
`camera.getWorldDirection()` ±70° (`:60-64`) and drops each onto `stage.sampleHeight`
(`:68`). The boss spawn does neither: it uses a fixed **world-axis** `+X/+Z` diagonal
regardless of where the camera is looking, and it uses `p.y + 2` with no terrain sample,
so on sloped ground the boss spawns buried or below the ledge. Then `attach()` (`:111`)
hands the camera back to the third-person rig, which never aims at it.

**Fix.** Place the boss the same way `spawnRing` places everything else, then frame it:
```js
const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
const x = p.x + fwd.x * 22, z = p.z + fwd.z * 22;
const at = new THREE.Vector3(x, (ctx.stage?.sampleHeight?.(x, z) ?? p.y) + 4, z);
```
and after `spawnOne`, `detach()` + `camera.lookAt` the boss's chest height (`at.y + 3.8`)
from ~26 m back and 6 m up, so the shot actually tests boss scale.

---

### V3 — `08-explosion` contains no explosion [AREA F, cause in B] — axes 6, 8, 2

`tools/capture.mjs:99` (`await settle(page, 12)`) against `src/systems/VFX.js:386-415`.

**Pixels.** The shot documented as "Peak VFX moment: explosion + damage numbers + shake"
shows: no fireball, no shockwave ring, no debris cluster, no smoke column at the blast
site. What is present is a featureless grey radial haze covering (600,250)–(1200,650)
that reads as a smudged lens, ~30 scattered orange embers, and two soft orange ribbons.
The frame is 46.0% of pixels below luma 24 (sampled every 3rd pixel, 160k samples).
`shots/08-explosion.png` cannot be distinguished from a non-explosion frame.

**Why — arithmetic, not opinion.** The manifest records `ctx.time` 1323.833 at `07` and
1324.467 at `08`: **0.633 s of gameplay across the 12 settle frames** (~19 fps under the
capture's forced quality 3). Against the explosion's own timings in `VFX.js`:

| Layer | line | life | alive at 0.63 s? |
|---|---|---|---|
| white core `FRAME.CORE` | `:388` | 0.09 s | dead |
| fireball flare `FRAME.FLARE` | `:395` | 0.22 s | dead |
| shockwave rings | `:414-415` | 0.45 / 0.28 s | dead |
| fireball smoke | `:406` | 0.42 s ±0.45 | mostly dead |
| embers / debris | `:435 / :422` | 1.1 / 1.5 s | alive — this is all we see |

Every beat that makes an explosion read has expired before the shutter opens.

**Fix.** Two changes, both required. (a) `capture.mjs:99` → `settle(page, 3)` so the
shutter lands ~0.15 s in, inside the fireball/ring window. (b) Make it frame-rate
independent rather than luck: add `H.explosionAt(framesBeforeShot)` that re-fires
`ctx.vfx.explosion` from a `requestAnimationFrame` callback two frames before the
screenshot, so the capture cannot drift past the effect again when fps changes. While
there, `Harness.js:158` places the blast at `p + (6, 1.5, 6)` — same world-axis bug as
V2; use the camera-forward form so the blast is centred in frame.

---

### V4 — Enemies are boxes wearing identical blown-white eyes [AREA A] — axes 4, 8

`src/entities/EnemyMeshes.js:137-140` (eye material, `emissiveIntensity: 2.4`) and
`:90-95` (the six palettes' `eye` colours).

**Pixels.** Crop `04-combat` at (1000,480,300,220): the "enemy" is a flat navy
parallelepiped with a pure-white disc where a head should be, sampling 255,255,246 at
(1105,510) — no hue survives. Crop `05-boss` at (950,400,400,250): a second enemy is the
same box silhouette with the same white disc at (1030,430) = 255,253,240. Across
`04-combat` there are eight of these discs at (632,376), (715,420), (895,455),
(1105,510), (1243,565) and three more on the right ridge. They are the only
high-contrast features on any enemy, they are all the same size, the same shape and the
same colour, and they sit at the same height on every body. The frame reads as a row of
streetlights, not as a horde of distinct monsters.

**Why.** All six `PAL` entries pick a near-white eye — `0xffc23a`, `0xe9ff5a`,
`0xffd9a0`, `0xa8f2ff`, `0xffd0e2`, `0xffe08a`. Every one of those, multiplied by
`emissiveIntensity 2.4` and pushed through the bloom threshold, clips to white. The
species tint is destroyed by exactly the element that is supposed to identify the
species. Meanwhile the *body* materials (`:127-131`) carry `emissiveIntensity: 0` unless
elite, so the body has no self-lit read at all and sits in the crushed-black band (V9).

**Fix.** Three changes:
1. Drop `emissiveIntensity` on `eye` from `2.4` to ~`1.1` and *saturate* the eye colours
   instead of brightening them (`lemurian` `0xff8a00`, `beetle` `0xb4ff10`, `golem`
   `0x00d0ff`, `pest` `0xff2f7a`, `wisp` `0xff5a00`, `titan` `0xffb020`) so the hue
   survives tone-mapping. A saturated 1.1 emissive reads hotter than a clipped 2.4.
2. Differentiate eye *geometry* per species, not just colour: golem keeps the single
   large `ico(0.17)` (`:852`), lemurian gets a paired narrow slit, beetle gets the
   existing cluster, pest gets the spot row. Right now the disc shape is a constant.
3. Add a species-coloured rim term to the body material so the silhouette separates from
   terrain of the same value (see V9).

---

### V5 — Particle sprites with alpha = 1 at a hard polygon edge [AREA B] — axis 6

`src/fx/ParticleSystem.js:641-659` (`hexShard`), `:661-668` (`softSquare`),
`:571-590` (`debrisChunk`).

**Pixels.** `05-boss` at (1090,655)–(1160,715): a perfect regular hexagon, ~70 px across,
filled flat at 216,189,177 with a **geometrically hard edge and zero falloff** — the
rubric's literal description of a 4 on axis 6 ("flat billboard puffs, hard-clipped
particle edges"). A second is at (1210,545) in `04-combat`, and a third hexagon plus a
hard-edged white parallelogram sit at (1085,555) and (1050,590) in `04-combat`'s
enemy crop.

**Why.** `hexShard` builds a radial gradient that goes `0.85 → 0.35 → **1.0**` — alpha
climbs *back to full opacity* at `r = 0.45s` (`:653-655`) and is then clipped by
`g.fill()` on the hexagon path. There is no soft margin between the alpha-1 rim and the
transparent tile, so the sprite has a knife edge at every scale. `softSquare` (`:667`)
and `debrisChunk` (`:587`) fill to alpha 1 with no falloff at all. None of the callers
that use these frames set `e.soft`, so the depth-fade in `ParticleShader.js:164-173`
never engages either — `shieldBreak` (`VFX.js:673-680`) and the `glacial`/`freeze`
presets (`VFX.js:67, 76`) all leave `soft` at its default.

**Fix.** Reverse the gradient's final stop and inset the polygon so the sprite fades out
inside its own tile:
```js
const r = s * 0.38;                       // was 0.45 — leave a margin
grad.addColorStop(0.00, 'rgba(255,255,255,0.95)');
grad.addColorStop(0.70, 'rgba(255,255,255,0.55)');
grad.addColorStop(1.00, 'rgba(255,255,255,0)');
```
then draw the hexagon path once more at `r * 1.18` with `g.filter = 'blur(6px)'` and
`globalAlpha 0.5` to give the silhouette a soft shoulder. Apply the same inset-plus-blur
to `softSquare` and `debrisChunk`. Independently, set `e.soft = 0.6` on every emitter
that uses `HEX`, `CHUNK` or `SQUARE` (`VFX.js:237, 427, 679`) so ground intersections
fade instead of showing a cut line.

---

### V6 — Tracers read as CAD wireframe overlays, not bullets [AREA B] — axes 6, 8

`src/systems/VFX.js:249-250` (`tracer`), beam fragment shader `VFX.js:1383`.

**Pixels.** `04-combat` carries five full-width straight lines: cyan from (620,270) to
(1560,430), cyan from (0,500) to (1600,560), red from (760,430) off the right edge, red
from (0,545) to (1590,275), cyan from (830,505) to (1600,600). Each is dead straight,
**uniform in both width and brightness from screen edge to screen edge**, and several
start and end off-frame. Real RoR2 tracers are short, taper visibly, and are gone in
about a tenth of a second. These read as a vector-graphics overlay laid on top of the
render, and they are the single biggest contributor to the "screen is undifferentiated
noise" failure on axis 8 because they cut the composition into unrelated wedges.

**Why.** `BeamFrag:1383` fades the ends with
`smoothstep(0.0, 0.04, vUv.y) * smoothstep(1.0, 0.96, vUv.y)` — 4% of length. On a 40 m
tracer that is a 1.6 m fade, i.e. sub-pixel at this camera distance; the line terminates
hard. Length-wise brightness is otherwise constant: `vColor.a` never varies along `vUv.y`.
The width taper (`width0 0.16 → width1 0.02`, `VFX.js:249`) is swamped by the
`pow(edge, 10.0) * vCore` core term at `:1382`, which saturates the centre line at every
width, so the taper is invisible.

**Fix.** Two lines. In `BeamFrag`, replace the symmetric end mask with a head-biased
one so the tracer has a bright head and a dissolving tail, and add an along-length decay:
```glsl
float head = smoothstep(0.0, 0.10, vUv.y);
float tail = pow(vUv.y, 1.8);                 // bright at the head, fades to the tail
float ends = head * smoothstep(1.0, 0.88, vUv.y);
float a = vColor.a * (soft + core) * ends * mix(0.15, 1.0, tail);
```
And in `tracer` (`VFX.js:246-250`), clamp the drawn segment to the last ~8 m before the
impact point rather than spanning muzzle-to-target, so a 60 m shot draws an 8 m streak.

---

### V7 — Damage numbers shrink to an illegible smear with no screen-space floor [AREA B] — axes 6, 8

`src/systems/VFX.js:1615-1621` (`scale = aGlyph.w * pop`, applied in view space) and
`:1719` (`const scale = crit ? 0.62 : 0.38;`).

**Pixels.** `08-explosion` at (485,492)–(515,502): the damage readout is a **30 x 8 px**
smear with visible blue-left / orange-right chromatic fringing, sitting on flat black
terrain. No digit is recoverable at any zoom. In `04-combat` the same system produces
legible ~28 px glyphs at (735,300). Same code, same frame budget, order-of-magnitude
different legibility.

**Why.** `mv.xy += corner` adds a **world-space** offset before projection, so glyph
height is `0.38 m` at any distance and shrinks with perspective. At 40 m with the
capture's FOV on a 900 px frame that is `0.38 / (2·40·tan 30°) · 900 ≈ 7 px` — matching
the measured 8 px exactly. There is no minimum, and no distance cull either, so far-off
chip damage still spends instances on unreadable smears.

**Fix.** Clamp the projected height in the vertex shader. After computing `mv`:
```glsl
float dist = max(-mv.z, 0.001);
float minWorld = dist * uMinPx * uPxToWorld;   // uPxToWorld = 2*tan(fov/2)/viewportHeight
float scale = max(aGlyph.w, minWorld) * pop;
```
with `uMinPx ≈ 18` for normals and `26` for crits, updated in `resize()`
(`VFX.js:1756`, currently a no-op that claims the atlas is resolution-independent — the
*scale* is not). Additionally, skip the spawn entirely in `DamageNumbers.spawn`
(`:1703`) when the world position is beyond ~45 m, and exclude the number pass from
chromatic aberration — a 4 px glyph cannot survive a channel offset.

---

### V8 — Every flash core is the same clipped hueless white [AREA B] — axes 6, 3, 9

`src/systems/VFX.js:273`, `:315`, `:389` — all three set `e.color0.set(0xffffff)`.

**Pixels.** Measured cores: 04 (1105,510) = 255,254,245 · 04 (895,455) = 255,255,247 ·
04 (632,376) = 255,255,246 · 04 (715,420) = 255,255,244 · 05 (1030,430) = 255,253,240.
Five separate effect types — impact flash, hit spark, muzzle core, enemy eye, explosion
core — all land on the same value with a maximum channel spread of 11/255. There is no
colour temperature difference between a bullet striking stone and a bullet striking
flesh, so the material-specific `color1` tints at `VFX.js:55-62` never reach the eye.

**Why.** Additive blending (`ParticleShader.js:199`) plus `toneMapped: false` (`:201`)
plus the bloom pass means anything starting at 1,1,1 saturates instantly and stays
saturated for its whole visible life; `color1` only takes over as alpha is already
falling off.

**Fix.** Start flash cores at a *hot tint*, not at white, and let additive stacking do
the whitening. `impact` (`:273`) → `e.color0.set(preset.spark).multiplyScalar(1.6)`;
`hitSpark` (`:315`) → `e.color0.set(0xfff0c8)` for normal, `0xffd24a` for crit;
`explosion` (`:389`) → `e.color0.set(0xfff4d8)`. Cap the additive layer's `uIntensity`
(`ParticleShader.js:192`) so a single sprite cannot exceed ~1.6 on its own and only
overlapping sprites clip — that is what makes an RoR2 flash read as *hot* rather than as
*blank*.

---

### V9 — Combat happens in the crushed-black band [AREA A + B] — axis 8

Enemy body materials `src/entities/EnemyMeshes.js:127-131` (`emissiveIntensity: 0` for
non-elites) interacting with the grade.

**Pixels.** Sampled every 3rd pixel across each full frame (160,000 samples):

| shot | pixels below luma 24 | pixels at clipped white |
|---|---|---|
| 04-combat | **28.6%** | 0.4% |
| 05-boss | **38.1%** | 0.2% |
| 08-explosion | **46.0%** | 0.2% |

Spot values inside those regions: 04 (300,700) = 20,6,13 · 05 (120,600) = 12,3,9 ·
05 (300,700) = 14,2,9 · 08 (200,500) = 8,3,6 · 08 (700,850) = 5,2,3. The tonal
distribution is bimodal — crushed shadow and clipped VFX highlight, with the enemies
living entirely in the crushed half. In `05-boss` the player character itself is a
featureless black cutout at (690,430)–(760,640) against equally black rock; in
`08-explosion` the lower-left third of frame is a single unmodulated black mass.

**Fix.** Give every monster a cheap species-coloured rim so silhouette survives a black
background: in `EnemyMeshes.js:127-131`, add `emissive: palette.accent` with
`emissiveIntensity: 0.12` on `body`/`dark`, and patch the body material with a
Fresnel rim term (`onBeforeCompile`, `rim = pow(1.0 - dot(N, V), 3.0) * accent * 0.6`).
That is the RoR2 read: monsters carry their own faint edge light so they never
disappear into terrain. Pair it with a lift on the shadow toe in the grade so
sub-luma-24 coverage drops under ~15%.

---

### V10 — Decals are oriented quads, so blood floats as a sticker [AREA B] — axes 6, 10

`src/fx/Decals.js:10` (the file's own admission: "oriented quads snapped to the surface
normal rather than true projections"), `:135-145` (`place`), `:171-178` (`project`).

**Pixels.** `05-boss` at (830,585)–(1000,615): a hard-edged red smear lies across a
faceted brown rock. It does not follow the facet break running through it — half the
splat sits on a plane facing the camera and the other half is sliced by the silhouette
edge, so the shape reads as a decal texture pasted over the render rather than blood on
a rock. A second instance is visible in `05-boss` at (690,80) in the same crop family.

**Why.** `project` raycasts once (`:176`), gets one point and one normal, and `place`
builds a single quad on that plane (`:141-142`). Any surface with curvature or a facet
break inside the decal's footprint — which is every rock in this stage — shows the quad
cutting through. `polygonOffset -4/-4` (`:109-111`) hides z-fighting but cannot hide the
geometric mismatch.

**Fix.** Cheapest fix that removes the artefact without a real projector: shrink the
footprint below the facet scale and orient to the *averaged* normal. Take four
raycasts on a small cross around the hit point in `project`, average the normals, reject
the placement if the max pairwise normal angle exceeds ~25°, and clamp
`opts.size` to `min(size, 0.6 * distance-to-nearest-facet-break)`. Longer term, swap
`place` for a box-projected decal that clips against the receiving triangles.

---

### V11 — Projectile trails read as lens flares, not motion [AREA B] — axes 6, 8

`src/entities/Projectile.js:110-111` (`width: p.radius * 1.1`, `trailLife 0.22`) with
`src/fx/Trails.js:92` (`AdditiveBlending`) and `:86` (`uCore: 1.4`).

**Pixels.** `08-explosion` carries two broad orange ribbons sweeping (0,560)→(1600,300)
and (900,640)→(1600,430). They are ~25 px wide, soft-edged, uniform in brightness, and
have **no visible head** — nothing marks where the projectile is or which way it is
travelling. They arc across the whole frame like anamorphic lens streaks and cross in
front of the foreground rock pillar at (900,300)–(1050,620) at full brightness. The same
system in `04-combat` is invisible, so the trail either dominates or does nothing.

**Why.** A width of `radius * 1.1` on a `radius 0.35–0.4` projectile
(`src/data/enemies.js:68, 97`) gives a 0.44 m ribbon, which at 8–15 m is 25+ px of
additive white-cored geometry; bloom then doubles it. `TrailFrag:42-44` gives a constant
`uCore` along the whole strip, so the head is no brighter than the tail — the taper at
`vParam.x` is never used in the fragment shader at all.

**Fix.** Use the head parameter that is already being passed but ignored. In
`TrailFrag`, weight both width and core by `vParam.x`:
```glsl
float headw = mix(0.25, 1.0, vParam.x);       // narrow at the tail
float edge  = 1.0 - abs(vParam.y) / headw;
float core  = pow(max(edge, 0.0), 8.0) * uCore * vParam.x;
```
and halve the spawn width at `Projectile.js:111` to `p.radius * 0.55`. That restores a
bright head and a vanishing tail, which is what makes a trail read as velocity.

---

### V12 — Nothing is grounded: no contact shadow under any enemy [AREA A] — axes 4, 8, 1

`src/entities/EnemyMeshes.js:1252` (`for (const m of rig.eye) m.castShadow = false;`) —
and no blob/contact shadow anywhere in the rig builders.

**Pixels.** In `04-combat` the enemies at (1105,510), (1243,565) and the cluster at
(1000,600)–(1300,720) have no darkening beneath them and no cast shadow on the rock they
stand on. In `05-boss` the two `pest` bells at (810,380) and (835,610) hover with no
contact cue whatsoever — the one at (835,610) is impossible to place in depth relative to
the rock behind it. Depth ordering in the horde is therefore guesswork, which is a direct
axis-8 failure: you cannot tell which threats are near.

**Fix.** Add a cheap projected blob shadow per rig: one `CircleGeometry` with a soft
radial alpha texture, `MeshBasicMaterial` multiply-blended, parented to the rig root,
raycast down to `stage.sampleHeight` each frame, radius `= entity.radius * 1.4`, opacity
scaled by `1 - clamp(height above ground / 3, 0, 1)`. That is one draw call per enemy in
an instanced pool and it is what separates "monsters standing on terrain" from
"sprites floating in front of terrain".

---

### V13 — Unidentifiable orange mass cropped by the frame edge in `04-combat` [AREA A/F] — axes 4, 2

`src/core/Harness.js:57-76` (`spawnRing`, `radiusBase = 8`).

**Pixels.** `04-combat` (1000,745)–(1200,900): a saturated orange-red mass runs off the
bottom edge of frame. It is the brightest warm object in the lower third and it reads as
neither enemy, prop, nor effect — most likely a `blazing`-affix elite
(`EnemyMeshes.js:100`) spawned inside the camera's near field. It pulls the eye to a
corner that contains no information.

**Fix.** `spawnRing` places the first ring at `radiusBase = 8` m from the player
(`Harness.js:57, 65`). With the third-person boom that puts spawns closer to the camera
than the player is. Raise the combat ring's `radiusBase` to 12 and add a rejection test
that re-rolls any spawn whose projected screen position falls outside
`[0.06, 0.94] × [0.06, 0.94]` of the viewport, so the horde is fully in frame and the
composition stays readable.

---

## 3. Defect index

| ID | Area | Axes hit | One line |
|---|---|---|---|
| V1 | **B** | 6, 8, 7 | Damage numbers rendered upside-down (`VFX.js:1790` / `:1623`) |
| V2 | **F** | 4, 2, 8, 7 | Boss absent from the boss shot (`Harness.js:116`) |
| V3 | **F** | 6, 8, 2 | Explosion expired 0.63 s before the shutter (`capture.mjs:99`) |
| V4 | **A** | 4, 8 | Identical blown-white eye discs on box-bodied enemies (`EnemyMeshes.js:137-140`) |
| V5 | **B** | 6 | Alpha-1 hard-edged hexagon/square/chunk sprites (`ParticleSystem.js:641-659`) |
| V6 | **B** | 6, 8 | Full-width uniform tracer lines, no taper or head (`VFX.js:249` / `:1383`) |
| V7 | **B** | 6, 8 | 8 px illegible damage numbers, no screen-space floor (`VFX.js:1615-1621`) |
| V8 | **B** | 6, 3, 9 | All flash cores clip to hueless 255,255,245 (`VFX.js:273/315/389`) |
| V9 | **A+B** | 8 | 29–46% of frame crushed below luma 24, enemies live there (`EnemyMeshes.js:127-131`) |
| V10 | **B** | 6, 10 | Decals are oriented quads; blood floats as a sticker (`Decals.js:10`) |
| V11 | **B** | 6, 8 | Trails read as lens flares — no head, no taper (`Projectile.js:110` / `Trails.js:42`) |
| V12 | **A** | 4, 8, 1 | No contact shadow on any enemy; depth ordering unreadable (`EnemyMeshes.js` rigs) |
| V13 | **A/F** | 4, 2 | Unidentifiable orange mass cropped by the frame edge (`Harness.js:57-76`) |

**By area — AREA A: 3 (V4, V12, V13) · AREA B: 8 (V1, V5, V6, V7, V8, V9, V10, V11) ·
AREA F: 2 (V2, V3).**

Fix order for round 3: **V1, V2, V3** first — those three are why the three shots cannot
be judged on their stated purpose at all. Then **V4 + V9** together (they are the same
"monsters have no read" problem from the material side and the grade side), then
**V5, V6, V8** as the VFX-quality block.

## Appendix — commands run

Read-only throughout. No project file was modified; `tools/capture.mjs` was **not** run.

- `Read` on `RUBRIC.md`, `CONTRACTS.md`, `shots/manifest.json`, and the three PNGs.
- `Read` on `src/systems/VFX.js`, `src/fx/ParticleSystem.js`, `src/fx/Trails.js`,
  `src/shaders/ParticleShader.js`, `src/core/Harness.js`, `tools/capture.mjs`.
- `Grep` on `src/fx/Decals.js`, `src/entities/EnemyMeshes.js`, `src/data/enemies.js`,
  `src/entities/Projectile.js`.
- PowerShell + `System.Drawing`, nearest-neighbour crops at 2.5–8x into the session
  scratchpad, for: damage numbers (04, 05, 08), flash cores, enemy bodies, the `05`
  left third, the `08` blast site and trail.
- PowerShell + `System.Drawing` `RotateNoneFlipY` on `05-boss.png` crop `(700,310,90,50)`
  — the V1 proof.
- PowerShell + `GetPixel` point sampling at 22 named coordinates (V4, V8, V9), and a
  3-px-stride full-frame luma histogram over all three shots (V9).
