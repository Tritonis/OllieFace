/**
 * Guarded steamworks.js init for the Electron MAIN process.
 *
 * steamworks.js is a native N-API module: the renderer never touches it, and
 * `getClient()` is main-process internal — it must never cross IPC. What does
 * cross (later tasks) is the status record and nothing else.
 *
 * Everything here is failure-tolerant on purpose. Steam not running, no
 * `steam_appid.txt`, a mismatched native binary, a Steam client that dies
 * mid-call — all of it collapses to `{ available: false, reason }`. The desktop
 * shell must boot identically for a player who has never opened Steam, so this
 * module throws nothing, shows nothing, and blocks on nothing.
 *
 * NO CALLBACK PUMP IS STARTED HERE, and none should be added. steamworks.js's
 * own `init()` installs one (`node_modules/steamworks.js/index.js:33-34`:
 * `setInterval(runCallbacks, 1000/30)`) and strips `runCallbacks` out of the
 * object it returns — which the typings restate as
 * `Omit<Client, "init" | "runCallbacks">` (`index.d.ts:1`). Callbacks
 * registered through `client.callback.register` just fire.
 *
 * Deliberately imports nothing from Electron, so `tests/desktop-steam.test.mjs`
 * can exercise the degradation contract in plain node.
 */
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Spacewar, Valve's public test id. The real app id replaces this when it
// arrives; `steam_appid.txt` at the repo root carries the same number for the
// dev loop, and shipping builds exclude that file and get the id from Steam.
export const DEV_APP_ID = 480;

let client = null;
// The steamworks.js MODULE (not the client): `electronEnableSteamOverlay` hangs
// off the module, not off the object `init()` returns, so `enableOverlay()`
// needs the handle `initSteam` already resolved rather than a second require.
let steamworksModule = null;
let status = { available: false, appId: null, personaName: null, reason: 'initSteam has not run' };

// A message that is always worth logging: `reason` is a diagnostic, so an empty
// string or a bare "[object Object]" would be a bug in its own right.
const describe = (err) => {
  const m = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
  return m && m.trim() ? m.trim() : 'steamworks.js init failed without a message';
};

/**
 * Initialise Steam, or explain why not.
 *
 * @param {number} [appIdOverride] app id to init against; defaults to Spacewar.
 * @param {{ load?: () => any }} [deps] test seam — `load` returns the
 *   steamworks.js module. Production never passes it.
 * @returns {{ available: boolean, appId: number|null, personaName: string|null, reason: string|null }}
 */
export function initSteam(appIdOverride, deps = {}) {
  const appId = Number.isInteger(appIdOverride) ? appIdOverride : DEV_APP_ID;
  const load = deps.load ?? (() => requireCjs('steamworks.js'));

  client = null;
  steamworksModule = null;
  try {
    // Two separately fallible things — resolving a native binary, and Steam
    // itself answering — but the caller only ever needs one verdict.
    const steamworks = load();
    const c = steamworks.init(appId);
    if (!c) throw new Error('steamworks.init returned no client');

    // Read back what Steam actually says rather than what we asked for: a
    // running client can be attached to a different app than the id we passed,
    // and a log claiming 480 when Steam thinks otherwise is a log that lies.
    // These calls are also the first real proof the client works — if any of
    // them throws, we have a handle we cannot trust, so we drop it.
    const personaName = c.localplayer.getName();
    const runningAppId = c.utils.getAppId();

    client = c;
    steamworksModule = steamworks;
    status = { available: true, appId: runningAppId, personaName, reason: null };
  } catch (err) {
    client = null;
    steamworksModule = null;
    status = { available: false, appId: null, personaName: null, reason: describe(err) };
  }
  return { ...status };
}

/**
 * Turn on the Steam overlay — the ONLY way an invite dialog can render, since
 * this binding has no programmatic invite call.
 *
 * Must be called before `app.whenReady()`: it appends `in-process-gpu` and
 * `disable-direct-composition` to the command line
 * (`node_modules/steamworks.js/index.js:50-74`), and switches appended after
 * ready are ignored. It also attaches a 60 Hz repaint invalidator to every
 * window, which self-skips while the page is already painting.
 *
 * CALL THIS ONLY WHEN `initSteam()` REPORTED `available: true`. A Steam-absent
 * player must get zero switches and zero timers — an unchanged GPU path is a
 * binding constraint, and `gpu-info.json`'s Optimus diagnostic reads that path.
 * The `available` guard is enforced here as well as at the call site, so a
 * future caller cannot get it wrong by forgetting.
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function enableOverlay() {
  if (!status.available || !steamworksModule) return { ok: false, reason: 'steam-unavailable' };
  try {
    steamworksModule.electronEnableSteamOverlay();
    return { ok: true, reason: null };
  } catch (err) {
    // A failed overlay is a degraded invite button, not a failed boot.
    return { ok: false, reason: describe(err) };
  }
}

/** The live steamworks client, or null. MAIN-PROCESS ONLY — never send this over IPC. */
export function getClient() {
  return client;
}

/** A copy of the last init verdict, safe to hand to anyone (including the renderer). */
export function getStatus() {
  return { ...status };
}
