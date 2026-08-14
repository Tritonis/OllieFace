/**
 * Minimal WebSocket signalling relay.
 *
 * Exists only to hand an offer to a joiner, an answer back to the host, and ICE
 * candidates either way, so a player can type a short room code instead of
 * pasting an SDP blob. It sees no game traffic — once the peer connection is up,
 * this process is irrelevant.
 *
 *   node tools/signal-server.mjs --port 8787
 *
 * Deliberately stateless beyond a room map, and rooms are dropped as soon as
 * both sides disconnect.
 *
 * ## Protocol version
 *
 * `hosting` carries `v`. Version 2 is "this relay forwards `ice` messages and
 * preserves the `trickle` flag on an offer", which is what lets a host skip the
 * non-trickle gathering wait (`Transport.js`, `waitForIce`).
 *
 * The version is advertised rather than required, and the degrade is by
 * omission in both directions:
 *
 *  · a NEW page against an OLD relay sees no `v` on `hosting`, so it never asks
 *    for trickle and never sends an `ice` message the old relay would drop; and
 *    a joiner through an old relay sees no `trickle` on its offer, because an
 *    old relay reconstructs that message from `blob` alone and drops fields it
 *    does not know. Both ends therefore fall back to today's behaviour, which
 *    is the behaviour that works.
 *  · an OLD page against a NEW relay never sets `trickle`, so the flag this
 *    server forwards is `undefined` and the joiner does not trickle either.
 *
 * The page's test is `v >= 2` — a floor, not an equality — so this number can
 * rise for a later feature without stranding a client that only needs ICE.
 *
 * ## Deploying it
 *
 * `PORT` is read from the environment as well as `--port`, because every
 * managed host (Render, Railway, Fly, Heroku, Cloud Run) assigns the port that
 * way and ignores argv. It binds an HTTP server rather than letting `ws` open
 * its own socket, so the same listener answers `GET /healthz` — most platforms
 * will not route traffic to a service whose health check has nothing to answer,
 * and a bare WebSocket server 404s every probe.
 *
 * TLS is intentionally not handled here. A browser page served over HTTPS may
 * only open `wss://`, but every platform above terminates TLS at its own edge
 * and forwards plain HTTP inward — so this stays plain and the URL players use
 * is `wss://`. Running it directly on a bare VM is the one case where a TLS
 * proxy (Caddy, nginx) has to be put in front of it by hand.
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Imported for its policy helpers (tests/signal-hardening.test.mjs) rather than
// run as a process, this file must not seize a port. Everything below the guard
// at the bottom is startup; everything above it is policy and is safe to import.
const RUN_DIRECTLY = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

// Bumped when a page can tell the difference. 2 = relays `ice` and preserves an
// offer's `trickle` flag; see the header for how each mismatch degrades.
const PROTOCOL_VERSION = 2;

const rooms = new Map(); // code -> { host, clients:Set, created, lastActivity }
const connsByIp = new Map(); // ip -> live socket count

/**
 * What has happened since this process started, as counters.
 *
 * Every name here ends in `Total` and every one of them only ever goes up.
 * That is not decoration: `/healthz` reports these beside the *live* figures
 * (`rooms`, `conns`), and the two are different quantities — `rooms` is how
 * many rooms are open at this instant, `roomsTotal` is how many have ever been
 * minted. Whoever reads this at 3am, or graphs it, must not be able to mistake
 * one for the other from the field name alone, so the two families are spelled
 * apart and neither is ever called just `conns` in here.
 *
 * Counts only. Nothing in this object may name a room, an address, or a
 * player — see `health()`.
 */
export const metrics = {
  connsTotal: 0,    // sockets accepted
  roomsTotal: 0,    // rooms minted
  rejectedTotal: 0, // messages refused by validate/rate, after the handshake
  refusedTotal: 0,  // upgrades refused at the handshake, before any message
  expiredTotal: 0,  // rooms swept by the TTL
  errorsTotal: 0,   // socket errors absorbed (a protocol violation ws already answered)
  stalledTotal: 0,  // sockets dropped for not reading what was addressed to them
  startedAt: Date.now(),
};

/**
 * How often the host page says its room is still in use.
 *
 * A copy of `RELAY_KEEPALIVE_MS` in `src/net/Lobby.js`, which the page owns and
 * this file cannot import — `tools/` is not part of the bundle. It is here for
 * one reason: it is the floor under ROOM_TTL_MS, and an operator tuning the TTL
 * has no way to know that from the TTL alone. See the startup `config-warning`.
 */
const PAGE_KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * The key MAX_CONNS_PER_IP is counted against: an IPv4 address as itself, an
 * IPv6 address as the /64 it sits in.
 *
 * A residential IPv6 allocation is a /64 at minimum and routinely a /56 or /48.
 * Every address in it is the subscriber's to use, costs nothing and needs no
 * spoofing — so a cap keyed on the exact address is 2^64 buckets wide for one
 * attacker, which is not a cap, and MAX_ROOMS and MAX_BUFFERED_BYTES are each
 * only as strong as the connection cap underneath them. A /64 is the smallest
 * unit that is reliably one subscriber.
 *
 * The trap is in the other direction and it is the expensive one: an IPv4 peer
 * arriving on a dual-stack listener is `::ffff:203.0.113.9`, and EVERY such
 * address shares the same all-zero /64. Truncating those would put every IPv4
 * player into one twelve-connection bucket — the whole service, not the
 * household — so they are keyed whole, as the IPv4 addresses they are.
 *
 * Anything this does not recognise as an address is keyed whole, which is what
 * the map did before this function existed.
 */
