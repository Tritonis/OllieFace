/**
 * Live blight-ceiling probe — the "verify by playing" pass of the blight
 * ceiling slice (corrupted material variants, rim shimmer, motes, per-band
 * sky/fog/grade), run headlessly because this environment has no hands.
 *
 * The unit tests drive `Blight` against hand-built stubs: a fake ctx, a fake
 * pipeline, a fake environment. This drives the *real* game — real Stage, real
 * material library, real RenderPipeline, real Environment — and asks the
 * questions a player would ask, reading the uniforms the GPU actually gets:
 *
 *   0. clean        a run with no blight leaves every uniform at its early-out
 *                   (uBlightCount == 0, uRimCount == 0) — a clean stage pays
 *                   nothing and cannot differ from a pre-slice frame.
 *   1. mask         a `blightSeed` populates MASK_UNIFORMS: count, patch
 *                   position, a growing radius, phase, band, time.
 *   2. sky/fog      band 4 blends sky, horizon, haze and fog off the biome's
 *                   own anchor and applies the grade saturation offset.
 *   3. restore      band 0 hands every one of those back to the baseline.
 *   4. shimmer      a camera standing off a rim records into the grade pass's
 *                   uRims/uRimCount with sane UV, radius and strength.
 *   5. motes        the rim emits particles — counted through a stub wrapped
 *                   around `ctx.vfx.particles.emit`, which is the same call
 *                   the real VFX takes.
 *   6. console      zero page errors across the whole session.
 *
 * MASK_UNIFORMS is read by dynamic-importing the module from the dev server.
 * That is the same URL `src/systems/Blight.js` imports, so the browser's module
 * registry hands back the *same* record the game is writing — not a copy.
 *
 * Shots land in `--out` (default `shots-blightceiling`), including the slice's
 * money shot: a blight edge in the foreground spreading toward camera,
 * corrupted props inside it, clean biome beyond.
 *
 *   node tools/blightprobe.mjs [--seed 1337] [--port 5212] [--out shots-blightceiling]
 *
 * Exit 1 if any check fails; the JSON record is written beside the PNGs either
 * way, because a failed arm is evidence too.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveOutDir } from './lib/evidence.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5212);
// shots-blightceiling is gitignored; route through the helper so a citation
// off this run gets warned about, not silently promised (issue #71).
const OUT = resolveOutDir(args.out ?? 'shots-blightceiling', { tool: 'blightprobe' });
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

let record = null;
try {
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  await page.evaluate(() => globalThis.__HARNESS__.pinClock(1 / 60));
  await page.evaluate(() => globalThis.__HARNESS__.gameplay({ settleFrames: 60 }));

  // Bind the *live* mask uniform object once, and hang the mote counter off the
  // real particle system. Both stay installed for the rest of the session.
  await page.evaluate(async () => {
    const G = globalThis.__GAME__;
    // This probe thaws for ~45 s of live play at band 4 with 200 world
    // corruption on the board, which kills a level-1 survivor long before the
    // money shot — and a death scrim over the frame photographs nothing. Same
    // pin `Harness`'s own `invulnerable()` uses for its combat scenarios.
    globalThis.__PIN__ = () => {
      const p = G.ctx.player;
      if (!p) return;
      p.maxHealth = 1e6; p.health = 1e6; p._iframeUntil = Infinity;
    };
    globalThis.__PIN__();
    const mod = await import('/src/shaders/BlightMask.js');
    globalThis.__BM__ = mod;
    // Same trick for the growth curve: a gate tool that re-types `radiusOf`'s
    // formula silently stops testing the game the day the formula moves.
    globalThis.__BL__ = await import('/src/systems/Blight.js');
    const parts = G.ctx.vfx?.particles;
    globalThis.__MOTES__ = { count: 0, real: !!parts, samples: [] };
    if (parts) {
      const inner = parts.emit.bind(parts);
      parts.emit = (o) => {
        // The blight's motes are the only EMBER emission that rides gravity
        // *upward*; everything else in the game falls.
        if (o && o.gravity < 0 && o.color0 === 0x9a5fe0) {
          globalThis.__MOTES__.count++;
          if (globalThis.__MOTES__.samples.length < 3) {
            globalThis.__MOTES__.samples.push({ x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2), z: +o.position.z.toFixed(2) });
          }
        }
        return inner(o);
      };
    }
  });

  // ---------------------------------------------------------------- arm 0
  // Clean stage. Nothing has been seeded; both early-outs must hold, which is
  // the whole argument that a corruption-free frame is unchanged by this slice.
  const clean = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    H.thaw(); await H.frames(30); H.freeze();
    const U = globalThis.__BM__.MASK_UNIFORMS;
    const grade = ctx.pipeline?.passes?.grade?.uniforms;
    return {
      patches: ctx.blight?.patches?.length ?? null,
      band: ctx.blight?.band ?? null,
      uBlightCount: U.uBlightCount.value,
      uRimCount: grade?.uRimCount?.value ?? null,
      saturation: grade?.uSaturation?.value ?? null,
      satBase: ctx.blight?._satBase ?? null,
      skyW: ctx.blight?._skyW ?? null,
      motes: globalThis.__MOTES__.count,
      moteStubReal: globalThis.__MOTES__.real,
    };
  });
  check('clean stage: no patches', clean.patches === 0, clean.patches);
  check('clean stage: mask early-outs at zero', clean.uBlightCount === 0, clean.uBlightCount);
  check('clean stage: shimmer early-outs at zero', clean.uRimCount === 0, clean.uRimCount);
  check('clean stage: grade saturation is the pipeline\'s own', clean.satBase != null && Math.abs(clean.saturation - clean.satBase) < 1e-6,
    { saturation: clean.saturation, base: clean.satBase });
  check('clean stage: no motes emitted', clean.motes === 0, clean.motes);
  check('mote counter wraps the real particle system', clean.moteStubReal === true, clean.moteStubReal);
  await shot('00-clean');

  // ---------------------------------------------------------------- arm 1
  // A blightSeed in front of the survivor. Everything below is read off the
  // uniform object the patched programs are bound to.
  const mask = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const p = ctx.player.position;
    const sx = p.x + 10, sz = p.z + 10;
    ctx.events.emit('blightSeed', { x: sx, z: sz, strength: 1 });
    H.thaw(); await H.frames(6); H.freeze();
    const U = globalThis.__BM__.MASK_UNIFORMS;
    const early = U.uBlightPatches.value.slice(0, 4);
    // A patch is born at `radiusOf(strength, world)`, so at world 0 it is
    // already on its target and nothing would crawl. Feed the world instead of
    // asserting against a target that has not moved: 200 corruption raises the
    // target to 11.5 m, and GROW_RATE walks it there at 1.2 m/s.
    // `world` is a getter; the only way in is the real feed, which is the path
    // a greedy chest takes anyway. The target comes from the shipped
    // `radiusOf`, not a copy of it.
    ctx.corruption.feed(ctx.player, 200);
    H.thaw(); await H.frames(120); H.freeze();   // 2 s of crawl
    const late = U.uBlightPatches.value.slice(0, 4);
    const patch = ctx.blight.patches[0];
    return {
      seed: { x: +sx.toFixed(2), z: +sz.toFixed(2) },
      patches: ctx.blight.patches.length,
      hasMesh: !!patch?.mesh,
      inScene: !!patch?.mesh?.parent,
      count: U.uBlightCount.value,
      early: early.map((v) => +v.toFixed(3)),
      late: late.map((v) => +v.toFixed(3)),
      world: ctx.corruption.world,
      target: globalThis.__BL__.radiusOf(1, ctx.corruption.world),
      uBlightTime: +U.uBlightTime.value.toFixed(2),
      ctxTime: +ctx.time.toFixed(2),
      uBlightBand: U.uBlightBand.value,
      phase: +U.uBlightPatches.value[3].toFixed(3),
    };
  });
  check('blightSeed plants exactly one patch, meshed and in the scene',
    mask.patches === 1 && mask.hasMesh && mask.inScene, mask);
  check('MASK_UNIFORMS.uBlightCount tracks it', mask.count === 1, mask.count);
  check('slot 0 carries the seed position (x, z)',
    Math.abs(mask.late[0] - mask.seed.x) < 0.01 && Math.abs(mask.late[1] - mask.seed.z) < 0.01,
    { slot: mask.late.slice(0, 2), seed: mask.seed });
  check('slot 0 radius crawls toward the fed target, not a pop',
    mask.early[2] > 0 && mask.late[2] > mask.early[2] && mask.late[2] < mask.target,
    { early: mask.early[2], late: mask.late[2], target: mask.target });
  check('slot 0 phase is a per-patch offset, not zero', mask.phase !== 0, mask.phase);
  check('uBlightTime rides ctx.time', Math.abs(mask.uBlightTime - mask.ctxTime) < 0.05,
    { uBlightTime: mask.uBlightTime, ctxTime: mask.ctxTime });
  await shot('01-mask-patch');

  // ---------------------------------------------------------------- arm 2
  // Push the band to 4 and let the 2.5 s blend settle. Sky, fog and grade are
  // compared against the biome's own recorded anchor, not against constants.
  const band4 = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const env = ctx.environment, base = env.biomeBaseline;
    const hex = (c) => '#' + c.getHexString();
    const before = {
      zenith: hex(env.skyUniforms.uZenith.value),
      horizon: hex(env.skyUniforms.uHorizon.value),
      haze: hex(env.skyUniforms.uHaze.value),
      fogColor: hex(ctx.scene.fog.color),
      fogDensity: +ctx.scene.fog.density.toFixed(6),
      saturation: +ctx.pipeline.passes.grade.uniforms.uSaturation.value.toFixed(4),
    };
    ctx.events.emit('corruptionBand', { band: 4 });
    H.thaw(); await H.frames(300); H.freeze();   // 5 s — twice the blend
    const g = ctx.pipeline.passes.grade.uniforms;
    return {
      before,
      baseline: {
        zenith: hex(base.zenith), horizon: hex(base.horizon), haze: hex(base.haze),
        fogColor: hex(base.fogColor), fogDensity: +base.fogDensity.toFixed(6),
      },
      after: {
        zenith: hex(env.skyUniforms.uZenith.value),
        horizon: hex(env.skyUniforms.uHorizon.value),
        haze: hex(env.skyUniforms.uHaze.value),
        fogColor: hex(ctx.scene.fog.color),
        fogDensity: +ctx.scene.fog.density.toFixed(6),
        saturation: +g.uSaturation.value.toFixed(4),
        vignetteBoost: +(ctx.pipeline.vignetteBoost || 0).toFixed(4),
      },
      skyW: +ctx.blight._skyW.toFixed(4),
      satOffset: +ctx.blight._sat.toFixed(4),
      satBase: +ctx.blight._satBase.toFixed(4),
      uBlightBand: globalThis.__BM__.MASK_UNIFORMS.uBlightBand.value,
      band: ctx.blight.band,
    };
  });
  check('band 4: blend weight reached 1', band4.skyW > 0.99, band4.skyW);
  check('band 4: sky moved off the biome anchor',
    band4.after.zenith !== band4.baseline.zenith && band4.after.horizon !== band4.baseline.horizon
    && band4.after.haze !== band4.baseline.haze, { baseline: band4.baseline, after: band4.after });
  check('band 4: fog recoloured and thickened',
    band4.after.fogColor !== band4.baseline.fogColor && band4.after.fogDensity > band4.baseline.fogDensity,
    { fog: [band4.baseline.fogColor, band4.after.fogColor], density: [band4.baseline.fogDensity, band4.after.fogDensity] });
  check('band 4: grade saturation offset applied and negative (the screen sickens)',
    band4.satOffset < -0.001 && Math.abs(band4.after.saturation - (band4.satBase + band4.satOffset)) < 1e-3,
    { base: band4.satBase, offset: band4.satOffset, live: band4.after.saturation });
  check('band 4: vignette floor raised', band4.after.vignetteBoost > 0.1, band4.after.vignetteBoost);
  check('band 4: the mask knows the band', band4.uBlightBand === 4, band4.uBlightBand);
  await shot('02-band4');

  // ---------------------------------------------------------------- arm 3
  // Drop to band 0. Every one of the above must land back exactly on the
  // baseline — this is the "band 0 gives it back" contract.
  const band0 = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const env = ctx.environment, base = env.biomeBaseline;
    const hex = (c) => '#' + c.getHexString();
    ctx.events.emit('corruptionBand', { band: 0 });
    H.thaw(); await H.frames(420); H.freeze();   // 7 s
    return {
      skyW: +ctx.blight._skyW.toFixed(6),
      satOffset: +ctx.blight._sat.toFixed(6),
      satBase: +ctx.blight._satBase.toFixed(4),
      saturation: +ctx.pipeline.passes.grade.uniforms.uSaturation.value.toFixed(4),
      zenith: hex(env.skyUniforms.uZenith.value), baseZenith: hex(base.zenith),
      horizon: hex(env.skyUniforms.uHorizon.value), baseHorizon: hex(base.horizon),
      haze: hex(env.skyUniforms.uHaze.value), baseHaze: hex(base.haze),
      fogColor: hex(ctx.scene.fog.color), baseFogColor: hex(base.fogColor),
      fogDensity: +ctx.scene.fog.density.toFixed(6), baseFogDensity: +base.fogDensity.toFixed(6),
      uBlightBand: globalThis.__BM__.MASK_UNIFORMS.uBlightBand.value,
    };
  });
  check('band 0: sky restored to the biome anchor exactly',
    band0.zenith === band0.baseZenith && band0.horizon === band0.baseHorizon && band0.haze === band0.baseHaze, band0);
  check('band 0: fog restored exactly',
    band0.fogColor === band0.baseFogColor && Math.abs(band0.fogDensity - band0.baseFogDensity) < 1e-6, band0);
  check('band 0: grade saturation handed back',
    band0.satOffset === 0 && Math.abs(band0.saturation - band0.satBase) < 1e-3, band0);
  check('band 0: mask band back to 0', band0.uBlightBand === 0, band0.uBlightBand);
  await shot('03-band0-restored');

  // ---------------------------------------------------------------- arm 4
  // Shimmer. Park a free camera outside the rim, looking at it, and read the
  // grade pass's own uniforms. Then step inside the patch: the projected ring
  // would wrap the screen, so the writer must refuse it.
  const shimmer = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const p = ctx.blight.patches[0];
    const r = p.mesh.material.uniforms.uRadius.value;
    const y = ctx.stage.sampleHeight(p.x, p.z);
    // Stand off the rim by 20 m: inside SHIMMER.far (55), outside r + 1.5.
    H.freeCam(p.x + r + 20, y + 6, p.z, p.x, y, p.z);
    H.thaw(); await H.frames(4); H.freeze();
    const g = ctx.pipeline.passes.grade.uniforms;
    const outside = {
      radius: +r.toFixed(2),
      count: g.uRimCount.value,
      rec: g.uRims.value.slice(0, 4).map((v) => +v.toFixed(4)),
      aspect: +g.uRimAspect.value.toFixed(3),
    };
    // Now stand in the middle of it.
    H.freeCam(p.x, y + 3, p.z, p.x + 5, y, p.z);
    H.thaw(); await H.frames(4); H.freeze();
    const inside = { count: g.uRimCount.value };
    return { outside, inside, patch: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) } };
  });
  check('shimmer: a rim off the camera records a slot', shimmer.outside.count === 1, shimmer.outside);
  check('shimmer: record UV lands on screen',
    shimmer.outside.rec[0] > 0 && shimmer.outside.rec[0] < 1 && shimmer.outside.rec[1] > 0 && shimmer.outside.rec[1] < 1,
    shimmer.outside.rec.slice(0, 2));
  check('shimmer: uv radius is a fraction of the frame',
    shimmer.outside.rec[2] > 0 && shimmer.outside.rec[2] < 1, shimmer.outside.rec[2]);
  check('shimmer: strength is live and small (heat haze, not a lens)',
    shimmer.outside.rec[3] > 0 && shimmer.outside.rec[3] <= 0.006, shimmer.outside.rec[3]);
  check('shimmer: aspect matches the viewport', Math.abs(shimmer.outside.aspect - 16 / 9) < 0.05, shimmer.outside.aspect);
  check('shimmer: a camera standing inside the patch records nothing', shimmer.inside.count === 0, shimmer.inside.count);
  await shot('04-shimmer-rim');

  // ---------------------------------------------------------------- arm 5
  // Motes. Ten seconds of live frames with the camera on the rim, counted
  // through the stub. MOTES.perPatchPerSecond is 2.5, so one patch owes ~25.
  const motes = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const p = ctx.blight.patches[0];
    const r = p.mesh.material.uniforms.uRadius.value;
    const y = ctx.stage.sampleHeight(p.x, p.z);
    H.freeCam(p.x + r + 18, y + 6, p.z, p.x, y, p.z);
    globalThis.__MOTES__.count = 0; globalThis.__MOTES__.samples.length = 0;
    H.thaw(); await H.frames(600); H.freeze();
    const near = globalThis.__MOTES__.count;
    // Push the camera past MOTES.range (55 m) — budget must stop being spent.
    H.freeCam(p.x + 400, y + 40, p.z, p.x, y, p.z);
    globalThis.__MOTES__.count = 0;
    H.thaw(); await H.frames(300); H.freeze();
    const far = globalThis.__MOTES__.count;
    return { near, far, samples: globalThis.__MOTES__.samples, radius: +r.toFixed(2), patch: { x: p.x, z: p.z } };
  });
  check('motes: the rim emits at ~2.5/s (10 s -> ~25)', motes.near >= 20 && motes.near <= 30, motes.near);
  check('motes: land on the rim, not the centre', motes.samples.every((s) => {
    const d = Math.hypot(s.x - motes.patch.x, s.z - motes.patch.z);
    return d > motes.radius * 0.75 && d <= motes.radius * 1.05;
  }), { samples: motes.samples, radius: motes.radius });
  check('motes: a patch beyond MOTES.range spends nothing', motes.far === 0, motes.far);

  // ------------------------------------------------------------ money shot
  // The trailer thesis this slice makes possible: a blight edge in the
  // foreground spreading toward camera, corrupted props inside it, clean biome
  // beyond. Band 2 so sky/fog/grade are visibly under the void without the
  // full band-4 wash flattening the "clean biome beyond" half of the claim.
  const money = await page.evaluate(async () => {
    const G = globalThis.__GAME__, H = globalThis.__HARNESS__, ctx = G.ctx;
    const THREE = G.THREE;
    const p = ctx.blight.patches[0];
    globalThis.__PIN__();
    ctx.events.emit('corruptionBand', { band: 2 });
    // Two more seeds inland of the first, so the edge reads as a spreading
    // field with a boundary rather than one disc.
    ctx.events.emit('blightSeed', { x: p.x - 11, z: p.z - 6, strength: 1 });
    ctx.events.emit('blightSeed', { x: p.x - 6, z: p.z + 12, strength: 1 });
    H.thaw(); await H.frames(900); H.freeze();  // grow the discs, settle the band
    const r = p.mesh.material.uniforms.uRadius.value;
    const y = ctx.stage.sampleHeight(p.x, p.z);
    // Low, close, looking along the field's spine: near rim in the bottom
    // third, corrupted ground and props behind it, clean terrain past them.
    H.freeCam(p.x + r + 13, y + 5.5, p.z + 4, p.x - 12, y + 1.5, p.z);
    H.thaw(); await H.frames(6); H.freeze();
    const g = ctx.pipeline.passes.grade.uniforms;
    // Count what is actually inside a patch, so the shot's claim is measured.
    let propsInside = 0;
    ctx.scene.traverse((o) => {
      if (!o.isMesh || o.name === 'blight.patch') return;
      const wp = new THREE.Vector3(); o.getWorldPosition(wp);
      for (const q of ctx.blight.patches) {
        const rr = q.mesh?.material.uniforms.uRadius.value ?? 0;
        if (Math.hypot(wp.x - q.x, wp.z - q.z) < rr) { propsInside++; return; }
      }
    });
    return {
      patches: ctx.blight.patches.length,
      radii: ctx.blight.patches.map((q) => +q.mesh.material.uniforms.uRadius.value.toFixed(2)),
      band: ctx.blight.band,
      maskCount: globalThis.__BM__.MASK_UNIFORMS.uBlightCount.value,
      rimCount: g.uRimCount.value,
      skyW: +ctx.blight._skyW.toFixed(3),
      propsInside,
    };
  });
  check('money shot: three patches live and masked', money.patches === 3 && money.maskCount === 3, money);
  check('money shot: shimmer is in frame', money.rimCount >= 1, money.rimCount);
  check('money shot: the band is on the sky', money.band === 2 && money.skyW > 0.29, { band: money.band, skyW: money.skyW });
  check('money shot: real scene meshes stand inside the corruption', money.propsInside > 0, money.propsInside);
  await shot('05-money-shot-blight-edge');

  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  record = { seed: SEED, out: OUT, clean, mask, band4, band0, shimmer, motes, money, pageErrors, consoleErrors, checks };
} catch (e) {
  console.error(e);
  check('probe ran to completion', false, String(e && e.message));
  record = { seed: SEED, out: OUT, error: String(e && e.stack), pageErrors, consoleErrors, checks };
} finally {
  await writeFile(path.join(OUT, 'record.json'), JSON.stringify(record, null, 2));
  await browser.close();
  await server.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
