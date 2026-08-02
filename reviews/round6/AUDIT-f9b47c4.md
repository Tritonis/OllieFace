# Independent audit of `f9b47c4` ("in progress")

Scope: `git diff 2a782a0 f9b47c4 -- src/`, the ten files not already cleared by the
session (1,155 added / 157 removed lines). `reviews/` ignored. `src/core/Harness.js`
skimmed only, per brief.

Method: every changed constant read together with the code that consumes it, plus
pixel measurement of shipped PNGs where a suspicion could be settled cheaply. All
measurements below name the file they came from. **No project file was modified**;
measurement scripts live in the session scratchpad and `tools/vfxcrop.mjs` was used
read-only. `tools/capture.mjs` was not run.

**8 CONFIRMED (new) · 6 SUSPECTED · 2 already-known re-stated · 5 files/areas cleared**

Worst finding: **C1** — `VFX._ringAxis` tilts the shockwave ring toward the lens for
essentially *every* explosion, not just airbursts, deliberately defeating `RingFrag`'s
edge-on fade whose stated purpose is "what stops a shockwave becoming a laser"; the
measured result is +34.8% mean luminance in the right third of `08-explosion`.

---

## Already known — restated only, not re-investigated

- `Materials.js:358` `#define DET_KILL 0.0`, applied `:486`. The whole terrain
  detail pass is off. **Side effect worth recording:** this moves *every* frame's
  luminance, so any "same stage and camera" control comparison that straddles this
  commit is not a fixed reference. Measured: `06-loaded-hud` mean L 67.50 →
  69.63 (`reviews/round5/base-r4/` vs `reviews/round6/base/`) with nothing in that
  shot otherwise touched.
- `ParticleShader.js` quad fade `smoothstep(0.74, 1.0, rq)`. See **C8** for a
  second, independent defect on the *same* line's neighbour (the 0.05 floor).

---

# CONFIRMED

## C1 — `_ringAxis` disables `RingFrag`'s edge-on fade for nearly every explosion, and its stated invariant is false
**Severity: critical.** `src/systems/VFX.js:1521-1541`, applied at `:532-534`.

```js
if (Math.abs(_ax1.y) >= 0.34) return UP;
return _ax2.set(0, 1, 0).addScaledVector(_ax1, -0.40).normalize();
```

`_ax1` is the normalised camera→blast direction. The guard therefore asks *"is the
blast at least 34% of its distance above or below the camera?"* — not *"is this an
airburst?"*. For a third-person lens 3–6 m above the ground, a blast **sitting on the
ground** clears 0.34 only inside ~9–18 m. Every ground explosion beyond that is
tilted 21.8° (`atan 0.40`) toward the lens.

The doc comment asserts the opposite: *"returns UP untouched for every blast that
does sit on the ground"* and *"no ground blast's read changes"*. Both are wrong.

What it disables: `RingFrag` (`VFX.js:1868`) does `a *= clamp(vFacing / 0.28, 0.0, 1.0)`
with the comment *"Fading the ring out as it goes edge-on is what stops a shockwave
becoming a laser."* `_ringAxis` exists specifically to push `vFacing` to ~0.37 so that
clamp always saturates. It is a global override of a guard, applied to fix one shot.

**Measurement** (`reviews/round5/base-r4/08-explosion.png` → `reviews/round6/base/08-explosion.png`,
both 1600×900; the blast is sited 9–15 m out and lifted 3.0–4.4 m by `Harness.js:2286-2331`):

| region | before | after |
|---|---|---|
| whole frame, mean L | 91.07 | 93.84 |
| whole frame, %>L220 | 2.86% | 0.60% |
| **x 1150-1600, y 250-850, mean L** | **88.05** | **118.71 (+34.8%)** |
| same region, %>L220 | 0.35% | 1.03% |
| same region, mean RGB | 117.4/81.0/71.7 | 155.0/111.0/88.2 |

