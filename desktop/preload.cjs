/**
 * The two bridges the renderer gets.
 *
 * `__DESKTOP__` is storage: synchronous on load (the game hydrates storage
 * before its first system boots), fire-and-forget on save (the main process
 * owns atomicity).
 *
 * `__STEAM__` is the Steam surface, and it is a keyhole on purpose. Every entry
 * is a named `invoke` on a named channel; there is no client object, no module
 * handle, and no generic `send`/`invoke` pass-through, so the renderer cannot
 * reach the native module or any channel this file does not list. Lobby and
 * Steam ids cross as decimal STRINGS in both directions — they are 64-bit and
 * a bigint is a `JSON.stringify` throw waiting to happen on the renderer side.
 * Nothing else crosses: no fs, no ipc pass-through.
 */
const { contextBridge, ipcRenderer } = require('electron');

// NOTHING PROJECT-LOCAL IS REQUIRED HERE, AND NOTHING EVER MAY BE. A preload
// under `contextIsolation: true` with no `sandbox: false` override -- which is
// what `desktop/main.mjs` deliberately builds -- runs inside Electron's
// SANDBOXED loader, whose `require` resolves a short allowlist of built-ins
// (`electron`, `events`, `timers`, `url`) and nothing else. A relative require
// of a file in this very directory throws `module not found` in that loader,
// `const { x } = require(...)` leaves `x` undefined, and the first call to it
// kills the REST OF THIS FILE -- every `exposeInMainWorld` below it included,
// so the page comes up with neither `__DESKTOP__` nor `__STEAM__`. That
// happened (#128, refuted 2026-08-21): it only bites when Steam is present,
// because only then is the crashing branch taken, and it is invisible to every
// suite that wires the halves together in plain node. The Conversation's
// renderer half is therefore INLINE, below.

// A structural ceiling, tighter than Node's default warning of ten. (Minor
// 4.) `ipcRenderer` is one EventEmitter and Node counts listeners per channel
// name, so a bug that stops unsubscribing a Steam push channel used to climb
// silently toward that default before anything said so. Four live subscribers
// is already generous for this bridge -- `onJoinRequested` and the save-status
// listener are one permanent listener each for the page's life, and
// `onSignal`/`onSignalFail` are at most one live pair at a time now that a
// second "Host via Steam" runs the previous latch before arming a new one --
// so six was a ceiling a working build could never approach. Seven now: the
// Conversation's `steam:net-recv` is one more permanent listener for the page's
// life (#128), and it is permanent rather than paired, so the headroom the
// ceiling was protecting is unchanged. A regression still trips loudly, well
// short of Node's own default.
ipcRenderer.setMaxListeners(7);

// Push channels hand the renderer the payload only -- never the IpcRendererEvent,
// which carries `sender` and would be a hole straight back through the bridge.
const subscribe = (channel, cb) => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, payload) => { cb(payload); };
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};

// { ok, raw }: raw is the file text, or null. ok:false means the file exists
// and could not be read -- the renderer must not treat that as a first boot.
const initial = ipcRenderer.sendSync('store:load');   // once, at boot

