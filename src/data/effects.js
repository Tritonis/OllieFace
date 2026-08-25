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

import { reservedViolation, reservedViolationOnFeedback } from './colourFamily.js';
import { ELEMENT_HUE, goreColour } from './damageTypes.js';
import { enemyCore, enemyRim } from './elementVoice.js';
import { SAMPLES_BY_ID } from './samples.js';

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
  // Violet here, magenta-violet on the damage spark, and that pair is
  // deliberate. `gravity` is a *cue* element; the damage vocabulary is the
  // closed seven of `damageTypes.js`, which has no violet, so `gravity` is
  // projected onto `void` — its nearest neighbour, one bucket away
  // (0x9b5cff h 262 `violet` / 0xab00ac h 300 `magenta-violet`). Closing the
  // gap costs more than it buys in either direction: moving this hue into
  // magenta-violet would put the gravity cue in the void spark's family and so
  // trade this adjacency for a gravity/void one, and moving the void spark
  // into violet would break `ELEMENT_HUE`'s standing rule that each family
  // borrows its affix's own colour (voidtouched's tint 0xab00ac). The third
  // option — an eighth damage family — is a change to the closed set, not a
  // hygiene fix. See `damageTypes.js`'s `TYPE_ELEMENT.gravity` and §1.1.
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

/**
 * The four geometries added on 2026-08-23, as vocabulary rather than as
 * gameplay (`docs/superpowers/plans/2026-08-23-new-vfx-geometries.md`).
 *
 * No ability or item names them yet — which effect adopts which shape is a
 * design decision, deliberately left open. What this table is for is the
 * showcase: each row is one demo entry, and its hue is read off `ELEMENTS`
 * above rather than typed at the call site, so the demos sit inside the same
 * walk every other authored colour does.
 *
 * `frame` names the §1.3 family the geometry belongs to; `vortex` shares
 * `helix` on purpose and separates on motion alone.
 */
