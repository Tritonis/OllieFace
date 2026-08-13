/**
 * Co-op signalling over a Steam lobby, for the Electron shell only.
 *
 * This module imports nothing from Electron and nothing from steamworks. It
 * speaks to `window.__STEAM__`, the preload bridge the desktop shell installs
 * (`desktop/preload.cjs`), and to nothing else. In a browser that object does
 * not exist and in a shell whose Steam never answered it reports
 * `available: false` — either way every function here refuses in one line and
 * the co-op screen keeps its existing relay and manual paths. That is the whole
 * inertness contract: no import, one guard.
 *
 * ## Why the two directions travel differently
 *
 * `Lobby.setData` is owner-only in Steam's model, and steamworks.js@0.4.0 binds
 * neither lobby member data nor lobby chat (verified against the shipped
 * binary — see `.superpowers/sdd/2026-08-12-steamworks-wiring/`). So a joiner
 * has no way to write anything into lobby data. The exchange is therefore
 * asymmetric, and deliberately so:
 *
 *   host -> joiner   the SDP offer, chunked across `sdp.offer.*` lobby-data
 *                    keys (the host IS the owner), read by a 1 s poll
 *   joiner -> host   the SDP answer, one reliable Steam P2P packet addressed to
 *                    the lobby owner. An answer is a few kB; Reliable carries up
 *                    to 1 MB, so this leg needs no chunking at all, and the host
 *                    learns the sender's Steam id for free.
 *
 * The blobs themselves are the ones the manual copy/paste path already
 * produces: `Lobby.createInvite()` mints the offer, `Lobby.joinManual(offer)`
 * returns the answer, `Lobby.acceptAnswer(answer)` completes the connection.
 * Steam is only the courier — nothing about the peer connection changes.
 */

/**
 * Chars per lobby-data value. The bridge rejects any value over 7000 (its
 * `validateLobbyRecord`); this leaves headroom so a cap change there cannot
 * silently start rejecting writes here.
 */
export const CHUNK_CHARS = 6000;

/** The bridge rejects a record of more than 64 keys, and one of ours is the count. */
const MAX_PARTS = 63;

const OFFER_PREFIX = 'sdp.offer';
const POLL_MS = 1000;
const OFFER_WAIT_MS = 60000;

/**
 * Cut a blob into lobby-data pairs.
 *
 * `${prefix}.n` carries the part count and every `${prefix}.<i>` carries a
 * slice. The count is a separate key rather than a sentinel because lobby data
 * arrives all at once or half-written — a reader needs to know how many parts
 * to expect *before* it can tell "still arriving" from "complete".
 */
export function chunkBlob(prefix, blob) {
  const s = String(blob ?? '');
  const parts = [];
  for (let i = 0; i < s.length; i += CHUNK_CHARS) parts.push(s.slice(i, i + CHUNK_CHARS));
  const pairs = [[`${prefix}.n`, String(parts.length)]];
  for (let i = 0; i < parts.length; i++) pairs.push([`${prefix}.${i}`, parts[i]]);
  return pairs;
}

/**
 * Reassemble what `chunkBlob` wrote, or `null` if it is not all there yet.
 *
 * `getter(key)` returns the value or null. Everything it hands back came from
 * another player's Steam client, so nothing here trusts it: the count must be a
 * plain non-negative integer inside the key budget (`'1e3'`, `'2.5'` and `'-1'`
 * are all refused, which bare `Number()` would not do), every part must be a
 * string, and a getter that throws is a `null` rather than an exception thrown
 * out of somebody's poll timer.
 */
export function assembleBlob(getter, prefix) {
  const read = (k) => { try { return getter(k); } catch { return undefined; } };

  const rawCount = read(`${prefix}.n`);
  if (typeof rawCount !== 'string' || !/^\d+$/.test(rawCount)) return null;
  const count = Number(rawCount);
  if (count > MAX_PARTS) return null;

  const parts = [];
  for (let i = 0; i < count; i++) {
    const part = read(`${prefix}.${i}`);
    if (typeof part !== 'string') return null;
    parts.push(part);
  }
  return parts.join('');
}

// -------------------------------------------------------------- the bridge

/**
 * The desktop bridge, or null.
 *
 * `typeof window` rather than a bare reference: this module is imported by a
 * node test and by the bundler's own module graph, neither of which has a
 * window, and neither may throw for it.
 */
function bridge() {
  try {
    if (typeof window === 'undefined') return null;
    return window.__STEAM__ || null;
  } catch { return null; }
}

