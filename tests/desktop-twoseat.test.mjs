/**
 * The two-seat test mode (#241), in plain node.
 *
 *   node tests/desktop-twoseat.test.mjs
 *
 * What this CAN prove: the gate (flags alone are inert), the record's shape and
 * verdict rule, that every wait is capped and the cap is written down, that the
 * joiner's invite travels 503 -> the pump -> `joinDelivery` (the real modules,
 * with a fake dispatch), and the negative control: a joiner with no invite
 * fails inside its cap with a failing record on disk.
 *
 * What it CANNOT prove: that a live Steam client delivers 503, or that two real
 * accounts form a Conversation. That is #13's sitting via #242.
 */
import { readFileSync } from 'node:fs';
import {
  parseTwoSeat, runSeat, finalize, capsFor, REQUIRED_CHECKS, TWOSEAT_SCHEMA,
} from '../desktop/twoseat.mjs';
import { drainCallbacks, LOBBY_INVITE } from '../desktop/steam-callbacks.mjs';
import { createJoinDelivery } from '../desktop/join-delivery.mjs';
import { createSeatDriver, seatIdentity } from '../desktop/twoseat-driver.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const PEER = '76561190000000002';
const ME = '76561190000000001';
const LOBBY = '109775240000000001';
const REC = 'C:\\seat\\record.json';
const hostArgv = ['electron', '.', '--twoseat=host', '--twoseat-run-id', 'r1', '--twoseat-record', REC,
  '--twoseat-play-s', '0.3', '--twoseat-cap-s', '3', '--twoseat-peer', PEER];
const joinerArgv = (cap = '3') => ['electron', '.', '--twoseat=joiner', '--twoseat-run-id', 'r1',
  '--twoseat-record', REC, '--twoseat-play-s', '0.3', '--twoseat-cap-s', cap];
const ON = { OLLIE_TWOSEAT: '1' };

/** Deps where every step succeeds; a test overrides the one it is about. */
function fakeDeps(over = {}) {
  const writes = [];
  const deps = {
    writes,
    writeRecord: (p, json) => { writes.push({ p, rec: JSON.parse(json) }); },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    identity: () => ({ available: true, appId: 5150570, steamId: ME }),
    rendererReady: () => true,
    listFriends: () => [{ steamId: PEER }],
    hostLobby: () => {},
    heldLobby: () => LOBBY,
    invite: () => true,
    lobbyMembers: () => [ME, PEER],
    heardInvite: () => ({ lobbyId: LOBBY, fromSteamId: PEER }),
    formed: async () => ({ ok: true, detail: 'formed' }),
    startRun: () => true,
    play: async () => ({ ok: true, detail: 'played' }),
    ...over,
  };
  return deps;
}
const last = (d) => d.writes[d.writes.length - 1].rec;

