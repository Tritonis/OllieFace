# Round 7 — round-2 co-op fixes

> **Corrections applied by round 3 (`round3-fix-coop.md` §9).** Round 2's own
> critique (`round2-critique-coop.md` §11.2) found six statements in this report
> that its raw files or `src/` contradict. None changes a verdict; all six are
> confirmed and stand as written there. In this document:
> 1. §2's `{dealt: 40, healthBefore: 143, healthAfter: 103}` is **one arm's**
>    numbers, not "every arm's" — `r2/main-preK5.json` records `110 / 70`.
> 2. §4's `preEB` cells "wire form: array" / "isFinite: false" are **inferences,
>    not measurements** — that arm's probe sat downstream of the abort and
>    `r2/main-preEB.json → killPayloads` is `[]`. Both are true; round 2's
>    critique measured them upstream, and round 3 reproduces them again
>    (`r3/main-preK3full.json`, `array` / `false` ×4).
> 3. §3's "seven listeners ... the other four" is **six**; the seventh carries
>    round 1's audio identity test instead.
> 4. §8's claim that the single-player control covers K-10 is **empty** —
>    `NetHost.sanitise` never runs in a `netRole "single"` session.
> 5. §9 credits single-player's surviving death to the no-victim fallback; a
>    real death goes through `Combat._kill`, which **names** the victim. Right
>    conclusion, wrong mechanism.
> 6. The banner this report added to `round1-fix-coop.md` points at "§8"; the
>    corrections are its **§10**.
>
> Also on the record: this round edited five of the eight files round 1's fixes
> live in and re-verified two of them, without naming the omission. Round 3
> re-verified eight prior fixes with a failed gate each; see its §7.

Branch `round7/content-and-polish`, HEAD `a43cc70`. Round 1's five fixes are
still in the working tree and untouched; my edits sit on top of them. Nothing
committed, staged or reverted. Subject: `round1-critique-coop.md`'s K-1 … K-10,
plus the four record corrections its §10 names.

**Closed:** K-1, K-2, K-3 (both halves), K-5, K-9, K-10, and the four record
corrections (K-7) plus a fifth the critique did not list.
**Deferred:** K-4 (Tectonic Heart — closing it breaks F-7's design; the
alternative is proposed in §6), F-11, the client's reactive soundtrack (K-6,
with its real scope restated), K-8 (a documentation correction, folded into the
record corrections).

`node node_modules/vite/bin/vite.js build` → **exit 0**, `✓ built in 688ms`
(re-run after the driver was deleted, with all edits in the tree, nothing
staged).

Raw JSON: `reviews/round7/coop/r2/`. The driver (`tools/_r2coop.mjs`) was
deleted after use; its output was not. Nothing in `src/` was modified to build a
test arm — every sabotaged arm is a named in-memory substitution applied by a
vite `transform` that throws if its anchor does not match **exactly once**, so
an arm that cannot be built refuses to boot. Each JSON records the `arm`, the
`substitutions` requested, `substitutionsApplied` and `substitutionsMissing`;
`substitutionsMissing` is `[]` in all ten runs. Ports 5721–5732 only; 5199 was
never touched and no running process was killed.

---

# 1. The gate that makes everything below admissible

Two real Chromium pages in one browser, host and client over the manual WebRTC
invite path (`Lobby.createInvite` / `joinManual` / `acceptAnswer`).

**The running-game gate is blocking.** Both pages are launched with
`ctx.hud.menus.launch()` and the driver *waits* on
`c.paused === false && c.player && (c.player._localTick ?? 0) > 60` before any
instrument is installed; a co-op arm that fails it throws
`running-game gate FAILED` and writes no measurements. Every arm, both pages:

| | host | client |
|---|---|---|
| `paused` | `false` | `false` |
| `menus.screen` | `null` | `null` |
| `player._localTick` | 61 | 61 |

(`runningGate` in every JSON.) Session reality, identical in all seven co-op
arms (`roles`):

```
host   { authority: true,  role: "host",   playerCount: 2, clients: 1 }
client { authority: false, role: "client", myNetId: 1,     connected: true }
```

The gate is re-read *after* the join as `runningGateAfterJoin`: host
`{paused: false, localTick: 396}`, client `{paused: false, localTick: 0}`. The
client's 0 is not a failed gate — it is round 1's F-6 fix, `resetCommandEpoch()`
zeroing `_localTick` at the `netRole → 'client'` transition, and it is why the
gate has to be taken before the join rather than after it.

## 1.1 Arms

