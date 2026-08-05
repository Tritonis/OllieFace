# Round 7 — independent critique of the round-5 co-op fixes

**Subject:** `reviews/round7/coop/round5-fix-coop.md`, against the working tree on
`round7/content-and-polish` @ `a43cc70` plus five uncommitted fix rounds (18 modified files).

Nothing was committed, staged or reverted; all five rounds are still in the tree.
`src/` was never modified to build an arm: every revert is a **named in-memory
substitution** applied by a vite `transform` hook and validated against the on-disk
source as matching **exactly once** before the server is allowed to listen — the arm
aborts otherwise. Ports 5861-5880 only; **5199 was never touched**.

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 24.09s`, on a
machine running four browser pages at the time).

---

# 0. Headline

**Round 5 is the most honest report in this sequence, and it is still wrong about the
one thing it was written to settle.**

Every substantive claim it makes about the code it changed, I re-derived and confirmed
— the four doors, both halves of P-2, both real halves of P-4, P-5, P-6, the three-peer
arm, the `PROTOCOL_VERSION` bump, and **both of the prescriptions it refused**. Its two
refusals are correct, and on P-8 I can now show *why* rather than infer it: my fixture
acquires pointer lock, which round 5's never did.

But **P-1 is not closed.** There is a fifth door, it is the widest of the five, and
walking through it requires sending **nothing at all**.

* **`door-nohello`** — a peer that connects and never sends a HELLO is simulated as the
  **host's** survivor for the whole session. Measured on the *fixed* tree, no
  substitutions: host pawn **`ranger` 70.17/110** while the joiner plays **`anvil`
  108.44/170** — the same two numbers 38 points apart that `PROTOCOL_VERSION` 3 was
  bumped to remove. `helloSeen: false`, `clients 1`, both lobbies read "connected",
  **0 console errors, 0 page errors, 0 `[net]` warnings on both machines**. The control
  `adv-legit` reads `anvil` **130.43/170** on both ends, agreeing to the cent. §3.3.

And a second defect, in a method round 5 edited, that five rounds and four critiques
have walked past:

* **`Lobby.leave()` does not reset `ctx.netRole`.** A player who joins a co-op game and
  then presses **Leave co-op** is left with a survivor that **cannot move, ever**, with
  no error and no way back but reloading the page. Measured, same page, same key:
  **2.103** units before joining, **1.908** while joined, **0.000** after `leave()`;
  the host, whose `netRole` is `'host'`, is unaffected (**2.258** either side of its own
  `leave()`). Opening and closing the pause menu does not recover it. §7.

Two corrections to round 5's wording, both minor and both in its favour on the merits:
the four doors carry **three** distinct diagnoses, not four; and the single-player
control matches HEAD `a43cc70` **for the three rows it tested and not in general** — I
found two more single-player rows where the trees differ, and in both the branch is
*better* than HEAD.

**The hold on the Co-op menu entry stands, and it has never been applied.** The `Co-op`
button is still live on the title screen (`Menus.js:187`) and in the pause menu
(`Menus.js:292`). **The single-player half is still shippable alone.**

## 0.1 Severity table

| ID | sev | finding | status |
|---|---|---|---|
| **C-1** | **MAJOR** | **The fifth door.** A peer that never sends a HELLO is silently simulated as the host's survivor, indefinitely, with no diagnostic. L-2 verbatim, on the fixed tree, from zero hostile bytes. There is a gate refusing a *late* HELLO and none refusing silence. | **OPEN** — §3.3 |
| **C-2** | **MAJOR** | **`Lobby.leave()` leaves `ctx.netRole === 'client'`.** `Player.fixedUpdate` skips `applyCommand` for a client and `NetClient.fixedUpdate` has stopped running, so the survivor is frozen permanently. Three other consumers leak the same way. | **OPEN** — §7 |
| **C-3** | MODERATE | **P-3's symptom reproduces, on a host in a menu.** `n8-fixed` ends with the client reading `alive:true, health:170`, `serverTick 100` against host tick 105, and **no death screen at all**. Round 5's re-diagnosis (host-side, not client-side) is supported; its deferral is now a deferral of something I have seen. | **OPEN** — §6.1 |
| **C-4** | MODERATE | **P-8's residual is real and round 5 took the trade backwards.** The un-mute can only ever fire while a menu is on screen, so it hands control to a player who cannot see. `Input`'s keydown is a bare `window` listener with no menu or form-field exclusion, and `Menus` navigates on `KeyW`/`KeyS` — the survivor's own movement keys. | **OPEN** — §5.2 |
| **C-5** | MODERATE | **Session teardown leaks systems.** `leave()` never removes the `NetHost`/`NetClient` from `engine.systems` and never nulls `ctx.net`. Measured: `systems 15 → 16 → 17`, **two `NetHost`s** live after one leave-and-rehost. | **OPEN** — §7.2 |
| **C-6** | MINOR | **The invite cap counts connected clients, not outstanding invites.** `NetHost.createInvite` guards on `clients.size >= maxPlayers - 1`; four invites created before anyone joins all pass. Source-derived, not driven. | **OPEN** — §9.1 |
| **C-7** | MINOR | **`HELLO_MAX_PAWN_AGE` is a frame-driven counter guarding a wall-clock intent** — the mirror image of the `HOLD_GRACE` defect round 5 diagnosed. 120 host ticks is 2 s at 60 fps and **~15 s** at the ~8 ticks/s these arms run at. | **OPEN** — §9.2 |
| **C-8** | MINOR | Round 5's headline says each of the four doors carries a *different* correct diagnosis. `adv-trunc3` and `adv-trunc1` produce the **identical** sentence. Three diagnoses, four doors — as round 5's own §3.2 table shows. | wording — §3.2 |
| **C-9** | MINOR | The single-player control is sound for its fixture and over-claimed as "every cell identical". Two more single-player rows **do** differ from HEAD's literal condition. Both differences are improvements. | wording — §8 |
| **C-10** | COSMETIC | §6.1's status wart is confirmed — and it is **not** three-peer-specific. It reproduces at **two** peers, on every successful join in every arm I ran. | confirmed — §6.4 |

Round 5's residuals that I re-derived and agree are correctly held: **N-1** (no enemy
targets a pawn), four peers, real network conditions, and the audio surface. The relay
path was on that list; **I ran it, and it works** — §10.

---

# 1. Method

## 1.1 The rig

An independent harness (round 5's was deleted). It boots a vite dev server on a private
port with named substitutions, launches Chromium (`--use-gl=swiftshader`), and drives
the **manual invite path** (`createInvite` → `joinManual` → `acceptAnswer`) between real
pages on a real WebRTC wire at 520×320, `?quality=0&seed=1337`. **42 arms**: 2
single-player, 38 two-page co-op, 2 three-page co-op. Raw JSON in
`reviews/round7/coop/r5-critique/`; drivers deleted.

**The substitution guard.** Each substitution names a file, an anchor and a replacement.
Before the server is allowed to `listen()`, the anchor is counted against the **on-disk**
source with newlines normalised on both sides; anything other than exactly one match
aborts the arm with `substitutionsMissing` populated and no numbers produced.
`substitutionsMissing` is `[]` in every arm quoted here. Every arm also records
`appliedAtRuntime` — the substitutions the transform hook actually fired in the browser
— so an anchor that matched on disk but never reached the page cannot pass as a revert.
(`src/net/Lobby.js` and `src/ui/Menus.js` are CRLF while the rest of `src/net/` is LF;
round 5 lost four arms to exactly this and disclosed it. My harness normalises both.)

**The running-game gate.** Every co-op arm blocks, on **every** page, on

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

taken *before* the join while each page is still single-player. Representative
(`door-nohello`): host `{paused:false, screen:null, localTick:75, survivorId:"ranger",
maxHealth:110}`, client `{…localTick:65, survivorId:"anvil", maxHealth:170}`. Different
survivors on purpose — that is what makes L-2 and P-1 measurable at all.

**Named instrumentation** (not substitutions, and not hidden):

1. `lobby.onStatus = (s, d) => menus.coopStatus(s, d)` plus a recorder, on every page.
   This is the exact binding line `Menus.openCoop` runs; it renders the real sentence
   into the real `[data-coop-status]` element without `push('coop')`, which would pause
   the game and break the gate above.
2. Hostile HELLOs replace `_sendHello` **on the live `NetClient` object**, in the same
   turn `joinManual` returns — many turns before `connected` resolves and the method is
   called. Not a race and not a source edit.
3. `three-refuse` drives `net._refuse(peer, …)` directly, because only one peer per page
   can be given a hostile HELLO. Same method, same real peer.
4. `--autoplay-policy=no-user-gesture-required` on the `prior*` arms only, so an
   `AudioContext` actually exists (`acState: "running"`). Round 4 disclosed that its
   `prior-eb` gate "failed to fail" precisely because headless Chromium creates none
   without a gesture; this removes that excuse. **A fixture change from every earlier
   round**, flagged because it makes those arms not directly comparable to theirs.

## 1.2 Evidence I disqualified

Stated up front, not buried.

1. **My "the survivor was driven by menu keystrokes" metric is worthless and I am not
   quoting it.** I sampled `ctx.player._cmd.moveZ`. `_cmd` is a reused scratch object
   written only inside `_sampleCommand`, which does not run while the world is paused —
   so it holds a stale value in arms where input was muted throughout. The claim in §5.2
   is therefore **derived from source**, not measured.
2. **The N-8 release *timing* is not stable in my fixture and I am not quoting
   milliseconds.** Across two independent runs `n8-fixed` released input at +679 ms with
   `{paused:false, hold:true}` and at +1349 ms with `{paused:true, hold:false}`. What is
   stable across every run, and is what decides P-8, is the pointer-lock reading and the
   `input`/`hold` state while the menu is up.
3. **Three artefacts were overwritten by a re-run before I quoted them.** An orphaned
   driver re-ran the N-8 trio and clobbered the files behind numbers I had already read.
   Rather than cite figures with no file behind them, I re-ran all three; §5 quotes only
   what is on disk now. This is the one place in this review where I nearly shipped a
   number whose baseline no longer existed.
4. **`door-late` never reached the age gate.** Nine seconds of wall clock bought only
   ~70 host ticks against a 120-tick threshold. The arm proves nothing about
   `HELLO_MAX_PAWN_AGE`; what it does prove is C-7, that the threshold is counted in the
   wrong unit.
5. **`door-dup` did not deliver its second message.** `helloSeen:true,
   survivorId:"anvil"`, four statuses, no `peerRefused` — the duplicate HELLO scheduled
   2.5 s later never reached `_onHello` and I did not determine why. The duplicate-HELLO
   case is carried instead by `door-race` and `ctrl-retry-shipped`, which both refuse it.
6. **`adv-trunc3` and `ctrl-retry-shipped` were both read too early the first time.**
   At 3.5 s and 5 s under load they showed `pawns [ranger 110]`, `clients 1` — the host
   caught mid-teardown. Settled reads (8-16 s later) read `pawns []`, `clients 0`,
   `players 1`. **The settled reads are what §3.2 and §3.4 quote.** Had I not re-run
   `ctrl-retry-shipped` with a longer settle I would have filed a false MAJOR against
   the shipped HELLO ordering.
7. **Three of my own `prior-fixed` measurements did not exercise their target** — F-9's
   positive control, K-10 and M1. Re-run corrected as `prior2-*`; §10.
8. **Contention.** Four gate arms and one battery arm died on `page.goto` timeouts while
   three jobs shared the machine, and two long jobs wedged on a WebRTC handshake that had
   no timeout. All were re-run serially with bounded waits; no number from a timed-out arm
   appears here. Several of my own node and Chromium processes were orphaned by that
   cleanup and killed — **disclosed**. No process I did not start was touched, and port
   5199 was never bound.
9. **`n8-lockgate` needed four attempts.** Three died on the WebRTC handshake with the
   substitution correctly applied and the running-game gate passed; the fourth completed
   and is the one quoted. P-8's verdict rests on the pointer-lock measurement and on
   source, not on that arm alone.

---

# 2. What round 5 changed, re-read at source

I read the whole co-op diff rather than trusting the edit table. It is accurate.
`_onHello`'s order is **latch → parse → malformed → version → catalogue → pawn → age**
(`NetHost.js:246-294`), the catalogue check is above `!c.pawn` with no
`hello.survivorId` short-circuit in front of it, `readHello` sets
`out.malformed = r.remaining < 4` (`Protocol.js:302`), `REFUSE_DETAIL_MAX = 64`
(`Protocol.js:311`) is applied once in `_refuse` (`NetHost.js:322`) and again on the way
in at `NetClient._refused` (`NetClient.js:209-210`), `_closeWhenFlushed`
(`NetHost.js:335-340`) polls `bufferedAmount` under an 8 × 16 ms cap,
`PROTOCOL_VERSION` is **4** (`Protocol.js:62`), both roles warn on an unknown kind
(`NetHost.js:205`, `NetClient.js:192`), and `Lobby` binds each role's listeners once
(`Lobby.js:83-84`, `Lobby.js:154-155`).

Two source facts underwrite much of what follows, and both check out:

* `SURVIVOR_BY_ID = Object.create(null)` (`survivors.js:230`) — `__proto__`,
  `constructor` and `toString` are genuinely absent, not inherited. Driven for
  `__proto__`; asserted for the other two.
* `Peer.close()` (`Transport.js:63-67`) calls `onClose` synchronously unless `closed` is
  already set, and `NetHost._onPeer` wires that to `_onPeerLeave`. That is the whole of
  round 5's §5.1 argument, and it is correct.

---

# 3. P-1 — the door count is five, not four

## 3.1 The gates, each failed on purpose

| arm | reverted | pawn | `clients` | host panel | joiner panel |
|---|---|---|---|---|---|
| `gate-empty-P1order` | `P1-order` | **`ranger` 110/110** | **1** | *"Reply accepted — connecting…"* | *"Connected. Rebuilding the host's world…"* |
| `gate-trunc3-P5` | `P1-order`, `P5-malformed` | **`ranger` 110/110** | **1** | *"Reply accepted — connecting…"* | *"Connected…"* |
| `gate-strbomb-P1parse` | `P1-parse` | **`ranger` 110/110** | **1** | *"Reply accepted — connecting…"* | *"Connected…"* |
| `gate-trunc1-P5only` | `P5-malformed` | `ranger` 110/110 | 1 | *"…they are running **a different version of the game (theirs 0, ours 4)**. Both of you need the same build."* | *"That host is running a different version…"* |

The first three reproduce L-2 verbatim — the host simulating the peer as its own survivor
at 110 while the peer plays `anvil` at 170 — and the first two do it with **no diagnostic
anywhere on either machine**. `gate-strbomb-P1parse` produces exactly one host
`console.error`:

```
[net] host dropped a malformed message from peer 1 RangeError: Invalid typed array length: 60000
    at Reader.str (Protocol.js:206) → readHello (Protocol.js:304) → NetHost._onHello (NetHost.js:258)
