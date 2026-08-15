/**
 * Steam-layer smoke on one box: the real Steam library carrying the real protocol.
 *
 *   node tools/steamsmoke.mjs
 *     [--peers 3]          how many socket pairs, i.e. host<->client links
 *     [--hz 60]            snapshot send rate
 *     [--entities 60]      entities per snapshot, i.e. how big a snapshot is
 *     [--run-s 30]         measurement window, after warm-up
 *     [--warmup-s 3]       discarded window before measurement starts
 *     [--event-hz 4]       reliable sends per second per peer
 *     [--lag-ms 0]         k_ESteamNetworkingConfig_FakePacketLag_Recv
 *     [--loss-pct 0]       k_ESteamNetworkingConfig_FakePacketLoss_Recv
 *     [--no-loopback]      in-memory socket pair instead of 127.0.0.1 (see below)
 *     [--label steam-socketpair-3peer-60hz]
 *     [--record reviews/net-baseline/<label>.json]
 *     [--compare reviews/net-baseline/webrtc-3peer-60hz.json]
 *
 * ## What this is
 *
 * Arm B of [ADR 0002](../docs/adr/0002-networking-coverage-after-webrtc.md), and
 * issue #64. It is the **only** automated thing in this repo that watches the
 * shipping Steam library move the shipping bytes. Everything else either mocks
 * the transport (`tests/transport-conformance.test.mjs`, arm A) or needs a
 * second machine (#13, arm C).
 *
 * It needs a **running, logged-in Steam client**, so it is a local gate and can
 * never run in CI (#47). That is a property of `SteamAPI_Init`, not a choice.
 *
 * ## Why a socket pair, and why loopback
 *
 * A Steam identity is an account and one account is online in one place at a
 * time, so two peers on one box cannot meet through any identity-addressed call
 * — which is every call either candidate Binding exposes (`docs/STEAM.md` 8.1,
 * 8.3). `CreateSocketPair` is Valve's exception, written for "testing, or so
 * that our client/server code can be compiled in a single process".
 *
 * `bUseNetworkLoopback = true` is the part that matters: the default in-memory
 * mode short-circuits, and the packets never get packetised, encrypted or
 * impaired. Through 127.0.0.1 they do. `--no-loopback` exists to make that
 * difference measurable rather than assumed, and must not be used for a gate run.
 *
 * ## Comparable with the WebRTC baseline by construction
 *
 * Same peer count, rate, entity count and warm-up; the snapshot is built by the
 * shipped `writeEntity` from the same synthetic roster, so it is the same 1031
 * bytes on the wire; the reduction is `tools/netstats.mjs`, pinned by
 * `tests/steam-smoke.test.mjs` to the algorithm `tools/netbaseline.mjs` uses in
 * the browser. `--compare` reads the baseline record and puts the two side by
 * side in this one.
 *
 * The two channels become send flags rather than data channels — `state` is
 * `UnreliableNoNagle`, `events` is `ReliableNoNagle` — because Steam has no
 * channel labels. Arrivals are therefore classified by the message tag the
 * shipped `Protocol.js` already puts in byte 0 (`MSG.SNAPSHOT` / `MSG.EVENT`),
 * and the sequence read from bytes 1-4, exactly as the baseline reads its own.
 * Nothing is appended to either payload to make it measurable.
 *
 * ## What the number is, and is not
 *
 * Both ends live in this process and share one `performance.now()`, so there is
 * no clock-sync error and no internet flight time in these figures. What is
 * measured is **transport and binding cost over loopback** — encode, FFI, Steam
 * packetisation and encryption, 127.0.0.1, decode. That is the fair basis for
 * comparing against the WebRTC number, whose meaning is the same. **It is not a
 * player-facing latency number.**
 *
 * ## One hot loop, no timers
 *
 * Sending and receiving share a single `setImmediate` loop. A `setInterval`
 * sender plus a polling receiver would quantise every arrival by the poll
 * period, and at a 2 ms baseline a 1 ms quantum is a third of the answer. The
 * loop pegs one core for the length of the run; `sendLoop.maxSendGapMs` in the
 * record is what says whether the send cadence held.
 *
 * Exit code is 0 only if the run completed and the criterion agreed on #52 held.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MSG, Writer, EKIND, ESTATE, writeEntity } from '../src/net/Protocol.js';
import { openSteamNet, SEND, CONFIG, RECV_DRAIN_BATCHES } from './steamnet.mjs';
import { dist, verdict } from './netstats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const num = (name, fallback) => Number(flag(name, fallback));
const has = (name) => argv.includes(`--${name}`);

const PEERS = num('peers', 3);
const HZ = num('hz', 60);
const ENTITIES = num('entities', 60);
const RUN_S = num('run-s', 30);
const WARMUP_S = num('warmup-s', 3);
const EVENT_HZ = num('event-hz', 4);
const LAG_MS = num('lag-ms', 0);
const LOSS_PCT = num('loss-pct', 0);
const LOOPBACK = !has('no-loopback');
const LABEL = flag('label', 'steam-socketpair-3peer-60hz');
const RECORD = path.resolve(root, flag('record', `reviews/net-baseline/${LABEL}.json`));
const COMPARE = flag('compare', 'reviews/net-baseline/webrtc-3peer-60hz.json');

/**
 * The pass criterion, agreed on #52 **before** any Steam run existed and
 * deliberately not softened afterwards. The WebRTC baseline is p99 2.0 ms
 * (`state`) and 2.9-3.0 ms (`events`); these limits allow ~2.5x for FFI and
 * Steam-side overhead, on the judgement that sub-5 ms transport cost is
 * inaudible against a 16.7 ms frame. Judged on p99, never on max.
 */
