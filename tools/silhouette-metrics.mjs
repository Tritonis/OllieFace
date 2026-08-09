// tools/silhouette-metrics.mjs
/**
 * The arithmetic half of the readability gate.
 *
 * `tools/silhouette.mjs` needs playwright, vite and a real GPU to produce a
 * mask. It needs none of them to *measure* one, and a gate whose measurement
 * can only be exercised by a minute of browser is a gate nobody runs and
 * nobody can prove still measures anything. So everything downstream of the
 * pixels lives here: pure, node-importable, and pinned by
 * `tests/readability-gate.test.mjs` against masks that file draws itself.
 *
 * The mask format is the one the in-page packer produces: one bit per pixel,
 * row-major, top row first, LSB-first within each byte, base64'd.
 */

/** Unpack a base64 mask into a bit reader. */
export function maskReader(b64, w) {
  const bits = Buffer.from(b64, 'base64');
  return (x, y) => {
    const i = y * w + x;
    return (bits[i >> 3] >> (i & 7)) & 1;
  };
}

const EMPTY_BANDS = () => Array.from({ length: 10 }, () => ({ w: 0, fill: 0, runs: 0 }));

/**
 * Everything one silhouette is worth, from its mask.
 *
 * `bands` is the shape of the shape — ten width/fill/run samples from the
 * crown down. `runs` is the mean number of separate solid segments per
 * scanline, which is the direct measure of daylight through the outline: a
 * band at 1.00 is a solid bar, i.e. arms welded to a torso or legs fused into
 * one column. `holes` is background inside the bbox the border flood cannot
 * reach — zero of it is the "solid lump" failure. `sig` is a bbox-normalised
 * 64x64 signature, so scale is removed on purpose and it answers "is this the
 * same shape at a different size".
 */
export function measureMask(b64, w, h) {
  const get = maskReader(b64, w);
  let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!get(x, y)) continue;
    area++; sx += x; sy += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // An empty mask is a real answer — a rig that rendered nothing — and it must
  // reach the grader as a zero rather than as a crash or a NaN that compares
  // false against every threshold and reads as a pass.
  if (area === 0) {
    return {
      x0: 0, y0: 0, bw: 0, bh: 0, area: 0, fill: 0, aspect: 0, cx: 0, cy: 0,
      holes: 0, bands: EMPTY_BANDS(), sig: new Uint8Array(64 * 64),
    };
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  const bands = [];
  for (let b = 0; b < 10; b++) {
    const ya = y0 + Math.floor(bh * b / 10), yb = y0 + Math.floor(bh * (b + 1) / 10);
    let lo = w, hi = -1, fill = 0, runs = 0, scan = 0;
    for (let y = ya; y < yb; y++) {
      scan++;
      let prev = 0;
      for (let x = x0; x <= x1; x++) {
        const v = get(x, y);
        if (v && !prev) runs++;
        prev = v;
        if (!v) continue;
        fill++;
        if (x < lo) lo = x; if (x > hi) hi = x;
      }
    }
    bands.push({
      w: hi < 0 ? 0 : (hi - lo + 1) / bw,
      fill: fill / (((yb - ya) * bw) || 1),
      runs: runs / (scan || 1),
    });
  }

  const seen = new Uint8Array(bw * bh);
  const stack = [];
  for (let x = 0; x < bw; x++) { stack.push([x, 0], [x, bh - 1]); }
  for (let y = 0; y < bh; y++) { stack.push([0, y], [bw - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
    if (seen[y * bw + x] || get(x0 + x, y0 + y)) continue;
    seen[y * bw + x] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  let holes = 0;
  for (let i = 0; i < bw * bh; i++) if (!seen[i] && !get(x0 + (i % bw), y0 + ((i / bw) | 0))) holes++;

  const sig = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    sig[y * 64 + x] = get(x0 + Math.floor(x * bw / 64), y0 + Math.floor(y * bh / 64));
  }

  return {
    x0, y0, bw, bh, area,
    fill: +(area / (bw * bh)).toFixed(4),
    aspect: +(bw / bh).toFixed(4),
    cx: +(((sx / area) - x0 + 0.5) / bw).toFixed(4),
    cy: +(((sy / area) - y0 + 0.5) / bh).toFixed(4),
    holes,
    bands, sig,
  };
}

/** Intersection over union of two 64x64 signatures. Empty over empty is 0. */
export function shapeIoU(a, b) {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] & b[k]) inter++; if (a[k] | b[k]) uni++; }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * The gate's thresholds. Task 2 defines what each one is measured against;
 * every value here is either sourced from an existing measurement in this
 * repo or is a design intent the first recorded run ratchets against.
 */
export const READABILITY = {
  // Silhouette pixels a unit must cover at 40 m, at the capture harness's
  // 1600x900 and the live camera's own FOV. 219 is not invented: it is the
  // per-object floor `11-bestiary` already sets for itself (minPixels 3500
  // over sixteen cards, src/core/Harness.js) and the number that shot was
  // re-framed three times to clear. A unit that cannot make the bestiary
  // shot's floor at 40 m cannot be read at 40 m in a fight either.
  minPx40: 219,
  // Two enemy families whose bbox-normalised silhouettes overlap more than
  // this are the same monster wearing two names.
  maxFamilyIoU: 0.78,
  // An enemy that reads as a survivor is the friend/foe failure. Held tighter
  // than the family bar: mistaking a monster for a monster costs a beat,
  // mistaking one for a teammate costs the fight.
  maxFoeFriendIoU: 0.72,
  // Median silhouette area at 40 m, tier n+1 against tier n. Area, not height:
  // it is what the eye integrates. 1.6 is comfortably under the roster's own
  // spread (tier-1 median height 1.1 m, tier-2 2.6 m, tier-3 3.4 m) and well
  // over the 1.0 that would mean tiers are indistinguishable by size.
  minTierAreaRatio: 1.6,
  // An affix must change the outline it is painted on: 1 - IoU(plain, elite).
  // Every affix in ELITE spends bands, bits or a ward on exactly this.
  minEliteDelta: 0.10,
  // And it must change the colour too, since the tint is what carries the
  // affix's identity: mean per-channel distance between the plain and elite
  // colour renders over the union of their masks, 0-1.
  minEliteChroma: 0.06,
  // Daylight: no unit may be a solid lump. A silhouette with no enclosed
  // negative space at all, as a fraction of its own bbox.
  minHoles: 0.004,
  /**
   * The ratchet. Each entry is a check the roster fails *as shipped*, with the
   * value measured at the time it was admitted and the run that measured it.
   * The gate passes an exempted check only while it is no worse than the
   * recorded value — a new failure is red, and an exempted one that degrades
   * is red. Adding an entry here is a content decision and belongs in a
   * commit of its own, with the record it came from.
   */
  exemptions: [],
};
