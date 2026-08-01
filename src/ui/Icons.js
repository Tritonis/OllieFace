// Procedural icon factory.
//
// Every glyph the HUD shows — ability icons, item icons, tier plates — is
// rasterised once into an offscreen canvas and cached as a data-URL, so the
// build ships zero image assets and makes zero network requests.
//
// Art direction: two-tone geometry. A dark angular plate, a single bright
// tier-coloured silhouette, one accent highlight. No gradients inside the
// glyph itself so it stays legible down to 32px.

import { ITEM_BY_ID, drawGlyph } from '../data/items.js';
import { EQUIPMENT_BY_ID } from '../data/equipment.js';

/**
 * One lookup across both catalogues.
 *
 * Equipment is not an item — it never enters the inventory Map and `give`
 * rejects its ids — but it is drawn by exactly the same machinery, and every
 * UI surface that shows a card (inventory strip, pickup banner, death screen,
 * tooltip, the Q slot) would otherwise need to know which of two tables to ask.
 * Asking here instead is what stops an equipment ever rendering as the generic
 * fallback plate, which is the one failure mode that reads as unfinished art.
 */
export function cardDef(id) {
  return ITEM_BY_ID.get(id) ?? EQUIPMENT_BY_ID.get(id) ?? null;
}

const SIZE = 64;

export const TIERS = {
  common:    { label: 'Common',    color: '#e6ecf4', dim: '#8b95a3', plate: '#1b1f26' },
  uncommon:  { label: 'Uncommon',  color: '#63e06a', dim: '#2f7a37', plate: '#14231a' },
  legendary: { label: 'Legendary', color: '#ff5b45', dim: '#8a2b20', plate: '#26120f' },
  boss:      { label: 'Boss',      color: '#ffd44f', dim: '#94742a', plate: '#241d0c' },
  lunar:     { label: 'Lunar',     color: '#5fd9f7', dim: '#2b7d92', plate: '#0e2029' },
  equipment: { label: 'Equipment', color: '#ff9a3c', dim: '#94551c', plate: '#26160b' },
};

export const TIER_ORDER = ['common', 'uncommon', 'legendary', 'boss', 'lunar', 'equipment'];

export function tierMeta(tier) {
  return TIERS[tier] || TIERS.common;
}

/** FNV-1a — stable across reloads so an item id always draws the same icon. */
export function hash(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const cache = new Map();

function cached(key, draw) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d');
  draw(g, SIZE);
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}

export function clearIconCache() { cache.clear(); }

// ---------------------------------------------------------------- primitives

function poly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

function ngon(g, cx, cy, r, n, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  poly(g, pts);
}

function starPath(g, cx, cy, outer, inner, points, rot = 0) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = rot + (i / (points * 2)) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  poly(g, pts);
}

/** Angular cut-corner plate — the shape the whole UI language is built on. */
function platePath(g, s, inset, cut) {
  const a = inset, b = s - inset;
  poly(g, [
    [a + cut, a], [b, a], [b, b - cut], [b - cut, b], [a, b], [a, a + cut],
  ]);
}

// ------------------------------------------------------------------- glyphs

