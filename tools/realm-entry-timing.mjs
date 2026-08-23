/**
 * Where does realm entry spend its milliseconds? (#183)
 *
 * Boots the real game, then times the pieces of `Realms._enter` separately:
 * the arena build, the reflection-probe bake, the controller's own entry, and
 * the frames either side of the swap. Prints facts; changes nothing.
 *
 *   node tools/realm-entry-timing.mjs [--realm crucible] [--port 5251]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const PORT = Number(args.port ?? 5238);
const REALM = String(args.realm ?? 'crucible');
const WARM = !!args.warm;
const SKIP = String(args.skip ?? '');
const TWICE = !!args.twice;

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
         '--window-position=-2400,-2400', '--window-size=1280,720'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=1&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null,
  null, { timeout: 60000 });

const out = await page.evaluate(async ({ realmId, warm, skip, twice }) => {
  const ctx = globalThis.__GAME__.ctx;
  const H = globalThis.__HARNESS__;
  H.thaw(); H.dismiss();
  await H.frames(30);
  ctx.director.clear(ctx);

  const now = () => performance.now();
  const res = {};

  // --- isolated: build one arena off to the side and throw it away ----------
  const { RealmStage } = await import('/src/world/realms/RealmStage.js');
  const { buildArena } = await import('/src/world/realms/RealmArena.js');
  const { REALM_BY_ID } = await import('/src/data/realms.js');
  const def = REALM_BY_ID.get(realmId);

  const t0 = now();
  const s = new RealmStage(ctx, def);
  const t1 = now();
  buildArena(s);
  const t2 = now();
  s.dispose();
  const t3 = now();
  res.stageCtor = t1 - t0;
  res.buildArena = t2 - t1;
  res.dispose = t3 - t2;

  // second build, to see whether the first paid a one-off (texture sets etc.)
  const s2 = new RealmStage(ctx, def);
  const t4 = now();
  buildArena(s2);
  res.buildArena2 = now() - t4;
  // how much geometry an arena actually is
  {
    const s3 = new RealmStage(ctx, def);
    buildArena(s3);
    let bytes = 0, verts = 0, meshes = 0, biggest = 0;
    s3.root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      let b = 0;
      for (const a of Object.values(o.geometry.attributes)) b += a.array.byteLength;
      const ix = o.geometry.index; if (ix) b += ix.array.byteLength;
      verts += o.geometry.attributes.position?.count ?? 0;
      bytes += b;
      if (b > biggest) biggest = b;
    });
    res.geoMeshes = meshes;
    res.geoVerts = verts;
    res.geoMB = +(bytes / 1048576).toFixed(2);
    res.geoBiggestMB = +(biggest / 1048576).toFixed(2);
    s3.dispose();
  }
  s2.dispose();

  // --- the real entry, instrumented ----------------------------------------
  const env = ctx.environment;
  const realBake = env.bakeProbe.bind(env);
  env.bakeProbe = (...a) => { const t = now(); realBake(...a); res.bakeProbe = now() - t; };
  const realApply = env.applyBiome.bind(env);
  env.applyBiome = (...a) => { const t = now(); realApply(...a); res.applyBiome = now() - t; };

  if (skip.includes('bake')) env.bakeProbe = () => { res.bakeProbe = -1; };
  if (skip.includes('biome')) env.applyBiome = () => { res.applyBiome = -1; };

  const realEnter = ctx.realms._enter.bind(ctx.realms);
  ctx.realms._enter = (...a) => { const t = now(); realEnter(...a); res.enterTotal = now() - t; };

  const pipe = ctx.pipeline;
  const realRender = pipe.render.bind(pipe);
  const renderTimes = [];
  pipe.render = (...a) => { const t = now(); realRender(...a); renderTimes.push(+(now() - t).toFixed(1)); };
  res.programsBefore = pipe.renderer.info.programs.length;
  let keysWarm = new Set(pipe.renderer.info.programs.map((pr) => pr.cacheKey));
  const keysBoot = new Set(keysWarm);
  const sm = pipe.renderer.shadowMap;
  const realShadow = sm.render.bind(sm);
  const shadowTimes = [];
  sm.render = (...a) => { const t = now(); realShadow(...a); shadowTimes.push(+(now() - t).toFixed(1)); };

  // frame times across the swap
  const frameTimes = [];
  let last = now();
  const tick = () => { const t = now(); frameTimes.push(+(t - last).toFixed(1)); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  // Visible point lights are in every lit program's cache key, so a warm that
  // counts them differently from the entry frame warms nothing. Note that
  // `renderer.compile` walks BOTH its target scene and its first argument, so
  // an arena root put into the scene *for* the compile is counted twice — the
  // trap this counter exists to expose.
  const countLightsNow = () => {
    let world = 0, arena = 0;
    const walk = (o, inRealm) => {
      if (!o.visible) return;
      const r = inRealm || (o.name || '').startsWith('realm:');
      if (o.isPointLight) { if (r) arena++; else world++; }
      for (const c of o.children) walk(c, r);
    };
    walk(ctx.scene, false);
    return `${world} world + ${arena} arena`;
  };

  if (warm) {
    // Read the light count from *inside* each posed compile: it is in every
    // lit program's cache key, so a warm that counts differently warms nothing.
    const realCA = pipe.renderer.compileAsync.bind(pipe.renderer);
    res.lightsAtCompile = [];
    pipe.renderer.compileAsync = (...a) => { res.lightsAtCompile.push(countLightsNow()); return realCA(...a); };

    // Exactly what a door opening does. Then let the prewarm run its course.
    const w0 = renderTimes.length;
    ctx.events.emit('realmOffer', { id: realmId, kind: 'gateway', stage: 3, cost: 0 });
    await H.frames(200);
    const during = renderTimes.slice(w0);
    res.warmStanding = ctx.realms.warm.records.has(realmId);
    res.warmStep = ctx.realms.warm.records.get(realmId)?.step ?? 'taken';
    res.warmReady = ctx.realms.warm.ready(realmId);
    res.warmSpread = ctx.realms.warm.records.get(realmId)?.spread ?? -1;
    res.warmNewCount = pipe.renderer.info.programs.filter((pr) => !keysBoot.has(pr.cacheKey)).length;
    res.programsWarm = pipe.renderer.info.programs.length;
    keysWarm = new Set(pipe.renderer.info.programs.map((pr) => pr.cacheKey));
    res.newAtWarm = pipe.renderer.info.programs
      .filter((pr) => !keysBoot.has(pr.cacheKey))
      .map((pr) => pr.cacheKey.slice(150, 260));
    res.warmRenderMax = Math.max(...during);
    res.warmRenderSum = during.reduce((a, b) => a + b, 0);
    res.warmOver50 = during.filter((t) => t > 50).length;
  }

  res.lightsBeforeEntry = countLightsNow();
  {
    const rec = ctx.realms.warm.records.get(realmId);
    let all = 0, vis = 0;
    rec?.stage?.root.traverse((o) => { if (o.isPointLight) { all++; if (o.visible) vis++; } });
    res.warmArenaLights = `${vis} visible / ${all} total`;
  }

  await H.frames(10);
  const mark = frameTimes.length;
  ctx.realms.requestEnter(realmId);
  await H.frames(20);

  res.framesBefore = frameTimes.slice(Math.max(0, mark - 6), mark);
  res.framesAfter = frameTimes.slice(mark, mark + 12);
  res.inRealm = ctx.realms.inRealm;
  res.lightsAfterEntry = countLightsNow();
  const rm = renderTimes.length;
  res.rendersAfter = renderTimes.slice(Math.max(0, rm - 20));
  res.programsAfter = pipe.renderer.info.programs.length;
  const fresh = pipe.renderer.info.programs.filter((pr) => !keysWarm.has(pr.cacheKey));
  res.newAtEntry = fresh.map((pr) => pr.cacheKey.slice(150, 260));
  // Which warmed key each entry-time program *nearly* matched, and where they
  // part company: a one-token difference is a warm aimed at the wrong state.
  const warmList = [...keysWarm];
  res.nearMiss = fresh.map((pr) => {
    let best = null, bestAt = -1;
    for (const w of warmList) {
      let i = 0;
      while (i < w.length && i < pr.cacheKey.length && w[i] === pr.cacheKey[i]) i++;
      if (i > bestAt) { bestAt = i; best = w; }
    }
    return `@${bestAt}:${pr.cacheKey.slice(0, 12)}:${pr.cacheKey.slice(bestAt, bestAt + 14)}`;
  });
  if (twice) {
    ctx.realms._exit();
    await H.frames(20);
    const r0 = renderTimes.length;
    ctx.realms.requestEnter(realmId);
    await H.frames(20);
    res.secondEntry = renderTimes.slice(r0);
    res.programsSecond = pipe.renderer.info.programs.length;
  }
  res.shadowsAfter = shadowTimes.slice(Math.max(0, shadowTimes.length - 20));
  return res;
}, { realmId: REALM, warm: WARM, skip: SKIP, twice: TWICE });

console.log(`\n=== realm entry timing: ${REALM}${WARM ? ' (prewarmed)' : ''} ===`);
for (const [k, v] of Object.entries(out)) {
  console.log(`  ${k.padEnd(14)} ${Array.isArray(v) ? v.join(' ') : (typeof v === 'number' ? v.toFixed(1) + ' ms' : v)}`);
}

await browser.close();
await server.close();
