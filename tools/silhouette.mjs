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
 * With `--enemies` the same page also renders every card the director can
 * spawn, grades the result against `READABILITY`, and exits non-zero if any
 * non-exempt check fails. That is the gate; the survivor pass above it is a
 * report.
 *
 *   node tools/silhouette.mjs [--seed 1337] [--enemies] [--json <path>]
 *                             [--range 40] [--software]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { measureMask, shapeIoU, gradeRoster } from './silhouette-metrics.mjs';

// Walk argv token by token, same shape as tools/capture.mjs's parser.
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const eq = tok.indexOf('=');
  if (eq !== -1) { args[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const SEED = Number(args.seed ?? 1337);
const ENEMIES = 'enemies' in args;
const JSON_OUT = typeof args.json === 'string' ? args.json : null;
const RANGE = Number(args.range ?? 40);   // metres, the spec's read distance

// SwiftShader instead of the real adapter. Slow — capture.mjs measures a full
// post-stack frame at ~0.1fps under it — but these are flat-shaded rigs
// against a white background with no post stack at all, so the cost lands in
// seconds rather than minutes. Kept as an explicit opt-in for exactly the
// same reason capture.mjs keeps it: a machine with no GPU session must be
// able to produce the evidence, and must not do it by accident on one that has.
const SOFTWARE = 'software' in args;

const W = 512, H = 768;
// One world box for all four rigs: 1.6 m wide by 2.4 m tall, centred at 1.15 m,
// so the feet sit just inside the bottom edge. The box aspect matches W/H
// exactly — square pixels, or every aspect ratio measured below is a lie.
const BOX = { halfW: 0.8, halfH: 1.2, cy: 1.15 };
// The enemy pass runs at the capture harness's own frame instead (tools/capture.mjs:31).
// `READABILITY.minPx40` is defined as a pixel count "at the capture harness's
// 1600x900 and the live camera's own FOV", so the 40 m read has to be taken on
// that frame or the floor is being compared against a different unit. It also
// makes the perspective camera's aspect the game's 16:9 rather than the
// survivor box's portrait 2:3. Shape comparisons are unaffected either way:
// `sig` is bbox-normalised to 64x64, so a survivor mask taken at 512x768 and an
// enemy mask taken at 1600x900 are still directly comparable.
const EW = 1600, EH = 900;

const server = await createServer({ server: { port: 5201, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl']
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
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

const roster = ENEMIES ? await page.evaluate(async ([w, h, range]) => {
  const THREE = globalThis.__GAME__.THREE;
  const ctx = globalThis.__GAME__.ctx;
  const renderer = ctx.pipeline.renderer;
  const { SPAWN_CARDS, BOSS_CARDS } = await import('/src/data/enemies.js');
  const { acquireRig, releaseRig, makeAnim, ELITE } = await import('/src/entities/EnemyMeshes.js');

  const cards = [...SPAWN_CARDS, ...BOSS_CARDS];
  // Elite reads are graded on one representative per tier rather than on the
  // whole cross product: the affix decoration is built from the same ELITE
  // table for every host, so nineteen hosts times six affixes measures the
  // table nineteen times and the roster once.
  const ELITE_HOSTS = ['scarab', 'sentinel', 'hulk'];
  const AFFIXES = Object.keys(ELITE);

  // One box for every unit, sized to the tallest thing in the roster so the
  // masks come back at true relative scale — the same contract the survivor
  // box has, at monster scale. The width is the taller of the frame-aspect
  // solve and the widest card's own `radius` with margin, because a maw is
  // wider than it is tall and a box solved on height alone clips it.
  const maxH = Math.max(...cards.map((c) => c.height));
  const maxR = Math.max(...cards.map((c) => c.radius));
  const halfH = maxH * 0.62;
  const halfW = halfH * (w / h);
  const box = { halfW: Math.max(halfW, maxR * 1.4), halfH, cy: maxH * 0.5 };

  const rt = new THREE.WebGLRenderTarget(w, h);
  const buf = new Uint8Array(w * h * 4);
  const ortho = new THREE.OrthographicCamera(-box.halfW, box.halfW, box.halfH, -box.halfH, 0.1, 200);
  ortho.position.set(0, box.cy, 60);
  ortho.lookAt(0, box.cy, 0);

  // The 40 m read. FOV and buffer size come off the live camera and the live
  // pipeline rather than being written down here: the question the spec asks
  // is whether the unit reads at 40 m *in this game*, and a hardcoded lens
  // would answer it about a different one.
  const persp = new THREE.PerspectiveCamera(ctx.camera.fov, w / h, 0.1, 400);
  persp.position.set(0, 1.6, range);
  persp.lookAt(0, 1.2, 0);

  // 1600x900 is 180,000 packed bytes, which is well past the argument limit
  // `String.fromCharCode(...bits)` would spread it through, so the string is
  // built in chunks.
  const b64 = (bits) => {
    let s = '';
    for (let i = 0; i < bits.length; i += 8192) s += String.fromCharCode(...bits.subarray(i, i + 8192));
    return btoa(s);
  };

  const pack = () => {
    const bits = new Uint8Array(Math.ceil(w * h / 8));
    let lit = 0;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;       // readRenderTargetPixels is bottom-up
      for (let x = 0; x < w; x++) {
        if (buf[(src + x) * 4] < 128) {
          const i = y * w + x;
          bits[i >> 3] |= 1 << (i & 7);
          lit++;
        }
      }
    }
    return { b64: b64(bits), lit };
  };

  // Colour readback for the affix chroma check: mean per-channel value over
  // the pixels that are not background. A silhouette cannot see a tint, and
  // the tint is half of what an affix is.
  const meanColour = () => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (buf[o] > 246 && buf[o + 1] > 246 && buf[o + 2] > 246) continue;  // background
      r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : [0, 0, 0];
  };

  const shoot = (cam, scene) => {
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(null);
  };

  /** One rig, posed at its idle, in a scene of its own. */
  const stand = (card, affix, silhouette) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    if (silhouette) scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    else {
      // Flat, frontal, and identical for every unit: the chroma read must
      // measure the affix's tint, not where the sun happens to be.
      scene.add(new THREE.AmbientLight(0xffffff, 1.6));
      const key = new THREE.DirectionalLight(0xffffff, 1.4);
      key.position.set(0.4, 1, 1);
      scene.add(key);
    }
    const rig = acquireRig(card.meshFactory);
    rig.setAffix(affix || null);
    const anim = makeAnim();
    // No `anim.state` assignment: nothing in src/entities/EnemyMeshes.js reads
    // `.state` at all (the animators branch on `speed`, `windup`, `swing` and
    // `death`), so a fresh `makeAnim()` at zero speed *is* the idle pose.
    // Same settle the survivor pass uses: 150 steps of 1/60 lands every rig
    // at the same phase of its own idle, which is what makes two runs of this
    // tool comparable at all.
    for (let i = 0; i < 150; i++) { anim.t += 1 / 60; rig.animate(rig, anim, 1 / 60); }
    rig.root.position.set(0, 0, 0);
    rig.root.rotation.y = 0.24;         // the roster shot's off-axis idle
    scene.add(rig.root);
    return { scene, rig };
  };

  const units = [], elites = [];
  for (const card of cards) {
    const s = stand(card, null, true);
    shoot(ortho, s.scene);
    const o = pack();
    shoot(persp, s.scene);
    const p = pack();
    units.push({ id: card.id, name: card.name, tier: card.tier, height: card.height,
                 mask: o.b64, px40: p.lit });
    releaseRig(s.rig);
  }
  for (const id of ELITE_HOSTS) {
    const card = cards.find((c) => c.id === id);
    if (!card) continue;
    const plainS = stand(card, null, true);
    shoot(ortho, plainS.scene);
    const plainMask = pack().b64;
    releaseRig(plainS.rig);
    const plainC = stand(card, null, false);
    shoot(persp, plainC.scene);
    const plainCol = meanColour();
    releaseRig(plainC.rig);
    for (const affix of AFFIXES) {
      const eS = stand(card, affix, true);
      shoot(ortho, eS.scene);
      const eMask = pack().b64;
      releaseRig(eS.rig);
      const eC = stand(card, affix, false);
      shoot(persp, eC.scene);
      const eCol = meanColour();
      releaseRig(eC.rig);
      elites.push({ id, affix, plainMask, eliteMask: eMask, plainCol, eliteCol: eCol });
    }
  }
  rt.dispose();
  return { units, elites, fov: ctx.camera.fov };
}, [EW, EH, RANGE]) : null;

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

// --- the gate ----------------------------------------------------------------

if (roster) {
  const { execSync } = await import('node:child_process');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');

  const measured = roster.units.map((u) => {
    const m = measureMask(u.mask, EW, EH);
    return { ...u, m, holesFrac: m.bw ? +(m.holes / (m.bw * m.bh)).toFixed(4) : 0 };
  });

  const familyPairs = [];
  for (let i = 0; i < measured.length; i++) for (let j = i + 1; j < measured.length; j++) {
    familyPairs.push({ a: measured[i].id, b: measured[j].id,
                       iou: +shapeIoU(measured[i].m.sig, measured[j].m.sig).toFixed(4) });
  }
  // The survivor masks are already in `M` from the pass above — friend/foe is
  // the cross product of the two rosters, which is the only place in this tool
  // where a monster and a survivor are compared at all.
  const foeFriendPairs = [];
  for (const e of measured) for (const sid of Object.keys(M)) {
    foeFriendPairs.push({ a: e.id, b: sid, iou: +shapeIoU(e.m.sig, M[sid].sig).toFixed(4) });
  }

  const tierMedianPx = {};
  for (const t of [...new Set(measured.map((u) => u.tier))].sort((a, b) => a - b)) {
    const px = measured.filter((u) => u.tier === t).map((u) => u.px40).sort((a, b) => a - b);
    tierMedianPx[t] = px[(px.length - 1) >> 1];
  }

  const elites = roster.elites.map((e) => {
    const a = measureMask(e.plainMask, EW, EH), b = measureMask(e.eliteMask, EW, EH);
    const chroma = Math.max(
      Math.abs(e.plainCol[0] - e.eliteCol[0]),
      Math.abs(e.plainCol[1] - e.eliteCol[1]),
      Math.abs(e.plainCol[2] - e.eliteCol[2]),
    );
    return { id: e.id, affix: e.affix,
             delta: +(1 - shapeIoU(a.sig, b.sig)).toFixed(4), chroma: +chroma.toFixed(4) };
  });

  const record = {
    tool: 'tools/silhouette.mjs --enemies',
    commit: execSync('git rev-parse HEAD').toString().trim(),
    seed: SEED, range: RANGE, width: EW, height: EH, fov: roster.fov,
    // Which adapter drew this. Two records produced under different renderers
    // are not directly comparable, and a reader diffing them needs to know
    // that before concluding the roster moved.
    renderer: SOFTWARE ? 'swiftshader' : 'd3d11',
    units: measured.map(({ id, name, tier, height, px40, holesFrac, m }) => ({
      id, name, tier, height, px40, holesFrac,
      bbox: `${m.bw}x${m.bh}`, fill: m.fill, aspect: m.aspect,
      // Width, fill *and* runs, not width alone. `runs` is the direct measure
      // of daylight through the outline — a band at 1.00 run is a solid bar,
      // arms welded to a torso or legs fused into one column — and it is the
      // metric that answers whether `minHoles` (which only sees *enclosed*
      // space, and reads zero across most of this roster) is measuring the
      // right thing. Recording width only meant the question the exemption
      // note raises could not be answered from the committed record, and
      // recovering the answer cost a whole GPU pass.
      bands: m.bands.map((b) => ({ w: +b.w.toFixed(3), fill: +b.fill.toFixed(3), runs: +b.runs.toFixed(3) })),
    })),
    familyPairs, foeFriendPairs, tierMedianPx, elites,
  };
  const graded = gradeRoster(record);
  record.ok = graded.ok;
  record.checks = graded.checks;

  console.log('\n=== READABILITY GATE ===');
  console.log('id            tier  px@40m  holes%  worst-family-IoU');
  for (const u of measured) {
    const worst = familyPairs.filter((p) => p.a === u.id || p.b === u.id)
      .reduce((w, p) => (p.iou > w.iou ? p : w), { iou: 0, a: '', b: '' });
    console.log(`${u.id.padEnd(13)} ${String(u.tier).padStart(2)}   ${String(u.px40).padStart(6)}`
      + `  ${(u.holesFrac * 100).toFixed(2).padStart(6)}  ${worst.iou.toFixed(3)} (${worst.a}/${worst.b})`);
  }
  const bad = graded.checks.filter((c) => !c.ok);
  console.log(`\n${graded.checks.length - bad.length}/${graded.checks.length} checks passed`);
  for (const c of bad) {
    console.log(`  FAIL ${c.kind} ${c.id}: ${c.value} vs `
      + (c.floor !== undefined ? `floor ${c.floor}` : `ceiling ${c.ceiling}`));
  }
  for (const c of graded.checks.filter((c2) => c2.exempt)) {
    console.log(`  EXEMPT ${c.kind} ${c.id}: ${c.value}`);
  }

  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(record, null, 2));
    console.log(`\nrecord -> ${JSON_OUT}`);
  }
  // The exit code is the gate. A tool that prints a failure and exits 0 is a
  // report, and this slice's job is to turn the report into a gate.
  process.exit(graded.ok ? 0 : 1);
}
