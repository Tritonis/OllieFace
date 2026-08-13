/**
 * Artifacts + difficulty: A/B evidence, not assertions.
 *
 * Every case loads the page fresh (artifacts are pre-run state, and the run
 * begins the moment the title screen closes), selects a rule set, then measures
 * the *same* quantity with it on and with it off. The pairs are printed
 * side by side so a reader can see the difference rather than trust a boolean.
 *
 *   node tools/artifactprobe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5207, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', '--window-size=1280,720'];
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

/** Fresh load, choose the rules, start the run, then run `probe` in the page. */
async function run(label, rules, probeName) {
  await page.goto('http://127.0.0.1:5207/?seed=4242&quality=1&harness=1', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.artifacts != null, null, { timeout: 60000 });
  const out = await page.evaluate(async ({ rules, probeName }) => {
    const { ctx } = globalThis.__GAME__;

    // Artifacts ship locked behind challenges; a probe is not a play session,
    // so grant them directly through the profile's own public API rather than
    // reaching past the gate.
    for (const a of ctx.artifacts.list()) ctx.profile.unlock('artifact', a.id, { silent: true });

    ctx.difficulty.set(rules.difficulty || 'fracture');
    ctx.artifacts.setActive(rules.artifacts || []);

    await globalThis.__HARNESS__.gameplay({ settleFrames: 30 });
    globalThis.__HARNESS__.thaw?.();

    const d = ctx.director;
    const frames = (n) => new Promise((res) => {
      let i = 0;
      const step = () => (++i >= n ? res() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });

    const cardById = (id) => {
      // SPAWN_CARDS is not exported to the page; every live enemy carries its
      // def, and the director's pool is keyed by id, so borrow one from a roll.
      for (let i = 0; i < 400; i++) {
        const c = d.rollCard(ctx);
        if (c && c.id === id) return c;
      }
      return null;
    };

    /** Empty the field, park the clock, then buy with a fixed bank on one card. */
    const spawnBatch = (cardId, credits, atTime) => {
      ctx.time = atTime;
      d.clear(ctx);
      d.updateDifficulty(ctx);
      const card = cardById(cardId);
      if (!card) return { error: `no card ${cardId}` };
      d.card = card;
      d.credits = credits;
      let placed = 0;
      for (let i = 0; i < 12; i++) placed += (d.spendCredits(ctx) || 0);
      const units = d.enemies.slice();
      return {
        placed,
        alive: units.length,
        populationCap: d.populationCap,
        sampleMaxHealth: units.length ? Math.round(units[0].maxHealth) : 0,
        elites: units.filter((e) => !!e.affix || !!e.elite).length,
        species: [...new Set(units.map((e) => e.def?.id))].sort(),
      };
    };

    const tally = (arr) => {
      const m = {};
      for (const v of arr) m[v] = (m[v] || 0) + 1;
      return m;
    };

    switch (probeName) {
      // ---- swarms: twice the bodies, half the health --------------------
      case 'swarms': {
        const r = spawnBatch('scarab', 600, 600);
        return { ...r, frameErrors: ctx.frameErrors };
      }

      // ---- honour: everything wears an affix ----------------------------
      case 'honour': {
        const r = spawnBatch('scarab', 600, 600);
        return { ...r, frameErrors: ctx.frameErrors };
      }

      // ---- evolution: monsters scale off your inventory ------------------
      case 'evolution': {
        for (const id of ['adrenal-syringe', 'pry-bar', 'dented-buckler']) ctx.items.give(id, 8);
        const held = ctx.items.inventory().reduce((a, b) => a + b.count, 0);
        const r = spawnBatch('scarab', 300, 600);
        return { ...r, itemsHeld: held, scale: { ...ctx.artifacts.monsterScale() }, frameErrors: ctx.frameErrors };
      }

      // ---- glass: five times damage, a tenth of the health ---------------
      case 'glass': {
        await frames(8);
        const s = ctx.player.stats;
        return {
          damage: +s.damage.toFixed(1),
          maxHealth: +s.maxHealth.toFixed(1),
          healthRegen: +s.healthRegen.toFixed(2),
          frameErrors: ctx.frameErrors,
        };
      }

      // ---- command: the drop is chosen, not rolled ------------------------
      case 'command': {
        // Hold three of one common item, so "what you already hold most of"
        // has an unambiguous answer the probe can name up front.
        ctx.items.give('pry-bar', 3);
        const ids = [];
        for (let i = 0; i < 60; i++) ids.push(ctx.items.rollItem('common'));
        const counts = tally(ids);
        return {
          distinctIds: Object.keys(counts).length,
          top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3),
          frameErrors: ctx.frameErrors,
        };
      }

      // ---- caprice: the tier forgets what it came out of ------------------
      case 'caprice': {
        // Roll a small (wooden) chest 800 times and see what tier comes out.
        const { ITEM_BY_ID } = await import('/src/data/items.js');
        const tiers = [];
        for (let i = 0; i < 800; i++) {
          const id = ctx.items.rollItem(null, 'small');
          tiers.push(ITEM_BY_ID.get(id)?.tier || '?');
        }
        return { fromSmallChest: tally(tiers), frameErrors: ctx.frameErrors };
      }

      // ---- sacrifice: no shops, loot off the corpses -----------------------
      case 'sacrifice': {
        const byType = {};
        for (const i of ctx.interactables.list) {
          const n = i.constructor.name;
          byType[n] = (byType[n] || 0) + 1;
        }
        // Drops: run a fixed number of kill payouts through the real path and
        // count the orbs it produced.
        const r = spawnBatch('sentinel', 600, 600);
        const before = ctx.interactables.orbs.length;
        let paid = 0;
        for (let i = 0; i < 400; i++) {
          const victim = d.enemies[i % Math.max(1, d.enemies.length)];
          if (!victim) break;
          // Both halves of one death's payout. The corpse-drop moved out of
          // `rewardKill` (which is now per-payee) and onto `rollSacrifice`,
          // which `Items.rewardKillAll` calls once per kill; this is that pair
          // for the roster of one this probe runs.
          ctx.items.rollSacrifice(victim, null);
          ctx.items.rewardKill(victim);
          paid++;
        }
        return {
          interactables: byType,
          killsPaid: paid,
          orbsFromCorpses: ctx.interactables.orbs.length - before,
          gold: ctx.items.gold,
          frameErrors: ctx.frameErrors,
          spawned: r.placed,
        };
      }

      // ---- difficulty: the ramp itself -------------------------------------
      case 'difficulty': {
        const at = (minutes) => {
          ctx.time = minutes * 60;
          d.updateDifficulty(ctx);
          return {
            min: minutes,
            coeff: +d.difficultyCoefficient.toFixed(3),
            level: d.level,
            popCap: d.populationCap,
            eliteChance: +d.eliteChance.toFixed(3),
          };
        };
        const curve = [at(0), at(5), at(10), at(20), at(30)];
        // One species, one clock, so the health figure is not confounded by the
        // three difficulties buying different cards.
        const sameCard = spawnBatch('scarab', 300, 600);

        // A real 60-second window of the director at minute 10, counting every
        // unit it decides to buy. `spawnOne` is wrapped rather than reading
        // `enemies.length` so attrition cannot flatter either side.
        ctx.time = 600;
        d.clear(ctx);
        d.updateDifficulty(ctx);
        d.credits = 0;
        d.spawnT = 0;
        d.rerollT = 0;
        d.enabled = true;
        const real = d.spawnOne.bind(d);
        let spawned = 0;
        const healths = [];
        d.spawnOne = (c, def, at2, affix) => {
          spawned++;
          const e = real(c, def, at2, affix);
          healths.push(e.maxHealth);
          return e;
        };
        for (let i = 0; i < 60 * 60; i++) {
          ctx.time += 1 / 60;
          // The player must survive the window or `playerDead` disables the
          // director and the two sides stop being comparable.
          if (ctx.player) { ctx.player.health = ctx.player.maxHealth; ctx.player.alive = true; }
          d.fixedUpdate(ctx, 1 / 60);
        }
        d.spawnOne = real;
        healths.sort((a, b) => a - b);
        return {
          curve,
          beetleAt10min: { maxHealth: sameCard.sampleMaxHealth, bought: sameCard.placed },
          window60s: {
            spawned,
            alive: d.enemies.length,
            medianMaxHealth: Math.round(healths[healths.length >> 1] || 0),
            creditRate: +d.creditRate.toFixed(3),
          },
          frameErrors: ctx.frameErrors,
        };
      }
      default:
        return { error: `unknown probe ${probeName}` };
    }
  }, { rules, probeName });
  return { label, ...out };
}

