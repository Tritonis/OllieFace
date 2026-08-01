# FIX — harness round 2

Owner of `src/core/Harness.js` and `tools/capture.mjs`. Nothing outside those two
files was edited. Everything below is measured on this machine's GPU path
(RTX 2070, ANGLE/D3D11) at 1600×900, quality 3, seed 1337.

Verification summary: `npx vite build` clean · `node tools/capture.mjs` → 21
shots (20 + `18-difficulty`), `subjectsOk: true`, `errorCount: 0`,
`frameTimeouts: 0` · `node tools/perf.mjs` combat-24 median **24.5 ms** (band
17–26) · PNGs opened and looked at, not inferred from the manifest.

The `shots/` on disk was last written by *another* agent's concurrent
`capture.mjs` run against this code — independently clean: `ready: true`,
`clockPinned: true`, `subjectsOk: true`, 0 errors, 21 shots.

---

## 1. Subject thresholds certified illegible subjects

**The defect.** The only gate on a `pixels` subject was `minPx`. `04-combat`
recorded the survivor at `lum 42.7 / bgLum 47.5 / contrast 0.053` — darker than
his own background, the dimmest object in his own combat frame — and wrote
`ok: true`.

**Why the number already in the manifest could not become the gate.** `contrast`
is a *signed aggregate*: `|Σls − Σlb| / Σ(ls + lb)` over the mask. It cancels. A
subject bright down one side and dark down the other reports ≈0, and so does one
whose mean happens to match its background, however sharply each pixel differs.
It cannot tell "invisible" from "balanced". Demonstrated on the deliberately
broken frame in §6: a survivor flattened to the colour of the canyon he stands
in scores **0.689** on this metric. Gating on it would have been the wrong fix.

**What replaced it** (`subjectReport`): per-pixel Michelson separation,
`|ls − lb| / (ls + lb + 8)`, accumulated into a 50-bin histogram inside the pass
that already counts the mask (no extra render, no allocation). It cannot cancel.
Published per subject as `sep` (mean), `sepP25`, `sepP50` (median) and `legible`
(fraction of mask pixels ≥ 0.15). The old `contrast` is kept so earlier reviews
stay comparable.

**The gate.** `MIN_SEPARATION = 0.25` on `sepP50`, applied to every `objects()`
subject unless the subject raises its own floor. Set from the measured
distribution, not from taste — every solid subject in the twenty shots:

| subject | sepP50 |
|---|---|
| `08-explosion` monsters in the blast | 0.83 |
| `06-loaded-hud` monsters under load | 0.71 |
| `10-inventory` monsters in the nova | 0.67 |
| `04-combat` horde | 0.61 |
| `12-boss-phases` vizier · `05-boss` Titan | 0.61 |
| `04-combat` survivor | 0.59 |
| `05-boss` survivor (for scale) | 0.57 |
| `06-loaded-hud` survivor | 0.53 |
| `03-thirdperson` survivor | 0.51 |
| `11-bestiary` roster | 0.47 |
| `09-survivors` four survivors | 0.43 |
| `07-interactables` chest | 0.41 |
| **gate** | **0.25** |
| *deliberately broken survivor (§6)* | *0.19* |

The pass population is 0.41–0.83; the gate sits in the empty band below it,
nearer the failure than the pass so it cannot be cleared by noise.

**One criterion correction, with the measurement behind it.** The median is the
right statistic for a *solid* subject, where every masked pixel is the subject.
It is the wrong statistic for an *effect*, where much of the mask is the
effect's own light falling on the world. Measured on `08-explosion`: the blast's
mask is 20,635 px of which **14,444 carry ≥ 0.15 separation** and the rest is
the light layer washing over terrain at p25 = 0.07 — that layer working, not
failing. So VFX subjects declare `minCarriedPx` and are gated on the *area that
carries an edge*, against the same floor their pixel count already used (1200
for `08`, 800 for `10`). **Strictly tighter than what shipped**: the old check
counted the whole halo toward `minPixels`; this one counts none of it.

No `minPixels`, `minObjects` or `minVisible` value in either file was lowered.

---

## 2. Run-to-run instability

