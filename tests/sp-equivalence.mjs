/**
 * A deterministic fingerprint of a single-player run.
 *
 *   node tests/sp-equivalence.mjs --out reviews/round7/baseline-00f8900.json
 *   node tests/sp-equivalence.mjs --compare reviews/round7/baseline-00f8900.json
 *
 * and the affix gate, which is a separate baseline because this one is
 * structurally blind to `ELITE_STATS` (`npm run gate:elite`):
 *
 *   node tests/sp-equivalence.mjs --mode elite-dps --out reviews/round7/elite-baseline-00f8900.json
 *   node tests/sp-equivalence.mjs --mode elite-dps --compare reviews/round7/elite-baseline-00f8900.json
 *
 * The roster migration's whole safety argument is that a roster of one behaves
 * exactly as `ctx.player` did. This is the instrument that decides it. Capture
 * a baseline from HEAD's literal condition first — not from the current tree
 * and not from an approximation. "Single-player didn't move" was asserted
 * rather than measured once before, and a kill-counter regression survived a
 * whole review round inside that gap.
 *
 * `--compare` is how every downstream task should use this. It re-runs the
 * probe and diffs only the `.fingerprint` object against the baseline's,
 * printing every moved field with its before and after, and exiting non-zero if
 * anything moved. Do NOT `diff` the two JSON files: `diagnostics` is
 * wall-clock-derived and will differ on a tree with no changes in it at all,
 * which trains a reader to decide by eye which lines in this diff matter. That
 * habit is the exact regression path this instrument exists to close.
 *
 * Runs the real game under `?harness=1` — `Stage`, `VFX` and `RenderPipeline`
 * all need a document and a GL context, so a node-only fixture is not an
 * option and every prior attempt at one is deleted.
 *
 * READ THIS BEFORE INTERPRETING A FAILING DIFF — the instrument is a chaotic
 * amplifier, not a linear one. The survivor's aim is re-derived from enemy
 * positions every step, so a change in enemy behaviour feeds straight back into
 * which enemy is shot next. Measured: a *one centimetre* offset applied to
 * enemy target selection moved total damage dealt by 4.4% and rewrote all
 * thirteen entries of `finalEnemyPositions`. That is the right sign of error for
 * a binary "did single-player move" gate, and it means the *magnitude* of a diff
 * carries no information about the magnitude of the regression. A large diff is
 * not proof of a large regression; a small diff is not proof of a safe one. The
 * only reading this gate supports is: nothing moved, or something did.
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
 * `ctx.time` past `(PRE_STEPS + STEPS + DEAD_STEPS) / 60`.
 *
 * The liveness phase is not decoration. Several prior instruments in this repo
 * produced clean-looking numbers while the page sat on a menu, and hand-driving
 * `fixedUpdate` bypasses `ctx.paused` — so the pinned phase *cannot* detect
 * that failure on its own. Phase A runs the real rAF loop, unpinned, and gates
 * on it actually stepping before phase B is allowed to measure anything.
 *
 * TWO MEASURED WINDOWS, separately addressable in the output:
 *
 *  1. `fingerprint.*` — the survivor alive and fighting for 60 s.
 *  2. `fingerprint.deadTarget.*` — the survivor killed through the real damage
 *     path, then 15 s more. `Enemy.fixedUpdate`'s `if (p && p.position) … else`
 *     (`Enemy.js:450-455`) is the exact statement the roster migration rewrites
 *     into a roster query, and window 1 pins the survivor alive so that branch
 *     never changes shape. Window 2 is where a bad empty-roster fallback shows
 *     up instead of shipping a green gate.
 *
 * `--coop-host` — the roster-of-one invariant, as a command (`npm run gate:mp1`).
 *
 * Appends `&coophost=1`, which makes the harness start hosting before the page
 * has taken a single simulation step (`Harness.js`, next to the `pinclock`
 * read). The host code path is then live for the whole measured window with
 * nobody connected: `ctx.authority` through `NetHost.init`, `ctx.netRole` at
 * `'host'`, the snapshot writer in the system list. The gate is that this moves
 * *zero* fields against the same baseline `gate:sp` names — hosting alone must
 * not displace one `ctx.rng` draw. Everything else about the run is untouched,
 * and the flag's absence is the flag not existing: no param, no hook, the
 * default path exactly as it was.
 *
 * The settle gate asserts the hosting actually happened (`netRole`,
 * `netClients` in `diagnostics.settleGate`). Without that, a `startHost` that
 * silently did nothing would produce a green gate measuring single-player
 * against single-player and calling it a multiplayer guarantee.
 *
 * The flag is orthogonal to `--mode`, because it is a URL param and the page
 * starts hosting before either arm runs — so *both* arms carry that assertion.
 * `--coop-host --mode elite-dps` is therefore a real, self-checking combination
 * (elite damage measured on a host with an empty roster) rather than a
 * combination that hosts without noticing whether it did. No script names it
 * yet; `gate:mp1` is the equivalence arm.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { laneBase } from '../tools/lib/lanes.mjs';

// Not a tuning range — a name for one arbitrary but *fixed* choice. Any value
// works; changing it invalidates every baseline captured with the old one, so
// the only failure mode is editing it, in either direction.
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

// 15 s of the second window, after the survivor is killed. Too few and the
// enemies are still finishing the attack animations they were mid-way through
// when he died, so the window measures the transient and not the steady state
// of the no-live-target branch; too many and the Director is disabled
// (`Director.js:159`) with nothing left to spawn, so every extra step is a
// scene that can no longer change and pure cost.
const DEAD_STEPS = 900;

// Ceiling on the wall-clock liveness gate in phase A. Too low and a cold shader
// compile on a slow machine fails a build that is fine; too high and a page
// genuinely stuck on a menu burns that long before saying so.
const LIVE_GATE_MS = 45000;

// How many hand-driven-equivalent steps the live loop must have taken before
// phase A believes the page is playing. Too low (1, say) and a page that
// stepped once during a menu transition passes a gate meant to prove sustained
// play; too high and the gate outlives a legitimately slow first stage and
// fails a build whose only sin is a long terrain build.
const LIVE_TICK_FLOOR = 60;

// Ceiling on waiting for `ctx.stage` to exist after page load. Too low and a
// cold Vite transform of the whole module graph fails a good build before the
// world has been generated once; too high and a page that threw during boot —
// where `ctx.stage` will never appear — is indistinguishable from a slow one
// for that long.
const STAGE_TIMEOUT_MS = 60000;

// Ceiling on one hand-driven evaluate. The 5100-step block runs as a single
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

// How far `ctx.time` may sit from `(PRE_STEPS + STEPS + DEAD_STEPS) / 60` before
// the run is rejected as not pinned. The measured figure is ~3e-12, the float
// error of summing `1/60` five thousand times. Tighten this below that and a
// perfectly pinned run fails; loosen it past `1/60` (0.0167 — one surviving rAF
// substep) and the one thing it exists to catch walks through it. The two ends
// are seven orders of magnitude apart, which is why a round number in the middle
// is safe rather than lucky.
const DRIFT_TOLERANCE = 1e-9;

// Fallback half-height for an enemy with no `height`, used only to pick the aim
// point. Too small and the lens aims at the monster's feet, too large and it
// aims over its head — either way every shot in window 1 misses something it
// should have hit and every damage number in the fingerprint changes. Every
// card in `data/enemies.js` declares `height`, so this is a guard against a
// future card that forgets to, not a value in live use.
const DEFAULT_ENEMY_HEIGHT = 1.6;

// The dev-server port, overridable — `--port 5300`, or `SP_PORT=5300`.
//
// The default only has to be free and to differ from every port the scripts in
// `tools/` claim. It did not: `tools/menuprobe.mjs` and `tools/voidprobe.mjs`
// both defaulted to 5209 as well, so the property the previous comment here
// claimed was never true. `tests/probe-ports.test.mjs` now asserts it instead
// of asserting it in prose, and it is what stops the next default from
// colliding.
//
// The override matters more than the default. All three gates — `gate:sp`,
// `gate:mp1`, `gate:elite` — run through this one file, so a single hardcoded
// port meant no two could run at once, *including from separate git
// worktrees*. That became the throughput ceiling for parallel work on
// 2026-08-15, and it cost two diagnosis cycles because a lost race surfaces as
// ERR_CONNECTION_REFUSED or a vite bind error inside the losing run, which
// reads as a defect in the branch under test. See issue #68.
//
// The port is internal to this file's own vite dev server. It is not part of
// any baseline fingerprint, so moving it cannot change a comparison result.
//
// `--lane A|B|C` is the same override said once instead of three times: a lane
// owns a ten-port block (tools/lib/lanes.mjs, mirroring CLAUDE.md), and this
// file takes the first port of it. A brief can then say "you are lane B"
// rather than restating a port number per command — the failure mode being
// that a brief which forgets to restate one leaves the run on 5209, silently
// joined to whichever other lane is already there.
const PORT = Number(
  (() => {
    const li = process.argv.indexOf('--lane');
    const i = process.argv.indexOf('--port');
    // Two ways to name the same port, so refuse rather than let argv order
    // decide silently — the whole point of the flag is that a lane's block is
    // knowable from the brief.
    if (li >= 0 && i >= 0) {
      console.error('sp-equivalence: pass --lane or --port, not both — they set the same thing.');
      process.exit(2);
    }
    if (li >= 0 && process.env.SP_PORT) {
      console.error('sp-equivalence: --lane was given but SP_PORT is also set. Unset one; refusing to guess.');
      process.exit(2);
    }
    if (li >= 0) {
      try { return laneBase(process.argv[li + 1]); }
      catch (e) { console.error(`sp-equivalence: ${e.message}`); process.exit(2); }
    }
    return i >= 0 ? process.argv[i + 1] : process.env.SP_PORT;
  })() ?? 5209,
);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`sp-equivalence: --port/SP_PORT must be an integer in 1024-65535, got ${PORT}`);
  process.exit(2);
}

/* ---------------------------------------------------------------------------
 * `--mode elite-dps` — the elite-affix damage arm.
 *
 * A second *export* of this file rather than a second fixture file, because the
 * pinned clock, the liveness gate and the settle gate above are the expensive
 * part and a second copy of them is a second thing that can drift out of true.
 * The default mode is untouched: `--compare` still runs the equivalence
 * fingerprint and nothing below this block executes for it.
 *
 * What it measures: how much damage one elite puts on one parked survivor per
 * second, split by damage *type*, at two standoffs. The split is the whole
 * point — an emberclad elite's total is three separate riders (the aura's direct
 * tick, the burn DoT the aura and the melee rider light, and the melee hit
 * itself) and they answer to three different levers, so a single total cannot
 * tell you which one to move.
 *
 * The `damage` event carries no `type` and no `isDot` (`Combat.js:478-481`), so
 * the split cannot be taken from it. `ctx.combat.applyDamage` is wrapped for
 * the duration of the run instead, which is where `info.type` and `info.isDot`
 * actually are. Nothing in `src/` is modified: the wrapper delegates and is
 * removed before the page closes.
 */