| arm | substitutions | scenario | raw |
|---|---|---|---|
| `fixed` | *(none)* | main, k2client | `main-fixed.json`, `k2client-fixed.json` |
| `preK1` | `K1:src/net/NetClient.js` | main | `main-preK1.json` |
| `preK2` | `K2:src/core/Engine.js` | main, k2client | `main-preK2.json`, `k2client-preK2.json` |
| `preK3` | `K3wire:NetHost.js`, `K3guard:Audio.js` | main | `main-preK3.json` |
| `preEB` | the two above **plus** `EB:src/core/Engine.js` | main | `main-preEB.json` |
| `preK5` | `K5:Progression.js`, `K5:Profile.js` | main | `main-preK5.json` |
| `sp-fixed` / `sp-pre` | single player, no network; `sp-pre` reverts **all eight** of this round's substitutions | sp | `sp-sp-fixed.json`, `sp-sp-pre.json` |

**One fix at a time.** Each `pre*` arm reverts exactly one finding, so every
gate failure is attributed to that finding rather than to a bundle. The one
deliberate exception is the `preK3` / `preEB` pair: they differ by the
`EventBus.emit` substitution **alone**, which is how the isolation change in §5
is measured on its own.

## 1.2 Evidence I disqualified rather than shipped

- **My first single-player pair (ports 5729/5730) produced `jumps: {impulses: [],
  barriers: [], quakes: 0}` on both trees.** The probe drove
  `ctx.input._keys`, which does not exist — the set is `ctx.input.keys`
  (`Input.js:7`). Two empty arrays that match each other would have read exactly
  like "the jump channel did not move" and are evidence of nothing. The pair was
  re-run on 5731/5732 with the real key set and only that pair is quoted; the
  first pair's files were overwritten, so this paragraph is its only record.
- **The jump probe reaches two of three jumps.** Even re-run it records
  `[30, 30]`, not `[30, 30, 30]` — the third press lands outside the sample
  window. Identical on both trees, so it is admissible as a *no-movement*
  control, but it does **not** reach Tectonic Heart's every-third tally, and I
  do not claim it does. See §9.
- **`progDamageTaken` after a death is not a number anyone should quote.** My
  kill probe deals `1e6`, and the client books the forwarded `playerHurt` for
  it, so the post-death reading is `1000040`. The K-5 measurement is taken at
  `afterHit`, before any death, off a real 40-damage hit.
- **`maxHealth` differs between arms (110 vs 143) and is session-dependent.** It
  moves with which enemies the director happened to spawn and whether the
  survivor levelled. It is never used as a build figure; K-1 is stated as the
  *agreement between the two ends*, not as an absolute health value.
- **One `pageerror` on the host page in every co-op arm**, on both trees and in
  both round-1 arms: `The root document of this element is not valid for pointer
  lock`, from the harness's synthetic click. Not mine, present everywhere,
  excluded from the error counts I read as signal.

---

# 2. K-1 (MAJOR) — a client's own health, and its own death

**Edits**

- `src/net/NetClient.js:217` — `this._applyAuthoritativeHealth(player, authoritative);`
  in `_reconcile`, placed **before** the `err < 0.02` early-out and before the
  history-index early-out, so a client whose prediction is perfect still gets
  its health.
- `src/net/NetClient.js:264-283` — `_applyAuthoritativeHealth(player, e)`:
  `healthFrac × maxHealth`, clamped; `sinceDamage = 0` when the authoritative
  value is below the local one; and `player.onDeath()` when the snapshot's
  `state` is `ESTATE.DEAD`.

`healthFrac` is the one health field the snapshot already carries
(`Protocol.js:189`), so this costs no protocol change. Death goes through
`Player.onDeath` rather than a bare `alive = false` so the pawn also drops its
projectiles, placeables and buffs as it does on the host. **No `playerDead` is
synthesised locally** — the host emits it and `NetHost` forwards it, and raising
a second one here would double every death cue and hide which of the two wrote
the record.

The `sinceDamage` reset is the half that is easy to miss: a client resolves no
damage of its own, so nothing local ever started its regen delay, and
`_updateRegen` was free to climb back up between snapshots and fight the
authority twenty times a second.

