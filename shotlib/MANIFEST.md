# Shot Library

The running money-shot library the launch design (section 3.4) requires. Every
feature milestone lands its money shot here; the trailer is cut from this
directory. Stills are committed (curated frames belong in the tree, the
`reviews/round8/UI-BASELINE.md` decision); clips are regenerated from their
recorded commands and never committed (`shotlib/clips/` is gitignored).

Renderer for every entry below: **headed d3d11** (`--use-angle=d3d11`, no
`--software`), chosen by the Task 1 canary of
`docs/superpowers/plans/2026-08-09-trailer-shot-library.md`. Every entry is
1600x900, deviceScaleFactor 1, seed 1337, clock pinned at 1/60. The
same-renderer rule is not optional — SwiftShader and d3d11 differ in AA and
gradient banding across the whole frame, so a frame re-shot under the other
adapter is a different photograph of the same scene and does not belong beside
these.

| Entry | File | Captured at | Command |
|---|---|---|---|
| The trailer thesis | `thesis-blight-edge.png` | `d156ecb` | `node tools/capture.mjs --out shots-trailer --only 20-blight-edge` |
| The thesis, moving | `clips/blightEdge-1337.webm` (regenerate) | `463579d` | `node tools/clipshot.mjs --arm blightEdge --secs 10 --seed 1337` |
| The ceiling | `blight-ceiling.png` | `463579d` | `node tools/blightprobe.mjs --seed 1337 --port 5212` |
| The instrument panel | `instrument-panel.png` | `0587511` | `node tools/gaugeshot.mjs --seed 1337 --secs 75 --target 150` |
| The kill that throws the body | `overkill-launch.png` | `54d7470` | `node tools/capture.mjs --out reviews/round9/money-shot --only 19-overkill --port 5203` |

Four stills, 8,272,597 bytes committed. The library is the trailer's contact
sheet, not an archive: one frame per milestone, and a frame earns its place by
arguing something no other frame here argues.

---

## The trailer thesis — `thesis-blight-edge.png`

**Captured at `d156ecb`** ("The thesis becomes photographable"), by
`node tools/capture.mjs --out shots-trailer --only 20-blight-edge`. Record:
`shots-trailer/manifest.json` (subject gates all green, `frameErrors: 0`,
`audioOk: true`).

**What it argues.** This is the sentence the spec wrote and the game had to
learn to say: *the party fighting at a blight edge as it spreads toward
camera*. Blight in the foreground with a grown rim (10.4 m off the live
uniform, not a seed radius), a live fight of ten combatants in the midground,
a deep-band sky over both — band 3, measured off the DOM at the instant of
capture, not dressed. The claim it settles is that the hook is
**photographable**: the three things the pitch promises can be true in one
frame, from public seams, without a bespoke scene. Everything else in this
directory supports this frame.

**Re-shoot when** the `blightEdge` harness arm changes what it composes, when
blight rim growth or band grading changes what a band-3 edge looks like, or
when the lens (`freeCam` pitch/height in the arm) is retuned. A change to
combat VFX that alters what a ten-body fight reads as also invalidates it.

**Tracked instance.** The source directory `shots-trailer/` is gitignored
(`shots-*/`), so the copy in this library is the **only tracked instance** of
this frame.

## The thesis, moving — `clips/blightEdge-1337.webm`

**Filmed at `463579d`** ("The sales unit learns to move"), by
`node tools/clipshot.mjs --arm blightEdge --secs 10 --seed 1337`. Record:
`shotlib/clips/blightEdge-1337.json` — 6/6 checks green, clock pinned at
1/60, zero frame errors, 10.05 s wall for 10 s asked, 2,795,285 bytes.

**Not committed, by design.** The clip is regenerated from the command above;
webm at 1600x900 does not belong in git history, and `shotlib/clips/` is
gitignored for exactly that reason. The record JSON beside it is the receipt
that the take held.

**What it argues.** The spec calls ten-second clips the sales unit, and a
still cannot show the one thing the thesis is about: the edge *crawls*. Ten
pinned seconds of the same arm as the still above, at wall-clock rate, is the
smallest artifact that proves the frame is a moment in a running game rather
than a composition.

**Re-shoot when** the still above is re-shot — they photograph the same arm
and must stay in step — or when `tools/clipshot.mjs`'s determinism gates
(pinned clock, wall-rate) change what a take means.

## The ceiling — `blight-ceiling.png`

**Captured at `463579d`**, by `node tools/blightprobe.mjs --seed 1337 --port 5212`.
Record: `shots-blightceiling/record.json` — 37/37 checks green, zero page and
console errors. The frame gates on four subjects of its own: three live masked
patches, shimmer in frame, the band on the sky (`band 2`, `skyW 0.30`), and
**372 real scene meshes standing inside the corruption**.

The blight-ceiling slice (`docs/superpowers/plans/2026-08-08-blight-ceiling.md`,
Task 7) published this frame, and the copy on disk had drifted to a later
unrecorded re-run whose commit could only be inferred from a file mtime. It was
therefore re-shot at the library's own HEAD, which is what a regenerable entry
is for: the SHA above is measured, not reconstructed, and the 37 checks are
this slice's own gates passing against current code.

**What it argues.** Not the pitch — the *system*. The thesis still says a
blight edge can be photographed; this frame says the corruption is a property
of the world and not a decal on it. Props inside the radius take the void
material variant, the rim shimmers as heat haze rather than as a lens effect,
and the sky itself has moved off the biome's anchor because the band demands
it. The 372 is the number that carries the argument: nothing here was placed
for the camera.

