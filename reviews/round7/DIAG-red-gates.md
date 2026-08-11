# DIAG: why 06-loaded-hud and 19-overkill are red

Diagnosis only. No code or config was changed. Tree at `1911d79`, clean except
untracked review artifacts. Node v24.15.0, playwright 1.62.1.

---

## Verdict

**The premise is false. Neither gate went red on 2026-08-11, and neither gate is
red "at a commit where it was previously green".**

Both failures are *deterministic functions of capture mode*, not of the day, the
commit, or the environment:

| shot | full run (`node tools/capture.mjs`) | `--only` run |
|---|---|---|
| `06-loaded-hud` | RED, and has been since 2026-08-03 | GREEN |
| `19-overkill` | RED since the day it was written (2026-08-09) | GREEN |

The "previously green" evidence that seeded the belief is a set of **partial
(`--only`) captures** being compared against **full-run** captures. Same tree,
same box, two different scenario orderings, two different answers.

The render-scale hypothesis is refuted, with a positive control (below), not
merely "not found".

---

## The discriminating experiment

Three captures run today at `1911d79` — i.e. *with* the render-scale slice
landed — into my own out dirs on my own ports:

| artifact on disk | mode | result |
|---|---|---|
| `reviews/round7/captures/diag-full/manifest.json` | full run, `--port 5303` | `subjectFailures` = `06-loaded-hud:monsters under load`, `19-overkill:the launched corpse\|the survivor\|the corpse is off the ground it died on` |
| `reviews/round7/captures/diag-red-gates/manifest.json` | `--only 06-loaded-hud`, `--port 5301` | `subjectFailures: []` |
| `reviews/round7/captures/diag-19-only/manifest.json` | `--only 19-overkill`, `--port 5317` | `subjectFailures: []` |

All three: `ready: true`, `clockPinned: true`, `seed: 1337`.

### The control that kills the environmental hypothesis

Today's **full run** reproduces a **pre-slice, two-days-older** capture to the
digit:

```
06-loaded-hud / "monsters under load"
  reviews/round9/shot-control-manifests/shots-before.manifest.json   (mtime 2026-08-09T06:20, partial=false)
    px 815  visibleObjects 8
    perPx  [7,3,24,206,51,35,179,109,86,115]
    perSep [0.87,0.09,0.29,0.45,0.73,0.83,0.11,0.93,0.87,0.95]
    objectFailures [{"i":6,"px":179,"sepP50":0.11}]

  shots-base-71a8d3b/manifest.json                                   (mtime 2026-08-11T11:34, commit 71a8d3b = PRE-slice)
  shots-after/manifest.json                                          (mtime 2026-08-11T11:56, POST-slice)
  reviews/round7/captures/diag-full/manifest.json                    (today, HEAD 1911d79)
    ...all three byte-identical to the block above.
```

And today's `--only 19-overkill` reproduces the 2026-08-09 green to three
decimals:

```
19-overkill / "the corpse is off the ground it died on"
  reviews/round9/money-shot/manifest.json          (2026-08-09T06:14, partial=true, 1 shot)
    liftMetres 0.924  deathGroundY 2.347  rootY 3.271   corpse px 1717  survivor px 976   ok
  reviews/round7/captures/diag-19-only/manifest.json (today, HEAD)
    liftMetres 0.924  deathGroundY 2.347  rootY 3.271   corpse px 1717  survivor px 976   ok
```

A GPU driver change, a playwright/node change, a drawing-buffer size change, or
a leaked render scale cannot produce metrics that are *identical to three
decimals* across two days and across the slice boundary. The environment did not
drift. This is the positive control the prime hypothesis needed and fails.

---

## Prime hypothesis: refuted four ways

1. **Identity of metrics across the slice boundary** (above). Decisive on its own.
2. **The setting cannot exist at old commits.** `_userScale` / `setRenderScale`
   were *introduced* by `d7704bd`: `src/core/RenderPipeline.js:169-170`
   (`this._userScale = 1; this._pinned = false;`) and the `setRenderScale` method
   at `src/core/RenderPipeline.js:400-415`. No commit before `d7704bd` reads any
   render-scale setting from anywhere, so a persisted profile value has nothing
   to bind to at `71a8d3b` or `f2f9f16`.
3. **The pin does what it says, and the harness holds it.**
   `RenderPipeline.setAdaptive(on, scale)` at `src/core/RenderPipeline.js:391-399`
   sets `this._pinned = !on` and forces `this._userScale = 1` before
   `resize()`; `6a24aca` additionally froze the quality-tier cap
   (`src/core/RenderPipeline.js`, `_applyPixelRatio` prefers the frozen cap while
   pinned). `setRenderScale` no-ops entirely while pinned
   (`src/core/RenderPipeline.js:401`).
