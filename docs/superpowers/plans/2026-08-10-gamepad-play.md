# Gamepad Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TELLURIC VOID becomes fully playable on a gamepad — left stick moves, right stick looks, triggers fire, face buttons jump/sprint/interact, Start pauses — with the pad state flowing through the exact input surface every consumer already polls, so `Player`, `NetClient`, and `Interactables` change by zero lines.

**Origin:** `docs/STEAM.md` §6 flags "Steam Input + D-pad UI navigation" as the single highest-risk pre-launch row (4–7 days, High, "the single most likely item to blow its estimate"). The menu half already shipped in the diegetic-ui slice (`src/ui/Menus.js:1695-1788` — D-pad/stick navigation, A confirm, B back, console repeat curve, `.is-focus` ring). This slice ships the gameplay half, which is Steam-independent: `navigator.getGamepads()` is the browser/web-build path, and STEAM.md documents that it is unreliable under Steam Input (electron#45732) — which is exactly why the pad-reading logic lands in a pure module with an **injectable pad source**, so the later steamworks.js Steam Input slice replaces one provider function instead of rewriting input.

**Current state (verified against source, 2026-08-10):**
- `src/core/Input.js` (59 lines) — keyboard Set + edge Set, mouse buttons/deltas under pointer lock. **No gamepad code anywhere in `src/` gameplay paths.**
- `src/entities/Player.js:379-414` `_sampleCommand` — polls `input.moveAxis()`, `input.down('Space'/'ShiftLeft'/'KeyQ'/'KeyR'/'KeyE')`, `input.mouse.left/right`, packs `BTN` bits (`src/net/Protocol.js:107-115`). Same path serves host and net client (`NetClient` calls `moveAxis` too).
- `src/core/CameraRig.js:124-140` `lateUpdate` — consumes `input.mouse.dx/dy` **gated on `input.locked`** (pointer lock). Gamepad look must bypass that gate.
- `src/core/Engine.js:217-270` `_frame` — fixedUpdate phase (gated on `!ctx.paused`) runs **before** the update phase; `main.js:94-99` clears input edges in the last lateUpdate hook. Therefore pad polling must happen at the top of `_frame`, or pad edges polled in the update phase die in `endFrame` before `Player.fixedUpdate` ever sees them.
- `src/ui/Menus.js:1695-1788` — menu pad navigation already works and polls its own pad state (`readPad`); this slice does not touch that code path except to add Start-opens-pause.
- `src/ui/HUD.js:1186-1188` — interaction prompt has a literal `<b class="prompt-key">E</b>` badge.
- `src/ui/Menus.js:51-82` — settings `DEFAULTS` + `SLIDERS` (persisted to `telluric.settings`), the home for the new pad look-sensitivity dial.

**Architecture:** One new pure module, `src/core/PadState.js`, owns everything decidable without a DOM: deadzone, response curve, button mapping, edge detection, device-activity tracking. It is constructed with an injectable `getPads` provider and is fully headless-testable. `src/core/Input.js` composes it: a new `pollPad(dt)` (called once per frame from the top of `Engine._frame`) maps the pad snapshot onto the existing surface — synthetic key codes into a pad-owned Set consulted by `down()`/`hit()`, stick movement folded into `moveAxis()`, triggers folded into `mouse.left/right`. Pad look deltas do **not** masquerade as mouse pixels: `CameraRig` consumes `input.pad.lookX/lookY` directly as a rad/s rate scaled by its own `dt` and the new `padSensitivity` setting, keeping units honest. `input.padActive` tracks which device spoke last and drives the HUD prompt glyph and the CameraRig look gate.

**Button map (standard-layout indices, Xbox naming):**

| Pad | Index | Maps to | Consumer sees |
|---|---|---|---|
| Left stick | axes 0/1 | movement | `moveAxis()` |
| Right stick | axes 2/3 | look | `input.pad.lookX/lookY` (CameraRig) |
| A | 0 | jump | `down('Space')` |
| B | 1 | sprint | `down('ShiftLeft')` |
| X | 2 | interact | `down('KeyE')` |
| LB | 4 | utility | `down('KeyQ')` |
| RB | 5 | special | `down('KeyR')` |
| LT | 6 | secondary | `input.mouse.right` |
| RT | 7 | fire | `input.mouse.left` |
| Start | 9 | pause | `hit('Escape')`-equivalent via Menus |

(B doubles as menu-back and gameplay-sprint; the contexts are disjoint — `Menus.navigate` only runs with a screen open, gameplay sampling only matters with none.)

**Tech Stack:** No new dependencies. Playwright (existing devDep) for the probe, headed d3d11 per the capture-works-unattended memory; probe fakes the pad by patching `navigator.getGamepads` in an init script.

## Global Constraints

- **Keyboard/mouse behaviour must not change.** With no pad connected (`getGamepads()` returns empties/nulls — the browser default), every new code path is inert. Gates: `node tests/run.mjs` green; `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` zero fields moved; one capture regression (`node tools/capture.mjs $CAPFLAG --out shots-regress --only 01-title` → `subjectsOk: true`, then delete the directory); `node tools/menuprobe.mjs` still green.
- **`Player.js`, `NetClient.js`, `Interactables.js`, `Protocol.js` are not modified.** The whole point of the virtual-device design. A reviewer finding a diff hunk in any of them fails the task.
- **No `npx`, ever** (memory: npx-destroys-rolldown-binding). Run binaries via `npm run` scripts or `node_modules/.bin/` paths.
- **Bash tool is ASCII-only**; non-ASCII content goes through Write/Edit. No report prose through heredocs (memory: no-report-prose-through-heredoc).
- **Line citations are signposts** — the live file wins; read before editing.
- **Settings keys are additive.** `padSensitivity` joins `telluric.settings` via `DEFAULTS`; existing saved settings objects lack the key and must fall back to the default through the existing `load()` merge path — verify, don't assume, in Task 3.
- **Deadzone is a constant (0.15 radial), not a setting.** YAGNI; Steam Input will own remapping later.
- **The probe suppresses the GPU notice and pins determinism** with `?seed=1337&quality=2&harness=1` (menuprobe uses seed+quality, `tools/menuprobe.mjs:46`; `harness=1` is the notice suppressor, `src/main.js:113`), and bakes a default port distinct from menuprobe's 5209.

---

### Task 1: `PadState` — the pure pad reader, headless TDD

All decision logic, no DOM. This lands first because Input, CameraRig, and the probe all consume its snapshot shape.

**Files:**
- Create: `src/core/PadState.js`
- Test: `tests/pad-state.test.mjs`

**Interfaces:**
- Consumes: a `getPads: () => (GamepadLike|null)[]` provider (injected; production default is `() => navigator.getGamepads?.() ?? []`). A `GamepadLike` is `{ connected: boolean, axes: number[], buttons: { pressed: boolean }[] }`.
- Produces: `class PadState { constructor(getPads); poll(); get snapshot(); }` where `snapshot` is
  `{ present, active, moveX, moveZ, lookX, lookY, held: Set<number>, edges: Set<number> }` —
  `present`: a connected pad exists; `active`: the pad was the most recent device to produce input (Task 2's Input glue flips it false on keyboard/mouse activity via `padState.deviceUsed('kb')`); `moveX/moveZ`: left stick after radial deadzone, normalized so magnitude ≤ 1; `lookX/lookY`: right stick after per-axis deadzone with a squared response curve, each in [-1, 1]; `held`: standard-layout button indices currently pressed; `edges`: indices newly pressed since the previous `poll()` (cleared and recomputed every poll — the caller reads them between polls).
- Also exports: `DEADZONE = 0.15`, `PAD_BUTTON = { A:0, B:1, X:2, Y:3, LB:4, RB:5, LT:6, RT:7, BACK:8, START:9 }`.

- [ ] **Step 1: Write the failing test.** Create `tests/pad-state.test.mjs` (repo convention: standalone node script, PASS/FAIL lines, non-zero exit — mirror `tests/run.mjs` discovery, see any recent `tests/*.test.mjs`):

```javascript
/**
 * PadState: pure gamepad reader. Radial deadzone on move, curved per-axis
 * deadzone on look, edge detection across polls, device-activity tracking.
 * No DOM, no navigator — the pad source is injected.
 */
import { PadState, DEADZONE, PAD_BUTTON } from '../src/core/PadState.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
  if (!pass) failures++;
};

const pad = (axes = [0, 0, 0, 0], pressed = []) => ({
  connected: true,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

// --- no pad: inert -----------------------------------------------------------
{
  const ps = new PadState(() => [null, null]);
  ps.poll();
  const s = ps.snapshot;
  check('no pad: not present', s.present === false);
  check('no pad: zero axes', s.moveX === 0 && s.moveZ === 0 && s.lookX === 0 && s.lookY === 0);
  check('no pad: no buttons', s.held.size === 0 && s.edges.size === 0);
}

// --- deadzone ----------------------------------------------------------------
{
  let p = pad([0.1, -0.1, 0.1, -0.1]);
  const ps = new PadState(() => [p]);
  ps.poll();
  check('inside deadzone: all zero',
    ps.snapshot.moveX === 0 && ps.snapshot.moveZ === 0
    && ps.snapshot.lookX === 0 && ps.snapshot.lookY === 0);
  check('inside deadzone: not active', ps.snapshot.active === false);

  p = pad([1, 1, 0, 0]);
  ps.poll();
  const m = Math.hypot(ps.snapshot.moveX, ps.snapshot.moveZ);
  check('diagonal move normalized to <= 1', m <= 1 + 1e-9, m);
  // Gamepad y-axis is +down; game forward is +z. Full-up stick (-1) must be forward (+1).
  check('stick up is forward', (() => { const q = new PadState(() => [pad([0, -1])]); q.poll(); return q.snapshot.moveZ; })() === 1);

  // Deadzone is rescaled, not a cliff: just past the zone is near-zero, not 0.18.
  const just = new PadState(() => [pad([DEADZONE + 0.01, 0])]);
  just.poll();
  check('deadzone rescaled: just past zone is small', Math.abs(just.snapshot.moveX) < 0.05, just.snapshot.moveX);
}

// --- look curve --------------------------------------------------------------
{
  const half = new PadState(() => [pad([0, 0, 0.5, 0])]);
  half.poll();
  const full = new PadState(() => [pad([0, 0, 1, 0])]);
  full.poll();
  check('look full deflection is 1', Math.abs(full.snapshot.lookX - 1) < 1e-9, full.snapshot.lookX);
  // Squared curve: half deflection gives well under half rate (precision aiming).
  check('look curve: half stick < 0.35 rate', half.snapshot.lookX > 0 && half.snapshot.lookX < 0.35, half.snapshot.lookX);
  const neg = new PadState(() => [pad([0, 0, -1, 0])]);
  neg.poll();
  check('look curve preserves sign', neg.snapshot.lookX === -1, neg.snapshot.lookX);
}

// --- edges -------------------------------------------------------------------
{
  let pressed = [PAD_BUTTON.RT];
  const ps = new PadState(() => [pad([0, 0, 0, 0], pressed)]);
  ps.poll();
  check('press: held + edge', ps.snapshot.held.has(PAD_BUTTON.RT) && ps.snapshot.edges.has(PAD_BUTTON.RT));
  ps.poll();
  check('hold: held, no edge', ps.snapshot.held.has(PAD_BUTTON.RT) && !ps.snapshot.edges.has(PAD_BUTTON.RT));
  pressed = [];
  ps.poll();
  check('release: neither', !ps.snapshot.held.has(PAD_BUTTON.RT) && !ps.snapshot.edges.has(PAD_BUTTON.RT));
}

// --- device activity ---------------------------------------------------------
{
  let axes = [0, 0, 0, 0];
  let pressed = [];
  const ps = new PadState(() => [pad(axes, pressed)]);
  ps.poll();
  check('idle pad: inactive', ps.snapshot.active === false);
  pressed = [PAD_BUTTON.A];
  ps.poll();
  check('button press activates', ps.snapshot.active === true);
  ps.deviceUsed('kb');
  check('keyboard use deactivates', ps.snapshot.active === false);
  pressed = []; axes = [0.8, 0, 0, 0];
  ps.poll();
  check('stick past deadzone re-activates', ps.snapshot.active === true);
}

// --- disconnect --------------------------------------------------------------
{
  let list = [pad([0, 0, 0, 0], [PAD_BUTTON.A])];
  const ps = new PadState(() => list);
  ps.poll();
  list = [null];
  ps.poll();
  const s = ps.snapshot;
  check('disconnect: everything clears',
    !s.present && !s.active && s.held.size === 0 && s.edges.size === 0
    && s.moveX === 0 && s.moveZ === 0 && s.lookX === 0 && s.lookY === 0);
}

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails.** `node tests/pad-state.test.mjs` — expected: cannot find module `../src/core/PadState.js`.

- [ ] **Step 3: Implement `src/core/PadState.js`.**

```javascript
// Pure gamepad reader. Everything decidable without a DOM lives here —
// deadzone, response curve, edge detection, which-device-spoke-last — so it is
// testable headless and so the pad *source* stays injectable: the browser path
// hands in navigator.getGamepads, and the future Steam Input slice hands in a
// provider backed by steamworks.js instead (STEAM.md: getGamepads is unreliable
// under Steam Input, electron#45732). This seam is the whole design.

export const DEADZONE = 0.15;

export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9 };

/** Radial deadzone, rescaled so travel resumes from zero at the zone's edge
 *  rather than jumping to it. Returns {x, y} with magnitude <= 1. */
function radial(x, y) {
  const m = Math.hypot(x, y);
  if (m <= DEADZONE) return { x: 0, y: 0 };
  const t = Math.min(1, (m - DEADZONE) / (1 - DEADZONE));
  return { x: (x / m) * t, y: (y / m) * t };
}

/** Per-axis deadzone + squared curve for look: fine aim near centre, full
 *  rate at full deflection, sign preserved. */
function curved(v) {
  const a = Math.abs(v);
  if (a <= DEADZONE) return 0;
  const t = Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
  return Math.sign(v) * t * t;
}

export class PadState {
  constructor(getPads = () => (globalThis.navigator?.getGamepads?.() ?? [])) {
    this._getPads = getPads;
    this._held = new Set();
    this._edges = new Set();
    this._active = false;
    this._snap = {
      present: false, active: false,
      moveX: 0, moveZ: 0, lookX: 0, lookY: 0,
      held: this._held, edges: this._edges,
    };
  }

  get snapshot() { return this._snap; }

  /** The other device spoke — the pad stops being the glyph/look authority
   *  until it produces input again. */
  deviceUsed(_which) {
    this._active = false;
    this._snap.active = false;
  }

  poll() {
    const s = this._snap;
    let gp = null;
    for (const p of this._getPads()) if (p?.connected) { gp = p; break; }

    if (!gp) {
      this._held.clear();
      this._edges.clear();
      this._active = false;
      s.present = false; s.active = false;
      s.moveX = 0; s.moveZ = 0; s.lookX = 0; s.lookY = 0;
      return;
    }

    s.present = true;

    const mv = radial(gp.axes[0] || 0, gp.axes[1] || 0);
    s.moveX = mv.x;
    s.moveZ = -mv.y;                    // pad y is +down; game forward is +z
    s.lookX = curved(gp.axes[2] || 0);
    s.lookY = curved(gp.axes[3] || 0);

    this._edges.clear();
    let anyButton = false;
    for (let i = 0; i < gp.buttons.length; i++) {
      const down = !!gp.buttons[i]?.pressed;
      if (down) {
        anyButton = true;
        if (!this._held.has(i)) this._edges.add(i);
        this._held.add(i);
      } else {
        this._held.delete(i);
      }
    }

    if (anyButton || s.moveX !== 0 || s.moveZ !== 0 || s.lookX !== 0 || s.lookY !== 0) {
      this._active = true;
    }
    s.active = this._active;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.** `node tests/pad-state.test.mjs` — expected: all PASS, exit 0. Then the full suite: `node tests/run.mjs` — green.

- [ ] **Step 5: Commit.**

```bash
git add src/core/PadState.js tests/pad-state.test.mjs
git commit -m "The pad gets read: a pure, injectable gamepad reader with deadzone, curve and edges"
```

---

### Task 2: Wire the pad through Input, Engine, CameraRig, and Menus

The glue layer: pad snapshot onto the existing polling surface, look into the camera, Start into pause. After this task the game is playable end-to-end on a pad (unstyled — glyphs and settings are Task 3).

**Files:**
- Modify: `src/core/Input.js` (compose PadState; virtual keys/mouse; `pollPad`; device tracking)
- Modify: `src/core/Engine.js` (one line at the top of `_frame`: poll before the fixed loop)
- Modify: `src/core/CameraRig.js` (pad look consumption + look gate)
- Modify: `src/ui/Menus.js` (Start opens pause; pad-resume must not die on pointer lock)
- Test: `tests/pad-input-glue.test.mjs`

**Interfaces:**
- Consumes: `PadState`, `PAD_BUTTON` from Task 1.
- Produces: `input.pad` — the PadState instance's snapshot (so `input.pad.lookX/lookY/active/present/edges` are readable everywhere `ctx.input` travels); `input.padActive` — convenience getter mirroring `input.pad.active`; `input.pollPad()` — called once per frame by `Engine._frame` before the fixed loop. Task 3 reads `input.padActive` for the glyph; Task 4's probe reads all of it.

- [ ] **Step 1: Write the failing glue test.** `tests/pad-input-glue.test.mjs`. Input's constructor touches DOM (`addEventListener`, canvas listeners), so the test stubs the four globals Input needs rather than importing a DOM. Keep the stubs minimal and delete nothing from them later — they document Input's exact DOM surface:

```javascript
/**
 * Input + PadState glue: pad buttons appear as the same key codes and mouse
 * flags gameplay already polls; stick folds into moveAxis(); keyboard use
 * flips the device flag back; no pad means byte-identical behaviour.
 */
const listeners = {};
globalThis.addEventListener = (t, fn) => { (listeners[t] ??= []).push(fn); };
globalThis.document = {
  addEventListener: (t, fn) => { (listeners[t] ??= []).push(fn); },
  pointerLockElement: null,
};
const canvas = { addEventListener: (t, fn) => { (listeners[`canvas:${t}`] ??= []).push(fn); }, requestPointerLock: () => {} };
const fire = (t, e = {}) => (listeners[t] ?? []).forEach((fn) => fn(e));

const { Input } = await import('../src/core/Input.js');
const { PAD_BUTTON } = await import('../src/core/PadState.js');

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
  if (!pass) failures++;
};

const pad = (axes = [0, 0, 0, 0], pressed = []) => ({
  connected: true,
  axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
});

// Injectable pad list, mutated per scenario.
let padList = [];
const input = new Input(canvas, { getPads: () => padList });

// --- inert without a pad -----------------------------------------------------
input.pollPad();
check('no pad: down() false', !input.down('Space'));
check('no pad: moveAxis zero', input.moveAxis().x === 0 && input.moveAxis().z === 0);
check('no pad: mouse untouched', !input.mouse.left && !input.mouse.right);
check('no pad: padActive false', input.padActive === false);

// --- buttons map to the codes Player polls -----------------------------------
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.A, PAD_BUTTON.B, PAD_BUTTON.X, PAD_BUTTON.LB, PAD_BUTTON.RB])];
input.pollPad();
check('A -> Space held + edge', input.down('Space') && input.hit('Space'));
check('B -> ShiftLeft', input.down('ShiftLeft'));
check('X -> KeyE', input.down('KeyE'));
check('LB -> KeyQ', input.down('KeyQ'));
check('RB -> KeyR', input.down('KeyR'));
input.endFrame();
input.pollPad();
check('held next frame: down yes, hit no', input.down('Space') && !input.hit('Space'));

// --- triggers are the mouse --------------------------------------------------
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.RT, PAD_BUTTON.LT])];
input.pollPad();
check('RT -> mouse.left (+edge)', input.mouse.left && input.mouse.leftEdge);
check('LT -> mouse.right (+edge)', input.mouse.right && input.mouse.rightEdge);
padList = [pad()];
input.endFrame();
input.pollPad();
check('trigger release clears mouse', !input.mouse.left && !input.mouse.right);

// --- external mouse writes survive polling (the Harness idiom) ---------------
// Harness.js:1492 fireBurst sets ctx.input.mouse.left = true ONCE and awaits
// frames. pollPad must never recompute the flag when the pad state hasn't
// transitioned, or every firing capture scenario silently stops firing.
padList = [];
input.pollPad();
input.mouse.left = true;
input.pollPad();
check('external mouse.left write survives pollPad', input.mouse.left === true);
input.mouse.left = false;

// --- pad release does not eat a held real key --------------------------------
padList = [pad([0, 0, 0, 0], [PAD_BUTTON.A])];
input.pollPad();
fire('keydown', { code: 'Space', repeat: false });   // real spacebar also held
padList = [pad()];
input.endFrame();
input.pollPad();
check('pad A release: real Space still down', input.down('Space'));
fire('keyup', { code: 'Space' });
check('real keyup clears it', !input.down('Space'));

// --- stick into moveAxis, kb+stick clamps ------------------------------------
padList = [pad([0, -1, 0, 0])];
input.pollPad();
check('stick forward: moveAxis z=1', input.moveAxis().z === 1, input.moveAxis());
fire('keydown', { code: 'KeyW', repeat: false });
const both = input.moveAxis();
check('kb + stick never exceeds unit', Math.hypot(both.x, both.z) <= 1 + 1e-9, both);
fire('keyup', { code: 'KeyW' });

// --- device flag -------------------------------------------------------------
// The keydown above cleared the flag; padList still holds the deflected stick,
// so one poll re-activates it before we assert. (Without this poll the check
// fails against a CORRECT implementation — pre-flight review B2.)
input.pollPad();
check('pad input set padActive', input.padActive === true);
fire('keydown', { code: 'KeyA', repeat: false });
check('keydown clears padActive', input.padActive === false);
fire('keyup', { code: 'KeyA' });
padList = [pad([0, 0, 0.9, 0])];
input.pollPad();
check('right stick re-activates', input.padActive === true);
check('look exposed on input.pad', input.pad.lookX > 0, input.pad.lookX);

process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails.** `node tests/pad-input-glue.test.mjs` — expected: FAILs (no `pollPad`, no second constructor arg).

- [ ] **Step 3: Implement the Input glue.** Edit `src/core/Input.js`:

```javascript
// Pointer-locked FPS-style input. Exposes a stable per-frame snapshot so
// systems never touch raw DOM events.
//
// A connected gamepad rides the same surface: pollPad() (called by Engine at
// the top of each frame, before the fixed loop samples commands) maps pad
// buttons onto the key codes and mouse flags gameplay already polls, so
// Player/NetClient/Interactables never learn the pad exists. Look is the one
// exception — sticks are a rate, not pixels, so CameraRig reads input.pad
// directly instead of pretending stick deflection is mouse movement.

import { PadState, PAD_BUTTON } from './PadState.js';

// Pad button -> the virtual key code gameplay polls (see Player._sampleCommand).
const PAD_KEYS = [
  [PAD_BUTTON.A, 'Space'],       // jump
  [PAD_BUTTON.B, 'ShiftLeft'],   // sprint
  [PAD_BUTTON.X, 'KeyE'],        // interact
  [PAD_BUTTON.LB, 'KeyQ'],       // utility
  [PAD_BUTTON.RB, 'KeyR'],       // special
];

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false };
    this.locked = false;
    this.enabled = true;

    // Pad-owned state, kept apart from the DOM-owned Sets so a pad release can
    // never eat a really-held key and a keyup can never eat a held pad button.
    // _padRT/_padLT remember the triggers' last held state: mouse flags are
    // written ONLY on a transition, never recomputed per frame — the screenshot
    // harness (Harness.js fireBurst and friends) writes mouse.left directly and
    // relies on it persisting across frames (pre-flight review B1).
    this._padState = new PadState(opts.getPads);
    this.pad = this._padState.snapshot;
    this._padKeys = new Set();
    this._domLeft = false;
    this._domRight = false;
    this._padRT = false;
    this._padLT = false;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      this._padState.deviceUsed('kb');
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this._domLeft = this._domRight = false;
      this.mouse.left = this._padRT;
      this.mouse.right = this._padLT;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) { canvas.requestPointerLock(); return; }
      this._padState.deviceUsed('mouse');
      if (e.button === 0) { this._domLeft = true; this.mouse.left = true; this.mouse.leftEdge = true; }
      if (e.button === 2) { this._domRight = true; this.mouse.right = true; this.mouse.rightEdge = true; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) { this._domLeft = false; this.mouse.left = this._padRT; }
      if (e.button === 2) { this._domRight = false; this.mouse.right = this._padLT; }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
      if (e.movementX || e.movementY) this._padState.deviceUsed('mouse');
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  get padActive() { return this.pad.active; }

  down(code) { return this.keys.has(code) || this._padKeys.has(code); }
  hit(code) { return this.pressed.has(code); }

  // Movement intent in local space: x = strafe, z = forward.
  moveAxis() {
    let x = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0) + this.pad.moveX;
    let z = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0) + this.pad.moveZ;
    const len = Math.hypot(x, z);
    return len > 1 ? { x: x / len, z: z / len } : { x, z };
  }

  /** Once per frame, from the top of Engine._frame — before the fixed loop, so
   *  pad edges live through fixedUpdate and die in endFrame like key edges.
   *  Mouse flags are written only on trigger TRANSITIONS: a poll with no pad
   *  change must not touch them, or it erases the direct writes the screenshot
   *  harness makes (Harness.js fireBurst — pre-flight review B1). */
  pollPad() {
    this._padState.poll();
    const snap = this.pad;

    this._padKeys.clear();
    if (snap.present) {
      for (const [btn, code] of PAD_KEYS) {
        if (snap.held.has(btn)) this._padKeys.add(code);
        if (snap.edges.has(btn)) this.pressed.add(code);
      }
    }

    const rt = snap.present && snap.held.has(PAD_BUTTON.RT);
    if (rt !== this._padRT) {
      this._padRT = rt;
      this.mouse.left = rt || this._domLeft;
      if (rt) this.mouse.leftEdge = true;
    }
    const lt = snap.present && snap.held.has(PAD_BUTTON.LT);
    if (lt !== this._padLT) {
      this._padLT = lt;
      this.mouse.right = lt || this._domRight;
      if (lt) this.mouse.rightEdge = true;
    }
  }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
  }
}
```

Note the deliberate asymmetry: `down()` consults `_padKeys` but `hit()` only consults `pressed` — pad edges are *pushed into* `pressed` during `pollPad`, so `hit()` needs no second set and edge lifetime is identical to a key's.

- [ ] **Step 4: Run the glue test.** `node tests/pad-input-glue.test.mjs` — all PASS. Then `node tests/run.mjs` — green (proves no existing test broke).

- [ ] **Step 5: Engine polls the pad first.** In `src/core/Engine.js` `_frame` (currently ~line 217-270), add one line before the fixed-update accumulator loop (before the `!ctx.paused` gate — the pad must keep polling while paused, or Menus loses Start/B the moment a screen opens):

```javascript
this.ctx.input?.pollPad?.();
```

Read the method first; place the call after dt computation, before any phase dispatch.

- [ ] **Step 6: CameraRig consumes pad look.** In `src/core/CameraRig.js`:

Add with the other constants (after `SENSITIVITY_BASE`, ~line 58):

```javascript
// Full right-stick deflection in rad/s, scaled by the player's pad dial.
// Yaw is faster than pitch on purpose — horizontal traversal is the common
// case; full-rate pitch makes aim floaty.
const PAD_YAW_RATE = 3.4;
const PAD_PITCH_RATE = 2.2;
```

Replace the look block (~lines 134-138):

```javascript
    if (input && input.locked && input.enabled !== false) {
      this.yaw -= input.mouse.dx * this.sensitivity;
      this.pitch -= input.mouse.dy * this.sensitivity;
    }
    const pad = input?.pad;
    if (pad?.active && input.enabled !== false) {
      const padSens = clamp(settings?.padSensitivity ?? 1, 0.05, 8);
      this.yaw -= pad.lookX * PAD_YAW_RATE * padSens * dt;
      this.pitch -= pad.lookY * PAD_PITCH_RATE * padSens * dt;
    }
    this.pitch = clamp(this.pitch, PITCH_MIN, PITCH_MAX);
