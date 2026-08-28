/**
 * The signature economy across the wire (issue #167).
 *
 *   node tests/corruption-replication.test.mjs
 *
 * One real host-side `Corruption`, one real client-side `Corruption`, and the
 * real `NetHost` / `NetClient` message paths between them — the bytes are
 * encoded and decoded, not handed across as an object. What is stubbed is the
 * transport and the world around the two systems; the axis under test is
 * whether the two machines agree, and the answer has to survive the encoder.
 *
 * The four claims:
 *   1. Every authoritative move — feed, bleed, mint, spend, sanctuary open and
 *      close, band crossing, ruin — lands on the client with identical reads.
 *   2. A late joiner starts from a full block, not from zero.
 *   3. The client's instance cannot be mutated by gameplay code, and the
 *      host's cannot be mutated by the wire.
 *   4. The joiner's route high-water band comes across even when the crossing
 *      happened before it existed.
 */
import { Corruption } from '../src/systems/Corruption.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { PROTOCOL_VERSION, Writer, writeWorld } from '../src/net/Protocol.js';
import { MOTE } from '../src/data/bandBoons.js';
// The real predicate the toast is classified by — imported, never restated, so
// a change to what counts as a mint reaches this test instead of passing it.
import { isMint } from '../src/ui/HUD.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(authority) {
  const listeners = new Map();
  const ctx = {
    authority, time: 0, seed: 4242, paused: false,
    events: {
      emit(name, p) { for (const fn of (listeners.get(name) || []).slice()) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    combat: { entities: [] },
    progression: { stageIndex: 0, corruptionPeakBand: 0 },
  };
  // Progression.js:170-173 verbatim in behaviour — the high-water band is a
  // derived thing on *both* machines, and stubbing it away would let claim 4
  // pass for the wrong reason. Present on the client too, so the joiner has
  // every chance to derive the band locally and the field on the wire is only
  // earning its keep where derivation genuinely cannot reach.
  ctx.events.on('corruptionBand', (e) => {
    const b = e?.band;
    if (Number.isInteger(b) && b > ctx.progression.corruptionPeakBand) ctx.progression.corruptionPeakBand = b;
  });
  return ctx;
}

/**
 * A host with a real `Corruption`, a stub transport that records every
 * broadcast, and a client whose own real `Corruption` those bytes are fed to.
 */
function makePair() {
  const sent = [];
  const host = new NetHost({ maxPlayers: 4 });
  host.transport = {
    onPeer: null, onPeerLeave: null,
    broadcastEvent: (b) => sent.push(b),
    broadcastState() {}, close() {},
  };
  const hostCtx = makeCtx(true);
  const hostCor = new Corruption();
  hostCor.init(hostCtx);
  host.init(hostCtx);
  // One admitted peer, so the host has somebody to talk to.
  const peerSent = [];
  const peer = { id: 1, sendEvent: (b) => peerSent.push(b), sendState() {}, pumpSim() {}, close() {} };
  host.clients.set(1, {
    peer, pawn: null, inputs: [], lastTick: 0, name: 'Player 2',
    joinTick: 0, joinedAt: 0, helloSeen: true, survivorId: null,
  });

  const client = new NetClient();
  const clientCtx = makeCtx(false);
  const clientCor = new Corruption();
  clientCor.init(clientCtx);
  client.ctx = clientCtx;

  /** Run the host's frame and deliver whatever it decided to say. */
  const settle = () => {
    host.update(hostCtx, 1 / 60);
    while (sent.length) client._handleMessage(sent.shift());
  };
  return { host, hostCtx, hostCor, client, clientCtx, clientCor, settle, peer, peerSent };
}

const player = { isPlayer: true, alive: true };

/** Everything the ticket says both machines must agree about. */
const readout = (c) => ({
  world: Math.round(c.world * 1e4) / 1e4,
  band: c.band,
  peak: Math.round(c.peak * 1e4) / 1e4,
  marks: c.marks,
  motes: c.motes,
  warded: Math.round(c.warded * 1e4) / 1e4,
  ruined: c.ruined,
  sanctified: c.sanctified,
});
const same = (a, b) => JSON.stringify(readout(a)) === JSON.stringify(readout(b));
const show = (c) => JSON.stringify(readout(c));

console.log(`protocol version is ${PROTOCOL_VERSION}`);
ok(PROTOCOL_VERSION >= 9, 'bumped past 8 so a pre-replication peer is refused rather than silently zeroed');

console.log('\n1. every authoritative move converges');
{
  const p = makePair();
  p.hostCtx.player = player;

  // Feed hard enough to cross bands and mint marks.
  p.hostCor.feed(player, 300);
  p.settle();
  ok(same(p.hostCor, p.clientCor), `after a 300 feed: host ${show(p.hostCor)} client ${show(p.clientCor)}`);
  ok(p.clientCor.band > 0, `the client's band actually left zero (${p.clientCor.band})`);
  ok(p.clientCor.marks === p.hostCor.marks && p.hostCor.marks > 0,
    `marks minted and crossed (${p.hostCor.marks} / ${p.clientCor.marks})`);

  // Bleed — warding, and the mote mint on the other side of the same act.
  p.hostCor.bleed(player, 250);
  p.settle();
  ok(same(p.hostCor, p.clientCor), `after a 250 bleed: host ${show(p.hostCor)} client ${show(p.clientCor)}`);
  ok(p.clientCor.warded === p.hostCor.warded && p.hostCor.warded > 0,
    `warded progress crossed (${p.hostCor.warded} / ${p.clientCor.warded})`);
  ok(p.clientCor.band < 2, `the band walked back down on the client too (${p.clientCor.band})`);

  // Spending both currencies.
  const marksBefore = p.hostCor.marks;
  if (marksBefore > 0) p.hostCor.spendMarks(1);
  p.settle();
  ok(p.clientCor.marks === p.hostCor.marks && p.hostCor.marks === marksBefore - 1,
    `a spent mark crossed (${p.hostCor.marks} / ${p.clientCor.marks})`);

  const motesBefore = p.hostCor.motes;
  if (motesBefore > 0) p.hostCor.spendMotes(1);
  p.settle();
  ok(p.clientCor.motes === p.hostCor.motes && p.hostCor.motes === motesBefore - 1,
    `a spent mote crossed (${p.hostCor.motes} / ${p.clientCor.motes})`);

  // Sanctuary: the window, then its close.
  p.hostCor.sanctuary(MOTE.sanctuarySeconds);
  p.settle();
  ok(p.clientCor.sanctified && p.hostCor.sanctified, 'the sanctuary window opened on both sides');
  ok(p.clientCor.priceOf(50) === 0 && p.hostCor.priceOf(50) === 0,
    'and both quote a free chest inside it — the prompt reads the same accessor');

  p.hostCor.update(p.hostCtx, MOTE.sanctuarySeconds + 1);
  p.settle();
  ok(!p.hostCor.sanctified && !p.clientCor.sanctified, 'the window closed on both sides');
  ok(p.clientCor.priceOf(50) === p.hostCor.priceOf(50) && p.hostCor.priceOf(50) > 0,
    `and the price came back on both (${p.hostCor.priceOf(50)} / ${p.clientCor.priceOf(50)})`);

  // Greed time — part of what a prompt quotes.
  p.hostCtx.events.emit('teleporterComplete', {});
  p.settle();
  ok(p.clientCor.greed && p.clientCor.priceOf(10) === p.hostCor.priceOf(10),
    `greed time crossed, so the client quotes the dear price (${p.clientCor.priceOf(10)})`);

  // Ruin — the one-way door.
  p.hostCor.ruin();
  p.settle();
  ok(p.clientCor.ruined && p.hostCor.ruined, 'ruin crossed');
  ok(same(p.hostCor, p.clientCor), `and the whole readout still agrees: ${show(p.clientCor)}`);
}

console.log('\n2. a late joiner initialises from the block, not from zero');
{
  const p = makePair();
  p.hostCtx.player = player;
  p.hostCor.feed(player, 420);
  p.hostCor.bleed(player, 60);
  p.hostCor.sanctuary(MOTE.sanctuarySeconds);
  p.settle();   // drains what the already-present peer heard

  // A second peer arrives now, long after the economy left zero. `_onPeer`
  // is the real join path: it sends WELCOME and then the world block.
  const joinerBytes = [];
  const joiner = { id: 7, sendEvent: (b) => joinerBytes.push(b), sendState() {}, pumpSim() {}, close() {}, onMessage: null, onClose: null };
  p.host._onPeer(joiner);

  const late = new NetClient();
  const lateCtx = makeCtx(false);
  const lateCor = new Corruption();
  lateCor.init(lateCtx);
  late.ctx = lateCtx;
  ok(lateCor.world === 0, `the joiner starts blind (world ${lateCor.world}) — this is what the block has to fix`);
  for (const b of joinerBytes) late._handleMessage(b);

  ok(same(p.hostCor, lateCor), `first rendered values match the host: host ${show(p.hostCor)} joiner ${show(lateCor)}`);
  ok(lateCor.sanctified, 'the open sanctuary window came with it');
  ok(lateCor.priceOf(50) === 0, 'so the joiner quotes the same free chest the host does');
}

console.log('\n3. the write paths are one-way');
{
  const p = makePair();
  p.hostCtx.player = player;
  p.hostCor.feed(player, 100);
  p.settle();
  const before = show(p.clientCor);

  // A buggy or hostile client calling every authoritative mutator it can reach.
  p.clientCor.feed(player, 9999);
  p.clientCor.bleed(player, 9999);
  p.clientCor.spendMarks(99);
  p.clientCor.spendMotes(99);
  p.clientCor.sanctuary(99);
  p.clientCor.ruin();
  p.clientCor.seed({ x: 1, z: 1 }, 5);
  ok(show(p.clientCor) === before, `a client's own mutators are inert (${show(p.clientCor)})`);
  ok(p.clientCor.seeds.length === 0, 'including the seed list');
  ok(p.hostCor.world === 100, `and the host's authoritative world never moved (${p.hostCor.world})`);

  // The guard can fail: the same calls on the *host's* instance do move it,
  // so "nothing happened" above is the authority gate and not a dead object.
  const hostBefore = p.hostCor.world;
  p.hostCor.feed(player, 50);
  ok(p.hostCor.world > hostBefore,
    `the same calls on the host DO move it (${hostBefore} -> ${p.hostCor.world}) — the gate is live, not inert`);

  // And the wire cannot write a host: `applyNetState` refuses with authority.
  const hostReadout = show(p.hostCor);
  const refused = p.hostCor.applyNetState({
    world: 1, band: 3, peak: 999, spent: 0, warded: 999, motesSpent: 0,
    sanctuaryT: 99, ruined: true, greed: true,
  });
  ok(refused === false && show(p.hostCor) === hostReadout,
    `a world block aimed at the host is refused (${show(p.hostCor)})`);
  // The mirror: the identical call on a client is accepted, so the refusal
  // above is the authority check and not a malformed argument.
  ok(p.clientCor.applyNetState({
    world: 1, band: 3, peak: 999, spent: 0, warded: 999, motesSpent: 0,
    sanctuaryT: 99, ruined: true, greed: true,
  }) === true && p.clientCor.world === 1,
  'while the identical block on a client is accepted — the refusal is the gate');
}

console.log("\n4. the route's high-water band crosses");
{
  const p = makePair();
  p.hostCtx.player = player;
  // Cross deep, then walk all the way back down before anyone joins: the
  // crossing left no event a joiner could have heard.
  p.hostCor.feed(player, 900);
  const peakBand = p.hostCtx.progression.corruptionPeakBand;
  p.hostCor.bleed(player, 900);
  p.settle();
  ok(peakBand > 0 && p.hostCor.band === 0, `host walked back to band 0 with a peak band of ${peakBand}`);

  const joinerBytes = [];
  const joiner = { id: 8, sendEvent: (b) => joinerBytes.push(b), sendState() {}, pumpSim() {}, close() {}, onMessage: null, onClose: null };
  p.host._onPeer(joiner);
  const late = new NetClient();
  const lateCtx = makeCtx(false);
  const lateCor = new Corruption();
  lateCor.init(lateCtx);
  late.ctx = lateCtx;
  for (const b of joinerBytes) late._handleMessage(b);
  ok(lateCtx.progression.corruptionPeakBand === peakBand,
    `the joiner's route forecast knows the run was there (${lateCtx.progression.corruptionPeakBand} vs ${peakBand})`);
  ok(lateCor.peak === p.hostCor.peak && lateCor.marks === p.hostCor.marks,
    `and the mint survives the cleansing on both sides (${lateCor.marks} marks)`);
}

console.log('\n5. a replicated spend is a spend, not a mint');
{
  const p = makePair();
  p.hostCtx.player = player;
  const purse = [];
  p.clientCtx.events.on('voidMarksChanged', (e) => purse.push(['mark', e]));
  p.clientCtx.events.on('argentMotesChanged', (e) => purse.push(['mote', e]));

  p.hostCor.feed(player, 400);
  p.hostCor.bleed(player, 200);
  p.settle();
  ok(purse.length > 0 && purse.every(([, e]) => isMint(e)),
    `the gains across the wire all classify as mints (${purse.length} events)`);

  purse.length = 0;
  const marksBefore = p.hostCor.marks;
  ok(p.hostCor.spendMarks(3) === true, `host spends 3 marks (${marksBefore} in hand)`);
  p.settle();
  const markEvents = purse.filter(([k]) => k === 'mark');
  ok(markEvents.length === 1, `the client hears exactly one mark event (${markEvents.length})`);
  ok(markEvents.every(([, e]) => e.spent === 3),
    `carrying the real charge (spent=${markEvents.map(([, e]) => e.spent).join(',')}, want 3)`);
  ok(markEvents.every(([, e]) => !isMint(e)),
    'and HUD.isMint refuses it — no "mark minted" toast, no mint sting on the guest');
  ok(p.clientCor.marks === marksBefore - 3, `while the purse still went down (${p.clientCor.marks})`);

  purse.length = 0;
  const motesBefore = p.hostCor.motes;
  ok(p.hostCor.spendMotes(1) === true, `host spends a mote (${motesBefore} in hand)`);
  p.settle();
  const moteEvents = purse.filter(([k]) => k === 'mote');
  ok(moteEvents.length === 1 && moteEvents[0][1].spent === 1 && !isMint(moteEvents[0][1]),
    `the mote spend crosses as a spend (spent=${moteEvents[0]?.[1]?.spent})`);

  // The guard can fail: a genuine mint through the same path still reads as one,
  // so the refusal above is the charge and not a blanket "never a mint".
  purse.length = 0;
  p.hostCor.bleed(player, 200);
  p.settle();
  ok(purse.some(([, e]) => isMint(e)),
    'a genuine mint through the same path still classifies as a mint');
}

console.log('\n6. an ended sanctuary is never re-announced');
{
  const p = makePair();
  p.hostCtx.player = player;
  const opens = [];
  const ends = [];
  p.clientCtx.events.on('voidSanctuary', (e) => opens.push(e));
  p.clientCtx.events.on('voidSanctuaryEnd', (e) => ends.push(e));

  p.hostCor.sanctuary(MOTE.sanctuarySeconds);
  p.settle();
  ok(opens.length === 1, `the window is announced once (${opens.length})`);

  // The client's own clock runs out a hair ahead of the host's — the ordinary
  // case, since it ticks locally and the host's block is a frame behind.
  p.clientCor.update(p.clientCtx, MOTE.sanctuarySeconds + 0.01);
  ok(ends.length === 1 && !p.clientCor.sanctified, 'the client closes its own window locally');

  // Now an unrelated change flushes while the host still holds a fraction of a
  // second. Before the epoch gate this re-announced "0s of free ground".
  p.hostCor.update(p.hostCtx, MOTE.sanctuarySeconds - 0.2);
  p.hostCor.feed(player, 10);
  p.settle();
  ok(opens.length === 1,
    `a residual window does not re-open it on the client (${opens.length} announcements, want 1)`);

  // Let it close for real, then have the altar genuinely open another: the gate
  // must still let a real window through.
  p.hostCor.update(p.hostCtx, 1);
  p.settle();
  p.hostCor.sanctuary(MOTE.sanctuarySeconds);
  p.settle();
  ok(opens.length === 2, `a genuinely new window IS announced (${opens.length}, want 2)`);
  ok(p.clientCor.sanctified && p.clientCor.priceOf(50) === 0, 'and the client is inside it');
}

console.log('\n7. the block is the size the docs claim');
{
  const bytes = writeWorld(new Writer(64), {
    world: 1, band: 1, peak: 1, spent: 1, warded: 1, motesSpent: 1,
    sanctuaryT: 1, sanctEpoch: 1, ruined: true, greed: true, peakBand: 1,
    alignment: 'corrupt',
  }).bytes();
  // 27 bytes through PROTOCOL_VERSION 14; 28 since #220 added the alignment
  // class byte (see Protocol.js's version-15 comment and NETCODE.md).
  ok(bytes.byteLength === 28, `WORLD is ${bytes.byteLength} bytes (NETCODE.md and Protocol.js say 28)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
