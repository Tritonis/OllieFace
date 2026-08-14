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

/** Spawn the relay on an ephemeral port; resolves with its port. */
function startRelay(env = {}) {
  const server = spawn(process.execPath, [join(here, '..', 'tools', 'signal-server.mjs'), '--port', '0'],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay never announced a port')), 5000);
    let buf = '';
    server.stdout.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/ws:\/\/0\.0\.0\.0:(\d+)/);
      if (m) { clearTimeout(t); resolve({ server, port: Number(m[1]) }); }
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
