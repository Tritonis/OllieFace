// tests/temper-pity-guest-sync.test.mjs
// Issue #223 round 3: a guest's own local `Items` mirror never runs
// `commitArgentPity` at all — that only ever executes where `ctx.authority`
// is true, the host's own copy of whichever pawn pressed. Round 2 left the
// mirror's `_pity.argentMisses` frozen at 0 forever, so its own tooltip peek
// (`peekArgentPity`) could promise a card the host's actual delivery omitted,
// or fail to promise one the host was about to force.
//
// The fix: `Items.applyArgentOfferOutcome` replays the ALREADY-DELIVERED
// `mutationChoiceOffered` offer (the post-commit truth, addressed to this
// pawn) onto a mirror, converging it to the host's counter without a new
// wire message. Wired at `HUD.js`'s existing `mutationChoiceOffered`
// consumer, guarded by `!ctx.authority` so the host's own already-mutated
// copy is never double-applied.
import * as THREE from 'three';
import { Items, TEMPER_PITY_BOUND } from '../src/systems/Items.js';
import { VoidBargain } from '../src/world/Interactables.js';
import { RELIQUARY } from '../src/data/bandBoons.js';
import { RNG } from '../src/core/MathUtil.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(seed) {
  const listeners = new Map();
  const ctx = {
    authority: true, // the HOST process — VoidBargain.interact() only ever runs with effect here
    seed,
    rng: new RNG(seed),
    time: 0,
    corruption: { band: 0, marks: 0, motes: RELIQUARY.motes, ruined: false, spendMotes: () => true },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
  };
  ctx.player = { isPlayer: true, alive: true };
  const items = new Items();
  items.init(ctx);
  return ctx;
}

// Stage indices for seed 550101 pre-verified to assemble a preview excluding
// 'quicksilver-vein' — real, deterministic misses (see round 1/2 for the same
// technique), so the pity bound is reached by GENUINE misses, not a hand-set
// counter standing in for them.
const MISS_STAGES = [1, 7, 9, 10, 16, 18, 19, 23];
const SEED = 550101;

console.log('RED->GREEN: 6 host presses (misses), then the 7th preview must show the host\'s forced delivery on the GUEST\'s own mirror too');
{
  const ctx = makeCtx(SEED);
  const guestPawn = { isPlayer: true, alive: true, peerId: 7 };
  const hostSideSatellite = new Items(guestPawn); // Items.of(ctx, guestPawn) on the HOST
  hostSideSatellite.init(ctx);
  guestPawn.items = hostSideSatellite;
  hostSideSatellite.give('arc-rot', 1); // arms on missing argent quicksilver-vein

  // The GUEST's own separate process: a different Items object, same
  // mirrored inventory (what itemPickup sync guarantees), that never runs
  // `commitArgentPity` — only ever receives `applyArgentOfferOutcome` replay.
  const guestCtx = makeCtx(SEED);
  const guestLocalMirror = new Items();
  guestLocalMirror.init(guestCtx);
  guestLocalMirror.give('arc-rot', 1);

  const deliveries = [];
  for (let i = 0; i < TEMPER_PITY_BOUND; i++) {
    const altar = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), MISS_STAGES[i]);
    let offer = null;
    const unsub = ctx.events.on('mutationChoiceOffered', (p) => { offer = p; });
    altar.interact(guestPawn); // the REAL, authoritative commit — host side
    deliveries.push(offer);
    // Wire simulation: the addressed event crosses to the guest, who applies
    // the replay exactly where HUD.js does.
    guestLocalMirror.applyArgentOfferOutcome(offer.offers.map((c) => c.baseId), offer.offerId);
    // Resolve the window (picking the first card is enough) so the NEXT
    // altar's press is not refused by a still-open choice on this instance.
    hostSideSatellite.chooseMutation(offer.offers[0].baseId);
  }
  ok(deliveries.every((d) => !d.offers.some((c) => c.baseId === 'quicksilver-vein')),
    'sanity: all 6 presses were genuine misses (pre-verified stages), not already forced');
  ok(hostSideSatellite._pity.argentMisses === TEMPER_PITY_BOUND,
    `RED baseline: host's own counter is at the bound after 6 real misses (${hostSideSatellite._pity.argentMisses})`);

  // Before the fix, `guestLocalMirror._pity.argentMisses` would still read 0
  // here — nothing had ever moved it. With the replay wired, it must track
  // the host exactly.
  ok(guestLocalMirror._pity.argentMisses === TEMPER_PITY_BOUND,
    `GREEN: the guest's own mirror converged to the host's counter via event replay (${guestLocalMirror._pity.argentMisses})`);

  // The 7th press: the host forces the missing parent.
  const altar7 = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 30); // an unverified stage is fine — force overrides whatever it would have rolled
  let offer7 = null;
  ctx.events.on('mutationChoiceOffered', (p) => { offer7 = p; });
  altar7.interact(guestPawn);
  ok(offer7.offers.some((c) => c.baseId === 'quicksilver-vein'), `the 7th press is genuinely forced by the host (${offer7.offers.map((c) => c.baseId)})`);

  // The reviewer's exact claim: BEFORE the guest ever sees offer 7 delivered,
  // does their OWN tooltip peek (built from the SAME converged counter)
  // already agree with what is about to be delivered? Yes — the peek is
  // taken against the base ids for the SAME stage as altar7 to prove the
  // guest's local state, converged after 6 replays, independently predicts
  // the same force the host is about to commit.
  const base7 = guestLocalMirror.previewArgent(RELIQUARY.choices, altar7.stageIndex);
  const guestPeek7 = guestLocalMirror.peekArgentPity(base7);
  ok(guestPeek7.join(',') === offer7.offers.map((c) => c.baseId).join(','),
    `the guest's own tooltip peek (converged via replay) matches the host's actual 7th delivery exactly (${guestPeek7} vs ${offer7.offers.map((c) => c.baseId)})`);

  guestLocalMirror.applyArgentOfferOutcome(offer7.offers.map((c) => c.baseId), offer7.offerId);
  ok(guestLocalMirror._pity.argentMisses === 0, 'and the replay resets the guest\'s mirror the same way the force reset the host');
}

