/**
 * A halted engine stops hosting — issue #75.
 *
 *   node tests/halt-hosting.test.mjs
 *
 * The three breaks in #75 were only findable end to end, because each one is a
 * *socket* callback outrunning a *frame-loop* guarantee. So this file uses the
 * real `Engine`, the real `Lobby` and the real `NetHost`, halts the engine the
 * way the game halts it — a critical system throwing inside `Engine._frame` —
 * and then asks what the page still does. The only stand-in is the WebSocket,
 * which is what lets the relay's messages be delivered on demand.
 *
 * Every assertion here is about behaviour that crosses a wire or a timer:
 * offers sent, WELCOMEs sent, keepalives beaten. Asserting that a flag got set
 * would pass against code that sets the flag and talks anyway, which is the
 * exact shape of the defect this file exists for.
 */
import { Engine } from '../src/core/Engine.js';
import { Lobby } from '../src/net/Lobby.js';
import { NetHost } from '../src/net/NetHost.js';
import { MSG, Writer } from '../src/net/Protocol.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
}
globalThis.WebSocket = FakeWS;

/** The critical failure. Undeclared criticality is critical — see `isCriticalSystem`. */
class Doomed {
  static critical = true;
  update() { throw new Error('the world came apart'); }
}

/** A peer whose channels are open, counting what the host sent it. */
function makePeer(id = 1) {
  const p = {
    id, states: 0, events_: 0, closed: false,
    events: { readyState: 'open', bufferedAmount: 0 },
    sendState() { p.states++; }, sendEvent() { p.events_++; }, pumpSim() {},
    drained() { return !p.events || p.events.readyState !== 'open' || p.events.bufferedAmount === 0; },
    close() { if (p.closed) return; p.closed = true; p.onClose?.(); },
  };
  return p;
}

/** A real Engine with the loop flag set but no rAF — frames are driven by hand. */
function freshEngine() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  return engine;
}

