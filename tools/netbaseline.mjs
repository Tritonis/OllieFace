/**
 * Net baseline: what the shipped WebRTC Conversation costs, as numbers.
 *
 *   node tools/netbaseline.mjs
 *     [--port 5216]        vite dev server port (started by this tool)
 *     [--peers 3]          how many client Peers the host serves
 *     [--hz 60]            host snapshot send rate
 *     [--entities 60]      entities per snapshot, i.e. how big a snapshot is
 *     [--run-s 30]         measurement window, after all peers are connected
 *     [--warmup-s 3]       discarded window before measurement starts
 *     [--event-hz 4]       reliable `events` sends per second per peer
 *     [--label webrtc]     names the record when --record is omitted
 *     [--record reviews/net-baseline/<label>.json]
 *
 * ## Why this exists
 *
 * `docs/superpowers/plans/steam-phase-2-swap.md` step 1 gates the Phase 2 spike
 * on "zero dropped reliable messages, and p99 added latency within the envelope
 * `gate:mp1` records for WebRTC". That envelope did not exist. `gate:mp1` is
 * `sp-equivalence --coop-host`: one process, no socket, no peer connection — it
 * asserts a determinism fingerprint and the roster-of-one invariant and records
 * no wire timing at all. `probe:coop` forms a real connection but records
 * `formationMs`, phase timings and behavioural pass/fail, with no per-message
 * distribution and no reliable-delivery counter. `ClockSync` (src/net/
 * Snapshot.js:138) does compute an RTT, but as a *minimum* over a 40-sample
 * window, deliberately chosen to be robust against spikes — structurally the
 * opposite of a p99, and it cannot be made to yield one.
 *
 * So step 0 could not be satisfied by reading a number off an existing gate.
 * This tool produces the number instead.
 *
 * ## Measured at the seam that survives the swap
 *
 * The measurement sits at `Peer` (src/net/Transport.js:114) — `sendState` /
 * `sendEvent` out, `onMessage` in, over the two channels `Protocol.js` names,
 * created with the exact flags `HostTransport` uses (`state`: unordered,
 * `maxRetransmits: 0`; `events`: ordered). That seam is the reason the number
 * is comparable later: whatever binds Steam `NetworkingSockets` has to present
 * the same two-channel contract to `NetHost`/`NetClient`, so the same benchmark
 * can be re-pointed at it and the two records read side by side.
 *
 * A baseline taken through `probe:coop` could not have been re-measured at all:
 * plan step 3 records that deleting the WebRTC Conversation deletes that probe,
 * which would leave a WebRTC number with nothing on the other side to compare
 * it to.
 *
 * ## What the number is, and what it is not
 *
 * Both endpoints live in one page, so both timestamps come off one
 * `performance.now()` and the latency figure has no clock-sync error in it.
 * What it therefore measures is **transport and binding cost — encode, channel,
 * SCTP, dispatch, decode — not network flight time**, over loopback.
 *
 * That is the fair comparison for the spike, whose question is what an unproven
 * FFI adds on the core loop, not what the internet adds. It is NOT a
 * player-facing latency figure and must not be quoted as one. Impairment
 * (`?netlag=`, `?netloss=`) is deliberately not armed here: the rig would add a
 * number this tool already knows, and hide the one it is trying to find.
 *
 * Latency is `recv - send` for the identical packet: snapshots are matched by
 * the `tick` the shipped header already carries at byte offset 1, so nothing is
 * appended to the wire format to make it measurable.
 *
 * ## Bounded everywhere
 *
 * Every wait has a cap and every cap is written into the record, as is the
 * discarded warm-up. The record is invalidated before the run starts, so a
 * crash can never leave the previous green file on disk looking like it
 * describes this HEAD.
 *
 * Exit code is 0 if the run completed and every reliable-channel invariant held.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const num = (name, fallback) => Number(flag(name, fallback));

const PORT = num('port', 5216);
const PEERS = num('peers', 3);
const HZ = num('hz', 60);
const ENTITIES = num('entities', 60);
const RUN_S = num('run-s', 30);
const WARMUP_S = num('warmup-s', 3);
const EVENT_HZ = num('event-hz', 4);
const LABEL = flag('label', 'webrtc');
const RECORD = path.resolve(root, flag('record', `reviews/net-baseline/${LABEL}.json`));

// Every bound this run imposes. Nothing waits without one.
const CAP = {
  connectMs: 30000,      // all peers open both channels
  pageLoadMs: 60000,
  browserLaunchMs: 180000,
};

const T0 = Date.now();
const capture = {
  argv: process.argv.slice(1).map((a) => a.replace(root, '.')),
  command: `node tools/netbaseline.mjs${argv.length ? ` ${argv.join(' ')}` : ''}`,
};

await mkdir(path.dirname(RECORD), { recursive: true });
// Invalidate first — coopprobe's rule. A tool that throws part way must never
// leave a stale green record looking like it describes this tree.
await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(), tool: 'tools/netbaseline.mjs', label: LABEL,
  aborted: 'run in progress - this file is rewritten when the tool finishes',
  ok: false,
}, null, 2)}\n`);

let vite = null;
let browser = null;
let result = null;
let fatal = null;

/**
 * The whole measurement, inside one page.
 *
 * It runs in the browser because WebRTC does: there is no `RTCPeerConnection`
 * in node, and a benchmark that faked one would measure the fake. Modules are
 * imported from the vite dev server so the code under measurement is the
 * shipped `src/net/` source, not a copy.
 */