// The Conversation's bridge (#128), decided once here because
// `TransportSelect.steamSockets()` asks a synchronous question -- "did the
// shell publish one?" -- and a promise is not an answer it can use. On a boot
// with no Steam this is `{ available: false }` and `net` below is null, which
// is exactly the state every runtime has been in until now.
/**
 * The renderer half of the Conversation's Steam bridge (#128, shape (a)).
 *
 * What it publishes is `window.__STEAM__.net`: an object with the same member
 * names `steamworks-ffi-node` gives the main process as
 * `steam.networkingSockets`, so `src/net/SteamTransport.js` is a pass-through
 * onto it and `TransportSelect.js` needs no change at all — the bridge existing
 * is the whole of the condition it already tests.
 *
 * Every member is synchronous, because the transport calls them from inside a
 * frame. That is possible because none of them actually talks to Steam:
 *
 *   - **Commands** (`createListenSocketP2P`, `connectP2P`, `acceptConnection`,
 *     `closeConnection`, `closeListenSocket`, `sendMessage`) go into one
 *     ordered outbox and leave as a single IPC message per frame. A handle is
 *     minted here and reconciled in `desktop/net-bridge-main.mjs`; see that
 *     file on the even/odd parity.
 *   - **Queries** (`receiveMessages`, `getPendingStateChanges`,
 *     `getPendingConnectionRequests`, `getConnectionRealTimeStatus`,
 *     `getIdentity`) are answered from what main last pushed. They are reads of
 *     a mailbox, not calls.
 *
 * The outbox is flushed on a zero-delay timer rather than by anyone calling a
 * `flush`: one game frame is one task, so everything a frame produced leaves in
 * one message and nothing waits for the *next* frame to go out. `flush` is
 * exported anyway, because `tests/net-bridge.test.mjs` drives both halves
 * without a scheduler between them.
 *
 * Order is preserved across the whole outbox, not per kind: a `close` that
 * overtook the `send` before it would turn the host's last reliable REFUSE into
 * a silent drop.
 */

// >>> net-bridge-renderer >>> single source of truth: `desktop/net-bridge-renderer.cjs`
// loads THIS BLOCK out of THIS FILE for the contract tests, so there is exactly
// one copy of it and a test can never pass against a stale twin.
/**
 * @param {object} opts
 * @param {(batch: object[]) => void} opts.post hands one command batch to main.
 * @param {string} opts.identity this player's Steam id, resolved before the
 *   bridge was published — `getIdentity()` is synchronous and has no mailbox.
 * @param {(fn: () => void) => void} [opts.schedule] test seam for the flush timer.
 */
function createNetBridgeRenderer({ post, identity, schedule }) {
  const later = schedule ?? ((fn) => { setTimeout(fn, 0); });

  let outbox = [];
  let flushScheduled = false;
  let nextHandle = 2;           // even: the renderer mints outbound

  const inbox = new Map();      // proxy conn -> array of ArrayBuffer-ish
  const openConns = new Set();  // conns this side believes are live
  const statuses = new Map();   // proxy conn -> last pushed real-time status
  let pendingChanges = [];
  let pendingRequests = [];

  const mint = () => { const h = nextHandle; nextHandle += 2; return h; };

  function flush() {
    flushScheduled = false;
    if (outbox.length === 0) return;
    const batch = outbox;
    outbox = [];
    post(batch);
  }

  function enqueue(cmd) {
    outbox.push(cmd);
    if (flushScheduled) return;
    flushScheduled = true;
    later(flush);
  }

  /** One batch from main. See `net-bridge-main.mjs` on why this order matters. */
  function deliver(payload) {
    if (!payload) return;
    for (const req of payload.requests ?? []) pendingRequests.push(req);
    for (const change of payload.changes ?? []) {
      pendingChanges.push(change);
      // A connection main minted for us becomes ours to close.
      openConns.add(change.connection);
    }
    for (const m of payload.messages ?? []) {
      let q = inbox.get(m.conn);
      if (!q) { q = []; inbox.set(m.conn, q); }
      q.push(m.data);
    }
    for (const s of payload.statuses ?? []) statuses.set(s.conn, s);
  }

  const sockets = {
    getIdentity: () => identity,

    createListenSocketP2P(port = 0) {
      const h = mint();
      enqueue({ op: 'listen', h, port });
      return h;
    },
    closeListenSocket(h) {
      enqueue({ op: 'closeListen', h });
      return true;
    },
    connectP2P(steamId, port = 0) {
      const h = mint();
      openConns.add(h);
      enqueue({ op: 'connect', h, steamId: String(steamId), port });
      return h;
    },
    acceptConnection(h) {
      openConns.add(h);
      enqueue({ op: 'accept', h });
      return true;
    },
    closeConnection(h, reason = 0, debug = '', linger = false) {
      openConns.delete(h);
      inbox.delete(h);
      statuses.delete(h);
      enqueue({ op: 'close', h, reason, debug: String(debug), linger: !!linger });
      return true;
    },
    sendMessage(h, data, flags = 0) {
      const bytes = data instanceof Uint8Array
        ? data
        : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length);
      // A copy, because the caller reuses its `Writer` buffer and this one has
      // a frame to wait before it is read.
      enqueue({ op: 'send', h, data: Uint8Array.from(bytes), flags });
      return { success: true, messageNumber: 0n };
    },

    receiveMessages(h, max = 16) {
      const q = inbox.get(h);
      if (!q || q.length === 0) return [];
      return q.splice(0, max).map((data) => ({ data, size: data.byteLength ?? data.length, connection: h }));
    },
    getPendingStateChanges() {
      const out = pendingChanges;
      pendingChanges = [];
      return out;
    },
    getPendingConnectionRequests() {
      const out = pendingRequests;
      pendingRequests = [];
      return out;
    },
    /**
     * The last status main pushed for this connection.
     *
     * A connection this side opened moments ago has none yet, and the honest
     * answer is not "null" — `SteamPeer.drained()` reads null as *drained*, and
     * a host that believed a brand-new connection had flushed its reliable
     * queue would close the door on the REFUSE it was about to send. So an
     * unanswered-but-open connection reports a byte outstanding until main says
     * otherwise, which errs towards holding the door rather than slamming it.
     */
    getConnectionRealTimeStatus(h) {
      const known = statuses.get(h);
      if (known) return known;
      if (!openConns.has(h)) return null;
      return { state: 3, pendingReliable: 1, pendingUnreliable: 0, sentUnackedReliable: 0 };
    },
  };

  return { sockets, deliver, flush };
}
// <<< net-bridge-renderer <<<