Before: a thin faded arc. After: a ~25 m-diameter tilted ellipse at 11 m from the
lens whose arcs cross the top-left, top-right and right edges of the frame and read
as unrelated light streaks rather than as a shockwave. The `vLens` fade added in the
same hunk does not reach it — at the shutter `sub = r/dist ≈ 12.7/11 = 1.15`, giving
`vLens ≈ 0.91`.

Second consequence, unmeasured but geometric: a *ground* blast's ring is now a disc
tilted 22° out of the ground plane, so at `r*2.6` for `r = 6` roughly half the ring
sits ±5.6 m below the terrain (occluded by the depth test) and half floats above it.

**Reproduction:** any `ctx.vfx.explosion(pos, r)` with `|pos.y − camera.position.y| <
0.34 · distance`. That is the common case, not the exception.

---

## C2 — the Fracture's 96 serrated rim teeth are under the floor and can never be drawn
**Severity: major.** `src/world/realms/RealmArena.js:524-546`.

Three independent reasons, any one sufficient:

1. **Position.** `x: Math.cos(a) * (1 - len * 0.35)` with `len ∈ [0.030, 0.085]` puts
   every tooth at 0.970–0.990 of the floor radius — *inside* the floor disc, which is
   a unit `CircleGeometry` scaled to `floorRadius` (`floorDisc`, `:63-76`).
2. **Height.** `y: drop = -0.02 - f*0.10` ∈ [−0.12, −0.02], plus the mesh's own
   `position.y = 0.02`, gives world y ∈ [−0.10, 0.00]. `stage.origin.y === 0`
   (`RealmStage.js:58`) and the floor disc sits exactly there. The teeth are at or
   below an opaque coplanar disc.
3. **Scale.** `stage.onFloorRadius` does `rimTeeth.scale.set(r, 1, r)`. X and Z are
   scaled by 34; **Y is not**. After the `rz: π/2` rotation the tooth's Y extent is
   its cone *radius*, 0.020–0.032 — so the teeth are 2–3 cm tall ribbons, 1.0–2.9 m
   long and 0.7–1.1 m wide.

There is a fourth, separate bug in the same block: `mergeParts` (`:50-52`) applies
`rotateY`, then `rotateX`, then `rotateZ`. The per-tooth `ry: -a` is applied to a cone
whose axis is +Y, which `rotateY` does not change; the final `rz: π/2` then swings
every axis to world −X. **All 96 teeth point the same way** instead of radially.

**Evidence:** `reviews/round6/base/realms/26-finale-phase2.png`, 4× crop of
x 20-340 / y 470-690 — the rim is an unbroken, perfectly smooth magenta band. The
critique this block answers ("a clean, unbroken, machined magenta tube") is unchanged.

---

## C3 — `roomWall`/`roomCeiling` mutate the caller's shared material to `BackSide`; the meshes that share it lose their form
**Severity: major. PRE-EXISTING (identical at `2a782a0`) — but it is what neuters this commit's headline bazaar and crucible work.**
`src/world/realms/RealmArena.js:82` and `:122`.

```js
shell.material.side = THREE.BackSide;   // roomWall
m.material.side     = THREE.BackSide;   // roomCeiling
```

`m.material` *is* the object the caller passed. There is no clone anywhere —
`RealmStage.addMesh` (`RealmStage.js:92`) only parents the mesh.

| realm | rung | also used by |
|---|---|---|
| bazaar | `paleStone` → `roomCeiling` (`:196`) | `colMesh` (`:216`), `dais` (`:262`) |
| crucible | `iron` → `roomWall`+`roomCeiling` (`:338-339`) | `blockMesh` (`:355`), `bowlMesh` (`:381`) |
| vault | `wall` only | *(clean)* |
| fracture | *(no room)* | *(clean)* |

So the arcade columns and lintels, the market dais, the crucible cover-block bodies
and skirts, and the brazier bowls and stems are all rendered **back-face-only**: you
see their far interior surface, the depth buffer records the back of the solid, and
with `flatShading: true` the geometric normal is taken from screen derivatives and so
always faces the camera — there is no form shading left at all.

**Evidence** (`reviews/round6/base/realms/22-realm-bazaar.png`):

