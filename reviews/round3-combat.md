# PETRICHOR — Round 3 critic report: COMBAT / VFX domain

Reference target: Risk of Rain 2 (Hopoo/Gearbox), Titanic Plains / Abandoned Aqueduct.
Shots judged: `shots/04-combat.png`, `shots/05-boss.png`, `shots/08-explosion.png`.
Seed 1337, 1600x900.

`shots/manifest.json`: `ready: true`, `errors: []`, `partial: false`, every shot
`frameErrors: 0`, `lastFrameError: null`. **No crash to report** — the frames are
honest output, so the pixels are the whole case.

Domain axes owned: **4 (silhouette & form)**, **6 (VFX quality)**, **8 (readability
under load)**. All ten axes scored per the rubric. Defects are confined to the owned
domain plus the framing axis the orchestrator assigned (AREA F).

---

## 1. Axis scores

| Axis | 04-combat | 05-boss | 08-explosion | (r2 → r3) |
|---|---|---|---|---|
| 1 Lighting & shadow | 5 | 5 | 4 | 5/4/4 → 5/5/4 |
| 2 Composition & depth | 5 | 5 | 5 | 5/3/3 → 5/5/5 |
| 3 Colour & grade | 6 | 6 | 5 | 6/6/5 → 6/6/5 |
| **4 Silhouette & form** | **4** | **3** | **4** | 3/2/2 → 4/3/4 |
| 5 Material believability | 4 | 4 | 3 | 4/4/4 → 4/4/3 |
| **6 VFX quality** | **4** | **4** | **3** | 4/4/2 → 4/4/3 |
| 7 UI/HUD craft | 7 | 7 | 7 | 6/6/7 → 7/7/7 |
| **8 Readability under load** | **5** | **4** | **3** | 3/2/2 → 5/4/3 |
| 9 Post-processing | 6 | 6 | 3 | 4/4/3 → 6/6/3 |
| 10 Cohesion | 6 | 5 | 5 | 6/5/5 → 6/5/5 |
| **mean** | **5.2** | **4.9** | **4.2** | 4.6/4.0/3.7 |

```
04-combat     AXIS SCORES: 1:5 2:5 3:6 4:4 5:4 6:4 7:7 8:5 9:6 10:6   VERDICT: FAIL
05-boss       AXIS SCORES: 1:5 2:5 3:6 4:3 5:4 6:4 7:7 8:4 9:6 10:5   VERDICT: FAIL
08-explosion  AXIS SCORES: 1:4 2:5 3:5 4:4 5:3 6:3 7:7 8:3 9:3 10:5   VERDICT: FAIL
```

**OVERALL VERDICT: FAIL.** Pass requires 7+ on every axis with none below 6. Only
axis 7 clears 7 in any frame. Eleven axis scores across the three frames sit at 3–4.

### What genuinely improved and must not be undone

- **The crushed-black failure is fixed.** Full-frame luma histogram, 3-px stride,
  160,200 samples per shot: sub-luma-24 coverage went **28.6% → 14.5%** (04),
  **38.1% → 12.0%** (05), **46.0% → 6.3%** (08). Nothing in the fixes below should
  touch the shadow toe.
- **Species now read by body colour.** Golem pale blue `(63,106,149)`, pest magenta
  `(255,105,147)` at 04 (855,445), a second pest hot orange `(255,115,60)` at
  04 (1180,640), beetle sage green at 05 (890,355). Round 2's row of identical
  white discs is gone: clipped-white coverage in 04 fell **0.4% → 0.02%**.
- **Boss and explosion are in frame at all.** Both scenarios now contain their
  subject for the first time. Their remaining defects are execution, not absence.
- **HUD is the best element in the build** and is now clean over a blown-out
  background too (08). Do not touch it.
- **Blob shadows exist and depth-order the horde in 04** — see V12, which landed
  as geometry but regressed as shading.

---

## 2. Round-2 defect ledger — LANDED / PARTIAL / NOT LANDED / REGRESSED