async function measure(page, opts) {
  return page.evaluate(async (o) => {
    const { Peer } = await import('/src/net/Transport.js');
    const { Writer, MSG, EKIND, ESTATE, writeEntity } = await import('/src/net/Protocol.js');

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = (p, ms, msg) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
    ]);

    // --- one host<->client pair, wired exactly as HostTransport wires it -----
    //
    // `_wire` is reached into deliberately. It is what sets `binaryType` and
    // installs the arrival hook the game receives through; re-implementing it
    // here would measure a receive path the game does not use.
    function makePair(id) {
      // No `rtcConfig()` (src/net/Transport.js:426), deliberately. That config
      // is ICE/STUN, which only bears on how a connection is formed; formation
      // happens before the timed window opens and nothing in it can reach the
      // figures. Both ends are in one page, so there is no NAT to traverse.
      const hostPc = new RTCPeerConnection();
      const clientPc = new RTCPeerConnection();
      hostPc.onicecandidate = (e) => { if (e.candidate) clientPc.addIceCandidate(e.candidate).catch(() => {}); };
      clientPc.onicecandidate = (e) => { if (e.candidate) hostPc.addIceCandidate(e.candidate).catch(() => {}); };

      const hostPeer = new Peer(hostPc, id);
      const clientPeer = new Peer(clientPc, id);

      hostPeer.state = hostPeer._wire(
        hostPc.createDataChannel('state', { ordered: false, maxRetransmits: 0 }), 'state',
      );
      hostPeer.events = hostPeer._wire(
        hostPc.createDataChannel('events', { ordered: true }), 'events',
      );

      const open = new Set();
      const ready = new Promise((resolve) => {
        clientPc.ondatachannel = (e) => {
          const ch = clientPeer._wire(e.channel, e.channel.label);
          clientPeer[e.channel.label] = ch;
          const done = () => { open.add(e.channel.label); if (open.size === 2) resolve(); };
          if (ch.readyState === 'open') done(); else ch.onopen = done;
        };
      });

      return { id, hostPc, clientPc, hostPeer, clientPeer, ready };
    }

    async function connect(pair) {
      const offer = await pair.hostPc.createOffer();
      await pair.hostPc.setLocalDescription(offer);
      await pair.clientPc.setRemoteDescription(offer);
      const answer = await pair.clientPc.createAnswer();
      await pair.clientPc.setLocalDescription(answer);
      await pair.hostPc.setRemoteDescription(answer);
      await pair.ready;
    }

    const pairs = [];
    for (let i = 0; i < o.peers; i++) pairs.push(makePair(i + 1));
    await deadline(
      Promise.all(pairs.map(connect)),
      o.capConnectMs,
      `not all ${o.peers} peers opened both channels within ${o.capConnectMs} ms`,
    );

    // --- per-peer accounting -------------------------------------------------
    // `stateLate` / `eventLate` surface as `arrivedOutsideWindow`. The name is
    // about the *send*, not the receive: they count arrivals whose key was
    // never recorded as sent, which structurally can only be warm-up traffic
    // landing after the window opened. They are not "late deliveries" of
    // measured packets — those are simply slow, and show up in the latency
    // distribution where they belong.
    const acct = pairs.map(() => ({
      stateSent: 0, stateRecv: 0, stateLate: 0, stateDup: 0, stateOutOfOrder: 0,
      eventSent: 0, eventRecv: 0, eventLate: 0, eventDup: 0, eventOutOfOrder: 0,
      stateLat: [], eventLat: [],
      lastStateTick: -1, lastEventSeq: -1,
      seenState: new Set(), seenEvent: new Set(),
    }));

    // Send timestamps live host-side, keyed by the sequence already on the
    // wire. Nothing is appended to either payload to make it measurable.
    const stateSentAt = pairs.map(() => new Map());
    const eventSentAt = pairs.map(() => new Map());

    let measuring = false;

    for (let i = 0; i < pairs.length; i++) {
      const a = acct[i];
      pairs[i].clientPeer.onMessage = (data, label) => {
        const now = performance.now();
        const view = new DataView(data);
        if (label === 'state') {
          const tick = view.getUint32(1, true);
          const sent = stateSentAt[i].get(tick);
          if (sent === undefined) { a.stateLate++; return; }
          if (a.seenState.has(tick)) { a.stateDup++; return; }
          a.seenState.add(tick);
          if (tick < a.lastStateTick) a.stateOutOfOrder++;
          a.lastStateTick = Math.max(a.lastStateTick, tick);
          a.stateRecv++;
          if (measuring) a.stateLat.push(now - sent);
        } else {
          const seq = view.getUint32(1, true);
          const sent = eventSentAt[i].get(seq);
          if (sent === undefined) { a.eventLate++; return; }
          if (a.seenEvent.has(seq)) { a.eventDup++; return; }
          a.seenEvent.add(seq);
          // The reliable channel is ordered: any decrease is a real violation.
          if (seq < a.lastEventSeq) a.eventOutOfOrder++;
          a.lastEventSeq = Math.max(a.lastEventSeq, seq);
          a.eventRecv++;
          if (measuring) a.eventLat.push(now - sent);
        }
      };
    }

    // --- payloads, built with the shipped encoders --------------------------
    //
    // A synthetic roster of the requested size, written through `writeEntity`,
    // so the snapshot is the shipped byte layout at a realistic combat size
    // rather than a number this tool made up.
    const roster = [];
    for (let n = 0; n < o.entities; n++) {
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

    // An `events` payload sized like the ones NetHost actually sends
    // (`new Writer(16)` .. `new Writer(128)`): tag, seq, and filler to 64 B.
    const EVENT_BYTES = 64;
    const evWriter = new Writer(EVENT_BYTES);
    function eventBytes(seq) {
      const w = evWriter.reset();
      w.u8(MSG.SNAPSHOT);    // placeholder tag; this channel is read by us only
      w.u32(seq);
      while (w.off < EVENT_BYTES) w.u8(seq & 0xff);
      return w.bytes();
    }

    const snapshotSize = snapshotBytes(0).byteLength;

    // --- the run -------------------------------------------------------------
    const stepMs = 1000 / o.hz;
    const eventEvery = Math.max(1, Math.round(o.hz / o.eventHz));
    const totalTicks = Math.round(((o.warmupS + o.runS) * 1000) / stepMs);
    const warmupTicks = Math.round((o.warmupS * 1000) / stepMs);

    const startedAt = performance.now();
    let tick = 0;
    let eventSeq = 0;
    let maxSendGapMs = 0;
    let lastSendAt = startedAt;

    // setInterval, not rAF: the send loop must not inherit a frame cadence, and
    // pacing jitter cannot pollute the result anyway — latency is measured from
    // the actual send timestamp of each packet, not from its scheduled one.
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (tick === warmupTicks) measuring = true;

        const now = performance.now();
        maxSendGapMs = Math.max(maxSendGapMs, now - lastSendAt);
        lastSendAt = now;

        const snap = snapshotBytes(tick);
        const sendEvent = tick % eventEvery === 0;
        const ev = sendEvent ? eventBytes(eventSeq) : null;

        // Send timestamps are recorded only while measuring. A warm-up packet
        // therefore has no entry, and if it lands after the window opens it is
        // counted as `arrivedOutsideWindow` rather than as a receive — which is
        // what keeps sent/received/lost a coherent set instead of letting
        // warm-up arrivals inflate the receive count past the send count.
        for (let i = 0; i < pairs.length; i++) {
          if (measuring) {
            stateSentAt[i].set(tick, performance.now());
            acct[i].stateSent++;
          }
          pairs[i].hostPeer.sendState(snap);
          if (ev) {
            if (measuring) {
              eventSentAt[i].set(eventSeq, performance.now());
              acct[i].eventSent++;
            }
            pairs[i].hostPeer.sendEvent(ev);
          }
        }
        if (sendEvent) eventSeq++;

        if (++tick >= totalTicks) { clearInterval(timer); resolve(); }
      }, stepMs);
    });

    // Drain: anything still in flight when the send loop stops is delivery, not
    // loss. Bounded, and the wait is reported.
    const drainMs = 1000;
    await sleep(drainMs);
    measuring = false;

    // --- reduce ---------------------------------------------------------------
    const pct = (arr, p) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
      return s[i];
    };
    const round = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
    const dist = (arr) => ({
      n: arr.length,
      p50: round(pct(arr, 50)), p95: round(pct(arr, 95)),
      p99: round(pct(arr, 99)), max: round(arr.length ? Math.max(...arr) : null),
      mean: round(arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null),
    });

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
    }));

    const allState = acct.flatMap((a) => a.stateLat);
    const allEvent = acct.flatMap((a) => a.eventLat);

    for (const p of pairs) { p.hostPeer.close(); p.clientPeer.close(); }

    return {
      config: {
        peers: o.peers, hz: o.hz, entities: o.entities,
        runS: o.runS, warmupS: o.warmupS, eventHz: o.eventHz,
        snapshotBytes: snapshotSize, eventBytes: EVENT_BYTES,
        offeredBytesPerSecond: Math.round(snapshotSize * o.hz * o.peers),
      },
      totals: {
        state: {
          sent: perPeer.reduce((s, p) => s + p.state.sent, 0),
          received: perPeer.reduce((s, p) => s + p.state.received, 0),
          lost: perPeer.reduce((s, p) => s + p.state.lost, 0),
          latencyMs: dist(allState),
        },
        events: {
          sent: perPeer.reduce((s, p) => s + p.events.sent, 0),
          received: perPeer.reduce((s, p) => s + p.events.received, 0),
          lost: perPeer.reduce((s, p) => s + p.events.lost, 0),
          duplicates: perPeer.reduce((s, p) => s + p.events.duplicates, 0),
          outOfOrder: perPeer.reduce((s, p) => s + p.events.outOfOrder, 0),
          latencyMs: dist(allEvent),
        },
      },
      perPeer,
      sendLoop: {
        ticks: tick,
        maxSendGapMs: Math.round(maxSendGapMs * 1000) / 1000,
        nominalStepMs: Math.round(stepMs * 1000) / 1000,
        wallMs: Math.round(performance.now() - startedAt),
        drainMs,
      },
    };
  }, opts);
}

