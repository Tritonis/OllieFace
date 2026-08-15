/**
 * A test-only Koffi binding for the flat entry points no Steam Binding binds.
 *
 * **This module must never be imported by shipping code.** It opens raw sockets
 * through the Steam library by FFI, it exists to make a gate possible, and
 * `tests/steam-smoke.test.mjs` asserts that nothing under `src/` or `desktop/`
 * reaches for it. `koffi` is a devDependency for the same reason.
 *
 * ## Why it exists
 *
 * Arm B of [ADR 0002](../docs/adr/0002-networking-coverage-after-webrtc.md), and
 * issue #64. Every way either candidate Binding can open a Steam connection is
 * addressed by Steam identity, and one box holds one identity — so no automated
 * test on this machine can watch the real Steam library carry the real protocol.
 * `ISteamNetworkingSockets::CreateSocketPair` is the exception Valve wrote for
 * exactly this purpose: two real connections in one process, and with
 * `bUseNetworkLoopback = true` the packets go through 127.0.0.1 with real
 * packetisation, encryption, and configurable fake lag and loss.
 *
 * `steamworks-ffi-node@0.10.4` binds 24 `NetworkingSockets` entry points and
 * none of them is `CreateSocketPair`; `steamworks.js@0.4.0` has four legacy
 * `ISteamNetworking` functions, all SteamID64-addressed. Neither package
 * contains the string `CreateSocketPair` at all. The evidence is
 * `docs/STEAM.md` section 8.3.
 *
 * ## Why this is small
 *
 * The Binding is Koffi FFI over the flat C API in `steam_api64.dll`, so
 * declarations are data. There is no compiler, no native fork, and no patched
 * package here — just this file naming symbols that Valve already exports and
 * that `npm run steamsdk` already checks for.
 *
 * Of the four entry points #64 names, **two are bound and two are only checked
 * to exist**: `CreateListenSocketIP` and `ConnectByIPAddress` belong to the
 * two-process arm, which the issue makes conditional and which is not built.
 * See `TWO_PROCESS_SYMBOLS`.
 *
 * ## Three things it refuses to assume
 *
 * 1. **The interface accessor version.** SDK 1.65 moved
 *    `SteamAPI_SteamNetworkingSockets_SteamAPI` from `_v012` to `_v013`, which
 *    cost #52 a plan assumption and left #64's own issue text saying v013 while
 *    the tree carries 1.64 and v012. So the version is *discovered* from the
 *    DLL's exports and the newest one wins. An SDK bump does not edit this file.
 * 2. **That the symbols are there.** Every declared symbol is checked against
 *    the DLL's exports before `koffi.load`, so a missing one is a named error at
 *    startup rather than an access violation on first call. This is the same
 *    lazy-binding trap `tools/steamsdk.mjs` exists to defuse for the Binding.
 * 3. **The config enum numbers.** `k_ESteamNetworkingConfig_FakePacketLag_Recv`
 *    is a number in a header this repo does not vendor, and a wrong number would
 *    silently configure something else. `SteamAPI_ISteamNetworkingUtils_GetConfigValueInfo`
 *    returns each value's real name, so the numbers below are verified against
 *    the library at startup instead of trusted.
 *
 * ## What it does not do
 *
 * No `SteamAPI_RestartAppIfNecessary` — that relaunches the process through
 * Steam, which is the last thing a test harness should do. No callbacks are
 * registered: a socket pair is connected the moment it is created, so nothing
 * here needs a connection-status callback to make progress.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The DLL `tools/steamsdk.mjs` vendors, and the one the Binding will load too. */
export const VENDOR_REL = 'steamworks_sdk/redistributable_bin/win64/steam_api64.dll';

/** The versioned interface accessors, without their `_vNNN` suffix. */
export const ACCESSORS = {
  sockets: 'SteamAPI_SteamNetworkingSockets_SteamAPI',
  utils: 'SteamAPI_SteamNetworkingUtils_SteamAPI',
};

/**
 * Every symbol this module actually binds through Koffi. Checked against the
 * DLL before anything is loaded, so a missing one is a named error at startup
 * rather than an access violation on first call — the lazy-binding trap
 * `docs/STEAM.md` section 8.6 exists to defuse.
 *
 * The first two are what #64 is about; the rest are what it takes to carry a
 * message at all.
 */