**Root cause, and it is not in the check that failed.** `Engine._frame` takes
its delta from a `THREE.Clock` — the wall clock — and hands it to every
`update()`, which is where all presentation lives (VFX particle ages, ring
radii, damage-number arcs). `ctx.time` advances separately, inside the fixed
step, and the fixed step is **scaled by hitstop** to 0.15
(`Engine.js:196-208`).

`10-inventory` budgeted its shutter with `waitSim(0.12)` — 0.12 s of
*simulation* time — while the nova it was photographing aged in *presentation*
time, and the nova's own kills raised the hitstop that drives the two apart by
up to 1/0.15. How many monsters died before the shutter varied with frame
pacing, so the effect's age at the shutter varied with frame pacing.

**Measured at HEAD, before the fix** — two full captures, same seed, no code
change between them (worktree at `34cc8c4`, nothing else touching it):

| | run A | run B | Δ |
|---|---|---|---|
| PNGs byte-identical | **0 of 21** | | |
| **`10-inventory` equipment blast** | **26,130 px** | **1,523 px** | **−94 %** |
| `11-bestiary` roster | 8,687 px | 5,144 px | −41 % |
| `06-loaded-hud` monsters | 4,007 px | 4,987 px | +24 % |
| `08-explosion` blast | 5,126 px | 4,721 px | −8 % |

The brief's 294 px failure is that distribution sampled once more.

**Three changes, in the order they were needed:**

1. **`pinClock(1/60)`** replaces the engine's `THREE.Clock` with a
   constant-delta stub, so one rendered frame is exactly 1/60 s of presentation
   time. Nothing is slowed — the engine still renders as fast as the GPU
   allows, it just no longer *asks* how long that took. It is armed by a
   `pinclock` URL flag read inside `installHarness`, **before the engine's first
   frame**: pinning from `capture.mjs` after stage-ready left every boot frame
   timed by the wall clock, and measurably so (~1–2 % residual). Off by default;
   `tools/perf.mjs` deliberately does not use it, because it is measuring the
   real clock.
2. **`waitFx(seconds)`** — a wait in *presentation* seconds — replaces
   `waitSim` in the two shutters that photograph effects. Both now publish the
   age they actually got, per run, in the manifest.
3. **Hitstop is held at zero for the duration of a shutter window** (inside
   `waitFx`). This was the last coupling: hitstop is a feel mechanic a still
   frame cannot show, and it (a) re-opened the sim/presentation gap for the
   sim-timed parts of an effect, (b) stretched `Enemy`'s 0.075 s *simulation*
   hit-flash to as much as 0.5 s of wall time, so **every monster in the blast
   photographed as a flat white cutout** — measured directly at a 0.14 s effect
   age — and (c) was the residual that kept `10-inventory` swinging after the
   clock was pinned. The manifest now shows `age` and `sim` agreeing exactly
   (`0.1167` / `0.1167`).

**After** — two captures back to back against a *frozen snapshot* of the tree
(five other agents are editing `src/` continuously; an unfrozen A/B measures
their edits, not the harness):

| | result |
|---|---|
| subject metrics bit-identical | **12 of 16** |
| the other 4 | differ by **≤ 1 px** (0.01–0.11 %) |
| **`10-inventory` equipment blast** | **10,957 vs 10,956 px — 0.01 %** (was −94 %) |
| `frameTimeouts` | 0 |

PNG bytes are still not identical. That residue is the GPU rasteriser, not the
simulation: a ≤1 px difference in a 10,957 px mask is sub-pixel coverage jitter,
and it is three orders of magnitude below the variation that was failing checks.
The one place a settle could still become wall-clock-dependent — the hang guard
inside `frames()` — now counts itself into `manifest.determinism.frameTimeouts`,
so a truncated wait shows as evidence rather than as a mystery.

---

## 3. `09-survivors` staging

**The defect.** The row search asked two questions per survivor: can the lens
see a point 0.3 m up, and one 1.9 m up. Two rays up the centre line cannot see a
rock across a survivor's shins. ROOK shipped buried to the thigh — no boot, no
foot, no ground contact — footline y 534 against 558 / 569 / 559, and a mesh fix
measured at 2.00 leg-runs offline read 1.03 in the shipped pixels.

**The fix**, all inside `survivors()`:

- height spread across the four slots is a **hard reject at 0.10 m**, not a
  scoring term (0.35 m of ground spread is 35 px of footline at this standoff —
  the defect itself, not a tie-break);
