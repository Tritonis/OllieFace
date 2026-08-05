/**
 * Round-4 audio critique (round 7), probe 4: the live game, real Chromium on
 * the GPU path with `tools/capture.mjs`'s launch flags, a real gesture and a
 * real `AudioContext`. Product code is driven, never modified; every hook here
 * is a wrapper installed from the probe.
 *
 * Re-measures round 4's live claims on the tree WITH the concurrent-`Engine.start`
 * fix in it, and adds the two arms round 4 named as untested: a WORLD_VOICES
 * sweep, and the client-side death path.
 *
 *   node reviews/round7/r5-audio/p4-live.mjs [--port 5551]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5551);
const out = {};
const log = (...a) => console.log('[p4]', ...a);

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 180000, headless: false,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--force_high_performance_gpu', '--window-position=-2400,-2400'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

// A non-finite AudioParam write is silent corruption; catch it before any
// product code runs.
await page.addInitScript(() => {
  globalThis.__NF__ = [];
  const P = globalThis.AudioParam?.prototype;
  if (!P) return;
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime']) {
    const o = P[m];
    P[m] = function (...a) {
      for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) globalThis.__NF__.push(`${m}(${a.join(',')})`);
      return o.apply(this, a);
    };
  }
});

await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 120000 });
log('booted');
// A real gesture, then a real run.
await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.up();
await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 18 }));
await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.audio?.ready === true, null, { timeout: 30000 });
log('audio ready');

const q = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.evaluate((m) => new Promise((r) => setTimeout(r, m)), ms);

/* ---- instrument `_take` (wrapper, calls through) -------------------------- */
await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  globalThis.__R__ = { calls: [], on: false };
  const orig = a._take.bind(a);
  a._take = (cost = 1, priority = false) => {
    const w = a.worldVoices, p = a.priorityVoices;
    const ok = orig(cost, priority);
    if (globalThis.__R__.on) globalThis.__R__.calls.push([cost, priority ? 1 : 0, w, p, ok ? 1 : 0]);
    return ok;
  };
});

/* ================= 1. the six ungated calls, re-measured ================== */
out.voiceCap = await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
  const pos = { x: 0, y: 0, z: 0 };
  const rows = [];
  const snap = (label) => rows.push({ call: label, voices: a.voices, worldVoices: a.worldVoices, priorityVoices: a.priorityVoices });
  a.teleporterStart(pos); snap('teleporterStart');
  a.levelUp();            snap('levelUp');
  a.stageSting();         snap('stageSting');
  a.pickup(2);            snap('pickup(2)');
  a.chest(pos);           snap('chest');
  a.shrineWin(pos);       snap('shrineWin');
  return { rows, shootAllowed: a._take(5), hurtAllowed: a._take(3, true) };
});
log('voiceCap', JSON.stringify(out.voiceCap.rows.at(-1)), out.voiceCap.shootAllowed, out.voiceCap.hurtAllowed);

/* ================= 2. playerHurt at a saturated world budget ============== */
out.hurtAtSaturation = await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
  const pos = { x: 0, y: 0, z: 0 };
  // Fill the WORLD budget with real world sounds until a shot is refused.
  let guard = 0;
  while (a._take(5) && guard++ < 60) a.explosion(pos, 4);
  const worldTakeRefused = !a._take(5);
  const before = { voices: a.voices, worldVoices: a.worldVoices, priorityVoices: a.priorityVoices };
  const musicBefore = +a.music.gain.value.toFixed(5);
  const v0 = a.voices, p0 = a.priorityVoices;
  a.playerHurt(40);
  return {
    ...before, worldTakeRefused, musicBefore,
    voicesSpentByHurt: a.voices - v0,
    prioritySpentByHurt: a.priorityVoices - p0,
    liveNodesAtHurt: v0,
  };
});
out.hurtAtSaturation.musicAfter60ms = await (async () => { await sleep(60); return q(() => +globalThis.__GAME__.ctx.audio.music.gain.value.toFixed(5)); })();
await sleep(900);
out.hurtAtSaturation.musicAfter1s = await q(() => +globalThis.__GAME__.ctx.audio.music.gain.value.toFixed(5));
log('hurt', JSON.stringify(out.hurtAtSaturation));

