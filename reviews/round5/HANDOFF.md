# Petrichor — Round 5 handoff

Written 2026-08-01 at a usage-limit boundary (resets 5:30pm America/Chicago).
Supersedes the earlier version of this file. Read this first on resume.

## Read these, in order

1. This file.
2. `RUBRIC.md` — the visual bar and the **4-round-per-subsystem stopping condition**.
3. `CONTRACTS.md` — binding system/ctx/event contracts. `NETCODE.md` for authority.
4. `ART-ASSETS.md` — sourcing notes; explains why axis 5 stalled for six rounds.
5. The round-3 critiques (below) before touching anything visual.

## Where the code is

`f9b47c4` is HEAD, build **green**, tree **clean**.

| Commit | What |
|---|---|
| `4e746e3` | Wave A — survivors, items, enemies, stages, meta (+14,353) |
| `f9d85cf` | Wave B — artifacts, difficulty, UI (+4,749) |
| `619e417` | F2 — affix silhouettes, inventory, distortion |
| `811fbef` | C1 — hidden realms, final boss, endings |
| `2a782a0` | F1+F3 — harness determinism, legibility gate, material identity |
| `f9b47c4` | "in progress" — partial round-4 work from four agents killed mid-edit |

## Content shipped

4 survivors (16 abilities) · 83 items + 12 equipment across 5 tiers · 16 enemies +
7 bosses · 5 elite affixes in 2 tiers · 4 authored biomes + 3 hidden realms + a
final stage · 7 artifacts · 3 difficulties · 2 endings · meta-progression with
challenges, logbook and run history · 30 harness shots across two capture tools.

## THE IMPORTANT PART: `errorCount: 4` is correct, not a regression

`node tools/capture.mjs` currently reports `errorCount: 4`, `subjectsOk: false`.
**Do not "fix" this by loosening thresholds.** A stricter per-object gate landed in
`f9b47c4` and is correctly surfacing defects that were always there:

| shot | failing subject | evidence |
|---|---|---|
| `04-combat` | horde | **18/24 objects** — six render zero pixels |
| `08-explosion` | monsters, damage numbers | 6/7 objects |
| `09-survivors` | the four survivors | sepP50 0.41 vs 4/4 objects |
| `11-bestiary` | spawn roster | sepP50 0.4 |

The `04-combat` 18/24 exactly matches the "six zeros of 24" a critic measured by
hand. The gate is working.

## Two harness bugs of the same shape — this is the round's core lesson

Round 5 opened with `04-combat.png` containing **zero enemies** and `05-boss.png`
showing a boss health bar over an empty forest, while `manifest.json` reported
`ready: true, errorCount: 0`. **Five agents cited that manifest as proof their work
was verified.** Both were fixed. Then the *replacement* gate was found to certify a
three-object subject where one object rendered zero pixels, because it tested the
**sum** and the **union** rather than each object.

Same shape both times: **an aggregate hiding an absence.** Assume it recurs. When
adding any check, ask what a zero inside it would look like.

## The harness was never deterministic — now it is

Root cause (`FIX-harness2.md` §2): `Engine._frame` took its delta from the wall
clock and fed it to every `update()` (where all VFX age), while `ctx.time` advanced
in a fixed step **scaled by hitstop 0.15**. Shutters budgeted in simulation seconds
photographed effects at a load-dependent age.

Measured before: **0 of 21 PNGs byte-identical** across same-seed runs; the
inventory blast swung 26,130 px → 1,523 px (−94%).

Fixed by `pinClock(1/60)` + `waitFx()` in presentation seconds. **I verified
independently: 14 of 16 pixel subjects are now bit-identical**, the two that drift
move 0.12–0.22%. PNGs are still not byte-identical (grain, GPU float) — that was
never the claim.

**Consequence: every measurement taken before `2a782a0` was one draw from a
distribution.** Round-1 and round-2 numbers are estimates.

## Critic scores (bar: 7+ on every axis, none below 6)

All rounds FAIL. Round 3 per-shot means:

| Domain | r1 → r2 → r3 |
|---|---|
| Character/enemies | `11-bestiary` 4.7→5.6 · `09-survivors` 5.1→5.4 · `03-thirdperson` 5.3→5.4 · `04-combat` 5.0→4.5 · `05-boss` 3.8→4.0 |
| Stages | build mean 5.7 → **5.6** |
| UI/VFX | `10-inventory` stuck 4.2 (worst all 3 rounds) · `08-explosion` 5.7→**5.3** · `17-artifacts` 4.6→5.8 |
| Realms | **4.5** (first critique) |

**Axis 4 (silhouette) cleared 7 for the first time in the project**, on three shots.
It opened round 1 at 3/10, the worst in the build. **Axes 2 and 5 are flat for three
rounds; axis 1 tops out at 5.** Per the rubric's stopping condition, those get an
honest report, not another grinding round.

## Fix claims that did NOT survive independent measurement

Five this round. Not dishonesty — each measured a *different artifact* than ships.
See memory `name-the-baseline-capture`.

- `10-inventory` 165.4 → 116.4: **the 165.4 baseline is not reproducible on any
  capture on disk.** Real delta −5.1 L. Shipped frame reads 132.3 — brighter than
  anything measured. Regression is real and open.
- `08` "centre out of the sky": clears its own bound by 0.001. "Away from the sun":
  he sits on the brightest sky quadrant by 4×.
