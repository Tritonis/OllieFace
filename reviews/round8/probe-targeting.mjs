/**
 * Does an enemy in a real co-op session ever attack anyone but the host?
 *
 *   node reviews/round8/probe-targeting.mjs --players 2 --netlag 0  --out reviews/round8/n1/2p-lag0.json
 *   node reviews/round8/probe-targeting.mjs --players 4 --netlag 60 --out reviews/round8/n1/4p-lag60.json
 *
 * Seven review rounds measured co-op with two pages on one machine and never
 * once measured who was being hit. HEAD before this branch reads **78 directed
 * enemy hits on the host and 0 on a pawn standing 3 m away over 30 s**, with an
 * enemy 6.3 m from the pawn still holding the host's position as its target.
 * This file is the instrument that decides whether that closed.
 *
 * WHAT IS DIFFERENT ABOUT THIS PROBE, and why it is not `sp-equivalence.mjs`
 * with more pages:
 *
 *  · **The clock cannot be pinned.** `sp-equivalence` stops the engine and hand
 *    drives `fixedUpdate`, which is what buys it determinism. A session is two
 *    to four browsers agreeing over WebRTC, and the `?netlag=` rig delays
 *    packets against `performance.now()`; a hand-driven page would advance
 *    `ctx.time` while the wire stood still and would measure a network that
 *    does not exist. So the measured window here is 30 s of *simulation* time
 *    read off `ctx.time` on the host with the real rAF loop running, and the
 *    run is not bit-reproducible. That is a property of the thing being
 *    measured, not a shortcut: a per-arm figure here is a sample, and the gate
 *    is written against effects (zero vs. non-zero, a 15% share) far larger
 *    than the run-to-run spread.
 *
 *  · **The liveness gate is per page and post-join.** `ctx.player._localTick`
 *    only advances in `Player._sampleCommand`, and `Player.fixedUpdate` skips
 *    that entirely once `ctx.netRole === 'client'` (`Player.js:371`) — so on a
 *    joined client the field freezes at whatever it reached before the join and
 *    would pass a liveness gate for ever afterwards while the page sat dead.
 *    A client's live counter is `NetClient.tick`, which increments once per
 *    fixed step and only while `connected` (`NetClient.js:233-235`). Both are
 *    gated, before *and* after the join, on every page. Multiple prior
 *    instruments in this repo produced clean-looking numbers while the pages
 *    sat on survivor-select; this one refuses to install its accumulator until
 *    every page proves it is playing, and writes `<out>.FAILED.json` and exits
 *    non-zero when one does not.
 *
 * THE FIXTURE, and what each piece buys:
 *
 *  · Players are **parked**: the host stays where it spawned, and each remote
 *    pawn is placed on a `RING_RADIUS` circle around it, host-side. Every
 *    player's position is re-asserted every animation frame, with the drift it
 *    absorbed recorded (`maxDriftMetres`) so a reader can see the fixture was
 *    holding something back rather than being a no-op. Without it, knockback
 *    walks the pawns out of the geometry the measurement is about.
 *
 *  · Players are **held alive**, by restoring health immediately *before* each
 *    hit lands rather than after: `Combat._kill` runs inside `applyDamage`, so
 *    a post-hoc restore resurrects nothing. Damage is measured, never
 *    prevented, and the amount recorded is the amount that landed. A dead
 *    player leaves the roster's targetable set and every enemy in the arena
 *    re-acquires — which would turn a targeting measurement into a measurement
 *    of who died first.
 *
 *  · Nobody shoots. The survivors' own aim is not under test here and a fixture
 *    that fights back changes the enemy population mid-window.
 *
 * WHAT IS WRITTEN: every damage event with its target, type, source and time;
 * a full per-second census of every player and every living enemy with that
 * enemy's target and its distance to each player. No summarisation — the
 * `derived` block at the end of the file is computed from those arrays in this
 * process and is reproducible from the raw arrays alone.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// The dev-server port. Not a range: it has to be free, and it has to differ
// from every other probe's — `tools/` uses 5202/5203 and `tests/sp-equivalence`
// holds 5209, so a capture running alongside this one would otherwise fail with
// a port-in-use error that reads as a networking bug in the game.
const PORT = 5211;

// One arbitrary but fixed world. Any value works; changing it changes which
// stage every arm is measured on, so the four arms must share it or their
// enemy populations are not comparable.
const SEED = 20260804;

// Metres from the host each remote pawn is parked at. The brief's figure, and
// the same 3 m the HEAD measurement was taken at. Much closer and the two
// players are inside each other's engagement radius, so every enemy is
// equidistant and a targeting bug is invisible; much further and the pawn is
// outside the aggro radius of the enemies the Director spawns near the host, so
// zero hits on it would mean "nobody walked over there" rather than "nobody
// targeted it".
const RING_RADIUS = 3;

// Seconds of play after everyone has joined and been parked, before the
// accumulator is installed. Too few and the window opens during the join
// transient — pawns still being placed, the Director still banking its first
// credits, no enemy within reach of anyone — and measures the handshake instead
// of the fight; too many and each arm costs minutes for a stage the Director
// has already pinned at its population cap, where a targeting change moves
// nothing.
const SETTLE_SEC = 20;

// The measured window, in simulation seconds. The brief's 30 s, and the window
// the HEAD figure of 78/0 was taken over, so a shorter one is not comparable
// against it. Longer costs wall clock in every arm without adding a behaviour
// the enemies have not already shown.
const MEASURE_SEC = 30;

// Census interval, in simulation seconds. At 1 s a 30 s window yields 30
// censuses, which is enough to see a target held or flipped across the window;
// much coarser and a re-acquisition that happened and reverted is invisible,
// much finer and the file is dominated by rows that repeat the previous row
// because `RETARGET_INTERVAL` is 0.5 s and nothing can have changed.
const SAMPLE_SEC = 1;

// Ceiling on waiting for `ctx.stage` after a page load. Too low and a cold Vite
// transform of the whole module graph fails a good build; too high and a page
// that threw during boot — where `ctx.stage` never appears — is
// indistinguishable from a slow one for that long.
const STAGE_TIMEOUT_MS = 90000;

// Ceiling on a liveness gate. Too low and a cold shader compile on a slow
// machine fails a build that is fine; too high and a page genuinely stuck on a
// menu burns that long before saying so. Four pages pay this in the worst case.
const LIVE_GATE_MS = 60000;

// Fixed steps a page must have taken before it counts as playing. Too low (1,
// say) and a page that stepped once during a menu transition passes a gate
// meant to prove sustained play; too high and the gate outlives a legitimately
// slow first stage and fails a build whose only sin is a long terrain build.
const LIVE_TICK_FLOOR = 60;

// Ceiling on one join round trip (invite → answer → accept → pawn on the host).
// Too low and a handshake slowed by the `?netlag=` rig itself is reported as a
// broken join; too high and a peer the host refused — where no pawn will ever
// appear — hangs the arm instead of failing it. `NetHost.HELLO_MAX_AGE_SEC`
// bounds the other side of this exchange, so a value far above it cannot save a
// join that is already lost.
const JOIN_TIMEOUT_MS = 45000;

// Ceiling on the single in-page evaluate that settles, measures and returns.
// Not an idle timeout — it is how long the measured session itself is allowed
// to take, and it must exceed `SETTLE_SEC + MEASURE_SEC` with room for a page
// running below real time. Too low and a slow machine loses a good arm at the
// last second; too high and a session that has stopped stepping hangs.
const MEASURE_TIMEOUT_MS = 300000;

// Wall-clock ceiling on each of the two in-page phases (the settle, then the
// measured window), enforced inside the page. Both are counted in *simulation*
// seconds, so a host running below real time takes proportionally longer in
// wall clock and nothing bounds that: the four-player arm sat inside the
// measured window for **20 minutes** and had to be killed, which destroyed the
// evidence of how slow it had been. Too low and a loaded four-page session is
// failed while it is still making progress; too high and a stalled page is
// indistinguishable from a slow one for that long. Six minutes is about seven
// times the wall clock the two-player arms needed for the same phase.
const PHASE_BUDGET_MS = 360000;

// How often node asks the page how far it has got. Too frequent and the poll
// competes with the simulation it is measuring; too rare and a phase budget
// expires with only one or two progress lines to explain why.
const PROGRESS_POLL_MS = 20000;

// Rounding on metres and damage in the raw file. 1e-3 is a millimetre and a
// thousandth of a point of damage: four orders of magnitude below anything that
// distinguishes one target from another, and coarse enough that the file is
// readable. Rounder (1e-1) and two enemies at the same distance stop being
// distinguishable; raw floats add nothing but noise.
const R = 1e3;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const players = Number(arg('--players', '2'));
const netlag = String(arg('--netlag', '0'));
const outPath = arg('--out');

if (!Number.isInteger(players) || players < 2 || players > 4) {
  console.error(`--players must be 2..4 (NetHost's default maxPlayers is 4); got ${arg('--players')}`);
  process.exit(2);
}
if (!outPath) {
  console.error('--out is required: every figure quoted downstream has to name the file it came from.');
  process.exit(2);
}

const round = (n) => Math.round(n * R) / R;

const write = (path, obj) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
  console.log(`wrote ${path}`);
};

const fail = (why, detail) => {
  const path = outPath.replace(/\.json$/, '') + '.FAILED.json';
  write(path, { failed: why, detail, argv: process.argv.slice(2), at: new Date().toISOString() });
  console.error(`ARM FAILED — ${why}`);
  console.error(JSON.stringify(detail, null, 2));
  process.exitCode = 1;
};

let server = null;
let browser = null;
let armFailure = null;
let result = null;
const pageErrors = [];
const consoleLines = [];

try {
  server = await createServer({ server: { port: PORT, hmr: false, watch: null }, logLevel: 'error' });
  await server.listen();

  // Headed for the real GPU path, parked off the visible desktop so probe runs
  // never appear on the user's screen. Set CAPTURE_VISIBLE=1 to watch.
  const OFFSCREEN = process.env.CAPTURE_VISIBLE
    ? []
    : ['--window-position=-2400,-2400', '--window-size=1280,720'];
  // The four anti-throttling flags are not boilerplate — without them this
  // probe cannot measure a session at all, and the failure is silent. Chromium
  // throttles rAF and timers in a window that is occluded or not focused, and
  // this rig deliberately parks every window off the visible desktop, so at any
  // moment at most one page is being driven and the rest are backgrounded.
  // Measured on the `--netlag 60` arm before they were added: while Playwright
  // waited on the client, the host page took **209 fixed steps in ~90 s of wall
  // clock** (`ctx.time` 3.48) — about 2 ticks per second. `Peer.pumpSim` is
  // called from `NetHost.update`/`NetClient.update`, i.e. once per frame, so a
  // 2 Hz page releases delayed packets in 500 ms lumps and the handshake dies
  // inside `HELLO_MAX_AGE_SEC`. The arm failed twice — once as `peerRefused`,
  // once as the client dropping to `disconnected` — and both read as a netcode
  // fault under latency rather than as a browser that had stopped running the
  // game.
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      ...OFFSCREEN,
    ],
  });

  // `?netlag=` is passed explicitly on every arm including the zero one, so the
  // condition each page ran under is visible in the URL recorded in the output
  // rather than inferred from an absent flag. `netSim()` reads `'0'` as off and
  // arms nothing, which is the same shipped path an absent flag takes.
  const url = `http://127.0.0.1:${PORT}/?seed=${SEED}&quality=1&harness=1&netlag=${encodeURIComponent(netlag)}`;

  // One browser *context* per player, not one page: contexts have separate
  // storage, and `NetConfig` persists every query param it reads into
  // localStorage. Sharing a context would let one arm's `?netlag=60` survive
  // into a later page that asked for none.
  const peers = [];
  for (let i = 0; i < players; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(MEASURE_TIMEOUT_MS);
    page.on('pageerror', (e) => pageErrors.push({ player: i, message: e.message }));
    // `[net]` warnings are the only trace some net-layer decisions leave, and a
    // refused join says more on the console than it does in any field.
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'warning' || t === 'error') consoleLines.push({ player: i, type: t, text: m.text().slice(0, 500) });
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: STAGE_TIMEOUT_MS });
    peers.push({ i, page, context, role: i === 0 ? 'host' : 'client' });
    console.log(`[probe] page ${i} loaded (${i === 0 ? 'host' : 'client'})`);
  }

  // `__HARNESS__.dismiss()` and not `__HARNESS__.gameplay()`: the latter is a
  // screenshot scenario that freezes the engine and clears the arena, which is
  // the opposite of what a live session needs.
  for (const p of peers) await p.page.evaluate(() => globalThis.__HARNESS__.dismiss());

  const snapshotOf = (page) => page.evaluate(() => {
    const { ctx, engine } = globalThis.__GAME__;
    const net = ctx.lobby?.net ?? null;
    return {
      paused: ctx.paused,
      engineRunning: engine.running,
      menuScreen: ctx.hud?.menus?.screen ?? null,
      netRole: ctx.netRole,
      authority: ctx.authority,
      lobbyMode: ctx.lobby?.mode ?? null,
      lobbyStatus: ctx.lobby?.status ?? null,
      // The whole content of a refusal is in the detail — `peerRefused` on its
      // own says a join failed and not one word about why.
      lobbyStatusDetail: ctx.lobby?.statusDetail ?? null,
      localTick: ctx.player?._localTick ?? null,
      clientTick: net && typeof net.tick === 'number' ? net.tick : null,
      clientConnected: net ? net.connected === true : null,
      survivorId: ctx.player?.survivorId ?? ctx.survivorId ?? null,
      ctxTime: +(ctx.time ?? 0).toFixed(3),
      rosterCount: ctx.roster?.all?.length ?? -1,
      pawnCount: ctx.coop?.pawns?.length ?? -1,
      enemiesAlive: (ctx.director?.enemies ?? []).filter((e) => e.alive).length,
      playerAlive: ctx.player?.alive === true,
      frameErrors: ctx.frameErrors,
      lastFrameError: ctx.lastFrameError ?? null,
    };
  });

  // --- gate 1: every page is playing, before anyone joins -------------------
  const preJoinGate = [];
  for (const p of peers) {
    try {
      await p.page.waitForFunction(
        (floor) => globalThis.__GAME__.ctx.paused === false
          && (globalThis.__GAME__.ctx.player?._localTick ?? 0) > floor,
        LIVE_TICK_FLOOR, { timeout: LIVE_GATE_MS },
      );
      preJoinGate.push({ player: p.i, gate: 'fired', ...(await snapshotOf(p.page)) });
    } catch (e) {
      preJoinGate.push({ player: p.i, gate: 'TIMED OUT', detail: String(e?.message ?? e), ...(await snapshotOf(p.page)) });
    }
  }
  console.log(`[probe] pre-join liveness: ${preJoinGate.map((g) => `${g.player}:${g.gate}`).join(' ')}`);
  if (preJoinGate.some((g) => g.gate !== 'fired')) {
    armFailure = ['a page never reached live gameplay before joining', { preJoinGate, consoleLines }];
    throw new Error('pre-join gate');
  }

  // --- the manual invite path, once per client ------------------------------
  // Exactly the calls `Menus.coopAction` makes for the `coop-invite`,
  // `coop-join` and `coop-accept` buttons — the blobs are carried between pages
  // here instead of by a human with a clipboard.
  const host = peers[0];
  const joins = [];
  for (let k = 1; k < peers.length; k++) {
    const client = peers[k];
    const t0 = Date.now();
    const invite = await host.page.evaluate(async () => {
      const inv = await globalThis.__GAME__.ctx.lobby.createInvite();
      return inv.blob;
    });
    const answer = await client.page.evaluate(
      async (blob) => await globalThis.__GAME__.ctx.lobby.joinManual(blob), invite,
    );
    await host.page.evaluate(async (a) => { await globalThis.__GAME__.ctx.lobby.acceptAnswer(a); }, answer);
    await host.page.waitForFunction(
      (n) => (globalThis.__GAME__.ctx.coop?.pawns?.length ?? 0) >= n, k, { timeout: JOIN_TIMEOUT_MS },
    );
    await client.page.waitForFunction(
      () => globalThis.__GAME__.ctx.lobby?.net?.connected === true, null, { timeout: JOIN_TIMEOUT_MS },
    );
    joins.push({
      player: k, ms: Date.now() - t0,
      inviteBytes: invite.length, answerBytes: answer.length,
      hostPawnCount: await host.page.evaluate(() => globalThis.__GAME__.ctx.coop.pawns.length),
    });
    console.log(`[probe] player ${k} joined in ${joins[joins.length - 1].ms} ms`);
  }

  // --- gate 2: every page is playing, after the joins -----------------------
  // The host is still gated on `_localTick`; a client is gated on
  // `NetClient.tick`, because `_localTick` is frozen from the moment
  // `ctx.netRole` became 'client' and would pass a stale value for ever.
  //
  // Waited on **concurrently**, and that is not a speed optimisation: the world
  // keeps running while this gate waits, nothing is holding the pawns alive
  // yet, and one page that will never satisfy it costs `LIVE_GATE_MS` of live
  // fighting *per page* when they are awaited in turn. Measured on the
  // four-player latency arm: one client's channel closed, the gate then spent a
  // minute on it, and by the time it reached players 2 and 3 both were on the
  // death screen — three separate-looking failures produced by waiting.
  const postJoinGate = await Promise.all(peers.map(async (p) => {
    const isHost = p.role === 'host';
    try {
      await p.page.waitForFunction(
        ({ floor, isHost: h }) => {
          const { ctx } = globalThis.__GAME__;
          if (ctx.paused !== false) return false;
          if (h) return (ctx.player?._localTick ?? 0) > floor;
          const net = ctx.lobby?.net;
          return net?.connected === true && (net.tick ?? 0) > floor;
        },
        { floor: LIVE_TICK_FLOOR, isHost }, { timeout: LIVE_GATE_MS },
      );
      return { player: p.i, role: p.role, gate: 'fired', ...(await snapshotOf(p.page)) };
    } catch (e) {
      return { player: p.i, role: p.role, gate: 'TIMED OUT', detail: String(e?.message ?? e), ...(await snapshotOf(p.page)) };
    }
  }));
  console.log(`[probe] post-join liveness: ${postJoinGate.map((g) => `${g.player}:${g.gate}`).join(' ')}`);
  if (postJoinGate.some((g) => g.gate !== 'fired')) {
    armFailure = ['a page was not live after joining', { postJoinGate, joins, consoleLines }];
    throw new Error('post-join gate');
  }

  // The session really has the requested number of players in it, on the
  // authority. A roster short of `players` means a peer was refused, and every
  // number below would then describe a smaller session than the arm claims.
  const rosterCheck = await host.page.evaluate(() => {
    const { ctx } = globalThis.__GAME__;
    return {
      rosterCount: ctx.roster.all.length,
      pawnCount: ctx.coop.pawns.length,
      netPlayerCount: ctx.lobby?.net?.playerCount ?? -1,
      // Direct evidence the `?netlag=` rig is armed on the wire this arm ran
      // over, rather than an inference from the URL: `Peer.installSim` is only
      // called when `netSim().on`, so `_sim` is null on an unarmed peer.
      peerSim: [...(ctx.lobby?.net?.clients?.values?.() ?? [])].map((c) => ({
        id: c.peer?.id ?? null,
        sim: c.peer?._sim ? { lagMs: c.peer._sim.lagMs, jitterMs: c.peer._sim.jitterMs, lossPct: c.peer._sim.lossPct } : null,
        rtt: c.peer?.rtt ?? null,
        survivorId: c.survivorId ?? null,
      })),
    };
  });
  if (rosterCheck.rosterCount !== players) {
    armFailure = ['the host roster does not hold every player', { rosterCheck, postJoinGate, joins, consoleLines }];
    throw new Error('roster');
  }

  // --- park, settle, measure ------------------------------------------------
  console.log(`[probe] parking and measuring: ${SETTLE_SEC} s settle + ${MEASURE_SEC} s window, in simulation seconds`);
  // Polled from node while the measure evaluate is pending. The page's JS is
  // single-threaded, but the loops inside await timers, so this lands between
  // them — and it is the only thing that makes a slow session legible as slow
  // rather than as hung.
  let measuring = true;
  const progress = (async () => {
    while (measuring) {
      await new Promise((r) => setTimeout(r, PROGRESS_POLL_MS));
      if (!measuring) break;
      const b = await host.page.evaluate(() => globalThis.__PROBE__ ?? null).catch(() => null);
      if (b) console.log(`[probe] ${b.phase}: sim +${(b.simNow - b.simFrom).toFixed(1)} s in ${(b.wallMs / 1000).toFixed(0)} s wall, ${b.samples} samples`);
    }
  })();

  result = await host.page.evaluate(
    async ({ ringRadius, settleSec, measureSec, sampleSec, r, phaseBudgetMs }) => {
      const { ctx, THREE } = globalThis.__GAME__;
      const rnd = (n) => Math.round(n * r) / r;
      const hostPlayer = ctx.player;
      const keyOf = (p) => (p === hostPlayer ? 'host' : p?.peerId != null ? `pawn${p.peerId}` : 'unknown');
      const horiz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));

      // Park: the host stays put, the pawns go onto a ring around it.
      const anchors = new Map();
      anchors.set(hostPlayer, hostPlayer.position.clone());
      const pawns = ctx.coop.pawns.slice();
      pawns.forEach((p, i) => {
        const a = (i / pawns.length) * Math.PI * 2;
        const x = hostPlayer.position.x + Math.cos(a) * ringRadius;
        const z = hostPlayer.position.z + Math.sin(a) * ringRadius;
        const y = ctx.stage?.sampleHeight?.(x, z);
        anchors.set(p, new THREE.Vector3(x, typeof y === 'number' && isFinite(y) ? y + 0.2 : hostPlayer.position.y, z));
      });

      let pinFrames = 0;
      let maxDrift = 0;
      let running = true;
      const pin = () => {
        for (const [p, a] of anchors) {
          const d = horiz(p.position, a);
          if (d > maxDrift) maxDrift = d;
          p.position.copy(a);
          p.velocity?.set?.(0, 0, 0);
        }
        pinFrames++;
        if (running) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);

      const parked = [...anchors.entries()].map(([p, a]) => ({
        key: keyOf(p), anchor: [rnd(a.x), rnd(a.y), rnd(a.z)],
        distanceToHost: rnd(horiz(a, anchors.get(hostPlayer))),
      }));

      // Progress beacon. The four-player arm spent twenty minutes inside this
      // function with nothing on stdout, which is indistinguishable from a
      // hang. `node` polls this between the awaits below.
      const beacon = { phase: 'settle', simFrom: ctx.time, simNow: ctx.time, wallMs: 0, samples: 0 };
      globalThis.__PROBE__ = beacon;
      const wallFrom = performance.now();
      const tick = (phase, from) => {
        beacon.phase = phase;
        beacon.simFrom = from;
        beacon.simNow = ctx.time;
        beacon.wallMs = Math.round(performance.now() - wallFrom);
      };

      /* --- the accumulator, installed BEFORE the settle -------------------
       *
       * Wrapped around `Combat.applyDamage` rather than subscribed to the
       * `damage` event, and the reason is load-bearing: the event payload
       * (`Combat.js:478-481`) carries no `type` field at all, so a subscriber
       * cannot tell a directed hit from a blast — the exact distinction this
       * measurement is about. `info` is a shared mutable scratch object
       * (`Enemy.js:33`), so every field is read synchronously here.
       *
       * It goes in before the settle and not at the window, because the *hold
       * alive* half of it has to cover the settle too. Measured with it
       * installed at the window instead: the four-player arm opened its window
       * with **three of its four players already dead** — host, pawn1 and pawn3
       * all at `alive: false, health: 0` in the first census — and the whole
       * 30 s then read as 119 directed hits on the one survivor and 0 on
       * everyone else, at a tidy-looking `targetIsNearestFraction` of 1.0. It
       * was 1.0 because a corpse is not a legal target: the file described a
       * mobbing, not a targeting split, and nothing in it said so. `recording`
       * keeps the *measurement* to the window while the fixture runs across
       * both phases.
       */
      const damage = [];
      let healthRestoredSettle = 0;
      let healthRestoredWindow = 0;
      let deaths = 0;
      let recording = false;
      const combat = ctx.combat;
      const realApplyDamage = combat.applyDamage.bind(combat);
      combat.applyDamage = function probeApplyDamage(target, amount, info = {}) {
        const isPlayer = target?.isPlayer === true;
        if (isPlayer) {
          // Held alive *before* the hit: `Combat._kill` runs inside
          // `applyDamage`, so restoring afterwards resurrects nothing. The
          // amount recorded is still the amount that landed.
          if (target.maxHealth > 0 && target.health < target.maxHealth) {
            const back = target.maxHealth - target.health;
            if (recording) healthRestoredWindow += back; else healthRestoredSettle += back;
            target.health = target.maxHealth;
          }
          if (recording) {
            damage.push({
              t: rnd(ctx.time),
              target: keyOf(target),
              type: info.type ?? null,
              amount: rnd(amount),
              source: info.source?.def?.id ?? (info.source?.isPlayer ? 'player' : null),
              sourceAffix: info.source?.affix ?? null,
              sourceDist: info.source?.position ? rnd(horiz(info.source.position, target.position)) : null,
            });
          }
        }
        const out = realApplyDamage(target, amount, info);
        if (isPlayer && target.alive === false) deaths++;
        return out;
      };

      // Settle, in simulation seconds — a page running below real time must get
      // the settle it was asked for, not the wall clock's idea of it. Bounded in
      // wall clock so a page that cannot keep up reports that instead of hanging.
      const settleFrom = ctx.time;
      while (ctx.time - settleFrom < settleSec) {
        if (performance.now() - wallFrom > phaseBudgetMs) {
          running = false;
          return {
            aborted: 'the settle phase never completed inside its wall-clock budget',
            beacon: { ...beacon }, simAdvanced: ctx.time - settleFrom, settleSec, phaseBudgetMs,
          };
        }
        tick('settle', settleFrom);
        await wait(100);
      }

      const census = () => {
        const roster = ctx.roster.all;
        const plist = roster.map((p) => ({
          key: keyOf(p),
          pos: [rnd(p.position.x), rnd(p.position.z)],
          alive: p.alive !== false,
          downed: p.downed === true,
          health: rnd(p.health ?? 0),
          maxHealth: rnd(p.maxHealth ?? 0),
        }));
        const enemies = [];
        for (const e of ctx.director?.enemies ?? []) {
          if (!e.alive) continue;
          const dists = roster.map((p) => rnd(horiz(e.position, p.position)));
          let nearest = null;
          let nearestD = Infinity;
          roster.forEach((p, i) => {
            if (p.alive === false || p.downed === true) return;
            if (dists[i] < nearestD) { nearestD = dists[i]; nearest = keyOf(p); }
          });
          enemies.push({
            id: e.def?.id ?? null,
            pos: [rnd(e.position.x), rnd(e.position.z)],
            target: e.targetPlayer ? keyOf(e.targetPlayer) : null,
            distToTarget: rnd(e.distToPlayer ?? -1),
            // Index-aligned with `players` in this same sample.
            distToPlayers: dists,
            nearestPlayer: nearest,
            state: e.fsm?.state == null ? null : String(e.fsm.state),
          });
        }
        return { t: rnd(ctx.time), wallMs: Math.round(performance.now()), players: plist, enemies };
      };

      /* The window-open gate: everyone in the roster is a legal target.
       *
       * A dead player is not targetable (`Roster.targetable`), so an arm that
       * opens on a corpse cannot measure a targeting split at all — every
       * enemy in it is correct to converge on whoever is left, and the file
       * reads as 100% of hits on one player with perfect proximity agreement.
       * That is exactly what the first four-player capture produced. Failing
       * here is the difference between reporting that and publishing it. */
      const openGate = ctx.roster.all.map((p) => ({
        key: keyOf(p), alive: p.alive !== false, downed: p.downed === true,
        health: rnd(p.health ?? 0), maxHealth: rnd(p.maxHealth ?? 0),
      }));
      if (openGate.some((g) => !g.alive || g.downed)) {
        combat.applyDamage = realApplyDamage;
        running = false;
        return {
          aborted: 'a player was not a legal target when the window opened',
          openGate, deathsBeforeWindow: deaths, healthRestoredSettle: rnd(healthRestoredSettle),
        };
      }

      recording = true;
      const samples = [];
      const from = ctx.time;
      const windowWallFrom = performance.now();
      let nextAt = from;
      let aborted = null;
      while (ctx.time - from < measureSec) {
        if (performance.now() - windowWallFrom > phaseBudgetMs) {
          aborted = 'the measured window never completed inside its wall-clock budget';
          break;
        }
        if (ctx.time >= nextAt) { samples.push(census()); nextAt += sampleSec; beacon.samples = samples.length; }
        tick('window', from);
        await wait(50);
      }
      samples.push(census());
      if (aborted) {
        combat.applyDamage = realApplyDamage;
        running = false;
        return {
          aborted, beacon: { ...beacon }, simAdvanced: ctx.time - from,
          measureSec, phaseBudgetMs, samplesTaken: samples.length,
        };
      }

      combat.applyDamage = realApplyDamage;
      running = false;

      return {
        parked,
        window: { fromCtxTime: rnd(from), toCtxTime: rnd(ctx.time), measureSec, sampleSec },
        openGate,
        fixture: {
          pinFrames,
          maxDriftMetres: rnd(maxDrift),
          healthRestoredSettle: rnd(healthRestoredSettle),
          healthRestoredWindow: rnd(healthRestoredWindow),
          deathsTotal: deaths,
          ringRadius,
        },
        damage,
        samples,
        frameErrors: ctx.frameErrors,
        lastFrameError: ctx.lastFrameError ?? null,
      };
    },
    { ringRadius: RING_RADIUS, settleSec: SETTLE_SEC, measureSec: MEASURE_SEC, sampleSec: SAMPLE_SEC, r: R, phaseBudgetMs: PHASE_BUDGET_MS },
  );
  measuring = false;
  await progress;

  if (result.aborted) {
    armFailure = [result.aborted, result];
    throw new Error('in-page abort');
  }

  const finalState = [];
  for (const p of peers) finalState.push({ player: p.i, role: p.role, ...(await snapshotOf(p.page)) });

  result.diagnostics = { preJoinGate, postJoinGate, joins, rosterCheck, finalState, url, pageErrors, consoleLines };
} catch (e) {
  if (!armFailure) armFailure = ['the arm threw', { message: String(e?.message ?? e), stack: String(e?.stack ?? ''), pageErrors, consoleLines }];
} finally {
  await browser?.close();
  await server?.close();
}

