# The dead-host join — the reported defect is refuted, two real ones found

**Date:** 2026-08-07 · **Files:** `src/net/NetHost.js`,
`tests/nethost-dead-host-join.test.mjs` (new) · **Not committed.**

## Verdict up front

> "A peer that completes its connection while the HOST is dead on its death
> screen never gets a pawn."

**This does not happen.** Measured against unmodified `master` with a
controlled clock: a peer joining a lone, frozen, death-screened host gets a
pawn, the world un-pauses within one frame, and snapshots flow. `_holdSession`
already covers the case, by the same rule round 7 wrote for it. The finding in
`ice-quiescence-refuted.md` §"What the failed captures bought anyway" item 1 is
an inference from a capture that does not support it — see below.

Two *other* defects were found on the way, one of them fixed here.

---

## Investigation — the evidence, before the fix

### How a pawn actually gets made

`NetHost._onPeer` (`NetHost.js:125`) spawns it: `ctx.spawnRemotePlayer?.(peer.id)`
→ `Coop._spawnPawn` (`Coop.js:39`) → `new Player({local:false}).init(ctx)`,
which sets `alive = true` unconditionally (`Player.js:152`).

The load-bearing fact is **where `_onPeer` is called from**: `HostTransport`
wires it as `ready.then((p) => this.onPeer?.(p))` (`Transport.js:332`), a
promise settled by the data channels opening. It is a browser callback, not a
frame callback. `ctx.paused` cannot gate it. Neither can it gate `_onMessage`
(`ch.onmessage`, `Transport.js:115`), so HELLO is parsed under a pause too.

So candidate (c) — "pawn spawn refuses while the host's player is dead" — is
false: nothing on that path reads `ctx.player.alive` or `ctx.paused`. The only
thing the host's death changes is *where* the pawn lands, since `_spawnPawn`
anchors on `ctx.player.position` (`Coop.js:51`).

### What a pause does gate

`Engine._frame` runs the whole fixed-step loop inside `if (!ctx.paused)`
(`Engine.js:246`) and runs every system's `update` outside it (`Engine.js:262`).
So under a pause: `NetHost.fixedUpdate` does not run — no `this.tick`, no
`_checkHelloDeadlines`, and therefore no snapshot is ever *newer* than the last
— while `NetHost.update`, and with it `_holdSession`, runs every frame.

That is candidate (a), and it is the correct mechanism — but it is also the
mechanism `_holdSession` exists to defeat.

### Why `_holdSession` already handles the reported case

```
_holdSession(ctx):  live = hasLivePeer()          // c.pawn?.alive, NetHost.js:413
                    if (live) _lastLivePeer = now
                    hold = !!screen && (now - _lastLivePeer) < HOLD_GRACE
                    if (hold) ctx.paused = false
```

A freshly spawned pawn is alive, so the frame after `_onPeer` returns,
`hasLivePeer()` is true, `_lastLivePeer` is *now*, `hold` is true, and the pause
is released. Candidate (b) — "`_holdSession` doesn't account for a
connecting-but-pawnless peer" — is half right: it does not account for a
**pawnless** one (see the fix), but a connecting peer stops being pawnless
before `_holdSession` ever sees it, because `_onPeer` creates the pawn
synchronously with the client record.

### Measured, on unmodified master

Controlled-clock probe (`performance.now` overridden, `Engine._frame` order
reproduced: fixed steps only when unpaused, then `update`):

```
host dead, live peer                -> paused = false
0.5 s after that peer died          -> paused = false, snapshots 6 -> 16
2.0 s after that peer died          -> paused = true            (grace expired)
NEW peer joins the frozen dead host -> paused = false, tick 110 -> 121, 4 snapshots
```

The last line is the reported defect, and it does not reproduce.

### What the capture actually shows

`reviews/audit-fixes/after-ice-1.FAILED.json`, `detail.hostDetail.clients`:

| peer | hasPawn | helloSeen | survivorId | lastTick |
|---|---|---|---|---|
| 1 | **true** | true | ranger | 1203 |
| 3 | **true** | true | ranger | 369 |

Both joiners have pawns host-side. Peer 3's `lobbyStatusDetail.time` is 21.35 s
(host `ctx.time` at its WELCOME) and its own terminal `ctxTime` is 27.35 s with
`clientTick: 369` — 369 ticks × 1/60 = 6.15 s of *world it actually stepped*.
Peer 3 was served a live world for six seconds and then died
(`playerAlive: false`, `menuScreen: "death"`). Peer 1 the same, for 20 s.

The terminal state — host `paused: true` on its death screen, `pawnCount: 2`,
`enemiesAlive: 8` — is `_holdSession` behaving exactly as designed: every
player, host and both peers, is dead, so `hasLivePeer()` is false and the world
pauses. Nobody is being starved; there is nobody left to starve.

