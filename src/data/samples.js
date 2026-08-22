/**
 * The sampled voices (#148).
 *
 * Seven timbres this mixer's oscillators and filtered noise cannot reach: the
 * dry rattle of a fly swarm, a wet gland, wind through dead stalks, a sung
 * hymn, a tooth grinding, a bloom opening. Everything else in the game stays
 * procedural — this is an additive capability, not a migration, and a sound
 * synthesis can make has no business being a download.
 *
 * A sampled voice is not a second mixer: `Audio.playSample` rides the same SFX
 * bus, the same positional chain and the same voice budget as every synthesized
 * burst. The only thing sampling changes is where the waveform came from.
 *
 * The recordings themselves are CC0 candidates a human still has to fetch; the
 * committed files are placeholders from `tools/make-sample-fixtures.mjs`.
 * Dropping a real recording in at the same path is a file edit and nothing
 * else — no code here names a duration, a sample rate or a channel count.
 *
 *   id      the effect id, and the key `playSample` is called with
 *   url     relative to the built root, so it resolves under app:// too
 *   gain    base level into the positional chain
 *   rateVar +/- fraction of playback rate rolled per trigger, the same
 *           idiom the synthesized voices use to avoid machine-gunning
 *   cost    voice-budget units. `_take` gates on it and `_release` charges one
 *           unit per source node, so for a sampled voice — which is exactly one
 *           `BufferSource` however long the recording is — the only honest
 *           value is 1. A 2 here would gate twice as hard as it charges, which
 *           is the same drift that once put the counter 18 nodes over a ceiling
 *           it was still being asked about.
 *   ref/max the panner distances this sound is heard over
 */

/** Where the recordings live, under `public/`. */
export const SAMPLE_DIR = 'game-assets/audio/samples';

const sample = (id, { gain, rateVar = 0.06, cost = 1, refDistance = 8, maxDistance = 140 }) => ({
  id,
  url: `${SAMPLE_DIR}/${id}.wav`,
  gain,
  rateVar,
  cost,
  refDistance,
  maxDistance,
});

export const SAMPLES = [
  // A body of insects, not a filtered hiss: the swarm's texture is its
  // irregularity, and irregularity is the one thing a noise band cannot fake.
  sample('carrion-flies', { gain: 0.5, rateVar: 0.08, cost: 1, refDistance: 6 }),
  sample('scrapfly-hive', { gain: 0.55, rateVar: 0.07, cost: 1, refDistance: 10 }),
  // Wet, close, and fleshy — every synthesized attempt reads as a bubble.
  sample('hive-gland', { gain: 0.6, rateVar: 0.09, cost: 1, refDistance: 5 }),
  sample('whisper-stalks', { gain: 0.45, rateVar: 0.05, cost: 1, refDistance: 9, maxDistance: 180 }),
  // A sung line. There is no oscillator recipe for a voice.
  sample('battle-hymn', { gain: 0.7, rateVar: 0.03, cost: 1, refDistance: 14, maxDistance: 220 }),
  sample('gorge-tooth', { gain: 0.65, rateVar: 0.1, cost: 1, refDistance: 6 }),
  sample('charnel-bloom', { gain: 0.5, rateVar: 0.06, cost: 1, refDistance: 8 }),
];

/** Registry by effect id. Unknown ids are a silent no-op, never a throw. */
export const SAMPLES_BY_ID = new Map(SAMPLES.map((s) => [s.id, s]));
