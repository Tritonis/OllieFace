# Render Scale / DPI Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player direct control over drawing-buffer resolution — a "Render scale" slider (50–100%) and a "Dynamic resolution" Auto/Off switch — wired into the existing adaptive-resolution pipeline without disturbing the capture harness's pinned-resolution path.

**Architecture:** The pixel-ratio computation moves out of `RenderPipeline._applyPixelRatio` into a pure, node-testable function (`src/core/ResolutionMath.js`). `RenderPipeline` gains a `setRenderScale(scale, dynamic)` entry point that `Menus.apply()` pushes on every settings change, and the existing harness-only `setAdaptive(false, scale)` becomes a *pin* that makes `setRenderScale` a no-op — a screenshot tool must control its own resolution, and a player's saved 50% scale must never leak into a capture. The settings screen reuses its existing slider and segmented-control patterns; persistence rides the existing numeric-only `load()`/`save()` (both new keys are numbers).

**Tech Stack:** Vanilla JS + three.js; repo's frameworkless `tests/*.test.mjs` convention (standalone file, `ok(cond,msg)`, exit non-zero); Playwright probes (`tools/menuprobe.mjs`) under headed d3d11.

## Global Constraints

- `Harness.js:58` calls `ctx.pipeline?.setAdaptive?.(false, 1)` at boot — after this pin, NO settings write may change the drawing-buffer scale. Pin ordering must be safe in both directions (apply-then-pin and pin-then-apply).
- `Menus.load()` (src/ui/Menus.js:2128) only adopts values that are `typeof parsed[k] === 'number' && Number.isFinite` — every new settings key must be a number (`dynamicRes` is `1`/`0`, not a boolean).
- The effective pixel ratio with defaults (`renderScale: 1.0`, `dynamicRes: 1`) must be **bit-identical** to today's `ratio * this._resScale` — proven by capture regression against the named baseline `shots-base-71a8d3b/` (captured from clean HEAD `71a8d3b` before Task 1; see Task 3).
- Zero lines changed in `Player.js`, `NetClient.js`, `Protocol.js`, `Harness.js` — this slice is pipeline + settings UI only.
- Bash tool commands are ASCII-only (use Write/Edit for any Unicode); never run bare `npx` (it destroys the rolldown binding package.json).
- Probes run headed d3d11 with the same launch flags as `tools/menuprobe.mjs:37-43` (same-renderer rule); stagger ports if anything else is running.

**Slice base:** `71a8d3b` on `master`. Rationale: last unblocked STEAM.md §6 engineering row ("DPI / render-scale settings", 1–2 days, Low); everything else needs the Steam app id, an Optimus laptop, or the user.

---

### Task 0: Capture and verify the named baseline (BEFORE any code)

**Status: DONE 2026-08-11 by the main session, before Task 1 existed.** Recorded here per pre-flight amendment B1 so the ordering is explicit and auditable — a baseline shot from the post-change tree makes the base-vs-after diff pass vacuously.

