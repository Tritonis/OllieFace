/**
 * The two halves of #55 that the portable contract deliberately does not cover:
 * the Steam Introduction handoff, and which transport a session gets.
 *
 *   node tests/steam-transport.test.mjs
 *
 * `tests/transport-conformance.test.mjs` proves the Conversation — the eight
 * peer members of `docs/STEAM.md` section 8.5, driven through the real
 * `NetHost`. It cannot prove the rendezvous, because ADR 0002 puts
 * `createInvite`/`join` outside the portable contract on purpose. This file
 * takes that half, over the same fake sockets layer.
 *
 * What this CAN prove: that the invite blob keeps the shape the lobby courier
 * and `Lobby._inviteIdFor` already parse, that a joiner's `connectP2P` reaches
 * the host's listen socket, that the host admits an identity it read an answer
 * from and closes one it did not, that both ends then carry framed messages on
 * both channels, and that a session with no Steam bridge gets WebRTC.
 *
 * What it CANNOT prove, and does not claim: that a real `ISteamNetworkingSockets`
 * behaves as `tests/steam-sockets-fake.mjs` says. Nothing on one box with one
 * Steam identity can. That half is the user's socket-pair smoke and the
 * two-seat sitting — `docs/STEAM.md` section 8.5 names what they must check.
 */
import { SteamHostTransport, SteamClientTransport, CH } from '../src/net/SteamTransport.js';
import { makeSteamNet } from './steam-sockets-fake.mjs';
import { HostTransport, ClientTransport } from '../src/net/Transport.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const HOST = '76561190000000001';
const JOINER = '76561190000000002';
const bytes = (...v) => new Uint8Array(v).buffer;

console.log('\nthe Introduction hands over an address, not a negotiation');
{
  const net = makeSteamNet();
  const host = new SteamHostTransport({ sockets: net.forIdentity(HOST) });
  const client = new SteamClientTransport({ sockets: net.forIdentity(JOINER) });

  const invite = await host.createInvite();
  const decoded = JSON.parse(atob(invite.blob));
  ok(decoded.role === 'offer' && decoded.id === invite.id,
    'the invite blob keeps the shape the lobby courier already carries');
  ok(decoded.steamId === HOST, "and names the host's Steam identity instead of an SDP");
  ok(host.listenSocket != null, 'minting an invite opened a listen socket');

  const { blob: answerBlob, connected } = await client.join(invite.blob);
  const answer = JSON.parse(atob(answerBlob));
  ok(answer.role === 'answer' && answer.id === invite.id,
    'the answer names the invite it answers, so `Lobby._inviteIdFor` still finds it');
  ok(answer.steamId === JOINER, "and carries the joiner's identity");

  let admitted = null;
  host.onPeer = (p) => { admitted = p; };
  const accepted = invite.accept(answerBlob);
  const hostPeer = await accepted;
  const clientPeer = await connected;

  ok(admitted === hostPeer, 'the host admitted the peer through onPeer');
  ok(hostPeer.id === invite.id, 'and gave it the invite id, so the host addresses it as before');
  ok(host.peers.get(invite.id) === hostPeer, 'and put it in the map Lobby bounds');

  // Both channels, both directions, over one connection.
  const heard = [];
  clientPeer.onMessage = (data, label) => heard.push([label, new Uint8Array(data)[0]]);
  hostPeer.sendState(bytes(11));
  hostPeer.sendEvent(bytes(22));
  clientPeer.pumpSim();
  ok(heard.length === 2, `both messages crossed (got ${heard.length})`);
  ok(heard[0][0] === 'state' && heard[0][1] === 11, 'the unreliable one arrived on the state channel');
  ok(heard[1][0] === 'events' && heard[1][1] === 22, 'the reliable one arrived on the events channel');

  const back = [];
  hostPeer.onMessage = (data, label) => back.push([label, new Uint8Array(data)[0]]);
  clientPeer.sendEvent(bytes(33));
  hostPeer.pumpSim();
  ok(back.length === 1 && back[0][0] === 'events' && back[0][1] === 33,
    'and the joiner can speak back on the same connection');

  // A leave the far end initiates reaches `onPeerLeave` through the state
  // change Steam queues, which is the whole reason `_pump` reads them.
  let left = null;
  host.onPeerLeave = (p) => { left = p; };
  clientPeer.close();
  host._pump();
  ok(left === hostPeer, 'a peer that closes its own connection reaches onPeerLeave');
  ok(host.peers.size === 0, 'and is gone from the transport');
}

console.log('\nan uninvited identity is refused rather than admitted');
{
  const net = makeSteamNet();
  const host = new SteamHostTransport({ sockets: net.forIdentity(HOST) });
  host.listen();
  const stranger = new SteamClientTransport({ sockets: net.forIdentity('76561190000000009') });

  // A blob the host never minted: a stranger who learned the host's id.
  const forged = btoa(JSON.stringify({ v: 1, role: 'offer', id: 99, steamId: HOST })).replace(/=+$/, '');
  const { connected } = await stranger.join(forged);
  let admitted = 0;
  host.onPeer = () => { admitted++; };
  host._pump();
  ok(admitted === 0, 'the host admitted nobody it had not read an answer from');
  ok(host.peers.size === 0, 'and its peer map stayed empty');
  // Refused, not merely unadmitted: the host closed the connection, so the
  // stranger's own end is dead rather than left hanging until a timeout.
  connected.catch(() => {});
  ok(net.conn(stranger.peer.conn).state === 4,
    `the host closed the uninvited connection (state ${net.conn(stranger.peer.conn).state})`);
  stranger.close();
}

console.log('\nthe channel byte is the only framing');
{
  ok(CH.state === 0 && CH.events === 1, 'state is channel 0 and events is channel 1, per docs/STEAM.md section 3');
}

console.log('\nselection: no bridge, no Steam transport');
{
  const saved = globalThis.__STEAM__;
  try {
    delete globalThis.__STEAM__;
    // Imported after the global is cleared is not required — the module reads
    // it per call, deliberately, so a shell that publishes the bridge late is
    // still seen.
    const { makeHostTransport, makeClientTransport, steamSockets } = await import('../src/net/TransportSelect.js');
    ok(steamSockets() === null, 'a runtime with no __STEAM__ has no sockets');
    ok(makeHostTransport() instanceof HostTransport, 'so the host gets the WebRTC transport');
    ok(makeClientTransport() instanceof ClientTransport, 'and so does the client');

    globalThis.__STEAM__ = { available: true, net: makeSteamNet().forIdentity(HOST) };
    ok(makeHostTransport() instanceof SteamHostTransport, 'a shell that publishes the bridge gets the Steam host transport');
    ok(makeClientTransport() instanceof SteamClientTransport, 'and the Steam client transport');

    globalThis.__STEAM__ = { available: false, net: makeSteamNet().forIdentity(HOST) };
    ok(makeHostTransport() instanceof HostTransport,
      'a shell whose Steam never answered falls back, however much bridge it published');
  } finally {
    if (saved === undefined) delete globalThis.__STEAM__; else globalThis.__STEAM__ = saved;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
