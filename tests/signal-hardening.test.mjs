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
import { readFile } from 'node:fs/promises';
import net from 'node:net';
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

console.log('T1 — a keepalive is a bare fact, and carries nothing else');
{
  const bare = validate({ type: 'keepalive' });
  ok(bare.ok === true, 'a keepalive is a message this relay knows');
  const stuffed = validate({ type: 'keepalive', code: 'ABCD2345', blob: 'x'.repeat(4000) });
  ok(stuffed.ok === true && JSON.stringify(stuffed.msg) === '{"type":"keepalive"}',
     `and whatever a sender bolts onto one is dropped rather than sized (got ${JSON.stringify(stuffed.msg)})`);
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

console.log('T3 — the room code is one length, and every page-side copy of it says so');
{
  const { normalizeRoomCode, formatRoomCode } = await import('../src/net/Lobby.js');
  const { newCode } = await import('../tools/signal-server.mjs');

  // The page cannot import LIMITS — `tools/` is not part of the bundle — so the
  // length lives on both sides of the wire and nothing but this test holds the
  // two together. Every assertion below is driven from LIMITS.CODE_LEN or from a
  // code the relay actually minted, so moving either side fails here rather than
  // in a friend's hands.
  const minted = newCode();
  ok(minted.length === LIMITS.CODE_LEN, `the relay mints ${LIMITS.CODE_LEN} characters (got ${minted})`);
  ok(normalizeRoomCode(minted) === minted, 'and the page accepts what the relay mints');
  ok(normalizeRoomCode(minted.slice(1)) === '' && normalizeRoomCode(minted + minted[0]) === '',
     'one character either way is not a room code, so the page agrees on the length exactly');

  const half = LIMITS.CODE_LEN / 2;
  ok(formatRoomCode(minted) === `${minted.slice(0, half)}-${minted.slice(half)}`,
     `the spoken spelling is the code split down the middle (got ${formatRoomCode(minted)})`);

  const menus = await readFile(join(here, '..', 'src', 'ui', 'Menus.js'), 'utf8');
  const maxlen = Number(menus.match(/data-coop-roomcode maxlength="(\d+)"/)?.[1]);
  ok(maxlen === LIMITS.CODE_LEN + 1,
     `the room-code field takes the grouped code and no more (maxlength=${maxlen}, expected ${LIMITS.CODE_LEN + 1})`);
  const placeholder = menus.match(/const CODE_PLACEHOLDER = '(-+)'/)?.[1];
  ok(placeholder?.length === LIMITS.CODE_LEN + 1,
     `and the empty code box is exactly that wide (got ${placeholder?.length})`);
}

console.log('T3 — a host reads out the same code the screen is showing');
{
  const menus = await readFile(join(here, '..', 'src', 'ui', 'Menus.js'), 'utf8');
  // The braced form: `coopAction`'s handler, not the bare label in the
  // button-dispatch switch above it.
  const from = menus.indexOf("case 'coop-room-host': {");
  const block = menus.slice(from, menus.indexOf("case 'coop-room-join': {"));
  ok(from > 0 && block.length > 40, 'the co-op screen still has a create-room action');

  // The box beside the button showed XXXX-XXXX while the sentence under it
  // interpolated the same code ungrouped, so two hosts reading one screen said
  // two different things to their friend. One grouping, used twice.
  ok(!/slice\(/.test(block), `the action does not spell the code itself (got ${block})`);
  ok((block.match(/formatRoomCode\(/g) ?? []).length === 1,
     'it groups the code exactly once, so the box and the sentence cannot disagree');
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

console.log('T4 — a burst past the bucket is throttled, and the player is still there afterwards');
{
  // Shipped defaults on purpose (burst 120, 40/s): this is the case a real host
  // gathering against several interfaces reaches, and the measured trigger was
  // 140 candidates in one burst — 130 survived, 140 closed with 1008. A message
  // that arrives too fast is back-pressure, not garbage: it is already dropped
  // on the wire, and it must not also spend the disconnect budget that exists
  // for malformed input.
  const { server, port } = await startRelay();
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');

  for (let i = 0; i < 160; i++) {
    host.send(JSON.stringify({ type: 'ice', clientId: 1, candidate: { candidate: `a=${i}` } }));
    await new Promise((r) => setImmediate(r)); // real pacing, not one synchronous flush
  }
  await new Promise((r) => setTimeout(r, 300));
  ok(host.readyState === 1,
     `a 160-candidate burst does not close the socket (readyState ${host.readyState})`);

  // Open is not enough: the room it was mid-handshake in has to still work.
  const joiner = connect(port);
  await joiner.opened;
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const req = await host.recv('joinRequest', 2000).catch(() => null);
  ok(typeof req?.clientId === 'number',
     `and the room it was signalling for still takes a joiner (got ${JSON.stringify(req)})`);

  host.close(); joiner.close(); server.kill();
}

console.log('T4 — a stream of genuinely malformed frames still spends the disconnect budget');
{
  const { server, port } = await startRelay();
  const junk = connect(port);
  await junk.opened;
  // Twenty-five, well inside the burst, so not one of them is a rate drop —
  // every one of them is garbage, which is what MAX_REJECTS is for.
  for (let i = 0; i < 25; i++) {
    junk.send(JSON.stringify({ type: 'nonsense' }));
    await new Promise((r) => setImmediate(r));
  }
  const code = await Promise.race([closed(junk), new Promise((r) => setTimeout(() => r(0), 3000))]);
  ok(code === 1008, `junk frames still close the socket with 1008 (got ${code})`);
  server.kill();
}

console.log('T4 — a sustained flood still loses its socket, on its own budget');
{
  // Not the same budget as the junk above, and much larger in production — but a
  // socket that spends the whole drop allowance is flooding, not gathering, and
  // the relay stops reading it.
  const { server, port } = await startRelay({
    SIGNAL_MSG_BURST: '5', SIGNAL_MAX_MSGS_PER_SEC: '1', SIGNAL_MAX_RATE_DROPS: '10',
  });
  const flood = connect(port);
  await flood.opened;
  for (let i = 0; i < 60; i++) {
    flood.send(JSON.stringify({ type: 'join', code: 'ZZZZ2345' })); // well-formed, just far too many
    await new Promise((r) => setImmediate(r));
  }
  const code = await Promise.race([closed(flood), new Promise((r) => setTimeout(() => r(0), 3000))]);
  ok(code === 1008, `a socket past its drop allowance is closed with 1008 (got ${code})`);
  server.kill();
}

console.log('T4 — a room with live traffic outlives its TTL, and an abandoned one is still reclaimed');
{
  const { server, port } = await startRelay({ SIGNAL_ROOM_TTL_MS: '600' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  const joiner = connect(port);
  await joiner.opened;
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const req = await host.recv('joinRequest');

  // 1.65 s of real signalling against a 600 ms TTL. Age-based expiry sweeps this
  // room while its host and its player are both connected and talking through
  // it; the player-facing consequence is that the next friend to try the code is
  // told 'No such room', which is what a typo looks like.
  for (let i = 0; i < 11; i++) {
    host.send(JSON.stringify({ type: 'ice', clientId: req.clientId, candidate: { candidate: `a=${i}` } }));
    await new Promise((r) => setTimeout(r, 150));
  }
  const busy = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  ok(busy.rooms === 1, `a room carrying continuous signalling is not swept (got ${busy.rooms})`);

  const late = connect(port);
  await late.opened;
  late.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const lateReq = await host.recv('joinRequest', 2000).catch(() => null);
  ok(typeof lateReq?.clientId === 'number',
     `and a friend arriving after the old TTL still gets in (got ${JSON.stringify(lateReq)})`);

  // Now let it go quiet. The TTL still means something — it means abandoned —
  // and the host is the one person who could otherwise sit on a co-op screen
  // believing they are still hosting, so the host is told too.
  const told = host.recv('error', 4000).catch(() => null);
  const swept = await eventually(
    async () => (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).rooms === 0, 4000);
  ok(swept, 'a room nobody has touched for a whole TTL is still reclaimed');
  const notice = await told;
  ok(notice?.error === 'Room expired',
     `and its host is told, not only its clients (got ${JSON.stringify(notice)})`);

  host.close(); joiner.close(); late.close(); server.kill();
}

console.log('T4 — a quiet session keeps its room, because the host says it is still there');
{
  const { server, port } = await startRelay({ SIGNAL_ROOM_TTL_MS: '600' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');

  // The relay only ever sees a handshake. Once every peer is connected the game
  // runs peer-to-peer and this socket falls silent for the rest of the session,
  // so an idle TTL reclaims the room out from under a live game — and the friend
  // who tries the code at minute 90 is told 'No such room', which is exactly what
  // a typo looks like. 1.65 s of NOTHING BUT keepalive against a 600 ms TTL is
  // that two-hour session, in miniature.
  for (let i = 0; i < 11; i++) {
    host.send(JSON.stringify({ type: 'keepalive' }));
    await new Promise((r) => setTimeout(r, 150));
  }
  const still = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  ok(still.rooms === 1, `a room carrying only keepalives is not swept (got ${still.rooms})`);
  ok(host.queue.length === 0,
     `and the relay answers a keepalive with nothing at all (got ${JSON.stringify(host.queue)})`);

  const late = connect(port);
  await late.opened;
  late.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const req = await host.recv('joinRequest', 2000).catch(() => null);
  ok(typeof req?.clientId === 'number',
     `and the friend who arrives long after the TTL still gets in (got ${JSON.stringify(req)})`);

  host.close(); late.close(); server.kill();
}

console.log('T4 — a heartbeat is not activity');
{
  // The sweep pings every socket it finds and `ws` answers at the transport
  // layer without the application seeing anything. If liveness counted as
  // activity, an idle relay would never reclaim a single code.
  const { server, port } = await startRelay({ SIGNAL_ROOM_TTL_MS: '600', SIGNAL_HEARTBEAT_MS: '100' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  await host.recv('hosting');
  const gone = await eventually(
    async () => (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).rooms === 0, 4000);
  ok(gone, 'a room held open by nothing but pings still expires');
  host.close(); server.kill();
}

console.log('T4 — a socket already in a full room is not turned away from the room it is in');
{
  const { server, port } = await startRelay({ SIGNAL_MAX_CLIENTS_PER_ROOM: '1' });
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  const joiner = connect(port);
  await joiner.opened;
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  await host.recv('joinRequest');

  // The room is now exactly at capacity and the only member re-sends its join.
  // Admitting it changes no membership at all; refusing it says 'Room is full'
  // to the socket occupying the seat.
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const outcome = await Promise.race([
    host.recv('joinRequest', 2000).then(() => 'joinRequest').catch(() => 'nothing'),
    joiner.recv('error', 2000).then((e) => e.error).catch(() => 'nothing'),
  ]);
  ok(outcome === 'joinRequest', `a member re-joining the room it holds is admitted (got ${outcome})`);

  host.close(); joiner.close(); server.kill();
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

console.log('T4 — a socket that has stopped reading is dropped, not buffered for');
{
  // The defect no unit test on a mock can see. `send` used to consult nothing
  // but `readyState`, so a peer that stops reading its TCP socket turns the
  // relay's heap into that peer's receive buffer: measured out of process
  // against this relay at shipped defaults, 12 sockets from ONE address inside
  // every declared ceiling grew it by 257 MB in 24 s with `rejectedTotal` at 0
  // and all 12 still open. The ceiling below is per-socket and the sender of
  // the traffic is never the socket that pays for it — which is why the
  // message-per-second bucket, which is charged to the sender, could not see it.
  //
  // The SENDER's rate ceiling is raised here and nothing else is: the defect is
  // on the recipient's side of the relay, and at 40 msg/s it takes half a minute
  // of real time to push enough bytes past the operating system's own socket
  // buffers to see it. The out-of-process measurement above was taken at the
  // shipped rate; this asserts the ceiling, quickly.
  const { server, port } = await startRelay({
    SIGNAL_MAX_BUFFERED_BYTES: String(64 * 1024),
    SIGNAL_MAX_MSGS_PER_SEC: '600', SIGNAL_MSG_BURST: '600',
  });
  const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  const host = connect(port); await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  const joiner = connect(port); await joiner.opened;
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const req = await host.recv('joinRequest');

  joiner._socket.pause(); // stop reading, and never start again
  const blob = 'z'.repeat(LIMITS.MAX_BLOB_CHARS);
  for (let i = 0; i < 400; i++) { // 12.8 MB, far past any kernel buffer in the way
    host.send(JSON.stringify({ type: 'offer', clientId: req.clientId, blob }));
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 10));
  }

  const dropped = await eventually(async () => (await health()).conns === 1, 4000);
  ok(dropped, `the relay lets go of a socket it cannot write to (conns=${(await health()).conns}, expected 1)`);
  const h = await health();
  ok(h.stalledTotal >= 1, `and counts having done so (stalledTotal=${h.stalledTotal})`);
  ok(host.readyState === 1,
     `while the socket that was reading normally is untouched (readyState ${host.readyState})`);

  try { joiner._socket.resume(); } catch { /* already gone, which is the point */ }
  joiner.terminate(); host.close(); server.kill();
}

console.log('T4 — only a host may offer, and only a joiner may answer');
{
  const { server, port } = await startRelay();
  const host = connect(port); await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  const a = connect(port); await a.opened;
  a.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const reqA = await host.recv('joinRequest');
  const b = connect(port); await b.opened;
  b.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const reqB = await host.recv('joinRequest');

  // The handshake the roles exist for runs first, in both directions, because a
  // `recv` that times out leaves its waiter behind and would swallow the next
  // message of that type on the same socket.
  host.send(JSON.stringify({ type: 'offer', clientId: reqB.clientId, blob: 'v=0 real', trickle: true }));
  const real = await b.recv('offer', 2000).catch(() => null);
  ok(real?.blob === 'v=0 real' && real.trickle === true,
     `the host's own offer still reaches its joiner, trickle flag and all (got ${JSON.stringify(real)})`);
  b.send(JSON.stringify({ type: 'answer', blob: 'v=0 back' }));
  const back = await host.recv('answer', 2000).catch(() => null);
  ok(back?.blob === 'v=0 back' && back.clientId === reqB.clientId,
     `and the joiner's answer still reaches the host, stamped with which joiner (got ${JSON.stringify(back)})`);

  // `b` is a joiner, and a joiner's `joinViaRelay` treats EVERY offer it
  // receives as the host's. So an offer `b` addresses at `a` is not a stray
  // message: it is `a`'s WebRTC connection, captured by whoever else holds the
  // room code. Anyone invited into a room can do this to anyone else in it.
  b.send(JSON.stringify({ type: 'offer', clientId: reqA.clientId, blob: 'v=0 impostor' }));
  const impostor = await a.recv('offer', 800).catch(() => null);
  ok(impostor === null, `a joiner's offer to another joiner is not forwarded (got ${JSON.stringify(impostor)})`);

  host.send(JSON.stringify({ type: 'answer', blob: 'v=0 impostor' }));
  const selfAnswer = await host.recv('answer', 800).catch(() => null);
  ok(selfAnswer === null, `nor a host's answer into its own room (got ${JSON.stringify(selfAnswer)})`);

  host.close(); a.close(); b.close(); server.kill();
}

console.log('T4 — a socket refused a room is not left pointing at the one it left on the way');
{
  const { server, port } = await startRelay({ SIGNAL_MAX_ROOMS: '1' });
  const host = connect(port); await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  const ghost = connect(port); await ghost.opened;
  ghost.send(JSON.stringify({ type: 'join', code: hosting.code }));
  await host.recv('joinRequest');

  // `host` runs `leaveCurrentRoom` BEFORE the room cap, so this socket gives up
  // its membership and is then refused a room of its own. It is now a member of
  // nothing — and it must not still be holding the code and the role of the room
  // it walked out of, because that is a pointer at somebody else's room.
  ghost.send(JSON.stringify({ type: 'host' }));
  const full = await ghost.recv('error');
  ok(full.error === 'Relay is full', `the room past the cap is refused (got ${full.error})`);

  ghost.send(JSON.stringify({ type: 'answer', blob: 'v=0 ghost' }));
  const leaked = await host.recv('answer', 800).catch(() => null);
  ok(leaked === null,
     `and the socket that left cannot still speak into that room (got ${JSON.stringify(leaked)})`);

  host.close(); ghost.close(); server.kill();
}

console.log('T4 — a whole IPv6 /64 is one address, because that is what one household is');
{
  const { ipBucketKey } = await import('../tools/signal-server.mjs');
  // A residential IPv6 allocation is a /64 or larger. Keyed on the exact
  // address, MAX_CONNS_PER_IP is 2^64 buckets wide for one attacker, at no cost
  // and with no spoofing — and MAX_ROOMS and the buffered-bytes ceiling are only
  // as strong as the connection cap underneath them.
  ok(ipBucketKey('2001:db8:1:2:3:4:5:6') === ipBucketKey('2001:db8:1:2:ffff:ffff:ffff:ffff'),
     'two addresses inside one /64 share one bucket');
  ok(ipBucketKey('2001:db8:1:2::1') === ipBucketKey('2001:DB8:1:2::9'),
     'however either of them is spelled');
  ok(ipBucketKey('2001:db8:1:2::1') !== ipBucketKey('2001:db8:1:3::1'),
     'and two different /64s are two different buckets');
  // The trap in the other direction, and it is the expensive one: every
  // IPv4-mapped address (`::ffff:a.b.c.d`) shares the same all-zero /64, so
  // truncating one would put every IPv4 player on a dual-stack listener into a
  // single 12-connection bucket — the whole service, not the household.
  ok(ipBucketKey('::ffff:203.0.113.9') !== ipBucketKey('::ffff:203.0.113.10'),
     'while two IPv4-mapped addresses are still two addresses');
  ok(ipBucketKey('203.0.113.9') === '203.0.113.9', 'and a plain IPv4 address is itself');

  const relay = await startRelay({ SIGNAL_MAX_CONNS_PER_IP: '2', SIGNAL_TRUST_PROXY: '1' });
  const mk = (xff) => connect(relay.port, { headers: { 'x-forwarded-for': xff } });
  const c1 = mk('2001:db8:abcd:1234::1'); await c1.opened;
  const c2 = mk('2001:db8:abcd:1234::2'); await c2.opened;
  const c3 = mk('2001:db8:abcd:1234:ffff:ffff:ffff:ffff');
  let capped = false;
  try { await c3.opened; } catch { capped = true; }
  ok(capped, 'a third address out of the same /64 is refused like a third connection from one address');
  const elsewhere = mk('2001:db8:abcd:9999::1');
  let wrongly = false;
  try { await elsewhere.opened; } catch { wrongly = true; }
  ok(!wrongly, 'while a different /64 still has its own allowance');

  c1.close(); c2.close(); elsewhere.close(); relay.server.kill();
}

/* ==========================================================================
 * 5 — observability that leaks nothing
 * ======================================================================= */

/** The health document, parsed. */
const healthOf = (port) => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());

/** Poll until `fn()` is true, or give up — a close is processed asynchronously. */
async function eventually(fn, ms = 2000) {
  const stop = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > stop) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

console.log('T5 — /healthz reports load without naming a single room');
{
  const { server, port } = await startRelay();
  const host = connect(port);
  await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');

  const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
  const h = JSON.parse(body);
  ok(h.ok === true, 'it still answers the platform health check');
  ok(h.rooms === 1 && typeof h.conns === 'number', `it reports rooms and connections (got ${body})`);
  ok(typeof h.rejectedTotal === 'number' && typeof h.uptimeMs === 'number', 'and refusals and uptime');
  ok(!body.includes(hosting.code), 'and no room code appears anywhere in it');

  // This endpoint is unauthenticated — a platform health check cannot carry a
  // credential — so what it may contain is a security question, not a
  // formatting one. A count describes load; anything else (a code, an address,
  // a client id) names somebody. Asserting the *shape* rather than the current
  // field list is what keeps the next field added here honest.
  ok(Object.values(h).every((v) => typeof v === 'number' || typeof v === 'boolean'),
     `every field is a count or a flag, so nothing in it can identify anyone (got ${body})`);
  ok(!/\d{1,3}(\.\d{1,3}){3}/.test(body) && !body.includes('::1'),
     `and no address of anyone connected to it (got ${body})`);

  host.close(); server.kill();
}

console.log('T5 — "how many now" and "how many since start" are two quantities with two names');
{
  const { server, port } = await startRelay();
  const host = connect(port); await host.opened;
  const other = connect(port); await other.opened;
  host.send(JSON.stringify({ type: 'host' }));
  await host.recv('hosting');

  const live = await healthOf(port);
  ok(live.conns === 2 && live.rooms === 1, `two sockets and one room are open (got ${JSON.stringify(live)})`);
  ok(live.connsTotal === 2 && live.roomsTotal === 1, 'and the same counts have accrued since start');

  other.close(); host.close();
  const emptied = await eventually(async () => {
    const h = await healthOf(port);
    return h.conns === 0 && h.rooms === 0;
  });
  ok(emptied, 'when everyone goes, the live counts fall to nothing');

  // The failure this guards against is nobody's bug and everybody's 3am
  // misreading: a dashboard that plots `conns` as a total, or `connsTotal` as
  // current load, is wrong in a direction that looks plausible. The names have
  // to make the two impossible to confuse from the field alone.
  const after = await healthOf(port);
  ok(after.connsTotal === 2 && after.roomsTotal === 1,
     `while the lifetime totals do not move (got ${JSON.stringify(after)})`);

  server.kill();
}

console.log('T5 — a refused connection is always counted and only sometimes written down');
{
  const { server, port } = await startRelay({ SIGNAL_MAX_CONNS_PER_IP: '1' });
  const held = connect(port);
  await held.opened;

  // Every one of these is refused at the handshake, and every one of them used
  // to write a log line naming an address. One attacker therefore chose how
  // much this relay wrote to disk — an unbounded write amplification bought
  // with a TCP connection each.
  const FLOOD = 30;
  for (let i = 0; i < FLOOD; i++) {
    const s = connect(port);
    try { await s.opened; } catch { /* refused, which is the point */ }
  }

  const h = await healthOf(port);
  ok(h.refusedTotal === FLOOD, `every refusal is counted (got ${h.refusedTotal} of ${FLOOD})`);

  await new Promise((r) => setTimeout(r, 200));
  const written = server.logs.filter((l) => l.includes('"event":"refused"'));
  ok(written.length > 0, 'an operator can still see that refusals are happening');
  ok(written.length < FLOOD,
     `but the sender does not choose how much the relay writes (got ${written.length} lines for ${FLOOD} refusals)`);

  held.close(); server.kill();
}

console.log('T5 — nor how long a line is');
{
  const { server, port } = await startRelay({ SIGNAL_ALLOWED_ORIGINS: 'https://play.example' });
  const bad = connect(port, { origin: `https://evil.example/${'a'.repeat(4000)}` });
  try { await bad.opened; } catch { /* refused, which is the point */ }
  await new Promise((r) => setTimeout(r, 200));

  const line = server.logs.find((l) => l.includes('"event":"refused"'));
  ok(!!line, `the refusal is logged (got ${JSON.stringify(server.logs)})`);
  ok(!!line && line.length < 400,
     `and a 4 KB Origin header does not become a 4 KB log line (got ${line?.length} chars)`);

  server.kill();
}

console.log('T5 — the volume of a sampled event is still exact, because the counter is not sampled');
{
  const { server, port } = await startRelay();
  for (let i = 0; i < 3; i++) {
    const s = connect(port);
    await s.opened;
    s.send(JSON.stringify({ type: 'offer', clientId: 1, blob: 'z'.repeat(LIMITS.MAX_PAYLOAD_BYTES + 1024) }));
    await closed(s);
  }
  const counted = await eventually(async () => (await healthOf(port)).errorsTotal === 3);
  ok(counted, `all three absorbed socket errors are counted (got ${(await healthOf(port)).errorsTotal} of 3)`);
  server.kill();
}

console.log('T5 — the startup line four spawners parse for a port is still there, beside the JSON one');
{
  const { server, port } = await startRelay();
  await new Promise((r) => setTimeout(r, 200));
  ok(server.logs.some((l) => l.includes(`signalling on ws://0.0.0.0:${port} (health: /healthz)`)),
     `the human line survives verbatim (got ${JSON.stringify(server.logs)})`);
  const listening = server.logs.find((l) => l.includes('"event":"listening"'));
  ok(!!listening && JSON.parse(listening).port === port, 'and a structured one says the same thing');
  // Nothing sets SIGNAL_ALLOWED_ORIGINS here, which is right for a laptop and
  // wrong for a public deployment. Saying so at startup is the only moment an
  // operator is reliably looking.
  ok(server.logs.some((l) => l.includes('SIGNAL_ALLOWED_ORIGINS')),
     'and an unset origin allowlist is announced as the open door it is');
  server.kill();
}

console.log('T5 — a log line never carries a code, a blob or a candidate');
{
  const { log } = await import('../tools/signal-server.mjs');
  const lines = [];
  const real = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    log('room-expired', { code: 'ABCD2345', ageMs: 10 });
    log('refused', { reason: 'origin', origin: 'https://evil.example' });
  } finally { console.log = real; }

  ok(lines.length === 2, `both lines were written (got ${lines.length})`);
  const parsed = lines.map((l) => JSON.parse(l));
  ok(parsed.every((p) => typeof p.at === 'string' && typeof p.event === 'string'),
     'each is one JSON object with a timestamp and an event');
  ok(!lines.join(' ').includes('ABCD2345'),
     'a room code handed to the logger is redacted, not printed');
  ok(parsed[0].code === '[code]', `and is replaced by a marker (got ${parsed[0].code})`);
  ok(parsed[1].origin === 'https://evil.example', 'while a non-secret field is kept, because it is the point of the line');
}

console.log('T5 — a room TTL below the beat that renews it is announced as the regression it is');
{
  // The page renews a live session's room every 5 minutes and nothing else does.
  // Any TTL under that reintroduces, in full, the defect the keepalive exists to
  // close — a live room reclaimed under a live game — and the setting reads as
  // freely tunable. An operator is reliably looking exactly once: at startup.
  const { server, port } = await startRelay({ SIGNAL_ROOM_TTL_MS: '600' });
  await new Promise((r) => setTimeout(r, 250));
  const warn = server.logs.find((l) => l.includes('"setting":"SIGNAL_ROOM_TTL_MS"'));
  ok(!!warn, `a TTL under the floor is announced at startup (got ${JSON.stringify(server.logs)})`);
  ok(!!warn && warn.includes('"event":"config-warning"'),
     `as a config-warning, structured, so an aggregator keeps it (got ${warn})`);
  ok(!!warn && /keepalive/i.test(warn), `and it names the beat it is under (got ${warn})`);
  server.kill();

  const quiet = await startRelay({ SIGNAL_ROOM_TTL_MS: String(30 * 60 * 1000) });
  await new Promise((r) => setTimeout(r, 250));
  ok(!quiet.server.logs.some((l) => l.includes('"setting":"SIGNAL_ROOM_TTL_MS"')),
     `and a TTL above it says nothing (got ${JSON.stringify(quiet.server.logs)})`);
  quiet.server.kill();
}

/* ==========================================================================
 * 6 — the surface below the protocol
 *
 * Everything above this point is about sockets that completed a WebSocket
 * handshake, which is where every ceiling in this relay used to begin. An
 * attacker does not have to get that far to cost the process a file descriptor.
 * ======================================================================= */

/** A raw TCP socket to the relay. No HTTP, no upgrade — just an accepted connection. */
function rawSocket(port) {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => {}); // a refused or destroyed socket is the expected outcome here
  // Flowing, or this end never reads the 408 the relay sends before hanging up
  // and so never emits 'close' — the socket would look held open when it is the
  // test that is not looking.
  s.resume();
  return s;
}

console.log('T6 — a request that never finishes is not held open for a minute');
{
  const { server, port } = await startRelay({ SIGNAL_HEADERS_TIMEOUT_MS: '600' });
  const s = rawSocket(port);
  await new Promise((r) => s.on('connect', r));
  // Headers deliberately unterminated: no blank line, so this request is never
  // complete. Node's default holds it for 60 s, which is 60 s of a file
  // descriptor bought with one packet.
  s.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
  const at = Date.now();
  const shut = await Promise.race([
    new Promise((r) => s.on('close', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  ok(shut, `an unfinished request is dropped rather than held (waited ${Date.now() - at} ms)`);
  server.kill();
}

console.log('T6 — one address cannot hold more raw sockets than the relay declared');
{
  // Measured before this ceiling existed: 200 raw sockets accepted from one
  // address against a per-IP WebSocket cap of 2, because that cap is only
  // charged on a COMPLETED upgrade. Nothing below the upgrade was counted at all.
  const { server, port } = await startRelay({ SIGNAL_MAX_SOCKETS: '8', SIGNAL_MAX_CONNS_PER_IP: '2' });
  const socks = [];
  for (let i = 0; i < 60; i++) socks.push(rawSocket(port));
  await new Promise((r) => setTimeout(r, 800));
  const alive = socks.filter((s) => !s.destroyed).length;
  ok(alive <= 8, `60 raw sockets from one address leave at most the declared 8 (got ${alive})`);
  ok(alive > 0, 'and the cap is a cap, not a closed door');
  for (const s of socks) s.destroy();
  server.kill();
}

console.log('T6 — the request timeouts do not evict a player who is merely quiet');
{
  // A guard on the fix above rather than on a defect: `headersTimeout` and
  // `requestTimeout` are properties of the HTTP server that the WebSocket
  // upgrade was born from, and a signalling socket is silent for the whole game
  // once the peers are connected. If either timeout survived the upgrade, every
  // co-op session would die on the clock — so this asserts the thing that would
  // be broken, at timeouts short enough to prove it inside a test.
  const { server, port } = await startRelay({
    SIGNAL_HEADERS_TIMEOUT_MS: '400', SIGNAL_REQUEST_TIMEOUT_MS: '700', SIGNAL_ROOM_TTL_MS: '600000',
  });
  const host = connect(port); await host.opened;
  host.send(JSON.stringify({ type: 'host' }));
  const hosting = await host.recv('hosting');
  await new Promise((r) => setTimeout(r, 2000)); // several timeouts' worth of silence
  ok(host.readyState === 1,
     `an upgraded socket outlives the HTTP request timeouts (readyState ${host.readyState})`);
  const joiner = connect(port); await joiner.opened;
  joiner.send(JSON.stringify({ type: 'join', code: hosting.code }));
  const req = await host.recv('joinRequest', 2000).catch(() => null);
  ok(typeof req?.clientId === 'number',
     `and is still signalling for its room afterwards (got ${JSON.stringify(req)})`);
  host.close(); joiner.close(); server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