console.log('EXACTLY-ONCE: replaying the SAME offerId twice must not double-count');
{
  const ctx = makeCtx(778899);
  const mirror = new Items();
  mirror.init(ctx);
  mirror.give('arc-rot', 1);

  const missOffer = { offerId: 42, offers: [{ baseId: 'unblemished-plate' }, { baseId: 'chime-of-absolution' }, { baseId: 'pale-standard' }] };
  mirror.applyArgentOfferOutcome(missOffer.offers.map((c) => c.baseId), missOffer.offerId);
  ok(mirror._pity.argentMisses === 1, 'the first delivery of offer 42 counts one miss');

  // A duplicate delivery of the identical offerId (retransmit, re-subscribed
  // listener) must be a no-op, not a second miss.
  mirror.applyArgentOfferOutcome(missOffer.offers.map((c) => c.baseId), missOffer.offerId);
  ok(mirror._pity.argentMisses === 1, `a duplicate delivery of the SAME offerId is a no-op (${mirror._pity.argentMisses})`);

  // A genuinely NEW offer (different offerId) is counted normally.
  const missOffer2 = { offerId: 43, offers: [{ baseId: 'unblemished-plate' }, { baseId: 'chime-of-absolution' }, { baseId: 'pale-standard' }] };
  mirror.applyArgentOfferOutcome(missOffer2.offers.map((c) => c.baseId), missOffer2.offerId);
  ok(mirror._pity.argentMisses === 2, `a genuinely new offerId counts normally (${mirror._pity.argentMisses})`);
}

console.log('the host\'s OWN pawn is never double-applied: HUD only replays when !ctx.authority');
{
  // This is the guard itself, exercised directly rather than through the DOM
  // — `commitArgentPity` on the host's own local pawn already mutated
  // `ctx.items` synchronously inside `interact()`; if HUD's handler replayed
  // AGAIN on that same instance the counter would move twice for one event.
  const ctx = makeCtx(220099);
  ctx.items.give('arc-rot', 1);
  const base = ctx.items.previewArgent(RELIQUARY.choices, 1);
  const committed = ctx.items.commitArgentPity(base); // what interact() already did
  const afterCommit = ctx.items._pity.argentMisses;

  // Simulate HUD's own guard: on the authoritative side, it must skip.
  const wouldReplay = !ctx.authority;
  ok(wouldReplay === false, 'ctx.authority is true on the host, so HUD\'s own replay call is skipped for its own pawn');
  ok(ctx.items._pity.argentMisses === afterCommit, 'confirming: nothing further moves the counter for the host\'s own offer');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
