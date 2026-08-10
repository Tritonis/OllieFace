# Desktop Shell (Electron Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TELLURIC VOID boots as a Windows desktop app — an Electron shell serving the real `dist/` over a custom `app://` scheme, saves mirrored to a single JSON file under `userData` (the Steam Cloud prerequisite), background throttling disabled so a host never desyncs on alt-tab, GPU adapter logged at startup, and a packaged portable folder that a probe can launch and gate end-to-end.

**Origin:** `docs/STEAM.md` — the port research this plan executes the low-risk engineering rows of (§6: "Electron shell, app:// protocol, packaging 2-3 days, Low risk"; "Saves -> JSON + Steam Cloud 1-2 days, Low"; plus the §5 gotchas: module loading via `app://`, `backgroundThrottling: false`, discrete-GPU logging). Roadmap Phase 4 (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md:160`). **Deliberately out of this slice** (they need a purchased Steam app id, a human account, or hands on hardware): `steamworks.js` wiring, Steam lobbies signalling, Steam Input, overlay verification, Optimus-laptop testing, SteamPipe upload. The slice's product is a shell Steam work can land in.

**Architecture:** The web build is not touched — `vite build` keeps producing `dist/`, gaining only `base: './'` so assets resolve under a non-root scheme. A new top-level `desktop/` directory owns the shell: `main.mjs` (app lifecycle, `app://` protocol from `dist/`, window, GPU log), `preload.cjs` (contextBridge exposing a minimal save-file API). On the renderer side one new module, `src/core/DesktopStore.js`, bridges persistence: at boot it hydrates `localStorage` from the desktop save file, then patches `localStorage.setItem`/`removeItem` to mirror every `telluric.*`/`net.*` write back through the bridge, debounced. No storage call site changes — `Profile.js`, `GpuNotice.js`, `Artifacts.js`, `NetConfig.js`, `Menus.js`, `LegacyStorage.js` keep talking to `localStorage` and the mirror rides underneath. In a browser the bridge is absent and the module is a no-op, so the web build's behaviour is byte-identical.

**Tech Stack:** Electron (new devDep, pinned exact per STEAM.md §5 "Pin the Electron version"), electron-builder (new devDep, `--dir` portable target only — no installer, no signing, per STEAM.md "skip codesigning for a Steam-only launch"), Playwright's `_electron` driver (already a devDep) for the probe.

## Global Constraints

- **The web build must not change behaviour.** `DesktopStore` is a no-op without the bridge; `base: './'` only rewrites asset URLs. Gate: `node tests/run.mjs` green, `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` zero fields moved, and one capture regression run (`node tools/capture.mjs $CAPFLAG --out shots-regress --only 01-title` -> `subjectsOk: true`, then delete the directory).
- **No `npx`, ever** (memory: npx-destroys-rolldown-binding). Install with `npm install --save-dev --save-exact <pkg>@<version>`; run binaries via `npm run` scripts or `node_modules/.bin/` paths.
- **Pin Electron exact.** Resolve the current stable with `npm view electron version`, install `--save-exact`, and record the version in `desktop/README.md`. Every future bump re-verifies the overlay (STEAM.md §5) — write that warning into the README.
- **Renderer security posture:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox` left at default, preload exposes only the functions this plan names. The game is a local single-page app but MP loads remote peers' data; do not widen the surface.
- **Saves are a single JSON file, written atomically** (tmp + rename), covering exactly the keys prefixed `telluric.` and `net.` — the complete live set (`src/systems/Profile.js:75-78` single profile blob; `src/ui/GpuNotice.js:18`; `src/systems/Artifacts.js`; `src/net/NetConfig.js`; settings via `src/ui/Menus.js` / `src/core/LegacyStorage.js:26-47`).
- **`desktop/main.mjs` honors `TELLURIC_USERDATA`** (env var -> `app.setPath('userData', ...)`) so probes and future tests never touch the real profile.
- **Bash tool is ASCII-only**; non-ASCII content goes through Write/Edit. No report prose through heredocs.
- **Line citations are signposts** — the live file wins; read before editing.

---

### Task 1: `DesktopStore` — the save mirror, headless-tested

Pure renderer logic, no Electron needed, full TDD. This lands first because everything else gates on the save story.

**Files:**
- Create: `src/core/DesktopStore.js`
- Modify: `src/main.js` — one import + one call, first thing before any system reads storage (before the `URLSearchParams` block at `src/main.js:25-28`)
- Test: `tests/desktop-store.test.mjs`

**Interfaces:**
- Consumes: `globalThis.__DESKTOP__` when present: `{ loadStore(): string | null, saveStore(json: string): void }` (Task 2's preload provides it; tests provide fakes).
- Produces: `initDesktopStore(storage = globalThis.localStorage, bridge = globalThis.__DESKTOP__, opts = {})` -> `{ active, hydrated, flush }`; `MIRROR_PREFIXES = ['telluric.', 'net.']`. Task 2's preload matches the bridge shape; Task 3's probe asserts the file contents this module writes.

- [ ] **Step 1: Write the failing test.** Create `tests/desktop-store.test.mjs` following the repo convention (standalone node script, PASS/FAIL lines, non-zero exit on failure — see `tests/run.mjs:1-31` and any recent `tests/*.test.mjs` for the exact reporting idiom):

```javascript
/**
 * DesktopStore: hydrate localStorage from the desktop save file at boot,
 * mirror every telluric.*/net.* write back through the bridge, debounced,
 * atomically ordered. No bridge -> inert no-op.
 */
import { initDesktopStore, MIRROR_PREFIXES } from '../src/core/DesktopStore.js';

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
  if (!pass) failures++;
};