export const GEOMETRY_DEMOS = {
  sector: {
    frame: 'sector', element: 'fire', motion: 'expanding-ring',
    label: 'Sector — a ground arc with a facing and an aperture',
  },
  helix: {
    frame: 'helix', element: 'restorative', motion: 'rising',
    label: 'Helix — particles laced on a rising spiral',
  },
  vortex: {
    frame: 'helix', element: 'gravity', motion: 'contracting',
    label: 'Vortex — the same lace, falling inward',
  },
  chain: {
    frame: 'chain', element: 'shock', motion: 'travelling',
    label: 'Chain — a jagged multi-hop arc',
  },
};

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
export function voice(audio, element, envelope, pos, step = 'event',
  { hold = null, pitch = 1, priority = null } = {}) {
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
    // budget; a tick proc never does. A caller may say otherwise, and the held
    // equipment ambiences do: the reserve is sized for the *transient* feedback
    // a player must hear at the instant it happens (a pickup, a level-up and a
    // hurt overlapping is 26 of its 28 nodes), and a chord that stands for eight
    // seconds is not that. Measured, one held dome spent the reserve's entire
    // remaining headroom and a second refused `playerHurt` outright.
    priority: priority === null ? (hold === true && step !== 'tick') : priority === true,
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
  // A struck bell in consecrated air: two concentric rings standing off the
  // player, and a plucked tonal with no noise bed at all. Rising, because
  // absolution goes upward.
  'chime-of-absolution': { element: 'void', at: 'player', bespoke: true,
    frame: 'lattice', motion: 'rising', envelope: 'plucked-tonal', step: 'event' },
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
  // Loud and bright, and it stops a body where it stood: one hard expanding
  // shock ring at the victim with a crack on the front of it.
  'concussion-charge': { element: 'shock', at: 'victim', bespoke: true,
    frame: 'ring', motion: 'expanding-ring', envelope: 'crack-body', step: 'event' },
  // A heart stopped mid-beat: ice grows as a lattice of shards out of the
  // freeze point, and the voice falls away rather than cracking flat.
  'hoarfrost-band': { element: 'frost', at: 'victim', bespoke: true,
    frame: 'lattice', motion: 'expanding-ring', envelope: 'crack-tonal-fall', step: 'event' },
  'feeding-vial':        { element: 'restorative', at: 'player' },
  'reaping-hook':        { element: 'restorative', at: 'player', every: 0.25 },
  'thirsting-burr':      { element: 'restorative', at: 'player', every: 0.25 },
  // "Follow the light." A pillar is a vertical line that goes up, which is the
  // one fire effect on the surface that is not a ring or a travelling streak.
  'corpse-flare': { element: 'fire', at: 'victim', bespoke: true,
    frame: 'line', motion: 'rising', envelope: 'crack-rumble-sub', step: 'event' },
  // Three at once and the world goes red: a mist that climbs the survivor,
  // held low and long rather than struck.
  'red-mist-pauldron': { element: 'blast', at: 'player', bespoke: true,
    frame: 'lattice', motion: 'rising', envelope: 'sustained-low-chord', step: 'event' },
  'ration-pack':         { element: 'restorative', at: 'player' },
  'iron-thorns':         { element: 'physical',    at: 'victim', every: 0.20 },
  'hunters-tag':         { element: 'bone',        at: 'victim', every: 0.50 },
  'frost-lattice':       { element: 'frost',       at: 'victim' },
  'scrap-magnet':        { element: 'blast',       at: 'player', envelope: 'pip' },
  // A sung line, sampled (#148). Degraded it is a restorative chord — so its
  // separation from `charnel-bloom`, the other sampled mint entry, is carried
  // by frame and motion, never by timbre (§4.2, §3.2).
  'battle-hymn': { element: 'restorative', at: 'player', bespoke: true,
    frame: 'lattice', motion: 'rising', envelope: 'chord', step: 'event' },
  // A swarm that hangs on the body it is eating rather than flying to it —
  // held streaks, which is what keeps it off `hive-gland`'s travelling ones in
  // the degraded case where both are the same toxic drone.
  'carrion-flies': { element: 'toxic', at: 'victim', every: 0.50, bespoke: true,
    frame: 'streak', motion: 'held', envelope: 'wobble-drone', step: 'tick' },
  // §4.2 names this one explicitly: the highest-frequency proc in the game, so
  // it is authored at tick intensity or it dominates the mix.
  // Bespoke but deliberately small: it keeps the floor's spark and takes only
  // an onset of its own, because §4.2 names it as the entry that dominates the
  // mix if it is authored any louder.
  'shrapnel-heart': { element: 'blast', at: 'victim', every: 0.20, bespoke: true,
    frame: 'radial-spark', motion: 'instant-radial', envelope: 'crack-body', step: 'tick' },
  // Stalks: vertical lines that rise around the survivor and whisper. Sampled;
  // degraded it is a void swell, separated from `mourners-dagger`'s magenta
  // line by motion.
  'whisper-stalks': { element: 'void', at: 'player', bespoke: true,
    frame: 'line', motion: 'rising', envelope: 'sustained-rise', step: 'event' },
  // "The one the metal remembers": concentric rings and a struck tonal.
  'resonance-coil': { element: 'blast', at: 'victim', bespoke: true,
    frame: 'ring', motion: 'expanding-ring', envelope: 'plucked-tonal', step: 'event' },
  'chronal-governor':    { element: 'void',        at: 'player' },
  'siege-battery':       { element: 'shock',       at: 'player' },
  // The hit comes back out as a shell: a lattice thrown off the survivor as
  // the refunded barrier forms, over a chord rather than a bang.
  'kinetic-recycler': { element: 'blast', at: 'player', bespoke: true,
    frame: 'lattice', motion: 'expanding-ring', envelope: 'chord', step: 'event' },
  'grafted-polyp':       { element: 'restorative', at: 'player' },
  'sunken-vertebra':     { element: 'restorative', at: 'player' },
  // The mountain opening: the only item row authored at heavy, because a 10m
  // eruption every six seconds is an event the player plans around.
  'molten-core': { element: 'fire', at: 'player', bespoke: true,
    frame: 'ring', motion: 'expanding-ring', envelope: 'crack-rumble-sub', step: 'heavy' },
  'tithe-of-ash':        { element: 'blast',       at: 'player', envelope: 'pip' },
  // A flower opening where something stopped: a ring that opens outward, not a
  // column that climbs — which is exactly the frame/motion pair that keeps it
  // off `battle-hymn` when #148's samples are absent and both are mint chords.
  'charnel-bloom': { element: 'restorative', at: 'player', bespoke: true,
    frame: 'ring', motion: 'expanding-ring', envelope: 'ascending-sine', step: 'event' },
  'brittle-edge':        { element: 'physical',    at: 'player', every: 0.25 },
  'ashen-pact':          { element: 'fire',        at: 'victim', every: 0.30 },
  'bloodscent':          { element: 'physical',    at: 'player', every: 0.25 },
  'bandolier':           { element: 'physical',    at: 'player' },

  // ------------------------------------------------------------- Tempered (#179)
  'tempered-capacitor': { element: 'shock',       frame: 'line', motion: 'travelling', envelope: 'crack-body', step: 'event', at: 'victim' },
  'tempered-bulwark':   { element: 'physical',    at: 'player', every: 0.4 },
  'tempered-cairn':     { element: 'restorative', at: 'player', every: 0.3 },
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
  // C5. §3's healing family is radial-spark · rising and the flare stays in it —
  // it is a heal, and re-shaping it would be the language separating things
  // that mean the same thing. What separates it from an ordinary `healPop` tick
  // is intensity and envelope: half a health bar at once is an *event*, on a
  // ladder that climbs rather than a thump. The expanding mint ring it used to
  // draw is gone: a ring is the equipment tier's hazard/blast shape, and wearing
  // it put a heal in the same frame family as the canister and the cell.
  'mending-flare':      { element: 'restorative', frame: 'radial-spark', motion: 'rising',    envelope: 'ascending-sine',   step: 'heavy' },
};

