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

ipcMain.on('store:load', (e) => {
  try { e.returnValue = fs.readFileSync(savePath(), 'utf8'); }
  catch { e.returnValue = null; }
});
ipcMain.on('store:save', (_e, json) => {
  try {
    const p = savePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Back up the previous good file once per session, then tmp+rename so a
    // crash mid-write can never leave a half save as the only copy.
    if (!backedUp && fs.existsSync(p)) { fs.copyFileSync(p, `${p}.bak`); backedUp = true; }
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
  } catch (err) { console.error('store:save failed', err); }
});

app.whenReady().then(async () => {
  // app://game/<path> -> dist/<path>, default document index.html.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.normalize(path.join(DIST, rel));
    if (!target.startsWith(DIST + path.sep) && target !== path.join(DIST, 'index.html'))
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
