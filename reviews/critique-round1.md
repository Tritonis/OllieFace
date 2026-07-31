# PETRICHOR — Art Critique, Round 1

Reference target: Risk of Rain 2 (Titanic Plains / Abandoned Aqueduct / Rallypoint Delta).
Rubric: `RUBRIC.md`. Capture: `shots/manifest.json`, seed 1337, 1600x900.

---

## 0. READ THIS FIRST — five of the eight shots are the same frame

Before any art judgement: **shots 04, 05, 06, 07 and 08 are the same rendered 3D frame.**
The HUD DOM overlay differs between them; the WebGL canvas underneath does not.

```
$ Get-FileHash shots/*.png -Algorithm SHA256
01-title.png          549402   E2BBD3D46CBA1201
02-vista.png         2341707   9204B61E91628242
03-thirdperson.png   2583064   065992FA98441962
04-combat.png        2425720   0CB3E8DDDB054E7A
05-boss.png          2417484   9230E5ADE6A2F8D3
06-loaded-hud.png    2422470   31C4C6C1C35B5D12   <-- identical
07-interactables.png 2422470   31C4C6C1C35B5D12   <-- identical
08-explosion.png     2422470   31C4C6C1C35B5D12   <-- identical
```

06/07/08 are **byte-for-byte identical files**. 04 and 05 differ from them only by HUD elements.
Corroborating evidence inside the pixels: the run timer reads `00:05` in all five, the difficulty
reads `EASY x1.0` in all five, gold reads `$0` in all five — even in 06, where the harness called
`ctx.items.addGold(4200)` and `ctx.time = 22*60` (`src/core/Harness.js:97-101`).

Consequence for this review:

- **05-boss contains no boss.** There is a boss health bar and there is no boss in the image. The
  shot cannot be scored for "scale, boss silhouette".
- **07-interactables contains no interactable.** The camera never moved to the chest/shrine.
  Prop modelling and pickup VFX are **unjudged**, not passed.
- **08-explosion contains no explosion, no damage numbers and no shake.** Impact feedback is
  **unjudged**, not passed.

Three of the ten rubric axes therefore have no evidence behind them for half the shot list. Any
"pass" on those axes in a later round must come from a re-capture, not from this set.

The cause is traced and confirmed in Defect **A1** below.

---

## 1. Verdict and per-shot axis scores

### Overall

```
VERDICT: FAIL
```

Not a marginal fail. The single most important shot in the set — 04-combat, the one that has to
prove this is a Risk of Rain 2-alike — scores **1/10 on readability under load** and **1/10 on VFX
quality**, and the frame is dominated by two malformed screen-spanning polygons. Five of eight shots
are duplicates of a broken frame. The rubric's pass bar is 7+ on every axis with none below 6;
**no shot in this set clears 7 on a single axis except HUD legibility on the title screen.**

### Per-shot

Axes: 1 Lighting · 2 Composition · 3 Colour · 4 Silhouette · 5 Material · 6 VFX · 7 UI · 8 Readability · 9 Post · 10 Cohesion

| Shot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | Mean |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01-title | 2 | 3 | 3 | 2 | 2 | 2 | 6 | 7 | 3 | 5 | 3.5 |
| 02-vista | 4 | 4 | 3 | 4 | 3 | 4 | 6 | 6 | 5 | 6 | 4.5 |
| 03-thirdperson | 5 | 5 | 4 | 2 | 3 | 4 | 6 | 5 | 4 | 6 | 4.4 |
| 04-combat | 3 | 2 | 3 | 2 | 2 | 1 | 5 | 1 | 2 | 3 | 2.4 |
| 05-boss † | 3 | 2 | 3 | 1 | 2 | 1 | 4 | 1 | 2 | 3 | 2.2 |
| 06-loaded-hud † | 3 | 2 | 3 | 2 | 2 | 1 | 3 | 1 | 2 | 3 | 2.2 |
| 07-interactables † | — | — | — | — | — | — | — | — | — | — | n/a |
| 08-explosion † | — | — | — | — | — | — | — | — | — | — | n/a |

† duplicate frames. 05 and 06 are scored only for the HUD layer that is genuinely new; their 3D
scores are inherited from 04 and are not independent evidence. 07 and 08 are **unscoreable** — the
content they were supposed to show is not present.

Worst axes across the set, in order: **8 Readability under load (1)**, **6 VFX quality (1)**,
**4 Silhouette (2)**, **9 Post-processing (2)**, **3 Colour & grade (3)**, **5 Material (3)**.

---

## 2. Ranked defect list, grouped by owning subsystem

Severity counts: **5 BLOCKER · 9 MAJOR · 7 MINOR**

---

### GROUP A — Engine / crash robustness *(owner: `src/core/Engine.js`, `src/systems/VFX.js`, `src/entities/Player.js`)*

#### A1 · BLOCKER · The render loop dies mid-capture; every shot after 04 is a frozen canvas
**Shots:** 04 (where it dies), 05, 06, 07, 08 (all frozen).

**What is visibly wrong:** the timer is stuck at `00:05` across five shots. Gold stays `$0` after
`addGold(4200)`. Difficulty stays `EASY x1.0` after `ctx.time = 22*60`. The camera never moves for
07 despite the harness repositioning it. No explosion appears in 08. The canvas is a photograph of
the last frame that rendered before the throw; only the DOM HUD keeps updating, which is exactly why
the boss bar and the inventory grid *do* appear over a stale 3D image.

**Confirmed chain** (`manifest.json` captured the throw verbatim under 04-combat):

