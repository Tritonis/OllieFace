/**
 * TELLURIC VOID desktop shell (Electron, Windows-only target).
 *
 * Serves the built web game over app:// (file:// breaks ES module
 * resolution, docs/STEAM.md section 5), keeps background throttling OFF (a
 * host that pauses on alt-tab desyncs every client), mirrors saves to one
 * atomically-written JSON under userData, and logs the GPU adapter so the
 * Optimus problem is diagnosable from a player report.
 */
import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { initSteam, getClient, getStatus, enableOverlay } from './steam.mjs';
import { createSaveWriter, createQuitGuard } from './save-writer.mjs';
import {
  parseSteamId, steamIdToString, validateMaxMembers, validateLobbyRecord, validateLobbyKeys,
  sanitizeLobbyData, encodeSignal, decodeSignal, MAX_SIGNAL_FRAME_BYTES,
  isAuthorizedSignalTarget, sanitizeFriendList, parseConnectLobbyArg,
} from './steam-validate.mjs';
import { createJoinDelivery } from './join-delivery.mjs';
import { startCallbackPump, holdDispatch } from './steam-callbacks.mjs';

const requireCjs = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');

if (process.env.TELLURIC_USERDATA) app.setPath('userData', process.env.TELLURIC_USERDATA);

// Must run before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const savePath = () => path.join(app.getPath('userData'), 'save.json');

// The renderer must be able to tell "no save yet" from "there is a save and I
// could not read it". Collapsing both to null makes an EBUSY from Steam Cloud
// or an antivirus scan look like a first boot, and the renderer then migrates
// an empty localStorage over the real file. So: ONLY a missing file reports
// { ok: true, raw: null }; every other failure reports ok:false, which
// DesktopStore treats as "do not migrate", and is logged loudly here.
ipcMain.on('store:load', (e) => {
  try {
    e.returnValue = { ok: true, raw: fs.readFileSync(savePath(), 'utf8') };
  } catch (err) {
    if (err.code === 'ENOENT') { e.returnValue = { ok: true, raw: null }; return; }
    console.error('store:load failed', err);
    e.returnValue = { ok: false, raw: null };
  }
});

// The whole of the write side. Every acceptance rule, the backup generation
// and the durability ordering live in `save-writer.mjs`; what remains here is
// the wire between the IPC channel and the writer, and the wire between the
// writer's verdict and the player.
//
// The verdict is pushed rather than returned because a save is fire-and-forget
// by design (the renderer must never block a frame on a disk), and because the
// interesting failure is the one that happens on the *fourth* save of a run —
// long after whatever call would have carried a return value.
const saveWriter = createSaveWriter({
  savePath,
  onStatus: (status) => pushToRenderer('store:save-status', status),
});

// The `.catch()` is belt to the writer's braces. `drain` cannot reject as it
// stands, but this is a fire-and-forget call in the main process, where an
// unhandled rejection is a crash dialog rather than a log line — and the thing
// that would produce one is a renderer-supplied callback misbehaving, which is
// not a class of bug worth trusting a single guard with.
ipcMain.on('store:save', (_e, json) => {
  saveWriter.save(json).catch((err) => { console.error('store:save: the writer rejected', err); });
});

// Two instances against one userData clobber each other's saves wholesale:
// each renderer snapshots ITS OWN localStorage and writes the whole file, so
// the last flush wins and the other run's progress is gone. Steam's client
// blocks a double launch, but the deliverable is a double-clickable exe.
let mainWindow = null;

// The Steam verdict for this run, decided once before ready and never re-asked.
// Held here so the IPC bridge has one source of truth, and so a Steam-absent
// boot is a recorded fact rather than a repeated failed call.
let steamStatus = { available: false, appId: null, personaName: null, reason: 'not yet initialised' };
let overlayStatus = { ok: false, reason: 'not attempted' };

