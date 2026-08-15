/**
 * The WebRTC arm of the transport contract: real `Peer`, real `HostTransport`,
 * two fake `RTCDataChannel`s in the middle.
 *
 * Not a test on its own — `tests/transport-conformance.test.mjs` runs the
 * contract in `tests/transport-contract.mjs` against this.
 *
 * ## What is real and what is stubbed
 *
 * Real: `Peer` in full — `_wire`, `sendState`'s `readyState`/`bufferedAmount`
 * gates, `sendEvent`, `installSim`/`pumpSim`, `close`, `onClose` — and
 * `HostTransport`'s in-contract half: `peers`, `_drop`, `broadcastEvent`,
 * `close`, `onPeer`, `onPeerLeave`. Real `NetHost`, `NetClient`, `Protocol`
 * codec and `SnapshotBuffer` sit on top, driven by the contract suite.
 *
 * Stubbed, and only this: `RTCPeerConnection` and its two `RTCDataChannel`s.
 * They are replaced by `channelPair()` below, which implements exactly the
 * surface `Peer` touches. That is the point rather than a shortcut — the thing
 * being verified is that the *game* behaves over a transport meeting the
 * contract, and a real peer connection would drag in ICE, DTLS and a browser to
 * prove nothing extra about `NetHost`.
 *
 * Deliberately out of scope: the Introduction. `createInvite`/`join`/answer
 * blobs/ICE are transport-specific by nature, they have no Steam analogue, and
 * `docs/adr/0002` puts them outside the portable contract on purpose. Issue #13
 * covers them, on two machines, where they can actually be exercised.
 *
 * ## Why delivery is queued rather than immediate
 *
 * `send()` puts bytes in a queue and `flush()` delivers them. A channel that
 * called the far side's `onmessage` synchronously inside `send()` would re-enter
 * the sender mid-frame — `NetHost._broadcastSnapshot` would run a client's
 * handler while still inside its own send loop — which no real channel does and
 * which would make ordering bugs pass. Queueing also gives the suite a place to
 * stand for "in flight": impairment, loss and out-of-order delivery are all
 * expressed by what `flush()` chooses to do.
 */
import { Peer, HostTransport } from '../src/net/Transport.js';

/**
 * One end of a fake `RTCDataChannel`. The member list is not arbitrary: it is
 * every member `Peer` and `NetHost` touch, per `docs/STEAM.md` section 8.5 —
 * including `readyState` and `bufferedAmount`, which `NetHost._closeWhenFlushed`
 * reads *through* the peer. That reach-through is the leak the ADR flags, and it
 * is modelled here rather than papered over, because a fixture that hides it
 * would let the Steam transport discover it the hard way.
 */
function makeChannel(label) {
  return {
    label,
    binaryType: '',
    readyState: 'open',
    bufferedAmount: 0,
    onmessage: null,
    onclose: null,
    onerror: null,
    onopen: null,
    _far: null,
    _inflight: [],

    send(bytes) {
      if (this.readyState !== 'open') return;
      // Copy on send. `Writer.bytes()` already returns a fresh ArrayBuffer today,
      // but a wire that aliased the sender's buffer would be a fixture with a
      // property the real one does not have, and the host reuses one `Writer`
      // for every snapshot.
      this._far._inflight.push(bytes.slice(0));
    },

    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      this.onclose?.();
    },
  };
}

/** Two channels wired to each other. Nothing is delivered until `flush()`. */
function channelPair(label) {
  const a = makeChannel(label);
  const b = makeChannel(label);
  a._far = b;
  b._far = a;
  return [a, b];
}

/**
 * A stand-in for the `RTCPeerConnection` a `Peer` holds. `Peer.close()` calls
 * `pc.close()` inside a `try`, and nothing else in the contract touches it.
 */
function makePc(onClose) {
  return { close() { onClose?.(); } };
}

/**
 * Build one connected host/client peer pair and register the host half with the
 * transport.
 *
 * The two registration lines mirror `Transport.js:482` and `Transport.js:490` —
 * `peers.set(id, peer)` then `onPeer(peer)` — which is what `createInvite` does
 * once both channels report open. They are duplicated rather than reached
 * through `createInvite` because that method's body is offer/answer/ICE, i.e.
 * the Introduction, which needs a real `RTCPeerConnection`.
 */
function connectPeer(host, id) {
  const [hState, cState] = channelPair('state');
  const [hEvents, cEvents] = channelPair('events');

  const hostPeer = new Peer(makePc(() => { hState.close(); hEvents.close(); }), id);
  hostPeer.state = hostPeer._wire(hState, 'state');
  hostPeer.events = hostPeer._wire(hEvents, 'events');

  const clientPeer = new Peer(makePc(() => { cState.close(); cEvents.close(); }), id);
  clientPeer.state = clientPeer._wire(cState, 'state');
  clientPeer.events = clientPeer._wire(cEvents, 'events');

  const wire = { hostPeer, clientPeer, channels: [hState, cState, hEvents, cEvents] };

  host.transport.peers.set(id, hostPeer);
  host.transport.onPeer?.(hostPeer);

  return wire;
}

/**
 * Deliver everything queued, in send order, once.
 *
 * One pass, not to exhaustion: a handler that sends in reply — and `NetHost`
 * does, WELCOME answers a join and PONG answers a PING — would otherwise let one
 * `flush()` run the whole conversation and hide which side spoke first. The
 * suite calls `flush()` as many times as it means to let messages cross.
 *
 * `lose` drops packets on the unreliable channel only, by index within this
 * pass, so loss is stated by the test rather than drawn at random. Dropping a
 * reliable packet is not offered: the contract says `events` is reliable, and a
 * fixture able to violate that would be testing a different transport.
 */
function flush(wire, { lose = null } = {}) {
  let delivered = 0;
  for (const ch of wire.channels) {
    const queued = ch._inflight.splice(0, ch._inflight.length);
    for (let i = 0; i < queued.length; i++) {
      if (ch.readyState !== 'open') break;
      if (lose && ch.label === 'state' && lose(i, delivered)) continue;
      ch.onmessage?.({ data: queued[i] });
      delivered++;
    }
  }
  return delivered;
}

/**
 * Impair one peer's *inbound* traffic, and hand back the clock that drives it.
 *
 * Receive-side and one-directional, which is not a simplification but the shape
 * the rig actually has — see `Peer.installSim`, which moved the delay off the
 * sender after a queued HELLO cost a measured 3.9 s and made every lagged join
 * fail. A Steam adapter implements this member with
 * `k_ESteamNetworkingConfig_FakePacketLag_Recv` and friends, which are
 * receive-side too, so the contract carries over.
 *
 * The clock is supplied rather than real: passing one tells `installSim` that
 * this caller drives time and will pump, which is what makes the assertion about
 * ordering a statement about the queue instead of about how fast the box ran.
 */
function impair(peer, { lagMs = 0, jitterMs = 0, lossPct = 0 } = {}) {
  const clock = { t: 0 };
  peer.installSim({ on: true, lagMs, jitterMs, lossPct }, () => clock.t);
  return clock;
}

export const loopbackAdapter = {
  name: 'webrtc-loopback',
  /** The transport `NetHost` is given. Real, minus the Introduction. */
  createHostTransport: () => new HostTransport(),
  connectPeer,
  flush,
  impair,
  channelPair,
  makePc,
};
