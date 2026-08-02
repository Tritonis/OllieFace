# FIX-harness2 — round 6, harness measurement defects

Owned files touched: `src/core/Harness.js`. **`tools/capture.mjs` was not
changed** — nothing in this pass needed it, and it behaved correctly under a
concurrent-write boot failure (see §5).

`reviews/round6/FINAL/` was not written to, read only.

## Capture directories, and what each one is

Every number below names the file it was decoded from. Nine captures, all
`clockPinned: true`, `partial: false`, seed 1337, full runs:

| dir | code state | why it exists |
|---|---|---|
| `reviews/round6/hdiag/` | shipped code + read-only diagnostics | **BEFORE.** Reproduces `reviews/round6/FINAL/manifest.json` exactly on every subject discussed here |
| `reviews/round6/hdiag-only/` | same, `--only 08-explosion` | control: the same code measuring the same effect on a different frame |
| `reviews/round6/hdiag2/` | BEFORE **+ `_pinSoftResolution` only** | the controlled A/B for job 1 |
| `reviews/round6/hdiag3/` | + horde placement diagnostics | why `06-loaded-hud` regressed |
| `reviews/round6/hdiag4/` | + `screenSlots` even-stride | **refuted**, §3.1 |
| `reviews/round6/hdiag5/` | + `declutter(12, { maxDist: 28 })` in `lateRun` | the `06-loaded-hud` fix |
| `reviews/round6/hdiag6/` | + `04-combat` `{ supply: 26, nearFirst: true }` | **refuted**, §3.2 |
| `reviews/round6/hfix2/` | + victim ring biased down frame | **refuted**, §3.3 |
| `reviews/round6/hfix4/` | **as delivered** | AFTER |

`reviews/round6/hfix/` and `hfix3/` are also as-delivered but were captured
while other agents were writing `Stage.js`, `VFX.js`, `Environment.js`, `HUD.js`
and `Materials.js`; **do not cite them.** See §5.

## Headline

| shot | BEFORE (`hdiag/manifest.json`) | AFTER (`hfix4/manifest.json`) |
|---|---|---|
| `08-explosion` | `the blast` **FAIL** — 640 px / 357 carried | **PASS** — 22,328 px / 12,347 carried |
| `06-loaded-hud` | `monsters under load` **FAIL** — `perPx [6,22,27,…]` | **PASS** — `perPx [33,142,140,…]` |
| `04-combat` | `horde` FAIL, 6 failing objects | FAIL, 6 failing objects — **not fixed** |
| `11-bestiary` | `the whole spawn roster` FAIL, object 4 | FAIL, object 4 — **not fixed** |
| failing shots | **4** | **2** |

No threshold moved. `git diff src/core/Harness.js` contains no change to
`minPixels`, `minCarriedPx`, `minSeparation`, `MIN_SEPARATION`, `minObjects`,
`crowd`, `need`, `OPEN_GROUND_NEED` or `MIN_VISIBLE` on any line that is not a
comment.

---

## 1. Job 1 — the `08-explosion` blast gate — **FIXED**

### It was not the pools, and it was not the blast

Both of the brief's hypotheses are refuted on disk, and so is mine.

- **The regex still matches everything it names.** `reviews/round6/hdiag/manifest.json`
  → `08-explosion` → `DIAG pools` lists one object per name, no duplicates, no
  stale set: `vfx.particles`, `vfx.trails`, `vfx.decals`, `vfx.beams`,
  `vfx.rings`, `vfx.damageNumbers`.
- **The blast was not occluded.** Same check, `DIAG blast` → `occluders: []` —
  a `THREE.Raycaster` cast from the lens to the blast centre over the whole
  scene, excluding the VFX pools, at the frozen frame. Nothing is in front of a
  6 m fireball 11.2 m away. `sphereVisible: 0.75`.
- **The pixels were where the blast is.** `corePx: 596` of the 640 fall inside a
  disc of 1.2 blast radii about its projected centre. The gate was looking in
  the right place and seeing almost nothing there.

### What it actually was

`vfx.particles` rendered **619 px** and `vfx.rings` rendered **0**
(`hdiag/manifest.json`, `DIAG pools`). The same code, the same effect and the
same shutter measured **19,323** and **23,977** on a differently-framed run
(`reviews/round6/hdiag-only/manifest.json`).

