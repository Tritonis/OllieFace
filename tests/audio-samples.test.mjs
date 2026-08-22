// tests/audio-samples.test.mjs
//
// Sampled playback (#148). Seven timbres synthesis cannot make now arrive as
// decoded buffers, and the whole fittingness constraint is that they arrive as
// *ordinary voices*: same bus, same positional chain, same budget. So the
// assertions here are budget assertions and graph assertions, not "it did not
// throw" assertions.
//
// Written so each half CAN fail. The stub context decodes the committed WAV
// fixtures for real — a genuine RIFF parse, not a resolved promise handing back
// a shape — so a registry entry pointing at a file that is missing or is not a
// WAV fails here rather than at 3am in a player's build. The counter checks
// distinguish charged / released / never-charged, so dropping `_release` or
// dropping the `_take` gate each break a different line.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES, SAMPLES_BY_ID, SAMPLE_DIR } from '../src/data/samples.js';
import { Audio } from '../src/systems/Audio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`PASS  ${msg}`); } else { fail++; console.log(`FAIL  ${msg}`); } };

/* -- a real, if minimal, WAV decoder --------------------------------------- */
// Mono/stereo 16-bit PCM is the whole format the fixtures use. Anything else
// throws, which is the same answer a browser gives for a file that is not audio.
function decodeWav(arrayBuffer) {
  const b = Buffer.from(arrayBuffer);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = b.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === 'data') data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('not 16-bit PCM');
  const frames = data.length / 2 / fmt.channels;
  return { sampleRate: fmt.rate, numberOfChannels: fmt.channels, length: frames, duration: frames / fmt.rate };
}

/* -- stub graph, same shape as tests/audio-sustained.test.mjs --------------- */
const param = (v = 0) => ({
  value: v,
  setValueAtTime(x) { this.value = x; },
  cancelScheduledValues() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  setTargetAtTime() {},
});
const node = (kind) => {
  const n = {
    kind, out: [], onended: null, buffer: null,
    gain: param(), frequency: param(), Q: param(), detune: param(), playbackRate: param(),
    positionX: param(), positionY: param(), positionZ: param(),
    starts: [], stops: [],
    connect(d) { n.out.push(d); return d; },
    disconnect() {},
    start(t) { n.starts.push(t); },
    stop(t) { n.stops.push(t); },
    setPosition() {},
  };
  return n;
};
function makeAc() {
  const made = [];
  const make = (kind) => { const n = node(kind); made.push(n); return n; };
  return {
    currentTime: 10, sampleRate: 48000, made, state: 'running',
    createGain: () => make('gain'),
    createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'),
    createBufferSource: () => make('src'),
    createPanner: () => make('panner'),
    decodeAudioData: async (ab) => decodeWav(ab),
    endAll() {
      for (const n of made) { if (n.onended) { const f = n.onended; n.onended = null; f(); } }
    },
  };
}
function makeAudio() {
  const a = new Audio();
  a.ac = makeAc();
  a.sfx = node('sfx');
  a.master = node('master');
  a.noiseBuf = {};
  return a;
}
const counters = (a) => [a.voices, a.worldVoices, a.priorityVoices];

// `fetch` off the real filesystem, so a URL the registry cannot resolve fails
// here exactly the way it would in a build.
globalThis.fetch = async (url) => {
  const file = join(root, 'public', url);
  if (!existsSync(file)) return { ok: false, status: 404, arrayBuffer: async () => { throw new Error('404'); } };
  const buf = readFileSync(file);
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));

/* -------------------------------------------------------------------------- */
console.log('-- the registry names exactly the seven sampled voices');
{
  const want = ['carrion-flies', 'scrapfly-hive', 'hive-gland', 'whisper-stalks',
    'battle-hymn', 'gorge-tooth', 'charnel-bloom'];
  const got = SAMPLES.map((s) => s.id);
  ok(got.length === want.length && want.every((id) => got.includes(id)),
    `exactly the seven ids, no more: ${got.join(', ')}`);
  ok(SAMPLES_BY_ID.size === SAMPLES.length, 'the by-id index has no collisions');
  ok(SAMPLES.every((s) => s.url.startsWith(`${SAMPLE_DIR}/`) && !s.url.startsWith('/')),
    'every url is relative, so it also resolves under the desktop app:// origin');
  ok(SAMPLES.every((s) => s.cost >= 1 && s.gain > 0 && s.rateVar >= 0),
    'every entry carries a cost, a base gain and a pitch-variation range');
  // The gate and the charge must be in the same units. A sampled voice is one
  // BufferSource, so a cost above 1 would refuse more budget than it ever
  // charges — an entry that drifts here fails this line, not the mix at 3am.
  ok(SAMPLES.every((s) => s.cost === 1),
    'every cost is 1, matching the single source node the voice actually spends');
}

