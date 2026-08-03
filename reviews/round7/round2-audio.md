# Round 7 — round-2 critique: audio (`Music.js`, `Audio.js`)

Branch `round7/content-and-polish`, HEAD `75f87d6`. Read-only; nothing in `src/` was modified.
Scope: `src/systems/Music.js` (new, 656 lines), `src/systems/Audio.js` (modified, +388/−113),
and their integration points (`Engine`, `Combat`, `Items`, `Director`, `Progression`, `Menus`).

Verdict up front: **FAIL against the stated bar.** The round-1 CRITICAL is genuinely fixed. But
the soundtrack the writeup describes is not the one that plays: measured live over three minutes
of continuous 22-enemy combat, **two of its ten layers never sound at all**, the intensity model
parks at a flat `I≈0.433` for the whole engagement, the 303 line's filter envelope is destroyed on
19% of its notes, and — the one that would fail cert on its own — **the player-damage cue is
silently dropped ~9.6 times a second by the SFX voice cap during exactly the fights it exists for.**

---

## Methodology

Everything below came from instrumented Playwright runs against the real dev server. Five
throwaway probes were written, run, and **deleted** before submitting; their raw output is
retained on disk so every number here is checkable:

| artifact | what produced it |
|---|---|
| `reviews/round7/r2-audio/offline.json` | offline-render probe 1 (port 5261) |
| `reviews/round7/r2-audio/offline2.json` | offline-render probe 2 (port 5262) |
| `reviews/round7/r2-audio/live.json`, `live-errs.json` | 180 s live gameplay probe (port 5263) |
| `reviews/round7/r2-audio/live2.json`, `live2.log` | targeted live probe (port 5264) |
| `reviews/round7/r2-audio/live3.json` | pickup fan-out probe (port 5265) |

Techniques, so they can be rebuilt:

1. **Offline reproduction of the real sequencer.** `MusicEngine` only touches its `ac` for
   `currentTime` and the five `create*` factories, so it can be driven on a fake clock inside an
   `OfflineAudioContext`: pass a shim with a settable `currentTime` getter, pin `intensity`/`bpm`,
   call `_schedule()` once per simulated 1/60 s frame, then `startRendering()`. This renders the
   **actual product code**, sample-exact, with no product edits — layer levels, envelopes,
   automation collisions and mix balance all come out as real PCM.
2. **AudioParam automation replay.** Own-property shadowing on a live `AudioParam` instance
   (`p.setValueAtTime = …`) records every automation write with its arguments and time. The
   recorded list is then replayed onto a bare `GainNode.gain` in a fresh offline context and
   rendered, which reads back **what WebAudio actually computes** for that timeline rather than
   what the source intends. Used on `duck.gain` and `acidFilter.frequency`.
3. **Layer isolation.** Leaving the music bus disconnected and tapping one layer's `GainNode`
   straight to the destination. (My first attempt kept the bus connected and was contaminated by
   `_riser`/`_impact`/`_downlifter`, which write to `duck`/`bus` directly and bypass every layer
   gain — that run is discarded; only `offline2.json:layerIsolated` is cited.)
4. **Live 180 s run.** `?harness=1`, `__HARNESS__.combat({enemies:24})` then `thaw()` and
   `director.enabled = true`, real `page.mouse.click` to satisfy the autoplay gate, sampling
   engine internals + `limiter.reduction` + `performance.memory` at 2 Hz for 346 rows.
   `BaseAudioContext.prototype.create*` and `AudioParam.prototype.*` patched in an
   `addInitScript` before any module loads, to count nodes and audit every parameter write.
5. **Build gate.** `node node_modules/vite/bin/vite.js build` → `✓ built in 37.05s`, only the
   pre-existing 500 kB chunk warning.

Browser flags followed `tools/apicheck.mjs` (`headless:false` + offscreen window +
`--use-angle=d3d11`), which is this repo's working pattern, not swiftshader.

**Not run:** `tools/capture.mjs`. It is a screenshot harness and it never issues a user gesture,
so `Audio._ensure()` never runs and no audio code executes under it at all — it cannot report on
this domain. (That is itself a testing-gap note, see *Observations*.)

**Inconclusive, and not cited as evidence anywhere below:**

- Whether `_heat` saturates in a real player-driven fight. In my scenario `_heat` decayed to 0.000
  from t≈74 s onward while 22 enemies were still alive, which means the harness stopped generating
  `damage` events; I cannot separate "the model's fast term is inert" from "my scenario stopped
  fighting". The `_scanSustain` saturation in finding #2 is measured and does not depend on this.
- Absolute resync frequency on a real machine. My environment ran at a median 28.3 ms/frame with a
  500.7 ms worst frame (`live2.json:fps`), which is slower than a shipping target. Finding #9 is
  therefore stated as a *tolerance* defect with a measured consequence in this environment, not as
  a claim about frame rates elsewhere.

---

## Round-1 finding #1 — verified fixed at runtime

`reviews/round7/D-bugs.md` #1: *"Music never plays: `Audio.js` throws every frame on a missing
import."* The import at `Audio.js:2` now reads `import { clamp } from '../core/MathUtil.js'` and
`lerp` moved into `Music.js:1`. That is the line-level fix; it also holds in the running game:

- Cold boot, before any gesture: `musicEngine` absent, `ready:false` (correct — autoplay gate).
- After one real `page.mouse.click`: `ready:true`, `ac.state:"running"`, `stepsEmitted:1`, growing
  to **330 steps in 45 s** (`live2.json:coldBoot`, `live2.json:ceiling`).
- 180 s live run: `stepsEmitted` 0 → 1326, layer gains non-zero throughout
  (`live.json:mid.rows`).
- **Console + page errors across both live probes: 0** (`live-errs.json` is `[]`, `live2.log`
  reports `ERRORS 0`).

