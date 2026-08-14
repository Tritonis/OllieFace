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
 * once and every later plain visit keeps the same configuration — with one
 * exception. `?turnuser=` and `?turnpass=` are credentials: they are read from
 * the URL, never written to storage, and any copy an older build left behind is
 * deleted on load. A tester carrying credentials therefore carries the whole
 * link every time, which is the intended cost.
 */

import { adoptLegacyKey } from '../core/LegacyStorage.js';

const LS_PREFIX = 'telluric.net.';

/** The pre-rename prefix. `store.get` adopts each sub-key on first read. */
const LEGACY_LS_PREFIX = 'petrichor.net.';

const params = (() => {
  try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
})();

const store = {
  get(k) {
    try { return adoptLegacyKey(LS_PREFIX + k, LEGACY_LS_PREFIX + k, localStorage); }
    catch { return null; }
  },
  set(k, v) { try { localStorage.setItem(LS_PREFIX + k, v); } catch { /* private mode */ } },
  // Both names, always. `?turn=` means "stop using TURN", and a clear that left
  // the pre-rename key behind would have the next `get` adopt it and turn the
  // setting straight back on.
  del(k) {
    try {
      localStorage.removeItem(LS_PREFIX + k);
      localStorage.removeItem(LEGACY_LS_PREFIX + k);
    } catch { /* private mode */ }
  },
};

/**
 * The settings that are secrets, and are therefore never written down.
 *
 * A TURN username and credential are bearer secrets for a relay somebody pays
 * for, and `localStorage` is the wrong shape for one in three separate ways: it
 * outlives the session that needed it, it is readable by every other script on
 * the origin, and it survives into screenshots and support dumps taken long
 * afterwards. So a credential is read from the URL of the session that is using
 * it and from nowhere else.
 *
 * One list, rather than a flag passed at each call site: a `persist: false` that
 * a future caller forgets to pass is a credential silently persisted again, and
 * nothing anywhere would fail to say so. Naming the key here is the whole of the
 * opt-out, and the purge below reads the same list.
 */
const NEVER_PERSIST = new Set(['turnuser', 'turnpass']);

// Deleted when this module loads, not when the co-op screen is next opened: a
// player who never opens co-op is precisely the one whose credential — stored
// by a build that did persist it — would otherwise sit there for ever. A value
// left behind is a value that leaks later, so it is removed rather than merely
// ignored. `store.del` clears `LEGACY_LS_PREFIX` too, which is why it is the
// right call here: a credential left under the pre-rename prefix would be
// adopted forward by the next `store.get` and written straight back out under
// the current name.
for (const k of NEVER_PERSIST) store.del(k);

/** Build-time env, guarded: `import.meta.env` is absent outside a Vite build. */
function env(name) {
  try { return import.meta.env?.[name] || ''; } catch { return ''; }
}

/**
 * One setting, resolved and — unless it is a secret — remembered.
 *
 * An explicitly empty query param (`?turn=`) clears the stored value rather
 * than being ignored, so a tester can turn TURN back off without clearing site
 * data by hand.
 *
 * A `NEVER_PERSIST` key is read from the query and from the build-time env, and
 * never from or to storage. The clear at the top is not redundant with the
 * load-time purge: the purge cannot see a write that happens after it, and an
 * older build of the game left open in a second tab is exactly that — it still
 * persists credentials, into the same origin this page reads. Clearing on every
 * read bounds the exposure to the gap between two reads rather than to the next
 * reload.
 */
function setting(queryKey, envKey, fallback = '') {
  const persist = !NEVER_PERSIST.has(queryKey);
  if (!persist) store.del(queryKey);
  if (params.has(queryKey)) {
    const v = params.get(queryKey).trim();
    if (persist) { if (v) store.set(queryKey, v); else store.del(queryKey); }
    return v || env(envKey) || fallback;
  }
  return (persist ? store.get(queryKey) : '') || env(envKey) || fallback;
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
  // Read above the `if`, not inside it: these two are `NEVER_PERSIST` keys, and
  // reading one is also what clears any copy of it in storage. A session with no
  // TURN endpoint configured is exactly the session that would otherwise keep an
  // old credential for ever.
  const username = setting('turnuser', 'VITE_TURN_USERNAME');
  const credential = setting('turnpass', 'VITE_TURN_CREDENTIAL');
  if (turn) {
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
    sim: netSim(),
  };
}

