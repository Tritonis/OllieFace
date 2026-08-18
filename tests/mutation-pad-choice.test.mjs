/**
 * The mutation window on a controller (#98).
 *
 *   node tests/mutation-pad-choice.test.mjs
 *
 * Before this, `.mutate-choice` could only be answered by Digit1-3 or by a
 * click pointer lock makes unreachable mid-run, so a pad player watched every
 * offer lapse into "the void chooses" — the pre-#33 behaviour #33 existed to
 * remove. D-pad LEFT / UP / RIGHT now answer the three offers.
 *
 * Every check drives the real `Menus` methods on a hand-built DOM (the idiom
 * from tests/a11y-announce.test.mjs — there is no jsdom in this repo). The
 * offers stub re-derives its children from the markup `showMutationChoice`
 * actually writes, so the prompt assertions read the shipped HTML rather than
 * a fixture.
 *
 * Both new guards were shown capable of failing:
 *   - drop the `|| ctx.input?.pad?.edges?.has?.(MUTATE_PAD[i])` clause in
 *     Menus.update and all three 'd-pad ... picks offer' checks go red (this
 *     is unmodified master's behaviour);
 *   - drop the `dpad` suppression in readPad and 'the same press does not also
 *     move the menu cursor' goes red.
 */
function classSet() {
  const s = new Set();
  return {
    toggle: (c, v) => { if (v === undefined ? !s.has(c) : v) s.add(c); else s.delete(c); },
    add: (c) => s.add(c), remove: (...c) => c.forEach((x) => s.delete(x)),
    contains: (c) => s.has(c),
  };
}

/** `itemArt` rasterises the card's icon through a 2D canvas. Nothing here
 *  looks at the pixels, so the context absorbs every call and every property. */
function stubCanvas() {
  const ctx2d = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (t[k] = () => ctx2d)),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return {
    width: 0, height: 0,
    getContext: () => ctx2d,
    toDataURL: () => 'data:image/png;base64,',
  };
}

globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? stubCanvas() : { style: {}, setAttribute() {} }),
  activeElement: null,
  body: { classList: classSet() },
  pointerLockElement: null,
  addEventListener() {},
  getElementById: () => null,
};

const { Menus } = await import('../src/ui/Menus.js');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log('  PASS ', msg); }
  else { fail++; console.log('  FAIL ', msg, detail === undefined ? '' : JSON.stringify(detail)); }
};

/** The D-pad indices this window answers on, restated literally so the day
 *  somebody re-orders MUTATE_PAD the test notices instead of following it. */
const DPAD = { UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/* -- stubs ------------------------------------------------------------ */

/** Reconstructs its children from the markup assigned to it, so the parsing
 *  side of these assertions is the shipped template. */
function offersEl() {
  const node = {
    html: '', children: [], keys: [],
    set innerHTML(v) {
      node.html = v;
      node.children = [...v.matchAll(/data-mutate-pick="([^"]*)"/g)]
        .map((m) => ({ dataset: { mutatePick: m[1] } }));
      node.keys = [...v.matchAll(/data-mutate-key="(\d+)"[^>]*>([^<]*)</g)]
        .map((m) => ({ dataset: { mutateKey: m[1] }, textContent: m[2] }));
    },
    get innerHTML() { return node.html; },
    querySelectorAll: (sel) => (sel.includes('mutate-key') ? node.keys : node.children),
  };
  return node;
}

const OFFERS = [
  { baseId: 'alpha', baseName: 'Alpha', count: 1, blightId: 'alpha_b', blightName: 'Alpha Blight', blightDescription: 'a' },
  { baseId: 'beta', baseName: 'Beta', count: 2, blightId: 'beta_b', blightName: 'Beta Blight', blightDescription: 'b' },
  { baseId: 'gamma', baseName: 'Gamma', count: 1, blightId: 'gamma_b', blightName: 'Gamma Blight', blightDescription: 'c' },
];

function fakeInput() {
  const keys = new Set();
  const edges = new Set();
  return {
    keys, edges, padActive: false,
    pad: { edges, held: new Set() },
    hit: (c) => keys.has(c),
    clearPadEdges() { edges.clear(); },
  };
}

/** A `Menus` with only what the mutation path touches, on the real prototype. */
function fakeMenus(glyphs = 'xbox') {
  const self = Object.create(Menus.prototype);
  self.screen = null;
  self.bannerTimer = 0;
  self.navIndex = 0;
  self.pad = { buttons: new Set() };
  self.settings = { controllerGlyphs: glyphs };
  self.mutateEl = { classList: classSet() };
  self.mutateRefs = { offers: offersEl(), clock: { textContent: '' } };
  self.commandActive = () => false;
  self.navigate = () => {};
  return self;
}

function open(m, picked) {
  m.showMutationChoice({
    offers: OFFERS, seconds: 12,
    onPick: (id) => picked.push(id),
    onRefuse: () => picked.push('refuse'),
  });
}

/* -- 1. a d-pad direction resolves its offer --------------------------- */

console.log('d-pad left / up / right answer the three offers');
for (const [btn, dir, want] of [[DPAD.LEFT, 'left', 'alpha'], [DPAD.UP, 'up', 'beta'], [DPAD.RIGHT, 'right', 'gamma']]) {
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.pad.edges.add(btn);
  m.update(ctx, 1 / 60);
  ok(picked.length === 1 && picked[0] === want, `d-pad ${dir} picks offer ${want}`, picked);
}

{
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  const ctx = { input: fakeInput(), player: { alive: true } };
  // Down is deliberately not an answer: three directions, three offers.
  ctx.input.pad.edges.add(DPAD.DOWN);
  m.update(ctx, 1 / 60);
  ok(picked.length === 0, 'd-pad down answers nothing', picked);
}

{
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.pad.edges.add(DPAD.LEFT);
  m.update(ctx, 1 / 60);
  ok(ctx.input.pad.edges.size === 0, 'the answering edge is consumed, not left for the next reader');
}

{
  const m = fakeMenus();
  m.screen = 'pause';
  const picked = [];
  open(m, picked);
  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.pad.edges.add(DPAD.LEFT);
  m.update(ctx, 1 / 60);
  ok(picked.length === 0, 'with a screen open the d-pad belongs to the menu, not the offer', picked);
}

/* -- 2. the same press must not also drive menu navigation ------------- */

console.log('the window suppresses the d-pad as a menu cursor while it owns it');

// Node ships a read-only `navigator`, so the gamepad source is installed once
// as a redefined property and swapped through `padSource`.
let padSource = () => [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { getGamepads: () => padSource() },
});

