/**
 * Live combat-juice probe — the "verify by playing" pass of the readability-
 * juice slice, run headlessly because this environment has no hands.
 *
 * The slice's unit tests drive `elementOf`, `corpseLaunch` and `KILL_SIGNATURE`
 * against hand-built stubs. They cannot answer the three questions the next
 * playtest will actually ask, because all three are about *frequency* rather
 * than about correctness:
 *
 *   (a) overkill    over N monster kills, what fraction clear
 *                   `LAUNCH.minOverkillFrac`, and how far does the body go.
 *                   Under ~10% the threshold is too high to ever be felt;
 *                   over ~70% the launch is the default rather than the reward.
 *   (b) elements    the histogram of `elementOf(type, status)` across those
 *                   kills. A family that never appears is a table entry with no
 *                   consumer; a run that is 95% kinetic means the projection
 *                   map in `src/data/damageTypes.js` is missing the types that
 *                   actually fire.
 *   (c) cost        `ctx.pipeline.renderer.info` programs/geometries/textures
 *                   and the particle emission rate at the peak of the fight.
 *                   The kill signatures add frames from the existing atlas and
 *                   no new material, so both should be flat against the commit
 *                   before the slice; a moved program count means something
 *                   forked a shader.
 *
 * Nothing here asserts. It *records*. The retune those numbers argue for is
 * the next slice's job — a quiet edit to `LAUNCH.minOverkillFrac` under cover
 * of a probe run is exactly the move this record exists to make visible.
 *
 * (d) The no-shared-stream-draw claim is not restated here. It is
 * `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json`
 * reading `no fields moved`, and the file it compares against is committed:
 * see `reviews/round9/README.md`. A probe re-deriving that claim from its own
 * run would be a second, weaker instrument for a question the fingerprint
 * already answers exactly.
 *
 * ## The two fixtures, and why there are two
 *
 * Overkill rate and element coverage are properties of a *damage profile*, not
 * of the game in the abstract, and the profile moves enormously across a run.
 *   - `mid`    five minutes in, level 8, the first twelve items. A stage-2
 *              survivor, which is where "can the launch be felt at all" is a
 *              live question.
 *   - `late`   twenty-two minutes in, level 20, every item in the catalogue at
 *              late-run stacks. Item procs are where the elemental vocabulary
 *              lives (see the `type:` literals in `src/data/items.js`), so this
 *              is where a family other than `kinetic` can appear at all, and it
 *              is the ceiling of the overkill rate.
 * A single arm would have been a number with no error bars on it. Two bracket
 * the real answer and make the fixture visible instead of implied.
 *
 * Both arms pin `ctx.time` before they start, because the director scales
 * monster health off it and the arms share one page: an unpinned second arm
 * would inherit the first one's clock and measure a difficulty nobody chose.
 * A first cut of this probe ran a level-1 survivor with no items and managed
 * **4 kills in 36,000 frames** — the arm was not measuring the floor of the
 * overkill rate, it was measuring ten minutes of difficulty scaling against a
 * starting weapon. That reading is why the floor arm is `mid` and not `early`.
 *
 * ## Cost arm
 *
 * A fixed frame budget on the `late` fixture, so the same code run on two trees
 * produces two comparable readings. `--mode cost` runs only that arm, which is
 * how the before-slice reading is taken from a worktree at the pre-slice
 * commit.
 *
 *   node tools/juiceprobe.mjs --mode cost --out <cost-record.json>
 *   node tools/juiceprobe.mjs [--seed 1337] [--port 5205] [--kills 200]
 *                             [--costBefore <a.json>] [--costAfter <b.json>]
 *                             [--out reviews/round9/juice-probe.json]
 *
 * Exit 1 only if the probe could not run to completion — a fixture that failed
 * to reach its kill target still writes its record, because a short sample is
 * evidence and a fabricated one is not.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5205);
const KILLS = Number(args.kills ?? 200);
const MODE = args.mode ?? 'full';
const OUT = path.resolve(args.out ?? 'reviews/round9/juice-probe.json');
const SOFTWARE = !!args.software;
const W = 1600, H = 900;

const commit = (() => {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return null; }
})();

await mkdir(path.dirname(OUT), { recursive: true });
const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
// Same two modes `tools/capture.mjs` and `tools/silhouette.mjs` carry, and for
// the same reason: this machine's established mode is d3d11, and a record taken
// under SwiftShader is not comparable to one taken on the real adapter — the
// cost arm reads the renderer's own counters, so the renderer is part of the
// measurement rather than an implementation detail of it.
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: [
    ...(SOFTWARE
      ? ['--use-gl=swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox']
      : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']),
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`,
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

let record = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?harness=1&pinclock=1&seed=${SEED}`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });

  // Everything the arms share, installed once. `__JUICE__` hangs off the page
  // so each arm is a small `evaluate` rather than one enormous one.
  await page.evaluate(async () => {
    const G = globalThis.__GAME__, ctx = G.ctx;
    // `LAUNCH` and `damageTypes` are this slice's own additions, so neither
    // exists on the tree the cost arm's baseline is taken from. The cost arm
    // needs neither; falling back keeps one probe file runnable on both trees,
    // which is the only way the two cost readings are the same measurement.
    let LAUNCH = null, dt = null;
    try { LAUNCH = (await import('/src/systems/VFX.js')).LAUNCH ?? null; } catch { /* pre-slice tree */ }
    try { dt = await import('/src/data/damageTypes.js'); } catch { /* pre-slice tree */ }
    LAUNCH = LAUNCH ?? { minOverkillFrac: NaN, maxSpeed: NaN, gravity: NaN, dur: NaN };
    const elementOf = dt?.elementOf ?? (() => 'unmeasurable-on-this-tree');
    const ELEMENTS = dt?.ELEMENTS ?? [];
    const items = (await import('/src/data/items.js')).ITEMS;
    const cards = (await import('/src/data/enemies.js')).SPAWN_CARDS;

    // The projection and the threshold are *imported from the game*, never
    // re-typed here. A gate tool that copies a constant silently stops testing
    // the game the day the constant moves.
    const J = globalThis.__JUICE__ = {
      LAUNCH, elementOf, ELEMENTS, ITEMS: items, CARDS: cards,
      kills: [], emitted: 0, emitPeak: 0, _emitWindow: 0, listening: false,
    };

    // Same pin `Harness`'s own scenarios use. A probe that drives 200 kills
    // through a level-1 survivor dies about eight times on the way, and a
    // fixture that keeps restarting is measuring the respawn path.
    J.pin = () => {
      const p = ctx.player;
      if (!p) return;
      p.maxHealth = 1e6; p.health = 1e6; p._iframeUntil = Infinity;
    };

    // Cumulative sprite emission, counted through the *real* `emit` — the same
    // call every effect in the game takes. `layers.*.live` looks like the field
    // to read and is a dead one: it is initialised to 0 at
    // `src/fx/ParticleSystem.js:141` and never written again, because the
    // system is a GPU-time ring buffer with no CPU-side liveness. Emission is
    // the honest proxy and is stated as such in the record.
    const parts = ctx.vfx?.particles;
    J.emitReal = !!parts;
    if (parts) {
      const inner = parts.emit.bind(parts);
      parts.emit = (o) => {
        const n = (o?.count | 0) || 1;
        J.emitted += n; J._emitWindow += n;
        return inner(o);
      };
    }

    // How many corpses actually dissolved. This exists because the cost arm
    // found a moved program count and "something forked a shader" needs an
    // answer rather than an inference: `deathDissolve` builds a *dissolve
    // material variant* through `makeDissolvable`, and before this slice
    // `resolveObject` could not see an enemy rig at all (commit d980a17), so
    // the call was made and did nothing. If the pre-slice tree dissolves zero
    // corpses and this one dissolves hundreds, the program is a shipped shader
    // reaching the GPU for the first time, not a new one.
    const vfx = ctx.vfx;
    J.dissolveCalls = 0; J.dissolveStarted = 0;
    if (vfx?.deathDissolve) {
      const innerD = vfx.deathDissolve.bind(vfx);
      vfx.deathDissolve = (obj, colour) => {
        J.dissolveCalls++;
        const before = vfx._dissolving?.length ?? 0;
        const r = innerD(obj, colour);
        if ((vfx._dissolving?.length ?? 0) > before) J.dissolveStarted++;
        return r;
      };
    }

    // Every kill the game emits, recorded off the real event. `overkill`,
    // `type` and `status` are the three fields this slice added to the payload.
    ctx.events.on('kill', (p) => {
      if (!J.listening) return;
      const v = p?.victim;
      if (!v || v.isPlayer) return;
      const pool = Math.max(1, v.maxHealth ?? 0);
      const frac = (p.overkill ?? 0) / pool;
      J.kills.push({
        id: v.def?.id ?? null,
        maxHealth: +pool.toFixed(2),
        overkill: +(p.overkill ?? 0).toFixed(2),
        frac: +frac.toFixed(4),
        type: p.type ?? null,
        status: p.status ?? null,
        element: J.elementOf(p.type, p.status),
        isElite: !!p.isElite,
      });
    });

    // Top the field up in front of the lens. `spawnOne` is the director's own
    // spawn path, so the monsters are the ones the game makes — level, health
    // multiplier, affix eligibility and all.
    J.topUp = (want) => {
      const p = ctx.player?.position;
      const d = ctx.director;
      if (!p || !d) return 0;
      const alive = d.enemies.filter((e) => e.alive).length;
      let made = 0;
      const fwd = new G.THREE.Vector3();
      G.ctx.camera.getWorldDirection(fwd);
      fwd.y = 0; fwd.normalize();
      for (let i = alive; i < want; i++) {
        const def = J.CARDS[(J.kills.length + i) % J.CARDS.length];
        // A shallow fan down camera forward at 7-13 m: close enough that the
        // survivor's own attack reaches it, spread enough that they do not
        // stack into one column.
        const a = ((i % 7) / 7 - 0.5) * 1.5;
        const r = 7 + (i % 4) * 2;
        const x = p.x + (fwd.x * Math.cos(a) - fwd.z * Math.sin(a)) * r;
        const z = p.z + (fwd.z * Math.cos(a) + fwd.x * Math.sin(a)) * r;
        const y = ctx.stage?.sampleHeight?.(x, z) ?? p.y;
        d.spawnOne(ctx, def, new G.THREE.Vector3(x, y, z), null);
        made++;
      }
      return made;
    };

    J.cost = () => {
      const info = ctx.pipeline?.renderer?.info;
      return {
        programs: info?.programs?.length ?? null,
        geometries: info?.memory?.geometries ?? null,
        textures: info?.memory?.textures ?? null,
      };
    };
  });

  // --------------------------------------------------------------- the arms
  //
  // One page, three arms, in this order: `early` runs before any item is given
  // because `Harness.begin()` deliberately does not clear the inventory, so a
  // fresh-run fixture is only available once.
  const arm = async (name, { items, level, kills, frameBudget, time }) => {
    console.log(`\n--- arm ${name}`);
    const out = await page.evaluate(async ([name, items, level, kills, frameBudget, time]) => {
      const G = globalThis.__GAME__, HN = globalThis.__HARNESS__, ctx = G.ctx, J = globalThis.__JUICE__;
      await HN.gameplay({ settleFrames: 60 });
      ctx.time = time;
      ctx.director?.updateDifficulty?.(ctx);
      J.pin();
      if (items) {
        const n = Math.min(items, J.ITEMS.length);
        for (let i = 0; i < n; i++) ctx.items?.give?.(J.ITEMS[i].id, 1 + ((i * 7) % 12));
      }
      if (level) {
        const p = ctx.progression;
        for (let i = 0; i < 128 && p && p.level < level; i++) p.addExperience(p.xpToNext - p.xp);
      }
      // The director keeps spawning on its own budget while this runs; the
      // top-up is on top of that, so the population is the game's plus a floor.
      if (ctx.input) ctx.input.mouse.left = true;
      J.kills.length = 0; J.listening = true;
      J.emitted = 0; J.emitPeak = 0;
      J.dissolveCalls = 0; J.dissolveStarted = 0;
      const costStart = J.cost();
      let frames = 0, peakAlive = 0, cycles = 0;
      while (J.kills.length < kills && frames < frameBudget) {
        J.pin();
        J.topUp(14);
        J._emitWindow = 0;
        HN.thaw(); await HN.frames(30); HN.freeze();
        frames += 30; cycles++;
        // Peak of the fight = the busiest 30-frame window, which is what the
        // cost question is actually about.
        if (J._emitWindow > J.emitPeak) {
          J.emitPeak = J._emitWindow;
          J.costAtPeak = J.cost();
        }
        const alive = ctx.director.enemies.filter((e) => e.alive).length;
        if (alive > peakAlive) peakAlive = alive;
      }
      J.listening = false;
      if (ctx.input) ctx.input.mouse.left = false;
      return {
        name, frames, cycles, peakAlive,
        level: ctx.progression?.level ?? null,
        gameTime: Math.round(ctx.time),
        directorLevel: ctx.director?.level ?? null,
        difficultyCoefficient: +(ctx.director?.difficultyCoefficient ?? 0).toFixed(4),
        healthMult: +(ctx.director?.healthMult ?? 0).toFixed(4),
        itemsHeld: ctx.items?.inventory?.().length ?? 0,
        kills: J.kills.slice(),
        emitted: J.emitted,
        dissolveCalls: J.dissolveCalls, dissolveStarted: J.dissolveStarted,
        emitPeakPer30Frames: J.emitPeak,
        emitReal: J.emitReal,
        cost: { start: costStart, atPeak: J.costAtPeak ?? null, end: J.cost() },
        minOverkillFrac: J.LAUNCH.minOverkillFrac,
        launch: { maxSpeed: J.LAUNCH.maxSpeed, gravity: J.LAUNCH.gravity, dur: J.LAUNCH.dur },
      };
    }, [name, items, level, kills, frameBudget, time]);
    console.log(`  ${out.kills.length} kills in ${out.frames} frames (t=${out.gameTime}s, level ${out.level}, ${out.itemsHeld} items, director lvl ${out.directorLevel} healthMult ${out.healthMult}, peak ${out.peakAlive} alive)`);
    return out;
  };

  /**
   * The launch a kill fraction buys, in metres, from the game's own kinematics.
   *
   * `VFX.corpseLaunch` sets `speed = maxSpeed * k`, `vy = speed * 0.62`, and
   * `_updateLaunches` retires the record when `y < 0` — so the flight time is
   * `2 * vy / gravity` and the horizontal reach is `speed * t`, capped by
   * `LAUNCH.dur`. Re-derived here rather than measured off a rig because the
   * probe is recording what the *tuning* buys, not what one corpse did.
   */
  const reach = (frac, L, minFrac) => {
    if (frac < minFrac) return 0;
    const k = Math.min(1, Math.max(0, (frac - minFrac) / (1 - minFrac)));
    const speed = L.maxSpeed * k;
    const vy = speed * 0.62;
    const t = Math.min(L.dur, (2 * vy) / L.gravity);
    return +(speed * t).toFixed(2);
  };

  const quantile = (sorted, q) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)).toFixed(4);
  };

  const summarise = (a) => {
    const fr = a.kills.map((k) => k.frac).sort((x, y) => x - y);
    const minFrac = a.minOverkillFrac;
    const launched = a.kills.filter((k) => k.frac >= minFrac);
    const hist = {};
    for (const k of a.kills) hist[k.element] = (hist[k.element] ?? 0) + 1;
    const types = {};
    for (const k of a.kills) {
      const key = `${k.type}${k.status ? `+${k.status}` : ''}`;
      types[key] = (types[key] ?? 0) + 1;
    }
    const med = quantile(fr, 0.5), p90 = quantile(fr, 0.9);
    return {
      arm: a.name, sample: a.kills.length, framesRun: a.frames,
      fixture: {
        gameTimeSeconds: a.gameTime, survivorLevel: a.level, itemsHeld: a.itemsHeld,
        directorLevel: a.directorLevel, difficultyCoefficient: a.difficultyCoefficient,
        healthMult: a.healthMult, peakAlive: a.peakAlive,
      },
      overkill: {
        minOverkillFrac: minFrac,
        launchedCount: launched.length,
        launchedFraction: a.kills.length ? +(launched.length / a.kills.length).toFixed(4) : null,
        medianFrac: med, p90Frac: p90,
        medianLaunchMetres: med == null ? null : reach(med, a.launch, minFrac),
        p90LaunchMetres: p90 == null ? null : reach(p90, a.launch, minFrac),
        maxFrac: fr.length ? fr[fr.length - 1] : null,
        maxLaunchMetres: fr.length ? reach(fr[fr.length - 1], a.launch, minFrac) : null,
      },
      elements: hist,
      elementsAbsent: (a.elementsAll ?? []).filter((e) => !hist[e]),
      typeStatus: types,
      cost: {
        ...a.cost,
        note: 'this arm\'s own counters, for the record only. `programs` counts what this page has compiled so far, so it is NOT comparable across trees from here — the cross-tree reading is `costComparison`, taken by two `--mode cost` runs that are each the first arm of a fresh page.',
      },
      particles: {
        note: 'emission, not liveness: ParticleSystem has no live counter (`layers.*.live` is initialised at src/fx/ParticleSystem.js:141 and never written).',
        wrappedRealEmit: a.emitReal,
        totalSpritesEmitted: a.emitted,
        peakSpritesPer30Frames: a.emitPeakPer30Frames,
      },
      corpseDissolve: {
        note: 'why the program count is allowed to move by one: `deathDissolve` compiles a dissolve material variant, and before this slice `resolveObject` could not see an enemy rig, so the call did nothing. Calls vs starts separates "asked" from "happened".',
        calls: a.dissolveCalls, started: a.dissolveStarted,
      },
    };
  };

  const ELEMENTS = await page.evaluate(() => globalThis.__JUICE__.ELEMENTS);

  const arms = [];
  if (MODE === 'cost') {
    // The cost arm is the **only** arm of its own run, and that is the whole of
    // what makes two trees' readings comparable. `renderer.info.programs`
    // counts shaders compiled so far in this page's life, so it is a function
    // of what has been drawn *before* the reading as much as of what the tree
    // contains: a draft that ran the cost arm after a `mid` arm read 72
    // programs against the pre-slice tree's 71, and the entire difference was
    // the monster meshes the earlier arm had already walked past. Same fixture,
    // same frame budget, first arm on a fresh page, both trees.
    //
    // It is also why the cost question does not ride along inside the full run:
    // `Harness.begin()` deliberately does not clear the inventory or the level,
    // so a cost arm placed first would hand the `mid` fixture every item in the
    // game and it would stop being a mid fixture. Measured — `mid` came back at
    // level 57 with 97 items.
    arms.push(await arm('cost', { items: 1e9, level: 20, time: 22 * 60, kills: 1e9, frameBudget: 3000 }));
  } else {
    arms.push(await arm('mid', { items: 12, level: 8, time: 5 * 60, kills: KILLS, frameBudget: 18000 }));
    arms.push(await arm('late', { items: 1e9, level: 20, time: 22 * 60, kills: KILLS, frameBudget: 18000 }));
  }

  const summaries = arms.map((a) => summarise({ ...a, elementsAll: ELEMENTS }));
  for (const s of summaries) {
    console.log(`\n[${s.arm}] n=${s.sample}  launched ${s.overkill.launchedCount} (${s.overkill.launchedFraction})  medianFrac ${s.overkill.medianFrac} -> ${s.overkill.medianLaunchMetres} m  p90 ${s.overkill.p90Frac} -> ${s.overkill.p90LaunchMetres} m`);
    console.log(`         elements ${JSON.stringify(s.elements)}  absent ${JSON.stringify(s.elementsAbsent)}`);
    console.log(`         cost start ${JSON.stringify(s.cost.start)}  peak ${JSON.stringify(s.cost.atPeak)}`);
  }

  // (c) is answered by two `--mode cost` records rather than by anything this
  // run measured. Both are named on the command line and both are committed, so
  // the delta below is recomputable from files rather than asserted.
  const costOf = async (p) => {
    if (!p) return null;
    const j = JSON.parse(await readFile(path.resolve(p), 'utf8'));
    const a = j.arms?.[0] ?? null;
    return {
      file: path.relative(process.cwd(), path.resolve(p)).replace(/\\/g, '/'),
      commit: j.commit, renderer: j.renderer, mode: j.mode,
      arm: a?.arm ?? null, framesRun: a?.framesRun ?? null, sample: a?.sample ?? null,
      cost: a?.cost ?? null, particles: a?.particles ?? null,
    };
  };
  const costBefore = await costOf(args.costBefore);
  const costAfter = await costOf(args.costAfter);
  // Computed here rather than left to a reader, because "flat" is the claim
  // this slice makes and a reader diffing two nested objects by eye is how a
  // moved program count gets called flat.
  const costDelta = (() => {
    const b = costBefore?.cost, n = costAfter?.cost;
    if (!b || !n) return null;
    const d = {};
    for (const when of ['start', 'atPeak', 'end']) {
      if (!b[when] || !n[when]) continue;
      for (const k of Object.keys(n[when])) d[`${when}.${k}`] = n[when][k] - b[when][k];
    }
    return d;
  })();
  if (costDelta) console.log(`\ncost ${costBefore.commit?.slice(0, 7)} -> ${costAfter.commit?.slice(0, 7)}: ${JSON.stringify(costDelta)}`);

  record = {
    tool: 'tools/juiceprobe.mjs',
    mode: MODE, commit, seed: SEED, killTarget: KILLS,
    renderer: SOFTWARE ? 'swiftshader' : 'd3d11',
    sharedStreamClaim: {
      note: 'Not measured here. The no-new-draw claim is the sp-equivalence fingerprint, which is exact where a probe would be indicative.',
      command: 'node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json',
      file: 'reviews/round8/baseline-HEAD.json',
    },
    arms: summaries,
    costComparison: costDelta && { before: costBefore, after: costAfter, delta: costDelta },
    raw: arms.map((a) => ({ arm: a.name, kills: a.kills })),
    pageErrors, consoleErrors,
  };
} catch (e) {
  console.error(e);
  record = { tool: 'tools/juiceprobe.mjs', mode: MODE, commit, seed: SEED, error: String(e && e.stack), pageErrors, consoleErrors };
} finally {
  await writeFile(OUT, JSON.stringify(record, null, 2));
  console.log(`\nrecord -> ${path.relative(process.cwd(), OUT)}`);
  await browser.close();
  await server.close();
}

process.exit(record?.error ? 1 : 0);
