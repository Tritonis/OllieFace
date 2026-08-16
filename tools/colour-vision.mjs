// tools/colour-vision.mjs
//
// Colour-vision arithmetic for the readability gate.
//
// The HUD spends colour freely — seven item tiers, six elite affixes — and until
// this module existed nothing in the repo asked whether any of it survived the
// three common dichromacies, or survived colour being removed altogether. Around
// one player in twelve has one of them, and the two channels the game leans on
// hardest, item rarity and elite threat, are exactly the pair that fails
// together: both are "a bright saturated hue against near-black", which is the
// signal a dichromat has least of.
//
// Nothing here is a design opinion. The simulation matrices are published, the
// difference metric is a CIE standard, and the only judgement in the file is
// where the bars sit (`PALETTE`), which is recorded next to them with the
// measurement that set them.
//
// Pure arithmetic, no DOM, no GPU — the same reason the silhouette maths was
// split out of `tools/silhouette.mjs` into `tools/silhouette-metrics.mjs`.

/* ------------------------------------------------------------ sRGB transfer */

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Accepts either of the two shapes the codebase already stores colours in:
 * `'#rrggbb'` (CSS, `src/ui/Icons.js`) and `0xrrggbb` (three.js,
 * `src/entities/EnemyMeshes.js`). Returns *linear* RGB, because every transform
 * below is a linear-light operation and applying one to gamma-encoded values is
 * the classic way to get a plausible-looking wrong answer.
 */
export function toLinear(colour) {
  const n = typeof colour === 'number'
    ? colour >>> 0
    : parseInt(String(colour).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
}

/** Back to `'#rrggbb'`, clamped into gamut. */
export function toHex(linear) {
  const [r, g, b] = linear.map((v) => Math.round(clamp01(linearToSrgb(clamp01(v))) * 255));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------- dichromacy simulation */

/*
 * Viénot, Brettel & Mollon (1999), "Digital video colourmaps for checking the
 * legibility of displays by dichromats", Color Research & Application 24(4).
 * These are the paper's linear-RGB reductions for the three dichromacies —
 * protanopia (no L cone), deuteranopia (no M cone), tritanopia (no S cone).
 *
 * They model the *dichromacies*, the total absences, not the far more common
 * anomalous trichromacies that shade into them. That is the right conservatism
 * for a gate: a palette that separates for a protanope separates for every
 * protanomalous player behind them, and the converse is not true.
 */
const MATRICES = {
  protan: [[0.1121, 0.8853, -0.0005], [0.1127, 0.8897, -0.0001], [0.0045, 0.0085, 1.0000]],
  deutan: [[0.2920, 0.7054, -0.0003], [0.2934, 0.7089, 0.0000], [-0.0209, 0.4912, 0.5300]],
  tritan: [[1.0000, 0.1440, -0.1440], [0.0000, 0.8271, 0.1729], [0.0000, 0.7050, 0.2950]],
};

/**
 * The fourth "vision" is no vision of colour at all: CIE relative luminance,
 * re-encoded as a grey. It is not a form of colour blindness — it is the floor
 * under all of them, and the only one that also covers a washed-out monitor, a
 * compressed stream and a screenshot someone desaturated. A palette that
 * survives this was never carrying its information in hue.
 */
function desaturate(linear) {
  const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return [y, y, y];
}

/**
 * `normal` is in the list on purpose. A gate that only measured the three
 * dichromacies could be passed by a palette that separates beautifully for a
 * deuteranope and has two near-identical hues for everyone else — and the elite
 * affix table was already close to that, with Warded and Hollowed 7.1 apart in
 * ordinary vision before this file existed. Trichromatic separation is not the
 * thing being fixed here, but it is the thing most easily broken while fixing
 * it, so it is measured against the same bar.
 */
export const VISIONS = ['normal', 'protan', 'deutan', 'tritan', 'mono'];

/** One colour as `vision` sees it, returned in the same `'#rrggbb'` form. */
export function simulate(colour, vision) {
  const lin = toLinear(colour);
  if (vision === 'mono') return toHex(desaturate(lin));
  const m = MATRICES[vision];
  if (!m) return toHex(lin);
  return toHex(m.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
}

/* ---------------------------------------------------------- CIEDE2000 */

/** CIE L*a*b* under D65, from linear RGB. */
export function lab(colour) {
  const [r, g, b] = toLinear(colour);
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    (0.2126729 * r + 0.7151522 * g + 0.0721750 * b),
    (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883,
  ];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = xyz.map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000 (CIE 142-2001). Plain Euclidean Lab distance would do for a rough
 * sort, but it badly overstates differences in the blue corner and understates
 * them among near-neutrals, and this palette lives in both places at once — the
 * Umbral cyan and the near-white Common are the two ends of that error. A
 * standard metric also means the bars below can be quoted against the
 * literature rather than against this file's own taste.
 *
 * Roughly: 1.0 is the just-noticeable difference for two large flat patches
 * side by side, and small marks glimpsed across a fight need very much more.
 */
export function deltaE(c1, c2) {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;
  const pow7 = (v) => Math.pow(v, 7);

  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(pow7(Cbar) / (pow7(Cbar) + pow7(25))));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hue = (bb, aa) => {
    if (bb === 0 && aa === 0) return 0;
    const h = Math.atan2(bb, aa) * DEG;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2);

  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp * RAD) / 2);

  const Lbp = (L1 + L2) / 2, Cbp = (Cp1 + Cp2) / 2;
  let hbp = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) > 180) hbp += hbp < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1
    - 0.17 * Math.cos((hbp - 30) * RAD)
    + 0.24 * Math.cos(2 * hbp * RAD)
    + 0.32 * Math.cos((3 * hbp + 6) * RAD)
    - 0.20 * Math.cos((4 * hbp - 63) * RAD);
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2)) * RAD)
    * 2 * Math.sqrt(pow7(Cbp) / (pow7(Cbp) + pow7(25)));

  return Math.sqrt(
    Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2)
    + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** The difference two colours retain once `vision` has had them. */
