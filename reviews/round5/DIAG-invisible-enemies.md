# DIAG — invisible enemies in `04-combat` / `05-boss`

## Verdict: **(A)** — a harness framing/placement problem. Plus one secondary finding that is *not* the reported bug but is worth recording (see §5).

There is **no rendering/visibility bug**. Enemy meshes did not fail to draw. In the
exact state that shipped the empty screenshots, every one of the 24 monsters was in
the scene graph, `visible`, unit-scaled, correctly positioned, and rendered
between 353 and 9,707 pixels when photographed with the terrain removed. They
contributed nothing to `04-combat.png` because **22 of 24 were behind a terrain lip
4–12 m in front of the lens and the other 2 were above the top of frame** — zero of
24 were simultaneously on-screen and unoccluded. `05-boss` is the same failure: the
Stone Titan was dead centre of frame at screen (0.50, 0.61) and blocked by a ridge
22 m into a 48 m sightline.

Everything below is measured, on the actual commits, with the commands shown.

---

## 1. What the diff changed

`git diff --stat f9d85cf a06c6fe` — nothing in the diff touches mesh visibility,
culling, instancing or scene-graph membership. Notably **`src/entities/EnemyMeshes.js`
and `src/entities/Enemy.js` are not in the diff at all**. The relevant files are:

```
 src/core/Harness.js  | 1133 ++++++++++++++++++++++++++++--
 tools/capture.mjs    |   62 +-
```

`Harness.js` gained: `visibleFraction()` (box-sampled occlusion instead of one
centre ray), `groundAtScreen()` (place subjects by marching a *screen* ray so the
landing point is unoccluded by construction), `faceOpenGround()` (turn the survivor
until the ground ahead is ground the lens can see), a rewritten `declutter()`, and
`mustContain()` — a per-shot assertion that measures **rendered pixels** by
render → hide subject → render → diff. `capture.mjs` gained the `subject` /
`subjectFailures` / `subjectsOk` manifest keys and a non-zero exit on a missing
subject.

That is camera placement, subject placement, and a detector. It is exactly the
profile the brief said would be strong evidence for (A).

## 2. Reproducing the original failure at `f9d85cf`

Worktree at `f9d85cf`, replaying the *exact* capture ordering (01-title →
17-artifacts → 02-vista → 03-thirdperson → 09-survivors → 14-survivor-select →
15-logbook → 13-biomes-1..4 → 04-combat → 05-boss), because the scenarios share one
page and one camera rig, then measuring.

```
git worktree add /tmp/ollie-old f9d85cf --detach
node tools/probe-old-combat.mjs 5341
```

The screenshot it produced (`probe-04-combat.png`) is the reported failure verbatim:
the survivor on an orange-lit lip bottom-left, a tracer streaking away into a large
dark void, **zero enemies**, HUD reading `STAGE 4 — RALLYPOINT FERROUS`.
`probe-05-boss.png` is a full `STONE TITAN` boss bar over an empty forest. Both
reproduce.

### The measurement on that exact frame

Method — "isolated draw test": snapshot each rig's real `visible` flag, then hide
every scene child except lights, park a fresh camera 2.2 body-heights off the
subject, render to an offscreen 192×192 target, reveal only that enemy's rig chain,
render again, and count differing pixels. The diff is that enemy's contribution with
terrain, props, other enemies, VFX and the composer all removed. Zero diff on a live
entity would mean the mesh genuinely does not draw.

```
combat cam [-15.74, 19.82, 28.61]  ground under cam 16.04  player [-14.98, 16.04, 31.12]
n 24   drew 24   zeroPx 0   losBlocked 22   offscreen 4
```

Per-enemy (abridged; `px` = isolated rendered pixels, `los` = terrain/prop raycast
from the *shot* camera, `gY` = terrain height under the enemy):