/** True only inside the Electron shell, with Steam running and answering. */
export async function steamAvailable() {
  const b = bridge();
  if (!b || typeof b.status !== 'function') return false;
  try {
    const s = await b.status();
    return s?.available === true;
  } catch { return false; }
}

/** Every bridge call answers `{ ... }` or `{ error: '<slug>' }`. This is the door. */
function unwrap(res, what) {
  if (!res || typeof res !== 'object') throw new Error(`${what}: the Steam bridge gave no answer.`);
  if (res.error) throw new Error(`${what}: ${String(res.error)}`);
  return res;
}

async function requireSteam() {
  const b = bridge();
  if (!b) throw new Error('This build has no Steam bridge — use a room code or an invite code.');
  if (!(await steamAvailable())) throw new Error('Steam is not running, or did not answer. Use a room code or an invite code.');
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hang a teardown on the Lobby's own dispose path.
 *
 * `Lobby.leave()` is the single place a co-op session ends — the Leave button,
 * a failed join, a new session — and a Steam lobby that outlives it is a lobby
 * the player is silently still sitting in, still joinable from their friends
 * list. `leave()` calls `_steamCleanup` and clears the slot; the whole thing is
 * idempotent, so calling it from a `catch` as well costs nothing.
 *
 * The steps are a list rather than one function body, and that is the whole
 * point: each runs inside its own `try/catch`, so an earlier one failing cannot
 * cancel a later one. Written as a single body, a throw from the first
 * unsubscribe closure would skip `leaveLobby` — and because the latch is
 * already set, nothing would ever retry it, leaking exactly the lobby this hook
 * exists to release.
 *
 * Steps are *started* synchronously and in order, because the joiner's first
 * step sets the flag its poll loop reads and that cannot wait for a microtask.
 * The bridge calls are `ipcRenderer.invoke` promises and nothing awaits them —
 * `Lobby.leave()` is synchronous and cannot — so their rejections are absorbed
 * here rather than left to become unhandled rejections on a page that is only
 * tidying up. Confirming they succeeded would mean making `leave()` async, and
 * a teardown nobody can wait for is the honest shape of this.
 */
function armCleanup(lobby, steps) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    for (const step of steps) {
      try {
        const r = step();
        if (r && typeof r.then === 'function') r.then(undefined, () => {});
      } catch { /* the next step still has to run */ }
    }
  };
  if (lobby) lobby._steamCleanup = once;
  return once;
}

// ---------------------------------------------------------------- the dance

/**
 * Host through a Steam lobby. Resolves with `{ lobbyId }` once the lobby is
 * open and the offer is posted — the same moment `hostViaRelay` resolves with
 * its room code (`Lobby.js:259-260`, at `roomOpen`), i.e. when a friend *can*
 * join, not when one has. Everything downstream is identical: the same
 * `startHost()`, the same `roomOpen` status, the same `peerJoined` when the
 * peer connection opens, and a plain `Error` on every failure.
 *
 * The offer is minted once, here, exactly as the manual path does — this is a
 * two-seat feature, and re-minting per joiner is the relay path's problem to
 * have (`Lobby.js:261-272`).
 */
export async function hostViaSteam(lobby, { maxMembers = 2 } = {}) {
  const b = await requireSteam();

  const { lobbyId } = unwrap(await b.hostLobby(maxMembers), 'Steam lobby');
  if (typeof lobbyId !== 'string' || !lobbyId) throw new Error('Steam lobby: no lobby id came back.');

  // Armed before anything else can fail, so every path below leaves nothing
  // behind: an abandoned Steam lobby is invisible to the player who abandoned it.
  let offSignal = null;
  let offFail = null;
  const cleanup = armCleanup(lobby, [
    () => offSignal?.(),
    () => offFail?.(),
    () => b.stopSignalListen?.(),
    () => b.leaveLobby?.(lobbyId),
  ]);

  try {
    const invite = await lobby.createInvite();
    const pairs = chunkBlob(OFFER_PREFIX, invite.blob);
    if (pairs.length - 1 > MAX_PARTS) throw new Error('Steam lobby: this invite is too large for lobby data.');
    unwrap(await b.writeLobbyData(lobbyId, Object.fromEntries(pairs)), 'Steam lobby');
    unwrap(await b.startSignalListen(lobbyId), 'Steam lobby');

    offSignal = b.onSignal(async (msg) => {
      // Another player's bytes. The bridge already validated the envelope in the
      // main process; this is the second look, because a renderer that trusts
      // its own preload is one preload bug away from feeding `acceptAnswer`
      // whatever arrived on the wire.
      const answer = typeof msg?.payload === 'string' ? msg.payload.trim() : '';
      if (!answer) return;
      // One answer is the whole exchange for two seats. Stop listening first, so
      // a second packet arriving during `acceptAnswer` cannot start a second one.
      offSignal?.();
      offSignal = null;
      try {
        await lobby.acceptAnswer(answer);
      } catch {
        // `acceptAnswer` already set `peerFailed` with the reason; there is no
        // caller left to throw at — this is a bridge callback.
      } finally {
        b.stopSignalListen?.();
      }
    });

    offFail = b.onSignalFail?.(() => {
      lobby._set?.('peerFailed', { detail: 'Steam could not open a connection to that player.' });
    }) || null;

    lobby._set?.('roomOpen', { code: lobbyId, steam: true });
    return { lobbyId };
  } catch (err) {
    cleanup();
    if (lobby) lobby._steamCleanup = null;
    throw err;
  }
}

