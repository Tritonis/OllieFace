/**
 * Integration review (merged master), Major M2: `hasChoiceWindow()` /
 * `choiceWindowKind()` read only the host's own `_muteChoice`. On a co-op
 * CLIENT the standing decision is `_muteOffer` (Items.js's
 * `mutationChoiceOffered` listener, `ctx.authority` false) — so any
 * client-side caller of either method (the reviewer's repro is the
 * tutorial's glossary defer; the method itself promises this for every
 * caller, not just that one) was blind to a live window of every kind and
 * would paint straight over it.
 *
 * RED below reproduces the pre-fix method body directly (`!!items._muteChoice`
 * alone) against a real client-context `Items` instance with a live window of
 * each of the four kinds, and shows it reads `false` throughout — the bug.
 * GREEN calls the real, now-widened `hasChoiceWindow`/`choiceWindowKind` and
 * shows they read the standing window correctly, for all four kinds, and
 * revert to nothing standing once the host's close arrives — with no change
 * to the host-side callers this file's sibling (`choice-slot-exclusion`)
 * already covers.
 */
import { Items } from '../src/systems/Items.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A client context: `authority: false`, the shape `NetClient.init` leaves. */
function clientCtx() {
  const listeners = new Map();
  const player = { isPlayer: true, alive: true };
  const ctx = {
    authority: false, seed: 1, time: 0, netRole: 'client',
    rng: new RNG(1),
    player,
    events: {
      emit(name, p) { for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const items = new Items();
  items.init(ctx);
  return { ctx, items };
}

const KINDS = ['blight', 'argent', 'wound', 'temper'];

for (const kind of KINDS) {
  console.log(`kind '${kind}': a client's addressed window`);
  const f = clientCtx();
  const { ctx, items } = f;

  ok(items.hasChoiceWindow() === false, 'starts with nothing standing');
  ok(items.choiceWindowKind() === null, 'and no kind');

  ctx.events.emit('mutationChoiceOffered', {
    kind, band: 0, seconds: 8, offerId: 7, owner: ctx.player,
    offers: [{ baseId: 'x' }, { baseId: 'y' }],
  });

  // RED — the pre-fix body, reproduced directly rather than via a flag, so
  // this stays red regardless of what `Items.js` currently does.
  const preFixHasWindow = !!items._muteChoice;
  ok(preFixHasWindow === false,
    `RED: the pre-fix check (_muteChoice alone) misses the standing ${kind} window — this is the bug M2 reports`);

  // GREEN — the real, fixed methods.
  ok(items.hasChoiceWindow() === true, `GREEN: hasChoiceWindow() sees the standing ${kind} window`);
  ok(items.choiceWindowKind() === kind, `GREEN: choiceWindowKind() names it '${kind}'`);

  // The host's close arrives (owner-addressed, like every mirror here) and
  // the shadow clears — the window is a display, not a second state machine.
  ctx.events.emit('mutationChoiceClosed', { kind, band: 0, offerId: 7, owner: ctx.player });
  ok(items.hasChoiceWindow() === false, 'and clears once the host closes it');
  ok(items.choiceWindowKind() === null, 'with no kind left standing');
}

console.log('an offer addressed to a different pawn is not this client\'s window');
{
  const { ctx, items } = clientCtx();
  const stranger = { isPlayer: true, alive: true };
  ctx.events.emit('mutationChoiceOffered', {
    kind: 'temper', band: 0, seconds: 8, offerId: 9, owner: stranger, offers: [{ baseId: 'x' }, { baseId: 'y' }],
  });
  ok(items.hasChoiceWindow() === false, 'a teammate\'s window does not read as standing here');
}

console.log('on the host, the widening changes nothing: _muteOffer never populates there');
{
  const listeners = new Map();
  const ctx = {
    authority: true, seed: 1, time: 0, netRole: 'single',
    rng: new RNG(1),
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { for (const fn of [...(listeners.get(name) || [])]) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  const items = new Items();
  items.init(ctx);
  // A host that somehow received the event anyway (never happens in real
  // play — `_openChoice` is what populates a host's own window) still refuses
  // to populate `_muteOffer`, per the listener's own `if (ctx.authority)
  // return;` guard.
  ctx.events.emit('mutationChoiceOffered', {
    kind: 'temper', band: 0, seconds: 8, offerId: 3, owner: ctx.player, offers: [{ baseId: 'x' }, { baseId: 'y' }],
  });
  ok(items._muteOffer == null, "a host's _muteOffer stays null even if the event reaches it");
  ok(items.hasChoiceWindow() === false, 'so hasChoiceWindow() is unaffected on the host');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