- [x] **Step 1: Verify clean base** — `git status` clean of `src/` changes, `git rev-parse HEAD` = `71a8d3b80b74e46d6c45084929954ef914976ed7`. Verified.
- [x] **Step 2: Capture** — `node tools/capture.mjs --out shots-base-71a8d3b` (all 21 PNGs written) and a second run `--out shots-base-71a8d3b-run2` (the same-commit control pair for the shotdiff envelope).
- [x] **Step 3: Record the known-red subjects** — capture exits 1 at clean base: `06-loaded-hud` (monster #6 sepP50 0.11 < 0.25) and `19-overkill` (liftMetres 0; corpse + survivor px 0). Reproduced 3x byte-identical, including at `f2f9f16` in a throwaway worktree — pre-existing environmental drift or scenario race, NOT slice code (see slice ledger). Task 3's gate is therefore: **identical subject-failure set (exactly those two) + shotdiff within the run1-vs-run2 control envelope.**

---

### Task 1: Pure resolution math + RenderPipeline wiring

**Files:**
- Create: `src/core/ResolutionMath.js`
- Modify: `src/core/RenderPipeline.js` (constructor state near line 157, `_applyPixelRatio` at 307–318, `setAdaptive` at 389–395, new `setRenderScale` beside it)
- Test: `tests/render-scale.test.mjs`

**Interfaces:**
- Consumes: nothing new — `PIXEL_BUDGET` (RenderPipeline.js:56), `QUALITY` tiers, `this._resScale` / `this._adaptOn` / `this._frameMs` (existing adaptive state).
- Produces: `effectivePixelRatio({dpr, qualityCap, budget, width, height, userScale, adaptScale}) -> number` (exported from ResolutionMath.js); `RenderPipeline.setRenderScale(scale: number, dynamic: boolean) -> void` (Task 2 calls it via `ctx.pipeline?.setRenderScale?.(...)`); `RenderPipeline._pinned: boolean` (true after `setAdaptive(false, ...)`; Task 3's probe asserts around it).

- [ ] **Step 1: Write the failing test**

Create `tests/render-scale.test.mjs` (repo idiom: standalone, `ok`, exit non-zero):

```javascript
import { effectivePixelRatio } from '../src/core/ResolutionMath.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const close = (a, b) => Math.abs(a - b) < 1e-9;

const base = { dpr: 1, qualityCap: 2, budget: 5.0e6, width: 1600, height: 900, userScale: 1, adaptScale: 1 };

// 1. Identity: 1080p-class window, dpr 1, everything at 1 -> ratio 1.
ok(close(effectivePixelRatio(base), 1), 'defaults pass dpr through untouched');

// 2. Quality cap: dpr 2 on the low tier (cap 1) is clamped to 1.
ok(close(effectivePixelRatio({ ...base, dpr: 2, qualityCap: 1 }), 1), 'quality cap clamps high-DPI down');

// 3. Pixel budget: dpr 2 at 2560x1440 CSS pixels busts the 5MP budget.
//    budget term = sqrt(5e6 / (2560*1440)) = 1.16451..., so ratio = 1.16451, not 2.
const busted = effectivePixelRatio({ ...base, dpr: 2, width: 2560, height: 1440 });
ok(close(busted, Math.sqrt(5.0e6 / (2560 * 1440))), `pixel budget clamps a 4K buffer (${busted})`);

// 4. Budget floor: the budget clamp never pushes the ratio below 1 on huge
//    windows — that is the adaptive controller's job, not the budget's.
ok(close(effectivePixelRatio({ ...base, width: 3840, height: 2160 }), 1), 'budget clamp floors at 1');

// 5. User scale multiplies after the clamps and may go below 1.
ok(close(effectivePixelRatio({ ...base, userScale: 0.5 }), 0.5), 'userScale halves the ratio');

// 6. Adaptive scale composes with user scale.
ok(close(effectivePixelRatio({ ...base, userScale: 0.8, adaptScale: 0.75 }), 0.6), 'userScale and adaptScale compose');

// 7. Zero-size window: clamps are skipped, scales still apply (matches the
//    old guard `if (w > 0 && h > 0)`).
ok(close(effectivePixelRatio({ ...base, width: 0, height: 0, userScale: 0.5 }), 0.5), 'zero-size window skips the budget clamp');

// 8. Today's exact formula with userScale 1 — the capture-regression invariant.
for (const [w, h, dpr, cap, adapt] of [[1600, 900, 1, 2, 1], [1920, 1080, 1.5, 1.5, 0.85], [2560, 1440, 2, 2, 0.55]]) {
  let old = Math.min(dpr, cap);
  const b = Math.sqrt(5.0e6 / (w * h));
  old = Math.min(old, Math.max(1, b));
  old *= adapt;
  const now = effectivePixelRatio({ dpr, qualityCap: cap, budget: 5.0e6, width: w, height: h, userScale: 1, adaptScale: adapt });
  ok(close(now, old), `userScale 1 reproduces the old formula at ${w}x${h} dpr ${dpr}`);
}

console.log(fail ? `FAIL (${fail})` : `PASS (${pass})`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/render-scale.test.mjs`
Expected: FAIL — `Cannot find module ... ResolutionMath.js`

- [ ] **Step 3: Create `src/core/ResolutionMath.js`**

```javascript
/**
 * The one place the drawing-buffer scale is computed. Pure — no DOM, no
 * renderer — so the clamp order is testable in node without a WebGL context.
 *
 * Order matters and is load-bearing: the quality cap and pixel budget exist to
 * stop the ratio *climbing* on high-DPI panels, so they clamp first and the
 * budget term never drops below 1. The two scales multiply last and are
 * allowed to take the ratio below 1 — `userScale` is the player's Render
 * scale setting (a hard ceiling they chose), `adaptScale` is the adaptive
 * controller's live correction underneath it.
 */
export function effectivePixelRatio({ dpr, qualityCap, budget, width, height, userScale = 1, adaptScale = 1 }) {
  let ratio = Math.min(dpr, qualityCap);
  if (width > 0 && height > 0) {
    const b = Math.sqrt(budget / (width * height));
    ratio = Math.min(ratio, Math.max(1, b));
  }
  return ratio * userScale * adaptScale;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/render-scale.test.mjs`
Expected: PASS (all checks)

- [ ] **Step 5: Wire RenderPipeline through it**

In `src/core/RenderPipeline.js`:

a) Add the import at the top with the other local imports:

```javascript
import { effectivePixelRatio } from './ResolutionMath.js';
```

b) In the constructor, next to the existing `this._resScale = 1;` (line ~159), add:

```javascript
    // The player's Render scale setting — a ceiling multiplied in alongside
    // the adaptive correction. `_pinned` is the capture harness's lock: while
    // held, the settings screen cannot move the drawing-buffer scale at all.
    this._userScale = 1;
    this._pinned = false;
```

c) Replace the body of `_applyPixelRatio()` (keep its doc comment):

```javascript
  _applyPixelRatio() {
    const max = this.quality >= QUALITY.HIGH ? 2 : this.quality >= QUALITY.MEDIUM ? 1.5 : 1;
    this.renderer.setPixelRatio(effectivePixelRatio({
      dpr: devicePixelRatio, qualityCap: max, budget: PIXEL_BUDGET,
      width: innerWidth, height: innerHeight,
      userScale: this._userScale, adaptScale: this._resScale,
    }));
  }
```

d) Replace `setAdaptive` (keep its doc comment, extend it):

```javascript
  /** Turn adaptive resolution off and pin the scale (used by the capture
   *  harness — a screenshot tool must control its own resolution). Pinning
   *  also locks out `setRenderScale` and clears any player Render scale, so
   *  a capture can never inherit a saved 50% setting. */
  setAdaptive(on, scale = 1) {
    this._adaptOn = on;
    this._pinned = !on;
    if (!on) {
      this._userScale = 1;
      this._resScale = scale;
      this.resize();
    }
  }
```

e) Add `setRenderScale` directly below `setAdaptive`:

```javascript
  /** The player's knobs, pushed by `Menus.apply()` on every settings change.
   *  `scale` (0.5..1) is a hard ceiling on the drawing-buffer scale; `dynamic`
   *  arms or disarms the adaptive controller underneath it. No-ops entirely
   *  while the capture harness holds the pin. */
  setRenderScale(scale, dynamic = true) {
    if (this._pinned) return;
    const s = Math.min(1, Math.max(0.5, Number(scale) || 1));
    const on = !!dynamic;
    if (s === this._userScale && on === this._adaptOn) return;
    this._userScale = s;
    this._adaptOn = on;
    // Disarming hands the whole scale to the player: the adaptive term resets
    // so the buffer sits exactly where the slider says. Stale controller state
    // goes with it — the frame samples and the remembered failure were both
    // measured under a different userScale basis.
    if (!on) this._resScale = 1;
    this._frameMs.length = 0;
    this._failedAt = Infinity;
    this._sinceFail = 0;
    this.resize();
  }
```

