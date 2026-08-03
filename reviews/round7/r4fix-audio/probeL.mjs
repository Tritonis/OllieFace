/**
 * Round-4 audio FIX, probe L: the live game, real Chromium on the GPU path with
 * the launch flags copied from tools/capture.mjs, a real gesture and a real
 * AudioContext. Product code untouched; everything here wraps it from outside.
 *
 * Same rig as the critic's reviews/round7/r4-audio/probeC.mjs, so the numbers
 * are comparable to that file's, plus the arms the fix has to be judged on.
 *
 *   node reviews/round7/r4fix-audio/probeL.mjs --port 5420
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) { const t = process.argv[i]; if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1]; }
const PORT = Number(args.port ?? 5420);
const W = 1280, H = 720;

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}`));

// Non-finite AudioParam writes are the class of bug that throws mid-fight, so
// the detector is installed before any product code runs.
await page.addInitScript(() => {
  globalThis.__NONFINITE__ = [];
  const P = globalThis.AudioParam?.prototype;
  if (!P) return;
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
    const o = P[m];
    P[m] = function (v, ...rest) {
      if (!Number.isFinite(v) || rest.some((x) => typeof x === 'number' && !Number.isFinite(x))) {
        globalThis.__NONFINITE__.push(`${m}(${v}, ${rest.join(', ')})`);
      }
      return o.call(this, v, ...rest);
    };
  }
});

const out = { errors: [] };
await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=2&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 90000 });
await page.mouse.click(640, 360);
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.audio?.ready === true, null, { timeout: 20000 });

await page.evaluate(() => {
  const a = globalThis.__GAME__.ctx.audio;
  const R = { takeCalls: 0, takeRefusals: 0, refusalsByCost: {}, calls: [] };
  globalThis.__R__ = R;
  const origTake = a._take.bind(a);
  a._take = (cost = 1, prio = false) => {
    R.takeCalls++;
    const ok = origTake(cost, prio);
    if (!ok) { R.takeRefusals++; R.refusalsByCost[cost] = (R.refusalsByCost[cost] ?? 0) + 1; }
    return ok;
  };
  for (const name of ['pickup', 'deny', 'playerHurt', 'playerDead', 'stageSting', 'coin', 'levelUp', 'explosion', 'shoot']) {
    const f = a[name].bind(a);
    a[name] = (...ar) => { R.calls.push({ name, arg: typeof ar[0] === 'object' ? '<pos>' : ar[0] }); return f(...ar); };
  }
});

const q = (fn, arg) => page.evaluate(fn, arg);
const wait = (ms) => page.waitForTimeout(ms);

/* ================= 1. THE UNGATED CATALOGUE (M2) — same sequence as probeC */
out.voiceCap = await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  const res = {};
  a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
  const pos = { x: 0, y: 1, z: 0 };
  const snap = () => ({ voices: a.voices, world: a.worldVoices, prio: a.priorityVoices });
  const seq = [];
  a.teleporterStart(pos); seq.push(['teleporterStart', snap()]);
  a.levelUp();            seq.push(['levelUp', snap()]);
  a.stageSting();         seq.push(['stageSting', snap()]);
  a.pickup(2);            seq.push(['pickup(2)', snap()]);
  a.chest(pos);           seq.push(['chest', snap()]);
  a.shrineWin(pos);       seq.push(['shrineWin', snap()]);
  res.sequence = seq;
  res.atEnd = { voices: a.voices, worldVoices: a.worldVoices, priorityVoices: a.priorityVoices, shootAllowed: a._take(5), hurtAllowed: a._take(3, true) };
  return res;
});

/* ================= 2. playerHurt WITH THE WORLD BUDGET FULL (M1) ========== */
out.hurtAtSaturation = await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  // World SFX saturated: every one of the 44 world nodes is live.
  a.worldVoices = 44; a.priorityVoices = 14; a.voices = 58;
  const res = {
    worldTakeRefused: !a._take(5),          // world is full: a shot must be refused
    priorityTakeAllowed: a._take(3, true),  // and the reserve must still be there
    musicGainBefore: +a.music.gain.value.toFixed(5),
  };
  const v0 = a.voices;
  a.playerHurt(40);
  res.voicesSpentByHurt = a.voices - v0;
  return res;
});
await wait(80);
out.hurtAtSaturation.musicGainAfter80ms = await q(() => +globalThis.__GAME__.ctx.audio.music.gain.value.toFixed(5));
await wait(900);
out.hurtAtSaturation.musicGainAfter1s = await q(() => +globalThis.__GAME__.ctx.audio.music.gain.value.toFixed(5));
await q(() => { const a = globalThis.__GAME__.ctx.audio; a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0; globalThis.__R__.calls.length = 0; });

