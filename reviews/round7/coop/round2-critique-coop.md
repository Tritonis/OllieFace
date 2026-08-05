# Round 7 — round-2 critique, co-op fixes
## Independent review of the second uncommitted co-op fix round on `round7/content-and-polish` @ `a43cc70`

Subject: `reviews/round7/coop/round2-fix-coop.md` and the working-tree edits to
`src/core/Engine.js`, `src/net/NetClient.js`, `src/net/NetHost.js`,
`src/systems/Audio.js`, `src/systems/Progression.js`, `src/systems/Profile.js`,
`src/systems/Director.js`, `src/systems/VFX.js`, `src/ui/HUD.js`,
`src/world/realms/Realms.js` — sitting on top of round 1's edits to
`src/entities/Player.js`, `src/systems/Combat.js`, `src/systems/Items.js`,
`src/data/items.js`.

Nothing in `src/` was modified. Every sabotaged arm was built by named
in-memory source substitution inside a vite `transform`; a substitution that
does not match exactly once throws and the arm refuses to boot. My raw JSON is
under `reviews/round7/coop/r2-critique/`. The drivers were deleted after use;
their output and logs were not. **I did not read the fixer's JSON as evidence.**
I read its report to know what it asserts, measured every number again with my
own instruments on my own arms, and then compared its prose against its own raw
files as a separate check.

`node node_modules/vite/bin/vite.js build` → **exit 0** (`✓ built in 937ms`;
re-run at the end of the review after the drivers were deleted, `✓ built in 694ms`,
exit 0 again, with both fix rounds still in the working tree and nothing staged,
committed or reverted).

---

**Verdict: the six claimed fixes PASS; co-op still does not ship.** K-1, K-2,
K-3 (both halves), K-5's accounting half, K-9 and the record corrections all
reproduce on my own instruments, and every gate fails on purpose in isolation.
The `EventBus.emit` isolation change is right, and I would keep it. Round 1's
five fixes are all still closed after round 2's edits — I re-derived all five,
which round 2 did not.

What stops this being an unqualified pass is that **the round's own success has
uncovered two larger defects than the ones it closed**, and both are one arm
away from anything it measured:

1. **When the host dies, the world stops for everybody.** `_endRun` sets
   `ctx.paused`, `Engine._frame` runs no fixed step while paused, and
   `NetHost.fixedUpdate` is the only thing that sends snapshots. Measured: the
   client's `serverTick` advances 301 → 333 → 363 → 393 before the host's death
   and then sits at **396 for four solid seconds** while `connected` stays
   `true`. K-2 correctly stops a teammate's death ending your run — and what it
   leaves you in is a frozen world you cannot finish, cannot die in and cannot
   leave except by quitting. Before K-2 the client at least got a coherent end.
2. **A client's survivor never crosses the wire.** `Coop._spawnPawn` builds
   `new Player({ local: false })`, so `Player.init` falls through to
   `ctx.survivorId` — the *host's*. Measured with the host on `ranger` and the
   client on `anvil`: the pawn on the host reads
   `survivorId "ranger", baseMax 110, moveSpeed 7, damage 12` while the client's
   own survivor reads `"anvil", baseMax 170, moveSpeed 6.5, damage 15`. K-1's
   `healthFrac × maxHealth` then maps the host's `0.6364` onto 170 and the two
   ends read **70.92 and 109.60 — a 38.68-point gap that never converges**. The
   report's stated premise for K-1 ("a client mirrors the host's inventory and
   level, so the two maxima agree") is true only while both players pick the
   same survivor, and picking one is the first thing the game asks you to do.

Single-player did not move. I ran the control on both trees with my own probe,
and mine reaches **all three** jump presses where round 2's reached two — so
Tectonic Heart's every-third `36` and its quake are re-verified as identical on
both trees, closing the leg round 2 disqualified in public.

| severity | count | ids |
|---|---|---|
| CRITICAL | 0 | — |
| MAJOR | 2 | L-1, L-2 |
| MODERATE | 3 | L-3, L-4, L-5 |
| MINOR | 4 | L-6, L-7, L-8, L-9 |

Claims re-derived, one by one, in §12: **31 confirmed**, **3 refuted**,
**2 confirmed but incomplete**, **1 unverifiable from the artefact that cites
it**.

---

# 1. Methodology, and the gates that make the rest admissible

## 1.1 Two real pages, one real wire

Every co-op number below is taken from two Chromium pages in one browser, host
and client over the manual WebRTC invite path (`Lobby.createInvite` /
`joinManual` / `acceptAnswer`). Session reality recorded in every arm's `roles`
key and identical across all of them:

```
host   { authority: true,  role: "host",   playerCount: 2, clients: 1 }
client { authority: false, role: "client", myNetId: 1,     connected: true }
```

Ports **5741–5760 only**. Port 5199 was never touched and no running process
was killed.

## 1.2 The running-game gate — blocking, and taken before the join

Every arm launches both pages with `ctx.hud.menus.launch()` and then **waits**
on

```js
c.paused === false && c.player && (c.player._localTick ?? 0) > 60
```

before any instrument is installed; an arm that fails it throws and writes no
measurements. Both pages, every one of the twenty-three sessions below:

| | host | client |
|---|---|---|
| `paused` | `false` | `false` |
| `menus.screen` | `null` | `null` |
| `player._localTick` | 61 | 61 |

(`runningGate` in every JSON.)

## 1.3 The three instruments, and why each of them can read "broken"

- **The replay counter.** `Player.prototype._commit` is wrapped and
  `this._replaying` is read *on entry* — the last moment the flag is legible,
  since `_commit`'s final statement clears it. It is proved by failing: on
  `preF6full` it reads **61 of 61** steps replayed and **0** projectile ticks in
  the first second after connect (§8.1).
- **The bus probe.** `ctx.events.emit` itself is wrapped, so the `kill` payload
  is recorded **upstream of every listener**, before any dispatch can abort.
  This is the one instrument round 2 did not have, and it is what lets me read
  the wire format on the `preEB` arm where the dispatch dies at `Audio`
  (§5, §11 row 24). The wrapper re-throws, so it cannot mask anything.
- **The jump probe.** Three sprint jumps driven through the real key handler
  (`ctx.input.keys` / `pressed`), retried while `player.grounded` is false until
  three impulses are recorded. It reaches all three presses on every arm, so it
  reads Tectonic Heart's every-third tally — the leg round 2 disqualified.
  Both ends of its own range: `[30, 30, 30]` for a client's jump, `[30, 30, 36]`
  for the host's own.

Both pages carry identical inventories granted **before** the join, while each
is still its own authority: `wax-quail` ×3 (a 30 m/s jump impulse),
`rubber-soles` (a 10-point barrier per jump), `tectonic-heart` (+6 on every
third jump), `sunken-vertebra` (a 30-point barrier when hurt). Recorded as
`inventory` in every JSON. Without them a jump records `0` and the F-7 probe
measures nothing — which is what my first pass did (§1.5).

## 1.4 Arms

Each arm is one two-page session on the tree as it stands, with a named list of
substitutions written into the JSON as `substitutions` /
`substitutionsApplied` / `substitutionsMissing`. **`substitutionsMissing` is
`[]` in all twenty-three runs.**

| arm | substitutions | what it reverts | raw |
|---|---|---|---|
| `fixed` | *(none)* | — | `main-fixed.json`, `k2c-fixed.json` |
| `preK1` | `K1-all` | K-1 entirely | `main-preK1.json` |
| `preK1death` | `K1-death` | **only** K-1's `ESTATE.DEAD` branch | `main-preK1death.json` |
| `preK1regen` | `K1-regen` | **only** K-1's `sinceDamage = 0` reset | `main-preK1regen.json` |
| `preK2` | `K2-pred` | `isLocalVictim` → `return true` | `main-preK2.json`, `k2c-preK2.json` |
| `preK3` | `K3-wire`, `K3-guard` | the wire format and the `_out` finite guard | `main-preK3.json` |
| `preEB` | the two above **plus** `EB-isolate` | + abort-on-throw restored | `main-preEB.json` |
| `preK5` | `K5-prog`, `K5-prof` | K-5's two handlers | `main-preK5.json` |
| `preK10` | `K10-null` | K-10's `null` branch | `main-preK10.json` |
| `preF6` | `R1-F6` | round 1's epoch reset **only** | `main-preF6.json` |
| `preF6full` | `R1-F6`, `R1-F6-window` | round 1's F-6, both halves | `main-preF6full.json` |
| `preF7gate` | `R1-F7-soles`, `R1-F7-tectonic` | round 1's F-7 side-effect gate | `main-preF7gate.json` |
| `preF9` | `R1-F9` | round 1's damage-credit guard | `main-preF9.json` |
| `preF10` | `R1-F10` | round 1's per-owner hurt forward | `main-preF10.json` |
| `preM1` | `R1-M1` | round 1's audio identity test | `main-preM1.json` |
| `preVictim` | `R1-victim` | round 1's `emit('playerDead', { victim })` | `main-preVictim.json`, `k2c-preVictim.json` |
| `sp-fixed` / `sp-pre` | — / all eight of round 2's | single player, both trees | `sp-sp-fixed.json`, `sp-sp-pre.json` |
| `survivor-mismatch` | *(none)* | supplementary: host `ranger`, client `anvil` | `survivor-mismatch.json` |
| `host-death-freeze` | *(none)* | supplementary: the host dies first | `host-death-freeze.json` |