const GLYPHS = [
  // 0 — faceted core
  (g, s, c) => { ngon(g, s / 2, s / 2, s * 0.3, 6, Math.PI / 6); g.fill();
    g.fillStyle = c.deep; ngon(g, s / 2, s / 2, s * 0.14, 6, Math.PI / 6); g.fill(); },
  // 1 — stacked blades
  (g, s) => { for (let i = 0; i < 3; i++) { const y = s * (0.28 + i * 0.17);
    poly(g, [[s * 0.22, y], [s * 0.7, y - s * 0.08], [s * 0.78, y], [s * 0.7, y + s * 0.08]]); g.fill(); } },
  // 2 — ring with break
  (g, s) => { g.lineWidth = s * 0.13; g.beginPath();
    g.arc(s / 2, s / 2, s * 0.27, -Math.PI * 0.62, Math.PI * 1.28); g.stroke();
    g.beginPath(); g.arc(s / 2, s * 0.2, s * 0.075, 0, 7); g.fill(); },
  // 3 — chevron burst
  (g, s) => { g.lineWidth = s * 0.11; g.lineJoin = 'miter';
    for (let i = 0; i < 3; i++) { const o = i * s * 0.15; g.beginPath();
      g.moveTo(s * 0.24, s * 0.22 + o); g.lineTo(s / 2, s * 0.42 + o); g.lineTo(s * 0.76, s * 0.22 + o); g.stroke(); } },
  // 4 — pillar bars
  (g, s, c) => { for (let i = 0; i < 4; i++) { const h = s * (0.2 + (i % 2 ? 0.28 : 0.14));
    g.fillStyle = i % 2 ? c.main : c.deep;
    poly(g, [[s * (0.22 + i * 0.15), s * 0.74], [s * (0.3 + i * 0.15), s * 0.74 - h],
             [s * (0.36 + i * 0.15), s * 0.74 - h], [s * (0.28 + i * 0.15), s * 0.74]]); g.fill(); } },
  // 5 — six-point star
  (g, s, c) => { starPath(g, s / 2, s / 2, s * 0.34, s * 0.13, 6, -Math.PI / 2); g.fill();
    g.fillStyle = c.deep; starPath(g, s / 2, s / 2, s * 0.16, s * 0.06, 6, -Math.PI / 2); g.fill(); },
  // 6 — crescent
  (g, s, c) => { g.beginPath(); g.arc(s / 2, s / 2, s * 0.31, 0, 7); g.fill();
    g.fillStyle = c.plate; g.beginPath(); g.arc(s * 0.62, s * 0.42, s * 0.27, 0, 7); g.fill();
    g.fillStyle = c.main; g.beginPath(); g.arc(s * 0.66, s * 0.7, s * 0.06, 0, 7); g.fill(); },
  // 7 — cross reactor
  (g, s, c) => { const t = s * 0.1;
    g.fillRect(s / 2 - t, s * 0.2, t * 2, s * 0.6);
    g.fillRect(s * 0.2, s / 2 - t, s * 0.6, t * 2);
    g.fillStyle = c.deep; ngon(g, s / 2, s / 2, s * 0.13, 4, Math.PI / 4); g.fill(); },
  // 8 — bolt
  (g, s) => { poly(g, [[s * 0.56, s * 0.16], [s * 0.28, s * 0.54], [s * 0.46, s * 0.54],
    [s * 0.4, s * 0.86], [s * 0.72, s * 0.44], [s * 0.52, s * 0.44]]); g.fill(); },
  // 9 — claw
  (g, s) => { g.lineWidth = s * 0.1; g.lineCap = 'round';
    for (let i = -1; i <= 1; i++) { g.beginPath();
      g.moveTo(s * 0.5 + i * s * 0.2, s * 0.78);
      g.quadraticCurveTo(s * 0.5 + i * s * 0.3, s * 0.4, s * 0.5 + i * s * 0.13, s * 0.16); g.stroke(); } },
  // 10 — vial
  (g, s, c) => { poly(g, [[s * 0.38, s * 0.18], [s * 0.62, s * 0.18], [s * 0.62, s * 0.5],
    [s * 0.74, s * 0.82], [s * 0.26, s * 0.82], [s * 0.38, s * 0.5]]); g.fill();
    g.fillStyle = c.deep; poly(g, [[s * 0.42, s * 0.56], [s * 0.58, s * 0.56], [s * 0.66, s * 0.74], [s * 0.34, s * 0.74]]); g.fill(); },
  // 11 — orbit
  (g, s, c) => { g.lineWidth = s * 0.075; g.beginPath();
    g.ellipse(s / 2, s / 2, s * 0.34, s * 0.15, -0.5, 0, 7); g.stroke();
    g.beginPath(); g.ellipse(s / 2, s / 2, s * 0.34, s * 0.15, 0.5, 0, 7); g.stroke();
    g.fillStyle = c.main; ngon(g, s / 2, s / 2, s * 0.13, 4, 0); g.fill();
    g.fillStyle = c.deep; g.beginPath(); g.arc(s * 0.78, s * 0.36, s * 0.06, 0, 7); g.fill(); },
  // 12 — shard cluster
  (g, s, c) => { poly(g, [[s * 0.5, s * 0.14], [s * 0.72, s * 0.5], [s * 0.5, s * 0.62], [s * 0.28, s * 0.5]]); g.fill();
    g.fillStyle = c.deep; poly(g, [[s * 0.5, s * 0.66], [s * 0.68, s * 0.58], [s * 0.6, s * 0.86], [s * 0.4, s * 0.86], [s * 0.32, s * 0.58]]); g.fill(); },
  // 13 — sensor eye
  (g, s, c) => { poly(g, [[s * 0.16, s * 0.5], [s * 0.5, s * 0.24], [s * 0.84, s * 0.5], [s * 0.5, s * 0.76]]); g.fill();
    g.fillStyle = c.plate; g.beginPath(); g.arc(s / 2, s / 2, s * 0.14, 0, 7); g.fill();
    g.fillStyle = c.main; g.beginPath(); g.arc(s / 2, s / 2, s * 0.07, 0, 7); g.fill(); },
  // 14 — gauntlet
  (g, s, c) => { g.fillRect(s * 0.26, s * 0.44, s * 0.48, s * 0.3);
    for (let i = 0; i < 3; i++) g.fillRect(s * (0.28 + i * 0.16), s * 0.2, s * 0.12, s * 0.22);
    g.fillStyle = c.deep; g.fillRect(s * 0.26, s * 0.56, s * 0.48, s * 0.06); },
  // 15 — spiral drill
  (g, s, c) => { poly(g, [[s * 0.5, s * 0.12], [s * 0.74, s * 0.72], [s * 0.5, s * 0.88], [s * 0.26, s * 0.72]]); g.fill();
    g.fillStyle = c.deep; g.lineWidth = s * 0.055; g.strokeStyle = c.plate;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(s * (0.5 - 0.06 * i), s * (0.24 + 0.15 * i));
      g.lineTo(s * (0.5 + 0.06 * i), s * (0.18 + 0.15 * i)); g.stroke(); } },
];

