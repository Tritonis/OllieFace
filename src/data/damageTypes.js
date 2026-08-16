/**
 * Damage types, and the seven ways a hit is allowed to look.
 *
 * `info.type` is an open vocabulary: it is written by hand at ~30 call sites
 * across abilities, items and equipment, and every new item may invent
 * another. It is a *provenance* string ("this came from the missile rack"),
 * not a taxonomy, and presentation cannot key off it directly without
 * silently rendering every future item as whatever the fallback happens to be.
 *
 * So there are two vocabularies. The open one stays where it is; this module
 * owns the closed one — seven read families — and the projection between them.
 * An unmapped type is `kinetic`, which is the family whose colours are exactly
 * the ones the game shipped before any of this existed. That is the property
 * that makes the change safe: an item nobody remapped looks the way it always
 * did, rather than looking wrong.
 *
 * The hues are not new paint. Each family borrows the colour its own affix
 * already owns in `EnemyMeshes.ELITE` — emberclad's aura 0xff6a10, rimebound's
 * aura 0x46c4f0, galvanic's tint 0x325cff, withering's tint 0x0dbd61,
 * voidtouched's tint 0xa400bb — so a fire hit and an Emberclad elite are the
 * same fire, and the game keeps one palette instead of growing a second one for
 * damage. The three tints moved when the affix table was rebuilt for colour
 * vision; these moved with them, because a borrowed colour that stops matching
 * its source is worse than never having borrowed it.
 */

/** The closed set. `kinetic` is first because it is the default. */
export const ELEMENTS = ['kinetic', 'fire', 'ice', 'shock', 'nature', 'void', 'blast'];

/**
 * core  — the hot centre of a spark or a kill burst
 * tail  — what it cools to; this is the hex `VFX.hitSpark` takes
 * ring  — the expanding ring / shockwave colour (Task 5's kill VFX)
 */
export const ELEMENT_HUE = {
  // The shipped values, unchanged. `tail` here is the exact literal that was
  // hardcoded at VFX.js:1169 and `critTail` the exact crit literal beside it.
  // `killCore` / `killTail` / `killFlick` exist on this entry alone. The kill
  // burst, the kill ring and the kill light each carry their own literal in
  // the shipped `_onKill`, and they are not the same literal — the ring is
  // 0xff7030 and the light is 0xff8030. Task 5 reads `killX ?? X`, so the six
  // other families fall back to their own hues and the default death stays
  // byte-identical down to the single channel that differs between those two.
  kinetic: {
    core: 0xfff0c8, tail: 0xffe9b0, critTail: 0xffd24a, ring: 0xff7030,
    killCore: 0xffffff, killTail: 0xff5a20, killFlick: 0xff8030,
  },
  fire:    { core: 0xffe0a8, tail: 0xff6a10, critTail: 0xff3a08, ring: 0xff4a10 },
  ice:     { core: 0xe4f8ff, tail: 0x46c4f0, critTail: 0x8ae8ff, ring: 0x4fb8e8 },
  shock:   { core: 0xe0e8ff, tail: 0x325cff, critTail: 0x74a6ff, ring: 0x4a78ff },
  nature:  { core: 0xe4ffe8, tail: 0x0dbd61, critTail: 0x86ffb4, ring: 0x3fd07a },
  void:    { core: 0xffd0f0, tail: 0xa400bb, critTail: 0xff2fb0, ring: 0xb64ad0 },
  blast:   { core: 0xfff4d0, tail: 0xff9a30, critTail: 0xffc450, ring: 0xffb040 },
};

/**
 * Provenance string -> read family. Anything absent is kinetic; the map is
 * deliberately not exhaustive over the live vocabulary, because it cannot be:
 * the point is that it does not need to be.
 *
 * Null-prototyped so a lookup can only ever answer with something written
 * here: `elementOf('constructor')` on a plain literal would hand presentation
 * a function instead of a family, and "always one of ELEMENTS" is the whole
 * contract this module sells.
 */
const TYPE_ELEMENT = {
  __proto__: null,
  fire: 'fire', meteor: 'fire',
  frost: 'ice',
  lightning: 'shock', overload: 'shock', resonance: 'shock',
  spore: 'nature', swarm: 'nature', thorns: 'nature',
  void: 'void',
  blast: 'blast', missile: 'blast', 'shrapnel-heart': 'blast', sticky: 'blast', gravity: 'blast',
};

/**
 * Status -> read family, used only when the type says nothing. A hit that
 * lights a burn is a fire hit even when it arrived as a plain bullet, which
 * is the case for most of the on-hit item procs.
 */
const STATUS_ELEMENT = { __proto__: null, burn: 'fire', slow: 'ice', shock: 'shock' };

/** Always one of ELEMENTS. Never throws, never returns undefined. */
export function elementOf(type, status) {
  if (typeof type === 'string') {
    const e = TYPE_ELEMENT[type];
    if (e) return e;
  }
  if (typeof status === 'string') {
    const s = STATUS_ELEMENT[status];
    if (s) return s;
  }
  return 'kinetic';
}

/** The single hex `VFX.hitSpark(pos, colour, scale)` wants. */
export function sparkColour(element, crit) {
  const h = ELEMENT_HUE[element] || ELEMENT_HUE.kinetic;
  return crit ? h.critTail : h.tail;
}
