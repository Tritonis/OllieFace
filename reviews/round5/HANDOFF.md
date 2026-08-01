# Round 5 handoff — 2026-08-01

Written at a usage-limit boundary. This is the state of play and what to do next.

## Where the code is

| Commit | What |
|---|---|
| `4ec7258` | Content expansion design spec |
| `4e746e3` | **Wave A** — survivors, items, enemies, stages, meta (+14,353 lines) |
| `f9d85cf` | **Wave B** — artifacts, difficulty, UI integration (+4,749 lines) |
| `f88a09b` | `ART-ASSETS.md` sourcing notes |
| `5618f22` | **WIP** — five fix agents mid-run (+2,319 lines). Build green, **visuals unverified** |

`5618f22` is a safety snapshot taken while agents were still writing. It compiles,
but nothing in it has been visually verified. Do not treat it as good.

## What shipped and is verified

Verified by me on the merged tree, not taken from agent reports: `npm run build`
clean, 20/20 shots captured with zero per-shot frame errors, no perf regression
against a properly measured baseline, world-gen determinism proven by sha1 over
baked grid + instance matrices + colliders + landmarks.

| | Before round 5 | After |
|---|---|---|
| Survivors | 1 hardcoded | 4 selectable, 16 abilities, own rigs |
| Items | 37 | 83 across 5 tiers + 12 equipment actives |
| Enemies | 6 + 2 bosses | 16 + 6 multi-phase bosses |
| Elite affixes | 3 | 5 across 2 unlock tiers |
| Biomes | 4 recolors | 4 authored generators + 12 landmarks |
| Artifacts / difficulty | none | 7 artifacts, 3 difficulties |
| Meta progression | none | profile, challenges, logbook, run history |
| Harness shots | 8 | 20 |

Measured wins worth protecting: biomes sit 1.36–1.74 hue-distance apart out of 2.0
(they genuinely are four places); the HUD held with 5 of 6 round-4 defects fixed
and measured (`.money` contrast 1.94:1 → 11.07:1); the equipment slot works.

## The critic loop — round 1 of a max 4 (RUBRIC.md caps it)

All four critics returned **FAIL**. Reports in `reviews/round5/critic-r1-*.md`.

| Domain | Mean range | Headline |
|---|---|---|
| Character | 3.5–4.9 | axis 4 = **3/10**; RANGER and ANVIL are one silhouette |
| Enemies | 3.7–4.7 | 2 shots contain no subject; ~3 of 16 survive a threshold |
| Stages | 4.8–6.3 | materials root-caused at last; `02-vista` regressed 6.6 → 4.8 |
| UI/VFX | 4.6–5.9 | icons in OS symbol font; explosion has 1 of 4 layers |

### The three findings that actually matter

1. **The instrument was lying.** `04-combat.png` contained **zero enemies** and
   `05-boss.png` rendered a boss health bar over an empty forest — while
   `manifest.json` reported `ready: true, errorCount: 0`. **Five agents cited that
   manifest as proof their work was verified.** I confirmed both by eye.
2. **Axis 5 (materials), stuck at 5/10 for five rounds, finally has a root cause.**
   The roughness ladder in `world/Materials.js:490-514` is authored correctly and
   *cannot express itself*, because the PMREM in `world/Environment.js:324-332` is
   a featureless analytic gradient — roughness 0.12 and 0.90 reflect the same
   constant. **Four rounds of tuning those numbers was wasted work.** Measured:
   73–92% of every unbroken surface carries no high-frequency detail.
3. **Possible gameplay bug, not just a screenshot bug.** In the empty combat frame
   the tracer terminates mid-air on an entity that is not drawn — enemies are
   solid to hitscan but their meshes do not render. If that reproduces outside the
   harness, enemies can be invisible in a real game. **Unresolved — check this
   first.**

## UPDATE — after the session limit hit

All four fix agents were **killed mid-edit** by the usage limit. None wrote its
`FIX-*.md` report. Partial work recovered and committed; build green.

**The critical bug is fixed and I verified it by eye, not by manifest:**

- `tools/capture.mjs` now emits a `subjectFailures` key (currently `[]`).
- `Harness.js` now has `visibleFraction()`, which samples the subject's whole
  projected box instead of one centre ray, plus foreground-occluder rejection.
- **`04-combat.png` now contains a full enemy field** (mechs, flyers, a red heavy,
  teal and tan types) — previously zero enemies.
- **`05-boss.png` now contains the Stone Titan**, in frame centre taking 113
  damage — previously a boss health bar over empty forest.
- Lighting/materials also leapt: sunset sky with real gradient, warm/cool contrast,
  genuine fog depth separation. Shader programs 63 → 68, consistent with the PMREM
  work landing.

**Caveats — do not read this as "done":**