// A faithful-enough localStorage: string map + the real method surface.
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { m.set(String(k), String(v)); },
    removeItem(k) { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}
function fakeBridge(fileContents = null) {
  const saves = [];
  return { loadStore: () => fileContents, saveStore: (json) => saves.push(json), _saves: saves };
}

// 1. No bridge: inert, storage untouched, flush callable.
{
  const s = fakeStorage({ 'telluric.profile': '{"v":3}' });
  const r = initDesktopStore(s, undefined);
  check('no bridge -> inactive', r.active === false && r.hydrated === false);
  s.setItem('telluric.profile', '{"v":4}');
  r.flush();
  check('no bridge -> setItem still works, nothing mirrored', s.getItem('telluric.profile') === '{"v":4}');
}

// 2. Hydration: file keys land in storage, non-prefixed file keys are ignored.
{
  const s = fakeStorage();
  const b = fakeBridge(JSON.stringify({ 'telluric.profile': '{"v":3}', 'net.name': 'olli', 'evil': 'x' }));
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  check('hydrates prefixed keys', s.getItem('telluric.profile') === '{"v":3}' && s.getItem('net.name') === 'olli');
  check('ignores non-prefixed keys', s.getItem('evil') === null);
  check('reports active + hydrated', r.active === true && r.hydrated === true);
}

// 3. First boot (no file): existing localStorage migrates out on first flush.
{
  const s = fakeStorage({ 'telluric.profile': '{"v":3}', 'unrelated': 'y' });
  const b = fakeBridge(null);
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  r.flush();
  const snap = JSON.parse(b._saves.at(-1));
  check('migration snapshot has the prefixed key', snap['telluric.profile'] === '{"v":3}');
  check('migration snapshot omits unrelated keys', !('unrelated' in snap));
}

// 4. Mirroring: a patched setItem schedules a snapshot; corrupt file does not throw.
{
  const s = fakeStorage();
  const b = fakeBridge(null);
  const r = initDesktopStore(s, b, { debounceMs: 0 });
  s.setItem('telluric.gpuNoticeDismissed', '1');
  s.setItem('ephemeral', 'z');
  r.flush();
  const snap = JSON.parse(b._saves.at(-1));
  check('mirrors prefixed writes', snap['telluric.gpuNoticeDismissed'] === '1');
  check('omits non-prefixed writes', !('ephemeral' in snap));

  const s2 = fakeStorage({ 'telluric.profile': '{"v":3}' });
  const b2 = fakeBridge('{not json');
  const r2 = initDesktopStore(s2, b2, { debounceMs: 0 });
  check('corrupt file -> boots inert-hydrated, storage untouched',
    r2.active === true && r2.hydrated === false && s2.getItem('telluric.profile') === '{"v":3}');
}

check('prefixes are the documented pair', JSON.stringify(MIRROR_PREFIXES) === '["telluric.","net."]');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it, watch it fail.** `node tests/desktop-store.test.mjs` — expected: cannot find module `../src/core/DesktopStore.js`.

- [ ] **Step 3: Implement.** Create `src/core/DesktopStore.js`:

```javascript
/**
 * The desktop save mirror.
 *
 * In the browser this module is a no-op: no bridge, nothing changes, and the
 * game's storage story is exactly what it was. Under the Electron shell the
 * preload exposes `__DESKTOP__` and this module does two things at boot:
 *
 *   1. Hydrate: the save file (one JSON object, key -> string) is copied into
 *      localStorage for every key matching MIRROR_PREFIXES. The file is the
 *      desktop source of truth; localStorage stays the live store the six
 *      existing call sites keep talking to.
 *   2. Mirror: localStorage.setItem/removeItem are wrapped so any write to a
 *      prefixed key schedules a debounced snapshot of ALL prefixed keys back
 *      through the bridge. First boot (no file yet) migrates the browser-era
 *      profile out on the first flush.
 *
 * Why localStorage stays live instead of being replaced: docs/STEAM.md's
 * actual requirement is a single JSON file Steam Cloud can sync; the six call
 * sites (Profile, GpuNotice, Artifacts, NetConfig, Menus, LegacyStorage) are
 * all correct against localStorage today, and the mirror gets the file
 * without rewriting any of them. The wrap must survive future call sites too,
 * which per-site rewrites would not.
 */
export const MIRROR_PREFIXES = ['telluric.', 'net.'];

const mirrored = (k) => MIRROR_PREFIXES.some((p) => String(k).startsWith(p));

export function initDesktopStore(
  storage = globalThis.localStorage,
  bridge = globalThis.__DESKTOP__,
  { debounceMs = 250 } = {},
) {
  if (!bridge || typeof bridge.loadStore !== 'function' || typeof bridge.saveStore !== 'function' || !storage) {
    return { active: false, hydrated: false, flush: () => {} };
  }

  let hydrated = false;
  try {
    const raw = bridge.loadStore();
    if (raw != null) {
      const file = JSON.parse(raw);
      for (const [k, v] of Object.entries(file)) {
        if (mirrored(k) && typeof v === 'string') storage.setItem(k, v);
      }
      hydrated = true;
    }
  } catch (e) {
    // A corrupt save file must never brick the boot: keep whatever
    // localStorage has, mirror from here on, and let the next flush write a
    // clean file. The old file is the shell's problem to back up (it does).
    console.error('DesktopStore: save file unreadable, continuing from localStorage', e);
  }

  const snapshot = () => {
    const out = {};
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k != null && mirrored(k)) out[k] = storage.getItem(k);
    }
    return out;
  };

  let timer = 0;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    try { bridge.saveStore(JSON.stringify(snapshot())); }
    catch (e) { console.error('DesktopStore: saveStore failed', e); }
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
  };

  const rawSet = storage.setItem.bind(storage);
  const rawRemove = storage.removeItem.bind(storage);
  storage.setItem = (k, v) => { rawSet(k, v); if (mirrored(k)) schedule(); };
  storage.removeItem = (k) => { rawRemove(k); if (mirrored(k)) schedule(); };

  // First boot on desktop: nothing on disk yet -> migrate the browser-era
  // keys out immediately rather than waiting for the first gameplay write.
  if (!hydrated) schedule();

  return { active: true, hydrated, flush };
}
```

Note the `debounceMs: 0` tests still go through `setTimeout(0)`; the test calls `r.flush()` explicitly, which cancels the pending timer and writes synchronously — that is the behaviour the code above implements (flush clears the timer first). Keep it that way.

- [ ] **Step 4: Run the test.** `node tests/desktop-store.test.mjs` — expected: all PASS, exit 0.

- [ ] **Step 5: Wire into boot.** In `src/main.js`, before anything reads storage (the imports run first — so the call goes at the very top of the module body, before the `URLSearchParams` parsing at `:25-28`; verify no imported module reads localStorage at import time — `grep -n "localStorage" src/systems/Profile.js src/core/LegacyStorage.js src/ui/GpuNotice.js` and confirm reads happen inside functions/constructors, not module top-level; if any module-top-level read exists, `initDesktopStore` must be called from an inline `<script type="module">` step instead — record which case held in the task report):

```javascript
import { initDesktopStore } from './core/DesktopStore.js';

initDesktopStore();
```

- [ ] **Step 6: Full gates.** `node tests/run.mjs` (all green, including the new test picked up by the runner — verify `run.mjs` globs `tests/*.test.mjs` and the new file appears in its output), `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` (zero fields moved).

- [ ] **Step 7: Commit.**