/* ============================ 3. EXPLOSION GRACEFUL DEGRADATION (M5) ====== */
out.explosionFallback = await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  const res = {};
  const measure = (world, fn) => {
    a.voices = world; a.worldVoices = world; a.priorityVoices = 0;
    const v0 = a.voices;
    fn();
    return a.voices - v0;
  };
  const boom = () => a.explosion({ x: 0, y: 1, z: 0 }, 4);
  const shot = () => a.shoot({ x: 0, y: 1, z: 0 }, 1);
  res.nodesAtWorld0 = measure(0, boom);     // full voice
  res.nodesAtWorld38 = measure(38, boom);   // 9 will not fit, 3 will
  res.nodesAtWorld43 = measure(43, boom);   // nothing fits
  res.shotAtWorld0 = measure(0, shot);      // full voice
  res.shotAtWorld41 = measure(41, shot);    // 5 will not fit, 2 will
  res.shotAtWorld43 = measure(43, shot);    // nothing fits
  a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
  return res;
});

/* ================================= 4. ITEM CUES: the blight sequence (M4) == */
out.pickupCues = await page.evaluate(async () => {
  const mod = await import('/src/data/items.js');
  const ctx = globalThis.__GAME__.ctx;
  const R = globalThis.__R__;
  const all = mod.ITEMS ?? mod.default ?? [];
  const list = Array.isArray(all) ? all : Object.values(all).flat();
  const byTier = {};
  for (const d of list) if (d && d.id) (byTier[d.tier] ??= []).push(d.id);
  const blight = list.find((d) => d && d.tier === 'blight' && d.corrupts);
  const res = { blight: blight ? { id: blight.id, corrupts: blight.corrupts } : null, cases: [] };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const rec = async (label, fn) => {
    const n = R.calls.length;
    try { fn(); } catch (e) { res.cases.push({ label, error: String(e) }); return; }
    await settle();                              // the cue is flushed on a microtask
    res.cases.push({ label, calls: R.calls.slice(n).map((c) => `${c.name}(${c.arg})`) });
  };
  ctx.authority = true;
  for (const t of ['common', 'uncommon', 'legendary', 'boss', 'lunar']) {
    const id = (byTier[t] ?? [])[0];
    if (id) await rec(`give ${t} (${id})`, () => ctx.items.give(id, 1));
  }
  const c0 = (byTier.common ?? [])[0];
  if (c0) await rec(`take ${c0}`, () => ctx.items.take(c0, 1));
  if (blight) {
    await rec(`seed base ${blight.corrupts} x3`, () => ctx.items.give(blight.corrupts, 3));
    await rec(`give blight ${blight.id} over the held base`, () => ctx.items.give(blight.id, 1));
  }
  const [x, y] = (byTier.common ?? []).slice(1, 3);
  if (x && y) await rec(`give ${x} then ${y} in one frame`, () => { ctx.items.give(x, 1); ctx.items.give(y, 1); });
  return res;
});

