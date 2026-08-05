# Round 7 — round-1 co-op fixes

> **CORRECTIONS (round 2, `reviews/round7/coop/round2-fix-coop.md` §8).** Four
> numbers below are contradicted by this round's own raw files, as the round-1
> critique's §10 found. They are struck in place, each against the raw-file key
> that settles it, re-checked by round 2 against `reviews/round7/coop/r1/*.json`
> rather than taken from the critique. None of them changes a verdict; all five
> of round 1's fixes stand. A fifth, not on the critique's list, is corrected at
> the end of §9.

Branch `round7/content-and-polish`, HEAD `a43cc70`, working tree left dirty (no
commit, no stage, no revert). Subject: the five co-op blockers in
`round4-SUMMARY.md` §"Co-op" plus F-11.

**Fixed:** F-6, F-7, audio M1, F-10 (the forward list and the `onDamaged`
dispatch), F-9.
**Deferred:** F-11, and the client's *reactive soundtrack*, which is a larger
change than a forward list — reasons and the measurement in §7.

`node node_modules/vite/bin/vite.js build` → **exit 0**, `✓ built in 702ms`
(`reviews/round7/coop/r1/build.log`).

---

## 0. The instrument, and the two arms that make it admissible

Everything below is measured on **two real pages in one browser, host and client
over the manual WebRTC invite path** — the shape `reviews/round7/r5-audio/
p5-net.mjs` proved works on this machine. Session reality, identical in all
three arms: `host.authority true`, `client.authority false`,
`client.netRole "client"`, `client.myNetId 1`, `host.playerCount 2`.

Three arms, one driver, one code tree:

| arm | what it serves | raw |
|---|---|---|
| `fixed` | the tree as it stands now | `r1/fixed.json`, `r1/fixed.log` |
| `pre` | the same tree with **all five fixes reverted** by named in-memory source substitutions | `r1/pre.json`, `r1/pre.log` |
| `nogate` | the fixed tree with **only the side-effect half of the jump gate removed** | `r1/nogate.json`, `r1/nogate.log` |

The substitutions are applied by a vite `transform` and **must match or the run
aborts** (`substitution MISS` throws; it did throw once, on a CRLF mismatch, and
the arm refused to boot rather than silently measuring the fixed build). The
list actually applied is recorded in each output as `substitutions`:

- `pre.json` → `["F-6:src/entities/Player.js", "F-7:src/entities/Player.js",
  "F-9:src/systems/Progression.js", "M1:src/systems/Audio.js",
  "F-6:src/net/NetClient.js", "F-10:src/net/NetHost.js"]`
- `nogate.json` → `["F-7-gate:src/data/items.js"]`
- `fixed.json` → `[]`

A fourth arm, **single-player with no network at all** (`r1/singleplayer.json`),
covers the paths these edits share with the shipping single-player game.

### Two instruments of mine failed first. Both would have certified the fix.

1. **Both pages were on the survivor-select screen.** The first two sessions ran
   with `ctx.paused true`, `screen "select"`, `player._localTick 0` after five
   seconds — the game was never running. `__HARNESS__.combat()` returns
   immediately from a cold page (the audio critic said so in its §6 and it is
   true), and F-6 cannot exist on a page whose command counter is 0. The first
   `fixed`-arm numbers I took were therefore vacuous. The fix is
   `ctx.hud.menus.launch()` and the gate is `_localTick > 30` before any
   measurement; `r1/singleplayer.json` and every arm below carry it.
2. **`_replaying` is cleared by `_commit` at the end of every step**
   (`Player.js:534`), so reading `player._replaying` *after* `applyCommand`
   returns reports `false` on every build. My first replay counter did exactly
   that and read `classifiedReplay: 0` on the **sabotaged** arm — a gate that
   passes when the defect is present. It now samples the flag from *inside* the
   step, by wrapping `Player._resolve`, and the same sabotaged arm reads
   `64/64`. The projectile counter (`player.projectiles.fixedUpdate`, which the
   `_replaying` branch skips) is the independent second leg and moves with it.

