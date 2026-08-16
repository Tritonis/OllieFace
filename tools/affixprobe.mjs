/**
 * Per-affix A/B of the elite visual system (rubric axes 4, 6, 8).
 *
 * The design constraint on an elite affix is a conjunction, and both halves
 * have to be measured or you optimise one into the other:
 *
 *   1. it must leave the host's silhouette readable, and
 *   2. it must be identifiable from the other four affixes.
 *
 * Round 5's critic measured `warded` and `withering` at 0.91 IoU against a
 * *perfect circle* and 0.88 against each other, and `emberclad`/`galvanic` as
 * two ~150x140 px opaque balls with blown white cores. Its instrument was a
 * background model over the shipped PNG, which is the best you can do from
 * outside; from inside we can do better.
 *
 * ## Why hide-and-diff, and why one frozen frame
 *
 * The mask here is exact rather than segmented: the frozen frame is rendered
 * once with the host hidden to get a background plate, then once per affix with
 * it visible. `|I - B| > 8` is then the host *and its affix* and nothing else —
 * no background model, no threshold sensitivity study, no neighbouring-enemy
 * contamination. And because all seven renders are of one frozen frame with a
 * single `setAffix` call between them, every pixel that is not the affix is bit
 * identical. `tools/vfxprobe.mjs` explains at length why re-running the
 * scenario instead would measure scene drift at ten times the signal; the same
 * applies here and worse, because `04-combat` does not even reliably compose
 * the same stage twice.
 *
 * ## What it reports, per affix
 *
 *  - `formKeep`  standard deviation of luminance *inside the plain host's own
 *                mask*, affixed over unaffixed. This is requirement 1, and it
 *                is the measurement the round-5 failure actually needed: the
 *                rimebound host in `04-combat` still had an outline, and what it
 *                had lost was every value break inside that outline — "a matte
 *                near-white mass with no internal structure". An affix that
 *                floods the body reads here as a collapse toward 0. Bar: 0.55.
 *  - `growth`    affixed mask area over plain mask area. An affix is allowed to
 *                add furniture around its host; it is not allowed to be three
 *                times the size of the monster it dresses. Bar: 2.6.
 *  - `keepIoU`   IoU of the affixed mask against the plain host mask. Reported
 *                for continuity with the critic's framing, but not gated: an
 *                honest wireframe cage scores low on it for the right reason.
 *  - `discIoU`   IoU against a perfect disc of equal area, centroid-aligned.
 *                The round-5 failure mode, measured the same way it was found.
 *                The bar is 0.78 — the critic's disc-vs-square calibration,
 *                i.e. "no more distinguishable than a circle from a square".
 *  - `white`     near-white desaturated pixels (L > 195, chroma < 40) inside
 *                the host's box, as a fraction of the mask. This is the
 *                erasure measurement: an affix can preserve an outline and
 *                still fill it with an undifferentiated white mass.
 *  - `pairIoU`   the worst pairwise IoU against another affix on the *same
 *                host*. This is requirement 2, and running it on one host is
 *                what removes species shape from the comparison entirely.
 *
 *   node tools/affixprobe.mjs [--seed 1337] [--port 5207] [--out shots-affix]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveOutDir } from './lib/evidence.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5207);
// `shots-affix` matches the `shots-` wildcard in .gitignore; a number quoted
// out of a run that landed there would not survive a clean checkout (#71).
const OUT = resolveOutDir(args.out ?? 'shots-affix', { tool: 'affixprobe' });
const W = 1600, H = 900;
const AFFIXES = ['emberclad', 'galvanic', 'rimebound', 'withering', 'warded'];

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });

// The bestiary scenario, because it is the one that puts the roster on flat
// ground at a chosen camera and then freezes. Everything below runs on the
// frame it leaves behind.
await page.evaluate(() => globalThis.__HARNESS__.bestiary());

// Pick the host: the enemy with the largest projected bounding box that is not
// already wearing an affix, so the measurement has pixels to work with and no
// pre-existing aura to subtract.
const host = await page.evaluate(() => {
  const ctx = globalThis.__GAME__.ctx;
  const THREE = globalThis.__GAME__.THREE;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let best = null;
  for (const e of ctx.director.enemies) {
    if (!e.rig?.root || e.affix) continue;
    box.setFromObject(e.rig.root);
    if (box.isEmpty()) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      v.project(ctx.camera);
      const px = (v.x + 1) * 0.5 * innerWidth, py = (1 - v.y) * 0.5 * innerHeight;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area > best.area) best = { id: e.def?.id ?? '?', area, box: [x0, y0, x1, y1], uid: ctx.director.enemies.indexOf(e) };
  }
  if (best) globalThis.__HOST__ = ctx.director.enemies[best.uid];
  return best;
});
if (!host) { console.error('no un-affixed enemy to dress'); process.exit(1); }
// Pad the box so a bit or a band that reaches outside the body is still counted.
const PAD = 90;
const box = [
  Math.max(0, Math.floor(host.box[0] - PAD)), Math.max(0, Math.floor(host.box[1] - PAD)),
  Math.min(W, Math.ceil(host.box[2] + PAD)), Math.min(H, Math.ceil(host.box[3] + PAD)),
];

await mkdir(OUT, { recursive: true });
const shots = {};
const render = async (key, affix, hide) => {
  await page.evaluate(({ affix, hide }) => {
    const ctx = globalThis.__GAME__.ctx;
    const e = globalThis.__HOST__;
    e.rig.root.visible = !hide;
    if (!hide) e.rig.setAffix(affix);
    ctx.pipeline.render(ctx.scene, ctx.camera, 0);
  }, { affix, hide });
  const buf = await page.screenshot({ type: 'png' });
  await writeFile(path.join(OUT, `${key}.png`), buf);
  shots[key] = `data:image/png;base64,${buf.toString('base64')}`;
  console.log(`rendered ${key}`);
};
await render('bg', null, true);
await render('plain', null, false);
for (const a of AFFIXES) await render(a, a, false);

// ---------------------------------------------------------------- analysis
const analysis = await page.evaluate(async ({ shots, w, h, box, affixes }) => {
  const load = (url) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.src = url; });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const px = {};
  for (const [k, url] of Object.entries(shots)) {
    g.clearRect(0, 0, w, h);
    g.drawImage(await load(url), 0, 0);
    px[k] = g.getImageData(0, 0, w, h).data;
  }
  const [bx0, by0, bx1, by1] = box;
  const bw = bx1 - bx0, bh = by1 - by0;

  /** Exact mask by hide-and-diff against the background plate. */
  const maskOf = (key) => {
    const m = new Uint8Array(bw * bh);
    const d = px[key], b = px.bg;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = ((y + by0) * w + (x + bx0)) * 4;
        const dr = d[i] - b[i], dg = d[i + 1] - b[i + 1], db = d[i + 2] - b[i + 2];
        if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 24) m[y * bw + x] = 1;
      }
    }
    return m;
  };
  const iou = (a, b) => {
    let inter = 0, uni = 0;
    for (let i = 0; i < a.length; i++) { const u = a[i] | b[i]; inter += a[i] & b[i]; uni += u; }
    return uni ? inter / uni : 0;
  };
  /** IoU against a perfect disc of equal area, centred on the mask centroid. */
  const discIoU = (m) => {
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (m[y * bw + x]) { n++; sx += x; sy += y; }
    if (!n) return 0;
    const cx = sx / n, cy = sy / n, r = Math.sqrt(n / Math.PI);
    const d = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) d[y * bw + x] = 1;
    }
    return iou(m, d);
  };
  /** Near-white desaturated fraction inside the mask. */
  const whiteFrac = (key, m) => {
    const d = px[key];
    let n = 0, wh = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!m[y * bw + x]) continue;
      const i = ((y + by0) * w + (x + bx0)) * 4;
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const ch = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      n++;
      if (L > 195 && ch < 40) wh++;
    }
    return { px: n, white: wh, frac: n ? +(wh / n).toFixed(3) : 0 };
  };

  /** Luminance spread inside a fixed mask — "does this still have form". */
  const spread = (key, m) => {
    const d = px[key];
    let n = 0, s = 0, s2 = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!m[y * bw + x]) continue;
      const i = ((y + by0) * w + (x + bx0)) * 4;
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++; s += L; s2 += L * L;
    }
    return n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
  };

  const plain = maskOf('plain');
  const baseSpread = spread('plain', plain);
  const masks = {}; for (const a of affixes) masks[a] = maskOf(a);
  const out = {
    plain: { ...whiteFrac('plain', plain), discIoU: +discIoU(plain).toFixed(3), spread: +baseSpread.toFixed(1) },
    affix: {}, pairs: [],
  };
  for (const a of affixes) {
    out.affix[a] = {
      ...whiteFrac(a, masks[a]),
      keepIoU: +iou(masks[a], plain).toFixed(3),
      discIoU: +discIoU(masks[a]).toFixed(3),
      formKeep: +(baseSpread ? spread(a, plain) / baseSpread : 0).toFixed(3),
      growth: +(out.plain.px ? whiteFrac(a, masks[a]).px / out.plain.px : 0).toFixed(2),
    };
  }
  for (let i = 0; i < affixes.length; i++) {
    for (let j = i + 1; j < affixes.length; j++) {
      out.pairs.push({ a: affixes[i], b: affixes[j], iou: +iou(masks[affixes[i]], masks[affixes[j]]).toFixed(3) });
    }
  }
  out.pairs.sort((x, y) => y.iou - x.iou);
  return out;
}, { shots, w: W, h: H, box, affixes: AFFIXES });

