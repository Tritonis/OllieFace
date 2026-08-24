/**
 * Co-op probe: two browser pages, one room code, a connection formed through
 * the shipped menus — and then measured.
 *
 *   node tools/coopprobe.mjs
 *     [--port 5214]          vite dev server port (started by this probe)
 *     [--signal-port 5215]   local signal server port (spawned by this probe)
 *     [--lane A|B|C]         resolves both ports from the lane's block
 *                            (base+4/base+5); mutually exclusive with --port
 *                            and --signal-port
 *     [--seed 1337]
 *     [--netlag 40-90]       optional: appended as ?netlag= to the CLIENT page only
 *     [--netloss 2]          optional: ?netloss= on the client page
 *
 * --netlag/--netloss impair the client's inbound traffic, i.e. host->client
 * one-way; for symmetric RTT flag both pages — not yet implemented
 *     [--run-s 60]           scripted play window after formation
 *     [--checks base]        comma-separated check-set names
 *     [--label base]         names the record file when --record is omitted
 *     [--record reviews/round9/coopprobe-<label>.json]
 *     [--out reviews/round9/coopprobe-shots]
 *     [--no-signal]          NEGATIVE CONTROL: do not spawn the relay, so both
 *                            pages point at a dead port and formation must fail
 *                            inside its cap instead of hanging
 *
 * ## Why this exists
 *
 * Every net gate the repo owns runs one process: the wire tests fake a peer,
 * `tools/verify-trickle.mjs` measures how fast a channel opens and then throws
 * the session away, and `npm run gate:sp` never opens a socket. Nothing has ever
 * asserted that two players who *drive the menus like players* end up in one
 * running world together — and nothing at all has done it at nonzero RTT.
 *
 * So this probe touches no internal networking API. It clicks Co-op, clicks
 * Create room, reads the room code out of the DOM, types it into the other
 * page's box, clicks Join room, and only then starts asking questions. If the
 * co-op screen's markup changes this fails, which is the point: that screen is
 * the contract a player uses.
 *
 * ## What is real and what is stubbed
 *
 * Real: the relay process, the vite server, two Chromium pages under d3d11,
 * `RTCPeerConnection`, both data channels, the snapshot stream, and
 * `?netlag=` / `?netloss=`'s delay-and-drop queue (`src/net/NetConfig.js`).
 *
 * Stubbed, and only this: `requestPointerLock`. Two pages in one browser cannot
 * both hold focus, and `Menus` opens the pause screen when a page loses pointer
 * lock mid-run (`src/ui/Menus.js:174`) — which would pause the host every time
 * the probe touched the client. Neutering the lock is what lets two live worlds
 * share one browser; nothing under test reads it.
 *
 * ## Bounded everywhere
 *
 * Every wait has a cap, and every cap is written into the record under
 * `bounded`, together with which check-sets ran and which checks were skipped.
 * A probe that quietly shortens its own job is worse than no probe.
 *
 * Exit code is 0 only if every selected check passed.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIVE } from '../src/data/revive.js';
import { resolveOutDir } from './lib/evidence.mjs';
import { laneBase } from './lib/lanes.mjs';
import { parseArgs, strArg } from './lib/parse-args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ arguments
// padprobe's idiom, widened for hyphenated names: `--signal-port` and `--run-s`
// arrive as `signalPort` / `runS`, and a flag followed by another flag (or by
// nothing) is a boolean.
let args;
try { args = parseArgs(process.argv.slice(2)); }
catch (e) { console.error(`coopprobe: ${e.message}`); process.exit(64); }

// --lane and --port/--signal-port are MUTUALLY EXCLUSIVE, same shape as
// gates.mjs and sp-equivalence.mjs (#158): both name the same ports, and
// silently letting one win is the #68 failure mode (`--lane C` ignored,
// probe runs on the shared defaults) wearing a different hat.
if (args.lane !== undefined && (args.port !== undefined || args.signalPort !== undefined)) {
  console.error('coopprobe: --lane and --port/--signal-port both set the ports — pass one, not both.');
  process.exit(64);
}
if (args.lane !== undefined) {
  let base;
  try { base = laneBase(args.lane); }
  catch (e) { console.error(`coopprobe: ${e.message}`); process.exit(64); }
  // base+4/base+5: base and base+1..3 are the ports gates.mjs's arms already
  // claim within a lane block, so coopprobe sits one step further in.
  args.port = String(base + 4);
  args.signalPort = String(base + 5);
}
const PORT = Number(strArg(args.port) ?? 5214);
const SIGNAL_PORT = Number(strArg(args.signalPort) ?? 5215);
const SEED = Number(strArg(args.seed, 1337));
const NETLAG = typeof args.netlag === 'string' ? args.netlag : null;
const NETLOSS = typeof args.netloss === 'string' ? args.netloss : null;
const RUN_S = Number(strArg(args.runS, 60));
// A shipped settings key, not a stub: `settings.spawnRate` is the "Enemy spawn
// rate" slider, and `Director` reads it as a live multiplier. Two survivors
// left to a scripted walk on the tuned curve die inside a minute — the first
// 60 s arm ended with both pages on the death screen and three checks red, and
// a second at 0.35 died at 55.1 s — a co-op probe that measures a corpse
// measures nothing. Turned down, not off: enemies still spawn, still replicate,
// still fill the snapshot (31 netIds crossed the wire at 0.35).
const SPAWN_RATE = Number(strArg(args.spawnRate, 0.12));
const SPAWN_SIGNAL = args.noSignal !== true;
const LABEL = typeof args.label === 'string' ? args.label
  : !SPAWN_SIGNAL ? 'deadsignal' : (NETLAG || NETLOSS) ? 'lag' : 'base';
const RECORD = path.resolve(strArg(args.record, `reviews/round9/coopprobe-${LABEL}.json`));
// The directory itself isn't caught by a `shots-` rule, but every file it
// writes is a .png and `.gitignore` discards those under reviews/** anyway —
// route through the helper regardless, so the next reader finds it here (#71).
const OUT = resolveOutDir(strArg(args.out, 'reviews/round9/coopprobe-shots'), { tool: 'coopprobe' });
const SETS = strArg(args.checks, 'base').split(',').map((s) => s.trim()).filter(Boolean);

const W = 1280, H = 720;

/** Every bound this probe imposes. Copied verbatim into the record. */
const CAP = {
  bootMs: 120000,          // page load -> title screen
  navMs: 30000,            // one menu transition
  roomCodeMs: 20000,       // Create room -> the grouped code (XXXX-XXXX) in [data-coop-code]
  formationMs: 30000,      // Join room -> both channels open and the host sees 2
  tickWindowMs: 5000,      // the window 'ticks-advance' measures over
  runS: RUN_S,             // scripted play after formation
};

