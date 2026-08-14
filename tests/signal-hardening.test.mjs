/**
 * The relay's own defences.
 *
 *   node tests/signal-hardening.test.mjs
 *
 * Two halves. The first imports the policy helpers directly and drives them as
 * pure functions — importing the module must NOT start a listener. The second
 * spawns the real server on an ephemeral port and proves the same rules hold on
 * the wire, because a policy that is only true in a unit test is not a defence.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { LIMITS, validate, normalizeCode } from '../tools/signal-server.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const here = dirname(fileURLToPath(import.meta.url));

/* ==========================================================================
 * 1 — the schema
 * ======================================================================= */

console.log('T1 — a message that is not a recognised shape is rejected with a reason');
{
  ok(validate(null).ok === false, 'null is not a message');
  ok(validate('host').ok === false, 'a bare string is not a message');
  ok(validate({}).reason === 'bad-type', 'a message with no type is bad-type');
  ok(validate({ type: 'nonsense' }).reason === 'bad-type', 'an unknown type is bad-type');
  ok(validate({ type: 'host' }).ok === true, 'a bare host is valid');
  ok(validate({ type: 'join', code: 'ABCD2345' }).ok === true, 'a join with a well-formed code is valid');
}

console.log('T1 — a code that could not have been minted here is refused before any lookup');
{
  ok(validate({ type: 'join', code: 'ABC' }).reason === 'bad-code', 'too short');
  ok(validate({ type: 'join', code: 'ABCD23456' }).reason === 'bad-code', 'too long');
  ok(validate({ type: 'join', code: 'ABCD01II' }).reason === 'bad-code', 'characters outside the alphabet');
  ok(validate({ type: 'join' }).reason === 'bad-code', 'absent');
  ok(validate({ type: 'join', code: 'abcd2345' }).ok === true, 'lowercase is normalised, not refused');
  ok(validate({ type: 'join', code: 'abcd-2345' }).msg.code === 'ABCD2345',
     'and the separator is stripped, so the room map only ever sees one spelling');
}

console.log('T1 — an oversized blob or candidate is refused rather than forwarded');
{
  const big = 'x'.repeat(LIMITS.MAX_BLOB_CHARS + 1);
  ok(validate({ type: 'offer', clientId: 1, blob: big }).reason === 'blob-too-big', 'an offer blob has a ceiling');
  ok(validate({ type: 'answer', blob: big }).reason === 'blob-too-big', 'an answer blob has the same ceiling');
  ok(validate({ type: 'offer', clientId: 1, blob: 'ok' }).ok === true, 'an ordinary blob passes');
  const fatCandidate = { candidate: 'y'.repeat(LIMITS.MAX_CANDIDATE_CHARS + 1) };
  ok(validate({ type: 'ice', candidate: fatCandidate }).reason === 'candidate-too-big', 'a candidate has a ceiling');
  ok(validate({ type: 'ice', candidate: { candidate: 'a=x' } }).ok === true, 'an ordinary candidate passes');
  ok(validate({ type: 'offer', clientId: 'nope', blob: 'ok' }).reason === 'bad-client-id',
     'a clientId that is not a number is refused');
}

console.log('T1 — normalizeCode is total: anything in, a legal code or nothing out');
{
  ok(normalizeCode('  abcd-2345 ') === 'ABCD2345', 'trims, strips and uppercases');
  ok(normalizeCode(null) === '', 'null is empty');
  ok(normalizeCode(12345678) === '', 'a non-string is empty');
  ok(normalizeCode('!!!!') === '', 'punctuation alone is empty');
}

/* ==========================================================================
 * 2 — the same rules, on the wire
 * ======================================================================= */

/**
 * Spawn the relay on an ephemeral port; resolves with its port.
 *
 * Every complete stdout line is also kept on `server.logs`, because from Task 3
 * onwards the relay's structured log IS part of its behaviour — a defence that
 * fires without saying so is one an operator cannot tell from one that never
 * fired, and a log line that says too much is its own defect.
 */
function startRelay(env = {}) {
  const server = spawn(process.execPath, [join(here, '..', 'tools', 'signal-server.mjs'), '--port', '0'],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  server.logs = [];
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay never announced a port')), 5000);
    let buf = '';
    let announced = false;
    server.stdout.on('data', (d) => {
      buf += String(d);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        server.logs.push(line);
        const m = announced ? null : line.match(/ws:\/\/0\.0\.0\.0:(\d+)/);
        if (m) { announced = true; clearTimeout(t); resolve({ server, port: Number(m[1]) }); }
      }
    });
  });
}