- [ ] **Step 6: Verify the constructor initialises `_adaptOn` (verify-only — pre-flight confirmed `this._adaptOn = true` exists at RenderPipeline.js:160; no edit should result)**

Also verify `_failedAt`/`_sinceFail` have constructor inits (they are reset by Step 5e); if absent, initialise `this._failedAt = Infinity; this._sinceFail = 0;` beside `_resScale`.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all test files pass (the new one included; nothing else touches this seam headlessly).

- [ ] **Step 8: Commit**

```bash
git add src/core/ResolutionMath.js src/core/RenderPipeline.js tests/render-scale.test.mjs
git commit -m "feat: pure pixel-ratio math with a player render-scale ceiling and a capture pin"
```

---

### Task 2: Settings UI + persistence

**Files:**
- Modify: `src/ui/Menus.js` — `DEFAULTS` (line ~52), `SLIDERS` (line ~72), `buildSettings` (line ~599), `syncSettings` (line ~636), `apply` (line ~1128)

**Interfaces:**
- Consumes: `RenderPipeline.setRenderScale(scale, dynamic)` from Task 1 (guarded call — pipeline may not exist yet, matching the `setQuality` idiom).
- Produces: settings keys `renderScale` (number, 0.5–1.0, default 1.0) and `dynamicRes` (number, 1 = Auto / 0 = Off, default 1) — persisted by the existing `save()`/`load()` (numeric filter passes both); Task 3's probe reads them from `localStorage['telluric.settings']`.

- [ ] **Step 1: Add the two keys to `DEFAULTS`**

```javascript
const DEFAULTS = {
  quality: 2,
  fov: 70,
  sensitivity: 1.0,
  master: 0.8,
  sfx: 0.9,
  music: 0.6,
  shake: 1.0,
  spawnRate: 1.0,
  padSensitivity: 1.0,
  renderScale: 1.0,
  // 1 = Auto (adaptive controller live), 0 = Off (pinned at renderScale).
  // A number, not a boolean: `load()` only adopts finite numbers.
  dynamicRes: 1,
};
```

- [ ] **Step 2: Add the slider row**

Insert as the FIRST entry of `SLIDERS` (so it renders directly under the Quality preset / Dynamic resolution rows — the display block stays together):

```javascript
const SLIDERS = [
  { key: 'renderScale', label: 'Render scale', min: 0.5, max: 1, step: 0.05, fmt: pct },
  { key: 'fov', label: 'Field of view', min: 60, max: 110, step: 1, fmt: (v) => `${v | 0}°` },
  // ... rest unchanged
```

- [ ] **Step 3: Add the Dynamic resolution segmented row and generalise the seg handler**

In `buildSettings()`, directly after the `Quality preset` row:

```javascript
    html += row('Dynamic resolution',
      `<div class="sseg" data-seg="dynamicRes">
         <button class="segbtn" data-nav data-val="1">Auto</button>
         <button class="segbtn" data-nav data-val="0">Off</button>
       </div>`);
```

Replace the click handler (it is currently hard-coded to `quality`):

```javascript
    host.addEventListener('click', (e) => {
      const seg = e.target.closest('.segbtn');
      if (!seg) return;
      const key = seg.closest('[data-seg]')?.dataset.seg;
      if (!key) return;
      this.settings[key] = Number(seg.dataset.val);
      this.apply();
      save(this.settings);
    });
```

- [ ] **Step 4: Generalise `syncSettings` over every seg control**

Replace the quality-specific loop at the bottom of `syncSettings()`:

```javascript
    for (const wrap of this.root.querySelectorAll('[data-seg]')) {
      const key = wrap.dataset.seg;
      for (const b of wrap.querySelectorAll('.segbtn')) {
        b.classList.toggle('is-on', Number(b.dataset.val) === this.settings[key]);
      }
    }
```