// ------------------------------------------------------------- public draws

/** The angular tier plate on its own — used as the ability-slot backdrop. */
export function tierFrame(tier) {
  const t = tierMeta(tier);
  return cached(`frame:${tier}`, (g, s) => drawPlate(g, s, t));
}

const PLATE_CUT = 0.22;

/** The tier stroke plus the machined corner ticks, drawn over whatever is
 *  already inside the plate. Shared by `drawPlate` and `itemArt`. */
function plateEdge(g, s, t) {
  const cut = s * PLATE_CUT;
  g.lineWidth = s * 0.045;
  g.strokeStyle = t.color;
  platePath(g, s, 2, cut);
  g.stroke();

  // corner ticks — the small machined detail that sells the sci-fi read
  g.strokeStyle = hexA(t.color, 0.55);
  g.lineWidth = s * 0.03;
  g.beginPath();
  g.moveTo(s * 0.08, s * 0.32); g.lineTo(s * 0.08, s * 0.2);
  g.moveTo(s * 0.92, s * 0.68); g.lineTo(s * 0.92, s * 0.8);
  g.stroke();
}

function drawPlate(g, s, t) {
  const cut = s * PLATE_CUT;
  platePath(g, s, 2, cut);
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, mix(t.plate, '#000000', 0.15));
  grad.addColorStop(1, '#05070a');
  g.fillStyle = grad;
  g.fill();

  // inner tier glow
  const glow = g.createRadialGradient(s / 2, s * 0.42, 0, s / 2, s * 0.42, s * 0.55);
  glow.addColorStop(0, hexA(t.color, 0.22));
  glow.addColorStop(1, hexA(t.color, 0));
  g.fillStyle = glow;
  g.fill();

  plateEdge(g, s, t);
}

/** Item icon: tier plate + a deterministic glyph chosen from the id. */
export function itemIcon(id, tier = 'common') {
  const t = tierMeta(tier);
  return cached(`item:${id}:${tier}`, (g, s) => {
    drawPlate(g, s, t);
    const h = hash(id);
    const glyph = GLYPHS[h % GLYPHS.length];
    const rot = ((h >> 8) % 4) * (Math.PI / 8) - Math.PI / 16;
    const colors = { main: t.color, deep: mix(t.color, '#000000', 0.55), plate: '#06080b' };

    g.save();
    g.translate(s / 2, s / 2);
    g.rotate(rot);
    g.translate(-s / 2, -s / 2);
    g.fillStyle = colors.main;
    g.strokeStyle = colors.main;
    g.lineJoin = 'miter';
    g.lineCap = 'butt';
    glyph(g, s, colors);
    g.restore();
  });
}

const ABILITY_GLYPHS = {
  // M1 — three-round burst
  primary: (g, s) => {
    g.lineWidth = s * 0.09;
    for (let i = 0; i < 3; i++) {
      const x = s * (0.3 + i * 0.2), h = s * (i === 1 ? 0.42 : 0.3);
      poly(g, [[x - s * 0.055, s * 0.72], [x, s * 0.72 - h], [x + s * 0.055, s * 0.72]]);
      g.fill();
    }
  },
  // M2 — charged lance
  secondary: (g, s, c) => {
    poly(g, [[s * 0.5, s * 0.1], [s * 0.66, s * 0.5], [s * 0.5, s * 0.66], [s * 0.34, s * 0.5]]);
    g.fill();
    g.fillStyle = c.deep;
    g.fillRect(s * 0.46, s * 0.62, s * 0.08, s * 0.26);
    g.fillStyle = c.main;
    g.lineWidth = s * 0.06;
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.4, Math.PI * 0.15, Math.PI * 0.85); g.stroke();
  },
  // SHIFT — dash
  utility: (g, s, c) => {
    poly(g, [[s * 0.32, s * 0.2], [s * 0.78, s * 0.5], [s * 0.32, s * 0.8], [s * 0.46, s * 0.5]]);
    g.fill();
    g.fillStyle = c.deep;
    for (let i = 0; i < 3; i++) g.fillRect(s * 0.1, s * (0.32 + i * 0.18), s * (0.2 - i * 0.04), s * 0.055);
  },
  // R — orbital special
  special: (g, s, c) => {
    starPath(g, s / 2, s / 2, s * 0.36, s * 0.12, 4, -Math.PI / 2);
    g.fill();
    g.fillStyle = c.deep;
    g.lineWidth = s * 0.05;
    g.strokeStyle = c.deep;
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.42, 0, 7); g.stroke();
    g.fillStyle = c.main;
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.09, 0, 7); g.fill();
  },
};

