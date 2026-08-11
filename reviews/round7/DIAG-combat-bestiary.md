# DIAG — `04-combat` zero-pixel objects and `11-bestiary` separation

Diagnosis only. No code was changed. Written 2026-08-11 against HEAD `1911d79`, tree clean.

**Capture taken for this report:** `reviews/round7/captures/diag-combat-bestiary/manifest.json`
— `seed 1337`, `ready true`, `clockPinned true`, `partial false`, 23 shots, port 5302.
Every number below names the file it came from.

---

## Headline: both failures in the brief are already closed at HEAD

The brief describes `04-combat` at **3 zero-pixel objects of 24** and `11-bestiary` at
**1 separation failure**. Neither state exists at HEAD, and neither existed on 2026-08-05.

| shot | `reviews/round6/resume/manifest.json` (08-01) | `reviews/round7/E-after/manifest.json` (08-05) | this capture (08-11) |
|---|---|---|---|
| `04-combat` -> `horde` | `ok: false`, 6 `objectFailures`, 4 absences | `ok: true`, 0 `objectFailures`, 2 absences | **`ok: true`, 0 `objectFailures`, 2 absences** |
| `11-bestiary` -> `the whole spawn roster` | `ok: true`, 0 failures | `ok: true`, 0 failures | **`ok: true`, 0 failures, 0 absences** |

Full-run verdicts from this capture: 21 of 23 shots green. The two red ones are
`06-loaded-hud` (the known-red the brief told me to ignore) and `19-overkill`, whose
red is expected on a *full* run by construction — `tools/capture.mjs:198-206` states it
"is captured with `--only 19-overkill` against a fresh page, which is the supported
path", because `16-run-summary` has already killed the player. Neither is mine and
neither is evidence about anything here.

**The handoff's live hypothesis is refuted for every current failure.** No absent object
in this frame is mid-blink. `hidden` is `[]` and every absentee reports
`visRig: true` in `DIAG horde` — in this capture, in `E-after`, and in `resume`. The
mid-blink cause was real (`Enemy.js:1397`, cited at `Harness.js:1128-1132`) and it is
already closed by `awaitVisibleHorde` (`Harness.js:1160-1163`), which is called at
`Harness.js:2655` and gated at `Harness.js:2757-2761`.

### Instrument calibration

The instrument is the shipped gate plus the manifest reader; the calibration is that a
fresh full capture six days of commits later reproduces a known on-disk input.

`04-combat` -> `horde` -> `perPx`, mine against `reviews/round7/E-after/manifest.json`:

```
mine   [70,0,1,55,42,407,270,169,59,233,317,1229,987,1002,1334,443,468,432,461,98,201,47,1036,1064]
E-after[70,1,1,56,43,465,288,168,61,233,313,1226,989,997,1331,438,465,436,455,102,198,47,1040,1064]
```

Sum 10,425 against 10,487 (−0.6%); largest single-object move 465 -> 407 px on object 5
(12.5%); object identity and index order identical (`i:1 beetle d 37.2`, `i:2 spitling
d 33.5` in both). The two absences are deterministic, not run noise.

Index alignment between `perPx` and `DIAG horde` is load-bearing for every verdict below
and is exact by construction: `rigsOf` filters
`e && e.rig && e.rig.root && e.rig.root.parent` (`Harness.js:2096-2098`), `DIAG horde`
filters the identical predicate (`Harness.js:2713`), and `subjectReport`'s own
`o && o.parent` re-filter (`Harness.js:1856`) removes nothing further.

---

## `04-combat` — per-object verdicts

Gate state, this capture: `px 10308 >= 900`, `visibleObjects 22 >= 8`,
`sepP50 0.43 >= 0.25`, `objectFailures: []`, `perObjectOk: true`.
`gatedOn: ["px >= minPx", "visibleObjects >= minObjects", "sepP50 >= minSep",
"perPx/perSep/absence over the 8 gated of 24"]`.

There are **two** sub-`ABSENT_PX` objects, not three, and both are outside the gated 8.
They are published in four places — `absentObjects`, `crowd.absentBeyondCrowd`,
`notGated`, and `manifest.toleratedAbsences` — exactly as `Harness.js:2265-2275`
specifies.

### Object 1 — `beetle`, 37.2 m, 0 px — **(b) legitimately invisible; gate is correct**

`DIAG horde`: `{"i":1,"id":"beetle","d":37.2,"sx":0.642,"sy":0.525,"vis":0,"visRig":true,"px":0}`.

