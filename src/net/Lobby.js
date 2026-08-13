import { NetHost } from './NetHost.js';
import { NetClient } from './NetClient.js';
import { signalUrl, signalIsLocal } from './NetConfig.js';

/**
 * A WebSocket failure gives no reason — the event carries nothing, by design,
 * so a page cannot probe the network. The two causes that actually happen are
 * worth naming, because both look identical from here and neither is obvious.
 */
function relayError(url) {
  if (signalIsLocal()) {
    return 'Could not reach the signalling server. This build is still pointed at '
      + `${url} — that only works if the relay is running on this machine. `
      + 'Build with VITE_SIGNAL_URL set, or add ?signal=wss://your-relay to the URL.';
  }
  let secureMismatch = false;
  try { secureMismatch = location.protocol === 'https:' && url.startsWith('ws://'); } catch { /* non-browser */ }
  if (secureMismatch) {
    return `Could not reach ${url}. An https page cannot open an insecure ws:// socket; the relay needs to be wss://.`;
  }
  return `Could not reach the signalling server at ${url}. Check it is running and reachable.`;
}

/**
 * The `hosting.v` at which a relay forwards `ice` messages and preserves an
 * offer's `trickle` flag — i.e. the version at and above which this page may
 * skip the non-trickle gathering wait on the room-code path.
 *
 * A floor rather than an equality, deliberately: the relay is the authority on
 * its own version (`tools/signal-server.mjs`) and can raise it for some later
 * feature, and a page that only needs ICE relaying must not stop trickling when
 * it does. An absent `v` is an older relay, which fails the comparison and gets
 * the non-trickle join it can actually carry.
 */
