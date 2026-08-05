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
// produce; too high defeats the point of capping a stall at all.
//
// The eviction policy is `state`-only, and that is not a nicety. This queue
// is shared by both channels — `_simSend` is reached from `sendState` and
// from `sendEvent` — so an unqualified `shift()` here could discard a queued
// `events` packet, which the transport declares `{ ordered: true }` and the
// rig's own charter (`NetConfig.js`, `netSim`) promises never to drop. A
// HELLO, a WELCOME or a forwarded event vanishing with no refusal and
// nothing in the console is indistinguishable from the join defects this rig
// was built to measure, so the rig would be manufacturing its own evidence.
// `_simEvict` therefore drops the oldest *state* entry (held longest, so
// already the most stale — the same "drop rather than queue" choice made for
// a backed-up `state` channel above) and, when the backlog is entirely
// reliable, exceeds the cap and says so once rather than lying about the
// guarantee. Unbounded growth is the lesser failure: it is loud, it is
// bounded in practice because state traffic dominates by an order of
// magnitude, and it does not corrupt a measurement.
// Exported so `tests/netlag.test.mjs` fills the queue against the real cap
// rather than against a copy of the number that can drift away from it.
export const MAX_SIM_QUEUE = 2048;

// How long the host waits, *after applying a joiner's answer*, for both data
// channels to open before it gives up on that peer.
//
// The window opens at `accept` rather than at `createInvite` deliberately: the
// invite-to-answer leg is a human copying a blob into a chat window and can
// legitimately take minutes, while from `setRemoteDescription` onwards both
// ends are exchanging ICE checks and nothing is waiting on a person.
//
// Too short and a slow-but-healthy join is refused mid-negotiation — a TURN
// allocation on a poor mobile network is seconds on its own, and the slowest
// *successful* join in this branch's own captures (reviews/round8/n1) took
// 8972 ms. Too long and this constant becomes the hang it exists to remove:
// the host's co-op panel sits on "connecting…" with the answer code still in
// the box and no error, which is precisely the state that made the four-peer
// join failure unreportable by either player. 20 s is a little over twice the
// slowest observed success and still inside the span a player will wait before
// concluding the game is broken.
const CONNECT_TIMEOUT_MS = 20000;

/**
 * Settle `promise` one way or the other within `ms`.
 *
 * `ready` below resolves only when both channels open, so on a peer whose
 * connection never forms it neither resolves nor rejects, and every caller
 * awaiting it — `Lobby.acceptAnswer`, and the host UI's `await` around that —
 * waits for ever, reaching neither its success path nor its `catch`.
 */