export function ipBucketKey(addr) {
  if (typeof addr !== 'string') return String(addr);
  const bare = addr.split('%')[0]; // a link-local scope id is not part of the address
  if (!bare.includes(':') || bare.includes('.')) return addr; // IPv4, or IPv4-mapped IPv6
  const halves = bare.split('::');
  if (halves.length > 2) return addr; // '::' appears at most once in a legal address
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return addr;
  // Re-spelled from the parsed groups rather than sliced from the text, so every
  // spelling of one prefix — leading zeroes, upper case, an elided run — is one
  // key. Two spellings of one subscriber would be two allowances.
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * The peer address, preferring the proxy's account of it ONLY where the
 * deployment says a proxy it controls is in front.
 *
 * Every platform this deploys to (Fly, Render, Railway, Cloud Run) terminates
 * TLS at its edge and forwards inward, so `socket.remoteAddress` is the edge,
 * not the player — every connection would share one bucket, and the first
 * twelve players would lock everyone else out. The left-most `x-forwarded-for`
 * entry is the original client where a trusted proxy sets it.
 *
 * But `x-forwarded-for` is written by whoever is talking to us. On a relay
 * reachable directly — which is `npm run signal`, every test, and any VM
 * deployment without a proxy — believing it makes MAX_CONNS_PER_IP a
 * formality: a fresh value on every connection buys a fresh allowance, so the
 * cap costs an attacker one header and stops nobody. Hence the default is to
 * disbelieve it, and a deployment behind an edge that rewrites the header
 * opts in with SIGNAL_TRUST_PROXY=1.
 */
function addressOf(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

export function start({ port = defaultPort() } = {}) {
  const http = createServer({
    // Node does not arm a timer per socket for the two timeouts set below: it
    // sweeps the connection list on this interval, so an unfinished request
    // lives for its timeout PLUS up to one interval, and the default interval
    // is 30 s. Setting a 5 s headers timeout and leaving this at its default
    // would have bought about 25 s of the 55 s it looks like it buys — which is
    // the sort of ceiling that passes its own test and does nothing.
    connectionsCheckingInterval: Math.max(250,
      Math.min(LIMITS.HEADERS_TIMEOUT_MS, LIMITS.REQUEST_TIMEOUT_MS)),
  }, (req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // `wss` is declared below but only read when a request arrives, which is
      // after this whole function has run.
      res.end(JSON.stringify(health(wss)));
      return;
    }
    res.writeHead(404).end();
  });

  // The ceilings BELOW the WebSocket handshake.
  //
  // MAX_CONNS_PER_IP is charged in `onConnection` — that is, only once an
  // upgrade has COMPLETED — so until this, nothing counted a raw TCP
  // connection, an HTTP request, or a half-finished upgrade at all. Measured
  // against the per-IP cap set to 2: 200 sockets accepted from one address,
  // each holding an incomplete `GET /healthz` open for Node's default 60 s
  // headers timeout. That is file-descriptor exhaustion for the price of a
  // packet each, and it never reaches the code that would have counted it.
  //
  // Node clears both timeouts when a request completes or upgrades, so a
  // signalling socket that is silent for a whole game — which is every socket
  // here, once the peers are connected — is not subject to either. That is
  // asserted on the wire rather than assumed: if it were untrue, every co-op
  // session in the world would die on this clock. An upgraded socket does still
  // count against `maxConnections` (also asserted), so this ceiling is every
  // socket the process holds, not only the ones still speaking HTTP.
  //
  // GLOBAL rather than per-address, and that is not an oversight. At accept
  // time there is no `x-forwarded-for` to read — the header arrives with the
  // request, one round trip later — so behind the edge proxy this relay is
  // meant to be deployed behind, every player's TCP connection comes from the
  // same place and a per-address accept cap would cap the whole service at N.
  // The cost of a global cap is honest and bounded: one address filling it with
  // raw sockets refuses everyone until it lets go, instead of exhausting the
  // process's file descriptors, and the headers timeout above reaps whatever it
  // is holding within seconds. Per-address remains what it always was — a
  // ceiling on COMPLETED upgrades, where the address is finally knowable.
  http.maxConnections = LIMITS.MAX_SOCKETS;
  http.headersTimeout = LIMITS.HEADERS_TIMEOUT_MS;
  http.requestTimeout = LIMITS.REQUEST_TIMEOUT_MS;

  const wss = new WebSocketServer({
    server: http,
    maxPayload: LIMITS.MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin, req }) => {
      // A client that sends no Origin is not a browser, and only a browser is
      // bound by this header — so refusing an absent one costs the probes and
      // any non-browser client while costing an attacker nothing.
      //
      // Note what this does NOT cover: the desktop shell is Chromium and its
      // page DOES send an Origin (`file://` or `null`), which is in nobody's
      // allowlist. A deployment that sets this variable and also serves desktop
      // players must name that value explicitly — see the operations section in
      // docs/MULTIPLAYER.md, and verify it empirically rather than assuming it.
      if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
        metrics.refusedTotal += 1;
        logSampled('refused', { reason: 'origin', origin });
        return false;
      }
      const ip = addressOf(req);
      // Counted against the /64 for IPv6, the address itself for IPv4 — see
      // `ipBucketKey`. The log field stays the address, because a prefix is not
      // what an operator is looking at when they read this line.
      if ((connsByIp.get(ipBucketKey(ip)) ?? 0) >= LIMITS.MAX_CONNS_PER_IP) {
        metrics.refusedTotal += 1;
        logSampled('refused', { reason: 'conns-per-ip', ip });
        return false;
      }
      return true;
    },
  });
  // `http.address().port` rather than `port`: `--port 0` asks the OS for a free
  // one, which is how a test or a local driver runs a relay without colliding
  // with whatever is already on 8787 — and the number it got is only knowable
  // here.
  http.listen(port, () => {
    // Four spawners parse this exact line for the port with
    // /ws:\/\/0\.0\.0\.0:(\d+)/ — tests/trickle-ice.test.mjs,
    // tools/verify-trickle.mjs, tools/coopprobe.mjs and
    // tests/signal-hardening.test.mjs. It stays, verbatim, and the structured
    // line goes beside it rather than instead of it: dropping it does not fail
    // loudly, it hangs all four of them for their whole timeout.
    console.log(`signalling on ws://0.0.0.0:${http.address().port} (health: /healthz)`);
    log('listening', {
      port: http.address().port,
      // Named rather than counted: the misconfiguration this exists to catch is
      // a typo in an origin, and a count cannot show one. These are the
      // operator's own non-secret settings, echoed back.
      allowedOrigins: ALLOWED_ORIGINS,
      trustProxy: TRUST_PROXY,
    });
    if (!ALLOWED_ORIGINS.length) {
      // Structured rather than a bare sentence, because the deployment where
      // this matters is the one whose logs go to an aggregator that keeps JSON
      // and drops everything else — a warning only a terminal can see is a
      // warning the public deployment never gets.
      log('config-warning', {
        setting: 'SIGNAL_ALLOWED_ORIGINS',
        detail: 'unset — any web origin may open this relay.'
          + ' That is right for a laptop and wrong for a public deployment.',
      });
    }
    // The TTL has a floor, and nothing about the setting says so. The only
    // thing that keeps a LIVE session's room alive is the host page's
    // keepalive; under that beat, a room is reclaimed out from under a game in
    // progress and the friend who arrives at minute 90 is told 'No such room',
    // which is exactly what a typo looks like. That is the whole regression the
    // keepalive was added to close, reintroduced by a number an operator has
    // every reason to think is free to tune. Twice the beat, not once: a room
    // that expires between two beats is expired.
    if (LIMITS.ROOM_TTL_MS < 2 * PAGE_KEEPALIVE_MS) {
      log('config-warning', {
        setting: 'SIGNAL_ROOM_TTL_MS',
        roomTtlMs: LIMITS.ROOM_TTL_MS,
        floorMs: 2 * PAGE_KEEPALIVE_MS,
        detail: 'a live session keeps its room with a keepalive every'
          + ` ${PAGE_KEEPALIVE_MS} ms; under the floor a room expires under a live game.`,
      });
    }
  });
  wss.on('connection', onConnection);

  // One timer for both jobs, because they answer the same question — is anything
  // here still real? A socket that stopped answering holds a room open; a room
  // whose players wandered off holds a code out of circulation. `unref` so the
  // timer never keeps a test's relay process alive past its kill.
  //
  // The period is the smaller of the heartbeat and half the room TTL: a sweep
  // that runs less often than the TTL it enforces would let a room outlive its
  // own expiry by up to a whole period.
  //
  // The TTL is measured from the room's last ACTIVITY, not from its birth.
  // Measured from birth it expired rooms whose host and players were connected
  // and signalling through them — the host was never told, its socket stayed
  // open, and the only symptom was that the next friend to type the code was
  // told 'No such room', which is exactly what a typo looks like. Idle is the
  // thing worth reclaiming; old is not. See `touch`.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActivity > LIMITS.ROOM_TTL_MS) {
        // The host too, not only the clients. The host is the one person who
        // would otherwise sit on a co-op screen believing they are still
        // hosting a room this process has already forgotten.
        for (const c of room.clients) send(c, { type: 'error', error: 'Room expired' });
        send(room.host, { type: 'error', error: 'Room expired' });
        log('room-expired', { code, ageMs: now - room.created, idleMs: now - room.lastActivity });
        metrics.expiredTotal += 1;
        rooms.delete(code);
      }
    }
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, Math.min(LIMITS.HEARTBEAT_MS, Math.max(250, LIMITS.ROOM_TTL_MS / 2)));
  sweep.unref();

  return { http, wss, sweep };
}

