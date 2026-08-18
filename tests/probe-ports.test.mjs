// tests/probe-ports.test.mjs
//
// Every probe and gate in this repo starts its own vite dev server on a fixed
// default port. Nothing enforced that those defaults were distinct, and on
// 2026-08-15 that cost two diagnosis cycles in one day: `gate:sp` and
// `gate:mp1` running from two worktrees both bound 5209, and *both* implementers
// read the collision as a code failure in their own branch (issue #68).
//
// A collision is invisible until two things run at once, which is exactly when
// it is most expensive to diagnose — the failure surfaces as
// ERR_CONNECTION_REFUSED or a vite bind error inside whichever run lost the
// race, pointing at the code under test rather than at the port. So the
// constraint is asserted statically here instead of being discovered
// dynamically there.
//
// This is a *static* check: it reads the source of each tool and extracts the
// port defaults it declares. It deliberately does not bind anything, so it
// costs milliseconds and runs in `npm test` alongside everything else.
//
// Scope is `tools/` plus `tests/sp-equivalence.mjs` — the scripts a person or
// an agent actually runs. `reviews/` is out of scope on purpose: those are
// archived artefacts of past critic rounds, frozen with the reviews they
// support, and re-porting them would edit history to no benefit.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANE_NAMES, laneBlock, laneOwning } from '../tools/lib/lanes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const toolsDir = join(root, 'tools');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/**
 * The three shapes a dev-server port default is written in across this repo:
 *
 *   const PORT = Number(args.port ?? 5205);        the idiom in `tools/`
 *   const PORT = 5209;                             a bare constant
 *   server: { port: 5207, hmr: false, ... }        inlined into createServer
 *
 * Anything in the 5000-5999 band reached through one of these is treated as a
 * claim on that port. A number that appears only inside a URL template or a
 * doc comment is not a claim — it is an echo of one of the above — so those are
 * not matched.
 */
const PATTERNS = [
  /\b(?:const|let)\s+[A-Z_0-9]*PORT[A-Z_0-9]*\s*=\s*(\d{4})\s*;/g,
  /\bserver\s*:\s*\{[^}]*?\bport\s*:\s*(\d{4})/g,
  // A helper call naming the flag: `num('port', 5216)` in `tools/netbaseline.mjs`,
  // and it would equally catch `flag('signal-port', 5215)`.
  //
  // This pattern is here because its absence was caught the expensive way. The
  // first version of this test recognised three declaration shapes, and
  // `netbaseline.mjs` uses a fourth — so it contributed no claims at all and
  // was invisible to the scan. A port reassignment made against that blind map
  // moved `tools/silhouette.mjs` straight onto netbaseline's 5216, and this
  // test reported green on a collision introduced by the very change meant to
  // end collisions.
  //
  // The lesson generalises past this one regex: an extractor that enumerates
  // known shapes fails silently on the unknown one, and silence reads exactly
  // like success. The two guard assertions below pin the idioms we know about
  // and structurally cannot cover the one we do not, so a new probe using a
  // fifth shape is still a gap. Prefer an existing idiom when adding a probe.
  /\b[A-Za-z_$][\w$]*\(\s*['"][a-z-]*port['"]\s*,\s*(\d{4})\s*\)/gi,
];

/**
 * `const PORT = Number(<anything> ?? 5205);` — matched as a whole declaration
 * rather than as a fixed `args.port ?? N`, because the fallback expression
 * varies: `tools/` reads a parsed `--port` flag, while `sp-equivalence` also
 * consults `SP_PORT`, so its right-hand side is a multi-line IIFE. Pinning the
 * narrower shape meant the extractor stopped seeing that file the moment it
 * gained its override — which is the silent-break the two guard assertions
 * below exist to catch.
 *
 * The argument text is delimited by counting parentheses rather than by a regex
 * or a fixed character window. A regex for the closing `);` stops early — the
 * `sp-equivalence` IIFE contains `indexOf('--port');` — and a fixed window has
 * the opposite failure: it runs past the end of the declaration and is free to
 * pick up an unrelated `?? NNNN` belonging to the next statement, inventing a
 * claim on a port the file never uses. Balancing the parens is exact, and
 * cheaper than either.
 */
const NUMBER_DECL = /\b(?:const|let)\s+[A-Z_0-9]*PORT[A-Z_0-9]*\s*=\s*Number\(/g;
const DEFAULTED = /\?\?\s*(\d{4})\b/g;

/** The text between `Number(` at `open` and its matching close paren. */
function balancedArgs(source, open) {
  let depth = 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

/** Ports claimed by one file, deduplicated: a file may name its own port twice. */
function portsIn(source) {
  const found = new Set();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const p = Number(m[1]);
      if (p >= 5000 && p <= 5999) found.add(p);
    }
  }
  NUMBER_DECL.lastIndex = 0;
  let decl;
  while ((decl = NUMBER_DECL.exec(source)) !== null) {
    const argText = balancedArgs(source, NUMBER_DECL.lastIndex);
    DEFAULTED.lastIndex = 0;
    let d;
    while ((d = DEFAULTED.exec(argText)) !== null) {
      const p = Number(d[1]);
      if (p >= 5000 && p <= 5999) found.add(p);
    }
  }
  return found;
}

/**
 * Every `.mjs` under `tools/`, RECURSIVELY.
 *
 * It used to be the top level only, and that was a hole with the same shape as
 * the netbaseline one above: `tools/lib/` was never read, so a port declared
 * there was invisible and the collision arm reported green over it. A planted
 * `const PORT = 5209;` in a new `tools/lib/` file — a genuine collision with
 * sp-equivalence — passed 16/16. The directory stopped being incidental the
 * moment the lane port table moved into it.
 *
 * `lanes.mjs` needs no exemption and deliberately gets none. It holds its
 * numbers as an object literal (`LANE_BASES = { A: 5240, ... }`), which is not
 * one of the four *binding* idioms the extractor recognises — declaring a block
 * is not claiming a port, and the difference is already encoded in the shapes.
 * A real bind written there in any of those idioms is caught like anywhere
 * else, which a special case keyed on the filename could not promise.
 */
function mjsUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) out.push(...mjsUnder(join(dir, e.name)));
    else if (e.name.endsWith('.mjs')) out.push(join(dir, e.name));
  }
  return out;
}

