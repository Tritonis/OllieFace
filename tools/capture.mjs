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
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
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

// Each scenario is driven entirely inside the page. The scenario functions in
// src/core/Harness.js are async: each owns its settle, composes its own frame,
// and stops the engine loop before resolving. Adding a `settle()` here on top
// of that is what put the shutter 0.63 s past the explosion it existed to
// photograph — the wait belongs next to the effect that knows how long it
// lives, not next to the screenshot call.
//
// This comment used to claim "no wall-clock waits that could land mid-animation
// on a slow machine", and it was wrong. Nothing here waits on the wall clock,
// but the *engine* did: `Engine._frame` takes its delta from a `THREE.Clock`
// and hands it to every `update()`, which is where every VFX lifetime is spent.
// So a shutter counted in rendered frames still landed at a different point in
// an effect's life on every run. See the `pinClock` call below.
const SCENARIOS = [
  {
    name: '01-title',
    doc: 'First frame the player sees. Menu framing and background composition.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.title?.()),
  },
  // Second, and it has to be: `Artifacts.setActive` is pre-run only and latches
  // on the first `stageStart`, which `Progression` raises from `fixedUpdate` —
  // skipped while the title screen holds `ctx.paused`. Any scenario that has
  // called `begin()` has already ended the only window in which artifacts can
  // be chosen, so this runs before the first one does.
  {
    name: '17-artifacts',
    doc: 'Pre-run artifact grid: earned artifacts enabled, unearned ones showing the challenge that opens them. Judges the card grid and the active/locked state pair.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.artifacts?.()),
  },
  // Third, and pre-run for the same reason `17-artifacts` is: the difficulty
  // knob feeds the director's credit rate, so it is chosen here and put back
  // after the shutter. It had no scenario at all until now, which is why an
  // emoji-presentation icon set survived every round of review — a surface no
  // shot looks at is a surface nothing can report on.
  {
    name: '18-difficulty',
    doc: 'Pre-run difficulty ladder with a rung selected. Judges the option-list treatment, the icon set and the selected/unselected state pair.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.difficulty?.()),
  },
  {
    name: '02-vista',
    doc: 'Wide establishing shot of the stage. Judges terrain, lighting, fog, sky.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.vista?.()),
  },
  {
    name: '03-thirdperson',
    doc: 'Default gameplay framing, player idle. Judges character read and camera.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.gameplay?.()),
  },
  // Early on purpose: the roster shot wants a clean HUD behind it, and every
  // scenario from `06-loaded-hud` onward hands the player 37 items and a full
  // inventory panel over the top-left quarter of frame. The scenario removes
  // its four display rigs from the scene *after* stopping the render loop, so
  // nothing later inherits them.
  {
    name: '09-survivors',
    doc: 'The full roster side by side. Judges silhouette read and how distinguishable the four survivors are from one another.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.survivors?.()),
  },
  // The two browsing screens go here for the same reason `09-survivors` does:
  // both are full-bleed overlays over a *live* stage with a translucent scrim,
  // so what is behind them is part of the composition — and from
  // `06-loaded-hud` onward that background is a stage strewn with the leftovers
  // of a twenty-two minute run. `16-run-summary` is the exception and runs
  // dead last; see below.
  {
    name: '14-survivor-select',
    doc: 'Survivor select: the four-strong roster, a rotating 3D portrait, the selected survivor\'s four abilities and roster-relative stat bars. Judges menu hierarchy, typography and whether the new content is legible before a run starts.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.survivorSelect?.()),
  },
  {
    name: '15-logbook',
    doc: 'Logbook, survivors tab, with the 3D model viewer live. Judges the index/detail split, unlock and discovery states, and whether the browsing UI reads as the same product as the HUD.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.logbook?.()),
  },
  // Biome identity: one establishing frame per stage type, each framed on that
  // kit's primary landmark. A single `02-vista` photographs one biome and says
  // nothing about whether the other three are different places, which is the
  // only question these four exist to answer.
  //
  // Early, for the same reason `09-survivors` is: every scenario from
  // `06-loaded-hud` onward leaves a full inventory panel over the top-left
  // quarter of frame, and a landscape shot with a quarter of the landscape
  // behind an item grid grades nothing. Each of these rebuilds the stage, and
  // the last one puts it back on stage 1 *after* its own shutter, so nothing
  // downstream is shot against the wrong world.
  ...[0, 1, 2, 3].map((i) => ({
    name: `13-biomes-${i + 1}`,
    doc: `Establishing shot of biome ${i + 1} of 4, framed on its primary landmark. Judges whether the four stages read as genuinely different places rather than as one generator recoloured.`,
    setup: (page) => page.evaluate(
      ([n, last]) => globalThis.__HARNESS__?.biomeVista?.({ index: n, restore: last }), [i, i === 3]),
  })),
  {
    name: '04-combat',
    doc: 'Mid-fight with a horde, firing. Judges VFX layering, enemy legibility, HUD under load.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 })),
  },
  {
    name: '05-boss',
    doc: 'Teleporter event with the boss active. Judges scale, boss silhouette, boss HUD.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.boss?.()),
  },
  {
    name: '07-interactables',
    doc: 'Chest / shrine / item pickup close-up. Judges prop modelling and pickup VFX.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.interactables?.()),
  },
  {
    name: '08-explosion',
    doc: 'Peak VFX moment: explosion + damage numbers + shake. Judges impact feedback.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.explosion?.()),
  },
  // Bestiary and boss telegraph go before `lateRun` for the same reason
  // everything below it goes after: these are monster shots, and a full
  // inventory panel over the corner of a silhouette line-up is not a state
  // that documents anything.
  {
    name: '11-bestiary',
    doc: 'The whole spawn roster in one rank, small to large, with two tier-2 elites. Judges silhouette variety and scale spread.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.bestiary?.()),
  },
  {
    name: '12-boss-phases',
    doc: 'A late-phase boss frozen at 85% of a wind-up. Judges boss silhouette at scale and telegraph legibility.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.bossPhases?.()),
  },
  // Runs last on purpose, despite the file name. `lateRun` gives the player
  // every item in the game, 4200 gold and 22 minutes on the difficulty clock,
  // and nothing takes them away again — with this in its numbered position, the
  // two shots after it carried a full inventory panel over the top-left quarter
  // of frame and a HARD x3.2 meter, which is neither what they document nor a
  // state the player could be in there.
  {
    name: '06-loaded-hud',
    doc: 'Late-run HUD with a full inventory and high difficulty. Judges UI density and hierarchy.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.lateRun?.()),
  },
  // Also after `lateRun`, and for the same reason: it loads the player with
  // every item in the game and never unloads them.
  {
    name: '10-inventory',
    doc: 'Dense late-run inventory across every tier, with an equipment nuke firing. Judges item icon craft, tier legibility and equipment effect quality.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.inventory?.()),
  },
  // Dead last, literally. This scenario reaches the summary the way a player
  // does — by taking a lethal hit — which ends the run, latches
  // `Progression._ended` and leaves the player dead. Nothing can be
  // photographed after it, so nothing is scheduled after it.
  {
    name: '16-run-summary',
    doc: 'Run-end summary after a real death: survivor, difficulty, artifacts, time, stages, kills, damage, the run\'s item haul and anything earned. Judges whether the run reads back as a story rather than a number dump.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.runSummary?.()),
  },
];

