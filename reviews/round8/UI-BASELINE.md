# UI visual baselines — round 8, diegetic-ui slice

The repo had no UI visual baselines before this slice. It has them now, and this
file is what makes them baselines rather than screenshots: the SHA each set was
taken at, the exact command that produced it, and the measured difference
between the two.

## The two sets

| set | SHA | what it is |
|---|---|---|
| `ui-shots-before/` | `9188e91` — *The panel is photographed as it was, before anything moves* | the panel before the slice: no type ladder, no `.bez`/`.core`/`.trace`, the old corruption gauge |
| `ui-shots-after/` | `d21c6a6` — *The logbook reads like the field notes of the same instrument* | the panel after Tasks 1-5, i.e. the shipped treatment |

Both sets: **1600x900, deviceScaleFactor 1, seed 1337, clock pinned at 1/60**,
captured **headed on the d3d11 adapter** (no `--software`). The same-renderer
rule is not optional — SwiftShader and d3d11 differ in AA and gradient banding
across the whole frame, so a mixed pair would measure the renderer rather than
the treatment. `$CAPFLAG` was fixed empty by the Task 1 Step 0a canary and both
sets were taken under it.

### The exact invocations

Before (Task 1, Step 0b, at `9188e91`):

```bash
node tools/capture.mjs --out reviews/round8/ui-shots-before --seed 1337 --only 01-title,14-survivor-select,15-logbook,17-artifacts,18-difficulty,16-run-summary,06-loaded-hud,10-inventory
```

After (Task 6, Step 3, at `d21c6a6`):

```bash
node tools/capture.mjs --out reviews/round8/ui-shots-after --seed 1337 --only 01-title,14-survivor-select,15-logbook,17-artifacts,18-difficulty,16-run-summary,06-loaded-hud,10-inventory
node tools/shotdiff.mjs reviews/round8/ui-shots-before reviews/round8/ui-shots-after --out reviews/round8/ui-shot-diff.json
```

The scenario list is deliberately in that order and deliberately eight long: it
is every screen the slice touches, and `06-loaded-hud` / `10-inventory` /
`16-run-summary` are the three that must run after `lateRun` inside
`capture.mjs`'s own ordering. A ninth scenario (`19-overkill`) exists in the
library from a sibling slice and is not part of this pair.

Both manifests report `subjectsOk: true` and `errorCount: 0`, so every frame in
both sets passed its per-scenario `mustContain` DOM and pixel assertions. No
scenario was excluded for scene noise.

## The measured difference

`reviews/round8/ui-shot-diff.json`, produced by the `shotdiff` command above.

| scenario | meanDiff | maxDiff | pctOver8 |
|---|---:|---:|---:|
| 01-title | 8.797 | 251 | 9.45 |
| 06-loaded-hud | 26.202 | 255 | 38.271 |
| 10-inventory | 25.119 | 255 | 34.841 |
| 14-survivor-select | 14.573 | 251 | 21.735 |
| 15-logbook | 8.836 | 253 | 17.969 |
| 16-run-summary | 17.608 | 255 | 14.643 |
| 17-artifacts | 7.042 | 247 | 13.613 |
| 18-difficulty | 3.547 | 247 | 6.689 |
| **aggregate** | **13.966** | **255** | **19.651** |

Read it the right way round: this is a deliberate whole-surface reskin, so a
*small* diff is the failure mode — it would mean the treatment never reached
that screen. Every one of the eight clears the ~2% `pctOver8` floor the plan set
for investigation, the lowest being `18-difficulty` at 6.689%, which is the
expected floor: that screen is a short option ladder with no bars, so what moved
on it is the type ladder, the panel-head rule and its trace, and nothing else.
The two densest screens moved most, as they should — they carry the most bars.

## The money shot

`reviews/round8/ui-money-shot.png`, with its five numbers in
`reviews/round8/ui-gauge-probe-record.json`.

```bash
node tools/gaugeshot.mjs --seed 1337 --secs 75 --target 150
```

`tools/gaugeshot.mjs` follows `tools/routeprobe.mjs` — real vite server, real
page, the real game through `__GAME__`/`__HARNESS__`, every reading taken off
the live DOM — and adds the photograph. It composes the frame the way a player
would arrive at it: `lateRun()` for a loaded panel, then the world driven along
a rising curve for 75 s of pinned simulation through the two real public levers
(`corruption.feed` and `corruption.bleed`), which is 50 pen samples at the HUD's
1.5 s interval and therefore a complete turnover of the 48-sample ring.

What the record publishes, all read off the live DOM at the instant of capture:

| reading | value |
|---|---|
| world corruption | 150 |
| band | 3 — `Overrun`, `data-band="3"`, fill 79% |
| gradations rendered (`.corruption-grad` `style.left`) | 10.53% / 28.95% / 57.89% / 100% |
| samples in `HUD._trace` | 48 (the ring's cap) |
| last `d` the pen wrote | `M 0.00 9.95 L 2.13 9.91 L 4.26 9.86 L 6.38 9.80 …` (48 points, 0.0046 → 0.7895) |

The gradation percentages are the planet's real band thresholds — 20, 55, 110
and 190 over the 190 top — so the engraving on the gauge is not decoration.

Full frame at the library's own 1600x900, not a crop: the thesis is that the
whole panel reads as one instrument, and a crop would beg that question. It also
keeps the money shot in the same coordinate system as `ui-shots-after/`, so it
can be diffed against `06-loaded-hud` directly.

## The reference

**`reviews/round8/ui-shots-after/` is the reference for future UI work.** Any
later change to `src/ui/*` should be captured with the "after" command above
into a fresh directory and diffed against it; an unexplained non-zero on a
screen the change did not mean to touch is the regression this baseline exists
to catch.

## A note on how these are committed

`.gitignore:18` excludes `reviews/**/*.png`, which is why `9188e91` landed the
"before" manifest with the frames on disk only. That policy is right for the
round-6/7 critique libraries, which are regenerable scratch. It is wrong for
these three, so they are committed with an explicit override:

```bash
git add -f reviews/round8/ui-shots-before reviews/round8/ui-shots-after reviews/round8/ui-money-shot.png
```

The reasoning, in case a later round wants to reverse it: `ui-shots-before/` is
**irreproducible** — the code it photographs no longer exists on any branch — and
it is the on-disk source of every number in the table above; `ui-shots-after/` is
named here as the reference future work diffs against, which a clone has to be
able to read; and the money shot is a spec §3.4 deliverable in its own right.
Roughly 16 MB in total.
