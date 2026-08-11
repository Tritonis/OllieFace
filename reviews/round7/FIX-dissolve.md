# FIX — the death dissolve, and the invisible-enemy path it was blocked on

Closes round 6 handoff item 6 under "Open": *"`deathDissolve` is still broken and
five agents have correctly refused the one-line fix because it arms a real
invisible-enemy bug (`VFX.js:1269` / `DIAG-invisible-enemies.md` §5)."*

Branch `worktree-agent-a8d5a08935e7500ea`. Build green, 44/44 test files green,
`sp-equivalence --compare` reports no moved fields.

**The first thing found, and it changes the framing of the whole item.** The
one-line fix the five agents refused — teaching `resolveObject` to see
`entity.rig?.root` — **has already shipped**, in `d980a17` ("The eye learns the
shape of an enemy"). So the trap DIAG §5 described was not a hypothetical one
commit away; it was armed and live at HEAD, and had been since that commit. The
task as briefed (fix the invisible-enemy path *before* enabling the dissolve) was
already overdue rather than pending.

---

## Root cause

Three defects on one seam, all of them the same mistake: **a presentation effect
holds an `Object3D` that belongs to a pooled rig, and nothing tells it when that
rig changes hands or gets re-dressed underneath it.**

### 1. The invisible-enemy path (DIAG §5, confirmed and reproduced)

`VFX._updateDissolves` ends a dissolve by hiding what is left:

```js
// src/systems/VFX.js, pre-fix
if (k >= 1) {
  d.mesh.visible = false;
  d.handle.release();
  this._dissolving.splice(i, 1);
}
```

`d.mesh` is `rig.root`. The dissolve runs 0.85 s (`VFX.js:786`); the reaper only
releases a rig at `DEATH_TIME = 1.5 s` (`src/entities/Enemy.js:25`), so the
ordinary death path is safe. But `Director.clear` (`src/systems/Director.js:966`,
run on **every** stage change) calls `Enemy.despawn` (`src/entities/Enemy.js:355`)
immediately regardless of `finished`, which calls `releaseRig`
(`src/entities/EnemyMeshes.js:4391`) and puts the rig straight back in `POOL`. The
new stage's first spawn pops it out again. Kill something, transition inside
0.85 s, and `visible = false` lands on a **live, damageable monster**, which
nothing makes visible again until it dies (`S.DIE.enter`,
`src/entities/Enemy.js:1795`).

**A second, quieter invisible path on the same seam, not recorded in DIAG.**
`resetRig` → `setAffix(null)` → `applyMats` (`src/entities/EnemyMeshes.js:725-730`)
only re-dresses four catalogued slots (`body`/`dark`/`accent`/`eye`). Every mesh
outside them is still wearing the corpse's dissolve variant, whose `uDissolve`
the loop keeps driving to 1 — i.e. `discard` on every fragment. Those parts of
the living monster were gone from the picture for the remaining 0.65 s just as
completely as `visible = false` made the whole of it.

### 2. The dissolve was not on the body at all

This is the "`deathDissolve` is broken" half, and it is **not** the
`resolveObject` bug that `d980a17` fixed. Even with the effect correctly wired
and running, it was invisible on every monster in the game.

Every hit sets `flashT = FLASH_TIME` (`src/entities/Enemy.js:432`) and
`updateRig` re-derives the flash from it each frame (`:1389`), so at the instant
of the killing blow the body/dark/accent/eye meshes are all wearing the shared
white `FLASH` material. `Combat._kill` calls `victim.onDeath()` and **then**
emits `kill` (`src/systems/Combat.js:608-610`), which is what runs
`VFX.deathDissolve` → `makeDissolvable`. So the dissolve was built over `FLASH`,
captured `FLASH` as the material to hand back, and `FLASH_TIME` later
`setFlash(false)` re-dressed those same four slots from `rig.mats`
(`src/entities/EnemyMeshes.js:735`) — pulling the dissolve variants off every
mesh the silhouette is actually made of. What was left dissolving was the crumble
debris.

Measured on the GPU, seed 1337, before the fix: the corpse rendered **an
unchanging 2,081 px with `uDissolve` driven from 0 all the way to 5** (5 discards
every possible fragment), while the instrument's own control — `root.visible =
false` — read 0 px. That pair is what separated "the dissolve is not on the body"
from "the instrument is broken".

---

## The fix

**One token, three uses.** `resetRig` is the single choke point every rig
lifecycle passes through (`acquireRig` and `releaseRig` both call it), so it
stamps a counter on the root, and anything holding the root compares it before it
writes.

| file:line | change |
|---|---|
| `src/entities/EnemyMeshes.js:796-807` | `resetRig` bumps `this.root.userData.rigEpoch` |
| `src/systems/VFX.js:794` | `deathDissolve` records `owner: mesh.userData.rigEpoch` |
| `src/systems/VFX.js:1673-1677` | `_updateDissolves` drops the entry (releasing the materials, never touching `visible`) the first frame the token no longer matches |
| `src/systems/VFX.js:846` | `corpseLaunch` records the same token |
| `src/systems/VFX.js:864-867` | `_updateLaunches` drops the throw the same way |
| `src/entities/Enemy.js:503-520` | `onDeath` clears the hit flash *before* the `kill` event, so the dissolve is built over the real materials |

Notes on the shape of it:

- **`undefined` on both sides for anything that is not a pooled rig** — the
  player mesh, a prop — which compares equal, so those paths behave exactly as
  they did. There is an explicit test arm for this.
- **Dropping the entry immediately beats letting it run to term.** A held entry
  keeps emitting embers at a bounding box on a stage that no longer exists and
  keeps the pooled material variants out of circulation for the first second of
  the new fight. `handle.release()` on the way out repairs the meshes `applyMats`
  does *not* reclaim, closing the second invisible path within one frame instead
  of 0.65 s.
- **DIAG's option 3 (clear `_dissolving` on `stageStart`) is deliberately not
  taken.** It is strictly weaker: the token covers every recycle path —
  `Director.clear`, the ordinary reap, `NetViews`, the realms — not just the one
  a stage change happens to take, and it needs no new hook.
- **`corpseLaunch` is the same defect in the neighbouring loop**, and is called
  out here rather than folded into the headline because it is a *different
  symptom* off the same root cause. It writes the rig root's
  transform for up to `dur + hold`, which also outlives a stage change; without
  the token a live monster was dragged metres off the position the simulation has
  for it, mid-tumble. Not an *invisible* enemy, so a reviewer who wants only the
  headline fix can drop `VFX.js:846` and `:867` and the last arm of
  `tests/corpse-launch.test.mjs` without touching anything else.

**Shared-RNG check.** No draw was added, removed or reordered. The only new
early-exit path skips ember emission for a corpse whose rig has already changed
hands, which cannot occur without a stage transition and therefore cannot occur
inside a capture shot. `fxRng` draw counts on the normal path are byte-identical;
`sp-equivalence` confirms.

---

## Test evidence

### `tests/dissolve-recycle.test.mjs` (new) — 29 assertions, headless, real pooled rigs

Real `acquireRig`/`releaseRig` from the real `POOL`, because the pooling *is* the
bug; real `Enemy`, real `Combat`, real `Roster` for the flash arm.

Pre-fix (the probe written first, run against unmodified `src/`):

```
a rig that changed hands mid-dissolve is never touched again
  FAIL  the finished dissolve did NOT hide a live, damageable monster
the recycled dissolve lets go at once, not at the end of its clock
  FAIL  the entry is dropped on the first frame after the handover
  FAIL  the corpse shaders are off the live rig within one frame, not 0.65 s later

18 passed, 3 failed
```

Post-fix:

```
21 passed, 0 failed        (invisible-enemy arms)
29 passed, 0 failed        (with the flash arm added)
```

The flash arm sabotaged (the two lines in `onDeath` removed, everything else
intact) — i.e. it is not passing for the wrong reason:

```
the dissolve survives the blow that caused it
  FAIL  and the corpse is no longer flashing
  FAIL  and the body is still dissolving half a second later, not re-dressed out of it
27 passed, 2 failed
```

### `tests/corpse-launch.test.mjs` — one arm added

```
a corpse that changed hands mid-flight is dropped, not dragged
  PASS  the throw is in flight
  PASS  the pool handed the same rig to the next enemy
  PASS  the launch let go on the first frame after the handover
  PASS  and left the living monster where the simulation put it
  PASS  upright, with no tumble on it

39 passed, 0 failed
```

Sabotaged (`if (false && ...)` on the guard): `36 passed, 3 failed`.

### `reviews/round7/dissolve/probe-dissolve.mjs` (new) — the rendered half

Real GPU path (`--use-angle=d3d11`), staged on `19-overkill`, port 5305, output in
`reviews/round7/captures/fix-dissolve/`. Pixels are of the **isolated** subject:
`H.subjectReport` renders the frame, hides the subject, renders again and diffs,
so terrain, props, VFX and the composer are all divided out.

```
arm 1 - the dissolve consumes the corpse
  29 material bags driven (29 read back at 0.95), corpse wearing: variant, dissolve t=0.116s
  uDissolve 0.00 ->   2114 px
  uDissolve 0.20 ->   1716 px
  uDissolve 0.40 ->   1319 px
  uDissolve 0.60 ->     27 px
  uDissolve 0.80 ->      0 px
  uDissolve 0.95 ->      0 px
  shader: {"cls":"RimStandardMaterial","isStandard":true,"hasBag":true,"sameBagObject":true,
           "programIsPatched":true,"progUniformIsOurs":true,"progHasUDissolve":true}
  control: uDissolve 5 -> 0 px, root.visible=false -> 0 px
  PASS  a full body at 0, monotone fall, 100.0% gone at 0.95

arm 2 - the rig changed hands mid-dissolve
  same rig popped from the pool: true
  rigEpoch 4 -> 6
  dissolves still holding it: 0
  root.visible: true   alive: true
  the live monster renders 4364 px
  PASS  a live, damageable monster is in the picture
```

Arm 2 performs exactly what a stage change does — `despawn` (which is
`releaseRig`) followed by the next stage's first `spawnOne` (which is
`acquireRig`, and pops the very rig being dissolved, confirmed by `sameRig:
true`) — then runs the dissolve 90 frames past its 0.85 s and photographs the new
monster. `rigEpoch 4 -> 6` is the two bumps of one handover (release, then
acquire).

The same file at the pre-fix commit, for contrast:

```
  uDissolve 0.00 ->   2081 px      (and 2081 at 0.2, 0.4, 0.6, 0.8, 0.95)
  shader: {"cls":"RimStandardMaterial","hasBag":false,"progHasUDissolve":false, ...}
  control: uDissolve 5 -> 2081 px, root.visible=false -> 0 px
  FAIL  a full body at 0, monotone fall, 0.0% gone at 0.95
```

`hasBag: false` on the corpse's largest mesh is the flash clobber caught in the
act: the biggest piece of the body was wearing a plain shared material, not a
dissolve variant.

Two composed frames of the same corpse are in
`reviews/round7/captures/fix-dissolve/` — `corpse-intact.png` (`uDissolve = 0`)
and `dissolve-midburn.png` (`uDissolve = 0.45`) — on disk but **not committed**,
because `.gitignore:19` excludes `reviews/**/*.png`; re-run the probe to
regenerate them. The burn is visible between them
as a shrinking mass left of the crosshair; the pixel table above is the rigorous
version of the same claim.

### Gates

```
node tests/run.mjs                 44/44 test files passed
node node_modules/vite/bin/vite.js build     built in 787ms
node tests/sp-equivalence.mjs --compare reviews/round7/dissolve/sp-baseline.json
  single-player unchanged vs reviews/round7/dissolve/sp-baseline.json - no fields moved
```

The baseline was captured from this branch's own HEAD with the working tree
stashed (`reviews/round7/dissolve/sp-baseline.json`, seed 1337), not from an
approximation and not from the main tree, which is on a different branch.

---

## What this does not cover, and one thing to look at next

- **`gate:elite` was not run.** Nothing here touches `ELITE_STATS`, and
  `sp-equivalence` prints its own note that the window contains no elite.
- **The co-op client path is still untested by anyone.** `NetViews.js:56` sets
  `this.group = this.rig.root`, so `resolveObject` resolves there too — but the
  client's `kill` payload is `sanitise`d to plain data (`src/net/NetHost.js`), so
  the effect does not reach a client rig at all. That is DIAG's own open question
  and is unchanged by this work.
- **`19-overkill`'s "kill burst" gate fails on every run of the probe** (78-128 px
  against a 150 floor). That is the known-red capture baseline recorded in the
  session memory, not something introduced here; the probe does not read that
  gate.
- **`acquireShadowSlot` still never releases** (`src/entities/EnemyMeshes.js:445`,
  192 slots, rigs live forever in `POOL`). Cosmetic, noted by DIAG, untouched.
