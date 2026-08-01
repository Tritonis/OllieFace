# FIX — harness round 2

Owner of `src/core/Harness.js` and `tools/capture.mjs`. Everything below is
measured on this machine's GPU path at 1600×900, quality 3, seed 1337.

---

## 1. Subject thresholds certified illegible subjects

**The defect.** The only gate on a `pixels` subject was `minPx`. `04-combat`
recorded the survivor at `lum 42.7 / bgLum 47.5 / contrast 0.053` — darker than
his own background, the dimmest object in his own combat frame — and wrote
`ok: true`.

**Why the number that was already there could not be the gate.** `contrast` is a
*signed aggregate*: `|Σls − Σlb| / Σ(ls + lb)` over the subject's mask. It
cancels. A subject bright down one side and dark down the other reports ≈0, and
so does a subject whose mean happens to match its background, however sharply
every individual pixel differs. It cannot distinguish "invisible" from
"balanced", so it was never safe to gate on and gating on it would have been the
wrong fix.

**What replaced it** (`Harness.js`, `subjectReport`): per-pixel Michelson
separation, `|ls − lb| / (ls + lb + 8)`, accumulated into a 50-bin histogram
during the same pass that counts the mask. It cannot cancel. Reported per
subject as `sep` (mean), `sepP25`, `sepP50` (median) and `legible` (fraction of
mask pixels at or above 0.15). The old `contrast` is kept so earlier reviews
remain comparable.

**The gate.** `MIN_SEPARATION = 0.25` on `sepP50`, applied to every `objects()`
subject unless it raises its own floor. Set from the measured distribution, not
from taste:

| subject | sepP50 |
|---|---|
| `05-boss` survivor (for scale) | 0.57 |
| `04-combat` horde | 0.67 |
| `12-boss-phases` vizier | 0.61 |
| `06-loaded-hud` survivor | 0.65 |
| `03-thirdperson` survivor | 0.47 |
| `11-bestiary` roster | 0.47 |
| `09-survivors` four survivors | 0.45 |
| `07-interactables` chest | 0.37 |
| **gate** | **0.25** |
| `10-inventory` blast *(mask includes its own light wash — see below)* | 0.13 |

Every solid subject in the set sits at 0.37–0.69. The gate is placed in the
empty band below them, nearer the failure population than the pass population so
it cannot be cleared by noise.

**One criterion correction, with the measurement that justifies it.** The median
is the right statistic for a *solid* subject, where every masked pixel is the
subject. It is the wrong statistic for an *effect*, where a large share of the
mask is the effect's own light falling on the world. Measured on `08-explosion`:
the blast's mask is 11,421 px, of which 6,350 carry ≥0.15 separation and the
remaining ~5,000 are the light layer washing across terrain at p25 = 0.07 —
that layer working, not failing. So VFX subjects are gated on
`minCarriedPx` — the *area that carries an edge* — against the same floor their
pixel count already used (1200 for `08`, 800 for `10`). That is strictly
**tighter** than what shipped: the old check counted the whole halo toward
`minPixels`; this one counts none of it.

Not a loosening anywhere: no `minPixels`, `minObjects` or `minVisible` value in
the file was lowered.

---

## 2. Run-to-run instability

**Root cause, in `Engine.js` and not in the check that failed.** `Engine._frame`
takes its delta from a `THREE.Clock` — the wall clock — and hands it to every
`update()`, which is where all presentation lives (VFX particle ages, ring
radii, damage-number arcs). `ctx.time` advances separately, inside the fixed
step, and the fixed step is **scaled by hitstop** (`HITSTOP_SCALE = 0.15`,
`Engine.js:196-208`).

`10-inventory` budgeted its shutter with `waitSim(0.12)` — 0.12 s of
*simulation* time — while the nova it was photographing aged in *presentation*
time, and the nova's own kills raised the hitstop that drives the two apart by
up to 1/0.15. How many monsters died before the shutter varied with frame
pacing. So the effect's age at the shutter varied with frame pacing.

