/**
 * Deterministic screenshot harness.
 *
 * Boots the dev server, opens the game in headless Chromium with a fixed seed,
 * drives it into a set of named scenarios via the `__GAME__` hook, and writes
 * PNGs to shots/. Also captures console errors so a black screenshot is never
 * mistaken for an art problem.
 *
 *   node tools/capture.mjs [--out shots] [--seed 1337] [--only combat,vista]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

// Walk argv token by token. An earlier version joined and split on '--', which
// silently mangled any value containing a double dash — including Windows paths
// passed to --out.
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const eq = tok.indexOf('=');
  if (eq !== -1) { args[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const OUT = path.resolve(args.out ?? 'shots');
const SEED = Number(args.seed ?? 1337);
const ONLY = args.only ? String(args.only).split(',') : null;
const W = Number(args.width ?? 1600), H = Number(args.height ?? 900);
// SwiftShader rasterises a full post-stack frame at ~0.1fps, which is too slow
// to even catch one committed frame. Default to the real GPU (headed) and keep
// software rendering as an explicit opt-in for CI-style machines.
const SOFTWARE = 'software' in args;
const SHOT_TIMEOUT = Number(args.shotTimeout ?? (SOFTWARE ? 180000 : 30000));

// Each scenario is driven entirely inside the page so it stays deterministic:
// no wall-clock waits that could land mid-animation on a slow machine.
const SCENARIOS = [
  {
    name: '01-title',
    doc: 'First frame the player sees. Menu framing and background composition.',
    setup: async (page) => { await settle(page, 90); },
  },
  {
    name: '02-vista',
    doc: 'Wide establishing shot of the stage. Judges terrain, lighting, fog, sky.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.vista?.());
      await settle(page, 90);
    },
  },
  {
    name: '03-thirdperson',
    doc: 'Default gameplay framing, player idle. Judges character read and camera.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.gameplay?.());
      await settle(page, 90);
    },
  },
  {
    name: '04-combat',
    doc: 'Mid-fight with a horde, firing. Judges VFX layering, enemy legibility, HUD under load.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
      await settle(page, 150);
    },
  },
  {
    name: '05-boss',
    doc: 'Teleporter event with the boss active. Judges scale, boss silhouette, boss HUD.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.boss?.());
      await settle(page, 150);
    },
  },
  {
    name: '06-loaded-hud',
    doc: 'Late-run HUD with a full inventory and high difficulty. Judges UI density and hierarchy.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.lateRun?.());
      await settle(page, 90);
    },
  },
  {
    name: '07-interactables',
    doc: 'Chest / shrine / item pickup close-up. Judges prop modelling and pickup VFX.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.interactables?.());
      await settle(page, 90);
    },
  },
  {
    name: '08-explosion',
    doc: 'Peak VFX moment: explosion + damage numbers + shake. Judges impact feedback.',
    setup: async (page) => {
      await page.evaluate(() => globalThis.__HARNESS__?.explosion?.());
      await settle(page, 12);
    },
  },
];

/**
 * Advance `frames` rendered frames so captures land on a known state.
 *
 * Capped by wall time as well: headless runs on SwiftShader, where a full
 * GTAO+bloom+SMAA frame at 1080p can take ~1s. Waiting on frame count alone
 * turns an 8-scenario run into 20 minutes of nothing.
 */
async function settle(page, frames, maxMs = 20000) {
  await page.evaluate(
    ([n, cap]) => new Promise((res) => {
      let i = 0;
      const deadline = performance.now() + cap;
      const step = () => (++i >= n || performance.now() > deadline ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }),
    [frames, maxMs]
  );
}

const t0 = Date.now();
const log = (...a) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s]`, ...a);

log('starting vite...');
// HMR off, deliberately. With it on, any file saved by a concurrently-running
// agent full-reloads the page mid-capture and resets the game to the title
// screen — producing a plausible-looking wrong screenshot with `ready: true`
// and zero errors in the manifest. Silent wrong output is the worst failure a
// harness can have.
const server = await createServer({
  server: { port: 5199, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
log('vite up; launching chromium...');

const browser = await chromium.launch({
  timeout: 120000,
  // Headed so Chromium binds the real adapter — the headless shell has no GPU
  // path on Windows, and WebGL silently falls back to SwiftShader.
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl']
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit'],
});

log('chromium up; opening page...');
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));

// Clear only what we generate. An earlier version wiped the whole directory
// and destroyed a review report that lived alongside the images.
await mkdir(OUT, { recursive: true });
for (const f of await readdir(OUT).catch(() => [])) {
  if (f.endsWith('.png') || f === 'manifest.json') await rm(path.join(OUT, f), { force: true });
}

log('navigating...');
await page.goto(`http://127.0.0.1:5199/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
log('loaded; waiting for stage...');

// The game signals readiness itself; a fixed sleep would race stage generation.
const ready = await page
  .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 })
  .then(() => true)
  .catch(() => false);

const manifest = { seed: SEED, ready, shots: [], errors: [] };

if (!ready) {
  manifest.errors = errors;
  await page.screenshot({ path: path.join(OUT, '00-FAILED-TO-BOOT.png') });
} else {
  for (const s of SCENARIOS) {
    if (ONLY && !ONLY.some((o) => s.name.includes(o))) continue;
    const before = errors.length;
    log(`scenario ${s.name}...`);
    try {
      await s.setup(page);
      const file = path.join(OUT, `${s.name}.png`);
      await page.screenshot({ path: file, timeout: SHOT_TIMEOUT, animations: 'disabled' });
      // A system that throws is now degraded rather than fatal, so a stale or
      // half-dead frame no longer announces itself. Record the engine's own
      // error telemetry per shot instead of trusting the image to look wrong.
      const engine = await page.evaluate(() => {
        const c = globalThis.__GAME__?.ctx;
        return { frameErrors: c?.frameErrors ?? 0, lastFrameError: c?.lastFrameError ?? null, time: c?.time ?? 0 };
      });
      manifest.shots.push({ name: s.name, doc: s.doc, file, engine, newErrors: errors.slice(before) });
    } catch (e) {
      manifest.shots.push({ name: s.name, doc: s.doc, error: String(e) });
    }
  }
  manifest.errors = errors;

  // render.calls/triangles read here would only reflect the composer's final
  // fullscreen quad, so report the stable counters instead.
  manifest.perf = await page.evaluate(() => {
    const g = globalThis.__GAME__;
    const r = g?.ctx?.pipeline?.renderer?.info;
    if (!r) return null;
    let objects = 0;
    g.ctx.scene.traverse(() => objects++);
    return {
      programs: r.programs?.length ?? 0,
      geometries: r.memory.geometries,
      textures: r.memory.textures,
      sceneObjects: objects,
    };
  });
}

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
await browser.close();
await server.close();

console.log(JSON.stringify({ ready, shots: manifest.shots.map((s) => s.name), errorCount: errors.length, perf: manifest.perf }, null, 2));
if (errors.length) console.log('\nFIRST ERRORS:\n' + errors.slice(0, 8).join('\n---\n'));
process.exit(ready ? 0 : 1);
