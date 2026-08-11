# FIX — `13-biomes-2`'s far spire, implemented and re-measured

Implements the fix `reviews/round7/DIAG-biomes2-spire.md` §5 proposed and
measured as runtime arms. Two numbers in `src/world/Materials.js`:

| what | where | before | after |
|---|---|---:|---:|
| `DETAIL.terrain.fineFade` | `src/world/Materials.js:327` | 400 | **110** |
| canyon `matTune.terrain.roughness` | `src/world/Materials.js:1323` | 0.70 | **0.82** |

(The diagnosis cited `:310` and `:1296` at `HEAD 1911d79`. This branch is based
on master `39bf2bc`; both sites were located by symbol and the lines moved to
`:327` / `:1323`, the second also by the comment this change added above it.)

No shader source, no uniform plumbing, and no `detAlpha` re-weighting — the
diagnosis rejected that lever on the `grad4` arm and this fix does not revisit
it. Neither `ctx.rng` nor `ctx.fxRng` is touched; `Materials.js` contains no RNG
reference at all, so no shared-stream ordering can have moved.

---

## 1. The instrument, and the noise floor it is read against

`reviews/round7/tools/lattice.mjs --selftest`, run in this worktree: **5 of 5
PEAK cases reproduce to the digit** (flat 0.000, ramp 0.000, 1-in-100 specks
1.020, 2x2 blocks 0.000, 3x3 blocks 0.000), and the autocorrelation half returns
0.020 on white noise and 0.999 at lag 10 on a planted period-10 grid. The
instrument calibrates here exactly as it did for the diagnosis.

The capture harness is not bit-exact, so **two full captures of the *unmodified*
tree were taken first** and every number below is judged against their spread,
not against zero:

- `reviews/round7/captures/fix-spire-ctrlA/` — pre-fix, port 5316, 23 shots
- `reviews/round7/captures/fix-spire-ctrlB/` — pre-fix, port 5317, 23 shots
- `reviews/round7/captures/fix-spire/` — post-fix, port 5316, 23 shots

All three: seed 1337, `clockPinned: true`, 23 shots, and the only manifest error
in any of them is `06-loaded-hud` (known-red, below).

**Measured control floor: max |delta| = 0.0026 pp** (`10-inventory`, 0.0068% ->
0.0042%). In relative terms the pair moves up to 38.8%, but only on shots whose
absolute PEAK is under 0.01%, where a handful of pixels is the whole
measurement. The floor that matters for judging this fix is the absolute one:
**0.0026 pp**. This run was considerably tighter than the ~0.68% per shot the
brief warned to expect.

---

## 2. The headline — PEAK at the *current* ROI

