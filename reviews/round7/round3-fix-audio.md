# Round 7 — round-3 fixes: audio (`Music.js`, `Audio.js`, `tools/capture.mjs`)

Answering `reviews/round7/round2-audio.md`. Files changed: `src/systems/Music.js`,
`src/systems/Audio.js`, `tools/capture.mjs`. Nothing else in `src/` was touched.
Not committed.

## How every number below was produced

Two probes, both driving the **product code**, both run twice: once against a
clean `git worktree` at HEAD `75f87d6` (`../OllieFace-r3base`, `node_modules`
junctioned) and once against the fixed tree. Same probe, same seed, same
machine, same browser flags — so each before/after pair is one experiment with
one variable, rather than a fix measured against someone else's numbers.

| artifact | what produced it |
|---|---|
| `reviews/round7/r3-audio/before-offline.json` | offline render probe, HEAD worktree |
| `reviews/round7/r3-audio/after-offline.json` | offline render probe, fixed tree |
| `reviews/round7/r3-audio/before-live.json` | 150 s live gameplay probe, HEAD worktree |
| `reviews/round7/r3-audio/after-live.json` | 150 s live gameplay probe, fixed tree |
| `reviews/round7/r3-audio/shots-noclick{,2,3}/` | three full 21-shot captures, `tools/capture.mjs` **at HEAD** |
| `reviews/round7/r3-audio/shots-final/` | full 21-shot capture, `tools/capture.mjs` **as changed** |
| `reviews/round7/r3-audio/diff-ctrl-*.json` | pixel diffs between HEAD captures — the noise floor |
| `reviews/round7/r3-audio/diff-final-*.json` | pixel diffs, HEAD captures vs the changed one |

**Offline probe** — `OfflineAudioContext` plus a settable-clock facade over it.
`MusicEngine` and `Audio` only touch `currentTime`, the `create*` factories,
`destination`, `listener` and `sampleRate`, so the real classes can be driven on
a fake clock and rendered sample-exactly with no product edits. Measures
per-layer isolated RMS/peak with the bus disconnected, the *rendered*
`acidFilter.frequency` curve (automation recorded off a live `AudioParam` by
own-property shadowing, then replayed onto a bare param so the readback is what
WebAudio computes rather than what the source intends), hats per bar across the
8th/16th threshold, 50 ms window peak/RMS of the bed at I=0.10, bars completed
across three 0.6 s stalls, and music-vs-SFX levels through the real `Audio`
graph at the shipped defaults (`master 0.8, sfx 0.9, music 0.6` — `Menus.js:20-22`).

**Live probe** — headed Chromium with `--use-angle=d3d11` offscreen. (SwiftShader
renders a 24-monster arena at ~0.1 fps and `__HARNESS__.combat()` never resolves
under it; two runs were lost to that before switching.) Real gesture, 45 s idle
on the title screen, then `combat({enemies:24})` with the director enabled and
the mouse held, sampling engine internals, `limiter.reduction`, voice counts and
`performance.memory` at 2 Hz for 299 rows. `BaseAudioContext.prototype.create*`
and `AudioParam.prototype.*` are patched in an `addInitScript` before any module
loads, to count nodes and audit every parameter write.

### One methodology correction, recorded because it nearly shipped

My first three live runs are discarded and are not cited anywhere. In each of
them the player died partway through, which calls `MusicEngine.stop()` — so
every statistic after that point was a measurement of a **stopped sequencer**.
`mutedChurn: 0 nodes/s`, `stop() trace all zeroes` and `reduction: 0` all looked
like clean passes and were nothing of the sort. Worse, it hit the two arms
asymmetrically: one run had the before arm alive and the after arm dead, the
next had it the other way round, which would have produced a confident and
entirely fictitious comparison.

The probe now caps player damage at 0.001 inside a wrapper on
`Combat.applyDamage` — every hit still *lands*, so `playerHurt` still fires and
the duck and the voice cap are exercised for real — and records
`engineStoppedSamples` / `playerDeadSamples` so the hole cannot recur unseen.
Both cited runs report **0 and 0**.

---

# Fixes

