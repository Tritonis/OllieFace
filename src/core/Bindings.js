// The binding map: which physical key, mouse button or pad button produces
// which game action.
//
// The design that makes this cheap is that every action keeps the *virtual*
// code gameplay has always polled. `Player._sampleCommand` still asks
// `input.down('Space')` for jump and `Items` still asks `input.hit('KeyF')`
// for the equipment; what changed is that `Input` no longer feeds the physical
// `e.code` straight into its key set. It looks the physical code up here, and
// inserts the ACTION's virtual code instead. Rebinding jump to J therefore
// makes a physical KeyJ press arrive as 'Space', and every consumer of the
// command stream is correct without knowing bindings exist.
//
// The two shooting actions carry virtual codes of 'Mouse0'/'Mouse2', which
// `Input` routes onto the mouse flags rather than the key set — so a pad
// trigger, a mouse button and a rebound keyboard key all reach `mouse.left`
// through one path.

import { PAD_BUTTON } from './PadState.js';

export const MOUSE_LEFT = 'Mouse0';
export const MOUSE_RIGHT = 'Mouse2';

/**
 * Every rebindable action, in the order the settings screen lists them.
 *
 * `key` and `pad` are the shipped defaults AND — for `key` — the virtual code
 * the action is known by forever after. A default of `null` for `pad` means the
 * action has no pad button by default (movement rides the left stick).
 */
export const ACTIONS = [
  { id: 'moveForward', label: 'Move forward', key: 'KeyW', pad: null },
  { id: 'moveBack', label: 'Move back', key: 'KeyS', pad: null },
  { id: 'moveLeft', label: 'Strafe left', key: 'KeyA', pad: null },
  { id: 'moveRight', label: 'Strafe right', key: 'KeyD', pad: null },
  { id: 'jump', label: 'Jump', key: 'Space', pad: PAD_BUTTON.A },
  { id: 'sprint', label: 'Sprint', key: 'ShiftLeft', pad: PAD_BUTTON.B },
  { id: 'interact', label: 'Interact', key: 'KeyE', pad: PAD_BUTTON.X },
  { id: 'equipment', label: 'Equipment', key: 'KeyF', pad: PAD_BUTTON.Y },
  { id: 'utility', label: 'Utility skill', key: 'KeyQ', pad: PAD_BUTTON.LB },
  { id: 'special', label: 'Special skill', key: 'KeyR', pad: PAD_BUTTON.RB },
  { id: 'primary', label: 'Primary fire', key: MOUSE_LEFT, pad: PAD_BUTTON.RT },
  { id: 'secondary', label: 'Secondary fire', key: MOUSE_RIGHT, pad: PAD_BUTTON.LT },
  // Camera zoom (#133). The mouse wheel is the primary path and needs no
  // binding -- it is not a key -- so these two exist for the keyboard and,
  // mainly, for the pad, which has no wheel and would otherwise be stuck at
  // whatever distance the last mouse user chose.
  //
  // The stick clicks, not the D-pad, and not by preference: the D-pad is read
  // RAW in two places that are live while the world is (Menus' MUTATE_PAD
  // answers the mutation window on 14/12/15, and menu navigation reads 12-15
  // off the gamepad directly), so binding zoom there would dolly the camera
  // every time a player picked the second mutation offer. L3/R3 are claimed by
  // nothing in this build.
  { id: 'zoomIn', label: 'Camera zoom in', key: 'Equal', pad: PAD_BUTTON.L3 },
  { id: 'zoomOut', label: 'Camera zoom out', key: 'Minus', pad: PAD_BUTTON.R3 },
];

/** actionId -> the virtual code gameplay polls. Never changes. */
export const VIRTUAL = Object.freeze(
  Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])),
);

/** actionId -> {key, pad} as shipped. */
export const DEFAULT_BINDINGS = Object.freeze(
  Object.fromEntries(ACTIONS.map((a) => [a.id, Object.freeze({ key: a.key, pad: a.pad })])),
);

/**
 * Codes no action may be bound to, because something reads them RAW.
 *
 * `Menus.navigate` polls ArrowUp/Down/Left/Right, Enter, NumpadEnter, Space,
 * Escape and Backspace directly, and `Menus.update` polls KeyC for the Edict.
 * Those never go through this map, so binding an action onto one of them would
 * hand the key to the action and silently take menu movement, confirm, back or
 * the Edict away from the player — with no way to reach the settings screen
 * that would undo it. Reserving them is the small correct fix; virtualizing the
 * menu's own navigation is a much larger change for no player-facing gain.
 *
 * Digit1-3 join them for the same reason: the `.mutate-choice` window reads
 * them raw off `ctx.input` in `Menus.update` while the pointer is locked, and
 * they are its only input path — no pad or virtual-code fallback exists.
 *
 * Space and the WASD codes are deliberately NOT here: they are shipped
 * defaults, and `navigate` reads them as the VIRTUAL codes this map produces,
 * so a rebind carries the menu with it instead of breaking it.
 */
export const RESERVED_KEYS = Object.freeze([
  'Escape', 'Enter', 'NumpadEnter', 'Backspace', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyC', 'Digit1', 'Digit2', 'Digit3',
]);

/** Would binding this code steal a raw-read menu control? */
export function isReserved(code) { return RESERVED_KEYS.includes(code); }

