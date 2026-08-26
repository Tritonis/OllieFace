/**
 * Enemy affix/corrupted presentation replicates to co-op guests (issue #228).
 *
 *   node tests/affix-replication.test.mjs
 *
 * Three claims, following the pattern `coop-shape-signature.test.mjs` used for
 * survivor class: (1) the host actually writes an enemy's affix/corrupted
 * state onto the wire, (2) `NetViews.EnemyView` actually changes its rig from
 * that record rather than ignoring it, and (3) removal — an affix or the
 * corrupted tint going away mid-run — updates the rig rather than sticking.
 *
 * Every claim goes through the REAL wire, not a stand-in: section [1] decodes
 * the actual bytes `NetHost._broadcastSnapshot` sent with `readEntity`, and
 * sections [2]-[4] hand a view factory only records that came out of
 * `writeEntity` -> `readEntity`, never a hand-built object. A prior version of
 * this file asserted on `enemy.affixId` — a JS property NetHost sets *before*
 * `writeEntity` runs — and hand-built view records, so it passed even with
 * the encoder blinded to write 0 always; that is what this rework closes.
 *
 * [2] and [3] are the ones that catch the regression this issue fixes:
 * `NetViews.js` used to hardcode `this.rig.setAffix(null)` regardless of what
 * the snapshot said. A guest never *derives* an affix locally — every
 * assertion below reads only wire fields (`typeId`, `affixId`, `corrupted`),
 * never anything from `data/enemies.js`'s spawn tables.
 */
import * as THREE from 'three';
import { EKIND, ESTATE, Writer, Reader, writeEntity, readEntity } from '../src/net/Protocol.js';
import { installViewFactories } from '../src/net/NetViews.js';
import { NetHost } from '../src/net/NetHost.js';
import { ENEMY_BY_TYPE, AFFIX_IDS } from '../src/data/enemies.js';
import { ELITE } from '../src/entities/EnemyMeshes.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const MITE_TYPE = [...ENEMY_BY_TYPE.keys()][0];

/** Decode one SNAPSHOT payload's header + entity records, the way SnapshotBuffer.ingest does. */
function decodeSnapshot(bytes) {
  const r = new Reader(bytes);
  r.u8();          // MSG.SNAPSHOT
  r.u32();         // tick
  r.u32();         // ackInput
  const count = r.u16();
  const out = [];
  for (let i = 0; i < count; i++) out.push(readEntity(r, {}));
  return out;
}

/** The real host path, for one enemy: real NetHost, real `_broadcastSnapshot`, real bytes decoded back with `readEntity`. */
function hostEnemyOverWire(affix, corrupted) {
  const sent = [];
  const host = new NetHost({});
  const enemy = {
    kind: EKIND.ENEMY, typeId: MITE_TYPE, replicated: true, alive: true,
    position: new THREE.Vector3(1, 2, 3), yaw: 0.5,
    health: 10, maxHealth: 10, shield: 0, netState: ESTATE.ALIVE,
    affix, corrupted,
  };
  host.ctx = { combat: { entities: [enemy] } };
  host.clients.set(1, { peer: { id: 1, sendState: (b) => sent.push(b) }, lastTick: 0 });
  host._broadcastSnapshot(host.ctx);
  const [decoded] = decodeSnapshot(sent[0]);
  return { sent, decoded };
}

/** Encode-then-decode a bare entity-like object through the real wire functions. */
function overWire(entityLike) {
  const w = new Writer();
  w.u8(4); w.u32(0); w.u32(0); w.u16(1);   // SNAPSHOT header: kind,tick,ack,count=1
  writeEntity(w, entityLike);
  const [decoded] = decodeSnapshot(w.bytes());
  return decoded;
}

console.log('\n[1] the host writes an enemy affix onto the real wire (decoded bytes, not the pre-encode JS property)');

{
  const { sent, decoded } = hostEnemyOverWire('galvanic', false);
  ok(sent.length === 1, 'one snapshot reached the peer');
  const wantId = AFFIX_IDS.indexOf('galvanic') + 1;
  ok(decoded.affixId === wantId, `decoded bytes carry galvanic's wire id ${wantId} (got ${decoded.affixId})`);
  ok(decoded.corrupted === false, 'decoded bytes carry corrupted=false for an elite');
}
{
  const { decoded } = hostEnemyOverWire(null, true);
  ok(decoded.affixId === 0, 'decoded bytes carry affixId 0 for a plain corrupted mob');
  ok(decoded.corrupted === true, 'decoded bytes carry corrupted=true for a plain corrupted mob');
}
{
  const { decoded } = hostEnemyOverWire(null, false);
  ok(decoded.affixId === 0 && decoded.corrupted === false, 'decoded bytes carry none/uncorrupted for a plain mob');
}