1. `src/entities/Player.js:140` — `this.mesh = new CharacterMesh()`. `CharacterMesh`
   (`src/entities/CharacterMesh.js:84`) is a plain wrapper class, **not** an `Object3D`; its
   actual scene node is `this.group` (`CharacterMesh.js:102`).
2. `src/systems/VFX.js:1257` — `resolveObject()` tests `entity.mesh` **first** and returns it
   without checking `isObject3D`:
   ```js
   return entity.mesh || entity.object3d || entity.object || entity.root || entity.group || null;
   ```
   For the player this returns the wrapper.
3. `src/systems/VFX.js:469` — `_box.setFromObject(mesh)` →
   `TypeError: object.updateWorldMatrix is not a function`.
4. `src/core/Engine.js:76-82` — the throw propagates out of `_frame()`, and the RAF is re-armed
   **after** `_frame()` with no `try`/`catch`:
   ```js
   const tick = () => {
     if (!this.running) return;
     this._frame();               // throws here
     requestAnimationFrame(tick); // never reached again
   };
   ```
   The loop is dead permanently, for the rest of the page's life.

Trigger path: `Enemy.fireBeam` (`Enemy.js:634`) → `hurtPlayer` (`Enemy.js:42`) →
`Combat.applyDamage` (`Combat.js:421`) → `Combat._kill` (`Combat.js:433`) → `events.emit('kill')` →
`VFX._onKill` (`VFX.js:939`) → `VFX.deathDissolve`. i.e. **the first time the player dies, the game
stops rendering.**

**Fix (three separate changes, all required):**
- `src/systems/VFX.js:1257` — reorder and type-check:
  `if (entity.mesh?.isObject3D) return entity.mesh;` then fall through to
  `entity.group ?? entity.root ?? entity.object3d ?? entity.object ?? null`, and return `null`
  for anything that is not `isObject3D`.
- `src/systems/VFX.js:468` — harden the entry point: `if (!mesh?.isObject3D) return;`
- `src/core/Engine.js:76-82` — wrap the body so one bad frame cannot kill the game:
  ```js
  const tick = () => {
    if (!this.running) return;
    requestAnimationFrame(tick);          // re-arm FIRST
    try { this._frame(); }
    catch (e) { console.error('frame error', e); }
  };
  ```
  Re-arming before the work is what makes this robust; the try/catch is what makes it debuggable.

#### A2 · BLOCKER · The capture harness cannot detect that it is photographing a dead frame
**Shots:** all of 05-08.

**What is visibly wrong:** the harness happily wrote five PNGs of the same stale canvas and recorded
`"ready": true` with no complaint. `settle(page, N)` (`tools/capture.mjs:103-113`) waits on
`requestAnimationFrame` callbacks — but those still fire when the *game's* loop is dead, because
they are the harness's own RAF, not the engine's. The wall-clock cap at
`tools/capture.mjs:108` then silently releases.

**Fix:** in `tools/capture.mjs`, make `settle()` wait on the engine's own frame counter, not on RAF:
poll `globalThis.__GAME__.engine.frame` and require it to advance by `n` before resolving; throw if
it stalls. Additionally, before each `page.screenshot`, assert `__GAME__.engine.running === true`
and that `errors.length` has not grown since the previous shot — and record a hard
`"stale": true` flag on the manifest entry when the frame counter did not move. A harness whose
stated purpose is "so a black screenshot is never mistaken for an art problem"
(`tools/capture.mjs:6-7`) must also catch a *frozen* screenshot.

#### A3 · MAJOR · Enemy beam trails are wired to the wrong function signature and render nothing
**Shots:** 04, 05 (the enemy beam attack has no trail).

`src/systems/Director.js:392-393` calls `this.trails.spawn(origin, dir, length, color)` — four
positional arguments. `Trails.spawn` (`src/fx/Trails.js:183`) takes **a single options object**:
```js
spawn(o = {}) { ... t.reset(o); if (o.position) t.push(...); }
```
`o` is therefore a `Vector3`. `o.width`, `o.color`, `o.life`, `o.position` are all `undefined`, so
the trail is reset to white, zero points are pushed, and on the next `update()` the `t.count < 2`
branch (`Trails.js:235-239`) immediately deactivates it. Every enemy beam attack silently burns a
pool slot and draws nothing. No crash, no warning — which is why it survived to a screenshot.

**Fix:** change `Director.js:393` to
`this.trails.spawn({ position: origin, life: 0.18, width: 0.35, color, coreColor: 0xffffff, core: 2.0 })`
and feed the tip along the ray with `trails.move()` over the beam's active window — or delete the
call and let `EnemyMeshes`' beam cylinder be the only visual. Add a runtime guard in `Trails.spawn`:
`if (o.isVector3 || arguments.length > 1) throw new Error('Trails.spawn takes an options object')`.

---

### GROUP B — VFX: beams, tracers, explosions *(owner: `src/entities/EnemyMeshes.js`, `src/systems/VFX.js`, `src/fx/*`)*

#### B1 · BLOCKER · The screen-spanning cyan wedges are the golem laser mesh, ~7x oversized
**Shots:** 04, 05, 06, 07, 08 (visible in every frozen copy).

**What is visibly wrong:** two enormous flat cyan wedges cut diagonally across the entire frame,
widest at the screen edges and converging to points near the enemies. They have hard straight edges,
a flat untextured interior, no falloff along their length, no soft depth fade against the terrain
they intersect, and they occlude the player entirely.

