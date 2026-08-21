/**
 * The same flat Steam networking surface `tools/steamnet.mjs` provides, but with
 * every hot-path call made **through `steamworks-ffi-node`'s own loader and its
 * own Koffi declarations**, so a throughput run measures the Binding rather than
 * a substitute for it. Issue #52.
 *
 * ## What is the Binding's, and what is not
 *
 * The Binding declares 24 `NetworkingSockets` entry points; the send/receive hot
 * path is entirely among them:
 *
 * | Call | Whose declaration |
 * |---|---|
 * | `SteamAPI_InitSafe` / `Shutdown` / `RunCallbacks` | Binding |
 * | `SteamNetworkingSockets_SteamAPI_v012` (interface accessor) | Binding |
 * | `SendMessageToConnection` | **Binding** |
 * | `ReceiveMessagesOnConnection` | **Binding** |
 * | `FlushMessagesOnConnection` | **Binding** |
 * | `SteamNetworkingMessage_t_Release` | **Binding** |
 * | `ISteamNetworkingSockets_RunCallbacks` | Binding |
 * | `CloseConnection` | Binding |
 * | `CreateSocketPair` | *not declared by the Binding* — see below |
 *
 * `CreateSocketPair` is the one symbol no Binding binds (`docs/STEAM.md` 8.3),
 * and without it no automated test on a one-identity box can open a real Steam
 * connection at all. It is resolved here with `lib.func(...)` on **the library
 * handle the Binding's own loader opened** — the same `koffi.load` result, the
 * same DLL, the same process — so no second FFI layer and no second DLL image
 * exists, and the connection handles the hot path uses are handles the Binding's
 * own interface pointer created.
 *
 * So: **the socket pair's construction is not the Binding's code; every byte
 * sent and received afterwards is.** That is the honest boundary, and any record
 * this module produces carries it in `steam.viaBinding`.
 *
 * ## What this does not offer
 *
 * `SetGlobalConfigValueInt32` is not declared by the Binding, so the fake
 * lag/loss impairment arms are unavailable here and asking for them throws
 * rather than silently running unimpaired. Those arms belong to
 * `tools/steamnet.mjs`, whose job is validating the *library*.
 *
 * Test-only, like `steamnet.mjs`: shipping code uses the Binding's public API,
 * not this.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOADER_REL = 'node_modules/steamworks-ffi-node/dist/internal/SteamLibraryLoader.js';

/** 32 message pointers per drain batch, 64 batches per call — both same as
 * `steamnet.mjs`, so the two arms share the same receive bound. */
const RECV_BATCH = 32;
export const RECV_DRAIN_BATCHES = 64;