// ------------------------------------------------------------ bespoke figures
//
// §4.2's second bullet: thirteen items were promised an effect of their own by
// name, and the proc-grammar floor — a spark in the element — is precisely what
// the promise was not. Each figure below is drawn from the primitives `VFX`
// already offers, so the language buys these thirteen without asking the engine
// for a new verb.
//
// A figure receives the resolved point and its element hue and draws; the voice
// is the row's own and is spoken by `cue` afterwards, sample first (§4.2's G1
// note) and procedural when the sample is absent.

/** A point `h` metres above `pos`, in whatever shape the caller handed us. */
const above = (pos, h) => ({ x: pos.x, y: (pos.y || 0) + h, z: pos.z });
/** A point offset in the ground plane. */
const beside = (pos, dx, dz) => ({ x: pos.x + dx, y: pos.y || 0, z: pos.z + dz });

const FIGURES = {
  // Two concentric rings standing off the player: a bell, seen.
  'chime-of-absolution': (vfx, pos, hue) => {
    vfx.ring?.(pos, 3, hue);
    vfx.ring?.(pos, 5.5, hue);
  },
  // A voice lifting off the survivor.
  'battle-hymn': (vfx, pos, hue) => {
    vfx.burst?.(pos, hue);
    vfx.ring?.(pos, 4, hue);
  },
  // Three stalks standing up around the survivor, whispering.
  'whisper-stalks': (vfx, pos, hue) => {
    for (const [dx, dz] of [[1.4, 0.6], [-1.1, 1.3], [-0.4, -1.6]]) {
      vfx.beam?.(beside(pos, dx, dz), above(beside(pos, dx, dz), 4), hue);
    }
  },
  // Flies hanging on the body, not flying to it: short streaks at the victim.
  'carrion-flies': (vfx, pos, hue) => {
    vfx.missile?.(above(beside(pos, 0.9, 0.5), 1.2), pos, hue);
    vfx.missile?.(above(beside(pos, -0.7, -0.8), 1.4), pos, hue);
  },
  // A flower opening where something stopped.
  'charnel-bloom': (vfx, pos, hue) => {
    vfx.ring?.(pos, 2.5, hue);
    vfx.healPop?.(pos, 0);
  },
  // Loud, bright, and it stops the body where it stood.
  'concussion-charge': (vfx, pos, hue) => {
    vfx.ring?.(pos, 3, hue);
    vfx.hitSpark?.(pos, hue, 1.1);
  },
  // Ice growing outward as shards, not as a smooth front.
  'hoarfrost-band': (vfx, pos, hue) => {
    vfx.ring?.(pos, 6, hue);
    for (const [dx, dz] of [[3, 0], [0, 3], [-3, 0], [0, -3]]) {
      vfx.beam?.(pos, above(beside(pos, dx, dz), 1.2), hue);
    }
  },
  // Follow the light: a pillar of fire off the corpse.
  'corpse-flare': (vfx, pos, hue) => {
    vfx.beam?.(pos, above(pos, 9), hue);
    vfx.burst?.(pos, hue);
  },
  // The world going red around the survivor.
  'red-mist-pauldron': (vfx, pos, hue) => {
    vfx.burst?.(pos, hue);
    vfx.ring?.(pos, 2.2, hue);
  },
  // The mountain, still open.
  'molten-core': (vfx, pos, hue) => {
    vfx.explosion?.(pos, 10, hue);
    vfx.ring?.(pos, 10, hue);
  },
  // What the metal remembers: three rings out of one strike.
  'resonance-coil': (vfx, pos, hue) => {
    for (const r of [2.5, 4.5, 7]) vfx.ring?.(pos, r, hue);
  },
  // The hit, handed back as a shell.
  'kinetic-recycler': (vfx, pos, hue) => {
    vfx.ring?.(pos, 9, hue);
    vfx.burst?.(pos, hue);
  },
  // Deliberately the floor's own spark: §4.2 authors this one *quiet*.
  'shrapnel-heart': (vfx, pos, hue) => { vfx.hitSpark?.(pos, hue, 0.5); },
};

