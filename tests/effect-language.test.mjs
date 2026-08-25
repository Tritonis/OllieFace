// tests/effect-language.test.mjs
//
// The proc-grammar floor (docs/art/EFFECT-LANGUAGE.md §4.2) says every item
// proc, however small, emits a tick-intensity radial-spark in its element at
// the point it acted, with a positioned tick voice. Forty-six item hooks had
// neither. The claim under test is that they do now — and, more importantly,
// that this test can tell the difference.
//
// The characteristic defect in this repo is a guard that reports green on the
// bug it was written to catch, so nothing here asserts "did not throw". Every
// case drives a real item hook out of `ITEM_BY_ID` through a recording `ctx`
// and insists on the *particular* colour and the *particular* voice recipe. A
// hook that quietly stopped calling `cue` fails on a count; a hook that called
// it with the wrong element fails on the hex; a `cue` that drew but did not
// speak fails on the voice. Deleting the emit from `items.js` turns the file
// red, which is the only evidence that any of the above is doing work.
//
// The second half re-runs the audit's own §2.1 bucketing rules over the
// re-authored surface — the mechanical half of §1.5's demonstration standard —
// and holds the five collision groups this wave resolved to being separated.

import * as THREE from 'three';
import { ITEM_BY_ID } from '../src/data/items.js';
import { EQUIPMENT_BY_ID } from '../src/data/equipment.js';
import { ELEMENTS, ITEM_EFFECTS, EQUIPMENT_EFFECTS, effectOf, cue, voice,
  NAMED_PROMISE, degradedKey, degradedCollision, allEffects, TABLE_EXEMPT } from '../src/data/effects.js';
import { SAMPLES } from '../src/data/samples.js';
import { buckets, familyOf } from '../tools/bucket-effects.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/**
 * A ctx that records instead of rendering.
 *
 * `startSustained` is recorded rather than stubbed away because it is the door
 * every element recipe goes through: the tones, the noise band and the envelope
 * are all arguments to it, so recording the call is recording the voice.
 */
function rig({ samples = false } = {}) {
  const sparks = [], sustains = [], beams = [], missiles = [], rings = [];
  const bursts = [], explosions = [], healPops = [], sampled = [];
  const ctx = {
    time: 10,
    authority: true,
    vfx: {
      hitSpark: (pos, colour, scale) => sparks.push({ pos, colour, scale }),
      beam: (from, to, colour) => beams.push({ from, to, colour }),
      missile: (from, to, colour) => missiles.push({ from, to, colour }),
      ring: (pos, r, colour) => rings.push({ pos, r, colour }),
      burst: (pos, colour) => bursts.push({ pos, colour }),
      explosion: (pos, radius, colour) => explosions.push({ pos, radius, colour }),
      healPop: (pos, amount) => healPops.push({ pos, amount }),
      rings: { spawn: (o, a, colour, r0, r1) => rings.push({ colour, r0, r1 }) },
    },
    audio: {
      played: [],
      play: (name) => ctx.audio.played.push(name),
      // `samples: false` is the degraded mode #148 may leave behind — a sample
      // that is declined, unloaded or missing refuses, and the cue must fall
      // through to the procedural recipe rather than going silent.
      playSample: (id, pos, opts) => {
        if (!samples) return false;
        sampled.push({ id, pos, opts });
        return true;
      },
      startSustained: (pos, recipe) => {
        sustains.push({ pos, recipe });
        return { active: true, move: () => {}, release: () => {} };
      },
    },
    pipeline: { addShake: () => {} },
  };
  return { ctx, sparks, sustains, beams, missiles, rings, bursts, explosions, healPops, sampled };
}

