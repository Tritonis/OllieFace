/**
 * The two-seat mode's hands (#241): turns a BrowserWindow's `webContents` and
 * main's own Steam functions into the dependencies `runSeat` asks for.
 *
 * Everything the renderer does, it does through the page a player sees: the
 * menu's buttons are clicked (`[data-act="coop-steam-host"]`, `play`,
 * `launch`), the joiner's join is the menu's own `acceptSteamInvite`, and the
 * play window is real key events via `sendInputEvent`. What it READS back off
 * the page is `globalThis.__GAME__`, the same always-present handle
 * `tools/coopprobe.mjs` reads formation from — read-only, never a lever.
 *
 * Only `desktop/main.mjs` constructs this, and only when `parseTwoSeat`
 * answered a seat.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runSeat } from './twoseat.mjs';

/** A Steam account id: a 17-digit individual SteamID64. */
const ACCOUNT_ID = /^7656119\d{10}$/;

/**
 * Who this seat is. `steamId` is the ACCOUNT's SteamID64 (what #13 matches
 * seats to accounts by), read off the Binding's status; the sockets identity
 * is a different number and travels separately. A value that is not an
 * account id is reported as null rather than passed off as one.
 */
export function seatIdentity(client, status) {
  let steamId = null, socketsIdentity = null;
  try { steamId = String(client?.getStatus?.()?.steamId ?? ''); } catch { steamId = null; }
  try { socketsIdentity = String(client?.networkingSockets?.getIdentity() ?? '') || null; } catch { socketsIdentity = null; }
  return {
    available: !!status?.available, appId: status?.appId ?? null,
    steamId: ACCOUNT_ID.test(steamId ?? '') ? steamId : null, socketsIdentity,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page-side snippets. Strings, because they run in the renderer. */
const JS = {
  atTitle: `globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title'`,
  screen: `globalThis.__GAME__?.ctx?.hud?.menus?.screen ?? null`,
  steamBlockShown: `(() => { const b = document.querySelector('[data-coop-steam]'); return !!b && !b.hidden; })()`,
  click: (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`,
  netState: `(() => {
    const ctx = globalThis.__GAME__?.ctx; const net = ctx?.net ?? null;
    return { mode: ctx?.lobby?.mode ?? 'single', connected: !!net?.connected, myNetId: net?.myNetId ?? null,
      playerCount: net?.playerCount ?? null, tick: net?.tick ?? 0,
      alive: ctx?.player?.alive !== false, screen: ctx?.hud?.menus?.screen ?? null,
      transport: net?.transport?.constructor?.name ?? null };
  })()`,
};

/**
 * @param {{
 *   webContents: any,
 *   identity: () => ReturnType<typeof seatIdentity>,
 *   listFriends: () => ({ friends?: Array<{steamId: string}>, error?: string }),
 *   inviteFriend: (lobbyId: string, steamId: string) => ({ ok?: true, error?: string }),
 *   heldLobby: () => string|null,
 *   lobbyMembers: (lobbyId: string) => string[],
 *   heardInvite: () => ({ lobbyId: string, fromSteamId: string|null }|null),
 *   listening: () => boolean,
 * }} main
 */
export function createSeatDriver(main) {
  const wc = main.webContents;
  const evalJs = async (code) => {
    try { return await wc.executeJavaScript(code, true); } catch { return null; }
  };
  const until = async (code, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (await evalJs(code)) return true; await sleep(200); }
    return false;
  };
  const key = (keyCode, type) => wc.sendInputEvent({ type, keyCode });

  let seat = null;
  const deps = {
    writeRecord: async (file, json) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, json); },
    now: () => Date.now(),
    sleep,
    identity: main.identity,
    rendererReady: () => evalJs(JS.atTitle),
    listFriends: () => { const r = main.listFriends(); return r.friends ?? null; },
    async hostLobby() {
      // The player's gesture: Co-op, wait for the Steam block, Host via Steam.
      await evalJs(JS.click('.screen.is-open [data-act="coop"]'));
      if (!(await until(JS.steamBlockShown, 10000))) throw new Error('the Steam block never showed on the co-op screen');
      await evalJs(JS.click('[data-act="coop-steam-host"]'));
    },
    heldLobby: main.heldLobby,
    invite: (lobbyId, steamId) => main.inviteFriend(lobbyId, steamId).ok === true,
    lobbyMembers: main.lobbyMembers,
    heardInvite: main.heardInvite,
    listening: main.listening,
    async formed() {
      const s = await evalJs(JS.netState);
      if (!s) return { ok: false, detail: 'renderer unreadable' };
      const ok = seat === 'host'
        ? s.mode === 'host' && (s.playerCount ?? 0) >= 2
        : s.mode === 'client' && s.connected && s.myNetId > 0;
      return { ok, detail: `mode=${s.mode} connected=${s.connected} myNetId=${s.myNetId} players=${s.playerCount} transport=${s.transport}` };
    },
    async startRun() {
      // Back to the title if the co-op screen is up, then Play -> Launch.
      if ((await evalJs(JS.screen)) === 'coop') {
        await evalJs(JS.click('.screen--coop [data-act="back"]'));
        if (!(await until(JS.atTitle, 10000))) return false;
      }
      await evalJs(JS.click('.screen--title [data-act="play"]'));
      if (!(await until(`${JS.screen} === 'select'`, 10000))) return false;
      await evalJs(JS.click('.screen--select [data-act="launch"]'));
      return until(`${JS.screen} === null && globalThis.__GAME__?.ctx?.paused === false`, 10000);
    },
    async play(ms) {
      const before = await evalJs(JS.netState);
      const keys = ['W', 'D', 'S', 'A'];
      const deadline = Date.now() + ms;
      let n = 0, dropped = null;
      while (Date.now() < deadline) {
        const k = keys[n++ % keys.length];
        key(k, 'keyDown');
        await sleep(Math.min(700, Math.max(0, deadline - Date.now())));
        key(k, 'keyUp');
        const s = await evalJs(JS.netState);
        if (!s || (seat === 'host' ? (s.playerCount ?? 0) < 2 : !s.connected)) { dropped = s; break; }
      }
      const after = await evalJs(JS.netState);
      const advanced = (after?.tick ?? 0) > (before?.tick ?? 0);
      // Death is recorded, never judged: a survivor dying says nothing about
      // the link, and this window exists to judge the link.
      const ok = !dropped && advanced;
      return { ok, detail: `${n} key holds; tick ${before?.tick ?? '?'} -> ${after?.tick ?? '?'}`
        + `${dropped ? `; session dropped: ${JSON.stringify(dropped)}` : ''}; alive=${after?.alive} (not judged)` };
    },
  };

  return {
    run(cfg) { seat = cfg.seat ?? null; return runSeat(cfg, deps); },
    /** Test seam only. */
    _deps: deps,
  };
}
