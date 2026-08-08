/**
 * Perceptual diff between two shot directories.
 *
 * `tools/capture.mjs` is deterministic in *simulation* (pinned clock, fixed
 * seed) but not byte-deterministic in *output*: re-running it on an unchanged
 * tree produces 21 of 21 PNGs with different bytes on this machine. So a hash
 * comparison of two shot runs carries no information at all, and any "clean
 * scenes are pixel-identical" claim has to be made against a measured
 * threshold with a same-tree control run beside it.
 *
 * Emits the manifest shape round 7 used (`reviews/round7/r3-audio/diff-*.json`):
 * per-file meanDiff / maxDiff / pctOver8 plus an aggregate. That script was
 * never committed and had to be rewritten; this one is committed.
 *
 *   node tools/shotdiff.mjs <dirA> <dirB> [--out diff.json]
 *
 * Decoding runs in headless Chromium — the repo has no image library, and the
 * browser is already a dependency.
 */
import { chromium } from 'playwright';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const positional = process.argv.slice(2).filter((t) => !t.startsWith('--'));
const flags = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  flags[t.slice(2)] = n && !n.startsWith('--') ? n : true;
}
const [dirA, dirB] = positional;
if (!dirA || !dirB) { console.error('usage: node tools/shotdiff.mjs <dirA> <dirB> [--out diff.json]'); process.exit(2); }

const names = (await readdir(dirA)).filter((f) => f.endsWith('.png'));
const bNames = new Set((await readdir(dirB)).filter((f) => f.endsWith('.png')));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const b64 = async (p) => (await readFile(p)).toString('base64');
const rows = [];
for (const name of names) {
  if (!bNames.has(name)) { rows.push({ file: name, missingIn: dirB }); continue; }
  const [a, b] = await Promise.all([b64(path.join(dirA, name)), b64(path.join(dirB, name))]);
  const r = await page.evaluate(async ([sa, sb]) => {
    const load = async (s) => {
      const bin = atob(s);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return createImageBitmap(new Blob([buf], { type: 'image/png' }));
    };
    const [ia, ib] = await Promise.all([load(sa), load(sb)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { sizeMismatch: [ia.width, ia.height, ib.width, ib.height] };
    }
    const px = (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height).data;
    };
    const pa = px(ia), pb = px(ib);
    let sum = 0, max = 0, over = 0, n = 0;
    for (let i = 0; i < pa.length; i += 4) {
      // Per-pixel channel-max distance, the same shape the round-7 manifests
      // report: one number per pixel, not per channel.
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      sum += d; if (d > max) max = d; if (d > 8) over++; n++;
    }
    return { meanDiff: +(sum / n).toFixed(3), maxDiff: max, pctOver8: +((over / n) * 100).toFixed(3), pixels: n };
  }, [a, b]);
  rows.push({ file: name, ...r });
  console.log(`  ${name.padEnd(24)} mean ${String(r.meanDiff ?? '-').padStart(8)}  max ${String(r.maxDiff ?? '-').padStart(4)}  %>8 ${String(r.pctOver8 ?? '-').padStart(8)}`);
}
await browser.close();

const scored = rows.filter((r) => r.meanDiff != null);
const out = {
  dirs: [dirA, dirB],
  files: rows.length,
  aggregate: {
    meanDiff: +(scored.reduce((s, r) => s + r.meanDiff, 0) / (scored.length || 1)).toFixed(3),
    pctOver8: +(scored.reduce((s, r) => s + r.pctOver8, 0) / (scored.length || 1)).toFixed(3),
    maxOfMax: scored.reduce((m, r) => Math.max(m, r.maxDiff), 0),
  },
  rows,
};
console.log(`\naggregate ${JSON.stringify(out.aggregate)}`);
if (flags.out) { await writeFile(String(flags.out), JSON.stringify(out, null, 1)); console.log(`wrote ${flags.out}`); }
