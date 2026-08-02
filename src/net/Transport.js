/**
 * WebRTC transport.
 *
 * Signalling is pluggable because the two useful modes have very different
 * infrastructure needs:
 *   - ManualSignaller  — zero servers. Host copies a blob, friend pastes it,
 *                        friend copies an answer back. Ugly but it works today
 *                        with nothing deployed.
 *   - SocketSignaller  — a ~40-line WebSocket relay (tools/signal-server.mjs)
 *                        for a normal "enter room code" flow.
 *
 * Both produce the same connected `Peer`, so nothing above this file cares.
 *
 * ICE is gathered non-trickle (we wait for gathering to complete before handing
 * out the blob) specifically so manual signalling is a single copy/paste rather
 * than an ongoing candidate exchange.
 */

// ICE config is resolved per connection rather than captured once at module
// load, so a `?turn=` / `?ice=relay` override applies to the next invite without
// a reload. See `NetConfig.js` for why TURN is not optional past a friendly LAN.
import { rtcConfig } from './NetConfig.js';

// Base64 of the JSON description. Deflate would roughly halve it, but SDP blobs
// are already paste-able and CompressionStream isn't worth the fallback path.
const encode = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '');
const decode = (s) => JSON.parse(atob(s));

/** One connected remote endpoint, with the two channels Protocol.js expects. */
export class Peer {
  constructor(pc, id) {
    this.pc = pc;
    this.id = id;
    this.state = null;    // unreliable/unordered — input + snapshots
    this.events = null;   // reliable/ordered — one-shot facts
    this.onMessage = null;
    this.onClose = null;
    this.rtt = 0;
    this.closed = false;
  }

  _wire(ch, label) {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => this.onMessage?.(e.data, label, this);
    ch.onclose = () => this.close();
    ch.onerror = () => {};
    return ch;
  }

  sendState(bytes) {
    if (this.state?.readyState === 'open') {
      // Drop rather than queue: a backed-up unreliable channel means we are
      // already behind, and stale snapshots are worse than none.
      if (this.state.bufferedAmount > 256 * 1024) return;
      this.state.send(bytes);
    }
  }

  sendEvent(bytes) {
    if (this.events?.readyState === 'open') this.events.send(bytes);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.pc.close(); } catch {}
    this.onClose?.(this);
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    // Some networks never reach 'complete' (no reflexive candidate). Cap the
    // wait so a join doesn't hang forever on a bad network.
    const timer = setTimeout(done, 4000);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * Host side. Call `createInvite()` once per joining player, hand the blob over,
 * then feed the returned answer blob back into the matching `accept`.
 */
export class HostTransport {
  constructor() {
    this.peers = new Map();
    this.onPeer = null;      // (peer) => void, fired once channels are open
    this.onPeerLeave = null;
    this._nextId = 1;
  }

  async createInvite() {
    const id = this._nextId++;
    const pc = new RTCPeerConnection(rtcConfig());
    const peer = new Peer(pc, id);

    // Host creates both channels so ordering/ids are deterministic; the client
    // just picks them up via ondatachannel.
    peer.state = peer._wire(
      pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }), 'state'
    );
    peer.events = peer._wire(
      pc.createDataChannel('events', { ordered: true }), 'events'
    );

    let opened = 0;
    const ready = new Promise((resolve) => {
      const tick = () => { if (++opened === 2) resolve(peer); };
      peer.state.onopen = tick;
      peer.events.onopen = tick;
    });

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this._drop(peer);
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);

    this.peers.set(id, peer);
    ready.then((p) => this.onPeer?.(p));

    return {
      id,
      blob: encode({ v: 1, role: 'offer', id, sdp: pc.localDescription }),
      accept: async (answerBlob) => {
        const msg = decode(answerBlob.trim());
        if (msg.role !== 'answer' || msg.id !== id) throw new Error('Answer does not match this invite');
        await pc.setRemoteDescription(msg.sdp);
        return ready;
      },
    };
  }

  _drop(peer) {
    if (!this.peers.has(peer.id)) return;
    this.peers.delete(peer.id);
    peer.close();
    this.onPeerLeave?.(peer);
  }

  broadcastState(bytes, except = null) {
    for (const p of this.peers.values()) if (p !== except) p.sendState(bytes);
  }
  broadcastEvent(bytes, except = null) {
    for (const p of this.peers.values()) if (p !== except) p.sendEvent(bytes);
  }
  close() {
    for (const p of [...this.peers.values()]) this._drop(p);
  }
}

/** Client side. Consume the host's invite blob, return an answer blob. */
export class ClientTransport {
  constructor() {
    this.peer = null;
    this.onConnected = null;
    this.onDisconnected = null;
  }

  async join(inviteBlob) {
    const msg = decode(inviteBlob.trim());
    if (msg.role !== 'offer') throw new Error('That is not a host invite code');

    const pc = new RTCPeerConnection(rtcConfig());
    const peer = new Peer(pc, msg.id);
    this.peer = peer;

    let opened = 0;
    const ready = new Promise((resolve) => {
      pc.ondatachannel = (e) => {
        const ch = peer._wire(e.channel, e.channel.label);
        if (e.channel.label === 'state') peer.state = ch;
        else peer.events = ch;
        const tick = () => { if (++opened === 2) resolve(peer); };
        if (ch.readyState === 'open') tick(); else ch.onopen = tick;
      };
    });

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        peer.close();
        this.onDisconnected?.();
      }
    };

    await pc.setRemoteDescription(msg.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);

    ready.then((p) => this.onConnected?.(p));

    return {
      blob: encode({ v: 1, role: 'answer', id: msg.id, sdp: pc.localDescription }),
      connected: ready,
    };
  }
}
