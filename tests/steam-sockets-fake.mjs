/**
 * A fake `ISteamNetworkingSockets`, faithful to the semantics
 * `src/net/SteamTransport.js` actually leans on.
 *
 * Not a mock of the whole interface: it implements the members the transport
 * calls, with the behaviours the transport's correctness depends on, and
 * nothing else. Those behaviours, and why each is here:
 *
 *   - **Message granularity.** `sendMessage` queues one message and
 *     `receiveMessages` returns whole messages. A stream fake would let a
 *     transport that forgot to frame its channel byte pass.
 *   - **Per-message reliability on one connection.** The flag rides the
 *     message, exactly as Steam's does; loss is only ever applied to
 *     unreliable messages, because a fake able to drop a reliable one would be
 *     testing a transport we do not ship.
 *   - **Pull-based state changes and connection requests.**
 *     `getPendingStateChanges` / `getPendingConnectionRequests` drain a queue
 *     per identity, which is the Binding's own pull surface — the transport
 *     never drives `SteamAPI_RunCallbacks`, so neither does this.
 *   - **`pendingReliable` / `sentUnackedReliable`.** Real numbers on a real
 *     connection, so `SteamPeer.drained()` is exercised rather than asserted.
 *   - **Close signalling.** Closing one end queues a `ClosedByPeer` state
 *     change on the other, which is how a leave reaches `onPeerLeave` in the
 *     shipping path.
 *
 * Receive-side impairment mirrors `k_ESteamNetworkingConfig_FakePacketLag_Recv`
 * and friends: held at the receiver, released when due, never reordered, and
 * never applied to reliable traffic's *delivery guarantee* — a held reliable
 * message is late, not lost.
 */

const STATE_CONNECTING = 1;
const STATE_CONNECTED = 3;
const STATE_CLOSED_BY_PEER = 4;

const RELIABLE = 8;

