# Petrichor — Content Expansion Design (Round 5)

Target: match current Risk of Rain 2 in *content breadth* at AAA quality, on top of
the existing 23.5k-LOC engine. Rounds 1–4 fixed the *look*; this round fills the
*game*.

## Current state (measured, 2026-08-01)

| Area | Have | RoR2 has | Gap |
|---|---|---|---|
| Survivors | 1 (hardcoded loadout in `Player.js`) | ~15 | no selection, no per-survivor mesh |
| Items | 37, tiers partial | ~150 across 6 tiers | no Equipment, no Lunar, no Void |
| Enemies | 6 + 2 bosses, 3 elite affixes | ~40 + 12 bosses | thin bestiary |
| Stages | 4 procedural biomes, one generator | 20+ authored | biomes are recolors |
| Meta progression | none | unlocks, logbook, stats | absent entirely |
| Artifacts / difficulty | none | 16 artifacts, 3 difficulties | absent entirely |

## Scope decisions (user-approved)

- **3 new survivors** (4 total), each with 4 unique abilities, unique mesh, own VFX language.
- **Item tiers + Equipment**, **meta progression**, **artifacts + difficulty**, **enemies + bosses** — all four.
- **Hand-authored biome identity**: per-biome generator rules, props, landmarks, skybox.

## Architecture

Everything obeys `CONTRACTS.md`: systems are classes with `init(ctx)` + update hooks,
no cross-system imports, all randomness through `ctx.rng` (cosmetic through `ctx.fxRng`),
all state changes gated on `ctx.authority`.

### New data modules
- `src/data/survivors.js` — survivor cards: id, name, base stats, 4 ability ids, mesh builder key, unlock condition.
- `src/data/equipment.js` — active Q-slot equipment cards.
- `src/data/artifacts.js` — artifact cards + their hooks.
- `src/data/challenges.js` — unlock conditions, evaluated against run + profile stats.

### New systems
- `src/systems/Profile.js` — persistent player profile (localStorage): unlocks, challenge progress, run history, aggregate stats. Owns all persistence; nothing else touches localStorage for meta.
- `src/systems/Artifacts.js` — reads active artifact set, exposes query methods (`ctx.artifacts.has('command')`) that Director/Items/Stage consult. Artifacts never reach into other systems; other systems ask.

### Extended
- `Player.js` — loadout becomes survivor-driven, not hardcoded.
- `Items.js` — equipment slot, use/cooldown, Lunar tier, tier-weighted drop tables.
- `Director.js` — larger spawn pool, elite affix tiers, boss selection.
- `Stage.js` / `Materials.js` / `Props.js` / `TerrainGen.js` — per-biome authored rules.
- `Menus.js` — survivor select, difficulty select, artifact select, logbook.
- `HUD.js` — equipment slot, survivor-specific skill icons.

## File ownership (prevents subagent write conflicts)

Wave A agents own disjoint file sets and **must not** touch `Menus.js` or `HUD.js`;
they expose data + a documented API instead, and Wave B integrates the UI.

| Agent | Owns |
|---|---|
| A1 Survivors | `data/survivors.js`, `data/abilities.js`, `entities/CharacterMesh.js`, `entities/Player.js` |
| A2 Items | `data/items.js`, `data/equipment.js`, `systems/Items.js`, `ui/Icons.js` |
| A3 Enemies | `data/enemies.js`, `entities/Enemy.js`, `entities/EnemyMeshes.js`, `systems/Director.js` |
| A4 Stages | `world/*` |
| B1 Meta | `systems/Profile.js`, `data/challenges.js`, `systems/Progression.js` |
| B2 Artifacts | `systems/Artifacts.js`, `data/artifacts.js` |
| B3 UI | `ui/Menus.js`, `ui/HUD.js`, `ui/hud.css`, `ui/Logbook.js` |

`core/Engine.js` and `core/Harness.js` are shared: agents append their own registration
/ scenario and must not reformat surrounding code.

## Quality gate

Every agent's work is judged by a **separate harsh critic subagent** against `RUBRIC.md`
(pass = 7+ on every axis, none below 6) using real screenshots from
`node tools/capture.mjs`. Critic default answer is FAIL. Max 4 critic rounds per
subsystem per the rubric's stopping condition; after round 4, report honestly which
axes still fall short.

New harness scenarios are required so new content is actually photographed —
content that never appears in a shot cannot be graded.