/** The `api` an item hook is handed, with just enough of Items to run one. */
function apiFor(ctx, count = 1) {
  const cooldowns = new Map();
  const player = {
    position: new THREE.Vector3(1, 0, 2),
    health: 90, alive: true, isPlayer: true,
    stats: { maxHealth: 100 },
    schedule: (t, fn) => fn(),
  };
  return {
    ctx, count, procDepth: 1, procCoefficient: 1, player,
    roll: () => true,
    combat: {
      MAX_PROC_DEPTH: 4,
      heal: () => {}, applyDamage: () => {}, applyStatus: () => {},
      explode: () => {}, hasStatus: () => true,
      nearestHostile: () => null, sphereOverlap: () => 0, overlapAt: () => null,
    },
    items: {
      baseDamage: () => 10,
      addBuff: () => {}, addBarrier: () => {}, addGold: () => {},
      addPermanentHealth: () => {}, addCloud: () => {}, addEffect: () => {},
      clearBuff: () => {}, mark: () => {}, killReward: () => 5,
      buffStacks: () => 0, buffMagnitude: () => 0, timeSinceHurt: () => 99,
      tally: () => true, tallyKillWindow: () => true,
      count: () => 0, gold: 0, applyImpulse: () => {},
      cooldownReady: (key, secs) => {
        const prev = cooldowns.get(key);
        if (prev !== undefined && ctx.time - prev < secs) return false;
        cooldowns.set(key, ctx.time);
        return true;
      },
      isMarked: () => false,
    },
  };
}

const victim = () => ({
  position: new THREE.Vector3(6, 0, 6), alive: true, isElite: true, isBoss: false,
  health: 10, maxHealth: 100, id: 7,
});

// ------------------------------------------------------------------------
console.log('a hooked item fires the floor: a spark in its element, and a voice');
{
  // Gristle Sickle: a crit-triggered heal that emitted nothing at all. It is
  // the plainest member of §1d — no beam, no ring, no explosion — so if the
  // floor is doing any work at all it is visible here and nowhere else.
  const { ctx, sparks, sustains } = rig();
  const api = apiFor(ctx);
  const t = victim();
  ITEM_BY_ID.get('gristle-sickle').hooks.onHit({ crit: true, target: t, position: t.position, amount: 40 }, api);

  ok(sparks.length === 1, `gristle-sickle drew exactly one radial-spark (saw ${sparks.length})`);
  ok(sparks[0]?.colour === ELEMENTS.restorative.hue,
    `and drew it in its element: 0x${(sparks[0]?.colour ?? 0).toString(16)} === restorative`);
  ok(sparks[0]?.scale <= 0.6, `at tick scale (${sparks[0]?.scale})`);
  // §4.2: a stat/heal proc speaks at the player, a damage proc at the victim.
  ok(sparks[0]?.pos?.x === api.player.position.x && sparks[0]?.pos?.z === api.player.position.z,
    'positioned at the player, because it is a restorative proc, not a damage one');
  ok(sustains.length === 1, `and spoke exactly once (saw ${sustains.length})`);
  const r = sustains[0]?.recipe;
  ok(r?.tones?.length === 2 && r.tones.every((x) => x.type === 'sine') && !r.noise,
    'in the restorative recipe: a pure sine ladder, no noise bed');
  ok(r?.attack <= 0.01 && r?.release <= 0.12,
    `on a tick envelope (attack ${r?.attack}, decay ${r?.release})`);
}

console.log('\nand it fires nothing when the hook did not act');
{
  // The floor is a cue for a proc that *landed*. A hook that returned early
  // must stay silent, or the language has bought noticeability by making every
  // hit in the game emit forty-six sparks.
  const { ctx, sparks, sustains } = rig();
  const api = apiFor(ctx);
  const t = victim();
  ITEM_BY_ID.get('gristle-sickle').hooks.onHit({ crit: false, target: t, position: t.position, amount: 40 }, api);
  ok(sparks.length === 0 && sustains.length === 0,
    `a non-crit emits nothing (${sparks.length} sparks, ${sustains.length} voices)`);
}

console.log('\na damage proc speaks at the victim, not at the player');
{
  const { ctx, sparks } = rig();
  const api = apiFor(ctx);
  const t = victim();
  ITEM_BY_ID.get('concussion-charge').hooks.onHit({ target: t, position: t.position, amount: 40 }, api);
  ok(sparks.length === 1 && sparks[0].colour === ELEMENTS.shock.hue,
    'concussion-charge is shock, periwinkle-blue');
  ok(sparks[0]?.pos?.x === t.position.x,
    'and lands on the body it stunned, not on the survivor');
}

