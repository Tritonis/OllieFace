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
 * `SetLobbyData` is owner-only in Steam's model, so a joiner cannot write into
 * the lobby's own data. Both legs nonetheless travel over lobby metadata now,
 * symmetrically, because Steam has a second slot the joiner DOES own:
 *
 *   host -> joiner   the SDP offer, chunked across `sdp.offer.*` LOBBY-data
 *                    keys (the host IS the owner), read by a 1 s poll
 *   joiner -> host   the SDP answer, chunked across `sdp.answer.*` MEMBER-data
 *                    keys on the joiner's own membership, read by the host's own
 *                    1 s poll across every member of the lobby
 *
 * `SetLobbyMemberData` writes the CALLER's member data and no one else's —
 * Steam gives no API to write another member's — so the answer leg needs no
 * membership gate of its own. That is a property of the platform, not of this
 * code, and it is why this leg is simpler than the one it replaced.
 *
 * ## What this used to be, and why it changed
 *
 * Until 2026-08-21 the answer was one reliable Steam P2P packet addressed to the
 * lobby owner, because `steamworks.js@0.4.0` bound neither lobby member data nor
 * lobby chat (verified against the shipped binary — see
 * `.superpowers/sdd/2026-08-12-steamworks-wiring/`). The Binding swap removed
 * both halves of that: `steamworks-ffi-node` binds member data, and binds no
 * `ISteamNetworking` at all, so the packet leg lost its carrier on the same day
 * its workaround stopped being necessary. This is the design the plan wanted
 * originally, arrived at late.
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
 * budget carries 7598 chars of payload once four chunk keys and the exchange
 * nonce (`sdp.offer.nonce`, 15 bytes of key and ~11 of value) are paid for. 2000
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
/** The joiner's half of the exchange, on the joiner's own member data. */
export const ANSWER_PREFIX = 'sdp.answer';

/**
 * The key each side stamps with the exchange's nonce.
 *
 * ## Why an exchange needs a name
 *
 * Member data is not a queue and reading it does not consume it. A friend's
 * `sdp.answer.*` sits in their membership until they overwrite it or leave —
 * and "leave" is exactly what a friend recovering from a dropped peer
 * connection does NOT do, because their Steam lobby membership survives a dead
 * WebRTC connection. So when the host re-advertises (mints a new offer over the
 * same lobby, which is the whole point of re-advertise), the fresh poll's very
 * first tick finds the PREVIOUS attempt's answer still sitting there, hands it
 * to `acceptAnswer`, and stops. The friend's real answer to the new offer is
 * written a moment later and never read, and nothing surfaces to either player:
 * the host believes it heard, the friend believes it answered.
 *
 * A timestamp would not fix this — clocks are two different machines' — and
 * "clear the member data first" cannot be done, because only the member who
 * owns a slot may write it. What distinguishes the two answers is not when they
 * arrived but WHICH OFFER they are an answer to. So every offer is stamped with
 * a nonce, the joiner echoes the nonce of the offer it actually read, and an
 * answer whose echo does not match the current offer is not an answer at all —
 * it is last round's, and the poll keeps listening.
 */
const NONCE_KEY = 'nonce';
const OFFER_NONCE_KEY = `${OFFER_PREFIX}.${NONCE_KEY}`;
const ANSWER_NONCE_KEY = `${ANSWER_PREFIX}.${NONCE_KEY}`;

/**
 * A fresh exchange name.
 *
 * Not cryptographic and does not need to be: it names one handshake between two
 * consenting players, and the only thing it has to beat is the PREVIOUS value
 * on the same lobby. Time plus randomness gives that, monotonically enough that
 * two attempts a millisecond apart still differ, and it stays inside the
 * lobby-data key shape (`LOBBY_KEY_RE`, alphanumerics and dots) that the shell
 * validates on the way through.
 */
