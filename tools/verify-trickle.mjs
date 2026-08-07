/**
 * Does trickle ICE actually shorten a real join? — the room-code path, measured.
 *
 *   node tools/verify-trickle.mjs [--joins 4] [--port 5599] [--headed]
 *
 * The number to beat is this branch's own: twelve real four-player joins over
 * the *manual* path came in at 0.6-1.2 s when neither side hit `waitForIce`'s
 * cap and 3.3-10.9 s when one or both did — the bimodal spread whose cause is
 * documented in reviews/audit-fixes/ice-quiescence-refuted.md. Trickle removes
 * both crossings of that wait on the relay path, so the prediction is a join
 * distribution with no upper mode at all: every join near the fast end, and the
 * spread collapsing rather than the mean merely improving. A run whose slowest
 * join is still multi-second has NOT reproduced the fix, whatever its average
 * says — print every join, not a mean.
 *
 * What this drives is the whole real path and nothing simulated: a real
 * `tools/signal-server.mjs` process on an ephemeral port, a real vite server,
 * two real Chromium pages, `Lobby.hostViaRelay` / `Lobby.joinViaRelay`, real
 * `RTCPeerConnection`s and real data channels. The unit tests
 * (tests/trickle-ice.test.mjs) pin the wiring against a fake peer connection;
 * only this can say whether a browser gathering real candidates against real
 * STUN servers connects faster, because the thing being removed is time spent
 * waiting for the network.
 *
 * ## Reading the output
 *
 * Per join: `ms` is wall time from the joiner calling `joinViaRelay` to that
 * joiner reporting `connected` with a netId and both data channels `open`.
 * `trickle` is what the page negotiated with the relay — if it is `false` the
 * measurement is of the OLD path and the run proves nothing about the new one
 * (that is the degrade working, but it is not this test).
 *
 * Exit code is 0 only if every join connected, every join negotiated trickle,
 * and both channels were open on both ends.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true;
}
const PORT = Number(args.port ?? 5599);
const JOINS = Number(args.joins ?? 1);

const out = { joins: [], steps: [] };
const log = (...a) => { console.log('[trickle]', ...a); out.steps.push(a.map(String).join(' ')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- the relay, on a port nothing else is using ---------------------------
 * `--port 0` and read the port back off its own startup line: a fixed port
 * collides with a relay the operator already has running, and this driver
 * exists to be run on a developer's machine mid-session.
 */
const relay = spawn(process.execPath, [joinPath(here, 'signal-server.mjs'), '--port', '0'],
  { stdio: ['ignore', 'pipe', 'inherit'] });
const SIGNAL_PORT = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('signal-server never printed a port')), 10000);
  relay.stdout.on('data', (b) => {
    const m = /ws:\/\/0\.0\.0\.0:(\d+)/.exec(String(b));
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
});
const SIGNAL_URL = `ws://localhost:${SIGNAL_PORT}`;
log('relay up on', SIGNAL_URL);
out.signalUrl = SIGNAL_URL;

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  timeout: 180000,
  // Headed, not headless, and the same flag set probe-targeting.mjs proved
  // out: headless Chromium software-renders the THREE scene and the page's
  // load event has been observed never firing inside 180 s. (The first cut of
  // this file tried `--force_high_performance_gpu` headless; that flag does
  // nothing on Windows — docs/STEAM.md cites the Electron issue — and the
  // host page never loaded.) The off-screen window position keeps a headed
  // run from splashing windows across the desktop.
  headless: false,
  args: [
    '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-position=-2400,-2400',
  ],
});

