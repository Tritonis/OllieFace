# Relay and TURN Credential Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the signalling relay safe to expose on the public internet, and stop TURN credentials from being persisted or leaked by the page.

**Architecture:** All relay hardening lands inside the single file `tools/signal-server.mjs` — schema/size validation, a token-bucket rate limiter, per-IP connection caps, room caps and TTL, heartbeat eviction, an optional Origin allowlist, crypto-random 8-character room codes, and structured logging. The file gains a run-directly guard so tests can import its policy helpers without starting a listener. The page side changes only where the code length or credential persistence is visible: `src/net/NetConfig.js`, `src/net/Lobby.js`, `src/ui/Menus.js`, `tools/coopprobe.mjs`.

**Tech Stack:** Node 20+ ESM, `ws` 8.x (already a runtime dependency), `node:crypto`, the repo's framework-free test idiom (`tests/*.test.mjs`, plain `ok()` assertions, run by `node tests/run.mjs`).

## Global Constraints

- **Single-file rule.** Every relay change goes in `tools/signal-server.mjs`. Do NOT create a new module under `tools/`. Reason: the parked branch `slice/mp-p4-remote-network` carries `deploy/signal/Dockerfile`, a crate that copies an explicit file list; a new file would be silently absent from the deployed image.
- **No new dependencies.** `ws` and `node:crypto` only.
- **The relay must stay dumb about content.** It never inspects inside an SDP blob or an ICE candidate beyond measuring its size. It is not a game server.
- **Backward degrade must stay intact.** `PROTOCOL_VERSION` (the RELAY version, currently `2`, distinct from the game's `PROTOCOL_VERSION = 7` in `src/net/Protocol.js`) stays at `2`. None of this changes the wire vocabulary, so no version bump is warranted. `src/net/Lobby.js:35` tests `v >= RELAY_TRICKLE_VERSION` as a floor — do not touch it.
- **Do not break the parked P4 slice.** `?turn=`, `?turnuser=`, `?turnpass=` query parameters MUST keep working: `tools/coopprobe.mjs` passes real Metered credentials that way in P4 Task 5, and the handoff makes that the *required* path (build-env credentials are invisible to the probe's redactor). This slice removes credential **persistence**, not credential **query support**.
- **Defaults must not break local development.** With no `SIGNAL_*` environment variable set, `npm run signal`, `npm run probe:coop`, `tests/trickle-ice.test.mjs` and `tools/verify-trickle.mjs` must all pass unchanged apart from the room-code length.
- **Room code length is 8**, drawn from the existing unambiguous alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I/O/0/1). Displayed and accepted as `XXXX-XXXX`; the separator is cosmetic and stripped on input.
- Commit style: one evocative sentence, plus the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Never `git push`, never `git pull`.
- Run the full suite with `npm test` at the end of each task. It must stay green (57/57 files before this slice; 59/59 after, with the two new files).

## File Structure

| File | Responsibility after this slice |
|---|---|
| `tools/signal-server.mjs` | The relay, plus its exported policy helpers (`newCode`, `normalizeCode`, `validate`, `TokenBucket`, `LIMITS`). Gains a run-directly guard. |
| `tests/signal-hardening.test.mjs` | **New.** Policy unit tests plus live-relay integration tests (spawns the real server on `--port 0`). |
| `tests/net-config-secrets.test.mjs` | **New.** Pins that TURN credentials never reach `localStorage` and that previously stored ones are purged. |
| `src/net/NetConfig.js` | Adds a per-setting `persist` policy; credentials become session-only. |
| `src/net/Lobby.js` | Normalises a typed room code before it goes on the wire. |
| `src/ui/Menus.js` | Room-code input accepts the longer, grouped code; hint copy stops saying "four letters". |
| `tools/coopprobe.mjs` | Room-code regex matches the new length. |
| `tests/trickle-ice.test.mjs` | One length assertion updated (`:464`). |
| `docs/MULTIPLAYER.md`, `.env.example` | Document the relay's environment knobs and the credential-handling rule. |

---

### Task 1: Message discipline — schema, size caps, and a run-directly guard

The relay currently `JSON.parse`s anything, forwards `msg.blob` and `msg.candidate` untouched at any size, and has no upper bound on a frame. This task makes every message prove itself before it is acted on, and makes the module importable so later tasks can unit-test policy.

**Files:**
- Modify: `tools/signal-server.mjs:50-164`
- Test: `tests/signal-hardening.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all named exports from `tools/signal-server.mjs`:
  - `export const LIMITS` — a frozen object of numeric policy values; Tasks 2–4 add keys to it.
  - `export function validate(msg)` → `{ ok: true, msg }` on success, `{ ok: false, reason: string }` on rejection. `reason` is a short stable slug — the full set is `'not-object'`, `'bad-type'`, `'bad-code'`, `'bad-blob'`, `'blob-too-big'`, `'bad-candidate'`, `'candidate-too-big'`, `'bad-client-id'`.
  - `export function normalizeCode(raw)` → uppercase A–Z/2–9 string with every other character stripped, or `''`.

- [ ] **Step 1: Write the failing test**

Create `tests/signal-hardening.test.mjs`:

```js
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
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node tests/signal-hardening.test.mjs`
Expected: FAIL — the import throws `SyntaxError: The requested module '../tools/signal-server.mjs' does not provide an export named 'LIMITS'`. (That is an ESM *link* error, so it precedes module evaluation and no port is bound either way. The guard in Step 3 is still required: once the exports exist, evaluation runs and today's top-level `http.listen` would seize port 8787 on every import.)

- [ ] **Step 3: Add the run-directly guard so the module can be imported**

In `tools/signal-server.mjs`, replace the top-of-file argv/port/listen wiring. The current lines 50-56 and 64-78 become:

```js
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Imported for its policy helpers (tests/signal-hardening.test.mjs) rather than
// run as a process, this file must not seize a port. Everything below the guard
// at the bottom is startup; everything above it is policy and is safe to import.
const RUN_DIRECTLY = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
```

and the server construction moves into an exported `start()` at the point where `createServer` used to sit:

```js
export function start({ port = defaultPort() } = {}) {
  const http = createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health()));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, maxPayload: LIMITS.MAX_PAYLOAD_BYTES });
  // `http.address().port` rather than `port`: `--port 0` asks the OS for a free
  // one, which is how a test or a local driver runs a relay without colliding
  // with whatever is already on 8787 — and the number it got is only knowable
  // here.
  http.listen(port, () => console.log(`signalling on ws://0.0.0.0:${http.address().port} (health: /healthz)`));
  wss.on('connection', onConnection);
  return { http, wss };
}

