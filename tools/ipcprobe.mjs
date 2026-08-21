/**
 * What the IPC boundary costs the Conversation. Issue #128, shape (a).
 *
 *     electron tools/ipcprobe.mjs [--peers 3] [--hz 60] [--entities 60]
 *                                 [--run-s 30] [--warmup-s 3] [--event-hz 4]
 *                                 [--label ipc-bridge-3peer-60hz]
 *
 * `SteamTransport.js` wants a synchronous `sendMessage`/`receiveMessages` at
 * 60 Hz. The main process is the only one that can hold the Binding, so the
 * renderer can only reach it across `ipcRenderer`, which is asynchronous. The
 * issue names three shapes and mandates that (a) -- batch per frame over one
 * IPC channel -- be MEASURED before anything else is designed.
 *
 * ## What is measured
 *
 * The real path is: sender renderer -> sender main -> Steam -> receiver main
 * -> receiver renderer. This rig runs one renderer and one main and loops the
 * batch back, which is exactly the two IPC hops, with Steam's own leg
 * (separately measured at p99 0.23-0.24 ms,
 * `reviews/net-baseline/STEAM-SOCKETPAIR.md`) standing aside. So the figure
 * here is the *added* latency, and the composed estimate this tool records is
 * that plus the Steam leg's p99.
 *
 * Two figures, and the difference between them is the whole reason the first
 * one is the one that gets compared:
 *
 * - **added** is stamped when the game hands the byte to the bridge and read
 *   when the IPC event reaches the renderer process. That is the same event
 *   the WebRTC baseline and the Steam smoke both timed, so it is the only
 *   figure comparable with theirs.
 * - **toFrameHook** is the same sample read where the game's own frame tick
 *   drains it, which adds up to one frame of quantisation. It is recorded
 *   because it is what the player experiences -- but WebRTC pays that frame
 *   too, and it was never in the 2 ms envelope, so gating on it would be
 *   comparing two different measurements.
 *
 * The main process forwards on receipt rather than on a pump of its own: the
 * renderer batches per frame because that is when the game produces bytes,
 * whereas main has bytes the instant the IPC lands. A 60 Hz pump on the main
 * side was measured first and cost a whole extra frame of phase for nothing.
 *
 * Payload sizes come from the shipped `writeEntity`, at the same 60 entities
 * every other measurement in `reviews/net-baseline/` used, so this record is
 * comparable with them by construction.
 *
 * The window is hidden but `backgroundThrottling` is off: Chromium throttles
 * timers in an unfocused window to 1 Hz, which would measure the throttle.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { MSG, Writer, EKIND, ESTATE, writeEntity } from '../src/net/Protocol.js';
import { dist } from './netstats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(process.defaultApp ? 2 : 1).filter((a) => a.startsWith('--') || !a.endsWith('.mjs'));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const num = (name, dflt) => Number(flag(name, dflt));

const PEERS = num('peers', 3);
const HZ = num('hz', 60);
const ENTITIES = num('entities', 60);
const RUN_S = num('run-s', 30);
const WARMUP_S = num('warmup-s', 3);
const EVENT_HZ = num('event-hz', 4);
const LABEL = String(flag('label', 'ipc-bridge-3peer-60hz'));
const RECORD = path.resolve(root, String(flag('record', `reviews/net-baseline/${LABEL}.json`)));

/**
 * The envelope #128 names, and the Steam leg it has to be composed with. Both
 * are quoted from measurements already in the repo rather than chosen here:
 * WebRTC p99 from `webrtc-3peer-60hz.json`, the Steam leg from
 * `STEAM-SOCKETPAIR.md`'s three runs (worst p99 of the three, so the composed
 * figure is the pessimistic one).
 */
const ENVELOPE = { stateP99Ms: 2.0, eventsP99Ms: 3.0 };
const STEAM_LEG_P99 = { state: 0.242, events: 0.277 };

const gitSha = () => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return null; }
};

// ------------------------------------------------------------------ payloads
// The shipped byte layout at the shipped size -- see the header.
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
const w = new Writer(16384);
w.u8(MSG.SNAPSHOT); w.u32(0); w.u32(0); w.u16(roster.length);
for (const e of roster) writeEntity(w, e);
const SNAPSHOT_BYTES = w.bytes().byteLength;
const EVENT_BYTES = 64;

