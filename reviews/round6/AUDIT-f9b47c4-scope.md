# Audit of `f9b47c4` — main-session findings and scope

`f9b47c4` is partial work from four agents killed mid-edit at a usage limit, with no
`FIX-*` report written for any of them. This is the audit the handoff asked for.

## Size: much smaller than it looks

`git diff --shortstat 2a782a0 f9b47c4` reports **125 files, +10,940 / −157**. Almost all
of that is captures and critic reports under `reviews/`. The actual source change is
**11 files, ~1,312 lines**:

| file | lines |
|---|---|
| `src/world/realms/RealmArena.js` | 319 |
| `src/core/Harness.js` | 202 |
| `src/world/realms/FinalBoss.js` | 206 |
| `src/systems/VFX.js` | 124 |
| `src/data/realms.js` | 100 |
| `src/ui/hud.css` | 96 |
| `src/world/Materials.js` | 81 |
| `src/ui/Menus.js` | 63 |
| `src/shaders/ParticleShader.js` | 50 |
| `src/world/realms/RealmHarness.js` | 44 |
| `src/core/RenderPipeline.js` | 27 |

## CLEARED — checked in the main session

**1. Only one latched kill switch exists.** A sweep of every added line for
`#define|KILL|DEBUG|DISABL|TEMP|HACK|XXX|TODO|FIXME|if (false)|* 0.0|= 0.0;` returns
exactly one real hit: `DET_KILL` in `Materials.js`. Everything else matching is prose
in comments.

**2. The gate was never loosened.** Every threshold in `Harness.js`, compared across
both commits:

```
2a782a0 → f9b47c4:  identical, except ONE ADDITION — minPixels: 420
```

No `minPixels`, `minObjects`, `minSep`, `minCarriedPx` or `need` value was reduced or
removed. The handoff's instruction to never fix a failing shot by loosening the gate
was honoured by the killed agents.

**3. `Harness.js`'s 202 lines are a strict tightening.** They replace sum-and-union
aggregate subject checks with per-object measurement, and publish `perPx`/`perSep` in
the manifest with the stated reason: *"Published, not just gated on. A reviewer reading
the manifest has to be able to see the zero for himself."* This is the correct response
to the round's core lesson, written by the agent that learned it.

**4. The code is well-commented and careful.** This is not sloppy work. Every
substantive change carries a comment explaining the measurement that motivated it. The
defects found so far are *semantic side effects*, not carelessness — which is precisely
why they survived review.

## CONFIRMED DEFECTS — found before the audit was dispatched

**D1 — `Materials.js:358,486`: the terrain detail pass was switched off entirely.**
`#define DET_KILL 0.0`, applied as `gradW *= DET_KILL; hOut *= DET_KILL;`. Absent in
`619e417`, `811fbef`, `2a782a0`; introduced in `f9b47c4`. A debug kill-switch latched at
zero and committed. `reviews/round6/crops/arch-base.png` shows the hero arch as bare
rock with no mortar courses. **A round-4 stages critique run against this commit would
have scored a build with its axis-5 hewn-stone identity deleted.**

**D2 — `ParticleShader.js`: the quad-boundary fade neutered the shock ring.**
`smoothstep(0.74, 1.0, rq)` left only **18%** of `shockRing`'s alpha, because that
sprite's band sits at `rq ≈ 0.93` — switching the atlas's one sharp-edged frame off
engine-wide. Found by the VFX agent through measurement (its rim emitter *worsened* the
gradient, and chasing the anomaly exposed this), not by reading. Narrowing to
`0.90 → 1.0` preserves the `rq ≥ 1.0` boundary guarantee exactly.

**D3 — mis-attribution in both directions.** The commit contains real, unreported
fixes: the per-channel-clip→ratio-scale change that took `08-explosion`'s core-clipped-R
fraction 100% → 0%, and the `RenderPipeline.js` change that took frame-wide aberration
from 4–6 px to 1 px. Two agents discovered this independently from separate evidence.
**Consequence: `reviews/round6/base/` is not a pre-fix state for VFX or materials work,
and any "before" number taken from it credits this commit's authors, not the current
round.**

## The pattern

All three defects share a shape: **a value that zeroes something its author did not
realise they were touching.** `DET_KILL` was deliberate and forgotten; the `0.74`
smoothstep was an unexamined side effect on a different sprite. Neither is findable by
keyword — D2 has no keyword at all. That is why the remaining ~900 lines were dispatched
to an independent auditor to be *read* rather than grepped, with instructions to treat
"constant that switches a feature off at its edges" as the target class.

Open question handed to that auditor: `ParticleShader.js` moved the nova alpha floor
**0.18 → 0.05**, a 3.6× reduction, to fix `10-inventory`. The handoff records that the
`10-inventory` fix claim (165.4 → 116.4) **did not survive independent measurement** and
that the regression is still open — so this constant may have been tuned against a
baseline that cannot be reproduced.

Findings continue in `AUDIT-f9b47c4.md`.
