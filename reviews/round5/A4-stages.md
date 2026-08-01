# A4 — Stages / biome identity (round 5)

Goal: make the four biomes read as four authored *places* rather than one
generator recoloured. Delivered per-biome heightfield profiles, per-biome prop
kits, 3 hand-authored landmarks each, per-biome sky/atmosphere, a real
per-biome roughness ladder, landmark-relative interactable placement, and a
`13-biomes` harness scenario so a critic can grade the claim from pixels.

---

## 1. Per-biome identity

Each biome now names a `profile` that `TerrainGen` dispatches a whole landform
pass on, and a `kit` that `Props` builds a different geometry set for. The
silhouette of the *ground* differs before any prop or colour is applied.

### `ochre` — **Cindergrass Flats** (kit `plains`, profile `mesa`)
Rolling dry grassland with long sight lines, punctuated by 8 flat-capped
sandstone mesas. Base amplitude drops 26 → 13 and terracing is cut to 0.20
strength: the open ground is *calm*, and every hard horizontal in frame belongs
to a mesa cap. Each mesa is a flat cap over a sheer skirt whose width swings on
a cubic with azimuth, so three sides are an unclimbable ~70° wall and one is a
long graded approach ramp (see §6 — without the ramp a cap is walkable ground
nothing can reach). Sun at 15° — the lowest that still clears a mesa rim.

### `verdant` — **The Drowned Aqueduct** (kit `canyon`, profile `canyon`)
An eroded plateau cut by a network of flooded channels 15 m deep. The network is
the **level set** of a smooth field rather than a threshold of one — a threshold
gives blobs, the set where a smooth field is near a chosen value is a family of
winding, branching curves, i.e. a drainage. Bank width rides its own much lower
octave, so some reaches are sheer walls and others are graded scree; that is not
decoration, it is what stops the canyon being a set of pits with no exit. The
basin *rises* here (`basinDrop +2.0`) — the play surface is the plateau, and the
drama is what has been removed from it. Standing water is one plane at
y = −13.4 on the `wetStone` rung.

### `amethyst` — **The Pale Vault** (kit `cavern`, profile `cavern`)
A cavern. `wallStart` moves 0.82 → **0.64** and `wallBase` 38 → **62**, so from
anywhere on the floor rock closes the upper third of every frame — this is the
one biome where the "the massif must not eat the sky" rule is deliberately
inverted. The floor is 22 terrain stalagmites: concave-flanked shafts on a power
curve (a smoothstep gives a dome, and a dome is a hill). The sky shader grows a
vault term for this biome only. Key is a 40° shaft rather than a sunset.

### `ferrous` — **Rallypoint Ferrous** (kit `works`, profile `works`)
A military fabrication site silted into a rust flat. One module height (2.4 m)
across the entire terrain with `terraceBlend 0.09` (razor risers) and the mask
wide open, so the shelving reads as a *survey grid* rather than a band of
geology. On top: 13 rotated rectangular pads whose deck heights are quantised to
that same module, each with three 1.5 m chamfered edges and one 13 m vehicle
ramp. The only biome with no organic silhouette in it at all.

---

## 2. Landmarks (3 per biome, hand-authored, non-random)

Positions come from a fixed bearing triangle rotated as a rigid body by stage
index (golden angle), zero rotation on stage 1 — the round-4 composition is
preserved and later stages don't repeat it. Published on
`stage.landmarks` as `{kind, x, y, z, r}`.

| Biome | Landmarks |
|---|---|
| plains | **Great Arch** (relocated onto the nearest mesa cap, off-centre toward the ramp side) · **The Henge** — 11 menhirs + 4 lintels, every 4th a broken stump · **The Watchstone** — leaning obelisk with a single metal band at 24 m |
| canyon | **The Viaduct** — 9-bay arcade, sited by searching for the deepest crossing with high ground at both ends; deck is a walkable one-way platform strip · **The Cistern** — 26-block drum with a collapsed quadrant you can walk into · **The Steps** — 22 quarried treads with cheek walls, plateau down into the water |
| cavern | **The Geode** — two 7 m half-shells split apart, 34 crystal instances inside · **The Grove** — 5 fungi at 7–13 m · **The Chandelier** — 22 stalactites, longest at the centre, hanging off a 15 m shelf |
| works | **The Gantry** — lattice tower + 22 m cantilevered boom + counterweight · **The Hangar Frame** — 5 uncladded portal ribs with purlins, walk-through · **The Dish** — true paraboloid lathe on a truss mount, tipped and swung off axis |

---

## 3. Prop kits