// The spawn card every arm uses. `lasher` is the card the round-7 fixture this
// arm reproduces used, and the choice is load-bearing rather than arbitrary:
// `baseDamage: 21` is what makes the plain arm's melee land on exactly 21 and
// the elite arms' on exactly 42, so a per-hit number that is off by a
// multiplier is visible as a non-integer rather than hidden in a dps average.
// Its `flail` reaches 6.5 m while `reel` and `thorns` have minRanges of 4 and 5,
// so at the 2.5 m stand it can *only* melee — the contact arm is therefore melee
// plus affix rider and nothing else.
const ARM_CARD = 'lasher';

// The two standoffs, both reported, because a fix aimed at one end can overshoot
// into the other. 2.5 m is inside emberclad's 3.2 m `auraRadius` and is the worst
// case: the aura fires on every beat, `inAuraFraction` is 1, and AI variance in
// whether the unit closed is removed entirely. 11 m is outside every aura and
// outside the melee reach, so the unit has to choose and travel — that arm can
// still be moved by a targeting or steering change, which is exactly why it
// cannot be the only one.
const CONTACT_M = 2.5;
const FREE_M = 11;

// Settle before the first arm. Short on purpose, unlike `PRE_STEPS`: this arm
// does not want the Director's spawn wave at all, and `updateDifficulty` runs
// on every step whether the Director is enabled or not (`Director.js:276`), so
// every extra settle step pushes `difficultyCoefficient` and with it the level
// the arms would spawn at. Too few and `ctx.stage`/`Progression` are not up yet
// and the gate below fails; too many and the survivor is fighting a horde the
// arm then has to clear, at a monster level that is no longer 1.
const ARM_SETTLE = 120;

// 40 s held in contact. The floor is set by quantisation, not by the ramp: the
// plain arm's whole damage is melee hits worth 21 each on a ~2.4 s cooldown, so
// at 20 s a single hit landing either side of the window edge moved the plain
// denominator by 14% and the emberclad/plain ratio by 1.6x between two runs of an
// unchanged tree. At 40 s that is ~6%. Too many and the six arms together push
// `difficultyCoefficient` far enough that the later arms are measured on a
// different curve from the earlier ones, and each capture costs minutes.
const CONTACT_STEPS = 2400;

// 27 s free-roam. Longer than the contact arm because the unit spends the first
// seconds closing and choosing, and a window that ends mid-approach measures
// travel time rather than damage. Too many and the same difficulty drift above
// applies.
const FREE_STEPS = 1620;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const outPath = arg('--out');
const comparePath = arg('--compare');
// A switch, not a value — `arg` reads the next token, which this flag has none
// of. See the `--coop-host` section of the header.
const COOP_HOST = process.argv.includes('--coop-host');

/**
 * What produced this capture, written into every `--out` file.
 *
 * A baseline that does not name its own source is a number nobody can
 * reproduce, and this repo has been burned by exactly that: four fix reports
 * once quoted before/after figures no critic could re-derive. The commit is the
 * point; `dirty` is the honest caveat, because a baseline captured over an
 * uncommitted edit is not a baseline of the commit it names.
 *
 * Neither `--compare` view reads this key, so adding it moves no gate.
 */
function captureSource() {
  const git = (a) => {
    try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; }
  };
  return {
    tool: 'tests/sp-equivalence.mjs',
    mode: MODE,
    coopHost: COOP_HOST,
    seed: SEED,
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain']) !== '',
    capturedAt: new Date().toISOString(),
  };
}
const MODE = arg('--mode') || 'equivalence';
if (MODE !== 'equivalence' && MODE !== 'elite-dps') {
  console.error(`unknown --mode ${MODE}; expected "equivalence" or "elite-dps"`);
  process.exit(2);
}

/**
 * Flatten to dotted leaf paths so a nested window (`deadTarget.*`) and a bucket
 * map (`damageToPlayerBySource.mite`) diff by name rather than by whole-object
 * inequality. Arrays are compared whole — a position vector that moved is one
 * fact, not thirteen.
 */
const flatten = (v, prefix = '', out = {}) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of Object.keys(v)) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = v;
  }
  return out;
};

const compareFingerprints = (baseline, fresh) => {
  const a = flatten(baseline);
  const b = flatten(fresh);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const moved = [];
  for (const k of keys) {
    const av = JSON.stringify(a[k]);
    const bv = JSON.stringify(b[k]);
    if (av !== bv) moved.push({ field: k, baseline: a[k], fresh: b[k] });
  }
  return moved;
};

let server = null;
let browser = null;
let result = null;
let elite = null;
let liveness = null;
let pageErrors = [];