/* ================= 3. WORLD_VOICES sweep (round 4's untested arm 6) ======= */
// `_take` is replaced by a faithful reimplementation parameterised on the
// budget, so the graph really does behave differently at each value rather
// than the refusals being recomputed after the fact.
out.sweep = [];
for (const B of [30, 44, 60, 88]) {
  await q((budget) => {
    const a = globalThis.__GAME__.ctx.audio;
    a.voices = 0; a.worldVoices = 0; a.priorityVoices = 0;
    a._takes = 0; a._refusals = 0;
    globalThis.__R__ = { calls: [], on: false };
    a._take = (cost = 1, priority = false) => {
      const ok = priority ? a.priorityVoices + cost <= 28 : a.worldVoices + cost <= budget;
      a._takes++;
      if (!ok) { a._refusals++; return false; }
      a._priorityCharge = priority;
      return true;
    };
    globalThis.__S__ = { worldPeak: 0, priorityPeak: 0, master: 0, sfx: 0, samples: 0, enemies: [], stopped: 0, dead: 0 };
  }, B);
  await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 24 }));
  await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
  // sample at 20 Hz for 25 s
  await q(() => {
    const c = globalThis.__GAME__.ctx, a = c.audio, S = globalThis.__S__;
    S.t0 = performance.now();
    S.iv = setInterval(() => {
      S.samples++;
      S.worldPeak = Math.max(S.worldPeak, a.worldVoices);
      S.priorityPeak = Math.max(S.priorityPeak, a.priorityVoices);
      S.master = Math.min(S.master, a.limiter?.reduction ?? 0);
      S.sfx = Math.min(S.sfx, a.sfxLimiter?.reduction ?? 0);
      S.masterSum = (S.masterSum ?? 0) + (a.limiter?.reduction ?? 0);
      S.sfxSum = (S.sfxSum ?? 0) + (a.sfxLimiter?.reduction ?? 0);
      S.enemies.push((c.director?.enemies ?? []).filter((e) => e.alive).length);
      if (a.musicEngine?.stopped) S.stopped++;
      if (c.player?.alive === false) S.dead++;
    }, 50);
  });
  await sleep(25000);
  const row = await q((budget) => {
    const a = globalThis.__GAME__.ctx.audio, S = globalThis.__S__;
    clearInterval(S.iv);
    const secs = (performance.now() - S.t0) / 1000;
    const mean = (x) => x.reduce((p, c) => p + c, 0) / Math.max(1, x.length);
    return {
      budget, seconds: +secs.toFixed(1),
      takes: a._takes, refusals: a._refusals,
      refusalPct: +(100 * a._refusals / Math.max(1, a._takes)).toFixed(1),
      refusalsPerSec: +(a._refusals / secs).toFixed(1),
      enemiesMean: +mean(S.enemies).toFixed(1), enemiesMax: Math.max(...S.enemies),
      worldPeak: S.worldPeak, priorityPeak: S.priorityPeak,
      masterWorst: +S.master.toFixed(3), masterMean: +(S.masterSum / S.samples).toFixed(3),
      sfxWorst: +S.sfx.toFixed(3), sfxMean: +(S.sfxSum / S.samples).toFixed(3),
      engineStoppedSamples: S.stopped, playerDeadSamples: S.dead, samples: S.samples,
    };
  }, B);
  out.sweep.push(row);
  log('sweep', JSON.stringify(row));
}

/* restore the shipped `_take` */
await q(() => {
  const a = globalThis.__GAME__.ctx.audio;
  const P = Object.getPrototypeOf(a);
  delete a._take;
  void P;
});