**This is confirmed, not inferred.** The colour `#22d3ff` in the pixels is exactly the golem laser's
declared colour at `src/data/enemies.js:150`:
```js
{ id: 'laser', kind: 'beam', range: 42, ..., beamRadius: 0.9, color: 0x22d3ff }
```

The geometry:
- `src/entities/EnemyMeshes.js:223-232` — `beam()` builds `cyl(0.05, 0.05, 1, 6)`, a **6-sided**
  cylinder of radius 0.05, rotated to point +Z.
- `src/entities/EnemyMeshes.js:234-239` — `setBeam(m, length, width, on)`:
  ```js
  m.scale.set(width, length, width);
  m.position.z = length * 0.5;
  ```
- `src/entities/EnemyMeshes.js:844` — the golem call site:
  ```js
  setBeam(p.beam, a.beamLen, w * 0.55 + fire * 6.5 + 0.12, a.beamOn);
  ```

At the moment of firing, `w`→1 and `fire`→1, so `width` = **7.17**. Diameter becomes
0.1 × 7.17 ≈ **0.72 world units**, and `length` = `a.beamLen`, which the FSM drives to
`min(range, max(4, distToPlayer))` (`Enemy.js:785`) — up to **42 units**.

The beam is aimed at the player. The camera sits 5.4 units behind the player
(`src/core/CameraRig.js:30`, `DIST = 5.4`). A 0.72-unit-diameter tube extending 42 units *toward the
camera* passes within roughly a unit of the near plane. At hFOV ≈102° that near end subtends
`0.72 / ~1.0 ≈ 0.72 rad ≈ 41°` — about **640 px of a 1600 px frame** — tapering to a point 42 units
away. That is precisely the wedge in the image, and two firing golems produce exactly two wedges.

Three compounding faults, all fixable:
1. **Magnitude.** `fire * 6.5` is a magic number ~7x too large and unrelated to the gameplay
   hitbox, which is `beamRadius: 0.9` (diameter 1.8). The visual does not even match the hitbox.
2. **No near-camera handling.** Nothing shrinks or fades the beam as it approaches the near plane,
   so an attack aimed at the player is guaranteed to become a screen-filling polygon.
3. **Flat hexagonal solid.** `cyl(r, r, 1, 6)` gives a 6-sided prism — hence the straight hard
   edges — with a flat additive material, no radial edge falloff, no soft-particle depth fade and
   no gradient along the length. It reads as a coloured sheet of plastic, not as energy.

**Fix:**
- `src/entities/EnemyMeshes.js:844` — drive the width from the attack data, not a constant:
  `setBeam(p.beam, a.beamLen, (a.beamRadius ?? 0.5) * (0.25 + fire * 0.75), a.beamOn)`, and pass
  `beamRadius` through on the `anim` struct. Do the same at `EnemyMeshes.js:1051` for the titan
  barrage (`beamRadius: 1.5`, `enemies.js:183`).
- `src/entities/EnemyMeshes.js:234-239` — in `setBeam`, compute the mesh's world distance to the
  camera and taper the near end: clamp the on-screen half-angle to ~6° by scaling width down when
  `dist < 6`, and drop `m.visible` when `dist < 1.2`. Also clamp `width` to a hard ceiling.
- `src/entities/EnemyMeshes.js:224` — raise the cylinder to 12+ segments so the silhouette stops
  reading as a hexagon.
- The beam material (`beamMat`) needs a radial `pow(1 - abs(ndc), k)` edge falloff, a
  head-to-tail intensity gradient, and a depth-buffer soft fade so it does not slice through
  terrain with a hard line.

#### B2 · BLOCKER · Bloom resolves emissives to featureless white polygons with visible hard edges
**Shots:** 04, 05, 06, 07, 08.

**What is visibly wrong:** five or six blobs of pure clipped white. The largest, at frame centre
(~x 900-1030, y 370-470), is not a soft glow — it has **visible straight polygon edges**, because
the underlying emissive quad has saturated to 1.0 across its whole area and the bloom halo around it
has also clipped. There is no core-to-halo gradient, no colour left in the falloff, and the blobs
carry zero information about what created them. Under this, the player is gone.

`src/core/RenderPipeline.js:83`:
```js
const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.62, 0.72, 0.82);
//                                                          strength^  radius^  threshold^
```
The pass runs on **linear HDR** (the composer target is `HalfFloatType`,
`RenderPipeline.js:54-58`), so a threshold of `0.82` is not "only very bright things" — it is
roughly sRGB 0.93, and every emissive in the scene sits far above it. `crystal` is
`emissiveIntensity: 1.9` (`src/world/Materials.js:270`); muzzle flashes, impact sparks, the beam
material and the sky's `disc * 22.0` (`src/shaders/SkyShader.js:72`) are all one to two orders of
magnitude over it. A radius of 0.72 then smears each one across a large screen area at strength
0.62, and the result clips before it ever reaches the tonemapper.

**Fix:**
- Raise the threshold into genuine HDR territory (`~2.5-4.0`) so bloom selects *emissives* and
  not merely "bright", drop strength to ~0.35, and drop radius to ~0.4. Bloom should widen a
  highlight, not replace it.
- Clamp the bloom **input**: insert a `min(color, vec3(K))` (K ≈ 12) before the bright-pass so a
  single enormous emissive cannot carry the whole screen. This is the standard fix and it is what
  keeps RoR2's own beams readable when six of them overlap.
- Cap `emissiveIntensity` on the pooled VFX materials; a flash that needs to read as "bright"
  should be sold with a light + a ring + particles, not by pushing one quad to 60.
- See also **C1** — the grade pass is amplifying these values *before* they reach the tonemapper,
  which makes this materially worse.

