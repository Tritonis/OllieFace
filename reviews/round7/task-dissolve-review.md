# REVIEW — the death dissolve fix (rigEpoch token + flash-clear ordering)

Independent first review. Worktree `C:\Users\tpzap\source\repos\OllieFace\.claude\worktrees\agent-a8d5a08935e7500ea`,
branch `worktree-agent-a8d5a08935e7500ea`, commits `dfc6d11` (rigEpoch token,
invisible-enemy hazard) and `4734ffd` (flash-clear ordering). Implementer report:
`reviews/round7/FIX-dissolve.md` (worktree copy). Its numbers were **not** taken on
trust — every claim below was independently re-derived: codegraph blast-radius
queries, direct reads of the diff and its call sites, my own runtime-monkeypatch
sabotage scripts (no tracked file edited), and my own re-run of the full test
suite, build, sp-equivalence, and the GPU probe on a fresh port/output dir.

## Verdicts

**SPEC: CONFIRMED** — every claim in `FIX-dissolve.md` reproduced independently;
no gap found in the hazard-closure enumeration.
**QUALITY: READY** — the fix is a single well-placed choke point (`resetRig`),
correctly guarded on both consuming loops, with real-pool tests and a real-GPU
probe backing it.

Severity counts: **0 critical, 0 major, 0 minor.**

---

## Per-claim verdicts

1. **Hazard closed for all recycle paths** — CONFIRMED. `resetRig`
   (`src/entities/EnemyMeshes.js:796-822` in the worktree) is called
   unconditionally by both `acquireRig` (`:4394-4400`) and `releaseRig`
   (`:4402-4408`), which are the *only* two functions that touch the module-level
   `POOL` (`EnemyMeshes.js:4391`). Verified via `codegraph_explore` that every
   caller of `acquireRig`/`releaseRig` in the tree — `Enemy.spawn`/`Enemy.despawn`
   (`src/entities/Enemy.js:338,361`), `NetViews.js` (`EnemyView` ctor line 48 and
   `dispose()` line 134), `fx/Prewarm.js`, `tools/silhouette.mjs` — routes through
   these two functions, so every recycle path bumps `rigEpoch`. Also traced
   `Director.spawnOne` (`src/systems/Director.js:728-745`): even when the
   *Enemy* JS wrapper itself is reused from `Director.pool` (a separate,
   unrelated pool of `Enemy` objects, not rigs), it still always calls
   `e.spawn(...)` which unconditionally calls `acquireRig` — there is no path
   that hands a stale `.rig` to a recycled `Enemy` object without going through
   `resetRig`. `NetViews.js:56` (`this.group = this.rig.root`) shares the same
   `POOL`, and its `dispose()` releases through the same choke point, so
   cross-source (host Enemy ↔ client NetView) recycling in a single process is
   covered too.
2. **Flash-ordering half safe** — CONFIRMED. `setFlash` (`EnemyMeshes.js:776-787`)
   guards on `if (on === this.flashing) return`, so `Enemy.onDeath`'s new
   `this.rig?.setFlash(false)` (`Enemy.js:520`) followed by `updateRig`'s regular
   `rig.setFlash(this.flashT > 0)` (`Enemy.js:1389`, now a no-op since
   `flashT` was zeroed at `Enemy.js:519`) cannot double-apply `applyMats`.
   `setFlash` has exactly two call sites in the whole tree
   (`Enemy.js:1389` and unrelated boot-time `Prewarm.js:57,59`); nothing else
   consumes `FLASH`/`flashT`. Ordering itself confirmed by reading
   `Combat._kill` (`src/systems/Combat.js:603-619`): `victim.onDeath()` runs
   synchronously before `ctx.events.emit('kill', ...)`, and `Enemy.takeDamage`
   (`Enemy.js:428-432`) — which sets `flashT = FLASH_TIME` — always runs before
   `Combat._kill` per the file's own comment at `Enemy.js:422-427`.
3. **RNG neutrality** — CONFIRMED. Read the full diff; no `ctx.rng`/`ctx.fxRng`
   call was added, removed, or reordered. The one new early-exit
   (`VFX.js:1673-1677` in `_updateDissolves`, `VFX.js:864` in `_updateLaunches`)
   sits *before* the ember `fxRng` draw at `VFX.js:1701-1703`, and only fires
   after a rig handover, which cannot happen inside a capture window. Re-ran
   `sp-equivalence --compare` myself against the implementer's own baseline
   (see below) — no fields moved.
