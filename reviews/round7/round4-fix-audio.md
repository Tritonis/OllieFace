# Round 7 — round-4 audio fix (`Music.js`, `Audio.js`, `tools/capture.mjs`)

Against `reviews/round7/round3-critique-audio.md`, branch `round7/content-and-polish`,
base `b18a2b4`. Files changed: `src/systems/Music.js`, `src/systems/Audio.js`,
`tools/capture.mjs`. Nothing else touched.

Every number below names the file on disk it came from. My artefacts are in
`reviews/round7/r4fix-audio/`:

| artefact | what it is |
|---|---|
| `probeI.mjs` → `probeI.json` | Node, no browser. Drives the **round-3 and round-4 `MusicEngine` side by side in one process** on the critic's stub `AudioContext`. `Music.round3.js` is `git show b18a2b4:src/systems/Music.js` with only its import path rewritten. Intensity at both ends, floors, `stop()`/`reset()`, resync/silent guards, the clap table. |
| `probeL.mjs` → `probeL.json`, `probeL.log` | The live game, real Chromium on the GPU path with `tools/capture.mjs`'s launch flags, a real mouse gesture, a real `AudioContext`. Voice budget, `playerHurt` under saturation, graceful refusal, item cues, 60 s of instrumented combat, both-ends intensity live, the latches, volume/mute/suspend, a non-finite `AudioParam` detector installed before any product code runs. |
| `gate-sabotage.mjs` | A copy of the **fixed** `tools/capture.mjs` with `--sabotage=<arm>` added and nothing else changed. Six arms. |
| `gate-unwired/ silence/ latch/ parked/ mute/ disconnect/`, `gate-*.log` | The six sabotage captures. |
| `gate-control/`, `gate-control.log` | The same shot, unsabotaged, through the shipped `tools/capture.mjs`. |
| `shots-full/`, `capture-full.log` | Full 21-shot capture, GPU path, shipped file. |
| `Music.round3.js` | The round-3 engine, kept so `probeI` stays runnable. |

Commands actually run:

```
node reviews/round7/r4fix-audio/probeI.mjs > reviews/round7/r4fix-audio/probeI.json
node reviews/round7/r4fix-audio/probeL.mjs --port 5423
node reviews/round7/r4fix-audio/gate-sabotage.mjs --sabotage unwired    --only 01-title --out reviews/round7/r4fix-audio/gate-unwired    --port 5455
node reviews/round7/r4fix-audio/gate-sabotage.mjs --sabotage silence    --only 01-title --out reviews/round7/r4fix-audio/gate-silence    --port 5441
node reviews/round7/r4fix-audio/gate-sabotage.mjs --sabotage latch      --only 01-title --out reviews/round7/r4fix-audio/gate-latch      --port 5452
node reviews/round7/r4fix-audio/gate-sabotage.mjs --sabotage parked     --only 01-title --out reviews/round7/r4fix-audio/gate-parked     --port 5443
node reviews/round7/r4fix-audio/gate-sabotage.mjs --sabotage mute       --only 01-title --out reviews/round7/r4fix-audio/gate-mute       --port 5444
node reviews/round7/r4fix-audio/gate-sabotage.mjs --sabotage disconnect --only 01-title --out reviews/round7/r4fix-audio/gate-disconnect --port 5445
node tools/capture.mjs --only 01-title --out reviews/round7/r4fix-audio/gate-control --port 5449
node tools/capture.mjs --out reviews/round7/r4fix-audio/shots-full --port 5460
```

## On the concurrent-engine bug

`Engine.start` re-arming before `_frame` was being fixed in parallel and is
**not** fixed in the tree I measured — `git diff` shows `src/core/Engine.js`
modified by another agent mid-session, and I did not take a dependency on it.
What that means for these numbers:

- Everything in `probeI.json` is **immune**: it is Node, there is no `Engine`,
  and `update()` is called exactly once per simulated frame by the probe itself.
  The intensity, floor, latch and clap results are unaffected by it.
- `probeL.json` drives the real engine, so its combat measurements may have run
  at 2× the intended rate, exactly as round 3's did. That matters for *rates*
  (`refusalRate_per_s`) and not for the *ratios* and *ceilings* the findings turn
  on: `refusalPct`, `worldPeak`, `voicesSpentByHurt`, the limiter reductions.
  Where a rate is quoted below it is quoted beside its percentage, and the
  percentage is the load-bearing half.