- The two-tier dais — `CylinderGeometry(5.2, 5.8, 0.34)` + `(4.4, 4.9, 0.30)`, 0.64 m
  total, which at 20.5 m from a 6.4 m lens is ~27 px of riser — renders as a **flat
  white disc flush with the floor, with no riser, no thickness and no step between the
  tiers** (8× crop of x 575-735, y 520-610).
- The "pale limestone" columns (`0xb9c6c8`, albedo L ≈ 195, `envMapIntensity` 1.0)
  measure mean L **108.4** (x 70-110, y 380-470), while the *darker* polished floor
  (`0x64777d`, albedo L ≈ 115, `envMapIntensity` 0.8) measures mean L **185.2**
  (x 620-860, y 700-760). The pale stone renders 1.7× darker than the mid stone in
  the same room.

This is precisely the goal the commit states — *"the columns must step off the wall by
≥2.5:1 in value"* and *"a lit top plate two stops above the body is what makes them
objects"*. The new `plinth`, `steel` and `daisFoot` materials are **not** passed to
`roomWall`/`roomCeiling` and do light correctly, so half of each fix lands and half
does not, which is why the improvement reads as partial rather than absent.

**Minimal fix:** pass a distinct rung to `roomCeiling`/`roomWall`, or have those two
helpers `mat.clone()` before mutating `side`.

---

## C4 — the nova alpha floor `0.05` is applied to the alpha layer, killing the silhouette layer added in the same commit
**Severity: major.** `src/shaders/ParticleShader.js:132`, `createParticleMaterial` `:283-308`, `src/systems/VFX.js:596-609`.

`c.a *= mix(1.0, 0.05, smoothstep(0.30, 0.85, subtense))` is in the **shared** vertex
shader. `createParticleMaterial` builds *both* blend layers from it; only `blending`
differs. The justification in the comment is exclusively about additive accumulation
— *"still a screen-filling wash when six of them overlap"* — which does not apply to
an alpha-blended layer at all: alpha-blended smoke cannot sum past clip, it occludes.

Consequence, in the very case the constant was tuned on. `overload-cell` is
`explosion(at, 12)` on the player, ~6 m from the lens. The dust skirt added by this
commit is `e.layer = 'alpha'`, `size1 = r * 1.1 = 13.2 m`, spawned at the blast
centre, and is documented as existing *"so the fireball has something dark to be read
against"*. Its `subtense = (13.2 × 0.5) / 6 = 1.10`, past the 0.85 knee → it is drawn
at **5% alpha**. Same for the smoke column (`size1 = r * 1.5`), whose `alpha0` was
*raised* 0.62 → 0.82 twenty lines earlier in the same hunk.

**Judgement on whether 0.05 is defensible (asked for explicitly): no.** The 3.6×
reduction bought little and was fitted against a baseline the handoff records as
unreproducible:

| shot | before (`round5/base-r4`) | after (`round6/base`) |
|---|---|---|
| `10-inventory` whole-frame mean L | 104.36 | 94.74 (−9.2%) |
| `06-loaded-hud` control, mean L | 67.50 | 69.63 (**+3.2%**) |
| gap (10-inv − control) | 36.9 | 25.1 |

Only 32% of the excess closed for a 3.6× parameter move — and the control itself
moved, because `DET_KILL` changes terrain luminance globally, so the "identical stage
and camera" reference the comment leans on is not fixed across this commit. The floor
is doing most of its work on the layer that never had the problem.

---

## C5 — cosmetic-only boss and ward art is gated on `ctx.authority`, violating NETCODE.md's one rule
**Severity: major.** `src/world/realms/FinalBoss.js:148` (early return) and `:182`
(`this._dressBoss(...)` at the end of `enter`), plus `_buildWardArt` called only from
inside `_raiseAnchors`.

`Realms.js:254` — `if (ctx.authority || replicated) this.active.controller?.enter?.(ctx, stage);`
— *does* call `enter()` on a co-op client. `FinaleController.enter` then returns at
line 148, so on a client the finale gets:

