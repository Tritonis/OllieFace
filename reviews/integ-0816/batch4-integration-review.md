# Integration review — batch 4 (4cfd442..7c90744)

Scope: two `--no-ff` lane merges on the integrated tree.

- `49cd343` — AT layer (#45 + #46): canvas role/label/describedby, `markDialog()` on every
  `[data-screen]`, `installFocusTrap`, `.a11y-live` polite region driven by `src/ui/Announcer.js`,
  captions setting (default 0) with 4 s captions in `HUD.update`. `tests/a11y-announce.test.mjs` (44).
- `7c90744` — capture audio gate (#96): window measured on `ac.currentTime`, settle derived from
  Music.js tempo/ramp restatements + named 0.15 s margin, settle peaks excluded, `sampled >= 80`
  truncation guard, `GATE_MAX_FRAMES` hang guard, `PEAK_FLOOR` unchanged.
  Includes fold-in `09437d0` (derived settle constant + `tests/audio-gate-window.test.mjs`), which
  this review also serves as the scoped re-review for.

## Verdict

**SPEC: CONFIRMED** — every behavioural claim in the dispatch was independently verified, including
the integration capture evidence, which exists on disk and matches its stated numbers.

**QUALITY: NOT READY** — one Major: the drift guard added by the fold-in is blind to the exact class
of regression it was written to prevent, in a repo whose named dominant defect shape is "guards that
pass while blind" and which has already fixed this same shape once (`c57d649`).

**COUNTS: 0 Critical, 1 Major, 4 Minor. Tests 82/82 files passed.**

---

## Item 0 — the fold-in (09437d0)

### Constants match Music.js — CONFIRMED

Verified against `src/systems/Music.js` source, not against the commit message:

| capture.mjs restatement | Music.js source | line |
|---|---|---|
| `OPENING_BPM = 118` | `this.bpm = 118;` (constructor) | `src/systems/Music.js:190` |
| `BAR_SIXTEENTHS = 16` | `const bar = 16 * stepDur;` (`_onBar`) | `src/systems/Music.js:449` |
| (16ths assumption) | `const stepDur = 60 / this.bpm / 4;` | `src/systems/Music.js:396` |
| `RAMP_BARS = 0.5` | `this._apply(next, t, bar * 0.5);` | `src/systems/Music.js:483` |

The constructor value is the one the regex binds to; `src/systems/Music.js:354`
(`this.bpm = lerp(118, 142, this.intensity)`) does not match the `this.bpm = <digits>;` anchor, so
there is no ambiguity. Derived `GATE_SETTLE_S` = 3.201 s.

### The test reads Music.js, not a copy — CONFIRMED

`tests/audio-gate-window.test.mjs:31-32` does `readFileSync(join(root, 'src/systems/Music.js'))` and
`readFileSync(join(root, 'tools/capture.mjs'))` with `root = <testfile>/..`. Real sources.

### Synthetic-failure proof — CONFIRMED for the case it covers

`node tests/audio-gate-window.test.mjs` → 13/13, exit 0. The drift block (lines 100-113) feeds the
same `readMusic` / `worstCaseSilenceS` used by the live checks a synthetic 90 bpm / whole-bar-ramp
source and requires the comparison to come back short. That is a genuine can-fail demonstration for
**drift in Music.js**.

### Fail-closed behaviour — CONFIRMED

Reproduced in an isolated scratch copy of the repo layout (no repo files touched):

- Music.js absent → `readFileSync` throws → exit 1. Fails closed.
- Music.js refactored so `this.bpm = 118;` becomes `this.bpm = OPENING_TEMPO;` (regex loses its
  anchor) → 6/13, exit 1, with `bpm: null` reported explicitly. Fails closed and loudly, rather than
  silently parsing a coincidental number.

---

## MAJOR — the drift guard does not read capture.mjs's combining expression

**`tests/audio-gate-window.test.mjs:83`** (with `tools/capture.mjs:723`)

The test parses capture.mjs's four **constants** via `captureNum()` and then recomputes the settle
using *its own* copy of the formula:

```js
// tests/audio-gate-window.test.mjs:83
const settle = barS * (1 + M.rampBars) + margin;
```

It never reads `tools/capture.mjs:723`, where the real value is combined:

```js
const GATE_SETTLE_S = GATE_BAR_S * (1 + RAMP_BARS) + SETTLE_MARGIN_S;
```

So any edit to the **expression** — as opposed to the constants — is invisible to the guard.

### Reproduction (isolated scratch copy; repo untouched)

1. Copy `tests/audio-gate-window.test.mjs`, `src/systems/Music.js`, `tools/capture.mjs` into a
   scratch tree preserving `tests/`, `src/systems/`, `tools/` layout. Baseline: 13/13, exit 0.
2. In the scratch `tools/capture.mjs`, change **only** line 723, leaving all four constants
   byte-identical:
   ```
   -  const GATE_SETTLE_S = GATE_BAR_S * (1 + RAMP_BARS) + SETTLE_MARGIN_S;
   +  const GATE_SETTLE_S = GATE_BAR_S * RAMP_BARS + SETTLE_MARGIN_S;
   ```
   This drops the whole-bar wait for the downbeat — the precise half of the #96 diagnosis — taking
   the real settle from **3.201 s to 1.166 s**, below the 3.051 s worst-case silence.
3. Run the test.

**Expected:** red — a 1.166 s settle no longer covers the silence, which is what this file exists
to catch.

**Actual:** `13/13 checks passed`, exit 0, and it prints
`PASS settle is ~3.2s for today's arrangement (3.201s)` — a number the gate no longer uses.
Issue #96 is fully reopened with every arm green.

### Why the coverage assertion cannot catch it either

`tests/audio-gate-window.test.mjs:84` is tautological:

```js
const settle   = barS * (1 + M.rampBars) + margin;   // line 83
const silenceS = barS * (1 + M.rampBars);            // from worstCaseSilenceS(M)
ok(settle >= silenceS, ...)                          // line 84  =>  margin >= 0
```

`settle - silenceS` is identically `SETTLE_MARGIN_S`, so line 84 restates line 85 (`margin > 0`) and
cannot fail on its own. The file header's claim that it "recomputes the worst case from the numbers
actually in Music.js to check the settle still covers it" therefore overstates the assertion: the
recomputation shares the formula it is checking.

The protection that **is** real is the three equality checks (lines 72-77) plus
`Math.abs(settle - 3.2) < 0.05` (line 95) — those do go red on Music.js drift, verified above. The
hole is one-directional: **Music.js can't drift unnoticed; capture.mjs's own arithmetic can.**

### Precedent

`c57d649` — *"The guard now reads the shader's own layout expression, so a numeral quietly drawn at
twice its advance no longer slips past"* — is the same lesson already learned in this repo.

### Suggested fix (not applied)

Have the test derive the expected settle from capture.mjs's own text rather than a hand-copy: parse
and evaluate the `GATE_SETTLE_S = ...` right-hand side, or at minimum assert the expression text
matches `GATE_BAR_S * (1 + RAMP_BARS) + SETTLE_MARGIN_S`. Then step 2 above goes red.

---

## Minor findings

**m1 — `tests/audio-gate-window.test.mjs:84`** — the coverage assertion is tautological
(`settle - silenceS ≡ SETTLE_MARGIN_S`); it can never fail independently of line 85. Detailed above.

**m2 — `src/ui/Announcer.js:112-121`** — `update()` never re-checks `captionsOn`. Turning captions
off mid-caption clears the caption only on the next `announce()` (`src/ui/Announcer.js:99-105`) or
when the ≤4 s hold expires, so a caption can outlive the setting by up to `CAPTION_HOLD_S`.
Self-expiring and bounded, hence Minor. The covering assertion at
`tests/a11y-announce.test.mjs:265-269` emits a further cue (`playerRevived`) before asserting, so it
exercises the `announce()` path only — its wording *"turning captions off clears a standing
caption"* claims more than it drives. Toggle-alone is untested.

**m3 — `tools/capture.mjs:878`** (`sampled: A.samples >= 80`) — the truncation guard is the one arm
of the #96 fix with no demonstration that it can fail. That `GATE_MAX_FRAMES` truncation leaves
`sampled` short is asserted in comment only. Given the fold-in's own premise (a guard must show it
can go red), this arm is unproven. Observed headroom on the integration run is 123 vs a floor of 80.

**m4 — caption rendering is never exercised by any gate.** `captions` defaults to 0
(`tests/a11y-announce.test.mjs:252`) and no capture shot, `gate:sp/mp1/elite` arm, or probe sets it
to 1 — grep for `captions` across `src/core/Harness.js` and `tools/capture.mjs` returns **zero**
hits. So `.caption` CSS (`src/ui/hud.css:3343-3359`: `position:absolute; left:50%; bottom:18%;
max-width:min(52vw,40em)`) — its placement, contrast, and overlap with HUD furniture — has never
been rendered under any automated gate. Only the unit rig drives it, and that rig has no layout.

---

## Item 1 — cross-lane: do captures now carry the a11y DOM?

**CLEAN — verified independently, not accepted from a subagent.**

The new nodes are unreachable by every capture subject check:

- `01-title`'s three checks live at `src/core/Harness.js:2837-2844`. The only DOM one is
  `(menus?.root?.querySelector('[data-screen="title"]')?.offsetHeight ?? 0) > 40` — a single scoped
  selector reading one element's height. The other two are `menus?.screen === 'title'` and
  `!!ctx.stage`, neither of which touches the DOM. (The dispatch's "detail 900" is that
  `offsetHeight`, not a count or a width sum — no aggregate check exists to be perturbed.)
- `menus.root` is `document.getElementById('overlay')` (`src/ui/Menus.js:186`). The new nodes live
  elsewhere: `.a11y-live` and `.caption` are built into HUD's own template inside `#hud`
  (`src/ui/HUD.js:1567-1568`, `1597-1598`), and `#viewport-help` is a direct child of `<body>`
  (`index.html:22-27`). None is a descendant of `#overlay`.
- **Decisive:** `grep -n "document\.querySelector\|document\.getElement\|document\.body\|documentElement" src/core/Harness.js`
  returns **zero matches**, and `grep -n "dom: () =>.*document"` also returns zero across all 41
  `dom:` checks. No subject check in the harness reaches the document at all, so no unscoped
  selector exists that could pick up a new node.
- The new nodes carry no `data-screen` / `data-survivor` / `data-difficulty` / `data-artifact`
  attributes, so even a mis-scoped attribute selector could not count them.

**Announcer cost during capture — negligible and non-perturbing:**

- Purely event-driven except a per-frame early-return: `src/ui/HUD.js:587` calls
  `this.announcer.update(dt)`, which returns at `src/ui/Announcer.js:113` (`if (this.captionT <= 0)
  return;`) whenever no caption is live — which is always during capture, since captions default 0.
- The alternating-space write is inside `announce()` (`src/ui/Announcer.js:95-96`), reached only from
  the event-bus handlers — off-frame.
- No forced reflow: Announcer.js never reads `offsetHeight` / `getBoundingClientRect` /
  `getComputedStyle` after a `textContent` write.
- Caption DOM writes are change-driven, not per-frame: written on `announce()`
  (`src/ui/Announcer.js:107`) and cleared once at expiry (`:118`).
- **Determinism:** grep for `Math.random|Date.now|performance.now|setTimeout|setInterval` over
  `src/ui/Announcer.js` → no matches. Nothing draws from the shared global RNG, which is the hazard
  `tools/capture.mjs` documents at length (a gate may not move the thing it gates).

`.a11y-only` is properly clipped (`src/ui/hud.css:3328-3336`: `position:absolute; width:1px;
height:1px; margin:-1px; overflow:hidden; clip-path:inset(50%)`), so `#viewport-help` is out of flow
and cannot shift layout in a screenshot.

---

## Item 2 — the focus trap vs. the harness

**CLEAN — the trap provably cannot swallow a key any probe or gate depends on.** Three independent
reasons, each read off the source rather than inferred from `gate:sp` passing:

1. **Tab only.** `src/ui/Dialogs.js:85-86` is `const handler = (e) => { if (e.key !== 'Tab') return; ... }`
   — the first statement in the handler. Enter, Escape, arrows, WASD, Space, Shift, E/Q/R and
   Backspace all return before anything else runs.
2. **It never stops propagation.** `grep -n "preventDefault\|stopPropagation\|stopImmediate"
   src/ui/Dialogs.js` returns exactly one hit: `e.preventDefault?.()` at `src/ui/Dialogs.js:91`, and
   only on the Tab path at a trap edge. There is no `stopPropagation` or `stopImmediatePropagation`
   anywhere in the file, so no event is prevented from reaching the game.
3. **Bubble phase, and a different target from the game's listener.**
   `src/ui/Dialogs.js:94` is `doc.addEventListener('keydown', handler)` — no third argument, so
   `capture: false`. The game's input listener is `src/core/Input.js:52`, a bare
   `addEventListener('keydown', ...)` which resolves to `window`. Only three keydown listeners exist
   in `src/` (`Input.js:52`, `Audio.js:244`, `Dialogs.js:94`), so there is no capture-phase
   interceptor anywhere.

So the answer to "why can't it interfere" is not "no dialog is open" — the trap **is** wired while
title/menu screens show, since `markDialog` is applied unconditionally to every `[data-screen]` at
`src/ui/Menus.js:614-621`. It is that the trap acts on a key no harness sends and blocks nothing.

**Focus stealing is a non-issue** for the same reason: `src/core/Input.js:52` listens on `window`,
not on the canvas (`canvas.addEventListener` is used only for mouse events), so moving DOM focus to
a menu button does not interrupt key delivery.

---

## Item 3 — whole-surface: what no gate covers

| Surface | Covered by | Status |
|---|---|---|
| `GATE_SETTLE_S` combining expression, `tools/capture.mjs:723` | nothing | **MAJOR — proven blind above** |
| `sampled >= 80` truncation guard, `tools/capture.mjs:878` | comment only | m3 — can-fail undemonstrated |
| Caption visual rendering (`src/ui/hud.css:3343-3359`) | nothing (captions default 0; no gate sets it to 1) | m4 |
| Caption clear on toggle-off *alone* | nothing | m2 |
| Focus restore on gamepad / programmatic close | no test drives it | **not a defect** — see below |
| Real screen-reader / AT behaviour end-to-end | nothing | inherent; out of scope for any local gate |
| `role="application"` on the canvas (`index.html:16`) | nothing | design choice, changes the AT interaction model wholesale; flagging for awareness only |

**Focus-restore candidate resolved as clean.** `src/ui/Menus.js:1392-1403` `moveFocus()` is a single
path used for every trigger — click, key, gamepad and programmatic alike — and the restore is fully
optional-chained: `(back || doc.getElementById?.('viewport'))?.focus?.()` at
`src/ui/Menus.js:1402`. There is no unguarded `.focus()` on a null or removed element and no separate
gamepad branch to diverge. The fallback target is coherent with `index.html:14`, which adds
`tabindex="0"` to `#viewport` — without it the canvas could not accept the restored focus.

---

## Item 4 — suite and merge shapes

`npm test` at HEAD (7c90744): **82/82 test files passed**, exit 0. `tests/run.mjs:20` discovers by
glob (`readdirSync(here).filter(f => f.endsWith('.test.mjs'))`), and both new files —
`tests/a11y-announce.test.mjs` and `tests/audio-gate-window.test.mjs` — are present in the 82, so
neither is a test that exists without running.

Merge `--stat` shapes are consistent with the described lanes; no stray files in either:

- `49cd343` — 7 files, +658/-1: `index.html` (+18), `src/ui/Announcer.js` (new, 122),
  `src/ui/Dialogs.js` (new, 96), `src/ui/HUD.js` (+18), `src/ui/Menus.js` (+61),
  `src/ui/hud.css` (+40), `tests/a11y-announce.test.mjs` (new, 304). No engine, sim or net files.
- `7c90744` — 9 files, +11823/-12: `tools/capture.mjs` (+119/-12),
  `tests/audio-gate-window.test.mjs` (new, 116), and 7 evidence manifests under
  `reviews/music-audible/`. The two lanes' file surfaces are genuinely disjoint — no file appears in
  both merges — so there is no textual cross-lane interaction, only the behavioural one examined in
  items 1 and 2.

**Integration capture evidence verified on disk** rather than taken from the dispatch:
`reviews/batch4-integrated-shots/manifest.json` — `commit: 7c90744`, `capturedAt
2026-08-17T03:39:09Z`, 23 shots, `subjectsOk: true`, `audioOk: true`, `audio.failed: []`, 0 subject
failures, `musicPeak 0.13045`, `samples 123`, `settlePeak 0.13456`, `windowS 5.736`.

`windowS 5.736` ≈ `GATE_SETTLE_S 3.201 + GATE_MEASURE_S 2.5 = 5.701` — direct on-disk confirmation
that the derived settle is what the live gate actually ran, not merely what the source says.
`settlePeak (0.1346) > musicPeak (0.1305)` confirms the settle window is being discarded as designed
rather than being empty.

Note: `reviews/integ-0816/manifest.json` is **not** this batch's capture — it has no `commit` field,
`subjectsOk: false`, `musicPeak 0.008`, `samples 75`. A `samples` of 75 would fail today's
`sampled >= 80`, which dates it to before this fix. It should not be mistaken for integration
evidence for batch 4.

---

## Commands run

```
git log --oneline 4cfd442..HEAD ; git log --graph --oneline 4cfd442..HEAD
git show --stat 49cd343 ; git show --stat 7c90744
git diff 6aac650..09437d0 -- tools/ tests/ src/
git diff 4cfd442..49cd343 -- index.html
grep -n "this\.bpm\s*=\|stepDur\s*=\|const bar\s*=\|_apply(next" src/systems/Music.js
node tests/audio-gate-window.test.mjs                      # 13/13, exit 0
node tests/a11y-announce.test.mjs                          # 44 passed, 0 failed
npm test                                                   # 82/82 test files passed, exit 0
grep -rn "addEventListener(.keydown" src/
grep -n "preventDefault\|stopPropagation\|stopImmediate" src/ui/Dialogs.js
grep -n "document\.querySelector\|document\.getElement\|document\.body\|documentElement" src/core/Harness.js   # zero
grep -n "dom: () =>.*document" src/core/Harness.js         # zero
grep -rn "captions" src/core/Harness.js tools/capture.mjs  # zero
# isolated scratch repro (repo untouched) — Music.js absent -> exit 1;
# Music.js bpm de-anchored -> 6/13 exit 1; GATE_SETTLE_S expression sabotaged -> 13/13 exit 0 (MAJOR)
```

No GPU captures, probes or `gh` calls were run. No repository file was modified; the sabotage
reproduction ran entirely inside the session scratchpad.
