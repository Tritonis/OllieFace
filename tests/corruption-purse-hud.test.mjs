/**
 * The purse: void marks and argent motes on the gauge (issue #36, D2), and the
 * mint clause's manners inside a Sanctuary window.
 *
 *   node tests/corruption-purse-hud.test.mjs
 *
 * Two contracts, both of them text a player reads:
 *
 *  - the gauge repaints when `Corruption` emits, and it does so *through the
 *    wiring* rather than through a method call the test makes itself. Every
 *    purse assertion below goes in one end of `HUD.prototype.bind` -- an
 *    emitted event -- and comes out the other as element text, so cutting the
 *    two `on(...)` lines fails this file. A test that called `setPurse`
 *    directly would pass on an unwired HUD, which is the exact defect D2
 *    describes.
 *  - `pricedPrompt` stops quoting a mark forecast while sanctified, because
 *    inside the window `priceOf` is 0 and the clause can only ever say the
 *    player is getting nowhere.
 *
 * A real `HUD` needs a document, so this drives the prototype on a hand-built
 * `this` holding only what `bind` and `setPurse` touch -- the idiom from
 * tests/revive-hud.test.mjs and tests/hud-strip-hold.test.mjs.
 */
import { HUD } from '../src/ui/HUD.js';
import { pricedPrompt } from '../src/world/corruptionPrice.js';
import { BOON } from '../src/data/bandBoons.js';

// `bind` also hangs two tooltip handlers off the item strip and one off the
// window. Neither is under test here; both need to exist for the subscription
// list to be reachable at all.
globalThis.addEventListener = globalThis.addEventListener || (() => {});

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n         got  ${got}\n         want ${want}`);

function el() {
  const classes = new Set();
  return {
    textContent: '',
    attrs: {},
    classList: {
      toggle: (c, v) => { if (v) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

/** A HUD bound to a bus, with only the purse refs present. */
function boundHUD() {
  const self = Object.create(HUD.prototype);
  self.c = {};
  self.refs = {
    corruptionPurse: el(), purseMarks: el(), purseMotes: el(),
    inventory: { addEventListener: () => {} },
  };
  // A mint also toasts (D5, tests/corruption-mint-toast.test.mjs owns that
  // contract); `toast` builds DOM, so it is stubbed out here rather than
  // dragged into a test about the gauge.
  self.toast = () => {};
  const listeners = new Map();
  const ctx = {
    events: {
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
    },
  };
  self.ctx = ctx;
  HUD.prototype.bind.call(self, ctx);
  return { self, emit: (n, p) => ctx.events.emit(n, p), listeners };
}

console.log('the gauge learns the purse from the events, not from a poll');
{
  const { self, emit, listeners } = boundHUD();
  ok(listeners.has('voidMarksChanged'), '`bind` subscribes to voidMarksChanged');
  ok(listeners.has('argentMotesChanged'), '`bind` subscribes to argentMotesChanged');

  ok(!self.refs.corruptionPurse.classList.contains('is-on'), 'an empty purse is not shown');

  emit('voidMarksChanged', { marks: 3, spent: 0 });
  eq(self.refs.purseMarks.textContent, '3', 'a mint paints the mark count');
  ok(self.refs.corruptionPurse.classList.contains('is-on'), 'and lights the row');
  ok(self.refs.corruptionPurse.classList.contains('has-marks'), 'marks read as held');
  ok(!self.refs.corruptionPurse.classList.contains('has-motes'), 'motes still read as empty');
  eq(self.refs.purseMotes.textContent, '0', 'the mote count is still zero, not blank');

  emit('argentMotesChanged', { motes: 1, spent: 0 });
  eq(self.refs.purseMotes.textContent, '1', 'a ward paints the mote count');
  eq(self.refs.purseMarks.textContent, '3',
    'and does NOT clear the marks -- each event carries only its own currency');
  eq(self.refs.corruptionPurse.attrs['aria-label'], '3 void marks, 1 argent mote',
    'the row announces both counts, singular where singular');

  emit('voidMarksChanged', { marks: 0, spent: 3 });
  eq(self.refs.purseMarks.textContent, '0', 'spending the last mark empties the count');
  ok(self.refs.corruptionPurse.classList.contains('is-on'),
    'the row stays up while the motes are still held');

  emit('argentMotesChanged', { motes: 0, spent: 1 });
  ok(!self.refs.corruptionPurse.classList.contains('is-on'),
    'and goes away once both purses are spent out');
}

console.log('\na malformed event never blanks the other half');
{
  const { self, emit } = boundHUD();
  emit('voidMarksChanged', { marks: 2 });
  emit('argentMotesChanged', undefined);
  eq(self.refs.purseMarks.textContent, '2', 'an undefined payload leaves the marks alone');
  eq(self.refs.purseMotes.textContent, '0', 'and the motes at zero');
}

// ------------------------------------------------------------ the mint clause

/** A corruption stub: `priceOf` is 0 inside a window, face value outside one. */
function cor({ sanctified = false, peak = 0, world = 0 } = {}) {
  return {
    sanctified, peak, world, greed: false,
    priceOf: (n) => (sanctified ? 0 : n),
  };
}

console.log('\nthe mint clause is quoted outside a window and suppressed inside one');
{
  const outside = pricedPrompt({ corruption: cor({ peak: 10 }) }, 'Small Chest ($40)', 2);
  ok(/void mark/.test(outside), `a plain press quotes the forecast: ${outside}`);
  ok(outside.includes(`(${BOON.markPer - 12} to the next void mark)`),
    'and quotes the real distance, off `BOON.markPer`');

  const inside = pricedPrompt({ corruption: cor({ sanctified: true, peak: 10 }) }, 'Small Chest ($40)', 2);
  ok(/\+0 corruption/.test(inside), `a sanctified press is free: ${inside}`);
  ok(!/void mark/.test(inside),
    'and says nothing about marks -- a free press mints nothing, and saying so reads as a scolding');
  ok(inside.includes('Small Chest ($40)'), 'the gain half is untouched');
  ok(inside.split('|').length === 3, 'and all three clauses are still there');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