- every slot is tested with `visibleFraction` over the **whole figure including
  the ankles** (new `y0`/`y1` band, `y0: 0.02`, 3 × 5 samples) from the camera
  that will actually be used, and must clear **0.97**;
- all four rigs are placed on **one** ground height instead of four;
- the no-candidate branch `console.error`s instead of silently shipping;
- and the result is asserted in pixels — two new checks fail the shot if the
  four screen footlines spread more than 12 px of 900, or any survivor's
  visibility drops below 0.97.

| | before | after |
|---|---|---|
| footlines (px) | 558 / 569 / 559 / **534** | **557 / 557 / 557 / 557** |
| footline spread | 35 px | **0 px** |
| ground spread across the row | not measured | **0.000 m** |
| per-survivor visibility, ankles included | not measured | **1.00 / 1.00 / 1.00 / 1.00** |

Confirmed by eye on `shots/09-survivors.png`: four survivors on one plane, all
four with visible legs, boots and ground contact, ROOK included and no longer
sunk into rock.

---

## 4. Timing-constant audit

Every timing constant in both files, checked by measurement. **Wrong** means the
documentation and the behaviour disagreed.

| # | Constant | Documented as | Measured | Verdict |
|---|---|---|---|---|
| 1 | `explosion({ blastSeconds: 0.09 })` | "0.11 s is where the blast has a shape" | shutter fired at **0.207 s** of effect life (sim-vs-presentation clock error, §2) | **WRONG — fixed.** Now `0.12`, spent in effect seconds, exact, and published per run |
| 2 | `inventory({ blastSeconds: 0.12 })` | implied 0.12 s of nova life | unstable by construction; the same seed gave 26,130 px and 1,523 px | **WRONG — fixed.** Now exactly 0.1167 s (7 frames), reproducible to 1 px |
| 3 | Harness header: "0.63 s elapsed against a **0.22 s** fireball" | 0.22 s fireball | blast's carrying area collapses to 423 px by **0.28 s** | **STALE — corrected** to ~0.28 s |
| 4 | `FLASH_TIME` 0.075 s, cited by `boss()`'s 0.14 s trigger release | "held for 0.075 s after every hit" | correct, and it is **simulation** time (`Enemy.js:441`, `fixedUpdate`). `fireBurst` also spends simulation time, so the 0.14 s margin is real | **CORRECT** (and the unit now documented — it is why victims photographed white, §2) |
| 5 | `inventory()` hold loop, 0.55 s "past the 0.45 s spawn pop in simulation time" | 0.45 s pop, simulation | `Enemy.js:1188` `fsm.t / 0.45`, advanced in `fixedUpdate` | **CORRECT** |
| 6 | `bestiary()` "let the 0.45 s spawn pop finish", waits `settleFrames = 40` | 0.45 s | 40 frames = 0.667 s, and the director is disabled so no hitstop | **CORRECT but mis-stated** — it is a frame budget, not a time budget; comment now says so |
| 7 | `abilityAudit()` `waitSim(0.9)` vs "Warden's airborne slam poll at 0.7 s" | 0.7 s | `abilities.js:524` polls to 0.7 s via `player.schedule`, which `Player._runSchedule` advances on the fixed step — same unit | **CORRECT** |
| 8 | `survivors()` "150 fixed steps is well past the slowest spring (`sLean`, 8 rad/s)" | — | 150 × 1/60 = 2.5 s against a ~0.5 s settle | **CORRECT** |
| 9 | `survivorSelect()` / `logbook()` "90 frames is comfortably past" a dynamic import | — | the import is **wall-clock work a frame count cannot bound**. It has always been a race | **UNSOUND but guarded** — the `dom` assertions on `preview.subject`/`renderer` fail the shot if it loses. Recorded, not papered over |
| 10 | `capture.mjs` `SHOT_TIMEOUT = 30000` | screenshot guard | worst screenshot **1,724 ms** (`01-title`); typical 650–880 ms. 17× margin | **CORRECT** |
| 11 | `capture.mjs` boot `timeout: 60000` | stage-ready guard | measured boot **9.0–13.0 s** | **CORRECT** |
| 12 | `capture.mjs` `browser.launch timeout: 120000` | launch guard | 0.4–0.6 s | **CORRECT** |
| 13 | `capture.mjs` `settle(page, frames, maxMs = 20000)` | "advance N frames so captures land on a known state" | **dead code — never called** | **DELETED.** A second, wrong answer to "how does a shot decide when to fire", sitting in the file that documents shot timing |
| 14 | `capture.mjs` header: "no wall-clock waits that could land mid-animation on a slow machine" | determinism claim | false — nothing here waited on the wall clock, but the *engine* did | **WRONG — corrected**, and now true (§2) |
| 15 | `SHOT_TIMEOUT` software path, 180000 | SwiftShader guard | not exercised — no SwiftShader run made | **UNVERIFIED**, left alone and flagged |
| 16 | `frames(n, maxMs = 20000)` hang guard | "wall-clock capped so a stalled GPU cannot hang" | fires 0 times across all runs | **CORRECT**, and now counted rather than silent |

