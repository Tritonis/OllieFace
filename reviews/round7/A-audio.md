# Round 7 — A: ramping techno soundtrack + SFX pass

Files touched: `src/systems/Audio.js` (modified), `src/systems/Music.js` (new).
Nothing else in the tree was edited.

---

## 1. The soundtrack

The old engine — a 16-step sequencer over A-minor pentatonic gated on
`difficultyCoefficient` — is gone. It has been replaced by `MusicEngine` in
`src/systems/Music.js`.

### Why a new module

Almost nothing was shared with the SFX catalogue: a different bus topology (a
sidechain stage SFX has no use for), a voice budget deliberately outside
`MAX_VOICES`, note primitives whose envelopes are tuned for repetition at
140bpm rather than for one-shot impact, and an intensity model with its own
state. Keeping it in `Audio.js` meant two unrelated state machines sharing a
namespace and nothing else. `Audio.js` now owns the buses and the SFX
catalogue; `MusicEngine` owns everything downstream of the `music` gain node.

### Topology

```
kick ──────────────────────────────────────┐
sub/pad/bass/hats/clap/perc/acid/lead ─ duck ┴─ music bus ─ master ─ limiter
```

Each layer has its own `GainNode`. Everything except the kick passes through
`duck`. Every kick writes an explicit dip + release into `duck.gain`:

```
depth = 0.22 + 0.44 * intensity
rel   = min(4 * stepDur * 0.86, 0.32)   // always < one beat
duck.gain.setValueAtTime(1 - depth, t)
duck.gain.exponentialRampToValueAtTime(1, t + rel)
```

Explicit automation rather than a `DynamicsCompressor`: WebAudio has no
sidechain input, so the compressor version has to be keyed off an audible LFO
hack whose depth drifts with programme level. Automation is sample-exact and
free. The release cap below one beat is what makes `cancelScheduledValues`
unnecessary — consecutive ducks never overlap, so their curves cannot fight.

The kick bypasses `duck` because a kick that ducked itself would swallow its
own transient.

### Arrangement

Ten layers, each with an `enter` intensity and a fade `band` (not a threshold):

| layer | enter | band | max gain | content |
|---|---|---|---|---|
| sub | -0.06 | 0.10 | 0.85 | half-time pulse (intro), then a pickup note |
| pad | -0.08 | 0.14 | 0.75 | 4 detuned saws, one chord a bar |
| kick | 0.13 | 0.12 | 1.00 | four-on-the-floor, 165→46Hz in 60ms |
| hat | 0.24 | 0.14 | 0.62 | 8ths, becoming 16ths above I=0.55, velocity-accented |
| bass | 0.31 | 0.14 | 0.90 | offbeat-8th line with movement, saw + sub sine |
| openhat | 0.45 | 0.12 | 0.50 | offbeat "tss" on 2/6/10/14 |
| clap | 0.52 | 0.12 | 0.62 | 3 taps 9ms apart + body |
| perc | 0.64 | 0.12 | 0.42 | metallic tick on the 4th 16th |
| acid | 0.70 | 0.14 | 0.55 | 303 line: shared resonant LP, per-note filter env, accent + slide |
| lead | 0.86 | 0.12 | 0.45 | detuned saw stabs |

`sub`/`pad` have a negative `enter` so they are already partly up at intensity
0 — a bed that fades to silence leaves the calm stretches of a run with no
soundtrack at all.

BPM lerps 118 → 142.

Deliberate choices recorded in comments in the source:

- **The bassline moves.** `BASS_PATTERN` rests, plays offbeat 8ths, and drops
  to the 5th below at the end of the bar. Root-only pulsing was the single
  biggest reason the old engine read as "generic procedural".
- **The acid uses one persistent filter**, not one per note. Sixteen fresh
  Q=13 filters a bar ring differently on every note, which is exactly the
  smear a 303 does not have.
