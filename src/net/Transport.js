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
import { rtcConfig, netSim } from './NetConfig.js';

// Base64 of the JSON description. Deflate would roughly halve it, but SDP blobs
// are already paste-able and CompressionStream isn't worth the fallback path.
const encode = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '');
const decode = (s) => JSON.parse(atob(s));

// Above this, the unreliable channel is backed up enough that we are already
// behind, so a fresh snapshot is dropped rather than queued (below, `0`
// would drop every send and defeat the channel entirely). Named once so the
// immediate-send and delayed-release paths cannot silently diverge.
const MAX_STATE_BUFFERED = 256 * 1024;

// Caps the `?netlag=` delay queue. Sends that reach `_simSend` are driven by
// message callbacks (hello/ping/refuse/forwarded events), not only by the
// per-frame `pumpSim()` caller, so a stalled render/update loop could
// otherwise grow this without bound while the data channel keeps delivering.
// Too low (below the packets a real probe legitimately has in flight at the
// configured lag) would drop traffic a real network of that latency would
// have delivered, contaminating the exact measurement this rig exists to
// produce; too high defeats the point of capping a stall at all. Dropping
// the oldest queued entry — the one held longest and therefore already the
// most stale — mirrors the "drop rather than queue" choice already made for
// a backed-up `state` channel above.
const MAX_SIM_QUEUE = 2048;

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
    this._sim = null;
    this._simQueue = null;
  }

  _wire(ch, label) {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (e) => this.onMessage?.(e.data, label, this);
    ch.onclose = () => this.close();
    ch.onerror = () => {};
    return ch;
  }

  /**
   * Arm the latency rig. `clock` returns seconds, monotonic; it is a parameter
   * so tests can drive it. Called only when `netSim().on` — a Peer that is not
   * armed has `_sim === null` and every send takes the original branch, so the
   * shipped path costs one null check and allocates nothing.
   */
  installSim(sim, clock) {
    this._sim = sim;
    this._simClock = clock;
    this._simQueue = [];
  }

  /** Release anything whose delay has elapsed. Inert when not armed. */
  pumpSim() {
    const q = this._simQueue;
    if (!q || q.length === 0) return;
    const now = this._simClock();
    let i = 0;
    // The queue is append-ordered and delays are drawn per packet, so a later
    // packet can come due first under jitter. Releasing strictly in queue order
    // preserves the ordering the channel would have had; reordering here would
    // be simulating a different network than the flag asks for.
    while (i < q.length && q[i].due <= now) i++;
    if (i === 0) return;
    const due = q.splice(0, i);
    for (const p of due) this._rawSend(p.ch, p.bytes);
  }

  _rawSend(label, bytes) {
    const ch = label === 'state' ? this.state : this.events;
    if (ch?.readyState !== 'open') return;
    if (label === 'state' && ch.bufferedAmount > MAX_STATE_BUFFERED) return;
    ch.send(bytes);
  }

  /** Returns true when the rig consumed the packet (dropped or queued). */
  _simSend(label, bytes) {
    const sim = this._sim;
    if (!sim) return false;
    if (label === 'state' && sim.lossPct > 0 && Math.random() * 100 < sim.lossPct) return true;
    const delay = (sim.lagMs + (sim.jitterMs ? Math.random() * sim.jitterMs : 0)) / 1000;
    if (delay <= 0) return false;
    const q = this._simQueue;
    if (q.length >= MAX_SIM_QUEUE) q.shift();
    q.push({ ch: label, bytes, due: this._simClock() + delay });
    return true;
  }

  sendState(bytes) {
    if (this._simSend('state', bytes)) return;
    if (this.state?.readyState === 'open') {
      // Drop rather than queue: a backed-up unreliable channel means we are
      // already behind, and stale snapshots are worse than none.
      if (this.state.bufferedAmount > MAX_STATE_BUFFERED) return;
      this.state.send(bytes);
    }
  }

  sendEvent(bytes) {
    if (this._simSend('events', bytes)) return;
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
    const sim = netSim();
    if (sim.on) peer.installSim(sim, () => performance.now() / 1000);

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
    const sim = netSim();
    if (sim.on) peer.installSim(sim, () => performance.now() / 1000);
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
