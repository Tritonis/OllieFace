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
 * The shapes a dev-server port default is written in across this repo:
 *
 *   const PORT = Number(args.port ?? 5205);        the idiom in `tools/`
 *   const PORT = Number(process.env.X || 5209);    the same, with `||`
 *   const PORT = 5209;                             a bare constant
 *   server: { port: 5207, hmr: false, ... }        inlined into createServer
 *   Object.freeze({ port: 5251 })                  any object-literal port key
 *
 * THE UNIFYING RULE, and it is worth stating because the previous version of
 * this comment enumerated shapes instead: a claim is a *port-named binding of a
 * numeric literal*. Either a `const`/`let`, or an object key, or a flag-string
 * argument, whose name has "port" as one of its **words** — case-insensitively
 * — bound to a 4-digit literal — directly, or as the fallback arm of `??`/`||`
 * inside a `Number(...)`.
 *
 * "Has PORT as a word" is deliberately not "contains the substring port".
 * `port`, `PORT`, `signalPort`, `SIGNAL_PORT` and `signal-port` all have it as
 * a word — the identifier splits (on `_`, `-`, and lower-to-upper case
 * transitions) into segments, and one segment is exactly "port". `support`,
 * `report`, `transport`, `viewport`, `export`, `passport` do NOT: each is one
 * unbroken lowercase run that happens to end in the letters p-o-r-t, not a
 * "port" segment. `hasPortWord()` below implements the split-and-compare
 * rather than a regex, on purpose: the substring shape (`/port/i`) is exactly
 * what over-matched `passport`/`support` before, and a case-blind identifier
 * regex (`PORT` with no `i`) is exactly what missed lowercase `const port`
 * before. A word split sidesteps both failure modes at once instead of adding
 * a flag to either.
 *
 * Naming is what makes this a rule rather than a shape list: a port only
 * reaches a bind by travelling through an identifier or a key that says "port",
 * because that is what `createServer`, `listen` and every flag parser here take.
 * A number under any other name is not reaching a socket in this repo.
 *
 * Anything in the 5000-5999 band reached that way is treated as a claim. A
 * number that appears only inside a URL template or a doc comment is not a
 * claim — it is an echo of one of the above — so those are not matched.
 */

/**
 * Split an identifier or flag string into lowercase words, on `_`, `-`, and
 * every lower-to-upper case transition (the camelCase boundary). `PORT` and
 * `SIGNAL_PORT` have no such transition and split on `_` alone; `signalPort`
 * has no `_` and splits on the transition alone; `signal-port` (a CLI flag
 * string) splits on `-`. A plain lowercase run like `support` has none of
 * these and stays one word, which is exactly why it never contains a "port"
 * word even though it contains the substring.
 */
function wordsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * English words that end in the letters "port" but are not port names — the
 * denylist that makes the prefix/suffix rule below safe. Without it, matching
 * "port" as a suffix (needed to catch `gameport`, `myport`, `httpport`, which
 * have no split boundary for `wordsOf` to find) would resurrect exactly the
 * over-match this file shipped once already (`export`, `support`, `passport`
 * as claims). There is no lexical rule that tells `gameport` apart from
 * `support` — both are one unbroken lowercase run ending in "port" — so this
 * is a named list of the ones we know are prose, not a device.
 */
const PORT_LOOKALIKE_WORDS = new Set([
  'export', 'import', 'support', 'report', 'transport', 'passport',
  'viewport', 'airport', 'deport', 'purport', 'comport', 'rapport',
]);

/**
 * True if `name` has "port" as one of its words, per `wordsOf` above, OR as a
 * prefix/suffix of an otherwise-unsplit word (`gameport`, `myport`, `port2`),
 * which `wordsOf` alone cannot find because there is no `_`/`-`/case-transition
 * boundary for it to split on. Trailing digits are stripped before comparing,
 * so `port2`/`PORT2` reduce to `port`.
 *
 * KNOWN GAP, stated rather than left implicit (this file's third widening
 * after two that shipped a comment ahead of what the code did): the
 * prefix/suffix rule is guarded only by `PORT_LOOKALIKE_WORDS` above, a finite
 * denylist, not a lexical rule. A genuine English word ending or starting in
 * "port" that is NOT on that list (e.g. "seaport", "portfolio", "portable")
 * WILL be misread as a port claim if it is ever used as a bare identifier
 * name in scanned source — the loud, safe-to-notice direction, but still a
 * false positive the denylist does not cover. Conversely, a real port
 * identifier built from an English word not obviously about ports would slip
 * through only if it also happened to collide with an entry on the denylist,
 * which is not a realistic naming choice. Extend the denylist rather than
 * abandoning the prefix/suffix rule if a new lookalike surfaces.
 *
 * Asymmetry worth naming, since it looks like an inconsistency otherwise:
 * `viewport` (one unsplit word) is excluded via the denylist, but `view_port`,
 * `viewPort`, `air-port` (words that DO split, giving an exact "port" word) are
 * still claims. That is intentional — the denylist exists only to rescue the
 * unsplit suffix/prefix case, and a name that explicitly separates "port" as
 * its own word segment is treated as meaning it.
 */
