/**
 * Live reckoning probe — the "verify by playing" pass of the corruption
 * reckoning slice (audible void layer + band sting, visible band snap, scaling
 * cleanse, the void's re-priced economy, corruption -> Director pressure), run
 * headlessly because this environment has no hands.
 *
 * A sibling of `tools/blightprobe.mjs` rather than six more arms bolted onto it:
 * blightprobe's subject is the mask/shimmer/sky shader stack and every one of
 * its 37 checks reads a uniform. This one's subject is the *reckoning* — sound,
 * pressure, price and the way back out — and it needs an AudioContext tap, the
 * Director's coefficient, the real shrine bag and the gold ledger. Same
 * conventions: real Vite server, real GPU browser, real game, checks printed as
 * they land, a JSON record written whether or not the run passes.
 *
 *   1. sting     every `corruptionBand` crossing fires `Audio.bandSting`, and
 *                each fire creates real oscillator nodes (counted by wrapping
 *                `ac.createOscillator`) — the announcement is audio, not a
 *                no-op'd call.
 *   2. snap      each upward crossing opens the snap window (`_snapT > 0`) and
 *                the sky blend weight reaches 0.9 inside SNAP.window seconds,
 *                traced frame by frame.
 *   3. mix       the deferred band-4 ear check, answered with numbers: the void
 *                layer's own output peak against the limiter's, measured on a
 *                quiet stage and again inside a real firefight (24 bodies, the
 *                trigger held). Nobody can hear a ratio from a brief.
 *   4. pressure  `difficultyCoefficient` carries the corruption term, proved
 *                differentially: the same frame recomputed at world W and at
 *                world 0 must differ by exactly PRESSURE.perWorld * W * the
 *                stage factor — while `rewardCoefficient`, the one the gold
 *                economy is paid against, does not move at all.
 *   5. font      a band >= 2 stage carries an Argent Font out of the real
 *                `populate`; three uses bleed exactly what `cleanseAmount` says
 *                the live world is worth, use by use, at world 400, and each
 *                press charges exactly `cleanseCost(stage, uses, world)` — the
 *                exit is priced against the debt it is retiring.
 *   6. price     a Hollowed kill and a sibling elite kill off the same card,
 *                compared through the `goldReward` event the HUD reads; the
 *                Hollowed pays `rewardMult` of the sibling (scaled by their
 *                elite costs) and bleeds `refund` of the world.
 *   7. bank      the void's savings clamp to `voidBankCap(world)`, read from the
 *                shipped function rather than a retyped formula.
 *   8. feel      the loop-closure table at world 400 the next playtest argues
 *                against — credits/s, bank cap, Hollowed vs sibling gold, the
 *                *compounding* three-use cleanse, corruption-added coefficient.
 *
 *   node tools/reckoningprobe.mjs [--seed 1337] [--port 5213] [--out shots-reckoning]
 *
 * Exit 1 if any check fails; the JSON record is written beside the PNGs either
 * way, because a failed arm is evidence too. `--record <path>` also copies it to
 * a committed location under `reviews/`.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveOutDir } from './lib/evidence.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5213);
// shots-reckoning is caught by the `shots-` ignore rule; the helper surfaces
// that so a number pulled from the record here doesn't get treated as fact (#71).
const OUT = resolveOutDir(args.out ?? 'shots-reckoning', { tool: 'reckoningprobe' });
const RECORD = args.record ? path.resolve(args.record) : null;
const W = 1600, H = 900;

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  — ${JSON.stringify(detail)}`}`);
};

await mkdir(OUT, { recursive: true });
const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    // The mix arm needs an AudioContext that actually runs. The KeyZ press below
    // is the honest gesture (capture.mjs uses the same one); this flag is the
    // belt to that braces, for a headless host with no audio device attached.
    '--autoplay-policy=no-user-gesture-required',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

let record = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));
  await page.evaluate(() => globalThis.__HARNESS__.gameplay({ settleFrames: 60 }));
  // A real gesture, for the autoplay policy and for the same reason capture.mjs
  // presses it: KeyZ is bound to nothing in `Input`, so it unlocks audio without
  // touching the run.
  await page.keyboard.press('KeyZ');

  // ------------------------------------------------------------- instruments
  // Installed once and left in for the whole session: the survivor pin (this
  // probe spends a minute of live band-4 play, which kills a level-1 body), the
  // audio taps, and the crossing/sting counters.
  const armed = await page.evaluate(async () => {
    const G = globalThis.__GAME__, ctx = G.ctx;
    globalThis.__PIN__ = () => {
      const p = ctx.player;
      if (!p) return;
      p.maxHealth = 1e6; p.health = 1e6; p._iframeUntil = Infinity;
    };
    globalThis.__PIN__();

    const a = ctx.audio;
    const ac = a?._ensure?.() ?? a?.ac ?? null;
    // Every number below is read out of the shipped modules, never retyped here.
    const [COR, BL, AU] = await Promise.all([
      import('/src/data/corruption.js'),
      import('/src/systems/Blight.js'),
      import('/src/systems/Audio.js'),
    ]);
    globalThis.__MODS__ = { COR, BL, AU };

    // Crossings, as the game announces them.
    const log = { crossings: [], stings: [] };
    ctx.events.on('corruptionBand', (p) => log.crossings.push({ band: p.band, prev: p.prev, world: +ctx.corruption.world.toFixed(2) }));
    globalThis.__LOG__ = log;

    // "Did it make a sound" answered structurally: count the oscillator nodes
    // the context actually mints while `bandSting` is on the stack. A sting
    // refused by the voice gate, or a `_tone` that early-outs, reads zero here.
    let oscCount = 0;
    if (ac) {
      const realOsc = ac.createOscillator.bind(ac);
      ac.createOscillator = () => { oscCount++; return realOsc(); };
    }
    const realSting = a.bandSting.bind(a);
    a.bandSting = (band, prev) => {
      const before = oscCount;
      const armedAt = ac ? +ac.currentTime.toFixed(3) : null;
      const ready = ac ? +a._stingReady.toFixed(3) : null;
      const r = realSting(band, prev);
      log.stings.push({ band, prev, oscillators: oscCount - before, at: armedAt, stingReadyWas: ready });
      return r;
    };

    // Taps. The void layer's own output, and the last node before the device —
    // the same pair (and the same reason) as the audio gate in tools/capture.mjs.
    const tap = (src) => {
      if (!ac || !src) return null;
      const an = ac.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      return { an, buf: new Float32Array(an.fftSize), src };
    };
    globalThis.__TAPS__ = { voidT: tap(a?.voidGain), outT: tap(a?.limiter ?? a?.master) };
    globalThis.__PEAK__ = (t) => {
      if (!t) return null;
      t.an.getFloatTimeDomainData(t.buf);
      let p = 0;
      for (let i = 0; i < t.buf.length; i++) { const v = Math.abs(t.buf[i]); if (v > p) p = v; }
      return p;
    };
    // Peak-hold over a real-time window, sampled every 16 ms: a 2048-sample
    // analyser window is ~43 ms at 48 kHz, so nothing transient slips between
    // reads.
    globalThis.__WINDOW__ = (ms) => new Promise((res) => {
      const T = globalThis.__TAPS__, P = globalThis.__PEAK__;
      const s = { voidPeak: 0, outPeak: 0, samples: 0 };
      const id = setInterval(() => {
        s.samples++;
        s.voidPeak = Math.max(s.voidPeak, P(T.voidT) ?? 0);
        s.outPeak = Math.max(s.outPeak, P(T.outT) ?? 0);
      }, 16);
      setTimeout(() => { clearInterval(id); res(s); }, ms);
    });

    return {
      acState: ac?.state ?? null,
      ready: !!a?.ready,
      muted: !!a?.muted,
      hasVoidGain: !!a?.voidGain,
      tapped: !!globalThis.__TAPS__.voidT && !!globalThis.__TAPS__.outT,
      VOID_LAYER: AU.VOID_LAYER,
      BAND_STING_WINDOW: AU.BAND_STING_WINDOW,
      SNAP: BL.SNAP,
      BAND_SKY: BL.BAND_SKY,
      PRESSURE: COR.PRESSURE,
      CLEANSE: COR.CLEANSE,
      VOIDTOUCHED: COR.VOIDTOUCHED,
      BANDS: COR.BANDS,
    };
  });
  check('the AudioContext is running (the mix arm has something to measure)',
    armed.acState === 'running' && armed.ready && !armed.muted, armed);
  check('both taps are on the real graph (void layer and the last node before the device)',
    armed.tapped && armed.hasVoidGain, { tapped: armed.tapped, voidGain: armed.hasVoidGain });

  // ---------------------------------------------------------------- arm 1+2
  // Walk the world up through every band with real `Corruption.feed` calls —
  // the same entry point a chest takes — one crossing at a time, and trace what
  // each crossing does to the sky. The 1.9 s real-time gap between crossings
  // clears `_stingReady` (1.6 s), which is the guard a burst of feeds inside one
  // frame is supposed to thin.
  const escalate = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    const { BL } = globalThis.__MODS__;
    const log = globalThis.__LOG__;
    const SNAP = BL.SNAP, BAND_SKY = BL.BAND_SKY;
    // Frames to cover the snap window exactly: the clock is pinned at 1/60, so
    // one rendered frame is one 60th of a second of simulation.
    const winFrames = Math.ceil(SNAP.window * 60);
    const out = [];
    for (const target of [25, 60, 115, 200]) {
      const before = ctx.corruption.world;
      const crossingsBefore = log.crossings.length;
      const stingsBefore = log.stings.length;
      Ha.thaw();
      globalThis.__PIN__();
      ctx.corruption.feed(ctx.player, target - before);
      // Frame-by-frame for the whole snap window: `_snapT` counts down on the
      // fixed step and `_skyW` is settled at SNAP.rateMult inside it.
      const trace = [];
      let skyHit = null;
      for (let f = 1; f <= winFrames; f++) {
        await Ha.frames(1);
        const t = +(f / 60).toFixed(4);
        const w = ctx.blight?._skyW ?? 0;
        if (skyHit == null && w >= 0.9) skyHit = t;
        if (f % 12 === 0 || f === 1) trace.push({ t, snapT: +(ctx.blight?._snapT ?? 0).toFixed(3), skyW: +w.toFixed(4) });
      }
      const rec = {
        target,
        world: +ctx.corruption.world.toFixed(2),
        band: ctx.corruption.band,
        crossings: log.crossings.slice(crossingsBefore),
        stings: log.stings.slice(stingsBefore),
        snapTAtCrossing: trace[0]?.snapT ?? null,
        skyTarget: BAND_SKY[Math.min(ctx.corruption.band, BAND_SKY.length - 1)],
        skyReached09At: skyHit,
        skyWAtWindowEnd: +(ctx.blight?._skyW ?? 0).toFixed(4),
        vignetteBoost: +(ctx.pipeline?.vignetteBoost ?? 0).toFixed(4),
        trace,
      };
      out.push(rec);
      // Real seconds, so the sting's own re-arm window actually elapses.
      await new Promise((r) => setTimeout(r, 1900));
    }
    Ha.freeze();
    return { steps: out, crossings: log.crossings, stings: log.stings, snapWindow: SNAP.window, winFrames };
  });
  check('every band crossing was announced (4 upward crossings)',
    escalate.crossings.length === 4 && escalate.crossings.map((c) => c.band).join(',') === '1,2,3,4',
    escalate.crossings);
  check('bandSting fired once per crossing',
    escalate.stings.length === escalate.crossings.length, {
      crossings: escalate.crossings.length, stings: escalate.stings.length,
    });
  check('every sting minted real oscillator nodes (it is audio, not a no-op)',
    escalate.stings.length > 0 && escalate.stings.every((s) => s.oscillators >= 2),
    escalate.stings.map((s) => ({ band: s.band, osc: s.oscillators })));
  check('every crossing opened the snap window',
    escalate.steps.every((s) => s.snapTAtCrossing > 0),
    escalate.steps.map((s) => ({ band: s.band, snapT: s.snapTAtCrossing })));
  // Bands 0-1 have BAND_SKY 0 by design (the atmosphere must not play before the
  // world is in trouble), so 0.9 is only owed where the target can reach it.
  const skyOwed = escalate.steps.filter((s) => s.skyTarget >= 0.9);
  check(`the sky weight reached 0.9 inside SNAP.window (${escalate.snapWindow}s) wherever the band asks for it`,
    skyOwed.length > 0 && skyOwed.every((s) => s.skyReached09At != null && s.skyReached09At <= escalate.snapWindow),
    skyOwed.map((s) => ({ band: s.band, target: s.skyTarget, reached09At: s.skyReached09At })));
  check('and the bands whose target is below 0.9 got there instead',
    escalate.steps.filter((s) => s.skyTarget < 0.9)
      .every((s) => Math.abs(s.skyWAtWindowEnd - s.skyTarget) < 0.02),
    escalate.steps.map((s) => ({ band: s.band, target: s.skyTarget, end: s.skyWAtWindowEnd })));
  await shot('00-band4-reached');

  // ---------------------------------------------------------------- arm 3
  // The deferred ear check, answered with numbers. Same band, same gain, two
  // mixes: an empty stage and a real firefight.
  const mix = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    const THREE = G.THREE;
    const { AU } = globalThis.__MODS__;
    const a = ctx.audio;
    Ha.thaw();
    globalThis.__PIN__();
    // `voidGain` rides a 2.0 s time constant; five of them is the settled value.
    await new Promise((r) => setTimeout(r, 10000));
    const band = ctx.corruption.band;
    const nominal = AU.voidLayerGain(band);
    const settled = +a.voidGain.gain.value.toFixed(4);

    // Quiet: nothing alive, nothing firing.
    for (const e of ctx.director.enemies.slice()) { e.alive = false; e.health = 0; }
    if (ctx.input) ctx.input.mouse.left = false;
    await new Promise((r) => setTimeout(r, 700));
    const quiet = await globalThis.__WINDOW__(2000);
    const quietEnemies = ctx.director.enemies.filter((e) => e.alive).length;

    // Firefight: 24 bodies off the real spawn cards, in a ring, trigger held.
    const { SPAWN_CARDS } = await import('/src/data/enemies.js');
    const p = ctx.player.position;
    let placed = 0;
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2, r = 9 + (i % 3) * 2;
      const x = p.x + Math.cos(ang) * r, z = p.z + Math.sin(ang) * r;
      const at = new THREE.Vector3(x, ctx.stage.sampleHeight(x, z), z);
      if (ctx.director.spawnOne(ctx, SPAWN_CARDS[i % SPAWN_CARDS.length], at, null)) placed++;
    }
    if (ctx.input) ctx.input.mouse.left = true;
    const damage = [];
    const off = (p2) => damage.push(p2?.amount ?? 0);
    ctx.events.on('damage', off);
    // Let the fight actually start before the shutter on the meter opens.
    await new Promise((r) => setTimeout(r, 1500));
    const damageBefore = damage.length;
    const fight = await globalThis.__WINDOW__(2000);
    const damageDuring = damage.length - damageBefore;
    const aliveDuring = ctx.director.enemies.filter((e) => e.alive).length;
    if (ctx.input) ctx.input.mouse.left = false;
    Ha.freeze();
    const db = (x, y) => (x > 0 && y > 0 ? +(20 * Math.log10(x / y)).toFixed(2) : null);
    return {
      band, nominalGain: nominal, settledGain: settled,
      quiet: { ...quiet, voidPeak: +quiet.voidPeak.toFixed(5), outPeak: +quiet.outPeak.toFixed(5), enemiesAlive: quietEnemies },
      fight: {
        ...fight, voidPeak: +fight.voidPeak.toFixed(5), outPeak: +fight.outPeak.toFixed(5),
        placed, aliveDuring, damageEvents: damageDuring,
      },
      voidBelowOutputQuiet_dB: db(quiet.voidPeak, quiet.outPeak),
      voidBelowOutputFight_dB: db(fight.voidPeak, fight.outPeak),
      outputRiseInFight_dB: db(fight.outPeak, quiet.outPeak),
    };
  });
  check('the void layer settled on its band-4 gain', Math.abs(mix.settledGain - mix.nominalGain) < 0.01,
    { band: mix.band, nominal: mix.nominalGain, settled: mix.settledGain });
  check('the void layer is not digital silence on a quiet stage', mix.quiet.voidPeak > 1e-3, mix.quiet);
  check('the firefight arm was a real firefight (bodies alive, damage landing)',
    mix.fight.aliveDuring > 0 && mix.fight.damageEvents > 0,
    { placed: mix.fight.placed, alive: mix.fight.aliveDuring, damage: mix.fight.damageEvents });
  check('the void layer survives the combat mix (still above -40 dB of the limiter output)',
    mix.voidBelowOutputFight_dB != null && mix.voidBelowOutputFight_dB > -40, {
      quiet_dB: mix.voidBelowOutputQuiet_dB, fight_dB: mix.voidBelowOutputFight_dB,
      outputRise_dB: mix.outputRiseInFight_dB,
    });
  await shot('01-band4-firefight');

  // ---------------------------------------------------------------- arm 4
  // Pressure, proved differentially. `updateDifficulty` is pure in its inputs,
  // so recomputing the same frame at world 0 isolates exactly the term this
  // slice added — no retyped formula, no captured baseline.
  const pressure = await page.evaluate(async () => {
    const { COR } = globalThis.__MODS__;
    const ctx = globalThis.__GAME__.ctx;
    const d = ctx.director;
    const world = ctx.corruption.world;
    d.updateDifficulty(ctx);
    const withWorld = d.difficultyCoefficient;
    const rewardWith = d.rewardCoefficient;
    const levelWith = d.level, nameWith = d.difficultyName;
    // Same frame, world removed. `_world` is the private field the getter reads;
    // put it back before anything else runs.
    const save = ctx.corruption._world;
    ctx.corruption._world = 0;
    d.updateDifficulty(ctx);
    const without = d.difficultyCoefficient;
    const rewardWithout = d.rewardCoefficient;
    const levelWithout = d.level;
    ctx.corruption._world = save;
    d.updateDifficulty(ctx);
    const stageFactor = Math.pow(1.15, d.stagesCompleted);
    return {
      world: +world.toFixed(3),
      stagesCompleted: d.stagesCompleted,
      stageFactor: +stageFactor.toFixed(4),
      ctxTime: +ctx.time.toFixed(2),
      playerFactor: +d.playerFactor.toFixed(4),
      coefWithWorld: +withWorld.toFixed(6),
      coefWithoutWorld: +without.toFixed(6),
      rewardWithWorld: +rewardWith.toFixed(6),
      rewardWithoutWorld: +rewardWithout.toFixed(6),
      delta: +(withWorld - without).toFixed(6),
      expectedDelta: +(world * COR.PRESSURE.perWorld * stageFactor).toFixed(6),
      perWorld: COR.PRESSURE.perWorld,
      levelWith, levelWithout, nameWith,
      restored: +d.difficultyCoefficient.toFixed(6),
    };
  });
  check('difficultyCoefficient carries the corruption term',
    pressure.delta > 0 && Math.abs(pressure.delta - pressure.expectedDelta) < 1e-6, pressure);
  check('and the term is PRESSURE.perWorld * world * the stage factor, exactly',
    Math.abs(pressure.delta - pressure.expectedDelta) < 1e-9,
    { delta: pressure.delta, expected: pressure.expectedDelta });
  check('and the reward coefficient did NOT move: pressure is threat, never gold',
    Math.abs(pressure.rewardWithWorld - pressure.rewardWithoutWorld) < 1e-9
      && Math.abs(pressure.rewardWithoutWorld - pressure.coefWithoutWorld) < 1e-9,
    { withWorld: pressure.rewardWithWorld, withoutWorld: pressure.rewardWithoutWorld,
      coefWithoutWorld: pressure.coefWithoutWorld });
  check('the world reads out as real Director levels, not just a number',
    pressure.levelWith >= pressure.levelWithout, { with: pressure.levelWith, without: pressure.levelWithout });
  check('the differential put the coefficient back where it found it',
    Math.abs(pressure.restored - pressure.coefWithWorld) < 1e-9,
    { before: pressure.coefWithWorld, after: pressure.restored });

  // ---------------------------------------------------------------- arm 5
  // The price of a Hollowed. Two bodies off the same card on the same ground,
  // one Hollowed, one sibling elite, killed a frame apart at the same
  // coefficient — and the payout read off the `goldReward` event the HUD reads,
  // not off a re-call of `killReward`.
  const price = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    const THREE = G.THREE;
    const { COR } = globalThis.__MODS__;
    const { SPAWN_CARDS, ELITE_STATS } = await import('/src/data/enemies.js');
    for (const e of ctx.director.enemies.slice()) { e.alive = false; e.health = 0; }
    const rewards = [];
    ctx.events.on('goldReward', (p) => rewards.push({
      amount: p.amount, affix: p.victim?.affix ?? null, def: p.victim?.def?.id ?? null,
      eliteCost: p.victim?.elite?.cost ?? null,
      // The coefficient the payout is actually computed against, which is the
      // clean one: corruption raises threat, never gold.
      coef: +ctx.director.rewardCoefficient.toFixed(4),
      difficultyCoef: +ctx.director.difficultyCoefficient.toFixed(4),
    }));
    const card = SPAWN_CARDS.find((c) => c.id === 'scarab') ?? SPAWN_CARDS[0];
    const spawn = (affix, dx) => {
      const x = ctx.player.position.x + dx, z = ctx.player.position.z + 14;
      const at = new THREE.Vector3(x, ctx.stage.sampleHeight(x, z), z);
      return ctx.director.spawnOne(ctx, card, at, affix);
    };
    Ha.thaw();
    globalThis.__PIN__();
    const sibling = spawn('warded', -6);
    const hollow = spawn(COR.VOIDTOUCHED.affix, 6);
    await Ha.frames(4);
    const coefAtKill = ctx.director.difficultyCoefficient;
    // Sibling first: the Hollowed kill bleeds the world, which moves the
    // coefficient on the next fixed step, and the two payouts have to be read
    // against the same one.
    const rewardsBefore = rewards.length;
    // A Warded elite carries a shield pool *and* ward armour while it is up, so
    // one oversized hit is not a guaranteed kill — armour scales the number
    // down and the barrier eats the rest. Hit until the body is actually down,
    // which is what a player does anyway.
    const finish = (e) => {
      for (let i = 0; i < 24 && e.alive; i++) {
        ctx.combat.applyDamage(e, (e.maxHealth || 100) * 4 + (e.shield || 0) + 1000,
          { source: ctx.player, type: 'probe', position: e.position });
      }
      return e.alive;
    };
    const siblingSurvived = finish(sibling);
    const worldBefore = ctx.corruption.world;
    const hollowSurvived = finish(hollow);
    const worldAfter = ctx.corruption.world;
    await Ha.frames(10);
    Ha.freeze();
    const got = rewards.slice(rewardsBefore);
    const sib = got.find((r) => r.affix === 'warded') ?? null;
    const hol = got.find((r) => r.affix === COR.VOIDTOUCHED.affix) ?? null;
    const artRefund = ctx.artifacts?.corruptionMods?.().refund ?? 1;
    return {
      card: card.id, coefAtKill: +coefAtKill.toFixed(4),
      sibling: sib, hollow: hol, allRewards: got,
      spawned: {
        sibling: { affix: sibling?.affix ?? null, isElite: !!sibling?.isElite, survived: siblingSurvived },
        hollow: { affix: hollow?.affix ?? null, isElite: !!hollow?.isElite, survived: hollowSurvived },
      },
      eliteCosts: { warded: ELITE_STATS.warded.cost, voidtouched: ELITE_STATS.voidtouched.cost },
      rewardMult: COR.VOIDTOUCHED.rewardMult,
      // What the Hollowed owes: the sibling's payout, re-scaled by the two
      // elite costs (the only other term that differs between them) and by
      // rewardMult. Both costs come from the live table.
      expectedHollow: sib ? Math.round(sib.amount
        * (ELITE_STATS.voidtouched.cost / ELITE_STATS.warded.cost) * COR.VOIDTOUCHED.rewardMult) : null,
      // What it would pay at the same elite cost, for the feel table.
      hollowAtSiblingCost: hol ? +(hol.amount * (ELITE_STATS.warded.cost / ELITE_STATS.voidtouched.cost)).toFixed(1) : null,
      refund: {
        fraction: COR.VOIDTOUCHED.refund * artRefund,
        worldBefore: +worldBefore.toFixed(3), worldAfter: +worldAfter.toFixed(3),
        bled: +(worldBefore - worldAfter).toFixed(3),
        expected: +(worldBefore * COR.VOIDTOUCHED.refund * artRefund).toFixed(3),
      },
    };
  });
  check('both kills paid through the goldReward event',
    !!price.sibling && !!price.hollow, { sibling: price.sibling, hollow: price.hollow });
  check(`a Hollowed pays rewardMult (${price.rewardMult}) of a sibling elite off the same card`,
    price.hollow && price.expectedHollow != null && Math.abs(price.hollow.amount - price.expectedHollow) <= 1,
    { hollow: price.hollow?.amount, sibling: price.sibling?.amount, expected: price.expectedHollow,
      eliteCosts: price.eliteCosts });
  check('both were paid at the same reward coefficient',
    price.sibling && price.hollow && Math.abs(price.sibling.coef - price.hollow.coef) < 1e-9,
    { sibling: price.sibling?.coef, hollow: price.hollow?.coef });
  check(`the Hollowed kill bled ${(price.refund.fraction * 100).toFixed(1)}% of the world`,
    Math.abs(price.refund.bled - price.refund.expected) < Math.max(0.05, price.refund.worldBefore * 0.01),
    price.refund);

  // ---------------------------------------------------------------- arm 6
  // The bank. Prime it past anything the world could earn and let one real tick
  // clamp it; the ceiling is read from the shipped `voidBankCap`.
  const bank = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    const { COR } = globalThis.__MODS__;
    const d = ctx.director;
    // The clamp only runs where the stage has a blight seed — that gate is the
    // sp-equivalence argument, so satisfy it the way the game does: a real seed.
    if (!d._voidSeeds.length) {
      const p = ctx.player.position;
      ctx.corruption.seed({ x: p.x + 25, z: p.z + 25 }, 1);
    }
    const world = ctx.corruption.world;
    d.voidCredits = 1e6;
    Ha.thaw();
    globalThis.__PIN__();
    await Ha.frames(6);
    const clamped = d.voidCredits;
    // And the rate it fills at, measured over a second of live play from empty.
    d.voidCredits = 0;
    const t0 = ctx.time;
    await Ha.frames(60);
    const filled = d.voidCredits;
    const dt = ctx.time - t0;
    Ha.freeze();
    return {
      world: +world.toFixed(2),
      seeds: d._voidSeeds.length,
      clamped: +clamped.toFixed(3),
      cap: +COR.voidBankCap(world).toFixed(3),
      maxBank: COR.VOIDTOUCHED.maxBank,
      filledInOneSecond: +filled.toFixed(3),
      simSeconds: +dt.toFixed(3),
      ratePerSecond: +COR.voidCreditRate(world).toFixed(4),
    };
  });
  check('the void bank clamps to voidBankCap(world)',
    Math.abs(bank.clamped - bank.cap) < 1e-6, bank);
  check('and it fills at voidCreditRate(world)',
    bank.simSeconds > 0 && Math.abs(bank.filledInOneSecond / bank.simSeconds - bank.ratePerSecond) < 0.05,
    { measured: +(bank.filledInOneSecond / bank.simSeconds).toFixed(4), expected: bank.ratePerSecond });

  // ---------------------------------------------------------------- arm 7
  // The way back out. A band >= 2 stage has to carry a font however the bag
  // landed, and three uses at world 400 have to be worth what `cleanseAmount`
  // says the *live* world is worth at each press — which is the number the next
  // playtest judges, and it is not three times the first one.
  const cleanse = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    const { COR } = globalThis.__MODS__;
    const { ArgentFont } = await import('/src/world/Interactables.js');
    // Take the world to exactly 400 — the depth every feel number is quoted at.
    const w0 = ctx.corruption.world;
    if (w0 < 400) ctx.corruption.feed(ctx.player, 400 - w0);
    else if (w0 > 400) ctx.corruption.bleed(ctx.player, w0 - 400);
    const band = ctx.corruption.band;

    // The guarantee, through the real `populate`, over many draws: from
    // CLEANSE.guaranteeBand up, every stage carries one.
    let stagesWithFont = 0, trials = 0, fontsSeen = 0;
    for (let i = 0; i < 12; i++) {
      ctx.seed = (ctx.seed * 1664525 + 1013904223) >>> 0;
      ctx.interactables.populate(1 + (i % 3));
      trials++;
      const n = ctx.interactables.list.filter((it) => it instanceof ArgentFont).length;
      fontsSeen += n;
      if (n > 0) stagesWithFont++;
    }

    // One of them, used for real. Everything else steps aside so "nearest
    // available" — the rule the E press goes through — can only mean the font.
    const font = ctx.interactables.list.find((it) => it instanceof ArgentFont);
    for (const it of ctx.interactables.list) it.enabled = (it === font);
    const near = font ? font.position : null;
    if (font && ctx.player) {
      ctx.player.position.set(near.x + 1.6, ctx.stage.sampleHeight(near.x + 1.6, near.z), near.z);
      ctx.player.velocity?.set?.(0, 0, 0);
    }
    ctx.items.gold = 500000;
    Ha.thaw();
    globalThis.__PIN__();
    await Ha.frames(10);
    const presses = [];
    for (let i = 0; i < COR.CLEANSE.maxUses; i++) {
      const w = ctx.corruption.world, g = ctx.items.gold, c = font?.cost ?? null;
      const expect = Math.min(w, COR.cleanseAmount(w));
      // What the shipped curve says this press should cost, from the live
      // module rather than a number written down here.
      const expectCost = font ? COR.cleanseCost(font.stageIndex, font.uses, w) : null;
      const ok = ctx.interactables.requestInteract(ctx.player);
      await Ha.frames(6);
      presses.push({
        ok, worldBefore: +w.toFixed(2), worldAfter: +ctx.corruption.world.toFixed(2),
        bled: +(w - ctx.corruption.world).toFixed(2), expected: +expect.toFixed(2),
        cost: c, expectedCost: expectCost, goldPaid: g - ctx.items.gold,
      });
    }
    Ha.freeze();
    const total = presses.reduce((s, p) => s + p.bled, 0);
    return {
      bandAtPopulate: band,
      guaranteeBand: COR.CLEANSE.guaranteeBand,
      stagesWithFont, trials, fontsSeen,
      hadFont: !!font,
      stageIndex: font?.stageIndex ?? null,
      // The price curve, read off the live module: what three presses cost at a
      // world held still (the per-use climb alone), and what the world term
      // itself is worth at 400. The measured prices above fall across a real
      // visit because each press retires part of the debt being charged for.
      costLadderAtFixedWorld: font ? [0, 1, 2].map((u) => COR.cleanseCost(font.stageIndex, u, 400)) : null,
      worldTermAt400: COR.cleanseCost(0, 0, 400) - COR.cleanseCost(0, 0, 0),
      goldPerWorld: COR.CLEANSE.goldPerWorld,
      firstUseAt400: COR.cleanseAmount(400),
      presses,
      totalBled: +total.toFixed(2),
      naiveThreeTimesFirst: COR.cleanseAmount(400) * COR.CLEANSE.maxUses,
      worldEnd: +ctx.corruption.world.toFixed(2),
      bandEnd: ctx.corruption.band,
    };
  });
  check(`every band >= ${cleanse.guaranteeBand} stage carried an Argent Font (${cleanse.trials} populates)`,
    cleanse.bandAtPopulate >= cleanse.guaranteeBand && cleanse.stagesWithFont === cleanse.trials,
    { band: cleanse.bandAtPopulate, withFont: cleanse.stagesWithFont, trials: cleanse.trials, fonts: cleanse.fontsSeen });
  check('every use bled exactly cleanseAmount(live world)',
    cleanse.presses.length > 0 && cleanse.presses.every((p) => p.ok && Math.abs(p.bled - p.expected) < 1e-6),
    cleanse.presses);
  check('every press charged cleanseCost(stage, uses, live world)',
    cleanse.presses.length > 0 && cleanse.presses.every((p) => p.cost === p.expectedCost && p.goldPaid === p.cost),
    cleanse.presses.map((p) => ({ cost: p.cost, expected: p.expectedCost, paid: p.goldPaid })));
  check('the price climbs per use at a world held still',
    !!cleanse.costLadderAtFixedWorld
      && cleanse.costLadderAtFixedWorld.every((c, i, all) => i === 0 || c > all[i - 1]),
    cleanse.costLadderAtFixedWorld);
  check(`and a Consumed world puts world * ${cleanse.goldPerWorld} on the bill`,
    Math.abs(cleanse.worldTermAt400 - 400 * cleanse.goldPerWorld) <= 1,
    { term: cleanse.worldTermAt400, expected: 400 * cleanse.goldPerWorld });
  check('a font visit at world 400 is worth a whole band of the debt',
    cleanse.totalBled > 190, { total: cleanse.totalBled, from: 400, to: cleanse.worldEnd });
  await shot('02-font-visit-at-400');

  // ---------------------------------------------------------------- arm 8
  // The feel table, computed from the live modules at world 400 and joined to
  // what the arms above actually measured.
  const feel = await page.evaluate(async () => {
    const { COR } = globalThis.__MODS__;
    const w = 400;
    const seq = [];
    let cur = w;
    for (let i = 0; i < COR.CLEANSE.maxUses; i++) {
      const a = Math.min(cur, COR.cleanseAmount(cur));
      seq.push({ use: i + 1, worldBefore: cur, bleed: a });
      cur -= a;
    }
    return {
      world: w,
      creditsPerSecond: COR.voidCreditRate(w),
      bankCap: COR.voidBankCap(w),
      bankCapPristine: COR.voidBankCap(0),
      refundPerKill: +(w * COR.VOIDTOUCHED.refund).toFixed(2),
      rewardMult: COR.VOIDTOUCHED.rewardMult,
      cleanseFirstUse: COR.cleanseAmount(w),
      cleanseSequence: seq,
      cleanseTotal: seq.reduce((s, x) => s + x.bleed, 0),
      cleanseWorldAfter: cur,
      corruptionCoefficient: +(w * COR.PRESSURE.perWorld).toFixed(4),
      bandOf400: COR.bandOf(w),
    };
  });
  check('world 400 pays the brief\'s 8.0 credits/s and banks 240',
    feel.creditsPerSecond === 8 && feel.bankCap === 240, feel);
  check('world 400 adds the brief\'s +1.6 coefficient before the stage multiplier',
    Math.abs(feel.corruptionCoefficient - 1.6) < 1e-9, feel.corruptionCoefficient);
  console.log('\n  feel numbers at world 400:');
  console.log(`    credits/s            ${feel.creditsPerSecond}`);
  console.log(`    bank cap             ${feel.bankCap} (pristine ${feel.bankCapPristine})`);
  console.log(`    Hollowed gold        ${price.hollow?.amount} vs sibling ${price.sibling?.amount}`
    + ` (at equal elite cost: ${price.hollowAtSiblingCost} vs ${price.sibling?.amount})`);
  console.log(`    refund per kill      ${feel.refundPerKill} world`);
  console.log(`    cleanse per visit    ${feel.cleanseSequence.map((s) => s.bleed).join(' + ')} = ${feel.cleanseTotal}`
    + `  (measured live: ${cleanse.presses.map((p) => p.bled).join(' + ')} = ${cleanse.totalBled})`);
  console.log(`    corruption coef      +${feel.corruptionCoefficient} pre-stage-mult (threat only)`);
  console.log(`    font prices paid     ${cleanse.presses.map((p) => '$' + p.cost).join(' + ')}`
    + `  (stage ${cleanse.stageIndex}; world term at 400: $${cleanse.worldTermAt400})`);

  check('no page errors across the session', pageErrors.length === 0, pageErrors.slice(0, 3));
  check('no console errors across the session', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  const failed0 = checks.filter((c) => !c.pass);
  record = {
    seed: SEED, at: new Date().toISOString(), out: OUT,
    constants: armed,
    arms: { escalate, mix, pressure, price, bank, cleanse, feel },
    checks, pageErrors, consoleErrors,
    verdict: failed0.length ? 'FAILED' : 'PASSED',
  };
} catch (e) {
  console.error('PROBE THREW', e);
  check('probe ran to completion', false, String(e && e.message));
  record = {
    seed: SEED, at: new Date().toISOString(), out: OUT,
    threw: String(e?.stack ?? e), checks, pageErrors, consoleErrors, verdict: 'THREW',
  };
  try { await page.screenshot({ path: path.join(OUT, 'zz-threw.png') }); } catch { /* the page is gone */ }
} finally {
  const json = JSON.stringify(record, null, 2);
  await writeFile(path.join(OUT, 'reckoningprobe.json'), json);
  if (RECORD) {
    await mkdir(path.dirname(RECORD), { recursive: true });
    await writeFile(RECORD, json);
  }
  await browser.close();
  await server.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed — ${failed.length ? 'FAILED' : 'PASSED'}`);
process.exit(failed.length ? 1 : 0);