// A `settle(page, frames, maxMs)` helper used to live here, unreferenced since
// every scenario took ownership of its own settle. It is deleted rather than
// left: a dead timing helper in the file that documents the shot timings is a
// second, wrong answer to "how does a shot decide when to fire", and the last
// two rounds of this harness were lost to timing documentation that did not
// match the code.

const t0 = Date.now();
const log = (...a) => console.log(`[${String((Date.now() - t0) / 1000).padStart(6)}s]`, ...a);

// Keep verification runs off the user's desktop. Set CAPTURE_VISIBLE=1 to watch.
// Duplicated in perf.mjs/spawnprobe.mjs rather than shared: importing it from
// here would execute this file's top-level capture run as a side effect.
const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', `--window-size=${W},${H}`];

log('starting vite...');
// HMR off, deliberately. With it on, any file saved by a concurrently-running
// agent full-reloads the page mid-capture and resets the game to the title
// screen — producing a plausible-looking wrong screenshot with `ready: true`
// and zero errors in the manifest. Silent wrong output is the worst failure a
// harness can have.
// Port is an argument because several agents run captures at once and a
// hardcoded one makes the second run die on EADDRINUSE — or, worse, quietly
// attach to the first run's server.
const PORT = Number(args.port ?? 5199);
const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
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
    : [
        '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
        '--disable-frame-rate-limit',
        // On a switchable-graphics laptop Chromium otherwise brings its GPU
        // process up on the integrated adapter and never leaves it, which had
        // these captures rendering ULTRA on an Intel UHD 630 at ~9fps. The
        // context-level `powerPreference` cannot override it — the decision is
        // made per GPU process, before any page script runs.
        '--force_high_performance_gpu',
        // Parked off the visible desktop. Headed is required for the GPU path,
        // but a window that flashes up on every verification run is hostile to
        // whoever is using the machine. Off-screen still composites on the GPU;
        // minimising would throttle rAF and corrupt the timings.
        ...OFFSCREEN,
      ],
});

