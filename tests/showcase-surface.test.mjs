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
import { SAMPLES } from '../src/data/samples.js';

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

  const attacks = [...SPAWN_CARDS, ...BOSS_CARDS].flatMap((c) => c.attacks ?? []);
  const wantTelegraphs = attacks.filter((a) => a.telegraph || a.blast).length;
  ok(wantTelegraphs > 0 && byGroup('telegraph').length === wantTelegraphs,
    `all ${wantTelegraphs} telegraphed enemy attacks are listed`);

  // The silent half. These are the windows the effect language's C6 group is
  // about, and the reason they must be on the menu is the reason they are easy
  // to leave off it: nothing about them is visible in play.
  const wantWindups = attacks.filter((a) => !(a.telegraph || a.blast)).length;
  ok(wantWindups > 0 && byGroup('windup').length === wantWindups,
    `all ${wantWindups} un-telegraphed enemy attack windows are listed`);

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

  ok(byGroup('sample').length === SAMPLES.length,
    `all ${SAMPLES.length} sampled voices are listed`);
}

console.log('\n-- the set-level presets carry their whole set (#149)');
{
  const attacks = [...SPAWN_CARDS, ...BOSS_CARDS]
    .flatMap((c) => (c.attacks ?? []).map((a) => ({ id: `${c.id}:${a.id}`, kind: a.kind })));
  // Re-derived here from the same tables, by hand and independently of the
  // module's own predicates: if the preset filters on a kind list that has
  // fallen behind `enemies.js`, the two disagree and this fails.
  const ofKinds = (...kinds) => attacks.filter((a) => kinds.includes(a.kind)).map((a) => a.id);
  const preset = (key) => api.presets.find((p) => p.key === key);
  const same = (key, want) => {
    const got = preset(key)?.ids ?? [];
    return got.length === want.length && want.every((id) => got.includes(id));
  };

  // C2 (EFFECT-LANGUAGE.md:280) — every nova at one point. The document says
  // 13 nova/slam/stomp users; the tables now carry 14 (the doc's roster
  // predates one), which is exactly the drift a derived preset absorbs and a
  // typed one would not. The three elites are the ones whose corpse is a nova,
  // read off the radius in their stat block rather than named.
  const novas = ofKinds('nova', 'slam', 'stomp');
  const deathNovaElites = Object.entries(ELITE_STATS)
    .filter(([, s]) => s.blastRadius || s.novaRadius).map(([a]) => `elite:${a}`);
  ok(novas.length === 14, `${novas.length} nova/slam/stomp attacks derived from the cards`);
  ok(deathNovaElites.length === 3 && ['galvanic', 'rimebound', 'warded']
    .every((a) => deathNovaElites.includes(`elite:${a}`)),
  'the death-nova elites derive to exactly galvanic, rimebound and warded');
  ok(same('9', [...novas, ...deathNovaElites]),
    `preset 9 fires all ${novas.length + deathNovaElites.length} of them together`);

  // C3 (:294) — the beam users, uncapped, unlike preset 7's `.slice(0, 3)`.
  // The document names nine, two of which (`tesla-crown`, `gravity-snare`) are
  // equipment and one of which (`herald`) is not a card in `enemies.js`; the
  // equipment table carries no property that marks a beam, so the derivable
  // set is the six enemy beams and barrages. The doc itself says the player
  // side is covered by the filter + mark + `g` workflow.
  const beams = ofKinds('beam', 'barrage');
  ok(beams.length === 6, `${beams.length} beam/barrage attacks derived from the cards`);
  ok(same('0', beams), 'preset 10 charges every one of them at once, uncapped');

  // C4 (:308) — the full-horde release: every projectile shooter.
  const shots = ofKinds('projectile');
  ok(shots.length === 11, `${shots.length} projectile releases derived from the cards`);
  ok(same('-', shots), 'preset 11 releases the whole horde together');

  // C6 (:318) — the silent windows. The document counts 16 and the tables
  // derive 16: melee windups, charges, summon casts and the shrike's dive.
  const windows = ofKinds('melee', 'charge', 'summon', 'dive');
  ok(windows.length === 16, `${windows.length} silent windows derived, matching C6's count`);
  ok(same('=', windows), 'preset 12 stands all sixteen windows up together');

  ok(api.presets.every((p) => p.ids.length > 0), 'no preset resolves to an empty set');
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