console.log('\nthe highest-frequency proc is throttled, per §4.2');
{
  // Shrapnel Heart is named in the document as the one entry that will dominate
  // the mix if it is authored above tick intensity. A throttle is only worth
  // having if it actually refuses the second call.
  const { ctx, sparks } = rig();
  const api = apiFor(ctx);
  const t = victim();
  const hook = ITEM_BY_ID.get('shrapnel-heart').hooks.onHit;
  for (let i = 0; i < 8; i++) hook({ target: t, position: t.position, amount: 40, type: 'primary' }, api);
  ok(sparks.length === 1, `eight hits in one instant produced ${sparks.length} cue, not eight`);
  ok(effectOf('shrapnel-heart').step === 'tick', 'and it is authored at tick intensity');
}

console.log('\nevery §1d row is reachable and legal');
{
  const rows = Object.keys(ITEM_EFFECTS);
  ok(rows.length >= 46, `${rows.length} item rows carry an effect-language assignment`);
  const orphan = rows.filter((id) => !ITEM_BY_ID.has(id));
  ok(orphan.length === 0, `every row names a real item${orphan.length ? `: ${orphan.join(', ')}` : ''}`);
  const eqOrphan = Object.keys(EQUIPMENT_EFFECTS).filter((id) => !EQUIPMENT_BY_ID.has(id));
  ok(eqOrphan.length === 0, `every equipment row names a real equipment${eqOrphan.length ? `: ${eqOrphan.join(', ')}` : ''}`);
  // §1.1's reservation, the half the document states without qualification.
  const minted = rows.filter((id) => effectOf(id).element === 'restorative' && effectOf(id).at === 'victim');
  ok(minted.length === 0, `no mint-green damage effect${minted.length ? `: ${minted.join(', ')}` : ''}`);
}

console.log('\nthe four equipment fittingness fixes landed');
{
  const cases = [
    ['gravity-snare', 'gravity', ELEMENTS.gravity.hue],
    ['overload-cell', 'blast', ELEMENTS.blast.hue],
    ['frostbite-canister', 'frost', ELEMENTS.frost.hue],
    ['aegis-emitter', 'restorative', ELEMENTS.restorative.hue],
    ['thermal-lance', 'fire', ELEMENTS.fire.hue],
  ];
  for (const [id, element] of cases) {
    ok(EQUIPMENT_EFFECTS[id]?.element === element, `${id} is the ${element} element`);
  }

  // Overload Cell was the loudest-looking card in the tier and was silent.
  const { ctx, sustains } = rig();
  const api = apiFor(ctx);
  EQUIPMENT_BY_ID.get('overload-cell').use(api);
  ok(sustains.length === 1, `overload-cell now speaks (${sustains.length} voice)`);
  ok(sustains[0]?.recipe?.tones?.some((t) => t.type === 'sine' && t.f0 < 100)
    && !!sustains[0]?.recipe?.noise,
    'in the blast recipe: a noise transient over a sine sub');
  ok(sustains[0]?.recipe?.release >= 0.4, `with a heavy tail (${sustains[0]?.recipe?.release}s)`);

  // Neither C8 member may keep shieldBreak's voice — it is the sound of a
  // shield *ending* and §4.1 says it belongs to nothing here.
  for (const id of ['frostbite-canister', 'aegis-emitter']) {
    const r2 = rig();
    const a = apiFor(r2.ctx);
    // The canister refuses an activation with nothing to freeze, so it needs a
    // body in range or the test would be asserting about a refusal.
    a.combat.sphereOverlap = () => 1;
    a.combat.overlapAt = () => victim();
    EQUIPMENT_BY_ID.get(id).use(a);
    ok(!r2.ctx.audio.played.includes('shieldBreak'), `${id} has stopped borrowing shieldBreak`);
    ok(r2.sustains.length >= 1, `${id} speaks in its own recipe instead`);
  }

  // Gravity Snare's ring must run inward. That is the one place §1.3 sanctions
  // contracting motion, and it is what takes the card out of C3.
  const r3 = rig();
  const api3 = apiFor(r3.ctx);
  api3.combat.sphereOverlap = () => 1;
  api3.combat.overlapAt = () => victim();
  EQUIPMENT_BY_ID.get('gravity-snare').use(api3);
  const inward = r3.rings.filter((x) => x.r0 !== undefined && x.r0 > x.r1);
  ok(inward.length >= 1, `gravity-snare's ring contracts (${inward.length} inward rings)`);
  ok(inward.every((x) => x.colour === ELEMENTS.gravity.hue), 'and is violet');
}