function defaultPort() {
  const argPort = process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1]
    : null;
  return Number(argPort ?? process.env.PORT ?? 8787);
}

/** What `/healthz` answers. Task 4 widens this. */
function health() { return { ok: true, rooms: rooms.size }; }
```

The existing `wss.on('connection', (ws) => { ... })` body becomes a named `function onConnection(ws) { ... }` declaration, unchanged for now apart from the name. At the very bottom of the file:

```js
if (RUN_DIRECTLY) start();
```

- [ ] **Step 4: Add `LIMITS`, `normalizeCode` and `validate`**

Insert above `onConnection` in `tools/signal-server.mjs`:

```js
/**
 * Every ceiling this relay enforces, in one object so a deployment can see the
 * whole policy at once and a test can assert against the same numbers the
 * server uses rather than a copy of them.
 *
 * The sizes are generous on purpose. An SDP offer carrying a dozen candidates
 * is a few kilobytes; 32 KiB is roughly an order of magnitude of headroom, and
 * the 64 KiB frame ceiling above it is what `ws` enforces for us before a byte
 * is ever buffered into this process.
 */
export const LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES: 64 * 1024,
  MAX_BLOB_CHARS: 32 * 1024,
  MAX_CANDIDATE_CHARS: 1024,
  CODE_LEN: 8,
});

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — misread over voice
const CODE_RE = new RegExp(`^[${ALPHABET}]{${LIMITS.CODE_LEN}}$`);

/**
 * Anything a human might have typed, reduced to the one spelling the room map
 * is keyed by. Total by construction: a non-string, a null, or a line of
 * punctuation all come back as the empty string, which no room is ever keyed
 * by, so a bad code fails the lookup instead of finding something.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const up = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(up) ? up : '';
}

/** The size of a value as it would sit on the wire, without re-serialising it twice. */
function jsonSize(v) {
  if (typeof v === 'string') return v.length;
  try { return JSON.stringify(v)?.length ?? 0; } catch { return Infinity; }
}

/**
 * The whole message schema, in one place.
 *
 * The relay stays dumb about *content* — it never looks inside an SDP or a
 * candidate — but it is no longer dumb about *shape*. A message that is not one
 * of the six known types, or whose fields are the wrong kind or too large, is
 * refused with a stable slug the caller logs and counts. Refusing before the
 * switch is what keeps every later handler able to assume its fields exist.
 */
export function validate(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, reason: 'not-object' };
  const bad = (reason) => ({ ok: false, reason });

  switch (msg.type) {
    case 'host':
      // Any `code` a client offers is dropped on the floor here rather than
      // honoured: letting a joiner name the room it is about to host is how an
      // attacker squats on a code a friend is still typing.
      return { ok: true, msg: { type: 'host' } };

    case 'join': {
      const code = normalizeCode(msg.code);
      return code ? { ok: true, msg: { type: 'join', code } } : bad('bad-code');
    }

    case 'offer': {
      if (!Number.isInteger(msg.clientId)) return bad('bad-client-id');
      if (typeof msg.blob !== 'string') return bad('bad-blob');
      if (msg.blob.length > LIMITS.MAX_BLOB_CHARS) return bad('blob-too-big');
      return { ok: true, msg: { type: 'offer', clientId: msg.clientId, blob: msg.blob, trickle: !!msg.trickle } };
    }

    case 'answer': {
      if (typeof msg.blob !== 'string') return bad('bad-blob');
      if (msg.blob.length > LIMITS.MAX_BLOB_CHARS) return bad('blob-too-big');
      return { ok: true, msg: { type: 'answer', blob: msg.blob } };
    }

    case 'ice': {
      if (msg.clientId !== undefined && !Number.isInteger(msg.clientId)) return bad('bad-client-id');
      if (!msg.candidate || typeof msg.candidate !== 'object') return bad('bad-candidate');
      if (jsonSize(msg.candidate) > LIMITS.MAX_CANDIDATE_CHARS) return bad('candidate-too-big');
      return { ok: true, msg: { type: 'ice', clientId: msg.clientId, candidate: msg.candidate } };
    }

    default:
      return bad('bad-type');
  }
}
```

Replace the old `ALPHABET`/`newCode` block at the bottom (lines 156-164) with the crypto version — `Math.random` is not a source a room code may come from:

```js
let idSeq = 0;

/**
 * A room code no one can predict.
 *
 * `Math.random` is seeded per process and its output is recoverable from a
 * handful of samples, which for a relay that hands rooms out on request means a
 * caller can compute the next code a stranger is about to be given. `randomInt`
 * is the CSPRNG, and its bounded form is rejection-sampled, so the alphabet
 * stays uniform even though 32 does not divide the generator's range evenly.
 */
