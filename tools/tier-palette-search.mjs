// tools/tier-palette-search.mjs
//
// The search behind #140: an eight-colour tier table that clears the readability
// gate's own bars. It imports `tools/colour-vision.mjs` rather than restating
// any of its arithmetic — a second implementation of CIEDE2000 that disagreed
// with the gate's would be worse than none.
//
//   node tools/tier-palette-search.mjs [iterations]
import { deltaEUnder, VISIONS, PALETTE, gradeContrast, gradePalette, lab }
  from './colour-vision.mjs';
import { TIERS } from '../src/ui/Icons.js';

const ORDER = ['common', 'uncommon', 'legendary', 'boss', 'lunar', 'blight', 'equipment', 'argent'];

// The seven-colour table as it stood before #140, written out rather than read
// from `TIERS`. Drift has to be measured from a fixed point: reading the live
// table means every run re-baselines on the previous run's answer, and a search
// that reports "drift 25" from a table already 25 away from the game's is
// reporting nothing. `argent`'s entry is the interim value it shipped with and
// is not counted.
const WAS = {
  common: '#e6ecf4', uncommon: '#3bf695', legendary: '#ff6472', boss: '#d9bf30',
  lunar: '#00c2d0', blight: '#c44fbc', equipment: '#bb7e00', argent: '#8fd7ff',
};

// Hue is identity: players name these tiers by hue, so each may move only
// within +/-6 degrees of where it ships. Lightness and chroma are free inside
// the bands below. Argent is the new one and is given a cold pale band.
const HUE_BAND = 6;
const SPEC = {
  common:    { L: [70, 96], C: [0, 14] },
  uncommon:  { L: [55, 92], C: [45, 90] },
  legendary: { L: [45, 80], C: [42, 90] },
  boss:      { L: [50, 90], C: [45, 95] },
  lunar:     { L: [40, 85], C: [30, 70] },
  blight:    { L: [40, 80], C: [40, 85] },
  equipment: { L: [45, 80], C: [40, 90] },
  // Argent is the new one: silver, cold cast. Its hue anchor is the one free
  // choice in the whole table and is swept from the command line.
  argent:    { L: [55, 92], C: [2, 26], hue: Number(process.env.ARGENT_HUE || 225) },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const srgb = (u) => Math.round(255 * (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055));

/** LCh(ab) -> sRGB hex, D65, with a gamut flag so the search can reject misses. */
function lchToHex(L, C, h) {
  const a = C * Math.cos(h * Math.PI / 180), bb = C * Math.sin(h * Math.PI / 180);
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * f(fx), Y = 1.0 * f(fy), Z = 1.08883 * f(fz);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  const inGamut = lin.every((v) => v > -0.002 && v < 1.002);
  const hex = '#' + lin.map((v) => srgb(clamp(v, 0, 1)).toString(16).padStart(2, '0')).join('');
  return { hex, inGamut };
}

function toLch(hex) {
  const [L, a, b] = lab(hex);
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 };
}

const BASE = Object.fromEntries(ORDER.map((k) => [k, toLch(WAS[k])]));
for (const k of ORDER) if (SPEC[k].hue !== undefined) BASE[k].h = SPEC[k].hue;

// The plates do not move. They are already near-black, they are what the icon
// art is drawn on, and re-cutting them would multiply the visual churn this
// ticket asks for. Argent keeps the plate it shipped with.
const PLATES = Object.fromEntries(ORDER.map((k) => [k, TIERS[k].plate]));

// The bars are floors; these are the targets the search aims at. Solving to the
// floor exactly is how a table ships with a 0.01 cushion that the next edit
// spends without anyone noticing, so the separation arms are pushed to a target
// above their bar and the shortfall below it is what is penalised.
const SEP_T = Number(process.env.SEP_TARGET || PALETTE.colour);
const MONO_T = Number(process.env.MONO_TARGET || PALETTE.mono);
const TEXT_T = Number(process.env.TEXT_TARGET || 5.05);

/**
 * The thinnest cushion any pair holds over its own bar, as a ratio.
 *
 * A ratio and not a difference, because the two arms are not on one scale: 0.5
 * of deltaE over the mono bar of 4 is an eighth of headroom, while 0.5 over the
 * colour bar of 12 is a twenty-fourth. Ranked on the difference the search
 * cheerfully buys mono cushion nobody needed with colour cushion that was the
 * scarce thing. 1.0 is exactly on the bar; 1.04 is four percent clear of it.
 */
function minMargin(set) {
  let m = Infinity, at = null, abs = 0;
  for (let i = 0; i < ORDER.length; i++) for (let j = i + 1; j < ORDER.length; j++) {
    for (const vision of VISIONS) {
      const bar = vision === 'mono' ? PALETTE.mono : PALETTE.colour;
      const d = deltaEUnder(set[ORDER[i]], set[ORDER[j]], vision);
      if (d / bar < m) { m = d / bar; at = ORDER[i] + '/' + ORDER[j] + ' ' + vision; abs = d; }
    }
  }
  return { margin: m, at, delta: abs };
}

/** Does this table clear the gate exactly as the gate asks it? */
function feasible(set) {
  if (minMargin(set).margin < 1) return false;
  for (const scene of ['#05070a', '#ffe662']) {
    if (!gradeContrast(set, PLATES, undefined, scene).ok) return false;
  }
  return true;
}