/* ================================== 5. 60 s OF LIVE COMBAT ================= */
await q(() => { const a = globalThis.__GAME__.ctx.audio; a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0; });
await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
out.combat = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const a = ctx.audio;
  const R = globalThis.__R__;
  ctx.director.enabled = true;
  const c = ctx.combat;
  if (c?.applyDamage) {
    const orig = c.applyDamage.bind(c);
    c.applyDamage = (t, amt, info) => orig(t, t?.isPlayer ? 0.001 : amt, info);
  }
  const rows = [];
  const t0 = performance.now();
  R.takeCalls = 0; R.takeRefusals = 0; R.refusalsByCost = {};
  let engineStopped = 0, playerDead = 0;
  while (performance.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 500));
    if (a.musicEngine.stopped) engineStopped++;
    if (!ctx.player?.alive) playerDead++;
    rows.push({
      t: +((performance.now() - t0) / 1000).toFixed(1),
      I: +a.musicEngine.intensity.toFixed(4),
      arc: +a.musicEngine.arc.toFixed(4),
      pressure: +a.musicEngine.pressure.toFixed(4),
      diff: +ctx.director.difficultyCoefficient.toFixed(3),
      cap: ctx.director.populationCap,
      alive: (ctx.director.enemies ?? []).filter((e) => e.alive).length,
      voices: a.voices, world: a.worldVoices, prio: a.priorityVoices,
      musicVoices: a.musicEngine.voices,
      red: +a.limiter.reduction.toFixed(3),
      sfxRed: +a.sfxLimiter.reduction.toFixed(3),
      steps: a.musicEngine.stepsEmitted,
    });
  }
  const secs = (performance.now() - t0) / 1000;
  return {
    seconds: +secs.toFixed(1), samples: rows.length,
    engineStoppedSamples: engineStopped, playerDeadSamples: playerDead,
    takeCalls: R.takeCalls, takeRefusals: R.takeRefusals,
    refusalRate_per_s: +(R.takeRefusals / secs).toFixed(2),
    refusalPct: +(100 * R.takeRefusals / Math.max(1, R.takeCalls)).toFixed(1),
    refusalsByCost: R.refusalsByCost,
    enemiesMean: +(rows.reduce((s, r) => s + r.alive, 0) / rows.length).toFixed(1),
    enemiesMax: Math.max(...rows.map((r) => r.alive)),
    capMax: Math.max(...rows.map((r) => r.cap)),
    diffMax: Math.max(...rows.map((r) => r.diff)),
    intensity: { max: Math.max(...rows.map((r) => r.I)), min: Math.min(...rows.map((r) => r.I)),
                 mean: +(rows.reduce((s, r) => s + r.I, 0) / rows.length).toFixed(4) },
    voicesPeak: Math.max(...rows.map((r) => r.voices)),
    worldPeak: Math.max(...rows.map((r) => r.world)),
    priorityPeak: Math.max(...rows.map((r) => r.prio)),
    musicVoicesPeak: Math.max(...rows.map((r) => r.musicVoices)),
    reduction: { worst: Math.min(...rows.map((r) => r.red)), mean: +(rows.reduce((s, r) => s + r.red, 0) / rows.length).toFixed(3) },
    sfxReduction: { worst: Math.min(...rows.map((r) => r.sfxRed)), mean: +(rows.reduce((s, r) => s + r.sfxRed, 0) / rows.length).toFixed(3) },
    stepsEmitted: rows[rows.length - 1].steps - rows[0].steps,
    rows,
  };
});

/* ============ 6. DRAIN: do the counters come back to zero (leak check)? ====
 * A counter that never comes down is indistinguishable from a cap that works,
 * so this is a time series rather than one reading, and it records how many NEW
 * sounds were requested during the drain: a counter that stays high because the
 * game is still making noise is not a leak.
 */
await q(() => {
  const ctx = globalThis.__GAME__.ctx;
  ctx.director.enabled = false;
  for (const e of ctx.director.enemies ?? []) e.alive = false;
  if (ctx.player) ctx.player.firing = false;
  globalThis.__R__.takeCalls = 0;
});
out.drain = await page.evaluate(async () => {
  const a = globalThis.__GAME__.ctx.audio;
  const R = globalThis.__R__;
  const series = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    series.push({ t: (i + 1) * 2, voices: a.voices, world: a.worldVoices, prio: a.priorityVoices,
                  music: a.musicEngine.voices, newTakes: R.takeCalls });
  }
  return { series, finalTakeCalls: R.takeCalls };
});

