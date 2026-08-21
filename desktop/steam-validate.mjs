/**
 * The validation half of the Steam bridge, kept free of Electron and of
 * steamworks.js so it can be unit-tested in plain node
 * (`tests/desktop-steam-validate.test.mjs`).
 *
 * EVERYTHING THAT CROSSES THIS MODULE IS UNTRUSTED. Lobby data is written by
 * whoever owns the lobby and P2P packets are written by whoever is on the other
 * end of the wire — neither is us, and neither has to be friendly. So every
 * function here is total: it returns a verdict, it never throws, and it never
 * hands back a value it has not measured.
 *
 * The other standing hazard is `bigint`. Steam ids and lobby ids are bigints,
 * `JSON.stringify` THROWS on a bigint, and Electron's IPC would carry one into
 * a renderer that then explodes on its own `JSON.stringify`. So ids cross as
 * decimal STRINGS in both directions, and `parseSteamId` is the only door back
 * to a bigint.
 */

/** Lobby-data keys the bridge will read or write. Also the prototype-pollution
 *  guard: `__proto__` and `constructor` cannot match it. */
export const LOBBY_KEY_RE = /^sdp\./;

/**
 * Steam's lobby metadata limit is ONE BUDGET FOR THE WHOLE LOBBY, not a per-key
 * cap. This is measured, not read off a wiki: against the live client on
 * appid 480, `Lobby.setData` accepts a single 8174-char value under an 11-byte
 * key (8185 raw bytes of key + value) and refuses at 8175, while *multi-entry*
 * lobbies refuse far earlier in raw bytes — 15 x 500-char values under
 * `sdp.offer.<i>` keys were accepted (7670 raw bytes) and the 16th (which would
 * have made 8182) was refused, 74 x 100-char values under 7-byte keys were
 * accepted (7918 raw) and the 75th refused, 48 x 100-char values under 67-byte
 * keys were accepted (8016 raw) and the 49th refused.
 *
 * Two things follow, and both were previously stated backwards here:
 *
 *  - key text counts against the budget exactly as value text does (the 7-byte
 *    and 67-byte key runs stop at nearly the same key+value total, not at the
 *    same value total), and
 *  - Steam charges roughly 3-4 bytes of framing per entry on top, which is why
 *    the raw ceiling falls as the key count rises.
 *
 * So the binding constraint is total bytes, ~8192, across every key and value
 * in the lobby at once.
 */
export const STEAM_LOBBY_TOTAL_BYTES = 8192;

/**
 * What we will actually spend of that budget.
 *
 * 8192 - 512. The 512-byte reserve covers per-entry framing at the structural
 * key ceiling below (64 keys x 4 bytes = 256) with 256 bytes still spare for
 * any non-`sdp.` metadata Steam or a later feature parks in the same lobby.
 * Deliberately a round number under a measured ceiling rather than the measured
 * ceiling itself: the measurement is of one Steam client build, and a write that
 * lands one byte inside the wall is a write that a patch can turn into a
 * silently half-written lobby.
 */
export const MAX_LOBBY_TOTAL_BYTES = 7680;

/**
 * A structural per-value cap, NOT a Steam limit — Steam has no per-key limit,
 * only the budget above. It survives as cheap bounds-checking on a value before
 * anything measures or concatenates it; `MAX_LOBBY_TOTAL_BYTES` makes it
 * unreachable in practice, and that is the intended relationship.
 */
export const MAX_LOBBY_VALUE_CHARS = 7000;
export const MAX_LOBBY_KEY_CHARS = 128;
/** Likewise structural: a bound on the work a hostile lobby owner can hand us
 *  per poll. The byte budget refuses long before this does. */
export const MAX_LOBBY_KEYS = 64;

/** An SDP answer is ~2-6 KB. Reliable P2P carries up to 1 MB, which is exactly
 *  why the cap has to be ours and not Steam's. */
export const MAX_SIGNAL_PAYLOAD_BYTES = 32 * 1024;
/** The JSON envelope adds `{"v":1,"p":""}` plus escaping. 4 KB of slack covers
 *  a fully-escaped payload without letting the cap drift upward meaningfully. */
export const MAX_SIGNAL_FRAME_BYTES = MAX_SIGNAL_PAYLOAD_BYTES + 4096;

const MAX_STEAM_ID = (1n << 64n) - 1n;

const isPlainRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A decimal Steam/lobby id string -> bigint, or null if it is not one.
 *
 * Deliberately strict: digits only, no sign, no whitespace, no exponent, no
 * leading zeroes beyond a bare "0", and inside the unsigned 64-bit range. A
 * lax parse here is how a renderer bug (or a spoofed id echoed back through the
 * renderer) reaches `sendP2PPacket` with something Steam never issued.
 *
 * @param {unknown} raw
 * @returns {bigint|null}
 */