/** Drive one frame and check the run really did stop, so nothing below is vacuous. */
function haltFor(engine) {
  engine.add(new Doomed());
  engine._frame();
  return !!engine.fatal;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real Lobby hosting a real relay room on a real Engine, parked at roomOpen. */
async function hostingLobby() {
  const engine = freshEngine();
  const lobby = new Lobby(engine, engine.ctx);
  // The beat under test is that it STOPS, which is answerable in milliseconds.
  lobby._keepaliveMs = () => 5;
  const open = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD', v: 2 });
  await open;
  // The only part of the real transport this file is about is that an offer
  // either does or does not reach the socket, and `HostTransport.createInvite`
  // wants an `RTCPeerConnection` node has never heard of. Stubbed so a host that
  // wrongly answers a post-halt `joinRequest` produces a visible offer rather
  // than a ReferenceError, i.e. so the guard fails as an assertion.
  const ice = {};
  lobby.net.createInvite = async () => ({
    id: 1, blob: 'offer-blob', onIceCandidate(cb) { ice.fire = cb; },
  });
  lobby.net.transport.cancelInvite = () => true;
  return { engine, lobby, ws, ice };
}

console.log('the room is genuinely open before the halt (the control)');
let live;
{
  live = await hostingLobby();
  const before = live.ws.ofType('keepalive').length;
  await sleep(40);
  ok(live.engine.ctx.authority === true, 'hosting, and authoritative');
  ok(live.ws.ofType('keepalive').length > before, 'the keepalive is beating');
}

console.log('#75 break 3 — a halted page stops holding the relay room');
{
  const { engine, lobby, ws } = live;
  ok(haltFor(engine), 'the engine halted on a critical throw');
  ok(engine.ctx.authority === false, 'the halt surrendered authority');

  const atHalt = ws.ofType('keepalive').length;
  await sleep(40);
  ok(ws.ofType('keepalive').length === atHalt,
     `no keepalive beat after the halt (${ws.ofType('keepalive').length - atHalt} did)`);
  ok(ws.closed === true, 'the relay socket was closed');
  ok(lobby.mode === 'single', 'the lobby is no longer hosting');

  console.log('#75 break 2 — a halted host answers no joiner');
  const offersAtHalt = ws.ofType('offer').length;
  await ws.recv({ type: 'joinRequest', clientId: 'c1' });
  await sleep(0);
  ok(ws.ofType('offer').length === offersAtHalt,
     `no offer sent after the halt (${ws.ofType('offer').length - offersAtHalt} were)`);

  console.log('#75 break 1 — the halt survives the teardown that follows it');
  // The issue's own warning: `leave()` is the obvious fix and it ends by setting
  // `ctx.authority = true`, so the teardown would re-arm what the halt gave up.
  lobby.leave();
  ok(engine.ctx.authority === false, 'leave() after a halt does not restore authority');
  ok(engine.ctx.netRole === 'single', 'netRole is still handed back — it says who speaks, not whether anyone may');
}

console.log('#75 break 1 — a relay failure on a halted page does not restore authority either');
{
  // The reproduction's `ws.onerror` path, reached on its own terms: this lobby
  // is halted before it ever hosts, so `hostViaRelay`'s own failure teardown —
  // not `leave()`'s — is the one that runs.
  const engine = freshEngine();
  ok(haltFor(engine), 'the engine halted');
  const lobby = new Lobby(engine, engine.ctx);
  const attempt = lobby.hostViaRelay('ws://relay.test').then(() => 'resolved', () => 'rejected');
  FakeWS.last.onerror?.();
  ok(await attempt === 'rejected', 'the host attempt failed rather than hanging');
  ok(engine.ctx.authority === false, 'authority did not come back through hostViaRelay fail()');
}

console.log('#75 break 2 — a candidate gathered before the halt is not sent after it');
{
  // The window the `joinRequest` gate cannot cover: the offer shipped while the
  // run was alive, ICE gathering is still going, and the halt lands in between.
  // The candidate callback is registered on the invite, not on the socket, so
  // nothing between it and `ws.send` knows the session ended.
  const { engine, ws, ice } = await hostingLobby();
  await ws.recv({ type: 'joinRequest', clientId: 'c9' });
  await sleep(0);
  ok(typeof ice.fire === 'function', 'the host registered an ICE sink (the control)');
  ice.fire({ candidate: 'pre-halt' });
  ok(ws.ofType('ice').length === 1, 'a live host does relay a candidate (the control)');

  ok(haltFor(engine), 'the engine halted');
  ice.fire({ candidate: 'post-halt' });
  ok(ws.ofType('ice').length === 1,
     `no candidate relayed after the halt (${ws.ofType('ice').length - 1} were)`);
}

console.log('#75 break 1 — a late relay error on a halted page still hands netRole back');
{
  // `_quiet()` nulls `this.ws`, so a genuine `onerror` arriving afterwards takes
  // `fail()`'s "superseded session, touch nothing" branch. Authority must stay
  // surrendered — but `netRole` says who is speaking, not whether anyone may,
  // and every reader of it is owed its single-player answer either way.
  const { engine, ws } = await hostingLobby();
  ok(haltFor(engine), 'the engine halted');
  ws.onerror?.();
  await sleep(0);
  ok(engine.ctx.netRole === 'single', `netRole handed back (got ${JSON.stringify(engine.ctx.netRole)})`);
  ok(engine.ctx.authority === false, 'authority still surrendered');
}

console.log('#75 break 2 — a halted NetHost greets nobody');
{
  const engine = freshEngine();
  const ctx = engine.ctx;
  ctx.spawnRemotePlayer = () => ({ isPlayer: true, alive: true, position: { x: 0, y: 0, z: 0 } });
  const host = new NetHost({ maxPlayers: 4 });
  host.init(ctx);

  const beforePeer = makePeer(1);
  host._onPeer(beforePeer);
  ok(beforePeer.events_ === 1, 'a live host does send WELCOME (the control)');

  ok(haltFor(engine), 'the engine halted');
  let joined = 0;
  ctx.events.on('netPlayerJoined', () => { joined++; });

  const peer = makePeer(2);
  host._onPeer(peer);
  ok(peer.events_ === 0, `no WELCOME after the halt (${peer.events_} sent)`);
  ok(joined === 0, 'no netPlayerJoined announced for a peer that was never admitted');
  ok(!host.clients.has(2), 'the peer was not entered into the session');

  // A PONG is a send from a transport callback too, and answering one tells a
  // peer this session is alive.
  const ponged = makePeer(3);
  host.clients.set(3, { peer: ponged, pawn: null, inputs: [], lastTick: 0, name: 'x', joinTick: 0, joinedAt: 0, helloSeen: true, survivorId: null });
  // Built from the real protocol, not a hand-guessed byte: a wrong kind is
  // ignored by `_handleMessage` anyway, which would make this assertion pass
  // against the unguarded code and prove nothing.
  const ping = new Writer(16).u8(MSG.PING).f32(1).bytes();
  host._onMessage(ponged, ping);
  ok(ponged.states === 0, `no reply to an inbound message after the halt (${ponged.states} sent)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
