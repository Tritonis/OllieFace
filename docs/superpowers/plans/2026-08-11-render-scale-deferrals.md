# Render-Scale Deferral Bundle (B4/B7/B5/B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four deferred findings from the render-scale slice's final review (`.superpowers/sdd/2026-08-11-render-scale-settings/final-review.md`): B5 (zero maps to full scale), B2 (unpin strands the player's scale), B4 (corrupt persisted values desync the settings UI), B7 (the slider is a ceiling but presented as the scale).

**Architecture:** Two files change: `src/core/RenderPipeline.js` (B5, B2 — input coercion and unpin semantics, both covered by the existing state-machine-probe unit test) and `src/ui/Menus.js` (B4, B7 — clamp on `load()`, ceiling-aware readout, both covered by `tools/menuprobe.mjs` browser checks). No new files, no new dependencies.

**Tech Stack:** Vanilla ES modules, `node tests/run.mjs` unit suite, Playwright-driven probes (`tools/menuprobe.mjs`, `tools/padprobe.mjs`) against the Vite dev server on d3d11.

## Global Constraints

- **Capture-pin invariant is sacred:** `setAdaptive(false, scale)` behaviour must be bit-identical after this slice — the pin, the frozen quality cap, `_userScale = 1`, `_resScale = scale`. Any change there poisons every screenshot gate. `src/core/Harness.js:58` is the only production caller and passes `(false, 1)`.
- **Do not touch** `src/core/ResolutionMath.js`, `tools/capture.mjs`, or any `SCENARIOS` entry.
- **Bash tool is ASCII-only** on this box: any file content with non-ASCII (degree sign in `Menus.js` slider fmt, em-dashes in comments) goes through Write/Edit, never through a shell heredoc or `echo`.
- **Never run bare `npx`** (it deletes the rolldown binding's package.json). Use `node node_modules/vite/bin/vite.js` and `node tools/<probe>.mjs` directly.
- **Probe ports:** stagger — menuprobe `--port 5211`, padprobe `--port 5212`, any capture `--only` smoke `--port 5213`. Kill your own dev-server process when done.
- **Commit style:** this repo's messages are single evocative sentences describing what changed semantically (see `git log --oneline`). End with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- Comment density and idiom must match the surrounding files — both touched files carry design-rationale comments; new behaviour gets one, restated mechanics get none.

---

### Task 1: B5 — `setRenderScale(0)` must clamp to the floor, not snap to full scale

**Files:**
- Modify: `src/core/RenderPipeline.js:424` (inside `setRenderScale`)
- Test: `tests/render-scale.test.mjs` (append to the existing state-machine-probe block pattern)

**Interfaces:**
- Consumes: `RenderPipeline.prototype.setRenderScale(scale, dynamic)` — existing signature, unchanged.
- Produces: coercion rule later tasks may rely on: any finite number clamps into `[0.5, 1]`; only non-finite input (NaN, undefined, `'abc'`) falls back to `1`.

- [ ] **Step 1: Write the failing test**

Append to `tests/render-scale.test.mjs` a new probe block (same fixture idiom as check 9 — `Object.create(RenderPipeline.prototype)` against a fake renderer):

```javascript
// 10. B5 regression: `Number(scale) || 1` absorbed 0 along with NaN, so a
//     caller passing a legitimate zero got FULL scale instead of the floor.
//     Finite input clamps into [0.5, 1]; only non-finite input falls back to 1.
{
  globalThis.devicePixelRatio = 1;
  globalThis.innerWidth = 1600;
  globalThis.innerHeight = 900;
  const renderer = {
    _ratio: 1,
    setPixelRatio(r) { this._ratio = r; },
    getPixelRatio() { return this._ratio; },
    setSize() {},
  };
  const rp = Object.create(RenderPipeline.prototype);
  rp.renderer = renderer;
  rp.composer = null;
  rp.passes = {};
  rp.ctx = null;
  rp.quality = QUALITY.ULTRA;
  rp._userScale = 1;
  rp._resScale = 1;
  rp._adaptOn = true;
  rp._pinned = false;
  rp._frameMs = [];
  rp._failedAt = Infinity;
  rp._sinceFail = 0;

  rp.setRenderScale(0, false);
  ok(close(rp._userScale, 0.5), `setRenderScale(0) clamps to the 0.5 floor, not full scale (${rp._userScale})`);

  rp.setRenderScale(NaN, false);
  ok(close(rp._userScale, 1), `setRenderScale(NaN) falls back to 1 (${rp._userScale})`);

  rp.setRenderScale('0.7', false);
  ok(close(rp._userScale, 0.7), `setRenderScale('0.7') coerces the numeric string (${rp._userScale})`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/run.mjs 2>&1 | grep -A2 "clamps to the 0.5 floor"`
Expected: FAIL on the first new assertion (`_userScale` reads 1, not 0.5). The NaN and string checks pass already — they document the preserved behaviour.

- [ ] **Step 3: Write minimal implementation**

In `src/core/RenderPipeline.js`, `setRenderScale`, replace:

```javascript
    const s = Math.min(1, Math.max(0.5, Number(scale) || 1));
```

with:

```javascript
    // `|| 1` would absorb a legitimate 0 along with NaN and send a caller
    // asking for the minimum to full scale instead. Only non-finite input
    // falls back; every finite number takes the clamp.
    const n = Number(scale);
    const s = Math.min(1, Math.max(0.5, Number.isFinite(n) ? n : 1));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.mjs`
Expected: all files pass, including the three new assertions.

- [ ] **Step 5: Commit**

```bash
git add src/core/RenderPipeline.js tests/render-scale.test.mjs
git commit -m "Zero asks for the floor and gets it, instead of the ceiling"
```

(Include the co-author trailer via a second `-m` or commit-file; do not use a heredoc.)

---

### Task 2: B2 — unpinning hands the scale back to the player, not to a hardcoded 1

**Files:**
- Modify: `src/core/RenderPipeline.js:402-416` (`setAdaptive`)
- Test: `tests/render-scale.test.mjs`

**Interfaces:**
- Consumes: `RenderPipeline.prototype.setAdaptive(on, scale)`; the `settings` getter at `src/core/RenderPipeline.js:441` (`this.ctx?.settings ?? globalThis.__GAME__?.ctx?.settings ?? null`); the coercion rule from Task 1.
- Produces: `setAdaptive(true)` now restores `_userScale` from `ctx.settings.renderScale` (clamped `[0.5, 1]`) and `_adaptOn` from `ctx.settings.dynamicRes !== 0` when a settings object is reachable; with no settings reachable, behaviour is unchanged from today (adaptive on, `_userScale` untouched).

**Background for the implementer:** today `setAdaptive(true)` clears `_pinned` but leaves `_userScale` at the `1` the pin forced, so a player who had 50% saved renders at full scale until the next `Menus.apply()`. Note the pin branch (`!on`) in the current tree already carries the B1 quality-cap freeze (`_pinnedQualityCap`, `RenderPipeline.js:405-411`, landed after the final review) — "byte-identical" includes those lines. The final review's probe: `setRenderScale(0.5, true); setAdaptive(false, 1); setAdaptive(true)` → ratio 1, player had 0.5. The only production caller of `setAdaptive` is the capture harness's pin (`false, 1`); the `true` path is reachable through the harness bridge (`src/core/Harness.js:5849`) and future callers. The pin path (`!on`) must not change at all.

- [ ] **Step 1: Write the failing test**

Append to `tests/render-scale.test.mjs`:

```javascript
// 11. B2 regression: unpinning stranded the player's scale. After
//     setAdaptive(true), the pipeline must re-adopt the saved knobs from
//     ctx.settings rather than keep the pin's userScale = 1.
{
  globalThis.devicePixelRatio = 1;
  globalThis.innerWidth = 1600;
  globalThis.innerHeight = 900;
  const renderer = {
    _ratio: 1,
    setPixelRatio(r) { this._ratio = r; },
    getPixelRatio() { return this._ratio; },
    setSize() {},
  };
  const rp = Object.create(RenderPipeline.prototype);
  rp.renderer = renderer;
  rp.composer = null;
  rp.passes = {};
  rp.ctx = { settings: { renderScale: 0.5, dynamicRes: 0 } };
  rp.quality = QUALITY.ULTRA;
  rp._userScale = 1;
  rp._resScale = 1;
  rp._adaptOn = true;
  rp._pinned = false;
  rp._frameMs = [];
  rp._failedAt = Infinity;
  rp._sinceFail = 0;

  rp.setRenderScale(0.5, false);
  rp.setAdaptive(false, 1);
  ok(close(renderer.getPixelRatio(), 1) && rp._pinned === true,
    'the pin still forces ratio 1 regardless of the saved 50%');

  rp.setAdaptive(true);
  ok(rp._pinned === false && close(rp._userScale, 0.5),
    `unpinning restores the player's saved 50% (${rp._userScale})`);
  ok(rp._adaptOn === false,
    'unpinning also restores the saved Dynamic resolution Off');
  ok(close(renderer.getPixelRatio(), 0.5),
    `the restored scale reaches the drawing buffer (${renderer.getPixelRatio()})`);

  // With no settings object reachable, today's behaviour is preserved.
  const rp2 = Object.create(RenderPipeline.prototype);
  rp2.renderer = { _ratio: 1, setPixelRatio(r) { this._ratio = r; }, getPixelRatio() { return this._ratio; }, setSize() {} };
  rp2.composer = null; rp2.passes = {}; rp2.ctx = null;
  rp2.quality = QUALITY.ULTRA;
  rp2._userScale = 1; rp2._resScale = 1; rp2._adaptOn = true; rp2._pinned = false;
  rp2._frameMs = []; rp2._failedAt = Infinity; rp2._sinceFail = 0;
  rp2.setAdaptive(false, 1);
  rp2.setAdaptive(true);
  ok(rp2._pinned === false && close(rp2._userScale, 1) && rp2._adaptOn === true,
    'with no settings reachable, unpin behaves exactly as before');
}
```

Note: `globalThis.__GAME__` must not be set by an earlier block; if a prior test set it, delete it at the top of this block.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/run.mjs 2>&1 | grep -B1 -A6 "unpinning restores"`
Expected: FAIL on "unpinning restores the player's saved 50%" (`_userScale` stays 1) and the two assertions after it.