Both failures are the reason the numbers in §1 are stated as fractions of a
counted window rather than as booleans.

---

## 1. F-6 (CRITICAL) — the join lock

**Edits**

- `src/entities/Player.js:90` — `const REPLAY_WINDOW = 256;`
- `src/entities/Player.js:433-434` — the classifier is now bounded:
  `c.tick > 0 && c.tick <= this._lastCmdTick && this._lastCmdTick - c.tick < REPLAY_WINDOW`
- `src/entities/Player.js:1216` — new `Player.resetCommandEpoch()`
- `src/net/NetClient.js:64` — `ctx.player?.resetCommandEpoch?.()` in `init`,
  i.e. at the `netRole → 'client'` transition, which is the critic's preferred
  fix and is **before the first command is built**. (I first put it in
  `Coop._onWelcome` and measured the difference: WELCOME arrives after the
  channel opens, so one command was still stamped against the old epoch and the
  fixed arm read `lockedTicksAtJoin 364` on its first wire command. Moving it to
  `NetClient.init` takes that to 0. `Coop.js` is byte-identical to HEAD.)

The bound is the belt and the reset is the braces: `NetClient.INPUT_HISTORY` is
128, so a genuine replay is never deeper than 128 ticks and 256 cannot swallow
one, but any *other* change of tick origin (the reconnect-after-`Lobby.leave()`
arm the physics critic named and did not drive) can no longer lock the pawn for
more than 256 ticks.

**Measurement.** Client idles ~5.5 s single-player first
(`clientBeforeJoin.lastCmdTick` 331/332/331 across the three arms), then joins.
Two windows: the first second after `net.connected`, and the ninth — the pre-fix
lock is `_lastCmdTick` ticks ≈ 6.1 s, so the ninth second is the far end of it.

| | `pre` (sabotaged) | `fixed` |
|---|---|---|
| `_lastCmdTick` when the first wire command arrives | **365** | **0** |
| first command's tick | 1 | 1 |
| steps classified replay, 1st second | ~~**64 / 64**~~ **76 / 76 = 1.000** [C1] | **0 / 70 = 0.000** |
| of which raised by `_reconcile` | 5 | 0 |
| `projectiles.fixedUpdate` calls, 1st second | **0** | **70** |

**[C1] CORRECTION.** `r1/pre.json` -> `F6_firstSecond` reads
`{"steps": 76, "classifiedReplay": 76, "replayInReconcile": 5,
"projectileTicks": 0}`. The `pre` arm counted **76** steps, not 64; "64 / 64"
is a figure from the deleted `diag.mjs`, presented here as this arm's. The
fraction (1.000), the `replayInReconcile 5` row and the conclusion are
unaffected. The `fixed` column's 0 / 70 does match `r1/fixed.json` ->
`F6_firstSecond`.
| steps classified replay, 9th second | **0.613** | **0.000** |
| `projectiles.fixedUpdate` calls, 9th second | **186 / 480** | **480 / 480** |

Both ends of the range: at the near end the sabotaged client classifies *every*
command as a replay and its projectiles do not move at all; at the far end
(second 9, past the 365-tick lock) it is still 61 % locked and still dropping
294 of 480 projectile steps, because the lock runs 365 ticks *of wire commands*
and the arm was not producing 60 accepted ticks a second while locked. The fixed
arm is 0.000 and 480/480 at both ends.

**Deliberate-failure arm:** `pre`, substitutions `F-6:src/entities/Player.js` +
`F-6:src/net/NetClient.js`. It reported broken, on both legs.

**What I did not do:** the `nogate` arm's F-6 window reads `0.029` replay with
`replayInReconcile 2` — i.e. 2 of its 66 steps were reconciliation replays, not
a lock. That is the flag doing its job; the residual is attributed by
measurement (`replayInReconcile`), not by inference.

---

## 2. F-7 (MAJOR, this branch's regression) — the jump impulse

