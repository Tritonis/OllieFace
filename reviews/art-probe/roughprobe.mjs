/**
 * Scratch measurement rig for the PMREM probe fix (art-detail Task 1).
 *
 * Deliberately NOT in `tools/`: it is evidence, not a gate, and it lives beside
 * the numbers it produced so that every figure quoted for this task names an
 * on-disk file a reviewer can regenerate. `tools/` was also out of scope for
 * the task that wrote it.
 *
 * What it measures: the roughness ladder's ability to discriminate, away from
 * the sun's reflection. A pure-metal plate (metalness 1, white) lit by nothing
 * but the environment shows exactly the prefiltered probe and nothing else, so
 * the difference between a roughness-0.12 plate and a roughness-0.90 plate IS
 * the ladder's discriminating power. Plates are oriented so their mirror
 * direction points at a chosen target direction; every target is checked to be
 * well away from the sun and the angle is recorded.
 *
 * Two arms, same boot, same frame -- which removes the shutter-phase and
 * boot-to-boot noise the harness is known for:
 *   sky   -- `Environment._bakeEnvironment()`, the sky sphere alone (pre-fix)
 *   scene -- `Environment.bakeProbe()`, the real stage (post-fix)
 *
 * Two places: the world basin, and the Hollow Market realm -- the realm being
 * the path that had no `bakeProbe` call at all before this task.
 *
 *   node reviews/art-probe/roughprobe.mjs [--out reviews/art-probe] [--port 5231]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const OUT = path.resolve(args.out ?? path.join('reviews', 'art-probe'));
const PORT = Number(args.port ?? 5231);
const SEED = Number(args.seed ?? 1337);
const log = (m) => console.log(`[roughprobe] ${m}`);

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
log(`vite on ${PORT}`);

const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
         '--disable-frame-rate-limit', '--force_high_performance_gpu',
         '--window-position=-2400,-2400', '--window-size=1280,720'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}`));

await mkdir(OUT, { recursive: true });
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`,
                { waitUntil: 'load' });
const ready = await page.waitForFunction(
  () => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__?.realmMarket != null,
  null, { timeout: 60000 }).then(() => true).catch(() => false);
if (!ready) { console.error('FAILED TO BOOT', errors); await browser.close(); await server.close(); process.exit(1); }
await page.evaluate(() => globalThis.__HARNESS__?.pinClock?.(1 / 60));
log('booted');

// ---------------------------------------------------------------- in-page rig
await page.evaluate(() => {
  const { THREE, ctx } = globalThis.__GAME__;
  const S = 160;
  const rig = {};
  globalThis.__RP__ = rig;

  const renderer = ctx.pipeline.renderer;
  const scene = new THREE.Scene();          // no lights: the probe is the only source
  const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  const V = new THREE.Vector3(0, 0, -1);    // camera forward, world space

  const geo = new THREE.PlaneGeometry(4, 4);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, metalness: 1.0, roughness: 0.12, envMapIntensity: 1.0,
  });
  const plate = new THREE.Mesh(geo, mat);
  plate.position.set(0, 0, -3);
  scene.add(plate);

  const rt = new THREE.WebGLRenderTarget(S, S, { colorSpace: THREE.SRGBColorSpace });
  const buf = new Uint8Array(S * S * 4);

  /** Aim the plate so its mirror direction is `t`. n = normalize(t - v). */
  const aim = (t) => {
    const n = t.clone().sub(V).normalize();
    plate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  };

  const shoot = (roughness) => {
    mat.roughness = roughness;
    mat.needsUpdate = true;
    scene.environment = ctx.scene.environment;
    scene.environmentIntensity = ctx.scene.environmentIntensity;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
    renderer.setRenderTarget(prevRT);
    return Uint8Array.from(buf);
  };

  const luma = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

  const sd = (px, mean) => {
    let s = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { const d = luma(px, i) - mean; s += d * d; n++; }
    return Math.sqrt(s / n);
  };

  /** Mean |Laplacian| over the plate, ignoring a 6px border. Detail energy. */
  const detail = (px) => {
    const L = (x, y) => luma(px, (y * S + x) * 4);
    let s = 0, n = 0;
    for (let y = 6; y < S - 6; y++) {
      for (let x = 6; x < S - 6; x++) {
        s += Math.abs(4 * L(x, y) - L(x - 1, y) - L(x + 1, y) - L(x, y - 1) - L(x, y + 1));
        n++;
      }
    }
    return s / n;
  };

  rig.targets = () => {
    const sun = ctx.environment.sunDir.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const horiz = new THREE.Vector3(-sun.x, 0, -sun.z).normalize();      // anti-sun, horizontal
    const perp = new THREE.Vector3().crossVectors(sun, up).normalize();  // 90 deg off the sun
    const below = horiz.clone().multiplyScalar(Math.cos(Math.PI / 6))
      .add(up.clone().multiplyScalar(-Math.sin(Math.PI / 6))).normalize();
    return [
      { name: 'floor', dir: new THREE.Vector3(0, -1, 0) },
      { name: 'antisun-horizon', dir: horiz },
      { name: 'perp-horizon', dir: perp },
      { name: 'antisun-below', dir: below },
    ].map((t) => ({ ...t, sunAngleDeg: THREE.MathUtils.radToDeg(t.dir.angleTo(sun)) }));
  };

  const toPng = (px) => {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    // readRenderTargetPixels is bottom-up; flip for a human-readable PNG.
    for (let y = 0; y < S; y++) {
      const src = (S - 1 - y) * S * 4, dst = y * S * 4;
      for (let x = 0; x < S * 4; x++) img.data[dst + x] = px[src + x];
    }
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  };

  /** One arm: rebake the probe the requested way, then measure every target. */
  rig.arm = ({ mode, y, x, z }) => {
    const env = ctx.environment;
    if (mode === 'sky') env._bakeEnvironment();
    else env.bakeProbe(y, x, z);

    const out = [];
    for (const t of rig.targets()) {
      aim(t.dir);
      const lo = shoot(0.12);
      const hi = shoot(0.90);
      let sumL = 0, sumH = 0, sumSq = 0, n = 0;
      for (let i = 0; i < lo.length; i += 4) {
        const a = luma(lo, i), b = luma(hi, i);
        sumL += a; sumH += b; sumSq += (a - b) * (a - b); n++;
      }
      const meanLo = sumL / n, meanHi = sumH / n;
      const rmse = Math.sqrt(sumSq / n);
      out.push({
        target: t.name,
        sunAngleDeg: +t.sunAngleDeg.toFixed(1),
        meanLuma012: +meanLo.toFixed(2),
        meanLuma090: +meanHi.toFixed(2),
        rmse: +rmse.toFixed(2),
        // The load-bearing pair. A mean shift between two rungs happens even on
        // a featureless gradient, purely because a wider cone averages more of
        // it -- that reads as "darker material", not as "glossy material". What
        // reads as gloss is *detail that blurs*: structure the sharp rung
        // resolves and the blunt rung does not. `detail` is mean |Laplacian|;
        // `detailRatio` above 1 means the ladder is discriminating something.
        detail012: +detail(lo).toFixed(3),
        detail090: +detail(hi).toFixed(3),
        detailRatio: +(detail(lo) / Math.max(1e-4, detail(hi))).toFixed(2),
        sd012: +sd(lo, meanLo).toFixed(2),
        sd090: +sd(hi, meanHi).toFixed(2),
        png012: toPng(lo),
        png090: toPng(hi),
      });
    }
    return out;
  };

  /** Wall-clock cost of a bake, with the GPU pipeline flushed either side. */
  rig.time = (fn, reps = 5) => {
    const gl = ctx.pipeline.renderer.getContext();
    const env = ctx.environment;
    const ms = [];
    for (let i = 0; i < reps; i++) {
      gl.finish();
      const t0 = performance.now();
      fn(env);
      gl.finish();
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    return { median: +ms[ms.length >> 1].toFixed(2), min: +ms[0].toFixed(2), max: +ms[ms.length - 1].toFixed(2) };
  };

  rig.costs = () => {
    const ctxx = globalThis.__GAME__.ctx;
    const y = (ctxx.stage?.terrain?.sampleHeight?.(0, 0) ?? 0) + 12;
    return {
      skyOnlyBake: rig.time((env) => env._bakeEnvironment()),
      sceneBake: rig.time((env) => env.bakeProbe(y)),
      stageBuild: rig.time(() => ctxx.stage.build(1), 3),
    };
  };
});

