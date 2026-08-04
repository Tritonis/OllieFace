/**
 * A deterministic fingerprint of a single-player run.
 *
 *   node tests/sp-equivalence.mjs --out reviews/round8/baseline-HEAD.json
 *
 * The roster migration's whole safety argument is that a roster of one behaves
 * exactly as `ctx.player` did. This is the instrument that decides it. Capture
 * a baseline from HEAD's literal condition first — not from the current tree
 * and not from an approximation. "Single-player didn't move" was asserted
 * rather than measured once before, and a kill-counter regression survived a
 * whole review round inside that gap.
 *
 * Runs the real game under `?harness=1` — `Stage`, `VFX` and `RenderPipeline`
 * all need a document and a GL context, so a node-only fixture is not an
 * option and every prior attempt at one is deleted.
 *
 * HOW DETERMINISM IS OBTAINED, which is the whole deliverable:
 *
 * The sim is driven by hand from step zero. `Progression.fixedUpdate` builds
 * stage 1 on the *first* fixed step (`Progression.js:203`), and `Engine._frame`
 * runs no fixed step at all while `ctx.paused` is true — which it is for the
 * whole time the title screen is up. So a page sitting at the menu has taken
 * exactly zero simulation steps, whatever the frame rate or the GPU was doing.
 * This probe therefore dismisses the menu and stops the frame loop in the same
 * synchronous block, with no rAF in between, and then calls `fixedUpdate` on
 * every system itself. `ctx.time` starts at 0 and advances only where this file
 * advances it. Wall clock, frame pacing and GPU speed are out of the result by
 * construction, rather than by being averaged over.
 *
 * `Engine` has no stored rAF handle to cancel: `start()` runs a self-re-arming
 * `tick()` that retires on `!this.running || gen !== this._loopGen`
 * (`Engine.js:185-197`), and `stop()` is exactly `this.running = false`. So
 * `engine.stop()` is the mechanism, and the proof that it worked is the
 * `ctx.time` assertion below — a loop still running underneath us would push
 * `ctx.time` past `(PRE_STEPS + STEPS) / 60`.
 *
 * The liveness phase is not decoration. Several prior instruments in this repo
 * produced clean-looking numbers while the page sat on a menu, and hand-driving
 * `fixedUpdate` bypasses `ctx.paused` — so the pinned phase *cannot* detect
 * that failure on its own. Phase A runs the real rAF loop, unpinned, and gates
 * on it actually stepping before phase B is allowed to measure anything.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SEED = 20260804;

// 10 s of settle at a pinned 60 Hz before the measured window opens. Too few
// and the fingerprint is dominated by stage construction and the first spawn
// wave, where a one-step difference in spawn order moves every later number and
// the instrument reads as noisy; too many and the measured window opens on a
// stage the Director has already saturated to its population cap, where a
// targeting change moves nothing that is not already pinned at that cap.
const PRE_STEPS = 600;

// 60 s of measured window. Too few and slow-cadence behaviour — director
// spawn intervals, elite affixes, boss phases — never fires, so a regression in
// it cannot be seen; too many and each capture costs minutes, which is what
// stops a gate from being run on every task that is supposed to pass it.
const STEPS = 3600;

// Ceiling on the wall-clock liveness gate in phase A. Too low and a cold shader
// compile on a slow machine fails a build that is fine; too high and a page
// genuinely stuck on a menu burns that long before saying so.
const LIVE_GATE_MS = 45000;

// Ceiling on one hand-driven evaluate. The 4200-step block runs as a single
// synchronous task, so this is not an idle timeout — it is how long the sim
// itself is allowed to take. Too low and a slow machine fails a good run; too
// high and an infinitely-looping system hangs the probe instead of reporting.
const EVAL_TIMEOUT_MS = 600000;

// Rounding kept in the fingerprint. 1e-6 on world-space metres and on damage:
// the last bits of a float differ between GPU drivers and are not a regression,
// but a micrometre is four orders of magnitude below anything the game can do
// — a one-step change in a single enemy's steering moves it by ~0.05 m, and a
// single point of damage is 1.0. Round harder (say 1e-2) and small persistent
// drifts hide; round softer (raw floats) and the diff is noise.
const R = 1e6;

const PORT = 5209;

const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;

const server = await createServer({ server: { port: PORT, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

// Headed for the real GPU path, parked off the visible desktop so probe runs
// never appear on the user's screen. Set CAPTURE_VISIBLE=1 to watch.
const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', '--window-size=1280,720'];
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
});

const URL = `http://127.0.0.1:${PORT}/?seed=${SEED}&quality=1&harness=1`;

const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(EVAL_TIMEOUT_MS);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  return { page, errs };
};

// --- Phase A: does this build actually play? --------------------------------
// The real rAF loop, unpinned, against the exact fields the gate names. If this
// times out, the page is on a menu and nothing below is worth reading.
const a = await newPage();
await a.page.evaluate(() => globalThis.__HARNESS__.dismiss());
let liveness;
try {
  await a.page.waitForFunction(
    () => globalThis.__GAME__.ctx.paused === false
      && (globalThis.__GAME__.ctx.player?._localTick ?? 0) > 60,
    null, { timeout: LIVE_GATE_MS },
  );
  liveness = await a.page.evaluate(() => {
    const { ctx } = globalThis.__GAME__;
    return {
      gate: 'fired',
      paused: ctx.paused,
      localTick: ctx.player?._localTick ?? null,
      menuScreen: ctx.hud?.menus?.screen ?? null,
      time: +ctx.time.toFixed(3),
      engineRunning: globalThis.__GAME__.engine.running,
      stageIndex: ctx.progression?.stageIndex ?? null,
    };
  });
} catch (e) {
  liveness = { gate: 'TIMED OUT', detail: String(e?.message ?? e) };
}
await a.page.close();

if (liveness.gate !== 'fired') {
  console.error('LIVENESS GATE FAILED — the page never reached live gameplay:', liveness);
  await browser.close();
  await server.close();
  process.exit(1);
}

// --- Phase B: the pinned fingerprint ----------------------------------------
const b = await newPage();

const fingerprint = await b.page.evaluate(({ preSteps, steps, r }) => {
  const { engine, ctx } = globalThis.__GAME__;
  const H = 1 / 60;
  const round = (n) => Math.round(n * r) / r;

  // Dismiss and stop in one synchronous block: no rAF can land between them, so
  // the sim is guaranteed to have taken zero steps when the hand-driven loop
  // starts. `engine.stop()` is the mechanism — there is no rAF handle to cancel.
  globalThis.__HARNESS__.dismiss();
  engine.stop();

  const startState = {
    time: ctx.time,
    localTick: ctx.player?._localTick ?? null,
    progressionStarted: !!ctx.progression?._started,
  };

  /* The fixture, and what it buys.
   *
   * Left alone, the survivor stands still, never shoots, and is dead about
   * fifteen seconds into the measured window — a first capture recorded ten
   * damage events, zero kills and a peak of six monsters across 4200 steps,
   * with the last three thousand of them spent watching a corpse and a disabled
   * Director. That is an instrument that cannot see a targeting change, which
   * is the one thing this plan needs it to see.
   *
   * Three constant inputs fix it. Every one of them is a pure function of sim
   * state, so none can be a source of variance:
   *
   *  · Health is restored to full after every step, so the Director keeps
   *    banking credits and every enemy keeps having a live target for the whole
   *    window. Damage is *measured*, not prevented — this is deliberately not
   *    `__HARNESS__.invulnerable()`, which sets `_iframeUntil = Infinity` and
   *    would zero `damageToPlayer` outright.
   *
   *  · The trigger is held. `Input.endFrame()` lives in a `lateUpdate` this
   *    loop never calls, so the button stays down without being re-pressed.
   *
   *  · The lens is pointed at the nearest living enemy, and the rig and the
   *    camera's world matrix are stepped with it. Holding the trigger alone is
   *    not enough and this was measured, not assumed: `Player.aimRay` raycasts
   *    from `ctx.camera`, `CameraRig` only runs in `lateUpdate`, and
   *    `camera.matrixWorld` is only recomposed by the renderer — so with a
   *    fixed-step-only loop the survivor fired 75 aimed shots into a stale
   *    matrix and dealt 0 damage, with `kills`, `goldTotal` and
   *    `damageToEnemiesBySource` all reading as permanently-empty accumulators.
   *    With the lens driven: 198 damage, 2 kills, 10 gold over 1800 steps. An
   *    accumulator that cannot move is worse than no accumulator, because it
   *    looks like a measurement.
   *
   *    Aiming for the survivor is a fixture input and not the thing under test:
   *    this plan changes how *enemies* choose targets, not how the player does.
   *
   * What this deliberately does not cover: enemy behaviour with a *dead* target,
   * since the survivor never dies here. That path needs a test of its own.
   */
  ctx.input.mouse.left = true;

  const holdAlive = () => {
    const p = ctx.player;
    if (p && p.alive && p.maxHealth > 0) p.health = p.maxHealth;
  };

  // Yaw/pitch in `Player._sampleCommand`'s own convention: `atan2(x, z)` and
  // `asin(y)` of the bearing from the lens to the target's centre of mass.
  const aimAtNearest = () => {
    const p = ctx.player;
    const rig = ctx.cameraRig;
    if (!p || !rig) return;
    let best = null;
    let bestD = Infinity;
    for (const e of ctx.director?.enemies ?? []) {
      if (!e.alive) continue;
      const d = e.position.distanceToSquared(p.position);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return;
    const c = ctx.camera.position;
    const dx = best.position.x - c.x;
    const dy = (best.position.y + (best.height || 1.6) * 0.5) - c.y;
    const dz = best.position.z - c.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    rig.yaw = Math.atan2(dx, dz);
    rig.pitch = Math.asin(Math.min(1, Math.max(-1, dy / len)));
  };

  const step = (n) => {
    for (let i = 0; i < n; i++) {
      aimAtNearest();
      ctx.time += H;
      for (const s of engine.systems) if (s.fixedUpdate) s.fixedUpdate(ctx, H);
      // The two halves of a frame this loop still needs: the rig places the
      // lens, and `matrixWorld` is what `aimRay` actually reads.
      ctx.cameraRig?.lateUpdate?.(ctx, H);
      ctx.camera.updateMatrixWorld(true);
      holdAlive();
    }
  };

  step(preSteps);

  // The real gate. Hand-driving `fixedUpdate` bypasses `ctx.paused`, so "the
  // steps ran" proves nothing on its own — these fields do. A page still on
  // survivor-select fails every one of them.
  const gate = {
    paused: ctx.paused,
    menuScreen: ctx.hud?.menus?.screen ?? null,
    localTick: ctx.player?._localTick ?? null,
    expectedLocalTick: preSteps,
    progressionStarted: !!ctx.progression?._started,
    stageIndex: ctx.progression?.stageIndex ?? null,
    playerAlive: !!ctx.player?.alive,
    enemiesAlive: ctx.director?.enemies?.length ?? -1,
    engineRunning: engine.running,
  };
  const gateFailures = [];
  if (gate.paused !== false) gateFailures.push('ctx.paused is not false');
  if (gate.menuScreen != null) gateFailures.push(`a menu is up: ${gate.menuScreen}`);
  if (gate.localTick !== preSteps) gateFailures.push(`player stepped ${gate.localTick}, expected ${preSteps}`);
  if (!gate.progressionStarted) gateFailures.push('Progression never began stage 1');
  if (!gate.playerAlive) gateFailures.push('player died during the settle window');
  if (gate.enemiesAlive <= 0) gateFailures.push('no enemies alive — the Director never spawned');
  if (gate.engineRunning) gateFailures.push('engine.stop() did not stop the frame loop');
  if (gateFailures.length) return { gateFailures, gate, startState };

  /* What a `damage` event's source is bucketed by, and why it is not `type`.
   *
   * The payload `Combat.js:478-481` emits is
   * `{ target, source, amount, toHealth, absorbed, crit, position, proc }` —
   * there is no `type` field on it at all. Keying on `e.type || 'none'` would
   * have filed 100% of damage under `'none'`: an accumulator that looks
   * populated and discriminates nothing.
   *
   * `source` is the attacking entity — the `Enemy` for melee, `p.owner` (also
   * the `Enemy`) for projectiles, `ctx.player` for the survivor's own hits, and
   * `null` for environmental damage. `constructor.name` is `'Enemy'` for every
   * monster in the game and is degenerate for the same reason `type` was;
   * `def.id` is the spawn-card id from `data/enemies.js` ('mite', 'beetle',
   * 'lemurian'...), which is stable across runs and is the granularity a
   * targeting change would actually show up at. The elite affix rides along
   * because it multiplies damage, so folding it in would hide an affix-only
   * change.
   */
  const sourceKey = (s) => {
    if (!s) return 'environment';
    if (s.isPlayer) return 'player';
    const id = s.def?.id;
    if (id) return s.affix ? `${id}+${s.affix}` : id;
    return s.constructor?.name || 'unknown';
  };

  const f = {
    seed: ctx.seed,
    preSteps,
    steps,
    // What arrived (`amount`), what reached health (`toHealth`) and what a
    // barrier ate (`absorbed`). All three ride on the event and a later balance
    // task needs them; recording only the first is what made every point spent
    // breaking a shield read as zero once before.
    damageToPlayer: 0,
    damageToPlayerToHealth: 0,
    damageToPlayerAbsorbed: 0,
    damageToPlayerBySource: {},
    damageToEnemies: 0,
    damageToEnemiesBySource: {},
    damageEvents: 0,
    crits: 0,
    kills: 0,
    enemyKills: 0,
    playerDeaths: 0,
    enemiesAlive: 0,
    enemiesAliveMax: 0,
    goldTotal: 0,
    playerHealth: 0,
    playerShield: 0,
    playerLevel: 0,
    ctxTime: 0,
    frameErrors: 0,
    lastFrameError: null,
    finalEnemyPositions: [],
  };

  const add = (bucket, key, v) => { bucket[key] = (bucket[key] || 0) + v; };

  const offDamage = ctx.events.on('damage', (e) => {
    f.damageEvents++;
    if (e.crit) f.crits++;
    const k = sourceKey(e.source);
    if (e.target === ctx.player) {
      f.damageToPlayer += e.amount || 0;
      f.damageToPlayerToHealth += e.toHealth || 0;
      f.damageToPlayerAbsorbed += e.absorbed || 0;
      add(f.damageToPlayerBySource, k, e.amount || 0);
    } else {
      f.damageToEnemies += e.amount || 0;
      add(f.damageToEnemiesBySource, k, e.amount || 0);
    }
  });
  const offKill = ctx.events.on('kill', (e) => {
    f.kills++;
    if (e?.victim?.isPlayer) f.playerDeaths++; else f.enemyKills++;
  });

  const errorsAtStart = ctx.frameErrors;

  for (let i = 0; i < steps; i++) {
    step(1);
    const n = ctx.director?.enemies?.length ?? 0;
    if (n > f.enemiesAliveMax) f.enemiesAliveMax = n;
  }

  offDamage();
  offKill();

  f.damageToPlayer = round(f.damageToPlayer);
  f.damageToPlayerToHealth = round(f.damageToPlayerToHealth);
  f.damageToPlayerAbsorbed = round(f.damageToPlayerAbsorbed);
  f.damageToEnemies = round(f.damageToEnemies);
  for (const k in f.damageToPlayerBySource) f.damageToPlayerBySource[k] = round(f.damageToPlayerBySource[k]);
  for (const k in f.damageToEnemiesBySource) f.damageToEnemiesBySource[k] = round(f.damageToEnemiesBySource[k]);
  f.playerHealth = round(ctx.player?.health ?? 0);
  f.playerShield = round(ctx.player?.shield ?? 0);
  f.playerLevel = ctx.progression?.level ?? 0;
  f.goldTotal = ctx.items?.gold ?? 0;
  f.enemiesAlive = ctx.director?.enemies?.length ?? 0;
  f.ctxTime = round(ctx.time);
  f.frameErrors = ctx.frameErrors - errorsAtStart;
  f.lastFrameError = ctx.lastFrameError;
  // Sorted, so a change in iteration order is not mistaken for a change in
  // behaviour — and rounded, because noise in the last bits of a float is not
  // a regression and must not read as one.
  f.finalEnemyPositions = (ctx.director?.enemies ?? [])
    .map((e) => [round(e.position.x), round(e.position.y), round(e.position.z)])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);

  return {
    fingerprint: f,
    gate,
    startState,
    // Not rounded: this is the proof that nothing advanced the clock behind the
    // hand-driven loop, and rounding it away would hide exactly that.
    rawCtxTime: ctx.time,
  };
}, { preSteps: PRE_STEPS, steps: STEPS, r: R });

