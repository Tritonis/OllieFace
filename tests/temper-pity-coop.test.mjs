// tests/temper-pity-coop.test.mjs
// Co-op regressions for issue #223's argent pity, round 2.
//
// Round 1 fixed a threading bug (the altar always read `ctx.player` instead
// of the pressing pawn) but left pity's MUTATION wired to `previewArgent`,
// which any peer's `_updateFocus`/`prompt()` calls every frame near an altar
// it has not even pressed. Two peers rendering the same conceptual altar a
// different number of times could mutate their own local `_pity` counters a
// different number of times, so a guest who merely walked past a few altars
// could show a forced card locally that the host — whose satellite for that
// guest is only ever touched by a real `interact()` press — would not yet
// agree to deliver. The adjudicated fix: mutation is authoritative-commit-only
// (`Items.commitArgentPity`, called once from `VoidBargain.interact()`'s
// consecrate branch, after motes are genuinely spent); every display path
// (`consecrationPreview`, `prompt()`) is a non-mutating peek
// (`Items.peekArgentPity`).
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
  guestItems._pity.argentMisses = TEMPER_PITY_BOUND; // the next REAL offer forces
  return guestPawn;
}

console.log('threading + commit: a real interact() press for a remote pawn commits on THAT pawn\'s own satellite');
{
  const ctx = makeCtx(778899);
  const guestPawn = armGuestOnArgent(ctx);
  ok(Items.of(ctx, ctx.player).count('arc-rot') === 0, 'sanity: the host itself holds nothing relevant');

  const altar = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 0);
  let offered = null;
  ctx.events.on('mutationChoiceOffered', (p) => { offered = p.offers.map((c) => c.baseId); });

  const result = altar.interact(guestPawn);
  ok(result === true, 'the press resolves');
  ok(offered?.includes('quicksilver-vein'), `the REAL offer assembled for the guest forces their missing parent (${offered})`);
  ok(guestPawn.items._pity.argentMisses === 0, 'and the commit mutated the PRESSING pawn\'s own counter, not some other instance\'s');

  // The host's own local player was never touched by this press at all.
  ok(Items.of(ctx, ctx.player)._pity.argentMisses === 0, 'the host\'s own local pity state is untouched by a guest\'s press');
}

console.log('display path (consecrationPreview/prompt) is a PEEK: it shows the forced card without ever committing anything itself');
{
  const ctx = makeCtx(112233);
  const guestPawn = armGuestOnArgent(ctx);
  const altar = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 1);

  // Look at the altar many times, the way a HUD tooltip would every frame
  // the guest stands near it, WITHOUT ever pressing.
  let lastPreview = null;
  for (let i = 0; i < 20; i++) lastPreview = altar.consecrationPreview(guestPawn);
  ok(lastPreview.some((c) => c.id === 'quicksilver-vein'),
    `the peek already shows the forced card before any press (${lastPreview.map((c) => c.id)})`);
  ok(guestPawn.items._pity.argentMisses === TEMPER_PITY_BOUND,
    `twenty peeks never moved the counter off the bound it started at (${guestPawn.items._pity.argentMisses})`);

  // NOW press, for real: the commit fires exactly once and the delivered
  // offer matches what the peek was already showing.
  let offered = null;
  ctx.events.on('mutationChoiceOffered', (p) => { offered = p.offers.map((c) => c.baseId); });
  altar.interact(guestPawn);
  ok(offered.join(',') === lastPreview.map((c) => c.id).join(','),
    'the committed offer matches exactly what the repeated peek had already shown — no bait-and-switch');
  ok(guestPawn.items._pity.argentMisses === 0, 'and NOW the counter is spent');
}

console.log('PARITY: host-side authoritative commit for pawn X and a guest-local peek for the SAME mirrored state agree at press time');
{
  // Models two separate JS objects for the "same" logical pawn — the host's
  // satellite and a guest's own local mirror — sharing a seed and mirrored
  // counts, the shape the coordinator's parity requirement is about. The
  // guest peeks (as their own HUD would, any number of times); the host
  // commits (as the real press does, exactly once). Because mutation only
  // ever happens on the host's copy now, there is nothing left for the
  // guest's own peeks to have thrown out of sync — the peek is read-only by
  // construction, so it can only ever agree with whatever the host later
  // commits, never race ahead of it.
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
  guestMirror._pity.argentMisses = TEMPER_PITY_BOUND; // mirrored miss history

  const base = guestMirror.previewArgent(RELIQUARY.choices, stageIndex); // pure; identical on both sides
  const guestPeek = guestMirror.peekArgentPity(base); // the guest's own HUD, read-only
  const hostCommit = hostSatellite.commitArgentPity(base); // the host's real, one-time offer

  ok(guestPeek.join(',') === hostCommit.join(','),
    `guest's local peek and host's authoritative commit agree given identical mirrored state (${guestPeek} vs ${hostCommit})`);
  ok(guestMirror._pity.argentMisses === TEMPER_PITY_BOUND, 'the guest\'s own peek never moved its counter');
  ok(hostSatellite._pity.argentMisses === 0, 'while the host\'s commit did — the two are allowed to diverge in COUNTER STATE, never in what either one SHOWS');
}

console.log('RED->GREEN: the walk-near-altar drift is closed — looking, never pressing, now leaves BOTH sides at 0, not 2 vs 0');
{
  // The exact round-1 scenario, replayed against the round-2 API: a guest's
  // own client calls the display path (now `peekArgentPity` via
  // `consecrationPreview`, exactly what `prompt()` calls) for two altars it
  // walks past and never presses. Round 1's `_pityPreviewArgent` mutated on
  // every such call; round 2's peek must not move anything at all.
  const ctx = makeCtx(9001);
  const guestPawn = { isPlayer: true, alive: true, peerId: 7 };
  const guestItems = new Items(guestPawn);
  guestItems.init(ctx);
  guestPawn.items = guestItems;
  guestItems.give('arc-rot', 1);

  const altar0 = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 5); // stage 5: verified natural miss
  const altar1 = new VoidBargain(ctx, new THREE.Vector3(0, 0, 0), 7); // stage 7: verified natural miss
  altar0.consecrationPreview(guestPawn); // walk-by, never pressed
  altar1.consecrationPreview(guestPawn); // walk-by, never pressed

  const hostSatelliteForSamePawn = new Items({ peerId: 7 });
  hostSatelliteForSamePawn.init(ctx);
  hostSatelliteForSamePawn.give('arc-rot', 1); // same mirrored holding; the host never rendered either altar

  ok(guestItems._pity.argentMisses === 0 && hostSatelliteForSamePawn._pity.argentMisses === 0,
    `walk-bys now leave both sides at 0 (guest ${guestItems._pity.argentMisses}, host ${hostSatelliteForSamePawn._pity.argentMisses}) — was 2 vs 0 under round 1's mutate-on-peek`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