- no broken ring, no trailing spar (`_dressBoss`);
- no key/fill `PointLight`s, i.e. the Herald is lit only by the arena's rim, which is
  the exact flat-pink failure the commit set out to fix;
- no anchor crowns, and **no tethers** — the tether is the only visual that explains
  why the Herald is invulnerable during phase 2. A client sees an unkillable boss, a
  yellow HUD line, and three unexplained polyhedra.

NETCODE.md:29-30 is binding: *"If it changes game state, gate it on `ctx.authority`.
**If it only changes what you see or hear, never gate it.**"* Nothing in `_dressBoss`
or `_buildWardArt` writes gameplay state.

Not observable by construction: the harness is single-player, and no two-peer test has
been run under `PROTOCOL_VERSION` 2. The class is pre-existing (`ctx.vfx.burst` was
already inside `_raiseAnchors`), but this commit puts the phase-2 explanation itself
behind the gate.

---

## C6 — the vault's new fill light puts its brightest pool on the floor, not on the chest
**Severity: major.** `src/world/realms/RealmArena.js:485-487`.

```js
const face = new THREE.PointLight(0xffe0a0, 46, 16, 1.9);
face.position.set(stage.origin.x, 3.2, stage.origin.z - 7.5);
```

three.js 0.185.1 non-legacy attenuation is `intensity / d^decay` × a distance window.

| target | distance | received |
|---|---|---|
| floor directly under `face` | 3.2 m | 46 / 3.2^1.9 = **5.05** |
| chest front face (7.5 m out, ~2 m up) | ~7.8 m | 46 / 7.8^1.9 = **0.92** |
| dais under the main key (210, decay 1.85) | 9.5 m | 210 / 9.5^1.85 = **3.27** |

The floor beneath the fill receives **5.5× what the chest face receives** and 1.6×
what the key puts on the dais — so the brightest lit *surface* in the room is a patch
of empty floor between the camera and the prize. The comment says *"Short range on
purpose: the pillars and the wall must stay in the dark"*; the pillars and wall do go
dark, but the floor does not.

**Evidence:** `reviews/round6/base/realms/24-realm-vault.png` — a broad gold wash
across the lower half of the frame, against the stated goal *"the walls have to fall
off into black behind it"*.

---

## C7 — "Time to the Fracture" is a verbatim duplicate of "Time survived", and is wrong on the `obliterated` ending
**Severity: major.** `src/ui/Menus.js:1017`.

```js
won ? ['Time to the Fracture', stats.time] : ['Items collected', stats.itemCount],
```

`stats.time` is already row 1 of the same grid (`['Time survived', stats.time]`). The
change was made to remove a duplicated *label* ("Items collected" appearing as a tile
and again as a list heading); it shipped a duplicated *value*.

And `won` is `id !== 'death'`, which includes `obliterated` — a run that ended in the
Obelisk of Departure, having never reached the Fracture.

**Evidence, shipped captures:**
- `reviews/round6/base/realms/28-finale-victory.png`: `TIME SURVIVED 00:26` and
  `TIME TO THE FRACTURE 00:26`.
- `reviews/round6/base/realms/29-ending-obliterate.png`: `TIME SURVIVED 00:09` and
  `TIME TO THE FRACTURE 00:09` — on the ending that never goes there.

Both endings also lose the `Items collected` tile from the grid entirely; it survives
only as the list heading `ITEMS COLLECTED — 0`.

---

## C8 — the Fracture's under-taper is occluded from every above-plane camera, so deepening it 3.4 m → 14 m is a no-op
**Severity: minor-to-major (dead geometry, 4× the vertex cost for nothing).**
`src/world/realms/RealmArena.js:513-517`.

```js
const under = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.18, 14, 64, 1, true), edge);
under.position.set(stage.origin.x, -7, stage.origin.z);
```

Top radius `1` equals the floor disc's radius (both are scaled by `floorRadius` —
`setFloorMesh` and `onFloorRadius`), and the cone narrows downward. Its entire
silhouette therefore lies **inside** the opaque floor disc that is coplanar with its
top. From any camera above the floor plane it is completely hidden, at 3.4 m depth or
at 14 m. It can only be seen after the player has fallen off.