const files = [
  ...mjsUnder(toolsDir),
  join(here, 'sp-equivalence.mjs'),
];

/** port -> [file, ...] */
const claims = new Map();
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/');
  for (const port of portsIn(readFileSync(file, 'utf8'))) {
    if (!claims.has(port)) claims.set(port, []);
    claims.get(port).push(rel);
  }
}

console.log('the scan finds something to check');
{
  ok(files.length > 10, `scanned ${files.length} scripts`);
  ok(claims.size > 10, `found ${claims.size} distinct default ports`);
  // A guard on the extractor itself: if a refactor changes the idiom and the
  // patterns above stop matching, `claims` silently empties and this file
  // starts passing vacuously. Pin the two ports that are documented by name in
  // CLAUDE.md, so the check fails loudly rather than going quiet.
  ok(claims.get(5209)?.includes('tests/sp-equivalence.mjs'),
    'the extractor still sees sp-equivalence on 5209');
  ok(claims.get(5214)?.includes('tools/coopprobe.mjs'),
    'the extractor still sees coopprobe on 5214');
  // The idiom the extractor was originally blind to. Pinned by name because
  // the cost of that blindness was not a missing row in a report — it was a
  // green test sitting on top of a live collision.
  ok(claims.get(5216)?.includes('tools/netbaseline.mjs'),
    'the extractor still sees netbaseline on 5216, via the num(name, fallback) idiom');
  // The scan is recursive, and this is the assertion that keeps it so: a
  // top-level-only readdir passed 16/16 over a planted `const PORT = 5209;` in
  // `tools/lib/`, because that directory was simply never opened.
  ok(files.some((f) => /[\\/]tools[\\/]lib[\\/]/.test(f)),
    'the scan descends into tools/lib/ rather than reading only the top level');
}

