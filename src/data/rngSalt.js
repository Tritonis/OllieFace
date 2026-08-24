// src/data/rngSalt.js
//
// The shared half of the salted-stream idiom used across the corruption
// systems: `new RNG(saltedSeed(seed, key, mult) || 1)`. Raw
// `(seed ^ mult*(key+1)) >>> 0` biases small-N picks for small contiguous
// seeds — the salted values differ only in their low bits and a generator's
// first draw does not carry them into the high ones (`src/data/vows.js`
// documents the concrete failure: seeds 0..7 all landing on the same vow).
// The standard fmix32 finaliser avalanches the salt first, so every bit of
// the value read by `new RNG(...)` depends on every bit of (seed, key).
//
// Zero imports, so `tests/import-boundaries.test.mjs` rule 2 (`src/data/`
// imports only `src/data/` and three) is satisfied trivially — this module
// is pure arithmetic, not a consumer of `core/MathUtil.js`'s `RNG`.
export function saltedSeed(seed, key, mult) {
  let h = ((seed >>> 0) ^ (Math.imul(mult, ((key >>> 0) + 1)) >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}
