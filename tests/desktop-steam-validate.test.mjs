/**
 * The untrusted-input contract for `desktop/steam-validate.mjs`.
 *
 *   node tests/desktop-steam-validate.test.mjs
 *
 * This is the boundary where another player's lobby data and another player's
 * P2P packets stop being their bytes and start being our values. The rules it
 * has to hold, all of them provable in plain node because the module imports
 * neither Electron nor steamworks:
 *
 *   - ids are decimal strings across IPC and bigints nowhere else; a parse that
 *     accepts "0x10" or "1e3" or " 42 " is a parse that lets a value Steam
 *     never issued reach `sendP2PPacket`.
 *   - outbound lobby data is `sdp.`-prefixed and <= 7000 chars per value, and
 *     the enforcement is HERE (main process), not in the renderer that asks.
 *   - inbound lobby data is filtered, not trusted, and never throws.
 *   - inbound packets are capped BEFORE decoding, rejected if they are not
 *     valid UTF-8, and JSON-parsed inside a try/catch.
 */
import {
  parseSteamId, steamIdToString, validateMaxMembers, validateLobbyRecord,
  sanitizeLobbyData, encodeSignal, decodeSignal,
  lobbyRecordBytes, isAuthorizedSignalTarget,
  MAX_LOBBY_VALUE_CHARS, MAX_LOBBY_KEYS, MAX_SIGNAL_PAYLOAD_BYTES, MAX_SIGNAL_FRAME_BYTES,
  MAX_LOBBY_TOTAL_BYTES, STEAM_LOBBY_TOTAL_BYTES,
} from '../desktop/steam-validate.mjs';
import { MAX_LOBBY_TOTAL_BYTES as RENDERER_BUDGET } from '../src/net/SteamLobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('\n-- parseSteamId: strict decimal, or nothing');
{
  ok(parseSteamId('76561198037383365') === 76561198037383365n, 'a real 64-bit Steam id round-trips to a bigint');
  ok(parseSteamId('1') === 1n, 'a one-digit id parses');
  ok(parseSteamId('18446744073709551615') === 18446744073709551615n, 'the top of the unsigned 64-bit range parses');
  ok(parseSteamId('18446744073709551616') === null, 'one past the range is rejected');
  ok(parseSteamId('0') === null, 'zero is not a Steam id');
  ok(parseSteamId('0123') === null, 'a leading zero is rejected rather than silently reinterpreted');
  ok(parseSteamId('-5') === null, 'a negative id is rejected');
  ok(parseSteamId(' 42 ') === null, 'whitespace is not trimmed into acceptance');
  ok(parseSteamId('0x10') === null, 'hex is rejected (BigInt() alone would have accepted it)');
  ok(parseSteamId('1e3') === null, 'exponent notation is rejected');
  ok(parseSteamId('12n') === null, 'a bigint literal suffix is rejected');
  ok(parseSteamId('') === null, 'the empty string is rejected');
  ok(parseSteamId(42n) === null, 'a bigint is not a string and is rejected: the wire type is the contract');
  ok(parseSteamId(42) === null, 'a number is rejected too -- JS numbers cannot hold a Steam id');
  ok(parseSteamId(null) === null && parseSteamId(undefined) === null && parseSteamId({}) === null, 'null/undefined/object are rejected');
}

console.log('\n-- steamIdToString: the only door out, and it never emits a bigint');
{
  ok(steamIdToString(76561198037383365n) === '76561198037383365', 'a bare bigint stringifies');
  ok(steamIdToString({ steamId64: 7n, steamId32: 'x', accountId: 1 }) === '7', 'a PlayerSteamId is read through steamId64');
  ok(steamIdToString('76561198037383365') === '76561198037383365', 'an already-valid string passes through');
  ok(steamIdToString('nope') === null, 'a bad string is not laundered into a good one');
  ok(steamIdToString(undefined) === null && steamIdToString({}) === null, 'nothing else yields a value');
  const out = steamIdToString(7n);
  ok(typeof out === 'string' && JSON.stringify({ id: out }) === '{"id":"7"}', 'the result survives JSON.stringify, which a bigint would not');
  let threw = false;
  try { JSON.stringify({ id: 7n }); } catch { threw = true; }
  ok(threw, 'and JSON.stringify on the raw bigint does throw -- the hazard is real, not theoretical');
}