```

(The pitch clamp moves out of the mouse branch so both paths share it. `settings.padSensitivity` does not exist until Task 3 — the `?? 1` default makes this correct today.)

- [ ] **Step 7: Start opens pause; pad resume survives without pointer lock.** In `src/ui/Menus.js`:

In `update(ctx, dt)` (~line 1790), next to the existing `KeyC` edict binding, add (import `PAD_BUTTON` from `../core/PadState.js` at the top of Menus.js — no hardcoded indices):

```javascript
    // Start on a pad is Escape: opens the pause screen from the world. With a
    // screen open, navigate()'s B-button back already covers it.
    if (!this.screen && ctx.player?.alive !== false
        && ctx.input?.pad?.edges?.has?.(PAD_BUTTON.START)) {
      // readPad's edge memory (this.pad.buttons) goes stale during gameplay.
      // Seed it from the live pad before opening, or a held A/B (jump/sprint)
      // reads as a fresh edge on the first menu frame and instant-closes the
      // pause (pre-flight review I3).
      for (const i of [PAD_BUTTON.A, PAD_BUTTON.B]) {
        if (ctx.input.pad.held.has(i)) this.pad.buttons.add(i);
        else this.pad.buttons.delete(i);
      }
      this.open('pause');
    }
```

In `act('resume')` (~line 1215-1218): `requestPointerLock` from a synthetic (pad-driven) click has no user activation and may reject — and a pad player does not want the lock anyway. Guard it:

```javascript
      case 'resume':
        this.close();
        if (!this.ctx.input?.padActive) {
          try { this.ctx.input?.canvas?.requestPointerLock?.()?.catch?.(() => {}); } catch { /* no lock, no problem */ }
        }
        break;