- **The kick's pitch drop is 165→46Hz over 60ms.** Slower is a tom; faster has
  no pitch in the attack at all.
- **The clap is a 3-tap stutter.** A single burst is a snare.

### Smooth transitions

Two mechanisms, because ramping alone is not enough:

1. Overlapping fade bands rather than hard thresholds, so a layer's gain is a
   continuous function of intensity.
2. **Layer levels are only ever committed on a bar boundary** (`_onBar`), with
   a `linearRampToValueAtTime` across half a bar. A hat fading in mid-bar
   arrives on a random 16th and sounds like a fault.

On top of that, when a *major* layer (kick/bass/clap/acid/lead) is about to
enter, the commit is deferred one bar and that bar is spent on a **riser** —
bandpassed noise sweeping 400→9000Hz plus a saw sweeping an octave up — landing
on a downbeat **impact** (70→28Hz sine + a bright noise tail). Major layers
leaving get a **downlifter** (6000→300Hz sweep) so the hole is intentional.
Only major layers get this: a whoosh every few bars stops reading as a
transition.

### Two intensity inputs

```
arc      = clamp((difficultyCoefficient - 1) / 5, 0, 1)         // minutes
sustain  = max(nearEnemies/7 * 0.58, boss ? 0.72 : 0, charging ? 0.76 : 0)
heat     = sum of event impulses, exponential decay tau 3.5s
pressure -> clamp(sustain + heat, 0, 1), attack tau 0.45s, release tau 5.0s
I        = arc + (1 - arc) * pressure * 0.7
I        = min(I, 0.10 + runT/60 * 0.70)                         // opening ceiling
```

- `nearEnemies` is a 45u radius scan of `ctx.director.enemies`, rescanned at
  4Hz (the list can be sixty deep and nothing else needs the distance check).
- Boss alive and teleporter charging are **floors**, not addends — those are
  set-pieces and the track should sit high for their whole duration even if
  the arena momentarily empties.
- Event impulses wired in `Audio.init`: enemy damage 0.028 (crit 0.045), kill
  0.05 / elite 0.14 / boss 0.5, `bossSpawn` 0.7, `levelUp` 0.22.
- **Asymmetric smoothing.** Symmetric made the music flutter every time an
  enemy died.
- **Blend, not max.** Pressure lifts into whatever headroom `arc` has left, so
  a fight early in a run is a big change and the same fight at high difficulty
  barely moves the needle — which is correct, it is already loud.
- `stageStart` calls `cool()`: a new stage is an empty arena, and carrying the
  last fight's heat across it left the track at full tilt over nothing for the
  ~15s the release curve takes to bleed off.
- **The opening ceiling** is time-based, not difficulty-based. The coefficient
  does climb on its own but not fast enough to stop a busy first thirty
  seconds from assembling most of the kit, and the brief is explicit that the
  run should open sparse.

The ambient drone now tracks the blended intensity, so it swells during a
fight rather than only as the coefficient grinds upward.

### Hard constraints

- **No lights added.** Nothing visual was touched at all.
- **Voice cap.** The music bus is explicitly exempt from `MAX_VOICES`, with the
  reasoning in a comment on `MusicEngine._count`: the cap works by *refusing*
  new sounds, and applying it to the sequencer would mean a busy fight silently
  deletes the downbeat. The music's concurrency is bounded by construction
  instead — a known fixed set of voices per 16th — and the measured ceiling is
  30 concurrent sources at full tilt (10 in the sparse opening). SFX still go
  through `_take`/`_release` unchanged.
- **Resync guard preserved**, comment and behaviour intact, in
  `MusicEngine._schedule`. Measured below.
- **No assets, no network.** Everything is oscillators, the shared noise
  buffer, and biquads.

---

## 2. SFX pass

### Silent fall-throughs, fixed

`play()`'s `default:` case was swallowing six names that gameplay code passes
every run. Found by grepping every `audio?.play?.(` call site. All six now have
real sounds:

| name | call sites | new sound |
|---|---|---|
| `chest` | `Interactables.js:330`, `RealmProps.js:537` | latch tick → lid (90ms later) → 4-note pentatonic shimmer |
| `purchase` | `Interactables.js:408,1139`, `RealmProps.js:287` | register clunk → rising two-note confirm on the pickup jingle's interval |
| `shrineWin` | `Interactables.js:604,936,1035`, `RealmProps.js:161,352` | bell chord (inharmonic 2.76x partial) over a sub swell |
| `shrineFail` | `Interactables.js:607` | the same gesture inverted: falling, 30-cent-detuned, dull |
| `shrineBlood` | `Interactables.js:711,908,1256`, `RealmProps.js:414` | Q=7 downward squelch + a 240ms lub-dub heartbeat |
| `teleporterStart` | `Interactables.js:1373`, `Realms.js:514` | 1.9s linear rising charge + crackle, landing on a boom |

Also added `deny()` and explicit `ui`/`uiClick`/`vaultPaid` cases so the
default is genuinely a last resort rather than the common path.

### Variety

New `_variant(key, n)` helper. Not `Math.random() * n`: uniform picking repeats
the same variant back-to-back roughly 1/n of the time, and a back-to-back
identical burst is precisely the machine-gun artefact variants exist to remove.
It advances by 1 or occasionally 2, so it walks the whole set, never repeats
consecutively, and never sounds like a fixed rotation.

Applied to:

- **`shoot`** — 3 timbres (body bandwidth + sweep depth), plus a mechanical
  action-cycling tail on one in three. Pitch variation alone was not enough:
  at 10rps, shots with identical envelope shapes still fuse into a buzz.
- **`impact`** — 3 lengths and bandwidths; metal now rings at one of three
  partials instead of a fixed 2400Hz (a fight against armour used to become a
  single held tone), plus an occasional grit scatter.
- **`hit`** — 4 variants shifting the mid body between wet, dry and clicky.
  This is the most-repeated sound in the game; a beam can trigger it 20x/sec.
- **`explosion`** — pitch-varied across all layers, plus 2–4 debris ticks at
  randomised offsets on two of three variants (a *fixed* number of ticks at
  fixed offsets becomes a rhythm the ear locks onto after three explosions).
- **`zap`** — 2–4 arc crackles at random times/frequencies. The irregular
  retriggers are what separate "lightning" from "laser"; the old version was a
  single clean sweep.
- **`footstep`** — left/right alternation (±8% pitch) plus a scuff on ~1 in 4.
  One sound repeating at a fixed interval is the most recognisably synthetic
  thing in a game's mix, and it was the state of this one.
- **`coin`** — the pair walks a 4-rung pentatonic ladder, so a long gold
  payout is a cascade instead of a stuck bleep, plus a high shimmer.

---

## 3. Verification

### `npm run build`

Passes. `✓ built in 1.28s`. The only warning is the pre-existing 500kB chunk
size notice.

### `tools/capture.mjs --only 01-title,04-combat`