#### B3 · MAJOR · No soft-particle depth fade anywhere; VFX slice through geometry
**Shots:** 04, 05, 06, 07, 08.

Beams, rings and particles all intersect terrain and enemy bodies along hard geometric lines — most
visible where the lower-left wedge cuts the foreground cliff. `BeamPool` (`VFX.js:1390-1399`),
`Trails` (`Trails.js:81-95`) and the ring material all use `depthWrite: false` with plain
`AdditiveBlending` and no depth-texture comparison. The rubric calls this out by name: "soft-particle
depth fade" is a 9-point requirement and its absence is a 4-point symptom.

**Fix:** bind the depth target to the VFX materials and multiply alpha by
`smoothstep(0, fadeDist, sceneDepth - fragDepth)` (fadeDist ≈ 0.5-1.0 world units). One shared
chunk covers `BeamPool`, `Trails`, `ParticleShader` and the ring pool.

#### B4 · MAJOR · Damage numbers and explosion feedback are entirely unproven
**Shots:** 08 (which shows neither).

`VFX.damageNumber` and `VFX.explosion` exist and 08 was supposed to exercise both. Because of
**A1** the shot shows neither a number nor an explosion. This is not scored as working. It must be
re-captured after A1 is fixed and re-judged before any claim about impact feedback stands.

#### B5 · MINOR · Impact flashes are billboards with no motion arc
**Shots:** 04, 05.

The small flashes at the muzzle and at the impact points are static round sprites. Nothing stretches
along the direction of travel, nothing arcs. The rubric's 4-point description — "flat billboard
puffs, single-layer effects" — is the accurate one here. `ParticleSystem` supports `stretch`
(used at `VFX.js:950`), so the mechanism exists; it is not being applied to the flashes.

---

### GROUP C — Post-processing *(owner: `src/core/RenderPipeline.js`, `src/shaders/GradeShader.js`)*

#### C1 · MAJOR · The grade pass runs before the tonemapper, so LDR maths is applied to HDR values
**Shots:** all gameplay shots; worst in 04-08.

Both files document the opposite of what the code does.
`src/shaders/GradeShader.js:5` claims it "Runs on the tonemapped-but-not-yet-encoded image".
`src/core/RenderPipeline.js:19` claims "Everything downstream of `grade` runs in LDR".
The actual pass order built at `RenderPipeline.js:62-101` is:

```
render -> GTAO -> bloom -> grade -> OutputPass(ACES) -> SMAA
```

Grade is **upstream** of the tonemapper. Three of its operations are only meaningful in LDR:

- `GradeShader.js:72` — `col = (col - 0.5) * uContrast + 0.5` with `uContrast = 1.06`. Pivoting
  contrast around 0.5 on a value of 20.0 pushes it to 20.7 *before* ACES ever sees it. This
  directly amplifies the blowout in **B2**.
- `GradeShader.js:73,82` — grain is scaled by `(1.0 - luma * 0.7)` where `luma` is computed on HDR.
  Anywhere `luma > 1.43` this factor goes **negative**, so the grain inverts and its amplitude
  grows without bound with scene brightness. That is a sign error in every bright region of the frame.
- `GradeShader.js:60-66` — chromatic aberration samples R and B at an offset in HDR. Where a
  60.0-valued emissive sits next to a 0.2-valued rock, the offset sample produces a saturated
  fringe that survives tonemapping intact. This is the visible rainbow fringing on the particles at
  the lower-left of 04 (x 60-340, y 640-760) and around the crystals.

**Fix:** move the `grade` ShaderPass to sit **after** `OutputPass` and before `SMAA` in
`RenderPipeline.js:87-101`. That is a two-line reorder and it makes the existing lift/gain/contrast/
grain/vignette/aberration values correct as authored. Then re-tune `uContrast`/`uSaturation`,
which were presumably dialled in against the wrong input.

#### C2 · MAJOR · Chromatic aberration is far too strong and is applied to the whole frame
**Shots:** 04, 05, 06, 07, 08.

Distinct red/green/blue-separated dots are visible on the particles at lower-left and along the
crystal edges at right — the individual channels are separated by several pixels. `uAberration`
resolves to `0.0016 + this.aberration + this.shake * 0.004` (`RenderPipeline.js:124`) and every
explosion adds `0.004 * s` (`VFX.js:459`) with no ceiling, on top of the `r2 * 2.2` radial ramp at
`GradeShader.js:62`. Under combat load these stack.

**Fix:** clamp the accumulated term — `u.uAberration.value = 0.0016 + Math.min(this.aberration + this.shake * 0.004, 0.004)`
— and clamp `this.aberration` itself in `RenderPipeline.update`. Aberration should be a subliminal
edge effect, never resolvable as separate colours.

#### C3 · MINOR · Grain reads as compression dirt on large flat facets
**Shots:** 03 (the large brown terrain facets, lower half), 02.

`uGrain: 0.022` (`GradeShader.js:24`) applied per-pixel with no scaling by output resolution puts
visible speckle on the big low-poly faces that dominate the frame. On a flat ochre plane it reads as
a dirty JPEG, not as film. Combined with **C1** it is being applied at the wrong stage as well.

**Fix:** after moving the pass (C1), drop `uGrain` to ~0.010 and scale the hash lookup by
`uResolution / 1080.0` so grain size is resolution-independent.

#### C4 · MINOR · GTAO is not visible anywhere in the frame
**Shots:** 02, 03.

