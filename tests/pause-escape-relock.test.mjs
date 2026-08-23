/**
 * Escape must leave the pause screen and stay left.
 *
 *   node tests/pause-escape-relock.test.mjs
 *
 * Issue #184: pressing Escape on the pause screen closed it and it immediately
 * re-opened, forever.
 *
 * The mechanism is not a double-fired key — there is exactly one Escape
 * consumer, `Menus.navigate` polling `input.hit('Escape')` — it is the browser
 * and the page fighting over the same keypress:
 *
 *   - Exiting pointer lock with Escape belongs to the *browser*. While the
 *     canvas is locked Chrome swallows the Escape keydown, so the page never
 *     sees it; `Menus`' `pointerlockchange` listener is what opens the pause.
 *   - That unlock gesture stays live for the whole press. A `requestPointerLock`
 *     issued from inside the same press is granted and then revoked ~86 ms later.
 *   - The revoke arrives as "unlocked, no screen open", which the listener reads
 *     as "the player hit Esc" — and re-opens the pause screen.
 *
 * Captured from real OS key input (keybd_event with true scancodes, so the
 * browser's own Escape handling is in play — CDP-synthesized keys do not drive
 * it) against headed Chromium. `MODEL_LOCK` below replays exactly this:
 *
 *   2045ms keydown Escape screen=pause
 *   2047ms navigate: Escape consumed, screen=pause
 *   2047ms open(null)                      <- the menu closes
 *   2048ms pointerlockchange lock=yes      <- our request is granted
 *   2121ms pointerlockchange lock=no       <- the still-live Escape revokes it
 *   2121ms open(pause)                     <- and the pause screen is back
 *
 * The fix is `Menus.relockPointer`: the lock is asked for only once the Escape
 * key is up. **This test is written to be red on the old code** — restore the
 * unconditional `requestPointerLock` in `act('resume')` and the first case
 * below reports the reopen.
 *
 * There is no jsdom here, so `open` (which wants the whole screen DOM) is the
 * one method stubbed; everything the bug actually lives in — `act`, `escape`,
 * `navigate`, `relockPointer`, `update`, `onPointerLockChange` — is the shipped
 * code running on the real prototype.
 */
import { Menus } from '../src/ui/Menus.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/**
 * Chromium's observed behaviour, as traced above.
 *
 * A lock requested while Escape is still held is granted and then revoked; the
 * revoke is dispatched to the page as a `pointerlockchange`. A lock requested
 * with the key up simply holds.
 */
function rig() {
  const held = new Set();
  const trace = [];
  const canvas = {};
  let menus = null;

  globalThis.document = { pointerLockElement: null };

  canvas.requestPointerLock = () => {
    trace.push('requestPointerLock');
    globalThis.document.pointerLockElement = canvas;
    trace.push('lock=yes');
    if (held.has('Escape')) {
      // The gesture that closed the menu is still down: Chrome takes it back.
      globalThis.document.pointerLockElement = null;
      trace.push('lock=no (revoked by the live Escape)');
      menus.onPointerLockChange();
    }
    return { catch: () => {} };
  };

  const input = {
    canvas,
    padActive: false,
    pressed: new Set(),
    down: (code) => held.has(code),
    hit: (code) => input.pressed.has(code),
  };

  const m = Object.create(Menus.prototype);
  menus = m;
  m.ctx = { input, player: { alive: true }, paused: true };
  m.screen = 'pause';
  m.stack = [];
  m.relockPending = false;
  m.capture = null;
  m.mutate = null;
  m.bannerTimer = 0;
  m.navIndex = 0;
  m.pad = { axis: 0, buttons: new Set() };
  m.opens = [];
  m.commandActive = () => false;
  m.navTargets = () => [];
  // The only stub: the real `open` builds and paints the screen DOM. Its two
  // facts that this bug turns on are kept.
  m.open = function (name) {
    this.opens.push(name);
    trace.push('open(' + name + ')');
    this.screen = name;
    this.ctx.paused = !!name;
    if (name) this.relockPending = false;
  };
  m.close = function () { this.open(null); };

  /** One frame: deliver the polled edge, run the real update, clear the edge. */
  const frame = () => { m.update(m.ctx, 1 / 60); input.pressed.clear(); };

  return { m, held, trace, input, frame, canvas };
}

