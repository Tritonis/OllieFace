// tests/import-boundaries.test.mjs
//
// Five files in `src/` are large enough that changing them is expensive:
// `core/Harness.js` (~5900 lines), `entities/EnemyMeshes.js` (~4450),
// `data/items.js` (~3300), `ui/hud.css` (~3250) and `systems/VFX.js` (~3000).
// Issue #49 is deliberately *not* a mandate to split them. It asks for the
// safety net that makes an opportunistic split cheap: if a feature happens to
// touch `VFX.js` and its author carves the status-effect channel out into its
// own module, nothing should have to be remembered for that carve to stay
// honest. The boundaries are asserted here instead of remembered there.
//
// The failure mode this file is written against is not "an import moved". It is
// a boundary test that encodes today's import graph as a fixture, goes red on
// every legitimate change, and trains everyone to re-bless it without reading
// it. So nothing below records an edge that exists. Every rule states an
// architectural claim — a direction of dependency that is wrong regardless of
// what the tree looks like this week — and a violation of one is a design
// mistake rather than a stale expectation. Adding a module never touches this
// file; adding a module that reaches the wrong way does.
//
// Three of the rules currently have violations. They are named exemptions with
// the debt spelled out, not softened rules: an exemption list that says what it
// owes is the useful artefact, and a rule quietly narrowed until it is green is
// the thing this file exists to prevent.
//
// This is static analysis. It reads text, imports nothing from `src/`, boots no
// browser and binds no port, so it costs milliseconds inside `npm test`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/* ------------------------------------------------------------------ *
 * Collecting the tree
 * ------------------------------------------------------------------ */

/** Every file under `src/`, as a `/`-separated path relative to `src/`. */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else out.push(relative(srcRoot, abs).split('\\').join('/'));
  }
  return out;
}

const allFiles = walk(srcRoot).sort();
const modules = allFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const moduleSet = new Set(modules);

/* An unscanned extension is the quietest way for this whole file to stop
 * meaning anything: a `.ts` build step arriving in `src/` would move real code
 * out of the sweep with every rule still reporting green. The scan covers ES
 * modules; anything else in `src/` has to be a known, declared non-module. */
const NON_MODULE_EXTENSIONS = new Set([
  // `ui/hud.css` — stylesheet, loaded by the bundler, no import graph of its own.
  'css',
]);
const unscanned = allFiles.filter((f) => !moduleSet.has(f));
const unknownKinds = unscanned.filter((f) => !NON_MODULE_EXTENSIONS.has(f.split('.').pop()));
ok(unknownKinds.length === 0,
  `every file under src/ is either scanned or a declared non-module${unknownKinds.length ? ` — unscanned and undeclared: ${unknownKinds.join(', ')}` : ''}`);

/* ------------------------------------------------------------------ *
 * Reading the edges
 * ------------------------------------------------------------------ */

/* Comments are removed before the import patterns run, because `Harness.js`
 * discusses other modules by path in its prose — `src/entities/Enemy.js:1638`
 * and similar — and a documentation reference is not a dependency. Only two
 * shapes are stripped, block comments and whole-line `//`, both of which are
 * how this repo actually writes commentary; a trailing `//` after code is left
 * alone rather than risk cutting a string that contains one.
 *
 * Stripping can in principle lose a real import — an unterminated `/*` inside a
 * template literal would swallow the rest of a file, and the one dependency
 * that matters most to rule 5 lives at `Harness.js:4338`, two thousand lines
 * below the last import statement. That is exactly what the positive controls
 * further down are for: they name specific edges the extractor must still find,
 * so a scan that has gone blind fails instead of passing over an empty set. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/* The four ways this codebase names a dependency: a static `import ... from`,
 * a re-exporting `export ... from`, a bare side-effect `import '...'`, and a
 * dynamic `import('...')`. Dynamic imports count as edges — `Harness.js` uses
 * one to reach the entity layer, and a rule that ignored them would call that
 * file clean. */
const EDGE_PATTERNS = [
  // The clause between the keyword and `from` may span lines — a long named
  // import list does — but it may not contain a quote or a semicolon. Allowing
  // those would let a lazy match run from a side-effect `import '...'` past the
  // end of its own statement and pair the keyword with some later `from`,
  // inventing an edge that is not in the source.
  /(?:^|[\s;}])(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Specifiers named by one module, in source order, deduplicated. */
function specifiersIn(source) {
  const text = stripComments(source);
  const found = new Set();
  for (const re of EDGE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) found.add(m[1]);
  }
  return [...found];
}

