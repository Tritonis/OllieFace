/**
 * The showcase (#144) is only worth booting if its list is *complete*: an
 * effect missing from it is exactly the effect nobody judges, and a hand-typed
 * catalogue goes stale the first time someone adds an item without touching
 * this file. So the module derives its list from the data tables, and this test
 * re-derives the expected totals from the same tables independently and insists
 * they match.
 *
 * It deliberately does not try to *fire* anything. Firing an ability means
 * hitscans against a live stage; a stub deep enough to survive that would be a
 * second game, and it would pass while the real one did nothing. Whether an
 * effect reads and sounds distinct is the question a human answers with
 * Shift+F9 — this test only guarantees they are all on the menu.
 */
import { ABILITIES } from '../src/data/abilities.js';
import { EQUIPMENT } from '../src/data/equipment.js';
import { ITEMS, TIERS } from '../src/data/items.js';
import { SPAWN_CARDS, BOSS_CARDS, ELITE_STATS } from '../src/data/enemies.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`PASS  ${msg}`); } else { fail++; console.log(`FAIL  ${msg}`); } };

/* -- the thinnest DOM the overlay can be built against --------------------- */
const el = () => {
  const node = {
    style: { cssText: '' }, textContent: '', innerHTML: '', id: '',
    children: [],
    append: (...k) => node.children.push(...k),
    appendChild: (k) => { node.children.push(k); return k; },
    scrollIntoView() {}, remove() {},
  };
  return node;
};
globalThis.document = { createElement: el, body: el() };
const listeners = [];
globalThis.window = { addEventListener: (t, fn, cap) => listeners.push({ t, fn, cap }), removeEventListener() {} };

const { installShowcase } = await import('../src/core/Showcase.js');

const api = installShowcase({
  camera: { position: { x: 0, y: 2, z: 0 }, getWorldDirection: (v) => v.set(0, 0, -1) },
  stage: { sampleHeight: () => 0 },
});

const byGroup = (g) => api.entries.filter((e) => e.group === g);

console.log('-- every table in the surface reaches the menu');
{
  ok(byGroup('ability').length === Object.keys(ABILITIES).length,
    `all ${Object.keys(ABILITIES).length} survivor abilities are listed`);
  ok(byGroup('equipment').length === EQUIPMENT.length,
    `all ${EQUIPMENT.length} equipment items are listed`);

  for (const hook of ['onHit', 'onKill', 'onDamaged', 'onInterval']) {
    const want = ITEMS.filter((i) => typeof i.hooks?.[hook] === 'function').length;
    ok(want > 0 && byGroup(`item:${hook}`).length === want,
      `all ${want} items carrying ${hook} are listed`);
  }

  const wantTelegraphs = [...SPAWN_CARDS, ...BOSS_CARDS]
    .flatMap((c) => c.attacks ?? []).filter((a) => a.telegraph || a.blast).length;
  ok(wantTelegraphs > 0 && byGroup('telegraph').length === wantTelegraphs,
    `all ${wantTelegraphs} telegraphed enemy attacks are listed`);

  // Elite modifiers carry player-facing surface of their own — a tint, an
  // aura, and a signature proc each — and #143's audit names them, so the
  // showcase owes them a line apiece. `voidtouched` is the one that catches a
  // lazy enumeration: it is deliberately absent from `ELITE_TIERS`, so
  // iterating `ELITE_AFFIXES` would list five of the six and look complete.
  ok(byGroup('elite').length === Object.keys(ELITE_STATS).length,
    `all ${Object.keys(ELITE_STATS).length} elite modifiers are listed`);
  ok(byGroup('elite').some((e) => e.id === 'elite:voidtouched'),
    'including voidtouched, which no elite tier contains');

  ok(byGroup('pickup').length === Object.keys(TIERS).length,
    `all ${Object.keys(TIERS).length} item tiers have a pickup entry`);
  ok(byGroup('moment').length >= 10, 'the run-level moments are listed');
}

console.log('\n-- and the menu is navigable');
{
  ok(new Set(api.entries.map((e) => e.id)).size === api.entries.length,
    'every entry has a unique id, so `__SHOWCASE__.fire(id)` is unambiguous');
  ok(api.entries.every((e) => typeof e.fire === 'function' && e.label),
    'every entry is labelled and firable');
  ok(api.presets.length >= 5, `${api.presets.length} overlap presets are bound to number keys`);
  ok(listeners.some((l) => l.t === 'keydown' && l.cap === true),
    'the key handler is installed in the capture phase, so a filter keystroke never reaches Input');
  ok(api.fire('no-such-effect') === false, 'an unknown id is refused rather than thrown');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
