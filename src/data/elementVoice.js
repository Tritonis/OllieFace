/**
 * The Effect Language's element recipes, as data.
 *
 * `docs/art/EFFECT-LANGUAGE.md` §1.4 gives each element a timbre recipe and
 * §1.2 gives every effect a core/rim polarity. Both are stated there in prose;
 * this module is the machine-readable form, so that a telegraph, a nova
 * transient and a beam voice for the same element cannot drift apart by being
 * authored three times at three call sites.
 *
 * The element vocabulary is `src/data/damageTypes.js`'s closed seven, not a
 * second one — the language's nine families project onto it (physical lands on
 * `kinetic`, gravity on `void` as the nearest family to its reserved violet,
 * restorative is never a damage element and therefore never reaches here).
 * Growing a parallel taxonomy is exactly the failure `damageTypes.js` was
 * written to avoid.
 */

import { ELEMENT_HUE } from './damageTypes.js';

/**
 * Sustained-rise windup voices (§1.4 `sustained-rise`, [#146 G2]).
 *
 * `f1`/`rise` are read by `Audio.startSustained`: the pitch or the filter
 * cutoff climbs monotonically for the whole of the game state, which is what
 * makes a 1.9s Colossus barrage and a 0.66s scarab lunge different lengths of
 * one grammar rather than two unrelated noises.
 */
export const SUSTAIN = {
  __proto__: null,
  // Bandpass noise 300-2200Hz, slow attack, no tonal partial.
  fire: {
    tones: [], attack: 0.25,
    noise: { type: 'bandpass', freq: 300, freqEnd: 2200, q: 1.4, gain: 0.16 },
  },
  // Noise transient + sine sub. Held, the sub is what carries.
  blast: {
    tones: [{ type: 'sine', f0: 44, f1: 82, gain: 0.16 }], attack: 0.12,
    noise: { type: 'lowpass', freq: 400, freqEnd: 1500, q: 0.8, gain: 0.1 },
  },
  // Square/saw pair, detuned, fast sweep + highpass crackle.
  shock: {
    tones: [
      { type: 'square', f0: 160, f1: 520, gain: 0.075 },
      { type: 'sawtooth', f0: 162, f1: 528, gain: 0.075, detune: 22 },
    ],
    attack: 0.03,
    noise: { type: 'highpass', freq: 2600, freqEnd: 6400, q: 0.9, gain: 0.07 },
  },
  // Triangle high partial + highpass hiss, no sub.
  ice: {
    tones: [{ type: 'triangle', f0: 640, f1: 1180, gain: 0.085 }], attack: 0.18,
    noise: { type: 'highpass', freq: 3200, freqEnd: 7200, q: 0.7, gain: 0.09 },
  },
  // Lowpass square with a slow detune wobble — wet, pitch-unstable.
  nature: {
    tones: [
      { type: 'square', f0: 96, f1: 178, gain: 0.09, detune: -30 },
      { type: 'square', f0: 99, f1: 184, gain: 0.07, detune: 34 },
    ],
    attack: 0.22,
    noise: { type: 'lowpass', freq: 700, freqEnd: 1400, q: 1.2, gain: 0.08 },
  },
  // Sine under a bandpass noise bed, high detune. The pitch of a void windup
  // still rises — it is a windup — but its bed is what identifies it.
  void: {
    tones: [
      { type: 'sine', f0: 70, f1: 132, gain: 0.11 },
      { type: 'sine', f0: 70, f1: 132, gain: 0.09, detune: 46 },
    ],
    attack: 0.2,
    noise: { type: 'bandpass', freq: 480, freqEnd: 1250, q: 2.6, gain: 0.11 },
  },
  // Short noise thump, lowpass, no tonal content — held, it is a scrape.
  kinetic: {
    tones: [], attack: 0.1,
    noise: { type: 'lowpass', freq: 240, freqEnd: 900, q: 0.9, gain: 0.19 },
  },
};

/**
 * The per-element attack transient layered over a shared body (§3 C2). The
 * `explosion` rumble stays common — all novas are novas — and this is the
 * elemental part of the onset.
 */