log('chromium up; opening page...');
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? ''}`));

// Clear only what we are about to regenerate. An earlier version wiped the
// whole directory and destroyed a review report that lived alongside the
// images; the version after that respected non-PNGs but still deleted all eight
// shots on an `--only combat` run, so a targeted re-shoot silently threw away
// the seven frames the reviewers were mid-way through judging.
const WANTED = new Set(
  SCENARIOS.filter((s) => !ONLY || ONLY.some((o) => s.name.includes(o))).map((s) => `${s.name}.png`)
);
await mkdir(OUT, { recursive: true });

log('navigating...');
const tBoot = Date.now();
// `pinclock` is read by `installHarness`, which runs before the engine's first
// frame. Pinning from here instead would leave every frame between page load
// and stage-ready timed by the wall clock, and a variable number of them.
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load' });
log('loaded; waiting for stage...');

// The game signals readiness itself; a fixed sleep would race stage generation.
// The 60 s budget is a boot guard, not a wait: measured 8.7 s from navigate to
// a live stage on this machine's GPU path.
const ready = await page
  .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 })
  .then(() => true)
  .catch(() => false);
const bootMs = Date.now() - tBoot;

/* Delete on *having captured*, not on intending to.
 *
 * The clear used to run before this line — before the navigate, and before
 * anything knew whether the app boots. Six agents share this tree, so at any
 * moment one of them may be mid-write and the module graph momentarily
 * unparseable; a capture started in that window deleted a completed capture and
 * replaced it with nothing. Two finished captures were lost that way, and the
 * directory left behind asserted "this is the capture" when what had happened
 * was "the capture did not happen" — the same shape as an aggregate hiding an
 * absence, one level up from the subject gates.
 *
 * So a failed boot now touches nothing it did not create: the previous PNGs and
 * the previous `manifest.json` are still there, and the failure announces itself
 * as `00-FAILED-TO-BOOT.png` plus `manifest.FAILED.json` beside them. A reader
 * can tell the two states apart on disk, which is the property that was missing.
 *
 * `carried` is read here for the same reason: on an `--only` run it merges the
 * untouched shots forward out of the manifest that is about to be overwritten,
 * and reading it after the boot check keeps it paired with the delete.
 */
const carried = ready && ONLY
  ? await readFile(path.join(OUT, 'manifest.json'), 'utf8')
      .then((t) => JSON.parse(t).shots?.filter((s) => !WANTED.has(`${s.name}.png`)) ?? [])
      .catch(() => [])
  : [];
if (ready) {
  for (const f of await readdir(OUT).catch(() => [])) {
    if (WANTED.has(f) || f === 'manifest.json' || f === 'manifest.FAILED.json'
        || f === '00-FAILED-TO-BOOT.png') {
      await rm(path.join(OUT, f), { force: true });
    }
  }
}

// Pin the frame delta before any scenario runs.
//
// The engine takes its delta from a `THREE.Clock`, hands it to every
// `update()` — which is where all presentation lives — and advances `ctx.time`
// separately, inside a fixed step that hitstop scales by 0.15. So a scenario
// waiting on simulation time to photograph a VFX effect is waiting on a
// different clock from the one the effect ages on, and the gearing between them
// depends on how many monsters happened to die. That is why `10-inventory`'s
// equipment blast failed at 294 px on one run and passed on the next from the
// same seed with no code change. Pinned, one rendered frame is exactly 1/60 s
// of both clocks' inputs and a shot is a function of its seed alone.
const pinned = ready
  ? await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60) ?? false)
  : false;
if (ready && !pinned) console.log('WARNING: capture clock not pinned — shots may vary run to run');

const manifest = {
  seed: SEED, ready, clockPinned: pinned,
  ms: { boot: bootMs, bootTimeout: 60000 },
  shots: [], errors: [], partial: !!ONLY,
};

if (!ready) {
  manifest.errors = errors;
  await page.screenshot({ path: path.join(OUT, '00-FAILED-TO-BOOT.png') });
} else {
  for (const s of SCENARIOS) {
    if (ONLY && !ONLY.some((o) => s.name.includes(o))) continue;
    const before = errors.length;
    log(`scenario ${s.name}...`);
    try {
      // Timed, because every timeout in this file is a claim about how long
      // something takes and none of them had ever been measured. The margins
      // are published per shot so the next person to touch a timeout can see
      // what it is actually guarding.
      const tSetup = Date.now();
      await s.setup(page);
      const setupMs = Date.now() - tSetup;
      const file = path.join(OUT, `${s.name}.png`);
      const tShot = Date.now();
      await page.screenshot({ path: file, timeout: SHOT_TIMEOUT, animations: 'disabled' });
      const shotMs = Date.now() - tShot;
      // A system that throws is now degraded rather than fatal, so a stale or
      // half-dead frame no longer announces itself. Record the engine's own
      // error telemetry per shot instead of trusting the image to look wrong.
      const engine = await page.evaluate(() => {
        const c = globalThis.__GAME__?.ctx;
        return { frameErrors: c?.frameErrors ?? 0, lastFrameError: c?.lastFrameError ?? null, time: c?.time ?? 0 };
      });
      // What the scenario declared its frame had to contain, measured against
      // the rendered pixels. A shot whose subject is absent is a failure here
      // even when nothing threw and the image looks plausible — which is
      // precisely the state `04-combat` and `05-boss` shipped in, with
      // `errorCount: 0` cited by five agents as proof of verification.
      const subject = await page.evaluate(
        (name) => globalThis.__GAME__?.ctx?.harness?.subjects?.[name] ?? null, s.name);
      manifest.shots.push({
        name: s.name, doc: s.doc, file, engine,
        ms: { setup: setupMs, screenshot: shotMs, shotTimeout: SHOT_TIMEOUT },
        subject: subject ?? { ok: false, checks: [], note: 'scenario declared no subject' },
        newErrors: errors.slice(before),
      });
    } catch (e) {
      manifest.shots.push({ name: s.name, doc: s.doc, error: String(e) });
    }
  }
  // Fold the untouched shots back in and restore capture order.
  manifest.shots = [...manifest.shots, ...carried].sort((a, b) => a.name.localeCompare(b.name));
  manifest.errors = errors;
  // Hoisted to the top of the file so it cannot be missed by a reader who only
  // skims. `ready: true` with an empty error list was never a statement that
  // the shots contain their subjects; now there is one that is.
  manifest.subjectFailures = manifest.shots
    .filter((s) => s.subject && !s.subject.ok)
    .map((s) => ({
      name: s.name,
      failed: (s.subject.checks ?? []).filter((c) => !c.ok).map((c) => c.subject),
      detail: (s.subject.checks ?? []).filter((c) => !c.ok),
    }));
  manifest.subjectsOk = manifest.subjectFailures.length === 0;

  // Hoisted for the same reason `subjectFailures` is hoisted, and it is the
  // more important of the two: a failure is already loud, and this is the
  // quiet one. Two kinds of check may pass while carrying an object that
  // rendered zero pixels, and both are legitimate on their face:
  //
  //  - a `crowd: N` subject, which signs a contract for N individually legible
  //    members out of an unbounded population, per its own `crowdWhy`;
  //  - a `minCarriedPx` aggregate, whose objects are shared particle/ring/trail
  //    buffers rather than nameable things, per its own `aggregateWhy`.
  //
  // That is exactly the shape of thing this project has shipped by accident six
  // times (`perPx: [141, 0, 299]` certified against a sum), so the cases where
  // it is *allowed* have to be visible at the top of the file, with the reason
  // attached, rather than buried in a green check. `subjectsOk: true` with a
  // non-empty list here is a manifest asking to be read, not a clean bill of
  // health.
  manifest.toleratedAbsences = manifest.shots.flatMap((s) => (s.subject?.checks ?? [])
    .filter((c) => c.carriesAbsence)
    .map((c) => ({
      name: s.name, subject: c.subject, checkOk: c.ok,
      gate: c.crowd ? `crowd ${c.crowd.need}/${c.perPx?.length ?? '?'} individually gated`
        : 'aggregate: carriedPx only, no per-object gate',
      why: c.crowd?.why ?? c.aggregate ?? null,
      perPx: c.perPx, absent: c.ungatedAbsences,
    })));

  // The one place a settle can silently become wall-clock-dependent is the
  // hang guard inside `frames()`. It counts itself, so a run that hit it says
  // so instead of quietly shipping a truncated wait as a deterministic one.
  manifest.determinism = await page.evaluate(() => globalThis.__HARNESS__?.determinism?.() ?? null);

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

// A failed boot writes its own file rather than overwriting the record of
// whatever capture is already on disk. See the note by the clear above.
await writeFile(path.join(OUT, ready ? 'manifest.json' : 'manifest.FAILED.json'),
                JSON.stringify(manifest, null, 2));
await browser.close();
await server.close();

const failures = manifest.subjectFailures ?? [];
console.log(JSON.stringify({
  ready,
  clockPinned: pinned,
  determinism: manifest.determinism ?? null,
  shots: manifest.shots.map((s) => s.name),
  errorCount: errors.length,
  subjectsOk: manifest.subjectsOk ?? null,
  subjectFailures: failures.map((f) => `${f.name}: ${f.failed.join(', ')}`),
  toleratedAbsences: (manifest.toleratedAbsences ?? []).map(
    (t) => `${t.name}: ${t.subject} [${t.gate}] carries ${t.absent.length} absent `
      + `— ${t.absent.map((o) => `#${o.i}@${o.px}px`).join(' ')}`),
  perf: manifest.perf,
}, null, 2));
if (errors.length) console.log('\nFIRST ERRORS:\n' + errors.slice(0, 8).join('\n---\n'));
if (failures.length) {
  console.log('\nSUBJECT FAILURES:\n' + JSON.stringify(failures, null, 2));
}
// Non-zero on a missing subject as well as on a failed boot. A capture that
// produced twenty plausible-looking images without their subjects is not a
// successful run, and the exit code is the one signal a caller cannot ignore.
process.exit(ready && !failures.length ? 0 : 1);
