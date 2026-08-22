/**
 * The mint says something (issue #36, D5): a toast on the log and a short
 * sting, on the frame a void mark or an argent mote is *minted* -- never on
 * the frame one is spent.
 *
 *   node tests/corruption-mint-toast.test.mjs
 *
 * Two halves, both driven through the real wiring rather than by calling the
 * painters directly, so deleting a subscription fails this file:
 *
 *  - `HUD.prototype.bind` turns a mint event into exactly one `toast` call and
 *    a spend event into none. `toast` itself needs a document, so it is the one
 *    thing stubbed; everything upstream of it is the shipping code.
 *  - `Audio.prototype.init` turns the same two mint events into a cue that
 *    charges the *priority* pool, which is what keeps it audible in the fight
 *    that earned it. Asserted by watching `priorityVoices` move and
 *    `worldVoices` stay put, against the stub graph tests/corruption-audio.mjs
 *    established.
 */
import { HUD } from '../src/ui/HUD.js';
import { Audio } from '../src/systems/Audio.js';

globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.removeEventListener = globalThis.removeEventListener || (() => {});

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const eq = (got, want, msg) => ok(got === want, `${msg}\n         got  ${got}\n         want ${want}`);

function el() {
  const classes = new Set();
  return {
    textContent: '', attrs: {},
    classList: { toggle: (c, v) => { if (v) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

function bus() {
  const listeners = new Map();
  return {
    listeners,
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
  };
}

/** A HUD bound to a bus, recording toasts instead of building DOM. */
function boundHUD() {
  const self = Object.create(HUD.prototype);
  self.c = {};
  self.refs = {
    corruptionPurse: el(), purseMarks: el(), purseMotes: el(),
    inventory: { addEventListener: () => {} },
  };
  const toasts = [];
  self.toast = (text, tier) => toasts.push({ text, tier });
  const events = bus();
  const ctx = { events };
  self.ctx = ctx;
  HUD.prototype.bind.call(self, ctx);
  return { self, toasts, emit: (n, p) => events.emit(n, p), listeners: events.listeners };
}

console.log('the mint announces itself on the log; the spend does not');
{
  const { toasts, emit } = boundHUD();

  emit('voidMarksChanged', { marks: 1, spent: 0 });
  eq(toasts.length, 1, 'a minted mark toasts exactly once');
  ok(/void mark/i.test(toasts[0]?.text), `and names the currency: ${toasts[0]?.text}`);
  ok(/\b1\b/.test(toasts[0]?.text), 'and quotes what the purse now holds');

  emit('argentMotesChanged', { motes: 2, spent: 0 });
  eq(toasts.length, 2, 'a minted mote toasts too');
  ok(/argent mote/i.test(toasts[1]?.text), `and names its own currency: ${toasts[1]?.text}`);
  ok(toasts[1]?.tier !== toasts[0]?.tier, 'the two currencies are coloured apart');

  emit('voidMarksChanged', { marks: 0, spent: 1 });
  emit('argentMotesChanged', { motes: 0, spent: 2 });
  eq(toasts.length, 2, 'spending either currency toasts nothing -- a purchase is not an earning');
}

console.log('\na malformed or empty mint says nothing');
{
  const { toasts, emit } = boundHUD();
  emit('voidMarksChanged', undefined);
  emit('argentMotesChanged', { motes: 0, spent: 0 });
  eq(toasts.length, 0, 'no payload and no gain are both silent');
}

console.log('\nthe toast fires through the shipped subscriptions, not a second bus');
{
  const { listeners } = boundHUD();
  eq(listeners.get('voidMarksChanged').length, 1, 'one voidMarksChanged handler carries both purse and toast');
  eq(listeners.get('argentMotesChanged').length, 1, 'and one argentMotesChanged handler likewise');
}

/* --------------------------------------------------------------- the sting */

const param = () => ({
  value: 0,
  setTargetAtTime() {}, setValueAtTime() {}, cancelScheduledValues() {},
  linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
});
const node = (kind) => {
  const n = {
    kind, out: [], gain: param(), frequency: param(), Q: param(), detune: param(),
    playbackRate: param(), buffer: null, loop: false,
    connect(d) { n.out.push(d); return d; }, disconnect() {}, start() {}, stop() {},
  };
  return n;
};
function makeAc() {
  const made = [];
  const make = (kind) => { const n = node(kind); made.push(n); return n; };
  return {
    currentTime: 0, sampleRate: 48000, made,
    createGain: () => make('gain'), createBiquadFilter: () => make('filter'),
    createOscillator: () => make('osc'), createBufferSource: () => make('src'),
    oscCount: () => made.filter((n) => n.kind === 'osc').length,
  };
}
function boundAudio() {
  const ac = makeAc();
  const a = new Audio();
  a.ac = ac;
  a.master = node('master');
  a.sfx = node('sfx');
  const events = bus();
  const ctx = { events };
  a.init(ctx);
  return { a, ac, emit: (n, p) => events.emit(n, p) };
}

console.log('\nthe mint is heard, out of the priority reserve');
{
  const { a, ac, emit } = boundAudio();
  const before = ac.oscCount();
  emit('voidMarksChanged', { marks: 1, spent: 0 });
  ok(ac.oscCount() > before, 'a minted mark plays');
  ok(a.priorityVoices > 0, 'and charges the priority reserve, not the world pool');
  eq(a.worldVoices, 0, 'the world pool is untouched -- a fight cannot crowd this out');

  const afterMark = ac.oscCount();
  ac.currentTime = 5;
  emit('argentMotesChanged', { motes: 1, spent: 0 });
  ok(ac.oscCount() > afterMark, 'a minted mote plays too');
}

console.log('\nspending is silent');
{
  const { ac, emit } = boundAudio();
  const before = ac.oscCount();
  emit('voidMarksChanged', { marks: 0, spent: 1 });
  emit('argentMotesChanged', { motes: 0, spent: 1 });
  emit('voidMarksChanged', undefined);
  eq(ac.oscCount(), before, 'no spend and no malformed payload reaches the graph');
}

console.log('\nthe sting is cheap enough to fire mid-fight');
{
  const { a, ac, emit } = boundAudio();
  emit('voidMarksChanged', { marks: 1, spent: 0 });
  ok(a.priorityVoices <= 4, `a mint costs at most 4 priority nodes (spent ${a.priorityVoices})`);
  ok(ac.oscCount() - 0 <= 4, 'and builds a handful of oscillators, not a fanfare');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
