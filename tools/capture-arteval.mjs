/**
 * The photographed-asset A/B (#109 step 3, evidence arm).
 *
 * One boot, one stage, one camera, two shutters: the same frame with the
 * evaluation set off and then on. That constraint is the whole reason this
 * exists as its own tool rather than two scenarios spliced into
 * `tools/capture.mjs`:
 *
 *  - Cross-boot frames here do not compare. The gated statistic is non-monotone
 *    in framing and unstable across boots (#122, #114), the shutter phase
 *    drifts, and an identical tree has been measured moving 10 of 23 shots. A
 *    "before" from one process and an "after" from another is not evidence of
 *    anything an asset swap did.
 *  - `capture.mjs`'s scenario array is order-load-bearing — it says so at
 *    length, and every entry draws from one shared RNG stream, so inserting a
 *    pair there re-rolls every shot below it and invalidates the standing
 *    baselines. Nothing in this file touches that array.
 *
 * The game is frozen between the two shutters, so the only difference across
 * the pair is the material swap itself: same enemies, same particles, same
 * phase of every animation.
 *
 *   node tools/capture-arteval.mjs [--out shots-arteval] [--seed 1337] [--port 5237]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const OUT = typeof args.out === 'string' ? args.out : 'shots-arteval';
const SEED = Number(args.seed ?? 1337);
// 5237 sits in the free window between the gate runner (5234-5236) and the
// lane blocks (5240-5269), which is what tests/probe-ports.test.mjs enforces:
// a default inside a lane block silently joins whichever lane is already
// there. Pass --port 5241 to run this inside lane A. 5209 is not a default
// anywhere either, for the same reason (#68).
const PORT = Number(args.port ?? 5237);
const W = 1600, H = 900;

const t0 = Date.now();
const log = (...a) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s]`, ...a);

const server = await createServer({
  server: { port: PORT, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();

const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? [] : ['--window-position=-2400,-2400', `--window-size=${W},${H}`];

const browser = await chromium.launch({
  headless: false,
  args: [...OFFSCREEN, '--use-angle=d3d11', '--force_high_performance_gpu',
         '--enable-unsafe-webgpu', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));

await mkdir(OUT, { recursive: true });
log('navigating...');
// No `pbr=1`: the pair always starts from the shipped build and the flag is
// thrown from inside the session, so the "off" frame is the real flag-off path
// and not a flag-on path with the maps swapped back out.
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load', timeout: 120000 });
const ready = await page
  .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null,
                   null, { timeout: 60000 })
  .then(() => true).catch(() => false);
if (!ready) {
  await writeFile(`${OUT}/manifest.FAILED.json`, JSON.stringify({ ready: false, errors }, null, 2));
  await browser.close(); await server.close();
  console.error('arteval: boot never reached ready');
  process.exit(1);
}

log('staging blight edge...');
await page.evaluate(() => globalThis.__HARNESS__.blightEdge());
// Frozen for the pair. Every difference between the two PNGs below is the
// swap; nothing in the world is allowed to move between them.
await page.evaluate(() => globalThis.__HARNESS__.freeze());

const shots = [];
const shoot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push(name);
  log(`shot ${name}`);
};

await shoot('arteval-a-procedural');

log('binding the evaluation set...');
const bind = await page.evaluate(async () => {
  const t = performance.now();
  const before = performance.getEntriesByType('resource').length;
  await globalThis.__HARNESS__.setPbr(true);
  const res = performance.getEntriesByType('resource').slice(before);
  const bytes = res.reduce((a, r) => a + (r.transferSize || r.encodedBodySize || 0), 0);
  return { ms: Math.round(performance.now() - t), requests: res.length, bytes };
});
// A recompile lands on the next render; give the frozen page a few.
await page.evaluate(() => globalThis.__HARNESS__.frames(6));
await shoot('arteval-b-photographed');

// And back, in the same session: if the "off" state is not restorable the A/B
// is not a toggle, it is a one-way door, and every later comparison is suspect.
await page.evaluate(async () => { await globalThis.__HARNESS__.setPbr(false); });
await page.evaluate(() => globalThis.__HARNESS__.frames(6));
await shoot('arteval-c-procedural-restored');

const manifest = {
  tool: 'capture-arteval', seed: SEED, ready: true,
  capturedAt: new Date().toISOString(),
  gpu: await page.evaluate(() => globalThis.__HARNESS__.gpu()),
  determinism: await page.evaluate(() => globalThis.__HARNESS__.determinism()),
  bind, shots, errors,
};
await writeFile(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
log(`wrote ${OUT}/manifest.json`);

await browser.close();
await server.close();
// Only infrastructure failures are exit-worthy here: this is an eyes arm, and
// the capture gate's verdict rules (docs: CLAUDE.md, capture gate) say a
// subject statistic never adjudicates on its own.
if (errors.length) {
  console.error(`arteval: ${errors.length} page error(s)`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
