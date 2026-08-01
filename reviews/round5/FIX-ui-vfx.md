# FIX — UI/VFX (round 5, critic report `critic-r1-ui-vfx.md`)

Two agents worked this list. The first was killed by a usage limit mid-edit and never
wrote a report; this document covers **both** its work and mine, and marks which is
which. Everything below was measured; nothing is asserted from a screenshot alone.

New instrument written for this pass: **`tools/vfxprobe.mjs`** — per-layer A/B of the
explosion. It composes `08-explosion` once, freezes it, and re-renders that *one frozen
frame* five times with a single VFX layer switched off in place. Every pixel that is not
the layer under test is bit-identical between variants, so a diff is the layer and
nothing else.

---

## Defect 1 — artifact / difficulty icons were OS symbol-font glyphs

**Status: already fixed by the predecessor. Verified, not redone.**

`src/data/artifacts.js` carries 10 `mark:` keys where it carried 10 raw Unicode
codepoints (`⌘ † ⁂ ◈ ❖ ♛ ⟁ ☂ ☁ ⛈`, six different Unicode blocks, none in the `--font`
stack). `src/ui/Icons.js:556-720` draws 11 vector marks against them; `markIcon()`
returns `null` on an unknown key so a caller falls back rather than drawing an empty box.

Verified in `shots-r5b/17-artifacts.png`: seven authored vector marks, no colour emoji,
no fallback-font metrics.

---

## Defect 2 — artifact-card title stagger

**Status: already fixed by the predecessor. Verified, not redone.**

The critic diagnosed this as font fallback. It was not. The card is a `<button>`, and
Chrome vertically centres a button's content box — so a card with a two-line description
pushed its whole stack down against a sibling with four. Fix is `display: flex;
flex-direction: column; justify-content: flex-start` on `.art` (`src/ui/hud.css:2040-2050`),
plus the fixed 30×30 px `.art-mark` box so no glyph can influence the metrics.

Predecessor's measurement, recorded in the CSS: four sibling titles in one grid row at
**y 370 / 377 / 377 / 385 → all four at 370**.

Confirmed by eye in `shots-r5b/17-artifacts.png`: row 1's four titles share one baseline,
row 2's three share one baseline.

---

## Defect 3 — `08-explosion` had one of four VFX layers

**Status: partly fixed by the predecessor; the remaining half fixed by me.**

### What the predecessor landed (verified present and working)

| Layer | Where | Measured contribution (this build) |
|---|---|---|
| Light | `VFX.js:546` — `lights.flick` intensity 14→20, range `r*3.4`→`r*4.2` | **307,892 px brightened (21.4% of frame), mean +13.9 L, max +205.9 at (675,642)** |
| Distortion | `shaders/DistortShader.js` composed into `GradeShader` (no extra fullscreen tap) | **38,070 px displaced (2.6%), luminance range −167.5 … +132.3** |
| Soft depth fade | `RingFrag` + the particle layer's shared half-res prepass | **16,560 px changed (1.2%), mean −24.8 L, deepest cut −125.4 at (752,739)** |

The soft-fade mean is **negative**, which is the sign the measurement exists to check: a
real depth fade only ever *removes* particle light where it meets a surface. It reuses
the particle layer's existing prepass rather than rasterising a second one, so the depth
texture is not a new cost.

The predecessor also fixed the ring rendering edge-on as a hard bar across the full 1600 px
frame width (`RingVert` now fades the ring as its plane goes square-on to the view ray) —
visible in `shots-uivfx-before/08-explosion.png` and gone after.

### What was still broken — the flash core, measured at **+0.0 L**

`tools/vfxprobe.mjs` read the live shockwave record on the frozen frame and found the
shutter lands at **t = 0.207 s**, not the 0.09 s that `capture.mjs` documents and that
both previous rounds tuned against. Core lives were 0.20 s and 0.16 s. Both had expired.
The radial luminance profile about the blast's *true* projected centre:

```
     r(px)   mean   peak   no-core   core adds     <-- BEFORE
        0    70.1  138.5      70.0        0.1
       10    69.4  169.4      69.4        0.0
       20    84.4  189.3      84.4        0.0
       30    90.1  239.5      90.1        0.0
      ...
```

Flat and dark at the centre, bright at r ≈ 30-160. That is the critic's "concentric tori
with an empty centre", exactly, for the third round running — and it survived two rounds
of tuning because nobody had measured *when the shutter fires*.

`shots-vfxprobe/08-no-flash.png` is that frame: an orange ring around a hole.

### Fix

`src/systems/VFX.js:415-448` — core life 0.20 → **0.42 s** (`alphaPow` 1.5 → 1.7,
`size1` `r*1.25` → `r*1.5`), pip life 0.16 → **0.28 s** (`alphaPow` 1.1 → 1.35, `size1`
`r*0.62` → `r*0.75`). The life covers the whole window the shutter can land in; the
falloff power does the shaping, so the extra life is a *decaying* hot centre (0.81 of
peak at 0.05 s, 0.31 at the shutter) rather than a disc that hangs around. It does not
photograph as a flashbulb — see `shots-vfxprobe/08-full.png`.

