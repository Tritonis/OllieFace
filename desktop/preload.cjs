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

// A structural ceiling, tighter than Node's default warning of ten. (Minor
// 4.) `ipcRenderer` is one EventEmitter and Node counts listeners per channel
// name, so a bug that stops unsubscribing a Steam push channel used to climb
// silently toward that default before anything said so. Four live subscribers
// is already generous for this bridge -- `onJoinRequested` and the save-status
// listener are one permanent listener each for the page's life, and
// `onSignal`/`onSignalFail` are at most one live pair at a time now that a
// second "Host via Steam" runs the previous latch before arming a new one --
// so six is a ceiling a working build can never approach and a regression
// trips loudly, well short of Node's own default.
ipcRenderer.setMaxListeners(6);

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
});

contextBridge.exposeInMainWorld('__STEAM__', {
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

  // One reliable Steam P2P packet to the lobby owner: the joiner's answer leg,
  // which lobby data cannot carry (setData is owner-only in Steam).
  // -> { ok: true } | { error: string }
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
