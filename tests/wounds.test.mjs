// tests/wounds.test.mjs
// Blight Wounds (#178) — Seal, Feed, and the bounds on both.
//
// Four things are held open here, and each was written red first:
//
//   (a) a seal really commits AND really wards. Blinding the payout — a listener
//       that commits `woundSealed` and forgets the bleed — must fail, so the
//       assertion is on the world moving, not merely on the ledger.
//   (b) a feed really expands the patch and really commits corrupt, and the
//       expansion is CLAMPED. An over-cap `expand` planted in the payload must
//       fail if `Blight` trusts its caller.
//   (c) promotion is deterministic and off the shared stream. A `promoteWound`
//       rewritten to draw from `ctx.rng` must fail, so the draw counter is an
//       assertion and not a comment.
//   (d) the growth caps can fail: raise the qualifying-seed count well past
//       `WOUND.max` and the stage must still hold at most `WOUND.max` wounds.
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { Blight, radiusOf } from '../src/systems/Blight.js';
import { Director } from '../src/systems/Director.js';
import { Items } from '../src/systems/Items.js';
import { Interactables, Wound } from '../src/world/Interactables.js';
import { WOUND, WOUND_PICK, promoteWound } from '../src/data/wounds.js';
import { weightOf } from '../src/data/alignment.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = () => ({ isPlayer: true, alive: true, position: new THREE.Vector3() });

/**
 * A ctx with the three systems that actually talk to each other on this path,
 * plus a `ctx.rng` that counts every draw taken through it — which is how (c)
 * is an assertion rather than a promise.
 */