```
  3 mite      px=353   vis=true inScene=true los=BLOCK@6.65/28.78  scr=[0.429,0.393]  gY=2.96   scale=1
  4 beetle    px=1684  vis=true inScene=true los=BLOCK@11.35/15.54 scr=[0.905,0.046]  gY=16.04  scale=1
  5 spitling  px=1459  vis=true inScene=true los=BLOCK@4.94/36.92  scr=[0.683,0.699]  gY=-8.93  scale=1
  6 lemurian  px=2635  vis=true inScene=true los=BLOCK@5.25/33.79  scr=[0.589,0.582]  gY=-5.36  scale=1
  7 wisp      px=1333  vis=true inScene=true los=BLOCK@8.29/14.22  scr=[0.692,-0.511] gY=16.04  scale=1
  8 pest      px=1449  vis=true inScene=true los=clear             scr=[0.743,-0.272] gY=16.04  scale=1
  9 harrier   px=9707  vis=true inScene=true los=BLOCK@7.78/24.35  scr=[0.589,0.304]  gY=0.98   scale=1
 10 charger   px=4408  vis=true inScene=true los=BLOCK@5.34/33.27  scr=[0.568,0.559]  gY=-4.51  scale=1
 11 burrower  px=2470  vis=false inScene=true los=BLOCK@10.62/29.59 scr=[0.359,0.137] gY=11.39  scale=1
 ... (all 24 in the same shape) ...
 15 acolyte   px=3074  vis=true inScene=true los=clear             scr=[0.416,-0.069] gY=16.04  scale=1
 26 charger   px=2999  vis=true inScene=true los=BLOCK@7.18/31.46  scr=[0.049,0.547]  gY=2.45   scale=1
```

Read that carefully, because it settles the question:

| Claim (B) would need | Measured at `f9d85cf` |
|---|---|
| a rig missing from the scene graph | `inScene=true` for 24/24 |
| `root.visible === false` on a live enemy | 23/24 `true`; the one `false` is enemy #11, a **burrower**, legitimately hidden by `S.SUBMERGED` (`src/entities/Enemy.js:1434`) |
| a rig left fully dissolved / zero-scaled by pooling | `scale=1` for 24/24 |
| a mesh at the wrong world transform | `posDelta = 0.000` for 24/24 |
| **zero rendered pixels** | **0 of 24.** Every enemy drew 353–9,707 px |

And the actual cause:

- **22 of 24 line-of-sight blocked** by terrain/props. The blocking hits land at
  **4.05–12.08 m** along sightlines of **14.2–39.8 m** — i.e. within the first
  15–40% of the distance. That is not a distant obstacle; that is the lip of the
  ground the survivor is standing on.
