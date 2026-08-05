# Round 7 — round-4 co-op fixes
## Step 1 of `round3-critique-coop.md` §14.3: items 2-6 of its §14.2 table

Everything below is measured on this tree, in this working directory, with all
three prior fix rounds present and **nothing committed, staged or reverted**.
Port 5199 was never touched, no running node or vite process was killed or
restarted, and `src/` was never modified to build a test arm.

---

# 0. Headline

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 718ms`,
re-run at the end after both drivers were deleted). `git status` shows the
sixteen files it showed at the start plus **two more** — `src/net/Lobby.js` and
`src/ui/Menus.js`, which is where "refuse" becomes a sentence a player reads.
Eighteen modified, nothing staged.

**All five closed.** Each is confirmed at both ends, each with its gate failed on
purpose **in isolation**, and N-7's single-player behaviour is measured against
HEAD `a43cc70`'s exact line rather than against the current tree.

| # | finding | verdict | the failed gate that proves it |
|---|---|---|---|
| 2 | **N-7** HUD kill guard widened, in single-player | **CLOSED** | `sp-r3` reproduces 4 → **5** → **6** with 6 reticle flashes; `sp-fixed` == `sp-head` at 4 / 4 / 4 |
| 3 | **N-4** HELLO is an unlimited pawn reset | **CLOSED** | `n4-none` reproduces 45/170 → **90/90 → 170/170 → 90/90 → 170/170**; `n4-fixed` refuses the first replay |
| 4 | **N-5 + N-3** unknown id / no version check | **CLOSED** | `n5-pre` re-creates L-2 (pawn `ranger` 110 under a client playing `anvil` 170); `n3h-pre` and `n3c-pre` accept `version 99` in full |
| 5 | **N-6** malformed message throws uncaught | **CLOSED, both roles** | `n6h-pre` / `n6c-pre` give uncaught `Invalid typed array length`; the fixed arms give one `console.error` and zero page errors |
| 6 | **N-8** 1.68 s muted, exposed host | **CLOSED** | `n8-pre` holds `input.enabled false` through **1447 ms**, releases at **1652 ms**; `n8-fixed` is back on by **207 ms** |

**What "refuse on mismatch" means for the user** — §4.3. Short version: the host
sends a new `MSG.REFUSE` carrying a reason, *then* closes the peer; both machines
raise a lobby status carrying that reason, and both render a plain sentence in
the co-op panel. Measured on both pages, and re-rendered correctly when the panel
is opened *after* the fact. Neither a silent drop nor an uncaught throw.

## 0.1 Arms

Twenty-five sessions: 3 single-player, 22 co-op. Every co-op number is two real
Chromium pages on one real WebRTC wire over the manual invite path
(`createInvite` / `joinManual` / `acceptAnswer`), ports **5801-5820**. Sabotage is
by named in-memory substitution inside a vite `transform`; every anchor is
validated against `src/` on disk before the arm boots and the transform throws
unless it matches **exactly once**. `substitutionsMissing` is `[]` in all 25.

| arm | substitutions | what it does | raw |
|---|---|---|---|
| `sp-fixed` | *(none)* | this tree, single player | `sp-n7.json` |
| `sp-head` | `N7-head` | **HEAD `a43cc70`'s exact HUD line** | `sp-n7.json` |
| `sp-r3` | `N7-r3` | round 3's `if (isLocalKill(ctx, e))` | `sp-n7.json` |
| `main-fixed` | *(none)* | L-2 + L-4 + N-7's co-op end | `main-fixed.json` |
| `main-n7pre` | `N7-hud` | N-7 in co-op | `main-n7pre.json` |
| `main-l4pre` | `L4-prog` | L-4 re-verified | `main-l4pre.json` |
| `main-l2pre` | `L2-hello` | L-2 re-verified | `main-l2pre.json` |
| `n4-fixed` / `n4-nolatch` / `n4-noage` / `n4-none` | — / `N4-latch` / `N4-age` / both | N-4, each gate failed alone and both together | `n4-*.json` |
| `n5-fixed` / `n5-pre` | — / `N5-cat` | an unknown survivor id in the **first** HELLO | `n5-*.json` |
| `n3h-fixed` / `n3h-pre` | — / `N3-host` | a peer declaring `version 99` | `n3h-*.json` |
| `n3c-fixed` / `n3c-pre` | `FX-hostv99` / + `N3-client` | a **host** declaring `version 99` | `n3c-*.json` |
| `n6h-fixed` / `n6h-pre` | — / `N6-host` | a truncated HELLO | `n6h-*.json` |
| `n6c-fixed` / `n6c-pre` | — / `N6-client` | a malformed EVENT at the client | `n6c-*.json` |
| `n8-fixed` / `n8-pre` | — / `N8-input` | the grace window | `n8-*.json` |
| `l1-fixed` / `l1-pre` | — / `L1-hold` | L-1 re-verified | `l1-*.json` |

The substitution table is §7. **`FX-hostv99` is a fixture, not a revert**, and is
labelled as one in the table and in the driver — it makes a version-skewed host
exist so the client's half of N-3 has something to refuse. Nothing else in this
document is taken through a substitution that is not a faithful revert.

## 0.2 The gates

Every arm blocks on the game actually running on **both** pages before anything
else happens:

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

`runningGate` on `main-fixed`: host `{paused:false, screen:null, localTick:66,
survivorId:"ranger", maxHealth:110}`, client `{paused:false, screen:null,
localTick:70, survivorId:"anvil", maxHealth:170}`. Two survivors, deliberately —
that is what makes L-2 measurable.

A second gate after the join, because the second page steals pointer lock and
`Menus` opens the pause screen on losing it. `runningGateAfterFocus` on
`main-fixed`: host `{paused:false, screen:null, _localTick:376, clients:1}`,
client `{paused:false, screen:null, net.tick:138, myNetId:1, connected:true}`.

**The brief's gate is not literally attainable on a client after it joins**, and
round 3's critique §1.2 is why: `resetCommandEpoch` zeroes the player's counter
and `NetClient.fixedUpdate` stamps from its own `this.tick`, so a joined client's
`player._localTick` is 0 forever. The post-join gate uses `net.tick` on that role.
I re-derived this rather than taking it on trust — it is `null`/0 on every client
row in all 22 co-op files.

---

# 1. N-7 — the HUD kill guard. MAJOR, and it was live in single-player

## 1.1 The prescription is not sufficient, and here is why

The critique's §14.2 costs this at "one clause — `!e?.victim?.isPlayer &&`, the
guard `Progression` already has". **That clause alone does not restore HEAD's
behaviour**, and the critique's own §9.4 says so in its last sentence ("plus
restoring the non-player-source exclusion if that was intended"). Worked through:

| single-player event | HEAD's condition | `isLocalKill` alone | `!victim.isPlayer && isLocalKill` |
|---|---|---|---|
| your own kill (`source === ctx.player`) | count | count | count |
| **an enemy kills an enemy** | **skip** | count | **count** ← still wrong |
| your own death (enemy source) | skip | count | skip |

`isLocalKill`'s authority branch is `!(source?.isPlayer && ctx.player && source
!== ctx.player)` — it excludes **other players** and nothing else, deliberately,
because it was written for the run summary where an environmental kill *should*
count. HEAD's condition excludes **non-player sources**. They are different
questions and the HUD needs both answered, plus the victim guard.

## 1.2 The edit

`src/ui/HUD.js:186-188` — three clauses, each with its own reason in the comment
above it:

```js
const src = e?.source;
const localSource = !src || src === ctx.player || src.isPlayer;
if (!e?.victim?.isPlayer && localSource && isLocalKill(ctx, e)) {
```

`localSource` is HEAD `a43cc70`'s exact condition, recovered with `git show
a43cc70:src/ui/HUD.js` and not retyped from the critique.

**One case is deliberately narrower than HEAD**: a player victim with a *player*
source. At HEAD that counted +1 (`source.isPlayer` → true). It is unreachable in
single-player in any arm I ran — the only player-victim kill available there has
an enemy source — and in co-op it is exactly "the host killed a teammate's pawn",
which is what `main-n7pre` shows flashing a kill confirm. This is a narrowing I
am choosing, it is the rule `Progression` already applies, and it is named here
rather than smoothed over.

## 1.3 Single-player, against HEAD's behaviour — both ends

`sp-n7.json`, three arms, identical fixture: seven beetles, four killed by the
player, one killed **by another enemy**, then the player killed by an enemy with
i-frames cleared. `killFlashes` counts `pulse(reticle, 'is-kill')` upstream of
the DOM by wrapping `HUD.pulse` and calling through.

| single-player event | `sp-head` (HEAD's line) | `sp-fixed` (this tree) | `sp-r3` (round 3's line) |
|---|---|---|---|
| four kills by the player | prog 4 / **HUD 4** / flash 4 | prog 4 / **HUD 4** / flash 4 | prog 4 / **HUD 4** / flash 4 |
| **an enemy kills an enemy** | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 5** / **flash 5** |
| **the player's own death** | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 6** / **flash 6** |

**`sp-fixed` matches `sp-head` in every cell, including the flash count.**
`sp-r3` reproduces the critique's `4 → 5 → 6` exactly. Fixture checks on all
three: `sourceWasEnemy true`, `attackerIsPlayer false`, `victimDied true`,
`killerIsPlayer false`, `playerAlive false`, `playerHealth 0`, 0 console errors,
0 page errors, and `progression` reads 4 / 5 / 5 on all three arms — the
Progression counter is untouched, which is the control that the change is
HUD-only.

## 1.4 Co-op, both ends

`main-fixed.json` / `main-n7pre.json`, host `ranger` + client `anvil`:

| | `main-n7pre` (`N7-hud`) | `main-fixed` |
|---|---|---|
| host HUD after 4 own kills | 4, flash 4 | 4, flash 4 |
| after the **pawn's** kill | 4, flash 4 | 4, flash 4 |
| **after the pawn dies** | **5, flash 5** | **4, flash 4** |
| host `progression.stats.kills` throughout | 4 | 4 |

A teammate's death flashes a kill confirm on the host's reticle on the reverted
arm and does not on this one. That is the co-op end of the same defect.

---

# 2. N-4 — HELLO is no longer an unlimited pawn reset. MAJOR

## 2.1 The edit, and the part of the prescription that does not work

`src/net/NetHost.js:226-249` (`_onHello`), plus `:116` and `:35`.

The critique's prescription is "latch HELLO, gate the re-stat on pawn age
(`c.pawn._localTick < N`)". **`_localTick` is not the age of a pawn.** It only
advances in `Player._sampleCommand` (`Player.js:407`), which a network-driven
pawn never runs — it reads **0 on a pawn for the whole session**, so that gate
would have been a no-op that looked like a fix. The age is measured instead in
`NetHost`'s own tick, from the tick at which the pawn was spawned:

```js
// NetHost.js:116, in _onPeer
joinTick: this.tick, helloSeen: false, survivorId: null,
// NetHost.js:228
if (c.helloSeen) return this._refuse(peer, REFUSE.HELLO, 'a second identity message');
c.helloSeen = true;
// NetHost.js:238
if (this.tick - (c.joinTick ?? 0) > HELLO_MAX_PAWN_AGE) {   // 120 ticks, 2 s at 60Hz
  return this._refuse(peer, REFUSE.HELLO, 'it arrived too late to re-stat the pawn safely');
}
```

## 2.2 Four arms, because each gate has to fail alone

Fixture, identical in all four: join, settle, host damages the pawn to **45/170**,
then the client sends four hand-built HELLOs (`kestrel`, `anvil`, `kestrel`,
`anvil` — all valid ids at the correct version) straight down the events channel.
`pawnAgeTicks` at the first replay is **171-179** in all four files, so the age
gate is genuinely exercised rather than trivially satisfied.

| arm | reverted | pawn after each of the four replays | outcome |
|---|---|---|---|
| `n4-none` | `N4-latch` + `N4-age` | **90/90 → 170/170 → 90/90 → 170/170** | the exploit, reproduced exactly |
| `n4-nolatch` | `N4-latch` | refused on the first — *"it arrived too late to re-stat the pawn safely"* | **the age gate alone catches it** |
| `n4-noage` | `N4-age` | refused on the first — *"a second identity message"* | **the latch alone catches it** |
| `n4-fixed` | — | refused on the first, `pawns []` | closed |

`n4-none` is the critique's H4 row reproduced on this tree from a pawn at
**45/110-equivalent** (45 of 170): four HELLOs, four full heals, and a survivor
swapped mid-run while the client's own `ctx.player` stayed `anvil` 170 throughout
(`clientOwn {survivorId:"anvil", maxHealth:170, connected:true}`).

The two single-gate arms are the point: **either gate alone is sufficient**, so
neither is dead weight and neither is load-bearing alone. That is why there are
four arms and not two.

**A cost I am choosing and naming.** A replayed HELLO now *drops the peer*
(`n4-fixed`: `pawns []`, client `connected:false`, both lobbies say why). The
stock client sends exactly one HELLO, in one place, on the reliable channel
(`NetClient.js:80`), so a second one is a modified client or a bug — and the
alternative to dropping is either the free full heal or a silent no-op that
leaves the peer wondering. It is refused out loud instead.

---

# 3. N-5 + N-3 — the trust boundary. MODERATE

## 3.1 The edits

| what | where |
|---|---|
| host compares the peer's version | `NetHost.js:231-233` |
| host validates the survivor id against the catalogue | `NetHost.js:235-237` (`SURVIVOR_BY_ID`) |
| host refuses, out loud, then drops | `NetHost.js:255-262` (`_refuse`) |
| the message itself | `Protocol.js:62` (`MSG.REFUSE`), `:76-80` (`REFUSE`), `:82-92` (`writeRefuse`/`readRefuse`) |
| client compares the host's version | `NetClient.js:134-138`, in `MSG.WELCOME` **before any other field is read** |
| client handles a refusal | `NetClient.js:181-184`, `:197-201` (`_refused`) |
| the lobby carries the reason | `Lobby.js:56`, `:76`, `:79-82`, `:134-140` |
| the player reads a sentence | `Menus.js:25-51` (`refusalText`), `:1245-1246`, `:1118` |

`PROTOCOL_VERSION` stays at **3** and the header comment at `Protocol.js:36-49`
now says why: no message layout moved, and a new message *code* is inert to a
reader that does not know it. It is bumped the next time bytes move — and the
check added here is what will make that bump mean something.

The client reads the version **first and returns on mismatch**. That ordering is
the fix, not decoration: WELCOME's trailing fields moved at 2 and the entity
record moved at 3, so reading past a skewed version is exactly what garbles a
session.

## 3.2 N-5 — an unknown survivor id, both ends

`n5-*.json`. The client's **first** HELLO carries `survivorId: "not-a-survivor"`
at the correct version. (Built by replacing `NetClient._sendHello` on the client
page in the same synchronous turn `joinManual` returns — `_sendHello` is called
from inside `connected.then(...)`, many turns later, so this is not a race.)

| | `n5-pre` (`N5-cat`) | `n5-fixed` |
|---|---|---|
| the host's pawn for that peer | **`ranger` 110 / 110** | **none — peer refused** (`pawns []`) |
| the client's own survivor at the same instant | `anvil` **170** | `anvil` 170 |
| host `clients.size` | 1 | **0** |
| host lobby status | `peerConnecting` | **`peerRefused {reason:"survivor", detail:"not-a-survivor"}`** |
| client lobby status | `connected` | **`refused {reason:"survivor", detail:"not-a-survivor"}`** |
| host page errors / client page errors | 0 / 0 | 0 / 0 |

**`n5-pre` is L-2, re-created from one bad byte**: a peer playing `anvil` at 170
simulated by the authority as `ranger` at 110, with no error anywhere on either
machine. That is the whole finding, measured.

## 3.3 N-3 — the version check, both directions and both ends

**Host half** (`n3h-*.json`) — the client declares `version: 99`:

| | `n3h-pre` (`N3-host`) | `n3h-fixed` |
|---|---|---|
| the pawn afterwards | **`anvil` 170 / 170 — accepted in full** | **none, peer refused** |
| host `clients.size` | 1 | 0 |
| host status | `peerConnecting` | `peerRefused {version, "theirs 99, ours 3"}` |
| client status | `connected` | `refused {version, "theirs 99, ours 3"}` |
| page errors | 0 / 0 | 0 / 0 |

`n3h-pre` reproduces the critique's H5 exactly — `version: 99` accepted silently.

**Client half** (`n3c-*.json`) — the host's WELCOME declares `99` (`FX-hostv99`):

| | `n3c-pre` (`FX-hostv99` + `N3-client`) | `n3c-fixed` (`FX-hostv99`) |
|---|---|---|
| client `myNetId` | **1 — read straight past the mismatch** | **0 — never read** |
| client `connected` | `true` | **`false`** |
| the host's pawn | `anvil` 170 | **none** |
| client status | `connected` | **`refused {version, "theirs 99, ours 3"}`** |
| host status | `peerConnecting` | `peerLeft` |

Both ends, both directions. `n3c-fixed`'s host row is the one honest wart: the
host says *"A player left. 1 in the game."*, because in that direction the host
genuinely does not know why — the client refused **it**, and it did so before
sending anything the host could read. Naming it rather than dressing it up.

## 3.4 What "refuse" means for the person holding the mouse

This is the part the brief asked me to decide and state. A silent drop is not
acceptable and neither is an uncaught throw, so:

1. The host writes `MSG.REFUSE` with a machine-readable reason and a human
   detail onto the **reliable** channel, then closes the peer on the next turn
   so the message is actually flushed (`NetHost._refuse`). A closed channel sends
   nothing; that `setTimeout(…, 0)` is load-bearing.
2. Both machines raise a lobby status — `netPeerRefused` on the host,
   `netRefused` on the client — and both are latched so the generic disconnect
   that follows a fraction of a turn later **cannot overwrite the reason**
   (`Lobby.js:76`, `:140`). That ordering bug was real and is why the latches
   exist.
3. `Lobby` keeps `statusDetail`, so opening the co-op panel *after* the refusal
   still renders the reason rather than a shrug (`Menus.openCoop`, `Menus.js:1118`).

Measured, read off the live DOM on both pages (`hostSaid` / `clientSaid`, taken
by opening the real co-op screen and reading `[data-coop-status]`):

| arm | the host reads | the joiner reads |
|---|---|---|
| `n5-fixed` | *"Turned a player away: they picked a survivor this build does not have (not-a-survivor)."* | *"The host does not have the survivor you picked. Choose one from their build and join again."* |
| `n3h-fixed` | *"Turned a player away: they are running a different version of the game (theirs 99, ours 3). Both of you need the same build."* | *"That host is running a different version of the game (theirs 99, ours 3). Both of you need the same build."* |
| `n3c-fixed` | *"A player left. 1 in the game."* (§3.3) | *"That host is running a different version of the game (theirs 99, ours 3). Both of you need the same build."* |

---

# 4. N-6 — a malformed message costs one message. MODERATE, both roles

`NetHost.js:164-170` and `NetClient.js:113-119`. `_onMessage` becomes a try/catch
around `_handleMessage`, which is the old body verbatim. The `console.error`
matches `Engine.emit`'s convention (`Engine.js:296`) deliberately, and for the
same stated reason: a listener — or a message — that throws is still a bug, and
this must not be the reason nobody finds it.

**Host half** (`n6h-*.json`) — a five-byte HELLO whose string length prefix
claims 200:

| | `n6h-pre` (`N6-host`) | `n6h-fixed` |
|---|---|---|
| host **page** errors (uncaught) | **1 — `RangeError: Invalid typed array length: 200`** | **0** |
| host **console** errors | 0 | **1 — `[net] host dropped a malformed message from peer 1 … 200`** |
| host `net.tick` across the probe | 164 → 220 | 166 → 219 |
| `clients.size` / `paused` | 1 / false | 1 / false |
| the pawn | `anvil` 170, untouched | `anvil` 170, untouched |

The stack in the reverted arm is the critique's, line for line: `Reader.str
(Protocol.js:195)` ← `readHello` ← `_onHello` ← `_handleMessage` ← `_onMessage` ←
`peer.onMessage` ← `ch.onmessage (Transport.js:44)`.

**Client half** (`n6c-*.json`) — the host sends a three-byte `MSG.EVENT` whose
name length claims 60000:

| | `n6c-pre` (`N6-client`) | `n6c-fixed` |
|---|---|---|
| client **page** errors | **1 — `Invalid typed array length: 60000`** | **0** |
| client **console** errors | 0 | **1 — `[net] client dropped a malformed message from the host`** |
| client `net.tick` | 140 → 196 | 137 → 193 |
| `connected` / own health | true / 170 | true / 170 |

Both roles, both ends. The client half is the arm the critique's §12.11 named as
not run.

**Named residual, R-1.** A HELLO that *throws while parsing* is now dropped, and
the peer stays connected on the host's survivor — which is the L-2 silent
mis-stat, reached by a different door. Closing it means refusing the peer on a
parse failure, which the prescription did not ask for and which I have not built.
It is not reachable from the stock client (`writeHello` is the only writer). It is
named, not fixed.

---

# 5. N-8 — the grace stops muting the host. MODERATE

`NetHost.js:326` and `:349`. One line, plus hoisting `hasLivePeer()` into a local
so the two questions can be asked separately:

```js
const live = this.hasLivePeer();
…
if (ctx.input) ctx.input.enabled = !live;
```

The grace and the mute answer different questions. The grace exists so a peer
that has just died still gets the snapshot carrying its own death; the mute exists
because the world is still being played by somebody. Tied together, they were
answering the first question with the second one's answer.

`n8-*.json`. The host opens its pause menu with a live peer, four samples; then
the peer's pawn is killed authoritatively and the host is sampled every 200 ms
for 2.7 s.

**Before the death — unchanged, which is the control:**

| | `n8-pre` | `n8-fixed` |
|---|---|---|
| host `paused` / `input.enabled` / `_holding` / `hasLivePeer`, ×4 | `false` / **`false`** / `true` / `true` | `false` / **`false`** / `true` / `true` |
| client `serverTick` across the overlay | 226 → 262 | 279 → 314 |

**After the death:**

| ms since the peer died | `n8-pre` `input.enabled` | `n8-fixed` `input.enabled` | `paused`, both arms |
|---|---|---|---|
| 4 | **false** | **false** | false |
| 207 / 210 | **false** | **`true`** | false |
| 829 / 834 | **false** | `true` | false |
| 1444 / 1447 | **false** | `true` | false |
| 1648 / 1652 | **`true`** | `true` | **`true`** |
| 2678 / 2694 | `true` | `true` | `true` |

**Both ends.** `n8-pre` reproduces the critique's window — muted through 1447 ms,
released at **1652 ms**, i.e. `HOLD_GRACE` plus a frame. `n8-fixed` is back on by
the **first sample after the death**, 207 ms, and the true bound is tighter than
that: the 4 ms row is read in the same synchronous block as the kill, before any
frame has run `_holdSession` at all, so the real window is **one frame**, and 207
ms is only the resolution of my sampling. I am not claiming better than "≤ 207 ms,
measured; one frame, by construction".

**And the grace still does its own job**, which is the thing this must not have
broken: `paused` stays `false` until 1648 ms on **both** arms, and the client's
own death lands identically on both — `{alive:false, health:0, screen:"death",
ended:true}`. Round 3's §4.3 defect stays closed.

---

# 6. Prior fixes — what I re-ran, and what I did not

## 6.1 Re-verified, each with its gate failed on purpose

| fix | why it could plausibly have moved | arm | `pre` | `fixed` |
|---|---|---|---|---|
| **L-4** (kill credit) | N-7 edits the HUD half of it | `main-l4pre` (`L4-prog`) | client `progression` **4** for the host's kills, **5** after the pawn's; host **5** (double-counting a teammate's) | client **0** then **1**; host **4** throughout |
| **L-2** (survivor crosses the wire) | N-4/N-5/N-3 all edit the HELLO branch L-2 created | `main-l2pre` (`L2-hello`) | host's pawn **`ranger` 110** under a client playing `anvil` 170, `helloSeen false` | host's pawn **`anvil` 170**, `helloSeen true` |
| **L-1** (host's death does not freeze the authority) | N-8 edits `_holdSession` | `l1-pre` (`L1-hold`) | client `serverTick` **260 ×8** over four seconds — frozen | **287 → 316 → 347 → 376 → 407 → 440 → 469 → 496** |
| **K-1 / L-5** (a client's own death is the authority's) | ridden by every co-op arm | every `main-*` arm | — | client `{alive:false, health:0, screen:"death", ended:true}` in all four |

`l1-pre`'s host row is the mechanism: `{alive:false, paused:**true**,
screen:"death", input:true, holding:false}` against `l1-fixed`'s
`{alive:false, paused:**false**, screen:"death", input:false, holding:true}`.

**One measurement I corrected rather than shipped.** My first L-1 leg read the
client's `net.tick` and showed the clock advancing on **both** arms — because
`net.tick` is the client's own prediction counter and advances whether or not the
authority is running. The observable is `net.buffer.serverTick`. The first
reading is not quoted anywhere above; the arms were re-run.

## 6.2 Not re-run, and named

- **L-3** (the client's barrier is the host's). Nothing I edited is upstream of
  `_applyAuthoritativeHealth` or of `shieldFrac`. **Not re-run.**
- **L-5** (the fail-closed victim predicate) beyond the incidental confirmation
  in §6.1 — I did not build the `R1-victim` + `L5-open` pair. **Not re-run as an
  isolated gate.**
- **K-2, K-3, the `EventBus` isolation, K-5, K-10, F-6, F-7, F-9, F-10, M1** —
  none of my five edits is upstream of any of them, and round 3's critique
  re-verified all of them on this tree eight days of work ago. **Not re-run.**
- **N-9 / K-4, K-6, N-1, N-2, N-10, N-11** — out of scope for step 1 and
  untouched. N-1 in particular is unchanged: the joiner is still never fought.

## 6.3 Arms I did not test

Naming them is not a claim that they are fine.

1. **Three or four peers.** Every arm here is host + one client. `hasLivePeer()`
   with one dead pawn and one live one is exercised by round 3's critique's
   three-page sessions, not by mine, and N-8's release predicate is the one thing
   I changed that reads it. **This is the gap I would close first.**
2. **A refused peer while a second peer is playing.** `_refuse` drops one peer;
   whether the host's lobby list and `_holdSession` behave with a survivor still
   in the game is unmeasured.
3. **Real network conditions.** Loopback WebRTC on one machine. N-8's 207 ms and
   `HELLO_MAX_PAWN_AGE`'s 2 s are zero-lag numbers; under real RTT a legitimate
   first HELLO is later, and 120 ticks is a guess with two orders of magnitude of
   headroom rather than a measurement.
4. **A HELLO deliberately withheld past the age gate by a legitimate client.**
   The age gate refuses it; I measured that (`n4-nolatch`) but only with a
   *replay*, never with a genuine slow first HELLO.
5. **`MSG.REFUSE` reaching a client that does not know the code.** Inert by
   construction (its `switch` has no case) — asserted, not driven.
6. **The relay path.** Every session is the manual invite path. `hostViaRelay` /
   `joinViaRelay` never ran; the refusal statuses go through the same `Lobby`
   plumbing, but the WebSocket half is unexercised.
7. **A stage transition, N-2's level divergence, a client pulling its own
   trigger, the 21-shot capture** — all still not run, by anyone, in five
   documents. The capture's default port is 5199 and the user is playtesting.
8. **Whether any of it sounds right.** Eight rounds old.

---

# 7. Appendix — the substitution table

All validated against `src/` on disk as matching **exactly once** before any arm
ran; the transform throws otherwise and the arm refuses to boot.
`substitutionsMissing` is `[]` in all 25 files.

| name | kind | file | anchor | replaced with |
|---|---|---|---|---|
| `N7-head` | fixture-revert | `src/ui/HUD.js` | `if (!e?.victim?.isPlayer && localSource && isLocalKill(ctx, e)) {` | **HEAD `a43cc70`'s exact line**, `if (!e?.source \|\| e.source === ctx.player \|\| e.source?.isPlayer) {` |
| `N7-r3` / `N7-hud` | revert | `src/ui/HUD.js` | the same line | `if (isLocalKill(ctx, e)) {` |
| `N4-latch` | revert | `src/net/NetHost.js` | the `c.helloSeen` latch, both lines | `;` |
| `N4-age` | revert | `src/net/NetHost.js` | the `HELLO_MAX_PAWN_AGE` block | `;` |
| `N5-cat` | revert | `src/net/NetHost.js` | the `SURVIVOR_BY_ID` block | `;` |
| `N3-host` | revert | `src/net/NetHost.js` | the `hello.version !== PROTOCOL_VERSION` block | `;` |
| `N3-client` | revert | `src/net/NetClient.js` | the `hostVersion !== PROTOCOL_VERSION` block | `;` |
| `N6-host` | revert | `src/net/NetHost.js` | the whole try/catch in `_onMessage` | `this._handleMessage(peer, data);` |
| `N6-client` | revert | `src/net/NetClient.js` | the whole try/catch in `_onMessage` | `this._handleMessage(data);` |
| `N8-input` | revert | `src/net/NetHost.js` | `if (ctx.input) ctx.input.enabled = !live;` | `… = false;` |
| `L2-hello` | revert (round 3's) | `src/net/NetClient.js` | `this._sendHello();` | `;` |
| `L1-hold` | revert (round 3's) | `src/net/NetHost.js` | `this._holdSession(ctx);` | `;` |
| `L4-prog` | revert (round 3's) | `src/systems/Progression.js` | `if (!isLocalKill(ctx, e)) return;` | `;` |
| **`FX-hostv99`** | **fixture, NOT a revert** | `src/net/NetHost.js` | `w.u16(PROTOCOL_VERSION);` (WELCOME) | `w.u16(99);` |

Raw JSON: `reviews/round7/coop/r4/` — 23 files (`sp-n7.json` holds all three
single-player arms; the other 22 are one co-op session each). Drivers deleted.