await browser.close();
await server.close();

console.log(`\n=== elite affix A/B on one frozen frame (seed ${SEED}) ===`);
console.log(`host: ${host.id}, box ${box.join(',')}  (${box[2] - box[0]}x${box[3] - box[1]} px window)`);
console.log(`plain host: ${analysis.plain.px} px, near-white ${(analysis.plain.frac * 100).toFixed(1)}%, discIoU ${analysis.plain.discIoU}, luminance spread ${analysis.plain.spread}\n`);
console.log('affix          mask px  growth  formKeep  discIoU  near-white  keepIoU');
for (const a of AFFIXES) {
  const o = analysis.affix[a];
  console.log(`  ${a.padEnd(13)}${String(o.px).padStart(7)}   ${o.growth.toFixed(2)}    ${o.formKeep.toFixed(3)}    ${o.discIoU.toFixed(3)}     ${(o.frac * 100).toFixed(1)}%      ${o.keepIoU.toFixed(3)}`);
}
console.log('\nworst pairwise IoU between affixes on the same host:');
for (const p of analysis.pairs.slice(0, 4)) console.log(`  ${p.iou.toFixed(3)}  ${p.a} <-> ${p.b}`);

const fail = [];
for (const a of AFFIXES) {
  const o = analysis.affix[a];
  if (o.formKeep < 0.55) fail.push(`${a} flattens its host's internal form (formKeep ${o.formKeep})`);
  if (o.growth > 2.6) fail.push(`${a} is ${o.growth}x the size of its host`);
  if (o.discIoU >= 0.78) fail.push(`${a} reads as a circle (discIoU ${o.discIoU})`);
  if (o.frac > 0.20) fail.push(`${a} is ${(o.frac * 100).toFixed(0)}% near-white`);
}
for (const p of analysis.pairs) {
  if (p.iou >= 0.88) fail.push(`${p.a} and ${p.b} are the same shape (${p.iou})`);
}
console.log(fail.length ? `\nFAIL — ${fail.join('; ')}` : '\nPASS — every affix preserves its host and differs from the others');
console.log(`\nPNGs in ${OUT}`);
process.exit(fail.length ? 1 : 0);
