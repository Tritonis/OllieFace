# Diegetic UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The UI stops looking like a web page and starts looking like an instrument panel reading the planet — one component language (bezel, core-sample bar, seismograph trace) defined once and applied across HUD, menus, survivor select and logbook, with the corruption gauge rebuilt as the centrepiece instrument, and the 2026-08-08 playtest's "the font is too weak" fixed at the token layer rather than screen by screen.

**Origin:** Launch design spec §3.3 (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md:138-141`): *"UI stops looking like a web page. One diegetic treatment across menus, HUD, logbook, survivor select: instrument-panel-reading-the-planet — seismograph lines, core-sample bars, the corruption gauge as the centrepiece instrument."* Plus the 2026-08-08 playtest's UI-font finding, folded in here because the font is a token, and tokens are what this slice owns.

**Architecture:** Nothing is rewritten. `src/ui/hud.css` is the repo's only stylesheet (`index.html:10`; the Edict screen's runtime-injected block in `Menus.js` is the one exception and is brought under the same rules). The slice adds two new sections to it — a type ladder in `:root`, and an INSTRUMENT LANGUAGE block of three reusable classes — then applies those classes to markup that already exists. Class names are **added, never renamed**, because `src/core/Harness.js` asserts on live DOM selectors per capture scenario. The one piece of real logic is procedural: two pure functions in `src/ui/Icons.js` that emit SVG path strings for the seismograph traces, following the file's existing "procedural, no assets, deterministic from an FNV hash" philosophy — no canvas, no images, no web fonts, no new dependency.

**Tech Stack:** Plain DOM + CSS custom properties (no framework), inline SVG paths generated in JS, the existing `HUD.set()` diff cache, `tools/capture.mjs` + `tools/shotdiff.mjs` for shots, node-only `tests/*.test.mjs`.

## Global Constraints

- **No renames.** Every existing class name, `data-*` attribute and DOM parent/child relationship survives. `src/core/Harness.js` runs `mustContain` DOM assertions per capture scenario (e.g. `01-title` checks `[data-screen="title"]`, `Harness.js:2496-2500`); a rename silently breaks the shot harness. Add classes to existing elements; add wrapper elements only where this plan names one.
- **No new runtime dependencies, no web fonts, no image assets.** Icons are procedural canvas; traces are procedural SVG path strings. Everything the browser loads is already in the repo.
- **Define it once.** The treatment lives in tokens and three utility classes. A per-screen bespoke bar, a per-screen bespoke hairline, or a fourth chamfer convention is a plan failure. Task 2's lint test enforces the type half of this mechanically.
- **Keep the diff-cache pattern.** `HUD.update` writes to the DOM only through `this.set(key, value, apply)` (`src/ui/HUD.js:556-561`), which skips the write when the value is unchanged. Any new HUD-driven visual in this slice goes through `this.set` with a scalar or string key. No per-frame `innerHTML`, no per-frame `setAttribute` outside a `set` callback.
- **Layout-safe animation.** `hud.css:3-4` states the house rule: everything animates on transform/opacity only; nothing may trigger layout during gameplay. This slice adds **no new animation at all** — the only motion it introduces is the gauge trace redrawing when new data arrives (at most once per 1.5 s of gameplay). Nothing new is needed for `prefers-reduced-motion`.
- **`src/ui/GpuNotice.js` is out of scope** and exempt from the type lint: it is a pre-boot diagnostic overlay that must render before any stylesheet or token exists, so its hardcoded `font-size:11px` stays.
- **sp-equivalence is a gate even though this slice is inert by construction.** `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` must show **zero fields moved**. No file this plan touches draws `ctx.rng` or mutates gameplay state; a moved field means an implementer wandered outside the slice, and is a bug in the work, never a baseline to regenerate.
- **Baselines land in `reviews/round8/` with a `ui-` prefix** (`ui-shots-before/`, `ui-shots-after/`, `ui-shot-diff.json`, `ui-gauge-probe-record.json`). Round 8 is the live review round and already holds the phase-3 probe records (`blight-probe-record.json`, `reckoning-probe-record.json`); a new round directory would split one phase's evidence across two folders.
- **Every capture in this plan runs under one renderer, chosen once, by the canary.** `tools/capture.mjs:35` sets `const SOFTWARE = 'software' in args`, and `:231` passes `headless: SOFTWARE` — so with no flag it launches **headed** Chromium against the real GPU adapter (`--use-angle=d3d11`), merely parked off-screen. That needs a live, unlocked, GPU-accessible Windows desktop session, which an unattended overnight run does not reliably have; without one the harness fails outright or, worse, shutters black frames that pass the timeout and fail `mustContain`. Task 1 Step 0's canary decides the flag for the whole run. Thereafter **every** `capture.mjs` invocation in this plan — Task 1 Step 0 and 7, Task 3 Step 9, Task 4 Step 8, Task 5 Step 8, Task 6 Steps 3 and 4 — carries the same flag, and the choice is recorded in `UI-BASELINE.md`. **Before and after baselines captured under different renderers make the shotdiff table void**: SwiftShader and d3d11 differ in AA and gradient banding across the whole frame, so the diff would measure the renderer, not the treatment. If the canary falls back to `--software` after the "before" was already taken headed, the "before" is re-captured under `--software` from its recorded SHA, or the diff table is not published at all.
- **Line citations in this plan are signposts, not addresses.** Every one was verified against the tree at authoring time, but the file moves under the slice's own edits. Every step that names a range also tells you what to search for; when the two disagree, the live file wins. Never overwrite a cited range without reading it first.
- **The plan's numbers are design dials.** Implementers transcribe them exactly. The closing task photographs the result so the next critique argues against pixels.
- Bash tool is ASCII-only in this environment; any non-ASCII content (em dashes in CSS comments, the trace glyphs) goes through Write/Edit, never through a heredoc.

---

## The treatment, stated once

Three parts, and everything downstream is an application of one of them.

1. **The bezel** (`.bez`) — the machined casing an instrument sits in: a dark ground, a hairline edge, a lit top lip, a hard black keyline under it. It gives panels, plates and readouts a common physical edge. It deliberately does **not** set `clip-path`: the repo already unified its chamfers on one `--skew`/corner-cut convention (`hud.css:1259-1264`), and a second clip-path on the same element would fight it.
2. **The core sample** (`.core`) — every bar in the game is a drilled column of the planet: dark casing, strata banding read as depth, an engraved gradation scale along the bottom lip. Six bars share it: health, shield, XP, boss, survivor-select stats, logbook progress. A seventh — the corruption gauge — takes the variant whose gradations are the *real* band thresholds.
3. **The seismograph trace** (`.trace`) — a plotted line, drawn as an SVG path from a pure function. It replaces flat 1px `border-bottom` dividers under section heads. Where real data exists the trace plots it (survivor stat vector, corruption history); where none does it plots the run seed, which is the planet's own signature and the number the title screen already displays.

**Deliberate rejections, so nobody re-litigates them mid-slice.** No system monospace for the data role: `Consolas`/`Menlo`/`DejaVu Sans Mono` render at three visibly different widths and weights, which is the exact failure the existing condensed-grotesque stack was assembled to avoid (`hud.css:8-11`). The data role is instead the same family at `--fw-read` with `font-variant-numeric: tabular-nums`, which the readouts already do. No scanline overlay, no CRT curvature, no chromatic-aberration frame: the game's post pipeline owns those channels and a UI that also uses them stops reading as an instrument and starts reading as a filter. No animated "live" scroll on the static traces — one moving trace (the gauge's) means motion carries meaning.

---

### Task 1: The panel stops whispering

The playtest's "the UI font is too weak" is three compounding faults, all at the token layer: the responsive unit's floor is 11px, no weight is ever declared for body text so it renders at 400, and 38 declarations set a font-size below 0.80em — several of them with 0.28-0.40em of tracking, which destroys word shape at that size. Fix all three as tokens, then push every offender onto the ladder.

**Files:**
- Modify: `src/ui/hud.css:7-54` (`:root`), `src/ui/hud.css:58-66` (`html, body`), and every sub-0.80em `font-size` / over-tracked small-text declaration in the file
- Modify: `src/ui/Menus.js:1664-1844` (the injected `EDICT_STYLE` template literal — same rules, same ladder)
- Create: `tests/ui-type-scale.test.mjs`

**Interfaces:**
- Produces (Tasks 2-6 and the lint consume these): `--u` (re-priced), `--fs-micro: 0.82em`, `--fs-small: 0.9em`, `--fw-body: 500`, `--fw-label: 600`, `--fw-read: 700`, `--fw-display: 800`, `--track-label: 0.14em`, `--track-eyebrow: 0.24em`, `--track-hero: 0.34em`.
- Consumes: nothing from earlier tasks — this is the foundation.

- [ ] **Step 0a: The renderer canary — one cheap shot decides the flag for the whole run**

Do not let the plan's first real action be an eight-scenario capture that may not be able to run at all. Fire one cheap scenario first and let it choose the renderer:

```bash
node tools/capture.mjs --out shots/canary --seed 1337 --only 01-title
```

Then read `shots/canary/manifest.json` (a `manifest.FAILED.json` is itself the failure signal) and open `shots/canary/01-title.png`.

- **The canary passes** — the command exits 0, the manifest is not `FAILED`, `01-title`'s `mustContain` assertions are satisfied, and the PNG is not black or blank. The run is GPU-capable. `CAPFLAG` is **empty** for every capture step in this plan.
- **The canary fails any of those** — command failure, a `FAILED` manifest, an unmet assertion, or a black/blank frame. This is the unattended-session case: `capture.mjs:231` passes `headless: SOFTWARE`, and `SOFTWARE` is false without `--software`, so the default is headed Chromium on the real adapter and there is no live desktop session behind it. Retry the *identical* invocation once with the flag:

```bash
node tools/capture.mjs --out shots/canary --seed 1337 --only 01-title --software
```

  If that passes, `CAPFLAG` is **`--software`** for every capture step in this plan, including Task 6's money shot, and the fallback is recorded in `UI-BASELINE.md`. Note that `--software` also raises the per-shot timeout from 30 s to 180 s (`capture.mjs:36`), so the eight-scenario runs take substantially longer — that is expected, not a hang.

  If the `--software` retry *also* fails, stop. Report the failure and both manifests, and do not begin Task 1: the code-correctness gates (`npm test`, both new lint/unit suites) are pure Node and would still run, but a slice whose entire deliverable is a visual treatment must not be executed blind with no way to photograph it.

Whichever branch you land in, write the chosen `CAPFLAG` into the task report as the first line, and use it verbatim in every `capture.mjs` command below. `shots/canary` is a working directory — do not commit it.

- [ ] **Step 0b: Capture the "before" — before touching anything**

The closing task's whole deliverable is a before/after the next critique can reproduce, and there is no way to take a "before" once the slice has started. Do this on a clean tree, with the canary's `CAPFLAG`:

```bash
git rev-parse --short HEAD
node tools/capture.mjs --out reviews/round8/ui-shots-before --seed 1337 --only 01-title,14-survivor-select,15-logbook,17-artifacts,18-difficulty,16-run-summary,06-loaded-hud,10-inventory $CAPFLAG
git add reviews/round8/ui-shots-before
git commit -m "The panel is photographed as it was, before anything moves"
```

Record the SHA `git rev-parse --short HEAD` printed and the `CAPFLAG` used — Task 6 names both in `UI-BASELINE.md`, and the "after" capture must use the same flag or the diff measures the renderer instead of the treatment. If the harness reports any scenario as failing its `mustContain` assertions *before* the slice begins, stop and report it: a scenario that is already broken cannot serve as a baseline, and the failure is not this slice's to absorb.

- [ ] **Step 1: Write the failing lint test** — create `tests/ui-type-scale.test.mjs`:

```js
/**
 * The type ladder is a rule, not a habit.
 *
 *   node tests/ui-type-scale.test.mjs
 *
 * The 2026-08-08 playtest reported the UI font as "too weak". It was three
 * faults at once and all three are token-level: `--u` floored at 11px, no
 * `font-weight` declared for body text anywhere (so prose rendered at 400),
 * and 38 declarations sized below 0.80em, several carrying 0.28-0.40em of
 * tracking. At that size, tracking that wide dissolves the word shape and the
 * label stops being read and starts being scanned past.
 *
 * CSS cannot be unit-tested for how it looks; the shot harness judges that.
 * What IS testable is the discipline, so this file pins it: a floor on size, a
 * declared weight, and a cap on tracking for anything under 1em. It reads the
 * two places CSS lives — hud.css and the Edict block injected by Menus.js —
 * so the treatment cannot be defined once and then quietly re-litigated in the
 * runtime sheet. `GpuNotice.js` is deliberately not read: it renders before any
 * stylesheet exists and must carry its own px.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const css = readFileSync(join(root, 'src/ui/hud.css'), 'utf8');
const menus = readFileSync(join(root, 'src/ui/Menus.js'), 'utf8');
const sources = [['hud.css', css], ['Menus.js (Edict block)', menus]];

const FLOOR_EM = 0.80;
const TRACK_CAP_EM = 0.24;

console.log('the tokens exist');
{
  for (const t of ['--fs-micro', '--fs-small', '--fw-body', '--fw-label',
                   '--fw-read', '--fw-display', '--track-label',
                   '--track-eyebrow', '--track-hero']) {
    ok(new RegExp(`\\n\\s*${t}\\s*:`).test(css), `${t} is declared in hud.css`);
  }
  const u = css.match(/--u:\s*clamp\(\s*([\d.]+)px/);
  ok(!!u && parseFloat(u[1]) >= 12, `--u floors at ${u?.[1]}px (>= 12)`);
}

console.log('body text declares a weight');
{
  const body = css.match(/\nhtml,\s*body\s*\{([\s\S]*?)\}/);
  ok(!!body, 'the html, body block is findable');
  ok(/font-weight:\s*var\(--fw-body\)/.test(body?.[1] ?? ''),
     'html, body sets font-weight: var(--fw-body) — nothing renders at the 400 default');
  for (const [name, src] of sources) {
    ok(!/font-weight:\s*400\b/.test(src), `${name} declares no font-weight: 400`);
  }
}

console.log('nothing on the ladder is too small to read');
{
  for (const [name, src] of sources) {
    const bad = [...src.matchAll(/font-size:\s*(0?\.\d+)em/g)]
      .map((m) => parseFloat(m[1]))
      .filter((v) => v < FLOOR_EM);
    ok(bad.length === 0, `${name} has no font-size below ${FLOOR_EM}em (found ${bad.join(', ') || 'none'})`);
    const px = [...src.matchAll(/font-size:\s*(\d+)px/g)].map((m) => m[1]);
    ok(px.length === 0, `${name} sizes nothing in raw px — every size derives from --u (found ${px.join(', ') || 'none'})`);
  }
}

console.log('small text is not tracked into illegibility');
{
  // A crude but sufficient block scanner: split on `}`, and for each rule read
  // its own font-size and letter-spacing. Nested blocks (@media, @keyframes)
  // split harmlessly into fragments that declare neither.
  for (const [name, src] of sources) {
    const blocks = src.split('}');
    const offenders = [];
    for (const b of blocks) {
      const fs = b.match(/font-size:\s*(0?\.\d+)em/);
      const ls = b.match(/letter-spacing:\s*(0?\.\d+)em/);
      if (!fs || !ls) continue;
      if (parseFloat(fs[1]) < 1 && parseFloat(ls[1]) > TRACK_CAP_EM) {
        offenders.push(`${(b.split('\n').find((l) => l.includes('{')) ?? b).trim().slice(0, 48)} (${fs[1]}em / ${ls[1]}em)`);
      }
    }
    ok(offenders.length === 0,
       `${name}: nothing under 1em tracks past ${TRACK_CAP_EM}em\n    ${offenders.join('\n    ')}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to watch it fail**

Run: `node tests/ui-type-scale.test.mjs`
Expected: FAIL — no tokens declared, `--u` floors at 11px, no `font-weight` on `html, body`, 33 sub-0.80em sizes in hud.css and 5 in Menus.js, two raw `font-size: 10px` in the corruption gauge, and roughly ten over-tracked small-text blocks.

- [ ] **Step 3: Re-price the root tokens** — replace `hud.css:7-12` and `hud.css:50-54` so the `:root` block opens and closes like this (the colour tokens between them are untouched):

```css
:root {
  /* Condensed grotesque, system-only. Bahnschrift ships with Windows,
     DIN Alternate with macOS, Roboto Condensed with most Linux desktops.
     One family, three roles — a system monospace for the data role was
     considered and rejected: Consolas, Menlo and DejaVu Sans Mono render at
     three visibly different widths, which is the exact inconsistency this
     stack was assembled to avoid. The data role is this same family at
     --fw-read with tabular numerals. */
  --font: 'Bahnschrift', 'DIN Alternate', 'Roboto Condensed', 'Liberation Sans Narrow',
          'Franklin Gothic Medium', 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif;
```

...and at the end of the block:

```css
  --skew: -16deg;
  /* One responsive unit drives every size in the HUD. Re-priced after the
     2026-08-08 playtest ("the UI font is too weak"): the floor was 11px and
     the slope resolved to 13.16px at the 1600x900 capture size, which is
     small type before any 0.7em label multiplies it down again. 12.5px floor,
     14.48px at capture size — about 10% larger everywhere at once. */
  --u: clamp(12.5px, calc(0.68vw + 0.40vh), 19px);
  --pad: clamp(18px, 3.2vmin, 44px);

  /* The type ladder. Three sizes, four weights, three trackings — every
     declaration in this file and in the Edict block picks a rung. The floor
     exists because the same playtest could not read the sub-labels: below
     0.80em of --u, a condensed grotesque with any tracking at all stops
     resolving into words. `tests/ui-type-scale.test.mjs` holds the line. */
  --fs-micro: 0.82em;   /* eyebrows, keys, tier tags, gauge labels */
  --fs-small: 0.9em;    /* secondary copy: descriptions, lore, subtitles */

  --fw-body:    500;    /* prose and anything otherwise unweighted */
  --fw-label:   600;    /* eyebrows and section heads */
  --fw-read:    700;    /* numerals and readouts — the instrument's own voice */
  --fw-display: 800;    /* wordmark, ending word, survivor name, book title */

  --track-label:   0.14em;   /* default for weighted labels */
  --track-eyebrow: 0.24em;   /* the cap for anything under 1em */
  --track-hero:    0.34em;   /* display type only, where the word is a shape */
}
```

- [ ] **Step 4: Declare the body weight** — `hud.css:58-66`, add one line to the existing `html, body` block:

```css
html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: #05070a;
  color: var(--ink);
  font-family: var(--font);
  /* Nothing in this file declared a weight for prose, so every unstyled run
     of text — lore, ability descriptions, option copy, the button sub-labels —
     rendered at 400. On a condensed face over a dark, busy frame that is the
     "too weak" the playtest reported. */
  font-weight: var(--fw-body);
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 5: Push every offender onto the ladder** — one mechanical rule, no judgment calls:
  - **Every** numeric `font-size` below `0.80em` in `src/ui/hud.css` and in the `EDICT_STYLE` block of `src/ui/Menus.js` becomes `var(--fs-micro)`. Find them with `grep -n "font-size: 0\.[0-7]" src/ui/hud.css src/ui/Menus.js`. There are 33 in hud.css and 5 in Menus.js. The extreme case is `.mbtn-sub` (`hud.css:1384`) at `0.56em` inside a `1.15em` button — 0.64em effective, the weakest text in the game.
  - **Every** `font-size` in raw px outside `:root` becomes an em on the ladder. Two exist, both in the corruption gauge (`hud.css:347`, `hud.css:359`) at `10px` — these are also the only HUD sizes that never scaled with `--u` at all. Both become `var(--fs-micro)`. (Task 3 rebuilds these two rules entirely; setting the token here keeps the lint green in between.)
  - **Every** block that declares a `font-size` under `1em` together with a `letter-spacing` over `0.24em` has its tracking replaced with `var(--track-eyebrow)`. Run the test after step 5 to get the exact list — it prints each offending selector. At the time of writing they are `.title-seed` (0.4em), `.sel-h`, `.sel-sub`, `.book-group`, `.book-section` (0.3em each), `.book-sub`, `.panel-tag` (0.28em), `.stat-items-label` (0.26em) and `.pickup-tier` (0.34em).
  - `.mbtn-sub`'s `font-weight: 400` (`hud.css:1384`) becomes `var(--fw-body)`; `.estand-v em`'s `font-weight: 600` (Menus.js) becomes `var(--fw-label)`.
  - Leave every `font-size >= 1em` and every tracking on display type alone. `.title-kicker`'s `0.62em` at `1em` and `.death-sub`'s `0.34em` at `1em` are the wordmark's own voice and are within the rule.

