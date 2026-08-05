# Round 7 — round-5 co-op fixes

## The fifth uncommitted co-op fix round on `round7/content-and-polish` @ `a43cc70`

Written against `reviews/round7/coop/round4-critique-coop.md` §12.1, in its
priority order. Nothing is committed, staged or reverted; all four earlier fix
rounds are still in the tree and this round is layered on top of them. Port 5199
was never touched — every arm ran on 5841-5860. `src/` was never modified to
build an arm: every revert is a **named in-memory substitution** applied by a
vite `transform` hook and validated against the on-disk source as matching
**exactly once** before the server boots, aborting the arm otherwise.

---

# 0. Headline

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 676ms`,
re-run at the end after every driver was deleted). `git status` shows the same
**eighteen** modified files it showed at the start and **nothing staged**.

**P-1 is closed and all three of its doors are shut**, plus a fourth the critique
did not name. `adv-empty`, `adv-trunc3`, `adv-strbomb` and `adv-trunc1` all end
with the peer **refused**, `pawns []`, `clients 0`, and a sentence on **both**
machines — and each of the four now carries a *different, correct* diagnosis
rather than one catch-all. Each door was failed on purpose in isolation.

**Two of the critique's eight prescriptions are wrong, and I can prove both.**

  * **P-8's** "gate the un-mute on pointer lock" **reverts N-8**. `Menus.open`
    calls `document.exitPointerLock()` (`Menus.js:983`), so `pointerLockElement`
    is `null` on *every sample of every arm I ran* — which means the gate can
    never open while a menu is up, which is the only situation the un-mute
    exists for. `n8-lockgate` is byte-for-byte the shape of `n8-pre`: input
    released at ms 1509 by grace expiry with `paused` already `true`, against
    ms 743 at `dTick 0` on the fixed tree. Declined, with the measurement.
  * **P-3's stated mechanism is false at source and by measurement.**
    `NetClient.fixedUpdate` does not call `_reconcile` and therefore never
    reaches `_applyAuthoritativeHealth`; the only caller is `_handleMessage`'s
    `MSG.SNAPSHOT` branch (`NetClient.js:166`), which runs off `ch.onmessage`
    and is not gated on `ctx.paused`. `p3-paused` puts the client behind a menu
    **before** the kill and it still reads `alive:false, health:0` 600 ms later
    with `serverTick` climbing 135 → 175 **while paused throughout**. The
    symptom the critique saw is real; the cause is on the *host*.

**P-2's fix is right and its gate is wrong.** The critique's `adv-huge` does not
fail on purpose here: a 60 000-character refusal is **delivered** on this machine
with both fixes reverted. So I built a different arm. With 6 291 456 bytes
genuinely queued ahead of it on the reliable channel, `setTimeout(() => peer.close(), 0)`
**loses the refusal** and the joiner reads *"Disconnected from the host."*;
`_closeWhenFlushed` delivers it and the joiner reads the survivor sentence. The
race is real; the size threshold in the critique is not.

**And one half of P-4 does not reproduce.** `_refusedPeers` cannot leak across a
session, because the refused peer's own `netPlayerLeft` clears its entry one turn
after the refusal — `latch-host-P4-latch` reverts the clear and reads `[]`
anyway. The line stays as one defensive statement, labelled as such. The
`_refused` half is real and is closed. §5.1.

**`PROTOCOL_VERSION` goes to 4.** Decision and reasoning in §9.2.

**Every prior fix I could plausibly have disturbed was re-run and all of them
hold** — L-1, L-2, K-1, L-3, F-6, N-3, N-4, N-5, N-6, N-8 — across **17 arms
whose gate was failed on purpose**, each revert isolated to one substitution
except `prior-n4-none`, which reverts both N-4 gates deliberately to show the
exploit through them.

## 0.1 Item ledger

| # | item | status |
|---|---|---|
| 1 | **P-1** — the empty-survivor door | **CLOSED**, four doors, each gated alone |
| 2 | **P-2** — bound and deliver the refusal | **CLOSED**; bound measured, delivery measured on a new arm because the prescribed gate does not fail |
| 3 | **P-4** — clear the latches | **CLOSED** for `_refused` (gated) and for the duplicate listeners (gated). The `_refusedPeers` half **does not reproduce** — §5.1 |
| 4 | the three-peer arm | **RUN. No defect found.** One pre-existing status wart surfaced (§6.1) |
| 5 | **P-6** — warn on an unknown kind | **CLOSED**, both roles, gated |
| 6 | **P-3** — a client that dies without dying | **RE-DIAGNOSED; fix DEFERRED.** The prescription is a no-op. §8 |
| 7 | **P-8** — gate the un-mute on pointer lock | **DECLINED with measurement.** It reverts N-8. §7 |
| 8 | **P-5 / P-7** — diagnosis and the version number | **CLOSED.** P-5 fixed and gated; `PROTOCOL_VERSION` → 4 |

---

# 1. Method

## 1.1 Arms

**41 arms**: 2 single-player, 37 two-page co-op, 2 three-page co-op. Every co-op
number is real Chromium pages on one real WebRTC wire over the manual invite
path (`createInvite` → `joinManual` → `acceptAnswer`), 520×320,
`?quality=0&seed=1337`. Raw JSON: `reviews/round7/coop/r5/` — 41 files. Drivers
deleted.

**`substitutionsMissing` is `[]` and `error` is absent in all 41.**

Four arms aborted before producing anything, on purpose, and are worth recording
because the guard is the control on every other number here:

* `latch-client-P4-latch`, `latch-host-P4-latch`, `latch-host-P4-bindhost` —
  `substitution P4-latch matched 0 times in src/net/Lobby.js (need exactly 1)`.
  `src/net/Lobby.js` is the one CRLF file in `src/net/` and the anchors were LF.
* `sp-head` — `substitution N7-head matched 0 times in src/ui/HUD.js`. My anchor
  was indented four spaces and the source is indented six.

In every case the arm refused to run rather than reporting a fixed-tree reading
as a reverted one. The harness now normalises newlines on both sides, the
`N7-head` anchor was corrected to HEAD's **whole** condition (see §12), and all
four were re-run.

## 1.2 The gate

Every co-op arm blocks on the game actually running on **every** page before
anything else happens:

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

taken *before* the join, while every page is still single-player and the counter
is live on all of them. Representative (`three-live`): host
`{paused:false, screen:null, localTick:1035, survivorId:"ranger", maxHealth:110}`,
A `{…localTick:700, survivorId:"anvil", maxHealth:170}`,
B `{…localTick:65, survivorId:"kestrel", maxHealth:90}`. Three different
survivors, deliberately — that is what makes L-2 and P-1 measurable at all.

## 1.3 Evidence I disqualified

Stated rather than buried.

1. **The critique's `adv-huge` gate does not fail on purpose on this machine.**
   With `P2-slice` *and* `P2-flush` both reverted, a 60 000-character refusal is
   still **delivered**: `adv-huge-pre` reads client status `refused` and the
   survivor sentence, not `disconnected`. I do not quote it as a gate. §4.2
   builds a congestion arm instead and that one does fail.
2. **`substitutionsMissing` was initially read before the pages loaded**, so it
   reported every substitution as missing on the first nine P-1 arms — nothing
   is transformed until something imports it. Those nine arms were re-run with
   the read moved after the session; the numbers did not change, and only the
   re-run files are in `r5/`.
3. **The three-peer arms' `_refuse` call is driven directly** (`net._refuse(peer, …)`)
   rather than provoked by a hostile HELLO, because only one peer can be given a
   hostile HELLO per page. It is the real method on the real peer; it is not a
   substitution, and I name it as instrumentation.

---

# 2. Every edit

| file:line | what |
|---|---|
| `src/net/Protocol.js:44-62` | the version comment, and **`PROTOCOL_VERSION = 4`** (`:62`) |
| `src/net/Protocol.js:290-305` | `readHello` gains **`out.malformed = r.remaining < 4;`** (`:302`) and the comment saying why a manufactured value must not reach a decision |
| `src/net/Protocol.js:307-311` | **`REFUSE_DETAIL_MAX = 64`** (`:311`) |
| `src/net/NetHost.js:2` | import `REFUSE_DETAIL_MAX` |
| `src/net/NetHost.js:36-40` | `REFUSE_FLUSH_MS = 16`, `REFUSE_FLUSH_TRIES = 8` |
| `src/net/NetHost.js:197-206` | the host's `else` branch: one `console.warn` per unrecognised kind (`:205`) |
| `src/net/NetHost.js:246-291` | `_onHello`, rewritten: latch first, then `try { readHello }`, then `malformed`, then version, then **the catalogue check above `!c.pawn` with no `!hello.survivorId` short-circuit in front of it** |
| `src/net/NetHost.js:300-339` | `_refuse` truncates `detail` once (`:322`) and calls `_closeWhenFlushed` (`:327`); `_closeWhenFlushed` (`:335-340`) polls `events.bufferedAmount` under a cap |
| `src/net/NetClient.js:3` | import `REFUSE_DETAIL_MAX` |
| `src/net/NetClient.js:186-193` | the client's `default:` branch, one `console.warn` (`:192`) |
| `src/net/NetClient.js:204-212` | `_refused` bounds `reason` and `detail` on the way *in* — a host is no more trusted than a joiner |
| `src/net/Lobby.js:63-70` | `startHost` calls `_bindHost()` |
| `src/net/Lobby.js:72-105` | `_bindHost`, guarded by `_hostBound` |
| `src/net/Lobby.js:137-151` | `joinManual` calls `_bindClient()` |
| `src/net/Lobby.js:153-166` | `_bindClient`, guarded by `_clientBound` |
| `src/net/Lobby.js:219-246` | `leave()` clears `_refused`, `_refusedPeers` and the player list |

---

# 3. P-1 — the empty-survivor door. **CLOSED, four doors.**

## 3.1 The shape of the fix

The critique's prescription is right and I shipped it, with two changes I can
defend by measurement:

* **The latch is armed before the parse, not after.** The prescription puts
  `try { readHello }` *above* `if (c.helloSeen)`. On that ordering a peer whose
  HELLO throws gets `helloSeen` left `false` — so it is free to try again, which
  is the exact hole `adv-strbomb-pre` shows below. Latch first.
* **A fourth outcome: `malformed`.** See §10 (P-5). A HELLO too short to carry a
  version field is not a version mismatch.

The resulting order is: latch → parse → malformed → version → **catalogue** →
pawn → age.

## 3.2 Both ends of every door

Host `ranger` 110, client `anvil` 170, hostile message as the peer's **first**
HELLO. The client's `_sendHello` is replaced in the same turn `joinManual`
returns, which is many turns before `connected` can resolve — not a race, and
not a source substitution.

| arm | the message | pawn | `clients` | `mistated` | host says | joiner says |
|---|---|---|---|---|---|---|
| `adv-empty` | 5 bytes, version **4**, string length **0** | **`[]`** | **0** | false | *"…they picked a survivor this build does not have **((none))**."* | *"The host does not have the survivor you picked…"* |
| `adv-trunc3` | 3 bytes, version 4, **no string at all** | **`[]`** | **0** | false | *"…their join did not make sense (**its identity message was truncated**)."* | *"The host refused the join. Try joining again."* |
| `adv-trunc1` | **1 byte** | **`[]`** | **0** | false | *"…(**its identity message was truncated**)."* | *"The host refused the join…"* |
| `adv-strbomb` | 5 bytes, length prefix claims **60000** | **`[]`** | **0** | false | *"…(**its identity message did not parse**)."* | *"The host refused the join…"* |
| `adv-legit` | a real `anvil` HELLO | **`anvil` 170/170** | **1** | false | — | *"Connected. Rebuilding the host's world…"* |

**0 console errors, 0 page errors, 0 `[net]` warnings on both machines in all
five.** The strbomb no longer produces even the one `console.error` it used to —
it is refused before the throw can escape.

**The gates, each failed alone:**

| arm | reverted | pawn | `clients` | `mistated` | lobbies |
|---|---|---|---|---|---|
| `adv-empty-pre` | `P1-order` | **`ranger` 110/110** | **1** | **true** | "connected" / "connected" |
| `adv-trunc3-pre` | `P1-order`, `P5-malformed` | **`ranger` 110/110** | **1** | **true** | "connected" / "connected" |
| `adv-strbomb-pre` | `P1-parse` | **`ranger` 110/110** | **1** | **true** | "connected" / "connected" |

All three reproduce L-2 verbatim — the host simulating the peer as its own
survivor at 110 while the peer plays `anvil` at 170 — and the first two do it
with **no diagnostic anywhere on either machine**. `adv-strbomb-pre` produces
exactly one host `console.error` (`RangeError: Invalid typed array length: 60000`
out of `readHello` → `_onHello` → `_handleMessage` → `_onMessage`), which is
round 4's named residual R-1, reproduced and now closed.

`adv-legit` is the control that the fix cannot break the legitimate path, which
is what `Player.init`'s `_applyCard(getSurvivor(...))` guarantees at source.

---

# 4. P-2 — bound and deliver the refusal

## 4.1 The bound. **CLOSED, both ends.**

`detail` is truncated once, in `_refuse`, so the same bound covers the wire, the
host's own status line and the event payload.

| arm | `detail` sent | host's rendered sentence | joiner's status |
|---|---|---|---|
| `adv-huge` (fixed) | 60 000 → **64** | **137 chars** | `refused` |
| `adv-huge-noslice` (`P2-slice`) | **60 000** | **60 073 chars** | `refused` |
| `adv-k300-pre` (`P2-slice`,`P2-flush`) | **300** | **373 chars** | `refused` |
| `adv-huge-pre` (`P2-slice`,`P2-flush`) | **60 000** | **60 073 chars** | `refused` |
| `adv-huge-noflush` (`P2-flush`) | 60 000 → **64** | **137 chars** | `refused` |

Both ends of the range: 60 073 characters of an attacker's string rendered in the
panel of the party that did nothing wrong, against 137. The client-side bound
(`NetClient._refused`) holds the *other* direction — the joiner's
`statusDetail.detail` is 64 in every arm including the reverted ones, because
that half is not reverted by either substitution.

## 4.2 The delivery. **CLOSED — on an arm I had to build.**

The critique's gate does not fail. `adv-huge-pre`, with **both** fixes reverted,
still delivers: client status `refused`, survivor sentence. 60 KB does not
congest loopback SCTP, so `setTimeout(0)` wins the race every time and the
critique's "delivered at 300 bytes, lost at 60 000" threshold does not reproduce
here. I am not quoting a gate that did not fail.

So I made the channel genuinely congested. `flush-*` queues **24 × 256 KB** of
EVENT traffic on the reliable channel in one turn and then refuses:

| arm | buffered at the refusal | joiner's status | joiner reads |
|---|---|---|---|
| `flush-fixed` | **6 291 456 bytes** | **`refused`** | *"The host does not have the survivor you picked…"* |
| `flush-pre` (`P2-flush`) | **6 291 456 bytes** | **`disconnected`** | ***"Disconnected from the host."*** |

Identical fixture, one line different, and the difference is the whole point of
the message. `_closeWhenFlushed` polls `events.bufferedAmount` every 16 ms for at
most 8 tries, so a peer that stops draining cannot hold the connection open.

---

# 5. P-4 — the latches. **CLOSED, both halves.**

`leave()` now clears `_refused`, `_refusedPeers` and the player list, and both
listener sets are bound once per Lobby rather than once per session.

Sequence: join → refused (`__proto__`) → both sides `leave()` → join again →
disconnect.

| step | `latch-client` (fixed) | `latch-host` (fixed) |
|---|---|---|
| session 1 | host `peerRefused` / client `refused`, both sentences correct | same |
| after `leave()` | `_refusedPeers []`, `_refused false`, both read `idle` | same |
| session 2 | peer id is **1 again**; host `players` **2**, `clients` 1 | same |
| the departure | client reads ***"Disconnected from the host."*** | host reads ***"A player left. 1 in the game."*** |

**The gates, each failed alone:**

| arm | reverted | what breaks |
|---|---|---|
| `latch-client-P4-latch` | `P4-latch` | `_refused` reads **`true`** after `leave()`; the second session's disconnect is **swallowed** and the client's panel still reads ***"Connected. Rebuilding the host's world…"*** while it is not connected to anything |
| `latch-host-P4-bindhost` | `P4-bindhost` | session 2's join pushes the same peer twice: host `players` reads **3** for two people in the game, against **2** on the fixed tree |
| `latch-host-P4-latch` | `P4-latch` | **nothing** — see below |

## 5.1 Half of P-4 is not reachable, and I am not going to pretend it is

The critique's `_refusedPeers` half — *"a host refuses peer 1, leaves, hosts
again, and the next peer 1's departure is silently swallowed"* — **does not
reproduce**. `latch-host-P4-latch` reverts the clear and still reads
`hostRefusedPeers: []` immediately after `leave()`, and its second session's
departure speaks normally: *"A player left. 1 in the game."*

The reason is in `_bindHost`'s own handler: `netPlayerLeft` does
`if (this._refusedPeers.has(id)) { this._refusedPeers.delete(id); return; }`.
The refused peer's close **always** arrives — that is the whole point of
`_refuse` — so the Set clears itself one turn later and is already empty by the
time `leave()` runs. It could only leak if a peer were refused and its
`netPlayerLeft` never fired.

`this._refusedPeers.clear()` stays, as one defensive line next to a measured one,
and it is labelled here as **defensive, not a measured fix**. The `_refused`
half of P-4 is real, is gated above, and is closed.

---

# 6. The three-peer arm. **RUN. No defect.**

Two three-page arms, host `ranger` + A `anvil` + B `kestrel`, all three gated on
a running game before either join.

**`three-live` — `hasLivePeer()` with one dead pawn and one live one:**

| sample | `hasLivePeer` | `hold` | `paused` | `input` | pawns |
|---|---|---|---|---|---|
| both joined | true | false | false | true | `anvil:alive`, `kestrel:alive` |
| host opens its pause menu | **true** | **true** | **false** | **false** | both alive |
| **one pawn dead, one live** | **true** | **true** | **false** | **false** | `anvil:dead:0`, `kestrel:alive:90` |
| both dead, inside the grace | **false** | false | false | **true** | both dead |
| both dead, after the grace | false | false | **true** | true | both dead |

`hasLivePeer()` answers exactly the question it is named for at three peers: one
dead pawn does not start the grace, does not un-mute the host and does not pause
the world under the survivor still playing. Both A's and B's `serverTick`
advanced (95 → 205, 130 → 205) right up to the moment the last one died.

**`three-refuse` — `_refuse` drops one peer while another plays:**

| sample | `clients` | pawns | A | B | host |
|---|---|---|---|---|---|
| both joined | 2 | `anvil`, `kestrel` | connected, tick 80 | connected, tick 115 | `players 3` |
| **after refusing B** | **1** | **`anvil` only** | **connected, tick 180** | **`refused`** | `peerRefused`, `players 2` |
| settled | 1 | `anvil` alive 170 | connected, **tick 205** | `refused` | `peerRefused`, `players 2` |

No collateral: A's session is untouched and still stepping, the pawn list is
correct, `_refusedPeers` swallowed B's `peerLeft` **without** swallowing
anything of A's, B reads the survivor sentence and the host reads the bounded
refusal. **0 console errors and 0 page errors on all three pages.**

## 6.1 One pre-existing wart the three-peer arm surfaced — named, not fixed

After **any** successful join the host's co-op panel reads *"Reply accepted —
connecting…"* for ever, including with `players 3` and two peers playing.
`HostTransport.createInvite`'s `accept` returns the `ready` promise, so
`Lobby.acceptAnswer`'s `await invite.accept(...)` resolves *after* `onPeer` has
already raised `netPlayerJoined` — and `_set('peerConnecting')` then overwrites
`peerJoined`. It is a one-line ordering fix in `acceptAnswer`.

**Deferred, with the cost stated.** It is pre-existing (visible in round 4's own
arms), it is cosmetic, it is not on the work list, and touching `Lobby`'s status
sequence would invalidate the status strings quoted by the fourteen arms already
run in this round. Cost of leaving it: a host is never told in words that the
player it accepted has actually arrived; the player list is the only signal.

---

# 7. N-8 re-verified, and P-8 **declined with the measurement**

In-page 20 ms recorder, every row carrying the host's own tick. The host opened
its pause menu **with a live peer** in all three arms; the control before the
event is identical in all three:
`{paused:false, input:false, hold:true, live:true, locked:false, screen:"pause"}`.

| | `n8-pre` (`N8-input`) | **`n8-fixed`** | `n8-lockgate` (`FX-lockgate`) |
|---|---|---|---|
| input at ms ~15 | **false** | **false** | **false** |
| first release | **ms 1476** | **ms 743** | **ms 1509** |
| `dTick` at the release | **5** | **0** | **5** |
| `paused` at the release | **true** | **false** | **true** |
| `hold` at the release | false | **true** | false |
| released by | grace expiry | **the mute's own predicate** | grace expiry |

`n8-fixed` releases on the **first frame** after the death: `dTick 0`, i.e. not
one fixed step ran between the kill and the release. One frame by construction;
743 ms measured at ~1.4 fps under SwiftShader.

**P-8's prescription reverts N-8, measured.** `n8-lockgate` implements exactly
what the critique asks — `ctx.input.enabled = !live && !!document.pointerLockElement`
— and it reproduces `n8-pre` in every cell: released at grace expiry, `dTick 5`,
`paused` already `true`, `hold` already `false`. The reason is one line:
`Menus.open` calls `document.exitPointerLock()` (`Menus.js:983`), so
`pointerLockElement` is **`null` on every one of the 37 samples across all three
arms**. The `hold` branch only runs when a menu is on screen, and a menu on
screen means the pointer is never locked, so the gate is `!live && false`.

I judge the residual — the host's survivor is driven by menu keystrokes for up
to 1.5 s of wall clock after the last peer dies — the **right trade, unchanged
from round 4's**, and the alternative on offer is not a narrowing of it but a
reversal of the fix. Named, bounded, and not taken. A real fix would have to
close the menu when the host is un-muted, which is a UX decision nobody has
asked for and which cannot be applied to a death screen.

---

# 8. P-3 — re-diagnosed. The prescription is a no-op.

**The stated mechanism is false.** Read off the live objects on the client page
in both arms:

```
fixedUpdateCallsReconcile: false
handleMessageCallsReconcile: true
reconcileAppliesHealth:     true
```

`NetClient.fixedUpdate` (`NetClient.js:233-247`) contains no call to
`_reconcile`. The only caller is `_handleMessage`'s `MSG.SNAPSHOT` branch
(`NetClient.js:166`), reached from `ch.onmessage` — **not** from the engine's
fixed step, and therefore not gated on `ctx.paused` at all.

**And it does not reproduce, in the harshest form available.** `p3-paused` opens
a pause menu on the client **before** the kill, so `ctx.paused` is already `true`
and stays `true` for the whole arm:

| ms after the kill | `alive` | `health` | `paused` | `screen` | `serverTick` |
|---|---|---|---|---|---|
| 600 | true | 170 | **true** | death | 135 |
| 1200 | **false** | **0** | **true** | death | **145** |
| 1800 → 4800 | false | 0 | **true** | death | **150 → 175** |

The authoritative death lands, at full pause, and the clock keeps climbing
behind the menu. `p3-normal` is identical. Applying the death "outside
`fixedUpdate`" is where it already is, and stopping `Menus.open('death')` pausing
a networked client would change nothing about this.

**The symptom is real, and it is the host's.** All three N-8 arms — where the
*host* has a menu up — end with the client reading
`{alive:true, health:170, screen:"death"}` and a `serverTick` frozen at the tick
*before* the kill (150 / 145 / 135 against host ticks 155 / 150 / 140). The
client never receives a snapshot newer than the one that predates the death, so
there is nothing for it to apply. `HOLD_GRACE` is **1.5 seconds of wall clock
guarding a frame-driven send**: at the ~1.4 fps these arms run at, it buys one
fixed-step batch and zero further broadcasts, and `ctx.paused` goes true with the
`ESTATE.DEAD` record still unsent.

**Fix deferred, with the cost.** The correct fix is on the host — count the
grace in broadcasts rather than in wall clock, e.g. hold until at least one
snapshot has been sent strictly after the tick at which the last peer died. That
is a change to `_holdSession`, which is the single method carrying **L-1, N-8 and
the grace itself**, all three of which are load-bearing and were re-verified in
this round against arms that would all need rebuilding at a throttled frame rate
to gate it. At 60 fps the grace is ~90 frames and ~30 snapshots; the defect needs
a host below roughly 2 fps. **Cost of leaving it:** a client that dies on a host
that is both in a menu and running at one to two frames per second is left on its
own death screen reading `alive: true` at full health, and can only leave by
reloading. I am not shipping a change to that method on the strength of an arm
that only exists because SwiftShader is slow.

---

# 9. P-5 and P-7

## 9.1 P-5 — malformed is not a version mismatch. **CLOSED, gated.**

`readHello` now reports `malformed` when the body is shorter than the four bytes
a version field plus a length prefix require, and `_onHello` refuses that as
`REFUSE.HELLO` before it can be mistaken for a version.

| the same 1-byte HELLO | host says | joiner says |
|---|---|---|
| `adv-trunc1-p5pre` (`P5-malformed` reverted) | *"…they are running a different version of the game (**theirs 0, ours 4**). Both of you need the same build."* | *"That host is running a different version of the game (theirs 0, ours 4)…"* |
| **`adv-trunc1` (fixed)** | *"…their join did not make sense (**its identity message was truncated**)."* | *"The host refused the join. Try joining again."* |

Both ends. The reverted arm tells the player to go and match their friend's
build, for a fault neither of them has.

## 9.2 P-7 — **`PROTOCOL_VERSION` goes to 4.** Stated as a decision.

**Decision: bump, now.** Reasoning, and the cost, both ways:

* The number's only job is to make a mismatched pairing refuse rather than
  garble. Three builds now call themselves "3" with three different behaviours —
  pre-`MSG.REFUSE`, round 4's, and this round's, which refuses HELLOs the
  previous two accepted. A version that does not identify the protocol is worse
  than no version, because it is trusted.
* The round-4 argument ("a new message *code* is inert to a reader that does not
  know it") is true of the **wire** and I verified it: four unknown-kind shots
  are inert on both roles, they just warn now. It is not true of the **check**.
* **The cost of bumping** is that a pre-round-5 build can no longer join a
  round-5 one. That is the correct outcome and it is now told out loud on both
  machines — which is exactly what P-2's fix makes reliable. And it is free
  today: the co-op menu entry is held and no build is deployed.
* **The cost of not bumping** is P-2's failure mode arriving by a second road: a
  peer refused for a reason it cannot render, reading a generic shrug.

---

# 10. P-6 — an unrecognised kind is no longer silent. **CLOSED, both roles.**

A thirteen-shot battery, both directions, on a live session; every shot followed
by a liveness read on both machines.

| | `msg-fixed` | `msg-p6pre` (`P6-host`,`P6-client`) |
|---|---|---|
| host `[net]` warnings | **3** | **0** |
| client `[net]` warnings | **2** | **0** |
| host `console.error`s | 3 | 3 |
| client `console.error`s | 4 | 4 |
| host / client **page errors** | **0 / 0** | **0 / 0** |

The three host warnings are `unknown kind 200`, `kind 0` and a `SNAPSHOT`
misdirected to the host; the two client warnings are `kind 201` and `kind 0`.
The `console.error` totals are identical across the pair, which is the control
that the warn branch took nothing from the malformed path.

Across all thirteen shots on the fixed tree the host's tick ran **135 → 295**,
`paused` stayed `false`, the pawn was untouched at `anvil` 170 and the client
stayed connected through every non-fatal shot.

**One item the critique asserted rather than drove is now driven.** `MSG.REFUSE`
with an **empty body** was the last shot: the client reads
*"The host refused the join. Try joining again."* — the generic branch of
`refusalText`, exactly as reasoned, now measured.

## 10.1 N-6 re-verified, both roles, both ends

| | `msg-n6hpre` (`N6-host`) | `msg-n6cpre` (`N6-client`) | `msg-fixed` |
|---|---|---|---|
| **host** uncaught page errors | **3** | 0 | **0** |
| **host** `console.error`s | **0** | 3 | **3** |
| **client** uncaught page errors | 0 | **4** | **0** |
| **client** `console.error`s | 4 | **0** | **4** |

Exact complements in both directions: the same number of failures, moved from
"uncaught" to "logged". Neither role's isolation was disturbed by rewriting the
methods immediately above it.

---

# 11. Prior fixes re-verified

I touched `NetHost._onHello`, `NetHost._refuse`, `NetHost._handleMessage`,
`NetClient._handleMessage`, `NetClient._refused`, `Protocol.readHello`,
`PROTOCOL_VERSION` and all of `Lobby`'s session lifecycle — L-1, L-2, N-3, N-4,
N-5, N-6 and N-8 territory. **Re-run:**

| fix | observable, fixed tree | gate, failed on purpose |
|---|---|---|
| **L-2** | pawn **`anvil` 170/170** under a client playing `anvil` 170 | `prior-l2pre` (`L2-hello`): pawn **`ranger` 110/110**, and K-1 then reads host **72.96/110** against client **112.76/170** |
| **K-1** | host pawn **135.70/170** → client reads **135.70/170** | as above |
| **L-3** | client's fabricated 42-point barrier seen at **41.29**, corrected to **0** | present in three arms; `prior-l2pre` reads 0/0 because that client's pawn is a different survivor |
| **F-6** | `_lastCmdTick` **55** vs `net.tick` **55**, **delta 0** (also 50/50, 45/45, 40/40) | — |
| **N-4** | all four replays **refused** (*"a second identity message"*), `pawns []`, `clients 0` | `prior-n4-nolatch` (`N4-latch`): refused on **age**. `prior-n4-noage` (`N4-age`): refused on the **latch**. `prior-n4-none` (both): **the exploit — `kestrel 90/90 → anvil 170/170 → kestrel 90/90 → anvil 170/170`**, four full re-stats from five bytes each |
| **L-1** | host dead, `paused:false`, `screen:"death"`, `input:false`, `hold:true`, client `serverTick` **140 → 145 → 155 → 165 → 175 → 185 → 195 → 205** over four seconds | `prior-l1pre` (`L1-hold`): client `serverTick` **135 × 8 over four seconds — frozen**, host tick frozen at 135, `paused:true` |
| **N-6** | §10.1 | both roles |
| **N-8** | §7 | `N8-input` |
| **N-3 host half** | the version branch still refuses and still names both numbers: `adv-trunc1-p5pre` renders *"theirs 0, ours 4"* on both machines. **I did not re-run a 65535 arm** — the branch is the same one and this is the reading it produced | — |
| **N-5** | `__proto__` refused with the survivor sentence on both machines, in five separate `latch-*` arms | `adv-empty-pre` / `adv-trunc3-pre` / `adv-strbomb-pre` all mis-state the pawn to `ranger` 110 |

Either N-4 gate alone is sufficient — round 4's contested claim — reconfirmed
independently on a tree where `_onHello` was rewritten around both of them.

`prior-l2pre`'s first "replay" is **accepted** (pawn becomes `kestrel` 90/90)
because with `_sendHello` reverted away the identity latch was never armed;
replays 2-4 are then refused. That is the arm behaving correctly, not a defect,
and I name it so the row is not misread.

---

# 12. The single-player control

`src/net/` runs at all only when `ctx.lobby.mode !== 'single'`; nothing in this
round is reachable from a single-player session. The control is run anyway,
against **HEAD `a43cc70`'s literal HUD condition** (`git show a43cc70:src/ui/HUD.js`,
line 168), substituted in as `N7-head`:

```js
if (!e?.source || e.source === ctx.player || e.source?.isPlayer) {
```

— substituted in **whole**, including the absence of the victim guard and of
`isLocalKill`, which is what makes it HEAD's condition and not a half of it.

Identical fixture on both arms — four kills by the player, one enemy killed by
another enemy, then a player-victim kill — counting `progression.stats.kills`,
`hud.stats.kills` and `pulse(reticle, 'is-kill')` wrapped upstream of the DOM.

| event | `sp-head` (HEAD's literal line) | `sp-fixed` (this tree) |
|---|---|---|
| four kills by the player | prog **4** / HUD **4** / flash **4** | prog **4** / HUD **4** / flash **4** |
| an enemy kills an enemy | prog **5** / HUD **4** / flash **4** | prog **5** / HUD **4** / flash **4** |
| the player's own death | prog **5** / HUD **4** / flash **4** | prog **5** / HUD **4** / flash **4** |

**Every cell identical.** Fixture controls, the same on both arms:
`sourceWasEnemy true`, `killerIsPlayer false`, `victimIsPlayer false` for the
enemy-on-enemy kill. `progression` reads 4 / 5 / 5 on both, which is the control
that nothing here is anything but HUD-side. `world` on both:
`{lobbyMode:"single", net:null, authority:true, paused:false, localTick:70,
alive:true, health:110/110}` — **0 page errors, 0 console errors** on both.

---

# 13. Arms I did **not** run

Naming them is not a claim that they are fine.

1. **The relay path.** `hostViaRelay` / `joinViaRelay` never ran, in any round.
   `_bindHost` / `_bindClient` are on that path too, and `hostViaRelay` calls
   `startHost()` directly — so the binding guard is exercised only through the
   manual path here.
2. **Four peers.** Three is the most I ran. `maxPlayers` is 4 and
   `createInvite` throws at `clients.size >= maxPlayers - 1`; that boundary is
   untested by anyone.
3. **Real network conditions.** Loopback WebRTC on one machine. Every timing
   number here — `HELLO_MAX_PAWN_AGE`'s 2 s, `HOLD_GRACE`'s 1.5 s,
   `REFUSE_FLUSH_MS` × `REFUSE_FLUSH_TRIES` = 128 ms — is a zero-lag number.
   In particular **nobody has measured whether 128 ms is enough to flush a
   refusal under real RTT**; the cap is a bound on how long a bad peer can hold
   the socket, not a promise of delivery.
4. **A `REFUSE` reaching a build that does not know the code**, and a v3 build
   meeting a v4 one. Both need two builds; reasoned from source, not driven.
5. **`constructor` / `toString` as survivor ids.** `__proto__` was driven;
   the others follow from `SURVIVOR_BY_ID = Object.create(null)` and are
   asserted.
6. **Duplicate and out-of-order `INPUT`.** Guarded by the pre-existing
   `cmd.tick <= c.lastTick` check; nothing in this round is upstream of it.
7. **A legitimate slow first HELLO** past the age gate. Named by rounds 4 and 5's
   critique; I did not close it either.
8. **P-3 at 60 fps.** The one arm that would settle whether the host-side grace
   is a real shipping defect needs a throttled-but-not-crawling host, and I did
   not build it. §8.
9. **N-1.** Untouched: no enemy in this build ever targets a pawn. A co-op
   session is still one player being attacked and one player being ignored.
10. **A stage transition, a client pulling its own trigger, the 21-shot capture,
    and whether any of it sounds right.** Still not run, by anyone.

---

# 14. Does this change the hold?

**No, and for the same reason as before.** Nothing here touches N-1. The hold on
the **Co-op menu entry** should stay; the branch is unaffected.

What has changed is that the claim round 4 most needed to be true — *nothing
silently falls through to the default survivor* — **is now true**, and is true
from four different malformed messages rather than one, each with its own
diagnosis, each gated by failing it on purpose. The refusal that says so is
bounded in both directions and survives a congested channel. The latches no
longer poison the next session. Three peers behave. And two of the eight things
this round was asked to do turned out to be wrong when measured, which is said
here rather than shipped.
