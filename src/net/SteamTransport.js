/**
 * The Steam-backed Conversation: `ISteamNetworkingSockets` behind the transport
 * seam enumerated in `docs/STEAM.md` section 8.5.
 *
 * Nothing above this file changes. `NetHost` and `NetClient` take a transport
 * as a parameter, and a `SteamPeer` carries exactly the eight members section
 * 8.5 lists — so the same `tests/transport-contract.mjs` assertions that run
 * against WebRTC run against this, and no gameplay code is touched.
 *
 * ## Two channels, one connection
 *
 * `docs/STEAM.md` section 3 describes channel 0 unreliable for snapshots and
 * channel 1 reliable for events, and reaches that shape through
 * `ISteamNetworkingMessages`, which has per-message channels. This transport
 * rides `ISteamNetworkingSockets` instead — the plan's step 5 names it — and
 * that interface has **no send-side channel argument**: `sendMessage(conn,
 * data, flags)` is the whole surface, and the `channel` field on a received
 * `NetworkMessage` is a lane number the send side cannot set through this
 * Binding. So the channel is carried where it can be: one leading byte,
 * `CH.state` or `CH.events`, in front of the payload. Reliability stays where
 * Steam puts it — a per-message flag on the same connection — which is the half
 * of section 3's claim that survives contact with the interface.
 *
 * That framing costs one byte per message and buys message granularity: Steam
 * delivers whole messages, so the receiver never has to re-frame a stream.
 *
 * ## What `pumpSim()` does here, and why it is not a no-op
 *
 * On the WebRTC peer `pumpSim()` drains the `?netlag=` rig and is meaningless
 * on a Steam connection. But `NetHost.js:532` calls it unconditionally every
 * frame, and a Steam connection *does* need a per-frame call: received messages
 * sit in Steam's queue until something calls `receiveMessages`. So this
 * transport spends the frame hook it is given on the receive pump. It is
 * idempotent — the queue is drained, so a second call in the same frame gets
 * nothing — which matters because the host calls it once per peer.
 *
 * ## The identity the Introduction hands over
 *
 * The Introduction is out of the portable contract on purpose (ADR 0002), and
 * the lobby/member-data courier built for the WebRTC era is not changed here.
 * It carries opaque base64 blobs of the shape `{ v, role, id, ... }`; the WebRTC
 * transport fills them with SDP, and this one fills them with a Steam id. So
 * `Lobby.createInvite` / `joinManual` / `acceptAnswer` and every line of
 * `SteamLobby.js` work unaltered, and the rendezvous stops being a negotiation
 * and becomes an address book — which is what Steam's own route-finding wants.
 *
 * ## Where the sockets object comes from
 *
 * Injected, never imported. In the main process it is
 * `steam.networkingSockets` from `steamworks-ffi-node`; in tests it is
 * `tests/steam-sockets-fake.mjs`; in the renderer it must be an IPC bridge that
 * **does not exist yet** — see `docs/STEAM.md` section 8.5, "as built". This
 * file deliberately knows nothing about which it has.
 *
 * State changes and inbound connection requests are read with the Binding's
 * *pull* accessors (`getPendingStateChanges`, `getPendingConnectionRequests`)
 * rather than its callback registrars, so the transport never drives
 * `SteamAPI_RunCallbacks` itself and therefore never needs the counted dispatch
 * hold `desktop/main.mjs` keeps around the Binding's async methods.
 */

/** The channel byte. Not Steam's lane number — see the header. */
export const CH = { state: 0, events: 1 };
const LABEL = ['state', 'events'];

/** `k_nSteamNetworkingSend_*`, inlined so this module imports no Binding. */
export const SEND_UNRELIABLE = 0;
export const SEND_RELIABLE = 8;

/** `ESteamNetworkingConnectionState`. Only the three we branch on. */
const STATE_CONNECTED = 3;
const STATE_CLOSED_BY_PEER = 4;
const STATE_PROBLEM_LOCALLY = 5;

/** How long the host waits for an accepted joiner's connection to come up. */
const CONNECT_TIMEOUT_MS = 20000;

const encode = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '');
const decode = (s) => JSON.parse(atob(s));

