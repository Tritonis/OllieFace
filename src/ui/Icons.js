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
 * One glyph per *ability*, not per slot.
 *
 * Four slot glyphs were enough while there was one survivor. With four of them
 * the M1 tile drew the same three-round burst whether the button fired a
 * carbine, a hammer, a rifle or a rivet gun — i.e. the icon carried the slot,
 * which the key chip under it already says, and carried nothing about the
 * ability. Sixteen shapes, keyed by `ability.id`, so the loadout is readable
 * from the cluster alone.
 *
 * Same two-tone contract as the item glyphs: `c.main` is the survivor's accent,
 * `c.deep` its shaded half. Nothing here draws a plate — the slot supplies one.
 */
const ABILITY_ART = {
  // ---- RANGER — carbine kit, everything is a round in flight -------------
  rangerDoubleTap: (g, s, c) => {
    for (let i = 0; i < 2; i++) {
      const x = s * (0.36 + i * 0.22);
      poly(g, [[x - s * 0.07, s * 0.7], [x, s * 0.26], [x + s * 0.07, s * 0.7]]); g.fill();
    }
    g.fillStyle = c.deep;
    for (let i = 0; i < 2; i++) g.fillRect(s * (0.31 + i * 0.22), s * 0.74, s * 0.1, s * 0.1);
  },
  rangerPhaseRound: (g, s, c) => {
    g.fillStyle = c.deep; g.fillRect(s * 0.1, s * 0.46, s * 0.8, s * 0.08);
    g.fillStyle = c.main;
    poly(g, [[s * 0.5, s * 0.16], [s * 0.72, s * 0.5], [s * 0.5, s * 0.84], [s * 0.28, s * 0.5]]); g.fill();
    g.fillStyle = c.plate;
    poly(g, [[s * 0.5, s * 0.32], [s * 0.62, s * 0.5], [s * 0.5, s * 0.68], [s * 0.38, s * 0.5]]); g.fill();
  },
  rangerTacticalDive: (g, s, c) => {
    poly(g, [[s * 0.34, s * 0.18], [s * 0.82, s * 0.5], [s * 0.34, s * 0.82], [s * 0.48, s * 0.5]]); g.fill();
    g.fillStyle = c.deep;
    for (let i = 0; i < 3; i++) g.fillRect(s * 0.08, s * (0.31 + i * 0.19), s * (0.22 - i * 0.05), s * 0.06);
  },
  rangerSalvo: (g, s, c) => {
    for (let i = 0; i < 4; i++) {
      const x = s * (0.22 + i * 0.19), y = s * (0.2 + Math.abs(i - 1.5) * 0.09);
      poly(g, [[x, y], [x + s * 0.09, y + s * 0.16], [x - s * 0.05, y + s * 0.16]]); g.fill();
      g.fillStyle = c.deep; g.fillRect(x - s * 0.03, y + s * 0.18, s * 0.05, s * 0.3); g.fillStyle = c.main;
    }
  },

  // ---- ANVIL — mass, contact, everything happens at arm's length --------
  anvilSweep: (g, s, c) => {
    g.lineWidth = s * 0.16; g.lineCap = 'butt';
    g.beginPath(); g.arc(s * 0.24, s * 0.5, s * 0.44, -Math.PI * 0.42, Math.PI * 0.42); g.stroke();
    g.fillStyle = c.deep;
    poly(g, [[s * 0.1, s * 0.36], [s * 0.34, s * 0.5], [s * 0.1, s * 0.64]]); g.fill();
  },
  anvilSlam: (g, s, c) => {
    g.fillRect(s * 0.44, s * 0.12, s * 0.12, s * 0.42);
    poly(g, [[s * 0.24, s * 0.12], [s * 0.76, s * 0.12], [s * 0.68, s * 0.3], [s * 0.32, s * 0.3]]); g.fill();
    g.fillStyle = c.deep;
    for (let i = 0; i < 3; i++) {
      const w = s * (0.2 + i * 0.13);
      g.fillRect(s * 0.5 - w / 2, s * (0.62 + i * 0.11), w, s * 0.055);
    }
  },
  anvilBreach: (g, s, c) => {
    poly(g, [[s * 0.12, s * 0.3], [s * 0.58, s * 0.5], [s * 0.12, s * 0.7], [s * 0.24, s * 0.5]]); g.fill();
    g.fillStyle = c.deep;
    starPath(g, s * 0.72, s * 0.5, s * 0.26, s * 0.08, 5, -Math.PI / 2); g.fill();
  },
  anvilBulwark: (g, s, c) => {
    poly(g, [[s * 0.5, s * 0.14], [s * 0.82, s * 0.3], [s * 0.78, s * 0.66],
             [s * 0.5, s * 0.88], [s * 0.22, s * 0.66], [s * 0.18, s * 0.3]]); g.fill();
    g.fillStyle = c.plate;
    g.lineWidth = s * 0.05; g.strokeStyle = c.plate;
    for (let i = -1; i <= 1; i++) {
      g.beginPath(); g.moveTo(s * (0.5 + i * 0.18), s * 0.22); g.lineTo(s * (0.5 + i * 0.1), s * 0.8); g.stroke();
    }
  },

  // ---- KESTREL — optics, windups, one committed shot --------------------
  kestrelMark: (g, s, c) => {
    g.lineWidth = s * 0.07; g.beginPath(); g.arc(s / 2, s / 2, s * 0.3, 0, 7); g.stroke();
    g.fillStyle = c.deep;
    g.fillRect(s * 0.48, s * 0.06, s * 0.04, s * 0.2);
    g.fillRect(s * 0.48, s * 0.74, s * 0.04, s * 0.2);
    g.fillRect(s * 0.06, s * 0.48, s * 0.2, s * 0.04);
    g.fillRect(s * 0.74, s * 0.48, s * 0.2, s * 0.04);
    g.fillStyle = c.main; ngon(g, s / 2, s / 2, s * 0.1, 4, 0); g.fill();
  },
  kestrelLance: (g, s, c) => {
    poly(g, [[s * 0.88, s * 0.5], [s * 0.42, s * 0.36], [s * 0.42, s * 0.64]]); g.fill();
    g.fillStyle = c.deep;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(s * (0.32 - i * 0.09), s * 0.5, s * (0.075 - i * 0.018), 0, 7); g.fill(); }
  },
  kestrelVault: (g, s, c) => {
    g.lineWidth = s * 0.1; g.lineJoin = 'miter';
    for (let i = 0; i < 3; i++) {
      const y = s * (0.34 + i * 0.19);
      g.strokeStyle = i ? c.deep : c.main;
      g.beginPath(); g.moveTo(s * 0.24, y + s * 0.16); g.lineTo(s * 0.5, y); g.lineTo(s * 0.76, y + s * 0.16); g.stroke();
    }
  },
  kestrelEclipse: (g, s, c) => {
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.3, 0, 7); g.fill();
    g.fillStyle = c.plate; g.beginPath(); g.arc(s * 0.4, s * 0.42, s * 0.24, 0, 7); g.fill();
    g.strokeStyle = c.deep; g.lineWidth = s * 0.045;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      g.beginPath();
      g.moveTo(s / 2 + Math.cos(a) * s * 0.36, s / 2 + Math.sin(a) * s * 0.36);
      g.lineTo(s / 2 + Math.cos(a) * s * 0.46, s / 2 + Math.sin(a) * s * 0.46);
      g.stroke();
    }
  },

  // ---- ROOK — hardware you leave behind you -----------------------------
  rookRivet: (g, s, c) => {
    for (let i = 0; i < 3; i++) {
      const x = s * (0.24 + i * 0.24);
      g.fillRect(x - s * 0.05, s * 0.34, s * 0.1, s * 0.22);
      g.fillStyle = c.deep;
      poly(g, [[x - s * 0.05, s * 0.34], [x + s * 0.05, s * 0.34], [x, s * 0.2]]); g.fill();
      g.fillStyle = c.main;
    }
  },
  rookMines: (g, s, c) => {
    for (let i = 0; i < 3; i++) {
      const x = s * (0.26 + i * 0.24), y = s * (0.6 - (i === 1 ? 0.14 : 0));
      ngon(g, x, y, s * 0.11, 6, Math.PI / 6); g.fill();
      g.strokeStyle = c.deep; g.lineWidth = s * 0.035;
      g.beginPath(); g.arc(x, y, s * 0.19, -Math.PI * 0.85, -Math.PI * 0.15); g.stroke();
    }
  },
  rookWard: (g, s, c) => {
    g.lineWidth = s * 0.07;
    g.beginPath(); g.arc(s / 2, s * 0.72, s * 0.34, Math.PI, 0); g.stroke();
    g.fillStyle = c.deep;
    g.beginPath(); g.arc(s / 2, s * 0.72, s * 0.15, Math.PI, 0); g.fill();
    g.strokeStyle = c.deep; g.lineWidth = s * 0.04;
    g.beginPath(); g.arc(s / 2, s * 0.72, s * 0.47, Math.PI, 0); g.stroke();
    g.fillStyle = c.main; g.fillRect(s * 0.14, s * 0.72, s * 0.72, s * 0.05);
  },
  rookTurret: (g, s, c) => {
    g.fillRect(s * 0.34, s * 0.34, s * 0.3, s * 0.22);
    g.fillRect(s * 0.62, s * 0.4, s * 0.28, s * 0.08);
    g.fillStyle = c.deep;
    poly(g, [[s * 0.46, s * 0.56], [s * 0.54, s * 0.56], [s * 0.72, s * 0.86], [s * 0.28, s * 0.86]]); g.fill();
    g.fillStyle = c.main; g.beginPath(); g.arc(s * 0.44, s * 0.3, s * 0.07, 0, 7); g.fill();
  },
};