console.log('\nre-elemented items draw in their new element');
{
  const t = victim();
  // Hive Gland was violet and is a swarm: acid-green, and streaks rather than
  // lines, which is what keeps it off Arc Rot's point in every mode (§3.2).
  const r1 = rig();
  const a1 = apiFor(r1.ctx);
  a1.combat.nearestHostile = () => t;
  ITEM_BY_ID.get('hive-gland').hooks.onInterval({ dt: 0.1 }, a1);
  ok(r1.missiles.length >= 1 && r1.missiles.every((m) => m.colour === ELEMENTS.toxic.hue),
    `hive-gland releases acid-green streaks (${r1.missiles.length}), not violet lines`);
  ok(r1.beams.length === 0, 'and draws no beam at all');

  // Prism Splinter is a shatter, so it happens at the crit point.
  const r2 = rig();
  const a2 = apiFor(r2.ctx);
  a2.combat.nearestHostile = () => t;
  ITEM_BY_ID.get('prism-splinter').hooks.onHit({ crit: true, target: t, position: t.position, amount: 40 }, a2);
  ok(r2.sparks.length >= 1 && r2.beams.length === 0,
    `prism-splinter shatters into radial-sparks (${r2.sparks.length}) rather than lines`);
}

// ------------------------------------------------------------------------
console.log('\nthe audit §2.1 bucketing re-run separates every group this wave touched');
{
  const GROUPS = {
    C1: ['copper-wire', 'cracked-zither', 'arc-capacitor', 'spark-plug',
         'arc-rot', 'quicksilver-vein', 'squall-charm'],
    C7: ['leaking-jerrycan', 'warlock-ember', 'emberwake'],
    C8: ['frostbite-canister', 'aegis-emitter'],
    C9: ['prism-splinter', 'hive-gland', 'mourners-dagger'],
    C10: ['bile-shell', 'missile-rack'],
  };
  const { rows } = buckets();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [name, ids] of Object.entries(GROUPS)) {
    const points = new Set(ids.map((id) => byId.get(id)?.key));
    ok(points.size === ids.length,
      `${name}: ${ids.length} members on ${points.size} distinct points`);
  }
  // The rules are the audit's, recomputed from the hex, so a hue that drifted
  // out of its declared §1.1 band is caught here rather than assumed away.
  for (const [name, el] of Object.entries(ELEMENTS)) {
    ok(familyOf(el.hue) === el.family,
      `${name} still buckets as ${el.family}`);
  }
}