console.log('\n[2] the wire actually changes what renders (mutation) — a guest never derives an affix locally');

function viewFor(rec) {
  let factory = null;
  const client = {
    registerViewFactory(kind, fn) { if (kind === EKIND.ENEMY) factory = fn; },
  };
  const ctx = { scene: new THREE.Group() };
  installViewFactories(client, ctx);
  return factory({ netId: 9, x: 0, y: 0, z: 0, yaw: 0, state: ESTATE.ALIVE, healthFrac: 1, ...rec }, ctx);
}

/** A view built from a record that actually came out of `writeEntity` -> `readEntity`. */
function viewOverWire(affixId, corrupted) {
  const decoded = overWire({
    netId: 9, kind: EKIND.ENEMY, typeId: MITE_TYPE,
    position: { x: 0, y: 0, z: 0 }, yaw: 0, health: 10, maxHealth: 10, shield: 0,
    netState: ESTATE.ALIVE, affixId, corrupted,
  });
  return viewFor(decoded);
}

const plain = viewOverWire(0, false);
ok(plain.rig.affix === null, 'no affix on the wire -> no affix on the rig');
ok(plain.rig.corrupted === false, 'not corrupted on the wire -> not corrupted on the rig');

const galvanicId = AFFIX_IDS.indexOf('galvanic') + 1;
const elite = viewOverWire(galvanicId, false);
ok(elite.rig.affix === 'galvanic', 'affixId on the wire resolves to the named affix on the rig');
ok(elite.rig.mats !== plain.rig.mats, 'an affixed rig actually gets different materials than a plain one');

const corrupted = viewOverWire(0, true);
ok(corrupted.rig.corrupted === true, 'corrupted on the wire -> corrupted on the rig');
ok(corrupted.rig.mats !== plain.rig.mats, 'a corrupted rig actually gets different materials than a plain one');

console.log('\n[3] removal — affix and corrupted tint clearing mid-run — updates the rig');

// A live view, exactly as EnemyView is driven by NetClient: constructed from
// one record decoded off the wire, then advanced by applyNetState as later
// (also wire-decoded) snapshots arrive.
{
  let factory = null;
  const client = { registerViewFactory(kind, fn) { if (kind === EKIND.ENEMY) factory = fn; } };
  const ctx = { scene: new THREE.Group() };
  installViewFactories(client, ctx);

  const base = { netId: 11, kind: EKIND.ENEMY, typeId: MITE_TYPE,
    position: { x: 0, y: 0, z: 0 }, yaw: 0, health: 10, maxHealth: 10, shield: 0, netState: ESTATE.ALIVE };

  const first = overWire({ ...base, affixId: galvanicId, corrupted: false });
  const view = factory(first, ctx);
  ok(view.rig.affix === 'galvanic', 'join-in-progress: the first decoded record already carries the affix (no separate JIP path needed)');

  // GUARD-CAN-FAIL evidence: reverting NetViews.js's `_syncAffix` calls to the
  // old `this.rig.setAffix(null)` hardcode makes this assertion fail — the
  // rig would still read 'galvanic' from construction and never move off it.
  view.applyNetState(overWire({ ...base, affixId: 0, corrupted: false }), 0.05);
  ok(view.rig.affix === null, 'affix removal (elite -> none) clears the rig, not just the record');

  view.applyNetState(overWire({ ...base, affixId: 0, corrupted: true }), 0.05);
  ok(view.rig.corrupted === true, 'a later snapshot can still turn corrupted on');

  view.applyNetState(overWire({ ...base, affixId: 0, corrupted: false }), 0.05);
  ok(view.rig.corrupted === false, 'and corrupted removal clears the rig too');
}

console.log('\n[4] every affix key round-trips through the wire index and resolves to a rig ELITE entry');

for (let i = 0; i < AFFIX_IDS.length; i++) {
  const key = AFFIX_IDS[i];
  ok(!!ELITE[key], `AFFIX_IDS[${i}] ('${key}') has a matching EnemyMeshes.ELITE entry`);
  const view = viewOverWire(i + 1, false);
  ok(view.rig.affix === key, `wire id ${i + 1} resolves back to '${key}' on the rig`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
