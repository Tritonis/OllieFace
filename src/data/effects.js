/**
 * The Effect Language, as data.
 *
 * `docs/art/EFFECT-LANGUAGE.md` says what each dimension of a player-facing
 * effect *means*. This file is the machine-readable half of that document for
 * the item and equipment surface: one row per effect, naming its four
 * dimensions — colour (element hue, §1.1), frame family (§1.3), motion
 * character and audio envelope family (§1.4) — plus the code that actually
 * emits them.
 *
 * The table is load-bearing, not documentation. `cue()` below reads it to draw
 * and to speak, and `tools/bucket-effects.mjs` re-runs the audit's §2.1
 * bucketing rules over the same rows. That is deliberate: a conformance check
 * that read a second, hand-kept copy of the assignments would only ever prove
 * that the copy agreed with itself.
 *
 * Two hard rules from §1.1 are enforced in `assertLanguage()` at module load,
 * because a violation of either is a language failure rather than a bug:
 * mint-green and magenta are reserved and may never be spent on damage.
 *
 * **Audio.** Everything here is procedural synthesis through the two public
 * doors `Audio` offers — `play(name, pos)` for the shared voices and
 * `startSustained(pos, recipe)` for everything else. A burst is a sustained
 * voice released the instant it starts: `startSustained`'s `attack` is the
 * onset and `release(fade)` is the decay, so an attack/decay envelope needs no
 * timer and no new primitive. That is what lets a family like `plucked-tonal`
 * (immediate onset, 450 ms free decay, fixed pitch, no noise bed) be expressed
 * as a *family* rather than as a texture description — see §1.4, which promoted
 * exactly that distinction so a bucketing re-run could see it.
 */

// ------------------------------------------------------------------ elements

/**
 * §1.1's element table. Each hue is chosen to land in its own §2.1 colour
 * family under the HSL bucketing rules — `tools/bucket-effects.mjs` recomputes
 * the family from the hex and objects if one drifts out of its band, so these
 * are not free-floating taste values.
 *
 * `damage: false` marks the two reserved hues. Nothing that hurts anything may
 * name them.
 */
export const ELEMENTS = {
  fire:        { hue: 0xff7a2a, family: 'ember-orange' },
  blast:       { hue: 0xffc46a, family: 'amber-warm' },
  shock:       { hue: 0x6f8cff, family: 'periwinkle-blue' },
  frost:       { hue: 0x9fe8ff, family: 'ice-blue' },
  toxic:       { hue: 0x9be035, family: 'acid-green' },
  restorative: { hue: 0x74ffc8, family: 'mint-green', damage: false },
  gravity:     { hue: 0x9b5cff, family: 'violet' },
  // Magenta is listed as reserved alongside mint-green in §1.1, but §3's C9
  // resolution then assigns it to `mourners-dagger` — a kill-triggered damage
  // proc — on the grounds that its fiction is void, and §4.3 does the same for
  // `withering`'s denial. The two passages cannot both be read literally. The
  // narrow reading is taken here: the reservation forbids spending a reserved
  // hue on something that is *not* its element, and only mint-green is
  // elaborated ("a mint-green damage effect is a language violation regardless
  // of how it is authored"). Void damage may therefore be magenta; a fire proc
  // may not. Flagged rather than silently resolved.
  void:        { hue: 0xff5fd0, family: 'magenta' },
  physical:    { hue: 0xd8b06a, family: 'tan-brown' },
  bone:        { hue: 0xe8ded0, family: 'bone-cream' },
};

/** §1.4's three intensity steps. Motion and audio must agree on one of them. */
export const STEPS = ['tick', 'event', 'heavy'];

// -------------------------------------------------------------------- voices

/**
 * The element timbre recipes of §1.4, expressed as `startSustained` arguments.
 *
 * `hold` is the decay handed to `release()`; `attack` is the onset. Together
 * they are the envelope, and the envelope family each recipe belongs to is
 * named on the row that uses it, never here — element and envelope are
 * independent axes (see C10, where two toxic effects sit in different envelope
 * families).
 */