function padHeld(...btns) {
  const buttons = [];
  for (let i = 0; i < 16; i++) buttons[i] = { pressed: btns.includes(i) };
  return { connected: true, axes: [0, 0], buttons };
}

{
  const m = fakeMenus();
  padSource = () => [padHeld(DPAD.LEFT)];
  // Baseline: with no window up, d-pad left is a menu move. If this ever goes
  // red the suppression below has swallowed navigation outright.
  m.screen = 'pause';
  const before = m.readPad();
  ok(before.dx === -1, 'with no offer up, d-pad left still moves the menu cursor', before);
}

{
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  padSource = () => [padHeld(DPAD.LEFT)];
  const out = m.readPad();
  ok(out.dx === 0 && out.dy === 0,
    'the same press does not also move the menu cursor while the window is up', out);
}

{
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  m.screen = 'pause';
  padSource = () => [padHeld(DPAD.UP)];
  const out = m.readPad();
  ok(out.dy === -1, 'suppression lifts once a screen owns the d-pad instead', out);
}

{
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  const gp = padHeld();
  gp.axes = [-1, 0];
  padSource = () => [gp];
  const out = m.readPad();
  ok(out.dx === -1, 'only the hat is suppressed -- the stick still navigates', out);
}

/* -- 3. the keyboard lever and the timeout are untouched --------------- */

console.log('Digit1-3 and the timeout path are unchanged');
for (const [i, want] of [[0, 'alpha'], [1, 'beta'], [2, 'gamma']]) {
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.keys.add(`Digit${i + 1}`);
  m.update(ctx, 1 / 60);
  ok(picked.length === 1 && picked[0] === want, `Digit${i + 1} still picks ${want}`, picked);
}

{
  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  const ctx = {
    input: fakeInput(), player: { alive: true },
    items: { mutationChoice: () => ({ remaining: 4.2 }) },
  };
  m.update(ctx, 1 / 60);
  ok(picked.length === 0, 'a frame with no press resolves nothing');
  ok(m.mutateRefs.clock.textContent === '5s', 'the clock still mirrors Items own remaining', m.mutateRefs.clock.textContent);
  ok(m.mutateEl.classList.contains('is-on'), 'the panel is still owned by Items, not closed here');
  m.hideMutationChoice();
  ok(m.mutate === null && !m.mutateEl.classList.contains('is-on'), 'Items still closes it through hideMutationChoice');
}

/* -- 4. the card prompt is a live glyph label -------------------------- */

console.log('the card prompt follows the device and the glyph set');
{
  const m = fakeMenus();
  open(m, []);
  const digits = m.mutateRefs.offers.keys.map((k) => k.textContent);
  ok(digits.join(',') === '1,2,3', 'on the keyboard the cards still read 1 2 3', digits);

  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.padActive = true;
  m.update(ctx, 1 / 60);
  const xbox = m.mutateRefs.offers.keys.map((k) => k.textContent);
  ok(xbox.join(',') === 'D-Pad Left,D-Pad Up,D-Pad Right', 'on a pad the cards read the Xbox d-pad names', xbox);

  m.settings.controllerGlyphs = 'playstation';
  m.update(ctx, 1 / 60);
  const ps = m.mutateRefs.offers.keys.map((k) => k.textContent);
  ok(ps.join(',') === 'Left,Up,Right', 'and follow the selected glyph set rather than a hardcoded string', ps);
  ok(ps.join(',') !== xbox.join(','), 'the two glyph sets genuinely differ');

  ctx.input.padActive = false;
  m.update(ctx, 1 / 60);
  ok(m.mutateRefs.offers.keys.map((k) => k.textContent).join(',') === '1,2,3',
    'and fall back to digits the moment the player touches the keyboard again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
