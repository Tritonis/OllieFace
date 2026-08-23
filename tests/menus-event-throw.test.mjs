/**
 * A `Menus` throw reached through an event handler — `HUD`'s `itemPickup`
 * listener calling into `this.menus.showPickup`, billed onto `Menus` via
 * `engine.callInto` (#120) — can still walk all the way to `Engine.remove()`
 * and blank `ctx.menus`, exactly as a throw inside `Menus.update` would.
 *
 *   node tests/menus-event-throw.test.mjs
 *
 * This pins CURRENT behaviour rather than guarding against it: `Menus` is
 * `static critical = false` precisely so a broken menu degrades the player
 * instead of ending the run (`src/ui/FallbackPause.js`'s header comment says
 * so directly), and `HUD.menus` already reads `ctx.menus` through an
 * optional-chain getter for the moment `remove()` nulls it out. A menu that
 * is wedged on the event path getting the same treatment as one wedged in
 * `update` is the intended generalisation of #118/#120, not a gap — this
 * test exists so a future change to that contract trips over an assertion
 * instead of shipping silently.
 */
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fresh() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  return engine;
}

function quietly(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { fn(); } finally { console.error = real; }
  return lines;
}

/** A minimal stand-in for `src/ui/Menus.js`: noncritical, publishes `ctx.menus`. */
class FakeMenus {
  static critical = false;
  init(ctx) { ctx.menus = this; }
  showPickup() { throw new Error('menu render blew up on a pickup toast'); }
}

console.log('a Menus throw driven through an event handler disables Menus and blanks ctx.menus');
{
  const engine = fresh();
  const menus = engine.add(new FakeMenus());
  ok(engine.ctx.menus === menus, 'init published ctx.menus');

  // Stand-in for HUD's `bind()`: an `itemPickup` listener that routes into
  // `this.menus.showPickup()` billed onto Menus via `callInto`, the same
  // mechanism `src/ui/HUD.js`'s `billed()` proxy uses (#120).
  engine.ctx.events.on('itemPickup', () => {
    engine.callInto(menus, 'showPickup', () => menus.showPickup());
  });

  const lines = quietly(() => {
    for (let i = 0; i < DISABLE_AFTER; i++) engine.ctx.events.emit('itemPickup', { id: 'x' });
  });

  ok(!engine.systems.includes(menus), 'Menus was dropped from the update list after DISABLE_AFTER consecutive throws');
  ok(engine.ctx.menus === null, 'and ctx.menus was blanked, exactly as remove() blanks any self-published key');
  ok(engine.fatal === null, 'the run itself was not halted — Menus is noncritical');
  ok(lines.some((l) => /disabling it/.test(l)), 'the console recorded the disable');
}

console.log('the run keeps going with ctx.menus null: a later itemPickup event does not throw again');
{
  const engine = fresh();
  const menus = engine.add(new FakeMenus());
  let handlerThrew = false;
  engine.ctx.events.on('itemPickup', () => {
    // Mirrors HUD.menus: read off ctx, guard with `?.`, never call the dead
    // system directly.
    try {
      engine.ctx.menus?.showPickup();
    } catch (e) {
      handlerThrew = true;
    }
  });

  quietly(() => {
    for (let i = 0; i < DISABLE_AFTER; i++) {
      engine.callInto(menus, 'showPickup', () => { throw new Error('boom'); });
    }
  });
  ok(engine.ctx.menus === null, 'Menus is disabled and blanked');

  engine.ctx.events.emit('itemPickup', { id: 'y' });
  ok(!handlerThrew, 'a guarded consumer sees ctx.menus === null and simply skips the toast, per HUD.menus');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