const RECIPES = {
  // bandpass noise, slow attack, no tonal partial
  fire: (f) => ({ tones: [], noise: { type: 'bandpass', freq: 900 * f, q: 0.7, gain: 0.22 } }),
  // noise transient + sine sub, fast attack, long tail
  blast: (f) => ({
    tones: [{ type: 'sine', f0: 62 * f, gain: 0.30 }],
    noise: { type: 'lowpass', freq: 1800 * f, q: 0.6, gain: 0.20 },
  }),
  // square/saw pair, detuned, plus highpass crackle
  shock: (f) => ({
    tones: [{ type: 'square', f0: 620 * f, gain: 0.09 },
            { type: 'sawtooth', f0: 624 * f, detune: 22, gain: 0.09 }],
    noise: { type: 'highpass', freq: 3400, q: 0.5, gain: 0.10 },
  }),
  // triangle high partial + highpass hiss, no sub
  frost: (f) => ({
    tones: [{ type: 'triangle', f0: 1480 * f, gain: 0.11 }],
    noise: { type: 'highpass', freq: 5200, q: 0.4, gain: 0.13 },
  }),
  // lowpass square, detuned, wet and pitch-unstable
  toxic: (f) => ({
    tones: [{ type: 'square', f0: 138 * f, gain: 0.13 },
            { type: 'square', f0: 138 * f, detune: -34, gain: 0.11 }],
    noise: { type: 'lowpass', freq: 700, q: 1.6, gain: 0.09 },
  }),
  // pure sine ladder
  restorative: (f) => ({
    tones: [{ type: 'sine', f0: 523 * f, gain: 0.10 },
            { type: 'sine', f0: 784 * f, gain: 0.07 }],
  }),
  // sine pair detuned ~7Hz, no noise
  gravity: (f) => ({
    tones: [{ type: 'sine', f0: 96 * f, gain: 0.18 },
            { type: 'sine', f0: 103 * f, gain: 0.16 }],
  }),
  // sine under a bandpass noise bed, high detune
  void: (f) => ({
    tones: [{ type: 'sine', f0: 172 * f, gain: 0.14, detune: -48 }],
    noise: { type: 'bandpass', freq: 2100, q: 2.2, gain: 0.10 },
  }),
  // short noise thump, lowpass, no tonal content
  physical: (f) => ({ tones: [], noise: { type: 'lowpass', freq: 420 * f, q: 0.8, gain: 0.24 } }),
};
// Bone is the physical family's pale member and shares its timbre.
RECIPES.bone = RECIPES.physical;

/**
 * The thirteen envelope families of §1.4, as (attack, decay) pairs.
 *
 * `NONE` is present and is not a shortcut: a row that names it is declaring
 * silence, which the bucketing re-run treats as the worst kind of match rather
 * than as an exemption.
 */
export const ENVELOPES = {
  'pip':                 { attack: 0.003, hold: 0.05 },
  'tick-thump':          { attack: 0.002, hold: 0.09 },
  'crack-body':          { attack: 0.002, hold: 0.20 },
  'crack-tonal-fall':    { attack: 0.003, hold: 0.34 },
  'crack-rumble-sub':    { attack: 0.002, hold: 0.60 },
  'sweep-crackle':       { attack: 0.002, hold: 0.24 },
  'ascending-sine':      { attack: 0.010, hold: 0.30 },
  'chord':               { attack: 0.030, hold: 0.45 },
  'plucked-tonal':       { attack: 0.002, hold: 0.45 },
  'wobble-drone':        { attack: 0.140, hold: 0.55 },
  'sustained-low-chord': { attack: 0.120, hold: 0.80 },
  'sustained-rise':      { attack: 0.200, hold: 0.40 },
  'NONE':                null,
};

/** Gain trim per intensity step, so motion and audio cannot disagree (§1.4). */
const STEP_GAIN = { tick: 0.45, event: 1, heavy: 1.5 };

/**
 * Speak one element in one envelope family at one point.
 *
 * Returns the sustain handle so a caller that owns a *state* rather than an
 * event (a snare's pull, a dome standing) can hold it and release at the end;
 * every other caller ignores it, because the release is already scheduled.
 */
export function voice(audio, element, envelope, pos, step = 'event', { hold = null, pitch = 1 } = {}) {
  if (!audio?.startSustained) return null;
  const env = ENVELOPES[envelope];
  const recipe = RECIPES[element];
  if (!env || !recipe) return null;
  const r = recipe(pitch);
  const g = STEP_GAIN[step] ?? 1;
  const h = audio.startSustained(pos, {
    tones: (r.tones || []).map((t) => ({ ...t, gain: (t.gain ?? 0.14) * g })),
    noise: r.noise ? { ...r.noise, gain: (r.noise.gain ?? 0.2) * g } : null,
    attack: env.attack,
    release: env.hold,
    // A held voice is a state and outranks a burst for the last slot in the
    // budget; a tick proc never does.
    priority: hold === true && step !== 'tick',
  });
  // `hold === true` means the caller owns the ending. Everything else is a
  // burst: released immediately, so `attack` is the onset and `release` the
  // free decay, which is the whole envelope.
  if (hold !== true) h?.release?.(env.hold);
  return h;
}

