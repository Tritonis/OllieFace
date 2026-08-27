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
import { EKIND, ESTATE, MSG, Writer, Reader, writeEntity, readEntity } from '../src/net/Protocol.js';
import { installViewFactories } from '../src/net/NetViews.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { ENEMY_BY_TYPE, AFFIX_IDS, ELITE_STATS } from '../src/data/enemies.js';
import { ELITE } from '../src/entities/EnemyMeshes.js';
import { HUD } from '../src/ui/HUD.js';
import { ITEM_BY_ID } from '../src/data/items.js';

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

// AFFIX_IDS is `Object.keys(ELITE_STATS)` (enemies.js), so the loop above only
// ever checks AFFIX_IDS against itself — a reorder of ELITE_STATS's literal
// keys would move every wire id at once and this loop would still pass,
// having moved the goalposts with it. This pins the order against a literal
// copy of `enemies.js`'s source, independent of AFFIX_IDS, so a reorder is
// caught rather than silently repointing every id.
const EXPECTED_AFFIX_ORDER = ['emberclad', 'galvanic', 'rimebound', 'withering', 'warded', 'voidtouched'];
ok(AFFIX_IDS.length === EXPECTED_AFFIX_ORDER.length,
  `AFFIX_IDS has ${EXPECTED_AFFIX_ORDER.length} entries (got ${AFFIX_IDS.length})`);
ok(EXPECTED_AFFIX_ORDER.every((k, i) => AFFIX_IDS[i] === k),
  `AFFIX_IDS matches the literal ELITE_STATS key order: ${EXPECTED_AFFIX_ORDER.join(', ')} (got ${AFFIX_IDS.join(', ')})`);

console.log('\n[5] a guest-side EnemyView exposes the affix HUD.setBoss needs (issue #238)');

{
  // A view built straight from a wire-decoded record, exactly like [2] above,
  // but reading the properties `HUD.setBoss` itself reads (`enemy.affix`,
  // `enemy.isElite`) rather than the rig's internals.
  const bare = viewOverWire(0, false);
  ok(bare.affix === null, 'no affix on the wire -> view.affix is null');
  ok(bare.isElite === false, 'no affix on the wire -> view.isElite is false');

  const view = viewOverWire(galvanicId, false);
  ok(view.affix === 'galvanic', "an elite's wire affixId resolves to view.affix, not just the rig");
  ok(view.isElite === true, 'a resolved affix marks the view isElite, matching Enemy.js');

  // The actual consumer, end to end: HUD.setBoss reads `enemy.isElite` and
  // `enemy.affix` off whatever `bossSpawn` hands it, which on a guest is this
  // view (NetClient._resolve turns the wire's `{netId}` back into it).
  const label = view.isElite ? (ELITE_STATS[view.affix]?.label ?? 'Elite') : null;
  ok(label && label !== 'Elite', `HUD's boss sub-line would resolve a real label, not the 'Elite' fallback (got '${label}')`);

  // GUARD-CAN-FAIL evidence: with `_syncAffix` blinded back to never touching
  // `this.affix`/`this.isElite` (i.e. reverting this fix), `view.affix` stays
  // `null` and `view.isElite` stays `false` on the elite case above, so this
  // whole section fails.
}

console.log('\n[6] a guest\'s boss bar actually opens, driven through the real _forward -> sanitise -> wire -> _resolve -> HUD.setBoss path (issue #238 wave 2, M2)');

/** Minimal event bus, the same shape `ctx.events` is everywhere in `src/`. */
function bus() {
  const listeners = new Map();
  return {
    on(name, fn) { (listeners.get(name) ?? listeners.set(name, []).get(name)).push(fn); return () => {}; },
    emit(name, p) { for (const fn of (listeners.get(name) ?? []).slice()) fn(p); },
  };
}