export function newCode() {
  let c;
  do {
    c = Array.from({ length: LIMITS.CODE_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  } while (rooms.has(c));
  return c;
}
```

- [ ] **Step 5: Route every inbound message through `validate`**

In `onConnection`, replace the message handler's preamble and the `host`/`join` cases:

```js
  ws.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return reject(ws, 'bad-json'); }

    const v = validate(parsed);
    if (!v.ok) return reject(ws, v.reason);
    const msg = v.msg;

    switch (msg.type) {
      case 'host': {
        const code = newCode();
        rooms.set(code, { host: ws, clients: new Set(), created: Date.now() });
        ws.room = code; ws.role = 'host';
        send(ws, { type: 'hosting', code, v: PROTOCOL_VERSION });
        break;
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) return send(ws, { type: 'error', error: 'No such room' });
        room.clients.add(ws);
        ws.room = msg.code; ws.role = 'client';
        // Ask the host to mint an invite for this specific joiner.
        send(room.host, { type: 'joinRequest', clientId: (ws.id = ++idSeq) });
        break;
      }
```

The `offer`, `answer` and `ice` cases keep their existing bodies and comments verbatim — they now read fields `validate` has already proven. Add the rejection counter above `onConnection`:

```js
/**
 * A refused message, counted.
 *
 * One malformed frame is a version skew or a fat-fingered `wscat`, and is not
 * worth a disconnect. A stream of them is someone probing, and the cheapest
 * answer is to stop reading. 1008 is "policy violation", which is exactly what
 * this is.
 */
const MAX_REJECTS = 20;
function reject(ws, reason) {
  ws.rejects = (ws.rejects ?? 0) + 1;
  if (ws.rejects >= MAX_REJECTS) ws.close(1008, 'too many invalid messages');
}
```

- [ ] **Step 6: Follow the minted length into the one existing test that asserts it**

The relay now mints 8 characters, so `tests/trickle-ice.test.mjs:464` is wrong the moment Step 4 lands. It travels with the commit that changed the minting, not with Task 2 — every task ends green. Change:

```js
    ok(rehost.code.length === 4, 'the relay is still answering after all of that');
```

to

```js
    ok(rehost.code.length === 8, 'the relay is still answering after all of that');
```

- [ ] **Step 7: Run the new test and the suite**

Run: `node tests/signal-hardening.test.mjs`
Expected: PASS on every line, `0 failed`.

Run: `npm test`
Expected: 58/58 test files pass — green, with no exceptions. If any file fails, stop and report.

- [ ] **Step 8: Commit**

```bash
git add tools/signal-server.mjs tests/signal-hardening.test.mjs tests/trickle-ice.test.mjs
git commit -m "The relay stops believing whatever it is told, and mints a code no one can predict"
```

---

### Task 2: The room code grows, everywhere it is known

Task 1 made the server mint 8 characters. Three other places still assume 4, and one of them (`tools/coopprobe.mjs`) fails as a timeout with a misleading message rather than an assertion. This task closes the length surface in one sweep so no consumer is left disagreeing with the server.

**Files:**
- Modify: `tools/coopprobe.mjs:108` (comment) and `:1083` (regex)
- Modify: `src/ui/Menus.js:426-437`, `:1514-1515`, `:1519`, `:1538`
- Modify: `src/ui/hud.css:2172-2173`
- Modify: `src/net/Lobby.js:35` (new export) and `:292-297`
- Modify: `docs/MULTIPLAYER.md:160-162`
- Test: `tests/signal-hardening.test.mjs` (append)

**Interfaces:**
- Consumes: `normalizeCode` from Task 1 — but the page must NOT import from `tools/`, so `Lobby.js` carries its own three-line normaliser. The two are kept honest by the test in Step 1, which asserts they agree.
- Produces: the room code display format `XXXX-XXXX`.

- [ ] **Step 1: Write the failing test**

Append to `tests/signal-hardening.test.mjs`, before the final `console.log` summary:

```js
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
```

Note the test never opens a socket: the guard must reject *before* `new WebSocket(url)`, which is also what makes this assertion meaningful.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node tests/signal-hardening.test.mjs`
Expected: FAIL — `normalizeRoomCode is not a function` (it does not exist yet).

- [ ] **Step 3: Export the normaliser from `Lobby.js` and use it on join**

In `src/net/Lobby.js`, add near the top-level constants (beside `RELAY_TRICKLE_VERSION` at `:35`):

```js
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
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(up) ? up : '';
}
```

and change `joinViaRelay` (`:292-297`) so a code that cannot be real never reaches the wire:

```js
  joinViaRelay(code, url = signalUrl()) {
    const norm = normalizeRoomCode(code);
    // The relay refuses a malformed code by dropping it, silently and by
    // design — a hardened relay does not narrate its own validation to whoever
    // is probing it. Nothing below settles this promise on its own, so a code
    // that could never have been minted has to fail here, where there is
    // someone to tell.
    if (!norm) {
      return Promise.reject(new Error(
        'That is not a room code — it is 8 letters and digits, and never O, 0, I or 1.'));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onerror = () => reject(new Error(relayError(url)));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code: norm }));
```

the rest of the method is unchanged.

- [ ] **Step 4: Widen the probe**

`tools/coopprobe.mjs:108` — the cap comment says `Create room → four letters in [data-coop-code]`. Reword it to say the grouped code, so the next reader of the timeout is not told to expect four characters.

`tools/coopprobe.mjs:1083` — change the regex:

```js
        () => /^[A-Z0-9]{4}$/.test(document.querySelector('[data-coop-code]')?.textContent?.trim() ?? ''),
```

becomes

```js
        () => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector('[data-coop-code]')?.textContent?.trim() ?? ''),
```

and the value the probe carries forward is typed straight back into the join field, so it must keep the separator it read — the input strips it. No other probe change. (`tools/coopprobe.mjs:914`'s `wireState` reads the code length-agnostically and needs nothing.)

- [ ] **Step 5: Widen the UI**

In `src/ui/Menus.js`, the room block at `:426-437`:

```html
            <h3 class="coop-h">Room code</h3>
            <p class="coop-hint">The easy way, if a signalling server is configured. The host
              creates a room and reads out the four letters; everyone else types them in.</p>
            <nav class="menu-list menu-list--row">
              <button class="mbtn mbtn--go" data-nav data-act="coop-room-host"><span>Create room</span></button>
              <output class="coop-code" data-coop-code>----</output>
              <input class="coop-input" data-coop-roomcode maxlength="6" placeholder="CODE" aria-label="Room code" />
```

becomes

```html
            <h3 class="coop-h">Room code</h3>
            <p class="coop-hint">The easy way, if a signalling server is configured. The host
              creates a room and reads out the code; everyone else types it in. The dash is
              only there to read by — typing it is optional.</p>
            <nav class="menu-list menu-list--row">
              <button class="mbtn mbtn--go" data-nav data-act="coop-room-host"><span>Create room</span></button>
              <output class="coop-code" data-coop-code>${CODE_PLACEHOLDER}</output>
              <input class="coop-input" data-coop-roomcode maxlength="9" placeholder="CODE" aria-label="Room code" />
```

At `:1515`, where the minted code is displayed, group it for reading. Change:

```js
    this.root.querySelector('[data-coop-code]').textContent = code;
```

to

```js
    // Grouped for the half of this feature that happens out loud. The input
    // strips the separator again, and the relay never sees it either way.
    this.root.querySelector('[data-coop-code]').textContent =
      code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
```

At `:1519`, the join read stays as it is — `Lobby.joinViaRelay` now normalises — but drop the redundant `.toUpperCase()` so there is exactly one place that decides the spelling:

```js
    const code = field('roomcode').value.trim().toUpperCase();
```

becomes

```js
    const code = field('roomcode').value;
```

At `:1515`, the confirmation still says "letters" for something that now contains digits and a dash:

```js
          this.coopSay(`Room ${code} is open. Give those letters to your friends — they join with them.`);
```

becomes

```js
          this.coopSay(`Room ${code} is open. Give that code to your friends — they join with it.`);
```

At `:1538`, leaving a room resets the display to the old four-dash placeholder, which would silently shrink after every leave. It must use the same string as the markup in Step 5's `<output>` — define it once at the top of the class file and use it in both places:

```js
/** The empty room-code display: the grouped shape of a real code, in dashes. */
const CODE_PLACEHOLDER = '---------';
```

```js
          this.root.querySelector('[data-coop-code]').textContent = CODE_PLACEHOLDER;
```

and the markup's `<output class="coop-code" data-coop-code>` uses `${CODE_PLACEHOLDER}` rather than a literal — **but only if that markup is inside a template literal**. Check it before you write it: if the co-op markup is an ordinary string, write the nine dashes literally in the HTML and keep the constant for `:1538` alone, and say so in your report.

- [ ] **Step 6: Widen the box the code has to fit in**

`src/ui/hud.css:2172-2173` — `.coop-input` is `width: 6.4em` with `letter-spacing: 0.28em`, sized for six characters. Nine will pan and clip inside the field, and **no gate can see this**: `tools/coopprobe.mjs` reads `textContent`, not pixels. Change:

```css
.coop-input {
  width: 6.4em;
```

to

```css
.coop-input {
  /* Nine characters at 0.28em tracking — the grouped code plus the separator a
     player may or may not type. Sized in em so it tracks the menu type scale. */
  width: 9.6em;
```

`.coop-code` (`:2159`) has `min-width: 5.2em` and grows, so it needs no change — but open the co-op screen at its narrowest layout and confirm `.menu-list--row` does not wrap or overflow with both the wider input and the longer output on it.

- [ ] **Step 7: Fix the player-facing instruction**

`docs/MULTIPLAYER.md:160-162`:

```markdown
1. Host: Co-op → **Create room** → four letters appear.
2. Read the letters out.
3. Everyone else: Co-op → type them into the code box → **Join room**.
```

becomes

```markdown
1. Host: Co-op → **Create room** → an eight-character code appears, grouped as `ABCD-2345`.
2. Read it out. The alphabet has no O, 0, I or 1 in it, so nothing in it can be misheard for something else.
3. Everyone else: Co-op → type it into the code box → **Join room**. The dash is optional.
```

- [ ] **Step 8: Run the tests**

Run: `node tests/signal-hardening.test.mjs`
Expected: PASS, `0 failed`.

Run: `npm test`
Expected: 58/58 files pass.

- [ ] **Step 9: Commit**

```bash
git add tools/coopprobe.mjs tests/signal-hardening.test.mjs src/ui/Menus.js src/ui/hud.css src/net/Lobby.js docs/MULTIPLAYER.md
git commit -m "A room code long enough to be worth guarding is one every part of the game can still read out loud"
```

---

### Task 3: Abuse limits — connections, message rate, room caps, Origin

The relay will take every connection offered, hold every room for ever, and let one socket send at line rate. This task puts a ceiling on each.

**Files:**
- Modify: `tools/signal-server.mjs`
- Test: `tests/signal-hardening.test.mjs` (append)

**Interfaces:**
- Consumes: `LIMITS` (Task 1) — extended here with `MAX_CONNS_PER_IP`, `MAX_MSGS_PER_SEC`, `MSG_BURST`, `MAX_ROOMS`, `MAX_CLIENTS_PER_ROOM`, `ROOM_TTL_MS`, `HEARTBEAT_MS`.
- Produces: `export class TokenBucket` with `constructor(ratePerSec, burst)` and `take(now)` → boolean; `export function log(event, fields)`, which Task 4 then builds on. The logger lands **here**, not in Task 4, because this task's own code calls it from `verifyClient` and from the sweep timer — a `log` that arrives one task later is a `ReferenceError` thrown inside an upgrade handler and an uncaught exception inside a `setInterval`, which kills the relay child mid-test.

- [ ] **Step 1: Write the failing test**

Append to `tests/signal-hardening.test.mjs`, before the summary:

```js
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node tests/signal-hardening.test.mjs`
Expected: FAIL — `TokenBucket` is not exported; the TTL/room-cap/Origin cases all fail because the server ignores those environment variables.

- [ ] **Step 3: Extend `LIMITS` and make it environment-overridable**

Replace the `LIMITS` block from Task 1 with:

```js
/** One environment override, parsed as a positive number or ignored. */
function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES: 64 * 1024,
  MAX_BLOB_CHARS: 32 * 1024,
  MAX_CANDIDATE_CHARS: 1024,
  CODE_LEN: 8,
  // Sized for a co-op game, not a public chat service. Four players is the
  // designed party; the slack above it absorbs a joiner whose socket has not
  // been swept yet, so a legitimate rejoin is never the one that is refused.
  MAX_CLIENTS_PER_ROOM: envNum('SIGNAL_MAX_CLIENTS_PER_ROOM', 8),
  MAX_ROOMS: envNum('SIGNAL_MAX_ROOMS', 500),
  MAX_CONNS_PER_IP: envNum('SIGNAL_MAX_CONNS_PER_IP', 12),
  // Trickle ICE is bursty by nature — a host gathering against several
  // interfaces emits a dozen candidates in a few milliseconds — so the burst is
  // deliberately much larger than the sustained rate.
  MAX_MSGS_PER_SEC: envNum('SIGNAL_MAX_MSGS_PER_SEC', 40),
  MSG_BURST: envNum('SIGNAL_MSG_BURST', 120),
  ROOM_TTL_MS: envNum('SIGNAL_ROOM_TTL_MS', 30 * 60 * 1000),
  HEARTBEAT_MS: envNum('SIGNAL_HEARTBEAT_MS', 30 * 1000),
});

/**
 * The origins a browser may open this relay from, or null for "any".
 *
 * Null is the default because the relay is also run on a laptop by `npm run
 * signal`, where there is no origin worth naming and a refusal would only ever
 * be self-inflicted. A public deployment is expected to set the variable; the
 * startup banner says so out loud when it is unset.
 */
const ALLOWED_ORIGINS = (process.env.SIGNAL_ALLOWED_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
```

- [ ] **Step 4: Add the redacting logger, then the token bucket**

The logger has to exist before anything in this task calls it, and it has to redact from its first line — a room code printed "just for now, until Task 4 adds redaction" is a room code in a commit.

```js
/**
 * The fields a log line must never carry, whatever a caller passes.
 *
 * A room code is a bearer token for the life of the room — anyone holding it
 * can walk into it — so it belongs in a log no more than a password does. That
 * it is also read aloud is not a counter-argument: saying it discloses it to
 * the people in the room for half an hour, while logging it discloses it to
 * whoever reads the logs, for ever.
 *
 * The contract is deliberately flat and by field NAME: `{ code }` is redacted,
 * `{ roomCode }` and `{ room: { code } }` are not. If you add a call site,
 * name your fields from this list or add to it.
 */
const SECRET_FIELDS = new Set(['code', 'blob', 'candidate', 'credential', 'password', 'username']);

export function log(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = SECRET_FIELDS.has(k) ? `[${k}]` : v;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
}
```

Then the bucket:

```js
/**
 * A message allowance that refills on the clock.
 *
 * Counting messages per fixed window would let a sender spend a whole window's
 * worth on each side of the boundary and get double the rate it was granted;
 * a bucket has no boundary to sit astride. `now` is passed in rather than read
 * so the test drives the clock instead of sleeping through it.
 */
export class TokenBucket {
  constructor(ratePerSec, burst) {
    this.rate = ratePerSec; this.burst = burst;
    this.tokens = burst; this.last = null;
  }

  take(now) {
    if (this.last === null) this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
```

- [ ] **Step 5: Enforce the ceilings at the connection**

Change `start()`'s `WebSocketServer` construction to carry a handshake gate, and extend `onConnection`:

```js
  const wss = new WebSocketServer({
    server: http,
    maxPayload: LIMITS.MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin, req }) => {
      // A client that sends no Origin is not a browser, and only a browser is
      // bound by this header — so refusing an absent one costs the probes and
      // any non-browser client while costing an attacker nothing.
      //
      // Note what this does NOT cover: the desktop shell is Chromium and its
      // page DOES send an Origin (`file://` or `null`), which is in nobody's
      // allowlist. A deployment that sets this variable and also serves desktop
      // players must name that value explicitly — see the operations section in
      // docs/MULTIPLAYER.md, and verify it empirically rather than assuming it.
      if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
        log('refused', { reason: 'origin', origin });
        return false;
      }
      const ip = addressOf(req);
      if ((connsByIp.get(ip) ?? 0) >= LIMITS.MAX_CONNS_PER_IP) {
        log('refused', { reason: 'conns-per-ip', ip });
        return false;
      }
      return true;
    },
  });
