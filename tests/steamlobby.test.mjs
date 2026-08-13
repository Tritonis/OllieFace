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
import { chunkBlob, assembleBlob, steamAvailable, hostViaSteam, joinViaSteam, onSteamInvite, openSteamInvite, CHUNK_CHARS, MAX_LOBBY_TOTAL_BYTES, recordBytes } from '../src/net/SteamLobby.js';
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
    async sendSignal(to, payload) { calls.push(['sendSignal', to, payload]); return { ok: true }; },
    async startSignalListen(id) { calls.push(['startSignalListen', id]); return { ok: true }; },
    stopSignalListen: record('stopSignalListen'),
    async openInviteDialog(id) { calls.push(['openInviteDialog', id]); return { ok: true, overlay: true }; },
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

console.log('-- hosting: lobby, offer, listener, and the answer that comes back as a packet');
{
  const b = makeBridge();
  const lobby = makeLobby();

  const res = await hostViaSteam(lobby);
  ok(res && res.lobbyId === '109775241996081388', `resolves { lobbyId } (${JSON.stringify(res)})`);

  const order = b.calls.map(([n]) => n).filter((n) => n !== 'status');
  ok(JSON.stringify(order) === JSON.stringify(['hostLobby', 'writeLobbyData', 'startSignalListen']),
    `the order is host -> write -> listen (${order.join(' -> ')})`);
  ok(b.calls.find(([n]) => n === 'hostLobby')[1] === 2, 'the lobby is opened for two');

  const written = b.calls.find(([n]) => n === 'writeLobbyData')[2];
  ok(Object.keys(written).every((k) => k.startsWith('sdp.offer.')), `only sdp.offer keys were written (${Object.keys(written).sort().join(',')})`);
  ok(assembleBlob((k) => (k in written ? written[k] : null), 'sdp.offer') === OFFER_FIXTURE,
    'the written chunks reassemble into exactly the invite blob');
  ok(lobby.statuses.some(([s]) => s === 'roomOpen'), 'the Lobby reached roomOpen, the same status hostViaRelay sets');

  // Garbage first: this is another player's packet, and the bridge is one bug
  // away from being wrong about it.
  for (const junk of [undefined, null, {}, { payload: '' }, { payload: '   ' }, { payload: 42 }, { payload: {} }]) {
    for (const cb of [...b.listeners.signal]) await cb(junk);
  }
  ok(lobby.accepted.length === 0, `no malformed packet reached acceptAnswer (${lobby.accepted.length})`);
  ok(b.listeners.signal.size === 1, 'and the listener is still armed for the real answer');

  for (const cb of [...b.listeners.signal]) await cb({ fromSteamId: '76561198037383365', payload: '  ANSWER-BLOB  ' });
  ok(lobby.accepted.length === 1 && lobby.accepted[0] === 'ANSWER-BLOB', `the answer reached acceptAnswer, trimmed (${JSON.stringify(lobby.accepted)})`);
  ok(b.calls.some(([n]) => n === 'stopSignalListen'), 'and the listen stopped once the exchange was over');
  ok(b.listeners.signal.size === 0, 'a second packet cannot start a second exchange');
  delete globalThis.window;
}

console.log('-- hosting: an answer acceptAnswer rejects does not throw out of the bridge callback');
{
  const b = makeBridge();
  const lobby = makeLobby({ async acceptAnswer() { throw new Error('no pending invite matches that code'); } });
  await hostViaSteam(lobby);
  let threw = null;
  try { for (const cb of [...b.listeners.signal]) await cb({ payload: 'JUNK-ANSWER' }); } catch (e) { threw = e; }
  ok(threw === null, `the callback swallowed it (${threw && threw.message})`);
  ok(b.calls.some(([n]) => n === 'stopSignalListen'), 'and still stopped listening');
  delete globalThis.window;
}

console.log('-- hosting: abandoned midway -- every failure point leaves no Steam lobby behind');
{
  const cases = [
    ['writeLobbyData refused', { async writeLobbyData(id, r) { this.calls.push(['writeLobbyData', id, r]); return { error: 'lobby-data-value-too-long' }; } }, {}],
    ['startSignalListen refused', { async startSignalListen(id) { this.calls.push(['startSignalListen', id]); return { error: 'not-a-member' }; } }, {}],
    ['createInvite threw', {}, { async createInvite() { throw new Error('Already networked'); } }],
  ];
  for (const [name, bo, lo] of cases) {
    const b = makeBridge(bo);
    const lobby = makeLobby(lo);
    let threw = null;
    try { await hostViaSteam(lobby); } catch (e) { threw = e; }
    ok(threw instanceof Error, `${name}: rejects with an Error (${threw && threw.message})`);
    ok(b.calls.some(([n, id]) => n === 'leaveLobby' && id === '109775241996081388'), `${name}: the Steam lobby was left`);
    ok(b.calls.some(([n]) => n === 'stopSignalListen'), `${name}: and the listen was stopped`);
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
  await hostViaSteam(lobby);
  await hostViaSteam(lobby);
  ok(opened.length === 1 && opened[0] === '101',
    `only the newest Steam lobby is still held (${JSON.stringify(opened)})`);
  ok(b.calls.some(([nm, id]) => nm === 'leaveLobby' && id === '100'), 'the first was left, by its own latch');
  ok(b.listeners.signal.size === 1 && b.listeners.fail.size === 1,
    `and no listeners piled up (signal=${b.listeners.signal.size}, fail=${b.listeners.fail.size})`);

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
  const b = makeBridge({ onSignal() { return () => { throw new Error('removeListener blew up'); }; } });
  const lobby = makeLobby();
  await hostViaSteam(lobby);
  let threw = null;
  try { lobby._steamCleanup(); } catch (e) { threw = e; }
  ok(threw === null, `the teardown did not throw at its caller (${threw && threw.message})`);
  ok(b.calls.some(([n]) => n === 'stopSignalListen'), 'the step after the throwing one still ran');
  ok(b.calls.some(([n, id]) => n === 'leaveLobby' && id === '109775241996081388'), 'and the Steam lobby was still left');
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

  const order = b.calls.slice(hostCalls).map(([n]) => n).filter((n) => n !== 'status');
  ok(JSON.stringify(order) === JSON.stringify(['joinLobby', 'getFullLobbyData', 'getLobbyOwner', 'sendSignal']),
    `join -> poll -> owner -> answer (${order.join(' -> ')})`);
  ok(joiner.joined.length === 1 && joiner.joined[0] === OFFER_FIXTURE,
    'joinManual got the reassembled offer, byte for byte');
  const sent = b.calls.find(([n]) => n === 'sendSignal');
  ok(sent[1] === '76561198037383365', `the answer is addressed to the lobby owner (${sent[1]})`);
  ok(sent[2] === 'ANSWER-BLOB', 'and carries exactly what joinManual returned');
  ok(!b.calls.slice(hostCalls).some(([n]) => n === 'leaveLobby'),
    'the joiner stays in the lobby -- the host only accepts P2P from a current member');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