/* `three` is the one third-party package `src/` is allowed to name, and its
 * `addons/` subpaths come with it. Everything else is either a relative path
 * into `src/` or a rule-6 violation. */
const isThree = (spec) => spec === 'three' || spec.startsWith('three/');

/** The module a relative specifier names, or `null` if nothing is there. */
function resolveRelative(fromFile, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}/index.js`]) {
    if (moduleSet.has(candidate)) return candidate;
  }
  return null;
}

/** Every edge in `src/`, as `{ from, spec, to }`; `to` is null for `three`. */
const edges = [];
const unresolvable = [];
const escaping = [];
const foreignPackages = [];

for (const file of modules) {
  const source = readFileSync(join(srcRoot, file), 'utf8');
  for (const spec of specifiersIn(source)) {
    if (!spec.startsWith('.')) {
      if (isThree(spec)) edges.push({ from: file, spec, to: null });
      else foreignPackages.push(`${file} -> ${spec}`);
      continue;
    }
    const target = resolveRelative(file, spec);
    if (target === null) {
      /* Either the path leaves `src/` or it points at nothing. Both are
       * reported by name. An import this scan cannot follow is a hole in every
       * rule below, so "could not tell" has to read as failure — a skip here
       * would let a module escape the graph and take its violations with it. */
      if (posix.normalize(posix.join(posix.dirname(file), spec)).startsWith('..')) escaping.push(`${file} -> ${spec}`);
      else unresolvable.push(`${file} -> ${spec}`);
      continue;
    }
    edges.push({ from: file, spec, to: target });
  }
}

ok(unresolvable.length === 0,
  `every relative import inside src/ resolves to a file that exists${unresolvable.length ? ` — dangling: ${unresolvable.join(', ')}` : ''}`);

/* ------------------------------------------------------------------ *
 * Areas
 * ------------------------------------------------------------------ */

/* The areas a module can belong to, most specific first so `world/realms/`
 * wins over `world/`. `main.js` is its own area because it is the composition
 * root: it is the one place allowed to know about every layer at once, and
 * several rules below turn on that distinction. */
const AREAS = [
  { name: 'main', match: (f) => f === 'main.js' },
  { name: 'world/realms', match: (f) => f.startsWith('world/realms/') },
  ...['ai', 'core', 'data', 'entities', 'fx', 'net', 'shaders', 'systems', 'ui', 'world']
    .map((d) => ({ name: d, match: (f) => f.startsWith(`${d}/`) })),
];

const areaOf = (file) => AREAS.find((a) => a.match(file))?.name ?? null;

const unclassified = modules.filter((f) => areaOf(f) === null);
ok(unclassified.length === 0,
  `every module under src/ belongs to a known area${unclassified.length ? ` — unclassified: ${unclassified.join(', ')}` : ''}`);

/* ------------------------------------------------------------------ *
 * Anti-vacuity: the sweep has to have swept something
 * ------------------------------------------------------------------ */

/* A rule over an empty set passes. On Windows that is one backslash away at any
 * time — a path built with `join` and compared against a `/`-separated prefix
 * matches nothing at all, and the whole file goes green over no files. So each
 * area declares a floor.
 *
 * These are floors, not a fixture, and the asymmetry is deliberate: adding
 * modules — which is what a split does, and what the run-telemetry work in
 * flight will do — never touches this table, while a drop below a floor is
 * either a real deletion, which is worth one considered line here, or a sweep
 * that has stopped seeing an area. */
const AREA_FLOORS = {
  main: 1, ai: 2, core: 11, data: 12, entities: 6, fx: 4,
  net: 10, shaders: 7, systems: 15, ui: 9, world: 8, 'world/realms': 6,
};
const short = Object.entries(AREA_FLOORS)
  .map(([area, floor]) => ({ area, floor, seen: modules.filter((f) => areaOf(f) === area).length }))
  .filter((r) => r.seen < r.floor);
ok(short.length === 0,
  `every area is swept at its declared floor or above${short.length ? ` — short: ${short.map((r) => `${r.area} ${r.seen}<${r.floor}`).join(', ')}` : ''}`);

/* Counting files proves the walk works; it does not prove the *extractor*
 * works. These four edges are known to exist and are each the sole example of a
 * shape whose silent loss would empty a rule:
 *
 *   - a plain cross-area static import, the bulk of the graph;
 *   - the dynamic import at `Harness.js:4338`, which is the only thing rule 5
 *     has to say about `core/` — lose it and rule 5 congratulates the tree;
 *   - an edge out of `main.js`, whose exemption in rules 1 and 7 is only safe
 *     if the root's imports are visible in the first place;
 *   - a `three` specifier, so rule 6 is judging a populated set.
 *
 * If one of these disappears because the code genuinely changed, replace it
 * with another edge of the same shape. Deleting it without a replacement gives
 * back the blind spot it was bought to cover. */
const CONTROLS = [
  ['systems/Items.js', 'data/items.js', 'a static cross-area import'],
  ['core/Harness.js', 'entities/CharacterMesh.js', 'a dynamic import far below the import block'],
  ['main.js', 'ui/HUD.js', 'an edge out of the composition root'],
  ['shaders/GradeShader.js', 'three', 'a bare package specifier'],
];
for (const [from, to, shape] of CONTROLS) {
  const found = edges.some((e) => e.from === from && (e.to === to || e.spec === to));
  ok(found, `extractor still sees ${shape}: ${from} -> ${to}`);
}

/* ------------------------------------------------------------------ *
 * The rules
 * ------------------------------------------------------------------ */

/**
 * Reports the edges matching `forbidden`, minus anything named in `exempt`.
 * Exemptions are matched as `from -> to` and every one of them must still be a
 * live violation: an exemption that no longer describes anything is a stale
 * licence, and leaving it behind is how the next real violation slips in under
 * a name someone already agreed to.
 */
function rule(label, forbidden, exempt = []) {
  const hits = edges.filter((e) => e.to !== null && forbidden(e));
  const keys = new Set(hits.map((e) => `${e.from} -> ${e.to}`));
  const stale = exempt.filter((x) => !keys.has(x));
  const live = [...keys].filter((k) => !exempt.includes(k));
  ok(live.length === 0, `${label}${live.length ? ` — violations: ${live.join('; ')}` : ''}`);
  if (exempt.length) {
    ok(stale.length === 0,
      `${label}: every exemption is still a real edge${stale.length ? ` — stale, delete these: ${stale.join('; ')}` : ''}`);
  }
}

/* Rule 1 — the interface is a leaf.
 *
 * Nothing but `main.js` and `ui/` itself may import from `ui/`. The reason is
 * that the HUD is the most-rewritten surface in the game and the least
 * testable: the moment a system reads a HUD module to push a value into it, the
 * system stops being runnable headless and the HUD stops being replaceable. The
 * traffic goes the other way — the interface reads game state, game state never
 * reaches for the interface. `main.js` wires the two together, which is what a
 * composition root is for. */
rule('rule 1: nothing outside src/ui/ and src/main.js imports src/ui/',
  (e) => areaOf(e.to) === 'ui' && areaOf(e.from) !== 'ui' && areaOf(e.from) !== 'main');

/* Rule 2 — content tables are content.
 *
 * `data/` is the declarative half of the game: item tables, enemy stat blocks,
 * survivor definitions, ability numbers. It must stay loadable on its own, by a
 * test or a balance tool, without dragging the engine in behind it. `three` is
 * allowed because a few tables state colours and geometry inline; anything else
 * outside `data/` is not.
 *
 * The direction also matters for the item registry seam named in issue #49: a
 * `data/items.js` that reaches upward cannot be split by tier or archetype
 * without each piece dragging its own upward dependency along.
 *
 * EXEMPTION — `data/abilities.js` imports `clamp` from `core/MathUtil.js`.
 *   Debt: `MathUtil.js` is pure arithmetic and imports nothing at all, so today
 *   this costs `data/` no engine weight, and the exemption is guarded by the
 *   assertion below that keeps `MathUtil.js` import-free. It is still an
 *   exemption rather than a rule, because the guarantee is a property of one
 *   file's current contents and not of the directory it lives in. It clears
 *   when `clamp` reaches `data/` from somewhere that is structurally neutral —
 *   a util module outside `core/`, or inlined at its one use. */
rule('rule 2: src/data/ imports only src/data/ and three',
  (e) => areaOf(e.from) === 'data' && areaOf(e.to) !== 'data',
  ['data/abilities.js -> core/MathUtil.js']);

const mathUtilEdges = edges.filter((e) => e.from === 'core/MathUtil.js');
ok(mathUtilEdges.length === 0,
  `rule 2's exemption stays cheap: core/MathUtil.js imports nothing${mathUtilEdges.length ? ` — now imports ${mathUtilEdges.map((e) => e.spec).join(', ')}` : ''}`);