function defaultPort() {
  const argPort = process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1]
    : null;
  return Number(argPort ?? process.env.PORT ?? 8787);
}

/**
 * What `/healthz` answers.
 *
 * This endpoint is unauthenticated and cannot be otherwise — a platform health
 * check carries no credential — so everything in it is public. It is therefore
 * counts and flags ONLY: an unsuffixed name is how many there are right now, a
 * `Total` name is how many there have been since startup, and nothing here
 * names a room, an address, a client id, or an origin. A stranger polling it
 * learns that the relay is busy, which is the point of a health check, and
 * nothing whatever about who is connected to what.
 *
 * `wss.clients.size` rather than a sum over `connsByIp`: it is the count `ws`
 * already maintains, so there is no second tally to drift, and it is O(1) on an
 * endpoint anyone on the internet may call as often as they like.
 */
function health(wss) {
  return {
    ok: true,
    // now
    rooms: rooms.size,
    conns: wss.clients.size,
    // since start
    roomsTotal: metrics.roomsTotal,
    connsTotal: metrics.connsTotal,
    rejectedTotal: metrics.rejectedTotal,
    refusedTotal: metrics.refusedTotal,
    expiredTotal: metrics.expiredTotal,
    errorsTotal: metrics.errorsTotal,
    stalledTotal: metrics.stalledTotal,
    uptimeMs: Date.now() - metrics.startedAt,
  };
}

