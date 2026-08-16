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
 * does exactly what it did before. The enumeration half reads `main.js` for the
 * systems actually registered and insists each one has an answer on file — a
 * classification that silently omits a system is the failure mode of this whole
 * change, and only a test that goes and looks can catch it.
 */
import { readFileSync } from 'node:fs';
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

console.log('every registered system has an answer on file');
{
  const main = readFileSync(join(SRC, 'main.js'), 'utf8');

  // The classes handed to `engine.add(new X())` in main.js, resolved back to
  // their files through main.js's own import list. Reading the registrations
  // rather than listing them here is the whole point: a system added tomorrow
  // is in this set the moment it is registered, without anyone remembering to
  // come and add it.
  const registered = [...main.matchAll(/engine\.add\(new (\w+)\(/g)].map((m) => m[1]);
  ok(registered.length >= 18, `found the registrations in main.js (${registered.length})`);

  const importOf = (name) => {
    const m = main.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '([^']+)'`));
    return m ? resolve(SRC, m[1]) : null;
  };

  for (const name of registered) {
    const file = importOf(name);
    if (!file) { ok(false, `${name}: could not resolve its import in main.js`); continue; }
    const src = readFileSync(file, 'utf8');
    const decl = src.match(new RegExp(`class ${name} \\{\\s*(?:\\n\\s*//[^\\n]*)*\\n\\s*static critical = (true|false);`));
    ok(!!decl, `${name} declares static critical${decl ? ` = ${decl[1]}` : ''}`);
  }

  // The renderer is a plain object rather than a class, so it carries the flag
  // as an own property instead.
  ok(/engine\.add\(\{[\s\S]{0,600}?critical: false,/.test(main), 'the renderer object declares critical: false');

  // Three more go through the same machinery without appearing in main.js:
  // Lobby registers the two net systems at runtime, and Input's pad poll is
  // called through `_call` from inside the frame.
  for (const [label, rel] of [['NetHost', 'net/NetHost.js'], ['NetClient', 'net/NetClient.js'], ['Input', 'core/Input.js']]) {
    const src = readFileSync(join(SRC, rel), 'utf8');
    ok(/\n  static critical = (true|false);/.test(src), `${label} declares static critical`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
