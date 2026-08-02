# FIX-combat — round 6, the last failing shot

Owned files touched: `src/core/Harness.js` **only**. `EnemyMeshes.js`, `Enemy.js`,
`Director.js` and `tools/capture.mjs` were read and not written.

Commits: `a4505f7` (the fix), `bb11224` (the refutation).

**Verdict: PARTIAL.** `04-combat` still fails. Failing *objects* 6 → 4, and the
two separation failures are closed — every object the gate ranks now clears both
its floors. The four that remain are absences, and the shot is one failing shot
in the capture, unchanged. **No second failing shot was added.**

## Captures, and what each one is

Four full captures, all `ready: true`, `clockPinned: true`, `partial: false`,
seed 1337, `--port 5291`.

| dir | code state | role |
|---|---|---|
| `reviews/round6/resume/manifest.json` | `093daeb` as inherited | **BEFORE** (the brief's baseline) |
| `reviews/round6/cfit1/manifest.json` | + `avoidFit: true` on `04-combat`'s final `declutter` | the fix |
| `reviews/round6/cfit2/manifest.json` | + `worstFirst`, scored `!framed \|\| merged \|\| d < minDist` | **refuted** — a no-op |
| `reviews/round6/cfit3/manifest.json` | + `worstFirst`, scored by contribution | **refuted** — four failing shots |
| `reviews/round6/final2/manifest.json` | **as delivered** | **AFTER** |

`final2` reproduces `cfit1` on every pixel check in the capture except
`03-thirdperson` → `survivor` at 977 → 975 px. That same 2 px moves between
`cfit1` and `cfit2` as well, on a change that provably cannot reach it, so it is
run-to-run jitter and not a code effect.

## Headline

| | `resume` | `final2` |
|---|---|---|
| failing shots | **1** (`04-combat`) | **1** (`04-combat`) |
| `04-combat` failing objects | **6** | **4** |
| separation failures | 2 (objects 3, 17) | **0** |
| absences (`perPx < 12`) | 4 (objects 0, 7, 14, 23) | 4 (objects 0, 7, 9, 14) |
| `horde` union px | 9,679 | 8,550 |

`perPx`, `resume` → `final2`:

```
[0,17,17,679,67,73,187,0,205,129,1847,24,318,492,1,3939,99,258,87,463,114,578,85,0]
[2,13,15,347,67,73,187,0,287, 3,2109,210,314,324,1,2495,14, 69,87,693,114,578,85,462]
```

Per-object movement that matters:

| obj | id | `resume` | `final2` | |
|---|---|---|---|---|
| 23 | charger | 0 px | **462 px / sepP50 0.41** | was off frame; now placed |
| 3 | lemurian | 679 px / **0.23** | 347 px / **0.25** | separation closed |
| 17 | beetle | 258 px / **0.19** | 69 px / **0.51** | separation closed |
| 11 | stalker | 24 px | 210 px | |
| 9 | brood | 129 px | **3 px** | **new absence** |

No threshold moved. `git diff HEAD -- src/core/Harness.js` filtered to
`minPixels|minObjects|minSep|minCarriedPx|minPerPx|MIN_SEPARATION|OPEN_GROUND_NEED`
is **empty**. The one `need` identifier my diff adds is a local `Map` of
per-body scores inside `_declutterPass`, not a floor.

## What the gate actually requires, since it decides everything below

`Harness.js:2225-2244`. With `crowd: 8` over 24 objects, `need = 8` and
`minPerPx = round(900 / 8) = 113`. Then:

- `rank` = the **top 8 objects by `perPx`**. Only these are held to
  `perPx >= 113` and `perSep >= 0.25`.
- `absentObjects` = **every** object with `perPx < 12`, ranked or not. These fail
  outright; `crowd` does not license them.

In `final2` the top 8 are objects 15, 10, 19, 23, 3, 13, 12 and 8 at 2495, 2109,
693, 462, 347, 324, 314 and 287 px, every one of them at `sepP50 >= 0.25`. **The
ranked half of the gate passes.** The shot fails only on the four absences.

## The three zeros I was sent to explain — and the one the brief predicted is not among them

**The blinking Rift Stalker is not one of them.** Object 11 is the stalker, and
in `final2` it renders **210 px at sepP50 0.25** — visible, ranked, passing. The
blink is already handled: `awaitVisibleHorde()` (`Harness.js:1160`) is called at
`Harness.js:2461`, before the final re-space, and spins up to 240 frames until
`hiddenRigs()` is empty. So the "gate mis-reads a legitimately invisible actor"
outcome the brief invited me to report **is not what the evidence shows**, and I
am not going to claim it. The four absences are four bodies the placement pass
had nowhere to put.

Read from `final2/manifest.json` → `04-combat` → `DIAG horde`:

```
 0 mite      d=27.1  sx= 0.518  sy=0.660  front=26.7  vis=0.11  px=2
 7 charger   d=22.9  sx=-2.642  sy=1.535  front= 3.6  vis=0     px=0
 9 brood     d=25.2  sx= 0.801  sy=0.624  front=21.5  vis=0.89  px=3
14 mortar    d=29.7  sx= 0.416  sy=0.624  front=29.0  vis=0.44  px=1
```

1. **Object 7, charger — off the frame entirely.** `sx -2.642`, `sy 1.535`,
   `vis 0`. Not occluded, not dim: it is two and a half frame widths to the left
   of the picture. It appears in the `unplaced` list of **both** declutter passes
   in every capture this round. It is the last body in an over-subscribed grid.
2. **Object 0, mite — terrain-and-body occluded.** On screen at (0.518, 0.660) at
   27.1 m with **11%** of its samples clear.
3. **Object 9, brood — occluded by a team-mate.** At (0.801, 0.624), 25.2 m. The
   warden (object 10) stands at (0.812, 0.586), 12.3 m, rendering 2,109 px —
   **0.011 of frame width away and 13 m nearer.** Its `vis 0.89` is *terrain*
   visibility, which is high; the per-object mask measures *marginal*
   contribution, so a body directly behind another body renders the pixels of
   neither. This is the failure `_declutterPass`'s third question exists to catch,
   and it caught it: the brood is in `bad` on both passes. It simply never got a
   slot.
4. **Object 14, mortar — 29.7 m, `vis 0.44`**, at the far edge of the 30 m band.

All four are in `DIAG declutter`'s `unplaced` list on both passes.

## The fix that landed — `avoidFit`, `a4505f7`

`093daeb` added an `avoidFit` option to `_declutterPass` and its commit message
describes it as the thing that fixed `11-bestiary`. **It does not: it defaults to
`false` and had no call site.** `11-bestiary` was fixed by the flyer-hover clamp
in `bestiary()`. So `avoidFit` arrived unshipped and unmeasured, and I treated it
as an untried lever rather than a validated one.

The DIAG counters `093daeb` published name the cause without ambiguity.
`resume/manifest.json` → `04-combat` → `DIAG declutter`:

```
pass 1  bad=15 slots=6 moved=6  {cells:52, noGround:14, player:2, avoid:20, dup:10, got:6}
pass 2  bad=10 slots=0 moved=0  {cells:52, noGround:14, player:2, avoid:36, dup: 0, got:0}
```

Of 52 grid cells, 14 fail `noGround` and 2 fail `player`, leaving **36 usable** —
and `avoid` rejects 20 of them on pass 1 and **all 36** on pass 2. `avoid` is what
empties this grid, not the depth band and not the row de-dup.

The keep-out disc was `k.half * 2.3`: the obstacle's own projected half-width,
doubled on the assumption that the incoming body is the same size. Here it
systematically is not. The obstacles are the bodies that were photographed well —
near and large, the hulk at 15.7 m and the warden at 12.3 m — and the candidates
are the ones that were not: mite, beetle and spitling at 27-33 m. Reserving a
hulk's width in order to admit a mite is **an error in an estimate, not a rule
being enforced**. `avoidFit` substitutes the projected half-width of the body
that is actually going to stand there (median radius of the `bad` list, at the
band's mid-distance). The crowding test it mirrors, `(half + k.half) * 1.15`, is
untouched, and a body seated too close still reports as a per-object zero.

Result, `resume` → `cfit1`/`final2`:

```
pass 1  bad=15 slots=7 moved=7  {cells:52, noGround:14, player:2, avoid:15, dup:14, got:7}
pass 2  bad=10 slots=1 moved=1  {cells:52, noGround:14, player:2, avoid:34, dup: 1, got:1}
```

One extra slot on each pass, and the re-seating those two slots bought closed
both separation failures and recovered the off-frame charger at object 23.

**It displaced nothing.** The only other pixel-check delta in the entire capture
is `07-interactables` at 21,158 → 21,157 px. That is the point: `avoidFit`
changes *where* bodies are placed without changing *which* bodies move, so it
consumes no draws from the shared stream and nothing downstream re-jitters.

## The refutation — `worstFirst`, `bb11224`

Recorded in source at the seat loop in `_declutterPass` and at the `04-combat`
call site. Kept as an opt-in option, defaulted off, exactly as `supply` and
`nearFirst` are.

The observation is sound and, as far as I can tell, new. `bad` is sorted
nearest-first, and the crowding test above it **requires** that order — pairs
resolve in favour of the near body, so the near body has to be considered first.
That order is then reused verbatim as the priority for a scarce grid, and there
is no reason those two orders should be the same one. On `cfit1`, pass 1 had 15
homeless bodies and 7 slots, and the 7 that got them were simply the 7 nearest;
**all four remaining zero-pixel objects were in the leftover list** while bodies
already rendering hundreds of pixels were re-seated ahead of them.

It is not the refuted `nearFirst`, which reversed the *slots* and left the
candidate order alone. Nothing had previously reordered the candidates.

**Two scorings were built and captured full. Both fail.**

**`cfit2` — score `!framed || merged || d < minDist` as 0, else `vis`. A no-op.**
`04-combat`'s `perPx` came back **byte-identical**; the whole capture moved by
2 px on `03-thirdperson` and 1 px on `10-inventory`. Seven bodies tie on the key
`0`, V8's sort is stable, and the partition therefore comes back identical to not
sorting at all — the same eight `unplaced`, merely reordered. The error was
conflating *"looks wrong"* with *"contributes nothing"*: a body inside the near
clamp is **over**-photographed. It is a composition defect, and it is the one
kind of `bad` that never fails a pixel gate.

**`cfit3` — score by contribution (off-frame 0, `merged` 0.05, else the visible
fraction, so an over-photographed near body ranks last). Works locally, and cost
three passing shots.**

`04-combat` improved: 4 failing objects → 3, and object 7 — the charger that has
been off frame in every capture this round — **finally landed, at 40 px**. And the
capture went from **one failing shot to four**:

| shot | check | `cfit1` | `cfit3` |
|---|---|---|---|
| `08-explosion` | `damage numbers` | PASS | **FAIL** |
| `10-inventory` | `monsters standing in it` | PASS | **FAIL** — object 3 `sepP50` 0.45 → **0.21** |
| `11-bestiary` | `the whole spawn roster` | PASS | **FAIL** — object 12 `sepP50` 0.61 → **0.19** |

This is the cleanest measurement of the shared-RNG hazard in this repo.
`10-inventory` → `the equipment blast` moved **19,488 → 57,049 px** on a change
whose entire effect is picking *which* of `04-combat`'s monsters get re-seated
two frames before its own shutter. Re-seating a different body changes what the
horde does over the following frames, the enemy AI draws from `ctx.rng` as it
does so, and every later scenario draws from that same stream.

It also states the standing rule sharply, and explains why the sibling change was
safe: **`avoidFit` changes where bodies go without changing the set of bodies
that move.** `worstFirst` changes the set. That is the whole difference between a
capture that moved by one pixel and a capture that lost three shots.

## What is left, and the honest structural finding

The declutter is not short of tuning. It is short of cells, and **the two-pass
loop starves itself**. Pass 1 seats 7 bodies into 7 of the grid's own cells;
those 7 are then carried into pass 2 as obstacles, and their keep-out discs
blanket the grid — `avoid` rejects **34 of the 36 usable cells**, and pass 2 seats
one body out of ten. The grid's own de-dup admits slots 0.05 of frame width apart
while `avoid` later refuses anything within roughly 0.05-0.15 of a placed body,
so **pass 1 hands out cells in a pattern that makes pass 2 impossible.** Fixing
that means reconciling the two spacing rules with each other, which is a change
to `screenSlots` for all callers — and changing `screenSlots` for all callers is
precisely what cost two passing shots in `hdiag4`. It needs its own baseline and
its own session.

Underneath that sits a plainer arithmetic problem: **the scenario declares 24
subject members and the frame yields at most 36 usable cells, of which de-dup and
keep-out remove 29.** Twenty-four bodies individually photographed, each at
≥ 12 px, in one 30 m arena, is close to the limit of what this camera can do.

### The tension I am escalating rather than resolving

The gate contains two rules that cannot both be right, and I did not touch either
because resolving it by relaxing one is loosening a threshold.

- `crowd: 8` with `crowdWhy: 'director horde: an unbounded population, not a
  fixed cast'`, and the comment at `Harness.js:2499`: *"Members behind a terrain
  lip or at the far edge of a 30 m arena are the scene working; what has to be
  true is that eight of them are individually in the photograph."*
- `absentObjects` (`Harness.js:2238`), which fails the shot for **any** declared
  member under 12 px, ranked or not, with the comment *"A scenario that cannot
  photograph a member of its subject must stop declaring it, not average it
  away."*

Both are defensible and they contradict each other on this shot. The second is
the stricter and it is currently the only thing failing `04-combat`. Its own
comment names the resolution — *stop declaring it* — which would mean the
scenario spawning fewer than 24, or declaring as its subject only the members it
undertakes to photograph. **That is a spec decision about what `04-combat`
asserts, not an implementation detail, so it is yours and not mine.** I flag it
because "the horde is an unbounded population" and "every one of the 24 must
clear 12 px" cannot both survive.

## Left alone deliberately

- **`VFX.js` `deathDissolve` / `resolveObject`.** Not touched, not read. Six
  agents have now correctly left it alone.
- **Every threshold.** `minPixels`, `minObjects`, `minSep`, `minCarriedPx`,
  `minPerPx`, `need`, `crowd`, `MIN_SEPARATION`, `OPEN_GROUND_NEED`, and the
  12 px absence floor. Diff against `HEAD` is empty on all of them.
- **`screenSlots`.** Its supply is the real constraint and it is the one function
  whose modification is measured to cost passing shots (`hdiag4`, five failing
  shots). Not touched.
- **`declutter({ supply, nearFirst })`** and **`placeForOpenArena()`** — refuted
  by predecessors with named manifests. Not re-tried.
- **Repainting `wisp`** — refuted at `EnemyMeshes.js:1220`. Not re-tried, and the
  lesson there is right: separation is a distance from the background, not a
  brightness.
- **The first `declutter(12)`** at `Harness.js:2439`. `avoidFit` almost certainly
  belongs there too, but that call sits **before** a 0.45 s `fireBurst`, so a
  change to it has hundreds of frames of enemy AI — and therefore hundreds of
  shared-stream draws — downstream of it. `cfit3` is what that looks like when it
  goes wrong. The delivered change is deliberately confined to the last two
  frames before the shutter for that reason. Anyone trying it should budget a
  full capture and expect to check all 21 shots.
- **`tools/capture.mjs`, `Enemy.js`, `Director.js`, `EnemyMeshes.js`.** No change
  needed for this work.
