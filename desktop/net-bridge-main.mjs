/**
 * The main-process half of the Conversation's Steam bridge (#128, shape (a)).
 *
 * `src/net/SteamTransport.js` wants `ISteamNetworkingSockets` synchronously, at
 * 60 Hz. Only the main process may hold the Binding, and `ipcRenderer` is
 * asynchronous, so the two halves split the interface along the only line that
 * works: **every call that returns nothing becomes a queued command, and every
 * call that returns something is answered from a renderer-side cache this file
 * keeps fresh.** Nothing the transport calls ever waits on an `invoke`.
 *
 * Measured before it was designed further, as the issue mandates:
 * `reviews/net-baseline/IPC-BRIDGE.md` — added p99 0.6-0.9 ms across three
 * 30 s runs at 3 peers / 60 Hz, against a 2 ms `state` envelope.
 *
 * ## Handles are proxies, and the parity says who minted them
 *
 * The renderer cannot be handed a real Steam connection handle, because it
 * mints handles *before* main has one: `connectP2P` returns synchronously into
 * game code that immediately builds a `SteamPeer` around the result. So the
 * renderer mints its own handle and this file maps it onto the real one when
 * the command lands. Inbound connections are the mirror image — main sees them
 * first — so main mints those. **Renderer handles are even, main's are odd**,
 * which makes a mix-up impossible rather than merely unlikely, and makes any
 * handle in a log say where it came from.
 *
 * ## Why a pump and not callbacks
 *
 * The transport reads Steam's state changes and inbound requests through the
 * Binding's *pull* accessors precisely so it never drives
 * `SteamAPI_RunCallbacks`; this file keeps that property. It polls the same
 * accessors on its own interval, drains every open connection's messages, and
 * pushes one batch per tick — one IPC, whatever arrived.
 *
 * Ordering inside that batch is load-bearing: requests, then state changes,
 * then messages. `SteamHostTransport._pump` accepts connections, turns state
 * changes into peers, and only then pumps each peer — a batch that delivered a
 * connected peer's first snapshot before the state change that created it
 * would drop the snapshot on the floor.
 *
 * Deliberately imports nothing from Electron: `push` and `sockets` are both
 * injected, so `tests/net-bridge.test.mjs` can run the whole contract through
 * this file in plain node.
 */

/** How many messages to lift off one connection per tick. */
const RECV_BATCH = 64;

/** The pump rate. The renderer produces at 60 Hz; draining slower would batch. */
export const PUMP_HZ = 60;

/**
 * @param {object} opts
 * @param {object} opts.sockets `steam.networkingSockets`, or the test fake.
 * @param {(payload: object) => void} opts.push hands one batch to the renderer.
 */
