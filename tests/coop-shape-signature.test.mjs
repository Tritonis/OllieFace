/**
 * Co-op per-class shape signatures, and the wire that makes them legible.
 *
 *   node tests/coop-shape-signature.test.mjs
 *
 * EFFECT-LANGUAGE.md §3.1 (groups X1-X3): in co-op, class-kit colours co-occur
 * — Ranger amber lands beside Cinder orange, Anvil red beside both — and the
 * language refuses to re-hue any of them, because a class's colour is part of
 * its identity. The separation is §1.2 polarity (player: white-hot core, element
 * rim) plus a per-class *shape* signature: Ranger lines, Anvil rings, Kestrel
 * charged lines with bead spool-ups, Rook lattices, Cinder cones of streaks.
 *
 * The whole claim rests on something that was not true when it was written: the
 * survivor id did not cross the wire, so every remote teammate was built from
 * the DEFAULT survivor's card and a remote Anvil rendered as a Ranger
 * (NetViews.js's own note). A signature nobody can attribute to a class is not
 * a signature. So this file checks both halves, and the second half is checked
 * by *removing* the class from the wire and proving the render changes.
 */
import * as THREE from 'three';
import {
  SURVIVORS, SURVIVOR_INDEX, DEFAULT_SURVIVOR, SURVIVOR_BY_ID,
  survivorByIndex, survivorIndexOf, loadoutOf,
} from '../src/data/survivors.js';
import { ABILITIES } from '../src/data/abilities.js';
import { EQUIPMENT } from '../src/data/equipment.js';
import { EKIND, ESTATE, Writer, MSG } from '../src/net/Protocol.js';
import { installViewFactories } from '../src/net/NetViews.js';
import { NetHost } from '../src/net/NetHost.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// §1.3's six families plus the two compounds the roster needed. A shape outside
// this list has not been separated from anything, because the bucketing re-run
// only sees names it knows (§1.4's argument, applied to shape).
const FAMILIES = new Set([
  'line', 'ring', 'radial-spark', 'streak', 'lattice', 'pose-ring',
  'charged-line', 'streak-cone', 'beam',
]);

// ---------------------------------------------------------------- signatures

console.log('\n[1] per-class shape signatures');

const sigs = new Map();
for (const s of SURVIVORS) {
  ok(typeof s.shapeSignature === 'string' && s.shapeSignature.length > 0,
    `${s.id} declares a shapeSignature`);
  ok(FAMILIES.has(s.shapeSignature),
    `${s.id} signature '${s.shapeSignature}' is a named family`);
  sigs.set(s.shapeSignature, (sigs.get(s.shapeSignature) ?? 0) + 1);
}

// The point of X1-X3. Two classes sharing a signature separates nothing, and
// two amber players would be back where they started.
for (const [sig, n] of sigs) {
  ok(n === 1, `signature '${sig}' is claimed by exactly one class (got ${n})`);
}
ok(sigs.size === SURVIVORS.length, 'every survivor has a distinct signature');

// The roster's signatures, spelled out, so a re-hue or a new class has to come
// past this line rather than quietly landing on somebody's point.
const EXPECTED = {
  ranger: 'line', anvil: 'ring', kestrel: 'charged-line',
  rook: 'lattice', cinder: 'streak-cone',
};
for (const [id, sig] of Object.entries(EXPECTED)) {
  ok(SURVIVOR_BY_ID[id]?.shapeSignature === sig,
    `${id} is '${sig}' as §3.1 names it`);
}

console.log('\n[2] every ability declares the shape it draws');

for (const [id, a] of Object.entries(ABILITIES)) {
  ok(FAMILIES.has(a.shape), `${id} shape '${a.shape}' is a named family`);
}

// The declared-shape field is the one `equipment.js` already carries, not a
// parallel scheme — if that ever forks, this notices.
const beamEquip = Object.values(EQUIPMENT).filter((e) => e.shape === 'beam');
ok(beamEquip.length >= 2, `equipment still declares shapes on the same field (${beamEquip.length} beams)`);

console.log('\n[3] a signature is visible in its own kit');

for (const s of SURVIVORS) {
  const kit = loadoutOf(s);
  const n = kit.filter((a) => a.shape === s.shapeSignature).length;
  // Half the kit. One ability carrying the signature is an accident; three is
  // a habit, and a habit is what a player reads across a fight.
  ok(n >= kit.length / 2,
    `${s.id}: ${n}/${kit.length} abilities draw '${s.shapeSignature}'`);
}

// Rook's lattice is the one that had to be *built* — Ward and Sentry drew a
// beam and two expanding rings, which is Anvil's Slam in lime. §1.3 forbids
// exactly that ("a shield going up" and "a freeze going off" cannot be the same
// shape), so both placeables now strike up a hex cage.
const wardSrc = ABILITIES.rookWard.fire.toString();
const turretSrc = ABILITIES.rookTurret.fire.toString();
ok(/latticeShell/.test(wardSrc), 'rookWard draws a lattice, not just rings');
ok(/latticeShell/.test(turretSrc), 'rookTurret draws a lattice, not just rings');

// Kestrel's is the compound §3.1 names literally: beads in front of a line.
ok(/chargeTell/.test(ABILITIES.kestrelLance.fire.toString()),
  'kestrelLance spools up with beads');