- `vis: 0` is nine of nine rays blocked. `visibleFraction` (`Harness.js:1657-1680`) casts
  through `seesTarget` -> `_rayHit` -> `ctx.stage.raycastDistance` (`Harness.js:294-307`),
  which is **stage geometry only**. So `vis: 0` proves terrain/prop occlusion outright.
- `visRig: true` and `no monster hidden by its own attack` is `ok: true` with detail `[]`
  — not a blink.
- It is also behind a wall of near bodies: acolyte `i:13` (1,002 px, 12.2 m) at 0.038
  screen-gap and golem `i:14` (1,334 px, 14.7 m) at 0.040, computed from the same
  `DIAG horde` coordinates with the aspect divided out the way `screenGap` does it.
- **Control inside the same frame:** the other beetle, `i:20` at 20.5 m, renders 201 px
  at `sepP50 0.41`. The mesh, material and mask path all work; this one is hidden.
- It sits at 37.2 m against `declutter`'s `maxDist: 30` (`Harness.js:2688`), so it is in
  the `bad` list, and `DIAG declutter` in `reviews/round7/E-after/manifest.json` names
  `"beetle"` in `unplaced` on both passes.

**Verdict: not a rendering or placement-correctness defect, and not a gate mis-read.**
The actor is genuinely absent from the photograph, and the gate declines to certify
against it rather than certifying it — `crowd: 8` (`Harness.js:2701`) holds the best 8 of
a director population, and `crowdWhy` declares exactly this case: "a monster behind a
terrain lip at the far edge of `04-combat`'s 30 m arena" (`Harness.js:2250-2251`).

**Recommended minimal fix: none to the gate, none to the scene.** See "the one fix I do
recommend" below, which is an instrument-legibility fix and moves no verdict.

### Object 2 — `spitling`, 33.5 m, 1 px — **(b) legitimately invisible; gate is correct**

`DIAG horde`: `{"i":2,"id":"spitling","d":33.5,"sx":0.455,"sy":0.526,"vis":1,"visRig":true,`
`"px":1,"sep":0.181,"sepP50":0.19,"lum":68.5,"bgLum":46.3}`.

This is the one that looks like a rendering defect and is not. `vis: 1` with `px: 1`
reads as "fully unoccluded and yet invisible", which is a contradiction only because
`vis` cannot see the thing that is occluding it.

**The occluder is another monster.** `mortar` `i:15` stands at `sx 0.459, sy 0.507,
d 22.2 m`, 443 px — a screen gap of **0.0114** frame-widths from the spitling, 11.3 m
nearer the lens. `visibleFraction` reports `1` because `_rayHit` raycasts
`ctx.stage` and the director's enemies are not in `ctx.stage` (`Harness.js:299`).