Per-shot `ms.setup` / `ms.screenshot` and `ms.boot` are written into the
manifest on every run, so the next person to touch a timeout can see what it is
actually guarding instead of guessing.

---

## 5. `08-explosion` composition

Round 1: "opaque orange tori whose notional centre is empty sky". Round 2: "the
blast sits in empty sky at y = 236 with its lower half behind a foreground
rock … move the blast lower and unoccluded and re-seed to a late-run moment —
this is `Harness.js`, and it is the single change that would make the layer work
visible."

Four changes:

1. **Sited on the fireball's centre, not on a ground point.** The ground point
   and the lift are searched together against what the *centre* projects to
   (must land in the middle band, 0.34–0.66 of frame height), and the sphere is
   sampled at five points at 0.8 × blast radius — top, bottom and both flanks —
   so a rock across the lower half is a reject rather than a surprise. Three
   graduated passes, each dropping one requirement; the pass used is published.
   A single strict pass is not a guard: the first cut found nothing on the stage
   this scenario actually runs on and fell through to a blind `ahead(12, 3.4)`
   that put the blast 40 m out beside the sun at 293 px.
2. **Depth is a constraint, not a preference** (9–15 m, scored toward 11). An
   early cut scored only on screen position and happily chose a point 25 m out —
   a six-metre fireball at 25 m is a smudge under a mountain.
3. **Not behind the survivor** — the centre must clear his screen position by
   0.22 of frame.
4. **Turned away from the sun before the arena is chosen.** The blast is
   additive: it reads against what is behind it, and what was behind it was an
   18° sunset disc. This is the single largest measured win.
5. **Seeded to a real mid-run moment** — 12:38 on the clock, level 11, $1,840,
   replacing `00:11 / LVL 1 / $6`. Deliberately *without* an item haul: items
   are permanent and would put an inventory panel across `11-bestiary` and
   `12-boss-phases`, which are shot after this one.

| | before (round 2) | after |
|---|---|---|
| blast, mask px | 5,126 (run A) / 4,721 (run B) | **20,635** |
| blast, pixels carrying an edge | not measured | **14,444** |
| monsters standing in it | 1,195–2,004 px | **7,742 px** at sepP50 0.83 |
| damage numbers | 169–182 px | 183 px |
| blast centre, screen | (0.469, **0.26**) — top quarter | (0.355, **0.34**) |
| blast distance | 16–25 m | **8.7 m** (search pass 0) |
| effect age at shutter | 0.207 s, accidental, variable | **0.1167 s, chosen, exact** |

By eye: a hot core with a defined edge, a full debris fan with motion streaks,
the light layer visibly on the terrain, monsters thrown and in colour rather
than flat white, over midground trees rather than sky.

The shutter age was chosen by photographing the same blast at six ages and
counting the pixels that carry their own edge — 0.05 s: 4,925 · 0.09 s: 4,925 ·
**0.12 s: 10,726** · 0.16 s: 8,227 · 0.20 s: 6,212 · 0.28 s: 423 (guard fires,
`why: absent`). The round-5 VFX retune (core life 0.20 → 0.42 s) is not
invalidated by moving earlier — a longer-lived core is *more* alive at 0.12 s
than at 0.20 s, and the table above is measured on the retuned build. What is
invalidated is treating 0.207 s as a target: it was never chosen, and it sits
past the peak of the effect it photographs.

