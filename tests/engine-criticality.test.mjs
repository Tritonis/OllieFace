/**
 * Critical vs noncritical systems, and what a throw from each one does.
 *
 *   node tests/engine-criticality.test.mjs
 *
 * The Engine used to treat every system exception identically: name it once,
 * carry on. That is right for a system that only draws things and wrong for one
 * the run's truth is made of, so systems now declare which they are and the
 * Engine stops for the second kind.
 *
 * Two halves are tested here, and the second is the one that will age. The
 * behaviour half proves a critical throw halts and a noncritical throw still
 * does exactly what it did before. The enumeration half walks every
 * `engine.add(` call site in `src/` and insists each one resolves to a class
 * that declares its criticality — failing, loudly and by name, on any call site
 * it cannot resolve. A classification that silently omits a system is the
 * failure mode of this whole change, so the guard is written to fail closed:
 * "I could not tell" is a FAIL, never a skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, isCriticalSystem } from '../src/core/Engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** An engine with the loop flag set but no rAF — frames are driven by hand. */
function fresh() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  return engine;
}

const boom = (phase) => function () { throw new Error(`boom in ${phase}`); };

class Cosmetic {
  static critical = false;
  update() { boom('update').call(this); }
}
class Authoritative {
  static critical = true;
  update() { boom('update').call(this); }
}
class AuthoritativeFixed {
  static critical = true;
  fixedUpdate() { boom('fixedUpdate').call(this); }
}
class Undeclared {
  update() { boom('update').call(this); }
}
/** Registered after the thrower, so "did the rest of the frame run" is answerable. */
class Witness {
  static critical = false;
  constructor() { this.updates = 0; this.fixed = 0; }
  update() { this.updates++; }
  fixedUpdate() { this.fixed++; }
}

console.log('a quiet frame is untouched');
{
  const engine = fresh();
  const w = engine.add(new Witness());
  engine.accumulator = 0.02;
  engine._frame();
  ok(w.updates === 1 && w.fixed === 1, 'every phase ran');
  ok(engine.ctx.frameErrors === 0, 'no frame errors recorded');
  ok(engine.fatal === null && engine.ctx.fatalError === null, 'nothing fatal');
  ok(engine.running === true, 'the loop is still running');
}

console.log('a noncritical throw logs and continues, exactly as before');
{
  const engine = fresh();
  engine.add(new Cosmetic());
  const w = engine.add(new Witness());
  engine._frame();
  ok(w.updates === 1, 'the system registered after the thrower still ran');
  ok(engine.running === true, 'the loop is still running');
  ok(engine.fatal === null, 'no fatal was recorded');
  ok(engine.ctx.fatalError === null, 'ctx.fatalError stayed null');
  ok(engine.ctx.authority === true, 'authority was not surrendered');
  ok(engine.ctx.frameErrors === 1, 'the error counter still moved');
  ok(engine.ctx.lastFrameError?.who === 'Cosmetic.update', 'lastFrameError names the offender');
  engine._frame();
  ok(w.updates === 2, 'and it keeps running on later frames');
  ok(engine.ctx.frameErrors === 2, 'each throw counts');
}

console.log('a critical throw stops the run');
{
  const engine = fresh();
  const seen = [];
  engine.ctx.events.on('fatalError', (e) => seen.push(e));
  engine.add(new Authoritative());
  const w = engine.add(new Witness());
  engine._frame();
  ok(engine.running === false, 'the loop stopped');
  ok(engine.fatal?.who === 'Authoritative.update', 'the failure names the offender');
  ok(engine.ctx.fatalError === engine.fatal, 'ctx carries the same record');
  ok(engine.ctx.authority === false, 'authority was surrendered');
  ok(engine.ctx.frameErrors === 1, 'the existing telemetry still moved');
  ok(engine.ctx.lastFrameError?.who === 'Authoritative.update', 'lastFrameError is still written');
  ok(w.updates === 0, 'the rest of the frame was abandoned');
  ok(seen.length === 1 && seen[0].who === 'Authoritative.update', 'fatalError was emitted once');
  engine.start();
  ok(engine.running === false, 'start() will not restart a halted engine');
}

