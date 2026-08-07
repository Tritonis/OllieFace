/**
 * Minimal WebSocket signalling relay.
 *
 * Exists only to hand an offer to a joiner, an answer back to the host, and ICE
 * candidates either way, so a player can type a 4-letter room code instead of
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

const argPort = process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : null;
const port = Number(argPort ?? process.env.PORT ?? 8787);

// Bumped when a page can tell the difference. 2 = relays `ice` and preserves an
// offer's `trickle` flag; see the header for how each mismatch degrades.
const PROTOCOL_VERSION = 2;

const rooms = new Map(); // code -> { host, clients:Set }

const http = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http });
// `http.address().port` rather than `port`: `--port 0` asks the OS for a free
// one, which is how a test or a local driver runs a relay without colliding
// with whatever is already on 8787 — and the number it got is only knowable
// here.
http.listen(port, () => console.log(`signalling on ws://0.0.0.0:${http.address().port} (health: /healthz)`));

const send = (ws, msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); };

wss.on('connection', (ws) => {
  ws.room = null;
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'host': {
        // Regenerate on collision rather than evicting a live room.
        let code = msg.code?.toUpperCase();
        if (!code || rooms.has(code)) code = newCode();
        rooms.set(code, { host: ws, clients: new Set() });
        ws.room = code; ws.role = 'host';
        send(ws, { type: 'hosting', code, v: PROTOCOL_VERSION });
        break;
      }
      case 'join': {
        const room = rooms.get(msg.code?.toUpperCase());
        if (!room) return send(ws, { type: 'error', error: 'No such room' });
        room.clients.add(ws);
        ws.room = msg.code.toUpperCase(); ws.role = 'client';
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
});

let idSeq = 0;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — misread over voice
function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => ALPHABET[(Math.random() * ALPHABET.length) | 0]).join('');
  } while (rooms.has(c));
  return c;
}