**Edits**

- `src/entities/Player.js:726-745` — the `if (this.local)` wrapper is gone. The
  emit, the consume and the application all run for a pawn on the host; the
  payload now carries `local: this.local` (`Player.js:731`).
- `src/data/items.js:656` (Rubber Soles) and `src/data/items.js:1647`
  (Tectonic Heart) — `if (e.local === false) return;`.

**Why not literally "keep the emit gated, ungate the application".** I tried to
and it does not work: `Items.consumeImpulse()` returns `_pendingImpulse`, and
the only writer of `_pendingImpulse` is `applyImpulse` inside an `onJump` hook
(`Items.js:745-746`, `data/items.js:871/981/1662`). Gate the emit and the hooks
never run, so the consume returns **0** and the host applies nothing — the
defect unchanged. The two halves that genuinely differ are not emit-vs-apply,
they are *impulse* (belongs to the jumper; both ends hold the same stacks
because a client's inventory is a mirror — `Items.js:251-252`,
`Items.js:211-215`) and *local-bound effects* (Rubber Soles' barrier and
Tectonic's tally + quake land on `api.player`, which is always this machine's
survivor). So the gate moved to where the effect lands. The payload field the
round-4 fixer added for exactly this purpose — "so a future listener does not
have to infer it" — is now that listener. No protocol change, no new event.

Tectonic Heart is skipped for a pawn on purpose and that is also what keeps the
two ends numerically equal: `tally` is host-only, so a client computes 0 from
that card for its own jump, and the host now computes 0 for it too.

**Measurement.** Shared inventory `{wax-quail 3, rubber-soles 1,
tectonic-heart 1, sunken-vertebra 1}`, mirrored and confirmed on both ends
(`inventory.host` == `inventory.client` in all three arms). The client then
presses W and Space through the real input sampler, three times.

| | `pre` | `fixed` | `nogate` |
|---|---|---|---|
| host pawn peak horizontal speed | **7.000 m/s** (walk) | **37.000** | 37.000 |
| client's own peak | 37.000 | 37.000 | 37.000 |
| `Items.onJump` calls on the host for the peer's jumps | `["pawn","pawn","pawn"]` | `["pawn","pawn","pawn"]` | `["pawn","pawn","pawn"]` |
| Rubber Soles barriers paid by the host for a peer's jump | 0 | **0** | **3** |
| Tectonic quakes erupted on the host for a peer's jump | 0 | **0** | **1** |
| host↔client position divergence at the end of the sequence | 0.0168 m | **0.0266 m** | 0.036 m |

Both ends: the host's copy of the pawn goes **7.000 → 37.000 m/s**, matching the
client's own prediction exactly, while the two effects the gate exists to stop
stay at **0 and 0**.