// ---------------------------------------------------------------------------
// The Steam bridge (window.__STEAM__)
//
// Every Steam call lives here, in the main process; the renderer gets the
// fourteen functions `preload.cjs` names and nothing else — no client object,
// no module handle, no ipcRenderer pass-through. Two rules run through all of
// it:
//
//   1. IDS ARE STRINGS ACROSS IPC. Lobby ids and Steam ids are `bigint`,
//      `JSON.stringify` throws on one, and a renderer handed a bigint explodes
//      the first time it serialises anything containing it. Ids become decimal
//      strings on the way out (`steamIdToString`) and bigints again on the way
//      in (`parseSteamId`) — including in error paths and log lines, which is
//      why nothing below interpolates a raw callback payload.
//   2. EVERYTHING FROM A PEER IS UNTRUSTED. Lobby data is written by whoever
//      owns the lobby; P2P packets by whoever is on the wire. Both are capped
//      and shape-checked in `steam-validate.mjs` before they cross to the
//      renderer, and a hostile or malformed one is dropped, never thrown.
// ---------------------------------------------------------------------------

/**
 * The lobbies THIS PROCESS holds, as decimal id strings.
 *
 * Was a `Map` of id -> `Lobby` handle under `steamworks.js`, whose matchmaking
 * API was instance methods on an object only the main process could hold. The
 * new Binding's matchmaking is flat — every call takes a `LobbyId` STRING, the
 * same string that crosses IPC — so there is no handle left to join to, and the
 * set is now purely an authorization record: which ids the renderer is allowed
 * to name, and which the shell must leave on the way out. That is the same job
 * the Map's KEYS were always doing; only its values are gone.
 */
const steamLobbies = new Set();

/** The active P2P signal listener, or null. At most one at a time: the slice is
 *  two-seat, and a second listener would double-read the same packet queue. */
let signalListen = null;

/** The manual-dispatch pump that hears callback 333, or null. See
 *  `desktop/steam-callbacks.mjs` for why it is ours to run at all. */
let callbackPump = null;

/** A cap on how many packets one tick may drain, so a flood cannot starve the
 *  main loop. Anything beyond it waits 100 ms for the next tick. */
const MAX_PACKETS_PER_TICK = 16;

/** `ELobbyType.FriendsOnly`. Spelled out rather than imported: the Binding's
 *  enum lives in the module `steam.mjs` owns, and one number is a smaller thing
 *  to carry than a second import path into the native library. */
const LOBBY_TYPE_FRIENDS_ONLY = 1;

/**
 * A lobby data key stamped on every lobby this build creates, and the value it
 * carries.
 *
 * The lobby space is shared: `requestLobbyList` returns whatever the appid's
 * matchmaking has, and during the spike on Spacewar that meant other people's
 * lobbies. Under our own appid that risk shrinks but does not vanish — an old
 * build, a modified client, a future mode all land in the same space — so any
 * enumeration this shell grows MUST filter on this key rather than trusting
 * that everything it can see is one of ours. Nothing enumerates today; the
 * stamp exists so that when something does, the lobbies are already marked.
 */
const LOBBY_TAG_KEY = 'telluric';
const LOBBY_TAG_VALUE = 'void-coop-1';

/**
 * The one door every accepted Steam invite goes through.
 *
 * All THREE routes — `+connect_lobby` at launch, a `second-instance` command
 * line, and callback 333 — can fire before the page is listening, 333 included:
 * it is registered in `registerSteamBridge()`, which runs before
 * `app.whenReady()`. An earlier version of this file believed 333 was the safe
 * one and pushed it straight at the renderer; that push had no window to land
 * in during boot and no subscription to land in during load, and the invite was
 * gone with nothing parked. `join-delivery.mjs` holds the whole rule and the
 * reasoning; nothing in this file may push `steam:join-requested` around it.
 */
const joinDelivery = createJoinDelivery({
  push: (lobbyId) => pushToRenderer('steam:join-requested', { lobbyId }),
  windowAlive: () => !!mainWindow && !mainWindow.isDestroyed(),
  // The closed-game route, read off this process's own command line. Parked
  // from the first line of the module, because there is no page for most of
  // what happens next.
  initial: parseConnectLobbyArg(process.argv),
});

/** A message for the renderer that is a string and only a string. `err` may
 *  carry a bigint somewhere in it, so it is never spread, serialised, or
 *  returned — only its message is. */
const steamError = (err) => {
  const m = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
  return m && m.trim() ? m.trim() : 'steam-call-failed';
};

/** The live client, or null when Steam never came up. Every handler starts here
 *  so a Steam-absent renderer gets a shape it can branch on, not a throw. */
const steamClient = () => (steamStatus.available ? getClient() : null);