4. **No persistence path into the capture browser anyway.**
   `tools/capture.mjs:251` uses `chromium.launch()`, not
   `launchPersistentContext` — every run gets a fresh, empty browser profile, so
   no `localStorage` survives between runs. The file-backed profile from
   `48d75f0` is the Electron shell's; the browser build is untouched (the commit
   subject says so, and `tools/capture.mjs` boots a plain vite dev server at
   `tools/capture.mjs:244-248`).

Independent corroboration already on disk:
`reviews/render-scale/capture-regression.txt:50-60` — the static menu screens are
unmoved between base and after (`15-logbook` 0.060 vs 0.060, `16-run-summary`
0.035 vs 0.035). A leaked render scale resamples the whole drawing buffer; it
cannot move the explosion scene and skip the logbook.

---

## Actual root causes

### The gate being tripped

`src/core/Harness.js:2280-2293` — for a `crowd: N` pixel subject, the best `N`
objects by pixel count are ranked and each must clear `ABSENT_PX` (12),
`minPerPx` (`minPx / need`), **and** `minSep`:

```js
c.objectFailures = rank
  .filter((i) => rep.perPx[i] < ABSENT_PX
    || rep.perPx[i] < c.minPerPx || rep.perSep[i] < c.minSep)
```

`c.ok = c.present && c.legibleOk && c.perObjectOk` at `src/core/Harness.js:2404`;
`minSep` defaults to `MIN_SEPARATION` at `src/core/Harness.js:2193`. For
`06-loaded-hud` that resolves to `minPx 300`, `need 3`, `minPerPx 100`,
`minSep 0.25`.

### A. `06-loaded-hud` — a composition regression dated 2026-08-02 → 2026-08-03

The failing object is always slot **#6**, and it always fails on **separation,
never on pixels**:

| full-run manifest | date | px | objectFailures |
|---|---|---|---|
| `reviews/round6/publish-eq/manifest.json` | 2026-08-02 | 2860 (10 objects) | `[]` — **last green full run** |
| `reviews/round7/r3-content/shots/manifest.json` | 2026-08-03 | 763 | `[{"i":6,"px":145,"sepP50":0.17}]` |
| `reviews/round7/r5-audio/shots-full/manifest.json` | 2026-08-03 | 759 | `[{"i":6,"px":135,"sepP50":0.13}]` |
| `shots-t7-before/manifest.json` | 2026-08-08 | 759 | `[{"i":6,"px":135,"sepP50":0.13}]` |
| `reviews/round9/shot-control-manifests/shots-before.manifest.json` | 2026-08-09 | 815 | `[{"i":6,"px":179,"sepP50":0.11}]` |
| `reviews/round7/captures/diag-full/manifest.json` | today, HEAD | 815 | `[{"i":6,"px":179,"sepP50":0.11}]` |

The subject's total pixel budget collapsed from 2860 to ~760-815 between
2026-08-02 and 2026-08-03 — **eight days before the render-scale slice** — and
has been red in every full run since.

`reviews/round7/captures/diag-full/06-loaded-hud.png` shows why: the full run
lands the survivor on a dark flooded stage, and the gated horde is a line of pale
wisp silhouettes read against a brightly lit stone arch. That is a separation
failure of the composition, and the scenario does nothing to compose it — unlike
`overkill()`, `lateRun()` never calls `faceOpenGround()` or re-seats its cast, so
it inherits whatever stage and lighting the 15 scenarios ahead of it left behind.

On a fresh page the same seed composes fine —
`reviews/round7/captures/diag-red-gates/manifest.json`: `px 1213`,
`perPx [6,194,1,263,72,57,215,158,151,96]`,
`perSep [0.59,0.63,0.71,0.67,0.97,0.83,0.31,0.55,0.23,0.67]`,
`objectFailures []` (the three gated slots are 3/6/1 at seps 0.67/0.31/0.63).

### B. `19-overkill` — a known, *documented*, never-enforced limitation

`tools/capture.mjs:191-203` already states it:

> "...on a full run this scenario begins from a dead run; it is captured with
> `--only 19-overkill` against a fresh page, **which is the supported path**."

The comment is right about the constraint and wrong about the mechanism. In
today's full run the survivor is alive (the frame shows 20/20 health, LVL 28) —
what actually breaks is the *siting*. `overkill()` picks its spawn with
`groundAtScreen(0.52, 0.62, ...)` at `src/core/Harness.js:3588`, after
`faceOpenGround()` at `src/core/Harness.js:3570`. In a full run the accumulated
stage is a lake, "open ground" is water, and the hulk is placed at
`deathGroundY 19.475` — the water surface:

```
reviews/round7/captures/diag-full/manifest.json (today) and
reviews/round9/shot-control-manifests/shots-after.manifest.json (2026-08-09), identical:
  the launched corpse   px 0    liftMetres 0
  the survivor          px 0
  corpse off the ground liftMetres 0, deathGroundY 19.475, rootY 19.475
```