console.log('\nthe reservation is checked over the enemy tables too, and can fail there');
{
  const { reservedViolation } = await import('../src/data/colourFamily.js');
  const { ELEMENT_HUE, goreColour, elementOf } = await import('../src/data/damageTypes.js');
  const { enemyCore, enemyRim, elementFromHex } = await import('../src/data/elementVoice.js');

  // RED arm: the exact hue `nature` shipped with, on the exact surface it
  // shipped on. If this stops being reported the guard has gone blind, which
  // is the failure mode that let a mint-green nova through in the first place.
  ok(reservedViolation(0x00ad5d, 'nature') === 'mint-green',
    'the emerald that was nature.tail is still recognised as a reserved-hue violation');
  ok(reservedViolation(0x3fd07a, 'nature') === 'mint-green'
    && reservedViolation(0x86ffb4, 'nature') === 'mint-green',
    'so are the ring and crit-tail that went with it');
  ok(reservedViolation(0xff5fd0, 'fire') === 'magenta' && reservedViolation(0xff5fd0, 'void') === null,
    'magenta is refused for a fire hit and allowed for a void one');
  ok(reservedViolation(0xffffff, 'kinetic') === null,
    'and white is not a hue anyone is spending, whatever band it falls in');

  // GREEN arm: every hue the enemy side can actually put on a damage surface.
  for (const [element, hues] of Object.entries(ELEMENT_HUE)) {
    for (const [where, hex] of Object.entries(hues)) {
      ok(reservedViolation(hex, element) === null, `${element}.${where} is a legal damage hue`);
    }
    for (const [where, hex] of [['enemyCore', enemyCore(element)], ['enemyRim', enemyRim(element)],
      ['goreColour', goreColour(element)]]) {
      ok(reservedViolation(hex, element) === null, `${element} ${where} is a legal damage hue`);
    }
  }

  // One element, one green: the two tables name the same literal.
  ok(ELEMENT_HUE.nature.tail === ELEMENTS.toxic.hue,
    'nature and toxic are the same green in both tables');
  ok(familyOf(enemyCore('nature')) === 'acid-green' && familyOf(enemyRim('nature')) === 'acid-green',
    'and the enemy nova core and rim carry it');
  // m2: the gravity cue and the sparks it throws are one family, not two.
  ok(elementFromHex(ELEMENTS.gravity.hue) === elementOf('gravity'),
    'a gravity proc buckets to the same family its own hue does');
}

console.log('\na voice with no audio, and a cue with no row, are quiet rather than fatal');
{
  ok(voice(null, 'fire', 'crack-body', { x: 0, y: 0, z: 0 }) === null, 'voice() survives a missing Audio');
  const { ctx, sparks } = rig();
  ok(cue(apiFor(ctx), 'no-such-item', { x: 1, y: 0, z: 1 }) === false && sparks.length === 0,
    'cue() refuses an id with no row');
}