// -------------------------------------------------------- the effect surface

/**
 * One row per player-side effect: its four dimensions, plus where it speaks.
 *
 * `at: 'player'` is §4.2's rule for stat and buff procs; `at: 'victim'` is the
 * rule for damage procs. `every` throttles the highest-frequency procs — a cue
 * on literally every hit is the mix-dominance failure §4.2 names against
 * `shrapnel-heart`, and it applies equally to the other per-hit rows.
 *
 * `step` is §1.4's intensity. Nothing here is `heavy`: the proc grammar is a
 * floor, and an item that deserves more than the floor gets it by being
 * authored beyond this table, not by turning its own dial up.
 */
export const ITEM_EFFECTS = {
  // ---------------------------------------------- C1: the seven arc items
  // Separated on colour, frame, motion and envelope — every pair differs on at
  // least one *bucketed* dimension. See §3 C1 for why re-hueing alone fails.
  'copper-wire':      { element: 'shock',    frame: 'line',         motion: 'travelling',     envelope: 'sweep-crackle',    step: 'event', at: 'victim' },
  'cracked-zither':   { element: 'shock',    frame: 'line',         motion: 'travelling',     envelope: 'plucked-tonal',    step: 'event', at: 'victim' },
  'arc-capacitor':    { element: 'shock',    frame: 'radial-spark', motion: 'instant-radial', envelope: 'crack-rumble-sub', step: 'event', at: 'victim' },
  'spark-plug':       { element: 'shock',    frame: 'streak',       motion: 'travelling',     envelope: 'crack-body',       step: 'event', at: 'victim' },
  'arc-rot':          { element: 'toxic',    frame: 'line',         motion: 'travelling',     envelope: 'wobble-drone',     step: 'event', at: 'victim' },
  'quicksilver-vein': { element: 'physical', frame: 'line',         motion: 'travelling',     envelope: 'tick-thump',       step: 'event', at: 'victim' },
  'squall-charm':     { element: 'bone',     frame: 'streak',       motion: 'travelling',     envelope: 'tick-thump',       step: 'event', at: 'victim' },

  // ------------------------------------------------ C7: the four fire areas
  // Held hazard ring vs event ring is the separator (§1.3): a ring redrawn on a
  // tick is the same shape as an instantaneous nova unless its boundary stops
  // expanding, which is what `motion: 'held'` names.
  'leaking-jerrycan': { element: 'fire', frame: 'ring',   motion: 'expanding-ring', envelope: 'crack-body',   step: 'event', at: 'victim' },
  'warlock-ember':    { element: 'fire', frame: 'streak', motion: 'travelling',     envelope: 'crack-body',   step: 'event', at: 'victim' },
  'emberwake':        { element: 'fire', frame: 'ring',   motion: 'held',           envelope: 'tick-thump',   step: 'tick',  at: 'player' },
  'spore-sac':        { element: 'toxic', frame: 'ring',  motion: 'held',           envelope: 'wobble-drone', step: 'tick',  at: 'victim' },

  // ---------------------------------------------------- C9: the false violets
  // None of the three was gravity. Violet is left to `gravity-well`.
  'prism-splinter':   { element: 'bone',  frame: 'radial-spark', motion: 'instant-radial', envelope: 'crack-body',       step: 'event', at: 'victim' },
  'hive-gland':       { element: 'toxic', frame: 'streak',       motion: 'travelling',     envelope: 'wobble-drone',     step: 'event', at: 'victim' },
  'mourners-dagger':  { element: 'void',  frame: 'line',         motion: 'travelling',     envelope: 'crack-tonal-fall', step: 'event', at: 'victim' },

  // ------------------------------------------------------- C10: the two shells
  'bile-shell':       { element: 'toxic', frame: 'streak', motion: 'travelling', envelope: 'crack-body', step: 'event', at: 'victim' },
  'missile-rack':     { element: 'blast', frame: 'streak', motion: 'travelling', envelope: 'crack-body', step: 'event', at: 'victim' },

  // -------------------------------------------------- the actual gravity items
  'gravity-well':     { element: 'gravity', frame: 'ring', motion: 'expanding-ring', envelope: 'crack-rumble-sub', step: 'event', at: 'victim' },

  // ---------------------------------------------------------- §1d, the floor
  //
  // Forty-six procs that emitted nothing at all. Each takes a tick-intensity
  // radial-spark in its element at the point it acted, with a positioned tick
  // voice. This buys the noticeability bar for all of them at once; the
  // thirteen named-promise entries among them are owed more than this and get
  // it in a later wave.
  'gristle-sickle':      { element: 'restorative', at: 'player', every: 0.25 },
  'rupture-gall':        { element: 'blast',       at: 'victim', every: 0.20 },
  'gorge-tooth':         { element: 'restorative', at: 'player' },
  'wardens-tally':       { element: 'bone',        at: 'player' },
  'unblemished-plate':   { element: 'restorative', at: 'player', every: 0.35 },
  'chime-of-absolution': { element: 'void',        at: 'player' },
  'bruised-coinpurse':   { element: 'blast',       at: 'player', envelope: 'pip' },
  'tar-charge':          { element: 'blast',       at: 'victim' },
  'marrow-tooth':        { element: 'restorative', at: 'player' },
  'amber-clasp':         { element: 'restorative', at: 'player' },
  'stitch-kit':          { element: 'restorative', at: 'player' },
  'spurs':               { element: 'physical',    at: 'player' },
  'warm-coals':          { element: 'fire',        at: 'victim' },
  'field-dressing':      { element: 'restorative', at: 'player' },
  'salt-lick':           { element: 'restorative', at: 'player', every: 1.0 },
  'prey-instinct':       { element: 'physical',    at: 'player', every: 1.0 },
  'gutting-shiv':        { element: 'physical',    at: 'victim' },
  'concussion-charge':   { element: 'shock',       at: 'victim' },
  'hoarfrost-band':      { element: 'frost',       at: 'victim' },
  'feeding-vial':        { element: 'restorative', at: 'player' },
  'reaping-hook':        { element: 'restorative', at: 'player', every: 0.25 },
  'thirsting-burr':      { element: 'restorative', at: 'player', every: 0.25 },
  'corpse-flare':        { element: 'fire',        at: 'victim' },
  'red-mist-pauldron':   { element: 'blast',       at: 'player' },
  'ration-pack':         { element: 'restorative', at: 'player' },
  'iron-thorns':         { element: 'physical',    at: 'victim', every: 0.20 },
  'hunters-tag':         { element: 'bone',        at: 'victim', every: 0.50 },
  'frost-lattice':       { element: 'frost',       at: 'victim' },
  'scrap-magnet':        { element: 'blast',       at: 'player', envelope: 'pip' },
  'battle-hymn':         { element: 'restorative', at: 'player' },
  'carrion-flies':       { element: 'toxic',       at: 'victim', every: 0.50 },
  // §4.2 names this one explicitly: the highest-frequency proc in the game, so
  // it is authored at tick intensity or it dominates the mix.
  'shrapnel-heart':      { element: 'blast',       at: 'victim', every: 0.20 },
  'whisper-stalks':      { element: 'void',        at: 'player' },
  'resonance-coil':      { element: 'blast',       at: 'victim' },
  'chronal-governor':    { element: 'void',        at: 'player' },
  'siege-battery':       { element: 'shock',       at: 'player' },
  'kinetic-recycler':    { element: 'blast',       at: 'player' },
  'grafted-polyp':       { element: 'restorative', at: 'player' },
  'sunken-vertebra':     { element: 'restorative', at: 'player' },
  'molten-core':         { element: 'fire',        at: 'player' },
  'tithe-of-ash':        { element: 'blast',       at: 'player', envelope: 'pip' },
  'charnel-bloom':       { element: 'restorative', at: 'player' },
  'brittle-edge':        { element: 'physical',    at: 'player', every: 0.25 },
  'ashen-pact':          { element: 'fire',        at: 'victim', every: 0.30 },
  'bloodscent':          { element: 'physical',    at: 'player', every: 0.25 },
  'bandolier':           { element: 'physical',    at: 'player' },
};

