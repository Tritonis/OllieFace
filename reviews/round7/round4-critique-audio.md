# Round 7 — round-4 critique: audio (`Music.js`, `Audio.js`, `tools/capture.mjs`)

Independent round-4 critic, and by `RUBRIC.md` the **last** critic this domain
gets. Branch `round7/content-and-polish`, HEAD `a43cc70`. I was not involved in
building or fixing any of it. Every number below is mine, from my own
instruments, taken on the tree **with** the concurrent-`Engine.start` fix in it.
Nothing is inherited from `reviews/round7/round4-fix-audio.md` or
`reviews/round7/r4fix-audio/`.

**Verdict: FAIL** — 0 critical, 3 major, 3 moderate, 4 minor.

Round 4 did the work. The intensity model is genuinely repaired at both ends,
the voice budget is genuinely two budgets, the latches genuinely clear, and the
capture gate genuinely stopped certifying silence. I confirmed twenty of
twenty-three of its claims against my own instruments, several rows
digit-for-digit, and could not shake any of them.

It fails on two things. The first is a regression round 4 introduced while
fixing a real bug: on a real multiplayer client — which I finally stood up, on a
real wire, for the first time in this project — **your own death is silent**. The
second is that the rebuilt gate, which is a large improvement, still returns
green on three classes of audibly-broken build that I have on disk.

§6 is written for whoever has to decide whether to ship this, and separates
*still broken* from *fixed but unverifiable here* from *acceptable*.

---

# 1. Methodology

Seven instruments. All drive the product code; none of it is modified. Scripts
and raw JSON are under `reviews/round7/r5-audio/` — deleting them would make
every reproduction below unrepeatable.

| artefact | what it is |
|---|---|
| `p1-model.mjs` → `p1-model.json` | The real `MusicEngine` on a real `OfflineAudioContext` whose `currentTime` is a settable facade, with `silent = true` so the model integrates without synthesising. **There is no `Engine` and no frame loop in it at all**, so the concurrent-loop bug cannot reach any of its numbers. Intensity at both ends across a difficulty sweep, `cool()`, the floors, the opening ceiling, `stop()`/`reset()`, resync, hat quantisation. |
| `p2-render.mjs` → `p2-render.json` | Sample-exact renders of the real `MusicEngine` and the real `Audio` graph. Per-layer isolation (peak **and** RMS), DC offset, clipping, sample-to-sample slew against layer-commit times, the `stop()`→`reset()` revival the gate drives every capture, and the gate's own configuration rendered so its margin can be read off a waveform. |
| `p3-check.mjs` → `p3-check.json` | Instrument sanity. Clap-vs-kick across five independent seeds; a second attempt at phase cancellation with the noise buffer seeded too. |
| `p4-live.mjs` → `p4-live.json` | The live game, real Chromium on the GPU path with `tools/capture.mjs`'s launch flags, a real mouse gesture, a real `AudioContext`. Voice budgets, `playerHurt` at saturation, the latches, the client death path, item cues, volume/mute, and a non-finite `AudioParam` detector installed before any product code runs. |
| `p5-net.mjs` → `p5-net.json` | **A real two-page networked session** over the manual WebRTC invite path — the arm rounds 2, 3 and 4 all listed as untested. `host.authority true / client.authority false / myNetId 1 / peers 2`. |
| `p6-sweep.mjs` → `p6-sweep.json`, `p6b-sweep.mjs` → `p6b-sweep.json` | The refusal rate and the `WORLD_VOICES` sweep at 30 / 44 / 60 / 88. **Neither reached a fight** — `p6` never advanced `ctx.time` at all, `p6b` reached 1.7 enemies. Kept, with their empty outputs, because D3 rests on them. |
| `build-attack.mjs` → `gate-attack.mjs` | A byte-faithful copy of the **shipped** `tools/capture.mjs` with a `--sabotage` switch injected at three anchors and nothing else changed. Four new arms, deliberately different in kind from round 4's six. |
| `gate-ctl{1,2,3}/`, `gate-{killkit,dconly,wrongtempo,sfxdead}/`, `gate-sw/`, `shots-full/` | The capture runs and their manifests. |

```
node reviews/round7/r5-audio/p1-model.mjs   --port 5501
node reviews/round7/r5-audio/p2-render.mjs  --port 5502
node reviews/round7/r5-audio/p3-check.mjs   --port 5671
node reviews/round7/r5-audio/p4-live.mjs    --port 5681
node reviews/round7/r5-audio/p5-net.mjs     --port 5711
node reviews/round7/r5-audio/p6-sweep.mjs   --port 5701     # measured nothing; see D3
node reviews/round7/r5-audio/p6b-sweep.mjs  --port 5721     # measured a lull; see D3
node reviews/round7/r5-audio/build-attack.mjs
node tools/capture.mjs --only 01-title --out reviews/round7/r5-audio/gate-ctl1 --port 5611     # and ctl2, ctl3
node tools/capture.mjs --software --only 01-title --out reviews/round7/r5-audio/gate-sw --port 5636
node tools/capture.mjs --out reviews/round7/r5-audio/shots-full --port 5641
node reviews/round7/r5-audio/gate-attack.mjs --sabotage killkit    --only 01-title --out reviews/round7/r5-audio/gate-killkit    --port 5632
node reviews/round7/r5-audio/gate-attack.mjs --sabotage dconly     --only 01-title --out reviews/round7/r5-audio/gate-dconly     --port 5633
node reviews/round7/r5-audio/gate-attack.mjs --sabotage wrongtempo --only 01-title --out reviews/round7/r5-audio/gate-wrongtempo --port 5634
```