const GATE = { stateP99Ms: 5.0, eventsP99Ms: 7.5 };

/** Every bound this run imposes. Nothing waits without one. */
const CAP = {
  drainMs: 1000,
  totalMs: Math.round((WARMUP_S + RUN_S) * 1000 * 1.5) + 30000,
};

const T0 = Date.now();
const capture = {
  argv: process.argv.slice(1).map((a) => a.replace(root, '.')),
  command: `node tools/steamsmoke.mjs${argv.length ? ` ${argv.join(' ')}` : ''}`,
};

await mkdir(path.dirname(RECORD), { recursive: true });
// Invalidate first — coopprobe's rule, and netbaseline's. A tool that throws
// part way must never leave a stale green record looking like it describes this
// tree and this Steam client.
await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(), tool: 'tools/steamsmoke.mjs', label: LABEL,
  aborted: 'run in progress - this file is rewritten when the tool finishes',
  ok: false,
}, null, 2)}\n`);

// ------------------------------------------------------------------ payloads
// The same synthetic roster netbaseline builds, written through the same shipped
// `writeEntity`, so the snapshot is the shipped byte layout at the same size.
// Any drift here silently makes the comparison a comparison of two payloads.
const roster = [];
for (let n = 0; n < ENTITIES; n++) {
  roster.push({
    netId: n + 1,
    kind: n < 4 ? EKIND.PLAYER : EKIND.ENEMY,
    typeId: n % 7,
    position: { x: (n % 40) - 20, y: 0.5, z: ((n * 7) % 40) - 20 },
    yaw: (n % 360) * (Math.PI / 180),
    health: 60 + (n % 40),
    maxHealth: 100,
    shield: n % 25,
    netState: ESTATE.ALIVE,
  });
}

const snapWriter = new Writer(16384);
function snapshotBytes(tick) {
  const w = snapWriter.reset();
  w.u8(MSG.SNAPSHOT);
  w.u32(tick);
  w.u32(0);              // ackInput — per-client in the game; constant here
  w.u16(roster.length);
  for (const e of roster) writeEntity(w, e);
  return w.bytes();
}

// Sized like the ones NetHost actually sends (`new Writer(16)`..`new Writer(128)`).
// Tagged `MSG.EVENT` rather than netbaseline's placeholder `MSG.SNAPSHOT`,
// because on Steam the tag is what tells the two channels apart on arrival.
const EVENT_BYTES = 64;
const evWriter = new Writer(EVENT_BYTES);
function eventBytes(seq) {
  const w = evWriter.reset();
  w.u8(MSG.EVENT);
  w.u32(seq);
  while (w.off < EVENT_BYTES) w.u8(seq & 0xff);
  return w.bytes();
}

// `Writer.bytes()` hands back a fresh ArrayBuffer (Protocol.js:219); koffi wants
// something with an address. This is a view over that copy, not a second one.
const toBuffer = (ab) => Buffer.from(ab);
const snapshotSize = snapshotBytes(0).byteLength;

// ----------------------------------------------------------------- the run
let net = null;
let result = null;
let fatal = null;
const links = [];

try {
  net = openSteamNet({ verbose: true });

  // Impairment is global, so it is armed once, before any connection exists,
  // and recorded whether or not it was used. Receive-side and one-directional —
  // the same shape as the `?netlag=` rig it replaces.
  if (LAG_MS > 0 && !net.setGlobalInt32(CONFIG.FakePacketLag_Recv, LAG_MS)) {
    throw new Error(`Steam refused FakePacketLag_Recv = ${LAG_MS}`);
  }
  if (LOSS_PCT > 0 && !net.setGlobalInt32(CONFIG.FakePacketLoss_Recv, LOSS_PCT)) {
    throw new Error(`Steam refused FakePacketLoss_Recv = ${LOSS_PCT}`);
  }

  for (let i = 0; i < PEERS; i++) {
    const [host, client] = net.createSocketPair(LOOPBACK);
    links.push({ id: i + 1, host, client });
  }
  console.log(`measuring: ${PEERS} peers, ${HZ} Hz, ${ENTITIES} entities `
    + `(${snapshotSize} B), ${WARMUP_S} s warm-up then ${RUN_S} s measured, `
    + `loopback ${LOOPBACK ? 'on' : 'OFF'}...`);

  // --- per-peer accounting, identical in shape to the WebRTC baseline's -----
  const acct = links.map(() => ({
    stateSent: 0, stateRecv: 0, stateLate: 0, stateDup: 0, stateOutOfOrder: 0,
    eventSent: 0, eventRecv: 0, eventLate: 0, eventDup: 0, eventOutOfOrder: 0,
    stateLat: [], eventLat: [],
    lastStateTick: -1, lastEventSeq: -1,
    seenState: new Set(), seenEvent: new Set(),
    unknownTag: 0,
  }));
  const stateSentAt = links.map(() => new Map());
  const eventSentAt = links.map(() => new Map());

  let measuring = false;

  const onMessage = (i, buf, now) => {
    const a = acct[i];
    const tag = buf[0];
    const seq = buf.readUInt32LE(1);
    if (tag === MSG.SNAPSHOT) {
      const sent = stateSentAt[i].get(seq);
      if (sent === undefined) { a.stateLate++; return; }
      if (a.seenState.has(seq)) { a.stateDup++; return; }
      a.seenState.add(seq);
      if (seq < a.lastStateTick) a.stateOutOfOrder++;
      a.lastStateTick = Math.max(a.lastStateTick, seq);
      a.stateRecv++;
      if (measuring) a.stateLat.push(now - sent);
    } else if (tag === MSG.EVENT) {
      const sent = eventSentAt[i].get(seq);
      if (sent === undefined) { a.eventLate++; return; }
      if (a.seenEvent.has(seq)) { a.eventDup++; return; }
      a.seenEvent.add(seq);
      // The reliable channel is ordered: any decrease is a real violation.
      if (seq < a.lastEventSeq) a.eventOutOfOrder++;
      a.lastEventSeq = Math.max(a.lastEventSeq, seq);
      a.eventRecv++;
      if (measuring) a.eventLat.push(now - sent);
    } else {
      // Steam delivers whole messages, so a tag we did not send is corruption,
      // not framing. Counted rather than ignored.
      a.unknownTag++;
    }
  };

  const stepMs = 1000 / HZ;
  const eventEvery = Math.max(1, Math.round(HZ / EVENT_HZ));
  const totalTicks = Math.round(((WARMUP_S + RUN_S) * 1000) / stepMs);
  const warmupTicks = Math.round((WARMUP_S * 1000) / stepMs);

  const startedAt = performance.now();
  let tick = 0;
  let eventSeq = 0;
  let maxSendGapMs = 0;
  let lastSendAt = startedAt;
  let lastPumpAt = 0;
  let iterations = 0;

  await new Promise((resolve, reject) => {
    const step = () => {
      iterations++;
      const now = performance.now();

      if (now - startedAt > CAP.totalMs) {
        reject(new Error(`run exceeded its cap of ${CAP.totalMs} ms at tick ${tick}/${totalTicks}`));
        return;
      }

      // Service the library on its own cadence rather than every iteration:
      // this loop spins thousands of times a second and RunCallbacks is not
      // free. 1 ms is far finer than anything being measured.
      if (now - lastPumpAt >= 1) { net.pump(); lastPumpAt = now; }

      // Drain first, so an arrival is timestamped as close to its delivery as
      // this process can see it.
      for (let i = 0; i < links.length; i++) {
        const msgs = net.receive(links[i].client);
        if (msgs.length) {
          const at = performance.now();
          for (const m of msgs) onMessage(i, m, at);
        }
      }

      const sendDue = tick < totalTicks && now - startedAt >= tick * stepMs;
      if (sendDue) {
        if (tick === warmupTicks) measuring = true;
        maxSendGapMs = Math.max(maxSendGapMs, now - lastSendAt);
        lastSendAt = now;

        const snap = toBuffer(snapshotBytes(tick));
        const sendEvent = tick % eventEvery === 0;
        const ev = sendEvent ? toBuffer(eventBytes(eventSeq)) : null;

        // Send timestamps are recorded only while measuring, so a warm-up packet
        // has no entry and, if it lands after the window opens, counts as
        // `arrivedOutsideWindow` rather than inflating the receive count past
        // the send count.
        for (let i = 0; i < links.length; i++) {
          if (measuring) { stateSentAt[i].set(tick, performance.now()); acct[i].stateSent++; }
          if (!net.send(links[i].host, snap, SEND.UNRELIABLE_NO_NAGLE)) {
            reject(new Error(`Steam refused an unreliable send on peer ${i + 1} at tick ${tick}`));
            return;
          }
          if (ev) {
            if (measuring) { eventSentAt[i].set(eventSeq, performance.now()); acct[i].eventSent++; }
            if (!net.send(links[i].host, ev, SEND.RELIABLE_NO_NAGLE)) {
              reject(new Error(`Steam refused a reliable send on peer ${i + 1} at tick ${tick}`));
              return;
            }
          }
        }
        if (sendEvent) eventSeq++;
        tick++;
      }

      // Anything still in flight when the send loop stops is delivery, not loss.
      // Bounded, and the wait is reported.
      if (tick >= totalTicks && now - lastSendAt >= CAP.drainMs) { resolve(); return; }
      setImmediate(step);
    };
    setImmediate(step);
  });

  measuring = false;
  const wallMs = Math.round(performance.now() - startedAt);
  for (const l of links) { net.flush(l.host); }

  // --------------------------------------------------------------- reduce
  const perPeer = acct.map((a, i) => ({
    peer: i + 1,
    state: {
      sent: a.stateSent, received: a.stateRecv,
      lost: Math.max(0, a.stateSent - a.stateRecv),
      duplicates: a.stateDup, outOfOrder: a.stateOutOfOrder,
      arrivedOutsideWindow: a.stateLate,
      latencyMs: dist(a.stateLat),
    },
    events: {
      sent: a.eventSent, received: a.eventRecv,
      lost: Math.max(0, a.eventSent - a.eventRecv),
      duplicates: a.eventDup, outOfOrder: a.eventOutOfOrder,
      arrivedOutsideWindow: a.eventLate,
      latencyMs: dist(a.eventLat),
    },
    unknownTag: a.unknownTag,
  }));

  const sum = (ch, key) => perPeer.reduce((s, p) => s + p[ch][key], 0);

  result = {
    steam: net.info,
    config: {
      peers: PEERS, hz: HZ, entities: ENTITIES,
      runS: RUN_S, warmupS: WARMUP_S, eventHz: EVENT_HZ,
      snapshotBytes: snapshotSize, eventBytes: EVENT_BYTES,
      offeredBytesPerSecond: Math.round(snapshotSize * HZ * PEERS),
      useNetworkLoopback: LOOPBACK,
      sendFlags: { state: 'UnreliableNoNagle', events: 'ReliableNoNagle' },
    },
    totals: {
      state: {
        sent: sum('state', 'sent'), received: sum('state', 'received'),
        lost: sum('state', 'lost'), duplicates: sum('state', 'duplicates'),
        outOfOrder: sum('state', 'outOfOrder'),
        latencyMs: dist(acct.flatMap((a) => a.stateLat)),
      },
      events: {
        sent: sum('events', 'sent'), received: sum('events', 'received'),
        lost: sum('events', 'lost'), duplicates: sum('events', 'duplicates'),
        outOfOrder: sum('events', 'outOfOrder'),
        latencyMs: dist(acct.flatMap((a) => a.eventLat)),
      },
    },
    perPeer,
    sendLoop: {
      ticks: tick,
      maxSendGapMs: Math.round(maxSendGapMs * 1000) / 1000,
      nominalStepMs: Math.round(stepMs * 1000) / 1000,
      wallMs,
      drainMs: CAP.drainMs,
      loopIterations: iterations,
      unknownTagTotal: perPeer.reduce((s, p) => s + p.unknownTag, 0),
    },
  };
} catch (err) {
  fatal = err;
} finally {
  try { for (const l of links) { net?.close(l.host); net?.close(l.client); } } catch { /* closing a dead handle is not a result */ }
  net?.shutdown();
}

// ------------------------------------------------------------------ compare
/**
 * The WebRTC record, alongside. Absent or unreadable is a note, not a failure:
 * the criterion is absolute limits, and this block exists to make the two
 * numbers readable side by side rather than to gate on their ratio.
 */
let comparison = null;
if (COMPARE && result) {
  try {
    const base = JSON.parse(await readFile(path.resolve(root, COMPARE), 'utf8'));
    const row = (ch) => ({
      steamP99Ms: result.totals[ch].latencyMs.p99,
      webrtcP99Ms: base.totals?.[ch]?.latencyMs?.p99 ?? null,
      ratio: base.totals?.[ch]?.latencyMs?.p99
        ? Math.round((result.totals[ch].latencyMs.p99 / base.totals[ch].latencyMs.p99) * 100) / 100
        : null,
    });
    comparison = { baseline: COMPARE, state: row('state'), events: row('events') };
  } catch (err) {
    comparison = { baseline: COMPARE, unavailable: String(err?.message ?? err).slice(0, 300) };
  }
}

const gate = verdict(result?.totals ?? null, GATE);
const ok = !fatal && gate.ok;

await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(),
  tool: 'tools/steamsmoke.mjs',
  label: LABEL,
  transport: 'Steam ISteamNetworkingSockets::CreateSocketPair (tools/steamnet.mjs, test-only Koffi)',
  measuredAt: 'SendMessageToConnection -> ReceiveMessagesOnConnection',
  meaning: 'transport and binding cost over loopback - encode, FFI, Steam '
    + 'packetisation and encryption, 127.0.0.1, decode. Both endpoints are in '
    + 'one process sharing one performance.now(), so there is no clock-sync '
    + 'error in these figures and no internet flight time in them either. Not a '
    + 'player-facing latency number.',
  bounded: {
    ...CAP,
    warmupDiscardedS: WARMUP_S,
    // The receive drain is inside the loop that enforces `totalMs`, so it needs
    // a bound of its own or that cap cannot fire while it is running. What it
    // does not drain stays queued for the next pass.
    recvDrainBatchesPerCall: RECV_DRAIN_BATCHES,
    note: 'every wait in this tool is capped; the caps above are the only ones there are',
  },
  impairment: {
    fakePacketLagRecvMs: LAG_MS,
    fakePacketLossRecvPct: LOSS_PCT,
    armed: LAG_MS > 0 || LOSS_PCT > 0,
    note: 'receive-side and one-directional, the same shape as the ?netlag= rig it replaces',
  },
  capture,
  gate,
  comparison,
  ok,
  ...(result ?? {}),
  fatal: fatal ? String(fatal?.message ?? fatal).slice(0, 2000) : null,
  totalMs: Date.now() - T0,
}, null, 2)}\n`);

