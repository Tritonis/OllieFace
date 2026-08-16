/**
 * Diagnoses the loot chain: are interactables placed, does killing pay gold,
 * can gold be spent, does a chest yield an orb, and does the orb reach the
 * inventory. Each link is checked separately so the break is localised rather
 * than inferred.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5203, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? [] : ['--window-position=-2400,-2400', '--window-size=1280,720'];
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', ...OFFSCREEN],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://127.0.0.1:5203/?seed=1337&quality=1&harness=1', { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__.gameplay());
await page.waitForTimeout(3000);

const out = await page.evaluate(async () => {
  const { ctx } = globalThis.__GAME__;
  const r = {};

  // --- what got placed on the stage at all ---
  const list = ctx.interactables?.list ?? [];
  const byType = {};
  for (const o of list) {
    const n = o.constructor?.name || 'unknown';
    byType[n] = (byType[n] || 0) + 1;
  }
  const p = ctx.player.position;
  r.interactables = {
    total: list.length,
    byType,
    nearestDist: list.length
      ? +Math.min(...list.map((o) => o.position?.distanceTo?.(p) ?? Infinity)).toFixed(1)
      : null,
    teleporter: (() => {
      const t = list.find((o) => /telep/i.test(o.constructor?.name || ''));
      return t ? { dist: +t.position.distanceTo(p).toFixed(1), state: t.state } : null;
    })(),
  };
  r.progression = {
    stageIndex: ctx.progression?.stageIndex,
    teleporterPosition: !!ctx.progression?.teleporterPosition,
  };

  // --- does killing an enemy pay out gold? ---
  const goldBefore = ctx.items?.gold ?? -1;
  let killEvents = 0;
  const off = ctx.events.on('kill', () => killEvents++);
  const e = ctx.director?.enemies?.[0];
  r.hadEnemyToKill = !!e;
  if (e) ctx.combat.applyDamage(e, 99999, { source: ctx.player, procCoefficient: 1 });
  await new Promise((res) => setTimeout(res, 400));
  off();
  r.goldOnKill = { before: goldBefore, after: ctx.items?.gold ?? -1, killEvents };

  // --- can we grant gold and does the HUD-facing value move? ---
  ctx.items?.addGold?.(500);
  r.afterAddGold = ctx.items?.gold ?? -1;

  // --- does a chest, when interacted with, produce an orb? ---
  const chest = list.find((o) => /chest/i.test(o.constructor?.name || ''));
  if (chest) {
    r.chest = { cost: chest.cost, available: chest.available?.(), prompt: chest.prompt?.() };
    // Orbs live in `interactables.orbs`, NOT `interactables.list` — `list` is
    // the focus/replication set. An earlier version of this probe filtered
    // `list` and so reported 0 orbs no matter what, which read as a broken
    // chest and sent an agent hunting a bug that did not exist.
    const orbsBefore = ctx.interactables.orbs?.length ?? -1;
    const opened = chest.interact?.();
    await new Promise((res) => setTimeout(res, 600));
    r.chest.opened = opened;
    r.chest.orbsBefore = orbsBefore;
    r.chest.orbsAfter = ctx.interactables.orbs?.length ?? -1;
    r.chest.usedAfter = chest.used;
  } else {
    r.chest = 'NO CHEST ON STAGE';
  }

  // --- does giving an item actually land in the inventory? ---
  const invBefore = ctx.items?.inventory?.()?.length ?? -1;
  ctx.items?.give?.('adrenal-syringe', 1);
  r.giveItem = { invBefore, invAfter: ctx.items?.inventory?.()?.length ?? -1 };

  // --- is the interaction input path wired? ---
  r.interactWiring = {
    playerHasInteractPressed: 'interactPressed' in (ctx.player || {}),
    requestInteract: typeof ctx.interactables?.requestInteract,
    focus: ctx.interactables?.focus?.constructor?.name ?? null,
  };
  r.authority = ctx.authority;
  r.frameErrors = ctx.frameErrors;
  r.lastFrameError = ctx.lastFrameError;
  return r;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