// Everything below runs inside try/finally: when the in-page fixture throws —
// which is what happens when this file is wrong — the top-level await used to
// reject with chromium still up and the port still held, and the *next* run
// then failed with a port-in-use error that reads as a different bug entirely.
try {
  // `strictPort` is the half of issue #68 that made the collision so expensive
  // to read. Without it vite does not fail on a held port: it quietly binds the
  // *next* free one and returns a healthy server. The run then navigates to
  // PORT, which belongs to the other process, and dies with
  // ERR_CONNECTION_REFUSED several seconds later and a long way from the cause
  // — which is verbatim what one of the two implementers reported. Failing at
  // bind, loudly, turns a mystery into a sentence.
  server = await createServer({
    server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
  });
  await server.listen();

  // Headed for the real GPU path, parked off the visible desktop so probe runs
  // never appear on the user's screen. Set CAPTURE_VISIBLE=1 to watch.
  const OFFSCREEN = process.env.CAPTURE_VISIBLE
    ? []
    : ['--window-position=-2400,-2400', '--window-size=1280,720'];
  browser = await chromium.launch({
    headless: false,
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
  });

  const url = `http://127.0.0.1:${PORT}/?seed=${SEED}&quality=1&harness=1`
    + (COOP_HOST ? '&coophost=1' : '');

  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(EVAL_TIMEOUT_MS);
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: STAGE_TIMEOUT_MS });
    return { page, errs };
  };

  // --- Phase A: does this build actually play? ------------------------------
  // The real rAF loop, unpinned, against the exact fields the gate names. If
  // this times out, the page is on a menu and nothing below is worth reading.
  const a = await newPage();
  await a.page.evaluate(() => globalThis.__HARNESS__.dismiss());
  try {
    await a.page.waitForFunction(
      (floor) => globalThis.__GAME__.ctx.paused === false
        && (globalThis.__GAME__.ctx.player?._localTick ?? 0) > floor,
      LIVE_TICK_FLOOR, { timeout: LIVE_GATE_MS },
    );
    liveness = await a.page.evaluate(() => {
      const { ctx } = globalThis.__GAME__;
      return {
        gate: 'fired',
        paused: ctx.paused,
        localTick: ctx.player?._localTick ?? null,
        menuScreen: ctx.menus?.screen ?? null,
        time: +ctx.time.toFixed(3),
        engineRunning: globalThis.__GAME__.engine.running,
        stageIndex: ctx.progression?.stageIndex ?? null,
      };
    });
  } catch (e) {
    liveness = { gate: 'TIMED OUT', detail: String(e?.message ?? e) };
  }
  pageErrors.push(...a.errs);
  await a.page.close();

  if (liveness.gate === 'fired' && MODE === 'elite-dps') {
    // --- Phase B': the elite-affix damage arm --------------------------------
    const e = await newPage();
    elite = await e.page.evaluate(
      async ({ card, contactM, freeM, settle, contactSteps, freeSteps, r, coopHost }) => {
        const { engine, ctx } = globalThis.__GAME__;
        const H = 1 / 60;
        const round = (n) => Math.round(n * r) / r;

        /* The spawn card, by id, from the module the game itself imports.
         *
         * Taken through the dev server's own module graph rather than fished
         * out of whatever happens to be on the field, so the arm spawns the card
         * it names even when the Director has never rolled one — `lasher` is
         * tier 2 and is not affordable 2 s into stage 1. This is the only
         * `await` in the block and it is deliberately *before* the
         * dismiss-and-stop pair below, so no rAF can land between those two.
         */
        const { ENEMY_BY_ID } = await import('/src/data/enemies.js');
        const def = ENEMY_BY_ID.get(card) ?? null;

        // Same synchronous dismiss-and-stop as the fingerprint mode: no rAF can
        // land between them, so the sim has taken exactly zero steps when the
        // hand-driven loop below starts.
        globalThis.__HARNESS__.dismiss();
        engine.stop();

        const p = ctx.player;
        const dir = ctx.director;
        if (!p || !dir) return { armFailures: ['no player or no director'] };

        /* One step of the pinned loop.
         *
         * `Director.fixedUpdate` already steps every enemy, so unlike the
         * fingerprint mode this loop does not call `Enemy.fixedUpdate` itself —
         * it calls `update` for the presentation half only, which is what
         * advances `deathT` and lets a corpse be reaped. The camera rig is not
         * driven and the trigger is not held: this arm measures damage *to* the
         * survivor, and a survivor who shoots back kills the subject.
         */
        // Counted rather than derived, because the lethal arm below stops the
        // moment the survivor dies and there is no closed form for how many
        // steps that took. The drift assertion still does its job: it compares
        // `ctx.time` against the steps *this loop* took, so a surviving rAF
        // advancing the clock underneath us is still caught.
        let stepsTaken = 0;
        const step = () => {
          ctx.time += H;
          stepsTaken++;
          for (const s of engine.systems) if (s.fixedUpdate) s.fixedUpdate(ctx, H);
          for (const en of dir.enemies) en.update?.(ctx, H);
        };

        for (let i = 0; i < settle; i++) step();

        const gate = {
          paused: ctx.paused,
          menuScreen: ctx.menus?.screen ?? null,
          localTick: p._localTick ?? null,
          expectedLocalTick: settle,
          progressionStarted: !!ctx.progression?._started,
          playerAlive: !!p.alive,
          playerMaxHealth: p.maxHealth,
          engineRunning: engine.running,
          authority: !!ctx.authority,
          // The same two fields the equivalence arm's gate carries, for the same
          // reason and in the same place — `gate` is diagnostics, never
          // fingerprint. `--coop-host` is mode-agnostic by construction (it is a
          // URL param, and the page hosts before either arm runs), so an arm
          // that did not assert the hosting would accept a silently no-oped
          // `startHost` as a measurement of hosting.
          netRole: ctx.netRole ?? null,
          netClients: ctx.net?.clients?.size ?? null,
          cardFound: null,
        };
        const gateFailures = [];
        if (gate.paused !== false) gateFailures.push('ctx.paused is not false');
        if (gate.menuScreen != null) gateFailures.push(`a menu is up: ${gate.menuScreen}`);
        if (gate.localTick !== settle) gateFailures.push(`player stepped ${gate.localTick}, expected ${settle}`);
        if (!gate.progressionStarted) gateFailures.push('Progression never began stage 1');
        if (!gate.playerAlive) gateFailures.push('player died during the settle window');
        if (gate.engineRunning) gateFailures.push('engine.stop() did not stop the frame loop');
        if (!gate.authority) gateFailures.push('ctx.authority is false — applyDamage returns 0');
        if (coopHost && gate.netRole !== 'host') {
          gateFailures.push(`--coop-host did not start a host: ctx.netRole is ${gate.netRole}`);
        }
        if (coopHost && gate.netClients !== 0) {
          gateFailures.push(`the host has ${gate.netClients} peer(s); this arm measures a roster of one`);
        }

        gate.cardFound = !!def;
        if (!def) gateFailures.push(`spawn card "${card}" not found in ENEMY_BY_ID`);
        if (gateFailures.length) return { gateFailures, gate };

        // Ambient spawning off for the whole run. `enabled` gates credit accrual
        // and spawning only (`Director.js:302`); everything already on the field
        // keeps stepping, which is why the field is cleared per arm as well.
        dir.enabled = false;

        /* The type/isDot split, taken where it exists.
         *
         * `applyDamage` returns the amount that actually landed, so this records
         * what the survivor took rather than what was requested — a shield or an
         * armour change shows up here as it would in play.
         */
        const origApply = ctx.combat.applyDamage.bind(ctx.combat);
        let rec = null;
        // The same shape the fingerprint mode's `sourceKey` files an elite under
        // — `<id>+<affix>` — so the arm can assert that an elite is actually
        // *in* the window it claims to have measured one in. Deliberately the
        // same convention and not a second one: the whole point of the assertion
        // is that a reader can compare it against the fingerprint's buckets.
        const srcKey = (s) => {
          if (!s) return 'environment';
          if (s.isPlayer) return 'player';
          const id = s.def?.id;
          if (id) return s.affix ? `${id}+${s.affix}` : id;
          return s.constructor?.name || 'unknown';
        };
        ctx.combat.applyDamage = (target, amount, info = {}) => {
          const dealt = origApply(target, amount, info);
          if (rec && target === ctx.player && dealt > 0) {
            const key = `${info.type || 'none'}${info.isDot ? ':dot' : ''}`;
            rec.byType[key] = (rec.byType[key] || 0) + dealt;
            const sk = srcKey(info.source);
            rec.sourceKeys[sk] = (rec.sourceKeys[sk] || 0) + dealt;
            rec.total += dealt;
            rec.events++;
            if (info.source !== rec.unit) rec.foreign += dealt;
          }
          return dealt;
        };

        const arms = {};
        const runArm = (affix, metres, steps, hold) => {
          dir.clear(ctx);
          ctx.combat.statuses.delete(p);
          p.health = p.maxHealth;
          p._iframeUntil = 0;

          /* Monster stats are baked at spawn (`Enemy.js:262-268`), and
           * `updateDifficulty` runs on every step whether the Director is
           * enabled or not — so by the sixth arm the curve has moved. Forcing
           * the three multipliers immediately before the spawn is what makes
           * all six arms the same unit: level 1, `damageMult` 1, so
           * `unitDamageStat` is `baseDamage` times the affix multiplier and
           * nothing else. The assertion that this worked is `baseDamage: 21`
           * in every arm's output.
           */
          dir.level = 1;
          dir.damageMult = 1;
          dir.healthMult = 1;

          const p0 = { x: p.position.x, y: p.position.y, z: p.position.z };
          // A fixed bearing rather than camera-forward: camera yaw at this point
          // is whatever the rig last wrote, which is not a pinned quantity.
          const at = { x: p0.x + metres, y: p0.y, z: p0.z };
          const unit = dir.spawnOne(ctx, def, at, affix);
          // `Enemy.spawn` grounds the body (`Enemy.js:273`); the hold re-forces
          // the position it was actually placed at, not the player's y, or the
          // held unit spends the arm hovering or buried.
          const holdY = unit.position.y;

          rec = { byType: {}, total: 0, events: 0, foreign: 0, sourceKeys: {}, unit };
          let inAura = 0;
          let distSum = 0;
          let distMin = Infinity;
          let stackSum = 0;
          let stackMax = 0;

          for (let i = 0; i < steps; i++) {
            if (hold && unit.alive) {
              // Held in contact: position re-forced every step, so the standoff
              // is exactly `metres` on every beat of the aura and the arm has no
              // AI variance in it at all.
              unit.position.set(p0.x + metres, holdY, p0.z);
              unit.velocity.set(0, 0, 0);
            }
            // Sampled *before* the step, because this is the separation the
            // step's `Enemy.fixedUpdate` will read into `distToPlayer` — sampling
            // after it would report the post-movement position instead of the one
            // the aura test actually used, and on a held arm that reads as an
            // `inAuraFraction` below 1 on a fixture that never left the aura.
            const d = Math.hypot(unit.position.x - p.position.x, unit.position.z - p.position.z);
            distSum += d;
            if (d < distMin) distMin = d;
            const aura = unit.elite?.auraRadius ?? 0;
            if (aura > 0 && d < aura) inAura++;

            step();

            /* The survivor gives no input in either arm and is topped up in
             * both: damage is *measured*, not prevented, and restoring after the
             * step means the step's damage is already recorded.
             *
             * His *position* is forced only on the held arm, where the whole
             * point is a standoff with no variance in it. On the free-roam arm
             * it is left alone, because the lasher's `reel` is a pull — forcing
             * the position there would silently delete a mechanic and leave an
             * arm that no aura change can move, i.e. an overshoot detector that
             * cannot detect an overshoot. The round-7 fixture this reproduces
             * recorded `minDist 0.005` on its free-roam arm for exactly that
             * reason: the survivor was yanked into contact and burned.
             */
            if (hold) {
              p.position.set(p0.x, p0.y, p0.z);
              p.velocity.set(0, 0, 0);
            }
            p.health = p.maxHealth;

            const st = ctx.combat.statusStacks(p, 'burn');
            stackSum += st;
            if (st > stackMax) stackMax = st;
          }

          const seconds = steps * H;
          const byType = {};
          for (const k of Object.keys(rec.byType).sort()) byType[k] = round(rec.byType[k]);
          const dpsOf = (k) => round((rec.byType[k] || 0) / seconds);
          const out = {
            affix: affix ?? 'none',
            card,
            metres,
            hold,
            seconds: round(seconds),
            damage: round(rec.total),
            dps: round(rec.total / seconds),
            // The three riders, separated. `burn` is the aura's *direct* tick
            // (`Enemy.js:566`), `burn:dot` is the stack damage `_tickStatuses`
            // applies, and `melee` is the hit itself. A stack cap moves the
            // second and neither of the other two.
            auraDirectDps: dpsOf('burn'),
            burnDotDps: dpsOf('burn:dot'),
            meleeDps: dpsOf('melee'),
            byType,
            sourceKeys: Object.fromEntries(Object.keys(rec.sourceKeys).sort().map((k) => [k, round(rec.sourceKeys[k])])),
            events: rec.events,
            foreignDamage: round(rec.foreign),
            // Read off the affix table rather than off the observed damage, so
            // an arm whose aura silently stopped existing is distinguishable
            // from one that was never supposed to have an aura. See the runner's
            // `inAuraFraction` invariant.
            auraRadius: round(unit.elite?.auraRadius ?? 0),
            hasAura: !!(unit.elite?.auraDps && unit.elite?.auraRadius),
            unitDamageStat: round(unit.damage),
            baseDamage: round(def.baseDamage),
            unitLevel: unit.level,
            eliteAlive: !!unit.alive,
            enemiesOnStage: dir.enemies.length,
            inAuraFraction: round(inAura / steps),
            meanBurnStacks: round(stackSum / steps),
            maxBurnStacks: stackMax,
            meanDist: round(distSum / steps),
            minDist: round(distMin),
            playerMaxHealth: round(p.maxHealth),
            playerAlive: !!p.alive,
          };
          rec = null;
          arms[`${affix ?? 'plain'}@${metres}`] = out;
        };

        /* The survivability arm, and why it is last and alone.
         *
         * The six arms above top the survivor up after every step, which is what
         * makes them dps measurements — but it also means the quantity this
         * affix's `auraDps` was tuned *for*, how long a full-health survivor
         * lives in the aura, has no instrument at all. It is not enough to
         * divide 110 by a 40-second steady-state average: the burn needs four
         * seconds to reach its three-stack cap, so the first two seconds are not
         * billed at that average and the division overstates the threat by about
         * 40%.
         *
         * It runs last and only once because killing the survivor is not a
         * reversible fixture input: the real damage path fires `playerDead`,
         * `Progression._endRun` puts a menu up and disables the Director, and
         * every arm after it would be measuring a paused game.
         */
        const runLethal = (affix, metres, maxSteps) => {
          dir.clear(ctx);
          ctx.combat.statuses.delete(p);
          p.health = p.maxHealth;
          // The killing blow must be the aura's, not a leftover i-frame's.
          p._iframeUntil = 0;
          dir.level = 1;
          dir.damageMult = 1;
          dir.healthMult = 1;

          const p0 = { x: p.position.x, y: p.position.y, z: p.position.z };
          const unit = dir.spawnOne(ctx, def, { x: p0.x + metres, y: p0.y, z: p0.z }, affix);
          const holdY = unit.position.y;
          rec = { byType: {}, total: 0, events: 0, foreign: 0, sourceKeys: {}, unit };

          const startHealth = p.health;
          const t0 = ctx.time;
          let deathAt = null;
          let taken = 0;
          for (let i = 0; i < maxSteps; i++) {
            if (unit.alive) {
              unit.position.set(p0.x + metres, holdY, p0.z);
              unit.velocity.set(0, 0, 0);
            }
            step();
            taken++;
            // Parked, and *not* topped up — this is the one arm where the
            // survivor is allowed to lose the fight.
            p.position.set(p0.x, p0.y, p0.z);
            p.velocity.set(0, 0, 0);
            if (!p.alive) { deathAt = ctx.time - t0; break; }
          }

          const byType = {};
          for (const k of Object.keys(rec.byType).sort()) byType[k] = round(rec.byType[k]);
          const out = {
            affix: affix ?? 'none',
            card,
            metres,
            startHealth: round(startHealth),
            // The number this arm exists for. `null` means the survivor was
            // still standing when the window closed, which is itself a result.
            timeToDeath: deathAt == null ? null : round(deathAt),
            survivedWindow: deathAt == null,
            windowSeconds: round(maxSteps / 60),
            stepsRun: taken,
            damageTaken: round(rec.total),
            byType,
            sourceKeys: Object.fromEntries(Object.keys(rec.sourceKeys).sort().map((k) => [k, round(rec.sourceKeys[k])])),
            events: rec.events,
            foreignDamage: round(rec.foreign),
            unitDamageStat: round(unit.damage),
            playerMaxHealth: round(p.maxHealth),
            playerAlive: !!p.alive,
            runEnded: !!ctx.progression?._ended,
          };
          rec = null;
          return out;
        };

        const errorsAtStart = ctx.frameErrors;
        for (const affix of ['emberclad', 'rimebound', null]) {
          runArm(affix, contactM, contactSteps, true);
          runArm(affix, freeM, freeSteps, false);
        }
        const lethal = runLethal('emberclad', contactM, contactSteps);
        ctx.combat.applyDamage = origApply;

        return {
          arms,
          lethal,
          gate,
          card,
          frameErrors: ctx.frameErrors - errorsAtStart,
          lastFrameError: ctx.frameErrors > errorsAtStart ? ctx.lastFrameError : null,
          rawCtxTime: ctx.time,
          expectedCtxTime: stepsTaken / 60,
          stepsTaken,
        };
      },
      {
        card: ARM_CARD, contactM: CONTACT_M, freeM: FREE_M, settle: ARM_SETTLE,
        contactSteps: CONTACT_STEPS, freeSteps: FREE_STEPS, r: R, coopHost: COOP_HOST,
      },
    );
    pageErrors.push(...e.errs);
    await e.page.close();
  } else if (liveness.gate === 'fired') {
    // --- Phase B: the pinned fingerprint ------------------------------------
    const b = await newPage();
    result = await b.page.evaluate(
      ({ preSteps, steps, deadSteps, r, defaultHeight, coopHost }) => {
        const { engine, ctx } = globalThis.__GAME__;
        const H = 1 / 60;
        const round = (n) => Math.round(n * r) / r;

        // Dismiss and stop in one synchronous block: no rAF can land between
        // them, so the sim is guaranteed to have taken zero steps when the
        // hand-driven loop starts. `engine.stop()` is the mechanism — there is
        // no rAF handle to cancel.
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
         * fifteen seconds into the measured window — a first capture recorded
         * ten damage events, zero kills and a peak of six monsters across 4200
         * steps, with the last three thousand of them spent watching a corpse
         * and a Director `_endRun` had disabled. That is an instrument that
         * cannot see a targeting change, which is the one thing this plan needs
         * it to see.
         *
         * Three constant inputs fix it. Every one is a pure function of sim
         * state, so none can be a source of variance:
         *
         *  · Health is restored to full after every step *of window 1*, so the
         *    Director keeps banking credits and every enemy keeps having a live
         *    target. Damage is *measured*, not prevented — this is deliberately
         *    not `__HARNESS__.invulnerable()`, which sets `_iframeUntil =
         *    Infinity` and would zero `damageToPlayer` outright.
         *
         *  · The trigger is held. `Input.endFrame()` lives in a `lateUpdate`
         *    this loop never calls, so the button stays down unpressed.
         *
         *  · The lens is pointed at the nearest living enemy, and the rig and
         *    the camera's world matrix are stepped with it. Holding the trigger
         *    alone is not enough and this was measured, not assumed:
         *    `Player.aimRay` raycasts from `ctx.camera`, `CameraRig` only runs
         *    in `lateUpdate`, and `camera.matrixWorld` is only recomposed by the
         *    renderer — so with a fixed-step-only loop the survivor fired 75
         *    aimed shots into a stale matrix and dealt 0 damage, with `kills`,
         *    `goldTotal` and `damageToEnemiesBySource` all reading as
         *    permanently-empty accumulators. With the lens driven: 198 damage,
         *    2 kills, 10 gold over 1800 steps. An accumulator that cannot move
         *    is worse than no accumulator, because it looks like a measurement.
         *
         *    Aiming for the survivor is a fixture input and not the thing under
         *    test: this plan changes how *enemies* choose targets, not how the
         *    player does.
         */
        ctx.input.mouse.left = true;

        // Window 1 only. Window 2 turns this off and lets the survivor die,
        // which is the whole point of window 2.
        let holdAliveOn = true;
        // Accumulated evidence that `holdAlive` is doing something rather than
        // being a no-op, and the low-water mark it prevented. `playerHealth`
        // used to be in the fingerprint and was a restatement of `maxHealth` by
        // construction — a field that reads 143 and looks like a measurement.
        let healthRestored = 0;
        let playerHealthMin = Infinity;

        const holdAlive = () => {
          const p = ctx.player;
          if (!p || !p.alive || !(p.maxHealth > 0)) return;
          if (p.health < playerHealthMin) playerHealthMin = p.health;
          if (!holdAliveOn) return;
          healthRestored += Math.max(0, p.maxHealth - p.health);
          p.health = p.maxHealth;
        };

        // Yaw/pitch in `Player._sampleCommand`'s own convention: `atan2(x, z)`
        // and `asin(y)` of the bearing from the lens to the target's centre.
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
          const dy = (best.position.y + (best.height || defaultHeight) * 0.5) - c.y;
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
            /* The three pieces of a frame this loop still needs, and no others.
             *
             * `Enemy.update` is the *only* place `deathT` advances
             * (`Enemy.js:1197`), `finished` is `state === DIE && deathT >=
             * DEATH_TIME` (`Enemy.js:1228`), and the reap loop at
             * `Director.js:283-296` gates on `finished`. With no `update` pass
             * at all, nothing is ever reaped: measured at 13 entries in
             * `Director.enemies` of which only 5 were alive, eight frozen
             * corpses holding 42% of a population cap of 19 and freezing 8 of
             * the 13 `finalEnemyPositions` triples. The Director's global cap
             * (`Director.js:453`) then throttles spawning through a mechanism
             * that does not exist in the real game, so a change in kill rate
             * would have read as a change in spawn behaviour.
             *
             * The enemy loop is called directly rather than `Director.update`,
             * which would also drag in the projectile, wave, trail and telegraph
             * presentation pools. Those own no state the fingerprint reads and
             * every one of them is another surface for non-determinism to enter
             * a determinism instrument. The rig places the lens, and
             * `matrixWorld` is what `aimRay` actually reads.
             */
            for (const e of ctx.director?.enemies ?? []) e.update?.(ctx, H);
            ctx.cameraRig?.lateUpdate?.(ctx, H);
            ctx.camera.updateMatrixWorld(true);
            holdAlive();
          }
        };

        step(preSteps);

        // The real gate. Hand-driving `fixedUpdate` bypasses `ctx.paused`, so
        // "the steps ran" proves nothing on its own — these fields do. A page
        // still on survivor-select fails every one of them.
        const gate = {
          paused: ctx.paused,
          menuScreen: ctx.menus?.screen ?? null,
          localTick: ctx.player?._localTick ?? null,
          expectedLocalTick: preSteps,
          progressionStarted: !!ctx.progression?._started,
          stageIndex: ctx.progression?.stageIndex ?? null,
          playerAlive: !!ctx.player?.alive,
          enemiesAlive: ctx.director?.enemies?.length ?? -1,
          engineRunning: engine.running,
          // Diagnostics, not fingerprint: `gate` is written to
          // `diagnostics.settleGate`, which `--compare` never reads. Recorded on
          // every run so a reader can see `single`/`host` next to the verdict.
          netRole: ctx.netRole ?? null,
          netClients: ctx.net?.clients?.size ?? null,
        };
        const gateFailures = [];
        if (gate.paused !== false) gateFailures.push('ctx.paused is not false');
        if (gate.menuScreen != null) gateFailures.push(`a menu is up: ${gate.menuScreen}`);
        if (gate.localTick !== preSteps) gateFailures.push(`player stepped ${gate.localTick}, expected ${preSteps}`);
        if (!gate.progressionStarted) gateFailures.push('Progression never began stage 1');
        if (!gate.playerAlive) gateFailures.push('player died during the settle window');
        if (gate.enemiesAlive <= 0) gateFailures.push('no enemies alive — the Director never spawned');
        if (gate.engineRunning) gateFailures.push('engine.stop() did not stop the frame loop');
        // The whole meaning of `--coop-host` is that these two are true. A
        // `startHost` that quietly did nothing would otherwise leave this gate
        // comparing single-player to single-player and reporting it as proof
        // that hosting changes nothing.
        if (coopHost && gate.netRole !== 'host') {
          gateFailures.push(`--coop-host did not start a host: ctx.netRole is ${gate.netRole}`);
        }
        if (coopHost && gate.netClients !== 0) {
          gateFailures.push(`the host has ${gate.netClients} peer(s); this gate measures a roster of one`);
        }
        if (gateFailures.length) return { gateFailures, gate, startState };

        /* What a `damage` event's source is bucketed by, and why it is not
         * `type`.
         *
         * The payload `Combat.js:478-481` emits is
         * `{ target, source, amount, toHealth, absorbed, crit, position, proc }`
         * — there is no `type` field on it at all. Keying on `e.type || 'none'`
         * would have filed 100% of damage under `'none'`: an accumulator that
         * looks populated and discriminates nothing.
         *
         * `source` is the attacking entity — the `Enemy` for melee, `p.owner`
         * (also the `Enemy`) for projectiles, `ctx.player` for the survivor's
         * own hits, and `null` for environmental damage. `constructor.name` is
         * `'Enemy'` for every monster in the game and is degenerate for the same
         * reason `type` was; `def.id` is the spawn-card id from
         * `data/enemies.js` ('mite', 'scarab', 'skink'...), which is stable
         * across runs and is the granularity a targeting change shows up at. The
         * elite affix rides along because it multiplies damage, so folding it in
         * would hide an affix-only change.
         */
        const sourceKey = (s) => {
          if (!s) return 'environment';
          if (s.isPlayer) return 'player';
          const id = s.def?.id;
          if (id) return s.affix ? `${id}+${s.affix}` : id;
          return s.constructor?.name || 'unknown';
        };

        const add = (bucket, key, v) => { bucket[key] = (bucket[key] || 0) + v; };

        // One accumulator shape, used by both windows. Window 2 gets its own
        // instance under `deadTarget` rather than adding into window 1's, so a
        // downstream task can see *which* window moved.
        const newAcc = () => ({
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
        });
        const roundAcc = (acc) => {
          acc.damageToPlayer = round(acc.damageToPlayer);
          acc.damageToPlayerToHealth = round(acc.damageToPlayerToHealth);
          acc.damageToPlayerAbsorbed = round(acc.damageToPlayerAbsorbed);
          acc.damageToEnemies = round(acc.damageToEnemies);
          for (const k in acc.damageToPlayerBySource) acc.damageToPlayerBySource[k] = round(acc.damageToPlayerBySource[k]);
          for (const k in acc.damageToEnemiesBySource) acc.damageToEnemiesBySource[k] = round(acc.damageToEnemiesBySource[k]);
          return acc;
        };

        let acc = newAcc();
        // Off only while the probe deals its own lethal blow to open window 2.
        // That blow is the fixture, not a measurement: left recorded it wrote
        // `damageToPlayer: 1000000` and an `environment` bucket into the second
        // window and buried everything the window is actually for.
        let recording = true;
        const offDamage = ctx.events.on('damage', (e) => {
          if (!recording) return;
          acc.damageEvents++;
          if (e.crit) acc.crits++;
          const k = sourceKey(e.source);
          if (e.target === ctx.player) {
            acc.damageToPlayer += e.amount || 0;
            acc.damageToPlayerToHealth += e.toHealth || 0;
            acc.damageToPlayerAbsorbed += e.absorbed || 0;
            add(acc.damageToPlayerBySource, k, e.amount || 0);
          } else {
            acc.damageToEnemies += e.amount || 0;
            add(acc.damageToEnemiesBySource, k, e.amount || 0);
          }
        });
        const offKill = ctx.events.on('kill', (e) => {
          if (!recording) return;
          acc.kills++;
          if (e?.victim?.isPlayer) acc.playerDeaths++; else acc.enemyKills++;
        });

        const positionsOf = (list) => list
          .map((e) => [round(e.position.x), round(e.position.y), round(e.position.z)])
          .sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);

        // Only living bodies. `Director.enemies` also holds corpses that have
        // not been reaped yet, whose positions are frozen and cannot respond to
        // any behaviour change — including them inflates the field's apparent
        // discriminating power without adding any.
        const livingOf = (list) => list.filter((e) => e.alive);

        const stateCounts = (list) => {
          const m = {};
          for (const e of list) {
            const s = e.fsm?.state;
            const k = s == null ? 'none' : String(s);
            m[k] = (m[k] || 0) + 1;
          }
          return m;
        };

        // `lastFrameError` is absolute where `frameErrors` is a delta, so a
        // throw during the *unpinned* page-load window — wall-clock dependent,
        // i.e. the non-determinism this probe exists to remove — would otherwise
        // be baked into the fingerprint while `frameErrors` stayed 0 and the
        // probe exited clean. Recorded only when the count actually moved.
        const errorsAtStart = ctx.frameErrors;
        const errorSince = () => (ctx.frameErrors > errorsAtStart ? ctx.lastFrameError : null);

        // ---- window 1: the survivor alive and fighting ----------------------
        let enemiesAliveMax = 0;
        for (let i = 0; i < steps; i++) {
          step(1);
          const n = livingOf(ctx.director?.enemies ?? []).length;
          if (n > enemiesAliveMax) enemiesAliveMax = n;
        }

        const live = ctx.director?.enemies ?? [];
        const f = {
          seed: ctx.seed,
          preSteps,
          steps,
          deadSteps,
          ...roundAcc(acc),
          enemiesAlive: livingOf(live).length,
          enemiesAliveMax,
          enemyStates: stateCounts(livingOf(live)),
          goldTotal: ctx.items?.gold ?? 0,
          playerLevel: ctx.progression?.level ?? 0,
          playerMaxHealth: round(ctx.player?.maxHealth ?? 0),
          // Real measurements, unlike the `playerHealth` these replace: the
          // low-water mark the fixture prevented, and how much health it put
          // back over the window. Both move with any change in incoming damage.
          playerHealthMin: round(playerHealthMin === Infinity ? 0 : playerHealthMin),
          healthRestored: round(healthRestored),
          playerShield: round(ctx.player?.shield ?? 0),
          // The pawn the roster migration replaces. Cheapest, highest-signal
          // state in the sim, and window 1 recorded thirteen enemies and not the
          // one entity the plan is about.
          playerPosition: [round(ctx.player?.position?.x ?? 0), round(ctx.player?.position?.y ?? 0), round(ctx.player?.position?.z ?? 0)],
          playerVelocity: [round(ctx.player?.velocity?.x ?? 0), round(ctx.player?.velocity?.y ?? 0), round(ctx.player?.velocity?.z ?? 0)],
          ctxTime: round(ctx.time),
          frameErrors: ctx.frameErrors - errorsAtStart,
          lastFrameError: errorSince(),
          // Sorted, so a change in iteration order is not mistaken for a change
          // in behaviour — and rounded, because noise in the last bits of a
          // float is not a regression and must not read as one.
          finalEnemyPositions: positionsOf(livingOf(live)),
        };

        /* ---- window 2: no live target -------------------------------------
         *
         * `Enemy.fixedUpdate` (`Enemy.js:450-455`) is
         *
         *     const p = ctx.player;
         *     if (p && p.position) { this.target.copy(p.position); … }
         *     else { this.distToPlayer = 999; }
         *
         * and that `if/else` is the statement Task 6 rewrites into a roster
         * query. Window 1 pins the survivor alive, so the fallback arm never
         * changes shape and a migration that gets the empty-roster case wrong
         * ships a green gate. The failure it hides is not theoretical: an
         * `undefined` where a fallback belonged makes every enemy throw once per
         * step, `Engine._call` swallows it (`Engine.js:100-113`), and the only
         * visible symptom is a death screen at 3 fps.
         *
         * The survivor is killed through the real damage path rather than by
         * assignment, so `Combat._kill`, the `kill` and `playerDead` events,
         * `Progression._endRun` and `Director.enabled = false` all run exactly
         * as they do in play. `_iframeUntil` is cleared first for the same
         * reason `Harness`'s own death scenario clears it — an i-frame window
         * would silently eat the killing blow and leave the survivor alive.
         */
        holdAliveOn = false;
        acc = newAcc();
        const deadErrorsAtStart = ctx.frameErrors;

        const p = ctx.player;
        recording = false;
        if (p) {
          p._iframeUntil = 0;
          ctx.combat?.applyDamage?.(p, 1e6, { type: 'sp-equivalence', isDot: true, ignoreArmor: true });
        }
        recording = true;
        const killedOnDemand = !ctx.player?.alive;

        step(deadSteps);

        const after = ctx.director?.enemies ?? [];
        // The direct probe of the fallback arm: how many enemies are carrying
        // the `distToPlayer = 999` sentinel that the `else` branch writes. It is
        // 0 today, because `ctx.player` outlives the survivor's death and the
        // `if` arm still wins — which is exactly why this number is worth
        // recording *before* the migration. After it, a roster with nothing
        // alive in it is what puts enemies on that branch, and this field is
        // where that shows up.
        const onFallback = after.filter((e) => e.distToPlayer === 999).length;

        f.deadTarget = {
          steps: deadSteps,
          killedOnDemand,
          playerAlive: !!ctx.player?.alive,
          playerExists: !!ctx.player,
          enemiesOnFallbackTarget: onFallback,
          ...roundAcc(acc),
          enemiesAlive: livingOf(after).length,
          enemyStates: stateCounts(livingOf(after)),
          finalEnemyPositions: positionsOf(livingOf(after)),
          directorEnabled: !!ctx.director?.enabled,
          frameErrors: ctx.frameErrors - deadErrorsAtStart,
          lastFrameError: ctx.frameErrors > deadErrorsAtStart ? ctx.lastFrameError : null,
        };

        offDamage();
        offKill();

        return {
          fingerprint: f,
          gate,
          startState,
          // Not rounded: this is the proof that nothing advanced the clock
          // behind the hand-driven loop, and rounding it away hides exactly
          // that.
          rawCtxTime: ctx.time,
        };
      },
      {
        preSteps: PRE_STEPS, steps: STEPS, deadSteps: DEAD_STEPS, r: R,
        defaultHeight: DEFAULT_ENEMY_HEIGHT, coopHost: COOP_HOST,
      },
    );
    pageErrors.push(...b.errs);
    await b.page.close();
  }
} catch (e) {
  // A held port is not a defect in the code under test, but it presents as one.
  // Naming it here is the whole of issue #68's third item: two implementers
  // spent a diagnosis cycle each on this exact failure in one day, one of them
  // chasing a branch that was fine.
  // Three spellings, because the one that actually happens is the least
  // obvious. Node raises `EADDRINUSE`, but vite catches that and rethrows its
  // own plain `Error: Port 5251 is already in use` with no `code` — so a
  // handler matching only the node spelling looks right, passes review, and
  // does nothing. Verified against a held port rather than assumed.
  if (e?.code === 'EADDRINUSE'
    || /EADDRINUSE|(?:address|port \d+) (?:is )?already in use/i.test(String(e?.message ?? ''))) {
    console.error(
      `\nPORT ${PORT} IS HELD — this is not a failure in the code under test.\n`
      + (PORT === 5209
        // Only true of the default. Saying it of an explicit --port would be
        // the same species of confidently-wrong diagnostic this exists to end.
        ? '  5209 is the shared default for all three gates (gate:sp, gate:mp1,\n'
          + '  gate:elite), including across separate git worktrees, so another gate is\n'
          + '  the likeliest holder.\n'
        : '  Something else is already listening there.\n')
      + '  A previously failed run can also leave chromium up still holding it.\n'
      + `  Wait for the other run, or give this one its own port:  --port ${PORT + 40}\n`
      + `  (or SP_PORT=${PORT + 40})\n`,
    );
    // `process.exit` does not run the `finally` below, and leaking a chromium
    // is how the *next* run fails differently. Close here, and null the handles
    // so the finally cannot double-close them. Each close is guarded on its
    // own: a `close()` that throws while we are already handling a bind failure
    // would otherwise escape before its handle was nulled, and the finally
    // would then close the same broken handle a second time — a diagnostic
    // turning back into a stack trace at the worst moment.
    try { await browser?.close(); } catch { /* already gone */ }
    browser = null;
    try { await server?.close(); } catch { /* already gone */ }
    server = null;
    process.exit(3);
  }
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}