/**
 * Equipment rows (§4.1). Kept beside the item rows so the bucketing re-run sees
 * one surface — C8 is an equipment-only collision and would be invisible to a
 * check that only walked items.
 */
export const EQUIPMENT_EFFECTS = {
  'thermal-lance':      { element: 'fire',        frame: 'line',    motion: 'travelling',     envelope: 'crack-rumble-sub', step: 'heavy' },
  'gravity-snare':      { element: 'gravity',     frame: 'ring',    motion: 'contracting',    envelope: 'sustained-low-chord', step: 'event' },
  'overload-cell':      { element: 'blast',       frame: 'ring',    motion: 'expanding-ring', envelope: 'crack-rumble-sub', step: 'heavy' },
  'frostbite-canister': { element: 'frost',       frame: 'ring',    motion: 'expanding-ring', envelope: 'crack-body',       step: 'event' },
  'aegis-emitter':      { element: 'restorative', frame: 'lattice', motion: 'rising',         envelope: 'sustained-rise',   step: 'event' },
};

// The floor's own four dimensions. Applied to every §1d row, which is what
// makes them a *floor* — one grammar, one shape, differing only in element.
const FLOOR = { frame: 'radial-spark', motion: 'instant-radial', envelope: 'tick-thump', step: 'tick' };