The stated purpose — *"the persistent void read — it is there in every frame at every
radius"* — cannot be delivered by this geometry. Consistent with the 4× rim crop of
`26-finale-phase2.png`, where the region beyond the rim is uniform dark with no taper.

---

# SUSPECTED

## S1 — the victory/obliterated headline's border-top is ~3× the width of the rule it is meant to pair with
`src/ui/hud.css:1428-1433` vs `:1437-1440`. `.death-word` is an `<h2>`, so
`border-top` spans the full width of `.death-mark`; `.death-rule` is
`width: min(40vw, 32em)`. Measured on the captures: the top rule runs x≈80→1520
(28-finale-victory) and x≈225→1375 (29-ending-obliterate); the bottom rule runs
x≈555→1045. The comment claims *"the headline sits inside a frame"*. It does not.

## S2 — the obliterated `.death-rule` is effectively invisible
`hud.css:1441-1444` reduces it to `height: 1px` on a
`linear-gradient(90deg, transparent, var(--end), transparent)` at `min(22vw, 18em)`.
`29-ending-obliterate.png` shows no rule at all between the headline and the sub-line.

## S3 — the collapse dust plane spawns underneath the floor it is meant to mark
`RealmArena.js:668-673`: `CircleGeometry(fromR * 1.02)` placed at `y = -0.4`, i.e.
below the opaque floor disc at y = 0, then sinking at 2.2 m/s. Only the annulus
outside the *shrinking* floor radius is ever visible. The layer described as *"what
makes the collapse leave a mark on the air"* contributes a thin outer ring at most.

## S4 — the crucible wave staging has no bound against the room
`RealmHarness.js:264-282`. `lane = (i % 2 ? 1 : -1) * (5.0 + Math.floor(i/2) * 3.6)`
grows without a check against `floorRadius`; a 6th wave member would land ≥12.2 m
off-axis. Harmless while waves are ≤5, but it is a scenario writing entity positions
that the wave controller does not know about. (The hard `0` for y is correct here —
`stage.origin.y === 0`, `RealmStage.js:58`.)

## S5 — the reactive half of chromatic aberration is now sub-pixel everywhere
`RenderPipeline.js:53, 424-425`. Range goes 0.0016–0.0056 → 0.00042–0.00064. The
resting value (~1.1 px at the corner) is defensible and the arithmetic matches the
comment. But the *boost* is 0.6 px at the frame corner and ~0.15 px at frame centre,
so the explosion/hit pulse is invisible where subjects live. `VFX.js:641` still writes
`pipeline.aberration += 0.0012 * s` and `RenderPipeline.js:416` still clamps to 0.004
— both now feed a 0.22-thousandth window. Effect confirmed landed: the heavy RGB
fringing on the left edges of `round5/base-r4/08-explosion.png` is gone in
`round6/base/08-explosion.png`. Flagging as a judgement call, not a bug.

## S6 — light-count churn forces whole-scene program recompiles
`FinalBoss._dressBoss` adds two `PointLight`s at finale entry; the bazaar goes from
2 → 5 and the crucible from 2 → 3. Any change in `NUM_POINT_LIGHTS` invalidates every
material program in the scene, and `attachDetail`'s `onBeforeCompile` makes each
recompile expensive. One hitch per realm entry / phase boundary.

---

# Cleared — read in full, nothing of this class found

- **RNG.** No line in the entire 1,155-line diff touches `ctx.rng`, `fxRng`,
  `Math.random` or any draw count. (`grep -E '^[+-].*(rng|random|Math\.random)'` over
  the whole `src/` diff returns exactly one hit, and it is a comment in
  `RealmHarness.js`.) `ParticleSystem` draws from `ctx.fxRng ?? ctx.rng`
  (`src/fx/ParticleSystem.js:67`), so the emitter changes (fireball 30 → 24, smoke
  22 → 26, +18 dust) cannot displace the gameplay stream.