CONFIRMED fixed. Round 2 found no new throw-every-frame class of defect: 98 495 offline and all
live `AudioParam` writes audited, **0 non-finite arguments, 0 `exponentialRampToValueAtTime(0,…)`,
0 thrown exceptions** (`offline.json:paramAudit`, `live.json:mid.aud`).

---

# Findings

## CRITICAL 1 — The player-damage cue and its music duck are silently dropped ~9.6×/second in heavy combat

**`src/systems/Audio.js:246-248`** (`_take`), **`:250-253`** (`_release`), **`:594-609`**
(`playerHurt`), and the same gate on `:357` `shoot`, `:466` `explosion`, `:632` `heal`,
`:644` `shieldBreak`, `:705` `ability`, `:557` `death`.

```js
_take() { return this.voices < MAX_VOICES; }          // 246-248, MAX_VOICES = 28
_release(node) { this.voices++; … }                    // 250-253, once per NODE
…
playerHurt(amount = 0) {
  const ac = this._ensure();
  if (!ac || !this._take()) return;                    // 596 — bails before the sound AND the duck
  …
  if (this.music) { …cancelScheduledValues… }          // 603-608 — never reached
}
```

The cap is checked **once per sound** but the counter is incremented **once per node**, and one
"sound" is 4–11 nodes (`explosion` alone emits 5 + 2–4 debris ticks). So the counter routinely
blows past its own ceiling and then refuses everything until it drains.

**Measured, 180 s of live 22-enemy combat** (`live.json`):

| metric | value |
|---|---|
| `_take()` returned false | **1720 times** (≈9.6 refusals/second) |
| peak `audio.voices` | **35** — 25% over `MAX_VOICES = 28` |
| `audio.voices` sampled ≥ 25 | 118 of 346 samples (34% of the run) |

**Direct reproduction** (`live2.json:hurtGate`) — force the arena-busy state and call the hook:

```
a.voices = 40; a.playerHurt(40)  ->  music.gain 0.192 -> 0.192   moved: false
a.voices =  0; a.playerHurt(40)  ->  music.gain 0.192 -> 0.08193 moved: true
```

With the counter high, `playerHurt` produces **nothing at all**: no hurt sound, and no music duck.
This is corroborated independently in `live.json:exp.deadThenHurt`, where a `playerHurt(30)` issued
during a live fight left `music.gain` decaying undisturbed (0.00108 → 0.00011, exactly the
`setTargetAtTime(0, τ=0.5)` curve continuing).

Why this is critical rather than major: in a horde roguelike the "I am taking damage" cue is the
player's primary off-screen threat signal, and this drops it *selectively in the busiest fights* —
the one situation where the visual channel is also saturated. RoR2 solves the same problem by
giving player-feedback sounds a reserved, non-stealable bus. The design note at `Audio.js:23-26`
correctly argues that a refusing cap must never be allowed to delete the downbeat, and then applies
that same refusing cap to the player's own damage.

**Fix.** Two parts, both small:
1. Exempt player-feedback sounds from the cap the way the music already is — move the
   `playerHurt` / `playerDead` / `levelUp` / `shieldBreak` bodies above the `_take()` check (or
   give them a `_release`-only path), and hoist the `this.music` duck block at `Audio.js:603-608`
   above the guard at `:596` regardless.
2. Make the cap honest about its own units: either charge `_take()` the node count the sound is
   about to spend (`_take(n)` → `this.voices + n <= MAX_VOICES`) or count sounds rather than nodes.
   As written, `peakSfxVoices` overshooting to 35 means the effective cap is unpredictable.

---

## MAJOR 2 — Two of the ten layers never play; the intensity model parks at I≈0.43 in a real fight

**`src/systems/Music.js:242-261`** (`_scanSustain`), **`:205`** (`arc`), **`:227`** (the blend),
against the layer table at **`:56-67`**.

180 s of continuous combat with 22–24 enemies alive the entire time, measured maxima
(`live.json:mid.rows`, 346 samples):

```
                  reached      needed for entry   needed for max gain
  clap    0.620   (yes)        I >= 0.52          I >= 0.64
  perc    0.141   partial      I >= 0.64          I >= 0.76
  acid    0.000   NEVER        I >= 0.70          I >= 0.84
  lead    0.000   NEVER        I >= 0.86          I >= 0.98

  intensity  min 0.173  max 0.692
  arc        min 0.002  max 0.052      (difficultyCoefficient 1.01 -> 1.26)
  _sustain   min 0.580  max 0.580      <- pinned, every single sample
  pressure   min 0.580  max 1.000
```

The steady state is a *flat line*: rows from t=113 s to t=150 s read `I = 0.433, 0.434, 0.433,
0.433, 0.435, 0.435` — 37 seconds of maximum-density combat producing an intensity that does not
move by 0.003. "A techno bed that answers the fight" is measurably not answering.

Two independent causes, both structural:

**(a) `_scanSustain` saturates at seven enemies** (`Music.js:253`):

```js
s = Math.min(near / 7, 1) * 0.58;      // 45u radius
```

With 22 enemies in the arena the term is pinned at its ceiling of 0.58 in every one of 346
samples. It cannot distinguish seven monsters from sixty, and `Director.populationCap` is far
higher than seven. The boss (`:258`) and teleporter-charging (`:259`) floors are the only things
above 0.58, so outside those two set-pieces `pressure` has an effective ceiling of 0.58 plus
whatever transient `_heat` supplies.

**(b) `arc` cannot contribute on any realistic timescale** (`Music.js:205`):

```js
this.arc = clamp(((ctx.director?.difficultyCoefficient ?? 1) - 1) / 5, 0, 1);
```