This is precisely the self-occlusion `declutter`'s third question was written for
(`Harness.js:887-905`: "the horde occludes itself, and the per-object mask measures
*marginal* contribution, so a body directly behind another body renders the pixels of
neither"). That test **did** fire: `crowded` is evaluated nearest-first, so the mortar was
`kept` before the spitling was considered, the spitling went into `bad`, and
`DIAG declutter` in `reviews/round7/E-after/manifest.json` names `"spitling"` in
`unplaced` on both passes. The detection worked; the grid had nowhere to put it.

- **Control inside the same frame:** the other spitling, `i:21` at 23.2 m, renders 47 px
  at `sepP50 0.73`, `lum 186.5`. The card renders.
- Range compounds it: at 33.5 m the fog has flattened it to `lum 68.5` against
  `bgLum 46.3`, which is the documented reason `maxDist: 30` exists at all
  (`Harness.js:2656-2661`).

**Verdict: not a rendering defect, and not a gate mis-read.** The pixels the mask counts
are the pixels a viewer would see, which is one. Ungated, published, correct.

**Recommended minimal fix: none.** The three levers that would move it are all
measured-refuted and recorded where they would be retried — `screenSlots` even-stride
(`Harness.js:648-663`), `declutter({supply, nearFirst})` (`Harness.js:2673-2682`), and
`worstFirst`, which took the capture to four failing shots and specifically broke
`11-bestiary` object 12 from `sepP50 0.61 -> 0.19` (`Harness.js:985-1002`).

### The third zero named in the brief

It no longer exists. The brief's "3 of 24" traces to
`reviews/round6/resume/manifest.json`, where `objectFailures` held six entries —
`i:3 679px/0.23`, `i:17 258px/0.19`, `i:0 0px`, `i:7 0px`, `i:14 1px`, `i:23 0px` — under
the *pre-`crowd`* rule that gated all 24. Two things closed it, both visible in
`gatedOn`: `resume` reads `"perPx/perSep per object"`, this capture reads
`"perPx/perSep/absence over the 8 gated of 24"` (the reconciliation argued at
`Harness.js:2245-2263`), and the two off-frame chargers at `sx -2.642` and `sx -1.364`
in `resume`'s `DIAG horde` are gone from the frame entirely — no object in this capture
projects outside `[0.126, 0.942]`.

### Not part of the brief, but it is in the manifest and should be said

Five objects sit under `MIN_SEPARATION` on `perSep` in this capture and none of them are
gated, because they are not in the best-8 by pixel count: `i:1 0`, `i:2 0.19`,
`i:10 0.15` (brood, 317 px), `i:0 0.21` (mite, 70 px), `i:8 0.23` (shriver, 59 px). That
is the `crowd` contract working as written, not a defect — but `i:10` at 317 px and
`sepP50 0.15` is a *rendered* body that does not stand off its background, which is a
different failure from absence and is currently invisible to every gate. Worth one
line in the next handoff; not worth a gate change on this evidence.

---

## `11-bestiary` — verdict

**No separation failure exists at HEAD.** This capture: `ok: true`, `px 26218 >= 4180`,
`visibleObjects 19 >= 19`, `sepP50 0.71 >= 0.25`, `objectFailures: []`,
`absentObjects: []`, and the gate is the strict one —
`"perPx/perSep/absence over every declared object"`, all 19, no `crowd` opt-out
(`Harness.js:4992-4999`; the rule at `Harness.js:2238-2244`).

Nor did it exist on 08-05 (`E-after`: `objectFailures: []`) or on 08-01
(`reviews/round6/resume/manifest.json`: `objectFailures: []`, min `perSep` 0.51). The
handoff says so itself in its own second paragraph — "`11-bestiary` was closed after
this file was first written" — and item 1's list was not updated to match.

**Verdict: (b), and not even a live one — nothing to certify against.** The closest
member to the floor is `i:13 warden`, `sepP50 0.29` against 0.25, 3,329 px; then
`i:15 mortar`, `sepP50 0.29`, 1,277 px, `lum 45.6` against `bgLum 60.6` (it is
silhouetted dark against a brighter backdrop, which is the axis working). The warden is
the object the four-rank stagger fix was made for and it is at its post-fix value:
`E-step-slots` 0.17 -> `E-after` 0.29 -> this capture 0.29, per the measurement recorded
at `Harness.js:4640-4650`.

**Recommended minimal fix: none.** The margin is 16% on two of nineteen. Any move here
re-frames the block and re-rolls the shared RNG stream for every shot below it.

---

## The one fix I do recommend

**`DIAG horde`'s `vis` field is a stage-only measurement published beside a pixel count,
with nothing saying so, and it inverts the reading of object 2.** A reader sees
`vis: 1, px: 1` and concludes the renderer dropped a visible actor; the actual cause is a
monster 11 m nearer at a screen gap of 0.011. That is this project's recurring failure
mode — an instrument that is wrong in the same direction as the bug — and it cost me the
single largest step in this diagnosis.

Minimal, gate-neutral, RNG-neutral fix, at `Harness.js:2718-2726` inside the
`DIAG horde` detail map, which is `info: true` and read-only:

- publish the nearest *nearer* horde member's screen gap alongside `vis` (the arithmetic
  already exists as `screenGap`, and `declutter` already computes exactly this pair at
  `Harness.js:904-905`), and
- say in the comment that `vis` is `ctx.stage` occlusion only and cannot see the horde.

It draws no `ctx.rng` and no `fxRng`, changes no threshold, and cannot move a verdict —
`DIAG horde` is `info` and `mustContain` returns `ok: true` unconditionally for it
(`Harness.js:2142-2147`). It is a publication fix in the same shape as the one already
argued at `Harness.js:2295-2327`.

The same caveat applies to `04-combat`'s gated `survivor unoccluded by the final lens`
check, which reads `visibleFraction` too — it currently reports `vis: 1`, and if a
monster ever parks in front of the survivor that check will say he is clear while the
pixels disagree. Not a live failure; worth knowing it is structurally blind to the horde.

---

## What I did not do

No code changed; `git status` clean apart from this file and the new capture directory.
I did not retry `screenSlots` even-stride, `declutter({supply, nearFirst})`,
`placeForOpenArena()` or `worstFirst`. The capture went to
`reviews/round7/captures/diag-combat-bestiary` on port 5302, never `shots/`, and it was
run **full** rather than `--only 04-combat,11-bestiary` on purpose: every scenario draws
from the shared RNG stream (`tools/capture.mjs:191-197`), so an `--only` run reaches
`04-combat` with a different stream state than the baseline it would be compared to, and
the comparison against `E-after` above would have meant nothing.
