/**
 * The Steam arm of the transport contract: the real `SteamPeer` and
 * `SteamHostTransport`, over the fake sockets layer in
 * `tests/steam-sockets-fake.mjs`.
 *
 * Not a test on its own — `tests/transport-conformance.test.mjs` runs the
 * contract in `tests/transport-contract.mjs` against this and against the
 * WebRTC loopback, and neither adapter is allowed to soften an assertion.
 *
 * ## What is real and what is stubbed
 *
 * Real: everything in `src/net/SteamTransport.js` that the contract reaches —
 * the channel-byte framing, both send paths and their reliability flags, the
 * receive pump that rides `pumpSim`, `drained()` over
 * `getConnectionRealTimeStatus`, `close()` with linger, and the host
 * transport's `peers` / `_drop` / `broadcastEvent` / `close`. Real `NetHost`,
 * `NetClient`, `Protocol` and `SnapshotBuffer` on top.
 *
 * Stubbed, and only this: `ISteamNetworkingSockets` itself. **This has never
 * met a live Steam connection** — see `docs/STEAM.md` section 8.5 for what the
 * user's socket-pair smoke and two-seat sitting still have to prove.
 *
 * Deliberately out of scope: the Introduction. `createInvite` / `join` are
 * rendezvous, `docs/adr/0002` puts them outside the portable contract, and on
 * this transport they are an address exchange with no negotiation to test in
 * process.
 *
 * ## Why `flush` is a pump
 *
 * Steam holds received messages until the application calls `receiveMessages`,
 * so "deliver what is in flight" is literally a pump on each end — which is
 * what `SteamPeer.pumpSim()` does in the shipping path too. The contract's
 * `lose` filter is pushed down into the fake, where it can drop unreliable
 * messages by index within the pass and refuse to drop reliable ones at all.
 */
import { SteamPeer, SteamHostTransport } from '../src/net/SteamTransport.js';
import { makeSteamNet } from './steam-sockets-fake.mjs';

const HOST_ID = '76561190000000001';
const peerIdentity = (id) => `7656119000000${String(1000 + id)}`;

let net = null;
let hostSockets = null;

function createHostTransport() {
  net = makeSteamNet();
  hostSockets = net.forIdentity(HOST_ID);
  const transport = new SteamHostTransport({ sockets: hostSockets });
  transport.listen();
  return transport;
}

/**
 * Bring up one connected host/client peer pair and register the host half.
 *
 * The two registration lines mirror `SteamHostTransport._onConnected` —
 * `peers.set(id, peer)` then `onPeer(peer)` — and are duplicated rather than
 * reached through `createInvite`/`join` for the same reason the WebRTC adapter
 * duplicates them: that path is the Introduction, which is out of contract.
 */
function connectPeer(host, id) {
  const clientId = peerIdentity(id);
  const clientSockets = net.forIdentity(clientId);
  const [hostConn, clientConn] = net.connectPair(HOST_ID, clientId);

  const hostPeer = new SteamPeer(hostSockets, hostConn, id);
  const clientPeer = new SteamPeer(clientSockets, clientConn, id);

  // `_connPeers` is how the transport turns a Steam close into `onPeerLeave`;
  // registering here keeps that path live for a peer this adapter built.
  host.transport._connPeers.set(hostConn, hostPeer);
  host.transport.peers.set(id, hostPeer);
  host.transport.onPeer?.(hostPeer);

  return { hostPeer, clientPeer, hostConn, clientConn };
}

/** Deliver everything due, once, on both ends. */
function flush(wire, { lose = null } = {}) {
  const hostRec = net.conn(wire.hostConn);
  const clientRec = net.conn(wire.clientConn);
  if (hostRec) hostRec.lose = lose;
  if (clientRec) clientRec.lose = lose;
  try {
    wire.hostPeer.pumpSim();
    wire.clientPeer.pumpSim();
  } finally {
    if (hostRec) hostRec.lose = null;
    if (clientRec) clientRec.lose = null;
  }
}

/**
 * Impair one peer's *inbound* traffic and hand back the clock driving it.
 *
 * Receive-side, which is not a convenience: Steam's own knobs are
 * `k_ESteamNetworkingConfig_FakePacketLag_Recv` and
 * `FakePacketLoss_Recv`, so the shape the WebRTC rig arrived at by measurement
 * is the shape this transport would get from the platform.
 */
function impair(peer, { lagMs = 0, jitterMs = 0, lossPct = 0 } = {}) {
  const clock = { t: 0 };
  net.impair(peer.conn, { lagMs, jitterMs, lossPct }, () => clock.t);
  return clock;
}

/** Reliable bytes still in the send queue, as `drained()` reads them. */
function setPendingReliable(peer, bytes) {
  net.conn(peer.conn).pendingReliable = bytes;
}

/** The reliable path closed under the peer, without the peer being told. */
function closeReliable(peer) {
  net.killQuietly(peer.conn);
}

/** No reliable path at all — the Steam reading of "the channel is absent". */
function dropReliable(peer) {
  peer.conn = null;
}

export const steamAdapter = {
  name: 'steam-sockets',
  createHostTransport,
  connectPeer,
  flush,
  impair,
  setPendingReliable,
  closeReliable,
  dropReliable,
};
