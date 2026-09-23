/**
 * The one broadcast callback this shell needs, and the pump that hears it.
 *
 * ## Why this file exists at all
 *
 * `steamworks-ffi-node` has no broadcast-callback mechanism. Everything it
 * calls a "callback" is an API *call result*: an async Steam call hands back a
 * `SteamAPICall_t`, and `SteamCallbackPoller` asks `IsAPICallCompleted` about
 * that one handle. `GameLobbyJoinRequested_t` (333) has no call handle — Steam
 * pushes it at the process when a friend clicks "Join game", unprompted — so
 * there is nothing for that poller to poll, and the Binding's 379 declared
 * symbols contain no `ManualDispatch` entry to receive it either.
 *
 * Without this file the swap ships a joiner who must RESTART the game to accept
 * an invite, which is precisely the failure the Phase 2 plan's step 4 warning
 * exists to prevent. The other two invite routes (`+connect_lobby` at launch, a
 * `second-instance` command line) do not cover it: both require the game to
 * have been closed or relaunched.
 *
 * ## What it does, and what it deliberately does not
 *
 * Valve's flat API exports a manual dispatch loop — `ManualDispatch_Init`,
 * `GetHSteamPipe`, `ManualDispatch_RunFrame`, `GetNextCallback`,
 * `FreeLastCallback` — and this declares those five against the library handle
 * the Binding has ALREADY opened. Not a second `koffi.load`: one DLL, one
 * handle, no second path-resolution rule to keep in step with the Binding's.
 *
 * It is scoped to exactly one callback id. Every other id that comes out of the
 * queue is freed and dropped, unread. Growing this into a general callback
 * router is a different decision than the one taken here, and should be argued
 * on its own. The one exception is `LobbyInvite_t` (503), read only when the
 * two-seat test mode passes a handler for it; a player boot never does.
 *
 * ## The bounded-ness that made this acceptable
 *
 * - One `setInterval`, unref'd: a pump is a listener, not a reason for the
 *   process to live.
 * - `MAX_CALLBACKS_PER_TICK` per tick, so a flood cannot starve the main loop.
 * - `FreeLastCallback` in a `finally`, always: a callback taken off the queue
 *   and not freed wedges the queue behind it permanently.
 * - Every FFI call inside `try`. A pump that throws must degrade to a pump that
 *   is off, never to a boot that failed.
 * - If ANY of the five symbols is missing or `ManualDispatch_Init` throws, this
 *   reports `{ ok: false, reason }` and the shell keeps both other invite
 *   routes. Nothing above it branches on the pump existing.
 *
 * ## THE MODE-MIXING CAVEAT (found in review, 2026-08-21)
 *
 * Valve's manual dispatch is documented as a REPLACEMENT for
 * `SteamAPI_RunCallbacks()`, not a supplement to it, and this process runs both
 * on the same pipe. Not by choice: the Binding's own `createLobby`/`joinLobby`
 * await their results through `SteamCallbackPoller.poll()`, which calls
 * `apiCore.runCallbacks()` -> `SteamAPI_RunCallbacks()` in a loop, every 100 ms
 * for up to 5 s. The poller is constructed inside the Binding and its
 * `runCallbacks()` call is unconditional — there is no option, no injection
 * point, and no way to disable it short of forking the package. Making our pump
 * the ONLY dispatcher is therefore impossible while the Binding is the thing
 * opening lobbies.
 *
 * What IS done about it: `holdDispatch()` wraps every Binding async call site,
 * and this pump SKIPS its ticks entirely — no `RunFrame`, no `GetNextCallback`
 * — for as long as any of them is in flight. The two mechanisms no longer run
 * concurrently.
 *
 * **What that does NOT fix, stated plainly.** The mixing is narrowed, not
 * eliminated: the two mechanisms still alternate on one pipe across the life of
 * the process, which is not what Valve's contract describes. And there is a
 * concrete, accepted consequence — a `GameLobbyJoinRequested` that Steam
 * delivers DURING a create/join window is dispatched by `SteamAPI_RunCallbacks`
 * to a C++ callback nobody registered, and is gone before this pump looks
 * again. A running joiner who accepts an invite in exactly that window (a few
 * seconds, at most, around hosting or joining) will not hear it. The two other
 * invite routes — `+connect_lobby` on a closed game, and typing the lobby id —
 * are the fallback, and they are why this is a degraded invite rather than a
 * lost one. Only a live client can measure how often it actually happens.
 *
 * ## What is NOT proven here
 *
 * That the live Steam client delivers 333 through this loop. Nothing in plain
 * node can prove that, and no test in this repo does. What IS proven is the
 * decode and the delivery rule, against an injected dispatch
 * (`tests/desktop-steam-callbacks.test.mjs`). The live half belongs to the
 * user's sitting.
 *
 * Imports nothing from Electron, and nothing from the Binding, on purpose.
 */

