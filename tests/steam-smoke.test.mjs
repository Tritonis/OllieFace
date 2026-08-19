/**
 * The parts of the Steam socket-pair gate that can be judged without Steam.
 *
 *   node tests/steam-smoke.test.mjs
 *
 * `npm run smoke:steam` (issue #64, arm B of docs/adr/0002) needs a running
 * Steam client, so it is a local gate and can never be part of `npm test`. That
 * is not a reason to leave the whole arm untested: three of its parts have
 * known answers on any box, and they are exactly the parts that decide whether a
 * green run means anything.
 *
 *   1. The reduction — percentiles and the pass/fail verdict. These carry the
 *      criterion agreed on #52 in advance, so a bug here changes the answer
 *      without changing the measurement.
 *   2. Symbol resolution against the vendored DLL. The four flat entry points
 *      the gate needs must be present, and the interface accessor must be
 *      *discovered* rather than assumed: #52 cost a plan assumption when SDK
 *      1.65 moved `SteamNetworkingSockets_SteamAPI` from v012 to v013, and #64's
 *      own issue text still says v013 while the tree now carries 1.64 and v012.
 *      A hard-coded version is that same defect waiting to happen.
 *   3. Containment. The issue's first constraint is that this surface must never
 *      be reachable from shipping code. That is a claim about the tree, so it is
 *      checkable here rather than remembered.
 *
 * Nothing below calls `SteamAPI_Init`, loads the DLL as code, or needs Steam.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pct, dist, verdict } from '../tools/netstats.mjs';
import {
  VENDOR_REL, REQUIRED_SYMBOLS, BOUND_SYMBOLS, TWO_PROCESS_SYMBOLS, ACCESSORS,
  exportedSymbols, pickAccessor, missingSymbols,
} from '../tools/steamnet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// ------------------------------------------------------------------ reduction
console.log('\n-- percentiles agree with the WebRTC baseline\'s own reducer');
{
  // `tools/netbaseline.mjs:356-361`, which runs inside the browser page and so
  // cannot be imported. The two must agree or the comparison the whole arm
  // exists to make is between two different statistics.
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  ok(pct(s, 50) === 5, 'p50 of 1..10 is 5 (ceil(0.5*10)-1 = index 4)');
  ok(pct(s, 99) === 10, 'p99 of 1..10 is 10');
  ok(pct(s, 100) === 10, 'p100 is the max, not out of range');
  ok(pct([], 99) === null, 'an empty sample has no percentile, and does not throw');
  ok(pct([3, 1, 2], 50) === 2, 'the input is not required to be sorted');

  const before = [3, 1, 2];
  pct(before, 50);
  ok(before.join() === '3,1,2', 'and it is not sorted in place');

  const d = dist([1, 2, 3, 4]);
  ok(d.n === 4 && d.p50 === 2 && d.max === 4 && d.mean === 2.5, `dist reports n/p50/max/mean (${JSON.stringify(d)})`);
  ok(dist([]).n === 0 && dist([]).p99 === null, 'an empty distribution is n:0 with null quantiles, not a crash');
}

console.log('\n-- the verdict is the criterion agreed on #52, and it bites');
{
  const GATE = { stateP99Ms: 5.0, eventsP99Ms: 7.5 };
  const green = {
    state: { sent: 5400, received: 5400, lost: 0, duplicates: 0, outOfOrder: 0, latencyMs: dist([1, 2, 3]) },
    events: { sent: 360, received: 360, lost: 0, duplicates: 0, outOfOrder: 0, latencyMs: dist([1, 2, 3]) },
  };
  ok(verdict(green, GATE).ok === true, 'a clean run passes');

  const named = (t) => verdict(t, GATE).checks.filter((c) => !c.ok).map((c) => c.name);

  ok(verdict({ ...green, events: { ...green.events, lost: 1 } }, GATE).ok === false,
    'one lost reliable message fails the run');
  ok(named({ ...green, events: { ...green.events, lost: 1 } }).includes('reliable delivery'),
    'and the failing check is named, so the record says which one');
  ok(verdict({ ...green, events: { ...green.events, duplicates: 1 } }, GATE).ok === false,
    'a duplicated reliable message fails the run');
  ok(verdict({ ...green, events: { ...green.events, outOfOrder: 1 } }, GATE).ok === false,
    'an out-of-order reliable message fails the run');

  // A run that sent nothing loses nothing. Without this the gate is green when
  // the send loop never started, which is the worst possible false pass.
  ok(verdict({ ...green, events: { ...green.events, sent: 0, received: 0 } }, GATE).ok === false,
    'a run that sent no reliable messages fails rather than vacuously passing');
  ok(verdict({ ...green, state: { ...green.state, sent: 0, received: 0 } }, GATE).ok === false,
    'and a run that sent no snapshots fails too');

  const slow = { ...green, state: { ...green.state, latencyMs: dist([5.1, 5.1, 5.1]) } };
  ok(verdict(slow, GATE).ok === false, 'p99 state latency above 5.0 ms fails');
  ok(named(slow).includes('state p99'), 'named as the state p99 check');
  ok(verdict({ ...green, state: { ...green.state, latencyMs: dist([5.0, 5.0]) } }, GATE).ok === true,
    'exactly at the limit passes - the gate is <=, and the limit is a decision, not a coin toss');

  const slowEvents = { ...green, events: { ...green.events, latencyMs: dist([7.6]) } };
  ok(verdict(slowEvents, GATE).ok === false, 'p99 events latency above 7.5 ms fails');
  ok(named(slowEvents).includes('events p99'), 'named as the events p99 check');

  // Unreliable loss is deliberately NOT a gate: the `state` channel is
  // unreliable on both transports and the baseline lost none only because
  // loopback is lossless. It must still be recorded, and it is - as a number.
  ok(verdict({ ...green, state: { ...green.state, lost: 12 } }, GATE).ok === true,
    'lost snapshots on the unreliable channel do not fail the run (they are reported, not gated)');

  ok(verdict(null, GATE).ok === false, 'a run with no totals at all is a failure, not a pass');
}

// --------------------------------------------------------- symbol resolution
console.log('\n-- the vendored DLL carries what the gate calls');
{
  const dll = readFileSync(path.join(root, VENDOR_REL));
  const exports = exportedSymbols(dll);

  ok(exports.size > 300, `the export scan found ${exports.size} SteamAPI_* names`);
  const missing = missingSymbols(exports, REQUIRED_SYMBOLS);
  ok(missing.length === 0, `all ${REQUIRED_SYMBOLS.length} symbols this gate declares are present${missing.length ? `: missing ${missing.join(', ')}` : ''}`);
  ok(REQUIRED_SYMBOLS.includes('SteamAPI_ISteamNetworkingSockets_CreateSocketPair'),
    'CreateSocketPair is among them - it is the one that makes the whole arm possible');
  ok(REQUIRED_SYMBOLS.includes('SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32'),
    'SetGlobalConfigValueInt32 is among them - it is where ?netlag=/?netloss= is reborn');

  // The bound/checked split is the honest version of "four entry points": two
  // of #64's four belong to a two-process arm nobody has built, and binding
  // them would be generality for a need nothing has. Pinned here so the
  // distinction cannot quietly rot back into an overstatement.
  ok(BOUND_SYMBOLS.every((s) => !TWO_PROCESS_SYMBOLS.includes(s)),
    'the bound set and the existence-checked set are disjoint');
  ok(REQUIRED_SYMBOLS.length === BOUND_SYMBOLS.length + TWO_PROCESS_SYMBOLS.length,
    `REQUIRED_SYMBOLS is exactly the two sets (${BOUND_SYMBOLS.length} bound + ${TWO_PROCESS_SYMBOLS.length} checked)`);
  ok(TWO_PROCESS_SYMBOLS.length === 2
    && TWO_PROCESS_SYMBOLS.every((s) => /CreateListenSocketIP|ConnectByIPAddress/.test(s)),
    'the unbound pair is exactly the two-process arm the issue made conditional');

  for (const base of Object.values(ACCESSORS)) {
    const picked = pickAccessor(exports, base);
    ok(picked !== null && exports.has(picked.symbol), `${base} resolves to ${picked?.symbol ?? 'NOTHING'} in this DLL`);
  }
}

console.log('\n-- the accessor version is discovered, never assumed');
{
  const base = 'SteamAPI_SteamNetworkingSockets_SteamAPI';
  ok(pickAccessor(new Set([`${base}_v012`]), base)?.version === 12, 'SDK 1.64 exports v012 and v012 is picked');
  ok(pickAccessor(new Set([`${base}_v013`]), base)?.version === 13, 'SDK 1.65 exports v013 and v013 is picked - no edit required');
  ok(pickAccessor(new Set([`${base}_v012`, `${base}_v013`]), base)?.version === 13,
    'given both, the newest wins');
  ok(pickAccessor(new Set([`${base}_v9`, `${base}_v10`]), base)?.version === 10,
    'versions are compared as numbers, not as strings (v10 > v9)');
  ok(pickAccessor(new Set(['SteamAPI_Init']), base) === null, 'an absent accessor is null, not a guess');
  ok(pickAccessor(new Set([`${base}Extra_v001`]), base) === null,
    'a name that merely starts with the base is not mistaken for it');
}

// ------------------------------------------------------------- containment
console.log('\n-- test-only: the gate is not reachable from shipping code');
{
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

  // steamworks-ffi-node (a direct dependency, issue #116) declares koffi as a hard,
  // non-optional dependency, so koffi sits in the PRODUCTION closure regardless of
  // where it is listed at the top level of package.json. `koffi in pkg.dependencies`
  // is therefore the wrong question - it stays false forever while koffi ships
  // anyway. What actually decides whether koffi reaches a built app is `build.files`:
  // assert on that.
  const koffiInLock = lock.packages?.['node_modules/koffi'];
  ok(koffiInLock !== undefined, 'koffi is present in the production dependency closure (transitively, via steamworks-ffi-node)');
  ok('koffi' in (pkg.devDependencies ?? {}), 'koffi is a devDependency');

  // `build.files` is what electron-builder packs. `tools/` is absent from it and
  // must stay absent: an FFI module that can open raw sockets has no business in
  // a shipped build, however inert it is. Since koffi is now unavoidably in the
  // production closure, it must instead be excluded by name - as must the package
  // that pulls it in - or electron-builder will pack the whole closure it finds.
  const files = pkg.build?.files ?? [];
  ok(!files.some((f) => String(f).startsWith('tools')), 'build.files does not pack tools/');
  ok(files.includes('!node_modules/koffi/**'),
    'build.files excludes node_modules/koffi from the shipped build, even though koffi is a production dependency');
  ok(files.includes('!node_modules/steamworks-ffi-node/**'),
    'build.files excludes node_modules/steamworks-ffi-node from the shipped build');

  const shipping = [];
  const walk = (dir) => {
    for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(m?js|cjs)$/.test(e.name)) shipping.push(rel);
    }
  };
  walk('src'); walk('desktop');

  const offenders = shipping.filter((rel) => {
    const src = readFileSync(path.join(root, rel), 'utf8');
    return /['"]koffi['"]/.test(src) || /['"]steamworks-ffi-node['"]/.test(src)
      || /steamnet\.mjs/.test(src) || /steamsmoke\.mjs/.test(src);
  });
  ok(offenders.length === 0,
    `no file under src/ or desktop/ reaches for koffi or the gate's modules${offenders.length ? `: ${offenders.join(', ')}` : ` (${shipping.length} files scanned)`}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
