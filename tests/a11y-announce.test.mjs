/**
 * The assistive-technology layer (#45) and the cue captions (#46).
 *
 *   node tests/a11y-announce.test.mjs
 *
 * Both features are the shape this repo keeps getting bitten by: markup and a
 * settings row that LOOK right and are wired to nothing. An aria attribute
 * nobody sets, a live region nobody writes to and a caption toggle nothing
 * reads all pass a visual inspection and a screenshot diff identically to the
 * working version. So every claim here is driven through the real code path —
 * `Menus.prototype.open` on a stub document for focus, the trap through the
 * listener it actually registers, and the announcer through `ctx.events` — and
 * each of the two riskiest guards carries a control assertion that would go red
 * if the path under it were cut.
 *
 * There is no jsdom in this repo, so `document` and the elements are hand-built
 * stubs with only the surface the code touches — the idiom from
 * tests/save-failure-ui.test.mjs and tests/revive-hud.test.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

/* -- stubs ------------------------------------------------------------ */

function classSet() {
  const s = new Set();
  return {
    toggle: (c, v) => { if (v === undefined ? !s.has(c) : v) s.add(c); else s.delete(c); },
    add: (c) => s.add(c), remove: (...c) => c.forEach((x) => s.delete(x)),
    contains: (c) => s.has(c),
  };
}

/** Minimum element: attributes, a class list, children and focus. */
function el(tag = 'button', kids = []) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs: {}, dataset: {}, kids, textContent: '',
    disabled: false, hidden: false, focused: 0,
    classList: classSet(), style: {},
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return node.attrs[k] ?? null; },
    focus() { node.focused++; doc.activeElement = node; },
    querySelector(sel) { return node.querySelectorAll(sel)[0] ?? null; },
    // The only selectors this code uses are a tag list and the focusable
    // string; both reduce to "which of my children am I willing to return".
    querySelectorAll(sel) {
      if (sel.includes('h1')) return kids.filter((k) => k.tagName === 'H1' || k.tagName === 'H2');
      return kids.filter((k) => k.tagName === 'BUTTON' || k.tagName === 'INPUT');
    },
  };
  return node;
}

const doc = {
  activeElement: null,
  body: { classList: classSet() },
  pointerLockElement: null,
  listeners: {},
  addEventListener(name, fn) { (doc.listeners[name] ||= []).push(fn); },
  getElementById: () => null,
};
globalThis.document = doc;

const { markDialog, focusablesIn, trapTab, installFocusTrap } = await import('../src/ui/Dialogs.js');
const { Menus, DEFAULTS } = await import('../src/ui/Menus.js');
const { Announcer, CAPTION_HOLD_S } = await import('../src/ui/Announcer.js');
const { BANDS } = await import('../src/data/corruption.js');

/* -- 1. the canvas has a name and instructions ------------------------ */

const html = read('index.html');
const canvas = html.match(/<canvas[\s\S]*?>/)?.[0] ?? '';
ok(/aria-label="[^"]{4,}"/.test(canvas), 'the canvas carries a non-trivial accessible name');
const describes = canvas.match(/aria-describedby="([^"]+)"/)?.[1];
ok(!!describes, 'the canvas points at a description');
ok(!!describes && new RegExp(`id="${describes}"`).test(html),
  `the description target #${describes} exists in the document`);
const help = html.match(/id="viewport-help"[\s\S]*?<\/p>/)?.[0] ?? '';
ok(/W, A, S and D/.test(help) && /Escape/.test(help),
  'the instructions name movement and the pause key rather than being a stub');