if (fatal) {
  console.error(`\nFAIL - ${String(fatal?.message ?? fatal)}`);
} else {
  const t = result.totals;
  for (const ch of ['state', 'events']) {
    const d = t[ch].latencyMs;
    console.log(`${ch.padEnd(6)} p50 ${d.p50} ms  p95 ${d.p95} ms  p99 ${d.p99} ms  max ${d.max} ms  `
      + `(${t[ch].received}/${t[ch].sent}, ${t[ch].lost} lost, ${t[ch].duplicates} dup, ${t[ch].outOfOrder} out of order)`);
  }
  if (comparison?.state) {
    console.log(`\nvs ${comparison.baseline}:  state p99 ${comparison.state.steamP99Ms} vs `
      + `${comparison.state.webrtcP99Ms} ms (${comparison.state.ratio}x)  `
      + `events p99 ${comparison.events.steamP99Ms} vs ${comparison.events.webrtcP99Ms} ms `
      + `(${comparison.events.ratio}x)`);
  }
  console.log('');
  for (const c of gate.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(gate.ok ? '\nPASS - the Steam library carried the protocol within the agreed envelope'
    : '\nFAIL - see the checks above');
}
console.log(`record: ${path.relative(root, RECORD)}`);
process.exit(ok ? 0 : 1);