/**
 * The icon for a specific ability, tinted with the survivor's accent.
 *
 * Falls back to the slot glyph for anything without art, so a survivor added
 * tomorrow renders a sensible tile rather than an empty one.
 */
export function abilityArt(id, slot = 'primary', color = '#dfe9f7') {
  const draw = ABILITY_ART[id];
  if (!draw) return abilityIcon(slot, color);
  return cached(`abil:${id}:${color}`, (g, s) => {
    const colors = { main: color, deep: mix(color, '#000000', 0.5), plate: '#06080b' };
    g.fillStyle = colors.main;
    g.strokeStyle = colors.main;
    g.lineJoin = 'miter';
    g.lineCap = 'butt';
    draw(g, s, colors);
  });
}

/** `0xff7a3d` (survivor cards carry numbers, CSS wants a string). */
export function hexOf(n, fallback = '#dfe9f7') {
  return Number.isFinite(n) ? `#${(n >>> 0).toString(16).padStart(6, '0')}` : fallback;
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
// Round 4 (D6/N7) measured the stack count still sitting across the glyph on
// every wide emblem — the comment in `hud.css` claimed this corner was reserved
// and the geometry did not reserve it. Lifting the centre and shrinking the
// radius is the fix that review specified.
const ART_CENTRE_Y = 0.38;
const ART_RADIUS = 0.27;

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

// --------------------------------------------------------------- rule marks
//
// Artifacts and difficulties used to carry a raw Unicode codepoint each —
// `⌘ † ⁂ ◈ ❖ ♛ ⟁ ☂ ☁ ⛈`, from six different Unicode blocks, none of them
// present in the `--font` stack. Every one fell through to the OS symbol font,
// so the artifact grid was drawn by Segoe UI Symbol in a game whose 95 item
// glyphs are authored vectors; the three weather codepoints are additionally
// emoji-presentation and rendered in *colour* on Windows. Worse, `.art-mark`
// inherited each fallback font's metrics, which pushed four sibling card titles
// in one grid row onto three baselines spanning 15px.
//
// These are the same drawings, authored here, in the same language as every
// other icon in the build: a filled accent silhouette under a white stroke,
// centred, sized to a fixed box. No text glyph is used as an icon anywhere.

/** Shared cloud shoulder — the three difficulty marks are one family. */
function cloud(g, s) {
  const y = s * 0.42;
  g.beginPath();
  g.moveTo(s * 0.18, y + s * 0.1);
  g.bezierCurveTo(s * 0.06, y + s * 0.1, s * 0.08, y - s * 0.12, s * 0.22, y - s * 0.1);
  g.bezierCurveTo(s * 0.26, y - s * 0.3, s * 0.58, y - s * 0.34, s * 0.62, y - s * 0.12);
  g.bezierCurveTo(s * 0.8, y - s * 0.18, s * 0.88, y + s * 0.1, s * 0.72, y + s * 0.1);
  g.closePath();
  g.fill(); g.stroke();
}

/** Vertical rain stroke, used by drizzle/rainstorm/monsoon at three densities. */
function rain(g, s, x, y0, y1) {
  g.beginPath(); g.moveTo(s * x, s * y0); g.lineTo(s * (x - 0.03), s * y1); g.stroke();
}

const MARKS = {
  // Edict — a decree between two brackets, with the pick already made.
  command: (g, s) => {
    g.beginPath();
    g.moveTo(s * 0.3, s * 0.16); g.lineTo(s * 0.16, s * 0.16);
    g.lineTo(s * 0.16, s * 0.84); g.lineTo(s * 0.3, s * 0.84);
    g.moveTo(s * 0.7, s * 0.16); g.lineTo(s * 0.84, s * 0.16);
    g.lineTo(s * 0.84, s * 0.84); g.lineTo(s * 0.7, s * 0.84);
    g.stroke();
    poly(g, [[s * 0.32, s * 0.34], [s * 0.68, s * 0.34], [s * 0.5, s * 0.7]]);
    g.fill(); g.stroke();
  },
  // Tithe — an offering bowl, and the drop that has to fall into it.
  sacrifice: (g, s) => {
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.12);
    g.quadraticCurveTo(s * 0.66, s * 0.3, s * 0.5, s * 0.42);
    g.quadraticCurveTo(s * 0.34, s * 0.3, s * 0.5, s * 0.12);
    g.fill(); g.stroke();
    g.beginPath();
    g.moveTo(s * 0.16, s * 0.54); g.lineTo(s * 0.84, s * 0.54);
    g.quadraticCurveTo(s * 0.78, s * 0.86, s * 0.5, s * 0.86);
    g.quadraticCurveTo(s * 0.22, s * 0.86, s * 0.16, s * 0.54);
    g.closePath(); g.fill(); g.stroke();
  },
  // Spate — a wedge of arrivals, not one of them.
  swarms: (g, s) => {
    const tri = (x, y, k) => {
      poly(g, [[s * x, s * (y - 0.11 * k)], [s * (x + 0.1 * k), s * (y + 0.08 * k)],
               [s * (x - 0.1 * k), s * (y + 0.08 * k)]]);
      g.fill(); g.stroke();
    };
    tri(0.5, 0.24, 1.05);
    tri(0.28, 0.5, 1.05); tri(0.72, 0.5, 1.05);
    tri(0.39, 0.76, 1.05); tri(0.61, 0.76, 1.05);
  },
  // Filament — drawn out thin, and already cracking.
  glass: (g, s) => {
    poly(g, [[s * 0.5, s * 0.1], [s * 0.64, s * 0.5], [s * 0.5, s * 0.9], [s * 0.36, s * 0.5]]);
    g.fill(); g.stroke();
    g.save();
    g.strokeStyle = '#06080b';
    g.lineWidth = Math.max(1.5, s * 0.05);
    g.beginPath();
    g.moveTo(s * 0.44, s * 0.28); g.lineTo(s * 0.56, s * 0.44);
    g.lineTo(s * 0.44, s * 0.58); g.lineTo(s * 0.56, s * 0.74);
    g.stroke();
    g.restore();
  },
  // Caprice — a die mid-roll. The label was never load-bearing.
  caprice: (g, s) => {
    poly(g, [[s * 0.5, s * 0.12], [s * 0.86, s * 0.32], [s * 0.86, s * 0.68],
             [s * 0.5, s * 0.88], [s * 0.14, s * 0.68], [s * 0.14, s * 0.32]]);
    g.fill(); g.stroke();
    g.beginPath();
    g.moveTo(s * 0.14, s * 0.32); g.lineTo(s * 0.5, s * 0.52); g.lineTo(s * 0.86, s * 0.32);
    g.moveTo(s * 0.5, s * 0.52); g.lineTo(s * 0.5, s * 0.88);
    g.stroke();
    g.save();
    g.fillStyle = '#06080b';
    for (const [x, y] of [[0.31, 0.66], [0.69, 0.66], [0.5, 0.34]]) {
      g.beginPath(); g.arc(s * x, s * y, s * 0.055, 0, 7); g.fill();
    }
    g.restore();
  },
  // Regalia — a field of crowns, and not one of them yours.
  honour: (g, s) => {
    poly(g, [[s * 0.14, s * 0.66], [s * 0.14, s * 0.22], [s * 0.32, s * 0.44],
             [s * 0.5, s * 0.16], [s * 0.68, s * 0.44], [s * 0.86, s * 0.22],
             [s * 0.86, s * 0.66]]);
    g.fill(); g.stroke();
    g.beginPath();
    g.moveTo(s * 0.14, s * 0.72); g.lineTo(s * 0.86, s * 0.72);
    g.lineTo(s * 0.86, s * 0.84); g.lineTo(s * 0.14, s * 0.84);
    g.closePath(); g.fill(); g.stroke();
  },
  // Mimicry — what you picked up, learned and handed back.
  evolution: (g, s) => {
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.86); g.lineTo(s * 0.5, s * 0.56);
    g.moveTo(s * 0.5, s * 0.56); g.lineTo(s * 0.24, s * 0.36);
    g.moveTo(s * 0.5, s * 0.56); g.lineTo(s * 0.76, s * 0.36);
    g.stroke();
    for (const x of [0.24, 0.76]) {
      const d = x < 0.5 ? 1 : -1;
      poly(g, [[s * x, s * 0.14], [s * (x + 0.14 * d), s * 0.34], [s * (x - 0.02 * d), s * 0.38]]);
      g.fill(); g.stroke();
    }
  },
  // ---- difficulties: one cloud, three weathers -------------------------
  drizzle: (g, s) => {
    cloud(g, s);
    rain(g, s, 0.5, 0.62, 0.8);
  },
  rainstorm: (g, s) => {
    cloud(g, s);
    rain(g, s, 0.3, 0.6, 0.82);
    rain(g, s, 0.5, 0.64, 0.88);
    rain(g, s, 0.7, 0.6, 0.82);
  },
  monsoon: (g, s) => {
    cloud(g, s);
    rain(g, s, 0.24, 0.6, 0.84);
    rain(g, s, 0.78, 0.6, 0.84);
    poly(g, [[s * 0.56, s * 0.54], [s * 0.38, s * 0.76], [s * 0.5, s * 0.76],
             [s * 0.44, s * 0.94], [s * 0.64, s * 0.7], [s * 0.52, s * 0.7]]);
    g.fill(); g.stroke();
  },
};

/**
 * A rule mark — one artifact or one difficulty — as a transparent data-URL.
 *
 * Transparent because the card supplies its own plate and its own accent
 * keyline; a second plate inside it would read as a tile pasted on a card.
 * Returns `null` for an unknown key so a caller can fall back rather than draw
 * an empty box.
 */
export function markIcon(key, color = '#dfe9f7') {
  const draw = MARKS[key];
  if (!draw) return null;
  return cached(`mark:${key}:${color}`, (g, s) => {
    g.fillStyle = color;
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1.5, s * 0.042);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    draw(g, s);
  });
}

export function hasMark(key) { return !!MARKS[key]; }

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
