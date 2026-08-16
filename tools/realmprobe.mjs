/**
 * End-to-end probe for the realm flow — no screenshots, only facts.
 *
 * The capture harness proves the realms *render*; it reaches them through
 * `forceEnter`, which is not how a player gets there. This drives the actual
 * path instead, in order, and prints what happened at each step:
 *
 *   1. a stage rolls gateways through `Realms.onStagePopulated`
 *   2. pressing a Newt Altar arms the market and charges gold for it
 *   3. clearing the stage opens the market portal beside the ordinary one
 *   4. a Trial Obelisk enters the Crucible *mid-stage*
 *   5. leaving it returns the player to the same stage, in the same place,
 *      with the same unopened chests and the same teleporter
 *   6. at FINALE_STAGE the loot window opens a second portal to the Fracture
 *      and the ordinary portal is still there, so the loop is intact
 *
 *   node tools/realmprobe.mjs [--seed 1337]
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
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5208);

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
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=1&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null && globalThis.__HARNESS__ != null, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const ctx = globalThis.__GAME__.ctx;
  const H = globalThis.__HARNESS__;
  const frames = H.frames;
  const log = [];

  H.thaw();
  H.dismiss();
  for (let i = 0; i < 300 && !ctx.interactables?.teleporter; i++) await frames(1);
  ctx.director.clear(ctx);

  const names = () => ctx.interactables.list.map((o) => o.kind || o.constructor.name);
  const gatewaysOn = () => ctx.interactables.list.filter((o) => o.kind === 'gateway');
  const portalsOn = () => ctx.interactables.list.filter((o) => o.kind === 'portal' || o.constructor.name === 'Portal');

  // --- 1. gateways roll onto ordinary stages --------------------------------
  // The roll is 26-42% per gateway per stage, so a single stage proves nothing
  // either way. Re-roll a stage's worth of gateways until each kind has been
  // seen at least once, and report how many attempts it took.
  const seen = new Map();
  let attempts = 0;
  for (; attempts < 60 && seen.size < 3; attempts++) {
    for (const g of gatewaysOn()) {
      const i = ctx.interactables.list.indexOf(g);
      if (i >= 0) ctx.interactables.list.splice(i, 1);
      ctx.interactables.root.remove(g.group);
    }
    ctx.realms.used.clear();
    ctx.realms.onStagePopulated(3);
    for (const g of gatewaysOn()) seen.set(g.realm.id, (seen.get(g.realm.id) || 0) + 1);
  }
  log.push({ step: 'gateways roll', attempts, kindsSeen: [...seen.keys()], counts: [...seen.entries()] });

  // --- 2. the altar arms the market and charges for it ----------------------
  ctx.realms.used.clear();
  ctx.realms.armedRealm = null;
  for (const g of gatewaysOn()) { const i = ctx.interactables.list.indexOf(g); if (i >= 0) ctx.interactables.list.splice(i, 1); }
  ctx.realms.gateways.length = 0;
  let altar = null;
  for (let i = 0; i < 80 && !altar; i++) {
    ctx.realms.used.clear();
    ctx.realms.onStagePopulated(3);
    altar = gatewaysOn().find((g) => g.gate.mode === 'arm') || null;
  }
  let arm = { found: !!altar };
  if (altar) {
    ctx.items.addGold(altar.cost + 10);
    const before = ctx.items.gold;
    const ok = altar.interact();
    arm = { found: true, cost: altar.cost, ok, goldBefore: before, goldAfter: ctx.items.gold,
            armed: ctx.realms.armedRealm };
  }
  log.push({ step: 'newt altar arms the market', ...arm });

  // --- 3. the loot window opens the market portal beside the ordinary one ----
  const tpAt = ctx.interactables.teleporter.position.clone();
  const portalsBefore = portalsOn().length;
  ctx.interactables.spawnPortal(tpAt.clone().add(new (Object.getPrototypeOf(tpAt).constructor)(4, 0, 0)), () => {});
  ctx.realms.openPortals(tpAt, 3);
  log.push({
    step: 'loot window (stage 3)',
    portalsBefore, portalsAfter: portalsOn().length,
    labels: portalsOn().map((p) => p.prompt()),
  });

  // --- 4/5. a mid-stage realm returns you to the same stage -----------------
  const stageBefore = ctx.stage;
  const posBefore = ctx.player.position.clone();
  const chestsBefore = ctx.interactables.list.filter((o) => o.constructor.name === 'Chest' && !o.used).length;
  const tpBefore = ctx.interactables.teleporter;

  ctx.realms.requestEnter('crucible');
  for (let i = 0; i < 120 && !ctx.realms.inRealm; i++) await frames(1);
  const inside = {
    inRealm: ctx.realms.inRealm,
    realm: ctx.realms.realmId,
    stageIsRealm: ctx.stage?.isRealm === true,
    floorRadius: ctx.stage?.floorRadius,
    playerOnRealmFloor: Math.round(Math.abs(ctx.player.position.x - ctx.stage.origin.x)) < 60,
    worldTerrainHidden: stageBefore.terrainMesh.visible === false,
    directorBuying: ctx.director.enabled,
    // The stage contract, exercised on the realm rather than asserted about it.
    contract: {
      sampleHeight: typeof ctx.stage.sampleHeight(ctx.stage.origin.x, ctx.stage.origin.z),
      raycast: !!ctx.stage.raycast(
        new (Object.getPrototypeOf(ctx.player.position).constructor)(ctx.stage.origin.x, 20, ctx.stage.origin.z),
        new (Object.getPrototypeOf(ctx.player.position).constructor)(0, -1, 0), 60),
      capsuleResolve: !!ctx.stage.capsuleResolve(ctx.player.position, 0.45, 1.8, ctx.player.velocity, 1 / 60),
      randomWalkablePoint: !!ctx.stage.randomWalkablePoint(ctx.rng, {}),
    },
  };
  log.push({ step: 'entered the Crucible from a stage', ...inside });

  // Run the trial's own wave machinery for a moment, then leave the way a
  // player does: through the exit portal the controller placed.
  ctx.realms.beginTrial();
  for (let i = 0; i < 400 && ctx.realms.active.controller.live.length === 0; i++) await frames(1);
  const waveLive = ctx.realms.active.controller.live.length;
  const exit = ctx.realms.props.find((p) => p.kind === 'portal');
  exit?.interact();
  for (let i = 0; i < 120 && ctx.realms.inRealm; i++) await frames(1);

  log.push({
    step: 'left the Crucible',
    waveSpawned: waveLive,
    backOnWorldStage: ctx.stage === stageBefore,
    terrainVisible: stageBefore.terrainMesh.visible,
    playerReturned: ctx.player.position.distanceTo(posBefore) < 3,
    sameTeleporter: ctx.interactables.teleporter === tpBefore,
    chestsStillUnopened: ctx.interactables.list.filter((o) => o.constructor.name === 'Chest' && !o.used).length,
    chestsBefore,
    realmPropsCleaned: ctx.realms.props.length,
    directorBuying: ctx.director.enabled,
  });

  // --- 6. the finale portal at FINALE_STAGE ---------------------------------
  for (const p of portalsOn()) { const i = ctx.interactables.list.indexOf(p); if (i >= 0) ctx.interactables.list.splice(i, 1); }
  ctx.interactables.spawnPortal(tpAt.clone(), () => {});
  ctx.realms.openPortals(tpAt, 5);
  const finalePortals = portalsOn().map((p) => p.prompt());
  log.push({
    step: 'loot window (stage 6 = FINALE_STAGE)',
    portals: finalePortals,
    loopStillOffered: finalePortals.some((t) => /Enter Portal/i.test(t)),
    finaleOffered: finalePortals.some((t) => /Fracture/i.test(t)),
  });

  return { log, frameErrors: ctx.frameErrors ?? 0 };
});

console.log(JSON.stringify({ seed: SEED, ...out, pageErrors: errors.slice(0, 5) }, null, 2));
await browser.close();
await server.close();
process.exit(out.frameErrors === 0 && errors.length === 0 ? 0 : 1);