The cause is in the mask pass, in my file:

`ParticleShader.js:277` and VFX's `RingFrag` (`VFX.js:1943`) fade a soft
particle against the scene depth sampled at `gl_FragCoord.xy / uResolution`.
`uResolution` is set — correctly, for the real frame — to the **drawing buffer**
size, 1600x900 (`ParticleSystem.js:308`, `VFX.js:2033`). `subjectReport` renders
its two mask passes into a **480x270** offscreen target. Every fragment's
`gl_FragCoord` therefore lands in the bottom-left 30% x 30% of that division:
the whole effect is faded against the depth of *the bottom-left corner of the
frame*. Where that corner holds near foreground — which is most third-person
framings — `(vViewZ - sceneZ)` goes negative, alpha clamps to zero, and the
fragment is `discard`ed.

**That is why the number was frozen.** It was not tracking the blast, the VFX
code or the framing of the subject; it was tracking the depth of one corner of
the frame, which none of the five captures in the brief changed.

### The fix

`_pinSoftResolution` (`Harness.js`, next to `maskPass`) retargets every material
in the scene that declares both `uDepth` and `uResolution` at the buffer being
rendered into, for the duration of the mask renders, and restores it after.

It is exact, not an approximation: `uDepth` is a *full-frame* depth texture at
half canvas resolution, same camera, same frustum, and the shader's division
exists only to turn `gl_FragCoord` into a [0,1] frame UV. Setting `uResolution`
to the render target restores that identity. Nothing is disabled, no fade is
switched off, and no threshold moved. It is collected by scene traversal rather
than by naming `ctx.vfx.particles` and `ctx.vfx.rings`, so a pool added later
inherits the fix instead of the bug.

### Evidence that the gate observes the VFX again — it *moves when the frame moves*

`reviews/round6/hdiag/manifest.json` → `reviews/round6/hdiag2/manifest.json` is
a controlled pair: captured four minutes apart, the only file written in that
window was my `Harness.js`, and the only change in it was `_pinSoftResolution`.

| | `hdiag` | `hdiag2` |
|---|---|---|
| `vfx.particles` mask px | **619** | **22,377** |
| `the blast` px / carried | 640 / 357 — FAIL | 22,379 / 12,376 — PASS |
| `10-inventory` `the equipment blast` px | 5,690 | 22,672 |

I diffed **every** pixel check in both manifests. The only subjects that moved
by more than 3 px are the two VFX ones above. `04-combat/horde` went 9,681 →
9,679, `05-boss/the Basalt Colossus` 7,093 → 7,094, `07-interactables` 21,198 →
21,197. The fix touches soft particles and nothing else.

And the number is no longer frozen. Across six captures of six different frames
it reads **22,379 / 33,465 / 30,390 / 27,679 / 22,328 / 22,400**
(`hdiag2`, `hdiag4`, `hdiag6`, `hfix2`, `hfix4`, `hfix3`), against **640 in five
consecutive captures** before the fix.

### What a zero inside this check looks like

The gate is unchanged: `px >= 1200` and `carriedPx >= 1200` over the union.
Three things were added around it so a zero cannot hide:

- **`perObject: true` and `detail.pools`.** `minCarriedPx` used to buy an
  exemption from per-object reporting on the grounds that shared pools are not
  nameable objects. They are not nameable *to a viewer*; they are perfectly
  nameable in a manifest, and that exemption is how a pool at exactly zero
  stayed inside a union sum for five captures. `hfix4` now records
  `perPx [22326, 0, 23, 0]` beside `pools ["vfx.particles", "vfx.trails",
  "vfx.beams", "vfx.rings"]`. The zeros are on the record, by name.
- **It is deliberately *not* gated per pool.** On this frame `vfx.rings` is
  legitimately 0: `RingFrag` fades a ground-plane ring as it goes edge-on below
  `|dot| = 0.28`, and this lens sits about 7.6 deg above a blast 11 m away —
  the guard working, not a missing ring. A per-pool floor would fail the shot
  for a ring that is correctly absent. The zero is published so a reader decides
  that; a sum no longer decides it for them.