console.log('\n-- and every committed fixture really decodes');
{
  for (const def of SAMPLES) {
    const file = join(root, 'public', def.url);
    if (!existsSync(file)) { ok(false, `${def.id}: no file at ${def.url}`); continue; }
    let d = null;
    try { const b = readFileSync(file); d = decodeWav(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch (e) { d = e; }
    ok(d && d.length > 0, `${def.id} decodes to ${d?.length ?? d} frames`);
  }
}

console.log('\n-- a cold trigger is silent, and starts the decode');
{
  const a = makeAudio();
  const started = a.playSample('carrion-flies', { x: 1, y: 0, z: 2 });
  ok(started === false, 'the first trigger does not sound — the frame never waits on a decode');
  ok(counters(a).join() === '0,0,0', 'and it charged nothing');
  await a.ensureSamples();
  ok(a._sampleBufs.size === SAMPLES.length, `all ${SAMPLES.length} buffers cached after ensureSamples`);
}

console.log('\n-- a warm trigger takes budget and gives every unit back');
{
  const a = makeAudio();
  await a.loadSample('battle-hymn');
  ok(counters(a).join() === '0,0,0', 'loading alone charges nothing');

  const def = SAMPLES_BY_ID.get('battle-hymn');
  ok(a.playSample('battle-hymn', { x: 3, y: 1, z: -4 }) === true, 'the warm trigger sounds');
  ok(a.voices === def.cost && a.worldVoices === def.cost,
    `charged its declared cost of ${def.cost} to the world budget (saw ${a.worldVoices})`);
  ok(a.priorityVoices === 0, 'the player reserve is untouched by a world sample');

  const src = a.ac.made.find((n) => n.kind === 'src');
  ok(src && src.buffer && src.buffer.length > 0, 'the voice is playing the decoded buffer');
  ok(src.starts.length === 1, 'it was started exactly once');
  const panner = a.ac.made.find((n) => n.kind === 'panner');
  ok(panner && panner.out.includes(a.sfx),
    'and it rides the same SFX bus through the same panner as a synthesized voice');
  const lo = 1 - def.rateVar, hi = 1 + def.rateVar;
  ok(src.playbackRate.value >= lo && src.playbackRate.value <= hi,
    `pitch varies within the entry's range (${src.playbackRate.value.toFixed(3)} in [${lo}, ${hi}])`);

  a.ac.endAll();
  ok(counters(a).join() === '0,0,0', 'and every unit came back when the voice ended');
}

console.log('\n-- the budget can refuse a sample exactly as it refuses a burst');
{
  const a = makeAudio();
  await a.loadSample('gorge-tooth');
  a.worldVoices = 44; // WORLD_VOICES
  const before = counters(a).join();
  ok(a.playSample('gorge-tooth', { x: 0, y: 0, z: 0 }) === false, 'a full world budget refuses the sample');
  ok(counters(a).join() === before, 'and the refusal charged nothing');
  ok(a._refusals === 1, 'the refusal is visible to the audio probes');
}

console.log('\n-- a load failure is silent, terminal, and logged once');
{
  const a = makeAudio();
  const def = SAMPLES_BY_ID.get('hive-gland');
  const realUrl = def.url;
  def.url = `${SAMPLE_DIR}/__no-such-recording__.wav`;
  warns.length = 0;
  try {
    const buf = await a.loadSample('hive-gland');
    ok(buf === null, 'the failed load resolves to null rather than rejecting into a gameplay handler');
    ok(warns.length === 1, `it warned exactly once (saw ${warns.length})`);
    ok(counters(a).join() === '0,0,0' && a._takes === 0,
      'a failed decode leaves every counter untouched — no take, no charge');
    ok(a.playSample('hive-gland', { x: 0, y: 0, z: 0 }) === false, 'and the trigger is an inert no-op');
    ok(counters(a).join() === '0,0,0', 'which also charges nothing');
    await a.loadSample('hive-gland');
    ok(warns.length === 1, 'the failure is terminal: no second fetch, no second warning');
    ok(a.ac.made.length === 0, 'a silent sample builds no nodes at all');
  } finally {
    def.url = realUrl;
  }
}

console.log('\n-- an unknown id is a no-op, never a throw');
{
  const a = makeAudio();
  ok(a.playSample('no-such-effect', { x: 0, y: 0, z: 0 }) === false, 'unknown ids return false');
  ok(counters(a).join() === '0,0,0' && a._takes === 0, 'and touch nothing');
  ok((await a.loadSample('no-such-effect')) === null, 'loading one resolves null');
}

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