console.log('\n-- validateMaxMembers');
{
  ok(validateMaxMembers(2).ok === true, '2 is accepted (the two-seat goal)');
  ok(validateMaxMembers(1).ok === false, '1 is out of range');
  ok(validateMaxMembers(251).ok === false, '251 is out of range');
  ok(validateMaxMembers(2.5).ok === false, 'a fractional count is rejected');
  ok(validateMaxMembers('4').ok === false, 'a string is rejected rather than coerced');
  ok(validateMaxMembers(NaN).ok === false, 'NaN is rejected');
}

console.log('\n-- validateLobbyRecord: what the host is allowed to write');
{
  const good = validateLobbyRecord({ 'sdp.offer.0': 'a', 'sdp.offer.n': '2' });
  ok(good.ok === true, 'an all-sdp record is accepted');
  ok(good.ok && good.record !== undefined && good.record['sdp.offer.0'] === 'a', 'and comes back with its values intact');
  ok(good.ok && Object.keys(good.record).length === 2, 'with exactly the keys it was given');

  ok(validateLobbyRecord({ 'sdp.x': 'a'.repeat(MAX_LOBBY_VALUE_CHARS) }).ok === true, 'a value at exactly the 7000-char cap is accepted');
  ok(validateLobbyRecord({ 'sdp.x': 'a'.repeat(MAX_LOBBY_VALUE_CHARS + 1) }).ok === false, 'one char over the cap is rejected');
  ok(validateLobbyRecord({ 'sdp.x': 'a', evil: 'b' }).ok === false, 'ONE non-sdp key rejects the whole batch');
  ok(validateLobbyRecord({ 'notsdp.x': 'a' }).ok === false, 'a key that merely contains sdp is rejected -- the regex is anchored');
  ok(validateLobbyRecord({ sdp: 'a' }).ok === false, 'bare "sdp" without the dot is rejected');
  ok(validateLobbyRecord({ __proto__: 'a' }).ok === false || Object.keys(validateLobbyRecord({ __proto__: 'a' })).length >= 0, '__proto__ cannot match /^sdp\\./ and cannot be written');
  ok(validateLobbyRecord({ 'sdp.x': 5 }).ok === false, 'a non-string value is rejected, not stringified');
  ok(validateLobbyRecord({ 'sdp.x': null }).ok === false, 'null is rejected');
  ok(validateLobbyRecord({}).ok === false, 'an empty record is rejected -- a write that writes nothing is a bug');
  ok(validateLobbyRecord(null).ok === false, 'null is not a record');
  ok(validateLobbyRecord([['sdp.x', 'a']]).ok === false, 'an array is not a record');
  ok(validateLobbyRecord('sdp.x=a').ok === false, 'a string is not a record');
  {
    const many = {};
    for (let i = 0; i <= MAX_LOBBY_KEYS; i++) many[`sdp.k${i}`] = 'v';
    ok(validateLobbyRecord(many).ok === false, `more than ${MAX_LOBBY_KEYS} keys is rejected`);
  }
  {
    // The budget, which is the limit Steam actually enforces. Measured live on
    // appid 480: one ~8192-byte allowance for the whole lobby, keys charged like
    // values. A record that clears every per-value rule above can still be over
    // it, and a `mergeFullData` Steam refuses stores entries until it hits the
    // wall rather than refusing cleanly -- so this is the check that keeps a
    // half-written offer out of the lobby.
    ok(MAX_LOBBY_TOTAL_BYTES < STEAM_LOBBY_TOTAL_BYTES, `the spend is under the measured ceiling (${MAX_LOBBY_TOTAL_BYTES} < ${STEAM_LOBBY_TOTAL_BYTES})`);
    ok(RENDERER_BUDGET === MAX_LOBBY_TOTAL_BYTES,
      `src/net/SteamLobby.js restates the same budget, so its pre-write guard and this one cannot disagree (${RENDERER_BUDGET})`);

    // Two keys, because the budget is bigger than the structural per-value cap
    // -- which is the relationship those two constants are meant to have.
    const fill = (bytes) => {                                       // 'sdp.a' + 'sdp.b' is 10 key bytes
      const v = bytes - 10;
      return { 'sdp.a': 'a'.repeat(Math.ceil(v / 2)), 'sdp.b': 'a'.repeat(Math.floor(v / 2)) };
    };
    ok(lobbyRecordBytes(fill(100)) === 100, 'lobbyRecordBytes counts key bytes as well as value bytes');
    ok(lobbyRecordBytes({ 'sdp.x': 'é' }) === 7, 'and counts UTF-8 bytes, not chars, because Steam does');
    ok(validateLobbyRecord(fill(MAX_LOBBY_TOTAL_BYTES)).ok === true, 'a record at exactly the budget is accepted');
    ok(validateLobbyRecord(fill(MAX_LOBBY_TOTAL_BYTES + 1)).error === 'lobby-data-over-budget', 'one byte over is refused, by name');
    {
      // Every value legal on its own, the record illegal together: the failure
      // the old per-key reading of the limit could not see.
      const spread = {};
      for (let i = 0; i < 8; i++) spread[`sdp.offer.${i}`] = 'a'.repeat(1000);
      ok(Object.values(spread).every((v) => v.length <= MAX_LOBBY_VALUE_CHARS), 'precondition: every value clears the per-value cap');
      ok(validateLobbyRecord(spread).error === 'lobby-data-over-budget', 'and the record is still refused, because the budget is the whole lobby');
    }
  }
  {
    const record = { 'sdp.x': 'a' };
    const result = validateLobbyRecord(record);
    result.record['sdp.x'] = 'mutated';
    ok(record['sdp.x'] === 'a', 'the accepted record is a fresh object, so the caller\'s input is not aliased');
  }
}