- **`region`.** The four pools carry every effect alive in the frame. The check
  now counts only pixels inside a disc of two blast radii about the blast's own
  projected centre, so what is measured is the event this scenario fired, at the
  place it fired it. It is strictly subtractive — every pixel it removes was
  being counted before — so nothing can pass under it that failed before. `at`
  and `box` publish where the counted pixels landed; a blast measured at the far
  corner of the frame is now visible as such.

A zero, concretely: `px: 0` fails `present`; a pool that stops emitting shows as
its own `0` in `perPx` next to its name in `detail.pools`; an effect that fires
somewhere other than where the scenario sited it shows as an `at`/`box` away
from `detail`'s blast position and as a collapsed `px` because the region
excludes it.

### Consequence outside `08-explosion`

`10-inventory` → `the equipment blast` was **passing on a broken measurement**:
5,690 px BEFORE, 25,121 px AFTER (`hdiag` → `hfix4`). Every VFX pixel number
taken through `subjectReport` before this commit — including round 5's and round
6's — understated soft-particle effects by roughly 4x, and by 30x on
`08-explosion`. Nothing that *passed* on such a number is invalidated (the fix
only ever adds pixels), but anything **tuned** against one should be re-measured.

---

## 2. Job 2 — `06-loaded-hud` — **FIXED**

Diagnosed before changing anything, in `reviews/round6/hdiag3/manifest.json` →
`06-loaded-hud` → `DIAG horde`, which dumps every enemy's distance from the lens,
screen position and card id at the shutter:

```
40.1/mite  44.0/beetle  38.1/spitling  29.4/lemurian  33.7/wisp
30.8/pest  20.1/harrier 25.7/charger   32.8/burrower  34.8/brood
```

`spawnRing(10, SPAWN_CARDS, 14, 3)` asks `screenSlots` for a 14-47 m band.
`screenSlots` fills row 0 — the `maxDist` rank — across all thirteen columns
before it touches row 1, so **any caller asking for thirteen or fewer bodies
gets every one of them at the far edge of its own band**, and the three smallest
cards in the deck (mite, beetle, spitling are `SPAWN_CARDS[0..2]`) drew the
three longest ranges. A mite at 40 m is 6 px. That is the regression the
`screenSlots` rewrite introduced.

It is a supply-order defect, not a camera one — which is exactly why
`placeForOpenArena()` returned byte-identical pixels and is correctly recorded as
refuted in the predecessor's comment. I did not re-try it.

**Fix:** `declutter(12, { maxDist: 28 })` in `lateRun`, replacing `declutter(12)`.
This is the same mechanism and very nearly the same number `04-combat` already
uses for the same reason. It is a call-site framing change; `minPixels` is still
300 across ten objects and `MIN_SEPARATION` is untouched.

| | `hdiag/manifest.json` | `hfix4/manifest.json` |
|---|---|---|
| `perPx` | `[6, 22, 27, 251, 56, 68, 779, 230, 102, 151]` | `[33, 142, 140, 290, 367, 177, 779, 230, 100, 602]` |
| union px | 1,692 | 2,860 |
| weakest member | 6 px (absence floor 12) | 33 px |
| distances | 20.1-44.0 m | 17.5-26.3 m (`hdiag5`, `DIAG horde`) |
| verdict | **FAIL** | **PASS** |

---

## 3. Three fixes I applied, measured, and withdrew

All three are recorded as refutations in the source at the site they would be
re-attempted, with the manifest that refutes them named.

### 3.1 `screenSlots` even-stride sampling — REFUTED

Building the whole `ROWS x COLS` grid and taking `count` slots at an even
far-to-near stride. It did spread the depth (`hdiag4`, `DIAG horde`: 14.6-40.9 m)
and it made the capture worse in three places at once:

- `06-loaded-hud` `perPx [6,22,27,…]` → `[0,0,26,199,…]` — one failing object
  became **two at literally 0 px**;
- `08-explosion` → `damage numbers` started failing;
- `10-inventory` → `monsters standing in it` started failing;
- `04-combat` did not move **at all** — byte-identical `perPx` — because on that
  frame the grid yields fewer slots than the twenty-four it asks for, so the
  stride never engages.

Five failing shots against a documented four. Reverted.

### 3.2 `04-combat` `declutter({ supply: 26, nearFirst: true })` — REFUTED