/** Human label for a physical key/mouse code, for prompts and the bind list. */
export function keyLabel(code) {
  if (code == null) return '--';
  if (code === MOUSE_LEFT) return 'LMB';
  if (code === MOUSE_RIGHT) return 'RMB';
  if (code === 'Space') return 'Space';
  if (code === 'Equal') return '=';
  if (code === 'Minus') return '-';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  if (code.startsWith('Mouse')) return `Mouse ${code.slice(5)}`;
  if (code.endsWith('Left')) return code.slice(0, -4);
  if (code.endsWith('Right')) return `Right ${code.slice(0, -5)}`;
  return code;
}

/** Is this a code `Input` must route onto the mouse flags rather than keys? */
export function isMouseCode(code) { return code === MOUSE_LEFT || code === MOUSE_RIGHT; }

export class Bindings {
  constructor(stored) {
    this.reset();
    if (stored) this.adopt(stored);
  }

  reset() {
    /** actionId -> physical key/mouse code */
    this.keys = {};
    /** actionId -> pad button index, or null */
    this.pads = {};
    for (const a of ACTIONS) { this.keys[a.id] = a.key; this.pads[a.id] = a.pad; }
  }

  /**
   * Fold a stored blob in, defensively — the same posture `Menus.load` takes
   * with the numeric settings. Anything that is not a non-empty string for a
   * known action, or not an integer pad index, is left at its default, and a
   * value that would duplicate an assignment already taken is dropped rather
   * than allowed to shadow another action.
   */
  adopt(stored) {
    if (!stored || typeof stored !== 'object') return;
    for (const a of ACTIONS) {
      const b = stored[a.id];
      if (!b || typeof b !== 'object') continue;
      if (typeof b.key === 'string' && b.key && !isReserved(b.key)
          && !this._keyTaken(b.key, a.id)) {
        this.keys[a.id] = b.key;
      }
      if (b.pad === null) this.pads[a.id] = null;
      else if (Number.isInteger(b.pad) && b.pad >= 0 && !this._padTaken(b.pad, a.id)) {
        this.pads[a.id] = b.pad;
      }
    }
  }

  _keyTaken(code, exceptId) {
    return ACTIONS.some((a) => a.id !== exceptId && this.keys[a.id] === code);
  }

  _padTaken(btn, exceptId) {
    return ACTIONS.some((a) => a.id !== exceptId && this.pads[a.id] === btn);
  }

  /** The virtual code gameplay polls for this action. */
  code(actionId) { return VIRTUAL[actionId]; }

  keyOf(actionId) { return this.keys[actionId] ?? null; }
  padOf(actionId) { return this.pads[actionId] ?? null; }

  /** Physical key/mouse code -> the virtual code to feed gameplay, or null. */
  virtualForKey(code) {
    for (const a of ACTIONS) if (this.keys[a.id] === code) return VIRTUAL[a.id];
    return null;
  }

  /**
   * Is this code one of the virtual names an action is known by?
   *
   * It matters because the virtual namespace and the physical one share
   * spellings. Rebinding "move forward" to I leaves the physical W unbound —
   * and W's own code is still `moveForward`'s virtual name, so passing an
   * unbound press through unchanged would make the old key keep working.
   * `Input` drops those instead.
   */
  isVirtual(code) { return Object.values(VIRTUAL).includes(code); }

  /** Pad button index -> the virtual code to feed gameplay, or null. */
  virtualForPad(btn) {
    for (const a of ACTIONS) if (this.pads[a.id] === btn) return VIRTUAL[a.id];
    return null;
  }

  /** Every virtual code a pad button currently produces (for `clearPadEdges`). */
  padVirtuals() {
    return ACTIONS.filter((a) => this.pads[a.id] != null).map((a) => VIRTUAL[a.id]);
  }

  /**
   * Assign a key. CONFLICT RULE: swap. If another action already holds this
   * code it receives the code being displaced, so no action is ever left
   * unbound and no key ever drives two actions — a block-with-message rule can
   * leave a player who has half-finished a layout with an action they can no
   * longer reach. Returns the id of the action that was swapped, or null.
   */
  bindKey(actionId, code) {
    if (!(actionId in this.keys) || typeof code !== 'string' || !code) return null;
    const prev = this.keys[actionId];
    const other = ACTIONS.find((a) => a.id !== actionId && this.keys[a.id] === code);
    this.keys[actionId] = code;
    if (other) { this.keys[other.id] = prev; return other.id; }
    return null;
  }

  /** Same swap rule for pad buttons. */
  bindPad(actionId, btn) {
    if (!(actionId in this.pads) || !Number.isInteger(btn)) return null;
    const prev = this.pads[actionId];
    const other = ACTIONS.find((a) => a.id !== actionId && this.pads[a.id] === btn);
    this.pads[actionId] = btn;
    if (other) { this.pads[other.id] = prev; return other.id; }
    return null;
  }

  toJSON() {
    const out = {};
    for (const a of ACTIONS) out[a.id] = { key: this.keys[a.id], pad: this.pads[a.id] };
    return out;
  }
}

/**
 * The one live map. `Input` reads it, the settings screen writes it, and the
 * HUD's prompt labels read it — one object rather than a value copied at boot
 * into three places that then disagree after a rebind.
 */
export const bindings = new Bindings();
