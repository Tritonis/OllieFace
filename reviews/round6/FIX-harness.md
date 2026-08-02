# FIX-harness — round 6

Owned files touched: `src/core/Harness.js`, `tools/capture.mjs`. Nothing else.

**Every number below names the file it was decoded from.** Two capture
directories are cited throughout:

- **before** → `reviews/round6/base/manifest.json` (the immutable baseline; the
  PNGs beside it are `reviews/round6/base/*.png`)
- **after** → `reviews/round6/harness/manifest.json` (my own capture dir,
  `node tools/capture.mjs --out reviews/round6/harness --port 5201`, full run,
  seed 1337, `clockPinned: true`, `partial: false`; PNGs `reviews/round6/harness/*.png`)

Intermediate diagnostics are cited as `reviews/round6/diag-combat*.json` and
`reviews/round6/diag-b2.json` — these are dumps from a temporary probe that
replayed the capture order and recorded per-enemy world position, screen
position, distance, `rig.root.visible` and per-object mask pixels. The probe
tool has been deleted; the JSON remains.

---

## Headline

| shot | before (`base/manifest.json`) | after (`harness/manifest.json`) |
|---|---|---|
| `04-combat` | 3 checks failing | **1** failing (`horde`) |
| `08-explosion` | 2 checks failing (`monsters`, `damage numbers`) | **0 of mine**; `the blast` fails for a reason attributed below |
| `09-survivors` | failing | **PASSES** |
| `11-bestiary` | failing (6 of 16 objects) | failing (**1** of 16) |
| `06-loaded-hud` | passing | **regressed — mine, fix specified, unverified** |
| `18-difficulty` | already correct in `f9b47c4` | verified by decoding the PNG |

`subjectsOk` is `false` in both manifests. This is a partial result, stated as one.

---

## Job 1 — `18-difficulty` asserts and photographs the same rung

**Already landed in `f9b47c4`; I changed nothing.** The predecessor's
`restoreAfterShutter` (`Harness.js:171`, drained from `thaw()`) defers the
difficulty restore into the *next* scenario, so the shutter fires on the rung
that was asserted.

Verified by decoding the image, not by reading the code:
`reviews/round6/base/18-difficulty.png` shows **MONSOON** as the selected card —
red left rule, red fill, filled diamond — with DRIZZLE and RAINSTORM unselected.
`reviews/round6/base/manifest.json` → `18-difficulty` → check `a selected rung`
→ `detail: "monsoon"`. Assertion and pixels agree.

One correction to `reviews/round6/BASELINE.md`: it says `18-difficulty` and
`17-artifacts` "are written by a different tool than `capture.mjs` and are not in
this manifest". Both **are** scenarios in `tools/capture.mjs` (lines 62-76) and
both **are** in `reviews/round6/base/manifest.json`. The claim is wrong; the
files are captured normally.

---

## Job 2 — the four shots

### `09-survivors` — PASSES

One change: the row is framed to fill 0.80 of frame width instead of 0.68
(`Harness.js`, `survivors`). Area scales as fill², so this is ×1.38.

| | `base/manifest.json` | `harness/manifest.json` |
|---|---|---|
| `perPx` | `[897, 1199, 992, 986]` | `[1235, 1643, 1377, 1296]` |
| floor (`minPixels 4000` / 4 objects) | 1000 | 1000 |
| objects failing | 3 | **0** |
| `all four on one footline` | `spreadPx 0` | `spreadPx 0` |
| `no survivor occluded` | `[1,1,1,1]` | `[1,1,1,1]` |

Predicted before running: `[1240, 1659, 1372, 1364]`. Measured: within 5%. The
weakest survivor clears the floor by 24%, not by 1 px. No threshold moved.

### `04-combat` — 3 failing checks → 1

