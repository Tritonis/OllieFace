/**
 * Stage Vows — purity's proactive verb (issue #177).
 *
 * The 2026-08-23 corruption/purity audit named the hole precisely: every act
 * the clean route owned was a *refusal*. Decline the chest, walk past the
 * altar, do not press. `Corruption`'s `itemOfferResolved` listener carries the
 * scar — banking pure commitment for a decline turned restraint into a free
 * tap, so the gate there now demands that a salvage actually warded something,
 * with the note that restraint "is #177's verb (Vows), not a free rider on
 * this one". This file is that verb.
 *
 * A Vow is a *declaration made in advance* about how the coming stage will be
 * played, with a condition the player can fail. That is the whole design: a run
 * that ends at zero corruption because nothing interesting happened has done
 * nothing, and earns nothing. A run that promised to seal three Hollowed and
 * then went and did it has committed to something, and the ledger says so.
 *
 * ## Shape
 *
 * A vow is data plus one pure reducer. `step` is handed an event name, its
 * payload, the live scope state, the vow, and `ctx`; it may advance
 * `state.count` and returns a verdict — `'kept'`, `'broken'`, or `null` for
 * "still running". Nothing here touches the world, emits, or commits; that is
 * `systems/Vows.js`, which is the single writer the same way `Corruption.commit`
 * is the ledger's.
 *
 * `events` is the exact subscription list, so the system never has to guess and
 * a vow cannot silently depend on an event nobody routes to it.
 *
 * `keptOnClose` decides what an unresolved vow means when the stage ends. A
 * restraint vow is kept by having survived the stage without being broken; a
 * combat or timing vow that never reached its condition simply did not happen.
 *
 * ## Failure is legible and free
 *
 * A broken vow closes with a toast and NOTHING else. No item is removed, no
 * corruption is fed, and — deliberately against the `vowBroken` entry declared
 * in `data/alignment.js` — no corrupt commitment is billed. Billing it would
 * make offering a vow to a pure-intent run a trap: three broken vows would push
 * an otherwise spotless ledger past the corrupt tolerance and shut the pure
 * capstone the system exists to open. The prototype's contract is that a Vow
 * can only ever pay; see `systems/Vows.js` for the single commit site.
 */
import { isVoidtouched } from './corruption.js';

/**
 * What one kept vow pays, in points of warding.
 *
 * Sized against `MOTE.per` (40): at 16 a vow is two-fifths of an Argent Mote,
 * so two kept vows nearly mint one and three comfortably do. That is the band
 * the ticket asked for, and it means a Pristine run that never once let the
 * world rise can still hold a mote by the third stage — the first permanent
 * purity reward reachable without crossing Overrun to get it.
 *
 * The warding also commits `warded` at `perUnit` 0.05, so a vow is worth
 * 16 * 0.05 = 0.8 pure from the payout plus `vowKept`'s flat 6, i.e. 6.8. Three
 * kept vows is 20.4 — exactly the pure capstone floor (`CAPSTONE.pure`), which
 * is the intended honest route to it.
 */
export const VOW_WARD = 16;

/**
 * Void Bargain kinds that break a restraint vow. Sanctuary and Consecration are
 * purity's own presses and must not.
 *
 * `ruin` is here and is the one that matters most: it is the heaviest corrupt
 * act in `data/alignment.js` (24, above the capstone floor on its own), and the
 * altar used to settle it by calling `Corruption.ruin()` directly without
 * emitting anything a vow could hear. A run could let the void all the way in
 * and still be paid for the Vow of the Closed Hand in the same stage. The altar
 * now emits `{ kind: 'ruin' }` alongside the other bargains; this set is the
 * other half of that fix and `tests/stage-vows.test.mjs` holds both open.
 */
const CORRUPT_BARGAIN = new Set(['reroll', 'synergy', 'pact', 'ruin']);

export const VOWS = [
  {
    id: 'seal-the-hollowed',
    kind: 'combat',
    title: 'Vow of the Seal',
    target: 3,
    keptOnClose: false,
    describe: (v) => `Seal ${v.target} Voidtouched before you leave this stage.`,
    progress: (v, s) => `${Math.min(s.count, v.target)}/${v.target}`,
    events: ['kill'],
    step(_name, payload, state, vow) {
      if (!isVoidtouched(payload?.victim)) return null;
      state.count++;
      return state.count >= vow.target ? 'kept' : null;
    },
  },
  {
    id: 'take-nothing-offered',
    kind: 'restraint',
    title: 'Vow of the Closed Hand',
    keptOnClose: true,
    describe: () => 'Buy nothing on void credit this stage — no forced lid, no pact.',
    progress: () => 'unbroken',
    events: ['itemOffer', 'itemOfferResolved', 'voidBargain'],
    step(name, payload) {
      if (name === 'voidBargain') {
        return CORRUPT_BARGAIN.has(payload?.kind) ? 'broken' : null;
      }
      // `itemOffer` is the chest's own open and `itemOfferResolved` is the
      // three-way verdict; either arriving as 'corrupt' is the same act of
      // spending void credit, and a vow broken twice is still broken once.
      return payload?.outcome === 'corrupt' ? 'broken' : null;
    },
  },
  {
    id: 'do-not-linger',
    kind: 'timing',
    title: 'Vow of the Swift Passage',
    /** Seconds of stage time by which the teleporter must have finished. */
    target: 210,
    keptOnClose: false,
    describe: (v) => `Charge the teleporter within ${v.target}s of arriving.`,
    progress: (v, s) => `${Math.max(0, Math.ceil(v.target - s.t))}s left`,
    events: ['teleporterComplete'],
    step(_name, _payload, state, vow) {
      return state.t <= vow.target ? 'kept' : 'broken';
    },
  },
];

export const VOW_BY_ID = Object.fromEntries(VOWS.map((v) => [v.id, v]));

/**
 * Which vow this seed offers on this stage. Pure, total, and — the property the
 * guard in `tests/stage-vows.test.mjs` exists to hold — drawn off its OWN
 * salted stream rather than `ctx.rng`.
 *
 * The salt follows `Interactables._placeBargain`'s idiom, with a different
 * multiplier so a stage's vow and its altar site are not correlated. Consuming
 * a gameplay draw here would make the presence of a vow move every later loot
 * roll, which is the one thing a purely additive system must not do.
 *
 * The hash is written out rather than fed to `core/MathUtil`'s `RNG`, because
 * `src/data/` may not import `src/core/` (`tests/import-boundaries.test.mjs`,
 * rule 2) — and the arithmetic below is a *finaliser*, not a generator: it needs
 * one avalanche, not a stream, so borrowing one would have been the larger
 * dependency for the smaller job.
 */
export function selectVow(seed, stageIndex) {
  // The XOR-with-a-multiple salt alone is NOT enough here, and the test that
  // says so is `different seeds offer different vows`: seeds 0 through 7 at
  // stage 0 all landed on the same vow, because the salted values differ only
  // in their low bits and the generator's first draw does not carry them into
  // the high ones. `_placeBargain` gets away with it — it feeds its stream into
  // a position, where a small bias is invisible — but a three-way pick off a
  // single first draw is exactly where that bias becomes "this seed has no
  // restraint vow". So the salt is avalanched first (the standard fmix32
  // finaliser) and the pick reads a value every bit of which depends on every
  // bit of (seed, stage).
  let h = ((seed >>> 0) ^ (Math.imul(0x27d4eb2f, stageIndex + 1) >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return VOWS[h % VOWS.length];
}
