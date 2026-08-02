# FIX-audit — the six confirmed findings assigned from `AUDIT-f9b47c4.md`

Six of the audit's eight findings. **C7 ("Time to the Fracture") was assigned to the
parallel agent and is not touched here.** C8 (the Fracture's under-taper) was not in
this work order and is not addressed.

Files changed — the four in the ownership list that needed a change. `RealmProps.js`
was read and needed none.

```
src/systems/VFX.js
src/shaders/ParticleShader.js
src/world/realms/RealmArena.js
src/world/realms/FinalBoss.js
```

## Verdicts

| # | finding | verdict |
|---|---|---|
| 1 | `VFX._ringAxis` defeats `RingFrag`'s edge-on fade | **fixed** — measured, and the arcs are gone from the frame |
| 2 | the 0.05 nova alpha floor | **fixed** — layer split, and 0.05 re-justified against a control captured here; 0.18 measured and rejected |
| 3 | `roomWall`/`roomCeiling` mutate the caller's material to `BackSide` | **fixed** — dais riser and column form both return |
| 4 | the Fracture's 96 undrawable rim teeth | **fixed** — the rim is serrated in the 4x crop |
| 5 | cosmetic boss/ward art behind `ctx.authority` | **partially fixed** — `_dressBoss` and the finale's HUD/pipeline cosmetics ungated; **the phase-2 tethers are not**, and nothing here is verifiable |
| 6 | the vault fill light lights the floor, not the chest | **fixed** — chest face +23.1%, floor pool −1.1% |

**Failing-shot set: `04-combat`, `06-loaded-hud`, `08-explosion`, `11-bestiary`.**
Four, the documented four, no fifth (`reviews/round6/audfix/manifest.json`,
`clockPinned: true`, `ready: true`, `partial: false`).
Realms: **`23-realm-crucible` only**, before and after
(`reviews/round6/audfix-realms-pre/manifest.json` →
`reviews/round6/audfix-realms/manifest.json`), with that subject's `px` unchanged at
**3326**.

---

## 0. Instrument and baseline, before any claim

**Instrument.** `<scratchpad>/stats.mjs` (the audit's own script, reused read-only).
Calibrated against the audit's published figures before scoring anything, and it
reproduces them to the digit:

| file | region | audit says | this run |
|---|---|---|---|
| `reviews/round6/base/08-explosion.png` | whole frame | 93.84 | **93.84** |
| `reviews/round6/base/08-explosion.png` | x 1150-1600 / y 250-850 | 118.71 | **118.71** |
| `reviews/round5/base-r4/08-explosion.png` | whole frame | 91.07 | **91.07** |
| `reviews/round5/base-r4/08-explosion.png` | same region | 88.05 | **88.05** |

**Baseline.** `reviews/round6/base/` is *not* the pre-fix state for this work — it is
`fba0a91`, four commits back. The pre-fix state is the committed tree this task
started from, captured here as **`reviews/round6/audfix-pre-full/`** (full run, seed
1337, `clockPinned: true`). It reproduces the committed
`reviews/round6/merged3/manifest.json` exactly: same four failing shots, same `px` on
every failing subject. **Every "before" number below is decoded from
`audfix-pre-full/`, not from `base/`, and where the two differ I say so.**

**Capture arms, all full runs at seed 1337, all `clockPinned: true`:**

| dir | tree |
|---|---|
| `reviews/round6/audfix-pre-full/` | pre-fix |
| `reviews/round6/audfix-A/` | all fixes, `LENS_FLOOR = { add: 0.05, alpha: 0.05 }` |
| `reviews/round6/audfix-B/` | all fixes, `{ add: 0.05, alpha: 1.0 }` |
| `reviews/round6/audfix-C/` | all fixes, `{ add: 0.18, alpha: 1.0 }` |
| `reviews/round6/audfix/` | **final** (identical tree to arm B) |
| `reviews/round6/audfix-realms-pre/` | pre-fix realms, from a throwaway worktree at `HEAD` |
| `reviews/round6/audfix-realms/` | final realms |
| `reviews/round6/audfix-crops/` | the 4x/6x crops named below |

Realms "before" was captured from a `git worktree` at `HEAD` with only `node_modules`
junctioned in, because by then this tree already carried the fixes. The prior
`reviews/round6/base/realms/` could not be used: `VERIFIED.md` records that it was
taken through an **unpinned** clock. Both realms arms here read `clockPinned: true`.

**Confound, stated not hidden.** A parallel agent committed `c315928` (a string-only
branding pass) into the shared tree partway through. `audfix-pre-full` predates it;
`audfix-A/B/C/audfix` follow it. It does not confound anything measured here: the four
failing shots and *every* number in `08-explosion`'s subject block are bit-identical
across that boundary (see §1b).

---

## 1. `VFX._ringAxis` — **fixed**

`src/systems/VFX.js`. The test moved off the camera ray and onto the blast's own
geometry. A blast is an airburst when the terrain under it is further away than its own
radius — i.e. when the ground is not inside the blast at all. `ctx.stage.sampleHeight`
is the sampler (the same one `Harness.js:273` uses); no sampler means "assume ground",
so the fade wins. The lens-height test survives as a *second* condition, because
tilting a true airburst's ring is only worth doing when the fade would have eaten it.
`explosion` now passes `r` so the test has a scale to work against.

The audit's own numbers for `08-explosion` (blast lifted 2.4-4.4 m, radius 6) put it
firmly on the ground side of that test, which is the intended result: a 6 m fireball
whose centre is 3 m up is half buried in the hill it is standing on.

**Measurement.** `reviews/round6/audfix-pre-full/08-explosion.png` →
`reviews/round6/audfix/08-explosion.png`, both 1600x900:

| region | before | after | |
|---|---|---|---|
| **x 1150-1600 / y 250-850, mean L** | **74.20** | **55.08** | **−25.8%** |
| whole frame, mean L | 91.57 | 81.24 | −11.3% |
| whole frame, %>L220 | 1.60 | 1.35 | |
| that region, %>L220 | 0.76 | 0.73 | |
| that region, mean RGB | 96.4/68.8/62.0 | 71.1/50.1/57.4 | |

The audit's 118.71 was measured on `reviews/round6/base/08-explosion.png` and is
reproduced above in §0; the pre-fix number *for this tree* is 74.20, because the shot
has moved since `fba0a91`. The defect is identical in both — the frame contains no
shockwave at all, only ~25 m ellipse arcs crossing three edges of the frame as
unrelated light streaks. Compare `audfix-pre-full/08-explosion.png` with
`audfix/08-explosion.png`: the arcs are gone and the frame reads as a scene again.

### 1b. `08-explosion`'s "the blast" failure is **not** closed, and could not have been

The work order asked me to say whether finding 1 fixes it. **It does not, and no VFX
change can, because the metric does not observe the VFX.** Across five full captures
whose `08-explosion` frames differ by up to **10.3 L whole-frame and 19.1 L in the
right third**, the subject block is *bit-identical*:

| capture | px | carriedPx | lum | bgLum | sep | legible |
|---|---|---|---|---|---|---|
| `audfix-pre-full/manifest.json` | 640 | 357 | 32.7 | 18.6 | 0.236 | 0.558 |
| `audfix-A/manifest.json` | 640 | 357 | 32.7 | 18.6 | 0.236 | 0.558 |
| `audfix-B/manifest.json` | 640 | 357 | 32.7 | 18.6 | 0.236 | 0.558 |
| `audfix-C/manifest.json` | 640 | 357 | 32.7 | 18.6 | 0.236 | 0.558 |
| `audfix/manifest.json` | 640 | 357 | 32.7 | 18.6 | 0.236 | 0.558 |

`Harness.js:1857-1861`'s own comment records this mask at **11,143 px**. It now reports
640, against `minPixels: 1200`. A mask that fell 17x and then stopped responding to the
thing it measures is not a blast that got smaller — it is a broken measurement.
`vfxObjects(/^vfx\.(particles|rings|trails|beams)$/)` still matches four objects and
reports all four visible, so the regex is not the fault; the hide-and-diff pass is.
**Routed to the `Harness.js` owner. Do not tune VFX against this number** — it is the
round-5 "aggregate hiding an absence" lesson in a new place, and the five rows above
are the reproduction.

Side effect worth recording: the frame-crossing arcs were never counted by this gate
either, so removing them cost the shot nothing.

---

## 2. The nova alpha floor — **fixed**

`src/shaders/ParticleShader.js`. Two separate things were wrong and both are addressed.

**(a) One floor for two blend modes.** The fade now reads a `uLensFloor` uniform, and
`createParticleMaterial` sets it from the `additive` flag it already receives — so
`src/fx/ParticleSystem.js` (not owned here) needs no change. Additive quads keep a
floor because their failure mode is accumulation; the alpha layer gets `1.0`, because
an alpha-blended quad occludes and cannot sum past clip.

**(b) The value, re-justified against a control captured for the purpose.** The audit's
objection was that 0.05 was fitted across a commit that also carried `#define DET_KILL
0.0`, so the `06-loaded-hud` control had itself moved (67.50 → 69.63) and the
comparison proved nothing. `DET_KILL` is gone. Three full captures, identical trees
apart from `LENS_FLOOR`, measured over the 3D-only region **x 520-1600 / y 110-760**
(the item strip and both HUD bars excluded — including them contaminates the comparison
badly, since `10-inventory` carries ~90 bright tiles that `06-loaded-hud` does not):

| arm | file | `06-loaded-hud` control | `10-inventory` | excess | `08-explosion` |
|---|---|---|---|---|---|
| add .05 / alpha .05 | `reviews/round6/audfix-A/` | 68.33 | 90.18 | +21.85 | 82.24 |
| add .05 / alpha 1.0 | `reviews/round6/audfix-B/` | 68.34 | 90.14 | **+21.80** | 82.20 |
| add .18 / alpha 1.0 | `reviews/round6/audfix-C/` | 68.39 | 93.86 | +25.47 | 82.74 |

(Files: `audfix-{A,B,C}/{06-loaded-hud,10-inventory,08-explosion}.png`.)

The control holds to **0.06 L** across all three arms, which is what makes the rest
readable — that is the fixed reference the previous tuning did not have.

**Restoring 0.18 is rejected on the measurement, not on deference.** It costs **+3.7 L
of wash on the one shot the constant exists for** and buys **+0.54 L** on the blast
shot. 0.05 stays, and it is now defensible for the reason it never was: it applies only
to the layer whose failure mode is additive accumulation.

**Correction to the audit, from the arithmetic.** C4 claims the dust skirt is "drawn at
5%" in the captured frames because its `subtense` is 1.10. That uses `size1`, the size
at *death*. The shader uses `size = mix(aSize.x, aSize.y, u)`, and at these shutters
`u` is small, so the dust is near `size0 = r * 0.28` — a subtense of ~0.28, below the
0.30 knee. The defect in principle is real and is fixed; **its measured magnitude on
the shipped shots is under 0.2 L** (A vs B: `10-inventory` −0.04, `08-explosion` −0.04,
`10-inventory` nova region x 520-1080 / y 480-860 92.55 → 92.41). I am not claiming a
visual improvement I cannot show. What the change buys is that a future tuning of the
additive constant can no longer silently attenuate the effect's only opacity.

---

## 3. `roomWall` / `roomCeiling` mutating a material they do not own — **fixed**

`src/world/realms/RealmArena.js`. A `backSided(mat)` helper clones before setting
`side`. The same pattern was applied to `buildFracture`'s `under.material.side =
DoubleSide`, which was mutating the `edge` rung shared by the rim teeth and the
monoliths — same defect class, same file, one clone.

**Dais.** `reviews/round6/audfix-crops/dais-pre.png` → `dais-post.png` (6x crop of
x 575-735 / y 500-630 of `audfix-realms-pre/22-realm-bazaar.png` and
`audfix-realms/22-realm-bazaar.png`). Before: a flat white disc flush with the floor,
no riser, no step between the tiers — exactly as the audit describes. After: both
risers and the step between the two tiers are drawn, with a shadowed contact band.

**Columns.** `reviews/round6/audfix-crops/col-pre.png` → `col-post.png` (4x crop of
x 40-260 / y 330-530). Before, the column body is partly see-through — the wall behind
is visible through it, and the flat-shaded back face gives a single neutral value.
After it is a solid object with three separable faces.

| region (`22-realm-bazaar.png`) | pre | post |
|---|---|---|
| column lit face, x 97-122 / y 385-455 | 101.60 | **120.31** |
| wall behind it, x 195-250 / y 395-440 | 60.12 | 60.18 |
| **column : wall** | **1.69 : 1** | **2.00 : 1** |
| polished floor, x 620-860 / y 700-760 | 185.25 | 186.06 |
| audit's column strip, x 70-110 / y 380-470 | 108.50 | 99.68 |

The audit's own two figures reproduce on the pre arm to within 0.1 L (108.4 / 185.2),
which confirms the pre state is the state it audited.

**Two honest caveats.** The audit's column strip goes *down*, 108.5 → 99.68, because
that strip now contains the column's genuinely dark right face instead of a
derivative-shaded flat — its mean RGB goes from neutral 106.5/109.3/106.5 to warm
118.4/121.1/117.7 on the lit face, which is the lantern actually reaching it. And the
commit's stated target of **≥2.5:1** column-to-wall is still **not met at 2.00:1**, and
the pale columns still measure darker than the polished floor's specular band. The
back-face bug was one cause of that, not the only one; the remaining gap is a lighting
decision, not this defect.

Crucible cover blocks and brazier bowls (which share `iron` with both helpers) are
fixed by the same clone; `23-realm-crucible` measures identically before and after
(`px 3326`), so nothing regressed there.

---

## 4. The Fracture's 96 rim teeth — **fixed (made to render)**

`src/world/realms/RealmArena.js`. All four causes addressed rather than one:

1. teeth now seat at `1 - len*0.35` and project to `1 + len*0.65` of the floor radius,
   so the visible part is **outside** the floor disc, over the void;
2. they straddle the floor plane instead of sitting under it;
3. the geometry is pre-scaled `(1, R*0.55, 1)` to cancel `onFloorRadius`'s X/Z-only
   scale, so a tooth is ~0.5-0.7 m tall instead of 2-3 cm;
4. the rotations are baked in the right order **inside the loop** and handed to
   `mergeParts` as finished geometry, so `ry` is no longer applied to a cone that still
   points along +Y and then overwritten by a shared `rz`. All 96 now point radially.

`mergeParts` itself is unchanged — every other caller in the file relies on its
current order.

**Evidence:** `reviews/round6/audfix-crops/rim-pre.png` → `rim-post.png` (4x crop of
x 20-340 / y 470-690 of `audfix-realms-pre/26-finale-phase2.png` and
`audfix-realms/26-finale-phase2.png`). Before: an unbroken, perfectly smooth magenta
band — the critique this block was written to answer, unchanged. After: the band is
broken by teeth of alternating length and pitch overhanging the void.

---

## 5. Cosmetic boss and ward art behind `ctx.authority` — **partially fixed**

`src/world/realms/FinalBoss.js`.

**Fixed.** `FinaleController.enter`'s `if (!ctx.authority) return;` was the first line
of the method. It now runs `_dressBoss` (the broken ring, the trailing spar, and the
key/fill `PointLight`s that are the whole answer to the Herald photographing as one
flat pink value), the finale's boss sub-line, the shake and the objective line
**before** the gate. The gate now covers only what NETCODE.md says it should: spawning
the entity, claiming `director.boss`, and emitting `bossSpawn`.

**Not fixed, and deliberately so: the phase-2 tethers.** `_buildWardArt` is reached only
from `_raiseAnchors`, reached only from `_enterPhase`, reached only past
`fixedUpdate`'s authority gate. The art is built from the `Enemy` instances that method
spawns, and a client has no local equivalent — its anchors arrive as snapshot views
through `src/net/NetViews.js`, and nothing in `FinalBoss.js` is told about them.
Closing it needs a client-side hook in `src/net/` or `Realms.js`, neither of which this
task owns. I did not add discovery machinery for it: there is no way to test it, and
speculative code on an untestable path is worse than a recorded gap. The gap is
documented in the `_raiseAnchors` doc comment.

**What I cannot verify, plainly.** **No two-peer co-op session has ever been run under
`PROTOCOL_VERSION` 2.** The capture harness is single-player, so `ctx.authority` is
`true` in every frame this repo has ever photographed and *none* of the client-path
behaviour above — before or after the change — has been observed. Everything I say
about what a guest sees is read off the call graph (`Realms.js:254` does call `enter`
when `replicated`), not off a running client. The change is justified by NETCODE.md's
rule and by the call graph, and by nothing else.

Single-player is unaffected by construction (`ctx.authority === true`), and the realms
captures agree: `26-finale-phase2` "the Herald" goes 900 → 1148 px and
`27-finale-phase3` 1204 → 1386 px (`audfix-realms-pre/manifest.json` →
`audfix-realms/manifest.json`), because the two modelling lights now exist before the
rig compiles rather than after. No realms subject got worse.

---

## 6. The vault fill light — **fixed**

`src/world/realms/RealmArena.js`. `(0, 3.2, −7.5)` at 46/16/1.9 → `(0, 2.9, −3.0)` at
27/9/1.9. The fill now stands just off the dais lip: the chest's front face is 2.2 m
away and the nearest surface it can pool on is the dais top 2.1 m below it — the
prize's own plinth, not open floor. Range cut to 9 m so it cannot reach the pillars.

`reviews/round6/audfix-realms-pre/24-realm-vault.png` →
`reviews/round6/audfix-realms/24-realm-vault.png`:

| region | before | after | |
|---|---|---|---|
| chest front face, x 735-880 / y 425-515 | 89.84 | **110.61** | **+23.1%** |
| floor pool the fill used to make, x 260-680 / y 640-790 | 66.86 | 66.11 | −1.1% |
| far wall, x 60-440 / y 200-290 | 47.11 | 46.15 | −2.0% |
| chest : floor-pool ratio | 1.34 | **1.67** | |

The harness agrees, from its own instrument: `24-realm-vault` "the vault chest" goes
`px 1852 → 1938`, `lum 34.8 → 48.1` against `bgLum 31.4 → 28.3`
(`audfix-realms-pre/manifest.json` → `audfix-realms/manifest.json`). The subject got
brighter and its background got darker at the same time, which is the shape the
finding asked for. The broad gold wash across the lower half of the frame is gone and
the far wall falls off, as the room's stated rule requires.

---

## Not touched, on instruction

- **The `deathDissolve` trap.** `VFX.js`'s `resolveObject` is unchanged, no sibling
  guard, no half-fix. Left exactly as the two previous agents left it.
- **C7 "Time to the Fracture"** — the parallel agent's.
- **`src/data/*`, `src/ui/*`, `src/core/Harness.js`, `src/world/{Interactables,Props,Materials}.js`,
  `src/systems/{Items,Progression}.js`, `src/world/realms/Realms.js`** — read, not
  edited. `git status -- src/` lists exactly the four files above.

## Toolchain

`npx` was never invoked. Builds were `node node_modules/vite/bin/vite.js build`; the
final tree builds clean. Captures used `--port 5221` (`capture.mjs`) and `--port 5222`
(`capture-realms.mjs`) into the `audfix*` directories only. `shots/` was never written.

**New toolchain hazard, caused by me and logged so it does not recur.** The realms
"before" arm needed a clean tree, so I made a `git worktree` and gave it
`node_modules` as a Windows directory junction (`mklink /J`) to the main checkout's.
**`git worktree remove --force` followed that junction and deleted the real
`node_modules`** — 0 entries left, build dead. Repaired with `npm ci`, run through the
*bundled* npm rather than the shim: `C:\Program Files\nodejs` has npm **6.13.6** on
PATH but ships npm **11.12.1** at `node_modules/npm/bin/npm-cli.js`, so

```
node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" ci
```

installs from `package-lock.json` (lockfileVersion 3) without the 6.13.6 code path that
has already cost this project two outages. `package.json` and `package-lock.json` are
unmodified afterwards; build, and a `--only 01-title` capture, both verified green.
**If you use a worktree, copy `node_modules` or symlink the other way — never junction
a directory you cannot afford to lose into something `--force` will delete.**

## Open items for whoever picks this up

1. **`08-explosion`'s "the blast" metric is dead** (§1b). Five captures, bit-identical.
   `Harness.js`'s own comment records the mask at 11,143 px; it reports 640. Fix the
   measurement before anyone tunes a VFX constant against it.
2. **The bazaar columns are at 2.00:1 against a stated 2.5:1** (§3). The back-face bug
   was one cause; the rest is a lighting call in `buildBazaar`.
3. **The phase-2 tethers are still authority-gated** (§5), and no co-op path in this
   repo has ever been executed.