## CRITICAL 1 — `playerHurt` dropped by the SFX voice cap

`Audio.js`. Three changes:

1. The music duck moved **above** the gate in `playerHurt` and is now
   unconditional. It costs no voices and it is the half of the cue that survives
   a busy mix; it had no business being gated on the budget the fight had just
   filled.
2. `_take(cost, priority)` is charged the node count the sound is about to
   spend, counted from each sound's own body (`shoot` 5, `explosion` 9, `zap` 7,
   `hit`/`impact`/`enemyVocal` 4, `footstep` 3, `death` 2). The gate is now in
   the same units as `_release`'s counter.
3. World SFX may not take the graph above `WORLD_VOICES`; `playerHurt`, `heal`,
   `shieldBreak` and `ability` pass `priority` and may spend the whole budget.
   The difference is a standing reservation nothing else can touch.

`MAX_VOICES` went 28 → 40 and `PRIORITY_RESERVE` is 10. That is a correction,
not a loosening: the old gate charged one per sound and counted one per node, so
it ran the graph to a *measured* 35 concurrent nodes and 28 was never the real
ceiling. Charging honestly at 28 would have cut the world budget from ~35 to 20
— I measured that intermediate state and refusals went from 658 to 2739 over the
same 150 s fight, i.e. it would have visibly thinned a firefight to fix a
different problem.

| metric (`before-live.json` / `after-live.json`, `mid`) | before | after |
|---|---|---|
| `_take()` refusals over 150 s of 20-23 enemy combat | **4893** (32.6/s) | **1389** (9.3/s) |
| peak `audio.voices` | 35 (25% over its own cap of 28) | 34 (inside a cap of 40) |
| `playerHurt(40)` at `voices = 40` → music duck | `0.192 → 0.192`, **moved: false** | `0.48 → 0.205`, **moved: true** |
| `playerHurt(40)` at `voices = 0` | moved: true | moved: true |

`hurtGate` in both files. The reproduction the critique gave now passes.

## MAJOR 2 — the ramp does not ramp; `acid` and `lead` never play

`Music.js`, three coupled numbers:

- `_scanSustain` scales to `Math.max(7, dir.populationCap * 0.5)` instead of a
  constant 7, and its coefficient is 0.9 rather than 0.58. A fixed `/7`
  saturated at seven monsters against a cap that starts at 18 and climbs past
  60, so the term could not tell seven from sixty.
- `arc` divides by 2.5 rather than 5, so `arc = 1` lands on "Fracturing"
  (`Director.js:53`) rather than "Collapse" — a difficulty a run reaches.
- The blend coefficient is 0.88 rather than 0.7. At 0.7, a maxed-out `pressure`
  with `arc` at zero produced `I = 0.70` *exactly* — the acid layer's entry
  threshold and not a decibel above it. The top of the arrangement was
  arithmetically unreachable, not merely hard to reach.
- The boss / teleporter floors moved 0.72 → 0.80 and 0.76 → 0.84 so they stay
  meaningful against the raised horde term, while still sitting below a
  genuinely full arena.

| 150 s of 20-23 enemy combat (`mid`) | before | after |
|---|---|---|
| `_sustain` | **0.58 in every one of 299 samples** | **0.90 in every sample** |
| `pressure` mean | 0.751 | 0.944 |
| `intensity` max / mean | 0.705 / 0.541 | **0.886** / 0.718 |
| `arc` max | 0.054 | 0.100 |
| layer max `acid` | **0.020** (of 0.55) | **0.49** — full |
| layer max `lead` | **0.000** | **0.467** — entered |
| layer max `perc` | 0.228 (of 0.42) | **1.98** — full |
| layer max `clap` | 0.62 — full | 3.50 — full |

`acid` and `lead` were the two layers that never sounded. Both now do, in a
stage-1 fight, without any difficulty-coefficient help.

## MAJOR 3 — the 303 filter envelope destroyed on slide notes

`Music.js`. The release is clamped so it can never cross the next step:
`t + Math.min(stepDur * 0.9, Math.max(0.05, dur * 0.8))`.