await b.page.close();
await browser.close();
await server.close();

const pageErrors = [...a.errs, ...b.errs];
if (pageErrors.length) {
  console.error('PAGE ERRORS — fingerprint is not trustworthy:', pageErrors);
  process.exit(1);
}

if (fingerprint.gateFailures) {
  console.error('SETTLE GATE FAILED — the page is not playing:', fingerprint);
  process.exit(1);
}

// The frame loop really was stopped. A live rAF would have gone on calling
// `_frame`, which advances `ctx.time` by FIXED per substep on top of ours.
const expectedTime = (PRE_STEPS + STEPS) / 60;
const drift = Math.abs(fingerprint.rawCtxTime - expectedTime);
if (drift > 1e-9) {
  console.error(`CLOCK DRIFT — ctx.time is ${fingerprint.rawCtxTime}, expected ${expectedTime} (drift ${drift}).`);
  console.error('Something advanced the simulation outside the hand-driven loop; the fingerprint is not pinned.');
  process.exit(1);
}

if (fingerprint.fingerprint.frameErrors > 0) {
  console.error('SYSTEM THREW DURING THE MEASURED WINDOW — fingerprint is not trustworthy:',
    fingerprint.fingerprint.frameErrors, fingerprint.fingerprint.lastFrameError);
  process.exit(1);
}

const out = {
  fingerprint: fingerprint.fingerprint,
  // Diagnostics, deliberately outside `fingerprint` so a diff of the thing this
  // instrument exists to compare is not polluted by wall-clock numbers.
  diagnostics: {
    liveness,
    settleGate: fingerprint.gate,
    startState: fingerprint.startState,
    rawCtxTime: fingerprint.rawCtxTime,
    clockDrift: drift,
  },
};

const json = JSON.stringify(out, null, 2);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  console.log(`wrote ${outPath}`);
} else {
  console.log(json);
}