// -------------------------------------------------------------- check registry
//
// The extension seam. Each check is { name, set, run(pages) -> { pass, detail } }
// where `pages` carries the two Playwright pages plus the helpers:
//   evalBoth(fn)    -> [hostResult, clientResult]
//   gameState(page) -> { paused, screen, tick, rosterCount, netIds, role, ... }
// A later slice adds a set name and its checks to this array; nothing else in
// this file needs to know the set exists.
const CHECKS = [
  {
    name: 'host-running',
    set: 'base',
    async run({ gameState, host }) {
      const s = await gameState(host);
      return {
        pass: s.paused === false && s.tick > 60,
        detail: `host paused=${s.paused} NetHost.tick=${s.tick} (want > 60) screen=${s.screen} role=${s.role}`,
      };
    },
  },
  {
    name: 'client-running',
    set: 'base',
    async run({ gameState, client }) {
      const s = await gameState(client);
      return {
        pass: s.paused === false && s.tick > 60,
        detail: `client paused=${s.paused} NetClient.tick=${s.tick} (want > 60) screen=${s.screen}`
          + ` role=${s.role} connected=${s.connected} myNetId=${s.myNetId}`,
      };
    },
  },
  {
    name: 'roster-2-both',
    set: 'base',
    async run({ gameState, host, client }) {
      const [h, c] = await Promise.all([gameState(host), gameState(client)]);
      return {
        pass: h.rosterCount === 2 && c.rosterCount === 2,
        detail: `host roster ${h.rosterCount} (NetHost.playerCount), client roster ${c.rosterCount}`
          + ' (PLAYER-kind entities in the newest snapshot); want 2 and 2',
      };
    },
  },
  {
    name: 'ticks-advance',
    set: 'base',
    async run({ gameState, host, client }) {
      const [h0, c0] = await Promise.all([gameState(host), gameState(client)]);
      await sleep(CAP.tickWindowMs);
      const [h1, c1] = await Promise.all([gameState(host), gameState(client)]);
      const dh = h1.tick - h0.tick, dc = c1.tick - c0.tick;
      return {
        pass: dh > 0 && dc > 0,
        detail: `over ${CAP.tickWindowMs} ms: host tick ${h0.tick} -> ${h1.tick} (+${dh}),`
          + ` client tick ${c0.tick} -> ${c1.tick} (+${dc}); want both strictly increasing`,
      };
    },
  },
  {
    // Not in the slice brief's five. It earns its place as the check that names
    // the one way this probe's scripted play can invalidate every other check:
    // a survivor dies, the death screen pauses the world, and 'host-running',
    // 'client-running' and 'ticks-advance' all go red without saying why.
    name: 'both-alive',
    set: 'base',
    async run({ evalBoth }) {
      const [h, c] = await evalBoth(() => ({
        alive: globalThis.__GAME__?.ctx?.player?.alive !== false,
        screen: globalThis.__GAME__?.ctx?.hud?.menus?.screen ?? null,
      }));
      return {
        pass: h.alive && c.alive,
        detail: `host alive=${h.alive} screen=${h.screen}; client alive=${c.alive} screen=${c.screen}`
          + `${runWindowEndedEarly ? ` — ${runWindowEndedEarly}` : ''}`,
      };
    },
  },
  {
    name: 'shared-world',
    set: 'base',
    async run({ gameState, host, client }) {
      const [h, c] = await Promise.all([gameState(host), gameState(client)]);
      const hostIds = new Set(h.netIds);
      const shared = c.netIds.filter((id) => hostIds.has(id));
      return {
        pass: shared.length > 0,
        detail: `host has ${h.netIds.length} replicated netIds, client sees ${c.netIds.length};`
          + ` intersection ${shared.length}`
          + ` [${shared.slice(0, 8).join(',')}${shared.length > 8 ? ',...' : ''}]`,
      };
    },
  },

  {
    // The signature economy on the wire (issue #167, `MSG.WORLD`). Every other
    // check here reads entities out of a snapshot; this one is the only witness
    // that the *world-level* state — the corruption gauge, the purse, the band
    // — actually crosses, and it exists because #167 shipped with a unit test
    // and nothing that had ever seen two real pages disagree.
    //
    // Deliberately cheap and deterministic: one direct authoritative `feed` on
    // the host, then poll the client until it agrees. No scripted play, no
    // timing window to lose, and the amount is small enough to leave the gauge
    // inside the first band so the checks around it see the run they expect.
    name: 'world-economy-replicates',
    set: 'base',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__?.ctx;
        if (!ctx?.corruption) return { error: 'the host has no corruption system' };
        const before = ctx.corruption.world;
        // Attributed to the host's own survivor, through the real authoritative
        // path — not a field poke, so the mint and the band ride along too.
        const added = ctx.corruption.feed(ctx.player, 25);
        return { before, added, after: ctx.corruption.world, peak: ctx.corruption.peak };
      });
      if (setup.error) return { pass: false, detail: setup.error };
      if (!(setup.added > 0)) {
        return { pass: false, detail: `the host's own feed did nothing (world ${setup.after})` };
      }

      let c = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        c = await client.evaluate(() => {
          const cor = globalThis.__GAME__?.ctx?.corruption;
          return cor ? { world: cor.world, band: cor.band, peak: cor.peak, marks: cor.marks } : null;
        });
        if (c && Math.abs(c.world - setup.after) < 0.01) break;
        await sleep(200);
      }
      const h = await host.evaluate(() => {
        const cor = globalThis.__GAME__.ctx.corruption;
        return { world: cor.world, band: cor.band, peak: cor.peak, marks: cor.marks };
      });
      const pass = !!c && Math.abs(c.world - h.world) < 0.01 && c.band === h.band
        && Math.abs(c.peak - h.peak) < 0.01 && c.marks === h.marks;
      return {
        pass,
        detail: `host fed ${setup.added} (world ${setup.before.toFixed(1)} -> ${h.world.toFixed(1)});`
          + ` client reads world ${c?.world?.toFixed?.(1)} band ${c?.band} peak ${c?.peak?.toFixed?.(1)}`
          + ` marks ${c?.marks}; host band ${h.band} peak ${h.peak.toFixed(1)} marks ${h.marks}`,
      };
    },
  },

  // ------------------------------------------------------------- p2 check-set
  //
  // Per-pawn economy (PROTOCOL_VERSION 6, `docs/superpowers/plans/2026-08-12-
  // mp-p2-per-player-economy.md`): every pawn owns its own `Items` instance
  // (`Items.of`), a host resolves an interaction against the pawn that
  // pressed (`Interactables.requestInteract(pawn)`), and a kill pays every
  // registered pawn in full (`Items.rewardKillAll`). These three checks drive
  // the client's pawn — never a shared purse — through those exact seams and
  // read the result back from *both* machines, so a bug that only shows up on
  // one side of the wire (the forwarded `goldChanged`/`itemPickup` routing)
  // cannot hide behind a host-only assertion.
  //
  // The first three drive the client pawn through the host page: two headed
  // pages sharing one focused OS cursor cannot both *walk* a pawn to a chest,
  // so the host — authoritative for both pawns' positions and every economy
  // call — parks `ctx.coop.pawns[0]` (the client's pawn, from the host's side
  // of the wire) where it needs to be and calls the authority path directly.
  // Recorded, not hidden: that is a shortcut around real input.
  //
  // The two arms after them are not: they start at a real key press on the
  // client page, because a key can be sent to an unfocused page even when a
  // mouse cannot, and they are what proves the client->host input seams
  // (`BTN.INTERACT`, `BTN.EQUIP`) exist outside of unit tests.
  {
    name: 'p2-chest-charges-actor',
    set: 'p2',
    async run({ host, client }) {
      const GRANT = 5000; // clears the most expensive chest on the stage (legendary, ~400 * 1.25^stage)
      const setup = await host.evaluate((grant) => {
        const ctx = globalThis.__GAME__?.ctx;
        const remote = ctx?.coop?.pawns?.[0];
        if (!remote) return { error: 'no remote pawn on host (ctx.coop.pawns is empty)' };
        const chest = (ctx.interactables?.list ?? []).find((it) => it.cost > 0 && it.available());
        if (!chest) return { error: 'no available chest with cost > 0 on the stage' };
        remote.items.addGold(grant);
        remote.position.set(chest.position.x, chest.position.y, chest.position.z);
        return {
          chestCost: chest.cost,
          remoteGoldBefore: remote.items.gold,
          hostGoldBefore: ctx.items.gold,
        };
      }, GRANT);
      if (setup.error) return { pass: false, detail: setup.error };

      const result = await host.evaluate(() => {
        const ctx = globalThis.__GAME__.ctx;
        const remote = ctx.coop.pawns[0];
        const opened = ctx.interactables.requestInteract(remote);
        return { opened, remoteGoldAfter: remote.items.gold, hostGoldAfter: ctx.items.gold };
      });

      const want = setup.remoteGoldBefore - setup.chestCost;
      // The forwarded `goldChanged` crosses a real data channel; give it a
      // bounded window to land rather than reading a stale mirror.
      let clientGold = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        clientGold = await client.evaluate(() => globalThis.__GAME__?.ctx?.items?.gold ?? null);
        if (clientGold === want) break;
        await sleep(200);
      }

      const pass = result.opened === true
        && result.remoteGoldAfter === want
        && clientGold === want
        && result.hostGoldAfter === setup.hostGoldBefore;
      return {
        pass,
        detail: `chest cost $${setup.chestCost}, opened=${result.opened};`
          + ` client pawn's gold (host's view) ${setup.remoteGoldBefore} -> ${result.remoteGoldAfter}`
          + ` (want ${want}); client's own view of its gold -> ${clientGold} (want ${want});`
          + ` host player's own gold ${setup.hostGoldBefore} -> ${result.hostGoldAfter} (want unchanged)`,
      };
    },
  },
  {
    name: 'p2-kill-pays-all',
    set: 'p2',
    async run({ host, client }) {
      const before = await host.evaluate(() => {
        const ctx = globalThis.__GAME__?.ctx;
        const remote = ctx?.coop?.pawns?.[0];
        if (!remote) return { error: 'no remote pawn on host (ctx.coop.pawns is empty)' };
        return { hostGold: ctx.items.gold, remoteGold: remote.items.gold };
      });
      if (before.error) return { pass: false, detail: before.error };

      // A live target is not guaranteed the instant the checks start (the
      // scripted run window drives movement, not combat) — poll for one
      // inside a bound rather than assume the stage still has a corpse to
      // make.
      let found = false;
      const findDeadline = Date.now() + 8000;
      while (Date.now() < findDeadline) {
        found = await host.evaluate(() => {
          const ctx = globalThis.__GAME__.ctx;
          const e = (ctx.director?.enemies ?? []).find((u) => u?.alive);
          if (!e) return false;
          ctx.combat.applyDamage(e, (e.maxHealth || e.health || 100) * 4 + (e.shield || 0) + 1000,
            { source: null, ignoreArmor: true, type: 'p2-probe' });
          return true;
        });
        if (found) break;
        await sleep(300);
      }
      if (!found) return { pass: false, detail: 'no live enemy appeared within 8000 ms to kill' };

      await sleep(400); // let rewardKillAll and the forwarded goldChanged settle
      const after = await host.evaluate(() => {
        const ctx = globalThis.__GAME__.ctx;
        const remote = ctx.coop.pawns[0];
        return { hostGold: ctx.items.gold, remoteGold: remote.items.gold };
      });

      let clientGold = null;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        clientGold = await client.evaluate(() => globalThis.__GAME__?.ctx?.items?.gold ?? null);
        if (clientGold === after.remoteGold) break;
        await sleep(150);
      }

      const hostDelta = after.hostGold - before.hostGold;
      const remoteDelta = after.remoteGold - before.remoteGold;
      const pass = hostDelta > 0 && hostDelta === remoteDelta && clientGold === after.remoteGold;
      return {
        pass,
        detail: `host player's gold ${before.hostGold} -> ${after.hostGold} (+${hostDelta});`
          + ` client pawn's gold (host's view) ${before.remoteGold} -> ${after.remoteGold} (+${remoteDelta});`
          + ` client's own view of its gold -> ${clientGold}; want two equal, positive deltas`,
      };
    },
  },
  // The two arms below are the ones the earlier p2 set stepped over: they start
  // at a REAL key press on the client page and end at host state. Nothing in
  // between is stubbed — `NetClient._sampleInput` packs the bit, the wire
  // carries it, `NetHost.fixedUpdate` feeds it to `applyCommand`, and the host
  // resolves it against the pressing pawn. A key is held for 200 ms rather than
  // tapped because the client samples input once per fixed step.
  {
    name: 'p2-client-interact-opens-chest',
    set: 'p2',
    async run({ host, client }) {
      const GRANT = 5000;
      const setup = await host.evaluate((grant) => {
        const ctx = globalThis.__GAME__?.ctx;
        const remote = ctx?.coop?.pawns?.[0];
        if (!remote) return { error: 'no remote pawn on host (ctx.coop.pawns is empty)' };
        const chest = (ctx.interactables?.list ?? []).find((it) => it.cost > 0 && it.available());
        if (!chest) return { error: 'no available chest with cost > 0 on the stage' };
        remote.items.addGold(grant);
        remote.position.set(chest.position.x, chest.position.y, chest.position.z);
        ctx.__probeChest = chest;
        return { chestCost: chest.cost, remoteGoldBefore: remote.items.gold, hostGoldBefore: ctx.items.gold };
      }, GRANT);
      if (setup.error) return { pass: false, detail: setup.error };

      await client.bringToFront();
      await client.keyboard.down('KeyE');
      await sleep(200);
      await client.keyboard.up('KeyE');

      let after = null;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        after = await host.evaluate(() => {
          const ctx = globalThis.__GAME__.ctx;
          return {
            opened: ctx.__probeChest.available() === false,
            remoteGold: ctx.coop.pawns[0].items.gold,
            hostGold: ctx.items.gold,
          };
        });
        if (after.opened) break;
        await sleep(200);
      }

      const want = setup.remoteGoldBefore - setup.chestCost;
      const pass = !!after && after.opened && after.remoteGold === want
        && after.hostGold === setup.hostGoldBefore;
      return {
        pass,
        detail: `a real E on the client page: chest cost $${setup.chestCost}, opened=${after?.opened};`
          + ` client pawn's gold (host's view) ${setup.remoteGoldBefore} -> ${after?.remoteGold} (want ${want});`
          + ` host player's own gold ${setup.hostGoldBefore} -> ${after?.hostGold} (want unchanged).`
          + ' This is the whole BTN.INTERACT path — client input, wire, host roster scan, Items.of',
      };
    },
  },
  {
    name: 'p2-equipment-fires',
    set: 'p2',
    async run({ host, client }) {
      // Combat Stim: no aim ray, no target search, so "did it fire" is a clean
      // question. Both slots are loaded so the check can prove the host's own
      // charge was NOT the one spent.
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__?.ctx;
        const remote = ctx?.coop?.pawns?.[0];
        if (!remote) return { error: 'no remote pawn on host (ctx.coop.pawns is empty)' };
        for (const items of [remote.items, ctx.items]) {
          items.setEquipment('stim-injector');
          items.equipCharges = 1;
          items.equipTimer = 0;
        }
        return { remoteCharges: remote.items.equipCharges, hostCharges: ctx.items.equipCharges };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      await client.bringToFront();
      await client.keyboard.down('KeyF');
      await sleep(200);
      await client.keyboard.up('KeyF');

      let after = null;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        after = await host.evaluate(() => {
          const ctx = globalThis.__GAME__.ctx;
          return {
            remoteCharges: ctx.coop.pawns[0].items.equipCharges,
            hostCharges: ctx.items.equipCharges,
            remoteBuff: !!ctx.coop.pawns[0].items.buffs?.has?.('berzerk'),
          };
        });
        if (after.remoteCharges === 0) break;
        await sleep(150);
      }

      const pass = !!after && after.remoteCharges === 0 && after.remoteBuff
        && after.hostCharges === setup.hostCharges;
      return {
        pass,
        detail: `a real F on the client page: client pawn's equipment charges (host's view)`
          + ` ${setup.remoteCharges} -> ${after?.remoteCharges} (want 0), its stim buff live=${after?.remoteBuff};`
          + ` host player's own charges ${setup.hostCharges} -> ${after?.hostCharges} (want unchanged).`
          + ' BTN.EQUIP end to end, resolved on the joiner\'s own Items',
      };
    },
  },
  {
    name: 'p2-inventory-isolated',
    set: 'p2',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__?.ctx;
        const remote = ctx?.coop?.pawns?.[0];
        if (!remote) return { error: 'no remote pawn on host (ctx.coop.pawns is empty)' };
        const id = remote.items.rollItem(null, 'common') ?? remote.items.rollItem(null, 'uncommon');
        if (!id) return { error: 'rollItem returned no id to grant' };
        const hostHadBefore = ctx.items.count(id);
        remote.items.give(id, 1);
        return { id, hostHadBefore, remoteHasAfter: remote.items.count(id) };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      let clientHas = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        clientHas = await client.evaluate((id) => globalThis.__GAME__?.ctx?.items?.count?.(id) ?? 0, setup.id);
        if (clientHas > 0) break;
        await sleep(200);
      }

      const hostHasAfter = await host.evaluate((id) => globalThis.__GAME__.ctx.items.count(id), setup.id);

      const pass = setup.remoteHasAfter >= 1 && clientHas >= 1 && hostHasAfter === setup.hostHadBefore;
      return {
        pass,
        detail: `granted item id ${setup.id} to the client's pawn; client pawn's own count`
          + ` (host's view) -> ${setup.remoteHasAfter}; client's own inventory count -> ${clientHas};`
          + ` host viewer's own count of the same id ${setup.hostHadBefore} -> ${hostHasAfter} (want unchanged)`,
      };
    },
  },

  // ------------------------------------------------------------- p3 check-set
  //
  // Downed/revive lifecycle (PROTOCOL_VERSION 7, docs/superpowers/plans/
  // 2026-08-12-mp-p3-downed-revive.md): lethal damage on a pawn with a living
  // teammate goes down instead of dying (`Combat.enterDowned`), `Revive.
  // fixedUpdate` runs the bleed-out clock and the pick-up race, and
  // `Progression.advanceStage`/`Revive._returnParty` hand a dead party back
  // their legs. Six checks walk that lifecycle start to finish in one
  // continuous session, in registration order, each numbered so the next
  // starts from the state the last one left behind: downed -> (P1's targeting
  // fix, re-verified while the body is still on the floor) -> revived ->
  // downed again -> bled out dead -> stage-returned alive with its build
  // intact -> wiped. Nothing here re-arms with a second down/kill of a pawn
  // the previous check didn't leave in the right state; a check that finds
  // the pawn in the wrong state fails loudly with what it expected instead of
  // silently re-arming around a bug.
  //
  // P2's economy isolation (rule 4's other prior-fix) is NOT re-verified with
  // a new check here: `p2-chest-charges-actor` (above) already drives a
  // directed `goldChanged` end to end and asserts it lands on the owning peer
  // alone, and `Revive.js`'s own header states the invariant that makes a
  // second, post-revive version of that check redundant rather than merely
  // convenient — "it never touches a pawn's build: `items` is not its
  // business and is exactly what survives a death untouched." Run with
  // `--checks base,p2,p3` and the p2 set proves the economy seam on the same
  // pawn this set puts through downed/revive/death/return.
  //
  // The client's pawn is always the one put through the lifecycle
  // (`ctx.coop.pawns[0]` on the host, the same administrative shortcut the p2
  // set uses for setup that isn't the seam under test); the host's own
  // survivor is the one real input drives, exactly once, for the one check
  // where the seam under test — a teammate reviving another player — actually
  // runs through it.
  {
    name: 'p3-downed-replicates',
    set: 'p3',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__?.ctx;
        const remote = ctx?.coop?.pawns?.[0];
        if (!remote) return { error: 'no remote pawn on host (ctx.coop.pawns is empty)' };
        if (!ctx.player?.alive || !remote.alive || remote.downed) {
          return { error: `both pawns must be alive and standing going in (host alive=${ctx.player?.alive},`
            + ` remote alive=${remote.alive}, remote downed=${remote.downed})` };
        }
        ctx.combat.applyDamage(remote, (remote.maxHealth || 100) * 4 + 1000,
          { source: null, ignoreArmor: true, type: 'p3-probe' });
        return { downedOnHost: remote.downed === true };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      // "Within 1 s": poll at a fine grain rather than sleep-then-check-once,
      // so a pass reports how much of the second it actually used.
      let seenAt = null;
      let last = null;
      const start = Date.now();
      const deadline = start + 1000;
      while (Date.now() < deadline) {
        last = await client.evaluate(() => {
          const el = document.querySelector('.downed-overlay');
          return {
            downed: globalThis.__GAME__?.ctx?.player?.downed === true,
            hudIsDowned: document.getElementById('hud')?.classList.contains('is-downed') ?? false,
            overlayOpacity: el ? getComputedStyle(el).opacity : null,
          };
        });
        if (last.downed && last.hudIsDowned) { seenAt = Date.now() - start; break; }
        await sleep(50);
      }

      const pass = setup.downedOnHost === true && !!last?.downed && !!last?.hudIsDowned;
      return {
        pass,
        detail: `host: remote pawn downed=${setup.downedOnHost}; client: ctx.player.downed=${last?.downed},`
          + ` #hud.is-downed=${last?.hudIsDowned} (want both true within 1000 ms, seen at`
          + ` ${seenAt === null ? 'not seen' : `${seenAt} ms`}); .downed-overlay computed opacity`
          + ` at that read = ${last?.overlayOpacity} (CSS transitions this over 0.4 s, not gated on)`,
      };
    },
  },
  {
    // Roadmap rule 4 re-verification: P1's 40 m acquisition slice claims a
    // downed pawn is never a legal target via `Roster.targetable`, but that
    // filter only runs where a caller asks it to. This reads the field every
    // live enemy actually carries (`Enemy.js:569`, `acquireTarget`) rather
    // than trusting the filter's own claim — runs immediately after the check
    // above, while the client pawn from that check is still on the floor.
    name: 'p3-downed-excluded-from-targeting',
    set: 'p3',
    async run({ host }) {
      let r = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        r = await host.evaluate(() => {
          const ctx = globalThis.__GAME__.ctx;
          const remote = ctx.coop.pawns[0];
          if (!remote?.downed) return { error: 're-arm order broken: the client pawn is not downed' };
          const enemies = (ctx.combat?.entities ?? []).filter((e) => e && 'targetPlayer' in e);
          const holders = enemies.filter((e) => e.targetPlayer === remote).length;
          return { holders, enemyCount: enemies.length };
        });
        if (r.error || r.enemyCount > 0) break;
        await sleep(250);
      }
      if (r.error) return { pass: false, detail: r.error };
      return {
        pass: r.holders === 0,
        detail: `${r.enemyCount} live enemies carry targetPlayer; ${r.holders} hold the downed client`
          + ` pawn as their target (want 0)`
          + (r.enemyCount === 0 ? ' — no enemy was on the stage to test against; assertion is vacuous' : ''),
      };
    },
  },
  {
    name: 'p3-revive-completes',
    set: 'p3',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__.ctx;
        const remote = ctx.coop.pawns[0];
        if (!remote?.downed) return { error: 're-arm order broken: the client pawn is not downed' };
        // Real input drives the hold below; this positions the reviver, which
        // is administrative setup, the same distinction the p2 set draws.
        ctx.player.position.set(remote.position.x, remote.position.y, remote.position.z);
        return { ok: true };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      await host.bringToFront();
      await host.keyboard.down('KeyE');
      // REVIVE.REVIVE_S plus slack for the hold to register and for the
      // snapshot carrying the result to reach the client.
      await sleep(REVIVE.REVIVE_S * 1000 + 2500);
      await host.keyboard.up('KeyE');

      let h = null, c = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        h = await host.evaluate(() => {
          const remote = globalThis.__GAME__.ctx.coop.pawns[0];
          return { downed: remote.downed === true, health: remote.health, maxHealth: remote.maxHealth || 100 };
        });
        c = await client.evaluate(() => {
          const p = globalThis.__GAME__.ctx.player;
          return { downed: p.downed === true, health: p.health, maxHealth: p.maxHealth || 100 };
        });
        if (h.downed === false && c.downed === false) break;
        await sleep(200);
      }

      const wantFrac = REVIVE.REVIVE_HEALTH_FRAC;
      const hFrac = h ? h.health / h.maxHealth : null;
      const cFrac = c ? c.health / c.maxHealth : null;
      const close = (f) => f !== null && Math.abs(f - wantFrac) < 0.05;
      const pass = h?.downed === false && c?.downed === false && close(hFrac) && close(cFrac);
      return {
        pass,
        detail: `host held KeyE at the body for ${REVIVE.REVIVE_S}s+slack; host view: downed=${h?.downed}`
          + ` health ${h?.health?.toFixed?.(1)}/${h?.maxHealth} (${hFrac?.toFixed(2)}); client view:`
          + ` downed=${c?.downed} health ${c?.health?.toFixed?.(1)}/${c?.maxHealth} (${cFrac?.toFixed(2)});`
          + ` want both false, ~${wantFrac} of max`,
      };
    },
  },
  {
    name: 'p3-bleedout-kills',
    set: 'p3',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__.ctx;
        const remote = ctx.coop.pawns[0];
        if (!remote?.alive || remote.downed) {
          return { error: `client pawn must be alive and standing (check 3 must have revived it): alive=${remote?.alive}, downed=${remote?.downed}` };
        }
        // Granted before the down, through the same per-pawn `Items` instance
        // `Items.of(ctx, remote)` produced (`remote.items`, the p2-inventory-
        // isolated idiom) — check 5 (stage-return) compares this count against
        // what the pawn is still holding after it dies and comes back.
        const id = remote.items.rollItem(null, 'common') ?? remote.items.rollItem(null, 'uncommon');
        if (!id) return { error: 'rollItem returned no id to grant' };
        remote.items.give(id, 1);
        ctx.__probeP3ItemId = id;
        ctx.combat.applyDamage(remote, (remote.maxHealth || 100) * 4 + 1000,
          { source: null, ignoreArmor: true, type: 'p3-probe' });
        return { itemId: id, itemCountBefore: remote.items.count(id), downedOnHost: remote.downed === true };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      // Nobody revives: no key is held on either page for the whole window.
      // The clock has to run out on its own — REVIVE.BLEEDOUT_S plus slack for
      // the tick that crosses the epsilon in Revive.fixedUpdate and the
      // snapshot/forwarded playerDead that carries the result to the client.
      let hostDead = false, clientDead = false, clientScreen = null;
      const deadline = Date.now() + (REVIVE.BLEEDOUT_S + 6) * 1000;
      while (Date.now() < deadline) {
        hostDead = await host.evaluate(() => globalThis.__GAME__.ctx.coop.pawns[0]?.alive === false);
        const c = await client.evaluate(() => ({
          alive: globalThis.__GAME__?.ctx?.player?.alive,
          screen: globalThis.__GAME__?.ctx?.hud?.menus?.screen ?? null,
        }));
        clientDead = c.alive === false;
        clientScreen = c.screen;
        if (hostDead && clientDead) break;
        await sleep(500);
      }

      const pass = setup.downedOnHost === true && hostDead === true && clientDead === true;
      return {
        pass,
        detail: `granted item ${setup.itemId} (count ${setup.itemCountBefore}) before the down; downed on`
          + ` the host=${setup.downedOnHost}; after up to ${REVIVE.BLEEDOUT_S + 6}s with nobody reviving:`
          + ` host sees the client pawn alive===false -> ${hostDead}; client's own alive -> ${clientDead},`
          + ` hud screen -> ${clientScreen} (want both dead — netState DEAD / playerDead observed on both)`,
      };
    },
  },
  {
    name: 'p3-stage-return',
    set: 'p3',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__.ctx;
        const remote = ctx.coop.pawns[0];
        const id = ctx.__probeP3ItemId;
        if (remote?.alive !== false || id == null) {
          return { error: `client pawn must be dead with a tracked item id from check 4 (alive=${remote?.alive}, id=${id})` };
        }
        const before = remote.items.count(id);
        // `Progression.advanceStage()` is the direct headless handle: no
        // teleporter charge is walked to completion, which is recorded here
        // as the bounded shortcut it is.
        ctx.progression.advanceStage();
        return { itemId: id, itemCountBefore: before };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      let h = null, c = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        h = await host.evaluate((id) => {
          const remote = globalThis.__GAME__.ctx.coop.pawns[0];
          return { alive: remote.alive === true, health: remote.health, maxHealth: remote.maxHealth || 100, itemCount: remote.items.count(id) };
        }, setup.itemId);
        c = await client.evaluate((id) => {
          const ctx = globalThis.__GAME__.ctx;
          return { alive: ctx.player.alive === true, health: ctx.player.health, maxHealth: ctx.player.maxHealth || 100, itemCount: ctx.items.count(id) };
        }, setup.itemId);
        if (h.alive && c.alive) break;
        await sleep(300);
      }

      const wantFrac = REVIVE.RETURN_HEALTH_FRAC;
      const hFrac = h ? h.health / h.maxHealth : null;
      const cFrac = c ? c.health / c.maxHealth : null;
      const close = (f) => f !== null && Math.abs(f - wantFrac) < 0.05;
      const pass = h?.alive === true && c?.alive === true && close(hFrac) && close(cFrac)
        && setup.itemCountBefore > 0 && h?.itemCount === setup.itemCountBefore && c?.itemCount === setup.itemCountBefore;
      return {
        pass,
        detail: `item ${setup.itemId} held count ${setup.itemCountBefore} going into the return; host view:`
          + ` alive=${h?.alive} health ${h?.health?.toFixed?.(1)}/${h?.maxHealth} (${hFrac?.toFixed(2)})`
          + ` itemCount=${h?.itemCount}; client view: alive=${c?.alive} health ${c?.health?.toFixed?.(1)}/`
          + `${c?.maxHealth} (${cFrac?.toFixed(2)}) itemCount=${c?.itemCount}; want both alive, ~${wantFrac}`
          + ` of max, and both item counts unchanged and > 0`,
      };
    },
  },
  {
    name: 'p3-wipe-ends-run',
    set: 'p3',
    async run({ host, client }) {
      const setup = await host.evaluate(() => {
        const ctx = globalThis.__GAME__.ctx;
        const remote = ctx.coop.pawns[0];
        if (!remote?.alive || !ctx.player.alive) {
          return { error: `both pawns must be alive going in (check 5 must have returned the party): remote=${remote?.alive}, host=${ctx.player.alive}` };
        }
        // Client pawn first, host pawn last, exactly as the brief orders it:
        // the wipe fork (`Revive.fixedUpdate`'s `standing === 0` scan) only
        // fires once nobody is left standing, so the second hit is the one
        // that actually trips it.
        ctx.combat.applyDamage(remote, (remote.maxHealth || 100) * 4 + 1000,
          { source: null, ignoreArmor: true, type: 'p3-probe' });
        const remoteDownedFirst = remote.downed === true;
        ctx.combat.applyDamage(ctx.player, (ctx.player.maxHealth || 100) * 4 + 1000,
          { source: null, ignoreArmor: true, type: 'p3-probe' });
        return { remoteDownedFirst };
      });
      if (setup.error) return { pass: false, detail: setup.error };

      let hostScreen = null, clientScreen = null, hostAlive = null, clientAlive = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const h = await host.evaluate(() => ({
          screen: globalThis.__GAME__?.ctx?.hud?.menus?.screen ?? null,
          alive: globalThis.__GAME__?.ctx?.player?.alive,
        }));
        const c = await client.evaluate(() => ({
          screen: globalThis.__GAME__?.ctx?.hud?.menus?.screen ?? null,
          alive: globalThis.__GAME__?.ctx?.player?.alive,
        }));
        hostScreen = h.screen; hostAlive = h.alive;
        clientScreen = c.screen; clientAlive = c.alive;
        if (hostScreen === 'death' && clientScreen === 'death') break;
        await sleep(300);
      }

      const pass = hostScreen === 'death' && clientScreen === 'death' && hostAlive === false && clientAlive === false;
      return {
        pass,
        detail: `client pawn downed first (downed=${setup.remoteDownedFirst}), host pawn downed last —`
          + ` the wipe should finish both. host: screen -> ${hostScreen}, alive -> ${hostAlive}; client:`
          + ` screen -> ${clientScreen}, alive -> ${clientAlive} (want both 'death' / false)`,
      };
    },
  },
];

