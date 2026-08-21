/**
 * The transport contract again, with the IPC bridge in the middle.
 *
 * `tests/transport-steam.mjs` hands `SteamTransport` a sockets object directly,
 * which is what the main process would do. This adapter hands it
 * `desktop/net-bridge-renderer.cjs`'s published surface instead, wired to
 * `desktop/net-bridge-main.mjs`, which is wired to the same fake sockets layer
 * — so the bytes cross the same seam they cross in the shipping shell, and the
 * contract is asserted on the far side of it.
 *
 * Not one assertion is softened; `tests/transport-contract.mjs` is imported
 * unchanged and does not know this adapter exists. What the adapter has to
 * provide, and does, is the notion of *a tick*: in the shell the bridge's two
 * halves are separated by an IPC hop and a 60 Hz pump, and here they are
 * separated by an explicit `tick()` that flushes every outbox and runs every
 * pump. That is a scheduler, not a weakening — the same messages cross in the
 * same order.
 *
 * The rendezvous is still out of contract (ADR 0002), but unlike the direct
 * adapter this one cannot skip it: `connectPair` mints connections behind the
 * sockets interface, and the whole point here is that nothing bypasses the
 * bridge. So a peer arrives the way one really arrives — `connectP2P`, an
 * inbound request, `acceptConnection`, a CONNECTED state change — driven
 * through `SteamHostTransport._pump`, with only the guest-list entry
 * (`_byIdentity`) set by hand where an answer blob would have set it.
 */
import { SteamPeer, SteamHostTransport } from '../src/net/SteamTransport.js';
import { makeSteamNet } from './steam-sockets-fake.mjs';
import { createNetBridgeMain } from '../desktop/net-bridge-main.mjs';
import rendererHalf from '../desktop/net-bridge-renderer.cjs';

const { createNetBridgeRenderer } = rendererHalf;

const HOST_ID = '76561190000000001';
const peerIdentity = (id) => `7656119000000${String(1000 + id)}`;

let net = null;
let seats = [];
let hostSeat = null;
/** Peer proxy handle -> the real handle the fake knows it by. */
let realOf = new Map();

/** One player: raw fake sockets, a main half, a renderer half, over one "IPC". */
function makeSeat(steamId) {
  const raw = net.forIdentity(steamId);
  let renderer = null;
  const main = createNetBridgeMain({ sockets: raw, push: (payload) => renderer.deliver(payload) });
  renderer = createNetBridgeRenderer({
    post: (batch) => main.apply(batch),
    identity: steamId,
    // No timer: this harness is the scheduler, so the outbox leaves only when
    // `tick()` says so. An auto-flush would hide an ordering bug behind the
    // event loop.
    schedule: () => {},
  });
  const seat = { steamId, raw, main, sockets: renderer.sockets, flush: renderer.flush };
  seats.push(seat);
  return seat;
}

/** Every outbox out, then every pump in. One frame of the whole shell. */
function tick() {
  for (const s of seats) s.flush();
  for (const s of seats) s.main.pump();
}

function createHostTransport() {
  net = makeSteamNet();
  seats = [];
  realOf = new Map();
  hostSeat = makeSeat(HOST_ID);
  const transport = new SteamHostTransport({ sockets: hostSeat.sockets });
  transport.listen();
  tick();                        // the listen socket only exists after this
  return transport;
}

function connectPeer(host, id) {
  const clientId = peerIdentity(id);
  const clientSeat = makeSeat(clientId);

  // The guest list. In the shell this line is `_accept` reading an answer blob;
  // that is the Introduction, and ADR 0002 keeps it out of the contract.
  host.transport._byIdentity.set(clientId, id);

  const clientConn = clientSeat.sockets.connectP2P(HOST_ID, 0);
  const clientPeer = new SteamPeer(clientSeat.sockets, clientConn, id);

  tick();
  host.transport._pump();        // sees the request, accepts it
  tick();
  host.transport._pump();        // sees CONNECTED, builds the peer, fires onPeer
  tick();                        // and the first status reaches both caches

  const hostPeer = host.transport.peers.get(id);
  if (!hostPeer) throw new Error('the bridged handshake produced no host peer');

  realOf.set(hostPeer, hostSeat.main.realFor(hostPeer.conn));
  realOf.set(clientPeer, clientSeat.main.realFor(clientConn));

  // In the shell, main's pump and the renderer's frame hook are two clocks that
  // both run at 60 Hz; here there is no clock at all, so a peer's frame hook is
  // where the tick is hung. The contract advances impaired traffic by calling
  // `pumpSim` directly rather than through `adapter.flush`, and on this side of
  // the bridge the message it is waiting for is released by the MAIN half --
  // which would otherwise never run. This is the adapter supplying a scheduler,
  // and it neither adds nor removes a message.
  for (const p of [hostPeer, clientPeer]) {
    const inner = p.pumpSim.bind(p);
    p.pumpSim = () => { tick(); inner(); };
  }

  return {
    hostPeer,
    clientPeer,
    hostConn: realOf.get(hostPeer),
    clientConn: realOf.get(clientPeer),
  };
}

function flush(wire, { lose = null } = {}) {
  const hostRec = net.conn(wire.hostConn);
  const clientRec = net.conn(wire.clientConn);
  // Armed across the tick, not across `pumpSim`: on this side of the bridge the
  // fake's `receiveMessages` is called by the main half, inside `tick()`.
  if (hostRec) hostRec.lose = lose;
  if (clientRec) clientRec.lose = lose;
  try {
    // No tick of its own: each peer's `pumpSim` carries one, above.
    wire.hostPeer.pumpSim();
    wire.clientPeer.pumpSim();
  } finally {
    if (hostRec) hostRec.lose = null;
    if (clientRec) clientRec.lose = null;
  }
}

function impair(peer, { lagMs = 0, jitterMs = 0, lossPct = 0 } = {}) {
  const clock = { t: 0 };
  net.impair(realOf.get(peer), { lagMs, jitterMs, lossPct }, () => clock.t);
  return clock;
}

/** Followed by a tick, because `drained()` reads a cache main has to refill. */
function setPendingReliable(peer, bytes) {
  net.conn(realOf.get(peer)).pendingReliable = bytes;
  tick();
}

function closeReliable(peer) {
  net.killQuietly(realOf.get(peer));
  tick();
}

function dropReliable(peer) {
  peer.conn = null;
}

export const bridgedSteamAdapter = {
  name: 'steam-sockets-over-ipc-bridge',
  createHostTransport,
  connectPeer,
  flush,
  impair,
  setPendingReliable,
  closeReliable,
  dropReliable,
};