if (liveness?.gate !== 'fired') {
  console.error('LIVENESS GATE FAILED — the page never reached live gameplay:', liveness);
  process.exit(1);
}
if (pageErrors.length) {
  console.error('PAGE ERRORS — fingerprint is not trustworthy:', pageErrors);
  process.exit(1);
}
if (MODE === 'elite-dps') {
  if (elite?.gateFailures || elite?.armFailures) {
    console.error('ELITE ARM GATE FAILED — the page is not playing:', elite);
    process.exit(1);
  }
  const eDrift = Math.abs(elite.rawCtxTime - elite.expectedCtxTime);
  if (eDrift > DRIFT_TOLERANCE) {
    console.error(`CLOCK DRIFT — ctx.time is ${elite.rawCtxTime}, expected ${elite.expectedCtxTime} (drift ${eDrift}).`);
    process.exit(1);
  }
  if (elite.frameErrors > 0) {
    console.error('SYSTEM THREW DURING A MEASURED ARM:', elite.frameErrors, elite.lastFrameError);
    process.exit(1);
  }
  // Per-arm invariants. Each of these has failed a real run at least once in
  // this repo's history, and every one of them turns a plausible-looking dps
  // into a number about a different fixture than the one the report describes.
  const armFail = [];
  for (const [name, a] of Object.entries(elite.arms)) {
    if (a.foreignDamage > 0) armFail.push(`${name}: ${a.foreignDamage} damage from something other than the subject`);
    if (!a.eliteAlive) armFail.push(`${name}: the subject died mid-arm`);
    if (a.enemiesOnStage !== 1) armFail.push(`${name}: ${a.enemiesOnStage} enemies on stage, expected 1`);
    if (a.baseDamage !== 21) armFail.push(`${name}: baseDamage ${a.baseDamage}, expected 21 — the difficulty pin did not hold`);
    if (a.unitLevel !== 1) armFail.push(`${name}: unit level ${a.unitLevel}, expected 1`);
    if (!a.playerAlive) armFail.push(`${name}: the survivor died — the top-up did not hold`);
    /* Keyed off the affix table, not off the observed fraction.
     *
     * The first version of this was `inAuraFraction > 0 && < 1`, where the `> 0`
     * existed so rimebound and plain — which have no aura — could pass. The cost
     * was that the one failure it exists to catch walked through it: an emberclad
     * arm whose aura had silently stopped existing (an `auraRadius` typo, or
     * `auraDps` falling to 0 and taking the whole gated block with it) records
     * `inAuraFraction` 0 and passed every gate, reporting a collapsed dps as a
     * clean measurement. `hasAura` is read off `unit.elite` at spawn, so the
     * assertion now knows whether the arm was *supposed* to have one.
     */
    if (a.hold && a.hasAura && a.metres < a.auraRadius && a.inAuraFraction !== 1) {
      armFail.push(`${name}: inAuraFraction ${a.inAuraFraction} on a held arm ${a.metres} m inside a ${a.auraRadius} m aura, expected 1`);
    }
    if (a.hold && a.affix === 'emberclad' && !a.hasAura) {
      armFail.push(`${name}: emberclad recorded no aura at all — auraDps or auraRadius is 0 in ELITE_STATS`);
    }
  }

  /* The elite is actually in the window. Fail loudly rather than report clean.
   *
   * `reviews/round7/baseline-00f8900.json` — the fingerprint mode's baseline —
   * contains no `<id>+<affix>` source key anywhere, because its 60 s of stage 1
   * never banks enough credit for a 4.5-credit affix. So a change to
   * `ELITE_STATS` gets `no fields moved` from that gate and it means nothing.
   * This arm is the instrument that *does* have power over an affix change, and
   * it is worth exactly as much as the elite being present. Without this
   * assertion, an affix that stopped spawning, stopped reaching the survivor or
   * stopped dealing damage would report six clean arms and a green run.
   */
  const eliteKeys = [];
  for (const [name, a] of Object.entries(elite.arms)) {
    if (a.affix === 'none') continue;
    const keys = Object.keys(a.sourceKeys ?? {}).filter((k) => k.includes('+'));
    if (!keys.length) armFail.push(`${name}: no "<id>+<affix>" damage source recorded — no elite was measured`);
    else eliteKeys.push(...keys);
  }
  if (!eliteKeys.length) {
    armFail.push('no elite damage source in any arm — this capture proves nothing about an affix change');
  }
  const lethalKeys = Object.keys(elite.lethal?.sourceKeys ?? {}).filter((k) => k.includes('+'));
  if (!lethalKeys.length) armFail.push('lethal arm: no elite damage source recorded');
  if (elite.lethal?.foreignDamage > 0) armFail.push(`lethal arm: ${elite.lethal.foreignDamage} damage from something other than the subject`);
  if (armFail.length) {
    console.error('ELITE ARM INVARIANTS FAILED:\n  ' + armFail.join('\n  '));
    process.exit(1);
  }

  const eliteOut = {
    mode: 'elite-dps',
    source: captureSource(),
    card: elite.card,
    arms: elite.arms,
    lethal: elite.lethal,
    diagnostics: {
      liveness, gate: elite.gate, rawCtxTime: elite.rawCtxTime,
      stepsTaken: elite.stepsTaken, clockDrift: eDrift,
    },
  };
  const ejson = JSON.stringify(eliteOut, null, 2);
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, ejson);
    console.log(`wrote ${outPath}`);
  } else if (!comparePath) {
    // Same condition as the fingerprint mode's: dumping the whole capture on
    // top of a one-line verdict trains a reader to skim past the verdict.
    console.log(ejson);
  }
  const plainContact = elite.arms[`plain@${CONTACT_M}`]?.dps ?? 0;
  for (const [name, a] of Object.entries(elite.arms)) {
    console.log(`${name.padEnd(16)} dps ${String(a.dps).padStart(7)}  aura ${String(a.auraDirectDps).padStart(6)}  burnDot ${String(a.burnDotDps).padStart(6)}  melee ${String(a.meleeDps).padStart(6)}`);
  }
  if (plainContact > 0) {
    for (const k of [`emberclad@${CONTACT_M}`, `rimebound@${CONTACT_M}`]) {
      console.log(`${k} is ${(elite.arms[k].dps / plainContact).toFixed(2)}x plain@${CONTACT_M}`);
    }
  }
  const L = elite.lethal;
  console.log(`lethal ${L.affix}@${L.metres}  time to death from ${L.startHealth} HP: `
    + (L.timeToDeath == null ? `SURVIVED ${L.windowSeconds}s` : `${L.timeToDeath}s`)
    + `  (${L.damageTaken} damage, ${JSON.stringify(L.byType)})`);

  /* `--compare` for this mode, which is what turns it from an instrument into a
   * gate.
   *
   * Until this existed, `ELITE_STATS` was the largest measured behaviour change
   * on the branch — emberclad 100.7 -> 40.9 dps — with nothing that could fail on
   * it. The default fingerprint is structurally blind to affixes (see the NOTE
   * it prints), this mode had no comparator at all, and there was no committed
   * baseline for one to read. A regression was caught by a human reading six
   * numbers, or not at all.
   *
   * Exact, not tolerance-banded, and that is a measurement rather than a hope.
   * Three consecutive captures of an unchanged tree were compared field by
   * field and are identical in every one — all 24 per-arm rates, every
   * ELITE_STATS-derived field, and the lethal arm's damage, step count and
   * time-to-death. The arm has no wall-clock input: the survivor is parked, the
   * elite is the only unit on stage, and the clock is hand-driven from step
   * zero, so there is nothing left to vary. `CONTACT_STEPS`' comment records a
   * ~6% run-to-run spread — that was measured at a 20 s window, and it is the
   * reason the window is 40 s; at 40 s the spread is zero.
   *
   * A tolerance would therefore be a band around a number that does not move,
   * and every dps in it would be free to drift by that band with no gate. If
   * this ever proves machine-dependent rather than run-dependent, the answer is
   * a tolerance with a measured floor — not a re-baseline.
   *
   * `diagnostics` is excluded for the same reason the fingerprint mode excludes
   * its own: it carries the liveness gate and the clock drift, which are
   * wall-clock derived.
   */
  if (comparePath) {
    const baseline = JSON.parse(readFileSync(comparePath, 'utf8'));
    if (baseline.mode !== 'elite-dps') {
      console.error(`${comparePath} is not an elite-dps capture (mode: ${baseline.mode ?? 'absent'}).`);
      console.error('The fingerprint baseline cannot gate an affix change — that blindness is why this mode exists.');
      process.exit(2);
    }
    const view = (o) => ({ mode: o.mode, card: o.card, arms: o.arms, lethal: o.lethal });
    const moved = compareFingerprints(view(baseline), view(eliteOut));
    if (!moved.length) {
      console.log(`\nelite damage unchanged vs ${comparePath} — no fields moved`);
      process.exit(0);
    }
    console.error(`\nELITE DAMAGE MOVED vs ${comparePath} — ${moved.length} field(s):\n`);
    for (const m of moved) {
      console.error(`  ${m.field}\n    baseline: ${JSON.stringify(m.baseline)}\n    now:      ${JSON.stringify(m.fresh)}`);
    }
    console.error('\nUnlike the fingerprint gate, this one is not a chaotic amplifier: the arms are');
    console.error('one pinned unit against one parked survivor, so the size of a move here is the');
    console.error('size of the change. Re-baselining is a decision for the human partner.');
    process.exit(1);
  }
  process.exit(0);
}