```

with the address helper and the per-IP census beside `rooms`:

```js
const connsByIp = new Map(); // ip -> live socket count

/**
 * The peer address, preferring the proxy's account of it.
 *
 * Every platform this deploys to (Fly, Render, Railway, Cloud Run) terminates
 * TLS at its edge and forwards inward, so `socket.remoteAddress` is the edge,
 * not the player — every connection would share one bucket. The left-most
 * `x-forwarded-for` entry is the original client where a trusted proxy sets it.
 */
function addressOf(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
```

In `onConnection(ws, req)` (the `ws` library passes the upgrade request as the second argument — take it):

```js
function onConnection(ws, req) {
  ws.room = null;
  ws.role = null;
  ws.ip = addressOf(req);
  ws.bucket = new TokenBucket(LIMITS.MAX_MSGS_PER_SEC, LIMITS.MSG_BURST);
  ws.alive = true;
  connsByIp.set(ws.ip, (connsByIp.get(ws.ip) ?? 0) + 1);
  ws.on('pong', () => { ws.alive = true; });
```

and at the very top of the message handler, before `JSON.parse`:

```js
    if (!ws.bucket.take(Date.now())) return reject(ws, 'rate');
```

Add the room ceilings inside the `host` and `join` cases:

```js
      case 'host': {
        if (rooms.size >= LIMITS.MAX_ROOMS) return send(ws, { type: 'error', error: 'Relay is full' });
        const code = newCode();
        // ... unchanged from Task 1
      }
      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) return send(ws, { type: 'error', error: 'No such room' });
        if (room.clients.size >= LIMITS.MAX_CLIENTS_PER_ROOM) return send(ws, { type: 'error', error: 'Room is full' });
        // ... unchanged from Task 1
      }