/**
 * Artificial latency and loss, for measuring the game as it is actually played.
 *
 * Every number in seven rounds of co-op review came from two pages on one
 * machine, where RTT is zero and no packet is ever lost. That is not a network;
 * it is the absence of one. This rig makes the same probes runnable against a
 * realistic path without deploying anything.
 *
 *   ?netlag=60          60 ms one-way delay
 *   ?netlag=40-90       uniform jitter between 40 and 90 ms
 *   ?netloss=2          2% loss, unreliable channel only
 *
 * The page carrying the flag is the one whose *inbound* traffic is impaired:
 * flight time is charged on arrival, not held back on send, because a send that
 * waits on this page's frame loop is not a network. `Transport.js`'s
 * `installSim` header has the measurement that settled it.
 *
 * Loss is deliberately never applied to the reliable `events` channel: dropping
 * there would misrepresent a guarantee the transport actually provides, and
 * every conclusion drawn from it would be about a transport we do not ship.
 *
 * That is a property of the whole rig, not just of `?netloss=`. The flight queue
 * both channels share is capped, and its overflow eviction is `state`-only for
 * the same reason (`Transport.js`, `MAX_SIM_QUEUE` / `_simEvict`); a reliable
 * backlog grows past the cap and warns instead. `tests/netlag.test.mjs` holds
 * both halves of the guarantee.
 */
// A bare non-negative number is a flat delay; `lo-hi` is a jitter range,
// both sides non-negative. Anchoring both patterns to digits-only (no `-`
// prefix) is what stops `'-60'.split('-')` from being read as the range
// `['', '60']` — a leading minus sign is never a range separator here.
const NETLAG_FLAT = /^\d+(?:\.\d+)?$/;
const NETLAG_RANGE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

export function netSim() {
  const lag = setting('netlag', 'VITE_NET_LAG');
  const loss = setting('netloss', 'VITE_NET_LOSS');
  if (!lag && !loss) return { on: false, lagMs: 0, jitterMs: 0, lossPct: 0 };
  let lagMs = 0, jitterMs = 0;
  if (lag) {
    if (NETLAG_FLAT.test(lag)) {
      lagMs = Number(lag);
    } else {
      const m = lag.match(NETLAG_RANGE);
      if (m) {
        let a = Number(m[1]), b = Number(m[2]);
        if (b < a) {
          // `?netlag=90-40` is one transposed character away from the
          // documented `?netlag=40-90`. Keeping only `a` (the brief's
          // original behaviour) would silently drop the jitter and measure a
          // materially simpler network than requested, with nothing to show
          // it happened — precisely the "later task reports testing under
          // jitter when it did not" failure this rig exists to prevent.
          // Normalise instead: the requested spread is still simulated, and
          // we say so on the console rather than proceeding quietly.
          [a, b] = [b, a];
          console.warn(`[net] ?netlag=${lag} is a reversed range; using ${a}-${b}`);
        }
        lagMs = a;
        jitterMs = b - a;
      } else {
        // Neither a flat number nor a recognised range (e.g. "abc", "40-",
        // "-60" with nothing after it that parses). Refusing loudly and
        // falling back to no added lag is safer than guessing at intent —
        // a rig that guesses wrong measures a network nobody asked for.
        console.warn(`[net] ?netlag=${lag} is not a recognised value (want "N" or "lo-hi"); ignoring`);
      }
    }
  }
  let lossPct = 0;
  if (loss) {
    const n = Number(loss);
    if (Number.isFinite(n) && n >= 0) lossPct = n;
    else console.warn(`[net] ?netloss=${loss} is not a valid non-negative number; ignoring`);
  }
  return { on: lagMs > 0 || jitterMs > 0 || lossPct > 0, lagMs, jitterMs, lossPct };
}