// ---------------------------------------------------------------- the page
// Inline, so the rig is two files and no build step. The renderer half is the
// half that has to look like the game's frame: produce, flush once, drain once.
const PAGE = `<!doctype html><meta charset="utf-8"><title>ipcprobe</title><script type="module">
const CFG = ${JSON.stringify({ PEERS, HZ, RUN_S, WARMUP_S, EVENT_HZ, SNAPSHOT_BYTES, EVENT_BYTES })};
const rig = window.__RIG__;
const CH_STATE = 0, CH_EVENTS = 1;
// channel byte, then float64 stamp, then filler to the shipped size. The stamp
// replaces payload bytes rather than being appended: a rig that made its own
// messages bigger than the game's would be measuring a different transport.
const make = (ch, size, t) => {
  const u8 = new Uint8Array(size + 1);
  u8[0] = ch;
  new DataView(u8.buffer).setFloat64(1, t, true);
  return u8;
};
const stampOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getFloat64(1, true);

const acct = [];
for (let i = 0; i < CFG.PEERS; i++) acct.push({ stateSent: 0, stateRecv: 0, eventSent: 0, eventRecv: 0, stateLat: [], eventLat: [], stateDrain: [], eventDrain: [] });

let frame = 0;
let measuring = false;
let measureFrom = Infinity;   // a sample is ours only if it was SENT while measuring
const startedAt = performance.now();
const warmupMs = CFG.WARMUP_S * 1000;
const totalMs = warmupMs + CFG.RUN_S * 1000;
const eventEvery = Math.max(1, Math.round(CFG.HZ / CFG.EVENT_HZ));

const tick = () => {
  const now = performance.now();
  const elapsed = now - startedAt;
  if (!measuring && elapsed >= warmupMs) { measuring = true; measureFrom = now; }

  // --- drain first: this is the game's frame hook, pumpSim ---
  for (let i = 0; i < CFG.PEERS; i++) {
    const got = rig.receive(i, 64);
    const at = performance.now();
    for (const m of got) {
      const u8 = m.data;
      const t0 = stampOf(u8);
      // Sent during warm-up, arriving during the measured window: counted by
      // neither, or the received tally outruns the sent one.
      if (t0 < measureFrom) continue;
      const a = acct[i];
      if (u8[0] === CH_STATE) { a.stateRecv++; a.stateLat.push(m.at - t0); a.stateDrain.push(at - t0); }
      else { a.eventRecv++; a.eventLat.push(m.at - t0); a.eventDrain.push(at - t0); }
    }
  }

  // --- then produce, and flush once ---
  const sendEvents = frame % eventEvery === 0;
  for (let i = 0; i < CFG.PEERS; i++) {
    const t = performance.now();
    rig.send(i, make(CH_STATE, CFG.SNAPSHOT_BYTES, t), 0);
    if (measuring) acct[i].stateSent++;
    if (sendEvents) {
      rig.send(i, make(CH_EVENTS, CFG.EVENT_BYTES, performance.now()), 8);
      if (measuring) acct[i].eventSent++;
    }
  }
  rig.flush();
  frame++;

  if (elapsed >= totalMs) {
    clearInterval(handle);
    // One drain-out second: messages in flight at the whistle are counted,
    // otherwise the last frame's sends read as loss.
    setTimeout(() => {
      for (let i = 0; i < CFG.PEERS; i++) {
        for (const m of rig.receive(i, 4096)) {
          const a = acct[i];
          const u8 = m.data; const t0 = stampOf(u8);
          if (t0 < measureFrom) continue;
          // Arrival is still a real sample -- the IPC landed when it landed.
          // The to-hook figure is NOT: this drain is a whistle, not a frame,
          // and timing it would put a one-second wait into a 60 Hz statistic.
          if (u8[0] === CH_STATE) { a.stateRecv++; a.stateLat.push(m.at - t0); }
          else { a.eventRecv++; a.eventLat.push(m.at - t0); }
        }
      }
      rig.report({ frames: frame, peers: acct });
    }, 1000);
  }
};
const handle = setInterval(tick, 1000 / CFG.HZ);
</script>`;

// ------------------------------------------------------------------ the run
const pagePath = path.join(tmpdir(), `ipcprobe-${process.pid}.html`);
writeFileSync(pagePath, PAGE);