const KNOWN_SETS = [...new Set(CHECKS.map((c) => c.set))];
for (const s of SETS) {
  if (!KNOWN_SETS.includes(s)) {
    console.error(`coopprobe: unknown check-set "${s}". Known sets: ${KNOWN_SETS.join(', ')}`);
    process.exit(2);
  }
}
const SELECTED = CHECKS.filter((c) => SETS.includes(c.set));
const SKIPPED = CHECKS.filter((c) => !SETS.includes(c.set)).map((c) => `${c.name} (set "${c.set}")`);

// ------------------------------------------------------------------- utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const at = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[coop ${at()}]`, ...a);

const checks = [];
const ok = (name, set, cond, detail) => {
  console.log(`  ${cond ? 'PASS ' : 'FAIL '} ${name} — ${detail}`);
  checks.push({ name, set, pass: !!cond, detail: String(detail) });
};

const phases = [];
/** Run one named phase with a wall-clock stamp; a throw is recorded, then rethrown. */
const phase = async (name, fn) => {
  const start = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    phases.push({ name, ms, ok: true, detail: detail ?? null });
    log(`${name}: ${ms} ms${detail ? ` — ${detail}` : ''}`);
    return detail;
  } catch (err) {
    const ms = Date.now() - start;
    const detail = String(err?.message ?? err).slice(0, 400);
    phases.push({ name, ms, ok: false, detail });
    log(`${name}: FAILED after ${ms} ms — ${detail}`);
    throw err;
  }
};