/**
 * Hand a message to a socket — unless that socket has stopped taking them.
 *
 * The rate limiter charges the SENDER, in messages. What it cannot see is that
 * the bytes pile up on the RECIPIENT: a peer that simply stops reading its TCP
 * socket turns this process's heap into that peer's receive buffer, and every
 * declared ceiling is respected the whole way down. Measured out of process at
 * shipped defaults, 12 sockets from one address — exactly MAX_CONNS_PER_IP —
 * grew the relay by 257 MB in 24 s with `rejectedTotal` at 0 and all 12 still
 * open. A 512 MB container dies in well under a minute, unauthenticated, from
 * one laptop.
 *
 * So the ceiling is per-socket and on bytes already owed rather than on bytes
 * about to be sent: `bufferedAmount` is what `ws` has queued and the kernel has
 * not taken. A socket over it is not slow, it is gone.
 */
function send(ws, msg) {
  if (ws?.readyState !== 1) return;
  if (ws.bufferedAmount > LIMITS.MAX_BUFFERED_BYTES) return stalled(ws);
  ws.send(JSON.stringify(msg));
}

/**
 * How long a socket over the buffer ceiling is given before it is destroyed.
 *
 * `close()` alone is not enough here, and the reason is the defect itself: the
 * close frame queues BEHIND the megabyte this peer has not read, so against the
 * exact peer this exists to stop it never leaves the process — `ws` then waits
 * out its own 30 s close timer holding every buffered byte the whole time.
 * The grace is for the peer that is merely slow and drains promptly, and is the
 * only window in which it can learn why it was dropped.
 */
const CLOSE_GRACE_MS = 1000;

function stalled(ws) {
  metrics.stalledTotal += 1;
  // Sampled like every other line a stranger can cause on demand, and carrying
  // a count rather than anything that was in the queue.
  logSampled('stalled', { ip: ws.ip, bufferedBytes: ws.bufferedAmount });
  // Once this returns, `readyState` is CLOSING, so `send` above refuses this
  // socket from here on and nothing more is queued for it.
  ws.close(1008, 'not reading');
  setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref?.();
}

/** One environment override, parsed as a positive number or ignored. */
function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Read out here rather than inline below, because two other ceilings are
// derived from it and a deployment that raises one has to raise those with it.
const MAX_CONNS_PER_IP = envNum('SIGNAL_MAX_CONNS_PER_IP', 12);

/**
 * Every ceiling this relay enforces, in one object so a deployment can see the
 * whole policy at once and a test can assert against the same numbers the
 * server uses rather than a copy of them.
 *
 * The sizes are generous on purpose, and the blob ceiling is now measured
 * rather than argued. A real offer from this game's transport, out of Chromium
 * on this machine: 458 characters trickling, 722 with ICE gathering complete
 * and its candidates inline, at about 132 characters per further candidate. So
 * 32 KiB is around 240 inline candidates. Cutting it to 8 KiB was considered as
 * a second front against the buffering defect and rejected: the memory ceiling
 * is now MAX_BUFFERED_BYTES and does not depend on this number (it changes the
 * single-message overshoot by 24 KiB on a 1 MiB ceiling — 2%), while 58 inline
 * candidates is a real ceiling for a NON-trickle host with several interfaces
 * and a TURN server offering udp/tcp/tls relay candidates on each — which is
 * the deployment this branch is preparing. The failure mode there is
 * `blob-too-big`: a co-op session that never forms, for the same
 * many-interfaces host the rate limiter already had to be widened for.
 *
 * The 64 KiB frame ceiling above it is what `ws` enforces for us before a byte
 * is ever buffered into this process.
 *
 * The abuse ceilings below are overridable from the environment because they
 * are the numbers a deployment has to tune against real traffic, and a relay
 * that needs a code change to raise a limit gets its limit removed instead.
 */
