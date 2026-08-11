/**
 * Screenshot harness for the hidden realms and the finale.
 *
 * Deliberately a second tool rather than more entries in `tools/capture.mjs`:
 * that file's twenty scenarios are one long stateful sequence (the late-run
 * shots hand the player every item in the game and never take them away), and
 * these nine need a *clean run* they can end twice. Sharing a page with them
 * would mean photographing the finale over a full inventory panel and a
 * finished run.
 *
 * Same contract as capture.mjs in every way that matters: fixed seed, driven
 * entirely inside the page, per-shot engine telemetry, and a `subjectsOk` gate
 * that fails the run when a frame does not contain what it claims to.
 *
 *   node tools/capture-realms.mjs [--out shots/realms] [--seed 1337] [--only market]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const eq = tok.indexOf('=');
  if (eq !== -1) { args[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const OUT = path.resolve(args.out ?? path.join('shots', 'realms'));
const SEED = Number(args.seed ?? 1337);
const ONLY = args.only ? String(args.only).split(',') : null;
const W = Number(args.width ?? 1600), H = Number(args.height ?? 900);
const SOFTWARE = 'software' in args;
const SHOT_TIMEOUT = Number(args.shotTimeout ?? (SOFTWARE ? 180000 : 45000));

// Order is load-bearing and is the run itself, in sequence:
//   gateways in a stage -> each realm -> the obelisk ending -> reset ->
//   the finale's three phases -> the victory ending.
// The two endings both latch `Progression._ended`, so the alternative one is
// photographed first and the run is explicitly put back on its feet after it.
const SCENARIOS = [
  {
    name: '21-realm-gateways',
    doc: 'The three realm entrances standing in an ordinary stage: Tithe Altar, Trial Obelisk, Gilded Beacon. Judges whether an optional doorway reads as findable without reading as a HUD marker.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.realmGateways?.()),
  },
  {
    name: '22-realm-market',
    doc: 'The Hollow Market: a lantern-lit hub with three deterministic stalls, the refinery and the Obelisk of Departure. Judges whether a no-combat room reads as a different pace and a different place.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.realmMarket?.()),
  },
  {
    name: '23-realm-crucible',
    doc: 'The Crucible mid-wave: a walled iron pit with the survivor firing into a spawned wave. Judges confinement, under-lighting and readability under load in a room with no terrain to hide behind.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.realmCrucible?.()),
  },
  {
    name: '24-realm-vault',
    doc: 'The Gilded Vault: the sealed prize on its dais with the Vault Warden between the player and it. Judges the single-elite encounter framing and the gold/black material key.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.realmVault?.()),
  },
  {
    name: '29-ending-obliterate',
    doc: 'The alternative ending: both presses on the Obelisk of Departure, the run committed as a deliberate end, and the existing run-summary screen. Judges that a second ending exists and routes.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.endingObliterate?.()),
  },
  {
    name: '__reset',
    hidden: true,
    doc: 'Harness-only: put the finished run back on its feet so the finale can be photographed on the same page.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.resetRun?.()),
  },
  {
    name: '25-finale-phase1',
    doc: 'The Herald of the Rift on the full Fracture arena. Judges the final boss silhouette at 6.8 m against a void backdrop and whether it reads as distinct from the six teleporter bosses.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.finalePhase1?.()),
  },
  {
    name: '26-finale-phase2',
    doc: 'Phase 2: the rim has collapsed from 34 m to 22 m and three warded Rift Anchors hold the Herald immune. Judges whether the arena change is legible as a rule change rather than as scenery.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.finalePhase2?.()),
  },
  {
    name: '27-finale-phase3',
    doc: 'Phase 3: floor reduced to a 14 m core plus three islands, healing suppressed. Judges the final shape of the arena and whether the remaining ground reads at a glance.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.finalePhase3?.()),
  },
  {
    name: '28-finale-victory',
    doc: 'The victory ending: the Herald dead, the outro run, a victory record committed to the profile and the run-summary screen up. Judges that the run has a real destination.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.finaleVictory?.()),
  },
];

const t0 = Date.now();
const log = (...a) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s]`, ...a);

const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', `--window-size=${W},${H}`];

const PORT = Number(args.port ?? 5207);
log('starting vite...');
const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  timeout: 120000,
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl']
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
       '--disable-frame-rate-limit', '--force_high_performance_gpu', ...OFFSCREEN],
});

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));

await mkdir(OUT, { recursive: true });
for (const f of await readdir(OUT).catch(() => [])) {
  if (f.endsWith('.png') || f === 'manifest.json') await rm(path.join(OUT, f), { force: true });
}

log('navigating...');
// `pinclock` is read by `installHarness`, which runs before the engine's first
// frame. Without it, every frame between page load and stage-ready is timed by
// the wall clock — a variable number of them, advancing the sim by a variable
// amount. This param was missing here for the tool's whole life while the
// `pinClock()` call below claimed to pin "exactly as capture.mjs does".
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load' });

const ready = await page
  .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__?.realmMarket != null,
                   null, { timeout: 60000 })
  .then(() => true)
  .catch(() => false);

const manifest = { seed: SEED, ready, clockPinned: false, shots: [], errors: [] };

if (!ready) {
  manifest.errors = errors;
  await page.screenshot({ path: path.join(OUT, '00-FAILED-TO-BOOT.png') });
} else {
  // Pin the frame delta before any scenario runs, matching `tools/capture.mjs`.
  //
  // Record the result rather than assuming it. This tool reported no pinning
  // state at all until 2026-08-01, so `pinClock` silently doing nothing looked
  // identical to it working — the same shape as the two harness bugs round 5
  // opened with: an aggregate hiding an absence. A `clockPinned: false` in the
  // manifest is now the visible zero that was missing.
  const pinned = await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60) ?? false);
  manifest.clockPinned = pinned;
  if (!pinned) console.log('WARNING: realms capture clock not pinned — shots may vary run to run');
  for (const s of SCENARIOS) {
    if (ONLY && !s.hidden && !ONLY.some((o) => s.name.includes(o))) continue;
    const before = errors.length;
    log(`scenario ${s.name}...`);
    try {
      const result = await s.setup(page);
      if (s.hidden) { log(`  reset -> ${JSON.stringify(result)}`); continue; }
      const file = path.join(OUT, `${s.name}.png`);
      await page.screenshot({ path: file, timeout: SHOT_TIMEOUT, animations: 'disabled' });
      const engine = await page.evaluate(() => {
        const c = globalThis.__GAME__?.ctx;
        return { frameErrors: c?.frameErrors ?? 0, lastFrameError: c?.lastFrameError ?? null, time: c?.time ?? 0 };
      });
      const subject = await page.evaluate(
        (name) => globalThis.__GAME__?.ctx?.harness?.subjects?.[name] ?? null, s.name);
      manifest.shots.push({
        name: s.name, doc: s.doc, file, engine, result: result ?? null,
        subject: subject ?? { ok: false, checks: [], note: 'scenario declared no subject' },
        newErrors: errors.slice(before),
      });
    } catch (e) {
      manifest.shots.push({ name: s.name, doc: s.doc, error: String(e) });
    }
  }
  manifest.errors = errors;
  manifest.subjectFailures = manifest.shots
    .filter((s) => s.subject && !s.subject.ok)
    .map((s) => ({
      name: s.name,
      failed: (s.subject.checks ?? []).filter((c) => !c.ok).map((c) => c.subject),
      detail: (s.subject.checks ?? []).filter((c) => !c.ok),
    }));
  manifest.subjectsOk = manifest.subjectFailures.length === 0;
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

const failures = manifest.subjectFailures ?? [];
console.log(JSON.stringify({
  ready,
  shots: manifest.shots.map((s) => s.name),
  errorCount: errors.length,
  subjectsOk: manifest.subjectsOk ?? null,
  subjectFailures: failures.map((f) => `${f.name}: ${f.failed.join(', ')}`),
  results: Object.fromEntries(manifest.shots.map((s) => [s.name, s.result ?? s.error ?? null])),
  perf: manifest.perf,
}, null, 2));
if (errors.length) console.log('\nFIRST ERRORS:\n' + errors.slice(0, 8).join('\n---\n'));
if (failures.length) console.log('\nSUBJECT FAILURES:\n' + JSON.stringify(failures, null, 2));
process.exit(ready && !failures.length ? 0 : 1);