## Instruments I refuted, and said so

This project has discarded five of its own instruments across four rounds. Four
of mine went the same way. They are listed because the reason to trust the rest
is that the failures are visible.

1. **`p2`'s phase-cancellation section is invalid.** It reported the sum of the
   ten isolated layers as **9.7 dB louder** than the mix of the same ten. That is
   impossible for a linear mix, and it was my rig: `mkOffline` filled the shared
   noise buffer from the *real* `Math.random` outside the seeded region, so no
   two renders shared a buffer. `p3` re-ran it with the buffer seeded and it got
   *worse* (−10.2 dB, sum peaking at 3.72 with eight layers reporting an
   identical 0.337 peak — a signature of measuring something other than the
   soloed layer). **I report no phase measurement from either.** §4 uses the one
   arithmetic check that is sound instead.
2. **`p4`'s and `p6`'s `WORLD_VOICES` sweeps measured nothing, and `p6b`'s
   measured a lull.** `p4` and `p6` recorded `takes: 0, refusals: 0,
   enemiesMean: 0, diffMax: 1.000` at every budget over 25-45 s — a difficulty
   coefficient pinned at exactly 1.000 means `ctx.time` never advanced, i.e. no
   fixed step ran and nothing ever asked for a sound. `p6b` forced
   `ctx.paused = false` on every sample, which did unpause the simulation
   (`diffMax` 1.005 → 1.030) — but the director banks credits from
   `ctx.time = 0`, so it produced **1.7 enemies mean, 11 `_take` calls and 0
   refusals in 40 s**. A valid measurement of a lull, and useless as a
   measurement of a firefight. See D3.
3. **`p4`'s live `lateArc` "full arena" column is invalid** for the same reason
   (`enemies: 0` in every row). Its *empty*-arena column is valid and is cited —
   the difficulty pin worked, `arc` reading 0 / 0.26 / 0.65 / 0.65 exactly.
4. **`p2`'s near-Nyquist figure (−19.7 dB above 18 kHz) is not an aliasing
   detector.** A one-pole 6 dB/oct high-pass leaks most of the band below it, and
   a mix whose hats and claps are white noise through wide band-passes has real
   content there. I draw no conclusion from it; §4 argues aliasing from the code.
5. Four of fourteen browser launches died on `page.goto: Timeout` against a cold
   vite transform, and the first two attempts at the networked session could not
   get a second page to fire `load` inside 180 s while the first page's rAF loop
   was running. All were re-run; see N4.

---

# 2. The gate — three ways past it, on disk

Round 4 rebuilt the gate to assert three independent things (a step delta,
liveness read off product state, audibility off two `AnalyserNode`s) and proved
it fails six ways. That work is real and it fixed round 3's C2.

**Full 21-shot run, shipped `tools/capture.mjs`, current tree**
(`reviews/round7/r5-audio/shots-full/manifest.json`):

```
audio.beforeGate: { ready: true, state: "running", stepsEmitted: 480,
                    stopped: true, musicOff: true, musicGain: 0 }
audio:            { stepsDelta: 49, musicPeak: 0.12916, outputPeak: 0.11101,
                    samples: 102 }          all 12 checks true, audioOk: true
```

`beforeGate.musicGain` is **exactly 0** on arrival. Round 3's gate read
`stepsEmitted: 480 > 0` in that state and reported green. This one revives
through `beginRun()` and then measures 49 sequencer steps and −17.8 dBFS of real
signal. Round 4 reported 28 steps and 0.0496; on the tree with the engine fix in
it the numbers are **better**, not worse. CONFIRMED, and I could not shake it.

## The seventh failure, and the eighth, and the ninth

Round 4's six arms are all one shape: *the graph produces nothing* (no-op'd
sources, a stopped engine, a parked bus, a muted master, a disconnected master,
an unwired engine). The gate catches every one. It does not catch audio that is
**loud, continuous and wrong**, because the whole of the audibility test is
`peak >= 1e-3` on two taps.

Four arms of that kind, built into a byte-faithful copy of the shipped file.
Three applied cleanly and **all three pass**:

| arm | what it breaks | `stepsDelta` | `musicPeak` | `outputPeak` | checks failed | `audioOk` |
|---|---|---|---|---|---|---|
| *(control ×3, shipped file)* | nothing | 35 / 25 / 35 | 0.0558 / 0.0524 / 0.0558 | 0.0571 / 0.0557 / 0.0518 | none | true |
| **`killkit`** | `kick, hat, bass, openhat, clap, perc, acid, lead` disconnected — 8 of 10 layers gone | 25 | **0.0524** | 0.0539 | **none** | **true** |
| **`dconly`** | the engine unwired exactly as round 4's `unwired` arm does it, **and a 0.03 DC `ConstantSourceNode` connected to the music bus in its place** | 21 | **0.0144** | 0.0315 | **none** | **true** |
| **`wrongtempo`** | `bpm` pinned to 600 — every note fires, five times too fast | **125** | 0.0677 | 0.0695 | **none** | **true** |
| `blown` | master gain ×25 | — | — | — | — | *not applied — see below* |