- ~~No root cause is documented.~~ **RESOLVED** — see `DIAG-invisible-enemies.md`.
  Verdict **(A): harness framing, no rendering bug.** 22 of 24 enemies were
  LOS-blocked by terrain 4–12 m in front of a lens 14–40 m away; the survivor stood
  on a plateau edge (16.04 m) while `spawnRing` dropped the ring down the cliff
  (−8.93 m). (B) was ruled out affirmatively by 190 isolated draw measurements
  across recycled rigs, affix re-dressing and 6 spawn/kill/respawn cycles: zero
  zero-pixel live enemies. The critic's "tracer terminates on an undrawn entity"
  was a **wrong inference** — the trail is depth-tested and ends on the near slope.

- **NEW, HIGH PRIORITY — a trap, not just a defect.** `VFX.deathDissolve` never
  fires for monsters (`resolveObject`, `VFX.js:1424`, does not know about
  `Enemy.rig.root`; measured `_dissolving.length === 0` after a real kill), so
  monsters just vanish. **Do not apply the obvious one-line fix.** `VFX.js:1269`
  sets `d.mesh.visible = false` on a rig `Director.clear()` may already have
  recycled onto a *live* enemy — that would create genuine invisible-but-alive
  enemies in gameplay. Add a visibility sibling/generation guard first, mirroring
  the material guard at `DissolveShader.js:200-204`, then wire `resolveObject`.
- The boss still does not read at 3× enemy scale, and trunks still partly occlude
  it in `05-boss`. The critic's measured 1.52× finding likely still stands.
- Foreground values are still crushed in places.
- The stages/character/UI fixes are all **partial** — mid-edit snapshots.
- One correction the UI agent found before dying, worth keeping: the artifact-card
  title stagger is **not** the font-fallback cause the critic diagnosed — the card
  is a `<button>`, whose content Chrome centres vertically. Fix the element, not
  the font.

## In flight when the session ended (state unknown)

Five agents were running. Their partial work is in `5618f22`. **Assume none
finished; re-verify rather than trusting the diff.** Expected report files, which
tell you whether each got there:

- `reviews/round5/FIX-harness.md` — subject-presence assertion + the render bug
- `reviews/round5/FIX-character.md` — silhouette collapse, terrain merge, stat bars
- `reviews/round5/FIX-stages.md` — PMREM, `02-vista` regression, teleporter beam
- `reviews/round5/FIX-ui-vfx.md` — icons, explosion layers, icon collision floor

If a file is absent, that agent did not finish; re-dispatch from the matching
`critic-r1-*.md` defect list.

**Already confirmed done inside the WIP commit:** the artifact/difficulty icons are
fixed — 10 raw Unicode literals became 10 `mark:` keys against 11 drawn glyphs in
`ui/Icons.js` (`markIcon` at :706 returns null on unknown key so callers fall back).

## Next actions, in order

1. **Re-run `node tools/capture.mjs` and LOOK at the PNGs.** Do not trust
   `errorCount: 0` — that is the exact failure this round exposed. Confirm
   `04-combat` has enemies and `05-boss` has a boss.
2. **Resolve finding 3**: is the invisible-enemy bug a harness artifact or a real
   rendering bug? This gates everything else.
3. Read whichever `FIX-*.md` exist; re-dispatch the missing ones.
4. **Round 2 critics** on the same four domains. Rubric caps at 4 rounds — after
   that, report honestly which axes still fall short rather than looping.
5. Close the integration debts — full `file:line` map is in task #5, already
   scouted.

## Known debts (mapped, not fixed)

- Equipment barrel is an interim `stageStart` seed at `systems/Items.js:150-164`;
  real interactable goes alongside `world/Interactables.js:165` (base), `:1019` (spawn loop).
- Co-op: client equipment press has no BTN bit. `net/Protocol.js:36-44`, bits 0–6
  used, 7–31 free. Pack `NetClient.js:148-164`, unpack `NetHost.js:115-128`.
- `PROTOCOL_VERSION` went 1→2; **no live two-peer co-op test has ever been run.**
- Rook's deployables are not `ctx.combat`-registered → invulnerable, absent from
  the snapshot. Non-scoring damageable must bypass `Combat.js:432-458`.
- `UNLOCK_BINDINGS` in `data/challenges.js` has 7 artifact bindings; survivor/item/
  enemy ids still unbound.
- Artifact of Command has no chooser UI (`Artifacts.js:310` hook is live).
- Honour does not force affixes on bosses (bosses *do* roll them at a 60% cap —
  smaller defect than first recorded).
- `survivorChanged` (`Player.js:299` → `HUD.js:170`) undocumented in `CONTRACTS.md`.

## Process notes that earned their keep

- **Disjoint file ownership** is what let 5–6 agents run concurrently without
  clobbering. Keep enforcing it; publish API contracts up front so parallel agents
  can build against each other.
- **Critics must be read-only and separate from fixers.** They cost 5–15× less than
  executors and found every defect above. Four critics = $24 and caught what $186
  of content agents shipped and declared verified.
- **Make critics measure, not describe.** Four rounds of adjectives never moved
  axis 5; one round of pixel measurement root-caused it.
- **Scout informs, never verifies.** The haiku scout returned two findings that
  were wrong-or-stale; validating them cost little and would have misled an agent
  otherwise.
