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

---

## 2026-08-01 — DO NOT BUY THE HDRI YET. Its premise is refuted.

The round-4 world critic (`reviews/round6/critic-r4-world.md`) refuted the stated
cause above for the specular half of axis 5. Verified independently in the source:

- `src/shaders/SkyShader.js:151-161` renders a **hard sun disc at 15× intensity**
  (`col += uSunColor * (disc * 15.0 + glow)`) plus a three-lobe scatter glow, and a
  warped-fbm cloud deck.
- `src/world/Environment.js:388` bakes the PMREM **from that scene, per stage**
  (`this._pmrem.fromScene(this._probeScene, 0.05, 1, 2000)`).

So the environment map is **not** a featureless gradient, and "no high-frequency
content in the environment to reflect" is not why specular response reads flat.
`07-interactables`' glitter field is that very sun disc reflected in the ladder's
lowest rung — the reflection mechanism demonstrably works.

**An HDRI bought on the old premise would be spending money to add something the
scene already has.** Someone must re-derive the specular defect from the shipped
pixels before this purchase is made.

**What still stands:** the *detail-starvation* half of axis 5 is real and is
genuinely an asset problem. The chest in `07-interactables` carries **67 unique luma
values over 117,000 px**. No shader term reaches that — it needs authored texel
variation. A small PBR set, not an HDRI, is the purchase with a measured defect
waiting for it.

### Adjudication: the two round-4 critics disagreed, and the synthesis is a code fix

The world critic said the environment is *not* featureless (true — 15× sun disc).
The character/enemies critic said the PMREM probe reflects a featureless analytic
gradient, so "roughness 0.12 and 0.90 are literally the same pixel" (also true).
Both are correct, and neither conclusion follows from the other. Verified in source
at `Environment.js:359-366`:

```js
this._probeScene = new THREE.Scene();
const probe = new THREE.Mesh(geo, mat);   // the sky sphere
this._probeScene.add(probe);              // ...and nothing else
```

**The probe scene contains exactly one mesh.** So the environment map holds one
high-frequency feature — the sun disc — and a smooth gradient everywhere else.
Roughness contrast therefore resolves *only* where the sun reflects (which is
precisely `07`'s glitter field on the ladder rung) and is invisible everywhere else.

**Conclusion: axis 5's specular half is a CODE problem, not an asset problem.** No
terrain, prop, or character ever appears in any reflection, because none of them are
in the probe scene. An HDRI would replace a one-feature sky with a many-feature sky
and still reflect **no scene geometry** — it cannot fix this.

The fix is to bake the probe from scene content rather than from a sky sphere alone.
Cost is bounded: `_bakeEnvironment` is already a per-stage-build cost, not per-frame,
called from `applyBiome` alongside a full terrain rebuild.

Both critics reached FAIL on axis 5 and both called it blocked. They were right that
it is blocked and wrong about what blocks it.

### THAT FIX LANDED THE SAME DAY. This section is history, not a work item.

**`b09c3d4` — "World: reflections finally contain the world", 2026-08-01.** `bakeProbe`
photographs `ctx.scene` from `Stage.build`; the one-mesh probe scene above is described
in the past tense at `src/world/Environment.js:524`. The code excerpt at lines 145-147
of this file is **pre-fix** and its line numbers no longer resolve.

This note exists because the omission cost real work. Issue #19 was written from the
unamended text above, quoted the pre-fix line numbers as a live defect, and an agent
was dispatched in 2026-08 to implement a fix that already existed. It found the staleness
only by enumerating the callers instead of trusting the framing.

**What was still broken, and was fixed in 2026-08:** the *realm* path. Realms are built
4 km out and never received a scene bake at all, and a realm **return trip** silently
stripped the standing overworld back to a sky-only probe. So the defect this section
describes was real in realms long after it was fixed in the overworld — which is why the
symptom kept being reported after `b09c3d4`.

Rule this earns: **when an adjudication in this file is acted on, amend the adjudication
to name the commit.** A refutation that does not record its own resolution reads as an
open work item forever.

---

## 2026-08-21 — THE PURCHASE LANDED. The set above is adopted; this file is now history.

Per this file's own rule, the resolution is recorded with its commit: **`eef20fe` merges the
photographed set as the shipping game.** Worn Rock Natural 01 (terrain), Corrugated Iron 03
(props), Mud Cracked Dry Riverbed 002 (Void overlay, no albedo — the tint mix owns colour),
and the Trembling Low Frequency Rumble under the void bed, all CC0, confirmed by the user on
the asset pages at download (2026-08-21), tracked at `public/game-assets/`, bound through
`src/world/Materials.js` via `src/world/PbrEval.js`, always-on with a procedural fallback.

Two statements above are therefore stale and stay only as history:

- *"Today the game has essentially zero asset payload"* — the shipped `dist/` now carries
  172.26 MiB of maps and audio, measured against `docs/art/asset-budget.json`'s ceilings
  (assets 200 MiB, shipped 205 MiB) by `tests/asset-budget.test.mjs`.
- *"A small PBR set, not an HDRI, is the purchase with a measured defect waiting for it"* —
  that purchase is the one that landed. The evaluation evidence lives in
  `reviews/asset-budget/` (branch-point perf baseline, matched-pair on/off, one-boot A/B
  capture manifest); the acceptance and its trail are on issue #109.

Still open from this file's plan: mesh kits (the #24/#26 fork) were never nominated and
remain undecided; HDRIs stay refuted per the 2026-08-01 adjudication above.