try {
  vite = await createServer({
    root,
    server: { port: PORT, strictPort: true, hmr: false, watch: null },
    logLevel: 'error',
  });
  await vite.listen();

  browser = await chromium.launch({
    timeout: CAP.browserLaunchMs,
    // Headed, with the backgrounding flags, for the reason coopprobe is: a
    // throttled timer in a backgrounded renderer reads as added latency that
    // the transport never caused. Nothing here draws, so the GPU flags
    // coopprobe needs for THREE are not carried over.
    headless: false,
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=-2400,-2400', '--window-size=800,600',
    ],
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push(String(e?.message ?? e).slice(0, 300)));

  // A blank page on the vite origin, not `index.html`. The game must not be
  // running underneath the measurement: its frame loop, renderer and audio
  // graph would all land in these numbers as latency the transport never
  // caused. Only this one URL is intercepted, so the `import()`s below still
  // fetch the real `src/net/` modules from the dev server.
  const HARNESS_URL = `http://127.0.0.1:${PORT}/__netbaseline__.html`;
  await page.route(HARNESS_URL, (route) => route.fulfill({
    status: 200, contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>netbaseline</title>',
  }));
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded', timeout: CAP.pageLoadMs });

  console.log(`measuring: ${PEERS} peers, ${HZ} Hz, ${ENTITIES} entities, `
    + `${WARMUP_S} s warm-up then ${RUN_S} s measured...`);

  const measured = await measure(page, {
    peers: PEERS, hz: HZ, entities: ENTITIES, runS: RUN_S, warmupS: WARMUP_S,
    eventHz: EVENT_HZ, capConnectMs: CAP.connectMs,
  });

  result = { ...measured, consoleErrors };
} catch (err) {
  fatal = err;
} finally {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
}