/* ====== 7. INTENSITY AT BOTH ENDS, LIVE, at a forced late-run difficulty === */
out.lateArc = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const a = ctx.audio;
  const d = ctx.director;
  const res = {};
  const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
  const sample = () => ({ I: +a.musicEngine.intensity.toFixed(4), arc: +a.musicEngine.arc.toFixed(4),
    pressure: +a.musicEngine.pressure.toFixed(4), bpm: +a.musicEngine.bpm.toFixed(1),
    levels: a.musicEngine.levels() });
  const origUpd = d.updateDifficulty?.bind(d);
  d.updateDifficulty = () => {};
  const real = d.enemies;
  const p = ctx.player.position;
  // A "full arena" the intensity model can see: `_scanSustain` reads alive and
  // position and nothing else, so these stand in for monsters without spawning
  // anything the rest of the game would have to simulate.
  const fake = [];
  for (let i = 0; i < 60; i++) fake.push({ alive: true, position: { x: p.x + 5, y: p.y, z: p.z + 5 } });
  for (const dc of [1.0, 2.0, 3.2, 3.5, 4.5, 6.0]) {
    d.difficultyCoefficient = dc;
    d.populationCap = 60;
    d.enemies = [];                       // empty arena
    a.musicEngine.cool();
    await wait2(3000);
    const empty = sample();
    d.enemies = fake;                     // full arena
    await wait2(3000);
    const full = sample();
    res['diff' + dc] = { empty, full, span: +(full.I - empty.I).toFixed(4) };
  }
  // cool() over an emptied arena, at the top of the arc
  d.difficultyCoefficient = 4.5;
  d.enemies = fake;
  await wait2(3000);
  const hot = sample();
  d.enemies = [];
  a.musicEngine.cool();
  await wait2(4000);
  res.coolAtDiff4p5 = { from: hot.I, to: sample().I };
  d.enemies = real;
  if (origUpd) d.updateDifficulty = origUpd;
  return res;
});

/* ============== 8. LATCHES: teammate death, local death, the next run ====== */
out.latches = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const a = ctx.audio;
  const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => ({ stopped: a.musicEngine.stopped, steps: a.musicEngine.stepsEmitted,
    runT: +a.musicEngine._runT.toFixed(2), musicGain: +a.music.gain.value.toFixed(5),
    musicOff: !!a._musicOff, droneGain: +(a.droneGain?.gain.value ?? -1).toFixed(4) });
  const res = {};
  res.before = snap();
  // stageStart index > 0 must not reset the run clock
  ctx.events.emit('stageStart', { index: 2 });
  await wait2(800);
  res.afterStageStartIndex2 = snap();
  // A TEAMMATE's death arriving off the wire while the local survivor is alive.
  ctx.player.alive = true;
  ctx.events.emit('playerDead', {});
  await wait2(1500);
  res.afterTeammateDeath = snap();
  // The local survivor's death.
  ctx.player.alive = false;
  ctx.events.emit('playerDead', {});
  await wait2(1500);
  res.afterLocalDeath = snap();
  // A new run in the same page session.
  ctx.player.alive = true;
  ctx.events.emit('stageStart', { index: 0 });
  await wait2(2500);
  res.afterNewRun = snap();
  await wait2(3000);
  res.after3sMore = snap();
  return res;
});

/* =============== 9. VOLUME / MUTE / SUSPEND-RESUME regression guards ======= */
out.controls = await page.evaluate(async () => {
  const a = globalThis.__GAME__.ctx.audio;
  const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = {};
  a.setMusicVolume(0.6); await wait2(400);
  res.musicVol0p6 = { bus: +a.music.gain.value.toFixed(5), silent: a.musicEngine.silent };
  a.setMusicVolume(0); await wait2(400);
  res.musicVol0 = { bus: +a.music.gain.value.toFixed(5), silent: a.musicEngine.silent };
  a.setMusicVolume(0.6); await wait2(400);
  res.musicVolBack = { bus: +a.music.gain.value.toFixed(5), silent: a.musicEngine.silent };
  a.setMuted(true); await wait2(400);
  res.muted = { master: +a.master.gain.value.toFixed(5), silent: a.musicEngine.silent };
  a.setMuted(false); await wait2(400);
  res.unmuted = { master: +a.master.gain.value.toFixed(5), silent: a.musicEngine.silent };
  a.setSfxVolume(0.5); await wait2(300);
  res.sfxVol0p5 = +a.sfx.gain.value.toFixed(5);
  a.setSfxVolume(1); await wait2(300);
  res.sfxVol1 = +a.sfx.gain.value.toFixed(5);
  await a.ac.suspend(); res.suspended = a.ac.state;
  a._ensure(); await wait2(2000);
  res.afterEnsure = a.ac.state;
  return res;
});

out.nonFinite = await q(() => globalThis.__NONFINITE__ ?? null);
out.errors = errors.slice(0, 20);
await writeFile('reviews/round7/r4fix-audio/probeL.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, combat: { ...out.combat, rows: `<${out.combat?.rows?.length} rows>` } }, null, 2));
await browser.close();
await server.close();