if (result?.gateFailures) {
  console.error('SETTLE GATE FAILED — the page is not playing:', result);
  process.exit(1);
}

// The frame loop really was stopped. A live rAF would have gone on calling
// `_frame`, which advances `ctx.time` by FIXED per substep on top of ours.
const expectedTime = (PRE_STEPS + STEPS + DEAD_STEPS) / 60;
const drift = Math.abs(result.rawCtxTime - expectedTime);
if (drift > DRIFT_TOLERANCE) {
  console.error(`CLOCK DRIFT — ctx.time is ${result.rawCtxTime}, expected ${expectedTime} (drift ${drift}).`);
  console.error('Something advanced the simulation outside the hand-driven loop; the fingerprint is not pinned.');
  process.exit(1);
}

const totalErrors = result.fingerprint.frameErrors + result.fingerprint.deadTarget.frameErrors;
if (totalErrors > 0) {
  console.error('SYSTEM THREW DURING A MEASURED WINDOW — fingerprint is not trustworthy:',
    { window1: result.fingerprint.frameErrors, deadTarget: result.fingerprint.deadTarget.frameErrors },
    result.fingerprint.lastFrameError ?? result.fingerprint.deadTarget.lastFrameError);
  process.exit(1);
}

const out = {
  source: captureSource(),
  fingerprint: result.fingerprint,
  // Diagnostics, deliberately outside `fingerprint` so a diff of the thing this
  // instrument exists to compare is not polluted by wall-clock numbers. These
  // fields DO differ between runs on an unchanged tree — use `--compare`, not
  // `diff`.
  diagnostics: {
    liveness,
    settleGate: result.gate,
    startState: result.startState,
    rawCtxTime: result.rawCtxTime,
    clockDrift: drift,
  },
};