const consoleErrors = { host: [], client: [] };

/**
 * Everything a check is allowed to ask a page about the running game.
 *
 * `tick` is the net system's own fixed-step counter (`NetHost.tick` /
 * `NetClient.tick`) and deliberately not `engine.frame`: frames advance while
 * the world is paused, sim ticks do not, so this is the only counter for which
 * "the game is running" and "the number went up" are the same statement.
 *
 * The two roster counts are measured differently because the two roles know
 * different things: the host counts its own connected peers, and the client can
 * only count what arrived — the PLAYER-kind entities in the newest snapshot,
 * which is its own pawn plus the host's survivor.
 */
const gameState = (page) => page.evaluate(() => {
  const ctx = globalThis.__GAME__?.ctx;
  const net = ctx?.net ?? null;
  const mode = ctx?.lobby?.mode ?? 'single';
  const EKIND_PLAYER = 1;  // src/net/Protocol.js

  let rosterCount = 1;
  let netIds = [];
  if (mode === 'host') {
    rosterCount = net?.playerCount ?? 1;
    for (const e of ctx?.combat?.entities ?? []) if (e?.netId) netIds.push(e.netId);
    for (const it of ctx?.interactables?.replicable?.() ?? []) if (it?.netId) netIds.push(it.netId);
  } else if (mode === 'client') {
    const live = net?.buffer?.liveIds?.() ?? null;
    if (live) {
      netIds = [...live.keys()];
      rosterCount = [...live.values()].filter((e) => e.kind === EKIND_PLAYER).length;
    } else {
      rosterCount = 0;
    }
  }

  return {
    paused: !!ctx?.paused,
    screen: ctx?.hud?.menus?.screen ?? null,
    tick: net?.tick ?? 0,
    rosterCount,
    netIds,
    role: ctx?.netRole ?? mode,
    connected: !!net?.connected,
    myNetId: net?.myNetId ?? null,
    coopStatus: document.querySelector('[data-coop-status]')?.textContent?.trim()?.slice(0, 200) ?? null,
  };
});

