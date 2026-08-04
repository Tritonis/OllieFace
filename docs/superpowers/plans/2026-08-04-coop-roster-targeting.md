# Co-op P0 + P1 Implementation Plan — lifecycle sweep, latency rig, roster and enemy targeting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every enemy in the arena fights whichever player is nearest it, and leaving co-op leaves your survivor working.

**Architecture:** A new `Roster` engine system owns the list of player entities and answers one spatial query. `Enemy` keeps a `targetPlayer` acquired from that query on a staggered timer with switch hysteresis, and fills the three per-enemy fields (`target`, `distToPlayer`, `hasLOS`) its FSM already reads — so the FSM, the steering and the pack-stagger timing are not touched. Four already-diagnosed lifecycle defects and a packet-delay rig land first so that no measurement is taken on a broken tree or at a zero-latency fiction.

**Tech Stack:** Vanilla ES modules, Three.js (`three`), Vite 5, Playwright for browser probes, bare `node` for headless tests. No test framework — tests are standalone `.mjs` files with a hand-rolled `ok()`/`eq()` harness, matching `reviews/round6/C2-corruption.test.mjs`.

## Global Constraints

- **Single-player must stay bit-identical to HEAD.** A roster of one is the invariant the whole migration is verified against. Task 5 is the gate that proves it. If any task moves a single-player number, stop and report — do not "fix" the test.
- **Do not touch `src/systems/Combat.js`.** Its three `ctx.player` reads (`:467`, `:483`) are a deliberate round-5 fix: a remote pawn *is* `isPlayer`, so gating on `=== ctx.player` is what stops a teammate 40 m away from resetting this player's hurt timer, flashing their HUD and ducking their music. Migrating them to the roster reintroduces that bug.
- **Do not change `PROTOCOL_VERSION`.** It stays at `4`. No wire format moves in P0 or P1.
- **Do not touch the enemy FSM.** `Enemy.js` lines 1264–1614 (the `S.*` state table) and the steering helpers are out of scope except for the four explicitly listed `ctx.player` null-guards.
- **Zero cost when off.** The latency rig (Task 3) must add no code path and no allocation when its URL flag is absent.
- **Comments state both ends of a range.** Every new tuning constant carries a comment naming the failure at each end of its range. This is process rule 1 from `reviews/round7/SESSION-SUMMARY.md` §6.
- **Never `npx`.** Run Vite as `node node_modules/vite/bin/vite.js <cmd>`. Bare `npx` has destroyed the rolldown binding in this repo before.
- Build check for every task: `node node_modules/vite/bin/vite.js build` → exit 0.

## Execution Waves

Tasks within a wave touch disjoint files and can run as parallel subagents. Waves are barriers.

| Wave | Tasks | Files touched | Parallel? |
|---|---|---|---|
| **A** | 1, 2, 3, 4 | `Lobby.js` · `NetHost.js` · `Transport.js`+`NetConfig.js` · `tests/` (new) | **Yes — 4 agents** |
| **B** | 5 | `Roster.js` (new), `Player.js`, `main.js`, `tests/` | No — blocks everything after |
| **C** | 6, 7 | `Enemy.js` · `Director.js`+`FinalBoss.js`+`HUD.js` | **Yes — 2 agents** |
| **D** | 8, 9 | `reviews/round8/` probes · `data/enemies.js` | No — 8 then 9 |

Task 6 and Task 7 are written against a **fixed cross-file interface** (`denyHealing(seconds, victim)`), declared in both tasks' Interfaces blocks, so they can be implemented simultaneously without either seeing the other's code.

---

# WAVE A — P0 lifecycle sweep and latency rig

## Task 1: Lobby lifecycle — C-2 and C-10

**Files:**
- Modify: `src/net/Lobby.js:116-124` (`acceptAnswer`), `src/net/Lobby.js:236-246` (`leave`)
- Test: `tests/lobby-lifecycle.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new. Restores the documented postcondition of `Lobby.leave()` — after it returns, `ctx.netRole === 'single'`.

**Background you need.** `ctx.netRole` is read in four places and each one breaks differently when it is stale:
- `src/entities/Player.js:366` — `if (ctx.netRole !== 'client') this.applyCommand(this._sampleCommand(ctx), h)`. A stale `'client'` means the survivor stops sampling its own input. This is the measured **0.000 units of movement** after *Leave co-op*.
- `src/core/Engine.js:357`, `:363` — damage attribution filters.
- `src/systems/Profile.js:1272`, `:1369` — a stale non-`'single'` role **silently disables profile and achievement recording** for the rest of the page's life. This consequence is not in any prior report; it is why this task is worth its own test rather than a one-line drive-by.

- [ ] **Step 1: Write the failing test**

Create `tests/lobby-lifecycle.test.mjs`:

```js
/**
 * C-2 and C-10 — the two Lobby lifecycle defects.
 *
 *   node tests/lobby-lifecycle.test.mjs
 *
 * Self-contained: fakes the engine, the event bus and the transport, and
 * imports the real `src/net/Lobby.js`.
 */
import { Lobby } from '../src/net/Lobby.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const handlers = new Map();
  return {
    netRole: 'single',
    authority: true,
    events: {
      on: (n, f) => { if (!handlers.has(n)) handlers.set(n, []); handlers.get(n).push(f); },
      emit: (n, p) => (handlers.get(n) || []).forEach((f) => f(p)),
    },
  };
}

// The engine only has to hand back whatever system it was given.
const makeEngine = () => ({ add: (s) => s });

console.log('C-2 — leave() restores ctx.netRole');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(), ctx);
  // Stand in for what NetClient.init does at src/net/NetClient.js:57.
  ctx.netRole = 'client';
  ctx.authority = false;
  lobby.mode = 'client';
  lobby.net = { close() {} };

  lobby.leave();

  ok(ctx.netRole === 'single', `netRole reset to 'single' (got '${ctx.netRole}')`);
  ok(ctx.authority === true, 'authority restored');
  ok(lobby.mode === 'single', 'mode restored');
}

console.log('C-2 — a Lobby that never joined is untouched (other end of the range)');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(), ctx);
  lobby.leave();
  ok(ctx.netRole === 'single', 'netRole still single');
}

