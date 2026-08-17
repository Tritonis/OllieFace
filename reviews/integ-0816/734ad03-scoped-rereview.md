# Scoped re-review — commit 734ad03 (master), diff 4d49a0b..734ad03

Files in scope: `src/ui/hud.css`, `src/core/Harness.js`, `tools/perf.mjs`.
No GPU captures run. No `gh` calls made. No pushes made.

## VERDICT

SPEC: CONFIRMED
QUALITY: READY

## Diff completeness

`git diff 4d49a0b..734ad03 --stat` → exactly the three named files, 65 insertions / 1 deletion.
Read in full; nothing beyond the three adjudicated items is present.

## 1. Settings panel overflow (hud.css:1812-1854)

Verified against the real page: `vite` dev server on port 5275 (`createServer` + `.listen()`),
Playwright Chromium headless, three viewports. Opened Settings via `.screen--title
[data-act="settings"]` after waiting for `.title-word`. (Pre-existing, unrelated `GpuNotice`
overlay intercepted the first click attempt on integrated-graphics headless Chromium; suppressed
robustly by pre-seeding `localStorage['telluric.gpuNoticeDismissed']` via `addInitScript` before
navigation — not a defect in this diff, confirmed by reading `src/ui/GpuNotice.js`.)

Measured (`scrollHeight`/`clientHeight` on `.settings-grid`, bounding rects on `.panel-head` and
the Back button):

| Viewport | grid scrollH | grid clientH | scrolls? | Back in-viewport | Back click → title | head in-viewport |
|---|---|---|---|---|---|---|
| 1366x768 | 608 | 573 | yes (Δ35) | yes | yes | yes (39.75–81) |
| 1280x720 | 608 | 525 | yes (Δ83) | yes | yes | yes (39.75–81) |
| 1920x1080 | 804 | 804 | **no** (equal) | yes | yes | yes (57.3–114.9) |

1366x768 scroll-to-bottom: `grid.scrollTop` set to `scrollHeight` lands at 35 (== `maxScrollTop`
of 35), 17 `.srow` rows total, last row's rect fully inside the grid's own rect — last slider row
reachable, confirmed.

1920x1080: `panelClientHeight` 1021 vs `panelNaturalHeight` (bounding-rect) 1022.98 — the ~2px gap
is border-box vs content-box rounding (`.panel--wide` has borders), not clipping; natural height
sits well under the `calc(100vh - 3em)` = 1032px cap, so the panel is at its natural height and no
scrollbar is engaged. All three viewport assertions in the brief hold.

## 2. Harness.js settings pin (Harness.js:52-68)

- Pin (`ctx.settings.flash/aberration/bloom/motion = 1`) is the second statement in
  `installHarness`, directly after the `setAdaptive` pin and before `dismiss`/`begin`/any
  scenario — no shot can be taken before it runs (`tools/capture.mjs` awaits a scenario before
  shooting, and scenarios don't exist yet at this point in the function).
- Confirmed `ctx.settings` is live and set before `installHarness` runs: `HUD.init()`
  (`src/ui/HUD.js:143-153`) constructs `new Menus(ctx)`, whose constructor
  (`src/ui/Menus.js:187-188`) does `ctx.settings = this.settings` synchronously. `HUD` is added at
  `main.js:108` (`engine.add(new HUD())`), `engine.start()` runs at `main.js:157`, and
  `installHarness(ctx)` isn't called until `main.js:166-168` — strictly after.
- Traced every path that can write settings to disk: `save(settings)` in `Menus.js:2432-2434`
  (`localStorage.setItem(STORE_KEY, ...)`) is a plain function, called only from four explicit
  UI-event handlers (`Menus.js:728, 737, 956, 1409` — slider input, segmented control, Director
  sync, and Reset-to-defaults). `ctx.settings` is a plain object, not a Proxy — direct field
  assignment (what Harness.js does) cannot reach `save()`. No persistence is reachable from the
  harness pin.

## 3. perf.mjs --out validation and mkdir ordering (perf.mjs:14-39)

Traced top-to-bottom: arg parsing (14-20) → bare-`--out` check (28-31, `process.exit(1)` with a
message naming the required path arg) → `mkdirSync(dirname(args.out), { recursive: true })`
(35-39) → **then** `createServer`/`.listen()` (41-42) → `chromium.launch()` (60-64) → navigation
and `measure()` calls (68-110). Both new blocks run before any server, browser, or measurement
exists. The write itself (117-134) has a redundant `mkdirSync` comment only (no second call) —
correct, since directory creation already happened up front.

## npm test

`npm test` at HEAD (734ad03): **80/80 test files passed**, 0 failures.

## Findings

None — no Critical/Major/Minor findings against the three claims. Every claim in the dispatch was
independently reproduced (browser measurements, source trace, or both) rather than taken on the
adjudication's word.

CLEAN: hud.css settings overflow, Harness.js settings pin, perf.mjs --out/mkdir ordering, diff scope, npm test