| ID | Status | Pixel evidence |
|---|---|---|
| **V1** damage numbers upside-down | **LANDED** (but see R3-7 / R3-9) | 08 crop `(755,340,70,30)` at 12x resolves as **`105`, right way up**, no flip needed. Second readout at 08 `(780,400)`. Source pair is consistent: `VFX.js:1687` samples `1.0 - uv.y` against `VFX.js:1881` `flipY = false`, `ParticleShader.js:138` matches, boot guard at `VFX.js:1899`. **The orientation bug is dead.** |
| **V2** `05-boss` contains no boss | **LANDED** (but see R3-3 / R3-4) | Stone Titan present at 05 `(758,130)–(858,355)`, silhouette 225 px tall × ~90 px wide, `STONE TITAN 100%` bar over an actual boss. |
| **V3** `08-explosion` contains no explosion | **PARTIAL — overshot the other way** | A blast now exists (1.09% of frame clipped white vs 0.2% in round 2) but it is a bare white core: **no fireball, no shockwave ring, no smoke column, no debris.** `Harness.js:630` `framesBefore = 4` fires the shutter ~0.026 s in. See R3-1. |
| **V4** identical blown-white eye discs | **LANDED** | `EnemyMeshes.js:149-152` eye `emissiveIntensity` 2.4 → **1.1**, colours re-saturated; `EnemyMeshes.js:136-143` adds `RimStandardMaterial` with `rimStrength 0.6`. Pixels: Titan core at 05 `(763,215) = 255,216,97` — **keeps its gold hue** instead of clipping to white; cyan rim visible on the golem edge at 05 `(1043,455)`. Per-species eye *geometry* is **NOT VERIFIABLE** — no enemy in any of the three frames is oriented so an eye is on screen. |
| **V5** alpha-1 hard-edged hex/square/chunk sprites | **NOT VERIFIABLE** | No `HEX`, `SQUARE` or `CHUNK` sprite appears in any of the three frames. The round-2 hexagon at 05 `(1090,655)` is gone from the new frame; nothing replaced it. Separately, the `FLARE` sprite **is** hard-edged — see R3-11. |
| **V6** tracers read as CAD wireframe | **PARTIAL** | Player tracers **landed**: `VFX.js:249-266` clamps to `TRACER_LENGTH = 8` (`VFX.js:55`) with `taper = 1`, and the 04 tracer at `(950,350)–(1350,550)` visibly thins and dims toward its tail. **But enemy attack beams were never touched**: 04 carries a 2-px, near-uniform cyan wire from `(125,0)` to `(460,310)` — 455 px, **exiting the top of frame**, brightness `(90,151,144)` at the top vs `(115,194,173)` at the bottom. Two more in 04 (crossings at y=260 x=927, y=420 x=901/1559), two in 05. See R3-8. |
| **V7** 8-px illegible damage numbers | **PARTIAL** | The screen-space floor landed (`VFX.js:1672-1675`, `NUM_MIN_PX = 18` at `:1635`): measured glyph ink at 08 `(755,340)` is **~15 px** tall vs round 2's 8 px. The 45 m cull (`VFX.js:1777`, `NUM_MAX_DIST = 45` at `:1638`) **is not the cause of any absence** — the 08 blast is ~21 m from the lens. The readout is nevertheless unreadable for a *new* reason (R3-9) and absent entirely from 04 and 05 (R3-7). |
| **V8** all flash cores clip to hueless white | **PARTIAL — the explosion core did not land** | The *tint-not-white* idea works where the ceiling bites: Titan core `255,216,97`, hue intact. It fails on the explosion: 08 `(770,348) = 255,255,241`, `(760,330) = 255,255,243`, `(800,350) = 255,251,235`, `(810,350) = 255,255,241` — max channel spread **14/255**, statistically identical to round 2's `255,255,245`. Cause: `VFX.js:410` sets `0xfff4d8` then `.multiplyScalar(1.5)` → every channel ≥ 1.0, and the "ceiling" `maxIntensity` defaults to **1.6** (`ParticleShader.js:196`), which is above the clip point and therefore does nothing. See R3-5. |
| **V9** 29–46% of frame crushed below luma 24 | **LANDED** | 14.5% / 12.0% / 6.3%. Target was under 15%; all three clear it. |
| **V10** decals are oriented quads | **NOT VERIFIABLE** | No blood or scorch decal is visible in any of the three frames. The candidate at 05 `(840,395)–(950,435)` is a terrain specular rake, not a decal (it follows the rock's lit edge exactly). |
| **V11** trails read as lens flares | **NOT VERIFIABLE** | No projectile trail is visible in any of the three frames. `Trails.js:43-46` now weights `headw` and `core` by `vParam.x` and `Projectile.js:114` halves the width to `radius * 0.55`, but nothing in these pixels tests it. |
| **V12** no contact shadow under any enemy | **LANDED, then REGRESSED** | Geometry landed: one pooled `InstancedMesh` (`EnemyMeshes.js:275-328`), blobs visible under the player at 04 `(700,620)–(790,650)` and under golems at 04 `(1040,490)–(1110,505)`. **But the ring term brightens instead of darkening.** `EnemyMeshes.js:301` / `CharacterMesh.js:153` write `vec3(0.30,0.34,0.42) * ring * 0.9`. Measured: 04 ground at `(700,635) = 33,22,30`, "shadow" ring at `(760,635) = 78,77,84` — **2.4x brighter than the floor it is supposed to darken**. At grazing angles it degenerates into a 286 × 7 px light-grey bar across 05. See R3-2. |
| **V13** unidentified orange mass cropped by the frame edge | **LANDED** | `spawnRing` radius raised to 13 (`Harness.js:416`). Nothing in 04 is cut by a frame edge; the orange pest now sits fully inside frame at `(1150,605)–(1235,685)`. |

**Score: 4 LANDED (V1, V2, V4, V9, V13 — five, counting V13), 4 PARTIAL (V3, V6, V7, V8),
3 NOT VERIFIABLE (V5, V10, V11), 1 LANDED-THEN-REGRESSED (V12).**

### The two regressions, stated plainly

1. **V12 regressed.** The contact shadow is now a *light* halo. Round 2 had no shadow;
   round 3 has one that lifts the ground it sits on and, seen edge-on, draws a bright
   scanline across the middle of the boss shot. A wrong shadow is worse than none.
2. **Damage numbers regressed in coverage.** Round 2's 04 and 05 both contained
   readouts (upside-down, but present). Round 3's 04 and 05 contain **zero**. Verified
   by scanning both full frames for the glyph's near-neutral black keyline
   (`R,G,B < 22`, channel spread < 6): 51 hits in each, **all 51 belonging to the
   crosshair** at `(774–820, 424–470)`. Not one glyph pixel anywhere else. The 45 m
   cull is **not** the cause — see R3-7 for what is.

---

## 3. New defect list, ranked by rubric cost

### R3-1 — `08-explosion` is a white flashbulb, not an explosion [AREA F] — axes 6, 8, 4, 5

`src/core/Harness.js:630` (`framesBefore = 4`), fired at `:663-666`.

**Pixels.** The frame documented as "Peak VFX moment: explosion + damage numbers +
shake" contains a single cream-white radial burst centred at `(790,340)` with hard
straight-sided godray spokes, and nothing else. **No fireball blobs, no shockwave
ring, no smoke column, no debris chunks.** Crop `(560,200,500,350)` at 2.6x: the
blast site is one flat luminous disc with four spokes; the only discrete particles
in the whole frame are ~20 ember dots.

**Why — arithmetic.** `ctx.time` advances in exact 1/60 steps (04→05 = 35/60,
07→08 = 26/60), but the render loop is free-running: the explosion scenario burns
**66 rendered frames for 26 sim steps**, i.e. ~152 rAF/s against a 60 Hz sim.
`framesBefore = 4` is therefore **4/152 ≈ 0.026 s**, not the ~0.067 s the comment at
`Harness.js:626-629` assumes. Against `VFX.js:399-474`:

| Layer | line | life | state at 0.026 s |
|---|---|---|---|
| white core | `:406` | 0.09 s | **at peak, fully occluding** |
| fireball flare | `:416` | 0.22 s | inside the core |
| fireball blobs (speed 9·s, drag 4.2) | `:426-428` | 0.42 s | travelled ~0.3 m — still inside the core |
| shockwave rings (r·0.35 → r·2.6) | `:435-436` | 0.45 / 0.28 s | radius 2.5 m — inside the core |
| smoke column (fadeIn 0.12) | `:473` | 2.2 s | alpha ≈ 0 |
| debris | `:443` | 1.5 s | ~0.35 m out — inside the core |

Round 2 photographed the tail. Round 3 photographs the flashbulb. Neither contains
an explosion.

**Fix.** Make `framesBefore` a *time* budget, not a frame count, and land it at the
peak of the fireball rather than the peak of the core:
```js
const waitSeconds = async (s) => {           // sim time, not rAF frames
  const t0 = ctx.time;
  for (let i = 0; i < 600 && ctx.time - t0 < s; i++) await frames(1);
};
ctx.vfx?.explosion?.(at, 6);
ctx.combat?.explode?.(at, 8, 300, null, {});
ctx.pipeline?.addShake?.(0.5);
await waitSeconds(0.16);                      // core dead, flare + ring + fireball alive
freeze();
```
0.16 s puts the shutter after the 0.09 s core expires, at ~73% through the flare,
with the outer ring at ~60% of its 2.6·r travel and the fireball blobs 1.4 m out —
the frame where an RoR2 explosion actually reads. Fixing this alone lifts axis 6 in
08 from 3 toward 6.

---

### R3-2 — The contact shadow is brighter than the ground [AREA A] — axes 1, 4, 8, 2

`src/entities/EnemyMeshes.js:301` and `src/entities/CharacterMesh.js:153` —
both `gl_FragColor = vec4(vec3(0.30, 0.34, 0.42) * ring * 0.9, a);`

**Pixels, 04-combat.** Horizontal scan at y = 635 through the player's blob:
ground at x = 700 is `33,22,30`; inside the blob at x = 750/760/770 it is
`53,45,54` / `78,73,84` / `78,77,93`. The "shadow" is **2.4x the luma of the floor**.
The player therefore stands in a pale ring, which reads as a puddle or a spawn decal,
not as occlusion.

**Pixels, 05-boss — the same shader at a grazing angle.** Vertical profile at x = 740:
`y 370–383` is terrain `(81,40,41)`, then `y 384–390` jumps to
`(109,88,95) / (114,93,100) / (110,88,94)` and drops back to `(80,40,41)` at y = 391.
Row-differencing y=387 against y=378 across the frame bounds the artefact at
**x = 638 → 924, 286 px wide by 7 px tall — a 41:1 bright grey bar** running straight
through the midground, crossing the Titan's legs and terminating under the beetle.
It is the boss's own `shadowR = 3.0` disc (`EnemyMeshes.js:1202`) seen edge-on: the
annulus where `ring` peaks is all that survives the projection, and that annulus is
the *lit* part of the shader. It reads as a rendering glitch, and it is the single
most distracting object in `05-boss`.

**Why.** The comment at `EnemyMeshes.js:287-291` is right that a purely subtractive
blob vanishes on luma-6 ground — but the answer chosen was to *add* light, and the
result is a halo. A contact shadow must never raise the value of the surface it lands
on; darkening plus a slightly *cooler hue* is what reads on near-black ground.

**Fix.** Keep the ring as a hue shift, not a luminance lift, and multiply rather than
composite. In both shaders:
```glsl
float a = (core * 0.55 + ring * 0.14) * uFade;
if (a <= 0.004) discard;
// Cool the floor instead of lifting it: near-black RGB with a blue bias reads as
// occlusion at every ground value; a positive grey never does.
gl_FragColor = vec4(vec3(0.02, 0.03, 0.06), a);
```
and set `blending: THREE.CustomBlending` with `blendSrc = THREE.DstColorFactor`,
`blendDst = THREE.OneMinusSrcAlphaFactor` (multiply) on `EnemyMeshes.js:312-318`
and `CharacterMesh.js:495-502`. Separately, damp the grazing-angle degeneracy: in
`updateShadow` (`EnemyMeshes.js:366-384`) fade `fade` by the camera's elevation over
the blob plane, `fade *= smoothstep(0.05, 0.25, abs(camDirToBlob.y))`, so a disc that
projects to a 41:1 sliver is not drawn at all.

---

### R3-3 — The Stone Titan is a legless mauve slab [AREA A] — axes 4, 5, 8, 10

`src/entities/EnemyMeshes.js:1195` (`TIT_HIP = 4.0`, `TIT_L1 = TIT_L2 = 1.9`) with
`:1270-1276` (leg chain), and `src/core/Harness.js:516-519` (no facing set).

**Confirming the orchestrator's read, with the cause corrected.** The "thin yellow
stick legs" are **not** the boss — they are sunlit terrain facets behind it
(`216,145,43` at 05 (758,355), (766,365), (774,375): a 1-px-per-5-rows diagonal that
continues past the boss to x = 1140, i.e. rock edge highlight, not geometry). The
"flat pink/tan cardboard slab" and "floating" are both **CONFIRMED**:

- **Silhouette extent.** Filtering the frame for the Titan's body hue (R−G in 38..75,
  B−G in 8..40) gives a solid mass from **y = 130 to y = 352**, x = 758 to 858. It is
  a narrow vertical rectangle, aspect 2.5:1. No head lobe, no arm mass, no leg taper,
  no fist — nothing that separates it from a standing monolith. The 06 rig's own
  comment (`EnemyMeshes.js:1191-1192`) promises "two fists it raises over its head":
  none of it is on screen.
