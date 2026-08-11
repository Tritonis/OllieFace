# DIAG — `13-biomes-2`'s "far spire", root-caused

Diagnosis only. **No file under `src/` was touched**; `git status` shows no
modification to any source file at `HEAD 1911d79`. Every arm below is a
*runtime* mutation applied through the page and undone on the next arm, so
nothing here can ship and nothing here is a code change.

Answering `reviews/round6/HANDOFF.md` item 2 under "Open":

> **`13-biomes-2`'s far spire** — PEAK 0.222% -> 0.210%, not fixed. The
> specular-aliasing fix that works elsewhere (b1 far mountain PEAK 8 -> 3 -> 0)
> did not reach it.

**Verdict.** The fix reaches the surface. It fires at about **a tenth of the
strength it fires with on b1**, and it does so because the pass's own
resolution gate declares the offending octave *resolved* on a surface viewed
head-on. The residual is **the fine detail octave alone**, rendered through a
specular lobe the canyon biome deliberately tightened. It is **not** the
`b09c3d4` probe and **not** the UV normal map — both excluded by measurement,
below.

Two numbers, both already in `Materials.js`, close it: **measured PEAK
0.203% -> 0.024%**, against the verify line of 0.03%.

---

## 0. Instruments, and their calibration

`reviews/round7/tools/lattice.mjs` — PEAK plus an autocorrelation of the
high-passed ROI. PEAK is the round-4 world critic's definition (`L - max(8
neighbours) > 25`), re-implemented here so it can be checked rather than
inherited. `--selftest` output, run at `HEAD 1911d79`:

| input | PEAK | critic's published value |
|---|---:|---:|
| flat 128 | 0.000% | 0.000% |
| ramp 0..255 | 0.000% | 0.000% |
| 1-in-100 px +60 | 1.020% | 1.020% |
| 2x2 blocks every 12 | 0.000% | 0.000% |
| 3x3 blocks every 12 | 0.000% | 0.000% |

Four of four reproduce to the digit, including the two that matter most for
this diagnosis: **PEAK returns 0.000% on resolved 2x2 and 3x3 relief**, so a
non-zero PEAK is aliasing and not detail the filter cannot name.

The autocorrelation half calibrates too: white noise returns 0.020 at its
strongest lag >= 3; a planted period-10 grid returns **0.999 at lag 10**.

`reviews/round7/tools/reg.mjs` — Sobel-edge cross-correlation over integer
shifts, used to decide whether two arms are even looking at the same thing.
Block-mean luma cannot separate a re-framing from an exposure change (that is
why round 4's `w4frame.mjs` was withdrawn), so this registers on edge
*positions*.

`reviews/round7/tools/peakscan.mjs` — worst-window PEAK over a whole frame, so
a claim that a defect "went away" is tested against the frame and not only
against a box drawn a round ago.

`reviews/round7/tools/roiprobe.mjs` — raycasts the ROI in the live scene and
reconstructs `fw`, the quantity the detail pass's resolution gate consumes.

---

## 1. The round-6 ROI is stale. The defect is not.

`reviews/round6/HANDOFF.md` and `reviews/round6/FIX-world.md` §4 both name ROI
**x1000-1180 y30-260**. That box no longer photographs the surface it was drawn
around.

`reviews/round7/tools/reg.mjs`, on the named baseline
`reviews/round6/resume/13-biomes-2.png` (seed 1337, `clockPinned: true`):

| pair | correlation at (0,0) | best shift |
|---|---:|---|
| `round6/resume` vs `round6/FINAL` | **0.930** | (0,0) |
| `round6/resume` vs `round7/captures/diag-spire/13-biomes-2.png` | **0.028** | (-4,6), 0.040 |
| `round7/captures/diag-spire` vs `round7/captures/diag-spire-arms` | 0.886 | (0,0) |

So the instrument scores 0.93 between two captures of the same world and 0.03
between round 6's `13-biomes-2` and the one `tools/capture.mjs` produces at
`HEAD 1911d79`. 203 commits recomposed that shot. The old ROI now lands on a
near aqueduct pier and reads **PEAK 0.010%** — which is why it must not be
believed:

| file | ROI x1000-1180 y30-260 | PEAK |
|---|---|---:|
| `reviews/round6/resume/13-biomes-2.png` | the far canyon fin | **0.227%** |
| `reviews/round6/FINAL/13-biomes-2.png` | same | 0.220% |
| `reviews/round6/world2-base/13-biomes-2.png` | same | 0.222% |
| `reviews/round6/world2-final/13-biomes-2.png` | same | 0.210% |
| `reviews/round7/captures/diag-spire/13-biomes-2.png` | a near pier | 0.010% |

**A trap worth recording:** `reviews/round6/stages/13-biomes-2.png` reads
**0.010%** on that ROI too, and it would be very easy to conclude from the
round-6 arms alone that the stages agent's fix *did* close the spire and the
merge put it back. It did not. Cropped
(`reviews/round7/crops/b2-stages-roi.png`), that arm's ROI is sky, a distant
ridge and a water surface. Its world differs from `FINAL`'s the same way
`HEAD`'s does. Any comparison of those two arms on that box is a comparison of
two different subjects.

### Scan the frame, not the box

`peakscan.mjs`, 180x180 windows, stride 60:

| shot | round 6 `resume/` frame PEAK | HEAD `diag-spire/` frame PEAK |
|---|---:|---:|
| `13-biomes-1` | 0.0249% (worst window x721-901 y601-781, 0.170%) | 0.0238% (**same window, same 55 hits**) |
| `13-biomes-2` | **0.1312%** (worst x1381-1561 y181-361, 0.543%) | **0.0884%** (worst x181-361 y61-241, 0.364%) |
| `13-biomes-3` | 0.0600% (worst x781-961 y361-541, 0.463%) | 0.0597% (same window, 0.481%) |
| `13-biomes-4` | 0.0144% | 0.0183% |
| `07-interactables` | 0.0647% | **0.0024%** |

b1, b3 and b4 are unchanged frame-for-frame; only b2 recomposed (and 07
improved 27x). **b2 is still the noisiest shot in the biome set, by 3.7x over
b1.** The defect moved in frame; it did not go away.

### The round-7 ROI

**x240-560 y120-420**, 320x300, n = 95,082 interior px. HUD-free — verified by
crop (`reviews/round7/crops/b2-HEAD-roi7.png`). It is the canyon's tapered wall
fins, the same "crushed foil, not rock" surface the round-4 critic described.

`reviews/round7/captures/diag-spire/13-biomes-2.png` (the canonical
`tools/capture.mjs` run at HEAD, `manifest.json`: `ready true`,
`clockPinned true`, 23 shots): **PEAK 0.211%**.

The round-6 number was 0.210-0.227%. **The defect survived 203 commits at
unchanged magnitude.**

---

## 2. What the surface is

`reviews/round7/tools/roiprobe.mjs`, 960 samples over the round-7 ROI
(`reviews/round7/captures/diag-spire-arms/roi-probe.json`):

| quantity | p10 | p50 | p90 |
|---|---:|---:|---:|
| hit distance (m) | 92.81 | **98.63** | 103.38 |
| `abs(cos)` incidence | 0.643 | **0.932** | 0.962 |
| `fw` (world metres per pixel on the surface) | 0.1156 | **0.1261** | 0.1947 |

- **952 of 960 samples hit `terrain` with `detKind: 'terrain'`** (8 sky). Not a
  prop, not `rock`, not `cliff` — the terrain mesh.
- It is **viewed close to head-on** (cos 0.932), at ~99 m.
- `13-biomes-2` is the **canyon** (`Materials.js:1269`, `profile: 'canyon'`),
  not the cavern. `TerrainGen._spires` never runs on it — the live terrain
  reports `spires: 0`. The "spire" is the canyon's tapered wall fins, terrain
  heightfield, `STEP` 1.375 m.

---

## 3. The bisect

Every arm mutates one term on `ctx.stage.terrain.mesh.material`, renders three
frames on the pinned clock, shoots, restores. `ctrl-a` and `ctrl-b` bracket
each set, so the cost of those three frames is measured rather than assumed.
ROI = x240-560 y120-420.

**Set 1** — `reviews/round7/captures/diag-spire-arms/`:

| arm | what it removes | ROI PEAK | vs ctrl |
|---|---|---:|---:|
| `ctrl-a` | - | 0.204% | - |
| `ctrl-b` | - | 0.212% | drift **0.008 pp (3.9%)** |
| `env0` | `envMapIntensity` 1.25 -> 0 | 0.205% | **-1.4%, inside drift** |
| `nmap0` | `normalMap` detached | 0.215% | **+3.4%, inside drift** |
| `rough1` | `roughness` -> 1.0 | **0.034%** | **-84%** |
| `det0` | both detail octaves -> 0 | **0.018%** | **-91%** |

**Set 3** — `reviews/round7/captures/diag-spire-arms3/` (ctrl 0.205 / 0.211):

| arm | ROI PEAK | vs ctrl |
|---|---:|---:|
| `coarse0` (`coarseAmp` 0.78 -> 0) | 0.220% | +6%, inside drift |
| `cav0` (`cavity` 0.70 -> 0, kills detCav *and* the sky-visibility weight) | 0.212% | inside drift |
| `rmod0` (`roughMod` 0.20 -> 0) | 0.206% | inside drift |
| `rmodNeg` (`roughMod` -> -0.20) | 0.232% | +12% |
| **`fine0` (`fineAmp` 1.15 -> 0)** | **0.046%** | **-78%** |

Reproduced independently in set 4 (`fine0` = 0.047%, ctrl 0.210/0.219).

### What this establishes

1. **It is specular** — `rough1` cuts it 6x. (This reproduces round 6's own
   decisive bisect on b1, on a different biome and a different surface.)
2. **It is the detail pass's normal perturbation** — `det0` cuts it 11.6x.
3. **It is the fine octave and nothing else.** `fine0` alone gets 78% of the
   way to `det0`; `coarse0` moves nothing.
4. **It is NOT the `b09c3d4` per-pixel probe.** `env0` removes the terrain's
   entire environment-map contribution and the ROI does not move (-1.4%,
   inside a 3.9% control drift). Handoff item 5 asks explicitly for this to be
   stated: **the spire residual does not trace to per-pixel probe reflections,
   and nothing here argues for touching `b09c3d4`.**
5. **It is NOT the UV normal map**, so round 6's Toksvig term was aimed at a
   contributor worth nothing here — which is exactly what its measured
   0.222% -> 0.220% said.

---

## 4. Why the existing fix does not reach it — `file:line`

The specular-AA term is `src/world/Materials.js:744`:

```
roughnessFactor = sqrt( min( 1.0, roughnessFactor * roughnessFactor + detAlpha ) );
```

with `detAlpha` assembled at `Materials.js:709` and `:740`:

```
float detAlpha = min( 2.0 * detVarS, 0.45 ) + min( detVarW, 0.60 );   // :709
detAlpha += min( detTok * dot( normalScale, normalScale ) * 0.5 * uvK * uvK, 0.50 );  // :740
```

The Toksvig term at `:740` is excluded by the `nmap0` arm. The world-space
term `detVarW` is built at `Materials.js:430`:

```
varOut += detHidden( uDetA.y * fineDist, fineRes );
```

from `detHidden`, `Materials.js:414-417`:

```
float detHidden(float amp, float res) {
  float a = amp * uDetE.w;
  return a * a * (1.0 - res * res);
}
```

**`1.0 - res*res` is the whole problem.** `detHidden` charges the specular lobe
only for the energy the pixel footprint *hid*. `res` comes from `detRes`,
`Materials.js:376`:

```
float detRes(float featM, float fw) {
  return 1.0 - smoothstep(0.20, 0.60, fw / max(featM, 1e-4));
}
```

Substituting the probed values (`fw` p50 = 0.1261 m, `DETAIL.terrain.fine` =
0.46 m at `Materials.js:309`, `_detGradRms` = 0.3789 from
`diag-spire-arms/facts.json` `uDetE.w`):

| term | b2 canyon fin (measured) |
|---|---|
| `fw / fine` | 0.1261 / 0.46 = 0.274 |
| `fineRes` | **0.910** |
| `1 - fineRes^2` | **0.172** |
| `coarseRes` (`fw`/2.2 = 0.057) | **1.000** -> coarse contributes **exactly 0** |
| `fineDist` (dist 98.6 m vs `fineFade` 400, `Materials.js:310`) | **1.000** — no fade at all |
| `a = fineAmp * gradRms` | 1.15 x 0.3789 = 0.4357 |
| `detVarW` | 0.4357^2 x 0.172 = **0.0327** |
| base `roughnessFactor` (canyon `matTune.terrain`, `Materials.js:1296`) | **0.700** |
| roughness after the fix | sqrt(0.49 + 0.033) = **0.723** |

**The entire specular-antialiasing fix moves this surface's roughness from
0.700 to about 0.723.** That is the answer to "why the fix does not reach the
spire": it is not bypassed and it is not switched off — it is *gated down to
17% of the fine octave's energy by its own resolution test*, and to 0% of the
coarse octave's.

### The asymmetry with b1, stated as arithmetic

`Materials.js:653-660` already names the asymmetry qualitatively — "13-biomes-1's
far mountain is viewed at a hard rake ... 13-biomes-2's far right spire is
viewed close to head-on". The probe supplies the numbers. `fw` is
`max(length(dFdx(vDetW)), length(dFdy(vDetW)))` (`Materials.js:602`), so it is
inflated by foreshortening. At cos 0.932 the canyon fin barely inflates it at
all and `fineRes` stays at 0.910. On a surface at a hard rake `fw` is several
times larger, `fineRes` collapses toward 0, `1 - res^2` goes to 1.0, and
`detVarW` reaches 0.190 — **5.8x what this surface gets** — on top of a base
roughness of 0.82 rather than 0.70, and with the masking clamp at
`Materials.js:640-641` also firing.

Round 6 read that comment as "b2 is neither view-grazing nor light-grazing, so
the clamp cannot help", and stopped at the clamp. The clamp is not the only
thing grazing incidence was buying: **it was also the only reason `detVarW` was
non-trivial on b1.**

### Two confirmations that the gate, not the gain, is the ceiling

`reviews/round7/captures/diag-spire-arms2/` (ctrl 0.197 / 0.203):

| arm | ROI PEAK |
|---|---:|
| `grad2` — `uDetE.w` x2, i.e. **`detVarW` x4** | 0.172% (-14%) |
| `grad4` — `uDetE.w` x4, i.e. **`detVarW` x16** | 0.105% (-47%) |

A sixteen-fold gain on the world-space variance term buys 1.9x. `detVarW` is
neither zero nor saturated at its 0.60 cap — it is simply multiplied by a
number (0.172) that no re-weighting of the term itself can fix. Re-tuning
`detAlpha`'s coefficients is the wrong lever, and this is the evidence for
saying so before someone spends a round on it.

| arm | ROI PEAK |
|---|---:|
| `r074` (roughness 0.70 -> 0.74) | 0.177% (-11%) |
| `r078` | 0.152% (-24%) |
| `r082` (back to `MAT_TUNE_BASE`) | 0.119% (-40%) |
| `d070` (both amplitudes x0.70) | 0.201% (inside drift) |
| `d050` (both amplitudes x0.50) | 0.134% (-33%) |
| `r082d070` | 0.111% (-45%) |

**No single knob reaches 0.03%.** That is worth stating plainly, because three
rounds of this project have been spent on single-knob retunes of this pass.

### The lattice hypothesis from `FIX-world.md` §4 — measured, and it belongs to the old frame

Round 6 handed on a crop reading of "a regular rectangular lattice at roughly
10 source pixels' spacing" and asked the next agent to measure its period
against `DETAIL.cliff.fine x DET_CELLS` and the UV repeat. Measured by
autocorrelation:

| file | ROI | strongest lag >= 3, x | y |
|---|---|---|---|
| `round6/resume/13-biomes-2.png` | x1000-1180 y30-260 | **18 (0.130)** | **18 (0.104)** |
| `round6/FINAL/13-biomes-2.png` | same | 18 (0.138) | 18 (0.112) |
| `round6/detON/13-biomes-2.png` | same | 18 (0.103) | 18 (0.069) |
| `round7/captures/diag-spire/13-biomes-2.png` | **x240-560 y120-420** | 22 (0.027) | 4 (0.062) |

The lattice is real in round 6's frame — an isotropic period-18 bump, well
above the instrument's 0.020 white-noise floor, present pre-fix and after it.
It is **absent from the surface that carries the residual at HEAD** (0.027 is
the noise floor). So it is a property of the round-6 composition, and **the
next fix should not be aimed at it.** Recorded so the request is not re-issued
a fourth time.

---

## 5. Proposed minimal fix — measured, not predicted

Two numbers, both already in `src/world/Materials.js`. I did not implement
either; the numbers below are the *arms*, applied at runtime to the live
uniforms and shot.

**(a) `DETAIL.terrain.fineFade` 400 -> 110** — `src/world/Materials.js:310`.

400 is by a wide margin the longest fade in the table (`rock` 110, `cliff` 55,
`moss` 70, `sand` 60, `wood` 26). `fineDist = 1 - smoothstep(0.45*fineFade,
fineFade, dist)` (`Materials.js:428`), so at 400 the fine octave holds **full
amplitude to 180 m** in a stage that is 220 m across: it never fades anywhere a
player can see. At 110 it retires between 49.5 m and 110 m and is gone by the
fins at 98.6 m, while surviving intact over the ground the player is standing
on — which is the reason the 400 was chosen (`Materials.js:309`: "the one
surface the player is always inside the near band of").

**(b) canyon `matTune.terrain.roughness` 0.70 -> 0.82** —
`src/world/Materials.js:1296`, back to `MAT_TUNE_BASE.terrain`
(`Materials.js:1143`).

`reviews/round7/captures/diag-spire-arms5/`, ROI x240-560 y120-420,
**ctrl-a 0.203% and ctrl-b 0.203% — zero control drift on this run**:

| arm | ROI PEAK | frame PEAK |
|---|---:|---:|
| `ctrl-a` / `ctrl-b` | 0.203% / 0.203% | 0.0879% / 0.0890% |
| `ff160` (fineFade 400 -> 160) | 0.203% | 0.0802% |
| `ff220` | 0.205% | 0.0898% |
| `ff110` (**(a) alone**) | **0.060%** | 0.0442% |
| `r082` (**(b) alone**, set 2) | 0.119% | 0.0484% |
| `ff160r082` | 0.101% | 0.0413% |
| **`ff110r082` — (a) + (b)** | **0.024%** | **0.0241%** |

**PEAK 0.203% -> 0.024%, against a verify line of 0.03%. Met.** Frame-wide b2
goes 0.0879% -> 0.0241%, which puts it level with `13-biomes-1` (0.0238%) and
`13-biomes-4` (0.0183%) instead of 3.7x above them.

Neither half is sufficient alone (0.060%, 0.119%) and the 160/220 arms show the
fade has to reach past the fins to do anything — so this is not two knobs
turned until a number moved; it is the one knob that removes the octave the
bisect isolated, plus the one that widens the lobe the bisect proved is
rendering it.

### What this costs, and what must be re-verified before it ships

- **(a) is global to the `terrain` detail class**, so it touches all four
  biomes and every world shot. It trades far-field ground detail for the
  aliasing. Re-verify at minimum: b1's far mountain at PEAK 0.000%
  (`round6/FINAL` x300-425 y422-456), b1's far right range (x1050-1550
  y280-560), `02-vista`'s right cliff (x900-1500 y520-880, PEAK 0.004%), and
  the "distant ranges recede" property the pass exists to deliver
  (`Materials.js:256-263`). The fine octave carries relief at 0.46 m; at 99 m
  that is 3.9 px, so what is being given up is detail the frame is barely
  resolving anyway.
- **(b) reverses a deliberate art decision.** `Materials.js:1292-1295` says the
  canyon shifts "the whole ladder down a rung" because "everything is damp".
  0.82 is the base value, not a new invention, but it is the art director's
  call, not a measurement's. If 0.82 is refused, `r078` measured 0.152% alone
  and `ff110` + 0.78 is untested — it should be armed before assuming it
  clears.
- **(a) + (b) were measured in one arm.** They should be re-measured
  independently after implementation, on a fresh full `tools/capture.mjs` run,
  not on the arm PNGs in this directory.

### Alternatives considered and rejected on evidence

- **Re-weight `detAlpha`.** `grad4` gives it a 16x gain and reaches only
  0.105%. Rejected.
- **Scale the detail amplitudes globally.** `d050` reaches 0.134%. Rejected.
- **A floor on `1 - res*res` in `detHidden`** (charging the lobe for resolved
  slope too) is the principled shader fix, and it is what would generalise. It
  also raises roughness on every near, well-resolved rock surface in the build
  — the one thing four rounds of critics have told implementers not to do
  unmeasured. Not proposed here without an arm, and there is no uniform that
  lets me arm it without a source change.
- **Reverting `b09c3d4`.** Excluded by the `env0` arm, and out of scope by the
  brief. Stated for the record: the probe is not implicated in this ROI.

---

## 6. Files

Captures (all at `HEAD 1911d79`, seed 1337, `clockPinned: true`):

- `reviews/round7/captures/diag-spire/` — full `tools/capture.mjs` run, 23
  shots + `manifest.json`. This is the round-7 baseline for b2.
- `reviews/round7/captures/diag-spire-arms/` — bisect set 1 + `facts.json` +
  `roi-probe.json`.
- `reviews/round7/captures/diag-spire-arms2/` — roughness / amplitude /
  `detVarW`-gain dose-response.
- `reviews/round7/captures/diag-spire-arms3/` — octave and side-path isolation.
- `reviews/round7/captures/diag-spire-arms4/` — fine-octave floor bracket.
- `reviews/round7/captures/diag-spire-arms5/` — the proposed fix.

Tools: `reviews/round7/tools/{lattice,reg,peakscan,roiprobe,spireprobe,spirearms2..5}.mjs`.
Crops: `reviews/round7/crops/`.

Known-red and not mine: `06-loaded-hud`, `19-overkill`.
