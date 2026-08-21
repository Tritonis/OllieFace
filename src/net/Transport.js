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
 * ICE is gathered non-trickle by default — we wait for gathering to complete
 * before handing out the blob — specifically so manual signalling is a single
 * copy/paste rather than an ongoing candidate exchange. That wait costs up to
 * `waitForIce`'s 4 s cap on each side of a join and is the measured cause of
 * this branch's 0.6-10.9 s bimodal join spread. It cannot be shortened on the
 * manual path: a blob a human is about to paste has no way to carry a candidate
 * that arrives afterwards, and trying to leave early was refuted by measurement
 * (reviews/audit-fixes/ice-quiescence-refuted.md).
 *
 * The room-code path has a live WebSocket relay, so it can carry candidates.
 * Passing `{ trickle: true }` (or setting `.trickle` on the transport, which is
 * how `Lobby` reaches it through `NetHost`/`NetClient`) skips the gathering wait
 * entirely and hands the exchange over to `onIceCandidate`/`addIceCandidate`.
 * Nothing on the manual path passes it, so nothing on the manual path changed.
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

// How often an unattended Peer drains its own inbound flight queue. Finer than
// a frame, because the number being measured is the configured delay and not
// the frame it happens to land in.
const SIM_PUMP_MS = 4;

// Caps the `?netlag=` flight queue. Arrivals that reach `_simRecv` are driven
// by the data channel, which keeps delivering whatever the page is doing, so a
// stalled render/update loop could otherwise grow this without bound.
// Too low (below the packets a real probe legitimately has in flight at the
// configured lag) would drop traffic a real network of that latency would
// have delivered, contaminating the exact measurement this rig exists to
// produce; too high defeats the point of capping a stall at all.
//
// The eviction policy is `state`-only, and that is not a nicety. This queue
// is shared by both channels — `_simRecv` is reached from both `_wire`d
// `onmessage` handlers — so an unqualified `shift()` here could discard a held
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

// How long `createInvite` itself may take before it gives up on minting.
//
// Nothing in the mint waits on a person: it is `createOffer`,
// `setLocalDescription`, and — on the manual path — `waitForIce`. So unlike the
// connect deadline above there is no human leg to be generous about, and the
// only question is how much room the machine work needs.
//
// It MUST sit above `waitForIce`'s own `capMs` of 4000, or that cap becomes dead
// code: a mint cancelled at 4 s or less could never reach the point where
// gathering has legitimately used its full allowance and the offer is about to
// be handed over complete. 10 s is that 4 s plus room for a slow `createOffer`
// on a machine gathering interfaces, and still an order of magnitude below "the
// rest of the session", which is what an unbounded mint costs the
// join-amplification ceiling in `Lobby` — every mint in flight holds a claim
// against it, and a claim is only as bounded as the promise it is paired to.
const MINT_TIMEOUT_MS = 10000;