4. **Evidence reproduced** — CONFIRMED, all independently re-run (see Commands).
5. **Sabotage checks** — CONFIRMED, via my own scripts, not the implementer's.
   I did not use `Edit`/`Write` on any tracked source file (I write only the
   review deliverable) — instead I wrote two throwaway `.mjs` scripts into
   `tests/` that runtime-monkeypatch `VFX.prototype._updateDissolves` and
   `Enemy.prototype.onDeath` back to their pre-fix behaviour, ran them, then
   deleted them (repo left clean — `git status --short tests/` empty
   afterward). Both reproduced the documented pre-fix failure independently
   of the implementer's own `dissolve-recycle.test.mjs` sabotage runs.
6. **Rendered probe** — CONFIRMED. Re-ran `probe-dissolve.mjs` myself (a
   modified copy, port 5311, `--out reviews/round7/captures/review-dissolve`,
   the original left untouched) and reproduced both arms:
   arm 1 monotone decline 1658→1658→1555→0→0→0 px (100% gone at 0.95, shader
   correctly patched), arm 2 `rigEpoch 4 -> 6`, `root.visible: true`, live
   monster rendering **2766 px** after a handover mid-dissolve. Pixel counts
   differ from the implementer's run (2114 vs 1658 at k=0; 4364 vs 2766 for
   arm 2) — expected, this is a live GPU harness with camera/timing that is
   not seeded identically between separate `overkill()` calls; the pass/fail
   shape (monotone-to-zero, and nonzero-after-handover) is what matters and it
   holds in both runs.

---

## What I verified beyond the six checkpoints

- **DIAG §5 framing.** Read `reviews/round5/DIAG-invisible-enemies.md` §5 in
  full. The report's characterization of the trap (`VFX.js` pre-fix
  `d.mesh.visible = false` at dissolve end, `Director.clear` despawning
  immediately regardless of `finished`) matches the diagnostic verbatim, and
  the "minimal fix" DIAG §5 sketches (an owner token bumped by `resetRig`,
  checked before the write) is exactly what shipped.
- **`d980a17` really did ship first.** `git log --oneline` on the worktree
  shows `d980a17` ("The eye learns the shape of an enemy...") predates
  `dfc6d11`/`4734ffd`, and `resolveObject` (`VFX.js:1925-1939`) already lists
  `entity.rig?.root` in its candidate chain — confirms the report's framing
  that the invisible-enemy trap DIAG §5 called hypothetical was already live
  at HEAD before this fix landed.
- **Client/co-op path unaffected, as claimed.** Read `NetHost.js`'s `sanitise`
  (`:622-650`): an entity with a `netId` is reduced to `{netId}` on the wire,
  so a client's `'kill'` handler's `p.victim` has no `.rig`/`.group`, and
  `resolveObject` returns `null` — `deathDissolve` never runs on a
  `NetViews.EnemyView` today. This is pre-existing behaviour, not something
  this fix touches or regresses.
- **`DissolveShader.js` handle guard.** `release()` (`DissolveShader.js:200-208`)
  already checks `r.child.material === r.swapped` before restoring — a
  pre-existing identity guard for materials that this fix's
  `d.handle.release()` call (unconditional on the epoch-mismatch path) relies
  on to be safe against double-restoring slots `applyMats` already reclaimed.
  Confirmed this guard predates the fix and is exercised by it correctly.
- **Non-rig objects behave identically.** `undefined === undefined` on both
  sides of the epoch comparison for a plain `Object3D` (player mesh, a prop) —
  confirmed by the existing passing test `"the guard is a token on the rig,
  not a guess about the object"` (`tests/dissolve-recycle.test.mjs:168-180`)
  and, for `corpseLaunch`, implicitly by every earlier block in
  `tests/corpse-launch.test.mjs` (all use a bare `THREE.Object3D`, i.e.
  `userData.rigEpoch` undefined on both sides, and none are ever dropped
  prematurely).

No gap was found in the recycle-path enumeration — this was the item five
prior agents refused to close, and the reason was legitimate (a naive
`root.visible = false` at dissolve-end genuinely was unsafe); the token fix
closes it at the one real choke point rather than patching each call site.

---

## Commands run (worktree `C:\Users\tpzap\source\repos\OllieFace\.claude\worktrees\agent-a8d5a08935e7500ea`)