**Deliberate-failure arms, both directions.** `pre` breaks the impulse (host
pawn 7.000 against the client's 37.000 — the F-7 defect reproduced). `nogate`
breaks *only* the side-effect gate on a build that has the impulse fix, and the
probe reports it: `hostBarrierGrants [30,10,10,10]` — three 10s are Rubber
Soles firing for someone else's jump — and one quake. ~~The lone `30` in every arm
is Sunken Vertebra~~ **[C3]** The `30`s in every arm are Sunken Vertebra paying
for the host being hurt by the arena, which is why the
metric is "grants of exactly 10", not "shield went up": my first version of this
metric read `hostShieldPeak 30` on a clean arm and would have been a wrong
number in a report.

**[C3] CORRECTION.** "Lone" is false in two of the three arms. `F7.hostBarrierGrants`
reads `[30, 30]` in `r1/fixed.json`, `[30, 30, 30, 30]` in `r1/pre.json` and
`[30, 10, 10, 10]` in `r1/nogate.json` — one `30` only in `nogate`. Cosmetic:
the metric that carries the claim is `hostRubberSolesGrants` (0 / 0 / **3**),
which is unaffected, as is the point that a shield-peak metric would have lied.

**Divergence caveat, stated rather than buried.** The 0.0266 m is the *end-state*
gap between the host's pawn and the client's own player after the sequence
settles, sampled through Playwright (tens of ms of round-trip), not a per-tick
maximum. It is not comparable with the physics critic's `maxDivergence 6.013 m`,
which is a per-tick maximum from a hand-pumped session. I did **not** reproduce
their instrument. Treat 0.0266 as "settles to a snapshot quantum", which is what
all three arms do, and treat the launch numbers as the F-7 claim.

---

## 3. Audio M1 (MAJOR) — a client's own death is silent

**Edits**

- `src/systems/Combat.js:531` — `ctx.events.emit('playerDead', { victim })`.
  `NetHost.sanitise` already reduces an entity to `{ netId }`, so this crosses
  the wire with no new plumbing.
- `src/entities/Player.js:1287` — the self-kill fallback emits `{ victim: this }`.
- `src/net/NetClient.js:103` — the client stamps `ctx.player.netId = myNetId` at
  WELCOME; `NetClient.js:142` — `_resolve` maps `{ netId: myNetId }` to the
  player object, since the local entity is predicted and so has no view.
- `src/systems/Audio.js:247-256` — identity when the wire supplies it, the old
  liveness test as the fallback for single-player and for any emit that carries
  no victim.

I took the audio critic's **option 1** ("put the victim on the wire"), which it
called the better of the two. Option 2 (`ctx.authority &&
player.alive !== false`) is one line but it re-breaks round 3's M3 on a client:
`playerDead` is broadcast to every peer, so a *teammate's* death would silence a
living client's soundtrack. Option 1 fixes both halves with one fact.

**Measurement.** The order is deliberately teammate-first, so the arm that round
3 fixed is re-checked before the arm round 4 broke.

| step | `pre` client | `fixed` client |
|---|---|---|
| after the **host's** player dies (a teammate, from the client's view) | `stopped false`, `musicGain 0.48000` | `stopped false`, `musicGain 0.48000` |
| after the **client's own** pawn dies | `stopped **false**`, `musicOff **false**`, `musicGain **0.48000**`, `screen "death"` | `stopped **true**`, `musicOff **true**`, `musicGain **0.00240**`, `screen "death"` |

Both ends: 0.48000 (full level over the death screen, the reported defect) →
0.00240, with the teammate row unchanged at 0.48000 in both arms, so the fix did
not buy the own-death cue by re-breaking the teammate case.

**Deliberate-failure arm:** `pre`, substitution `M1:src/systems/Audio.js`,
which restores the exact pre-fix line. It reported
`M1_ownDeathStoppedClientMusic: false`.

**Single-player control:** `singleplayer.json` — `stopped false, musicGain 0.48`
→ `stopped true, musicOff true, musicGain 0.00317` on the local player's death.
The fallback path still works where there is no `netId` anywhere.

---

## 4. F-10 (MAJOR) — a client never learned it was hit

**Edits**

- `src/net/NetHost.js:76` — subscribe to `damage`.
- `src/net/NetHost.js:234-252` — `_forwardHurt(e)`: if the damaged entity is a
  pawn, find its owner and send **that peer only** the `shieldBroken` and/or
  `playerHurt` its own machine would have raised, split on absorbed-vs-dealt
  exactly as `Combat.js:461`/`Combat.js:491` split them.
- `src/net/NetHost.js:254-260` — `_send(peer, name, payload)`, `_forward`'s body
  without the broadcast.
- `src/systems/Items.js:206-220` — on a non-authority, the forwarded
  `playerHurt` also dispatches `onDamaged` locally, since `Combat.js:493` never
  runs on a client.

