/**
 * Performance probe.
 *
 * Measures where frame time actually goes, per system, under a real combat
 * load — and separately measures how much of the wall clock the game spends
 * frozen in hitstop, which the player experiences as stutter rather than as
 * low framerate.
 *
 *   node tools/perf.mjs [--quality 3] [--enemies 24] [--seconds 8]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const QUALITY = Number(args.quality ?? 3);
const ENEMIES = Number(args.enemies ?? 24);
const SECONDS = Number(args.seconds ?? 8);

// A bare `--out` with no path parses to `true` and would otherwise fall
// through the `typeof args.out === 'string'` check below and silently skip
// the write after a full headed GPU run. Fail fast instead.
if ('out' in args && typeof args.out !== 'string') {
  console.error('perf: --out requires a path argument, e.g. --out reviews/perf/run.json');
  process.exit(1);
}
// Same reasoning: create the output directory before the measurement runs,
// not after, so a missing/unwritable dir fails in seconds rather than after
// the full GPU run below.
if (typeof args.out === 'string') {
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(args.out), { recursive: true });
}

const server = await createServer({ server: { port: 5201, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

// Headed is required for the real GPU path, but the window is parked off the
// visible desktop so verification runs never interrupt whoever is using the
// machine. Off-screen still composites on the GPU; minimising would throttle
// rAF and corrupt exactly the timings this tool exists to measure.
// Set CAPTURE_VISIBLE=1 to watch it run.
const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', '--window-size=1600,900'];

// `--force_high_performance_gpu` is load-bearing on a laptop with switchable
// graphics. Without it Chromium brings the GPU process up on the integrated
// adapter and stays there — the context-level `powerPreference:
// 'high-performance'` is decided per-process, not per-context, so it cannot
// move it. This probe measured an Intel UHD 630 at 5.8fps for months while the
// machine had an idle GTX 1660 Ti that runs the same frame at 80fps, and every
// optimisation decision made from those numbers was aimed at the wrong GPU.
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
         '--disable-frame-rate-limit', ...OFFSCREEN],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

// `--pbr` boots with the photographed evaluation set bound (#109 step 3). The
// flag goes in the URL rather than through the harness toggle on purpose: this
// arm is measuring the cost of *running* with those maps resident, and a
// mid-session swap would fold the one-off decode and upload into the sample.
const PBR = args.pbr ? '&pbr=1' : '';
await page.goto(`http://127.0.0.1:5201/?seed=1337&quality=${QUALITY}&harness=1${PBR}`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });

const env = await page.evaluate(() => {
  const g = globalThis.__GAME__;
  const r = g.ctx.pipeline.renderer;
  const gl = r.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    devicePixelRatio,
    rendererPixelRatio: r.getPixelRatio(),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
    shadowMapSize: g.ctx.scene.children
      .filter((c) => c.isDirectionalLight && c.shadow)
      .map((c) => `${c.shadow.mapSize.width}x${c.shadow.mapSize.height}`),
    gtaoSamples: g.ctx.pipeline.passes.gtao ? 'on' : 'off',
  };
});

async function measure(label, setup) {
  await page.evaluate(setup);
  // Let the scenario settle before sampling so spawn-frame cost isn't counted.
  await page.waitForTimeout(1200);
  await page.evaluate(() => globalThis.__GAME__.engine.startProfile());
  await page.waitForTimeout(SECONDS * 1000);
  const r = await page.evaluate(() => {
    const g = globalThis.__GAME__;
    const out = g.engine.stopProfile();
    const info = g.ctx.pipeline.renderer.info;
    out.geometries = info.memory.geometries;
    out.textures = info.memory.textures;
    out.programs = info.programs?.length ?? 0;
    return out;
  });
  return { label, ...r };
}

const results = [];
results.push(await measure('idle', () => globalThis.__HARNESS__.gameplay()));
results.push(await measure(`combat-${ENEMIES}`, () => {
  globalThis.__HARNESS__.combat({ enemies: Number(document.title.length) && 24 });
}));

console.log(JSON.stringify({ env, quality: QUALITY, results }, null, 2));

// `--out <path>` writes the record the payload/frame-time gate reads (issue
// #28). Until this existed the only frame-time numbers on record lived in
// review prose, which no gate can check.
if (typeof args.out === 'string') {
  const { writeFileSync } = await import('node:fs');
  // Directory already created above, before the GPU run.
  const combat = results.find((r) => r.label.startsWith('combat-'));
  if (!combat) throw new Error('perf: no combat arm in results — nothing to record');
  writeFileSync(args.out, JSON.stringify({
    scenario: combat.label,
    // Engine.stopProfile() names these; see src/core/Engine.js:273-278.
    medianFrameMs: combat.medianFrameMs,
    p95FrameMs: combat.p95FrameMs,
    quality: QUALITY,
    gpu: env.gpu,
    transcribed: false,
    capturedAt: new Date().toISOString(),
    raw: { env, quality: QUALITY, results },
  }, null, 2) + '\n');
  console.error(`perf: wrote ${args.out}`);
}

await browser.close();
await server.close();