- The capture gate takes a delta over its own window, so a doubled engine can
  only make `stepsDelta` larger. It cannot turn a failing gate green.

---

# 1. What changed

## `src/systems/Music.js`

1. **`ARC_AUTHORITY = 0.65`** (new constant, applied at `update()`'s `this.arc`
   assignment). `arc` can no longer reach 1, so the `(1 - arc)` factor can never
   annihilate the pressure term.
2. **`reset()` clears `stopped`**, clears `_pending`, and re-seeds `_musicTime`.
   `stop()` is now undone by exactly one thing — a run starting.
3. **`clap` `maxGain` 3.50 → 2.20** (−4.03 dB).
4. Comment on `stepsEmitted` stating it is a lifetime counter readable only as a
   delta, and a comment on `stop()` naming its single inverse.

## `src/systems/Audio.js`

5. **Two voice counters, two gates.** `worldVoices` gated on `WORLD_VOICES = 44`,
   `priorityVoices` gated on `PRIORITY_RESERVE = 28`. Neither class can refuse
   the other at any load. `_take` chooses the bucket, `_release` spends it.
6. **All 26 emitting catalogue entries now pass `_take`** (verified by parse, see
   §3-M2), the fourteen that never did included. `playerDead` uses a new
   `_always()` — charged, never refused, and explicit at the call site.
7. **Graceful refusal** for the two largest refusal classes: `explosion` falls
   back from 9 nodes to 3 (crack, body, sub), `shoot` from 5 to 2 (transient,
   body).
8. **`beginRun()`** — new public method, called by `stageStart{index:0}`. Clears
   `_musicOff`, clears `_itemCounts`, calls `musicEngine.reset()`, and reopens
   the music bus that `playerDead` ran to zero.
9. **`playerDead` is local-only**: the handler returns unless the local survivor
   is verifiably dead.
10. **One cue per inventory transaction** — `itemChanged` buffers on a microtask
    and `_flushItemCue` emits `pickup` at the best tier gained, or `deny` only if
    the whole transaction was a loss. The 40 ms `pickup` throttle is deleted.
11. **`sfxLimiter` −7 dB/14:1 → −5 dB/10:1**, chosen against a measurement (§3-D4).
12. **`_ensure()`'s `resume()` is guarded** against an `OfflineAudioContext`.

## `tools/capture.mjs`

13. **The gate is rebuilt** (§2), and the false premise at `capture.mjs:449` is
    replaced with the measurement that refutes it.

---

# 2. The gate — and the five ways I made it fail

The old gate asserted `musicEngine.stepsEmitted > 0` — a lifetime counter — and
so asserted only "the sequencer ran at some point since page load". The new one
asserts three independent things:

1. **A delta**: `stepsEmitted` sampled either side of the window, `>= 8`.
2. **Liveness**, read off the product's own state: `stopped === false`,
   `silent === false`, `muted === false`, `_musicOff === false`,
   `ac.state === 'running'`, `music.gain > 0`, `master.gain > 0`.
3. **Audibility**: two `AnalyserNode`s — one on the music bus, one on the master
   limiter, i.e. the last node before the device — peak-sampled every 16 ms
   across the window, each `>= 1e-3` (−60 dBFS), with `samples >= 20` so the two
   peak checks cannot pass vacuously.

The window is opened by `ctx.audio.beginRun()`, the product's own new-run path.
Without it the gate measures a corpse: the last scenario kills the player, and a
dead player's soundtrack is *supposed* to be silent. Reviving through the real
API means the gate now also covers the revival, which is where M3's latch lived.

**Honest limit:** a tap reads the node it is attached to, so the one edge this
cannot observe is `limiter → ac.destination`. Nothing reachable from JavaScript
can observe the device. Everything upstream of that edge is covered.

## The proofs

Each arm is a real failure class, applied to the shipped gate through
`gate-sabotage.mjs`, `--only 01-title`. Source: `reviews/round7/r4fix-audio/gate-*/manifest.json`.

All six rows below are against the **final** code, from
`reviews/round7/r4fix-audio/gate-<arm>/manifest.json`.

