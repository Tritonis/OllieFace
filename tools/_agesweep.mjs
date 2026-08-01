/** Scratch: photograph 08-explosion at a range of effect ages. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

const OUT = process.argv[2];
const PORT = Number(process.argv[3] ?? 5222);
const AGES = process.argv.slice(4).map(Number);
await mkdir(OUT, { recursive: true });

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
  root: 'C:/Users/tpzap/source/repos/OllieFace',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit',
    '--force_high_performance_gpu', '--window-position=-2400,-2400', '--window-size=1600,900'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=3&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));

for (const a of AGES) {
  await page.evaluate((s) => globalThis.__HARNESS__.explosion({ blastSeconds: s }), a);
  await page.screenshot({ path: path.join(OUT, `age-${String(a).replace('.', '')}.png`) });
  const rep = await page.evaluate(() => globalThis.__GAME__.ctx.harness.subjects['08-explosion']);
  console.log(a, JSON.stringify(rep.checks.filter((c) => c.kind === 'pixels' || c.subject.includes('band'))
    .map((c) => ({ s: c.subject, px: c.px, carried: c.carriedPx, sep: c.sepP50, d: c.detail }))));
}
await browser.close();
await server.close();