console.log('\nEscape on the pause screen closes it and it stays closed');
{
  const { m, held, trace, input, frame } = rig();

  // Escape goes down while the pause screen is up and the canvas is unlocked
  // (`open('pause')` released the lock on the way in).
  held.add('Escape');
  input.pressed.add('Escape');
  trace.push('keydown Escape screen=' + m.screen);
  frame();

  ok(m.screen === null, 'the pause screen closed');
  ok(!m.opens.includes('pause'), 'and did not re-open on the same press');
  ok(trace.filter((t) => t === 'requestPointerLock').length === 0,
    'no pointer lock was asked for while the Escape that closed it was still down');
  ok(m.relockPending === true, 'the re-lock is pending on the key coming up');

  // A few more frames with the key still held change nothing.
  frame(); frame();
  ok(m.screen === null, 'still closed several frames later, key still held');
  ok(trace.filter((t) => t === 'requestPointerLock').length === 0, 'and still no lock requested');

  // The player lets go.
  held.delete('Escape');
  frame();
  ok(trace.filter((t) => t === 'requestPointerLock').length === 1,
    'the lock is taken exactly once, on the frame after the key came up');
  ok(globalThis.document.pointerLockElement !== null, 'and it held — the world has the mouse back');
  ok(m.screen === null, 'the player is in the world, not the pause screen');

  frame(); frame();
  ok(trace.filter((t) => t === 'requestPointerLock').length === 1, 'and it is not asked for again');

  if (fail) console.log('\n  trace:\n    ' + trace.join('\n    '));
}

console.log('\nThe deferral is only for a held Escape');
{
  // Resume clicked with the mouse: nothing is held, so the lock is taken in the
  // same frame exactly as it always was. Guards against over-deferring.
  const { m, trace } = rig();
  m.act('resume');
  ok(m.screen === null, 'the menu closed');
  ok(trace.filter((t) => t === 'requestPointerLock').length === 1, 'the lock was taken immediately');
  ok(m.relockPending === false, 'with nothing left pending');
}

console.log('\nA pad resume still never grabs the pointer');
{
  const { m, trace, input } = rig();
  input.padActive = true;
  m.act('resume');
  ok(trace.filter((t) => t === 'requestPointerLock').length === 0, 'no lock requested on a pad');
  ok(m.relockPending === false, 'and nothing pending to grab it later');
}

console.log('\nRe-opening a screen cancels a pending re-lock');
{
  const { m, held, input, frame, trace } = rig();
  held.add('Escape');
  input.pressed.add('Escape');
  frame();
  ok(m.relockPending === true, 'a re-lock is pending');

  // The player pauses again (a pad Start, a lost focus) before letting go.
  m.open('pause');
  ok(m.relockPending === false, 'opening a screen dropped it');

  held.delete('Escape');
  input.pressed.clear();
  m.update(m.ctx, 1 / 60);
  ok(trace.filter((t) => t === 'requestPointerLock').length === 0,
    'so releasing the key does not steal the mouse out from under an open menu');
}

console.log('\nLosing the lock in the world still pauses');
{
  // The fix must not cost the feature: an unlock the game did not provoke —
  // the Escape that opens the pause, an alt-tab — still opens the pause screen.
  const { m } = rig();
  m.screen = null;
  globalThis.document.pointerLockElement = null;
  m.onPointerLockChange();
  ok(m.screen === 'pause', 'an unlock with no screen up opens the pause screen');
}

console.log('\nA dead player is not paused by an unlock');
{
  const { m } = rig();
  m.screen = null;
  m.ctx.player.alive = false;
  globalThis.document.pointerLockElement = null;
  m.onPointerLockChange();
  ok(m.screen === null, 'no pause screen over the death screen');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
