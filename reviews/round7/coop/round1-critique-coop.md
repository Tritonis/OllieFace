# Round 7 — round-1 critique, co-op fixes
## Independent review of the uncommitted co-op fix round on `round7/content-and-polish` @ `a43cc70`

Subject: `reviews/round7/coop/round1-fix-coop.md` and the working-tree edits to
`src/net/NetHost.js`, `src/net/NetClient.js`, `src/systems/Combat.js`,
`src/systems/Audio.js`, `src/systems/Items.js`, `src/systems/Progression.js`,
`src/entities/Player.js`, `src/data/items.js`.

Nothing in `src/` was modified. Every sabotaged arm was built by named
in-memory source substitution inside a vite `transform`; a substitution that
does not match exactly once throws and the arm refuses to boot. My raw JSON is
under `reviews/round7/coop/r1-critique/`. The drivers were deleted after use;
their output was not. **I did not read the fixer's JSON as evidence.** I read
its report to know what it asserts, then measured every number again with my
own instruments, and I compared its prose against its own raw files afterwards
as a separate check.

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 681ms`;
re-run at the end of the review, `✓ built in 684ms`, exit 0 again, with the
fixer's eight edits still in the working tree and nothing staged).

---

**Verdict: the five fixes PASS; co-op does not ship.** All five claimed fixes
reproduce on my own instruments and all five gates fail on purpose. The round's
work is sound. What is left in co-op after it — three MAJORs, all pre-existing,
all correctly attributed by the fixer, two of them larger than its report reads
— is still enough to keep a co-op client from being a playable one.

**Headline.** All five fixes are real, and I failed all five gates on purpose
with one-fix-at-a-time substitutions the fixer did not run — a stronger
attribution than its single all-reverted arm. F-6, F-7, M1, F-10 and F-9 are
closed on the arms the brief named. The two instrument failures the fixer
reported and corrected were genuinely corrected: my independent versions of
both agree with the corrected ones. I also closed the one arm the fixer marked
"code-reviewed only, unverified" (`shieldBroken` on the wire), and it passes.

What stops this from being an unqualified pass is that **the round has made
co-op's remaining defects louder rather than smaller.** The three defects the
fixer found and declined are correctly attributed as pre-existing — I
reproduced all three on a fully-reverted tree — but two of them are worse than
its report reads, and one of them is not a missing sound effect at all: it is a
thrown exception that aborts event dispatch on every co-op client. F-7 is
closed for two of the three items the summary named it for; Tectonic Heart is
still inert for a client, and the fix's own design is what keeps it that way.
And four numbers in the fix report are contradicted by the fixer's own raw
files — the exact failure mode round 4's lesson was written about.

Single-player did not move. I ran the single-player control on *both* trees —
the fixer ran it only on the fixed one — and every measured quantity is
identical.

| severity | count | ids |
|---|---|---|
| CRITICAL | 0 | — |
| MAJOR | 3 | K-1, K-2, K-3 |
| MODERATE | 3 | K-4, K-5, K-6 |
| MINOR | 4 | K-7, K-8, K-9, K-10 |

Claims re-derived, one by one, in §11: **24 confirmed** (one of them a claim
the fixer marked unverified, which I verified), **4 refuted**, **1 unverifiable
as a build property**, **1 confirmed but incomplete**.

---

# 1. Methodology, and the two gates that make the rest admissible

## 1.1 Two real pages, one real wire

Every co-op number below is taken from two Chromium pages in one browser,
host and client over the manual WebRTC invite path
(`Lobby.createInvite` / `joinManual` / `acceptAnswer`) — the shape
`reviews/round7/r5-audio/p5-net.mjs` established. Session reality recorded in
every arm's `roles` key and identical across all of them:

```
host   { authority: true,  role: "host",   playerCount: 2, clients: 1 }
client { authority: false, role: "client", myNetId: 1,     connected: true }
```

## 1.2 The running-game gate — the fixer's first instrument failure, re-derived

The fixer reports that its first two sessions sat on the survivor-select screen
with `ctx.paused true` and `player._localTick 0`, so nothing it measured was
in a running game. I did not adopt its fix; I built my own and made it a
blocking precondition. Every arm launches both pages with
`ctx.hud.menus.launch()` and then **waits** on

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

before any instrument is installed, and records the result as `runningGate`.
Both pages, every arm:

| | host | client |
|---|---|---|
| `paused` | `false` | `false` |
| `menus.screen` | `null` | `null` |
| `player._localTick` | 61 | 61 |

(`fixed-run1.json` → `runningGate`.) The correction is real and my arms carry
an independent version of it.

## 1.3 The replay flag, read from inside the step — the second failure, re-derived

The fixer reports that `_replaying` is cleared by `_commit` at the end of every
step, so reading it after `applyCommand` returns reads `false` on every build,
and that its first replay counter therefore read "fixed" on a sabotaged tree.
That is true at source: `Player.js:535` is `this._replaying = false;`, the last
statement of `_commit`.

The fixer's corrected instrument wraps `Player._resolve`. **Mine wraps
`Player.prototype._commit` and reads `this._replaying` on entry** — the last
moment the flag is legible — which is a different hook on a different method,
so the two are genuinely independent. Two more legs ride with it:

- `player.projectiles.fixedUpdate` call count (the branch `_replaying` skips,
  `Player.js:467-470`);
- `replayInReconcile`, from a wrapper on `NetClient._reconcile`, so a
  reconciliation replay is *attributed* rather than inferred.

The instrument is proved by failing: on `preF6` it reads **60 of 60** steps
replayed and **0** projectile ticks in the first second after connect. A
counter that cannot read `1.000` on a broken build is not a counter.

## 1.4 Arms

Each arm is one two-page session on the tree as it stands, with a named list of
in-memory substitutions. The list actually applied is written into each JSON as
`substitutions`, and `substitutionsMissing` is non-empty only if a substitution
failed to apply (it never was).

| arm | substitutions | raw |
|---|---|---|
| `fixed` | *(none)* | `fixed-run1.json` (primary, the only session whose M1 leg survived), `fixed.json` (second session; `fixed2.json` is a byte-identical copy of it) |
| `pre` | all ten, i.e. HEAD's behaviour | `pre.json` |
| `preF6` | `F6-classifier`, `F6-reset` | `preF6.json` |
| `preF7` | `F7-impulse` | `preF7.json` |
| `nogate` | `F7-gate-soles`, `F7-gate-tectonic` | `nogate.json` |
| `preM1` | `M1-combat`, `M1-audio`, `M1-stamp`, `M1-resolve` | `preM1.json` |
| `preF10` | `F10-host`, `F10-items` | `preF10.json` |
| `preF9` | `F9-guard` | `preF9.json` |
| `sp-fixed` / `sp-pre` | single player, no network, fixed tree vs HEAD | `sp-fixed.json`, `sp-pre.json` |
| `blast-fixed` | supplementary: `kill` dispatch and client-only state | `blast-fixed.json` |

**The per-fix arms are the improvement over the fixer's method.** Its `pre` arm
reverts all five fixes at once, so every gate failure is attributed to a bundle.
Mine revert one fix at a time, so "the F-9 guard is what stops the peer's 777"
is a measurement rather than an inference.

## 1.5 Evidence I disqualified rather than shipped

- **`preF9`, three runs out of four.** Its F-9 probe recorded
  `sourceWasPawn: false` — the client page had died and the host's `clients` map
  was empty, so the 777 was applied with an *undefined* source and
  `e.source?.isPlayer` was false for a reason that has nothing to do with the
  guard. **`peerDealtDelta: 0` on those runs would have read exactly like a
  passing gate and is evidence of nothing**; the `sourceWasPawn` flag exists
  precisely so that cannot happen silently. One run in four
  (`preF9-attempt2-DISQUALIFIED.json` is kept on disk as one of the bad ones)
  landed with a live pawn as the source, and only that run is quoted.
- **`preF6`, sections F7 / F10 / M1.** The client page lost its execution
  context after the F-6 windows (`state@F7 → client { M: "undefined" }`, same
  URL), so everything in that arm from `F7` onward ran on a disconnected page.
  `preF6`'s F-6 windows are clean — they were taken before the loss and its
  `roles` shows a live two-player session — and nothing else from that arm is
  quoted. `preF9`'s first run lost the client the same way.
- **My peak-horizontal-speed metric is noisy and I stopped relying on it.**
  Two arms recorded a client peak (74.4, 85.4 m/s) far above the host's while
  the *impulse record* was identical on both ends, which is a jump landing
  inside a sampling window rather than a divergence. Everything load-bearing in
  §3 is taken from `Player._jumpImpulses` — the code's own per-tick record of
  what each jump consumed — not from a velocity peak.
- **The first pass of my `kill`-dispatch probe measured nothing:** `emitted: 0`
  kill events on the client across a 20 s fight, because neither survivor's
  auto-fire killed anything (`hostFight.progressionKills: 0` on the host too).
  A "0 of 0 reached the downstream listener" would have looked like a passing
  control and proved nothing either way. Re-run with enemies killed outright on
  the host; that pass overwrote the empty one at `blast-fixed.json`, so the
  empty output is *not* on disk — this paragraph is the only record of it, and
  the numbers quoted in §8 are all from the re-run (`forcedKills.killed: 4`).

---

# 2. F-6 — the join lock. CONFIRMED, gate failed on purpose in isolation

**Claim:** `_lastCmdTick` at the first wire command 365 → 0; steps classified
replay in the first second 1.000 → 0.000; `projectiles.fixedUpdate` 0 → 70.

The epoch reset is visible directly. In every arm the client idles ~6 s in
single-player before joining, so `_lastCmdTick` is several hundred; then:

| | `preF6` (F-6 alone) | `pre` (all ten) | `fixed` | `nogate` |
|---|---|---|---|---|
| `clientBeforeJoin.lastCmdTick` | 421 | 423 | 421 | 422 |
| `_lastCmdTick` at connect (`atJoin`) | **454** | **455** | **5** | **6** |
| `net.tick` at the same instant | 11 | 6 | 5 | 6 |

`atJoin.lastCmdTick === atJoin.netTick` on the fixed tree: the counter was
re-based, and it was re-based before the first wire command, which is the
critic-preferred fix and is what `NetClient.init` gives you.

**Near end of the range — the first second after `net.connected`:**

| | `preF6` | `pre` (all ten) | `fixed` | `nogate` |
|---|---|---|---|---|
| steps | 60 | 61 | 48 | 64 |
| classified replay | **60** | **61** | **0** | **0** |
| replay fraction | **1.000** | **1.000** | **0.000** | **0.000** |
| of which raised by `_reconcile` | 0 | 0 | 0 | 0 |
| `projectiles.fixedUpdate` calls | **0** | **0** | **48** | **64** |
| projectile ticks per step | **0.000** | **0.000** | **1.000** | **1.000** |

Every command a replay and every projectile frozen on the sabotaged arms; zero
replays and a projectile tick for every step on the fixed ones. **CONFIRMED**,
and the gate failed on purpose with the two F-6 edits reverted *alone*.

**Far end — the ninth second. This is where I part company with the report.**
The fixer states the far end as "still 61 % locked, still dropping 294 of 480
projectile steps". In my sessions the sabotaged arms read **0.000 replay at second 9**, with
60/60 (`pre`) and 61/61 (`preF6`) projectile ticks — the lock had already
expired. Both
observations are consistent with the same mechanism: the lock runs
`_lastCmdTick` *accepted wire ticks*, and my idle client's wire ran at a full
60 Hz, so a 421-tick lock clears in 7.0 s, inside my ninth-second window. The
fixer's session was not producing 60 accepted ticks a second, so its lock was
still running at second 9.

So the *mechanism* is confirmed at both ends and the *duration* is a property
of the session's wire throughput, not of the build. **`0.613` and `186 / 480`
must not be quoted as build figures.** The fixer flagged F-11's numbers and
F-7's divergence as session-dependent and was right to; this third one carries
the same problem and is not flagged. See K-8.

**One arm I did not drive:** reconnect after `Lobby.leave()`. Reading
`Lobby.joinManual` (`Lobby.js:105-107`, `new NetClient()` then
`engine.add(client)` → `init`), a reconnect constructs a fresh `NetClient` and
therefore calls `resetCommandEpoch()` again, so the reset covers that arm too
and `REPLAY_WINDOW` is belt over braces rather than the only cover. That is a
source reading, not a measurement.

---

# 3. F-7 — the jump impulse. CONFIRMED, and closed for two items of three

**Claim:** host pawn peak 7.000 → 37.000, equal to the client's 37.000, with
Rubber Soles barriers and Tectonic quakes on the host staying at 0.

## 3.1 The impulse itself, from the code's own record

`Player._recordJumpImpulse` writes what each jump consumed against the tick
that consumed it. Reading `_jumpImpulses` on both ends after three sprint-jumps
driven through the real key handler is the sharpest available statement of this
claim, and it does not depend on catching a velocity peak:

| | `preF7` (impulse re-gated) | `fixed` | `nogate` (side-effect gate removed) |
|---|---|---|---|
| host — impulses applied to the pawn | **`[]`** | **`[30, 30, 30]`** | `[30, 30, 36]` |
| client — impulses applied to itself | `[30, 30, 30]` | **`[30, 30, 30]`** | `[30, 30, 30]` |
| host — `jump` payloads for the pawn | **`[]`** | 3 × `{local: false, isPawn: true}` | 3 × pawn |
| host pawn peak horizontal speed | **10.150 m/s** (sprint, no launch) | **40.150 m/s** | 46.150 |
| client's own peak | 30.893 | **40.150** | 40.150 |
| Rubber Soles grants of exactly 10 paid by the host for a peer's jump | 0 | **0** | **3** |
| quakes erupted on the host for a peer's jump | 0 | **0** | **1** |
| end-state host-pawn ↔ client-player gap | 0.0594 m | **0.0000 m** | — |

Both ends of the range: with the impulse re-gated the host applies **nothing**
while the client applies 30 three times; with the fix in place the two ends
apply the identical `[30, 30, 30]` and end the sequence at the identical
position (`[2.507, 6.754, 29.19]` on both). Confirmed again in a second fixed
session (`fixed.json`: `[30,30,30]` / `[30,30,30]`, 40.150 / 40.150,
`barriersOf10 0`, `quakes 0`). **CONFIRMED.**

One caution on the last row, in the fixer's own spirit: my two fixed sessions
end at **0.0000 m** and **0.0348 m**. The end-state gap is a settling artefact
of when the sample lands relative to the snapshot, so it is session-dependent
too and neither number should be adopted — which is exactly what the fixer says
about its 0.0266 m.

The fixer's 7.000 → 37.000 and my 10.150 → 40.150 are the same event at
different base speeds (its client walked, mine sprinted: 7 × 1.45 = 10.15, and
`linear(10, 3) = 30` in both). The claim is the *equality*, and the equality
holds.

## 3.2 The side-effect gate, failed on purpose in one file

`nogate` removes only the two `if (e.local === false) return;` lines in
`src/data/items.js` and reports it: `barriersOf10: 3`,
`barriers: [30, 10, 10, 30, 10, 30]`, `quakes: 1`. Three Rubber Soles barriers
and one quake paid by the host for a jump 25 m away. **The gate is a gate.**

`nogate` also proves the fixer's second, subtler argument. Without the gate the
host applies **36** on the pawn's third jump (Tectonic Heart's `applyImpulse(6)`
riding on its every-third tally) while the client predicts **30** — a 6 m/s
divergence on every third jump, forever. The gate is doing double duty and the
report is right about that.

## 3.3 What the report does not draw from its own design — K-4

`Items.tally` returns `false` on a non-authority (`Items.js:644`). So a client
can never fire Tectonic Heart for its own jump, and the new gate means the host
never fires it for the pawn either. Measured, same session, same inventory:

| whose jump | impulses applied |
|---|---|
| the **host's own** jump, all arms | **`[30, 30, 36]`** + `barriers [10, 10, 10]` + 1 quake |
| the **client's own** jump | **`[30, 30, 30]`** + 0 quakes |
| the host's copy of the client's jump | `[30, 30, 30]` |

The round-4 summary lists F-7 as "Waxed Wing, Updraft Vents and Tectonic Heart
are inert for every non-host player". **This round restores two of those three.**
Tectonic Heart's quake and its +6 are still unreachable for a client, and the
fix's correctness argument depends on their staying that way. The report says
this ("Tectonic Heart is skipped for a pawn on purpose") but frames it as a
property that makes the numbers agree, not as a boss-tier item that does
nothing for half the players. Recorded as **K-4, MODERATE**.

---

# 4. Audio M1 — a client's own death. CONFIRMED, gate failed in isolation

**Claim:** teammate row unchanged at `0.48000`; own death `0.48000` → `0.00240`.

Order is teammate-first in every arm, so the arm round 3 fixed is re-checked
before the arm round 4 broke.

| step, on the **client** | `preM1` (four M1 edits reverted) | `fixed` |
|---|---|---|
| after the **host's** player dies (a teammate) | `stopped false`, `musicOff false`, `musicGain 0.48000` | `stopped false`, `musicOff false`, `musicGain 0.48000` |
| after the **client's own** pawn dies | `stopped **false**`, `musicOff **false**`, `musicGain **0.48000**` | `stopped **true**`, `musicOff **true**`, `musicGain **0.00311**` |
| `playerDead` payloads the client received | `[{victimNetId: null}, {victimNetId: null}]` | `[{victimNetId: 2, isSelf: false}, {victimNetId: 1, isSelf: true}]` |

Both ends. **CONFIRMED**, and the last row is the mechanism rather than the
symptom: on the fixed tree the wire actually carries the victim's identity, the
teammate's death arrives as netId 2 and the client's own as netId 1 —
`myNetId` — resolved to `ctx.player` by `NetClient._resolve`.

The fixer's choice of the audio critic's option 1 over option 2 is sound and I
can add a measurement for it: because the identity is carried, the teammate row
is 0.48000 on **both** arms, so option 1 did not buy the own-death cue at the
cost of round 3's M3. Option 2 (`ctx.authority && player.alive !== false`)
would have, because `playerDead` is broadcast.

**Not tested by anyone:** `Player.js:1287`'s self-kill fallback
(`{ victim: this }`) is unreachable without a build that has no `Combat`. Still
source-level only.

---

# 5. F-10 — the client's damage feedback. CONFIRMED, plus the arm nobody ran

**Claim:** `timeSinceHurt()` sentinel → 1.47 s; `Audio.playerHurt` cues 0 → 1;
barrier from Sunken Vertebra's `onDamaged` 0 → 21.9.

The host deals an identical 40 in every arm (`healthBefore 110`,
`healthAfter 70`), so both arms really did land the same hit.

| on the **client** | `preF10` (both F-10 edits reverted) | `fixed` | `nogate` (independent replication) |
|---|---|---|---|
| `items.timeSinceHurt()` before → after | 1033.77 → **1035.28** (sentinel, still climbing) | 1033.23 → **1.48** | → **1.45** |
| `Audio.playerHurt` cues | **0** | **1** | **1** |
| barrier from `onDamaged` | **0** | **21.84** | **22.03** |

Both ends, three legs each. **CONFIRMED**, and three sessions agree.

## 5.1 The `shieldBroken` half — the fixer's untested arm #5, now measured

The report names this as "code-reviewed only, unverified": no arm produced an
absorbed-only hit on a pawn. I produced one — pawn shield set to 500, 30 damage,
`healthUnchanged: true` on the host — and read the client:

| | `preF10` | `fixed` |
|---|---|---|
| `shieldBroken` events received by the client | **0** | **1** |
| additional `playerHurt` cues | 0 | **0** — correctly none |
| `timeSinceHurt()` across the absorbed hit | 1036.50 (sentinel) | 1.48 → **2.70**, i.e. **not reset** |

The split matches `Combat.js:461`/`:491` exactly: a hit a barrier ate whole
raises `shieldBroken` on the client, does **not** raise `playerHurt`, and does
**not** reset the hurt timer three items key off. **The unverified half is
correct.** This is the one arm where I can upgrade a fixer's own caveat rather
than qualify it.

## 5.2 What F-10's fix does not reach — K-5

`Combat` emits `damage` for every target; `Progression` and `Profile` both
count damage taken off **`damage`**, not off `playerHurt`
(`Progression.js:144-161`, `Profile.js:1355-1370`). The fix forwards
`playerHurt`/`shieldBroken` and nothing else, so on the fixed tree, after the
client has taken a 40-damage hit it can hear and proc:

```
blast-fixed.json → phantomBarrier.after
  progressionDamageTaken : 0
  profileRunDamageTaken  : 0
  profileStageDamage     : 0
