/**
 * The downed state on the wire (mp-p3, task 4).
 *
 *   node tests/revive-net.test.mjs
 *
 * Four properties, no WebRTC and no DOM:
 *   1. `ESTATE.DOWNED` survives writeEntity/readEntity like any other state.
 *   2. A downed pawn's `healthFrac` carries its bleed-out clock, not its
 *      health — the host writes it at the snapshot-build site, and a standing
 *      pawn in the same snapshot is untouched by that special case.
 *   3. `playerDowned` / `playerRevived` / `playerBledOut` are broadcast to
 *      every peer with their live pawn refs reduced to netIds.
 *   4. The receiving end: a client's own predicted survivor and a remote
 *      `PlayerView` both read state 3 as "downed and still alive", both clear
 *      it on the next ALIVE, and neither confuses it with a death.
 *
 * Channel-level assertions go through the `Peer`/`chan()` fixtures from
 * tests/netlag.test.mjs:14-28, so what is asserted is what a data channel was
 * actually handed.
 */
import * as THREE from 'three';
import { Peer } from '../src/net/Transport.js';
import {
  Writer, Reader, MSG, EKIND, ESTATE, writeEntity, readEntity,
} from '../src/net/Protocol.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { installViewFactories } from '../src/net/NetViews.js';
import { Player } from '../src/entities/Player.js';
import { REVIVE } from '../src/data/revive.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --- fixtures, copied from tests/netlag.test.mjs:14-28 ----------------------

function fakePc() { return { close() {}, addEventListener() {}, removeEventListener() {} }; }

function chan() {
  const sent = [];
  return { readyState: 'open', bufferedAmount: 0, send: (b) => sent.push(b), sent };
}

function wiredPeer(id = 1) {
  const p = new Peer(fakePc(), id);
  p.state = chan();
  p.events = chan();
  return p;
}

/** A pawn with the real `netState` getter and none of the world it needs. */
function pawn({ netId, downed = false, alive = true, health = 100, bleedout = 0 }) {
  const p = Object.create(Player.prototype);
  p.netId = netId;
  p.isPlayer = true;
  p.alive = alive;
  p.downed = downed;
  p.bleedout = bleedout;
  p.revive = 0;
  p.health = health;
  p.maxHealth = 100;
  p.shield = 0;
  p.yaw = 0;
  p.position = new THREE.Vector3(1, 2, 3);
  return p;
}

/** Read a SNAPSHOT off a state channel into `netId -> record`. */
function readSnapshot(bytes) {
  const r = new Reader(bytes);
  const kind = r.u8();
  const tick = r.u32();
  r.u32();                      // ack
  const count = r.u16();
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const rec = readEntity(r, {});
    out.set(rec.netId, rec);
  }
  return { kind, tick, count, out };
}

/** Read an EVENT off an events channel. */
function readEvent(bytes) {
  const r = new Reader(bytes);
  const kind = r.u8();
  return { kind, name: r.str(), payload: r.json() };
}

// --- 1. round trip ----------------------------------------------------------

console.log('writeEntity/readEntity preserve ESTATE.DOWNED');
{
  const w = new Writer(64);
  writeEntity(w, {
    netId: 9, kind: EKIND.PLAYER, typeId: 0,
    position: { x: -4.5, y: 0.25, z: 12 }, yaw: 0.5,
    health: 0.75, maxHealth: 1, shield: 0, netState: ESTATE.DOWNED,
  });
  const rec = readEntity(new Reader(w.bytes()), {});
  ok(rec.state === ESTATE.DOWNED, `state round-trips as DOWNED (got ${rec.state})`);
  ok(rec.state === 3, 'DOWNED is the wire value 3');
  // The clock rides in `healthFrac`, so its quantisation is the u16 grid.
  ok(near(rec.healthFrac, 0.75, 1 / 65535), `healthFrac 0.75 round-trips (got ${rec.healthFrac})`);
  ok(rec.kind === EKIND.PLAYER && rec.netId === 9, 'the rest of the record is unharmed');
}

// --- 2. the host writes the clock ------------------------------------------

