/**
 * Task 3 — the Steam signalling module.
 *
 *   node tests/steamlobby.test.mjs
 *
 * Two halves:
 *
 *  1. The chunk codec, pure. An SDP offer is a few kilobytes and a Steam lobby
 *     holds ONE ~8192-byte budget across every key and value it carries (see
 *     `MAX_LOBBY_TOTAL_BYTES`), so the offer travels as `sdp.offer.n` +
 *     `sdp.offer.0..k-1` and the whole record is measured before it is written.
 *     This half is the brief's specified test.
 *  2. The dance, against a fake `window.__STEAM__` that answers with the exact
 *     shapes task-2-report.md documents. The point of this half is the paths
 *     that are not the happy one: no bridge at all, `available: false`, a peer
 *     that writes garbage, a join abandoned mid-poll, and `Lobby.leave()`.
 *
 * Self-contained: no browser, no Electron, no Steam. `window` is created here,
 * which is exactly how the module's own guard is exercised rather than bypassed.
 */
import {
  chunkBlob, assembleBlob, pickMemberAnswer, steamAvailable, hostViaSteam, joinViaSteam, onSteamInvite, openSteamInvite,
  CHUNK_CHARS, MAX_LOBBY_TOTAL_BYTES, recordBytes, steamInviteNeedsConfirm, steamInviteBlocked,
  listSteamFriends, inviteSteamFriend, pendingSteamJoin,
} from '../src/net/SteamLobby.js';
import { Lobby } from '../src/net/Lobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// ---------------------------------------------------------------- the codec

/**
 * The largest blob `hostViaSteam` may post: grown until `chunkBlob`'s own record
 * crosses the budget, so it tracks CHUNK_CHARS and the key framing rather than
 * restating a number that could drift away from them.
 */
const BUDGET_FIT = (() => {
  let lo = 0, hi = MAX_LOBBY_TOTAL_BYTES;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (recordBytes(chunkBlob('sdp.offer', 'q'.repeat(mid))) > MAX_LOBBY_TOTAL_BYTES) hi = mid; else lo = mid;
  }
  return lo;
})();

console.log('-- chunkBlob / assembleBlob: a budget-filling blob survives the round trip');
{
  // Random-ish rather than random: the failure this guards against is an
  // off-by-one at a chunk boundary, and a fixed string makes that reproducible.
  let blob = '';
  let x = 123456789;
  while (blob.length < BUDGET_FIT) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    blob += String.fromCharCode(33 + (x % 94));
  }

  const pairs = chunkBlob('sdp.offer', blob);
  const map = new Map(pairs);
  const getter = (k) => (map.has(k) ? map.get(k) : null);

  ok(Array.isArray(pairs) && pairs.every((p) => Array.isArray(p) && p.length === 2), 'chunkBlob returns [key, value] pairs');
  ok(pairs.every(([, v]) => typeof v === 'string'), 'every value is a string -- lobby data carries no other type');
  ok(map.get('sdp.offer.n') === String(pairs.length - 1), `the count key names the part count (n=${map.get('sdp.offer.n')}, parts=${pairs.length - 1})`);
  ok(pairs.length - 1 === Math.ceil(blob.length / CHUNK_CHARS), 'the part count is ceil(len / cap) -- no wasted key');
  ok(pairs.every(([, v]) => v.length <= CHUNK_CHARS), `every part is within the ${CHUNK_CHARS}-char cap`);
  ok(pairs.every(([k]) => k.startsWith('sdp.')), 'every key is under the sdp. prefix the bridge requires');
  ok(assembleBlob(getter, 'sdp.offer') === blob, 'the assembled blob is identical to the original');
}

console.log('-- assembleBlob is null until every chunk is present');
{
  const blob = 'A'.repeat(3 * CHUNK_CHARS);
  const map = new Map(chunkBlob('sdp.offer', blob));
  const total = Number(map.get('sdp.offer.n'));
  ok(total >= 3, `precondition: the blob really is chunked (${total} parts)`);

  for (let i = 0; i < total; i++) {
    const held = new Map(map);
    held.delete(`sdp.offer.${i}`);
    const got = assembleBlob((k) => (held.has(k) ? held.get(k) : null), 'sdp.offer');
    ok(got === null, `withholding part ${i} yields null, not a truncated blob`);
  }

  const noCount = new Map(map);
  noCount.delete('sdp.offer.n');
  ok(assembleBlob((k) => (noCount.has(k) ? noCount.get(k) : null), 'sdp.offer') === null, 'no count key yields null -- the poll simply has not seen the write yet');
  ok(assembleBlob(() => null, 'sdp.offer') === null, 'an empty lobby yields null');
}

console.log('-- assembleBlob treats lobby data as untrusted');
{
  const bad = (n) => assembleBlob((k) => (k === 'sdp.offer.n' ? n : 'x'), 'sdp.offer');
  ok(bad('not-a-number') === null, 'a non-numeric count is null, not NaN chunks');
  ok(bad('-1') === null, 'a negative count is null');
  ok(bad('2.5') === null, 'a fractional count is null');
  ok(bad('1e3') === null, 'exponent notation is null -- Number() alone would have accepted it');
  ok(bad('999999') === null, 'an absurd count is refused rather than driving a million getter calls');
  ok(assembleBlob(() => { throw new Error('bridge blew up'); }, 'sdp.offer') === null, 'a throwing getter is null, not an exception out of the poll');
  ok(bad('0') === '', 'a zero count is the empty blob, which is the honest round trip of one');

  // The count guard has seven assertions above; the *part* guard had none. A
  // getter is only ever fed `getFullLobbyData`'s output today, but this is the
  // line that stops a loosened main-side contract turning a non-string into
  // "undefined" spliced into the middle of an SDP blob.
  for (const junk of [42, null, undefined, {}, ['x'], true]) {
    const got = assembleBlob((k) => (k === 'sdp.offer.n' ? '2' : (k === 'sdp.offer.0' ? 'A' : junk)), 'sdp.offer');
    ok(got === null, `a ${junk === null ? 'null' : typeof junk} part yields null rather than being stringified into the blob`);
  }
}

console.log('-- the two prefixes do not read each other');
{
  const map = new Map([...chunkBlob('sdp.offer', 'OFFER'), ...chunkBlob('sdp.other', 'OTHER')]);
  const getter = (k) => (map.has(k) ? map.get(k) : null);
  ok(assembleBlob(getter, 'sdp.offer') === 'OFFER', 'sdp.offer assembles its own');
  ok(assembleBlob(getter, 'sdp.other') === 'OTHER', 'sdp.other assembles its own');
}

// ------------------------------------------------------- inertness, proven

console.log('-- with no window at all (this is a node process), nothing reaches for Steam');
{
  ok(typeof globalThis.window === 'undefined', 'precondition: there is no window here');
  ok((await steamAvailable()) === false, 'steamAvailable() is false, and did not throw for the missing global');

  let threw = null;
  try { await hostViaSteam(null); } catch (e) { threw = e; }
  ok(threw instanceof Error, `hostViaSteam rejects with an Error (${threw && threw.message})`);
  ok(/Steam/i.test(threw.message), 'and the message names Steam, so the co-op screen can print it');

  threw = null;
  try { await joinViaSteam(null, '1'); } catch (e) { threw = e; }
  ok(threw instanceof Error, `joinViaSteam rejects with an Error (${threw && threw.message})`);
}

console.log('-- a window with no __STEAM__ (the web build) is the same story');
{
  globalThis.window = {};
  ok((await steamAvailable()) === false, 'steamAvailable() is false with a bare window');
  let threw = null;
  try { await hostViaSteam(null); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'hostViaSteam still rejects rather than reading undefined');
  delete globalThis.window;
}

// ------------------------------------------------------------- the fake bridge

/**
 * Answers with the exact shapes `task-2-report.md` documents for
 * `window.__STEAM__` — `{ error }` on refusal, decimal strings for ids, and
 * push subscriptions that hand back an unsubscribe function.
 */