export function parseSteamId(raw) {
  if (typeof raw !== 'string') return null;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(raw)) return null;
  let id;
  try { id = BigInt(raw); } catch { return null; }
  if (id <= 0n || id > MAX_STEAM_ID) return null;
  return id;
}

/** A bigint (or a `PlayerSteamId`-shaped thing) -> a decimal string, or null.
 *  The single conversion point on the way OUT; nothing containing a raw bigint
 *  is ever allowed to reach IPC or a `JSON.stringify`. */
export function steamIdToString(raw) {
  if (typeof raw === 'bigint') return raw.toString();
  if (typeof raw === 'string') return parseSteamId(raw) === null ? null : raw;
  if (raw && typeof raw === 'object' && typeof raw.steamId64 === 'bigint') return raw.steamId64.toString();
  return null;
}

/**
 * The renderer's `maxMembers` -> a lobby size Steam will accept.
 * @returns {{ ok: true, value: number }|{ ok: false, error: string }}
 */
export function validateMaxMembers(raw) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error: 'max-members-not-an-integer' };
  if (raw < 2 || raw > 250) return { ok: false, error: 'max-members-out-of-range' };
  return { ok: true, value: raw };
}

/**
 * OUTBOUND lobby data: what the host is about to write with `mergeFullData`.
 * Every key must be an `sdp.` key, every value must fit the structural cap, and
 * the record as a whole must fit `MAX_LOBBY_TOTAL_BYTES` — the last of those is
 * the one Steam actually enforces, and enforcing it here is what turns a
 * half-written lobby into a refusal the renderer can explain.
 *
 * All three are checked in the MAIN process so a compromised renderer cannot use
 * the lobby as a scratch store or spend the budget on something that is not an
 * SDP offer.
 *
 * @returns {{ ok: true, record: Record<string,string> }|{ ok: false, error: string }}
 */
export function validateLobbyRecord(raw) {
  if (!isPlainRecord(raw)) return { ok: false, error: 'lobby-data-not-a-record' };
  const entries = Object.entries(raw);
  if (entries.length === 0) return { ok: false, error: 'lobby-data-empty' };
  if (entries.length > MAX_LOBBY_KEYS) return { ok: false, error: 'lobby-data-too-many-keys' };

  const record = {};
  let bytes = 0;
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key.length > MAX_LOBBY_KEY_CHARS || !LOBBY_KEY_RE.test(key))
      return { ok: false, error: 'lobby-data-bad-key' };
    if (typeof value !== 'string') return { ok: false, error: 'lobby-data-value-not-a-string' };
    if (value.length > MAX_LOBBY_VALUE_CHARS) return { ok: false, error: 'lobby-data-value-too-long' };
    // Bytes, not chars: Steam counts UTF-8, and an SDP blob that ever carried a
    // non-ASCII byte would otherwise measure short here and be refused there.
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    record[key] = value;
  }
  if (bytes > MAX_LOBBY_TOTAL_BYTES) return { ok: false, error: 'lobby-data-over-budget' };
  return { ok: true, record };
}

/**
 * A renderer-supplied LIST of lobby-data keys to read back.
 *
 * `steam:collect-member-data` is the one bridge call the page drives with keys
 * of its own choosing, because the answer protocol (`sdp.answer.n`,
 * `sdp.answer.<i>`) belongs to `src/net/SteamLobby.js` and the shell has no
 * business knowing it. That makes the key list untrusted input in a place the
 * other handlers do not have one: unbounded, it is a way for a compromised page
 * to turn one IPC into thousands of native calls per poll tick.
 *
 * So it is bounded by the same two rules the write side already uses — the same
 * key shape and the same key count — and nothing else is accepted. ONE bad key
 * refuses the whole list rather than being skipped: a partial read is a partial
 * answer, and a partial answer is exactly the half-written state the byte-budget
 * guard exists to keep out of the poll.
 *
 * @returns {{ ok: true, keys: string[] }|{ ok: false, error: string }}
 */
export function validateLobbyKeys(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'lobby-keys-not-a-list' };
  if (raw.length === 0) return { ok: false, error: 'lobby-keys-empty' };
  if (raw.length > MAX_LOBBY_KEYS) return { ok: false, error: 'lobby-keys-too-many' };
  const keys = [];
  for (const key of raw) {
    if (typeof key !== 'string' || key.length > MAX_LOBBY_KEY_CHARS || !LOBBY_KEY_RE.test(key))
      return { ok: false, error: 'lobby-keys-bad-key' };
    keys.push(key);
  }
  return { ok: true, keys };
}