/** The lobby id, if this process holds it; null otherwise. Every handler that
 *  acts on a lobby goes through here, so a renderer cannot name a lobby the
 *  shell never joined. */
const lobbyFor = (rawId) => (typeof rawId === 'string' && steamLobbies.has(rawId) ? rawId : null);

/** Matchmaking, or null when Steam never came up. */
const matchmaking = () => steamClient()?.matchmaking ?? null;

const pushToRenderer = (channel, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
};

/** Is this Steam id currently in this lobby? The gate on accepting a P2P
 *  session and on believing a packet — blanket-accepting sessions would let any
 *  Steam user on the internet open a channel into the main process. */
const isLobbyMember = (lobbyId, steamId) => {
  if (!lobbyId || typeof steamId !== 'string') return false;
  try {
    const mm = matchmaking();
    return !!mm && mm.getLobbyMembers(lobbyId).some((m) => steamIdToString(m) === steamId);
  } catch { return false; }
};

/**
 * The legacy P2P surface, or null.
 *
 * `steamworks.js@0.4.0` bound `ISteamNetworking`, and the joiner's SDP answer
 * rides it (`docs/STEAM.md` section 7). `steamworks-ffi-node` binds NONE of it
 * — zero `SteamAPI_ISteamNetworking_*` symbols in its 379 declarations — so the
 * answer leg has no carrier under this Binding and the two handlers that use it
 * degrade to a named error instead of throwing at a renderer that expects a
 * shape. This is the swap's one genuine regression and it is recorded as such
 * in `docs/STEAM.md` section 7 rather than hidden behind a working-looking call.
 *
 * The replacement is not improvised here: this Binding DOES bind
 * `setLobbyMemberData`/`getLobbyMemberData` and lobby chat, either of which
 * carries the answer without a P2P packet, and either of which is a signalling
 * change with its own tests. Feature-detected rather than deleted, so a shell
 * running the old Binding is unaffected by the file it shares.
 */
const legacyNetworking = () => {
  const p2p = steamClient()?.networking;
  return p2p && typeof p2p.sendP2PPacket === 'function' ? p2p : null;
};

/** Drain the P2P queue, validate, forward. Total by construction: one bad
 *  packet is skipped, and a throwing native call ends the tick rather than the
 *  process. */
function pumpSignals() {
  const p2p = legacyNetworking();
  if (!p2p || !signalListen) return;
  try {
    for (let i = 0; i < MAX_PACKETS_PER_TICK; i++) {
      const size = p2p.isP2PPacketAvailable();
      if (!Number.isInteger(size) || size <= 0) return;

      // Read it at its FULL size even when it is far too big to be one of ours.
      // An undrained packet blocks every packet behind it, so a single 100 KB
      // packet from a hostile member would otherwise wedge the handshake
      // permanently; Steam's own 1 MB Reliable ceiling is what bounds the cost
      // of draining it. The oversize check then drops it before it is decoded.
      const packet = p2p.readP2PPacket(size);
      if (!packet || !packet.data) continue;
      if (size > MAX_SIGNAL_FRAME_BYTES) {
        console.error(`steam: dropped an oversized P2P packet (${size} bytes)`);
        continue;
      }

      // The sender's id, as the one string form everything downstream uses.
      // `steamIdToString` takes the `{ steamId64: bigint }` shape and a decimal
      // string alike, so this line does not care which Binding produced it.
      const from = steamIdToString(packet.steamId);
      if (!from) continue;
      if (!isLobbyMember(signalListen.lobby, from)) continue;   // non-members are silent drops

      const len = Number.isInteger(packet.size) && packet.size >= 0 && packet.size <= packet.data.length
        ? packet.size : packet.data.length;
      const decoded = decodeSignal(packet.data.subarray(0, len));
      if (!decoded.ok) {
        // `from` is already a string; the packet object it came out of never is
        // interpolated, because it may carry a bigint somewhere inside it.
        console.error(`steam: dropped a signal packet from ${from} (${decoded.error})`);
        continue;
      }
      pushToRenderer('steam:signal', { fromSteamId: from, payload: decoded.payload });
    }
  } catch (err) {
    console.error('steam: signal pump failed', steamError(err));
  }
}

/** Tear the listener down: the interval, and BOTH callback handles. A
 *  `Handle` that is never `.disconnect()`ed keeps firing into a closure that
 *  outlives the lobby it was registered for. */
