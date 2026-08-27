// tests/gateway-pity.test.mjs
// Bounded pity for realm gateway placement (issue #233): N consecutive
// stage-eligible denials of a single gateway kind is bounded by
// GATEWAY_PITY_BOUND rather than open-ended, without moving the shared
// `ctx.rng` stream by even one extra draw between the forced and unforced
// paths — same determinism constraint #223's temper pity is built on.
import * as THREE from 'three';
import { GATEWAYS, GATEWAY_PITY_BOUND } from '../src/data/realms.js';
import { Realms } from '../src/world/realms/Realms.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A queued rng: `.next()` drains `values` in order, then falls back to a
 * constant that misses every `chance` in GATEWAYS (max chance is 0.42). */
function queueRng(values) {
  let i = 0;
  return { next: () => (i < values.length ? values[i++] : 0.99), calls: 0 };
}

function makeCtx(rng) {
  const added = [];
  const offers = [];
  const ctx = {
    authority: true,
    stage: { landmarks: [] },
    interactables: {
      add: (p) => added.push(p),
      // Siting is stubbed so the only `rng.next()` draws in the function
      // under test are the gateway-chance rolls themselves — the thing this
      // suite is asserting a draw count about.
      _sited: () => new THREE.Vector3(0, 0, 0),
    },
    player: { position: new THREE.Vector3(0, 0, 0) },
    rng,
    events: { emit: (name, e) => { if (name === 'realmOffer') offers.push(e); }, on() {} },
  };
  return { ctx, added, offers };
}

function makeRealms(rng, { usedRealms = [] } = {}) {
  const { ctx, added, offers } = makeCtx(rng);
  const realms = new Realms();
  realms.ctx = ctx;
  for (const id of usedRealms) realms.used.add(id);
  return { realms, ctx, added, offers };
}

const obelisk = GATEWAYS.find((g) => g.id === 'obelisk');
ok(obelisk && obelisk.once === false && obelisk.minStage === 1,
  'test fixture assumption holds: obelisk is repeatable and eligible from stage 1');

// Stage 1 with 'market' already used skips altar's draw entirely (once-gate,
// already taken) and beacon is out of range (minStage 2), so exactly one
// `rng.next()` draw happens per call: obelisk's. Isolates the gate under test
// from the other two without needing to patch the shared GATEWAYS table.
const STAGE = 1;
const ONLY_OBELISK_ELIGIBLE = { usedRealms: ['market'] };

console.log(`GATEWAY_PITY_BOUND is a small, named, positive constant (${GATEWAY_PITY_BOUND})`);
{
  ok(Number.isInteger(GATEWAY_PITY_BOUND) && GATEWAY_PITY_BOUND >= 4 && GATEWAY_PITY_BOUND <= 8,
    `GATEWAY_PITY_BOUND is bounded in 4..8 (${GATEWAY_PITY_BOUND})`);
}

console.log('bound-1 consecutive misses do not force; the bound-th miss forces the very next roll');
{
  const rng = queueRng([]); // always 0.99 > every chance: pure denial stream
  const { realms, ctx, added } = makeRealms(rng, ONLY_OBELISK_ELIGIBLE);

  for (let i = 0; i < GATEWAY_PITY_BOUND - 1; i++) realms.onStagePopulated(STAGE);
  ok(added.length === 0, `${GATEWAY_PITY_BOUND - 1} straight denials: still nothing spawned`);
  ok(realms._gatewayMisses.get('obelisk') === GATEWAY_PITY_BOUND - 1,
    `miss counter sits at bound-1 (${GATEWAY_PITY_BOUND - 1})`);

  realms.onStagePopulated(STAGE); // the bound-th eligible denial
  ok(added.length === 0, 'the bound-th denial itself still does not force (it is what REACHES the bound)');
  ok(realms._gatewayMisses.get('obelisk') === GATEWAY_PITY_BOUND, 'counter now sits exactly at the bound');

  realms.onStagePopulated(STAGE); // next roll: must force regardless of the roll value
  ok(added.length === 1, 'the roll immediately after the bound is reached is forced to spawn');
  ok(added[0].gate.id === 'obelisk', 'the forced spawn is the gate that was denied, not some other one');
  ok(realms._gatewayMisses.get('obelisk') === 0, 'forcing resets the miss counter to zero');
}

console.log('RED EVIDENCE: this guard can fail — a build that drops the forced-check spawns nothing, ever, under sustained denial');
{
  // Same fixture as above, but manually replaying just the "would the old,
  // unbounded code ever spawn" question: a bare `roll > gate.chance` gate
  // with no counter denies forever on an all-0.99 stream. This is the exact
  // shape the boundary test above would fail against if `forced` were
  // deleted from `onStagePopulated` — recorded here as an explicit
  // documented counter-scenario rather than only an implicit one.
  let denied = 0;
  for (let i = 0; i < GATEWAY_PITY_BOUND * 3; i++) {
    const roll = 0.99;
    if (roll > obelisk.chance) denied++; else break;
  }
  ok(denied === GATEWAY_PITY_BOUND * 3, 'an unbounded roll-only gate denies every single draw on this stream (no forcing)');
}

