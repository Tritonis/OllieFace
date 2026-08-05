# Round 7 — round-4 critique, co-op fixes
## Independent review of the fourth uncommitted co-op fix round on `round7/content-and-polish` @ `a43cc70`

> ## Note on timing — read this first
>
> **Every measurement in this document was taken between 22:26 and 03:57, against
> the working tree as round 4 left it.** At 04:11, after this report was
> finished, a round-5 fix began editing the same files. The tree has moved since:
> `src/net/NetHost.js` has gone from 263 to 342 changed lines,
> `src/net/Protocol.js` from 95 to 123, `src/net/Lobby.js` from 25 to 74, and
> `PROTOCOL_VERSION` is now **4**. Line numbers, code quotations and diffstats
> below describe **round 4's bundle**, not the current tree, and will not match a
> fresh `git diff`.
>
> By inspection — **not by measurement, and not re-verified by me** — that
> round-5 work appears to address §12.1 items 1, 2, 3, 5 and 8: the HELLO latch
> is now armed before parsing, `readHello` is wrapped in a try/catch that
> refuses, a `malformed` flag separates a corrupt HELLO from a version mismatch
> (P-5), `_refuse` caps the detail at `REFUSE_DETAIL_MAX` and drains
> `bufferedAmount` before closing (P-2), `Lobby.leave()` clears both latches
> (P-4), both roles now `console.warn` on an unknown message kind (P-6), and the
> protocol version has been bumped (P-7). **None of that is verified here.**
> P-1's fix in particular needs the three arms named in §12.1 item 1 run against
> it — `adv-empty`, `adv-trunc3` and `adv-strbomb` — before anyone should believe
> it, and that verification is a separate job from this one.
>
> The findings below stand as the record of **round 4** and are unchanged.

Everything below is measured on this tree, in this working directory, with all
four fix rounds present and **nothing committed, staged or reverted**. Port 5199
was never touched. `src/` was never modified: every arm is a named in-memory
substitution inside a vite `transform`, validated against `src/` **on disk** as
matching **exactly once** before the server boots, aborting the arm otherwise.

I did not reuse a single byte of round 4's JSON. Every number below is from an
arm I built and ran.

---