```

That is round 4's named residual **R-1**, reproduced and closed. `gate-trunc1-P5only` is
P-5's gate: the same single byte tells **both** players to go and match each other's
build, for a fault neither has. Each gate is one substitution except the two-substitution
row, which is named as such.

## 3.2 The four doors round 5 named — all four confirmed

Host `ranger` 110, client `anvil` 170; the hostile message is the peer's **first** HELLO.
Values are the settled reads (§1.2 item 6).

| arm | the message | pawn | `clients` | host says | joiner says |
|---|---|---|---|---|---|
| `adv-empty` | 5 bytes, version 4, string length 0 | **`[]`** | **0** | *"…they picked a survivor this build does not have **((none))**."* | *"The host does not have the survivor you picked…"* |
| `adv-trunc3` | 3 bytes, version 4, no string | **`[]`** | **0** | *"…their join did not make sense (**its identity message was truncated**)."* | *"The host refused the join. Try joining again."* |
| `adv-trunc1` | 1 byte | **`[]`** | **0** | *"…(**its identity message was truncated**)."* | *"The host refused the join…"* |
| `adv-strbomb` | 5 bytes, length prefix claims 60000 | **`[]`** | **0** | *"…(**its identity message did not parse**)."* | *"The host refused the join…"* |
| `adv-legit` | a real `anvil` HELLO | **`anvil` 170/170** | **1** | — | *"Connected. Rebuilding the host's world…"* |

**0 console errors, 0 page errors and 0 `[net]` warnings on both machines in all five.**
The strbomb no longer produces even the one `console.error` it used to.

**C-8, the wording correction.** `adv-trunc3` and `adv-trunc1` render the *same*
sentence. Four doors, **three** diagnoses. Round 5's §3.2 table shows this; its headline
does not. The behaviour is right — both messages *are* truncated.

**Both ends of the `remaining < 4` boundary**, which round 5 did not state as a range:

| arm | body after the kind byte | `malformed` | outcome |
|---|---|---|---|
| `edge-rem3` | **3 bytes** | true | refused, *"its identity message was truncated"* |
| `adv-empty` | **4 bytes** | false | refused, *"they picked a survivor this build does not have ((none))"* |

Different reasons, both correct, and neither falls through.

## 3.3 C-1 — the fifth door. **P-1 is not closed.**

`door-nohello` replaces `_sendHello` with an empty function. Nothing else. No hostile
bytes, no substitutions, the shipped tree.

| | `adv-legit` (control) | **`door-nohello`** |
|---|---|---|
| host `clients[0]` | `helloSeen:true, survivorId:"anvil"` | **`helloSeen:false, survivorId:null`** |
| the pawn, after 40 points taken on the authority | `anvil` **130.43 / 170** | **`ranger` 70.17 / 110** |
| what the joiner reads of **itself** | `anvil` **130.43 / 170** | **`anvil` 108.44 / 170** |
| the two ends disagree by | **0.00** | **38.27 points** |
| `clients` / `players` | 1 / 2 | **1 / 2** |
| host panel | *"Reply accepted — connecting…"* | *"Reply accepted — connecting…"* |
| joiner panel | *"Connected. Rebuilding the host's world…"* | *"Connected. Rebuilding the host's world…"* |
| console / page errors / `[net]` warnings, both machines | 0 / 0 / 0 | **0 / 0 / 0** |

70.17 / 110 = 0.638; 0.638 × 170 = 108.4. That is exactly the mapping
`NetClient._applyAuthoritativeHealth`'s own comment names as the defect the HELLO body
exists to remove — *"a `ranger` host and an `anvil` client mapped a fraction of 110 onto
170"*. It is L-2, on the fixed tree, from a peer that said nothing.

**Why the door is open.** `NetHost._onPeer` builds the pawn on channel open from the
host's own `ctx.survivorId` (`Coop._spawnPawn` → `Player.init`) — by design, since round
3. `_onHello` then refuses five things a peer can *say* wrong, including a HELLO that
arrives more than `HELLO_MAX_PAWN_AGE` ticks late. **Nothing anywhere refuses a peer that
never speaks.** The asymmetry is written down in `Protocol.js`'s own version-3 note —
*"a client that never sends one is spawned as before"* — where it was a compatibility
virtue, and has since become the last surviving instance of the defect the same file's
version-4 note claims to have closed.

**Threat model.** Identical to the four doors round 5 closed: all five require a peer
that chooses its own bytes, because a stock build always sends a well-formed HELLO
(`ClientTransport.join` resolves only when **both** channels are open, so a legitimate
HELLO cannot be lost — I checked at source). C-1 is not harder to reach than the other
four; it is the easiest of the five.

**The fix, in the shape the file already has.** `_onPeer` records `joinTick` and
`HELLO_MAX_PAWN_AGE` already exists. The symmetric rule is about four lines in
`NetHost.fixedUpdate`: any client with `helloSeen === false` and
`this.tick - c.joinTick > HELLO_MAX_PAWN_AGE` gets
`_refuse(peer, REFUSE.HELLO, 'it never said which survivor it is')`. Same constant, same
refusal path, same two sentences. **Read C-7 first** — that constant is currently counted
in the wrong unit.

## 3.4 Six more shapes, all refused, none of them a door

| arm | the message | outcome |
|---|---|---|
| `door-unknown` | id `anvil2` | refused, *"…does not have (anvil2)"* |
| `door-proto` | id `__proto__` | refused, *"…does not have (__proto__)"* |
| `door-lenover` | length prefix 5, three bytes follow | refused, *"…did not parse"* |
| `door-race` | an empty HELLO and a legitimate one **in the same turn** | refused twice; the second is *"**a second identity message**"*; `pawns []`, `clients 0` |
| `ctrl-retry-shipped` | a strbomb, then a legitimate HELLO **250 ms later** | refused twice; `pawns []`, `clients 0`, `players 1` at the settled read |
| `door-state` | a legitimate HELLO on the **unreliable** state channel | accepted, pawn `anvil` 170/170 |

`door-state` is not a divergence — the id was honest — but it is worth naming:
`_handleMessage` ignores which channel a message arrived on. It cannot bite today because
`_sendHello` uses `sendEvent`, but it is the same silence C-1 exploits: a HELLO that never
arrives is indistinguishable from one that was never sent.

**Round 5's deviation from the prescription is a no-op, not a fix.** Round 5 armed the
latch *before* the parse and justified it by claiming round 4's prescribed ordering
(parse above latch) leaves a peer "free to try again". `gate-retry-prescribed` implements
the prescribed ordering exactly, with the same strbomb-then-retry: **`pawns []`,
`clients 0`, one refusal, *"its identity message did not parse"***. The hole does not
reproduce, because the same prescription's inner `try/catch` refuses and closes the peer
on the first message, so `helloSeen` being false never matters. The shipped ordering
reaches the same end state and sends **two** REFUSE messages instead of one. Round 5's
choice is tidier; the reason it gave for it is not demonstrated.

---

# 4. P-2 — confirmed, both halves, both ends

**The bound.** Identical fixtures, one line different:

| arm | reverted | host's rendered sentence | joiner |
|---|---|---|---|
| `bound-fixed` | — | **137 characters** | `refused`, survivor sentence |
| `bound-noslice` | `P2-slice` | **60 073 characters** | `refused`, survivor sentence |

60 073 characters of an attacker's string rendered in the panel of the party that did
nothing wrong, against 137.

**The delivery.** Round 5's disclosure that the *critique's* gate does not fail is
correct; I did not re-quote it, and re-built its congestion arm instead. 24 × 256 KB of
EVENT traffic queued on the reliable channel in one turn, then the refusal:

| arm | reverted | buffered at the refusal | joiner's status | joiner reads |
|---|---|---|---|---|
| `flush-fixed` | — | **6 291 456 bytes** | **`refused`** | *"The host does not have the survivor you picked…"* |
| `flush-pre` | `P2-flush` → `setTimeout(() => peer.close(), 0)` | **6 291 456 bytes** | **`disconnected`** | ***"Disconnected from the host."*** |

Identical fixture, one line different, and the difference is the whole message. Round 5's
arm is honest and reproduces exactly.

**What neither of us measured, and it bounds the fix.** `REFUSE_FLUSH_MS ×
REFUSE_FLUSH_TRIES` = **128 ms**, after which the peer is closed whether or not the
channel drained. `flush-fixed` passing means loopback SCTP cleared 6 MB inside 128 ms
(~49 MB/s). On any real uplink 6 MB takes seconds, so under genuine congestion the
refusal is lost with the fix in place exactly as it is without it. The fix buys the band
between "one macrotask" and "128 ms" — real, and much narrower than the arm makes it
look. Round 5 names this in its §13 item 3; this puts a number on it.

---

# 5. P-8 — round 5's refusal is right; its judgement of the residual is not

## 5.1 The prescription reverts N-8 — now shown causally

Round 5 argued that `pointerLockElement` is null on every sample. That is true in its
arms and in mine, but *its* fixture never acquired pointer lock at all, so the
observation could not tell "the menu released it" from "there was never any". **Mine
acquires it.** Every arm's pre-join gate reads `pointerLock: true`, and in the N-8 arms:

| | `n8-fixed` | `n8-pre` (`N8-input`) | `n8-lockgate` (`FX-lockgate`) |
|---|---|---|---|
| pointer lock **before** the menu opens | **true** | **true** | **true** |
| pointer lock **after** `Menus.open('pause')` | **false** | **false** | **false** |
| locked samples across the arm | 2 of 14 (both pre-menu) | 0 of 12 | 1 of 10 (pre-menu) |
| while the menu is up with a live peer | `{input:false, hold:true, paused:false}` ×6 | same ×6 | same |
| input restored after the last peer dies | +1349 ms, `{paused:true, hold:false}` | never within the window | +4236 ms, `{paused:true, hold:false}` |

`Menus.open` calls `document.exitPointerLock()` (`Menus.js:983`), and `_holdSession`'s
hold branch only runs when `screen` is truthy — so the gate
`!live && !!document.pointerLockElement` evaluates `!live && false` in exactly the
situation it exists for. **The pointer-lock reading is `false` on every sample taken
while a menu is up, in all three arms**, and `true` on every arm before the menu opens —
the observation round 5's fixture could not make, and what turns its inference into a
measurement. **Round 5's refusal of P-8's prescription: CONFIRMED.**

Be clear about what these three arms do *not* show. At ~8 frames per second the un-mute
window is one or two frames wide, and in the runs whose artefacts survive **none of the
three caught it**: every "input restored" row above is the `else if (this._holding)`
branch firing after the grace, which all three trees share. So the arms establish the
*premise* of round 5's refutation — the lock is never held behind a menu — and the
control that L-1 and N-8's mute both work. They do not independently time the un-mute,
and §5.2 is argued from source accordingly.

The table also re-derives the control both rounds needed: with a live peer and a menu on
screen, the host runs the world (`paused:false`) with its own input muted
(`input:false`). L-1 and N-8's mute both hold.

## 5.2 C-4 — but the residual should be closed, and the trade is the wrong way round

Round 5 calls the residual "the right trade, unchanged from round 4's". I disagree, and
the argument is at source, not in a measurement (§1.2 item 1 disqualifies mine):

* `hold` requires `!!screen`. `ctx.input.enabled` is written **only** inside the hold
  branch (and once on the frame it ends). So the un-mute — `enabled = !live`, true when
  no peer is live — **can only ever fire while a menu is on screen**.
* During that window `ctx.paused` is forced `false`, so `Engine._frame` runs fixed steps
  and `Player.fixedUpdate` calls `applyCommand(_sampleCommand(ctx))`.
* `Input`'s keydown handler is a bare `addEventListener('keydown', …)` on `window`
  (`Input.js:13-17`) with **no** menu, focus or form-field exclusion. `Menus` navigates
  on `hit('ArrowDown') || hit('KeyS')` and `hit('ArrowUp') || hit('KeyW')`
  (`Menus.js:1508-1509`); `Input.moveAxis` reads `KeyW`/`KeyS` for forward and back.
  They are the same keys — and so is anything typed into the co-op panel's invite and
  reply `<input>` fields, which are reachable from that same screen.

So for up to `HOLD_GRACE` = 1.5 s the host's survivor is driven by whatever the player
presses to work the menu they are looking at. What the un-mute buys in exchange is the
ability to "move, dodge or shoot" — for a player whose view is a pause or death panel, in
a window that ends with the world pausing anyway. Meanwhile the host is muted for the
**entire preceding period** in which a menu is up and peers are alive, which may be
minutes; nobody has called that a defect, because it is what every co-op game does.

**Ruling.** P-8's complaint is real; P-8's prescribed fix is wrong and round 5 was right
to refuse it; the correct fix is neither — it is to drop the un-mute. Inside the hold
branch, `ctx.input.enabled = false` (the mute is already implied, since `hold ⇒ screen`).
That is exactly `n8-pre`, whose whole cost is visible in the table above: the host stays
muted through the ≈1.5 s of grace, with a menu on screen throughout. One line, and it
removes a class of input confusion rather than bounding it.

---

# 6. P-3, P-4, P-6, P-7 and the three-peer arm

## 6.1 P-3 — mechanism refuted (confirmed), and C-3: the symptom reproduces

Round 5's source claim, read off the **live objects** on the client page in both arms:

```
fixedUpdateCallsReconcile: false
handleMessageCallsReconcile: true
reconcileAppliesHealth:     true
```

`NetClient.fixedUpdate` (`NetClient.js:233-248`) contains no `_reconcile` call; the only
caller is `_handleMessage`'s `MSG.SNAPSHOT` branch (`NetClient.js:166`), reached from
`ch.onmessage` and not gated on `ctx.paused`. **Round 4's stated mechanism is false.
CONFIRMED at source and by measurement.**

`p3-paused` opens a pause menu on the client **before** the kill:

| ms after the kill | `alive` | `health` | `paused` | `serverTick` |
|---|---|---|---|---|
| 600 | **false** | **0** | **true** | 160 |
| 1200 → 5400 | false | 0 | **true** | **170 → 240** |

The authoritative death lands at the **first** sample, at full pause, and the clock keeps
climbing behind the menu. `p3-normal` is identical with `paused:false`, ticks 135 → 215.
Applying the death "outside `fixedUpdate`" is where it already is. **The prescription is
a no-op. CONFIRMED.**

**And round 5's re-diagnosis is supported.** It attributes the symptom to the host —
`HOLD_GRACE` counted in wall clock guarding a frame-driven send. In my arms the symptom
appears **intermittently, and only on the host-in-a-menu path round 5 names**:

| arm | client at the end | client `serverTick` | host `tick` |
|---|---|---|---|
| `n8-pre` | `alive:false, health:0` | 100 | 105 |
| **`n8-fixed`** | **`alive:true, health:170/170`** | **100** | **105** |

Same fixture, same kill, one line apart. In `n8-fixed` the client is left **alive at full
health, with `screen: null` — not even a death screen** — its clock frozen five ticks
behind the host's, in a world that will not move again until the host closes its menu.
An earlier run of the same three arms ended with the client correctly dead in all three,
which is exactly the frame-rate dependence round 5 predicted.

So: the mechanism round 4 stated is false, the mechanism round 5 proposes is consistent
with everything I measured, and **the defect is real and player-facing rather than
theoretical**. Round 5's decision to defer a change to `_holdSession` — the one method
carrying L-1, N-8 and the grace together — is defensible **only while the co-op entry
stays hidden**.

## 6.2 P-4 — both real halves confirmed, and round 5's refusal of the third confirmed

Sequence: join → refused (`__proto__`) → both sides `leave()` → join again → disconnect.

| step | `latch-fixed` | `latch-P4latch` (`P4-latch`) | `latch-P4bind` (`P4-bindhost`) |
|---|---|---|---|
| session 1 | refused, both sentences correct | same | same |
| after `leave()` | `_refused` **false**, both idle | `_refused` **true** | `_refused` false |
| session 2 | host `players` **2** | `players` 2 | host `players` **3** for two people |
| the departure | client: ***"Disconnected from the host."*** | client: ***"Connected. Rebuilding the host's world…"*** — the disconnect is **swallowed** and the panel claims a connection that does not exist | client: *"Disconnected from the host."* |

Both gates fail on purpose. **CONFIRMED.**

**And round 5's §5.1 is right.** `_refusedPeers` reads `[]` at **every** step of **all
three** arms — including `latch-P4latch`, where the clear is reverted. The refused peer's
own `netPlayerLeft` deletes the entry one turn after the refusal, and `Peer.close()`
calls `onClose` synchronously (`Transport.js:63-67`), so the Set is already empty when
`leave()` runs. Round 5 declining to claim that half as a measured fix, and labelling the
surviving line defensive, is exactly right.

## 6.3 P-6, P-5, P-7

* **P-6** — both roles' `console.warn` branches are present at source (`NetHost.js:205`,
  `NetClient.js:192`) and the client's fired in `prior-fixed`. I did not re-drive round
  5's thirteen-shot battery; its numbers are internally consistent and I have no reason
  to doubt them. **Accepted, not independently re-derived.**
* **P-5** — gated above (`gate-trunc1-P5only`), both ends, both machines. **CONFIRMED.**
* **P-7** — `PROTOCOL_VERSION = 4` is live and visible in the rendered sentence
  (*"theirs 0, ours 4"*). The reasoning is sound and the cost — a pre-round-5 build can
  no longer join — is the correct outcome and is free while the entry is held.
  **CONFIRMED, and I agree with the decision.**

## 6.4 The three-peer arm — run, and it reproduces cell for cell

`three-live`, host `ranger` + A `anvil` + B `kestrel`, all three gated on a running game
before either join:

| sample | `live` | `hold` | `paused` | `input` | pawns |
|---|---|---|---|---|---|
| both joined | true | false | false | true | `anvil:alive`, `kestrel:alive` |
| host opens its pause menu | true | **true** | **false** | **false** | both alive |
| **one pawn dead, one live** | **true** | **true** | **false** | **false** | `anvil:dead`, `kestrel:alive` |
| both dead, inside the grace | **false** | true | false | **true** | both dead |
| both dead, after the grace | false | false | **true** | true | both dead |

`hasLivePeer()` answers exactly the question it is named for at three peers: one dead
pawn does not start the grace, un-mute the host, or pause the world under the survivor
still playing. A's and B's `serverTick` advanced 80 → 190 and 115 → 190. The fourth row
is C-4's window again, now with two peers dead.

`three-refuse`: `clients` 2 → 1, pawns `[anvil, kestrel]` → `[anvil]`, `players` 3 → 2,
A stays connected with `serverTick` climbing **95 → 205 → 225** across the refusal, B
reads `refused`, the host reads the bounded refusal. **No collateral, 0 page errors on
all three pages. CONFIRMED.**

### C-10 — the status wart is not three-peer-specific

Round 5 reports §6.1 as something the three-peer arm surfaced. It reproduces at **two**
peers, on **every** successful join in **every** arm I ran: the host's recorded status
sequence ends `… peerJoined → peerConnecting`, so the panel settles on *"Reply accepted —
connecting…"* with `players 2` (or 3) and the peers playing.
`HostTransport.createInvite`'s `accept` returns the `ready` promise, so
`Lobby.acceptAnswer`'s `await invite.accept(…)` resolves *after* `onPeer` has already
raised `netPlayerJoined`, and `_set('peerConnecting')` overwrites `peerJoined`. Round
5's diagnosis and cost statement are right; its scoping is not. One line in
`acceptAnswer`, and it is the last thing a host is told about a join that worked.

---

# 7. C-2 — leaving a co-op game bricks the survivor

Not on anyone's work list. It is in `Lobby.leave()`, which round 5 edited.

## 7.1 The measurement

One page, one key (`KeyW` held for 2.5 s), six readings:

| step | `netRole` | `lobbyMode` | distance moved |
|---|---|---|---|
| client **before** joining (control) | `single` | `single` | **2.103** |
| host **before** hosting (control) | `single` | `single` | **2.258** |
| client **while** joined | `client` | `client` | **1.908** |
| **client after `leave()`** | **`client`** | `single` | **0.000** |
| host after `leave()` | `host` | `single` | **2.258** |
| client after opening **and closing** the pause menu | `client` | `single` | **0.000** |

Both ends of the range on the same page with the same key. The host is unaffected
because its `netRole` is `'host'`, which is not `'client'`.

## 7.2 The cause, and the blast radius

`Lobby.leave()` (`Lobby.js:236-246`) resets `mode`, `_refused`, `_refusedPeers`,
`players` and `ctx.authority`. It does not reset **`ctx.netRole`**, which
`NetClient.init` set to `'client'` (`NetClient.js:57`) and which nothing else writes
after `Engine`'s initial `'single'` (`Engine.js:50`).

`Player.fixedUpdate` reads:

```js
if (ctx.netRole !== 'client') this.applyCommand(this._sampleCommand(ctx), h);
```
`src/entities/Player.js:366`

While joined, the survivor's motion came from `NetClient.fixedUpdate`'s own
`applyCommand`. After `leave()` that system returns immediately (`this.connected` is
false) **and** `Player.fixedUpdate` still believes it is a client. Nothing drives the
survivor. There is no error, no status, and no recovery short of reloading the page.

Three more consumers leak the same way:

* `isLocalKill` / `isLocalVictim` (`Engine.js:355-365`) take their client branches — a
  `playerDead` payload carrying no victim stops raising the death screen at all.
* `Profile._isLocalSource` (`Profile.js:1272`) never takes its `'single'` fast path, so a
  null-source death (fall damage, a hazard) stops counting toward earned counters in what
  is now a solo run.
* `Menus`' Edict note (`Menus.js:851`) will tell a solo player *"You are a guest."*

**C-5, from the same arms:** `engine.systems` grows `15 → 16 → 17` and never shrinks;
after one leave-and-rehost the host page runs **two `NetHost` systems**, and `ctx.net`
still points at the old one (`ctxNet: true`) on every page after `leave()`. Round 5's P-4
fix stopped duplicate *listeners*; duplicate *systems* remain.

**The fix.** Two lines in `leave()` — `this.ctx.netRole = 'single'; this.ctx.net = null;`
— unbrick the player. Removing the system needs an `Engine.remove`, which does not exist;
that is C-5 and it is the larger of the two.

**Reachability.** *Leave co-op* is a live button on the co-op panel (`Menus.js:378` →
`coopAction('coop-leave')` → `lobby.leave()`), reachable from the title screen and the
pause menu, both of which still carry the `Co-op` entry.

---

# 8. The single-player control

Round 5 substituted HEAD `a43cc70`'s literal HUD kill condition. I substituted that
**and** HEAD's literal `playerDead` line, named separately, and ran a longer fixture:
four kills by the player, one enemy-on-enemy kill, then **four** player-victim and
sourceless cases instead of one. Counts are `progression.stats.kills` /
`hud.stats.kills` / `pulse(reticle,'is-kill')`, wrapped upstream of the DOM.

| event | `sp-head` (HEAD's literal lines) | `sp-fixed` (this tree) |
|---|---|---|
| four kills by the player | 4 / 4 / 4 | 4 / 4 / 4 |
| an enemy kills an enemy | **5 / 4 / 4** | **5 / 4 / 4** |
| the player dies to an enemy | **5 / 4 / 4** | **5 / 4 / 4** |
| **the player dies to *itself*** | **5 / 5 / 5** | **5 / 4 / 4** |
| **the player dies, no source** | **5 / 6 / 6** | **5 / 4 / 4** |
| an enemy dies, no source | 6 / 7 / 7 | 6 / 5 / 5 |

**Round 5's three rows: CONFIRMED, identical.** Its claim that the trees are identical in
single-player is **true of its fixture and false in general** (C-9). On HEAD, a
self-inflicted or sourceless player death incremented **your own HUD kill counter and
flashed your reticle**; the branch's victim guard stops it. Both differences are
improvements, neither is a regression, and `progression` is untouched in every row —
which is the control that this is HUD-side only.

**Single-player still behaves as HEAD does in every case where HEAD was right, and better
in the two where it was not.**

---

# 9. Two source-derived findings I did not drive

## 9.1 C-6 — the invite cap counts the wrong thing

`NetHost.createInvite` throws only when `this.clients.size >= this.maxPlayers - 1`, and
`clients` is populated in `_onPeer`, i.e. **on channel open**.
`HostTransport.createInvite` mints ids from its own `_nextId++` and nothing reconciles
outstanding invites against the cap. Four invites created before anyone connects all
pass; four peers can then join and produce `maxPlayers + 1` players. Round 5 names four
peers as untested by anyone; this is why that boundary is worth testing rather than
assuming. **Not driven** — three pages is the most I ran.

## 9.2 C-7 — `HELLO_MAX_PAWN_AGE` is counted in the wrong unit

`HELLO_MAX_PAWN_AGE = 120` is documented as "two seconds", and it is — at 60 fps. It is
counted in `NetHost.tick`, which advances one per fixed step, and fixed steps only run
while frames run. In my arms the host advanced **~8 ticks per second**, so the gate's real
length was **~15 seconds**: `door-late` withheld its HELLO for 9 s of wall clock and the
pawn's age at arrival was ≈70 against a threshold of 120, so the gate never fired.

That is the mirror image of the defect round 5 correctly identified in `HOLD_GRACE` — a
wall-clock window guarding a frame-driven send. Here it is a frame-driven counter
guarding a wall-clock intent. The same slow host that makes `HOLD_GRACE` too *short*
makes `HELLO_MAX_PAWN_AGE` too *long*, and both errors point the same way: they are most
wrong on exactly the machine most likely to host badly. Any fix for C-1 that reuses this
constant inherits it.

---

# 10. The prior fixes round 5 did not re-run

Round 5 named F-7, F-9, F-10, K-5, K-10, M1, the `EventBus` isolation and the relay path
as things it did not re-run. All are here, on live two-page sessions on the fixed tree,
with an `AudioContext` actually running (`acState: "running"`).

| fix | observable | verdict |
|---|---|---|
| **F-7** | the host sees the remote pawn's `jump` carrying **`local: false`** — the flag `items.js:656`'s `if (e.local === false) return;` gates on | **holds** (the item half is source-confirmed, not driven) |
| **F-9** | a teammate's 777 through `Combat.applyDamage` moved this run's `damageDealt` by **+0** | **holds, negative half only** — my positive control never fired in either arm (no second live enemy with headroom); the guard is confirmed at `Progression.js:154` |
| **F-10** | client `timeSinceHurt()` **1003.67 → 0.08**; the forwarded `playerHurt` arrived with `amount 37.04, remaining 132.96, targetIsMe true` | **holds** |
| **K-5** | client `progression.stats.damageTaken` **0 → 18.52**, `profile.run.damageTaken` **0 → 18.52**, `damageTakenThisStage` **0 → 18.52**, against 18.52 dealt | **holds** |
| **K-10** | a source entity with `takeDamage`, **no `netId`** and 10 own keys reached the client as `source: null` (`sourceType:"null"`, `sourceKeys:null`) instead of a walked stat block | **holds — measured for the first time**; round 2 called it source-derived only |
| **M1** | teammate's death (`victimNetId 2, victimIsMe false`) leaves the client's music at **0.48**; the client's **own** death (`victimNetId 1, victimIsMe true`) takes it to **0.00204** | **holds — first re-verification with a real `AudioContext` since round 1** |
| **EventBus isolation** | a throwing `kill` listener registered second of three, four forwarded kills | **holds, and the gate fails on purpose** — below |
| **the relay path** | room code `KA99` over `tools/signal-server.mjs`; pawn **`anvil` 170/170**, `clients 1`, client `connected`, `serverTick 70`, `_hostBound true`, **0 errors on both pages** | **works — driven for the first time in seven rounds** |

**The EventBus gate, which round 4 disclosed it could not fail:**

| | `prior2-fixed` | `prior2-eb-gate` (`EB-isolate`) |
|---|---|---|
| kills reaching the listener registered **after** the thrower | **4 of 4** | **0 of 4** |
| kills reaching the listener registered **before** it | 4 of 4 | 4 of 4 |
| client page errors | **0** | **0** |

4 of 4 against 0 of 4 — round 2's exact measurement, re-derived, with the gate failing on
purpose. One thing worth naming: with the isolation reverted the throw still never
becomes a page error, because `NetClient._onMessage`'s own try/catch (N-6) catches it one
level up and logs *"[net] client dropped a malformed message from the host Error:
deliberate listener failure"*. **The two isolations compose, and the outer one masks the
inner one's absence** — which is precisely why the inner one needs its own gate.

---

# 11. Claim ledger

| # | round 5's claim | verdict |
|---|---|---|
| 1 | P-1 is closed; all doors are shut | **REFUTED** — four are; a fifth (`door-nohello`) is open. §3.3 |
| 2 | `adv-empty` / `adv-trunc3` / `adv-trunc1` / `adv-strbomb` all end refused, `pawns []`, `clients 0`, a sentence on both machines | **CONFIRMED** (settled reads) |
| 3 | each of the four carries a *different* correct diagnosis | **REFUTED as worded** — three diagnoses, four doors; behaviour correct. C-8 |
| 4 | 0 console/page errors on both machines across all five P-1 arms | **CONFIRMED** |
| 5 | `adv-legit` still joins normally | **CONFIRMED** — `anvil` 170/170, both ends agree to the cent |
| 6 | R-1 (the strbomb `console.error`) is reproduced and closed | **CONFIRMED** — `gate-strbomb-P1parse` |
| 7 | each P-1 gate fails on purpose in isolation | **CONFIRMED** — four gates, one substitution each (one row uses two, named) |
| 8 | the latch must be armed before the parse, because the prescribed order leaves a retry hole | **REFUTED** — `gate-retry-prescribed` refuses and drops the peer too. The deviation is harmless, its justification undemonstrated. §3.4 |
| 9 | P-8's prescription reverts N-8 | **CONFIRMED**, causally: lock true → false across `Menus.open`, 0-2 locked samples per arm and none during the hold |
| 10 | the P-8 residual is "the right trade" | **DISPUTED** — the un-mute can only fire behind a menu and shares its keys. C-4, §5.2 |
| 11 | P-3's stated mechanism is false at source | **CONFIRMED** — `fixedUpdateCallsReconcile: false` off the live prototype |
| 12 | `p3-paused` applies the authoritative death with the client paused throughout | **CONFIRMED** — dead at the first 600 ms sample, `paused:true`, ticks 160 → 240 |
| 13 | the real cause is on the host, and the symptom is a real defect | **CONFIRMED** — `n8-fixed` ends `alive:true, health:170`, no death screen, client tick 100 vs host 105. C-3 |
| 14 | the critique's `adv-huge` gate does not fail | **ACCEPTED, not re-tested** — I built the congestion arm instead, as round 5 did |
| 15 | the congestion arm: `setTimeout(0)` loses the refusal at 6 291 456 bytes queued, `_closeWhenFlushed` delivers it | **CONFIRMED** — `refused` vs `disconnected` on identical fixtures |
| 16 | the detail bound holds at both ends | **CONFIRMED** — 137 vs 60 073 characters |
| 17 | the `_refused` half of P-4 is real and closed | **CONFIRMED** — the gate swallows the disconnect and claims a live connection |
| 18 | the duplicate-listener half of P-4 is real and closed | **CONFIRMED** — `players 3` for two people with the guard reverted |
| 19 | the `_refusedPeers` half does not reproduce | **CONFIRMED** — `[]` at every step of all three arms, including the reverted one |
| 20 | three peers behave; no defect | **CONFIRMED** — both arms, cell for cell |
| 21 | §6.1's status wart is pre-existing and cosmetic | **CONFIRMED** — and it is not three-peer-specific; it fires on every join at two peers. C-10 |
| 22 | P-5 closed and gated, both ends | **CONFIRMED** — *"theirs 0, ours 4"* vs *"its identity message was truncated"* |
| 23 | `PROTOCOL_VERSION` → 4 is the right call | **CONFIRMED** — live in the rendered sentence, and I agree with the reasoning |
| 24 | P-6 closed, both roles | **ACCEPTED, partially re-derived** — both branches present at source, the client's fired; the 13-shot battery not re-driven |
| 25 | single-player matches HEAD's literal condition | **CONFIRMED for its fixture, REFUTED as a general claim** — two more rows differ, both improvements. C-9 |
| 26 | prior fixes L-1, L-2, K-1, L-3, F-6, N-3, N-4, N-5, N-6, N-8 all hold | **ACCEPTED, spot-checked** — L-2/K-1 re-derived via `adv-legit`/`door-nohello`, N-4's latch via `door-race`/`ctrl-retry-shipped`, N-5 via `latch-*`, N-8 via §5, L-1 via §5.1's control |
| 27 | F-7, F-9, F-10, K-5, K-10, M1, the EventBus isolation and the relay path were not re-run | **all re-run** — all hold; K-10 and the relay driven for the first time. §10 |
| 28 | the hold on the Co-op menu entry should stay | **CONFIRMED** — and it is still un-applied; the button is live |
| 29 | the substitution guard aborted arms rather than reporting a fixed reading as reverted | **CONFIRMED** — and my own harness caught nothing it should not have |

**Confirmed 21 · Refuted 4 (one of them the headline) · Disputed 1 · Accepted without independent re-derivation 3.**

---

# 12. Arms I did not run

Naming them is not a claim that they are fine.

1. **Four peers**, and the `maxPlayers` boundary — including C-6, which is source-derived.
2. **`constructor` / `toString` as survivor ids** — `__proto__` was driven; the others
   follow from `Object.create(null)` and are asserted.
3. **A v3 build meeting a v4 one**, and a `REFUSE` reaching a build that does not know
   the code. Both need two builds.
4. **Real network conditions.** Every timing number here is a zero-lag loopback number,
   and §4 shows what that hides about the 128 ms flush cap.
5. **P-6's thirteen-shot battery**; **P-3 at a throttled-but-not-crawling frame rate**,
   the arm that would turn C-3 from intermittent into characterised; and **the C-4
   un-mute window timed directly**, which needs a host fast enough to sample inside it.
7. **`door-dup`** and **`door-late`** — disqualified, §1.2 items 4 and 5.
8. **A stage transition, a client pulling its own trigger, and whether any of it sounds
   right.** Still not run, by anyone, in seven rounds.
9. **N-1.** Untouched. No enemy in this build has ever targeted a pawn.

---

# 13. Where co-op stands, and what it would take

*Written to be read cold. Assume nothing about the twelve reports before it.*

## What a player gets today

Two to three people in one machine's world, connected either by copy-pasting invite codes
or through a relay room code, playing the host's run. The host simulates everything;
clients predict their own movement and interpolate everyone else. It works: pawns are
stated as the right survivor, health and barrier agree between the two ends to the cent,
damage feedback and run bookkeeping reach the client, a host's death no longer freezes
the world for everyone still in it, a refused join is explained in plain English on
**both** machines, and three peers behave exactly as two do. Seven rounds of work are
visible in that list and none of it is fake.

## What is still broken

| | what it costs a player | to fix |
|---|---|---|
| **N-1 — no enemy has ever targeted a co-op pawn** (pre-existing, untouched by all seven rounds) | A co-op session is one player being attacked and one player being ignored. Every monster chases `ctx.player`, which on a host is the host's own survivor. The guest is functionally invulnerable and the host takes the entire game. **This is not a bug in co-op; it is the reason co-op is not a game yet.** | Per-enemy targeting: a nearest-player query, and routing `hurtPlayer`/`statusPlayer` through it. Days, not hours, and it changes combat balance for single-player if done carelessly. |
| **C-1 — the fifth door** (§3.3) | A peer that sends no HELLO is simulated as the host's survivor for the whole session, silently. The two ends' health readings drift 38 points apart on a 40-point hit. | ~4 lines in `NetHost.fixedUpdate`, reusing `joinTick`, `HELLO_MAX_PAWN_AGE` and `_refuse`. Fix **C-7** first, or it inherits a 15-second timeout. |
| **C-2 — `leave()` bricks the survivor** (§7) | Press *Leave co-op* and your character never moves again. No error. Only a page reload recovers. | 2 lines in `Lobby.leave()`. |
| **C-3 — a client that dies without dying** (§6.1) | A client whose pawn dies while the host has a menu open can be left **alive at full health with no death screen**, in a world that will not move again until the host closes the menu. Intermittent; incidence rises as the host's frame rate falls. | Count the hold grace in snapshots sent rather than in wall clock. It touches `_holdSession`, which carries L-1, N-8 and the grace together — the riskiest method in `src/net/`. |
| **C-4 — the input un-mute behind a menu** (§5.2) | For up to 1.5 s after the last peer dies, the keys you are using to work the pause menu also drive your survivor. | 1 line in `_holdSession`. |
| **C-5 — session teardown leaks systems** (§7.2) | Nothing visible yet; two `NetHost`s and a dangling `ctx.net` after one leave-and-rehost. The kind of leak that becomes a bug the third time someone touches the lifecycle. | Needs an `Engine.remove`, which does not exist. Half a day. |
| **C-6, C-7, C-10** (§9, §6.4) | An over-capacity lobby; a join gate whose real length depends on frame rate; a host never told in words that the player it accepted has arrived. | Small, each. C-10 is one line in `acceptAnswer`. |
| **Still never driven** | Four peers, a stage transition mid-session, real network latency, and whether any of it sounds right. | Unknown, which is the point. |

## Does the hold on the Co-op menu entry still stand?

**Yes, and more firmly than before.** N-1 alone justifies it: co-op today is a mode in
which one of the two players cannot be hurt. C-1, C-2 and C-3 are each independently
shipping-blockers — one silently mis-simulates a player, one permanently disables a
character, one strands a dead player alive.

**And it is important to say plainly: the hold has never been applied.** The `Co-op`
button is live on the title screen (`Menus.js:187`) and in the pause menu
(`Menus.js:292`). Every previous round has recommended hiding it; nobody has. If this
branch ships as it stands, players will find that button. **Hiding it is a two-line
change and it is the single highest-value edit on this list.**

## Is the single-player half still shippable alone?

**Yes.** `src/net/` runs at all only when `ctx.lobby.mode !== 'single'`, nothing in round
5 is reachable from a single-player session, and the one place round 5 touched that
single-player *does* execute — the HUD's kill condition — I compared against HEAD
`a43cc70`'s literal lines across nine events: identical in every row where HEAD was
right, and better in the two where HEAD counted your own death as a kill (§8). Note that
C-1 through C-5 are all reachable only *through* the co-op entry, so hiding that entry
closes every one of them for shipping purposes.

## The remaining work, in priority order

1. **Hide the Co-op menu entry.** Two lines. Everything below stops being urgent the
   moment this is done.
2. **C-2** — reset `ctx.netRole` (and null `ctx.net`) in `leave()`. Two lines, and the
   only defect here that permanently disables a player's character.
3. **C-1** — refuse a peer that never sends a HELLO, with **C-7** (count the age in
   seconds, or state the tick threshold as frame-rate-dependent) as its prerequisite.
4. **N-1** — enemies must target pawns. The difference between "co-op exists" and "co-op
   is worth shipping", and the largest single item on the list.
5. **C-4** — drop the input un-mute. One line.
6. **C-3** — count the hold grace in snapshots. After 4, and only with new arms at a
   throttled frame rate, because `_holdSession` carries three load-bearing fixes at once.
7. **C-10** — order `acceptAnswer`'s status set before `netPlayerJoined`. One line.
8. **C-5, C-6** — `Engine.remove` and the invite cap. Housekeeping, but they are the two
   places where the next lifecycle change will go wrong.
9. **Drive the paths nobody has driven**: four peers, a mid-session stage transition, and
   one session under real latency. Four of the seven findings in this report were found
   by pointing a rig at something nobody had pointed one at.

---

*Raw JSON for every arm quoted here: `reviews/round7/coop/r5-critique/` (42 arms).
Drivers deleted.*
