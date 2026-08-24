/**
 * One panel, two decisions, two clocks (#175).
 *
 *   node tests/choice-window-identity.test.mjs
 *
 * `.mutate-choice` is the only choice window there is, and two systems paint
 * into it: the blight toll's mutation offer (6 s, `Items._muteChoice`) and the
 * chest's item offer (8 s, `itemTransaction`). Either can open on top of the
 * other, and their clocks interleave freely — so a *close* has to name which
 * decision is closing. Before it did, a chest offer lapsing underneath a live
 * mutation window tore that window down: cards gone, `onPick` gone, the toll
 * still counting down behind a panel the player could no longer answer.
 *
 * The real `Menus.showChoice`/`hideChoice`/`hideMutationChoice` are driven on a
 * hand-built DOM — the idiom from tests/mutation-pad-choice.test.mjs, because
 * there is no jsdom in this repo.
 *
 * The guard was shown capable of failing: drop the id comparison in
 * `hideMutationChoice` and 'the mutation window survives it' goes red.
 */
function classSet() {
  const s = new Set();
  return {
    toggle: (c, v) => { if (v === undefined ? !s.has(c) : v) s.add(c); else s.delete(c); },
    add: (c) => s.add(c), remove: (...c) => c.forEach((x) => s.delete(x)),
    contains: (c) => s.has(c),
  };
}

function stubCanvas() {
  const ctx2d = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (t[k] = () => ctx2d)),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx2d, toDataURL: () => 'data:image/png;base64,' };
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
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** Reconstructs its children from the markup assigned to it, so the parsing
 *  side of these assertions reads the shipped template. */
function offersEl() {
  const node = {
    html: '', children: [],
    set innerHTML(v) {
      node.html = v;
      node.children = [...v.matchAll(/data-mutate-pick="([^"]*)"/g)]
        .map((m) => ({ dataset: { mutatePick: m[1] } }));
    },
    get innerHTML() { return node.html; },
    querySelectorAll: () => node.children,
  };
  return node;
}

function fakeMenus() {
  const self = Object.create(Menus.prototype);
  self.screen = null;
  self.settings = { controllerGlyphs: 'xbox' };
  self.mutateEl = { classList: classSet() };
  self.mutateRefs = {
    offers: offersEl(),
    clock: { textContent: '' },
    title: { textContent: '' },
    refuse: { hidden: false, querySelector: () => ({ textContent: '' }) },
  };
  return self;
}

const MUTATION = [
  { baseId: 'alpha', baseName: 'Alpha', count: 1, blightId: 'alpha_b', blightName: 'Alpha Blight', blightDescription: 'a' },
  { baseId: 'beta', baseName: 'Beta', count: 1, blightId: 'beta_b', blightName: 'Beta Blight', blightDescription: 'b' },
];

console.log('a chest offer resolving does not tear down the mutation window painted over it');
{
  const m = fakeMenus();
  const picked = [];
  // The chest's window, exactly as HUD opens it.
  m.showChoice({
    id: 'offer:41', title: 'The chest offers a choice', seconds: 8,
    cards: [{ pick: 'safe', name: 'Take Alpha', note: '' }, { pick: 'salvage', name: 'Salvage Alpha', note: '' }],
    onPick: (o) => picked.push(`chest:${o}`),
  });
  ok(m.mutateEl.classList.contains('is-on'), 'the chest window is up');

  // A band crossing paints the mutation window over it — the documented,
  // intended behaviour: one slot, newest wins.
  m.showMutationChoice({
    id: 'mutation:2', offers: MUTATION, seconds: 6,
    onPick: (id) => picked.push(`mutate:${id}`),
    onRefuse: () => picked.push('mutate:refuse'),
  });
  ok(m.mutate?.id === 'mutation:2', 'the mutation window is the one on screen');

  // The chest's own clock runs on regardless of what is drawn, and lapses.
  m.hideChoice('offer:41');
  ok(m.mutateEl.classList.contains('is-on'), 'the mutation window survives it');
  ok(m.mutate?.id === 'mutation:2', 'and it is still the mutation window, not a husk');
  m.mutate.onPick('beta');
  ok(picked.includes('mutate:beta'), 'its cards still answer — the decision was never lost');
}

console.log('and the reverse: a mutation closing does not kill a chest window over it');
{
  const m = fakeMenus();
  const picked = [];
  m.showMutationChoice({
    id: 'mutation:2', offers: MUTATION, seconds: 6, onPick: () => {}, onRefuse: () => {},
  });
  m.showChoice({
    id: 'offer:42', title: 'The chest offers a choice', seconds: 8,
    cards: [{ pick: 'safe', name: 'Take Alpha', note: '' }],
    onPick: (o) => picked.push(o),
  });
  m.hideMutationChoice('mutation:2');
  ok(m.mutateEl.classList.contains('is-on'), 'the chest window is still up');
  ok(m.mutate?.id === 'offer:42', 'and still the chest\'s');
  m.mutate.onPick('safe');
  ok(picked.includes('safe'), 'and still answerable');
}

console.log('a window closes on its own id, and on a caller that names none');
{
  const m = fakeMenus();
  m.showChoice({
    id: 'offer:43', title: 'x', seconds: 8,
    cards: [{ pick: 'safe', name: 'Take Alpha', note: '' }], onPick: () => {},
  });
  m.hideChoice('offer:43');
  ok(!m.mutateEl.classList.contains('is-on') && m.mutate === null,
    'its own resolution closes it');

  m.showChoice({
    id: 'offer:44', title: 'x', seconds: 8,
    cards: [{ pick: 'safe', name: 'Take Alpha', note: '' }], onPick: () => {},
  });
  // The run ending, a death, a fresh screen: callers that mean "whatever is
  // open, close it" pass nothing and must keep working.
  m.hideMutationChoice();
  ok(!m.mutateEl.classList.contains('is-on') && m.mutate === null,
    'an unnamed close still closes whatever is open');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
