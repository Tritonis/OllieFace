// tests/temper-pity-coop.test.mjs
// Fix-wave regression for issue #223's argent pity, reviewer CRITICAL:
// `VoidBargain._consecrationIds()` always read `Items.of(this.ctx, this.ctx.player)`
// — the HOST's own local pawn — even when the host is resolving `interact(pawn)`
// on behalf of a remote pawn. Before pity, that was harmless: the ids were a
// pure function of (seed, stage) and identical on every satellite. Pity broke
// that invariant (the ids can now depend on which pawn's recipe is half-held),
// which turned the pre-existing shortcut into a real bug: a guest's own
// bounded pity could never fire through the altar, because the host was
// consulting its own inventory instead of the guest's.
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
    authority: true,
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

function armGuestOnArgent(ctx) {
  // A remote pawn's satellite: a distinct Items instance, exactly what
  // `Items.of(ctx, guestPawn)` resolves to on the HOST.
  const guestPawn = { isPlayer: true, alive: true, peerId: 7 };
  const guestItems = new Items(guestPawn);
  guestItems.init(ctx);
  guestPawn.items = guestItems;
  guestItems.give('arc-rot', 1); // blight parent of tempered-capacitor -> arms on missing argent quicksilver-vein
  guestItems._pity.argentMisses = TEMPER_PITY_BOUND; // next assembled preview forces
  return guestPawn;
}

console.log('CRITICAL repro: the altar path must consult the PRESSING pawn\'s own satellite, not the host\'s local player');
{
  const ctx = makeCtx(778899);
  const guestPawn = armGuestOnArgent(ctx);
  // The host's own local player never touched a parent — never armed.
  ok(Items.of(ctx, ctx.player).count('arc-rot') === 0, 'sanity: the host itself holds nothing relevant');

  const altar = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 0);

  // The comparison value, computed on an INDEPENDENT clone of the guest's
  // satellite state before the altar path ever runs — `previewArgent` mutates
  // pity counters on every real call, so reusing `guestPawn.items` itself for
  // both sides of the comparison would consume the force on whichever call
  // ran first and silently pass a second, already-reset call against it.
  const expected = new Items({ peerId: 7 });
  expected.init(ctx);
  expected.give('arc-rot', 1);
  expected._pity.argentMisses = TEMPER_PITY_BOUND;
  const direct = expected.previewArgent(RELIQUARY.choices, altar.stageIndex ?? 0);

  const hostView = altar._consecrationIds(ctx.player); // what the host's OWN player would see
  const guestView = altar._consecrationIds(guestPawn); // what the altar path resolves for the GUEST

  ok(!hostView.includes('quicksilver-vein'), 'the host\'s own unarmed view is never forced (sanity)');
  ok(guestView.includes('quicksilver-vein'),
    `the altar path forces the guest's missing argent parent into THEIR preview (${guestView})`);
  ok(guestView.join(',') === direct.join(','),
    'and it matches calling Items.of(ctx, guestPawn).previewArgent directly on an identically-armed clone of that satellite — the exact reviewer repro');
  ok(Items.of(ctx, guestPawn)._pity.argentMisses === 0,
    'the force actually mutated the PRESSING pawn\'s own counter, not some other instance\'s');
}

console.log('consecrationPreview/consecratePick/selectConsecration all thread the pawn through, not just _consecrationIds');
{
  const ctx = makeCtx(112233);
  const guestPawn = armGuestOnArgent(ctx);
  const altar = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 1);

  const preview = altar.consecrationPreview(guestPawn);
  ok(preview.some((c) => c.id === 'quicksilver-vein'),
    `consecrationPreview(guestPawn) carries the forced card into the displayed list (${preview.map((c) => c.id)})`);

  const pick = altar.consecratePick(guestPawn);
  ok(pick >= 0 && pick < preview.length, `consecratePick(guestPawn) clamps against the GUEST's own list length (${pick})`);
  ok(altar.selectConsecration(pick, guestPawn) === true, 'selectConsecration accepts an index valid for the guest\'s own offer');
}