/** The thirteen §4.2 named-promise ids, derived rather than re-listed. */
export const NAMED_PROMISE = Object.keys(FIGURES);

/**
 * G1-named ids with a sample registered in `samples.js` but no row here —
 * named exemptions, not oversights. `scrapfly-hive` is the one member: its
 * hook (`items.js`) draws a bespoke sequence — a release burst, a travelling
 * fly rendered as repeated hitsparks, a beam on each of five strikes — at a
 * literal hue (`0xc8d86a`) that is not one of `ELEMENTS`', and never calls
 * `cue()`. A row here would have to invent a colour-family/frame/motion/
 * envelope classification for pixels the table doesn't actually drive rather
 * than describe an existing one, which is design, not description (see #211).
 *
 * `tests/effect-language.test.mjs` asserts every `samples.js` id either reaches
 * `effectOf()` or is named here, so a sample that falls out of both sets —
 * including this one, were the entry ever deleted — fails loudly instead of
 * silently.
 */
export const TABLE_EXEMPT = ['scrapfly-hive'];

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
  const figure = FIGURES[id];
  if (figure) {
    // A named-promise item (§4.2, second bullet) draws its own figure and
    // nothing else — the floor's spark on top of it would be the language
    // adding particles rather than meaning, exactly as for the authored rows.
    if (api?.ctx?.vfx) figure(api.ctx.vfx, pos, el.hue, row);
  } else if (row.frame === 'radial-spark') {
    const scale = row.step === 'tick' ? 0.5 : row.step === 'heavy' ? 1.6 : 0.9;
    api?.ctx?.vfx?.hitSpark?.(pos, el.hue, scale);
  }
  speak(api?.ctx?.audio, row, pos);
  return true;
}