console.log('a halted engine calls nobody, however the frame was driven');
{
  // Not reachable through `start()`, which stops the loop on the way into
  // `_halt`. It is reachable by anything holding the Engine and calling
  // `_frame()` itself, and "a halted engine calls no more systems" is stated
  // without qualification, so it has to hold there too.
  const engine = fresh();
  const w = engine.add(new Witness());
  engine.fatal = { who: 'Elsewhere.update', message: 'halted on an earlier frame', frame: 0 };
  engine.accumulator = 0.2;
  const before = engine.frame;
  engine._frame();
  ok(w.updates === 0 && w.fixed === 0, 'a healthy noncritical system did not run');
  ok(engine.frame === before, 'the frame counter did not advance');
}

console.log('a critical throw in the fixed step abandons the substep loop too');
{
  const engine = fresh();
  engine.add(new AuthoritativeFixed());
  const w = engine.add(new Witness());
  engine.accumulator = 0.2;
  engine._frame();
  ok(engine.fatal?.who === 'AuthoritativeFixed.fixedUpdate', 'the fixed phase halts');
  ok(w.fixed === 0 && w.updates === 0, 'no later system ran in any phase');
}

console.log('omission gets the strict answer, and says so');
{
  const engine = fresh();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  engine.add(new Undeclared());
  console.warn = realWarn;
  ok(warnings.some((w) => w.includes('Undeclared')), 'add() warns that nothing was declared');
  engine._frame();
  ok(engine.running === false, 'an undeclared system is treated as critical');
  ok(isCriticalSystem({}) === true, 'so is a bare object');
  ok(isCriticalSystem(undefined) === true, 'and so is a frame-level throw with no system');
}