/** Ability icons draw transparent — the slot supplies its own frame. */
export function abilityIcon(slot, color = '#dfe9f7') {
  const key = `ability:${slot}:${color}`;
  return cached(key, (g, s) => {
    const colors = { main: color, deep: mix(color, '#000000', 0.45), plate: '#06080b' };
    const draw = ABILITY_GLYPHS[slot] || ABILITY_GLYPHS.primary;
    g.fillStyle = colors.main;
    g.strokeStyle = colors.main;
    g.lineJoin = 'miter';
    draw(g, s, colors);
  });
}

/**
 * The Q-slot card. Identical machinery to an item tile, but it always resolves
 * to the equipment plate — the HUD slot has no tier to pass and should not have
 * to know one.
 */
export function equipmentArt(id) {
  return itemArt(id, 'equipment');
}

/** Fallback for an unknown item id — a neutral question plate. */
export function unknownIcon(tier = 'common') {
  return itemIcon('unknown', tier);
}

/**
 * The game's own item art (`src/data/items.js`), re-plated into the HUD's
 * angular language and re-coloured by tier.
 *
 * Two things had to change about the way `items.js` presents its own icons:
 *
 * 1. **Shape.** `items.js` draws its plate and its border as rounded rects, and
 *    the inventory was the only rounded thing in an interface otherwise built
 *    entirely from chamfers, shears and notched octagons. So the glyph is drawn
 *    here directly, onto this file's chamfered plate — the glyph is what
 *    carries item identity, and nothing else from the source icon is wanted.
 *    (An earlier version blitted the source canvas at 1.3x and clipped the
 *    rounded shapes off the edge, which also scaled the glyph and cropped the
 *    wide ones — burst, snowflake, bars — flush into the tile border.)
 * 2. **Colour.** The source fills each glyph from a hash of its id, which made
 *    a row of same-tier items read as eleven unrelated hues with the tier
 *    carried only by a 2px border. A `color` composite keeps the glyph's
 *    luminosity — its shading, its white outline — and takes hue and saturation
 *    from the tier. Shape carries identity, colour carries tier.
 *
 * The glyph is centred high and sized to leave the bottom-right of the tile
 * free, because that is where the stack count lives (`.item-stack`); at a
 * legible count size the two used to overlap.
 *
 * Ids with no definition fall back to the generic tier plate above.
 */
const ART_CENTRE_Y = 0.41;
const ART_RADIUS = 0.30;

export function itemArt(id, tier = 'common') {
  const item = cardDef(id);
  if (!item) return itemIcon(id, tier);
  // The card knows its own tier; trust it over the caller's guess so an
  // equipment handed in without one still gets its orange plate.
  const resolved = item.tier || tier;
  const t = tierMeta(resolved);
  return cached(`art:${id}:${resolved}`, (g, s) => {
    g.save();
    platePath(g, s, 2, s * PLATE_CUT);
    g.clip();
    // Opaque backdrop first: `color` composites onto whatever is under them,
    // and any transparent pixel inside the clip would take the flat tier fill.
    const grad = g.createRadialGradient(s / 2, s * ART_CENTRE_Y, 0, s / 2, s * ART_CENTRE_Y, s * 0.62);
    grad.addColorStop(0, mix(t.plate, '#ffffff', 0.06));
    grad.addColorStop(1, '#05070a');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);

    g.save();
    g.translate(s / 2, s * ART_CENTRE_Y);
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1.5, s * 0.045);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    drawGlyph(g, item.glyph, s * ART_RADIUS, 0);
    g.restore();

    g.globalCompositeOperation = 'color';
    g.fillStyle = t.color;
    g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'source-over';
    g.restore();

    plateEdge(g, s, t);
  });
}

// -------------------------------------------------------------- colour math

function parseHex(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export function mix(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function hexA(hex, alpha) {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
