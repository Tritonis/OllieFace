/**
 * The sales unit: a ten-second clip of a live harness arm.
 *
 * Same discipline as tools/gaugeshot.mjs: real vite server, real page, the
 * real game through __GAME__/__HARNESS__, a record JSON whose checks gate the
 * exit code. The one addition is motion: the page runs inside a context with
 * recordVideo, the arm composes its scene, and instead of freezing for a
 * shutter the engine free-runs `--secs` of pinned simulation before the
 * context closes and playwright finalises the webm.
 *
 * The clock is pinned at 1/60, so N seconds of simulation is 60N engine
 * frames -- but the *video* records at wall-clock rate. That is correct for a
 * sales clip: the capture GPU runs the real frame rate, and pinning only
 * guarantees the simulation's timeline is the same every take.
 *
 *   node tools/clipshot.mjs [--arm blightEdge] [--secs 10] [--seed 1337]
 *                           [--port 5221] [--out shotlib/clips] [--software]
 *                           [--armopts '{"settleFrames":30}']
 *
 * `--armopts` is a JSON object passed straight through as the arm's argument.
 * Arms are tuned for a STILL's shutter -- `blightEdge` spends 150 settle frames
 * letting the rim grow before it composes, which is right for a photograph and
 * wrong for a clip, because the crawl the clip exists to show is then almost
 * over when filming starts. Lowering `settleFrames` hands the growth to the
 * camera. Default: no argument at all, so an unflagged run is byte-for-byte the
 * old behaviour.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const ARM = String(args.arm ?? 'blightEdge');
const SECS = Number(args.secs ?? 10);
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5221);
const OUTDIR = path.resolve(String(args.out ?? 'shotlib/clips'));
const SOFTWARE = 'software' in args;
const ARMOPTS_RAW = typeof args.armopts === 'string' ? args.armopts : null;
let ARMOPTS = null;
if (ARMOPTS_RAW !== null) {
  try { ARMOPTS = JSON.parse(ARMOPTS_RAW); } catch (e) {
    console.error(`--armopts is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  if (ARMOPTS === null || typeof ARMOPTS !== 'object' || Array.isArray(ARMOPTS)) {
    console.error('--armopts must be a JSON object, e.g. \'{"settleFrames":30}\'');
    process.exit(2);
  }
}
const W = 1600, H = 900;
mkdirSync(OUTDIR, { recursive: true });

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  -- ${JSON.stringify(detail)}`}`);
};

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=swiftshader', `--window-size=${W},${H}`]
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--force_high_performance_gpu',
      '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
// NB: capture.mjs's headed profile also passes --disable-frame-rate-limit,
// because stills want speed. A CLIP must not: with rAF uncapped and the sim
// pinned at 1/60, ten sim-seconds would fast-forward through however little
// wall time the GPU allows. Vsync capping rAF at the display refresh is what
// makes the recorded motion real; the wall-clock check below enforces it.
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
  recordVideo: { dir: OUTDIR, size: { width: W, height: H } },
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });

let record = null, videoPath = null, armRecord = null;
try {
  // pinclock=1 in the URL, the capture.mjs way (capture.mjs:293-296, honored
  // at Harness.js:2475): the clock is pinned before the FIRST frame, so no
  // boot frame is ever wall-timed. No pinClock evaluate needed.
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  // The arm composes its scene and freezes; we thaw and let it play.
  armRecord = await page.evaluate(
    ([arm, opts]) => (opts === null
      ? globalThis.__HARNESS__?.[arm]?.()
      : globalThis.__HARNESS__?.[arm]?.(opts)),
    [ARM, ARMOPTS]);
  check('the arm exists and composed a scene', armRecord != null, { arm: ARM, armopts: ARMOPTS });
  const wall0 = Date.now();
  await page.evaluate(async (frames) => {
    const Hz = globalThis.__HARNESS__;
    Hz.thaw();
    await Hz.frames(frames, 300000);
    Hz.freeze();
  }, Math.round(SECS * 60));
  const wallSecs = (Date.now() - wall0) / 1000;
  record = await page.evaluate(() => ({
    simTime: +(globalThis.__GAME__.ctx.time ?? 0).toFixed(3),
    frameErrors: globalThis.__GAME__.ctx.frameErrors ?? 0,
    determinism: globalThis.__HARNESS__.determinism(),
  }));
  record.wallSecs = +wallSecs.toFixed(2);
  videoPath = await page.video().path();
} finally {
  await context.close();   // finalises the webm before browser.close
  await browser.close();
  await server.close();
}

const finalPath = path.join(OUTDIR, `${ARM}-${SEED}.webm`);
renameSync(videoPath, finalPath);
const bytes = statSync(finalPath).size;
check('the clip exists and has substance', bytes > 200000, { bytes, path: finalPath });
check('the clock stayed pinned', record?.determinism?.clockPinned === true, record?.determinism);
check('no frame errors (subject gates held)', record?.frameErrors === 0, record?.frameErrors);
// mustContain never throws (Harness.js:2104-2107) -- it raises
// ctx.frameErrors and returns. Without this check the tool is blind to the
// one failure mode the arm was built to detect.
check('the take ran at wall-clock rate (~60 Hz display assumed)',
  record?.wallSecs >= SECS * 0.8 && record?.wallSecs <= SECS * 1.4,
  { wallSecs: record?.wallSecs, secs: SECS });
check('no page errors', pageErrors.length === 0, pageErrors);

const failed = checks.filter((c) => !c.pass).length;
writeFileSync(path.join(OUTDIR, `${ARM}-${SEED}.json`), `${JSON.stringify({
  tool: 'tools/clipshot.mjs',
  // The regeneration command has to carry the arm options, or the record
  // documents a take nobody can reproduce. Single-quoted JSON: correct in
  // bash and in PowerShell, both of which pass it through verbatim.
  command: `node tools/clipshot.mjs --arm ${ARM} --secs ${SECS} --seed ${SEED}`
    + (ARMOPTS ? ` --armopts '${JSON.stringify(ARMOPTS)}'` : '')
    + (SOFTWARE ? ' --software' : ''),
  armopts: ARMOPTS,
  renderer: SOFTWARE ? 'swiftshader (headless)' : 'd3d11 (headed)',
  viewport: { w: W, h: H },
  secs: SECS, seed: SEED,
  clip: finalPath, bytes,
  // The arm's own return, verbatim and unread by this tool. It is the state
  // the take OPENS on -- for `blightEdge`, the rim radius the camera starts
  // filming at -- and without it the manifest's claim about the take's first
  // second is unmeasurable after the fact.
  arm: armRecord,
  sim: record, checks, pageErrors,
  ok: failed === 0,
}, null, 2)}\n`);
console.log(`\nwrote ${finalPath}`);
console.log(`${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
