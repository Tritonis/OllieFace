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
for (const [id, b64] of Object.entries(masks)) {
  const bits = Buffer.from(b64, 'base64');
  const get = (x, y) => (bits[(y * W + x) >> 3] >> ((y * W + x) & 7)) & 1;
  let x0 = W, x1 = -1, y0 = H, y1 = -1, area = 0, sx = 0, sy = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!get(x, y)) continue;
    area++; sx += x; sy += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  // Width profile in ten bands from the crown down, as a fraction of the
  // widest band. This is the shape of the shape: an hourglass, a top-heavy
  // triangle and a needle read as three different curves here even when their
  // bounding boxes agree.
  const bands = [];
  for (let b = 0; b < 10; b++) {
    const ya = y0 + Math.floor(bh * b / 10), yb = y0 + Math.floor(bh * (b + 1) / 10);
    let lo = W, hi = -1, fill = 0, runs = 0, scan = 0;
    for (let y = ya; y < yb; y++) {
      scan++;
      let prev = 0;
      for (let x = x0; x <= x1; x++) {
        const v = get(x, y);
        if (v && !prev) runs++;
        prev = v;
        if (!v) continue;
        fill++;
        if (x < lo) lo = x; if (x > hi) hi = x;
      }
    }
    // `runs` is the average number of separate solid segments per scanline —
    // the direct measure of daylight through the outline. A band at 1.00 is a
    // solid bar: arms welded to the torso, or legs fused into one column.
    bands.push({ w: hi < 0 ? 0 : (hi - lo + 1) / bw, fill: fill / ((yb - ya) * bw || 1), runs: runs / (scan || 1) });
  }

  // Negative space: background pixels inside the bbox that the border flood
  // cannot reach. Zero of these is the "solid lump" failure — daylight through
  // the outline is what separates a figure from a blob.
  const seen = new Uint8Array(bw * bh);
  const stack = [];
  for (let x = 0; x < bw; x++) { stack.push([x, 0], [x, bh - 1]); }
  for (let y = 0; y < bh; y++) { stack.push([0, y], [bw - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
    if (seen[y * bw + x] || get(x0 + x, y0 + y)) continue;
    seen[y * bw + x] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  let holes = 0;
  for (let i = 0; i < bw * bh; i++) if (!seen[i] && !get(x0 + (i % bw), y0 + ((i / bw) | 0))) holes++;

  // 64x64 shape signature, bbox-normalised — scale is removed on purpose so
  // this answers "is it the same shape at a different size", which is exactly
  // what the roster was failing.
  const sig = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    sig[y * 64 + x] = get(x0 + Math.floor(x * bw / 64), y0 + Math.floor(y * bh / 64));
  }

  M[id] = {
    bbox: `${bw}x${bh}`, area, fill: +(area / (bw * bh)).toFixed(3),
    aspect: +(bw / bh).toFixed(3),
    cx: +(((sx / area) - x0) / bw).toFixed(3), cy: +(((sy / area) - y0) / bh).toFixed(3),
    holes: +(holes / (bw * bh)).toFixed(4),
    bands, sig,
  };
}

const ids = Object.keys(M);
console.log('\n=== SILHOUETTE MASKS (shared ortho box, true relative scale) ===');
console.log('id       bbox      area   fill  aspect  cx     cy     holes%');
for (const id of ids) {
  const m = M[id];
  console.log(`${id.padEnd(8)} ${m.bbox.padEnd(9)} ${String(m.area).padStart(6)} ${m.fill.toFixed(3)}  ${m.aspect.toFixed(3)}   ${m.cx.toFixed(3)}  ${m.cy.toFixed(3)}  ${(m.holes * 100).toFixed(2)}`);
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
  const a = M[ids[i]].sig, b = M[ids[j]].sig;
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] & b[k]) inter++; if (a[k] | b[k]) uni++; }
  const iou = inter / uni;
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