function withDeadline(promise, ms, message) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject);
  }).finally(() => clearTimeout(timer));
}

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
    this._simOverflowWarned = false;
  }

  /**
   * Make room for one more queued packet, never at a reliable packet's expense.
   *
   * Drops the oldest `state` entry if there is one. If the whole backlog is
   * `events`, the queue is allowed past `MAX_SIM_QUEUE` and we warn once: a rig
   * that quietly discards ordered/reliable traffic measures a transport this
   * game does not ship. The scan is O(queue) but only on overflow, and lands on
   * index 0 in the ordinary case because snapshots dominate the queue.
   */
  _simEvict() {
    const q = this._simQueue;
    for (let i = 0; i < q.length; i++) {
      if (q[i].ch === 'state') { q.splice(i, 1); return; }
    }
    if (!this._simOverflowWarned) {
      this._simOverflowWarned = true;
      console.warn(
        `[net] ?netlag= queue is past ${MAX_SIM_QUEUE} entries and holds no droppable state packet; ` +
        'growing rather than dropping reliable traffic — the pump is stalled.'
      );
    }
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
    // The shipped transport drops when the channel is not open — `sendState` /
    // `sendEvent` below both check, and so does `_rawSend` on release. The rig
    // queued first and never consulted channel state, and a `Peer` enters
    // `HostTransport.peers` at *invite* time, so `_forward`'s broadcast filled
    // this queue for the whole pre-connect window and released the lot in one
    // burst on the first pump after the channels opened: a purse jump,
    // unearned level-ups and a stale realmEnter/realmExit pair the shipped
    // game never delivers. Returning false hands the packet back to the
    // caller's own open-check, so the drop is the same code either way.
    const ch = label === 'state' ? this.state : this.events;
    if (ch?.readyState !== 'open') return false;
    if (label === 'state' && sim.lossPct > 0 && Math.random() * 100 < sim.lossPct) return true;
    const delay = (sim.lagMs + (sim.jitterMs ? Math.random() * sim.jitterMs : 0)) / 1000;
    if (delay <= 0) return false;
    const q = this._simQueue;
    if (q.length >= MAX_SIM_QUEUE) this._simEvict();
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

  /**
   * The connect deadline in milliseconds. A seam so the gate is testable
   * without a 20 s test, in the same shape and for the same reason as
   * `NetHost._now()`.
   */
  _connectTimeoutMs() { return CONNECT_TIMEOUT_MS; }

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
    let failConnect = null;
    const ready = new Promise((resolve, reject) => {
      failConnect = reject;
      const tick = () => { if (++opened === 2) resolve(peer); };
      peer.state.onopen = tick;
      peer.events.onopen = tick;
    });

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // Settle `ready` on the browser's own failure signal, symmetric with
        // the client's `failJoin`. Without this the host had a *deadline* but
        // no *failure* signal: ICE could fail at t=3 s, `_drop` would run and
        // the console would say so, while `ready` stayed pending and the co-op
        // panel read "Reply accepted — connecting…" for the remaining 17 s of
        // `CONNECT_TIMEOUT_MS` — the exact "connecting with no error" state
        // that constant's own comment says made the four-peer join failure
        // unreportable. The deadline is the backstop for a connection that
        // never fails and never opens; this is the signal for one that fails.
        //
        // Reject before `_drop`, because `_drop` calls `peer.close()` and
        // re-enters this handler with state `closed`: settling first means the
        // rejection carries the state that actually failed. Both re-entrant
        // calls are no-ops — a settled promise ignores a second reject and
        // `_drop` returns on its own `peers.has` guard.
        failConnect(new Error('That player\'s connection failed before the game could start. '
          + 'Their network may be blocking it — ask them to try again, and see the connection '
          + 'note on this screen.'));
        this._drop(peer);
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);

    this.peers.set(id, peer);
    // The rejection handler is not decoration, and it becomes required the
    // moment `ready` can reject: this chain is created inside `createInvite`,
    // before any caller holds a promise, so a connection that fails while the
    // host is still waiting for a human to paste the answer would be an
    // unhandled rejection on a machine that has done nothing wrong. Same shape
    // and same reason as `ClientTransport.join`. The promise `accept` returns
    // still rejects for the caller that has one.
    ready.then((p) => this.onPeer?.(p), () => {});

    return {
      id,
      blob: encode({ v: 1, role: 'offer', id, sdp: pc.localDescription }),
      accept: async (answerBlob) => {
        const msg = decode(answerBlob.trim());
        if (msg.role !== 'answer' || msg.id !== id) throw new Error('Answer does not match this invite');
        await pc.setRemoteDescription(msg.sdp);
        // From here both ends are negotiating and nothing is waiting on a
        // person, so the wait gets a deadline. On expiry the peer leaves
        // through the ordinary path — `_drop`, hence `onPeerLeave`, hence the
        // host's log line — and the rejection is what finally reaches the
        // co-op panel's `catch` instead of it awaiting for ever.
        return withDeadline(
          ready,
          this._connectTimeoutMs(),
          'That player never finished connecting. Their network may be blocking it — '
          + 'ask them to try again, and see the connection note on this screen.',
        ).catch((err) => { this._drop(peer); throw err; });
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
    let failJoin = null;
    const ready = new Promise((resolve, reject) => {
      failJoin = reject;
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
        // Settle `connected` rather than leaving it pending for ever: on a
        // client whose channels never opened there is nothing else that can
        // ever settle it. A no-op once it has already resolved.
        //
        // Deliberately no *deadline* on this side, unlike the host's. The
        // client cannot tell "the host has not pasted my answer yet" from "the
        // connection is failing" — both look like `connecting` — so any timer
        // armed here races a human with a chat window and would refuse healthy
        // joins. The browser's own ICE failure is the honest signal, and this
        // is what makes it audible.
        failJoin(new Error('The connection to the host failed before the game could start.'));
        peer.close();
        this.onDisconnected?.();
      }
    };

    await pc.setRemoteDescription(msg.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc);

    // The second handler is not decoration: without it this internal chain is
    // an unhandled rejection whenever the join fails. The `connected` promise
    // the caller receives still rejects.
    ready.then((p) => this.onConnected?.(p), () => {});

    return {
      blob: encode({ v: 1, role: 'answer', id: msg.id, sdp: pc.localDescription }),
      connected: ready,
    };
  }
}