- [ ] **Step 6: Run the lint and the suite**

Run: `node tests/ui-type-scale.test.mjs` — PASS.
Run: `npm test` — green (the new file auto-registers; `tests/run.mjs:20` globs `*.test.mjs`).

- [ ] **Step 7: Eyeball the one layout risk** — `.mbtn-sub` grew ~47% and lives in a `space-between` flex row inside `.mbtn`. Capture the title screen and confirm no sub-label wraps or collides with its `<span>`:

```bash
node tools/capture.mjs --out shots/typecheck --only 01-title,14-survivor-select $CAPFLAG
```

Open `shots/typecheck/01-title.png` and `14-survivor-select.png`. If a sub-label wraps, the fix is `white-space: nowrap` on `.mbtn-sub` — not a smaller size. Do not commit `shots/typecheck`; it is a working directory (`shots/` is the harness's default output and Task 6 owns the committed baselines).

- [ ] **Step 8: Commit**

```bash
git add src/ui/hud.css src/ui/Menus.js tests/ui-type-scale.test.mjs
git commit -m "The panel stops whispering: one type ladder, and nothing on it is too small to read"
```

---

### Task 2: The instrument language gets its parts

Three classes and two pure functions. Nothing is applied to any screen yet — this task ships the vocabulary and its tests, so Tasks 3-5 are pure application.

**Files:**
- Modify: `src/ui/Icons.js` (append after the `hash` helper block at `Icons.js:53-61`)
- Modify: `src/ui/hud.css` (new INSTRUMENT LANGUAGE section, inserted after the `.plate` rule at `hud.css:106-111` so the language sits with the other shared treatments and before any screen-specific block)
- Create: `tests/ui-instruments.test.mjs`

**Interfaces:**
- Consumes: `hash(str)` from `src/ui/Icons.js:53` (exported, FNV-1a, stable across reloads); the tokens from Task 1.
- Produces (Tasks 3-6 consume these by these exact names):
  - `tracePathFrom(values, { h = 10, amp = 1 } = {}) -> string` — an SVG `d` for a polyline across a `0..100` x `0..h` box. `values` are in `[0, 1]`; `0` plots at the bottom (`y = h`), `1` at the top (`y = 0`). Values outside the range clamp. Fewer than two values returns a flat line at `h / 2`.
  - `tracePath(seed, { points = 32, h = 10, amp = 1 } = {}) -> string` — the same, from a deterministic pen wander seeded by any string or number.
  - CSS classes `.bez`, `.core`, `.core--bands`, `.trace`, and the tokens `--bezel`, `--bezel-line`, `--bezel-hi`, `--grad`, `--trace-ink`, `--core-band`, `--core-grad`, `--trace-h`.

- [ ] **Step 1: Write the failing tests** — create `tests/ui-instruments.test.mjs`:

```js
/**
 * The seismograph trace is procedural, pure and deterministic.
 *
 *   node tests/ui-instruments.test.mjs
 *
 * The diegetic UI treatment (launch spec 3.3) is mostly CSS, which cannot be
 * unit-tested for how it looks — the shot harness judges that. But the trace
 * is the one part of it that is logic: a path string derived from data or from
 * a seed. It is tested the way `Icons.js`'s other procedural art wants to be
 * and never was: exact geometry, exact determinism.
 *
 * Determinism is not a nicety here. The traces are baked into committed
 * screenshot baselines, so a trace that wanders between runs would make every
 * UI baseline unreproducible.
 */
import { tracePath, tracePathFrom, hash } from '../src/ui/Icons.js';
import { gaugeGradations } from '../src/ui/HUD.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('tracePathFrom plots values exactly');
{
  ok(tracePathFrom([0, 0.5, 1], { h: 10 }) === 'M 0.00 10.00 L 50.00 5.00 L 100.00 0.00',
     'three values span the box, 0 at the floor and 1 at the ceiling');
  ok(tracePathFrom([1, 1], { h: 10 }) === 'M 0.00 0.00 L 100.00 0.00', 'a full pair rides the ceiling');
  ok(tracePathFrom([-4, 9], { h: 10 }) === 'M 0.00 10.00 L 100.00 0.00', 'out-of-range values clamp, they do not escape the box');
  ok(tracePathFrom([], { h: 10 }) === 'M 0.00 5.00 L 100.00 5.00', 'nothing to plot is a resting pen, not an empty attribute');
  ok(tracePathFrom([0.25], { h: 10 }) === 'M 0.00 5.00 L 100.00 5.00', 'one sample is not a line either');
  ok(tracePathFrom([0, 1], { h: 10, amp: 0 }) === 'M 0.00 5.00 L 100.00 5.00', 'amp 0 flattens without special-casing');
  ok(tracePathFrom([0, 1], { h: 4 }).endsWith('L 100.00 0.00'), 'h scales the box');
}

console.log('tracePath is a deterministic pen');
{
  const a = tracePath('telluric', { points: 16 });
  ok(a === tracePath('telluric', { points: 16 }), 'same seed, same path — baselines stay reproducible');
  ok(a !== tracePath('void', { points: 16 }), 'a different seed draws a different trace');
  ok(tracePath(1337, { points: 16 }) === tracePath('1337', { points: 16 }), 'numeric seeds coerce like every other Icons id');
  const pts = a.split(' L ').length;
  ok(pts === 16, `16 points requested, ${pts} drawn`);
  const nums = a.match(/-?\d+\.\d+/g).map(Number);
  ok(nums.every((n) => n >= 0), 'no coordinate escapes the box on the low side');
  const xs = nums.filter((_, i) => i % 2 === 0);
  ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), 'x advances monotonically — a plotter never backs up');
  ok(xs[0] === 0 && xs[xs.length - 1] === 100, 'the trace spans the full box');
  const yss = nums.filter((_, i) => i % 2 === 1);
  ok(yss.every((y) => y >= 0 && y <= 10), 'every y sits inside the default 10-high box');
  ok(new Set(yss).size > 4, 'the pen actually moves — a flat line is not a seismograph');
}

console.log('the gauge gradations are the real band thresholds');
{
  const g = gaugeGradations();
  ok(g.length === 4, 'four gradations for five bands — Pristine is the origin, not a mark');
  ok(g[0].name === 'Seeded' && g[0].pct === 10.53, `Seeded engraves at ${g[0].pct}% (20/190)`);
  ok(g[1].name === 'Blighted' && g[1].pct === 28.95, `Blighted engraves at ${g[1].pct}% (55/190)`);
  ok(g[2].name === 'Overrun' && g[2].pct === 57.89, `Overrun engraves at ${g[2].pct}% (110/190)`);
  ok(g[3].name === 'Consumed' && g[3].pct === 100, 'Consumed is the top of the scale');
  ok(gaugeGradations([{ id: 0, name: 'a', at: 0 }, { id: 1, name: 'b', at: 50 }])[0].pct === 100,
     'the function reads whatever BANDS it is handed, so re-tuning corruption re-engraves the gauge');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to watch it fail**

Run: `node tests/ui-instruments.test.mjs`
Expected: FAIL at import — `tracePath`, `tracePathFrom` and `gaugeGradations` do not exist.

- [ ] **Step 3: Add the trace functions** — append to `src/ui/Icons.js` immediately after the `hash` function (`Icons.js:61`):

```js
/* ------------------------------------------------------------------- traces
 * The seismograph line: the diegetic UI's third component (launch spec 3.3).
 * SVG path strings rather than canvas, because a trace is a hairline that has
 * to stay a hairline while its box stretches to any width — `vector-effect:
 * non-scaling-stroke` gives that for free and a rasterised icon cannot.
 *
 * Both functions are pure and deterministic. They are baked into committed
 * screenshot baselines, so a trace that wandered between runs would make every
 * UI baseline unreproducible.
 */

/**
 * Plot `values` (each in 0..1, 0 at the floor) as a polyline across a
 * 0..100 x 0..h box. Under two values draws a resting pen at mid-height —
 * an instrument with no data still shows its zero line.
 */
export function tracePathFrom(values, { h = 10, amp = 1 } = {}) {
  const mid = h / 2;
  const n = values?.length ?? 0;
  if (n < 2) return `M 0.00 ${mid.toFixed(2)} L 100.00 ${mid.toFixed(2)}`;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(0, Number(values[i]) || 0));
    const x = (i / (n - 1)) * 100;
    const y = mid - (v - 0.5) * h * amp;
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M ${pts[0]} L ${pts.slice(1).join(' L ')}`;
}

/**
 * A pen wander seeded by any string or number: each step folds an FNV hash of
 * `seed:i` into a small delta and integrates it, with a pull back toward the
 * centre line so the trace never parks against an edge. Reads as a plotter,
 * not as white noise, which is the whole difference between an instrument and
 * a texture.
 */
export function tracePath(seed, { points = 32, h = 10, amp = 1 } = {}) {
  const n = Math.max(2, points | 0);
  const values = [];
  let v = 0.5;
  for (let i = 0; i < n; i++) {
    const d = ((hash(`${seed}:${i}`) % 1000) / 1000 - 0.5) * 0.42;
    v = v + d + (0.5 - v) * 0.22;
    values.push(Math.min(1, Math.max(0, v)));
  }
  return tracePathFrom(values, { h, amp });
}
```

- [ ] **Step 4: Add the gradation function** — in `src/ui/HUD.js`, immediately after the existing `round3` helper (`HUD.js:1045`). `BANDS` is already imported at `HUD.js:10`:

```js
/**
 * Where each corruption band's threshold sits on the gauge, as a percentage of
 * the top of the scale. The gauge is an instrument reading the planet, so its
 * gradations are the planet's real numbers: re-tune `BANDS` in
 * `src/data/corruption.js` and the engraving moves with it. Pristine is the
 * origin and gets no mark.
 */
export function gaugeGradations(bands = BANDS) {
  const top = bands[bands.length - 1].at || 1;
  return bands.slice(1).map((b) => ({
    id: b.id,
    name: b.name,
    pct: Math.round((b.at / top) * 10000) / 100,
  }));
}
```

- [ ] **Step 5: Add the CSS language** — insert into `src/ui/hud.css` directly after the `.plate` rule (currently `hud.css:106-111`), and add the five instrument tokens to the `:root` block next to the type ladder from Task 1:

```css
  /* The instrument panel's own materials (launch spec 3.3). Four surfaces:
     the casing an instrument is set into, the hairline that machines its edge,
     the lit top lip that makes the casing read as physical, and the engraving
     ink used for gradations and plotted traces alike. */
  --bezel:      rgba(7, 11, 17, 0.86);
  --bezel-line: rgba(174, 205, 235, 0.30);
  --bezel-hi:   rgba(198, 226, 255, 0.16);
  --grad:       rgba(174, 205, 235, 0.42);
  --trace-ink:  rgba(160, 199, 236, 0.62);
```

```css
/* =====================================================================
   INSTRUMENT LANGUAGE
   The whole diegetic treatment (launch spec 3.3) is three classes. Every
   screen in the game is an application of them; a screen that invents its own
   bar, its own hairline or its own casing is the failure this section exists
   to prevent.

     .bez    the machined casing an instrument sits in
     .core   a bar read as a drilled core sample of the planet
     .trace  a plotted seismograph line

   Deliberately no `clip-path` on `.bez`: the repo unified its chamfers on one
   `--skew` / corner-cut convention (see `.title-word`), and a second clip-path
   on the same element would fight it. The casing gives the edge treatment; the
   element keeps its own silhouette.
   ===================================================================== */

.bez {
  position: relative;
  background: var(--bezel);
  border: 1px solid var(--bezel-line);
  box-shadow:
    inset 0 1px 0 var(--bezel-hi),
    inset 0 0 0 1px rgba(0, 0, 0, 0.72),
    0 6px 22px rgba(0, 0, 0, 0.5);
}

/* A bar is a column of rock the party drilled out of the stage. The casing is
   dark and lit at the lip; `::before` bands it into strata so length reads as
   depth rather than as a percentage; `::after` engraves an evenly spaced
   gradation scale along the bottom lip.

   Both pseudo-elements take `z-index: 2` on purpose. `.core` is the containing
   block, and every existing fill (`.hp-fill`, `.xp-fill`, `.sbar-track i`, ...)
   is an absolutely positioned child at `z-index: auto`, which paints in DOM
   order *after* the pseudo-elements. Without the lift, every fill would bury
   the strata it is supposed to be read through. */
.core {
  position: relative;
  overflow: hidden;
  background: linear-gradient(180deg,
    rgba(0, 0, 0, 0.58) 0%, rgba(0, 0, 0, 0.22) 42%, rgba(0, 0, 0, 0.62) 100%);
  border: 1px solid var(--bezel-line);
  box-shadow: inset 0 1px 0 var(--bezel-hi), inset 0 0 0 1px rgba(0, 0, 0, 0.6);
}
.core::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: repeating-linear-gradient(90deg,
    rgba(0, 0, 0, 0.42) 0 1px,
    transparent 1px var(--core-band, 0.5em));
}
.core::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 0.28em;
  z-index: 2;
  pointer-events: none;
  background: repeating-linear-gradient(90deg,
    var(--grad) 0 1px,
    transparent 1px var(--core-grad, 25%));
}
/* The corruption gauge's gradations are the real band thresholds and are not
   evenly spaced, so it engraves its own marks as elements and turns the
   generated scale off. */
.core--bands::after { content: none; }

/* The plotted line. `preserveAspectRatio="none"` in the markup lets the 0..100
   box stretch to any width; `non-scaling-stroke` keeps the pen a hairline
   through that stretch, which is the reason this is SVG and not a canvas. */
.trace {
  display: block;
  width: 100%;
  height: var(--trace-h, 0.9em);
  overflow: visible;
  opacity: 0.9;
}
.trace path {
  fill: none;
  stroke: var(--trace-ink);
  stroke-width: 1;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
```

- [ ] **Step 6: Run the tests**

Run: `node tests/ui-instruments.test.mjs` — PASS.
Run: `node tests/ui-type-scale.test.mjs` — still PASS (the new section declares no font-size).
Run: `npm test` — green.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Icons.js src/ui/HUD.js src/ui/hud.css tests/ui-instruments.test.mjs
git commit -m "The instrument language gets its parts: a bezel, a drilled core, and a pen that plots"
```

---

### Task 3: The gauge becomes the instrument

The spec names the corruption gauge as the centrepiece. Today it is a 180x6px purple rectangle with two labels absolutely positioned underneath at a hardcoded 10px. It becomes a real instrument: engraved gradations at the actual band thresholds, a redline zone past Overrun, and a chart recorder plotting the run's own corruption history — the one moving trace in the game, and the one that makes the panel read as *reading the planet*. Every other bar in the HUD takes the core-sample treatment in the same pass.

**Files:**
- Modify: `src/ui/HUD.js:1155-1159` (gauge markup), `src/ui/HUD.js:666-710` (`updateMoney`'s gauge block), `src/ui/HUD.js:1051-1113` (`refs`; the corruption entries sit at 1060-1063), `src/ui/HUD.js:19` (import)
- Modify: `src/ui/hud.css:328-396` (gauge), `hud.css:720-728` (`.hpbar`), `hud.css:826-843` (`.xpbar`), `hud.css:570-592` (`.boss-track`)
- Test: extend `tests/ui-instruments.test.mjs` with the ring-buffer block below

**Interfaces:**
- Consumes: `tracePathFrom` and `gaugeGradations` from Task 2; `BANDS` (`HUD.js:10`); `this.set` / `this.pulse` (`HUD.js:556`, `HUD.js:481`); `.core`, `.core--bands`, `.bez`, `.trace` from Task 2.
- Produces: refs `corruptionTrack`, `corruptionTrace`; constants `TRACE_SAMPLES = 48`, `TRACE_INTERVAL = 1.5`; instance state `this._trace` (array), `this._traceT` (seconds).

- [ ] **Step 1: Write the failing test** — append to `tests/ui-instruments.test.mjs`, before the summary lines:

```js
console.log('the gauge trace is a ring buffer written through the diff cache');
{
  const { HUD } = await import('../src/ui/HUD.js');
  // Same idiom as tests/hud-strip-hold.test.mjs: a real HUD needs a document,
  // so the method is driven through the prototype on a hand-built `this`
  // carrying only the fields the gauge block touches.
  let writes = 0, lastD = null;
  const noop = { toggle() {}, add() {}, remove() {} };
  const self = Object.create(HUD.prototype);
  self.c = {};
  self.moneyShown = 0;
  self.refs = {
    money: { classList: noop }, moneyVal: { textContent: '' },
    corruption: { dataset: {}, classList: noop },
    corruptionFill: { style: {} },
    corruptionBand: { textContent: '' },
    corruptionRoute: { textContent: '', classList: noop },
    corruptionTrace: { setAttribute: (k, v) => { writes++; lastD = v; } },
  };
  const ctx = (world) => ({
    items: { gold: 0 },
    corruption: { world, band: 0 },
    progression: { stageIndex: 0 },   // < 2, so the route branch stays out of this test
  });

  // Ten seconds at a flat zero. `_traceT` starts primed, so the pen strikes on
  // the first frame and then every 1.5 s: 7 samples in 600 frames at 1/60.
  for (let i = 0; i < 600; i++) self.updateMoney(ctx(0), 1 / 60);
  ok(self._trace.length === 7, `7 samples in 10 s at a 1.5 s interval (held ${self._trace.length})`);
  ok(writes === 7, `one write per sample while the window is still filling (wrote ${writes})`);

  // Once the window is full, a still instrument costs nothing: the buffer's
  // quantised key stops changing and `this.set` swallows every write. This is
  // the property that lets the pen live in the per-frame update at all.
  for (let i = 0; i < 5000; i++) self.updateMoney(ctx(0), 1 / 60);
  ok(self._trace.length === 48, `the ring buffer caps at 48 samples (held ${self._trace.length})`);
  const settled = writes;
  for (let i = 0; i < 600; i++) self.updateMoney(ctx(0), 1 / 60);
  ok(writes === settled, `a flat, full window writes nothing further (${writes - settled} extra writes)`);

  // A climbing run redraws.
  for (let i = 0; i < 600; i++) self.updateMoney(ctx(i), 1 / 60);
  ok(writes > settled, 'a climbing run redraws the pen');
  ok(typeof lastD === 'string' && lastD.startsWith('M '), `the pen writes a path (${lastD?.slice(0, 24)}...)`);
  ok(self._trace.length === 48, 'the window is still bounded after the climb');
}
```

- [ ] **Step 2: Run it to watch it fail**

Run: `node tests/ui-instruments.test.mjs`
Expected: FAIL — `refs.corruptionTrace` is never written; `self._trace` is undefined.

- [ ] **Step 3: Rebuild the gauge markup** — replace `src/ui/HUD.js:1155-1159` in `TEMPLATE`:

```js
  <div class="corruption" data-band="0">
    <div class="corruption-track core core--bands">
      <div class="corruption-fill"></div>
      <i class="corruption-redline"></i>
      ${gaugeGradations().map((g) => `<i class="corruption-grad" style="left:${g.pct}%" data-band="${g.id}"></i>`).join('')}
    </div>
    <svg class="trace corruption-trace" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
      <path d="M 0.00 5.00 L 100.00 5.00" />
    </svg>
    <b class="corruption-band">Pristine</b>
    <i class="corruption-route"></i>
  </div>
```

The wrapper is load-bearing: `.core` sets `overflow: hidden`, and the band label and route line used to be absolutely positioned *outside* the 6px bar. Left where they were, the casing would have clipped both away. In the new structure they are normal flow items in a column, which also retires the `.corruption.has-route` margin hack — `HUD.js` still toggles the class and the CSS below simply no longer reacts to it.

Add `gaugeGradations` to the module's own scope: it is defined in this file (Task 2, after `round3`), so no import is needed — but `TEMPLATE` is evaluated at construction time and `gaugeGradations` is a hoisted function declaration, so the ordering is safe. Verify by reading the file: if `TEMPLATE` is invoked from the constructor before the declaration is reached, function hoisting still covers it.

- [ ] **Step 4: Add the refs** — in the `refs` object (`HUD.js:1051-1113`), next to the existing corruption entries at `HUD.js:1060-1063` (find `corruption:` / `corruptionFill:` and add below them):

```js
    corruptionTrack: q('.corruption-track'),
    corruptionTrace: q('.corruption-trace path'),
```

- [ ] **Step 5: Add the chart recorder** — near the other HUD constants (`HUD.js:42-83`), add:

```js
/* The gauge's chart recorder. A run's corruption history is the one piece of
   state the HUD holds that the world itself does not — Corruption.js knows the
   number now, nobody knows the shape of how it got there. 48 samples at 1.5 s
   is 72 seconds of trailing history: long enough that a chest opening shows as
   a step, short enough that the pen keeps moving. */
const TRACE_SAMPLES = 48;
const TRACE_INTERVAL = 1.5;
```

Then, inside the `if (cor && this.refs.corruption)` block of `updateMoney` (`HUD.js:670`), immediately after the `corruptionFrac` `this.set` call (`HUD.js:673-675`):

```js
      // The pen. It advances on wall-clock, not per frame, and the write goes
      // through the diff cache keyed on the quantised buffer — so a run whose
      // corruption is not moving costs exactly zero DOM writes, and a run that
      // is climbing costs one `setAttribute` every 1.5 s.
      this._trace ??= [];
      this._traceT = (this._traceT ?? TRACE_INTERVAL) + dt;
      if (this._traceT >= TRACE_INTERVAL) {
        this._traceT = 0;
        this._trace.push(frac);
        if (this._trace.length > TRACE_SAMPLES) this._trace.shift();
        this.set('corTrace', this._trace.map((v) => Math.round(v * 200)).join(','), () => {
          this.refs.corruptionTrace?.setAttribute('d', tracePathFrom(this._trace, { h: 10 }));
        });
      }
```

Add `tracePathFrom` to the existing `Icons.js` import at `HUD.js:19`:

```js
import { abilityIcon, abilityArt, equipmentArt, itemArt, hexOf, TIER_ORDER, tracePathFrom } from './Icons.js';
```

- [ ] **Step 6: Restyle the gauge** — replace `src/ui/hud.css:328-396` wholesale:

```css
/* The run's second price, and the panel's centrepiece instrument (launch spec
   3.3). Everything about it is the real economy rendered as gauge hardware:
   the gradations sit at the actual band thresholds from `data/corruption.js`
   (see `gaugeGradations`), the redline opens where Overrun does, and the trace
   under the casing is this run's own corruption history — the instrument is
   reading the planet, and what it plots is what the party did to it. */
.corruption {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.18em;
  width: 13em;
  margin-bottom: 0.3em;
}
.corruption-track {
  position: relative;
  width: 100%;
  height: 0.62em;
  --core-band: 0.62em;
  border-color: rgba(160, 120, 255, 0.34);
}
.corruption-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 0%;
  background: linear-gradient(180deg, #9260e6, #7a4fd0 55%, #4b2b8c);
  transition: width 0.3s ease;
}
/* The redline: the gauge tells you where the route stops being contested
   before the route label does. Opens at Overrun (110 of 190 = 57.89%), which
   is `gaugeGradations()[2].pct` — hardcoded here because CSS cannot read it,
   and pinned by `tests/ui-instruments.test.mjs` so a re-tune fails loudly. */
.corruption-redline {
  position: absolute;
  left: 57.89%; right: 0; top: 0; bottom: 0;
  z-index: 1;
  background: repeating-linear-gradient(-45deg,
    rgba(255, 47, 176, 0.20) 0 2px, transparent 2px 5px);
}
/* Engraved gradations. `z-index: 3` puts them above the strata, because a
   scale is cut into the casing and the strata are behind the glass. */
.corruption-grad {
  position: absolute;
  top: -1px; bottom: -1px;
  z-index: 3;
  width: 1px;
  background: var(--grad);
}
.corruption-grad[data-band="4"] { background: rgba(255, 143, 214, 0.75); }
.corruption-trace {
  --trace-h: 0.8em;
  --trace-ink: rgba(185, 161, 232, 0.55);
  width: 100%;
}
.corruption-band {
  font-size: var(--fs-micro);
  font-weight: var(--fw-label);
  letter-spacing: var(--track-eyebrow);
  text-transform: uppercase;
  color: #b9a1e8;
}
/* The door this band is buying, from stage 3 on. In flow under the label now:
   the gauge is a column, so the row it needs is the row it takes. */
.corruption-route {
  display: none;
  font-style: normal;
  font-size: var(--fs-micro);
  letter-spacing: var(--track-label);
  white-space: nowrap;
  color: #b9a1e8;
  opacity: 0.78;
}
.corruption-route.is-on { display: block; }
/* A crossing is announced here too, not just on the screen grade: the casing
   flares once on the frame the band label changes. Kept to a glow and a label
   kick — the track is a thin rule in a busy corner, so scaling it reads as a
   glitch. The class still lands on `.corruption`; the flare is on the casing,
   which is the part that looks like hardware. */
.corruption.is-tick .corruption-track { animation: cortick 0.5s ease-out; }
.corruption.is-tick .corruption-band { animation: cortickband 0.5s ease-out; }
@keyframes cortick {
  0% { box-shadow: 0 0 0 0 rgba(255, 47, 176, 0.7); }
  100% { box-shadow: 0 0 0 10px rgba(255, 47, 176, 0); }
}
@keyframes cortickband {
  0% { transform: translateY(-2px); color: #ff8fd6; }
  100% { transform: translateY(0); color: #b9a1e8; }
}
/* A descent is announced too, but never in the warning colour and never with
   the same kick: the font's own argent blue, downward, and dimmer. Same rule
   the screen grade and the band sting already follow — a cleanse is good news
   and none of the three channels may read as a hit. */
.corruption.is-tick-down .corruption-track { animation: cortickdown 0.5s ease-out; }
.corruption.is-tick-down .corruption-band { animation: cortickbanddown 0.5s ease-out; }
@keyframes cortickdown {
  0% { box-shadow: 0 0 0 0 rgba(159, 212, 255, 0.5); }
  100% { box-shadow: 0 0 0 8px rgba(159, 212, 255, 0); }
}
@keyframes cortickbanddown {
  0% { transform: translateY(2px); color: #cfe8ff; }
  100% { transform: translateY(0); color: #b9a1e8; }
}
.corruption[data-band="2"] .corruption-fill { background: linear-gradient(180deg, #b055f0, #9a3fe0 55%, #5d2288); }
.corruption[data-band="3"] .corruption-fill { background: linear-gradient(180deg, #dd52e8, #c72fd6 55%, #7a1a86); box-shadow: 0 0 6px #c72fd6; }
.corruption[data-band="4"] .corruption-fill { background: linear-gradient(180deg, #ff62c6, #ff2fb0 55%, #96125f); box-shadow: 0 0 10px #ff2fb0; }
.corruption[data-band="3"] .corruption-trace,
.corruption[data-band="4"] .corruption-trace { --trace-ink: rgba(255, 143, 214, 0.68); }
```

- [ ] **Step 7: Give the other three bars the core treatment** — three additive edits, no markup changes:
  - `.hpbar` (`hud.css:720-728`): add `.hpbar` to the `.core` treatment by adding the class in `TEMPLATE` (`HUD.js:1211`: `<div class="hpbar core">`) and, in the CSS rule, delete the now-duplicated `background`, `border` and `overflow` declarations, replacing them with `--core-band: 0.9em; --core-grad: calc(100% / 8);` so the engraved scale lands exactly on the eight segment ticks `.hp-ticks` already draws. Keep the `transform: skewX(var(--skew))` and the `box-shadow` — the shake keyframe depends on the skew being on this element.
  - `.xpbar` (`hud.css:826-843`): add `core` in `TEMPLATE` (`HUD.js:1224`: `<div class="xpbar core">`) and set `--core-band: 0.7em; --core-grad: 10%;` — ten gradations, one per level's worth of the track, which is what `.xp-ticks` already implies.
  - `.boss-track` (`hud.css:570-592`): add `core` in `TEMPLATE` (`HUD.js:1171`: `<div class="boss-track core">`) and set `--core-band: 1.1em;` and `.boss-track.core::after { content: none; }` — the boss bar already draws its own phase segments through `.boss-segs`, and a second scale under them would read as a second phase count.

  In each case, read the live rule first and remove only the declarations `.core` now provides; leave every colour, glow and animation hook alone.

- [ ] **Step 8: Run the tests**

Run: `node tests/ui-instruments.test.mjs` — PASS.
Run: `node tests/ui-type-scale.test.mjs` — PASS (the two 10px sizes are gone for good).
Run: `node tests/hud-strip-hold.test.mjs` — PASS (unchanged, but it drives HUD.prototype and is the canary for a broken module).
Run: `npm test` — green.

- [ ] **Step 9: See it** — `node tools/capture.mjs --out shots/gauge --only 06-loaded-hud,04-combat $CAPFLAG`. Confirm in `shots/gauge/06-loaded-hud.png`: the gauge has visible gradation hairlines, the strata read across the health bar, and no label has been clipped by the new casing. Do not commit `shots/gauge`.

- [ ] **Step 10: Commit**

```bash
git add src/ui/HUD.js src/ui/hud.css tests/ui-instruments.test.mjs
git commit -m "The gauge becomes the instrument: real gradations, a redline, and the run's own trace"
```

---

### Task 4: The menus join the panel

Title, survivor select, difficulty, artifacts, pause, settings, co-op and the death summary all live in `Menus.js`. They already share `.panel`, `.panel-head`, `.mbtn` and `.chip`, so the treatment is applied at those shared points, not per screen. Two markup additions only: a trace under `.panel-head`, and a trace under the title wordmark.

**Files:**
- Modify: `src/ui/Menus.js` — the `build()` template (`Menus.js:173-460`), the survivor-stats renderer (`Menus.js:619-631`), and the `EDICT_STYLE` block (`Menus.js:1664-1844` — the literal closes at 1844; the lines after it are `document.head.appendChild(el)` and an unrelated function)
- Modify: `src/ui/hud.css` — `.title-rule` (1294-1301), `.panel-head` (1402-1424), `.sbar-track` (2229-2242), `.stat` / `.stat-grid` (1630-1650), `.chip` (1961-1980), `.sur` (2070-2120)

**Interfaces:**
- Consumes: `tracePath`, `tracePathFrom` from `Icons.js` (Task 2); `.bez`, `.core`, `.trace` (Task 2); the type ladder (Task 1).
- Produces: the markup convention `<svg class="trace ..." viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><path d="..."/></svg>`, which Task 5 repeats in the logbook.

- [ ] **Step 1: Import the trace functions** — at the top of `src/ui/Menus.js`, add `tracePath` and `tracePathFrom` to the existing `./Icons.js` import (read the live import line; it currently pulls `markIcon`/`itemIcon`-family helpers).

- [ ] **Step 2: The title's rule becomes a trace** — in `build()`, replace the title rule (`Menus.js:180`):

```js
          <svg class="trace title-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
            <path d="${tracePath(ctx.seed ?? 'telluric-void', { points: 40, amp: 0.72 })}" />
          </svg>
```

The seed is the trace's data, and it is honest data: the title screen already prints `SEED <span data-seed>` two lines below, so the line under the wordmark is that seed's own signature — a different planet draws a different trace. Verify the field: `Menus.js` fills `[data-seed]` from somewhere in `apply()`/`bindProgress` — use the same expression it uses, and fall back to the literal `'telluric-void'` if the seed is not yet known at build time.

Now replace the `.title-rule` rule in `hud.css` — it opens at **line 1294** and closes at **1301**, immediately before the comment that introduces `.title-seed` at 1304. **Read those eight lines before overwriting them**: this is the plan's only instruction to replace a CSS rule wholesale by range rather than by search, so confirm the block you are about to delete is the one that draws the 3px cyan gradient bar (`height: 3px`, a `linear-gradient(90deg, ...)` through `var(--t-lunar)`, a `clip-path` and `transform: skewX(var(--skew))`). If it is not, find `.title-rule {` and replace that block instead. Preserve nothing from the old rule except the shear — the gradient bar is exactly what this step retires.

```css
/* The rule under the wordmark is the planet's own seismograph line, plotted
   from the run seed — the same number the line below it prints. It keeps the
   lockup's shear so the mark reads as one object. */
.title-rule {
  --trace-h: 1.5em;
  --trace-ink: color-mix(in srgb, var(--t-lunar) 78%, transparent);
  width: min(54vw, 40em);
  margin: 0.8em auto 0.7em;
  transform: skewX(var(--skew));
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--t-lunar) 40%, transparent));
}
```

- [ ] **Step 3: Every panel head gets its trace** — `.panel-head` currently separates itself from its body with `border-bottom: 1px solid rgba(148, 182, 214, 0.25)` (`hud.css:1408`). That hairline is the single most web-page-looking element in the game, and it appears on **eight** screens: seven in `Menus.js` (select, difficulty, artifacts, edict, **pause**, settings, co-op) and one in `Logbook.js`, which Task 5 handles. Replace it with a plotted line, generated from the head's own title so each screen's rule is distinguishable.

In `build()`, add one child to each `<header class="panel-head">`. Do not work from the list above — run `grep -n panel-head src/ui/Menus.js` and treat its seven hits as the worklist, because a head added since this plan was written still needs its rule:

```js
            <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <path d="${tracePath('Select Survivor', { points: 56, amp: 0.5 })}" />
            </svg>
```

...with the seed string matching that head's own `<h2>` text. Because `.panel-head` is a `display: flex` row with `align-items: baseline`, the trace must be taken out of that row — CSS below.

In `hud.css`, replace the `border-bottom` on `.panel-head` and add the rule:

```css
.panel-head {
  position: relative;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1em;
  padding-bottom: 0.9em;
  margin-bottom: 1.2em;
}
/* The hairline every panel used to draw is now a plotted line seeded by the
   panel's own title: the same treatment as the wordmark's rule, so a head and
   a title read as the same instrument. Absolute so it does not become a third
   flex item in the head's baseline row. */
.panel-rule {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  --trace-h: 0.75em;
  --trace-ink: rgba(148, 182, 214, 0.42);
}
```

- [ ] **Step 4: Survivor stat bars become core samples** — this is the spec's "core-sample bars" in its most literal place. In `Menus.js:627-631`, add the class (markup shape otherwise unchanged, so `Harness.js`'s `14-survivor-select` assertions hold):

```js
      return `<div class="sbar">
          <div class="sbar-k">${s.label}</div>
          <div class="sbar-track core"><i style="transform:scaleX(${frac.toFixed(3)})"></i></div>
          <div class="sbar-v">${text}</div>
```

In `hud.css:2229-2242`, strip what `.core` now provides and keep only what is specific:

```css
/* Stat bars are drawn against the roster maximum, not against an absolute —
   the only useful question here is "more or less than the other three". As
   core samples they also answer it by depth: four columns drilled side by
   side, strata aligned, so the eye compares length without reading a number. */
.sbar-track {
  height: 0.72em;
  --core-band: 0.42em;
  --core-grad: 20%;
  transform: skewX(var(--skew));
}
.sbar-track i {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 55%, #05070a), var(--accent));
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 45%, transparent);
}
```

- [ ] **Step 5: The survivor's stat profile gets a trace** — under `.sel-plate`, the survivor's own numbers plotted as one line, so the roster reads as four instrument readings rather than four cards. In `Menus.js` where `[data-sel-stats]` is filled (`Menus.js:619`), the per-stat `frac` is already computed; collect them and emit one trace above the bars:

The site currently reads `q('[data-sel-stats]').innerHTML = STAT_BARS.map((s) => { ... }).join('')`. Hoist the map into a local so the fractions are in hand before the trace is emitted — the map already computes `frac` per row, so this is a reorder, not new math:

```js
    const fracs = [];
    const rows = STAT_BARS.map((s) => {
      // ... every existing line of this callback, unchanged, up to and
      //     including whatever computes `frac` and `text` ...
      fracs.push(frac);
      return `<div class="sbar">
          <div class="sbar-k">${s.label}</div>
          <div class="sbar-track core"><i style="transform:scaleX(${frac.toFixed(3)})"></i></div>
          <div class="sbar-v">${text}</div>
        </div>`;
    }).join('');
    q('[data-sel-stats]').innerHTML =
      `<svg class="trace sel-trace" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
         <path d="${tracePathFrom(fracs, { amp: 0.9 })}" />
       </svg>${rows}`;
```

(The closing `</div>` of the row and the exact body of the callback come from the live file at `Menus.js:619-632`; the only edits are the `fracs.push(frac)` line, the `core` class from Step 4, and the wrapper around the assignment.)

```css
/* The survivor's whole stat profile as one plotted line, above the four bars
   that break it out. Real data: these are the same fractions the bars draw. */
.sel-trace {
  --trace-h: 1.3em;
  --trace-ink: color-mix(in srgb, var(--accent) 62%, transparent);
  margin-bottom: 0.4em;
}
```

- [ ] **Step 6: Casings for the readout blocks** — four additive class edits in `build()`, no structural change:
  - `.sel-plate` (opening tag at `Menus.js:213`) gains `bez`: `<div class="sel-plate bez">`, and in `hud.css:2146-2154` drop the now-duplicated `background` (keep `border-left: 3px solid var(--accent)` and the `clip-path`).
  - `.chip` (opening tags at `Menus.js:227` and `Menus.js:230`) gains `bez`, and `hud.css:1961+` drops its own background/border.
  - `.run-id-cell` and `.stat` in the death summary (`Menus.js`, the `stat-grid`/`run-id` renderers) each gain `bez`; drop their backgrounds in `hud.css:1630-1650`.
  - `.sur` roster buttons (`Menus.js`, the `sel-roster` renderer) gain `bez`; drop the background in `hud.css:2070+`, keep `.sur-rule` and the `is-on` treatment.

  In every case: read the live rule, remove only `background` / `border` / `box-shadow` declarations that `.bez` now supplies, and leave accent colours, clip-paths and state classes untouched.

- [ ] **Step 7: Bring the Edict block under the same tokens** — in `Menus.js`'s `EDICT_STYLE`, `.eitem` and `.estand` are hand-rolled panels with their own backgrounds. Replace those declarations with `var(--bezel)` / `var(--bezel-line)` and add `bez` to the `.eitem` / `.estand` markup, so the runtime-injected sheet consumes the language rather than duplicating it. Its font sizes are already on the ladder from Task 1.

- [ ] **Step 8: Run the gates**

Run: `node tests/ui-type-scale.test.mjs` and `node tests/ui-instruments.test.mjs` — PASS.
Run: `npm test` — green.
Run: `node tools/capture.mjs --out shots/menus --only 01-title,14-survivor-select,17-artifacts,18-difficulty,16-run-summary $CAPFLAG`
Expected: all five scenarios report their `mustContain` assertions satisfied — the harness's DOM contracts are the regression test for "no renames". If a scenario fails, a class or `data-*` attribute was renamed; restore it. Inspect all five PNGs before moving on. Do not commit `shots/menus`.

- [ ] **Step 9: Commit**

```bash
git add src/ui/Menus.js src/ui/hud.css
git commit -m "The menus join the panel: every bar is a core sample, every rule is a trace"
```

---

### Task 5: The logbook reads as field notes from the same instrument

The logbook is the screen the spec's cold-audience test lingers on, and it is the most web-page-shaped thing in the build: a nav rail, a scrolling list and a detail pane with a stat grid. It keeps that structure — it is the right structure — and takes the same three parts.

**Files:**
- Modify: `src/ui/Logbook.js` — the shell template (`Logbook.js:356-376`), the stat-cell helper (`Logbook.js:847-848`), the challenge progress rows (`Logbook.js:780`, `Logbook.js:989`)
- Modify: `src/ui/hud.css` — logbook section (2390-2633) and the meta/post-run section (2688-2803)

**Interfaces:**
- Consumes: `tracePath` from `Icons.js`; `.bez`, `.core`, `.trace`, `.panel-rule` (Tasks 2 and 4).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Import the trace function** — add `tracePath` to `Logbook.js`'s existing `./Icons.js` import.

- [ ] **Step 2: The logbook's panel head gets its rule** — in the shell template (`Logbook.js:361-364`), add the same child Task 4 added to the menu panel heads, seeded on this head's own title:

```js
      <header class="panel-head">
        <h2>Logbook</h2>
        <div class="panel-tag" data-book-count></div>
        <svg class="trace panel-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath('Logbook', { points: 56, amp: 0.5 })}" />
        </svg>
      </header>
```

The `.panel-rule` CSS from Task 4 already covers it — that is the point of defining it once.

- [ ] **Step 3: The detail head gets a trace seeded by its entry** — in each detail renderer that emits `<div class="book-head">` (`Logbook.js:647`, `671`, `690`, `723`, `748`, `775` — grep `book-head` for the full set), add one child after `.book-sub`:

```js
        <svg class="trace book-rule" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="${tracePath(c.name, { points: 44, amp: 0.6 })}" />
        </svg>
```

...substituting each renderer's own entry-name expression for `c.name` (`d.name`, `entry.name`, `'Career'`, and so on — read each site). Every entry in the book therefore draws its own line, and no two are alike.

```css
/* A trace per entry, seeded by the entry's own name — the book's index is a
   run of readings, and no two readings are the same shape. */
.book-rule {
  --trace-h: 0.9em;
  --trace-ink: color-mix(in srgb, var(--accent) 55%, transparent);
  margin-top: 0.45em;
}
```

- [ ] **Step 4: Stat cells become instrument readouts** — `Logbook.js:847-848` emits every stat cell in the book:

```js
  return `<div class="book-stat bez"><div class="book-stat-k">${escapeHtml(k)}</div><div class="book-stat-v">${escapeHtml(String(v))}</div></div>`;
```

In `hud.css:2530-2541`, drop `.book-stat`'s own background/border (whatever it declares — read it) and keep its padding and grid placement. Set the readout voice on the value:

```css
.book-stat-v {
  margin-top: 0.25em;
  font-size: 1.2em;
  font-weight: var(--fw-read);
  color: #fff;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Challenge progress becomes a core sample** — two sites emit the progress bar with the identical shape the survivor stat bar uses. `Logbook.js:780`:

```js
      <div class="book-prog core"><i style="transform:scaleX(${(c.fraction ?? 0).toFixed(3)})"></i></div>
```

...and the same class addition at `Logbook.js:989`. Then in `hud.css:2598-2609`, strip what `.core` supplies and keep the rest:

```css
.book-prog {
  height: 0.7em;
  --core-band: 0.4em;
  --core-grad: 25%;
}
.book-prog i {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  background: linear-gradient(90deg, color-mix(in srgb, var(--t-boss) 45%, #05070a), var(--t-boss));
}
```

(Read the live `.book-prog i` rule first and preserve its actual fill colour and glow; the snippet above shows the shape, and the colour is whatever the file already uses.)

- [ ] **Step 6: The tab rail gets its casing** — `.book-tabs` / `.tabbtn` (`hud.css:2394-2410`) is the screen's remaining flat-web element. Add `bez` to `.book-tabs` in the shell template (`Logbook.js:366`: `<nav class="book-tabs bez" data-book-tabs>`) and drop `.book-tabs`'s own background in the CSS. Leave `.tabbtn`'s `is-on` treatment exactly as it is — the selected tab is state, and this slice does not re-tune state colours.

- [ ] **Step 7: The run-summary meta blocks** — `.run-best`, `.run-prog` and `.book-section` (`hud.css:2688-2803`) each draw their own panel. Add `bez` to `.run-best` and `.run-prog` at their render sites in `Logbook.js` and drop their backgrounds, exactly as Steps 4 and 6 did.

- [ ] **Step 8: Run the gates**

Run: `node tests/ui-type-scale.test.mjs`, `node tests/ui-instruments.test.mjs` — PASS.
Run: `npm test` — green.
Run: `node tools/capture.mjs --out shots/book --only 15-logbook,16-run-summary $CAPFLAG`
Expected: both scenarios' `mustContain` assertions pass — `15-logbook` checks the index/detail split and the live model viewer, so it is the regression test for the `.book-stage` mount surviving the pass. Inspect both PNGs. Do not commit `shots/book`.

- [ ] **Step 9: Commit**

```bash
git add src/ui/Logbook.js src/ui/hud.css
git commit -m "The logbook reads like the field notes of the same instrument"
```

---

### Task 6: Gates, money shot, baselines

The repo has no UI visual baselines. This slice both needs them (a treatment applied everywhere is exactly the change a per-pixel diff should be able to size) and is the right moment to create them, because the before/after is the deliverable.

**Files:**
- Create: `reviews/round8/ui-shots-before/` (pre-slice capture), `reviews/round8/ui-shots-after/`, `reviews/round8/ui-shot-diff.json`, `reviews/round8/ui-gauge-probe-record.json`, `reviews/round8/UI-BASELINE.md`
- Modify: none expected.

- [ ] **Step 1: Full suite**

Run: `npm test` — every suite green, including the two new files.
Run: `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json`
Expected: **zero fields moved.** This slice touches only `src/ui/*` and draws no `ctx.rng`, so equivalence is inert by construction. A moved field means an implementer edited outside the slice; it is a bug in the work, never a baseline to regenerate.

- [ ] **Step 2: Confirm the "before" is on disk** — `reviews/round8/ui-shots-before/` was captured and committed by Task 1 Step 0, at the SHA recorded there. Verify the eight PNGs and the `manifest.json` are present and that the manifest is not `manifest.FAILED.json`. If the directory is missing, the "before" is unrecoverable at this point: say so plainly in the report and ship the after-only baseline rather than reconstructing a comparison that has no source.

- [ ] **Step 3: Capture the "after"** — same eight scenarios, same seed, so the diff is the treatment and nothing else:

```bash
node tools/capture.mjs --out reviews/round8/ui-shots-after --seed 1337 --only 01-title,14-survivor-select,15-logbook,17-artifacts,18-difficulty,16-run-summary,06-loaded-hud,10-inventory $CAPFLAG
node tools/shotdiff.mjs reviews/round8/ui-shots-before reviews/round8/ui-shots-after --out reviews/round8/ui-shot-diff.json
```

Report the per-scenario `meanDiff` / `pctOver8` table. Expect large numbers on all eight — this is a deliberate whole-surface reskin, so a *small* diff is the failure mode (it would mean the treatment did not reach that screen). Any scenario under ~2% `pctOver8` gets investigated and named in the report.

- [ ] **Step 4: The money shot** (spec §3.4 — every feature milestone ends with its money shot). This slice's thesis image is the centrepiece instrument doing its job: the corruption gauge at a deep band with the run's climb plotted under it, the core-sample health bar beside it, the whole panel reading as hardware. `tools/routeprobe.mjs` already drives the corruption gauge HUD to real bands — read its header, follow its conventions, and add a shot arm that pushes the run to band 3 or 4, lets 60+ seconds of simulation accrue so the trace has a shape to show, and captures the frame to `reviews/round8/ui-money-shot.png`. Record alongside it, in `reviews/round8/ui-gauge-probe-record.json`: the world corruption at capture, the band, the gradation percentages actually rendered (read the `.corruption-grad` elements' `style.left` from the live DOM), the sample count in `HUD._trace`, and the `d` attribute the pen last wrote. Those five numbers are what let the next critique argue with this frame instead of about it.

- [ ] **Step 5: Name the baselines** — write `reviews/round8/UI-BASELINE.md`: the SHA each directory was captured at, the exact `capture.mjs` invocation (seed, resolution, scenario list), the `shotdiff` table from Step 3, and a one-line statement that `ui-shots-after/` is the reference for future UI work. Without the capture command on record the images are screenshots, not baselines.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "The panel photographs as one product: gates held, baselines named"
```

---

## Self-review notes

- **Spec coverage (§3.3):** *one diegetic treatment* ✓ (Task 2 defines three classes and two functions; Tasks 3-5 only apply them, and Task 1's lint mechanically forbids a screen re-litigating the type half). *Across menus, HUD, logbook, survivor select* ✓ (Task 3 HUD, Task 4 menus + select, Task 5 logbook — plus the Edict screen's runtime-injected sheet, which the recon nearly let slip as a second stylesheet). *Seismograph lines* ✓ (`tracePath`/`tracePathFrom`, applied at the title rule, every panel head, the survivor stat profile, every logbook entry head, and the gauge). *Core-sample bars* ✓ (`.core` on health, XP, boss, survivor stats, logbook progress, corruption). *The corruption gauge as the centrepiece instrument* ✓ (Task 3 — gradations at the real thresholds, redline at Overrun, and the chart recorder, which is the one thing on screen that plots the planet over time). *Money shot into the shot library* ✓ (Task 6, per §3.4). The playtest's font finding ✓ (Task 1, at the token layer, with a lint that keeps it fixed).
- **Type consistency:** `tracePath` / `tracePathFrom` / `gaugeGradations` are spelled identically in Icons.js, HUD.js, Menus.js, Logbook.js and both test files; `tracePathFrom`'s contract (values in `[0,1]`, `0` at the floor, `h` default 10) is stated once in Task 2 and relied on unchanged by Tasks 3-5; `.bez` / `.core` / `.core--bands` / `.trace` and the tokens `--core-band` / `--core-grad` / `--trace-h` / `--trace-ink` / `--bezel*` / `--grad` are defined in Task 2 and only consumed afterwards; `--fs-micro` / `--fw-*` / `--track-*` are defined in Task 1 and asserted by name in its own lint.
- **What the tests actually cover, honestly:** the type ladder (a text lint over the two files where CSS lives), the trace geometry and its determinism (pure functions, exact strings), the gauge gradation math, and the chart recorder's write discipline through the diff cache. What they do **not** cover is whether any of it looks like an instrument panel — that is the shot harness's job in Task 6, and the reason this slice ends with committed before/after baselines and a diff table rather than a green checkmark. The harness's per-scenario `mustContain` DOM assertions double as the regression test for the no-renames constraint, which is why Tasks 4 and 5 each run capture before committing.
- **Known execution-time checks (deliberate):** the expression `Menus.js` uses to fill `[data-seed]`, needed for the title trace (Task 4 Step 2); the full set of `panel-head` sites across `Menus.js` and `Logbook.js` (Task 4 Step 3 / Task 5 Step 2 — grep, do not assume); the live declarations inside `.sur`, `.chip`, `.stat`, `.book-stat`, `.book-tabs`, `.book-prog i` and `.run-best` that `.bez`/`.core` now supersede (Tasks 4 and 5 say "read the rule, remove only what is duplicated"); whether the `--seed` flag reproduces the survivor-select and logbook scenes deterministically enough for a clean diff (Task 6 Step 3 — if a scenario's diff is dominated by scene noise rather than UI, say so in the report and exclude it rather than quoting it).
- **The sharp edge, restated:** no renames. Every class name and `data-*` attribute in this slice is added, never changed, because `src/core/Harness.js` asserts on live selectors per capture scenario and a rename fails the shot rather than the test suite. The one structural change in the whole plan — wrapping the corruption gauge's bar in `.corruption-track` — is forced by `.core`'s `overflow: hidden` clipping the two labels that used to be positioned outside the 6px bar, and it preserves `.corruption`, `.corruption-fill`, `.corruption-band` and `.corruption-route` exactly where the HUD's refs and CSS selectors expect them.

---

## Post-review amendments (pre-flight, 2026-08-08)

The plan came back SPEC-CONFIRMED but NOT READY: 1 blocker, 1 major, 9 minor.
The reasoning is on record in `.superpowers/sdd/2026-08-08-diegetic-ui/plan-review.md`.
What changed, and why:

- **Blocker — the plan's first action could not run unattended.** `tools/capture.mjs:35`
  sets `SOFTWARE = 'software' in args` and `:231` passes `headless: SOFTWARE`, so
  with no flag every capture launches **headed** Chromium against the real GPU
  adapter and needs a live, unlocked Windows desktop session. All seven of the
  plan's capture invocations defaulted to that, and Task 1 Step 0 — the "before"
  baseline — was a hard gate on it, so an overnight run against a locked session
  would have stalled the slice before a line of code moved, or worse shuttered
  black frames that pass the timeout and fail `mustContain`. Step 0 is now split:
  **Step 0a is a one-scenario renderer canary** that runs `01-title`, inspects the
  manifest and the PNG, retries once with `--software` on any failure, and fixes
  `CAPFLAG` for the entire run (aborting only if both branches fail, and saying
  plainly that the pure-Node gates would still run but a visual slice must not
  ship unphotographed). Every capture command in the plan now carries `$CAPFLAG`.
  A new Global Constraint states the trap the fallback creates: **before and after
  must be captured under the same renderer or the shotdiff table is void** —
  SwiftShader and d3d11 differ in AA and gradient banding across the whole frame,
  so a mixed pair measures the renderer, not the treatment. If the canary falls
  back after the "before" was taken headed, the "before" is re-captured or the
  table is not published.
- **Major — one "replace this range" step pointed at the wrong lines.** Task 4
  Step 2 cited `hud.css:1300-1310` for `.title-rule`; the live rule is
  **1294-1301**, and the cited range mostly covered `.title-seed`. It was also the
  only CSS-replacement step in the plan without a "read the live rule first"
  hedge, which is exactly the combination that overwrites the wrong block. The
  citation is corrected and the step now names the four declarations the doomed
  rule must contain (`height: 3px`, the `linear-gradient` through `--t-lunar`, the
  `clip-path`, the `skewX`) so the implementer can confirm the target before
  deleting it, with a search fallback if it does not match.
- **Minor — nine citation drifts, all corrected in place:** `.hpbar` 719-728 ->
  720-728; `.xpbar` 830-843 -> 826-843; the `refs` object 1080-1112 -> 1051-1113
  with the corruption entries' real location (1060-1063) named; the title-rule
  markup `Menus.js:181` -> 180; `.sel-plate` 216 -> 213 and `.chip` 229/232 ->
  227/230 (the old numbers were closing tags, not opening ones); the six
  `book-head` sites shifted down one (647, 671, 690, 723, 748, 775); `statCell`
  848 -> 847-848; `EDICT_STYLE` 1664-1849 -> 1664-1844, where the template literal
  actually closes.
- **Minor — the panel-head prose undercounted and omitted a screen.** It claimed
  six screens and listed select, difficulty, artifacts, edict, logbook, co-op and
  settings, silently dropping **pause**. The real count is eight: seven in
  `Menus.js` plus one in `Logbook.js`. Corrected, and the step now instructs the
  implementer to work from `grep -n panel-head src/ui/Menus.js` rather than from
  the list, so a head added after this plan was written still gets its rule.
- **A Global Constraint added on citations generally**, since the slice edits the
  files it cites and every line number in it moves under its own work: the
  citations are signposts, every step that names a range also names what to search
  for, and where the two disagree the live file wins.

Not changed, deliberately: the reviewer confirmed the corruption-gauge wrapper is
structurally safe (refs use bare `querySelector`, no direct-child CSS combinators,
no harness assertion touches the gauge markup), that no cross-task name mismatches
exist, and that this slice shares zero files and zero capture ports with the
concurrent readability-juice plan. Nothing there needed a plan edit.