- [ ] **Step 3: Write minimal implementation**

In `src/core/RenderPipeline.js`, `setAdaptive`, add an `else` branch to the existing `if (!on)`:

```javascript
    } else {
      // Unpinning hands control back to the player. Without this, the pin's
      // forced userScale = 1 survives until the next Menus.apply() and a
      // saved 50% silently renders at full scale (final-review B2 /
      // pre-flight S2). No settings reachable -> nothing to restore.
      const st = this.settings;
      if (st && Number.isFinite(st.renderScale)) {
        this._userScale = Math.min(1, Math.max(0.5, st.renderScale));
        this._adaptOn = st.dynamicRes !== 0;
        if (!this._adaptOn) this._resScale = 1;
        this._frameMs.length = 0;
        this._failedAt = Infinity;
        this._sinceFail = 0;
        this.resize();
      }
    }
```

The pin branch (`!on`) is byte-identical to before.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/run.mjs`
Expected: all pass, including check 9 (the pin/quality freeze) and Task 1's block — proof the pin path did not move.

- [ ] **Step 5: Verify the pin caller is unaffected**

Run: `grep -n "setAdaptive" src/core/Harness.js`
Expected: only `setAdaptive?.(false, 1)` at `:58` and the pass-through bridge at `:5849`. State in the task report that no production code calls `setAdaptive(true)`.

- [ ] **Step 6: Commit**

```bash
git add src/core/RenderPipeline.js tests/render-scale.test.mjs
git commit -m "Unpinning returns the buffer to its owner instead of to a constant"
```

---

### Task 3: B4 — `load()` clamps persisted values into each control's own range

**Files:**
- Modify: `src/ui/Menus.js:2148-2163` (`load`)
- Test: `tools/menuprobe.mjs` (new checks; run against the dev server)

**Interfaces:**
- Consumes: module-scope `DEFAULTS` (`src/ui/Menus.js:52`) and `SLIDERS` (`src/ui/Menus.js:76`) — `SLIDERS[i] = { key, min, max, step, ... }` covers every numeric setting except `quality` (integer 0..3) and `dynamicRes` (0 or 1).
- Produces: `load()` returns a settings object where every `SLIDERS` key is inside `[min, max]`, `quality` is an integer in `[0, 3]`, and `dynamicRes` is exactly `0` or `1`. Task 4 may rely on `dynamicRes` being strictly `0 | 1`.

**Background:** `load()` adopts any finite number (`Menus.js:2157`), so a hand-edited `renderScale: 7` renders the thumb at the clamp (browser range inputs clamp to `max`) while the `<output>` prints `700%`, and a `dynamicRes: 5` matches neither Auto nor Off. The pipeline itself is safe (Task 1's clamp); this fixes the UI desync at its source, as the final reviewer prescribed ("clamp in `load()` against each `SLIDERS` entry's min/max").

- [ ] **Step 1: Write the failing probe checks**

The existing render-scale block runs `tools/menuprobe.mjs:316-358` and **ends in its own `page.reload` (`:348`) plus three boot-state checks (`:350-358`)**, followed immediately by `browser.close()` (`:360`) — its header comment says it runs last because the reload discards the live run. Insert the new B4 arm **after `:358`, before `browser.close()`**. After the arm's reload there is no run and no pause screen — the page sits on the title screen — so the reopen recipe is: copy `:349`'s wait (`globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title'`, 60 s timeout), then `page.click('.screen--title [data-act="settings"]')` (the title screen carries the same `data-act` — `src/ui/Menus.js:213`), then copy `:322`'s wait with `=== 'settings'`:

```javascript
// B4: hostile persisted values must be clamped by load(), not adopted.
// A hand-edited renderScale of 7 used to render the thumb at the clamp while
// the readout printed 700%, and dynamicRes 5 matched neither segment button.
await page.evaluate(() => {
  const KEY = Object.keys(localStorage).find((k) => localStorage.getItem(k)?.includes('renderScale'));
  const st = JSON.parse(localStorage.getItem(KEY));
  st.renderScale = 7;
  st.dynamicRes = 5;
  st.fov = 9999;
  localStorage.setItem(KEY, JSON.stringify(st));
});
await page.reload({ waitUntil: 'load' });
// ... re-open the settings screen exactly the way the top of this probe does ...
const clamped = await page.evaluate(() => {
  const input = document.querySelector('input[data-key="renderScale"]');
  const out = document.querySelector('output[data-out="renderScale"]');
  const fovOutEl = document.querySelector('output[data-out="fov"]');
  const on = [...document.querySelectorAll('[data-seg="dynamicRes"] .segbtn')]
    .filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.val);
  return { val: input.value, text: out.textContent.trim(), fovOut: fovOutEl.textContent.trim(), on };
});
ok(clamped.val === '1', `hostile renderScale 7 loads as the 1.0 ceiling (thumb ${clamped.val})`);
ok(clamped.text.includes('100%'), `and the readout agrees with the thumb (${clamped.text})`);
ok(clamped.fovOut.startsWith('110'), `hostile fov 9999 clamps to the slider max, readout included (${clamped.fovOut})`);
ok(clamped.on.length === 1 && clamped.on[0] === '1', `hostile dynamicRes 5 lands on Auto, one segment lit (${clamped.on})`);
```