function makeBridge(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const listeners = { signal: new Set(), fail: new Set(), join: new Set() };
  const b = {
    calls,
    listeners,
    data: {},
    async status() { calls.push(['status']); return { available: true, appId: 480, personaName: 'Tester', reason: null }; },
    async hostLobby(n) { calls.push(['hostLobby', n]); return { lobbyId: '109775241996081388' }; },
    async joinLobby(id) { calls.push(['joinLobby', id]); return { ok: true, lobbyId: id }; },
    async leaveLobby(id) { calls.push(['leaveLobby', id]); return { ok: true }; },
    async writeLobbyData(id, rec) { calls.push(['writeLobbyData', id, rec]); Object.assign(b.data, rec); return { ok: true }; },
    async getFullLobbyData(id) { calls.push(['getFullLobbyData', id]); return { data: { ...b.data } }; },
    async getLobbyOwner(id) { calls.push(['getLobbyOwner', id]); return { steamId: '76561198037383365' }; },
    // The answer leg. `members` stands in for Steam's per-member metadata: the
    // joiner writes into ITS OWN slot (the fake has one member, JOINER_ID) and
    // the host reads every slot back in one call. Modelling it as a store
    // rather than a spy is what lets the joiner-writes and host-reads blocks be
    // the same exchange rather than two assertions that agree by hand.
    members: {},
    async writeMemberData(id, rec) {
      calls.push(['writeMemberData', id, rec]);
      b.members[JOINER_ID] = { ...(b.members[JOINER_ID] ?? {}), ...rec };
      return { ok: true };
    },
    async collectMemberData(id, keys) {
      calls.push(['collectMemberData', id, keys]);
      const out = {};
      for (const [steamId, rec] of Object.entries(b.members)) {
        const picked = {};
        for (const k of keys) if (k in rec) picked[k] = rec[k];
        out[steamId] = picked;
      }
      return { members: out };
    },
    async sendSignal(to, payload) { calls.push(['sendSignal', to, payload]); return { ok: true }; },
    async startSignalListen(id) { calls.push(['startSignalListen', id]); return { ok: true }; },
    stopSignalListen: record('stopSignalListen'),
    async openInviteDialog(id) { calls.push(['openInviteDialog', id]); return { ok: true, overlay: true }; },
    async listFriends() {
      calls.push(['listFriends']);
      return { friends: [
        { steamId: '3', personaName: 'Zoe', personaState: 1, inGame: false },
        { steamId: '1', personaName: 'Ada', personaState: 0, inGame: false },
        { steamId: '2', personaName: 'Bo', personaState: 1, inGame: true },
        { steamId: '4', personaName: 'Ash', personaState: 1, inGame: false },
      ] };
    },
    async inviteFriend(lobbyId, steamId) { calls.push(['inviteFriend', lobbyId, steamId]); return { ok: true }; },
    async pendingJoin() { calls.push(['pendingJoin']); return { lobbyId: null }; },
    onSignal(cb) { listeners.signal.add(cb); return () => listeners.signal.delete(cb); },
    onSignalFail(cb) { listeners.fail.add(cb); return () => listeners.fail.delete(cb); },
    onJoinRequested(cb) { listeners.join.add(cb); return () => listeners.join.delete(cb); },
    ...overrides,
  };
  globalThis.window = { __STEAM__: b };
  return b;
}

/**
 * A stand-in offer blob at life size. Real ones measured out of Chromium with
 * this build's `rtcConfig()` are 915 chars with no ICE servers and 1098 with the
 * default STUN pair, so 1011 sits between them — and, unlike the 12 kB blob this
 * fixture used to carry, it is a blob Steam would actually store.
 */
const OFFER_FIXTURE = 'OFFER-BLOB-' + 'z'.repeat(1000);

/** The one joiner the fake bridge models, as a decimal Steam id. */
const JOINER_ID = '76561198000000002';

/** Fast poll settings, so a block that waits on the host's answer poll waits
 *  milliseconds rather than the second the shipping default takes. */
const FAST = { pollMs: 2, answerMs: 4000 };

/** Wait for a predicate, or give up. Returns whether it came true, so a caller
 *  asserts on the answer rather than on having waited. */
async function waitFor(pred, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return pred();
}

/** Write an answer into the joiner's member slot, the way `joinViaSteam` does. */
const putAnswer = (b, blob, steamId = JOINER_ID) => {
  b.members[steamId] = Object.fromEntries(chunkBlob('sdp.answer', blob));
};

/** Enough of `src/net/Lobby.js` to see what the dance does to it. */
function makeLobby(over = {}) {
  return {
    statuses: [],
    accepted: [],
    joined: [],
    _set(s, d) { this.statuses.push([s, d]); },
    async createInvite() { return { id: 1, blob: OFFER_FIXTURE }; },
    async joinManual(blob) { this.joined.push(blob); return 'ANSWER-BLOB'; },
    async acceptAnswer(blob) { this.accepted.push(blob); },
    ...over,
  };
}

console.log('-- __STEAM__ present but Steam did not answer: nothing is called');
{
  const b = makeBridge({ async status() { this.calls.push(['status']); return { available: false, reason: 'Steam is not running' }; } });
  const lobby = makeLobby();
  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error, `hostViaSteam rejects (${threw && threw.message})`);
  ok(!b.calls.some(([n]) => n === 'hostLobby'), 'no lobby was created');
  ok(lobby.statuses.length === 0, 'the Lobby was not touched at all');
  delete globalThis.window;
}

console.log('-- hosting: lobby, offer, and the answer that comes back on the joiner\'s member data');
{
  // REWRITTEN 2026-08-21 with the answer leg. The old block drove
  // `b.listeners.signal` -- a P2P packet callback -- and the leg it exercised no
  // longer has a carrier: `steamworks-ffi-node` binds no `ISteamNetworking` at
  // all. Every claim it made is made again here against the member-data poll,
  // and two are made MORE strongly: the malformed-answer sweep now goes through
  // `assembleBlob`, which refuses a half-written record the old `payload` check
  // could not have seen, and "a second answer cannot start a second exchange" is
  // now checked by leaving a second answer in place and proving the poll stopped
  // reading rather than by counting listeners.
  const b = makeBridge();
  const lobby = makeLobby();

  const res = await hostViaSteam(lobby, FAST);
  ok(res && res.lobbyId === '109775241996081388', `resolves { lobbyId } (${JSON.stringify(res)})`);

  const order = b.calls.map(([n]) => n).filter((n) => n !== 'status' && n !== 'collectMemberData');
  ok(JSON.stringify(order) === JSON.stringify(['hostLobby', 'writeLobbyData']),
    `the order is host -> write (${order.join(' -> ')})`);
  ok(b.calls.find(([n]) => n === 'hostLobby')[1] === 2, 'the lobby is opened for two');

  const written = b.calls.find(([n]) => n === 'writeLobbyData')[2];
  ok(Object.keys(written).every((k) => k.startsWith('sdp.offer.')), `only sdp.offer keys were written (${Object.keys(written).sort().join(',')})`);
  ok(assembleBlob((k) => (k in written ? written[k] : null), 'sdp.offer') === OFFER_FIXTURE,
    'the written chunks reassemble into exactly the invite blob');
  ok(lobby.statuses.some(([s2]) => s2 === 'roomOpen'), 'the Lobby reached roomOpen, the same status hostViaRelay sets');

  // The poll is the listener now, so its existence is the first thing to prove:
  // a host that advertised an offer and is not reading member data is the
  // advertised-but-deaf state this module refuses everywhere.
  ok(await waitFor(() => b.calls.some(([n]) => n === 'collectMemberData')),
    'the host is polling member data for an answer');
  const asked = b.calls.find(([n]) => n === 'collectMemberData');
  ok(asked[1] === '109775241996081388', `it polls the lobby it opened (${asked[1]})`);
  ok(Array.isArray(asked[2]) && asked[2][0] === 'sdp.answer.n' && asked[2].length === 5,
    `and names a bounded, constant key list (${JSON.stringify(asked[2])})`);

  // Garbage first: this is another player's member data, and the bridge is one
  // bug away from being wrong about it.
  const junk = [
    {},                                                   // written nothing yet
    { 'sdp.answer.n': '2', 'sdp.answer.0': 'half' },       // half-written
    { 'sdp.answer.n': 'lots', 'sdp.answer.0': 'x' },       // count is not a number
    { 'sdp.answer.n': '1e3', 'sdp.answer.0': 'x' },        // ...nor is this, to Number()
    { 'sdp.answer.n': '1', 'sdp.answer.0': '   ' },        // present but empty
    { 'sdp.answer.0': 'orphan' },                          // parts with no count
  ];
  for (const record of junk) {
    b.members[JOINER_ID] = record;
    const before = b.calls.filter(([n]) => n === 'collectMemberData').length;
    await waitFor(() => b.calls.filter(([n]) => n === 'collectMemberData').length > before + 1);
  }
  ok(lobby.accepted.length === 0, `no malformed member record reached acceptAnswer (${lobby.accepted.length})`);

  putAnswer(b, '  ANSWER-BLOB  ');
  ok(await waitFor(() => lobby.accepted.length === 1), 'the answer reached acceptAnswer');
  ok(lobby.accepted[0] === 'ANSWER-BLOB', `trimmed (${JSON.stringify(lobby.accepted)})`);

  // The answer is STILL SITTING THERE -- member data is not consumed by being
  // read -- so a poll that kept running would hand it over again and drag the
  // player into the same handshake twice.
  const ticks = b.calls.filter(([n]) => n === 'collectMemberData').length;
  await new Promise((r) => setTimeout(r, 30));
  ok(b.calls.filter(([n]) => n === 'collectMemberData').length === ticks,
    'the poll stopped on the answer it accepted, rather than reading it forever');
  ok(lobby.accepted.length === 1, 'so a second exchange never started');
  lobby._steamCleanup?.();
  delete globalThis.window;
}

console.log('-- the answer leg: a build that cannot carry it says so instead of half-working');
{
  // Both halves are feature-detected, and both refusals happen BEFORE anything
  // is advertised or joined. A host that opens a lobby it cannot hear an answer
  // on, or a joiner that reads an offer it cannot answer, is worse than one that
  // refused: the other player sees a live invite and a silence.
  const b = makeBridge();
  delete b.collectMemberData;
  const lobby = makeLobby();
  let threw = null;
  try { await hostViaSteam(lobby, FAST); } catch (e) { threw = e; }
  ok(threw instanceof Error, `hosting refuses with an Error (${threw && threw.message})`);
  ok(/cannot hear a joiner answer/.test(threw.message), 'and the sentence names what is missing');
  ok(/room code or an invite code/.test(threw.message), 'and offers the path that still works');
  ok(!b.calls.some(([n]) => n === 'hostLobby'), 'no Steam lobby was opened at all');
  delete globalThis.window;

  const b2 = makeBridge();
  const host = makeLobby();
  await hostViaSteam(host, FAST);          // the offer lands in b2.data
  delete b2.writeMemberData;
  const joiner = makeLobby();
  let threw2 = null;
  try { await joinViaSteam(joiner, '109775241996081388', { pollMs: 2, waitMs: 1000 }); }
  catch (e) { threw2 = e; }
  ok(threw2 instanceof Error, `joining refuses with an Error (${threw2 && threw2.message})`);
  ok(/cannot send a joiner answer/.test(threw2.message), 'and the sentence names what is missing');
  ok(b2.calls.some(([n, id]) => n === 'leaveLobby' && id === '109775241996081388'),
    'and the Steam lobby the joiner had entered was left behind clean');
  host._steamCleanup?.();
  delete globalThis.window;
}