- [ ] **Step 5: Push the settings from `apply()`**

Directly after the `ctx.pipeline?.setQuality?.(settings.quality);` line:

```javascript
    // Same single-hook rule as quality: one guarded call, the pipeline owns
    // the clamp order and the capture pin. `dynamicRes` is numeric on disk.
    ctx.pipeline?.setRenderScale?.(settings.renderScale, settings.dynamicRes !== 0);
```

- [ ] **Step 6: Eyeball the settings screen in the dev server**

Run: `npm run dev`, open the browser, Settings from the title screen.
Expected: "Dynamic resolution" Auto/Off row under Quality preset; "Render scale" slider at the top of the sliders showing `100%`; dragging it to 50% visibly softens the image; Off pins it; both survive a reload. (Headless DOM assertions for this screen are impossible — the settings screen is DOM-coupled; the binding proof is Task 3's probe, same carriage as the gamepad slice's settings dial.)

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS (no headless test touches Menus).

- [ ] **Step 8: Commit**

```bash
git add src/ui/Menus.js
git commit -m "feat: render scale slider and dynamic resolution switch in settings"
```

---

### Task 3: Probe proof + regression gates

**Files:**
- Modify: `tools/menuprobe.mjs` (append a settings section before `browser.close()`, line ~99)
- Create: `reviews/render-scale/` — probe record, shotdiff manifests

**Interfaces:**
- Consumes: settings keys `renderScale`/`dynamicRes` (Task 2), `__GAME__.ctx.pipeline` internals `_adaptOn`/`_resScale`/`_pinned` (Task 1), `renderer.getPixelRatio()`.
- Produces: extended menuprobe (the permanent gate for this slice); committed shotdiff manifests proving the default path unchanged.

**Baseline note (do this BEFORE Task 1 if not already done):** capture the shot baseline from the clean base commit — `git status` clean at `71a8d3b`, then `npm run shots -- --out shots-base-71a8d3b` (check `tools/capture.mjs --help`/header for the exact out flag; if it takes no flag, rename the default output dir to `shots-base-71a8d3b` after the run). The on-disk baseline is the named source every before/after claim cites.

- [ ] **Step 1: Extend `tools/menuprobe.mjs`**

Append after the tooltip section (before `await browser.close()`):

```javascript
// ---------------------------------------------------------- render scale
// From pause into settings, with the run live underneath: the menus are open,
// so the adaptive controller is frozen (`_adapt` returns while paused) and
// the pixel ratio can only move because the slider moved it.
await page.click('.screen--pause [data-act="settings"]');  // scoped: the title screen carries the same data-act (pre-flight P1)
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'settings');
ok(await page.locator('input[data-key="renderScale"]').count() === 1, 'the settings screen carries a Render scale slider');
ok(await page.locator('[data-seg="dynamicRes"] .segbtn').count() === 2, 'the Dynamic resolution switch drew both positions');

const ratioBefore = await page.evaluate(() => __GAME__.ctx.pipeline.renderer.getPixelRatio());
await page.locator('input[data-key="renderScale"]').evaluate((el) => {
  el.value = '0.5';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const ratioAfter = await page.evaluate(() => __GAME__.ctx.pipeline.renderer.getPixelRatio());
ok(Math.abs(ratioAfter - ratioBefore * 0.5) < 1e-3,
  `render scale 50% halves the drawing-buffer ratio (${ratioBefore.toFixed(3)} -> ${ratioAfter.toFixed(3)})`);
ok((await page.textContent('output[data-out="renderScale"]')).trim() === '50%', 'the readout says 50%');

await page.click('[data-seg="dynamicRes"] [data-val="0"]');
const dyn = await page.evaluate(() => ({
  adaptOn: __GAME__.ctx.pipeline._adaptOn,
  resScale: __GAME__.ctx.pipeline._resScale,
  stored: JSON.parse(localStorage.getItem('telluric.settings')),
}));
ok(dyn.adaptOn === false, 'Off disarms the adaptive controller');
ok(dyn.resScale === 1, 'Off resets the adaptive term so the slider owns the buffer');
ok(dyn.stored.renderScale === 0.5 && dyn.stored.dynamicRes === 0, 'both settings persisted to localStorage');
await shot('06-render-scale.png');

// Reload: the saved settings must come back and land on the pipeline at boot.
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title', null, { timeout: 60000 });
const boot = await page.evaluate(() => ({
  userScale: __GAME__.ctx.pipeline._userScale,
  adaptOn: __GAME__.ctx.pipeline._adaptOn,
  pinned: __GAME__.ctx.pipeline._pinned,
}));
ok(boot.pinned === false || (boot.userScale === 1),
  'a pinned pipeline ignored the saved scale; an unpinned one may adopt it');
ok(boot.pinned || (boot.userScale === 0.5 && boot.adaptOn === false),
  `saved render scale survives a reload (userScale ${boot.userScale}, dynamic ${boot.adaptOn})`);
```