export const LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES: 64 * 1024,
  MAX_BLOB_CHARS: 32 * 1024,
  MAX_CANDIDATE_CHARS: 1024,
  CODE_LEN: 8,
  // What this relay will hold for ONE socket that is not reading. About 30
  // pending offers at the blob ceiling and some 1400 at the size a real offer
  // actually is, against a worst legitimate backlog — a 160-candidate trickle
  // burst at the candidate ceiling — of about 160 KB. Far above anything a
  // handshake owes; far below what a peer can weaponise. See `send`.
  //
  // Read this WITH `MAX_SOCKETS`, because the two multiply: the worst case is
  // no longer unbounded, but it is (sockets x this), and at the defaults that
  // is 768 MiB. That is bounded and survivable on a machine with memory, and
  // still over the head of a 512 MB container — so a small container should
  // lower SIGNAL_MAX_SOCKETS or SIGNAL_MAX_BUFFERED_BYTES rather than read
  // "1 MiB per socket" as the whole story.
  MAX_BUFFERED_BYTES: envNum('SIGNAL_MAX_BUFFERED_BYTES', 1024 * 1024),
  // Every socket the process holds, upgraded or not — see `start`. 64 sockets
  // per allowed connection is enough slack that the WebSocket cap above is
  // always the limit a real player meets, while still being a number a small
  // container can hold file descriptors for.
  MAX_SOCKETS: envNum('SIGNAL_MAX_SOCKETS', MAX_CONNS_PER_IP * 64),
  // How long an unfinished HTTP request may hold a socket. Node's defaults are
  // 60 s and 300 s; nothing legitimate here — a health check, a WebSocket
  // upgrade — takes longer than one round trip.
  HEADERS_TIMEOUT_MS: envNum('SIGNAL_HEADERS_TIMEOUT_MS', 5000),
  REQUEST_TIMEOUT_MS: envNum('SIGNAL_REQUEST_TIMEOUT_MS', 10_000),
  // Sized for a co-op game, not a public chat service. Four players is the
  // designed party; the slack above it absorbs a joiner whose socket has not
  // been swept yet, so a legitimate rejoin is never the one that is refused.
  MAX_CLIENTS_PER_ROOM: envNum('SIGNAL_MAX_CLIENTS_PER_ROOM', 8),
  MAX_ROOMS: envNum('SIGNAL_MAX_ROOMS', 500),
  // Counted per /64 for IPv6, per address for IPv4 — see `ipBucketKey`.
  MAX_CONNS_PER_IP,
  // Trickle ICE is bursty by nature — a host gathering against several
  // interfaces emits a dozen candidates in a few milliseconds — so the burst is
  // deliberately much larger than the sustained rate.
  MAX_MSGS_PER_SEC: envNum('SIGNAL_MAX_MSGS_PER_SEC', 40),
  MSG_BURST: envNum('SIGNAL_MSG_BURST', 120),
  // What happens to a socket that keeps sending past the bucket. Its own
  // allowance, deliberately far larger than MAX_REJECTS and — unlike
  // MAX_REJECTS — it forgives: an overshoot is spent and earned back, so a
  // finite burst is throttled and a genuine flood still runs out. See
  // `overRate`.
  MAX_RATE_DROPS: envNum('SIGNAL_MAX_RATE_DROPS', 600),
  RATE_DROPS_FORGIVEN_PER_SEC: envNum('SIGNAL_RATE_DROPS_FORGIVEN_PER_SEC', 20),
  ROOM_TTL_MS: envNum('SIGNAL_ROOM_TTL_MS', 30 * 60 * 1000),
  HEARTBEAT_MS: envNum('SIGNAL_HEARTBEAT_MS', 30 * 1000),
});

/**
 * The origins a browser may open this relay from, or empty for "any".
 *
 * Empty is the default because the relay is also run on a laptop by `npm run
 * signal`, where there is no origin worth naming and a refusal would only ever
 * be self-inflicted. A public deployment is expected to set the variable.
 */
const ALLOWED_ORIGINS = (process.env.SIGNAL_ALLOWED_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Whether `x-forwarded-for` is believed. Off unless a deployment says a proxy
 * it controls rewrites the header — see `addressOf` for why the default is
 * disbelief.
 */
const TRUST_PROXY = /^(1|true|yes|on)$/i.test((process.env.SIGNAL_TRUST_PROXY ?? '').trim());

/**
 * The fields a log line must never carry, whatever a caller passes.
 *
 * A room code is a bearer token for the life of the room — anyone holding it
 * can walk into it — so it belongs in a log no more than a password does. That
 * it is also read aloud is not a counter-argument: saying it discloses it to
 * the people in the room for half an hour, while logging it discloses it to
 * whoever reads the logs, for ever.
 *
 * The contract is deliberately flat and by field NAME: `{ code }` is redacted,
 * `{ roomCode }` and `{ room: { code } }` are not. If you add a call site,
 * name your fields from this list or add to it.
 */
const SECRET_FIELDS = new Set(['code', 'blob', 'candidate', 'credential', 'password', 'username']);

/**
 * How much of a string field survives into a log line.
 *
 * Several of the fields logged here arrive from the other end of a socket — an
 * `Origin` header, an `x-forwarded-for` value where a proxy is trusted — and a
 * header may be kilobytes long. Without a ceiling the sender chooses the size
 * of every line the relay writes, which is a write amplification bought with
 * one TCP connection. 128 characters is far more than any real origin or
 * address and far less than a header.
 */
const MAX_LOG_FIELD_CHARS = 128;

export function log(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_FIELDS.has(k)) { safe[k] = `[${k}]`; continue; }
    safe[k] = typeof v === 'string' && v.length > MAX_LOG_FIELD_CHARS
      ? `${v.slice(0, MAX_LOG_FIELD_CHARS)}…`
      : v;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
}

/**
 * A log line for something a stranger can cause on demand.
 *
 * A refused handshake and an absorbed socket error are both events an attacker
 * triggers at whatever rate it likes, and one line each means one attacker
 * decides how much this relay writes to disk — the log bill, and eventually the
 * disk, are the denial of service. So these events are SAMPLED: a few lines per
 * window, then a running tally that rides out on the next line that is written.
 *
 * Nothing is lost by it. The counter behind each sampled event (`refusedTotal`,
 * `errorsTotal`) is incremented on every occurrence regardless and reported by
 * `/healthz`, so the *volume* is always exact; what is sampled is the detail —
 * which address, which origin — and one line of that is as good as a thousand
 * identical ones. The
 * budget is global rather than per-address on purpose: a map keyed by something
 * the sender chooses is itself unbounded memory, which is the same bug wearing
 * a different hat.
 */
