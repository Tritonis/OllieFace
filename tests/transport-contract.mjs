/**
 * The transport contract: one suite, run against every transport we ship.
 *
 * Not a test file — `tests/transport-conformance.test.mjs` runs it against the
 * WebRTC loopback adapter today, and the Steam transport (#55) is expected to
 * pass the same assertions without any of them being edited. That "without being
 * edited" is the whole design constraint: the transport arrives as a parameter,
 * and nothing below imports `Transport.js`.
 *
 * ## Why this exists
 *
 * It replaces the half of `npm run probe:coop` that survives the WebRTC
 * deletion. `probe:coop` proved two separable things — that a Conversation
 * carries the game correctly, and that an Introduction ends in two peers meeting
 * — and only the first is transport-independent. `docs/adr/0002` splits them;
 * this is arm A. Arm C (#13, two machines) owns the second, because no single
 * box can hold two Steam identities.
 *
 * `gate:mp1` does not cover this. It measures gameplay equivalence and never
 * opens a socket.
 *
 * ## The contract, and why it is enumerated rather than counted
 *
 * `CONTRACT` below is the machine-readable form of `docs/STEAM.md` section 8.5.
 * It exists because section 3 of that document claimed for a long time that
 * `NetHost` and `NetClient` touch a peer through "exactly three methods", and
 * that was wrong in two ways that would each have shipped a broken Steam
 * transport: `NetHost.js:532` calls `pumpSim()` unconditionally every frame, and
 * `NetHost.js:404-405` used to read `readyState`/`bufferedAmount` off the peer's
 * raw `events` channel; that leak is closed as of the transport-neutral
 * `drained()` predicate below. A conformance suite built from the count would
 * have passed while leaving both holes.
 *
 * So the last section of this suite does not test behaviour at all. It builds a
 * peer carrying *exactly* the enumerated members and nothing else, drives the
 * real host loop over it, and fails if the host reaches for anything absent.
 * That is the assertion that keeps this file honest as `NetHost` changes.
 */
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { MSG, Writer, Reader, EKIND, ESTATE, PROTOCOL_VERSION } from '../src/net/Protocol.js';

/** `docs/STEAM.md` section 8.5, as data. */
export const CONTRACT = {
  peer: [
    'id', 'sendState', 'sendEvent', 'onMessage', 'onClose', 'pumpSim', 'close', 'drained',
  ],
  hostTransport: ['onPeer', 'onPeerLeave', 'peers', 'broadcastEvent', 'close'],
};

const SURVIVOR = 'anvil';

// ---------------------------------------------------------------- fixtures
/**
 * The smallest `ctx` `NetHost` will run on, plus a recorder for everything it
 * emits. Shaped from `tests/nethost-hello-gate.test.mjs:17-21`, widened with the
 * pawn hooks `_onPeer` and `_onPeerLeave` call.
 */
function hostCtx() {
  const emitted = [];
  const despawned = [];
  const ctx = {
    authority: true, netRole: 'host', time: 12.5, seed: 4242, paused: false,
    events: { on() {}, emit: (n, p) => emitted.push([n, p]) },
    combat: { entities: [] },
    spawnRemotePlayer: (id) => {
      const pawn = {
        netId: 0, isPlayer: true, alive: true, netState: ESTATE.ALIVE,
        position: { x: id, y: 0, z: -id }, yaw: 0.25,
        health: 100, maxHealth: 100, shield: 0, survivorId: null,
        setSurvivor(s) { this.survivorId = s; },
      };
      ctx.combat.entities.push(pawn);
      return pawn;
    },
    despawnRemotePlayer: (pawn) => {
      despawned.push(pawn);
      const i = ctx.combat.entities.indexOf(pawn);
      if (i >= 0) ctx.combat.entities.splice(i, 1);
    },
  };
  ctx.emitted = emitted;
  ctx.despawned = despawned;
  return ctx;
}

function clientCtx() {
  const emitted = [];
  const ctx = {
    events: { on() {}, emit: (n, p) => emitted.push([n, p]) },
    player: {
      survivorId: SURVIVOR, netId: 0, health: 100, maxHealth: 100, shield: 0,
      sinceDamage: 99, position: { x: 0, y: 0, z: 0 },
      resetCommandEpoch() {}, setRenderOffset() {},
    },
  };
  ctx.emitted = emitted;
  return ctx;
}

const emittedNames = (ctx) => ctx.emitted.map(([n]) => n);
const lastEmit = (ctx, name) => [...ctx.emitted].reverse().find(([n]) => n === name)?.[1];