Update the final PASS line's description to mention render scale.

- [ ] **Step 2: Run the extended probe**

Run: `node tools/menuprobe.mjs`
Expected: all original checks PASS plus the new render-scale checks; exit 0. Copy the console record to `reviews/render-scale/menuprobe-record.txt`. In the record, note two things per pre-flight P2/A: (a) the reload block's first assertion is vacuous in menuprobe (which never pins) — the pin property is proven by the capture control envelope, not this probe; (b) the menu portrait/preview canvases (`Logbook.js:68`, survivor-select preview) own their own pixel ratios and are a documented non-goal of the slider.

- [ ] **Step 3: Negative control**

Temporarily revert the `apply()` line from Task 2 Step 5 (comment it out), run `node tools/menuprobe.mjs`, and confirm the ratio check FAILS — the probe is load-bearing. Restore the line, re-run, confirm PASS. Note both runs in the record file.

- [ ] **Step 4: Capture regression against the named baseline**

```bash
npm run shots -- --out shots-after
node tools/shotdiff.mjs shots-base-71a8d3b shots-after --out reviews/render-scale/diff-base-vs-after.json
npm run shots -- --out shots-control
node tools/shotdiff.mjs shots-after shots-control --out reviews/render-scale/diff-control.json
```

Expected: the base-vs-after aggregate sits inside the same-tree control's envelope (capture is not byte-deterministic; the control run IS the threshold). The capture harness pins via `setAdaptive(false, 1)`, which now also forces `_userScale = 1` — any drift here means the pin leaked.

- [ ] **Step 5: Full gate sweep**

```bash
npm test
node tools/padprobe.mjs
```

Expected: suite green; padprobe 21/21 (it drives settings adjacent DOM — proves the seg-handler generalisation broke nothing).

- [ ] **Step 6: Commit**

```bash
git add tools/menuprobe.mjs reviews/render-scale/
git commit -m "test: menuprobe proves the render scale slider, the pin, and the reload path"
```

---

## Self-Review Notes

- **Spec coverage:** STEAM.md row is "DPI / render-scale settings". DPI is already governed (quality-tier `devicePixelRatio` caps + `PIXEL_BUDGET`); what was missing was player control and a testable seam — both delivered. Supersampling (>100%) deliberately excluded: the budget/cap clamps exist to stop the ratio climbing, and YAGNI.
- **Pin ordering:** boot order `Menus.apply()` vs `Harness` pin is safe both ways — `setAdaptive(false, …)` resets `_userScale` after any earlier apply; `_pinned` blocks any later apply.
- **Type consistency:** `setRenderScale(scale:number, dynamic:boolean)` is the only new cross-task signature; Task 2 calls it exactly so; Task 3 asserts its state fields `_userScale`/`_adaptOn`/`_pinned` as defined in Task 1.
- **Known non-goals:** integrated-GPU boot preset (`_resScale = 0.75`) interaction with Off is intentional — Off resets the adaptive term and the player's slider becomes the whole story, which is what "Off" promises.
