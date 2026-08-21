/**
 * The #52 keyboard sitting, as an instrument: overlay eyes-on, peer
 * visibility, lobby space — the three checks only a human can verdict,
 * with every programmatic action and result logged to
 * `reviews/spike-sitting-0820/sitting-log.jsonl` so the sitting leaves
 * evidence on disk rather than in memory.
 *
 *   npx electron tools/steam-sitting.mjs            # host seat (machine A)
 *   npx electron tools/steam-sitting.mjs --joiner <lobbyId>   # machine B
 *
 * What this is NOT: a test of the game. The game still runs on
 * steamworks.js (#54 is unstarted). This loads `steamworks-ffi-node`
 * directly — the Binding being spiked — inits on Spacewar (480), hangs
 * its native overlay window off an animated Electron page (Chromium
 * skips repainting static regions, and an unpainting page can mask an
 * unpainting overlay — docs/STEAM.md "the overlay" section), and wires
 * buttons for the calls the sitting needs.
 *
 * The overlay architecture here is NOT steamworks.js's: this Binding's
 * `addElectronSteamOverlay(win)` renders the Electron content into a
 * native graphics window it creates, and Steam injects into THAT. Judge
 * the window that actually paints.
 */
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = path.join(root, 'reviews', 'spike-sitting-0820');
const LOG = path.join(EVIDENCE_DIR, 'sitting-log.jsonl');

process.env.SteamAppId = '480';
process.env.SteamGameId = '480';

const argv = process.argv.slice(2);
const joinerIdx = argv.indexOf('--joiner');
const JOINER_LOBBY = joinerIdx >= 0 ? argv[joinerIdx + 1] : null;
const modeIdx = argv.indexOf('--overlay-mode');
const OVERLAY_MODE = modeIdx >= 0 ? argv[modeIdx + 1] : 'native';
if (!['native', 'switches', 'none'].includes(OVERLAY_MODE)) {
  console.error(`--overlay-mode must be native|switches|none, got ${OVERLAY_MODE}`);
  process.exit(1);
}

// The switches arm is steamworks.js's overlay strategy (its index.js:50-69),
// reimplemented so no second Steam binding enters the process: Chromium must be
// told before ready, and a repaint invalidator keeps frames flowing for the hook.
if (OVERLAY_MODE === 'switches') {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-direct-composition');
}
// Optional ANGLE backend override (e.g. --use-angle gl): reroutes Chromium onto
// OpenGL, whose SwapBuffers is the overlay hook's most reliable target.
const angleIdx = argv.indexOf('--use-angle');
if (angleIdx >= 0) app.commandLine.appendSwitch('use-angle', argv[angleIdx + 1]);

mkdirSync(EVIDENCE_DIR, { recursive: true });
const rawConsole = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console), debug: console.debug.bind(console) };
const log = (event, data) => {
  const entry = { at: new Date().toISOString(), seat: JOINER_LOBBY ? 'joiner' : 'host', mode: OVERLAY_MODE, event, ...data };
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
  rawConsole.log('[sitting]', event, JSON.stringify(data ?? {}));
  return entry;
};