- **It floats.** The drawn body stops at y = 352. Its own contact shadow (R3-2) is at
  y = 384–390. **32 px of bare terrain sit between the boss and its shadow** with no
  leg or foot geometry bridging them.
- **The mesh explains it.** The leg chain is 3.8 m long hanging from a 2.85 m hip:
  spine at `TIT_HIP = 4.0`, hip at `spine − 1.15 = 2.85` (`:1270`), knee at
  `2.85 − 1.9 = 0.95` (`:1272`), shin cylinder spanning `0.95 → −0.95` (`:1274`),
  foot box centred at `knee − 1.95 = −1.0` spanning `−1.25 → −0.75` (`:1275`).
  **The bottom 1.25 m of each leg and both feet are below y = 0** — buried in the
  terrain whenever the rig is grounded, and deeper on any downslope. The harness
  already measured this shortfall and worked around it
  (`Harness.js:533-535`: "the Titan's rig measures about 0.7 of its 7.6 m collision
  capsule on screen") instead of fixing the rig.
- **We are looking at its side.** The chest core (`accent` ico at `:1220`, world
  +Z 1.02) shows as a gold disc at 05 `(757,200)–(770,225)`, `255,216,97` — **outside**
  the torso's left silhouette edge (the body mass starts at x = 773 on those rows).
  The core is grazing past the torso, which only happens when the boss is turned
  ~70–90° off camera. `Harness.js:516-519` sets `position`, `home` and `velocity` but
  never a yaw, and only 3 frames elapse before `freeze()` (`:535-536`), so the AI has
  no time to turn. Face, both eyes, the core and both fists are all hidden.

**Fix.** Three changes, all small:
1. `EnemyMeshes.js:1195` → `TIT_L1 = 1.45, TIT_L2 = 1.4` (chain 2.85 m = hip height,
   feet land at y ≈ 0) and `:1275` → `P(box(1.15, 0.5, 1.6), 0, -TIT_L2 + 0.2, 0.2)`
   so the foot sits *on* the ground plane, not a metre under it. Then delete the 0.7
   fudge at `Harness.js:535` and aim at the real `bh`.
2. `Harness.js:519`, after `boss.velocity?.set?.(0,0,0)`, add
   `boss.yaw = Math.atan2(cam.x - spot.x, cam.z - spot.z);` (and mirror it onto
   `boss.rig?.pivot.rotation.y`) so the shot that exists to judge boss silhouette
   photographs the boss's front.
3. Widen the stance for silhouette: `:1270` `0.92 * s` → `1.25 * s`. A colossus reads
   by having a base wider than its head; at 90 px of screen width the current stance
   is a single column.

---

### R3-4 — The "judges scale" shot destroys the scale comparison [AREA F] — axes 2, 4, 8

`src/core/Harness.js:479` (`cx = p.x + dx * 16`) and `:492` (`const r = 20 + ring * 4`).

**Pixels.** Measured silhouette heights in `05-boss`: **Titan 222 px** (y 130→352),
**player 167 px** (y 545→712). The boss reads at **1.33x the player's screen height**.
The true ratio is `7.6 / 1.8 = 4.2x`. The frame's stated purpose — "Judges scale,
boss silhouette, boss HUD" — is defeated by its own camera placement.

**Why — arithmetic.** Apparent size ∝ height / distance, so the on-screen ratio is
`4.2 × (d_player / d_boss)`. The camera stands 16 m behind the player (`:479`) and the
boss is placed 20–28 m beyond the player (`:492`), giving `d_player ≈ 16`,
`d_boss ≈ 36–44`, and `4.2 × 16/40 = 1.68` — close to the measured 1.33 once the rig's
buried metre (R3-3) is subtracted. Perspective is cancelling exactly the difference the
shot exists to show.

**Fix.** Collapse the depth ratio: put the boss close behind the player and the lens far
back, and let the narrow 36° lens do the compression.
```js
const r = 9 + ring * 2;                       // Harness.js:492  (was 20 + ring * 4)
const cx = p.x + dx * 24, cz = p.z + dz * 24; // Harness.js:479  (was 16)
```
`d_player = 24`, `d_boss = 33` → `4.2 × 24/33 ≈ 3.1x`. At 3x the player's height the
Titan reads as a colossus. Also drop the backdrop requirement at `:503` from 45 m to
30 m — with the boss at 9 m ahead of the player the search will otherwise fail out to
the lenient branch on most terrain.

---

### R3-5 — The explosion core is still the same clipped hueless white [AREA B] — axes 6, 3, 9

`src/systems/VFX.js:410` (`.multiplyScalar(1.5)`) and
`src/shaders/ParticleShader.js:196` (`maxIntensity = 1.6`), applied at `:173`.

**Pixels.** 08 `(760,330) = 255,255,243` · `(770,348) = 255,255,241` ·
`(790,352) = 255,252,237` · `(800,350) = 255,251,235` · `(810,350) = 255,255,241`.
Maximum channel spread **14/255** across a mass covering **1.09% of the frame** (up
from 0.2% in round 2 — the defect got *larger*, not smaller). An explosion in this
build has no colour temperature: it is a hole in the image.

**Why the claimed ceiling does nothing.** `VFX.js:410` starts at `0xfff4d8` =
`(1.00, 0.957, 0.847)` and multiplies by 1.5 → `(1.50, 1.44, 1.27)`. The clamp at
`ParticleShader.js:173` is `min(c.rgb, vec3(1.6))` — **1.6 is above the display clip
point of 1.0**, so it never fires, and with `toneMapped: false` (`:213`) every channel
lands at 255. A ceiling only tints a sprite if it is below 1.0.

**Fix.** Two lines.
- `ParticleShader.js:196` → `maxIntensity = 0.92`. A single additive sprite then tops
  out just under white and keeps its hue; two overlapping sprites still clip, which is
  what makes an RoR2 flash read as *hot* rather than as *blank*.
- `VFX.js:410` → `e.color0.set(0xffdc96);` (drop the `multiplyScalar` entirely — with
  the ceiling in place it only crushes the ratio between channels). Same treatment at
  `VFX.js:436`, which still spawns a `0xffffff` shockwave ring.

---

### R3-6 — The blast light erases the enemies inside it [AREA B] — axes 4, 8, 1, 5

`src/systems/VFX.js:477` — `this.lights.flick(pos, colour, 60 * s, r * 2.5, 0.32);`
with `s = r / 4 = 1.5` → intensity **90** at range 15 m.

**Pixels.** The golem standing in the blast at 08 `(870,400)–(1020,500)` is rendered as
a **uniform white plaster cast**: `(900,450) = 243,236,227`, `(920,460) = 242,236,226`,
`(940,470) = 241,236,227`. Its species colour, its rim light, its facet shading and its
internal contrast are all gone — variance across the whole body is under 3/255. In RoR2
the flash *silhouettes* the monsters inside it; here it deletes them. This is the
single largest axis-4 and axis-8 cost in `08`.

**Fix.** Cap the light's contribution to lit surfaces rather than raising its intensity
to reach far ones. `VFX.js:477` → `this.lights.flick(pos, colour, 14 * s, r * 3.4, 0.32)`
— roughly 4x lower intensity over a 36% larger radius delivers a similar falloff at
8–10 m without saturating anything inside 4 m. Then verify against this exact frame:
the golem's body should keep at least 40/255 of internal contrast between its lit and
shaded facets.

---

### R3-7 — `04-combat` contains no impact feedback of any kind [AREA F] — axes 6, 8

`src/core/Harness.js:416-426` (`combat`) and `:448-536` (`boss`).

**Pixels.** The frame documented as "Mid-fight with a horde, firing. Judges VFX
layering, enemy legibility, HUD under load" contains **no damage number, no muzzle
flash, no impact spark, no hit flash and no blood**. Proven for the damage numbers by
scanning the full frame for the glyph keyline (`R,G,B < 22`, channel spread < 6):
51 hits, **all 51 inside the crosshair** at `(774–820, 424–470)`. The gun muzzle at
`(680,415)` is bare (crop `(640,390,90,90)` at 10x). Same result in `05-boss`. The
trigger is held (`Harness.js:422`) and tracers exist, so rounds are leaving the
weapon — **they are not hitting anything.** `spawnRing` fans the horde across
camera-forward ±70° and nothing aims the camera at a body; 24 enemies at 13 m and not
one round connects in 60 frames.

This is why the orchestrator's report saw no numbers in 08 either: the two that exist
in 08 come from the *scripted* `combat.explode` at `Harness.js:664`, not from gunfire.
**The 45 m cull and the pixel floor are both innocent.**

**Fix.** Aim the weapon at a body before the shutter. In `combat`, after
`declutter(12)`:
```js
// Point the rig at the nearest live enemy so the frame contains hit feedback, which
// is the entire subject of this shot. Without it, "mid-fight, firing" photographs
// tracers leaving a gun and nothing arriving.
const target = (ctx.director?.enemies ?? [])
  .filter((e) => e.alive)
  .sort((a, b) => a.position.distanceToSquared(camera.position)
                - b.position.distanceToSquared(camera.position))[0];
if (target && ctx.cameraRig) {
  ctx.cameraRig.yaw = Math.atan2(target.position.x - p.x, target.position.z - p.z);
  ctx.cameraRig.pitch = -Math.asin((target.position.y + 1.0 - (p.y + 1.6))
    / Math.max(1, target.position.distanceTo(p)));
}
await frames(20);       // long enough for 2-3 shots to land and their numbers to arc
freeze();
```
Apply the same to `boss` so the Titan is actually being shot when its portrait is
taken.

---

### R3-8 — Enemy attack beams are unclamped hairline wires across the frame [AREA A] — axes 6, 8, 2

`src/entities/EnemyMeshes.js:233` (`along = mix(1.0, 0.32, vBeamUv.y)`) and `:1315-1316`
(golem beam width), driven by `src/entities/Enemy.js:929`
(`beamLen = Math.min(a.range, Math.max(4, e.distToPlayer))`).

**Pixels.** `04-combat` carries a 2-px cyan line from `(125,0)` to `(460,310)` —
**455 px of dead-straight, near-uniform hairline that exits the top of the frame**.
Brightness along it: `(90,151,144)` at y=0, `(59,117,143)` at y=20, `(83,170,156)` at
y=180, `(115,194,173)` at y=300 — a 25% swing over 455 px, which is not a taper, it is
noise. Two more cross 04 (y=260 x=927; y=420 x=901 and x=1559) and two cross 05
(y=420 x=1143 and x=1503). This is round 2's V6 complaint verbatim, on a system the V6
fix never touched — `VFX.js`'s tracers were clamped to 8 m, the enemies' own beams were
not.

**Why.** The beam is drawn muzzle-to-player at full length with no distance clamp, and
`BEAM_FRAG:233` only decays to 32% at the far tip. `BEAM_MAX_HALF_ANGLE` (`:193`) caps
the on-screen half-width at tan(6°)·dist, but `setBeam` (`:1316`) passes 0.26 m base
diameter, so at 25–40 m the quad is 2 px wide and the width clamp never engages —
the result is a constant-width wire with no visual mass anywhere along it.

**Fix.** Give the beam a floor in *screen* space and a real head bias, matching what
was already done for tracers:
```glsl
// BEAM_VERT:216-217 — a beam thinner than ~3 px is a wire, not a threat.
halfW = clamp(halfW, uMinAngle * dist, uMaxAngle * dist);   // uMinAngle = tan(0.25°)
```
```glsl
// BEAM_FRAG:233 — hot at the muzzle, gone by the tip, so the line has a direction.
float along = pow(1.0 - vBeamUv.y, 1.6);
```
and clamp the drawn length at `Enemy.js:929` to `Math.min(a.range, e.distToPlayer, 14)`
so a golem 35 m away draws a 14 m bolt from its own muzzle rather than a wire spanning
the composition.

---

### R3-9 — Damage numbers are near-white text on a blown-white blast [AREA B] — axes 6, 8

`src/systems/VFX.js:1706` (`vec3 col = mix(vec3(0.02), vColor.rgb, t.r);`) and
`:1690` (`vColor.a *= smoothstep(0.0, 0.06, k) * ...`).

**Pixels.** The two readouts that *do* exist in 08 measure `105` at `(755,340,70,30)`
and a second at `(780,400,60,30)`. Their ink reads **`250,240,225` against a
`255,255,241` background — a delta of 5–16 out of 255.** Both are invisible at 1:1;
the 12x crops above are the only way to prove they are there. In the same frame the
crosshair, which is white with a hard black keyline, is perfectly legible 40 px away —
that is the control that shows the problem is contrast, not size.

**Why.** The glyph body is `0xfff2d8` (near-white) and the keyline is `vec3(0.02)` at
the glyph's own alpha, so on a near-white background the keyline dissolves along with
the body. Compounding it, the shutter fires 0.026 s after the damage event, so
`smoothstep(0.0, 0.06, 0.026) ≈ 0.40` — the numbers are at 40% opacity at the moment
they are photographed.

**Fix.** Make the keyline opaque and independent of the fill's alpha, which is how RoR2
readouts survive any background:
```glsl
// NumberFrag — outline at full alpha, body tinted inside it.
float body = t.r;
float outline = clamp(t.a - t.r, 0.0, 1.0);
vec3 col = mix(vec3(0.02, 0.02, 0.03), vColor.rgb, body);
float a = max(outline, body * vColor.a) * step(0.01, t.a) * vColor.a;
```
plus widen the stroke at `VFX.js:1871` from `lineWidth = 16` to `22`, and shorten the
fade-in at `:1690` from `smoothstep(0.0, 0.06, k)` to `smoothstep(0.0, 0.02, k)` so a
readout is at full opacity within one frame of the hit.

---

### R3-10 — Chromatic aberration reaches 6–7 px at the frame edge [AREA B] — axes 9, 3, 10

`src/core/RenderPipeline.js:392` (`clamp(..., 0, 0.004)`) and `:400`
(`0.0016 + min(this.aberration + this.shake * 0.004, 0.004)`), consumed at
`src/shaders/GradeShader.js:70-76`.

**Pixels.** Crop `08-explosion` at `(60,230,200,90)` and 6x: the multishop terminal at
`(110,250)–(160,285)` is split into a **full RGB rainbow** — a cyan band on its left
edge, a red/orange band on its right, separated by **~7 source pixels**. The dead tree
at `(200,235)–(250,300)` is fringed the same way. The entire left third and right
edge of the frame are affected.

**Why — arithmetic that matches the measurement.** With `shake = 0.5`
(`Harness.js:665`) and the explosion's own `+0.006` (`VFX.js:480`), `uAberration`
saturates at `0.0016 + 0.004 = 0.0056`. At the terminal, `c = (−0.419, −0.206)`,
`r² = 0.218`, so `off = c · 0.0056 · (0.35 + 0.218·2.2) = 3.1 px` in x — and R shifts
`+off` while B shifts `−off`, giving **6.2 px of R-to-B separation**. Measured ~7.
A subtle aberration is under 1 px.

**Fix.** `RenderPipeline.js:392` → `clamp(..., 0, 0.0012)` and `:400` →
`0.0005 + Math.min(this.aberration + this.shake * 0.0012, 0.0012)`. That caps total
separation at ~1.8 px in the corners and under 0.5 px at the centre, which is the
range where aberration reads as a lens and not as a broken pass. Independently, drop
`VFX.js:480` from `0.004 * s` to `0.0012 * s` so a single blast cannot alone reach the
cap.

---

### R3-11 — The blast is one hard-edged star sprite, not a layered effect [AREA B] — axes 6, 9, 10

`src/fx/ParticleSystem.js:520-545` (`flareStar`) driven by `src/systems/VFX.js:414-420`
(`size0 = r * 2.4` on `FRAME.FLARE`).

**Pixels.** Crop `08-explosion` at `(600,130,300,200)` and 4x: four straight-sided
wedges radiate from the blast centre with **geometrically hard edges** and a flat
translucent fill, washing the floating rock island at `(600,130)–(850,320)` to a
uniform pale pink. It is a 700-px-wide lens-flare sticker laid over the render — the
rubric's literal 4 on axis 6 ("flat billboard puffs… single-layer effects") and its
literal 3 on axis 9 ("over-processed mush").

**Why.** `flareStar` draws each spoke as a filled triangle (`:536-541`) with a linear
gradient along its axis only — there is no falloff *across* the spoke, so the two long
edges are alpha discontinuities. At `size0 = r * 2.4` with `r = 6` that is a 14.4 m
billboard, and at 21 m from the lens it is ~700 px across.

**Fix.**
- `ParticleSystem.js:536-541`: replace the linear gradient with a radial one anchored
  at the spoke's base and inset the triangle, then re-draw each spoke once at
  `globalAlpha 0.45` with `g.filter = 'blur(5px)'` so the spoke has a soft shoulder
  instead of a knife edge.
- `VFX.js:417`: `size0 = r * 2.4` → `r * 1.15`. A flare wider than the fireball it
  belongs to reads as a lens artefact, never as heat.
- `VFX.js:411, 419`: both layers set `e.soft = 0`, so the depth fade in
  `ParticleShader.js:176-186` never engages and the flare cuts a hard line through the
  terrain crest at `(620,370)–(1010,395)`. Set `e.soft = 1.5` on the flare and
  `e.soft = 0.8` on the core.

---

### R3-12 — A flat translucent disc sits on the player's head in `04-combat` [AREA F] — axes 4, 2, 8

`src/core/Harness.js:416` (`combat` framing) — owner of the object not identified from
the render tree.

**Pixels.** Crop `(715,350,90,70)` at 12x: a **72-px flat grey-blue disc with a hard
circular edge**, containing a pale spire and four small cubes, sits directly over the
player's helm at `(720,355)–(795,420)`. The helm antenna crosses in front of it, so it
is behind the player and in front of the far ridge. It is the second-highest-contrast
object in the centre of frame and it breaks the only well-formed silhouette in the
shot. It appears in neither `05-boss` nor `08-explosion` at the equivalent position.

I could not attribute it: no `Sprite`, `SpriteMaterial` or billboarded translucent
`CircleGeometry` in `src/` matches its colour or size (`Interactables.js:589` is the
portal, `0x9b5cff` purple; `Environment.js:371-380` is the 0.42 m dust point sprite).
**It needs an owner before it can be fixed** — that is itself a finding: something is
in the scene graph that the codebase does not obviously account for.

**Fix.** First identify it (`ctx.scene.traverse` filtered to objects whose world
position projects inside `(715,350,90,70)` in this exact scenario). Then, whatever it
is: if it is diegetic, `Harness.js:416` must reject a camera yaw that puts it inside
`[0.40,0.60] × [0.35,0.55]` of the viewport; if it is a UI affordance leaking into the
world pass, it should not be drawn behind the player at all.

---

### R3-13 — Enemy bodies take no shading; every facet is one value [AREA A] — axes 1, 5, 4

`src/entities/EnemyMeshes.js:136-143` (`RimStandardMaterial`, `flatShading: true`,
`roughness: 0.82`, `metalness: 0.04`).

**Pixels.** Two differently-oriented facets of the same golem torso in `05-boss`:
`(1030,420) = 57,110,145` and `(1060,430) = 63,106,149` — **delta ≤ 6/255 across a
~40° normal change.** Crop `(990,380,160,150)` at 8x shows the whole torso as a single
unmodulated fill with the leg group as a second single fill. The distant enemy at 04
`(430,290)–(560,380)` is literally a flat blue rectangle. `flatShading` is on, so the
geometry *can* differentiate — the lighting is not delivering enough directional
contrast to the monsters for it to matter, which is what keeps axis 5 at 4 and axis 4
from clearing 5.

**Fix.** The rim term landed but it is a 1–2 px edge at combat range and cannot carry
form on its own. Add cheap normal-driven value separation in `RimStandardMaterial`:
a hemispherical term `mix(shadeColor, bodyColor, N.y * 0.5 + 0.5)` at strength ~0.25
so up-facing plates read lighter than side plates regardless of key direction, and
raise `roughness` variance between `body` (0.82) and `dark` (0.9) into a visible split
by dropping `dark` to 0.55 with `metalness: 0.25` — a golem's plates and its joints
should not have the same specular response.

---

### R3-14 — `declutter` fuses an enemy with the player's silhouette [AREA F] — axes 4, 8

`src/core/Harness.js:345-360` (`declutter(minDist)`), called at `:424`.

**Pixels.** Crop `04-combat` at `(640,390,90,90)` and 10x: a red pest — saturated
crimson cap with a spiked crown and a single orange eye dot — sits at
`(645,435)–(700,465)`, **touching and partly behind the player's left shoulder**.
At 1:1 it reads as an orange growth on the survivor's arm, not as a monster. A second
enemy overlaps the player's helm from behind at `(700,405)`.

**Why.** `declutter` pushes every enemy inside 12 m out to exactly 12 m *along its own
bearing from the camera* (`:353-354`), which preserves screen position exactly. An
enemy that was overlapping the player at 6 m is still overlapping the player at 12 m —
the pass moves things in depth but never in the frame, so it cannot declutter anything.

**Fix.** Reject on *screen* separation, not world distance. `Harness.js:345` already
has `screenOf` available (`:236-242`):
```js
// Push off the bearing as well as the distance: an enemy at the player's screen
// position is still there after a purely radial push, which is the case this
// function exists to prevent.
const ps = screenOf(playerPos().x, playerPos().y + 1.0, playerPos().z);
const es = screenOf(x, y + 1.0, z);
if (Math.hypot(es.x - ps.x, es.y - ps.y) < 0.09) {
  const az = Math.atan2(dx, dz) + (e.id % 2 ? 0.22 : -0.22);
  x = cam.x + Math.sin(az) * minDist; z = cam.z + Math.cos(az) * minDist;
}
```

---

## 4. Defect index

| ID | Area | Axes | One line |
|---|---|---|---|
| R3-1 | **F** | 6, 8, 4, 5 | Shutter fires 0.026 s in — white core only, no fireball/ring/smoke (`Harness.js:630`) |
| R3-2 | **A** | 1, 4, 8, 2 | Contact shadow is 2.4x brighter than the ground; 286×7 px bright bar in 05 (`EnemyMeshes.js:301`, `CharacterMesh.js:153`) |
| R3-3 | **A** | 4, 5, 8, 10 | Titan is a legless mauve slab seen side-on; 1.25 m of each leg buried (`EnemyMeshes.js:1195/1270-1276`, `Harness.js:516-519`) |
| R3-4 | **F** | 2, 4, 8 | Boss reads 1.33x the player instead of 4.2x — depth ratio kills the scale shot (`Harness.js:479/492`) |
| R3-5 | **B** | 6, 3, 9 | Explosion core still `255,255,241`; `maxIntensity 1.6` is above the clip point (`VFX.js:410`, `ParticleShader.js:196`) |
| R3-6 | **B** | 4, 8, 1, 5 | Blast point light (intensity 90) erases the golem inside it to `242,236,226` (`VFX.js:477`) |
| R3-7 | **F** | 6, 8 | 04 and 05 contain zero hit feedback — no shot connects (`Harness.js:416-426/448-536`) |
| R3-8 | **A** | 6, 8, 2 | Enemy attack beams are unclamped 2-px wires exiting the frame (`EnemyMeshes.js:233/1315`, `Enemy.js:929`) |
| R3-9 | **B** | 6, 8 | Damage numbers are near-white on blown white — 5–16/255 contrast (`VFX.js:1706/1690`) |
| R3-10 | **B** | 9, 3, 10 | 6–7 px RGB separation at the frame edge in 08 (`RenderPipeline.js:392/400`) |
| R3-11 | **B** | 6, 9, 10 | 700-px hard-edged star sprite is the whole explosion (`ParticleSystem.js:520-545`, `VFX.js:414-420`) |
| R3-12 | **F** | 4, 2, 8 | Unidentified 72-px translucent disc on the player's head in 04 (`Harness.js:416`; owner unknown) |
| R3-13 | **A** | 1, 5, 4 | Enemy facets differ by ≤ 6/255 — monsters take no shading (`EnemyMeshes.js:136-143`) |
| R3-14 | **F** | 4, 8 | `declutter` pushes radially, so an enemy stays fused with the player (`Harness.js:345-360`) |

**By area — AREA A: 4 (R3-2, R3-3, R3-8, R3-13) · AREA B: 5 (R3-5, R3-6, R3-9, R3-10,
R3-11) · AREA F: 5 (R3-1, R3-4, R3-7, R3-12, R3-14).**

Fix order for round 4: **R3-1, R3-2, R3-7** first — those three are why the frames
still cannot be judged on their stated purpose (no explosion, a shadow that glows, no
hit feedback). Then **R3-3 + R3-4** together, since they are the same "the boss shot
does not show the boss" problem from the mesh side and the lens side. Then
**R3-5, R3-6, R3-10** as the 08 exposure block.

---

## 5. Which axes clear 7, plainly

**Clears 7 in every frame — 1 axis:**
- **Axis 7 (UI/HUD craft): 7 / 7 / 7.** Angular segmented health bar, difficulty
  meter, objective ribbon, boss bar, ability tray with keybinds, item grid. Dense,
  hierarchical, consistently styled, and it stays legible over a blown-out background
  in 08. This is the only part of the build at target.

**Does not clear 7 in any frame — 9 axes:**

| Axis | Best score | Why it falls short |
|---|---|---|
| 1 Lighting & shadow | 5 | The key direction is committed and the terrain reads, but the monsters take no shading (R3-13, ≤6/255 across facets) and the one contact cue in the build brightens the ground (R3-2). No AO anywhere. |
| 2 Composition & depth | 5 | Fog and value separation on the far mountains are genuinely good. Killed by foreground clutter: 3–5 hairline beams cutting the frame (R3-8), a disc on the player's head (R3-12), an enemy fused to his shoulder (R3-14), and a 286-px bright bar across 05 (R3-2). |
| 3 Colour & grade | 6 | Palette and warm/cool split are right and species hues now survive. Held at 6 by red-channel clipping on saturated enemies (`255,105,147`, `255,115,60`) and by the hueless blast (R3-5). |
| **4 Silhouette & form** | 4 | The Titan — the one shot that exists for this axis — is a legless slab at 25% frame height seen from the side (R3-3, R3-4). Enemies are flat rectangles. Only the player character clears 7 on its own. |
| 5 Material believability | 4 | Every surface in the game is one matte fill. No roughness contrast between rock, metal and organic anywhere in three frames. The terrain's specular rake is the sole material read. |
| **6 VFX quality** | 4 | Tracers landed and are the one good effect. The peak-VFX frame is a single hard-edged star sprite (R3-11) with the core clipped white (R3-5) and no fireball, ring, smoke or debris (R3-1). 04 contains no impact feedback at all (R3-7). |
| **8 Readability under load** | 5 | Real progress — species colour + blob shadows make the horde countable in 04, which is why this axis moved 3→5. Blocked from 6–7 by: no hit feedback (R3-7), an enemy erased to white by its own explosion (R3-6), invisible damage numbers (R3-9), and beams that cut the frame into wedges (R3-8). |
| 9 Post-processing | 6 | 04 and 05 are close (bloom restrained, AA acceptable). 08 collapses to 3 on 6–7 px of chromatic aberration (R3-10) plus 1.09% clipped white. |
| 10 Cohesion | 6 | Flat saturated toy-coloured monsters against naturalistic faceted rock, with a lens-flare sticker on top, still read as three asset sets. |

**Two axes that were the worst in round 2 have moved but not cleared: axis 8 (3/2/2 →
5/4/3) and axis 4 (3/2/2 → 4/3/4). Axis 6 barely moved (4/4/2 → 4/4/3) and remains the
domain's weakest result.**

---

## Appendix — commands run

Read-only throughout. **No project file was modified. `tools/capture.mjs` was NOT run.**

- `Read` on `RUBRIC.md`, `CONTRACTS.md`, `reviews/round2-combat.md`,
  `shots/manifest.json`, and the three PNGs.
- `Read` / `Grep` on `src/systems/VFX.js`, `src/shaders/ParticleShader.js`,
  `src/shaders/GradeShader.js`, `src/fx/ParticleSystem.js`, `src/fx/Trails.js`,
  `src/entities/EnemyMeshes.js`, `src/entities/CharacterMesh.js`,
  `src/entities/Enemy.js`, `src/entities/Projectile.js`, `src/data/enemies.js`,
  `src/data/abilities.js`, `src/data/items.js`, `src/core/Harness.js`,
  `src/core/RenderPipeline.js`, `src/world/Interactables.js`,
  `src/world/Environment.js`, `src/world/Props.js`.
- PowerShell + `System.Drawing` nearest-neighbour crops at 2.6–12x into the session
  scratchpad: Titan (whole / top / feet), the 05 grey bar, the beetle, the golem in 05
  and in 04, the blast core, both 08 damage numbers, the 08 white golem, the 08 flare
  spokes, the 08 left-edge aberration, the player + head disc in 04, the muzzle, the
  orange pest.
- PowerShell + `GetPixel` point sampling at 60+ named coordinates; horizontal row scans
  at y = 382–398 (05) and y = 612/635/660 (04); a vertical profile at x = 740, y = 370–405
  (05); a row-difference band search (y=387 vs y=378) bounding the grey bar to x 638–924.
- Full-frame luma histograms, 3-px stride, 160,200 samples per shot, for the sub-luma-24
  and clipped-white coverage figures.
- Full-frame hue-filtered silhouette extraction over `(700–920, 110–440)` in 05 to
  measure the Titan's on-screen extent.
- Full-frame scans of all three shots for the damage-number keyline signature
  (`R,G,B < 22`, channel spread < 6) — the proof that 04 and 05 contain none.
- Thin-cyan run detection at y = 130/260/420/560 in 04 and 05 to count the beam wires.