```

Also verify (read, don't assume) the `pointerlockchange` auto-pause at ~line 166-172: it only fires on lock *transitions*, so pad-only play (never locked) is unaffected — confirm no change needed and say so in the task report.

- [ ] **Step 8: Full gates.** `node tests/run.mjs` green; `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` zero fields moved; `node tools/menuprobe.mjs` green (menus still navigate; resume still works mouse-side).

- [ ] **Step 9: Commit.**

```bash
git add src/core/Input.js src/core/Engine.js src/core/CameraRig.js src/ui/Menus.js tests/pad-input-glue.test.mjs
git commit -m "The pad reaches the game: sticks move and look, triggers fire, Start pauses, and no consumer learned a thing"
```

---

### Task 3: The pad is a first-class citizen — settings dial and prompt glyphs

**Files:**
- Modify: `src/ui/Menus.js` (`DEFAULTS` + `SLIDERS`: `padSensitivity`)
- Modify: `src/ui/HUD.js` (prompt-key badge follows the active device)
- Test: `tests/pad-settings.test.mjs`

**Interfaces:**
- Consumes: `input.padActive` from Task 2; the existing settings `load()`/`save()`/`apply()` path (`src/ui/Menus.js:2084-2143`).
- Produces: `ctx.settings.padSensitivity` (number, default 1.0) — already consumed by Task 2's CameraRig code via `?? 1`.

- [ ] **Step 1: Write the failing settings test.** `tests/pad-settings.test.mjs` — the settings module surface is inside Menus.js which needs a DOM, so test the *data contract* the way the repo tests settings already do (check for an existing settings test first — `ls tests/ | grep -i setting` — and mirror its approach if one exists; otherwise assert on the exported shape indirectly): the minimal honest headless test is that `DEFAULTS`-merged legacy objects gain the key. If `load`/`DEFAULTS` are not exported, export `DEFAULTS` from Menus.js is NOT acceptable (DOM import). Instead put the merge-with-defaults contract where it is testable: this step verifies via Task 4's probe (`ctx.settings.padSensitivity === 1` on a profile saved before this slice) and the headless test is **skipped as impossible** — record that in the task report. Then this task's test file is not created; the checkbox below shifts the burden to the probe.
  - Concretely: confirm by reading `load()` (~line 2084) that it merges `{...DEFAULTS, ...stored}` or equivalent, so an old `telluric.settings` without `padSensitivity` yields `1.0`. If the merge is key-by-key or otherwise would drop the new default, fix `load()` so it cannot.

- [ ] **Step 2: Add the setting.** In `src/ui/Menus.js` `DEFAULTS` (~line 51):

```javascript
  padSensitivity: 1.0,