export function mintNonce() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36).padStart(5, '0')}`;
}

/**
 * Exactly what the host writes into lobby data, and what the joiner writes into
 * its own member data — chunks plus the stamp.
 *
 * Both exist so that "how big is the record" has ONE answer. The byte guard,
 * the write, and the test that proves the budget is usable to its last byte all
 * measure the same function; before these, the guard measured `chunkBlob` and
 * the write added a key to it, which is how a budget check quietly stops
 * checking the thing that is written.
 */
/**
 * How many CHUNKS a pair list carries.
 *
 * Counted by key shape rather than by list length, because the list also holds
 * `.n` and the exchange nonce. `pairs.length - 1` was right until the nonce was
 * added, and then quietly refused a legal four-chunk offer as a five-part one —
 * a budget guard that had started measuring something other than the budget.
 */
const countParts = (pairs) => pairs.filter(([k]) => /\.\d+$/.test(k)).length;

export const offerPairs = (blob, nonce) => [...chunkBlob(OFFER_PREFIX, blob), [OFFER_NONCE_KEY, nonce]];
export const answerPairs = (blob, nonce) => [...chunkBlob(ANSWER_PREFIX, blob), [ANSWER_NONCE_KEY, nonce ?? '']];
const POLL_MS = 1000;
const OFFER_WAIT_MS = 60000;

/**
 * How long the host keeps looking for an answer before it stops.
 *
 * Five minutes, not the joiner's sixty seconds, and the asymmetry is deliberate.
 * The joiner's bound measures one thing that either happens promptly or not at
 * all — the host writing an offer it has already minted. The host's bound spans
 * a human: a friend has to see the invite, alt-tab, accept it, and let the game
 * boot before they can even read the offer. A minute is well inside that, and
 * an expired poll leaves the lobby advertised and deaf, which is the one state
 * this module refuses everywhere else.
 */
const ANSWER_WAIT_MS = 300000;

/**
 * Every key the answer can occupy, computed once.
 *
 * Sent to the shell on every poll tick, so the shell never has to know the
 * protocol and the page never gets to name an unbounded key list: it is
 * `MAX_PARTS + 1` entries and it is a constant.
 */
export const answerKeys = () => {
  const keys = [`${ANSWER_PREFIX}.n`, ANSWER_NONCE_KEY];
  for (let i = 0; i < MAX_PARTS; i++) keys.push(`${ANSWER_PREFIX}.${i}`);
  return keys;
};

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

/**
 * Pick the first complete answer to THIS offer out of one `collectMemberData`
 * reply.
 *
 * Pure, so the thing worth getting right is testable without a timer: every
 * member's record is another player's bytes, `assembleBlob` already refuses a
 * half-written or malformed one, and an EMPTY answer is not an answer — a
 * member who has written nothing yet has no `sdp.answer.n` at all, and one who
 * wrote an empty string has nothing for `acceptAnswer` to do.
 *
 * `nonce` is the current offer's, and it is the load-bearing argument: without
 * it a re-advertise re-accepts the previous attempt's leftover answer on its
 * first tick and never hears the real one (see `NONCE_KEY`). A record whose
 * echo does not match is skipped exactly as a half-written one is — the poll
 * keeps listening, which is the whole point. A caller may pass `null` to mean
 * "any answer", and nothing in this module does.
 *
 * `exclude` is the host's own Steam id where the caller knows it. Steam counts
 * the owner as a member, and a host that somehow read its own slot would hand
 * its own blob to `acceptAnswer`; the empty-answer rule already covers it in
 * practice, and this is the cheap belt.
 *
 * @param {Record<string, Record<string,string>>} members
 * @param {string|null} [nonce] the nonce the current offer was stamped with
 * @param {string|null} [exclude]
 * @returns {{ steamId: string, answer: string }|null}
 */
export function pickMemberAnswer(members, nonce = null, exclude = null) {
  if (!members || typeof members !== 'object') return null;
  for (const [steamId, record] of Object.entries(members)) {
    if (steamId === exclude) continue;
    if (!record || typeof record !== 'object') continue;
    // The echo first, because it is the cheap test and the one that makes a
    // stale answer invisible rather than merely unwanted.
    if (nonce !== null && record[ANSWER_NONCE_KEY] !== nonce) continue;
    const answer = assembleBlob(
      (k) => (Object.prototype.hasOwnProperty.call(record, k) ? record[k] : null), ANSWER_PREFIX);
    if (typeof answer === 'string' && answer.trim()) return { steamId, answer: answer.trim() };
  }
  return null;
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

/**
 * How long a bridge call taken BEFORE a teardown latch exists may go unanswered.
 *
 * Generous by an order of magnitude — opening a Steam lobby is a sub-second
 * round trip in the field — because this bound is not a performance budget, it
 * is the difference between a hung Steam client costing one dead button press
 * and costing the whole co-op feature for the life of the page.
 */
const BRIDGE_TIMEOUT_MS = 15000;

/**
 * A bridge call that never answers, bounded (fix round 4).
 *
 * `ipcRenderer.invoke` rejects when the main handler throws, but *hangs* when
 * the handler awaits something that never settles — and every Steam call in
 * `desktop/main.mjs` awaits a steamworks.js promise that a Steam callback
 * resolves, with no timeout anywhere in that chain. A Steam client that is hung,
 * updating, or mid-restart simply never fires the callback.
 *
 * That matters in exactly one window: between `beginSteamOp` taking the
 * in-flight claim and `armCleanup` parking a latch on the Lobby. Past
 * `armCleanup` the Leave button is the recovery and it works, by design. Before
 * it there is no latch for `Lobby.leave()` to run, so the claim is held forever
 * and every subsequent "Host via Steam" and every accepted invite is refused as
 * busy, permanently, with no player-visible way back. A stuck latch is as bad as
 * the race it fixes, so every call in that window is bounded here.
 *
 * The bound is a rejection with an actionable sentence, and the operation's own
 * `finally` releases the claim on the way out — the ordinary failure path, not a
 * new one. The main process may still finish the call afterwards and be left
 * holding a lobby the renderer forgot; `releaseAllSteamState()` frees it on
 * window teardown, and that is strictly less bad than a permanent denial.
 *
 * `ms` is the same kind of seam `joinViaSteam`'s `pollMs`/`waitMs` already are:
 * both entry points take `bridgeMs` so a test can drive the unanswered-call path
 * in milliseconds instead of a quarter of a minute. Nothing in the app passes it.
 */
function withTimeout(promise, what, ms = BRIDGE_TIMEOUT_MS) {
  let timer = null;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${what}: Steam did not answer in time. `
      + 'It may be busy or updating — try again in a moment, or use a room code or an invite code.',
    )), ms);
  });
  // `race` attaches a handler to both, so a late rejection from `promise` is
  // absorbed rather than surfacing as an unhandled rejection; `finally` clears
  // the timer on either outcome, so no bound outlives the call it bounds.
  return Promise.race([Promise.resolve(promise), bound]).finally(() => clearTimeout(timer));
}