function cost(set) {
  let v = 0;
  for (let i = 0; i < ORDER.length; i++) for (let j = i + 1; j < ORDER.length; j++) {
    for (const vision of VISIONS) {
      const want = vision === 'mono' ? MONO_T : SEP_T;
      const d = deltaEUnder(set[ORDER[i]], set[ORDER[j]], vision);
      if (d < want) v += (want - d) * 4;
    }
  }
  for (const scene of ['#05070a', '#ffe662']) {
    for (const c of gradeContrast(set, PLATES, undefined, scene).checks) {
      if (!c.ok) v += (c.min - c.ratio) * 30;
      if (c.kind === 'text' && c.ratio < TEXT_T) v += (TEXT_T - c.ratio) * 30;
    }
  }
  return v;
}

/**
 * Which of two feasible tables is the better answer.
 *
 * Min-margin first, drift second, and in that order deliberately. Ranking on
 * drift alone is what shipped a table whose worst pair cleared its bar by 0.01:
 * every such table is feasible, the search has no reason to prefer any of them,
 * and the one it happens to return is a table one rounding away from red.
 * `MARGIN_FLOOR` is how much cushion is worth paying drift for; past it the
 * tables are treated as equally safe and the least-drifted one wins.
 */
const MARGIN_FLOOR = Number(process.env.MARGIN_FLOOR || 1.04);
function better(a, b) {
  const ca = Math.min(a.min, MARGIN_FLOOR), cb = Math.min(b.min, MARGIN_FLOOR);
  if (Math.abs(ca - cb) > 1e-6) return ca > cb;
  return a.drift < b.drift;
}

/** Perceptual drift from the shipping seven; argent is new so it does not count. */
function drift(set) {
  return ORDER.filter((k) => k !== 'argent')
    .reduce((s, k) => s + deltaEUnder(WAS[k], set[k], "normal"), 0);
}

function render(state) {
  return Object.fromEntries(ORDER.map((k) => [k, lchToHex(state[k].L, state[k].C, state[k].h).hex]));
}
const legal = (state) => ORDER.every((k) => lchToHex(state[k].L, state[k].C, state[k].h).inGamut);

function anneal(seed, iters) {
  let rnd = seed;
  const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const state = {};
  for (const k of ORDER) {
    const s = SPEC[k];
    state[k] = {
      L: clamp(BASE[k].L + (rand() - 0.5) * 30, s.L[0], s.L[1]),
      C: clamp(BASE[k].C + (rand() - 0.5) * 30, s.C[0], s.C[1]),
      h: BASE[k].h + (rand() - 0.5) * 2 * HUE_BAND,
    };
  }
  let cur = cost(render(state)) + drift(render(state)) * 0.05;
  let best = null;
  for (let it = 0; it < iters; it++) {
    const T = 3 * (1 - it / iters) + 0.01;
    const k = ORDER[Math.floor(rand() * ORDER.length)];
    const s = SPEC[k], prev = { ...state[k] };
    const step = 1 + T * 3;
    state[k] = {
      L: clamp(prev.L + (rand() - 0.5) * 2 * step, s.L[0], s.L[1]),
      C: clamp(prev.C + (rand() - 0.5) * 2 * step, s.C[0], s.C[1]),
      h: clamp(prev.h + (rand() - 0.5) * step, BASE[k].h - HUE_BAND, BASE[k].h + HUE_BAND),
    };
    if (!legal(state)) { state[k] = prev; continue; }
    const set = render(state);
    const c = cost(set) + drift(set) * 0.05;
    if (c <= cur || rand() < Math.exp((cur - c) / T)) {
      cur = c;
      // Feasibility is judged against the gate's bars; `cost` aims past them
      // and would never reach zero, which is a different question.
      if (feasible(set)) {
        const cand = { set, drift: drift(set), min: minMargin(set).margin };
        if (!best || better(cand, best)) best = cand;
      }
    } else state[k] = prev;
  }
  return best;
}

const iters = Number(process.argv[2] || 40000);
let overall = null;
for (let seed = 1; seed <= 24; seed++) {
  const r = anneal(seed * 7919, iters);
  if (r && (!overall || better(r, overall))) {
    overall = r;
    console.log(`seed ${seed}: min-margin ${r.min.toFixed(2)}, drift ${r.drift.toFixed(1)}`);
  }
}
if (!overall) { console.log('INFEASIBLE over the searched space'); process.exit(1); }
console.log('\nbest table, total drift', overall.drift.toFixed(1));
for (const k of ORDER) {
  console.log(`  ${k.padEnd(10)} ${WAS[k]} -> ${overall.set[k]}  dE ${deltaEUnder(WAS[k], overall.set[k], 'normal').toFixed(1)}`);
}
const gp = gradePalette(overall.set);
console.log('separation worst:', gp.checks[0].id, gp.checks[0].vision, gp.checks[0].delta.toFixed(2), 'vs', gp.checks[0].min);
const plates = PLATES;
const gc = gradeContrast(overall.set, plates, undefined, '#ffe662');
console.log('contrast worst:', gc.checks[0].id, gc.checks[0].surface, gc.checks[0].ratio.toFixed(3), 'vs', gc.checks[0].min);
const wt = gc.checks.filter((c) => c.kind === 'text')[0];
console.log('worst text:', wt.id, wt.surface, wt.ratio.toFixed(3));