const LOG_SAMPLE_WINDOW_MS = 10_000;
const LOG_SAMPLE_PER_WINDOW = 5;
let sampleWindowAt = 0;
let sampledInWindow = 0;
let sampleSuppressed = 0;

function logSampled(event, fields = {}) {
  const now = Date.now();
  if (now - sampleWindowAt >= LOG_SAMPLE_WINDOW_MS) {
    sampleWindowAt = now;
    sampledInWindow = 0;
  }
  if (sampledInWindow >= LOG_SAMPLE_PER_WINDOW) { sampleSuppressed += 1; return; }
  sampledInWindow += 1;
  // `suppressedSince` is how many sampled lines — of any event — were dropped
  // between the last one written and this one, so a reader can tell a quiet
  // relay from a loud one that is being sampled.
  const line = sampleSuppressed ? { ...fields, suppressedSince: sampleSuppressed } : fields;
  sampleSuppressed = 0;
  log(event, line);
}

/**
 * A message allowance that refills on the clock.
 *
 * Counting messages per fixed window would let a sender spend a whole window's
 * worth on each side of the boundary and get double the rate it was granted;
 * a bucket has no boundary to sit astride. `now` is passed in rather than read
 * so the test drives the clock instead of sleeping through it.
 */
export class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec; this.burst = burst;
    this.tokens = burst; this.last = null;
  }

  take(now) {
    if (this.last === null) this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — misread over voice
const CODE_RE = new RegExp(`^[${ALPHABET}]{${LIMITS.CODE_LEN}}$`);

/**
 * Anything a human might have typed, reduced to the one spelling the room map
 * is keyed by. Total by construction: a non-string, a null, or a line of
 * punctuation all come back as the empty string, which no room is ever keyed
 * by, so a bad code fails the lookup instead of finding something.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const up = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(up) ? up : '';
}

/** The size of a value as it would sit on the wire, without re-serialising it twice. */
function jsonSize(v) {
  if (typeof v === 'string') return v.length;
  try { return JSON.stringify(v)?.length ?? 0; } catch { return Infinity; }
}

/**
 * The whole message schema, in one place.
 *
 * The relay stays dumb about *content* — it never looks inside an SDP or a
 * candidate — but it is no longer dumb about *shape*. A message that is not one
 * of the six known types, or whose fields are the wrong kind or too large, is
 * refused with a stable slug the caller logs and counts. Refusing before the
 * switch is what keeps every later handler able to assume its fields exist.
 */
export function validate(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, reason: 'not-object' };
  const bad = (reason) => ({ ok: false, reason });

  switch (msg.type) {
    case 'host':
      // Any `code` a client offers is dropped on the floor here rather than
      // honoured: letting a joiner name the room it is about to host is how an
      // attacker squats on a code a friend is still typing.
      return { ok: true, msg: { type: 'host' } };

    case 'keepalive':
      // A host saying its room is still in use, and nothing else — it carries no
      // fields, so there is nothing here to size-check and nothing to leak. It
      // costs a token from the sender's bucket like every other message, which is
      // the only limit it needs.
      return { ok: true, msg: { type: 'keepalive' } };

    case 'join': {
      const code = normalizeCode(msg.code);
      return code ? { ok: true, msg: { type: 'join', code } } : bad('bad-code');
    }

    case 'offer': {
      if (!Number.isInteger(msg.clientId)) return bad('bad-client-id');
      if (typeof msg.blob !== 'string') return bad('bad-blob');
      if (msg.blob.length > LIMITS.MAX_BLOB_CHARS) return bad('blob-too-big');
      return { ok: true, msg: { type: 'offer', clientId: msg.clientId, blob: msg.blob, trickle: !!msg.trickle } };
    }

    case 'answer': {
      if (typeof msg.blob !== 'string') return bad('bad-blob');
      if (msg.blob.length > LIMITS.MAX_BLOB_CHARS) return bad('blob-too-big');
      return { ok: true, msg: { type: 'answer', blob: msg.blob } };
    }

    case 'ice': {
      if (msg.clientId !== undefined && !Number.isInteger(msg.clientId)) return bad('bad-client-id');
      if (!msg.candidate || typeof msg.candidate !== 'object') return bad('bad-candidate');
      if (jsonSize(msg.candidate) > LIMITS.MAX_CANDIDATE_CHARS) return bad('candidate-too-big');
      return { ok: true, msg: { type: 'ice', clientId: msg.clientId, candidate: msg.candidate } };
    }

    default:
      return bad('bad-type');
  }
}

/**
 * A refused message, counted.
 *
 * One malformed frame is a version skew or a fat-fingered `wscat`, and is not
 * worth a disconnect. A stream of them is someone probing, and the cheapest
 * answer is to stop reading. 1008 is "policy violation", which is exactly what
 * this is.
 */
const MAX_REJECTS = 20;
function reject(ws, reason) {
  metrics.rejectedTotal += 1;
  ws.rejects = (ws.rejects ?? 0) + 1;
  if (ws.rejects >= MAX_REJECTS) ws.close(1008, 'too many invalid messages');
}

