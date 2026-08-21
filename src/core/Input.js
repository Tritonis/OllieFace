// Pointer-locked FPS-style input. Exposes a stable per-frame snapshot so
// systems never touch raw DOM events.
//
// A connected gamepad rides the same surface: pollPad() (called by Engine at
// the top of each frame, before the fixed loop samples commands) maps pad
// buttons onto the key codes and mouse flags gameplay already polls, so
// Player/NetClient/Interactables never learn the pad exists. Look is the one
// exception — sticks are a rate, not pixels, so CameraRig reads input.pad
// directly instead of pretending stick deflection is mouse movement.

import { PadState } from './PadState.js';
import {
  bindings as liveBindings, isMouseCode, MOUSE_LEFT, MOUSE_RIGHT,
} from './Bindings.js';

// Pad button -> virtual key code is no longer a constant here: it is one column
// of the binding map (Bindings.js), which also owns the keyboard column. What
// gameplay polls is unchanged — the map translates a physical press into the
// virtual code `Player._sampleCommand` and friends have always asked for.

export class Input {
  // Not a registered system, but `pollPad` runs through the Engine's `_call`
  // and so needs the same declaration. Only the pad poll goes through there:
  // keyboard and mouse arrive on their own listeners, and a failed poll starves
  // input rather than corrupting anything.
  static critical = false;

  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false };
    this.locked = false;
    this.enabled = true;
    // Wheel notches accumulated this frame, positive = away from the player
    // (zoom out). Kept off `mouse` on purpose: `mouse.dx/dy` are pixels the
    // look path integrates, and the harness writes that object directly.
    // Cleared in endFrame beside the other per-frame deltas.
    this.wheel = 0;

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
    // A *keyboard* key can be bound to primary/secondary fire. Held apart from
    // the mouse's own flags for the same reason the pad's are: a keyup must
    // never eat a really-held mouse button.
    this._kbLeft = false;
    this._kbRight = false;
    // virtual code -> the set of physical codes whose still-held presses were
    // translated to it. Two facts in one structure: what a given press applied
    // (so its release undoes THAT, never what the current map would say), and
    // how many sources are holding a virtual code (so it clears only when the
    // last one lets go). Both mattered: a mid-hold rebind used to strand a
    // flag, and then to drop one a second physical key was still holding.
    this._holders = new Map();

    // The live map by default; injectable so tests (and any future per-profile
    // input) can hand in their own without touching module state.
    this.bindings = opts.bindings || liveBindings;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._padState.deviceUsed('kb');
      const code = this._virtual(e.code);
      if (!code) return;
      this._applyPress(e.code, code);
    });
    addEventListener('keyup', (e) => this._applyRelease(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this._holders.clear();
      this._domLeft = this._domRight = false;
      this._kbLeft = this._kbRight = false;
      this.mouse.left = this._padRT;
      this.mouse.right = this._padLT;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) { canvas.requestPointerLock(); return; }
      this._padState.deviceUsed('mouse');
      // A mouse button is a bindable physical code too, so it goes through the
      // same lookup: unbound (or bound to a gameplay key) it stops driving fire.
      const physical = `Mouse${e.button}`;
      const code = this.bindings.virtualForKey(physical);
      if (!code) return;
      // The physical mouse buttons keep their own held flags (`_domLeft`/
      // `_domRight`), which the screenshot harness and the pad path both read,
      // so fire stays on those rather than going through `_holders`.
      if (code === MOUSE_LEFT) { this._domLeft = true; this.mouse.left = true; this.mouse.leftEdge = true; }
      else if (code === MOUSE_RIGHT) { this._domRight = true; this.mouse.right = true; this.mouse.rightEdge = true; }
      else this._applyPress(physical, code);
    });
    addEventListener('mouseup', (e) => {
      // Same rule as keyup: the release follows the press's own translation,
      // and a mouse button that was driving fire is released as fire.
      const physical = `Mouse${e.button}`;
      if (this._holders.size && this._releaseHeld(physical)) return;
      const code = this.bindings.virtualForKey(physical);
      if (code === MOUSE_LEFT) { this._domLeft = false; this.mouse.left = this._padRT || this._kbLeft; }
      else if (code === MOUSE_RIGHT) { this._domRight = false; this.mouse.right = this._padLT || this._kbRight; }
      else if (this._domLeft && physical === 'Mouse0') { this._domLeft = false; this.mouse.left = this._padRT || this._kbLeft; }
      else if (this._domRight && physical === 'Mouse2') { this._domRight = false; this.mouse.right = this._padLT || this._kbRight; }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
      if (e.movementX || e.movementY) this._padState.deviceUsed('mouse');
    });
    // Only while locked: an unlocked wheel is the player scrolling a menu, and
    // a settings screen that dollied the camera behind itself would be absurd.
    canvas.addEventListener('wheel', (e) => {
      if (!this.locked || this.enabled === false) return;
      e.preventDefault();
      // deltaMode 1 is lines, 2 is pages; normalise everything to notches so a
      // trackpad's pixel stream and a wheel's 100-per-detent both behave.
      const scale = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 1 : 1 / 100;
      this.wheel += e.deltaY * scale;
      this._padState.deviceUsed('mouse');
    }, { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  get padActive() { return this.pad.active; }

  /** Another device spoke somewhere these listeners cannot see — a click on the
   *  menu overlay, which is neither the canvas nor a pointer-locked move. Same
   *  effect as a canvas mousedown: the pad stops being the glyph/look authority,
   *  so a mouse-clicked Resume re-locks the pointer. */
  deviceUsed(which) { this._padState.deviceUsed(which); }

  /** Drop this frame's pad-mapped edges. For the one caller that consumes a pad
   *  press by opening a screen (Menus' Start branch): the synthetic codes are
   *  already in `pressed`, and the menu's own confirm reads `hit('Space')`, so a
   *  same-frame A+Start would open the pause and instantly click Resume. */
  clearPadEdges() {
    for (const code of this.bindings.padVirtuals()) this.pressed.delete(code);
  }

  /**
   * Spend ONE pad button's edge — the narrow counterpart to `clearPadEdges`,
   * for a consumer that answers a single press and must leave the rest of the
   * frame's pad input alone (Menus' mutation window, #98). The blanket clear
   * is wrong there: it drops every pad-bound action's edge, which is harmless
   * only for as long as nothing polls a pad action through `hit`/`actionHit`,
   * and is a trap for the first thing that does.
   *
   * Both halves matter: the raw index leaves `pad.edges` so another raw reader
   * (the Start-opens-pause branch) cannot see it again, and the virtual code
   * leaves `pressed` so an action bound to that same button cannot fire twice.
   */
  consumePadEdge(btn) {
    this.pad.edges.delete(btn);
    const code = this.bindings.virtualForPad(btn);
    if (code) this.pressed.delete(code);
  }

  /**
   * Physical key code -> the code to record, or null to drop it.
   *
   * An unbound key passes through under its own name so Escape, Enter and the
   * menu arrows keep working without being in the binding table — EXCEPT where
   * its name is some action's virtual code. Rebinding "move forward" to I
   * leaves W unbound, and letting W through as 'KeyW' would leave the old key
   * silently still moving the player.
   */
  _virtual(physical) {
    const mapped = this.bindings.virtualForKey(physical);
    if (mapped) return mapped;
    return this.bindings.isVirtual(physical) ? null : physical;
  }

  /** Record a press and, if it is the first source, apply its virtual state. */
  _applyPress(physical, virtual) {
    let set = this._holders.get(virtual);
    if (!set) { set = new Set(); this._holders.set(virtual, set); }
    const first = set.size === 0;
    set.add(physical);
    if (isMouseCode(virtual)) { if (first) this._setKbMouse(virtual, true); return; }
    this.keys.add(virtual);
    // The edge fires per press even when a second source already holds the
    // code: an edge is "somebody pressed", not "the state changed".
    this.pressed.add(virtual);
  }

  /** Release whatever this physical code applied. */
  _applyRelease(physical) { this._releaseHeld(physical); }

  /** @returns true if this physical code was holding something. */
  _releaseHeld(physical) {
    for (const [virtual, set] of this._holders) {
      if (!set.delete(physical)) continue;
      if (set.size === 0) {
        this._holders.delete(virtual);
        if (isMouseCode(virtual)) this._setKbMouse(virtual, false);
        else this.keys.delete(virtual);
      }
      return true;
    }
    return false;
  }

  /** Transition-only write, matching the pad triggers above. */
  _setKbMouse(code, on) {
    if (code === MOUSE_LEFT) {
      if (on === this._kbLeft) return;
      this._kbLeft = on;
      this.mouse.left = on || this._domLeft || this._padRT;
      if (on) this.mouse.leftEdge = true;
    } else {
      if (on === this._kbRight) return;
      this._kbRight = on;
      this.mouse.right = on || this._domRight || this._padLT;
      if (on) this.mouse.rightEdge = true;
    }
  }

  down(code) { return this.keys.has(code) || this._padKeys.has(code); }
  hit(code) { return this.pressed.has(code); }

  /** The same two questions asked by action rather than by virtual code. */
  actionDown(id) { return this.down(this.bindings.code(id)); }
  actionHit(id) { return this.hit(this.bindings.code(id)); }

  // Movement intent in local space: x = strafe, z = forward.
  moveAxis() {
    const b = this.bindings;
    let x = (this.down(b.code('moveRight')) ? 1 : 0) - (this.down(b.code('moveLeft')) ? 1 : 0) + this.pad.moveX;
    let z = (this.down(b.code('moveForward')) ? 1 : 0) - (this.down(b.code('moveBack')) ? 1 : 0) + this.pad.moveZ;
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

    const b = this.bindings;
    this._padKeys.clear();
    let rt = false;
    let lt = false;
    if (snap.present) {
      for (const btn of snap.held) {
        const code = b.virtualForPad(btn);
        if (!code) continue;
        if (code === MOUSE_LEFT) rt = true;
        else if (code === MOUSE_RIGHT) lt = true;
        else this._padKeys.add(code);
      }
      for (const btn of snap.edges) {
        const code = b.virtualForPad(btn);
        if (code && !isMouseCode(code)) this.pressed.add(code);
      }
    }

    if (rt !== this._padRT) {
      this._padRT = rt;
      this.mouse.left = rt || this._domLeft || this._kbLeft;
      if (rt) this.mouse.leftEdge = true;
    }
    if (lt !== this._padLT) {
      this._padLT = lt;
      this.mouse.right = lt || this._domRight || this._kbRight;
      if (lt) this.mouse.rightEdge = true;
    }
  }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.wheel = 0;
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
  }
}