| arm | what it breaks | `stepsDelta` | `musicPeak` | `outputPeak` | checks failed | exit |
|---|---|---|---|---|---|---|
| *(control, shipped `capture.mjs`)* | nothing | 15 | 0.0524 | 0.0515 | **none — passes** | 0 |
| `unwired` | music engine's layers + duck disconnected from the bus | **14** | **0** | 0.0147 | **`musicAudible` — and nothing else** | 1 |
| `silence` | `Oscillator.start` / `BufferSource.start` no-op'd | 3 | **0** | **0** | `stepsAdvanced`, `musicAudible`, `outputAudible` | 1 |
| `latch` | engine stopped, `reset()` neutered — round 3's one-way stop | **0** | **0** | 0.0150 | `sequencerRunning`, `stepsAdvanced`, `musicAudible` | 1 |
| `parked` | music bus parked at 0 after `beginRun` | 24 | **0** | 0.0182 | `musicBusOpen`, `musicAudible` | 1 |
| `mute` | `setMuted(true)` | 0 | **0** | 0.0013 | `notSilenced`, `masterOpen`, `stepsAdvanced`, `musicAudible` | 1 |
| `disconnect` | `master.disconnect(limiter)` | 2 | **0** | **0** | `stepsAdvanced`, `musicAudible`, `outputAudible` | 1 |

The rows that carry the argument:

- **`unwired` is the proof that the analyser is load-bearing.** The sequencer
  runs (14 steps in the window), `stopped` is false, `silent` is false, the
  context is running, the music bus reads 0.48, the master reads 0.8, the ambient
  bed is still audible at the limiter — and the music engine's output is
  connected to nothing. Every check the old gate could have made passes. The
  single failing check is the music-bus analyser. No step counter and no state
  flag can make that call.
- **`latch` is round 3's actual shipped state** at the moment its gate ran, and
  it fails three checks at once. Note `outputPeak` is 0.0150 there — the ambient
  bed is audible with the sequencer dead — which is exactly why the music-bus tap
  exists separately from the output tap. Either alone would have passed something
  it should not.
- **`silence` is the build that returned `audioOk: true` in round 3.** On the
  final code it also drops `stepsDelta` to 3, because Chromium stops advancing a
  graph that reaches the device with nothing; on an earlier build of this fix the
  same arm emitted 16 steps and failed **only** on the two audibility checks.
  That earlier directory was overwritten by this re-run, which is why `unwired`
  is the arm cited for the load-bearing claim — it reproduces on disk.

## On the real 21-shot run

`reviews/round7/r4fix-audio/shots-full/manifest.json`:

```
audio.beforeGate: { stopped: true, musicOff: true, musicGain: 0.00191, stepsEmitted: 473 }
audio:            { stepsDelta: 28, musicPeak: 0.04957, outputPeak: 0.07313, samples: 85,
                    stopped: false, musicOff: false, musicGain: 0.48, masterGain: 0.80 }
audio.checks:     all 12 true          audioOk: true
```

`beforeGate` is recorded as telemetry rather than as an assertion, and it is the
whole story in one line: on arrival at the gate the engine **is** the corpse the
critique described — stopped, ambient latched off, music bus at −54 dBFS. Round
3's gate read `stepsEmitted: 473 > 0` there and reported green. This one revives
through the product's own new-run path and then measures 28 sequencer steps and
real signal on two taps. Round 3's number in the same place was
`stepsEmittedDuringGateWindow: 0`.

---

# 3. Findings, before and after

## C1 — intensity pinned at maximum (`Music.js`)

Fix: `arc` is scaled by `ARC_AUTHORITY = 0.65`, so `(1 - arc) >= 0.35` always and
`pressure` always owns a share of the range.

**Both ends, analytic, round-3 and round-4 engines in one process**
(`probeI.json:bothEnds` — empty arena vs full arena, 240 s settle, same seed of
conditions for both builds):

| difficulty | r3 `I` empty | r3 `I` full | **r3 span** | r4 `I` empty | r4 `I` full | **r4 span** | r4 `cool()` moves |
|---|---|---|---|---|---|---|---|
| 1.0 | 0.000 | 0.792 | 0.792 | 0.000 | 0.792 | 0.792 | 0.788 |
| 1.5 | 0.200 | 0.834 | 0.634 | 0.130 | 0.819 | 0.689 | 0.685 |
| 2.0 | 0.400 | 0.875 | 0.475 | 0.260 | 0.846 | 0.586 | 0.583 |
| 2.875 | 0.750 | 0.948 | 0.198 | 0.488 | 0.893 | 0.406 | 0.404 |
| 3.2 | 0.880 | 0.975 | 0.095 | 0.572 | 0.911 | 0.339 | 0.337 |
| **3.5** | **1.000** | **1.000** | **0.000** | 0.650 | 0.927 | **0.277** | 0.276 |
| **4.5** | **1.000** | **1.000** | **0.000** | 0.650 | 0.927 | **0.277** | 0.276 |
| **6.0** | **1.000** | **1.000** | **0.000** | 0.650 | 0.927 | **0.277** | 0.276 |
| **12.0** | **1.000** | **1.000** | **0.000** | 0.650 | 0.927 | **0.277** | 0.276 |

