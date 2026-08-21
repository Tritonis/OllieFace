// Pure gamepad reader. Everything decidable without a DOM lives here —
// deadzone, response curve, edge detection, which-device-spoke-last — so it is
// testable headless and so the pad *source* stays injectable: the browser path
// hands in navigator.getGamepads, and the future Steam Input slice hands in a
// provider backed by steamworks.js instead (STEAM.md: getGamepads is unreliable
// under Steam Input, electron#45732). This seam is the whole design.

export const DEADZONE = 0.15;

export const PAD_BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11 };

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
    // Prefer a standard-mapping device. A wheel, a flight stick or an arcade
    // pad enumerated at a lower index than the real controller reports
    // `mapping: ''`, and its button indices bear no relation to the layout
    // PAD_BUTTON describes — a paddle would read as fire. Fall back to the
    // first connected device only when nothing standard is plugged in, so a
    // pad the browser fails to recognise is still better than no pad.
    let gp = null;
    let fallback = null;
    for (const p of this._getPads()) {
      if (!p?.connected) continue;
      if (p.mapping === 'standard') { gp = p; break; }
      if (!fallback) fallback = p;
    }
    if (!gp) gp = fallback;

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