console.log('C-10 — acceptAnswer sets peerConnecting before the join can land');
{
  const ctx = makeCtx();
  const lobby = new Lobby(makeEngine(), ctx);
  const seen = [];
  lobby.onStatus = (s) => seen.push(s);

  // The real `invite.accept` resolves the transport's `ready` promise, which
  // fires onPeer -> netPlayerJoined -> the host's "connected" status. Model
  // that as a status set that happens *during* the await.
  lobby.pendingInvites.set(7, {
    accept: async () => { lobby._set('peerJoined'); },
  });
  lobby._inviteIdFor = () => 7;

  await lobby.acceptAnswer('irrelevant-blob');

  const iConnecting = seen.indexOf('peerConnecting');
  const iJoined = seen.indexOf('peerJoined');
  ok(iConnecting >= 0 && iJoined >= 0, `both statuses seen (${JSON.stringify(seen)})`);
  ok(iConnecting < iJoined, `peerConnecting precedes peerJoined (${JSON.stringify(seen)})`);
  ok(lobby.status === 'peerJoined', `final status is the join, not the placeholder (got '${lobby.status}')`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/lobby-lifecycle.test.mjs`

Expected: FAIL on `netRole reset to 'single' (got 'client')` and on `peerConnecting precedes peerJoined` / `final status is the join`.

- [ ] **Step 3: Fix C-2 in `leave()`**

In `src/net/Lobby.js`, method `leave()` (line 236), after the `this.ctx.authority = true;` line, add:

```js
    // Every consumer of `netRole` has to be handed back its single-player
    // answer, not just `authority`. A stale 'client' stops
    // `Player.fixedUpdate` sampling input at all (Player.js:366 — the measured
    // 0.000 units of movement after leaving), re-points two damage filters
    // (Engine.js:357, :363) and silently disables profile and achievement
    // recording for the rest of the page's life (Profile.js:1272, :1369).
    this.ctx.netRole = 'single';
```

- [ ] **Step 4: Fix C-10 in `acceptAnswer()`**

In `src/net/Lobby.js`, method `acceptAnswer()` (line 116), the body currently ends:

```js
    await invite.accept(answerBlob);
    this.pendingInvites.delete(id);
    this._set('peerConnecting', { id });
```

Replace those three lines with:

```js
    // Set the placeholder *before* the await. `invite.accept` resolves the
    // transport's `ready` promise, which fires `onPeer` -> `netPlayerJoined` ->
    // the status a successful join deserves. Setting 'peerConnecting'
    // afterwards overwrote that, so a host that had just accepted a player sat
    // reading "Reply accepted — connecting…" forever.
    this._set('peerConnecting', { id });
    await invite.accept(answerBlob);
    this.pendingInvites.delete(id);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/lobby-lifecycle.test.mjs`
Expected: PASS on all 6 assertions, exit 0.

- [ ] **Step 6: Fail each gate on purpose, one fix at a time**

Revert **only** the `netRole` line, run the test, confirm exactly the two C-2 assertions fail and the three C-10 assertions still pass. Restore. Then revert **only** the `acceptAnswer` reordering, run, confirm exactly the C-10 ordering assertions fail. Restore.

Record both outputs in the task report. A gate never failed on purpose is not a gate (process rule 2).

- [ ] **Step 7: Build and commit**

```bash
node node_modules/vite/bin/vite.js build
git add src/net/Lobby.js tests/lobby-lifecycle.test.mjs
git commit -m "Hand back every answer leaving co-op borrowed, not just one"
```

---

## Task 2: NetHost lifecycle — C-7, C-1 and C-4

**Files:**
- Modify: `src/net/NetHost.js:35` (constant), `:107-146` (`_onPeer`), `:280-295` (`_onHello` age gate), `fixedUpdate`, `:402-434` (`_holdSession`)
- Test: `tests/nethost-hello-gate.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `client.joinedAt` (seconds, wall clock) alongside the existing `client.joinTick`. Task 3's rig and later waves do not depend on it.

**Background.** Three defects in one file, done together because they overlap.

- **C-7:** `HELLO_MAX_PAWN_AGE = 120` (`NetHost.js:35`) is compared against `this.tick - c.joinTick`, a frame-driven counter, but expresses a wall-clock intent. 120 host ticks is ~2 s at 60 fps and **~15 s** at the ~8 ticks/s a throttled arm runs at. Mirror image of the `HOLD_GRACE` defect.
- **C-1:** `_onHello` refuses a HELLO that is duplicated, unparseable, truncated, version-mismatched, survivor-invalid or late. It cannot refuse a peer that **never sends one**. Such a peer is simulated as the host's survivor for the whole session: measured host `ranger` 70.17/110 vs joiner `anvil` 108.44/170, both lobbies reading "connected", **0 console errors, 0 page errors, 0 `[net]` warnings**.
- **C-4:** `_holdSession` sets `ctx.input.enabled = !live`, so for up to `HOLD_GRACE` (1.5 s) after the last peer dies, pause-menu keystrokes also drive the host's survivor.

**C-7 must land before C-1**, or the new refusal inherits the 15 s timeout.

- [ ] **Step 1: Write the failing test**

Create `tests/nethost-hello-gate.test.mjs`:

```js
/**
 * C-7 and C-1 — the HELLO age unit, and the peer that never sends one.
 *
 *   node tests/nethost-hello-gate.test.mjs
 *
 * Drives NetHost's client bookkeeping directly rather than standing up a
 * transport: the defect is entirely in when the age gate fires.
 */
import { NetHost } from '../src/net/NetHost.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeHost() {
  const host = new NetHost({ maxPlayers: 4 });
  const emitted = [];
  host.ctx = {
    authority: true, netRole: 'host', time: 0, seed: 1,
    events: { on() {}, emit: (n, p) => emitted.push([n, p]) },
    combat: { entities: [] },
  };
  host.emitted = emitted;
  return host;
}

/** A client record shaped exactly as `_onPeer` builds one. */
function addClient(host, { helloSeen = false, joinedAt = 0, joinTick = 0 } = {}) {
  const refusals = [];
  const peer = { id: 1, sendEvent() {}, sendState() {}, close() {}, refusals };
  host.clients.set(peer.id, {
    peer, pawn: null, inputs: [], lastTick: 0, name: 'Player 2',
    joinTick, joinedAt, helloSeen, survivorId: null,
  });
  host._refuse = (p, reason, detail) => { refusals.push({ reason, detail }); host.clients.delete(p.id); };
  return { peer, refusals };
}

console.log('C-7 — the age gate is counted in seconds, not ticks');
{
  const host = makeHost();
  const { refusals } = addClient(host, { joinedAt: 0 });
  // 3 real seconds have passed but only 20 ticks — a throttled host. The gate
  // must fire on the clock, not the frame counter.
  host._now = () => 3.0;
  host.tick = 20;
  host._checkHelloDeadlines();
  ok(refusals.length === 1, `refused after 3 s at 20 ticks (got ${refusals.length})`);
}

console.log('C-7 — the other end: many ticks, little time, no refusal');
{
  const host = makeHost();
  const { refusals } = addClient(host, { joinedAt: 0 });
  // 300 ticks in 0.5 s — a fast host. Under the old tick gate this refused.
  host._now = () => 0.5;
  host.tick = 300;
  host._checkHelloDeadlines();
  ok(refusals.length === 0, `not refused at 0.5 s despite 300 ticks (got ${refusals.length})`);
}

console.log('C-1 — a peer that never sends a HELLO is refused');
{
  const host = makeHost();
  const { refusals } = addClient(host, { helloSeen: false, joinedAt: 0 });
  host._now = () => 99;
  host._checkHelloDeadlines();
  ok(refusals.length === 1, 'silent peer refused');
  ok(/identity/i.test(refusals[0]?.detail ?? ''), `refusal names the identity message (got '${refusals[0]?.detail}')`);
}

console.log('C-1 — the other end: a peer that did send one is left alone');
{
  const host = makeHost();
  const { refusals } = addClient(host, { helloSeen: true, joinedAt: 0 });
  host._now = () => 99;
  host._checkHelloDeadlines();
  ok(refusals.length === 0, 'peer with a HELLO is not refused');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/nethost-hello-gate.test.mjs`
Expected: FAIL — `host._checkHelloDeadlines is not a function`.

- [ ] **Step 3: C-7 — replace the tick constant with a wall-clock one**

In `src/net/NetHost.js`, replace the `HELLO_MAX_PAWN_AGE` declaration at line 35 with:

```js
// How long a peer may take to identify itself before the host gives up on it.
//
// Counted in seconds, not host ticks. It used to be 120 ticks, which reads as
// ~2 s at 60 fps and ~15 s at the ~8 ticks/s a throttled host actually runs
// at — a join gate whose real length depended on the host's frame rate. Too
// short and a peer on a slow connection is refused mid-handshake; too long and
// a silent peer is simulated as the host's own survivor for that whole window.
const HELLO_MAX_AGE_SEC = 2.5;
```

Delete the old `HELLO_MAX_PAWN_AGE` constant. Add a monotonic clock helper as a method on `NetHost` so tests can substitute it:

```js
  /** Seconds, monotonic. A seam so the age gates are testable. */
  _now() { return performance.now() / 1000; }
```

- [ ] **Step 4: C-7 — stamp the join time and use it in `_onHello`**

In `_onPeer` (line ~119), extend the `this.clients.set(...)` record with `joinedAt`:

```js
    this.clients.set(peer.id, {
      peer, pawn, inputs: [], lastTick: 0, name: `Player ${peer.id + 1}`,
      joinTick: this.tick, joinedAt: this._now(), helloSeen: false, survivorId: null,
    });
```

`joinTick` stays — it remains the honest measure of pawn age for anything counted in ticks.

Then in `_onHello`, replace the late-HELLO gate at line ~288:

```js
    if (this.tick - (c.joinTick ?? 0) > HELLO_MAX_PAWN_AGE) {
```

with:

```js
    if (this._now() - (c.joinedAt ?? 0) > HELLO_MAX_AGE_SEC) {
```

- [ ] **Step 5: C-1 — add the deadline sweep**

Add this method to `NetHost`:

```js
  /**
   * The fifth HELLO door.
   *
   * `_onHello` can refuse a message that is duplicated, unparseable,
   * truncated, version-mismatched, survivor-invalid or late. It cannot refuse
   * a peer that never sends one at all, because nothing ever looks. Such a
   * peer keeps the pawn's default survivor — the host's — and is simulated as
   * it for the whole session, silently: measured at host `ranger` 70.17/110
   * against joiner `anvil` 108.44/170 with both lobbies reading "connected"
   * and zero console errors, page errors or `[net]` warnings.
   */
  _checkHelloDeadlines() {
    if (this.clients.size === 0) return;
    const now = this._now();
    for (const c of [...this.clients.values()]) {
      if (c.helloSeen) continue;
      if (now - (c.joinedAt ?? 0) <= HELLO_MAX_AGE_SEC) continue;
      this._refuse(c.peer, REFUSE.HELLO, 'it never sent an identity message');
    }
  }
```

Call it as the first statement of `NetHost.fixedUpdate`. If `fixedUpdate` does not yet exist on `NetHost`, add it:

```js
  fixedUpdate(ctx, h) {
    this._checkHelloDeadlines();
  }
```

If it does exist, insert `this._checkHelloDeadlines();` as its first line and leave the rest alone.

- [ ] **Step 6: Run test to verify it passes**

Run: `node tests/nethost-hello-gate.test.mjs`
Expected: PASS on all 5 assertions, exit 0.

- [ ] **Step 7: C-4 — mute input on the right predicate**

In `_holdSession` (line ~428) the line is:

```js
      if (ctx.input) ctx.input.enabled = !live;
```

Replace with:

```js
      // Two questions, two predicates. The grace exists so a peer that has just
      // died still receives the snapshot carrying its own death; the mute
      // exists because the world is still being played by somebody. But while a
      // local menu is open the host is not playing it — leaving input live let
      // pause-menu keystrokes drive the survivor for up to HOLD_GRACE (1.5 s)
      // after the last peer died.
      if (ctx.input) ctx.input.enabled = !live && !screen;
```

- [ ] **Step 8: Fail each gate on purpose, one fix at a time**

Restore the tick-based gate alone → confirm only the two C-7 assertions fail. Restore. Remove the `_checkHelloDeadlines` call alone → confirm only the two C-1 assertions fail. Restore. Record both outputs.

- [ ] **Step 9: Build and commit**

```bash
node node_modules/vite/bin/vite.js build
git add src/net/NetHost.js tests/nethost-hello-gate.test.mjs
git commit -m "A door for the peer that says nothing, on a clock that means seconds"
```

---

## Task 3: The `?netlag=` rig

**Files:**
- Modify: `src/net/NetConfig.js` (add resolver + export), `src/net/Transport.js:30-69` (`Peer`)
- Test: `tests/netlag.test.mjs` (create)

**Interfaces:**
- Consumes: `setting(queryKey, envKey, fallback)` — the existing private resolver in `NetConfig.js`.
- Produces:
  - `netSim()` → `{ lagMs: number, jitterMs: number, lossPct: number, on: boolean }` exported from `src/net/NetConfig.js`. `on` is `false` when no flag was supplied.
  - `Peer.pumpSim()` — drains the delay queue. Called from `NetHost.update` and `NetClient.update`. A no-op when the rig is off.

**Why this is in P0 rather than P4.** Every number in seven prior review rounds came from two pages on one machine at zero latency. Every measurement from Wave C onward should run at both 0 ms and a realistic RTT, and that is only possible if the rig exists first.

- [ ] **Step 1: Write the failing test**

Create `tests/netlag.test.mjs`:

```js
/**
 * The ?netlag= / ?netloss= rig.
 *
 *   node tests/netlag.test.mjs
 *
 * Checks the two properties that matter: it is exactly a no-op when off, and
 * when on it delays without reordering and drops only the unreliable channel.
 */
import { Peer } from '../src/net/Transport.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fakePc() { return { close() {}, addEventListener() {}, removeEventListener() {} }; }

function chan() {
  const sent = [];
  return { readyState: 'open', bufferedAmount: 0, send: (b) => sent.push(b), sent };
}

function peerWith(sim) {
  const p = new Peer(fakePc(), 1);
  p.state = chan();
  p.events = chan();
  if (sim) p.installSim(sim, () => p._t);
  p._t = 0;
  return p;
}

console.log('off — sends land immediately and pumpSim is inert');
{
  const p = peerWith(null);
  p.sendState(new Uint8Array([1]));
  p.sendEvent(new Uint8Array([2]));
  ok(p.state.sent.length === 1, 'state sent immediately');
  ok(p.events.sent.length === 1, 'event sent immediately');
  p.pumpSim();
  ok(p.state.sent.length === 1, 'pumpSim added nothing');
}

console.log('on — a delayed packet is held, then released in order');
{
  const p = peerWith({ on: true, lagMs: 50, jitterMs: 0, lossPct: 0 });
  p._t = 0;
  p.sendState(new Uint8Array([1]));
  p.sendState(new Uint8Array([2]));
  ok(p.state.sent.length === 0, 'nothing sent yet');
  p._t = 0.049; p.pumpSim();
  ok(p.state.sent.length === 0, 'still held just under the delay');
  p._t = 0.051; p.pumpSim();
  ok(p.state.sent.length === 2, `both released (got ${p.state.sent.length})`);
  ok(p.state.sent[0][0] === 1 && p.state.sent[1][0] === 2, 'released in order');
}

console.log('on — loss applies to the unreliable channel only');
{
  const p = peerWith({ on: true, lagMs: 0, jitterMs: 0, lossPct: 100 });
  p._t = 0;
  for (let i = 0; i < 10; i++) p.sendState(new Uint8Array([i]));
  for (let i = 0; i < 10; i++) p.sendEvent(new Uint8Array([i]));
  p._t = 1; p.pumpSim();
  ok(p.state.sent.length === 0, `every state packet dropped (got ${p.state.sent.length})`);
  ok(p.events.sent.length === 10, `no event packet dropped (got ${p.events.sent.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/netlag.test.mjs`
Expected: FAIL — `p.installSim is not a function`.

- [ ] **Step 3: Add the resolver to `NetConfig.js`**

Append to `src/net/NetConfig.js`:

```js
/**
 * Artificial latency and loss, for measuring the game as it is actually played.
 *
 * Every number in seven rounds of co-op review came from two pages on one
 * machine, where RTT is zero and no packet is ever lost. That is not a network;
 * it is the absence of one. This rig makes the same probes runnable against a
 * realistic path without deploying anything.
 *
 *   ?netlag=60          60 ms one-way delay
 *   ?netlag=40-90       uniform jitter between 40 and 90 ms
 *   ?netloss=2          2% loss, unreliable channel only
 *
 * Loss is deliberately never applied to the reliable `events` channel: dropping
 * there would misrepresent a guarantee the transport actually provides, and
 * every conclusion drawn from it would be about a transport we do not ship.
 */
export function netSim() {
  const lag = setting('netlag', 'VITE_NET_LAG');
  const loss = setting('netloss', 'VITE_NET_LOSS');
  if (!lag && !loss) return { on: false, lagMs: 0, jitterMs: 0, lossPct: 0 };
  let lagMs = 0, jitterMs = 0;
  if (lag) {
    const [a, b] = lag.split('-').map((s) => Number(s.trim()));
    if (Number.isFinite(a)) {
      if (Number.isFinite(b) && b > a) { lagMs = a; jitterMs = b - a; }
      else lagMs = a;
    }
  }
  const lossPct = Number(loss) || 0;
  return { on: lagMs > 0 || jitterMs > 0 || lossPct > 0, lagMs, jitterMs, lossPct };
}
```

Also add `sim: netSim()` to the object `describeNet()` returns, so the co-op panel can show it.

- [ ] **Step 4: Add the rig to `Peer`**

In `src/net/Transport.js`, import the resolver alongside the existing one:

```js
import { rtcConfig, netSim } from './NetConfig.js';
```

Add to `Peer`:

```js
  /**
   * Arm the latency rig. `clock` returns seconds, monotonic; it is a parameter
   * so tests can drive it. Called only when `netSim().on` — a Peer that is not
   * armed has `_sim === null` and every send takes the original branch, so the
   * shipped path costs one null check and allocates nothing.
   */
  installSim(sim, clock) {
    this._sim = sim;
    this._simClock = clock;
    this._simQueue = [];
  }

  /** Release anything whose delay has elapsed. Inert when not armed. */
  pumpSim() {
    const q = this._simQueue;
    if (!q || q.length === 0) return;
    const now = this._simClock();
    let i = 0;
    // The queue is append-ordered and delays are drawn per packet, so a later
    // packet can come due first under jitter. Releasing strictly in queue order
    // preserves the ordering the channel would have had; reordering here would
    // be simulating a different network than the flag asks for.
    while (i < q.length && q[i].due <= now) i++;
    if (i === 0) return;
    const due = q.splice(0, i);
    for (const p of due) this._rawSend(p.ch, p.bytes);
  }

  _rawSend(label, bytes) {
    const ch = label === 'state' ? this.state : this.events;
    if (ch?.readyState !== 'open') return;
    if (label === 'state' && ch.bufferedAmount > 256 * 1024) return;
    ch.send(bytes);
  }

  /** Returns true when the rig consumed the packet (dropped or queued). */
  _simSend(label, bytes) {
    const sim = this._sim;
    if (!sim) return false;
    if (label === 'state' && sim.lossPct > 0 && Math.random() * 100 < sim.lossPct) return true;
    const delay = (sim.lagMs + (sim.jitterMs ? Math.random() * sim.jitterMs : 0)) / 1000;
    if (delay <= 0) return false;
    this._simQueue.push({ ch: label, bytes, due: this._simClock() + delay });
    return true;
  }
```

Then change the two send methods to consult it first:

```js
  sendState(bytes) {
    if (this._simSend('state', bytes)) return;
    if (this.state?.readyState === 'open') {
      // Drop rather than queue: a backed-up unreliable channel means we are
      // already behind, and stale snapshots are worse than none.
      if (this.state.bufferedAmount > 256 * 1024) return;
      this.state.send(bytes);
    }
  }

  sendEvent(bytes) {
    if (this._simSend('events', bytes)) return;
    if (this.events?.readyState === 'open') this.events.send(bytes);
  }
```

Add `this._sim = null;` and `this._simQueue = null;` to the `Peer` constructor.

- [ ] **Step 5: Arm it at both construction sites**

In `HostTransport.createInvite`, immediately after `const peer = new Peer(pc, id);`:

```js
    const sim = netSim();
    if (sim.on) peer.installSim(sim, () => performance.now() / 1000);
```

Add the identical two lines in `ClientTransport.join` after its `const peer = new Peer(pc, msg.id);`.

- [ ] **Step 6: Pump the queue each frame**

In `NetHost.update` (`src/net/NetHost.js:436`), as the first statement after `this._holdSession(ctx);`:

```js
    for (const c of this.clients.values()) c.peer.pumpSim();
```

In `NetClient`'s `update` method, add `this.peer?.pumpSim();` as its first statement. If `NetClient` has no `update`, add one containing only that line.

- [ ] **Step 7: Run test to verify it passes**

Run: `node tests/netlag.test.mjs`
Expected: PASS on all 9 assertions, exit 0.

- [ ] **Step 8: Verify the off path costs nothing**

Confirm by inspection and state in the task report: with no `?netlag=`/`?netloss=` and no env var, `netSim().on` is `false`, `installSim` is never called, `_sim` stays `null`, `_simSend` returns `false` on its first line, `_simQueue` stays `null`, and `pumpSim` returns on its first line. No allocation, no timer, no added branch beyond one null check.

- [ ] **Step 9: Build and commit**

```bash
node node_modules/vite/bin/vite.js build
git add src/net/Transport.js src/net/NetConfig.js tests/netlag.test.mjs
git commit -m "A network to measure against, instead of the absence of one"
```

---

## Task 4: Test runner and the single-player equivalence harness

**Files:**
- Create: `tests/run.mjs`, `tests/sp-equivalence.mjs`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `npm test` — runs every `tests/*.test.mjs`, exits non-zero if any fails.
  - `node tests/sp-equivalence.mjs --out <path>` — writes a deterministic single-player fingerprint to `<path>`. Task 5 and Task 6 both compare against a baseline captured with this.

**This task's deliverable is the gate the whole plan rests on.** Global constraint 1 says single-player must stay bit-identical; this is the instrument that decides it. Capture the baseline from **HEAD's literal condition** (`git stash` the working tree, or capture from a clean checkout) — not from the current tree, and not from an approximation. That is process rule 5, and the single-player kill-counter regression survived a whole round precisely because "single-player didn't move" was asserted rather than measured this way.

- [ ] **Step 1: Write the runner**

Create `tests/run.mjs`:

```js
/**
 * Runs every tests/*.test.mjs in its own process.
 *
 *   npm test
 *
 * Deliberately tiny: this repo has no test framework and does not need one.
 * Each test file is standalone, prints PASS/FAIL lines and exits non-zero on
 * failure, matching the idiom in reviews/round6/C2-corruption.test.mjs.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`--- ${f} FAILED ---`); }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add to `scripts`:

```json
    "test": "node tests/run.mjs",
```

- [ ] **Step 3: Verify the runner picks up Wave A's tests**

Run: `npm test`

Expected: it discovers and runs whichever `*.test.mjs` files exist. If Tasks 1–3 are still in flight, an empty or partial run exiting 0 is correct. Do not wait for them.

- [ ] **Step 4: Write the equivalence harness**

**Read `tools/spawnprobe.mjs` first — it is the maintained pattern and this file follows it.** Do not try to import the game's systems into bare node: `Stage`, `VFX` and `RenderPipeline` need a document and a GL context, and every prior attempt at a second, node-only fixture is now deleted. The surviving fixture is the real game under `?harness=1`, driven by Playwright. `reviews/round7/coop/sp-verify/` contains **only JSON output — its drivers were deleted**, so there is nothing there to reuse.

Create `tests/sp-equivalence.mjs`:

```js
/**
 * A deterministic fingerprint of a single-player run.
 *
 *   node tests/sp-equivalence.mjs --out reviews/round8/baseline-HEAD.json
 *
 * The roster migration's whole safety argument is that a roster of one behaves
 * exactly as `ctx.player` did. This is the instrument that decides it. Capture
 * a baseline from HEAD's literal condition first — not from the current tree
 * and not from an approximation. "Single-player didn't move" was asserted
 * rather than measured once before, and a kill-counter regression survived a
 * whole review round inside that gap.
 *
 * Runs the real game under `?harness=1` and then drives `fixedUpdate` by hand
 * at a pinned 60 Hz, so the only inputs are the seed and the step count. Wall
 * clock, frame rate and GPU speed are all out of the result by construction —
 * which is what "pinned-clock probe" means everywhere in reviews/round7/.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SEED = 20260804;
const STEPS = 3600;                    // 60 s at a pinned 60 Hz

const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;

const server = await createServer({ server: { port: 5209, hmr: false, watch: null }, logLevel: 'error' });
await server.listen();

const OFFSCREEN = process.env.CAPTURE_VISIBLE
  ? []
  : ['--window-position=-2400,-2400', '--window-size=1280,720'];
const browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', ...OFFSCREEN],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(`http://127.0.0.1:5209/?seed=${SEED}&quality=1&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
await page.evaluate(() => globalThis.__HARNESS__.gameplay());

// Let the world settle into normal play before the clock is pinned, then gate
// on the game actually running. Process rule 6: multiple prior instruments
// produced clean-looking numbers while the page sat on survivor-select.
await page.waitForFunction(
  () => globalThis.__GAME__.ctx.paused === false && (globalThis.__GAME__.ctx.player?._localTick ?? 0) > 60,
  null, { timeout: 30000 },
);

const fingerprint = await page.evaluate((steps) => {
  const { engine, ctx } = globalThis.__GAME__;
  const H = 1 / 60;

  // Stop the render loop from advancing the sim underneath us. `_frame` derives
  // its own dt from the wall clock, which is exactly the non-determinism this
  // probe exists to remove.
  engine.running = false;
  if (engine.raf) cancelAnimationFrame(engine.raf);

  const f = {
    seed: ctx.seed, steps,
    damageToPlayer: 0, damageByType: {}, kills: 0,
    enemiesSpawned: 0, goldTotal: 0, playerHealth: 0,
    finalEnemyPositions: [],
  };
  const r6 = (n) => Math.round(n * 1e6) / 1e6;

  ctx.events.on('damage', (e) => {
    if (e.target !== ctx.player) return;
    f.damageToPlayer += e.amount || 0;
    const t = e.type || 'none';
    f.damageByType[t] = (f.damageByType[t] || 0) + (e.amount || 0);
  });
  ctx.events.on('kill', () => { f.kills++; });

  for (let i = 0; i < steps; i++) {
    ctx.time += H;
    for (const s of engine.systems) if (s.fixedUpdate) s.fixedUpdate(ctx, H);
  }

  f.damageToPlayer = r6(f.damageToPlayer);
  for (const k in f.damageByType) f.damageByType[k] = r6(f.damageByType[k]);
  f.playerHealth = r6(ctx.player?.health ?? 0);
  f.goldTotal = ctx.items?.gold ?? 0;
  f.enemiesSpawned = ctx.director?.enemies?.length ?? 0;
  // Sorted, so a change in iteration order is not mistaken for a change in
  // behaviour — and rounded, because noise in the last bits of a float is not
  // a regression and must not read as one.
  f.finalEnemyPositions = (ctx.director?.enemies ?? [])
    .map((e) => [r6(e.position.x), r6(e.position.y), r6(e.position.z)])
    .sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  return f;
}, STEPS);

await browser.close();
await server.close();

if (pageErrors.length) {
  console.error('PAGE ERRORS — fingerprint is not trustworthy:', pageErrors);
  process.exit(1);
}

const json = JSON.stringify(fingerprint, null, 2);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  console.log(`wrote ${outPath}`);
} else {
  console.log(json);
}
```

**Two things to verify while writing this, because I could not from outside the page:**

1. **The render-loop stop.** `Engine` drives itself from `requestAnimationFrame` at `src/core/Engine.js:189-196`. `engine.running = false; cancelAnimationFrame(engine.raf)` is the *expected* shape — read lines 180–240 and use whatever the flag and handle are actually called. **State in the task report which mechanism you used**, and prove it worked by asserting `ctx.time` advances by exactly `STEPS / 60` and not a fraction more.
2. **The `damage` event's field names.** The accumulator above assumes `{ target, amount, type }`. Confirm against `Combat.js`'s emit (around line 478) and correct if they differ.

This file is named `sp-equivalence.mjs`, **not** `.test.mjs`, so `npm test` does not run it — it takes about a minute and needs a browser. It is run explicitly by the tasks that need it.

- [ ] **Step 5: Capture the HEAD baseline**

```bash
git stash push --include-untracked
node tests/sp-equivalence.mjs --out /tmp/baseline-HEAD.json
git stash pop
mkdir -p reviews/round8
cp /tmp/baseline-HEAD.json reviews/round8/baseline-HEAD.json
```

The baseline file is committed. Every later claim of "single-player unchanged" names this file. That is process rule 3 — a number with no on-disk source behind it escapes into the record.

- [ ] **Step 6: Verify it is deterministic**

Run `node tests/sp-equivalence.mjs` twice, diff the two outputs. Expected: identical. If not, the fixture has a real time source or an unseeded RNG in it — find it before continuing; a non-deterministic baseline is worse than none.

- [ ] **Step 7: Commit**

```bash
git add tests/run.mjs tests/sp-equivalence.mjs package.json reviews/round8/baseline-HEAD.json
git commit -m "Fingerprint the run HEAD plays, before anything is allowed to change it"
```

---

# WAVE B — the roster

## Task 5: `Roster` system, player registration, engine wiring

**Files:**
- Create: `src/systems/Roster.js`
- Modify: `src/entities/Player.js:144-286` (`init`), `:1127` (`dispose`), `src/main.js:52-53`
- Test: `tests/roster.test.mjs` (create), `tests/targeting.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces — every later task depends on these exact names:
  - `ctx.roster.all` → `Player[]`, every registered player entity, host and pawns.
  - `ctx.roster.count` → `number`.
  - `ctx.roster.local` → the viewer's own pawn, `=== ctx.player`, or `null`.
  - `ctx.roster.alive` → `Player[]`, freshly allocated. **Non-hot-path only** (UI, reports).
  - `ctx.roster.nearest(pos, out?)` → nearest targetable player or `null`. `pos` is any `{x, z}`. When `out` is given it is filled as `{ player, dist }` and reused, so hot callers allocate nothing.
  - `ctx.roster.distanceToNearest(pos)` → `number`, `Infinity` when the roster is empty.
  - `ctx.roster.forEachTargetable(fn)` → calls `fn(player)` per targetable player. No allocation.
  - `Roster.targetable(p)` → `boolean`; `true` when `p` is present, `p.alive !== false` and `p.downed !== true`.
  - `acquireTarget(roster, pos, current)` → the player a hunter at `pos` should fight, or `null`. Sticky. Task 6 calls this per enemy.
  - `SWITCH_MARGIN` → `0.8`. Exported so the test can assert both sides of the boundary rather than hard-coding it twice.

**On `downed`.** P1 defines the flag and honours it in the query; **P3 implements the behaviour around it**. Until P3 lands, no code sets `downed`, so the filter is a no-op. Writing it now means P3 never has to revisit the targeting hot path.

**On layering.** `Roster` lives in `src/systems/`, **not** `src/net/`. `Enemy.js` reaching into `ctx.coop` for a target would invert the boundary `Coop.js`'s own header exists to maintain — it calls itself "the seam between the netcode and the game" so that gameplay never imports net. Do not put this in `Coop.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/roster.test.mjs`:

```js
/**
 * The Roster — registration, and the one query enemies use to pick a target.
 *
 *   node tests/roster.test.mjs
 */
import { Roster } from '../src/systems/Roster.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = (x, z, extra = {}) => ({ isPlayer: true, alive: true, position: { x, y: 0, z }, ...extra });

function fresh() {
  const ctx = { player: null };
  const r = new Roster();
  r.init(ctx);
  return { r, ctx };
}

console.log('registration');
{
  const { r, ctx } = fresh();
  ok(ctx.roster === r, 'publishes itself on ctx');
  const a = P(0, 0);
  r.add(a);
  r.add(a);
  ok(r.count === 1, `adding twice registers once (got ${r.count})`);
  r.remove(a);
  ok(r.count === 0, 'remove works');
  r.remove(a);
  ok(r.count === 0, 'removing twice is harmless');
}

console.log('nearest — the empty and single cases');
{
  const { r } = fresh();
  ok(r.nearest({ x: 0, z: 0 }) === null, 'empty roster returns null');
  ok(r.distanceToNearest({ x: 0, z: 0 }) === Infinity, 'empty roster distance is Infinity');
  const solo = P(3, 4);
  r.add(solo);
  ok(r.nearest({ x: 0, z: 0 }) === solo, 'single-entry roster returns that entry');
  ok(Math.abs(r.distanceToNearest({ x: 0, z: 0 }) - 5) < 1e-9, 'horizontal distance is 3-4-5');
}

console.log('nearest — picks the nearer, ignores height');
{
  const { r } = fresh();
  const near = P(2, 0);
  const far = P(20, 0);
  far.position.y = -500;
  r.add(far); r.add(near);
  ok(r.nearest({ x: 0, z: 0 }) === near, 'nearer wins regardless of insertion order');
  ok(r.nearest({ x: 30, z: 0 }) === far, 'query point decides, not registration order');
}

console.log('targetable — dead and downed are excluded');
{
  const { r } = fresh();
  const dead = P(1, 0, { alive: false });
  const downed = P(2, 0, { downed: true });
  const up = P(50, 0);
  r.add(dead); r.add(downed); r.add(up);
  ok(r.nearest({ x: 0, z: 0 }) === up, 'skips dead and downed even though they are far nearer');
  ok(r.count === 3, 'but they stay registered');
  ok(r.alive.length === 1, `alive lists only the targetable one (got ${r.alive.length})`);
}

console.log('targetable — a roster where nobody is targetable');
{
  const { r } = fresh();
  r.add(P(1, 0, { alive: false }));
  r.add(P(2, 0, { downed: true }));
  ok(r.nearest({ x: 0, z: 0 }) === null, 'returns null rather than a dead player');
  ok(r.distanceToNearest({ x: 0, z: 0 }) === Infinity, 'distance is Infinity');
}

console.log('nearest — ties are stable');
{
  const { r } = fresh();
  const first = P(5, 0);
  const second = P(-5, 0);
  r.add(first); r.add(second);
  ok(r.nearest({ x: 0, z: 0 }) === first, 'an exact tie resolves to the earlier registration');
  ok(r.nearest({ x: 0, z: 0 }) === first, 'and does so repeatably');
}

console.log('nearest — the out parameter allocates nothing');
{
  const { r } = fresh();
  const p = P(3, 4);
  r.add(p);
  const out = { player: null, dist: 0 };
  const got = r.nearest({ x: 0, z: 0 }, out);
  ok(got === p, 'still returns the player');
  ok(out.player === p && Math.abs(out.dist - 5) < 1e-9, 'fills the out object');
}

console.log('local');
{
  const { r, ctx } = fresh();
  const me = P(0, 0);
  r.add(me);
  ok(r.local === null, 'null before ctx.player exists');
  ctx.player = me;
  ok(r.local === me, 'tracks ctx.player');
}

console.log('forEachTargetable');
{
  const { r } = fresh();
  r.add(P(0, 0)); r.add(P(1, 0, { alive: false })); r.add(P(2, 0));
  const seen = [];
  r.forEachTargetable((p) => seen.push(p.position.x));
  ok(seen.length === 2 && seen[0] === 0 && seen[1] === 2, `visits only targetable, in order (got ${JSON.stringify(seen)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

Then create `tests/targeting.test.mjs` — the sticky-acquisition rule, tested against the roster it queries rather than against an Enemy and a stage. Isolating it is what lets both ends of the hysteresis range be stated as assertions:

```js
/**
 * Sticky nearest-target acquisition and its hysteresis.
 *
 *   node tests/targeting.test.mjs
 *
 * Exercises the acquisition rule directly rather than standing up an Enemy:
 * the rule is the fix, and isolating it is what lets both ends of the
 * hysteresis range be stated as assertions.
 */
import { Roster, acquireTarget, SWITCH_MARGIN } from '../src/systems/Roster.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = (x, z, extra = {}) => ({ isPlayer: true, alive: true, position: { x, y: 0, z }, ...extra });

function rosterOf(...players) {
  const r = new Roster();
  r.init({ player: players[0] ?? null });
  players.forEach((p) => r.add(p));
  return r;
}

console.log('acquisition with no current target');
{
  const a = P(10, 0), b = P(3, 0);
  const r = rosterOf(a, b);
  ok(acquireTarget(r, { x: 0, z: 0 }, null) === b, 'takes the nearest when it has none');
  ok(acquireTarget(r, { x: 0, z: 0 }, undefined) === b, 'undefined behaves as none');
}

console.log('stickiness — a marginally nearer player does NOT steal the target');
{
  const held = P(10, 0);
  const rival = P(9, 0);       // 10% nearer; margin is 20%
  const r = rosterOf(held, rival);
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === held, 'keeps the held target at 90% distance');
}

console.log('stickiness — a decisively nearer player DOES steal it');
{
  const held = P(10, 0);
  const rival = P(5, 0);       // 50% nearer; well inside the margin
  const r = rosterOf(held, rival);
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === rival, 'switches at 50% distance');
}

console.log('the margin boundary, from both sides');
{
  const held = P(10, 0);
  const r0 = rosterOf(held, P(10 * SWITCH_MARGIN + 0.01, 0));
  ok(acquireTarget(r0, { x: 0, z: 0 }, held) === held, 'just outside the margin: holds');
  const inner = P(10 * SWITCH_MARGIN - 0.01, 0);
  const r1 = rosterOf(held, inner);
  ok(acquireTarget(r1, { x: 0, z: 0 }, held) === inner, 'just inside the margin: switches');
}

console.log('two players standing together do not cause oscillation');
{
  // The failure this margin exists to prevent: with SWITCH_MARGIN at 1.0 the
  // enemy flips every evaluation. Alternate which is imperceptibly nearer and
  // assert the target never moves.
  const a = P(10.00, 0), b = P(10.01, 0);
  const r = rosterOf(a, b);
  let held = acquireTarget(r, { x: 0, z: 0 }, null);
  const firstPick = held;
  let switches = 0;
  for (let i = 0; i < 100; i++) {
    a.position.x = 10 + (i % 2 ? 0.01 : -0.01);
    b.position.x = 10 + (i % 2 ? -0.01 : 0.01);
    const next = acquireTarget(r, { x: 0, z: 0 }, held);
    if (next !== held) switches++;
    held = next;
  }
  ok(switches === 0, `no switches over 100 jittered evaluations (got ${switches})`);
  ok(held === firstPick, 'still on the original pick');
}

console.log('a dead or downed target is dropped immediately, margin or not');
{
  const held = P(1, 0);
  const other = P(40, 0);
  const r = rosterOf(held, other);
  held.alive = false;
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === other, 'dead target released for a far one');
  held.alive = true; held.downed = true;
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === other, 'downed target released too');
}

console.log('an empty roster yields null, not a stale target');
{
  const held = P(1, 0);
  const r = rosterOf(held);
  r.remove(held);
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === null, 'target that left the roster is dropped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `node tests/roster.test.mjs` and `node tests/targeting.test.mjs`
Expected: both FAIL — cannot resolve `../src/systems/Roster.js`.

- [ ] **Step 3: Write `Roster`**

Create `src/systems/Roster.js`:

```js
/**
 * Every player in the run, and the one query that picks between them.
 *
 * `ctx.player` means three different things across this codebase: the player
 * this screen belongs to (HUD, camera, the local half of Combat), the one
 * player the authority simulates (Enemy, Director), and the owner of a piece of
 * gameplay state (Items, Progression). The first is correct and stays. This
 * system exists to answer the second, so that an enemy asks *which* player
 * rather than assuming there is one.
 *
 * It deliberately does not import THREE and does not know what a Player is: any
 * object with a `position` and an `alive` flag can register, which is what lets
 * a client register its interpolated `PlayerView`s for the HUD's teammate bars
 * without pulling the entity layer into the net layer.
 *
 * Single-player registers exactly one entity, `nearest()` returns it for every
 * query, and every number in the game is what it was before this file existed.
 * That invariant is the whole safety argument for the migration; see
 * `tests/sp-equivalence.mjs`.
 */

// Scratch for `distanceToNearest`, so the hot path allocates nothing.
const _q = { player: null, dist: Infinity };

export class Roster {
  constructor() {
    this.all = [];
  }

  init(ctx) {
    this.ctx = ctx;
    ctx.roster = this;
  }

  /**
   * A legal target: present, alive, and not downed.
   *
   * `downed` is honoured here from the start even though nothing sets it yet.
   * Revive (P3) introduces a state where a player is registered, rendered and
   * addressable but must not be attacked; putting the check in now means that
   * round never has to reopen the targeting hot path.
   */
  static targetable(p) {
    return !!p && p.alive !== false && p.downed !== true;
  }

  add(p) {
    if (!p || this.all.indexOf(p) >= 0) return p;
    this.all.push(p);
    return p;
  }

  remove(p) {
    const i = this.all.indexOf(p);
    if (i >= 0) this.all.splice(i, 1);
  }

  get count() { return this.all.length; }

  /** The pawn this machine's camera and HUD follow. */
  get local() { return this.ctx?.player ?? null; }

  /**
   * Freshly allocated — for UI and reports, never for a per-enemy per-step
   * call. Hot paths use `nearest` or `forEachTargetable`, which allocate
   * nothing.
   */
  get alive() { return this.all.filter(Roster.targetable); }

  /**
   * Nearest targetable player to `pos`, by horizontal distance, or null.
   *
   * Horizontal because every consumer is a ground-based engagement range and
   * `dist2D` is already what `Enemy` compares against; including height would
   * make an enemy on a ledge below you read as further away than one across the
   * arena and change engagement ranges the encounter design is tuned around.
   *
   * Ties resolve to the earlier registration, which makes the result stable
   * across steps: two players standing exactly together must not make every
   * enemy in the arena flip target every time this is called.
   */
  nearest(pos, out = null) {
    let best = null;
    let bestD = Infinity;
    const list = this.all;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!Roster.targetable(p)) continue;
      const dx = p.position.x - pos.x;
      const dz = p.position.z - pos.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (out) { out.player = best; out.dist = best ? bestD : Infinity; }
    return best;
  }

  /** Horizontal distance to the nearest targetable player, or Infinity. */
  distanceToNearest(pos) {
    this.nearest(pos, _q);
    return _q.dist;
  }

  /** Visit every targetable player in registration order. Allocates nothing. */
  forEachTargetable(fn) {
    const list = this.all;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (Roster.targetable(p)) fn(p);
    }
  }
}

/**
 * How much nearer a rival has to be before a hunter will change its mind.
 *
 * At 1.0 there is no hysteresis at all and two players standing together make
 * every enemy in the arena flip target on every evaluation — the pack visibly
 * shivers and no attack ever completes its wind-up against one person. Near 0
 * an enemy never switches, so it will chase one survivor across the whole stage
 * past a teammate standing on top of it. 0.8 means "meaningfully closer".
 */
export const SWITCH_MARGIN = 0.8;

const _acq = { player: null, dist: Infinity };

/**
 * Pick who a hunter at `pos` is fighting, given who it is fighting now.
 *
 * Sticky: the current target is kept until it stops being targetable, leaves
 * the roster, or someone else is decisively nearer. Everything about co-op
 * combat reading as coherent rather than twitchy is in that word.
 *
 * Lives here rather than in `Enemy.js` because it is a question about the
 * roster, and because a 1600-line entity file should not be exporting symbols
 * that exist for a test.
 */
export function acquireTarget(roster, pos, current) {
  if (!roster) return null;
  roster.nearest(pos, _acq);
  const best = _acq.player;
  if (!best) return null;
  if (!current || !Roster.targetable(current) || roster.all.indexOf(current) < 0) return best;
  if (best === current) return current;
  const dx = current.position.x - pos.x;
  const dz = current.position.z - pos.z;
  const currentDist = Math.sqrt(dx * dx + dz * dz);
  return _acq.dist < currentDist * SWITCH_MARGIN ? best : current;
}
```

- [ ] **Step 4: Run both tests to verify they pass**

Run: `node tests/roster.test.mjs` — expected PASS on all 21 assertions, exit 0.
Run: `node tests/targeting.test.mjs` — expected PASS on all 13 assertions, exit 0.

- [ ] **Step 5: Register players**

In `src/entities/Player.js`, method `init`, immediately after the existing `ctx.combat?.register?.(this);` (line 281):

```js
    // Combat decides what can be hit; the roster decides who can be *chosen*.
    // Both registrations are unconditional — a remote pawn is as much a player
    // as the local one, and the whole of N-1 was that nothing ever asked which.
    ctx.roster?.add?.(this);
```

In `Player.dispose()` (line 1127), as its first statement:

```js
    this.ctx?.roster?.remove?.(this);
```

`Coop._spawnPawn` and `Coop._despawnPawn` already call `init` and `dispose`, so pawns join and leave the roster with no change to `src/net/Coop.js`.

- [ ] **Step 6: Wire it into the engine**

In `src/main.js`, add the import alongside the other systems and insert the registration **between** `new Combat()` (line 52) and `new Player()` (line 53):

```js
// Before Player, which registers itself into it during `init` — the same
// ordering reason Combat sits above.
engine.add(new Roster());
```

- [ ] **Step 7: Prove single-player did not move**

```bash
node tests/sp-equivalence.mjs --out reviews/round8/roster-after.json
node -e "const a=require('./reviews/round8/baseline-HEAD.json'),b=require('./reviews/round8/roster-after.json');const s=JSON.stringify;console.log(s(a)===s(b)?'IDENTICAL':'DIFFERS');process.exit(s(a)===s(b)?0:1)"
```

Expected: `IDENTICAL`, exit 0. **If it differs, stop and report — do not adjust the harness.** A roster of one that changes a single-player number means the registration changed evaluation order somewhere, and that is a finding, not a nuisance.

- [ ] **Step 8: Build, full test run, commit**

```bash
node node_modules/vite/bin/vite.js build
npm test
git add src/systems/Roster.js src/entities/Player.js src/main.js tests/roster.test.mjs tests/targeting.test.mjs reviews/round8/roster-after.json
git commit -m "Ask which player, in a game that only ever had one"
```

---

# WAVE C — targeting

Tasks 6 and 7 run in parallel. They share one interface and no files.

**The contract between them, fixed before either starts:**

```js
// src/systems/Director.js — Task 7 implements, Task 6 calls
denyHealing(seconds, victim)   // victim: a player entity; required
healingDeniedFor(player)       // -> boolean
```

Task 6 calls `ctx.director?.denyHealing?.(em.denyTime, this.targetPlayer)`. Task 7 makes that signature real. Neither needs to read the other's diff.

## Task 6: Enemy targeting

**Files:**
- Modify: `src/entities/Enemy.js` — the sites listed below and nothing else
- Test: none of its own. The acquisition contract is covered by `tests/targeting.test.mjs`, written and satisfied in Task 5. This task is gated by the grep in Step 7, the equivalence run in Step 8, and Task 8's probe.

**Interfaces:**
- Consumes: `ctx.roster.nearest(pos, out)`, `Roster.targetable(p)`, `ctx.roster.forEachTargetable(fn)` (Task 5); `ctx.director.denyHealing(seconds, victim)` (Task 7).
- Produces: `enemy.targetPlayer` — the player entity this enemy is currently fighting, or `null`. Task 8's probe reads it.

**The finding that makes this small.** Every steering behaviour, state transition and attack selection in `Enemy.js` — lines 571 through 1614 — already reads three *per-enemy* fields: `this.target` (a `Vector3`), `this.distToPlayer` and `this.hasLOS`. They were always per-enemy. The only thing wrong is the four lines at `Enemy.js:449-455` that fill them from a global. **Do not touch the FSM.**

- [ ] **Step 1: Import the acquisition rule**

`acquireTarget` and `SWITCH_MARGIN` were written in Task 5 and live in `src/systems/Roster.js`. This step only imports them and adds the pacing constant.

Add the import at the top of `src/entities/Enemy.js`:

```js
import { Roster, acquireTarget } from '../systems/Roster.js';
```

And near the top-level helpers (beside `hurtPlayer`, around line 32), add:

```js
/**
 * How often an enemy reconsiders its target, in seconds.
 *
 * Too long and an enemy keeps swinging at a player who has already run out of
 * the fight; too short and 60 units re-query every step for a decision that
 * changes a few times a minute. Staggered per unit so they never land together
 * — the same reason `losT` is staggered at `Enemy.js:459`.
 */
const RETARGET_INTERVAL = 0.5;
```

- [ ] **Step 2: Confirm the contract is already green**

Run: `node tests/targeting.test.mjs`
Expected: PASS on all 13 assertions (Task 5 wrote and satisfied them). If this fails, Task 5 is not actually complete — stop and report rather than implementing around it.

- [ ] **Step 3: Change the two damage helpers to take an explicit victim**

This is the signature change that makes the rest impossible to get subtly wrong: there is no longer a default victim to fall back to.

Replace `hurtPlayer` (line 35) and `statusPlayer` (line 61):

```js
/**
 * Route through Combat's one damage path; fall back only if it isn't up.
 *
 * The victim is passed rather than looked up. It used to read `ctx.player`,
 * which on a host is the host's own survivor — so every directed attack in a
 * co-op session landed on one person no matter who it was aimed at. Measured at
 * 78 directed hits on the host and 0 on a pawn standing 3 m away over 30 s.
 */
function hurtPlayer(ctx, victim, source, amount, type, at) {
  const p = victim;
  if (!p || p.alive === false) return;
  _info.source = source;
  _info.procCoefficient = 0;
  _info.type = type;
  if (at) _info.position.copy(at); else _info.position.copy(source.position);
  const c = ctx.combat;
  if (c && c.applyDamage) c.applyDamage(p, amount, _info);
  else if (p.takeDamage) p.takeDamage(amount, _info);
}

/** Elite on-hit riders, expressed as Combat's own status types. */
function statusPlayer(ctx, victim, source, type, count = 1) {
  const c = ctx.combat;
  if (c && c.applyStatus && victim) c.applyStatus(victim, type, source, count);
}
```

And fix `explodeAt`'s fallback branch (line 54). Its main path already delegates to `combat.explode`, which is team-based and correct — that accident is why area damage did reach guests. Only the fallback is wrong:

```js
/** Sphere blast that respects teams, armour and i-frames. */
function explodeAt(ctx, source, point, radius, damage, status) {
  const c = ctx.combat;
  if (c && c.explode) {
    c.explode(point, radius, damage, source, { proc: 0, status: status || null, type: 'blast' });
    return;
  }
  // Fallback only — reached when Combat is not up. It has to sweep the roster
  // for the same reason `combat.explode` does: a blast is a place, not a
  // person, and everyone standing in it is in it.
  ctx.roster?.forEachTargetable?.((p) => {
    if (dist2D(p.position, point) < radius + (p.radius || 0.45)) {
      hurtPlayer(ctx, p, source, damage, 'blast', point);
    }
  });
}
```

- [ ] **Step 4: Replace target acquisition in `fixedUpdate`**

Replace `Enemy.js:449-455`:

```js
    const p = ctx.player;
    if (p && p.position) {
      this.target.copy(p.position);
      this.distToPlayer = dist2D(this.position, p.position);
    } else {
      this.distToPlayer = 999;
    }
```

with:

```js
    // Who this unit is fighting. Re-evaluated on a stagger rather than every
    // step: the answer changes a few times a minute, and 60 units re-querying
    // the roster every step would pay for that sixty times a frame. Dropped
    // immediately — not on the next tick — when the held target stops being
    // targetable, so an enemy never spends half a second swinging at a corpse.
    this.retargetT -= h;
    if (this.retargetT <= 0 || !Roster.targetable(this.targetPlayer)) {
      this.retargetT = RETARGET_INTERVAL;
      this.targetPlayer = acquireTarget(ctx.roster, this.position, this.targetPlayer);
    }

    // Everything below this line — the FSM, the steering, the attack selection —
    // reads these three fields and nothing else. They were always per-enemy;
    // only the source they were filled from was wrong.
    const p = this.targetPlayer;
    if (p && p.position) {
      this.target.copy(p.position);
      this.distToPlayer = dist2D(this.position, p.position);
    } else {
      this.distToPlayer = 999;
    }
```

Initialise the two new fields in the `Enemy` constructor, beside the existing `this.target = new THREE.Vector3();` (line 166):

```js
    this.targetPlayer = null;
    // Staggered by unit so sixty enemies never re-query on one step, the same
    // way `losT` is staggered. `this.noise` is the per-unit jitter the class
    // already carries.
    this.retargetT = 0;
```

And in the same place the constructor sets `this.noise`, seed the first evaluation:

```js
    this.retargetT = this.noise * RETARGET_INTERVAL;
```

If `this.noise` is not yet assigned at that point in the constructor, place this line immediately after the line that assigns it.

- [ ] **Step 5: Rewrite the remaining `ctx.player` sites**

Apply each of these exactly. Every one is in `src/entities/Enemy.js`.

| Line | Before | After |
|---|---|---|
| 471–473 | `hurtPlayer(ctx, this, this.damage * em.auraDps, 'burn');` / `statusPlayer(ctx, this, 'burn', 1);` | `hurtPlayer(ctx, this.targetPlayer, this, this.damage * em.auraDps, 'burn');` / `statusPlayer(ctx, this.targetPlayer, this, 'burn', 1);` |
| 486 | `ctx.director?.denyHealing?.(em.denyTime);` | `ctx.director?.denyHealing?.(em.denyTime, this.targetPlayer);` |
| 488 | `hurtPlayer(ctx, this, this.damage * em.thornDps, 'wither');` | `hurtPlayer(ctx, this.targetPlayer, this, this.damage * em.thornDps, 'wither');` |
| 499 | `const p = ctx.player;` (in `checkLOS`) | `const p = this.targetPlayer;` |
| 600 | `if (st === S.IDLE \|\| !ctx.player) {` | `if (st === S.IDLE \|\| !this.targetPlayer) {` |
| 616 | `return pursue(d, this, this.target, ctx.player?.velocity, speed, 0.25);` | `return pursue(d, this, this.target, this.targetPlayer?.velocity, speed, 0.25);` |
| 802 | `if (combatFacing && ctx.player) {` | `if (combatFacing && this.targetPlayer) {` |
| 819 | `if (this.gcd > 0 \|\| !ctx.player \|\| !this.hasLOS) return -1;` | `if (this.gcd > 0 \|\| !this.targetPlayer \|\| !this.hasLOS) return -1;` |
| 865 | `const p = ctx.player;` (melee cone) | `const p = this.targetPlayer;` |
| 869–871 | `hurtPlayer(ctx, this, this.damage, 'melee');` / `statusPlayer(ctx, this, 'burn', 2);` / `statusPlayer(ctx, this, 'slow', 1);` | `hurtPlayer(ctx, p, this, this.damage, 'melee');` / `statusPlayer(ctx, p, this, 'burn', 2);` / `statusPlayer(ctx, p, this, 'slow', 1);` |
| 948 | `const p = ctx.player;` (`chargeContact`) | `const p = this.targetPlayer;` |
| 1017 | `const p = ctx.player;` (`pullPlayer`) | `const p = this.targetPlayer;` |
| 1159 | `combat.applyDamage(this, this.health, { source: ctx.player, procCoefficient: 0 });` | see below |
| 1186 | `if (ctx.player) {` (anim look-at) | `if (this.targetPlayer) {` |
| 1303 | `if (ctx.player && e.distToPlayer < 70) fsm.set(S.CHASE, ctx);` | `if (e.targetPlayer && e.distToPlayer < 70) fsm.set(S.CHASE, ctx);` |
| 1309 | `if (!ctx.player) { fsm.set(S.IDLE, ctx); return; }` | `if (!e.targetPlayer) { fsm.set(S.IDLE, ctx); return; }` |
| 1343 | `if (!ctx.player) { fsm.set(S.IDLE, ctx); return; }` | `if (!e.targetPlayer) { fsm.set(S.IDLE, ctx); return; }` |
| 1547 | `const p = ctx.player;` (dive proximity) | `const p = e.targetPlayer;` |

Also update every other `hurtPlayer(ctx, this, …)` and `statusPlayer(ctx, this, …)` call not listed above to pass the victim as the second argument — `grep -n "hurtPlayer(\|statusPlayer(" src/entities/Enemy.js` and confirm **no call site has the old arity** when you are done. The compiler will not catch this; the grep is the check.

For **line 1159** (the pest's self-detonation), replace with:

```js
        // Credited to whoever it was attacking, not to `ctx.player`. On a host
        // that read as the host's own survivor, so a pest that killed itself
        // completing an attack on a guest paid the host the gold.
        combat.applyDamage(this, this.health, { source: this.targetPlayer ?? null, procCoefficient: 0 });
```

- [ ] **Step 6: Make `fireBeam` hit everyone on the segment**

Replace the body of `fireBeam` (line 1110) after `this.anim.beamLen = ...` — the aiming half keeps reading `this.targetPlayer`, the damage half sweeps the roster:

```js
    const aim = this.targetPlayer;
    if (aim) {
      _v3.copy(aim.position);
      _v3.y += 1.0;
      const dy = _v3.y - origin.y;
      const dh = Math.hypot(_v3.x - origin.x, _v3.z - origin.z);
      dir.y = dh > 0.01 ? dy / dh : 0;
      dir.normalize();
    }
    let len = a.range;
    const hit = ctx.stage && ctx.stage.raycast ? ctx.stage.raycast(origin, dir, a.range) : null;
    if (hit) len = hit.distance;
    this.anim.beamLen = Math.min(len, BEAM_MAX_LEN);

    // Aimed at one player, but it damages everyone it passes through. A
    // hitscan beam that goes straight through your teammate without touching
    // them is the kind of thing that reads as broken rather than as a rule.
    ctx.roster?.forEachTargetable?.((p) => {
      _v3.copy(p.position);
      _v3.y += 1.0;
      _v3.sub(origin);
      const t = clamp(_v3.dot(dir), 0, len);
      const px = origin.x + dir.x * t - (p.position.x);
      const py = origin.y + dir.y * t - (p.position.y + 1.0);
      const pz = origin.z + dir.z * t - (p.position.z);
      const r = radius + (p.radius || 0.45);
      if (px * px + py * py + pz * pz < r * r) hurtPlayer(ctx, p, this, damage, 'beam');
    });
```

- [ ] **Step 7: Confirm no `ctx.player` remains in the file**

Run: `grep -n "ctx\.player" src/entities/Enemy.js`
Expected: **no output.** Every one of the 21 is now either `this.targetPlayer`, `e.targetPlayer`, an explicit victim parameter or a roster sweep.

- [ ] **Step 8: Prove single-player did not move**

```bash
node tests/sp-equivalence.mjs --out reviews/round8/targeting-after.json
node -e "const a=require('./reviews/round8/baseline-HEAD.json'),b=require('./reviews/round8/targeting-after.json');const s=JSON.stringify;console.log(s(a)===s(b)?'IDENTICAL':'DIFFERS');process.exit(s(a)===s(b)?0:1)"
```

Expected: `IDENTICAL`. With one player in the roster, `acquireTarget` returns that player on every call and the three fields are filled from exactly the object `ctx.player` pointed at.

**If it differs, stop and report the specific accumulator that moved.** Do not adjust the harness and do not "explain" the difference — a roster of one that changes a single-player number is a finding.

- [ ] **Step 9: Build, full test run, commit**

```bash
node node_modules/vite/bin/vite.js build
npm test
git add src/entities/Enemy.js reviews/round8/targeting-after.json
git commit -m "Every enemy asks who it is fighting, and can be told someone else"
```

---

## Task 7: Per-player heal denial and roster-aware spawn placement

**Files:**
- Modify: `src/systems/Director.js:340-364` (`denyHealing`, `healingDenied`, `enforceHealDenial`), `:105` and `:751` (state init/reset), `:598-628` (spawn point selection), `src/world/realms/FinalBoss.js` (its `denyHealing` call), `src/ui/HUD.js` (the `healingDenied` read)
- Test: `tests/heal-denial.test.mjs` (create)

**Interfaces:**
- Consumes: `ctx.roster.forEachTargetable(fn)`, `ctx.roster.distanceToNearest(pos)`, `ctx.roster.local` (Task 5).
- Produces — Task 6 calls the first of these and nothing else:
  - `denyHealing(seconds, victim)` — `victim` is a player entity and is **required**. A call with no victim is a no-op, deliberately: silently falling back to "everybody" is the bug being fixed.
  - `healingDeniedFor(player)` → `boolean`.

**Background.** `Director.denyHealing` writes a single global `healDenyUntil`, and `enforceHealDenial` holds a single `this._healCap`. So one withering elite currently denies healing to **everyone on the map** — including players it has no line of sight to, which is exactly the counterplay the method's own comment says it is preserving. The caller at `Enemy.js:486` already knows which player it has LOS to.

- [ ] **Step 1: Write the failing test**

Create `tests/heal-denial.test.mjs`:

```js
/**
 * Per-player healing denial, and spawn placement that respects every player.
 *
 *   node tests/heal-denial.test.mjs
 */
import { Director } from '../src/systems/Director.js';
import { Roster } from '../src/systems/Roster.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = (x, z) => ({ isPlayer: true, alive: true, health: 100, position: { x, y: 0, z } });

function fresh(...players) {
  const roster = new Roster();
  const ctx = { time: 0, player: players[0] ?? null };
  roster.init(ctx);
  players.forEach((p) => roster.add(p));
  const d = new Director();
  d.ctx = ctx;
  d.healDenyUntil = -1;
  return { d, ctx, roster, players };
}

console.log('denial is scoped to the named victim');
{
  const a = P(0, 0), b = P(50, 0);
  const { d, ctx } = fresh(a, b);
  d.denyHealing(2, a);
  ok(d.healingDeniedFor(a) === true, 'the named victim is denied');
  ok(d.healingDeniedFor(b) === false, 'the other player is not');
}

console.log('a call with no victim is a no-op, not a global');
{
  const a = P(0, 0), b = P(50, 0);
  const { d } = fresh(a, b);
  d.denyHealing(2);
  ok(d.healingDeniedFor(a) === false && d.healingDeniedFor(b) === false,
     'nobody is denied — silently falling back to everyone is the bug being fixed');
}

console.log('overlapping elites top the same victim up');
{
  const a = P(0, 0);
  const { d, ctx } = fresh(a);
  d.denyHealing(2, a);
  ctx.time = 1;
  d.denyHealing(2, a);        // expires at 3, not 2
  ctx.time = 2.5;
  ok(d.healingDeniedFor(a) === true, 'still denied after the first window would have lapsed');
  ctx.time = 3.5;
  ok(d.healingDeniedFor(a) === false, 'lapses at the later expiry');
}

console.log('enforcement caps only the denied player');
{
  const a = P(0, 0), b = P(50, 0);
  const { d, ctx } = fresh(a, b);
  d.denyHealing(5, a);
  d.enforceHealDenial(ctx);
  a.health = 150; b.health = 150;
  d.enforceHealDenial(ctx);
  ok(a.health === 100, `denied player cannot heal (got ${a.health})`);
  ok(b.health === 150, `undenied player heals normally (got ${b.health})`);
}

console.log('damage lowers the ceiling for the denied player');
{
  const a = P(0, 0);
  const { d, ctx } = fresh(a);
  d.denyHealing(5, a);
  d.enforceHealDenial(ctx);
  a.health = 40;                   // took a hit
  d.enforceHealDenial(ctx);
  a.health = 90;                   // tried to heal
  d.enforceHealDenial(ctx);
  ok(a.health === 40, `ceiling followed the damage down (got ${a.health})`);
}

console.log('spawn distance respects every player, not just the first');
{
  const near = P(0, 0), far = P(200, 0);
  const { d, roster } = fresh(far, near);
  // A point 40 m from `far` but 160 m from `near` is fine; a point 5 m from
  // `near` must be rejected however far it is from `far`.
  ok(roster.distanceToNearest({ x: 5, z: 0 }) < 34, 'a point beside the second player reads as close');
  ok(roster.distanceToNearest({ x: 100, z: 0 }) >= 34, 'a point between both reads as far');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/heal-denial.test.mjs`
Expected: FAIL — `d.healingDeniedFor is not a function`.

- [ ] **Step 3: Move the denial onto the player**

In `src/systems/Director.js`, replace `denyHealing` (line 340) and the `healingDenied` getter (line 346):

```js
  /**
   * Lock one player's healing for `seconds`.
   *
   * The victim is required and there is deliberately no fallback. This used to
   * write a single `healDenyUntil` on the Director, so one withering elite
   * denied healing to every player on the map — including ones it had no line
   * of sight to, which is precisely the counterplay the LOS test at
   * `Enemy.js:485` exists to preserve. A call that cannot name a victim should
   * do nothing rather than quietly do it to everyone.
   */
  denyHealing(seconds, victim) {
    if (!victim) return;
    const t = (this.ctx?.time ?? 0) + (seconds || 2);
    if (t > (victim._healDenyUntil ?? -1)) victim._healDenyUntil = t;
  }

  /** Read by the HUD for its own player. Cosmetic — safe on clients too. */
  healingDeniedFor(player) {
    if (!player) return false;
    return (this.ctx?.time ?? 0) < (player._healDenyUntil ?? -1);
  }

  /** Back-compat for the HUD's single-player read: the local player's answer. */
  get healingDenied() { return this.healingDeniedFor(this.ctx?.roster?.local ?? this.ctx?.player); }
```

- [ ] **Step 4: Enforce it per player**

Replace `enforceHealDenial` (line 358):

```js
  /**
   * Enforce the lock.
   *
   * Combat.heal is the single heal path and it has no notion of a debuff, so
   * rather than reaching into it this holds a running ceiling on each denied
   * player's health: damage lowers the ceiling, healing cannot raise it. Net
   * effect is exactly RoR2's Malachite — every heal source in the game is
   * nullified at once, including ones written after this code.
   *
   * The ceiling lives on the player rather than on the Director because two
   * players can be denied by two different elites at two different times, and
   * one scalar cannot hold both.
   */
  enforceHealDenial(ctx) {
    const roster = ctx.roster;
    if (!roster) return;
    const now = ctx.time ?? 0;
    roster.forEachTargetable((p) => {
      if (now >= (p._healDenyUntil ?? -1)) { p._healCap = null; return; }
      if (p._healCap == null || p.health < p._healCap) p._healCap = p.health;
      else if (p.health > p._healCap) p.health = p._healCap;
    });
  }
```

Remove `this.healDenyUntil = -1;` from the constructor (line 105) and from the reset at line 751, and remove `this._healCap` from wherever it is initialised. Both are now per-player.

- [ ] **Step 5: Fix the `FinalBoss.js` caller**

Find its `denyHealing(` call and add the victim argument. If the boss has a `targetPlayer` (it will after Task 6 if it extends `Enemy`), pass that; otherwise pass `ctx.roster?.local`. State in the task report which one applied and why.

- [ ] **Step 6: Fix the HUD read**

In `src/ui/HUD.js`, the `healingDenied` read continues to work via the back-compat getter. Confirm by grep that the HUD reads `director.healingDenied` and not `director.healDenyUntil`. If it reads the raw field, change it to `director.healingDeniedFor(ctx.roster.local)`.

- [ ] **Step 7: Roster-aware spawn placement**

In `Director.js`, the spawn point loop at line ~598 currently reads:

```js
    const player = ctx.player ? ctx.player.position : _v.set(0, 0, 0);
```

and rejects on `if (d < MIN_SPAWN_DIST || d > MAX_SPAWN_DIST) continue;` where `d` is distance from that one player.

Keep the sample **anchor** as one player — `randomWalkablePoint` takes a single `minDistFrom` and re-rolling per player would change the RNG draw sequence and break single-player equivalence. Change only the **acceptance test**:

```js
    const anchor = ctx.roster?.local ?? ctx.player;
    const player = anchor ? anchor.position : _v.set(0, 0, 0);
```

and replace the distance computation inside the loop:

```js
      const p = this.samplePoint(ctx, player);
      if (!p) continue;
      // Distance from the anchor decides how far out this spawn reads; distance
      // from the *nearest* player decides whether it is legal. A guest who has
      // wandered away from the host must not have monsters materialise on top
      // of them just because they are far from whoever the anchor is.
      const d = Math.hypot(p.x - player.x, p.z - player.z);
      const dNearest = ctx.roster ? Math.min(d, ctx.roster.distanceToNearest(p)) : d;
      if (dNearest < MIN_SPAWN_DIST || d > MAX_SPAWN_DIST) continue;
```

In single-player the roster holds exactly the anchor, so `dNearest === d` and the RNG sequence is untouched.

- [ ] **Step 8: Run test to verify it passes**

Run: `node tests/heal-denial.test.mjs`
Expected: PASS on all 11 assertions, exit 0.

- [ ] **Step 9: Prove single-player did not move**

```bash
node tests/sp-equivalence.mjs --out reviews/round8/director-after.json
node -e "const a=require('./reviews/round8/baseline-HEAD.json'),b=require('./reviews/round8/director-after.json');const s=JSON.stringify;console.log(s(a)===s(b)?'IDENTICAL':'DIFFERS');process.exit(s(a)===s(b)?0:1)"
```

Expected: `IDENTICAL`. If it differs, the most likely cause is the spawn change perturbing the RNG draw order — check that `samplePoint` is still called exactly once per iteration with the same anchor.

- [ ] **Step 10: Build, full test run, commit**

```bash
node node_modules/vite/bin/vite.js build
npm test
git add src/systems/Director.js src/world/realms/FinalBoss.js src/ui/HUD.js tests/heal-denial.test.mjs reviews/round8/director-after.json
git commit -m "The elite that can see you denies you, and nobody standing elsewhere"
```

---

# WAVE D — measurement and balance

## Task 8: The N-1 measurement

**Files:**
- Create: `reviews/round8/probe-targeting.mjs`, `reviews/round8/README.md`
- Raw output: `reviews/round8/n1/{2p-lag0,2p-lag60,4p-lag0,4p-lag60}.json`

**Interfaces:**
- Consumes: `enemy.targetPlayer` (Task 6), the `?netlag=` flag (Task 3).
- Produces: the four raw JSON captures every later claim about co-op targeting cites by name.

**This is the task that decides whether P1 worked.** HEAD reads **78 directed enemy hits on the host, 0 on a pawn standing 3 m away** over 30 s, with an enemy 6.3 m from the pawn still holding the host's position as its target. The gate is that both counts are substantial and track proximity.

- [ ] **Step 1: Write the probe**

Create `reviews/round8/probe-targeting.mjs`, a Playwright driver following the pattern in `reviews/round7/coop/` — read one of those drivers first and reuse its page setup rather than inventing a second one.

It must:
1. Launch N pages, host on the first, join from the rest via the manual invite path.
2. **Gate on the game actually running before installing any instrument** — `paused === false` and `_localTick > 60` on **every** page. This is process rule 6; multiple prior instruments produced clean-looking numbers while both pages sat on survivor-select.
3. Park the pawn a fixed 3 m from the host, hold both still.
4. Over 30 s of pinned clock, accumulate per player: directed hits taken (`type !== 'blast'`), total damage taken, and the number of enemies whose `targetPlayer` is that player, sampled each second.
5. Write raw JSON — every field, no summarisation — to the named path.

- [ ] **Step 2: Run all four arms**

```bash
node reviews/round8/probe-targeting.mjs --players 2 --netlag 0  --out reviews/round8/n1/2p-lag0.json
node reviews/round8/probe-targeting.mjs --players 2 --netlag 60 --out reviews/round8/n1/2p-lag60.json
node reviews/round8/probe-targeting.mjs --players 4 --netlag 0  --out reviews/round8/n1/4p-lag0.json
node reviews/round8/probe-targeting.mjs --players 4 --netlag 60 --out reviews/round8/n1/4p-lag60.json
```

Four peers and a session under latency are both things **nobody has ever driven** (`SESSION-SUMMARY.md` §4 item 9). Expect to find something here; that is the point of the arm.

- [ ] **Step 3: Check the gate**

Assert, from the raw files:
- Directed hits on the pawn are **> 0** in every arm. HEAD reads 0. This is N-1 closed.
- Neither player takes less than 15% of total directed hits in the 2-player arms — a targeting system that technically works but sends 95% of attention one way has not fixed the experience.
- The count of enemies targeting each player tracks proximity, not identity.

- [ ] **Step 4: Fail the gate on purpose**

Substitute `acquireTarget` to always return `ctx.roster.local`, re-run the `2p-lag0` arm to a scratch path, and confirm it reproduces HEAD's shape — pawn hits back to 0. Restore. Record the sabotage output path in the report.

This is the arm that proves the instrument can detect the defect it is claiming to have fixed. Do it **one substitution at a time** — a blanket revert hides which change the gate is sensitive to.

- [ ] **Step 5: Write the README and commit**

`reviews/round8/README.md` names every raw file, the exact command that produced it, and the HEAD figure it is being compared against. Every number quoted anywhere later must be traceable to a file listed here — process rule 3.

```bash
git add reviews/round8/
git commit -m "Point a rig at the four peers and the latency nobody has driven"
```

---

## Task 9: Blazing balance pass

**Files:**
- Modify: `src/data/enemies.js` (`ELITE_STATS` — `auraDps`, `burn`)
- Raw output: `reviews/round8/balance/{before,after}.json`

**Interfaces:**
- Consumes: `tests/sp-equivalence.mjs` (Task 4), extended with an elite-aura arm.
- Produces: nothing other tasks depend on.

**The fixture this task needs does not exist yet.** `reviews/round7/coop/sp-verify/` holds only JSON — the drivers that produced it were deleted after that round, which is this repo's convention. The 97.99 dps figure quoted below is from `singleplayer-fix-verify.md` and its raw `fixed.json`, and **must be re-derived, not assumed**. Build the arm as a second export mode of `tests/sp-equivalence.mjs` rather than a new file: it already stands up the real game on a pinned clock, and a second fixture is a second thing that can be contaminated (process rule 3).

**Background — this comes from the verifier report at `reviews/round7/coop/singleplayer-fix-verify.md`, not from the spec.** The player DoT stack cap (C1) is confirmed working, but it does not close the balance problem it was aimed at. Blazing now sits at **97.99 dps** against glacial's 17.04 and plain's 8.52 at identical cost — 5.75× and 11.5×, essentially the ratio the original critique called indefensible. The cap cannot close it: **28.77 dps of the survivor is the aura's direct tick**, which no stack cap touches, so even a cap of 1 leaves ~50 dps of rider.

The remaining levers are `ELITE_STATS` (`auraDps` / `burn`) and the undocumented **+2-stack melee rider at `Enemy.js:870`**. That line is inside the block Task 6 rewrites, which is why this task runs after Wave C and not before — the same arm then measures both changes.

- [ ] **Step 1: Capture the current numbers**

Add an elite-aura arm to `tests/sp-equivalence.mjs` (`--mode elite-dps`): park a 110-HP survivor held in contact at 2.5 m from a blazing elite, then at 11 m free-roam, and accumulate dps by source — separating the aura's **direct tick** from the **burn DoT**, because the verifier established those respond to different levers. Run the same arm against glacial and plain elites at identical cost.

Write `reviews/round8/balance/before.json`. Confirm it reproduces the prior figures within a few percent: **blazing 97.99 dps** held in contact, **glacial 17.04**, **plain 8.52**, with **28.77** of blazing's total being the direct aura tick. Those come from `reviews/round7/coop/singleplayer-fix-verify.md` and its raw `sp-verify/fixed.json`.

**If they do not reproduce, stop and report before tuning anything** — either Wave C moved elite damage, or the arm is not measuring what the deleted fixture measured. Tuning against an unvalidated fixture is exactly how three wrong numbers got into round 4's reports and one into a shipped card comment.

- [ ] **Step 2: Decide the change against a stated target**

The target: blazing sits at **2–2.5× plain**, not 11.5×. State the arithmetic in the report before editing — which of `auraDps`, `burn` and the `Enemy.js:870` rider you are moving, by how much, and what each contributes to the 97.99.

Note the constraint the verifier already established: the cap does **not** save a full-health survivor standing in the aura (death at ~1.5–2 s with and without it, because stacks have not ramped by then). A tuning change that only affects the ramp will not change that outcome, so if survivability at point-blank is the goal, `auraDps` is the lever, not `burn`.

- [ ] **Step 3: Apply, re-measure, and state both ends**

Write `reviews/round8/balance/after.json`. Report blazing, glacial and plain dps side by side at **both** ends of the range — held in contact at 2.5 m *and* free-roam at 11 m — so the change cannot overshoot into the opposite failure (process rule 1).

- [ ] **Step 4: Confirm nothing else moved**

```bash
npm test
node tests/sp-equivalence.mjs --out reviews/round8/balance-after.json
```

The equivalence fingerprint **will** differ here, and that is expected and correct — this task deliberately changes single-player balance. Say so explicitly in the report and name which accumulators moved and why. This is the one task where `DIFFERS` is the right answer, and it must be argued rather than assumed.

- [ ] **Step 5: Build and commit**

```bash
node node_modules/vite/bin/vite.js build
git add src/data/enemies.js reviews/round8/balance/
git commit -m "Bring blazing back inside the range the other elites share"
```

---

# Final gate — not a task

None of the above closes P1. The last gate is in `SESSION-SUMMARY.md` §8 and no document substitutes for it:

**A full co-op run, played by hand, by two people, with at least one of them on a real remote network.** Every figure in seven rounds and in this plan is a pinned-clock probe against a scripted survivor. The balance change in Task 9, the aggro stickiness in Task 6 and the spawn placement in Task 7 are all choices only play can settle.

Until that has happened, the Co-op menu entry stays labelled **"Co-op (beta)"**.