const netInit = ipcRenderer.sendSync('steam:net-init');
const netBridge = netInit && netInit.available
  ? createNetBridgeRenderer({
    post: (batch) => { ipcRenderer.send('steam:net-send', batch); },
    identity: String(netInit.identity),
  })
  : null;
if (netBridge) ipcRenderer.on('steam:net-recv', (_event, payload) => { netBridge.deliver(payload); });

// The last save verdict main has pushed, latched here so it survives the gap
// between it being sent and the renderer subscribing. Without the latch a save
// that fails during the first frames -- exactly when the first-boot migration
// flush runs -- lands on nobody and the player is told nothing.
let lastSaveStatus = null;
ipcRenderer.on('store:save-status', (_event, status) => { lastSaveStatus = status; });

contextBridge.exposeInMainWorld('__DESKTOP__', {
  loadStore: () => initial,
  saveStore: (json) => { ipcRenderer.send('store:save', String(json)); },
  // cb({ ok: boolean, reason: string|null }) -- pushed on every CHANGE of
  // verdict, not on every save. A subscriber is handed the latched verdict
  // immediately if one has already arrived.
  onSaveStatus: (cb) => {
    const off = subscribe('store:save-status', cb);
    if (lastSaveStatus && typeof cb === 'function') cb(lastSaveStatus);
    return off;
  },
  // Start the run over. `location.reload()` is blocked in this shell by the
  // window's `will-navigate` denial (#136), so the reload is asked of main,
  // which is allowed to perform it. Fire-and-forget: nothing comes back
  // because nothing is left to come back to.
  reload: () => { ipcRenderer.send('shell:reload'); },
});