Only the boulder layer is shared (a rock belongs everywhere). `Props.js.bak`
deleted.

| Biome | Kit |
|---|---|
| plains | sandstone slabs, prairie trees (trunk `wood` + 3–4-lobe canopy `moss` on shared matrices), 900 grass tufts (no shadow, no raycast), standing stones, floating islands |
| canyon | fluted columns (real scalloped flutes, not a texture), toppled drums, reeds gated to the waterline, ferns gated above it, polished slicks on the channel floors, 2-bay arcade fragments of the viaduct's own order, the water plane |
| cavern | stalagmites, hanging stalactites off the islands, glowing fungus (stalk `wood` + cap on the `crystal` rung — the biome's ground-level fill light), mineral pools, heavy crystal |
| works | I-beam girders (some kinked), corrugated containers stacked 1–3 with per-layer yaw offset, lattice pylons, Jersey barriers laid in runs of 3–7, pipe runs on saddles |

New shared machinery: `_addPaired` (two geometries on one matrix set),
`_addInstanced(..., {shadow, target})` so small organics stay out of the shadow
map and out of `propTargets`, `_spot({yMin,yMax})` for the waterline gating.

Crystal geometry now has two silhouette families (needles + stubby wedges),
closing the round-4 axis-4 defect "~150 instances of the same spike shape".

---

## 4. Materials — the roughness ladder per biome

`applyBiomeMaterials` now applies a per-biome `matTune` block over
`MAT_TUNE_BASE`: roughness, metalness, `envMapIntensity`, `normalScale`,
`emissiveIntensity`. All uniform-level — no map, flag or material identity is
touched, so **no shader program is invalidated** (capture manifest: 62–64
programs, unchanged from baseline).

| rung | plains | canyon | cavern | works |
|---|---|---|---|---|
| terrain | **0.90** / env 0.85 (bone dry) | 0.70 / 1.25 | 0.86 / 1.15 | **0.93** / 0.75 (silt) |
| rock | 0.70 / 1.35 | 0.58 / 1.50 | 0.64 / 1.55 | 0.80 / 0.95 |
| cliff | **0.58** / 1.45 (wind-polished caps) | 0.62 / 1.30 | 0.54 / 1.60 | 0.74 / 1.05 |
| moss | 0.99 / 0.30 | 0.94 / 0.62 | **0.72 / 1.30** (lichen, leaves the matte end) | 0.99 / 0.30 |
| wetStone | 0.12 / 2.40 | **0.045 / 3.4** (the water surface) | 0.05 / 3.1 (glass pools) | **0.07 / 3.6** (oil slick) |
| metalRuin | 0.20 / 2.80 | 0.34 / 2.2 (green corrosion) | 0.20 / 2.80 | **0.15 / metalness 0.86 / 3.4** (hero material) |
| sand | 0.94 / 0.60 | 0.94 / 0.60 | 0.88 / 0.85 | 0.97 / 0.45 |
| crystal emissive | 0.55 | 0.60 | **1.35** (a light source, not an accent) | 0.45 |

Also added **sedimentary strata** to the terrain vertex colours: a per-layer
value step keyed to absolute world height, weighted onto steep ground. First
attempt at `strataStep 2.6` aliased into vertical stripes on the massif —
a 1.375 m facet on a 70° wall spans ~3.8 m of height, so every triangle landed
in its own layer. Fixed by a step *longer than a facet's vertical extent*
(6.0–9.0 per biome) plus holding each layer's value flat across 78% of the step
before a fast crossfade, so band edges stay hard but neighbours don't scatter.

---

## 5. Sky + atmosphere

`SkyShader` gained three uniforms, defaulted so the three open biomes are
unchanged in shape:

- `uHazePow` — how tightly the hot band hugs the horizon (plains 9.0, canyon
  13.0 hard/narrow, cavern 6.0, works 8.0).
- `uCeiling` / `uCeilingAmount` — the vault. Above ~2° of elevation the dome
  becomes rock; the two wide atmospheric-scatter lobes of the sun go with the
  atmosphere and the sun survives as the disc and its tight halo only, which
  reads as the shaft of daylight the key light represents. Cloud deck and the
  horizon glow are damped by the same term. 0 in the other three biomes.

`Environment` gained a per-biome `fog.skyBlend` override, used only by the
cavern: aerial perspective converges distant geometry toward the sky behind it,
but the "sky" behind the back of a cave is the vault, so the usual 0.45 blend
onto the horizon amber painted daylight onto the back of a cave (0.12 there).

Key directions / fog: plains 15°/az 34° density 0.0031; canyon 19°/az 118°
density 0.0046; cavern 40°/az −62° density 0.0058 skyBlend 0.12; works
9°/az 152° density 0.0058.

---

## 6. Interactables placement

`Stage.landmarks` is published from `Props`. `Interactables.populate` now sites
against it instead of scattering uniformly:

- **Chests** round-robin the landmarks (all get loot, so the player is never
  rewarded for visiting only the nearest). Ring radius tightens with tier —
  a legendary sits against the structure's footing, a common out to ~28 m.
- **Multishop** goes *between* two landmarks, so the walk between anchors has a
  reason to be taken.
- **Shrines** go tight in (3.5–11 m) on the landmarks the chest run doesn't lead
  with; a shrine reads best with mass directly behind it.
- **Teleporter** is sited on the line from landmark 0 toward the basin centre —
  open ground with the primary landmark as backdrop, which is the sight line
  every wide framing already looks down.

All of it draws from `ctx.rng` and validates through `stage.isWalkable`, so it
stays reproducible for a co-op client, with the old uniform scatter as fallback
when a stage has no landmarks.

**`ctx.stage` API shape is unchanged** — `raycast`, `sampleHeight`,
`capsuleResolve`, `randomWalkablePoint` keep their exact signatures and
semantics. `landmarks` is a new read-only field, additive.

---

## 7. Walkability (`randomWalkablePoint` safety)

A3 is expanding the enemy roster against this terrain, so walkable fraction was
treated as a hard constraint, not an afterthought. Measured offline over the
r ≤ 72 play disc (the annulus `randomWalkablePoint` samples), 2 m grid:

| biome | walkable % | height range | p05 / p50 / p95 | mean relief over 12 m |
|---|---|---|---|---|
| ochre | **80.0** | −8.0 … 31.9 | −5.0 / 5.2 / 21.0 | 8.74 |
| verdant | **68.8** | −16.3 … 9.3 | −14.8 / −0.4 / 6.4 | 8.19 (10.9% of the disc under water) |
| amethyst | **75.7** | −7.8 … 42.5 | −5.6 / −0.5 / 13.4 | 7.06 |
| ferrous | **87.3** | −11.1 … 24.0 | −6.4 / 2.0 / 10.9 | 4.77 |

Reference biome before this round measured ~66%. Every biome is at or above it.
Two connectivity hazards were designed out rather than measured away: mesa caps
get an azimuthal ramp (first pass used a quartic and gave a ramp only ~20° wide
in azimuth — a 52° approach, past the 50° walk limit, i.e. no ramp; cubed
instead), and canyon banks vary from sheer to 24° scree so a player or a pathing
agent that ends up in the water can get out.

---

## 8. Verification (actual output)

### Build
```
$ npm run build
vite v8.2.0 building client environment for production...
✓ 78 modules transformed.
✓ built in 1.07s
```
Clean (only the pre-existing >500 kB chunk-size advisory).

### Capture — `node tools/capture.mjs`, full run, seed 1337
```
{
  "ready": true,
  "shots": ["01-title","02-vista","03-thirdperson","04-combat","05-boss",
            "06-loaded-hud","07-interactables","08-explosion","09-survivors",
            "10-inventory","11-bestiary","12-boss-phases",
            "13-biomes-1","13-biomes-2","13-biomes-3","13-biomes-4"],
  "errorCount": 0,
  "perf": { "programs": 62, "geometries": 571, "textures": 50, "sceneObjects": 760 }
}
READY true | top-level errors 0 | partial false | shots 16 | shots with any error 0
```
Per-shot: every `13-biomes-*` reports `frameErrors: 0`, `newErrors: []`.
All four PNGs hash differently (they are four different worlds, not four
screenshots of one).

### Perf — `node tools/perf.mjs`, quality 3, combat-24, RTX 2070
| | avg ms | median ms | p95 ms | worst ms | geometries | programs |
|---|---|---|---|---|---|---|
| **baseline (before my work)** | 20.44 | **20.80** | 24.6 | 25.6 | 158 | 64 |
| after, sample 1 | 39.02 | **20.30** | 34.7 | 515.8 | 341 | 59 |
| after, sample 2 | 18.24 | **17.80** | 24.2 | 25.4 | 340 | 59 |
| after, sample 3 | 22.33 | **22.30** | 29.3 | 29.3 | 340 | 59 |

Median 17.8–22.3 against a 20.8 baseline: no regression, inside run-to-run
noise. Sample 1's 515 ms worst frame is a one-off first-draw warm-up (it does
not reproduce in samples 2–3 and it is a single `saturatedFrames: 1`).
**Caveat, stated plainly:** this is not a clean isolate — three other agents
landed survivors, items and an expanded enemy roster into the same tree while I
worked, so the geometry count rise (158 → 340) and the program count are not
attributable to the world alone. What is attributable: program count did **not**
rise (62–64 throughout), confirming `matTune` and the sky uniforms fork no
shader; and the offline prop probe puts the per-stage prop budget at 22–25 draw
calls and 57k–131k triangles across the four kits, comparable to what the single
old kit produced.