/** ICE / channel state, for the evidence a failed formation has to carry. */
const wireState = (page) => page.evaluate(() => {
  const ctx = globalThis.__GAME__?.ctx;
  const net = ctx?.net ?? null;
  const peers = [...(net?.clients?.values?.() ?? [])].map((c) => ({
    id: c.peer?.id ?? null,
    pawn: !!c.pawn,
    state: c.peer?.state?.readyState ?? null,
    events: c.peer?.events?.readyState ?? null,
  }));
  return {
    // The loop and the lag rig's own backlog. A `?netlag=` queue that is not
    // empty while `frame` is not advancing is a stalled pump, not a slow
    // network, and those two failures are indistinguishable from the outside.
    frame: globalThis.__GAME__?.engine?.frame ?? null,
    engineRunning: !!globalThis.__GAME__?.engine?.running,
    simQueue: ctx?.net?.transport?.peer?._simQueue?.length
      ?? ctx?.net?.peer?._simQueue?.length ?? null,
    lobbyMode: ctx?.lobby?.mode ?? 'single',
    lobbyStatus: ctx?.lobby?.status ?? null,
    coopStatus: document.querySelector('[data-coop-status]')?.textContent?.trim()?.slice(0, 300) ?? null,
    roomCode: document.querySelector('[data-coop-code]')?.textContent?.trim() ?? null,
    wiring: document.querySelector('[data-coop-wiring]')?.textContent?.trim()?.slice(0, 300) ?? null,
    connected: !!net?.connected,
    myNetId: net?.myNetId ?? null,
    trickle: net?.transport?.trickle ?? null,
    iceConnectionState: net?.transport?.pc?.iceConnectionState ?? null,
    connectionState: net?.transport?.pc?.connectionState ?? null,
    channels: {
      state: net?.peer?.state?.readyState ?? null,
      events: net?.peer?.events?.readyState ?? null,
    },
    hostPeers: peers,
  };
});

