// tests/asset-budget.test.mjs
//
// Issue #28: the asset payload and frame-time budget, committed before any art
// lands so the trade is checkable rather than remembered.
//
// Four arms, three of which can fail on data that is in the repo right now:
//
//   1. the prose and the machine-readable budget agree (always runs);
//   2. the GPU resource proxies from the committed capture manifest are inside
//      their ceilings (always runs — the stand-in for a VRAM number nobody has
//      measured yet);
//   3. the recorded combat-24 frame time is inside its ceiling (always runs,
//      against `reviews/asset-budget/perf-combat24.json`);
//   4. a built `dist/` is inside its payload ceilings — and SKIPS LOUDLY when
//      there is no build, because `npm test` must never appear to have checked
//      a payload it never saw.
//
// Why arm 3 lives here and not in the capture arm's manifest checks: the
// capture manifests carry no frame-time field at all. `manifest.perf` is
// programs/geometries/textures/sceneObjects (tools/capture.mjs:586-598) and
// `shot.ms` is capture wall-clock, not render time. The only thing in this repo
// that measures frame time is `tools/perf.mjs`, which until now printed to
// stdout and wrote nothing — which is why every frame-time number on record
// lives in review prose. So the gate checks the perf record, and `perf` is now
// a tracked manual arm in tools/gates.mjs that can go OVERDUE.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBudget, measureDist, buildStaleness, checkPayload, MiB } from '../tools/asset-budget.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const skip = (msg) => { skipped++; console.log('  SKIP ', msg); };

const budget = loadBudget();
const c = budget.ceilings;

