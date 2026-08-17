/**
 * What is actually behind the HUD's translucent panels, and what that does to
 * the tier palette's contrast (#78).
 *
 * `tools/colour-vision.mjs` grades every tier colour against eight surfaces.
 * Four are opaque and exact. Four — `--panel`, `--panel-hard`, and the two
 * logbook row washes built on `--panel-hard` — are `rgba()` fills over the live
 * 3D frame, and the gate composites them onto `#05070a` because a stylesheet is
 * the only thing that file can read. `#05070a` is the darkest ground the
 * stylesheet names, so those four ratios are a **best case**: over a lit realm
 * the panel composites lighter and the real ratio falls. The shipped palette
 * clears its worst surface by 0.09, which is not enough headroom to assume the
 * two cases agree.
 *
 * So this measures the lit case. It drives the same scenarios the capture gate
 * uses, and at each one asks the harness (`panelGround`, src/core/Harness.js)
 * for the scene colour under every translucent panel's screen rect — an
 * offscreen render with normal materials, so it is colour-aware, unlike the
 * silhouette masks. Two colours per panel per scene: the `mean`, which is what
 * a viewer sees most of, and the `p95`, the bright tail that the floor actually
 * has to survive.
 *
 * The worst `p95` over every scene and panel is then fed to `gradeContrast` as
 * the composite ground, and the palette is re-graded honestly.
 *
 * This is a **measurement, not a gate**. It reports; it does not fail the
 * build. Whether the number it produces should become a floor is the decision
 * the ticket asks it to inform, and bundling a fix with its own measurement
 * would make neither independently checkable.
 *
 *   node tools/panel-ground.mjs [--port 5251] [--seed 1337] [--out reviews/...]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gradeContrast, relativeLuminance } from './colour-vision.mjs';
import { TIERS, TIER_ORDER } from '../src/ui/Icons.js';

const COMMIT = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const eq = tok.indexOf('=');
  if (eq !== -1) { args[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}

// 5251 by default. Unique by test, not by convention — `tests/probe-ports.test.mjs`
// scans this file and fails if another tool claims the same number.
const PORT = Number(args.port ?? 5251);
const SEED = Number(args.seed ?? 1337);
const W = Number(args.width ?? 1600), H = Number(args.height ?? 900);
const OUT = args.out ? String(args.out) : null;

/**
 * The scenes to sample, and why these.
 *
 * Every one puts the HUD over a lit 3D frame. The four biome vistas are the
 * realm coverage the ticket asks for — a brightness range is the whole point,
 * so a single realm would answer nothing — and `boss`, `combat` and `explosion`
 * are the lit extremes: bloom, muzzle flash, a blast at full brightness. The
 * menu screens (`title`, `difficulty`) are excluded: their panels are opaque
 * `.panel` fills, not the four surfaces under test.
 */
const SCENES = [
  ['biome-1', (p) => p.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 0 }))],
  ['biome-2', (p) => p.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 1 }))],
  ['biome-3', (p) => p.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 2 }))],
  ['biome-4', (p) => p.evaluate(() => globalThis.__HARNESS__?.biomeVista?.({ index: 3, restore: true }))],
  ['vista', (p) => p.evaluate(() => globalThis.__HARNESS__?.vista?.())],
  ['gameplay', (p) => p.evaluate(() => globalThis.__HARNESS__?.gameplay?.())],
  ['combat', (p) => p.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }))],
  ['boss', (p) => p.evaluate(() => globalThis.__HARNESS__?.boss?.())],
  ['explosion', (p) => p.evaluate(() => globalThis.__HARNESS__?.explosion?.())],
  ['loaded-hud', (p) => p.evaluate(() => globalThis.__HARNESS__?.lateRun?.())],
  ['inventory', (p) => p.evaluate(() => globalThis.__HARNESS__?.inventory?.())],
  ['logbook', (p) => p.evaluate(() => globalThis.__HARNESS__?.logbook?.())],
];

const log = (m) => console.log(`[panel-ground] ${m}`);

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
log(`vite up on ${PORT}; launching chromium...`);

