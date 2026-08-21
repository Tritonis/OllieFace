/**
 * Which Conversation this session gets.
 *
 * One rule, and it is deliberately the narrowest one that can be true: if the
 * desktop shell has published a Steam networking bridge, the session is a Steam
 * Conversation; otherwise it is the WebRTC one, exactly as today. There is no
 * flag, no query parameter and no fallback *within* a session — a transport is
 * chosen once, when the `NetHost` or `NetClient` is built, and lives as long as
 * it does.
 *
 * The bridge is `window.__STEAM__.net`, and it is the same shape
 * `steamworks-ffi-node` gives the main process as `steam.networkingSockets`:
 * `SteamTransport.js` calls that surface and nothing else, so the bridge is a
 * pass-through rather than a translation.
 *
 * **The bridge does not exist yet.** `desktop/preload.cjs` publishes
 * `window.__STEAM__` for the Introduction (lobby data and member data) and
 * nothing for the Conversation, so on every runtime that exists today —
 * browser, `npm run dev`, and the current Electron shell — `steamSockets()`
 * returns null and every caller here takes the WebRTC branch it already took.
 * That is the whole inertness contract, and it is why this file can be wired
 * into `Lobby` ahead of the bridge: WebRTC remains the default and dev
 * transport, and its deletion is #56, gated elsewhere.
 *
 * Why the guard is "did the shell publish it" rather than "are we on Steam":
 * being logged into Steam does not mean a 60 Hz path to the sockets interface
 * exists in this process, and the honest question a renderer can answer is
 * whether something handed it one.
 */
import { HostTransport, ClientTransport } from './Transport.js';
import { SteamHostTransport, SteamClientTransport } from './SteamTransport.js';

/** The injected sockets surface, or null on every runtime that has none. */
export function steamSockets() {
  const bridge = globalThis.__STEAM__;
  if (!bridge || bridge.available === false) return null;
  return bridge.net ?? null;
}

export function makeHostTransport() {
  const sockets = steamSockets();
  if (!sockets) return new HostTransport();
  const transport = new SteamHostTransport({ sockets });
  // Open the listen socket now rather than at the first invite: Steam's P2P
  // rendezvous wants the host listening before a joiner is told where to look,
  // and a lobby is created before any invite is minted.
  transport.listen();
  return transport;
}

export function makeClientTransport() {
  const sockets = steamSockets();
  return sockets ? new SteamClientTransport({ sockets }) : new ClientTransport();
}
