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
   *
   * Every value below was measured by
   * `node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json`
   * under d3d11, and is copied from that record. Nineteen entries, in three
   * groups, and none of them is a threshold that was moved to fit the roster.
   */
  exemptions: [
    // The mite is 0.5 m tall and covers 74 px at 40 m against a 219 floor — a
    // third of what the bestiary shot's per-object floor asks for. It is a
    // swarm card (packMin 5) and was probably never meant to be read as an
    // individual at range, but "read it as a cloud" is a design decision that
    // has never been written down, and until it is, this is the roster's one
    // genuine 40 m failure. Slice-3 / content work.
    { id: 'mite', kind: 'px40', value: 74, note: 'smallest card, 0.5 m tall: 74 px at 40 m vs a 219 floor' },

    // Daylight. Seventeen of twenty-five cards have less enclosed negative
    // space in their front-on idle than `minHoles` asks for, and eight of them
    // have literally none. This is not the instrument failing: thunderhead
    // reads 14.03%, acolyte 3.72%, vizier 2.12%, warden 1.95% on the same run,
    // so enclosed space is detected wherever it exists. It is also not a
    // resolution artifact at the top of the list — colossus (858x737 px of bbox),
    // hulk (332x452) and wyrm (540x760) read exactly zero with tens of
    // thousands of pixels available to find a hole in.
    //
    // What it actually says is that most of this roster's silhouettes are
    // closed outlines: the gaps that exist are between legs or beside an arm,
    // open at the boundary, and the flood fill correctly refuses to count
    // them. Whether that is a defect is a content question and a big one —
    // it is the single largest finding this gate has produced — and it is
    // recorded here rather than dissolved by lowering `minHoles`.
    { id: 'mite',     kind: 'holes', value: 0.0002, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'spitling', kind: 'holes', value: 0.0003, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'skink', kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'mote',     kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'shrike',     kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'harrier',  kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'burrower', kind: 'holes', value: 0.0001, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'brood',    kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'sentinel',    kind: 'holes', value: 0.0001, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'mortar',   kind: 'holes', value: 0.0013, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'lasher',   kind: 'holes', value: 0.0022, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'redoubt',  kind: 'holes', value: 0.0015, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'hulk',     kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'colossus',    kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'wyrm',     kind: 'holes', value: 0,      note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'matron',   kind: 'holes', value: 0.0008, note: 'closed outline: no enclosed negative space in the idle read' },
    { id: 'maw',      kind: 'holes', value: 0.0029, note: 'closed outline: no enclosed negative space in the idle read' },

    // The roster's one silhouette collision, and it is marginal: 0.0166 over
    // the bar. Both are tall, narrow, hunched tier-2 casters — brood at aspect
    // 0.500 and acolyte at 0.602 — and at bbox-normalised scale they are close
    // to the same posture. The next-worst pair in the roster is charger/brood
    // at 0.734, comfortably under. Slice-3 / content work: one of the two
    // needs a distinguishing feature that survives being flattened.
    { id: 'brood/acolyte', kind: 'familyIoU', value: 0.7966, note: 'two hunched tier-2 casters at near-identical normalised posture' },
  ],
};

/**
 * Grade a recorded roster against READABILITY.
 *
 * Two directions of threshold, and they ratchet in opposite directions:
 * `px40`, `tierArea`, `eliteDelta`, `eliteChroma` and `holes` are floors (more
 * is better, an exemption caps how far *under* the floor a unit may sit);
 * `familyIoU` and `foeFriendIoU` are ceilings (less is better, an exemption
 * caps how far *over* it a pair may sit).
 *
 * The exemption list is the honest half of this. A gate authored against a
 * roster it has never measured is a gate that goes red on arrival and gets
 * switched off within a week. This one is allowed to admit what the roster
 * already is — once, in writing, with the measured value and the record it
 * came from — and is then absolute about anything new or anything worse.
 *
 * `EXEMPT_SLACK` is the other half of surviving. Every exemption was copied
 * from the record at full precision, so every exempted check sat at *exactly*
 * its bar: one pixel off the mite's 40 m footprint, or +0.0001 on the
 * brood/acolyte IoU, and the gate went red on a re-run that changed nothing
 * but the rasteriser's mind. A ratchet with no tolerance against a d3d11
 * driver gets switched off in the same week as a gate authored blind. So an
 * exempted bar — and *only* an exempted bar; the design thresholds above are
 * absolute and are not moved by this — carries 1 % of relative slack, floored
 * at one whole pixel for `px40` where the unit is discrete. That is far under
 * the smallest real regression any of these checks could describe and far over
 * the noise, so "no worse than when we admitted it" keeps meaning what it
 * says: an exemption that genuinely degrades still goes red.
 */
const EXEMPT_SLACK = 0.01;
const slackFor = (kind, value) => (kind === 'px40'
  ? Math.max(1, Math.abs(value) * EXEMPT_SLACK)
  : Math.abs(value) * EXEMPT_SLACK);

export function gradeRoster(record, exemptions = READABILITY.exemptions) {
  const checks = [];
  const ex = (id, kind) => exemptions.find((e) => e.id === id && e.kind === kind) || null;

  const floor = (id, kind, value, limit) => {
    const e = ex(id, kind);
    const bar = e ? Math.min(limit, e.value - slackFor(kind, e.value)) : limit;
    checks.push({ id, kind, value, floor: bar, ok: value >= bar, exempt: !!e });
  };
  const ceiling = (id, kind, value, limit) => {
    const e = ex(id, kind);
    const bar = e ? Math.max(limit, e.value + slackFor(kind, e.value)) : limit;
    checks.push({ id, kind, value, ceiling: bar, ok: value <= bar, exempt: !!e });
  };

  for (const u of record.units || []) {
    floor(u.id, 'px40', u.px40, READABILITY.minPx40);
    floor(u.id, 'holes', u.holesFrac, READABILITY.minHoles);
  }
  for (const p of record.familyPairs || []) {
    ceiling(`${p.a}/${p.b}`, 'familyIoU', p.iou, READABILITY.maxFamilyIoU);
  }
  for (const p of record.foeFriendPairs || []) {
    ceiling(`${p.a}/${p.b}`, 'foeFriendIoU', p.iou, READABILITY.maxFoeFriendIoU);
  }
  // Tier separation is a property of consecutive tiers, so it is graded on the
  // pairs that exist in the record rather than on a fixed 1..4.
  const tiers = Object.keys(record.tierMedianPx || {}).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < tiers.length; i++) {
    const lo = record.tierMedianPx[tiers[i - 1]], hi = record.tierMedianPx[tiers[i]];
    floor(`tier${tiers[i - 1]}->${tiers[i]}`, 'tierArea', lo > 0 ? hi / lo : 0,
          READABILITY.minTierAreaRatio);
  }
  for (const e of record.elites || []) {
    floor(`${e.id}:${e.affix}`, 'eliteDelta', e.delta, READABILITY.minEliteDelta);
    floor(`${e.id}:${e.affix}`, 'eliteChroma', e.chroma, READABILITY.minEliteChroma);
  }

  return { ok: checks.every((c) => c.ok), checks };
}