/**
 * Poll `predicate` on a real timer until it is true or `timeoutMs` elapses.
 * Used in place of a fixed sleep for real-timer assertions ("this eventually
 * becomes true") so the suite absorbs scheduler jitter on a loaded box without
 * changing what the assertion actually verifies: a predicate that genuinely
 * never becomes true still returns false once `timeoutMs` is up.
 */
async function pollUntil(predicate, { intervalMs = 20, timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ============================================================================
export async function runTransportContract(adapter, ok) {
  const t = (msg) => `[${adapter.name}] ${msg}`;

  /** A host with the adapter's transport in place of the one it builds itself. */
  function makeHost() {
    const host = new NetHost({ maxPlayers: 4, transport: adapter.createHostTransport() });
    const ctx = hostCtx();
    host.init(ctx);
    // A fixed clock: every age gate in `NetHost` reads through this seam, and a
    // suite whose HELLO deadline depends on how fast the machine ran is a suite
    // that fails on somebody else's laptop.
    let now = 0;
    host._now = () => now;
    host.setNow = (v) => { now = v; };
    return { host, ctx };
  }

  function makeClient() {
    const client = new NetClient();
    const ctx = clientCtx();
    client.init(ctx);
    return { client, ctx };
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — a peer arrives and the host admits it`);
  // ==========================================================================
  {
    const { host, ctx } = makeHost();
    const wire = adapter.connectPeer(host, 1);

    ok(host.clients.size === 1, t('onPeer put exactly one client in the host'));
    ok(host.clients.get(1)?.pawn != null, t('the host spawned a pawn for it'));
    ok(emittedNames(ctx).includes('netPlayerJoined'), t('and announced netPlayerJoined'));
    ok(host.playerCount === 2, t(`playerCount counts the host plus the peer (got ${host.playerCount})`));

    // WELCOME is written into the reliable channel by `_onPeer`, before any
    // flush — the host speaks first, and that ordering is part of the contract.
    const { client, ctx: cctx } = makeClient();
    client.attach(wire.clientPeer);
    adapter.flush(wire);

    ok(client.myPeerId === 1, t(`the client learned its peer id from WELCOME (got ${client.myPeerId})`));
    ok(client.myNetId > 0, t(`and its own net id (got ${client.myNetId})`));
    ok(emittedNames(cctx).includes('netWelcome'), t('and emitted netWelcome'));
    ok(lastEmit(cctx, 'netWelcome')?.seed === 4242, t("carrying the host's seed"));

    // The client's HELLO went out inside `attach`; one more flush lands it.
    adapter.flush(wire);
    ok(host.clients.get(1)?.helloSeen === true, t('the HELLO reached the host'));
    ok(host.clients.get(1)?.survivorId === SURVIVOR,
      t(`and re-stated the pawn to the joiner's survivor (got ${host.clients.get(1)?.survivorId})`));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — snapshots flow, and the client tracks them`);
  // ==========================================================================
  {
    const { host, ctx } = makeHost();
    const wire = adapter.connectPeer(host, 1);
    const { client } = makeClient();
    client.attach(wire.clientPeer);
    adapter.flush(wire);   // WELCOME
    adapter.flush(wire);   // HELLO

    // Two snapshots a tick apart, so the buffer has something to interpolate
    // between rather than a single sample it can only hold.
    const pawn = host.clients.get(1).pawn;
    host.tick = 10;
    host._broadcastSnapshot(ctx);
    pawn.position.x += 4;
    host.tick = 11;
    host._broadcastSnapshot(ctx);
    adapter.flush(wire);

    const ids = client.buffer.liveIds();
    ok(ids != null && ids.size > 0, t(`the client's snapshot buffer has live entities (got ${ids?.size ?? 0})`));
    ok(ids?.has(client.myNetId), t('including the one WELCOME named as its own'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — reliable events: exactly once, in send order`);
  // ==========================================================================
  {
    const { host } = makeHost();
    const wire = adapter.connectPeer(host, 1);

    const seen = [];
    wire.clientPeer.onMessage = (data, label) => {
      if (label !== 'events') return;
      const r = new Reader(data);
      if (r.u8() !== MSG.EVENT) return;
      seen.push(r.str());
    };

    for (let i = 0; i < 25; i++) host._forward(`evt${i}`, { i });
    adapter.flush(wire);

    ok(seen.length === 25, t(`every reliable event arrived exactly once (got ${seen.length})`));
    ok(seen.every((n, i) => n === `evt${i}`), t('and in send order'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — ...and still exactly once, in order, under impairment`);
  // ==========================================================================
  //
  // The previous section proves the channel. This one proves the channel plus
  // the delay rig, which is where ordering actually gets interesting: each
  // packet draws its own jitter, so a later one can come due first, and the
  // queue is what must refuse to reorder. It is also the only place `pumpSim`
  // does real work rather than being a no-op the host calls out of habit.
  {
    const { host } = makeHost();
    const wire = adapter.connectPeer(host, 1);
    const clock = adapter.impair(wire.clientPeer, { lagMs: 20, jitterMs: 80, lossPct: 0 });

    const seen = [];
    wire.clientPeer.onMessage = (data, label) => {
      if (label !== 'events') return;
      const r = new Reader(data);
      if (r.u8() !== MSG.EVENT) return;
      seen.push(r.str());
    };

    // A fixed pseudo-random sequence, so a failure here is reproducible rather
    // than a story about one unlucky run. Same device as
    // `tests/net-loopback.test.mjs:267-282`.
    const realRandom = Math.random;
    let seedv = 987654321;
    Math.random = () => { seedv = (seedv * 1103515245 + 12345) & 0x7fffffff; return seedv / 0x7fffffff; };
    try {
      for (let i = 0; i < 25; i++) host._forward(`evt${i}`, { i });
      adapter.flush(wire);
    } finally {
      Math.random = realRandom;
    }

    ok(seen.length === 0, t(`nothing arrived before its flight time (got ${seen.length})`));

    // Step past the worst case (lag + jitter = 100 ms), pumping along the way.
    for (clock.t = 0; clock.t <= 0.2; clock.t += 0.01) wire.clientPeer.pumpSim();
    clock.t = 1;
    wire.clientPeer.pumpSim();

    ok(seen.length === 25, t(`every reliable event still arrived exactly once (got ${seen.length})`));
    ok(seen.every((n, i) => n === `evt${i}`),
      t(`and still in send order despite per-packet jitter (got ${seen.slice(0, 4).join(',')}...)`));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — the unreliable channel may drop, and never reorders`);
  // ==========================================================================
  {
    const { host, ctx } = makeHost();
    const wire = adapter.connectPeer(host, 1);
    const { client } = makeClient();
    client.attach(wire.clientPeer);
    adapter.flush(wire);
    adapter.flush(wire);

    const ticks = [];
    const realIngest = client.buffer.ingest.bind(client.buffer);
    client.buffer.ingest = (r, when) => {
      // Peek the tick without consuming it: `ingest` reads from the same Reader.
      const at = r.off;
      const tick = r.view.getUint32(at, true);
      ticks.push(tick);
      return realIngest(r, when);
    };

    for (let n = 0; n < 6; n++) {
      host.tick = 100 + n;
      host._broadcastSnapshot(ctx);
    }
    // Lose the second and fifth snapshot of this pass. Stated, not drawn — a
    // random draw here would make a failure unreproducible.
    adapter.flush(wire, { lose: (i) => i === 1 || i === 4 });

    ok(ticks.length === 4, t(`the two lost snapshots did not arrive (got ${ticks.length} of 6)`));
    ok(ticks.every((v, i) => i === 0 || v > ticks[i - 1]),
      t(`what did arrive was strictly in order (got ${ticks.join(',')})`));
    ok(client.connected === true, t('and loss on the unreliable channel did not disconnect anyone'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — a peer leaves, and both ends notice once`);
  // ==========================================================================
  {
    const { host, ctx } = makeHost();
    const wire = adapter.connectPeer(host, 1);
    const { client, ctx: cctx } = makeClient();
    client.attach(wire.clientPeer);
    adapter.flush(wire);
    adapter.flush(wire);

    const pawn = host.clients.get(1).pawn;

    // A clean leave must not look like a failure in the log. `NetHost` wires
    // *both* `peer.onClose` and the transport's `onPeerLeave` to the same
    // handler — correctly, since either can fire without the other — so a drop
    // that fires both reaches it twice. The second pass finds no client record
    // and used to warn "dropped before its channels opened", which is the
    // diagnostic for a peer that never joined, printed for one that just did.
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      host.transport._drop(wire.hostPeer);
    } finally {
      console.warn = realWarn;
    }
    ok(warned.length === 0, t(`a clean leave warned about nothing (got: ${warned.join(' | ') || 'nothing'})`));

    ok(host.clients.size === 0, t('the host released its client record'));
    ok(ctx.despawned.includes(pawn), t('and despawned the pawn'));
    ok(emittedNames(ctx).filter((n) => n === 'netPlayerLeft').length === 1,
      t('netPlayerLeft fired exactly once'));

    // The host's `_drop` closed its own peer; the far end learns through its own
    // channel close. Both `peer.onClose` and the transport's `onDisconnected`
    // route to `_reportDisconnect`, which is latched — so this is also the
    // assertion that it cannot report twice.
    wire.clientPeer.close();
    wire.clientPeer.close();
    ok(client.connected === false, t('the client noticed it is no longer connected'));
    ok(emittedNames(cctx).filter((n) => n === 'netDisconnected').length === 1,
      t('and said so exactly once, however many times it is closed'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — close() on the transport takes every peer with it`);
  // ==========================================================================
  {
    const { host, ctx } = makeHost();
    adapter.connectPeer(host, 1);
    adapter.connectPeer(host, 2);
    ok(host.clients.size === 2, t('two peers connected'));

    host.close();

    ok(host.transport.peers.size === 0, t('transport.close() emptied peers'));
    ok(host.clients.size === 0, t('and every client record went with them'));
    ok(emittedNames(ctx).filter((n) => n === 'netPlayerLeft').length === 2,
      t('with one netPlayerLeft each'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — a refusal is flushed before the door shuts`);
  // ==========================================================================
  {
    const { host } = makeHost();
    const wire = adapter.connectPeer(host, 1);

    const refusals = [];
    wire.clientPeer.onMessage = (data, label) => {
      if (label !== 'events') return;
      const r = new Reader(data);
      if (r.u8() === MSG.REFUSE) refusals.push(true);
    };

    // A peer that never sends a HELLO, well past the deadline. This is the path
    // through `_refuse` -> `_closeWhenFlushed`, which is the one place the host
    // reads `readyState`/`bufferedAmount` off the raw channel.
    host.setNow(99);
    host._checkHelloDeadlines();
    adapter.flush(wire);

    ok(refusals.length === 1, t(`the refusal reached the peer before it was closed (got ${refusals.length})`));
    ok(host.clients.size === 0, t('and the host let it go'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — a refusal waits for a backed-up channel, but not for ever`);
  // ==========================================================================
  //
  // `_closeWhenFlushed` retries while the reliable channel still holds bytes,
  // capped at `REFUSE_FLUSH_TRIES`. Nothing in this repository had ever driven
  // that retry: every fixture in `tests/` sets `bufferedAmount: 0` and never
  // moves it, so `drained` was always true on the first check and the peer
  // always closed immediately. The point of the cap is a peer that stops
  // reading, and that peer had never existed in a test.
  {
    const { host } = makeHost();
    const wire = adapter.connectPeer(host, 1);
    // A peer that is not draining: the refusal goes into the reliable path and
    // stays there. Stated through the adapter, because "bytes still to send" is
    // `bufferedAmount` on a data channel and `pendingReliable` on a Steam
    // connection - the same fact in two vocabularies, and reaching for either by
    // name here is what would make this suite unportable.
    adapter.setPendingReliable(wire.hostPeer, 4096);
    host.setNow(99);
    host._checkHelloDeadlines();

    ok(wire.hostPeer.closed === false,
      t('the host held the connection open while the refusal was still buffered'));

    // Now it drains. The retry is on a 16 ms timer, so this is the one place the
    // suite waits on real time — polled rather than a fixed sleep so a loaded
    // box doesn't flake the assertion (#126).
    adapter.setPendingReliable(wire.hostPeer, 0);
    const drained = await pollUntil(() => wire.hostPeer.closed === true);

    ok(drained, t('and closed it once the channel drained'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — ...and gives up on a peer that never drains`);
  // ==========================================================================
  {
    const { host } = makeHost();
    const wire = adapter.connectPeer(host, 1);

    // Never drains, ever. The cap is what stops this peer holding a connection
    // open by doing nothing: 8 tries at 16 ms.
    adapter.setPendingReliable(wire.hostPeer, 4096);
    host.setNow(99);
    host._checkHelloDeadlines();

    // Polled rather than a fixed sleep: a peer that stops reading closes once
    // the 8-try cap is exhausted, but on a loaded box that can take longer
    // than the previous fixed 250 ms wait (#126). A peer that genuinely never
    // closes still fails here once `pollUntil`'s deadline elapses.
    const capped = await pollUntil(() => wire.hostPeer.closed === true);

    ok(capped, t('the cap closed a peer that stopped reading'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — the enumerated contract is SUFFICIENT`);
  // ==========================================================================
  //
  // Not a behaviour test. A peer carrying exactly `CONTRACT.peer` and nothing
  // else is driven through the real host loop; if `NetHost` reaches for a member
  // that is not on the list, this throws and the list is wrong. It is the guard
  // against the failure that produced this suite: a documented seam that was
  // missing two of its members.
  {
    const { host, ctx } = makeHost();
    const touched = new Set();
    const missing = [];

    // Built *from* `CONTRACT`, never alongside it. A hand-written fixture is a
    // second copy of the list, and two copies drift: drop a member from
    // `CONTRACT` while the fixture still implements it and this check goes on
    // passing while the document it polices has already gone wrong. Generating
    // the peer means removing a row from `CONTRACT` removes it from the peer,
    // and the host loop throws.
    const value = (member) => {
      if (member === 'id') return 7;
      // Assigned by `_onPeer`, not called by it.
      if (member === 'onMessage' || member === 'onClose') return null;
      // Reports drained so the refusal path closes on the first check, same as
      // the original `readyState`/`bufferedAmount` fixture did.
      if (member === 'drained') return () => { touched.add(member); return true; };
      return () => { touched.add(member); };
    };

    const bare = {};
    for (const m of CONTRACT.peer) bare[m] = value(m);

    // Anything read that is not on the contract is recorded rather than thrown,
    // so one run names every omission instead of only the first. `bare` is
    // generated from the contract, so `prop in target` *is* the membership test.
    const guarded = new Proxy(bare, {
      get(target, prop) {
        if (typeof prop === 'string' && !(prop in target)) missing.push(prop);
        return target[prop];
      },
    });

    host.transport.peers.set(7, guarded);
    host.transport.onPeer?.(guarded);

    let threw = null;
    try {
      // The whole host loop: the frame update that pumps and snapshots, and the
      // fixed step that sweeps the HELLO deadlines.
      for (let i = 0; i < 4; i++) {
        host.update(ctx, 1 / 60);
        host.fixedUpdate(ctx, 1 / 60);
      }
      host._forward('kill', {});
      host.update(ctx, 1);
      // And the refusal path, which is the only thing that reaches *through* the
      // peer into its channel. Without it the nested guard above would never be
      // exercised and the row it protects would be checked in theory only.
      host.setNow(99);
      host._checkHelloDeadlines();
    } catch (err) {
      threw = err;
    }

    ok(threw === null, t(`the host ran a full loop over a contract-only peer (${threw?.message ?? 'no throw'})`));
    ok(missing.length === 0, t(`it reached for nothing outside the contract (saw ${missing.join(', ') || 'nothing'})`));
    ok(touched.has('pumpSim'),
      t('and it did reach for pumpSim — the member section 3 of docs/STEAM.md omitted'));
    ok(touched.has('sendState'), t('and sendState, so the loop really ran'));
    ok(touched.has('sendEvent') && touched.has('close'),
      t('and the refusal path ran, so peer.drained() was called instead of a raw channel read'));
  }

  // ==========================================================================
  console.log(`\n${adapter.name} — drained() is transport-neutral`);
  // ==========================================================================
  //
  // Exercises the peer's own `drained()` directly, against the real reliable
  // path — the exact states `_closeWhenFlushed` used to read off
  // `readyState`/`bufferedAmount` by hand.
  //
  // The states are named rather than spelled: "bytes still to send", "nothing
  // left", "closed", "absent". Each transport's adapter puts its own connection
  // into them, because the first two are `bufferedAmount` in WebRTC's
  // vocabulary and `pendingReliable` in Steam's - a suite that wrote either
  // name would be a suite only one transport could pass. This is the one place
  // #55 found the enumeration portable and the *fixture* not.
  {
    const { host } = makeHost();
    const wire = adapter.connectPeer(host, 1);

    adapter.setPendingReliable(wire.hostPeer, 4096);
    ok(wire.hostPeer.drained() === false,
      t('an open reliable path with bytes still to send is not drained'));

    adapter.setPendingReliable(wire.hostPeer, 0);
    ok(wire.hostPeer.drained() === true,
      t('an open reliable path with nothing left to send is drained'));

    adapter.closeReliable(wire.hostPeer);
    ok(wire.hostPeer.drained() === true,
      t('a closed reliable path counts as drained regardless of what it held'));

    adapter.dropReliable(wire.hostPeer);
    ok(wire.hostPeer.drained() === true,
      t('an absent reliable path counts as drained'));
  }
}