**Measurement — the health leg, both ends.** Host deals an identical 40 to the
client's pawn in every arm (`hostDamagesPawn: {dealt: 40, healthBefore: 143,
healthAfter: 103}`), then the host's copy of the pawn and the client's own
reading are sampled together, eight times over two seconds
(`healthSeries`):

| sample | `preK1` host pawn | `preK1` **client's own** | `fixed` host pawn | `fixed` **client's own** |
|---|---|---|---|---|
| 1 | 103.00 | **112.56** | 103.00 | **103.00** |
| 4 | 103.00 | **113.50** | 103.00 | **103.00** |
| 6 | 103.48 | **114.14** | 103.48 | **103.46** |
| 8 | 104.12 | **114.78** | 104.12 | **104.12** |

Both ends of the range, and the failure is the shape the critique described
rather than staleness: with the fix reverted the client's own reading **rises**
112.56 → 114.78 while the host holds the same pawn at 103 — an unrelated number,
not a stale copy. With the fix in, the two ends agree to within 0.04 (the
snapshot quantum) at every sample and track the host's regeneration together.

**The death leg, both ends** (`afterPawnDeath.client`, after the host has killed
the pawn outright — `hostKillsPawn: {aliveOnHost: false, healthOnHost: 0}`):

| on the client | `preK1` | `fixed` |
|---|---|---|
| `player.alive` | **`true`** | **`false`** |
| `player.health` | **114.80** | **0** |
| `menus.screen` | `"death"` | `"death"` |

The pre-fix client sits behind its own death screen at 114.8 health, still
alive, which is exactly the critique's "after the host has killed the pawn, the
client still reads `alive: true, health: 110.0`".

**Deliberate-failure arm:** `preK1`, one substitution, `K1:src/net/NetClient.js`
— the call replaced with `if (authoritative) { }`. Reported broken on both legs.
Every other finding in that same arm still read its fixed value (K-3 throws 0,
K-5 40 / 40 / 40, K-2 host `screen null`), which is the isolation showing.

---

# 3. K-2 (MAJOR) — a teammate's death is not your run's death

**Edits**

- `src/core/Engine.js:303-307` — new exported `isLocalVictim(ctx, payload)`:
  true when the payload names no victim (single-player, and the harness's
  `emit('playerDead', {})`), otherwise `victim === ctx.player`. `Combat._kill`
  names the victim and `NetClient._resolve` maps a client's own netId back to
  `ctx.player`, so one predicate is correct on both roles.
- `src/systems/Progression.js:183` — `_endRun(false)` guarded.
- `src/systems/Profile.js:453` — `run.died = true` guarded.
- `src/ui/HUD.js:223` — `onDeath()` (the run-summary screen) guarded.
- `src/systems/Director.js:159` — `enabled = false` guarded.
- `src/systems/VFX.js:192` — the death shake / aberration / vignette guarded.
- `src/world/realms/Realms.js:82` — the realm controller abort guarded.

The critique names three listeners; there are seven, and the other four are the
same defect pointing the other way. On a **host**, a client pawn's death
unguarded stopped the director for everyone still alive, aborted the realm and
blacked out the host's screen.

**Measurement, client end** — the host's own player killed while the client is
alive (`k2client-*.json`, `hostDies: {hostAlive: false, hostHealth: 0}`):

| on the **client**, after the host dies | `preK2` | `fixed` |
|---|---|---|
| `player.alive` / `health` | `true` / 110 | `true` / 110 |
| `menus.screen` | **`"death"`** | **`null`** |
| `ctx.paused` | **`true`** | **`false`** |
| `progression._ended` | **`true`** | **`null`** (never set) |
| `profile.run.died` | **`null`** — `run` already committed and cleared | **`false`** |
| `director.enabled` | **`false`** | **`true`** |
| music (`stopped` / `musicGain`) | `false` / 0.48000 | `false` / 0.48000 |

Both ends. The last row is the control that the guard is not too wide: round 3's
M3 (a teammate's death must not silence a living client's soundtrack) is
untouched on both arms, and round 1's audio fix already handled that listener by
identity rather than by this predicate.

The `playerDead` payload the client received in both arms is
`{victimIsSelf: false, victimNetId: 2}` — the identity round 1 put on the wire is
what the guard reads, and it is present on the broken arm too. The defect was
never a missing fact; it was seven listeners not asking.

**Measurement, host end** — the client's pawn killed while the host is alive
(`main-*.json`, `afterPawnDeath.host`):

| on the **host**, after the pawn dies | `preK2` | `fixed` |
|---|---|---|
| `menus.screen` | **`"death"`** | **`null`** |
| `ctx.paused` | **`true`** | **`false`** |
| `progression._ended` | **`true`** | **`null`** |
| `profile.run.died` | `null` (run committed) | **`false`** |
| `director.enabled` | **`false`** | **`true`** |

**Control — the guard is not too wide.** In the same `fixed` session, after the
pawn death above, the host's *own* player is then killed
(`afterHostOwnDeath.host`): `alive false`, `screen "death"`, `progEnded true`,
`directorEnabled false`. Your own death still ends your own run, on the same
build, seconds later. And on the client side, its own death in the `main-fixed`
arm gives `progEnded true`, `screen "death"`, with the payload
`{victimIsSelf: true, victimNetId: 1}`.

**Deliberate-failure arm:** `preK2`, one substitution, `K2:src/core/Engine.js` —
the body of `isLocalVictim` replaced with `return true`, i.e. all seven
listeners restored to unguarded at once, which is what "the fix" is. Reported
broken at both ends, in two separate scenarios.

---

# 4. K-3 (MAJOR) — the `AudioParam` throw, and what it took with it

**Edits**

- `src/net/NetHost.js:294` — `sanitise` now puts a Vector3 on the wire as
  `{x, y, z}` instead of `[x, y, z]`. Every consumer on the far side reads
  `.x`/`.y`/`.z` off it — `Audio.death → _out` (`Audio.js:536`) and
  `VFX._onKill → Vector3.copy` (`VFX.js:1172`) — and an array gave all of them
  `undefined`, which reached the Web Audio graph as `NaN` and threw. Fixing the
  encoder rather than one reader closes it for every consumer at once, including
  the VFX one nobody had named.
- `src/systems/Audio.js:532` — `_out` returns the unpanned bus for any
  non-finite position. Belt to the wire-format braces: anything we cannot place,
  we play unpanned rather than not at all.

**Measurement.** Four director enemies killed outright on the host, so four real
`kill` events cross the wire (`forcedKills: {killed: 4}` in every arm — the
fixture check that stops a "0 of 0" from reading like a passing control). The
client carries two counters: `deathCalls`/`deathThrows` from a wrapper on
`Audio.death` that re-throws, and `downstreamKill` from a `kill` listener
registered *after* every system's own, i.e. downstream of `Audio`.

| on the **client** | `preEB` (= HEAD's behaviour) | `preK3` | `fixed` |
|---|---|---|---|
| wire form of `position` | `array` | **`array`** | **`object`** |
| `Number.isFinite(position.x)` | `false` | **`false`** | **`true`** |
| `Audio.death` calls | 4 | 4 | 4 |
| `Audio.death` **throws** | **4 of 4** | **4 of 4** | **0 of 4** |
| `kill` reaching a listener registered *after* `Audio` | **0 of 4** | **4 of 4** | **4 of 4** |
| `HUD.stats.kills` | 0 → **0** | 0 → **4** | 0 → **4** |
| `Progression` kills (registered *before* `Audio`) | 4 | 4 | 4 |
| client page errors | **6** | 0 | 0 |
| host `HUD.stats.kills`, same session | 4 | 4 | 4 |

Both ends, and the critique's exact table reproduced on `preEB`: 4 of 4 upstream,
**0 of 4** downstream, client HUD counter stuck at 0 while the host's tracks the
fight.

**Deliberate-failure arm:** `preK3`, two substitutions in two files
(`K3wire` restores the array, `K3guard` disables the `_out` finite check).
Reported broken on the throw: `deathThrows 4 of 4`, `posXFinite false`.

---

# 5. `EventBus.emit` — the isolation question, decided and measured

**Decision: yes, isolate.** `src/core/Engine.js:279-285` — `emit` now iterates a
copy of the subscriber set and wraps each call in `try`/`catch`, re-surfacing the
error with `console.error('[events] listener threw for event: ' + name, err)`.

**The argument.** Without it, "which listeners survive an exception" is decided
by registration order in `main.js`, which is an accident: `Progression` (55),
`VFX` (59), `Audio` (60), `Coop` (65), `HUD` (66). Nothing about that ordering
was chosen to make `Audio` a load-bearing gate in front of the HUD, and no
listener's contract says "I may silence every subscriber after me". The
alternative — leaving `emit` fail-fast so a bug is loud — was never actually
buying loudness: K-3 was a *silent*, permanent, per-kill failure for two rounds,
and the physics critic recorded it as unreproduced. The `console.error` keeps
the loudness and drops the collateral. The set copy is not decoration: it makes
an `off()` from inside a handler safe, which the previous loop was not.

**The risk I accepted, stated.** A listener that throws every frame now logs
every frame instead of stopping the dispatch, and a caller that relied on an
exception propagating out of `emit` would no longer see it. I checked: nothing in
`src/` calls `emit` inside a `try`, so no caller depends on that.

**Measured in isolation.** `preK3` and `preEB` differ by the `EB` substitution
alone, on the same broken-throw build:

| | `preK3` (throw present, isolation **in**) | `preEB` (throw present, isolation **reverted**) |
|---|---|---|
| `Audio.death` throws | 4 of 4 | 4 of 4 |
| `kill` reaching a downstream listener | **4 of 4** | **0 of 4** |
| client `HUD.stats.kills` | **4** | **0** |
| client page errors | 0 (caught and logged) | **6** |

That is the isolation change, alone, at both ends: identical throw, opposite
dispatch outcome. It is also the argument for keeping it *even though* K-3 is
fixed — it is the difference between one broken listener and a broken build.

Single-player is unaffected: `sp-fixed` and `sp-pre` both read
`downstreamKill 5`, `deathThrows 0`, `pageErrors 0` (§7).

---

# 6. K-4 (MODERATE) — Tectonic Heart. **Deferred, and here is why, and what instead**

The critique asked me to read its §3.3 before touching this and to say so rather
than force it if closing K-4 breaks F-7's design. **It does, and I did not.**

The state of the world, unchanged by this round: `Items.tally` returns `false`
on a non-authority (`Items.js:644`), so a client can never fire Tectonic Heart
for its own jump; and round 1's `if (e.local === false) return;`
(`data/items.js:1647`) means the host never fires it for the pawn either. Both
ends therefore compute 0 from that card for a client's jump, which is precisely
what makes F-7's measured equality (`[30,30,30]` on both ends) hold. Remove
either half and the host applies 36 where the client predicts 30, forever, on
every third jump — the divergence the round-1 critique measured on its `nogate`
arm.

**A correct fix is not a line, it is two design changes, and they must land
together:**

1. **Per-jumper tally state.** `Items._tallies` is one map per machine, keyed
   `'tectonic-heart'`. On a host it would have to count the host's own jumps and
   each pawn's jumps separately, or the host's jumps would advance the pawn's
   beat. That is a keying change on `Items.tally(key, every)` — `tally(key,
   every, owner)` — touching every card that uses it, not just this one.
2. **A jumper-aware hook API.** The card's body spends `api.player` four times —
   `explode(api.player.position, …, api.player, …)`, `applyImpulse`, `vfx.ring`,
   `addShake`. `api.player` is always *this machine's* survivor. For a pawn's
   jump the explosion has to happen at the **pawn's** position with the **pawn**
   as its source, while the shake and the ring stay local or go nowhere. That is
   a new `api.jumper` (or `e.entity`) on the item-hook surface, which every
   `onJump` card then has to be re-read against.

With those two in place the host would apply +6 on the pawn's third jump and the
client would predict +6 on its own third jump, because each end counts the same
jumper's jumps and each end runs the same deterministic every-3 rule. Until then
the only two reachable states are "inert for a client" (today, correct) and
"6 m/s of permanent divergence" (`nogate`, measured). **Inert is the right one of
those two**, and the summary's "Waxed Wing, Updraft Vents and Tectonic Heart are
inert for every non-host player" is two-thirds closed, not three-thirds.

I did not measure anything new here — the round-1 critique's §3.3 numbers stand
and nothing I edited touches the jump channel. Recorded as still-open.

---

# 7. K-5 (MODERATE) — a client's damage-taken accounting

**Edits**

- `src/systems/Progression.js:169-172` — on a non-authority, book
  `playerHurt.amount` into `stats.damageTaken`.
- `src/systems/Profile.js:449-452` — on a non-authority, feed the same event
  into `_onDamage` as `{target: ctx.player, amount, toHealth: amount}`.

`Progression` and `Profile` both count damage taken off **`damage`**, which is
never emitted on a client (`Combat.applyDamage` returns at the authority check).
The host's per-owner `playerHurt` forward is the only record that arrives, and
its `amount` is already what got through a barrier — the same quantity the
`damage` branch books as `toHealth`, so an absorbed-only hit still books nothing
and round 4's `Untouchable`/`Ironclad` fix is not re-broken. Both handlers are
gated on `!ctx.authority`, so single-player and the host take neither path.

**Measurement** — the client, after the same real 40-damage hit as §2
(`afterHit.client`):

| on the **client** | `preK5` | `fixed` |
|---|---|---|
| `progression.stats.damageTaken` | **0** | **40** |
| `profile.run.damageTaken` | **0** | **40** |
| `profile.run.damageTakenThisStage` | **0** | **40** |
| `items.timeSinceHurt()` | 2.05 | 2.05 |

Both ends. The hurt-timer row is round 1's F-10 still working on both arms,
which is the control that this change is additive rather than a re-route.

**Deliberate-failure arm:** `preK5`, two substitutions (`Progression.js`,
`Profile.js`), both handlers turned into early returns. Reported broken on all
three counters, with `timeSinceHurt()` still at 2.05 — i.e. the client *felt*
the hit and still recorded none of it, which is the defect exactly.

**Not closed by this, and named:** `flawlessStages` is incremented in
`Profile._onStageStart` (`Profile.js:1290`) when a stage is cleared with
`damageTakenThisStage <= 0`. `damageTakenThisStage` now moves on a client, so
the free-`Untouchable` path is closed at its source — but **I did not clear a
stage in co-op and watch the challenge not fire.** Source-derived plus the
measured 40, exactly as far as the critique got, and no further.

---

# 8. K-10 (MINOR) — a stat block in a per-hit unicast

`src/net/NetHost.js:300` — `sanitise` now emits `null` for an object that is an
entity (`typeof v.takeDamage === 'function'`) but has no `netId` yet, instead of
recursing three levels into it. An enemy that has not appeared in a snapshot has
no netId, so a hit from it serialised a partial `Enemy` — stat block included —
into the payload of a per-hit, per-DoT-tick unicast, and the receiver could not
resolve the result to anything anyway.

**Not measured. Source-derived**, exactly as the critique filed it, and it is in
the `sp-pre` revert bundle only so that the single-player control covers it.

---

# 9. Single-player did not move — **on both trees**

`sp-fixed` (no substitutions) and `sp-pre` (**all eight** of this round's
substitutions, i.e. the tree as round 1 left it), both `netRole "single"`,
`authority true`, both through `menus.launch()` and both past the `_localTick >
60` gate. This is K-9's standard applied to my own round.

| | `sp-pre` (round 1's tree) | `sp-fixed` (this round's) |
|---|---|---|
| 4 enemies killed → `progression.stats.kills` | 4 | 4 |
| `HUD.stats.kills` | 4 | 4 |
| `Audio.death` calls / **throws** | 4 / **0** | 4 / **0** |
| `kill` reaching a downstream listener | **4** | **4** |
| 40-damage hit: health | 143 → **103** | 143 → **103** |
| `progression.stats.damageTaken` | **40** | **40** |
| `profile.run.damageTaken` / `damageTakenThisStage` | **40 / 40** | **40 / 40** |
| `playerHurt` emits over that hit | **1** | **1** |
| `items.timeSinceHurt()` after it | 1.15 | 1.20 |
| three sprint-jumps: impulses applied | **`[30, 30]`** | **`[30, 30]`** |
| Rubber Soles barriers | **`[10, 10]`** | **`[10, 10]`** |
| own death: `alive` / `screen` / `progression._ended` | `false` / `death` / `true` | `false` / `death` / `true` |
| own death silences the music | `0.48000 → 0.00812`, `stopped true`, `musicOff true` | `0.48000 → 0.00842`, `stopped true`, `musicOff true` |
| `director.enabled` after own death | `false` | `false` |
| page errors | **0** | **0** |

Identical on every measured quantity. Two rows are not build-invariant and are
not read as such: `musicGain` after death (a decaying `setTargetAtTime`, sampled
by wall clock) and `timeSinceHurt` (same), and `damageTaken` after the `1e6`
kill probe (1000036.33 vs 1000035.36 — arena chip damage between probe steps).

Three rows are the specific risks in this round's edits, and none fired:

- **`EventBus.emit`'s try/catch does not change single-player dispatch**:
  `downstreamKill` 4 → 5 across the run on both trees, `deathThrows 0` on both,
  `pageErrors 0` on both.
- **`isLocalVictim` does not suppress a single-player death**: `screen "death"`,
  `_ended true`, `director.enabled false`, music silenced — on both trees. The
  no-victim fallback (`Harness.js:5084`'s `emit('playerDead', {})`) is the reason
  it cannot.
- **The client-only damage-taken handlers do not double-count on a host**:
  `damageTaken` is **40**, not 80, after one 40-damage hit, on both trees.

**The jump row is weaker than it looks and I am not dressing it up.** The probe
lands two of the three presses, so it reads `[30, 30]` rather than `[30, 30, 30]`
and never reaches Tectonic Heart's every-third tally or its quake. It is a valid
*equality* between the two trees — which is what a control is for, and my edits
touch no jump code — but it is **not** a re-verification of round 1's F-7, and
the `[30, 30, 36]` / `[10, 10, 10]` / 1-quake figures in the round-1 critique's
§7.1 are the ones that carry that.

---

# 10. The record — five corrections applied in place

`reviews/round7/coop/round1-fix-coop.md` now carries a banner under its title and
five marked corrections, `[C1]`–`[C5]`, each next to the claim it corrects and
each naming the raw-file key that settles it. **I re-derived all four of the
critique's from `reviews/round7/coop/r1/*.json` myself rather than adopting its
readings**, and found a fifth it did not list.

| # | round 1 said | its own raw file says | where |
|---|---|---|---|
| C1 | §1: replay 1st second, `pre` = "**64 / 64**" | `r1/pre.json → F6_firstSecond` = `{steps: 76, classifiedReplay: 76, replayInReconcile: 5, projectileTicks: 0}` | §1 table |
| C2 | §7: host intensity "**0.3950 – 0.4108**" | `beforeAnyDeath.host.I` = **0.395** (`fixed`), **0.4112** (`pre`), **0.319** (`nogate`); true spread **0.319 – 0.4112** | §7 |
| C3 | §2: "the **lone** `30` in every arm" | `F7.hostBarrierGrants` = `[30,30]` (`fixed`), `[30,30,30,30]` (`pre`), `[30,10,10,10]` (`nogate`) — lone in one arm of three | §2 |
| C4 | §9: "the arm each JSON was taken under is recorded inside it as `arm` and `substitutions`" | `r1/singleplayer.json` has neither; its keys are `afterDeath, beforeDeath, jump, pageErrors, progression, role, steps, verdicts` | §9 |
| C5 | §0: `nogate.json → ["F-7-gate:src/data/items.js"]` | the file records the key **twice** (one name, two hooks) | §0 |

None changes a verdict and all five of round 1's fixes stand. C2 is the one that
would have misled someone sizing the soundtrack work, so its correction also
carries K-6's restatement (below), inline, where a reader will meet it.

**K-8 (F-6's ninth-second figures, `0.613` and `186 / 480`) is deliberately
*not* struck from round 1's report.** They are real readings of `r1/pre.json →
F6_ninthSecond` (`{steps: 480, classifiedReplay: 294, projectileTicks: 186}`) —
294/480 = 0.6125 — so striking them would put a *new* wrong statement in the
record. What is wrong is their status, not their value: they are a property of
that session's wire throughput, not of the build, exactly as the round-1 critique
showed by reading 0.000 at second 9 on its own arms. That is now recorded here
and in the critique; the fix report's §1 table is left carrying its own numbers
under its own session. **I did not re-measure F-6 at second 9 on either tree.**

---

# 11. Deferred

## 11.1 K-6 — the client's reactive soundtrack. Deferred; scope restated

The deferral is right and I am not reversing it. What I am fixing is the *scope
statement*, which round 1 left as one dead input and the critique showed is
three. `MusicEngine.intensity` (`Music.js:314-353`) has three inputs and one of
them is alive on a client:

- **`_sustain`** — `_scanSustain` over `ctx.director.enemies`, which is empty on
  a client (spawning is authority-gated, `Director.js:272`, and `NetViews`
  registers replicated enemies as *views*). Its `dir.boss` floor is never set on
  a client and its `progression.state === 'charging'` floor is unreachable
  because the teleporter is host-driven. **Dead three ways.**
- **`arc`** — `(director.difficultyCoefficient - 1) / 2.5`. `updateDifficulty`
  runs after `Director.fixedUpdate`'s authority return, so on a client it moves
  only at `init` and at `Director.reset`. **Frozen at each stage's opening value
  rather than climbing** — degraded, not zero.
- **`_heat`** — `bump()` from forwarded `kill` / `bossSpawn` / `levelUp`.
  **Alive**, decaying on a 3.5 s constant, which is why a client reads ~0.003
  rather than 0.

Round 1's option 1 (register `NetViews` entities with the Director read-only)
closes `_sustain` and leaves `arc` frozen. Option 2 (replicate an intensity or
pressure value) closes both. **They are not equivalent**, and whoever picks this
up is choosing between them, not between two spellings of the same fix. This is
now written into round 1's report at `[C2]` as well as here.

One thing did change for the client's soundtrack this round, and it is a side
effect rather than a fix: with K-3 closed, a client's `Audio.death` no longer
throws, so `musicEngine.bump(0.05)` on the same listener now actually runs for
every replicated enemy death. `_heat` was already the one live input; it is now
fed by four times as many events as it was (0 of 4 reaching the bump call, on
`preEB`, versus 4 of 4 on `fixed`). **I did not measure the resulting
`intensity`**, and nobody has listened to it.

## 11.2 F-11 — the join placement gap. Still deferred

Untouched, for round 1's reason (a real fix is a placement handshake, and
nothing on the wire carries the joiner's position) and the critique's
(nine measurements across two rounds span 2.855 m to 35.811 m for the identical
code path, so none of them is a baseline). I measured nothing new.

## 11.3 K-7 / K-8 / K-9

K-7 is §10. K-9 is §9 — the single-player control ran on both trees, which is
the standard the critique set. K-8 is §10's closing paragraph: recorded as
session-dependent rather than struck, with the reason.

---

# 12. Files changed

| file:line | finding |
|---|---|
| `src/core/Engine.js:266-287` | `EventBus.emit` isolates listeners, copies the set, logs |
| `src/core/Engine.js:290-307` | new exported `isLocalVictim(ctx, payload)` |
| `src/net/NetClient.js:217` | K-1 — apply authoritative health before the position early-outs |
| `src/net/NetClient.js:253-283` | K-1 — `_applyAuthoritativeHealth`, incl. death and the regen-delay reset |
| `src/net/NetHost.js:283-294` | K-3 — a Vector3 crosses as `{x, y, z}` |
| `src/net/NetHost.js:295-300` | K-10 — a netId-less entity serialises as `null` |
| `src/systems/Audio.js:528-532` | K-3 — `_out` refuses a non-finite position |
| `src/systems/Progression.js:6` | import |
| `src/systems/Progression.js:164-172` | K-5 — a client books `playerHurt` as damage taken |
| `src/systems/Progression.js:178-183` | K-2 — `_endRun` guarded |
| `src/systems/Profile.js:9` | import |
| `src/systems/Profile.js:444-452` | K-5 — same, into `_onDamage` |
| `src/systems/Profile.js:453` | K-2 — `run.died` guarded |
| `src/ui/HUD.js:12`, `:220-223` | K-2 — the run-summary screen guarded |
| `src/systems/Director.js:29`, `:157-159` | K-2 — the spawner guarded |
| `src/systems/VFX.js:8`, `:189-192` | K-2 — the death screen effect guarded |
| `src/world/realms/Realms.js:13`, `:82` | K-2 — the realm abort guarded |
| `reviews/round7/coop/round1-fix-coop.md` | five in-place corrections, `[C1]`–`[C5]` |

Round 1's eight files are untouched by me except where a line above says
otherwise; `src/entities/Player.js`, `src/systems/Combat.js`,
`src/systems/Items.js` and `src/data/items.js` carry round 1's edits only.

---

# 13. Arms I did not test

Naming them is not a claim that they are fine.

1. **Three or four peers.** Every session here is host + one client.
   `_forwardHurt`'s owner lookup and `isLocalVictim` on a host with two pawns are
   both unexercised — the second especially: with two clients, one pawn's death
   must end that client's run and neither the host's nor the other client's, and
   I have only ever shown the one-pawn case.
2. **A peer leaving, and reconnect after `Lobby.leave()`.** Not driven, in this
   round or either previous one.
3. **Real network conditions.** Loopback WebRTC on one machine. K-1's
   health-agreement figures are zero-lag; under real RTT the client's own bar
   will lag the host's by the interpolation delay and I have not seen how that
   reads.
4. **The 21-shot capture.** Not run: its default port is 5199 and the user is
   playtesting on this machine. Build is exit 0 and §9 covers the changed
   single-player paths, but nobody has re-shot the manifest against these edits.
5. **A client killing anything.** Still true, and now more pointed: `Progression`
   and `Profile` on a client credit damage *taken* off the forwarded
   `playerHurt`, and nothing at all off damage *dealt*, so a co-op client's run
   summary still reports 0 damage dealt. I did not measure it and it is not in
   this round's findings; it follows from the same missing-`damage` gap K-5 is
   about and should be the next thing anyone looks at.
6. **`flawlessStages` actually not firing on a client.** §7 closes its source,
   measured at `damageTakenThisStage 40`; I did not clear a stage in co-op.
7. **Tectonic Heart's every-third tally in single-player.** My jump probe reaches
   two presses of three (§1.2, §9), so the quake never had a chance to fire in
   *either* tree. The equality between trees holds; the third-jump behaviour is
   covered only by the round-1 critique's §7.1.
8. **F-6 at second 9, on either tree.** See §10's last paragraph.
9. **Whether any of it sounds right.** Still nobody has listened. `musicGain`,
   a cue count and a throw count are not a cue, and that is now five rounds old.
10. **`Player.js:1287`'s self-kill fallback.** Unreachable without a build that
    has no `Combat`. Source-level only, three rounds running.
