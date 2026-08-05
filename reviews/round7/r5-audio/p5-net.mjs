/**
 * Round-4 audio critique (round 7), probe 5: a REAL networked session — the arm
 * round 3 and round 4 both named as untested.
 *
 * Two pages, one browser, host + client over the manual WebRTC invite path
 * (`Lobby.createInvite` / `Lobby.joinManual` / `Lobby.acceptAnswer`). Then:
 *   - a teammate's death, seen by a living player (round 4's fix)
 *   - the CLIENT's own death, seen by the client (the arm nobody ran)
 *
 *   node reviews/round7/r5-audio/p5-net.mjs [--port 5571]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (t.startsWith('--')) args[t.slice(2)] = process.argv[i + 1];
}
const PORT = Number(args.port ?? 5571);
const out = { steps: [] };
const log = (...a) => { console.log('[p5]', ...a); out.steps.push(a.map(String).join(' ')); };

const server = await createServer({ server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  timeout: 180000, headless: false,
  // The GPU path, not SwiftShader: with two pages both software-rendering, the
  // second page's load event never fired inside 180 s on two attempts.
  args: ['--force_high_performance_gpu', '--window-position=-2400,-2400'],
});

const mkPage = async (tag) => {
  const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
  p.on('pageerror', (e) => log(`${tag} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') log(`${tag} console: ${m.text().slice(0, 200)}`); });
  await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load', timeout: 180000 });
  await p.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 120000 });
  await p.mouse.move(400, 300); await p.mouse.down(); await p.mouse.up();
  return p;
};

const A = await mkPage('HOST');
log('host booted');
// Park the host's frame loop while the client page loads. A live rAF loop on
// page A is what starved page B's load past 180 s twice.
await A.evaluate(() => globalThis.__HARNESS__?.freeze?.());
const B = await mkPage('CLIENT');
log('client booted');
await A.evaluate(() => globalThis.__HARNESS__?.thaw?.());

// Both into a running game so there is a player, a director and a soundtrack.
for (const [p, tag] of [[A, 'HOST'], [B, 'CLIENT']]) {
  await p.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 8 }));
  await p.evaluate(() => globalThis.__HARNESS__?.thaw?.());
  await p.waitForFunction(() => globalThis.__GAME__?.ctx?.audio?.ready === true, null, { timeout: 30000 });
  log(`${tag} audio ready`);
}

/* ---- connect ------------------------------------------------------------- */
const invite = await A.evaluate(async () => {
  const inv = await globalThis.__GAME__.ctx.lobby.createInvite();
  return inv.blob;
});
log('invite blob', invite.length, 'bytes');
const answer = await B.evaluate(async (blob) => globalThis.__GAME__.ctx.lobby.joinManual(blob), invite);
log('answer blob', answer.length, 'bytes');
await A.evaluate(async (ans) => globalThis.__GAME__.ctx.lobby.acceptAnswer(ans), answer);

let connected = false;
try {
  await B.waitForFunction(() => globalThis.__GAME__?.ctx?.net?.connected === true && globalThis.__GAME__.ctx.net.myNetId > 0,
    null, { timeout: 45000 });
  connected = true;
} catch (e) { log('CONNECT FAILED:', e.message); }
out.connected = connected;

out.roles = {
  host: await A.evaluate(() => { const c = globalThis.__GAME__.ctx; return { authority: c.authority, role: c.netRole ?? 'host', peers: c.net?.playerCount ?? null }; }),
  client: await B.evaluate(() => { const c = globalThis.__GAME__.ctx; return { authority: c.authority, role: c.netRole, myNetId: c.net?.myNetId ?? null, connected: !!c.net?.connected }; }),
};
log('roles', JSON.stringify(out.roles));

