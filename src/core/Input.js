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
  [PAD_BUTTON.Y, 'KeyF'],        // equipment (Items.js EQUIP_KEY)
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
    for (const [, code] of PAD_KEYS) this.pressed.delete(code);
  }

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