{
  const host = new NetHost({});
  const sentEvents = [];
  const sentState = [];
  host.transport = {
    onPeer: null, onPeerLeave: null,
    broadcastEvent: (b) => sentEvents.push(b), broadcastState() {}, close() {},
  };
  const hostCtx = { events: bus(), combat: { entities: [] }, authority: true, time: 0, seed: 1 };
  host.init(hostCtx);
  const peer = { id: 1, sendEvent() {}, sendState: (b) => sentState.push(b), pumpSim() {}, close() {} };
  host.clients.set(1, {
    peer, pawn: null, inputs: [], lastTick: 0, name: 'guest',
    joinTick: 0, joinedAt: 0, helloSeen: true, survivorId: null,
  });

  // A boss that has just spawned (`Director.spawnOne`), like `boss` at
  // Director.js:944-949 — in `ctx.combat.entities` but with no `.netId` yet,
  // because nothing has broadcast a snapshot containing it.
  const boss = {
    kind: EKIND.ENEMY, typeId: MITE_TYPE, replicated: true, alive: true, isBoss: true,
    name: 'Warden', displayName: null,
    position: new THREE.Vector3(0, 0, 0), yaw: 0,
    health: 500, maxHealth: 500, shield: 0, netState: ESTATE.ALIVE,
    affix: 'voidtouched', corrupted: false,
    takeDamage() {},
  };
  hostCtx.combat.entities.push(boss);
  ok(boss.netId === undefined, 'sanity: the boss has no netId before anything runs, matching the real spawn order');

  // The real spawn-time emission (Director.js:944-949), before any snapshot.
  hostCtx.events.emit('bossSpawn', { enemy: boss });
  ok(boss.netId !== undefined, "_sanitise assigned the boss a netId at spawn time rather than leaving it unset");
  ok(sentEvents.length === 1, 'one bossSpawn event reached the wire');

  const er = new Reader(sentEvents[0]);
  ok(er.u8() === MSG.EVENT, 'it is an EVENT message');
  const evName = er.str();
  const evPayload = er.json();
  ok(evName === 'bossSpawn', `named bossSpawn (got ${evName})`);
  ok(!!evPayload?.enemy && evPayload.enemy.netId === boss.netId,
    `wire payload names the boss's real netId, not null (got ${JSON.stringify(evPayload?.enemy)})`);

  // GUARD-CAN-FAIL evidence: reverting `_sanitise`'s `{netId: this._netId(v)}`
  // branch back to the old `out[k] = null` makes `evPayload.enemy` read
  // `null` here — the exact `{"enemy":null}` M2 reported.

  // Now the snapshot that carries the boss — `_broadcastSnapshot` assigns the
  // same netId `_sanitise` already gave it (`_netId` is idempotent) and hands
  // the guest something to build a view from.
  host._broadcastSnapshot(hostCtx);
  ok(sentState.length === 1, 'one snapshot reached the peer');

  // A real client: the real `NetClient`, the real `HUD.setBoss`, wired the
  // same way `main.js`/`HUD.js:642` wire them — `ctx.events.on('bossSpawn',
  // ({enemy}) => hud.setBoss(enemy))` — nothing hand-computed.
  const client = new NetClient();
  const clientCtx = { events: bus(), scene: new THREE.Group() };
  client.init(clientCtx);   // wires `clientCtx.net = client`, among other things
  client.connected = true;
  installViewFactories(client, clientCtx);

  // Event before snapshot — the realistic ordering, not the exception: the
  // events channel is reliable and ordered, the state channel is
  // `{ordered:false, maxRetransmits:0}` and can arrive late or not at all
  // (Transport.js:522,525), so a `bossSpawn` racing ahead of the first
  // snapshot that carries the boss is routine, worse under the packet loss
  // this codebase already simulates (`Transport.js` `sim.lossPct`).

  // A minimal stand-in for the DOM-heavy parts of `HUD` — `setBoss` and
  // `updateBoss` themselves are imported and called unmodified via
  // `HUD.prototype`, nothing about either is reimplemented here.
  const hud = {
    boss: null, c: {},
    refs: {
      bossName: { textContent: '' }, bossSub: { textContent: '' },
      bossBar: { classList: { add() {}, remove() {} } },
      bossFill: { style: {} }, bossPct: { textContent: '' },
      bossPing: { style: {} },
    },
    setObjective() {},
    // `updateBoss` (HUD.js) calls `this.setBoss`/`this.set`/`this.updateBossPing`
    // internally, so the stand-in needs real bound methods, not just a
    // one-off `.call()` from the listener below.
    setBoss: HUD.prototype.setBoss,
    set: HUD.prototype.set,
    updateBossPing: HUD.prototype.updateBossPing,
    ping: HUD.prototype.ping,
    setPing: HUD.prototype.setPing,
    setBossPing: HUD.prototype.setBossPing,
  };
  clientCtx.events.on('bossSpawn', ({ enemy }) => hud.setBoss(enemy));

  client._handleMessage(sentEvents[0]);   // real MSG.EVENT decode -> _resolve -> emit
  ok(hud.boss !== null, 'HUD.setBoss did not early-return: the guest resolved a real enemy, not null');
  ok(hud.boss.netId === boss.netId && hud.boss.health === undefined,
    'the boss bar opened off a bare {netId} stub — no view exists yet');
  ok(hud.refs.bossName.textContent === 'BOSS', "the placeholder name shows immediately (nothing to name it with yet, got '" + hud.refs.bossName.textContent + "')");
  ok(hud.refs.bossSub.textContent === 'Teleporter Boss',
    `no affix line yet — the stub carries no affix (got '${hud.refs.bossSub.textContent}')`);

  // GUARD-CAN-FAIL evidence: with the M2 fix reverted, `evPayload.enemy` is
  // `null`, `_resolve` passes `null` through unchanged, `HUD.setBoss(null)`
  // early-returns at `HUD.js:848`, and `hud.boss` stays `null` — this section
  // fails at the very first `hud.boss !== null` assertion.

  // The snapshot the guest was still waiting on: on the real transport the
  // events channel is reliable and ordered while the state channel is
  // neither (`{ordered:false, maxRetransmits:0}`, Transport.js:522,525), so
  // this ordering — the event landing first — is routine, not the exception;
  // no earlier claim in this file that it was out of scope survives that.
  client._handleMessage(sentState[0]);
  client.update(clientCtx, 1 / 60);
  const realView = client.views.get(boss.netId);
  ok(!!realView && realView !== hud.boss, 'the guest has now built the real view, distinct from the stub still latched in HUD');

  // The real per-frame call (`HUD.update` -> `updateBoss`, HUD.js:1028) is
  // what has to notice and upgrade — nothing re-drives `bossSpawn` itself.
  HUD.prototype.updateBoss.call(hud, clientCtx);
  ok(hud.boss === realView, 'updateBoss swapped the stub for the real view once one existed');
  ok(hud.refs.bossSub.textContent.includes('Hollowed'),
    `the affix line now names voidtouched's real label 'Hollowed' (got '${hud.refs.bossSub.textContent}')`);
  ok(hud.refs.bossPct.textContent === '100%',
    `the health fraction reads off the real view, not the stub (got '${hud.refs.bossPct.textContent}')`);
  ok(hud.boss.position && hud.boss.position.x === 0 && hud.boss.position.z === 0,
    'the position reads off the real view too (the stub had none at all)');

  // GUARD-CAN-FAIL evidence: with `updateBoss`'s stub-detection reverted,
  // `hud.boss` stays the `{netId}` stub forever — `hud.boss === realView`
  // fails, the sub-line stays 'Teleporter Boss' with no affix, and
  // `bossPct.textContent` stays whatever the stub's `undefined` health
  // rounded to (`'0%'`), reproducing the reviewer's "boss bar opens
  // permanently wrong" repro exactly.
}

