/**
 * Minimal WebSocket signalling relay.
 *
 * Exists only to hand an offer to a joiner and an answer back to the host, so a
 * player can type a 4-letter room code instead of pasting an SDP blob. It sees
 * no game traffic — once the peer connection is up, this process is irrelevant.
 *
 *   node tools/signal-server.mjs --port 8787
 *
 * Deliberately stateless beyond a room map, and rooms are dropped as soon as
 * both sides disconnect.
 */
import { WebSocketServer } from 'ws';

const port = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1]
  : 8787);

const rooms = new Map(); // code -> { host, clients:Set }

const wss = new WebSocketServer({ port });
console.log(`signalling on ws://0.0.0.0:${port}`);

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
        send(ws, { type: 'hosting', code });
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
        // Host -> a specific joiner.
        const room = rooms.get(ws.room);
        const target = [...(room?.clients ?? [])].find((c) => c.id === msg.clientId);
        send(target, { type: 'offer', blob: msg.blob });
        break;
      }
      case 'answer': {
        // Joiner -> host.
        const room = rooms.get(ws.room);
        send(room?.host, { type: 'answer', blob: msg.blob, clientId: ws.id });
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