```

Extend the close handler to release the census:

```js
  ws.on('close', () => {
    connsByIp.set(ws.ip, (connsByIp.get(ws.ip) ?? 1) - 1);
    if (connsByIp.get(ws.ip) <= 0) connsByIp.delete(ws.ip);
    const room = rooms.get(ws.room);
    // ... the existing host/client body, unchanged
  });
```

- [ ] **Step 6: Sweep expired rooms and dead sockets**

Inside `start()`, after `wss.on('connection', onConnection)`:

```js
  // One timer for both jobs, because they answer the same question — is anything
  // here still real? A socket that stopped answering holds a room open; a room
  // whose players wandered off holds a code out of circulation. `unref` so the
  // timer never keeps a test's relay process alive past its kill.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.created > LIMITS.ROOM_TTL_MS) {
        for (const c of room.clients) send(c, { type: 'error', error: 'Room expired' });
        log('room-expired', { code, ageMs: now - room.created });
        rooms.delete(code);
      }
    }
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, LIMITS.HEARTBEAT_MS);
  sweep.unref();
```

Note the TTL test sets `SIGNAL_ROOM_TTL_MS=600` and waits 1400 ms, so the sweep must also run often enough to see it. Make the sweep interval the smaller of the two:

```js
  }, Math.min(LIMITS.HEARTBEAT_MS, Math.max(250, LIMITS.ROOM_TTL_MS / 2)));