// ---------------------------------------------------------------------- run
let relay = null;
let vite = null;
let browser = null;
let hostPage = null;
let clientPage = null;
let fatal = null;
let roomCode = null;
let formationMs = null;
let runWindowEndedEarly = null;

// The record is invalidated before anything runs — padprobe's rule. A probe that
// throws part way must never leave the previous green record on disk looking
// like it describes this HEAD.
await mkdir(path.dirname(RECORD), { recursive: true });
await mkdir(OUT, { recursive: true });
await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(), probe: 'tools/coopprobe.mjs', label: LABEL,
  aborted: 'run in progress — this file is rewritten when the probe finishes',
  checks: [], allPass: false,
}, null, 2)}\n`);

try {
  // -- the relay ------------------------------------------------------------
  if (SPAWN_SIGNAL) {
    await phase('relay', async () => {
      relay = spawn(process.execPath, [path.join(here, 'signal-server.mjs'), '--port', String(SIGNAL_PORT)],
        { stdio: ['ignore', 'pipe', 'inherit'] });
      const bound = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('signal-server never printed a port within 10 s')), 10000);
        relay.stdout.on('data', (b) => {
          const m = /ws:\/\/0\.0\.0\.0:(\d+)/.exec(String(b));
          if (m) { clearTimeout(timer); resolve(Number(m[1])); }
        });
        relay.on('exit', (code) => { clearTimeout(timer); reject(new Error(`signal-server exited (${code})`)); });
      });
      if (bound !== SIGNAL_PORT) throw new Error(`relay bound ${bound}, wanted ${SIGNAL_PORT}`);
      return `ws://127.0.0.1:${SIGNAL_PORT}`;
    });
  } else {
    log(`NEGATIVE CONTROL: no relay spawned — both pages point at the dead port ${SIGNAL_PORT}`);
    phases.push({
      name: 'relay', ms: 0, ok: true,
      detail: `skipped (--no-signal): port ${SIGNAL_PORT} is dead on purpose`,
    });
  }

  // -- vite -----------------------------------------------------------------
  await phase('vite', async () => {
    vite = await createServer({
      server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
    });
    await vite.listen();
    return `http://127.0.0.1:${PORT}`;
  });

  browser = await chromium.launch({
    timeout: 180000,
    // Headed and d3d11: headless Chromium software-renders the THREE scene and
    // has been observed never firing `load` inside 180 s (verify-trickle's
    // header documents the measurement). The backgrounding flags matter more
    // here than anywhere else — two live pages take turns being the focused
    // one, and a throttled rAF on the unfocused page reads as a stalled sim.
    headless: false,
    args: [
      '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--disable-frame-rate-limit', '--force_high_performance_gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-position=-2400,-2400', `--window-size=${W},${H}`,
    ],
  });

  /**
   * One page in its own fresh context.
   *
   * A context per page, not merely per run: `NetConfig` persists `?signal=`,
   * `?netlag=` and `?netloss=` into `localStorage`, so two pages sharing a
   * context share a key space and the client's impairment would be sitting in
   * the host's storage waiting for the next arm to read it.
   */
  const mkPage = async (tag, query) => {
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => {
      consoleErrors[tag].push(`pageerror: ${e.message}`.slice(0, 300));
      console.error(`  ${tag.toUpperCase()} PAGE ERROR`, e.message);
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors[tag].push(`console: ${m.text()}`.slice(0, 300));
    });
    // See the header: the one stub in this probe.
    await page.addInitScript(() => {
      Element.prototype.requestPointerLock = function requestPointerLock() { /* two pages, one focus */ };
      document.exitPointerLock = function exitPointerLock() { /* nothing to exit */ };
    });
    // Real settings, seeded before boot the way padprobe does it: a survivable
    // spawn rate, and silence — two headed pages on an unattended box.
    await page.addInitScript((blob) => {
      try { localStorage.setItem('telluric.settings', JSON.stringify(blob)); } catch { /* private mode */ }
    }, { spawnRate: SPAWN_RATE, master: 0, music: 0, sfx: 0 });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?${query}`, { waitUntil: 'load', timeout: CAP.bootMs });
    await page.waitForFunction(() => globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title'
      && globalThis.__HARNESS__ != null,
      null, { timeout: CAP.bootMs });
    return page;
  };

  const signalParam = `signal=${encodeURIComponent(`ws://127.0.0.1:${SIGNAL_PORT}`)}`;
  const baseQuery = `seed=${SEED}&quality=2&harness=1&${signalParam}`;
  const clientQuery = baseQuery
    + (NETLAG ? `&netlag=${encodeURIComponent(NETLAG)}` : '')
    + (NETLOSS ? `&netloss=${encodeURIComponent(NETLOSS)}` : '');

  // Screens are addressed by their `screen--*` class, never by `[data-screen=]`:
  // `Menus.open` stamps the *root* with `data-screen` too, so `[data-screen="coop"]
  // [data-act="back"]` matches every Back button in the whole overlay — seven of
  // them — and Playwright dutifully waits on the first, which is hidden.
  /** Title -> Play -> Launch, and wait for a world that is actually running. */
  const launchRun = async (page) => {
    await page.click('.screen--title [data-act="play"]');
    await page.waitForFunction(() => globalThis.__GAME__.ctx.hud.menus.screen === 'select',
      null, { timeout: CAP.navMs });
    await page.click('.screen--select [data-act="launch"]');
    await page.waitForFunction(() => globalThis.__GAME__.ctx.hud.menus.screen === null
      && globalThis.__GAME__.ctx.paused === false, null, { timeout: CAP.navMs });
  };

  /** Co-op, off whichever screen is open. */
  const openCoop = async (page) => {
    await page.click('.screen.is-open [data-act="coop"]');
    await page.waitForFunction(() => globalThis.__GAME__.ctx.hud.menus.screen === 'coop',
      null, { timeout: CAP.navMs });
  };

  /** The co-op screen's own Back button. */
  const leaveCoopScreen = async (page) => {
    await page.click('.screen--coop [data-act="back"]');
    await page.waitForFunction(() => globalThis.__GAME__.ctx.hud.menus.screen === 'title',
      null, { timeout: CAP.navMs });
  };

  // -- canary: page 1 boots and reaches the title before page 2 exists ------
  await phase('host-boot', async () => {
    hostPage = await mkPage('host', baseQuery);
    return `title screen up, seed ${SEED}`;
  });

  // -- host opens a room, through the menus ---------------------------------
  roomCode = await phase('host-room', async () => {
    await openCoop(hostPage);
    await hostPage.click('[data-act="coop-room-host"]');
    try {
      await hostPage.waitForFunction(
        () => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector('[data-coop-code]')?.textContent?.trim() ?? ''),
        null, { timeout: CAP.roomCodeMs });
    } catch {
      const w = await wireState(hostPage);
      throw new Error(`no room code inside ${CAP.roomCodeMs} ms — the co-op screen says`
        + ` "${w.coopStatus}" (lobby ${w.lobbyMode}/${w.lobbyStatus}; wiring: ${w.wiring})`);
    }
    const code = await hostPage.textContent('[data-coop-code]');
    return code.trim();
  });

  await phase('host-launch', async () => {
    await leaveCoopScreen(hostPage);
    await launchRun(hostPage);
    return `hosting room ${roomCode} with the world running`;
  });

  // -- page 2, with the host's loop parked across its load ------------------
  await phase('client-boot', async () => {
    // A live rAF loop on the host has starved a second page's load past 180 s
    // before now (verify-trickle). Park it across the load and thaw it before
    // anything is measured. `__HARNESS__` exists because both pages carry
    // `?harness=1`.
    await hostPage.evaluate(() => globalThis.__HARNESS__?.freeze?.());
    try {
      clientPage = await mkPage('client', clientQuery);
    } finally {
      await hostPage.evaluate(() => globalThis.__HARNESS__?.thaw?.());
    }
    return `title screen up${NETLAG ? `, netlag=${NETLAG}` : ''}${NETLOSS ? `, netloss=${NETLOSS}` : ''}`;
  });

  // -- the join, through the menus, and the formation wait ------------------
  await phase('formation', async () => {
    await openCoop(clientPage);
    await clientPage.fill('[data-coop-roomcode]', roomCode);
    const start = Date.now();
    await clientPage.click('[data-act="coop-room-join"]');
    try {
      await clientPage.waitForFunction(() => {
        const net = globalThis.__GAME__?.ctx?.net;
        return net?.connected === true && net.myNetId > 0
          && net.peer?.state?.readyState === 'open' && net.peer?.events?.readyState === 'open';
      }, null, { timeout: CAP.formationMs });
      await hostPage.waitForFunction(() => (globalThis.__GAME__?.ctx?.net?.playerCount ?? 0) >= 2,
        null, { timeout: CAP.formationMs });
    } catch {
      const [h, c] = await Promise.all([wireState(hostPage), wireState(clientPage)]);
      throw new Error(`the session never formed inside ${CAP.formationMs} ms.`
        + ` CLIENT: ${JSON.stringify(c)} HOST: ${JSON.stringify(h)}`);
    }
    formationMs = Date.now() - start;
    return `${formationMs} ms from the Join click to two open channels and a host roster of 2`;
  });

  await phase('client-launch', async () => {
    await leaveCoopScreen(clientPage);
    await launchRun(clientPage);
    return 'joined and running';
  });

  // -- scripted play --------------------------------------------------------
  //
  // Both worlds are live, so give them something to disagree about: each page
  // gets a turn holding a movement key. Playwright brings a page to the front
  // to type into it, which is exactly why the backgrounding flags are set — the
  // page that is not being typed into must keep ticking, and `ticks-advance`
  // is the check that would notice if it did not.
  await phase('run-window', async () => {
    const keys = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
    const start = Date.now();
    const deadline = start + RUN_S * 1000;
    const alive = (page) => page.evaluate(() => globalThis.__GAME__?.ctx?.player?.alive !== false
      && globalThis.__GAME__?.ctx?.hud?.menus?.screen !== 'death');
    let n = 0;
    while (Date.now() < deadline) {
      const page = n % 2 === 0 ? hostPage : clientPage;
      const key = keys[(n >> 1) % keys.length];
      await page.keyboard.down(key);
      await sleep(Math.min(700, Math.max(0, deadline - Date.now())));
      await page.keyboard.up(key);
      n++;
      // A death ends the session, and every check below reads a paused world
      // off a death screen. Stop here and say when, rather than let three
      // checks go red with no cause named between them.
      const [h, c] = await Promise.all([alive(hostPage), alive(clientPage)]);
      if (!h || !c) {
        runWindowEndedEarly = `${!h ? 'the host' : 'the client'} survivor died`
          + ` ${((Date.now() - start) / 1000).toFixed(1)} s into a ${RUN_S} s window`;
        return `${runWindowEndedEarly} — window ended there, ${n} key holds`;
      }
    }
    return `${RUN_S} s of scripted play, ${n} alternating key holds, both survivors alive`;
  });

  // -- the checks -----------------------------------------------------------
  const pages = {
    host: hostPage,
    client: clientPage,
    gameState,
    evalBoth: (fn) => Promise.all([hostPage.evaluate(fn), clientPage.evaluate(fn)]),
  };
  for (const check of SELECTED) {
    try {
      const { pass, detail } = await check.run(pages);
      ok(check.name, check.set, pass, detail);
    } catch (err) {
      ok(check.name, check.set, false, `threw: ${String(err?.message ?? err).slice(0, 300)}`);
    }
  }

  ok('no page errors', 'base',
    consoleErrors.host.length === 0 && consoleErrors.client.length === 0,
    consoleErrors.host.length || consoleErrors.client.length
      ? `host ${consoleErrors.host.length}, client ${consoleErrors.client.length}:`
        + ` ${[...consoleErrors.host, ...consoleErrors.client].slice(0, 3).join(' | ')}`
      : '0 uncaught page errors and 0 console errors across both pages');

  await hostPage.screenshot({ path: path.join(OUT, `${LABEL}-host.png`) }).catch(() => {});
  await clientPage.screenshot({ path: path.join(OUT, `${LABEL}-client.png`) }).catch(() => {});
} catch (err) {
  fatal = err;
  // A run that never reached the checks still has to say so in the record's own
  // vocabulary, or a reader sees an empty `checks` array and no verdict. The
  // phase that threw becomes a failed check, and every check that consequently
  // did not run is listed as not run — never quietly absent.
  const where = phases.at(-1)?.name ?? 'startup';
  ok(`phase:${where}`, 'base', false, String(err?.message ?? err).slice(0, 1200));
  const already = new Set(checks.map((c) => c.name));
  for (const check of SELECTED) {
    if (already.has(check.name)) continue;
    ok(check.name, check.set, false, `not run — the probe failed at phase "${where}"`);
  }
} finally {
  // Kill everything this process started, including on a throw.
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
  relay?.kill();
}