const CASES = [
  ['swarms', { artifacts: [] }, 'swarms', 'OFF'],
  ['swarms', { artifacts: ['swarms'] }, 'swarms', 'ON'],
  ['honour', { artifacts: [] }, 'honour', 'OFF'],
  ['honour', { artifacts: ['honour'] }, 'honour', 'ON'],
  ['evolution', { artifacts: [] }, 'evolution', 'OFF'],
  ['evolution', { artifacts: ['evolution'] }, 'evolution', 'ON'],
  ['glass', { artifacts: [] }, 'glass', 'OFF'],
  ['glass', { artifacts: ['glass'] }, 'glass', 'ON'],
  ['command', { artifacts: [] }, 'command', 'OFF'],
  ['command', { artifacts: ['command'] }, 'command', 'ON'],
  ['caprice', { artifacts: [] }, 'caprice', 'OFF'],
  ['caprice', { artifacts: ['caprice'] }, 'caprice', 'ON'],
  ['sacrifice', { artifacts: [] }, 'sacrifice', 'OFF'],
  ['sacrifice', { artifacts: ['sacrifice'] }, 'sacrifice', 'ON'],
  ['difficulty', { difficulty: 'settling' }, 'difficulty', 'DRIZZLE'],
  ['difficulty', { difficulty: 'fracture' }, 'difficulty', 'RAINSTORM'],
  ['difficulty', { difficulty: 'cataclysm' }, 'difficulty', 'MONSOON'],
];

// `node tools/artifactprobe.mjs swarms difficulty` runs only those cases.
const only = process.argv.slice(2);
const results = [];
for (const [name, rules, probe, state] of CASES.filter((c) => !only.length || only.includes(c[0]))) {
  const r = await run(`${name}/${state}`, rules, probe);
  results.push(r);
  console.log(`\n=== ${name.toUpperCase()} — ${state} ===`);
  console.log(JSON.stringify(r, null, 2));
}

console.log('\n--- page errors ---');
console.log(pageErrors.length ? pageErrors.join('\n') : '(none)');

await browser.close();
await server.close();
