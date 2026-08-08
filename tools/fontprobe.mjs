/**
 * Live counterplay probe — the "verify by playing" pass of the Argent Font /
 * Covenant Stone slice, run headlessly because this environment has no hands.
 *
 * The unit tests build the two shrines by hand against a stub ctx. This drives
 * the *real* game instead — real Stage, real Interactables.populate, real
 * chests, real Corruption, real HUD — and asks what a player would ask:
 *
 *   1. bag        a stage-1+ run actually rolls Argent Fonts out of the real
 *                 shrine bag; stage 0 never does (the gate).
 *   2. solo       a solo roster never rolls a Covenant Stone, over many
 *                 populates; flipping the roster to a party makes stones
 *                 appear from the same code. (Structural — the live two-player
 *                 pact itself is deferred to a co-op session.)
 *   3. gauge      real void-credit chest opens move World Corruption and the
 *                 HUD gauge off Pristine.
 *   4. prompt     walking up to the font puts its price in the real HUD prompt
 *                 through `_updateFocus`, not a string this probe built.
 *   5. use        interacting drops the gauge by CLEANSE.amount, takes exactly
 *                 the prompted gold, climbs the price, and the second use
 *                 spends the font — the third is refused.
 *   6. clean      no seed is planted by a cleanse (it is not a greed act), and
 *                 zero page/console errors across the session.
 *
 *   node tools/fontprobe.mjs [--seed 1337] [--port 5211] [--out shots-counterplay]
 *
 * Exit 1 if any check fails; the JSON record is written beside the PNGs either
 * way, because a failed arm is evidence too.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5211);
const OUT = path.resolve(args.out ?? 'shots-counterplay');
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
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));
  await page.evaluate(() => globalThis.__HARNESS__.gameplay({ settleFrames: 60 }));

  // ---------------------------------------------------------------- arm 1+2
  // The bag, driven through the real `populate`. Repopulating the live stage is
  // exactly what a stage transition does, so this is the shipped code path with
  // the dice rolled many times instead of once.
  const bag = await page.evaluate(async () => {
    const G = globalThis.__GAME__, ctx = G.ctx;
    const tally = (stageIndex, trials) => {
      const t = { fonts: 0, stones: 0, shrines: 0 };
      for (let i = 0; i < trials; i++) {
        // Each populate re-seeds the private shrine stream off ctx.seed, so
        // move the seed to sample the bag rather than one fixed draw.
        ctx.seed = (ctx.seed * 1664525 + 1013904223) >>> 0;
        ctx.interactables.populate(stageIndex);
        for (const it of ctx.interactables.list) {
          const n = it.constructor.name;
          if (n === 'ArgentFont') t.fonts++;
          else if (n === 'CovenantStone') t.stones++;
          if (typeof it.maxUses === 'number') t.shrines++;
        }
      }
      return t;
    };
    const soloCount = ctx.roster?.count ?? 1;
    const solo1 = tally(1, 40);
    const solo0 = tally(0, 40);
    // The party case: the same bag code with a second pawn on the roster.
    // `Roster.count` is `all.length`, so the only honest way to say "two" is
    // to put a second body in the list.
    const mate = { isPlayer: true, alive: true, position: ctx.player.position.clone() };
    ctx.roster?.all?.push(mate);
    const partyCount = ctx.roster?.count ?? 1;
    const party1 = tally(1, 40);
    const i = ctx.roster?.all?.indexOf(mate) ?? -1;
    if (i >= 0) ctx.roster.all.splice(i, 1);
    return { soloCount, partyCount, solo0, solo1, party1 };
  });
  check('solo run: the shrine bag is a solo bag', bag.soloCount === 1, bag.soloCount);
  check('stage 1+: Argent Fonts roll out of the real bag', bag.solo1.fonts > 0, bag.solo1);
  check('stage 0: the font is gated out', bag.solo0.fonts === 0, bag.solo0);
  check('solo: no Covenant Stone in 40 populates', bag.solo1.stones === 0 && bag.solo0.stones === 0, {
    stage0: bag.solo0.stones, stage1: bag.solo1.stones,
  });
  check('party: the same bag code rolls Covenant Stones', bag.party1.stones > 0, bag.party1);

  // ---------------------------------------------------------------- arm 3
  // Feed the world with real void-credit chest opens (gold emptied first), then
  // put a font on the ground the player is standing on so the walk-up is real.
  const fed = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    ctx.interactables.populate(1);
    if (ctx.items) ctx.items.gold = 0;
    const before = ctx.corruption.world;
    const chests = ctx.interactables.list.filter((i) => !i.used && i.constructor.name === 'Chest');
    let opened = 0;
    for (const c of chests.slice(0, 8)) if (c.interact()) opened++;
    // The gauge is redrawn from the engine loop, and `frames()` rides rAF — so
    // the HUD is only allowed to catch up while the world is thawed.
    Ha.thaw();
    await Ha.frames(30);
    Ha.freeze();
    return {
      opened, worldBefore: before, world: ctx.corruption.world,
      seeds: ctx.corruption.seeds.length,
      gaugeWidth: document.querySelector('.corruption-fill')?.style.width ?? null,
      gaugeBand: document.querySelector('.corruption-band')?.textContent ?? null,
    };
  });
  check('void-credit chests fed the world', fed.world > fed.worldBefore, { from: fed.worldBefore, to: fed.world });
  check('the HUD gauge left Pristine', fed.gaugeBand !== 'Pristine' && fed.gaugeWidth !== '0%',
    { band: fed.gaugeBand, width: fed.gaugeWidth });

  // ---------------------------------------------------------------- arm 4
  // Walk up to a font and read the *real* prompt the HUD was handed.
  const promptArm = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    // Guarantee one within reach without inventing it: build it through the
    // shipped class and the manager's own add(), sited at the survivor.
    const mod = await import('/src/world/Interactables.js');
    const THREE = G.THREE;
    const px = ctx.player.position.x + 2.0, pz = ctx.player.position.z;
    const at = new THREE.Vector3(px, ctx.stage.sampleHeight(px, pz), pz);
    // Everything else on the stage steps aside, so "nearest available" — the
    // rule both the prompt and the E press go through — can only mean the font.
    for (const it of ctx.interactables.list) it.enabled = false;
    const font = new mod.ArgentFont(ctx, at, 1);
    ctx.interactables.add(font);
    globalThis.__FONT__ = font;
    let prompt = null;
    ctx.events.on('prompt', (p) => { if (/Argent Font/.test(p.text || '')) prompt = p.text; });
    Ha.thaw();
    await Ha.frames(20);
    Ha.freeCam(at.x + 4, at.y + 2.6, at.z + 4, at.x, at.y + 1.0, at.z);
    await Ha.frames(3);
    Ha.freeze();
    return {
      prompt,
      hudPrompt: document.querySelector('.prompt')?.textContent ?? null,
      focus: ctx.interactables.focus?.constructor?.name ?? null,
      cost: font.cost, typeId: font.typeId,
    };
  });
  check('the font is what the survivor is focused on', promptArm.focus === 'ArgentFont', promptArm.focus);
  check('the real prompt shows the price', !!promptArm.prompt
    && promptArm.prompt.includes(`$${promptArm.cost}`), { prompt: promptArm.prompt, cost: promptArm.cost });
  check('it is wire value 13', promptArm.typeId === 13, promptArm.typeId);
  await shot('00-argent-font-prompt');

  // ---------------------------------------------------------------- arm 5
  const used = await page.evaluate(async () => {
    const G = globalThis.__GAME__, Ha = globalThis.__HARNESS__, ctx = G.ctx;
    const { CLEANSE } = await import('/src/data/corruption.js');
    const font = globalThis.__FONT__;
    ctx.items.gold = 5000;
    Ha.thaw();
    const w0 = ctx.corruption.world, g0 = ctx.items.gold, c0 = font.cost;
    const seeds0 = ctx.corruption.seeds.length;
    const fill0 = document.querySelector('.corruption-fill')?.style.width ?? null;
    // The E press itself: `requestInteract` is what the input path calls, and
    // it is the gate that refuses a spent shrine (`_nearest` skips anything
    // `available()` says no to). Calling `font.interact()` here would bypass
    // exactly the rule under test.
    const press = () => ctx.interactables.requestInteract(ctx.player);
    const ok1 = press();
    await Ha.frames(20);
    const w1 = ctx.corruption.world, g1 = ctx.items.gold, c1 = font.cost;
    const fill1 = document.querySelector('.corruption-fill')?.style.width ?? null;
    const ok2 = press();
    await Ha.frames(10);
    const ok3 = press();
    await Ha.frames(10);
    Ha.freeze();
    return {
      cleanseAmount: CLEANSE.amount, costClimb: CLEANSE.costClimb, maxUses: CLEANSE.maxUses,
      ok1, ok2, ok3, w0, w1, g0, g1, c0, c1,
      worldEnd: ctx.corruption.world, goldEnd: ctx.items.gold,
      seedsBefore: seeds0, seedsAfter: ctx.corruption.seeds.length,
      fill0, fill1, uses: font.uses, available: font.available(),
      emissive: font.water.material.emissiveIntensity,
    };
  });
  check('a paid cleanse succeeds', used.ok1 === true, used.ok1);
  check('the gauge dropped by CLEANSE.amount',
    Math.abs((used.w0 - used.w1) - used.cleanseAmount) < 1e-6, { from: used.w0, to: used.w1, expected: used.cleanseAmount });
  check('exactly the prompted gold was taken', used.g0 - used.g1 === used.c0, { paid: used.g0 - used.g1, prompted: used.c0 });
  check('the price climbed', used.c1 === Math.round(used.c0 * used.costClimb), { from: used.c0, to: used.c1 });
  check('the HUD gauge visibly narrowed', used.fill0 !== used.fill1, { before: used.fill0, after: used.fill1 });
  check('the font is spent after maxUses', used.ok2 === true && used.ok3 === false && used.available === false,
    { ok2: used.ok2, ok3: used.ok3, uses: used.uses });
  check('the spent basin is dimmed', used.emissive <= 0.05, used.emissive);
  check('cleansing planted no seed', used.seedsAfter === used.seedsBefore,
    { before: used.seedsBefore, after: used.seedsAfter });
  await shot('01-argent-font-spent');

  check('zero page errors across the session', pageErrors.length === 0, pageErrors);
  check('zero console errors across the session', consoleErrors.length === 0, consoleErrors.slice(0, 5));

  const failed = checks.filter((c) => !c.pass);
  const record = {
    seed: SEED, at: new Date().toISOString(),
    arms: { bag, fed, prompt: promptArm, used },
    deferred: ['the two-player Covenant Stone pact — needs a live co-op session'],
    checks, pageErrors, consoleErrors,
    verdict: failed.length ? 'FAILED' : 'PASSED',
  };
  await writeFile(path.join(OUT, 'fontprobe.json'), JSON.stringify(record, null, 2));
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed — ${record.verdict}`);
  await browser.close();
  await server.close();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('PROBE THREW', e);
  await writeFile(path.join(OUT, 'fontprobe.json'), JSON.stringify({
    seed: SEED, at: new Date().toISOString(), threw: String(e?.stack ?? e), checks, pageErrors, consoleErrors,
    verdict: 'THREW',
  }, null, 2));
  try { await page.screenshot({ path: path.join(OUT, 'zz-threw.png') }); } catch {}
  await browser.close();
  await server.close();
  process.exit(1);
}