export const BOUND_SYMBOLS = [
  'SteamAPI_ISteamNetworkingSockets_CreateSocketPair',
  'SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32',
  'SteamAPI_InitFlat',
  'SteamAPI_Shutdown',
  'SteamAPI_RunCallbacks',
  'SteamAPI_ISteamNetworkingSockets_SendMessageToConnection',
  'SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection',
  'SteamAPI_ISteamNetworkingSockets_FlushMessagesOnConnection',
  'SteamAPI_ISteamNetworkingSockets_CloseConnection',
  'SteamAPI_ISteamNetworkingSockets_RunCallbacks',
  'SteamAPI_ISteamNetworkingUtils_GetConfigValueInfo',
  'SteamAPI_SteamNetworkingMessage_t_Release',
];

/**
 * Existence-checked but deliberately **not bound**: these are the two-process
 * arm, and the issue makes them conditional — "only if a two-process arm is
 * wanted". It is not wanted yet, so binding them would be generality for a need
 * nothing has.
 *
 * They are still checked, for the reason `tools/steamsdk.mjs` checks them too:
 * an SDK swap that quietly dropped either one would remove the option of ever
 * building that arm, and the point of checking a vendored binary is to find that
 * out on the day of the swap rather than on the day someone needs it.
 */
export const TWO_PROCESS_SYMBOLS = [
  'SteamAPI_ISteamNetworkingSockets_CreateListenSocketIP',
  'SteamAPI_ISteamNetworkingSockets_ConnectByIPAddress',
];

/** Everything this module wants present in the DLL, bound or not. */
export const REQUIRED_SYMBOLS = [...BOUND_SYMBOLS, ...TWO_PROCESS_SYMBOLS];

/**
 * How many batches of `RECV_BATCH` one `receive()` call will drain before
 * returning. Without it the drain is an unbounded loop inside the caller's hot
 * loop, which would let a pathological sender hold the run past the cap that
 * loop is responsible for enforcing — and this repo's tools claim in their own
 * records that every wait is capped.
 *
 * Stopping early loses nothing: unread messages stay queued in the library and
 * the next pass of the hot loop, microseconds later, takes them. 2048 messages
 * per connection per call is already two orders of magnitude more than a 60 Hz
 * sender can put in flight between two passes.
 */
export const RECV_DRAIN_BATCHES = 64;

/**
 * `k_nSteamNetworkingSend_*`, the two combinations the game's two channels map
 * onto. `state` is WebRTC's `{ ordered: false, maxRetransmits: 0 }`; `events` is
 * its ordered reliable channel. NoNagle on both, because the WebRTC channels do
 * not coalesce either and a Nagle delay would be measured as latency the
 * transport did not have.
 */
export const SEND = {
  UNRELIABLE_NO_NAGLE: 1, // k_nSteamNetworkingSend_Unreliable(0) | NoNagle(1)
  RELIABLE_NO_NAGLE: 9,   // k_nSteamNetworkingSend_Reliable(8)   | NoNagle(1)
};

/**
 * `ESteamNetworkingConfigValue`, the impairment subset. Every one of these is
 * verified by name against the library at startup — see `verifyConfigNames`.
 * Receive-side and one-directional, which is the same shape as this repo's own
 * `?netlag=` / `?netloss=` rig (`src/net/NetConfig.js`), so the port is a port.
 */
export const CONFIG = {
  FakePacketLoss_Send: 2,
  FakePacketLoss_Recv: 3,
  FakePacketLag_Send: 4,
  FakePacketLag_Recv: 5,
  FakePacketReorder_Send: 6,
  FakePacketReorder_Recv: 7,
  FakePacketReorder_Time: 8,
};

/** `k_EResultOK`. */
const RESULT_OK = 1;

/** `k_ESteamAPIInitResult_OK`. */
const INIT_OK = 0;

// ------------------------------------------------------------------ pure part
/**
 * Exported names read out of the DLL's bytes rather than its PE export table —
 * the same trade `tools/steamsdk.mjs` makes and for the same reason: export
 * names are plain ASCII, `SteamAPI_` is an unambiguous prefix, and the
 * alternative is a PE parser this repo would then own. The failure this guards
 * against is a name that is simply absent, and that cannot hide from it.
 */
export const exportedSymbols = (dll) =>
  new Set(String(dll.toString('latin1')).match(/SteamAPI_[A-Za-z0-9_]+/g) ?? []);

/**
 * The highest `${base}_vNNN` the DLL exports, or `null`. Compared as numbers, so
 * a future `_v10` does not lose to `_v9` on string order.
 */