/**
 * How many Binding async operations are in flight right now.
 *
 * Module-level rather than passed around, because the two things it separates
 * live in different files and share only the Steam pipe: `desktop/main.mjs`
 * holds it across `matchmaking.createLobby`/`joinLobby`, and the pump below
 * reads it. A counter and not a boolean: two overlapping operations must both
 * be finished before dispatch resumes, and a boolean would let the first one to
 * settle re-open the pipe under the second.
 */
let dispatchHolds = 0;

/** True while any Binding async call is awaiting `SteamAPI_RunCallbacks`. */
export const dispatchHeld = () => dispatchHolds > 0;

/**
 * Run a Binding async call with this pump stood down for its duration.
 *
 * `finally`, always: a hold that leaks is a pump that never ticks again, which
 * turns a narrowed risk into a dead invite route. The operation's own result
 * and its own failure both pass straight through — this wrapper decides
 * nothing about the call it wraps.
 *
 * @template T
 * @param {() => Promise<T>|T} op
 * @returns {Promise<T>}
 */
export async function holdDispatch(op) {
  dispatchHolds++;
  try {
    return await op();
  } finally {
    dispatchHolds--;
  }
}

/** `k_iSteamFriendsCallbacks` (300) + 33. Steam pushes this when a friend's
 *  "Join game" is clicked, or an invite accepted, while the game is running. */
export const GAME_LOBBY_JOIN_REQUESTED = 333;

/** `k_iSteamMatchmakingCallbacks` (500) + 3. `LobbyInvite_t`: somebody SENT
 *  this user an invite (not accepted it). Heard ONLY by the two-seat test mode
 *  (`desktop/twoseat.mjs`): for a player an invite is a question, and turning
 *  it into a join would be answering it for them. `drainCallbacks` reads it
 *  only when a caller hands it an `onLobbyInvite`, and `desktop/main.mjs` hands
 *  one over only behind `OLLIE_TWOSEAT=1`. */
export const LOBBY_INVITE = 503;

/** `LobbyInvite_t` is three uint64s: inviter, lobby, game id. Layout per the
 *  Steamworks `isteammatchmaking.h` declaration; no SDK header is vendored here
 *  to check it against, so the live half is #13's to confirm. */
const INVITE_USER_OFFSET = 0;
const INVITE_LOBBY_OFFSET = 8;
const MIN_INVITE_BYTES = 16;

/**
 * Decode one 503 payload. Null for anything implausible, same rule as 333.
 * @param {Buffer|Uint8Array} data
 * @returns {{ lobbyId: string, fromSteamId: string|null }|null}
 */
export function decodeLobbyInvite(data) {
  if (!data || typeof data.length !== 'number' || data.length < MIN_INVITE_BYTES) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length);
  const lobby = buf.readBigUInt64LE(INVITE_LOBBY_OFFSET);
  if (lobby === 0n) return null;
  const from = buf.readBigUInt64LE(INVITE_USER_OFFSET);
  return { lobbyId: lobby.toString(), fromSteamId: from === 0n ? null : from.toString() };
}

/** A tick drains at most this many callbacks. See "bounded-ness" above. */
export const MAX_CALLBACKS_PER_TICK = 32;

/** `GameLobbyJoinRequested_t` is two `CSteamID`s: the lobby, then the friend.
 *  Only the first is wanted, and only the first is read. */
const LOBBY_ID_OFFSET = 0;
const MIN_PAYLOAD_BYTES = 8;

/**
 * Decode one 333 payload into a decimal lobby id string.
 *
 * Returns null rather than throwing for anything that is not a plausible
 * payload — a short buffer, a zero id — because this runs inside a pump whose
 * whole contract is that it never throws. A zero id is Steam's own "no lobby",
 * and forwarding it would send the player to a lobby that does not exist.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {string|null}
 */
export function decodeJoinRequested(data) {
  if (!data || typeof data.length !== 'number' || data.length < MIN_PAYLOAD_BYTES) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length);
  const id = buf.readBigUInt64LE(LOBBY_ID_OFFSET);
  return id === 0n ? null : id.toString();
}

/**
 * Drain the dispatch queue once, delivering every 333 it finds.
 *
 * Split out from the timer so the rule is exercisable without one. `dispatch`
 * is the four-method shape `createKoffiDispatch` returns; a test passes a fake.
 *
 * @param {{ runFrame: () => void,
 *           next: () => ({ id: number, data: Buffer|Uint8Array|null }|null),
 *           free: () => void }} dispatch
 * @param {(lobbyId: string) => void} onJoinRequested
 * @param {(message: string) => void} [onError]
 * @param {() => boolean} [held] true while a Binding async call is using
 *   `SteamAPI_RunCallbacks` on this same pipe. A held tick does NOTHING — not
 *   even `RunFrame` — which is the whole of the mitigation described above.
 * @param {((invite: { lobbyId: string, fromSteamId: string|null }) => void)|null} [onLobbyInvite]
 *   two-seat mode only. Null (every player boot): a 503 is freed unread like
 *   any other id.
 * @returns {number} how many callbacks were delivered this tick
 */
