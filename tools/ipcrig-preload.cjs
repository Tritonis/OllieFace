/**
 * The measurement rig's preload: shape (a) of issue #128, in the smallest form
 * that can be measured honestly.
 *
 * It is deliberately the *same* shape `desktop/preload.cjs` would have to
 * publish for `window.__STEAM__.net` — one outbound IPC per frame carrying
 * every message the frame produced, one inbound push per main-process tick
 * carrying every message that arrived, and a synchronous drain out of a
 * renderer-side buffer so `SteamTransport.receiveMessages` can stay
 * synchronous. If this rig's added latency misses the envelope, so does the
 * bridge; if it makes it, the bridge is that plus bookkeeping.
 */
const { contextBridge, ipcRenderer } = require('electron');

const inbox = new Map();   // conn -> array of Uint8Array
let outbox = [];

ipcRenderer.on('rig:recv', (_event, batch) => {
  // Stamped here, in the IPC event itself: the arrival figure has to be the
  // moment the byte reached the renderer process, not the moment the game's
  // frame hook got round to asking for it. The second is measured too, in the
  // page, and the two differ by the frame quantisation.
  const at = performance.now();
  for (const m of batch) {
    let q = inbox.get(m.conn);
    if (!q) { q = []; inbox.set(m.conn, q); }
    q.push({ data: m.data, at });
  }
});

contextBridge.exposeInMainWorld('__RIG__', {
  send: (conn, data, flags) => { outbox.push({ conn, data, flags }); },
  /** One IPC per frame, whatever the frame produced. */
  flush: () => {
    if (outbox.length === 0) return;
    const batch = outbox;
    outbox = [];
    ipcRenderer.send('rig:send', batch);
  },
  /** Synchronous, out of the local buffer -- never an `invoke`. */
  receive: (conn, max) => {
    const q = inbox.get(conn);
    if (!q || q.length === 0) return [];
    return q.splice(0, max);
  },
  report: (record) => ipcRenderer.send('rig:done', record),
});
