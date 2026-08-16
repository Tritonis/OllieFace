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
 * How often a host tells the relay that its room is still being hosted.
 *
 * The relay sees traffic only while peers are still handshaking: once everybody
 * has connected the game runs peer-to-peer and this socket goes silent for the
 * rest of the session. So the relay's idle room TTL — 30 minutes by default —
 * reclaimed the room out from under a live two-hour game whose players had all
 * joined in the first five minutes, and the friend who typed the code at minute
 * 90 was told 'No such room', which is indistinguishable from a typo. This
 * message is the only thing that can tell the relay the difference between a
 * quiet room and an abandoned one.
 *
 * Five minutes is well inside that TTL and is a few dozen bytes an hour, so it
 * is invisible on both ends. Only the host sends it, because the host is who
 * holds the room.
 *
 * No version gate, deliberately: an older relay's message switch has no default
 * case, so a `keepalive` it has never heard of is ignored and that host simply
 * gets the never-expiring room such a relay always gave it. The degrade is free
 * and stays free.
 */
const RELAY_KEEPALIVE_MS = 5 * 60 * 1000;

/**
 * How long a room code is, page-side.
 *
 * The relay's `LIMITS.CODE_LEN` is the authority and this is its copy, because
 * `tools/` is not part of the bundle and the page cannot import it. Nothing at
 * runtime holds the two together, so a test does:
 * `tests/signal-hardening.test.mjs` drives the page's normaliser, its grouping
 * and the two literals in the markup from the relay's own number, and fails if
 * either side moves alone.
 */
const CODE_LEN = 8;

/**
 * How many unanswered invites this page will hold at once.
 *
 * Every `joinRequest` the relay forwards makes this page build an
 * RTCPeerConnection — see `hostViaRelay` — and until this ceiling existed
 * `pendingInvites`, `_invitesByClient` and the transport's own `peers` were
 * three unbounded maps that were never pruned for a joiner who never answered.
 * Measured end to end against a real relay: one socket holding nothing but the
 * room code, pacing itself under every ceiling that relay declares, made a host
 * page build 317 peer connections in ten seconds and hold all 317 open. The
 * relay was unharmed the whole way; the victim is the other player's browser,
 * and Chromium stops handing out peer connections long before a page has
 * hundreds of them.
 *
 * The relay's `LIMITS.MAX_CLIENTS_PER_ROOM` is the number it mirrors, because a
 * room admits at most that many joiners at once and an invite exists to answer
 * one of them. It is deliberately not the relay's copy — `tools/` is not part of
 * the bundle — and it does not have to be: this is a page-side ceiling on the
 * page's own memory, and it is safe whatever the relay's number is.
 *
 * The relay's `join` rate limit is the other half and neither is sufficient
 * alone: a rate limit alone still permits one connection a second for ever, and
 * a bound alone lets a burst arrive as fast as a socket can write.
 */
const MAX_PENDING_INVITES = 8;

/**
 * How long a joiner waits for the host's offer before giving up on it.
 *
 * `joinViaRelay` settles on the `offer` message and on nothing else, so every
 * way a host can fail to send one is a joiner sitting on 'Joining room…' for
 * the rest of the page's life with no error and no way back but Leave. The
 * host page closed, froze or lost its network between the relay forwarding the
 * join and the invite being minted; its `createInvite` threw; or — the one
 * `MAX_PENDING_INVITES` made reachable — eight further joins arrived and
 * `_admitJoiner` evicted this joiner's invite, which cancels its peer
 * connection and tells it nothing, because the relay carries no message for
 * that. The clock on this side is the only thing that can end any of them.
 *
 * Twenty seconds, and it is deliberately generous. What it bounds is only the
 * first leg of a join — socket, relay round trip, the host's `createInvite`,
 * the offer coming back — and the whole join, all the way to a formed
 * connection, measured 5808 ms end to end against a real relay. So this is
 * over three times the complete measurement for a leg that is a fraction of
 * it, which leaves room for the things that legitimately stretch it: a cold
 * WebSocket handshake on a poor mobile link, and an old relay that cannot
 * carry candidates, where the host pays `waitForIce`'s 4 s cap inside
 * `createInvite` before the offer can even be sent. Too short is the failure
 * that matters here — a slow but perfectly healthy join refused on the clock
 * is a worse bug than the hang, because it is indistinguishable from a broken
 * relay. It is the same number `Transport.js` argued its way to for
 * `CONNECT_TIMEOUT_MS`, so a join has one span of patience rather than two
 * that disagree.
 */