**`killkit`'s `musicPeak` is 0.05241 — the same value, to five decimals, that an
unsabotaged control run recorded.** Deleting eight of the ten layers changed the
gate's reading by nothing at all. That is structural, not luck. `beginRun()`
calls `musicEngine.reset()`, which sets `_runT = 0`; the opening ceiling
(`Music.js:351`) then pins `I` at 0.10 — 0.119 at the very end of the window if
the page is not paused, and on a full run the death screen holds `ctx.paused`
so `_runT` does not advance at all. Against the layer table (`Music.js:79-97`),
`sub` enters at −0.06, `pad` at −0.08, `kick` at 0.13 and everything above it
higher. **The gate is incapable of hearing more than `sub` and `pad`.** Eight of
ten layers, the entire arrangement above the bed, the whole intensity model,
`bump()`, `cool()` and the bar-quantised commits are outside its reach by
construction.

**`dconly` refutes the load-bearing argument for the analyser.** The report's
case is the `unwired` arm — engine running, flags green, output connected to
nothing, only `musicAudible` fails. True *provided nothing else feeds `a.music`*.
Connect anything and the check passes. A 0.03 DC offset — not a soundtrack, not
even audio — reads 0.0144 on the tap (0.03 × the 0.48 bus gain; the DC is the
only signal present) and takes all twelve checks green. The check asks "is this
node's output non-zero", not "is this the game's music".

**`wrongtempo` shows the step delta is not a tempo check.** At 600 bpm
`stepsDelta` is 125 against a control of 25-35 and a floor of 8. There is no
upper bound, so a sequencer running five times too fast reads as healthier than
a correct one.

*(`blown` reported `NO AUDIO GRAPH`: `a.ac` did not yet exist when my injection
ran immediately after `page.keyboard.press('KeyZ')` resolved. That is a race in
my harness, not in the product, and it is reported as not run rather than as a
result.)*

## What the gate also cannot see

- **The whole SFX catalogue.** Twenty-six emitters, all of the world's audio,
  and not one of the twelve checks touches the SFX bus. The gate's own comment
  concedes this (`capture.mjs:519-522`). I ran a `sfxdead` arm that no-ops
  `_tone`/`_noise` on the `Audio` prototype and it passed (`audioOk: true`,
  `stepsDelta: 28`) — but I could not positively confirm from the manifest that
  the patch had landed, so I rest the claim on the code, not on that run.
- **Which scenarios ran.** The window is synthetic: `beginRun()` manufactures
  the state being measured. `--only 01-title` passes with the same twelve checks
  as a 21-shot run. `audioOk: true` on a partial capture is not evidence that
  the capture had audio.

## The `--software` path — round 4 ran none of it

`node tools/capture.mjs --software --only 01-title` (`gate-sw/manifest.json`):

```
audioOk: true   stepsDelta: 12   musicPeak: 0.05627   samples: 1189
determinism: { clockPinned: true, frameDt: 0.0167, frameTimeouts: 1 }
```

`samples: 1189` at 16 ms is **19 s of wall clock** — `frames(180)` hit its own
20 s hang guard (`Harness.js:248`), which is what `frameTimeouts: 1` records.
See M3.

---

# 3. Verification table — round 4's claims against my own numbers

| # | round-4 claim | their number | my number | verdict |
|---|---|---|---|---|
| 1 | `ARC_AUTHORITY` fixes C1; span at the cap 0.000 → 0.277 | 0.277 | **0.2772** empty→full; **0.3080** empty→full-with-combat-heat; `deadRows: []` | **CONFIRMED** |
| 2 | the whole both-ends table (0.792 / 0.689 / 0.586 / 0.406 / 0.339 / 0.277) | as listed | **0.792 / 0.689 / 0.586 / 0.406 / 0.339 / 0.277** | **CONFIRMED** digit-for-digit |
| 3 | `cool()` moves 0.9272 → 0.6918 at the cap | 0.235 of I | 0.958 → 0.7257 (+1 s) → **0.6546** (+15 s); drop **0.3034** | **CONFIRMED** |
| 4 | floors at difficulty 3.5: boss 0.896 / charging 0.909 / full 0.927 | as listed | **0.8964 / 0.9087 / 0.9272** | **CONFIRMED** |
| 5 | the opening ceiling is unmoved | `_runT` 0.00, I 0.170 at 6 s | `_runT` **0.000** after 45 s paused, I **0.000**; thereafter I tracks `0.10 + t/60·0.70` exactly | **CONFIRMED** |
| 6 | `reset()` revives a stopped engine | 51 → 51 → 94 steps | **43 → 43 → 86**, `stopped: false`, `_pending: null`, `_runT` reseeded | **CONFIRMED** |
| 7 | M3: a teammate's death does not stop a living player's music | steps 858 → 871 | single-process: steps **231 → 235**, `stopped: false`, gain 0.48. **On a real wire**: host dies → client `stopped: false`, `musicGain: 0.48000` | **CONFIRMED twice** |
| 8 | M3: a second run in one page session has music | steps 894 → 918 | `stopped` true → **false**, `musicOff` true → **false**, gain 0.066 → **0.48**, steps 235 → 241 | **CONFIRMED** |
| 9 | M1: `voicesSpentByHurt` 0 → 3 with the world budget saturated | 3 | **3** (priority 3) at `worldVoices 43` with `_take(5)` refused; duck **0.48000 → 0.16955 → 0.48000** | **CONFIRMED** |
| 10 | M2: the six ungated calls → 58 voices / world 35 / priority 23, shoot and hurt both allowed | 58 / 35 / 23 | **58 / 35 / 23**, `shootAllowed: true`, `hurtAllowed: true` | **CONFIRMED** |
| 11 | all 26 emitting entries reach a `_take`/`_always` | 26, by parse | **26 emitters, 0 ungated**, by my own independent parse | **CONFIRMED** |
| 12 | M4: one cue per inventory transaction | `pickup(0)` alone | give→`pickup(0)`; take→`deny()`; two different commons in one frame→**one** `pickup(0)` | **CONFIRMED** |
| 13 | N4: `_ensure()` no longer throws on an `OfflineAudioContext` | guarded | the whole `Audio` graph builds and runs offline with no `InvalidStateError` | **CONFIRMED** |
| 14 | volume / mute behave | 0.48 / 0.00007 / 0.8 | music **0.48**; music 0 → **0.0002** + `silent: true`; back → **0.4792**; muted → master **0** + `silent`; unmuted → **0.8** | **CONFIRMED** |
| 15 | no non-finite `AudioParam` writes | `[]` | **`[]`** across a full live session; 0 console errors, 0 page errors | **CONFIRMED** |
| 16 | the gate revives a corpse and then measures real signal on a full run | 28 steps / 0.0496 | `beforeGate` stopped, `musicOff`, gain **0**; then **49 steps / 0.1292 / 102 samples**, 12/12 | **CONFIRMED** (better) |
| 17 | D1: `clap` 3.50 → 2.20 puts its transient ~0.03 dB **under** the kick | arithmetic on the previous critic's render | rendered fresh, 5 seeds: **+0.51 dB over** the kick (range −0.21 … +1.16) | **REFUTED as stated**; the improvement (was +4.00) is **CONFIRMED** |
| 18 | the gate "was failed six ways" | 6 arms | 6 arms of one shape. **3 new arms of a different shape all pass** | **CONFIRMED but narrow** — §2, M2 |
| 19 | untested arm: `--software` | not run | ran: passes with **12 steps against a floor of 8** and `frameTimeouts: 1` | **new finding, M3** |
| 20 | untested arm: a real networked session; the teammate guard is "positive evidence" | static trace + single-process | ran, connected. Teammate half **CONFIRMED**. Self half **REFUTED** — see M1 | **REFUTED in part** |
| 21 | untested arm: `WORLD_VOICES` never swept | not run | my sweep instrument failed three times; **not measured** | **UNVERIFIABLE here** — D3 |
| 22 | M5: refusal 54.6% → 45.4%, "improved and not closed" | 45.4% | **not measured** (same instrument failure) | **UNVERIFIABLE here** — D3 |
| 23 | the two `deny()`-on-success sites are unfixed and not `Audio`'s to fix | filed | confirmed unfixed; `RealmProps.js:344-352` takes a stack and spawns an **orb**, so the transaction really is a pure loss and netting cannot see it | **CONFIRMED** |

