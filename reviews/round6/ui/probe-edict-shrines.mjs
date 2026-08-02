/**
 * Functional probe for the Edict chooser and the six shrines.
 * Evidence, not assertions: every case prints what it measured.
 *   node tools/_c3probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = 5263;
const server = await createServer({ server: { port: PORT, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit',
    '--window-position=-2400,-2400', '--window-size=1280,720'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/?seed=1337&quality=1&harness=1`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.artifacts != null, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const { ctx } = globalThis.__GAME__;
  const R = {};
  for (const a of ctx.artifacts.list()) ctx.profile.unlock('artifact', a.id, { silent: true });
  ctx.artifacts.setActive(['command']);
  await globalThis.__HARNESS__.gameplay({ settleFrames: 30 });
  globalThis.__HARNESS__.thaw?.();

  const items = await import('/src/data/items.js');
  const commons = items.ITEMS_BY_TIER.common;

  // ---------------------------------------------------------------- 1. edict
  R.commandActive = ctx.artifacts.has('command');
  const target = commons[7].id;
  ctx.artifacts.setEdict('common', target);
  const rngBefore = ctx.rng.s;
  const picks = [];
  for (let i = 0; i < 25; i++) picks.push(ctx.items.rollItem('common'));
  R.edict = {
    ordered: target,
    allMatch: picks.every((p) => p === target),
    distinct: [...new Set(picks)],
    rngUnmoved: ctx.rng.s === rngBefore,
  };
  ctx.artifacts.clearEdict();
  const after = [];
  for (let i = 0; i < 10; i++) after.push(ctx.items.rollItem('common'));
  R.edict.afterRevokeDistinct = [...new Set(after)].length;
  R.edict.persisted = JSON.parse(localStorage.getItem('petrichor.run.v1') || '{}').edict;
  ctx.artifacts.setEdict('common', target);
  R.edict.persistedAfterSet = JSON.parse(localStorage.getItem('petrichor.run.v1') || '{}').edict;
  // A stale id must degrade to the policy, not to a null drop.
  ctx.artifacts.setEdict('common', 'no-such-item-id');
  R.edict.staleIdFallsBack = ctx.items.rollItem('common') !== null;
  ctx.artifacts.setEdict('common', target);

  // ------------------------------------------------------------------ 2. UI
  const menus = ctx.hud.menus;
  menus.open('edict');
  const root = menus.root;
  R.ui = {
    screenOpen: root.querySelector('.screen--edict')?.classList.contains('is-open'),
    paused: ctx.paused,
    tabs: root.querySelectorAll('.etab').length,
    tiles: root.querySelectorAll('.eitem').length,
    commonCount: commons.length,
    seals: root.querySelectorAll('.etab-seal').length,
    ordered: root.querySelectorAll('.eitem.is-on').length,
    standing: root.querySelector('.estand-v')?.textContent?.trim(),
    styleInjected: !!document.getElementById('petrichor-edict-style'),
    // computed style proves the injected sheet actually applied
    panelWidth: getComputedStyle(root.querySelector('.panel--edict')).width,
    tileBg: getComputedStyle(root.querySelector('.eitem.is-on')).borderLeftColor,
    noteText: root.querySelector('[data-edict-note]')?.textContent || '',
  };
  // Click a different tier, then a tile, through the real delegated handler.
  root.querySelector('[data-edict-tier="uncommon"]').click();
  const firstUncommon = root.querySelector('.eitem');
  firstUncommon.click();
  R.ui.clickFiled = ctx.artifacts.edictFor('uncommon');
  R.ui.clickFiledExpected = items.ITEMS_BY_TIER.uncommon[0].id;
  // Re-query: filing an order re-renders the grid, so the node above is now
  // detached and a click on it would never reach the delegated handler.
  const sameTile = root.querySelector(`[data-edict-item="${R.ui.clickFiled}"]`);
  R.ui.reRenderedTileIsOn = sameTile.classList.contains('is-on');
  sameTile.click();                            // same tile again = revoke
  R.ui.clickRevoked = ctx.artifacts.edictFor('uncommon') === null;

  // What a co-op guest is told.
  const realRole = ctx.netRole;
  ctx.netRole = 'client';
  menus.renderEdict();
  R.ui.clientNote = root.querySelector('[data-edict-note]').textContent;
  ctx.netRole = realRole;
  // …and what it says with Command switched off.
  ctx.artifacts.live = false;
  ctx.artifacts.setActive([]);
  menus.renderEdict();
  R.ui.inertNote = root.querySelector('[data-edict-note]').textContent;
  R.ui.entriesHiddenWhenOff = [...root.querySelectorAll('[data-edict-entry]')].every((e) => e.hidden);
  ctx.artifacts.setActive(['command']);
  menus.renderEdict();
  menus.syncEdictEntries();
  R.ui.entriesShownWhenOn = [...root.querySelectorAll('[data-edict-entry]')].every((e) => !e.hidden);
  menus.act('edict-back');
  R.ui.closedToRun = menus.screen === null && ctx.paused === false;

  // -------------------------------------------------------------- 3. shrines
  const NAMES = { 3: 'AuricCairn', 4: 'IchorFont', 9: 'HollowChime', 10: 'GildedSnare', 11: 'FallowVault', 12: 'MarrowKiln' };
  const perStage = [];
  for (let s = 0; s < 10; s++) {
    ctx.progression.interactables.populate(s);
    const ids = ctx.progression.interactables.list
      .filter((i) => NAMES[i.typeId]).map((i) => NAMES[i.typeId]);
    perStage.push(ids);
  }
  R.shrines = {
    perStage,
    everTypes: [...new Set(perStage.flat())].sort(),
    maxOnAStage: Math.max(...perStage.map((p) => p.length)),
    anyDuplicateOnAStage: perStage.some((p) => new Set(p).size !== p.length),
    stage0Types: [...new Set(perStage[0])],
  };
  // Determinism: same stage index, same seed -> same shrine set.
  ctx.progression.interactables.populate(5);
  const a5 = ctx.progression.interactables.list.filter((i) => NAMES[i.typeId]).map((i) => NAMES[i.typeId]);
  ctx.progression.interactables.populate(5);
  const b5 = ctx.progression.interactables.list.filter((i) => NAMES[i.typeId]).map((i) => NAMES[i.typeId]);
  R.shrines.deterministic = JSON.stringify(a5) === JSON.stringify(b5);

  // ------------------------------------------------- 4. per-shrine mechanics
  const grab = (typeId) => {
    for (let s = 0; s < 24; s++) {
      ctx.progression.interactables.populate(s);
      const hit = ctx.progression.interactables.list.find((i) => i.typeId === typeId);
      if (hit) { hit.position.copy(ctx.player.position); hit.stageIndex = 2; return hit; }
    }
    return null;
  };
  const prompts = {};

  // Kiln: certain, named, irreversible.
  const kiln = grab(12);
  ctx.items.give(commons[0].id, 4);
  ctx.items.give(commons[1].id, 1);
  prompts.kiln = kiln.prompt();
  const goldBefore = ctx.items.gold;
  const fuel = kiln._fuel();
  const okK = kiln.interact();
  R.kiln = {
    prompt: prompts.kiln,
    namedFuel: fuel.def.name,
    tookNamedItem: ctx.items.count(fuel.id) === fuel.count - 1,
    paid: ctx.items.gold - goldBefore,
    ok: okK,
  };

  // Vault: commits the purse, pays next stage.
  const vault = grab(11);
  ctx.items.addGold(400 - ctx.items.gold);
  prompts.vault = vault.prompt();
  const stake = ctx.items.gold;
  const okV = vault.interact();
  R.vault = {
    prompt: prompts.vault, ok: okV, stake,
    goldAfterCommit: ctx.items.gold,
    held: JSON.parse(JSON.stringify(ctx.progression.vault || null)),
  };
  ctx.progression.advanceStage();
  R.vault.goldAfterNextStage = ctx.items.gold;
  R.vault.cleared = ctx.progression.vault === null;

  // Chime: ambush first, then two certain drops.
  const chime = grab(9);
  const enemiesBefore = ctx.director.enemies.filter((e) => e.alive).length;
  const orbsBefore = ctx.progression.interactables.orbs.length;
  const okC = chime.interact();
  R.chime = {
    ok: okC, state: chime.state, prompt: chime.prompt(),
    summoned: ctx.director.enemies.filter((e) => e.alive).length - enemiesBefore,
    pending: chime.pending.length,
    orbsWhileRinging: ctx.progression.interactables.orbs.length - orbsBefore,
  };
  for (const h of chime.pending) { h.e.alive = false; }
  chime.update(1 / 60);
  R.chime.orbsAfterClear = ctx.progression.interactables.orbs.length - orbsBefore;
  R.chime.stateAfterClear = chime.state;

  // Snare: reward first, elite after.
  const snare = grab(10);
  const orbs2 = ctx.progression.interactables.orbs.length;
  const elitesBefore = ctx.director.enemies.filter((e) => e.alive && e.elite).length;
  const okS = snare.interact();
  R.snare = {
    ok: okS, prompt: snare.prompt(),
    orbsImmediately: ctx.progression.interactables.orbs.length - orbs2,
    elitesAdded: ctx.director.enemies.filter((e) => e.alive && e.elite).length - elitesBefore,
  };

  // Prompts carry no RoR2 shrine names.
  const cairn = grab(3), font = grab(4);
  R.prompts = {
    cairn: cairn.prompt(), font: font.prompt(),
    chime: chime.prompt(), snare: snare.prompt(),
    vault: vault.prompt(), kiln: kiln.prompt(),
  };
  return R;
});

console.log(JSON.stringify(out, null, 2));
console.log('pageErrors:', pageErrors);
await browser.close();
await server.close();
