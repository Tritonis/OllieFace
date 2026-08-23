# New VFX geometries — scope (2026-08-23 overnight, user directive)

Directive: "scope out and implement additional geometries that we could use for new VFX."
Scoped from the recon of the current vocabulary (16-frame particle atlas, straight BeamPool,
RingPool r0→r1, LightPool, Trails, Decals). Everything below composes with the Effect
Language's frame/motion/envelope dimensions and the bucketing check.

## What the current vocabulary cannot draw

1. **Direction and aperture on the ground.** Telegraphs are full rings ("pose + ring") — a
   melee swing or cone attack cannot show WHERE it will land. Anvil's sweep and Cinder's cone
   fake it with streaks.
2. **Rotation about a path.** Nothing spirals: no rising helix (charge/ascent/restorative),
   no inward vortex (gravity/void pull). SPARK/EMBER travel straight.
3. **A path that is not a line.** Beams are straight point-to-point; conduction/chain effects
   (shock arcing between targets) have no jagged multi-segment form — BOLT is only a sprite.

## Scoped additions (4)

| # | Name | Frame family | Form | Implementation route |
|---|------|--------------|------|----------------------|
| G-1 | `sector` | new `sector` | Filled/edged ground arc: origin, axis, r0→r1, aperture angle, facing | New small pool (SectorPool) with an angular-clip ring shader variant — the one genuinely new mesh. This is the telegraph upgrade. |
| G-2 | `helix` | new `helix` | Particles laced on a rising spiral: radius, turns, height, life; also point-to-point variant | Emitter pattern over the existing particle pool (SPARK/EMBER frames) — no new mesh |
| G-3 | `vortex` | `helix` family, inward motion | Particles spiraling inward/downward to a point | Same emitter machinery as G-2 with inverted radial velocity — shares the family, separates on motion (in vs out), exactly how the language wants it |
| G-4 | `chain` | new `chain` | Jagged multi-segment path A→B with midpoint displacement, optional multi-hop through waypoints | Composes existing BeamPool segments (the latticeShell precedent) — no new mesh |

Deliberately NOT scoped: dome/shell (latticeShell already reads as one), pillar (tall beam
already reads as one), ribbon variants (Trails covers), anything needing a new shader beyond
the sector clip.

## Rules for the implementation

- New frame families registered in EFFECT-LANGUAGE.md §1.3 AND tools/bucket-effects.mjs's
  frame map, so the collision/degraded-point checks can speak about them from day one.
- No gameplay data references yet — which ability/item adopts which geometry is a design
  decision for the user. The geometries land as engine vocabulary plus showcase entries.
- Showcase: a demo entry per geometry (derived path), so Shift+F9 shows them for by-eye
  judgment. Surface count will rise 202 → 206; CLAUDE.md updated by the controller at merge.
- Colours in demos come from declared tables (the #160 lesson) — no raw hex in the new methods.
- Pools: SectorPool follows RingPool's shape (init in VFX constructor, `_roots`, update,
  dispose/resize registration). Emitters and chain are methods, not pools.
- Red-then-green per geometry; `npm test` + `bucket-effects --check` green.

Status: IMPLEMENTED-PENDING-REVIEW (this doc is the morning-review artifact; adoption into
gameplay data is the user's call).