---

# 4. Checked and clean

Each is something round 4's changes could plausibly have broken, and each is
measured here rather than inherited.

- **No clicks at layer commits.** `p2-render.json:ramp` — a 70 s 0 → 1 ramp with
  **33 layer commits**; of the 200 largest sample-to-sample slews in the render,
  **0** fall within 5 ms of a commit.
- **No click on the revival the gate now drives every capture.** `stop()` at
  t = 10 s, `reset()` at t = 16 s: the largest slew in the 900 ms bracketing the
  revival is **0.0004**. `stop()` does reach digital silence (peak exactly 0.0
  over 13-16 s), and the arrangement rebuilds over the following ~3 s.
- **No clipping, anywhere.** 0 clipped samples across four full mixes, the 70 s
  ramp and the revival render. Music-bus peak at the loudest reachable state
  (I = 0.958) is **−3.08 dBFS**, before the 0.48 bus gain and the master.
- **No DC offset.** Whole-render mean −0.002 (−54 dB) at worst; the opening mix
  reads 1.9e-5. The worst 20 ms windowed mean (−0.109) is the 27.5 Hz sub being
  less than one cycle long inside the window, not an offset.
- **No evidence of destructive cancellation.** Both of my direct instruments were
  wrong (§1), so I use the arithmetic that is sound: the incoherent power sum of
  the ten isolated layer RMS values is **−20.54 dB** and the rendered mix of the
  same ten is **−21.62 dB**. The 1.1 dB deficit is the sidechain duck, present in
  the mix and absent from the isolated renders. Cancellation would show a far
  larger deficit; there is none.
- **No aliasing, by construction.** Every music source is a stock band-limited
  WebAudio oscillator or a noise buffer read at rate 1.0 — `Music.js` sets no
  `playbackRate` anywhere. `Audio._noise` does vary `playbackRate` (0.9-1.1), but
  only on white noise, where resampling produces white noise.
- **Resync keeps the bar counter.** 60 s with three 0.6 s stalls: 33 bars, 3
  resyncs, **0 rewinds**, 526 steps.
- **Hat quantisation holds.** 23 bars under ±0.02 intensity dither across the
  0.55 threshold: **0 bars with more than one flip**, 1 flip in total.
- **The opening ceiling is exact.** 45 s on a paused survivor-select screen
  leaves `_runT` at **0.000** and I at **0.000**.
- **`stageStart{index > 0}` neither resets the run nor stops the engine**
  (`stopped: false`, steps 227 → 231).
- **Voice costs are honest at the call sites.** I counted emitted nodes by hand:
  `explosion` is 5 fixed plus 2-4 randomised debris ticks = 9 worst case against
  `_take(9)`, and its fallback emits exactly the 3 it charges; `shoot` is 5 and 2.
- **The priority reserve is real under load.** Filling the world budget with real
  explosions reaches `worldVoices: 43`, refuses `_take(5)`, and still lets
  `_take(3, true)` through — measured live, not inferred.
- **On a real wire, the host is correct in both directions**: a client's death
  leaves the host's music running (`stopped: false`, gain 0.48); the host's own
  death stops it (`stopped: true`, `musicOff: true`, gain 0.00323).