export function deltaEUnder(c1, c2, vision) {
  return deltaE(simulate(c1, vision), simulate(c2, vision));
}

/* ------------------------------------------------------------- the bars */

/*
 * Where the bars come from.
 *
 * They are set from what the palettes can actually reach, not from a number
 * picked first and hoped for. Seven tier hues and six affix hues have to be
 * mutually separable in a space that has lost a whole opponent channel, and the
 * room shrinks fast: under deuteranopia the red-green axis collapses onto
 * blue-yellow, so seven colours end up competing over roughly one hue dimension
 * plus lightness — and lightness is itself constrained, because a saturated
 * yellow only exists near the top of the range and a saturated red only near
 * the bottom.
 *
 * `colour` 12 is what those constraints leave. It is well above the ~5 at which
 * two patches read as "a slightly different shade" of one colour, and it is
 * reachable with every tier keeping the hue the game already gave it. Pushing
 * it to 15 is possible on paper and the palettes it produces are not the game's:
 * the search that satisfies 15 turns Legendary pink and Boss olive, which trades
 * a real identity for a bar with no player behind it. 12 with a mandatory shape
 * is the better exchange, and the shape is not a consolation — it is the channel
 * that survives when colour is gone entirely.
 *
 * `mono` 4 is deliberately much lower and is doing a narrower job. Once colour
 * is removed, seven bright tiers cannot be told apart by lightness alone without
 * one of them being nearly invisible on a near-black plate — that is arithmetic,
 * not a shortfall. So this bar asks only that no two tiers are *the same grey*;
 * it does not claim a tier can be named from its grey. Naming is the tier mark's
 * job, and `MARK_SIMILARITY` is what holds the marks to it.
 */
export const PALETTE = {
  colour: 12,
  mono: 4,
};

/**
 * The ceiling on how alike two tier marks may be, under the same
 * aspect-preserving silhouette metric `tools/silhouette-metrics.mjs` uses to
 * keep two survivors from reading as one another.
 *
 * 0.72 is `READABILITY.maxSurvivorSimilarity` rather than a new number: the
 * question is identical — can these two shapes be told apart at a glance — so a
 * second, differently-argued threshold for it would be a liability. The seven
 * shipped marks measure 0.63 on their worst pair, Uncommon's two strokes against
 * Blight's saltire.
 */
export const MARK_SIMILARITY = 0.72;

/**
 * Every pair in `set` measured under every vision, worst first.
 *
 * `set` is `{ id: colour }` in either accepted colour form. Returns one row per
 * pair per vision, each carrying its own bar, so a caller can report exactly
 * which pair fails which vision rather than a single boolean.
 */
export function gradePalette(set, bars = PALETTE) {
  const ids = Object.keys(set);
  const checks = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const vision of VISIONS) {
        const min = vision === 'mono' ? bars.mono : bars.colour;
        const delta = deltaEUnder(set[ids[i]], set[ids[j]], vision);
        checks.push({
          id: `${ids[i]}/${ids[j]}`, vision, delta, min, ok: delta >= min,
        });
      }
    }
  }
  checks.sort((a, b) => (a.delta - a.min) - (b.delta - b.min));
  return { ok: checks.every((c) => c.ok), checks };
}
