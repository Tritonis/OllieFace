/**
 * Losing the menus must not cost the player the ability to stop.
 *
 *   node tests/menus-recovery.test.mjs
 *
 * Issue #119. `Menus` is the pause screen, the death screen, settings, title,
 * survivor select and co-op, and it is `static critical = false` — six
 * consecutive throws in one phase and the Engine drops it for the rest of the
 * run, blanking `ctx.menus`. `ctx.paused` is written by exactly one
 * player-reachable place in the tree, `Menus.open()` (Menus.js:1624), so after
 * that disable the run is still playable and can never be interrupted again.
 *
 * The fallback under test is `src/ui/FallbackPause.js`: one document keydown
 * listener, installed at boot rather than inside any system, that writes
 * `ctx.paused` and offers a restart — and that stands down completely while
 * `ctx.menus` is alive.
 *
 * The engine here is the shipped one and it is genuinely driven to the disable;
 * nothing asserts against a hand-set `ctx.menus = null`. There is no jsdom, so
 * a minimal document stand-in is passed in through the injectable `doc`
 * parameter to prove the overlay is built and torn down.
 */
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';
import { Menus } from '../src/ui/Menus.js';
import {
  installFallbackPause, setFallbackPause, fallbackRestart, fallbackPauseOpen,
  clearFallbackPause, fallbackPauseNeeded, FALLBACK_PAUSE_KEY, FALLBACK_PAUSE_LABEL,
} from '../src/ui/FallbackPause.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

// ------------------------------------------------------------ a tiny document

/** Enough of a DOM for `showOverlay` to build into and `remove()` off. */
function fakeDoc() {
  const listeners = new Map();
  const node = (tag) => ({
    tag, children: [], className: '', textContent: '', style: {},
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    addEventListener() {},
    remove() {
      const i = this.parent?.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    },
  });
  return {
    head: node('head'),
    body: node('body'),
    createElement: node,
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners.get(type) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    press(key) {
      let prevented = false;
      const e = { key, preventDefault: () => { prevented = true; } };
      for (const fn of listeners.get('keydown') || []) fn(e);
      return prevented;
    },
  };
}

/**
 * Drive the real Engine until it gives up on a real-prototype `Menus`.
 *
 * The class is the shipped one so `static critical === false` and the
 * `constructor.name` the Engine reports are the shipped values; only the frame
 * phases are stubbed, because `Menus.init` wants a document.
 */
function wedgeTheMenus() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  const menus = Object.create(Menus.prototype);
  menus.screen = null;
  menus.init = (ctx) => { ctx.menus = menus; };
  menus.update = () => { throw new Error('the pause screen threw'); };
  menus.lateUpdate = () => {};
  engine.add(menus);
  const disabled = [];
  engine.ctx.events.on('systemDisabled', (e) => disabled.push(e));
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  return { engine, ctx: engine.ctx, menus, disabled };
}

// -------------------------------------------------------- the premise itself

console.log('the premise: nothing but Menus writes ctx.paused for a player');
{
  const { ctx, disabled, menus, engine } = wedgeTheMenus();
  ok(disabled[0]?.name === 'Menus', `the Engine gave up on Menus (${disabled[0]?.name})`);
  ok(ctx.menus === null, 'and blanked ctx.menus, so nothing can call open() any more');
  ok(!engine.systems.includes(menus), 'Menus is out of the update list');
  ok(engine.running === true, 'the run continues — this is the uninterruptible state, not a stopped one');
}

// ------------------------------------------------------ the recovery, headless