console.log("-- the answer leg: an answer is measured against the same byte budget the offer is");
{
  // Symmetric with the offer's guard, and for the same reason: a member-data
  // write Steam refuses part-way through leaves `sdp.answer.n` counting parts
  // that are not there, and the host then spends its whole poll on them. In
  // practice this refuses nothing -- a real SDP answer measures ~918 chars
  // against a 7680-byte budget -- so the assertion below deliberately builds a
  // blob that could not have travelled the OTHER leg either.
  const b = makeBridge();
  const host = makeLobby();
  await hostViaSteam(host, FAST);
  const huge = 'A'.repeat(MAX_LOBBY_TOTAL_BYTES + 1000);
  const joiner = makeLobby({ async joinManual() { return huge; } });
  let threw = null;
  try { await joinViaSteam(joiner, '109775241996081388', { pollMs: 2, waitMs: 1000 }); }
  catch (e) { threw = e; }
  ok(threw instanceof Error, `an oversized answer is refused (${threw && String(threw.message).slice(0, 60)})`);
  ok(/a Steam lobby holds 7680 in total/.test(threw.message), 'and the message names the real budget');
  ok(!b.calls.some(([n]) => n === 'writeMemberData'),
    'nothing was written -- a half-written answer is the state this guard exists to prevent');
  // And the answer that fits still goes, so the guard is not simply refusing
  // everything: the same bound, one blob under it.
  const ok2 = makeLobby({ async joinManual() { return 'B'.repeat(1900); } });
  const b2calls = b.calls.length;
  await joinViaSteam(ok2, '109775241996081388', { pollMs: 2, waitMs: 1000 });
  const written = b.calls.slice(b2calls).find(([n]) => n === 'writeMemberData');
  ok(!!written, 'a life-sized answer is written');
  ok(assembleBlob((k) => (k in written[2] ? written[2][k] : null), 'sdp.answer') === 'B'.repeat(1900),
    'and reassembles byte for byte');
  host._steamCleanup?.();
  delete globalThis.window;
}

console.log('-- pickMemberAnswer: whose answer, and whether it is one at all');
{
  const chunk = (blob) => Object.fromEntries(chunkBlob('sdp.answer', blob));
  ok(pickMemberAnswer({ '5': chunk('HI') })?.answer === 'HI', 'a complete record is an answer');
  ok(pickMemberAnswer({ '5': chunk('HI') })?.steamId === '5', 'and it says whose');
  ok(pickMemberAnswer({ '5': chunk('  HI  ') })?.answer === 'HI', 'trimmed');
  ok(pickMemberAnswer({ '5': chunk('') }) === null, 'an empty answer is not an answer');
  ok(pickMemberAnswer({ '5': chunk('   ') }) === null, 'nor is whitespace');
  ok(pickMemberAnswer({ '5': {} }) === null, 'nor a member who has written nothing');
  ok(pickMemberAnswer({ '5': { 'sdp.answer.n': '2', 'sdp.answer.0': 'a' } }) === null,
    'nor a half-written one');
  ok(pickMemberAnswer({}) === null, 'nor an empty lobby');
  ok(pickMemberAnswer(null) === null, 'and a missing reply is null, not a throw');
  ok(pickMemberAnswer({ '5': null, '6': chunk('YES') })?.steamId === '6',
    'one bad record does not hide a good one behind it');
  ok(pickMemberAnswer({ '5': chunk('MINE') }, '5') === null,
    'the host never reads its own slot back');
  ok(pickMemberAnswer({ '5': chunk('MINE'), '6': chunk('THEIRS') }, '5')?.answer === 'THEIRS',
    'and skips past it to the member who did answer');
}

console.log('-- hosting: an answer acceptAnswer rejects does not throw out of the bridge callback');
{
  const b = makeBridge();
  let rejected = 0;
  const lobby = makeLobby({ async acceptAnswer() { rejected++; throw new Error('no pending invite matches that code'); } });
  await hostViaSteam(lobby, FAST);
  putAnswer(b, 'JUNK-ANSWER');
  ok(await waitFor(() => rejected === 1), 'acceptAnswer was reached and rejected');
  // An unhandled rejection out of a detached poll is a main-process crash in
  // Electron, not a caught error: nothing is awaiting this loop.
  await new Promise((r) => setTimeout(r, 30));
  ok(rejected === 1, 'the poll swallowed it and did not retry the answer it already failed on');
  lobby._steamCleanup?.();
  delete globalThis.window;
}

console.log('-- hosting: abandoned midway -- every failure point leaves no Steam lobby behind');
{
  const cases = [
    ['writeLobbyData refused', { async writeLobbyData(id, r) { this.calls.push(['writeLobbyData', id, r]); return { error: 'lobby-data-value-too-long' }; } }, {}],
    // `startSignalListen refused` lived here until 2026-08-21. Its channel has
    // no carrier under the new Binding and nothing calls it, so the case is
    // replaced by the equivalent one on the leg that took over: a lobby whose
    // member-data write is refused must leave no Steam lobby behind either.
    ['writeLobbyData threw', { async writeLobbyData() { throw new Error('IPC died mid-write'); } }, {}],
    ['createInvite threw', {}, { async createInvite() { throw new Error('Already networked'); } }],
  ];
  for (const [name, bo, lo] of cases) {
    const b = makeBridge(bo);
    const lobby = makeLobby(lo);
    let threw = null;
    try { await hostViaSteam(lobby); } catch (e) { threw = e; }
    ok(threw instanceof Error, `${name}: rejects with an Error (${threw && threw.message})`);
    ok(b.calls.some(([n, id]) => n === 'leaveLobby' && id === '109775241996081388'), `${name}: the Steam lobby was left`);
    ok(!b.calls.some(([n]) => n === 'collectMemberData'),
      `${name}: and no answer poll was left running against a lobby that is gone`);
    ok(lobby._steamCleanup === null, `${name}: the dispose hook is cleared, so leave() will not double-fire`);
    delete globalThis.window;
  }
}

console.log("-- hosting: the offer is measured against Steam's whole-lobby byte budget");
{
  // This block replaces one that asserted 63 parts of 6000 chars -- a 378 KB
  // invite -- was accepted. It passed only because the fake bridge accepts
  // anything; live Steam refuses it, and refuses it about 46x earlier than the
  // constants claimed. The measurement (appid 480, this box): a single value of
  // 8174 chars under an 11-byte key is stored and 8175 is refused, while 15
  // separate 500-char values are stored and the 16th is refused at a raw total
  // of 8182 -- one budget for the whole lobby, keys charged like values.
  //
  // So what is asserted here is the platform's real capacity, and every
  // assertion below fails against the constants this branch shipped with.
  ok(MAX_LOBBY_TOTAL_BYTES < 8192, `the budget is under Steam's measured ~8192-byte ceiling (${MAX_LOBBY_TOTAL_BYTES})`);
  ok(BUDGET_FIT > 6000 && BUDGET_FIT < 8192,
    `the largest postable invite is a single lobby's worth, not a part count (${BUDGET_FIT} chars)`);

  // The old ceiling, in the flesh. 63 * CHUNK_CHARS was "accepted" before.
  const b = makeBridge();
  const huge = makeLobby({ async createInvite() { return { id: 1, blob: 'q'.repeat(63 * 6000) }; } });
  let threw = null;
  try { await hostViaSteam(huge); } catch (e) { threw = e; }
  ok(threw instanceof Error, `a 378 kB invite is refused, not written (${threw && threw.message})`);
  ok(!b.calls.some(([n]) => n === 'writeLobbyData'), 'nothing was written, so no half-blob sits in the lobby');
  ok(b.calls.some(([n]) => n === 'leaveLobby'), 'and the Steam lobby was left');

  // One byte over the budget is the first refusal, and the message is one a
  // player can act on rather than a slug.
  const b2 = makeBridge();
  const over = makeLobby({ async createInvite() { return { id: 1, blob: 'q'.repeat(BUDGET_FIT + 1) }; } });
  let threw2 = null;
  try { await hostViaSteam(over); } catch (e) { threw2 = e; }
  ok(threw2 instanceof Error, `one char past the budget is refused (${BUDGET_FIT + 1} chars)`);
  ok(threw2 && /\d+ bytes/.test(threw2.message) && /room code/.test(threw2.message),
    `and says the size and what to do instead (${threw2 && threw2.message})`);
  ok(!b2.calls.some(([n]) => n === 'writeLobbyData'), 'still nothing written');
  delete globalThis.window;

  // ...and the budget really is usable to its last byte: the guard is a ceiling,
  // not an off-by-one that rejects a legal invite.
  const b3 = makeBridge();
  const atCap = makeLobby({ async createInvite() { return { id: 1, blob: 'q'.repeat(BUDGET_FIT) }; } });
  let threw3 = null;
  try { await hostViaSteam(atCap); } catch (e) { threw3 = e; }
  ok(threw3 === null, `a blob of exactly ${BUDGET_FIT} chars is accepted (${threw3 && threw3.message})`);
  const written = b3.calls.find(([n]) => n === 'writeLobbyData')[2];
  ok(recordBytes(Object.entries(written)) <= MAX_LOBBY_TOTAL_BYTES,
    `and the record it wrote fits the budget (${recordBytes(Object.entries(written))} <= ${MAX_LOBBY_TOTAL_BYTES})`);
  delete globalThis.window;
}