`reviews/round7/captures/diag-full/19-overkill.png` is the picture of it: the
camera is aimed at open water, the damage numbers (`46750!`) confirm the kill
landed, and neither the hulk nor the survivor is in frame. `deathGroundY ===
rootY` exactly, so the rig root never moved: the corpse was launched into, or
under, water. `liftMetres 0` under a pinned clock is therefore not a timing race
— it is a body that was never on visible ground.

`RealmHarness.js:487` shows the project already knows this class of problem and
handles it there (`pr._ended = false; pr.ending = null;`). `overkill()` has no
equivalent guard for the stage it inherits.

### C. How "previously green" was manufactured

Every capture cited as green for these shots is `partial: true`:

| manifest | partial | shots | 06 px | 06 result |
|---|---|---|---|---|
| `reviews/round8/ui-shots-before/manifest.json` (2026-08-09) | true | 8 | 1304 | GREEN |
| `reviews/round8/ui-shots-after/manifest.json` (2026-08-09) | true | 8 | 1304 | GREEN |
| `shots-t7-dbg-after/manifest.json` (2026-08-08) | true | 21 | 1305 | GREEN |
| `reviews/round7/captures/diag-red-gates/manifest.json` (today) | true | 1 | 1213 | GREEN |
| — vs — | | | | |
| `shots-t7-before/manifest.json` (2026-08-08, **same day, same tree**) | false | 21 | 759 | RED |

`shots-t7-dbg-after` (partial, GREEN) and `shots-t7-before` (full, RED) are
**twenty minutes apart on 2026-08-08**. That pair alone falsifies "green at this
commit, red now".

Aggravating factor: `tools/capture.mjs:329-333` merges untouched shots forward
out of the previous manifest on an `--only` run, and `subjectFailures` /
`subjectsOk` are then computed over the merged set at
`tools/capture.mjs:415-422`. A partial manifest therefore publishes carried,
possibly days-old shot results indistinguishably from freshly captured ones. Any
reader taking `subjectsOk` off a partial manifest is reading a mixture.

---

## Recommended minimal fix (not implemented)

Priority order. Items 1-3 are the fix; 4 is prophylaxis.

1. **`19-overkill`: enforce the constraint the comment already states.**
   Cheapest correct change: give the scenario entry in `tools/capture.mjs:199-203`
   an `onlyPath: true` flag and skip it (rather than gate it) when `ONLY` does not
   name it. This turns a documented limitation into a mechanical one and takes
   three subject failures off every full run without touching game code.
   *Better but larger:* have `overkill()` compose its own ground the way it
   already composes its own lens — reject a `groundAtScreen` hit whose ground is
   the water plane, and fall back to `ahead(9, 0)` on dry land
   (`src/core/Harness.js:3588-3590`).

2. **`06-loaded-hud`: compose the horde instead of inheriting it.** `lateRun()`
   should do what `overkill()` does at `src/core/Harness.js:3570` and
   `3610-3618` — `faceOpenGround()`, then re-seat the gated cast via
   `groundAtScreen` — so the three gated monsters are placed against chosen
   background rather than against whatever arch the previous fifteen scenarios
   left in frame. Do **not** lower `minSep` below 0.25; the gate is reporting a
   real legibility failure that the PNG confirms.

3. **Correct the memory note** `capture-gates-red-since-2026-08-11`. Its dating
   ("since 2026-08-11"), its attribution ("environmental drift"), and its
   `19-overkill` mechanism ("time-sensitive race under a pinned clock") are all
   wrong. Replace with: *06-loaded-hud has been red in full runs since
   2026-08-03; 19-overkill is red in full runs by construction and green on its
   documented `--only` path; compare like-for-like capture modes.*

4. **Stop partial manifests from laundering stale results.** Tag carried entries
   in `tools/capture.mjs:329-333` (e.g. `carried: true`, plus the manifest
   timestamp they came from), and exclude carried shots from `subjectsOk` — or at
   minimum surface `carriedShots: [...]` beside `subjectFailures`. This is the
   mechanism that let a green partial be read as a green gate.

Do not attempt 1 or 2 as a "make it green" edit without re-running the
full/`--only` pair above; the pair is the only control that distinguishes a real
fix from a re-composition that happens to clear the threshold.

---

## Ruled out, explicitly

- Render-scale setting persisting via localStorage or the desktop profile file — refuted 4 ways above.
- Drawing-buffer / resolution change — `reviews/render-scale/capture-regression.txt:50-60`, plus metric identity across the slice boundary.
- playwright / node / GPU driver drift — metric identity between 2026-08-09 and today rules out any environmental change.
- Clock pinning failure — `clockPinned: true` and `determinism: {"clockPinned":true,"frameDt":0.016666666666666666,"frameTimeouts":0}` in `reviews/round7/captures/diag-red-gates/manifest.json`.
- A regression introduced by `d7704bd` / `2fa1d77` / `6a24aca` — `shots-base-71a8d3b` (pre-slice) and `shots-after` (post-slice), both captured 2026-08-11, carry identical failure metrics.