function stopSignalListen() {
  if (!signalListen) return { ok: true };
  clearInterval(signalListen.timer);
  for (const handle of [signalListen.sessionHandle, signalListen.failHandle]) {
    try { handle?.disconnect(); } catch (err) { console.error('steam: callback disconnect failed', steamError(err)); }
  }
  signalListen = null;
  return { ok: true };
}

/**
 * Release every Steam lobby this process still holds, and the pump/handles
 * that feed them. (Important 3.) A renderer reload, a crashed renderer, the
 * window closing and the app quitting all used to leave every one of those
 * running against a page that no longer has any listener for them — the
 * lobby stays open and joinable from a friend's list, the 100 ms pump keeps
 * polling a queue nobody drains, and both callback `Handle`s keep firing into
 * a closure over a `mainWindow` that may itself be gone.
 *
 * Idempotent, deliberately: every one of its four call sites can fire more
 * than once in a session (a reload after a reload; `window-all-closed`
 * racing `before-quit`), and `stopSignalListen` already tolerates being
 * called with nothing armed. `steamLobbies.clear()` after the loop, not
 * per-entry deletion during it, because a `Map` mutated while iterated is the
 * kind of bug that only shows up the second time this runs.
 */
function releaseAllSteamState() {
  // The page that was listening is gone; anything pushed from here until the
  // next `bindSteam` would land nowhere. Park it instead.
  joinDelivery.release();
  stopSignalListen();
  const mm = matchmaking();
  for (const lobbyId of steamLobbies) {
    try { mm?.leaveLobby(lobbyId); } catch (err) { console.error('steam: lobby leave failed', steamError(err)); }
  }
  steamLobbies.clear();
}

/**
 * Register the IPC surface. Called exactly once, before `app.whenReady()` —
 * `ipcMain.handle` is legal that early, and registering there means a renderer
 * that races the first frame still finds every channel already listening.
 */