**Re-shoot when** `MASK_UNIFORMS`, the void material variant, the rim shimmer,
the mote emitter, or the per-band sky/fog/grade blend changes — i.e. whenever
`src/systems/Blight.js` or the grade pass moves. Also re-shoot if a biome's
base palette changes, since the whole frame is defined relative to that anchor.

**Tracked instance.** The source directory `shots-blightceiling/` is gitignored
(`shots-*/`), so the copy in this library is the **only tracked instance** of
this frame.

## The instrument panel — `instrument-panel.png`

**Captured at `0587511`** ("The labels stop touching and the last gradation
finally draws"), by `node tools/gaugeshot.mjs --seed 1337 --secs 75 --target 150`.
Record: `reviews/round8/ui-gauge-probe-record.json`; the prose that publishes
its five numbers is `reviews/round8/UI-BASELINE.md`.

**What it argues.** The UI is one instrument, not a set of widgets. The frame
is the full 1600x900 panel rather than a crop, deliberately — a crop would beg
the question it exists to answer. Every reading in it was taken off the live
DOM at the shutter: world corruption 150, band 3 `Overrun` at 79% fill, all
four gradations *rendered* (each 1 x 6.97 px, measured as
`getBoundingClientRect()` intersected with the track's clip box, which is what
caught the band-4 mark drawing nothing at all), and 48 samples in the pen's
ring — a complete turnover, so the trace is the run's own history and not a
decoration. The gradation percentages are the planet's real band thresholds.

**Re-shoot when** anything under `src/ui/` changes the panel's type ladder,
bezel/core/trace language, or the corruption gauge; when the band thresholds
move (the engraving is derived from them); or when the HUD trace ring's length
or sample interval changes. Per `UI-BASELINE.md`, such a change should also be
diffed against `reviews/round8/ui-shots-after/`.

**Tracked instance.** Unlike the other three, the source
`reviews/round8/ui-money-shot.png` **is** tracked — force-added past
`reviews/**/*.png` under the UI-BASELINE decision. That copy is an immutable
baseline and stays untouched; this one is the library's working copy. If the
two ever disagree, the `reviews/round8/` file is the baseline of record.

## The kill that throws the body — `overkill-launch.png`

**Captured at `54d7470`** ("The kill is photographed as an event"), by
`node tools/capture.mjs --out reviews/round9/money-shot --only 19-overkill --port 5203`.
Record: `reviews/round9/money-shot/manifest.json`; the published reading is
`reviews/round9/README.md`, section `money-shot/`.

**What it argues.** A kill is an event with consequences, not a despawn. A Slag
Hulk killed by a fire blow with four pools of damage to spare, four beetles
flanking, photographed 12 frames after the killing blow: the corpse is 0.924 m
off the ground it died on — 87% of its 1.057 m apex and still rising — with the
fire kill signature clear of the body. Every one of those is a gated subject,
not a description: launched corpse 1,717 px against a 900 px floor, burst 269 px
against 150, survivor 976 px against 400. The 12 frames are chosen rather than
inherited (6 frames is right for the arc and wrong for the burst, which at 6 is
still inside the 4.2 m body it came from); the departure is recorded in round 9.

**Re-shoot when** `VFX.LAUNCH` is retuned (`minOverkillFrac`, `maxSpeed`,
`gravity`, `dur` all change where the apex is and therefore what frame 12
shows), when the element kill signatures change, or when the hulk or beetle
rigs change silhouette. The plan flagged `LAUNCH.minOverkillFrac` as a retune
candidate against round 9's probe data — that retune, when it happens,
invalidates this frame.

**Tracked instance.** `reviews/round9/money-shot/19-overkill.png` is gitignored
(`reviews/**/*.png`; only its `manifest.json` is committed), so the copy in
this library is the **only tracked instance** of this frame.

---

## What was considered and left out

Curation, per the plan's instruction not to hoard:

- **`shots-blight/09-money-shot.png`** — the earlier blight-visuals slice
  (`docs/superpowers/plans/2026-08-07-blight-visuals.md`, 2026-08-07): mid-band
  stage, three patches, one on slope, HUD gauge top-left. Superseded rather
  than rejected: it photographs the same subject as *The ceiling* above, one
  slice earlier, before the void material variant reached props, before the rim
  shimmer and motes, and before the per-band sky. The newer frame contains its
  argument and beats it on every count. Left on disk.
- **`shots-blight/10-money-shot-grade-off.png`** — the A of that frame's A/B.
  An argument for a review, not for a trailer.
- **`reviews/round8/ui-shots-before/`, `ui-shots-after/`** — baselines, not
  money shots. They exist to be diffed and they stay where `UI-BASELINE.md`
  put them.
- **`shots-blightceiling/00-clean.png` .. `04-shimmer-rim.png`** — the
  ceiling probe's evidence frames. Their job is to make the record checkable;
  the record is committed, the frames are regenerable.

## How to append

A later slice's money shot joins this library by: copying the PNG in under a
self-describing name, adding one table row (entry, file, the SHA it was
captured at, the exact command), and adding one section that states what the
frame argues and what would invalidate it. If the total committed PNG bytes
approach 10 MB, retire a superseded frame rather than raising the ceiling — a
contact sheet that holds everything stops being a contact sheet.