/**
 * The byte cost of a record against `MAX_LOBBY_TOTAL_BYTES`, for a caller that
 * wants to refuse *before* it asks. Keys and values both count; the per-entry
 * framing Steam adds is what the budget's reserve is for.
 *
 * Pure and dependency-free so the renderer's own guard
 * (`src/net/SteamLobby.js`) can compute the identical number without importing
 * anything from the desktop shell.
 */
export function lobbyRecordBytes(record) {
  let bytes = 0;
  for (const [key, value] of Object.entries(record ?? {}))
    bytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(String(value), 'utf8');
  return bytes;
}

/**
 * INBOUND lobby data: whatever `getFullData()` returned, which the lobby's
 * OWNER wrote and we do not control. Non-conforming entries are dropped
 * silently rather than failing the poll — one junk key from a peer with a newer
 * build must not stall a join that has every chunk it needs. Never throws.
 *
 * @returns {Record<string,string>}
 */
export function sanitizeLobbyData(raw) {
  const out = {};
  if (!isPlainRecord(raw)) return out;
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_LOBBY_KEYS) break;
    if (typeof key !== 'string' || key.length > MAX_LOBBY_KEY_CHARS || !LOBBY_KEY_RE.test(key)) continue;
    if (typeof value !== 'string' || value.length > MAX_LOBBY_VALUE_CHARS) continue;
    out[key] = value;
    kept++;
  }
  return out;
}

/**
 * Is `targetId` the owner of a lobby we currently hold? (Minor 1.) The
 * receive side of a P2P session is membership-gated (`isLobbyMember` in
 * `desktop/main.mjs`) but the send side — `steam:send-signal` — used to
 * address any Steam id the shape check let through, which matches the
 * adjudication's literal spec but leaves an asymmetry: a compromised renderer
 * could point a reliable 32 KB packet at an arbitrary Steam account instead
 * of only the one channel this bridge exists for, the joiner's answer to its
 * own lobby's owner.
 *
 * Pure and dependency-free, same reason `lobbyRecordBytes` is: the caller
 * (`desktop/main.mjs`) owns the live `Lobby` objects and their `getOwner()`
 * calls, which need Electron/steamworks and cannot be unit-tested here — this
 * is the part of the check that can be, so it is split out rather than left
 * buried in the handler.
 *
 * @param {bigint} targetId
 * @param {bigint[]} ownerIds - the owners of every lobby this process holds
 * @returns {boolean}
 */
export function isAuthorizedSignalTarget(targetId, ownerIds) {
  if (typeof targetId !== 'bigint') return false;
  if (!Array.isArray(ownerIds)) return false;
  return ownerIds.some((id) => id === targetId);
}

/**
 * OUTBOUND signal: the renderer's answer blob -> the exact text that goes on
 * the wire.
 *
 * The payload is opaque to the bridge (Task 3 owns its format), so the bridge
 * supplies its own JSON envelope. That envelope is the whole reason the receive
 * side has something structural to reject: raw bytes have no shape to check,
 * `{"v":1,"p":"..."}` does.
 *
 * @returns {{ ok: true, frame: string }|{ ok: false, error: string }}
 */
export function encodeSignal(payload) {
  if (typeof payload !== 'string') return { ok: false, error: 'signal-payload-not-a-string' };
  if (payload.length === 0) return { ok: false, error: 'signal-payload-empty' };
  if (Buffer.byteLength(payload, 'utf8') > MAX_SIGNAL_PAYLOAD_BYTES) return { ok: false, error: 'signal-payload-too-large' };
  return { ok: true, frame: JSON.stringify({ v: 1, p: payload }) };
}

/**
 * INBOUND signal: raw packet bytes -> a payload string, or a reason to drop it.
 *
 * This is the untrusted-input boundary the constraints name. In order: cap the
 * byte length BEFORE decoding, reject bytes that are not valid UTF-8 (a
 * `toString` on garbage silently yields U+FFFD rather than failing), JSON-parse
 * inside a try/catch, and check the envelope's shape field by field. Anything
 * that fails is a `{ ok: false }` the caller drops — never an exception into the
 * main process, and never an unvalidated value into the renderer.
 *
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {{ ok: true, payload: string }|{ ok: false, error: string }}
 */