console.log('a downed pawn\'s healthFrac is bleedout / BLEEDOUT_S');
{
  const host = new NetHost();
  const down = pawn({ netId: 0, downed: true, health: 0, bleedout: REVIVE.BLEEDOUT_S * 0.25 });
  const up = pawn({ netId: 0, health: 50 });
  host.ctx = { combat: { entities: [down, up] } };
  const peer = wiredPeer(1);
  host.clients.set(1, { peer, pawn: down, inputs: [], lastTick: 7 });

  host._broadcastSnapshot(host.ctx);
  ok(peer.state.sent.length === 1, 'one snapshot reached the state channel');
  const { kind, count, out } = readSnapshot(peer.state.sent[0]);
  ok(kind === MSG.SNAPSHOT, 'it is a SNAPSHOT');
  ok(count === 2, `both pawns replicate — a downed one is not skipped (got ${count})`);

  const d = out.get(down.netId);
  const u = out.get(up.netId);
  ok(d?.state === ESTATE.DOWNED, 'the downed pawn is written as DOWNED');
  ok(near(d?.healthFrac ?? -1, 0.25, 1e-4), `downed healthFrac is the clock, 0.25 (got ${d?.healthFrac})`);
  ok(near(u?.healthFrac ?? -1, 0.5, 1e-4), `the standing pawn still carries health, 0.5 (got ${u?.healthFrac})`);
  ok(u?.state === ESTATE.ALIVE, 'the standing pawn is still ALIVE');
  // Position is the pawn's, not the scratch record's leftovers.
  ok(near(d?.x ?? 0, 1, 0.02) && near(d?.z ?? 0, 3, 0.02), 'the downed record carries the pawn position');
}

console.log('the clock is clamped and empties to zero');
{
  const host = new NetHost();
  const down = pawn({ netId: 0, downed: true, health: 0, bleedout: 0 });
  host.ctx = { combat: { entities: [down] } };
  const peer = wiredPeer(1);
  host.clients.set(1, { peer, pawn: down, inputs: [], lastTick: 0 });
  host._broadcastSnapshot(host.ctx);
  const { out } = readSnapshot(peer.state.sent[0]);
  ok(out.get(down.netId)?.healthFrac === 0, 'an empty clock is 0 on the wire');
}

// --- 3. the host broadcasts the three events --------------------------------

function hostWithBus() {
  const host = new NetHost();
  const handlers = new Map();
  const ctx = {
    authority: true, seed: 1, time: 0,
    events: {
      on: (n, f) => { (handlers.get(n) ?? handlers.set(n, []).get(n)).push(f); },
      emit: (n, p) => { for (const f of handlers.get(n) ?? []) f(p); },
    },
    combat: { entities: [] },
  };
  host.init(ctx);
  const peer = wiredPeer(1);
  host.transport.peers.set(1, peer);
  host.clients.set(1, { peer, pawn: null, inputs: [], lastTick: 0 });
  return { host, ctx, peer };
}

console.log('playerDowned / playerRevived / playerBledOut are broadcast with netIds');
{
  const { ctx, peer } = hostWithBus();
  const victim = pawn({ netId: 4, downed: true, health: 0, bleedout: REVIVE.BLEEDOUT_S });
  const rescuer = pawn({ netId: 5 });

  ctx.events.emit('playerDowned', { player: victim, position: victim.position, source: null });
  ctx.events.emit('playerRevived', { player: victim, by: rescuer, position: victim.position });
  ctx.events.emit('playerBledOut', { player: victim, position: victim.position });

  ok(peer.events.sent.length === 3, `three events reached the peer (got ${peer.events.sent.length})`);
  const evs = peer.events.sent.map(readEvent);
  ok(evs.every((e) => e.kind === MSG.EVENT), 'each is an EVENT message');
  ok(evs.map((e) => e.name).join(',') === 'playerDowned,playerRevived,playerBledOut',
     `names in order (got ${evs.map((e) => e.name).join(',')})`);

  const [downEv = {}, revEv = {}] = evs;
  ok(downEv.payload?.player?.netId === 4, 'playerDowned names the victim by netId');
  ok(Object.keys(downEv.payload?.player ?? {}).length === 1, 'and carries nothing else of the pawn');
  ok(near(downEv.payload?.position?.x ?? 0, 1, 0.01) && near(downEv.payload?.position?.z ?? 0, 3, 0.01),
     'position crosses as {x,y,z}');
  ok(revEv.payload?.by?.netId === 5, 'playerRevived names the reviver by netId');
  ok(revEv.payload?.player?.netId === 4, 'playerRevived names the victim by netId');
  // Nothing live survives the crossing: JSON is the whole proof.
  ok(JSON.stringify(evs[2]?.payload ?? {}).length < 120, 'playerBledOut is a small plain payload');
}

// --- 4. the receiving end ---------------------------------------------------