`probeI.json:bothEndsVerdict` — `round3_deadRows: [3.5, 4.5, 6, 12]`,
`round4_deadRows: []`. The invariant the critique asked for
(`max(I) - min(I) > 0` for every reachable arc) now holds by construction.

**And live** (`probeL.json:lateArc`, real game, difficulty pinned, arena emptied
and filled, 3 s settle each):

| difficulty | `I` empty | `I` full | span | bpm empty → full |
|---|---|---|---|---|
| 1.0 | 0.0138 | 0.7903 | 0.777 | 118.3 → 137.0 |
| 2.0 | 0.3553 | 0.8433 | 0.488 | 126.5 → 138.2 |
| 3.2 | 0.6309 | 0.9083 | 0.277 | 133.1 → 139.8 |
| 3.5 | 0.6960 | 0.9266 | 0.231 | 134.7 → 140.2 |
| 4.5 | 0.6962 | 0.9266 | 0.230 | 134.7 → 140.2 |
| 6.0 | 0.6954 | 0.9268 | 0.231 | 134.7 → 140.2 |

`probeL.json:lateArc.coolAtDiff4p5` — **0.9272 → 0.6918**. The critic's same row
read 1.0000 → 1.0000.

**The other end is unmoved.** `probeI.json:openingCeiling`: 45 s on a paused
survivor-select screen leaves `_runT` at 0.00 and `I` at 0.000; six seconds into
the run `I = 0.170`, which is `0.10 + 6/60 · 0.70` exactly, identical for both
builds. `I` at 60 s: r3 0.7962, r4 0.7947.

**Cost, stated.** The swing a fight buys shrinks from 0.79 of range at difficulty
1 to 0.28 at the cap — intended (a fight late in a run is a smaller change
because the track is already loud), but it is a real reduction and it is the
reason N3 below is improved rather than solved.

## C2 — the gate

See §2. Fixed and proved failing five ways.

## M1 — `playerHurt`'s sound refused by the voice cap

**Before** (`r4-audio/probeC.json:voiceCap.hurtAtVoices40`): duck fired,
`voicesSpentByHurt: 0`.

**After** (`probeL.json:hurtAtSaturation`), with the world budget saturated at 44
and the graph at 58 live nodes — the exact number that used to refuse it:

| | value |
|---|---|
| `worldTakeRefused` (a shot, cost 5) | **true** — the world budget is genuinely full |
| `priorityTakeAllowed` (cost 3, priority) | **true** |
| **`voicesSpentByHurt`** | **3** (was 0) |
| music duck | 0.48000 → 0.17878 → 0.48000 |

The duck reading is from the run at `--port 5421`; the final run's 80 ms sample
landed after the 0.7 s restore had completed and read 0.48000. All three runs
report `voicesSpentByHurt: 3`, which is the claim.

## M2 — fourteen entries charging without a gate

**Before** (`r4-audio/probeC.json:voiceCap.ungated`): six calls → 58 voices;
`_take(5)` false, `_take(3, true)` false.

**After** (`probeL.json:voiceCap`), same six calls, same order:

| call | `voices` | `worldVoices` | `priorityVoices` |
|---|---|---|---|
| `teleporterStart` | 11 | 11 | 0 |
| `levelUp` | 23 | 11 | 12 |
| `stageSting` | 28 | 16 | 12 |
| `pickup(2)` | 39 | 16 | 23 |
| `chest` | 48 | 25 | 23 |
| `shrineWin` | 58 | 35 | 23 |
| **at end** | 58 | 35 | 23 | 

`shootAllowed: true`, `hurtAllowed: true`. Both were `false` before.