if (armFailure) {
  fail(armFailure[0], armFailure[1]);
} else if (pageErrors.length) {
  fail('a page threw during the session — the numbers are not trustworthy', { pageErrors, diagnostics: result?.diagnostics });
} else {
  // Derived from the raw arrays above and nothing else — every figure here is
  // recomputable from `damage` and `samples` by a reader who distrusts it.
  const keys = result.samples[0].players.map((p) => p.key);
  const directed = result.damage.filter((d) => d.type !== 'blast');
  const perPlayer = {};
  for (const k of keys) {
    const dirHits = directed.filter((d) => d.target === k);
    const allHits = result.damage.filter((d) => d.target === k);
    const targeting = result.samples.map((s) => s.enemies.filter((e) => e.target === k).length);
    perPlayer[k] = {
      directedHits: dirHits.length,
      directedDamage: round(dirHits.reduce((a, d) => a + d.amount, 0)),
      allHits: allHits.length,
      allDamage: round(allHits.reduce((a, d) => a + d.amount, 0)),
      hitTypes: allHits.reduce((m, d) => { m[d.type ?? 'null'] = (m[d.type ?? 'null'] || 0) + 1; return m; }, {}),
      enemiesTargetingPerSample: targeting,
      enemiesTargetingMean: round(targeting.reduce((a, b) => a + b, 0) / targeting.length),
      enemiesTargetingMax: Math.max(...targeting),
    };
  }
  const totalDirected = directed.length;
  for (const k of keys) {
    perPlayer[k].directedShare = totalDirected ? round(perPlayer[k].directedHits / totalDirected) : null;
  }
  // Proximity, not identity: over every enemy in every census, how often the
  // held target was also the nearest targetable player. Hysteresis
  // (`SWITCH_MARGIN`) means a correct system is below 1.0 by construction, so
  // this is evidence to read rather than a threshold to pass.
  let enemyRows = 0;
  let targetIsNearest = 0;
  let noTarget = 0;
  for (const s of result.samples) {
    for (const e of s.enemies) {
      enemyRows++;
      if (!e.target) noTarget++;
      else if (e.target === e.nearestPlayer) targetIsNearest++;
    }
  }
  const out = {
    arm: { players, netlag, seed: SEED, out: outPath, argv: process.argv.slice(2), at: new Date().toISOString() },
    derived: {
      totalDirectedHits: totalDirected,
      totalHits: result.damage.length,
      perPlayer,
      enemyCensusRows: enemyRows,
      enemyRowsWithNoTarget: noTarget,
      enemyRowsTargetingNearest: targetIsNearest,
      targetIsNearestFraction: enemyRows ? round(targetIsNearest / enemyRows) : null,
    },
    raw: result,
  };
  write(outPath, out);
  console.log(JSON.stringify(out.derived.perPlayer, null, 2));
}