/** True only inside the Electron shell, with Steam running and answering. */
export async function steamAvailable(bridgeMs = BRIDGE_TIMEOUT_MS) {
  const b = bridge();
  if (!b || typeof b.status !== 'function') return false;
  try {
    const s = await withTimeout(b.status(), 'Steam', bridgeMs);
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
  'friends-unavailable':
    'this build of the Steam bridge cannot read your friends list, so there is nobody to pick. Use a room code or an invite code instead.',
  'invite-unavailable':
    'this build of the Steam bridge cannot send invites. Use a room code or an invite code instead.',
  'invite-refused': 'Steam would not deliver that invite. They may have left, or blocked invites.',
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

async function requireSteam(bridgeMs) {
  const b = bridge();
  if (!b) throw new Error('This build has no Steam bridge — use a room code or an invite code.');
  if (!(await steamAvailable(bridgeMs))) throw new Error('Steam is not running, or did not answer. Use a room code or an invite code.');
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A sleep that is not a reason for the process to live.
 *
 * Same discipline as the callback pump in the shell: the host answer poll runs
 * in the background for minutes, and a ref'd timer would keep node alive for
 * the whole of it in any test that forgets to tear the host down. `unref` does
 * not exist on a browser timer id, which is why it is asked for rather than
 * assumed.
 */
const idleSleep = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  if (t && typeof t.unref === 'function') t.unref();
});

/**
 * Claim this Lobby for one Steam operation, or refuse.
 *
 * ## Why `lobby.mode` was never enough (fix round 3)
 *
 * The round-2 guards below ask `lobby.mode` whether a session already exists.
 * `mode` is a *completion* signal: `Lobby.startHost()` and `Lobby.joinManual()`
 * set it, and `joinViaSteam` does not reach `joinManual` until its poll loop has
 * found a complete offer — up to `OFFER_WAIT_MS`, a full minute. For that whole
 * minute a join is unmistakably happening and `mode` still reads `'single'`,
 * exactly as it reads when nothing is happening at all. A second Steam operation
 * arriving inside that window — a second friend's "Join game", or the player
 * pressing "Host via Steam" out of impatience — sailed past both guards and then
 * released the first operation's Steam lobby through `armCleanup`'s previous-latch
 * step, before the first operation's own outcome was known. That is the partial
 * teardown the invariant forbids, and no completion-state check can see it.
 *
 * So this is an *in-flight* latch, and three properties make it one:
 *
 *  - It is read and written **synchronously**, before either function's first
 *    `await`. `requireSteam()` alone is two awaits; a check that happens after
 *    them is already a race.
 *  - Any operation in flight refuses any new one. Uniformly — a join can never
 *    supersede anything, and a *concurrent* host press is wave 1's impatient
 *    double-press, which its UI guard already intended to make impossible and
 *    which nothing downstream is prepared for. The deliberate asymmetry stays
 *    exactly where round 2 put it: a **settled** `mode === 'host'` still passes
 *    `hostViaSteam`, because that is the re-advertise gesture, and this latch is
 *    empty by then.
 *  - The releaser compares **identity**, not truthiness, so a latch released late
 *    (a teardown, a rejected promise settling after the fact) can never clear a
 *    newer operation's claim.
 *
 * Every exit path clears it, and fix round 4 is what makes that true rather than
 * nearly true. `finally` covers resolve, throw and the 60 s bound; the releaser
 * is also the first step of the operation's `armCleanup` list, so a
 * `Lobby.leave()` mid-poll frees the latch at once rather than a poll tick later.
 * The gap was the window *before* `armCleanup` is armed — `requireSteam()` and
 * the opening `hostLobby`/`joinLobby` — where there is no latch for `leave()` to
 * run and a bridge call that never answers held the claim for the life of the
 * page. Those calls are now bounded (`withTimeout`), so that window ends in a
 * rejection and a released claim like every other.
 */
function beginSteamOp(lobby, kind) {
  const busy = lobby && lobby._steamOp;
  if (busy) {
    const doing = busy.kind === 'host'
      ? "you're still opening your own Steam lobby"
      : "you're still joining a friend's game";
    const then = kind === 'host' ? 'then host your own.' : 'then try that invite again.';
    throw new Error(`Steam lobby: ${doing}. Wait for that to finish, or leave, ${then}`);
  }
  const op = { kind };
  if (lobby) lobby._steamOp = op;
  return () => { if (lobby && lobby._steamOp === op) lobby._steamOp = null; };
}

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
function armCleanup(lobby, steps, { holds = null, release = [] } = {}) {
  // A latch already parked here belongs to an EARLIER Steam session on this same
  // Lobby — a second "Host via Steam", or a Steam invite accepted while already
  // hosting. Overwriting it was the whole of Important 2: `leave()` can only ever
  // run the newest latch, so the older session's Steam lobby was orphaned for the
  // life of the process, still listed and still joinable by a friend whose answer
  // the host would then refuse. Run it first, and the older session is released
  // by exactly the code written to release it.
  //
  // `holds` names the Steam lobby this operation is taking responsibility for.
  // When the previous latch held the SAME one, the new operation is not replacing
  // that lobby, it is taking it over (fix round 3's re-advertise path), so the
  // previous latch runs its listener teardown and skips its `release` group. The
  // new latch inherits the duty of freeing the lobby, and it is the only latch
  // that can — `done` has already fired on the old one.
  //
  // Fix round 4 moved the re-advertise path off this branch: it lifts the previous
  // latch off the slot itself and runs it only once the replacement listeners are
  // live, because running it *here* tore the running session's ears off at the top
  // of an attempt that might still fail. This same-`holds` case is kept as the
  // backstop for any future caller that takes a lobby over without doing that —
  // skipping the release group is the correct answer for one either way.
  const previous = lobby && lobby._steamCleanup;
  if (typeof previous === 'function') {
    lobby._steamCleanup = null;      // cleared first: a latch must never re-enter itself
    const keepLobby = holds != null && previous.holds != null && previous.holds === holds;
    try { previous({ keepLobby }); } catch { /* it swallows its own steps; this is belt and braces */ }
  }

  let done = false;
  const once = (opts) => {
    if (done) return;
    done = true;
    // `release` last and as a group: the listeners come down before the lobby
    // they were listening on, and `Lobby.leave()` — which calls this with no
    // argument at all — always gets the whole list.
    for (const step of (opts && opts.keepLobby ? steps : [...steps, ...release])) {
      try {
        const r = step();
        if (r && typeof r.then === 'function') r.then(undefined, () => {});
      } catch { /* the next step still has to run */ }
    }
  };
  once.holds = holds;
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
export async function hostViaSteam(lobby, { maxMembers = 2, bridgeMs = BRIDGE_TIMEOUT_MS, pollMs = POLL_MS, answerMs = ANSWER_WAIT_MS } = {}) {
  // Synchronous, before the first `await`: see `beginSteamOp`. Nothing below
  // this line can begin while another Steam operation on this Lobby is still
  // undecided, which is what makes "decide, then release" true on every path
  // rather than only on the ones `lobby.mode` can see.
  const endOp = beginSteamOp(lobby, 'host');
  try {
    return await hostViaSteamBody(lobby, maxMembers, endOp, bridgeMs, pollMs, answerMs);
  } finally {
    endOp();
  }
}

async function hostViaSteamBody(lobby, maxMembers, endOp, bridgeMs, pollMs, answerMs) {
  const b = await requireSteam(bridgeMs);

  // Checked before a lobby is opened, not after it is advertised. A shell whose
  // bridge predates the member-data answer leg can host a lobby a friend can
  // join and can never hear their answer, which is the advertised-but-deaf
  // state this module refuses on every other path too. One sentence, up front.
  if (typeof b.collectMemberData !== 'function')
    throw new Error('Steam lobby: this build cannot hear a joiner answer. Use a room code or an invite code instead.');

  // FIX ROUND 2 (re-review, the host-then-accept-invite finding's mirror
  // case). Checked before anything below touches the bridge — no new Steam
  // lobby is created, no latch runs — so a player who is already a CLIENT of
  // someone else's game (accepted a Steam invite, or joined by room code)
  // cannot have that session's Steam membership released by a "Host via
  // Steam" press that was always going to fail. `mode === 'host'` is
  // deliberately still allowed through — unchanged by fix round 3 — because
  // that is the double-host / re-host case Important 2 fixed, and
  // `Lobby.createInvite()` itself reuses the existing `NetHost` rather than
  // starting a second one when already hosting. What round 3 changed is what
  // that press then does to the Steam lobby: see "RE-ADVERTISE, NOT RE-OPEN"
  // below.
  if (lobby && lobby.mode === 'client')
    throw new Error("Steam lobby: you're already in a game. Leave it first, then host your own.");

  // RE-ADVERTISE, NOT RE-OPEN (fix round 3). Pressing "Host via Steam" while
  // already hosting through Steam used to open a second Steam lobby and drop the
  // first. That silently stranded any friend who had joined the first lobby and
  // was mid-handshake: the main process gates every incoming P2P packet on
  // membership of whichever lobby it is currently listening to
  // (`desktop/main.mjs`, `isLobbyMember(signalListen.lobby, ...)`), so once the
  // listener rebinds to the new lobby the friend's answer — which the host's own
  // `pendingInvites` would still have matched — is dropped without a word to
  // either player. It also invalidated the friends-list entry the friend was
  // holding. Reusing the lobby is what "re-advertise my running game" actually
  // means: same lobby, same membership, a freshly minted offer written over the
  // old one. A `mode === 'host'` session with no Steam lobby of its own (hosted
  // by room code or invite code) falls through and opens one, as before.
  const reusing = !!(lobby && lobby.mode === 'host'
    && typeof lobby._steamLobbyId === 'string' && lobby._steamLobbyId);

  let lobbyId;
  if (reusing) {
    lobbyId = lobby._steamLobbyId;
  } else {
    ({ lobbyId } = unwrap(await withTimeout(b.hostLobby(maxMembers), 'Steam lobby', bridgeMs), 'Steam lobby'));
    if (typeof lobbyId !== 'string' || !lobbyId) throw new Error('Steam lobby: no lobby id came back.');
  }

  // HOLD THE OLD SESSION'S LISTENERS UNTIL THEIR REPLACEMENTS EXIST (fix round 4).
  //
  // On a re-advertise the running session's latch is parked on this same Lobby
  // holding this same lobby id, and its steps ARE that session's `onSignal` and
  // `onSignalFail` subscriptions. Round 3 let `armCleanup` run it here, at the top
  // of the attempt, so those subscriptions came down before `createInvite()` — an
  // ICE gather capped at 4 s — and their replacements were not registered until
  // after `writeLobbyData` and `startSignalListen`. On the success path that is
  // seconds in which an answer arriving is dropped on the floor (`preload.cjs`
  // does not buffer). On the failure path there is no replacement at all: the
  // catch keeps the lobby, `stopSignalListen` sits in the skipped `release` group,
  // and the session is left open, still listed in the friends list, still offering
  // an offer a friend can read and answer, and structurally unable to hear that
  // answer. Advertised-but-deaf is worse than not advertising.
  //
  // So the previous latch is lifted off the slot here — synchronously, in the
  // same turn `reusing` was decided, with no await in between — held in this
  // closure, and run only by `handOver()` once the new listen and both new
  // subscriptions are live. If the attempt fails first it goes straight back onto
  // the slot, and the running session is exactly as it was found: session, Steam
  // lobby AND listeners.
  let inherited = null;
  if (reusing && lobby && typeof lobby._steamCleanup === 'function'
    && lobby._steamCleanup.holds === lobbyId) {
    inherited = lobby._steamCleanup;
    lobby._steamCleanup = null;
  }
  // Always `{ keepLobby: true }`: the inherited latch holds the very lobby this
  // operation is taking over, so it runs its listener teardown and never its
  // release group — freeing that lobby is this operation's duty now.
  const handOver = () => { const prev = inherited; inherited = null; prev?.({ keepLobby: true }); };

  // Armed before anything else can fail, so every path below leaves nothing
  // behind: an abandoned Steam lobby is invisible to the player who abandoned it.
  let offSignal = null;
  let offFail = null;
  const release = [
    () => b.leaveLobby?.(lobbyId),
    () => { if (lobby && lobby._steamLobbyId === lobbyId) lobby._steamLobbyId = null; },
  ];
  const cleanup = armCleanup(lobby, [
    () => endOp(),
    // A `Lobby.leave()` landing before the hand-over still has to take the old
    // session's subscriptions down: this operation picked them up off the slot,
    // so nobody else can reach them any more.
    () => handOver(),
    () => offSignal?.(),
    () => offFail?.(),
  ], { holds: lobbyId, release });
  if (lobby) lobby._steamLobbyId = lobbyId;

  try {
    const invite = await lobby.createInvite();
    // One name per ATTEMPT, minted here rather than per lobby: a re-advertise
    // reuses the lobby and it is the offer, not the lobby, that the answer is
    // an answer to.
    const nonce = mintNonce();
    const pairs = offerPairs(invite.blob, nonce);
    // Measured before the write, not discovered by it. A `mergeFullData` Steam
    // refuses does not refuse cleanly: it stores entries until it hits the wall,
    // so `sdp.offer.n` can land without the chunks it counts and a joiner then
    // spends its whole 60 s poll waiting for a part that is never coming. Asking
    // first is the only way that state is never reached.
    const bytes = recordBytes(pairs);
    if (bytes > MAX_LOBBY_TOTAL_BYTES || countParts(pairs) > MAX_PARTS)
      throw new Error(
        `Steam lobby: this invite needs ${bytes} bytes and a Steam lobby holds ${MAX_LOBBY_TOTAL_BYTES} in total, `
        + 'so it cannot be posted. That usually means your network is offering an unusual number of connection routes — '
        + 'use a room code or an invite code instead.');
    unwrap(await b.writeLobbyData(lobbyId, Object.fromEntries(pairs)), 'Steam lobby');

    // THE ANSWER POLL, started before the room is advertised.
    //
    // Same rule the P2P listener it replaces obeyed, and for the same reason:
    // an advertised lobby that cannot hear an answer is worse than one that was
    // never advertised. `offSignal` keeps its name and its slot in the latch —
    // every teardown path in this function already spends it — but what it now
    // holds is this poll's stop function rather than a subscription.
    let polling = true;
    offSignal = () => { polling = false; };
    (async () => {
      const deadline = Date.now() + answerMs;
      while (polling && Date.now() < deadline) {
        await idleSleep(pollMs);
        if (!polling) return;
        let members = null;
        try {
          const res = await b.collectMemberData(lobbyId, answerKeys());
          // A refusal is not fatal to the poll: Steam can be briefly unhappy and
          // the friend has minutes left to answer. A THROW is not fatal either.
          members = res && !res.error ? res.members : null;
        } catch { members = null; }

        const hit = pickMemberAnswer(members, nonce);
        if (!hit) continue;
        // One answer is the whole exchange for two seats. Stop polling first, so
        // a second tick cannot start a second `acceptAnswer` while this one is
        // still awaiting.
        polling = false;
        offSignal = null;
        try {
          await lobby.acceptAnswer(hit.answer);
        } catch {
          // `acceptAnswer` already set `peerFailed` with the reason; there is no
          // caller left to throw at — this is a background poll.
        }
        return;
      }
    })();

    offFail = null;

    lobby._set?.('roomOpen', { code: lobbyId, steam: true });
    // Last, after every statement that can throw. The replacement listen and both
    // replacement subscriptions are live, and nothing above has awaited since
    // `startSignalListen` returned, so the old subscriptions come down in the same
    // synchronous turn the new ones went up: no packet can fall between them, and
    // none can arrive twice.
    handOver();
    return { lobbyId };
  } catch (err) {
    // NOTHING HERE MAY TOUCH THE LATCH SLOT UNLESS IT IS STILL OURS (fix round 4).
    //
    // `endOp` is a teardown step, so a `Lobby.leave()` frees the in-flight claim
    // the instant it is pressed while this operation is still parked in an await
    // — `createInvite`'s ICE gather alone runs up to 4 s. The next gesture the
    // player makes is therefore accepted, arms its own latch, and this stale catch
    // then arrives to find a slot it does not own. Running that latch (round 3 ran
    // it through `armCleanup`) releases a Steam lobby whose operation has not
    // finished deciding — the round-2 defect with the direction of time reversed.
    // Blanking it (round 2's line, inherited unchanged) orphans that lobby and
    // turns the player's next Leave into a no-op, so the abandoned operation runs
    // on and can drop them into a game they said no to.
    //
    // `cleanup` itself is always safe to call: it is `once`, so if the slot has
    // moved on it has already run and this is a no-op.
    const ours = !!(lobby && lobby._steamCleanup === cleanup);
    // Reclaim the inherited latch before our own teardown can spend it — on a
    // failure the old session keeps its listeners, so the hand-over must not fire.
    const previous = inherited;
    inherited = null;
    // A failed re-advertise must not cost the player the session it was
    // re-advertising: the lobby it reused is the one still carrying the running
    // game, so the lobby itself stays open.
    cleanup({ keepLobby: reusing });
    if (ours) {
      lobby._steamCleanup = null;
      // Put the running session back exactly as it was found: this is the latch
      // that still owns its listeners and still frees its lobby.
      if (previous) lobby._steamCleanup = previous;
      // Reusing with no inherited latch — a `leave()` took it, or this session
      // never armed one. The lobby is kept, so something must still be able to
      // free it or Important 2's orphan comes back through the failure path. The
      // slot is null above, so this arms over nothing and runs nothing.
      else if (reusing) armCleanup(lobby, [], { holds: lobbyId, release });
    }
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
export async function joinViaSteam(lobby, lobbyId, { pollMs = POLL_MS, waitMs = OFFER_WAIT_MS, bridgeMs = BRIDGE_TIMEOUT_MS } = {}) {
  // Synchronous, before the first `await`: see `beginSteamOp`. The poll loop
  // below can run for a minute with `lobby.mode` still reading `'single'`, and
  // this latch is the only thing that is true for the whole of it.
  const endOp = beginSteamOp(lobby, 'join');
  try {
    return await joinViaSteamBody(lobby, lobbyId, pollMs, waitMs, endOp, bridgeMs);
  } finally {
    endOp();
  }
}

async function joinViaSteamBody(lobby, lobbyId, pollMs, waitMs, endOp, bridgeMs) {
  const b = await requireSteam(bridgeMs);
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

  unwrap(await withTimeout(b.joinLobby(id), 'Steam lobby', bridgeMs), 'Steam lobby');

  let abandoned = false;
  const cleanup = armCleanup(lobby, [
    // Read by the poll loop below: a player who pressed Leave while waiting for
    // the host's offer must stop the timer, not merely be ignored by it. First
    // in the list, and set synchronously, so it lands before anything else can
    // throw its way past it.
    () => { abandoned = true; },
    // And the in-flight latch goes with it, at once rather than a poll tick
    // later, so a teardown never leaves the Lobby looking busy to the next
    // gesture the player makes.
    () => endOp(),
  ], { holds: id, release: [() => b.leaveLobby?.(id)] });

  try {
    const deadline = Date.now() + waitMs;
    let offer = null;
    let offerNonce = null;
    for (;;) {
      if (abandoned) throw new Error('Steam lobby: left before the host posted an invite.');
      const { data } = unwrap(await b.getFullLobbyData(id), 'Steam lobby');
      const record = data && typeof data === 'object' ? data : {};
      const read = (k) => (Object.prototype.hasOwnProperty.call(record, k) ? record[k] : null);
      offer = assembleBlob(read, OFFER_PREFIX);
      // Taken from the SAME snapshot as the offer, deliberately: the echo has
      // to name the offer this joiner actually read, and a second `getFullLobbyData`
      // could straddle a re-advertise and pair a new nonce with an old blob.
      if (offer !== null) offerNonce = typeof read(OFFER_NONCE_KEY) === 'string' ? read(OFFER_NONCE_KEY) : null;
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
    if (typeof b.writeMemberData !== 'function')
      throw new Error('Steam lobby: this build cannot send a joiner answer. Use a room code or an invite code instead.');

    // The same chunking and the same budget guard as the offer, on the same
    // reasoning: a member-data write Steam refuses part-way through leaves
    // `sdp.answer.n` counting parts that are not there, and the host then burns
    // its whole poll on them. In practice an answer is one chunk — a real SDP
    // answer measures ~918 chars against a 2000-char chunk — so this refuses
    // only a blob that could not have travelled the other leg either.
    // A host that stamped no nonce is a host running an older build of this
    // module. Echoing an empty string rather than refusing keeps this joiner
    // usable against one — `pickMemberAnswer` on that side is not checking.
    const pairs = answerPairs(answer, offerNonce);
    const bytes = recordBytes(pairs);
    if (bytes > MAX_LOBBY_TOTAL_BYTES || countParts(pairs) > MAX_PARTS)
      throw new Error(
        `Steam lobby: this answer needs ${bytes} bytes and a Steam lobby holds ${MAX_LOBBY_TOTAL_BYTES} in total, `
        + 'so it cannot be posted. That usually means your network is offering an unusual number of connection routes — '
        + 'use a room code or an invite code instead.');
    unwrap(await b.writeMemberData(id, Object.fromEntries(pairs)), 'Steam lobby');

    // Deliberately still in the Steam lobby, and now for a stronger reason than
    // before: the answer IS the membership. Member data lives on the membership
    // that wrote it, so leaving does not race a packet — it deletes the answer
    // outright, before the host's poll has read it. The lobby is released on
    // `Lobby.leave()` like the host's.
  } catch (err) {
    cleanup();
    // Only ever clear a slot this operation still owns — the same rule, and the
    // same reasons, as `hostViaSteamBody`'s catch. A join abandoned by
    // `Lobby.leave()` settles up to a poll tick (1 s) later, and the invite the
    // player accepted instead has already armed its own latch by then. Blanking it
    // orphaned that Steam lobby for the life of the page AND made the player's
    // next Leave a no-op, so the new join's poll loop ran on and dropped them into
    // a game they had just declined.
    if (lobby && lobby._steamCleanup === cleanup) lobby._steamCleanup = null;
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

/**
 * The picker's list: this player's Steam friends, ready to render.
 *
 * Rows arrive already sanitised by the main process; what is added here is the
 * ordering the picker wants and nothing else — friends already in this game
 * first, then everyone else online, then the offline, each group by name. A
 * player looking for someone to invite is looking at the top of that list.
 *
 * Throws with a sentence when there is no bridge or Steam refuses, so the
 * caller has something to say; an empty friends list is NOT an error, it is an
 * empty array and a picker that says so.
 */
export async function listSteamFriends() {
  const b = bridge();
  if (!b || typeof b.listFriends !== 'function') throw new Error('This build has no Steam friends list.');
  const res = unwrap(await b.listFriends(), 'Steam friends');
  const friends = Array.isArray(res.friends) ? res.friends : [];
  const rank = (f) => (f.inGame ? 0 : f.personaState === 0 ? 2 : 1);
  return friends.slice().sort((a, b2) =>
    rank(a) - rank(b2) || String(a.personaName).localeCompare(String(b2.personaName)));
}

/**
 * Invite one friend to the lobby this session hosts. The overlay-less send
 * side: Steam delivers a notification, and their accept comes back to us as
 * either callback 333 (game running) or `+connect_lobby` (game closed).
 */
export async function inviteSteamFriend(lobbyId, steamId) {
  const b = bridge();
  if (!b || typeof b.inviteFriend !== 'function') throw new Error('This build cannot send Steam invites.');
  return unwrap(await b.inviteFriend(String(lobbyId ?? ''), String(steamId ?? '')), 'Steam invite');
}

/**
 * The invite this player accepted before the game was running, if there is one.
 *
 * Answers null in a browser, on a shell without the channel, and on the second
 * ask — main hands it over exactly once. Never throws: a start-up path that can
 * fail the boot for want of an invite is worse than the missed invite.
 */
export async function pendingSteamJoin() {
  const b = bridge();
  if (!b || typeof b.pendingJoin !== 'function') return null;
  try {
    const res = await b.pendingJoin();
    const lobbyId = typeof res?.lobbyId === 'string' ? res.lobbyId : '';
    return /^\d+$/.test(lobbyId) ? lobbyId : null;
  } catch { return null; }
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