```bash
git add src/core/DesktopStore.js src/main.js tests/desktop-store.test.mjs
git commit -m "The profile learns to live in a file: hydrate at boot, mirror every write, browser build untouched"
```

---

### Task 2: The shell — `desktop/`, `app://`, and the pinned Electron

**Files:**
- Create: `desktop/main.mjs`
- Create: `desktop/preload.cjs`
- Create: `desktop/README.md`
- Modify: `vite.config.js` — add `base: './'`
- Modify: `package.json` — `"main": "desktop/main.mjs"`, scripts, pinned devDeps
- Test: manual boot gate this task; the probe (Task 3) is the real gate

**Interfaces:**
- Consumes: `dist/` from `vite build`; Task 1's bridge contract.
- Produces: `npm run desktop` (boots the shell against `dist/`); `__DESKTOP__` bridge `{ loadStore, saveStore }`; save file at `<userData>/save.json`, backup at `save.json.bak`; GPU log at `<userData>/gpu-info.json`; `TELLURIC_USERDATA` env override. Task 3 probes all of it; Task 4 packages it.

- [ ] **Step 1: Install, pinned.**

```bash
npm view electron version
npm install --save-dev --save-exact electron@<that version>
```

(electron-builder waits for Task 4.) Verify `npm run build` still succeeds and `git diff package.json` shows only the intended lines. Record the Electron version in `desktop/README.md` along with the STEAM.md warning: overlay behaviour is not stable across Electron majors; re-test after every bump; never bump casually.

- [ ] **Step 2: `desktop/preload.cjs`.** CommonJS on purpose — preloads run in a hybrid context and CJS is the no-surprises path:

```javascript
/**
 * The one bridge the renderer gets. Synchronous on load (the game hydrates
 * storage before its first system boots), fire-and-forget on save (the main
 * process owns atomicity). Nothing else crosses: no fs, no ipc pass-through.
 */
const { contextBridge, ipcRenderer } = require('electron');

const initial = ipcRenderer.sendSync('store:load');   // string | null, once, at boot

contextBridge.exposeInMainWorld('__DESKTOP__', {
  loadStore: () => initial,
  saveStore: (json) => { ipcRenderer.send('store:save', String(json)); },
});
```

- [ ] **Step 3: `desktop/main.mjs`.**

```javascript
/**
 * TELLURIC VOID desktop shell (Electron, Windows-only target).
 *
 * Serves the built web game over app:// (file:// breaks ES module
 * resolution, docs/STEAM.md section 5), keeps background throttling OFF (a
 * host that pauses on alt-tab desyncs every client), mirrors saves to one
 * atomically-written JSON under userData, and logs the GPU adapter so the
 * Optimus problem is diagnosable from a player report.
 */
import { app, BrowserWindow, ipcMain, protocol, net, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

if (process.env.TELLURIC_USERDATA) app.setPath('userData', process.env.TELLURIC_USERDATA);

// Must run before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const savePath = () => path.join(app.getPath('userData'), 'save.json');

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
let backedUp = false;

app.whenReady().then(async () => {
  // app://game/<path> -> dist/<path>, default document index.html.
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.normalize(path.join(DIST, rel));
    if (!target.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });

  const win = new BrowserWindow({
    width: 1600, height: 900,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
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
    fs.writeFileSync(path.join(app.getPath('userData'), 'gpu-info.json'), JSON.stringify(info, null, 2));
  } catch (err) { console.error('gpu-info failed', err); }
});

app.on('window-all-closed', () => app.quit());
```

The `let backedUp = false;` line must precede its first use — hoist it above the `ipcMain.on('store:save', ...)` block when writing the real file (shown below its use here only to keep the handler readable in the plan).

- [ ] **Step 4: Build config.** `vite.config.js` gains `base: './'` inside `defineConfig({...})`. `package.json` gains `"main": "desktop/main.mjs"` and scripts:

```json
"desktop": "npm run build && electron .",
"desktop:run": "electron ."
```

(`desktop:run` skips the rebuild for probe loops. Both invoke the local binary via npm scripts — never npx.)

- [ ] **Step 5: Boot gate.** `npm run desktop` — the window opens on the title screen, no devtools errors visible in the terminal. Then close it and check `%APPDATA%/telluric-void/save.json` exists (first-boot migration snapshot from Task 1 — even an empty-profile one) and `gpu-info.json` exists. On this headless-ish overnight box a windowed boot works (memory: capture-works-unattended-d3d11 — headed windows are fine); if the window cannot be verified visually, rely on Task 3's probe as the gate and say so in the report.

