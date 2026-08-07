/**
 * Trickle ICE on the room-code path — and the manual path left alone.
 *
 *   node tests/trickle-ice.test.mjs
 *
 * Every join crosses `waitForIce` twice and each crossing can eat the 4 s cap,
 * which is the measured cause of the 0.6-10.9 s bimodal join spread
 * (reviews/audit-fixes/ice-quiescence-refuted.md). The cap cannot be shortened:
 * a copy-paste blob has no way to carry a candidate that arrives after the
 * human has pasted it, so the blob must be complete before it is handed over.
 *
 * The relay path has no such constraint — a live WebSocket is already carrying
 * the offer and the answer, so it can carry candidates too. This file pins the
 * three things that have to be true for that to be safe:
 *
 *   1. with `trickle`, the SDP is available the moment `setLocalDescription`
 *      resolves, even though gathering never completes;
 *   2. without it, nothing changed — the wait is still there (and
 *      tests/ice-quiescence.test.mjs, unmodified, still pins its shape);
 *   3. the candidate/remote-description race is handled in the only order that
 *      matters: a candidate that arrives before `setRemoteDescription` is
 *      buffered, not thrown away and not thrown.
 *
 * Fake `RTCPeerConnection` throughout, in the shape
 * tests/connect-deadline.test.mjs established: the defect class here is
 * promise/event wiring, so the wiring is what has to be driven.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { HostTransport, ClientTransport } from '../src/net/Transport.js';
import { Lobby } from '../src/net/Lobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const turn = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------
 * A fake peer connection whose gathering NEVER completes.
 *
 * That is the whole point: under non-trickle this pc costs the full cap every
 * time, so "did the trickle path wait for gathering?" is answerable by the
 * clock rather than by reading the source.
 * ---------------------------------------------------------------------- */
function fakeChannel(label) {
  return {
    label, readyState: 'connecting', bufferedAmount: 0, binaryType: '',
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send() {}, close() {},
    open() { this.readyState = 'open'; this.onopen?.(); },
  };
}

function fakePc() {
  const listeners = new Map();
  const pc = {
    connectionState: 'new',
    iceGatheringState: 'gathering',        // and it stays there
    localDescription: null,
    remoteDescription: null,
    added: [],                             // every candidate that reached addIceCandidate
    onicecandidate: null,
    createDataChannel(label) { return fakeChannel(label); },
    async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; },
    async setLocalDescription(d) { pc.localDescription = d ?? { type: 'offer', sdp: 'v=0 offer' }; },
    async setRemoteDescription(d) { pc.remoteDescription = d; },
    async addIceCandidate(c) { pc.added.push(c); },
    addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    /** The browser's own candidate event, including its end-of-gathering null. */
    emitCandidate(candidate) { pc.onicecandidate?.({ candidate }); },
    completeGathering() {
      pc.iceGatheringState = 'complete';
      for (const fn of [...(listeners.get('icegatheringstatechange') ?? [])]) fn();
    },
    _setState(s) { if (pc.connectionState !== s) { pc.connectionState = s; pc.onconnectionstatechange?.(); } },
    close() { pc._setState('closed'); },
  };
  return pc;
}

const pcs = [];
globalThis.RTCPeerConnection = function RTCPeerConnectionStub() {
  const pc = fakePc();
  pcs.push(pc);
  return pc;
};
const lastPc = () => pcs[pcs.length - 1];

const answerFor = (invite) =>
  btoa(JSON.stringify({ v: 1, role: 'answer', id: invite.id, sdp: { type: 'answer', sdp: 'v=0' } }));
const offerBlob = (id) =>
  btoa(JSON.stringify({ v: 1, role: 'offer', id, sdp: { type: 'offer', sdp: 'v=0' } }));

/* ==========================================================================
 * 1 — the timing claim, on both sides of the join
 * ======================================================================= */