### Determinism
```
$ node _detprobe.mjs      # sha1 over baked grid + every instance matrix + colliders + landmarks
ochre     pass1=af3f8aa5f1d2aa14 pass2=af3f8aa5f1d2aa14 MATCH
verdant   pass1=5f9a2cfcc4f36605 pass2=5f9a2cfcc4f36605 MATCH
amethyst  pass1=7d4e25c240c6fbb7 pass2=7d4e25c240c6fbb7 MATCH
ferrous   pass1=370b6d34b673966b pass2=370b6d34b673966b MATCH
all deterministic: true
```
All feature layout draws from a sub-seed of the terrain seed, never from
`ctx.rng`, per NETCODE.md.

---

## 9. Files touched

Owned:
- `src/world/TerrainGen.js` — `_shape` dispatch + `_mesas`/`_channels`/`_pads`/`_spires`, `_buildFeatures`, strata in `_faceColor`, `waterLevel`
- `src/world/Materials.js` — `SHAPE_BASE`, `MAT_TUNE_BASE`, four rewritten biomes, `applyBiomeMaterials` applies surface response
- `src/world/Props.js` — rewritten around four kits + landmarks; `Props.js.bak` **deleted**
- `src/world/Environment.js` — new sky uniforms, per-biome fog blend
- `src/world/Stage.js` — publishes `stage.landmarks` (+6 lines)
- `src/world/Interactables.js` — landmark-relative placement
- `src/shaders/SkyShader.js` — `uHazePow`, `uCeiling`, `uCeilingAmount`