- **No console or page errors** attributable to audio across a full 21-shot
  capture, four `--only` captures, a `--software` capture, a full live session
  and a two-page networked session.
- **The full capture is otherwise unchanged**: 21/21 shots, `clockPinned: true`,
  `frameTimeouts: 0`, `errorCount: 1` — the pre-existing `06-loaded-hud`
  "monsters under load" subject check, the only entry in `subjectFailures`.

---

# 5. Findings

## MAJOR

### M1 — on a real multiplayer client, your own death is silent. Round 4 introduced it.

**Where:** `src/systems/Audio.js:238-241`.

```js
e.on('playerDead', () => {
  if (this.ctx?.player && this.ctx.player.alive !== false) return;
  this.playerDead();
});
```

The guard is right for the bug it was written for — round 3's M3, a teammate's
death permanently silencing a living client — and that half works (§3 row 7,
confirmed on a real wire). Its stated premise is that "`alive` is set to false
before the emit on every path that raises this, so the local player being alive
here is positive evidence the death belongs to somebody else". True on a
**host**. On a **client**, `ctx.player.alive` is never false at all:

- `Combat.applyDamage` returns 0 at `src/systems/Combat.js:382`
  (`if (!ctx.authority) return 0;`) — before it can reach `_kill`, the only
  thing that writes `victim.alive = false` (`Combat.js:516`).
- `Player.takeDamage`'s self-kill fallback (`src/entities/Player.js:1245`) is
  gated on `!this.ctx.combat`, and a client *has* a `Combat` — `src/main.js:52`
  adds it unconditionally, regardless of net role.
- Nothing applies the snapshot's `healthFrac` to the client's own player.
  `NetClient._reconcile` writes x/y/z and nothing else
  (`src/net/NetClient.js:193`), and `NetClient.update` skips the local entity
  outright (`src/net/NetClient.js:239`, `if (netId === this.myNetId) continue;`).
  `Combat.js:379`'s comment — "A client's health comes from snapshot
  `healthFrac`" — describes code that does not exist.

So the guard returns on **every** `playerDead` a client sees, including the one
the host forwards for that client's own death (`NetHost.js:58` →
`NetClient.js:106` → `Audio.js:239`).

**Measured on a real two-page networked session** (`p5-net.json`;
`host.authority true / client.authority false / client.myNetId 1 / peers 2`):

| step | on the host | on the client |
|---|---|---|
| host deals 40 damage to the client's pawn | pawn health **110 → 70**, `alive: true` | own health **110.0** (unchanged), `alive: true`, `playerHurt` cues fired: **0** |
| host kills the client's pawn | pawn `alive: false`, `health: 0` | `alive: **true**`, `stopped: **false**`, `_musicOff: **false**`, `music.gain: **0.48000**`, `menus.screen: **"death"**` |
| host then kills its own player | `stopped: **true**`, `_musicOff: **true**`, `music.gain: 0.00323` | `stopped: false`, `music.gain: 0.48000` — correct, this one is a teammate |

`p5-net.json:verdicts.clientOwnDeathStoppedItsMusic: false`.

The client's run-summary screen is up — every other subscriber to `playerDead`
acted, `HUD.onDeath` and `Progression._endRun` included — while `Audio` alone
returned. The soundtrack plays on at full level over the death screen, the
ambient bed never darkens, and the two-second `playerDead` sting never fires.
The client also never hears its own damage at all (`playerHurt` cues: 0 across
the session), which is a pre-existing netcode gap and not round 4's, but it
means the guard's inference has no fallback signal to lean on.

Round 3 rated the symmetric failure MAJOR. This is the same bug reflected, and
it fires on **every** client death rather than only on a co-op death.

**Reproduce:** `node reviews/round7/r5-audio/p5-net.mjs --port 5711`, read
`afterClientDeath.client` and `verdicts`. Single-process equivalent, no wire:
`node reviews/round7/r5-audio/p4-live.mjs --port 5681`, read `clientDeath` —
`{ dealt: 0, healthAfter: 110, alive: true, stopped: false, musicGain: 0.48,
screen: "death" }`.

**Fix.** The guard needs a fact instead of an inference. Either:

1. **Put the victim on the wire.** `Combat.js:526` emits `playerDead` with `{}`;
   emitting `{ netId }` and testing it at `Audio.js:239` removes the guesswork
   entirely. This is exactly the remedy round 4's own §6 demands of the item
   system's owner for the analogous `Items._set` case, and it is right here too.
2. **Failing that, gate on authority, not on `alive`:**
   `if (this.ctx?.authority && this.ctx.player?.alive !== false) return;`
   On a host that is byte-for-byte today's behaviour. On a client every
   `playerDead` plays — wrong only for a teammate's death, i.e. it puts the
   defect back where round 3 found it instead of leaving it inverted. Silence on
   your own death is strictly worse than a stinger on a teammate's, and this is
   one line.

Either way it must be verified on two hosts. "No networked session" has been on
the untested list for three consecutive rounds, and this is what was living in
it. `p5-net.mjs` is left in the tree so the next person does not have to build
the rig again.

### M2 — the gate passes three classes of audibly-broken build, and can only ever hear two of the ten layers

**Where:** `tools/capture.mjs:524-635`. Evidence, manifests and the structural
argument are in §2.

Summary of what is on disk: `killkit` (8 of 10 layers disconnected) returns
`audioOk: true` with a `musicPeak` **identical to five decimals** to an
unsabotaged control; `dconly` (engine unwired, a 0.03 DC source connected to the
music bus in its place) returns `audioOk: true`; `wrongtempo` (600 bpm) returns
`audioOk: true` with a step delta five times the control's. Plus two structural
gaps: the entire SFX catalogue is untouched by all twelve checks, and the
verdict is independent of which scenarios ran.