const allPass = checks.length > 0 && checks.every((c) => c.pass);
await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(),
  probe: 'tools/coopprobe.mjs',
  label: LABEL,
  flags: {
    port: PORT, signalPort: SIGNAL_PORT, seed: SEED,
    netlag: NETLAG, netloss: NETLOSS, runS: RUN_S,
    checks: SETS, record: RECORD, out: OUT,
    signalServerSpawned: SPAWN_SIGNAL,
    spawnRate: SPAWN_RATE,
  },
  urls: {
    host: `/index.html?seed=${SEED}&quality=2&harness=1&signal=ws://127.0.0.1:${SIGNAL_PORT}`,
    client: `/index.html?seed=${SEED}&quality=2&harness=1&signal=ws://127.0.0.1:${SIGNAL_PORT}`
      + `${NETLAG ? `&netlag=${NETLAG}` : ''}${NETLOSS ? `&netloss=${NETLOSS}` : ''}`,
  },
  // No silent caps: every bound this run imposed, and every check it did not run.
  bounded: {
    ...CAP,
    checkSetsRequested: SETS,
    checkSetsKnown: KNOWN_SETS,
    checksSkipped: SKIPPED,
    runWindowEndedEarly,
    settingsSeeded: { spawnRate: SPAWN_RATE, master: 0, music: 0, sfx: 0 },
    ...(NETLAG || NETLOSS ? { netlagDirection: 'host->client inbound' } : {}),
    stubbed: ['Element.prototype.requestPointerLock', 'document.exitPointerLock'],
    note: 'every wait in this probe is capped; the caps above are the only ones there are',
  },
  roomCode,
  formationMs,
  phases,
  timings: {
    totalMs: Date.now() - T0,
    byPhase: Object.fromEntries(phases.map((p) => [p.name, p.ms])),
  },
  consoleErrors,
  checks,
  fatal: fatal ? String(fatal?.message ?? fatal).slice(0, 2000) : null,
  allPass,
}, null, 2)}\n`);

const failed = checks.filter((c) => !c.pass);
console.log(failed.length
  ? `\nFAIL - ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join('; ')}`
  : `\nPASS - ${checks.length} co-op checks verified across two real pages`
    + `${NETLAG ? ` at netlag=${NETLAG}` : ''}${NETLOSS ? ` netloss=${NETLOSS}` : ''}`);
console.log(`record: ${RECORD}`);
process.exit(allPass ? 0 : 1);