export function decodeSignal(bytes) {
  let text;
  if (typeof bytes === 'string') {
    if (Buffer.byteLength(bytes, 'utf8') > MAX_SIGNAL_FRAME_BYTES) return { ok: false, error: 'signal-frame-too-large' };
    text = bytes;
  } else if (bytes instanceof Uint8Array) {
    if (bytes.length > MAX_SIGNAL_FRAME_BYTES) return { ok: false, error: 'signal-frame-too-large' };
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    text = buf.toString('utf8');
    // Round-trip: `toString('utf8')` replaces invalid sequences instead of
    // failing, so the only honest validity check is re-encoding.
    if (!Buffer.from(text, 'utf8').equals(buf)) return { ok: false, error: 'signal-not-utf8' };
  } else {
    return { ok: false, error: 'signal-not-bytes' };
  }

  let frame;
  try { frame = JSON.parse(text); } catch { return { ok: false, error: 'signal-not-json' }; }
  if (!isPlainRecord(frame)) return { ok: false, error: 'signal-not-an-envelope' };
  if (frame.v !== 1) return { ok: false, error: 'signal-bad-version' };
  const payload = frame.p;
  if (typeof payload !== 'string') return { ok: false, error: 'signal-payload-not-a-string' };
  if (payload.length === 0) return { ok: false, error: 'signal-payload-empty' };
  if (Buffer.byteLength(payload, 'utf8') > MAX_SIGNAL_PAYLOAD_BYTES) return { ok: false, error: 'signal-payload-too-large' };
  return { ok: true, payload };
}

/** How many friends one `steam:list-friends` answer may carry. A Steam friends
 *  list runs to thousands; the picker is a menu, not a directory, and a runaway
 *  list is a renderer stall. */
export const MAX_FRIENDS_LISTED = 512;

/** Longest persona name the picker will render. Steam's own cap is 32 chars,
 *  so this is slack rather than truncation in practice. */
export const MAX_PERSONA_CHARS = 64;

/**
 * A friend's persona name on its way OUT to the renderer.
 *
 * Another player chose this string, so it is untrusted text: control characters
 * — including the bidi overrides that let a name repaint the row beside it —
 * are dropped, the result is capped, and a name that survives as nothing at all
 * becomes a placeholder rather than an empty row nobody can read.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizePersonaName(raw) {
  if (typeof raw !== 'string') return 'Unknown friend';
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .trim();
  if (!stripped) return 'Unknown friend';
  return stripped.length > MAX_PERSONA_CHARS ? stripped.slice(0, MAX_PERSONA_CHARS) : stripped;
}

/**
 * The Binding's `friends.getAllFriends()` -> what may cross IPC.
 *
 * Ids become decimal strings (nothing bigint-shaped ever reaches the renderer),
 * names are scrubbed, the state is a plain integer, and anything without a
 * readable id is dropped entirely — an invite needs an id, so a row that cannot
 * carry one is a row that could only fail when pressed.
 *
 * Never throws: a Binding answering with the wrong shape yields an empty list,
 * which the picker already has to render for the friendless case.
 *
 * @param {unknown} raw
 * @returns {Array<{ steamId: string, personaName: string, personaState: number, inGame: boolean }>}
 */
export function sanitizeFriendList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (out.length >= MAX_FRIENDS_LISTED) break;
    if (!entry || typeof entry !== 'object') continue;
    const steamId = steamIdToString(entry.steamId ?? entry.steamId64 ?? entry.id);
    if (!steamId) continue;
    out.push({
      steamId,
      personaName: sanitizePersonaName(entry.personaName ?? entry.name),
      personaState: Number.isInteger(entry.personaState) ? entry.personaState : 0,
      inGame: entry.inGame === true,
    });
  }
  return out;
}

/**
 * Steam's launch notification -> the lobby the player just accepted.
 *
 * When an invite is accepted while the game is NOT running, Steam starts it
 * with `+connect_lobby <id>` on the command line; the running-game case arrives
 * as callback 333 instead. This argv is attacker-adjacent in exactly the way
 * every other id is — a desktop shortcut, a second instance, a protocol handler
 * — so the id goes through `parseSteamId` and nothing else is taken from the
 * line. A `+connect_lobby` whose value is not an id yields null rather than
 * falling through to a later occurrence: the first one is the one Steam wrote.
 *
 * Both spellings are read (`+connect_lobby 123` and `+connect_lobby=123`): the
 * separated form is what Steam sends, the joined form is what hand-written
 * shortcuts and harnesses tend to carry.
 *
 * @param {unknown} argv
 * @returns {string|null} the lobby id as a decimal string, or null
 */
export function parseConnectLobbyArg(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string') continue;
    let candidate;
    if (token === '+connect_lobby') candidate = argv[i + 1];
    else if (token.startsWith('+connect_lobby=')) candidate = token.slice('+connect_lobby='.length);
    else continue;
    return parseSteamId(candidate) === null ? null : candidate;
  }
  return null;
}
