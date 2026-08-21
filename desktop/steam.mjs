/**
 * Guarded `steamworks-ffi-node` init for the Electron MAIN process.
 *
 * The Binding is Koffi FFI over `steam_api64.dll`: the renderer never touches
 * it, and `getClient()` is main-process internal — it must never cross IPC.
 * What does cross is the status record and nothing else.
 *
 * Everything here is failure-tolerant on purpose. Steam not running, a missing
 * vendored `steamworks_sdk/` tree, a Steam client that dies mid-call — all of
 * it collapses to `{ available: false, reason }`. The desktop shell must boot
 * identically for a player who has never opened Steam, so this module throws
 * nothing, shows nothing, and blocks on nothing.
 *
 * TWO THINGS CHANGED WITH THE BINDING (phase 2 plan step 4):
 *
 *  1. THE MODULE IS A SINGLETON, NOT A FACTORY. `steamworks.js` returned a
 *     client from `init()`; this one hands out one `SteamworksSDK` instance
 *     from `getInstance()` and `init()` answers a bare boolean. So "did it
 *     work" is `init() === true` AND the interrogation below, not truthiness of
 *     a returned object.
 *
 *  2. NOTHING PUMPS CALLBACKS FOR US. `steamworks.js` installed its own 30 Hz
 *     `runCallbacks` interval and hid the function; this Binding exposes
 *     `runCallbacks()` and starts no timer. That is deliberate here too: the
 *     one broadcast callback this shell needs (GameLobbyJoinRequested, 333) is
 *     not in the Binding's surface at all, and `desktop/steam-callbacks.mjs`
 *     owns the manual-dispatch pump that hears it. NO PUMP IS STARTED IN THIS
 *     FILE, and none should be added — a second pump on one pipe steals
 *     callbacks from the first.
 *
 * Deliberately imports nothing from Electron, so `tests/desktop-steam.test.mjs`
 * can exercise the degradation contract in plain node.
 */
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// The real app id (Valve completed partner processing 2026-08-20).
// `steam_appid.txt` at the repo root carries the same number for the dev loop;
// shipping builds exclude that file and get the id from Steam.
export const DEV_APP_ID = 5150570;

let client = null;
/** The MODULE, kept for module-level entry points (there are none the shell
 *  uses today — see `enableOverlay` — but the handle costs nothing and a second
 *  `require` of a Koffi module is not free). */
let steamworksModule = null;
let status = { available: false, appId: null, personaName: null, reason: 'initSteam has not run' };

// A message that is always worth logging: `reason` is a diagnostic, so an empty
// string or a bare "[object Object]" would be a bug in its own right.
const describe = (err) => {
  const m = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err);
  return m && m.trim() ? m.trim() : 'steam init failed without a message';
};

/**
 * The instance a loaded module hands out.
 *
 * Three shapes are tolerated because three exist in the wild: the CJS module
 * with `.SteamworksSDK`, the ESM-interop `.default`, and — the shape every test
 * fake in this repo uses — an object that is already the SDK. Whichever it is,
 * what comes back must answer `init`.
 */
const instanceOf = (mod) => {
  const SDK = (mod && (mod.SteamworksSDK ?? mod.default)) ?? mod;
  const sdk = SDK && typeof SDK.getInstance === 'function' ? SDK.getInstance() : SDK;
  if (!sdk || typeof sdk.init !== 'function') throw new Error('the Steam binding exposes no init()');
  return sdk;
};

/**
 * Initialise Steam, or explain why not.
 *
 * @param {number} [appIdOverride] app id to init against; defaults to the real id.
 * @param {{ load?: () => any }} [deps] test seam — `load` returns the Binding
 *   module. Production never passes it.
 * @returns {{ available: boolean, appId: number|null, personaName: string|null, reason: string|null }}
 */
export function initSteam(appIdOverride, deps = {}) {
  const appId = Number.isInteger(appIdOverride) ? appIdOverride : DEV_APP_ID;
  const load = deps.load ?? (() => requireCjs('steamworks-ffi-node'));

  client = null;
  steamworksModule = null;
  try {
    // Three separately fallible things — resolving the Koffi module, finding
    // the vendored DLL, and Steam itself answering — but the caller only ever
    // needs one verdict.
    const steamworks = load();
    const sdk = instanceOf(steamworks);
    if (sdk.init({ appId }) !== true) throw new Error('steam.init() reported failure');

    // Read back what Steam actually says rather than what we asked for: a
    // running client can be attached to a different app than the id we passed,
    // and a log claiming 5150570 when Steam thinks otherwise is a log that
    // lies. These calls are also the first real proof the Binding works — and
    // that matters more here than it did under `steamworks.js`, because Koffi
    // resolves symbols LAZILY: `init()` succeeding proves only that one symbol
    // exists. If either of these throws we have a handle we cannot trust, so we
    // drop it.
    const personaName = sdk.friends.getPersonaName();
    const runningAppId = sdk.utils.getAppID();

    client = sdk;
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
 * The Steam overlay — kept as a named, guarded no-op rather than deleted.
 *
 * REFUTED 2026-08-21 (`reviews/spike-sitting-0820/VERDICT.md`, #127). Three
 * arrangements injected `gameoverlayrenderer64.dll` and registered the process
 * as the game; none ever painted, this Binding's GL mirror included — its
 * `beginFrameSubscription` never delivers a frame on Electron 43 for an
 * onscreen window. So there is nothing here to enable, and the invite path no
 * longer needs one: it is programmatic (`matchmaking.inviteUserToLobby`).
 *
 * The function survives because its CALLER's guard is the thing worth keeping —
 * a Steam-absent player must get zero appended command-line switches and zero
 * repaint timers, and that constraint is asserted here as well as at the call
 * site so a future overlay attempt cannot get it wrong by forgetting. When
 * `load()` hands over a module that still carries `electronEnableSteamOverlay`
 * (the `steamworks.js` shape), it is honoured; the shipping Binding has no such
 * export and says so.
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function enableOverlay() {
  if (!status.available || !steamworksModule) return { ok: false, reason: 'steam-unavailable' };
  if (typeof steamworksModule.electronEnableSteamOverlay !== 'function') {
    return { ok: false, reason: 'overlay-not-bound-by-this-binding' };
  }
  try {
    steamworksModule.electronEnableSteamOverlay();
    return { ok: true, reason: null };
  } catch (err) {
    // A failed overlay is a degraded button, not a failed boot.
    return { ok: false, reason: describe(err) };
  }
}

/** The live Steam SDK instance, or null. MAIN-PROCESS ONLY — never send this over IPC. */
export function getClient() {
  return client;
}

/** A copy of the last init verdict, safe to hand to anyone (including the renderer). */
export function getStatus() {
  return { ...status };
}