`arc = 1` requires `difficultyCoefficient = 6` — `DIFFICULTY_NAMES` calls that "Collapse"
(`Director.js:55`). Measured growth in my run was 1.01 → 1.26 over 180 s (~0.0015/s), i.e.
`arc` moved from 0.002 to 0.052. Feeding that into `I = arc + (1-arc)·pressure·0.7`
(`Music.js:227`) with `pressure = 0.58` gives `I = 0.052 + 0.948·0.406 = 0.437` — which is exactly
the 0.433–0.435 observed. The arithmetic and the measurement agree.

Consequence: `acid` needs `I ≥ 0.70`, which needs `pressure ≥ 0.986` at low `arc`. `lead` needs
`I ≥ 0.86`, which at `pressure = 1` needs `arc ≥ 0.533`, i.e. `difficultyCoefficient ≥ 3.67` —
stage 4-plus territory. The two layers the writeup presents as the top of the arrangement are
unreachable for the great majority of a run, and `perc` peaked at a third of its level. The
writeup's layer table (A-audio.md §Arrangement) was validated by *forcing* `intensity`; it was
never validated against what the game produces.

**Fix.** Raise the saturation point and give `pressure` real headroom above the horde floor:
- `Music.js:253` — scale to the director's actual population, e.g.
  `Math.min(near / Math.max(7, dir.populationCap * 0.45), 1)`, and lift the coefficient from 0.58
  toward ~0.85 so a full arena alone can reach the upper layers.
- `Music.js:205` — divide by a coefficient the run actually reaches. `(dc - 1) / 2.5` maps
  `arc = 1` onto "Straining"/"Fracturing" instead of "Collapse".
- Then re-derive the `enter` column at `:56-67` against a *measured* `I` distribution rather than
  an assumed 0→1 sweep. The current table is calibrated for an input range the game never spans.

---

## MAJOR 3 — The acid line's filter envelope is destroyed on every slide note (3 of 16 steps, every bar)

**`src/systems/Music.js:520-527`**

```js
const dur = stepDur * (note.s ? 1.9 : 0.92);     // 497
…
const fp = this.acidFilter.frequency;
fp.setValueAtTime(top, t);                                            // 525
fp.exponentialRampToValueAtTime(base, t + Math.max(0.05, dur * 0.8)); // 527
```

For a slide, `dur·0.8 = 1.52 · stepDur` — the ramp is scheduled to *end* half a step after the next
note has already written its own `setValueAtTime`. The events go onto the shared
`acidFilter.frequency` timeline out of chronological order. `ACID_PATTERN` (`:87-92`) has `s:1` at
indices **3, 7 and 10**, so this happens three times per bar, deterministically, every bar the
acid layer is audible.

**Recorded automation, verbatim from a live `AudioParam` at I=1** (`offline.json:acid.head`,
`[method, value, time]`):

```
setValueAtTime                4248   2.1570      <- step 3, the SLIDE note
exponentialRampToValueAtTime  1180   2.3176      <- its ramp ends at 2.3176
setValueAtTime                7000   2.2627      <- step 4 (an ACCENT) starts at 2.2627, BEFORE that
exponentialRampToValueAtTime  1180   2.3404
```

**Rendered result** — the recorded list replayed onto a bare `AudioParam` and rendered by Chrome's
own automation engine (`offline.json:acid.trace2s`, 2 ms resolution, values in Hz):

```
t=4.05..4.14  4142 4008 3878 ... 1443 1265 1184 1180     <- normal note: 4142 -> 1180, the 303 "wow"
t=4.16..4.25  4117 3984 3855 ... 1388 1257 1180          <- normal note, same shape
t=4.26..4.37  4248 4248 4248 4248 4248 4248 4248 4248    <- SLIDE note: FLAT for 123 ms. No envelope.
t=4.37        6859 6429 6025 ...                          <- the accent finally fires, late
```

The slide note gets **no filter movement at all** — the cutoff parks wide open at 4248 Hz for more
than a full step, which is both brighter and louder than every note around it, and the accent that
follows it starts late. A resonant filter envelope *is* the 303; the source comment at `:168-170`
argues correctly for one persistent filter and then does not defend that filter's shared timeline.
At 142 bpm this is ~3.5 mangled notes per second whenever the acid plays.

**Reproduce:** record `eng.acidFilter.frequency`'s automation methods, drive `_schedule()` with
`intensity = 1` for 8 s, replay the log onto a `GainNode.gain` in an `OfflineAudioContext`, render.

**Fix.** One line, either of:
- `fp.cancelScheduledValues(t);` immediately before `Music.js:525`; or
- clamp the ramp so it can never cross the next step:
  `fp.exponentialRampToValueAtTime(base, t + Math.min(stepDur * 0.9, Math.max(0.05, dur * 0.8)));`

The `cancelScheduledValues` form is preferable — it also makes the envelope correct if the
sequencer ever emits two acid notes in the same lookahead window out of order.

---

## MAJOR 4 — The "opening ceiling" is keyed to AudioContext age, not to run start

**`src/systems/Music.js:129`** (`this._runT = 0` in the constructor), **`:202-203`**
(`this._runT += d`), **`:234`**:

```js
I = Math.min(I, 0.10 + this._runT / 60 * 0.70);
```

`_runT` starts when `Audio._ensure()` builds the `MusicEngine` — which happens on the **first user
gesture anywhere on the page** (`Audio.js:75-83`), typically the click that opens the survivor
select or the difficulty screen, not the click that begins the run. And `Engine._frame` runs
`update` unconditionally (`Engine.js:210` — the `!ctx.paused` guard only wraps `fixedUpdate`), so
`_runT` accumulates through every menu.

**Reproduced** (`live2.json:ceiling`): unlock audio with one click, then idle 45 s on the title
screen without starting a run:

```
after 45s on the title screen (paused: true):
  _runT     = 41.8
  ceiling   = 0.10 + 41.8/60*0.70 = 0.587      <- already lifted, run not started
  steps     = 330                              <- the sequencer ran the whole time

then begin the run; 6 seconds in:
  I = 0.514
  sub 0.85  pad 0.75  kick 1.00  hat 0.62  bass 0.90  openhat 0.283
```

Six seconds into the run the player has the kick, the hats, the bassline and half the open-hat.
The brief and `A-audio.md` are explicit that the first minute must be a sub pulse and a pad; that
holds only for a player who clicks *straight* into a run. Any player who reads the survivor cards
for 45 seconds gets a completely different opening, and there is no reset anywhere — `_runT` is
never zeroed on `stageStart` or on run begin.

Secondary consequence visible in the same data: **the sequencer emitted 330 steps while paused on
the title screen**, i.e. the `sub`/`pad` bed plays under the menus at `I = 0` with no separate menu
cue and no fade-in. That may be intentional; the `_runT` accumulation underneath it is not.

**Fix.** Zero `_runT` at run start rather than at context creation. `Audio.init` already listens
for `stageStart` (`Audio.js:105-110`) and already calls `musicEngine.cool()` there — add a
`reset()` on `MusicEngine` that sets `_runT = 0` (and `_bar = 0`) and call it from the
`stageStart` handler when `index === 0`. Alternatively gate the accumulator:
`if (!ctx.paused) this._runT += d;` at `Music.js:203`, which also stops menu time counting.

---

## MAJOR 5 — Every item pickup plays two identical jingles 10.6 ms apart, always at tier 0, and *removing* an item plays it too

**`src/systems/Audio.js:101`**, **`:951`**; **`src/systems/Items.js:265-266`**, **`:284`**,
**`:326-327`**, **`:344`**.

Two independent paths reach `Audio.pickup()` for the same event:

```js
// Items.js:265-266  — give()
const next = this._set(id, (this.counts.get(id) || 0) + count);
this.ctx.audio?.play?.('pickup');            // -> Audio.js:951 -> this.pickup(undefined ?? 0)

// Items.js:284 — _set(), the single mutation point for give / take / corruption
this.ctx.events.emit('itemPickup', { id, count: next });

// Audio.js:101
e.on('itemPickup', (p) => this.pickup(p?.tier ?? 0));   // payload has no `tier`, ever
```

**Reproduced live** (`live3.json`), `Audio.pickup` wrapped to log `(tier, ac.currentTime)`:

```
items.give('bipod', 1)          (common)     -> pickup(0) @3.9307, pickup(0) @3.9413   [2 calls, 10.6 ms apart]
items.give('atg', 1)            (uncommon)   -> pickup(0) @3.9413, pickup(0) @3.9520   [2 calls]
items.give('behemoth', 1)       (LEGENDARY)  -> pickup(0) @4.0107, pickup(0) @4.0213   [2 calls, still tier 0]
items.take('bipod', 1)          (REMOVAL)    -> pickup(0) @4.0213                      [1 call]
items.give('spasm-gland', 1)    (blight)     -> pickup(0) x4 across 4.0613..4.2320     [4 calls]
```

Three defects in one:

1. **Doubled.** `pickup()` is fully deterministic — no `Math.random`, no `_variant` — so the two
   calls emit *bit-identical* waveforms 10.6 ms apart. That is textbook comb filtering (first null
   near 47 Hz, then every odd multiple), so the "reward" jingle is hollow and phasey rather than
   twice as loud. This is the single most-heard reward cue in the game.
2. **Tier is never passed.** The `itemPickup` payload is `{ id, count }` (`Items.js:284`) and
   `play('pickup')` is called with no argument, so `pickup(tier)` is always `pickup(0)`. All six
   tiers that exist — `blight, common, uncommon, legendary, boss, lunar` (`live3.json:tiersSeen`)
   — sound identical. `Audio.pickup`'s tier-scaled base pitch, its 4th/5th note
   (`n = 3 + Math.min(2, tier)`, `Audio.js:657`) and its `tier >= 2` shimmer tail (`:668-670`) are
   **unreachable dead code**. In a roguelike, "what tier did I just pick up" is a core read.
3. **Removal plays the pickup jingle.** `take()` goes through `_set()` → `itemPickup`
   (`Items.js:344`), so losing an item plays a rising major arpeggio. The blight corruption path
   (`Items.js:326-327`, two `_set` calls) fires four jingles in 170 ms for one card that *deletes*
   part of the inventory.

**Fix.**
- Delete the `this.ctx.audio?.play?.('pickup')` at `Items.js:266` (the event handler already
  covers it), and carry the tier on the wire: `emit('itemPickup', { id, count: next, tier: def?.tier, delta })`.
- `Audio.js:101` — map the tier string to an index and gate on direction:
  `e.on('itemPickup', (p) => { if ((p?.delta ?? 1) > 0) this.pickup(TIER_INDEX[p?.tier] ?? 0); })`.
- Give removal its own cue (`deny()` already exists at `Audio.js:878`).

---

## MAJOR 6 — The layer mix is a kick with decoration; the `maxGain` column does not describe the balance

**`src/systems/Music.js:56-67`** (the table) versus the per-note gains in `_kick` (`:460-478`),
`_clap` (`:480-492`), the `perc` block (`:431-437`) and the `lead` block (`:445-453`).

Per-layer isolated render, `intensity = 1`, 10 s, layer tapped straight off its own `GainNode`
with the bus disconnected so risers/impacts cannot contaminate (`offline2.json:layerIsolated`):