ROI **x240-560 y120-420** (the round-7 box; the canyon's tapered wall fins),
`13-biomes-2`, n = 96,000 interior px:

| capture | PEAK | hits |
|---|---:|---:|
| `fix-spire-ctrlA` (pre-fix) | 0.202% | 194 |
| `fix-spire-ctrlB` (pre-fix) | 0.209% | 201 |
| **`fix-spire` (post-fix)** | **0.026%** | **25** |

**0.202-0.209% -> 0.026%, against a verify line of 0.03%. Met.**

Control drift on the pre-fix pair at this ROI is 0.007 pp (3.5%); the fix moves
it 0.180 pp, **26x the drift**. The independently re-measured result also lands
within 0.002 pp of the diagnosis's combined arm (`ff110r082`, 0.024%) — which is
the confirmation §5 asked for, since (a) and (b) had only ever been measured
together in one runtime arm and never on a fresh `tools/capture.mjs` run.

### The stale ROI, and whether anything encodes it

Round 6's box **x1000-1180 y30-260** reads **0.010%** on the pre-fix capture,
reproducing the diagnosis exactly: it now photographs a near aqueduct pier, not
the fin, and it would have reported this defect as already fixed.

**No gate encodes it.** Searching `tests/`, `tools/` and `src/` for that box
finds it in exactly two places, both prose: `Materials.js:660` and
`Materials.js:716`, where it records what the round-4 and round-6 critics
measured. Those statements remain true as history, so **nothing was changed on
this account** — there is no hardcoded-ROI gate to update. (The two `PEAK`
symbols in `tools/capture.mjs` are the audio `PEAK_FLOOR`, unrelated.)

### Frame-wide, so the defect is not merely relocated

`peakscan.mjs`, 180x180 windows, stride 60, `13-biomes-2`:

| | pre-fix (`ctrlA`) | post-fix |
|---|---|---|
| frame PEAK | 0.0891% | **0.0245%** |
| worst window | **0.343%** at x181-361 y61-241 | **0.114%** at x361-541 y421-601 |

The worst window is 3.0x quieter *and has moved off the fins* onto the mid-frame
ground — the surface that carried the defect is no longer the noisiest thing in
the shot. Frame-wide, b2 goes from 3.7x `13-biomes-1` to level with it (0.0245%
vs 0.0201%), which is what the diagnosis predicted.

---

## 3. Full-capture comparison, post-fix vs the pre-fix control

Frame-wide PEAK, every shot, `fix-spire-ctrlA` -> `fix-spire`
(`reviews/round7/tools/fixcompare.mjs`). Judge the `delta pp` column against the
**0.0026 pp** control floor from §1.

| shot | pre-fix (ctrlA) | post-fix | delta pp | delta % | verdict |
|---|---:|---:|---:|---:|---|
| 01-title | 0.0000% | 0.0000% | +0.0000 | +0.0% | flat |
| 02-vista | 0.0125% | 0.0104% | -0.0022 | -17.2% | improved |
| 03-thirdperson | 0.0025% | 0.0022% | -0.0003 | -13.9% | floor |
| 04-combat | 0.0015% | 0.0011% | -0.0004 | -27.3% | floor |
| 05-boss | 0.0096% | 0.0061% | -0.0035 | -36.2% | improved |
| 06-loaded-hud | 0.0052% | 0.0057% | +0.0006 | +10.8% | floor (known-red) |
| 07-interactables | 0.0024% | 0.0024% | +0.0000 | +0.0% | flat |
| 08-explosion | 0.0038% | 0.0034% | -0.0003 | -9.3% | floor |
| 09-survivors | 0.0117% | 0.0084% | -0.0033 | -28.0% | improved |
| 10-inventory | 0.0068% | 0.0058% | -0.0010 | -15.3% | floor |
| 11-bestiary | 0.0263% | 0.0166% | -0.0098 | -37.0% | improved |
| 12-boss-phases | 0.0124% | 0.0072% | -0.0052 | -42.1% | improved |
| 13-biomes-1 | 0.0239% | 0.0201% | -0.0038 | -15.7% | improved |
| **13-biomes-2** | **0.0891%** | **0.0245%** | **-0.0646** | **-72.5%** | **target** |
| 13-biomes-3 | 0.0591% | 0.0509% | -0.0082 | -13.8% | improved |
| 13-biomes-4 | 0.0193% | 0.0206% | +0.0013 | +6.9% | **floor** |
| 14-survivor-select | 0.0029% | 0.0029% | +0.0000 | +0.0% | flat |
| 15-logbook | 0.0001% | 0.0001% | +0.0000 | +0.0% | flat |
| 16-run-summary | 0.0095% | 0.0095% | +0.0000 | +0.0% | flat |
| 17-artifacts | 0.0028% | 0.0028% | +0.0000 | +0.0% | flat |
| 18-difficulty | 0.0003% | 0.0003% | +0.0000 | +0.0% | flat |
| 19-overkill | 0.0074% | 0.0094% | +0.0020 | +27.4% | floor (known-red) |
| 20-blight-edge | 0.0112% | 0.0108% | -0.0004 | -3.7% | floor |

**No shot regressed beyond the noise floor.** Three shots moved upward at all,
and all three are under the 0.0026 pp control floor:

- `13-biomes-4` +0.0013 pp — 0.5x the floor. The only terrain shot that did not
  improve; it is also the shot with the least far-field ground in frame.
- `19-overkill` +0.0020 pp — 0.8x the floor, and red on full runs by
  construction (only-path shot). Ignored per brief.
- `06-loaded-hud` +0.0006 pp — 0.2x the floor, and *smaller than the control
  pair's own movement on this same shot* (+0.0011 pp). Red pending a parallel
  fix. Ignored per brief.

Everything else is flat or better. The improvements outside the floor
(`11-bestiary` -37%, `12-boss-phases` -42%, `05-boss` -36%, `09-survivors` -28%,
`02-vista` -17%, `13-biomes-3` -14%, `13-biomes-1` -16%) are collateral *gains*:
`fineFade` is global to the `terrain` detail class, so every shot with far-field
ground in frame got the same de-aliasing. That is the fix working as described,
in the direction that costs nothing.

---

## 4. b1's far mountain — the verdict

This is the shot the original specular-AA fix closed (PEAK 8 -> 3 -> 0), and the
one this change most plausibly reopens, since it lowers far-field terrain detail
globally.

| ROI | ctrlA | ctrlB | post-fix | verdict |
|---|---:|---:|---:|---|
| **far mountain** `13-biomes-1` x300-425 y422-456 | **0.000%** | **0.000%** | **0.000%** | **holds — zero hits, not a rounded zero** |
| far right range `13-biomes-1` x1050-1550 y280-560 | 0.024% (33) | 0.022% (31) | **0.005% (7)** | improved 4.4x |
| `02-vista` right cliff x900-1500 y520-880 | 0.001% (3) | 0.001% (3) | 0.001% (3) | unchanged, identical hit count |

**b1's far mountain did not reopen.** It is 0 hits out of the ROI before and 0
after — there is no headroom for it to have degraded invisibly. The far right
range, which the diagnosis flagged as the second thing to watch, *improved* by
4.4x. `02-vista`'s right cliff is bit-identical at 3 hits.

### The property the pass exists to deliver

The diagnosis warned that (a) trades far-field ground detail for the aliasing,
and asked that "distant ranges recede" (`Materials.js:256-263`) be re-checked by
eye rather than by PEAK, since PEAK cannot tell de-aliasing from mush.

Compared side by side (`fix-spire-ctrlA/13-biomes-2.png` vs
`fix-spire/13-biomes-2.png`): the wall fins that carried the residual lose their
crawling sparkle and read as damp stone with intact silhouette and shading
gradient — the "crushed foil, not rock" the round-4 critic named is gone. The
near ground the player is standing on is unchanged, which is what the 110 fade
was chosen to preserve. The distant ranges still recede with their form and
aerial perspective intact; nothing flattened to a matte plate. At 99 m the fine
octave's 0.46 m relief spans 3.9 px, so what was surrendered is detail the frame
was barely resolving — as predicted.

### On (b) reversing an art decision

The diagnosis was careful that 0.82 is the art director's call, not a
measurement's. What ships restores `MAT_TUNE_BASE.terrain`'s roughness for the
canyon's *terrain* rung only. The biome's damp read is carried by the rungs
below it — `rock` 0.58, `cliff` 0.62, `wetStone` 0.045 near-mirror — all of
which stay shifted, and by the terrain's own `env` 1.25, which stays lifted. The
comment at the tune site was updated to say so rather than leaving the file
claiming a ladder shift that the terrain rung no longer takes.

---

## 5. Gates

- `node tests/run.mjs` — **47/47 test files passed**, 0 failed.
- `node node_modules/vite/bin/vite.js build` — **green**, built in 861 ms.

The build initially failed on `Cannot find native binding` for
`@rolldown/binding-win32-x64-msvc`. This is the known npx failure mode, not
anything in this change: the `.node` binary (20.8 MB) was present and intact
while its `package.json` had been deleted. Restored the `package.json` rather
than reinstalling. Recorded because the next agent to hit it should not spend a
round on `npm i`.

## 6. Files

- `reviews/round7/captures/fix-spire-ctrlA/`, `fix-spire-ctrlB/` — the pre-fix
  control pair that defines the noise floor. Both taken on this branch's tree
  *before* either edit.
- `reviews/round7/captures/fix-spire/` — post-fix, `--port 5316` as briefed.
- `reviews/round7/tools/fixcompare.mjs` — frame-PEAK diff across two capture
  directories; added here so the table above can be regenerated rather than
  trusted.

Known-red and untouched by this change: `06-loaded-hud`, `19-overkill`.