```

In `SLIDERS` (~line 70), after the `sensitivity` row:

```javascript
  { key: 'padSensitivity', label: 'Gamepad look', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
```

The existing `buildSettings()` renders every `SLIDERS` row and the existing input hook saves it — verify by opening the file, not by faith.

- [ ] **Step 2b: Make sliders pad-adjustable.** Pre-flight review I2: no slider can currently be changed by pad or keyboard — `navConfirm` (Menus.js:1681-1682) skips range inputs with a comment claiming "left/right already adjust it", but the dx path only calls `navMove`. Without this, the slice's own "Gamepad look" dial is unusable by the device it serves. In `navigate()` (~line 1718-1722), before the ring-move line, consume a horizontal step when the focused target is a slider:

```javascript
    const el = this.navTargets()[this.navIndex];
    if (dx && el?.tagName === 'INPUT' && el.type === 'range') {
      // Left/right adjust the focused slider — this is what navConfirm's
      // "left/right already adjust it" comment always promised. stepUp/stepDown
      // honor the input's min/max/step; the synthetic 'input' event runs the
      // buildSettings listener, which applies and saves.
      if (dx > 0) el.stepUp(); else el.stepDown();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (step && !(dy && this.navScroll(dy > 0 ? 1 : -1))) {
      this.navMove(step > 0 ? 1 : -1);
    }
```

(This replaces the existing `if (step && ...) this.navMove(...)` line — vertical movement on a slider row still walks the ring; only horizontal is consumed. Read the live method and integrate; the `step` local already exists.)

- [ ] **Step 3: Glyph swap.** In `src/ui/HUD.js`: the prompt markup (~line 1186-1188) is `<b class="prompt-key">E</b>`. Add a ref in the refs block (~line 1114): `promptKey: q('.prompt-key'),`. Then in the HUD's per-frame update path (find the method the HUD uses for cheap per-frame DOM syncs — the `set(key, value, fn)` memoisation idiom visible at ~line 833 — and follow it):

```javascript
    this.set('padPrompt', !!this.ctx.input?.padActive, (pad) => {
      if (this.refs.promptKey) this.refs.promptKey.textContent = pad ? 'X' : 'E';
    });
```

`X` is the pad interact button (PAD_BUTTON.X → `KeyE`, Task 2's map). Memoised: DOM writes only on device switches.

- [ ] **Step 4: Run gates.** `node tests/run.mjs` green. Load the game in a browser is not available to the executor — the probe in Task 4 is the visual verification; state that dependency in the report rather than claiming visual confirmation.

- [ ] **Step 5: Commit.**

```bash
git add src/ui/Menus.js src/ui/HUD.js
git commit -m "The pad gets its dial and its letter: look sensitivity in settings, the prompt badge follows the device"
```

---

### Task 4: `tools/padprobe.mjs` — the whole claim, proven in a real renderer

Every behaviour this slice claims, exercised in one Playwright run with a fake pad injected under the real game. Model on `tools/menuprobe.mjs` (headed d3d11, offscreen window position, `waitForFunction` on `__GAME__.ctx`, `ok(cond, msg)` assertions, screenshots) — read it end to end first and reuse its launch/wait idioms exactly.

**Files:**
- Create: `tools/padprobe.mjs`
- Create: committed record `reviews/round9/padprobe-record.json` — use the NEWEST existing `reviews/round*/` directory (round9 exists as of plan time; verify with `ls reviews/` and do not create a new round). The record is the on-disk baseline the memory name-the-baseline-capture requires.

**Interfaces:**
- Consumes: everything Tasks 1-3 shipped, via the page's `window.__GAME__.ctx`.
- Produces: a committed probe record `{ when, checks: [{name, pass, detail}], allPass }`; a `package.json` script `"padprobe": "node tools/padprobe.mjs"`.

- [ ] **Step 1: Write the probe.** `tools/padprobe.mjs`. The fake pad: an `addInitScript` that replaces `navigator.getGamepads` with a function returning `[window.__PAD__]`, where `__PAD__` starts `null`; the test drives it with `page.evaluate` setting `window.__PAD__ = { connected: true, axes: [...], buttons: [...] }`. Structure:

```javascript
// Drives the game with a synthetic gamepad under the real renderer and gates
// every claim the gamepad-play slice makes. Fake pad, real everything else:
// navigator.getGamepads is patched before the game boots, then each scenario
// mutates window.__PAD__ and asserts on __GAME__.ctx state.
import { chromium } from 'playwright';
// ...same launch flags / offscreen position / d3d11 args as tools/menuprobe.mjs

const PAD_IDLE = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
const press = (i) => ({ ...PAD_IDLE, buttons: PAD_IDLE.buttons.map((b, j) => (j === i ? { pressed: true } : b)) });

// checks to implement, in order (each an ok(...) with a record entry):
// 1. boot with ?seed=1337&quality=2&harness=1 (menuprobe parity is seed+quality,
//    menuprobe.mjs:46; harness=1 is what suppresses the GPU notice, main.js:113);
//    default PORT distinct from menuprobe's 5209 — bake 5210 in; wait for title
//    screen (menuprobe idiom)
// 2. MENU NAV REGRESSION (title's [data-nav] order is Play, Logbook, Co-op,
//    Settings, Quit — Menus.js:196; open() resets navIndex to 0):
//    stick down (axes[1]=1) -> navIndex === 1; return stick to idle so
//    readPad's repeat gate re-arms (needs axis < 0.55, Menus.js:1766-1776);
//    stick up -> navIndex === 0; press(0) (A on Play) ->
//    menus.screen === 'select'  [the shipped menu path works under the patch]
// 3. navigate to a run the way menuprobe does (clicks are fine for the parts
//    menu-nav already covered), wait for ctx.player
// 4. MOVE: record player.position; __PAD__ = axes [0,-1,0,0] for ~40 frames
//    (page.waitForTimeout in small steps, re-setting __PAD__ each step is not
//    needed - the poll reads the same object; just hold and wait) -> position
//    moved > 1m; then idle pad -> velocity decays
// 5. LOOK: record cameraRig.yaw; __PAD__ = axes [0,0,1,0] for ~30 frames ->
//    yaw changed by > 0.3 rad in the negative direction; assert pitch clamp
//    holds under held full-down stick (axes [0,0,0,1] for 120 frames ->
//    pitch >= -1.15 && Number.isFinite(pitch); PITCH_MIN is not exported,
//    CameraRig.js:34 — assert the number)
// 6. FIRE: press(7) (RT) held ~20 frames -> some projectile/attack evidence:
//    assert via ctx state the same way existing tests detect firing (check
//    tests/ for the idiom; player.lastCommand.buttons & 4 (BTN.FIRE) is the
//    minimum honest assertion)
// 7. JUMP: press(0) -> lastCommand.buttons & 1 within a few frames
// 8. START: press(9) -> menus.screen === 'pause' && ctx.paused; then press(0)
//    (A confirms Resume - it is the focused default) or press(1) (B backs out)
//    -> screen null, ctx.paused false  [proves pad polling continues while paused]
// 8b. START-WHILE-HELD: hold B (sprint) AND press Start in the same __PAD__
//    state -> pause opens and STAYS open for >= 10 frames (regression for
//    pre-flight review I3's instant-close)
// 9. GLYPH: with pad active -> document.querySelector('.prompt-key').textContent === 'X';
//    page.keyboard.press('KeyW') -> flips back to 'E'  [device switch]
// 10. SETTINGS: ctx.settings.padSensitivity === 1 (default merged into a
//    pre-slice settings object: the probe seeds localStorage with a legacy
//    telluric.settings JSON lacking the key via addInitScript BEFORE boot)
// 10b. SLIDER: open pause -> Settings with the pad; ring onto the
//    'Gamepad look' row; dx right (axes[0]=1 one repeat) ->
//    ctx.settings.padSensitivity increased (pre-flight review I2's fix proven)
// 11. screenshot the pause screen with pad focus ring visible -> scratch dir
// write the record into the NEWEST existing reviews/round*/ directory
// (round9 exists already — check ls reviews/, do not invent round10);
// exit 1 unless allPass
```

The comment block above is the specification; the executor writes the real code under it. Two hard requirements: **every check lands in the record file with a pass flag and a measured detail** (yaw delta, metres moved — numbers, not booleans, per name-the-baseline-capture), and **the probe exits non-zero on any failure** so it can gate.

- [ ] **Step 2: Run it, iterate until green.** `node tools/padprobe.mjs`. Expect real findings here (frame-timing margins, focus-index assumptions); fix forward in the earlier tasks' files as needed — that is this task's purpose. Playwright launch idioms (ports, renderer) must match menuprobe's exactly; if two probes ever run concurrently they need the port-stagger noted in memory capture-works-unattended-d3d11.

- [ ] **Step 3: Add the script + record.** `"padprobe": "node tools/padprobe.mjs"` in `package.json` scripts; commit the green record JSON.

- [ ] **Step 4: Full slice gates, all of them.** `node tests/run.mjs`; `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` (zero fields moved); `node tools/menuprobe.mjs`; capture regression `node tools/capture.mjs $CAPFLAG --out shots-regress --only 01-title` → `subjectsOk: true`, then delete `shots-regress/`; `node tools/padprobe.mjs`. Paste each command's tail into the task report.

- [ ] **Step 5: Commit.**

```bash
git add tools/padprobe.mjs package.json reviews/
git commit -m "The pad is proven under glass: one probe walks menus, moves, looks, fires, pauses and reads its own letter"
```

---

## Deliberately out of scope

- **Steam Input / steamworks.js** — needs the Steam app id; this slice builds the injectable-provider seam it will use.
- **Button remapping UI, vibration, multiple simultaneous pads** — YAGNI until a player asks; PadState reads the first connected pad, same rule the menus already use.
- **Aim assist** — a design question for a playtest, not an input-layer default.
- **Deck/Proton glyph sets (B-confirm regions, Nintendo layouts)** — the glyph is one `<b>` element; localising it is trivial later and worthless now.

## Pre-flight review

Reviewed 2026-08-10: `.superpowers/sdd/2026-08-10-gamepad-play/plan-review.md` — EXECUTE WITH AMENDMENTS (2 blockers / 3 important / 5 minor), all amendments applied to this document: B1 transition-driven trigger→mouse writes + harness-write regression test; B2 device-flag test poll; I1 probe check 2 rewritten against the real title nav order; I2 pad-adjustable sliders (Task 3 Step 2b + probe check 10b); I3 Start-branch edge-memory seeding + probe check 8b; m1 probe URL params; m2 distinct port; m3 numeric pitch assertion; m4 newest review round; m5 PAD_BUTTON.START import.

## Self-review notes

- Spec coverage: STEAM.md's "Steam Input + D-pad UI navigation" row = menu nav (shipped, regression-gated by probe check 2) + gameplay pad support (Tasks 1-2) + the UI affordances a pad player needs (Task 3) + proof (Task 4). The Steam-side half is explicitly deferred to the app-id slice with its seam prepared.
- Type consistency: `PadState.snapshot` shape is identical in Task 1's implementation, Task 2's glue test, and Task 4's probe usage. `PAD_BUTTON.X → 'KeyE' → prompt glyph 'X'` is consistent across Tasks 2 and 3.
- The one intentional near-placeholder: Task 4's probe body is specified as a check-list comment rather than full code — the launch idioms must be copied from the live `tools/menuprobe.mjs` at execution time, and duplicating that file into this plan would drift. The eleven checks and their pass criteria are exact.
