/**
 * Live Voidtouched probe — the "verify by playing" pass of the Hollowed slice,
 * run headlessly because this environment has no hands.
 *
 * Everything the unit tests establish about the void path they establish
 * against hand-built fixtures: a stub ctx, a synthetic `stageStart`, a Director
 * with its seed list written directly. This drives the *real* game instead —
 * real Stage, real chests, real Corruption, real Director, real HUD — and asks
 * the questions a player would ask:
 *
 *   1. pristine       a run at world 0 surfaces nothing, ever.
 *   2. void-credit    opening chests with no gold feeds corruption, plants
 *                     blight patches, and the HUD gauge moves.
 *   3. surfacing      within the budget the Director banks void credit, lays a
 *                     telegraph ring at a seed and a Hollowed comes up out of
 *                     it — carrying the `voidtouchedSpawn` event.
 *   4. standoff       every surfacing point is >= VOIDTOUCHED.minPlayerDist
 *                     from every player, measured at the moment it is chosen.
 *   5. siphon         standing inside `siphonRadius` drains the player and
 *                     heals the unit on 0.5 s ticks; backing out stops both.
 *   6. refund         killing it bleeds World Corruption, and the HUD gauge
 *                     fill visibly narrows.
 *   7. branding       every surface that names the unit says "Hollowed"; the
 *                     string "voidtouched" never reaches the DOM.
 *   8. carryover      a new stage wipes seeds, bank and pending surfacings.
 *   9. console        zero page errors across the whole session.
 *
 * Shots land in `--out` (default `shots-voidtouched`): the telegraph ring at a
 * blight patch, the unit mid-surface, a 40 m read against a Warded elite for
 * the family-separation claim, and the gauge before/after the refund.
 *
 *   node tools/voidprobe.mjs [--seed 1337] [--port 5209] [--out shots-voidtouched]
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
const PORT = Number(args.port ?? 5209);
const OUT = path.resolve(args.out ?? 'shots-voidtouched');
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

  // One pinned frame is one fixed step of simulation, so every "seconds" figure
  // below is frames/60 and does not depend on how fast this machine renders.
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));
  // `gameplay` is the smallest scenario that actually begins a run: stage
  // started, survivor attached, HUD live. It freezes when it resolves.
  await page.evaluate(() => globalThis.__HARNESS__.gameplay({ settleFrames: 60 }));

  // ---------------------------------------------------------------- arm 1
  // A pristine run. Nothing is fed, nothing is seeded, and the void path is
  // asked to prove it costs the run nothing over ten seconds of real play.
  const pristine = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const log = { spawns: [] };
    ctx.events.on('voidtouchedSpawn', (p) => log.spawns.push(p));
    globalThis.__VOIDLOG__ = log;
    H.thaw();
    await H.frames(600);
    return {
      world: ctx.corruption.world,
      band: ctx.corruption.band,
      seeds: ctx.corruption.seeds.length,
      voidSeeds: ctx.director._voidSeeds.length,
      voidCredits: ctx.director.voidCredits,
      pending: ctx.director._voidPending.length,
      spawns: log.spawns.length,
      enemies: ctx.director.enemies.length,
      voidEnemies: ctx.director.enemies.filter((e) => e.affix === 'voidtouched').length,
      gaugeWidth: document.querySelector('.corruption-fill')?.style.width ?? null,
      gaugeBand: document.querySelector('.corruption-band')?.textContent ?? null,
    };
  });
  check('pristine run: world stays 0', pristine.world === 0, pristine.world);
  check('pristine run: void bank never accrues', pristine.voidCredits === 0, pristine.voidCredits);
  check('pristine run: no surfacings in 10 s of live play', pristine.spawns === 0 && pristine.voidEnemies === 0, pristine);
  check('pristine run: HUD reads Pristine', pristine.gaugeBand === 'Pristine', pristine.gaugeBand);
  await shot('00-pristine');

  // ---------------------------------------------------------------- arm 2
  // Void-credit real chests. Gold is emptied first so `Chest.interact` takes
  // the credit branch — the same branch the prompt offers the player — and the
  // seed is planted by the chest, not by this probe.
  const credit = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const THREE = G.THREE;
    const chests = ctx.interactables.list.filter((i) => typeof i.interact === 'function' && i.cost != null && !i.used
      && i.constructor.name.toLowerCase().includes('chest'));
    // Broke, so every open is a void-credit open.
    if (ctx.items) ctx.items.gold = 0;
    const before = ctx.corruption.world;
    const opened = [];
    // Eight opens is a greedy run, not a pathological one: it lands World
    // Corruption in band 2 (Blighted), which is where the void's rate is high
    // enough that a surfacing is a thing you wait seconds for rather than
    // minutes. Three opens (band 1, 30 world, 0.36 credits/s) banked 16.4 in a
    // measured 60 s and never reached a unit's price — real, and worth knowing,
    // but it is not the state this shot is about.
    for (const c of chests.slice(0, 8)) {
      const ok = c.interact();
      opened.push({ size: c.size, ok, x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2) });
    }
    await H.frames(30);
    const seed = ctx.corruption.seeds[ctx.corruption.seeds.length - 1] ?? null;
    // Park the survivor a clear 18 m off the freshest seed: outside
    // minPlayerDist so the void may use it, close enough that the camera can
    // hold both the patch and him.
    if (seed && ctx.player) {
      const y = ctx.stage.sampleHeight(seed.x + 18, seed.z);
      ctx.player.position.set(seed.x + 18, y, seed.z);
      ctx.player.velocity?.set?.(0, 0, 0);
    }
    await H.frames(30);
    return {
      chestsFound: chests.length,
      opened,
      worldBefore: before,
      world: ctx.corruption.world,
      band: ctx.corruption.band,
      seeds: ctx.corruption.seeds.length,
      voidSeeds: ctx.director._voidSeeds.length,
      patches: ctx.blight?.patches?.length ?? null,
      gaugeWidth: document.querySelector('.corruption-fill')?.style.width ?? null,
      gaugeBand: document.querySelector('.corruption-band')?.textContent ?? null,
      seedAt: seed && { x: +seed.x.toFixed(2), z: +seed.z.toFixed(2) },
      player: ctx.player && [+ctx.player.position.x.toFixed(2), +ctx.player.position.z.toFixed(2)],
      unused: THREE ? true : true,
    };
  });
  check('void-credit chests fed corruption', credit.world > credit.worldBefore, { from: credit.worldBefore, to: credit.world });
  check('void-credit planted seeds', credit.seeds > 0 && credit.voidSeeds === credit.seeds, credit);
  check('blight patches grew where greed happened', (credit.patches ?? 0) > 0, credit.patches);
  check('HUD gauge left Pristine', credit.gaugeBand !== 'Pristine' && credit.gaugeWidth !== '0%', {
    band: credit.gaugeBand, width: credit.gaugeWidth,
  });

  // ---------------------------------------------------------------- arm 3
  // Wait for the Director to bank enough void credit to buy one, and stop the
  // world the instant the telegraph ring is laid.
  const tele = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const d = ctx.director;
    let frames = 0;
    const trace = [];
    while (frames < 5400 && !d._voidPending.length) {
      await H.frames(1); frames++;
      if (frames % 60 === 0) trace.push(+d.voidCredits.toFixed(2));
    }
    const p = d._voidPending[0] ?? null;
    let minPlayerDist = null;
    if (p && ctx.roster) {
      ctx.roster.forEachTargetable((pl) => {
        const dx = pl.position.x - p.x, dz = pl.position.z - p.z;
        const dd = Math.hypot(dx, dz);
        if (minPlayerDist == null || dd < minPlayerDist) minPlayerDist = dd;
      });
    }
    let seedDist = null;
    if (p) for (const s of d._voidSeeds) {
      const dd = Math.hypot(s.x - p.x, s.z - p.z);
      if (seedDist == null || dd < seedDist) seedDist = dd;
    }
    // Frame the ring: eye 9 m back and 6 m up, looking down at the point.
    if (p) H.freeCam(p.x + 4.5, p.y + 3.2, p.z + 4.5, p.x, p.y + 0.3, p.z);
    await H.frames(2);
    H.freeze();
    return {
      secondsWaited: +(frames / 60).toFixed(2),
      creditTracePerSecond: trace,
      pending: p && { x: +p.x.toFixed(2), z: +p.z.toFixed(2), t: +p.t.toFixed(2), card: p.card?.id },
      minPlayerDist: minPlayerDist == null ? null : +minPlayerDist.toFixed(2),
      seedDist: seedDist == null ? null : +seedDist.toFixed(2),
      voidCredits: +d.voidCredits.toFixed(2),
      telegraphs: d.telegraphs?.count?.() ?? d.telegraphs?.active ?? null,
    };
  });
  check('a telegraph ring was laid inside the budget', !!tele.pending, tele);
  check('the surfacing point respects minPlayerDist (12 m)', (tele.minPlayerDist ?? 0) >= 12, tele.minPlayerDist);
  check('the surfacing point sits on the seed ring (2.5-6.5 m)',
    tele.seedDist != null && tele.seedDist >= 2.5 - 1e-6 && tele.seedDist <= 6.5 + 1e-6, tele.seedDist);
  await shot('01-telegraph-at-blight');

  // ---------------------------------------------------------------- arm 3b
  // Let it ripen. The shutter opens on the frame the unit arrives, with the
  // camera still on the ring.
  const surfaced = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const log = globalThis.__VOIDLOG__;
    const before = log.spawns.length;
    H.thaw();
    let frames = 0;
    while (frames < 300 && log.spawns.length === before) { await H.frames(1); frames++; }
    const ev = log.spawns[log.spawns.length - 1] ?? null;
    const unit = ctx.director.enemies.find((e) => e.affix === 'voidtouched') ?? null;
    if (unit) H.freeCam(unit.position.x + 3.2, unit.position.y + 1.9, unit.position.z + 3.2,
      unit.position.x, unit.position.y + 0.5, unit.position.z);
    await H.frames(1);
    H.freeze();
    globalThis.__VOIDUNIT__ = unit;
    return {
      framesToSurface: frames,
      event: ev,
      eventKeys: ev ? Object.keys(ev).sort() : null,
      unit: unit && {
        id: unit.def?.id, affix: unit.affix, isElite: unit.isElite,
        health: +unit.health.toFixed(2), maxHealth: +unit.maxHealth.toFixed(2),
        x: +unit.position.x.toFixed(2), z: +unit.position.z.toFixed(2),
      },
      eventMatchesUnit: !!(ev && unit && Math.hypot(ev.x - unit.position.x, ev.z - unit.position.z) < 1.5),
      voidUnits: ctx.director.enemies.filter((e) => e.affix === 'voidtouched').length,
    };
  });
  check('a Hollowed surfaced out of the ring', !!surfaced.unit, surfaced.unit);
  check('voidtouchedSpawn fired with { x, z, id }',
    surfaced.eventKeys && surfaced.eventKeys.join(',') === 'id,x,z', surfaced.eventKeys);
  check('the event names the point the unit came up at', surfaced.eventMatchesUnit, surfaced.event);
  await shot('02-hollowed-surfaced');

  // ---------------------------------------------------------------- arm 4
  // The 40 m read, against a Warded elite on the same ground: the confusion
  // this family was specified against.
  await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const THREE = G.THREE;
    const u = globalThis.__VOIDUNIT__;
    if (!u) return;
    // The engine is stopped between arms, and `frames()` rides rAF rather than
    // the engine loop — so without this thaw the camera below would move and
    // nothing would ever compose a frame through it, and the shutter would
    // photograph the *previous* arm's picture. (It did, once.)
    H.thaw();
    // Same card, so the only difference in frame is the affix dressing.
    const at = new THREE.Vector3(u.position.x + 4, u.position.y, u.position.z);
    at.y = ctx.stage.sampleHeight(at.x, at.z);
    ctx.director.spawnOne(ctx, u.def, at, 'warded');
    await H.frames(20);
    // 40 m out on the diagonal, eye height taken off the ground *under the
    // lens* rather than off the subject's — this stage has an escarpment
    // between the two, and a camera hung 2.5 m over the subject's y ended up
    // below the lip looking at a cliff face.
    const mid = { x: u.position.x + 2, y: u.position.y, z: u.position.z };
    // Backed off along the bearing of the survivor rather than an arbitrary
    // diagonal: he is standing on the same shelf the pair is on, so that is the
    // one direction guaranteed to have 40 m of continuous ground behind it.
    // The diagonal walked straight off the escarpment and photographed a cliff.
    const bx = ctx.player.position.x - mid.x, bz = ctx.player.position.z - mid.z;
    const bl = Math.hypot(bx, bz) || 1;
    const cx = mid.x + (bx / bl) * 40, cz = mid.z + (bz / bl) * 40;
    const cy = Math.max(ctx.stage.sampleHeight(cx, cz), mid.y) + 2.2;
    H.freeCam(cx, cy, cz, mid.x, mid.y + 0.8, mid.z);
    await H.frames(3);
    H.freeze();
    globalThis.__PAIRMID__ = mid;
  });
  await shot('03-hollowed-vs-warded-40m');

  // The same pair at conversational range. At 40 m a beetle is a handful of
  // pixels whatever it is wearing, so the wide shot alone cannot carry the
  // family-separation claim; this one is what a human judges the two dressings
  // against, and the wide one is what tells you they are still separable when
  // they are small.
  await page.evaluate(async () => {
    const H = globalThis.__HARNESS__;
    const mid = globalThis.__PAIRMID__;
    if (!mid) return;
    H.thaw();
    H.freeCam(mid.x + 5, mid.y + 2.6, mid.z + 5, mid.x, mid.y + 0.5, mid.z);
    await H.frames(3);
    H.freeze();
  });
  await shot('04-hollowed-vs-warded-close');

  // ---------------------------------------------------------------- arm 5
  // The siphon, live: stand in it, then back out of it.
  const siphon = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const u = globalThis.__VOIDUNIT__;
    if (!u || !u.alive) return { skipped: 'no unit' };
    // Clear the field so nothing else can touch the survivor while this is
    // measured — the only damage source left is the siphon.
    for (const e of ctx.director.enemies.slice()) if (e !== u) { e.alive = false; e.health = 0; }
    u.health = u.maxHealth * 0.5;
    const put = (dist) => {
      const x = u.position.x + dist, z = u.position.z;
      ctx.player.position.set(x, ctx.stage.sampleHeight(x, z), z);
      ctx.player.velocity?.set?.(0, 0, 0);
    };
    const hurts = [];
    ctx.events.on('playerHurt', (p) => hurts.push(p.amount));
    H.thaw();

    put(2.0);
    const hpIn0 = ctx.player.health, euIn0 = u.health, hurts0 = hurts.length;
    for (let i = 0; i < 90; i++) { put(2.0); await H.frames(1); }   // 1.5 s inside
    const inside = { playerLost: +(hpIn0 - ctx.player.health).toFixed(3), unitGained: +(u.health - euIn0).toFixed(3), ticks: hurts.length - hurts0 };

    put(6.0);
    const hpOut0 = ctx.player.health, euOut0 = u.health, hurts1 = hurts.length;
    for (let i = 0; i < 90; i++) { put(6.0); await H.frames(1); }   // 1.5 s outside
    const outside = { playerLost: +(hpOut0 - ctx.player.health).toFixed(3), unitGained: +(u.health - euOut0).toFixed(3), ticks: hurts.length - hurts1 };

    H.freeze();
    return { inside, outside, radius: 3.6 };
  });
  check('inside 3.6 m the siphon drains the player', (siphon.inside?.playerLost ?? 0) > 0, siphon.inside);
  check('and the unit heals off it', (siphon.inside?.unitGained ?? 0) > 0, siphon.inside);
  // `playerLost` goes *negative* out here, and that is the survivor's own
  // regeneration ticking back up — which is only visible because the siphon
  // stopped. The drain itself is `ticks`: zero `playerHurt` events and zero
  // healing on the unit is what "both stop" means.
  check('outside 3.6 m both stop',
    siphon.outside && siphon.outside.ticks === 0 && siphon.outside.unitGained === 0 && siphon.outside.playerLost <= 0,
    siphon.outside);

  // ---------------------------------------------------------------- arm 6
  // Kill it and watch the gauge walk back.
  await shot('05-gauge-before-kill');
  const refund = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const u = globalThis.__VOIDUNIT__;
    if (!u || !u.alive) return { skipped: 'no unit' };
    const worldBefore = ctx.corruption.world;
    const fillBefore = document.querySelector('.corruption-fill')?.style.width ?? null;
    const bandBefore = document.querySelector('.corruption-band')?.textContent ?? null;
    H.thaw();
    ctx.combat.applyDamage(u, u.health + 100, { source: ctx.player, type: 'probe', position: u.position });
    await H.frames(20);
    H.freeze();
    return {
      alive: u.alive,
      worldBefore: +worldBefore.toFixed(3),
      worldAfter: +ctx.corruption.world.toFixed(3),
      expected: +(worldBefore * 0.03).toFixed(3),
      fillBefore, fillAfter: document.querySelector('.corruption-fill')?.style.width ?? null,
      bandBefore, bandAfter: document.querySelector('.corruption-band')?.textContent ?? null,
    };
  });
  check('the kill bled World Corruption', refund.worldAfter < refund.worldBefore, refund);
  check('the refund is 3% of the world value', refund.expected != null
    && Math.abs((refund.worldBefore - refund.worldAfter) - refund.expected) < 0.05, refund);
  check('the HUD gauge visibly narrowed',
    refund.fillBefore !== refund.fillAfter, { before: refund.fillBefore, after: refund.fillAfter });
  await shot('06-gauge-after-kill');

  // ---------------------------------------------------------------- arm 7
  // Branding. The label the player can read, and the string they must not.
  const branding = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const mods = await Promise.all([import('/src/data/enemies.js'), import('/src/entities/EnemyMeshes.js')]);
    const stats = mods[0].ELITE_STATS.voidtouched;
    const mesh = mods[1].ELITE_VISUALS?.voidtouched ?? mods[1].ELITE?.voidtouched ?? null;
    // Drive the boss label through the real HUD path with a voidtouched boss.
    const THREE = G.THREE;
    const at = new THREE.Vector3(ctx.player.position.x + 6, ctx.player.position.y, ctx.player.position.z + 6);
    at.y = ctx.stage.sampleHeight(at.x, at.z);
    const card = ctx.director.enemies[0]?.def ?? null;
    let bossLabel = null;
    const boss = ctx.director.spawnOne(ctx, card ?? undefined, at, 'voidtouched');
    if (boss) {
      boss.isBoss = true;
      ctx.events.emit('bossSpawn', { enemy: boss });
      H.thaw();
      await H.frames(10);
      H.freeze();
      bossLabel = document.querySelector('.bossbar .boss-sub')?.textContent ?? null;
      if (!bossLabel) {
        const el = [...document.querySelectorAll('*')].find((n) => n.children.length === 0
          && /Teleporter Boss/i.test(n.textContent || ''));
        bossLabel = el?.textContent ?? null;
      }
      ctx.events.emit('bossDead', { enemy: boss });
      boss.alive = false; boss.health = 0;
    }
    return {
      statLabel: stats?.label ?? null,
      meshName: mesh?.name ?? null,
      bossLabel,
      domHasVoidtouched: /voidtouched/i.test(document.body.innerText || ''),
    };
  });
  check('ELITE_STATS label is Hollowed', branding.statLabel === 'Hollowed', branding.statLabel);
  check('the mesh family name is Hollowed', branding.meshName === 'Hollowed', branding.meshName);
  check('the boss bar reads Hollowed', branding.bossLabel != null && /Hollowed/.test(branding.bossLabel), branding.bossLabel);
  check('the word "voidtouched" never reaches the DOM', !branding.domHasVoidtouched, branding.domHasVoidtouched);

  // ---------------------------------------------------------------- arm 8
  // A new stage. Seeds, bank and pending surfacings are the stage's, not the
  // run's; nothing may carry over.
  const carry = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const d = ctx.director;
    const before = {
      seeds: d._voidSeeds.length, credits: +d.voidCredits.toFixed(2),
      pending: d._voidPending.length, corruptionSeeds: ctx.corruption.seeds.length,
    };
    const log = globalThis.__VOIDLOG__;
    const spawnsBefore = log.spawns.length;
    ctx.events.emit('stageStart', { index: 2, name: ctx.stage?.stageName ?? 'probe' });
    H.thaw();
    await H.frames(600);   // 10 s on the "new stage"
    H.freeze();
    return {
      before,
      after: {
        seeds: d._voidSeeds.length, credits: +d.voidCredits.toFixed(2),
        pending: d._voidPending.length,
      },
      newSpawns: log.spawns.length - spawnsBefore,
      world: +ctx.corruption.world.toFixed(2),
    };
  });
  check('a new stage wipes the void seeds', carry.after.seeds === 0, carry);
  check('a new stage wipes the bank and any pending surfacing',
    carry.after.credits === 0 && carry.after.pending === 0, carry.after);
  check('no carryover surfacings in 10 s of the new stage', carry.newSpawns === 0, carry.newSpawns);

  check('zero page errors across the session', pageErrors.length === 0, pageErrors);
  check('zero console errors across the session', consoleErrors.length === 0, consoleErrors.slice(0, 5));

  const failed = checks.filter((c) => !c.pass);
  const record = {
    seed: SEED, at: new Date().toISOString(),
    arms: { pristine, credit, tele, surfaced, siphon, refund, branding, carry },
    checks, pageErrors, consoleErrors,
    verdict: failed.length ? 'FAILED' : 'PASSED',
  };
  await writeFile(path.join(OUT, 'voidprobe.json'), JSON.stringify(record, null, 2));
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed — ${record.verdict}`);
  await browser.close();
  await server.close();
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('PROBE THREW', e);
  await writeFile(path.join(OUT, 'voidprobe.json'), JSON.stringify({
    seed: SEED, at: new Date().toISOString(), threw: String(e?.stack ?? e), checks, pageErrors, consoleErrors,
    verdict: 'THREW',
  }, null, 2));
  try { await page.screenshot({ path: path.join(OUT, 'zz-threw.png') }); } catch {}
  await browser.close();
  await server.close();
  process.exit(1);
}
