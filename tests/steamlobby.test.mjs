/**
 * Task 3 — the Steam signalling module.
 *
 *   node tests/steamlobby.test.mjs
 *
 * Two halves:
 *
 *  1. The chunk codec, pure. An SDP offer is a few kilobytes; a Steam lobby-data
 *     value is capped (the bridge enforces 7000 chars per value), so the offer
 *     travels as `sdp.offer.n` + `sdp.offer.0..k-1`. This half is the brief's
 *     specified test.
 *  2. The dance, against a fake `window.__STEAM__` that answers with the exact
 *     shapes task-2-report.md documents. The point of this half is the paths
 *     that are not the happy one: no bridge at all, `available: false`, a peer
 *     that writes garbage, a join abandoned mid-poll, and `Lobby.leave()`.
 *
 * Self-contained: no browser, no Electron, no Steam. `window` is created here,
 * which is exactly how the module's own guard is exercised rather than bypassed.
 */
import { chunkBlob, assembleBlob, steamAvailable, hostViaSteam, joinViaSteam, onSteamInvite, openSteamInvite, CHUNK_CHARS } from '../src/net/SteamLobby.js';
import { Lobby } from '../src/net/Lobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// ---------------------------------------------------------------- the codec

console.log('-- chunkBlob / assembleBlob: a 20 kB blob survives the round trip');
{
  // Random-ish rather than random: the failure this guards against is an
  // off-by-one at a chunk boundary, and a fixed string makes that reproducible.
  let blob = '';
  let x = 123456789;
  while (blob.length < 20000) {
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
  const blob = 'A'.repeat(15000);
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

/** Enough of `src/net/Lobby.js` to see what the dance does to it. */
function makeLobby(over = {}) {
  return {
    statuses: [],
    accepted: [],
    joined: [],
    _set(s, d) { this.statuses.push([s, d]); },
    async createInvite() { return { id: 1, blob: 'OFFER-BLOB-' + 'z'.repeat(12000) }; },
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
  ok(assembleBlob((k) => (k in written ? written[k] : null), 'sdp.offer') === 'OFFER-BLOB-' + 'z'.repeat(12000),
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

console.log('-- hosting: an invite too large for lobby data is refused, and leaves nothing');
{
  const b = makeBridge();
  // 63 parts is the ceiling (the bridge caps a record at 64 keys and one of
  // ours is the count), so 64 parts' worth of blob is the first refusal.
  const lobby = makeLobby({ async createInvite() { return { id: 1, blob: 'q'.repeat(64 * CHUNK_CHARS) }; } });
  let threw = null;
  try { await hostViaSteam(lobby); } catch (e) { threw = e; }
  ok(threw instanceof Error && /too large/.test(threw.message), `it is refused before the write (${threw && threw.message})`);
  ok(!b.calls.some(([n]) => n === 'writeLobbyData'), 'nothing was written, so no half-blob sits in the lobby');
  ok(b.calls.some(([n]) => n === 'leaveLobby'), 'and the Steam lobby was left');

  // One part under the ceiling still goes through -- the guard is a ceiling,
  // not an off-by-one that rejects a legal invite.
  const b2 = makeBridge();
  const ok63 = makeLobby({ async createInvite() { return { id: 1, blob: 'q'.repeat(63 * CHUNK_CHARS) }; } });
  let threw2 = null;
  try { await hostViaSteam(ok63); } catch (e) { threw2 = e; }
  ok(threw2 === null, `exactly 63 parts is accepted (${threw2 && threw2.message})`);
  ok(Object.keys(b2.calls.find(([n]) => n === 'writeLobbyData')[2]).length === 64, 'and writes 64 keys -- the bridge cap, exactly');
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
  ok(joiner.joined.length === 1 && joiner.joined[0] === 'OFFER-BLOB-' + 'z'.repeat(12000),
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