This is a gate, not shipped behaviour, so it is not CRITICAL. It is MAJOR because
it is being cited as evidence — the round-4 report leads with it — and because
the class of build it certifies is exactly the class a future regression will
produce: something still makes a noise, and the noise is wrong.

**Fix**, in rough order of value per line:

1. **Do not reset the run.** The reason the gate hears two layers is that it
   revives with `reset()`, which zeroes `_runT` and hands the opening ceiling
   control of intensity. Set `musicEngine._runT = 120` and `bump()` a few times
   after `beginRun()`, and the same 3 s window exercises the whole kit. Then
   assert a per-layer floor off `musicEngine.levels()` rather than one bus peak.
   That alone kills `killkit`, and it is about five lines.
2. **Bound the step delta on both sides**, e.g. `8 <= stepsDelta <= 60`. A window
   of known length has a known step count; an unbounded assertion cannot see a
   tempo fault.
3. **Reject DC and stuck notes.** The sampler already holds the samples: compare
   peak against the window mean (`peak - |mean| >= floor`) to reject a constant,
   and count zero crossings per second against a floor to reject a held note.
   A handful of lines inside the loop that already runs.
4. **Tap the SFX bus and fire one catalogue entry inside the window.**
   `a.uiClick(0)` costs two nodes and no gameplay state, and it closes the
   largest uncovered surface in the system for about three lines.

None of that makes the gate a listener. It makes it a smoke test that cannot be
passed by silence *or* by a graph that is obviously not the soundtrack, which is
the honest ceiling for an automated check here.

### M3 — the `--software` gate is one rendered frame from a false failure, and round 4 ran none of it

**Where:** `tools/capture.mjs:528` (`GATE_FRAMES = 180`) and `:626`
(`stepsAdvanced: A.stepsDelta >= 8`), against `src/core/Harness.js:248`
(`frames(n, maxMs = 20000)`) and `src/systems/Music.js:422-432`.

```
gate-sw/manifest.json:
audioOk: true   stepsDelta: 12   musicPeak: 0.05627   samples: 1189
determinism: { clockPinned: true, frameDt: 0.0167, frameTimeouts: 1 }
```

`samples: 1189` at 16 ms is **19 s of wall clock**: `frames(180)` hit its own
20 s hang guard having rendered a handful of frames, which is what
`frameTimeouts: 1` records. In that window the sequencer emitted **12 steps
against a floor of 8**. The mechanism is `_schedule`'s resync guard, which
discards every step in the gap between two widely spaced frames — by design,
"a bar the player never heard is not owed to them". So the step delta is a
function of **how many frames the renderer managed**, not of whether the audio
works.

On the GPU path the same assertion has 3-4× of headroom (25-49 against 8). On
the software path it has 1.5×. A slower CI box, a larger viewport or one more
competing process turns a healthy audio system into
`AUDIO FAILURE: stepsAdvanced` and a non-zero exit. The floor's own comment says
8 "leaves room for a slow renderer"; measured on the actual slow renderer, it
does not leave much.

**Reproduce:**
`node tools/capture.mjs --software --only 01-title --out <dir> --port <p>`,
read `audio.stepsDelta` and `determinism.frameTimeouts`.

**Fix.** Make the window a duration rather than a frame count when frames are
the scarce thing: sample `ac.currentTime` either side of the window and scale
the expected count by elapsed *audio* time
(`stepsDelta >= max(4, elapsed * bpm/60 * 4 * 0.25)`); or skip `stepsAdvanced`
when `frameTimeouts` increased during the window and let the two audibility
checks carry the verdict. Either is a few lines and removes a failure mode that
has nothing to do with the subject.

## MODERATE

### D1 — late in a run the intensity range is three layers wide, and that is what "0.277" means

**Where:** `src/systems/Music.js:162` (`ARC_AUTHORITY = 0.65`) and `:79-97`.

The fix is real and I confirmed the numbers (§3 rows 1-4). What the number *is*
was never stated in terms a player hears, and on the last round it should be.

At difficulty ≥ 3.5, `arc` saturates at 0.65 and the reachable range is
`I ∈ [0.650, 0.958]`. Against the layer table
(`p1-model.json:lateRunArrangement`):

| | `sub` | `pad` | `kick` | `hat` | `bass` | `openhat` | `clap` | `perc` | `acid` | `lead` |
|---|---|---|---|---|---|---|---|---|---|---|
| **empty arena**, I = 0.650 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.08 | 0 | 0 |
| after `cool()` + 15 s, I ≈ 0.655 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.12 | 0 | 0 |
| **full arena**, I = 0.927 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.56 |
| full + combat heat, I = 0.958 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.82 |

Seven of ten layers are pinned at full in an arena with nothing in it, and the
tempo floor is 133.6 bpm against a ceiling of 141.0. Everything a fight buys —
and everything a stage transition gives back — is `perc`, `acid` and a partial
`lead`.

Reachability, from `Director.js:212-220` (solo, Rainstorm, `DIFFICULTY_SCALE 2`:
`d = (1 + 0.1012·minutes) · 1.15^stagesCompleted`): difficulty 3.5 arrives 9.9
minutes in on stage 5, 5.1 minutes in on stage 7, 1.4 minutes in on stage 9. A
long run spends most of its length here.