console.log("-- hosting: a write Steam refuses reaches the player as a sentence, not a slug");
{
  // The exact symptom this kills: "Steam lobby: lobby-data-write-refused".
  const b = makeBridge({ async writeLobbyData(id, r) { this.calls.push(['writeLobbyData', id, r]); return { error: 'lobby-data-write-refused' }; } });
  const lobby = makeLobby();
  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'the refusal is an Error');
  ok(!/lobby-data-write-refused/.test(threw.message), `no slug survives into the message (${threw.message})`);
  ok(/Steam refused/.test(threw.message) && /room code/.test(threw.message), 'and it carries both a cause and a remedy');
  ok(b.calls.some(([n]) => n === 'leaveLobby'), 'and the Steam lobby was still left');
  delete globalThis.window;

  // A joiner reaching a lobby that has since closed gets the same treatment.
  const b2 = makeBridge({ async getFullLobbyData(id) { this.calls.push(['getFullLobbyData', id]); return { error: 'unknown-lobby' }; } });
  let threw2 = null;
  try { await joinViaSteam(makeLobby(), '109775241996081388', { pollMs: 5, waitMs: 50 }); } catch (e) { threw2 = e; }
  ok(threw2 instanceof Error && !/unknown-lobby/.test(threw2.message) && /host again/.test(threw2.message),
    `and so does the joiner (${threw2 && threw2.message})`);
  void b2;
  delete globalThis.window;
}

console.log('-- hosting twice: the first Steam lobby is released rather than orphaned');
{
  // Important 2. `hostViaSteam` opens the Steam lobby before it waits out ICE
  // gathering (up to 4 s), so a second press is an ordinary impatient gesture --
  // and it used to park a second cleanup latch over the first, leaving the player
  // a member of a lobby that `leave()` could never reach and that a friend could
  // still accept an invite to.
  const b = makeBridge();
  const opened = [];
  let n = 100;
  b.hostLobby = async () => { const id = String(n++); opened.push(id); return { lobbyId: id }; };
  b.leaveLobby = async (id) => { b.calls.push(['leaveLobby', id]); opened.splice(opened.indexOf(id), 1); return { ok: true }; };

  const lobby = makeLobby();
  await hostViaSteam(lobby, FAST);
  await hostViaSteam(lobby, FAST);
  ok(opened.length === 1 && opened[0] === '101',
    `only the newest Steam lobby is still held (${JSON.stringify(opened)})`);
  ok(b.calls.some(([nm, id]) => nm === 'leaveLobby' && id === '100'), 'the first was left, by its own latch');
  // Counting subscriptions used to answer "did anything pile up". There are no
  // subscriptions now, and the equivalent question is sharper: the abandoned
  // lobby's poll must be DEAD, not merely unheard. A poll left running on '100'
  // would keep asking Steam about a lobby this process has left.
  await waitFor(() => b.calls.some(([nm, id]) => nm === 'collectMemberData' && id === '101'));
  const stale = b.calls.filter(([nm, id]) => nm === 'collectMemberData' && id === '100').length;
  await new Promise((r) => setTimeout(r, 30));
  ok(b.calls.filter(([nm, id]) => nm === 'collectMemberData' && id === '100').length === stale,
    'the abandoned lobby\'s answer poll is dead, not merely unheard');
  ok(b.calls.some(([nm, id]) => nm === 'collectMemberData' && id === '101'),
    'and the lobby that is still held is the one being polled');

  lobby._steamCleanup();
  ok(opened.length === 0, 'and Leave releases the one that is left');
  ok(b.listeners.signal.size === 0, 'along with its listeners');
  delete globalThis.window;
}

console.log('-- teardown: one failing step does not cancel the step that matters');
{
  // Minor-1's case: the unsubscribe closures are the bridge's own synchronous
  // functions, and if the first one throws, `leaveLobby` must still run --
  // otherwise the latch is set, nothing retries, and the lobby leaks.
  // RE-AIMED 2026-08-21. The throwing step used to be an `onSignal` unsubscribe,
  // and there is no such subscription any more -- the poll's stop is a closure of
  // this module's own, which cannot throw. So the throw is injected one step
  // earlier, at the first entry of the RELEASE group, and the claim is unchanged
  // and if anything sharper: a step that throws must not cancel the step after
  // it, and the last step is the one that stops the Lobby looking like it still
  // holds a Steam lobby.
  let leaveTried = 0;
  const b = makeBridge({ async leaveLobby() { leaveTried++; throw new Error('leaveLobby blew up'); } });
  const lobby = makeLobby();
  await hostViaSteam(lobby, FAST);
  ok(lobby._steamLobbyId === '109775241996081388', 'precondition: the Lobby is holding the id');
  let threw = null;
  try { lobby._steamCleanup(); } catch (e) { threw = e; }
  ok(threw === null, `the teardown did not throw at its caller (${threw && threw.message})`);
  ok(lobby._steamLobbyId === null, 'the step after the throwing one still ran');
  ok(leaveTried === 1, `and the throwing step was genuinely reached (${leaveTried})`);
  delete globalThis.window;
}

console.log('-- teardown: a rejecting bridge call is absorbed, not left unhandled');
{
  const b = makeBridge({ async leaveLobby() { throw new Error('IPC died'); } });
  const lobby = makeLobby();
  await hostViaSteam(lobby);
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  lobby._steamCleanup();
  // An unhandled rejection is reported at the end of the microtask checkpoint,
  // so give it a real turn of the loop to be reported in.
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', onUnhandled);
  ok(unhandled.length === 0, `no unhandled rejection escaped the teardown (${unhandled.length})`);
  void b;
  delete globalThis.window;
}

console.log('-- hosting: a lobby with no id, and a Steam that refuses outright');
{
  let b = makeBridge({ async hostLobby(n) { this.calls.push(['hostLobby', n]); return { error: 'max-members-out-of-range' }; } });
  let threw = null;
  try { await hostViaSteam(makeLobby()); } catch (e) { threw = e; }
  ok(threw instanceof Error && /max-members-out-of-range/.test(threw.message), `the bridge's own error slug survives into the message (${threw && threw.message})`);
  ok(!b.calls.some(([n]) => n === 'leaveLobby'), 'nothing was left, because nothing was opened');
  delete globalThis.window;

  b = makeBridge({ async hostLobby() { return {}; } });
  threw = null;
  try { await hostViaSteam(makeLobby()); } catch (e) { threw = e; }
  ok(threw instanceof Error, `a reply with no lobbyId is a failure, not undefined downstream (${threw && threw.message})`);
  delete globalThis.window;
}

console.log('-- joining: poll, assemble, answer back to the owner');
{
  const b = makeBridge();
  const host = makeLobby();
  await hostViaSteam(host);            // the host's chunks land in b.data
  const hostCalls = b.calls.length;

  const joiner = makeLobby();
  await joinViaSteam(joiner, '109775241996081388', { pollMs: 5, waitMs: 2000 });

  const order = b.calls.slice(hostCalls).map(([n]) => n)
    .filter((n) => n !== 'status' && n !== 'collectMemberData');
  ok(JSON.stringify(order) === JSON.stringify(['joinLobby', 'getFullLobbyData', 'writeMemberData']),
    `join -> poll -> answer (${order.join(' -> ')})`);
  ok(joiner.joined.length === 1 && joiner.joined[0] === OFFER_FIXTURE,
    'joinManual got the reassembled offer, byte for byte');
  // `getLobbyOwner` is gone from this path: member data is addressed to the
  // lobby, not to a Steam id, so the joiner no longer has to learn who the owner
  // is in order to answer them.
  ok(!b.calls.slice(hostCalls).some(([n]) => n === 'getLobbyOwner'),
    'the joiner no longer has to ask who owns the lobby before it can answer');
  const sent = b.calls.find(([n]) => n === 'writeMemberData');
  ok(sent[1] === '109775241996081388', `the answer is written on the lobby just joined (${sent[1]})`);
  ok(Object.keys(sent[2]).every((k) => k.startsWith('sdp.answer.')),
    `only sdp.answer keys were written (${Object.keys(sent[2]).sort().join(',')})`);
  ok(assembleBlob((k) => (k in sent[2] ? sent[2][k] : null), 'sdp.answer') === 'ANSWER-BLOB',
    'and they reassemble into exactly what joinManual returned');
  ok(!b.calls.slice(hostCalls).some(([n]) => n === 'leaveLobby'),
    'the joiner stays in the lobby -- leaving would delete the member data carrying its answer');
  delete globalThis.window;
}

console.log('-- joining: it really does poll, rather than reading once and giving up');
{
  const b = makeBridge();
  const joiner = makeLobby();
  // The offer appears on the third poll, which is what a real host racing a
  // joiner looks like.
  let polls = 0;
  const offer = Object.fromEntries(chunkBlob('sdp.offer', 'LATE-OFFER'));
  b.getFullLobbyData = async (id) => { b.calls.push(['getFullLobbyData', id]); polls++; return { data: polls >= 3 ? offer : {} }; };

  await joinViaSteam(joiner, '109775241996081388', { pollMs: 5, waitMs: 2000 });
  ok(polls === 3, `it polled until the data was there (${polls} polls)`);
  ok(joiner.joined[0] === 'LATE-OFFER', 'and used the offer that arrived late');
  delete globalThis.window;
}