| layer | `maxGain` in the table | measured RMS | measured peak | RMS below kick |
|---|---|---|---|---|
| kick | 1.00 | **−17.9 dB** | +1.9 dB | — |
| bass | 0.90 | −25.2 dB | −4.7 dB | 7 dB |
| acid | 0.55 | −35.1 dB | −9.8 dB | 17 dB |
| pad | 0.75 | −37.9 dB | −16.4 dB | 20 dB |
| hat | 0.62 | −38.3 dB | −7.4 dB | 20 dB |
| sub | 0.85 | −39.5 dB | −10.6 dB | 22 dB |
| openhat | 0.50 | −39.8 dB | −13.0 dB | 22 dB |
| clap | 0.62 | −44.2 dB | −15.1 dB | **26 dB** |
| lead | 0.45 | −47.1 dB | −18.1 dB | **29 dB** |
| perc | 0.42 | −53.4 dB | −20.5 dB | **35 dB** |

The table reads like a balanced mix (kick 1.00 against clap 0.62 against lead 0.45) and the actual
signal is not one. A clap 26 dB under the kick is inaudible; a techno clap normally sits within
3–6 dB of it. `lead` — the layer the arrangement builds toward, which finding #2 shows never
arrives anyway — is 29 dB down. `perc` is 35 dB down, i.e. below the noise floor of anything else
playing. And these numbers *flatter* the non-kick layers: in the real graph everything except the
kick also passes through `duck` (`Music.js:163`), which the kick stamps down by up to 0.66
(`:470`), so in situ the gap is up to 9 dB worse.

Root cause is that `maxGain` scales a layer whose intrinsic energy was never normalised: `_kick`
stacks a 0.95 sine, a 0.28 triangle and a 0.22 noise burst with a 360 ms tail at 46–165 Hz, while
`_clap` is three 20 ms noise bursts at 0.35 and one 170 ms body at 0.5 through a Q=1.1 bandpass.
The former has roughly two orders of magnitude more energy before the layer gain is applied.

**Fix.** Calibrate `maxGain` against measured per-layer loudness rather than intuition — render
each layer in isolation (the harness above), target roughly `kick 0 dB / clap −5 / bass −6 /
openhat −10 / hat −12 / acid −12 / lead −10 / perc −16 / pad −14 / sub −8` relative RMS, and back
out the gains. As a first pass that is roughly `clap 0.62 → 3.5`, `perc 0.42 → 5.0`,
`lead 0.45 → 4.0`, `pad 0.75 → 2.5`, then pull `kick` down to hold the bus peak where it is.

---

## MAJOR 7 — The soundtrack is 9 dB under the SFX bus and is compressed out by the shared limiter during combat

**`src/systems/Audio.js:144-150`** (bus gains), **`:130-136`** (the limiter).

```js
this.sfx.gain.value   = this.sfxVolume  * 0.9;    // 145  -> 0.81 at defaults
this.music.gain.value = this.musicVolume * 0.32;  // 149  -> 0.192 at defaults
…
limiter.threshold.value = -8; limiter.ratio.value = 18;   // 131-133, on the shared master
```

Rendered at the real bus gains and the shipped default settings (`master 0.8, sfx 0.9,
music 0.6` — `Menus.js:20-22`), which cancels the master term (`offline2.json`):

| source | peak | RMS |
|---|---|---|
| music, full tilt (I=1) | −12.2 dB | −31.2 dB |
| music, opening (I=0.10) | −19.3 dB | **−39.1 dB** |
| sustained fire, 10 rps | −4.0 dB | −29.9 dB |
| hit confirms, 5/s | −9.6 dB | −33.9 dB |
| explosions, 1/s | **+2.2 dB** | **−19.8 dB** |

So a firefight with explosions is **11.4 dB louder in RMS than the music at full tilt** and 19.3 dB
louder than the opening. And the SFX peak of +2.2 dB is 10 dB over the limiter's −8 dB threshold on
the shared master, so the limiter pulls *everything*, music included, down whenever the fight is
loud.

**Measured live, not inferred** — `limiter.reduction` sampled at 2 Hz across the 180 s combat run
(`live.json:mid.rows[].red`):

```
range           -0.02 dB .. -14.12 dB
typical combat  -3 to -7 dB, continuously
```

Net effect: the intensity engine's entire dynamic range from sparse opening to full tilt is
**+7.9 dB of music RMS**, and the limiter alone takes 3–14 dB of that back during the fight the
build exists to score. All of finding #2's arrangement work, and finding #6's balance work, is
being applied to a signal the player cannot hear when it matters.

**Fix.** Two changes, in order:
1. Raise the music bus. `0.32` against an SFX bus of `0.9` is a 9 dB structural deficit; `0.55–0.6`
   is the region where the two are comparable at the defaults. Verify against the rendered numbers
   above rather than by ear on one machine.
2. Stop the limiter doing double duty. Either give SFX its own limiter before the master (so
   explosions are tamed without dragging the music down) or drive the existing master duck from the
   SFX bus level rather than only from `playerHurt`. The `playerHurt` duck at `Audio.js:602-608`
   already proves the plumbing; it just fires on one event instead of on programme level.

---

## MODERATE 8 — The hi-hat 8th↔16th switch is the one arrangement change that is not bar-quantised

**`src/systems/Music.js:397`**

```js
if (this._on('hat') && (I > 0.55 ? true : s % 2 === 0)) {
```

`_onBar`'s doctrine (`:303-310`) is that arrangement changes only happen on downbeats, because "a
hat fading in over the middle of a bar arrives on a random 16th and sounds like a fault". This line
reads `this.intensity` live, per 16th, and flips the whole hat density mid-bar.

**Reproduced** (`offline.json:hatFlicker`) — hats counted per bar while intensity dithers ±0.02
around 0.55 on a 6 s sine, 21 bars:

```
14  8 13 16  8 11 16 10  9 16 12  8 15 15  8 12 16  9 10 16
```

Only 10 of 21 bars are clean (8 = eighths, 16 = sixteenths). The other 11 are 9–15, i.e. the
density changed **inside the bar**. The same thing appears on a smooth monotone ramp, not just a
dither (`offline2.json:dropout`): bar 20 at `I=0.524` emits 13 hats between a 16-hat bar and an
8-hat bar. Since `pressure` genuinely oscillates in play (`live.json` shows `I` moving 0.42→0.69
and back), any run that spends time near 0.55 stutters.

**Fix.** Latch the density with the other bar-quantised state. Add a `this._hat16` field, set it in
`_onBar` from the intensity at the downbeat, and read `this._hat16` at `:397` instead of `I`.
Hysteresis (`on above 0.57, off below 0.53`) on top would stop it toggling every other bar.

---

## MODERATE 9 — Any frame gap over ~0.36 s resets the loop to bar 0; 12 times in 180 s

**`src/systems/Music.js:286-290`**

```js
if (this._musicTime < ac.currentTime) {
  this._musicTime = ac.currentTime + 0.02;
  this._step = 0;
  this._bar = 0;
}
```

The guard itself is correct and does the job it was written for — a 1.5 s main-thread stall emits
**3** steps, not the ~9-14 an unguarded scheduler would dump (`live.json:exp.stall`), and
`AudioContext.suspend()/resume()` is completely clean (steps frozen at 1329 during suspend, lead
0.332 → 0.316 after resume, no burst, no resync — `live.json:exp.suspend`). Those are wins.

Two problems remain:

**(a) The trigger tolerance is one lookahead.** `LOOKAHEAD = 0.25` (`:103`), so the guard fires
whenever a single frame exceeds roughly `0.25 + stepDur` ≈ 0.36 s. Measured in my environment
(median 28.3 ms/frame, p95 135.8 ms, max 500.7 ms — `live2.json:fps`) that happened **12 times in
180 s** (`live.json:mid.resyncs`), with `_musicTime - currentTime` reaching **−0.312 s**. A stage
transition, a shader compile or a large GC will exceed 0.36 s on any machine.

**(b) The recovery is heavier than it needs to be.** Resetting `_step = 0` *and* `_bar = 0` throws
away the phase and the 8-bar chord progression. `BAR_ROOTS` (`:38`) is an 8-bar cycle; at 12 resets
per 180 s the progression restarted more often than it completed, so the movement at bars 5–8 that
the comment says exists "only so a long fight does not feel like one chord held for four minutes"
mostly never plays. Also, `_musicTime = currentTime + 0.02` gives the first post-resync step 20 ms
of lead — inside the typical output latency of an `interactive` context, so that step lands late or
jittered, on a downbeat, with a kick on it.

To its credit: `_pending` does *not* survive a resync in practice — probed explicitly, a pending
commit set before a 1.2 s stall was gone afterwards (`live2.json:resyncState`).

**Fix.**
- Preserve phase: on resync, snap `_musicTime` forward by whole steps
  (`this._musicTime += Math.ceil((ac.currentTime + 0.05 - this._musicTime) / stepDur) * stepDur`)
  and advance `_step`/`_bar` by the same count, instead of zeroing them. The pulse and the
  progression both survive; only the missed audio is lost, which is the stated intent.
- Give the restart real lead: `+0.05` rather than `+0.02`.
- Raise `LOOKAHEAD` to 0.4–0.5 s. Nothing here reads intensity more than a lookahead ahead of time,
  so the cost is only slightly staler intensity at commit time.

---

## MINOR 10 — `_on()`'s documented "fade-out tail" does not exist; nine of ten layers stop dead on a bar line

**`src/systems/Music.js:344-359`**

```js
_apply(levels, t, ramp) {
  … L.g.gain.linearRampToValueAtTime(v, t + ramp);
  L.target = v;
  L.cur = v;            // 351 — set to the TARGET immediately
}
/** True while a layer is audible, including its fade-out tail. */
_on(name) { const L = this.layers.get(name); return L.target > 0 || L.cur > 0; }   // 356-358
```

`L.cur` is assigned the target at commit time, so `cur === target` always and `_on()` is just
`target > 0`. The half-bar `linearRampToValueAtTime(0, …)` therefore ramps down a gain that has no
signal passing through it — every layer except `pad` (the only sustained one) simply stops emitting
notes on the same bar line.

**Measured** (`offline2.json:dropout`, per-bar emission counts as intensity falls 1→0): bar 19 has
`perc: 4`, bar 20 has no `perc` key at all; bar 22 has `openhat: 4`, bar 23 has none. Instant, not
faded. `MAJOR` layers get the `_downlifter` (`:340`) to cover it; `hat`, `openhat`, `perc` and
`sub` get nothing and just vanish.

Not necessarily wrong musically — an abrupt drop is a legitimate technique — but the code does not
do what its own comment claims, and the half-bar fade is dead work. **Fix:** either track the true
current value (`L.cur` should be updated from `L.g.gain.value` at each bar, not from the target), or
delete the fade-out and the `cur` field and document the behaviour as a hard cut.

---

## MINOR 11 — The "bed" is not a bed: at intensity 0 the mix falls to −73 dBFS between downbeats

**`src/systems/Music.js:383-392`** (the pad block) using the one-shot envelope in `_osc`
(**`:597-616`**).

`_osc` is an attack/decay with no sustain: `setValueAtTime(0.0001) → exp to gain at t0+attack →
exp to 0.0001 at t0+dur`. The pad calls it with `dur ≈ 1.89 s` and `attack = dur*0.3`, so after the
568 ms rise it decays exponentially by 57 dB over the remaining 1.33 s.