ok(/class="a11y-only"/.test(help) && /\.a11y-only\s*\{[\s\S]*?clip-path/.test(read('src/ui/hud.css')),
  'the instructions are visually hidden by a clip rule, not display:none');

/* -- 2. dialog semantics ---------------------------------------------- */

const head = el('h2');
const panel = el('section', [head, el('button')]);
panel.dataset.screen = 'settings';
markDialog(panel);
ok(panel.getAttribute('role') === 'dialog', 'a screen is exposed with role=dialog');
ok(panel.getAttribute('aria-modal') === 'true', 'a screen is exposed as modal');
ok(panel.getAttribute('aria-labelledby') === head.getAttribute('id') && !!head.getAttribute('id'),
  'the panel is labelled by its own heading');

const headless = el('section', [el('button')]);
headless.dataset.screen = 'pause';
markDialog(headless);
ok(/Pause/.test(headless.getAttribute('aria-label') || ''),
  'a headingless screen falls back to a plain aria-label');

/* -- 3. focus moves in on open and is restored on close --------------- */

function fakeMenus() {
  const first = el('button'), last = el('button');
  const screen = el('section', [el('h2'), first, last]);
  screen.dataset.screen = 'settings';
  const self = Object.create(Menus.prototype);
  self.ctx = {};
  self.screen = null;
  self.stack = [];
  self.screens = { settings: screen };
  self.root = { classList: classSet(), dataset: {} };
  self.navIndex = 0;
  self.tooltip = null;
  self.logbook = { onClose() {}, onOpen() {}, navTargets: () => [] };
  self.syncEdictEntries = () => {};
  self.paintFocus = () => {};
  return { self, screen, first, last };
}

const canvasEl = el('canvas');
doc.activeElement = canvasEl;

const m = fakeMenus();
Menus.prototype.open.call(m.self, 'settings');
ok(doc.activeElement === m.first && m.first.focused === 1,
  'opening a screen moves real DOM focus to its first control');
ok(m.self._focusReturn === canvasEl, 'the element focus came from is remembered');

Menus.prototype.open.call(m.self, null);
ok(doc.activeElement === canvasEl && canvasEl.focused === 1,
  'closing the last screen restores focus to where it came from');

// Control: the restore is not a coincidence of the stub. Focus something else
// before opening and the restore must follow it, not the canvas.
const other = el('button');
doc.activeElement = other;
const m2 = fakeMenus();
Menus.prototype.open.call(m2.self, 'settings');
Menus.prototype.open.call(m2.self, null);
ok(doc.activeElement === other, 'control: the restore tracks whatever actually had focus');

/* -- 4. the trap cycles, driven through its own keydown listener ------ */

const t = fakeMenus();
t.self.screen = 'settings';
installFocusTrap(t.self, doc);
const onKey = doc.listeners.keydown.at(-1);
ok(typeof onKey === 'function', 'the trap registers a keydown listener');

let prevented = 0;
const key = (k, shift = false) => onKey({ key: k, shiftKey: shift, preventDefault: () => { prevented++; } });

doc.activeElement = t.last;
key('Tab');
ok(doc.activeElement === t.first && prevented === 1,
  'Tab off the last control wraps to the first instead of leaving the dialog');

doc.activeElement = t.first;
key('Tab', true);
ok(doc.activeElement === t.last && prevented === 2,
  'Shift+Tab off the first control wraps to the last');

doc.activeElement = t.first;
key('Tab');
ok(doc.activeElement === t.first && prevented === 2,
  'a mid-list Tab is left to the browser (no preventDefault, no forced focus)');

const outsider = el('button');
doc.activeElement = outsider;
key('Tab');
ok(doc.activeElement === t.first,
  'focus that escaped to the game underneath is pulled back into the dialog');

ok(trapTab(el('section', []), null) === null, 'a dialog with no controls traps nothing');
ok(focusablesIn(t.self.screens.settings).length === 2, 'the heading is not a focus target');

/* -- 5. the live region receives text on all four cue events ---------- */

function rig(settings = {}) {
  const handlers = new Map();
  const events = {
    on: (n, fn) => { (handlers.get(n) || handlers.set(n, []).get(n)).push(fn); },
    emit: (n, e) => (handlers.get(n) || []).forEach((fn) => fn(e)),
  };
  const live = el('div'), caption = el('div');
  const ctx = { player: { survivor: { name: 'Kestrel' } }, settings, events };
  const a = new Announcer(ctx, { live, caption }, events);
  return { a, live, caption, events, ctx };
}

const cues = [
  ['playerDowned', { player: null }, /down/i],
  ['playerRevived', { player: null }, /revived/i],
  ['corruptionBand', { band: 2, prev: 1 }, new RegExp(BANDS[2].name, 'i')],
  ['teleporterCharging', { progress: 0.5 }, /teleporter/i],
];

for (const [name, payload, want] of cues) {
  const r = rig();
  r.events.emit(name, payload);
  ok(want.test(r.live.textContent), `${name} reaches the live region ("${r.live.textContent.trim()}")`);
  ok(r.caption.textContent === '', `${name} writes no caption while the setting is off`);
}

// The four cues are the ones #45 names, and the fourth arm has an end state of
// its own worth naming.
{
  const r = rig();
  r.events.emit('teleporterComplete', {});
  ok(/charged/i.test(r.live.textContent), 'teleporterComplete reaches the live region');
}

// A repeat of the same cue must still be a NEW string, or a live region says
// nothing the second time somebody goes down.
{
  const r = rig();
  r.events.emit('playerDowned', {});
  const first = r.live.textContent;
  r.events.emit('playerDowned', {});
  ok(r.live.textContent !== first && r.live.textContent.trim() === first.trim(),
    'the same cue twice writes a distinct string with the same words');
}

// Control: the region is not written by construction — an event nobody
// subscribed to must leave it empty.
{
  const r = rig();
  r.events.emit('itemPickup', {});
  ok(r.live.textContent === '', 'control: an unsubscribed event writes nothing');
}

// A teammate is named; the local player is "You".
{
  const r = rig();
  r.events.emit('playerRevived', { player: { survivor: { name: 'Thorn' } } });
  ok(/Thorn/.test(r.live.textContent), 'a teammate cue names the teammate');
  r.events.emit('playerRevived', { player: r.ctx.player });
  ok(/^You/.test(r.live.textContent.trim()), 'the local player is addressed as "You"');
}

/* -- 6. captions: the setting is real, and it is consumed ------------- */

ok(DEFAULTS.captions === 0, 'captions default to off (current behaviour preserved)');
const menusSrc = read('src/ui/Menus.js');
ok(/data-seg="captions"/.test(menusSrc), 'captions have a settings row');
ok(/out\.captions = out\.captions === 1 \? 1 : 0/.test(menusSrc),
  'a stored captions value is normalised to 0 or 1 on load');

{
  const on = rig({ captions: 1 });
  on.events.emit('playerDowned', {});
  ok(/down/i.test(on.caption.textContent) && on.caption.classList.contains('is-on'),
    `captions on renders the cue ("${on.caption.textContent}")`);

  // The same rig, setting flipped live off the shared settings object — this
  // is how the settings screen turns it off mid-run. No further cue is
  // emitted: the toggle alone, on the next update tick, must clear it.
  on.a.ctx.settings.captions = 0;
  on.a.update(0.016);
  ok(on.caption.textContent === '' && !on.caption.classList.contains('is-on'),
    'turning captions off alone clears a standing caption on the next update tick');
}

{
  const on = rig({ captions: 1 });
  on.events.emit('teleporterComplete', {});
  on.a.update(CAPTION_HOLD_S - 0.01);
  ok(on.caption.textContent !== '', 'a caption is still up just before its hold expires');
  on.a.update(0.02);
  ok(on.caption.textContent === '' && !on.caption.classList.contains('is-on'),
    'a caption clears itself once the hold expires');
}

// Consumption on the real HUD path, not just the announcer's own: the HUD
// builds the two nodes, hands them over and ticks the decay.
const hudSrc = read('src/ui/HUD.js');
ok(/class="a11y-live a11y-only"[^>]*aria-live="polite"/.test(hudSrc),
  'the HUD markup carries the polite live region');
ok(/new Announcer\(ctx, \{ live: this\.refs\.live, caption: this\.refs\.caption \}\)/.test(hudSrc),
  'the HUD wires the announcer to those two nodes');
ok(/this\.announcer\.update\(dt\)/.test(hudSrc), 'the HUD ticks the caption hold every frame');

/* -- 7. the teleporter cue does not become a barrage ------------------ */

{
  const r = rig();
  let n = 0;
  const live = { textContent: '', classList: classSet() };
  Object.defineProperty(live, 'textContent', { set(v) { n++; this._v = v; }, get() { return this._v ?? ''; } });
  const a = new Announcer({ settings: {} }, { live, caption: null }, r.events);
  for (let i = 0; i <= 100; i++) r.events.emit('teleporterCharging', { progress: i / 100 });
  ok(n > 0 && n <= 5, `100 charge frames produce ${n} announcements, not 101`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
