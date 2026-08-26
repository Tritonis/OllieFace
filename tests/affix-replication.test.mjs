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

console.log('\n[1] the host writes an enemy affix onto the wire');

function hostWithEnemy(affix, corrupted) {
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
  return { enemy, sent };
}

{
  const { enemy, sent } = hostWithEnemy('galvanic', false);
  ok(sent.length === 1, 'one snapshot reached the peer');
  ok(enemy.affixId === AFFIX_IDS.indexOf('galvanic') + 1, `host resolved galvanic to wire id ${AFFIX_IDS.indexOf('galvanic') + 1}`);
}
{
  const { enemy } = hostWithEnemy(null, true);
  ok(enemy.affixId === 0, 'a plain corrupted mob writes affixId 0');
}
{
  const { enemy } = hostWithEnemy(null, false);
  ok(enemy.affixId === 0, 'a plain, uncorrupted mob writes affixId 0');
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

const plain = viewFor({ typeId: MITE_TYPE, affixId: 0, corrupted: false });
ok(plain.rig.affix === null, 'no affix on the wire -> no affix on the rig');
ok(plain.rig.corrupted === false, 'not corrupted on the wire -> not corrupted on the rig');

const galvanicId = AFFIX_IDS.indexOf('galvanic') + 1;
const elite = viewFor({ typeId: MITE_TYPE, affixId: galvanicId, corrupted: false });
ok(elite.rig.affix === 'galvanic', 'affixId on the wire resolves to the named affix on the rig');
ok(elite.rig.mats !== plain.rig.mats, 'an affixed rig actually gets different materials than a plain one');

const corrupted = viewFor({ typeId: MITE_TYPE, affixId: 0, corrupted: true });
ok(corrupted.rig.corrupted === true, 'corrupted on the wire -> corrupted on the rig');
ok(corrupted.rig.mats !== plain.rig.mats, 'a corrupted rig actually gets different materials than a plain one');

console.log('\n[3] removal — affix and corrupted tint clearing mid-run — updates the rig');

// A live view, exactly as EnemyView is driven by NetClient: constructed from
// one record, then advanced by applyNetState as later snapshots arrive.
{
  let factory = null;
  const client = { registerViewFactory(kind, fn) { if (kind === EKIND.ENEMY) factory = fn; } };
  const ctx = { scene: new THREE.Group() };
  installViewFactories(client, ctx);

  const view = factory({ netId: 11, typeId: MITE_TYPE, x: 0, y: 0, z: 0, yaw: 0,
    state: ESTATE.ALIVE, healthFrac: 1, affixId: galvanicId, corrupted: false }, ctx);
  ok(view.rig.affix === 'galvanic', 'join-in-progress: the first record already carries the affix (no separate JIP path needed)');

  // GUARD-CAN-FAIL evidence: reverting NetViews.js's `_syncAffix` call to the
  // old `this.rig.setAffix(null)` hardcode makes this assertion fail — the
  // rig would still read 'galvanic' from construction and never move off it.
  view.applyNetState({ x: 0, y: 0, z: 0, yaw: 0, state: ESTATE.ALIVE, healthFrac: 1,
    affixId: 0, corrupted: false }, 0.05);
  ok(view.rig.affix === null, 'affix removal (elite -> none) clears the rig, not just the record');

  view.applyNetState({ x: 0, y: 0, z: 0, yaw: 0, state: ESTATE.ALIVE, healthFrac: 1,
    affixId: 0, corrupted: true }, 0.05);
  ok(view.rig.corrupted === true, 'a later snapshot can still turn corrupted on');

  view.applyNetState({ x: 0, y: 0, z: 0, yaw: 0, state: ESTATE.ALIVE, healthFrac: 1,
    affixId: 0, corrupted: false }, 0.05);
  ok(view.rig.corrupted === false, 'and corrupted removal clears the rig too');
}

console.log('\n[4] every affix key round-trips through the wire index and resolves to a rig ELITE entry');

for (let i = 0; i < AFFIX_IDS.length; i++) {
  const key = AFFIX_IDS[i];
  ok(!!ELITE[key], `AFFIX_IDS[${i}] ('${key}') has a matching EnemyMeshes.ELITE entry`);
  const view = viewFor({ typeId: MITE_TYPE, affixId: i + 1, corrupted: false });
  ok(view.rig.affix === key, `wire id ${i + 1} resolves back to '${key}' on the rig`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