`hdiag5`'s `DIAG horde` says why `04-combat`'s four zeros are zeros: object 0 is
a mite at 27.1 m standing at screen (0.52, 0.63), which is where the lemurian
15 m in front of it is standing; object 14 is a mortar at 29.7 m; objects 7 and
23 are chargers at screen x **-2.61** and **-1.38**, outside the frame
altogether. That reads as `_declutterPass` running out of cells.

Giving it the whole grid and taking from the near end (`hdiag6/manifest.json`):
the two off-frame chargers **did not move**, object 14 stayed at 1 px, and
objects 0, 1, 2 *fell* from 0/17/17 to 2/8/6 as the near rank was pulled across
them — six failing objects became **seven**. It also cost `08-explosion` its
`damage numbers` check. This scenario's layout feeds the next one's, so a change
here is never local. Reverted.

The `supply` and `nearFirst` options survive in `_declutterPass`, opt-in and used
by nobody, documented as available to a future caller with better evidence. Both
default to the previous behaviour, so no existing call site changed.

### 3.3 `08-explosion` victim ring biased down frame — REFUTED

Once the mask stopped being measured through the broken depth lookup, `damage
numbers` came back at `sepP50 0.23` against the 0.25 floor, with its mask
centroid at screen **(0.629, 0.246)** and `lum 63.9` against `bgLum 63.0` — white
glyphs over a sunset sky of exactly their own value (`hfix/manifest.json`).
Readouts spawn at their victims, so standing the ring lower should put them over
terrain.

Applied as `sin(a) * 0.10 + 0.07` and captured to `hfix2/manifest.json`: the
victims demonstrably moved (`monsters standing in it` `perPx
[134,97,55,1228,…]` → `[32,313,270,250,…]`) and the damage-number mask **did
not**, staying at (0.629, 0.244) with `sepP50 0.23` and `lum 63.9 / bgLum 63.8`.
Its centroid sits on the blast's own screen position (0.622), not on the
victims. Reverted.

---

## 4. The coordinator's fifth-instance finding: `contrast` — **closed, but not the way it was proposed**

The structural half is correct and is now closed. The inference drawn from it is
refuted, with named files.

**Correct:** `contrast` is computed, recorded, and read by no gate — as are
`sep`, `sepP25` and (for non-aggregate subjects) `legible`. Four of a `pixels`
check's seven published statistics decided nothing, and a reader had no way to
tell which. The round-2 critic quoted `contrast: 0.053` as a finding, and the
round-4 critic quoted `contrast 0.442 → 0.088`; both were reading a number no
gate had ever consulted.

**Refuted:** that this means the `04-combat` survivor is "nearly
indistinguishable from his background". `contrast` is `|Σls − Σlb| / Σ(ls + lb)`
— a signed mean, which this file already documents as cancelling — and the same
manifest records that survivor at `sepP50 0.41`, `lum 48.8`, `bgLum 59.0`
(`hdiag5/manifest.json`). Half his pixels differ from what is behind them by
more than 41% per-pixel Michelson. What changed is that he is no longer a
different *average value* from his background; that is a composition observation,
not a legibility one.

A `contrast` floor is refuted directly. Over the 502 pixel-checks on disk in
`reviews/round6/`, the empty band is between 0.101 and 0.264, so 0.15 is where
the `MIN_SEPARATION` method would put it. At 0.15 it would newly fail:

| subject | contrast | sepP50 | px | file |
|---|---|---|---|---|
| `24-realm-vault` / the vault chest | **0.052** | 0.51 | 1,852 | `reviews/round6/realms/manifest.json` |
| `22-realm-bazaar` / the survivor | **0.101** | 0.29 | 680 | same |
| `04-combat` / survivor | 0.094 | 0.41 | 846 | `reviews/round6/hdiag5/manifest.json` |

Two of those three sit in shots that currently **pass**, so the floor would add
two failures to catch one, and all three subjects are ones a viewer can see. A
chest with half its pixels above 50% Michelson separation reported as
`contrast 0.052` is the cancellation defect in one line.

**What I did instead.** Every `pixels` check now publishes `gatedOn` — the list
of comparisons that actually decided `ok` — and `notGated`, the statistics it
publishes and did not read. `hfix4`'s `04-combat` survivor now carries
`gatedOn: ["px >= minPx", "sepP50 >= minSep"]` and
`notGated: ["contrast", "sep", "sepP25", "legible"]`. The field stays published,
because the composition observation is worth having; it is now declared as
something no gate read, so no future critic can quote it as a certified
measurement.