console.log('T1 — a trickling host hands out the SDP without waiting for gathering');
{
  const t = new HostTransport();
  const t0 = Date.now();
  const invite = await t.createInvite({ trickle: true });
  const ms = Date.now() - t0;

  ok(ms < 150, `createInvite returned in ${ms}ms against a pc that never finishes gathering`);
  ok(lastPc().iceGatheringState === 'gathering', 'and gathering is still in progress, as it would be in a browser');
  const decoded = JSON.parse(atob(invite.blob));
  ok(decoded.sdp?.type === 'offer', 'the blob carries the local offer anyway');
  ok(typeof invite.onIceCandidate === 'function' && typeof invite.addIceCandidate === 'function',
     'and the invite exposes the two halves of the candidate exchange');
}

console.log('T1 — the manual path is untouched: it still waits for gathering');
{
  const t = new HostTransport();
  const pending = t.createInvite();                     // no options — the shipped manual call
  const raced = await Promise.race([pending.then(() => 'returned'), turn(200).then(() => 'still waiting')]);
  ok(raced === 'still waiting', `createInvite() held for the gathering wait (got '${raced}')`);

  // Release it so the 4 s cap does not keep the process alive.
  lastPc().completeGathering();
  const invite = await pending;
  ok(typeof invite.blob === 'string', 'and completes normally once gathering does');
}

console.log('T1 — the joiner half: trickle answers immediately, manual still waits');
{
  const c = new ClientTransport();
  const t0 = Date.now();
  const { blob } = await c.join(offerBlob(3), { trickle: true });
  const ms = Date.now() - t0;
  ok(ms < 150, `join returned in ${ms}ms with gathering unfinished`);
  ok(JSON.parse(atob(blob)).sdp?.type === 'answer', 'and the answer blob is real');

  const c2 = new ClientTransport();
  const pending = c2.join(offerBlob(4));
  const raced = await Promise.race([pending.then(() => 'returned'), turn(200).then(() => 'still waiting')]);
  ok(raced === 'still waiting', `join() without trickle still waits for gathering (got '${raced}')`);
  lastPc().completeGathering();
  await pending;
}

/* ==========================================================================
 * 2 — the outbound half: which candidates get relayed
 * ======================================================================= */

console.log('T2 — the end-of-gathering null sentinel is not relayed as a candidate');
{
  const t = new HostTransport();
  const invite = await t.createInvite({ trickle: true });
  const seen = [];
  invite.onIceCandidate((c) => seen.push(c));

  const pc = lastPc();
  pc.emitCandidate({ candidate: 'candidate:1 host' });
  pc.emitCandidate(null);                     // gathering finished — not a candidate
  pc.emitCandidate({ candidate: 'candidate:2 srflx' });

  ok(seen.length === 2, `two candidates relayed, not three (got ${seen.length})`);
  ok(seen.every((c) => c && c.candidate), `and none of them is the null sentinel (${JSON.stringify(seen)})`);
}

console.log('T2 — candidates gathered before a sink is registered are not lost');
{
  // Real ordering: `setLocalDescription` starts gathering, and the Lobby only
  // has somewhere to send candidates once the invite exists and the socket
  // send is wired. Anything gathered in that gap has to be held.
  const t = new HostTransport();
  const invite = await t.createInvite({ trickle: true });
  lastPc().emitCandidate({ candidate: 'candidate:early' });

  const seen = [];
  invite.onIceCandidate((c) => seen.push(c));
  ok(seen.length === 1 && seen[0].candidate === 'candidate:early',
     `the early candidate was replayed to the sink (got ${JSON.stringify(seen)})`);
}

console.log('T2 — a non-trickle invite relays nothing and its handles are inert');
{
  const t = new HostTransport();
  const invite = await t.createInvite();
  lastPc().completeGathering();
  await turn();
  const seen = [];
  let threw = null;
  try {
    invite.onIceCandidate((c) => seen.push(c));
    lastPc().emitCandidate({ candidate: 'candidate:1 host' });
    invite.addIceCandidate({ candidate: 'candidate:remote' });
  } catch (e) { threw = e; }
  ok(threw === null, `the handles exist and do not throw on the manual path (got ${threw?.message})`);
  ok(seen.length === 0, `nothing is relayed (got ${seen.length})`);
  ok(lastPc().added.length === 0, `and nothing is applied (got ${lastPc().added.length})`);
}