const RELAY_OFFER_TIMEOUT_MS = 20000;

/**
 * A typed room code, reduced to the one spelling the relay keys its room map by.
 *
 * The relay does the same reduction on receipt (`tools/signal-server.mjs`,
 * `normalizeCode`) and would refuse anything else, so this is not the security
 * boundary — it is the difference between a friend who typed `abcd-2345` being
 * let in and being told there is no such room. The page cannot import the
 * server's copy: `tools/` is not part of the bundle.
 */
export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  const up = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return new RegExp(`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{${CODE_LEN}}$`).test(up) ? up : '';
}

/**
 * What the room-code field keeps while the player is still typing.
 *
 * `normalizeRoomCode` is the authority on what a code *is*, but it only runs
 * when the player presses Join — by which point the field has already applied
 * its own `maxlength` and thrown characters away. A code read aloud as "ABCD,
 * dash, 2345" is typed with spaces around the dash often enough that it matters:
 * eleven characters in a nine-character box arrive as `ABCD - 2`, which is five
 * real characters and is refused for being too short. The message was right and
 * the field had already eaten the code.
 *
 * So keep exactly what a code is read as — its letters and digits, and the one
 * dash it is grouped by — and drop the rest at the keystroke, where there is
 * still something to keep. The dash survives because a player who typed it
 * should see it; a run of them collapses because two dashes are nobody's
 * spelling of one. Nine characters is the most this can ever return for input
 * that contains a whole code, which is exactly what the field holds.
 */
export function tidyRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/-{2,}/g, '-');
}

/**
 * A room code as it is meant to be read aloud: one dash down the middle.
 *
 * It lives beside `normalizeRoomCode` rather than in the UI because the two are
 * one decision seen from either end — this is the spelling a host says, that is
 * every spelling a friend might type back. The co-op screen used to group the
 * code in the box and interpolate it ungrouped into the sentence beside it, so
 * two hosts reading one screen told their friend two different things.
 *
 * Anything that is not a whole code comes back untouched: there is no grouping
 * of half a code that helps anybody.
 */
export function formatRoomCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LEN) return code ?? '';
  return `${code.slice(0, CODE_LEN / 2)}-${code.slice(CODE_LEN / 2)}`;
}

/**
 * One of these per lobby session — per `startHost`/`joinViaRelay` up to the
 * `leave()` that ends it — and it is the thing an in-flight mint holds on to.
 *
 * `minting` counts invites whose `createInvite()` has been called and has not
 * resolved yet. They are counted against MAX_PENDING_INVITES beside the maps
 * themselves; see `_admitJoiner` for why a ceiling that reads only the maps is
 * no ceiling at all.
 *
 * The reason the count lives out here rather than on the Lobby is the race
 * between it and `leave()`. `createInvite()` is a long await — an offer, and on
 * a non-trickle relay a full ICE gather — and the player can press Leave in the
 * middle of one. A count that belonged to the Lobby had to be *reset* by
 * `leave()`, and the in-flight mint's `finally` then decremented the reset
 * count to -1: the ceiling that is this page's only defence against join
 * amplification became one invite taller for the rest of the page's life, and
 * one more with every leave that landed in that window.
 *
 * Handing out a fresh session instead of resetting a field makes the counting
 * balanced by construction. A mint claims from the session it was admitted by
 * and releases to that same session, so the arithmetic on any one session is
 * strictly paired: it cannot go negative, and it cannot be stranded above zero
 * either, because the session a stranded claim is stranded on is one nothing
 * reads any more. Identity does double duty — a mint whose captured session is
 * no longer `this._session` has resolved into a lobby that has moved on, and
 * everything it produced belongs to the dead session, not this one.
 */