// ------------------------------------------------------------------------
// §4.2, second bullet: the thirteen named-promise items.
//
// Each was promised an effect of its own by name and each was getting the
// generic floor. What is under test is not "it emits something" — the floor
// already did that — but that it emits *its own figure*: the particular
// primitives, in its own element, and nothing of the floor's spark on top.
console.log('\nthe thirteen named-promise items each draw a figure of their own');
{
  const t = victim();
  /** Fire one item's real hook and hand back everything the ctx recorded. */
  const fire = (id, how, opts) => {
    const r = rig(opts);
    const api = apiFor(r.ctx);
    api.combat.sphereOverlap = () => 1;
    api.combat.overlapAt = () => t;
    api.combat.nearestHostile = () => t;
    api.ctx.corruption = { sanctified: true, bleed: () => {} };
    how(ITEM_BY_ID.get(id).hooks, api, r);
    return r;
  };
  const onHit = (e = {}) => (h, api) => h.onHit({ target: t, position: t.position, amount: 400, ...e }, api);
  const onKill = (h, api) => h.onKill({ target: t, victim: t, position: t.position }, api);
  const onDamaged = (h, api) => h.onDamaged({ amount: 10 }, api);

  // Each row: id, how to fire it, and the claim its figure makes.
  const CASES = [
    ['chime-of-absolution', onKill, 'void',
      (r) => r.rings.length === 2 && r.rings[0].r !== r.rings[1].r, 'two concentric rings, a bell seen'],
    ['battle-hymn', onDamaged, 'restorative',
      (r) => r.bursts.length === 1 && r.rings.length === 1, 'a burst lifting inside a ring'],
    ['whisper-stalks', onKill, 'void',
      (r) => r.beams.length === 3 && r.beams.every((b) => b.to.y > b.from.y), 'three lines that stand up'],
    ['carrion-flies', (h, api) => h.onInterval({ dt: 0.1 }, api), 'toxic',
      (r) => r.missiles.length === 2, 'streaks hanging on the body'],
    ['charnel-bloom', onKill, 'restorative',
      (r) => r.rings.length === 1 && r.healPops.length === 1, 'a ring opening over a heal'],
    ['concussion-charge', onHit(), 'shock',
      (r) => r.rings.length === 1 && r.sparks.length === 1, 'one hard ring and a flash'],
    ['red-mist-pauldron', onKill, 'blast',
      (r) => r.bursts.length === 1 && r.rings.length === 1, 'mist climbing the survivor'],
    ['corpse-flare', onKill, 'fire',
      (r) => r.beams.length === 1 && r.beams[0].to.y > r.beams[0].from.y + 5, 'a pillar, not a puff'],
    ['molten-core', (h, api) => h.onInterval({ dt: 0.1 }, api), 'fire',
      (r) => r.explosions.length === 1 && r.explosions[0].radius >= 10, 'the mountain, at ten metres'],
    ['resonance-coil', onHit(), 'blast',
      (r) => r.rings.length === 3, 'three rings out of one strike'],
    ['hoarfrost-band', onHit(), 'frost',
      (r) => r.rings.length === 1 && r.beams.length === 4, 'a front of shards, not a smooth ring'],
    ['kinetic-recycler', onDamaged, 'blast',
      (r) => r.rings.length === 1 && r.bursts.length === 1, 'the hit handed back as a shell'],
    ['shrapnel-heart', onHit({ type: 'primary' }), 'blast',
      (r) => r.sparks.length === 1 && r.sparks[0].scale <= 0.5, 'deliberately small, per §4.2'],
  ];
  ok(CASES.length === 13, `${CASES.length} named-promise items covered`);
  ok(NAMED_PROMISE.length === 13 && CASES.every(([id]) => NAMED_PROMISE.includes(id)),
    'and the thirteen the code authors are the thirteen the document names');

  for (const [id, how, element, claim, what] of CASES) {
    const r = fire(id, how);
    const drawn = [...r.rings, ...r.beams, ...r.missiles, ...r.bursts, ...r.explosions, ...r.sparks];
    ok(drawn.length > 0, `${id} draws`);
    ok(claim(r), `${id}: ${what}`);
    ok(drawn.every((d) => d.colour === undefined || d.colour === ELEMENTS[element].hue),
      `${id} draws entirely in ${element}`);
    // The floor's spark on top of an authored figure is the language adding
    // particles rather than meaning. Shrapnel Heart *is* the spark, by design.
    if (id !== 'shrapnel-heart' && id !== 'concussion-charge') {
      ok(r.sparks.length === 0, `${id} does not also fire the generic floor spark`);
    }
    ok(r.sustains.length === 1, `${id} speaks once, in its own envelope`);
    const row = effectOf(id);
    ok(Math.abs(r.sustains[0].recipe.release - ({
      'pip': 0.05, 'tick-thump': 0.09, 'crack-body': 0.20, 'crack-tonal-fall': 0.34,
      'crack-rumble-sub': 0.60, 'sweep-crackle': 0.24, 'ascending-sine': 0.30, 'chord': 0.45,
      'plucked-tonal': 0.45, 'wobble-drone': 0.55, 'sustained-low-chord': 0.80,
      'sustained-rise': 0.40,
    })[row.envelope]) < 1e-6, `${id}'s voice is the ${row.envelope} envelope it declares`);
  }

  // The floor is untouched by all of this: an item nobody promised anything to
  // still gets exactly the spark and the tick voice §4.2's first bullet buys.
  const plain = rig();
  const papi = apiFor(plain.ctx);
  ITEM_BY_ID.get('tar-charge').hooks.onHit({ target: t, position: t.position, amount: 40 }, papi);
  ok(plain.sparks.length === 1 && plain.rings.length === 0 && plain.beams.length === 0,
    'a floor item still emits the floor, and only the floor');
}