/* ================= 4. latches, incl. the client path ====================== */
out.latches = await (async () => {
  const rows = [];
  const snap = async (label) => rows.push(await q((l) => {
    const c = globalThis.__GAME__.ctx, a = c.audio;
    return { step: l, stopped: a.musicEngine.stopped, steps: a.musicEngine.stepsEmitted,
      runT: +a.musicEngine._runT.toFixed(2), musicGain: +a.music.gain.value.toFixed(5),
      musicOff: !!a._musicOff, drone: +(a.droneGain?.gain.value ?? 0).toFixed(4),
      playerAlive: c.player?.alive ?? null, authority: c.authority };
  }, label));
  await snap('baseline');
  await q(() => globalThis.__GAME__.ctx.events.emit('stageStart', { index: 2 }));
  await sleep(400); await snap('stageStart{2}');
  // a TEAMMATE's death, off the wire: the local survivor is alive
  await q(() => globalThis.__GAME__.ctx.events.emit('playerDead', {}));
  await sleep(400); await snap('playerDead (local alive)');
  // the LOCAL survivor's death, single-player: alive is false before the emit
  await q(() => { const c = globalThis.__GAME__.ctx; c.player.alive = false; c.events.emit('playerDead', {}); });
  await sleep(400); await snap('playerDead (local dead)');
  await q(() => { const c = globalThis.__GAME__.ctx; c.player.alive = true; c.events.emit('stageStart', { index: 0 }); });
  await sleep(400); await snap('stageStart{0} = new run');
  await sleep(3000); await snap('+3 s');
  return rows;
})();
log('latches ok');

/* ================= 5. the CLIENT death path ============================== */
// On a client `ctx.authority` is false, `Combat.applyDamage` returns 0 before
// it can set `alive`, and nothing applies the snapshot's `healthFrac` to the
// local player. So this reproduces what a client's own death looks like to
// `Audio`: the host's `playerDead` arrives over the wire while `ctx.player.alive`
// is still true.
out.clientDeath = await (async () => {
  await q(() => {
    const c = globalThis.__GAME__.ctx;
    c.player.alive = true;
    c.authority = false;
    globalThis.__GAME__.ctx.audio.beginRun();
  });
  await sleep(600);
  const before = await q(() => {
    const c = globalThis.__GAME__.ctx, a = c.audio;
    return { alive: c.player.alive, stopped: a.musicEngine.stopped, musicOff: !!a._musicOff,
      musicGain: +a.music.gain.value.toFixed(5), steps: a.musicEngine.stepsEmitted };
  });
  // the host's damage would kill it; on a client applyDamage is a no-op
  const damage = await q(() => {
    const c = globalThis.__GAME__.ctx;
    const h0 = c.player.health;
    const dealt = c.combat?.applyDamage?.(c.player, 1e6, { type: 'probe', isDot: true, ignoreArmor: true }) ?? null;
    return { dealt, healthBefore: +h0.toFixed(1), healthAfter: +c.player.health.toFixed(1), alive: c.player.alive };
  });
  // ... and then the host's playerDead lands over the wire
  await q(() => globalThis.__GAME__.ctx.events.emit('playerDead', {}));
  await sleep(1200);
  const after = await q(() => {
    const c = globalThis.__GAME__.ctx, a = c.audio;
    return { alive: c.player.alive, stopped: a.musicEngine.stopped, musicOff: !!a._musicOff,
      musicGain: +a.music.gain.value.toFixed(5), steps: a.musicEngine.stepsEmitted,
      screen: c.hud?.menus?.screen ?? null };
  });
  await q(() => { globalThis.__GAME__.ctx.authority = true; });
  return { before, damage, after, deathCueFired: after.stopped === true };
})();
log('clientDeath', JSON.stringify(out.clientDeath));