export function createNetBridgeMain({ sockets, push }) {
  const conns = new Map();      // proxy handle -> real connection handle
  const byReal = new Map();     // real connection handle -> proxy handle
  const listens = new Map();    // proxy handle -> real listen socket
  const listensByReal = new Map();
  let nextMainHandle = 1;       // odd: main mints inbound
  let timer = null;

  /** The proxy for a connection main has seen but the renderer has not. */
  const proxyFor = (real) => {
    let p = byReal.get(real);
    if (p === undefined) {
      p = nextMainHandle;
      nextMainHandle += 2;
      byReal.set(real, p);
      conns.set(p, real);
    }
    return p;
  };

  const forget = (proxy) => {
    const real = conns.get(proxy);
    if (real === undefined) return;
    conns.delete(proxy);
    byReal.delete(real);
  };

  /**
   * Run one batch of renderer commands, in order.
   *
   * Every op is wrapped: a Steam call that throws must not take the rest of the
   * frame's traffic with it, and the transport's own error handling is written
   * for a sockets layer that returns rather than one that explodes.
   */
  function apply(batch) {
    for (const cmd of batch ?? []) {
      try {
        switch (cmd.op) {
          case 'listen': {
            const real = sockets.createListenSocketP2P(cmd.port ?? 0);
            listens.set(cmd.h, real);
            listensByReal.set(real, cmd.h);
            break;
          }
          case 'closeListen': {
            const real = listens.get(cmd.h);
            if (real !== undefined) {
              listens.delete(cmd.h);
              listensByReal.delete(real);
              sockets.closeListenSocket(real);
            }
            break;
          }
          case 'connect': {
            const real = sockets.connectP2P(cmd.steamId, cmd.port ?? 0);
            conns.set(cmd.h, real);
            byReal.set(real, cmd.h);
            break;
          }
          case 'accept': {
            const real = conns.get(cmd.h);
            if (real !== undefined) sockets.acceptConnection(real);
            break;
          }
          case 'close': {
            const real = conns.get(cmd.h);
            forget(cmd.h);
            if (real !== undefined) sockets.closeConnection(real, cmd.reason ?? 0, cmd.debug ?? '', !!cmd.linger);
            break;
          }
          case 'send': {
            const real = conns.get(cmd.h);
            if (real === undefined) break;
            const bytes = cmd.data instanceof Uint8Array ? cmd.data : new Uint8Array(cmd.data);
            // `Buffer` where the runtime has it: the Binding declares
            // `Buffer | string` and koffi wants an address.
            const payload = globalThis.Buffer ? globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
            sockets.sendMessage(real, payload, cmd.flags ?? 0);
            break;
          }
          default: break;
        }
      } catch { /* see the doc comment: one bad op is not a bad frame */ }
    }
  }

  /** One sweep of Steam's queues, pushed to the renderer as a single batch. */
  function pump() {
    const requests = [];
    const changes = [];
    const messages = [];
    const statuses = [];

    try {
      for (const req of sockets.getPendingConnectionRequests?.() ?? []) {
        requests.push({
          connection: proxyFor(req.connection),
          listenSocket: listensByReal.get(req.listenSocket) ?? null,
          identityRemote: String(req.identityRemote ?? ''),
        });
      }
    } catch { /* a throwing accessor is a Steam that has gone away */ }

    try {
      for (const change of sockets.getPendingStateChanges?.() ?? []) {
        changes.push({
          connection: proxyFor(change.connection),
          newState: change.newState,
          info: { identityRemote: String(change.info?.identityRemote ?? '') },
        });
      }
    } catch { /* as above */ }

    for (const [proxy, real] of conns) {
      let msgs = null;
      try { msgs = sockets.receiveMessages(real, RECV_BATCH); } catch { msgs = null; }
      for (const m of msgs ?? []) {
        // Copied, not viewed: the Binding frees the native buffer when
        // `receiveMessages` returns, and this one still has an IPC hop to make.
        const src = m.data instanceof ArrayBuffer ? new Uint8Array(m.data) : new Uint8Array(m.data.buffer ?? m.data, m.data.byteOffset ?? 0, m.data.byteLength ?? m.data.length);
        messages.push({ conn: proxy, data: Uint8Array.from(src) });
      }
      // `drained()` is synchronous in the renderer, so the answer has to be
      // there before it is asked. One tick stale at worst, and its only caller
      // polls across frames waiting for a reliable queue to empty.
      let status = null;
      try { status = sockets.getConnectionRealTimeStatus(real); } catch { status = null; }
      if (status) {
        statuses.push({
          conn: proxy,
          state: status.state,
          pendingReliable: status.pendingReliable | 0,
          pendingUnreliable: status.pendingUnreliable | 0,
          sentUnackedReliable: status.sentUnackedReliable | 0,
        });
      }
    }

    if (requests.length || changes.length || messages.length || statuses.length) {
      push({ requests, changes, messages, statuses });
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(pump, 1000 / PUMP_HZ);
    timer.unref?.();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    for (const [proxy, real] of conns) {
      try { sockets.closeConnection(real, 0, 'shell closed', false); } catch { /* already gone */ }
      byReal.delete(real);
      conns.delete(proxy);
    }
    for (const [proxy, real] of listens) {
      try { sockets.closeListenSocket(real); } catch { /* already gone */ }
      listensByReal.delete(real);
      listens.delete(proxy);
    }
  }

  /**
   * The real connection handle behind a proxy, or undefined.
   *
   * A test seam of the same kind as `initSteam`'s `deps.load`: the conformance
   * harness impairs and inspects connections through the fake sockets layer,
   * which knows only real handles, while the transport under test holds only
   * proxies. Nothing in `desktop/` or `src/` calls it.
   */
  const realFor = (proxy) => conns.get(proxy);

  return { apply, pump, start, stop, realFor };
}