console.log('-- joining: the 60 s bound, and the lobby left behind when it expires');
{
  const b = makeBridge();
  const joiner = makeLobby();
  let threw = null;
  try { await joinViaSteam(joiner, '109775241996081388', { pollMs: 5, waitMs: 30 }); } catch (e) { threw = e; }
  ok(threw instanceof Error && /never posted/.test(threw.message), `the wait is bounded (${threw && threw.message})`);
  ok(b.calls.some(([n]) => n === 'leaveLobby'), 'and the Steam lobby was left');
  ok(joiner.joined.length === 0, 'nothing was handed to joinManual');
  delete globalThis.window;
}

console.log('-- joining: abandoned mid-poll stops the timer rather than being ignored by it');
{
  const b = makeBridge();
  const joiner = makeLobby();
  const p = joinViaSteam(joiner, '109775241996081388', { pollMs: 5, waitMs: 5000 });
  await new Promise((r) => setTimeout(r, 20));
  ok(typeof joiner._steamCleanup === 'function', 'the dispose hook is armed while the poll runs');
  joiner._steamCleanup();                     // this is what Lobby.leave() does
  let threw = null;
  try { await p; } catch (e) { threw = e; }
  ok(threw instanceof Error && /left before/.test(threw.message), `the pending join rejects (${threw && threw.message})`);
  const pollsAfter = b.calls.filter(([n]) => n === 'getFullLobbyData').length;
  await new Promise((r) => setTimeout(r, 40));
  ok(b.calls.filter(([n]) => n === 'getFullLobbyData').length === pollsAfter, 'and the poll really stopped -- no further reads');
  ok(b.calls.some(([n]) => n === 'leaveLobby'), 'the Steam lobby was left');
  delete globalThis.window;
}

console.log('-- joining: an empty offer blob is "arrived", not "not yet" (Minor 2)');
{
  // chunkBlob('sdp.offer', '') is a legal write: sdp.offer.n = '0', no parts,
  // and assembleBlob correctly returns '' for it. The old `if (offer) break`
  // read that as "still arriving" and burned the whole wait bound on an
  // invite that had, in fact, fully posted.
  const b = makeBridge();
  const emptyOffer = Object.fromEntries(chunkBlob('sdp.offer', ''));
  b.getFullLobbyData = async (id) => { b.calls.push(['getFullLobbyData', id]); return { data: { ...emptyOffer } }; };
  const joiner = makeLobby();
  const start = Date.now();
  let threw = null;
  try { await joinViaSteam(joiner, '109775241996081388', { pollMs: 5, waitMs: 50 }); } catch (e) { threw = e; }
  ok(threw === null, `an empty-but-complete offer resolves rather than timing out (${threw && threw.message})`);
  ok(joiner.joined.length === 1 && joiner.joined[0] === '', `joinManual received the empty string, not undefined (${JSON.stringify(joiner.joined)})`);
  ok(Date.now() - start < 50, 'it resolved on the first poll instead of waiting out the whole bound');
  delete globalThis.window;
}

console.log('-- steamInviteNeedsConfirm: when a friend\'s "Join game" must ask before it acts (Important 4)');
{
  ok(steamInviteNeedsConfirm({ hasActiveRun: false, lobbyMode: 'single' }) === false,
    'idle at a menu, nothing networked: the direct join the two-seat checkpoint exercises is unaffected');
  ok(steamInviteNeedsConfirm({ hasActiveRun: false, lobbyMode: null }) === false, 'no lobby object at all needs no confirmation either');
  ok(steamInviteNeedsConfirm({ hasActiveRun: false, lobbyMode: undefined }) === false, 'nor does an undefined mode');
  ok(steamInviteNeedsConfirm({ hasActiveRun: true, lobbyMode: 'single' }) === true, 'a run in flight asks first, even with nothing networked yet');
  ok(steamInviteNeedsConfirm({ hasActiveRun: false, lobbyMode: 'host' }) === true, 'already hosting a session asks first');
  ok(steamInviteNeedsConfirm({ hasActiveRun: false, lobbyMode: 'client' }) === true, 'already joined a session asks first');
  ok(steamInviteNeedsConfirm({ hasActiveRun: true, lobbyMode: 'client' }) === true, 'mid-run AND networked still asks -- one true is enough');
}

console.log('-- FIX ROUND 2 (re-review): host-then-accept-invite must not release the host\'s own Steam lobby');
{
  // The exact finding: `armCleanup`'s "run the previous latch" step used to
  // fire as an UNCONDITIONAL FIRST STEP of joinViaSteam -- releasing the
  // host's own, currently-working Steam lobby -- before the new invite's
  // outcome (success, "Already networked", or a timeout) was even known.
  // The invariant: no partial teardown, ever. Decide and refuse completely
  // BEFORE releasing anything.
  const b = makeBridge();
  const lobby = makeLobby();
  const hostRes = await hostViaSteam(lobby);
  lobby.mode = 'host';   // what real Lobby.createInvite() -> startHost() sets
  const callsBeforeInvite = b.calls.length;

  let threw = null;
  try { await joinViaSteam(lobby, '999999999999999999', { pollMs: 5, waitMs: 20 }); }
  catch (e) { threw = e; }
  ok(threw instanceof Error, `accepting an invite while hosting refuses (${threw && threw.message})`);
  ok(threw && !/Already networked/.test(threw.message),
    `the raw Lobby.js throw text never reaches the player (${threw && threw.message})`);
  ok(threw && /already hosting/i.test(threw.message), `and says why, in words a player can act on (${threw && threw.message})`);
  // `status()` is the one call `requireSteam()` always makes before the new
  // guard is even reached -- everything Steam-lobby-specific (joinLobby,
  // getFullLobbyData, leaveLobby) must be absent.
  const newCalls = b.calls.slice(callsBeforeInvite).map(([n]) => n);
  ok(JSON.stringify(newCalls) === JSON.stringify(['status']),
    `nothing but the status check reached the bridge for the doomed join (${JSON.stringify(newCalls)})`);
  ok(!b.calls.some(([n, id]) => n === 'leaveLobby' && id === hostRes.lobbyId),
    `the host's own Steam lobby (${hostRes.lobbyId}) was never released`);
  ok(typeof lobby._steamCleanup === 'function', 'the hosting session\'s own teardown latch is still armed, untouched');
  delete globalThis.window;
}