**Bonus defect found and fixed while in there.** The biome series rebuilds the
world four times and restores stage 1 *after* its last shutter without
relabelling, so every later shot carried the previous caption: `04-combat`
shipped a stage-1 world captioned `STAGE 4 — RALLYPOINT FERROUS`. The relabel is
now deferred into the next scenario's `begin()`, which runs before anything is
composed. `04-combat` now reads `STAGE 1 — CINDERGRASS FLATS`, which is where it
is.

---

## 6. Proof the guard fires

**(a) Present but illegible.** `03-thirdperson` was deliberately broken by
flattening the survivor's materials to the colour of the canyon he stands in
(temporary edit in `gameplay()`, since removed). The subject is still there and
still the same size:

```
03-thirdperson / survivor
  px 823   (floor 600)  ->  present: true
  contrast 0.689        <- the OLD metric calls this a high-contrast subject
  sepP50 0.19  (floor 0.25) -> legibleOk: false
  ok: false
```

`subjectsOk: false`, the shot is listed in `subjectFailures` with
`why: "illegible"`, `console.error` raises `frameErrors`, and `capture.mjs`
exits non-zero. Looking at the PNG: the survivor is a dark shape barely
separable from the shadowed rock — exactly the class of frame five agents once
certified with `errorCount: 0`. **The old gate passes this frame; the new gate
fails it.**

**(b) Present in the simulation, absent from the photograph.** The same
mechanism catches a mistimed shutter with no source edit at all — photographing
`08-explosion` at a 0.28 s effect age:

```
08-explosion / the blast
  px 475  (floor 1200) -> present: false, why: "absent"
  carriedPx 423 (floor 1200)
```

Both were restored; the shipped tree contains neither break, and the final
capture is `subjectsOk: true` with `errorCount: 0`.

---

## Left open

- **`04-combat`'s survivor is legible but crowded.** `clearSurvivorFromLens`
  (new) turns the boom until the lens can see the survivor, rejecting any
  bearing that "fixes" him by jamming the camera into a rock — the first cut of
  it scored a perfect visibility with a 3 m boom and a survivor filling the left
  third at 9,839 px. On the shipped frame it settles at `vis 0.583, boom 5.25`
  and reports both. The residual occluders are *enemies*, which
  `visibleFraction` cannot see (it raycasts terrain and props only). He measures
  814 px at sepP50 0.59 — a real fix on the round-2 defect (875 px at
  `contrast 0.053`) — but the frame is busy. Extending the occlusion probe to
  entity capsules is the next move and is not in this change.
- **The player's own lighting is untouched**, because it lives in files I do not
  own. Defect 1(a) in `critic-r2-character.md` — a camera-attached key on the
  player layer — is still open and is the durable fix; this change makes its
  absence *fail* rather than pass.
- **`tools/perf.mjs` reports `idle` as 1 frame / 0 ms** because
  `HARNESS.gameplay()` freezes the engine before profiling starts. Pre-existing,
  outside the two files I own, and it means only the `combat-24` number in that
  tool is meaningful. `combat-24` measured **24.5 ms median** (avg 25.05, p95
  32.5) — inside the 17–26 ms band, and unaffected by this work since perf does
  not pin the clock.
- **The 180 s SwiftShader shot timeout is unverified** — no software-rendering
  run was made.
- **`14-survivor-select` / `15-logbook` settle on a frame count against a
  dynamic import**, which is wall-clock work. Guarded by assertions rather than
  by timing; noted in the audit as item 9.
- **PNG bytes are not reproducible**, only shot *content* is (≤1 px of subject
  area). If bit-identical output is ever wanted, the remaining source is GPU
  rasterisation, not the harness.
- **Environment note, not a defect in this change.** Mid-session `npx vite
  build` began failing with `Cannot find native binding … @rolldown/binding-*`
  because `node_modules/@rolldown/binding-win32-x64-msvc/package.json` briefly
  vanished under a concurrent agent's npm operation, and `npx` also resolved a
  half-torn-down cached vite. It self-healed. If it recurs, build with the local
  binary — `node node_modules/vite/bin/vite.js build` — rather than reaching for
  `npm install`, which is what breaks the rolldown toolchain in the first place.