/** One shared fake Steam network. Identities get their own sockets object. */
export function makeSteamNet() {
  let nextHandle = 1;
  const conns = new Map();      // handle -> connection record
  const identities = new Map(); // steam id -> { stateChanges, requests, listenSockets }

  const owner = (id) => {
    if (!identities.has(id)) identities.set(id, { stateChanges: [], requests: [], listenSockets: new Set() });
    return identities.get(id);
  };

  function makeConn(localId, remoteId, state) {
    const h = nextHandle++;
    const rec = {
      handle: h,
      localId,
      remoteId,
      state,
      far: null,
      inbox: [],            // { bytes, reliable, due }
      pendingReliable: 0,
      sentUnackedReliable: 0,
      // Receive-side impairment, armed by `impair()` below.
      sim: null,
      clock: null,
      // Set for one `receiveMessages` pass by the conformance adapter to state
      // which unreliable messages this pass loses. Indexed among unreliable
      // messages in the pass, so a failure is reproducible.
      lose: null,
    };
    conns.set(h, rec);
    return rec;
  }

  /** Bring up a connected pair directly, skipping the rendezvous. */
  function connectPair(aId, bId) {
    const a = makeConn(aId, bId, STATE_CONNECTED);
    const b = makeConn(bId, aId, STATE_CONNECTED);
    a.far = b; b.far = a;
    return [a.handle, b.handle];
  }

  /** Arm receive-side impairment on one connection. `clock` returns seconds. */
  function impair(handle, sim, clock) {
    const rec = conns.get(handle);
    rec.sim = sim;
    rec.clock = clock;
  }

  function closeRecord(rec, notifyFar) {
    if (rec.state === STATE_CLOSED_BY_PEER) return;
    rec.state = STATE_CLOSED_BY_PEER;
    const far = rec.far;
    if (notifyFar && far && far.state !== STATE_CLOSED_BY_PEER) {
      far.state = STATE_CLOSED_BY_PEER;
      owner(far.localId).stateChanges.push({
        connection: far.handle,
        oldState: STATE_CONNECTED,
        newState: STATE_CLOSED_BY_PEER,
        info: { identityRemote: far.remoteId, state: STATE_CLOSED_BY_PEER },
      });
    }
  }

  /** The sockets object one Steam identity sees. */
  function forIdentity(steamId) {
    const me = owner(steamId);
    return {
      getIdentity: () => steamId,

      createListenSocketP2P(virtualPort = 0) {
        const h = nextHandle++;
        me.listenSockets.add(h);
        void virtualPort;
        return h;
      },
      closeListenSocket(h) { return me.listenSockets.delete(h); },

      connectP2P(remoteSteamId, virtualPort = 0) {
        void virtualPort;
        const remote = String(remoteSteamId);
        const mine = makeConn(steamId, remote, STATE_CONNECTING);
        const theirs = makeConn(remote, steamId, STATE_CONNECTING);
        mine.far = theirs; theirs.far = mine;
        const them = owner(remote);
        const listen = [...them.listenSockets][0] ?? 0;
        them.requests.push({ connection: theirs.handle, identityRemote: steamId, listenSocket: listen });
        return mine.handle;
      },

      acceptConnection(handle) {
        const rec = conns.get(handle);
        if (!rec) return 2;
        rec.state = STATE_CONNECTED;
        rec.far.state = STATE_CONNECTED;
        // Both ends learn they are up, which is what the real interface does.
        for (const end of [rec, rec.far]) {
          owner(end.localId).stateChanges.push({
            connection: end.handle,
            oldState: STATE_CONNECTING,
            newState: STATE_CONNECTED,
            info: { identityRemote: end.remoteId, state: STATE_CONNECTED },
          });
        }
        return 1; // EResult.OK
      },

      closeConnection(handle, reason = 0, debug = '', linger = false) {
        void reason; void debug; void linger;
        const rec = conns.get(handle);
        if (!rec) return false;
        closeRecord(rec, true);
        return true;
      },

      sendMessage(handle, data, sendFlags = 0) {
        const rec = conns.get(handle);
        if (!rec || rec.state !== STATE_CONNECTED) return { success: false, messageNumber: 0n };
        const far = rec.far;
        const reliable = (sendFlags & RELIABLE) !== 0;
        const bytes = Uint8Array.from(
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length),
        );
        if (!far || far.state !== STATE_CONNECTED) return { success: false, messageNumber: 0n };
        const sim = far.sim;
        if (sim && !reliable && sim.lossPct > 0 && Math.random() * 100 < sim.lossPct) {
          return { success: true, messageNumber: 1n };
        }
        const delay = sim ? (sim.lagMs + (sim.jitterMs ? Math.random() * sim.jitterMs : 0)) / 1000 : 0;
        far.inbox.push({ bytes, reliable, due: delay > 0 ? far.clock() + delay : -Infinity });
        return { success: true, messageNumber: 1n };
      },
      sendReliable(handle, data) { return this.sendMessage(handle, data, RELIABLE); },
      sendUnreliable(handle, data) { return this.sendMessage(handle, data, 0); },

      receiveMessages(handle, maxMessages = 16) {
        const rec = conns.get(handle);
        if (!rec) return [];
        const now = rec.clock ? rec.clock() : Infinity;
        // Strictly in arrival order: stop at the first message not yet due,
        // even if a later one drew a shorter delay. Reordering here would
        // simulate a network Steam does not give us.
        let n = 0;
        while (n < rec.inbox.length && n < maxMessages && rec.inbox[n].due <= now) n++;
        if (n === 0) return [];
        const due = rec.inbox.splice(0, n);
        const out = [];
        let unreliableSeen = 0;
        for (const m of due) {
          if (!m.reliable) {
            const i = unreliableSeen++;
            if (rec.lose && rec.lose(i)) continue;
          }
          out.push({
            data: m.bytes,
            size: m.bytes.length,
            connection: handle,
            identityPeer: rec.remoteId,
            channel: 0,
            flags: m.reliable ? RELIABLE : 0,
          });
        }
        return out;
      },

      getConnectionRealTimeStatus(handle) {
        const rec = conns.get(handle);
        if (!rec) return null;
        return {
          state: rec.state,
          ping: 0,
          pendingReliable: rec.pendingReliable,
          pendingUnreliable: 0,
          sentUnackedReliable: rec.sentUnackedReliable,
          sendRateBytesPerSecond: 0,
          outPacketsPerSec: 0, outBytesPerSec: 0, inPacketsPerSec: 0, inBytesPerSec: 0,
          connectionQualityLocal: 1, connectionQualityRemote: 1,
          usecQueueTime: 0n,
        };
      },

      getConnectionInfo(handle) {
        const rec = conns.get(handle);
        return rec ? { state: rec.state, identityRemote: rec.remoteId } : null;
      },

      getPendingStateChanges() { return me.stateChanges.splice(0, me.stateChanges.length); },
      getPendingConnectionRequests() { return me.requests.splice(0, me.requests.length); },
      isConnectionActive(handle) { return conns.get(handle)?.state === STATE_CONNECTED; },
    };
  }

  return {
    forIdentity,
    connectPair,
    impair,
    conn: (handle) => conns.get(handle),
    /** Mark a connection closed *without* telling the far end, as a peer that vanished would. */
    killQuietly: (handle) => { const r = conns.get(handle); if (r) r.state = STATE_CLOSED_BY_PEER; },
  };
}