```

and the same three read 0 in every co-op arm. Two consequences, both
pre-existing but both *un-closed by a fix filed as closing "a co-op client
never receives damage feedback at all"*:

1. A co-op client's run summary reports **0 damage taken** for the whole run.
2. `Profile._onStageStart` increments `flawlessStages` whenever
   `damageTakenThisStage <= 0` (`Profile.js:1290`). On a client that counter can
   never move, so **every stage a co-op client clears is flawless** and
   `Untouchable` (goal 1) and `Ironclad` (goal 3) unlock for free. Source-derived
   plus the measured `profileStageDamage: 0` after a real hit; I did not clear a
   stage in co-op to see the unlock fire, and say so.

The second half of K-5 is the mirror image: the client-side `onDamaged`
dispatch creates state the host does not have. Measured in the same probe —

| | client | host's copy of the same pawn |
|---|---|---|
| shield before the hit | 0.00 | 0.00 |
| shield after the 40-damage hit | **19.63** | **0.00** |
| health after it | **116.5** (and rising) | **103.4** |

`Items.addBarrier` writes `ctx.player.shield` (`Items.js:716-722`), which on a
host is always the host's own survivor, so no item can ever put a barrier on a
pawn. The client therefore displays 19.63 points of barrier that absorb nothing,
on top of a health bar frozen at 110 (K-1). `onDamaged` cards that grant gold
(`items.js:435`) and buffs (`items.js:1036`) have the same shape. Nothing here
diverges the *simulation* — I checked, `frenzy` is `attackSpeed` only
(`Items.js:532`) and no `onDamaged` buff touches `moveSpeed` — so this is a
display and expectation defect, not a desync. **MODERATE.**

---

# 6. F-9 — a teammate's damage credited to your run. CONFIRMED

**Claim:** the peer's 777 contributes +0 and does not become `highestHit`;
the local 500 still does both.

Measured on the host with a real director enemy as the target
(`usedRealEnemy: true`) and the peer's pawn as `e.source`
(`sourceWasPawn: true` — the fixture check that voided three of my four
`preF9` runs; see §1.5):

| | `preF9` (guard alone reverted) | `pre` (all ten) | `fixed` |
|---|---|---|---|
| `damageDealt` delta from the **peer's** 777 | **+777** | **+777** | **+0** |
| `highestHit` after it | **777** | **777** | **0** (untouched) |
| `damageDealt` delta from the **local** 500 | +500 | +500 | **+500** |
| `highestHit` after that | 777 | 777 | **500** |

Both ends, in an arm where the guard is the *only* thing reverted, with a
control on the same run showing the guard is not too wide, and reproduced again
in the all-reverted arm. On the same `preF9` session F-7 and F-10 still read
their fixed values (`[30,30,30]` on both ends, hurt cues 1), which is the
isolation showing. **CONFIRMED.**

I also checked the restructure for the side effect it could have had. The edit
turns `if (A) {…} else if (B) {…}` into `if (A && C) {…} else if (B) {…}`, so a
`damage` event with a *remote pawn* as source can now fall into the
damage-**taken** branch, which it could not before. The inner guard on that
branch (`!ctx.player || e.target === ctx.player`, round 4's) makes it a no-op
for every reachable combination, and the arena has no friendly fire. No finding.

---

# 7. Regressions — single-player did not move, and neither did the two things I was asked to re-check

## 7.1 The single-player control the fixer did not run

`singleplayer.json` in the fix round exists only on the **fixed** tree, so
"single-player still works" is demonstrated but "single-player did not move" is
not. I ran the same probe on both trees — `sp-fixed` (no substitutions) and
`sp-pre` (all twelve, i.e. HEAD) — with `netRole "single"`, `authority true`,
launched through `menus.launch()` and gated on `_localTick > 60`.

| | `sp-pre` (HEAD) | `sp-fixed` |
|---|---|---|
| impulses applied over three jumps | `[30, 30, 36]` | `[30, 30, 36]` |
| Rubber Soles barriers | `[10, 10, 10]` | `[10, 10, 10]` |
| Tectonic quakes | 1 | 1 |
| `jump` payloads | 3 × `{local: true, isSelf: true}` | 3 × `{local: true, isSelf: true}` |
| own damage credited / `highestHit` | +500 / 500 | +500 / 500 |
| absorbed-only hit → `damageTaken` delta | **0** | **0** |
| absorbed-only hit → `onDamaged` dispatches | **0** | **0** |
| absorbed-only hit → `playerHurt` emits | 0 | 0 |
| through-health hit → `damageTaken` delta | 20.83 | 20.83 |
| through-health hit → `onDamaged` dispatches | **1** | **1** |
| through-health hit → `playerHurt` emits | 1 | 1 |
| `timeSinceHurt()` across that hit | 1006.53 → **0** | 1006.55 → **0** |
| own death silences the music | `0.33303 → 0.00311`, `stopped true` | `0.27415 → 0.00172`, `stopped true` |
| page errors | **0** | **0** |

Identical on every measured quantity. Peak horizontal speed differs (30.965 vs
37.000) and is the one figure I do **not** treat as build-invariant: it depends
on the terrain under the survivor, which is why the impulse record is the row
that matters. **Single-player did not move. CONFIRMED.**

Two of those rows are the specific risks in this round's edits, and neither
fired:

- **`onDamaged` is not double-dispatched in single-player.** The new
  `Items.playerHurt` listener adds a second dispatch behind `if (!ctx.authority)`.
  `ctx.authority` defaults to `true` (`Engine.js:49`), so single-player takes
  neither path twice: `onDamagedDelta` is **1**, not 2, on both trees.
- **Barrier-absorbed damage still does not count as damage taken**, so
  `Untouchable` and `Ironclad` remain achievable for a single-player survivor:
  `takenDelta 0`, `onDamagedDelta 0`, `playerHurtDelta 0` on a fully-absorbed
  40-damage hit, both trees. Round 4's fix is intact.

The same two rows hold on the **host** in a live co-op session
(`fixed-run1.json → barrierRegression`): absorbed-only
`{takenDelta 0, onDamagedDelta 0, healthDelta 0}`, through-health
`{takenDelta 20.83, onDamagedDelta 1}`.

## 7.2 The host side of the jump/impulse channel F-7 was about

Measured after the F-7 sequence, in the same session, on every arm that
completed it: `hostOwnJump` = `ownImpulsesApplied [30, 30, 36]`,
`barriers [10, 10, 10]`, `quakes 1`, `jumpPayloads` all
`{local: true, isPawn: false}`. Every card on the host's own jump channel still
fires, including the Tectonic tally the new gate reads. **Not regressed.**

---

# 8. The three defects the fixer found and declined — attribution and ranking

All three reproduce on `pre` — all ten substitutions applied, i.e. HEAD's
behaviour — in the same session, on a live two-page wire:

| defect | `pre` (HEAD) | `fixed` |
|---|---|---|
| (a) client's own health ever moves | `clientHealthEverMoved: **false**`, `health 110.0` throughout | `**false**`, `health 110.0` throughout |
| (b) client's `menus.screen` after the **host** dies, client alive | `"**death**"` | `"**death**"` |
| (c) `AudioParam … non-finite` on the client | present | present |

**The fixer's attribution is correct on all three: none is its own.** They are
not, however, equally sized, and the report's ordering (health, then
`playerDead` subscribers, then the `AudioParam` error) is not the order I would
hand to whoever ships this.

## K-1 — MAJOR, pre-existing. A client's own health never updates, and it does not know it is dead

**Rank 1 of 3.**

`NetClient._reconcile` passes only `{x, y, z}` to `setNetState`
(`NetClient.js:214`), and `NetClient.update` skips `myNetId` outright
(`NetClient.js:259`), so nothing writes the local survivor's health on a
client. `Combat.js:379`'s
comment — "A client's health comes from snapshot `healthFrac`" — describes code
that does not exist; the audio critic said so in round 4 and it is still true.

Measured, every arm, `pre` and `fixed` alike:

- `clientHealthEverMoved: false` in every arm.
- The client reads `health 110.0` while the host has its pawn at `70.0`
  (`fixed-run1.json → F10`).
- Worse than "frozen": the two numbers move in **opposite directions**. In
  `blast-fixed.json → phantomBarrier` the host takes the pawn from 143 to
  **103.4** while the client's own reading *rises* from **114.8 to 116.5** on
  local regeneration. The client's health is not a stale copy of the
  authoritative value; it is an unrelated number.
- **After the host has killed the pawn**, the client still reads
  `alive: true, health: 110.0` while sitting on `menus.screen "death"`.

Why this is rank 1 rather than rank 2 despite being quieter: it is
unconditional and continuous. Every second of every co-op session as a client is
played against a health bar that reads full. The player cannot judge a single
risk — when to disengage, when to use a heal, whether an elite is survivable —
and the run ends without warning. It is also the reason M1 needed a netId
handshake at all: the round-4 guard's premise ("`alive` is false by the time
this fires") is false on a client precisely because of K-1, and the fix works
around K-1 rather than removing it. Every co-op fix in this round is now built
on top of it.

The fix is a snapshot field and a line in `_reconcile`, and it would also
subsume half of K-5.

## K-2 — MAJOR, pre-existing. A teammate's death ends *your* run and commits *your* record

**Rank 2 of 3.** The fixer files this as "`playerDead` is broadcast, and
non-audio subscribers do not filter it", which understates it.

Measured, every arm including `pre` and `preM1`: after the **host's** player
dies, the still-alive client reads `menus.screen "death"` with
`alive: true, health: 110`. That is not only a UI state:

- `Progression.js:169` — `on('playerDead', () => this._endRun(false))`, unguarded.
  `_endRun` sets `this._ended = true`, calls `profile.commitRun(false, stats)` —
  which writes the permanent run record and runs the challenge pass — and emits
  `runEnd` (`Progression.js:461-471`).
- `Profile.js:443` — `on('playerDead', () => { if (this.run) this.run.died = true; })`,
  unguarded, so the client's run is marked as a death it did not have.
- `HUD.onDeath` raises the summary screen, which is what the measurement sees.

Because `_endRun` is idempotent on `_ended`, **the client's own death later is a
no-op**: the record that gets written is the one taken at the moment the
teammate died. In a two-player game the first death ends both runs and files
both records, and the survivor is left alive, mobile and looking at a summary
screen. Combined with K-5, that record says 0 damage taken and every stage
flawless.

The `victim` field this round adds to `playerDead` is exactly what these three
listeners need; the round fixed only the audio one, which is defensible on
scope, but the remaining three are one guard each on a field that now exists.

## K-3 — MAJOR, pre-existing. The `AudioParam` throw is not a missing sound; it aborts event dispatch on the client

**Rank 3 of 3 by blast radius, but it is the cheapest to fix and it is not what
the report describes.**

`sanitise` turns a Vector3 into an **array** (`NetHost.js:285`), and
`Audio`'s `kill` listener calls `this.death(p?.position || …)`
(`Audio.js:209-212`) which reads `.x` off it, giving `NaN` at
`Audio._out` (`Audio.js:536`). Reproduced in **every** arm including `pre`, on
every forwarded enemy death, exactly as the fixer says; the physics critic's
"unreproduced" is superseded.

What the report calls "one line in `NetClient._resolve` or in `Audio.death`"
misses the consequence. `EventBus.emit` has no `try`/`catch`
(`Engine.js:261-265`): `for (const fn of set) fn(payload);`. A throwing listener
therefore **aborts the whole dispatch**, and everything registered after `Audio`
never runs. Registration order is fixed by `main.js`: `Progression` (55),
`VFX` (59), **`Audio` (60)**, `Coop` (65), `HUD` (66) — and `Profile`'s
listener is registered inside `Progression.init`, so it is upstream and safe.
Downstream and starved on every co-op client, for every replicated enemy death:

- `HUD.js:167` — the kill counter and the reticle kill-pulse.
- Anything any future system registers for `kill` after `Audio`.

The stack ends at `NetClient._onMessage` → `peer.onMessage` → `ch.onmessage`, so
the damage is bounded to the remaining listeners of that one event rather than
to the message pump. It is still a silent, permanent, per-kill failure of a
listener chain, and it is one line away.

**Measured, not inferred** (`blast-fixed.json`, fixed tree, two real pages).
Four director enemies killed outright on the host, so four real `kill` events
cross the wire:

| | host | client |
|---|---|---|
| enemies killed | 4 | — |
| `kill` events emitted locally | 4 | **4** |
| `Audio.death` calls | — | **4** |
| `Audio.death` **throws** | — | **4 of 4** |
| `Progression` kill count (registered *before* `Audio`) | 4 | **4** |
| `kill` events reaching a listener registered *after* `Audio` | — | **0 of 4** |
| `HUD.stats.kills` | 0 → **4** | 0 → **0** |

Both ends of the dispatch chain in one table: upstream of `Audio`, 4 of 4;
downstream, **0 of 4**. The client's HUD kill counter sits at zero for the whole
session while the host's tracks the fight.

---

# 9. What the round did not fix

## 9.1 F-11 — deferred. The judgement is right and the warning is right

The fixer defers F-11 and warns that its three figures (30.198 / 30.277 /
24.240 m) are session-dependent and must not become a baseline. **The warning is correct, and I can put a number on how correct.** Same defect,
five of my sessions, `F11.gapPawnToClientStand`:

**4.189 m / 5.397 m / 3.272 m / 2.855 m / 3.443 m**

In `fixed-run1`, `Coop._spawnPawn` put the pawn at `[2, 1.406, 2]` and the
joining client stood at `[0, -1.684, 0]`. Against the physics critic's 35.811 m
and the fixer's 24.240–30.277 m, for the identical code path — an order of
magnitude apart, because my survivors idled at spawn and theirs had walked. The
spread is the whole argument: the number is where two independently-generated
single-player runs happened to leave their survivors, and nothing else. **None
of these nine figures is a baseline.**

The deferral reasoning also holds at source: nothing on the wire carries the
joiner's position (the client's first INPUT has no position field,
`NetClient._sampleInput`), and "next to the host" is the intended behaviour, so
a real fix is a placement handshake. Agreed: defer.

## 9.2 The client's reactive soundtrack — deferred. Right call, **understated scope**

The fixer's judgement is right: this is larger than a forward list and
half-doing it is worse than not doing it. My measurements agree with its
symptom, on every arm:

| | host | client |
|---|---|---|
| `musicEngine.intensity` | 0.2724 – 0.5645 | **0.0036** |
| `director.enemies.length` | 4 – 8 | **0** |
| `net.views.size` | — | 29 – 31 |

Thirty replicated entities and an empty enemy list, in the same session.

**But the scope statement is incomplete, and someone will act on it.** The
report names one dead input — `_scanSustain` over `ctx.director.enemies`. There
are three inputs to `MusicEngine.intensity` (`Music.js:314-353`) and only one of
them is alive on a client:

- `_sustain` — `_scanSustain` over `dir.enemies` (empty) with a `dir.boss` floor
  (never set on a client) and a `progression.state === 'charging'` floor (a
  client's teleporter never charges; `_tickTeleporter` is host-driven and the
  client's `stageStart` handler clears `interactables`). **Dead, three ways.**
- `arc` — `(director.difficultyCoefficient - 1) / 2.5`. `updateDifficulty` is
  called from `Director.fixedUpdate` *after* `if (!ctx.authority) return`
  (`Director.js:272-274`), so on a client it runs only at `init` and at
  `Director.reset` (a stage change). **`arc` is frozen at each stage's opening
  value instead of climbing** — not permanently zero, but not the difficulty
  clock either.
- `_heat` — `bump()` from forwarded `kill` / `bossSpawn` / `levelUp`. **Alive**,
  and decaying on a 3.5 s time constant, which is why the client reads 0.0036
  rather than 0.

The report's option 1 — register `NetViews` entities with the Director for
read-only purposes — closes `_sustain` and leaves `arc` frozen. Its option 2 —
replicate an intensity or pressure value — closes both. The two options are not
equivalent, and the report presents them as if they were. If anyone picks this
up, that is the choice they are actually making. **K-6, MODERATE**, filed
against the deferral note rather than against the code.

Separately, and to the round's credit: the F-10 forward means the client's
soundtrack now **ducks** on its own damage (`Audio.playerHurt`, cue count
0 → 1). That is a real audible change on a client and it is the first one.

## 9.3 Named as untested by the fixer, and still untested by me

Three or four peers; a peer leaving; reconnect after `Lobby.leave()`; real
latency, loss and jitter; the 21-shot capture (its default port is 5199 and the
user is playtesting on this machine — I never touched that port); whether any of
it *sounds* right. I add: nobody has driven a co-op session in which the client
kills anything, since a client's fire resolves on the host and I only ever
verified damage flowing *toward* the client.

---

# 10. The record — four numbers in the fix report its own raw files contradict

Round 4's lesson was that a number taken through a contaminated fixture escapes
into the record. The fixer applied that lesson to F-7's divergence and to
F-11's gap, correctly and unprompted. It did not apply it to its own prose.
Each of these is the report checked against the JSON it cites, not against my
measurements.

| # | report says | its own raw file says | effect |
|---|---|---|---|
| 1 | §1: "steps classified replay, 1st second — **64 / 64 = 1.000**" for `pre` | `r1/pre.json → F6_firstSecond`: `steps 76, classifiedReplay 76` | the fraction and the conclusion survive; the figure is from the deleted `diag.mjs`, presented as the `pre` arm's |
| 2 | §7: host intensity "**0.3950 – 0.4108**" | `fixed 0.395`, `pre 0.4112`, `nogate 0.319` | the stated range excludes one of its own three arms and neither bound matches |
| 3 | §2: "The **lone** `30` in every arm is Sunken Vertebra" | `fixed [30,30]`, `pre [30,30,30,30]`, `nogate [30,10,10,10]` | cosmetic, but it is a statement about its own data that is false in two of three arms |
| 4 | §9: "the arm each JSON was taken under is recorded inside it as `arm` and `substitutions`" | `r1/singleplayer.json` has **neither** key | the single-player control is the one artefact whose provenance cannot be read off the file |

None of these changes a verdict. Item 1 is the same class as round 4's three
struck numbers and item 2 would mislead anyone sizing the soundtrack work from
the report alone. **K-7, MINOR.**

**K-8, MINOR** — and this one *is* a verdict-adjacent number: F-6's ninth-second
figures (`0.613`, `186 / 480`) are session-dependent in exactly the way the
fixer correctly flagged F-11's and F-7's, and are not flagged. My sabotaged arms read 0.000 replay at second 9 — 60/60 (`pre`) and 61/61
(`preF6`) projectile ticks — because their locks had already expired. See §2.

**K-9, MINOR** — the fix round's single-player control ran only on the fixed
tree, so it shows single-player *works*, not that it *did not move*. Closed by
§7.1, which had to be run to close it.

**K-10, MINOR** — `NetHost._forwardHurt` puts `e.source` on the wire and
`sanitise` reduces an object to `{ netId }` only when `netId !== undefined`
(`NetHost.js:286`); otherwise it recurses to depth 3. An enemy that has not yet
appeared in a snapshot has no netId, so a hit from it serialises a partial
`Enemy` — including its stat block — into the payload of a per-hit, per-DoT-tick
unicast. Latent (enemies are netId'd on their first snapshot) and cheap to
close with a `?? null`. Not measured; source-derived.

---

# 11. Claim ledger

| # | claim | verdict | my number |
|---|---|---|---|
| 1 | build exit 0 | CONFIRMED | exit 0, `✓ built in 681ms` |
| 2 | session reality: `authority` true/false, `netRole client`, `myNetId 1`, `playerCount 2` | CONFIRMED | every arm's `roles` |
| 3 | both pages actually in a running game | CONFIRMED | `runningGate`: `paused false`, `_localTick 61`, both pages, every arm |
| 4 | the replay counter reads broken on a broken build | CONFIRMED | `preF6` window 1 = 60/60 replay, 0 projectile ticks |
| 5 | F-6: epoch reset happens before the first wire command | CONFIRMED | `atJoin.lastCmdTick` 454 → 5, equal to `net.tick` |
| 6 | F-6: replay fraction 1.000 → 0.000, first second | CONFIRMED | 60/60 → 0/48 |
| 7 | F-6: projectile ticks 0 → 70, first second | CONFIRMED | 0 → 48 (`projFrac` 0.000 → 1.000) |
| 8 | F-6: still 0.613 locked / 186 of 480 at second 9 | **UNVERIFIABLE as a build property** | my sabotaged arms read 0.000 and 61/61 at second 9; mechanism confirmed, duration is session-dependent |
| 9 | F-6 report table "64 / 64" | **REFUTED** against `r1/pre.json` (76/76) | — |
| 10 | F-7: host pawn 7.000 → 37.000, equal to the client | CONFIRMED | impulses `[]` → `[30,30,30]` == client `[30,30,30]`; peaks 10.150 → 40.150 == 40.150 |
| 11 | F-7: host pays 0 Rubber Soles and 0 quakes for a peer's jump | CONFIRMED | 0 and 0 fixed; 3 and 1 on `nogate` |
| 12 | F-7: `Items.onJump` sees the pawn three times on the host | CONFIRMED | 3 × `{local:false, isPawn:true}` |
| 13 | F-7: the divergence figure is an end-state gap, not comparable to 6.013 m | CONFIRMED — and itself session-dependent | 0.0000 m and 0.0348 m across my two fixed sessions |
| 14 | F-7: skipping Tectonic for a pawn is what keeps the ends equal | CONFIRMED | `nogate` host `[30,30,36]` vs client `[30,30,30]` |
| 15 | M1: teammate row unchanged at 0.48000 in both arms | CONFIRMED | 0.48000 / 0.48000 |
| 16 | M1: own death 0.48000 → 0.00240 | CONFIRMED | 0.48000 → 0.00311, `stopped true`, `musicOff true` |
| 17 | M1: identity actually crosses the wire | CONFIRMED | `victimNetId` 2 (teammate) / 1 (self) on fixed; `null`/`null` on `preM1` |
| 18 | F-10: hurt timer sentinel → 1.47 | CONFIRMED | 1033.23 → 1.48 (and 1.45 in a third session) |
| 19 | F-10: cues 0 → 1 | CONFIRMED | 0 → 1, three sessions |
| 20 | F-10: `onDamaged` barrier 0 → 21.9 | CONFIRMED | 0 → 21.84 / 22.03 |
| 21 | F-10: the `shieldBroken` half is unverified | **now VERIFIED** | 1 event, 0 extra cues, hurt timer not reset |
| 22 | F-9: peer +0 / own +500 / highest 500 | CONFIRMED | fixed 0 / +500 / 500; `preF9` (guard alone) +777 / highest 777; `pre` the same |
| 23 | single-player still works | CONFIRMED, and strengthened to "did not move" | every measured quantity identical on `sp-pre` and `sp-fixed` |
| 24 | F-11 gaps are session-dependent, do not baseline | CONFIRMED | my gap 4.189 m for the same defect |
| 25 | the client's soundtrack does not react | CONFIRMED | client `intensity 0.0036`, `director.enemies 0`, 29–31 views |
| 26 | host intensity "0.3950 – 0.4108" | **REFUTED** against its own raw (0.395 / 0.4112 / 0.319) | — |
| 27 | the reactive-soundtrack scope is `_scanSustain` | **incomplete** | `arc` is also degraded (frozen per stage); options 1 and 2 are not equivalent |
| 28 | all three declined defects are pre-existing | CONFIRMED | all three reproduce on `pre` |
| 29 | "the lone 30 in every arm" | **REFUTED** against its own raw | — |
| 30 | every JSON records its `arm` and `substitutions` | **REFUTED** — `singleplayer.json` records neither | — |

---

# 12. For whoever decides whether to ship co-op

**The fix round did what it was asked to do.** Five blockers, five closed, five
gates failed on purpose — and failed in isolation, one substitution at a time,
which is a standard nobody in this project has met before. F-6's lock is gone
at the source of the tick origin rather than papered over; F-7's regression is
reversed with the gate moved to where the effect lands rather than deleted;
M1 is fixed with a fact on the wire instead of an inference; F-10 forwards the
owner's copy of a damage event to exactly one peer rather than broadcasting it;
F-9 is one line and it is the right line. Single-player did not move, and I
checked that against HEAD rather than against a claim.

**Co-op still does not ship**, and the reason has changed shape. Before this
round the argument was five named blockers. After it, the argument is that a
co-op client is a second-class client in ways the round did not set out to fix
and, in two cases, made more conspicuous:

1. **You cannot see your own health.** (K-1) The bar reads 110/110 from join to
   death. Everything this round added — the hurt cue, the hurt timer, the
   `onDamaged` barrier — is feedback about damage the player still cannot see,
   and the barrier the client now displays does not exist on the host.
2. **Your teammate's death ends your run and files your record.** (K-2) In a
   two-player game the first death ends both sessions, and the client's own
   death afterwards is a no-op. The `victim` field this round adds is precisely
   what `Progression._endRun`, `Profile` and `HUD.onDeath` need; three guards.
3. **Every enemy death throws on the client and eats the rest of the event.**
   (K-3) One line in `NetClient._resolve` or `Audio.death`, and it is not a
   sound bug — `EventBus.emit` has no `try`/`catch`, so `HUD`'s kill listener
   and anything registered after `Audio` never runs.
4. **The run summary and the challenge tracker are wrong for a client.** (K-5)
   `Progression` and `Profile` count damage taken off `damage`, which is not
   forwarded, so a client's run reports 0 damage taken and every stage it clears
   counts as flawless — `Untouchable` and `Ironclad` for free.
5. **Tectonic Heart is still inert for a client.** (K-4) F-7 restores two of the
   three items the summary named it for, and the fix's correctness argument
   depends on the third staying inert.

Items 2, 3 and 5 are each one to three lines. Item 1 is a snapshot field. Item 4
follows from item 1 or from adding `Progression`/`Profile` to the forward path.
That is a smaller list than the one this round closed, and it is the difference
between "co-op works" and "co-op is a demo".

**If the choice is ship-or-hide today:** hide the Co-op menu entry. Not because
this round failed — it did not — but because K-1 and K-2 together mean a
client's first co-op session is played blind and ended by somebody else, and
neither was on this round's list.

**One thing to strike from the record before anyone acts on it:** the fix
report's "64 / 64", its "0.3950 – 0.4108" host intensity range, and its
ninth-second F-6 figures (`0.613`, `186 / 480`). The first two are contradicted
by the fixer's own JSON; the third is a property of one session's wire
throughput. The report's own instrument discipline is otherwise the best in
this project — it disqualified two of its own instruments in public and named
eight untested arms, one of which (`shieldBroken`) I ran and which passes —
which is exactly why these four should not travel.

---

# 13. Arms I did not test

Naming them is not a claim that they are fine.

1. **Three or four peers.** Every session here is host + one client.
   `_forwardHurt`'s owner lookup is a linear scan over `clients` that has only
   ever seen one entry, and I did not exercise it with two.
2. **A peer leaving, and reconnect after `Lobby.leave()`.** I read
   `Lobby.joinManual` and concluded the epoch reset covers reconnect by
   construction; I did not drive it.
3. **Real network conditions.** Loopback WebRTC on one machine. No latency, loss
   or jitter, so F-7's "6.013 m with real lag" is still unre-measured; only its
   zero-lag ends are.
4. **The 21-shot capture.** Not run: its default port is 5199 and the user is
   playtesting. The build is exit 0 and §7.1 covers the changed single-player
   paths, but nobody has re-shot the manifest against these edits.
5. **A client killing anything.** All my damage flows toward the client. A
   client's own outgoing damage resolves on the host and I never confirmed the
   loop closes.
6. **`Player.js:1287`'s self-kill fallback.** Unreachable without a build that
   has no `Combat`. Source-level only, in this round and the last.
7. **`Untouchable` / `Ironclad` actually unlocking on a client.** K-5's second
   half is source-derived plus a measured `damageTakenThisStage: 0` after a real
   hit; I did not clear a stage in co-op and watch the challenge fire.
8. **Whether any of it sounds right.** Still nobody has listened. `musicGain`
   and a cue count are not a cue, and that is now four rounds old.
9. **`preF6`'s F7 / F10 / M1 sections and `preF9`'s first run** — the client page
   lost its context mid-session in both. Disqualified rather than quoted; the
   quantities they would have carried are covered by `preF7`, `preF10`, `preM1`
   and the `preF9` re-run.
