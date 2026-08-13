/**
 * The desktop shell under instruments: two boots against a scratch userData.
 *
 * Boot 1: app:// serves the real dist, the title screen renders, the renderer
 * has no node and exactly the two-function bridge, a profile write lands in
 * save.json (atomically: no .tmp left behind), gpu-info.json exists.
 * Boot 2: the save hydrates back into localStorage before the game reads it.
 *
 * Two modes, same checks:
 *   dev    -- launches the local electron binary on desktop/main.mjs
 *   packed -- launches a packaged executable, which carries its own main
 *
 *   node tools/desktopprobe.mjs                      -> ...record.json
 *   node tools/desktopprobe.mjs --exe "dist-desktop/win-unpacked/TELLURIC VOID.exe"
 *                                                    -> ...record-packed.json
 *
 * --record overrides the destination. Each record carries its own provenance
 * (sha, when, electron, playwright) so it can be re-derived, not just believed.
 */
import { _electron } from 'playwright';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// The committed record has to be re-derivable by whoever finds it: which tree,
// which runtimes, when. Without these it is a claim, not evidence.
const require = createRequire(import.meta.url);
const version = (pkg) => { try { return require(`${pkg}/package.json`).version; } catch { return null; } };
const gitSha = () => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
};

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
// --exe takes a path; a bare --exe (parsed as `true`) is a typo, not a mode.
if (args.exe === true) {
  console.error('--exe needs a path to the packaged executable');
  process.exit(2);
}
const EXE = args.exe ? String(args.exe) : null;
if (EXE && !existsSync(EXE)) {
  console.error(`--exe: no such file: ${EXE}`);
  process.exit(2);
}
const MODE = EXE ? 'packed' : 'dev';
// One record per mode: the packed run used to overwrite the dev run's, which
// left the repo with no evidence for the mode CI would actually exercise.
const RECORD = String(args.record ?? `reviews/round8/desktop-probe-record${EXE ? '-packed' : ''}.json`);
console.log(`mode: ${MODE}${EXE ? `  -- ${EXE}` : ''}`);

// The exact `window.__STEAM__` surface, sorted. Anything more is a widening of
// the renderer's reach into the main process and must go red here.
const STEAM_BRIDGE_KEYS = [
  'getFullLobbyData', 'getLobbyOwner', 'hostLobby', 'joinLobby', 'leaveLobby',
  'onJoinRequested', 'onSignal', 'onSignalFail', 'openInviteDialog', 'sendSignal',
  'startSignalListen', 'status', 'stopSignalListen', 'writeLobbyData',
].sort();

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  -- ${JSON.stringify(detail)}`}`);
};

const userData = mkdtempSync(path.join(tmpdir(), 'telluric-probe-'));
const boot = () => _electron.launch({
  ...(EXE ? { executablePath: EXE, args: [] } : { args: ['desktop/main.mjs'] }),
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

  // The plan calls the isolation non-negotiable, so it is gated here rather
  // than re-verified by hand: a webPreferences edit that widens it must go red.
  const iso = await page.evaluate(() => ({
    req: typeof require, proc: typeof process,
    keys: Object.keys(globalThis.__DESKTOP__ ?? {}).sort(),
    steamKeys: Object.keys(globalThis.__STEAM__ ?? {}).sort(),
  }));
  check('boot 1: renderer has no node (require/process undefined)',
    iso.req === 'undefined' && iso.proc === 'undefined', iso);
  check('boot 1: bridge exposes exactly loadStore + saveStore',
    JSON.stringify(iso.keys) === '["loadStore","saveStore"]', iso.keys);
  // The Steam bridge is the second surface the isolation claim now rests on.
  // Pinned as an exact set, not a subset: the danger is something ARRIVING
  // here -- a client object, a getClient, a generic invoke -- and a
  // "contains what we expect" check would never see it.
  check('boot 1: the Steam bridge is exactly its named functions, nothing that reaches the native module',
    JSON.stringify(iso.steamKeys) === JSON.stringify(STEAM_BRIDGE_KEYS), iso.steamKeys);

  // One real round trip through the new bridge. Asserts only the invariant
  // that holds on any box: a Steam-less machine answers available:false with a
  // reason, a Steam-running one answers available:true with none.
  const steam = await page.evaluate(() => globalThis.__STEAM__.status());
  check('boot 1: __STEAM__.status() answers with the documented shape',
    steam !== null && typeof steam === 'object' && typeof steam.available === 'boolean'
      && (steam.available ? steam.reason === null : typeof steam.reason === 'string' && steam.reason.length > 0),
    steam);

  // A prefixed write must reach the file through the mirror.
  await page.evaluate(() => localStorage.setItem('telluric.probeMark', 'boot1'));
  await page.waitForTimeout(1500);   // > DesktopStore debounce
  const savePath = path.join(userData, 'save.json');
  check('boot 1: save.json written', existsSync(savePath));
  check('boot 1: no torn tmp left', !existsSync(`${savePath}.tmp`));
  const snap = existsSync(savePath) ? JSON.parse(readFileSync(savePath, 'utf8')) : {};
  check('boot 1: the write is in the file', snap['telluric.probeMark'] === 'boot1');
  check('boot 1: no page errors', errors.length === 0, errors);
} finally { await app.close(); }
// gpu-info is written from an awaited getGPUInfo after loadURL -- checking
// it mid-session races a slow GPU-process boot. After close it must exist.
check('boot 1: gpu-info.json written', existsSync(path.join(userData, 'gpu-info.json')));

// ---- edit the save out-of-band ----
// Boot 2's hydration check would be tautological otherwise: both boots share
// the userData partition, so Chromium's own localStorage persistence would
// carry probeMark across even with hydration deleted. Rewriting the file
// between boots means boot 2 can only see the new value if the FILE
// overwrote Chromium's persisted copy -- the file-is-source-of-truth
// precedence DesktopStore claims.
{
  const savePath = path.join(userData, 'save.json');
  const snap = JSON.parse(readFileSync(savePath, 'utf8'));
  snap['telluric.probeMark'] = 'edited-on-disk';
  writeFileSync(savePath, JSON.stringify(snap));
}

// ---- boot 2: warm ----
app = await boot();
page = await app.firstWindow();
const errors2 = [];
page.on('pageerror', (e) => errors2.push(e.message));
try {
  await page.waitForSelector('[data-screen="title"]', { timeout: 60000 });
  const mark = await page.evaluate(() => localStorage.getItem('telluric.probeMark'));
  check('boot 2: the file hydrated localStorage over Chromium\'s own copy', mark === 'edited-on-disk', mark);
  check('boot 2: no page errors', errors2.length === 0, errors2);
} finally { await app.close(); }

// Scratch cleanup only -- on Windows the browser process can hold handles
// briefly after close; a cleanup race must not fail a probe that passed.
try { rmSync(userData, { recursive: true, force: true }); } catch {}

const failed = checks.filter((c) => !c.pass).length;
writeFileSync(RECORD, `${JSON.stringify({
  tool: 'tools/desktopprobe.mjs',
  command: EXE ? `node tools/desktopprobe.mjs --exe ${JSON.stringify(EXE)}` : 'node tools/desktopprobe.mjs',
  mode: MODE,
  exe: EXE,
  when: new Date().toISOString(),
  sha: gitSha(),
  electron: version('electron'),
  playwright: version('playwright'),
  checks, ok: failed === 0,
}, null, 2)}\n`);
console.log(`${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