// Carried on the error rather than only in its text, so a caller — and the log
// line below — can tell "the mint timed out" from a mint that rejected on its
// own (a full lobby, a browser that refused the peer connection). Message text
// is a UI string and can be reworded; this is the wire.
const MINT_TIMEOUT_NAME = 'InviteMintTimeout';

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
    this._simTimer = null;
  }

  _wire(ch, label) {
    ch.binaryType = 'arraybuffer';
    // The rig, if armed, holds this arrival until it is due; `_simRecv` returns
    // false whenever it does not consume the packet, so an unarmed Peer runs the
    // original statement below and nothing else.
    ch.onmessage = (e) => {
      if (this._sim && this._simRecv(label, e.data)) return;
      this.onMessage?.(e.data, label, this);
    };
    ch.onclose = () => this.close();
    ch.onerror = () => {};
    return ch;
  }

  /**
   * Arm the latency rig. Called only when `netSim().on` — a Peer that is not
   * armed has `_sim === null`, so every send and every arrival takes the
   * original branch and the shipped path costs one null check.
   *
   * ## The delay is on the *receive* side, and that is the whole point
   *
   * This rig used to hold outbound packets in a queue drained by `pumpSim()`
   * once per rendered frame. That is not a network: it makes the wire wait on
   * the *sender's* frame loop. Measured cost of the difference — a joining
   * client's HELLO queued at 1542 ms, the host's WELCOME landing at 1580 ms,
   * and the client's main thread then blocked for 3.9 s rebuilding the stage,
   * so the HELLO did not leave until 5486 ms and the host had already refused
   * the peer on its 2.5 s identity deadline. No co-op join could form at any
   * configured delay of one frame or more, and no timer could have fixed it:
   * a `setInterval` callback is a main-thread task and does not run during a
   * synchronous block either.
   *
   * A real network takes the packet the moment `send()` is called and delivers
   * it one flight time later, whatever the sender is doing. So sends are now
   * immediate and unconditional, and the flight time is simulated where it
   * actually lands: at the receiver, in `_wire`'s `onmessage`. A blocked
   * receiver then delivers late — which is exactly what a blocked receiver
   * does in reality, and is now the only stall the rig can express.
   *
   * The contract is otherwise unchanged, just inbound: `lagMs` plus a uniform
   * `jitterMs`, loss on the unreliable `state` channel only, every surviving
   * packet delivered exactly once, release strictly in arrival order, and
   * `MAX_SIM_QUEUE` bounding the backlog by evicting the oldest `state` entry
   * rather than ever dropping a reliable one.
   *
   * `clock` returns seconds, monotonic, and is optional: passing one means
   * "this caller drives time and will call `pumpSim()` itself", which is what
   * the tests do. Omitting it — the browser path, both call sites below — takes
   * the real clock and a self-pump, so delivery does not depend on any
   * particular caller remembering to pump.
   */
  installSim(sim, clock) {
    this._sim = sim;
    this._simDriven = !clock;
    this._simClock = clock ?? (() => performance.now() / 1000);
    this._simQueue = [];
    this._simOverflowWarned = false;
    if (this._simDriven) {
      // Finer than a frame so the configured delay is what is measured rather
      // than the frame it lands in. `pumpSim` returns on an empty queue, so an
      // idle peer pays a null check per tick. Cleared in `close()`.
      this._simTimer = setInterval(() => this.pumpSim(), SIM_PUMP_MS);
      this._simTimer?.unref?.();   // node: never hold the process open
    }
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

  /**
   * Deliver anything whose flight time has elapsed. Inert when not armed.
   *
   * Called from `NetHost.update` / `NetClient.update` on every frame, and — on
   * the browser path, where `installSim` was given no clock — from this Peer's
   * own interval as well. Both are safe: the queue is spliced, so a packet is
   * delivered exactly once regardless of how many callers pump.
   */
  pumpSim() {
    const q = this._simQueue;
    if (!q || q.length === 0) return;
    const now = this._simClock();
    let i = 0;
    // The queue is append-ordered and delays are drawn per packet, so a later
    // packet can come due first under jitter. Releasing strictly in arrival
    // order preserves the ordering the channel would have had; reordering here
    // would be simulating a different network than the flag asks for.
    while (i < q.length && q[i].due <= now) i++;
    if (i === 0) return;
    const due = q.splice(0, i);
    for (const p of due) this.onMessage?.(p.data, p.ch, this);
  }

  /**
   * Returns true when the rig consumed the arrival (dropped in flight, or held
   * until due). False means "not for me" and the caller delivers it as usual.
   *
   * Loss is `state`-only: the reliable channel is `{ ordered: true }` and the
   * rig's charter is that it never drops what the transport guarantees. A lost
   * `state` packet is simply never delivered, which is what loss is.
   */
  _simRecv(label, data) {
    const sim = this._sim;
    if (!sim) return false;
    if (label === 'state' && sim.lossPct > 0 && Math.random() * 100 < sim.lossPct) return true;
    const delay = (sim.lagMs + (sim.jitterMs ? Math.random() * sim.jitterMs : 0)) / 1000;
    if (delay <= 0) return false;
    const q = this._simQueue;
    if (q.length >= MAX_SIM_QUEUE) this._simEvict();
    q.push({ ch: label, data, due: this._simClock() + delay });
    return true;
  }

  sendState(bytes) {
    if (this.state?.readyState === 'open') {
      // Drop rather than queue: a backed-up unreliable channel means we are
      // already behind, and stale snapshots are worse than none.
      if (this.state.bufferedAmount > MAX_STATE_BUFFERED) return;
      this.state.send(bytes);
    }
  }

  sendEvent(bytes) {
    if (this.events?.readyState === 'open') this.events.send(bytes);
  }

  /**
   * True once the reliable channel has nothing left to deliver: closed or
   * never opened, or open with an empty send buffer. Transport-neutral so a
   * caller (the flush-then-close path in NetHost) never has to read the
   * channel's raw internals itself.
   */
  drained() {
    const ch = this.events;
    return !ch || ch.readyState !== 'open' || ch.bufferedAmount === 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._simTimer) { clearInterval(this._simTimer); this._simTimer = null; }
    try { this.pc.close(); } catch {}
    this.onClose?.(this);
  }
}