/**
 * Join a Steam lobby the local player was invited to. Resolves once the answer
 * is on its way to the host — the same point `joinViaRelay` resolves
 * (`Lobby.js:320-322`), after its `ws.send({ type: 'answer' })` — with the same
 * `undefined`, the same `joining`/`answerReady`/`connected` statuses from
 * `joinManual`, and a plain `Error` on failure.
 */
export async function joinViaSteam(lobby, lobbyId, { pollMs = POLL_MS, waitMs = OFFER_WAIT_MS } = {}) {
  const b = await requireSteam();
  const id = String(lobbyId ?? '');
  if (!/^\d+$/.test(id)) throw new Error('Steam lobby: that is not a lobby id.');

  unwrap(await b.joinLobby(id), 'Steam lobby');

  let abandoned = false;
  const cleanup = armCleanup(lobby, [
    // Read by the poll loop below: a player who pressed Leave while waiting for
    // the host's offer must stop the timer, not merely be ignored by it. First
    // in the list, and set synchronously, so it lands before anything else can
    // throw its way past it.
    () => { abandoned = true; },
    () => b.leaveLobby?.(id),
  ]);

  try {
    const deadline = Date.now() + waitMs;
    let offer = null;
    for (;;) {
      if (abandoned) throw new Error('Steam lobby: left before the host posted an invite.');
      const { data } = unwrap(await b.getFullLobbyData(id), 'Steam lobby');
      const record = data && typeof data === 'object' ? data : {};
      offer = assembleBlob((k) => (Object.prototype.hasOwnProperty.call(record, k) ? record[k] : null), OFFER_PREFIX);
      if (offer) break;
      if (Date.now() >= deadline) throw new Error(`Steam lobby: the host never posted an invite (waited ${Math.round(waitMs / 1000)} s).`);
      await sleep(pollMs);
    }
    if (abandoned) throw new Error('Steam lobby: left before the host posted an invite.');

    const answer = await lobby.joinManual(offer);
    const { steamId } = unwrap(await b.getLobbyOwner(id), 'Steam lobby');
    if (typeof steamId !== 'string' || !steamId) throw new Error('Steam lobby: the lobby has no owner to answer.');
    unwrap(await b.sendSignal(steamId, answer), 'Steam lobby');

    // Deliberately still in the Steam lobby. The host only accepts a P2P session
    // from a *current member* of its lobby, so leaving the instant the answer is
    // sent would race the packet and lose. The lobby is released on
    // `Lobby.leave()` like the host's.
  } catch (err) {
    cleanup();
    if (lobby) lobby._steamCleanup = null;
    throw err;
  }
}

/**
 * Accepting an invite from the Steam friends list. Returns an unsubscribe
 * function, or null when there is no Steam — so a caller can register this
 * unconditionally at start-up and get a no-op in the browser.
 */
export function onSteamInvite(handler) {
  const b = bridge();
  if (!b || typeof b.onJoinRequested !== 'function') return null;
  return b.onJoinRequested((msg) => {
    const lobbyId = typeof msg?.lobbyId === 'string' ? msg.lobbyId : '';
    if (/^\d+$/.test(lobbyId)) handler(lobbyId);
  });
}

/** Open Steam's own invite dialog over the game. Needs the overlay. */
export async function openSteamInvite(lobbyId) {
  const b = bridge();
  if (!b || typeof b.openInviteDialog !== 'function') throw new Error('This build has no Steam bridge.');
  const res = unwrap(await b.openInviteDialog(String(lobbyId ?? '')), 'Steam invite');
  // The bridge reports whether the overlay was actually enabled. Without it the
  // call is a silent no-op, which the player would read as a broken button.
  if (res.overlay === false) throw new Error('The Steam overlay is not available, so the invite dialog cannot open.');
  return res;
}