**The critique's preferred fix does not work, and I have the measurement.** It
recommended `fp.cancelScheduledValues(t)` before the write. I implemented that
first: rendered flat spot **105.7 ms → 105.7 ms**, unchanged
(`after-offline.json:acid` from that iteration). The reason is that this is a
*lookahead* scheduler — the next note is written up to 0.4 s before the previous
one is audible — so cancelling from `t` deletes the previous note's in-flight
ramp retroactively and re-creates exactly the flat spot it was meant to remove.
Clamping keeps the timeline in chronological order by construction, which is
what the defect actually needed.

| `acid`, rendered cutoff at I=1 | before | after |
|---|---|---|
| longest flat run in the cutoff curve | **105.7 ms** | **41.2 ms** (the legitimate hold at the base cutoff between notes) |
| slide note (`ACID_PATTERN` index 3), rendered | `4248 4248 4248 …` — flat wide open for a full step | `4232 4120 4010 … 1193 1180` — a full envelope |
| the accent after it | fires late | fires on time, `6908 → 1327` |

Traces in `before-offline.json:acid.trace` / `after-offline.json:acid.trace`
(2 ms resolution, t = 4.00–4.50 s).

## MAJOR 4 — the opening ceiling counted menu time

`Music.js` gains `reset()`; `update` only accumulates `_runT` when
`!ctx.paused`; `Audio.js`'s `stageStart` handler calls `reset()` when
`index === 0`. Both halves, because the pause gate alone would still carry time
from an unpaused pre-run state and `reset()` alone would still count menu time
inside a run.

| 45 s idling on the title screen, then starting a run | before | after |
|---|---|---|
| `_runT` at the end of the idle (`paused: true`) | **44.65 s** | **0.00 s** |
| `_runT` 6 s into the run | 54.5 s | 9.13 s |
| `intensity` 6 s into the run | **0.660** | **0.207** |
| layers up 6 s in | sub 0.85, pad 0.75, **kick 1.00, hat 0.62, bass 0.90**, openhat 0.25 | sub 0.75, pad 0.15, kick 0.27 — nothing else |

`ceilingIdle` / `ceilingAfter6s` in both files. The sequencer still runs under
the menus (352 → 357 steps across the idle); that is the pre-existing behaviour
the critique flagged as "may be intentional", and I left it — only the
accumulator underneath it was wrong.

## MAJOR 5 — pickup: doubled, always tier 0, and played on removal

Everything fixable inside `Audio.js` is fixed:

- `itemChanged(p)` replaces the bare `pickup(p?.tier ?? 0)` handler. `itemPickup`
  carries an **absolute** stack total (`Items.js:284`), so the direction is
  derived from the previous total: up is a pickup, down is a removal, unchanged
  is silence. `p.delta` is honoured if the emitter ever starts sending one.
- The tier is resolved from the id via `ITEM_BY_ID` and a `PICKUP_TIER` ladder,
  rather than waiting on a payload field that does not exist.
- `pickup()` throttles on a 40 ms key, which collapses the duplicate pair (10.6 ms
  apart) and the two events the blight transform fires for one card.
- Removal plays `deny()`.

| (`pickup` in both files; last field is **voices actually emitted**) | before | after |
|---|---|---|
| `give('bipod')` — common | `pickup(0)` ×2, **6 and 6 voices** | `pickup(0)` 6 voices, duplicate **0 voices** |
| `give('atg')` — uncommon | `pickup(0)` ×2, 6 and 6 | **`pickup(1)`** 8 voices, duplicate 0 |
| `give('behemoth')` — legendary | `pickup(0)` ×2, 6 and 6 | **`pickup(2)`** 11 voices (extra note + shimmer tail), duplicate 0 |
| `take('bipod')` — **removal** | `pickup(0)`, 6 voices — the reward jingle | **`deny()`** |

The probe counts emitted voices rather than calls, because the de-duplication
lives inside `pickup()` and a wrapper above it would report a silent call as if
it had played.

### What the item-system owner still has to change

The throttle is a stopgap that happens to be correct only because of call
ordering, and it should not be load-bearing. In `src/systems/Items.js`:

1. **Delete `this.ctx.audio?.play?.('pickup')` at `Items.js:266`** — the
   `itemPickup` event handler already covers it. Also `Items.js:261` (the
   blight-waiting branch of `give`) and `Items.js:220` (the client mirror),
   which are the same duplicate on the other two paths. My throttle survives
   only because `_set()` fires *before* the direct call, so the correct-tier
   event wins and the tier-0 one is dropped; reverse that order and the game
   goes back to tier 0 everywhere.
2. **Carry the tier and the delta on the wire**:
   `emit('itemPickup', { id, count: next, tier: def?.tier, delta })`. My
   `ITEM_BY_ID` lookup is a fallback, and it makes `Audio.js` import the item
   catalogue, which is a layering cost I would rather not keep.
3. `Items.js:798` calls `play('pickup', null, 2)` for equipment — a raw tier
   index that bypasses `PICKUP_TIER`. It should route through the same map.

Not fixed and needing a design call, not a code one: a blight card currently
plays the plain tier-0 reward jingle. It is a corruption and deserves its own
cue; I did not invent one.

## MAJOR 6 — 35 dB of layer imbalance

`Music.js`'s `maxGain` column is now solved from measured per-layer loudness:
each layer rendered in isolation at I=1 with the bus disconnected, then the gain
back-solved for a target balance relative to the kick. The kick comes *down*
rather than everything else coming up, so the bus peak is held.

| layer | before RMS | rel. kick | after RMS | rel. kick |
|---|---|---|---|---|
| `kick` | −17.91 | 0.0 | −23.93 | 0.0 |
| `clap` | −44.07 | **−26.2** | −29.20 | −5.3 |
| `bass` | −25.22 | −7.3 | −29.98 | −6.1 |
| `lead` | −47.47 | **−29.6** | −34.01 | −10.1 |
| `openhat` | −39.58 | −21.7 | −34.07 | −10.1 |
| `hat` | −38.43 | −20.5 | −35.93 | −12.0 |
| `acid` | −35.05 | −17.1 | −36.00 | −12.1 |
| `perc` | −53.48 | **−35.6** | −39.67 | −15.7 |
| `sub` | −38.25 | −20.3 | −37.85 | −13.9 |
| `pad` | −37.74 | −19.8 | −39.91 | −16.0 |
| **span** | **35.6 dB** | | **16.0 dB** | |

`layerIsolated` in both offline files. Every layer lands within 0.3 dB of its
target.

The bed is placed deliberately low (−14 / −16 rather than the −8 / −14 I first
tried). With the pad given a real sustain (below), a bed calibrated for presence
rendered the *opening* 3 dB hotter in RMS than the full arrangement — a ramping
soundtrack that ramped downwards. Measured and rejected, then re-solved.

## MAJOR 7 — music 9 dB under SFX, and compressed out by the shared limiter

Two changes in `Audio.js`:

- `MUSIC_BUS = 0.80` replaces the `0.32` literal, and it is now a named constant
  because three places wrote it (graph setup, `setMusicVolume`, and the
  `playerHurt` duck's restore target) and a drifting copy there silently
  restores the bus to the wrong level.
- **`sfx` gets its own limiter before the master** (−7 dB, 14:1). The master
  limiter drops to −3 dB / 12:1 and becomes a safety net on the sum rather than
  the thing shaping the mix. Explosions are now tamed where they are made
  instead of by dragging the soundtrack down with them.

| rendered at the shipped defaults (`musicLevel` / `sfxLevel`) | before | after |
|---|---|---|
| music, full tilt (I=1) | −33.28 RMS / −14.38 peak | **−30.53** / −11.31 |
| music, opening (I=0.10) | −41.02 RMS | **−38.24** |
| engine dynamic range, opening → full | 7.74 dB | **7.71 dB** (preserved) |
| explosions, 1/s | −23.13 RMS | −22.93 |
| **music-to-explosion RMS deficit** | **10.35 dB** | **7.60 dB** |

And the part that matters more, measured live at 2 Hz across the same combat
(`mid.reduction`):

| master limiter gain reduction | before | after |
|---|---|---|
| worst | **−12.16 dB** | **−0.74 dB** |
| mean | **−3.70 dB** | **−0.03 dB** |

The limiter took 3.7 dB of a 7.7 dB dynamic range on average and up to 12.2 dB
at its worst. It now takes essentially nothing.

## MODERATE 8 — the hat 8th/16th switch was not bar-quantised

`Music.js`: `this._hat16` is latched in `_onBar` with hysteresis
(on above 0.57, off below 0.53) and read at the emit site instead of `intensity`.

| hats per bar, intensity dithering ±0.02 around 0.55 (`hatFlicker`) | before | after |
|---|---|---|
| per-bar counts | `14 8 13 16 8 11 16 10 8 16 13` | `8 8 8 8 8 8 8 8 8 8 8` |
| clean bars (8 or 16) | **6 of 13** | **11 of 13** (the two are the partial first and last bars) |

## MODERATE 9 — resync zeroed the bar counter

`Music.js` snaps `_musicTime` forward by a whole number of steps and advances
`_step` by the same count, deriving `_bar = floor(_step / 16)`. The missed audio
is still discarded — that was the stated intent — but the phase and the 8-bar
progression survive. Restart lead is 0.05 s rather than 0.02 s (20 ms is inside
the output latency of an `interactive` context, so the first post-resync step —
a downbeat, with a kick on it — landed late). `LOOKAHEAD` is 0.4 s, which moves
the resync trigger from a ~0.36 s frame gap to ~0.51 s.

| offline: 12 s driven clock with three 0.6 s stalls (`resync`) | before | after |
|---|---|---|
| bars completed | **1** | **8** — one full `BAR_ROOTS` cycle |
| bar-counter rewinds | **3** | **0** |
| steps emitted | 120 | 124 |

Live over 150 s: bars completed 85 → 113 on near-identical step counts (1760 /
1794). Neither live arm hit a resync in this environment, so the stall test is
the load-bearing measurement here.

## MINOR 10 — the rest of the round-2 minors

All four are fixed; they are cheap and they are all in these two files.

**`_on()`'s fade-out tail now exists.** `_apply` records `L.until = t + ramp`
when a layer is committed to zero, and `_on(name, t)` is true until then, so a
layer keeps emitting notes through the half-bar fade instead of stopping dead on
the bar line it starts fading on. The half-bar ramp is no longer dead work.

**The bed is a bed.** `_osc` takes an optional `hold` (a fraction of `dur`)
giving attack/sustain/release, and the pad uses it — 22% attack, hold to 78%,
release across a length that overlaps the next bar's attack.

| 50 ms windows at I=0.10 (`bed`) | before | after |
|---|---|---|
| minimum window peak | **−180 dB** (a full window of digital silence) | **−65.2 dB** |
| median window peak | −34.1 dB | −33.9 dB |
| windows below −50 dBFS peak | **46 of 139** | **10 of 139** |

**`_impact` and `_riser` are scaled and routed.** `_impact` now goes through
`duck` rather than straight at the bus, so it participates in the pump like
everything else that is not the sidechain key, and both scale with intensity
(`0.25 + 0.45·I` and `0.12 + 0.22·I`) instead of firing the same ~25 dB
transient over a two-layer intro and a full arrangement alike.

**The sequencer stops when nothing can hear it.** `MusicEngine.silent`, set from
`Audio._syncMusicSilence()` on `setMuted` / `setMusicVolume` / graph build. The
intensity model keeps integrating, so the arrangement is in the right place the
moment sound returns; only `_schedule()` is skipped.

| muted **and** music volume 0, 4 s (`mutedChurn`) | before | after |
|---|---|---|
| sequencer steps emitted | **34** | **0** |

(The raw node count in that window is not a clean measure — it includes SFX from
enemies still attacking. The offline probe isolates it: 282 nodes in 4 s audible,
**0** silent, `after-offline.json:churn`.)

---

# `tools/capture.mjs` — the process fix

The harness never issued a user gesture, so no line of `Audio.js` or `Music.js`
had ever executed under it and `errorCount: 0` was not evidence about this
domain. It now presses `KeyZ` (unbound — `Input` reads only WASD, arrows, Space,
Shift, E/Q/R, Enter, Escape and Backspace), calls `thaw()` because every scenario
stops the engine loop before resolving, runs 90 frames, and records
`manifest.audio` + `manifest.audioOk`. A run with `stepsEmitted === 0`, or with
any console error raised during that window, exits non-zero.

**The gesture goes after the final shutter, and that placement is measured.**
My first version put it before the first scenario, which is where it belongs
logically. It changes the shots. Building the audio graph fills a two-second
white-noise buffer — ~96 000 `Math.random()` draws — off the same global
generator `data/abilities.js` and `main.js` draw from, so every unseeded visual
downstream lands somewhere else. A click and a keypress do it identically; it is
not the pointer, it is the entropy.

**Proof the shots are unchanged.** The capture is *not* byte-deterministic —
two runs of the unmodified harness differ on all 21 PNGs — so byte identity
cannot be the test. Instead: three captures with the **unmodified** harness
establish a noise floor from three pairwise pixel diffs, and the changed
harness is compared against all three.

| aggregate over 21 shots | mean abs. diff | % of pixels differing > 8/255 |
|---|---|---|
| control: HEAD vs HEAD (3 pairs) | 1.75 – 3.00 | 3.61 – 6.28 |
| **changed vs HEAD (3 pairs)** | **0.84 – 3.01** | **0.56 – 6.39** |
| rejected early-gesture version, vs HEAD | 3.74 – 3.89 | 8.16 – 8.35 |

Per shot, 19 of 21 sit entirely inside the control band. The two that do not
are `08-explosion` (control 21.42–31.32%, changed 1.56–31.98%) and
`10-inventory` (control 13.78–22.90%, changed 2.40–24.30%) — both exceed the
control *maximum* by 0.7 and 1.4 percentage points while their *minimum* is far
below the control minimum, which is the signature of scatter on two already
highly variable particle shots rather than a shift. For contrast, the rejected
early-gesture version put `01-title` at 4.74–7.90% against a control of
0.10–2.08%, and `14-survivor-select` at 1.70–2.67% against 0.01–0.46%. The
final version puts them at 0.00–1.41% and 0.00–0.26%.

Numbers from `diff-ctrl-*.json` and `diff-final-*.json`.

**The gate was proved to fail.** With `throw new Error(...)` injected at the top
of `MusicEngine._schedule`, a capture reports `stepsEmitted: 0`, `audioOk: false`,
prints `AUDIO FAILURE`, and exits 1 — with `subjectsOk: true` and all 21 images
present and plausible, which is exactly the state that reached a human in round 1.
The sabotage was reverted and the build re-verified.

**What this does not cover, stated plainly:** the SFX catalogue. Its entry points
are gameplay events that only fire during scenarios, and holding the audio graph
open across the shots is the thing measured above as unacceptable. This catches
the round-1 class of defect — an audio system that is dead or throwing every
frame — and not a bug confined to, say, `Audio.explosion`.

---

# Clean areas re-verified after the changes

Round 2 certified these; each is something my changes could plausibly have
broken, so each was re-measured on both arms.

| | before | after |
|---|---|---|
| non-finite / illegal `AudioParam` writes | 0 of 264 569 | **0 of 277 076** |
| `exponentialRampToValueAtTime(0, …)` | 0 | 0 |
| thrown exceptions from automation | 0 | 0 |
| console + page errors, whole run | 0 | **0** |
| JS heap over 150 s (MB) | min 91 / max 126, no trend | min 92 / max 126, no trend |
| `setMuted(true)` → master | 0.0007 | 0.0004 |
| `setMasterVolume(0.5)` **while muted** | 0 (stays muted) | 0 (stays muted) |
| then `setMuted(false)` | 0.5 (not the old 0.85) | 0.5 |
| `setMusicVolume(0.2)` → music bus | 0.06425 (= 0.2 × 0.32) | 0.16073 (= 0.2 × 0.80) |
| `setMusicVolume(0)` → music bus | 0.00013 | 0.00022 |
| `suspend()` → steps frozen, no burst on resume | 1854 → 1864 → 1870, lead 0.346 | 1849 → 1860 → 1865, lead 0.411 |
| `stop()` envelope | monotone 0.843 → 0.160 | monotone 0.410 → 0.079 |
| sidechain duck automation | non-overlapping by construction (`rel` capped below one beat) — unchanged, no edit near it |

The duck-overlap proof is the one item I did not independently re-derive: I did
not touch `_kick`'s automation or the `rel` cap, so round 2's rendered
verification still stands. Named here rather than silently inherited.

---

# Arms I did **not** test

Stated explicitly, because round 2's lesson was that a fix verified against the
arm it was reported in leaves the other arm live.

1. **Boss and teleporter-charging intensity floors.** I raised them 0.72 → 0.80
   and 0.76 → 0.84 to keep them meaningful against the raised horde term. My
   live scenario is a horde fight; neither `dir.boss.alive` nor
   `progression.state === 'charging'` was true in any of the 299 samples. The
   change is arithmetic and small, but it is untested at runtime.
2. **A run past stage 1.** Both live arms are a stage-1 fight with
   `difficultyCoefficient` reaching 1.25. `arc` is the term I retuned for the
   *late* run and it only reached 0.10 here. `arc = 1` at difficulty 3.5 is a
   calculation, not a measurement. Nothing verifies how the mix sits at stage 4
   with `arc` dominant.
3. **`MusicEngine.reset()` on a real stage-1 `stageStart`.** The live probe
   reaches the run through `__HARNESS__.combat()`, which does raise `stageStart`
   — `_runT` was 9.13 s six seconds in, so the reset demonstrably fired — but I
   did not test a `stageStart` with `index > 0` (which must *not* reset) nor a
   second run in the same page.
4. **A multiplayer client.** `Items.js:220`'s client mirror calls
   `play('pickup')` on every replicated `itemPickup`, which my throttle also
   collapses. I did not run a networked session; the analysis is static.
5. **`--software` capture.** Every capture cited here is the GPU path. The
   `KeyZ` gesture and the `thaw()` + `frames(90)` window are renderer-agnostic,
   but the SwiftShader path's much longer frames are untested against them.
6. **Real playback.** Everything here is rendered or introspected, never heard.
   The layer balance targets are my judgement about what a techno mix should be;
   the measurements only prove the mix now *is* what the table says it is.
7. **`ambient` bus levels.** Untouched and unmeasured — round 2 raised nothing
   about them and I did not go looking.

---

# Not fixed, with reasons

- **The `itemPickup` emit sites.** `Items.js` is not mine this round. The
  required changes are enumerated under MAJOR 5.
- **A dedicated cue for blight cards.** A corruption playing the reward jingle
  at tier 0 is better than the previous state but is not right. It needs a
  sound designed, which is a design call rather than a defect fix.
- **`Audio.js` importing `data/items.js`.** A layering cost I accepted so the
  tier could be correct without waiting on the emitter. It should be reverted to
  reading `p.tier` once the payload carries it.
- **The sequencer running under the menus.** 357 steps accumulate while the
  title screen is paused. Round 2 flagged it as "may be intentional" and it is
  outside what the defect list asked for; only the `_runT` accumulation
  underneath it was wrong, and that is fixed.
- **The `06-loaded-hud` subject failure.** Pre-existing, recorded in
  `E-framing.md` §5, unchanged: identical failing check (`monsters under load`,
  `#0@8px #1@7px`) across all four captures.

---

# Build and capture

- `node node_modules/vite/bin/vite.js build` → `✓ built in 1.21s`, only the
  pre-existing 500 kB chunk warning.
- Full 21-shot capture (`reviews/round7/r3-audio/shots-final/`): 21/21 shots,
  `ready: true`, `clockPinned: true`, `frameTimeouts: 0`, `errorCount: 1` (the
  harness's own `console.error` for the known `06-loaded-hud` check — identical
  in all three HEAD control captures), `audioOk: true` with `stepsEmitted: 288`
  and no errors in the audio window, `subjectsOk: false` with the single
  pre-existing `06-loaded-hud` failure. Exit code 1, which is what that one
  failing check has always produced.

Throwaway probe scripts were deleted; the raw JSON, the four capture directories
and the pixel diffs remain under `reviews/round7/r3-audio/`.