- **`src/ui/hud.css` (96 lines).** Every changed line is inside the `.screen--death`
  subtree. No `z-index`, `position`, `pointer-events`, `overflow`, `transform` on an
  ancestor, or stacking-context change anywhere. **It cannot affect `10-inventory`.**
  `.ending-seal[hidden] { display: none; }` correctly re-asserts `hidden` over
  `display: inline-flex`. `color-mix(in srgb, …)` renders in the capture browser
  (verified on 28/29). Only S1/S2 above.
- **`src/data/realms.js` (100 lines).** Pure `air()` value changes on four realms plus
  comments. No key added or removed, no structural change, no derived value.
- **`src/core/RenderPipeline.js` (27 lines).** The rewrite is arithmetically
  consistent with its own comment (base 0.00042 × 2660 ≈ 1.1 px; max ≈ 1.7 px), and
  `ABERRATION.drive` (0.004) equals the pre-existing clamp on `this.aberration`
  (`:416`), so the normalisation cannot overshoot. No other uniform touched. See S5.
- **`src/shaders/ParticleShader.js` (50 lines), apart from the two known items.** The
  `min()` → scale change (`c.rgb *= uMaxIntensity / max(mx, uMaxIntensity)`) is
  correct: an exact no-op below the ceiling, and channel-ratio-preserving above it.
  `vQuad = uv` is safe — `uv` is already consumed by the atlas lookup on the line
  below, so the attribute is known to exist.
- **`src/ui/Menus.js` (63 lines), apart from C7.** The ending plumbing is sound:
  `progression.ending` is set only by `finishRun`, which is called only with
  `ENDINGS.victory` / `ENDINGS.obliterated` (`Realms.js:356, :361`), so an ordinary
  death still reads `null` → "You Died". `restart` is `location.reload()`
  (`Menus.js:825`), so a victory's `ending` cannot leak into the next run's summary.
  `Progression.js:408-411`'s two text writes run *after* `hud.onDeath()` and write the
  same strings `showDeath` already wrote — redundant, not conflicting.
- **`src/world/Materials.js`, apart from `DET_KILL`.** `detRes`, the soft crease sign,
  the joint prefilter and the horizon-limit clamp are all internally consistent, and
  `uDetE` is populated from the same `DETAIL` row as `uDetA`/`uDetC`, un-reciprocated,
  in the one place uniforms are built. The horizon clamp does bound the *UV normal
  map's* contribution as well as the detail pass's (down to a 16.7° tilt at grazing)
  — the comment says so explicitly, so it is a documented trade, not a hidden one.
  Nothing further of the `DET_KILL` class found.
- **`src/core/Harness.js`.** Skimmed per brief; the changes are a strict tightening
  (per-object measurement replacing sum/union aggregates, published `perPx`/`perSep`,
  deferred restores drained from `thaw()`). No gate loosened.

---

## Commands and artefacts used

```
git diff -U6..-U10 2a782a0 f9b47c4 -- <each of the ten files>
git show f9b47c4:<file>                      # audited the committed state, not the
                                             # working tree (16 files are dirty)
node tools/vfxcrop.mjs <png> <out> x y w h s # magnified crops
node <scratchpad>/stats.mjs <png> [x y w h]… # mean L / max L / mean RGB / %>L220
cat node_modules/three/src/renderers/shaders/ShaderChunk/normal_fragment_begin.glsl.js
node -e "require('./node_modules/three/package.json').version"   # 0.185.1
```

PNGs measured: `reviews/round5/base-r4/{08-explosion,10-inventory,06-loaded-hud}.png`,
`reviews/round6/base/{08-explosion,10-inventory,06-loaded-hud}.png`,
`reviews/round6/base/realms/{22-realm-bazaar,23-realm-crucible,24-realm-vault,26-finale-phase2,28-finale-victory,29-ending-obliterate}.png`.

`reviews/round6/base/realms/manifest.json` is a capture of the tree at HEAD
(`fba0a91`, whose `src/` is identical to `f9b47c4`), so it is the right baseline for
this commit.