/**
 * The voice half of a cue: the sampled timbre where #148 supplied one, and the
 * procedural recipe where it did not.
 *
 * The fallback is not a courtesy. §4.2 says a G1 entry's *degraded* point is
 * part of the language, so a declined or unloaded sample must leave a legible
 * effect behind rather than silence — and it is why every sampled row is
 * separated from its neighbours on frame and motion, which survive the
 * downgrade, rather than on timbre, which does not.
 */
function speak(audio, row, pos) {
  if (SAMPLES_BY_ID.has(row.id) && audio?.playSample?.(row.id, pos,
    { gain: STEP_GAIN[row.step] ?? 1 }) === true) return true;
  return voice(audio, row.element, row.envelope, pos, row.step) !== null;
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
  assertEnemyLanguage();
  assertAuthoredPalette();
  assertDegradedSeparation();
}

/**
 * §4.2's Degraded Point rule, checked rather than promised.
 *
 * #148 may decline: a sample can be refused, unloaded or missing, and then a
 * sampled row falls back to its element's procedural recipe. Any separation
 * that lived in the recording is gone at that moment. So every row with a
 * sample must differ from every other such row on a dimension that *survives*
 * the downgrade — colour, frame or motion — and never on timbre alone. This is
 * the `hive-gland`/`arc-rot` case of §C9 generalised to all seven.
 *
 * The key deliberately omits the envelope as well as the element: the envelope
 * is the other half of the timbre axis, and a pair separated only by envelope
 * would still be two drones of the same colour in the same shape.
 */
export function degradedKey(row) {
  return [ELEMENTS[row.element].family, row.frame, row.motion].join(' · ');
}

/**
 * The first pair of sampled rows sharing a degraded point, or null.
 *
 * Takes its rows as an argument so a test can hand it a deliberately colliding
 * pair and watch it report one — a guard that can only ever be run over a
 * surface already known to be clean is a guard nobody has seen fail.
 */
export function degradedCollision(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!SAMPLES_BY_ID.has(row.id)) continue;
    const key = degradedKey(row);
    if (seen.has(key)) return { a: seen.get(key), b: row.id, key };
    seen.set(key, row.id);
  }
  return null;
}

function assertDegradedSeparation() {
  const clash = degradedCollision(allEffects());
  if (clash) {
    throw new Error(`[effects] sampled "${clash.b}" and "${clash.a}" share the degraded point`
      + ` ${clash.key} — separable only by timbre, which #148 may not supply (EFFECT-LANGUAGE §4.2)`);
  }
}

/**
 * The same two reservations over the *enemy* half of the vocabulary.
 *
 * This is the arm that was missing. The check above walks only this file's
 * table, so `damageTypes.js` and everything `elementVoice.js` derives from it
 * were unguarded — which is how `nature` came to spend mint-green on six live
 * enemy damage surfaces while a load-time assert stood two files away
 * reporting green. Every hue in `ELEMENT_HUE` reaches a damage surface by
 * construction: `sparkColour` draws `tail`/`critTail`, `enemyCore` is the nova
 * and telegraph core, `enemyRim` is its rim, `goreColour` is the splat. So all
 * of them are checked, and the failure is at load, not at review.
 *
 * `void` may wear magenta — the narrow reading documented on `ELEMENTS` above.
 * Nothing may wear mint-green.
 */