console.log('-- FIX ROUND 2: mirror case -- hosting after already accepting an invite must not release the joined lobby');
{
  const b = makeBridge();
  // Seed b.data with a real offer the way a live host's lobby would, via a
  // throwaway host object -- the same trick "-- joining: poll, assemble,
  // answer back to the owner" above uses -- so the join under test actually
  // succeeds and reaches `mode = 'client'`, rather than timing out for an
  // unrelated reason.
  await hostViaSteam(makeLobby());
  const joinId = '109775241996081388';
  const lobby = makeLobby();
  await joinViaSteam(lobby, joinId, { pollMs: 5, waitMs: 2000 });
  lobby.mode = 'client';   // what real Lobby.joinManual() sets
  const callsBeforeHost = b.calls.length;

  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error, `hosting while already a client refuses (${threw && threw.message})`);
  ok(threw && /already in a game/i.test(threw.message), `and says why (${threw && threw.message})`);
  const newCalls = b.calls.slice(callsBeforeHost).map(([n]) => n);
  ok(JSON.stringify(newCalls) === JSON.stringify(['status']),
    `nothing but the status check reached the bridge for the doomed host attempt (${JSON.stringify(newCalls)})`);
  ok(!b.calls.some(([n, id]) => n === 'leaveLobby' && id === joinId), `the joined lobby (${joinId}) was never released`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 2: mirror case -- a second Steam invite while already joined must not release the first');
{
  const b = makeBridge();
  await hostViaSteam(makeLobby());   // seeds b.data so the first join below succeeds
  const firstJoinId = '109775241996081388';
  const lobby = makeLobby();
  await joinViaSteam(lobby, firstJoinId, { pollMs: 5, waitMs: 2000 });
  lobby.mode = 'client';
  const callsBefore = b.calls.length;

  let threw = null;
  try { await joinViaSteam(lobby, '5', { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
  ok(threw instanceof Error, `a second invite while already joined refuses (${threw && threw.message})`);
  const newCalls = b.calls.slice(callsBefore).map(([n]) => n);
  ok(JSON.stringify(newCalls) === JSON.stringify(['status']),
    `nothing but the status check reached the bridge for the second invite (${JSON.stringify(newCalls)})`);
  ok(!b.calls.some(([n, id]) => n === 'leaveLobby' && id === firstJoinId), `the first joined lobby (${firstJoinId}) was never released`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 3: double-host (the SAME gesture twice) re-advertises IN PLACE -- Important 2 stays closed');
{
  // Important 2 asked for one thing: a second "Host via Steam" must not leave an
  // orphaned Steam lobby behind. Round 2 met that by opening a fresh lobby and
  // releasing the old one. Round 3 meets it more strongly by not opening a second
  // lobby at all -- see `hostViaSteam`'s re-advertise comment. Either way exactly
  // one Steam lobby is open at the end and `Lobby.leave()` frees it; the
  // difference is that a friend already inside the first lobby keeps their
  // membership, and so keeps the only thing that makes their answer deliverable.
  const b = makeBridge();
  const opened = [];
  let n = 200;
  b.hostLobby = async () => { const id = String(n++); opened.push(id); b.calls.push(['hostLobby']); return { lobbyId: id }; };
  b.leaveLobby = async (id) => { b.calls.push(['leaveLobby', id]); opened.splice(opened.indexOf(id), 1); return { ok: true }; };
  const lobby = makeLobby();
  const first = await hostViaSteam(lobby, FAST);
  lobby.mode = 'host';
  const second = await hostViaSteam(lobby, FAST);

  ok(opened.length === 1 && opened[0] === '200',
    `exactly one Steam lobby is open, and it is the first one (${JSON.stringify(opened)})`);
  ok(second.lobbyId === first.lobbyId, `the re-advertise keeps the friend's lobby id (${first.lobbyId} -> ${second.lobbyId})`);
  ok(b.calls.filter(([n2]) => n2 === 'hostLobby').length === 1, 'no second Steam lobby was opened');
  ok(!b.calls.some(([n2]) => n2 === 'leaveLobby'), 'and nothing was released out from under a friend who had already joined');
  ok(b.calls.filter(([n2]) => n2 === 'writeLobbyData').length === 2, 'a freshly minted offer was written over the old one');
  // The listen is a poll now, and "still listening on the friend's lobby" is
  // the same claim: an answer written by a member of the FIRST lobby must still
  // reach acceptAnswer after the second press.
  putAnswer(b, 'THE-FRIENDS-ANSWER');
  ok(await waitFor(() => lobby.accepted.length >= 1),
    'the host is still hearing the lobby the friend is a member of');
  ok(lobby.accepted.length === 1 && lobby.accepted[0] === 'THE-FRIENDS-ANSWER',
    `and heard it exactly once -- no poll accumulated across the two presses (${JSON.stringify(lobby.accepted)})`);
  ok(b.calls.filter(([n2, id]) => n2 === 'collectMemberData' && id === first.lobbyId).length > 0,
    'the poll named the first lobby, not a second one');

  lobby._steamCleanup();                       // this is what Lobby.leave() does
  ok(opened.length === 0, `Lobby.leave() still frees the one lobby that is open (${JSON.stringify(opened)})`);
  delete globalThis.window;
}

// -------------------------------------------------- FIX ROUND 3: in-flight
//
// The round-2 guards read `lobby.mode`, which is a COMPLETION signal. A
// `joinViaSteam` can sit in its poll loop for a full minute with `mode` still
// reading `'single'`, and every one of these blocks fires a second Steam
// operation inside exactly that window. Each asserts the same invariant the two
// previous rounds asserted only for settled state: no partial teardown -- decide,
// and either complete or abort, BEFORE releasing any previous state.

/** A bridge whose host never posts an offer, so a join stays in its poll loop. */
function stallingBridge() {
  const b = makeBridge();
  b.getFullLobbyData = async (id) => { b.calls.push(['getFullLobbyData', id]); return { data: {} }; };
  return b;
}
const settle = (p) => p.then(() => 'resolved', (e) => 'rejected: ' + e.message);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('-- FIX ROUND 3: a second invite arriving while the first join is still MID-POLL must not release the first');
{
  const b = stallingBridge();
  const lobby = makeLobby({ mode: 'single' });
  const firstId = '111';
  const first = settle(joinViaSteam(lobby, firstId, { pollMs: 5, waitMs: 300 }));
  await tick(30);
  ok(lobby.mode === 'single',
    'the first join is genuinely in flight and lobby.mode still reads "single" -- what the round-2 guards see');
  const before = b.calls.length;

  let threw = null;
  try { await joinViaSteam(lobby, '222', { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
  ok(threw instanceof Error, `the second invite is refused (${threw && threw.message})`);
  ok(threw && /still joining/i.test(threw.message), `and names the cause and the remedy (${threw && threw.message})`);
  ok(JSON.stringify(b.calls.slice(before).map(([n]) => n)) === JSON.stringify([]),
    `nothing at all reached the bridge for the refused invite (${JSON.stringify(b.calls.slice(before))})`);
  ok(!b.calls.some(([n, id]) => n === 'leaveLobby' && id === firstId),
    `the first join's own Steam lobby (${firstId}) was never released`);
  ok(!b.calls.some(([n, id]) => n === 'joinLobby' && id === '222'), 'and the second lobby was never joined');

  const how = await first;
  ok(/never posted/.test(how), `the first join ran on to its OWN outcome rather than being abandoned (${how})`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 3: "Host via Steam" pressed while a join is still MID-POLL must not release the join');
{
  const b = stallingBridge();
  const lobby = makeLobby({ mode: 'single' });
  const firstId = '111';
  const first = settle(joinViaSteam(lobby, firstId, { pollMs: 5, waitMs: 300 }));
  await tick(30);
  const before = b.calls.length;

  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error, `the host press is refused rather than silently superseding the join (${threw && threw.message})`);
  ok(threw && /still joining/i.test(threw.message), `and says why (${threw && threw.message})`);
  ok(JSON.stringify(b.calls.slice(before).map(([n]) => n)) === JSON.stringify([]),
    `nothing reached the bridge (${JSON.stringify(b.calls.slice(before))})`);
  ok(!b.calls.some(([n, id]) => n === 'leaveLobby' && id === firstId), `the join's Steam lobby (${firstId}) was never released`);
  ok(!b.calls.some(([n]) => n === 'hostLobby'), 'and no Steam lobby was opened for the refused host attempt');

  const how = await first;
  ok(/never posted/.test(how), `the join ran on to its own outcome (${how})`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 3: a second host press while the first is still opening is refused, and opens no second lobby');
{
  const b = makeBridge();
  const opened = [];
  let n = 300;
  b.hostLobby = async () => { await tick(40); const id = String(n++); opened.push(id); return { lobbyId: id }; };
  const lobby = makeLobby({ mode: 'single' });
  const first = settle(hostViaSteam(lobby));
  await tick(5);

  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error, `the impatient second press is refused (${threw && threw.message})`);
  ok(threw && /still opening/i.test(threw.message), `and says what is already happening (${threw && threw.message})`);
  ok(await first === 'resolved', 'the first press still completes on its own terms');
  ok(opened.length === 1, `exactly one Steam lobby was ever opened (${JSON.stringify(opened)})`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 3: an invite arriving while a host press is still in flight is refused, host untouched');
{
  const b = makeBridge();
  b.hostLobby = async (m) => { b.calls.push(['hostLobby', m]); await tick(40); return { lobbyId: '400' }; };
  const lobby = makeLobby({ mode: 'single' });
  const first = settle(hostViaSteam(lobby));
  await tick(5);

  let threw = null;
  try { await joinViaSteam(lobby, '555', { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
  ok(threw instanceof Error && /still opening/i.test(threw.message),
    `the invite is refused while the host press is undecided (${threw && threw.message})`);
  ok(await first === 'resolved', 'and the host press completes');
  ok(!b.calls.some(([n, id]) => n === 'leaveLobby' && id === '400'), "the host's own Steam lobby was never released");
  ok(!b.calls.some(([n]) => n === 'joinLobby'), 'and the invite never reached the bridge');
  delete globalThis.window;
}

console.log('-- FIX ROUND 3: the in-flight latch clears on EVERY exit -- success, refusal, the wait bound, and teardown');
{
  // A latch that outlives its operation is a co-op screen that refuses every
  // gesture for the rest of the process. Each arm below drives one exit path and
  // then proves the very next Steam operation is accepted.
  const b = stallingBridge();

  const a = makeLobby({ mode: 'single' });
  let threw = null;
  try { await joinViaSteam(a, '111', { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
  ok(threw && /never posted/.test(threw.message), 'arm 1: the join times out at its bound');
  threw = null;
  try { await joinViaSteam(a, '112', { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
  ok(threw && /never posted/.test(threw.message), `arm 1: and the next invite is accepted, not refused as busy (${threw && threw.message})`);

  const c = makeLobby({ mode: 'single' });
  const pending = settle(joinViaSteam(c, '113', { pollMs: 5, waitMs: 5000 }));
  await tick(20);
  // The whole point of the round: "an operation is in progress on this Lobby" is
  // observable SYNCHRONOUSLY, mid-poll, while `mode` still says 'single'.
  ok(!!c._steamOp && c._steamOp.kind === 'join' && c.mode === 'single',
    `arm 2: the in-flight latch is readable while the poll runs (${JSON.stringify(c._steamOp)}, mode ${c.mode})`);
  c._steamCleanup();                              // Lobby.leave() mid-poll
  ok(!c._steamOp, 'arm 2: teardown clears the in-flight latch at once, not a poll tick later');
  threw = null;
  try { await joinViaSteam(c, '114', { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
  ok(threw && /never posted/.test(threw.message), `arm 2: so the next invite is accepted straight away (${threw && threw.message})`);
  ok(/left before/.test(await pending), 'arm 2: and the abandoned join still rejects for its own reason');

  const d = makeLobby({ mode: 'single' });
  Object.assign(b.data, Object.fromEntries(chunkBlob('sdp.offer', 'AN-OFFER')));
  b.getFullLobbyData = async (id) => { b.calls.push(['getFullLobbyData', id]); return { data: { ...b.data } }; };
  await joinViaSteam(d, '115', { pollMs: 5, waitMs: 2000 });   // the offer is there, so this one succeeds
  ok(!d._steamOp, 'arm 3: a join that succeeds leaves no latch behind either');
  delete globalThis.window;

  const e = makeBridge();
  const f = makeLobby({ mode: 'single' });
  await hostViaSteam(f);
  ok(!f._steamOp, 'arm 4: nor does a host that succeeds');
  e.hostLobby = async () => ({ error: 'steam-unavailable' });
  const g = makeLobby({ mode: 'single' });
  threw = null;
  try { await hostViaSteam(g); } catch (err) { threw = err; }
  ok(threw instanceof Error && !g._steamOp, 'arm 5: nor does a host that throws from the bridge');
  delete globalThis.window;
}

console.log('-- FIX ROUND 3: a re-advertise that FAILS keeps the running session\'s Steam lobby, and leave() still frees it');
{
  const b = makeBridge();
  const opened = [];
  b.hostLobby = async () => { opened.push('500'); return { lobbyId: '500' }; };
  b.leaveLobby = async (id) => { b.calls.push(['leaveLobby', id]); opened.splice(opened.indexOf(id), 1); return { ok: true }; };
  const lobby = makeLobby();
  await hostViaSteam(lobby);
  lobby.mode = 'host';

  b.writeLobbyData = async () => ({ error: 'lobby-data-write-refused' });
  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error, `the failed re-advertise reports itself (${threw && threw.message})`);
  ok(opened.length === 1 && opened[0] === '500',
    `the running game's Steam lobby is still open -- a failed re-advertise costs nothing (${JSON.stringify(opened)})`);
  ok(typeof lobby._steamCleanup === 'function', 'and a latch is still armed over it');
  lobby._steamCleanup?.();
  ok(opened.length === 0, 'so Lobby.leave() still frees it -- no orphan, Important 2 stays closed');
  delete globalThis.window;
}

// ------------------------------------------------ FIX ROUND 4: the failure paths
//
// Round 3's in-flight latch holds; what did not was what happens AROUND it when an
// operation fails or is torn down. Every block below drives a failure or a teardown
// and asserts the PROPERTY the invariant names -- what the player and their friend
// can still do -- rather than the mechanism this file happens to use for it.

/**
 * What `Lobby.leave()` does that matters here (`src/net/Lobby.js:345-362`): it runs
 * the Steam latch, clears the slot, and drops the session back to single-player.
 * The `mode` reset is load-bearing -- it is what lets the NEXT gesture past the
 * round-2 mode guards, and therefore what opens the window these blocks exploit.
 */
const leaveLikeLobby = (l) => { const c = l._steamCleanup; l._steamCleanup = null; c?.(); l.mode = 'single'; };

/** `settle`, but a promise that never settles reports itself instead of hanging the suite. */
const settleWithin = (p, ms) => Promise.race([settle(p), tick(ms).then(() => 'never settled')]);

console.log('-- FIX ROUND 4 (Critical 2): a re-advertise that FAILS leaves the running session able to HEAR the answer it is still offering');
{
  // Keeping the Steam lobby open is only half of "leaves the previous session
  // exactly as it was". A lobby that is still listed in the friends list and still
  // carrying a readable offer, whose host can no longer receive an answer, is
  // WORSE than one that was never advertised: the friend reads a perfectly good
  // offer, sends a perfectly good answer, and is met with silence.
  const b = makeBridge();
  const open = new Set();
  b.hostLobby = async () => { b.calls.push(['hostLobby']); open.add('500'); return { lobbyId: '500' }; };
  b.leaveLobby = async (id) => { b.calls.push(['leaveLobby', id]); open.delete(id); return { ok: true }; };
  const lobby = makeLobby();
  await hostViaSteam(lobby, FAST);
  lobby.mode = 'host';

  // `lobby-data-write-refused` is in BRIDGE_REASONS: a condition this module
  // documents as expected, not an exotic one.
  b.writeLobbyData = async () => ({ error: 'lobby-data-write-refused' });
  let threw = null;
  try { await hostViaSteam(lobby, FAST); } catch (e) { threw = e; }
  ok(threw instanceof Error, `the re-advertise fails, as the bridge said it would (${threw && threw.message})`);

  ok(open.has('500'), `the running game's Steam lobby is still open (${JSON.stringify([...open])})`);
  ok(assembleBlob((k) => (k in b.data ? b.data[k] : null), 'sdp.offer') === OFFER_FIXTURE,
    'and still carries an offer a friend can read');
  // The listener is a poll now, so "can still HEAR" is asked of the poll
  // directly, which is a stronger question than counting subscriptions was: it
  // fails if the surviving poll is running against the wrong lobby, or stopped.
  putAnswer(b, 'THE-ANSWER');
  ok(await waitFor(() => lobby.accepted.length >= 1),
    "the friend's answer still reaches acceptAnswer -- the session can HEAR");
  ok(lobby.accepted.length === 1 && lobby.accepted[0] === 'THE-ANSWER',
    `exactly once -- no poll was lost and none stacked (${JSON.stringify(lobby.accepted)})`);

  ok(typeof lobby._steamCleanup === 'function', 'a latch is still armed over the lobby');
  leaveLikeLobby(lobby);
  ok(!open.has('500'), 'so Lobby.leave() still frees it -- no orphan, Important 2 stays closed');
  ok(b.listeners.fail.size === 0, `and leave() takes the surviving subscriptions down exactly once (${b.listeners.fail.size})`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 4 (Critical 1): a stale failed re-advertise must not spend a NEWER operation\'s Steam lobby');
{
  const b = makeBridge();
  const open = new Set();
  b.hostLobby = async () => { b.calls.push(['hostLobby']); open.add('100'); return { lobbyId: '100' }; };
  b.joinLobby = async (id) => { b.calls.push(['joinLobby', id]); open.add(id); return { ok: true }; };
  b.leaveLobby = async (id) => { b.calls.push(['leaveLobby', id]); open.delete(id); return { ok: true }; };
  b.getFullLobbyData = async (id) => { b.calls.push(['getFullLobbyData', id]); return { data: {} }; };

  let stall;
  const hung = new Promise((_, rej) => { stall = rej; });
  let invites = 0;
  const lobby = makeLobby({
    // The second press parks in `createInvite` -- in the real Lobby that is
    // `waitForIce`, capped at 4000 ms (`Transport.js:283`), so this window is
    // seconds wide and reliably outlives a Leave and the invite that follows it.
    async createInvite() { invites++; return invites === 1 ? { id: 1, blob: OFFER_FIXTURE } : hung; },
  });
  await hostViaSteam(lobby);
  lobby.mode = 'host';
  const stale = settle(hostViaSteam(lobby));
  await tick(10);
  leaveLikeLobby(lobby);
  ok(open.size === 0 && !lobby._steamOp,
    `Leave released the lobby and freed the claim while the re-advertise was still undecided (${JSON.stringify([...open])})`);

  const mark = b.calls.length;
  const joinB = settle(joinViaSteam(lobby, '222', { pollMs: 5, waitMs: 400 }));
  await tick(20);
  const claimB = lobby._steamOp;
  const latchB = lobby._steamCleanup;
  ok(!!claimB && claimB.kind === 'join' && open.has('222'),
    'the friend\'s invite was accepted and is now the operation in flight, in its own Steam lobby');

  stall(new Error('the bridge died'));
  ok(/^rejected/.test(await stale), 'the stale re-advertise finally rejects, as it always would have');
  ok(!b.calls.slice(mark).some(([n, id]) => n === 'leaveLobby' && id === '222'),
    `it did not release the new join's Steam lobby while that join was undecided (${JSON.stringify(b.calls.slice(mark))})`);
  ok(lobby._steamOp === claimB, 'nor clear the new join\'s in-flight claim');
  ok(lobby._steamCleanup === latchB, 'nor take the new join\'s teardown off the Lobby');
  ok(/never posted/.test(await joinB), 'so the join ran on to its OWN outcome rather than being abandoned for it');
  delete globalThis.window;
}

console.log('-- FIX ROUND 4 (Important 1): a stale join\'s catch must not discard a NEWER operation\'s teardown');
{
  const b = makeBridge();
  const open = new Set();
  b.joinLobby = async (id) => { b.calls.push(['joinLobby', id]); open.add(id); return { ok: true }; };
  b.leaveLobby = async (id) => { b.calls.push(['leaveLobby', id]); open.delete(id); return { ok: true }; };
  b.getFullLobbyData = async (id) => { b.calls.push(['getFullLobbyData', id]); return { data: {} }; };
  const lobby = makeLobby({ mode: 'single' });

  // Alice's invite, abandoned by Leave. Its catch does not fire until the poll tick
  // it is asleep in expires -- a full second at the shipped POLL_MS.
  const alice = settle(joinViaSteam(lobby, '111', { pollMs: 200, waitMs: 5000 }));
  await tick(10);
  leaveLikeLobby(lobby);
  ok(!open.has('111') && !lobby._steamOp, 'Leave released Alice\'s lobby and freed the claim at once');

  // Bob's invite, accepted inside that same tick -- which the refusal text the
  // player was shown ("...or leave, then try that invite again") invites them to do.
  const bob = settle(joinViaSteam(lobby, '222', { pollMs: 200, waitMs: 5000 }));
  await tick(20);
  ok(open.has('222') && !!lobby._steamOp, 'Bob\'s invite is now the operation in flight');
  ok(/left before/.test(await alice), 'Alice\'s abandoned join settles on its own terms');
  ok(typeof lobby._steamCleanup === 'function', 'and Bob\'s teardown is still on the Lobby, not blanked by hers');

  leaveLikeLobby(lobby);
  ok(!open.has('222'), `so a second Leave releases Bob's Steam lobby -- no orphan (${JSON.stringify([...open])})`);
  ok(!lobby._steamOp, 'and frees the claim, so the co-op screen is not wedged');
  ok(/left before/.test(await bob),
    'and Bob\'s join is abandoned rather than completing behind the back of a player who pressed Leave');
  ok(lobby.joined.length === 0, `nobody was dropped into a game they declined (${JSON.stringify(lobby.joined)})`);
  delete globalThis.window;
}

console.log('-- FIX ROUND 4 (Important 2): a bridge call that never answers must not wedge Steam co-op for the life of the page');
{
  // `ipcRenderer.invoke` hangs, rather than rejecting, when the main handler awaits
  // a steamworks.js promise whose Steam callback never fires -- an ordinary field
  // condition for a client that is busy, updating or mid-restart. Before
  // `armCleanup` there is no latch for `Lobby.leave()` to run, so a claim taken in
  // that window had no exit at all.
  const never = () => new Promise(() => {});
  const arms = [
    ['the status check', (b) => { b.status = never; }, (l) => hostViaSteam(l, { bridgeMs: 30 })],
    ['opening the lobby', (b) => { b.hostLobby = never; }, (l) => hostViaSteam(l, { bridgeMs: 30 })],
    ['joining the lobby', (b) => { b.joinLobby = never; }, (l) => joinViaSteam(l, '111', { pollMs: 5, waitMs: 200, bridgeMs: 30 })],
  ];
  for (const [name, wreck, go] of arms) {
    const b = makeBridge();
    wreck(b);
    const lobby = makeLobby({ mode: 'single' });
    const how = settleWithin(go(lobby), 400);
    await tick(10);
    ok(!!lobby._steamOp, `${name} never answers: precondition -- the operation is in flight and holding the claim`);

    const said = await how;
    ok(/^rejected/.test(said), `${name} never answers: the operation ends by itself (${said})`);
    ok(/Steam/.test(said) && /room code/.test(said),
      `${name} never answers: with a sentence naming what to do instead, not a slug (${said})`);
    ok(!lobby._steamOp, `${name} never answers: and the in-flight claim is released`);

    // The property that actually matters to a player: the feature still works.
    b.status = async () => ({ available: true, appId: 480, personaName: 'Tester', reason: null });
    b.hostLobby = async () => ({ lobbyId: '900' });
    let res = null; let why = null;
    try { res = await hostViaSteam(lobby, { bridgeMs: 200 }); } catch (e) { why = e.message; }
    ok(res && res.lobbyId === '900',
      `${name} never answers: and the very next "Host via Steam" is accepted, not refused as busy (${why || JSON.stringify(res)})`);
    delete globalThis.window;
  }
}

console.log('-- steamInviteBlocked: when an invite cannot possibly succeed (fix round 2)');
{
  ok(steamInviteBlocked({ lobbyMode: 'single' }) === false, 'idle, nothing networked: not blocked');
  ok(steamInviteBlocked({ lobbyMode: null }) === false, 'no lobby mode at all: not blocked');
  ok(steamInviteBlocked({ lobbyMode: undefined }) === false, 'undefined mode: not blocked');
  ok(steamInviteBlocked({ lobbyMode: 'host' }) === true, 'already hosting: blocked');
  ok(steamInviteBlocked({ lobbyMode: 'client' }) === true, 'already a client: blocked');
}

console.log('-- joining: a lobby id that is not one');
{
  const b = makeBridge();
  for (const bad of ['0x10', '', 'abc', null, '12 3']) {
    let threw = null;
    try { await joinViaSteam(makeLobby(), bad, { pollMs: 5, waitMs: 20 }); } catch (e) { threw = e; }
    ok(threw instanceof Error, `${JSON.stringify(bad)} is refused before any Steam call`);
  }
  ok(!b.calls.some(([n]) => n === 'joinLobby'), 'joinLobby was never reached');
  delete globalThis.window;
}

console.log('-- the invite dialog reports a missing overlay instead of pretending');
{
  const b = makeBridge();
  const res = await openSteamInvite('109775241996081388');
  ok(res.ok === true, 'the dialog opens when the overlay is there');
  ok(b.calls.some(([n, id]) => n === 'openInviteDialog' && id === '109775241996081388'), 'against the right lobby');
  delete globalThis.window;

  makeBridge({ async openInviteDialog() { return { ok: true, overlay: false }; } });
  let threw = null;
  try { await openSteamInvite('1'); } catch (e) { threw = e; }
  ok(threw instanceof Error && /overlay/i.test(threw.message), `no overlay is an error, not a dead button (${threw && threw.message})`);
  delete globalThis.window;
}

console.log('-- friends-list invites: a lobby id only, and only a real one');
{
  const b = makeBridge();
  const seen = [];
  const off = onSteamInvite((id) => seen.push(id));
  for (const cb of [...b.listeners.join]) {
    cb({ lobbyId: '109775241996081388' });
    cb({ lobbyId: 'not-an-id' });
    cb({});
    cb(null);
  }
  ok(JSON.stringify(seen) === JSON.stringify(['109775241996081388']), `only the well-formed id got through (${JSON.stringify(seen)})`);
  off();
  for (const cb of [...b.listeners.join]) cb({ lobbyId: '1' });
  ok(seen.length === 1, 'and unsubscribing works');
  delete globalThis.window;

  ok(onSteamInvite(() => {}) === null, 'with no bridge it is null, so a browser can register it unconditionally');
}

// ------------------------------------------- the real Lobby's dispose path

console.log('-- the real src/net/Lobby.js runs the Steam teardown from leave()');
{
  const handlers = new Map();
  const ctx = {
    netRole: 'single', authority: true,
    events: { on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); }, emit: () => {} },
  };
  const engine = { systems: [], add(s) { this.systems.push(s); s.init?.(ctx); return s; }, remove(s) { this.systems.splice(this.systems.indexOf(s), 1); return s; } };
  const lobby = new Lobby(engine, ctx);

  let torn = 0;
  lobby._steamCleanup = () => { torn++; };
  lobby.leave();
  ok(torn === 1, `leave() ran the Steam teardown (${torn})`);
  ok(lobby._steamCleanup === null, 'and cleared the slot');
  lobby.leave();
  ok(torn === 1, 'a second leave() does not re-tear a session that is already gone');

  // The web build's whole experience of this line.
  const plain = new Lobby(engine, ctx);
  let threw = null;
  try { plain.leave(); } catch (e) { threw = e; }
  ok(threw === null, 'a Lobby that never saw Steam leaves without a murmur');
}

console.log('\n-- the friend picker: the list, in the order a picker wants it');
{
  const b = makeBridge();
  const friends = await listSteamFriends();
  ok(b.calls.some(([n]) => n === 'listFriends'), 'the bridge was asked');
  ok(friends.map((f) => f.personaName).join(',') === 'Bo,Ash,Zoe,Ada',
    `in this game, then online by name, then offline (got ${friends.map((f) => f.personaName).join(',')})`);
  delete globalThis.window;

  // An empty friends list is NOT an error: it is a picker that says so.
  makeBridge({ async listFriends() { return { friends: [] }; } });
  ok((await listSteamFriends()).length === 0, 'no friends is an empty list, not a throw');
  delete globalThis.window;

  makeBridge({ async listFriends() { return { friends: 'not an array' }; } });
  ok((await listSteamFriends()).length === 0, 'and neither is a bridge that answers with the wrong shape');
  delete globalThis.window;

  // The graceful states the picker has to render.
  makeBridge({ async listFriends() { return { error: 'friends-unavailable' }; } });
  let threw2 = null;
  try { await listSteamFriends(); } catch (e) { threw2 = e; }
  ok(threw2 instanceof Error && /friends list/i.test(threw2.message),
    `a Binding without a friends list explains itself in words (${threw2 && threw2.message})`);
  delete globalThis.window;

  globalThis.window = {};
  let threw3 = null;
  try { await listSteamFriends(); } catch (e) { threw3 = e; }
  ok(threw3 instanceof Error, 'and a build with no bridge at all throws rather than hanging the picker');
  delete globalThis.window;
}

console.log('\n-- the friend picker: sending one invite');
{
  const b = makeBridge();
  await inviteSteamFriend('109775241996081388', '76561198037383365');
  ok(b.calls.some(([n, l, s]) => n === 'inviteFriend' && l === '109775241996081388' && s === '76561198037383365'),
    'the lobby and the friend both reach the bridge as decimal strings');
  delete globalThis.window;

  makeBridge({ async inviteFriend() { return { error: 'invite-refused' }; } });
  let threw2 = null;
  try { await inviteSteamFriend('1', '2'); } catch (e) { threw2 = e; }
  ok(threw2 instanceof Error && /would not deliver/i.test(threw2.message),
    `a refused invite is said out loud (${threw2 && threw2.message})`);
  delete globalThis.window;
}

console.log('\n-- the launch-time invite: collected once, and only if it is an id');
{
  makeBridge({ async pendingJoin() { return { lobbyId: '109775241996081388' }; } });
  ok(await pendingSteamJoin() === '109775241996081388', 'a parked lobby id is handed over');
  delete globalThis.window;

  makeBridge();
  ok(await pendingSteamJoin() === null, 'a cold launch parks nothing');
  delete globalThis.window;

  makeBridge({ async pendingJoin() { return { lobbyId: 'not-an-id' }; } });
  ok(await pendingSteamJoin() === null, 'and a command line carrying junk is not believed on this side either');
  delete globalThis.window;

  makeBridge({ async pendingJoin() { throw new Error('bridge died'); } });
  ok(await pendingSteamJoin() === null, 'a throwing bridge cannot fail the boot for want of an invite');
  delete globalThis.window;

  globalThis.window = {};
  ok(await pendingSteamJoin() === null, 'and a browser answers null without ever touching a channel');
  delete globalThis.window;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