function newSession() {
  return { minting: 0 };
}

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
    // The host's "this room is still in use" timer, while there is one.
    this._keepalive = null;
    this._session = newSession();
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
    const session = this._session;
    const net = this.net;
    const invite = await net.createInvite();
    // The player can press Leave while the offer is still gathering. What comes
    // back then is a peer connection belonging to a transport that has already
    // been closed, and writing it into `pendingInvites` would republish it into
    // whatever session is running now — so it is given up on the transport that
    // made it, and the caller is told there is no invite rather than shown a
    // blob nobody can answer.
    if (session !== this._session) {
      net.transport?.cancelInvite?.(invite.id);
      throw new Error('You left the lobby before the invite was ready');
    }
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
      // Whether the room code has arrived, which is what settles this promise —
      // see the `error` branch below for the two sides of that moment.
      let open = false;
      /**
       * Leave nothing behind on a host attempt that never became a room.
       *
       * Rejecting was not enough on either count. `ws.onopen` starts the
       * keepalive before the relay has said whether there is a room to keep
       * alive, so a 'Relay is full' arriving after the socket opened left a
       * five-minute timer writing to an open socket for the rest of the page's
       * life. And `startHost()` ran at the top of this method, so the lobby was
       * left in `host` mode holding a live `NetHost` — which is why the player
       * had no way to recover: pressing Create room again died on 'Already
       * networked' until they pressed Leave. This is `leave()`'s teardown minus
       * the parts that belong to a session that actually started.
       */
      const fail = (err) => {
        // A relay that errors late — a flaky connection the player answered by
        // pressing Leave and hosting again — delivers that error to a closure
        // whose `ws` this lobby replaced two steps ago. The teardown below
        // cannot tell one host from another (`_release()` only knows there is
        // one), so running it here would drop the *live* second room silently
        // to single-player. Identity is settled at the socket, because this is
        // the only place that still knows which socket asked.
        //
        // The attempt is still failed rather than abandoned: its caller is
        // inside `await hostViaRelay(...)` in the co-op screen's action
        // handler, and a promise that never settles leaves that handler's
        // `finally` unreached — which holds the action's busy latch and makes
        // the button dead for the rest of the session. Close the dead socket,
        // tell the caller, touch nothing that belongs to the live session.
        if (this.ws !== ws) {
          try { ws.close(); } catch { /* a socket that never opened */ }
          return reject(err);
        }
        this._stopKeepalive();
        try { ws.close(); } catch { /* a socket that never opened */ }
        this._release();
        this.mode = 'single';
        // `NetHost.init` published 'host' on the way in, and every reader of
        // `ctx.netRole` — input sampling, the damage filters, profile recording
        // — has to be handed its single-player answer back, exactly as
        // `joinManual`'s own failure path does.
        this.ctx.authority = true;
        this.ctx.netRole = 'single';
        reject(err);
      };
      ws.onerror = () => fail(new Error(relayError(url)));
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'host' }));
        this._startKeepalive(ws);
      };
      // Guarded for the same reason `fail` is, and it is not hypothetical: the
      // close *this* attempt performs on its own dead socket delivers an
      // `onclose` here, and an unguarded `_stopKeepalive()` would then silence
      // the beat belonging to the room the lobby is hosting now.
      ws.onclose = () => { if (this.ws === ws) this._stopKeepalive(); };
      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') {
          // The relay narrates its own failures, and they land on either side of
          // the room opening. 'Relay is full' arrives *instead of* a code, where
          // there is still a promise to fail and a caller waiting on it. 'Room
          // expired' arrives half an hour later, where that promise is long
          // settled — and rejecting a settled promise is a silent no-op, which is
          // how a host came to sit on the co-op screen believing it was still
          // hosting a room this relay had already forgotten. After the code, the
          // only thing left to tell is the screen.
          if (!open) fail(new Error(msg.error));
          else this._set('relayError', { error: msg.error });
        } else if (msg.type === 'hosting') {
          open = true;
          // A relay too old to say what it is cannot carry a candidate, so the
          // invites this session mints keep waiting for gathering — today's
          // behaviour, which works. `hosting` always precedes `joinRequest`, so
          // the decision is made before the first invite exists.
          this.net.transport.trickle = Number(msg.v) >= RELAY_TRICKLE_VERSION;
          this._set('roomOpen', { code: msg.code });
          resolve(msg.code);
        } else if (msg.type === 'joinRequest') {
          const trickle = this.net.transport.trickle === true;
          // Synchronously, and before the await below. Anyone holding the room
          // code can make the relay send these, and this page answers each one
          // with a peer connection — see `MAX_PENDING_INVITES`.
          if (!this._admitJoiner()) return;
          // Both captured before the await, because both can be replaced during
          // it: `leave()` hands the lobby a new session and a new `NetHost`, and
          // the claim below has to be released to — and the connection given up
          // on — the ones this mint was admitted by.
          const session = this._session;
          const net = this.net;
          session.minting += 1;
          let invite;
          // `finally` and not `catch`: a `createInvite` that throws — 'Lobby is
          // full' from `NetHost` — fails exactly as it did before this ceiling
          // existed. What must not change is the claim being released.
          try { invite = await net.createInvite(); } finally { session.minting -= 1; }
          // The lobby left while this offer was being made. `HostTransport`
          // registers the peer only after its own awaits, so the connection is
          // sitting in a closed transport's map with nothing left to close it;
          // and the maps and the socket below belong to a session that no longer
          // wants this joiner. Give the connection up and say nothing.
          if (session !== this._session) { net.transport?.cancelInvite?.(invite.id); return; }
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

  /**
   * Make room for one more joiner, and say whether there is any.
   *
   * Two things this has to get right, and the second is the one that decides
   * whether any of it works.
   *
   * **It counts invites that do not exist yet.** `ws.onmessage` is an async
   * function and nothing serialises it, so a burst of `joinRequest`s arrives as
   * a burst of *concurrent* `createInvite()` calls — every one of them awaiting,
   * none of them having written to any map. A ceiling that read
   * `pendingInvites.size` alone would see an empty map for all two hundred of
   * them and admit every one. `_session.minting` is the claim taken before the await,
   * which is the only place the claim can be taken.
   *
   * **It evicts rather than refuses.** Refusing at the ceiling would let eight
   * silent joiners lock a host out of their own room permanently: eight frames,
   * and no friend can ever be admitted again until the host presses Leave. The
   * oldest invite nobody has answered is given up instead, so the room stays
   * open to whoever knocks next and the cost of the attack decays to nothing the
   * moment the attacker stops. The window it opens is the other side of that
   * trade and is honest: a real joiner who is mid-handshake when eight further
   * joins arrive loses its invite. Against the relay's one-join-a-second that is
   * eight seconds of sustained flooding to displace a join that normally takes
   * one or two — and the joiner can simply try again, which the alternative
   * would not allow.
   *
   * Returns false only when there is nothing left to evict, i.e. when the whole
   * ceiling is in-flight mints — which is the flood itself.
   */
  _admitJoiner() {
    while (this.pendingInvites.size + this._session.minting >= MAX_PENDING_INVITES
           && this.pendingInvites.size > 0) {
      this._dropInvite(this.pendingInvites.keys().next().value);
    }
    // Bounded on its own account and not by implication. Every write to it is
    // paired with one to `pendingInvites`, but the two are emptied at different
    // moments (`acceptAnswer` clears one, the `answer` branch the other), and a
    // map that is only bounded by an invariant somebody else maintains is a map
    // waiting for that invariant to move.
    while (this._invitesByClient.size >= MAX_PENDING_INVITES) {
      const clientId = this._invitesByClient.keys().next().value;
      const stale = this._invitesByClient.get(clientId);
      this._invitesByClient.delete(clientId);
      if (stale) this._dropInvite(stale.id);
    }
    return this.pendingInvites.size + this._session.minting < MAX_PENDING_INVITES;
  }

  /**
   * Give up one invite, everywhere it is held.
   *
   * Three places, and the third is the one that matters: dropping an invite from
   * this object's two maps leaves its RTCPeerConnection open and referenced by
   * `HostTransport.peers`, so a bound enforced here alone would bound two maps
   * and leak every connection they ever held. `cancelInvite` closes it.
   */
  _dropInvite(id) {
    this.pendingInvites.delete(id);
    // Keyed the other way round, so this is a scan — over at most
    // MAX_PENDING_INVITES entries. Deleting while iterating a Map is defined.
    for (const [clientId, held] of this._invitesByClient) {
      if (held?.id === id) this._invitesByClient.delete(clientId);
    }
    this.net?.transport?.cancelInvite?.(id);
  }

  /**
   * Start telling the relay, on a timer, that this room is still in use.
   *
   * See `RELAY_KEEPALIVE_MS` for why a live session needs to say so at all.
   * Started when the host's socket opens and stopped when it closes or the lobby
   * leaves: a timer that outlives its socket is a leak, and a page that hosts
   * twice would otherwise beat twice for one room.
   */
  _startKeepalive(ws) {
    this._stopKeepalive();
    this._keepalive = setInterval(
      () => ws.send(JSON.stringify({ type: 'keepalive' })), this._keepaliveMs());
    // Node only, and a no-op in a browser: a headless Lobby — the tests, the
    // probes, the desktop shell's own harnesses — must not be held open for five
    // minutes by a timer whose whole job is to be invisible.
    this._keepalive.unref?.();
  }

  _stopKeepalive() {
    if (this._keepalive) clearInterval(this._keepalive);
    this._keepalive = null;
  }

  /** Overridable so a test can drive the beat rather than wait five minutes for one. */
  _keepaliveMs() { return RELAY_KEEPALIVE_MS; }

  /**
   * Overridable for the same reason `_keepaliveMs` and `Transport`'s own
   * `_connectTimeoutMs` are: the behaviour under test is that this wait ENDS,
   * which is answerable in milliseconds, and a test that slept through the real
   * deadline would be twenty seconds of nothing.
   */
  _offerTimeoutMs() { return RELAY_OFFER_TIMEOUT_MS; }

  /** Join through the relay with a room code. */
  joinViaRelay(code, url = signalUrl()) {
    const norm = normalizeRoomCode(code);
    // The relay refuses a malformed code by dropping it, silently and by
    // design — a hardened relay does not narrate its own validation to whoever
    // is probing it. Nothing below settles this promise on its own, so a code
    // that could never have been minted has to fail here, where there is
    // someone to tell.
    if (!norm) {
      return Promise.reject(new Error(
        `That is not a room code — it is ${CODE_LEN} letters and digits, and never O, 0, I or 1.`));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      // Whether this join has connected, which is what settles the promise. The
      // `error` branch below reads it for the same reason `hostViaRelay` reads
      // `open`: the relay speaks on both sides of that moment and the two sides
      // want opposite things done to the socket.
      let joined = false;
      // The deadline on the wait for the host's offer, while there is one. See
      // `RELAY_OFFER_TIMEOUT_MS`. Armed here rather than in `ws.onopen`,
      // because a socket that neither opens nor errors — a relay host that
      // black-holes the SYN, which is minutes of TCP retry with no event — is
      // one of the silent waits this exists to end.
      let offerTimer = null;
      const disarm = () => { if (offerTimer) { clearTimeout(offerTimer); offerTimer = null; } };
      /**
       * Give the connection back on a join that failed.
       *
       * Every terminal answer a joiner can get — 'No such room', 'Room is
       * full', 'Relay is full', a host that left before the offer — used to
       * reject and leave the socket connected, answering the relay's heartbeat
       * for ever; a retry simply assigned a new socket to `this.ws` and orphaned
       * the last one. Against a relay that now caps connections per address,
       * that made every mistyped code cost a permanent slot out of the
       * household's allowance, and the attempt that finally hit the cap was
       * refused at the handshake and shown `relayError()`'s localhost branch —
       * telling the player the relay was not running, the one explanation that
       * is certainly wrong.
       */
      const fail = (err) => {
        disarm();
        try { ws.close(); } catch { /* a socket that never opened */ }
        reject(err);
      };
      offerTimer = setTimeout(() => fail(new Error(
        'The host never sent an invite. They may have closed the game or lost their connection, '
        + 'or too many other joins arrived at once — try the code again.')), this._offerTimeoutMs());
      // Node only, and a no-op in a browser: the same reason `_startKeepalive`
      // unrefs its interval. A headless Lobby must not be held open for twenty
      // seconds by a deadline that is going to be disarmed anyway.
      offerTimer.unref?.();
      ws.onerror = () => fail(new Error(relayError(url)));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code: norm }));
      ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') {
          // Before the offer there is still a promise to fail and a player
          // waiting on it. After it, this join is peer-to-peer and the relay is
          // no longer part of it — but the socket is: it is still carrying
          // trickled candidates for a connection that may still be forming, so
          // closing it here would break the very thing the error is about to be
          // irrelevant to. Rejecting a settled promise says nothing to anybody
          // either, and a host that really left tears the data channel down
          // too, which reaches the screen as `netDisconnected`.
          if (!joined) fail(new Error(msg.error));
          return;
        }
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
          // The relay puts no role check on `offer`, so a second one can arrive
          // from anyone else holding the code. This page already has its
          // connection: answering again would throw 'Already networked' out of
          // an async handler nobody awaits, which is an unhandled rejection in
          // the page and, worse, would take the teardown below with it.
          if (joined) return;
          // The offer is exactly what the deadline was waiting for, so it stops
          // counting here and not when this promise settles. Everything below
          // is bounded on its own account — `waitForIce`'s cap, then the
          // transport's connect deadline — and a timer still armed across it
          // would eventually close the socket this joiner's trickled candidates
          // are riding, out from under a connection that is still forming.
          disarm();
          try {
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
            joined = true;
            resolve();
          } catch (err) {
            // An offer this page cannot answer — a blob it cannot parse, a
            // connection that never lands — is the same failed attempt as a
            // refusal from the relay, and left the same socket behind plus a
            // promise that never settled at all, so the co-op button stayed dark
            // and the player was told nothing.
            fail(err);
          }
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
    // Before the close and not only in `ws.onclose`: a close event is delivered
    // a turn later at best, and on a socket that never opened it is not
    // delivered at all — either way the interval must not survive the session
    // that started it.
    this._stopKeepalive();
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
    // `_invitesByClient` was cleared here and `pendingInvites` was not, so a page
    // that hosted, left and hosted again carried every unanswered invite of the
    // last session — and its peer connection — into the next one for the life of
    // the page. `net.close()` above has already closed the connections
    // themselves; this is the references to them.
    this.pendingInvites.clear();
    // A new session rather than a reset counter, and that distinction is the
    // whole of `newSession`'s reason to exist: an invite still being minted for
    // the session that is ending must not be able to reach in and count against
    // the one that starts next, nor be written into the maps just cleared above.
    this._session = newSession();
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
