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

module.exports = { createNetBridgeRenderer };