console.log('\nthe sampled voices ride the samples, and survive their absence');
{
  const t = victim();
  const drive = (opts) => {
    const r = rig(opts);
    const api = apiFor(r.ctx);
    ITEM_BY_ID.get('battle-hymn').hooks.onDamaged({ amount: 10 }, api);
    return r;
  };
  const withSample = drive({ samples: true });
  ok(withSample.sampled.length === 1 && withSample.sampled[0].id === 'battle-hymn',
    'battle-hymn plays its recording when #148 supplied one');
  ok(withSample.sustains.length === 0, 'and does not double up with the synthesized recipe');

  // The degraded mode. This is the arm that matters: #148 may decline.
  const without = drive({ samples: false });
  ok(without.sampled.length === 0 && without.sustains.length === 1,
    'a refused sample falls through to the procedural recipe rather than to silence');
  ok(without.sustains[0].recipe.tones.every((x) => x.type === 'sine'),
    'in the restorative recipe it degrades to');

  // §4.2's Degraded Point rule, checked with the timbre axis struck out.
  const { rows } = buckets();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const sampledIds = SAMPLES.map((s) => s.id).filter((id) => byId.has(id));
  ok(sampledIds.length >= 6, `${sampledIds.length} sampled voices reach the item surface`);
  const points = new Set(sampledIds.map((id) => degradedKey(effectOf(id))));
  ok(points.size === sampledIds.length,
    `all ${sampledIds.length} separate on colour, frame or motion — never on timbre alone`);

  // RED arm. A guard that has only ever been run over a clean surface is a
  // guard nobody has watched fail, which is this repo's characteristic defect.
  const forged = [effectOf('carrion-flies'), { ...effectOf('hive-gland'), motion: 'held' }];
  const clash = degradedCollision(forged);
  ok(clash?.a === 'carrion-flies' && clash?.b === 'hive-gland',
    'and the check reports a collision when two sampled rows are given one');
  ok(degradedCollision(allEffects()) === null, 'while the real surface has none');
}

console.log('\nevery registered sample reaches the table or a named exemption (#211)');
{
  const { rows } = buckets();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const orphaned = (exempt) => SAMPLES.filter((s) => !byId.has(s.id) && !exempt.includes(s.id))
    .map((s) => s.id);
  ok(orphaned(TABLE_EXEMPT).length === 0,
    `no sampled voice falls out of both sets (orphaned: ${orphaned(TABLE_EXEMPT).join(', ') || 'none'})`);
  ok(TABLE_EXEMPT.includes('scrapfly-hive'),
    'scrapfly-hive is named rather than silently absent');
  // RED arm: strip the exemption this repo currently relies on and watch the
  // first assertion's own predicate catch scrapfly-hive falling out of both
  // sets — the failure this guard exists to report.
  ok(orphaned([]).includes('scrapfly-hive'),
    'and the check would have caught scrapfly-hive vanishing, were TABLE_EXEMPT ever emptied');
}

console.log('\nC5: the mending flare is a heal at event scale, not another ring');
{
  const r = rig();
  const api = apiFor(r.ctx);
  EQUIPMENT_BY_ID.get('mending-flare').use(api);
  ok(r.healPops.length === 1, 'it still pops a heal');
  ok(r.rings.length === 0, 'and has stopped drawing the equipment tier\'s ring over it');
  ok(r.sparks.length === 1 && r.sparks[0].colour === ELEMENTS.restorative.hue
    && r.sparks[0].scale >= 1.5,
    'the healing family\'s radial-spark, at the scale half a health bar deserves');
  ok(!r.ctx.audio.played.includes('heal'),
    'it no longer borrows the heal-tick voice a per-second regen uses');
  ok(r.sustains.length === 1 && Math.abs(r.sustains[0].recipe.release - 0.30) < 1e-6,
    'speaking instead on its own ascending ladder');
  const row = EQUIPMENT_EFFECTS['mending-flare'];
  ok(row.frame === 'radial-spark' && row.motion === 'rising',
    'and it stays in §3 C5\'s healing family: radial-spark, rising');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