```

- [ ] **Step 7: Run the tests**

Run: `node tests/signal-hardening.test.mjs`
Expected: PASS on every line, `0 failed`.

Run: `npm test`
Expected: 58/58 files pass.

Run: `npm run probe:coop`
Expected: the probe forms a co-op session as before. This is the proof that the rate limit does not clip real trickle-ICE traffic — a burst of candidates during formation is exactly what `MSG_BURST` is sized for. If it fails on `rate`, raise `MSG_BURST` and say so in the report rather than lowering the limiter's usefulness silently.

- [ ] **Step 8: Commit**

```bash
git add tools/signal-server.mjs tests/signal-hardening.test.mjs
git commit -m "The relay learns how much it is willing to carry, and stops holding rooms open for players who left"
```

---

### Task 4: Say what happened, without saying anything secret

The relay logs one line at startup and nothing else, so an operator cannot tell a busy hour from an attack. This task adds structured logs and widens `/healthz` — while making sure neither ever carries a code, a blob, or a candidate.

**Files:**
- Modify: `tools/signal-server.mjs`
- Test: `tests/signal-hardening.test.mjs` (append)

**Interfaces:**
- Consumes: `LIMITS`, `rooms`, `connsByIp`, and `log` (already defined in Task 3).
- Produces: `export const metrics` — a counter object.

- [ ] **Step 1: Write the failing test**

Append to `tests/signal-hardening.test.mjs`, before the summary:

```js
/* ==========================================================================
 * 5 — observability that leaks nothing
 * ======================================================================= */

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
  ok(typeof h.rejected === 'number' && typeof h.uptimeMs === 'number', 'and refusals and uptime');
  ok(!body.includes(hosting.code), 'and no room code appears anywhere in it');

  host.close(); server.kill();
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node tests/signal-hardening.test.mjs`
Expected: FAIL — `/healthz` answers only `{ok, rooms}`, so the `conns`/`rejected`/`uptimeMs` assertions fail. The T5 logging assertions should already PASS: `log` and its redaction landed in Task 3, and this task's test is what pins them.

- [ ] **Step 3: Add the metrics counter**

```js
export const metrics = { conns: 0, rooms: 0, rejected: 0, expired: 0, startedAt: Date.now() };
```

Increment the counters where the events already happen: `metrics.conns++` in `onConnection`, `metrics.rejected++` inside `reject`, `metrics.expired++` in the sweep, `metrics.rooms++` in the `host` case.

- [ ] **Step 4: Widen `/healthz`**

```js
function health() {
  return {
    ok: true,
    rooms: rooms.size,
    conns: [...connsByIp.values()].reduce((a, b) => a + b, 0),
    rejected: metrics.rejected,
    expired: metrics.expired,
    roomsTotal: metrics.rooms,
    uptimeMs: Date.now() - metrics.startedAt,
  };
}
```

- [ ] **Step 5: Say at startup what is and is not guarded**

Replace the `http.listen` callback:

The human-readable line is **not** decoration and must not be replaced by the JSON one: `tests/trickle-ice.test.mjs:409`, `tools/verify-trickle.mjs:67`, `tools/coopprobe.mjs:960` and the new test's own `startRelay` all parse the port out of it with `/ws:\/\/0\.0\.0\.0:(\d+)/`, which no JSON line can satisfy. Keep both:

```js
  http.listen(port, () => {
    // Four spawners parse this exact line for the port. It stays, verbatim.
    console.log(`signalling on ws://0.0.0.0:${http.address().port} (health: /healthz)`);
    log('listening', { port: http.address().port });
    if (!ALLOWED_ORIGINS.length) {
      console.log('[signal] SIGNAL_ALLOWED_ORIGINS is unset — any web origin may open this relay.'
        + ' That is right for a laptop and wrong for a public deployment.');
    }
  });
```

- [ ] **Step 6: Run the tests**

Run: `node tests/signal-hardening.test.mjs`
Expected: PASS, `0 failed`.

Run: `npm test`
Expected: 58/58 files pass. If `trickle-ice.test.mjs` times out waiting for the relay, the `ws://0.0.0.0:PORT` line from Step 5 was dropped — restore it.

- [ ] **Step 7: Commit**

```bash
git add tools/signal-server.mjs tests/signal-hardening.test.mjs
git commit -m "The relay learns to describe its own load without ever naming a room"
```