// The reliable channel is the one with an absolute contract, so it is the one
// with a pass/fail rather than a number to be read.
const reliableIntact = !!result
  && result.totals.events.sent > 0
  && result.totals.events.lost === 0
  && result.totals.events.duplicates === 0
  && result.totals.events.outOfOrder === 0;

const ok = !fatal && reliableIntact;

await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(),
  tool: 'tools/netbaseline.mjs',
  label: LABEL,
  transport: 'WebRTC RTCDataChannel (src/net/Transport.js)',
  measuredAt: 'Peer.sendState/sendEvent -> Peer.onMessage',
  meaning: 'transport and binding cost over loopback - encode, channel, SCTP, '
    + 'dispatch, decode. Both endpoints share one performance.now(), so there is '
    + 'no clock-sync error in these figures and no network flight time in them '
    + 'either. Not a player-facing latency number.',
  bounded: {
    ...CAP,
    impairment: 'none - ?netlag=/?netloss= deliberately not armed',
    warmupDiscardedS: WARMUP_S,
    note: 'every wait in this tool is capped; the caps above are the only ones there are',
  },
  capture,
  reliableIntact,
  ok,
  ...(result ?? {}),
  fatal: fatal ? String(fatal?.message ?? fatal).slice(0, 2000) : null,
  totalMs: Date.now() - T0,
}, null, 2)}\n`);

if (fatal) {
  console.error(`\nFAIL - ${String(fatal?.message ?? fatal)}`);
} else {
  const t = result.totals;
  console.log(`\nstate  p50 ${t.state.latencyMs.p50} ms  p95 ${t.state.latencyMs.p95} ms  `
    + `p99 ${t.state.latencyMs.p99} ms  max ${t.state.latencyMs.max} ms  `
    + `(${t.state.received}/${t.state.sent}, ${t.state.lost} lost)`);
  console.log(`events p50 ${t.events.latencyMs.p50} ms  p95 ${t.events.latencyMs.p95} ms  `
    + `p99 ${t.events.latencyMs.p99} ms  max ${t.events.latencyMs.max} ms  `
    + `(${t.events.received}/${t.events.sent}, ${t.events.lost} lost, `
    + `${t.events.duplicates} dup, ${t.events.outOfOrder} out of order)`);
  console.log(reliableIntact
    ? 'PASS - reliable channel delivered every message exactly once, in order'
    : 'FAIL - reliable channel violated its contract');
}
console.log(`record: ${path.relative(root, RECORD)}`);
process.exit(ok ? 0 : 1);