The baseline's three failures had **one** root cause, and it was not framing: the
survivor was standing in the wrong place. `reviews/round6/base/04-combat.png`
shows him on the lip of a rocky knoll; `reviews/round6/diag-combat.json`
(a replay of the baseline code, reproducing `base`'s numbers exactly) shows two
of the twenty-four monsters at world y 3.8 and y −8.2 against a survivor at
y 19.5 — 15 and 24 m down the slope, at screen y 1.88 and 1.82, i.e. off the
bottom of the frame.

Diagnosis of the six zero-pixel objects in `base` **before** changing any framing,
as instructed. They were three different things:

1. **objects 22, 23** — off the plateau, below the frame
   (`diag-combat.json`: `pos [-22.7, 1.4, 49.6]` and `[-30, -8.2, 46.9]`).
2. **object 11 — a Rift Stalker mid-blink.** `rootVisible: false`, `alive: true`,
   full health. `Enemy.js:1397` sets `rig.root.visible = false` for the 0.35 s
   blink dash and `exit` at `:1418` puts it back. **This is the game working**,
   not the `deathDissolve`/`resolveObject` defect in
   `reviews/round5/DIAG-invisible-enemies.md` §5. I did not touch `VFX.js` and
   did not apply the one-line `resolveObject` fix. A burrower does the same thing
   for 2.4 s (`Enemy.js:1429`, `submerge: 2.4`).
3. **objects 12, 14, 16** — mutual and terrain occlusion. Object 16 was at
   `pos [-15.2, 16, 31]` against a survivor at `[-15, 16, 31.1]`: 0.2 m away,
   entirely inside his silhouette.

Fixes, in the order they were measured:

**a. `placeForOpenArena` / `arenaFlatness` (new).** Two stages: a cheap
heightfield shortlist (disc flatness + `Stage.isWalkable`), then each shortlisted
spot is *committed to the player and scored by `faceOpenGround` itself* — the
same function, the same 0.85 bar, the same camera that gets photographed. The
proxy is only a shortlist, deliberately: on this stage the best patch scores
0.531 by the proxy and 0.889 by the gate, so treating the proxy as the answer
would have thrown the right patch away.

`open arena`: **0.44 → 0.89** (`base/manifest.json` → `harness/manifest.json`),
against an untouched `need` of 0.85.
`survivor unoccluded by the final lens`: **0.583 → 1.0**, against an untouched
`need` of 0.6.

**b. `awaitVisibleHorde` (new).** Holds the shutter until no rig in the horde is
hidden, and is a *wait*, not a repair — forcing `visible = true` here would paper
over the real `VFX.js` invisibility defect. Budget is 240 frames, set by the
longest self-hiding timer in the game (burrower, 2.4 s); 90 frames timed out on a
burrower on a live run. A new gated check `no monster hidden by its own attack`
publishes the raw list.

**c. `screenSlots` rewritten.** The largest single finding of this pass. Rows sat
at `sy = 0.40 + row*0.085`, a band chosen for a camera well above its terrain. On
the flat arena the lens is 1.8 m above the ground plane and the horizon lands at
`sy ≈ 0.38`: exactly **one of the five rows** fell inside the wanted distance band.
Measured with instrumentation (since removed): `spawnRing` received **15 slots for
24 monsters** and dropped nine onto its blind fallback arc. Rows now bisect for
the screen heights that bracket `[minDist, maxDist]` per column and spread evenly
between them; the fan is 13 columns; emitted slots stand off each other.

**d. `declutter`: a crowding pass, and `keep` as an obstacle.** The per-object mask
measures *marginal* contribution, so a body directly behind another renders the
pixels of neither. Nothing was asking about pairs. Also, the pinned damage-number
target was filtered out of the function entirely, so the grid was free to re-seat
a monster on top of it — object 16 at 7 px of a required 113
(`reviews/round6/diag-combat11.json`).

**e. `declutter` runs to convergence, monotonically.** A naive second pass made
things *worse* — 5 failing objects against 1 — because two passes fight over the
same cells. Bodies already seated are now carried forward as obstacles, so each
pass strictly reduces the number of unplaced bodies.

**f. `spawnRing`'s fallback arc** was one `sampleHeight` call with no validation;
it now walks the radius until the ground is on the same shelf as the survivor.

**g. Director spawning off for the shot.** `Director.fixedUpdate` banks credits
and spawns at `findSpawnPoint` — off camera by design — through every frame the
scenario spends composing, and the arena search spends real frames. Two of its
reinforcements landed *inside the declared subject*
(`reviews/round6/diag-combat4.json`). `enabled = false` gates only credit accrual
and spawning (`Director.js:290`); the horde keeps chasing, attacking and dying.
**This makes the assertion strictly harder**: all 24 are members that must be
photographed, with no unplaceable extras diluting the population `crowd: 8` draws
from. Restored via `restoreAfterShutter`.

Result:

| | `base/manifest.json` | `harness/manifest.json` |
|---|---|---|
| union px | 9226 | 9681 |
| objects visible | 18/24 | 20/24 |
| objects at literally 0 px | 6 (11,12,14,16,22,23) | 3 (0, 7, 23) |
| failing objects | 7 | 4 (0 px, 0 px, 1 px, 0 px) |
| `open arena` | 0.44 / need 0.85 ✗ | 0.89 ✗→✓ |
| `survivor unoccluded` | 0.583 / need 0.60 ✗ | 1.0 ✗→✓ |
| checks failing | 3 | 1 |

**`04-combat` does not pass.** Four of twenty-four monsters still render at or
near zero. Two of the three checks that were failing now pass and no threshold
moved.

### `08-explosion` — both of my failures fixed; the remaining one is not mine

| check | `base/manifest.json` | `harness/manifest.json` |
|---|---|---|
| `monsters standing in it` | `perPx [324, 4991, 0, 1262, 388, 243, 534]` — object 2 at 0 px — **FAIL** | `perPx [133, 104, 51, 1162, 318, 182, 328]` — no zeros — **PASS** |
| `damage numbers` | `sepP50 0.23` / need 0.25, `px 191`, lum 54.8 vs bgLum 40.8 — **FAIL** | `sepP50 0.53` — **PASS** |
| `the blast` | `px 4863`, `carriedPx 1935` — PASS | `px 640`, `carriedPx 357` — **FAIL** |

Two changes: the victim ring went from 0.105 to 0.16 of frame width (every readout
was being drawn over the brightest object in the frame — at ~4 m from the centre
of an 8 m blast the victims are still standing in it), and `awaitVisibleHorde` runs
before the victims are laid out, not next to the shutter, so the wait cannot undo
the ring. Plus the same director-spawning fix.

**`the blast` is a pre-existing regression in the shared tree, not mine.** Four
other agents' captures of the same tree, taken with an *unmodified* `Harness.js`
explosion scenario, show the same collapse:

| capture | `08-explosion` `the blast` px / carried |
|---|---|
| `reviews/round6/base/manifest.json` | 4863 / 1935 — pass |
| `reviews/round6/realms-main/manifest.json` | 4863 / 1935 — pass |
| `reviews/round6/vfx/manifest.json` | 5265 / 1774 — pass |
| `reviews/round6/vfx-mine/manifest.json` | 4754 / 1707 — pass |
| `reviews/round6/ctrl/manifest.json` | **485 / 196 — fail** |
| `reviews/round6/stages/manifest.json` | **508 / 260 — fail** |
| `reviews/round6/items/manifest.json` | **508 / 257 — fail** |
| `reviews/round6/harness/manifest.json` | **640 / 357 — fail** |

The failing arm is shared by three agents who did not touch the explosion
scenario. The `blast framed in the middle band` check passes in my capture
(`{x: 0.622, y: 0.406, distM: 11.2, pass: 0}`), so the blast *is* sited and in
frame — it is contributing an order of magnitude fewer pixels than it did. That is
VFX/material territory, which I do not own. Handing it over rather than chasing it.

### `11-bestiary` — 6 failing objects → 1

The arithmetic first, because it decides the shape of the fix. The per-object
floor this subject sets for itself is `minPixels / N` = 3500/16 = **219 px**, and
`reviews/round6/base/manifest.json` has the mite at 63. Uniform zoom cannot close
that: pixels per metre scale as `d_c / (d_c − fz) / halfExtent`, so the levers are
the rank's *width* and how far in front of the aim point the near rank stands —
not focal length, which cancels against the rank having to fit the frame.

- two ranks of eight at 2.7 m, camera 27 m: `27/23/12.3 = 0.095`
- three ranks of six at 2.4 m, camera 16 m, ranks at −6/0/+6: `16/10/8.7 = 0.184`

So: three ranks; a lens **solved** from the rank (fill 0.86) instead of a fixed
40°, which on `reviews/round6/base/11-bestiary.png` spent 62% of frame width on
the roster (the sixteen span x 450-1450 of 1600) and the rest on foreground dirt
and sky; a vertical check that widens the FOV if the 12 m-deep block will not fit,
because aiming at `tallest * 0.4` crops the near rank's feet once the ranks spread
in depth; `arenaFlatness` added to the centre score (a centre flat *across* the
rank but on a shelf front-to-back drops the far rank over the edge — observed, all
four tallest at 0 px); a deterministic ring of extra candidate centres that costs
no `ctx.rng` draws, so the scenarios after this one keep their random stream.

Rank depth was checked, not assumed: with the lens 5.0-5.5 m up, the near rank's
tallest member subtends less elevation than the middle rank's feet, so the near
rank cannot stand in front of the far one.

| | `base/manifest.json` | `harness/manifest.json` |
|---|---|---|
| union px | 7892 | 19472 |
| `perPx` | `[63, 311, 226, 249, 292, 317, 486, 813, 154, 173, 222, 306, 1098, 546, 1361, 1349]` | `[300, 1634, 958, 1091, 1284, 926, 770, 1092, 558, 478, 1019, 1426, 2511, 1040, 2432, 2095]` |
| worst object | 63 px (floor 219) | 300 px |
| objects below the 219 px floor | 3 | **0** |
| objects below the 0.25 separation floor | 3 (`0.11`, `0.19`, `0.23`) | **1** (`0.17`) |
| failing objects | 6 | 1 |

The last two separation failures were fixed by *range*, not by a threshold: the
back rank moved from 25 m to 22 m (`reviews/round6/diag-b2.json` had objects 12
and 13 at `sepP50` 0.15 and 0.23, fog-washed against terrain fog-washed to the
same value; `harness/manifest.json` has them at 0.63 and 0.57).

**`11-bestiary` does not pass.** Object 4 sits at `sepP50 0.17` against the 0.25
floor. It is a small card in the near rank whose colour is close to the ground
behind it; I could not move it without moving the whole rank, and I did not touch
`MIN_SEPARATION`.

---

## Regression I introduced, and did not get to verify a fix for

**`06-loaded-hud` → `monsters under load`.** Passing in
`reviews/round6/base/manifest.json` with `perPx [20, 35, 111, 356, 162, 110, 139,
1135, 278, 192]`; failing in `reviews/round6/harness/manifest.json` with
`perPx [6, 22, 27, 251, 56, 68, 779, 230, 102, 151]`, object 0 below the 12 px
absence floor. Cause: `lateRun` calls `spawnRing`, so the `screenSlots` rewrite
changed where its ten monsters land. Note the baseline was passing by **8 px** on
its weakest member — this shot was always one body away from failing.

The fix is one line, in `lateRun`: `await placeForOpenArena();` in place of
`await faceOpenGround();`, exactly as `04-combat` needed. **It is not applied.**
I wrote it, and before it could be captured `node_modules/playwright`,
`node_modules/playwright-core` and `node_modules/@rolldown/*` were emptied by a
stray `npx` (the same hazard the coordinator flagged mid-session), and no capture
can run. Shipping an unmeasured fix in this file is the precise thing this round
exists to prevent, so the line is a comment at the call site pointing here.
A `COLS 13 → 15` widening of the slot fan was reverted for the same reason.

Everything else in this report was measured on
`reviews/round6/harness/manifest.json`, which is a complete run of the code as
delivered.

---

## `tools/capture.mjs`

Two changes, both requested by the coordinator mid-pass.

**1. Delete on having captured, not on intending to.** The out-dir clear ran
before the navigate and before anything knew the app boots. Six agents share this
tree, so at any moment one may be mid-write and the module graph momentarily
unparseable — I hit exactly this five times during this pass. A capture started in
that window deleted a completed capture and replaced it with nothing; two finished
captures were lost that way. The clear now runs after `ready` resolves true.

A failed boot touches nothing it did not create: the previous PNGs and
`manifest.json` survive, and the failure announces itself on disk as
`00-FAILED-TO-BOOT.png` **plus `manifest.FAILED.json`** beside them. That is the
property the coordinator asked for — a failed run is visibly distinguishable from
a successful one, not merely absent. The directory used to assert "this is the
capture" when what had happened was "the capture did not happen", which is the
same shape as an aggregate hiding an absence, one level up from the subject gates.

**2. `10-inventory` → `every tier in the inventory strip`.** Was
`ctx.hud.inv.size >= ITEMS.length - 2`. The corruption tier makes that
unsatisfiable by construction — a corrupted item consumes the ordinary item it
pairs with, so nine catalogue entries can never co-exist with their bases. Three
on-disk manifests agree that the strip itself did not change:
`reviews/round6/base/manifest.json` `{shown: 83, items: 83}` pass;
`reviews/round6/items/manifest.json` `{shown: 83, items: 92}` fail;
`reviews/round6/items-control/manifest.json` (Blight present, its settle stubbed)
`{shown: 92, items: 92}` pass. Same 83 tiles; only the target moved.

Now `shown >= held && shown >= 60`, where `held = ctx.items.inventory().length`.

**What a zero inside it looks like, explicitly.** `shown >= held` alone is
self-referential: an empty inventory rendering an empty strip is `0 >= 0` and
certifies. That is why the second clause is there and why it is in the assertion
rather than in a comment. An empty strip fails on `>= 60`; a strip that has
dropped tiles fails on `>= held`; `detail` publishes `shown`, `held`, `floor` and
`catalogue` so a reader can see which of the two moved. `10-inventory` passes in
`reviews/round6/harness/manifest.json`. **This failure is attributed and closed —
it is not a fifth baseline failure.**

---

## Thresholds: none moved

`minPx`, `minPerPx`, `minSep`/`MIN_SEPARATION`, `minObjects`, `need`,
`OPEN_GROUND_NEED`, `MIN_VISIBLE`, `crowd` — all unchanged. Two checks became
*stricter* as a side effect: disabling director spawning means all 24 of
`04-combat`'s horde and all 7 of `08-explosion`'s victims are members that must be
photographed, with no off-camera extras in the population.

## For every check I added or touched, what a zero inside it looks like

- **`no monster hidden by its own attack`** (`04-combat`, new). Publishes the raw
  list of enemy ids whose `rig.root.visible === false` at the shutter, not a
  count. An empty array is the pass; a non-empty one is the failure and names the
  members. Nothing is averaged. Every member listed here also lands as a zero in
  `perPx` on the same frame, so it cannot report clear while concealing one, and
  cannot report a failure the pixel gate disagrees with.
- **`open arena`** (`04-combat`, existing gate, detail extended). Still
  `openness >= 0.85` where `openness` is whatever `faceOpenGround` returned *for
  the spot actually used*. `placeForOpenArena` cannot invent it. `detail.arena`
  now also publishes `moved`, `dist`, `flatness` and `tried`, so a reader can see
  whether the search moved the survivor and how far.
- **`every tier in the inventory strip`** (`10-inventory`, rewritten). Covered
  above: `shown >= held` alone would pass on `0 >= 0`; the `>= 60` floor makes an
  empty strip unable to certify.
- **`screenSlots` de-dup and `declutter`'s crowding test** are not assertions —
  they are placement. Neither can suppress a report: a body that cannot be placed
  stays where it is and fails the per-object pixel gate, which is the behaviour
  the existing comment already promised and now actually delivers.

## Left alone deliberately

- **`VFX.js:1424` `resolveObject` / `Enemy.rig.root`.** Not touched, not fixed. My
  zero-pixel enemies were a Rift Stalker mid-blink and a burrower mid-submerge —
  both correct game states with timers — so the invisibility I found is not the
  latent defect, and per `reviews/round5/DIAG-invisible-enemies.md` §5 the one-line
  fix arms a real bug. `awaitVisibleHorde` waits it out instead of repairing it,
  precisely so a rig that goes invisible for any *other* reason still fails.
- **`08-explosion` → `the blast`.** Attributed to the shared tree with eight
  manifests cited above; not my file, not my change.
- **`MIN_SEPARATION = 0.25`.** `11-bestiary` object 4 sits at 0.17 and
  `04-combat` has bodies in the 0.2s. I have no measurement showing the criterion
  is wrong for those subjects — the frames I could not fix are frames where the
  monster genuinely does not stand off its background — so the floor stays.
- **`11-bestiary` object 12** reads `sepP50 0.63` in the final capture but read
  `0.25` exactly in an earlier one (`reviews/round6/diag-bestiary1.json`), i.e. it
  passed on equality. Worth knowing that card is marginal against this terrain.
- **`reviews/round6/base/`** was not written to. All my captures went to
  `reviews/round6/harness/` on port 5201.
- Per the coordinator: `base/` is the detail-pass-OFF arm (`DET_KILL 0.0` in
  `f9b47c4`). No number in this report is a material or surface-appearance number
  — every one is a mask pixel count, a per-pixel separation, a visibility fraction
  or a screen coordinate, and all of them reproduce independently of the detail
  pass. The detail-ON arm is at `reviews/round6/detON/`.