Shared (append/minimal, per the wave rules):
- `src/core/Harness.js` — added `biomeVista`; and fixed `vista`'s hardcoded
  camera diagonal, which my landforms broke (it was landing the lens flat
  against a mesa skirt and filling half of `02-vista` with one unlit triangle).
  It now sweeps off the same preferred bearing until it can see the subject.
- `tools/capture.mjs` — four `13-biomes-*` scenarios, placed before
  `06-loaded-hud` so they get a clean HUD; the last one restores stage 1 *after*
  its own shutter so nothing downstream is shot against the wrong world.

Not touched: `ui/*`, `data/*`, `entities/*`, `systems/*`, `core/Engine.js`.

---

## 10. Left undone / known weaknesses

1. **The teleporter beam is still a strong vertical in three of four biome
   frames.** The framing now rejects any bearing that puts it within ~17° of the
   centre line, which stops it splitting the shot, but a 70 m emissive column is
   loud wherever it lands. Properly fixing it means the beam itself getting a
   distance/height falloff, and that is VFX's area, not the world's.
2. **`02-vista` still spends ~25% of frame on one dark mesa flank.** The bearing
   sweep only tests line of sight to the subject; it does not test *foreground
   load* the way `clearCam` does for `07-interactables`. Porting that
   `foregroundLoad` rejection into `vista` and `biomeVista` is the next cheapest
   composition win and I did not get to it.
3. **The plains read closer to mesa country than to open prairie** in a
   landmark-framed shot, because the primary landmark now stands on a mesa and
   any framing of it puts a cliff underneath. That is deliberate (an elevated
   landmark is better composition) but it means the "wide sight lines over flat
   ground" half of the biome brief is under-photographed.
4. **The canyon's water does not read as water at a distance** — it is the
   `wetStone` rung on a flat plane, which gives a real specular but no
   refraction, no shoreline foam and no normal animation. A dedicated water
   material would fork a shader program, which the biome design explicitly
   forbids, so this is a deliberate ceiling rather than an oversight.
5. **Perf is not a clean isolate** (see §8). If the world's own cost needs to be
   attributed exactly, it wants a perf run on a branch with only these changes.
6. `matTune` does not touch the interactable material ladder in
   `Interactables.js` (IRON/STONE/etc.), so chests and shrines carry the same
   surface response in all four biomes. Round 4's #2 defect (the chest as an
   untextured neutral slab) was partly addressed by another pass and is
   otherwise still an asset-authoring ceiling.
