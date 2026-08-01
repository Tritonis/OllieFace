import { NetHost } from './NetHost.js';
import { NetClient } from './NetClient.js';

/**
 * Headless lobby controller.
 *
 * Owns the whole "get two browsers talking" flow and exposes it as plain
 * async methods plus a status callback, so the UI layer (src/ui/Menus.js) can
 * render it however it likes without importing any networking.
 *
 * Two paths, same result:
 *   manual  — no server; copy/paste an invite blob and an answer blob
 *   relay   — a room code via tools/signal-server.mjs
 */
export class Lobby {
  constructor(engine, ctx) {
    this.engine = engine;
    this.ctx = ctx;
    this.mode = 'single';
    this.net = null;
    this.status = 'idle';
    this.onStatus = null;
    this.players = [{ id: 0, name: 'You', local: true }];
    this.pendingInvites = new Map();
  }

  _set(status, detail) {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  // --- host ----------------------------------------------------------------

  /** Start hosting. The engine keeps running exactly as it does single-player. */
  startHost({ maxPlayers = 4 } = {}) {
    if (this.net) throw new Error('Already networked');
    this.mode = 'host';
    this.net = this.engine.add(new NetHost({ maxPlayers }));
    this.ctx.events.on('netPlayerJoined', ({ id }) => {
      this.players.push({ id, name: `Player ${id + 1}`, local: false });
      this._set('peerJoined', { id, count: this.players.length });
    });
    this.ctx.events.on('netPlayerLeft', ({ id }) => {
      this.players = this.players.filter((p) => p.id !== id);
      this._set('peerLeft', { id, count: this.players.length });
    });
    this._set('hosting');
    return this.net;
  }

  /**
   * Manual path: returns the blob to send to a friend, and a function to feed
   * their reply back in. One invite is consumed per joining player.
   */
  async createInvite() {
    if (this.mode !== 'host') this.startHost();
    const invite = await this.net.createInvite();
    this.pendingInvites.set(invite.id, invite);
    this._set('inviteReady', { id: invite.id, blob: invite.blob });
    return invite;
  }

  async acceptAnswer(answerBlob) {
    // The blob names its own invite, so the caller doesn't have to track ids.
    const id = this._inviteIdFor(answerBlob);
    const invite = this.pendingInvites.get(id);
    if (!invite) throw new Error('No pending invite matches that code');
    await invite.accept(answerBlob);
    this.pendingInvites.delete(id);
    this._set('peerConnecting', { id });
  }

  _inviteIdFor(blob) {
    try { return JSON.parse(atob(blob.trim())).id; } catch { throw new Error('That is not a valid answer code'); }
  }

  // --- client --------------------------------------------------------------

  /**
   * Join via an invite blob. Returns the answer blob to hand back to the host.
   * The local sim is dropped to non-authoritative before any snapshot arrives,
   * so the client never briefly simulates its own enemies.
   */
  async joinManual(inviteBlob) {
    if (this.net) throw new Error('Already networked');
    this.mode = 'client';
    const client = new NetClient();
    this.net = this.engine.add(client);
    // Views must be registered before the first snapshot lands, or the entities
    // in it are skipped once and never re-offered.
    this.ctx.coop?.attachClient?.(client);
    this._set('joining');

    const answerBlob = await client.join(inviteBlob);
    this._set('answerReady', { blob: answerBlob });

    this.ctx.events.on('netWelcome', (w) => this._set('connected', w));
    this.ctx.events.on('netDisconnected', () => this._set('disconnected'));
    return answerBlob;
  }

  // --- relay path ----------------------------------------------------------

  /** Host through the WebSocket relay; resolves with the room code. */
  hostViaRelay(url = 'ws://127.0.0.1:8787') {
    this.startHost();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onerror = () => reject(new Error('Could not reach the signalling server'));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'host' }));
      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hosting') {
          this._set('roomOpen', { code: msg.code });
          resolve(msg.code);
        } else if (msg.type === 'joinRequest') {
          const invite = await this.net.createInvite();
          this.pendingInvites.set(invite.id, invite);
          ws.send(JSON.stringify({ type: 'offer', clientId: msg.clientId, blob: invite.blob }));
        } else if (msg.type === 'answer') {
          await this.acceptAnswer(msg.blob).catch(() => {});
        }
      };
    });
  }

  /** Join through the relay with a room code. */
  joinViaRelay(code, url = 'ws://127.0.0.1:8787') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onerror = () => reject(new Error('Could not reach the signalling server'));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code }));
      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') return reject(new Error(msg.error));
        if (msg.type === 'offer') {
          const answer = await this.joinManual(msg.blob);
          ws.send(JSON.stringify({ type: 'answer', blob: answer }));
          resolve();
        }
      };
    });
  }

  leave() {
    this.net?.close?.();
    this.ws?.close?.();
    this.net = null;
    this.mode = 'single';
    this.ctx.authority = true;
    this._set('idle');
  }
}