const json = JSON.stringify(out, null, 2);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  console.log(`wrote ${outPath}`);
} else if (!comparePath) {
  console.log(json);
}

/* What this fingerprint cannot see, said out loud every time it is taken.
 *
 * `sourceKey` files an elite as `<id>+<affix>`. Measured: no such key exists
 * anywhere in `reviews/round7/baseline-00f8900.json` — 10 s of settle plus 60 s of
 * stage 1 never banks the 4.5 credits an affix costs, and `enemiesAliveMax` is
 * 6. So a change to `ELITE_STATS` moves nothing here and `--compare` reports
 * `no fields moved` for a change that halved an affix's damage.
 *
 * This is not fixed by failing the run — it would fail every run, including the
 * five earlier tasks legitimately gated by this file — so it is printed instead,
 * next to the verdict a reader is about to act on. `--mode elite-dps` is the
 * instrument with power over an affix change, and *that* mode does fail loudly
 * when no elite is in its window.
 */
const eliteBuckets = [
  ...Object.keys(out.fingerprint.damageToPlayerBySource ?? {}),
  ...Object.keys(out.fingerprint.damageToEnemiesBySource ?? {}),
  ...Object.keys(out.fingerprint.deadTarget?.damageToPlayerBySource ?? {}),
].filter((k) => k.includes('+'));
if (!eliteBuckets.length) {
  console.error('NOTE: this window contains no elite (no "<id>+<affix>" damage source).');
  console.error('      A change to ELITE_STATS cannot move this fingerprint. Run `npm run gate:elite`,');
  console.error('      which is the gate that does have power over it.');
}

if (comparePath) {
  const baseline = JSON.parse(readFileSync(comparePath, 'utf8'));
  // The mirror of the elite mode's guard. Handing this mode an elite baseline
  // used to flatten `undefined` into a single empty-named field and report one
  // meaningless move, which reads as a regression in a file that has none.
  if (!baseline.fingerprint) {
    console.error(`${comparePath} is not an equivalence capture (no "fingerprint" object).`);
    console.error('An elite-dps baseline is compared with --mode elite-dps.');
    process.exit(2);
  }
  const moved = compareFingerprints(baseline.fingerprint, out.fingerprint);
  if (!moved.length) {
    console.log(`single-player unchanged vs ${comparePath} — no fields moved`);
    process.exit(0);
  }
  console.error(`SINGLE-PLAYER MOVED vs ${comparePath} — ${moved.length} field(s):\n`);
  for (const m of moved) {
    console.error(`  ${m.field}\n    baseline: ${JSON.stringify(m.baseline)}\n    now:      ${JSON.stringify(m.fresh)}`);
  }
  console.error('\nRemember this instrument is a chaotic amplifier: the size of this list says');
  console.error('nothing about the size of the regression. See the header of tests/sp-equivalence.mjs.');
  process.exit(1);
}