// -------------------------------------------------------------------- measure
const report = { seed: SEED, generatedAt: new Date().toISOString(), places: {}, costs: {} };

const savePngs = async (place, mode, rows) => {
  for (const r of rows) {
    for (const rung of ['012', '090']) {
      const f = path.join(OUT, `${place}-${mode}-${r.target}-r${rung}.png`);
      await writeFile(f, Buffer.from(r[`png${rung}`], 'base64'));
    }
    delete r.png012; delete r.png090;
  }
};

for (const place of ['world', 'realm-market']) {
  if (place === 'realm-market') {
    log('entering the Hollow Market...');
    await page.evaluate(() => globalThis.__HARNESS__.realmMarket());
    await page.waitForTimeout(1200);
  }
  const centre = await page.evaluate(() => {
    const c = globalThis.__GAME__.ctx;
    const s = c.stage;
    return s?.isRealm
      ? { y: 12, x: s.origin.x, z: s.origin.z, realm: true }
      : { y: (s?.terrain?.sampleHeight?.(0, 0) ?? 0) + 12, x: 0, z: 0, realm: false };
  });
  report.places[place] = { probeCentre: centre, arms: {} };
  for (const mode of ['sky', 'scene']) {
    log(`${place} / ${mode}`);
    const rows = await page.evaluate((a) => globalThis.__RP__.arm(a), { mode, ...centre });
    await savePngs(place, mode, rows);
    report.places[place].arms[mode] = rows;
  }
  // The cost of the bake measured where it actually runs. This is the whole of
  // what the change adds on the realm path: one `bakeProbe` per transition.
  report.costs[`${place}-sceneBake`] = await page.evaluate(
    (c) => globalThis.__RP__.time((env) => env.bakeProbe(c.y, c.x, c.z)), centre);
  report.costs[`${place}-skyOnlyBake`] = await page.evaluate(
    () => globalThis.__RP__.time((env) => env._bakeEnvironment()));
}

log('timing...');
// Costs are measured back in the world, which is the per-stage-build path.
await page.evaluate(() => globalThis.__HARNESS__.resetRun());
await page.waitForTimeout(800);
Object.assign(report.costs, await page.evaluate(() => globalThis.__RP__.costs()));
report.errors = errors;

await writeFile(path.join(OUT, 'roughness-ladder.json'), JSON.stringify(report, null, 2));
log(`wrote ${path.join(OUT, 'roughness-ladder.json')}`);
for (const [place, p] of Object.entries(report.places)) {
  for (const [mode, rows] of Object.entries(p.arms)) {
    for (const r of rows) {
      console.log(`  ${place.padEnd(12)} ${mode.padEnd(6)} ${r.target.padEnd(17)} sun ${String(r.sunAngleDeg).padStart(5)} deg  `
        + `L012 ${String(r.meanLuma012).padStart(6)}  L090 ${String(r.meanLuma090).padStart(6)}  `
        + `det012 ${String(r.detail012).padStart(7)}  det090 ${String(r.detail090).padStart(6)}  `
        + `ratio ${String(r.detailRatio).padStart(6)}`);
    }
  }
}
console.log('costs', JSON.stringify(report.costs));
await browser.close();
await server.close();
