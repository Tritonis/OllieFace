# Petrichor — Round 6 handoff and the honest per-axis report

Written 2026-08-01. Supersedes `reviews/round5/HANDOFF.md`. Read this first on resume.

HEAD `83d76eb` · build **green** · tree clean · **2 failing shots**, down from 4.
Shipping capture: `reviews/round6/SHIP/manifest.json` (seed 1337, `clockPinned: true`).

## The verdict, up front

**All three subsystems FAIL. All four critic rounds are spent.** Per `RUBRIC.md`'s
stopping condition there is no round 5 for character/enemies, world, or UI/VFX.

No axis clears 7 as a domain mean anywhere in the build. Nearest misses:

| axis | best | status |
|---|---|---|
| **4 silhouette** | clears **7 on four of six** character shots (`09-survivors` scores **8**) | **the project's one real visual win** — it opened at 3/10, worst in the build |
| **7 UI craft** | clears build-wide in the world domain; 6.8 char-domain mean, 5 of 6 shots | closest to a genuine pass |
| 10 cohesion | 6.5 char domain, four of eight UI shots | close |
| 3 colour | 5.7 char domain | code |
| 8 readability | 5.5 char domain | code |
| 6 VFX | 5.0 | code, premise re-diagnosed (below) |
| 1 lighting | 4.7 char, max 5 UI, 3 on `07` | code — and it is *one* fix |
| 9 post | 4.7 | code |
| 2 composition | 4.8, max 5 UI | mixed |
| **5 material** | **3.8 — worst in the build** | half code (now fixed), half asset |

Build means: world **5.5**, char/enemies **5.4**, UI/VFX **5.4**.

## The single most important correction: the residual is mostly CODE, not assets

The round-5 handoff predicted axes 1, 2 and 5 were permanent asset shortfalls. **That
was wrong, and two independent critics plus a source adjudication overturned it.**

**Axis 5 was never primarily an asset problem.** Two round-4 critics disagreed and both
were right about what they looked at — the world critic proved the sky is *not*
featureless (`SkyShader.js:151`, hard sun disc at 15× plus three-lobe glow), and the
character critic proved roughness 0.12 and 0.90 resolve to the same pixel. The
reconciliation was in `Environment.js`: **`_probeScene` held exactly one mesh**, the sky
dome. One high-frequency feature, smooth gradient in every other direction. No terrain,
prop or character had ever appeared in any reflection in this project's history.

Fixed in `b09c3d4` — `bakeProbe` now photographs the real scene, energy-neutral at
ratio 1.001. **An HDRI would not have fixed this** and `ART-ASSETS.md` now says so:
it swaps a one-feature sky for a many-feature sky and still reflects no geometry.

**What is genuinely an asset problem, and only this:** detail starvation. The chest in
`07-interactables` carries **67 unique luma values over 117,000 px**. No shader term
reaches that. The purchase with a measured defect waiting for it is a **small PBR set,
not an HDRI**.

**Axis 1 is one fix, not a class of problem.** `02-vista`'s right cliff is 216,000 px
at five luma of range, and it is simply unlit — key 0, bounce 0, rim 0, proven by PEAK
and Nyquist energy being unchanged from the pre-fix arm. It is now 10 luma; verify
wants 15. **The rim can never close it** — that wall sits 87° off the key and 93° off
the rim, *both at their terminators*; a 2.55× rim raise bought 2 luma. A third azimuth
at 14.5% of key is what worked, and it saturates. The last 5 luma is macro relief in
`TerrainGen.js`, which re-frames every world shot and needs its own baseline.

## The round's core lesson, and it is not the one round 5 predicted

Round 5 said: *an aggregate hiding an absence; assume it recurs.* It recurred **five
times**. But the deeper problem is one round 5 never named:

> **Instruments in this project fail about as often as the code they measure.**

**Three measuring instruments were refuted this round**, each by a later agent:
- The VFX agent's **per-ray gradient median** — plain scenery in `06-loaded-hud` scores
  113.3 where `08-explosion`'s blast scores 54.0. It ranks empty terrain above the
  explosion it was built to measure. Its 21.5 → 46.2 → 57.4 claim is **withdrawn**.
