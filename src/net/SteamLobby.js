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
 * ## What a Steam lobby can actually hold
 *
 * Steam's lobby metadata is a single ~8192-byte budget for the WHOLE lobby —
 * every key and every value, added together — not a per-key limit. Measured
 * against the live client on appid 480 rather than inherited from a doc: one
 * 8174-char value under an 11-byte key is accepted and 8175 is refused, but
 * fifteen 500-char values under `sdp.offer.<i>` keys are accepted and the
 * sixteenth is refused at a raw total of 8182, and key text is charged exactly
 * as value text is. `desktop/steam-validate.mjs` carries the full measurement
 * and the matching main-process guard.
 *
 * Everything below is derived from that one number.
 */

/**
 * What the offer may spend, in UTF-8 bytes across all keys and values.
 *
 * 8192 - 512, the same figure `MAX_LOBBY_TOTAL_BYTES` names in
 * `desktop/steam-validate.mjs`. It is restated rather than imported because no
 * `src/` file may reach into the desktop shell; the bridge enforces the same
 * number in the main process, so a drift between the two is a refusal with a
 * message, never a half-written lobby.
 */
export const MAX_LOBBY_TOTAL_BYTES = 7680;

/**
 * Chars per lobby-data value.
 *
 * Derived, not chosen for comfort: with a 7680-byte budget, framing costs
 * `sdp.offer.n` plus its count (12 bytes) and 11 bytes per chunk key, so the
 * budget carries 7624 chars of payload once four chunk keys are paid for. 2000
 * is the largest round size that lets a blob use the whole budget — at 6000 a
 * second chunk would already overflow it, which would have thrown away 22% of
 * the capacity Steam does offer. It is also comfortably under the bridge's
 * 7000-char structural per-value cap.
 */
export const CHUNK_CHARS = 2000;

/**
 * The structural ceiling on parts: `ceil(MAX_LOBBY_TOTAL_BYTES / CHUNK_CHARS)`.
 * No record the byte budget permits can carry more, so this is the cheap bound
 * `assembleBlob` applies to an untrusted part count before it starts making
 * getter calls. The byte budget, not this, is what refuses a real oversize
 * offer.
 */
const MAX_PARTS = Math.ceil(MAX_LOBBY_TOTAL_BYTES / CHUNK_CHARS);

/**
 * The UTF-8 cost of a pair list against the budget.
 *
 * `TextEncoder` rather than `.length`: Steam counts bytes, and an SDP blob that
 * ever carried a non-ASCII byte would otherwise measure short here and be
 * refused there — which is exactly the class of surprise this guard exists to
 * remove.
 */
export function recordBytes(pairs) {
  const enc = new TextEncoder();
  let bytes = 0;
  for (const [key, value] of pairs) bytes += enc.encode(key).length + enc.encode(String(value)).length;
  return bytes;
}

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

/**
 * The bridge's error slugs, in words a player can act on.
 *
 * A slug is a name for a condition, not an account of it: "Steam lobby:
 * lobby-data-write-refused" told a player what our variable was called and
 * nothing about what went wrong or what to do instead. Every slug the main
 * process can hand back from a path a player can reach is answered here with a
 * cause and a remedy. Slugs not listed still pass through verbatim — an
 * unrecognised one is a bug report, and blanking it would cost more than it
 * saves.
 */
const BRIDGE_REASONS = {
  'steam-unavailable': 'Steam stopped answering. Use a room code or an invite code instead.',
  'unknown-lobby': 'that Steam lobby is no longer open. Ask your friend to host again.',
  'bad-lobby-id': 'that invite does not name a real Steam lobby.',
  'lobby-id-unreadable': 'Steam opened a lobby but would not say which one. Try hosting again.',
  'owner-unreadable': 'Steam would not say who owns that lobby, so there is nobody to answer.',
  'lobby-data-over-budget':
    'the invite is larger than a Steam lobby can hold. Use a room code or an invite code instead.',
  'lobby-data-write-refused':
    'Steam refused to store the invite in the lobby. That happens when the lobby is already full of data or somebody else owns it — leave the lobby and host again, or use a room code.',
  'signal-send-refused': 'Steam would not deliver the reply to the host. Ask them to host again.',
  'bad-steam-id': 'the host’s Steam account could not be identified, so the reply had nowhere to go.',
  'signal-target-not-lobby-owner':
    'that Steam account is not the owner of a lobby you are in, so the reply was not sent. Ask your friend to host again.',
};