/** Prefix `bytes` with its channel byte, as whatever the sockets layer takes. */
function frame(channel, bytes) {
  const src = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint8Array(src.length + 1);
  out[0] = channel;
  out.set(src, 1);
  // `Buffer` is a `Uint8Array`, and the Binding declares `Buffer | string`, so
  // hand it one where the runtime has it and the plain view where it does not.
  return globalThis.Buffer ? globalThis.Buffer.from(out.buffer, 0, out.length) : out;
}

/** Strip the channel byte. Returns `[label, ArrayBuffer]`, or null if unknown. */
function unframe(data) {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (view.length < 1) return null;
  const label = LABEL[view[0]];
  if (!label) return null;
  // Copy: the Binding frees the message's native buffer after `receiveMessages`
  // returns, and `Reader` holds whatever it is given for as long as the game
  // wants it.
  return [label, view.slice(1).buffer];
}

/**
 * One connected remote endpoint over a Steam connection.
 *
 * Carries exactly `docs/STEAM.md` section 8.5's peer surface — `id`,
 * `sendState`, `sendEvent`, `onMessage`, `onClose`, `pumpSim`, `close`,
 * `drained` — and nothing the game reaches for that Steam cannot answer.
 */
export class SteamPeer {
  constructor(sockets, connection, id) {
    this.sockets = sockets;
    this.conn = connection;
    this.id = id;
    this.onMessage = null;
    this.onClose = null;
    this.rtt = 0;
    this.closed = false;
  }

  /** Snapshots and input: unreliable, dropped rather than queued by Steam. */
  sendState(bytes) {
    if (this.conn == null || this.closed) return;
    this.sockets.sendMessage(this.conn, frame(CH.state, bytes), SEND_UNRELIABLE);
  }

  /** One-shot facts: reliable and ordered, on the same connection. */
  sendEvent(bytes) {
    if (this.conn == null || this.closed) return;
    this.sockets.sendMessage(this.conn, frame(CH.events, bytes), SEND_RELIABLE);
  }

  /**
   * Drain Steam's receive queue for this connection. See the module header for
   * why the frame hook named `pumpSim` is where this lives.
   */
  pumpSim() {
    if (this.conn == null || this.closed) return;
    let msgs;
    try {
      msgs = this.sockets.receiveMessages(this.conn, 64);
    } catch {
      return;
    }
    if (!msgs || msgs.length === 0) return;
    for (const m of msgs) {
      const framed = unframe(m.data);
      // A message on neither channel is a peer speaking a protocol we do not
      // have. Dropping it is the same choice `Protocol` makes for an unknown
      // message id, and louder handling here would be a log line per frame.
      if (!framed) continue;
      this.onMessage?.(framed[1], framed[0], this);
    }
  }

  /**
   * True once the reliable half has nothing left to deliver — the Steam reading
   * of `drained()`: no connection, or a connection with no reliable bytes
   * pending and none sent-but-unacknowledged.
   *
   * `pendingUnreliable` is deliberately not counted. The predicate exists so
   * `NetHost._closeWhenFlushed` can know a REFUSE arrived, and a REFUSE is a
   * reliable message; waiting on unreliable bytes would hold the door for a
   * snapshot nobody will miss.
   */
  drained() {
    if (this.conn == null || this.closed) return true;
    let status = null;
    try {
      status = this.sockets.getConnectionRealTimeStatus(this.conn);
    } catch {
      return true;
    }
    if (!status) return true;
    if (status.state !== STATE_CONNECTED) return true;
    return (status.pendingReliable | 0) === 0 && (status.sentUnackedReliable | 0) === 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const conn = this.conn;
    this.conn = null;
    // `enableLinger` true: the last thing the host sends a refused peer is a
    // reliable REFUSE, and a close that discarded it would make every refusal
    // look like a silent drop to the player on the other end.
    if (conn != null) { try { this.sockets.closeConnection(conn, 0, 'closed', true); } catch {} }
    this.onClose?.(this);
  }
}

/**
 * The host half. `peers`, `onPeer`, `onPeerLeave`, `broadcastEvent`, `close` are
 * the contract; `createInvite` / `cancelInvite` are rendezvous and outside it.
 */