/* ==========================================================================
 * 3 — the inbound half: the candidate/remote-description race
 * ======================================================================= */

console.log('T3 — a candidate arriving before setRemoteDescription is buffered, then applied');
{
  const t = new HostTransport();
  const invite = await t.createInvite({ trickle: true });
  const pc = lastPc();

  // The host trickles its offer out at once, so the joiner's candidates can and
  // do arrive before the joiner's *answer* does. `addIceCandidate` before a
  // remote description is an error in every browser.
  invite.addIceCandidate({ candidate: 'candidate:remote-1' });
  invite.addIceCandidate({ candidate: 'candidate:remote-2' });
  ok(pc.added.length === 0, `nothing applied while there is no remote description (got ${pc.added.length})`);
  ok(pc.remoteDescription === null, 'and the remote description really is absent');

  t._connectTimeoutMs = () => 50;
  invite.accept(answerFor(invite)).catch(() => {});   // rejects on the deadline; irrelevant here
  await turn();

  ok(pc.remoteDescription !== null, 'accept set the remote description');
  ok(pc.added.length === 2, `both buffered candidates were then applied (got ${pc.added.length})`);
  ok(pc.added[0].candidate === 'candidate:remote-1' && pc.added[1].candidate === 'candidate:remote-2',
     'in arrival order');

  invite.addIceCandidate({ candidate: 'candidate:remote-3' });
  await turn();
  ok(pc.added.length === 3, `and a later candidate goes straight through (got ${pc.added.length})`);
}

console.log('T3 — the joiner buffers too: its remote description is set inside join()');
{
  const c = new ClientTransport();
  // The relay delivers the offer and the host's candidates over one socket, and
  // `join` is async — so a candidate can land before the transport has a pc at
  // all, let alone a remote description.
  c.addIceCandidate({ candidate: 'candidate:host-1' });
  await c.join(offerBlob(9), { trickle: true });
  const pc = lastPc();
  ok(pc.added.length === 1 && pc.added[0].candidate === 'candidate:host-1',
     `the pre-join candidate was applied once join built the connection (got ${JSON.stringify(pc.added)})`);

  c.addIceCandidate({ candidate: 'candidate:host-2' });
  await turn();
  ok(pc.added.length === 2, `and later ones apply immediately (got ${pc.added.length})`);
}