export function drainCallbacks(dispatch, onJoinRequested, onError = () => {}, held = dispatchHeld, onLobbyInvite = null) {
  let delivered = 0;
  // Before `runFrame`, deliberately: `RunFrame` is itself a dispatch call, and
  // a tick that ran it and then declined to read would be mixing the two
  // mechanisms while claiming not to.
  if (held()) return 0;
  try {
    dispatch.runFrame();
  } catch (err) {
    onError(`steam: manual dispatch runFrame failed (${err && err.message ? err.message : err})`);
    return 0;
  }

  for (let i = 0; i < MAX_CALLBACKS_PER_TICK; i++) {
    let msg = null;
    try {
      msg = dispatch.next();
    } catch (err) {
      onError(`steam: manual dispatch getNextCallback failed (${err && err.message ? err.message : err})`);
      return delivered;
    }
    if (!msg) return delivered;

    // The free MUST pair with every successful next(), including the ones whose
    // id we do not care about and the ones whose payload does not decode.
    try {
      if (msg.id === GAME_LOBBY_JOIN_REQUESTED) {
        const lobbyId = decodeJoinRequested(msg.data);
        if (lobbyId) { onJoinRequested(lobbyId); delivered++; }
        else onError('steam: a GameLobbyJoinRequested payload carried no lobby id');
      } else if (msg.id === LOBBY_INVITE && onLobbyInvite) {
        const invite = decodeLobbyInvite(msg.data);
        if (invite) { onLobbyInvite(invite); delivered++; }
        else onError('steam: a LobbyInvite payload carried no lobby id');
      }
    } catch (err) {
      onError(`steam: join-requested delivery failed (${err && err.message ? err.message : err})`);
    } finally {
      try { dispatch.free(); } catch { /* a queue we cannot free is a queue we stop draining */ }
    }
  }
  return delivered;
}

/**
 * Build the real dispatch over the library handle the Binding already opened.
 *
 * @param {any} lib a `koffi` library handle (`lib.func(...)`).
 * @param {any} koffi the koffi module, for decoding the payload pointer.
 * @returns {{ runFrame: () => void, next: () => object|null, free: () => void }}
 */
export function createKoffiDispatch(lib, koffi) {
  // Declared here rather than taken from the Binding because the Binding
  // declares none of them. `tools/steamsdk.mjs` REQUIRED_SYMBOLS carries the
  // same five, so a DLL that stops exporting one fails the gate instead of
  // failing at the first invite.
  const manualInit = lib.func('SteamAPI_ManualDispatch_Init', 'void', []);
  const getPipe = lib.func('SteamAPI_GetHSteamPipe', 'int32', []);
  const runFrame = lib.func('SteamAPI_ManualDispatch_RunFrame', 'void', ['int32']);
  const freeLast = lib.func('SteamAPI_ManualDispatch_FreeLastCallback', 'void', ['int32']);
  // `CallbackMsg_t` under MSVC pack(8): int32 user, int32 callback, void *param,
  // int32 size, 4 bytes tail padding. Twenty-four bytes, filled by Steam.
  const getNext = lib.func('SteamAPI_ManualDispatch_GetNextCallback', 'bool', ['int32', 'void *']);

  manualInit();
  const pipe = getPipe();
  if (!pipe) throw new Error('SteamAPI_GetHSteamPipe returned no pipe');

  const msg = Buffer.alloc(24);

  return {
    runFrame: () => runFrame(pipe),
    next() {
      msg.fill(0);
      if (!getNext(pipe, msg)) return null;
      const id = msg.readInt32LE(4);
      const size = msg.readInt32LE(16);
      const ptr = koffi.decode(msg, 8, 'void *');
      const data = ptr && size > 0 ? Buffer.from(koffi.decode(ptr, 'uint8 [' + size + ']')) : null;
      return { id, data };
    },
    free: () => freeLast(pipe),
  };
}

/**
 * Start the pump.
 *
 * @param {{
 *   dispatch?: object,
 *   library?: () => any,
 *   koffi?: any,
 *   onJoinRequested: (lobbyId: string) => void,
 *   intervalMs?: number,
 *   onError?: (message: string) => void,
 * }} deps `dispatch` is the test seam; production passes `library`/`koffi`.
 * @returns {{ ok: boolean, reason: string|null, stop: () => void, tick: () => number }}
 */
export function startCallbackPump({
  dispatch, library, koffi, onJoinRequested, onLobbyInvite = null,
  intervalMs = 100, onError = (m) => console.error(m), held = dispatchHeld,
}) {
  const off = (reason) => ({ ok: false, reason, stop: () => {}, tick: () => 0 });
  let d = dispatch ?? null;
  if (!d) {
    try {
      const lib = library ? library() : null;
      if (!lib || typeof lib.func !== 'function') return off('steam-library-handle-unavailable');
      d = createKoffiDispatch(lib, koffi);
    } catch (err) {
      return off(err && err.message ? err.message : String(err));
    }
  }

  const tick = () => drainCallbacks(d, onJoinRequested, onError, held, onLobbyInvite);
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { ok: true, reason: null, stop: () => clearInterval(timer), tick };
}
