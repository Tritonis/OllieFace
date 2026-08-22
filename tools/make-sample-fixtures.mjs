/**
 * Writes the placeholder WAVs the sampled-playback registry points at (#148).
 *
 *   node tools/make-sample-fixtures.mjs
 *
 * The real recordings are CC0 candidates a human still has to fetch by hand
 * (freesound needs an account). Until they land, every entry in
 * `src/data/samples.js` names a file that exists, decodes, and is audibly
 * distinct from its neighbours — so the decode, budget and packaging paths are
 * exercised end to end rather than waiting on the art.
 *
 * Replacing a placeholder is a file drop at the same path: nothing in the game
 * or in the registry names a duration, a rate or a channel count.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES, SAMPLE_DIR } from '../src/data/samples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', SAMPLE_DIR);

const RATE = 8000;
const SECONDS = 0.2;

/** A mono 16-bit PCM WAV of `pcm`, which is the whole format we need. */
function wav(pcm, rate) {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);       // PCM chunk size
  head.writeUInt16LE(1, 20);        // format: PCM
  head.writeUInt16LE(1, 22);        // channels
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); // byte rate
  head.writeUInt16LE(2, 32);        // block align
  head.writeUInt16LE(16, 34);       // bits per sample
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (const [i, def] of SAMPLES.entries()) {
  const file = join(root, 'public', def.url);
  if (existsSync(file) && !process.argv.includes('--force')) continue;
  const n = Math.round(RATE * SECONDS);
  const pcm = new Float32Array(n);
  // A decaying blip, one per entry on its own pitch: enough to tell which
  // placeholder is speaking without pretending to be the sound it stands for.
  const f0 = 180 + i * 70;
  for (let s = 0; s < n; s++) {
    const t = s / RATE;
    pcm[s] = Math.sin(2 * Math.PI * f0 * t) * Math.exp(-t * 14) * 0.6;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, wav(pcm, RATE));
  written++;
  console.log(`wrote ${def.url} (${def.id})`);
}
console.log(written ? `${written} placeholder(s) written` : 'every registry sample already has a file');