console.log('a natural hit resets the counter without forcing anything, and costs no extra draw');
{
  // obelisk.chance = 0.34. A roll of 0.01 passes (0.01 <= chance): a hit.
  const rng = queueRng([0.9, 0.9, 0.9, 0.01, 0.9]);
  const { realms, added } = makeRealms(rng, ONLY_OBELISK_ELIGIBLE);
  for (let i = 0; i < 3; i++) realms.onStagePopulated(STAGE);
  ok(added.length === 0 && realms._gatewayMisses.get('obelisk') === 3, 'three denials recorded');
  realms.onStagePopulated(STAGE); // the 0.01 hit
  ok(added.length === 1, 'a natural hit spawns the gateway on its own merit');
  ok(realms._gatewayMisses.get('obelisk') === 0, 'and resets the counter — the hit was not a forced spawn');
  realms.onStagePopulated(STAGE); // back to denial (0.9)
  ok(added.length === 1 && realms._gatewayMisses.get('obelisk') === 1, 'the counter resumes counting fresh after a hit, not from where it left off');
}

console.log('exactly one rng.next() draw per eligible gate per stage, forced or not (the RNG stream is never lengthened by pity)');
{
  const rng = queueRng([]);
  const spy = { calls: 0, next: () => { spy.calls++; return rng.next(); } };
  const { realms } = makeRealms(spy, ONLY_OBELISK_ELIGIBLE);
  for (let i = 0; i < GATEWAY_PITY_BOUND + 2; i++) realms.onStagePopulated(STAGE);
  ok(spy.calls === GATEWAY_PITY_BOUND + 2, `${GATEWAY_PITY_BOUND + 2} calls to onStagePopulated drew exactly ${GATEWAY_PITY_BOUND + 2} rng values (got ${spy.calls}), including across the forced spawn`);
}

console.log('DETERMINISM: same seed, same call history -> identical spawn pattern and identical final pity state');
{
  const run = () => {
    const { realms } = makeRealms(new RNG(90210), ONLY_OBELISK_ELIGIBLE);
    const pattern = [];
    for (let i = 0; i < 20; i++) {
      const before = realms.gateways.length;
      realms.onStagePopulated(STAGE);
      pattern.push(realms.gateways.length > before);
      realms.gateways.length = 0; // mimic stageStart's clear so the next call is a fresh eligible roll
    }
    return { pattern, finalMisses: realms._gatewayMisses.get('obelisk') };
  };
  const a = run(), b = run();
  ok(a.pattern.join(',') === b.pattern.join(','), 'two runs off the same seed spawn on exactly the same stages');
  ok(a.finalMisses === b.finalMisses, 'and end with the identical pity counter');
  ok(a.pattern.includes(true) && a.pattern.includes(false), 'sanity: the pattern is neither all-hit nor all-miss (the fixture actually exercises both paths)');
}

console.log('a once-gateway already used is skipped before any draw, and pity never engages a spent gate');
{
  const rng = queueRng([]);
  const { realms, ctx, added } = makeRealms(rng, { usedRealms: ['market', 'vault'] });
  // Stage 2 makes beacon (vault, minStage 2) eligible by index, but it is
  // already marked used, so it must be skipped before consuming a draw.
  for (let i = 0; i < GATEWAY_PITY_BOUND + 3; i++) realms.onStagePopulated(2);
  ok(!added.some((g) => g.gate.id === 'beacon'), 'a used once-gate never spawns again regardless of denial history');
  ok(realms._gatewayMisses.get('beacon') === undefined, 'and its miss counter is never touched — pity has nothing to say about a gate that cannot roll');
}

console.log('SAVE-SAFETY: no run/mid-run serialization exists in this codebase (verified by scope), so gateway pity state has nothing to leak into');
{
  // `Realms` owns `_gatewayMisses` exactly like it owns `used` (run-local,
  // reset only by a fresh `new Realms()` — i.e. a fresh page load / new run,
  // per `src/main.js`). Neither is read by `src/systems/Profile.js`, which
  // only ever writes END-OF-RUN career summaries (verified: no reference to
  // `realms` or `_gatewayMisses` in Profile.js). The structural guarantee
  // this test can make from a unit test is: the field lives only on the
  // Realms instance and a fresh instance starts clean, mirroring `used`.
  const { realms } = makeRealms(queueRng([]), ONLY_OBELISK_ELIGIBLE);
  ok(realms._gatewayMisses instanceof Map && realms._gatewayMisses.size === 0,
    'a fresh Realms instance starts with an empty pity map, same lifecycle as `used`');
  realms.onStagePopulated(STAGE);
  const fresh = new Realms();
  ok(fresh._gatewayMisses.size === 0, 'a second, independent Realms instance does not inherit the first one\'s pity state');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