**A shared total does not give this property, and I measured that too.** My first
attempt gated world on `worldVoices` but priority on the *sum* against a
MAX_VOICES of 56. Over 60 s of combat that refused **158 three-node
player-feedback sounds** (`probeL.log` run at `--port 5420`,
`refusalsByCost["3"]: 158`), because the graph legitimately reached 58 live
nodes and the priority gate could see all of them. A reserve a full graph can
consume is not a reserve. The shipped design gates each class only on its own
counter. On the shipped configuration the same 60 s of combat refuses **no
priority sound at all**: `priorityPeak` is 21 against a reserve of 28, so no
3-node cue could have been refused at any instant, and `refusalsByCost` contains
no entry at 11 or 12, so neither `pickup` nor `levelUp` was refused either
(`probeL.json:combat`).

Coverage is verified by parsing the file rather than by eye: all **26** methods
that call `_tone`/`_noise` reach a `_take` or an `_always` first.

## M3 — `stop()` / `_musicOff` one-way

**Analytic** (`probeI.json:stopLatch`):

| | round 3 | round 4 |
|---|---|---|
| steps before `stop()` | 51 | 51 |
| steps after `stop()` | 51 | 51 |
| steps after `reset()` + 5 s | **51** | **94** |
| `stopped` after `reset()` | **true** | **false** |
| verdict | *reset() does NOT revive a stopped engine* | *revived* |

**Live** (`probeL.json:latches`, one page session):

| step | `stopped` | `steps` | `_runT` | `music.gain` | `_musicOff` | `droneGain` |
|---|---|---|---|---|---|---|
| baseline | false | 851 | 90.71 | 0.48000 | false | 0.2395 |
| `stageStart{index:2}` | false | 858 | 91.60 | 0.48000 | false | 0.2059 |
| **`playerDead` with the local survivor ALIVE** (a teammate's, off the wire) | **false** | **871** | 91.60 | **0.48000** | **false** | 0.1771 |
| `playerDead` with the local survivor dead | true | 871 | 91.60 | 0.02333 | true | 0.0861 |
| `stageStart{index:0}` — a new run | **false** | **894** | 0.00 | **0.48000** | **false** | 0.1419 |
| +3 s | false | **918** | 0.00 | 0.48000 | false | 0.1524 |

Both halves of the critic's fix land: the client no longer loses its soundtrack
when a teammate dies, and a second run in the same page session has music.

The teammate guard is `this.ctx.player.alive !== false → ignore`. `alive` is set
to false *before* the emit on every path that raises `playerDead`
(`Combat.js:506` then `:516`, `Player.js:1197-1199`, `Harness.js:5081-5084`), so
the local player being alive is positive evidence the death was somebody else's.
The event carries `{}` on every path, so there is nothing better to test until
someone puts the victim on the wire — filed below.

## M4 — blight pickup emitting `pickup, deny, pickup`

Fix: one cue per transaction, buffered on a microtask.

**After** (`probeL.json:pickupCues.cases`, live, real item catalogue,
`spasm-gland` corrupting a held `syringe` ×3):

| action | cues emitted |
|---|---|
| `give` common `syringe` | `pickup(0)` |
| `give` uncommon `ukulele` | `pickup(1)` |
| `give` legendary `behemoth` | `pickup(2)` |
| `give` boss `titanic-knurl` | `pickup(3)` |
| `give` lunar `shattered-covenant` | `pickup(4)` |
| `take syringe` | `deny()` |
| **`give` blight `spasm-gland` over the held base** | **`pickup(0)`** — was `pickup(0), deny(), pickup(0)` |
| **two different commons in one frame** | **`pickup(0)`** — was `pickup(0), pickup(0)` with the second thrown away |

The six-tier ladder is unchanged, which was the thing this could most easily
have broken.

## M5 — over half of all world SFX refused

This is improved and **not closed**, and the honest version is worth stating
plainly.

**Refusal rate**, 60 s of live combat, director enabled. Only the last row
measures the code that ships; the middle rows are the intermediate
configurations I went through, listed because they are what the decisions were
taken against and because presenting the best of them as "the fix" would be
exactly round 3's error with its 9.3/s.

| run | config | enemies mean | `_take` calls | refusals | **% refused** | rate |
|---|---|---|---|---|---|---|
| critic (`r4-audio/probeC.json:combat`) | round-3 code | 17.5 | 5368 | 2928 | **54.6%** | 48.8/s |
| port 5420 † | world 44, priority gated on the *sum* | 17.3 | 2864 | 846 | 29.5% | 14.0/s |
| port 5421 † | world 44 / reserve 28, sfx limiter −7/14 | 14.8 | 3696 | 1501 | 40.6% | 24.9/s |
| port 5422 † | + sfx limiter −5/10, no `shoot` fallback | 18.0 | 4270 | 1912 | 44.8% | 31.7/s |
| **port 5423 (`probeL.json:combat`)** | **shipped** | 14.3 | 3959 | 1796 | **45.4%** | 29.3/s |

† `probeL.mjs` writes one `probeL.json` and one `probeL.log`, so each run
overwrote the last. **Only the final row is reproducible from disk.** The dagger
rows are recorded from the run output at the time and are reported as the
rationale the decisions were taken against, not as evidence a reader can
re-derive. If they matter to a critic, `probeL.mjs` plus the constants named in
the config column reproduce them.

Read that honestly: on the shipped configuration the refusal percentage is
**45.4% against the critic's 54.6%**, at 26% fewer requests. That is an
improvement and it is not a large one, and two things confound it in opposite
directions — the load differs run to run (the percentage tracks `_take` call
volume against a fixed budget), and the graceful fallbacks *add* a second
`_take` per refused sound, so every downgraded sound now counts as two calls and
at least one refusal. `worldPeak` pins at exactly **44 in every run**: the world
budget saturates in a heavy fight, and that is the real ceiling.

**What did change decisively is what a refusal does.** Of 649 refused shots in
the shipped run, 429 also failed the 2-node fallback and 220 — **34%** — still
made a sound. The equivalent split for explosions is not resolvable from this
instrument: cost-3 refusals (249) pool the explosion fallback with `footstep`
and `coin`, and I did not add a per-sound "fully dropped" counter to separate
them. That is a gap in my instrument, not a result.

What is qualitatively different is what a refusal now *does*
(`probeL.json:explosionFallback`, deterministic):

| condition | explosion nodes | shot nodes |
|---|---|---|
| world budget empty | 7 (of a 9 worst case; debris count is randomised) | 4 (of 5; the mechanical tail is on 1 variant in 3) |
| world at 38 / 41 | **3** — crack, body, sub | **2** — transient, body |
| world at 43 | 0 | 0 |

A firefight where distant explosions and shots get thinner is a mix. One where
they vanish was the bug. Going further — widening `WORLD_VOICES` past 44 — trades
directly against limiter pumping (D4 below) and is a decision that needs ears I
do not have.

## D1 — clap out-peaking the kick

`clap.maxGain` 3.50 → 2.20, **−4.03 dB** (`probeI.json:clap`). Against the
critic's isolated-layer measurement (clap peak −0.39 dBFS, +4.00 dB over the
kick) this puts the clap's transient ~0.03 dB under the kick's and hands ~4 dB of
headroom back to the bus. **Not re-rendered**: I did not rebuild the critic's
offline per-layer render, so the post-change peak table is arithmetic on their
measurement, not a new measurement. Named as an untested arm below.

