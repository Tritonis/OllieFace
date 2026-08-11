/**
 * The rendered half of the dissolve fix. `tests/dissolve-recycle.test.mjs` proves
 * the bookkeeping headless; this proves the pixels, on the real GPU path, using
 * the harness's own calibrated instrument rather than a new one.
 *
 *   node reviews/round7/dissolve/probe-dissolve.mjs
 *
 * Two questions, both answered in rendered pixels of the *isolated* subject
 * (`H.subjectReport` renders the frame, hides the subject, renders again, and
 * diffs -- so terrain, props, VFX and the composer are all divided out):
 *
 *  1. Does the dissolve visibly consume a corpse? Drive one dead hulk's
 *     `uDissolve` across its range and read its pixel count at each step. A
 *     working dissolve is a monotone fall from a full body to nothing. Two
 *     controls sit under it: `uDissolve = 5` (everything must discard) and
 *     `root.visible = false` (the instrument's own zero). Before the flash fix
 *     in `Enemy.onDeath`, arm 1 read a flat 2,081 px at every step *including*
 *     `uDissolve = 5`, while the visibility control read 0 -- which is how a
 *     dissolve that was not on the body at all was told apart from one that was.
 *
 *  2. Is the invisible-enemy path closed? Kill, then perform exactly what a
 *     stage change does inside the dissolve's 0.85 s -- `despawn` (which is
 *     `releaseRig`) followed by the next stage's first `spawnOne` (which is
 *     `acquireRig`, and pops the very rig we were dissolving) -- then run the
 *     dissolve out and photograph the new monster. Before the fix its closing
 *     `visible = false` lands on that live rig and the count is 0 px.
 *
 * Staged on `19-overkill`, which already composes a real overkill death at a
 * chosen lens. Its own gates are irrelevant here and are not read.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = 5305;
const OUT = 'reviews/round7/captures/fix-dissolve';
const SEED = 1337;

mkdirSync(OUT, { recursive: true });

let server = null, browser = null;
let result = null;
try {
  server = await createServer({ server: { port: PORT, hmr: false, watch: null }, logLevel: 'error' });
  await server.listen();

  const OFFSCREEN = process.env.CAPTURE_VISIBLE
    ? []
    : ['--window-position=-2400,-2400', '--window-size=1280,720'];
  browser = await chromium.launch({
    headless: false,
    args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__HARNESS__ != null, null, { timeout: 120000 });

  await page.evaluate(() => globalThis.__HARNESS__.overkill({ launchFrames: 10 }));

  // --- arm 1: the dissolve consumes the corpse ------------------------------
  const sweep = await page.evaluate(() => {
    const H = globalThis.__HARNESS__;
    const { ctx } = globalThis.__GAME__;
    const hulk = ctx.director.enemies.find((e) => e.def?.id === 'hulk');
    if (!hulk?.rig) return { error: 'no hulk' };
    const d = ctx.vfx._dissolving.find((x) => x.mesh === hulk.rig.root);
    if (!d) return { error: 'the kill started no dissolve' };
    const steps = [];
    for (const k of [0, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      for (const bag of d.bags) bag.uDissolve.value = k;
      steps.push({ k, px: H.subjectReport([hulk.rig.root], { perObject: true }).px });
    }
    // Diagnostics: is the corpse actually wearing the bags we are driving?
    const worn = new Set();
    hulk.rig.root.traverse((c) => {
      if (!c.isMesh || !c.material) return;
      for (const m of (Array.isArray(c.material) ? c.material : [c.material])) {
        worn.add(m.userData?.dissolveUniforms ? 'variant' : 'plain');
      }
    });
    const driven = d.bags.filter((b) => b.uDissolve.value === 0.95).length;

    // What is actually on the GPU for the biggest piece of this corpse?
    let probeMesh = null, probeArea = -1;
    hulk.rig.root.traverse((c) => {
      if (!c.isMesh || Array.isArray(c.material)) return;
      const g = c.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const a = g.boundingSphere.radius;
      if (a > probeArea) { probeArea = a; probeMesh = c; }
    });
    const m = probeMesh?.material;
    const r = ctx.pipeline?.renderer;
    const props = r?.properties?.get?.(m);
    const shaderInfo = {
      cls: m?.constructor?.name ?? null,
      isStandard: !!m?.isMeshStandardMaterial,
      hasBag: !!m?.userData?.dissolveUniforms,
      sameBagObject: d.bags.some((b) => b === m?.userData?.dissolveUniforms),
      // The compiled program's cache key is prefixed `dissolve|` by
      // `applyDissolve`; anything else means the patch never reached the GPU.
      programIsPatched: (props?.currentProgram?.cacheKey ?? '').includes('dissolve|'),
      progUniformIsOurs: props?.uniforms?.uDissolve && m?.userData?.dissolveUniforms
        ? props.uniforms.uDissolve === m.userData.dissolveUniforms.uDissolve : null,
      progHasUDissolve: props?.uniforms ? Object.keys(props.uniforms).includes('uDissolve') : null,
    };

    // Instrument control: does this measurement respond to anything at all?
    for (const bag of d.bags) bag.uDissolve.value = 5;
    const pxGone = H.subjectReport([hulk.rig.root], { perObject: true }).px;
    hulk.rig.root.visible = false;
    const pxHidden = H.subjectReport([hulk.rig.root], { perObject: true }).px;
    hulk.rig.root.visible = true;
    for (const bag of d.bags) bag.uDissolve.value = 0.35;

    return {
      steps, bags: d.bags.length, owner: d.owner, t: +d.t.toFixed(3),
      rigEpoch: hulk.rig.root.userData.rigEpoch,
      wearing: [...worn], drivenBags: driven, pxGone, pxHidden, shaderInfo,
    };
  });
  if (sweep.error) throw new Error(`arm 1: ${sweep.error}`);

  // Two frames of the same corpse for a human to look at. The loop is frozen,
  // so each is composed by hand through the real pipeline before the shutter.
  const shoot = async (k, name) => {
    const drawn = await page.evaluate((kk) => {
      const { ctx } = globalThis.__GAME__;
      const hulk = ctx.director.enemies.find((e) => e.def?.id === 'hulk');
      const d = ctx.vfx._dissolving.find((x) => x.mesh === hulk.rig.root);
      for (const bag of d.bags) bag.uDissolve.value = kk;
      const cam = ctx.camera ?? globalThis.__HARNESS__.ctx?.camera ?? null;
      if (!cam) return 'no camera on ctx';
      ctx.pipeline.render(ctx.scene, cam, 1 / 60);
      return 'ok';
    }, k);
    if (drawn !== 'ok') console.log(`  [shot ${name}] ${drawn}`);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };
  await shoot(0, 'corpse-intact');
  await shoot(0.45, 'dissolve-midburn');

  // --- arm 2: the rig changes hands mid-dissolve -----------------------------
  const handover = await page.evaluate(() => {
    const H = globalThis.__HARNESS__;
    const { ctx } = globalThis.__GAME__;
    const hulk = ctx.director.enemies.find((e) => e.def?.id === 'hulk');
    const d = ctx.vfx._dissolving.find((x) => x.mesh === hulk.rig.root);
    for (const bag of d.bags) bag.uDissolve.value = 0.35;

    const def = hulk.def;
    const at = hulk.position.clone();
    const oldRoot = hulk.rig.root;
    const epochBefore = oldRoot.userData.rigEpoch;

    // Exactly `Director.clear` -> `Enemy.despawn`, then the new stage's first
    // spawn. `acquireRig` pops the rig we are mid-dissolve on.
    const i = ctx.director.enemies.indexOf(hulk);
    hulk.despawn(ctx);
    ctx.director.enemies.splice(i, 1);
    const fresh = ctx.director.spawnOne(ctx, def, at, null);
    if (!fresh?.rig) return { error: 'the replacement refused to spawn' };
    const sameRig = fresh.rig.root === oldRoot;

    // Run the dissolve past its 0.85 s, which is where the old code hid the rig.
    for (let f = 0; f < 90; f++) ctx.vfx._updateDissolves(1 / 60);

    return {
      sameRig,
      epochBefore, epochAfter: fresh.rig.root.userData.rigEpoch,
      dissolvingLeft: ctx.vfx._dissolving.length,
      visible: fresh.rig.root.visible,
      px: H.subjectReport([fresh.rig.root], { perObject: true }).px,
      alive: fresh.alive,
    };
  });
  if (handover.error) throw new Error(`arm 2: ${handover.error}`);
  await page.screenshot({ path: `${OUT}/live-after-handover.png` });

  result = { sweep, handover, pageErrors: errs };
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

const { sweep, handover } = result;
console.log('\narm 1 - the dissolve consumes the corpse');
console.log(`  ${sweep.bags} material bags driven (${sweep.drivenBags} read back at 0.95), corpse wearing: ${sweep.wearing.join('+')}, dissolve t=${sweep.t}s`);
for (const s of sweep.steps) console.log(`  uDissolve ${s.k.toFixed(2)} -> ${String(s.px).padStart(6)} px`);
const first = sweep.steps[0].px, last = sweep.steps[sweep.steps.length - 1].px;
const monotone = sweep.steps.every((s, i) => i === 0 || s.px <= sweep.steps[i - 1].px);
console.log('  shader:', JSON.stringify(sweep.shaderInfo));
console.log(`  control: uDissolve 5 -> ${sweep.pxGone} px, root.visible=false -> ${sweep.pxHidden} px`);
const consumes = first > 500 && last < first * 0.25 && monotone;
console.log(`  ${consumes ? 'PASS' : 'FAIL'}  a full body at 0, monotone fall, ${((1 - last / first) * 100).toFixed(1)}% gone at 0.95`);

console.log('\narm 2 - the rig changed hands mid-dissolve');
console.log(`  same rig popped from the pool: ${handover.sameRig}`);
console.log(`  rigEpoch ${handover.epochBefore} -> ${handover.epochAfter}`);
console.log(`  dissolves still holding it: ${handover.dissolvingLeft}`);
console.log(`  root.visible: ${handover.visible}   alive: ${handover.alive}`);
console.log(`  the live monster renders ${handover.px} px`);
const closed = handover.sameRig && handover.visible === true && handover.px > 500;
console.log(`  ${closed ? 'PASS' : 'FAIL'}  a live, damageable monster is in the picture`);

writeFileSync(`${OUT}/probe.json`, JSON.stringify(result, null, 2));
console.log(`\nwrote ${OUT}/probe.json and two PNGs`);
if (result.pageErrors.length) console.log('page errors:', result.pageErrors);
process.exit(consumes && closed ? 0 : 1);