/**
 * A message that arrived too fast, dropped.
 *
 * Deliberately NOT `reject`. A well-formed frame arriving over the bucket is
 * back-pressure, not garbage: the sender is a real player whose machine gathered
 * more candidates than this relay wants in one second, and it is already dropped
 * on the wire. Spending the same twenty-strong, never-decaying budget that
 * exists for malicious input meant a single trickle burst that overshot the
 * 120-token bucket by twenty messages — measured: 140 candidates closes, 130
 * does not — disconnected that player mid-handshake with 1008. A host with a
 * VPN adapter, a Hyper-V switch and two real NICs reaches that in one gather.
 *
 * The socket still cannot flood for ever, because a flood is not a burst: the
 * drops are counted against their own allowance, which is an order of magnitude
 * larger than MAX_REJECTS and, unlike MAX_REJECTS, refills. A finite overshoot
 * costs a few tokens and is forgiven; a sender that holds the throttle down
 * spends the whole allowance faster than it earns it back and loses the socket.
 * Either way `rejectedTotal` counts every dropped message, so /healthz sees the
 * throttling whether or not it ends in a close.
 */
function overRate(ws, now) {
  metrics.rejectedTotal += 1;
  if (!ws.dropBudget.take(now)) ws.close(1008, 'sustained flood');
}

/**
 * A room is still in use, as of now.
 *
 * Called for every message the relay routes through a room — a join, an offer,
 * an answer, a candidate — and for the one message that exists only to say this,
 * `keepalive`, because once every peer is connected a live session routes nothing
 * at all and would otherwise be indistinguishable from an abandoned room.
 *
 * A transport heartbeat is pointedly NOT one of them: `ws` answers a protocol
 * ping without this file seeing anything, so liveness alone can never renew a
 * room, and a code whose players have gone is still reclaimed on schedule. That
 * is the line — a socket being open is not a session; a page saying so is.
 */
function touch(room) {
  if (room) room.lastActivity = Date.now();
}