contextBridge.exposeInMainWorld('__STEAM__', {
  // The Conversation, or null. Always present as a KEY, so the surface the
  // desktop probe pins does not change shape between a Steam boot and a
  // Steam-less one; `TransportSelect` reads the VALUE.
  net: netBridge ? netBridge.sockets : null,

  // -> { available, appId, personaName, reason }
  status: () => ipcRenderer.invoke('steam:status'),

  // -> { lobbyId: string } | { error: string }
  hostLobby: (maxMembers) => ipcRenderer.invoke('steam:host-lobby', maxMembers),
  // -> { ok: true, lobbyId: string } | { error: string }
  joinLobby: (lobbyId) => ipcRenderer.invoke('steam:join-lobby', String(lobbyId)),
  // -> { ok: true }   (idempotent; leaving an unheld lobby is not an error)
  leaveLobby: (lobbyId) => ipcRenderer.invoke('steam:leave-lobby', String(lobbyId)),
  // -> { ok: true, overlay: boolean } | { error: string }
  openInviteDialog: (lobbyId) => ipcRenderer.invoke('steam:open-invite', String(lobbyId)),

  // The overlay-less invite path: our own picker, drawn by the page.
  // -> { friends: Array<{ steamId, personaName, personaState, inGame }> } | { error }
  listFriends: () => ipcRenderer.invoke('steam:list-friends'),
  // -> { ok: true } | { error: string }
  inviteFriend: (lobbyId, steamId) =>
    ipcRenderer.invoke('steam:invite-friend', String(lobbyId), String(steamId)),
  // An invite accepted while the game was CLOSED, delivered as launch args and
  // answered exactly once. -> { lobbyId: string|null }
  pendingJoin: () => ipcRenderer.invoke('steam:pending-join'),

  // record: { 'sdp.<key>': '<=7000 chars' } -- main enforces both, batched into
  // one mergeFullData. -> { ok: true } | { error: string }
  writeLobbyData: (lobbyId, record) => ipcRenderer.invoke('steam:write-lobby-data', String(lobbyId), record),
  // -> { data: Record<string,string> } | { error: string }   (one IPC per poll)
  getFullLobbyData: (lobbyId) => ipcRenderer.invoke('steam:get-full-lobby-data', String(lobbyId)),
  // -> { steamId: string } | { error: string }
  getLobbyOwner: (lobbyId) => ipcRenderer.invoke('steam:get-lobby-owner', String(lobbyId)),

  // The answer leg. A member may only ever write its OWN member data, which is
  // Steam's rule and not ours — so the joiner writes and the host reads, and no
  // membership gate is needed on either side.
  // record: same shape and same budget as writeLobbyData.
  // -> { ok: true } | { error: string }
  writeMemberData: (lobbyId, record) =>
    ipcRenderer.invoke('steam:write-member-data', String(lobbyId), record),
  // keys: a bounded list of key names to read off EVERY member, in one IPC per
  // poll tick. -> { members: Record<steamId, Record<string,string>> } | { error }
  collectMemberData: (lobbyId, keys) =>
    ipcRenderer.invoke('steam:collect-member-data', String(lobbyId), keys),

  // VESTIGIAL (2026-08-21). The joiner's answer used to ride one reliable Steam
  // P2P packet, because `steamworks.js@0.4.0` bound no member-data API. The new
  // Binding binds none of `ISteamNetworking`, so these three channels answer
  // `p2p-unavailable` and nothing in `src/` calls them any more. Kept, not
  // deleted, because deleting them is the WebRTC-era sweep (#56) and takes
  // `encodeSignal`/`decodeSignal`/`isAuthorizedSignalTarget` and their tests
  // with it — a change with no behavioural effect and a real coverage cost,
  // which does not belong in the same commit as the leg that replaced them.
  // -> { error: 'p2p-unavailable' }
  sendSignal: (steamId, payload) => ipcRenderer.invoke('steam:send-signal', String(steamId), payload),
  // -> { ok: true } | { error: string }
  startSignalListen: (lobbyId) => ipcRenderer.invoke('steam:start-signal-listen', String(lobbyId)),
  // -> { ok: true }
  stopSignalListen: () => ipcRenderer.invoke('steam:stop-signal-listen'),

  // cb({ lobbyId: string }) -- a friend clicked "Join game" in the Steam client.
  onJoinRequested: (cb) => subscribe('steam:join-requested', cb),
  // cb({ fromSteamId: string, payload: string }) -- validated and capped in main.
  onSignal: (cb) => subscribe('steam:signal', cb),
  // cb({ fromSteamId: string|null, error: number|null })
  onSignalFail: (cb) => subscribe('steam:signal-fail', cb),
});