/* Rule 3 — shaders are strings, not participants.
 *
 * A module in `shaders/` holds GLSL source and the uniform block that goes with
 * it. It may compose with other shader modules and it may name `three`, and
 * that is all: shader code has to be compilable during prewarm, before any game
 * object exists, and a shader that reads a system or a data table cannot be. */
rule('rule 3: src/shaders/ imports only src/shaders/ and three',
  (e) => areaOf(e.from) === 'shaders' && areaOf(e.to) !== 'shaders');

/* Rule 4 — the engine floor does not reach upward.
 *
 * `core/` owns the loop, the renderer, the storage layer and the test harness.
 * It may consume the things below it — `data/`, `shaders/`, `fx/` — but if it
 * imports an entity, a system, the world or the network, then every layer above
 * it is welded to the loop and none of them can be extracted or exercised
 * without booting it. This is the rule that most directly protects
 * `core/Harness.js`, the largest file in the repo: the seam the issue names for
 * it is "scenarios by domain", and a scenario that has reached upward is a
 * scenario that cannot leave.
 *
 * EXEMPTION — `core/Harness.js` dynamically imports `entities/CharacterMesh.js`.
 *   Its `survivors()` capture scenario builds a row of survivor rigs to
 *   photograph, so it needs the character mesh factory. The import is dynamic
 *   and inside the scenario, which keeps it off the module's load path, but it
 *   is still `core/` depending on `entities/`. Debt: it clears when that
 *   scenario moves out of `core/` into the layer that owns the meshes — which
 *   is precisely the extraction issue #49 exists to make safe, and is out of
 *   scope for the test that guards it. */