export function pickAccessor(exports, base) {
  let best = null;
  for (const name of exports) {
    if (!name.startsWith(`${base}_v`)) continue;
    const m = name.slice(base.length).match(/^_v(\d+)$/);
    if (!m) continue;
    const version = Number(m[1]);
    if (!best || version > best.version) best = { symbol: name, version };
  }
  return best;
}

export const missingSymbols = (exports, symbols) => symbols.filter((s) => !exports.has(s));

// -------------------------------------------------------------- the live part
/**
 * Open the Steam library and hand back the flat surface, or throw with a reason
 * a human can act on.
 *
 * Needs a running Steam client. Everything above this line does not.
 */
export function openSteamNet({ appId = 480, dllPath = path.join(root, VENDOR_REL), verbose = false } = {}) {
  if (!existsSync(dllPath)) {
    throw new Error(`no Steam library at ${dllPath} - run \`npm run steamsdk -- --zip <steamworks_sdk_NNN.zip>\``);
  }

  const dllBytes = readFileSync(dllPath);
  const exports = exportedSymbols(dllBytes);

  const missing = missingSymbols(exports, REQUIRED_SYMBOLS);
  if (missing.length) {
    throw new Error(`this steam_api64.dll is missing ${missing.length} symbol(s) this gate calls: ${missing.join(', ')}`);
  }

  const accessorNames = {};
  for (const [key, base] of Object.entries(ACCESSORS)) {
    const picked = pickAccessor(exports, base);
    if (!picked) throw new Error(`this steam_api64.dll exports no ${base}_vNNN accessor`);
    accessorNames[key] = picked.symbol;
  }

  // The appid the SDK looks for. Set explicitly rather than relying on
  // `steam_appid.txt` being in the process's cwd, which makes the gate
  // insensitive to where it was launched from.
  process.env.SteamAppId = String(appId);
  process.env.SteamGameId = String(appId);

  const koffi = require('koffi');
  const lib = koffi.load(dllPath);

  const ptr = koffi.pointer('void');
  const outU32 = koffi.out(koffi.pointer('uint32'));
  const outI32 = koffi.out(koffi.pointer('int'));

  const fn = {
    initFlat: lib.func('SteamAPI_InitFlat', 'int', [ptr]),
    shutdown: lib.func('SteamAPI_Shutdown', 'void', []),
    runCallbacks: lib.func('SteamAPI_RunCallbacks', 'void', []),
    sockets: lib.func(accessorNames.sockets, ptr, []),
    utils: lib.func(accessorNames.utils, ptr, []),
    createSocketPair: lib.func('SteamAPI_ISteamNetworkingSockets_CreateSocketPair', 'bool',
      [ptr, outU32, outU32, 'bool', ptr, ptr]),
    send: lib.func('SteamAPI_ISteamNetworkingSockets_SendMessageToConnection', 'int',
      [ptr, 'uint32', ptr, 'uint32', 'int', ptr]),
    receive: lib.func('SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection', 'int',
      [ptr, 'uint32', ptr, 'int']),
    flush: lib.func('SteamAPI_ISteamNetworkingSockets_FlushMessagesOnConnection', 'int', [ptr, 'uint32']),
    closeConnection: lib.func('SteamAPI_ISteamNetworkingSockets_CloseConnection', 'bool',
      [ptr, 'uint32', 'int', 'str', 'bool']),
    socketsRunCallbacks: lib.func('SteamAPI_ISteamNetworkingSockets_RunCallbacks', 'void', [ptr]),
    configInfo: lib.func('SteamAPI_ISteamNetworkingUtils_GetConfigValueInfo', 'str',
      [ptr, 'int', outI32, outI32]),
    setGlobalInt32: lib.func('SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32', 'bool',
      [ptr, 'int', 'int']),
    releaseMessage: lib.func('SteamAPI_SteamNetworkingMessage_t_Release', 'void', [ptr]),
  };

  // `SteamErrMsg` is `char[1024]`. The init result is an enum, not a bool, and
  // its message is the difference between "Steam is not running" and a version
  // mismatch, so it is carried into the throw rather than discarded.
  const errBuf = Buffer.alloc(1024);
  const initResult = fn.initFlat(errBuf);
  if (initResult !== INIT_OK) {
    const msg = errBuf.toString('latin1').split('\0')[0] || `SteamAPI_InitFlat returned ${initResult}`;
    throw new Error(`Steam is not usable from this process: ${msg} (is the Steam client running and logged in?)`);
  }

  let live = true;
  const sockets = fn.sockets();
  const utils = fn.utils();
  if (!sockets || !utils) {
    fn.shutdown();
    throw new Error('SteamAPI_Init succeeded but an interface accessor returned null');
  }

  /**
   * Ask the library what each config number is actually called. A wrong number
   * would not fail — it would configure a different setting, and the run would
   * look green while measuring something else.
   */
  function verifyConfigNames() {
    const scope = [0], type = [0];
    const wrong = [];
    for (const [name, value] of Object.entries(CONFIG)) {
      const actual = fn.configInfo(utils, value, scope, type);
      if (actual !== name) wrong.push(`${value} is "${actual ?? 'unknown'}", expected "${name}"`);
    }
    if (wrong.length) {
      throw new Error(`ESteamNetworkingConfigValue numbers do not match this SDK: ${wrong.join('; ')}`);
    }
  }
  verifyConfigNames();

  // 32 message pointers: more than a 60 Hz sender can put in flight between two
  // polls of a loop that polls thousands of times a second, and the drain below
  // loops until the library returns nothing anyway, so it is a batch size rather
  // than a cap on what can be received.
  const RECV_BATCH = 32;
  const recvBuf = Buffer.alloc(8 * RECV_BATCH);

  const api = {
    /** What this run bound, for the record. */
    info: {
      dll: path.relative(root, dllPath).replace(/\\/g, '/'),
      bytes: dllBytes.length,
      accessors: accessorNames,
      appId,
      koffi: koffi.version ?? null,
    },

    /** `SetGlobalConfigValueInt32`. Returns false if the library refused it. */
    setGlobalInt32(value, int) {
      return fn.setGlobalInt32(utils, value, int);
    },

    /**
     * Two real, already-connected Steam connections in this process. With
     * `useNetworkLoopback` the packets take 127.0.0.1 and ephemeral ports, which
     * is what restores packetisation, encryption and fake impairment; without it
     * the library short-circuits in memory and measures much less.
     */
    createSocketPair(useNetworkLoopback = true) {
      const a = [0], b = [0];
      if (!fn.createSocketPair(sockets, a, b, useNetworkLoopback, null, null)) {
        throw new Error('CreateSocketPair failed');
      }
      return [a[0], b[0]];
    },

    /** True if the library accepted the message. */
    send(conn, bytes, flags) {
      return fn.send(sockets, conn, bytes, bytes.length, flags, null) === RESULT_OK;
    },

    /**
     * Drain what has arrived, as `{ bytes, size }` per message, oldest first.
     *
     * The payload is copied out of the library's buffer before the message is
     * released, which is both required (the buffer is the library's) and the
     * fair thing to measure: a real transport hands the game bytes it owns, and
     * the WebRTC baseline's `onMessage` receives an already-materialised
     * `ArrayBuffer`.
     *
     * Bounded at `RECV_DRAIN_BATCHES` batches per call, so this can never hold
     * the caller's loop open: whatever is left stays queued for the next pass.
     */
    receive(conn) {
      const out = [];
      for (let batch = 0; batch < RECV_DRAIN_BATCHES; batch++) {
        const n = fn.receive(sockets, conn, recvBuf, RECV_BATCH);
        if (n <= 0) return out;
        for (let i = 0; i < n; i++) {
          const msg = koffi.decode(recvBuf, i * 8, ptr);
          // SteamNetworkingMessage_t: `void *m_pData` at 0, `int m_cbSize` at 8.
          const size = koffi.decode(msg, 8, 'int');
          const data = koffi.decode(msg, 0, ptr);
          out.push(Buffer.from(new Uint8Array(koffi.view(data, size))));
          fn.releaseMessage(msg);
        }
        if (n < RECV_BATCH) return out;
      }
      return out;
    },

    flush(conn) { fn.flush(sockets, conn); },

    /**
     * Service the library. A socket pair is connected on creation so nothing
     * here waits on a callback, but the connection still wants its service call
     * to move packets and time out cleanly.
     */
    pump() {
      fn.socketsRunCallbacks(sockets);
      fn.runCallbacks();
    },

    close(conn) { fn.closeConnection(sockets, conn, 0, null, false); },

    shutdown() {
      if (!live) return;
      live = false;
      fn.shutdown();
    },
  };

  if (verbose) {
    console.log(`[steamnet] ${api.info.dll}`);
    console.log(`[steamnet]   ${accessorNames.sockets} / ${accessorNames.utils}`);
    console.log(`[steamnet]   appid ${appId}, ${BOUND_SYMBOLS.length} symbols bound and `
      + `${TWO_PROCESS_SYMBOLS.length} checked only, config names verified`);
  }

  return api;
}