console.log('T3 — a rejected candidate does not become an unhandled rejection');
{
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(String(e?.message ?? e));
  process.on('unhandledRejection', onUnhandled);
  try {
    const t = new HostTransport();
    const invite = await t.createInvite({ trickle: true });
    const pc = lastPc();
    // A stale or malformed candidate is normal traffic on a relay; the browser
    // rejects the promise and nothing above here is awaiting it.
    pc.addIceCandidate = async () => { throw new Error('Failed to parse candidate'); };
    pc.remoteDescription = { type: 'answer' };
    t._connectTimeoutMs = () => 50;
    invite.accept(answerFor(invite)).catch(() => {});
    await turn();
    invite.addIceCandidate({ candidate: 'garbage' });
    await turn(20);
    ok(unhandled.length === 0, `nothing left unhandled (got ${JSON.stringify(unhandled)})`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

/* ==========================================================================
 * 4 — Lobby: protocol negotiation and the drop rules
 * ======================================================================= */

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  /** Deliver a server message; returns the handler's promise so tests can await it. */
  recv(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
}
globalThis.WebSocket = FakeWS;

function mkLobby() {
  const handlers = new Map();
  const ctx = {
    netRole: 'single', authority: true,
    events: {
      on: (n, f) => { (handlers.get(n) ?? handlers.set(n, []).get(n)).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
  };
  return new Lobby({ add: (s) => s, remove: () => {} }, ctx);
}

console.log('T4 — a v2 relay turns trickle on and the offer says so');
{
  const lobby = mkLobby();
  const p = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD', v: 2 });
  ok(await p === 'ABCD', 'the room code still resolves');
  ok(lobby.net.transport.trickle === true, 'the host transport is trickling');

  await ws.recv({ type: 'joinRequest', clientId: 11 });
  const offer = ws.ofType('offer')[0];
  ok(offer?.trickle === true, `the offer carries trickle:true for the relay to forward (got ${JSON.stringify(offer?.trickle)})`);

  // The candidates this invite gathers go out addressed to that joiner.
  lastPc().emitCandidate({ candidate: 'candidate:host-a' });
  const ice = ws.ofType('ice');
  ok(ice.length === 1 && ice[0].clientId === 11 && ice[0].candidate.candidate === 'candidate:host-a',
     `one ice message, keyed by clientId (got ${JSON.stringify(ice)})`);
  ok(ws.ofType('ice').every((m) => m.candidate !== null), 'and no null sentinel was relayed');
}

console.log('T4 — DEGRADE GATE: an old relay (no version) leaves the join exactly as it is today');
{
  const lobby = mkLobby();
  const p = lobby.hostViaRelay('ws://old-relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'WXYZ' });     // no `v` — the server predates ICE relay
  await p;
  ok(lobby.net.transport.trickle === false, 'trickle stays off');

  const req = ws.recv({ type: 'joinRequest', clientId: 4 });
  const raced = await Promise.race([req.then(() => 'returned'), turn(200).then(() => 'still waiting')]);
  ok(raced === 'still waiting', `the invite still waits for gathering (got '${raced}')`);
  lastPc().completeGathering();
  await req;
  const offer = ws.ofType('offer')[0];
  ok(offer?.trickle === false, `and the offer says trickle:false, which an old relay drops anyway (got ${JSON.stringify(offer?.trickle)})`);
  ok(ws.ofType('ice').length === 0, 'no candidate is ever sent to a relay that cannot carry one');
}

console.log('T4 — a candidate for an unknown or spent invite is dropped, not thrown');
{
  const lobby = mkLobby();
  const p = lobby.hostViaRelay('ws://relay.test');
  const ws = FakeWS.last;
  ws.open();
  await ws.recv({ type: 'hosting', code: 'ABCD', v: 2 });
  await p;

  let threw = null;
  try {
    await ws.recv({ type: 'ice', clientId: 999, candidate: { candidate: 'candidate:nobody' } });
    await ws.recv({ type: 'ice', clientId: 999 });                 // and one with nothing in it
  } catch (e) { threw = e; }
  ok(threw === null, `an unmatched candidate is dropped silently (got ${threw?.message})`);
}

console.log('T4 — the joiner trickles only when the offer says the relay will carry it');
{
  const lobby = mkLobby();
  lobby.joinViaRelay('ABCD', 'ws://relay.test').catch(() => {});
  const ws = FakeWS.last;
  ws.open();
  const done = ws.recv({ type: 'offer', blob: offerBlob(2), trickle: true });
  const raced = await Promise.race([done.then(() => 'returned'), turn(200).then(() => 'still waiting')]);
  ok(raced === 'returned', `the joiner answered without waiting for gathering (got '${raced}')`);
  ok(ws.ofType('answer').length === 1, 'and sent its answer');

  lastPc().emitCandidate({ candidate: 'candidate:client-a' });
  ok(ws.ofType('ice').length === 1, `its own candidates go back over the relay (got ${ws.ofType('ice').length})`);

  await ws.recv({ type: 'ice', candidate: { candidate: 'candidate:from-host' } });
  ok(lastPc().added.some((c) => c.candidate === 'candidate:from-host'),
     `and the host's candidates are applied (got ${JSON.stringify(lastPc().added)})`);
}

console.log('T4 — DEGRADE GATE: an offer with no trickle flag joins the old way');
{
  const lobby = mkLobby();
  lobby.joinViaRelay('ABCD', 'ws://old-relay.test').catch(() => {});
  const ws = FakeWS.last;
  ws.open();
  // An old relay forwards `{type:'offer', blob}` and drops every field it does
  // not know about, so this is what a new client sees through one.
  const done = ws.recv({ type: 'offer', blob: offerBlob(2) });
  const raced = await Promise.race([done.then(() => 'returned'), turn(200).then(() => 'still waiting')]);
  ok(raced === 'still waiting', `the joiner waits for gathering, as it does today (got '${raced}')`);
  lastPc().completeGathering();
  await done;
  ok(ws.ofType('answer').length === 1, 'and still answers');
  ok(ws.ofType('ice').length === 0, 'without ever sending a candidate to a relay that would drop it');
}

/* ==========================================================================
 * 5 — the relay itself, as a process
 * ======================================================================= */

console.log('T5 — signal-server relays ice both ways, and says what version it is');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const server = spawn(process.execPath, [join(here, '..', 'tools', 'signal-server.mjs'), '--port', '0'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('signal-server never announced a port')), 5000);
      server.stdout.on('data', (b) => {
        const m = /ws:\/\/0\.0\.0\.0:(\d+)/.exec(String(b));
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    ok(port > 0, `the relay bound an ephemeral port (${port})`);

    const connect = (url) => new Promise((res, rej) => {
      const s = new WebSocket(url);
      s.inbox = [];
      s.on('message', (d) => { s.inbox.push(JSON.parse(d)); s._wake?.(); });
      s.on('error', rej);
      s.on('open', () => res(s));
    });
    /** Wait for the next message of `type`, from the start of the inbox. */
    const await1 = (s, type) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no '${type}' from the relay`)), 3000);
      const check = () => {
        const i = s.inbox.findIndex((m) => m.type === type);
        if (i < 0) return;
        clearTimeout(t); s._wake = null; res(s.inbox.splice(i, 1)[0]);
      };
      s._wake = check; check();
    });
    const url = `ws://127.0.0.1:${port}`;

    const host = await connect(url);
    host.send(JSON.stringify({ type: 'host' }));
    const hosting = await await1(host, 'hosting');
    ok(hosting.v >= 2, `the relay advertises a protocol version (got ${JSON.stringify(hosting.v)})`);

    const client = await connect(url);
    client.send(JSON.stringify({ type: 'join', code: hosting.code }));
    const jr = await await1(host, 'joinRequest');

    host.send(JSON.stringify({ type: 'offer', clientId: jr.clientId, blob: 'BLOB', trickle: true }));
    const offer = await await1(client, 'offer');
    ok(offer.blob === 'BLOB' && offer.trickle === true,
       `the offer is forwarded with its trickle flag (got ${JSON.stringify(offer)})`);

    host.send(JSON.stringify({ type: 'ice', clientId: jr.clientId, candidate: { candidate: 'H1' } }));
    const toClient = await await1(client, 'ice');
    ok(toClient.candidate?.candidate === 'H1', `host -> client candidate relayed (got ${JSON.stringify(toClient)})`);

    client.send(JSON.stringify({ type: 'ice', candidate: { candidate: 'C1' } }));
    const toHost = await await1(host, 'ice');
    ok(toHost.candidate?.candidate === 'C1' && toHost.clientId === jr.clientId,
       `client -> host candidate relayed, stamped with the sender (got ${JSON.stringify(toHost)})`);

    // A candidate for a joiner who is not in this room must not crash the relay
    // or leak into another room.
    host.send(JSON.stringify({ type: 'ice', clientId: 4242, candidate: { candidate: 'X' } }));
    host.send(JSON.stringify({ type: 'ice' }));
    host.send(JSON.stringify({ type: 'ping-nobody-implements' }));
    host.send(JSON.stringify({ type: 'host' }));
    const rehost = await await1(host, 'hosting');
    ok(rehost.code.length === 4, 'the relay is still answering after all of that');

    host.close(); client.close();
  } finally {
    server.kill();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