function makeCtx({ seed = 12345, stage = 1, scene = true } = {}) {
  const listeners = new Map();
  const draws = { n: 0 };
  const ctx = {
    authority: true,
    seed,
    time: 0,
    paused: false,
    player: P(),
    progression: { stageIndex: stage, stats: { time: 0 } },
    stage: { sampleHeight: () => 0 },
    rng: { next() { draws.n++; return 0.5; }, range(a, b) { draws.n++; return (a + b) / 2; }, int(a) { draws.n++; return a; } },
    fxRng: { range: (a, b) => (a + b) / 2 },
    events: {
      emit(name, p) { for (const fn of (listeners.get(name) || []).slice()) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  if (scene) ctx.scene = new THREE.Group();
  const cor = new Corruption();
  cor.init(ctx);
  const blight = new Blight();
  blight.init(ctx);
  const inter = new Interactables();
  inter.init(ctx);
  // What `populate(stage)` sets. Called directly because the rest of `populate`
  // wants a full stage kit (landmarks, items, artifacts) that has nothing to do
  // with wounds; the promotion path itself is exercised for real, through the
  // `blightSeed` event, below.
  inter._woundStage = stage;
  inter._woundOrdinal = 0;
  return { ctx, cor, blight, inter, draws };
}

/** Plant a greed mark the way `Corruption.seed` does — the real event. */
const plant = (cor, x, z, strength = WOUND.minStrength) =>
  cor.seed({ x, y: 0, z }, strength);

const wounds = (inter) => inter.list.filter((i) => i instanceof Wound);

console.log('\n-- promotion is bounded, and the bound can fail --');
{
  // The literals matter and are NOT read off `WOUND`. An earlier draft asserted
  // `grown.length <= WOUND.max` alone, and raising `max` to 99 left it green —
  // the guard was reading the very constant it was supposed to be holding. The
  // tuned numbers ARE the contract this prototype was adjudicated on, so they
  // are written out here and a retune has to come and argue with this line.
  ok(WOUND.max === 3, `at most three wounds per stage (WOUND.max=${WOUND.max})`);
  ok(WOUND.expandCap === 3, `a fed patch grows by at most 3 strength (${WOUND.expandCap})`);
  ok(WOUND.minSpacing >= 12, `wounds stand apart (${WOUND.minSpacing}m)`);

  const { cor, inter } = makeCtx();
  // Twenty qualifying seeds, every one of them past `minSpacing` from all the
  // others, so nothing but `WOUND.max` can be what stops this.
  for (let i = 0; i < 20; i++) plant(cor, i * 120, 0, 4);
  const grown = wounds(inter);
  ok(grown.length > 0, `twenty greed marks grow at least one wound (${grown.length})`);
  ok(grown.length <= 3, `and never more than three (${grown.length})`);

  // Spacing: no two wounds may stand on top of each other.
  let tooClose = 0;
  for (let i = 0; i < grown.length; i++) {
    for (let j = i + 1; j < grown.length; j++) {
      if (grown[i].position.distanceTo(grown[j].position) < WOUND.minSpacing) tooClose++;
    }
  }
  ok(tooClose === 0, `no two wounds are inside minSpacing (${tooClose} pairs)`);

  // A scuff is not a decision.
  const { cor: c2, inter: i2 } = makeCtx({ seed: 77 });
  for (let i = 0; i < 20; i++) plant(c2, i * 120, 0, WOUND.minStrength - 1);
  ok(wounds(i2).length === 0, 'a strength below minStrength never becomes a wound');
}

console.log('\n-- promotion is deterministic and never touches the shared stream --');
{
  const run = (seed) => {
    const { cor, inter, draws } = makeCtx({ seed });
    for (let i = 0; i < 20; i++) plant(cor, i * 120, 0, 4);
    return { at: wounds(inter).map((w) => w.position.x), draws: draws.n };
  };
  const a = run(9001), b = run(9001);
  ok(a.at.length > 0 && JSON.stringify(a.at) === JSON.stringify(b.at),
    `one seed promotes the same seeds twice (${JSON.stringify(a.at)})`);
  ok(a.draws === 0 && b.draws === 0,
    `and takes zero draws off ctx.rng doing it (${a.draws})`);

  // Different seeds must actually disagree somewhere, or the predicate is a
  // constant and the determinism assertion above is vacuous.
  let differ = 0;
  for (let s = 1; s <= 24; s++) if (JSON.stringify(run(s).at) !== JSON.stringify(a.at)) differ++;
  ok(differ > 0, `other seeds promote other ground (${differ}/24 differ)`);

  // The predicate itself is pure and salted-then-avalanched: neighbouring
  // ordinals must not agree wholesale, which is the failure the raw xor salt
  // has and `data/vows.js` documents.
  const row = [];
  for (let o = 0; o < 32; o++) row.push(promoteWound(4, 0, o) ? 1 : 0);
  const on = row.reduce((s, v) => s + v, 0);
  ok(on > 2 && on < 30, `the predicate is neither always nor never (${on}/32)`);
  let impure = 0;
  for (let o = 0; o < 32; o++) if ((promoteWound(4, 0, o) ? 1 : 0) !== row[o]) impure++;
  ok(impure === 0, `promoteWound is pure across repeats (${impure} disagreements)`);
}

console.log('\n-- a seal commits, wards, closes the patch and quiets the ground --');
{
  const { ctx, cor, blight, inter } = makeCtx();
  const p = ctx.player;
  cor.feed(p, 60);                       // something for the seal to take back
  const worldBefore = cor.world;
  plant(cor, 0, 0, 4);
  // Force the wound rather than hope the predicate promotes seed 0: the
  // promotion path has its own arm above, and this arm is about the press.
  const w = inter._promoteWound({ x: 0, z: 0, strength: 4 })
    || wounds(inter)[0]
    || inter.add(new Wound(ctx, new THREE.Vector3(0, 0, 0), 4));
  ok(!!w && w.available(), 'the wound is standing and answerable');
  ok(blight.patches.length >= 1, `and a patch is under it (${blight.patches.length})`);

  // The prompt quotes BOTH outcomes before the press, with their numbers.
  const quote = w.prompt();
  ok(/Seal/.test(quote) && /Feed/.test(quote), `the prompt names both outcomes (${quote})`);
  ok(quote.includes(String(WOUND.sealWard)) && quote.includes(String(WOUND.feedCorruption)),
    'and quotes both payouts');

  ok(w.selectOutcome('seal') === true, 'the press can be aimed at Seal');
  w.interact(p);
  ok(w.state === 'sealing', 'the press opens the window rather than resolving it');
  // Half the window, then walk away: the hold resets rather than banks.
  w.update(WOUND.sealWindow * 0.5);
  p.position.set(WOUND.sealHold + 5, 0, 0);
  w.update(0.1);
  ok(w.state === 'open' && w.hold === 0, 'straying resets the window');
  ok(cor.ledger.pure === 0, 'and an abandoned window commits nothing');

  p.position.set(0, 0, 0);
  w.interact(p);
  w.update(WOUND.sealWindow + 0.01);
  ok(w.state === 'sealed' && !w.available(), 'holding the ground seals the wound');

  const wantPure = weightOf('woundSealed', 1) + weightOf('warded', WOUND.sealWard);
  ok(Math.abs(cor.ledger.pure - wantPure) < 1e-9,
    `a seal pays the act AND the warding it earned (${cor.ledger.pure} vs ${wantPure})`);
  ok(cor.ledger.corrupt === 0, 'and nothing to the other side');
  // The payout is real, not merely billed. A listener that commits and forgets
  // to bleed leaves the world exactly where it was, and this is the line that
  // catches it.
  ok(cor.world === worldBefore - WOUND.sealWard,
    `the world actually gave ${WOUND.sealWard} back (${worldBefore} -> ${cor.world})`);

  ok(blight.patches.length === 0, `the patch is gone from the ground (${blight.patches.length})`);
}

console.log('\n-- a sealed wound quiets the void locally, not globally --');
{
  // The REAL Director, not a mirror of its rule: `spendVoidCredits` picks the
  // seed it surfaces at out of this list, so the list is the suppression.
  const { ctx, cor } = makeCtx();
  const dir = new Director();
  dir.init(ctx);
  plant(cor, 0, 0, 4);
  plant(cor, 400, 0, 4);
  const seeds = dir._voidSeeds;
  ok(seeds.length === 2, `two seeds are on the stage (${seeds.length})`);
  ctx.events.emit('woundResolved', { outcome: 'seal', x: 0, z: 0, radius: WOUND.radius });
  ok(seeds.length === 1 && seeds[0].x === 400,
    'sealing drops the seed under the wound and leaves the far one alone');
  // A feed is not a cleanse: the ground stays hot.
  ctx.events.emit('woundResolved', { outcome: 'feed', x: 400, z: 0, radius: WOUND.radius });
  ok(dir._voidSeeds.length === 1, 'feeding removes nothing from the void spawn list');
}

console.log('\n-- a feed commits corrupt, pays in marks, and expands under a cap --');
{
  const { ctx, cor, blight, inter } = makeCtx();
  const p = ctx.player;
  plant(cor, 0, 0, 4);
  const w = inter._promoteWound({ x: 0, z: 0, strength: 4 })
    || wounds(inter)[0]
    || inter.add(new Wound(ctx, new THREE.Vector3(0, 0, 0), 4));
  const patch = blight.patches[0];
  const before = patch.strength;
  const marksBefore = cor.marks;

  ok(w.selectOutcome('feed') === true, 'the press can be aimed at Feed');
  w.interact(p);
  ok(w.state === 'fed' && !w.available(), 'a feed resolves on the press, with no window');
  ok(cor.ledger.corrupt === weightOf('woundFed', 1),
    `a feed commits ${weightOf('woundFed', 1)} corrupt (${cor.ledger.corrupt})`);
  ok(cor.ledger.pure === 0, 'and nothing to the other side');
  ok(cor.world === WOUND.feedCorruption,
    `the void took its ${WOUND.feedCorruption} (${cor.world})`);
  ok(cor.marks > marksBefore || cor.peak === WOUND.feedCorruption,
    'and the descent it bought is minted against peak');

  const grew = patch.strength - before;
  ok(grew === WOUND.feedExpand, `the patch expanded by feedExpand (${grew})`);
  ok(radiusOf(patch.strength, cor.world) > radiusOf(before, 0),
    'which is a visibly larger radius, not a bookkeeping change');
}

console.log('\n-- the expansion cap is enforced at the thing that grows --');
{
  const { ctx, cor, blight } = makeCtx();
  plant(cor, 0, 0, 4);
  const patch = blight.patches[0];
  const before = patch.strength;
  // Planted over-cap in the payload, which is exactly what a later ticket — or
  // a wire message — would do by accident. `Blight` must clamp, not trust.
  ctx.events.emit('woundResolved', { outcome: 'feed', x: 0, z: 0, radius: WOUND.radius, expand: 99 });
  const grew = patch.strength - before;
  ok(grew === WOUND.expandCap, `an over-cap ask is clamped to expandCap=${WOUND.expandCap} (${grew})`);
  ok(radiusOf(patch.strength, 1000) <= 14, 'and the drawn radius is still under RADIUS.cap');
  // Negative and non-finite asks are refused rather than shrinking the patch.
  ctx.events.emit('woundResolved', { outcome: 'feed', x: 0, z: 0, radius: WOUND.radius, expand: -50 });
  ctx.events.emit('woundResolved', { outcome: 'feed', x: 0, z: 0, radius: WOUND.radius, expand: NaN });
  ok(patch.strength === before + WOUND.expandCap + WOUND.feedExpand,
    `a negative ask does nothing and a NaN ask falls back to feedExpand (${patch.strength})`);
}

console.log('\n-- a guest neither promotes wounds nor accrues from them --');
{
  const { ctx, cor, inter } = makeCtx();
  ctx.authority = false;
  ok(inter._promoteWound({ x: 0, z: 0, strength: 4 }) === null, 'a guest promotes nothing');
  ctx.events.emit('woundResolved', { outcome: 'seal', x: 0, z: 0, radius: WOUND.radius, ward: 8, owner: ctx.player });
  ctx.events.emit('woundResolved', { outcome: 'feed', x: 0, z: 0, radius: WOUND.radius, corruption: 18, owner: ctx.player });
  ok(cor.ledger.pure === 0 && cor.ledger.corrupt === 0, "and a guest's ledger stays empty");
}

// ---------------------------------------------------------------------------
// The integration review's M1 and M2 (reviews/round9-integration-2026-08-24).
// ---------------------------------------------------------------------------

console.log('\n-- the feed quote is the feed charge, greed time included (M1) --');
{
  // The review's probe A, as a test. Greed time is the condition that produces
  // MOST wounds — `Corruption.seed` adds +1 strength while greed is on and
  // `WOUND.minStrength` is 2 — so a face-value quote is wrong exactly where
  // wounds actually appear. Remove the `pricedPrompt` routing from
  // `Wound.prompt` and both lines below go red.
  const { ctx, cor, inter } = makeCtx();
  const p = ctx.player;
  cor.feed(p, 25);                       // world 25, band 1 — the review's scenario
  // Greed time the way the run turns it on: the teleporter has finished and
  // looting past it cuts deeper. This is also why wounds mostly exist —
  // `Corruption.seed` adds +1 strength while it is on, and `WOUND.minStrength`
  // is 2, so the common seeders only ever qualify inside this window.
  ctx.events.emit('teleporterComplete', {});
  ok(cor.greed === true, 'greed time is on');
  ok(cor.priceOf(WOUND.feedCorruption) === WOUND.feedCorruption * 2,
    `a greed-time feed really costs double (${cor.priceOf(WOUND.feedCorruption)})`);

  plant(cor, 0, 0, 4);
  const w = inter._promoteWound({ x: 0, z: 0, strength: 4 })
    || wounds(inter)[0]
    || inter.add(new Wound(ctx, new THREE.Vector3(0, 0, 0), 4));
  const quote = w.prompt();
  const charge = cor.priceOf(WOUND.feedCorruption);
  ok(quote.includes(`+${charge} corruption`),
    `the prompt quotes the multiplied charge, not face value (${quote})`);
  ok(/greed time/.test(quote), 'and says why it is doubled');
  // The band edge: 25 + 36 clears Blighted at 55, and a crossing queues an item
  // toll. An unquoted crossing is the expensive half of M1.
  ok(/Blighted/.test(quote), 'and names the band the press is about to cross');

  // And the quote is the charge, measured rather than asserted about.
  const before = cor.world;
  w.selectOutcome('feed');
  w.interact(p);
  ok(cor.world - before === charge,
    `the press charged exactly what the prompt quoted (${cor.world - before} vs ${charge})`);
}

console.log('\n-- the seal line quotes what bleed will actually give back (m4) --');
{
  const { ctx, cor, inter } = makeCtx();
  cor.feed(ctx.player, 3);               // less world than the ward is worth
  const w = inter.add(new Wound(ctx, new THREE.Vector3(0, 0, 0), 4));
  ok(w.prompt().includes('-3 corruption'),
    `a shallow world is quoted at what it can give (${w.prompt().split(' - or - ')[0]})`);
  const { ctx: c2, cor: cor2, inter: i2 } = makeCtx();
  cor2.feed(c2.player, 500);
  const w2 = i2.add(new Wound(c2, new THREE.Vector3(0, 0, 0), 4));
  ok(w2.prompt().includes(`-${WOUND.sealWard} corruption`),
    'and a deep one is quoted at the full ward');
}

console.log('\n-- the press raises a real choice window, and the pick decides (M2) --');
{
  // Real `Items`, real `_openChoice`, real `chooseMutation` — the same window
  // the blight toll and the argent altar use. Blind the routing (drop the
  // `resolve` handoff, or ignore the picked id in `Wound.interact`) and the
  // feed arm goes red while the lapse arm stays green.
  const feedRun = () => {
    const { ctx, cor, blight, inter } = makeCtx();
    const items = new Items();
    items.init(ctx);
    const offers = [];
    ctx.events.on('mutationChoiceOffered', (e) => offers.push(e));
    plant(cor, 0, 0, 4);
    const w = inter.add(new Wound(ctx, new THREE.Vector3(0, 0, 0), 4));
    return { ctx, cor, blight, items, offers, w };
  };

  const a = feedRun();
  ok(a.w.interact(a.ctx.player) === true, 'the press is accepted');
  ok(a.offers.length === 1 && a.offers[0].kind === 'wound',
    `and raises a window of kind 'wound' (${a.offers.map((o) => o.kind).join(',')})`);
  ok(a.offers[0].offers?.length === 2, 'with two cards on it');
  ok(a.offers[0].offers.map((c) => c.baseId).sort().join(',') === `${WOUND_PICK.feed},${WOUND_PICK.seal}`,
    'named seal and feed');
  ok(a.w.state === 'open', 'and resolves nothing until the window is answered');
  ok(a.cor.ledger.corrupt === 0 && a.cor.ledger.pure === 0, 'the ledger is untouched while it stands');

  const patch = a.blight.patches[0];
  const before = patch.strength;
  ok(a.items.chooseMutation(WOUND_PICK.feed) === true, 'the feed card can be picked');
  ok(a.w.state === 'fed', 'and the pick really feeds the wound');
  ok(a.cor.ledger.corrupt === weightOf('woundFed', 1),
    `which commits corrupt (${a.cor.ledger.corrupt})`);
  ok(patch.strength - before === WOUND.feedExpand, 'and spreads the patch');

  // Picking the seal card starts the hold rather than sealing outright — the
  // window buys the attempt, not the outcome.
  const b = feedRun();
  b.w.interact(b.ctx.player);
  ok(b.items.chooseMutation(WOUND_PICK.seal) === true, 'the seal card can be picked');
  ok(b.w.state === 'sealing', 'and the pick opens the hold');
  ok(b.cor.ledger.pure === 0, 'sealing is not free — the pick alone commits nothing');

  // Lapse is the seal, which is the safe half.
  const c = feedRun();
  c.w.interact(c.ctx.player);
  c.items.refuseMutation('timeout');
  ok(c.w.state === 'sealing', 'a lapsed window lands on the seal, not the feed');
  ok(c.cor.ledger.corrupt === 0, 'and never on the corrupt side');

  // A window already standing on this pack is not this press's to paint over.
  const d = feedRun();
  d.items.openArgentChoice({
    cards: [{ baseId: 'x', argentId: 'x', argentName: 'x' }, { baseId: 'y', argentId: 'y', argentName: 'y' }],
    seconds: 5, resolve: () => {},
  });
  const n = d.offers.length;
  ok(d.w.interact(d.ctx.player) === false, 'a wound press is refused while another window stands');
  ok(d.offers.length === n, 'and paints nothing over it');
  ok(d.w.state === 'open', 'the wound is left exactly as it was');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