**Each `pre*` arm reverts exactly one finding**, except the two deliberate
pairs: `preK3`/`preEB` differ by the `EB-isolate` substitution alone (which is
how §5 is measured), and `preF6full` is `preF6` plus one line (which is how §8.1
is measured).

The `EB-isolate` substitution is smaller than the change it reverts: it leaves
the set copy in place and turns `catch (err) { console.error(…) }` into
`catch (err) { throw err; … }`, restoring HEAD's abort-on-throw semantics
exactly and nothing else. That is the sharpest available isolation of the one
thing §5 is about.

## 1.5 Evidence I disqualified rather than shipped

- **My first `fixed` session (port 5741) recorded `clientJump.impulses
  [0, 0, 0]` and `hostPawnJump [0, 0, 0]`.** Three jumps landed and each
  consumed nothing, because neither survivor was holding a jump-impulse item.
  **Two matching arrays of zeroes would have read exactly like a passing
  equality gate and are evidence of nothing.** The arm was re-run on 5742 with
  the inventory of §1.3 and only the re-run is quoted; the first session's file
  was overwritten, so this paragraph is its only record.
- **The same first session's `F9` leg read `peerDelta 0` *and* `localDelta 0`.**
  The peer's 777 had killed the target, so the local 500 landed on a corpse and
  `applyDamage` returned 0 — a passing-looking `peerDelta 0` next to a control
  that proves nothing. Every quoted `F9` now sets the target to `1e7` health
  first and records `targetAliveThroughout`, `peerDealt` and `localDealt`, so a
  zero delta cannot be a dead enemy wearing the guard's clothes.
- **`hostOwnJump.barriers` / `.quakes` in the first re-run were double-counted**
  (`[10,10,10,10,10,10]`, `quakes 2` for three jumps) because my `addBarrier`
  wrapper was installed twice on the host page. Fixed with a single-wrap guard
  before any arm in §1.4 was run; the impulse record was never affected because
  it is the game's own `_jumpImpulses` map, not a wrapper.
- **My `preF6` arm does not fail its gate, and I say so rather than quoting
  it as one.** It reverts round 1's epoch reset only, and round 1's second
  edit — the `REPLAY_WINDOW` bound in `Player.applyCommand` — covers the same
  hole by itself. `preF6full` reverts both and fails properly. See §8.1; the
  result is a *finer* attribution than round 1's, not a weaker one.
- **`emitRate` is a weak number and I do not lean on it.** My sessions read
  1–4 emits/second because nothing much was happening; the session totals
  (`emitTotals`, 56–76 on a host, 32 on a client, for a whole two-minute
  session) are the figures I use in §5.4, and I name the heavy-fight arm I did
  not drive.
- **One `pageerror` on the host page in every co-op arm**
  (`The root document of this element is not valid for pointer lock`, from the
  harness's synthetic click) is present on every tree and every arm and is
  excluded from the error counts I read as signal. `pageErrors.host` is `1`
  in all twenty-one co-op sessions and `0` in both single-player ones.

---

# 2. K-1 — a client's own health, and its own death. CONFIRMED, and split in two

**Claim:** the client's own health tracks the host's authoritative value, and
the client enters its own death state.

## 2.1 The health leg, both ends

Host deals 40 to the pawn, then the host's copy of the pawn and the client's own
reading are sampled together eight times over two seconds (`healthSeries`):

| sample | `preK1` host pawn | `preK1` **client's own** | `fixed` host pawn | `fixed` **client's own** |
|---|---|---|---|---|
| 1 | 103.00 | **121.10** | 103.00 | **103.00** |
| 4 | 103.00 | **122.04** | 103.00 | **103.00** |
| 6 | 103.48 | **122.68** | 103.48 | **103.46** |
| 8 | 104.12 | **123.32** | 104.12 | **104.12** |

Both ends, and the failure is the shape round 1's critique described rather
than staleness: with the fix reverted the client's own reading **rises**
121.10 → 123.32 on local regeneration while the host holds the same pawn at
103 → 104.12. With the fix in, the two ends agree to **within 0.04 at every
sample** and climb together. `hostDamagesPawn` on both arms is
`{dealt: 40, healthBefore: 143, healthAfter: 103, maxHealth: 143}`.

The bar the player actually looks at is driven by this number — `HUD.js:497`
reads `p?.health` — so the fix reaches the view, which nobody had checked.

## 2.2 The death leg, isolated from the health leg

Round 2 reverted K-1 whole. I reverted its two halves separately, which
separates two facts its single arm conflated:

| on the client, after the host has killed the pawn | `preK1` (all of K-1) | `preK1death` (**only** the `DEAD` branch) | `fixed` |
|---|---|---|---|
| `player.alive` | **`true`** | **`true`** | **`false`** |
| `player.health` | **123.34** | **0** | **0** |
| `menus.screen` | `"death"` | `"death"` | `"death"` |

So the health leg alone takes the client to **0 HP and still alive** — it is the
`ESTATE.DEAD` branch, and only that branch, that stops the pawn simulating,
drops its projectiles and clears its buffs. Both halves are load-bearing and
each fails on purpose alone. **CONFIRMED.**

The death screen itself comes from the forwarded `playerDead`, not from K-1: it
reads `"death"` on all three arms. That is worth stating plainly because it
means **K-1 is not what tells the player they died** — round 1's `victim` field
is (§8.5).

## 2.3 The half that does nothing measurable — L-8

Round 2 calls the `sinceDamage = 0` reset "the half that is easy to miss" and
argues local regen "was free to climb back up between snapshots and fight the
authority twenty times a second". I reverted **only** that line:

| | `fixed` | `preK1regen` |
|---|---|---|
| max \|host pawn − client own\| over 8 samples | **0.04** | **0.06** |
| client `player.sinceDamage` across the same window | cycles 0.20 → 1.27 → 0.23 | **133.72 → 135.55**, never reset |

The mechanism is real — the flag behaves exactly as described — but **the effect
it is supposed to buy is not visible**: the snapshot overwrite at 20 Hz dominates
whatever local regen adds between snapshots, and the two ends agree just as well
without it. Filed as **L-8, MINOR**: a defensive line stated as a corrective one,
in the only latency regime anyone has measured. Under real RTT it may well earn
its place; nobody has run that arm.

## 2.4 What K-1 does not survive

K-1 is applied in `NetClient._reconcile`, which runs only on `MSG.SNAPSHOT`. §3.3
shows what happens when the snapshots stop.

---

# 3. K-2 — a teammate's death is not your run's death. CONFIRMED, both directions, plus the arm that breaks it

## 3.1 The client end, both ends of the range

Host's own player killed while the client is alive (`k2c-*.json`,
`hostDies: {hostAlive: false, hostHealth: 0}`):

| on the **client**, after the host dies | `preK2` | `fixed` |
|---|---|---|
| `player.alive` / `health` | `true` / 110 | `true` / 110 |
| `menus.screen` | **`"death"`** | **`null`** |
| `ctx.paused` | **`true`** | **`false`** |
| `progression._ended` | **`true`** | **`null`** |
| `profile.run.died` | **`null`** (run committed and cleared) | **`false`** |
| `director.enabled` | **`false`** | **`true`** |
| music `stopped` / `musicGain` | `false` / 0.48000 | `false` / 0.48000 |

The last row is the control that the guard is not too wide: round 3's M3 is
untouched on both arms. **CONFIRMED.**

## 3.2 The host end, and the control the fix must not break

Client's pawn killed while the host is alive (`main-*.json`,
`afterPawnDeath.host`):