function registerSteamBridge() {
  // Every handler is `async` and every one of them returns a plain object with
  // string/boolean/number fields only. No handler ever returns a bigint, a
  // Lobby, a Buffer, or an Error.
  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, ...args) => {
    try { return await fn(...args); }
    catch (err) { return { error: steamError(err) }; }
  });

  handle('steam:status', async () => getStatus());

  handle('steam:host-lobby', async (maxMembers) => {
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    const size = validateMaxMembers(maxMembers);
    if (!size.ok) return { error: size.error };

    // The Binding answers with a RESULT RECORD, not a handle: `{ success,
    // lobbyId?, error? }`, where `lobbyId` is already the decimal string that
    // crosses IPC. A failure here is a Steam refusal, not an exception, so it
    // has to be read rather than caught.
    // `holdDispatch`: this call awaits its result through the Binding's own
    // `SteamAPI_RunCallbacks` loop, and the 333 pump dispatches manually on the
    // same pipe. Valve's manual dispatch replaces `RunCallbacks` rather than
    // supplementing it, so the pump stands down for the duration. See the
    // mode-mixing caveat in `desktop/steam-callbacks.mjs` for what this does
    // and does not fix.
    const created = await holdDispatch(() => mm.createLobby(LOBBY_TYPE_FRIENDS_ONLY, size.value));
    if (!created || !created.success) return { error: created?.error || 'lobby-create-refused' };
    const lobbyId = steamIdToString(created.lobbyId);
    if (!lobbyId) return { error: 'lobby-id-unreadable' };
    steamLobbies.add(lobbyId);
    // Stamp it as ours before anyone can see it. A lobby created and not tagged
    // is a lobby no future filter can tell from a stranger's.
    try { mm.setLobbyData(lobbyId, LOBBY_TAG_KEY, LOBBY_TAG_VALUE); }
    catch (err) { console.error('steam: lobby tag write failed', steamError(err)); }
    return { lobbyId };
  });

  handle('steam:join-lobby', async (rawLobbyId) => {
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    // Parsed for its STRICTNESS, not its value: the Binding takes the string,
    // but `parseSteamId` is what keeps a renderer from handing Steam something
    // it never issued.
    if (parseSteamId(rawLobbyId) === null) return { error: 'bad-lobby-id' };

    const joined = await holdDispatch(() => mm.joinLobby(rawLobbyId));   // see `steam:host-lobby`
    if (!joined || !joined.success) return { error: joined?.error || 'lobby-join-refused' };
    // Hold both the id we were given and the id the result reports. They are
    // the same number today; holding both means a normalisation we did not
    // predict cannot orphan the lobby the renderer is about to address.
    const reported = steamIdToString(joined.lobbyId);
    steamLobbies.add(rawLobbyId);
    if (reported && reported !== rawLobbyId) steamLobbies.add(reported);
    return { ok: true, lobbyId: reported ?? rawLobbyId };
  });

  handle('steam:leave-lobby', async (rawLobbyId) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { ok: true };   // leaving a lobby we do not hold is done, not an error
    if (signalListen && signalListen.lobby === lobbyId) stopSignalListen();
    steamLobbies.delete(lobbyId);
    matchmaking()?.leaveLobby(lobbyId);
    return { ok: true };
  });

  handle('steam:open-invite', async (rawLobbyId) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    // REFUTED as an invite surface (2026-08-21, #127) and this Binding binds no
    // `openInviteDialog` at all, so the channel survives only as an honest
    // answer: the picker in `src/ui/Menus.js` is the invite path now. Kept
    // rather than removed because `preload.cjs`'s key set is pinned by
    // `tools/desktopprobe.mjs` and dropping a key is a bridge change, not a
    // Binding one.
    return { error: 'overlay-unavailable', overlay: overlayStatus.ok };
  });

  // ------------------------------------------------------------- the picker
  // The overlay was refuted as an invite surface (2026-08-21), so the invite is
  // ours to draw: a list of friends, and a call per friend. Both halves are
  // feature-detected rather than assumed, because the Binding that carries them
  // is not the Binding every other handler above is written against — a shell
  // running the older one answers `friends-unavailable` and the picker says so,
  // which is a sentence a player can act on, unlike a button that does nothing.

  handle('steam:list-friends', async () => {
    const client = steamClient();
    if (!client) return { error: 'steam-unavailable' };
    const friends = client.friends;
    if (!friends || typeof friends.getAllFriends !== 'function') return { error: 'friends-unavailable' };
    // Sanitised, not forwarded: persona names are strings other players chose.
    return { friends: sanitizeFriendList(friends.getAllFriends()) };
  });

  handle('steam:invite-friend', async (rawLobbyId, rawSteamId) => {
    const client = steamClient();
    if (!client) return { error: 'steam-unavailable' };
    const target = parseSteamId(rawSteamId);
    if (target === null) return { error: 'bad-steam-id' };
    // A lobby THIS PROCESS HOLDS, and no other. The renderer names the lobby,
    // and an invite is Steam telling another player where to connect — so an
    // arbitrary id here would let a compromised page point a friend anywhere.
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    const mm = client.matchmaking;
    if (!mm || typeof mm.inviteUserToLobby !== 'function') return { error: 'invite-unavailable' };
    return mm.inviteUserToLobby(lobbyId, target.toString())
      ? { ok: true }
      : { error: 'invite-refused' };
  });

  // The renderer collecting whatever invite arrived before it was listening,
  // by whichever of the three routes. Answers once and forgets; the ask is
  // also what tells `joinDelivery` a subscription now exists, so everything
  // after this point is pushed live instead of parked.
  handle('steam:pending-join', async () => ({ lobbyId: joinDelivery.collect() ?? null }));

  handle('steam:write-lobby-data', async (rawLobbyId, record) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    const checked = validateLobbyRecord(record);
    if (!checked.ok) return { error: checked.error };
    // `mergeFullData` is gone: this Binding writes ONE KEY PER CALL. The batch
    // is therefore ours to make, and its atomicity is ours to not have — which
    // is the same position the old call was in, since Steam stores entries
    // until it hits the 8 KB wall and refuses the rest. `validateLobbyRecord`
    // already measures the whole record against `MAX_LOBBY_TOTAL_BYTES` before
    // a single key is written, so the wall is not reached by anything that gets
    // this far; a refusal here is Steam saying "you do not own this lobby",
    // which is the joiner's expected answer and not an error to log.
    for (const [key, value] of Object.entries(checked.record)) {
      if (!mm.setLobbyData(lobbyId, key, value)) return { error: 'lobby-data-write-refused' };
    }
    return { ok: true };
  });

  handle('steam:get-full-lobby-data', async (rawLobbyId) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    return { data: sanitizeLobbyData(mm.getAllLobbyData(lobbyId)) };
  });

  // ------------------------------------------------------- the answer leg
  // `SetLobbyData` is owner-only in Steam's model, which is why the joiner's
  // SDP answer used to travel as a P2P packet. `steamworks-ffi-node` binds
  // `setLobbyMemberData`/`getLobbyMemberData`, which `steamworks.js@0.4.0` did
  // not, so the answer goes back the way the plan originally wanted it to: the
  // joiner writes into ITS OWN member data and the host reads it off the
  // member. Member data is per-member and self-written — Steam gives no way to
  // write another member's, which is the property that makes this leg safe
  // without the membership gate the P2P leg needed.

  handle('steam:write-member-data', async (rawLobbyId, record) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    if (typeof mm.setLobbyMemberData !== 'function') return { error: 'member-data-unavailable' };
    const checked = validateLobbyRecord(record);
    if (!checked.ok) return { error: checked.error };
    // One key per call, same as the owner-side write. `setLobbyMemberData`
    // returns void rather than a boolean — Steam does not refuse a member their
    // own slot — so there is no per-key verdict to read here.
    for (const [key, value] of Object.entries(checked.record)) mm.setLobbyMemberData(lobbyId, key, value);
    return { ok: true };
  });

  handle('steam:collect-member-data', async (rawLobbyId, rawKeys) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    if (typeof mm.getLobbyMemberData !== 'function') return { error: 'member-data-unavailable' };
    const checked = validateLobbyKeys(rawKeys);
    if (!checked.ok) return { error: checked.error };

    // Bounded on BOTH axes before a single native call: the key list by
    // `validateLobbyKeys`, the member list by the lobby size Steam itself
    // enforces. One poll tick is therefore at most keys x members reads, and
    // both factors are small integers.
    const members = mm.getLobbyMembers(lobbyId);
    const out = {};
    for (const raw of Array.isArray(members) ? members : []) {
      const steamId = steamIdToString(raw);
      if (!steamId) continue;
      const record = {};
      for (const key of checked.keys) {
        // Everything read here was written by another player's Steam client.
        // Sanitised on the way out, exactly as lobby data is.
        try {
          const value = mm.getLobbyMemberData(lobbyId, steamId, key);
          if (typeof value === 'string' && value !== '') record[key] = value;
        } catch { /* an unreadable key is an absent key */ }
      }
      out[steamId] = sanitizeLobbyData(record);
    }
    return { members: out };
  });

  handle('steam:get-lobby-owner', async (rawLobbyId) => {
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    const mm = matchmaking();
    if (!mm) return { error: 'steam-unavailable' };
    const steamId = steamIdToString(mm.getLobbyOwner(lobbyId));
    return steamId ? { steamId } : { error: 'owner-unreadable' };
  });

  handle('steam:send-signal', async (rawSteamId, payload) => {
    const client = steamClient();
    if (!client) return { error: 'steam-unavailable' };
    // See `legacyNetworking`: under `steamworks-ffi-node` there is no
    // `ISteamNetworking` to send on, and a named refusal is the honest answer.
    const p2p = legacyNetworking();
    if (!p2p) return { error: 'p2p-unavailable' };
    const target = parseSteamId(rawSteamId);
    if (target === null) return { error: 'bad-steam-id' };
    // MINOR 1. This channel exists for exactly one purpose — the joiner's
    // answer to the lobby it just joined, addressed to that lobby's owner —
    // and until here the shape check let it address ANY Steam id. The receive
    // side is already membership-gated (`isLobbyMember`, below); this is its
    // asymmetric other half.
    const mm = matchmaking();
    const owners = [];
    for (const lobbyId of steamLobbies) {
      try {
        const owner = parseSteamId(steamIdToString(mm?.getLobbyOwner(lobbyId)));
        if (owner !== null) owners.push(owner);
      } catch { /* an unreadable owner is not a match either way */ }
    }
    if (!isAuthorizedSignalTarget(target, owners)) return { error: 'signal-target-not-lobby-owner' };
    const framed = encodeSignal(payload);
    if (!framed.ok) return { error: framed.error };

    const sent = p2p.sendP2PPacket(
      target, p2p.SendType.Reliable, Buffer.from(framed.frame, 'utf8'));
    return sent ? { ok: true } : { error: 'signal-send-refused' };
  });

  handle('steam:start-signal-listen', async (rawLobbyId) => {
    const client = steamClient();
    if (!client) return { error: 'steam-unavailable' };
    const p2p = legacyNetworking();
    if (!p2p) return { error: 'p2p-unavailable' };
    const lobbyId = lobbyFor(rawLobbyId);
    if (!lobbyId) return { error: 'unknown-lobby' };
    stopSignalListen();   // idempotent restart; never two pumps on one queue

    // Callback registration is `steamworks.js`-shaped and feature-detected with
    // the surface it belongs to: the two session callbacks are part of the same
    // `ISteamNetworking` the send leg rides, and neither exists without it.
    const { SteamCallback } = client.callback;
    const sessionHandle = client.callback.register(SteamCallback.P2PSessionRequest, (event) => {
      try {
        const remote = steamIdToString(event && event.remote);
        if (!remote) return;
        // MEMBERS ONLY. Accepting every session request would open a channel
        // from any Steam user who learns our id.
        if (!isLobbyMember(lobbyId, remote)) {
          console.error(`steam: refused a P2P session from a non-member (${remote})`);
          return;
        }
        p2p.acceptP2PSession(parseSteamId(remote));
      } catch (err) { console.error('steam: P2P session request failed', steamError(err)); }
    });
    const failHandle = client.callback.register(SteamCallback.P2PSessionConnectFail, (event) => {
      const remote = steamIdToString(event && event.remote);
      const code = event && typeof event.error === 'number' ? event.error : null;
      pushToRenderer('steam:signal-fail', { fromSteamId: remote, error: code });
    });

    const timer = setInterval(pumpSignals, 100);
    // Unref'd: the pump is a listener, not a reason for the process to live.
    if (typeof timer.unref === 'function') timer.unref();
    signalListen = { lobby: lobbyId, timer, sessionHandle, failHandle };
    return { ok: true };
  });

  handle('steam:stop-signal-listen', async () => stopSignalListen());

  // Push-only: a friend clicking "Join game" in the Steam client.
  //
  // `steamworks.js` had a callback registry and pumped it itself;
  // `steamworks-ffi-node` has neither — no broadcast dispatch at all, and no
  // `ManualDispatch` symbol among its 379 declarations. So the pump is ours,
  // and `desktop/steam-callbacks.mjs` is the whole of it. It is started here,
  // in the same place and for the same reason the old registration was: before
  // `app.whenReady()`, because 333 fires with no window at all.
  //
  // Delivery goes through `joinDelivery`, NOT straight to the renderer, and
  // this stays the only site in this file that offers an invite from a Steam
  // callback — `tests/desktop-join-delivery.test.mjs` pins that.
  const client = steamClient();
  if (client) {
    callbackPump = startCallbackPump({
      library: () => client.libraryLoader?.getLibrary?.() ?? null,
      koffi: (() => { try { return requireCjs('koffi'); } catch { return null; } })(),
      onJoinRequested: (lobbyId) => joinDelivery.offer(lobbyId),
    });
    if (!callbackPump.ok) {
      // A joiner who was already running cannot hear an acceptance. The other
      // two routes still work, so this is a degraded invite and not a dead one
      // — and it is a line a player report can carry back.
      console.error(`steam: callback 333 pump is off (${callbackPump.reason}); a running joiner must relaunch to accept an invite`);
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Steam BEFORE ready, deliberately (adjudication 2026-08-13 section 4).
  // `steamworks.init()` is a plain native call with no dependency on Electron
  // readiness, and the overlay's two command-line switches are ignored if they
  // are appended after ready — so an overlay that works at all has to be
  // decided here. Nothing waits on it: initSteam never throws and never blocks.
  steamStatus = initSteam();
  // ONLY when Steam actually answered. A Steam-absent player gets zero appended
  // switches, zero repaint timers, and the same GPU path (and the same
  // `gpu-info.json` Optimus diagnostic) they had before this line existed.
  // `TELLURIC_NO_OVERLAY=1` skips only this line. It exists because the overlay's
  // `in-process-gpu` switch blinds `getGPUInfo('complete')` — the Optimus
  // diagnostic below reports nothing useful with the overlay on — so anyone
  // gathering that diagnostic, or re-deriving the before/after pair in
  // `desktop/README.md`, needs a way to boot without it that is not a hand edit.
  if (steamStatus.available && !process.env.TELLURIC_NO_OVERLAY) overlayStatus = enableOverlay();
  registerSteamBridge();

  app.on('second-instance', (_event, argv) => {
    // Steam delivers an accepted invite by LAUNCHING the game again, which the
    // single-instance lock turns into this event — so the second instance's
    // command line is where a running shell hears about it.
    joinDelivery.offer(parseConnectLobbyArg(argv));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // The verdict was reached before ready; this is only the report of it. No
    // dialog, no retry, no slower boot for a player who has never opened Steam
    // — the log line is the whole of the Steam-absent experience.
    console.log('steam:', steamStatus.available
      ? `available: true, appId: ${steamStatus.appId}, personaName: ${steamStatus.personaName}, overlay: ${overlayStatus.ok}`
      : `available: false, reason: ${steamStatus.reason}`);

    // app://game/<path> -> dist/<path>, default document index.html.
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const target = path.normalize(path.join(DIST, rel));
      if (!target.startsWith(DIST + path.sep))
        return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });

    const win = new BrowserWindow({
      width: 1600, height: 900,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(HERE, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,   // host-authoritative netcode: never stall the sim on blur
      },
    });
    mainWindow = win;
    // The preload rides the window, not the origin: anything this window can
    // navigate to inherits saveStore. Nothing in src/ navigates today; these
    // two denials keep it that way without needing anyone to remember.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    // IMPORTANT 3. `will-navigate` never fires for a reload (Ctrl+R / the
    // bound `reload`/`forcereload` accelerators on the default application
    // menu `autoHideMenuBar` only hides, it does not remove), so a reload was
    // the one path that left the Steam lobby, the 100 ms pump and both
    // callback handles running against a renderer that had just been thrown
    // away — invisible, and rearmed by every subsequent host/join, not just
    // the first. `did-start-navigation` fires for every navigation INCLUDING
    // reload; `isSameDocument` excludes hash changes and pushState, which
    // never touch the renderer's Steam state and must not tear it down.
    win.webContents.on('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details?.isSameDocument) releaseAllSteamState();
    });
    // A crashed or killed renderer is the same problem from the other side:
    // nothing left to hear `steam:signal` or `steam:signal-fail` either way.
    win.webContents.on('render-process-gone', () => releaseAllSteamState());
    win.loadURL('app://game/index.html');

    // The Optimus diagnostic (docs/STEAM.md section 1): which adapter Chromium
    // actually picked, written where a player report can find it.
    try {
      const info = await app.getGPUInfo('complete');
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'gpu-info.json'), JSON.stringify(info, null, 2));
    } catch (err) { console.error('gpu-info failed', err); }
  });

  // The pump holds two Steam callback handles and a live Steam lobby
  // membership; quitting without releasing them fires closures at a window
  // that no longer exists and leaves the player sitting in a lobby their
  // friends can still see and join after the process is gone. Both hooks call
  // the same idempotent release, so whichever one Windows delivers first
  // still gets it done.
  app.on('window-all-closed', () => { releaseAllSteamState(); app.quit(); });

  // ...and quitting also has to let the last save finish.
  //
  // The renderer's `pagehide` flush hands over one final snapshot and does not
  // wait for it; before this hook, nor did the process. Crash-atomicity is not
  // an answer to that — tmp/fsync/rename guarantees the file is never corrupt
  // and says nothing about the last write being *there* — and the async
  // writer's retry budget made the window wider than the old synchronous
  // handler's under exactly the contended-disk conditions it was built for.
  //
  // The latch lives in `createQuitGuard` and has three states, not two: a
  // second quit request arriving mid-drain has to be REFUSED, not waved past.
  // Electron clears its own `is_quitting_` the moment the first handler calls
  // `preventDefault()`, so Alt+F4 or a second Quit re-emits this event, and a
  // boolean latch would let it terminate the process mid-write.
  //
  // `releaseAllSteamState` stays outside the guard: it is idempotent and must
  // run on every pass, whether or not this one is allowed to quit.
  const guardQuit = createQuitGuard(saveWriter, { quit: () => app.quit() });
  app.on('before-quit', (event) => { releaseAllSteamState(); guardQuit(event); });
}
