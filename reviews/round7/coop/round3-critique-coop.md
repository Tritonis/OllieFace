# Round 7 — round-3 critique, co-op fixes
## Final independent review of the third uncommitted co-op fix round on `round7/content-and-polish` @ `a43cc70`

There is no round 4. Everything below is measured on this tree, in this working
directory, with all three fix rounds present and nothing committed, staged or
reverted.

---

# 0. Headline

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 737ms`,
re-run at the end after every driver was deleted, with all three fix rounds still
in the working tree and nothing staged, committed or reverted — `git status`
shows the same sixteen modified files it showed at the start).

**N-1 is real, and round 3 got its consequence wrong in the direction that
matters.** I built the arm round 3 declined to build. Over 30 seconds with a
host and a client standing 3 m apart inside a six-unit pack — melee, ranged and
a mortar — the enemies landed **78 directed attacks on the host and 0 on the
pawn**, every one of them while `enemy.target` held the host's position and
`targetIsPawnPos` read `false`. Enemies never select, pursue, line-of-sight-test
or aim at a pawn. That half of N-1 is **CONFIRMED**, and it is the single
biggest thing wrong with co-op.

But round 3's stated consequence — "a joining player is **functionally
invulnerable** to the AI" — is **REFUTED**. A pawn is registered with `Combat`
on team `player`, so every *area* effect an enemy produces is a team-filtered
spatial query that includes it. An Overloading elite dying 1.5 m from the pawn
took **87 points off it** (66 blast + 5 × 4.2 shock) with no harness damage call
in the chain, and the client's own `progression.stats.damageTaken` booked
**67.96** for it. Round 3 asserted invulnerability from a source read, without
an arm. It is wrong.

That same arm settles the second, larger worry. Because that damage was
genuinely enemy-originated and travelled the whole real path — `Enemy` →
`combat.explode` → `applyDamage(pawn)` → `NetHost._forwardHurt` → the client's
`playerHurt` → `Items.onDamaged` → `Progression` — **K-1, K-5, F-10, L-3 and M1
survive N-1 intact**. Their mechanism does not read the damage source. Nobody in
three rounds had shown that; it is shown here.

**Verdict on the round: the five findings it was convened for are closed. Every
one of L-1, L-2, L-3, L-4, L-5 is CONFIRMED at both ends, with the gate failed on
purpose in isolation for each. The three record items L-6, L-8, L-9 are correct
and applied. L-7 does not exist and round 3 is right to say so.** Eight prior
fixes re-verified by round 3 all still hold on my own arms, and the **four it
declined to re-run — F-7, M1, K-9/K-10, F-11 — I ran the first three: M1 was
load-bearing and holds, F-7 holds in co-op at both ends, and K-10 is confirmed
to have no behavioural signature. So does round 3's own `Player._jump`
restructure, which had no gate from anyone until this document.**

**Eight new findings of my own, plus N-1 adjudicated — and the round's own claim
that "single-player did not move" is REFUTED by one of them.**

## 0.1 Severity table

| severity | count | ids |
|---|---|---|
| CRITICAL | 0 | — |
| MAJOR | 3 | N-1 (adjudicated), N-4, N-7 |
| MODERATE | 4 | N-5, N-6, N-8, N-9 |
| MINOR | 2 | N-10, N-11 |

| id | one line | new? |
|---|---|---|
| **N-1** | no enemy ever *selects* a pawn (CONFIRMED); "invulnerable to the AI" (REFUTED) | round 3's, adjudicated |
| **N-4** | `MSG.HELLO` is an unauthenticated, unlimited pawn reset: a peer can full-heal and re-stat its own pawn at will, mid-fight | mine |
| **N-7** | L-4's HUD half **widens** the kill guard: `+1` on your own death and `+1` per enemy-on-enemy kill, with a reticle kill-flash — **in single-player**. "Single-player did not move" is false | mine |
| **N-5** | an unknown survivor id in HELLO silently re-stats the pawn to the **default** survivor, re-creating L-2's exact defect from one bad byte | mine |
| **N-6** | a truncated HELLO throws **uncaught** on the host (`Invalid typed array length: 200`); `readHello`'s own comment says it cannot | mine |
| **N-8** | `HOLD_GRACE` closes its defect and opens a **1.68 s** window (measured) in which a host that opened a menu is simulated, targeted and unable to act | mine |
| **N-9** | a client's `onDamaged` **heals** are overwritten by the authority exactly as its barriers are; the comment L-3's round added at `Items.js:205-215` claims the opposite | mine |
| **N-10** | L-6 item 6 is *recorded* in the round-2 banner but the bad pointer in `round1-fix-coop.md` is still there | mine, record |
| **N-11** | round 3's §7.3 "eight messages for four throws" (2× loudness) is not reproducible — I measure **7 for 7**, 1:1 | mine, record |

Round 3's own new findings **N-2** (level divergence) and **N-3** (no
`PROTOCOL_VERSION` check) are adjudicated in §10. N-3 is **CONFIRMED by
measurement**, at both ends, and it is worse than round 3 states because of N-5.

---

# 1. Methodology, and the gates that make the rest admissible

## 1.1 Real pages, one real wire, and a third player

Every co-op number below is taken from two or **three** Chromium pages in one
browser over the manual WebRTC invite path (`Lobby.createInvite` / `joinManual`
/ `acceptAnswer`). Ports **5781–5798 only**. Port 5199 was never touched and no
running node or vite process was killed or restarted. `src/` was never modified.

Round 3's §12.1 names "three or four peers" as an arm nobody had driven. **Seven
of my co-op sessions run host + two clients** on three different survivors, and
that is where `hasLivePeer()` with one dead pawn and one live one, `isLocalVictim`
with two pawns, and `_forwardHurt`'s owner scan with two entries are exercised.
Session reality, `roles` in every three-page JSON:

```
host    { role: "host",   authority: true,  clients: 2 }
client0 { role: "client", authority: false, myNetId: 1,  connected: true }
client1 { role: "client", authority: false, myNetId: 28, connected: true }
```

**Three survivors, deliberately** — host `ranger` (110 / 7.0 / 12), client0
`anvil` (170 / 6.5 / 15), client1 `kestrel` (90 / 7.4 / 17). Two mismatched
survivors is what makes L-2 measurable; three is what shows the host does not
simply copy *one* id onto every pawn.

## 1.2 The running-game gate, and the thing about it round 3's wording hides

Each page launches through the real menu (`menus.survivorId = …;
menus.launch()`) and then **blocks** on

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

before anything else happens. `runningGate` on the `fixed` arm:

| | host | client0 | client1 |
|---|---|---|---|
| `paused` | `false` | `false` | `false` |
| `menus.screen` | `null` | `null` | `null` |
| `player._localTick` | 66 | 64 | 65 |
| `player.survivorId` | `"ranger"` | `"anvil"` | `"kestrel"` |
| `player.maxHealth` | 110 | 170 | 90 |

**A second gate after the join**, because the second and third pages steal
pointer lock and `Menus` opens the pause screen on losing it. Every arm clears
both screens and re-asserts. `runningGateAfterFocus` on `fixed`:

| | host | client0 | client1 |
|---|---|---|---|
| `paused` / `screen` | `false` / `null` | `false` / `null` | `false` / `null` |
| the tick that advances on that role | `_localTick` **240** | `net.tick` **65** | `net.tick` **78** |

**And a fact I had to discover the hard way, which round 3's §1.2 does not
state:** after the join a client's own `player._localTick` is **frozen at 0
forever**. `NetClient.fixedUpdate` stamps commands from its own `this.tick`
(`NetClient.js:172-176`) and round 1's `resetCommandEpoch` zeroes the player's
counter. So the liveness half of the brief's gate — `_localTick > 60` on *both*
pages — is **unattainable on a client at any point after it joins**, and my
post-join gate uses `net.tick` on that role instead. Round 3's report is not
wrong about this (its `runningGateAfterFocus` claims only `paused` and `screen`),
but the brief's wording is impossible to satisfy literally and anyone reading
either document should know why.

## 1.3 The instruments

- **The bus probe** wraps `ctx.events.emit` itself, so a `kill` payload is
  recorded **upstream of every listener**, before any dispatch can abort. Proved
  by failing: `array` / non-finite ×7 on `preEBfull`, a page where the
  downstream listener never ran once.
- **The downstream-kill counter**, a `kill` listener registered **last**. 8 of 8
  on `fixed`, **0 of 7** on `preEBfull`.
- **`Audio.death` and `Audio.playerDead` call/throw counters**, re-throwing so
  nothing is masked.
- **A passive `Combat.applyDamage` observer on the authority**, recording every
  hit's target, type and source id, and in particular whether the target was a
  pawn and whether the source was an enemy. **It drives nothing.** This is the
  instrument N-1 needed and nobody built.
- **Paired end-to-end sampling** — one host read and one client read back to
  back, eight times over two seconds, for every health/shield row.
- **Real DOM key events** for the jump probe: Playwright `keyboard.down/up` in
  single-player, `window.dispatchEvent(new KeyboardEvent(...))` on the client
  page in co-op (no page needs focus, and the whole `Input` →
  `_sampleCommand` → `_jump` path runs).

## 1.4 Arms

Twenty-eight sessions kept — 23 co-op and 5 single-player — plus one disqualified
and deleted (§1.5). Sabotage is by named in-memory source substitution inside a
vite `transform`; a substitution whose anchor does not match **exactly once**
throws and the arm refuses to boot. Every anchor is validated against `src/` on
disk before any arm runs, and `substitutionsMissing` is `[]` in every run.

| arm | substitutions | what it reverts | peers | raw |
|---|---|---|---|---|
| `fixed` | *(none)* | — | 2 | `fixed.json` |
| `preL1` | `L1-hold` | the session hold | 2 | `preL1.json` |
| `preL2` | `L2-hello` | the survivor id crossing the wire | 1 | `preL2.json` |
| `preL3` | `L3-shield` | the client's shield correction | 1 | `preL3.json` |
| `preL4` | `L4-prog`, `L4-hud` | both kill-credit guards | 2 | `preL4.json` |
| `preVictim` | `R1-victim` | round 1's `victim` field only | 2 | `preVictim.json` |
| `preL5` | `R1-victim`, `L5-open` | + the fail-closed predicate | 2 | `preL5.json` |
| `preK1` | `K1-all` | round 2's K-1 | 1 | `preK1.json` |
| `preK2` | `K2-pred` | round 2's K-2 predicate | 2 | `preK2.json` |
| `preK3full` | `K3-wire`, `K3-guard` | K-3, both halves | 1 | `preK3full.json` |
| `preEBfull` | `K3-wire`, `K3-guard`, `EB-isolate` | + abort-on-throw restored | 1 | `preEBfull.json` |
| `preK5` | `K5-prog` | K-5's accounting handler | 1 | `preK5.json` |
| `preF6full` | `R1-F6`, `R1-F6-window` | round 1's F-6, both halves | 1 | `preF6full.json` |
| `preF9` | `R1-F9` | round 1's damage-credit guard | 1 | `preF9.json` |
| `preF10` | `R1-F10` | round 1's per-owner hurt forward | 1 | `preF10.json` |
| `preM1` | `R1-M1` | round 1's audio identity test | 2 | `preM1.json` |
| `preK10` | `K10-null` | K-10's `null` branch | 1 | `preK10.json` |
| `n1b` | *(none)* | N-1, four placement phases | 1 | `n1b.json` |
| `n1e` | *(none)* | N-1 reachability, three phases | 1 | `n1e.json` |
| `proto` | *(none)* | HELLO at the trust boundary + the pause overlay | 1 | `proto.json` |
| `f7-fixed` / `f7-pregate` / `f7-preimpulse` | — / `R1-F7-*` | round 1's F-7 **in co-op** | 1 | `f7-*.json` |
| `sp-fixed` / `sp-pre` | — / all six of round 3's | single player, both trees | 1 page | `sp-*.json` |
| `sp-preL4hudHEAD` | `L4-hud-head` | **HEAD `a43cc70`'s exact HUD condition** | 1 page | `sp-preL4hudHEAD.json` |
| `sp-preF7` | `R1-F7-soles`, `R1-F7-tectonic` | round 1's F-7 in single-player | 1 page | `sp-preF7.json` |

## 1.5 Evidence I disqualified rather than shipped

- **`sp-pre`'s HUD kill rows are taken through a substitution that is not a
  faithful revert.** My first `L4-hud` opened the guard to `if (true)`, not to
  HEAD's condition, so `sp-pre` and `sp-fixed` agreeing on `hudKills` proves
  nothing. I recovered the exact HEAD line with `git show a43cc70:src/ui/HUD.js`
  and re-ran the leg as `sp-preL4hudHEAD`. **N-7 is stated only from that arm.**
  The `sp-pre` HUD rows are not quoted anywhere as a control.
- **`sp-preF7` is not a failed gate and I do not quote it as one.** Round 1's
  F-7 gate is `e.local === false`, and `local` is always true in single-player,
  so reverting it is a no-op there: `[30, 30, 36]` on both trees. F-7 can only
  fail in co-op, which is why I built `f7-*` (§8.3).
- **`preK10` is not a failed gate either.** Reverting K-10's `null` branch
  produced no null victim in my fixture — `victimIsNull: false` on all payloads
  — exactly as round 2's critique established. It demonstrates nothing about
  K-10 in either direction and is quoted only to say so.
- **`preVictim`'s host-death leg did not land.** The 1e9 blow aimed at the
  host's own survivor was eaten by i-frames (`Combat.js:387`); that arm's host
  reads `alive: true, health: 49.23` where it should read dead. Every other
  `preVictim` row is clean and the host-death conclusion is taken from `preL5`,
  which did land.
- **`highestHit` is contaminated in every arm** (my kills deal `1e9`) and is not
  read. The load-bearing F-9 pair is `peerDelta` / `localDelta`.
- **`P1`'s "the host is defenceless while its menu is up" is a mechanism I
  measured and a consequence I did not.** The world running and
  `input.enabled === false` are both measured five times; the pack I spawned did
  not land a hit inside the 2.5 s window, so "the host can be killed while
  reading a pause menu" is one inference away from the data and is labelled as
  such in §7.2.
- **`maxHealth`, `health`, `damageTaken`, `timeSinceHurt` and `shield` are
  session-dependent** and appear only as agreements or comparisons *within* one
  session. In particular a client's own `maxHealth` climbs from 170 to 221+
  across a session as the run levels, which is why every agreement table is
  taken in the seconds around one hit.
- **My first N-1 session is deleted, not quoted.** It ran phases B and C with the
  host already dead, so "0 hits on the pawn" in those phases could have been "0
  hits because everything had stopped attacking a corpse". `n1b.json` re-runs it
  with both players made unkillable and `n1e.json` re-runs it again with the host
  topped up every 500 ms; only those two are quoted.
- **N-1's phase-C and phase-D health deltas in `n1b.json` are unusable** — the
  1e6 health I set is rewritten by the level-scaling recompute, and the host was
  dead for part of them. The load-bearing observables in that file are the **hit
  counts** and the **per-enemy telemetry**, both of which are clean; `n1e.json`
  re-runs the same question with the host topped up every 500 ms.

---

# 2. N-1 — the arm round 3 did not build. CONFIRMED as targeting, REFUTED as invulnerability. MAJOR

## 2.1 The source claim, re-derived

Round 3's reading of `src/entities/Enemy.js` is exactly right and I re-derived
every line of it:

| line | what |
|---|---|
| `Enemy.js:36` | `hurtPlayer` opens `const p = ctx.player;` — every melee, charge, pull, beam and aura hit |
| `Enemy.js:63` | `statusPlayer` applies to `ctx.player` |
| `Enemy.js:449-455` | `fixedUpdate` copies `ctx.player.position` into `this.target` and computes `distToPlayer` from it |
| `Enemy.js:471`, `:486` | the Blazing and Withering auras test that same `distToPlayer` |
| `Enemy.js:499` | `checkLOS` raycasts to `ctx.player` |
| `Enemy.js:600`, `:1298`, `:1304`, `:1338` | every FSM transition is gated on `ctx.player` existing |

`ctx.player` on a host is the host's own survivor (`Player.init` skips claiming
it when `local` is false, `Coop.js:40-44`). **A pawn is never `ctx.player`.**

And `src/net/Coop.js:41-43` says, in a comment:

> `init` is the whole of Player's construction — it registers with Combat
> **(so enemies target this player and it can be hurt)**

The first half of that parenthesis is false and has been for as long as pawns
have existed.

## 2.2 The arm: same enemies, same spot, only which player stands there changes

`n1b.json`, one session, four phases. The only harness acts are spawning the
pack and moving the two players; **no phase deals damage**. Every enemy is given
`1e7` health so nothing dies and nothing stops attacking.

| phase | who stands in the pack | who is 150 m away | enemy hits on **host** | enemy hits on **pawn** |
|---|---|---|---|---|
| **A** | the **pawn** | the host | 0 | **0** |
| **B** | the **host** | the pawn | **80** | **0** |
| **C** | both, 1.2 m apart | — | 50 | **0** |
| **D** | both, pawn pushed toward the shooters | — | 50 | **0** |

Phase B is the positive control and it is emphatic: six attack channels landed
on the host — `melee:beetle`, `melee:lemurian`, `melee:mite`,
`projectile:spitling`, `projectile:lemurian`, `projectile:wisp`. The same pack,
in the same spot, with a pawn standing there instead, produced **nothing**.

The per-enemy telemetry in phase A is the finding in one row. Sampled while the
pawn is the only player in the arena:

| enemy | fsm state | dist to **host** | dist to **pawn** | `distToPlayer` field | `target` == host pos | `target` == pawn pos |
|---|---|---|---|---|---|---|
| lemurian | `chase` | 141.5 | **19.6** | **141.5** | `true` | `false` |
| lemurian | `chase` | 141.4 | **21.2** | **141.6** | `true` | `false` |
| beetle | `chase` | 132.8 | **21.9** | **132.9** | `true` | `false` |
| wisp | `reposition` | 136.6 | **15.0** | **136.7** | `true` | `false` |
| spitling | `reposition` | 141.2 | **6.3** | **141.2** | `true` | `false` |
| wisp | `reposition` | 135.6 | **19.1** | **135.6** | `true` | `false` |

Six live enemies, one of them **6.3 m** from a player, all six chasing a target
141 m away. `targetIsPawnPos` is `false` in every sample of every phase of every
session.

**Corroborated independently** by the passive observer on the `fixed` main arm,
which ran a whole three-player session end to end: host `enemyDamageToPawn` = **0**,
`enemyDamageToLocal` = **16**.

## 2.3 "Functionally invulnerable" is wrong, and here is the counter-example

`n1e.json`. The pawn is parked 3 m from the host; the pack includes a mortar
(splash shell) and an **Overloading** elite (`deathBlast: 3, blastRadius: 7`).

**E1 — 30 s, host topped up every 500 ms so nothing is measured against a corpse:**

| | host | pawn |
|---|---|---|
| enemy hits | **78** | **0** |
| channels | `projectile:lemurian`, `melee:lemurian`, `projectile:wisp`, `projectile:mortar`, `melee:beetle`, `melee:mite` | — |
| alive at end | `true` | `true` |
| separation | 3.0 m | |

**E2 — the host kills the Overloading elite 1.5 m from the pawn.** The kill is a
player act; the death blast that follows is the *enemy's*, routed through
`combat.explode`'s team query and not through `ctx.player`:

| on the **pawn**, from the elite's own death | value |
|---|---|
| `blast:lemurian` | **66.0** |
| `shock:lemurian` ×5 | **4.2** each |
| pawn health | 170 → **102.03** |
| the **client's own** health, same instant | **102.03** |
| the **client's own** `progression.stats.damageTaken` | **67.96** |

**E3 — the capability probe (harness-driven, and labelled):**

| | |
|---|---|
| `combat.sphereOverlap(pawnPos, 3, 'enemy')` | 3 hits, **includes the pawn** |
| `pawn.team` / `player.team` / `enemy.team` | `player` / `player` / `monster` |
| `combat.explode(pawnPos, 6, 40, enemy)` | pawn 102.03 → **70.78** |

`Projectile.js:200` and `:239` filter the same way (`e.team === p.owner.team`),
so an enemy projectile with splash, a mortar shell, an Overloading death blast
and every `spawnBlast` affix nova (`Enemy.js:378, 423, 425, 907, 968, 1141`) can
all reach a pawn.

**So the correct statement of N-1 is:** *no enemy ever selects, pursues,
line-of-sight-tests or aims at a pawn; every directed attack in the game
(melee, charge, pull, beam, aura, single-target projectile) is unreachable for a
joining player; but area effects are spatial and do reach them.* A joiner is not
invulnerable. A joiner is **never fought**, and takes only the splash of a fight
that is entirely about somebody else.

## 2.4 What N-1 does and does not invalidate

Round 3 states that "every measurement of a client taking damage in rounds 1, 2
and 3 — including all of F-10, K-5 and L-3 — was driven by a harness call, not
by the game." **The premise is true; the implication is not, and E2 is the
proof.** In E2 the damage originated in `Enemy`'s own death handler with no
harness call anywhere in the chain, and it produced:

| observable | value | which finding it belongs to |
|---|---|---|
| `NetHost._forwardHurt` fired for the owning peer only | client `damageTaken` **67.96**, host's own unchanged | **F-10, K-5** |
| the client's own health tracked the authority | **102.03** on both ends | **K-1** |
| the client's barrier read the authority's | `shield 0` on both ends | **L-3** |
| the client's own death silenced only its own soundtrack | §8.2 | **M1** |

None of those code paths reads the damage *source*. They read `e.target`,
`healthFrac`, `shieldFrac` and `victim.netId`. **K-1, K-5, F-10, L-3 and M1
survive N-1 in full.** What N-1 does invalidate is any claim about how *often*
or *how much* a client is hurt in a real game — round 1's F-10 rationale
("every `onDamaged` card is dead for that player") is materially understated,
because in practice those cards almost never fire at all.

**Cost to close, corrected.** Round 3's costing ("a player list on `ctx`,
nearest-player targeting, `hurtPlayer`/`statusPlayer` routed to the enemy's
target") is the right shape and it is incomplete. It also has to cover
`checkLOS` (`Enemy.js:499`), the elite aura radius tests (`:471`, `:486`), the
four FSM transitions that read `ctx.player` (`:600`, `:1298`, `:1304`, `:1338`),
the projectile homing seed (`Enemy.js:1108-1121`, `:1542`) and the aggro
stickiness nobody has designed yet — an enemy that re-picks "nearest" every tick
between two players 2 m apart will oscillate. And a nearest-player query per
enemy per tick is in the AI hot path with the population cap in the dozens.
**It is a feature, not a fix**, and it needs its own round.

---

# 3. L-2, MAJOR — a client's survivor crosses the wire. CONFIRMED

## 3.1 Both ends, three survivors

`fixed.json → L2` against `preL2.json → L2`:

| | `preL2` (`L2-hello` reverted) | `fixed` |
|---|---|---|
| host's own survivor | `ranger` 110 / 7.0 / 12 | `ranger` 110 / 7.0 / 12 |
| host's pawn for client0 | **`ranger` 110 / 7.0 / 12** | **`anvil` 170 / 6.5 / 15** |
| host's pawn for client1 | *(1-peer arm)* | **`kestrel` 90 / 7.4 / 17** |
| client0's own survivor | `anvil` 170 / 6.5 / 15 | `anvil` 170 / 6.5 / 15 |
| client1's own survivor | *(1-peer arm)* | `kestrel` 90 / 7.4 / 17 |

Two peers, two different survivors, two correctly re-stated pawns. The fix is
not "the host copies one id".

## 3.2 The gap that never converges

Host deals 40 to client0's pawn, both ends sampled back to back eight times over
two seconds:

| sample | `preL2` host pawn | `preL2` client's own | gap | `fixed` host pawn | `fixed` client's own | gap |
|---|---|---|---|---|---|---|
| 1 | 76.67 | 170.00 | 93.33 | 136.67 | 170.00 | 33.33 |
| 2 | 76.67 | **118.49** | **41.82** | 136.67 | 136.67 | **0.00** |
| 4 | 76.67 | **118.49** | **41.82** | 136.67 | 136.67 | **0.00** |
| 6 | 76.80 | **118.66** | **41.86** | 136.89 | 136.92 | **0.03** |
| 8 | 77.33 | **119.51** | **42.18** | 137.69 | 137.63 | **0.06** |

Both ends. On `preL2` the gap **widens** (41.82 → 42.18) because the two ends
regenerate against different maxima; it never converges, and this reproduces
round 2's 38.68 and round 3's 41.82 → 42.33 in shape, direction and magnitude.
On `fixed` the worst disagreement after the first snapshot is **0.09** and three
of the eight are exact.

Sample 1 is one snapshot interval of lag on both trees and is not a finding;
`hostDamagesPawn` is the fixture check that stops a zero reading looking like a
pass: `{dealt: 33.33, healthBefore: 170, healthAfter: 136.67, maxHealth: 170}`
on `fixed` against `{dealt: 33.33, healthBefore: 110, healthAfter: 76.67,
maxHealth: 110}` on `preL2`. The `maxHealth` column is the finding.

## 3.3 The wire change at the trust boundary — where it is not clean

L-2 is the largest-surface change of the three rounds and it is the first time
the host decodes a **variable-length, peer-controlled** field. `proto.json`:

| probe | what the client sent | the host's pawn afterwards | host page errors |
|---|---|---|---|
| baseline | the real HELLO | `anvil` 170 / 170 | — |
| **H1** | `survivorId: "not-a-survivor"` | **`ranger` 110 / 110** | none |
| **H2** | a bare `MSG.HELLO`, no body | `ranger` 110 / 110 (unchanged) | none |
| **H3** | length prefix `200`, zero bytes of string | unchanged | **`Invalid typed array length: 200`** |
| **H4** | `kestrel`, `anvil`, `kestrel`, `anvil` on a pawn at 35/110 | **90/90 → 170/170 → 90/90 → 170/170** | none |
| **H5** | `version: 99` | `anvil` 170 / 170 | none |

Three findings fall out of that table and each gets its own section: **N-5**
(H1), **N-6** (H3), **N-4** (H4). H5 is **N-3**, measured (§10.3).

What *is* clean, and worth saying because it is the obvious worry: `_sendHello()`
is called in the same synchronous block as `peer.onMessage = …`
(`NetClient.js:74-79`), with no `await` between them, so it cannot open a window
in which an inbound WELCOME is dropped. The bare-HELLO path (H2) degrades
exactly as documented. And `PROTOCOL_VERSION` was correctly bumped with a
truthful compatibility statement.

---

# 4. N-4, MAJOR — HELLO is an unauthenticated, unlimited pawn reset

`NetHost.js:150-165` handles `MSG.HELLO` with no once-guard, no rate limit and
no state check:

```js
const hello = readHello(r, {});
if (c.pawn && hello.survivorId) {
  c.survivorId = hello.survivorId;
  c.pawn.setSurvivor?.(hello.survivorId);
}
```

`Player.setSurvivor` early-returns only when the card is *the same one*
(`Player.js:334`). Otherwise it runs `_applyCard`, and `_applyCard` sets
`this.health = this.base.maxHealth` (`Player.js:306`) — a **full heal** — and
clears `_buffs`, `placeables` and `projectiles`, and rebuilds the rig.

Round 3's §2.1 justifies this: *"on a pawn that is one tick old its destructive
half … is all no-ops."* **Nothing enforces that the pawn is one tick old.**
Measured, `proto.json → H4`: the pawn was hit for 90 and sat at **35/110**, and
four HELLOs later:

| sent | pawn afterwards |
|---|---|
| `kestrel` | **90 / 90** — full |
| `anvil` | **170 / 170** — full |
| `kestrel` | **90 / 90** — full |
| `anvil` | **170 / 170** — full |

A peer can restore its own pawn to full health, on demand, as often as it likes,
by sending five bytes. On the one machine that is supposed to own that number.
It also swaps the survivor — stats, skills, mesh — mid-run, and because the
client's own `ctx.player` is untouched (`clientOwn` stayed `anvil` 170
throughout), a peer can put its prediction and the authority on **different
survivors at will**, which is L-2's original divergence turned into a switch.

The stock client sends exactly one HELLO, so this is not reachable by accident
today. It is reachable by a text editor.

**Cost to close: three lines.** Latch it — `if (c.helloSeen) return;
c.helloSeen = true;` — and, because a re-stat on a live pawn is never wanted,
gate the `setSurvivor` on the pawn's age (`c.pawn._localTick < N`). The latch
alone removes the whole finding.

---

# 5. N-5, MODERATE — an unknown survivor id silently re-stats the pawn to the default

`proto.json → H1`. The client sends `survivorId: "not-a-survivor"`. The host
calls `setSurvivor` with it, `getSurvivor` falls through to the default
(`survivors.js:240-242`), and the pawn becomes **`ranger`, maxHealth 110**.

Round 3 presents this as a safety property — *"an unknown id resolves to the
default survivor, so a malformed HELLO cannot throw out of the pawn."* It cannot
throw, which is true and worth having. But the state it lands in is **exactly
the defect L-2 exists to fix**: a client playing `anvil` at 170 is simulated as
`ranger` at 110, and its health bar reads a fraction of 110 mapped onto 170 —
the 38.68-point gap of §3.2, silently, with no error anywhere.

And the trigger does not require malice. It requires a survivor id the *host's*
build does not know: a peer on a newer build, a modded roster, a renamed card.
That is the same class of pairing N-3 refuses to detect, which is why the two
compound.

**Cost: one line.** `if (!SURVIVOR_BY_ID.has(id)) return;` before the
`setSurvivor` call — leave the pawn on the host's survivor and let the existing
mismatch be visible, rather than laundering an unknown id into a silent
downgrade. Better still, refuse the peer.

---

# 6. N-6, MODERATE — a truncated HELLO throws uncaught on the host

`Protocol.js:240-241`:

```js
out.version    = r.remaining >= 2 ? r.u16() : 0;
out.survivorId = r.remaining >= 2 ? r.str() : '';
```

with the comment *"Read defensively … a peer that sends a bare HELLO must not
throw out of the message that identifies it."* The bare case is covered. The
**truncated** case is not: `r.remaining >= 2` is satisfied by the two bytes of
the string's own length prefix, and `Reader.str` then does

```js
const n = this.u16();
new Uint8Array(this.buf, this.off, n)   // RangeError when n overruns the buffer
```

`proto.json → H3` sends a five-byte HELLO whose length prefix claims 200 bytes.
The host page records an uncaught **`Invalid typed array length: 200`**.
`NetHost._onMessage` is wired straight into `ch.onmessage`
(`Transport.js:44`) with **no try/catch anywhere on the path**.

The host survives — `clients.size` stays 1, `net.tick` runs 440 → 483 — so this
is a robustness defect, not a kill. But it is the first place in `src/net/` where
the host decodes a peer-controlled length, L-2 put it there, and the comment
above it claims the opposite of what happens.

**Cost: two lines.** Bound the read (`if (r.remaining < 2 + peek) return out;`)
or, better, wrap `_onMessage`'s body in a try/catch that drops the message and
logs — which the client half needs too, since `readEntity` and `r.json()` have
the same shape.

---

# 7. L-1, MAJOR — the host's death no longer freezes the authority. CONFIRMED, and the design holds

## 7.1 Both ends, and the release

`fixed.json` / `preL1.json`. The host dies with client0 alive; client0's
snapshot clock, four samples 500 ms apart before and eight over four seconds
after:

| | `preL1` | `fixed` |
|---|---|---|
| four samples **before** the host's death | 621 → 652 → 684 → 712 | 774 → 802 → 832 → 862 |
| eight samples **after**, over four seconds | **742 ×8** | **908 → 939 → 969 → 1002 → 1032 → 1062 → 1094 → 1124** |
| host `ctx.paused` across those eight | **`true` ×8** | **`false` ×8** |
| host `input.enabled` | `true` | **`false`** |
| host `_holding` | `false` | **`true`** |
| client `connected` | `true` | `true` |

`preL1` reproduces the frozen clock exactly — it does not degrade, it stops. On
`fixed` the client gains **216 ticks in four seconds** with the host dead.

Then client0 is killed authoritatively **with the host already dead**:

| on **client0** | `preL1` | `fixed` |
|---|---|---|
| `player.alive` | **`true`** | **`false`** |
| `player.health` | **212.26** | **0** |
| `menus.screen` | `"death"` | `"death"` |
| `progression._ended` | `true` | `true` |
| `audio.playerDead` calls | 1 | 1 |

`preL1` is the "died but not dead" split. On `fixed` the client dies properly
with the host gone.

**The release is real and it is not a one-way door.** `hostReleased` reads
`{paused: true, screen: "death", inputEnabled: true, _holding: false,
hasLivePeer: false}` on **every** arm, fixed and sabotaged alike.

## 7.2 The pause overlay, measured with the world running

`proto.json → P1`. The host opens its pause menu while the peer is alive:

| | value |
|---|---|
| client `serverTick`, three samples before | 1254 → 1286 → 1316 |
| five samples **while the pause menu is open** | **1361 → 1394 → 1424 → 1450 → 1482** |
| host `ctx.paused` across those five | **`false` ×5** |
| host `input.enabled` across those five | **`false` ×5** |
| host `_holding` / `hasLivePeer` | `true` / `true` ×5 |
| three samples **after the menu closes** | 1548 → 1578 → 1609 |
| host `paused` / `input.enabled` / `screen` after | `false` / **`true`** / `null` |

Both ends of the release, in both directions. The overlay works exactly as
designed.

**The consequence I could not measure and will not pretend to.** The world is
provably running (166 client ticks inside 2.5 s of pause) and the host's input is
provably off, and §2 proves every enemy in the arena is targeting precisely that
survivor. The pack I spawned did not land a hit inside the window, so *"a host
can be killed while reading its own pause menu"* is **one inference from the
data, not a measurement**. It is the inference I would act on.

## 7.3 The design decision, judged

Round 3's rule — *a death ends exactly one run, the dead player's; an authority
never stops the simulation while a peer is still playing* — is **coherent with
K-2 and is the right call.** The alternative (the host's death ends the session)
is K-2 with extra steps, and "the teammate happened to be the host" is not a
distinction a player experiences. Implementing it in `NetHost` rather than
`Menus` is right for the same reason: it is a fact about the network role.

Three cases the report does not work through, which I did:

- **Three peers, simultaneous and staggered deaths — measured, and it holds.**
  `fixed.json` with two clients: pawn1 dies first with the host and pawn0 alive
  → host `screen null`, `_ended null`, `director true`, `hasLivePeer true`;
  client1 gets its own death screen; client0 untouched. Then the host dies →
  hold engages with one live peer. Then pawn0 dies → hold releases. Every step
  correct, and this is the arm round 3's §12.1 names as never driven.
- **`_holdSession` fires on *any* truthy `menus.screen`**, and that set is
  `title, select, difficulty, artifacts, edict, pause, settings, coop, death`
  (`Menus.js:143-363`). A host that dies and presses Quit lands on `title`
  (`Menus.js:1036`) and keeps hosting a running world from behind the title
  screen with its input muted. That is arguably the intended reading of "the
  host watches", but nobody designed it and nobody has looked at it.
- **The grace opens a window of its own — see N-8.**

---

# 8. N-8, MODERATE — `HOLD_GRACE` closes its defect and opens a 1.68-second one

## 8.1 The defect it closes is genuinely closed

Round 3 reports finding a defect in its own L-1 fix: pausing in the same frame as
the last peer's death discarded that peer's death snapshot, because
`SnapshotBuffer.ingest` (`Snapshot.js:40`) drops anything not newer than the last
tick and `this.tick` only advances in `fixedUpdate`. I re-derived the mechanism at
source and it is exactly right.

**Closed, in seventeen arms.** Across every co-op session I ran, the client whose
pawn is killed last — after the host is already dead, which is the exact frame
ordering the defect needs — reads `player.alive` on its own death screen as:

| arms | `client0.alive` on its own death screen | `client0.health` |
|---|---|---|
| `fixed`, `preL2`, `preL3`, `preL4`, `preL5`, `preVictim`, `preK2`, `preK3full`, `preEBfull`, `preK5`, `preK10`, `preF6full`, `preF9`, `preF10`, `preM1` — **15 arms** | **`false`** | **0** |
| `preL1` (`L1-hold` reverted) | `true` | 212.26 |
| `preK1` (`K1-all` reverted) | `true` | 189.45 |

The only two arms that read `true` are the two where the reverted fix *is* the
thing that makes it false. **No arm of mine reproduced the pre-grace split**, and
round 3's §4.3 is the reason it does not exist: at 20 Hz, 1.5 s is about thirty
snapshot intervals of margin for a message that needs one.

## 8.2 The window it opens, measured

`proto.json → P2`. The host's pause menu is open with a live peer (so the hold is
engaged and input is muted); the peer then dies. Sampled every 200 ms:

| ms since the peer's death | host `paused` | host `input.enabled` | `_holding` | `hasLivePeer` |
|---|---|---|---|---|
| 5 | `false` | **`false`** | `true` | `false` |
| 427 | `false` | **`false`** | `true` | `false` |
| 837 | `false` | **`false`** | `true` | `false` |
| 1269 | `false` | **`false`** | `true` | `false` |
| 1473 | `false` | **`false`** | `true` | `false` |
| **1681** | **`true`** | **`true`** | `false` | `false` |

**1.68 seconds** — `HOLD_GRACE` plus a frame — in which a live host that has
chosen to stop playing is simulated in the arena, targeted by every enemy
(§2), and unable to move, dodge or shoot. `hold` is computed from
`now - _lastLivePeer < HOLD_GRACE` and never asks whether *this* machine's
survivor still needs to act.

The grace is right; its scope is not. It exists so the **peer** gets one more
snapshot; it should not also keep muting the **host**. **Cost: one line** —
compute the release for `ctx.paused` and for `input.enabled` from different
predicates, or drop `input.enabled = false` once `hasLivePeer()` goes false:

```js
if (ctx.input) ctx.input.enabled = !this.hasLivePeer() ? true : false;
```

The same 1.68 s applies when the last peer *disconnects* rather than dies, and
there it buys nothing at all: the snapshot has nowhere to go.

---

# 9. L-3, L-4, L-5 and the prior rounds

## 9.1 L-3, MODERATE — the client's barrier is the host's barrier. CONFIRMED

`preL3.json` / `fixed.json`, same 40-damage hit on the same pawn, eight paired
samples:

| sample | `preL3` client's own `shield` | `preL3` host's copy | `fixed` client's own `shield` | `fixed` host's copy |
|---|---|---|---|---|
| 1 | 30.00 | **0.00** | 30.00 | **0.00** |
| 2 | **28.16** | **0.00** | **0.00** | **0.00** |
| 4 | **23.63** | **0.00** | **0.00** | **0.00** |
| 8 | **14.70** | **0.00** | **0.00** | **0.00** |

Both ends. `preL3` reproduces round 2's 28.02 → 12.43 and round 3's 28.44 →
12.58 almost exactly (28.16 → 14.70), and the host's copy holds `0.00`
throughout in both columns. Sample 1 is one snapshot of lag on both trees.

The dependency round 3 names is confirmed: `preK1` (which reverts
`_applyAuthoritativeHealth` whole) reads the client's shield decaying 30.00 →
14.56 — the `preL3` shape, not the `fixed` zero.

## 9.2 N-9, MODERATE — the same three lines kill a client's `onDamaged` **heals**, and a comment says otherwise

Round 3 states the barrier half. It does not state that the identical mechanism
takes the heals, and it leaves standing a comment that claims the opposite.
`Items.js:205-215`, added by round 2's fix and untouched by round 3:

> The hooks that deal damage no-op on a non-authority exactly as the rest of a
> client's combat does; **the ones that grant barriers, buffs and heals are the
> point.**

Barriers are zeroed by `shieldFrac` and heals are overwritten by `healthFrac`,
both at 20 Hz, both in `_applyAuthoritativeHealth`. Only buffs survive.

Measured, `proto.json → HEAL`. Both machines hold Sunken Vertebra (30 barrier on
being hurt) **and** Grafted Polyp (`items.js:1573`, heal 15 on being hurt):

| after one 40-damage hit | the **client's own** view | the host's copy of the same pawn |
|---|---|---|
| immediately | health 170.00, **shield 30.00** | health 138.75, shield 0.00 |
| +300 ms | health **138.75**, **shield 0.00** | health 138.75, shield 0.00 |
| +1.5 s | health 139.34, shield 0.00 | health 139.40, shield 0.00 |
| **host control**, same two cards, the host's own survivor | — | health 110 → 93.75, **shield 29.86 held** |

The client computes its barrier and its heal, displays them for less than one
snapshot, and has both erased by the authority. The host keeps its barrier.
That is K-4's family and deferring it is still correct — but the comment is now
false, and "visibly inert rather than invisibly so" (round 3 §3) is only half the
story.

## 9.3 L-4, MODERATE — a run summary credits its own kills. CONFIRMED, three ways

`preL4.json` / `fixed.json`, both with two clients. Four enemies killed by the
host's own player, then one killed with client0's pawn as the source:

| | `preL4` | `fixed` |
|---|---|---|
| host kills 4 → host `progression` / `HUD` | 4 / 4 | 4 / 4 |
| → **client0** `progression` / `HUD` | **4 / 4** | **0 / 0** |
| → **client1** `progression` / `HUD` | **4 / 4** | **0 / 0** |
| then **client0's pawn** kills 1 → host | **5 / 5** | **4 / 4** |
| → client0 | **5 / 5** | **1 / 1** |
| → client1 | **5 / 5** | **0 / 0** |
| every client's `damageDealt`, throughout | 0 | 0 |

Both ends, three ways, and the second half is the arm nobody ran in three
rounds: a client's own kill is credited to that client and to nobody else. On
`preL4` **both** clients' summaries claim every kill the party made while dealing
no damage, and the host double-counts a teammate's.

The interaction round 3 names is confirmed and is why the downstream counter
exists: `HUD.stats.kills` on a client reads `0` whichever way K-3 goes.

**But L-4's HUD half is a regression — see N-7.**

## 9.4 N-7, MAJOR — L-4 widens the HUD kill guard, in single-player

This is the row round 3's single-player control does not have, and it refutes its
§8 headline.

`HUD.js:168` at HEAD `a43cc70` (recovered with `git show`):

```js
if (!e?.source || e.source === ctx.player || e.source?.isPlayer) {
```

`HUD.js:173` on round 3's tree:

```js
if (isLocalKill(ctx, e)) {
```

They are not the same guard. For a kill whose source is an **enemy**, HEAD's
condition is `false` (source is truthy, is not `ctx.player`, is not `isPlayer`),
while `isLocalKill`'s authority branch returns `!(false && …)` = **`true`**.
`Progression`'s counter is protected from the player-victim case by its own
`if (e.victim?.isPlayer) return;` (`Progression.js:126`). **The HUD has no such
guard.**

Isolated in single-player with `L4-hud-head`, which restores exactly HEAD's line
and nothing else (`sp-preL4hudHEAD.json` against `sp-fixed.json`):

| single-player event | HEAD's HUD condition | round 3's tree |
|---|---|---|
| four kills by the player | `progression` 4 / **HUD 4** | `progression` 4 / **HUD 4** |
| **an enemy kills an enemy** | `progression` 5 / **HUD 4** | `progression` 5 / **HUD 5** |
| **the player's own death** (enemy source) | `progression` 5 / **HUD 4** | `progression` 5 / **HUD 6** |

Both ends. On round 3's tree the on-screen kill counter gains one for every
enemy-on-enemy kill (a Blazing aura, an Overloading death blast, a mortar shell
— routine in a horde) and one for **your own death**, each with a
`pulse(reticle, 'is-kill')` hit-confirm flash. In co-op it is worse and I have it
in the main arm: on the `fixed` three-player session the host's `HUD.stats.kills`
ran **4 → 5 → 6 → 7** across pawn1's death, its own death and pawn0's death while
`progression.stats.kills` stayed at **4**. A teammate dying flashes a kill
confirm on your reticle.

Round 3's §8 says *"`isLocalKill` does not suppress a single-player kill …
so it is the authority branch carrying single-player, and it is measured, not
assumed."* It measured the branch not suppressing. It never measured the branch
*admitting*, because its only single-player kills had `source === ctx.player`.

**Cost: one clause.** `if (!e?.victim?.isPlayer && isLocalKill(ctx, e))`, which
is the guard `Progression` already carries, plus restoring the non-player-source
exclusion if that was intended: `isLocalKill` was written for the run summary and
the HUD needed a narrower rule than the one it was handed.

## 9.5 L-5, MODERATE — the victim predicate fails closed on a client. CONFIRMED

Isolated with `R1-victim`, the only way to make a victimless payload cross the
wire without inventing one. `preL5` and `preVictim` differ by `L5-open` alone:

| | `preL5` (`R1-victim` + the old permissive predicate) | `preVictim` (`R1-victim`, fail-closed in place) |
|---|---|---|
| **client0's run after a *teammate* (pawn1) dies** | **`screen "death"`, `_ended true`, `paused true`** | **`screen null`, `_ended null`, `paused false`** |
| client0's own player at that moment | `alive true`, health 200.47 | `alive true`, health 200.44 |
| client1's own run after **its own** pawn dies | `screen "death"`, `_ended true` | **`screen null`, `_ended null`** |
| the **host's** run after a pawn dies | `screen "death"`, `_ended true`, `director false` | `screen "death"`, `_ended true`, `director false` |

Both ends, and the first row is the finding: with the permissive predicate one
missing field takes an uninvolved client's whole run with a teammate's death,
silently. The last row is the control that the change is client-only — the host
behaves identically in both columns, and identically to round 2's `preVictim`.

Round 3's stated cost is real and is in row 3: failing closed means that in the
same already-broken no-victim case, a client's own death no longer ends its own
run. That is the better half of a bad pair and I agree with the trade.

## 9.6 The eight prior fixes round 3 re-ran — all still hold

Each with its gate failed on purpose, on round 3's tree, in my own sessions.

**K-1** (`preK1` / `fixed`), on the client:

| | `preK1` | `fixed` |
|---|---|---|
| own health, samples 1 / 4 / 8 | **170 / 170 / 170** (flat) | 136.67 / 136.67 / 137.63 |
| host's copy of the same pawn | 138.75 / 138.75 / 139.91 | 136.67 / 136.67 / 137.69 |
| after the host kills the pawn: `alive` / `health` | **`true` / 189.45** | **`false` / 0** |

**K-2** (`preK2` / `fixed`), three players:

| | `preK2` | `fixed` |
|---|---|---|
| **host** after pawn1 dies: `screen` / `_ended` / `director` | **`"death"` / `true` / `false`** | **`null` / `null` / `true`** |
| **client0** after pawn1 dies | **`"death"` / `true`** | **`null` / `null`** |
| **client0** after the host dies | **`"death"` / `true`** | **`null` / `null`** |
| **client0** after its **own** death | `"death"` / `true` / `alive false` | `"death"` / `true` / `alive false` |

**K-3 and the `EventBus` isolation** — reverting both halves together, then
adding the isolation revert, on the client:

| | `preK3full` | `preEBfull` | `fixed` |
|---|---|---|---|
| wire form of `position`, read upstream of every listener | **`array`** | **`array`** | **`object`** |
| `Number.isFinite(position.x)` | **`false`** | **`false`** | **`true`** |
| `Audio.death` calls / **throws** | 7 / **7** | 7 / **7** | 8 / **0** |
| `kill` reaching a listener registered *after* `Audio` | **7 of 7** | **0 of 7** | **8 of 8** |
| client `[events] listener threw` console errors | **7** | **0** | **0** |
| client uncaught page errors | **0** | **7** | **0** |

The isolation pair differs by `EB-isolate` alone, the throws are identical, and
the dispatch outcome is opposite. That is round 2's §5.1 reproduced on round 3's
tree. **N-11**: the ratio is **1:1**, not round 3's 2:1 — see §10.4.

**K-5 and F-10**, on the client after the same real hit:

| | `preK5` | `preF10` | `fixed` |
|---|---|---|---|
| `progression.stats.damageTaken` | **0** | **0** | **33.33** |
| `items.timeSinceHurt()` | 2.07 | **1004.85** (sentinel) | 2.13 |
| `playerHurt` emits on the client | 1 | **0** | 1 |

Both ends, and K-5's total dependence on round 1's F-10 forward is re-confirmed.

**F-6** (`preF6full` / `fixed`), on the client:

| | `preF6full` | `fixed` |
|---|---|---|
| `_lastCmdTick` immediately before the join | 69 | 67 |
| `_lastCmdTick` at connect | **100** | **0** |
| `net.tick` at the same instant | **6** | **0** |
| `player._localTick` at connect | **100** | **0** |

`lastCmdTick === netTick` on the fixed tree: the epoch is re-based before the
first wire command. On `preF6full` the counter is 94 ticks ahead of the wire.

**F-9** (`preF9` / `fixed`), on the host, against a real enemy raised to `1e7`:

| | `preF9` | `fixed` |
|---|---|---|
| `peerDealt` (the pawn's hit landed) | 777 | 1554 (crit) |
| `damageDealt` delta from the **peer's** hit | **+777** | **+0** |
| `damageDealt` delta from the **local** 500 | +500 | **+500** |
| `targetAliveThroughout` / `usedRealEnemy` | `true` / `true` | `true` / `true` |

Both ends with the control on the same run. `highestHit` is disqualified (§1.5).

## 9.7 The four fixes round 3 declined to re-run — I ran three, and one was load-bearing

### M1 (round 1's audio identity test) — **CONFIRMED, and it matters**

Round 3's §7.6: *"I did not edit `Audio.js`. Its predicate is netId identity,
independent of `isLocalKill` and of `isLocalVictim`. Not re-run."* The premise is
true. The conclusion — that it therefore needs no gate — is the same reasoning
round 2 used and round 2's critique struck. `preM1.json` reverts the identity
read alone (`const victimNetId = p?.victim?.netId;` → `undefined`), on a
three-player session:

| | `preM1` | `fixed` |
|---|---|---|
| client1's **own** death → its `musicOff` / `Audio.playerDead` calls | **`false` / 0** | **`true` / 1** |
| client0's **own** death → its `musicOff` / `Audio.playerDead` calls | **`false` / 0** | **`true` / 1** |
| client0 during **client1's** death | `false` / 0 | `false` / 0 |
| client0 during the **host's** death | `false` / 0 | `false` / 0 |
| the client0 payload it read for its own death | `{victimIsSelf: true, victimNetId: 1}` | same |

Both ends, both directions, three-way. With the identity read gone the
`alive !== false` fallback fires on a client's **own** death — full soundtrack
over its own death screen, no sting — because the forwarded `playerDead` arrives
before K-1's snapshot clears `alive`. That is round 1's M1 defect, still live
under the fix, on round 3's tree. **Not re-running it was the wrong call**, and
the fix holds.

### F-7 (the jump-impulse gate) — **CONFIRMED in co-op**, see §9.8

### K-9 / K-10 — **K-10 confirmed to have no behavioural signature**

`preK10.json` reverts K-10's `null` branch. Every `playerDead` payload the
client saw still read `victimIsNull: false` with a real `netId`, so the arm
produced no divergence in either direction. This is **not a failed gate** and I
do not quote it as one; it agrees with round 2's critique that K-10 is a
payload-size change. Round 3's reasoning here was sound.

### F-11 — untouched, correctly, for the reason all four documents give.

## 9.8 F-7 in co-op — the only place its gate can fail

Round 3's §7.6 argues F-7 needs no co-op re-run because *"no round-3 edit is
upstream of the item hooks"*, and offers the single-player control as partial
cover. The single-player control cannot cover it: `e.local` is always `true`
there, so reverting the gate is a no-op — `sp-preF7.json` reads `[30, 30, 36]`
identically to `sp-fixed.json`, which is why I disqualified it in §1.5.

I built the co-op arm. The client jumps three times through real DOM key events
(`window.dispatchEvent(new KeyboardEvent(...))`, so no page needs focus and the
whole `Input` → `_sampleCommand` → `_jump` path runs); each press waits for
`grounded` first, so all three land. The host records what its copy of the pawn
launched with and what the **host's own** survivor was charged for a jump 3 m
away it did not make.

| | `f7-pregate` (round 1's gate reverted) | `f7-preimpulse` (the impulse re-wrapped in `this.local`) | `f7-fixed` |
|---|---|---|---|
| the **host's** copy of the pawn: impulses applied | **`[30, 30, 36]`** | **`[]`** | **`[30, 30, 30]`** |
| the **client's** own prediction | `[30, 30, 30]` | `[30, 30, 30]` | `[30, 30, 30]` |
| **do the two ends agree?** | **no** | **no** | **yes** |
| `jump` events seen on the host for the pawn | 3, `local: false` | **0** | 3, `local: false` |
| **the host's own** Rubber Soles barriers paid for it | **`[10, 10, 10]`** | `[]` | **`[]`** |
| **the host's own** Tectonic Heart quakes at its own feet | **1** (r 9, 52.5 damage) | 0 | **0** |
| the client's own Rubber Soles barriers (its own inventory, correctly) | `[10, 10, 10]` | `[10, 10, 10]` | `[10, 10, 10]` |
| all three presses reached from `grounded` | `[true, true, true]` | `[true, true, true]` | `[true, true, true]` |

**Both ends, twice, and two different failures.** `f7-pregate` reproduces round
2's critique's numbers exactly — the host launches the pawn at `36` on every
third jump while the client predicts `30`, which is 6 m/s of permanent
divergence, and the host pays three barriers and one 9-metre quake at its own
feet for somebody else's jump.

`f7-preimpulse` is the arm **nobody has ever run**, and it is round 3's own
change under test. Round 3 restructured `Player._jump` (`Player.js:698-746`),
moving the `this.local` gate off the impulse and onto the hooks, and states in a
comment that the previous revision *"removed the launch from the host's copy of a
remote pawn … Waxed Wing, Updraft Vents and Tectonic Heart were inert for every
non-host player."* That is a prose claim about a revision no longer in the tree.
Reverting to it measures **`pawnImpulses: []` and zero `jump` events on the host**
against a client predicting `[30, 30, 30]` — the client launches, the authority
does not, and reconciliation drags it back down. **Round 3's restructure is
load-bearing and correct**, and this is the gate it never had.

So: **F-7 holds in co-op**, round 3's decision not to re-run it was wrong for the
reason it gave (the single-player control cannot cover it), and right in outcome.

---

# 10. The record, and round 3's own new findings

## 10.1 L-7 does not exist — CONFIRMED

`round2-critique-coop.md` contains the string `L-7` **exactly once**, at line 69,
inside the severity table: `| MINOR | 4 | L-6, L-7, L-8, L-9 |`. There is no
section, paragraph, table row or ledger entry for it anywhere in the document,
and it appears nowhere in `round2-fix-coop.md` either. One of the four MINORs in
that round's headline count has no content behind it. Round 3 is right to name
it and right that it could not have closed it.

**Round 2's critique's true count is 8 findings, not 9**, and its severity table
should read `MINOR | 3 | L-6, L-8, L-9`.

## 10.2 L-6, L-8, L-9 — the corrections

**L-6 (six record items).** All six are correctly restated as a banner at the
head of `round2-fix-coop.md` (lines 3-26), each with the artefact that
contradicts the original, plus the process finding round 2 omitted. I checked
each against the source it cites. **Applied.**

**N-10, MINOR — except item 6, which is recorded but not fixed.** L-6 item 6 is
that the banner round 2 added to `round1-fix-coop.md` points at
"`round2-fix-coop.md` §8" when the corrections are its §10. The round-2 banner
now *says* that. `round1-fix-coop.md:3` still reads:

> **CORRECTIONS (round 2, `reviews/round7/coop/round2-fix-coop.md` §8).**

A reader following the pointer still lands in the wrong section. Recording a bad
cross-reference in a different document is not fixing it. **Cost: one word.**

**L-8.** Round 3 keeps the `sinceDamage = 0` reset and rewrites the comment to
state the measured effect rather than a corrective one. I read the new comment
(`NetClient.js:283-292`) and it is honest: it says plainly that reverting the
line alone moved the worst disagreement from 0.04 to 0.06, that at zero lag the
20 Hz overwrite dominates, and that nobody has run it under real RTT. Round 3
did not re-measure `preK1regen` and says so. I did not either. **Correctly
handled.**

**L-9.** The costing correction is right and I verified it: exactly three cards
call `Items.tally` — `frost-lattice`, `resonance-coil`, `tectonic-heart` — and
an optional `owner` parameter defaulting to the local survivor is backward
compatible. Three call sites and one method. **Correct.**

## 10.3 N-3 — no `PROTOCOL_VERSION` check, measured at both ends

Round 3 files this from a source read. It is worse than stated, and it is now
measured. `proto.json → H5`: the client declares `version: 99` in its HELLO.

| | reading |
|---|---|
| what the host stored about the peer's version | `{survivorId: "anvil", version: null, hasVersionField: false}` |
| what the client stored about the host's version | `null`; no key on `NetClient` matching `/ver/i` |
| host page errors | none |
| the pawn afterwards | `anvil` 170 — accepted in full |

**Neither side keeps the other's version, let alone compares it.** `readHello`
parses `out.version` into a local that is read exactly nowhere, and
`NetClient.js:102` reads WELCOME's version into a discard.

Round 3 is right that this was already true at version 2 and that round 3 does
not make it worse *by itself*. It is wrong that it is unchanged in importance:
the entity record grew by two bytes, so a 2.x reader now **mis-frames every
entity after the first** rather than degrading, and **N-5** means a version-skewed
survivor roster silently downgrades a peer to the default survivor instead of
failing. The three compound into "a mixed-version pairing produces a garbled,
silently mis-statted session with no error." **Cost, corrected upward:** one
comparison in the HELLO branch, one in `MSG.WELCOME`, a refusal path, **and**
N-5's catalogue check.

## 10.4 N-11, MINOR — the 2× loudness reading is not reproducible

Round 3's §7.3 item 3 records "eight messages for four throws", 2× the
`Audio.death` throws in both columns, and speculates (without claiming) that
`VFX._onKill → Vector3.copy` is a second thrower. On my tree the ratio is
**1:1**: `preK3full` records **7** `Audio.death` throws and **7**
`[events] listener threw` console messages, and `preEBfull` records 7 throws and
**7** uncaught page errors with 0 console messages. If `VFX._onKill` also threw
on an array position I would see fourteen. It does not. Round 3 correctly
declined to claim the second thrower; the count that prompted the speculation is
a fixture artefact and should not travel.

## 10.5 N-2 — level divergence, still unmeasured

Round 3 files this as "a single asymmetric reading, not a divergence" and does
not claim one. I did not run it either; my sessions are too short and every
agreement table I quote is taken inside seconds of one hit for exactly that
reason. **It remains the named arm nobody has run**, and the mechanism is sound:
`healthFrac × local maxHealth` is safe only while the two maxima agree, and
`Progression.level` is per-machine run state learned from a forwarded event.
**It is L-2's defect in a slower form and it is cheap to run.** Nobody should
enable co-op for long sessions without it.

---

# 11. Regressions — single-player, and the leg round 3 did not chase

`sp-fixed` (no substitutions) and `sp-pre` (all six of round 3's, i.e. the tree
as round 2 left it), both `netRole "single"`, `authority true`, both through the
real menu and both past the `_localTick > 60` gate. Same inventory, same
six-unit pack.

| | `sp-pre` (round 2's tree) | `sp-fixed` (round 3's) |
|---|---|---|
| enemies available → killed | 6 → 4 | 6 → 4 |
| `progression.stats.kills` after four player kills | **4** | **4** |
| `HUD.stats.kills` after four player kills | **4** | **4** |
| `Audio.death` calls / **throws** | 6 / **0** | 6 / **0** |
| `kill` reaching a downstream listener | **6** | **6** |
| `kill` payload `position` type / finite / `source === ctx.player` | `object` / `true` / `true` ×4 | `object` / `true` / `true` ×4 |
| 40-damage hit: `dealt` | **33.33** | **33.33** |
| **three sprint-jumps: impulses applied** | **`[30, 30, 36]`** | **`[30, 30, 36]`** |
| all three presses reached from `grounded` | `[true, true, true]` | `[true, true, true]` |
| own death: `alive` / `screen` / `_ended` | `false` / `death` / `true` | `false` / `death` / `true` |
| own death: `director.enabled` / `ctx.paused` / `musicOff` | `false` / `true` / `true` | `false` / `true` / `true` |
| `[events] listener threw` console errors | **0** | **0** |
| page errors | **0** | **0** |

**Tectonic Heart's every-third `36` is re-verified**, through real Playwright key
events, with all three presses landing from a grounded state on both trees.

## 11.1 The `onDamaged` barrier leg — chased, and it works

Round 3's §8 names one leg it could not cover: *"`shield` after the hit reads 0
on both trees, so the `onDamaged` barrier leg that round 2's critique measured at
23.58 is not exercised here … I did not chase it."*

I chased it. The cause is the fixture, not the build: Sunken Vertebra is on a 1 s
cooldown (`items.js:1594`) and the arena chips at the player continuously, so a
read taken any distance after the hit finds a barrier that was already spent and
has decayed. Give it 2.2 s of quiet, zero the shield, land one hit and read
immediately:

| | `sp-pre` | `sp-fixed` | `sp-preF7` |
|---|---|---|---|
| `shield` at the read before the hit | **14.87** | 0.00 | 0.00 |
| `dealt` (incoming, barrier included) | 33.33 | 33.33 | 33.33 |
| `shield` **immediately after** | **30.00** | **30.00** | **30.00** |
| at +120 ms | 29.28 | 29.40 | 29.52 |
| at +620 ms | 25.71 | 25.83 | 25.95 |
| health across the hit | 126.62 → 108.15 | 143.00 → 109.67 | 143.00 → 109.67 |

**The payout is 30.00 on all three trees and the decay curve is the same on all
three.** It is a control now, not an uncovered leg.

**One row here needs stating rather than smoothing.** I zero `shield` and wait
2.2 s before the hit, and on `sp-pre` that window was long enough for arena chip
damage to re-fire Sunken Vertebra: its pre-hit read is **14.87, not 0**. That
does not spoil the measurement — the arithmetic closes exactly (33.33 incoming,
14.87 eaten by the standing barrier, 18.46 to health, 126.62 → 108.15) and the
card's payout is the same 30.00 — but the "0 (forced)" I would have liked to
write is not what the file says, and this is the class of row that escapes into
a record. `sp-fixed` and `sp-preF7` both read a true 0.00 before the hit.

## 11.2 …and the row that refutes "single-player did not move"

Every row above is identical on both trees. **N-7 is not**, and it is a
single-player row: `sp-preL4hudHEAD` against `sp-fixed`, §9.4. An enemy-on-enemy
kill and the player's own death each add one to the on-screen kill counter on
round 3's tree and neither did at HEAD.

`sp-pre` does not catch it because my own first `L4-hud` substitution was not a
faithful revert (§1.5), and round 3's `sp-pre` does not catch it either — for the
different reason that its single-player arm has no enemy-on-enemy kill and reads
its counters before the death rather than after. **Round 3's §8 headline is
false as written.** The rest of §8 stands.

---

# 12. Arms I did not test

Naming them is not a claim that they are fine.

1. **Four peers.** Three is as far as I went. `maxPlayers` is 4.
2. **A peer leaving, and reconnect after `Lobby.leave()`.** Still not driven, in
   any of four documents. A host that presses Quit from the **pause** screen does
   `location.reload()` (`Menus.js:1035`) and every client gets `netDisconnected`
   and nothing else — **no run end, no summary, no record.** From the **death**
   screen Quit goes to `title` instead, and `_holdSession` then keeps hosting a
   running world from behind the title screen. Neither path is measured here.
3. **Real network conditions.** Loopback WebRTC on one machine. Every agreement
   figure, `HOLD_GRACE`'s 1.5 s and N-8's 1.68 s window are zero-lag numbers.
   Under real RTT the grace is closer to necessary and the muted window is
   longer.
4. **The correction rate under matched survivors** (round 3's §12.4). Still not
   counted.
5. **A client pulling its own trigger.** Every kill attributed to a pawn in every
   round is a harness call with the pawn as `source`. §9.8's jumps are the only
   thing a client has ever actually *done* across four documents.
6. **`isLocalKill` against a burn/DoT kill whose source has despawned.** Source
   reading says the authority branch keeps counting it; not driven. **And the
   mirror of it, which nobody has stated: a *pawn's* mine or sentry kill has a
   non-`isPlayer` source, so `isLocalKill` counts it for the host.** The host
   over-reports a client's placeable kills exactly where the client
   under-reports them. Source-derived, not measured.
7. **Level divergence over a session** (N-2). Not run, by anyone, in four
   documents.
8. **A stage transition in co-op.** No teleporter charged in any arm, in any
   round. `flawlessStages`, `syncStage` and the realm abort under L-5's predicate
   are all unexercised. Four rounds old.
9. **The 21-shot capture.** Not run: its default port is 5199 and the user is
   playtesting. The build is exit 0 and §11 covers the changed single-player
   paths.
10. **Whether any of it sounds right.** `musicOff`, a cue count and a throw count
    are not a cue. Seven rounds old.
11. **A truncated snapshot or a malformed EVENT on the *client* side.** N-6 is the
    host's half; `readEntity` and `r.json()` have the same unbounded shape and I
    only probed HELLO.
12. **N-1 with the fix in.** Obviously — but it means nobody knows what enemy
    aggro between two players feels like, and that is a design question, not a
    correctness one.

---

# 13. Claim ledger

| # | round 3's claim | verdict | my number |
|---|---|---|---|
| 1 | build exit 0 | **CONFIRMED** | exit 0, `✓ built in 1.03s`, all 16 files still modified, nothing staged |
| 2 | blocking running-game gate, both pages, every arm | **CONFIRMED** | `runningGate` in 28 sessions; and the post-join `_localTick` fact in §1.2 |
| 3 | second gate after focus, `{paused:false, screen:null}` both pages | **CONFIRMED** | `runningGateAfterFocus`, every arm |
| 4 | `substitutionsMissing` empty in every run | **CONFIRMED** | `[]` in all 28 of mine |
| 5 | **L-2** the client's survivor now crosses the wire | **CONFIRMED**, and with two peers at once | pawns `anvil` 170/6.5/15 and `kestrel` 90/7.4/17 on a `ranger` host |
| 6 | L-2: `preL2` gap widens and never converges | **CONFIRMED** | 41.82 → 42.18 over eight samples; `fixed` worst 0.09 |
| 7 | L-2: an unknown id cannot throw out of the pawn | **CONFIRMED as stated, REFUTED as a safety property** | it cannot throw; it silently re-stats to `ranger` 110 — **N-5** |
| 8 | L-2: the HELLO half degrades cleanly | **CONFIRMED for the bare case, REFUTED for truncation** | `Invalid typed array length: 200` uncaught on the host — **N-6** |
| 9 | L-2: re-stating a one-tick-old pawn is the smaller change | **REFUTED as a bound** | nothing enforces one tick; four HELLOs full-healed a 35/110 pawn — **N-4** |
| 10 | **L-3** the client's barrier is the host's | **CONFIRMED** | `preL3` 30.00 → 14.70 client / 0.00 host; `fixed` 0.00 from sample 2 |
| 11 | L-3 replaces an invisible lie with a visible zero | **CONFIRMED, and understated** | the same lines also erase `onDamaged` **heals** — **N-9** |
| 12 | L-3 rides on K-1 (`preK1` reverts it too) | **CONFIRMED** | `preK1` client shield 30.00 → 14.56 |
| 13 | **L-1** the host's death no longer freezes the authority | **CONFIRMED** | `preL1` 742 ×8; `fixed` 908 → 1124, +216 ticks in 4 s |
| 14 | L-1: the client can die with the host dead | **CONFIRMED** | `preL1` `alive true`/212.26 on a death screen; `fixed` `alive false`/0 |
| 15 | L-1: the release is not a one-way door | **CONFIRMED** | `hostReleased {paused:true, screen:"death", inputEnabled:true}` in every arm |
| 16 | L-1: a menu on a host with a live peer is an overlay, input muted | **CONFIRMED** | client 1316 → 1482 through five samples; host `paused false`, `input.enabled false` ×5 |
| 17 | L-1's design is coherent with K-2 | **CONFIRMED**, and it holds with 3 peers and staggered deaths | `fixed` two-client sequence, §7.3 |
| 18 | §4.3: `HOLD_GRACE` closes the discarded-death-snapshot defect | **CONFIRMED** | `client.alive false` on every fixed-tree arm; no arm reproduced the split |
| 19 | §4.3 implies the grace introduces nothing of its own | **REFUTED** | **1.68 s** measured, host simulated, targeted and input-muted — **N-8** |
| 20 | **L-4** a run summary credits only its own kills | **CONFIRMED**, three ways | `preL4` 4/4 and 5/5 on both clients; `fixed` 0/0 then 1/1 and 0/0 |
| 21 | L-4: `HUD.stats.kills` is no longer a K-3 observable on a client | **CONFIRMED** | `0` on the client in every fixed-tree arm |
| 22 | L-4 leaves single-player untouched | **REFUTED** | HUD +1 per enemy-on-enemy kill and +1 on your own death — **N-7** |
| 23 | **L-5** the victim predicate fails closed on a client | **CONFIRMED** | `preL5` client0 `death`/`_ended true` from a teammate's death; `preVictim` `null`/`null` |
| 24 | L-5's cost: a client's own death also stops ending its run | **CONFIRMED**, and it is the better half of a bad pair | `preVictim` client1 `screen null`, `_ended null` on its own death |
| 25 | L-5 is client-only; the host row is the control | **CONFIRMED** | host `death`/`true`/`director false` in both columns |
| 26 | K-1 re-verified | **CONFIRMED** | flat 170 vs 136.67; `alive true`/189.45 vs `false`/0 |
| 27 | K-2 re-verified, both directions | **CONFIRMED**, three players | §9.6 |
| 28 | K-3: the `Audio._out` guard alone is sufficient, so `preEB` is not a failed gate | **CONFIRMED as reasoning**; I used `preK3full`/`preEBfull` and never quoted a wire-only arm | `preK3full` 7 of 7 throws with 7 of 7 downstream |
| 29 | `EventBus` isolation re-confirmed at both ends | **CONFIRMED** | `preK3full` 7 of 7 downstream vs `preEBfull` **0 of 7**, identical throws |
| 30 | "eight messages for four throws", 2× loudness | **NOT REPRODUCIBLE** | 7 throws → 7 messages, 1:1 — **N-11** |
| 31 | K-5 rides entirely on F-10 | **CONFIRMED** | `preK5` 0 with cue 1; `preF10` 0 with sentinel 1004.85 and cue 0 |
| 32 | F-6 re-verified | **CONFIRMED** | `preF6full` lastCmdTick 100 vs netTick 6; `fixed` 0 == 0 |
| 33 | F-9 re-verified with its control | **CONFIRMED** | `peerDelta` +777 vs **+0**, `localDelta` +500 in both |
| 34 | **F-7 needs no co-op re-run** | **REFUTED as a decision, CONFIRMED as a fix** | `f7-pregate` host pawn `[30, 30, 36]` vs client `[30, 30, 30]`, plus host barriers `[10,10,10]` and 1 quake; `f7-fixed` agrees `[30,30,30]` with no host side effects |
| 34b | round 3's `Player._jump` restructure (the `local` gate moved off the impulse) | **CONFIRMED, and it had no gate until now** | `f7-preimpulse`: host `pawnImpulses []` and 0 `jump` events against a client predicting `[30,30,30]` |
| 35 | **M1 needs no re-run** — its predicate is independent | **REFUTED as a decision, CONFIRMED as a fix** | `preM1`: a client's own death leaves `musicOff false`, `Audio.playerDead 0` |
| 36 | K-10 has no behavioural signature | **CONFIRMED** | `preK10` produced no null victim in either direction; not a failed gate |
| 37 | **§8 "single-player did not move"** | **REFUTED** | every other row identical; the HUD kill counter is not — **N-7** |
| 38 | §8: the `onDamaged` barrier leg reads 0 on both trees, not chased | **CHASED, and it is a fixture artefact** | 30.00 → 25.83 immediately after a clean hit, identical on all three SP trees |
| 39 | **L-7 is counted but never defined** | **CONFIRMED** | one occurrence in the whole document, at line 69, in the table |
| 40 | L-6's six items are correct and applied | **CONFIRMED, five of six fixed** | item 6 is recorded but the bad pointer in `round1-fix-coop.md:3` is still there — **N-10** |
| 41 | L-8: the reset buys nothing observable at zero lag; kept as correctness | **CONFIRMED as recorded**, not re-measured by either of us | round 2's critique's 0.04 vs 0.06 stands as the only measurement |
| 42 | L-9: three `tally` call sites, one method, backward-compatible `owner` | **CONFIRMED** | `frost-lattice`, `resonance-coil`, `tectonic-heart` |
| 43 | **N-1** no enemy has ever targeted a co-op pawn | **CONFIRMED** | 78 hits on the host, **0** on a pawn 3 m away over 30 s; `targetIsPawnPos false` in every sample |
| 44 | N-1: a joining player is functionally invulnerable to the AI | **REFUTED** | an Overloading death blast took **87** off the pawn with no harness call |
| 45 | N-1: every client-damage measurement in three rounds was harness-driven | **CONFIRMED as a fact, REFUTED as an invalidation** | E2 drove K-1, K-5, F-10 and L-3 from real enemy damage; all four hold |
| 46 | N-1's cost: a player list, nearest-player targeting, two re-routes | **INCOMPLETE** | also `checkLOS`, two aura radii, four FSM transitions, projectile homing, and aggro stickiness |
| 47 | **N-3** no `PROTOCOL_VERSION` check on either side | **CONFIRMED by measurement** | host stores no version field; client keeps none; `version: 99` accepted silently |
| 48 | N-3 is not made worse by round 3 | **PARTLY REFUTED** | not by itself, but N-5 turns a version-skewed roster into a silent stat downgrade |
| 49 | **N-2** level divergence, not claimed, named as an arm | **UNVERIFIABLE — still not run by anyone** | — |
| 50 | 19 co-op sessions, 21 raw files, driver deleted | **CONFIRMED** | `r3/` holds 21 files; every number I spot-checked in §2-§7 of that report matches its named file and key |

---

# 14. Ship, hold, or hide the menu entry

**For whoever is making this call today.**

## 14.1 Hide the menu entry. Ship the rest of the branch.

Not because co-op is broken — after three rounds it is *coherent*, and that is a
real achievement I want on the record. Two people get two survivors, two honest
health bars, two run summaries about their own player, and one death ends one
run. Every one of those was false eight days of work ago and each is measured at
both ends here.

Hide it because of one sentence: **the second player is never fought.** Not
"fought less", not "fought unfairly" — never selected, never chased, never aimed
at. They walk through a horde that will not look at them and take only splash.
Whatever they experience, it is not this game, and no amount of the coherence
rounds 1-3 bought changes that. A menu entry is a promise, and this one cannot be
kept yet.

## 14.2 What co-op is now, honestly

**Fixed, and I verified each at both ends:** you play the survivor you picked
(L-2); one death ends one run, in every direction and with three players (L-1,
K-2, L-5); your kill counter is yours (L-4); your barrier does not lie (L-3);
your own health and your own death are the authority's (K-1); a teammate's death
does not silence your music (M1) or take your run (K-2); a host's death does not
stop the world (L-1); and the whole of rounds 1 and 2 still holds — eleven
prior fixes (K-1, K-2, K-3's two halves, the `EventBus` isolation, K-5, K-10,
F-6, F-7, F-9, F-10, M1) re-verified here with a gate failed on purpose for
each, plus round 3's own `Player._jump` restructure, which nobody had gated.

**Not fixed:**

| # | what the player gets | cost to close |
|---|---|---|
| 1 | **N-1.** The joiner is never attacked. The host fights the entire run alone. | A **feature**, not a fix: player list on `ctx`, nearest-player targeting, LOS, two aura radii, four FSM transitions, projectile homing, plus aggro stickiness that does not oscillate between two players standing together. In the AI hot path. **Its own round, with its own verification pass.** |
| 2 | **N-7.** Your kill counter lies, in single-player too, and your reticle flashes a kill confirm when a teammate dies. | **One clause** — `!e?.victim?.isPlayer &&`, the guard `Progression` already has. Do this before shipping *anything*; it is not a co-op bug. |
| 3 | **N-4.** A peer can full-heal its own pawn on demand. | **Three lines** — latch HELLO, gate the re-stat on pawn age. |
| 4 | **N-5 + N-3.** One unknown survivor id, or one version-skewed pairing, silently re-creates L-2. | **~10 lines** — validate the id against the catalogue, compare `PROTOCOL_VERSION` on both sides, refuse on mismatch. |
| 5 | **N-6.** A malformed message throws uncaught on the host. | **Two lines** — try/catch around `_onMessage`, both roles. |
| 6 | **N-8.** 1.68 s of a muted, exposed host after the last peer dies. | **One line** — release `input.enabled` on `hasLivePeer()`, not on the grace. |
| 7 | **N-9 / K-4.** Defensive item cards do nothing for a joiner. | Per-jumper tally state and a jumper-aware hook API. Three `tally` sites, one method, plus the real work in `api.jumper`. And correct the `Items.js:205-215` comment either way. |
| 8 | **K-6.** A joiner's soundtrack is flat. | Replicate the difficulty arc, or drive intensity from forwarded events. |
| 9 | **§12.2.** A host that quits strands every client — no run end, no summary. | **One listener** on `netDisconnected`. Untested in four rounds. |
| 10 | **N-2.** Level divergence over a long session. | **Nothing to build — an arm to run.** Sample both ends' `level` and `maxHealth` together over ten minutes. Do this before believing any long-session agreement number. |
| 11 | **§12.8.** Nobody has played a stage transition in co-op, in four rounds. | Unknown, sitting between stage 1 and every stage after it. |

## 14.3 The shortest credible path to enabling it

Four steps, in this order, and the order matters.

1. **Items 2-6 above.** They are roughly twenty lines between them, they are all
   in files this branch already touches, and four of the five are one-liners.
   N-7 in particular ships regardless of co-op. **A day, including a verification
   pass that fails each gate on purpose.**
2. **Run the two arms that cost nothing to run and gate a decision** — N-2
   (level divergence over ten minutes) and a co-op stage transition. Neither is a
   known defect; both are unknowns sitting under everything else. **Half a day.**
   If either fails, it changes what step 3 is for.
3. **N-1.** This is the one that decides whether there is a game here. Treat it
   as a feature round: design the aggro rule first (nearest? most recently
   damaged? per-enemy sticky with a hysteresis band?), then implement, then
   verify with the arm in §2 of this document run in reverse — a pawn standing
   in a pack **must** take directed hits, and a host 150 m away must stop
   drawing them. **Days, not hours, and it will surface balance questions
   (spawn budget scales with `playerCount`; two players and one aggro target is
   not the same encounter as two players and two).**
4. **Then play it.** Two people, one full run, headphones on. Four rounds of
   review have produced a great deal of evidence and not one minute of anyone
   playing this. That is the last gate and no document can substitute for it.

Steps 1 and 2 are a day and a half and make the branch strictly better whether or
not co-op ever ships. Step 3 is the product decision. **Until step 3 lands, the
Co-op entry should not be in the menu**, because a player who takes it gets a
game where nothing is trying to kill them — and that reads as broken long before
it reads as easy.

---

Raw JSON: `reviews/round7/coop/r3-critique/` — 28 session files. Drivers deleted; the
substitution table is §14.4 below and every number above names the file and key it
came from.

## 14.4 Appendix — the substitution table

All validated against `src/` on disk as matching **exactly once** before any arm
ran; the transform throws otherwise and the arm refuses to boot.

| name | file | anchor replaced | replaced with |
|---|---|---|---|
| `L2-hello` | `src/net/NetClient.js` | `this._sendHello();` | `;` |
| `L1-hold` | `src/net/NetHost.js` | `this._holdSession(ctx);` | `;` |
| `L3-shield` | `src/net/NetClient.js` | `const sfrac = e?.shieldFrac;` | `const sfrac = undefined;` |
| `L4-prog` | `src/systems/Progression.js` | `if (!isLocalKill(ctx, e)) return;` | `;` |
| `L4-hud` | `src/ui/HUD.js` | `if (isLocalKill(ctx, e)) {` | `if (true) {` — **not a faithful revert, see §1.5** |
| `L4-hud-head` | `src/ui/HUD.js` | the same line | **HEAD `a43cc70`'s exact condition** |
| `L5-open` | `src/core/Engine.js` | `if (!victim) return ctx?.netRole !== 'client';` | `if (!victim) return true;` |
| `K1-all` | `src/net/NetClient.js` | `this._applyAuthoritativeHealth(player, authoritative);` | `if (authoritative) { }` |
| `K2-pred` | `src/core/Engine.js` | the same `!victim` line | `return true;` (the whole predicate) |
| `K3-wire` | `src/net/NetHost.js` | the `{x, y, z}` object form | the array form |
| `K3-guard` | `src/systems/Audio.js` | the `Number.isFinite` early return in `_out` | `;` |
| `EB-isolate` | `src/core/Engine.js` | `} catch (err) {` | `} catch (err) { throw err;` |
| `K5-prog` | `src/systems/Progression.js` | `this.stats.damageTaken += e?.amount ?? 0;` | `;` |
| `K10-null` | `src/net/NetHost.js` | the `typeof v.takeDamage === 'function'` branch | `else if (false) { }` |
| `R1-F6` | `src/net/NetClient.js` | `ctx.player?.resetCommandEpoch?.();` | `;` |
| `R1-F6-window` | `src/entities/Player.js` | `&& this._lastCmdTick - c.tick < REPLAY_WINDOW;` | `&& true;` |
| `R1-F9` | `src/systems/Progression.js` | the `e.source === ctx.player` damage guard | the unguarded form |
| `R1-F10` | `src/net/NetHost.js` | `ctx.events.on('damage', (e) => this._forwardHurt(e));` | `;` |
| `R1-victim` | `src/systems/Combat.js` | `ctx.events.emit('playerDead', { victim });` | `ctx.events.emit('playerDead', {});` |
| `R1-M1` | `src/systems/Audio.js` | `const victimNetId = p?.victim?.netId;` | `const victimNetId = undefined;` |
| `R1-F7-soles` | `src/data/items.js` | Rubber Soles' `e.local === false` gate | the ungated form |
| `R1-F7-tectonic` | `src/data/items.js` | Tectonic Heart's `if (e.local === false) return;` | `;` |
| `R1-F7-impulse` | `src/entities/Player.js` | `let impulse = 0;` | `let impulse = 0; if (!this.local) return;` |
