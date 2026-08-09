/**
 * Silhouette threshold test for the survivor roster (rubric axis 4).
 *
 * Renders every rig in `CharacterMesh` alone, in its idle pose, flat black on
 * white, through one shared orthographic box — so the four masks come back at
 * true relative scale and can be compared as pure shapes with no lighting,
 * palette, terrain or staging in the way.
 *
 * This exists because "they look different to me" is not a measurement. The
 * question axis 4 asks is whether the shapes survive being flattened, and the
 * only honest way to answer it is to flatten them and measure.
 *
 *   node tools/silhouette.mjs [--seed 1337]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { measureMask, shapeIoU } from './silhouette-metrics.mjs';

const SEED = 1337;
const W = 512, H = 768;
// One world box for all four rigs: 1.6 m wide by 2.4 m tall, centred at 1.15 m,
// so the feet sit just inside the bottom edge. The box aspect matches W/H
// exactly — square pixels, or every aspect ratio measured below is a lie.
const BOX = { halfW: 0.8, halfH: 1.2, cy: 1.15 };

const server = await createServer({ server: { port: 5201, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', '--window-size=800,600'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(`http://127.0.0.1:5201/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });

const masks = await page.evaluate(async ([w, h, box]) => {
  const THREE = globalThis.__GAME__.THREE;
  const ctx = globalThis.__GAME__.ctx;
  globalThis.__GAME__.engine.stop();
  const renderer = ctx.pipeline.renderer;
  const { CharacterMesh } = await import('/src/entities/CharacterMesh.js');
  const { SURVIVORS } = await import('/src/data/survivors.js');

  const rt = new THREE.WebGLRenderTarget(w, h);
  const cam = new THREE.OrthographicCamera(-box.halfW, box.halfW, box.halfH, -box.halfH, 0.1, 40);
  cam.position.set(0, box.cy, 12);
  cam.lookAt(0, box.cy, 0);

  const out = {};
  const buf = new Uint8Array(w * h * 4);
  for (const card of SURVIVORS) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const mesh = new CharacterMesh(card.meshKey);
    // The contact decal is a ground plane, not part of the body: under an
    // override material it would stamp a black disc over the feet.
    mesh.blob.visible = false;
    // Same idle the roster shot photographs: facing the lens, 0.24 rad off-axis.
    const state = {
      velocity: new THREE.Vector3(), grounded: true, aimYaw: 0.24, aimPitch: -0.04,
      dashT: 0, sprint: false, moveSpeed: 7, dead: false,
    };
    mesh.bodyYaw = 0.24;
    for (let i = 0; i < 150; i++) mesh.update(1 / 60, state);
    mesh.blob.visible = false;
    scene.add(mesh.group);

    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(null);

    // Pack to one bit per pixel, top row first (readRenderTargetPixels is
    // bottom-up), so the node side gets a plain row-major mask.
    const bits = new Uint8Array(Math.ceil(w * h / 8));
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        if (buf[(src + x) * 4] < 128) {
          const i = y * w + x;
          bits[i >> 3] |= 1 << (i & 7);
        }
      }
    }
    out[card.id] = btoa(String.fromCharCode(...bits));
  }
  rt.dispose();
  return out;
}, [W, H, BOX]);

await browser.close();
await server.close();

// --- measurement -------------------------------------------------------------

const M = {};
for (const [id, b64] of Object.entries(masks)) M[id] = measureMask(b64, W, H);

const ids = Object.keys(M);
console.log('\n=== SILHOUETTE MASKS (shared ortho box, true relative scale) ===');
console.log('id       bbox      area   fill  aspect  cx     cy     holes%');
for (const id of ids) {
  const m = M[id];
  const bbox = `${m.bw}x${m.bh}`;
  console.log(`${id.padEnd(8)} ${bbox.padEnd(9)} ${String(m.area).padStart(6)} ${m.fill.toFixed(3)}  ${m.aspect.toFixed(3)}   ${m.cx.toFixed(3)}  ${m.cy.toFixed(3)}  ${(m.holes / (m.bw * m.bh) * 100).toFixed(2)}`);
}

console.log('\n=== WIDTH PROFILE (crown -> feet, fraction of own bbox width) ===');
for (const id of ids) console.log(`${id.padEnd(8)} ${M[id].bands.map((b) => b.w.toFixed(2)).join(' ')}`);
console.log('\n=== SEGMENT PROFILE (crown -> feet, mean solid runs per scanline) ===');
for (const id of ids) console.log(`${id.padEnd(8)} ${M[id].bands.map((b) => b.runs.toFixed(2)).join(' ')}`);
console.log('\n=== FILL PROFILE (crown -> feet, fraction of bbox-width row filled) ===');
for (const id of ids) console.log(`${id.padEnd(8)} ${M[id].bands.map((b) => b.fill.toFixed(2)).join(' ')}`);

console.log('\n=== PAIRWISE SHAPE IoU (bbox-normalised 64x64 — scale removed) ===');
let worst = 0, worstPair = '';
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const iou = shapeIoU(M[ids[i]].sig, M[ids[j]].sig);
  if (iou > worst) { worst = iou; worstPair = `${ids[i]}/${ids[j]}`; }
  console.log(`${ids[i].padEnd(8)} vs ${ids[j].padEnd(8)} IoU ${iou.toFixed(3)}`);
}
console.log(`\nWORST PAIR: ${worstPair} at IoU ${worst.toFixed(3)}`);

// ASCII contact sheet — cheap, and it catches "the numbers moved but the shape
// is still a lump" in a way a table cannot.
const ROWS = 46, COLS = 30;
console.log(`\n=== CONTACT SHEET (${ROWS} rows, shared ortho box) ===`);
const cols = ids.map((id) => {
  const bits = Buffer.from(masks[id], 'base64');
  const get = (x, y) => (bits[(y * W + x) >> 3] >> ((y * W + x) & 7)) & 1;
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    let s = '';
    for (let c = 0; c < COLS; c++) {
      let hit = 0;
      for (let y = Math.floor(r * H / ROWS); y < Math.floor((r + 1) * H / ROWS) && !hit; y += 2)
        for (let x = Math.floor(c * W / COLS); x < Math.floor((c + 1) * W / COLS) && !hit; x += 2)
          hit = get(x, y);
      s += hit ? '#' : '.';
    }
    rows.push(s);
  }
  return rows;
});
console.log(ids.map((id) => id.toUpperCase().padEnd(COLS)).join(' '));
for (let r = 0; r < ROWS; r++) console.log(cols.map((c) => c[r]).join(' '));