let failed = 0;
try {
  const mkPage = async (tag) => {
    const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
    p.on('pageerror', (e) => log(`${tag} pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') log(`${tag} console: ${m.text().slice(0, 200)}`); });
    // `?signal=` is the runtime override NetConfig reads (and persists), so the
    // pages point at the relay this process just started rather than at
    // whatever the build was configured with.
    await p.goto(`http://127.0.0.1:${PORT}/index.html?signal=${encodeURIComponent(SIGNAL_URL)}`,
      { waitUntil: 'load', timeout: 180000 });
    await p.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 120000 });
    await p.mouse.move(400, 300); await p.mouse.down(); await p.mouse.up();
    return p;
  };

  const A = await mkPage('HOST');
  log('host booted');

  const code = await A.evaluate(() => globalThis.__GAME__.ctx.lobby.hostViaRelay());
  out.code = code;
  out.hostTrickle = await A.evaluate(() => globalThis.__GAME__.ctx.lobby.net?.transport?.trickle ?? null);
  log('room', code, '| host negotiated trickle =', out.hostTrickle);
  if (out.hostTrickle !== true) {
    log('WARNING: the host did not negotiate trickle — every measurement below is of the OLD path');
  }

  for (let n = 0; n < JOINS; n++) {
    // Paired experiment: odd joins run the new trickle path, even joins force
    // the old non-trickle path by lying to the host's transport (exactly what
    // an old relay produces), so both modes share one run's STUN weather. The
    // first cut measured trickle alone at 5.3-6.8 s and had no way to say
    // whether that was the fix failing or the environment being slow that
    // minute — a control in the same run is the only comparison that means
    // anything here.
    const wantTrickle = n % 2 === 0;
    await A.evaluate((t) => { globalThis.__GAME__.ctx.lobby.net.transport.trickle = t; }, wantTrickle);

    // A live rAF loop on the host is what has starved a second page's load
    // past 180 s before now; park it across the load and thaw it before the
    // join, so the measurement covers a running host, not a frozen one.
    await A.evaluate(() => globalThis.__HARNESS__?.freeze?.());
    const B = await mkPage(`CLIENT${n + 1}`);
    await A.evaluate(() => globalThis.__HARNESS__?.thaw?.());
    await B.evaluate(() => globalThis.__HARNESS__?.thaw?.());
    log(`client ${n + 1} booted (mode: ${wantTrickle ? 'trickle' : 'control'})`);

    const t0 = Date.now();
    // Fire and do not await: `joinViaRelay` resolves when the answer is sent,
    // which under trickle is long before the channels open. What is being timed
    // is the connection, so the clock stops on the channel state.
    await B.evaluate((c) => { globalThis.__JOIN__ = globalThis.__GAME__.ctx.lobby.joinViaRelay(c); }, code);

    let ms = null, err = null;
    try {
      await B.waitForFunction(() => {
        const net = globalThis.__GAME__?.ctx?.net;
        const peer = net?.peer;
        return net?.connected === true && net.myNetId > 0
          && peer?.state?.readyState === 'open' && peer?.events?.readyState === 'open';
      }, null, { timeout: 45000 });
      ms = Date.now() - t0;
    } catch (e) {
      err = e.message.slice(0, 200);
      failed++;
    }

    const clientView = await B.evaluate(() => {
      const c = globalThis.__GAME__.ctx, net = c.net, peer = net?.peer;
      return {
        connected: !!net?.connected, myNetId: net?.myNetId ?? null,
        role: c.netRole, authority: c.authority,
        trickle: net?.transport?.trickle ?? null,
        state: peer?.state?.readyState ?? null, events: peer?.events?.readyState ?? null,
        status: c.lobby?.status ?? null,
      };
    });
    const hostView = await A.evaluate(() => {
      const net = globalThis.__GAME__.ctx.net;
      const peers = [...(net?.clients?.values() ?? [])].map((e) => ({
        id: e.peer?.id ?? null, pawn: !!e.pawn,
        state: e.peer?.state?.readyState ?? null, events: e.peer?.events?.readyState ?? null,
      }));
      return { playerCount: net?.playerCount ?? null, peers };
    });

    const bothOpen = clientView.state === 'open' && clientView.events === 'open'
      && hostView.peers.every((p) => p.state === 'open' && p.events === 'open');
    // A control join reading trickle=false is the control working; only a
    // trickle-mode join that failed to negotiate counts against the run.
    if (!bothOpen || (wantTrickle && clientView.trickle !== true)) failed++;

    out.joins.push({ n: n + 1, mode: wantTrickle ? 'trickle' : 'control', ms, err, bothOpen, client: clientView, host: hostView });
    log(`join ${n + 1} (${wantTrickle ? 'trickle' : 'control'}): ${ms ?? 'FAILED'} ms | trickle=${clientView.trickle}`
      + ` | channels ${clientView.state}/${clientView.events} | host sees ${hostView.playerCount} players${err ? ' | ' + err : ''}`);

    // Close the joiner so its lobby slot frees: the lobby caps at 4 players,
    // so a run that keeps every joiner connected refuses its 4th join — the
    // first cut did exactly that and burned two of five arms on "Lobby is
    // full". The comparison this driver exists for is per-join connect time,
    // not concurrent load.
    await B.close();
    await sleep(1000);
  }

  const byMode = (mode) => out.joins.filter((j) => j.mode === mode && j.ms != null).map((j) => j.ms);
  const stat = (a) => a.length ? { n: a.length, minMs: Math.min(...a), maxMs: Math.max(...a) } : { n: 0 };
  out.summary = {
    joins: out.joins.length,
    connected: out.joins.filter((j) => j.ms != null).length,
    // Judged over the joins that ran the new path; a control join reading
    // trickle=false is the control working, not the feature failing.
    trickleNegotiated: out.joins.filter((j) => j.mode === 'trickle')
      .every((j) => j.client?.trickle === true),
    trickle: stat(byMode('trickle')),
    control: stat(byMode('control')),
    manualPathBaseline: '0.6-1.2 s fast / 3.3-10.9 s when a side ate the 4 s cap '
      + '(reviews/audit-fixes/ice-quiescence-refuted.md)',
  };
  log('SUMMARY', JSON.stringify(out.summary));
} finally {
  await writeFile(joinPath(here, '..', 'reviews', 'parked', 'verify-trickle.json'),
    JSON.stringify(out, null, 2)).catch(() => {});
  await browser.close();
  await server.close();
  relay.kill();
}

console.log(JSON.stringify(out.summary ?? out, null, 2));
process.exit(failed ? 1 : 0);