console.log('\n-- the gate: flags without OLLIE_TWOSEAT=1 are inert');
{
  ok(parseTwoSeat(hostArgv, {}) === null, 'host flags, no env -> no seat');
  ok(parseTwoSeat(joinerArgv(), {}) === null, 'joiner flags, no env -> no seat');
  ok(parseTwoSeat(hostArgv, { OLLIE_TWOSEAT: '0' }) === null, 'OLLIE_TWOSEAT=0 -> no seat');
  ok(parseTwoSeat(hostArgv, { OLLIE_TWOSEAT: 'true' }) === null, 'only the literal 1 opens it');
  ok(parseTwoSeat(['electron', '.'], ON) === null, 'env without --twoseat -> no seat (a player with a stray env var)');
  const cfg = parseTwoSeat(hostArgv, ON);
  ok(cfg && cfg.seat === 'host' && cfg.runId === 'r1' && cfg.peer === PEER && cfg.capS === 3,
    'env + flags -> the host seat, as asked');

  // main.mjs reaches a seat through parseTwoSeat and nothing else, and 503 is
  // wired to nothing unless a joiner seat exists.
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  ok(/const twoseat = parseTwoSeat\(process\.argv, process\.env\);/.test(main), 'main.mjs parses the seat from argv AND env');
  ok((main.match(/parseTwoSeat\(/g) || []).length === 1, 'and that is the only parse');
  ok(/onLobbyInvite: twoseat\?\.seat === 'joiner' \? onSeatInvite : null/.test(main),
    'the 503 handler is null unless a joiner seat was parsed');
  const driverAt = main.indexOf('createSeatDriver({');
  ok(driverAt > 0 && /if \(twoseat\) \{\s*const driver = $/.test(main.slice(driverAt - 60, driverAt)),
    'the driver is constructed only inside if (twoseat)');
}

console.log('\n-- malformed seats are refused, with the reason recorded');
{
  const noPeer = parseTwoSeat(hostArgv.slice(0, -2), ON);
  ok(noPeer?.error && /peer/.test(noPeer.error), 'host without --twoseat-peer is an error');
  ok(parseTwoSeat(joinerArgv('0.1'), ON)?.error, 'a cap no larger than the play window is an error');
  ok(parseTwoSeat(['--twoseat=joiner', '--twoseat-run-id', 'r', '--twoseat-record', 'rel.json',
    '--twoseat-play-s', '1', '--twoseat-cap-s', '5'], ON)?.error, 'a relative record path is an error');
  const d = fakeDeps();
  const code = await runSeat(noPeer, d);
  ok(code === 1 && last(d).allPass === false && /peer/.test(last(d).fatal), 'and runSeat writes it as a failing record, exit 1');
}

console.log('\n-- the record: placeholder first, then the verdict');
{
  const d = fakeDeps();
  const code = await runSeat(parseTwoSeat(hostArgv, ON), d);
  const first = d.writes[0].rec;
  ok(first.aborted === 'run in progress' && first.allPass === false && first.checks.length === 0
    && first.schema === TWOSEAT_SCHEMA && first.runId === 'r1' && first.seat === 'host',
    'the first write is the failing placeholder');
  const rec = last(d);
  ok(code === 0 && rec.allPass === true, `a clean host run passes and exits 0 (code ${code})`);
  ok(REQUIRED_CHECKS.host.every((id) => rec.checks.some((c) => c.id === id && c.pass)), 'every required host check is present and passed');
  for (const k of ['schema', 'runId', 'seat', 'appId', 'steamId', 'peerSteamId', 'when', 'flags', 'bounded', 'checks', 'fatal', 'allPass']) {
    ok(k in rec, `record carries ${k}`);
  }
  ok(rec.appId === 5150570 && rec.steamId === ME && rec.peerSteamId === PEER && rec.fatal === null, 'identity fields filled');
  const b = capsFor({ capS: 3, playS: 0.3 });
  ok(JSON.stringify(rec.bounded) === JSON.stringify(b), 'bounded is every cap in use');
  ok(Object.values(rec.bounded).every((v) => typeof v === 'number' && v > 0 && v <= 3), 'and every inner cap sits inside the overall cap');
}

console.log('\n-- a missing or failed required check means allPass=false');
{
  const partial = finalize({ seat: 'joiner' }, REQUIRED_CHECKS.joiner.slice(0, -1).map((id) => ({ id, pass: true, detail: '' })), null);
  ok(partial.allPass === false, 'three of four joiner checks passing is not a pass');
  ok(partial.checks.find((c) => c.id === 'play-window')?.detail === 'not reached', 'and the missing one is written as not reached');
  const full = finalize({ seat: 'joiner' }, REQUIRED_CHECKS.joiner.map((id) => ({ id, pass: true, detail: '' })), null);
  ok(full.allPass === true, 'all four is a pass');
  ok(finalize({ seat: 'joiner' }, full.checks, 'boom').allPass === false, 'a fatal fails the record regardless');

  const d = fakeDeps({ invite: () => false });
  const code = await runSeat(parseTwoSeat(hostArgv, ON), d);
  const rec = last(d);
  ok(code === 1 && !rec.allPass && rec.checks.find((c) => c.id === 'invite-sent')?.pass === false,
    'a refused invite fails invite-sent and the run');
  ok(rec.checks.find((c) => c.id === 'peer-joined')?.detail === 'not reached', 'and nothing after it is claimed');

  const absent = fakeDeps({ listFriends: () => [{ steamId: '1' }] });
  await runSeat(parseTwoSeat(hostArgv, ON), absent);
  ok(last(absent).checks.find((c) => c.id === 'friends-listed')?.pass === false, 'a peer missing from the friends list fails friends-listed');

  const noSteam = fakeDeps({ identity: () => ({ available: false, appId: null, steamId: null }) });
  ok(await runSeat(parseTwoSeat(hostArgv, ON), noSteam) === 1 && /Steam/.test(last(noSteam).fatal), 'no Steam is fatal');
}

console.log('\n-- joiner: 503 -> pump -> joinDelivery -> the menu, with the real modules');
{
  // What main.mjs wires: a heard invite is remembered AND offered at the door.
  let seatInvite = null;
  let held = null;
  const delivery = createJoinDelivery({
    // The "menu": acceptSteamInvite -> joinViaSteam -> steam:join-lobby, which
    // adds the lobby to main's held set.
    push: (lobbyId) => { held = lobbyId; },
    windowAlive: () => true,
  });
  delivery.collect();   // the page's bindSteam has subscribed
  const onSeatInvite = (inv) => { seatInvite = inv; delivery.offer(inv.lobbyId); };

  const payload = Buffer.alloc(24);
  payload.writeBigUInt64LE(BigInt(PEER), 0);
  payload.writeBigUInt64LE(BigInt(LOBBY), 8);
  payload.writeBigUInt64LE(5150570n, 16);
  const queue = [{ id: 503, data: payload }];
  const dispatch = { runFrame() {}, next: () => queue.shift() ?? null, free() {} };
  // Arrives while the seat is already waiting.
  setTimeout(() => drainCallbacks(dispatch, () => {}, () => {}, () => false, onSeatInvite), 60);

  const d = fakeDeps({ heardInvite: () => seatInvite, heldLobby: () => held });
  const code = await runSeat(parseTwoSeat(joinerArgv(), ON), d);
  const rec = last(d);
  ok(code === 0 && rec.allPass, `a joiner that hears 503 joins, forms, plays, passes (code ${code})`);
  ok(rec.peerSteamId === PEER, 'the inviter from the 503 payload becomes peerSteamId');
  ok(rec.checks.find((c) => c.id === 'lobby-joined')?.detail === `holding ${LOBBY}`, 'the lobby joined is the one invited to');
  ok(LOBBY_INVITE === 503, 'LobbyInvite_t is k_iSteamMatchmakingCallbacks (500) + 3');
}

console.log('\n-- negative control: no invite fails inside the cap, record written');
{
  const d = fakeDeps({ heardInvite: () => null, heldLobby: () => null });
  const t0 = Date.now();
  const code = await runSeat(parseTwoSeat(joinerArgv('1.5'), ON), d);
  const took = (Date.now() - t0) / 1000;
  const rec = last(d);
  ok(code === 1 && rec.allPass === false, 'exit 1, allPass false');
  ok(took < 1.5 + 0.75, `returned inside its cap (${took.toFixed(2)} s against 1.5 s)`);
  const heard = rec.checks.find((c) => c.id === 'invite-heard');
  ok(heard?.pass === false && /no LobbyInvite_t inside 1\.2 s/.test(heard.detail),
    `invite-heard fails on its OWN cap, not the overall one (${heard?.detail})`);
  ok(rec.bounded.inviteS === 1.2 && rec.fatal === null, 'and that cap is the one in the record');
  ok(!('aborted' in rec) && d.writes.length === 2, 'the final record replaced the placeholder');
}

console.log('\n-- the overall cap wins over a step that never returns');
{
  const d = fakeDeps({ formed: () => new Promise(() => {}) });
  const t0 = Date.now();
  const code = await runSeat(parseTwoSeat(joinerArgv('1'), ON), d);
  ok(code === 1 && /overall cap of 1 s/.test(last(d).fatal), `a hung step ends at the overall cap (${last(d).fatal})`);
  ok(Date.now() - t0 < 1750, 'on time');
}

console.log('\n-- steamId is the ACCOUNT SteamID64, the sockets identity travels apart (fix wave 1)');
{
  // The numbers a real run produced: getIdentity() is not the account id.
  const client = {
    getStatus: () => ({ steamId: '76561198037383365' }),
    networkingSockets: { getIdentity: () => '331217728859799560' },
  };
  const id = seatIdentity(client, { available: true, appId: 5150570 });
  ok(/^7656119\d{10}$/.test(id.steamId ?? ''), `steamId is a 17-digit 7656119... account id (${id.steamId})`);
  ok(id.socketsIdentity === '331217728859799560', 'and the sockets identity is kept, in its own field');
  const wrong = seatIdentity({ getStatus: () => ({ steamId: '331217728859799560' }) }, { available: true });
  ok(wrong.steamId === null, 'a non-account number is never passed off as steamId');

  const d = fakeDeps({ identity: () => id });
  await runSeat(parseTwoSeat(hostArgv, ON), d);
  const rec = last(d);
  ok(/^7656119\d{10}$/.test(rec.steamId ?? '') && rec.socketsIdentity === '331217728859799560',
    'the record carries both, under their own names');
}

console.log('\n-- the play window judges the link, not whether a survivor died (fix wave 1)');
{
  /** A webContents whose page reports the scripted states in turn. */
  const fakeWc = (states) => {
    let i = 0;
    return {
      executeJavaScript: async () => states[Math.min(i++, states.length - 1)],
      sendInputEvent: () => {},
    };
  };
  const st = (tick, over = {}) => ({ mode: 'client', connected: true, myNetId: 2, playerCount: null, tick, alive: true, ...over });
  const play = (states) => createSeatDriver({ webContents: fakeWc(states) })._deps.play(200);

  const died = await play([st(10), st(20, { alive: false }), st(30, { alive: false })]);
  ok(died.ok === true && /alive=false \(not judged\)/.test(died.detail), `a death on a live link passes, and is recorded (${died.detail})`);
  const dropped = await play([st(10), st(20, { connected: false }), st(20, { connected: false })]);
  ok(dropped.ok === false && /session dropped/.test(dropped.detail), 'a dropped connection still fails');
  const stalled = await play([st(10), st(10), st(10)]);
  ok(stalled.ok === false, 'ticks that never advance still fail');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
