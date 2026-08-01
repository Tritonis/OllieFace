# Sourcing art assets

Notes for future content rounds. Written 2026-08-01, after the round-5 critics
finally root-caused why axis 5 (material believability) had been stuck at 5/10
for five consecutive rounds.

Everything in this game is currently generated in code — hand-built geometry in
`world/Props.js`, `entities/EnemyMeshes.js`, `entities/CharacterMesh.js`, with no
texture maps. That has real virtues (zero asset payload, deterministic, tiny
repo) and one specific, measured cost, below.

## Two problems that sound alike but aren't

**Detail starvation** — what we have. The round-5 stages critic measured
**73–92% of every unbroken surface carrying no high-frequency detail at all**
(high-pass residual against each shot's own film-grain floor). The chest body
holds 8 distinct luma values across 2,025 px. The Drowned Aqueduct's *water*
holds 13 — flatter than the sky above it.

**Cohesion** — what asset packs can make *worse*. `RUBRIC.md` axis 10 penalises
"assets from visibly different styles/eras jammed together." Buying five packs is
the fastest way to score badly there. Detail and cohesion pull against each other;
the plan below buys detail without spending cohesion.

## Start here: HDRIs, not models

The single highest-leverage acquisition for this codebase is not geometry.

The round-5 critic found the roughness ladder in `world/Materials.js` is authored
correctly and **cannot express itself**, because the PMREM environment in
`world/Environment.js` is a featureless analytic gradient. Roughness 0.12 and
roughness 0.90 reflect the same constant, so the whole PBR ladder resolves to one
value. **Four rounds of tuning those numbers were wasted work** — a roughness
ladder is only visible when there is something structured to reflect.

One good HDRI fixes that for every surface in the game simultaneously, for a few
MB.

| Source | Licence shape | Notes |
|---|---|---|
| **Poly Haven** | CC0 | HDRIs **and** PBR texture sets. Best quality-per-effort available. Start here. |
| **ambientCG** | CC0 | Very broad PBR material library. |
| Adobe Substance 3D Assets | Subscription | Parametric — see below. |
| Textures.com | Tiered / credits | More restrictive terms; read them. |

**Substance Designer deserves special mention for this project.** Its materials
are *parametric*, so one palette and one roughness philosophy can drive an entire
library. That is the difference between "a defined feel" and "assorted purchased
rocks." It is the cohesion-preserving way to buy detail.

Second-order material work, once reflections carry information: surfaces need
high-frequency breakup (normal/roughness variation, procedural or textured) so a
flat-shaded polygon stops being 8 luma values.

## Models

| Source | Licence shape | Notes |
|---|---|---|
| **Synty Studios** | Commercial | Closest match to the RoR2 silhouette-forward low-poly look. Packs are large and *internally consistent* — that consistency is the actual product. |
| **Kenney** | CC0 | Excellent, free, smaller scope. |
| **Quaternius** | CC0 | Excellent, free. |
| KayKit | Mixed | Character/dungeon kits. |

Two practical caveats for this stack:

- These ship FBX / engine-oriented formats. three.js wants glTF/GLB — budget a
  conversion pass, and check that generated normals and material bindings survive it.
- **Verify licences per pack.** Some marketplace terms are written around a
  specific engine, and terms change. Do not trust a summary — including this one.

## Audio

- **Sonniss GDC bundles** — free, royalty-free, released annually, genuinely large.
- **Freesound** — mixed CC licences, check per file.

## The actual answer on "a defined feel"

Packs give you *detail*. They do not give you *direction*. What produces a defined
feel is a constraint enforced across everything, regardless of where it came from:

1. **One palette.** A fixed ramp with one accent. `world/Materials.js` already
   centralises this — keep all incoming assets flowing through it rather than
   shipping their authored materials.
2. **One shader treatment.** Run purchased assets through *our* material pipeline.
   This is the single thing that makes mixed sources cohere.
3. **One post stack.** Consistent grade / bloom / grain over everything.
4. **A silhouette rule.** RoR2's real identity is readable shapes. Round 5 scored
   axis 4 at **3/10** — RANGER and ANVIL thresholded to the same shape. No texture
   fixes that; only structural difference does.

The highest-value artefact to create is not a purchase at all — it is a **style
guide that new content is checked against before it lands**. `RUBRIC.md` grades
output after the fact; a style guide constrains input. The round-5 critics caught
a Unicode-dingbat icon set and an emoji-presentation difficulty icon that Windows
renders in colour, both of which a written input rule ("no text glyph is ever an
icon; all icons are drawn in `ui/Icons.js`") would have prevented outright.

## The tradeoff to go in with open eyes

Today the game has essentially zero asset payload. Textures and meshes bring real
download and VRAM budgets, and this project has already been through perf passes
(`combat-24` median sits in a 21–26 ms band; anything above that is a regression).

Recommended order: **HDRI first, then a small PBR set, then meshes** — increasing
cost, decreasing certainty of payoff. The HDRI is the one with a measured defect
waiting for it.
