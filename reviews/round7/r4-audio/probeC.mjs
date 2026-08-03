/**
 * Round-4 audio critique, probe C: the live game in real Chromium with a real
 * user gesture and a real AudioContext. Product code is untouched; everything
 * here wraps instances from outside.
 *
 *   node reviews/round7/r4-audio/probeC.mjs --port 5312
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) { const t = process.argv[i]; if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1]; }
const PORT = Number(args.port ?? 5312);
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

const out = { errors: [] };
await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=2&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 90000 });

// A real gesture, so the graph is built the way a player builds it.
await page.mouse.click(640, 360);
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.audio?.ready === true, null, { timeout: 20000 });

// ------------------------------------------------------------------ install
await page.evaluate(() => {
  const a = globalThis.__GAME__.ctx.audio;
  const R = { takeCalls: 0, takeRefusals: 0, refusalsByCost: {}, calls: [], peakVoices: 0 };
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
    a[name] = (...ar) => { R.calls.push({ name, arg: typeof ar[0] === 'object' ? '<pos>' : ar[0], t: +performance.now().toFixed(1) }); return f(...ar); };
  }
});

const ev = (name, payload) => page.evaluate(([n, p]) => globalThis.__GAME__.ctx.events.emit(n, p), [name, payload]);
const q = (fn, arg) => page.evaluate(fn, arg);

/* ============================================ 1. VOICE CAP / ungated sounds */
out.voiceCap = await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  const R = globalThis.__R__;
  const res = {};
  // (a) ungated catalogue: how many nodes do sounds with NO _take gate spend?
  a.voices = 0;
  const pos = { x: 0, y: 1, z: 0 };
  const before = a.voices;
  a.teleporterStart(pos); const v1 = a.voices;
  a.levelUp();            const v2 = a.voices;
  a.stageSting();         const v3 = a.voices;
  a.pickup(2);            const v4 = a.voices;
  a.chest(pos);           const v5 = a.voices;
  a.shrineWin(pos);       const v6 = a.voices;
  a.playerDead && 0;
  res.ungated = { start: before, afterTeleporterStart: v1, afterLevelUp: v2, afterStageSting: v3,
                  afterPickup2: v4, afterChest: v5, afterShrineWin: v6 };
  res.MAX_VOICES_probe = { worldTakeAt_v: a.voices, shootAllowed: a._take(5), hurtAllowed: a._take(3, true) };
  // (b) playerHurt duck at a saturated graph
  a.voices = 40;
  const g = a.music.gain;
  const gBefore = g.value;
  a.playerHurt(40);
  res.hurtAtVoices40 = { musicGainBefore: +gBefore.toFixed(5), scheduled: true };
  return res;
});
await page.waitForTimeout(80);
out.voiceCap.hurtAtVoices40.musicGainAfter80ms = await q(() => +globalThis.__GAME__.ctx.audio.music.gain.value.toFixed(5));
await page.waitForTimeout(900);
out.voiceCap.hurtAtVoices40.musicGainAfter1s = await q(() => +globalThis.__GAME__.ctx.audio.music.gain.value.toFixed(5));
out.voiceCap.hurtAtVoices40.voicesSpentByHurt = await q(() => globalThis.__GAME__.ctx.audio.voices);
await q(() => { globalThis.__GAME__.ctx.audio.voices = 0; globalThis.__R__.calls.length = 0; });

/* =================================================== 2. ITEM / PICKUP PATH */
out.pickup = await q(() => {
  const ctx = globalThis.__GAME__.ctx;
  const R = globalThis.__R__;
  const res = { cases: [] };
  const items = ctx.items;
  const rec = (label, fn) => { const n = R.calls.length; fn(); res.cases.push({ label, calls: R.calls.slice(n).map((c) => `${c.name}(${c.arg})`) }); };
  // find a blight card with a `corrupts` target
  let blight = null;
  for (const [id, def] of (globalThis.__ITEMDBG__ ?? new Map())) {}
  return res;
});

// Pull the item catalogue from the module graph for the blight case.
out.pickupDetail = await page.evaluate(async () => {
  const mod = await import('/src/data/items.js');
  const ctx = globalThis.__GAME__.ctx;
  const R = globalThis.__R__;
  const all = mod.ITEMS ?? mod.default ?? [];
  const list = Array.isArray(all) ? all : Object.values(all).flat();
  const byTier = {};
  for (const d of list) if (d && d.id) (byTier[d.tier] ??= []).push(d.id);
  const blight = list.find((d) => d && d.tier === 'blight' && d.corrupts);
  const res = { tiersSeen: Object.keys(byTier), blight: blight ? { id: blight.id, corrupts: blight.corrupts } : null, cases: [] };
  const rec = (label, fn) => { const n = R.calls.length; try { fn(); } catch (e) { res.cases.push({ label, error: String(e) }); return; }
    res.cases.push({ label, calls: R.calls.slice(n).map((c) => `${c.name}(${c.arg})`) }); };
  ctx.authority = true;
  // one plain pickup per tier
  for (const t of ['common', 'uncommon', 'legendary', 'boss', 'lunar']) {
    const id = (byTier[t] ?? [])[0];
    if (!id) continue;
    rec(`give ${t} (${id})`, () => ctx.items.give(id, 1));
  }
  // a removal
  const c0 = (byTier.common ?? [])[0];
  if (c0) rec(`take ${c0}`, () => ctx.items.take(c0, 1));
  // the blight transform over a held base
  if (blight) {
    rec(`seed base ${blight.corrupts} x3`, () => ctx.items.give(blight.corrupts, 3));
    rec(`give blight ${blight.id} (corrupts held base)`, () => ctx.items.give(blight.id, 1));
  }
  // two DIFFERENT items inside the 40 ms throttle window
  const [x, y] = (byTier.common ?? []).slice(1, 3);
  if (x && y) rec(`give ${x} then ${y} back to back`, () => { ctx.items.give(x, 1); ctx.items.give(y, 1); });
  return res;
});