| on the **host**, after the pawn dies | `preK2` | `preVictim` | `fixed` |
|---|---|---|---|
| `menus.screen` | **`"death"`** | **`"death"`** | **`null`** |
| `ctx.paused` | **`true`** | **`true`** | **`false`** |
| `progression._ended` | **`true`** | **`true`** | **`null`** |
| `director.enabled` | **`false`** | **`false`** | **`true`** |

And the two controls, on the `fixed` build, seconds later:

- **Your own death still ends your own run.** `main-fixed →
  afterHostOwnDeath.host`: `alive false`, `screen "death"`, `progEnded true`,
  `director.enabled false`.
- **A client's own death still ends its own run *after* a teammate has already
  died.** This is the exact scenario round 1's critique said was a no-op, and it
  is the one round 2 did not run. `k2c-fixed → afterClientOwnDeath.client`:
  `progEnded true`, `screen "death"`, music `stopped true`, `musicGain 0.00117`,
  with the payload `{victimIsSelf: true, victimNetId: 1, myNetId: 1}` — and the
  earlier teammate death still recorded as `{victimIsSelf: false, victimNetId: 2}`
  in the same array. **Exactly once, for the right death.**

## 3.3 What K-2 leaves behind — L-1, MAJOR

**The host's death stops the world for every surviving client.**

`Progression._endRun` sets `ctx.paused`; `Engine._frame` runs no fixed step
while paused (`Engine.js:230`); `NetHost.fixedUpdate` is the only thing that
builds and sends a snapshot. So the moment the host dies, the authoritative
simulation stops — for everyone.

Measured directly (`host-death-freeze.json`), the client's snapshot clock at
both ends of the range:

| | client `net.buffer.serverTick` | host `net.tick` | client `connected` |
|---|---|---|---|
| four samples **before** the host's death, 500 ms apart | **301 → 333 → 363 → 393** | 303 → 334 → 365 → 395 | `true` |
| eight samples **after** it, over four seconds | **396, 396, 396, 396, 396, 396, 396, 396** | 396 × 8 | `true` |

The feed does not degrade, it stops. The client's own page reads
`paused false`, `screen null`, `alive true`, `health 110`, 26 live views — alive
and mobile in a world where nothing will ever move again. There is no
teleporter (host-driven), no enemy motion, no health update, and no way to end
the run.

The second half is sharper still. With the host dead and paused, I killed the
client's pawn on the host. The forwarded `playerDead` still crosses (it is
raised from `Combat._kill` inside my call, not from the frame loop), so the
client gets `screen "death"`, `paused true` — but **its own player still reads
`alive: true`, `health: 110`**, because K-1 rides on snapshots and there are
none. Compare the same moment with a live host (`main-fixed →
afterPawnDeath.client`): `alive false`, `health 0`.

So: **K-1 is closed only while the host is alive**, and K-2 has converted "the
first death ends both runs" into "the first death strands the survivor". That
is a better failure than the one it replaced — the survivor's record is no
longer falsified — but it is not a shippable one. **MAJOR.**

The fix is a decision, not a line: either the host keeps simulating while dead
(spectate), or the host's death ends the session for everyone explicitly and
says so. What must not stay is a paused authority with live peers attached.

## 3.4 The guard fails open, and this round added a second way to make it — L-5, MODERATE

`isLocalVictim` (`Engine.js:303-307`) opens with `if (!victim) return true;`.
Every one of the six guards therefore reverts to its old, unguarded behaviour
whenever the payload names no victim — silently, with nothing logged anywhere.

That is not hypothetical. `preVictim` reverts round 1's one-line
`emit('playerDead', { victim })` back to `{}` and changes nothing else:

| | `fixed` | `preVictim` |
|---|---|---|
| payload seen on the host | `{victimIsSelf: false, victimNetId: 1}` | **`{victimIsNull: true}`** |
| host's run after the **pawn** dies | `screen null`, `_ended null` | **`screen "death"`, `_ended true`, `paused true`, `director false`** |
| client's music after **its own** death | `stopped true`, gain 0.00115 | **`stopped false`, gain 0.48000** |
| payload seen on the client | `{victimIsSelf: true, victimNetId: 1}` | **`{victimIsNull: true}`** |

So the whole of K-2 and the whole of round 1's M1 rest on one field, and the
failure mode when it is absent is a **complete, silent** revert of both.

This round then added a new way to produce exactly that payload. K-10's edit
(`NetHost.js:300`) serialises an entity with no `netId` as **`null`** instead of
recursing into it. Before K-10 a netId-less victim crossed as a walked object —
truthy, not `ctx.player`, so the guard held closed. After K-10 it crosses as
`null`, and the guard opens. The window is narrow (a player's `netId` is
assigned in the WELCOME for a pawn and at the first `_snapshot` for the host's
own survivor, and `_forward` returns early while `clients.size === 0`), and
**I did not measure the trigger** — only the consequence, above. It is still the
wrong default: a predicate whose job is "is this mine" should answer *no* when it
cannot tell, on a client. One line.

## 3.5 The listener count — L-6 (record)

Round 2 writes: "The critique names three listeners; there are seven, and the
other four are the same defect pointing the other way." There are seven
`playerDead` subscribers in `src/`, and **six** of them carry this round's
predicate:

| # | listener | guarded by |
|---|---|---|
| 1 | `Progression.js:183` — `_endRun(false)` | `isLocalVictim` (round 2) |
| 2 | `Profile.js:453` — `run.died = true` | `isLocalVictim` (round 2) |
| 3 | `HUD.js:223` — `onDeath()` | `isLocalVictim` (round 2) |
| 4 | `Director.js:159` — `enabled = false` | `isLocalVictim` (round 2) |
| 5 | `VFX.js:192` — the death screen effect | `isLocalVictim` (round 2) |
| 6 | `Realms.js:82` — the realm abort | `isLocalVictim` (round 2) |
| 7 | `Audio.js:247` — the soundtrack | **round 1's** netId identity test |

Three named by the critique plus **three** others, not four; the seventh was
already handled by a different predicate and is not "the same defect pointing
the other way". The report's own §12 files-changed table lists the six
correctly. The substantive claim — that the host-side direction matters and the
critique missed it — is **CONFIRMED**, and I found no eighth listener that
still needs the guard. Filed as part of **L-6**.

---

# 4. K-3 — the `AudioParam` throw. CONFIRMED at both ends, with the row round 2 could not have measured

**Claim:** the position crosses as `{x, y, z}`, `Audio.death` stops throwing,
and the `kill` chain downstream of `Audio` runs again.

Four director enemies killed outright on the host (`forcedKills: {available: 4,
killed: 4}` — the fixture check that stops a "0 of 0" reading like a passing
control). The client carries `Audio.death` call/throw counters (re-throwing, so
nothing is masked), a `kill` listener registered last, and the bus probe that
records the payload **before** dispatch:

| on the **client** | `preEB` (= HEAD's behaviour) | `preK3` | `fixed` |
|---|---|---|---|
| wire form of `position` | **`array`** | **`array`** | **`object`** |
| `Number.isFinite(position.x)` | **`false`** | **`false`** | **`true`** |
| `Audio.death` calls | 4 | 4 | 4 |
| `Audio.death` **throws** | **4 of 4** | **4 of 4** | **0 of 4** |
| `kill` reaching a listener registered *after* `Audio` | **0 of 4** | **4 of 4** | **4 of 4** |
| `HUD.stats.kills` | 0 → **0** | 0 → **4** | 0 → **4** |
| `Progression` kills (registered *before* `Audio`) | 4 | 4 | 4 |
| client page errors | **6** | **0** | **0** |
| client `[events] listener threw` console errors | **0** | **6** | **0** |
| host `HUD.stats.kills`, same session | 4 | 4 | 4 |

Both ends, and round 1's critique's exact table reproduced on `preEB`: 4 of 4
upstream, **0 of 4** downstream, the client's HUD counter stuck at zero while
the host's tracks the fight. **CONFIRMED.**

The first two rows of the `preEB` column are the ones round 2 states and cannot
support. Its probe read the payload from a listener registered *after* `Audio`,
so on `preEB` that listener never ran and `main-preEB.json` records
`killPayloads: []`. Those two cells are inferences from the substitution list
presented inside a measurement table. My bus probe sits upstream of the abort,
so I can read them: `array` / `false`, four times. Filed as part of **L-6**;
the conclusion is unchanged and now measured.

Fixing the encoder rather than one reader is the right call and it closes
`VFX._onKill → Vector3.copy` at the same time; my `killWire` shows
`posType: "object", posXFinite: true` for every kill on every fixed arm,
including the two player deaths.

---

# 5. `EventBus.emit` — the isolation change. CONFIRMED, and I would keep it

This is the only change in two rounds that alters shared infrastructure every
subsystem depends on, so it gets the hardest look.

## 5.1 It does what it claims, measured in isolation

`preK3` and `preEB` differ by the `EB-isolate` substitution alone, on the same
broken-throw build:

| | `preK3` (throw present, isolation **in**) | `preEB` (throw present, isolation **reverted**) |
|---|---|---|
| `Audio.death` throws | 4 of 4 | 4 of 4 |
| `kill` reaching a downstream listener | **4 of 4** | **0 of 4** |
| client `HUD.stats.kills` | **4** | **0** |
| client page errors | **0** | **6** |
| client `[events] listener threw` on the console | **6** | **0** |

Identical throw, opposite dispatch outcome, at both ends. **CONFIRMED.**

## 5.2 The loudness argument — tested, and it holds

Round 2 argues the `console.error` keeps the loudness fail-fast was supposed to
buy and never did. I tested the two halves of that separately.

**Does a throwing listener actually surface?** Yes, one message per throw, with
the real stack:

```
[events] listener threw for event: kill TypeError: Failed to set the 'value'
property on 'AudioParam': The provided float value is non-finite.
    at Audio._out (…/src/systems/Audio.js…)
```

Six throws, six messages, on `preK3` (`listenerThrewLogs.client: 6`). Zero on
every fixed arm. It is a 1:1 mapping, not a sample.

**Does the loudness reach anything automated?** Yes, and this is the part
round 2 does not say. `tools/capture.mjs:254` already collects
`page.on('console')` errors into the *same* `errors` array as
`page.on('pageerror')` (`:255`), and prints them under `FIRST ERRORS`. So the
change moves a failure from one bucket of that array to the other bucket of the
same array, and the project's own capture harness reports it with the same
weight it did before. Fail-fast bought nothing here that `console.error` does
not: K-3 was a silent, permanent, per-kill failure for two rounds and a
previous critic recorded it as unreproduced.

**Do the other listeners genuinely survive?** Yes: `downstreamKill` 4 of 4 and
`HUD.stats.kills` 0 → 4 on `preK3`, against 0 and 0 on `preEB`.

## 5.3 The risks, including two round 2 does not name

- **No caller depends on `emit` throwing.** I checked the same way round 2 says
  it did and agree: across 92 `emit` call sites in `src/`, none appears within
  six lines below a `try {`. CONFIRMED.
- **The set copy makes `off()` from inside a handler safe** — true, and
  currently unexercised: there are **no `.off()` call sites in `src/` at all**
  outside `EventBus` itself. So the stated benefit is theoretical today.
- **Unnamed risk 1: the copy also changes the other direction.** A listener
  removed by another listener *during* a dispatch used to be skipped and now
  still runs. With no `off()` call sites this is unreachable today, but it is a
  semantic change the report presents as one-directional.
- **Unnamed risk 2: a listener *added* during a dispatch of the same event no
  longer receives that event.** `for (const fn of set)` on a `Set` visits
  entries added mid-iteration; `for (const fn of [...set])` does not. I found no
  such registration in `src/`, so nothing changes today.
- **Log flood.** A listener that throws on a per-frame event now logs every
  frame. Accepted and stated by the report; §5.4 bounds it.

## 5.4 What it costs

`emit` is not a hot path. Measured session totals over a complete two-minute
co-op session (`emitTotals`): **56 emits on the host, 32 on the client**
(`main-fixed`), 76/32 on the busiest arm, 60–62 in a whole single-player
session. The busiest single name is `challengeProgress` at 25. One small array
allocation per emit, at tens per session, is not a cost worth discussing.

**The arm I did not drive:** a heavy fight. `damage` is emitted per damage
instance, so twenty enemies trading hits could plausibly push `emit` into the
low hundreds per second — still two orders of magnitude below anything that
matters for a spread of 3–8 listeners, but I measured quiet sessions and say so.

**Verdict on the isolation change: keep it.** It is correct, it is measured at
both ends, its loudness lands in the project's own error bucket, and its cost is
not measurable. It is also the right call independently of K-3: `preEB` is the
difference between one broken listener and a broken build.

---

# 6. K-5 — the accounting half is closed; the other half is not — L-3, MODERATE

**Claim (§7):** a client books its own damage taken.

| on the **client**, after the same real 40-damage hit | `preK5` | `preF10` | `fixed` |
|---|---|---|---|
| `progression.stats.damageTaken` | **0** | **0** | **40** |
| `profile.run.damageTaken` | **0** | **0** | **40** |
| `profile.run.damageTakenThisStage` | **0** | **0** | **40** |
| `items.timeSinceHurt()` | 2.05 | **1021.40** (sentinel) | 2.05 |
| `Audio.playerHurt` cues | 1 | **0** | 1 |

Both ends. On `preK5` the client *felt* the hit (hurt timer 2.05, one cue) and
recorded none of it, which is the defect exactly. **CONFIRMED**, and the
`preF10` column is the dependency nobody stated: **K-5 rides entirely on round
1's F-10 forward** — revert F-10 and K-5's three counters go to zero with it.

The host does not double-count: `main-fixed → afterHit.host` reads
`progDamageTaken 20.17` from real arena chip damage, unchanged by the pawn's 40.

## 6.1 What is still open

Round 1's K-5 has two halves. The report closes the first, files K-5 as
**Closed** in its header, and does not mention the second anywhere.

The second half is that the client's own `onDamaged` dispatch creates state the
host does not have. Measured on the fixed tree, sampling both ends of the same
pawn across two seconds (`survivor-mismatch.json → healthSeries`):

| sample | client's own `shield` | host's copy of the same pawn, `shield` |
|---|---|---|
| 1 | **28.02** | **0.00** |
| 4 | **21.36** | **0.00** |
| 8 | **12.43** | **0.00** |

Twenty-eight points of Sunken Vertebra barrier on the client's bar — and the HUD
extends the health track by the shield, so the player sees it — absorbing
nothing, because the host resolves every hit against a pawn whose shield is
zero. The same shape holds on every co-op arm (`afterHit.client.shield` 15.10 –
20.68 on fifteen arms, `0` on `preF10`).

Filing a two-part finding as Closed when one part is untouched and unmentioned
is the problem, not the deferral. **MODERATE.**

---

# 7. K-4, K-6, K-8, K-10, F-11 — the deferrals, adjudicated

## 7.1 K-4 (Tectonic Heart) — the deferral is right; the costing is not — L-9

The assessment is correct and I verified every leg of it at source:

- `Items.tally` returns `false` on a non-authority (`Items.js:644`), so a client
  can never fire the card for its own jump. ✔
- Round 1's `if (e.local === false) return;` (`data/items.js:1647`) means the
  host never fires it for the pawn. ✔
- Forcing it breaks F-7's measured equality. **Measured, not argued:**
  `preF7gate` (round 1's gate reverted, on round 2's tree) reads the host
  applying **`[30, 30, 36]`** to the pawn while the client predicts
  **`[30, 30, 30]`** — 6 m/s of permanent divergence on every third jump — plus
  `barriers [10, 10, 10]` and `1` quake paid by the host for a jump 25 m away.
  Against `fixed`: pawn `[30, 30, 30]` == client `[30, 30, 30]`, host side
  effects `[]` and `0`. ✔
- The two reachable states really are "inert for a client" and "6 m/s of
  divergence", and inert is the right one. ✔

The two-part alternative is the right shape. One correction to its costing: the
report says re-keying `tally(key, every, owner)` means "touching every card that
uses it". **Three** cards use `tally` — `frost-lattice`, `resonance-coil`,
`tectonic-heart` — and an optional third parameter defaulting to the local
survivor is backward compatible, so the change is three call sites and one
method, not a sweep. The `api.jumper` half is the real work and the report is
right about that. **L-9, MINOR**, against the estimate, not the decision.

I also went looking for a cross-talk bug the shared `Items._pendingImpulse` slot
invites — two players jumping in the same tick, one consuming the other's
impulse — and it is not there: `Player._jump` emits `jump` and calls
`consumeImpulse()` on the next line, synchronously (`Player.js:731-734`). No
finding.

## 7.2 K-6 (the reactive soundtrack) — deferred, scope statement CONFIRMED

Round 2 restates the scope as three inputs, one alive. Verified at source:
`MusicEngine.intensity` (`Music.js:314-353`) blends `arc`, `_sustain` and
`_heat`; `Director.fixedUpdate` returns for a non-authority at `Director.js:275`
**before** `updateDifficulty(ctx)` at `:277`, so `arc` is frozen per stage on a
client. ✔ Measured: `director.enemies` is **0** on the client against 1–2 on the
host in every arm, and the client's `intensity` before any fight is **0.0032**.

And I can close the measurement round 2 explicitly declined. Its §11.1 says
K-3's closure now feeds `_heat` four times as often but "I did not measure the
resulting `intensity`". After four kills, on the client:

| | `preEB` | `preK3` | `fixed` |
|---|---|---|---|
| client `musicEngine.intensity` | **0.1422** | **0.1424** | **0.2619** |
| host `musicEngine.intensity`, same moment | 0.3886 | 0.3900 | 0.3659 |

Two independent broken-throw sessions agree to four decimals and the fixed tree
is 84 % above them, with the host's own intensity within 7 % across all three —
so the fight was comparable and the difference is the four `musicEngine.bump`
calls that now survive. **The side effect is real and it is worth about +0.12
of intensity on four kills.** Still a fraction of the host's, which is K-6.

## 7.3 K-8 — round 2's refusal to strike is correct

`r1/pre.json → F6_ninthSecond` reads
`{steps: 480, classifiedReplay: 294, replayInReconcile: 0, projectileTicks: 186}`.
294 / 480 = 0.6125, and 480 − 186 = 294 projectile steps dropped. Both of round
1's figures are true readings of its own file. **Striking them would have put a
new wrong number in the record; re-statusing them as session-dependent is the
right disposal.** Round 2's adjudication is CONFIRMED, and its admission that it
did not re-measure F-6 at second 9 is honest. Neither did I.

## 7.4 K-10 and F-11

K-10 is a payload-size change with no behavioural signature, and my `preK10` arm
confirms that: every measured quantity matches `fixed`. Filing it as closed on a
source reading is symmetric with how the critique filed it. But §8's claim that
it is in the `sp-pre` bundle "so that the single-player control covers it" is
empty — `NetHost.sanitise` is never called in a single-player session, so the
control demonstrates nothing about K-10 either way. Part of **L-6**. Its
interaction with K-2 is §3.4.

F-11: untouched, correctly, for the reason both previous rounds give. I measured
nothing new.

---

# 8. Round 1's five fixes, re-derived after round 2's edits

Round 2 edited `NetClient.js`, `NetHost.js`, `Audio.js`, `Progression.js` and
`Profile.js` — five of the eight files round 1's fixes live in — and re-verified
**F-10 and M1 only, incidentally**, through arms aimed at other findings. F-6,
F-7-in-co-op and F-9 were not re-measured at all, and its §13 does not name that
as an untested arm. Filed as **L-6**. Here they are, all five, each with its gate
failed on purpose in isolation on round 2's tree.

## 8.1 F-6 — the join lock. CONFIRMED, and attributed more finely than before

| | `fixed` | `preF6` (epoch reset alone) | `preF6full` (both halves) |
|---|---|---|---|
| `clientBeforeJoin.lastCmdTick` | 366 | 365 | 368 |
| `_lastCmdTick` at connect | **10** | **396** | **399** |
| `net.tick` at the same instant | **10** | 5 | 10 |
| steps in the first second | 60 | 48 | 61 |
| classified replay | **0** | **0** | **61** |
| replay fraction | **0.000** | **0.000** | **1.000** |
| `projectiles.fixedUpdate` calls | **60** | 48 | **0** |

`atJoin.lastCmdTick === atJoin.netTick` on the fixed tree: the epoch is re-based
before the first wire command. **CONFIRMED.**

The middle column is the finer result. Round 1's F-6 has two edits — the
`resetCommandEpoch()` in `NetClient.init` and the `REPLAY_WINDOW` bound in
`Player.applyCommand` — and round 1's critique reverted both together. Reverting
the reset **alone** leaves the counter un-based (396 against a wire tick of 5)
and still produces **zero** replays, because the 391-tick gap exceeds
`REPLAY_WINDOW = 256` and the bound catches it. Revert both and the lock
returns at full strength: 61 of 61 steps replayed, every projectile frozen.
So round 1's belt-and-braces is measurably belt-**or**-braces, and the braces
alone are sufficient. That is a strengthening of round 1, not a weakening.

## 8.2 F-7 — the jump impulse and its side-effect gate. CONFIRMED

| | `fixed` | `preF7gate` |
|---|---|---|
| client's own jump, impulses applied | `[30, 30, 30]` | `[30, 30, 30]` |
| host's copy of the pawn's jump | **`[30, 30, 30]`** | **`[30, 30, 36]`** |
| Rubber Soles barriers the host paid for a peer's jump | **`[]`** | **`[10, 10, 10]`** |
| quakes erupted on the host for a peer's jump | **0** | **1** |
| the host's **own** jump, same session | `[30, 30, 36]`, `[10, 10, 10]`, 1 quake | `[30, 30, 36]`, `[10, 10, 10]`, 1 quake |

Both ends, and the host's own jump channel is untouched in both columns.
**CONFIRMED after round 2's edits**, and my numbers reproduce round 1's
critique's `nogate` arm exactly.

## 8.3 F-9 — a teammate's damage credited to your run. CONFIRMED

Measured on the host with a real director enemy as the target
(`usedRealEnemy: true`, `sourceWasPawn: true`, `targetAliveThroughout: true`,
health raised to `1e7` so neither hit can land on a corpse):

| | `fixed` | `preF9` |
|---|---|---|
| `peerDealt` (the pawn's hit actually landed) | 777 | 777 |
| `damageDealt` delta from the **peer's** 777 | **+0** | **+777** |
| `highestHit` after it | **0** | **777** |
| `damageDealt` delta from the **local** 500 | **+500** | +500 |
| `highestHit` after that | **500** | 777 |

Both ends, with the control on the same run showing the guard is not too wide.
**CONFIRMED.**

## 8.4 F-10 — the client's damage feedback. CONFIRMED

| on the **client** | `fixed` | `preF10` |
|---|---|---|
| `items.timeSinceHurt()` before → after | 1009.10 → **2.05** | 1021.40 (sentinel, still climbing) |
| `Audio.playerHurt` cues | **1** | **0** |
| barrier from Sunken Vertebra's `onDamaged` | **15.34** | **0** |
| `progression.stats.damageTaken` | 40 | 0 |

Both ends, four legs. **CONFIRMED**, and the last row is §6's dependency.

## 8.5 M1 — a client's own death silences its own soundtrack. CONFIRMED

| on the **client** | `fixed` | `preM1` | `preVictim` |
|---|---|---|---|
| after a **teammate's** death, music | `stopped false`, gain 0.48000 | — | `stopped false`, gain 0.48000 |
| after the **client's own** death, music | **`stopped true`**, `musicOff true`, gain **0.00117** | **`stopped false`**, gain **0.48000** | **`stopped false`**, gain **0.48000** |

Both ends, on two different sabotages: reverting the identity test (`preM1`) and
reverting the field it reads (`preVictim`) each break it the same way.
**CONFIRMED.**

**All five of round 1's fixes are still closed**, and round 1's sixth edit —
the `victim` field — is now measured as load-bearing for four separate things
(M1, K-2's six guards, and the client's own-death identity).

---

# 9. Regressions — single-player did not move, on both trees

`sp-fixed` (no substitutions) and `sp-pre` (all eight of round 2's, i.e. the
tree as round 1 left it), both `netRole "single"`, `authority true`, both
through `menus.launch()` and both past the `_localTick > 60` gate.

| | `sp-pre` (round 1's tree) | `sp-fixed` (round 2's) |
|---|---|---|
| 4 enemies killed → `progression.stats.kills` | 4 | 4 |
| `HUD.stats.kills` | 4 | 4 |
| `Audio.death` calls / **throws** | 4 / **0** | 4 / **0** |
| `kill` reaching a downstream listener | **4** | **4** |
| `kill` payload `position` type / finite | `object` / `true` ×4 | `object` / `true` ×4 |
| 40-damage hit: `dealt` | **40** | **40** |
| `playerHurt` emits over that hit | **1** | **1** |
| `onDamaged` barrier from that hit (`shield`) | **23.58** | **23.58** |
| three sprint-jumps: impulses applied | **`[30, 30, 36]`** | **`[30, 30, 36]`** |
| Rubber Soles barriers | **`[10, 10, 10]`** | **`[10, 10, 10]`** |
| Tectonic quakes | **1** | **1** |
| own death: `alive` / `screen` / `_ended` | `false` / `death` / `true` | `false` / `death` / `true` |
| own death: `director.enabled` | `false` | `false` |
| own death silences the music | `stopped true`, `musicOff true` | `stopped true`, `musicOff true` |
| `playerDead` payload | `{victimIsSelf: true}` | `{victimIsSelf: true}` |
| `[events] listener threw` console errors | **0** | **0** |
| page errors | **0** | **0** |

**Single-player did not move. CONFIRMED**, and my jump row is the one round 2
could not supply: it reaches all three presses on both trees, so Tectonic
Heart's every-third `36` and its quake are re-verified as identical rather than
never reached. Round 2 was right to disqualify its own two-press probe and right
that the round-1 critique's §7.1 was carrying that leg; it no longer has to.

**Rows that are not build-invariant and are not read as such:** `damageTaken`
and `health` after the hit (37.60 / 74.42 against 31.92 / 79.07 — arena chip
damage between probe steps), `timeSinceHurt` and `musicGain` after death (both
decaying, sampled by wall clock, 0.00254 against 0.00304), and `maxHealth`
(110 here, 143 on some co-op arms, moving with the level the director happened
to grant). Round 2 named the same three classes and was right to.

Three rows are the specific risks in this round's edits, and none fired:

- **`EventBus.emit`'s try/catch does not change single-player dispatch:**
  `downstreamKill` 4 → 5 across the run on both trees, `deathThrows 0`,
  `pageErrors 0`, and zero `[events]` console errors on both.
- **`isLocalVictim` does not suppress a single-player death:** `screen "death"`,
  `_ended true`, `director.enabled false`, music silenced, on both trees. But
  **round 2's stated reason for this is wrong.** It credits "the no-victim
  fallback (`Harness.js:5084`'s `emit('playerDead', {})`)". A real single-player
  death goes through `Combat._kill`, which names the victim: my probe records
  `{victimIsSelf: true}` on both trees, so it is the *identity* branch that
  carries single-player, not the fallback. The conclusion holds; the mechanism
  named for it does not. Part of **L-6**.
- **The client-only damage-taken handlers do not double-count on a host:** one
  40-damage hit moves `damageTaken` by 32–38 (its `toHealth` after a barrier),
  never by twice that, on both trees.

---

# 10. Two defects larger than the ones this round closed

## 10.1 L-2, MAJOR — a client's survivor never crosses the wire

Nothing in `src/net/` carries a joiner's survivor id — I grepped the whole
directory. `Coop._spawnPawn` builds `new Player({ local: false })` with no
`requestedSurvivor`, so `Player.init` (`Player.js:174`) falls through to
`ctx.survivorId`: **the host's**. Survivor base health runs 90 / 110 / 125 /
135 / 170 across the five cards, and base move speed and damage differ too.

Measured, host on `ranger`, client on `anvil`, both gated into a running game
and the arm refusing to boot unless the two ids actually differ
(`survivor-mismatch.json`):

| | `survivorId` | base `maxHealth` | `maxHealth` | `moveSpeed` | `damage` |
|---|---|---|---|---|---|
| the host's own survivor | `ranger` | 110 | 110 | — | — |
| **the host's pawn for the client** | **`ranger`** | **110** | **110** | **7.0** | **12** |
| the client's own survivor | `anvil` | **170** | **170** | **6.5** | **15** |

Two consequences, and the first is this round's:

1. **K-1 reports a number that is not the host's.** The host takes the pawn to
   `70 / 110` (`frac 0.6364`); `_applyAuthoritativeHealth` multiplies that
   fraction by the client's own 170. Eight samples, two seconds:

   | sample | host pawn | client's own | gap |
   |---|---|---|---|
   | 1 | 70.00 | **108.18** | **38.18** |
   | 4 | 70.00 | **108.18** | **38.18** |
   | 8 | 70.92 | **109.60** | **38.68** |

   The *fraction* is right, so the bar is proportionally right; the number
   beside it is 55 % too high and never converges. Compare the same probe with
   both ends on the same survivor: agreement within **0.04** at every sample
   (§2.1). So K-1 is closed for matched survivors and open for mismatched ones,
   and the report's premise for it is false in the second case.

2. **The client's prediction runs on different stats from the authority.** The
   client predicts its own movement at `moveSpeed 6.5` while the host simulates
   the pawn at `7.0`. That is a permanent mismatch in the one quantity
   prediction exists to hide, and it is upstream of everything round 1 measured
   about reconciliation. I did not measure the resulting correction rate — that
   is a named untested arm (§13) — but the two numbers are read off both ends of
   one live session.

Pre-existing, unattributable to either fix round, and unnamed by both. It is
also the largest single thing standing between this and a co-op build: **a
client does not get to play the survivor it picked.**

## 10.2 L-4, MODERATE — a client's run summary credits the host's kills

Round 1's F-9 established the convention that a teammate's damage is not your
run's damage, and this round preserved it (§8.3). The `kill` event never got the
same treatment. `Progression.on('kill')` (`Progression.js:125-132`) increments
`stats.kills` with no source filter at all, and `HUD.js:168` counts any kill
whose source is absent or `isPlayer`.

Measured with the host killing a real director enemy with **itself** as the
source, so the credit question is unambiguous (`survivor-mismatch.json`):

| | host | client |
|---|---|---|
| enemies the machine killed | 1 | **0** |
| `progression.stats.kills` before → after | 0 → **1** | 0 → **1** |
| `HUD.stats.kills` before → after | 0 → **1** | 0 → **1** |
| `progression.stats.damageDealt` after | 1 000 000 | **0** |

Reproduced on every co-op arm at four kills: the client reads `progKills 4`,
`hudKills 4`, `damageDealt 0`. So a co-op client's run record says it killed
every enemy the party killed and dealt no damage doing it — internally
contradictory, and it inflates any run-scoped kill goal. `Profile._onKill` is
already witness-gated through `_isLocalSource` (`Profile.js:1271-1276`), so the
lifetime stats are right and the run summary is not, which is the inconsistency
worth fixing. One guard, the same shape as F-9's.

Round 2 names the damage-dealt half in its §13 as the next thing to look at,
honestly. It does not name the kills half, which is the louder one because it
over-reports rather than under-reports.

---

# 11. The record

## 11.1 Round 1's report, corrections `[C1]`–`[C5]` — all five CONFIRMED

Re-derived by me from `reviews/round7/coop/r1/*.json` directly, not adopted from
either report:

| # | corrected claim | the raw file | verdict |
|---|---|---|---|
| C1 | "64 / 64" replay, 1st second, `pre` | `r1/pre.json → F6_firstSecond` = `{steps: 76, classifiedReplay: 76, replayInReconcile: 5, projectileTicks: 0}` | **correct** — 76, not 64 |
| C2 | host intensity "0.3950 – 0.4108" | `beforeAnyDeath.host.I` = 0.395 (`fixed`), 0.4112 (`pre`), 0.319 (`nogate`) | **correct** — true spread 0.319 – 0.4112 |
| C3 | "the **lone** `30` in every arm" | `F7.hostBarrierGrants` = `[30,30]` / `[30,30,30,30]` / `[30,10,10,10]` | **correct** — lone in one arm of three (`nogate`) |
| C4 | "every JSON records its `arm` and `substitutions`" | `r1/singleplayer.json` keys are `afterDeath, beforeDeath, jump, pageErrors, progression, role, steps, verdicts` | **correct** — neither key present |
| C5 | `nogate.json → ["F-7-gate:src/data/items.js"]` | the file records `["F-7-gate:src/data/items.js", "F-7-gate:src/data/items.js"]` | **correct** — the key is recorded twice |

All five are applied in place in `round1-fix-coop.md` with strikethrough and a
named raw-file key, and all five are accurate. The fifth, which the round-1
critique did not list, is a real find. **This is the cleanest record work in the
project so far.**

## 11.2 Round 2's own report against its own artefacts — L-6, MINOR

Every prior round in this project has put at least one number in its report that
its own raw files contradict. This one is much better than its predecessors —
its §3, §4, §5, §7, §9 tables and its entire §12 file:line table all check out
against `r2/*.json` and against `src/` — but it is not clean:

| # | the report says | its own artefact says | effect |
|---|---|---|---|
| 1 | §2: "Host deals an identical 40 to the client's pawn **in every arm** (`{dealt: 40, healthBefore: 143, healthAfter: 103}`)" | `r2/main-preK5.json → hostDamagesPawn` = `{dealt: 40, healthBefore: **110**, healthAfter: **70**}` | the 40 is identical; the pair quoted with it is one arm's, and the report itself flags `maxHealth` as session-dependent two pages earlier |
| 2 | §4: `preEB` column, "wire form of `position`: **array**", "`isFinite(position.x)`: **false**" | `r2/main-preEB.json → afterKills.client.probe.killPayloads` = **`[]`** | the probe was downstream of the abort, so those two cells cannot have been read; both are true (I measured them upstream, §4) but they are inferences inside a measurement table |
| 3 | §3: "The critique names three listeners; **there are seven**, and the other **four** are the same defect pointing the other way" | `src/` has seven `playerDead` subscribers; **six** carry this round's predicate, the seventh is round 1's Audio guard. The report's own §12 lists six | the substantive claim holds; the arithmetic is off by one |
| 4 | §8: K-10 "is in the `sp-pre` revert bundle only so that the single-player control covers it" | `NetHost.sanitise` is never called in a `netRole "single"` session | the control covers nothing about K-10 |
| 5 | §9: "The no-victim fallback (`Harness.js:5084`'s `emit('playerDead', {})`) is the reason it cannot [suppress a single-player death]" | a real single-player death goes through `Combat._kill`, which names the victim; my probe reads `{victimIsSelf: true}` on both single-player trees | right conclusion, wrong mechanism |
| 6 | the banner added to `round1-fix-coop.md` points readers at "`round2-fix-coop.md` **§8**" | the corrections are round 2's **§10**; §8 is K-10 | a reader following the pointer lands on the wrong section |

None of these changes a verdict. Items 2 and 5 are the two worth caring about,
because both present an inference in the voice of a measurement — which is the
same class of error rounds 4 and 7 have now written three lessons about.

Also filed here: **round 2 did not re-verify round 1's F-6, F-7-in-co-op or F-9
after editing five of the eight files those fixes live in, and does not name that
omission in its §13.** Closed by §8, which had to be run to close it.

## 11.3 My own report, held to the same standard

Every number above is quoted with the file and key it came from in
`reviews/round7/coop/r2-critique/`. Four things I will not let travel:

- **`preF6` is not a failed gate** and is labelled as such wherever it appears
  (§1.5, §8.1).
- **`emitRate`** is a quiet-session number and I use `emitTotals` instead (§5.4).
- **`hostOwnJump.barriers` and `.quakes` from my first re-run were
  double-counted** and are not quoted anywhere; the fixed-wrapper values in §8.2
  are.
- **`maxHealth`, `damageTaken`, `timeSinceHurt`, `musicGain` and every
  `intensity` figure are session-dependent** and appear only as agreements or
  comparisons within one session, never as build figures.

---

# 12. Claim ledger

| # | round 2's claim | verdict | my number |
|---|---|---|---|
| 1 | build exit 0 | CONFIRMED | exit 0 twice, `✓ built in 937ms` and `✓ built in 694ms` |
| 2 | blocking running-game gate; both pages `paused false`, `_localTick 61`, every arm | CONFIRMED | `runningGate`, 23 sessions |
| 3 | session reality: host authority/2 players, client `myNetId 1` | CONFIRMED | every arm's `roles` |
| 4 | `substitutionsMissing` empty in every run | CONFIRMED | `[]` in all 23 of mine |
| 5 | the client's post-join `_localTick 0` is F-6's reset, not a failed gate | CONFIRMED, 19 sessions | `runningGateAfterJoin.client.localTick` = **0** in every arm carrying the reset and **396 / 399** on `preF6` / `preF6full` where it is reverted; host 567–599 throughout |
| 6 | K-1: client's own health tracks the host's | CONFIRMED | 121.10→123.32 vs 103→104.12 broken; agreement within **0.04** fixed |
| 7 | K-1: the client enters its own death state | CONFIRMED, and split | `preK1` `alive true`/123.34; `preK1death` `alive true`/**0**; `fixed` `alive false`/0 |
| 8 | K-1: the `sinceDamage` reset stops local regen fighting the authority | **CONFIRMED as mechanism, REFUTED as an observable effect** | `preK1regen` agrees to 0.06 with the reset gone; `sinceDamage` 135.55 vs cycling 0.20–1.27 |
| 9 | K-1: `healthFrac × maxHealth` is safe because both maxima agree | **CONFIRMED only for matched survivors** | mismatched: 70.92 vs **109.60**, a 38.68 gap (§10.1) |
| 10 | K-2: a teammate's death no longer ends the client's run | CONFIRMED | `k2c` `screen null` / `_ended null` / `director true` vs `death` / `true` / `false` |
| 11 | K-2: the host end matters too and was missed by the critique | CONFIRMED | `preK2` host `screen "death"`, `_ended true`, `director false` after a pawn death |
| 12 | K-2: the fix touches **seven** listeners | **REFUTED** — six | seven subscribers exist; six carry `isLocalVictim` (§3.5) |
| 13 | K-2: it does not over-reach — your own death still ends your own run | CONFIRMED | `afterHostOwnDeath.host` `_ended true`; and a client's own death **after** a teammate's, `_ended true` |
| 14 | K-2: round 3's M3 is untouched | CONFIRMED | music `stopped false`, gain 0.48000 on both `k2c` arms |
| 15 | K-2: the guard reads round 1's identity field | CONFIRMED, and it fails **open** without it | `preVictim`: host's run ends on a pawn death (§3.4) |
| 16 | K-3: the position crosses as an object and `Audio.death` stops throwing | CONFIRMED | `object`/finite ×4, `deathThrows 0 of 4` |
| 17 | K-3: 0 of 4 downstream on HEAD's behaviour, 4 of 4 fixed | CONFIRMED | `preEB` 0 / `fixed` 4; `HUD.stats.kills` 0 vs 4 |
| 18 | K-3: `preEB`'s wire form was `array` / non-finite | CONFIRMED by me, **UNVERIFIABLE from the artefact that cites it** | `main-preEB.json → killPayloads: []`; my bus probe reads `array`/`false` ×4 |
| 19 | EB: isolation changes the dispatch outcome and nothing else | CONFIRMED | `preK3` vs `preEB`: 4 of 4 vs 0 of 4, identical throws |
| 20 | EB: the `console.error` preserves loudness | CONFIRMED | 6 throws → **6** `[events] listener threw` messages; `capture.mjs:254` already collects them |
| 21 | EB: nothing in `src/` calls `emit` inside a `try` | CONFIRMED | 92 call sites, none under a `try` |
| 22 | EB: the set copy makes `off()` from a handler safe | CONFIRMED but unexercised, and one-directional | **no `.off()` call sites in `src/`**; the copy also changes two other semantics (§5.3) |
| 23 | EB: single-player unaffected | CONFIRMED | `downstreamKill 4→5`, `deathThrows 0`, `pageErrors 0`, zero `[events]` errors, both trees |
| 24 | K-4: closing it breaks F-7's equality; defer | CONFIRMED, measured | `preF7gate` pawn `[30,30,36]` vs client `[30,30,30]`, host `[10,10,10]` + 1 quake |
| 25 | K-4: the fix is two design changes touching every `tally` card | CONFIRMED in shape, **overstated in cost** | three `tally` call sites; an optional `owner` param is back-compatible |
| 26 | K-5: a client books its own damage taken | CONFIRMED | 0/0/0 → **40/40/40**, hurt timer 2.05 on both arms |
| 27 | K-5 is **Closed** | **CONFIRMED for the accounting half; the other half is untouched and unmentioned** | client `shield` 28.02 → 12.43 while the host's pawn holds **0.00** |
| 28 | K-6: three inputs, one alive; options 1 and 2 are not equivalent | CONFIRMED at source | `Director.js:275` returns before `:277`; client `intensity 0.0032`, `director.enemies 0` |
| 29 | K-6: `_heat` is now fed four times as often; intensity not measured | CONFIRMED **and now measured** | client intensity after 4 kills: 0.1422 / 0.1424 broken, **0.2619** fixed |
| 30 | K-8: `294/480 = 0.6125` is a true reading; do not strike | CONFIRMED | `r1/pre.json → F6_ninthSecond` = `{480, 294, 186}` |
| 31 | K-10: source-derived, no behavioural signature | CONFIRMED | `preK10` matches `fixed` on every measured quantity |
| 32 | K-10 is covered by the single-player control | **REFUTED** | `sanitise` never runs in a `netRole "single"` session |
| 33 | the record: `[C1]`–`[C5]` against `r1/*.json` | CONFIRMED, all five | §11.1 |
| 34 | single-player did not move, on both trees | CONFIRMED, and strengthened | every structural quantity identical; my jump probe reaches all three presses |
| 35 | the jump probe reaches two of three and is not an F-7 re-verification | CONFIRMED, and now superseded | mine reads `[30, 30, 36]`, `[10,10,10]`, 1 quake on both trees |
| 36 | round 1's five fixes still hold | **not claimed, and not checked by round 2** — CONFIRMED by me | F-6, F-7, F-9, F-10, M1, each with its gate failed in isolation (§8) |

---

# 13. Arms I did not test

Naming them is not a claim that they are fine.

1. **Three or four peers.** Every session here is host + one client. `isLocalVictim`
   on a host with two pawns, and `_forwardHurt`'s linear owner scan with two
   entries, are both unexercised. With two clients, one pawn's death must end
   that client's run and neither the host's nor the other client's; I have only
   shown the one-pawn case. Source reading says it holds (the other client
   resolves the victim's netId to a *view*, which is neither `ctx.player` nor
   `null`), but that is a reading.
2. **A peer leaving, and reconnect after `Lobby.leave()`.** Not driven, in this
   round or either previous one.
3. **Real network conditions.** Loopback WebRTC on one machine. K-1's agreement
   figures, K-1's `sinceDamage` result (§2.3) and L-2's prediction mismatch
   (§10.1) are all zero-lag; under real RTT all three could read differently and
   §2.3 in particular might reverse.
4. **The correction rate under L-2's stat mismatch.** I read both ends'
   `moveSpeed` off one live session; I did not count reconciliation replays with
   mismatched survivors.
5. **The K-10 trigger.** §3.4's consequence is measured; the narrow window in
   which a netId-less victim actually reaches the wire is not.
6. **A heavy fight's emit rate.** §5.4's totals are from quiet sessions.
7. **A client killing anything.** All damage still flows toward the client. A
   client's outgoing damage resolves on the host and nobody has closed that loop
   in three rounds — and §10.2 shows the run summary is already wrong about it.
8. **`flawlessStages` actually not firing on a client.** Source-derived plus a
   measured `damageTakenThisStage 40`; I did not clear a stage in co-op.
9. **F-6 at second 9, on either tree.** Neither round 2 nor I re-measured it;
   §7.3 is why that is the correct disposal.
10. **The 21-shot capture.** Not run: its default port is 5199 and the user is
    playtesting on this machine. The build is exit 0 and §9 covers the changed
    single-player paths, but nobody has re-shot the manifest against these edits.
11. **Whether any of it sounds right.** Still nobody has listened. `musicGain`,
    a cue count, a throw count and an `intensity` reading are not a cue, and that
    is now five rounds old.
12. **`Player.js:1287`'s self-kill fallback.** Unreachable without a build that
    has no `Combat`. Source-level only, three rounds running.

---

# 14. For whoever decides whether to ship co-op

**The round did what it was asked to do, and did it well.** Six findings closed,
every gate failed on purpose in isolation, the record corrected in place against
the raw files rather than against a critique's reading, one deferral defended
with a design argument that survives inspection, and one shared-infrastructure
change that is correct, measured at both ends, and cheaper than the failure it
prevents. Round 1's five fixes are all still standing under it. The two reports
together are the best-evidenced work in this project.

**Co-op still does not ship**, and for the first time the reasons are not the
ones the round was working on. Ranked, with what each costs:

1. **The host's death freezes the world for everyone else.** (L-1, MAJOR) The
   client's snapshot clock stops dead — 393 → 396 → 396 for four seconds with
   `connected` still true — and the survivor is left alive in a world that will
   never move again, unable to finish, die or end the run. This is now the first
   thing a two-player session hits. **Cost: a design decision.** Either the host
   keeps `NetHost.fixedUpdate` running while dead (spectate, and the run
   continues for the living), or the host's death ends the session explicitly
   and tells the client so. Both are more than a line; neither is large.
2. **A client does not get to play the survivor it picked.** (L-2, MAJOR) The
   pawn is built with the host's `ctx.survivorId`, so the client's stats, speed,
   damage and health maximum are all the host's on the authoritative side —
   measured 110 against 170, 7.0 against 6.5. It also makes K-1 report a health
   number 55 % too high. **Cost: one field in the JOIN/WELCOME handshake plus
   `requestedSurvivor` on the pawn.** Small change, large blast radius; needs its
   own verification pass.
3. **K-5's second half.** (L-3, MODERATE) A client displays barrier the host
   does not have (28.02 against 0.00) and pays no attention to the barrier it
   does. **Cost:** either replicate `shield` in the snapshot alongside
   `healthFrac`, or stop the client's `onDamaged` dispatch granting local
   barrier. The first is one wire field and subsumes the problem.
4. **A client's run summary credits the host's kills.** (L-4, MODERATE) One
   guard on `Progression.on('kill')` and one on `HUD.js:168`, the same shape as
   F-9's. **Cost: two lines.**
5. **`isLocalVictim` fails open on a missing victim, and K-10 added a way to
   produce one.** (L-5, MODERATE) **Cost: one line** — answer *no* on a client
   when the payload cannot name a victim.
6. **Still deferred and still correct to defer:** Tectonic Heart for a client
   (K-4), the reactive soundtrack (K-6), the join placement gap (F-11), and a
   client's outgoing damage never being credited.

**If the choice is ship-or-hide today:** hide the Co-op menu entry. Not because
this round failed — it is the strongest round in the project — but because the
first thing that happens in a real two-player game is that somebody dies, and
what happens then is that the survivor's world stops.

**One thing to fix in the record before anyone acts on it:** round 2's §4 states
the `preEB` wire format as measured when its own probe recorded nothing there,
and its §9 credits single-player's surviving death to a fallback path that a
real death never takes. Both conclusions are right; both mechanisms as written
are not, and a reader building on either will build on sand. The rest of its
prose survived a line-by-line check against `r2/*.json` and `src/`, which is a
first here.

---

# Appendix A — the substitution table

Reproduced here because the driver was deleted. Every anchor is a **single line
of text** with no newline in it, so mixed CRLF/LF in the tree cannot make one
silently miss; the transform throws unless the anchor matches **exactly once**,
and the arm then refuses to boot. All eighteen were validated against `src/` as
matching exactly once before any arm was run.

| name | file | line replaced | replaced with |
|---|---|---|---|
| `K1-all` | `src/net/NetClient.js` | `this._applyAuthoritativeHealth(player, authoritative);` | `if (authoritative) { }` |
| `K1-death` | `src/net/NetClient.js` | `if (e?.state === ESTATE.DEAD) {` | `if (false) {` |
| `K1-regen` | `src/net/NetClient.js` | `if (next < player.health - 0.001) player.sinceDamage = 0;` | `;` |
| `K2-pred` | `src/core/Engine.js` | `if (!victim) return true;` | `return true;` |
| `K3-wire` | `src/net/NetHost.js` | `if (v.isVector3) out[k] = { x: …, y: …, z: … };` | `the array form` |
| `K3-guard` | `src/systems/Audio.js` | `the Number.isFinite(pos.x) … early return in _out` | `;` |
| `EB-isolate` | `src/core/Engine.js` | `} catch (err) {` | `} catch (err) { throw err;` |
| `K5-prog` | `src/systems/Progression.js` | `this.stats.damageTaken += e?.amount ?? 0;` | `;` |
| `K5-prof` | `src/systems/Profile.js` | `this._onDamage({ target: this.ctx.player, … });` | `;` |
| `K10-null` | `src/net/NetHost.js` | `else if (typeof v.takeDamage === 'function') out[k] = null;` | `else if (false) …` |
| `R1-F6` | `src/net/NetClient.js` | `ctx.player?.resetCommandEpoch?.();` | `;` |
| `R1-F6-window` | `src/entities/Player.js` | `&& this._lastCmdTick - c.tick < REPLAY_WINDOW;` | `&& true;` |
| `R1-F7-soles` | `src/data/items.js` | `Rubber Soles' onJump with its e.local === false gate` | `the ungated hook` |
| `R1-F7-tectonic` | `src/data/items.js` | `if (e.local === false) return; (Tectonic Heart)` | `;` |
| `R1-F9` | `src/systems/Progression.js` | `if (e.source?.isPlayer && (!ctx.player \|\| e.source === ctx.player)) {` | `if (e.source?.isPlayer) {` |
| `R1-F10` | `src/net/NetHost.js` | `ctx.events.on('damage', (e) => this._forwardHurt(e));` | `;` |
| `R1-M1` | `src/systems/Audio.js` | `if (myNetId > 0 && victimNetId != null) {` | `if (false) {` |
| `R1-victim` | `src/systems/Combat.js` | `ctx.events.emit('playerDead', { victim });` | `ctx.events.emit('playerDead', {});` |

`EB-isolate` deserves its own note: it is deliberately **smaller** than the
change it reverts. It leaves round 2's set copy in place and only restores
abort-on-throw, so §5's table isolates the try/catch semantics and nothing else.