export function waitForIce(pc, capMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    // Some networks never reach 'complete' (no reflexive candidate). Cap the
    // wait so a join doesn't hang forever on a bad network.
    //
    // Do not "optimize" this into an early exit once candidates go quiet: that
    // was tried, and it turned a 4/4-success four-player probe into 0/2 with
    // 10-14 s joins. Chromium publishes host candidates as mDNS names that a
    // remote peer may not resolve, so the blob is useless until the reflexive
    // (STUN) candidate arrives — 1-3 s on a good day, and the last thing
    // gathering produces. Shipping early forces connect-retry churn (one
    // captured session burned ~30 peer ids). The cap is the floor a blob can
    // be trusted at, not slack to be clawed back; the evidence is
    // reviews/audit-fixes/ice-quiescence-refuted.md.
    const timer = setTimeout(done, capMs);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// Both candidate buffers below hold remote input off a relay we do not control,
// and neither has a natural ceiling. A healthy connection gathers well under
// twenty candidates per side, so this is far above any real exchange while
// still refusing to grow without bound if a peer or a relay misbehaves.
const MAX_BUFFERED_CANDIDATES = 64;

/**
 * The trickle half of a connection: candidates out, candidates in.
 *
 * Split out of both transports because both ends need the identical pair of
 * buffers, for two races that are unavoidable rather than defensive:
 *
 *  · *outbound* — `setLocalDescription` starts gathering, and candidates begin
 *    arriving immediately. The caller that will relay them (`Lobby`) does not
 *    exist as a sink until the invite has been created and matched to a joiner,
 *    which is strictly later. Candidates gathered in that gap are held and
 *    replayed to the first sink registered.
 *
 *  · *inbound* — the whole point of trickling is that the SDP ships before
 *    gathering finishes, so the peer's candidates are in flight while the
 *    *answer* still is. `addIceCandidate` before a remote description is an
 *    error in every browser, so anything arriving early is held until the
 *    description that gives it meaning has been applied.
 *
 * Constructed unattached so `ClientTransport` can accept candidates that arrive
 * before `join()` has built a peer connection at all — over one socket, the
 * host's offer and the host's first candidates are microseconds apart.
 */
class TrickleIce {
  constructor() {
    this._pc = null;
    this._sink = null;
    this._out = [];
    this._in = [];
    this._remoteSet = false;
    this._dead = false;
  }

  attach(pc) {
    this._pc = pc;
    pc.onicecandidate = (e) => {
      // `null` is the end-of-gathering sentinel, not a candidate. Relaying it
      // would have the far end call `addIceCandidate(null)`, which in WebRTC
      // means "no more candidates" — ending the remote's checking early on a
      // connection whose useful reflexive candidate may not have arrived yet.
      const c = e?.candidate;
      if (!c) return;
      const plain = typeof c.toJSON === 'function' ? c.toJSON() : c;
      if (this._sink) this._sink(plain);
      else if (this._out.length < MAX_BUFFERED_CANDIDATES) this._out.push(plain);
    };
  }

  /** Stop accepting anything. Used when the caller turns out not to be trickling. */
  discard() {
    this._dead = true;
    this._out.length = 0;
    this._in.length = 0;
  }

  onCandidate(cb) {
    if (this._dead) return;
    this._sink = cb;
    for (const c of this._out.splice(0)) cb(c);
  }

  /** The remote description just landed; anything held becomes applicable. */
  remoteReady() {
    if (this._dead) return;
    this._remoteSet = true;
    for (const c of this._in.splice(0)) this._apply(c);
  }

  add(candidate) {
    if (this._dead || !candidate) return;
    if (this._remoteSet) this._apply(candidate);
    else if (this._in.length < MAX_BUFFERED_CANDIDATES) this._in.push(candidate);
  }

  _apply(candidate) {
    // A stale, duplicate or malformed candidate is ordinary traffic on a relay
    // and the browser rejects the promise for it. Nothing is awaiting this, so
    // an unswallowed rejection would be an unhandled rejection on a machine
    // that has done nothing wrong — and would say nothing useful if it were
    // reported, because the connection carries on with the candidates that did
    // parse.
    try { this._pc?.addIceCandidate(candidate)?.catch?.(() => {}); } catch { /* sync throw, same story */ }
  }
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
    // The default for every invite this transport mints, because `Lobby` reaches
    // `createInvite` through `NetHost.createInvite()` — which owns the lobby-full
    // check and forwards no arguments. A relay session is trickle or not for its
    // whole life, so the transport is the right grain for the switch; the
    // per-call option remains for tests and direct callers.
    this.trickle = false;
  }

  /**
   * The connect deadline in milliseconds. A seam so the gate is testable
   * without a 20 s test, in the same shape and for the same reason as
   * `NetHost._now()`.
   */
  _connectTimeoutMs() { return CONNECT_TIMEOUT_MS; }

  /** The mint deadline, as a seam. Same shape and reason as `_connectTimeoutMs`. */
  _mintTimeoutMs() { return MINT_TIMEOUT_MS; }

  /**
   * Mint an invite, or reject trying.
   *
   * The bound is the whole point of this wrapper: `_mintInvite` awaits browser
   * calls, and a browser call that hangs rather than rejecting leaves the
   * promise pending for ever. Every caller of this method pairs a claim against
   * its own ceiling with the promise's settlement — `Lobby` counts mints in
   * flight against `MAX_PENDING_INVITES` and releases in a `finally` — and a
   * `finally` on a promise that never settles never runs. So the counter is
   * only as bounded as this promise is, and this is where that bound has to
   * live: no amount of work in `Lobby` can bound a promise it does not own.
   *
   * It rejects rather than resolving with nothing, because rejection is what
   * runs those `finally`s and what the callers already handle — a mint that
   * throws is an ordinary, already-tested outcome ('Lobby is full'), and a
   * resolve-with-null would be a new shape every caller would have to learn.
   *
   * The half-built connection is given up here too. On timeout the peer may or
   * may not have reached `this.peers` — that write happens after the ICE wait —
   * so both are covered: `cancelInvite` if it landed, a direct close if not.
   * Otherwise a hung mint would swap an unbounded counter for an unbounded set
   * of live RTCPeerConnections, which is the worse of the two.
   */
  createInvite(opts = {}) {
    // Not `withDeadline`: this one owns the error it throws (so the failure is
    // named, not just worded) and has cleanup to do when it fires.
    const held = {};
    let timer = null;
    return new Promise((resolve, reject) => {
      const ms = this._mintTimeoutMs();
      timer = setTimeout(() => {
        const err = new Error(
          'That invite could not be created — your browser never finished setting '
          + 'up the connection. Try again, and see the connection note on this screen.'
        );
        err.name = MINT_TIMEOUT_NAME;
        console.warn(`[net] ${MINT_TIMEOUT_NAME}: createInvite got no answer from the browser `
          + `within ${ms}ms; giving up the half-built connection and releasing the invite slot.`);
        held.abandoned = true;
        if (held.peer && !this.cancelInvite(held.peer.id)) held.peer.close();
        reject(err);
      }, ms);
      this._mintInvite(opts, held).then(resolve, reject);
    }).finally(() => clearTimeout(timer));
  }

  async _mintInvite({ trickle = this.trickle } = {}, held = {}) {
    const id = this._nextId++;
    const pc = new RTCPeerConnection(rtcConfig());
    const ice = trickle ? new TrickleIce() : null;
    ice?.attach(pc);
    const peer = new Peer(pc, id);
    // Published to the caller's deadline before the first await, so a timeout
    // has something to close rather than leaking whatever this got as far as.
    held.peer = peer;
    const sim = netSim();
    if (sim.on) peer.installSim(sim);

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
    // The swallow that used to live on line ~490's `ready.then` has to be here
    // instead, because the mint deadline can close this peer *before* that line
    // is reached: closing re-enters `onconnectionstatechange`, which rejects
    // `ready`, and a rejection with no handler yet is an unhandled rejection on
    // a machine that has done nothing wrong. Attaching one here is harmless to
    // the later chain — a promise takes any number of handlers.
    ready.catch(() => {});

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
    // The wait is the whole cost being removed here. Under trickle the offer is
    // shipped candidate-free the instant it exists and the candidates follow it
    // over the relay; under manual signalling the blob must be complete, so the
    // call is byte-identical to what it has always been.
    if (!trickle) await waitForIce(pc);

    // The deadline fired while the browser was working, and then the browser
    // came back. Its answer is no longer wanted: the caller has already been
    // told this mint failed and has released whatever it was holding, so
    // registering the peer now would put a connection nobody will ever close
    // into `peers`. It was closed when the deadline fired; say so and stop.
    if (held.abandoned) throw new Error('Invite mint was abandoned after its deadline');

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
      // The two halves of the candidate exchange, for a caller that has a relay
      // to carry them. Inert on a non-trickle invite rather than absent, so the
      // relay path can wire them unconditionally and let the negotiated mode
      // decide whether anything flows — a missing method would make "this relay
      // is too old" a TypeError instead of a slower join.
      onIceCandidate: (cb) => ice?.onCandidate(cb),
      addIceCandidate: (candidate) => ice?.add(candidate),
      accept: async (answerBlob) => {
        const msg = decode(answerBlob.trim());
        if (msg.role !== 'answer' || msg.id !== id) throw new Error('Answer does not match this invite');
        await pc.setRemoteDescription(msg.sdp);
        ice?.remoteReady();
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

  /**
   * Give up an invite nobody answered: close its connection and forget it.
   *
   * `peers` is where an invite's RTCPeerConnection actually lives, from the
   * moment `createInvite` returns until somebody drops it — so a caller that
   * bounds its own map of invites and stops there has bounded a map and leaked
   * every connection in it. This is the other end of that bound, and it is why
   * the ceiling in `Lobby` reaches through to here rather than deleting a
   * reference and hoping.
   *
   * Delete BEFORE `close()`, exactly as `_drop` does: `pc.close()` re-enters
   * `onconnectionstatechange` with `closed`, which calls `_drop`, which then
   * returns on its own `peers.has` guard.
   *
   * Deliberately NOT `_drop`: that fires `onPeerLeave`, and `NetHost`'s handler
   * for a peer whose channels never opened writes `[net] peer N dropped before
   * its channels opened` — true of a connection that failed, and wrong for one
   * this host chose to give up. Returns whether there was anything to give up.
   */
  cancelInvite(id) {
    const peer = this.peers.get(id);
    if (!peer) return false;
    this.peers.delete(id);
    peer.close();
    return true;
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
    // As on the host: `Lobby` reaches `join` through `NetClient.join`, which
    // forwards no options.
    this.trickle = false;
    // Built before `join`, because the relay delivers the host's offer and the
    // host's first candidates over one socket and `join` is async — a candidate
    // can arrive before there is a peer connection to give it to.
    this._ice = new TrickleIce();
  }

  /** Relay this connection's local candidates to `cb`. One transport, one peer. */
  onIceCandidate(cb) { this._ice.onCandidate(cb); }

  /** Apply a candidate from the host, buffering it if the answer is not out yet. */
  addIceCandidate(candidate) { this._ice.add(candidate); }

  async join(inviteBlob, { trickle = this.trickle } = {}) {
    const msg = decode(inviteBlob.trim());
    if (msg.role !== 'offer') throw new Error('That is not a host invite code');

    const pc = new RTCPeerConnection(rtcConfig());
    if (trickle) this._ice.attach(pc); else this._ice.discard();
    const peer = new Peer(pc, msg.id);
    const sim = netSim();
    if (sim.on) peer.installSim(sim);
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
    this._ice.remoteReady();
    await pc.setLocalDescription(await pc.createAnswer());
    // See `HostTransport.createInvite`: the answer ships candidate-free under
    // trickle and unchanged under manual signalling.
    if (!trickle) await waitForIce(pc);

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