let done = null;
const finished = new Promise((resolve) => { done = resolve; });

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: {
      preload: path.join(here, 'ipcrig-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // The main-process half: hold what the renderer sent, and push it back on
  // this process's own 60 Hz tick. Standing in for the sockets pump, which is
  // what would sit exactly here -- `sendMessage` on receipt, `receiveMessages`
  // on the tick.
  // Immediately, not on a timer of its own: the renderer batches per frame
  // because that is when the game produces bytes, but the main process has no
  // reason to hold them -- it would call `sendMessage` here, and push whatever
  // `receiveMessages` returned as soon as it returned. A 60 Hz pump on this
  // side was measured first and cost a whole extra frame of phase for nothing.
  ipcMain.on('rig:send', (_event, batch) => {
    if (!win.isDestroyed()) win.webContents.send('rig:recv', batch);
  });

  ipcMain.on('rig:done', (_event, record) => { done(record); });

  await win.loadFile(pagePath);

  const result = await finished;

  const stateLat = [];
  const eventLat = [];
  const stateDrain = [];
  const eventDrain = [];
  let stateSent = 0; let stateRecv = 0; let eventSent = 0; let eventRecv = 0;
  for (const p of result.peers) {
    stateLat.push(...p.stateLat); eventLat.push(...p.eventLat);
    stateDrain.push(...p.stateDrain); eventDrain.push(...p.eventDrain);
    stateSent += p.stateSent; stateRecv += p.stateRecv;
    eventSent += p.eventSent; eventRecv += p.eventRecv;
  }
  const added = { state: dist(stateLat), events: dist(eventLat) };
  const toFrameHook = { state: dist(stateDrain), events: dist(eventDrain) };
  const composed = {
    stateP99Ms: Math.round((added.state.p99 + STEAM_LEG_P99.state) * 1000) / 1000,
    eventsP99Ms: Math.round((added.events.p99 + STEAM_LEG_P99.events) * 1000) / 1000,
  };
  const checks = [
    { name: 'traffic', ok: stateSent > 0 && eventSent > 0, detail: `state sent ${stateSent}, events sent ${eventSent}` },
    { name: 'events delivered', ok: eventSent > 0 && eventRecv === eventSent, detail: `${eventRecv}/${eventSent}` },
    {
      name: 'composed state p99 within the WebRTC envelope',
      ok: composed.stateP99Ms <= ENVELOPE.stateP99Ms,
      detail: `${composed.stateP99Ms} ms <= ${ENVELOPE.stateP99Ms} ms`,
    },
    {
      name: 'composed events p99 within the WebRTC envelope',
      ok: composed.eventsP99Ms <= ENVELOPE.eventsP99Ms,
      detail: `${composed.eventsP99Ms} ms <= ${ENVELOPE.eventsP99Ms} ms`,
    },
  ];
  const ok = checks.every((c) => c.ok);

  const record = {
    tool: 'tools/ipcprobe.mjs',
    label: LABEL,
    command: `electron tools/ipcprobe.mjs${argv.length ? ` ${argv.join(' ')}` : ''}`,
    when: new Date().toISOString(),
    sha: gitSha(),
    electron: process.versions.electron,
    shape: 'a: one batched IPC per frame each way, synchronous drain from a renderer-side buffer',
    config: { peers: PEERS, hz: HZ, entities: ENTITIES, runS: RUN_S, warmupS: WARMUP_S, eventHz: EVENT_HZ, snapshotBytes: SNAPSHOT_BYTES, eventBytes: EVENT_BYTES },
    frames: result.frames,
    totals: {
      state: { sent: stateSent, received: stateRecv, lost: stateSent - stateRecv },
      events: { sent: eventSent, received: eventRecv, lost: eventSent - eventRecv },
    },
    addedLatencyMs: added,
    toFrameHookMs: toFrameHook,
    steamLegP99Ms: STEAM_LEG_P99,
    composedP99Ms: composed,
    envelope: ENVELOPE,
    checks,
    ok,
  };

  await mkdir(path.dirname(RECORD), { recursive: true });
  await writeFile(RECORD, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`shape (a): ${PEERS} peers, ${HZ} Hz, ${SNAPSHOT_BYTES} B snapshots, ${RUN_S} s measured`);
  console.log(`  added   state p99 ${added.state.p99} ms (p50 ${added.state.p50}, max ${added.state.max}, n ${added.state.n})`);
  console.log(`  added   events p99 ${added.events.p99} ms (p50 ${added.events.p50}, max ${added.events.max}, n ${added.events.n})`);
  console.log(`  to-hook state p99 ${toFrameHook.state.p99} ms, events p99 ${toFrameHook.events.p99} ms (adds the game's frame quantisation, which the WebRTC baseline never counted either)`);
  console.log(`  composed state p99 ${composed.stateP99Ms} ms vs ${ENVELOPE.stateP99Ms} ms`);
  console.log(`  composed events p99 ${composed.eventsP99Ms} ms vs ${ENVELOPE.eventsP99Ms} ms`);
  for (const c of checks) console.log(`  ${c.ok ? 'PASS ' : 'FAIL '} ${c.name}  -- ${c.detail}`);
  console.log(`record: ${path.relative(root, RECORD)}`);

  win.destroy();
  app.exit(ok ? 0 : 1);
});