## D2 — the 40 ms pickup throttle

Deleted. The duplicate it existed for is now collapsed at its source (M4), and
its only remaining effect was loss. Proved by the last row of the M4 table.

## D3 — the gate's false premise

The comment claiming no line of `Audio.js` executes without a gesture is gone,
replaced by the measurement that refutes it (`ready: true`, `ac.state: running`,
305 steps before the keypress) and by an explanation of what the keypress is
still for: an `--only` run whose scenarios happen to make no sound.

## D4 — the SFX limiter

Measured, and then chosen against the measurement.

| | master limiter | **sfx limiter** |
|---|---|---|
| round 3, critic's measurement (`r4-audio/probeC.json:combat`) | −0.524 worst / −0.015 mean | **−8.86 worst / −2.82 mean** |
| round 4, budgets widened, still −7 dB/14:1 (port 5421, † overwritten) | −0.474 / −0.042 | **−11.96 / −5.21** |
| **round 4 shipped, −5 dB/10:1** (`probeL.json:combat`) | −0.679 / −0.113 | **−7.29 worst / −2.86 mean** |

Widening the voice budget pushed the SFX limiter to 5.2 dB of continuous gain
reduction, which is not a limiter, it is the thing shaping the mix — the exact
criticism that moved compression off the master in round 3. −5 dB/10:1 puts it
back to round 3's duty (−2.86 vs −2.82 mean, and 1.6 dB *better* at its worst)
while roughly twice as many sounds reach it. The master limiter absorbs the
difference at −0.11 dB mean.

