# Art: the code half of detail and cohesion

The *Art: detail and cohesion* milestone has two halves. The search half produced five CC0
shortlists plus a commercial shortlist (#66) and is now waiting on a human decision (#26, #27).
The **code half** is not waiting on anything, and this plan executes it.

`ART-ASSETS.md`'s 2026-08-01 addendum overturns its own top half. Two of the four tasks here exist
because that adjudication refuted an asset purchase and named a code defect in its place. Read the
addendum before acting on anything above it.

## Spec

The issues are the spec. Each task's acceptance criteria are the issue's own, verbatim:
**#19**, **#60**, **#20**, **#59**. Where this plan and an issue disagree, the issue governs.

## Global Constraints

- `npm test` green (63/63 test files at plan authoring time) and `npm run gate:sp` "no fields
  moved" before any task is considered complete.
- **All gates bind hardcoded port 5209** (`tests/sp-equivalence.mjs:190`, no override) and
  **cannot run concurrently — including across worktrees.** Check `netstat -ano | findstr 5209`
  before starting one; on a connection failure, wait and retry rather than reporting a code
  failure. `tools/menuprobe.mjs` and `tools/voidprobe.mjs` collide on the same port.
- Capture evidence follows the `capture-gates` conventions. **The harness is not bit-exact** —
  sub-percent pixel deltas are run noise, and the shutter phase drifts across boots. Never assert
  a before/after number without naming the on-disk file it came from.
- Each task runs in its own git worktree and is merged by the controller only after gates, tests,
  and an adversarial review pass. Implementers never push and never merge.
- ASCII in user-facing strings. **Never write a backtick into a prose comment that lands inside a
  JS template literal** — shader sources are template literals, and a backticked path in a
  `/* glsl */` block closes the string and breaks the module far from the edited line.
- Out of scope for every task: `tools/`, `desktop/`, `docs/STEAM.md`, `package.json`, `src/net/`.

## Task 1 — #19: bake the PMREM probe from scene content

`src/world/Environment.js:359-366` builds `_probeScene` containing exactly one mesh, the sky
sphere. So the environment map holds one high-frequency feature (the sun disc at 15x intensity,
`SkyShader.js:151-161`) and a smooth gradient everywhere else. Roughness 0.12 and 0.90 resolve to
the same pixel except where the sun reflects. No terrain, prop, or character appears in any
reflection because none are in the probe scene.

**This is why an HDRI was refuted.** An HDRI replaces a one-feature sky with a many-feature sky
and still reflects no scene geometry. Four rounds of roughness-ladder tuning were spent on the
wrong cause.

Bake the probe from scene content instead. `_bakeEnvironment` is a per-stage-build cost called
from `applyBiome` alongside a full terrain rebuild, so the budget is bounded and already understood.

**Acceptance:** the `world/Materials.js` roughness ladder shows visibly different specular
response between its low and high ends **away from the sun's reflection**, with named on-disk
capture evidence. Gates green.

## Task 2 — #60: the void tint needs the fade its detail map already has

The near-field detail map retires with distance (`uv: 0.5`, `uvFade: [20, 60]` in
`src/world/Materials.js`), deliberately — `Materials.js:256-263` documents feature scale as
material identity, and an unfaded near-field map aliases into noise at distance. `BM_TINT` and
`BM_VEIN` (`src/shaders/BlightMask.js`) have no fade, so a Void mask bound as a near-field UV map
would be structured up close and a flat violet wash past 60 m. That inverts style-guide rule 2: a
blighted object should read as *the ochre object with the void's claim over it*, not a violet
silhouette with no claim visible.

**Ruling (controller, 2026-08-15): take route 2 — sample the mask triplanar in metres.**
The issue offers two routes and calls it the author's call; the author is away and asked for
autonomous progress. Route 2 is the more general fix: the mask carries its own world-space scale
and is immune to UV fade entirely, and it decouples the mask from UV authoring at a moment when
#59's loader seam does not exist and we do not know what UVs purchased meshes will arrive with.
Route 1 (drive the emissive `vein` term) is cheaper and stays inside the blight shader, but it
solves a *structure* problem by moving structure into a brightness channel, constraining the Void
to whatever reads as glow. All four candidates in #23's shortlist ship height/displacement, so
either route is supportable by the assets.
**Cost if wrong:** route 2 is the more invasive of the two; reverting to route 1 means discarding
the triplanar sampling and re-authoring the vein term. Reversible, one task's work.

**Acceptance:** blight reads as structure over the base material at both near and far distance,
with named capture evidence at both. Gates green.

## Task 3 — #20: silhouette differentiation

`RUBRIC.md` axis 4 scored **3/10**: RANGER and ANVIL threshold to the same shape. Not
purchasable — *"No texture fixes that; only structural difference does."*

Structural geometry differentiation in `src/entities/CharacterMesh.js`, and `EnemyMeshes.js`
where the same collapse occurs between species.

**Enumerate the full cast before changing any of it.** A fix that separates RANGER from ANVIL
while leaving a third pair collapsed passes a RANGER-vs-ANVIL check and still ships axis 4 red.
This repo has been bitten by exactly that completeness trap.

**Acceptance:** a silhouette-mask comparison across **every** playable character and enemy
species, not just the named pair, with the on-disk captures named. The rule written into
`docs/ART-STYLE-GUIDE.md` so new content is checked before it lands rather than graded after.
Gates green.

## Task 4 — #59: the loader and pipeline seam

No loader or pipeline seam exists for externally-authored meshes. `model-kits.md` costs this at
**2-4 days, unbudgeted**, and it is required whether the project adopts free CC0 kits or a paid
pack — which is why it is sequenced here rather than behind the #66 purchase decision.

Runs **after** Task 2, which also touches the material path.

**Acceptance:** per the issue. Gates green.

## Sequencing

Tasks 1 and 3 are disjoint (`Environment.js` vs `CharacterMesh.js`/`EnemyMeshes.js`) and may run
in parallel worktrees. Task 2 touches `BlightMask.js` and `Materials.js`; Task 4 touches the
material path and follows Task 2. Gate serialisation on port 5209 is the real throughput limit,
not task independence.