/* ============================================ 3. LIMITER during real combat */
await q(() => { globalThis.__GAME__.ctx.audio.voices = 0; });
await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
out.combat = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const a = ctx.audio;
  const R = globalThis.__R__;
  ctx.director.enabled = true;
  // cap player damage so the run cannot end mid-measurement
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
      sustain: +a.musicEngine._sustain.toFixed(4),
      diff: +ctx.director.difficultyCoefficient.toFixed(3),
      cap: ctx.director.populationCap,
      alive: (ctx.director.enemies ?? []).filter((e) => e.alive).length,
      voices: a.voices,
      musicVoices: a.musicEngine.voices,
      red: +a.limiter.reduction.toFixed(3),
      sfxRed: +a.sfxLimiter.reduction.toFixed(3),
      steps: a.musicEngine.stepsEmitted,
      bar: a.musicEngine._bar,
      levels: a.musicEngine.levels(),
    });
  }
  const maxI = Math.max(...rows.map((r) => r.I));
  const lay = {};
  for (const k of Object.keys(rows[0].levels)) lay[k] = +Math.max(...rows.map((r) => r.levels[k])).toFixed(3);
  return {
    samples: rows.length, engineStoppedSamples: engineStopped, playerDeadSamples: playerDead,
    takeCalls: R.takeCalls, takeRefusals: R.takeRefusals, refusalsByCost: R.refusalsByCost,
    intensity: { max: +maxI.toFixed(4), mean: +(rows.reduce((s, r) => s + r.I, 0) / rows.length).toFixed(4) },
    arcMax: Math.max(...rows.map((r) => r.arc)),
    pressureMax: Math.max(...rows.map((r) => r.pressure)),
    voicesPeak: Math.max(...rows.map((r) => r.voices)),
    musicVoicesPeak: Math.max(...rows.map((r) => r.musicVoices)),
    reduction: { worst: Math.min(...rows.map((r) => r.red)), mean: +(rows.reduce((s, r) => s + r.red, 0) / rows.length).toFixed(3) },
    sfxReduction: { worst: Math.min(...rows.map((r) => r.sfxRed)), mean: +(rows.reduce((s, r) => s + r.sfxRed, 0) / rows.length).toFixed(3) },
    layerMax: lay,
    barsCompleted: rows[rows.length - 1].bar - rows[0].bar,
    stepsEmitted: rows[rows.length - 1].steps - rows[0].steps,
    rows,
  };
});

/* ==================== 4. FORCED LATE-RUN ARC (the untested arm: stage > 1) */
out.lateArc = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const a = ctx.audio;
  const d = ctx.director;
  const res = {};
  const sample = () => ({ I: +a.musicEngine.intensity.toFixed(4), arc: +a.musicEngine.arc.toFixed(4),
    pressure: +a.musicEngine.pressure.toFixed(4), levels: a.musicEngine.levels(), bpm: +a.musicEngine.bpm.toFixed(1) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // pin the coefficient the way a real late run does, then EMPTY the arena
  const origUpd = d.updateDifficulty?.bind(d);
  d.updateDifficulty = () => {};
  for (const dc of [2.0, 2.875, 3.2, 3.5, 4.5, 6.0]) {
    d.difficultyCoefficient = dc;
    for (const e of d.enemies ?? []) e.alive = false;   // empty arena
    a.musicEngine.cool();
    await wait(3000);
    res['diff' + dc + '_emptyArena'] = sample();
  }
  d.difficultyCoefficient = 3.5;
  a.musicEngine.cool();
  await wait(2000);
  res.diff3p5_afterCool = sample();
  if (origUpd) d.updateDifficulty = origUpd;
  return res;
});

/* ================= 5. stageStart index>0, playerDead latch, second run */
out.latches = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const a = ctx.audio;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => ({ stopped: a.musicEngine.stopped, silent: a.musicEngine.silent,
    steps: a.musicEngine.stepsEmitted, runT: +a.musicEngine._runT.toFixed(2),
    musicGain: +a.music.gain.value.toFixed(5), musicOff: !!a._musicOff,
    droneGain: +(a.droneGain?.gain.value ?? -1).toFixed(4), I: +a.musicEngine.intensity.toFixed(4) });
  const res = {};
  res.before = snap();
  // stageStart with index > 0 must NOT reset _runT
  ctx.events.emit('stageStart', { index: 2 });
  await wait(600);
  res.afterStageStartIndex2 = snap();
  // the one-way latch: a playerDead on the bus (on a client this is a TEAMMATE's)
  ctx.events.emit('playerDead', {});
  await wait(1500);
  res.afterPlayerDead = snap();
  // a new run: stage 1 begins again in the same page session
  ctx.events.emit('stageStart', { index: 0 });
  await wait(2500);
  res.afterNewRunStageStart0 = snap();
  await wait(3000);
  res.after3sMore = snap();
  // does anything at all bring it back?
  a.setMusicVolume(1); a.setMuted(false);
  await wait(1500);
  res.afterSetMusicVolume1 = snap();
  return res;
});

/* =========================== 6. does runSummary leave the capture gate dead? */
out.runSummaryThenGate = await page.evaluate(async () => {
  const a = globalThis.__GAME__.ctx.audio;
  return { note: 'measured in a separate fresh page below', stoppedNow: a.musicEngine.stopped };
});

out.errors = errors.slice(0, 20);
await writeFile('reviews/round7/r4-audio/probeC.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, combat: { ...out.combat, rows: `<${out.combat?.rows?.length} rows in json>` } }, null, 2));
await browser.close();
await server.close();