/** Every bridge call answers `{ ... }` or `{ error: '<slug>' }`. This is the door. */
function unwrap(res, what) {
  if (!res || typeof res !== 'object') throw new Error(`${what}: the Steam bridge gave no answer.`);
  if (res.error) {
    const slug = String(res.error);
    throw new Error(`${what}: ${BRIDGE_REASONS[slug] || slug}`);
  }
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
  // A latch already parked here belongs to an EARLIER Steam session on this same
  // Lobby — a second "Host via Steam", or a Steam invite accepted while already
  // hosting. Overwriting it was the whole of Important 2: `leave()` can only ever
  // run the newest latch, so the older session's Steam lobby was orphaned for the
  // life of the process, still listed and still joinable by a friend whose answer
  // the host would then refuse. Run it first, and the older session is released
  // by exactly the code written to release it.
  const previous = lobby && lobby._steamCleanup;
  if (typeof previous === 'function') {
    lobby._steamCleanup = null;      // cleared first: a latch must never re-enter itself
    try { previous(); } catch { /* it swallows its own steps; this is belt and braces */ }
  }

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

  // FIX ROUND 2 (re-review, the host-then-accept-invite finding's mirror
  // case). Checked before anything below touches the bridge — no new Steam
  // lobby is created, no latch runs — so a player who is already a CLIENT of
  // someone else's game (accepted a Steam invite, or joined by room code)
  // cannot have that session's Steam membership released by a "Host via
  // Steam" press that was always going to fail. `mode === 'host'` is
  // deliberately still allowed through: that is the double-host / re-host
  // case Important 2 fixed, `Lobby.createInvite()` itself reuses the
  // existing `NetHost` rather than starting a second one when already
  // hosting, and the old Steam lobby's release there is the intended
  // "re-advertise my running game" behaviour, not a bug.
  if (lobby && lobby.mode === 'client')
    throw new Error("Steam lobby: you're already in a game. Leave it first, then host your own.");

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
    // Measured before the write, not discovered by it. A `mergeFullData` Steam
    // refuses does not refuse cleanly: it stores entries until it hits the wall,
    // so `sdp.offer.n` can land without the chunks it counts and a joiner then
    // spends its whole 60 s poll waiting for a part that is never coming. Asking
    // first is the only way that state is never reached.
    const bytes = recordBytes(pairs);
    if (bytes > MAX_LOBBY_TOTAL_BYTES || pairs.length - 1 > MAX_PARTS)
      throw new Error(
        `Steam lobby: this invite needs ${bytes} bytes and a Steam lobby holds ${MAX_LOBBY_TOTAL_BYTES} in total, `
        + 'so it cannot be posted. That usually means your network is offering an unusual number of connection routes — '
        + 'use a room code or an invite code instead.');
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

  // FIX ROUND 2 (re-review Important, host-then-accept-invite). Checked
  // BEFORE `armCleanup` ever runs the previous latch, and before the new
  // Steam lobby is even joined: `Lobby.joinManual` (below, `:401` area)
  // would refuse this exact join with `this.net` already set — this attempt
  // was always going to fail — so the only question was whether reaching
  // that failure took the CURRENT session's Steam lobby down with it first.
  // `armCleanup`'s "run the previous latch" step is what did that: it fires
  // synchronously, before the new invite's outcome is known at all. No
  // partial teardown: decide, and refuse completely, BEFORE releasing
  // anything. This also closes the accept-invite-while-already-joined
  // mirror case (`mode === 'client'` here too) — a second invite must not
  // cost the player the first one they already accepted.
  // `lobby.mode != null`, not a bare inequality: the real `Lobby` always
  // initialises `mode = 'single'` in its constructor (`Lobby.js:52`), so this
  // never differs in production, but a `null`/`undefined` mode reads as "not
  // networked" rather than "blocked" for any caller that has not threaded one
  // through — the same defensive shape `steamInviteBlocked` uses.
  if (lobby && lobby.mode != null && lobby.mode !== 'single') {
    throw new Error(lobby.mode === 'host'
      ? "Steam lobby: you're already hosting a game. Leave it first, then accept a Steam invite."
      : "Steam lobby: you're already in a game. Leave it first, then accept another Steam invite.");
  }

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
      // `!== null`, not truthy: `chunkBlob('sdp.offer', '')` is a legal write —
      // `sdp.offer.n = '0'` and no parts — and `assembleBlob` correctly returns
      // `''` for it. A bare `if (offer)` reads that as "not yet" and burns the
      // whole 60 s bound on an invite that already fully arrived (Minor 2).
      if (offer !== null) break;
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
 * Should a friend's "Join game" click ask before it acts, rather than act?
 *
 * Important 4: this invite used to run unconditionally — mid single-player
 * run or already networked, the session in flight was discarded with no
 * confirmation and no way to say no. The two states that must not be torn
 * down silently are a run in progress and an existing network session; idle
 * at a menu with nothing networked is the only state a direct join is safe
 * in, and it is the state the two-seat checkpoint actually exercises.
 *
 * Pure and UI-free on purpose — this is the one fact the caller has to get
 * right, and it is exactly the fact a DOM-dependent test in this codebase
 * cannot cheaply exercise (see `tests/steamlobby.test.mjs`).
 *
 * @param {{ hasActiveRun: boolean, lobbyMode: 'single'|'host'|'client'|null|undefined }} state
 */
export function steamInviteNeedsConfirm({ hasActiveRun, lobbyMode }) {
  return !!hasActiveRun || (lobbyMode != null && lobbyMode !== 'single');
}

/**
 * Would accepting this invite fail outright, no matter what the player
 * chooses? (Fix round 2, re-review.) `joinViaSteam` now refuses up front
 * whenever `lobbyMode !== 'single'` — the player is already hosting or
 * already a client of some other session, and `Lobby.joinManual`'s own
 * `this.net` guard means the join could never have succeeded anyway. That
 * case is not a confirmation ("do you want to trade session A for session
 * B?") because there is no trade on offer — it is a plain refusal, and an
 * Accept/Decline prompt is the wrong affordance for a choice that is not
 * actually a choice. `Menus.bindSteam` checks this FIRST, before
 * `steamInviteNeedsConfirm`, so the accept/decline banner is only ever shown
 * for the one case where accepting can genuinely succeed: idle at a menu, or
 * mid a single-player run with nothing networked yet.
 */
export function steamInviteBlocked({ lobbyMode }) {
  return lobbyMode != null && lobbyMode !== 'single';
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
