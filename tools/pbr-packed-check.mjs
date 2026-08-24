/**
 * EVIDENCE TOOLING (#109) — kept after adoption, along with
 * `tools/capture-arteval.mjs` and `tools/shot-diff.mjs`. The packaging seam it
 * was written against is gone; the question it answers is not, because no unit
 * test can see the packed artifact and a build that ships the maps but cannot
 * serve them looks identical from the filesystem.
 *
 * Boots nothing itself: it attaches to an ALREADY-RUNNING packed shell over
 * CDP and asks the renderer the question the packer cannot answer.
 *
 *   "dist-desktop/win-unpacked/TELLURIC VOID.exe" --remote-debugging-port=9222
 *   node tools/pbr-packed-check.mjs [--port 9222]
 *
 * `tools/capture.mjs` cannot drive the packed app — it owns its own vite server
 * and its own Chromium — so this is the substitute. A pack that carries the
 * files but cannot serve them (wrong resources root, a traversal refusal, a
 * protocol handler that never sees the prefix) is indistinguishable from a good
 * one if you only look at the filesystem.
 *
 * Two measurements, and the second is the verdict:
 *
 *  - a direct `fetch` of one map through the app:// handler, which proves the
 *    packaging seam resolves and serves;
 *  - a walk of the live scene graph for a 4096-wide texture actually bound to a
 *    material, which proves the renderer got as far as *using* them. The
 *    obvious cheaper metric — `performance.getEntriesByType('resource')` — is
 *    not usable here and the reason is worth writing down: Chromium does not
 *    record resource timings for a custom scheme, so under app:// it reports
 *    zero fetches for a run that fetched 122 MiB. Counting it would have
 *    reported this working seam as broken.
 */
import { chromium } from 'playwright';
import { argValue } from './lib/parse-args.mjs';

const argv = process.argv;
let portVal;
try { portVal = argValue(argv, '--port'); }
catch (e) { console.error(`pbr-packed-check: ${e.message}`); process.exit(64); }
const port = Number(portVal ?? 9222);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? await ctx.waitForEvent('page');
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  page:', m.type(), m.text()); });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const url = 'game-assets/terrain/worn_rock_natural_01/worn_rock_natural_01_diff_4k.jpg';
  const res = { href: location.href, resolved: new URL(url, location.href).href };
  try {
    const r = await fetch(res.resolved);
    res.status = r.status;
    res.bytes = (await r.arrayBuffer()).byteLength;
  } catch (e) { res.fetchError = String(e); }

  // The scene walk. 4096 is the tell: every procedural DataTexture in
  // Materials.js is built at a far smaller N, so a 4K image on a material is
  // necessarily one of the photographed maps.
  const big = new Set();
  const slots = ['map', 'normalMap', 'roughnessMap', 'aoMap'];
  globalThis.__GAME__.ctx.scene?.traverse?.((o) => {
    for (const m of [].concat(o.material ?? [])) {
      for (const s of slots) {
        const t = m?.[s];
        const w = t?.image?.width ?? 0;
        if (w >= 4096) big.add(`${s}@${w}`);
      }
    }
  });
  res.boundBigMaps = [...big].sort();
  return res;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
const ok = out.status === 200 && out.bytes > 0 && out.boundBigMaps.length > 0;
console.log(ok ? 'PASS  the packed shell serves the staged set and the renderer has it bound'
               : 'FAIL  the packed shell did not end up rendering with the staged set');
process.exit(ok ? 0 : 1);