/** A predicted local player, as `_applyAuthoritativeHealth` sees one. */
function localPlayer() {
  return {
    maxHealth: 100, health: 100, shield: 0, maxShield: 50,
    alive: true, downed: false, bleedout: 0, revive: 0, sinceDamage: 99,
    deaths: 0, onDeath() { this.alive = false; this.deaths++; },
  };
}

console.log('the client\'s own survivor reads state 3 as downed, not dead');
{
  const client = new NetClient();
  const p = localPlayer();
  client._applyAuthoritativeHealth(p, { state: ESTATE.DOWNED, healthFrac: 0.5, shieldFrac: 0 });
  ok(p.downed === true, 'downed === true');
  ok(p.alive === true, 'alive === true');
  ok(p.deaths === 0, 'onDeath was not called');
  ok(p.health === 0, 'health is the zero the host holds, not the clock');
  ok(near(p.bleedout, REVIVE.BLEEDOUT_S * 0.5, 0.01), `bleedout is decoded from the clock (got ${p.bleedout})`);

  // ALIVE afterwards clears it, and the fraction is health again.
  client._applyAuthoritativeHealth(p, { state: ESTATE.ALIVE, healthFrac: 0.4, shieldFrac: 0 });
  ok(p.downed === false, 'ALIVE after DOWNED clears downed');
  ok(p.bleedout === 0 && p.revive === 0, 'and both clocks are cleared');
  ok(near(p.health, 40, 1e-6), `health is the fraction again (got ${p.health})`);
  ok(p.alive === true, 'still alive');
}

console.log('DEAD still dies');
{
  const client = new NetClient();
  const p = localPlayer();
  client._applyAuthoritativeHealth(p, { state: ESTATE.DEAD, healthFrac: 0, shieldFrac: 0 });
  ok(p.deaths === 1, 'onDeath was called exactly once');
  ok(p.alive === false, 'alive === false');
  ok(p.downed === false, 'not downed');
}

console.log('a remote PlayerView fed state 3 is downed and alive, and stands back up on state 0');
{
  const factories = new Map();
  const stubClient = { registerViewFactory: (k, f) => factories.set(k, f) };
  const ctx = { scene: new THREE.Scene() };
  installViewFactories(stubClient, ctx);
  const view = factories.get(EKIND.PLAYER)({ x: 0, y: 0, z: 0, yaw: 0 }, ctx);

  view.applyNetState({ x: 0, y: 0, z: 0, yaw: 0, healthFrac: 0.5, state: ESTATE.DOWNED }, 1 / 60);
  ok(view.downed === true, 'downed === true');
  ok(view.alive === true, 'alive === true');
  ok(view.health === 0, 'the health bar reads zero, not the clock');
  ok(near(view.bleedoutFrac, 0.5, 1e-6), `bleedoutFrac carries the clock (got ${view.bleedoutFrac})`);
  ok(view.group.rotation.x !== 0, 'the pawn is visibly no longer upright');

  view.applyNetState({ x: 0, y: 0, z: 0, yaw: 0, healthFrac: 0.4, state: ESTATE.ALIVE }, 1 / 60);
  ok(view.downed === false, 'ALIVE after DOWNED clears downed');
  ok(view.alive === true, 'and it is alive');
  ok(near(view.health, 40, 1e-6), `health is the fraction again (got ${view.health})`);
  ok(view.group.rotation.x === 0, 'the pose is released');

  view.applyNetState({ x: 0, y: 0, z: 0, yaw: 0, healthFrac: 0, state: ESTATE.DEAD }, 1 / 60);
  ok(view.alive === false, 'DEAD is still death');
}

console.log('NetClient.update does not mistake DOWNED for the start of a death');
{
  const client = new NetClient();
  client.connected = true;
  client.myNetId = 1;
  const record = { x: 0, y: 0, z: 0, yaw: 0, healthFrac: 0.5, state: ESTATE.DOWNED };
  const live = new Map([[2, { kind: EKIND.PLAYER }]]);
  client.buffer = { liveIds: () => live, sample: () => record };
  const view = { netId: 2, deaths: 0, applied: 0, onDeath() { this.deaths++; }, applyNetState() { this.applied++; } };
  client.views.set(2, view);
  const ctx = { player: null };

  client.update(ctx, 1 / 60);
  ok(!view.dying, 'DOWNED did not start the dying animation');
  ok(view.deaths === 0, 'onDeath was not called');
  ok(view.applied === 1, 'the record was still applied to the view');

  record.state = ESTATE.DEAD;
  client.update(ctx, 1 / 60);
  ok(view.dying === true, 'DEAD does start it');
  ok(view.deaths === 1, 'onDeath was called once');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