/**
 * The purity route's authored palette (issue #154).
 *
 * These are hero-ish, player-facing figures — a ward landing, a Sanctuary
 * going up, a Consecration paying out — so they are not rows in the table
 * above and `ELEMENT_HUE` never reaches them: they are drawn straight by
 * `VFX.wardingMote`, `VFX.sanctuaryOpen` and `VFX.consecration`. Written as
 * hex literals at those call sites they were **outside every guard in this
 * file**, which was demonstrated rather than argued: planting full magenta on
 * the warding core left the entire suite green.
 *
 * Declaring them here puts them back inside the walk. Each entry names the
 * element it is spending, and `assertAuthoredPalette` runs the same
 * reservation predicate over every hex at load — the *feedback* reading of it
 * (`reservedViolationOnFeedback`), because mint-green is reserved **for**
 * restorative and these are the restorative family by design, while magenta
 * stays void-only here exactly as it is everywhere else.
 *
 * `tests/argent-legibility.test.mjs` holds the other half of the seam shut:
 * `VFX`'s three methods must reference this table rather than re-typing a
 * literal, or the declaration would guard a copy nobody draws.
 */
export const PURITY_PALETTE = {
  // White-hot core, mint rim: player polarity, §1.2.
  wardCore:        { hex: 0xf4fff6, element: 'restorative' },
  wardRim:         { hex: 0x6fe0a8, element: 'restorative' },
  wardRing:        { hex: 0x8ff0bc, element: 'restorative' },
  sanctuaryCore:   { hex: 0xffffff, element: 'restorative' },
  sanctuaryRim:    { hex: 0x5fdca4, element: 'restorative' },
  sanctuaryVeil:   { hex: 0xdfffee, element: 'restorative' },
  sanctuaryVeilIn: { hex: 0x3fbf88, element: 'restorative' },
  sanctuaryLight:  { hex: 0x9fffcf, element: 'restorative' },
  // Argent's core, white-gold (#189). It used to be a hueless pale grey chosen
  // to spend no hue at all — and it read as nothing: a grey core inside a family
  // of sanctuary white and mint rims is the *absence* of a tier, not a tier. A
  // consecration is the route's most expensive press and it now looks like one.
  //
  // Candlelit ivory rather than brass: h~43 deg at l=0.88, so the value stays in
  // the family's high-key band and only the warmth changes. Its nearest hue
  // neighbour in the whole vocabulary is fire's 0xff8a20, and that nearness was
  // accepted on one condition — argent and fire never separate on hue. They
  // separate on shape and motion: argent is a rising column of HEX/CROSS motes
  // under an expanding ground ring, fire is EMBER spray with negative gravity
  // and no ring of its own. `tests/argent-legibility.test.mjs` holds that
  // condition, on the frame/motion fields rather than on the hexes.
  argentPale:      { hex: 0xf3e9cf, element: 'restorative' },
  // The rim stays mint. Argent is still purity family; only its core is gold.
  argentRing:      { hex: 0xcfe8d8, element: 'restorative' },
};

/** Just the hexes, for the call sites: `HUE.wardRim` reads as a colour. */
export const HUE = Object.fromEntries(
  Object.entries(PURITY_PALETTE).map(([k, v]) => [k, v.hex]));

/**
 * The vocabulary the palette itself owns, read off its own keys: `wardCore`
 * and `wardRim` say `ward`, `sanctuaryVeil` says `sanctuary`, `argentPale`
 * says `argent`. The guard uses these stems to *find* purity surfaces in
 * `VFX` rather than being told where they are — see `PURITY_METHODS`.
 */
export const PURITY_STEMS = [...new Set(
  Object.keys(PURITY_PALETTE).map((k) => k.match(/^[a-z]+/)[0]))];

/**
 * The `VFX` methods that draw the purity family. This is *not* a hand list the
 * guard trusts: `tests/argent-legibility.test.mjs` re-derives the same set two
 * independent ways — every prototype method that reads `PURITY.`, and every
 * prototype method whose name carries a `PURITY_STEMS` word — and fails if
 * either derivation disagrees with what is written here.
 *
 * The reach of that is exactly two cases and no more: a method that wears a
 * palette word, and a method that reads the palette. A purity effect written
 * with *neither* — no stem in its name, every hue typed as a literal — is
 * invisible to this list by construction, and is issue #163's business, not
 * this one's.
 */
