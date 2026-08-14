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

const rooms = new Map(); // code -> { host, clients:Set, created }

export function start({ port = defaultPort() } = {}) {
  const http = createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health()));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, maxPayload: LIMITS.MAX_PAYLOAD_BYTES });
  // `http.address().port` rather than `port`: `--port 0` asks the OS for a free
  // one, which is how a test or a local driver runs a relay without colliding
  // with whatever is already on 8787 — and the number it got is only knowable
  // here.
  http.listen(port, () => console.log(`signalling on ws://0.0.0.0:${http.address().port} (health: /healthz)`));
  wss.on('connection', onConnection);
  return { http, wss };
}

function defaultPort() {
  const argPort = process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1]
    : null;
  return Number(argPort ?? process.env.PORT ?? 8787);
}

/** What `/healthz` answers. Task 4 widens this. */
function health() { return { ok: true, rooms: rooms.size }; }

const send = (ws, msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };

/**
 * Every ceiling this relay enforces, in one object so a deployment can see the
 * whole policy at once and a test can assert against the same numbers the
 * server uses rather than a copy of them.
 *
 * The sizes are generous on purpose. An SDP offer carrying a dozen candidates
 * is a few kilobytes; 32 KiB is roughly an order of magnitude of headroom, and
 * the 64 KiB frame ceiling above it is what `ws` enforces for us before a byte
 * is ever buffered into this process.
 */
export const LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES: 64 * 1024,
  MAX_BLOB_CHARS: 32 * 1024,
  MAX_CANDIDATE_CHARS: 1024,
  CODE_LEN: 8,
});

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
  ws.rejects = (ws.rejects ?? 0) + 1;
  if (ws.rejects >= MAX_REJECTS) ws.close(1008, 'too many invalid messages');
}

function onConnection(ws) {
  ws.room = null;
  ws.role = null;

  // `ws` reports a protocol violation it has ALREADY answered — an
  // over-maxPayload frame is closed with 1009 and then raised here — and an
  // 'error' with no listener is an unhandled event, which ends this process and
  // every other room in it. One stranger's oversized frame must not be able to
  // close everybody else's session, and there is nothing left to do about the
  // socket itself, so the report is absorbed on purpose.
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return reject(ws, 'bad-json'); }

    const v = validate(parsed);
    if (!v.ok) return reject(ws, v.reason);
    const msg = v.msg;

    switch (msg.type) {
      case 'host': {
        const code = newCode();
        rooms.set(code, { host: ws, clients: new Set(), created: Date.now() });
        ws.room = code; ws.role = 'host';
        send(ws, { type: 'hosting', code, v: PROTOCOL_VERSION });
        break;
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) return send(ws, { type: 'error', error: 'No such room' });
        room.clients.add(ws);
        ws.room = msg.code; ws.role = 'client';
        // Ask the host to mint an invite for this specific joiner.
        send(room.host, { type: 'joinRequest', clientId: (ws.id = ++idSeq) });
        break;
      }
      case 'offer': {
        // Host -> a specific joiner. `trickle` rides along untouched: it is the
        // host telling that joiner "candidates will follow over this relay", and
        // forwarding it is exactly what makes this server a v2 one.
        const room = rooms.get(ws.room);
        const target = [...(room?.clients ?? [])].find((c) => c.id === msg.clientId);
        send(target, { type: 'offer', blob: msg.blob, trickle: !!msg.trickle });
        break;
      }
      case 'answer': {
        // Joiner -> host.
        const room = rooms.get(ws.room);
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
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === 'host') {
      for (const c of room.clients) send(c, { type: 'error', error: 'Host left' });
      rooms.delete(ws.room);
    } else {
      room.clients.delete(ws);
    }
  });
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