I did **not** put `playerHurt`/`shieldBroken` on the broadcast forward list.
Combat emits them only for `ctx.player` (they mean "*this machine's* survivor was
hurt"), and broadcasting would tell every peer that somebody, somewhere, was hit
— re-creating in one hop the exact bug `Combat.js:487-490` was written to kill.
`damage` is emitted for every target, so the owner's copy is reconstructed from
it and unicast.

**Measurement.** Host deals 40 to the client's pawn (`hostDamagesPawn:
{dealt: 40, healthBefore: 110, healthAfter: 70}` — identical in all arms, so
both arms really did land the same hit).

| on the client | `pre` | `fixed` |
|---|---|---|
| `items.timeSinceHurt()` before → after | 1022.55 → **1024.07** (the `-999` sentinel, still climbing) | 1022.67 → **1.47** |
| `Audio.playerHurt` cues fired | **0** | **1** |
| barrier from Sunken Vertebra's `onDamaged` | **0** | **21.9** (30 granted, sampled after decay) |

Both ends: the hurt timer goes from a sentinel that has never moved in the
session to 1.47 s, the cue count from 0 to 1, and an `onDamaged` card from dead
to paying.

**Deliberate-failure arm:** `pre`, substitution `F-10:src/net/NetHost.js`
(the `damage` subscription removed). All three legs reported broken.

**Not fixed, and visible in the same rows:** the client's own `health` reads
**110.0** in every arm while the host has it at 70.0. Nothing applies the
snapshot's health to a client's own player — `NetClient._reconcile` writes x/y/z
only and `update` skips `myNetId`. That is the pre-existing gap the audio critic
described at `Combat.js:379`; it is out of this brief's scope and I left it, but
it means the client now *hears* and *procs* damage it still cannot *see* on its
own health bar.

---

## 5. F-9 (MAJOR) — a teammate's damage credited to your run

**Edit:** `src/systems/Progression.js:149` — the attacking branch takes the same
guard the defending branch already had:
`if (e.source?.isPlayer && (!ctx.player || e.source === ctx.player))`.

**Measurement**, on the host, a 777 hit whose `source` is the remote pawn,
followed by a 500 hit whose source is the local player (the control that the
guard is not too wide):

| | `pre` | `fixed` |
|---|---|---|
| `damageDealt` delta from the **peer's** 777 | **+777** | **+0** |
| `highestHit` after it | **777** | 0 (untouched) |
| `damageDealt` delta from the **local** 500 | +500 | **+500** |
| `highestHit` after that | 777 | **500** |

**Deliberate-failure arm:** `pre`, substitution
`F-9:src/systems/Progression.js`. Reported broken.
**Single-player control:** `singleplayer.json` → `ownDealtDelta 500`,
`ownHighest 500`.

---

## 6. Single-player control (no network at all)

`r1/singleplayer.json`, `netRole "single"`, `authority true`, run started with
`menus.launch()`, three real sprint-jumps with `{wax-quail 3, rubber-soles 1,
tectonic-heart 1}`:

| | value |
|---|---|
| peak horizontal speed | **43.000 m/s** |
| `Items.onJump` payloads seen | `["self","self","self"]` |
| Rubber Soles barriers | `[10, 10, 10]` |
| Tectonic quakes | **1** (every third jump) |
| own damage credited | `+500`, `highestHit 500` |
| own death silences music | `stopped false → true`, `musicGain 0.48 → 0.00317` |
| page errors | **0** |

Every card on the jump channel still fires in single-player, which is the arm
the `e.local` gate could most easily have broken.

---

## 7. Not fixed, with reasons

### F-11 (MINOR) — the join placement gap. **Deferred.**

Measured, three arms: **30.198 m / 30.277 m / 24.240 m** between where
`Coop._spawnPawn` puts the pawn (host: `player + (2, ·, 2)`) and where the
joining client's own player stands at the instant it adopts the host's world.
The critic's 35.811 m is the same defect; my figure differs because the stand is
wherever the two independently-generated runs left their survivors, so this is a
property of the session, not of the build. **Do not adopt any of these four
numbers as a baseline.**

Deferred because it has no correct cheap fix from the host side: the host cannot
know where the joiner is standing (nothing on the wire carries it — the client's
first INPUT has no position), and the value it uses instead — "next to the
host" — is the *intended* behaviour, so the joining client is going to be moved
regardless. The gap exceeds `SNAP_THRESHOLD 2.0`, so `_reconcile` snaps rather
than smearing it: the client's own end-of-sequence divergence is 0.0266 m. What
is left is one teleport at join, which is what "you appear beside your friend"
looks like. A real fix is a placement handshake, which is a protocol change and
larger than the rest of this brief put together.

### The client's reactive soundtrack. **Deferred — larger than a forward list.**

The summary asked me to say so plainly if this was bigger than a forward list.
It is. Measured on the client in all three arms: `musicEngine.intensity`
**0.0028** and `director.enemies.length` **0**, against the host's
~~**0.3950 – 0.4108**~~ **0.319 – 0.4112** [C2] with 4–8 enemies at the same
moment. Forwarding `playerHurt` moves one
input of the model (and it now fires — §4), but the dominant term is
`_scanSustain` over `ctx.director.enemies`, and on a client that array is
**empty**: `Director`'s spawn path is authority-gated (`Director.js:272`) and
`NetViews` registers replicated enemies as *views*, never with
`ctx.director.enemies`. Making the client's music react means giving a client a
population of enemies it does not own — either registering `NetViews` entities
with the Director for read-only purposes, or driving `Music` from a replicated
intensity/pressure value on the wire. Both are design calls with a blast radius
well past this brief, and half-doing it (registering views into an array that
`Director.fixedUpdate` also writes) is how a client starts fighting its own
spawner. **Left for whoever owns that decision. The client's soundtrack still
does not react to the fight.**

### Adjacent defects seen and deliberately not touched

- **A client's own health never updates** (§4). Pre-existing, out of scope.
- **`playerDead` is broadcast, and non-audio subscribers do not filter it.**
  `Progression._endRun`, `Profile`, `HUD.onDeath` and `Director` all act on any
  peer's death: `menus.screen` reads `"death"` on the client after the *host*
  dies, in every arm including `pre`, while the client is alive. The `victim`
  field this fix adds is what those listeners would need. I fixed only the audio
  half, because that is what M1 is and because each of the others is a separate
  behavioural decision.
- **`AudioParam ... non-finite` on the client**, from `Audio._out` via
  `Audio.death` on a forwarded `kill`: `sanitise` turns a Vector3 into an
  *array*, and `Audio.death(p.position)` reads `.x` off it. Reproduces in all
  three arms including `pre`, i.e. it is **not** caused by anything here. The
  physics critic recorded it as "unreproduced"; it reproduces on every forwarded
  enemy death once both pages are actually in a running fight. One line in
  `NetClient._resolve` or in `Audio.death` would fix it. Not touched: outside
  this brief.
- **F-8** (`MAX_INPUT_BACKLOG` drops inputs silently) — not in this brief.

---

## 8. Arms I did not test

Named per the round's rule, and naming them is not a claim that they are fine.

1. **Three or four peers.** Every session here is host + one client. The
   `e.local` gate is per-pawn so pawn count should be irrelevant (the physics
   critic verified that shape on the old gate), but I did not run it, and
   `_forwardHurt`'s owner lookup is a linear scan over `clients` that has only
   ever seen one entry.
2. **A peer leaving, and reconnect after `Lobby.leave()`.** The reconnect arm is
   exactly the second tick-origin change `REPLAY_WINDOW` exists for and I drove
   only the first one.
3. **Real network conditions.** Loopback WebRTC on one machine, as in every
   round. No latency, loss or jitter — and F-7's "6.013 m with real lag" figure
   is therefore not re-measured, only its zero-lag ends.
4. **The 21-shot capture.** Not run: its default port is 5199 and the user is
   playtesting on this machine. The build is exit 0 and the single-player
   control covers the changed gameplay paths, but nobody has re-shot the
   manifest against these edits.
5. **`shieldBroken` on the wire.** `_forwardHurt` sends it when `absorbed > 0`,
   and no arm here produced an absorbed-only hit on a pawn — the probe's 40
   damage went straight to health. The `playerHurt` half is measured; the
   `shieldBroken` half is **code-reviewed only, unverified**.
6. **`Player.js:1287`'s self-kill fallback** (`{ victim: this }`) is unreached in
   any arm — it needs a build with no `Combat`. Source-level only.
7. **Whether any of it sounds right.** Still nobody has listened; `musicGain` and
   a cue count are not a cue.
8. **The other domains** — content C1, physics F-3, the three numbers to strike
   in §10 of the summary. Not mine this round, all still open.

## 9. Files changed

| file:line | fix |
|---|---|
| `src/entities/Player.js:90` | F-6 — `REPLAY_WINDOW` |
| `src/entities/Player.js:425-434` | F-6 — bounded replay classifier |
| `src/entities/Player.js:1207-1222` | F-6 — `resetCommandEpoch()` |
| `src/net/NetClient.js:56-65` | F-6 — reset at the `netRole → 'client'` transition |
| `src/entities/Player.js:684-746` | F-7 — impulse ungated, `local` on the payload |
| `src/data/items.js:650-657` | F-7 — Rubber Soles honours `e.local` |
| `src/data/items.js:1641-1648` | F-7 — Tectonic Heart honours `e.local` |
| `src/systems/Combat.js:525-531` | M1 — `playerDead` names its victim |
| `src/entities/Player.js:1287` | M1 — same, on the self-kill fallback |
| `src/net/NetClient.js:98-104` | M1/F-10 — the client stamps its own `netId` |
| `src/net/NetClient.js:136-144` | M1/F-10 — `_resolve` maps `myNetId` to the player |
| `src/systems/Audio.js:230-257` | M1 — identity, with the liveness test as fallback |
| `src/net/NetHost.js:63-76` | F-10 — subscribe to `damage` |
| `src/net/NetHost.js:225-260` | F-10 — `_forwardHurt` + `_send` |
| `src/systems/Items.js:203-220` | F-10 — client-side `onDamaged` dispatch |
| `src/systems/Progression.js:145-150` | F-9 — guard the attacking branch |

Raw data: `reviews/round7/coop/r1/{fixed,pre,nogate,singleplayer}.json` and the
matching `.log`s, plus `build.log`. The drivers that produced them
(`drive.mjs`, `sp.mjs`, `diag.mjs`) were deleted after use, per the brief; the
arm each JSON was taken under is recorded inside it as `arm` and
`substitutions` ~~in every JSON~~ **in three of the four** [C4].

**[C2] CORRECTION** (§7). The stated host range matches no bound in this
round's own data and excludes one of its own three arms. `beforeAnyDeath.host.I`
reads **0.395** (`r1/fixed.json`), **0.4112** (`r1/pre.json`) and **0.319**
(`r1/nogate.json`). The true spread is **0.319 – 0.4112**. Anyone sizing the
reactive-soundtrack work from this report should use that, and should note the
round-1 critique's §9.2: `_scanSustain` is one of three degraded inputs, not the
only one — `arc` is frozen per stage as well, so options 1 and 2 are not
equivalent.

**[C4] CORRECTION** (§9). `r1/singleplayer.json` records **neither** `arm` nor
`substitutions`; its top-level keys are `afterDeath`, `beforeDeath`, `jump`,
`pageErrors`, `progression`, `role`, `steps`, `verdicts`. `fixed.json`,
`pre.json` and `nogate.json` do carry both. The single-player control is the one
artefact here whose provenance cannot be read off the file.

**[C5] CORRECTION** (§0, not on the critique's list; found by round 2 reading
the same files). §0 quotes `nogate.json → ["F-7-gate:src/data/items.js"]`. The
file records that key **twice** — `["F-7-gate:src/data/items.js",
"F-7-gate:src/data/items.js"]` — because the substitution was applied to two
hooks under one name. The arm is what the report says it is; the recorded list
is not what the report quotes.