```
     r(px)   mean   peak   no-core   core adds     <-- AFTER
        0   210.0  214.3      75.0      135.0
       10   211.2  228.4      85.8      125.4
       20   210.8  232.0      96.6      114.2
       30   207.7  242.9      95.5      112.2
       40   204.5  239.9      97.1      107.4
       60   189.6  235.9      95.5       94.1
       80   163.6  240.1     102.9       60.7
      120   143.5  254.1      89.3       54.2
      160   127.6  240.1      90.5       37.1
      190    99.6  220.8      75.1       24.5
```

Monotonic falloff from 210 L at the centre to 100 L at r = 190, with the core's own
contribution decaying +135 → +24.5. Footprint 202,073 px, peak +143.2 L at (805,196) —
i.e. at the blast centre, not at some unrelated muzzle flash.

### Fix — motion arcs were a false claim in a code comment

`ParticleShader.js` stretched every velocity-stretched particle along **`aVel`, the spawn
velocity**, while the comment above it in `VFX.js` claimed it followed "each chunk's own
analytic trajectory". It did not: direction and length were constant for the particle's
whole life, so a chunk at the top of its arc still read as travelling at launch speed and
a chunk falling back still pointed upward. That is a static billboard with a long axis,
which is what the critic saw as "no motion streaking".

The trajectory is a closed form and its derivative was already in registers:
`d/dt [term*t + (aVel−term)(1−e)/k] = term + (aVel−term)·e`. `ParticleShader.js:105-121`
now stretches along that. Cost: one madd. Drag shortens the streak as the chunk slows and
gravity swings it over as the arc turns.

`e.stretch` on the debris was left at 0.35 rather than raised: the instantaneous velocity
at the shutter is ~2.8× the spawn speed under this gravity scale, so the correctness fix
lengthened the streak on its own and raising the coefficient on top of it made the debris
field read as rain.

### Final layer scorecard

```
1. FLASH/CORE  202073 px (14.03%), mean +36.27 L, peak +143.2 at 805,196
2. LIGHT       307892 px (21.38%), mean +13.88 L, max +205.9 at 675,642
3. DISTORTION   38070 px ( 2.64%), range -167.5..+132.3
4. SOFT FADE    16560 px ( 1.15%), mean -24.81 L, deepest cut -125.4 at 752,739
PASS — all four layers measurably present
```

---

## Defect 4 — icon collision floor "regressed to 5.7%"

**Status: does not reproduce. No code change made.**

The critic measured this by sampling the 16-column grid on `16-run-summary.png` into a
440-bit centre crop. Measured instead against the **shipped tile** — `ui/Icons.js`
`itemArt`, the exact function the inventory calls, rendered at the HUD's own 34 px and
thresholded over the glyph band — the floor is nowhere near it. `tools/glyphdist.mjs`
(written by the predecessor, all 83 items, 850 same-tier pairs, 616-bit mask):

```
floor 11.04%  (target >= 10%)

tightest same-tier pairs:
   11.04%  common     hex/pouch      (Tougher Times / Hollowpoint Pouch)
   11.04%  common     triangle/flame (Predatory Instincts / Gasoline)
   11.04%  uncommon   blade/feather  (Tri-Tip Dagger / Wax Quail)
   11.20%  uncommon   bolt/blade     (Ukulele / Tri-Tip Dagger)
   11.36%  common     drop/plug      (Bison Steak / Spark Plug)
   12.18%  common     arrow/triangle (Paul's Goat Hoof / Predatory Instincts)
PASS — floor is above 10%
```

**11.04% against round 4's 8.5% floor.** The four pairs the critic named specifically:

| critic's pair | claimed | measured (repo crop) | measured (critic's tighter centre crop) |
|---|---|---|---|
| filled hexagon vs isometric cube (`hex`/`saltcube`, common) | 5.7% | **22.73%** | 25.00% |
| plain diamond vs faceted gem (`diamond`/`gem`, common) | 7.7% | **21.43%** | 29.51% |
| hexagon vs shield — round-4 N11 (`hex`/`shield`, common) | 8.4% | **16.56%** | 23.26% |
| battery vs canister, "green" | 6.4% | — | **no such pair exists**: `battery` is *legendary*, and there is no `canister` glyph in the set |

Three of the four measure 2-3× the claimed distance under both crops, and the fourth
names two items that are not in the same tier and one that is not in the game. Rendered
at 5× (`hex` vs `shield`, `diamond` vs `gem`, `hex` vs `saltcube`) they are three
plainly different drawings: a ringed hexagon, a riveted shield, a bomb-diamond, a
faceted gem, an isometric cube.