**Measured** (`offline2.json:transition`, 50 ms window peak/RMS at `I = 0.10`):

```
t=5.15  peak  -6.0 dB   rms -12.1   <- the downbeat
t=6.00  peak -72.9 dB   rms -81.6   <- 850 ms later, same bar
t=8.05  peak  -180  dB  rms  -180   <- one full 50 ms window of digital silence
```

Roughly 55% of each intro bar sits below −50 dBFS peak. The comment at `:48-51` says `sub` and
`pad` exist because "a bed that fades to silence leaves the calm parts of a run with no soundtrack
at all" — and the envelope makes them do exactly that. At the shipped `musicVolume = 0.6` the
intro's RMS is −39.1 dB at the bus (finding #7); the between-downbeat portions are 30+ dB below
even that.

**Fix.** Give the pad a real sustain: replace the `_osc` call at `:386-391` with an explicit
`setValueAtTime → ramp to peak → hold → release` (or `setTargetAtTime` to a sustain level, with a
release scheduled at `t0 + dur`). The `sub` half-time pulse at `:374-375` is fine as a one-shot; it
is the pad that has to hold.

---

## MINOR 12 — `_impact` and `_riser` are fixed-gain and bypass every level control

**`src/systems/Music.js:535-557`** (`_riser`), **`:568-573`** (`_impact`), **`:560-565`**
(`_downlifter`).

```js
_impact(t) {
  this._osc(t, 1.1, { type: 'sine', f0: 70, f1: 28, gain: 0.7, out: this.bus, attack: 0.004 });
```

`_impact` writes to `this.bus` — so it bypasses the layer gains, bypasses `duck`, and is not scaled
by `intensity`. `_riser` writes to `this.duck` at a fixed 0.34, likewise unscaled. The first major
transition happens when the kick enters at `I = 0.13`, over a bed whose peak is around −30 dBFS
(measured above). Rendered across that transition (`offline2.json:transition`), the impact window
reads `peak −1.4 dB, rms −8.2 dB` against a preceding bar floating at −26 to −40 dB RMS — a ~25 dB
transient, and an identical one fires at `I = 0.9` where the mix is 20 dB louder.

**Fix.** Scale both by intensity the way `_kick` already scales its sidechain depth (`:470`):
`gain: 0.25 + 0.45 * this.intensity` for the impact, `0.12 + 0.22 * this.intensity` for the riser,
and route `_impact` through `this.duck` so it participates in the pump like everything else that
is not the sidechain key.

---

## MINOR 13 — ~270 WebAudio nodes/second are synthesised even with music volume 0 and the master muted

**`src/systems/Music.js:198-240`** (`update` has no volume gate), **`src/systems/Audio.js:979-983`**
(`setMusicVolume` only writes a gain).

**Measured** (`live.json:exp.mutedCost`) — `setMusicVolume(0)` **and** `setMuted(true)`, then 4 s:

```
createGain 423, createBufferSource 224, createBiquadFilter 224, createOscillator 199
= 1070 music nodes in 4 s  (~267/s), 33 sequencer steps, all rendering into a gain of 0
```

Over the full 180 s run the graph churned **49 361 nodes** (18 271 gains, 9 715 filters, 9 712
buffer sources, 8 543 oscillators, 3 120 panners ≈ 274/s). To be clear, this is *not* a leak — see
"clean" below — but it is real CPU and GC pressure spent on silence for any player who turns the
music off, which is a setting the game offers.

**Fix.** Early-return in `MusicEngine.update` when the music is inaudible:
`if (this.stopped || this._silent) return;`, with `Audio.setMusicVolume`/`setMuted` setting
`musicEngine._silent = (this.muted || this.musicVolume <= 0)`. Keep `_runT` and the intensity
integration running so the state is correct when it comes back; skip `_schedule()` only.

---

# Areas checked that came back clean

Each of these was probed, not assumed.

- **Round-1 CRITICAL #1 is genuinely fixed at runtime.** Cold boot → gesture → `ready:true`,
  `state:"running"`, 1326 steps in 180 s, **0 console/page errors across both live probes**
  (`live-errs.json` = `[]`, `live2.log` = `ERRORS 0`).
- **No memory or node leak.** `usedJSHeapSize` across the 180 s run: start 105 MB, end 94 MB,
  min 91, max 137 — sawtooth, no trend, despite 49 361 nodes created. Sources are stopped and
  collected correctly; `_count`'s `onended` decrement (`Music.js:592-595`) behaves.
- **No non-finite or illegal AudioParam writes.** 98 495 offline writes and every live write
  audited: **0** non-finite arguments, **0** `exponentialRampToValueAtTime(0, …)`, **0** thrown
  exceptions. The `Math.max(0.0002, …)` / `Math.max(1, …)` / `Math.max(30, …)` clamps throughout
  `_osc`/`_noise` do their job.