/** Every .js file under src/, depth-first. */
function sources(dir = SRC, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * The same source with every comment body and string body blanked to spaces,
 * newlines and length preserved so offsets and line numbers still line up.
 *
 * Scanning for call sites has to happen on this rather than on the raw text.
 * A first attempt skipped a matched site when the *preceding line* looked like
 * prose, which caught `Player.js`'s JSDoc example but missed a single-line
 * block comment mentioning the same call outright: that manufactured a phantom
 * registration which then resolved happily against a class the file already
 * imported, and the suite went green over a call site that does not exist. A
 * completeness guard that can be fooled into counting imaginary entries is no
 * better than one that misses real ones.
 *
 * Known limit, stated rather than papered over: a regex literal containing an
 * odd quote is read as a string here. Nothing in `src/` does that today, and
 * the exact site count below is what would notice if something started.
 */
function scannable(src) {
  const out = src.split('');
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { blank(i++); if (i < src.length) blank(i++); continue; }
        blank(i++);
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * The source text of the argument at `open` (the index of a `(`), brackets
 * balanced. Comments are skipped rather than scanned, because an apostrophe in
 * one — "this frame's input edges", in the very object literal this has to
 * read — otherwise opens a string that swallows the rest of the argument.
 */
function argumentAt(src, open) {
  let depth = 0, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return null; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; if (i < 1) return null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

/**
 * Does the class `name`, declared in `src`, carry a boolean `static critical`?
 * Read from the class's opening block, where the convention puts it.
 */
function declaresCriticality(src, name) {
  const at = src.search(new RegExp(`(^|\\n)(export )?class ${name} \\{`));
  if (at < 0) return null;
  const m = src.slice(at, at + 1500).match(/\n\s*static critical = (true|false);/);
  return m ? m[1] : null;
}

/** Resolve a class name used in `file` to the file that declares it. */
function fileDeclaring(file, src, name) {
  if (new RegExp(`(^|\\n)(export )?class ${name} \\{`).test(src)) return file;
  const m = src.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '([^']+)'`));
  return m ? resolve(dirname(file), m[1]) : null;
}

console.log('every registered system has an answer on file');
{
  // Every `engine.add(` call site in src/, whatever shape its argument takes,
  // each one resolved to a declaration or else reported. The guard is written
  // to fail closed: a registration whose argument this cannot follow is a FAIL
  // naming the call site, never a quiet skip. That distinction is the whole
  // value of the test — an earlier version only recognised the literal
  // `engine.add(new Thing())` shape, so `engine.add(makeThing())` registered an
  // unclassified system and the suite stayed green.
  //
  // What it therefore guarantees: every *statically written* registration in
  // src/ either points at a declared class or fails. What it cannot see: a
  // registration built somewhere this cannot read it back to a class — which is
  // exactly the case it now fails on rather than passes.
  let sites = 0;
  for (const file of sources()) {
    // Two views of the same bytes, and the distinction matters both ways.
    // `src` has comment and string bodies blanked, so prose that merely
    // *mentions* a registration cannot be counted as one and an apostrophe
    // cannot swallow a real argument; offsets are preserved, so line numbers
    // and `argumentAt` address the same characters. But resolution has to read
    // `raw`, because an import specifier lives inside a string literal — the
    // first attempt at this blanked those too and sent `readFileSync` a path
    // made of spaces.
    const raw = readFileSync(file, 'utf8');
    const src = scannable(raw);
    const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
    for (const m of src.matchAll(/(?:^|[^\w.])(?:this\.)?engine\.add\(/g)) {
      const open = m.index + m[0].length - 1;
      const line = src.slice(0, open).split('\n').length;
      const where = `${rel}:${line}`;
      const arg = (argumentAt(src, open) || '').trim();
      sites++;

      const asClass = arg.match(/^new (\w+)\(/);
      if (asClass) {
        const name = asClass[1];
        const home = fileDeclaring(file, raw, name);
        if (!home) { ok(false, `${where}: cannot find where ${name} is declared`); continue; }
        const declared = declaresCriticality(readFileSync(home, 'utf8'), name);
        ok(declared !== null, `${where}: ${name} declares static critical${declared ? ` = ${declared}` : ''}`);
        continue;
      }

      if (arg.startsWith('{')) {
        // A plain-object system carries the flag as an own property. The
        // renderer in main.js is the only one.
        const declared = arg.match(/(^|\n)\s*critical: (true|false),/);
        ok(!!declared, `${where}: object-literal system declares critical${declared ? `: ${declared[2]}` : ''}`);
        continue;
      }

      // A local binding. Follow it to the `new X()` that produced it, in the
      // same function, and no further — anything cleverer than that is a shape
      // this test is honestly telling you it cannot read.
      const local = /^\w+$/.test(arg)
        ? src.slice(0, open).match(new RegExp(`(?:const|let|var) ${arg} = new (\\w+)\\(`, 'g'))?.pop()
        : null;
      const name = local ? local.match(/new (\w+)\(/)[1] : null;
      if (name) {
        const home = fileDeclaring(file, raw, name);
        const declared = home && declaresCriticality(readFileSync(home, 'utf8'), name);
        ok(!!declared, `${where}: \`${arg}\` is a ${name}, which declares static critical${declared ? ` = ${declared}` : ''}`);
        continue;
      }

      ok(false, `${where}: cannot resolve \`engine.add(${arg})\` to a class — classify it, or teach this test the shape`);
    }
  }
  // Pinned exactly, not as a floor. A floor only notices sites appearing; the
  // failure this guard exists for is one going *missing* — a registration the
  // scanner stopped being able to see would sail under `>= 20` while the system
  // it registers goes unclassified. Moving this number is fine and expected;
  // moving it without noticing is not.
  ok(sites === 21, `every engine.add() call site in src/ is accounted for (${sites}, expected 21)`);

  // Input is not registered at all: its `pollPad` is called through the
  // Engine's `_call` from inside the frame, so it needs the same declaration
  // and no `engine.add(` scan will ever find it.
  const input = readFileSync(join(SRC, 'core/Input.js'), 'utf8');
  ok(declaresCriticality(input, 'Input') !== null, 'Input declares static critical');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