console.log('\n[7] EnemyView.isElite (wave 1) correctly gates Whisper Stalks and Vulture\'s Mantle (issue #238 wave 2, M3)');

// Adjudicated as CORRECT host-parity, not a defect: `EnemyView.isElite`
// (wave 1) is read by `victim?.isElite` in two item hooks
// (`src/data/items.js:1771`, `:1834`), and before wave 1 it was `undefined`
// on every guest view, so Whisper Stalks was silently dead for a guest and
// Vulture's Mantle fired on bosses only. This tests that the two hooks
// correctly honour an `EnemyView`'s `isElite`/`isBoss` exactly as they
// already honour a real `Enemy`'s — the item code itself has no idea which
// kind of object it was handed, only that it carries the two flags.
//
// Reachability, honestly stated (the m2 lesson: ask whether the fixture is
// reachable): today `Combat._kill` -> `_dispatch('onKill', ...)` is the only
// simulation call site for these hooks, and it is reached exclusively through
// `applyDamage`, which returns immediately when `!ctx.authority`
// (`Combat.js:505`) — so a *guest's own* `Items.onKill` never actually fires
// with a network view as `victim` today; every real kill is resolved, and
// every hook dispatched, on the host with a real `Enemy`. `Showcase.js:212`
// is the one place that already calls `items.onKill({victim, ...})` directly,
// outside that gate, which is the same direct-call shape used below.

{
  const calls = [];
  const api = {
    count: 1,
    items: {
      addBuff: (...args) => calls.push(['addBuff', ...args]),
      addBarrier: (...args) => calls.push(['addBarrier', ...args]),
    },
    // `vultures-mantle` reads `api.ctx.vfx` without an intervening `?.`, so
    // `ctx` itself has to exist; `cue()` (Whisper Stalks) no-ops safely off an
    // empty one, same as everything else here.
    ctx: {},
  };

  const whisperStalks = ITEM_BY_ID.get('whisper-stalks').hooks.onKill;
  const vulturesMantle = ITEM_BY_ID.get('vultures-mantle').hooks.onKill;

  const eliteView = viewOverWire(galvanicId, false);
  ok(eliteView.isElite === true, "sanity: the fixture view is elite (wave 1's own guarantee)");

  calls.length = 0;
  whisperStalks({ victim: eliteView }, api);
  ok(calls.some((c) => c[0] === 'addBuff'), "Whisper Stalks fires its cooldown reset for an elite EnemyView victim");

  calls.length = 0;
  vulturesMantle({ victim: eliteView }, api);
  ok(calls.some((c) => c[0] === 'addBuff') && calls.some((c) => c[0] === 'addBarrier'),
    "Vulture's Mantle fires its buff and barrier for an elite EnemyView victim");

  const plainView = viewOverWire(0, false);
  ok(plainView.isElite === false && !plainView.isBoss, 'sanity: the fixture view is neither elite nor boss');

  calls.length = 0;
  whisperStalks({ victim: plainView }, api);
  ok(calls.length === 0, 'Whisper Stalks stays dead for a plain EnemyView victim');

  calls.length = 0;
  vulturesMantle({ victim: plainView }, api);
  ok(calls.length === 0, "Vulture's Mantle stays dead for a plain EnemyView victim");

  // GUARD-CAN-FAIL evidence: with wave 1's `this.isElite = !!affix;` reverted
  // (i.e. `_syncAffix` never touching `isElite`), `eliteView.isElite` reads
  // `undefined`, both `e.victim?.isElite` gates read false, and the two
  // "fires" assertions above fail.
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