---

### Task 5: TURN credentials stop being written down

`setting()` persists every query parameter it reads to `localStorage`, including `?turnuser=` and `?turnpass=`. A credential in `localStorage` outlives the session that needed it, rides in a URL through history and screenshots, and is readable by anything else running on the origin. This task makes credentials session-only and purges any already stored.

**Files:**
- Modify: `src/net/NetConfig.js:75-132`
- Test: `tests/net-config-secrets.test.mjs` (create)
- Modify: `docs/MULTIPLAYER.md` (the configuration table), `.env.example`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature changes. `signalUrl()`, `iceServers()`, `rtcConfig()`, `describeNet()`, `netSim()` keep their exact shapes — `tools/coopprobe.mjs`, `src/net/Transport.js`, `src/net/Lobby.js` and `src/ui/Menus.js` all call them unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/net-config-secrets.test.mjs`:

```js
/**
 * A TURN credential is never written down.
 *
 *   node tests/net-config-secrets.test.mjs
 *
 * `?turnuser=`/`?turnpass=` have to keep working — `tools/coopprobe.mjs` passes
 * the real relay credentials that way, and the P4 handoff makes that the only
 * path whose secrets the probe can redact. What must stop is the *persistence*:
 * a credential in localStorage outlives the run that needed it and is readable
 * by everything else on the origin.
 *
 * NetConfig reads `location.search` once at module load, so each case installs
 * its globals and then imports a fresh copy with a cache-busting query.
 */
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
    keys: () => [...map.keys()],
    dump: () => Object.fromEntries(map),
  };
}

let nonce = 0;
async function loadNetConfig({ search = '', storage = fakeStorage() } = {}) {
  globalThis.location = { search, protocol: 'https:', href: `https://play.test/${search}` };
  globalThis.localStorage = storage;
  const mod = await import(`../src/net/NetConfig.js?case=${++nonce}`);
  return { mod, storage };
}

console.log('T1 — a credential arriving by query is used but never stored');
{
  const { mod, storage } = await loadNetConfig({
    search: '?turn=turn:relay.test:3478&turnuser=alice&turnpass=s3cret',
  });
  const turn = mod.iceServers().find((s) => String(s.urls).includes('turn:'));
  ok(turn?.username === 'alice' && turn?.credential === 's3cret',
     'the credential reaches the ICE server list');
  const stored = JSON.stringify(storage.dump());
  ok(!stored.includes('alice') && !stored.includes('s3cret'),
     `nothing about it is written down (storage: ${stored})`);
  ok(storage.keys().some((k) => k.endsWith('.turn')),
     'while the endpoint itself — which is not a secret — still persists');
}

console.log('T2 — a credential left in storage by an older build is purged on load');
{
  const { mod, storage } = await loadNetConfig({
    search: '',
    storage: fakeStorage({
      'telluric.net.turnuser': 'alice',
      'telluric.net.turnpass': 's3cret',
      'petrichor.net.turnpass': 'older-secret',
      'telluric.net.turn': 'turn:relay.test:3478',
    }),
  });
  mod.iceServers();
  const stored = JSON.stringify(storage.dump());
  ok(!stored.includes('s3cret') && !stored.includes('older-secret') && !stored.includes('alice'),
     `both prefixes are cleared (storage: ${stored})`);
  ok(storage.getItem('telluric.net.turn') === 'turn:relay.test:3478',
     'and the endpoint is left alone');
}

console.log('T3 — a stored credential is not silently used, so TURN fails loudly rather than half-configured');
{
  const { mod } = await loadNetConfig({
    search: '',
    storage: fakeStorage({
      'telluric.net.turn': 'turn:relay.test:3478',
      'telluric.net.turnuser': 'alice',
      'telluric.net.turnpass': 's3cret',
    }),
  });
  const turn = mod.iceServers().find((s) => String(s.urls).includes('turn:'));
  ok(turn && turn.username === undefined,
     `a session with no credential in its URL gets no credential (got ${JSON.stringify(turn)})`);
}

