/**
 * Damage-readout glyph atlas geometry.
 *
 * Extracted from `VFX.js` (issue #92, items 3 and 4) for one reason: every
 * number in here is mirrored somewhere it cannot see. `NUM_ADVANCE` is
 * interpolated into `NumberVert`'s `float cw` *and* hand-written into `_box`'s
 * CPU reservation; `NUM_HALO_PX` is a radius in atlas texels that is only valid
 * while the tile has padding left over after the font and its stroke. Until
 * this file existed, the only thing that could notice a broken mirror was the
 * manual capture gate — a slow, headed GPU run nobody triggers on a one-line
 * constant edit.
 *
 * This module has no imports on purpose. It touches no browser API, so
 * `tests/glyph-atlas-layout.test.mjs` can import it in bare node and assert the
 * relationships for real rather than parsing them back out of source text.
 *
 * `VFX.js` keeps the prose rationale for the *values*; this file owns the
 * arithmetic that ties them together.
 */

/** Glyphs the atlas carries, in atlas index order. */
export const GLYPHS = '0123456789!+-x%';

/**
 * Horizontal advance between glyph centres, in quad widths. Specified in *quad*
 * units, so it moves with `NUM_TILE`. Mirrored by the vertex shader's `cw` and
 * by `glyphRunHalfWidthChars` below — those two are the mirror, and the test
 * pins them to each other.
 */
export const NUM_ADVANCE = 0.496;

/** Atlas tile edge, in atlas texels. 160 rather than 128 to buy halo padding. */
export const NUM_TILE = 160;
/** Tiles per atlas row (and column — the atlas is square). */
export const NUM_COLS = 4;
/** Glyph font size drawn into a tile, in atlas texels. */
export const NUM_FONT_PX = 88;
/** Keyline stroke width, in atlas texels. Straddles the outline, so half of it
 * lies outside the ink. */
export const NUM_STROKE_PX = 20;
/** Halo dilation radius, in atlas texels. Must stay within the tile padding. */
export const NUM_HALO_PX = 26;

/** Atlas canvas edge, in texels. */
export const atlasSizePx = () => NUM_TILE * NUM_COLS;

/** Halo radius expressed in atlas UV, as `uHaloUv` wants it. */
export const haloUv = () => NUM_HALO_PX / atlasSizePx();

/**
 * The room left between a glyph's inked extent and its tile edge, in atlas
 * texels. The ink is the font's cap box (~0.9 of the em) grown by half the
 * stroke on each side; a halo tap beyond this reads the neighbouring tile.
 */
export const tilePaddingPx = () => NUM_TILE * 0.5 - (NUM_FONT_PX * 0.9 + NUM_STROKE_PX) * 0.5;

/**
 * Width of a `len`-glyph run in quad widths — the run's own quad plus the
 * advance of each glyph after the first. `_box` projects exactly this, and the
 * vertex shader lays glyphs out on the same advance, so the collision
 * reservation describes the numerals it is reserving space for.
 */
export const glyphRunWidthChars = (len) => (len - 1) * NUM_ADVANCE + 1;