A GTAO pass is configured with radius 0.85 and `blendIntensity: 0.85`
(`RenderPipeline.js:66-81`), but there is no darkening in any crevice in the image — the joins
between terrace slabs in 03, the bases of the rock spires in 02, and the contact between the
floating islands and their undersides are all uniformly lit. Rubric axis 1's 9-point requirement is
"real ambient occlusion in crevices"; there is none visible. Either the radius is far too small
relative to the 220-unit stage scale, or the effect is being washed out by the hemisphere light
(`Environment.js:121`, intensity 0.75) plus IBL at 0.85 (`Environment.js:87`).

**Fix:** raise GTAO `radius` to ~2.5-3.0 to match the world scale, verify with
`gtao.output = GTAOPass.OUTPUT.Denoise` that the pass is producing anything at all, and drop
`hemi` intensity to ~0.45 so the occlusion has darkness to work against.

---

### GROUP D — World: palette, fog, sky, terrain *(owner: `src/world/*.js`, `src/shaders/SkyShader.js`)*

#### D1 · MAJOR · The entire palette occupies one hue; there is no colour hierarchy
**Shots:** 02, 03 (and the brown substrate of 04-08).

**What is visibly wrong:** the frame is brown. Rock, cliff, sand, fog and sky-horizon are all the
same warm ochre at slightly different values, so nothing separates from anything else by hue — only
by luminance, and fog is flattening luminance too. The only accent is the cyan crystal, which is
scattered as confetti rather than placed, so it reads as noise rather than as a focal accent.

The numbers, from `src/world/Materials.js:14-42` and `src/shaders/SkyShader.js:15`:

| Element | Hex | Hue |
|---|---|---|
| `fog` | `#c2ab84` | 37° |
| sky `horizon` | `#e9b877` | 33° |
| terrain `rock` | `#9c7a4a` | 35° |
| terrain `sand` | `#cfb27e` | 38° |
| terrain `cliff` | `#6b543a` | 33° |
| sky `ground` | `#6a4a33` | 26° |

Six of the seven dominant surfaces sit within **12 degrees of hue**. The palette comment claims
"warm ochre ground, teal-blue zenith, violet-cool shadows" — the ochre is delivered; the teal zenith
and violet shadows are not visible anywhere in any shot (see D2, D3).

**Fix:** this is a colour-script problem, not a shader problem. Push hue separation into the
material set:
- Move `cliff` toward a desaturated violet-grey (`#5a5060`, hue ~275°) so vertical faces read as
  shadow-side and separate from horizontal ochre.
- Move `moss` (`#74883e`) up in coverage and saturation — it is currently invisible in every shot.
- Pull `fog` off the terrain hue entirely toward the sky's zenith teal (`#8fa6ab`), so distance
  reads as *cooling* rather than as more brown. This one change does most of the work.
- Reduce crystal placement density and cluster it, so the cyan accent reads as landmark rather than
  as scatter.

#### D2 · MAJOR · Exponential fog erases all value contrast past ~120 units
**Shots:** 02 (worst), 03.

**What is visibly wrong:** in 02 everything beyond the midground is a single flat tan. The arch at
frame centre, the distant spires, the far terrain — all the same value, no silhouette, no
separation. There is fog *gradient* but no fog *depth cueing*, because the far half of the stage is
saturated at 100% fog.

`src/world/Environment.js:37` — `new THREE.FogExp2(PALETTE.fog, 0.0072)`. FogExp2 factor is
`1 - exp(-(d·density)²)`:

| Distance | Fog |
|---|---|
| 100 u | 40% |
| 139 u | 63% |
| 200 u | 87% |
| 220 u (stage extent) | **91%** |

The stage is 220 units across (`Environment.js:105`, shadow extent 118 ≈ half-stage). At this
density the back half of the level carries less than 10% of its own colour.

**Fix:** drop density to ~0.0035 so 220 units lands near 60% rather than 91%, and pair it with the
cooler fog colour from D1. If a strong haze read is wanted, get it from a *height* fog term
(dense in the basin, thin above the terraces) rather than from uniform distance fog — that is what
gives Titanic Plains its layered look and what would separate the floating islands from the
backdrop instead of dissolving them into it.

#### D3 · MAJOR · The sky's sun disc, zenith gradient and cloud bands are never in frame
**Shots:** 01, 02, 03 (and by inheritance 04-08).

**What is visibly wrong:** the sky is a flat pale tan wash. No sun, no gradient, no cloud detail.

**This is not a broken shader.** `src/shaders/SkyShader.js` is correct and complete — it has a
two-lobe sun disc at `disc * 22.0` (line 70-72), a `pow(h, 0.42)` horizon-to-zenith gradient
(line 65), a warped-fbm cloud deck (lines 83-93), and a sun-biased horizon band (lines 75-78). The
material is correctly excluded from fog (`Environment.js:58`, `fog: false`) and from tonemapping
(line 59). **The problem is that no camera in the game ever points at any of it.**

- Sun direction is `(-0.62, 0.34, 0.71)` (`Environment.js:21`) — an elevation of about **20°**.
- The vista camera sits at `p.y + 28` looking at `p.y + 2` (`src/core/Harness.js:63-64`) — pitched
  **down**. The top of frame is at or below the horizon.
- The title orbit camera sits at `c.y + 16` looking at `c.y + 3` (`src/ui/Menus.js:341-345`) —
  also pitched down.
- The gameplay rig's default pitch is `-0.12` rad, below level (`src/core/CameraRig.js:47`).

So the only part of the dome ever rasterised is the band within a few degrees of the horizon, which
evaluates to `mix(uHorizon, uZenith, ~0.0)` ≈ `uHorizon` = `#e9b877` — the flat tan in the image.
The authored sky exists and has never been seen.