ok(/chargeTell/.test(ABILITIES.kestrelEclipse.fire.toString()),
  'kestrelEclipse spools up with beads');

// ------------------------------------------------------------------ the wire

console.log('\n[4] the survivor id crosses the wire');

ok(survivorIndexOf('anvil') === SURVIVOR_INDEX.anvil, 'survivorIndexOf agrees with the table');
for (const s of SURVIVORS) {
  ok(survivorByIndex(survivorIndexOf(s.id)).id === s.id, `${s.id} round-trips through its index`);
}
// Never throws, never null — the same contract `getSurvivor` holds.
ok(survivorByIndex(99).id === DEFAULT_SURVIVOR, 'an unknown index falls back to the default');
ok(survivorIndexOf('nosuchclass') === SURVIVOR_INDEX[DEFAULT_SURVIVOR],
  'an unknown id falls back to the default index');
// A byte is all `writeEntity` has for it.
ok(SURVIVORS.length <= 255, 'the roster still fits the typeId byte');

// What the host actually writes. A real NetHost, a real snapshot broadcast, one
// fake peer — the assertion is on the pawn's `typeId` after the encode, which
// is the field `writeEntity` puts on the wire.
function hostWithPawn(survivorId) {
  const sent = [];
  const host = new NetHost({});
  const pawn = {
    isPlayer: true, alive: true, replicated: true, survivorId,
    position: new THREE.Vector3(1, 2, 3), yaw: 0.5,
    health: 100, maxHealth: 100, shield: 0, netState: ESTATE.ALIVE,
  };
  host.ctx = { combat: { entities: [pawn] } };
  host.clients.set(1, {
    peer: { id: 1, sendState: (b) => sent.push(b) }, lastTick: 0,
  });
  host._broadcastSnapshot(host.ctx);
  return { pawn, sent };
}

for (const s of SURVIVORS) {
  const { pawn, sent } = hostWithPawn(s.id);
  ok(pawn.kind === EKIND.PLAYER, `${s.id}: pawn replicates as a PLAYER`);
  ok(pawn.typeId === survivorIndexOf(s.id),
    `${s.id}: host writes typeId ${survivorIndexOf(s.id)} (was a constant 0)`);
  ok(sent.length === 1, `${s.id}: one snapshot reached the peer`);
}

// A downed teammate is the case where a stand-in record is written instead of
// the pawn. If the class did not survive that copy, a teammate would change
// class the moment they went down, which is precisely when you are looking at
// them.
{
  const { pawn } = hostWithPawn('cinder');
  const host = new NetHost({});
  pawn.bleedout = 3;
  const rec = host._downedRecord(pawn);
  ok(rec.typeId === survivorIndexOf('cinder'), 'a downed teammate keeps their class');
}

console.log('\n[5] the wire actually changes what renders (mutation)');

// The claim under test is not "the field exists" but "removing it changes the
// render". So: build the same view twice, once from a record carrying the class
// and once from a record with the class stripped, and require them to differ.
function viewFor(typeId) {
  let factory = null;
  const client = {
    registerViewFactory(kind, fn) { if (kind === EKIND.PLAYER) factory = fn; },
  };
  const ctx = { scene: new THREE.Group() };
  installViewFactories(client, ctx);
  return factory({ netId: 7, typeId, x: 0, y: 0, z: 0, yaw: 0, state: ESTATE.ALIVE }, ctx);
}

const anvilIdx = survivorIndexOf('anvil');
const anvil = viewFor(anvilIdx);
ok(anvil.survivorId === 'anvil', 'a remote Anvil is built from the Anvil card');
ok(anvil.shapeSignature === 'ring', 'a remote Anvil carries the ring signature');
ok(Math.abs(anvil.height - SURVIVOR_BY_ID.anvil.hurtHeight) < 1e-6,
  'a remote Anvil is hittable at its own crown, not the default 2.13');
ok(anvil.accentColor === SURVIVOR_BY_ID.anvil.accentColor,
  'a remote Anvil wears its own accent');

// The mutation: strip the survivor id from the record, exactly as protocol 7
// left it. Every assertion above must now be false, or the field is decorative.
const stripped = viewFor(0);
ok(stripped.survivorId === DEFAULT_SURVIVOR, 'stripped: falls back to the default class');
ok(stripped.shapeSignature !== anvil.shapeSignature,
  'stripped: the shape signature changes (Ranger line, not Anvil ring)');
ok(Math.abs(stripped.height - anvil.height) > 0.5,
  `stripped: the hurtbox changes by ${(stripped.height - anvil.height).toFixed(3)} m`);
ok(stripped.accentColor !== anvil.accentColor, 'stripped: the accent changes');

// And every class must be distinguishable from every other on the wire, not
// just Anvil from Ranger — two classes that render identically would pass the
// mutation above and still be a collision.
{
  const seen = new Map();
  let clashes = 0;
  for (const s of SURVIVORS) {
    const v = viewFor(survivorIndexOf(s.id));
    const key = `${v.survivorId}|${v.shapeSignature}|${v.height.toFixed(4)}`;
    if (seen.has(key)) clashes++;
    seen.set(key, s.id);
  }
  ok(clashes === 0 && seen.size === SURVIVORS.length,
    `all ${SURVIVORS.length} classes render distinctly off the wire`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