function onConnection(ws, req) {
  ws.room = null;
  ws.role = null;
  ws.ip = addressOf(req);
  // Two fields on purpose: `ip` is who this is, for a log line; `ipKey` is what
  // the connection cap is counted against, which for IPv6 is the whole /64.
  ws.ipKey = ipBucketKey(ws.ip);
  ws.bucket = new TokenBucket(LIMITS.MAX_MSGS_PER_SEC, LIMITS.MSG_BURST);
  // The allowance for messages this socket sends past `bucket` — see `overRate`.
  // A second bucket rather than a counter, because forgiveness is the whole
  // point and a bucket already knows how to refill on the clock.
  ws.dropBudget = new TokenBucket(LIMITS.RATE_DROPS_FORGIVEN_PER_SEC, LIMITS.MAX_RATE_DROPS);
  ws.alive = true;
  connsByIp.set(ws.ipKey, (connsByIp.get(ws.ipKey) ?? 0) + 1);
  metrics.connsTotal += 1;
  ws.on('pong', () => { ws.alive = true; });

  // `ws` reports a protocol violation it has ALREADY answered — an
  // over-maxPayload frame is closed with 1009 and then raised here — and an
  // 'error' with no listener is an unhandled event, which ends this process and
  // every other room in it. One stranger's oversized frame must not be able to
  // close everybody else's session, and there is nothing left to do about the
  // socket itself, so the report is absorbed on purpose.
  //
  // Absorbed, but not silent: repeated max-payload violations from one address
  // across many sockets are exactly the pattern an operator needs to see, and a
  // handler that swallowed them without a word made that invisible. The error
  // OBJECT is deliberately not logged — its message can quote the frame that
  // caused it, which is the blob this relay is not allowed to write down.
  //
  // Sampled, for the same reason the refusals are: an oversized frame is one
  // line, and a stranger can send oversized frames as fast as it can open
  // sockets.
  ws.on('error', () => {
    metrics.errorsTotal += 1;
    logSampled('socket-error', { ip: ws.ip });
  });

  ws.on('message', (raw) => {
    // Before the parse, because parsing is itself work a flood is trying to buy.
    const now = Date.now();
    if (!ws.bucket.take(now)) return overRate(ws, now);

    let parsed;
    try { parsed = JSON.parse(raw); } catch { return reject(ws, 'bad-json'); }

    const v = validate(parsed);
    if (!v.ok) return reject(ws, v.reason);
    const msg = v.msg;

    switch (msg.type) {
      case 'host': {
        // A socket holds at most one room. Without this, `host` sent twice
        // mints a second code and orphans the first: nothing points at the old
        // room any more, but it is still in the map and still counted, and only
        // the TTL sweep releases it half an hour later. With MAX_ROOMS in force
        // that turns a loop of `host` frames from a slow memory leak into a
        // denial of service — one socket spends the relay's whole room budget
        // inside a single burst allowance and every real host is then told
        // 'Relay is full' until the rooms age out.
        leaveCurrentRoom(ws);
        if (rooms.size >= LIMITS.MAX_ROOMS) return send(ws, { type: 'error', error: 'Relay is full' });
        const code = newCode();
        rooms.set(code, { host: ws, clients: new Set(), created: now, lastActivity: now });
        metrics.roomsTotal += 1;
        ws.room = code; ws.role = 'host';
        send(ws, { type: 'hosting', code, v: PROTOCOL_VERSION });
        break;
      }
      case 'keepalive': {
        // The one message whose entire purpose is `touch`. Everything else this
        // relay routes is a handshake, and a handshake stops the moment the peers
        // are connected — so without this, a room full of players who all joined
        // in the first five minutes looks exactly like an abandoned one, and the
        // TTL reclaims a code the session is still handing out. No reply: there
        // is nothing to say, and a room the sender is not in is nobody's error.
        //
        // This beat is therefore the floor under ROOM_TTL_MS, and the coupling
        // runs the other way too: the page beats every PAGE_KEEPALIVE_MS, so a
        // TTL below twice that expires live rooms no matter how busy they are.
        // The startup `config-warning` in `start` says so out loud, because
        // nothing about the TTL setting hints that this message exists.
        touch(rooms.get(ws.room));
        break;
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) return send(ws, { type: 'error', error: 'No such room' });
        // A socket already in this room is exempt from the capacity check: it
        // occupies one of the seats being counted, so admitting it again changes
        // no membership at all, and refusing it told the sitting member the room
        // it is in is 'Room is full'. The check stays BEFORE `leaveCurrentRoom`
        // for everyone else on purpose — a join that is going to fail must not
        // first cost the socket the room it already has.
        if (room.clients.size >= LIMITS.MAX_CLIENTS_PER_ROOM && !room.clients.has(ws)) {
          return send(ws, { type: 'error', error: 'Room is full' });
        }
        // Same one-room rule as `host`: a socket that joins a second room must
        // not stay listed in the first, or the room it left keeps a dead
        // reference until its own host disconnects.
        leaveCurrentRoom(ws);
        room.clients.add(ws);
        touch(room);
        ws.room = msg.code; ws.role = 'client';
        // Ask the host to mint an invite for this specific joiner.
        send(room.host, { type: 'joinRequest', clientId: (ws.id = ++idSeq) });
        break;
      }
      case 'offer': {
        // Host -> a specific joiner. `trickle` rides along untouched: it is the
        // host telling that joiner "candidates will follow over this relay", and
        // forwarding it is exactly what makes this server a v2 one.
        //
        // Only the host, and the check is not a formality: a joiner's
        // `joinViaRelay` treats EVERY offer it receives as the host's, so an
        // offer forwarded from one joiner to another is not a stray message —
        // it is that joiner's WebRTC connection, captured by whoever else holds
        // the room code. `ice` has always been keyed on the role; these two were
        // not, and the room code is a bearer token every invited friend holds.
        if (ws.role !== 'host') return reject(ws, 'wrong-role');
        const room = rooms.get(ws.room);
        touch(room);
        const target = [...(room?.clients ?? [])].find((c) => c.id === msg.clientId);
        send(target, { type: 'offer', blob: msg.blob, trickle: !!msg.trickle });
        break;
      }
      case 'answer': {
        // Joiner -> host, and only a joiner: the mirror of the check above, and
        // the reason a socket that has left a room must not still be wearing its
        // role — see `leaveCurrentRoom`.
        if (ws.role !== 'client') return reject(ws, 'wrong-role');
        const room = rooms.get(ws.room);
        touch(room);
        send(room?.host, { type: 'answer', blob: msg.blob, clientId: ws.id });
        break;
      }
      case 'ice': {
        // One ICE candidate, in whichever direction the sender is not. Addressed
        // exactly like offer/answer — the host names a joiner, a joiner is
        // stamped with its own id — and just as dumb: the candidate is an opaque
        // object this server never looks inside. A candidate for a joiner who
        // has gone (or was never here) finds no target and is dropped, which is
        // the normal end of a join, not an error worth a reply.
        const room = rooms.get(ws.room);
        if (!room) break;
        touch(room);
        if (ws.role === 'host') {
          const target = [...room.clients].find((c) => c.id === msg.clientId);
          send(target, { type: 'ice', candidate: msg.candidate });
        } else {
          send(room.host, { type: 'ice', candidate: msg.candidate, clientId: ws.id });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    connsByIp.set(ws.ipKey, (connsByIp.get(ws.ipKey) ?? 1) - 1);
    if (connsByIp.get(ws.ipKey) <= 0) connsByIp.delete(ws.ipKey);
    leaveCurrentRoom(ws);
  });
}

/**
 * Detach a socket from whatever room it is currently in.
 *
 * The same three lines whether the socket is closing, hosting again, or
 * joining somewhere else — and one place to be right, because every one of
 * those paths used to be able to leave a room in the map with nobody in it or
 * a departed socket still listed as a member.
 *
 * Detaching means BOTH directions. The room stops pointing at the socket, and
 * the socket stops pointing at the room — because a caller that leaves and is
 * then refused what it left for (`host` runs this BEFORE the MAX_ROOMS check)
 * would otherwise still be holding the code and the role of a room it is no
 * longer a member of, and `answer` and `keepalive` are routed from exactly
 * those two fields. Every handler that re-establishes a membership sets them
 * again immediately after calling this.
 */
function leaveCurrentRoom(ws) {
  const room = rooms.get(ws.room);
  if (room) {
    if (ws.role === 'host') {
      for (const c of room.clients) send(c, { type: 'error', error: 'Host left' });
      rooms.delete(ws.room);
    } else {
      room.clients.delete(ws);
    }
  }
  ws.room = null;
  ws.role = null;
}

let idSeq = 0;

/**
 * A room code no one can predict.
 *
 * `Math.random` is seeded per process and its output is recoverable from a
 * handful of samples, which for a relay that hands rooms out on request means a
 * caller can compute the next code a stranger is about to be given. `randomInt`
 * is the CSPRNG, and its bounded form is rejection-sampled, so the alphabet
 * stays uniform even though 32 does not divide the generator's range evenly.
 */
export function newCode() {
  let c;
  do {
    c = Array.from({ length: LIMITS.CODE_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  } while (rooms.has(c));
  return c;
}

if (RUN_DIRECTLY) start();
