/**
 * Cross-survivor alignment/build balance matrix (issue #232).
 *
 * A deterministic smoke harness covering all five survivors x the three
 * alignment paths (pure / mixed / corrupted): 15 cells, one comparable metric
 * set apiece. This measures. It changes no balance value in `src/` and makes
 * no tuning recommendation — it exists so a later tuning pass has a shared,
 * reproducible instrument instead of anecdotes.
 *
 *   node tools/balance-matrix.mjs [--lane A|B|C] [--out reviews/balance-matrix]
 *
 * MODELLED ON `tests/sp-equivalence.mjs`: same pinned-clock technique
 * (`engine.stop()`, then hand-driven `fixedUpdate`), same headed-Chromium,
 * one-vite-server-many-pages shape. Read that file's header before touching
 * the clock-pinning here — the reasoning is not repeated in this comment.
 *
 * HOW A CELL REACHES ITS ALIGNMENT, and why this is the load-bearing design
 * decision in this file:
 *
 * `Corruption.commit(source, amount)` (`src/systems/Corruption.js`) is the
 * ledger's ONE writer — every real trigger in the game (a chest, an altar, a
 * void bargain, a sealed wound) reaches the ledger through exactly this
 * method, which prices the act via `weightOf`/`classOf`, gates on
 * `ctx.authority`, appends the history row and emits `alignmentCommitted`.
 * This harness calls it directly with real source names from
 * `src/data/alignment.js`'s `SOURCES` table — e.g. `commit('corruptChest', 1)`
 * — which is the identical call `Corruption`'s own `itemOffer` listener makes
 * when a player actually forces a chest. That is "driving the real
 * commitment path": every number that moves, moves through the production
 * write function. What this file does NOT do is reach into
 * `ctx.corruption._ledger` and add to a class directly — that would skip
 * `weightOf`, the authority gate and the history log, and would measure a
 * ledger shape the game itself can never produce.
 *
 * Each path's recipe commits through several distinct wired sources (not one
 * source repeated) so the archetype exercises a spread of the table, and its
 * total lands comfortably past both `TOLERANCE` and `CAPSTONE.{corrupt,pure}`
 * (`src/data/alignment.js`) — a representative committed run, not a
 * bare-minimum crossing:
 *
 *   pure    sanctuary + consecration + stabilised + salvaged + woundSealed
 *           + vowKept   = 2+5+3+3+5+6 = 24
 *   corrupt corruptChest + blightMutation + bargainSynergy + bargainPact
 *           + corruptUpgrade + woundFed = 3+4+4+5+4+5 = 25
 *   mixed   tempered x3 (mixed has exactly one wired source) = 8*3 = 24
 *
 * Each cell's own `alignmentOf(ledger)` is asserted against the path it was
 * built for — a recipe that stopped producing its intended classification
 * (a `TOLERANCE`/`CAPSTONE` retune, say) fails loudly rather than silently
 * mislabelling a cell.
 *
 * SURVIVOR SELECTION: `?survivor=<id>` (added to `src/main.js` for this
 * issue) sets `ctx.survivorId` before `Menus` is constructed, which is the
 * exact field `Menus`'s own constructor already falls back to
 * (`Menus.js:289`) and the one `Player` boots from. No new selection code
 * path — this is the field a resumed save already carries.
 *
 * DETERMINISM: the matrix always re-runs cell 0 (ranger/pure) a second time
 * and diffs its full metrics object (minus the declared-volatile keys) against
 * the first run. This is the guard, and it is meant to be able to fail: it
 * failed for real during development the moment a `Date.now()` timestamp was
 * left inside a measured field, and passed again once that field moved to
 * `diagnostics` (excluded from the diff) — see `VOLATILE_KEYS` below.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { laneBase } from './lib/lanes.mjs';
import { argValue, hasArg } from './lib/parse-args.mjs';
import { resolveOutDir } from './lib/evidence.mjs';
import { checkAlignmentDiscrimination } from './lib/alignment-discrimination.mjs';

// Fixed, not tuned — any value works, changing it invalidates a captured
// matrix as a comparison point. Distinct from sp-equivalence's SEED so a
// person running both in the same session cannot mistake one gate's fixture
// for the other's.
const SEED = 20260826;

// Settle before the alignment recipe fires and the combat window opens. Short
// on purpose (this is a smoke instrument, not `gate:sp`): long enough for
// `Progression` to build stage 1 and the Director to have a live target,
// short enough that 15 cells plus one determinism re-run cost minutes.
const PRE_STEPS = 180;

// The measured combat window, in fixed steps at 60 Hz (10 s). Long enough
// that the held-trigger, aim-at-nearest fixture (borrowed verbatim from
// `sp-equivalence`) lands several kills; short enough to keep sixteen page
// loads (15 cells + 1 determinism re-run) inside a few minutes.
const STEPS = 600;

const LIVE_GATE_MS = 45000;
const STAGE_TIMEOUT_MS = 60000;
const EVAL_TIMEOUT_MS = 120000;
const R = 1e6;

const PORT = Number(
  (() => {
    const laneGiven = hasArg(process.argv, '--lane');
    const portGiven = hasArg(process.argv, '--port');
    let laneVal, portVal;
    try {
      laneVal = argValue(process.argv, '--lane');
      portVal = argValue(process.argv, '--port');
    } catch (e) { console.error(`balance-matrix: ${e.message}`); process.exit(2); }
    if (laneGiven && portGiven) {
      console.error('balance-matrix: pass --lane or --port, not both — they set the same thing.');
      process.exit(2);
    }
    if (laneGiven) {
      try { return laneBase(laneVal); }
      catch (e) { console.error(`balance-matrix: ${e.message}`); process.exit(2); }
    }
    return portGiven ? portVal : process.env.MATRIX_PORT;
  })() ?? 5230,
);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`balance-matrix: --port/MATRIX_PORT must be an integer in 1024-65535, got ${PORT}`);
  process.exit(2);
}

const outArg = (() => {
  try { return argValue(process.argv, '--out'); }
  catch (e) { console.error(`balance-matrix: ${e.message}`); process.exit(2); }
})();
const OUT_DIR = resolveOutDir(outArg ?? 'reviews/balance-matrix', { tool: 'balance-matrix' });

const SURVIVORS = ['ranger', 'anvil', 'kestrel', 'rook', 'cinder'];

/** Every recipe totals comfortably past TOLERANCE and CAPSTONE — see header. */
const RECIPES = {
  pure: [['sanctuary', 1], ['consecration', 1], ['stabilised', 1], ['salvaged', 1], ['woundSealed', 1], ['vowKept', 1]],
  corrupt: [['corruptChest', 1], ['blightMutation', 1], ['bargainSynergy', 1], ['bargainPact', 1], ['corruptUpgrade', 1], ['woundFed', 1]],
  mixed: [['tempered', 3]],
};
const PATHS = ['pure', 'mixed', 'corrupt'];

