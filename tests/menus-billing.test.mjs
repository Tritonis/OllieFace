/**
 * A menu that throws costs the player the menus, not the whole UI.
 *
 *   node tests/menus-billing.test.mjs
 *
 * Issue #118. `Menus` used to be constructed by `HUD.init` and pumped from the
 * first statement of `HUD.update`, so the Engine — which bills a failure to the
 * system whose phase it escaped — attributed every throw out of a menu, the
 * pause screen, the settings screen or the mutation window to `HUD.update`.
 * Since #72 six consecutive failures in one phase drop a noncritical system for
 * the rest of the run, so a defect anywhere in the menus took down the entire
 * HUD along with them: the health bar, the item strip, the boss bar, and the
 * death screen and settings a player would have used to recover.
 *
 * The billing scope now matches the failure scope: `Menus` is registered in
 * `main.js` in its own right.
 *
 * **This test is written to be red on the old structure**, and that is the
 * point of it — nothing previously asserted WHICH system was billed when Menus
 * threw, which is why the arrangement survived two independent reviews. So the
 * behavioural half does not hard-code either shape. It reads the wiring out of
 * `src/main.js` and `src/ui/HUD.js` and builds the frame that source describes:
 * point it at the old tree and it constructs the HUD-owns-Menus shape, watches
 * the Engine name `HUD`, and fails on the assertion below. Point it at this one
 * and it constructs the registered shape and passes.
 *
 * Real prototypes are used rather than look-alikes so the criticality flags and
 * the `constructor.name` the Engine reports are the shipped ones. Their bodies
 * are stubbed because there is no jsdom here and both classes want a document.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';
import { HUD } from '../src/ui/HUD.js';
import { Menus } from '../src/ui/Menus.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const mainSrc = readFileSync(join(SRC, 'main.js'), 'utf8');
const hudSrc = readFileSync(join(SRC, 'ui/HUD.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** Run `fn` with the console's error channel captured — a wedge logs once. */
function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

// ------------------------------------------------------- the wiring, as source

/** Does `main.js` register Menus as a system of its own? */
const registered = /engine\.add\(\s*new Menus\(/.test(mainSrc);
/** Does the HUD still pump Menus from one of its own frame phases? */
const hudPumps = /this\.menus\??\.(update|orbit)\(/.test(hudSrc);

console.log('the wiring says who owns the menus');
{
  ok(registered, 'main.js registers Menus with engine.add()');
  ok(!hudPumps, 'HUD does not also pump Menus from its own frame phases (that would tick it twice and bill HUD)');
  ok(Menus.critical === false, 'Menus declares static critical = false — a broken menu degrades, it does not end the run');
  ok(typeof Menus.prototype.update === 'function', 'Menus has an update phase of its own');
  ok(typeof Menus.prototype.lateUpdate === 'function', 'and a lateUpdate, which is where the title orbit went');
  ok(HUD.prototype.lateUpdate === undefined, 'and the HUD no longer carries the lateUpdate that used to run that orbit');
  ok(mainSrc.indexOf('engine.add(new Menus(') < mainSrc.indexOf('engine.add(new HUD())'),
    'Menus is registered before HUD, which needs the ctx.settings its constructor publishes');
}

// -------------------------------------------------- what a wedged menu costs

/**
 * Build a frame in the shape the source above describes, and wedge the menus.
 *
 * Returns the engine, the two systems, and every `systemDisabled` entry.
 */
function wedgeTheMenus() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;

  const menus = Object.create(Menus.prototype);
  menus.update = () => { throw new Error('the pause screen threw'); };

  const hud = Object.create(HUD.prototype);
  hud.updates = 0;
  // The HUD's real update does a great deal more; what matters here is only
  // whether it reaches into Menus, which is the fact read off the source.
  hud.update = function () { this.updates++; if (hudPumps) menus.update(); };
  // The real `init` builds the whole overlay out of `document`, which is not
  // here. It publishes `ctx.hud` and caches `ctx`; those are the parts the rest
  // of this test needs.
  hud.ctx = engine.ctx;
  hud.init = (ctx) => { ctx.hud = hud; };

  if (registered) engine.add(menus);
  engine.add(hud);

  const disabled = [];
  engine.ctx.events.on('systemDisabled', (e) => disabled.push(e));
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  return { engine, menus, hud, disabled };
}

console.log('a wedged menu is billed to Menus, and the HUD outlives it');
{
  const { engine, menus, hud, disabled } = wedgeTheMenus();

  ok(disabled.length === 1, `exactly one system was given up on (${disabled.length})`);
  ok(disabled[0]?.name === 'Menus',
    `the systemDisabled event names Menus, not HUD (named ${disabled[0]?.name})`);
  ok(!engine.systems.includes(menus), 'Menus is out of the update list');
  ok(engine.systems.includes(hud), 'the HUD is still in the update list');

  const before = hud.updates;
  quietly(() => engine._frame());
  ok(hud.updates === before + 1, 'and it is still being updated after the menus are gone');
  ok(engine.running === true && engine.ctx.fatalError === null, 'the run continues');
}

console.log('the HUD stops reaching for a system nobody is running');
{
  const { engine, hud } = wedgeTheMenus();
  // `remove()` blanks what the dead system's `init` published, and the HUD
  // reads its menus back off `ctx` for exactly this reason: it must not go on
  // calling into a Menus the Engine has given up on. Every `this.menus` use in
  // HUD.js is `?.`-guarded against this window.
  ok(engine.ctx.menus === null, 'ctx.menus was blanked when Menus was dropped');
  ok(hud.menus === null, 'so the HUD sees no menus rather than a dead one');
  ok(!/this\.menus\.[a-zA-Z]/.test(hudSrc), 'and no unguarded `this.menus.` call survives in HUD.js');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