export function openSteamNetViaBinding({ appId = 480, verbose = false } = {}) {
  process.env.SteamAppId = String(appId);
  process.env.SteamGameId = String(appId);

  const koffi = require('koffi');
  const ptr = koffi.pointer('void');
  const outU32 = koffi.out(koffi.pointer('uint32'));

  const loaderPath = path.join(root, LOADER_REL);
  const pkgVersion = require(path.join(root, 'node_modules/steamworks-ffi-node/package.json')).version;
  const { SteamLibraryLoader } = require(loaderPath);
  const loader = new SteamLibraryLoader();
  loader.load();
  const lib = loader.getLibrary();
  if (!lib) throw new Error('the Binding\'s loader produced no library handle');

  if (!loader.SteamAPI_Init()) {
    throw new Error('SteamAPI_InitSafe() returned false through the Binding '
      + '(is the Steam client running and logged in?)');
  }

  let live = true;
  const sockets = loader.SteamAPI_SteamNetworkingSockets_SteamAPI_v012();
  if (!sockets) {
    loader.SteamAPI_Shutdown();
    throw new Error('the Binding\'s SteamNetworkingSockets accessor returned null');
  }

  // The single symbol the Binding does not declare, resolved on the Binding's
  // own library handle. See the header: this is construction, not the hot path.
  const createSocketPair = lib.func(
    'SteamAPI_ISteamNetworkingSockets_CreateSocketPair', 'bool',
    [ptr, outU32, outU32, 'bool', ptr, ptr],
  );

  const recvBuf = Buffer.alloc(8 * RECV_BATCH);

  let dllBytes = null;
  try {
    dllBytes = statSync(loader.getSteamLibraryPath?.() ?? '').size;
  } catch { /* the loader may not expose its path; the version pins the surface */ }

  const api = {
    info: {
      via: 'steamworks-ffi-node',
      bindingVersion: pkgVersion,
      runtime: process.versions.electron ? 'electron' : 'node',
      versions: {
        electron: process.versions.electron ?? null,
        node: process.versions.node,
        chrome: process.versions.chrome ?? null,
      },
      accessors: { sockets: 'SteamAPI_SteamNetworkingSockets_SteamAPI_v012' },
      appId,
      koffi: koffi.version ?? null,
      dllBytes,
      viaBinding: {
        send: 'SteamAPI_ISteamNetworkingSockets_SendMessageToConnection',
        receive: 'SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection',
        flush: 'SteamAPI_ISteamNetworkingSockets_FlushMessagesOnConnection',
        release: 'SteamAPI_SteamNetworkingMessage_t_Release',
        pump: ['SteamAPI_ISteamNetworkingSockets_RunCallbacks', 'SteamAPI_RunCallbacks'],
        close: 'SteamAPI_ISteamNetworkingSockets_CloseConnection',
        init: 'SteamAPI_InitSafe',
      },
      notViaBinding: ['SteamAPI_ISteamNetworkingSockets_CreateSocketPair'],
    },

    setGlobalInt32() {
      throw new Error('the Binding does not declare SetGlobalConfigValueInt32; '
        + 'impairment arms belong to tools/steamnet.mjs');
    },

    createSocketPair(useNetworkLoopback = true) {
      const a = [0], b = [0];
      if (!createSocketPair(sockets, a, b, useNetworkLoopback, null, null)) {
        throw new Error('CreateSocketPair failed');
      }
      return [a[0], b[0]];
    },

    /** `EResult k_EResultOK` is 1. */
    send(conn, bytes, flags) {
      return loader.SteamAPI_ISteamNetworkingSockets_SendMessageToConnection(
        sockets, conn, bytes, bytes.length, flags, null,
      ) === 1;
    },

    receive(conn) {
      const out = [];
      for (let batch = 0; batch < RECV_DRAIN_BATCHES; batch++) {
        const n = loader.SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection(
          sockets, conn, recvBuf, RECV_BATCH,
        );
        if (n <= 0) return out;
        for (let i = 0; i < n; i++) {
          const msg = koffi.decode(recvBuf, i * 8, ptr);
          const size = koffi.decode(msg, 8, 'int');
          const data = koffi.decode(msg, 0, ptr);
          // koffi.view() -- what steamnet.mjs uses -- hands back an *external*
          // ArrayBuffer per message. Under Electron, thousands of those a second
          // fatal the process inside N-API ("Error::New napi_get_last_error_info")
          // a few seconds into 60 Hz traffic. koffi.decode into a typed array does
          // the same job -- copy the payload out of the library's buffer before
          // releasing it -- without registering an external buffer per message.
          // Same bytes, same work, one fewer N-API object per message.
          const arr = koffi.decode(data, koffi.array('uint8', size, 'Typed'));
          out.push(Buffer.from(arr.buffer, arr.byteOffset, size));
          loader.SteamAPI_SteamNetworkingMessage_t_Release(msg);
        }
        if (n < RECV_BATCH) return out;
      }
      return out;
    },

    flush(conn) { loader.SteamAPI_ISteamNetworkingSockets_FlushMessagesOnConnection(sockets, conn); },

    pump() {
      loader.SteamAPI_ISteamNetworkingSockets_RunCallbacks(sockets);
      loader.SteamAPI_RunCallbacks();
    },

    close(conn) { loader.SteamAPI_ISteamNetworkingSockets_CloseConnection(sockets, conn, 0, null, false); },

    shutdown() {
      if (!live) return;
      live = false;
      loader.SteamAPI_Shutdown();
    },
  };

  if (verbose) {
    console.log(`[steamnet-binding] steamworks-ffi-node ${pkgVersion} under `
      + `${api.info.runtime}${process.versions.electron ? ` ${process.versions.electron}` : ''}`);
    console.log('[steamnet-binding]   hot path: Send/Receive/Flush/Release are the Binding\'s own declarations');
    console.log('[steamnet-binding]   CreateSocketPair resolved on the Binding\'s library handle (it declares none)');
  }

  return api;
}