/** What produced this capture — the reproducibility convention this repo insists on. */
function captureSource() {
  const git = (a) => {
    try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return null; }
  };
  return {
    tool: 'tools/balance-matrix.mjs',
    seed: SEED,
    preSteps: PRE_STEPS,
    steps: STEPS,
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain']) !== '',
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Run one cell: boot a page as `survivor`, settle, commit `path`'s recipe,
 * then run the measured combat window. Everything below `evaluate` executes
 * inside the page, in one synchronous hand-driven loop — no rAF, no wall
 * clock — exactly the technique `sp-equivalence`'s header explains at length.
 */
async function runCell(browser, { survivor, path }) {
  const url = `http://127.0.0.1:${PORT}/?seed=${SEED}&quality=1&harness=1&survivor=${survivor}`;

  // Phase A: liveness, unpinned, on its own throwaway page — proves this
  // build actually plays before the pinned measurement below is trusted to
  // mean anything. A *separate* page from phase B's, matching
  // `sp-equivalence`'s shape exactly: dismissing here lets the real rAF loop
  // run while `waitForFunction` polls, so `ctx.player._localTick` is already
  // nonzero by the time it resolves. Measuring on this same page would start
  // the pinned window from whatever tick liveness happened to settle at
  // (measured: 187-188, not 0) rather than from a known, reproducible zero.
  const a = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  a.setDefaultTimeout(EVAL_TIMEOUT_MS);
  const pageErrors = [];
  a.on('pageerror', (e) => pageErrors.push(e.message));
  await a.goto(url, { waitUntil: 'load' });
  await a.waitForFunction(
    () => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null,
    null, { timeout: STAGE_TIMEOUT_MS },
  );
  await a.evaluate(() => globalThis.__HARNESS__.dismiss());
  let liveGate = 'fired';
  try {
    await a.waitForFunction(
      () => globalThis.__GAME__.ctx.paused === false,
      null, { timeout: LIVE_GATE_MS },
    );
  } catch (e) {
    liveGate = `TIMED OUT: ${String(e?.message ?? e)}`;
  }
  await a.close();

  let result = null;
  if (liveGate === 'fired') {
    // Phase B: fresh page, dismiss-and-stop in one synchronous block (no rAF
    // can land between them), so the pinned loop below starts from tick zero.
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(EVAL_TIMEOUT_MS);
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(
      () => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null,
      null, { timeout: STAGE_TIMEOUT_MS },
    );
    result = await page.evaluate(
      ({ preSteps, steps, r, recipe, path, defaultHeight }) => {
        const { engine, ctx } = globalThis.__GAME__;
        const H = 1 / 60;
        const round = (n) => Math.round(n * r) / r;

        globalThis.__HARNESS__.dismiss();
        engine.stop();

        ctx.input.mouse.left = true;
        const aimAtNearest = () => {
          const p = ctx.player, rig = ctx.cameraRig;
          if (!p || !rig) return;
          let best = null, bestD = Infinity;
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

        let healthRestored = 0;
        const holdAlive = () => {
          const p = ctx.player;
          if (!p || !p.alive || !(p.maxHealth > 0)) return;
          healthRestored += Math.max(0, p.maxHealth - p.health);
          p.health = p.maxHealth;
        };

        const step = (n) => {
          for (let i = 0; i < n; i++) {
            aimAtNearest();
            ctx.time += H;
            for (const s of engine.systems) if (s.fixedUpdate) s.fixedUpdate(ctx, H);
            for (const e of ctx.director?.enemies ?? []) e.update?.(ctx, H);
            ctx.cameraRig?.lateUpdate?.(ctx, H);
            ctx.camera.updateMatrixWorld(true);
            holdAlive();
          }
        };

        step(preSteps);

        const settleGate = {
          paused: ctx.paused,
          menuScreen: ctx.menus?.screen ?? null,
          localTick: ctx.player?._localTick ?? null,
          expectedLocalTick: preSteps,
          progressionStarted: !!ctx.progression?._started,
          playerAlive: !!ctx.player?.alive,
          enemiesAlive: ctx.director?.enemies?.length ?? -1,
          engineRunning: engine.running,
          authority: !!ctx.authority,
          survivorId: ctx.survivorId ?? null,
        };
        const gateFailures = [];
        if (settleGate.paused !== false) gateFailures.push('ctx.paused is not false');
        if (settleGate.menuScreen != null) gateFailures.push(`a menu is up: ${settleGate.menuScreen}`);
        if (settleGate.localTick !== preSteps) gateFailures.push(`player stepped ${settleGate.localTick}, expected ${preSteps}`);
        if (!settleGate.progressionStarted) gateFailures.push('Progression never began stage 1');
        if (!settleGate.playerAlive) gateFailures.push('player died during the settle window');
        if (settleGate.enemiesAlive <= 0) gateFailures.push('no enemies alive — the Director never spawned');
        if (settleGate.engineRunning) gateFailures.push('engine.stop() did not stop the frame loop');
        if (!settleGate.authority) gateFailures.push('ctx.authority is false — commit() and applyDamage() are no-ops');
        if (settleGate.survivorId !== ctx.survivorId) gateFailures.push('survivorId mismatch (unreachable)');
        if (gateFailures.length) return { gateFailures, settleGate };

        // --- the alignment recipe: the real commitment write path -----------
        for (const [source, amount] of recipe) ctx.corruption.commit(source, amount);
        const ledger = ctx.corruption.ledger;
        const achievedAlignment = ctx.corruption.alignment;

        // --- the measured combat window --------------------------------------
        let acc = { damageToPlayer: 0, damageToEnemies: 0, damageEvents: 0, crits: 0, kills: 0 };
        const offDamage = ctx.events.on('damage', (e) => {
          acc.damageEvents++;
          if (e.crit) acc.crits++;
          if (e.target === ctx.player) acc.damageToPlayer += e.amount || 0;
          else acc.damageToEnemies += e.amount || 0;
        });
        const offKill = ctx.events.on('kill', () => { acc.kills++; });

        step(steps);
        offDamage(); offKill();

        return {
          gateFailures: [],
          settleGate,
          path,
          alignment: {
            achieved: achievedAlignment,
            matchesIntent: achievedAlignment === path,
            corrupt: round(ledger.corrupt),
            pure: round(ledger.pure),
            mixed: round(ledger.mixed),
            pureCapstone: ctx.corruption.pureCapstone,
            corruptCapstone: ctx.corruption.corruptCapstone,
          },
          corruption: {
            peakWorld: round(ctx.corruption.peak),
            marksInHand: round(ctx.corruption.marks),
            motesInHand: round(ctx.corruption.motes),
            warded: round(ctx.corruption.warded),
          },
          combat: {
            kills: acc.kills,
            damageToEnemies: round(acc.damageToEnemies),
            damageToPlayer: round(acc.damageToPlayer),
            dps: round(acc.damageToEnemies / (steps / 60)),
            crits: acc.crits,
            damageEvents: acc.damageEvents,
          },
          // Named `survivorState`, not `survivor` — the outer cell object
          // already has `survivor` as the card id string, and spreading a
          // same-named nested object over it here clobbered that string with
          // this object (caught live: the summary table's `.padEnd` on a
          // string crashed against an object).
          survivorState: {
            id: ctx.survivorId,
            level: ctx.progression?.level ?? null,
            maxHealth: round(ctx.player?.maxHealth ?? 0),
            healthRestored: round(healthRestored),
            alive: !!ctx.player?.alive,
          },
          diagnostics: {
            stepsTaken: preSteps + steps,
            rawCtxTime: ctx.time,
            expectedCtxTime: (preSteps + steps) / 60,
          },
        };
      },
      { preSteps: PRE_STEPS, steps: STEPS, r: R, recipe: RECIPES[path], path, defaultHeight: 1.6 },
    );
    await page.close();
  }

  return { survivor, path, liveGate, pageErrors, ...(result ?? { gateFailures: ['liveness gate did not fire'] }) };
}

/**
 * Keys whose values are allowed — expected — to differ between two identical
 * runs. `capturedAt`/`diagnostics.rawCtxTime` are wall-clock/float-noise, not
 * a measurement; excluding them is what makes the determinism check compare
 * the things the matrix actually claims are reproducible.
 */
const VOLATILE_KEYS = new Set([
  'diagnostics',
  // Added by the batch loop after `runCell` returns (`ok`, `ms`) — not part of
  // the cell's own measurement, and absent from the bare re-run's result.
  'ok', 'ms',
]);

function diffCells(a, b) {
  const moved = [];
  const walk = (av, bv, prefix) => {
    if (VOLATILE_KEYS.has(prefix)) return;
    if (av && bv && typeof av === 'object' && !Array.isArray(av)) {
      const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
      for (const k of keys) walk(av[k], bv[k], prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (JSON.stringify(av) !== JSON.stringify(bv)) moved.push({ field: prefix, a: av, b: bv });
  };
  walk(a, b, '');
  return moved;
}

let server = null, browser = null;
const cells = [];
let determinism = null;
try {
  server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
  await server.listen();

  const OFFSCREEN = process.env.CAPTURE_VISIBLE ? [] : ['--window-position=-2400,-2400', '--window-size=1280,720'];
  browser = await chromium.launch({
    headless: false,
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
  });

  console.log(`balance-matrix: 15 cells, seed ${SEED}, port ${PORT}`);
  for (const survivor of SURVIVORS) {
    for (const path of PATHS) {
      const t0 = Date.now();
      const cell = await runCell(browser, { survivor, path });
      const ms = Date.now() - t0;
      const ok = cell.gateFailures.length === 0 && cell.pageErrors.length === 0
        && cell.alignment?.matchesIntent === true;
      cells.push({ ...cell, ok, ms });
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'} ${survivor.padEnd(8)} ${path.padEnd(8)} `
        + `${ok ? `align=${cell.alignment.achieved} kills=${cell.combat.kills} dps=${cell.combat.dps} (${ms}ms)`
          : JSON.stringify(cell.gateFailures.length ? cell.gateFailures : { pageErrors: cell.pageErrors, alignment: cell.alignment })}`,
      );
    }
  }

  // --- the determinism guard ------------------------------------------------
  // Re-run the first cell (ranger/pure) once more, fresh page, same seed, and
  // diff its full metrics object against the first run. Any moved field —
  // other than the declared-volatile ones — is a determinism failure, loudly.
  console.log('\nbalance-matrix: determinism self-check (ranger/pure, re-run)');
  const repeat = await runCell(browser, { survivor: 'ranger', path: 'pure' });
  const moved = diffCells(cells[0], repeat);
  determinism = { moved, ok: moved.length === 0 };
  if (determinism.ok) console.log('  PASS  re-run of ranger/pure produced an identical fingerprint');
  else {
    console.log(`  FAIL  ${moved.length} field(s) moved between two runs of the same cell:`);
    for (const m of moved.slice(0, 20)) console.log(`    ${m.field}: ${JSON.stringify(m.a)} -> ${JSON.stringify(m.b)}`);
  }
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

const alignmentAxis = checkAlignmentDiscrimination(cells);
const matrix = { source: captureSource(), survivors: SURVIVORS, paths: PATHS, cells, determinism, alignmentAxis };
mkdirSync(dirname(`${OUT_DIR}/x`), { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const outFile = `${OUT_DIR}/matrix-${matrix.source.commit?.slice(0, 7) ?? 'uncommitted'}.json`;
writeFileSync(outFile, JSON.stringify(matrix, null, 2));

console.log(`\nwritten to ${outFile}`);
if (alignmentAxis.caveat) {
  console.log(`\n*** CAVEAT: ${alignmentAxis.caveat} ***`);
}
console.log('\nSURVIVOR  PATH      ALIGN     KILLS  DPS      DMG-TAKEN  CAPSTONE');
for (const c of cells) {
  if (!c.ok) { console.log(`${c.survivor.padEnd(9)} ${c.path.padEnd(9)} FAILED`); continue; }
  const cap = c.alignment.pureCapstone ? 'pure' : c.alignment.corruptCapstone ? 'corrupt' : '-';
  console.log(
    `${c.survivor.padEnd(9)} ${c.path.padEnd(9)} ${c.alignment.achieved.padEnd(9)} `
    + `${String(c.combat.kills).padEnd(6)} ${String(c.combat.dps).padEnd(8)} ${String(c.combat.damageToPlayer).padEnd(10)} ${cap}`,
  );
}

const failedCells = cells.filter((c) => !c.ok).length;
console.log(`\n${cells.length - failedCells}/${cells.length} cells passed; determinism ${determinism.ok ? 'PASS' : 'FAIL'}`);
process.exit(failedCells > 0 || !determinism.ok ? 1 : 0);