export class SteamHostTransport {
  constructor({ sockets, virtualPort = 0 } = {}) {
    this.sockets = sockets;
    this.virtualPort = virtualPort;
    this.peers = new Map();
    this.onPeer = null;
    this.onPeerLeave = null;
    this.listenSocket = null;
    this._nextId = 1;
    this._invites = new Map();     // id -> { id, steamId, resolve, reject }
    this._byIdentity = new Map();  // remote steam id -> invite id
    this._connPeers = new Map();   // connection handle -> peer
  }

  /** Open the listen socket. Idempotent, so `createInvite` can just call it. */
  listen() {
    if (this.listenSocket != null) return this.listenSocket;
    this.listenSocket = this.sockets.createListenSocketP2P(this.virtualPort);
    return this.listenSocket;
  }

  /**
   * Mint an invite. Unlike the WebRTC mint there is nothing to negotiate and
   * nothing to gather, so this is synchronous work wrapped in the promise its
   * caller (`NetHost.createInvite` -> `Lobby.createInvite`) already awaits.
   *
   * The blob is the WebRTC blob's shape with a Steam id where the SDP was, so
   * the lobby courier in `SteamLobby.js` carries it unaltered and
   * `Lobby._inviteIdFor` still finds the id in the answer.
   */
  async createInvite() {
    this.listen();
    const id = this._nextId++;
    const invite = { id, steamId: null, settle: null };
    this._invites.set(id, invite);
    return {
      id,
      blob: encode({ v: 1, role: 'offer', id, steamId: String(this.sockets.getIdentity() ?? '') }),
      // Steam does its own route-finding; there are no candidates to trickle.
      // Inert rather than absent for the same reason the WebRTC invite keeps
      // them inert on a non-trickle mint: a caller that wires them
      // unconditionally must not meet a TypeError.
      onIceCandidate: () => {},
      addIceCandidate: () => {},
      accept: (answerBlob) => this._accept(id, answerBlob),
    };
  }

  /**
   * Take the joiner's answer — its Steam id — and wait for its connection.
   *
   * The joiner has been calling `connectP2P` since it wrote the answer, so the
   * request may already be sitting in Steam's queue; `_pump` is called once up
   * front for exactly that case.
   */
  _accept(id, answerBlob) {
    const invite = this._invites.get(id);
    if (!invite) throw new Error('No pending invite matches that code');
    const msg = decode(String(answerBlob).trim());
    if (msg.role !== 'answer' || msg.id !== id) throw new Error('Answer does not match this invite');
    invite.steamId = String(msg.steamId ?? '');
    this._byIdentity.set(invite.steamId, id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._invites.delete(id);
        this._byIdentity.delete(invite.steamId);
        reject(new Error(
          'That player never finished connecting. Their network may be blocking it — '
          + 'ask them to try again, and see the connection note on this screen.',
        ));
      }, CONNECT_TIMEOUT_MS);
      timer?.unref?.();
      invite.settle = (peer, err) => {
        clearTimeout(timer);
        this._invites.delete(id);
        this._byIdentity.delete(invite.steamId);
        if (err) reject(err); else resolve(peer);
      };
      this._pump();
    });
  }

  /**
   * Accept inbound requests and turn state changes into peers.
   *
   * Pull, not callbacks: see the module header on the dispatch hold.
   */
  _pump() {
    const s = this.sockets;
    for (const req of s.getPendingConnectionRequests?.() ?? []) {
      if (this.listenSocket != null && req.listenSocket !== this.listenSocket) continue;
      // Only a peer we handed an invite to and read an answer from. An
      // unexpected identity is refused rather than admitted and counted: the
      // lobby is the guest list, and `NetHost` has no vocabulary for a peer
      // that arrived without one.
      if (!this._byIdentity.has(String(req.identityRemote))) {
        try { s.closeConnection(req.connection, 0, 'not invited', false); } catch {}
        continue;
      }
      s.acceptConnection(req.connection);
    }

    for (const change of s.getPendingStateChanges?.() ?? []) {
      if (change.newState === STATE_CONNECTED) this._onConnected(change);
      else if (change.newState === STATE_CLOSED_BY_PEER || change.newState === STATE_PROBLEM_LOCALLY) {
        const peer = this._connPeers.get(change.connection);
        if (peer) this._drop(peer);
      }
    }

    for (const peer of this.peers.values()) peer.pumpSim();
  }

  _onConnected(change) {
    if (this._connPeers.has(change.connection)) return;
    const identity = String(change.info?.identityRemote ?? '');
    const id = this._byIdentity.get(identity);
    if (id == null) return;
    const invite = this._invites.get(id);
    const peer = new SteamPeer(this.sockets, change.connection, id);
    this._connPeers.set(change.connection, peer);
    this.peers.set(id, peer);
    this.onPeer?.(peer);
    invite?.settle?.(peer, null);
  }

  /** Give up an invite nobody answered. Same contract as the WebRTC one. */
  cancelInvite(id) {
    const invite = this._invites.get(id);
    if (invite) {
      this._invites.delete(id);
      if (invite.steamId) this._byIdentity.delete(invite.steamId);
      invite.settle?.(null, new Error('The invite was given up'));
    }
    const peer = this.peers.get(id);
    if (!peer) return invite != null;
    this.peers.delete(id);
    if (peer.conn != null) this._connPeers.delete(peer.conn);
    peer.close();
    return true;
  }

  _drop(peer) {
    if (!this.peers.has(peer.id)) return;
    this.peers.delete(peer.id);
    if (peer.conn != null) this._connPeers.delete(peer.conn);
    peer.close();
    this.onPeerLeave?.(peer);
  }

  broadcastEvent(bytes, except = null) {
    for (const p of this.peers.values()) if (p !== except) p.sendEvent(bytes);
  }

  close() {
    for (const p of [...this.peers.values()]) this._drop(p);
    for (const id of [...this._invites.keys()]) this.cancelInvite(id);
    if (this.listenSocket != null) {
      try { this.sockets.closeListenSocket(this.listenSocket); } catch {}
      this.listenSocket = null;
    }
  }
}