export const PURITY_METHODS = ['wardingMote', 'sanctuaryOpen', 'consecration'];

/**
 * Names that carry a purity stem while deliberately drawing something else, so
 * the stem net does not misfile them. This is a *classification* exemption and
 * nothing more: an excused method skips the derivation-agreement checks, but
 * its hues are still scanned, against the literals recorded here — so a third
 * literal appearing in `wardReflect` fails like any other undeclared hue.
 *
 * - `wardReflect` is the void-polarity shield bounce: arcane, not restorative,
 *   and its two hues are the void family's own.
 * - `_onWarded` is the event handler; it delegates and draws no colour at all.
 */
export const PURITY_METHOD_EXCEPTIONS = {
  wardReflect: ['0xb291ff', '0x2a1240'],
  _onWarded: [],
};

/**
 * `VFX.enemyMend`'s colours (issue #163).
 *
 * An enemy support unit's heal, drawn in *enemy* polarity (§1.2): the
 * caster's own element as the core, a fixed dark rim beneath it — the
 * inversion of `healPop`'s pale-to-mint player ramp. `hue` is the default
 * core a caller-less call would fall back to (every real caller, `Enemy.js`,
 * passes the attack's own colour instead); `rim` is fixed rather than
 * derived from `hue`, because the polarity's point is a rim that reads as
 * *shadow* regardless of which element cast the heal.
 *
 * Deliberately not in `PURITY_PALETTE`/`PURITY_METHODS`: those are the
 * player-facing purity family's own polarity (white-hot core, mint rim) and
 * #160 excludes enemy-polarity effects from them on purpose. This is its own
 * small table so `enemyMend`'s two literals stop being outside every no-literal
 * scan the way `argent-legibility.test.mjs`'s own comment names as this
 * issue's business — `tests/vfx-geometries.test.mjs`'s method scan is where it
 * lands instead, since that scan is not restricted to the purity family.
 */
export const ENEMY_MEND = { hue: 0x74ffc8, rim: 0x0d3b30 };

/**
 * The authored-palette arm. Same predicate, same failure mode, at load.
 *
 * A guard nobody has seen fail is worth nothing, so this one is written
 * against the exact mutation that falsified its absence: put magenta on
 * `wardCore` and the module throws before a frame is drawn.
 */
function assertAuthoredPalette() {
  for (const [name, { hex, element }] of Object.entries(PURITY_PALETTE)) {
    const bad = reservedViolationOnFeedback(hex, element);
    if (bad) {
      throw new Error(`[effects] PURITY_PALETTE "${name}" = 0x${hex.toString(16).padStart(6, '0')}`
        + ` spends the reserved hue ${bad} on a feedback surface (EFFECT-LANGUAGE §1.1)`);
    }
  }
}

function assertEnemyLanguage() {
  const blame = (element, where, hex, family) => {
    throw new Error(`[effects] damageTypes "${element}".${where} = 0x${hex.toString(16).padStart(6, '0')}`
      + ` spends the reserved hue ${family} on damage (EFFECT-LANGUAGE §1.1)`);
  };
  for (const [element, hues] of Object.entries(ELEMENT_HUE)) {
    for (const [where, hex] of Object.entries(hues)) {
      const bad = reservedViolation(hex, element);
      if (bad) blame(element, where, hex, bad);
    }
    for (const [where, hex] of [['enemyCore', enemyCore(element)], ['enemyRim', enemyRim(element)],
      ['goreColour', goreColour(element)]]) {
      const bad = reservedViolation(hex, element);
      if (bad) blame(element, where, hex, bad);
    }
  }
}
assertLanguage();