- **The sidechain duck does not fight itself.** The claim at `Music.js:472-475` ("that cap is why
  no `cancelScheduledValues` is needed here") holds. Automation replayed and rendered: 32 writes
  over 8 s at I=1, curve minimum **0.3422** — exactly `1 − (0.22 + 0.44·1)` — maximum 1.0, and it
  reaches ≥0.995 between kicks in 663 of 1601 sampled points. No overlap, no drift.
- **`AudioContext.suspend()`/`resume()` is clean.** Steps frozen at 1329 through a 1.2 s suspend,
  `_musicTime` lead 0.332 → 0.316 after resume, no resync, no burst (`live.json:exp.suspend`).
- **The resync guard prevents the burst it was written for.** 1.5 s main-thread stall (rAF fully
  blocked) → **3** steps emitted, which is the normal 0.25 s lookahead refill
  (`live.json:exp.stall`). Its *tolerance* and *recovery* are finding #9; the burst suppression
  itself works.
- **`_pending` does not survive a resync.** Explicitly probed: a pending commit present before a
  1.2 s stall was gone afterwards, no orphaned `_impact` (`live2.json:resyncState`).
- **Every volume and mute path is correct** (`live.json:exp.volumes`), including the subtle one:
  `setMasterVolume(0.5)` **while muted** correctly does not unmute (master stays 0), and the
  subsequent `setMuted(false)` restores to 0.5, not to the old 0.8. `setSfxVolume` /
  `setMusicVolume` / `setMasterVolume` are all null-safe before `_ensure()`, so `Menus.apply()`
  (`Menus.js:913-918`) firing before the first gesture cannot throw and the values are picked up
  correctly when the graph is built.
- **The `playerHurt` music duck restores to the right target.** At `musicVolume = 0.2`:
  0.064 → 0.034 (dipping) → 0.064, and `0.2 × 0.32 = 0.064` exactly. The duplicated `0.32` constant
  the writeup flags as pre-existing is currently consistent (`live.json:exp.hurtDuck`).
- **`MusicEngine.stop()` produces no click and terminates cleanly.** Rendered envelope across a
  stop: −2.2 → −8 → −20 → −33 → −45 → −57 → −69 → −77 → −89 → silence over ~450 ms, monotone
  (`offline2.json:stopEnvelope`). The `cancelScheduledValues` + `setTargetAtTime` pair at
  `Music.js:650-651` does not snap.
- **Music does not resurrect after death.** `playerDead` → 2.5 s → `stageStart` leaves
  `stopped:true`, `music.gain: 0`, `stepsEmitted` frozen at 1438, drone parked at 0.05
  (`live.json:exp.deadThenHurt`, `exp.stageAfterDeath`). Since restart is `location.reload()`
  (`Menus.js:1028, 1032`), the terminal `stop()` is defensible and there is no stale-state-across-
  restart bug.
- **The music voice budget does not starve SFX.** `MusicEngine._count` maintains its own counter
  and never touches `Audio.voices`; peak music voices 20 in the live run against a separate SFX
  peak of 35. The starvation in finding #1 is entirely SFX-on-SFX.
- **Intensity-model inputs all exist.** `director.difficultyCoefficient` (`Director.js:80,216`),
  `director.enemies`, `director.boss` (`Director.js:93` etc.) and
  `progression.state === 'charging'` (`Progression.js:63,312`) are all real fields with the exact
  names `_scanSustain` reads — no silent-`undefined` dead branch.
- **Event payload shapes match the handlers.** `damage` carries `{target, crit, position}`,
  `kill` carries `{isElite, isBoss, position, victim}` (`Combat.js:455-457, 499-501`) — the
  `Audio.init` hooks at `:90-99` read them correctly. `itemPickup` is the exception, and that is
  finding #5.
- **`Audio.play()`'s new world-interaction cases are real.** `chest`, `purchase`/`vaultPaid`,
  `shrineWin`, `shrineFail`, `shrineBlood`, `teleporterStart`, `deny`, `ui`/`uiClick` all dispatch
  to distinct implementations (`Audio.js:962-970`); the round-1-era default-case blip is gone.
- **Build.** `node node_modules/vite/bin/vite.js build` → `✓ built in 37.05s`, only the
  pre-existing 500 kB chunk warning.

---

# Observations (not defects)

- **`tools/capture.mjs` cannot see audio at all.** It never issues a user gesture, so
  `Audio._ensure()` never runs and no line of `Music.js` executes under it. `errorCount: 0` from
  capture is not evidence about this domain — which is how round 1's every-frame `ReferenceError`
  survived to be found by a human. A one-line `page.mouse.click()` in the capture boot, plus
  asserting `ctx.audio.musicEngine.stepsEmitted > 0` after the first scenario, would have caught
  it automatically and would catch the next one.
- **The writeup's numbers are reproducible in the direction they were measured, and misleading
  about the game.** Every layer level in `A-audio.md` §Verification is correct *given a forced
  `intensity`* — I reproduced them exactly (`offline.json:mix`, e.g. acid at I=0.72 = 0.079). The
  gap is that nothing checked whether the game supplies those intensities. It does not (finding
  #2). The lesson for the next round is to validate content against a driven run, not against a
  driven parameter.

---

# Verdict

**FAIL.** Not shippable at Risk of Rain 2 quality, and not for taste reasons — the specific,
reproduced problems are:

1. A safety-critical feedback sound (`playerHurt`) is dropped ~9.6×/s in heavy combat, along with
   its music duck. **CRITICAL, must fix.**
2. Two of ten layers never sound in real play and the intensity model flatlines at 0.43. **MAJOR** —
   the headline feature does not do the thing it is named for.
3. The 303's filter envelope is destroyed on 19% of its notes. **MAJOR**, and it is a one-line fix.
4. The opening ceiling keys off menu time, so the "sparse opening" is conditional on how fast the
   player clicks through. **MAJOR.**
5. Every pickup plays two comb-filtered copies of the same tier-0 jingle, and removing an item
   plays it too. **MAJOR.**
6. The layer balance spans 35 dB and the music sits 9 dB under SFX beneath a limiter that takes
   another 3–14 dB during fights. **MAJOR** — the arrangement is inaudible where it matters.

The engineering underneath is genuinely good and should be kept: the sidechain automation is
exact, there are no leaks, no illegal parameter writes, no suspend/resume faults, and the settings
paths are correct including the awkward mute-then-set-master case. What is missing is validation
against the running game rather than against forced inputs — every finding above except #3 would
have surfaced from a single instrumented three-minute run.

Nothing in `src/` was modified. All five throwaway probes were deleted; their raw output remains in
`reviews/round7/r2-audio/`.