## N1 / N2 / N3 / N4

- **N1** — `stepsEmitted` is documented as delta-only at its declaration, and its
  one consumer now takes a delta.
- **N2** — `_itemCounts` is **kept**, deliberately. It is the fallback for a
  payload with no `delta`, which is the shape a replicated event from an older
  host has, and `Audio` cannot verify that no such host exists. It is now cleared
  by `beginRun()` alongside everything else a new run resets, which removes the
  stale-state trap.
- **N3** — improved, not solved. Boss / teleporter / full-arena separation in `I`
  (`probeI.json:floors`): at difficulty 3.5 round 3 gives 0.000 (all three at
  1.0); round 4 gives boss 0.896, charging 0.909, full 0.927 — **0.031** of
  separation, against 0.088 at difficulty 1. The floors are distinguishable
  everywhere now, but late in a run they are close, and that is inherent to a
  multiplicative blend: the range available to `pressure` is `(1 - arc)`. Making
  them properly separate late would mean scaling the floors by the same factor,
  which is a design change I did not make unasked.
- **N4** — `_ensure()`'s `resume()` is guarded with `!this.ac.startRendering`, so
  an `OfflineAudioContext` no longer throws `InvalidStateError`. Verified both
  ways: a live `AudioContext` in Chromium reports `startRendering` absent, so the
  guard does not block the real path (`probeL.json:controls.afterEnsure:
  "running"` after a real `suspend()`).
- **The absorbed-hit cue** is not fixable from `Audio.js`: `Combat.js:481` emits
  `playerHurt` only when health was lost, and the payload already carries
  `absorbed`. Filed below.

---

# 4. Re-verified clean (things this change could have broken)

All from `probeL.json` / `probeI.json` unless noted.

- **No non-finite `AudioParam` writes.** A detector wrapping
  `setValueAtTime`/`linearRamp`/`exponentialRamp`/`setTargetAtTime` is installed
  before any product code runs: `nonFinite: []` across the whole session
  including 60 s of combat, the item cues, the latch sequence and the volume
  sweeps.
- **No voice leak.** `probeL.json:drain` is a 12 s time series after the director
  is disabled: `voices` 29 → 33 → 54 → **14** → 28 → 44, `worldVoices` never
  reaches 44, and **480 new `_take` calls arrive during the window** — the game is
  still making noise, and the counters rise and fall rather than pinning. A
  monotonic climb would have been the leak signature; this is not one.
- **Duck automation does not overlap.** `playerHurt`'s ramp still cancels, pins
  the current value and ramps in two segments; measured restore is exactly
  `musicVolume × MUSIC_BUS = 0.48000` on every run.
- **Volume, mute, suspend/resume** (`probeL.json:controls`): music 0.6 → bus
  0.48000; music 0 → bus 0.00007 and `silent: true`; back to 0.6 → 0.47994 and
  `silent: false`; muted → master 0 and `silent: true`; unmuted → master 0.8;
  sfx 0.5 → 0.45087, sfx 1 → 0.89992; `suspend()` → `"suspended"`, `_ensure()` →
  `"running"`.
- **Resync and the bar counter** (`probeI.json:guards`): three 0.6 s stalls, 6
  bars, 3 resyncs, **0 rewinds**, identical for both builds. `silent` still emits
  0 steps while the model keeps integrating.
- **The opening ceiling** is bit-identical between builds at 6 s (0.170).
- **The six-tier pickup ladder** resolves 0/1/2/3/4 live, and equipment still
  routes through the string form.
- **`stageStart{index > 0}` does not reset the run clock**: 90.71 → 91.60 s.
- **Click-free `stop()`**: unchanged code path (`cancelScheduledValues` +
  `setTargetAtTime(0, t, 0.5)`); the only change is that `reset()` can now undo
  the flag.
- **No state survives a reload**: everything added lives on the `Audio` instance
  or the `MusicEngine`, both constructed per page.
- **Build**: `npm run build` exit 0.
- **Capture** (`reviews/round7/r4fix-audio/shots-full/`, `capture-full.log`):
  21/21 shots, `clockPinned: true`, `frameTimeouts: 0`, `errorCount: 1` — the
  pre-existing `06-loaded-hud` subject check (`monsters under load`), the only
  entry in `subjectFailures` and unchanged in kind from `E-framing.md` §5.
  `audioOk: true`, all 12 gate checks true. Exit 1, from that subject check
  alone.

