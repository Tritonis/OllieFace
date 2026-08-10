/**
 * TELLURIC VOID desktop shell (Electron, Windows-only target).
 *
 * Serves the built web game over app:// (file:// breaks ES module
 * resolution, docs/STEAM.md section 5), keeps background throttling OFF (a
 * host that pauses on alt-tab desyncs every client), mirrors saves to one
 * atomically-written JSON under userData, and logs the GPU adapter so the
 * Optimus problem is diagnosable from a player report.
 */
import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');

if (process.env.TELLURIC_USERDATA) app.setPath('userData', process.env.TELLURIC_USERDATA);

// Must run before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const savePath = () => path.join(app.getPath('userData'), 'save.json');

// One backup per session: the first write of a run preserves the file the
// player launched with, and later writes do not churn over it.
let backedUp = false;

// The renderer must be able to tell "no save yet" from "there is a save and I
// could not read it". Collapsing both to null makes an EBUSY from Steam Cloud
// or an antivirus scan look like a first boot, and the renderer then migrates
// an empty localStorage over the real file. So: ONLY a missing file reports
// { ok: true, raw: null }; every other failure reports ok:false, which
// DesktopStore treats as "do not migrate", and is logged loudly here.
ipcMain.on('store:load', (e) => {
  try {
    e.returnValue = { ok: true, raw: fs.readFileSync(savePath(), 'utf8') };
  } catch (err) {
    if (err.code === 'ENOENT') { e.returnValue = { ok: true, raw: null }; return; }
    console.error('store:load failed', err);
    e.returnValue = { ok: false, raw: null };
  }
});

// An empty snapshot over a non-empty save is data loss, never intent: no
// gameplay path clears every mirrored key at once. The renderer already
// refuses to migrate after a failed read; this is the second half of the
// chain, so a future renderer bug cannot erase the file either.
const isEmptySnapshot = (json) => {
  try { return Object.keys(JSON.parse(json)).length === 0; }
  catch { return false; }
};

ipcMain.on('store:save', (_e, json) => {
  try {
    const p = savePath();
    if (isEmptySnapshot(json) && fs.existsSync(p) && fs.statSync(p).size > 2) {
      console.error('store:save refused: empty snapshot over a non-empty save.json');
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Back up the previous good file once per session, then tmp+rename so a
    // crash mid-write can never leave a half save as the only copy. A backup
    // is only worth taking if it does not shrink: one generation of grace is
    // all there is, and overwriting it with less than it holds spends it.
    if (!backedUp && fs.existsSync(p)) {
      const bak = `${p}.bak`;
      const prev = fs.existsSync(bak) ? fs.statSync(bak).size : -1;
      if (fs.statSync(p).size >= prev) fs.copyFileSync(p, bak);
      else console.error('store:save: kept the larger save.json.bak');
      backedUp = true;
    }
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
  } catch (err) { console.error('store:save failed', err); }
});

// Two instances against one userData clobber each other's saves wholesale:
// each renderer snapshots ITS OWN localStorage and writes the whole file, so
// the last flush wins and the other run's progress is gone. Steam's client
// blocks a double launch, but the deliverable is a double-clickable exe.
let mainWindow = null;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // app://game/<path> -> dist/<path>, default document index.html.
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const target = path.normalize(path.join(DIST, rel));
      if (!target.startsWith(DIST + path.sep))
        return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });

    const win = new BrowserWindow({
      width: 1600, height: 900,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(HERE, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,   // host-authoritative netcode: never stall the sim on blur
      },
    });
    mainWindow = win;
    // The preload rides the window, not the origin: anything this window can
    // navigate to inherits saveStore. Nothing in src/ navigates today; these
    // two denials keep it that way without needing anyone to remember.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadURL('app://game/index.html');

    // The Optimus diagnostic (docs/STEAM.md section 1): which adapter Chromium
    // actually picked, written where a player report can find it.
    try {
      const info = await app.getGPUInfo('complete');
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'gpu-info.json'), JSON.stringify(info, null, 2));
    } catch (err) { console.error('gpu-info failed', err); }
  });

  app.on('window-all-closed', () => app.quit());
}
