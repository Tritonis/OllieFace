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

globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
};

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
    consumePadEdge(btn) { edges.delete(btn); },
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

/* -- 2. offer answer and menu cursor are mutually exclusive by state ---- */

// The honest claim, narrowed after review. There is no suppression flag and
// there must not be one: `navigate` returns before it reaches `readPad` unless
// a screen is open, and the pick branch runs only when one is NOT. So the two
// handlers can never both see a press. What follows tests exactly that -- the
// state exclusion through the real `navigate`/`update` -- and no longer claims
// to prevent a defect that the early return already makes impossible. An
// earlier draft asserted a guard inside `readPad`; that guard was unreachable
// in production and its test only proved that `readPad` had been edited.
console.log('a d-pad press reaches the offer or the menu, never both');

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

/** A `Menus` whose `navigate` is the real one, so the exclusion is tested and
 *  not stubbed over. `navMove` records rather than touching the DOM. */
function navMenus() {
  const m = fakeMenus();
  delete m.navigate;
  m.moves = [];
  m.navMove = (d) => m.moves.push(d);
  m.navTargets = () => [];
  m.navScroll = () => false;
  m.navConfirm = () => {};
  m.escape = () => {};
  return m;
}

{
  // With the offer up and no screen, a held D-pad answers the offer and the
  // navigator never runs at all.
  const m = navMenus();
  const picked = [];
  open(m, picked);
  padSource = () => [padHeld(DPAD.LEFT)];
  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.pad.edges.add(DPAD.LEFT);
  m.update(ctx, 1 / 60);
  ok(picked.length === 1 && m.moves.length === 0,
    'answering an offer moves no menu cursor', { picked, moves: m.moves });
}

{
  // With a screen open the same held D-pad is a menu cursor and nothing else:
  // the pick branch is off, so there is nothing to double-handle.
  const m = navMenus();
  const picked = [];
  open(m, picked);
  m.screen = 'pause';
  padSource = () => [padHeld(DPAD.LEFT)];
  const ctx = { input: fakeInput(), player: { alive: true } };
  ctx.input.pad.edges.add(DPAD.LEFT);
  m.update(ctx, 1 / 60);
  ok(picked.length === 0 && m.moves.length === 1,
    'with a screen open the press is a menu move and answers no offer', { picked, moves: m.moves });
}

{
  // The exclusion is a property of `navigate` itself, stated directly: with no
  // screen it consults no pad at all. If this ever goes red, the pick branch
  // needs a real suppression and the comment above stops being true.
  const m = navMenus();
  open(m, []);
  let read = 0;
  m.readPad = () => { read++; return { dx: 0, dy: 0, confirm: false, back: false }; };
  m.navigate({ input: fakeInput() });
  ok(read === 0, 'navigate reads no pad while no screen is open', read);
}

/* -- 2b. the consume is scoped: other pad edges survive ---------------- */

// Review Major 1. This runs a REAL `Input` rather than the stub above, because
// the claim is about the input layer's own bookkeeping. Answering an offer
// used to call the blanket `clearPadEdges`, which drops EVERY pad-bound
// action's edge for the frame -- invisible today only because gameplay polls
// `down()` rather than `hit()`, and a trap for the first consumer that does
// not. Fails on cfacb1f.
console.log('answering an offer spends one edge, not the frame');
{
  const { Input } = await import('../src/core/Input.js');
  const { PAD_BUTTON } = await import('../src/core/PadState.js');
  const { VIRTUAL } = await import('../src/core/Bindings.js');

  const canvasEl = { addEventListener() {}, requestPointerLock() {} };
  const gp = padHeld(PAD_BUTTON.A, DPAD.LEFT);
  const input = new Input(canvasEl, { getPads: () => [gp] });
  input.pollPad();
  ok(input.hit(VIRTUAL.jump) && input.pad.edges.has(DPAD.LEFT),
    'setup: jump (pad A) and d-pad left both register an edge this frame');

  const m = fakeMenus();
  const picked = [];
  open(m, picked);
  m.update({ input, player: { alive: true } }, 1 / 60);

  ok(picked.length === 1 && picked[0] === 'alpha', 'the offer is still answered', picked);
  ok(!input.pad.edges.has(DPAD.LEFT), 'the answering edge is spent');
  ok(input.hit(VIRTUAL.jump), 'an unrelated pad-bound action keeps its edge');
  ok(input.pad.edges.has(PAD_BUTTON.A), 'and keeps its raw edge too');
}

/* -- 2c. Digit1-3 stay out of the rebinder ----------------------------- */

console.log('the keyboard lever cannot be rebound away');
{
  const { RESERVED_KEYS, isReserved } = await import('../src/core/Bindings.js');
  for (const code of ['Digit1', 'Digit2', 'Digit3']) {
    ok(isReserved(code) && RESERVED_KEYS.includes(code),
      `${code} is reserved from rebinding, so the offer lever cannot be taken`);
  }
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