console.log('PARITY (the non-drifted case): two independent Items instances for the same pawn, mirrored inventory, ONE call each, agree exactly');
{
  // Models the host's satellite for pawn X and a guest's own local mirror of
  // the SAME logical pawn X as two separate JS objects sharing a seed and
  // mirrored counts (what itemPickup sync guarantees) — the shape the
  // coordinator's parity requirement is about. This is the case where each
  // side calls `previewArgent` exactly once for this stage, in the same
  // order relative to the mirrored state — the case the fix above restores.
  const seed = 4455;
  const stageIndex = 2;

  const hostCtx = makeCtx(seed);
  const hostSatellite = new Items({ peerId: 7 });
  hostSatellite.init(hostCtx);
  hostSatellite.give('arc-rot', 1);
  hostSatellite._pity.argentMisses = TEMPER_PITY_BOUND;

  const guestCtx = makeCtx(seed); // a second process, same seed
  const guestMirror = new Items(); // the guest's OWN ctx.items, for their own pawn
  guestMirror.init(guestCtx);
  guestMirror.give('arc-rot', 1); // itemPickup sync mirrors the same holding
  guestMirror._pity.argentMisses = TEMPER_PITY_BOUND; // mirrored miss history, one call each so far

  const hostResult = hostSatellite.previewArgent(RELIQUARY.choices, stageIndex);
  const guestResult = guestMirror.previewArgent(RELIQUARY.choices, stageIndex);
  ok(hostResult.join(',') === guestResult.join(','),
    `host satellite and guest local mirror agree given identical mirrored state and call history (${hostResult} vs ${guestResult})`);
}

console.log('KNOWN GAP, not fixed here: a pawn that VIEWS an altar (prompt/tooltip) without pressing mutates only its own local instance');
{
  // Recorded as evidence for the coordinator, not asserted as a requirement
  // this fix wave meets: `_updateFocus` (Interactables.js) calls `prompt()`
  // for `ctx.player` every frame near ANY interactable, on whichever machine
  // is rendering it. That means a guest's own client can call
  // `_consecrationIds()`/`previewArgent` (and so mutate `_pity.argentMisses`)
  // simply by walking past an altar it never presses, while the HOST's
  // satellite for that guest is untouched until an actual `interact()` press
  // arrives over the network. If a guest walks past N altars before pressing
  // one, their local mirror's miss counter can be ahead of the host's by up
  // to N misses at press time, and the two sides can disagree about whether
  // pity has reached the bound. This is a real, reproducible divergence
  // (demonstrated in isolation below) that the pawn-threading fix above does
  // NOT address, because it is not about which Items instance is consulted —
  // it is about WHICH EVENTS are allowed to mutate `_pity` state at all, and
  // fixing it changes the mutation boundary (host-authoritative commit only,
  // vs read-only peek) rather than the pawn parameter. That is a design
  // decision, not a mechanical fix, so it is reported rather than built.
  const ctx = makeCtx(9001);
  const guestLocal = new Items(); // the guest's own mirror, "walks past" 2 altars
  guestLocal.init(ctx);
  guestLocal.give('arc-rot', 1);
  // Stage keys 5 and 7 are pre-verified (against this seed) to assemble a
  // preview that excludes the target — real, deterministic misses, not a
  // hand-set counter standing in for one.
  guestLocal.previewArgent(RELIQUARY.choices, 5); // walk-by altar: a miss, uncounted by any host
  guestLocal.previewArgent(RELIQUARY.choices, 7); // walk-by altar: another miss
  const guestMissesAfterWalkBys = guestLocal._pity.argentMisses;

  const hostSatelliteForSamePawn = new Items({ peerId: 7 });
  hostSatelliteForSamePawn.init(ctx);
  hostSatelliteForSamePawn.give('arc-rot', 1); // same mirrored holding, but no walk-by calls ever reached the host

  ok(guestMissesAfterWalkBys > hostSatelliteForSamePawn._pity.argentMisses,
    `guest's local miss count (${guestMissesAfterWalkBys}) outruns the host's satellite (${hostSatelliteForSamePawn._pity.argentMisses}) after walk-bys the host never saw — structural drift, out of scope for this fix wave`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