function hasPortWord(name) {
  for (const raw of wordsOf(name)) {
    const w = raw.replace(/\d+$/, '');
    if (!w) continue;
    if (w === 'port') return true;
    if ((w.startsWith('port') || w.endsWith('port')) && !PORT_LOOKALIKE_WORDS.has(w)) return true;
  }
  return false;
}

// Captures the *name* (identifier, object key, or flag string) alongside the
// literal, so `portsIn` can filter with `hasPortWord` instead of baking the
// word-boundary logic into the regex itself.
const PATTERNS = [
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d{4})\b/g,
  // ANY object-literal `port:` / `signalPort:` / `SIGNAL_PORT:` key, not only
  // one nested inside `server: { ... }`. The narrower form was a hole: a real
  // bind written `createServer(Object.freeze({ port: 5251 }))` passed the whole
  // suite while genuinely sitting inside lane B's block.
  /\b([A-Za-z_$][\w$]*)\s*:\s*(\d{4})/g,
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
  /\b[A-Za-z_$][\w$]*\(\s*['"]([a-z][a-z-]*)['"]\s*,\s*(\d{4})\s*\)/g,
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
const NUMBER_DECL = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Number\(/g;
const DEFAULTED = /(?:\?\?|\|\|)\s*(\d{4})\b/g;

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

/**
 * Comments removed, so that *describing* an idiom is not *using* it.
 *
 * This became load-bearing the moment the extractor learned to read a bare
 * `{ port: N }`: `tools/lib/lanes.mjs` explains, in prose, that a bind written
 * there would be caught — and naming the example made the file claim 5240
 * inside lane A. The header above has always said a number in a doc comment is
 * an echo of a claim rather than a claim; this is that sentence made true.
 *
 * `//` is only treated as a comment when it is not preceded by `:` or `\`, so
 * the `http://localhost:5205` templates that appear all over `tools/` keep
 * their line intact instead of being truncated at the scheme separator — and
 * so does an escaped-slash regex literal like `/https?:\/\//`. Without the
 * `\` guard, that literal's *closing* `\/` followed by the final `/` reads as
 * a bare `//` preceded by `\` (not `:`), and everything after it on the line
 * — a `const PORT = ...` sharing the line — was stripped as a comment along
 * with it.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Ports claimed by one file, deduplicated: a file may name its own port twice. */
function portsIn(raw) {
  const source = stripComments(raw);
  const found = new Set();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      if (!hasPortWord(m[1])) continue;
      const p = Number(m[2]);
      if (p >= 5000 && p <= 5999) found.add(p);
    }
  }
  NUMBER_DECL.lastIndex = 0;
  let decl;
  while ((decl = NUMBER_DECL.exec(source)) !== null) {
    if (!hasPortWord(decl[1])) continue;
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
 * `lanes.mjs` needs no exemption and deliberately gets none — but the earlier
 * justification for that was wrong and is worth correcting in place, because it
 * described a hole as a safety property. It said the lane table is invisible
 * "because it is an object literal, and object literals are not a binding
 * idiom". Object literals ARE a binding idiom, and now the extractor reads them.
 *
 * The real reason is the naming rule stated above: the extractor claims a port
 * only where the *identifier or key* says port. `LANE_BASES = { A: 5240, B:
 * 5250, C: 5260 }` is keyed by lane name, and a lane name is not a port name —
 * it maps a lane to the base of a block that nothing in this file binds. So the
 * table contributes zero claims by what it is, not by which numbers happen to
 * be in it. Rename a key to `port` and it would be a claim, correctly.
 *
 * And a genuine bind written in this same file is still caught: `const PORT =
 * 5240` or `{ port: 5240 }` here reads exactly as it would anywhere else, which
 * is what an exemption keyed on the filename could not promise. The assertion
 * below pins both halves.
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

  // Positive controls on the extractor itself, on synthetic source. Both of
  // these shapes were planted in a real `tools/lib/` file and passed 17/17
  // while genuinely colliding — the first with sp-equivalence on 5209, the
  // second sitting inside lane B's block. A guard that cannot see the idiom
  // reports green on the collision it exists to find.
  ok(portsIn('const PORT = Number(process.env.PROBE_PORT || 5209);').has(5209),
    'the extractor reads a `||` fallback, not only `??`');
  ok(portsIn('const OPTS = Object.freeze({ port: 5251 });\ncreateServer({ server: OPTS });').has(5251),
    'the extractor reads an object-literal `port:` key outside a `server: { ... }` block');
  ok(portsIn('const SIGNAL_PORT = 5215;').has(5215),
    'the extractor reads a bare constant with no trailing semicolon dependency');

  // Item 1 (the Major): lowercase `const port` was silently invisible, because
  // PATTERNS[0]/NUMBER_DECL required an uppercase PORT in the name while the
  // comment claimed no such qualifier. A real collision passing unseen is the
  // dangerous direction, so this must be caught.
  ok(portsIn('const port = 5209;').has(5209),
    'a lowercase `const port` is caught, matching the documented case-insensitive rule');
  ok(portsIn('const port = Number(args.port ?? 5209);').has(5209),
    'a lowercase `const port = Number(...)` is caught too');

  // Item 2: the object-key pattern matched any key merely ENDING in "port",
  // not a key whose name has "port" as its own word. False claims block an
  // innocent lane, which is the loud-failure direction — still wrong, but
  // less dangerous than item 1's silence.
  ok(!portsIn('const x = { export: 5209 };').has(5209),
    '`export:` is not a port claim');
  ok(!portsIn('const x = { support: 5209 };').has(5209),
    '`support:` is not a port claim');
  ok(!portsIn('const x = { report: 5209 };').has(5209),
    '`report:` is not a port claim');
  ok(!portsIn('const x = { transport: 5209 };').has(5209),
    '`transport:` is not a port claim');
  ok(!portsIn('const x = { viewport: 5209 };').has(5209),
    '`viewport:` is not a port claim');
  ok(!portsIn('const passport = 5209;').has(5209),
    '`const passport` is not a port claim');
  ok(portsIn('const x = { signalPort: 5209 };').has(5209),
    '`signalPort:` is still a port claim');
  ok(portsIn('const x = { port: 5209 };').has(5209),
    '`port:` is still a port claim');

  // Item 3: an escaped-slash regex literal earlier on the same line as a real
  // PORT declaration used to eat the rest of the line as a false comment.
  ok(portsIn('const RE = /https?:\\/\\//; const PORT = 5209;').has(5209),
    'a same-line escaped-slash regex literal does not swallow a trailing PORT declaration');

  // Item (the fix-wave Critical): a boundaryless port identifier — no `_`,
  // `-`, or case transition for `wordsOf` to split on — used to be invisible
  // because `hasPortWord` only ever checked for a whole "port" word.
  for (const name of ['myport', 'gameport', 'httpport', 'serverport', 'SIGNALPORT', 'HTTPPORT', 'GAMEPORT']) {
    ok(portsIn(`const ${name} = Number(process.env.X ?? 5209);`).has(5209),
      `a boundaryless port identifier \`${name}\` is caught`);
  }
  ok(portsIn('const port2 = 5209;').has(5209), '`port2` is caught');
  ok(portsIn('const PORT2 = 5209;').has(5209), '`PORT2` is caught');
  ok(portsIn('const port_2 = 5209;').has(5209), '`port_2` is still caught');
  ok(portsIn('const port = 5209;').has(5209), '`port` is still caught');
  // The denylist rescues the exact English words known to false-positive on
  // the prefix/suffix rule above.
  for (const word of ['export', 'support', 'report', 'transport', 'passport', 'viewport']) {
    ok(!portsIn(`const ${word} = 5209;`).has(5209),
      `\`const ${word}\` stays excluded by the denylist`);
  }
  ok(portsIn('const x = { signalPort: 5209 };').has(5209) && portsIn('const x = { port: 5209 };').has(5209),
    '`signalPort:` and `port:` remain claims after the denylist change');

  // The lane table's own honesty, both directions (see the comment on mjsUnder).
  const lanesSrc = readFileSync(join(toolsDir, 'lib', 'lanes.mjs'), 'utf8');
  ok(portsIn(lanesSrc).size === 0,
    'tools/lib/lanes.mjs contributes zero claims — its keys are lane names, not port names');
  ok(portsIn(`${lanesSrc}\nconst PORT = 5240;`).has(5240)
    && portsIn(`${lanesSrc}\ncreateServer({ port: 5240 });`).has(5240),
    'a real bind added to lanes.mjs would still be caught, in either idiom');
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