The arm failed because the probe's own predicate is wrong, which is the *other*
finding in `ice-quiescence-refuted.md` (item 2, "join-stage waits should key on
the specific peer's pawn, not a global count") — `hostPawnCount` reads 1 for
both recorded joins. Item 1 of that section should be read as superseded by
this file.

### The real hazard the capture *does* point at (out of scope, not fixed)

`Coop._spawnPawn` drops the joiner at `ctx.player.position + (2,·,2)` — the
host's corpse. `_holdSession`'s own doc comment already records that enemies
chase `ctx.player` and nothing else (`Enemy.js` targeting), "so with the host
down they gather on its body". A peer joining a dead host is therefore spawned
two metres from every enemy on the stage. That is a plausible reading of "you
die, your friend joins, and they get nothing" — they get a pawn and lose it in
seconds. It is `Coop.js:49-55`, outside this task's scope, and is **not**
changed here. Recommended follow-up: anchor a joiner on a live pawn, or on the
host's last *living* position, when `ctx.player.alive` is false.

---

## The fix

### 1. `_checkHelloDeadlines` could not run on a paused host (behaviour)

`NetHost.update` now sweeps the HELLO deadline when, and only when, the world
is paused:

```js
if (ctx.paused) this._checkHelloDeadlines();
```

The sweep is a wall-clock deadline (`HELLO_MAX_AGE_SEC`, 2.5 s, read through
`_now()`), but its only caller was `fixedUpdate`, which a pause gates entirely.
A peer whose pawn is null keeps `hasLivePeer()` false, so `_holdSession` never
releases the pause, so the door built to close that peer can never open.
Measured on the unfixed path: **30 simulated seconds — twelve deadlines — with
the peer still in `clients`, never refused, never closed, host `tick` still 0.**
The peer sits in a frozen world with no console line and no refusal; the host
sees a phantom in its player list.

Kept in `fixedUpdate` as well, so the existing reachability assertion in
`tests/nethost-hello-gate.test.mjs` still holds and that file is untouched. The
`ctx.paused` guard is what stops the two callers duplicating work per frame.

### 2. `_holdSession` bypassed the `_now()` seam (testability, no behaviour change)

`_holdSession` read `performance.now() / 1000` directly while `_now()` — whose
docstring is "a seam so the age gates are testable" — returns exactly that. The
arithmetic is identical; the consequence was that `HOLD_GRACE`, the single
number the repo's riskiest method turns on, had no unit test of either edge. It
now reads `this._now()`, and both edges are gated (below).

Both changes are confined to `src/net/NetHost.js`.

---

## Both-ends test results

`tests/nethost-dead-host-join.test.mjs` (new), **20 passed, 0 failed**. It
extends the `nethost-hello-gate.test.mjs` fake-ctx/fake-peer harness with a
frame loop in `Engine._frame`'s real order, which is the whole subject.

| End | Assertion | Result |
|---|---|---|
| The report | lone dead host is frozen before the join (`paused`, `tick 0`) | PASS |
| The report | pawn exists and is alive host-side; WELCOME sent under the pause | PASS |
| The report | world un-pauses, steps (`tick 0 → 11`), snapshots reach the joiner | PASS |
| Lone host | dead host alone, 10 s: stays paused, `tick` never leaves 0 | PASS |
| Hold grace | live peer dies → world still running at 0.5 s, snapshots 40 → 50 | PASS |
| Hold grace | past 1.5 s the world pauses, and stays paused over 2 further seconds | PASS |
| Dead host's own inputs | `ctx.input.enabled === false` while a joiner is live | PASS |
| The fix | pawnless peer, 10 s paused: `tick 0`, yet refused and closed | PASS |

**Red/green.** With `src/net/NetHost.js` stashed, the file reports 16 passed,
4 failed. The two that matter are the fix's — `the peer was refused anyway,
from update` and `and closed`. The other two are the grace's, and they fail on
the stashed tree *for a harness reason, not a behavioural one*: without change
2 `_holdSession` reads real wall time, which barely advances across 90
simulated frames, so the grace cannot expire. Master's grace does expire
correctly in real time — that is the third line of the controlled-clock probe
above, run against unmodified code.

## Verification

- `node tests/run.mjs` — **17/17 test files passed.**
  (An earlier run showed `item-id-migration` and `trickle-ice` failing; both
  pass in isolation and on re-run. The working tree is being edited by other
  agents concurrently — `Lobby.js`, `Transport.js`, `items.js` and others are
  modified and not by this task — so those were files caught mid-write.)
- `node node_modules/vite/bin/vite.js build` — **✓ built in 759ms**, no errors.
- Not run, by instruction: browser probes, `sp-equivalence`, `gate:elite`.

## Files changed

- `src/net/NetHost.js` — `_holdSession` uses `this._now()`; `update` sweeps the
  HELLO deadline while paused.
- `tests/nethost-dead-host-join.test.mjs` — new.

## Deferred

- `Coop._spawnPawn` anchoring a joiner on the dead host's corpse (above).
- The probe's per-join success predicate keying on a global `hostPawnCount`
  rather than the specific peer's pawn — already open as item 2 of
  `ice-quiescence-refuted.md`, and the actual cause of that arm's failure.
