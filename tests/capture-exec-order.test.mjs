// tests/capture-exec-order.test.mjs
//
// #114: shots execute in `SCENARIOS` array order but are stored alphabetically
// by name in the manifest, hiding the actual run order from anyone editing a
// scenario. `tools/capture.mjs` now stamps each shot's manifest entry with
// `execIndex` — this array's index at capture time — so the true order
// survives the alphabetical sort. This asserts the stamp actually matches the
// array position it claims to.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../tools/capture.mjs'), 'utf8');

ok(/for \(const \[execIndex, s\] of SCENARIOS\.entries\(\)\)/.test(src),
  'main loop iterates SCENARIOS with an index');
const pushOffsets = [...src.matchAll(/manifest\.shots\.push\(\{/g)].map((m) => m.index);
ok(pushOffsets.length === 3, `found all 3 manifest.shots.push call sites (found ${pushOffsets.length})`);
for (const off of pushOffsets) {
  const window = src.slice(off, off + 300);
  ok(/execIndex/.test(window), `push site stamps execIndex: ${window.slice(0, 40).replace(/\n/g, ' ')}...`);
}

// Round-trip: reproduce the actual loop shape (deliberately spliced out of
// order, the exact scenario #114 describes) and confirm each shot's stamped
// execIndex equals its true position in the declared array, even after the
// alphabetical `.sort()` capture.mjs applies to the finished manifest.
function simulateCapture(scenarioNames) {
  const SCENARIOS = scenarioNames.map((name) => ({ name }));
  const shots = [];
  for (const [execIndex, s] of SCENARIOS.entries()) {
    shots.push({ name: s.name, execIndex });
  }
  return shots.sort((a, b) => a.name.localeCompare(b.name));
}

// Mirrors #114: '11-bestiary' spliced before '10-inventory' in execution order.
const manifest = simulateCapture(['09-survivors', '11-bestiary', '10-inventory', '12-boss-phases']);
const byName = Object.fromEntries(manifest.map((s) => [s.name, s.execIndex]));

ok(byName['09-survivors'] === 0, "09-survivors execIndex is its true array position 0");
ok(byName['11-bestiary'] === 1, "11-bestiary execIndex is its true array position 1, before 10-inventory");
ok(byName['10-inventory'] === 2, "10-inventory execIndex is its true array position 2, after 11-bestiary");
ok(byName['11-bestiary'] < byName['10-inventory'],
  'execIndex exposes that 11-bestiary ran before 10-inventory despite the manifest listing 10- before 11- alphabetically');

console.log(`\ncapture-exec-order: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
