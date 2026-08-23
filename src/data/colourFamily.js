/**
 * The audit's §2.1 colour-family bucketing, as a shared primitive.
 *
 * This used to live inside `tools/bucket-effects.mjs`, which meant only the
 * item table could be checked against it: `src/data/effects.js`'s load-time
 * `assertLanguage()` could not import the rules without a cycle, so the enemy
 * side of the vocabulary — `damageTypes.js`'s `ELEMENT_HUE` and everything
 * `elementVoice.js` derives from it — was invisible to the one guard that
 * exists to catch a reserved hue on a damage surface. That blindness is how a
 * mint-green nature nova shipped. The rules now sit here, under `src/`, and
 * both the tool and the assert read the same copy.
 *
 * The family is always *recomputed from the hex*. A table that declared its own
 * families would only ever prove that it agreed with itself.
 */

/** sRGB hex to HSL, degrees / 0-1 / 0-1. */
export function hsl(hex) {
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
export const RULES = [
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

/**
 * Below this saturation a hex is not spending a hue on anything — it reads as
 * white, bone or ash — and the reservation has nothing to bite on. Pure white
 * buckets as `coral-red` under the rules above (`d === 0`, so `h === 0`); a
 * grey-green would bucket as `mint-green`. Neither is a language violation, so
 * the reserved-hue guard skips them rather than reporting the artefact.
 */
export const CHROMA_FLOOR = 0.2;

/**
 * §1.1's reservation, as a predicate over one hex on one damage surface.
 *
 * Mint-green is reserved for restorative outright. Magenta is reserved for
 * void, which under `effects.js`'s documented narrow reading means void damage
 * may wear it and nothing else may — so the element is part of the question.
 * Returns the offending family name, or `null` if the hue is legal.
 */
export function reservedViolation(hex, element) {
  if (!Number.isFinite(hex)) return null;
  if (hsl(hex).s < CHROMA_FLOOR) return null;
  const family = familyOf(hex);
  if (family === 'mint-green') return family;
  if ((family === 'magenta' || family === 'magenta-violet') && element !== 'void') return family;
  return null;
}

/**
 * The same reservation over a *feedback* surface — something drawn at or for
 * the player rather than at a victim.
 *
 * §1.1 reserves two hues and they are not symmetric. Mint-green is reserved
 * *for* restorative, so a heal, a ward or a shield granted may wear it and a
 * damage surface may not; the predicate above forbids it outright because
 * every surface it walks is a damage surface. Magenta is reserved for void on
 * every surface there is, and a feedback effect is no exception — mistaking a
 * ward for a siphon is exactly the confusion the reservation exists to
 * prevent.
 *
 * So this is the damage predicate with the mint clause lifted and the magenta
 * clause intact. Returns the offending family name, or null.
 */
export function reservedViolationOnFeedback(hex, element) {
  if (!Number.isFinite(hex)) return null;
  if (hsl(hex).s < CHROMA_FLOOR) return null;
  const family = familyOf(hex);
  if ((family === 'magenta' || family === 'magenta-violet') && element !== 'void') return family;
  return null;
}