console.log('a player whose menus were switched off can still pause');
{
  const { ctx } = wedgeTheMenus();
  const doc = fakeDoc();
  ctx.input = { enabled: true };
  installFallbackPause(ctx, doc);

  ok(ctx.paused === false, 'the world is running');
  const prevented = doc.press(FALLBACK_PAUSE_KEY);
  ok(ctx.paused === true, `${FALLBACK_PAUSE_LABEL} paused a run with no menus`);
  ok(prevented === true, 'and the key was claimed');
  ok(ctx.input.enabled === false, 'the stick is muted behind the emergency overlay');
  ok(fallbackPauseOpen() === true, 'an overlay is up saying what happened');
  ok(doc.body.children.length === 1, 'and it is in the document');

  doc.press(FALLBACK_PAUSE_KEY);
  ok(ctx.paused === false, 'and the same key resumed');
  ok(ctx.input.enabled === true, 'the stick came back');
  ok(fallbackPauseOpen() === false && doc.body.children.length === 0, 'the overlay went with it');
  clearFallbackPause();
}

console.log('and can still reach a restart');
{
  const { ctx } = wedgeTheMenus();
  const doc = fakeDoc();
  installFallbackPause(ctx, doc);
  doc.press(FALLBACK_PAUSE_KEY);

  // The overlay's buttons: Resume, and the one that ends the run. `Restart run`
  // is `location.reload()`, which is verbatim what `Menus.act('restart')` and
  // the pause screen's `act('quit')` do.
  const row = doc.body.children[0].children[0].children.find((c) => c.className === 'fallback-pause__row');
  const labels = row.children.map((b) => b.textContent);
  ok(labels.some((t) => /restart/i.test(t)), `the overlay offers a restart (${labels.join(' | ')})`);

  let reloaded = 0;
  fallbackRestart({ reload: () => { reloaded++; } });
  ok(reloaded === 1, 'and it reloads the page, ending the run — the same switch Menus.act(\'restart\') throws');
  clearFallbackPause();
}

// --------------------------------------------------------------- arbitration

console.log('while the menus are alive they keep the pause outright');
{
  const engine = new Engine({ canvas: null, seed: 1 });
  const ctx = engine.ctx;
  const menus = Object.create(Menus.prototype);
  menus.init = (c) => { c.menus = menus; };
  menus.update = () => {}; menus.lateUpdate = () => {};
  engine.add(menus);
  ctx.input = { enabled: true };

  const doc = fakeDoc();
  installFallbackPause(ctx, doc);
  ok(fallbackPauseNeeded(ctx) === false, 'the fallback knows it has no business here');
  const prevented = doc.press(FALLBACK_PAUSE_KEY);
  ok(ctx.paused === false, 'the key did not pause anything');
  ok(prevented === false, 'and was not even claimed — it falls through to whatever else wants it');
  ok(doc.body.children.length === 0, 'no overlay was built');

  // Direct calls are refused too, not merely the key path: two writers to
  // ctx.paused is the failure this arbitration exists to prevent.
  setFallbackPause(ctx, true, doc);
  ok(ctx.paused === false && ctx.input.enabled === true,
    'and setFallbackPause refuses outright while ctx.menus is live');
  clearFallbackPause();
}

// ------------------------------------------------ the notice names the key

console.log('the fallback is actually installed, and not from inside a system');
{
  const fs = await import('node:fs');
  const mainSrc = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const hudSrc = fs.readFileSync(new URL('../src/ui/HUD.js', import.meta.url), 'utf8');
  // Anchored at the start of a line: a commented-out call is not an install,
  // and a looser regex read one as one while this test was being written.
  ok(/^installFallbackPause\(ctx\);/m.test(mainSrc), 'main.js installs it at boot');
  // Installed from a system's init, that system's own disable — or a throw in
  // its init — would take the recovery path with it. The whole point is that
  // no remove() can reach it.
  ok(!/installFallbackPause/.test(hudSrc), 'and no frame system owns it');
}

console.log('the on-screen notice tells the player which key');
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/ui/SystemNotice.js', import.meta.url), 'utf8'));
  ok(/FALLBACK_PAUSE_LABEL/.test(src),
    'SystemNotice takes the key name from FallbackPause rather than restating it');
  ok(/name === 'Menus'/.test(src),
    'and only says it when it is the menus that went — the only case with nothing left to press');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