console.log('no two scripts claim the same default port');
{
  const collisions = [...claims.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort((a, b) => a[0] - b[0]);
  for (const [port, owners] of collisions) {
    console.log(`    ${port} claimed by ${owners.length}: ${owners.join(', ')}`);
  }
  ok(collisions.length === 0,
    collisions.length === 0
      ? 'every default port is claimed by exactly one script'
      : `${collisions.length} port(s) claimed by more than one script`);
}

// ---------------------------------------------------------------------------
// The lane blocks
//
// `--lane A|B|C` derives a whole port block from one flag. That mapping is
// runtime arithmetic, so the regex scan above cannot see the ports a lane
// actually binds — and a collision detector that cannot see half the ports in
// play is the "green on a question it can no longer ask" shape this repo keeps
// paying for. So the lane table is imported as data and checked directly: the
// scan owns the fixed defaults, this section owns the ranges, and together they
// still cover every port anything here can bind.
//
// The invariant CLAUDE.md asserts in prose — "nothing in tools/ or tests/
// claims above 5236, so the 5240+ lane range is free by construction" — becomes
// a check that can go red the moment someone picks 5251 for a new probe.

/** Claims that fall inside some lane's block: [port, lane, owners]. */
function laneTrespasses(claimMap) {
  const out = [];
  for (const [port, owners] of claimMap) {
    const lane = laneOwning(port);
    if (lane) out.push([port, lane, owners]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

console.log('the lane port blocks are disjoint and unclaimed');
{
  const blocks = LANE_NAMES.map((n) => [n, laneBlock(n)]);
  let overlap = null;
  for (let a = 0; a < blocks.length; a++) {
    for (let b = a + 1; b < blocks.length; b++) {
      const [na, ba] = blocks[a], [nb, bb] = blocks[b];
      if (ba.from < bb.to && bb.from < ba.to) overlap = `${na} and ${nb}`;
    }
  }
  ok(overlap === null,
    overlap === null
      ? `lanes are disjoint: ${blocks.map(([n, b]) => `${n}=${b.from}-${b.to - 1}`).join(', ')}`
      : `lane blocks overlap: ${overlap}`);

  const trespass = laneTrespasses(claims);
  for (const [port, lane, owners] of trespass) {
    console.log(`    ${port} is inside lane ${lane}'s block but claimed by ${owners.join(', ')}`);
  }
  ok(trespass.length === 0,
    trespass.length === 0
      ? 'no script hardcodes a default inside a lane block'
      : `${trespass.length} default port(s) sit inside a lane block`);

  // Positive control: the same function, on a synthetic claim, must report the
  // trespass. Without this the check above passes just as happily if
  // `laneOwning` starts returning null for everything.
  const synthetic = laneTrespasses(new Map([[5251, ['tools/imaginary.mjs']]]));
  ok(synthetic.length === 1 && synthetic[0][1] === 'B',
    'the lane check catches a synthetic probe planted on 5251 (lane B)');
  ok(laneOwning(5209) === null && laneOwning(5234) === null,
    'the shipped defaults 5209 and 5234 are outside every lane block');
}

console.log('both lane-aware entry points take --lane');
{
  const gates = readFileSync(join(root, 'tools', 'gates.mjs'), 'utf8');
  const sp = readFileSync(join(here, 'sp-equivalence.mjs'), 'utf8');
  ok(/--lane/.test(gates), 'tools/gates.mjs parses --lane');
  ok(/--lane/.test(sp), 'tests/sp-equivalence.mjs parses --lane');
  // Both must read the SAME table, or "lane B" means two things.
  ok(/lib\/lanes\.mjs/.test(gates) && /lib\/lanes\.mjs/.test(sp),
    'both import the lane block table rather than restating the numbers');
}

console.log('sp-equivalence takes a port override');
{
  // Item 1 of issue #68: the three gates all run through this one file, so
  // without an override they cannot run concurrently even from separate
  // worktrees. The override is what makes parallel gate runs possible at all.
  const src = readFileSync(join(here, 'sp-equivalence.mjs'), 'utf8');
  ok(/--port/.test(src), 'a --port flag is documented and parsed');
  ok(/SP_PORT/.test(src), 'an SP_PORT environment override exists');
  // Matched on EADDRINUSE specifically, not on prose: the phrase "port 5209 is
  // held" already appeared in a comment here, so a looser pattern passes
  // without any handler existing.
  ok(/EADDRINUSE/.test(src),
    'a bind failure is caught and explained rather than surfacing a raw stack');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