- Distortion: verifies on `vfxprobe` **to a single pixel**, but the probe
  photographs a frame that no longer ships.
- `glacial` 40.5% → 4.4%: **unverifiable — the subject renders zero pixels.**
- ROOK leg-runs 1.31 → 2.00: shipped pixels read 1.03 (offline rig only). *Later
  refuted in the other direction — round 3 confirmed the legs ARE fixed.*
- Monolith specular 0.149: measured 0.111.

## Critics correcting themselves (the loop working)

- Round-2 stages **retracted its own materials root cause**: "one texture at a fixed
  7–13px screen-space period" was an artefact of its own 15-tap filter bandwidth.
  World-locking is verified. It also withdrew its own ≥4× HF-sd criterion as
  confounded by a 9.7× within-material shading spread.
- Round-2 enemies **rebuilt and calibrated** its silhouette instrument (disc-vs-square
  0.777) and refuted three round-1 claims. Round 1's own IoU was garbage.
- Round-3 UI/VFX **withdrew its own round-2 withdrawal** on chromatic aberration —
  it had cleared it by sampling a HUD chamfer composited after post.
- The realms critic withdrew four findings it couldn't reproduce.

## Work in flight when the limit hit (all four killed mid-edit)

Partial work is in `f9b47c4`. **No `FIX-*` report was written for any of them —
re-verify, don't trust the diff.** Their last words:

- **Harness per-object gate** — "verify the difficulty PNG now matches the
  assertion". Gate landed and works. Also fixing `18-difficulty`, which asserts
  `monsoon` and photographs `rainstorm` (`Harness.js:3218` restores the previous
  rung before the shutter).
- **Stages r4** — "The gates barely moved the needle. I need to isolate whether the
  detail pass is actually the salt source." Target: detail-pass **aliasing**
  (isolated-bright fraction rose at identical bearings in all six shots, worst on the
  most distant surfaces, b1 far mountain 5.3×). `Materials.js:403` gates only
  `uDetA.y`; the ridge octave and analytic `detJoint` have no distance/filter-width
  term.
- **VFX r4** — "cap the blast light at `08-explosion`'s own values so only the nuke
  moves." Targets: `08` blast is edgeless clipped white (core R clipped on 100% of
  pixels, max radial gradient 6.6 L); frame-wide radial chromatic aberration 4–6px,
  10px peak.
- **Realms identity** — blocked on another agent re-breaking `ParticleShader.js`
  (now fine). Targets below.

## Realms: the biggest open content gap

Critic verdict: *"structurally a destination, visually three more stages and one real
place."* Mean 4.5.

- Three realms sit **12.5 dE76** apart; the four ordinary biomes sit **28.5** apart.
  Each realm is closer to biome 4 (8.8–9.8) than any two biomes are to each other.
- **The safe hub and the kill-pit are photometrically identical** — meanL 52.5 vs
  52.4, and the pit is *brighter* at the median. "Safe" is carried by a HUD string.
- Victory / obliterate / `YOU DIED` headlines are **identical within 0.5/255**.
- Rift Anchors colour-match the floor (245.9°), not the Herald (294.3°) they ward.
- The Fracture *does* commit (62.3 dE from base) — use it as the reference for how
  far to push the other three.

## Next actions, in order

1. Re-dispatch the four killed agents from their briefs above. Tell each to **assess
   what already landed first** — that instruction saved a full redo last time.
2. Fix the 4 failing shots properly (framing/content), **never by loosening the gate**.
3. Round-4 critics — the last scheduled round for character/enemies, stages, UI/VFX.
4. Then report honestly which axes still fall short. Axes 1, 2, 5 are the likely
   permanent shortfalls.
5. Content depth still queued: more survivors, a void/corruption item tier, shrine
   variety, Command chooser UI.

## Standing hazards

- **`npm install` breaks this repo.** npm 6.13.6 is on PATH with node v24; it
  downgrades `lockfileVersion` 3→1 and destroys the rolldown native binding. It has
  broken the build twice. Recover with
  `npx -y --package=npm@11 -- npm install`.
- **The `deathDissolve` trap.** `VFX.js:1424`'s `resolveObject` doesn't know about
  `Enemy.rig.root`, so monsters never dissolve. The obvious one-line fix **arms a
  real invisible-enemy bug**: `VFX.js:1269` sets `visible = false` on a rig
  `Director.clear()` may have recycled onto a live enemy. Add a visibility sibling
  guard first, mirroring `DissolveShader.js:200-204`. See `DIAG-invisible-enemies.md` §5.
- **No two-peer co-op test has ever been run** under `PROTOCOL_VERSION` 2.
- `archGeo` shifted the shared RNG stream — golden hashes need re-baselining.
- Branding: ~40 item/enemy/stage names are verbatim RoR2, incl. **"Hopoo Feather"**
  (the actual developer's name). See the branding analysis in task #5 notes.

## Open debts

Full `file:line` map is in the task list (task #5, scouted). Headlines: equipment
barrel is still an interim `stageStart` seed; a co-op client's equipment press has no
BTN bit; Rook's deployables aren't `ctx.combat`-registered; `UNLOCK_BINDINGS` unbound
for survivor/item/enemy ids; Artifact of Command has no chooser UI; boss scale 2.29×
against a 3× target.