- [ ] **Step 6: Web-build gates.** `node tests/run.mjs`; `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json`; `node tools/capture.mjs $CAPFLAG --out shots-regress --only 01-title` then confirm `subjectsOk: true` and delete `shots-regress/` — proves `base: './'` broke nothing under the dev server the whole capture stack uses.

- [ ] **Step 7: Commit.**

```bash
git add desktop/ vite.config.js package.json package-lock.json
git commit -m "The game gets a body: an app:// shell that never throttles its host and saves to a real file"
```

---

### Task 3: `tools/desktopprobe.mjs` — the shell under instruments

**Files:**
- Create: `tools/desktopprobe.mjs`

**Interfaces:**
- Consumes: Playwright `_electron` (`import { _electron } from 'playwright'`); `desktop/main.mjs`; a scratch `TELLURIC_USERDATA`.
- Produces: `node tools/desktopprobe.mjs [--record reviews/round8/desktop-probe-record.json]` — exit 0/1 with a record JSON, the repo's probe convention (`tools/gaugeshot.mjs:68-72,209-226`).

- [ ] **Step 1: Write the probe.** Boot the shell twice against a scratch userData and gate the whole Phase-1 story:

```javascript
/**
 * The desktop shell under instruments: two boots against a scratch userData.
 *
 * Boot 1: app:// serves the real dist, the title screen renders, a profile
 * write lands in save.json (atomically: no .tmp left behind), gpu-info.json
 * exists.
 * Boot 2: the save hydrates back into localStorage before the game reads it.
 *
 *   node tools/desktopprobe.mjs [--record reviews/round8/desktop-probe-record.json]
 */
import { _electron } from 'playwright';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const RECORD = String(args.record ?? 'reviews/round8/desktop-probe-record.json');

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  -- ${JSON.stringify(detail)}`}`);
};

const userData = mkdtempSync(path.join(tmpdir(), 'telluric-probe-'));
const boot = () => _electron.launch({
  args: ['desktop/main.mjs'],
  env: { ...process.env, TELLURIC_USERDATA: userData },
});

// ---- boot 1: cold ----
let app = await boot();
let page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.waitForSelector('[data-screen="title"]', { timeout: 60000 });
  check('boot 1: title screen over app://', true);
  check('boot 1: page url is app://', page.url().startsWith('app://'), page.url());

  // A prefixed write must reach the file through the mirror.
  await page.evaluate(() => localStorage.setItem('telluric.probeMark', 'boot1'));
  await page.waitForTimeout(1500);   // > DesktopStore debounce
  const savePath = path.join(userData, 'save.json');
  check('boot 1: save.json written', existsSync(savePath));
  check('boot 1: no torn tmp left', !existsSync(`${savePath}.tmp`));
  const snap = existsSync(savePath) ? JSON.parse(readFileSync(savePath, 'utf8')) : {};
  check('boot 1: the write is in the file', snap['telluric.probeMark'] === 'boot1');
  check('boot 1: gpu-info.json written', existsSync(path.join(userData, 'gpu-info.json')));
  check('boot 1: no page errors', errors.length === 0, errors);
} finally { await app.close(); }

// ---- boot 2: warm ----
app = await boot();
page = await app.firstWindow();
try {
  await page.waitForSelector('[data-screen="title"]', { timeout: 60000 });
  const mark = await page.evaluate(() => localStorage.getItem('telluric.probeMark'));
  check('boot 2: the file hydrated localStorage', mark === 'boot1', mark);
} finally { await app.close(); }

rmSync(userData, { recursive: true, force: true });

const failed = checks.filter((c) => !c.pass).length;
writeFileSync(RECORD, `${JSON.stringify({
  tool: 'tools/desktopprobe.mjs',
  command: 'node tools/desktopprobe.mjs',
  checks, ok: failed === 0,
}, null, 2)}\n`);
console.log(`${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

Verify against the live tree while writing: (a) the title screen's selector — `grep -n "data-screen" src/ui/Menus.js | head -3` and use whatever the title actually sets (`Harness.js:2496-2500` asserts `[data-screen="title"]` per the diegetic-ui plan, so it should hold); (b) `_electron.launch` needs the electron binary — it resolves from the local devDep automatically; if not, pass `executablePath: require('electron')` semantics via `import electronPath from 'electron'` in an `.mjs`-safe way (`const electronPath = (await import('electron')).default` returns the binary path when imported from node, not inside electron). Playwright's own docs cover `_electron`; the probe must not need network access.

- [ ] **Step 2: Run it.** `npm run build && node tools/desktopprobe.mjs` — expected: every check PASS, record `ok: true`, exit 0. This is the slice's central gate; a failure here is debugged, never waived.

- [ ] **Step 3: Commit.**

```bash
git add tools/desktopprobe.mjs reviews/round8/desktop-probe-record.json
git commit -m "The shell is probed like everything else: two boots, one file, every claim on disk"
```

---

### Task 4: The portable package

**Files:**
- Create: package.json `"build"` section (electron-builder config)
- Modify: `package.json` scripts; `.gitignore` (add `dist-desktop/`)
- Modify: `desktop/README.md` — how to pack, what ships, what is deliberately absent (Steam SDK, signing, installer)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `npm run desktop:pack` -> `dist-desktop/win-unpacked/TELLURIC VOID.exe`, the folder SteamPipe will eventually upload.

- [ ] **Step 1: Install, pinned.** `npm view electron-builder version` then `npm install --save-dev --save-exact electron-builder@<that version>`. No npx.

- [ ] **Step 2: Configure.** In `package.json`:

```json
"build": {
  "appId": "com.olliface.telluricvoid",
  "productName": "TELLURIC VOID",
  "directories": { "output": "dist-desktop" },
  "files": ["desktop/**", "dist/**", "package.json"],
  "win": { "target": "dir", "signAndEditExecutable": false }
},
"scripts": {
  "desktop:pack": "npm run build && electron-builder --win --dir"
}
```

`"target": "dir"` only — no NSIS, no signing, per STEAM.md (Valve launches the exe itself; codesigning unnecessary for a Steam-only launch). Watch the STEAM.md §4 warning in reverse: `files` must NOT include `node_modules` (electron-builder excludes devDeps automatically, but confirm the packed folder holds no `three/` source — the game is inside `dist/`) and must not ship `dist/*.map` if present — check `ls dist/assets` after build; if sourcemaps exist, exclude them with `"!dist/**/*.map"` in `files` and note it in the README.

- [ ] **Step 3: Pack and probe the packed exe.** `npm run desktop:pack`, then re-run the probe against the packaged binary:

```bash
node tools/desktopprobe.mjs --exe "dist-desktop/win-unpacked/TELLURIC VOID.exe"
```

Add `--exe` support to the probe (one argument: when present, `_electron.launch({ executablePath: EXE, args: [], env: ... })` — the packaged app carries its own main; verify the flag parses and both modes still pass). Expected: all checks PASS against the packed exe too, recorded to `reviews/round8/desktop-probe-record.json` (the record gains a `mode: 'dev' | 'packed'` field; final committed record is the packed run).

- [ ] **Step 4: Gates.** `node tests/run.mjs`; `git status --short` shows no `dist-desktop/` (ignored) and no stray files.

- [ ] **Step 5: Commit.**

```bash
git add package.json package-lock.json .gitignore desktop/README.md tools/desktopprobe.mjs reviews/round8/desktop-probe-record.json
git commit -m "The body ships as a folder: packed, probed, and honest about what it does not yet contain"
```

---

## Self-Review

- **Spec coverage (STEAM.md low-risk engineering rows):** shell + `app://` + packaging (Tasks 2, 4); saves -> JSON (Task 1); `backgroundThrottling: false` (Task 2, the STEAM.md §5 frame-pacing row's shipped half — the worker-tick alternative is deliberately not built, the flag is the documented sufficient fix inside Electron); GPU logging (Task 2) with the warn UX already existing (`src/ui/GpuNotice.js`); module-loading gotcha (app:// scheme, Task 2); localStorage-cannot-sync gotcha (Task 1). Steam-SDK-dependent rows are explicitly out of scope in the header.
- **Placeholders:** `<that version>`/`<userData>` are resolve-at-execution values with the resolving command given. No TBDs.
- **Type consistency:** bridge shape `{ loadStore(): string|null, saveStore(json) }` identical in Task 1 (consumer + fakes), Task 2 preload (provider), Task 3 probe (asserts its effect). `TELLURIC_USERDATA` spelled identically in Tasks 2 and 3. `save.json` path identical in Tasks 2 and 3.