- **4 of 24 off-frame** (negative screen-y — above the top of the picture).
- The only 2 with clear LOS (#8 pest, #15 acolyte) were both off-frame
  (screen-y −0.272 and −0.069).
- **0 of 24 were both in-frame and unoccluded.**

Terrain height under the camera: **16.04 m**. Terrain height under the enemies:
**−8.93 m to +16.04 m**. The survivor was standing on the edge of a plateau with a
25 m drop, facing the drop. `spawnRing` chose bearings off camera-forward at 13–20 m
and dropped each spawn onto `sampleHeight` — so the ring landed down the cliff face,
correctly inside the frustum (`inFront=true` for all of them), and behind the lip.

`05-boss` is the same:

```
cam [0.66, 22.54, 12.91]  ground 3.6
 27 titan  px=5166  vis=true inScene=true los=BLOCK@22.14/47.8  scr=[0.5,0.607]  gY=3.21
```

The Titan was in the centre of frame and drew 5,166 px in isolation. It was behind
the ridge that dominates the middle of `probe-05-boss.png`.

### The critic's inference, and why it was wrong

The critic wrote that "the tracer terminates in mid-air on an entity that isn't
drawn". Reasonable, but not what happened. The tracer (`src/fx/Trails.js:95`) is
`depthWrite: false` with depth *testing* on and `renderOrder = 11`; in the shot it is
flying over the near, unlit slope in front of the lip and simply ends where the
trail's ring buffer ends. The hitscan and the mesh agreed the whole time — the
monsters were 5–25 m further down the hill behind the crest. There was no
"solid-but-not-drawn" entity.

## 3. Ruling out (B) in the current code, on the mechanisms the brief named

### 3a. Pooled reuse — the highest-risk path — across the full roster

`tools/probe-roster.mjs`: five generations, each spawning **every one of the 22 rig
types** (16 monsters + 6 bosses) through `Director.spawnOne`, alternating elite
affixes between generations so `setAffix` re-dresses pooled rigs, forcing three rigs
per generation into `root.visible = false` immediately before teardown (exactly what
`S.CHARGE`-blink and `S.SUBMERGED` do), and alternating teardown between the
kill-and-reap path and the hard `Director.clear(ctx)` stage-transition path.

```
gen 0: n=22 drew=22 zeroPx=0 rootHidden=0 notInScene=0
gen 1: n=22 drew=22 zeroPx=0 rootHidden=0 notInScene=0
gen 2: n=22 drew=22 zeroPx=0 rootHidden=0 notInScene=0
gen 3: n=22 drew=22 zeroPx=0 rootHidden=0 notInScene=0
gen 4: n=22 drew=22 zeroPx=0 rootHidden=0 notInScene=0    <- running on recycled rigs
```

Generation 4 is the load-bearing one: generation 3 ended with `clear()`, which
released 44 rigs to `POOL` and 44 `Enemy` objects to `Director.pool` (confirmed by
the pool census — 22 types × 1 left over after generation 4 popped its 22). All 22
reused rigs drew. **110 measurements, 0 failures.**

### 3b. Pooled reuse under natural director spawning + a stage transition

`tools/probe-invisible.mjs --mode gameplay --cycles 6`: real `dismiss()`, cranked
director credits, six spawn/kill/respawn cycles with `progression.advanceStage()` in
the middle. **56 live enemies measured, 56 drew, 0 zero-pixel, 0 out of scene.**
Pool census shows genuine recycling across cycles (`spitling 0→4→0`, `wisp`, `pest`,
`beetle` all cycling).

### 3c. Code-level checks on the specific mechanisms

- **Instancing.** There is no instanced path for enemy bodies. The only
  `InstancedMesh` in `EnemyMeshes.js` is the shared contact-shadow blob pool
  (`src/entities/EnemyMeshes.js:421`, `SHADOW_MAX = 192`). Bodies are plain
  `THREE.Mesh` under a per-rig `Group`. No `count`/`instanceMatrix.needsUpdate`
  failure mode exists for enemy visibility.
- **Bounding spheres / frustum culling.** No enemy code writes `boundingSphere`.
  Geometry bounds are computed by three.js from static geometry and transformed by
  `matrixWorld`, which the animators do update. Nothing stale.
- **Scene-graph membership.** `Enemy.spawn` does `ctx.scene.add(this.rig.root)`
  (`src/entities/Enemy.js:271`). A stage rebuild removes only its own
  `terrainMesh` / `propsGroup` (`src/world/Stage.js:229,231`) — live enemies are
  never orphaned. `inScene` was true in 100% of 190 measurements.
- **Reset on reuse.** `acquireRig` always calls `resetRig`
  (`src/entities/EnemyMeshes.js:3718-3724`), which restores `root.visible = true`,
  `root.scale = 1`, pivot transform, crumble offsets, beams, shadow, `flashing =
  false`, and re-applies materials via `setAffix(null) → applyMats`
  (`:687-702`). `releaseRig` calls it a second time on the way out (`:3726-3732`).
  `common()` additionally rewrites the pivot transform every frame when
  `a.death === 0` (`:757-763`).
- **The three states that hide a rig** (`S.CHARGE` blink `:1398`, `S.SUBMERGED`
  `:1434`, and `eruptAt` `:942`) each restore visibility on exit, and `S.DIE.enter`
  (`src/entities/Enemy.js:1563-1574`) force-clears all of them with an explicit
  comment saying why. This is already defended.
- **Material opacity / depth state.** `matsFor()` hands out shared opaque
  materials; the only swap is `FLASH`, restored by `setFlash(false)` and again by
  `resetRig`.

### 3d. The fixed harness on the real capture ordering

Full capture at `7f32fc5`:

```
node tools/capture.mjs --out <scratch>/shots-head --port 5381
  "errorCount": 1,
  "subjectsOk": false,
  "subjectFailures": [ "10-inventory: the equipment blast" ]
```

`04-combat` and `05-boss` both pass their pixel assertions
(`04-combat` requires ≥8 rigs at ≥900 px each). I looked at the PNG: a full enemy
field, damage numbers, tracers, the survivor centre-left. The one remaining failure
is an unrelated VFX shortfall in `10-inventory` (563 px against a floor of 800).

## 4. Why the harness change is a fix and not a mask

It attacks the mechanism, not the symptom:

- `faceOpenGround()` (`src/core/Harness.js:548`) commits each candidate bearing to
  the rig, renders two frames, and measures against the camera that will actually be
  used. This is the direct fix for "the survivor's inherited heading faced the drop".
- `groundAtScreen()` (`:894`) inverts the placement problem: it marches a *screen*
  ray and returns the first thing it hits, so anything stood there is on-screen and
  unoccluded by construction rather than by a test that can be fooled.
- `visibleFraction()` (`:852`) samples the subject's projected box (`cols × rows`)
  instead of one centre ray — the single-ray version is what let a tree trunk over a
  third of the composition pass.
- `mustContain()` measures **rendered pixels** by hide-and-diff, so the manifest can
  no longer report `ready: true, errorCount: 0` over an empty frame, and
  `capture.mjs` now exits non-zero on it.

**One honest caveat.** `declutter()` (`:494`) teleports any enemy that fails the
distance / screen-overlap / visibility test onto a `screenSlots` position. That is
staging: `04-combat` is now a composed photograph rather than an emergent one, and
the harness has consequently lost the ability to detect "the director spawns
monsters where the player cannot see them". That is a limitation of the instrument,
not a rendering bug, and it has **no gameplay analogue** — `Director.findSpawnPoint`
(`src/systems/Director.js:578-601`) deliberately spawns *off-screen* by design and
lets monsters walk in, whereas `spawnRing` is a synthetic construction that plants
24 bodies on a bearing off camera-forward at a fixed radius. Nothing in real play
does what `spawnRing` did.

## 5. Secondary finding (not the reported bug, but record it)

**The RoR2 death dissolve never runs on monsters, and the obvious one-line fix for
that arms a real invisible-enemy bug.**

`VFX._onKill` calls `deathDissolve(resolveObject(p.victim))`
(`src/systems/VFX.js:1022-1023`). `resolveObject` (`src/systems/VFX.js:1424-1431`)
looks for `entity.mesh`, `.group`, `.root`, `.object3D`, `.object` — an `Enemy`
carries its Object3D at **`entity.rig.root`**, which is not in that list. Measured:

```
Enemy shape: { hasMesh:false, hasGroup:false, hasRoot:false, hasObject3D:false,
               hasRig:true, rigRootIsObject3D:true }
_dissolving.length before kill: 0
_dissolving.length after  kill: 0      <- deathDissolve never fires
_dissolving.length after explicit deathDissolve(rig.root): 1
```

So the signature RoR2 death effect is dead code for enemies (host *and* client — the
client's `kill` payload is `sanitise`d to plain data at
`src/net/NetHost.js:205-213`, so `resolveObject` returns null there too, despite
`NetViews.js:56` setting `this.group = this.rig.root` specifically for it).

**The trap:** `_updateDissolves` ends a dissolve with

```js
// src/systems/VFX.js:1268-1274
if (k >= 1) {
  d.mesh.visible = false;
  d.handle.release();
  this._dissolving.splice(i, 1);
}
```

`d.mesh` is `rig.root`. The dissolve runs 0.85 s (`dur: 0.85`, `VFX.js:563`); the
reaper only releases a rig after `DEATH_TIME = 1.5 s`
(`src/entities/Enemy.js:24,1200`), so the ordinary death path is safe. But
`Director.clear(ctx)` (`src/systems/Director.js:718-732`, called on every
`stageStart`) despawns *immediately* regardless of `finished`, and `_dissolving` is
never cleared on a stage change. Kill something, transition within 0.85 s, and the
rig goes back to `POOL`, is re-acquired by a new enemy on the new stage, and then
`d.mesh.visible = false` fires **on a live, damageable monster** — which stays
invisible until it dies (only `S.DIE.enter` sets it back). That is precisely the
"live entity, no pixels" shape the brief was hunting for.

Note that `DissolveShader.makeDissolvable().release()` already guards this exact
hazard for materials — `if (r.child.material === r.swapped)` with the comment "a
pooled rig respawning mid-dissolve" (`src/shaders/DissolveShader.js:200-204`). The
visibility line at `VFX.js:1269` was simply not given the same guard.

**Minimal fix, when someone wires the dissolve up** (do both, not one):

1. `src/systems/VFX.js:1424` — add `entity.rig?.root` to `resolveObject`'s candidate
   list (this is what makes the effect exist at all).
2. `src/systems/VFX.js:1269` — do not hide a recycled rig. Record an owner token at
   `deathDissolve` time and check it on completion, e.g. capture
   `d.owner = mesh.userData.epoch` where `resetRig` bumps `root.userData.epoch`, and
   guard `if (d.mesh.userData.epoch === d.owner) d.mesh.visible = false;`. A cheaper
   equivalent: drop the line entirely and let the death animation's own
   `rig.root.scale → 0` at `a.death > 0.75` (`src/entities/Enemy.js:1190-1192`) end
   the corpse, which it already does.
3. `src/systems/VFX.js` — clear `_dissolving` (calling `handle.release()` on each) on
   `stageStart`.

This is **not** the cause of the empty screenshots and is **not** currently
reachable. I am recording it because it is one plausible commit away from being the
shipping blocker the brief was worried about.

Also noted in passing, not investigated further: `acquireShadowSlot`
(`src/entities/EnemyMeshes.js:445-448`) hands out `SHADOW_MAX = 192` slots that are
never released — rigs live forever in `POOL`, so once 192 distinct rigs have been
built, every later rig silently loses its contact shadow. Cosmetic, not visibility.

## 6. Confidence, and what would change my mind

**Confidence in (A): high.** Not because the screenshots look right now — they did
before, to five agents — but because the failing frame was reproduced on the original
commit and every (B) mechanism was measured *on that frame* and found intact, while
the (A) mechanism was measured and found to fully account for it (0 of 24 enemies
both in-frame and unoccluded). 190 isolated draw measurements across two commits,
five pool generations, a stage transition and the full 22-rig roster produced zero
non-drawing live enemies.

**What would change my mind:**

- A live enemy observed with `rig.root.visible === false` while not `submerged`,
  `charging` or `dying`. My probes report this flag directly; it never appeared
  except on the one legitimately-submerged burrower.
- Any enemy scoring 0 in the isolated draw test. None did.
- A reproduction under conditions I did not exercise: **quality tier 0–2** (I ran
  quality 3 only, matching the capture), **the co-op client render path**
  (`NetViews.EnemyView` — never tested by anyone, and it is the one place
  `resolveObject` *would* resolve a rig if the payload weren't sanitised), or
  **`popCap`-saturated waves past 192 concurrent rigs** (shadow-slot exhaustion is
  cosmetic, but I did not push rig count that high).
- A shot where `mustContain` passes but a human sees no subject — i.e. the detector
  itself lying. I checked `04-combat.png` by eye against a passing manifest; they
  agreed.

## 7. Commands run

```
git diff --stat f9d85cf a06c6fe
git diff f9d85cf a06c6fe -- tools/capture.mjs src/core/Harness.js
git worktree add /tmp/ollie-old  f9d85cf --detach     # + node_modules junction
git worktree add /tmp/ollie-head 7f32fc5 --detach     # + node_modules junction
node tools/probe-old-combat.mjs 5341                  # (old worktree) replay + measure
node tools/probe-invisible.mjs --mode combat   --port 5321
node tools/probe-invisible.mjs --mode gameplay --port 5361 --cycles 6
node tools/probe-roster.mjs   5371 5
node tools/probe-dissolve.mjs 5391 300
node tools/probe-resolve.mjs
node tools/capture.mjs --out <scratch>/shots-head --port 5381
```

All probe scripts lived in the two throwaway worktrees (or, for
`tools/probe-invisible.mjs`, in the main tree) and **have been deleted**; both
worktrees are removed. The working tree is as I found it — the four in-flight
modifications by parallel agents (`src/systems/VFX.js`, `src/world/Environment.js`,
`src/world/Interactables.js`, `src/world/Materials.js`) and the two other agents'
scratch files are untouched. Note that `src/world/Environment.js` was mid-edit and
syntactically invalid at 13:05 (vite parse error at `Environment.js:104`), which is
why every measurement above was taken in a clean worktree at a committed revision
rather than on the working tree.
