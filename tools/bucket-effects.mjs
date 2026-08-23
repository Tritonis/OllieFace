/**
 * The audit's §2.1 bucketing rules, re-run over the re-authored surface.
 *
 * `.superpowers/sdd/legible-effects/audit.md` §2.1 defines a Collision
 * mechanically: two effects sharing **all four** of colour family, frame
 * family, motion character and audio envelope family occupy the same point in
 * the Effect Language and are, by construction, indistinguishable by the
 * dimensions that are supposed to separate them. `NONE`/`NONE` counts as a
 * shared audio family — that is the worst kind of match, not an exemption.
 *
 * The colour family is recomputed here from the hex, by the audit's own HSL
 * rules, rather than trusted from the table. That is the point: it means an
 * element hue cannot drift out of its band without this saying so, and it means
 * the check is comparable to the audit's baseline instead of being a new
 * measurement that happens to agree with itself.
 *
 * Usage:
 *   node tools/bucket-effects.mjs          list every collision group
 *   node tools/bucket-effects.mjs --check  exit non-zero if a named group re-forms
 *
 * `--check` is the arm that can fail. It asserts that the five collision groups
 * this wave was written to resolve — C1, C7, C8, C9, C10 — have separated: no
 * two members of a group may still share all four dimensions.
 */

import { allEffects, ELEMENTS } from '../src/data/effects.js';

// ------------------------------------------------------- audit §2.1 colour

/** sRGB hex to HSL, degrees / 0-1 / 0-1. */
function hsl(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

/**
 * The audit's table, in order. First match wins, exactly as a hand re-run of
 * the rules would read them top to bottom.
 */
const RULES = [
  ['bone-cream',      (c) => c.h >= 30 && c.h <= 50 && c.s < 0.40 && c.l > 0.75],
  ['ember-orange',    (c) => c.h >= 10 && c.h <= 30 && c.s > 0.7 && c.l >= 0.35 && c.l <= 0.60],
  ['tan-brown',       (c) => c.h >= 25 && c.h <= 45 && c.s >= 0.3 && c.s <= 0.6 && c.l >= 0.45 && c.l <= 0.70],
  ['earth-brown',     (c) => c.h >= 25 && c.h <= 45 && c.s < 0.35 && c.l < 0.45],
  ['amber-warm',      (c) => c.h >= 25 && c.h <= 50 && c.l > 0.60],
  ['coral-red',       (c) => c.h >= 0 && c.h <= 15 && c.l > 0.55],
  ['crimson-red',     (c) => c.h >= 335 && c.s > 0.7],
  ['pink-rose',       (c) => (c.h >= 340 || c.h <= 10) && c.s >= 0.5 && c.l > 0.65],
  ['magenta',         (c) => c.h >= 300 && c.h <= 330 && c.s > 0.6],
  ['magenta-violet',  (c) => c.h >= 285 && c.h < 300 && c.s > 0.7],
  ['violet',          (c) => c.h >= 255 && c.h < 285],
  ['periwinkle-blue', (c) => c.h >= 220 && c.h <= 235],
  ['ice-blue',        (c) => c.h >= 185 && c.h <= 215],
  ['mint-green',      (c) => c.h >= 140 && c.h <= 175],
  ['acid-green',      (c) => c.h >= 70 && c.h <= 110],
];

export function familyOf(hex) {
  const c = hsl(hex);
  for (const [name, rule] of RULES) if (rule(c)) return name;
  return `unbucketed(h=${c.h.toFixed(1)} s=${c.s.toFixed(2)} l=${c.l.toFixed(2)})`;
}

// -------------------------------------------------------------- the re-run

/** The groups this wave was written to resolve, by their audit names. */
const GROUPS = {
  C1: ['copper-wire', 'cracked-zither', 'arc-capacitor', 'spark-plug',
       'arc-rot', 'quicksilver-vein', 'squall-charm'],
  C7: ['leaking-jerrycan', 'warlock-ember', 'emberwake'],
  C8: ['frostbite-canister', 'aegis-emitter'],
  C9: ['prism-splinter', 'hive-gland', 'mourners-dagger'],
  C10: ['bile-shell', 'missile-rack'],
};

function point(row) {
  const declared = ELEMENTS[row.element].family;
  const measured = familyOf(ELEMENTS[row.element].hue);
  return {
    id: row.id,
    colour: measured,
    drift: measured !== declared ? declared : null,
    frame: row.frame,
    motion: row.motion,
    envelope: row.envelope,
    key: [measured, row.frame, row.motion, row.envelope].join(' · '),
  };
}

export function buckets() {
  const rows = allEffects().map(point);
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  return { rows, byKey };
}

function main() {
  const check = process.argv.includes('--check');
  const { rows, byKey } = buckets();
  let failed = 0;

  // An element hue that no longer lands in its own §1.1 family is a language
  // defect on its own, before any grouping question.
  for (const r of rows) {
    if (r.drift) {
      console.error(`DRIFT  ${r.id}: hue buckets as ${r.colour}, table declares ${r.drift}`);
      failed++;
    }
  }

  const groups = [...byKey.entries()].filter(([, m]) => m.length > 1);
  console.log(`${rows.length} rows, ${byKey.size} distinct points, ${groups.length} shared points.\n`);
  for (const [key, members] of groups.sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  [${members.length}] ${key}`);
    console.log(`        ${members.map((m) => m.id).join(', ')}`);
  }

  console.log('\nNamed groups:');
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [name, ids] of Object.entries(GROUPS)) {
    const present = ids.map((id) => byId.get(id)).filter(Boolean);
    const seen = new Map();
    const clashes = [];
    for (const r of present) {
      if (seen.has(r.key)) clashes.push(`${seen.get(r.key)} = ${r.id} (${r.key})`);
      else seen.set(r.key, r.id);
    }
    const missing = ids.filter((id) => !byId.has(id));
    if (clashes.length) {
      console.log(`  ${name}: STILL COLLIDING — ${clashes.join('; ')}`);
      failed++;
    } else {
      console.log(`  ${name}: separated — ${present.length}/${ids.length} rows on ${seen.size} distinct points`
        + (missing.length ? ` (not on this surface: ${missing.join(', ')})` : ''));
    }
  }

  if (check && failed) {
    console.error(`\n${failed} failure(s).`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('bucket-effects.mjs')) main();