console.log('the budget prose and the machine-readable budget agree');
{
  // A ceiling nobody can find is a ceiling nobody honours, and a ceiling that
  // disagrees with itself is worse than none. ASSET-SPEC.md is where a human
  // looks; asset-budget.json is what the gate reads.
  //
  // This arm was first written as `spec.includes(value)` over the whole
  // document, and that is exactly the guard-passes-while-blind shape this repo
  // keeps producing: every ceiling is stated in the table AND restated in the
  // prose beside it, so editing only the table cell — the one place a human
  // reads — left a correct mention elsewhere and the substring search still
  // found it. A review demonstrated it for both the 24 MiB and the 26.0 ms
  // ceiling. So the check is now anchored two ways:
  //
  //   1. every KNOWN statement site is matched by its own regex, must appear
  //      exactly once, and must carry the JSON's value — so moving the table
  //      cell alone fails, and moving a prose restatement alone fails naming
  //      the site;
  //   2. every `N MiB` / `N ms` figure anywhere in the budget section must be
  //      a value the JSON actually documents — so a *newly written* stale
  //      restatement, in wording no site regex anticipated, still fails.
  const spec = readFileSync(join(root, 'docs', 'art', 'ASSET-SPEC.md'), 'utf8');
  ok(!/Download\/VRAM budget: PLACEHOLDER/.test(spec),
    'ASSET-SPEC.md no longer carries the #28 placeholder');

  const section = spec.slice(spec.indexOf('\n## The budget')).split(/\n## (?!The budget)/)[0];
  ok(section.length > 500, 'the budget section exists and is where the sites below are looked for');

  const mib = (b) => +(b / 1048576).toFixed(2);
  const ft = c.frameTime;
  // site: [label, regex with one capture per expected value, expected values]
  const sites = [
    ['total-shipped table cell', /\| Total shipped \| \*\*([\d.]+) MiB\*\*/g, [mib(c.shippedTotalBytes)]],
    ['code table cell', /\| Code \| \*\*([\d.]+) MiB\*\*/g, [mib(c.codeBytes)]],
    ['assets table cell', /\| Assets \| \*\*([\d.]+) MiB\*\*/g, [mib(c.assetBytes)]],
    ['asset-review table cell', /\| Asset review threshold \| \*\*([\d.]+) MiB\*\*/g, [mib(c.assetReviewBytes)]],
    // Replaces the old 'cold download' prose site, which stated a rationale that
    // Steam-only distribution retired. The runtime figure is what the hard
    // ceiling is now sized against, so it is the figure worth anchoring.
    ['electron-runtime prose', /alongside a ([\d.]+) MiB Electron runtime/g, [mib(c.electronRuntimeBytes)]],
    ['VRAM table cell', /\| VRAM \| \*\*([\d.]+) MiB, provisional\*\*/g, [mib(c.vramBytes)]],
    ['VRAM headroom prose', /([\d.]+) MiB is the resident-texture headroom/g, [mib(c.vramBytes)]],
    ['GPU-proxy table cell', /\| \*\*(\d+) textures, (\d+) geometries\*\*/g, [c.gpuTextures, c.gpuGeometries]],
    ['frame-time table cell', /frame time \| \*\*median ([\d.]+) ms, p95 ([\d.]+) ms\*\*/g, [ft.medianMs, ft.p95Ms]],
    ['frame-time ceiling prose', /median at or\s+under ([\d.]+) ms, p95 at or under ([\d.]+) ms/g, [ft.medianMs, ft.p95Ms]],
    ['frame-time tolerance prose', /([\d.]+) ms is \+\d+%/g, [ft.medianMs]],
  ];
  for (const [label, re, expected] of sites) {
    const hits = [...section.matchAll(re)];
    if (hits.length !== 1) {
      ok(false, `${label}: found ${hits.length} matches, expected exactly 1 — the site moved or was reworded, so it is no longer checked`);
      continue;
    }
    const got = hits[0].slice(1).map(Number);
    ok(got.every((v, i) => v === expected[i]),
      `${label} states ${expected.join(' / ')} (found ${got.join(' / ')})`);
  }

  // The second net. Everything the JSON legitimately documents, in the two
  // units the section quotes; anything else with those units is drift.
  const b = budget.baseline, rec = JSON.parse(readFileSync(join(root, budget.frameTimeRecord), 'utf8'));
  const okMiB = new Set([c.shippedTotalBytes, c.codeBytes, c.assetBytes, c.assetReviewBytes,
    c.electronRuntimeBytes, c.formerAssetBytes, c.vramBytes,
    b.shippedBytes, b.distTotalBytes, b.sourcemapBytes, b.jsBytes].map(mib));
  // Historical citations come from the JSON, not the live record: the record is
  // re-measured (perf.mjs --out) and its numbers move, while the spec's prose
  // cites fixed history. The transcribed seed record carried the history
  // inline; a live record does not, hence the guard.
  const okMs = new Set([ft.medianMs, ft.p95Ms, rec.medianFrameMs, rec.p95FrameMs,
    ...(ft.historicalMediansMs ?? []), ...(ft.historicalP95Ms != null ? [ft.historicalP95Ms] : []),
    ...(rec.otherRecordedMedians ?? []).map((m) => m.ms)]);
  const strays = [];
  for (const [, n, unit] of section.matchAll(/([\d.]+)\s*(MiB|ms)\b/g)) {
    const set = unit === 'MiB' ? okMiB : okMs;
    if (!set.has(Number(n))) strays.push(`${n} ${unit}`);
  }
  ok(strays.length === 0,
    `every MiB/ms figure in the budget section is one the JSON documents${strays.length ? ` — stray: ${strays.join(', ')}` : ''}`);
}

console.log('GPU resource proxies stay inside their ceilings');
{
  // The provisional stand-in for a VRAM measurement. These counts come from a
  // full 23-shot run, so they move when an asset pack lands wholesale.
  const manifest = JSON.parse(readFileSync(
    join(root, 'reviews', 'survivor-sep', 'integrated-shots', 'manifest.json'), 'utf8'));
  const perf = manifest.perf;
  ok(perf && typeof perf.textures === 'number' && typeof perf.geometries === 'number',
    'the capture manifest still carries a perf block with textures/geometries');
  if (perf) {
    ok(perf.textures <= c.gpuTextures,
      `textures ${perf.textures} <= ${c.gpuTextures}`);
    ok(perf.geometries <= c.gpuGeometries,
      `geometries ${perf.geometries} <= ${c.gpuGeometries}`);
  }
}

console.log('recorded combat-24 frame time stays inside its ceiling');
{
  const recPath = join(root, budget.frameTimeRecord);
  if (!existsSync(recPath)) {
    // Loud, and a failure rather than a skip: the record is committed, so its
    // absence is a deletion, not a missing local artefact.
    ok(false, `frame-time record missing at ${budget.frameTimeRecord} — the frame-time gate has nothing to check`);
  } else {
    const rec = JSON.parse(readFileSync(recPath, 'utf8'));
    ok(rec.scenario === c.frameTime.scenario,
      `record is the ${c.frameTime.scenario} scenario`);
    ok(rec.medianFrameMs <= c.frameTime.medianMs,
      `median ${rec.medianFrameMs} ms <= ${c.frameTime.medianMs} ms ceiling`);
    ok(rec.p95FrameMs <= c.frameTime.p95Ms,
      `p95 ${rec.p95FrameMs} ms <= ${c.frameTime.p95Ms} ms ceiling`);
    if (rec.transcribed) {
      console.log('  NOTE  the record is transcribed from review prose, not machine-written.');
      console.log('        Replace it: node tools/perf.mjs --out ' + budget.frameTimeRecord);
    }
  }
}

console.log('a built dist/ stays inside the payload ceilings');
{
  const m = measureDist();
  if (!m) {
    skip('no dist/ — payload NOT checked. Run `npm run build`, then `npm test` again.');
    skip('(`npm run gates:cheap` runs test before build, so a first-ever run of the');
    skip(' cheap tier skips this arm; the second run checks the build the first made.)');
  } else {
    const s = buildStaleness(m);
    if (s.stale) {
      console.log(`  NOTE  this dist/ predates ${s.newestFile} — the payload below is the previous build's.`);
    }
    for (const r of checkPayload(m, budget)) {
      if (r.soft) {
        // The review tripwire. It must never redden the suite — if it did, it
        // would be a second hard ceiling wearing a softer word, and the whole
        // point of splitting the two numbers is that one of them is policy.
        if (!r.ok) {
          console.log(`  NOTE  ${r.name} ${MiB(r.actual)} exceeds the ${MiB(r.ceiling)} soft threshold`);
          console.log('        Not a failure. Write a note on the issue adopting this payload.');
        }
        continue;
      }
      ok(r.ok, `${r.name} ${MiB(r.actual)} <= ${MiB(r.ceiling)}`);
    }
    if (m.assets > 0) {
      console.log(`  NOTE  ${m.assetFiles.length} non-code asset file(s), largest: ` +
        m.assetFiles.slice(0, 3).map((a) => `${a.file} ${MiB(a.bytes)}`).join(', '));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
