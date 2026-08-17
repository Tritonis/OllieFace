// Controller layout glyph sets (#42) — the names on-screen prompts print for
// pad buttons. Before this file, prompts always printed the Xbox-face names
// because that is what `PAD_BUTTON` is keyed on; a PlayStation or Switch
// player reading "Press A" for a button their pad does not have is exactly the
// mismatch this file exists to close. Selection is manual (Settings), never
// auto-detected — no gamepad-vendor sniffing exists anywhere in this repo to
// default it from, so inventing one would be guessing, the same posture the
// `captions` default in `Menus.DEFAULTS` already takes on unrelated ground.

// `src/data/` may only import `src/data/` and three (import-boundaries.test.mjs
// rule 2), so the button-index -> name table below is a deliberate literal
// copy of `core/PadState.js`'s `PAD_BUTTON`, not an import of it. If that
// table's indices ever move, this one has to move with it by hand.

/** Every selectable glyph set, in the order the settings screen lists them. */
export const GLYPH_SETS = [
  { id: 'xbox', label: 'Xbox' },
  { id: 'playstation', label: 'PlayStation' },
  { id: 'switch', label: 'Switch' },
  { id: 'generic', label: 'Generic' },
];

/** The shipped default — the historical Xbox-face naming every prompt used
 *  to print unconditionally. */
export const DEFAULT_GLYPH_SET = 'xbox';

const NAMES = {
  xbox: {
    A: 'A', B: 'B', X: 'X', Y: 'Y',
    LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT',
    BACK: 'View', START: 'Menu',
  },
  playstation: {
    A: 'Cross', B: 'Circle', X: 'Square', Y: 'Triangle',
    LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2',
    BACK: 'Share', START: 'Options',
  },
  switch: {
    // Nintendo's face buttons sit in the Xbox layout's mirror image (A/B and
    // X/Y swapped), not just renamed in place.
    A: 'B', B: 'A', X: 'Y', Y: 'X',
    LB: 'L', RB: 'R', LT: 'ZL', RT: 'ZR',
    BACK: '-', START: '+',
  },
  generic: {
    A: 'Button 1', B: 'Button 2', X: 'Button 3', Y: 'Button 4',
    LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT',
    BACK: 'Back', START: 'Start',
  },
};

const PAD_NAMES = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'BACK', 9: 'START',
};

/** Is this a glyph set id `Menus`/`HUD` may store and select? */
export function isGlyphSet(id) { return GLYPH_SETS.some((g) => g.id === id); }

/** Human label for a pad button index, in the given glyph set. */
export function glyphLabel(btn, setId) {
  if (btn == null) return '--';
  const name = PAD_NAMES[btn];
  if (!name) return `Button ${btn}`;
  const table = NAMES[setId] ?? NAMES[DEFAULT_GLYPH_SET];
  return table[name] ?? name;
}