export const TRANSIENT = {
  __proto__: null,
  fire: { noise: { type: 'bandpass', freq: 1800, freqEnd: 320, q: 1.2, gain: 0.3, dur: 0.3, attack: 0.02 } },
  blast: { tone: { type: 'sine', f0: 130, f1: 38, gain: 0.28, dur: 0.34 }, noise: { type: 'lowpass', freq: 2400, freqEnd: 300, q: 0.8, gain: 0.26, dur: 0.16 } },
  shock: { tone: { type: 'sawtooth', f0: 1500, f1: 240, gain: 0.2, dur: 0.1 }, noise: { type: 'highpass', freq: 5200, freqEnd: 1600, q: 3.5, gain: 0.28, dur: 0.13 } },
  ice: { tone: { type: 'triangle', f0: 2100, f1: 900, gain: 0.16, dur: 0.22 }, noise: { type: 'highpass', freq: 6200, freqEnd: 2600, q: 1.1, gain: 0.22, dur: 0.24 } },
  nature: { tone: { type: 'square', f0: 220, f1: 74, gain: 0.2, dur: 0.26 }, noise: { type: 'lowpass', freq: 1100, freqEnd: 260, q: 1.4, gain: 0.2, dur: 0.2 } },
  void: { tone: { type: 'sine', f0: 300, f1: 46, gain: 0.24, dur: 0.42 }, noise: { type: 'bandpass', freq: 900, freqEnd: 300, q: 2.8, gain: 0.2, dur: 0.34 } },
  kinetic: { noise: { type: 'lowpass', freq: 900, freqEnd: 160, q: 0.9, gain: 0.28, dur: 0.14, attack: 0.001 } },
};

/**
 * Enemy polarity (§1.2): element hue at full chroma in the core, a
 * low-lightness version of the same hue at the rim. Player effects invert it.
 * Returned as plain hex so callers can hand it straight to `spawnBlast`,
 * `spawnTelegraph` or a particle ramp.
 */
export function enemyCore(element) {
  return (ELEMENT_HUE[element] || ELEMENT_HUE.kinetic).tail;
}

export function enemyRim(element) {
  return darken(enemyCore(element), 0.34);
}

/** Multiply every channel, clamped — a low-lightness version of one hue. */
export function darken(hex, k) {
  const r = Math.round(Math.min(255, ((hex >> 16) & 255) * k));
  const g = Math.round(Math.min(255, ((hex >> 8) & 255) * k));
  const b = Math.round(Math.min(255, (hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

/**
 * Hue bucketing, §1.1's rules run mechanically.
 *
 * Enemy attack cards carry a `color` and (mostly) nothing else, so the element
 * of a telegraph has to be recoverable from the colour the card already
 * declares. This is deliberately the audit's own bucketing rule rather than a
 * new hand-written table: a card that changes colour changes element with it,
 * which is the property that keeps the ring, the voice and the blast core
 * agreeing without a second place to edit.
 *
 * **This is not `colourFamily.js`'s `familyOf`, and the two are not
 * interchangeable.** `familyOf` answers the audit's §2.1 *presentation* family
 * and has saturation and lightness gates; this answers which of the closed
 * seven an enemy card belongs to, from hue alone, with every degree assigned to
 * something. The bands differ at the edges on purpose: `familyOf` leaves
 * h 50-70 unbucketed, this one has to put it somewhere. Consequently a player
 * hue routed through here can come back surprising — `ELEMENTS.fire.hue`
 * 0xff7a2a (h 22.5) answers `blast`, `ELEMENTS.physical` answers `blast` too.
 *
 * The governing rule: for a *player* effect the element is the one its
 * `effects.js` row names, and nothing may re-derive it from the hex. This
 * function is for enemy attack cards, which carry a colour and no element, and
 * it should be called on nothing else.
 */
export function elementFromHex(hex) {
  if (!Number.isFinite(hex)) return 'kinetic';
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  // Near-neutral is not an element. Bone-cream, tan and dust all land here,
  // which is what `kinetic` means in this vocabulary.
  if (d < 0.14) return 'kinetic';
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  if (h < 18 || h >= 345) return 'fire';
  if (h < 68) return 'blast';
  if (h < 160) return 'nature';
  if (h < 205) return 'ice';
  if (h < 258) return 'shock';
  return 'void';
}

/**
 * The element of one enemy attack card. Explicit `element` wins, then the
 * status it applies (a burn is fire however it arrived), then the card's own
 * colour, then `kinetic` — which is where every melee card lands, and is
 * correct: a body committing is physical.
 */
export function attackElement(a) {
  if (!a) return 'kinetic';
  if (typeof a.element === 'string') return a.element;
  if (a.status === 'burn') return 'fire';
  if (a.status === 'slow' || a.status === 'freeze') return 'ice';
  if (a.status === 'shock') return 'shock';
  if (a.status === 'void') return 'void';
  if (Number.isFinite(a.color)) return elementFromHex(a.color);
  return 'kinetic';
}