In the `page.evaluate`, read the fov **readout** (`output[data-out="fov"]`, `fovOut: fovOutEl.textContent.trim()`) rather than the input value — a range input clamps its own `value` property, so the input-value leg cannot fail pre-fix, but the readout prints the raw stored number (the fov fmt appends a degree sign; `startsWith('110')` keeps the probe edit ASCII-clean). Storage cleanliness after the arm is moot — `browser.close()` runs on the next line and each probe run launches a fresh context; the report should still state the arm runs last and why.

- [ ] **Step 2: Run the probe to verify the new checks fail**

Start the dev server if not running: `node node_modules/vite/bin/vite.js --port 5211` (background).
Run: `node tools/menuprobe.mjs --port 5211`
Expected: the pre-existing checks pass; of the four new checks, **exactly two FAIL** — the renderScale readout (`700%` does not include `100%`) and the dynamicRes segment (`on` empty). The `clamped.val === '1'` check is a consistency check that cannot fail pre-fix (the range element clamps its own `value` for display); the fov-readout check fails pre-fix only because it reads the `<output>`, not the input.
Record the exact failure lines in the task report — this is the gate being failed on purpose. Do not "fix" the val consistency check into something that fails; its role is to pin the thumb-readout agreement post-fix.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/Menus.js`, `load()`, after the adoption loop (`:2156-2158`), add:

```javascript
    // Adopting any finite number lets a hand-edited or corrupted store desync
    // the UI: a renderScale of 7 draws the thumb at the clamp while the
    // readout prints 700%, and a dynamicRes of 5 lights neither segment.
    // Clamp every value into its own control's range (final-review B4).
    for (const s of SLIDERS) {
      out[s.key] = Math.min(s.max, Math.max(s.min, out[s.key]));
    }
    out.quality = Math.min(3, Math.max(0, Math.round(out.quality)));
    out.dynamicRes = out.dynamicRes === 0 ? 0 : 1;