```
# node_modules junction (worktree had none)
New-Item -ItemType Junction -Path node_modules -Target ...\OllieFace\node_modules

node tests/run.mjs
  -> 44/44 test files passed

node tests/dissolve-recycle.test.mjs
  -> 29 passed, 0 failed

node tests/corpse-launch.test.mjs
  -> 39 passed, 0 failed

node node_modules/vite/bin/vite.js build
  -> built in 1.56s

node tests/sp-equivalence.mjs --compare reviews/round7/dissolve/sp-baseline.json
  -> single-player unchanged vs reviews/round7/dissolve/sp-baseline.json — no fields moved

# Sabotage 1 (my own script, tests/_review-sabotage-dissolve.mjs, deleted after run):
# monkeypatched VFX.prototype._updateDissolves to the documented pre-fix body
# (unconditional `d.mesh.visible = false`, no rigEpoch check), reran the
# rig-handover scenario:
  PASS  the dissolve is still mid-burn at 0.2 s
  PASS  the pool handed the same rig to the next enemy
  PASS  which starts its life visible
  PASS  the dissolve is finished and off the list
  FAIL  the finished dissolve did NOT hide a live, damageable monster
  -> 4 passed, 1 failed  (confirms the guard is load-bearing)

# Sabotage 2 (my own script, tests/_review-sabotage-flash.mjs, deleted after run):
# monkeypatched Enemy.prototype.onDeath to re-flash the rig immediately after
# the real onDeath returns (undoing the fix's clear before 'kill' fires):
  PASS  the graze put the rig in its hit flash
  PASS  the kill built a dissolve
  FAIL  and the corpse is no longer flashing (SABOTAGED: should FAIL)
  FAIL  and the body is still dissolving half a second later (SABOTAGED: should FAIL)
  -> 2 passed, 2 failed  (confirms the flash-clear ordering is load-bearing)

git status --short tests/
  -> (empty; both sabotage scripts deleted, no tracked file modified)

# Rendered probe, own port/output (copy of reviews/round7/dissolve/probe-dissolve.mjs
# with PORT=5305->5311 and OUT changed to reviews/round7/captures/review-dissolve;
# copy deleted after the run, original untouched):
node reviews/round7/dissolve/_review-probe-dissolve.mjs

arm 1 - the dissolve consumes the corpse
  uDissolve 0.00 ->   1658 px
  uDissolve 0.20 ->   1658 px
  uDissolve 0.40 ->   1555 px
  uDissolve 0.60 ->      0 px
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
  the live monster renders 2766 px
  PASS  a live, damageable monster is in the picture

  -> wrote reviews/round7/captures/review-dissolve/probe.json and two PNGs
     (worktree-local; not committed, evidence of this review's own run)
```

Codegraph queries run against the main repo's `.codegraph/` index (no
`.codegraph/` exists inside the worktree itself; the index tracks the
worktree's files too and was current for the files this review depended on)
confirmed the `acquireRig`/`releaseRig`/`resetRig` caller graph described
above.

## Files inspected (file:line references used above)

- `src/entities/EnemyMeshes.js:796-822` (`resetRig`), `:4383-4408`
  (`acquireRig`/`releaseRig`), `:776-787` (`setFlash`)
- `src/entities/Enemy.js:246-353` (`spawn`/`despawn`), `:422-524` (`onDeath`,
  flash clear at `:519-520`), `:428-438` (`takeDamage`, flash set at `:432`),
  `:1389` (`updateRig`'s `setFlash` call)
- `src/systems/VFX.js:768-847` (`deathDissolve`/`corpseLaunch`, owner capture),
  `:861-901` (`_updateLaunches`, guard at `:864`), `:1659-1715`
  (`_updateDissolves`, guard at `:1673-1677`), `:1925-1944` (`resolveObject`)
- `src/systems/Combat.js:603-619` (`_kill` ordering)
- `src/systems/Director.js:728-745` (`spawnOne`), `:966-985` (`clear`)
- `src/net/NetViews.js:45-136` (`EnemyView` ctor/`dispose`)
- `src/net/NetHost.js:598-650` (`sanitise`)
- `src/shaders/DissolveShader.js:155-208` (`releaseVariant`/`release`)
- `reviews/round5/DIAG-invisible-enemies.md` §5 (framing source)
- `tests/dissolve-recycle.test.mjs`, `tests/corpse-launch.test.mjs` (read in
  full)
- `reviews/round7/dissolve/probe-dissolve.mjs` (read in full, copied for
  independent re-run)