/** The client half: `join`, `onConnected`, `onDisconnected`, `peer`. */
export class SteamClientTransport {
  constructor({ sockets, virtualPort = 0 } = {}) {
    this.sockets = sockets;
    this.virtualPort = virtualPort;
    this.peer = null;
    this.onConnected = null;
    this.onDisconnected = null;
    this._timer = null;
  }

  onIceCandidate() {}
  addIceCandidate() {}

  /**
   * Read the host's Steam id out of the invite, start connecting, and hand back
   * the answer blob the lobby courier carries home.
   *
   * The answer goes out *before* the connection is up, exactly as the WebRTC
   * answer does: the host cannot accept a connection from an identity it has
   * not been told to expect, so the address has to travel first.
   */
  async join(inviteBlob) {
    const msg = decode(String(inviteBlob).trim());
    if (msg.role !== 'offer') throw new Error('That is not a host invite code');
    const conn = this.sockets.connectP2P(msg.steamId, this.virtualPort);
    const peer = new SteamPeer(this.sockets, conn, msg.id);
    this.peer = peer;

    const connected = new Promise((resolve, reject) => {
      // Polled rather than callback-driven for the reason in the module
      // header: this transport never drives Steam's callback dispatch.
      this._timer = setInterval(() => {
        for (const change of this.sockets.getPendingStateChanges?.() ?? []) {
          if (change.connection !== conn) continue;
          if (change.newState === STATE_CONNECTED) {
            this._stopPolling();
            this.onConnected?.(peer);
            resolve(peer);
          } else if (change.newState === STATE_CLOSED_BY_PEER || change.newState === STATE_PROBLEM_LOCALLY) {
            this._stopPolling();
            reject(new Error('The connection to the host failed before the game could start.'));
            peer.close();
            this.onDisconnected?.();
          }
        }
      }, 50);
      // Deliberately NOT `unref`ed, unlike the host's connect deadline. This
      // timer is the only thing that can settle the join, so a node process
      // that exited while it was pending would be exiting in the middle of a
      // connection rather than after one. `_stopPolling` clears it on either
      // outcome, and `close()` clears it on a join nobody waited out.

    });
    // As on the WebRTC side: without this the internal chain is an unhandled
    // rejection whenever the join fails. The promise handed to the caller still
    // rejects.
    connected.catch(() => {});

    return {
      blob: encode({ v: 1, role: 'answer', id: msg.id, steamId: String(this.sockets.getIdentity() ?? '') }),
      connected,
    };
  }

  _stopPolling() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  close() {
    this._stopPolling();
    this.peer?.close();
  }
}