`errorCount: 1` — **pre-existing and not audio**. The error is
`TypeError: BUILDERS[id] is not a function`, thrown from
`src/entities/EnemyMeshes.js` (someone else's in-flight round-7 work).
Confirmed by baseline: `git stash push -- src/systems/Audio.js` and re-running
the same capture produces the identical `errorCount: 1` with the identical
message. My changes introduce zero new errors.

### Playwright probe

A throwaway `tools/_musicprobe.mjs` was written, run, and deleted. It booted
`?harness=1`, patched `AudioParam.prototype`'s four automation methods and its
`value` setter before any module loaded, unlocked the context with a real
`page.mouse.click`, then drove `ctx.audio.musicEngine`. Actual output:

**Layer gains across the intensity range** (read off the live
`GainNode.gain.value`, settled 9s — a bar is ~1.9s and a major entry defers one
bar for the riser):

```
idle  I=0     bpm=118.0  sub=0.51 pad=0.429 kick=0 hat=0 bass=0 openhat=0 clap=0 perc=0 acid=0    lead=0
low   I=0.12  bpm=120.9  sub=0.85 pad=0.75  kick=0 hat=0 bass=0 openhat=0 clap=0 perc=0 acid=0    lead=0
mid   I=0.40  bpm=127.6  sub=0.85 pad=0.75  kick=1 hat=0.62 bass=0.579 openhat=0 clap=0 perc=0 acid=0 lead=0
high  I=0.72  bpm=135.3  sub=0.85 pad=0.75  kick=1 hat=0.62 bass=0.9 openhat=0.5 clap=0.62 perc=0.28 acid=0.079 lead=0
max   I=1.00  bpm=142.0  sub=0.85 pad=0.75  kick=1 hat=0.62 bass=0.9 openhat=0.5 clap=0.62 perc=0.42 acid=0.55 lead=0.45
```

Every value matches the layer table exactly (e.g. acid at I=0.72:
`(0.72-0.70)/0.14 * 0.55 = 0.079`), and the build is monotone across the range.

**Step rate vs BPM** (4s windows, compared against the *mean* BPM over the
window since it drifts with pressure):

```
bpm(mean)=118.0  steps/s actual=8.06  expected=7.87  err=+2.5%  peakMusicVoices=10
bpm(mean)=127.6  steps/s actual=8.50  expected=8.51  err=-0.1%  peakMusicVoices=19
bpm(mean)=142.0  steps/s actual=9.50  expected=9.47  err=+0.3%  peakMusicVoices=30
```

**Combat pressure** (arc pinned at 0, i.e. a fight at the very start of a run
with the opening ceiling lifted):

```
calm    I=0      pressure=0
+1.2s   I=0.605  pressure=0.865   (after ~1s of sustained damage impulses)
+10s    I=0.319  pressure=0.456   (decaying)
```

Fast rise, slow decay, exactly as specified. Note the ceiling: pressure alone
tops out at `0.7 * pressure`, so a fight can lift the track to about two-thirds
of the kit but never to full tilt.

**Opening sparseness** (`_runT` reset to 0, `heat` forced to 1.0 — i.e. the
hardest possible fight 2.6 seconds into a run):

```
I=0.122   sub=0.85  pad=0.75  kick=0  acid=0
```

A pulse and a pad. Exactly the brief.

**1-second main-thread stall** (`while (performance.now() - t0 < 1000);`,
which blocks rAF entirely, then exactly two rAF ticks):

```
steps emitted across the stall = 3   (an unguarded scheduler would dump ~8-9)
```

The resync guard snapped `_musicTime` forward instead of replaying the
backlog; the 3 steps are the normal 0.25s lookahead refill.

**Non-finite AudioParam values:** `0` out of `40,183` recorded parameter writes
(covering `setValueAtTime`, `linearRampToValueAtTime`,
`exponentialRampToValueAtTime`, `setTargetAtTime`, and the `value` setter).

**Console/page errors during the probe:** `0`.

---

## 4. Not done / notes

- **`capture.mjs` does not report `errorCount: 0`.** It reports 1, from
  `EnemyMeshes.js`, and it does so identically on a baseline with my `Audio.js`
  changes stashed. That is someone else's file and outside my ownership.
- The probe was deleted as instructed, so the numbers above are not
  reproducible without rewriting it. The capture baseline comparison *is*
  reproducible: `git stash push -- src/systems/Audio.js`, run, `git stash pop`.
- The music does not restart after `playerDead` — `MusicEngine.stop()` is
  terminal, matching the previous engine's `_musicOff` behaviour. A new run
  reloads the page.
- I did not touch `playerHurt`'s hardcoded `musicVolume * 0.32` duck target,
  which duplicates the constant in `setMusicVolume`. Pre-existing, and
  changing it is a call-site question rather than an audio one.