// Tee every console channel into the evidence log: the Binding's overlay
// diagnostics ([Steam Overlay] ...) go through SteamLogger to the console, and
// last time they evaporated with the terminal.
for (const ch of ['log', 'error', 'warn', 'debug']) {
  console[ch] = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try { appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), event: 'console', ch, line })}\n`); } catch { /* keep printing regardless */ }
    rawConsole[ch](...args);
  };
}

const SteamworksSDK = require('steamworks-ffi-node').default ?? require('steamworks-ffi-node');
// All of the overlay module's own diagnostics are debug-gated; without this the
// attach can fail in four different ways while printing nothing.
try { require('steamworks-ffi-node/dist/internal/SteamLogger.js').SteamLogger.setDebug(true); }
catch (err) { log('debug-mode', { enabled: false, error: String(err?.message ?? err) }); }
// The enums live in dist/types and are not re-exported from the package root.
let ELobbyType, ELobbyDistanceFilter;
try {
  ({ ELobbyType, ELobbyDistanceFilter } = require('steamworks-ffi-node/dist/types/matchmaking.js'));
} catch {
  ELobbyType = { Private: 0, FriendsOnly: 1, Public: 2, Invisible: 3 };
  ELobbyDistanceFilter = { Close: 0, Default: 1, Far: 2, Worldwide: 3 };
}

let steam = null;
let lobbyId = null;

function initSteam() {
  steam = SteamworksSDK.getInstance ? SteamworksSDK.getInstance() : new SteamworksSDK();
  const ok = steam.init({ appId: 480 });
  const persona = ok && steam.friends?.getPersonaName ? steam.friends.getPersonaName() : null;
  log('init', { ok, persona, binding: '0.11.1', electron: process.versions.electron });
  if (ok) setInterval(() => steam.runCallbacks(), 1000 / 30);
  return { ok, persona };
}

const ACTIONS = {
  // Check 2, half 1: does Steam's own UI paint over the game at all?
  async overlayFriends() {
    steam.overlay.activateGameOverlay('Friends');
    return log('overlay-friends-requested', { note: 'verdict is human: did it PAINT?' });
  },
  // Check 4 needs a lobby; check 2 half 2 (invite dialog) needs the same lobby.
  async createLobby() {
    const r = await steam.matchmaking.createLobby(ELobbyType.FriendsOnly, 4);
    lobbyId = r?.lobbyId ?? null;
    return log('create-lobby', { success: !!r?.success, lobbyId: String(lobbyId), type: 'FriendsOnly(1)' });
  },
  async inviteDialog() {
    if (!lobbyId) return log('invite-dialog-skipped', { reason: 'no lobby yet' });
    steam.overlay.activateGameOverlayInviteDialog(lobbyId);
    return log('invite-dialog-requested', { lobbyId: String(lobbyId), note: 'verdict is human: did the friend picker OPEN?' });
  },
  // Check 4: what does an unfiltered worldwide scan of appid 480 return?
  async lobbyScan() {
    try {
      if (steam.matchmaking.addRequestLobbyListDistanceFilter && ELobbyDistanceFilter?.Worldwide !== undefined) {
        steam.matchmaking.addRequestLobbyListDistanceFilter(ELobbyDistanceFilter.Worldwide);
      }
    } catch { /* filter is best-effort; the unfiltered default still answers the question */ }
    const r = await steam.matchmaking.requestLobbyList();
    const lobbies = r?.lobbies ?? [];
    const sample = lobbies.slice(0, 8).map(l => ({
      id: String(l.lobbyId ?? l), members: l.numMembers ?? null, max: l.maxMembers ?? null,
    }));
    const oursListed = lobbyId ? lobbies.some(l => String(l.lobbyId ?? l) === String(lobbyId)) : null;
    return log('lobby-scan', { count: lobbies.length, sample, oursListedInOwnScan: oursListed });
  },
  // Check 3, joiner side: enter the host's lobby, list who is here.
  async joinLobby(id) {
    const target = id || JOINER_LOBBY;
    const r = await steam.matchmaking.joinLobby(target);
    lobbyId = r?.success ? target : lobbyId;
    return log('join-lobby', { target: String(target), success: !!r?.success, response: r?.response ?? null });
  },
  async members() {
    if (!lobbyId) return log('members-skipped', { reason: 'no lobby' });
    const m = steam.matchmaking.getLobbyMembers ? steam.matchmaking.getLobbyMembers(lobbyId) : null;
    return log('members', { lobbyId: String(lobbyId), members: (m ?? []).map(x => ({ id: String(x.steamId ?? x), name: x.personaName ?? null })) });
  },
  // The human verdicts, typed into the page so they land in the same log.
  async verdict({ check, verdict, note }) {
    return log('HUMAN-VERDICT', { check, verdict, note });
  },
};

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 720,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const st = initSteam();

  ipcMain.handle('sitting', async (_e, action, arg) => {
    try { return await ACTIONS[action](arg); }
    catch (err) { return log('action-error', { action, error: String(err?.message ?? err) }); }
  });

  // Overlay strategy per arm. `attachReturned` is the Binding's own verdict --
  // the last run logged "attached" off a try/catch while ignoring the boolean,
  // which is how a failing attach read as a success.
  let overlayAttach = `mode:${OVERLAY_MODE}`;
  if (OVERLAY_MODE === 'native') {
    try {
      const returned = steam.addElectronSteamOverlay(win, { title: 'Telluric Void spike sitting', fps: 60, vsync: true });
      overlayAttach = `native attachReturned:${returned}`;
      log('overlay-attach', { mode: 'native', attachReturned: returned });
      log('hint', { note: 'Alt+Tab to the window named "Telluric Void spike sitting" (the GL mirror). Does it show the animation? Shift+Tab with IT focused.' });
    } catch (err) {
      overlayAttach = `native threw: ${err?.message ?? err}`;
      log('overlay-attach', { mode: 'native', threw: String(err?.message ?? err) });
    }
  } else if (OVERLAY_MODE === 'switches') {
    const invalidator = setInterval(() => {
      if (win.isDestroyed()) return void clearInterval(invalidator);
      if (!win.webContents.isPainting()) win.webContents.invalidate();
    }, 1000 / 60);
    log('overlay-attach', { mode: 'switches', switches: ['in-process-gpu', 'disable-direct-composition'], note: 'Shift+Tab over the Electron window itself' });
  } else {
    log('overlay-attach', { mode: 'none', note: 'control: init only, no overlay strategy' });
  }

  // Injection probe: is gameoverlayrenderer64.dll resident in this process?
  // Separates "Steam never injected" from "injected but the window path is broken".
  setTimeout(() => {
    const { execFile } = require('node:child_process');
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Process -Id ${process.pid}).Modules | Where-Object { $_.ModuleName -match 'gameoverlay' } | ForEach-Object { $_.ModuleName }`,
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      const modules = String(stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      log('injection-probe', { injected: modules.length > 0, modules, error: err ? String(stderr || err.message) : null });
    });
  }, 3000);

  win.loadFile(path.join(root, 'tools', 'steam-sitting.html'), {
    query: { persona: st.persona ?? 'INIT FAILED', seat: JOINER_LOBBY ? `joiner->${JOINER_LOBBY}` : 'host', attach: overlayAttach, mode: OVERLAY_MODE },
  });
  if (JOINER_LOBBY) setTimeout(() => ACTIONS.joinLobby(JOINER_LOBBY).then(() => ACTIONS.members()), 1500);
});

app.on('window-all-closed', () => { try { steam?.shutdown?.(); } catch { /* leaving anyway */ } app.quit(); });