`git log` confirms no item glyph in `Icons.js` and no `glyph:` field in `items.js` was
touched between the critic's read and this measurement, so this is not a fix that landed
in between — the two instruments disagree, and the one that renders the shipped tile is
the one that matters. **Recorded as a measurement error in the critique, not a defect.**

`tools/glyphdist.mjs` exits non-zero under its floor, so this cannot silently regress
again.

---

## Defect 5 — the seven withdrawn claims in §5

Not touched, as instructed.

---

## Performance

`node tools/perf.mjs --enemies 24 --seconds 8`, run back-to-back on the same machine so
the pair is comparable (the box is running three other agents; absolute numbers drift
with their load, the A/B does not):

| | combat-24 median | p95 |
|---|---|---|
| Without my VFX changes (`git checkout` of the two files) | 21.2 ms | 34.4 ms |
| With them | **18.8 ms** | 25.9 ms |
| With them, later re-run under lighter machine load | 14.5 ms | 21.0 ms |

Inside the 21-26 ms band and no regression. The changes are two particle-lifetime
constants and one extra multiply-add in the particle vertex shader; the soft-particle
depth texture the brief warned about is the *existing* half-res prepass, shared with the
ring pass rather than duplicated, so nothing new is rasterised.

---

## Still open / not mine to fix

1. **`08-explosion` composition.** The scenario sites the blast 12 m out and 4.5 m up,
   which on the current terrain puts the fireball high in frame and half behind a
   mountain crest. The four layers are all present and measurable there, but the shot
   would read better with the blast lower and unoccluded. That is `Harness.js`, which I
   was told not to touch.
2. **The harness's shutter time is wrong by 2.3×.** `capture.mjs` and `Harness.js` both
   document `08-explosion` as capturing at 0.09 s; it captures at **0.207 s**. Two
   rounds of VFX tuning were done against the documented figure and both missed. The
   comment at `Harness.js:1655-1662` reasons in detail about what the blast looks like
   "at 0.11 s" — that reasoning is against a frame the shot never takes. Whoever owns
   `Harness.js` should either fix `waitSim` or fix the documentation; I have worked
   around it in `VFX.js` by widening the core's life to cover the real window.
3. **The `08-explosion` scenario is not deterministic across runs.** Two runs of
   `tools/vfxprobe.mjs` minutes apart composed visibly different frames (blast at
   509,445 vs 800,177) from the same seed, because the scenario free-runs on rAF. This
   is why the probe A/Bs one frozen frame instead of re-running the shot — the first
   version of it did re-run the shot and its noise floor was 40% of the frame, ten times
   the signal. Any future measurement that diffs two *runs* of a harness scenario is
   measuring drift.
4. **New, unreported, found while judging VFX under load in `04-combat`.** Six enemies
   in the left half of the frame carry ~90 px **blown-white hexagons** that erase their
   silhouettes — the `glacial` elite-affix aura (`VFX.js:71`, `tip: 0xe6ffff`, `rate: 22`)
   and the `freeze` status puff (`VFX.js:80`). At close range the aura is larger and
   hotter than the monster it is dressing. Not on my defect list and not measured, so I
   have not tuned it blind, but it is the most conspicuous VFX problem left in the
   populated combat frame and it will cost axis 4 as well as axis 6.
5. **`VFX.deathDissolve` never fires for monsters** — recorded in `HANDOFF.md` by
   another agent this session, in a file I own. Left alone deliberately: the obvious
   one-line fix creates genuine invisible-but-alive enemies, and the guard it needs is
   a separate piece of work from this brief.
6. **Cohesion between the HUD and the summary screens** (critique §2 Q1: the bare Chrome
   scrollbar, two casing systems, the plain 3×3 table, tier grouping abandoned, and the
   tile system inverted between HUD and run-summary). Untouched — `Menus.js` and
   `hud.css` were contended by another agent this session and the brief limited me to
   surgical artifact/logbook edits. This is the largest remaining axis-7/10 defect.

## Files changed by me

- `src/systems/VFX.js` — explosion core lifetimes and falloff; corrected the debris
  stretch comment.
- `src/shaders/ParticleShader.js` — velocity stretch along the instantaneous velocity.
- `tools/vfxprobe.mjs` — new.

No edits were made to `src/ui/Menus.js` or `src/ui/hud.css`.

## Evidence on disk

- `shots-vfxprobe/08-{full,no-flash,no-light,no-distort,no-soft}.png` — the five
  variants of the one frozen frame. `08-no-flash.png` is the round-5 defect in
  isolation: an orange ring around a hole. `08-full.png` is the same frame with the
  core alive.
- `shots-r5b/08-explosion.png` — the fix through the real `tools/capture.mjs` path
  (`errorCount: 0`, `subjectsOk: true`, `subjectFailures: []`).
- `shots-r5b/{04-combat,05-boss,17-artifacts}.png` — populated and usable.
- `shots-uivfx-before/08-explosion.png` — the predecessor's before, showing the ring
  rendering edge-on as a hard bar across the full frame width.