const RELAY_TRICKLE_VERSION = 2;

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
    // The relay addresses joiners by `clientId` and the transport addresses
    // invites by its own id, so trickled candidates need the map between them.
    this._invitesByClient = new Map();
    // Candidates that reached this page before there was a transport to hand
    // them to. See `joinViaRelay`.
    this._earlyIce = [];
    // Peers this host turned away, so their departure does not overwrite the
    // reason with a generic one. Cleared as each leave arrives.
    this._refusedPeers = new Set();
    this._refused = false;
  }

  _set(status, detail) {
    this.status = status;
    // Kept so the screen can be *re*-rendered later with the same words it
    // would have shown at the time. `Menus.openCoop` renders from `status`, and
    // a refusal's whole content is in the detail.
    this.statusDetail = detail;
    this.onStatus?.(status, detail);
  }

  // --- host ----------------------------------------------------------------

  /** Start hosting. The engine keeps running exactly as it does single-player. */
  startHost({ maxPlayers = 4 } = {}) {
    if (this.net) throw new Error('Already networked');
    this.mode = 'host';
    this.net = this.engine.add(new NetHost({ maxPlayers }));
    this._bindHost();
    this._set('hosting');
    return this.net;
  }

  /**
   * Subscribe once per Lobby, not once per session.
   *
   * `startHost` and `joinManual` can both be called again after `leave()`, and
   * `EventBus.on` has no idea it has seen these closures before — so a second
   * host session pushed every joiner into `players` twice and set the status
   * twice, and a second join accumulated a second `netDisconnected` handler on
   * the same bus. Nothing here needs per-session state: the handlers read
   * `this`, and the events they listen for are only raised by the role that
   * raises them.
   */
  _bindHost() {
    if (this._hostBound) return;
    this._hostBound = true;
    this.ctx.events.on('netPlayerJoined', ({ id }) => {
      this.players.push({ id, name: `Player ${id + 1}`, local: false });
      this._set('peerJoined', { id, count: this.players.length });
    });
    this.ctx.events.on('netPlayerLeft', ({ id }) => {
      this.players = this.players.filter((p) => p.id !== id);
      // A refused peer leaves too, and "a player left" is a worse answer than
      // the reason we just refused them for. `_refuse` fires first and the close
      // is deferred a turn, so this arrives second and must not overwrite it.
      if (this._refusedPeers.has(id)) { this._refusedPeers.delete(id); return; }
      this._set('peerLeft', { id, count: this.players.length });
    });
    this.ctx.events.on('netPeerRefused', ({ id, reason, detail }) => {
      this._refusedPeers.add(id);
      this._set('peerRefused', { id, reason, detail });
    });
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
    // Set the placeholder *before* the await. `invite.accept` resolves the
    // transport's `ready` promise, which fires `onPeer` -> `netPlayerJoined` ->
    // the status a successful join deserves. Setting 'peerConnecting'
    // afterwards overwrote that, so a host that had just accepted a player sat
    // reading "Reply accepted — connecting…" forever.
    this._set('peerConnecting', { id });
    try {
      await invite.accept(answerBlob);
    } catch (err) {
      // `accept` now rejects on its connect deadline instead of awaiting a
      // promise that can never settle, so this is reachable — and the panel
      // has to stop saying "connecting…" when it is not.
      this._set('peerFailed', { id, detail: err?.message });
      throw err;
    } finally {
      // In the `finally` and not after the await: an invite whose connection
      // failed is spent either way — its RTCPeerConnection has a remote
      // description and is closed — so keeping it would only let the host
      // paste the same dead answer again. A mistyped code never reaches here;
      // it throws out of `_inviteIdFor` above, with the invite intact.
      this.pendingInvites.delete(id);
    }
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
  async joinManual(inviteBlob, { trickle = false, onIceCandidate = null } = {}) {
    if (this.net) throw new Error('Already networked');
    this.mode = 'client';
    const client = new NetClient();
    this.net = this.engine.add(client);
    // Both are set before `client.join` and both have to be: `trickle` decides
    // whether that call waits for gathering at all, and gathering starts inside
    // it — a sink registered afterwards would be registered after the first
    // candidates had already been produced. (`TrickleIce` holds them either way;
    // this just means it does not have to.) The manual path passes neither, so
    // it reaches the same `join(blob)` it always did.
    client.transport.trickle = trickle;
    if (onIceCandidate) client.transport.onIceCandidate(onIceCandidate);
    // Views must be registered before the first snapshot lands, or the entities
    // in it are skipped once and never re-offered.
    this.ctx.coop?.attachClient?.(client);
    this._set('joining');

    let answerBlob;
    try {
      answerBlob = await client.join(inviteBlob);
    } catch (err) {
      // The system was registered before the await, so a join that never lands
      // leaves a dead `NetClient` ticking and owning `ctx.net` — and the retry
      // the caller is most likely to make next dies on 'Already networked'.
      this._release();
      this.mode = 'single';
      // `NetClient.init` already dropped this machine to non-authoritative, and
      // C-2's reasons for restoring both fields on `leave()` apply verbatim to a
      // session that failed before it began.
      this.ctx.authority = true;
      this.ctx.netRole = 'single';
      throw err;
    }
    this._set('answerReady', { blob: answerBlob });
    this._bindClient();
    return answerBlob;
  }

  /** The client half of `_bindHost`, once per Lobby. */
  _bindClient() {
    if (this._clientBound) return;
    this._clientBound = true;
    this.ctx.events.on('netWelcome', (w) => this._set('connected', w));
    this.ctx.events.on('netRefused', ({ reason, detail }) => {
      this._refused = true;
      this._set('refused', { reason, detail });
    });
    // A refusal closes the channel, so the bare disconnect follows it by one
    // turn. The reason is the more useful of the two and it goes second, so it
    // has to win.
    this.ctx.events.on('netDisconnected', () => { if (!this._refused) this._set('disconnected'); });
  }

  // --- relay path ----------------------------------------------------------

  /**
   * Host through the WebSocket relay; resolves with the room code.
   *
   * The URL defaults to whatever the build was configured with rather than to
   * localhost — see `NetConfig.js`. A deployed build pointed at nobody is the
   * failure this signature used to guarantee.
   *
   * This is the path that can trickle ICE. The manual path cannot — a blob a
   * human pastes has to be complete — but here a live socket is already carrying
   * the offer and the answer, so it can carry candidates too, and both sides
   * stop paying `waitForIce`'s cap. Whether it does is decided by the relay's
   * own advertised version, not assumed: see `RELAY_TRICKLE_VERSION`.
   */
  hostViaRelay(url = signalUrl()) {
    this.startHost();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onerror = () => reject(new Error(relayError(url)));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'host' }));
      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'hosting') {
          // A relay too old to say what it is cannot carry a candidate, so the
          // invites this session mints keep waiting for gathering — today's
          // behaviour, which works. `hosting` always precedes `joinRequest`, so
          // the decision is made before the first invite exists.
          this.net.transport.trickle = Number(msg.v) >= RELAY_TRICKLE_VERSION;
          this._set('roomOpen', { code: msg.code });
          resolve(msg.code);
        } else if (msg.type === 'joinRequest') {
          const trickle = this.net.transport.trickle === true;
          const invite = await this.net.createInvite();
          this.pendingInvites.set(invite.id, invite);
          this._invitesByClient.set(msg.clientId, invite);
          // Registered before the offer goes out, so a candidate gathered while
          // the joiner is still reading the offer has somewhere to go.
          if (trickle) {
            invite.onIceCandidate((candidate) =>
              ws.send(JSON.stringify({ type: 'ice', clientId: msg.clientId, candidate })));
          }
          ws.send(JSON.stringify({ type: 'offer', clientId: msg.clientId, blob: invite.blob, trickle }));
        } else if (msg.type === 'answer') {
          await this.acceptAnswer(msg.blob).catch(() => {});
          // `acceptAnswer` settles only once the channels open or the connect
          // deadline expires, so by here this joiner is connected or gone and
          // its candidates are of no further use either way.
          this._invitesByClient.delete(msg.clientId);
        } else if (msg.type === 'ice') {
          // A candidate for a joiner this host has no live invite for — one that
          // already connected, one whose invite failed, or one from a room this
          // page is no longer part of. Dropping it is the ordinary end of a
          // join, not an error: the relay is dumb by design and will forward
          // whatever the far end was still gathering when it stopped mattering.
          this._invitesByClient.get(msg.clientId)?.addIceCandidate(msg.candidate);
        }
      };
    });
  }

  /** Join through the relay with a room code. */
  joinViaRelay(code, url = signalUrl()) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onerror = () => reject(new Error(relayError(url)));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code: String(code || '').toUpperCase() }));
      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') return reject(new Error(msg.error));
        if (msg.type === 'ice') {
          // The host trickles from the moment it has an offer, and this page
          // only has a transport once `joinManual` has built one. The window is
          // small but it is on the wire, not in this process, so it is not ours
          // to reason away — hold anything that beats the transport here.
          const transport = this.net?.transport;
          if (transport?.addIceCandidate) transport.addIceCandidate(msg.candidate);
          else this._earlyIce.push(msg.candidate);
          return;
        }
        if (msg.type === 'offer') {
          // `msg.trickle` is the host's claim *through this relay*: the host
          // only sets it against a v2 relay, and only a v2 relay preserves the
          // field. Either being old leaves it undefined and this join is the
          // one that ships today.
          const answer = await this.joinManual(msg.blob, {
            trickle: !!msg.trickle,
            onIceCandidate: (candidate) => ws.send(JSON.stringify({ type: 'ice', candidate })),
          });
          ws.send(JSON.stringify({ type: 'answer', blob: answer }));
          for (const c of this._earlyIce.splice(0)) this.net?.transport?.addIceCandidate?.(c);
          resolve();
        }
      };
    });
  }

  /**
   * End the session and put the lobby back where it started.
   *
   * Both refusal latches are cleared here, and neither is optional. They exist
   * to stop a *later* generic message overwriting the reason for a refusal that
   * has already happened, which is a within-session job — carried across a
   * `leave()` they silence the next session instead:
   *
   *  · `_refused` suppresses the generic `disconnected` status. Left set, every
   *    subsequent disconnect on this Lobby is silent for ever and the panel
   *    keeps showing a refusal from a session that has ended.
   *  · `_refusedPeers` is keyed by peer id, and peer ids are not unique across
   *    sessions: `leave()` drops the `NetHost`, `startHost()` builds a new one
   *    with a fresh `HostTransport` whose `_nextId` opens at 1 again. So a host
   *    that refused peer 1, left and hosted again swallowed the *next* peer 1's
   *    departure.
   */
  leave() {
    this.net?.close?.();
    this.ws?.close?.();
    // The Steam path's counterpart to `ws.close()`. `src/net/SteamLobby.js`
    // parks a teardown here when it opens a Steam lobby, because a Steam lobby
    // is not a socket: nothing closes it when the page stops caring, and the
    // player is left silently sitting in a lobby their friends can still join.
    // Undefined in the browser and in any session that never touched Steam.
    const steamCleanup = this._steamCleanup;
    this._steamCleanup = null;
    steamCleanup?.();
    // Dropping `this.net` was never enough. The system is registered with the
    // engine and publishes itself as `ctx.net` in `init`, so a closed `NetHost`
    // that is only forgotten here keeps being ticked every frame and stays the
    // answer every `ctx.net` reader gets — and hosting again registered a second
    // live host beside the dead one.
    this._release();
    this.mode = 'single';
    this.ctx.authority = true;
    // Every consumer of `netRole` has to be handed back its single-player
    // answer, not just `authority`. A stale 'client' stops
    // `Player.fixedUpdate` sampling input at all (Player.js:366 — the measured
    // 0.000 units of movement after leaving), re-points two damage filters
    // (Engine.js:357, :363) and silently disables profile and achievement
    // recording for the rest of the page's life (Profile.js:1272, :1369).
    this.ctx.netRole = 'single';
    this._refused = false;
    this._refusedPeers.clear();
    // Same reason `_refusedPeers` is cleared here: both are keyed by ids that a
    // fresh session reissues from the start, so anything left behind belongs to
    // a joiner who no longer exists and would answer for the next one.
    this._invitesByClient.clear();
    this._earlyIce.length = 0;
    this.players = [{ id: 0, name: 'You', local: true }];
    this._set('idle');
  }

  /** Undo `engine.add` and the `ctx.net` that the system's `init` published. */
  _release() {
    if (!this.net) return;
    this.engine.remove?.(this.net);
    if (this.ctx.net === this.net) this.ctx.net = null;
    this.net = null;
  }
}