**What a zero inside `gatedOn` looks like:** it is a list of names, not a count
and not a boolean, so an empty array is a `pixels` check that gated on nothing
at all and is visible on sight. Every name in it is a field present on the same
object, so a reader can re-derive the verdict from the numbers without being
told what it was.

---

## 5. What I could not verify, stated plainly

- **`08-explosion` → `damage numbers` is marginal at exactly its floor and flips
  run to run.** Four full captures of as-delivered or near-as-delivered code:
  `hdiag5` 0.25 PASS, `hfix` 0.23 FAIL, `hfix3` 0.25 PASS, `hfix4` 0.25 PASS —
  and 0.25 *is* the floor, i.e. it passes on equality. Its `px` also ranges
  147-284 across those runs. **A rerun of the delivered tree may show
  `08-explosion` failing on this check.** It was passing before at `sepP50 0.31`,
  but that number was produced by the broken depth path this pass removed, so
  the previous pass was not evidence. This is a real, pre-existing legibility
  problem the broken measurement was concealing, and §3.3 records the one fix I
  tried and withdrew. I have no fix for it.
- **The tree moved under three of my captures.** `Stage.js` was written at
  21:10, `Environment.js` 21:19, `HUD.js` 21:20, `VFX.js` 21:21 and 21:22,
  `Materials.js` 21:21, all by other agents. `hfix` (21:14) and `hfix3` (21:21)
  straddle those writes and **should not be cited**. `hdiag` (20:50) through
  `hdiag5` (21:05) and the controlled A/B pair `hdiag`→`hdiag2` are clean — no
  file but my own `Harness.js` was written between them. `hfix4` was captured
  after the writes settled. This is the reason I did not attribute the
  `damage numbers` variance to non-determinism: I cannot separate it from other
  agents' edits.
- **The two `hfix4` predecessors failed to boot** on a mid-write `VFX.js`,
  and `tools/capture.mjs` handled it exactly as designed: it wrote
  `00-FAILED-TO-BOOT.png` and `manifest.FAILED.json` and destroyed nothing. That
  is the predecessor's fix working under the condition it was written for.
- **`04-combat` is not fixed and I did not improve it.** `perPx` in `hfix4` is
  byte-identical to `hdiag`. Six failing objects: two on separation (object 3 at
  679 px / 0.23, object 17 at 258 px / 0.19) and four absent (objects 0, 7, 14,
  23 at 0, 0, 1, 0 px). §3.2 records what the absent four actually are and the
  one fix I tried and withdrew.
- **`11-bestiary` is not fixed and I did not touch it.** Object 4 sits at
  `sepP50 0.17` against the 0.25 floor in both `hdiag` and `hfix4`, with 1,287 px
  — it is not small, it does not stand off its background. The predecessor
  reached the same conclusion and I have no measurement that contradicts it.
- **I did not re-verify the realms capture set.** `tools/capture-realms.mjs` is
  not mine and I did not run it. The `_pinSoftResolution` fix is in
  `subjectReport`, which realms shots also use, so **every realms VFX pixel
  number should be re-measured after merge** for the same reason
  `10-inventory`'s moved 5,690 → 25,121.

## Left alone deliberately

- **`VFX.js` `deathDissolve` / `resolveObject`.** Not touched, not read, not
  fixed. Four agents have now correctly left it alone.
- **`ParticleShader.js` and `VFX.js`'s `RingFrag`.** The `uResolution` they set
  is *correct for the frame they are drawn in*. The defect was entirely in my
  file rendering into a differently-sized buffer without telling them. Fixing it
  in the shaders would have been fixing the wrong file.
- **`MIN_SEPARATION = 0.25`.** `11-bestiary` object 4 (0.17), `04-combat`
  objects 3 and 17 (0.23, 0.19) and `08-explosion`'s damage numbers (0.23-0.25)
  are all under or on it. I have no measurement showing the criterion is wrong
  for those subjects, so it stays.
- **`placeForOpenArena()` in `lateRun`.** Refuted by the predecessor with two
  named manifests. Not re-tried; the comment now also carries the real cause.
- **`tools/capture.mjs`.** No change needed.
- **`reviews/round6/FINAL/`.** Read only.