/** A socket with `recv(type)` — resolves the next message of that type. */
function connect(port, opts) {
  const s = new WebSocket(`ws://127.0.0.1:${port}`, opts);
  s.queue = [];
  s.waiters = [];
  s.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const w = s.waiters.findIndex((x) => x.type === msg.type);
    if (w >= 0) s.waiters.splice(w, 1)[0].resolve(msg); else s.queue.push(msg);
  });
  s.recv = (type, ms = 3000) => new Promise((resolve, reject) => {
    const i = s.queue.findIndex((m) => m.type === type);
    if (i >= 0) return resolve(s.queue.splice(i, 1)[0]);
    const t = setTimeout(() => reject(new Error(`no '${type}' from the relay`)), ms);
    s.waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  s.opened = new Promise((resolve, reject) => { s.on('open', resolve); s.on('error', reject); });
  return s;
}

const closed = (s) => new Promise((r) => s.on('close', (code) => r(code)));

console.log('T2 — a junk frame does not disturb a live room');
{
  const { server, port } = await startRelay();
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  ok(/^[A-Z2-9]{8}$/.test(hosting.code), `the relay mints an 8-character code (got ${hosting.code})`);

  host.send('{not json');
  host.send(JSON.stringify({ type: 'nonsense' }));
  host.send(JSON.stringify({ type: 'join', code: '!!' }));

  const joiner = connect(port);
  await joiner.opened;
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const req = await host.recv('joinRequest');
  ok(typeof req.clientId === 'number', 'and the room still takes a joiner afterwards');

  host.close(); joiner.close(); server.kill();
}

console.log('T2 — a client cannot name its own room');
{
  const { server, port } = await startRelay();
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host', code: 'AAAAAAAA' }));
  const hosting = await host.recv('hosting');
  ok(hosting.code !== 'AAAAAAAA', `the relay ignores a client-chosen code (got ${hosting.code})`);
  ok(/^[A-Z2-9]{8}$/.test(hosting.code), 'and mints its own');
  host.close(); server.kill();
}

console.log('T2 — an oversized frame is dropped by the socket, not buffered by the room');
{
  const { server, port } = await startRelay();
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  await host.recv('hosting');
  host.send(JSON.stringify({ type: 'offer', clientId: 1, blob: 'z'.repeat(LIMITS.MAX_PAYLOAD_BYTES + 1024) }));
  const code = await closed(host);
  ok(code === 1009, `an over-maxPayload frame closes the socket with 1009 (got ${code})`);

  // Closing the sender's socket is only half the requirement. `ws` answers an
  // over-maxPayload frame with 1009 and then emits 'error' on the server side;
  // with no listener there that is an unhandled 'error' event, which takes the
  // whole relay down — so one stranger's oversized frame would end every other
  // player's session too. The 1009 above is true either way, which is why this
  // assertion has to exist beside it.
  const survivor = connect(port);
  await survivor.opened;
  survivor.send(JSON.stringify({ type: 'host' }));
  const still = await survivor.recv('hosting');
  ok(still.code.length === LIMITS.CODE_LEN,
     `and the relay is still serving other rooms afterwards (got ${still.code})`);

  survivor.close(); server.kill();
}

/* ==========================================================================
 * 3 — the page's own normaliser agrees with the relay's
 * ======================================================================= */

console.log('T3 — Lobby normalises a typed code to exactly what the relay would key on');
{
  const { normalizeRoomCode } = await import('../src/net/Lobby.js');
  const cases = ['abcd2345', 'ABCD-2345', ' abcd 2345 ', 'AbCd2345'];
  ok(cases.every((c) => normalizeRoomCode(c) === 'ABCD2345'),
     'every spelling of one code collapses to one string');
  ok(normalizeRoomCode('abcd2345') === normalizeCode('abcd2345'),
     'and it is the same string the relay derives');
  ok(normalizeRoomCode('!!') === '', 'junk normalises to nothing rather than to a lookup');
}

console.log('T3 — a code that could never be real is refused here, where there is someone to tell');
{
  const { Lobby } = await import('../src/net/Lobby.js');
  const lobby = Object.create(Lobby.prototype);
  // `ABCD0I45` is the transcription error the alphabet predicts: a code read
  // aloud, written down with a zero for O and a one for I. The relay would drop
  // it as malformed and answer nothing at all, and `joinViaRelay` has no
  // timeout — so a join that never resolves would leave the co-op screen saying
  // "Joining room…" for ever. It has to fail here, out loud.
  let message = null;
  await lobby.joinViaRelay('ABCD0I45', 'ws://relay.test').catch((e) => { message = e.message; });
  ok(typeof message === 'string' && /room code/i.test(message),
     `a malformed code rejects with something a player can act on (got ${JSON.stringify(message)})`);
}

/* ==========================================================================
 * 4 — the ceilings
 * ======================================================================= */

console.log('T4 — the token bucket spends a burst, refuses, then refills on the clock');
{
  const { TokenBucket } = await import('../tools/signal-server.mjs');
  const b = new TokenBucket(10, 5);          // 10/s sustained, 5 in hand
  let t = 1_000_000;
  const spent = [];
  for (let i = 0; i < 6; i++) spent.push(b.take(t));
  ok(spent.filter(Boolean).length === 5, `the burst is exactly the burst (got ${spent.filter(Boolean).length})`);
  ok(spent[5] === false, 'and the one after it is refused');
  ok(b.take(t + 100) === true, '100 ms later one token has refilled');
  ok(b.take(t + 100) === false, 'but only one');
}

console.log('T4 — a room dies when its host does, and when nobody comes back for it');
{
  const { server, port } = await startRelay({ SIGNAL_ROOM_TTL_MS: '600' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  ok((await res.json()).rooms === 1, 'the room is counted while it is live');

  await new Promise((r) => setTimeout(r, 1400));
  const after = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  ok(after.rooms === 0, `an expired room is swept (got ${after.rooms})`);

  const late = connect(port);
  await late.opened;
  late.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const err = await late.recv('error');
  ok(err.error === 'No such room', 'and joining it afterwards is an honest miss');

  // The sweep is the one place the relay names a room out loud, and it must not.
  const expiry = server.logs.find((l) => l.includes('"event":"room-expired"'));
  ok(!!expiry, `the sweep says it swept something (got ${JSON.stringify(server.logs)})`);
  ok(!!expiry && !expiry.includes(hosting.code),
     `and does not print the code it swept (got ${expiry})`);

  host.close(); late.close(); server.kill();
}

console.log('T4 — a room takes its declared number of joiners and no more');
{
  const { server, port } = await startRelay({ SIGNAL_MAX_CLIENTS_PER_ROOM: '2' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');

  const joiners = [];
  for (let i = 0; i < 2; i++) {
    const j = connect(port);
    await j.opened;
    j.send(JSON.stringify({ type: 'join', code: hosting.code }));
    await host.recv('joinRequest');
    joiners.push(j);
  }
  const third = connect(port);
  await third.opened;
  third.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const err = await third.recv('error');
  ok(err.error === 'Room is full', `the third joiner is turned away (got ${err.error})`);

  for (const j of joiners) j.close();
  host.close(); third.close(); server.kill();
}

console.log('T4 — the relay holds no more rooms than it declared, and a re-host spends no extra one');
{
  const { server, port } = await startRelay({ SIGNAL_MAX_ROOMS: '1' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const first = await host.recv('hosting');

  const other = connect(port);
  await other.opened;
  other.send(JSON.stringify({ type: 'host' }));
  const err = await other.recv('error');
  ok(err.error === 'Relay is full', `a room past the cap is refused (got ${err.error})`);

  // A socket that hosts again must release the room it already held rather than
  // orphan it. An orphaned room is unreachable — nothing points at it — but it
  // is still counted, and it is only released by the TTL sweep half an hour
  // later. With MAX_ROOMS in force that turns `host` sent in a loop from a
  // memory leak into a denial of service: one socket spends the whole relay's
  // room budget in a single burst and every real host is told 'Relay is full'.
  host.send(JSON.stringify({ type: 'host' }));
  const second = await host.recv('hosting');
  ok(second.code !== first.code, `a re-host mints a new code (got ${second.code})`);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  ok(health.rooms === 1, `and the relay still holds exactly one room (got ${health.rooms})`);

  host.close(); other.close(); server.kill();
}

console.log('T4 — a per-IP connection cap that a forged header cannot walk past');
{
  const { server, port } = await startRelay({ SIGNAL_MAX_CONNS_PER_IP: '2' });
  const a = connect(port); await a.opened;
  const b = connect(port); await b.opened;

  const third = connect(port);
  let refused = false;
  try { await third.opened; } catch { refused = true; }
  ok(refused, 'the third connection from one address never completes the handshake');

  // `x-forwarded-for` is written by whoever is talking to us. Believing it
  // unconditionally makes the cap above a formality — a fresh value on every
  // connection buys a fresh allowance — so it is trusted only where the
  // deployment states that a proxy it controls rewrites the header.
  const forged = connect(port, { headers: { 'x-forwarded-for': '9.9.9.9' } });
  let forgedRefused = false;
  try { await forged.opened; } catch { forgedRefused = true; }
  ok(forgedRefused, 'and a forged x-forwarded-for does not buy a fresh allowance');

  // Turning the trust on is what a real deployment behind Fly or Render does,
  // and then the header is the only thing that tells two players apart.
  const trusting = await startRelay({ SIGNAL_MAX_CONNS_PER_IP: '1', SIGNAL_TRUST_PROXY: '1' });
  const p1 = connect(trusting.port, { headers: { 'x-forwarded-for': '203.0.113.1' } });
  await p1.opened;
  const p2 = connect(trusting.port, { headers: { 'x-forwarded-for': '203.0.113.2' } });
  let secondRefused = false;
  try { await p2.opened; } catch { secondRefused = true; }
  ok(!secondRefused, 'behind a trusted proxy two forwarded addresses are two players');
  const p3 = connect(trusting.port, { headers: { 'x-forwarded-for': '203.0.113.1' } });
  let sameRefused = false;
  try { await p3.opened; } catch { sameRefused = true; }
  ok(sameRefused, 'and the same forwarded address is still one');

  p1.close(); p2.close(); trusting.server.kill();
  a.close(); b.close(); server.kill();
}

console.log('T4 — an Origin allowlist admits what it names and refuses what it does not');
{
  const { server, port } = await startRelay({ SIGNAL_ALLOWED_ORIGINS: 'https://play.example' });

  const good = connect(port, { origin: 'https://play.example' });
  await good.opened;
  good.send(JSON.stringify({ type: 'host' }));
  ok((await good.recv('hosting')).code.length === 8, 'a named origin hosts normally');

  const bad = connect(port, { origin: 'https://evil.example' });
  let refused = false;
  try { await bad.opened; } catch { refused = true; }
  ok(refused, 'an unnamed browser origin never completes the handshake');

  // A non-browser client sends no Origin at all. Refusing it would break the
  // desktop shell and every probe while stopping no attacker — anything that is
  // not a browser can put whatever it likes in the header.
  const headless = connect(port);
  await headless.opened;
  headless.send(JSON.stringify({ type: 'host' }));
  ok((await headless.recv('hosting')).code.length === 8, 'and a client with no Origin is still served');

  good.close(); headless.close(); server.kill();
}

console.log('T4 — a socket that sends past its allowance is refused, not obeyed');
{
  const { server, port } = await startRelay({ SIGNAL_MSG_BURST: '5', SIGNAL_MAX_MSGS_PER_SEC: '1' });
  const host = connect(port);
  await host.opened;
  // One frame mints the room; the rest of the burst is spent on well-formed
  // `join`s for rooms that do not exist, which the pre-Task-3 relay would answer
  // one-for-one for ever. That is the room-guessing oracle the bucket is here to
  // make expensive.
  host.send(JSON.stringify({ type: 'host' }));
  await host.recv('hosting');
  for (let i = 0; i < 40; i++) host.send(JSON.stringify({ type: 'join', code: 'ZZZZ2345' }));

  let errors = 0;
  const stop = Date.now() + 1500;
  while (Date.now() < stop) {
    try { await host.recv('error', 300); errors++; } catch { break; }
  }
  ok(errors > 0 && errors < 40,
     `only part of an over-budget flood is answered (got ${errors} of 40)`);

  host.close(); server.kill();
}

console.log('T4 — a socket error is counted, without the frame that caused it');
{
  const { server, port } = await startRelay();
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  await host.recv('hosting');
  host.send(JSON.stringify({ type: 'offer', clientId: 1, blob: 'z'.repeat(LIMITS.MAX_PAYLOAD_BYTES + 1024) }));
  await closed(host);
  await new Promise((r) => setTimeout(r, 300));

  const line = server.logs.find((l) => l.includes('"event":"socket-error"'));
  ok(!!line, `an absorbed socket error still leaves a trace (got ${JSON.stringify(server.logs)})`);
  ok(!!line && !line.includes('zzz'),
     `and the trace does not carry the frame that caused it (got ${line})`);

  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
