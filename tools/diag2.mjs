/** Throwaway: per-enemy visible-pixel breakdown for 04-combat / 05-boss. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const W = 1600, H = 900;
const server = await createServer({ server: { port: 5202, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 120000, headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto('http://127.0.0.1:5202/?seed=1337&quality=3&harness=1', { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });

const seq = [
  () => page.evaluate(() => globalThis.__HARNESS__.artifacts()),
  () => page.evaluate(() => globalThis.__HARNESS__.vista()),
  () => page.evaluate(() => globalThis.__HARNESS__.gameplay()),
  () => page.evaluate(() => globalThis.__HARNESS__.survivors()),
  () => page.evaluate(() => globalThis.__HARNESS__.survivorSelect()),
  () => page.evaluate(() => globalThis.__HARNESS__.logbook()),
  ...[0, 1, 2, 3].map((i) => () => page.evaluate(
    ([n, last]) => globalThis.__HARNESS__.biomeVista({ index: n, restore: last }), [i, i === 3])),
  () => page.evaluate(() => globalThis.__HARNESS__.combat({ enemies: 24 })),
];
for (const f of seq) await f();

const dump = async (tag) => {
  const out = await page.evaluate(() => {
    const g = globalThis.__GAME__, ctx = g.ctx, THREE = g.THREE;
    const r = ctx.pipeline.renderer;
    const list = (ctx.director?.enemies ?? []).filter((e) => e.rig?.root);
    const w = 800, h = 450;
    const rt = new THREE.WebGLRenderTarget(w, h);
    const a = new Uint8Array(w * h * 4), b = new Uint8Array(w * h * 4);
    const prevShadow = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    const prevRT = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(ctx.scene, ctx.camera); r.readRenderTargetPixels(rt, 0, 0, w, h, a);
    const per = [];
    for (const e of list) {
      e.rig.root.visible = false;
      r.render(ctx.scene, ctx.camera); r.readRenderTargetPixels(rt, 0, 0, w, h, b);
      let n = 0, lumS = 0, lumB = 0;
      for (let i = 0; i < w * h; i++) {
        const j = i * 4;
        const d = Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]);
        if (d > 6) {
          n++;
          lumS += 0.2126 * a[j] + 0.7152 * a[j + 1] + 0.0722 * a[j + 2];
          lumB += 0.2126 * b[j] + 0.7152 * b[j + 1] + 0.0722 * b[j + 2];
        }
      }
      per.push({ id: e.def?.id, px: n, subjLum: n ? +(lumS / n).toFixed(1) : 0, bgLum: n ? +(lumB / n).toFixed(1) : 0 });
      e.rig.root.visible = true;
    }
    // enemies-only image: hide everything else
    const hidden = [];
    for (const c of ctx.scene.children) {
      if (list.some((e) => e.rig.root === c)) continue;
      if (c.visible) { hidden.push(c); c.visible = false; }
    }
    r.setClearColor(0x000000, 1); r.clear();
    r.render(ctx.scene, ctx.camera); r.readRenderTargetPixels(rt, 0, 0, w, h, b);
    for (const c of hidden) c.visible = true;
    r.setRenderTarget(prevRT); r.shadowMap.autoUpdate = prevShadow;
    rt.dispose();
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d'); const img = c2.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4;
        img.data[d] = b[s]; img.data[d + 1] = b[s + 1]; img.data[d + 2] = b[s + 2]; img.data[d + 3] = 255;
      }
    }
    c2.putImageData(img, 0, 0);
    return { per, dataUrl: cv.toDataURL('image/png') };
  });
  console.log(tag, JSON.stringify(out.per));
  await writeFile(`shots-diag/${tag}-only.png`, Buffer.from(out.dataUrl.split(',')[1], 'base64'));
};

await dump('combat');
await page.evaluate(() => globalThis.__HARNESS__.boss());
await dump('boss');

await browser.close();
await server.close();