**Fix (two parts, both needed):**
- **Framing.** Raise the sun to ~35-40° elevation in `Environment.js:21` and re-aim the harness
  cameras so the sun's azimuth is in frame: `Harness.vista()` should look *across* the basin
  slightly upward (target `p.y + 12`, camera at `p.y + 14`), not down at it, and the title orbit
  should tilt up so the wordmark sits against sky rather than dirt.
- **Reach.** The `pow(clamp(h,0,1), 0.42)` curve at `SkyShader.js:65` still needs `h > 0.15` before
  the zenith teal is meaningfully present. Compress it (`pow(h, 0.30)`) so the cool colour reaches
  down closer to the horizon and gives the vista its complementary contrast even at low pitch.

#### D4 · MAJOR · Terrain silhouette is one primitive repeated at every scale
**Shots:** 02 (worst), 03.

**What is visibly wrong:** 02 contains eleven or more floating islands and every one of them is the
same inverted cone / truncated cone. Same proportion, same taper, same flat top. There is no
variation of form language, so the frame reads as a particle system of one asset rather than as a
place. The rubric's 4-point description — "blobby primitives, everything the same size" — applies
almost literally, except here they are all the same *shape* at different sizes.

**Fix:** in `src/world/Stage.js` / `src/world/TerrainGen.js`, give the island generator at least
three distinct silhouette families (slab/plateau, spire, arch fragment) selected by a hash of the
island seed, and vary the taper ratio and top-face irregularity per instance. Also break the top
faces — every island currently has a perfectly flat cap, which is what makes them read as a
repeated mesh.

#### D5 · MINOR · One island renders with an inconsistent near-black noisy material
**Shots:** 02, upper right (approximately x 900-1120, y 95-410).

A large downward-pointing island is rendered dramatically darker than every other island in frame
and carries visible high-frequency noise across its face, while its neighbours at the same depth are
mid-value and smooth. It does not read as a shadow — its neighbours at the same distance and
orientation are lit. This is a material or vertex-colour assignment outlier and it breaks cohesion
(axis 10): it looks like an asset from a different scene.

**Fix:** trace which material this face receives in `src/world/Stage.js`; the likely cause is the
`cliff` material (`#6b543a`, `Materials.js:208`) combined with vertex colours from
`TerrainGen` multiplying down. Clamp the vertex-colour range so a face cannot drop below ~0.35 of
its material albedo.

#### D6 · MINOR · Material variety is authored but does not read at any distance
**Shots:** 02, 03.

`Materials.js` defines nine distinct materials with genuinely differentiated roughness —
`wetStone` at 0.28 with `metalness: 0.1` (line 228-235), `metalRuin` at 0.52 with
`metalness: 0.85` (line 237-244), `sand` at 0.99. In the images, **every** surface reads as the same
matte ochre. There is not a single specular highlight anywhere in 02 or 03. The rubric's 4-point
description — "uniform matte plastic on every surface" — is what is on screen.

Contributing causes: the key light is a single directional at intensity 3.4 (`Environment.js:97`)
with the sun *behind* the camera in every shot (see D3), so no surface is at a glancing angle where
specular would show; and the procedural normal maps are applied at `normalScale` 0.5-1.3 with
`repeat: 26` on terrain (`Materials.js:190`), which puts the detail below one pixel at vista range.

**Fix:** re-frame so the key is at a raking angle to the camera (D3), add a distance-based
`normalScale` falloff so mid-range surfaces keep readable normal detail, and place `wetStone` and
`metalRuin` props deliberately in the midground where a specular streak will actually separate them
from the terrain, rather than scattering them.

---

### GROUP E — Player character and camera *(owner: `src/entities/CharacterMesh.js`, `src/core/CameraRig.js`)*

#### E1 · MAJOR · The player character is an unreadable dark blue wedge
**Shots:** 03 (at approximately x 690-760, y 420-650), 04-08 (invisible entirely).

**What is visibly wrong:** at the game's *default* framing, in the shot whose stated job is
"Judges character read", the player is a featureless dark navy shape roughly 60 px wide and 220 px
tall. There is no separation between head, torso, weapon and legs. There is no rim light. There is
no colour that is not the same navy. You cannot tell which direction the character is facing. A
small orange fleck at the top (~x 715, y 425) is the only non-navy pixel on the whole model.

Rubric axis 4's 9-point standard is "shapes readable as pure black silhouettes; characters
distinguishable at a glance". This character is *already* effectively a pure black silhouette and it
is still not readable — the internal forms do not survive at gameplay distance. This is the single
most important axis for a third-person action game and it scores 2.

