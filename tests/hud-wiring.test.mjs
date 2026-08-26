// Cross-lane integration probe: drives the MERGED src/ui/HUD.js wiring for
// both #234 (density) and #223 (argent pity replay). Neither lane's own test
// touches HUD.js's bound handlers, so this is the only thing that would notice
// the auto-merge dropping or misplacing either line.
import { HUD } from 'file:///C:/Users/tpzap/source/repos/OllieFace/src/ui/HUD.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS ', m); } else { fail++; console.log('  FAIL ', m); } };

const noop = new Proxy(function () {}, { get: (t, k) => (k === 'canvas' ? noop : noop), set: () => true, apply: () => noop });
const makeEl = (tag) => ({
  tagName: tag, className: '', dataset: {}, innerHTML: '', offsetWidth: 0,
  width: 0, height: 0, children: [], parent: null, _badge: null,
  classList: {
    _s: new Set(),
    add(...c) { for (const x of c) this._s.add(x); },
    remove(...c) { for (const x of c) this._s.delete(x); },
    toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
    contains(c) { return this._s.has(c); },
  },
  addEventListener() {},
  get parentElement() { return this.parent; },
  get lastElementChild() { return this.children[this.children.length - 1] || null; },
  get childElementCount() { return this.children.length; },
  appendChild(c) { c.parent = this; this.children.push(c); return c; },
  remove() { const p = this.parent; if (p) p.children.splice(p.children.indexOf(this), 1); this.parent = null; },
  querySelector(sel) { return sel === '.item-stack' ? (this._badge ??= makeEl('b')) : null; },
  getContext: () => noop, toDataURL: () => 'data:,',
});
globalThis.document ??= { createElement: (tag) => makeEl(tag) };
globalThis.requestAnimationFrame ??= () => {};
globalThis.addEventListener ??= () => {};

const { TIER_ORDER } = await import('file:///C:/Users/tpzap/source/repos/OllieFace/src/ui/Icons.js');
const { ITEMS } = await import('file:///C:/Users/tpzap/source/repos/OllieFace/src/data/items.js');
const { DENSITY_COMPACT_AT, DENSITY_ULTRA_AT } = await import('file:///C:/Users/tpzap/source/repos/OllieFace/src/ui/HUD.js');

function bindHud({ authority = true } = {}) {
  const player = { isPlayer: true, alive: true };
  const applied = [];
  const shown = [];
  const listeners = new Map();
  const self = Object.create(HUD.prototype);
  self.inv = new Map();
  self.refs = { inventory: makeEl('div'), tierGroups: Object.fromEntries(TIER_ORDER.map((t) => [t, makeEl('div')])) };
  self.menus = { showPickup: () => {}, showArgentChoice: (c) => shown.push(c) };
  self.toast = () => {};
  const ctx = {
    authority, player,
    items: { applyArgentOfferOutcome: (ids, id) => applied.push({ ids, id }), chooseMutation: () => {} },
    events: { on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); } },
  };
  self.bind(ctx);
  const fire = (n, p) => { for (const f of listeners.get(n) || []) f(p); };
  return { self, fire, applied, shown, player };
}

const realIds = ITEMS.map((i) => i.id);

console.log('#234 x merge: onItemPickup drives the density class on the REAL bound handler');
{
  const { self, fire, player } = bindHud();
  const inv = self.refs.inventory.classList;
  for (let i = 0; i < DENSITY_COMPACT_AT - 1; i++) fire('itemPickup', { id: realIds[i], count: 1, owner: player });
  ok(self.inv.size === DENSITY_COMPACT_AT - 1, `strip holds ${self.inv.size} tiles one short of compact`);
  ok(!inv.contains('is-dense'), 'one short of compact: no density class');
  fire('itemPickup', { id: realIds[DENSITY_COMPACT_AT - 1], count: 1, owner: player });
  ok(inv.contains('is-dense') && !inv.contains('is-dense-2'), 'crossing DENSITY_COMPACT_AT sets is-dense only');
  for (let i = DENSITY_COMPACT_AT; i < DENSITY_ULTRA_AT; i++) fire('itemPickup', { id: realIds[i], count: 1, owner: player });
  ok(inv.contains('is-dense') && inv.contains('is-dense-2'), 'crossing DENSITY_ULTRA_AT adds is-dense-2 cumulatively');
  // removal (count 0) must walk back down
  fire('itemPickup', { id: realIds[DENSITY_ULTRA_AT - 1], count: 0, owner: player });
  ok(inv.contains('is-dense') && !inv.contains('is-dense-2'), 'dropping back below ultra clears is-dense-2');
}

console.log('#223 x merge: the argent branch of mutationChoiceOffered replays only off-authority');
{
  const g = bindHud({ authority: false });
  g.fire('mutationChoiceOffered', { kind: 'argent', owner: g.player, offerId: 7, seconds: 10, offers: [{ baseId: 'a' }, { baseId: 'b' }] });
  ok(g.applied.length === 1, 'guest mirror got exactly one applyArgentOfferOutcome');
  ok(JSON.stringify(g.applied[0]?.ids) === '["a","b"]', 'replayed with the delivered baseIds');
  ok(g.applied[0]?.id === 7, 'and the host-minted offerId');
  ok(g.shown.length === 1 && g.shown[0].id === 'argent:7', 'the choice window still opened');

  const h = bindHud({ authority: true });
  h.fire('mutationChoiceOffered', { kind: 'argent', owner: h.player, offerId: 7, seconds: 10, offers: [{ baseId: 'a' }] });
  ok(h.applied.length === 0, 'host authority skips the replay (no double count)');
  ok(h.shown.length === 1, 'host still gets its window');
}

console.log('#223 x #234: a non-argent kind must not reach the argent replay');
{
  const g = bindHud({ authority: false });
  g.self.menus.showWoundChoice = () => {};
  g.self.menus.showTemperChoice = () => {};
  g.self.menus.showMutationChoice = () => {};
  for (const kind of ['wound', 'temper', undefined]) {
    g.fire('mutationChoiceOffered', { kind, owner: g.player, offerId: 9, seconds: 10, offers: [{ baseId: 'a' }] });
  }
  ok(g.applied.length === 0, 'wound/temper/blight kinds never touch argent pity');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