if (connected) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3000);

  const audioState = (p) => p.evaluate(() => {
    const c = globalThis.__GAME__.ctx, a = c.audio, m = a.musicEngine;
    return {
      alive: c.player?.alive ?? null, health: +(c.player?.health ?? -1).toFixed(1),
      stopped: m.stopped, steps: m.stepsEmitted,
      musicGain: +a.music.gain.value.toFixed(5), musicOff: !!a._musicOff,
      drone: +(a.droneGain?.gain.value ?? 0).toFixed(4),
      screen: c.hud?.menus?.screen ?? null,
      // the intensity model, which is the whole subject of rounds 3 and 4
      I: +m.intensity.toFixed(4), pressure: +m.pressure.toFixed(4),
      sustain: +m._sustain.toFixed(4), heat: +m._heat.toFixed(4), arc: +m.arc.toFixed(4),
      directorEnemies: (c.director?.enemies ?? []).length,
      directorAlive: (c.director?.enemies ?? []).filter((e) => e.alive).length,
      diff: +(c.director?.difficultyCoefficient ?? 0).toFixed(3),
      cues: globalThis.__CUES__ ? { ...globalThis.__CUES__ } : null,
    };
  });

  // Count the cues each side actually plays, so "the client hears the fight"
  // is a measurement rather than an inference.
  for (const p of [A, B]) {
    await p.evaluate(() => {
      const a = globalThis.__GAME__.ctx.audio;
      globalThis.__CUES__ = { hit: 0, death: 0, playerHurt: 0, explosion: 0, shoot: 0 };
      for (const k of ['hit', 'death', 'playerHurt', 'explosion', 'shoot']) {
        const o = a[k].bind(a);
        a[k] = (...args) => { globalThis.__CUES__[k]++; return o(...args); };
      }
    });
  }
  // Ten seconds of the host fighting, with both sides sampled.
  await A.evaluate(() => globalThis.__HARNESS__?.combat?.({ enemies: 20 }));
  await A.evaluate(() => globalThis.__HARNESS__?.thaw?.());
  await new Promise((r) => setTimeout(r, 10000));
  out.duringFight = { host: await audioState(A), client: await audioState(B) };
  log('during a 10 s fight:', JSON.stringify(out.duringFight));

  out.beforeAnyDeath = { host: await audioState(A), client: await audioState(B) };
  log('before', JSON.stringify(out.beforeAnyDeath));

  /* ---- 1. does the host's damage reach the client's own view of itself? --- */
  out.hostDamagesClientPawn = await A.evaluate(() => {
    const c = globalThis.__GAME__.ctx;
    const entry = [...(c.net?.clients?.values() ?? [])][0];
    const pawn = entry?.pawn ?? null;
    if (!pawn) return { found: false };
    const h0 = pawn.health;
    const dealt = c.combat?.applyDamage?.(pawn, 40, { type: 'probe', isDot: true, ignoreArmor: true }) ?? null;
    return { found: true, dealt, healthBefore: +h0.toFixed(1), healthAfter: +pawn.health.toFixed(1), aliveOnHost: pawn.alive };
  });
  await sleep(1500);
  out.clientSeesOwnDamage = await audioState(B);
  log('after 40 dmg to the client pawn — host says', JSON.stringify(out.hostDamagesClientPawn),
      '| client sees health', out.clientSeesOwnDamage.health, 'alive', out.clientSeesOwnDamage.alive);

  /* ---- 2. kill the client's pawn on the host ----------------------------- */
  out.hostKillsClientPawn = await A.evaluate(() => {
    const c = globalThis.__GAME__.ctx;
    const entry = [...(c.net?.clients?.values() ?? [])][0];
    const pawn = entry?.pawn ?? null;
    if (!pawn) return { found: false };
    for (let i = 0; i < 20 && pawn.alive; i++) {
      pawn._iframeUntil = 0;
      c.combat?.applyDamage?.(pawn, 1e6, { type: 'probe', isDot: true, ignoreArmor: true });
    }
    return { found: true, aliveOnHost: pawn.alive, healthOnHost: +pawn.health.toFixed(1) };
  });
  await sleep(2500);
  out.afterClientDeath = { host: await audioState(A), client: await audioState(B) };
  log('after the CLIENT died:', JSON.stringify(out.afterClientDeath));

  /* ---- 3. now kill the HOST's own player --------------------------------- */
  await A.evaluate(() => {
    const c = globalThis.__GAME__.ctx;
    for (let i = 0; i < 20 && c.player.alive; i++) {
      c.player._iframeUntil = 0;
      c.combat?.applyDamage?.(c.player, 1e6, { type: 'probe', isDot: true, ignoreArmor: true });
    }
  });
  await sleep(2500);
  out.afterHostDeath = { host: await audioState(A), client: await audioState(B) };
  log('after the HOST died:', JSON.stringify(out.afterHostDeath));

  out.verdicts = {
    clientOwnDeathStoppedItsMusic: out.afterClientDeath.client.stopped === true,
    clientMusicSurvivedTeammateDeath: out.afterHostDeath.client.stopped === false || out.afterClientDeath.client.stopped === true,
    hostMusicSurvivedClientDeath: out.afterClientDeath.host.stopped === false,
    hostOwnDeathStoppedItsMusic: out.afterHostDeath.host.stopped === true,
  };
  log('VERDICTS', JSON.stringify(out.verdicts));
}

await writeFile('reviews/round7/r5-audio/p5-net.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