Contributing: `CameraRig` places the camera 5.4 units back (`CameraRig.js:30`) at FOV 70
(`CameraRig.js:27`), which is a reasonable framing — the problem is the mesh, not the distance. And
the rim light that was authored to fix exactly this (`Environment.js:126-132`, "so ridges and props
get a violet edge instead of dissolving into the fog", intensity 1.1) is not landing on the
character at all.

**Fix:**
- Give the character a light/dark value break in `src/entities/CharacterMesh.js` — RoR2's
  Commando reads because the torso is light against dark limbs. A single second material at ~2.5x
  the albedo value on the chest/shoulders/helmet would do most of the work.
- Add a saturated accent colour on one small, consistently placed element (visor, backpack light)
  so the player is findable in a crowd by colour alone.
- Verify the rim light is actually reaching the character: raise `rim` intensity and confirm the
  character's materials are not `flatShading` matte at roughness 1.0, which would kill the edge.
- Break the outer silhouette — the current shape is a smooth taper. Add an asymmetric shoulder or
  weapon profile so the character's facing is readable from behind.

#### E2 · MINOR · The crosshair is nearly invisible against the scene
**Shots:** 02, 03, 04, 05, 06, 07, 08 (frame centre).

A four-tick reticle in thin white sits at frame centre. Against the mid-value ochre terrain in 02
and 03 it has almost no contrast, and in 04 it is completely lost inside the cyan wedge. There is no
outline, no drop shadow, no hitmarker.

**Fix:** in `src/ui/hud.css`, give the reticle a 1 px dark outline (`filter: drop-shadow(0 0 1px rgba(0,0,0,0.9))`)
so it holds against any background, and add a hitmarker state on the `damage` event.

---

### GROUP F — HUD and UI *(owner: `src/ui/*.js`, `src/ui/hud.css`)*

#### F1 · MAJOR · Every item renders as "common" with a raw kebab-case id — the rarity hierarchy is invisible
**Shots:** 06, 07, 08.

**What is visibly wrong:** the inventory grid (top-left) is **37 identical white glyphs** in one
undifferentiated block — no rarity banding, no colour, no hierarchy. The pickup log (bottom-right)
reads `FROST-RELIC`, `CEREMONIAL-DAGGER`, `BRAINSTALKS`, `TITANIC-KNURL`, `PLANULA`, `QUEENS-GLAND`
— raw ids with hyphens, all in the same white. Three of those are `legendary` and three are `boss`
tier; they should be red and gold respectively.

**Confirmed root cause.** `src/ui/Tooltip.js:32-47`, `def(id)`, duck-types six different accessor
names off `ctx.items`:
```js
items.defs?.[id] ?? items.DEFS?.[id] ?? items.catalog?.[id] ?? items.byId?.[id]
  ?? (typeof items.def === 'function' ? items.def(id) : null)
  ?? (typeof items.get === 'function' ? items.get(id) : null)
```
`src/systems/Items.js` exposes **none** of these. It imports `ITEM_BY_ID` from
`src/data/items.js:455` and keeps it module-private. So `def(id)` returns `null` for every item in
the game, and both consumers fall back:
- `src/ui/HUD.js:170` — `const tier = def?.tier || 'common'` → everything is common, so
  `TIER_ORDER` grouping (`HUD.js:596`, `:670`) collapses into one group and `itemIcon(id, tier)`
  (`HUD.js:180`) always draws the common colour.
- `src/ui/HUD.js:193` — `const name = def?.name || id` → the raw id.

The data itself is fine: `src/data/items.js:379` is
`{ id: 'frost-relic', name: 'Frost Relic', tier: 'legendary', glyph: 'shard' }`. The entire
rarity design exists in `hud.css` (`--t-common` … `--t-boss`, lines 24-30) and never renders.

**Fix (one line):** in `src/ui/Tooltip.js`, `import { ITEM_BY_ID } from '../data/items.js'` and
make `def(id)` return `ITEM_BY_ID.get(id) ?? null`. Delete the six-way duck-type — it is what hid
the bug, because a hard failure would have been noticed immediately. Separately, `HUD.js:193`
should use `prettify(id)` as its fallback the way `Tooltip.js:55` already does, so a missing def
never surfaces kebab-case to the player.

#### F2 · MAJOR · 05-boss's HUD asserts a boss that is not in the frame
**Shot:** 05 (and inherited by 06, 07, 08).

A full-width `BOSS — 100%` bar sits at the top of the frame with no boss anywhere in the image. This
is a symptom of **A1**, but it also exposes a UI design problem worth fixing independently: the boss
bar has no on-screen indicator tying it to a body — no off-screen arrow, no world-space marker, no
health-bar-over-head. In RoR2 the boss bar is always accompanied by a locatable target.

Also: the `TELEPORTER BOSS` sub-label (`HUD.js:207`) renders in a dim grey that is close to
illegible against the yellow bar above it.

**Fix:** add an off-screen direction indicator driven from `HUD.setBoss(enemy)`, and raise the
sub-label's contrast — it is currently below WCAG AA against its own backdrop.

#### F3 · MINOR · Ability names are hard-clipped mid-word
**Shots:** 02, 03, 04, 05, 06, 07, 08 (bottom-right).

The skill bar reads `DOUBLE TAP`, `PHASE ROUND`, `TACTICAL DIV_`, `SUPPRESSIV_`. Two of four names
are truncated, and the truncation is a hard clip with what reads as an underscore rather than a
proper ellipsis. The bar looks broken.

**Fix:** in `src/ui/hud.css`, either widen the slot to fit the longest ability name in
`src/data/abilities.js`, or apply `text-overflow: ellipsis; overflow: hidden; white-space: nowrap`
so it degrades to `TACTICAL DIV…`. Better: author short display names (`TAC. DIVE`, `SUPPRESS`) in
the ability data and use the full name only in the tooltip.

#### F4 · MINOR · The M1 slot shows a bare "0.1" where its icon should be
**Shots:** 04, 05, 06, 07, 08.

The first ability slot's icon has been replaced by the text `0.1` — a raw cooldown float with no
unit, no rounding and no radial sweep. The other three slots still show their icons. A cooldown
readout that replaces the icon costs the player the ability to identify the slot at exactly the
moment they most need to.

**Fix:** overlay the cooldown as a radial wipe on top of the icon rather than replacing it, and
round to one decimal only below 1.0s (`0.1` → show as a sweep; `3.2` → show as `3`).

#### F5 · MINOR · The title screen scrim destroys the background it exists to show
**Shot:** 01.

**What is visibly wrong:** the entire background is a near-black brown smear. There is no readable
terrain, no horizon, no silhouette, nothing. `Menus.orbit()` (`src/ui/Menus.js:337-347`) is running
a slow 34-unit orbit over the generated stage specifically so there is something to look at, and the
scrim erases all of it.

`src/ui/hud.css:897-906`:
```css
background: radial-gradient(ellipse at 50% 45%, rgba(6,12,20,0.55), rgba(2,4,7,0.92) 85%);
backdrop-filter: blur(9px) saturate(0.75);
```
92% opaque black at the edges, plus a 9 px blur, plus desaturation to 0.75. Combined with the orbit
camera's downward pitch (see D3), the result is a frame that is roughly 90% featureless dark.

**Fix:** drop the outer stop to `rgba(2,4,7,0.62)`, reduce blur to 3-4 px, keep saturation at 1.0,
and change the gradient from radial-centred to a vertical or left-anchored one so the darkening sits
*behind the type* and lets the stage read in the upper right. Combined with raising the orbit
camera's look-at target so the horizon and sky are in frame, this turns dead space into an
establishing shot.

#### F6 · MINOR · The wordmark is a system font with letter-spacing, not a logo
**Shot:** 01.

`PETRICHOR` renders in `--font` (`hud.css:10`, Bahnschrift / DIN Alternate / Roboto Condensed) at
weight 700 with `letter-spacing: 0.16em` (`hud.css:935-944`). It is clean and it is legible, and it
has no identity — it reads as a presentation title. Every other piece of UI chrome in this project
commits to an angular sci-fi language (the `--skew: -16deg` buttons, the `clip-path` rule under the
title, the notched panels), and the wordmark commits to nothing.

**Fix:** apply the same angular language the buttons already use — a slight horizontal skew or a
`clip-path` chamfer on the wordmark, a heavier weight, tighter tracking, and a single accent
element (the cyan rule is already there; tie it into the letterforms rather than parking it
underneath). This is the cheapest large win in the set: it is pure CSS.

#### F7 · MINOR · `manifest.json` records two unexplained 404s
**Shot:** 02 (one recorded), plus one more in the global list.

`"Failed to load resource: the server responded with a status of 404 (Not Found)"`. No asset loads
exist anywhere in `src/` — a repo-wide search for `fetch(`, `new Image`, `.load(`, `src="/"` and
`href="/"` in JS returns nothing, and `src/ui/Icons.js` generates icons procedurally. The most
likely candidate is `/favicon.ico`, which is benign. It is logged here so a later round does not
re-investigate it, and so that if it turns out to be a real asset the harness flags it.

**Fix:** add a favicon to `index.html`, or filter `favicon.ico` out of the error collector at
`tools/capture.mjs:136` so genuine 404s are not buried in noise.

---

## 3. What already works

Short, and honest.

- **The HUD layout is genuinely good.** In 02 and 03 the composition is correct: gold top-left,
  timer and difficulty top-right, health and XP bottom-left, abilities bottom-right, objective
  centred at the top. Nothing overlaps the action, the reading order is right, and the angular
  notched panels with the `-16deg` skew have a real identity that is not a default rounded box.
  This is the one subsystem where the intent survived into the pixels.
- **The health bar is well-built.** Segment ticks, a white ghost-damage trail behind the fill, and
  a readable `10 / 110` numeral. That is a considered piece of UI, not a progress bar.
- **The skill-slot chrome reads correctly** — icon, keybind chip, name — and the four procedurally
  drawn ability glyphs in 02/03 are distinct from each other at a glance.
- **The crystal accent works where it is dense.** The large cluster at bottom-left of 02 is the one
  place in the set with a genuine complementary contrast against the ochre, and it is the only thing
  in that frame that functions as a focal point.
- **Fog does produce a legible depth stack in 03** — dark foreground cliff, mid-value player ledge,
  washed background — even though it is over-dense (D2). The composition instinct is right.
- **The dead trees in 03 hold a readable silhouette** against the sky band and are the best-formed
  props in the set.
- **`SkyShader.js` is well-written and is not the cause of the flat sky.** Sun disc, two-lobe glow,
  horizon band, warped-fbm cloud deck, correct linear-space handling, correctly excluded from fog
  and tonemapping. It has simply never been pointed at (D3). Fixing the framing should unlock most
  of it for free — this is the highest-value-per-line-changed fix in the report.
- **`Materials.js` texture generation is sound** — one noise field driving albedo, roughness and a
  derived normal so the three channels agree. The problem is lighting and framing, not the maps.

That is the complete list. Nothing else in this set earns a mention.

---

## 4. Recommended dispatch order

The groups are ordered by what unblocks the most downstream judgement:

1. **GROUP A** (Engine/harness) — nothing else can be evaluated until 05/07/08 capture real content.
   A1 and A2 must land before any re-capture.
2. **GROUP B** (VFX beams/bloom) + **GROUP C** (post ordering) — these two interact; C1's pass
   reorder changes what B2's bloom tuning should be, so they should go to the same agent or be
   sequenced B2 after C1.
3. **GROUP D** (world palette/fog/sky) — D3's framing fix and D2's fog density are cheap and will
   move axes 1, 2, 3 and 5 together.
4. **GROUP E** (character silhouette) — the highest-value single art fix, but independent.
5. **GROUP F** (HUD) — F1 is a one-line fix with a large visible payoff; the rest are polish.

Round 1 of 4.
