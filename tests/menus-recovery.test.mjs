/**
 * Losing the menus must not cost the player the ability to stop.
 *
 *   node tests/menus-recovery.test.mjs
 *
 * Issue #119. `Menus` is the pause screen, the death screen, settings, title,
 * survivor select and co-op, and it is `static critical = false` — six
 * consecutive throws in one phase and the Engine drops it for the rest of the
 * run, blanking `ctx.menus`. `Menus.open()` (Menus.js:1624) is the last
 * player-reachable writer of `ctx.paused` to go with it — `NetHost.js:553,570`
 * also write the flag, but both branches are computed off `ctx.menus?.screen`
 * and neither can fire again once that is permanently null. So after the
 * disable the run is still playable and can never be interrupted again.
 *
 * The fallback under test is `src/ui/FallbackPause.js`: one document keydown
 * listener, installed at boot rather than inside any system, that writes
 * `ctx.paused` and offers a restart — and that stands down completely while
 * `ctx.menus` is alive, or while a co-op peer is still playing in the world the
 * flag would freeze.
 *
 * The engine here is the shipped one and it is genuinely driven to the disable;
 * nothing asserts against a hand-set `ctx.menus = null`. There is no jsdom, so
 * a minimal document stand-in is passed in through the injectable `doc`
 * parameter to prove the overlay is built and torn down.
 */
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';
import { Menus } from '../src/ui/Menus.js';
import { NetHost } from '../src/net/NetHost.js';
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

// ------------------------------------------------- the co-op host (issue #119 review)

/**
 * A host's emergency pause must not freeze the people still playing.
 *
 * `ctx.paused` gates all of `Engine`'s fixedUpdate (`Engine.js:747`) and
 * `NetHost.update` refuses to broadcast a snapshot while it is set
 * (`NetHost.js:598`), so on an authority it is everyone's flag, not the local
 * player's. `NetHost._holdSession` exists precisely because a host that froze
 * itself left a peer "unable to finish, die or end the run" for four seconds
 * (`NetHost.js:497-522`) — and it cannot cover this path, because everything it
 * computes comes off `ctx.menus?.screen`, which is permanently null once the
 * menus are gone.
 *
 * Real `NetHost`, real `_holdSession`, real snapshot path; the peer is a stub
 * that counts what arrives.
 */
console.log('a co-op host pressing the emergency key does not starve its peer');
{
  const { ctx } = wedgeTheMenus();
  const doc = fakeDoc();
  ctx.input = { enabled: true };
  installFallbackPause(ctx, doc);

  const host = new NetHost({ maxPlayers: 4 });
  let clock = 0;
  host._now = () => clock;
  host.init(ctx);
  let sent = 0;
  const peer = { id: 1, pumpSim() {}, send() { sent++; }, sendUnreliable() { sent++; }, sendState() { sent++; }, sendEvent() {}, close() {} };
  host.clients.set(1, { peer, pawn: { alive: true }, inputs: [], lastTick: 0, netId: 1 });
  ok(host.hasLivePeer() === true, 'a peer is connected and its pawn is alive');
  ok(ctx.net === host, 'and the host published itself as ctx.net, which is what the fallback asks');

  const pump = (n) => { sent = 0; for (let i = 0; i < n; i++) { clock += 50; ctx.tick = (ctx.tick | 0) + 1; host.tick++; host.update(ctx, 1 / 60); } return sent; };

  const running = pump(5);
  ok(running > 0, `the peer is being fed while the host plays (${running} sends)`);

  doc.press(FALLBACK_PAUSE_KEY);
  ok(fallbackPauseOpen() === true, 'the host raised the emergency overlay');
  ok(ctx.paused === false,
    'and the world did NOT freeze — a menu on a host with a live peer is an overlay, not a pause');
  ok(ctx.input.enabled === false, 'the host set its own controls down');
  const held = pump(5);
  ok(held > 0, `the peer keeps receiving snapshots across the overlay (${held} sends)`);

  // And the recovery the ticket is for is still there in this case.
  const row = doc.body.children[0].children[0].children.find((c) => c.className === 'fallback-pause__row');
  ok(row.children.some((b) => /restart/i.test(b.textContent)),
    'restart is still on the overlay for a host that could not pause');

  doc.press(FALLBACK_PAUSE_KEY);
  ok(fallbackPauseOpen() === false && ctx.input.enabled === true,
    'and the host takes the controls back up');

  // Not a blanket refusal to pause: the last peer dies, and the same key
  // freezes the world exactly as it does solo. Re-asked every press.
  host.clients.get(1).pawn.alive = false;
  doc.press(FALLBACK_PAUSE_KEY);
  ok(ctx.paused === true, 'with nobody left playing, the same key freezes the world again');
  clearFallbackPause();
  ctx.paused = false;
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

  // What the install DOES, observed rather than read: a real listener on a real
  // document, and a handle that takes it off again. `main.js` cannot be
  // imported here (it wants a canvas and a WebGL context), so the call site is
  // checked separately below — but the thing being called is exercised.
  {
    const doc = fakeDoc();
    const ctx = { menus: null, paused: false };
    const off = installFallbackPause(ctx, doc);
    doc.press(FALLBACK_PAUSE_KEY);
    ok(ctx.paused === true, 'installFallbackPause registers a live keydown listener');
    ok(typeof off === 'function', 'and returns an unsubscribe handle');
    off();
    setFallbackPause(ctx, false, doc);
    doc.press(FALLBACK_PAUSE_KEY);
    ok(ctx.paused === false, 'and the handle actually removes it');
    clearFallbackPause();
  }

  // The call site: at module top level, not merely present in the text. The
  // first spelling of this was a line-anchored regex and a dead branch
  // (`if (false) { installFallbackPause(ctx); }`) walked straight through it,
  // while a harmless re-indent of the live call false-failed. Brace depth
  // answers both: a dead branch is depth 1, an indented top-level call is
  // still depth 0. Comments and quoted text are stripped first so their braces
  // cannot skew the count.
  const code = mainSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
  const at = code.search(/\binstallFallbackPause\s*\(\s*ctx\s*\)/);
  ok(at >= 0, 'main.js calls installFallbackPause(ctx)');
  const before = code.slice(0, Math.max(at, 0));
  const depth = (before.split('{').length - 1) - (before.split('}').length - 1);
  ok(at >= 0 && depth === 0, `and at module top level, so it always runs (brace depth ${depth})`);
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