/** The full row for an id, floor defaults folded in. */
export function effectOf(id) {
  const row = ITEM_EFFECTS[id] || EQUIPMENT_EFFECTS[id];
  if (!row) return null;
  return { ...FLOOR, ...row, id };
}

/** Every row on the player-facing surface, floor defaults folded in. */
export function allEffects() {
  return [...Object.keys(ITEM_EFFECTS), ...Object.keys(EQUIPMENT_EFFECTS)].map(effectOf);
}

// ------------------------------------------------------------------ the cue

/**
 * The proc-grammar floor (§4.2, first bullet).
 *
 * Every item proc, however small, emits at minimum a tick-intensity
 * radial-spark in its element at the point it acted, with a positioned tick
 * voice. Rows that name a richer frame get that instead; rows that name a
 * throttle honour it, because the mix has to survive a full inventory.
 *
 * `at` may be a Vector3 or anything carrying `.position`, so a hook can hand it
 * the victim it just hit without unwrapping first.
 */
export function cue(api, id, at) {
  const row = effectOf(id);
  if (!row) return false;
  const el = ELEMENTS[row.element];
  if (!el) return false;

  const pos = at?.position || at
    || (row.at === 'player' ? api?.player?.position : null);
  if (!pos || !Number.isFinite(pos.x)) return false;

  // Throttled through the same per-item cooldown table the items themselves
  // use, under a namespaced key: a cue must never be able to eat the cooldown
  // the item's own mechanic is gated on.
  if (row.every && !api?.items?.cooldownReady?.(`cue:${id}`, row.every)) return false;

  // The floor's shape is a radial-spark and this is where it is drawn. A row
  // that names any other frame family has an authored figure of its own — a
  // chain's lines, a swarm's streaks, an ignition's ring — and a spark on top
  // of it would be the language adding particles rather than meaning. Those
  // rows come here for the voice alone, which is the half they were missing.
  if (row.frame === 'radial-spark') {
    const scale = row.step === 'tick' ? 0.5 : row.step === 'heavy' ? 1.6 : 0.9;
    api?.ctx?.vfx?.hitSpark?.(pos, el.hue, scale);
  }
  voice(api?.ctx?.audio, row.element, row.envelope, pos, row.step);
  return true;
}

// ------------------------------------------------------------- conformance

/**
 * §1.1's two reservations, checked at load rather than asserted in prose.
 *
 * Mint-green and magenta may never be spent on damage. A row is a damage row
 * unless it speaks at the player, so this catches exactly the mistake the
 * reservation exists to prevent — colouring something that hurts a monster
 * with the healing or the void hue.
 */
function assertLanguage() {
  for (const row of allEffects()) {
    const el = ELEMENTS[row.element];
    if (!el) throw new Error(`[effects] "${row.id}" names unknown element "${row.element}"`);
    if (el.damage === false && row.at === 'victim') {
      throw new Error(`[effects] "${row.id}" spends the reserved hue ${el.family} on damage (EFFECT-LANGUAGE §1.1)`);
    }
    if (!STEPS.includes(row.step)) throw new Error(`[effects] "${row.id}" is at no intensity step`);
    if (!(row.envelope in ENVELOPES)) throw new Error(`[effects] "${row.id}" names unknown envelope family "${row.envelope}"`);
  }
}
assertLanguage();
