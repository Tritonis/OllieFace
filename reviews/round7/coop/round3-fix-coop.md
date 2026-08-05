# Round 7 — round-3 co-op fixes (final fix round)

Branch `round7/content-and-polish`, HEAD `a43cc70`. Rounds 1 and 2 are still in
the working tree, untouched; my edits sit on top of both. Nothing committed,
staged or reverted. Subject: `round2-critique-coop.md`'s L-1 … L-9, the three
standing deferrals (K-4, K-6, F-11), and the two unnamed `EventBus.emit`
semantics.

**Closed:** L-1, L-2, L-3, L-4, L-5, L-8 (as a record correction), L-9 (record),
the six record items in L-6, both `EventBus` semantics (documented at the call
site), plus **one defect of my own fix that the first pass of measurement found
and the second closed** (§4.3).
**Deferred, with costs stated:** K-4, K-6, F-11, and three new findings this
round's measurement uncovered (§10).
**Named as never defined:** L-7 (§9.3).

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 677ms`,
re-run at the end after the driver was deleted, with all three fix rounds in the
working tree and nothing staged, committed or reverted).

---

# 1. Methodology, and the gates that make the rest admissible

## 1.1 Two real pages, one real wire

Every co-op number below is taken from two Chromium pages in one browser, host
and client over the manual WebRTC invite path (`Lobby.createInvite` /
`joinManual` / `acceptAnswer`). Session reality, recorded as `roles` in every
JSON and identical across all nineteen co-op sessions:

```
host   { role: "host",   authority: true,  clients: 1 }
client { role: "client", authority: false, myNetId: 1, connected: true }
```

Ports **5761–5780 only**. Port 5199 was never touched, and no running node or
vite process was killed or restarted.

**The two pages are deliberately on different survivors** — host `ranger`,
client `anvil` — in *every* arm, not just the one about survivors. That is the
fixture change that makes L-2 measurable at all, and it is why several rows
below read differently from round 2's.

## 1.2 The running-game gate — blocking, and taken twice

Each page launches through `ctx.hud.menus.launch()` and then **waits** on

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

before anything is installed. An arm that fails it throws and writes no
measurements. `runningGate` in every JSON:

| | host | client |
|---|---|---|
| `paused` | `false` | `false` |
| `menus.screen` | `null` | `null` |
| `player._localTick` | 61–62 | 61–62 |
| `player.survivorId` | `"ranger"` | `"anvil"` |

**A second gate, which round 2 and its critique did not have.** Opening the
second page blurs the first, `Menus` opens the pause screen on losing pointer
lock (`Menus.js:128-133`), and my first `fixed` session recorded the host
sitting at `screen "pause", paused true` through part of the run. Every arm now
clears both screens after the second page exists and **re-asserts the gate**;
`runningGateAfterFocus` reads `{paused: false, screen: null}` on both pages in
all nineteen sessions. Without it the whole L-1 measurement would have been
taken through a host that was already paused for an unrelated reason.

## 1.3 The instruments

- **The bus probe.** `ctx.events.emit` itself is wrapped, so a `kill` payload is
  recorded **upstream of every listener**, before any dispatch can abort. It is
  proved by failing: on `preEBfull` it reads `array` / non-finite four times on
  a page whose downstream listener never ran (§7.3).
- **The downstream-kill counter.** A `kill` listener registered **last**, so it
  only increments if the dispatch reached the end. `4` on every fixed arm, `0`
  on `preEBfull`.
- **The `Audio.death` throw counter**, re-throwing so nothing is masked.
- **Paired end-to-end sampling.** Every health/shield row is one host read and
  one client read taken back to back on the same wall clock, eight times over
  two seconds.
- **The jump probe** (single-player arms), three sprint jumps through the real
  key handler, retried while `grounded` is false. It reaches **all three**
  presses on both trees, so Tectonic Heart's every-third `36` is read.

Both pages carry identical inventories granted **before** the join, while each
is still its own authority: `wax-quail` ×3, `rubber-soles`, `tectonic-heart`,
`sunken-vertebra` (`inventory` in every JSON).

## 1.4 Arms

Nineteen sessions. Sabotage is by named in-memory source substitution inside a
vite `transform`; a substitution whose anchor does not match **exactly once**
throws and the arm refuses to boot. **`src/` was never modified to build a test
arm.** Every anchor is a single line of text with no newline in it, so mixed
CRLF/LF cannot make one silently miss, and all eighteen were validated as
matching exactly once against `src/` before any arm ran (script output in §11).
`substitutionsMissing` is `[]` in all nineteen runs.

| arm | substitutions | what it reverts | raw |
|---|---|---|---|
| `fixed` | *(none)* | — | `main-fixed.json` |
| `preL2` | `L2-hello` | the survivor id crossing the wire | `main-preL2.json` |
| `preL1` | `L1-hold` | the session hold | `main-preL1.json` |
| `preL3` | `L3-shield` | the client's shield correction | `main-preL3.json` |
| `preL4` | `L4-prog`, `L4-hud` | both kill-credit guards | `main-preL4.json` |
| `preVictim` | `R1-victim` | round 1's `victim` field **only** | `main-preVictim.json` |
| `preL5` | `R1-victim`, `L5-open` | + the fail-closed predicate | `main-preL5.json` |
| `pausehold` | *(none)* | supplementary: the pause menu on a live host | `main-pausehold.json` |
| `pausehold-preL1` | `L1-hold` | same, with the hold reverted | `main-pausehold-preL1.json` |
| `preK1` | `K1-all` | round 2's K-1 | `main-preK1.json` |
| `preK2` | `K2-pred` | round 2's K-2 predicate | `main-preK2.json` |
| `preK3` | `K3-wire` | K-3's wire half **only** | `main-preK3.json` |
| `preK3full` | `K3-wire`, `K3-guard` | K-3, both halves | `main-preK3full.json` |
| `preEB` | `K3-wire`, `EB-isolate` | wire half + isolation | `main-preEB.json` |
| `preEBfull` | `K3-wire`, `K3-guard`, `EB-isolate` | both halves + isolation | `main-preEBfull.json` |
| `preK5` | `K5-prog` | K-5's accounting handler | `main-preK5.json` |
| `preF6full` | `R1-F6`, `R1-F6-window` | round 1's F-6, both halves | `main-preF6full.json` |
| `preF9` | `R1-F9` | round 1's damage-credit guard | `main-preF9.json` |
| `preF10` | `R1-F10` | round 1's per-owner hurt forward | `main-preF10.json` |
| `sp-fixed` / `sp-pre` | — / all six of round 3's | single player, both trees | `sp-sp-fixed.json`, `sp-sp-pre.json` |

**Each `pre*` arm reverts exactly one finding**, except the three deliberate
pairs used to isolate a half: `preK3`/`preK3full` differ by `K3-guard` alone,
`preK3full`/`preEBfull` differ by `EB-isolate` alone, and `preVictim`/`preL5`
differ by `L5-open` alone.

## 1.5 Evidence I disqualified rather than shipped

- **My first `fixed` session ran with the host on a `pause` screen** for part of
  the session, because the second page's focus stole pointer lock (§1.2). Every
  L-1 number taken there is contaminated — the world was already stopped for a
  reason that had nothing to do with a death. The arm was rebuilt with the
  second gate and only the rebuild is quoted. That session's file was
  overwritten; this paragraph is its only record.
- **My first pass had one live enemy on the stage.** `forcedKills` read
  `{available: 1, killed: 1}` and the pawn-source kill leg read *nothing*,
  because there was no second enemy to kill. **"4 of 4" and "0 of 0" read
  identically** — the exact fixture failure round 2's critique disqualified its
  own first session for. Every quoted arm now spawns a real six-unit pack first
  and records `spawned {card, live}` beside `forcedKills {available, killed}`;
  all nineteen read `{available: 7, killed: 4}`.
- **`preEB` is not a failed gate, and I say so rather than quoting it as one.**
  It reverts K-3's wire half only, and K-3's *other* half — the
  `Number.isFinite` early return in `Audio._out` — covers the same hole by
  itself: `preEB` reads `deathThrows 0 of 4` and `downstreamKill 4 of 4`. The
  isolation change therefore had nothing to isolate on that arm. `preEBfull`
  reverts both halves and fails properly. See §7.3; this is a **finer**
  attribution than round 2's, exactly as round 2's critique's `preF6`/`preF6full`
  split was of round 1's.
- **`F9.highestHit` is contaminated in every co-op arm and I do not use it.** My
  fixture raises the target to `1e7` health, and earlier legs deal `1e7` damage,
  so `highestHit` reads `10000000` before, during and after on every arm. The
  load-bearing pair is `peerDelta` / `localDelta`, which is clean.
- **`hostMoveX` is not evidence of input muting** and is not read as such. No key
  was held during the pause arm, so `0` is what it would read either way. The
  direct read is `input.enabled`.
- **`maxHealth`, `health`, `damageTaken`, `timeSinceHurt`, `musicGain` and
  `intensity` are session-dependent** and appear only as agreements or
  comparisons *within* one session, never as build figures. In particular the
  client's own `maxHealth` climbs from 170 to 221 across a session as the run
  levels, which is why §3's agreement table is taken in the first two seconds
  after the hit rather than at the end.
- **One `pageerror` on the host page in the single-player arms**
  (`The root document of this element is not valid for pointer lock`) is present
  on both trees and is excluded from the counts I read as signal. The co-op arms
  record **0 page errors on both pages** in all nineteen sessions.

---

# 2. L-2, MAJOR — a client's survivor now crosses the wire. CLOSED

## 2.1 The change

| # | file:line | what |
|---|---|---|
| 1 | `src/net/Protocol.js:42` | `PROTOCOL_VERSION` 2 → **3**, with the reason and the compatibility statement |
| 2 | `src/net/Protocol.js:230-241` | `writeHello` / `readHello` — `MSG.HELLO` gains a body: version + survivor id |
| 3 | `src/net/NetClient.js:80` | send it the moment both channels open, before anything else |
| 4 | `src/net/NetClient.js:95-100` | `_sendHello()` — `ctx.player.survivorId`, not `ctx.survivorId` |
| 5 | `src/net/NetHost.js:150-165` | `MSG.HELLO` handler: `c.pawn.setSurvivor(id)` |
| 6 | `src/net/NetClient.js:210-216` | the false premise in `_reconcile`'s comment, replaced by the measured one |

`setSurvivor` is the existing runtime swap (`Player.js:331`). On a pawn that is
one tick old its destructive half — clear placeables, clear projectiles, refill
health, rebuild the rig — is all no-ops, and `local` is `false` so it touches
neither `ctx.survivorId` nor `ctx.setSurvivor`. An unknown id resolves to the
default survivor (`getSurvivor`, `survivors.js:240-242`), so a malformed HELLO
cannot throw out of the pawn.

**Why the pawn is re-stated rather than built right:** the host spawns the pawn
in `_onPeer`, which fires on channel open — strictly before the first byte can
arrive. Deferring the spawn until HELLO would also defer WELCOME (it carries the
pawn's netId) and would need a timeout path for a client that never sends one.
Re-stating a one-tick-old pawn is the smaller change with the smaller failure
mode.

## 2.2 Both ends of the range

Host on `ranger`, client on `anvil`, both gated into a running game
(`main-fixed.json` / `main-preL2.json`):

| | `preL2` (the fix reverted) | `fixed` |
|---|---|---|
| the host's pawn: `survivorId` | **`"ranger"`** — the host's | **`"anvil"`** — the client's |
| base `maxHealth` | **110** | **170** |
| `moveSpeed` | **7.0** | **6.5** |
| `damage` | **12** | **15** |
| the client's own survivor | `"anvil"`, 170, 6.5, 15 | `"anvil"`, 170, 6.5, 15 |

And the consequence the critique named — K-1 reporting a number that is not the
host's. Host deals 40 to the pawn, then both ends are sampled together eight
times over two seconds (`healthSeries`):

| sample | `preL2` host pawn | `preL2` **client's own** | gap | `fixed` host pawn | `fixed` **client's own** | gap |
|---|---|---|---|---|---|---|
| 1 | 76.67 | **118.49** | **41.82** | 138.75 | 138.75 | **0.00** |
| 4 | 76.67 | **118.49** | **41.82** | 138.75 | 138.75 | **0.00** |
| 6 | 77.07 | **119.10** | **42.03** | 139.43 | 139.43 | **0.00** |
| 8 | 77.58 | **119.88** | **42.33** | 140.37 | 140.37 | **0.00** |

Both ends. On `preL2` the gap **widens** — 41.82 → 42.33 — because the two ends
regenerate against different maxima; it never converges. On `fixed` the worst
disagreement over eight samples is **0.06**, and four of the eight are exact.

The `preL2` gap is larger than the critique's 38.68 because the host's hit lands
for a different amount against a `ranger` pawn's armour (`dealt 33.33` against
`31.25`); the shape and the direction are the same, and both are read off both
ends of one live session.

**`hostDamagesPawn` is the fixture check** that stops a zero reading like a pass:
`{dealt: 31.25, healthBefore: 170, healthAfter: 138.75, maxHealth: 170}` on
`fixed`, `{dealt: 33.33, healthBefore: 110, healthAfter: 76.67, maxHealth: 110}`
on `preL2`. The `maxHealth` column is itself the finding.

## 2.3 What L-2 does *not* close

The client's prediction now runs on the same stat block as the authority, which
was the second half of the critique's §10.1. I did **not** count reconciliation
replays with matched survivors against mismatched ones — the correction-rate arm
the critique named is still not run (§12.4).

---

# 3. L-3, MODERATE — the client's barrier is now the host's barrier. CLOSED

| # | file:line | what |
|---|---|---|
| 7 | `src/net/Protocol.js:99` | `ENTITY_SIZE` gains the shield field |
| 8 | `src/net/Protocol.js:183-188` | `writeEntity` — barrier as a fraction of **maxHealth**, not of `maxShield` |
| 9 | `src/net/Protocol.js:215` | `readEntity` — `shieldFrac` |
| 10 | `src/net/Snapshot.js:98` | carried through interpolation |
| 11 | `src/net/NetClient.js:307-324` | applied to the local player, beside the health it already applied |

One denominator for both bars on purpose: `maxShield` is derived
(`maxHealth * 0.5`), and a receiver scaling by its own copy of a derived number
doubles the divergence when the two maxima disagree.

| on the **client**, same 40-damage hit, eight samples | `preL3` | `fixed` |
|---|---|---|
| client's own `shield`, sample 1 | **28.44** | **0.00** |
| sample 4 | **21.64** | **0.00** |
| sample 8 | **12.58** | **0.00** |
| the host's copy of the same pawn, `shield`, every sample | **0.00** | **0.00** |
| health agreement over the same window | 0.00 – 0.03 | 0.00 – 0.06 |

Both ends. `preL3` reproduces the critique's 28.02 → 12.43 almost exactly
(28.44 → 12.58) and the host's copy holds `0.00` throughout in both columns.

**What this buys and what it does not.** It replaces an invisible lie with a
visible zero. The HUD extends the health track by the shield
(`HUD.js:508-525`), so on `preL3` the player is asked to spend risk against 28
points of barrier that absorb nothing; on `fixed` the bar tells the truth. It
does **not** make a client's `onDamaged` barrier real — the host does not run a
pawn's item hooks (`data/items.js`'s `e.local === false` gate, round 1's F-7), so
Sunken Vertebra and the six cards like it are now *visibly* inert for a client
rather than invisibly so. That is the same gap K-4 defers and it is stated at the
call site (`NetClient.js:307-319`) rather than left for the next reader to find.

**A dependency worth naming:** the shield correction lives inside
`_applyAuthoritativeHealth`, so reverting K-1 whole reverts L-3 with it —
`preK1` reads `clShieldAfterHit 12.58`, the `preL3` value, not the `fixed` `0`.

---

# 4. L-1, MAJOR — the host's death no longer freezes the authority. CLOSED

## 4.1 The design decision, and why this one

> **A death ends exactly one run: the dead player's. An authority does not stop
> while somebody else is still playing.**

That is the same sentence K-2 is built on, applied to the one player K-2 could
not reach. The host that dies gets its own death screen, its own committed
record and its own end; the world it is hosting keeps running for the people
still in it, and the host watches. It is the pause menu's rule too: **on a host
with a live peer, a menu is an overlay, not a pause.**

The alternative the critique offered — the host's death ends the session
explicitly for everyone — was rejected because it is K-2 with extra steps. K-2's
whole content is that a teammate's death must not end your run, and "the
teammate happened to be the host" is not a distinction the player experiences.

Implemented in `NetHost` rather than in `Menus` because the rule is a fact about
the *network role*, not about the menu, and because re-evaluating it every frame
means the release case needs no state: when the last live peer is gone, the
host's already-open death screen pauses the world on its own.

| # | file:line | what |
|---|---|---|
| 12 | `src/net/NetHost.js:27` | `HOLD_GRACE = 1.5` |
| 13 | `src/net/NetHost.js:40-42` | `_holding` |
| 14 | `src/net/NetHost.js:194-197` | `hasLivePeer()` |
| 15 | `src/net/NetHost.js:200-256` | `_holdSession(ctx)` and the decision written out in full |
| 16 | `src/net/NetHost.js:259` | called first in `update`, so it runs while paused |
| 17 | `src/net/NetHost.js:265` | do not broadcast from a paused world — every such snapshot is discarded at the far end |

## 4.2 Both ends of the range

The host dies while the client is alive. Client's snapshot clock, four samples
500 ms apart before and eight over four seconds after (`tickBefore` /
`tickAfter`):

| | `preL1` | `fixed` |
|---|---|---|
| four samples **before** the host's death | 650 → 680 → 711 → 739 | 651 → 681 → 714 → 740 |
| eight samples **after**, over four seconds | **769, 769, 769, 769, 769, 769, 769, 769** | **799 → 829 → 855 → 888 → 918 → 944 → 974 → 1004** |
| host `ctx.paused` across those eight | **`true` ×8** | **`false` ×8** |
| client `connected` | `true` | `true` |
| host `input.enabled` under its own death screen | `true` | **`false`** |

`preL1` reproduces the critique's frozen clock exactly — the feed does not
degrade, it stops. On `fixed` the client's clock gains **205 ticks in four
seconds** with the host dead, which is the 51 Hz the snapshot pipeline was
running at before the death.

And the consequence the critique cared about most — **K-1 works again with the
host dead.** With the host down and the client alive, the pawn is killed
authoritatively:

| on the **client** | `preL1` | `fixed` |
|---|---|---|
| `player.alive` | **`true`** | **`false`** |
| `player.health` | **221** | **0** |
| `menus.screen` | `"death"` | `"death"` |
| `progression._ended` | `true` | `true` |

`preL1` is the critique's "died but not dead" split, reproduced. On `fixed` the
client dies properly with the host already gone.

**The release, on the same run:** once the last live peer is dead, the host's
own death screen takes the world back — `hostReleased` reads
`{paused: true, screen: "death", inputEnabled: true}` on **every** arm, fixed and
sabotaged alike. The hold is not a one-way door.

## 4.3 A defect in my own fix, found by measuring and closed by measuring again

The first implementation held the session on `hasLivePeer()` alone. It measured
as a pass on the tick clock and a **failure** on the thing the clock exists for:
in three of five arms the client ended on its death screen still reading
`alive: true, health: 221`.

`SnapshotBuffer.ingest` (`Snapshot.js:40`) discards any snapshot whose tick is
not newer than the last, and `this.tick` advances only in `fixedUpdate`. So the
instant the world pauses, every further send is thrown away at the far end — and
a peer that has just died still needs one more snapshot, the one carrying
`ESTATE.DEAD`, because that is the only thing that puts its own player into its
own death state. Pausing in the same frame as the kill produced the same
"died but not dead" split as the frozen authority, at one-second scale instead of
for ever.

`HOLD_GRACE` (three snapshot intervals plus a frame) closes it. After the change
`pawnDeath|hostDead → client.alive` reads **`false` in every fixed-tree arm**
(`fixed`, `preL2`, `preL3`, `preL4`, `preVictim`, `preL5`) and `true` only where
`L1-hold` is reverted. **The pre-grace numbers are not quoted anywhere in this
report except here**; the arms were re-run and only the re-runs are used.

I am recording this rather than quietly fixing it because it is the exact class
of error this project keeps writing lessons about: a gate that passed on the
instrument I was watching and failed on the one I nearly did not add.

## 4.4 The pause menu, the other half of the same predicate

Round 2's critique measured only the death case. The pause screen runs through
the same code and is measured here (`main-pausehold.json` /
`main-pausehold-preL1.json`), with the host opening its pause menu while the
client is alive and closing it again:

| | `pausehold-preL1` | `pausehold` |
|---|---|---|
| client `serverTick`, three samples before | 184 → 202 → 223 | 183 → 201 → 222 |
| five samples **while the host's pause menu is open** | **241, 241, 241, 241, 241** | **263 → 290 → 314 → 338 → 362** |
| host `ctx.paused` across those five | **`true` ×5** | **`false` ×5** |
| host `input.enabled` across those five | **`true` ×5** | **`false` ×5** |
| three samples **after the menu closes** | 277 → 295 → 316 | 425 → 443 → 464 |
| host `input.enabled` after | `true` | **`true`** |

Both ends, and both directions of the release. Muting local input while the
overlay is up is what stops the host's survivor walking around the arena while
its owner reads the pause menu — and it is a behaviour change a player will
notice, so it is stated here and at `NetHost.js:222-226`.

## 4.5 What L-1 does *not* fix, and it matters

**Enemies chase `ctx.player` and nothing else** (`Enemy.js:36`, `:449`, `:499`).
With the host down, they gather on its body and ignore the survivor. "The run
continues" therefore currently means "the run continues, and it is easier".
That is a pre-existing hole — no enemy has ever targeted a pawn in this build,
in any round — and it is filed as new finding **N-1** in §10.1. It is not
introduced by L-1; L-1 is what makes it visible.

---

# 5. L-4, MODERATE — a run summary credits only its own kills. CLOSED

| # | file:line | what |
|---|---|---|
| 18 | `src/core/Engine.js:329-357` | `isLocalKill(ctx, payload)`, exported beside `isLocalVictim`, with both roles' rules and the under-report it accepts |
| 19 | `src/systems/Progression.js:6,130` | the run summary's counter |
| 20 | `src/ui/HUD.js:12,169-173` | the HUD counter and its reticle flash |

The two roles need opposite defaults, which is why this is not one comparison.
On an authority, `source` is a real entity and excluding another player's kills
is enough — an environmental kill, a mine's kill, a burn tick whose source has
despawned all keep counting exactly as they did in single-player. On a client,
`source` came off the wire: its own kills resolve to `ctx.player`
(`NetClient._resolve`), and every other kill resolves to an interpolated *view*,
which is not `isPlayer` and would sail straight through the authority test. So a
client counts only what it can positively identify as its own.

**Both directions, in one session.** Four enemies killed by the host's own
player, then one killed with the client's pawn as the source:

| | `preL4` | `fixed` |
|---|---|---|
| host kills 4 → host `progression.stats.kills` / `HUD.stats.kills` | 4 / 4 | 4 / 4 |
| → **client's** `progression.stats.kills` / `HUD.stats.kills` | **4 / 4** | **0 / 0** |
| then the **pawn** kills 1 → host's counters | **5 / 5** | **4 / 4** |
| → client's counters | **5 / 5** | **1 / 1** |
| client `progression.stats.damageDealt`, throughout | 0 | 0 |

Both ends, and the second half is the arm nobody had run in three rounds: **a
client's own kill is credited to the client and to nobody else**, and the host
does not take credit for it. On `preL4` the client's summary says it killed
every enemy the party killed while dealing no damage doing it, and the host
double-counts its teammate's kill — the same defect pointing both ways.

`Profile._onKill` is witness-gated already (`Profile.js:1271-1276`), so lifetime
stats were never wrong; only the run summary was, and now is not.

**An interaction to state:** `HUD.stats.kills` on a client used to be one of
K-3's observables ("0 → 4 broken, 0 → 4 fixed"). After L-4 it reads `0` on a
client whichever way K-3 goes, so that leg of K-3 is no longer available as a
signal. The downstream-kill counter (§1.3) is what replaces it, and it is why I
added it.

---

# 6. L-5, MODERATE — the victim predicate fails closed on a client. CLOSED

| # | file:line | what |
|---|---|---|
| 21 | `src/core/Engine.js:363` | `if (!victim) return ctx?.netRole !== 'client';` |
| 22 | `src/core/Engine.js:294-315` | why the two roles differ, written out |

Every `playerDead` a client sees arrives over the wire, so a missing victim there
is a failure to name one, not an old-style local emit — and answering "yes" to it
silently reverts all six of K-2's guards *and* round 1's audio identity test at
once. K-10 added a way to produce exactly that payload (`NetHost.js:300`
serialises a netId-less entity as `null`). The host keeps the permissive default
deliberately: single-player and the harness both emit through it, and on a host a
victimless payload cannot have come off the wire.

Isolated with `R1-victim` — round 1's one-line `emit('playerDead', { victim })`
reverted to `{}`, which is the only way to produce a victimless payload on the
wire without inventing one. The two arms differ by `L5-open` alone:

| | `preL5` (`R1-victim` + the old permissive predicate) | `preVictim` (`R1-victim`, fail-closed in place) |
|---|---|---|
| **the client's run after the HOST dies** | **`screen "death"`, `_ended true`, `paused true`** | **`screen null`, `_ended null`, `paused false`** |
| the client's own player at that moment | `alive true` | `alive true` |
| the client's run after **its own** pawn dies | `screen "death"`, `_ended true` | `screen null`, `_ended null` |
| the host's run after a **pawn** dies | `screen "death"`, `_ended true`, `director false` | `screen "death"`, `_ended true`, `director false` |

Both ends. The first row is the finding: with the permissive predicate, one
missing field takes the client's whole run with a teammate's death, silently.
With the fix, it does not.

**The cost, stated rather than hidden.** Failing closed also means that in the
same already-broken no-victim case, a client's *own* death no longer ends its own
run (`preVictim` row 3). That is the trade the critique asked for — "a predicate
whose job is *is this mine* should answer no when it cannot tell" — and it is the
better half of a bad pair: a run that does not end is recoverable, a run ended by
someone else's death is not. The host row is unchanged in both columns, which is
the control that the change is client-only.

---

# 7. Prior rounds' fixes, re-verified after round 3's edits

Round 3 edited **`Engine.js`, `NetClient.js`, `NetHost.js`, `Progression.js`,
`HUD.js`, `Protocol.js` and `Snapshot.js`** — six of the files rounds 1 and 2's
fixes live in. Round 2's critique's process finding was that round 2 edited five
such files and re-checked two. **Here are eight prior fixes, each with its gate
failed on purpose in isolation on round 3's tree**, and §7.6 names the two I did
not re-run and why.

## 7.1 K-1 — the client's own health and its own death. CONFIRMED

| on the **client** | `preK1` | `fixed` |
|---|---|---|
| own health, samples 1 / 4 / 8 | **170 / 170 / 170** (flat) | 138.75 / 138.75 / 140.37 |
| the host's copy of the same pawn | 138.75 / 138.75 / 140.34 | 138.75 / 138.75 / 140.37 |
| after the host kills the pawn: `alive` / `health` | **`true` / 174.73** | **`false` / 0** |

Both ends. On `preK1` the client's bar reads full while the host's copy is 31
points down, and the client stays alive through its own death.

## 7.2 K-2 — a teammate's death is not your run's death. CONFIRMED

| | `preK2` | `fixed` |
|---|---|---|
| **host** after the pawn dies: `screen` / `_ended` / `director.enabled` | **`"death"` / `true` / `false`** | **`null` / `null` / `true`** |
| **client** after the host dies: `screen` / `_ended` | **`"death"` / `true`** | **`null` / `null`** |
| **client** after its **own** death: `screen` / `_ended` / `alive` | `"death"` / `true` / `false` | `"death"` / `true` / `false` |

Both ends, both directions, with the control on the last row showing the guard is
not too wide: your own death still ends your own run in both columns.

## 7.3 K-3 and the `EventBus` isolation — CONFIRMED, and attributed more finely

K-3 has two halves — the wire format (`NetHost.sanitise`) and the
`Number.isFinite` early return in `Audio._out`. Round 2's critique reverted both
together. Reverting the wire **alone** does not fail:

| on the **client**, four kills | `preK3` (wire only) | `preK3full` (both halves) | `preEBfull` (both + isolation reverted) | `fixed` |
|---|---|---|---|---|
| wire form of `position` (read upstream of every listener) | **`array`** | **`array`** | **`array`** | **`object`** |
| `Number.isFinite(position.x)` | **`false`** | **`false`** | **`false`** | **`true`** |
| `Audio.death` calls | 4 | 4 | 4 | 4 |
| `Audio.death` **throws** | **0 of 4** | **4 of 4** | **4 of 4** | **0 of 4** |
| `kill` reaching a listener registered *after* `Audio` | 4 of 4 | **4 of 4** | **0 of 4** | 4 of 4 |
| client `[events] listener threw` console errors | 0 | **8** | **0** | 0 |
| client uncaught page errors | 0 | 0 | **8** | 0 |

Three results, and two of them are new:

1. **K-3's braces alone are sufficient.** The `Audio._out` guard catches the
   non-finite position by itself; the wire format is belt to its braces. That is
   a strengthening of K-3, not a weakening — and it is why `preEB` is not a
   failed gate and is not quoted as one (§1.5).
2. **The isolation change is re-confirmed at both ends** on the one pair that can
   test it: `preK3full` and `preEBfull` differ by `EB-isolate` alone, the throw
   is identical in both (4 of 4), and the dispatch outcome is opposite —
   4 of 4 downstream against **0 of 4**. That is round 2's §5.1 reproduced on
   round 3's tree.
3. **Eight messages for four throws.** The count is 2× the `Audio.death` throws
   in both columns. The most likely second thrower is `VFX._onKill →
   Vector3.copy`, which the wire format also broke and which K-3 also fixed —
   but **I did not isolate it**, and I am not claiming it. What is measured is
   that the loudness is 1:1-or-better with the failure, in the same console
   bucket `tools/capture.mjs:254` already collects.

## 7.4 K-5's accounting half, and F-10 underneath it. CONFIRMED

| on the **client**, after the same real hit | `preK5` | `preF10` | `fixed` |
|---|---|---|---|
| `progression.stats.damageTaken` | **0** | **0** | **31.25** |
| `items.timeSinceHurt()` | 2.03 | **1004.60** (sentinel) | 2.03–2.08 |
| `playerHurt` cues on the client | 1 | **0** | 1 |

Both ends, and the dependency round 2's critique found is re-confirmed: **K-5
rides entirely on round 1's F-10 forward.** On `preK5` the client felt the hit
(hurt timer 2.03, one cue) and recorded none of it; on `preF10` it never learned
it was hit at all.

## 7.5 F-6 and F-9. CONFIRMED

| | `preF6full` | `fixed` |
|---|---|---|
| client `_lastCmdTick` immediately before the join | 90 | 91 |
| `_lastCmdTick` at connect | **125** | **6** |
| `net.tick` at the same instant | **8** | **6** |
| `player._localTick` at connect | **125** | **0** |

`atJoin.lastCmdTick === atJoin.netTick` on the fixed tree: the epoch is re-based
before the first wire command. On `preF6full` the counter is 117 ticks ahead of
the wire, which is the replay lock.

| on the **host**, real enemy raised to `1e7` health so neither hit lands on a corpse | `preF9` | `fixed` |
|---|---|---|
| `peerDealt` (the pawn's hit actually landed) | 777 | 777 |
| `damageDealt` delta from the **peer's** 777 | **+777** | **+0** |
| `damageDealt` delta from the **local** 500 | +500 | **+500** |

Both ends, with the control on the same run showing the guard is not too wide.
`targetAliveThroughout: true` and `usedRealEnemy: true` in both. The
`highestHit` legs are disqualified (§1.5).

## 7.6 Prior fixes I did **not** re-run in isolation, and why

- **Round 1's F-7** (the jump-impulse side-effect gate in `src/data/items.js`).
  I did not touch `data/items.js` or `Player._jump`, and no round-3 edit is
  upstream of the item hooks. Not re-run in co-op with its gate failed. The
  single-player control does exercise the same three cards on both trees and
  reads `[30, 30, 36]` with all three presses reached (§8).
- **Round 1's M1** (the audio identity test in `src/systems/Audio.js`). I did not
  edit `Audio.js`. Its predicate is netId identity, independent of `isLocalKill`
  and of `isLocalVictim`. Not re-run.
- **K-9 and K-10.** K-10 is a payload-size change with no behavioural signature,
  as round 2's critique established; I edited `NetHost.js` but not `sanitise`.
  Not re-run. K-10's *consequence* is now covered from the other side by L-5.
- **F-11.** Untouched, for the reason all three rounds give.

---

# 8. Regressions — single-player did not move, on both trees

`sp-fixed` (no substitutions) and `sp-pre` (all six of round 3's, i.e. the tree
as round 2 left it), both `netRole "single"`, `authority true`, both through
`menus.launch()` and both past the `_localTick > 60` gate. Same inventory, same
six-unit spawned pack.

| | `sp-pre` (round 2's tree) | `sp-fixed` (round 3's) |
|---|---|---|
| enemies available → killed | **6 → 4** | **6 → 4** |
| `progression.stats.kills` | **4** | **4** |
| `HUD.stats.kills` | **4** | **4** |
| `Audio.death` calls / **throws** | 4 / **0** | 4 / **0** |
| `kill` reaching a downstream listener | **4** | **4** |
| `kill` payload `position` type / finite / `source === ctx.player` | `object` / `true` / `true` ×4 | `object` / `true` / `true` ×4 |
| 40-damage hit: `dealt` | **33.333333** | **33.333333** |
| `playerHurt` emits over that hit | **2** | **2** |
| three sprint-jumps: impulses applied | **`[30, 30, 36]`** | **`[30, 30, 36]`** |
| own death: `alive` / `screen` / `_ended` | `false` / `death` / `true` | `false` / `death` / `true` |
| own death: `director.enabled` / `ctx.paused` | `false` / `true` | `false` / `true` |
| own death silences the music | `stopped true` | `stopped true` |
| `[events] listener threw` console errors | **0** | **0** |
| page errors (the pointer-lock one) | **1** | **1** |

**Single-player did not move.** The jump row reaches all three presses on both
trees, so Tectonic Heart's every-third `36` is re-verified as identical rather
than never reached.

The four specific risks in round 3's edits, each with the row that would have
caught it:

- **`isLocalKill` does not suppress a single-player kill.** `progression` 4 and
  `HUD` 4 on both trees, with the probe recording `sourceIsSelf: true` on all
  four payloads — so it is the *authority* branch carrying single-player, and it
  is measured, not assumed.
- **`isLocalVictim`'s new client branch does not touch single-player.** `screen
  "death"`, `_ended true`, `director false`, music silenced, on both trees.
- **`NetHost._holdSession` costs single-player nothing.** `NetHost` is not in the
  system list in a `netRole "single"` session; `ctx.paused` reads `true` under
  the death screen on both trees, which is the observable that would have moved.
- **The protocol's two extra bytes cost single-player nothing.** `writeEntity` is
  never called in a single-player session; the identical rows above are the
  control, and I say plainly that this is the same empty control round 2's
  critique correctly struck for K-10 (§9.1, item 4). It demonstrates nothing
  about the wire either way.

**Rows that are not build-invariant and are not read as such:** `damageTaken`
(27.08 against 27.06), `health` after the hit (115.92 / 115.94), `timeSinceHurt`
(0.38 / 0.37), `musicGain` (0.09139 / 0.09336) and `intensity` (0.1638 / 0.1635)
— all arena chip damage or wall-clock decay sampled between probe steps.

**A leg my single-player control does not cover, stated rather than glossed:**
`shield` after the hit reads **0 on both trees**, so the `onDamaged` barrier leg
that round 2's critique measured at 23.58 is not exercised here. Two `playerHurt`
cues fired over that window (arena chip damage plus mine), so the most likely
cause is that Sunken Vertebra had already paid out and decayed by the read. I did
not chase it. Identical on both trees, therefore not a regression signal, but not
a control either.

---

# 9. The record

## 9.1 Round 2's report — L-6's six items, applied in place

All six of `round2-critique-coop.md` §11.2's findings are correct, and I applied
them as a correction banner at the head of `round2-fix-coop.md` rather than
silently agreeing with them elsewhere. Item 2 — round 2's `preEB` wire cells
presented as measurements when its own probe recorded `[]` — is now measured a
third time, upstream of the abort, on `preK3full`: `array` / `false` ×4 (§7.3).

## 9.2 L-8 and L-9 — corrections, not code

- **L-8** (`NetClient.js:299-305`). The `sinceDamage = 0` reset is **kept**, and
  the comment that used to state a corrective effect now states the measured
  one: at zero lag the line buys nothing observable, because the 20 Hz overwrite
  dominates whatever regen adds between snapshots. It is a correctness statement
  whose payoff scales with RTT, and nobody has run it under real RTT. I did not
  re-measure the `preK1regen` arm; round 2's critique's 0.04-against-0.06 is the
  measurement, and I am recording its conclusion, not re-deriving it.
- **L-9.** The costing correction is right: **three** cards use `Items.tally`
  (`frost-lattice`, `resonance-coil`, `tectonic-heart`), an optional `owner`
  parameter defaulting to the local survivor is backward compatible, and the
  re-keying is three call sites and one method — not a sweep. Restated in §10.2.

## 9.3 L-7 does not exist

`round2-critique-coop.md`'s severity table lists four MINORs — L-6, L-7, L-8,
L-9 — and **L-7 appears nowhere else in that document**. There is no §, no
paragraph and no ledger row for it. I searched the whole file. So one of the four
MINORs in the headline count has no content behind it, and this round could not
have closed it. Naming it here so the count and the findings agree.

## 9.4 `EventBus.emit`'s two unnamed semantics — documented

`src/core/Engine.js:276-287`. Both edges the critique found are now written at
the call site: a listener **removed** mid-dispatch still runs, and one **added**
mid-dispatch no longer does. Neither is reachable today — there is not one
`.off()` call site in `src/` outside `EventBus` itself, and nothing subscribes
from inside a handler — so it is a note for whoever writes the first one, with
the correct fix named (`if (!set.has(fn)) continue;`, not dropping the copy,
which would reintroduce the mid-iteration hazard the copy exists for).

---

# 10. Findings this round's measurement uncovered

## 10.1 N-1, MAJOR — no enemy has ever targeted a co-op pawn

`Enemy.fixedUpdate` reads `const p = ctx.player` and targets it
(`Enemy.js:449-455`); `hurtPlayer` and `statusPlayer` route to `ctx.player`
(`Enemy.js:36`, `:54`, `:63`); the elite auras test `distToPlayer`
(`Enemy.js:471`). `ctx.player` on a host is the **host's own survivor**, and a
pawn is never it.

So in every co-op session in three rounds, **all enemy attention and all enemy
damage has gone to the host and only the host.** Every measurement of a client
taking damage in rounds 1, 2 and 3 — including all of F-10, K-5 and L-3 — was
driven by a harness call, not by the game. I did not build an arm for it (I would
have had to wait for an enemy to reach a stationary pawn and prove it never did);
this is a source finding, and it is the strongest one in the file.

**Cost:** enemy targeting becomes "nearest player" — a player list on `ctx`
(`coop.pawns` plus `ctx.player`), one nearest-player query per enemy per tick, and
`hurtPlayer`/`statusPlayer` routed to the enemy's current target rather than to
`ctx.player`. Bounded and mechanical, but it touches the AI hot path and every
elite affix, and it needs its own verification pass. **It is the reason L-1's
"the run continues" currently means "the run continues, and it is easier".**

## 10.2 N-2 — level divergence between a host and a client over a session

At the join, the pawn and the client's own survivor both read `maxHealth 170`. By
the end of a two-minute session the client's own reads **221** while I only ever
sampled the pawn's at the start. `Progression.level` is run state on each machine
and a client learns it from the forwarded `levelUp`, so the two can drift if any
`levelUp` is missed. K-1 scales a *fraction* by the local maximum, so a level
divergence is L-2's defect in a slower form.

Measured only as a single asymmetric reading, not as a divergence — **I did not
sample both ends' `level` and `maxHealth` together over a session**, and I am not
claiming a divergence exists. It is a named arm (§12.7), and it is cheap to run.

## 10.3 N-3 — no `PROTOCOL_VERSION` check on either side

WELCOME carries the version and `NetClient` reads it into a discard
(`NetClient.js:102`). The host never learns the client's. Round 3's entity record
grew by two bytes, so a cross-version pairing now mis-frames every entity after
the first rather than degrading. **That was already true at version 2** — the
layout changed then too — and round 3 does not make it worse, but it is now the
next thing that file needs. Stated at `Protocol.js:29-41`. **Cost: one comparison
in `_onMessage`'s HELLO branch and one in `MSG.WELCOME`, plus a refusal path.**

---

# 11. Appendix — the substitution table

Reproduced because the driver was deleted. All eighteen were validated against
`src/` as matching **exactly once** before any arm was run; the validator's
output was `OK` for all eighteen and `BAD: []`. The transform throws unless the
anchor matches exactly once, and the arm then refuses to boot.

| name | file | line replaced | replaced with |
|---|---|---|---|
| `L2-hello` | `src/net/NetClient.js` | `this._sendHello();` | `;` |
| `L1-hold` | `src/net/NetHost.js` | `this._holdSession(ctx);` | `;` |
| `L3-shield` | `src/net/NetClient.js` | `const sfrac = e?.shieldFrac;` | `const sfrac = undefined;` |
| `L4-prog` | `src/systems/Progression.js` | `if (!isLocalKill(ctx, e)) return;` | `;` |
| `L4-hud` | `src/ui/HUD.js` | `if (isLocalKill(ctx, e)) {` | the pre-L-4 condition |
| `L5-open` | `src/core/Engine.js` | `if (!victim) return ctx?.netRole !== 'client';` | `if (!victim) return true;` |
| `K1-all` | `src/net/NetClient.js` | `this._applyAuthoritativeHealth(player, authoritative);` | `if (authoritative) { }` |
| `K1-death` | `src/net/NetClient.js` | `if (e?.state === ESTATE.DEAD) {` | `if (false) {` |
| `K2-pred` | `src/core/Engine.js` | the same `!victim` line | `return true;` (the whole predicate) |
| `K3-wire` | `src/net/NetHost.js` | the `{x, y, z}` object form | the array form |
| `K3-guard` | `src/systems/Audio.js` | the `Number.isFinite(pos.…)` early return in `_out` | `;` |
| `EB-isolate` | `src/core/Engine.js` | `} catch (err) {` | `} catch (err) { throw err;` |
| `K5-prog` | `src/systems/Progression.js` | `this.stats.damageTaken += e?.amount ?? 0;` | `;` |
| `R1-F6` | `src/net/NetClient.js` | `ctx.player?.resetCommandEpoch?.();` | `;` |
| `R1-F6-window` | `src/entities/Player.js` | `&& this._lastCmdTick - c.tick < REPLAY_WINDOW;` | `&& true;` |
| `R1-F9` | `src/systems/Progression.js` | the `e.source === ctx.player` damage guard | the unguarded form |
| `R1-F10` | `src/net/NetHost.js` | `ctx.events.on('damage', (e) => this._forwardHurt(e));` | `;` |
| `R1-victim` | `src/systems/Combat.js` | `ctx.events.emit('playerDead', { victim });` | `ctx.events.emit('playerDead', {});` |

`EB-isolate` is deliberately **smaller** than the change it reverts: it leaves
the set copy in place and only restores abort-on-throw, so §7.3's table isolates
the try/catch semantics and nothing else.

---

# 12. Arms I did not test

Naming them is not a claim that they are fine.

1. **Three or four peers.** Every session here is host + one client.
   `hasLivePeer()` with two pawns, `isLocalVictim` with two pawns, and
   `_forwardHurt`'s linear owner scan with two entries are all unexercised. In
   particular, **`_holdSession` with two clients where one is dead** is a source
   reading only: `hasLivePeer` returns true while any pawn is alive, which is the
   behaviour I intend, but nobody has driven it.
2. **A peer leaving, and reconnect after `Lobby.leave()`.** Not driven, in any of
   the three rounds. This matters more after L-1 than before it: the host now
   *can* quit from its death screen into a running session, and what a client
   sees when the host leaves is `netDisconnected` and nothing else. **A client is
   still stranded by a host that quits, and L-1 does not fix that.**
3. **Real network conditions.** Loopback WebRTC on one machine. L-2's agreement
   figures, L-3's shield agreement, L-8's regen result and `HOLD_GRACE`'s 1.5 s
   are all zero-lag numbers. `HOLD_GRACE` in particular is sized against a
   zero-RTT snapshot pipeline and I have not tested it against a lossy one.
4. **The correction rate under matched survivors.** L-2 fixes the stat mismatch;
   I did not count reconciliation replays before and after.
5. **A client killing anything with its own weapon.** §5's pawn-source kill is
   driven by a harness call with the pawn as `source`, which is the same payload
   the wire would carry — but the client did not pull the trigger. A client's
   *placeable* kill (mine, sentry) is the case `isLocalKill` knowingly
   under-reports, and that is not measured either.
6. **`isLocalKill` against a burn/DoT kill whose source has despawned.** Source
   reading says the authority branch keeps counting it; not driven.
7. **Level divergence over a session** (§10.2). Both ends' `level` and
   `maxHealth` sampled together, over minutes. Not run.
8. **Enemy targeting of a pawn** (§10.1). Source-derived. I did not build the arm.
9. **A stage transition in co-op.** No teleporter was charged in any arm, so
   `flawlessStages`, `syncStage` and the realm abort under L-5's new predicate
   are all unexercised. This is now three rounds old.
10. **The 21-shot capture.** Not run: its default port is 5199 and the user is
    playtesting on this machine. The build is exit 0 and §8 covers the changed
    single-player paths, but nobody has re-shot the manifest against these edits.
11. **Whether any of it sounds right.** Still nobody has listened. `musicGain`, a
    cue count and a throw count are not a cue, and that is now six rounds old.
12. **The `onDamaged` barrier leg in single-player** (§8), which read 0 on both
    trees and which I did not chase.

---

# What ships, what is held, and what it costs

**For someone deciding whether to enable the Co-op menu entry.**

## What ships

Two people can now play a co-op run together and both of them are playing their
own game. Specifically, and each measured at both ends:

- **You play the survivor you picked.** (L-2) The host simulates your pawn with
  your stats, your speed and your health — `anvil` 170/6.5/15, not the host's
  `ranger` 110/7.0/12 — and your health bar agrees with the authority to within
  0.06 instead of being 55 % wrong for ever.
- **One death ends one run.** (L-1 + K-2) A teammate's death does not end yours,
  a host's death does not stop your world, and your own death still ends your own
  run — including with the host already dead. The host's clock kept running 205
  ticks through four seconds of being dead; with the fix reverted it sat frozen
  on one number for the same four seconds.
- **Your run summary is yours.** (L-4) Your kill counter counts your kills and
  your kills alone, in both directions — you no longer inherit the host's four,
  and the host no longer inherits your one.
- **Your health bar does not lie about your barrier.** (L-3)
- **A malformed death message cannot silently end your run.** (L-5)
- **Menus on a host are overlays, not pauses**, with local input muted while
  they are up. (L-1) This is a behaviour change the host will feel.
- Everything rounds 1 and 2 closed is still closed: eight of their fixes were
  re-verified here with a gate failed on purpose for each, and two more were left
  alone for stated reasons (§7.6).
- **Single-player did not move**, measured on both trees.

## What is held

Ranked by what it costs the player, with what it costs to fix.

1. **Enemies never attack anyone but the host.** (N-1, MAJOR, §10.1) This is the
   big one and it is *pre-existing* — three rounds of co-op work, and nobody
   looked at `Enemy.js`. A joining player is functionally invulnerable to the AI,
   and the host fights the whole run alone. It is also why L-1's "the run
   continues after the host dies" currently means "the run continues, and it is
   easier". **Cost:** a player list on `ctx`, nearest-player targeting in
   `Enemy.fixedUpdate`, and `hurtPlayer`/`statusPlayer` routed to the enemy's
   target. Mechanical, in the AI hot path, needs its own verification pass.
2. **A host that quits still strands its clients.** (§12.2) L-1 fixed the host
   *dying*. A host that leaves from its death screen drops every client into
   `netDisconnected` with no run end at all. **Cost:** one listener that ends the
   local run on disconnect. Small, and untested in three rounds.
3. **Defensive item cards do nothing for a client.** (K-4 / L-3) The host does not
   run a pawn's item hooks, so Sunken Vertebra, Rubber Soles, Tectonic Heart and
   the cards like them are inert for a joiner. After L-3 this is *visible* rather
   than a lie on the bar. **Cost:** per-jumper tally state plus a jumper-aware
   item-hook API — and, corrected from round 2's estimate, only **three** `tally`
   call sites and one method, with an optional `owner` parameter that is backward
   compatible. The `api.jumper` half is the real work.
4. **A client's soundtrack does not react to the fight.** (K-6) Three inputs, one
   alive; `Director.fixedUpdate` returns for a non-authority before
   `updateDifficulty`, so `arc` is frozen per stage on a client. **Cost:** either
   replicate the difficulty arc or drive intensity from forwarded events only.
5. **Nobody has played a stage transition in co-op.** (§12.9) Three rounds, no
   teleporter charged. This is not a known defect; it is an unknown, and it sits
   between stage 1 and every stage after it.
6. **Still deferred and still correct to defer:** F-11 (the join placement gap),
   a client's outgoing damage never reaching its `damageDealt`, and cross-version
   protocol validation (N-3).

## The call

**Enable it for two players who know each other, or hold it — but the reason has
changed.** After this round the co-op session is coherent: two survivors, two
health bars that tell the truth, two run summaries that are each about their own
player, and a death that ends one run instead of a session. What is left is not
incoherence, it is *thinness*: the joining player is never attacked, three
classes of item do nothing for them, and their soundtrack is flat. That is a game
you can finish together and would not choose to play twice.

If the bar is "does it lie to the player", it no longer does, and that was the
bar the previous two rounds could not clear. If the bar is "is the second player
playing the same game as the first", **N-1 is the one thing standing in the way**,
it is one bounded change in `Enemy.js`, and nobody has looked at it yet.

---

Raw JSON: `reviews/round7/coop/r3/` — 21 files, nineteen co-op sessions plus two
single-player. The driver was deleted after use; its substitution table is §11
and every number above names the file and key it came from.