---

# 5. Arms I did NOT test

Stated because round 3's lesson was that this is where the next critic goes.

1. **I could not listen.** Everything here is introspected or rendered. The clap
   retune, the `sfxLimiter` retune and the `ARC_AUTHORITY` value are numbers
   chosen against measurements, not against ears. Of the three, the limiter
   retune is the one most likely to be wrong in a way only a listener can hear.
2. **D1's post-change peak table is arithmetic, not a render.** I did not rebuild
   the critic's offline per-layer isolation rig, so "the clap now sits under the
   kick" is −4.03 dB applied to their measurement. A per-layer re-render is the
   check that would close it.
3. **No real networked session.** The teammate-death guard is proved by a
   single-process reproduction on the same event bus (`probeL.json:latches`) plus
   the static trace `NetHost.js:58 → NetClient.js:106 → Audio.js`. Two hosts on a
   wire were not run.
4. **No `--software` capture at all**, full or partial. The gate's analyser path
   is untested on the SwiftShader renderer; the `AudioContext` is renderer-
   independent so I expect it to hold, but I did not run it.
5. **The concurrent `Engine.start` fix** is not in the tree I measured (see the
   note at the top). Every live number here should be re-taken once it lands.
6. **`WORLD_VOICES = 44` was not swept.** I measured 44 and inferred the trade at
   other values from the limiter reduction; I did not run combat at 30 or 60 to
   plot it.
7. **The graceful-refusal fallbacks were not judged for how they sound** — only
   that they emit 3 and 2 nodes instead of 0. Whether a 2-node shot reads as "a
   shot" or as "a click" is a listening question.
8. **`_always()` has one caller.** If a future sound uses it while a world sound
   is mid-emit the bucket handover assumption (synchronous, non-overlapping sound
   bodies) is what holds it together; that assumption is documented at `_take`
   but is not enforced by anything.
9. **Item cue batching under a slow frame**: the microtask flush assumes every
   write in one grant is synchronous. It is today (`Items._settleBlight`). A
   grant that ever awaits between writes would produce two cues again.

---

# 6. What the item system's owner must still change

Not mine to edit; all three are in files another fixer owns.

1. **`Items.js:337` — `_settleBlight` writes a negative delta inside a pickup.**
   I have made `Audio` deaf to it by netting the whole transaction, which fixes
   the audible symptom. The underlying wire format still says "this item was
   removed" in the middle of a reward. **`Items._set` should carry a `reason`
   (`'give' | 'take' | 'corrupt' | 'refine'`)** and let `Audio` read the
   direction off the wire instead of inferring it from the sign.
2. **`Interactables.js:1253` (Marrow Kiln) and `RealmProps.js:349` (Hollow Market
   refinery) still emit a rejection buzzer on success.** Both are a removal that
   is the *consequence* of a successful action with no gain beside it, so netting
   cannot see it — the transaction genuinely is "an item left the inventory". The
   `reason` field above is the fix; until it exists, `Audio.itemChanged` cannot
   tell that removal from a `take()`.
3. **`Combat.js:481` — an absorbed hit has no cue.** `playerHurt` is emitted only
   when health was lost, and the payload already carries `absorbed`. Emitting it
   (or a sibling event) when `dealt === 0 && absorbed > 0` would let `Audio` give
   a barrier its own sound; there is no hook for it from this side.

---

# 7. Declined, with reasons

- **Removing `_itemCounts` (N2).** It is the documented fallback for a payload
  without `delta`, and `Audio` cannot prove no such payload exists. Kept, and now
  cleared by `beginRun()`.
- **Scaling the boss/teleporter floors by `(1 - arc)` to restore their late-run
  separation (N3).** It would work, and it is a design change to how set-pieces
  read at high difficulty that nobody asked for in this round. Measured and
  reported instead.
- **Widening `WORLD_VOICES` past 44 to push the refusal rate lower (M5).** It
  trades directly against SFX limiter pumping, which is the thing D4 says was
  never measured before it was chosen. Two of the three knobs here need a
  listener; I moved the one I could justify with a number and stopped.
- **Making the gate assert on `ac.destination`.** Not observable from
  JavaScript. Documented as the one uncovered edge.