This is **not** the round-3 bug: the range is non-zero for every reachable arc,
`cool()` demonstrably moves 0.30 of I, and round 4 states the cost honestly in
`Music.js:155-160`. It is a design position, and it is recorded as MODERATE only
so that "the soundtrack reacts to what the player does" is not read as meaning
the same thing at minute 12 as at minute 1.

**If it is ever revisited:** the cheap version of the option round 4 declined is
to let `arc` raise the floor of the *bed* (`sub`, `pad`, `bass`) rather than of
the whole blend, leaving the transient kit under `pressure`'s control. That
keeps "already loud" without spending the whole kit on the difficulty clock.

### D2 — the two `deny()`-on-success sites are still live

**Where:** `src/world/realms/RealmProps.js:344-352` (Hollow Market refinery) and
the Marrow Kiln in `src/world/Interactables.js:1156+`, against
`src/systems/Audio.js:960-968`.

Round 4 files both for the item system's owner and says netting cannot see them.
I checked the refinery rather than taking it on trust, and it is right:
`interact()` does `items.take(from.id, 1)` and then
`interactables.spawnOrb(...)` — the replacement is an **orb on the ground**, not
a `give`, so the transaction really is a pure loss and `_flushItemCue` emits
`deny()` alongside the `shrineWin` the same function plays two lines earlier.
`Items._set` (`src/systems/Items.js:287-297`) still carries only
`{id, count, tier, delta}` with no `reason`.

Confirmed unfixed, correctly attributed, and still a player-audible defect: two
successful interactions each play the reward cue and then the "that did not
work" buzzer.

### D3 — the refusal rate and the `WORLD_VOICES` sweep: NOT MEASURED, by me or by anyone

Round 4's headline for M5 is 54.6% → **45.4%** refused — which it calls noisy
and load-dependent itself — and untested arm 6 is that `WORLD_VOICES = 44` was
never swept. I built an instrument for both, and **it did not work, three times**.

`p4-live.json:sweep` and `p6-sweep.json` record, at every budget:
`takes: 0, refusals: 0, enemiesMean: 0, capMax: 18, diffMax: 1.000` over 25-45 s.
A difficulty coefficient pinned at exactly 1.000 means `ctx.time` never advanced
— no fixed step ran, the page sat paused behind a menu, the director never
banked a credit and nothing ever asked for a sound. `__HARNESS__.combat()` alone
does not leave the game in a running fight from a cold probe.

`p6b-sweep.json` forces `ctx.paused = false` and `director.enabled = true` on
every sample, and that *does* unpause the simulation — `diffMax` climbs 1.005 →
1.030 across the four budgets. It still does not produce a fight: the director
banks credits from `ctx.time = 0`, so the shipped control run saw **1.705
enemies mean (max 2), 11 `_take` calls and 0 refusals in 40 s**, with
`worldPeak: 10` against a budget of 44. The four sweep rows are indistinguishable
from each other because no budget was ever approached — at 1.7 enemies the
refusal rate is 0% at 30, 44, 60 and 88 alike, which tells a reader nothing
about the 17-enemy firefight round 4 measured.

I will not convert that into a number. **Round 4's 45.4% is neither confirmed
nor refuted by me, and `WORLD_VOICES` remains unswept after two rounds of being
named.** What I can say from code and from the measurements that did work:

- The mechanism is real and visible in `p4-live.json:hurtAtSaturation`: filling
  the world budget with real explosions reaches `worldVoices: 43` and refuses
  `_take(5)`, while `_take(3, true)` still succeeds and spends 3 priority
  voices. The reserve is not fiction.
- The percentage is not comparable to round 3's in either direction, because the
  graceful fallbacks make every downgraded sound cost **two** `_take` calls and
  at least one refusal (`Audio.js:594-595`, `:714-715`). Round 4 says this, and
  it is correct — which means 45.4% against 54.6% is not a like-for-like win.
- `WORLD_VOICES = 44` against an `explosion` that honestly costs 9 means a
  firefight holding 36 nodes drops the loudest event in the game to its 3-node
  form. Whether that is the right trade is a listening question, which is what
  round 4 said when it declined to move it. That remains the right answer.

This is a MODERATE finding about *evidence*, not about code: the one headline
number in round 4's report that a reader would most want to rely on is the one
neither round 4 (single overwritten run, its own dagger note) nor I can
reproduce from disk.

## MINOR

- **N1 — D1's clap claim is off by ~0.5 dB and by its sign.** Round 4 applied
  −4.03 dB arithmetically to the previous critic's render and concluded the clap
  now sits "~0.03 dB under the kick's transient". I re-rendered it across five
  independent seeds (`p3-check.json:clapVsKick`): the clap peaks **+0.51 dB over
  the kick on average**, range −0.21 to +1.16, with the kick itself stable to
  0.47 dB across seeds. The retune is a real ~3.5 dB improvement on round 3's
  +4.00 and the clap no longer dominates the kit; it does not sit under the
  kick. A further −0.5 to −1.0 dB (`clap.maxGain` 2.20 → ~2.00) would make the
  stated claim true. Peak span across the ten layers is now **23.14 dB** (round
  3: 25.74); RMS span **16.20 dB** (round 3: 16.98).
- **N2 — two different items granted in one frame still produce one cue.**
  Round 3's D2 was that the 40 ms throttle deleted the second of two distinct
  pickups. The throttle is gone, and `_flushItemCue` now collapses the whole
  transaction to one cue instead (`p4-live.json:itemCues` — two different
  commons in one frame → a single `pickup(0)`). It is better than the throttle,
  because the *best* tier survives rather than the *first*, but the audible
  count is unchanged and a chest burst of three items still plays one jingle.
  Deliberate and defensible; worth knowing it was not restored.
