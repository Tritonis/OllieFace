# Round 7 — round-3 critique: audio (`Music.js`, `Audio.js`, `tools/capture.mjs`)

Independent round-3 critic. Branch `round7/content-and-polish`, HEAD `b18a2b4`.
I was not involved in building or fixing this. Every number below is my own
measurement from my own instruments; nothing is inherited from
`reviews/round7/round3-fix-audio.md` or `reviews/round7/r3-audio/`.

**Verdict: FAIL.** 2 critical, 5 major, 4 moderate, 4 minor.

Two of the findings are load-bearing. The intensity model — the whole subject of
round 3's MAJOR 2 — is arithmetically dead from roughly difficulty 3.2 onward,
and round 3 is what moved that point forward into ordinary play. And
`tools/capture.mjs`'s new audio gate emits **zero** sequencer steps inside its own
measurement window on the full 21-shot run, and passes a build in which not one
sample of audio is produced.

---

# 1. Methodology

Four instruments, all driving the product code, none of it modified. Scripts and
raw JSON are under `reviews/round7/r4-audio/`. I kept the probe scripts rather
than deleting them: every reproduction below is a command line against one of
them, and deleting them would make the findings unrepeatable.

| artefact | what it is |
|---|---|
| `r4-audio/probeA.mjs` → `probeA.json` | Node, no browser. Drives the real `MusicEngine` on a stub `AudioContext` that records every node creation and every `AudioParam` write with its scheduled time. Intensity model, opening ceiling, resync, hat quantisation, latches. |
| `r4-audio/probeA2.mjs` → `probeA2.json` | The same rig, with per-node parameter tagging, isolated to the one shared `acidFilter`. (Probe A's first pass aggregated every biquad into one stream and produced a false "161 out-of-order writes"; A2 is the corrected instrument and the one I cite.) |
| `r4-audio/probeB.mjs` → `probeB.json` | Playwright + vite. Renders the real `MusicEngine` and the real `Audio` graph sample-exactly in an `OfflineAudioContext` behind a settable-clock facade, and analyses the waveform: per-layer isolated loudness, DC, clipping, sample-to-sample slew at layer-commit boundaries, 50 ms window peaks, sub-30 Hz energy. |
| `r4-audio/probeB2.mjs` → `probeB2.json` | Probe B's graph section with three artefacts fixed (voice counter reset per SFX, limiters bypassed by rewiring rather than by neutral settings, ambient isolated). |
| `r4-audio/probeC.mjs` → `probeC.json` | The live game, real Chromium on the GPU path with the launch flags copied from `tools/capture.mjs`, a real mouse gesture, a real `AudioContext`. Voice cap, pickup path, 60 s of instrumented combat at 2 Hz, forced late-run arc, the latches. |
| `r4-audio/capture-instrumented.mjs` | A copy of `tools/capture.mjs` with **telemetry only** added around the audio gate (engine state at four points), plus an opt-in `--sabotage` that no-ops `OscillatorNode.prototype.start/stop` and `AudioBufferSourceNode.prototype.start/stop`. Nothing else differs from the product file. |
| `r4-audio/shots-r4/` | Full 21-shot capture, instrumented copy, GPU path. |
| `r4-audio/shots-r4-sabotage/` | Full 21-shot capture, `--sabotage`. |
| `r4-audio/shots-r4-sw/` | `--software --only 01-title`, the untested renderer path. |

Commands actually run:

```
node reviews/round7/r4-audio/probeA.mjs   > reviews/round7/r4-audio/probeA.json
node reviews/round7/r4-audio/probeA2.mjs  > reviews/round7/r4-audio/probeA2.json
node reviews/round7/r4-audio/probeB.mjs  --port 5311
node reviews/round7/r4-audio/probeB2.mjs --port 5316
node reviews/round7/r4-audio/probeC.mjs  --port 5312
node reviews/round7/r4-audio/capture-instrumented.mjs --out reviews/round7/r4-audio/shots-r4          --port 5313
node reviews/round7/r4-audio/capture-instrumented.mjs --sabotage --out reviews/round7/r4-audio/shots-r4-sabotage --port 5314
node reviews/round7/r4-audio/capture-instrumented.mjs --software --only 01-title --out reviews/round7/r4-audio/shots-r4-sw --port 5315
```

## The hole I checked for first

Round 3's own correction was that three live runs died 70 s in and turned every
statistic into a measurement of a stopped sequencer. My live probe records
`engineStoppedSamples` and `playerDeadSamples` for the same reason and reports
**0 and 0** across 113 samples (`probeC.json:combat`). It also caps player damage
inside a wrapper on `Combat.applyDamage`, so hits still land and the duck and the
voice cap are still exercised.

A second class of the same error nearly caught me: probe A's first run
aggregated every `BiquadFilterNode.frequency` in the graph into one event stream
and reported 161 out-of-order writes on the acid filter. That was my instrument,
not the code. Probe A2 tags each node's params separately and reports zero. I am
recording it because a reader should be able to see which of my numbers came
from an instrument I had to correct.

## What I could not do

- **I could not listen.** Everything here is rendered or introspected. Round 3
  said the same and it is still true.
- I did not run a full 21-shot `--software` capture (~1 hour at the shipped
  180 s per-shot timeout); only `--only 01-title --software`.
- I did not run a real networked session. The client-side `playerDead` latch is
  proved by a static trace through `NetHost.js:57` → `NetClient.js:106` →
  `Audio.js:178` plus a single-process reproduction on the same event bus.
- **Inconclusive:** probe B2's offline "limiters bypassed" comparison shows a
  constant **+1.29 to +2.87 dB** with the limiters engaged, at every content
  level. A constant offset independent of level is not compression, and I could
  not attribute it. I therefore do **not** rely on it; the load-bearing limiter
  measurement is the live `DynamicsCompressor.reduction` meter in probe C.
- Round 3's "windows below −50 dBFS peak: 46 of 139 → 10 of 139" uses an
  absolute threshold against a render whose gain staging I cannot reconstruct.
  I verified only the qualitative half of that claim (no digital-silence window).

---

# 2. Verification table — round 3's claims against my own numbers

| # | Round-3 claim | Their number | My number | Verdict |
|---|---|---|---|---|
| 1 | intensity reaches **I = 0.886** in a stage-1 fight | 0.8864 max | 0.8432 max over 60 s live; analytic ceiling **0.892** at `arc = 0.1` | **CONFIRMED** (attainable) |
| 2 | `acid` now audible | 0.49 (full) | 0.49, full, live | **CONFIRMED** |
| 3 | `lead` now audible ("entered") | 0.467 of 2.12 | **0.000** in my 60 s run; ceiling permits at most 0.354 of 2.12 at `arc = 0` | **REFUTED** |
| 4 | layer balance span **35.6 → 16.0 dB** | 16.0 dB | **16.98 dB** RMS | **CONFIRMED** |
| 5 | "every layer lands within 0.3 dB of its target" | ±0.3 dB | `perc` −16.98 vs target −16 (1.0 dB out); `openhat` −10.42 vs −10 | **REFUTED** |
| 6 | master limiter worst **−12.16 → −0.74 dB**, mean −3.70 → −0.03 | −0.74 / −0.0275 | **−0.524 / −0.015** | **CONFIRMED** |
| 6b | *(unreported)* the new `sfxLimiter` | — | worst **−8.86 dB**, mean **−2.816 dB**, continuous | new finding — see D4 |
| 7 | **8 bars, 0 rewinds** across three 0.6 s stalls | 8 / 0 | 6 bars / **0 rewinds** (12 s, my stall placement); no-stall control also 6 bars | **CONFIRMED** |
| 8 | `playerHurt` survives the voice cap at `voices = 40` | duck moved 0.48 → 0.205 | duck moved 0.48 → **0.188** → 0.48; the **sound spent 0 voices** | **PARTIALLY REFUTED** — see M1 |
| 9 | opening ceiling: `_runT` 44.65 → **0.00 s**, I at 6 s 0.660 → 0.207 | 0.00 / 0.207 | `_runT` **0.00**; I at 6 s **0.170** = exactly `0.10 + 6/60·0.70` | **CONFIRMED** |
| 10 | acid envelope repaired; longest flat 105.7 → 41.2 ms | 41.2 ms | **0** out-of-order writes, **0** ramps crossing the next note, longest hold **27.9 ms** | **CONFIRMED** |
| 11 | hats bar-quantised, 6/13 → 11/13 clean bars | 11 of 13 | **15 of 15** clean under ±0.02 dither | **CONFIRMED** |
| 12 | `_take` refusals 4893 → **1389** (9.3/s) | 9.3/s | **48.8/s** (2928 in 60 s) at comparable enemy density | **NOT REPRODUCED** — see M5 |
| 13 | pickup tier resolves from the payload | tiers 0/1/2 | common→0, uncommon→1, legendary→2, boss→3, lunar→4 | **CONFIRMED** |
| 14 | removal plays `deny()` | yes | yes | **CONFIRMED** — and see M4 |
| 15 | the 40 ms throttle collapses the duplicate pair | yes | yes — and it also silences two *different* items granted in one frame | **CONFIRMED w/ regression** — see D2 |
| 16 | bed no longer falls to digital silence (−180 → −65.2 dB) | −65.2 dB | min 50 ms window peak **−72.9 dB** at I = 0; no digital-silence window | **CONFIRMED** (directionally) |
| 17 | music-to-explosion RMS deficit 10.35 → **7.60 dB** | 7.60 dB | **6.42 dB** | **CONFIRMED** |
| 18 | engine dynamic range preserved at **7.71 dB** | 7.71 dB | **7.46 dB** | **CONFIRMED** |
| 19 | `MUSIC_BUS = 0.80` reaches the bus | 0.16073 at vol 0.2 | music bus **0.48** at the shipped `musicVolume 0.6` | **CONFIRMED** |
| 20 | the gate "fails when the sequencer throws" | proved | true **only** when it throws from the first frame | **CONFIRMED but narrow** |
| 21 | the gate is evidence the audio system runs | implied throughout | **0 steps** emitted in the gate window on the full run; passes a totally silent build | **REFUTED** — see C2 |
| 22 | "without a gesture no line of `Audio.js` or `Music.js` ever executes under this harness" (`capture.mjs:449-452`) | premise | **305 steps** already emitted and `ac.state: "running"` *before* the keypress | **REFUTED** — see D3 |
| 23 | untested arm: `stageStart` with `index > 0` must not reset | untested | verified — `_runT` 84.03 → 84.66 s across `stageStart{index:2}` | **CONFIRMED** |
| 24 | untested arm: boss / teleporter floors | untested | `director.boss`, `progression.state === 'charging'`, `director.populationCap` all correctly named; floors yield I = 0.822 / 0.844 at diff 2.0 | **CONFIRMED by construction** |
| 25 | untested arm: `--software` capture | untested | `--software --only 01-title` passes, gate emits 14 steps in-window | **CONFIRMED** (partial run only) |
| 26 | untested arm: **a run past stage 1** | untested | the intensity model is dead from diff ≈ 3.2 | **REFUTED** — see C1 |
| 27 | untested arm: a multiplayer client | static analysis only | a teammate's death permanently silences the client | **REFUTED** — see M3 |

---

# 3. Findings

## CRITICAL

### C1 — `arc` saturates and annihilates the intensity model from difficulty ≈3.2. Round 3 caused this.

**Where:** `src/systems/Music.js:260` and `src/systems/Music.js:290`.

```js
this.arc = clamp(((ctx.director?.difficultyCoefficient ?? 1) - 1) / 2.5, 0, 1);
...
let I = this.arc + (1 - this.arc) * this.pressure * 0.88;
```

When `arc` reaches 1, the second term is multiplied by `(1 - arc) = 0` and
`I = 1` **unconditionally**. `pressure`, `_heat`, `_sustain`, `bump()` and
`cool()` all become no-ops. `arc = 1` at `difficultyCoefficient = 3.5`.

**Measured** (`probeC.json:lateArc`, live, difficulty pinned and the arena
emptied of every enemy so `pressure` decays to its floor):

| difficulty | arena | `pressure` | **I** | bpm | layers up |
|---|---|---|---|---|---|
| 2.0 | empty | 0.158 | 0.4835 | 129.6 | through `openhat` (half) |
| 2.875 | empty | 0.141 | 0.7809 | 136.7 | through `acid` |
| **3.2** ("Fracturing") | **empty** | 0.052 | **0.8855** | 139.3 | **everything, `lead` entering** |
| **3.5** | **empty** | 0.054 | **0.9856** | 141.7 | **everything at maximum** |
| 4.5 | empty | 0.168 | **1.0000** | 142.0 | everything at maximum |
| 6.0 | empty | 0.038 | **1.0000** | 142.0 | everything at maximum |
| 3.5, then `cool()` | empty | 0.107 | **1.0000** | 142.0 | unchanged by `cool()` |

The last row is the one that matters most: `cool()` exists solely so a stage
transition drops the track over an empty arena (`Music.js:225-229`,
`Audio.js:166`). Past difficulty 3.5 it does nothing at all.

**Reachability.** `Director.js:216`, `Director.js:187`, solo on Rainstorm:
`difficulty = (1.0 + t·0.001687) · 1.15^stagesCompleted`. Difficulty 3.5 arrives at

| stages completed | wall clock to diff 3.5 | to diff 3.2 |
|---|---|---|
| 4 | 9.9 min | 8.0 min |
| 6 | 5.1 min | 3.5 min |
| 8 | 1.4 min | 0.6 min |

Monsoon multiplies the time term by 1.5 and brings all of these forward again.
The harness's own `lateRun` scenario sets 22 minutes on the difficulty clock and
`E-framing.md` records the resulting HUD as "HARD x3.2" — i.e. the shipped
screenshot set already photographs a state in which the soundtrack is pinned.

**This is a round-3 regression, not a pre-existing one.** Before the fix,
`arc = (d-1)/5` with a 0.7 blend coefficient. In the same empty arena at
difficulty 3.2 the old code gives `arc = 0.44`, `I ≈ 0.46` — the kit half
assembled and still responsive. Round 3 moved the point at which the model dies
from difficulty 6 ("Collapse", a late-run curiosity) to difficulty 3.2
("Fracturing", a place every run passes through). The report names this as
untested arm #2 and calls `arc = 1 at difficulty 3.5` "a calculation, not a
measurement". It is now a measurement, and it is a defect.

**Reproduce:** `node reviews/round7/r4-audio/probeC.mjs --port 5312`, read
`probeC.json:lateArc`. Or analytically:
`node reviews/round7/r4-audio/probeA.mjs`, read `probeA.json:intensity` — the row
`stage4 EMPTY arena diff3.5` reports `I: 1, pressure: 0, sustain: 0`.

**Fix.** `arc` must not be able to reach 1, or must not be blended
multiplicatively. The minimal change is to cap the arc's authority so pressure
always keeps a share of the range, e.g.

```js
this.arc = clamp(((ctx.director?.difficultyCoefficient ?? 1) - 1) / 2.5, 0, 1) * 0.65;
```

which pins the late-run floor at 0.65 and leaves `pressure` 0.31 of headroom
(`I` spans 0.65 → 0.96), so a full arena is still audibly different from an empty
one at difficulty 6 and `cool()` still does something. Whatever number is chosen,
the invariant to state and test is `max(I) - min(I) > 0` **for every reachable
`arc`**, which today it is not.

---

### C2 — the capture gate measures nothing, and passes a build that produces no audio at all.

**Where:** `tools/capture.mjs:479-492`.

Two independent failures, both measured.

**(a) The gate window emits zero steps.** The final scenario, `16-run-summary`,
reaches the summary by killing the player (`Harness.js:5083-5084`, or via
`Combat._kill` at `Combat.js:516`). That raises `playerDead` on the bus,
`Audio.js:178` handles it, and `Audio.playerDead()` calls
`this.musicEngine.stop(t)` — which latches `stopped = true` forever (see M3). By
the time the gate presses `KeyZ`, the sequencer is already dead.

Telemetry from the instrumented copy of the product file
(`shots-r4/manifest.json:r4`), full 21-shot GPU capture:

| point | `stepsEmitted` | `musicEngine.stopped` | `_musicOff` | `music.gain` | player alive |
|---|---|---|---|---|---|
| before `KeyZ` | 305 | **true** | true | 0.01534 | false |
| after `KeyZ` | 305 | true | true | 0.01502 | false |
| after `thaw()` | 305 | true | true | 0.01447 | false |
| after `frames(90)` | **305** | true | true | 0.00235 | false |
| | **`stepsEmittedDuringGateWindow: 0`** | | | | |

`manifest.audioOk: true`. The gate passed on a capture in which the sequencer
was verifiably stopped, the music bus was at −52 dBFS and falling to zero, and
the ambient bed was latched off. `stepsEmitted` is a cumulative counter that is
never reset (`Music.js:164`), so `> 0` asserts only that the engine ran *at some
point during the whole run* — which it did, 305 steps' worth, during scenarios
that finished minutes earlier.

The gesture, the `thaw()` and the 90 frames contribute exactly nothing to the
assertion on the only configuration that ships.

**(b) The gate passes a totally silent build.** I ran the same instrumented copy
with `--sabotage`, which no-ops `OscillatorNode.prototype.start/stop` and
`AudioBufferSourceNode.prototype.start/stop` in an `addInitScript`. Every node is
still created, connected, scheduled and counted; not one of them ever starts.
The game produces **zero samples of audio, music and SFX alike, for the entire
run**, and throws nothing.

`shots-r4-sabotage/manifest.json`:

```
audioOk: true
audio: {"ready":true,"state":"running","stepsEmitted":330,"newErrors":[]}
errors: 1   (the pre-existing 06-loaded-hud subject check, unchanged)
```

Exit code 1, from the same pre-existing subject failure and nothing else — byte
for byte the same signal as the clean run.

Round 3's proof that "the gate was proved to fail" injected `throw` at the top of
`MusicEngine._schedule`, which throws from the first frame and so keeps the
cumulative counter at zero. That is the only regression class this gate catches:
*an engine that is broken before it ever runs*. It cannot catch an engine that
runs and then dies, an engine that runs and is inaudible, or a graph that is
never connected — and it is currently, on every run, in the first of those
states.

**Reproduce:**
```
node reviews/round7/r4-audio/capture-instrumented.mjs --out reviews/round7/r4-audio/shots-r4 --port 5313
node reviews/round7/r4-audio/capture-instrumented.mjs --sabotage --out reviews/round7/r4-audio/shots-r4-sabotage --port 5314
```
then read `manifest.r4` and `manifest.audioOk` in each.

**Fix.** Three changes, all in `tools/capture.mjs`:

1. **Take a delta, not a level.** Read `stepsEmitted` immediately before the
   gesture and again after `frames(90)`; assert the *difference* is greater than
   a floor (the software run emitted 14, so `>= 8` is a safe floor).
2. **Assert the engine is alive**, not merely that a counter is non-zero:
   `stopped === false`, `silent === false`, `ac.state === 'running'`,
   `music.gain.value > 0`, and `master.gain.value > 0`.
3. **Assert something was audible.** The cheapest honest check is an
   `AnalyserNode` tapped onto `master` for the 90-frame window with
   `getFloatTimeDomainData` sampled a few times, asserting a peak above a floor.
   A step counter can never be that evidence. Failing that, run the gate
   *before* `16-run-summary` (its own comment already establishes that placement
   before the *first* scenario perturbs the shots; placing it between
   `10-inventory` and `16-run-summary` perturbs only `16-run-summary`, which can
   be re-measured against the existing three-run noise floor).

---

## MAJOR

### M1 — `playerHurt`'s audible cue is still dropped by the voice cap. Only the duck was rescued.

**Where:** `src/systems/Audio.js:698`.

```js
if (!this._take(3, true)) return;      // <- the sound
```

Round 3's CRITICAL 1 is titled "`playerHurt` dropped by the SFX voice cap" and
its evidence row is `playerHurt(40) at voices = 40 → music duck: 0.48 → 0.205,
moved: true`. That row measures the **duck**, which was moved above the gate and
made unconditional. The three voices that are the actual damage sound are still
behind `_take`, and `_take(3, true)` is `voices + 3 <= 40`, i.e. false for any
`voices >= 38`.

**Measured** (`probeC.json:voiceCap.hurtAtVoices40`, live, real `AudioContext`):

| | value |
|---|---|
| `music.gain` before | 0.48000 |
| `music.gain` +80 ms | **0.18801** — the duck fired |
| `music.gain` +1 s | 0.48000 — and restored |
| **voices spent by `playerHurt`** | **0** |

The duck is real and it is an improvement. The sound is still gone, in exactly
the busy fight the critique said it was being deleted from.

**Fix.** `playerHurt` is three nodes and it is the player's primary off-screen
threat signal. Either exempt it entirely (drop the `_take` and let `_release`
account for it, as the music bus already does), or make the reserve a genuine
reserve by giving priority sounds their own counter:
`_take(cost, priority)` → `priority ? this._priorityVoices + cost <= PRIORITY_RESERVE
: this.voices + cost <= WORLD_VOICES`. Either way M2 must be fixed too, or the
reserve is fiction regardless.

---

### M2 — fourteen catalogue entries charge the voice counter without ever passing the gate, defeating `PRIORITY_RESERVE`.

**Where:** `src/systems/Audio.js` — `playerDead` (:705), `pickup` (:770),
`coin` (:798), `levelUp` (:813), `bossHorn` (:843), `stageSting` (:856),
`uiClick` (:868), `chest` (:885), `purchase` (:905), `shrineWin` (:920),
`shrineFail` (:938), `shrineBlood` (:955), `teleporterStart` (:973),
`deny` (:1003).

Every one of them calls `_noise`/`_tone`, which call `_release` (`Audio.js:341`)
and increment `this.voices`. None of them calls `_take`. So they raise the
counter arbitrarily far above `MAX_VOICES` and every gated sound is refused
until they drain.

**Measured** (`probeC.json:voiceCap.ungated`, live, starting from `voices = 0`):

| call | `voices` after |
|---|---|
| `teleporterStart(pos)` | 11 |
| `levelUp()` | 23 |
| `stageSting()` | 28 |
| `pickup(2)` | 39 |
| `chest(pos)` | 48 |
| `shrineWin(pos)` | **58** |

At `voices = 58`, against `MAX_VOICES = 40`:

```
_take(5)          -> false     (shoot refused)
_take(3, true)    -> false     (playerHurt refused, priority and all)
```

This is not a synthetic edge. A single teleporter activation fires
`teleporterStart` (11 nodes) and `bossHorn` (5) — 16 uncharged nodes on top of a
world budget of 30, leaving 14, which one explosion (9) plus one shot (5)
consume exactly. `goldChanged` → `coin()` is three uncharged nodes throttled at
0.06 s, i.e. up to 50 uncharged nodes per second during a gold cascade.

Round 3's stated mechanism — "World SFX may not take the graph above
`WORLD_VOICES`; `playerHurt`, `heal`, `shieldBreak` and `ability` … may spend the
whole budget. The difference is a standing reservation nothing else can touch" —
is false as written. Fourteen sounds touch it, at the loudest moments in the
game.

**Fix.** Route every catalogue entry through `_take` with its own node count,
priority-flagged where it is player feedback (`playerDead`, `levelUp`, `pickup`,
`deny`) and world-flagged otherwise (`chest`, `purchase`, `shrine*`,
`teleporterStart`, `bossHorn`, `stageSting`, `coin`, `uiClick`). The counts are
`playerDead 3, pickup 11, coin 3, levelUp 12, bossHorn 5, stageSting 5,
uiClick 2, chest 9, purchase 5, shrineWin 10, shrineFail 8, shrineBlood 5,
teleporterStart 11, deny 2` (counted from each body and confirmed against the
measured deltas above). A cheaper structural fix that cannot rot: charge inside
`_release` itself and make `_take` a pure query, so the two can never drift
apart again — which is the same class of bug round 3 fixed for `cost` and left
open for `coverage`.

---

### M3 — `MusicEngine.stop()` and `Audio._musicOff` are still one-way latches. Round 2's MINOR is unfixed and unmentioned.

**Where:** `src/systems/Music.js:790` (`stop()` sets `this.stopped = true`),
`src/systems/Music.js:239-244` (`reset()` clears `_runT`, `_heat`, `_sustain`,
`pressure` — **not** `stopped`), `src/systems/Audio.js:709` (`this._musicOff = true`,
assigned nowhere else in the file).

**Measured** (`probeC.json:latches`, live, one page session):

| step | `stopped` | `stepsEmitted` | `_runT` | `music.gain` | `_musicOff` | `droneGain` |
|---|---|---|---|---|---|---|
| baseline | false | 753 | 84.03 | 0.48000 | false | 0.2762 |
| `stageStart{index:2}` | false | 758 | 84.66 | 0.48000 | false | 0.2405 |
| **`playerDead`** | **true** | 758 | 84.66 | 0.02031 | **true** | 0.1010 |
| `stageStart{index:0}` — a **new run** | **true** | **758** | 0.00 | 0.00013 | true | 0.0563 |
| +3 s | true | **758** | 0.00 | 0.00000 | true | 0.0505 |
| `setMusicVolume(1)` | true | **758** | 0.00 | **0.80000** | true | 0.0501 |

The last row is the shape of the bug: `reset()` demonstrably ran (`_runT` is
0.00), the music bus is wide open at 0.8, and the sequencer has emitted zero
further steps. Total silence with a fully-open bus. `_musicOff` also pins the
ambient drone at 0.05 for the rest of the page session (`Audio.js:1052`).

Confirmed analytically too (`probeA.json:stopLatch`): steps before `stop()` 27,
after `stop()` 27, after `reset()` **27**, `stoppedFlagAfterReset: true`.

**Two paths reach this without a page reload.**

1. **A multiplayer client.** `NetHost.js:57` forwards `playerDead` to every
   client; `NetClient.js:106` re-emits it verbatim on the client's own bus;
   `Audio.js:178` handles it identically. A surviving client loses its
   soundtrack and its ambient bed permanently the moment **a teammate** dies.
   This is precisely the one-way latch round 2 flagged as MINOR. Round 3's
   report does not mention it in its fix list, its clean list, or its untested
   list.
2. **The capture harness**, every run — this is the mechanism behind C2(a).

Single-player restart happens to escape it because `Menus.js:1039` does
`location.reload()`. That is luck, not design: `Music.js:712` explicitly reasons
about "if anything ever revived this instance", and nothing can.

**Fix.** Two lines. `Music.js reset()` must clear `this.stopped = false` and
re-seed `this._musicTime = this.ac.currentTime + 0.15` (otherwise the first
`_schedule` after a revival takes a resync). `Audio.js` must clear
`this._musicOff = false` in the `stageStart` `index === 0` branch alongside
`musicEngine.reset()` and `_itemCounts.clear()`. Separately, `playerDead` on a
non-local player should not reach `Audio.playerDead()` at all — the event needs
to carry the victim, and `Audio.js:178` needs to test it.

---

### M4 — the blight transform plays the reward jingle followed by the rejection buzzer.

**Where:** `src/systems/Audio.js:765` (`if (delta < 0) { this.deny(); return; }`)
against `src/systems/Items.js:337` (`this._set(def.corrupts, 0)`).

`_settleBlight` writes the base stack to zero and then writes the blight card's
new total. `_set` emits `itemPickup` with `delta` for both, so `Audio.itemChanged`
sees a negative delta in the middle of a *pickup* and fires `deny()` — the
"rejected input" sound (`Audio.js:1002`, "short, low, and unmistakably not a
confirm").

**Measured** (`probeC.json:pickupDetail.cases`, live, real item catalogue —
`spasm-gland` corrupting a held `syringe` x3):

| action | cues emitted |
|---|---|
| `give` common `syringe` | `pickup(0)` |
| `give` uncommon `ukulele` | `pickup(1)` |
| `give` legendary `behemoth` | `pickup(2)` |
| `give` boss `titanic-knurl` | `pickup(3)` |
| `give` lunar `shattered-covenant` | `pickup(4)` |
| `take syringe` | `deny()` |
| **`give` blight `spasm-gland` over the held base** | **`pickup(0)`, `deny()`, `pickup(0)`** |

(The third call is swallowed by the 40 ms throttle, so what a player hears is
**reward jingle, then rejection buzzer**, for picking an item up.)

The same shape reaches two more surfaces round 3 did not consider:

- `Interactables.js:1253` — the Marrow Kiln burns an item for gold. It plays
  `shrineBlood` **and** a `deny()`.
- `RealmProps.js:349` — the Hollow Market refinery trades a stack up a tier. It
  plays `shrineWin` **and** a `deny()`.

In all three cases the removal is the *consequence of a successful action*, and
the sound the player gets is the one the game uses for "that did not work".

**Fix.** `deny()` is the wrong cue for an inventory removal in the first place —
it is the UI-rejection sound. Either give removal its own cue, or (cheaper and
correct today) suppress it when a positive delta for another id arrives in the
same tick: buffer `itemChanged` on a microtask and emit one cue for the net
transaction. `Items._set` could also carry a `reason` (`'give' | 'take' |
'corrupt' | 'refine'`) and let `Audio` decide, which removes the guesswork.

---

### M5 — over half of all world SFX are refused under ordinary combat load; the reported refusal rate is not reproducible.

**Where:** `src/systems/Audio.js:58-60`, `:337-339`.

**Measured** (`probeC.json:combat`, 60 s of live stage-1 combat, director
enabled, 17.5 live enemies mean / 23 max, population cap 19, difficulty 1.107 —
i.e. very close to round 3's own scenario of 19.6 mean / cap 18.7 / difficulty
1.13):

| | value |
|---|---|
| `_take` calls | 5368 |
| `_take` **refusals** | **2928 (54.6%)** — **48.8/s** |
| refusals by cost | 9 (explosion): **1768** · 5 (shoot): **1088** · 4: 44 · 7: 25 · 2: 3 |
| peak `audio.voices` | 32 (inside 40) |
| samples with engine stopped / player dead | 0 / 0 |

Round 3 reports 1389 refusals over 150 s — 9.3/s — as the fix's headline. I
measure 48.8/s at comparable enemy density, which is worse than the 32.6/s it
reports for the *before* arm. I do not claim their run is wrong; I claim the
number is not a property of the fix and should not be read as one.

The mechanism is not in dispute: `WORLD_VOICES` is 30, an explosion honestly
costs 9, and a firefight routinely holds more than 21 nodes — so the loudest
event in the game is the first thing deleted. M2 makes it worse by spending part
of that 30 without ever asking.

**Fix.** This is the trade round 3 explicitly measured and accepted, so the
decision needs re-taking with the honest numbers rather than a code change alone.
The cheapest real improvement is to make refusal *graceful* rather than total:
when `_take(9)` fails for an explosion, fall back to a two-node version (the
sub thump and the crack) instead of dropping the entire sound. A firefight where
distant explosions get thinner is a mix; one where they vanish is a bug.

---

## MODERATE

### D1 — the layer balance was solved on RMS alone, so the peaks are 25.7 dB apart and the clap out-peaks the kick.

**Where:** `src/systems/Music.js:79-90`.

**Measured** (`probeB.json:layerIsolated` — each layer rendered in isolation at
I = 1 with the bus disconnected, exactly the method the fix report describes):

| layer | RMS | rel. kick (RMS) | **peak** | **rel. kick (peak)** |
|---|---|---|---|---|
| **clap** | −28.28 | −5.44 | **−0.39** | **+4.00** |
| kick | −22.84 | 0.00 | −4.39 | 0.00 |
| lead | −33.53 | −10.69 | −4.59 | −0.20 |
| hat | −35.13 | −12.29 | −4.70 | −0.31 |
| openhat | −33.26 | −10.42 | −6.88 | −2.49 |
| perc | −39.82 | −16.98 | −7.11 | −2.72 |
| bass | −29.07 | −6.23 | −9.11 | −4.72 |
| sub | −37.14 | −14.30 | −9.99 | −5.60 |
| acid | −34.86 | −12.02 | −10.19 | −5.80 |
| pad | −38.99 | −16.15 | −26.13 | −21.74 |
| **span** | | **16.98 dB** | | **25.74 dB** |

The RMS claim holds (16.98 dB against their 16.0). But RMS across layers with
wildly different note densities is not a balance: `clap` fires twice a bar and
`hat` sixteen times, so equalising their RMS means equalising their *average*
level and leaving the clap 4 dB louder than the kick **per hit**, at −0.39 dBFS
from a single isolated layer. In a four-on-the-floor arrangement the kick is the
peak of the mix, by definition; here it is fourth.

**Fix.** Re-solve `maxGain` against a density-normalised target — peak-per-hit
for the transient layers (`kick`, `clap`, `perc`, `openhat`, `hat`) and RMS for
the sustained ones (`sub`, `pad`, `bass`, `acid`, `lead`). As a first cut,
`clap` needs about −4 dB (3.50 → 2.20) to sit under the kick's transient, which
also recovers 4 dB of bus headroom.

### D2 — `pickup()`'s 40 ms throttle now silences legitimately distinct pickups, and no longer has a duplicate to collapse.

**Where:** `src/systems/Audio.js:780`.

**Measured** (`probeC.json:pickupDetail.cases`, last row): granting two different
common items in the same frame produces `pickup(0), pickup(0)` — and the second
is thrown away by the throttle, because `_throttle` keys on `ac.currentTime`,
which is identical for two synchronous calls.

The duplicate the throttle was added for is gone: the integration pass deleted
the direct `play('pickup')` calls (`Items.js:220` now carries a comment saying
so, and `Items.js:812` routes equipment through `'equipment'`), and `_set` now
carries `delta` and `tier` on the wire (`Items.js:293-295`). The throttle's only
remaining effect is loss — on chest bursts, on the Void field's multi-grants,
and on any drop that hands over two items at once.

The report says as much itself ("the throttle is a stopgap that happens to be
correct only because of call ordering, and it should not be load-bearing"), and
the ordering it depended on has since changed underneath it.

**Fix.** Delete the throttle from `pickup()`. If duplicate suppression is still
wanted, key it on `id` rather than the literal string `'pickup'`.

### D3 — the gate's stated premise is false: the audio system is already live long before the gesture.

**Where:** `tools/capture.mjs:449-452`.

> "WebAudio's autoplay policy means `Audio._ensure()` runs on the first
> pointerdown/keydown/touchstart and not before, so without a gesture no
> statement in `Audio.js` or `Music.js` ever executes under this harness."

**Measured** (`shots-r4/manifest.json:r4.beforeGesture`, full 21-shot run,
*before* the keypress): `ready: true`, `ac.state: "running"`, `stepsEmitted: 305`,
`music.gain: 0.0153`.

`_ensure()` is called from the body of every catalogue entry, and `Audio.init`
subscribes handlers to `stageStart`, `kill`, `damage`, `itemPickup` and
`playerDead` (`Audio.js:147-179`). `04-combat` alone spawns and kills two dozen
monsters. The `AudioContext` is constructed without a gesture (it starts
suspended and resumes on the first `_ensure` retry), the graph is built, and the
sequencer runs. `errorCount: 0` from a pre-round-3 capture *was* partial evidence
about this domain.

This matters beyond pedantry: the report's careful three-run pixel-diff defence
of the gesture's placement is defending a keypress that, on the shipped
configuration, does no work at all (C2a). The placement reasoning itself is
sound — the ~96 000 `Math.random()` draws are real and moving the gesture
earlier would move the shots — but it is now the answer to the wrong question.

**Fix.** Correct the comment, and see C2's fix — the gate should assert on a
delta and on liveness, at which point the gesture is genuinely optional.

### D4 — the compression did not go away, it moved to the SFX bus, and that half was never measured.

**Where:** `src/systems/Audio.js:215-222`.

**Measured** (`probeC.json:combat.sfxReduction`, live, 113 samples across the same
60 s fight as the master figure):

| | master limiter | **sfx limiter** |
|---|---|---|
| worst reduction | −0.524 dB | **−8.86 dB** |
| mean reduction | −0.015 dB | **−2.816 dB** |

The master claim is confirmed and the split is a real improvement — the
soundtrack is no longer being pulled down by explosions. But round 3's
conclusion, "The limiter took 3.7 dB of a 7.7 dB dynamic range on average and up
to 12.2 dB at its worst. It now takes essentially nothing", is stated about the
mix and is true only of the master. The SFX bus is under 2.8 dB of continuous
gain reduction with 8.9 dB peaks, and that number appears nowhere in the report
even though `sfxLimiter` is one of the two nodes the fix added.

**Fix.** No code change is necessarily required — this may be the intended
behaviour. It needs to be *measured and stated*, and `-7 dB / 14:1` chosen
against that measurement rather than against an unstated one.

---

## MINOR

- **N1.** `MusicEngine.stepsEmitted` (`Music.js:164`) is a monotonic lifetime
  counter with no reset. Any consumer that reads it as "the engine is running"
  is wrong by construction; it can only be read as a delta. It is currently
  read as a level by `capture.mjs:492`.
- **N2.** `Audio._itemCounts` (`Audio.js:122`, `:760-763`) is now vestigial —
  `Items._set` always supplies `delta`, so the `?? (total - prev)` branch is
  dead. It is still maintained, and still only cleared on `stageStart{index:0}`,
  which is a stale-state trap for whoever touches this next.
- **N3.** The boss floor (0.80), the teleporter-charging floor (0.84) and a
  genuinely full arena (0.90) collapse into 0.044 of separation in `I` once
  `arc >= 0.5` (`Music.js:325-332`). The floors are correctly named against
  `Director.boss`, `Progression.state` and `Director.populationCap` — I verified
  all three — but they stop being distinguishable well before the point where
  C1 flattens everything.
- **N4.** `Audio._ensure()` (`Audio.js:187`) calls `ac.resume()` unconditionally
  whenever the context is suspended. Harmless on a live `AudioContext`; it
  throws `InvalidStateError` against an `OfflineAudioContext`, which is what any
  offline verification rig will use. Guarding it (`if (this.ac.resume && this.ac.state === 'suspended')`
  → check for `startRendering`) would make this system testable offline without
  a harness working around it. My probe B swallowed 18 of these.

---

# 4. Checked and clean

Each of these is something round 3's changes could plausibly have broken, and
each is measured here independently rather than inherited.

- **Acid filter timeline (`Music.js:646-648`).** `probeA2.json`: over 380
  scheduled events on the one shared `acidFilter.frequency`, **0 out-of-order
  writes**, **0 ramps crossing the next note**, longest flat hold **27.9 ms**
  (against a 105.6 ms step), and only two distinct ramp lengths — 77.75 ms
  (normal note) and 95.07 ms (slide). Still clean under a rising BPM
  (`rising_bpm`: 370 events, 0 crossings at 139 bpm mid-ramp). The clamp works
  and the report's rejection of `cancelScheduledValues` is sound reasoning about
  a lookahead scheduler.
- **No clicks at layer boundaries.** `probeB.json:ramp` — a full 90 s 0 → 1
  ramp with **45 layer commits**; of the 200 largest sample-to-sample slews in
  the render, **0** fall within 5 ms of a commit. The half-bar ramps and the
  `L.cur`/`L.target` bookkeeping hold.
- **No DC offset, no clipping.** Whole-render mean −0.0014 to −0.0018 (≈ −55 dB)
  across every mix; **0 clipped samples** in any of the twelve renders. The
  worst 20 ms windowed mean (−0.124) is the 27.5 Hz sub triangle being less than
  one cycle long in the window, not an offset.
- **No aliasing.** Every music source is a band-limited WebAudio oscillator or a
  noise buffer read at rate 1.0 (`Music.js:760-780` sets no `playbackRate`), so
  the acid sweep and the riser cannot alias.
- **Resync.** `probeA.json:resync` — **0 bar-counter rewinds** in every
  configuration: three 0.6 s stalls (6 bars, 3 resyncs), no stall (6 bars), and a
  30 s backgrounded tab (`_bar` 1 → 16, `_step` 19 → 260, monotone). The phase
  is preserved and the 8-bar `BAR_ROOTS` cycle survives. Live: 32 bars and 512
  steps over 60 s at ~130 bpm, 0 resyncs.
- **Hat quantisation.** `probeA.json:hatQuantise` — 15 of 15 bars clean under
  ±0.02 intensity dither across the 0.55 threshold. The hysteresis latch works.
- **Opening ceiling.** `probeA.json:ceiling_run` — `_runT` **0.00 s** after 45 s
  on a paused title screen; `I = 0.170` six seconds into the run, which is
  `0.10 + 6/60·0.70` exactly.
- **`stageStart` with `index > 0`.** `probeC.json:latches` — `_runT` carried
  84.03 → 84.66 s across `stageStart{index:2}`. Does not reset. Correct.
- **Pickup tier ladder.** All six tiers resolve to distinct rungs live
  (common 0, uncommon 1, legendary 2, boss 3, lunar 4), and equipment routes
  through the same map via the string form (`Items.js:812`,
  `Audio.js:1078-1079`).
- **Master limiter.** −0.524 dB worst, −0.015 dB mean over 113 live samples.
- **`MUSIC_BUS`.** Music bus reads 0.48 at the shipped `musicVolume 0.6`
  (= 0.6 × 0.80), and the `playerHurt` duck restores to exactly that value.
- **Music-vs-SFX staging.** `probeB2.json` — music-to-explosion RMS deficit
  6.42 dB (report: 7.60), engine dynamic range opening → full 7.46 dB (report:
  7.71).
- **The bed is continuous.** Minimum 50 ms window peak at I = 0 is −72.9 dB, not
  digital silence. The `hold` parameter on `_osc` does what it claims.
- **Errors.** 0 console errors and 0 page errors attributable to audio across
  three full 21-shot captures, one software capture and a 60 s live combat probe.
  The single `errorCount: 1` in each capture is the pre-existing
  `06-loaded-hud` subject check, unchanged from round 3's control runs.
- **`--software` capture path.** `--software --only 01-title` boots in 28 s,
  builds the graph on the gesture (`ready: false` → `true`), emits 14 steps in
  the 90-frame window and reports `audioOk: true`. The renderer-agnostic claim
  holds for a partial run.

---

# 5. Verdict

**FAIL.**

Round 3 did real work. The acid envelope is genuinely repaired, the layer
balance is genuinely 17 dB tighter, the resync genuinely preserves the bar
counter, the opening ceiling is exact, the hat switch is quantised, the tier
ladder reaches the sound, and the master limiter no longer eats the soundtrack.
Nine of the twenty-seven claims in the table above I confirmed against my own
instruments, several with better numbers than the report claimed.

It fails on two things.

The first is that the round's centrepiece — an intensity model that "reacts to
what the player does" — stops working entirely from difficulty 3.2, and round 3
is what moved that boundary from a late-run curiosity into ordinary play. A run
that reaches stage 6 in five minutes spends the rest of its length listening to
a static maximum-intensity wall, and `cool()`, `bump()` and `pressure` are dead
code from that point on. The report names this as untested arm #2 and describes
the number as "a calculation, not a measurement". The calculation was wrong.

The second is that the round's only new automated gate does not work. It emits
zero sequencer steps inside its own measurement window on every full capture,
because the scenario immediately before it kills the player and latches the
engine off; it asserts on a cumulative counter that was already non-zero; and it
returns `audioOk: true` for a build in which no oscillator ever starts. A gate
that reports green on total silence is worse than no gate, because it is now
cited as evidence.

Underneath both sits the same unfixed latch round 2 flagged and round 3 did not
mention: `stop()` is one-way, `reset()` does not clear it, and `_musicOff` never
clears at all. It is what kills the gate, and on a multiplayer client it is what
permanently silences a living player's soundtrack when a teammate dies.

Not shippable at AAA quality. C1, C2 and M3 must land before this domain is
looked at again; M1, M2 and M4 are audible defects a player will hit in a normal
run.