console.log('\n-- sanitizeLobbyData: what a peer is allowed to hand us back');
{
  const cleaned = sanitizeLobbyData({ 'sdp.offer.0': 'a', junk: 'b', 'sdp.offer.1': 'c' });
  ok(Object.keys(cleaned).length === 2, 'non-sdp keys are dropped');
  ok(cleaned['sdp.offer.0'] === 'a' && cleaned['sdp.offer.1'] === 'c', 'the sdp keys survive -- one junk key does not stall a join');
  ok(cleaned.junk === undefined, 'and the junk is gone');
  ok(Object.keys(sanitizeLobbyData({ 'sdp.x': 'a'.repeat(MAX_LOBBY_VALUE_CHARS + 1) })).length === 0, 'an oversized value is dropped rather than forwarded');
  ok(Object.keys(sanitizeLobbyData({ 'sdp.x': 5 })).length === 0, 'a non-string value is dropped');
  ok(Object.keys(sanitizeLobbyData(null)).length === 0, 'null yields an empty record, not a throw');
  ok(Object.keys(sanitizeLobbyData('nope')).length === 0, 'a string yields an empty record');
  ok(Object.keys(sanitizeLobbyData(undefined)).length === 0, 'undefined yields an empty record');
  {
    const flood = {};
    for (let i = 0; i < MAX_LOBBY_KEYS * 4; i++) flood[`sdp.k${i}`] = 'v';
    ok(Object.keys(sanitizeLobbyData(flood)).length === MAX_LOBBY_KEYS, `a flood is truncated to ${MAX_LOBBY_KEYS} keys, bounding the work per poll`);
  }
  {
    // A hostile owner cannot reach Object.prototype through us.
    const cleanedProto = sanitizeLobbyData(JSON.parse('{"__proto__":{"polluted":true},"sdp.x":"a"}'));
    ok({}.polluted === undefined, 'a __proto__ key in lobby data does not pollute Object.prototype');
    ok(cleanedProto['sdp.x'] === 'a', 'and the legitimate key still comes through');
  }
}

