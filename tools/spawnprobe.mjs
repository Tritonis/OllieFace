/**
 * Diagnoses why the Director is not spawning during normal play.
 *
 * Runs a real session (menu dismissed, no harness force-spawns) and samples the
 * director's internal state over time, plus the success rate of the spawn-point
 * search — which is the step most likely to silently fail after terrain changes.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5202, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
// Headed for the real GPU path, parked off the visible desktop so probe runs
// never appear on the user's screen. Set CAPTURE_VISIBLE=1 to watch.
const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', '--window-size=1280,720'];

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto('http://127.0.0.1:5202/?seed=1337&quality=1&harness=1', { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });

// Normal play: dismiss the menu, then leave the game entirely alone.
await page.evaluate(() => globalThis.__HARNESS__.gameplay());
await page.waitForTimeout(20000);

const out = await page.evaluate(() => {
  const { ctx } = globalThis.__GAME__;
  const d = ctx.director;
  if (!d) return { error: 'no director' };

  // Exercise the spawn-point search directly to see whether it can find
  // anywhere valid at all.
  let sampleOk = 0, findOk = 0;
  for (let i = 0; i < 200; i++) {
    if (d.samplePoint?.(ctx, ctx.player.position)) sampleOk++;
    if (d.findSpawnPoint?.(ctx)) findOk++;
  }
  let walkOk = 0;
  for (let i = 0; i < 200; i++) if (ctx.stage.randomWalkablePoint?.(ctx.rng, {})) walkOk++;

  return {
    authority: ctx.authority,
    netRole: ctx.netRole,
    paused: ctx.paused,
    time: +ctx.time.toFixed(1),
    frameErrors: ctx.frameErrors,
    lastFrameError: ctx.lastFrameError,
    director: {
      enabled: d.enabled,
      credits: +(d.credits ?? -1).toFixed(1),
      creditRate: +(d.creditRate ?? -1).toFixed(3),
      difficultyCoefficient: +(d.difficultyCoefficient ?? -1).toFixed(3),
      spawnInterval: d.spawnInterval,
      spawnT: +(d.spawnT ?? -1).toFixed(2),
      card: d.card?.id ?? null,
      enemiesAlive: d.enemies?.length ?? -1,
      popCap: d.popCap,
      eventActive: d.eventActive,
    },
    spawnPointSearch: { samplePoint: `${sampleOk}/200`, findSpawnPoint: `${findOk}/200`, randomWalkablePoint: `${walkOk}/200` },
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