const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: [
    '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--force_high_performance_gpu',
    '--window-position=-2400,-2400',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let out = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                  { waitUntil: 'load', timeout: 120000 });
  const ready = await page
    .waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null,
                     null, { timeout: 60000 })
    .then(() => true).catch(() => false);
  if (!ready) throw new Error('the game never reached a live stage');
  log('stage ready; sampling...');

  const samples = [];
  for (const [name, drive] of SCENES) {
    try { await drive(page); } catch (err) { samples.push({ scene: name, error: String(err.message) }); continue; }
    const g = await page.evaluate(() => globalThis.__HARNESS__?.panelGround?.());
    samples.push({ scene: name, ...(g ?? { ok: false, panels: [] }) });
    const lit = (g?.panels ?? []).filter((p) => p.present);
    log(`${name.padEnd(11)} ${lit.length ? lit.map((p) => `${p.selector} mean ${p.mean} p95 ${p.p95}`).join('  ') : '(no translucent panel on screen)'}`);
  }

  /* The worst ground, which is the one the floor has to clear. Ranked by
   * luminance rather than by any single channel: a ground can be brighter
   * without any one byte being larger, and it is the luminance that moves the
   * WCAG ratio. */
  const all = samples.flatMap((s) => (s.panels ?? []).filter((p) => p.present)
    .map((p) => ({ scene: s.scene, selector: p.selector, colour: p.p95, kind: 'p95' })));
  const allMean = samples.flatMap((s) => (s.panels ?? []).filter((p) => p.present)
    .map((p) => ({ scene: s.scene, selector: p.selector, colour: p.mean, kind: 'mean' })));
  if (!all.length) throw new Error('no translucent panel was on screen in any scene; nothing was measured');

  /* Every modelled surface has to have been *seen*, or this run measured
   * whatever happened to be on screen and reported it as coverage.
   *
   * This is the guard for the defect #78's review found: the first version of
   * the selector list carried `.plate`, which no DOM node ever carries, and it
   * sampled zero in all twelve scenes without a word. The numbers happened to
   * survive because `.objective` covers the same `--panel` fill — but a future
   * run that drove a scene set without `.objective` on screen would have
   * reported a clean pass for a surface it never looked at. An instrument that
   * cannot tell "fine" from "never measured" is not an instrument.
   *
   * Fail, loudly, naming the surface and every selector that came back absent,
   * rather than exiting 0 on partial coverage. */
  const declared = await page.evaluate(() => globalThis.__HARNESS__?.panelSurfaces?.() ?? []);
  const seen = new Map();
  for (const s of samples) for (const p of s.panels ?? []) {
    if (!p.surface) continue;
    const e = seen.get(p.surface) ?? { n: 0, selectors: new Set() };
    if (p.present) { e.n++; e.selectors.add(p.selector); }
    seen.set(p.surface, e);
  }
  const unseen = declared.filter((d) => !(seen.get(d.surface)?.n > 0));
  const coverage = declared.map((d) => ({
    surface: d.surface,
    samples: seen.get(d.surface)?.n ?? 0,
    via: [...(seen.get(d.surface)?.selectors ?? [])],
    neverPresent: d.selectors.filter((q) =>
      !samples.some((s) => (s.panels ?? []).some((p) => p.selector === q && p.present))),
  }));
  console.log('\n  coverage — every modelled translucent surface, and what actually sampled it:');
  for (const c of coverage) {
    console.log(`    ${c.surface.padEnd(11)} ${String(c.samples).padStart(3)} samples via ${c.via.join(', ') || '(none)'}${
      c.neverPresent.length ? `   never on screen: ${c.neverPresent.join(', ')}` : ''}`);
  }
  if (unseen.length) {
    throw new Error(
      `these modelled surfaces were never on screen in any driven scene, so nothing was ` +
      `measured for them and this run cannot speak to their contrast: ` +
      unseen.map((d) => `${d.surface} (${d.selectors.join(', ')})`).join('; ') +
      `. Either drive a scene that shows them, or remove them from PANEL_SURFACES ` +
      `in src/core/Harness.js — do not read this run as coverage.`);
  }
  const rank = (xs) => xs.slice().sort((a, b) => relativeLuminance(b.colour) - relativeLuminance(a.colour));
  const worstP95 = rank(all)[0];
  const worstMean = rank(allMean)[0];

  const plates = Object.fromEntries(TIER_ORDER.map((k) => [k, TIERS[k].plate]));
  const shipped = Object.fromEntries(TIER_ORDER.map((k) => [k, TIERS[k].color]));
  const grade = (scene) => {
    const g = gradeContrast(shipped, plates, undefined, scene);
    const translucent = g.checks.filter((c) => ['panel', 'panel-hard', 'book-row', 'book-row-hover'].includes(c.surface));
    return {
      scene,
      ok: g.ok,
      worst: g.checks[0],
      failures: g.checks.filter((c) => !c.ok).map((c) => ({ id: c.id, surface: c.surface, ground: c.ground, ratio: +c.ratio.toFixed(2), min: c.min })),
      worstTranslucent: translucent.sort((a, b) => a.ratio - b.ratio)[0],
    };
  };

  const best = grade('#05070a');
  const mean = grade(worstMean.colour);
  const worst = grade(worstP95.colour);

  console.log('');
  console.log('  ground                       worst translucent surface        verdict');
  for (const [label, r, src] of [
    ['stylesheet black (the gate today)', best, '#05070a'],
    ['brightest scene mean', mean, `${worstMean.colour} (${worstMean.scene} ${worstMean.selector})`],
    ['brightest scene p95', worst, `${worstP95.colour} (${worstP95.scene} ${worstP95.selector})`],
  ]) {
    const w = r.worstTranslucent;
    console.log(`  ${label.padEnd(34)} ${w.id}/${w.surface} ${w.ratio.toFixed(2)}:1 vs ${w.min}   ${r.ok ? 'PASS' : `FAIL (${r.failures.length} checks)`}`);
    console.log(`    ground sampled from ${src}`);
  }
  if (!worst.ok) {
    console.log('\n  failing checks over the brightest measured ground:');
    for (const f of worst.failures) console.log(`    ${f.id.padEnd(10)} ${f.surface.padEnd(16)} on ${f.ground}  ${f.ratio}:1 vs ${f.min}`);
  }

  out = {
    commit: COMMIT, seed: SEED, viewport: [W, H], capturedAt: new Date().toISOString(),
    samples, worstMean, worstP95, coverage,
    grades: { best, mean, worst },
    pageErrors: errors,
  };
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

if (OUT && out) {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  log(`wrote ${OUT}`);
}
// Deliberately exit 0 on an uncomfortable number: this is an instrument, and an
// instrument that fails the build is a gate nobody has agreed to yet.
process.exit(0);