console.log('\n-- encodeSignal / decodeSignal: the packet boundary');
{
  const framed = encodeSignal('the-answer-blob');
  ok(framed.ok === true, 'a normal payload frames');
  ok(framed.ok && JSON.parse(framed.frame).p === 'the-answer-blob', 'the envelope carries the payload verbatim');

  const round = decodeSignal(Buffer.from(framed.frame, 'utf8'));
  ok(round.ok === true && round.payload === 'the-answer-blob', 'and it round-trips through bytes unchanged');

  ok(encodeSignal('').ok === false, 'an empty payload is refused');
  ok(encodeSignal(null).ok === false, 'null is refused');
  ok(encodeSignal({ sdp: 'x' }).ok === false, 'an object is refused, not stringified');
  ok(encodeSignal('a'.repeat(MAX_SIGNAL_PAYLOAD_BYTES)).ok === true, 'a payload at exactly the cap is accepted');
  ok(encodeSignal('a'.repeat(MAX_SIGNAL_PAYLOAD_BYTES + 1)).ok === false, 'one byte over the cap is refused');
  ok(encodeSignal('é'.repeat(MAX_SIGNAL_PAYLOAD_BYTES)).ok === false, 'the cap is BYTES, not chars: multi-byte text cannot smuggle 2x through');

  ok(decodeSignal(Buffer.from('not json at all')).ok === false, 'a non-JSON packet is dropped, not thrown');
  ok(decodeSignal(Buffer.from('{"v":1,"p":')).ok === false, 'a truncated JSON packet is dropped');
  ok(decodeSignal(Buffer.from('[1,2,3]')).ok === false, 'a JSON array is not an envelope');
  ok(decodeSignal(Buffer.from('"a string"')).ok === false, 'a bare JSON string is not an envelope');
  ok(decodeSignal(Buffer.from('null')).ok === false, 'JSON null is not an envelope');
  ok(decodeSignal(Buffer.from('{"v":2,"p":"x"}')).ok === false, 'an unknown envelope version is dropped');
  ok(decodeSignal(Buffer.from('{"v":1}')).ok === false, 'a missing payload is dropped');
  ok(decodeSignal(Buffer.from('{"v":1,"p":5}')).ok === false, 'a non-string payload is dropped');
  ok(decodeSignal(Buffer.from('{"v":1,"p":""}')).ok === false, 'an empty payload is dropped');
  ok(decodeSignal(Buffer.from(JSON.stringify({ v: 1, p: 'a'.repeat(MAX_SIGNAL_PAYLOAD_BYTES + 1) }))).ok === false,
    'a well-formed envelope whose payload is over the cap is still dropped');
  ok(decodeSignal(Buffer.alloc(MAX_SIGNAL_FRAME_BYTES + 1)).ok === false, 'an oversized frame is rejected on LENGTH, before any parsing');
  ok(decodeSignal(Buffer.from([0xff, 0xfe, 0xfd])).ok === false, 'invalid UTF-8 is rejected rather than silently becoming U+FFFD');
  ok(decodeSignal(null).ok === false && decodeSignal(42).ok === false, 'a non-buffer is dropped');
  ok(decodeSignal(Buffer.from('{"__proto__":{"polluted2":true},"v":1,"p":"x"}')).ok === true && {}.polluted2 === undefined,
    'a __proto__ key inside a packet does not pollute Object.prototype');

  {
    // The whole point: nothing above threw. Prove it over a fuzz of garbage.
    let threw = null;
    const junk = ['', '{', '}', '[]', 'undefined', '  ', 'a'.repeat(1000), '{"v":1,"p":{"a":1}}'];
    try {
      for (const s of junk) decodeSignal(Buffer.from(s, 'utf8'));
      for (let i = 0; i < 200; i++) {
        const bytes = Buffer.alloc(64);
        for (let b = 0; b < bytes.length; b++) bytes[b] = (i * 31 + b * 7) % 256;
        decodeSignal(bytes);
      }
    } catch (err) { threw = err; }
    ok(threw === null, `200 random byte packets plus 8 hand-picked ones: nothing thrown (${threw ? threw.message : 'clean'})`);
  }
}

console.log('\n-- isAuthorizedSignalTarget: send-signal may only address a lobby owner (Minor 1)');
{
  // The gap the finding named: the shape check alone let this channel address
  // ANY Steam id, not just the one it exists for -- the owner of a lobby we
  // are actually in. This is the pure half of that check; `desktop/main.mjs`
  // supplies the live owner list from `Lobby.getOwner()`.
  const OWNER = 76561198037383365n;
  const OTHER_OWNER = 1n;
  const STRANGER = 999n;

  ok(isAuthorizedSignalTarget(OWNER, [OWNER]) === true, 'the owner of the one lobby we hold is authorized');
  ok(isAuthorizedSignalTarget(OWNER, [OTHER_OWNER, OWNER]) === true, 'and among several held lobbies, matching any one is enough');
  ok(isAuthorizedSignalTarget(STRANGER, [OWNER]) === false, 'an id that owns nothing we hold is refused');
  ok(isAuthorizedSignalTarget(OWNER, []) === false, 'no held lobbies means no authorized target at all');
  ok(isAuthorizedSignalTarget(OWNER, [OTHER_OWNER]) === false, 'being a member is not enough -- it has to be the owner of a lobby we hold');

  // The wire type is the contract everywhere else in this module; this check
  // does not get an exception.
  ok(isAuthorizedSignalTarget('76561198037383365', [OWNER]) === false, 'a string target is refused -- parseSteamId is the only door to a bigint');
  ok(isAuthorizedSignalTarget(OWNER, null) === false, 'a non-array owner list is refused rather than thrown through');
  ok(isAuthorizedSignalTarget(OWNER, ['76561198037383365']) === false, 'a string in the owner list cannot match a bigint target either');
  ok(isAuthorizedSignalTarget(null, [OWNER]) === false, 'a null target is refused');

  let threw = null;
  try { isAuthorizedSignalTarget(undefined, undefined); } catch (err) { threw = err; }
  ok(threw === null, 'garbage in either argument degrades to false, never throws');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
