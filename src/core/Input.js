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
    // physical code -> the virtual code its still-held press was translated to.
    this._pressedVirtual = new Map();

    // The live map by default; injectable so tests (and any future per-profile
    // input) can hand in their own without touching module state.
    this.bindings = opts.bindings || liveBindings;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._padState.deviceUsed('kb');
      const code = this._virtual(e.code);
      if (!code) return;
      // Remember the translation this press was given. A rebind between the
      // press and the release would otherwise resolve keyup against the NEW
      // map, leaving the pressed state — a held key, or worse a held fire flag
      // — with nothing that will ever undo it (review Critical).
      this._pressedVirtual.set(e.code, code);
      if (isMouseCode(code)) { this._setKbMouse(code, true); return; }
      this.keys.add(code);
      this.pressed.add(code);
    });
    addEventListener('keyup', (e) => {
      // The release undoes what the press did, not what the current map says
      // that key would do now.
      const code = this._pressedVirtual.get(e.code) ?? this._virtual(e.code);
      this._pressedVirtual.delete(e.code);
      if (!code) return;
      if (isMouseCode(code)) { this._setKbMouse(code, false); return; }
      this.keys.delete(code);
    });
    addEventListener('blur', () => {
      this.keys.clear();
      this._pressedVirtual.clear();
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
      if (code) this._pressedVirtual.set(physical, code);
      if (code === MOUSE_LEFT) { this._domLeft = true; this.mouse.left = true; this.mouse.leftEdge = true; }
      else if (code === MOUSE_RIGHT) { this._domRight = true; this.mouse.right = true; this.mouse.rightEdge = true; }
      else if (code) { this.keys.add(code); this.pressed.add(code); }
    });
    addEventListener('mouseup', (e) => {
      // Same rule as keyup: the release follows the press's own translation.
      const physical = `Mouse${e.button}`;
      const code = this._pressedVirtual.get(physical) ?? this.bindings.virtualForKey(physical);
      this._pressedVirtual.delete(physical);
      if (code === MOUSE_LEFT) { this._domLeft = false; this.mouse.left = this._padRT || this._kbLeft; }
      else if (code === MOUSE_RIGHT) { this._domRight = false; this.mouse.right = this._padLT || this._kbRight; }
      else if (code) this.keys.delete(code);
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
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
  }
}