**Measured, at HEAD, before the fix.** Two full captures, same seed 1337, no
code change between them:

| | run A | run B | Δ |
|---|---|---|---|
| PNGs byte-identical | **0 of 21** | | |
| `10-inventory` equipment blast | 26,130 px | 1,523 px | **−94 %** |
| `11-bestiary` roster | 8,687 px | 5,144 px | −41 % |
| `06-loaded-hud` monsters | 4,007 px | 4,987 px | +24 % |
| `08-explosion` blast | 5,126 px | 4,721 px | −8 % |

The 294 px failure in the brief is the same distribution sampled once more.

**The fix.** `__HARNESS__.pinClock(1/60)`, called by `capture.mjs` before the
first scenario, replaces the engine's `THREE.Clock` with a constant-delta stub.
One rendered frame is then exactly 1/60 s of presentation time and 1/60 s ×
hitstop-scale of simulation time, both derived from a frame count that is
identical on every machine. Nothing is slowed: the engine still renders as fast
as the GPU allows, it just no longer *asks* how long that took. It is off by
default — `tools/perf.mjs` measures the real clock and pinning it there would
make that measurement fiction.

Alongside it, `waitFx(seconds)` — a wait in *presentation* seconds, the clock
every VFX lifetime is written against — replaces `waitSim` in the two shutters
that were photographing effects. Both record the age they actually got, in the
manifest, on every run.

The one remaining place a settle could silently become wall-clock-dependent is
the hang guard inside `frames()`. It now counts itself and the count is
published as `manifest.determinism.frameTimeouts`, so a truncated wait shows up
as evidence instead of as a mystery.

**After.** RESULT_DETERMINISM_AFTER

---

## 3. `09-survivors` staging

**The defect.** The row search asked two questions per survivor — can the lens
see a point 0.3 m up, and one 1.9 m up. Two rays up the centre line cannot see a
rock across a survivor's shins. ROOK shipped buried to the thigh with no boot,
no foot and no ground contact, its footline at y 534 against 558 / 569 / 559,
and a leg fix measured at 2.00 leg-runs offline read 1.03 in the shipped pixels.

**The fix**, all in `survivors()`:

- flatness across the four slots is a **hard reject** at 0.10 m, not a scoring
  term (0.35 m of ground spread is 35 px of footline at this standoff — it is
  the defect, not a tie-break);
- every slot is tested with `visibleFraction` over the **whole figure including
  the ankles** (`y0: 0.02`, 3 × 5 samples) from the camera that will actually be
  used, and must clear **0.97**;
- all four rigs are placed on **one** ground height rather than four;
- the "no candidate" branch now `console.error`s instead of silently shipping;
- and the result is asserted in pixels: two new checks measure the four
  footlines on screen and the per-survivor visibility, and fail the shot if the
  spread exceeds 12 px of 900 or any survivor drops below 0.97.

**Measured, shipped frame:**

| | before | after |
|---|---|---|
| footlines (px) | 558 / 569 / 559 / **534** | RESULT_FOOTLINES |
| footline spread | 35 px | RESULT_FOOTSPREAD |
| ground spread across the row | — | RESULT_GROUNDSPREAD |
| per-survivor visibility incl. ankles | not measured | RESULT_FOOTVIS |

RESULT_SURVIVORS_EYE

---

## 4. Timing-constant audit

`blastSeconds = 0.09` was documented as "0.11 s is where the blast has a shape"
and the shutter actually fired at **0.207 s** — a factor of 2.3, because the
budget was spent in simulation seconds and the effect ages in presentation
seconds (defect 2). Every other timing constant in both files was checked the
same way, by measurement rather than by reading.

RESULT_TIMING_TABLE

---

## 5. `08-explosion` composition

RESULT_EXPLOSION

---

## 6. Proof the guard fires

RESULT_GUARD

---

## Left open

RESULT_OPEN
