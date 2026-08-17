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
 * Losing a cone destroys a dimension. That is the one structural fact every
 * simulation here has to satisfy, and it is worth stating as arithmetic rather
 * than as prose, because it is checkable and because the first version of this
 * file failed it: a dichromacy matrix must be **rank 2** (determinant zero) and
 * an **idempotent projection** (M squared equals M), and it must leave greys
 * alone (its rows sum to one). `tests/readability-gate.test.mjs` asserts all
 * three of those on every matrix below, which is the check that would have
 * caught what shipped here first — see the tritan note.
 *
 * Protanopia and deuteranopia are Viénot, Brettel & Mollon (1999), "Digital
 * video colourmaps for checking the legibility of displays by dichromats",
 * Color Research & Application 24(4), in the paper's linear-sRGB form. Rows one
 * and two are identical by construction: with the L or the M cone gone, the two
 * remaining long-wave responses collapse onto a single value, and that identity
 * is what makes these exact projections rather than approximations of one.
 *
 * These model the *dichromacies*, the total absences, not the far more common
 * anomalous trichromacies that shade into them. That is the right conservatism
 * for a gate: a palette that separates for a protanope separates for every
 * protanomalous player behind them, and the converse is not true.
 */
const MATRICES = {
  protan: [[0.11238, 0.88762, 0], [0.11238, 0.88762, 0], [0, 0, 1]],
  deutan: [[0.29275, 0.70725, 0], [0.29275, 0.70725, 0], [-0.02234, 0.02234, 1]],

  /*
   * Tritanopia is NOT from that paper, and saying it was is what this entry is
   * a correction of.
   *
   * Viénot, Brettel & Mollon give no validated tritan reduction — the paper
   * addresses protanopia and deuteranopia only — and the single matrix that
   * shipped here under their name was measurably not a dichromacy simulation at
   * all: determinant 0.122, i.e. full rank, i.e. it destroyed no dimension and
   * threw away nothing. Roughly a fifth of this gate's verdicts rested on it.
   *
   * What replaces it is derived here, from three statements, so that every part
   * of it can be argued with:
   *
   *   1. Greys are unchanged.       A dichromat's neutral axis is a normal one.
   *   2. Red is unchanged.          A tritanope's L and M cones are intact, so
   *                                 the red-green axis survives; it is the
   *                                 blue-yellow axis that goes.
   *   3. The confusion direction is the blue primary. This is the approximation
   *                                 in the set: the S cone is gone, and L and M
   *                                 respond only weakly at short wavelengths,
   *                                 so blue is taken to carry no surviving
   *                                 signal at all.
   *
   * A projection fixing the plane through (1,1,1) and (1,0,0) with null
   * direction (0,0,1) is uniquely determined by those three, and it is the
   * matrix below: blue collapses onto green, which is the tritan confusion.
   *
   * The honest cost of statement 3 is that L and M do retain a small short-wave
   * response, so this discards slightly more than a real tritanope does. It is
   * therefore *harsh* on blue-carrying colours rather than lenient — a pair
   * separated only by blue scores worse here than a tritanope would find it —
   * and a gate that errs toward failing is the tolerable direction to err.
   *
   * Doing it properly means Brettel, Viénot & Mollon (1997), whose method is
   * two half-planes meeting at the neutral axis rather than one, anchored at
   * 485 nm and 660 nm. That needs cone fundamentals and those two anchor
   * chromaticities, neither of which is derivable in this file, so it is left
   * undone rather than approximated under a citation it does not have.
   */
  tritan: [[1, 0, 0], [0, 1, 0], [0, 1, 0]],
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

/* -------------------------------------------------------------- contrast
 *
 * The axis the first version of this gate did not have, and the one it broke.
 *
 * Separating seven colours from each other under dichromacy pushes them apart
 * in lightness, and lightness is also the whole of their contrast against the
 * near-black they are drawn on. Optimising the first without pricing the second
 * walked Uncommon to 4.36:1 against its own plate and Equipment to 3.77:1 —
 * both had been 8-10:1 — and Equipment is used as literal text. Neither of
 * those is visible to a tier-against-tier metric, because the palette was never
 * measured against the surfaces it is painted on.
 *
 * So both constraints are graded, always, together.
 */

/** WCAG 2.x relative luminance. */
export function relativeLuminance(colour) {
  const [r, g, b] = toLinear(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Source-over composite of a translucent colour onto an opaque one.
 *
 * Deliberately in gamma-encoded sRGB, not in linear light. That is wrong as
 * optics and right as a model of the thing being measured: both CSS `rgba()`
 * and canvas 2D blend the encoded bytes, so a 5% white wash is 5% of 255 and
 * not 5% of the linear value. Over the logbook's panel that wash resolves to
 * #111318; composited in linear light the same wash gives #404041, a surface
 * four times brighter than the one the browser actually paints, which would
 * have made this gate fail colours that are fine.
 */
export function over(colour, alpha, backdrop) {
  const bytes = (c) => {
    const n = typeof c === 'number' ? c >>> 0 : parseInt(String(c).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const f = bytes(colour), b = bytes(backdrop);
  const out = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return `#${((out[0] << 16) | (out[1] << 8) | out[2]).toString(16).padStart(6, '0')}`;
}

/** WCAG 2.x contrast ratio, always >= 1 and order-independent. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/*
 * The UI's own black. Every translucent surface below is composited onto it,
 * and that choice is a real limitation rather than a neutral default: in the
 * running game the HUD's panels sit over the 3D scene, and over a lit scene
 * they composite *lighter* and every ratio here falls. This is the darkest
 * backdrop the stylesheet itself specifies, so these numbers are the best case
 * for the translucent surfaces and a statement of fact only for the opaque
 * ones. Bounding the lit case properly needs a scene-luminance measurement
 * this file has no way to take.
 */
const UI_BLACK = '#05070a';

/**
 * Every surface a tier colour is actually painted on, enumerated from
 * `src/ui/hud.css` and `src/ui/Icons.js` rather than assumed.
 *
 * `kind` is which WCAG floor applies, and the distinction is the standard's,
 * not a convenience: 1.4.3 asks 4.5:1 of text, 1.4.11 asks 3:1 of graphical
 * objects. The DOM surfaces carry tier-coloured *type* — `.t-*` sets `color`,
 * and `.book-row-name` inherits it — so they take the text floor. The canvas
 * surfaces carry the plate stroke, the corner ticks, the glyph and the tier
 * mark, which are graphics, so they take the graphic floor.
 *
 * `plateOf` is a function because four of these grounds are the tier's own
 * plate, which differs per tier — a colour partly lighting the surface it then
 * has to be legible against.
 */
/**
 * The third argument to `of` is the ground the translucent surfaces composite
 * onto, and it exists because four of these are `rgba()` over the live 3D
 * frame rather than over anything a stylesheet names (#78). It defaults to
 * `UI_BLACK` — the darkest the stylesheet specifies, and therefore the best
 * case — so every existing caller keeps the numbers it had. Pass a measured
 * scene colour (`tools/panel-ground.mjs`, from the harness's `panelGround`)
 * and the same four surfaces are graded against the lit case instead.
 *
 * The four opaque surfaces ignore it, because they are opaque; that is the
 * whole distinction the ticket turns on, and it is expressed here as which
 * entries read the argument rather than stated in prose.
 */
export const SURFACES = [
  // --- DOM, tier-coloured text -------------------------------------------
  // `.plate`, `.objective`, the inventory strip: `--panel` over the scene.
  { id: 'panel', kind: 'text', translucent: true,
    of: (_p, _c, ground = UI_BLACK) => over('#060a10', 0.58, ground) },
  // `.tip` (the tooltip name is the tier colour) and `.party-chip`.
  { id: 'panel-hard', kind: 'text', translucent: true,
    of: (_p, _c, ground = UI_BLACK) => over('#04070c', 0.86, ground) },
  // `.book-row` in the logbook index, whose name inherits the tier colour, and
  // its hover wash — the lightest ground any tier-coloured type sits on.
  {
    id: 'book-row',
    kind: 'text',
    translucent: true,
    of: (_p, _c, ground = UI_BLACK) => over('#ffffff', 0.018, over('#04070c', 0.86, ground)),
  },
  {
    id: 'book-row-hover',
    kind: 'text',
    translucent: true,
    of: (_p, _c, ground = UI_BLACK) => over('#ffffff', 0.05, over('#04070c', 0.86, ground)),
  },

  // --- canvas, tier-coloured graphics ------------------------------------
  // The icon plate's gradient runs from `mix(plate, #000, 0.15)` at the top to
  // `#05070a` at the bottom; the tier stroke crosses both.
  { id: 'plate-top', kind: 'graphic', of: (plate) => over(plate, 0.85, '#000000') },
  { id: 'plate-floor', kind: 'graphic', of: () => UI_BLACK },
  // The inner glow is 22% of the tier's *own* colour over that gradient, and
  // `itemIcon` draws its glyph in the tier colour right on top of it. A colour
  // lighting the ground it then has to read against is the one surface here
  // that gets worse as the colour gets brighter.
  {
    id: 'plate-glow',
    kind: 'graphic',
    of: (plate, colour) => over(colour, 0.22, over(plate, 0.85, '#000000')),
  },
  // The tier mark's chip is opaque, by design — see `drawTierMark`.
  { id: 'mark-chip', kind: 'graphic', of: () => UI_BLACK },
];

/**
 * WCAG 2.x AA. 4.5:1 for text (1.4.3), 3:1 for graphical objects (1.4.11).
 *
 * Taken as given rather than argued, which is the point of using a standard:
 * these are the numbers a compliance check would apply, so a palette that meets
 * them here meets them anywhere.
 */
export const CONTRAST = { text: 4.5, graphic: 3.0 };

/**
 * Grade a palette against the surfaces it is drawn on.
 *
 * `plates` maps each id to the plate colour behind it, for the four canvas
 * surfaces that need one; an entry without one is graded on the DOM surfaces
 * alone.
 *
 * `scene` is the ground the four translucent surfaces composite onto. It
 * defaults to `UI_BLACK`, which is the best case; pass a measured scene colour
 * to grade the lit case.
 *
 * This is for the tier palette. The elite tints are not passed to it at all —
 * they are painted on lit monsters, not on any surface this repo defines, and
 * a contrast floor against a ground nobody can measure would be a number with
 * nothing behind it.
 */
export function gradeContrast(set, plates = {}, floors = CONTRAST, scene = UI_BLACK) {
  const checks = [];
  for (const [id, colour] of Object.entries(set)) {
    for (const surface of SURFACES) {
      const plate = plates[id];
      if (surface.kind === 'graphic' && !plate) continue;
      const ground = surface.of(plate, colour, scene);
      const ratio = contrastRatio(colour, ground);
      const min = floors[surface.kind];
      checks.push({ id, surface: surface.id, kind: surface.kind, ground, ratio, min, ok: ratio >= min });
    }
  }
  checks.sort((a, b) => (a.ratio - a.min) - (b.ratio - b.min));
  return { ok: checks.every((c) => c.ok), checks };
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
 * `colour` 12 is what those constraints leave, and it is now known to be very
 * close to the most that is available: solved against this bar *and* the WCAG
 * floors in `CONTRAST`, with every hue held saturated, the feasible region is
 * nearly a single point — the shipped palette clears its worst separation pair
 * by 0.2 and its worst contrast surface by 0.09. It is well above the ~5 at
 * which two patches read as "a slightly different shade" of one colour. Pushing
 * it to 15 is possible only by abandoning one of the other two constraints, and
 * the palettes that come back are not the game's: the searches that satisfy 15
 * turn Legendary pink and Boss olive, trading a real identity for a bar with no
 * player behind it. 12 with a mandatory shape is the better exchange, and the
 * shape is not a consolation — it is the channel that survives when colour is
 * gone entirely.
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
 * The same bars for the elite **aura** column, with the colour arm at 10 (#77).
 *
 * This is a lower bar than `PALETTE` and the reason is a ceiling, not a
 * preference. Four of the six aura colours are pinned: `rimebound` by round-5's
 * blow-out tuning, which caps how pale a value that stacks additively over a lit
 * body may be, and `emberclad`, `withering` and `voidtouched` because their hue
 * *is* the affix — fire, rot and the void's magenta — and every search that
 * moved them dragged emberclad toward peach or voidtouched toward pale pink.
 * With those four held and the remaining two free to be anything at all, the
 * best reachable worst pair over all five visions is **emberclad/voidtouched at
 * 10.8 tritanopic** — orange against magenta, and tritanopia collapses the blue
 * channel that separates them. No choice of the free values can lift it, so a
 * bar of 12 here would be a number that cannot be met rather than a standard.
 *
 * `mono` is *not* relaxed. Greyscale collapse is the failure #77 was opened
 * for — `rimebound` and `warded` measured 0.27 apart, one grey wearing two
 * names — and it is the arm a low-vision player actually feels.
 *
 * The aura is also redundancy rather than the primary channel: it is thin
 * additive strokes over a body whose tint already clears the full `PALETTE`
 * bars, and `ELITE`'s bands x bits x orbit signature separates the affixes with
 * no colour at all. `tests/readability-gate` pins the 10.8 ceiling directly, so
 * if the pinned pair ever moves this bar has to be re-argued rather than
 * inherited.
 */
export const AURA = {
  colour: 10,
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
