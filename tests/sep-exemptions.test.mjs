// tests/sep-exemptions.test.mjs
//
// Issue #97: a typo in a SEP_MARGIN_EXEMPTIONS id (`<shot>::<subject>`) is
// silently inert. Nothing at runtime notices — `marginExemption` simply never
// matches, the bar goes back to floor + margin, and the entry sits in the
// table looking like a live record of a known shortfall.
//
// DECISION 1 - parse, don't import. The declarations live in modules that
// cannot be loaded in a test process: `tools/capture.mjs` imports `playwright`
// and `vite` at module scope, and `src/core/Harness.js` exports an installer
// that expects a live engine context. So this guard reads the sources as text,
// the same shape as the existing capture.mjs drift guard. Text parsing can go
// blind, so every extractor below is floor-checked: an extraction that finds
// too few shots or too few subjects FAILS rather than vacuously passing.
//
// DECISION 2 - roster split, taken from the consumers, not from name shapes.
// `SEP_MARGIN_EXEMPTIONS` is consulted only from `mustContain`, and the shot
// argument to `mustContain` is always the scenario name the surrounding
// capture tool drives. `tools/capture.mjs` drives only the scenarios declared
// in its own SCENARIOS array, whose subjects are declared by the `mustContain`
// calls in `src/core/Harness.js`; `tools/capture-realms.mjs` likewise pairs
// with `src/world/realms/RealmHarness.js`. A realm exemption is therefore
// never seen by the main run and vice versa, so each id is validated against
// exactly one roster: the one whose capture tool declares its shot. An id
// whose shot appears in neither roster - or, defensively, in both - fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/**
 * Find the index just past the `]` matching the `[` at `open`, skipping over
 * string and comment bodies so a bracket inside a note cannot end the block.
 */
const matchBracket = (src, open) => {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i === -1) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i === -1) return -1; i++; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) break;
      }
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
};

/** A shot name literal, possibly a template (`13-biomes-${i + 1}`), as a matcher. */
const nameMatcher = (raw) => {
  if (!raw.includes('${')) return (s) => s === raw;
  const rx = new RegExp(`^${raw.split(/\$\{[^}]*\}/).map(
    (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
  return (s) => rx.test(s);
};

/** Scenario names declared by a capture tool's SCENARIOS array. */
const shotsOf = (src) => [...src.matchAll(/^\s*name: (?:'([^']*)'|`([^`]*)`),/gm)]
  .map((m) => m[1] ?? m[2])
  .filter((n) => !n.startsWith('__'));

/** shot-name-literal -> Set(subject literals) from every `mustContain` call. */
const subjectsOf = (src) => {
  const out = [];
  for (const m of src.matchAll(/mustContain\(\s*(?:'([^']*)'|`([^`]*)`)\s*,\s*\[/g)) {
    const shot = m[1] ?? m[2];
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close === -1) continue;
    const block = src.slice(open, close);
    const subjects = [...block.matchAll(/subject:\s*(?:'([^']*)'|`([^`]*)`)/g)]
      .map((s) => s[1] ?? s[2]);
    out.push({ shot, subjects });
  }
  return out;
};

const rosters = {
  main: {
    shots: shotsOf(read('tools', 'capture.mjs')),
    decls: subjectsOf(read('src', 'core', 'Harness.js')),
    // Floors chosen well under the current counts (21 shots, 22 declaration
    // blocks) but far above zero: a refactor that moves these declarations
    // out from under the regex trips this instead of quietly exempting
    // everything.
    minShots: 15, minDecls: 15,
  },
  realm: {
    shots: shotsOf(read('tools', 'capture-realms.mjs')),
    decls: subjectsOf(read('src', 'world', 'realms', 'RealmHarness.js')),
    minShots: 6, minDecls: 6,
  },
};

console.log('the extractors can still see their sources');
for (const [name, r] of Object.entries(rosters)) {
  ok(r.shots.length >= r.minShots,
    `${name}: ${r.shots.length} shot names extracted (floor ${r.minShots})`);
  ok(r.decls.length >= r.minDecls,
    `${name}: ${r.decls.length} mustContain blocks extracted (floor ${r.minDecls})`);
  const subjects = r.decls.reduce((n, d) => n + d.subjects.length, 0);
  ok(subjects >= r.decls.length,
    `${name}: ${subjects} subjects extracted across ${r.decls.length} blocks`);
  // Every shot a roster's harness declares subjects for must be a shot its own
  // capture tool drives. This is the roster-split claim itself: if it ever
  // stops holding, the mapping below is validating against the wrong table.
  const orphan = r.decls.map((d) => d.shot)
    .filter((s) => !r.shots.some((n) => nameMatcher(n)(s)));
  ok(orphan.length === 0,
    `${name}: every mustContain shot is in its own capture roster${orphan.length ? ` (orphans: ${orphan.join(', ')})` : ''}`);
}

console.log('every SEP_MARGIN_EXEMPTIONS id names a real shot and a real subject');
{
  const harness = read('src', 'core', 'Harness.js');
  const table = /const SEP_MARGIN_EXEMPTIONS = \[/.exec(harness);
  ok(table !== null, 'the exemption table is where this guard expects it');
  const block = table ? harness.slice(table.index, matchBracket(harness, table.index + table[0].length - 1) + 1) : '';
  const ids = [...block.matchAll(/\bid:\s*'([^']*)'/g)].map((m) => m[1]);
  // The table may legitimately empty out (#85 retired one entry that way), so
  // zero ids is not itself a failure - but zero ids AND no `id:` key anywhere
  // would also be what a moved table looks like, which the check above catches.
  ok(block.length > 0, `exemption table read (${ids.length} entries)`);

  for (const id of ids) {
    const sep = id.indexOf('::');
    if (sep === -1) { ok(false, `'${id}' is not in <shot>::<subject> form`); continue; }
    const shot = id.slice(0, sep), subject = id.slice(sep + 2);

    const owning = Object.entries(rosters)
      .filter(([, r]) => r.shots.some((n) => nameMatcher(n)(shot)))
      .map(([name]) => name);
    if (owning.length !== 1) {
      ok(false, `'${id}': shot '${shot}' is declared by ${owning.length === 0
        ? 'no capture roster - the entry is inert'
        : `more than one roster (${owning.join(', ')})`}`);
      continue;
    }
    const roster = rosters[owning[0]];
    ok(true, `'${id}': shot '${shot}' belongs to the ${owning[0]} roster`);

    const declared = roster.decls.filter((d) => nameMatcher(d.shot)(shot)
      || nameMatcher(shot)(d.shot));
    if (declared.length === 0) {
      ok(false, `'${id}': the ${owning[0]} harness declares no subjects for '${shot}' - the entry is inert`);
      continue;
    }
    const known = declared.some((d) => d.subjects.includes(subject));
    ok(known, `'${id}': subject '${subject}' is declared by ${owning[0]} shot '${shot}'${known ? ''
      : ` - the entry is inert (declared there: ${declared.flatMap((d) => d.subjects).join(', ')})`}`);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