/* ================= 6. intensity, live, both ends ========================== */
out.lateArc = await (async () => {
  const rows = [];
  for (const diff of [1.0, 2.0, 3.5, 6.0]) {
    await q((d) => {
      const c = globalThis.__GAME__.ctx;
      c.audio.beginRun();
      c.director._pinned = d;
      Object.defineProperty(c.director, 'difficultyCoefficient', { get: () => d, configurable: true });
      c.audio.musicEngine._runT = 400;
    }, diff);
    // empty
    await q(() => { const c = globalThis.__GAME__.ctx; for (const e of c.director.enemies) e.alive = false; c.director.enabled = false; });
    await sleep(9000);
    const empty = await q(() => { const m = globalThis.__GAME__.ctx.audio.musicEngine; return { I: +m.intensity.toFixed(4), bpm: +m.bpm.toFixed(1), pressure: +m.pressure.toFixed(4) }; });
    // full
    await q(() => { const c = globalThis.__GAME__.ctx; c.director.enabled = true; });
    await page.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 30 }));
    await page.evaluate(() => globalThis.__HARNESS__?.thaw?.());
    await sleep(9000);
    const full = await q(() => { const c = globalThis.__GAME__.ctx, m = c.audio.musicEngine; return { I: +m.intensity.toFixed(4), bpm: +m.bpm.toFixed(1), pressure: +m.pressure.toFixed(4), enemies: c.director.enemies.filter((e) => e.alive).length }; });
    // cool() over an emptied arena, as a stage transition does
    await q(() => { const c = globalThis.__GAME__.ctx; for (const e of c.director.enemies) e.alive = false; c.director.enabled = false; c.audio.musicEngine.cool(); });
    await sleep(4000);
    const cooled = await q(() => { const m = globalThis.__GAME__.ctx.audio.musicEngine; return { I: +m.intensity.toFixed(4), bpm: +m.bpm.toFixed(1) }; });
    rows.push({ diff, empty, full, cooled, span: +(full.I - empty.I).toFixed(4), coolDrop: +(full.I - cooled.I).toFixed(4) });
    log('lateArc', JSON.stringify(rows.at(-1)));
  }
  return rows;
})();

/* ================= 7. item cues =========================================== */
out.itemCues = await q(async () => {
  const c = globalThis.__GAME__.ctx, a = c.audio;
  const cues = [];
  const op = a.pickup.bind(a), od = a.deny.bind(a);
  a.pickup = (t) => { cues.push(`pickup(${t})`); return op(t); };
  a.deny = () => { cues.push('deny()'); return od(); };
  const run = async (label, fn) => {
    cues.length = 0;
    try { fn(); } catch (e) { cues.push('THREW ' + e.message); }
    await new Promise((r) => setTimeout(r, 60));
    return { label, cues: cues.slice() };
  };
  const rows = [];
  const items = c.items;
  rows.push(await run('give common', () => items.give('syringe', 1)));
  rows.push(await run('take common', () => items.take?.('syringe', 1) ?? items.give('syringe', -1)));
  rows.push(await run('give two different commons in one frame', () => { items.give('syringe', 1); items.give('bone-charm', 1); }));
  a.pickup = op; a.deny = od;
  return rows;
});
log('itemCues', JSON.stringify(out.itemCues));

/* ================= 8. controls and hygiene =============================== */
out.controls = await q(async () => {
  const a = globalThis.__GAME__.ctx.audio;
  const r = {};
  const g = () => ({ music: +a.music.gain.value.toFixed(5), master: +a.master.gain.value.toFixed(4), sfx: +a.sfx.gain.value.toFixed(5), silent: a.musicEngine.silent });
  const w = () => new Promise((res) => setTimeout(res, 300));
  a.setMusicVolume(0.6); await w(); r.music06 = g();
  a.setMusicVolume(0);   await w(); r.music0 = g();
  a.setMusicVolume(0.6); await w(); r.musicBack = g();
  a.setMuted(true);      await w(); r.muted = g();
  a.setMuted(false);     await w(); r.unmuted = g();
  return r;
});
out.nonFinite = await q(() => globalThis.__NF__.slice(0, 20));
out.finalState = await q(() => {
  const c = globalThis.__GAME__.ctx, a = c.audio;
  return { voices: a.voices, worldVoices: a.worldVoices, priorityVoices: a.priorityVoices,
    stopped: a.musicEngine.stopped, steps: a.musicEngine.stepsEmitted, acState: a.ac.state };
});
out.consoleErrors = logs.slice(0, 20);

await writeFile('reviews/round7/r5-audio/p4-live.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
