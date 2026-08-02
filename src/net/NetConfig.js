/**
 * Where the network points, and who helps it get there.
 *
 * Two things have to be configurable once the game leaves localhost, and both
 * used to be hardcoded:
 *
 *   - the **signalling** URL, which was `ws://127.0.0.1:8787` baked into two
 *     `Lobby` defaults, so a deployed build could only ever talk to a relay
 *     running on the player's own machine;
 *   - the **ICE servers**, which were two public STUN entries and no TURN, so
 *     any pair of players behind symmetric NAT (most corporate, university and
 *     carrier-grade-NAT networks) could never establish a path at all.
 *
 * STUN only tells a peer what its public address looks like. When both ends sit
 * behind a NAT that rewrites the port per destination, neither can predict the
 * other's mapping and the connection simply never forms — no error, just a
 * candidate list that never pairs. TURN is the fallback: a relay in the middle
 * that both peers can reach outbound, at the cost of carrying the traffic. It
 * is the difference between "works for most of my friends" and "works".
 *
 * ## Resolution order
 *
 * Most specific wins, so a build can ship a sane default and still be pointed
 * somewhere else without a rebuild:
 *
 *   1. URL query (`?signal=`, `?turn=`, `?turnuser=`, `?turnpass=`, `?ice=`)
 *   2. `localStorage` (whatever a query param last persisted)
 *   3. build-time env (`VITE_SIGNAL_URL`, `VITE_TURN_URLS`, ...)
 *   4. the localhost default
 *
 * Query params persist to `localStorage` on read, so a tester follows a link
 * once and every later plain visit keeps the same configuration.
 */

const LS_PREFIX = 'petrichor.net.';

const params = (() => {
  try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
})();

const store = {
  get(k) { try { return localStorage.getItem(LS_PREFIX + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(LS_PREFIX + k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(LS_PREFIX + k); } catch { /* private mode */ } },
};

/** Build-time env, guarded: `import.meta.env` is absent outside a Vite build. */
function env(name) {
  try { return import.meta.env?.[name] || ''; } catch { return ''; }
}

/**
 * One setting, resolved and (if it came from the query string) remembered.
 *
 * An explicitly empty query param (`?turn=`) clears the stored value rather
 * than being ignored, so a tester can turn TURN back off without clearing site
 * data by hand.
 */
function setting(queryKey, envKey, fallback = '') {
  if (params.has(queryKey)) {
    const v = params.get(queryKey).trim();
    if (v) store.set(queryKey, v); else store.del(queryKey);
    return v || env(envKey) || fallback;
  }
  return store.get(queryKey) || env(envKey) || fallback;
}

/**
 * The signalling relay.
 *
 * Defaults to localhost, which is right for `npm run dev` and wrong for
 * everything else — a deployed build must be given `VITE_SIGNAL_URL` at build
 * time or `?signal=` at run time. A page served over HTTPS may only open a
 * `wss://` socket; a `ws://` URL from an HTTPS page is blocked as mixed content
 * before it ever reaches the network, which is why `signalUrl()` upgrades the
 * scheme rather than letting it fail silently.
 */
export function signalUrl() {
  let url = setting('signal', 'VITE_SIGNAL_URL', 'ws://127.0.0.1:8787');
  const secure = (() => { try { return location.protocol === 'https:'; } catch { return false; } })();
  if (secure && url.startsWith('ws://')) url = `wss://${url.slice('ws://'.length)}`;
  return url;
}

/** True when the build is still pointing at a localhost relay. */
export function signalIsLocal() {
  const u = signalUrl();
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u);
}

/**
 * The ICE server list handed to every `RTCPeerConnection`.
 *
 * STUN first, TURN last: ICE tries the cheapest viable candidate pair first and
 * only falls back to a relayed one, so listing TURN costs nothing on networks
 * that do not need it.
 *
 * `VITE_TURN_URLS` accepts a comma-separated list, because a TURN deployment is
 * normally offered over UDP, TCP and TLS-on-443 at once, and the last of those
 * is the one that survives a firewall that only permits HTTPS.
 */
export function iceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];

  const turn = setting('turn', 'VITE_TURN_URLS');
  if (turn) {
    const username = setting('turnuser', 'VITE_TURN_USERNAME');
    const credential = setting('turnpass', 'VITE_TURN_CREDENTIAL');
    const urls = turn.split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length) servers.push(username ? { urls, username, credential } : { urls });
  }
  return servers;
}

/**
 * Full RTC configuration.
 *
 * `?ice=relay` sets `iceTransportPolicy: 'relay'`, which forbids direct and
 * server-reflexive candidates and forces every packet through TURN. Nothing in
 * the game needs that, but it is the only way to *prove* a TURN server works:
 * on a normal home network a broken TURN config still connects directly, and
 * the failure only shows up on the one restrictive network you cannot test
 * from. Two players joining with `?ice=relay` are testing TURN and nothing else.
 */
export function rtcConfig() {
  const cfg = { iceServers: iceServers() };
  if (setting('ice', 'VITE_ICE_POLICY') === 'relay') cfg.iceTransportPolicy = 'relay';
  return cfg;
}

/** What the co-op screen shows about the current wiring. */
export function describeNet() {
  const ice = iceServers();
  return {
    signal: signalUrl(),
    signalIsLocal: signalIsLocal(),
    hasTurn: ice.some((s) => String(s.urls).includes('turn:') || String(s.urls).includes('turns:')),
    relayOnly: rtcConfig().iceTransportPolicy === 'relay',
  };
}