```

(`SLIDERS` is module-scope in the same file; no import needed. `spawnRate` is a SLIDERS key and is covered by the loop.)

- [ ] **Step 4: Run the probe to verify all checks pass**

Run: `node tools/menuprobe.mjs --port 5211`
Expected: all checks pass, old and new.

- [ ] **Step 5: Run the unit suite (regression)**

Run: `node tests/run.mjs`
Expected: all pass (Menus.js has no unit coverage; this catches accidental syntax/import damage).

- [ ] **Step 6: Commit**

```bash
git add src/ui/Menus.js tools/menuprobe.mjs
git commit -m "A corrupted store is clamped at the door, and the thumb and readout agree again"
```

---

### Task 4: B7 — the readout says it is a ceiling while Auto is on

**Files:**
- Modify: `src/ui/Menus.js:649-662` (`syncSettings`)
- Modify: `tools/menuprobe.mjs` (update the `'50%'` expectation at `:334`; add the toggle check)

**Interfaces:**
- Consumes: `this.settings.dynamicRes` strictly `0 | 1` (Task 3), `SLIDERS` entry `{ key: 'renderScale', fmt: pct }`, `apply()` calling `syncSettings()` on every change (`src/ui/Menus.js:1146`).
- Produces: the renderScale `<output>` reads `up to 50%` while Dynamic resolution is Auto, `50%` while Off. No other slider's readout changes.

**Background:** with Render scale 50% and Auto on, a struggling GPU renders at 0.5 × adaptive — as low as 27.5% — while the readout says "50%". The doc comment on `setRenderScale` calls the slider "a hard ceiling"; the UI should say so. The live effective scale is not shown (the adaptive term doesn't move while the pause menu is open, so a live number would be stale anyway); the fix is honest copy, not new plumbing.

- [ ] **Step 1: Update the probe expectations (write the failing test)**

In `tools/menuprobe.mjs`:

1. The existing check at `:334` runs with Dynamic resolution at its default (Auto). Change it to:

```javascript
ok((await page.textContent('output[data-out="renderScale"]')).trim() === 'up to 50%',
  'while Auto is on, the readout admits the slider is a ceiling');
```

2. Immediately after the existing click on `[data-seg="dynamicRes"] [data-val="0"]` (`:336`), add:

```javascript
ok((await page.textContent('output[data-out="renderScale"]')).trim() === '50%',
  'with Dynamic resolution Off, the readout is the scale itself');
```

3. If the B4 arm from Task 3 asserted `text.includes('100%')`, it still passes (`up to 100%` includes `100%`) — verify, don't assume.

- [ ] **Step 2: Run the probe to verify the changed checks fail**

Run: `node tools/menuprobe.mjs --port 5211`
Expected: FAIL on "admits the slider is a ceiling" (readout still `50%`); the Off-position check passes vacuously — note that in the report.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/Menus.js`, `syncSettings()`, replace:

```javascript
      if (out) out.textContent = s.fmt(this.settings[s.key]);
```

with:

```javascript
      if (out) {
        const v = s.fmt(this.settings[s.key]);
        // The slider is a hard ceiling, not the live scale: under Auto the
        // adaptive controller renders anywhere below it (a struggling GPU at
        // "50%" may be at 27%). Say so, rather than presenting the ceiling
        // as the value (final-review B7).
        out.textContent = (s.key === 'renderScale' && this.settings.dynamicRes !== 0)
          ? `up to ${v}` : v;
      }
```

`apply()` already calls `syncSettings()` on every input and segment click, so toggling Auto/Off refreshes the readout with no new wiring.

- [ ] **Step 4: Run the probe to verify all checks pass**

Run: `node tools/menuprobe.mjs --port 5211`
Expected: all checks pass, including both new readout states.

- [ ] **Step 5: Run the full regression battery**

- `node tests/run.mjs` — expected all pass.
- `node tools/padprobe.mjs --port 5212` — expected 21/21 (the pad probe drives the same settings screen; if it asserts any renderScale readout text, update it the same way and disclose).
- Capture smoke (the readout is menu-only, but `Harness` boots the same `Menus` code): `node tools/capture.mjs --only 15-logbook --out <scratchpad>/shots-smoke --port 5213` — expected exit 0, `subjectsOk: true`. Delete the output directory afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Menus.js tools/menuprobe.mjs
git commit -m "The readout stops presenting the ceiling as the floor it stands on"
```