# 0. Headline

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 695ms`,
re-run at the end after every driver was deleted). `git status` shows the same
**eighteen** modified files it showed at the start and **nothing staged**.

**Round 4 is right on both contested prescriptions, and I can prove both.** The
round-3 critic's one-clause N-7 fix and its `c.pawn._localTick` N-4 gate are
each measurably insufficient — the first still counts enemy-on-enemy kills, the
second is a literal no-op that read `0` on every call it was ever asked. Round 4
was right to refuse them and right to say so out loud. That is the most
important thing in this document and it is settled by measurement, not argument.

**Four of the five findings are closed.** N-7, N-4, N-6 and N-8 are CONFIRMED at
both ends with the gate failed on purpose in isolation. Single-player matches
HEAD `a43cc70` in every cell, against HEAD's literal line.

**N-5 + N-3 is NOT closed.** The trust boundary it builds has a hole in it that
round 4 did not find, and the hole is *the exact defect this whole sequence of
rounds was convened to fix*. A five-byte HELLO carrying the correct protocol
version and an **empty survivor id** is accepted silently: the host simulates the
peer as its own survivor (`ranger`, 110 max health) while the peer plays `anvil`
at 170, with **zero console output and zero page errors on either machine** and
both lobbies reading "connected". That is L-2, re-created on the boundary built
to prevent it. There are three doors to it; round 4's named residual R-1 covers
only the third and loudest.

**Nothing round 4 declined to re-run had broken.** I ran all of it — L-3, L-5 as
an isolated gate, K-2, K-3, the `EventBus` isolation, K-5, K-10, F-6, F-9, F-10,
M1, plus L-1, L-2, L-4 and K-1 independently — and every one reads its fixed
value on this tree, with seven of them failed on purpose to prove the observable
is live. The `EventBus` isolation turns out to be *more* load-bearing than round
2 measured: with it reverted a throwing listener does not merely starve the
listeners after it, it **aborts `Combat.applyDamage` mid-kill**.

**Eight findings of my own**, one major.

## 0.1 Severity table

| id | severity | finding | status |
|---|---|---|---|
| **P-1** | **MAJOR** | A HELLO with an empty or absent `survivorId` is silently accepted and the peer is simulated as the **host's** survivor. L-2, re-created on N-5's own boundary. Three doors; two produce no diagnostic anywhere. | **OPEN** |
| **P-2** | MODERATE | `MSG.REFUSE` delivery races `peer.close()` and **loses**. `detail` is unbounded and attacker-controlled in both directions: a 60 000-character survivor id renders verbatim on the *host's* screen, and the refusal never reaches the joiner, who reads the generic "Disconnected from the host." | **OPEN** |
| **P-3** | MODERATE | A client's own death can leave it `alive: true` at full health behind its own death screen. `Menus.open('death')` sets `ctx.paused`, `Engine._frame` gates `fixedUpdate` on `!ctx.paused`, and `_applyAuthoritativeHealth` runs only there — so the reliable `playerDead` event racing the unreliable `ESTATE.DEAD` snapshot decides the outcome. Pre-existing; `HOLD_GRACE` does not address it. | **OPEN (pre-existing)** |
| **P-4** | MODERATE | Both of `Lobby`'s new refusal latches are permanent. `_refused` suppresses the generic `disconnected` status for the lifetime of the Lobby; `_refusedPeers` survives `leave()` while `HostTransport._nextId` restarts at 1, so a *later* session's peer 1 has its departure silently swallowed. | **OPEN** |
| **P-5** | MINOR | A truncated or corrupt HELLO is reported to the player as a **version** mismatch ("theirs 0, ours 3"). Wrong diagnosis, wrong remedy offered. | **OPEN** |
| **P-6** | MINOR | Unknown message kinds are dropped silently on both roles with no diagnostic — in the round that added a version check whose entire purpose is to make protocol drift visible. | **OPEN** |
| **P-7** | MINOR | `PROTOCOL_VERSION` stays at 3 while the message set changes. Two builds both calling themselves "3" now have different message sets and the new check cannot tell them apart. | **judgement, recorded** |
| **P-8** | MINOR | N-8's other end: during the grace with a dead peer the host has `input.enabled === true` **while a menu is on screen and the pointer is unlocked**, so menu keystrokes drive the survivor for up to 1.5 s. The right trade, but un-named. | **accepted trade, un-named** |

---

# 1. Methodology

## 1.1 Arms

**Thirty-nine arms**: 4 single-player, 2 single-page `EventBus`, **33 co-op**.
Every co-op number is two real Chromium pages on one real WebRTC wire over the
manual invite path (`createInvite` → `joinManual` → `acceptAnswer`), ports
**5821-5840**. `substitutionsMissing` is `[]` in **all thirty-nine**.

| arm | substitutions | what it answers | raw |
|---|---|---|---|
| `sp-fixed` | *(none)* | this tree, single player | `sp-fixed.json` |
| `sp-head` | `N7-head` | HEAD `a43cc70`'s literal HUD line | `sp-head.json` |
| `sp-r3` | `N7-r3` | round 3's `if (isLocalKill(ctx, e))` | `sp-r3.json` |
| **`sp-prescribed`** | **`N7-prescribed`** | **the round-3 critique's §14.2 item 2, verbatim** | `sp-prescribed.json` |
| `eb-fixed` / `eb-pre` | — / `EB-iso` | the `EventBus` isolation, failed with a listener that really throws | `eb-*.json` |
| `main-fixed` | *(none)* | L-2 + L-4 + K-1/L-5 + N-7's co-op end | `main-fixed.json` |
| `main-l2pre` / `main-l4pre` / `main-k2pre` | `L2-hello` / `L4-prog` / `K2-victim` | L-2, L-4, K-2 gates | `main-*.json` |
| `n4-fixed` / `n4-nolatch` / `n4-noage` / `n4-none` | — / `N4-latch` / `N4-age` / both | N-4, each gate failed alone and together | `n4-*.json` |
| **`n4-r3gate`** | **`N4-latch,N4-r3gate`** | **the round-3 critique's `c.pawn._localTick < N` gate, instrumented at the gate itself** | `n4-r3gate.json` |
| `n5-pre` | `N5-cat` | the catalogue check removed | `n5-pre.json` |
| `n3h-pre` | `N3-host` | a peer declaring version 65535 | `n3h-pre.json` |
| `n3c-fixed` / `n3c-pre` | `FX-hostv99` / + `N3-client` | a **host** declaring version 99 | `n3c-*.json` |
| `adv-empty`, `adv-trunc1`, `adv-trunc3`, `adv-strbomb`, `adv-proto`, `adv-space`, `adv-k300`, `adv-huge`, `adv-v65535` | *(none)* | **hostile FIRST HELLO**, nine shapes | `adv-*.json` |
| `advmsg-fixed` / `advmsg-n6hpre` / `advmsg-n6cpre` | — / `N6-host` / `N6-client` | a **fifteen-shot malformed-message battery**, both directions | `advmsg-*.json` |
| `n8-fixed` / `n8-pre` / `n8-leave` | — / `N8-input` / — | the grace window, on a death and on a disconnect | `n8-*.json` |
| `prior-fixed` | *(none)* | L-5, F-6, K-3, K-10, K-1, K-5, F-10, L-3, F-9, L-1, K-2, M1 on this tree | `prior-fixed.json` |
| `prior-eb` / `prior-l1pre` | `EB-iso,K10-vec` / `L1-hold` | K-10's and L-1's gates | `prior-*.json` |
| `f6l3-fixed` / `f6l3-pre` | — / `F6-epoch,L3-shield` | F-6's and L-3's gates | `f6l3-*.json` |

`FX-hostv99` is a **fixture, not a revert** — it makes a version-skewed host
exist so the client's half of N-3 has something to refuse. `N4-r3gate` is a
**reconstruction of the round-3 prescription**, not a revert. Everything else is
a faithful revert.

Raw JSON: `reviews/round7/coop/r4-critique/` — 39 files. Drivers deleted.

## 1.2 The gates

Every co-op arm blocks on the game actually running on **both** pages before
anything else happens, exactly as the brief requires:

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

`runningGate` on `main-fixed`: host `{paused:false, screen:null, localTick:70,
survivorId:"ranger", maxHealth:110}`, client `{paused:false, screen:null,
localTick:65, survivorId:"anvil", maxHealth:170}`. Two survivors, deliberately —
that is what makes L-2 and P-1 measurable.

Note that I gate on `_localTick > 60` on **both** pages *before* the join, when
both are still single-player and the counter is live on both. Round 4's §0.2
argues the brief's gate "is not literally attainable on a client after it
joins", which is true and which I confirm below, but that is a reason to gate
*before* the join, not to weaken the gate. A second gate after the join uses
`net.tick` on the client, for exactly the reason round 4 gives.

## 1.3 Three of my own measurements, disqualified

Stated rather than buried.

1. **My first `n8-pre` / `n8-fixed` pair is thrown away.** It sampled
   `input.enabled` from the driver process every 200 ms; under SwiftShader with
   two pages each round trip cost 1.3–4.7 s, so the 0–1650 ms window it existed
   to resolve was never sampled at all. The numbers in §6 come from a re-run
   with an **in-page** 20 ms recorder, a 520×320 viewport and `?quality=0`, and
   every row carries the host's own tick as well as wall-clock ms — a wall-clock
   window means nothing without knowing how many frames ran. Only the N-8 pair
   moved to that fixture, and both halves of the pair moved together.
2. **`prior-l1pre`'s `advanced: true` flag is disqualified.** It compares the
   last sample to the first and reads `true` because one snapshot was already in
   flight when the host died. The evidence for L-1 is the *series*
   (`235 ×8` over four seconds), not the derived boolean. I quote the series.
3. **`prior-eb` did not fail the gate it was built for** (§10.3). I say so and
   built a different arm rather than quoting it as a failed gate.

I also confirm round 4's own disqualification was correct: `net.tick` on a
client is its own prediction counter and advances whether or not the authority
is running. `f6l3-fixed` reads `net.tick 75` on a client whose
`buffer.serverTick` is the observable that froze in `prior-l1pre`. The bad
reading appears nowhere in round 4's document — I checked every table — and it
appears nowhere here.

---

# 2. N-7 — the contested prescription. **Round 4 is right.**

## 2.1 The adjudication

I built the round-3 critique's §14.2 item 2 exactly as it was written —
`!e?.victim?.isPlayer && isLocalKill(ctx, e)`, nothing else — and ran it on the
same fixture as HEAD's line and as this tree's line. Identical fixture in all
four arms: seven beetles, four killed by the player, one killed **by another
enemy**, then the player killed by an enemy with i-frames cleared.
`killFlashes` counts `pulse(reticle, 'is-kill')` upstream of the DOM by wrapping
`HUD.pulse` and calling through.

| single-player event | `sp-head` (HEAD's literal line) | `sp-fixed` (this tree) | `sp-prescribed` (**round 3's clause**) | `sp-r3` (round 3's earlier line) |
|---|---|---|---|---|
| four kills by the player | prog 4 / **HUD 4** / flash 4 | prog 4 / **HUD 4** / flash 4 | prog 4 / **HUD 4** / flash 4 | prog 4 / **HUD 4** / flash 4 |
| **an enemy kills an enemy** | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 5** / **flash 5** ← wrong | prog 5 / **HUD 5** / flash 5 |
| **the player's own death** | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 4** / flash 4 | prog 5 / **HUD 5** / flash 5 | prog 5 / **HUD 6** / flash 6 |

**The prescribed one clause is insufficient, measured.** It fixes the
player-death half and leaves the enemy-on-enemy half exactly as broken as
`sp-r3` left it: 4 → **5**, where HEAD gives 4 → **4**. Both ends of the range.

Round 4's §1.1 reasoning is correct in every particular. `isLocalKill`'s
authority branch is `!(source?.isPlayer && ctx.player && source !== ctx.player)`
— it excludes *other players* and nothing else, because it was written for the
run summary where an environmental kill should still count. HEAD's condition
excluded *non-player sources*. They are different questions and the HUD needs
both answered, plus the victim guard. Three clauses is the right number.

Fixture controls, identical on all four arms: `sourceWasEnemy true`,
`killerIsPlayer false`, `victimWasAlive true`, `victimDied true`,
`victimIsPlayer false` for the enemy-on-enemy kill; `killerIsPlayer false`,
`playerAlive false`, `playerHealth 0`, `victimIsPlayer true` for the death.
`progression` reads 4 / 5 / 5 on **all four** arms — the Progression counter is
untouched, which is the control that this change is HUD-only. 0 console errors,
0 page errors on all four.

`sp-fixed` matches `sp-head` in **every cell, including the flash count**. The
round-3 critique's charge that "single-player did not move" is answered: it has
now been re-derived against HEAD's literal line by two independent parties.

## 2.2 `localSource` is HEAD's condition

`git show a43cc70:src/ui/HUD.js`, line 168:

```js
if (!e?.source || e.source === ctx.player || e.source?.isPlayer) {
```

Against `src/ui/HUD.js:186-188` on this tree:

```js
const src = e?.source;
const localSource = !src || src === ctx.player || src.isPlayer;
```

Identical, and the `e.source?.isPlayer` → `src.isPlayer` change is safe because
`!src` short-circuits first. Round 4 recovered it correctly and did not retype it
from the critique, as it claims.

## 2.3 The narrowing round 4 named — I judge it **correct**

Round 4 names one case as deliberately narrower than HEAD: a **player victim with
a player source**. At HEAD that counted +1 (`source.isPlayer` → true); here it
counts 0.

I judge this right, and for a reason round 4 states but does not press:
`Progression.js:126` already carries `if (e.victim?.isPlayer) return;`. Before
this change, killing a teammate's pawn added +1 to the on-screen counter and +0
to the run summary — **the two numbers a player sees for the same event
disagreed.** The narrowing removes an existing divergence rather than creating
one.

It is also unreachable in single-player: the only player-victim kill available
there has an enemy source, which is what all four `sp-*` arms measure. In co-op
it is "the host killed a teammate's pawn", which is exactly what `main-fixed`
shows *not* flashing.

## 2.4 Co-op, both ends, with the controls

`main-fixed`, host `ranger` + client `anvil`, and two arms with unrelated
reverts:

| | `main-fixed` | `main-l4pre` (`L4-prog`) | `main-k2pre` (`K2-victim`) |
|---|---|---|---|
| host HUD after 4 own kills | 4, flash 4 | 4, flash 4 | 4, flash 4 |
| after the **pawn's** kill | 4, flash 4 | 4, flash 4 | 4, flash 4 |
| **after the pawn dies** | **4, flash 4** | 4, flash 4 | 4, flash 4 |
| host `progression.stats.kills` after the pawn's kill | **4** | **5** ← L-4's gate | 4 |
| host `screen` after the pawn dies | **null** | null | **`"death"`** ← K-2's gate |

The HUD's kill guard, Progression's kill guard and HUD's `playerDead` guard are
three independent things, and each arm moves only its own observable. That is
the control that N-7's edit disturbed neither L-4 nor K-2.

---

# 3. N-4 — the contested prescription. **Round 4 is right, twice.**

## 3.1 `_localTick` is not the age of a pawn — at source, and by measurement

**At source.** `Coop._spawnPawn` (`src/net/Coop.js:39-58`) builds
`new Player({ local: false })` and calls `pawn.init(ctx)`. It is **never handed
to `engine.add`**, so its `fixedUpdate` never runs. `Player._localTick` is
incremented in exactly one place — `cmd.tick = ++this._localTick`
(`Player.js:407`) — reached only from `Player.fixedUpdate` (`Player.js:366`).
`NetHost.fixedUpdate` drives a pawn with `applyCommand`, which never touches it.
So `c.pawn._localTick` reads `0` on a pawn for the whole session.

**By measurement.** Every co-op arm reads `pawn._localTick` on every snapshot.
It is `0` in **all 33**, at host ticks from 55 to 315.

**By instrumentation of the prescription itself.** `n4-r3gate` replaces round 4's
`joinTick` gate with the round-3 critique's `c.pawn._localTick < 120` and
records the value the gate actually saw on every call:

```
pawnTicksSeenByGate: [0, 0, 0, 0, 0]
```

Five calls — the legitimate first HELLO and all four replays — every one reading
`0`. `0 < 120` is always true. **The prescribed gate never fires once.** And the
exploit reproduces straight through it:

| arm | reverted | pawn after each of four replays |
|---|---|---|
| `n4-none` | `N4-latch` + `N4-age` | 54.26/170 → **90/90 → 170/170 → 90/90 → 170/170** |
| **`n4-r3gate`** | **`N4-latch` + round 3's gate** | 54.26/170 → **90/90 → 170/170 → 90/90 → 170/170** |

Byte for byte identical. The round-3 critique's prescription would have shipped
as a fix and changed nothing at all. Round 4 was right to refuse it, and right
to name it in the document rather than quietly substituting something else.

`pawnAgeTicks` at the first replay is **175** in all four N-4 arms, so round 4's
own gate is genuinely exercised rather than trivially satisfied.

## 3.2 The replacement closes it, and either gate alone is sufficient

| arm | reverted | outcome on the first replay |
|---|---|---|
| `n4-none` | `N4-latch` + `N4-age` | the exploit: four full heals, `kestrel`/`anvil` swapped mid-run |
| `n4-nolatch` | `N4-latch` | **refused** — *"it arrived too late to re-stat the pawn safely"*; pawn stays `anvil` 54.26/170 |
| `n4-noage` | `N4-age` | **refused** — *"a second identity message"*; pawn stays `anvil` 54.26/170 |
| `n4-fixed` | — | **refused** on the first, then `pawns []`, `clients 0`, client `connected false` |

Round 4's claim that **either gate alone is sufficient** — so that neither is
dead weight and neither is load-bearing alone — is confirmed independently.

`n4-none` is round 3's H4 row reproduced on this tree from a pawn at 54.26 of
170, with the client's own `ctx.player` staying `anvil` 170 throughout. One
detail round 4 does not draw out: the exploit **also full-heals the client's own
readout**, because `_applyAuthoritativeHealth` maps the host's restored fraction
straight back onto it. It is a real heal on both screens, not a bookkeeping
error, which makes it worth more to an attacker than the report implies.

Both machines say why. Host: *"Turned a player away: their join did not make
sense (a second identity message)."* Joiner: *"The host refused the join. Try
joining again."* 0 page errors and 0 console errors on both, in all four arms.

## 3.3 One property of `HELLO_MAX_PAWN_AGE` worth recording

The 120-tick budget is measured in host ticks, and `this.tick` advances only in
`fixedUpdate`, which `Engine._frame` skips while `ctx.paused` (`Engine.js:230`).
That is the *safe* direction — a host sitting in a menu cannot age a joiner out
— and it is worth recording as a property rather than a coincidence, because the
obvious "fix" of switching to wall clock would break it. `joinTick` in my arms
ranged 25–80 and the HELLO always landed well inside the window on loopback.
Under real RTT nobody has measured it; round 4 names this and is right to.

---

# 4. N-5 + N-3 — **NOT closed.** The boundary has a hole, and the hole is L-2.

## 4.1 What round 4 got right

Both halves of what round 4 built do work, and I re-derived both.

**N-5, the catalogue check.** `n5-pre` (`N5-cat` reverted, first HELLO carrying
`__proto__`): the host's pawn is **`ranger` 110/110** under a client playing
**`anvil` 170**, `clients 1`, both lobbies read "connected", **0 errors
anywhere**. `getSurvivor` falls through to `DEFAULT_SURVIVOR` exactly as
documented. On the fixed tree the same message is refused with
`{reason:"survivor", detail:"__proto__"}`.

`SURVIVOR_BY_ID` is `Object.create(null)` (`survivors.js:230`), which is what
makes `__proto__` resolve to `undefined` rather than to `Object.prototype` and
be refused. I drove `__proto__` and `' anvil '` (both refused — no trimming, no
normalisation surprise); `constructor` and `toString` follow from the same
null-prototype construction and are **asserted, not driven**.

**N-3, the version check, both directions.**

| | host half (`n3h-pre`, `N3-host` reverted) | client half (`n3c-pre`, `FX-hostv99` + `N3-client`) |
|---|---|---|
| the skewed field | peer declares **65535** | host's WELCOME declares **99** |
| reverted arm | pawn **`anvil` 170/170, accepted in full**, `clients 1`, 0 errors | client `myNetId` **1**, `connected true`, world rebuilt, session runs |
| fixed arm | refused, `pawns []`, `clients 0`, both lobbies carry the reason | client `myNetId` **0**, `connected false`, `serverTick 55`, status `refused {version, "theirs 99, ours 3"}` |

`n3c-fixed`'s host row reads *"A player left. 1 in the game."* — round 4's named
honest wart, confirmed: in that direction the host genuinely does not know why,
because the client refused **it** before sending anything the host could read.

**The sentences reach the player.** Read off the live DOM on both pages by
opening the real co-op screen and reading `[data-coop-status]` — in every case
**after** the refusal, not during, which is the `Lobby.statusDetail` claim:

| arm | the host reads | the joiner reads |
|---|---|---|
| `adv-proto` | *"Turned a player away: they picked a survivor this build does not have (__proto__)."* | *"The host does not have the survivor you picked. Choose one from their build and join again."* |
| `adv-v65535` | *"Turned a player away: they are running a different version of the game (theirs 65535, ours 3). Both of you need the same build."* | *"That host is running a different version of the game (theirs 65535, ours 3). Both of you need the same build."* |
| `n4-fixed` | *"Turned a player away: their join did not make sense (a second identity message)."* | *"The host refused the join. Try joining again."* |
| `n3c-fixed` | *"A player left. 1 in the game."* | *"That host is running a different version of the game (theirs 99, ours 3). Both of you need the same build."* |

`coopSay` writes `textContent` (`Menus.js:1259-1262`), so an attacker-controlled
`detail` cannot carry markup. **There is no XSS here.** There is P-2.

**The latch holds where it is asked to.** In every refused arm the host's status
stayed `peerRefused` and was never overwritten by `peerLeft`, and the client's
stayed `refused` and was never overwritten by `disconnected`. Within a session,
round 4's claim is confirmed. Across sessions it is not — P-4.

## 4.2 P-1 — MAJOR. Three doors back into L-2, two of them silent

`NetHost._onHello`:

```js
const hello = readHello(r, {});
if (c.helloSeen) return this._refuse(peer, REFUSE.HELLO, 'a second identity message');
c.helloSeen = true;
if (hello.version !== PROTOCOL_VERSION) { ...refuse... }
if (!c.pawn || !hello.survivorId) return;          // ← the hole
if (!SURVIVOR_BY_ID[hello.survivorId]) { ...refuse... }
```

The `!hello.survivorId` early return sits **above** the catalogue check, so an
empty string never reaches validation. And `readHello` manufactures that empty
string for free, in the name of reading defensively:

```js
out.survivorId = r.remaining >= 2 ? r.str() : '';
```

Three arms, each with the hostile message as the peer's **first** HELLO. (The
client's `_sendHello` is replaced on the client page in the same turn
`joinManual` returns; `_sendHello` runs inside `connected.then(...)`, which
cannot fire until the host accepts the answer many turns later. Not a race, and
not a source substitution.)

| arm | the message | host's pawn | client's own survivor | `clients` | host console | host page | client page | lobbies |
|---|---|---|---|---|---|---|---|---|
| **`adv-empty`** | 5 bytes: `HELLO`, version **3**, string length **0** | **`ranger` 110/110** | **`anvil` 170** | 1 | **0** | 0 | 0 | "connected" / "connected" |
| **`adv-trunc3`** | 3 bytes: `HELLO`, version **3**, **no string at all** | **`ranger` 110/110** | **`anvil` 170** | 1 | **0** | 0 | 0 | "connected" / "connected" |
| `adv-strbomb` | 5 bytes: `HELLO`, version 3, length prefix claims **60000** | **`ranger` 110/110** | **`anvil` 170** | 1 | 1 | 0 | 0 | "connected" / "connected" |

All three set `mistated: true` — the host's pawn survivor is not the survivor
the peer is playing. **The first two produce no diagnostic anywhere**: not a
console line, not a page error, not a status, on either machine.
`helloSeen` is `true` on the first two and `false` on the third (the throw
happens inside `readHello`, above the latch), so the third also leaves the
identity latch un-armed.

This is L-2 verbatim. The round-3 critique exists because a peer playing `anvil`
at 170 was simulated by the authority as `ranger` at 110, with its own health
bar reading a fraction of one maximum against the other. `n5-pre` and
`main-l2pre` reproduce that from the *old* doors; `adv-empty` and `adv-trunc3`
reproduce it from a **new** one, opened by the code written to close it.

**Round 4's named residual R-1 does not cover this.** R-1 is *"a HELLO that
throws while parsing is now dropped, and the peer stays connected on the host's
survivor"* — that is `adv-strbomb`, the one door of the three that at least
logs. The two silent doors need no throw at all: five well-formed bytes at the
correct version.

**Reachability.** Not from the stock client. `_sendHello` reads
`ctx.player.survivorId ?? ctx.survivorId ?? ''`, and `Player.init:174` always
calls `_applyCard(getSurvivor(...))` with a `DEFAULT_SURVIVOR` fallback, while
`_applyCard:299` sets `this.survivorId = card.id` — so a legitimate client's id
is always a real catalogue entry. That also means **the fix cannot break the
legitimate path.** The threat model is a modified client, which is the *same*
threat model round 4 accepted for N-4's replay and chose to refuse out loud. The
inconsistency is the finding: an identical attacker gets a loud refusal for a
duplicate HELLO and a silent mis-simulation for an empty one.

**The fix.** Move the survivor test below the catalogue check and refuse on a
parse failure:

```js
_onHello(peer, c, r) {
  let hello;
  try { hello = readHello(r, {}); }
  catch { return this._refuse(peer, REFUSE.HELLO, 'its identity message did not parse'); }
  if (c.helloSeen) return this._refuse(peer, REFUSE.HELLO, 'a second identity message');
  c.helloSeen = true;
  if (hello.version !== PROTOCOL_VERSION) return this._refuse(peer, REFUSE.VERSION, `theirs ${hello.version}, ours ${PROTOCOL_VERSION}`);
  if (!SURVIVOR_BY_ID[hello.survivorId]) return this._refuse(peer, REFUSE.SURVIVOR, hello.survivorId || '(none)');
  if (!c.pawn) return;
  if (this.tick - (c.joinTick ?? 0) > HELLO_MAX_PAWN_AGE) return this._refuse(peer, REFUSE.HELLO, 'it arrived too late to re-stat the pawn safely');
  c.survivorId = hello.survivorId;
  c.pawn.setSurvivor?.(hello.survivorId);
}
```

One rule closes all three doors: **a peer that cannot name a survivor this build
has does not get simulated.**

## 4.3 P-2 — MODERATE. The refusal loses its own race, and `detail` is unbounded

The brief asked me to check whether the close-a-turn-later flush delivers the
message rather than racing the socket close. **It races, and at 60 KB it loses.**

`NetHost._refuse` writes `MSG.REFUSE` with an untruncated, peer-supplied
`detail`, then `setTimeout(() => peer.close(), 0)`. Three arms bound it:

| arm | `detail` length | did the refusal reach the joiner? | what the joiner read | what the **host** rendered |
|---|---|---|---|---|
| `adv-proto` | 9 | **yes** — status `refused` | the survivor sentence | 82 chars |
| `adv-k300` | 300 | **yes** — status `refused` | the survivor sentence | **373 chars** |
| **`adv-huge`** | **60 000** | **NO** — status `disconnected` | ***"Disconnected from the host."*** | **60 073 chars** |

Both ends of the range, stated. On **loopback, with zero network latency**, a
large refusal is dropped by `pc.close()` before it is flushed, and the joiner
falls back to precisely the generic shrug the `_refused` latch was built to
prevent. Under real RTT the margin is worse, and a normal-sized refusal is not
obviously safe either — nobody has measured one under load.

Two problems, one fix each:

1. **Cap the detail.** `_refuse` echoes an unbounded attacker-controlled string
   back onto the wire *and* renders it verbatim in the **host's** own co-op
   panel — the host being the party that did nothing wrong. `detail.slice(0, 64)`
   in `_refuse` fixes both the amplification and the UI flood.
2. **Do not close in a bare `setTimeout(0)`.** Poll `peer.events.bufferedAmount
   === 0` with a short cap, or defer the close a fixed number of frames. A
   refusal that is not delivered is a silent drop, and round 4's own §3.4 says a
   silent drop is not acceptable.

## 4.4 The malformed-message battery — fifteen shots, both directions

`advmsg-fixed`, on the fixed tree, after a normal join. Every shot is followed
by a liveness read on both machines.

| shot | direction | host page err | client page err | diagnostic | peer survived | world stepping |
|---|---|---|---|---|---|---|
| empty message (0 bytes) | c→h | 0 | 0 | 1 host `console.error` (`Offset is outside the bounds of the DataView`) | yes | yes |
| `INPUT` truncated | c→h | 0 | 0 | 1 host `console.error` | yes | yes |
| `PING` truncated | c→h | 0 | 0 | 1 host `console.error` | yes | yes |
| unknown kind 200 | c→h | 0 | 0 | **none** (P-6) | yes | yes |
| kind 0 | c→h | 0 | 0 | **none** (P-6) | yes | yes |
| `SNAPSHOT` misdirected to the host | c→h | 0 | 0 | **none** (P-6) | yes | yes |
| `EVENT` name length 60000 | h→c | 0 | 0 | 1 client `console.error` (`Invalid typed array length: 60000`) | yes | yes |
| `EVENT` with malformed JSON | h→c | 0 | 0 | 1 client `console.error` (`SyntaxError`) | yes | yes |
| `SNAPSHOT` truncated | h→c | 0 | 0 | 1 client `console.error` | yes | yes |
| `WELCOME` truncated | h→c | 0 | 0 | 1 client `console.error` | yes | yes |
| unknown kind 201 | h→c | 0 | 0 | **none** (P-6) | yes | yes |
| `REFUSE` reason length 60000 | h→c | 0 | 0 | 1 client `console.error` | yes | yes |
| `HELLO` length prefix 60000 | c→h | 0 | 0 | 1 host `console.error` | yes | yes |
| `HELLO` 1 byte (a duplicate) | c→h | 0 | 0 | refused; both lobbies latch the reason | **dropped, correctly** | yes |
| `REFUSE` empty | h→c | — | — | **not delivered — the peer was already gone** | — | — |

**Zero uncaught page errors across fifteen shots on either machine.** The host's
tick ran 165 → 315 throughout, `paused` stayed `false`, the pawn was untouched
at `anvil` 170, and the client stayed `connected` through every non-fatal shot.
The duplicate HELLO was refused with the correct reason and the correct sentence
at both ends.

The last row is honest bookkeeping: `refuse-empty` was never delivered because
the preceding shot had already dropped the peer. **`MSG.REFUSE` with an empty
body is not tested by me.** By inspection `readRefuse` yields `{reason:'',
detail:''}` and `refusalText` falls to its generic branch, so it should read
*"The host refused the join. Try joining again."* — asserted, not driven.

**Duplicate and out-of-order `INPUT`** is handled by the pre-existing
`cmd.tick <= c.lastTick` guard (`NetHost.js:186`) and `MAX_INPUT_BACKLOG`. I did
not build a dedicated arm because nothing in this round is upstream of it. Named
as not tested.

---

# 5. N-6 — a malformed message costs one message. **CLOSED, both roles.**

Same fifteen-shot battery, three arms:

| | `advmsg-n6hpre` (`N6-host`) | `advmsg-n6cpre` (`N6-client`) | `advmsg-fixed` |
|---|---|---|---|
| **host** uncaught page errors | **4** | 0 | **0** |
| **host** `console.error`s | **0** | 4 | **4** |
| **client** uncaught page errors | 0 | **5** | **0** |
| **client** `console.error`s | 5 | **0** | **5** |

Both ends, both roles, and the totals are exact complements: the same number of
failures, moved from "uncaught" to "logged". The client's uncaught set is
`RangeError: Invalid typed array length: 60000`, `SyntaxError: Expected property
name or '}' in JSON at position 1`, and `RangeError: Offset is outside the
bounds of the DataView` — three distinct parse failures, every one of them fatal
to `ch.onmessage` without the try/catch.

**Nothing is swallowed.** Every caught failure produces exactly one
`console.error` carrying both the context and the original error object, prefixed
`[net] host dropped a malformed message from peer 1` / `[net] client dropped a
malformed message from the host`. That matches `Engine.emit`'s convention
(`[events] listener threw for event: …`) as claimed, and I verified the
convention by inspecting both. A throw still surfaces loudly; it just no longer
takes the session with it.

The one gap is **P-6**: an unknown message *kind* produces no diagnostic at all,
because neither role has a default branch. Four shots (kinds 200, 201, 0 and a
misdirected `SNAPSHOT`) were dropped in total silence. In the round that added a
protocol version check *specifically so that drift becomes visible*, silent
handling of an unrecognised kind is the wrong default. One `console.warn` in
each role's else-branch fixes it.

---

# 6. N-8 — the grace stops muting the host. **CLOSED, and I found its other end.**

In-page 20 ms sampling; `?quality=0`, 520×320; every row carries the host tick.
The host opened its pause menu **with a live peer** in all three arms.

**Before the event — the control, unchanged in both arms:**
`{paused:false, input:false, hold:true, live:true, screen:"pause"}` on every
sample, with the client's `serverTick` advancing throughout.

**After the last live peer dies:**

| | `n8-pre` (`N8-input`) | `n8-fixed` |
|---|---|---|
| host frame rate during the arm | 2.12 ticks/s | 3.64 ticks/s |
| `input.enabled` at ms 0 (same synchronous turn as the kill) | **false** | **false** |
| `input.enabled` at ms 9 / 12 (`live` has gone false) | **false** | **false** |
| first release | **ms 2048, by grace expiry** | **ms 723, by the mute's own predicate** |
| `dTick` at the release | 5 | **0** |
| `paused` during the grace | false | false |

`n8-pre` reproduces the defect: the host is muted for the entire grace and
regains input only when the world pauses under it. `n8-fixed` releases on the
**first frame** after the death — `dTick` is still `0` at ms 723, i.e. not one
fixed step had run, so the release is `_holdSession`'s own next call and nothing
else. On this machine that frame cost 723 ms; at 60 fps it is one frame. I claim
**"one frame, by construction; 723 ms measured at 1.4 fps"** and nothing tighter.
This agrees with round 4's "≤ 207 ms, measured; one frame, by construction" and
is arrived at independently, from a different sampling method, at a different
frame rate.

**The disconnect case, which round 4 did not run.** `n8-leave` closes the peer
instead of killing it:

| ms | dTick | paused | input | hold | live |
|---|---|---|---|---|---|
| 0 | 0 | false | **false** | true | true |
| 1038 | 5 | false | **true** | true | false |
| 2103 | 10 | **true** | true | false | false |

The host regains input on the first frame after the disconnect too, the grace
still runs to term, and `paused` is handed back correctly at the end. **No new
window at that end.**

**And the grace still does its own job.** `paused` stays `false` for the full
grace on both arms, and in `n8-fixed` the client's own death landed correctly:
`{alive:false, health:0, screen:"death", ended:true}` with `serverTick`
advancing to 225. Round 3's §4.3 defect stays closed **when the death snapshot
wins the race** — see P-3.

## 6.1 P-8 — the other end of the range, un-named

`if (ctx.input) ctx.input.enabled = !live;` runs **only inside the `hold`
branch**. So for the remainder of the grace after the last peer dies, the host
sits at `paused:false, input:true, hold:true, screen:"pause"` — measured, ms 723
→ 2155 in `n8-fixed` and ms 1038 → 2103 in `n8-leave`. The pause menu is on
screen, the pointer is unlocked, and `Player._sampleCommand` is live
(`Player.js:377`, `usable = !!input && input.enabled !== false`): **menu
keystrokes drive the survivor for up to 1.5 s.**

I judge this the right trade — being able to act while exposed beats being a
mute sitting duck — but it is a behaviour change at the other end of N-8's range
and round 4 names neither it nor the ≤1.5 s bound on it. If it wants closing,
the cheap answer is to gate the un-mute on pointer lock as well as on `live`.

---

# 7. P-3 — a client can die without dying. MODERATE, pre-existing

`Menus.open` sets `ctx.paused = !!name` (`Menus.js:982`). `Engine._frame` runs
`fixedUpdate` only `if (!ctx.paused)` (`Engine.js:230`). `NetClient.fixedUpdate`
is the only caller of `_applyAuthoritativeHealth`, which is the only thing on a
client that writes its own `alive` and `health`.

So when a client's death arrives, two messages race:

- the forwarded `playerDead` event, on the **reliable, ordered** events channel,
  which raises the death screen and *thereby stops the client's fixed step*;
- the `ESTATE.DEAD` snapshot, on the **unreliable** state channel, which is the
  only thing that sets `alive = false`.

If the event wins, the client is frozen behind its own death screen with
`alive: true` at full health, and can never consume the correction. Observed:

| arm | host ticks/s | client after its own death |
|---|---|---|
| `main-fixed` | 900×560, no menu | `{alive:false, health:0, screen:"death", ended:true}` ✓ |
| `n8-fixed` | 3.64 | `{alive:false, health:0, screen:"death", ended:true}` ✓ |
| `n8-pre` | 2.12 | **`{alive:true, health:170, screen:"death", ended:true}`** |
| `n8-fixed`, first (disqualified) run | ~0.8 | **`{alive:true, health:170, screen:"death", ended:true}`** |

**Confound named honestly.** Both failures are on arms running at one to two
frames per second under software rendering, far below any shipping condition,
and `N8-input` has no plausible causal path to it. **I do not claim this
reproduces at 60 fps.** What I claim is that the mechanism is real, is visible
at source in three files, and that `HOLD_GRACE` does not address it — the grace
buys the *host* time to send, and this failure is on the *client's* side of the
wire, after the bytes have arrived. It is a 1.5-second wall-clock budget
guarding a frame-driven process, and the arm that exposes it is simply a slow
frame.

Cheap mitigation: apply the authoritative death from `NetClient._handleMessage`'s
snapshot branch as well as from `fixedUpdate`, or stop `Menus.open('death')`
pausing a networked client.

---

# 8. P-4 — the refusal latches are permanent

`Lobby` gained two latches and neither is ever cleared.

**`this._refused`** (`Lobby.js:79-82`, `:140`) is set on `netRefused` and read by
`netDisconnected`. `leave()` does not clear it. So after one refusal, *every
subsequent* disconnect on that Lobby is silent — the player is dropped and the
co-op panel keeps showing the old refusal. `joinManual` also re-registers all
three listeners on each call, so a second join accumulates duplicates on the
same bus.

**`this._refusedPeers`** (`Lobby.js:45`, `:74`, `:79`) is keyed by peer id.
`NetHost`'s constructor builds a fresh `HostTransport` (`NetHost.js:40`) whose
`_nextId` starts at **1**, and `Lobby.leave()` → `startHost()` creates a new
`NetHost` — but the `Set` survives. So if a host refuses peer 1, leaves, and
hosts again, the *next* session's peer 1 has its `peerLeft` status silently
swallowed and the panel keeps showing the previous session's refusal.

Neither is reachable within a single uninterrupted session, which is why no arm
catches it and why I found it by reading rather than by measuring. I am
reporting it as source-derived, not measured. Both are one line:
`this._refused = false; this._refusedPeers.clear();` in `leave()`.

---

# 9. P-7 — the version number that no longer identifies the protocol

`PROTOCOL_VERSION` stays at **3** while `MSG.REFUSE` is added, on the argument
that a new message *code* is inert to a reader that does not know it. The
argument is sound as far as it goes, and I verified the inertness at source:
`NetClient._handleMessage`'s `switch` has no `default`, and `NetHost`'s if/else
chain simply falls through — confirmed empirically by the four silent
unknown-kind shots in §4.4.

The cost is not named. After this change, two builds both reporting version 3
have different message sets, and the check added in the same commit — the one
whose entire purpose is to make a mismatched pairing refuse instead of garble —
**cannot distinguish them**. A joiner on a v3 build that predates `MSG.REFUSE`
will be refused, will drop the message on the floor, and will read *"Disconnected
from the host."* That is P-2's failure mode arriving by a second road.

This is a judgement call and I am recording it, not overruling it. But "we will
bump the next time bytes move" leaves a window in which the version number is
known to be a lie, and the person who inherits that window is the one debugging
a refusal that does not display.

---

# 10. Prior fixes — I ran everything round 4 skipped. Nothing had broken.

`prior-fixed` measures twelve prior fixes in one co-op session on the current
tree, with seven dedicated arms failing the gates whose observables needed
proving live.

## 10.1 On this tree, fixed values

| fix | observable | reading |
|---|---|---|
| **L-5** (fail-closed victim predicate) | `isLocalVictim` on a **client** | `victimless false`, `nullVictim false`, `ownVictim true`, `strangerVictim false` — fail-closed ✓ |
| | `isLocalVictim` on a **host** | `victimless true` (the permissive default), `ownVictim true`, `pawnVictim false` ✓ |
| | `isLocalKill` on a **client** | `killOwn true`, `killStranger false`, `killEnvironment false` (the documented under-report) ✓ |
| | `isLocalKill` on a **host** | `killOwn true`, `killPawn false`, `killEnvironment true` ✓ |
| **F-6** (command epoch re-based) | `_lastCmdTick` vs `net.tick` | **85 vs 85, delta 0**; `f6l3-fixed` **75 vs 75, delta 0** ✓ |
| **K-3 / K-10** (wire form of `position`) | shape read upstream of every listener | `posType "object"`, `finiteX true`, on all 4 replicated kills ✓ |
| **EventBus isolation** | a listener registered *after* a throwing one | receives **4 of 4** ✓ |
| **K-1** (client health is the authority's) | host pawn 132.96/170 | client reads **132.96/170** ✓ |
| **L-3** (client barrier is the authority's) | client sets `shield = 42` locally | seen at 41.29, corrected to **0** ✓ |
| **K-5** (client books its own damage taken) | `progression.stats.damageTaken` | **37.04** ✓ |
| **F-10** (`playerHurt` forwarded per owner) | `items.timeSinceHurt()` | **0.08** — not the 1004.85 sentinel ✓ |
| **F-9 / L-4** (a teammate's damage is not your run's) | host `damageDealt` delta from the **pawn's** 500 | **+0**; from the host's own 500, **+500**; target alive throughout ✓ |
| **L-1** (host's death does not freeze the authority) | client `serverTick` over 4 s after the host dies | **240 → 245 → 250 → 255 → 265 → 265 → 270 → 275** ✓ |
| **K-2** (a teammate's death is not your death screen) | host `screen` after the pawn dies | **`null`**; and client `screen` after the **host** dies: **`null`**, `ended null` ✓ |
| **M1** (audio identity) | client on its **own** death | `musicOff true`, `Audio.playerDead` calls **1** ✓ |

## 10.2 Gates failed on purpose

| gate | arm | reverted reading |
|---|---|---|
| **L-1** | `prior-l1pre` (`L1-hold`) | client `serverTick` **235 ×8 over four seconds — frozen**; host `{alive:false, paused:true, screen:"death", input:true, holding:false}` against fixed `{alive:false, paused:false, screen:"death", input:false, holding:true}` |
| **L-2** | `main-l2pre` (`L2-hello`) | host's pawn **`ranger` 110/110** under a client playing `anvil` 170, `helloSeen false` |
| **L-4** | `main-l4pre` (`L4-prog`) | client books **4** kills for the host's four and **5** after the pawn's, against **0** and **1** on the fixed tree; host books **5** for a teammate's kill against **4** |
| **K-2** | `main-k2pre` (`K2-victim`) | the pawn's death raises the **host's** death screen (`screen "death"`) while the host is alive; fixed leaves it `null` |
| **K-10** | `prior-eb` (`K10-vec`) | `posType "array"`, `finiteX false` on all 4 kills — the wire shape regresses exactly as documented |
| **F-6** | `f6l3-pre` (`F6-epoch`) | `_lastCmdTick` **115** against `net.tick` **70** — **delta 45**, and `_localTick` reads 115 instead of 0; fixed is 75 vs 75, delta 0 |
| **L-3** | `f6l3-pre` (`L3-shield`) | the client's fabricated 42-point barrier **persists at 39.88** after 2.5 s while the host resolves every hit against the same pawn with `shield: 0`; fixed corrects it to **0** |
| **EventBus** | `eb-fixed` / `eb-pre` (`EB-iso`) | §10.3 |

`F6-epoch` and `L3-shield` are reverted in the same arm. They touch disjoint
observables (a command counter and a barrier), so each still isolates which
observable moved; I name the combination rather than claiming two isolated arms.

## 10.3 The `EventBus` isolation is more load-bearing than anyone had measured

`prior-eb` (`EB-iso` + `K10-vec`) did **not** fail its gate. The wire form
regressed to an array as expected (`posType "array"`, `finiteX false`), but
`Audio.death` did not throw — headless Chromium never resolves an `AudioContext`
without a user gesture, so no `AudioParam` is ever written and round 2's original
`non-finite` throw cannot occur. **My fixture cannot reproduce round 2's failure
and I am not going to pretend otherwise.** `audioThrows: 0`, and the listener
registered after `Audio` still saw all four kills — that arm proves K-10's wire
shape and nothing about the isolation.

So I failed the gate directly instead. `eb-fixed` / `eb-pre` register three
`kill` listeners in order — a counter, one that **really throws**, and a second
counter — then kill four enemies in single-player:

| | `eb-fixed` | `eb-pre` (`EB-iso`) |
|---|---|---|
| the throwing listener fired | 4 | 1 |
| the listener registered **after** it | **4** | **0** |
| `hud.stats.kills` | **4** | — |
| `console.error`s (`[events] listener threw for event: kill`) | **4** | **0** |
| uncaught | **0** | the exception escapes `EventBus.emit` → `Combat._kill` (`Combat.js:521`) → `Combat.applyDamage` (`Combat.js:509`) and **aborts the caller**; the remaining three kills never happen and the arm cannot complete |

Round 2 measured that a throwing listener starves the listeners after it. It is
worse than that: without the isolation the exception unwinds out of the event
bus into **gameplay code**, `applyDamage` never returns, and the rest of the
frame's work is lost. This fix is holding up more than the report for it claims,
and the copy-the-set / try-per-listener shape is the right one.

## 10.4 Arms I did **not** run

Naming them is not a claim that they are fine.

1. **Three or four peers.** Every arm here is host + one client, exactly as round
   4's were. `hasLivePeer()` with one dead pawn and one live one, and `_refuse`
   dropping one peer while another is still playing, remain unmeasured by anyone
   in this round or the last. **This is the first gap I would close.**
2. **The relay path.** `hostViaRelay` / `joinViaRelay` never ran. The refusal
   statuses go through the same `Lobby` plumbing but the WebSocket half is
   unexercised.
3. **Real network conditions.** Loopback WebRTC on one machine. Every timing
   number here — `HELLO_MAX_PAWN_AGE`'s 2 s, `HOLD_GRACE`'s 1.5 s, the refusal
   flush in P-2 — is a zero-lag number.
4. **`MSG.REFUSE` with an empty body**, and **a `REFUSE` reaching a build that
   does not know the code.** Both reasoned from source, neither driven.
5. **`constructor` / `toString` as survivor ids.** `__proto__` and `' anvil '`
   were driven; the other two follow from `Object.create(null)` and are asserted.
6. **Duplicate and out-of-order `INPUT`.** Guarded by pre-existing code that
   nothing in this round is upstream of. Not re-run.
7. **F-7** (the jump-impulse gate) and **F-11**. Round 3's critique ran F-7 in
   co-op at both ends; nothing in round 4 is upstream of `data/items.js`'s
   `e.local === false` gate. Not re-run.
8. **A legitimate slow first HELLO** past the age gate. Round 4 names this gap
   and I did not close it either.
9. **N-1, N-2, N-9, N-10, N-11, K-4, K-6.** Out of scope for step 1 and
   untouched. **N-1 is unchanged: no enemy in this build ever targets a pawn.**
10. **A stage transition, a client pulling its own trigger, the 21-shot capture.**
    Still not run, by anyone, in six documents.
11. **Whether any of it sounds right.** Nine rounds old now.

---

# 11. Claim ledger

| # | round 4's claim | verdict | evidence |
|---|---|---|---|
| 1 | build exits 0 | **CONFIRMED** | `✓ built in 695ms`, exit 0, eighteen modified files, nothing staged |
| 2 | **the round-3 critique's one-clause N-7 prescription is insufficient** | **CONFIRMED** | `sp-prescribed` reads 4 → **5** → 5 where `sp-head` reads 4 → 4 → 4 |
| 3 | `localSource` is HEAD `a43cc70`'s exact condition | **CONFIRMED** | `git show a43cc70:src/ui/HUD.js:168`, term for term |
| 4 | `sp-fixed` matches `sp-head` in every cell | **CONFIRMED** | 4/4/4 HUD, 4/4/4 flashes, prog 4/5/5 on both |
| 5 | `sp-r3` reproduces 4 → 5 → 6 | **CONFIRMED** | exactly, with 6 flashes |
| 6 | the player-victim / player-source narrowing is correct | **CONFIRMED, and I endorse it** | it makes the HUD agree with `Progression.js:126`, which it previously contradicted |
| 7 | N-7's co-op end: a teammate's death no longer flashes a kill confirm | **CONFIRMED** | host HUD 4 / flash 4 across the pawn's death in three independent arms |
| 8 | **`c.pawn._localTick` is a no-op gate** | **CONFIRMED at source and by measurement** | pawn is never `engine.add`ed; `_localTick` 0 in all 33 co-op arms; `n4-r3gate` records `[0,0,0,0,0]` at the gate itself and reproduces the exploit through it |
| 9 | the `joinTick` gate closes the HELLO replay | **CONFIRMED** | `n4-none` 54.26/170 → 90/90 → 170/170 → 90/90 → 170/170; `n4-fixed` refuses the first |
| 10 | either N-4 gate alone is sufficient | **CONFIRMED** | `n4-nolatch` refuses on age; `n4-noage` refuses on the latch |
| 11 | a replayed HELLO now drops the peer, out loud | **CONFIRMED** | both lobbies latch the reason, both render a sentence |
| 12 | N-5: an unknown survivor id is refused | **CONFIRMED** | `n5-pre` mis-states the pawn to `ranger` 110; fixed refuses `__proto__` and `' anvil '` |
| 13 | N-3 host half: version skew is refused | **CONFIRMED** | `n3h-pre` accepts version 65535 in full; fixed refuses |
| 14 | N-3 client half: the client reads the version first and returns | **CONFIRMED** | `n3c-pre` `myNetId 1, connected true`; `n3c-fixed` `myNetId 0, connected false` |
| 15 | the refusal is visible to a player on both machines, and re-renders if the panel is opened afterwards | **CONFIRMED** | eight sentences read off the live DOM, every one after the fact |
| 16 | the latches cannot be overwritten by the generic disconnect | **CONFIRMED within a session; REFUTED across sessions** | never overwritten in any arm; but see **P-4** — neither latch is ever cleared |
| 17 | the deferred close flushes the message | **REFUTED** | **P-2**: delivered at 300 bytes, **lost at 60 000**, on loopback |
| 18 | **"nothing may silently fall through to the default survivor"** | **REFUTED** | **P-1**: `adv-empty` and `adv-trunc3` do exactly that, with zero diagnostics on either machine |
| 19 | R-1 is the only parse-related residual | **REFUTED** | R-1 is one of **three** doors; the other two need no throw at all |
| 20 | N-6, host half: 0 page errors, one console error per malformed message | **CONFIRMED** | `n6hpre` 4 page / 0 console; fixed 0 page / 4 console |
| 21 | N-6, client half: same | **CONFIRMED** | `n6cpre` 5 page / 0 console; fixed 0 page / 5 console |
| 22 | nothing is swallowed silently | **CONFIRMED for malformed messages; REFUTED for unknown kinds** | **P-6**: four shots dropped in total silence |
| 23 | N-8: the exposed-host window is gone | **CONFIRMED** | `n8-pre` muted through 2048 ms; `n8-fixed` released on the first frame |
| 24 | "one frame, by construction" | **CONFIRMED as a bound** | release at `dTick 0`, 723 ms at 1.4 fps, by a different sampling method than round 4's |
| 25 | no new window opens at either end | **REFUTED, mildly** | **P-8**: the host drives its survivor from an open menu for the rest of the grace |
| 26 | the host regains input when the peer **disconnects** | **CONFIRMED** (round 4 did not test this) | `n8-leave`, released at 1038 ms, grace intact, `paused` handed back |
| 27 | the grace still delivers the peer's own death | **CONFIRMED conditionally** | correct in `main-fixed` and `n8-fixed`; **P-3** is the race that decides it |
| 28 | L-4, L-2, L-1, K-1/L-5 re-verified | **CONFIRMED** | all four re-derived independently, each gate failed on purpose |
| 29 | the `net.tick` self-disqualification was correct | **CONFIRMED** | `net.tick` advances on a client regardless; the bad reading appears in neither document |
| 30 | L-3, L-5-isolated, K-2, K-3, EventBus, K-5, K-10, F-6, F-9, F-10, M1 need no re-run | **CONFIRMED as an outcome; the decision was still worth overturning** | I ran all eleven; every one holds — and the `EventBus` isolation does **more** than its own report claims (§10.3) |
| 31 | `PROTOCOL_VERSION` need not be bumped | **CONFIRMED as inert; recorded as a cost** | **P-7** |
| 32 | 25 arms, `substitutionsMissing` `[]` in all | **not verifiable, and not re-used** | round 4's drivers are deleted; I built 39 arms of my own and quote none of its JSON |

---

# 12. Does this change the hold?

**No. The hold stands: hide the Co-op menu entry, ship the rest of the branch.**

Nothing in this bundle touches N-1, and round 4 correctly declines to claim
otherwise. A co-op session is still one player being attacked and one player
standing in the same arena being ignored by every enemy in it. That was the
reason for the hold, it is untouched, and it was never a thing four small fixes
were going to move.

This bundle does make the hold **cheaper to lift later**. N-4 and N-3 close two
real ways for a peer to corrupt a session, N-6 stops one bad message ending one,
N-8 stops the host being a mute target for a second and a half, and N-7 fixes a
counter that was wrong in single-player. All of that is real work, all of it is
correct, and all of it should stay in the tree. Round 4 also did something harder
than fixing five things: it read two prescriptions from its reviewer, found both
of them wrong, said so in the document, and shipped the right fix instead. Both
of those calls are vindicated by measurement here.

But **N-5 + N-3 should not be described as closed** while P-1 is open. The one
claim this bundle makes that the branch most needs to be true — *nothing
silently falls through to the default survivor* — is false, and it is false on
the boundary built to make it true, from a five-byte message. That is not a
reason to revert anything. It is a reason for one more small round.

**Is the single-player half of the branch clean enough to ship on its own?**
**Yes**, and this is the strongest positive finding in the document. `sp-fixed`
matches HEAD `a43cc70` in every cell — kills, HUD, reticle flashes — against
HEAD's literal line, on four arms with an identical fixture and a Progression
control confirming the change is HUD-only. The single-player regression the
round-3 critique found is closed. The only path by which round 4's other four
edits could reach single-player is `EventBus.emit`, which I failed on purpose in
`eb-pre` and which is strictly better than what it replaced. Nothing in
`src/net/` runs while `ctx.lobby.mode === 'single'`, and every one of P-1 through
P-8 lives behind a WebRTC connection that a single-player session never opens.

## 12.1 If there is a round 5, this is the work list, in priority order

1. **P-1 — close the empty-survivor door.** In `NetHost._onHello`: move the
   `!hello.survivorId` test below the catalogue check and refuse an empty id;
   wrap `readHello` in its own try/catch and refuse on a parse failure. This also
   closes round 4's named R-1. `Player.init` guarantees a legitimate client
   always sends a real catalogue id, so this cannot break the normal path.
   **Gate it with `adv-empty`, `adv-trunc3` and `adv-strbomb`: all three must end
   with the peer refused, `pawns []`, and a sentence on both machines.** Nothing
   else on this list matters as much.
2. **P-2 — bound and deliver the refusal.** `detail.slice(0, 64)` in
   `NetHost._refuse`, and replace `setTimeout(() => peer.close(), 0)` with a
   flush-then-close (poll `peer.events.bufferedAmount === 0` under a short cap).
   **Gate it with `adv-huge`: the joiner must read the survivor sentence, not
   "Disconnected from the host."**
3. **P-4 — clear the latches.** `this._refused = false;
   this._refusedPeers.clear();` in `Lobby.leave()`, and stop `joinManual`
   re-registering listeners it already holds. **Gate it with a
   join → refuse → leave → join → disconnect sequence: the second disconnect must
   say "Disconnected from the host."**
4. **The three-peer arm.** `hasLivePeer()` with one dead pawn and one live one,
   and `_refuse` dropping one peer while another plays. This is the biggest
   untested surface in the round, and N-8 and N-4 both lean on it.
5. **P-6 — one `console.warn` per role for an unrecognised message kind.** Four
   lines, and it is what makes the next protocol drift visible at all.
6. **P-3 — apply the authoritative death outside `fixedUpdate`**, or stop
   `Menus.open('death')` pausing a networked client. Pre-existing; worth fixing
   before co-op ships, not before the branch does.
7. **P-8 — gate the input un-mute on pointer lock as well as on `live`**, if
   "menu keystrokes drive the survivor for 1.5 s" is judged to matter.
8. **P-5 / P-7 — diagnosis and bookkeeping.** Distinguish "malformed" from
   "version mismatch" in the refusal reason, and decide whether
   `PROTOCOL_VERSION` should go to 4 now rather than "next time bytes move".

**None of items 1–8 is a reason to hold the branch.** Items 1–3 are a reason to
keep holding the **Co-op menu entry**, which is already held.