- Its **`y ∈ [90,470]` "3D-only" band** does not exclude the inventory strip — ~9,000
  HUD tile edges went into a band chosen specifically to avoid that exact error.
- The world critic's **`w4frame.mjs` framing check** uses block-mean luma and cannot
  separate an exposure change from a re-framing; it flagged three shots whose cameras
  provably did not move. **I relayed that bad warning to an implementer; it is
  withdrawn.**

The agents whose numbers survived are exactly the ones that **calibrated against a
known input before measuring** — the stages agent, the world critic (PEAK calibrates to
0.000% on resolved 2×2 and 3×3 relief), the VFX agent's `vfxmeasure.mjs` (reproduces
the round-3 critic's published numbers to the digit), and the UI implementer (its
instrument reads 0.755× the critic's dilation and reproduces its 7-run/62-component
counts exactly). **Calibration is not optional here. Make it a standing requirement.**

## The five aggregates hiding absences

1. `errorCount: 0` certifying two subjectless shots *(round 5, fixed)*.
2. Sum/union certifying a subject with a zero-pixel object *(round 5, fixed)*.
3. **`tools/capture-realms.mjs` never pinned its clock** while its own comment claimed
   it pinned "exactly as `capture.mjs` does", and the manifest recorded no pinning
   state — so `pinClock` doing nothing was indistinguishable from it working. Fixed;
   **every realms colour number in this repo predates the fix.**
4. **`08-explosion`'s blast gate measured one corner of the frame** for five consecutive
   captures, returning a bit-identical block. Soft particles fade against scene depth at
   `gl_FragCoord.xy / uResolution` where `uResolution` is the 1600×900 drawing buffer,
   but `subjectReport` renders masks into **480×270** — every fragment landed in the
   bottom-left 30%×30% and was discarded. Fixed in `db8eb0f`: 640 px → 22,332 px.
   **Consequence: every soft-particle pixel number ever taken through `subjectReport`
   understated by ~4×, and ~30× on `08-explosion`.** `10-inventory`'s equipment blast
   was *passing on the broken measurement*.
5. **`04-combat`'s `contrast` field was computed, written to the manifest, and never
   gated on** — the survivor fell 0.442 → 0.088 with the gate reporting fine. Closed
   with `gatedOn`/`notGated` markers on every pixel check, so no critic can again quote
   a number no gate consulted. *(My proposed 0.15 contrast floor was refuted: it would
   newly fail two passing shots to catch one.)*

## The shared RNG stream is a repeat offender — treat it as a standing hazard

Three displacements this round: `archGeo` (inherited), a shrine implementation that
broke three unrelated shots by taking one draw per shrine, and a numeral gate that
changed `fxRng` draw counts and re-jittered every particle (blast 21,486 → 56,735 px).

**The rule, derived by the last agent: a draw from a shared stream must never sit
downstream of a decision you intend to change.**

## What shipped this round

`2c30b46` six agents' fixes · `c315928` branding · `1541fc9` audit fixes ·
`db8eb0f` harness depth fix · `b09c3d4` world/PMREM · `b5dff68`+`7ea873b` UI.

- **Shots 4 → 2 failing.** `09-survivors` passes (perPx floor cleared by 24%);
  `08-explosion` fully passes; `06-loaded-hud` fixed; `10-inventory`'s wrong assertion
  corrected; `11-bestiary` 6 failing objects → 1; `04-combat` 3 checks → 1, 6 zero-px
  objects → 3.
- **`10-inventory` moved 4.2 → 4.8**, off a score it held for three rounds. It was
  **two problems in two layers and only one was ever worked**: the nova wash (fixed,
  viewport excess +69.0 → +32.3 L) and the damage-numeral layer, never dispatched until
  now — numeral:monster **7.7× → 3.1×** in the critic's units, concurrent runs 7 → 4,
  no two runs abutting. Root cause one line: **crits bypassed the existing concurrency
  gate, and every readout on that shot is a crit**, so the gate had never fired on the
  shot it was written for.