console.log('T4 — describeNet still says whether TURN is configured, and never what it is');
{
  const { mod } = await loadNetConfig({
    search: '?turn=turn:relay.test:3478&turnuser=alice&turnpass=s3cret',
  });
  const d = JSON.stringify(mod.describeNet());
  ok(d.includes('"hasTurn":true'), 'it reports that TURN is on');
  ok(!d.includes('alice') && !d.includes('s3cret'), `and carries neither half of the credential (got ${d})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node tests/net-config-secrets.test.mjs`
Expected: FAIL on T1 (`nothing about it is written down`), T2 and T3 — today every query parameter persists and a stored credential is read back.

- [ ] **Step 3: Give `setting()` a persistence policy**

In `src/net/NetConfig.js`, replace `setting()` (`:68-82`) with:

```js
/**
 * One setting, resolved — and, if it is not a secret, remembered.
 *
 * An explicitly empty query param (`?turn=`) clears the stored value rather
 * than being ignored, so a tester can turn TURN back off without clearing site
 * data by hand.
 *
 * `persist: false` is the whole of this function's security behaviour. A TURN
 * username and credential are bearer secrets for a relay somebody pays for, and
 * `localStorage` is the wrong shape for one in three separate ways: it outlives
 * the session that needed it, it is readable by every script on the origin, and
 * it survives into screenshots and support dumps taken long afterwards. So a
 * credential is read from the URL of the session that is using it and from
 * nowhere else, and anything an older build stored is actively removed rather
 * than merely ignored — a value left behind is a value that leaks later.
 */
function setting(queryKey, envKey, fallback = '', { persist = true } = {}) {
  if (!persist) store.del(queryKey);
  if (params.has(queryKey)) {
    const v = params.get(queryKey).trim();
    if (persist) { if (v) store.set(queryKey, v); else store.del(queryKey); }
    return v || env(envKey) || fallback;
  }
  return (persist ? store.get(queryKey) : '') || env(envKey) || fallback;
}
```

- [ ] **Step 4: Mark the two credentials non-persisting**

In `iceServers()` (`:124-130`):

```js
  const turn = setting('turn', 'VITE_TURN_URLS');
  if (turn) {
    const username = setting('turnuser', 'VITE_TURN_USERNAME');
    const credential = setting('turnpass', 'VITE_TURN_CREDENTIAL');
```

becomes

```js
  const turn = setting('turn', 'VITE_TURN_URLS');
  const username = setting('turnuser', 'VITE_TURN_USERNAME', '', { persist: false });
  const credential = setting('turnpass', 'VITE_TURN_CREDENTIAL', '', { persist: false });
  if (turn) {
```

Note the two credential reads move **above** the `if (turn)` guard deliberately: the purge must also happen in sessions with no TURN endpoint configured, which are exactly the ones that would otherwise keep an old credential for ever.

That is still not early enough to match the claim. `iceServers()` runs when the co-op screen opens or a connection forms — a player who never touches co-op would keep a stored credential indefinitely. Purge at module scope so the guarantee is "on load", as documented, rather than "on first co-op":

```js
// A credential stored by an older build is deleted when this module loads, not
// when co-op is next opened — a player who never opens the co-op screen is
// precisely the one whose stale credential would otherwise sit there for ever.
for (const k of ['turnuser', 'turnpass']) store.del(k);
```

Place it immediately after the `store` definition (`:61`). `store.del` clears both the current and the legacy prefix, which is why it is the right call here.

Update the resolution-order comment at `:26-30` to record the exception:

```js
 *   1. URL query (`?signal=`, `?turn=`, `?turnuser=`, `?turnpass=`, `?ice=`)
 *   2. `localStorage` (whatever a query param last persisted)
 *   3. build-time env (`VITE_SIGNAL_URL`, `VITE_TURN_URLS`, ...)
 *   4. the localhost default
 *
 * Query params persist to `localStorage` on read, so a tester follows a link
 * once and every later plain visit keeps the same configuration — with one
 * exception. `?turnuser=` and `?turnpass=` are credentials: they are read from
 * the URL, never written to storage, and any copy an older build left behind is
 * deleted on load. A tester carrying credentials therefore carries the whole
 * link every time, which is the intended cost.
```

- [ ] **Step 5: Run the tests**

Run: `node tests/net-config-secrets.test.mjs`
Expected: PASS, `0 failed`.

Run: `npm test`
Expected: 59/59 files pass.

- [ ] **Step 6: Document the environment surface**

In `docs/MULTIPLAYER.md`, in the configuration matrix around `:177-183`, note in the `?turnuser=`/`?turnpass=` rows that they are session-only and do not persist (the table's own caption at `:172-173` says "Query wins, and persists" — amend it so it is not contradicted by its own rows).

Then add a relay-operations section listing every `SIGNAL_*` variable from `LIMITS` with its default and one line on what it protects: `SIGNAL_ALLOWED_ORIGINS`, `SIGNAL_MAX_CLIENTS_PER_ROOM`, `SIGNAL_MAX_ROOMS`, `SIGNAL_MAX_CONNS_PER_IP`, `SIGNAL_MAX_MSGS_PER_SEC`, `SIGNAL_MSG_BURST`, `SIGNAL_ROOM_TTL_MS`, `SIGNAL_HEARTBEAT_MS`. State plainly that a public deployment must set `SIGNAL_ALLOWED_ORIGINS`, and add this warning verbatim in substance:

> An allowlist names **browser** origins. The desktop build is Chromium too, and its page sends an Origin of its own (`file://` or `null`) that appears in no allowlist — so a deployment that serves desktop players and sets this variable must include that value. Find out what it actually sends by reading the relay's `refused` log line while a desktop build connects. Do not assume it.

In `.env.example`, add a comment above the `VITE_TURN_*` block: build-time credentials are baked into the bundle and are invisible to `tools/coopprobe.mjs`'s redactor, so for probe runs pass them as `--turn/--turnuser/--turnpass` instead.

- [ ] **Step 7: Commit**

```bash
git add src/net/NetConfig.js tests/net-config-secrets.test.mjs docs/MULTIPLAYER.md .env.example
git commit -m "A credential is something this session was handed, not something the browser keeps"
```

---

## Out of scope, deliberately

- **Short-lived TURN REST credentials** (audit item 12's second half). Issuing them needs a credential service and a deployment the user owns; this slice removes the persistence hazard from the client, which is the half that lives in this repo. Flag it as needing a user decision.
- **Relay authentication.** The Origin allowlist plus the rate limits are the deployment-appropriate control for a free relay with no accounts. Real authentication implies identity, which this game does not have.
- **`deploy/signal/` crate updates.** That directory exists only on the parked `slice/mp-p4-remote-network` branch. When P4 merges, its `fly.toml` should set `SIGNAL_ALLOWED_ORIGINS`; that is a P4 merge-carry item, recorded here and in the session handoff.

## Self-review notes

- Spec coverage: audit item 11's six bullets map to Task 1 (schemas, byte limits), Task 1 (crypto codes) + Task 2 (the length surface), Task 3 (room caps, rate limits, heartbeat, TTL, Origin) and Task 4 (metrics, secret-free logs). Audit item 12 maps to Task 5, minus the REST-credential half recorded above.
- The whole-surface enumeration behind Task 2 came from a dedicated recon pass; the three consumers that hard-code the old length (`tools/coopprobe.mjs:1083`, `tests/trickle-ice.test.mjs:464`, `src/ui/Menus.js:433`) are each named with a line number, because each fails differently and one of them fails as a timeout rather than an assertion.
- Type consistency: `LIMITS`, `validate`, `normalizeCode`, `TokenBucket`, `log`, `metrics` are named identically in every task that uses them. `normalizeRoomCode` (page side) is deliberately a different name from `normalizeCode` (relay side) because they are two implementations of one rule that cannot import each other, and Task 2's test asserts they agree.