- **N3 — `_cueTier`, `_cuePending` and `_cueRemoval` are never declared.** They
  are created on first use in `itemChanged` (`Audio.js:927-933`) and read in
  `_flushItemCue`. The `?? -1` and `!= null` guards make the undefined case
  behave, so this is style rather than a bug — but every other piece of state on
  this class is declared in the constructor, and `beginRun()` clears
  `_itemCounts` and not these three.
- **N4 — the capture harness itself is flaky, and it is not audio.** Four of my
  fourteen browser launches died on `page.goto: Timeout 30000ms exceeded`
  against a cold vite transform, and two attempts at the networked session could
  not get a second page to fire `load` inside 180 s while the first page's rAF
  loop was running (fixed by freezing page A during page B's load — a technique
  the next person will need). Re-running cleared every one. Out of my domain;
  recorded because a reader comparing run counts will notice the retries.

---

# 6. FINAL POSITION

Written for someone deciding whether to ship. `RUBRIC.md` caps this domain at
four critic rounds, so this is the last word and it has to be usable rather than
diplomatic.

## Still broken

1. **A multiplayer client's own death is silent** (M1). Confirmed on a real
   two-host session, not inferred. The death screen appears with the soundtrack
   at full level and no death cue. It is a one-line fix with an obvious better
   two-line fix beside it, and it is a regression this round introduced. **This
   should not ship as it stands.** If multiplayer is being shipped at all, fix
   it; if the decision is that co-op is beta, then this is a known beta defect
   and the single-player experience is unaffected — `Combat._kill` sets
   `alive = false` before the emit on the host, and I confirmed the
   single-player path works in both directions.
2. **The Marrow Kiln and the Hollow Market refinery play the rejection buzzer on
   success** (D2). Not `Audio.js`'s to fix, correctly filed by round 4, still
   live. Two interactions, both audible on a first playthrough. Small, cheap,
   and it needs one field on `Items._set`.
3. **The capture gate certifies builds it should not** (M2, M3). Nothing a
   player hears, everything a reviewer relies on. If this project's next change
   to audio is going to be validated by `audioOk: true`, the four fixes in M2
   are worth the half hour they cost, because today that flag survives eight of
   ten layers being deleted.

## Fixed, but not verifiable from here

- **The refusal rate and the voice-budget trade** (D3). Round 4's 45.4% comes
  from one run that overwrote itself, and its own report says so. My instrument
  failed three times — the best of the three managed a 1.7-enemy lull with 0
  refusals at every budget from 30 to 88 — so I cannot confirm or refute it, and
  `WORLD_VOICES = 44` has now gone two rounds without being swept. The
  *mechanism* is verified —
  the two budgets exist, the reserve holds under saturation, the fallbacks emit
  the node counts they claim — and the *rate* is unknown. If anyone wants that
  number, the missing piece is a probe that reliably puts the game into a
  sustained fight; `__HARNESS__.combat()` does not do it from a cold page.
- **Whether any of it sounds good.** Nobody in four rounds has listened. Every
  number in this report and in the three before it is rendered or introspected.
  The clap retune, the `sfxLimiter` retune, the `ARC_AUTHORITY` value and the
  2-node shot fallback are all choices that were made against measurements and
  that only ears can settle. `p2-render.mjs` renders the real engine
  sample-exactly into an `OfflineAudioContext`; adding twenty lines to write a
  WAV would give a human something to play. That is the single highest-value
  thing left undone in this domain.
- **Whether the intensity model works on a client at all.** Not measured — both
  pages in my networked run were on the survivor-select screen, so neither side
  had a fight. **PLAUSIBLE from the code, and worth someone's half hour:**
  `Director`'s spawn path is authority-gated (`Director.js:272`), `NetViews`
  never registers replicated enemies with `ctx.director.enemies`, and `damage`
  and `playerHurt` are absent from `NetHost`'s forward list (`NetHost.js:58-60`).
  If that reads the way it looks, then `_scanSustain` returns 0 on a client
  forever and the entire subject of rounds 3 and 4 — a soundtrack that reacts to
  the fight — does not function in co-op. I measured `playerHurt` cues on the
  client at **0** across a whole session, which is one leg of that argument
  standing up. I am flagging it, not claiming it.

## Acceptable to ship

Everything else, and it is most of it.

The intensity model is repaired at both ends and I confirmed the whole table
digit-for-digit: 0.792 of range at difficulty 1, 0.277 at the cap, no dead rows
anywhere, `cool()` moving 0.30 of I where round 3 moved 0.000. The opening
ceiling is exact. Twenty-six of twenty-six emitters are gated; the two-budget
design works under real saturation; `playerHurt` spends its three voices in the
fight that used to delete it. The latches clear, on a real wire and off it. One
cue per inventory transaction. No clipping, no DC, no clicks at layer commits,
no click on the revival, no non-finite parameter writes, no aliasing by
construction, no console errors across seven captures and two live sessions. The
resync keeps the bar counter and the hats stay quantised under dither. The gate
no longer passes a silent build — that part of round 3's C2 is genuinely closed,
and on the current tree the full-run numbers are better than round 4 reported.

The layer balance is 3.5 dB better than round 3 measured and the clap no longer
out-peaks the kick by 4 dB; it out-peaks it by half a decibel, which is a
rounding error next to where it started.

## The one sentence

Fix M1 or ship co-op knowing your own death is silent; everything else in this
domain is either good, or a gate that flatters itself, or a number nobody has
been able to measure twice.