- **Branding: 50 verbatim RoR2 proper nouns removed**, including `Hopoo Feather` — the
  actual developer's studio name. All `id` values untouched, so save data,
  `UNLOCK_BINDINGS` and golden hashes are unaffected.
- **Content:** Blight corruption tier (9 items, 99 tests incl. 200 permutations
  converging on one inventory); Artifact of the Edict now has a chooser and is actually
  playable (25 `rollItem` calls left `ctx.rng`'s state word unchanged); 6 shrines, 4 new.
- **Realms:** anchors closed; `24-realm-vault` had been certifying a survivor at **0 px**
  (camera 1.5 m in front of it); realms failing shots 3 → 1.
- **`f9b47c4` audited** (`AUDIT-f9b47c4.md`): 8 confirmed defects, 5 fixed. It had
  shipped `#define DET_KILL 0.0` — the terrain detail pass switched off entirely.

## Open, in priority order

1. **`04-combat` (3 zero-px objects) and `11-bestiary` (1 separation failure).** Dead
   approaches, all measured, recorded in source where they'd be retried: `screenSlots`
   even-stride sampling (→ five failing shots), `declutter({supply,nearFirst})` (six
   failing objects → seven), `placeForOpenArena()` (byte-identical). The original six
   zeros were three distinct causes, one of them a Rift Stalker **mid-blink — a correct
   game state**. The honest answer may be that the gate mis-reads a legitimately
   invisible actor.
2. **`13-biomes-2`'s far spire** — PEAK 0.222% → 0.210%, not fixed. The specular-aliasing
   fix that works elsewhere (b1 far mountain PEAK 8 → 3 → 0) did not reach it.
3. **Axis 6's premise is refuted, needs re-diagnosis.** The critique's #1 fix — "add the
   opacity layer" — is *already implemented*; `VFX.explosion` emits two `layer: 'alpha'`
   emitters. The residual is the additive sum swamping it.
4. **Escalation awaiting a decision:** the Blight glyph polarity. The tier's author
   deliberately inverted tiles for negative-space findability; the round-4 critic scores
   that as an axis-4 failure. The unambiguous half is fixed (a missing `--t-blight` was
   drawing the tier's rule white). Recommendation on the table: route Blight through the
   ordinary `itemArt` path (~5 lines), since the new magenta rule already provides
   findability without inverting tiles.
5. **The mesa low-pass round 3 has requested three times is aimed at the wrong term** —
   2.7× gain moved the target statistic 0.02. Its real cause is `b09c3d4`'s probe
   (per-pixel normals → per-pixel reflections), an 8.3% regression on that ROI and the
   honest price of the axis-5 fix.
6. Inherited: no two-peer co-op test has ever run under `PROTOCOL_VERSION` 2; the
   phase-2 finale tethers remain authority-gated and unverifiable; `deathDissolve` is
   still broken and **five agents have correctly refused the one-line fix** because it
   arms a real invisible-enemy bug (`VFX.js:1269` / `DIAG-invisible-enemies.md` §5).

## Standing hazards

- **Never run bare `npx`.** npm 6.13.6 is on PATH with node v24; npx's cleanup deletes
  this repo's rolldown binding *and* playwright. **Three outages this session**, one of
  them mine. Node v24 bundles npm **11.12.1**, shadowed on PATH — recover with
  `node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" ci`. Build with
  `node node_modules/vite/bin/vite.js build`.
- Capture into your own `--out` dir and `--port`, never `shots/`. `capture.mjs` now
  gates its directory wipe on `ready` and writes `manifest.FAILED.json` on a failed
  boot — verified in the field twice this round, preserving captures it would previously
  have destroyed.
- ~40 code identifiers still carry RoR2 names (`meshFactory: 'lemurian'`,
  `hopoo-feather` and `shatterspleen` as ids). Display text is clean; ids need a save
  migration and a golden-hash re-baseline as one decision.