const UPWARD_OF_CORE = new Set(['entities', 'systems', 'net', 'ui', 'world', 'world/realms']);
rule('rule 4: src/core/ does not import entities, systems, net, ui or world',
  (e) => areaOf(e.from) === 'core' && UPWARD_OF_CORE.has(areaOf(e.to)),
  ['core/Harness.js -> entities/CharacterMesh.js']);

/* Rule 5 — one runtime dependency.
 *
 * `three` is the only package `src/` names. This is not a purity exercise: the
 * game ships as a Steam build, so every added dependency is bundle size, a
 * licence, and a supply-chain surface, and the decision to take one deserves to
 * be visible in a diff rather than to arrive inside a feature. Adding a package
 * here is a one-line, deliberate edit to this list — which is the intended cost
 * of it, not an obstacle to route around. */
ok(foreignPackages.length === 0,
  `rule 5: three is the only package src/ imports${foreignPackages.length ? ` — also found: ${foreignPackages.join(', ')}` : ''}`);

/* Rule 6 — `src/` is closed.
 *
 * No module may import a path that climbs out of `src/`. `tools/`, `tests/` and
 * `reviews/` are not shipped, so an import reaching one of them either breaks
 * the bundle or silently ships a script that was never meant to be in it. The
 * traffic runs the other way: the tools import the game. */
ok(escaping.length === 0,
  `rule 6: no module imports a path outside src/${escaping.length ? ` — escaping: ${escaping.join(', ')}` : ''}`);

/* Rule 7 — a subdirectory is private to the area that contains it.
 *
 * When an area grows a subdirectory, only that area — and `main.js`, wiring it
 * up — may import into it. `systems/VFX.js` split into `systems/vfx/combat.js`
 * and friends should leave `systems/VFX.js` as the thing the rest of the game
 * talks to; the day `ui/HUD.js` imports `systems/vfx/status.js` directly, the
 * split has been undone and the file is merely spread across several places.
 *
 * This is the rule most specific to what issue #49 is for, and it is written
 * ahead of the splits rather than after them: it applies automatically to any
 * subdirectory that appears, so the person who carves up a hotspot inherits the
 * boundary instead of having to think of it.
 *
 * `world/realms/` is its only instance today and passes cleanly — realms are
 * swappable biome content reached through the world module, and a system
 * reaching into one particular realm would tie global behaviour to one place on
 * the map. Its two importers are both `main.js`, registering the realm set. */
// `areaOf` yields null for a module no area claims, which is already reported
// above; it is filtered here so one stray file cannot throw and take the rules
// that follow off the report with it.
const nestedAreas = [...new Set(modules.map(areaOf))].filter((a) => a !== null && a.includes('/'));
ok(nestedAreas.length > 0,
  `rule 7 has something to check: nested areas present (${nestedAreas.join(', ') || 'none'})`);
for (const nested of nestedAreas) {
  const parent = nested.split('/')[0];
  rule(`rule 7: only src/${parent}/ and src/main.js import src/${nested}/`,
    (e) => areaOf(e.to) === nested && areaOf(e.from) !== nested
      && areaOf(e.from) !== parent && areaOf(e.from) !== 'main');
}

console.log(`\n${pass} passed, ${fail} failed  (${modules.length} modules, ${edges.length} edges)`);
process.exit(fail ? 1 : 0);
