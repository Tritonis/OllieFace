/**
 * Shot-harness render-state dump — the receipts for the `04-combat` /
 * `08-explosion` drift diagnosis in the blight-ceiling slice's task 7.
 *
 * The shot diff put those two scenes at 40x and 71x the same-tree noise floor
 * with band 0, world 0 and zero blight patches — i.e. in a state the slice
 * cannot touch. The task-7 report explained that away with specific numbers
 * (grade `uTime`, `uShake`, `uBlastCount`, fov, resolution scale), and the
 * task-7 review correctly refused them: they were transcribed from a console
 * session that left nothing on disk. `tools/capture.mjs` photographs frames and
 * the `shots-` directories are gitignored, so there was no artifact anywhere
 * carrying them.
 *
 * This script exists to put them on disk. It replays `tools/capture.mjs`'s
 * scenario list in capture order, up to and including `08-explosion`, under the
 * same boot flags, the same pinned clock and the same per-scenario screenshot —
 * because the claim is about the state at the *shutter*, and the shutter's wall
 * clock depends on everything photographed before it. After each shutter it
 * reads the render state the diagnosis turns on and writes the lot to JSON.
 *
 * Run it on both trees and diff the two files; that pair is the evidence.
 *
 *   node reviews/round8/blight-state-probe.mjs --out <file.json> [--port 5231]
 *
 * The PNGs are throwaway (the diff maps already live elsewhere) and land in a
 * scratch directory beside the JSON; only the JSON is the artifact.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  args[tok.slice(2)] = process.argv[i + 1];
}
const OUT = path.resolve(args.out ?? 'shot-state.json');
const SHOTS = path.resolve(args.shots ?? path.join(path.dirname(OUT), 'state-probe-frames'));
const PORT = Number(args.port ?? 5231);
const SEED = Number(args.seed ?? 1337);
const W = 1600, H = 900;

// capture.mjs's SCENARIOS in capture order, truncated after 08-explosion. Kept
// as `[name, setup source]` pairs rather than imported because capture.mjs is a
// top-level script with side effects and exports nothing; the sources are
// verbatim copies of that file's `setup` bodies. If capture.mjs's order or
// setups change, this prefix has to change with them — it is a measurement
// instrument for one specific pair of shutters, not a second capture tool.
const PREFIX = [
  ['01-title', 'globalThis.__HARNESS__?.title?.()'],
  ['17-artifacts', 'globalThis.__HARNESS__?.artifacts?.()'],
  ['18-difficulty', 'globalThis.__HARNESS__?.difficulty?.()'],
  ['02-vista', 'globalThis.__HARNESS__?.vista?.()'],
  ['03-thirdperson', 'globalThis.__HARNESS__?.gameplay?.()'],
  ['09-survivors', 'globalThis.__HARNESS__?.survivors?.()'],
  ['14-survivor-select', 'globalThis.__HARNESS__?.survivorSelect?.()'],
  ['15-logbook', 'globalThis.__HARNESS__?.logbook?.()'],
  ['13-biomes-1', 'globalThis.__HARNESS__?.biomeVista?.({ index: 0, restore: false })'],
  ['13-biomes-2', 'globalThis.__HARNESS__?.biomeVista?.({ index: 1, restore: false })'],
  ['13-biomes-3', 'globalThis.__HARNESS__?.biomeVista?.({ index: 2, restore: false })'],
  ['13-biomes-4', 'globalThis.__HARNESS__?.biomeVista?.({ index: 3, restore: true })'],
  ['04-combat', 'globalThis.__HARNESS__?.combat?.({ enemies: 24 })'],
  ['05-boss', 'globalThis.__HARNESS__?.boss?.()'],
  ['07-interactables', 'globalThis.__HARNESS__?.interactables?.()'],
  ['08-explosion', 'globalThis.__HARNESS__?.explosion?.()'],
];

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: [
    '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`,
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));
await mkdir(SHOTS, { recursive: true });

const tBoot = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load' });
const ready = await page
  .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 })
  .then(() => true).catch(() => false);
const bootMs = Date.now() - tBoot;
const pinned = ready
  ? await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60) ?? false)
  : false;

// Read at the shutter. Every grade uniform that is a plain number is dumped
// wholesale rather than by name, so a uniform nobody thought to list cannot be
// the thing that moved and go unnoticed — that is the whole point of the file.
const readState = () => page.evaluate(() => {
  const c = globalThis.__GAME__?.ctx;
  if (!c?.camera) return null;
  const k = c.camera;
  const u = c.pipeline?.passes?.grade?.uniforms ?? null;
  const grade = u
    ? Object.fromEntries(Object.keys(u)
        .filter((n) => typeof u[n]?.value === 'number')
        .map((n) => [n, +u[n].value.toFixed(5)]))
    : null;
  return {
    cam: [k.position.x, k.position.y, k.position.z].map((v) => +v.toFixed(6)),
    quat: [k.quaternion.x, k.quaternion.y, k.quaternion.z, k.quaternion.w].map((v) => +v.toFixed(6)),
    fov: k.fov,
    ctxTime: +(c.time || 0).toFixed(6),
    resScale: globalThis.__HARNESS__?.resScale?.() ?? null,
    dpr: c.pipeline?.renderer?.getPixelRatio?.() ?? null,
    adaptive: c.pipeline?._adaptive ?? null,
    grade,
    blightPatches: c.blight?.patches?.length ?? null,
    band: c.corruption?.band ?? null,
    world: +(c.corruption?.world ?? 0).toFixed(2),
  };
});

const record = {
  seed: SEED, port: PORT, ready, clockPinned: pinned, bootMs,
  viewport: { w: W, h: H },
  note: 'capture.mjs scenario prefix through 08-explosion, same flags and pinned clock; state read at each shutter',
  scenarios: {}, errors: [],
};

if (ready) {
  for (const [name, setup] of PREFIX) {
    process.stdout.write(`scenario ${name}...\n`);
    await page.evaluate(setup);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 30000, animations: 'disabled' });
    record.scenarios[name] = await readState();
  }
}
record.errors = errors;

await writeFile(OUT, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`wrote ${OUT}\n`);
await browser.close();
await server.close();
process.exit(ready ? 0 : 1);
