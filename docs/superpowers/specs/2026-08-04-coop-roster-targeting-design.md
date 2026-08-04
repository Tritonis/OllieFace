# P0 + P1 — lifecycle sweep, latency rig, roster and enemy targeting

**Date:** 2026-08-04 · **Roadmap:** `2026-08-04-multiplayer-roadmap-design.md`

The goal of this sub-project, stated as one sentence a player would recognise:

> **Every enemy in the arena fights whichever player is nearest it, and leaving
> co-op leaves your survivor working.**

Today neither is true. `Enemy.js` routes all targeting and all damage to
`ctx.player` — on a host, its own survivor — so a guest is ignored by every
enemy on the map (measured: **78 directed hits on the host, 0 on a pawn 3 m
away** over 30 s). And `Lobby.leave()` never resets `ctx.netRole`, so a survivor
that has been in a co-op session never moves again.

---

## P0 — lifecycle sweep and latency rig

Four defects already diagnosed to the line in `reviews/round7/coop/round5-critique-coop.md`,
plus one new tool. All are small. They come first so that no measurement taken
during P1 is taken on a tree that is still broken underneath it.

### P0-1 · C-2 — `Lobby.leave()` does not reset `ctx.netRole`

`Lobby.leave()` (`src/net/Lobby.js:236`) restores `mode`, `ctx.authority`,
`players` and status, but leaves `ctx.netRole` reading `'client'` forever.

The consequences are wider than the summary recorded. `netRole` gates four
different things:

- `Player.fixedUpdate` (`src/entities/Player.js:366`) —
  `if (ctx.netRole !== 'client') this.applyCommand(this._sampleCommand(ctx), h)`.
  This is the measured **0.000 units of movement**: the survivor stops sampling
  its own input.
- `Engine.js:357` and `:363` — damage attribution filters.
- `Profile.js:1272` and `:1369` — a stale non-`'single'` role **silently
  disables profile and achievement recording** for the rest of the page's life.

**Fix:** add `this.ctx.netRole = 'single';` to `leave()`.

**Verification:** at both ends of the range — a survivor that never joined
(unchanged), and a survivor that joined and left (moves again, records profile
again). Fail the gate on purpose by reverting only this line.

### P0-2 · C-7 — `HELLO_MAX_PAWN_AGE` is counted in the wrong unit

`HELLO_MAX_PAWN_AGE = 120` (`src/net/NetHost.js:35`) is compared against
`this.tick - c.joinTick`, a frame-driven counter, but expresses a wall-clock
intent. 120 host ticks is ~2 s at 60 fps and **~15 s** at the ~8 ticks/s a
throttled arm runs at. It is the mirror image of the `HOLD_GRACE` defect: that
one uses wall clock where it should count snapshots sent; this one counts ticks
where it should use wall clock.

**Fix:** record a wall-clock join timestamp alongside `joinTick` and compare
against seconds. `joinTick` stays — it remains the honest measure of pawn age
for anything counted in ticks.

**Must land before P0-3**, or the new refusal path inherits the same 15 s
timeout.

### P0-3 · C-1 — the fifth HELLO door

`_onHello` refuses a peer whose HELLO is duplicated, unparseable, truncated,
version-mismatched, survivor-invalid, or late. It cannot refuse a peer that
**never sends one at all** — `helloSeen` stays `false` and nothing ever looks.
Such a peer is simulated as the host's survivor for the entire session:
measured host `ranger` **70.17/110** vs joiner `anvil` **108.44/170**, both
lobbies reading "connected", **0 console errors, 0 page errors, 0 `[net]`
warnings**. It is silent in every channel a person would look in.

**Fix:** ~4 lines in `NetHost.fixedUpdate` — for each client with
`!helloSeen` whose join is older than the P0-2 wall-clock threshold, call
`_refuse(peer, REFUSE.HELLO, 'no identity message')`. Reuses the existing
refusal path, so both machines get the plain-English explanation round 5 built.

### P0-4 · C-10 — a host panel that reads "connecting…" forever

`Lobby.acceptAnswer` (`src/net/Lobby.js:116`) awaits `invite.accept(answerBlob)`
and only then calls `_set('peerConnecting')`. But `accept` resolves the `ready`
promise, which fires `onPeer` → `netPlayerJoined` → the status set for a
*successful join* — which the line after the await then overwrites back to
"Reply accepted — connecting…", permanently.

**Fix:** move `_set('peerConnecting', { id })` **above** the `await`. One line.

### P0-5 · C-4 — input un-mute behind a menu

`NetHost._holdSession` sets `ctx.input.enabled = !live`. For up to
`HOLD_GRACE` (1.5 s) after the last peer dies, pause-menu keystrokes also drive
the host's survivor. One line.

### P0-6 · The `?netlag=` rig *(new)*

~30 lines in `src/net/Transport.js`. Behind a URL flag resolved through
`NetConfig` (consistent with `?signal=`, `?turn=`, `?ice=`), wrap `Peer.sendState`
/ `Peer.sendEvent` and the inbound `onmessage` to apply:

- `?netlag=<ms>` — one-way delay, optionally `<min>-<max>` for jitter
- `?netloss=<pct>` — drop probability, applied to the **unreliable channel only**
  (dropping on `events` would misrepresent a reliable channel's guarantees)

Constraints: zero cost and zero code path when the flag is absent —
single-player and normal co-op must not pay for this. Delay is implemented with
a timestamped queue drained on the existing update, not a `setTimeout` per
packet.

**This is the most valuable 30 lines in P0.** Every measurement from P1 onward
runs at both 0 ms and a realistic RTT. Every number in seven prior rounds came
from two pages on one machine at zero latency.

---

## P1 — roster and enemy targeting

### The finding that makes this small

**The enemy FSM does not need to change.** Every steering behaviour, state
transition and attack selection in `Enemy.js` — lines 571 through 1547 — already
reads three *per-enemy* fields: `this.target` (a `Vector3`), `this.distToPlayer`
and `this.hasLOS`. They were always per-enemy. The only thing wrong is
`Enemy.js:449-455`, which fills them from a global.

So P1 changes *where three fields get their values from* and leaves the risky
part — the FSM, the steering, the pack-stagger timing — untouched.

### P1-1 · `src/systems/Roster.js` *(new, ~60 lines)*

An ordinary engine system. It lives in `src/systems/`, **not** `src/net/`:
`Enemy.js` reaching into `ctx.coop` for a target would invert the layering
`Coop.js`'s own header exists to maintain ("the seam between the netcode and the
game", so gameplay never imports net).

```
ctx.roster.all              // every registered player entity
ctx.roster.alive            // alive and not downed — the targetable set
ctx.roster.local            // the viewer's own pawn (=== ctx.player)
ctx.roster.count            // roster size
ctx.roster.nearest(pos, opts)   // nearest targetable player, or null
```

Registration: `Player.init` adds, `Player.dispose` removes. `Coop._spawnPawn`
and `_despawnPawn` already call exactly those, so pawns join and leave the
roster for free.

`alive` filters on both `alive` and a `downed` flag. **P1 defines `downed` and
honours it in the query; P3 implements the behaviour around it.** Until P3
lands, `downed` is always `false` and the filter is a no-op — but writing it now
means P3 does not have to revisit the targeting hot path.

**Client side:** the client does not simulate enemies, so it needs no targeting.
It does need teammate positions and health for the HUD, and on a client those
teammates are `PlayerView` objects, not `Player`s. The roster accepts anything
flagged `isPlayer`, so views register too.

**The invariant:** in single-player the roster holds exactly one entity,
`nearest()` returns `ctx.player`, and **every number in the game is identical to
HEAD**. That property is what makes this migration verifiable rather than
hopeful.

### P1-2 · Sticky target acquisition

Replace `Enemy.js:449-455`. Each enemy gains `this.targetPlayer`, held across
frames.

```
this.retargetT -= h;
if (this.retargetT <= 0 || !isTargetable(this.targetPlayer)) {
  this.retargetT = RETARGET_INTERVAL;
  this._acquireTarget(ctx);
}
// then fill this.target / this.distToPlayer exactly as today
```

- `retargetT`'s **initial** value is keyed off the enemy's index so 60 units
  never re-query on the same step — the same stagger pattern `losT` already uses
  at `Enemy.js:459-463`.
- `_acquireTarget` switches only when
  `bestDist < currentDist * SWITCH_MARGIN` (~0.8), or when the current target is
  dead, downed or gone. **That margin is the anti-oscillation fix** the session
  summary calls for: without it, two players standing together make every enemy
  in the arena flip its target every re-evaluation.

Both `RETARGET_INTERVAL` and `SWITCH_MARGIN` are named constants with a comment
stating the failure at **each** end of their range — a margin of 1.0 oscillates,
a margin near 0 makes an enemy chase one player past a teammate standing on top
of it.

### P1-3 · The 21 `ctx.player` reads in `Enemy.js`

Three groups, each with a mechanical rewrite:

| Group | Lines | Rewrite |
|---|---|---|
| Null-guards | 600, 802, 819, 1303, 1309, 1343 | → `this.targetPlayer` |
| Damage / aim / velocity | 36, 54, 63, 449, 616, 865, 948, 1017, 1113, 1126, 1186, 1547 | `hurtPlayer`/`statusPlayer` take an explicit victim; aim reads `this.targetPlayer` |
| Attribution bug | 1159 | see below |

**`hurtPlayer(ctx, source, amount, type, at)` becomes
`hurtPlayer(victim, source, amount, type, at)`** — the victim is passed
explicitly rather than looked up from a global. This is the signature change
that makes the rest impossible to get subtly wrong: there is no longer a default
victim to fall back to.

**`explodeAt` is already correct** on its main path — it delegates to
`combat.explode`, which is team-based and reaches every player. That accident is
why area damage *did* reach guests, and why K-1, K-5, F-10, L-3 and M1 survived
N-1. Its `ctx.player` fallback branch (`Enemy.js:54-57`) still needs fixing, to
iterate the roster.

**A bug found while scoping this:** `Enemy.js:1159` attributes a self-kill with
`source: ctx.player`. On a host, that credits the host for a suicide that
happened next to a guest. It becomes the real killer, or `null`.

### P1-4 · `fireBeam` — a deliberate design choice

`fireBeam` (`Enemy.js:1110`) currently aims at and damages `ctx.player`. It
becomes: **aim at `targetPlayer`, damage every player whose capsule intersects
the segment.** A hitscan beam that passes through your teammate without hurting
them reads as broken, and the segment test is already written — it just runs
once instead of over a roster.

### P1-5 · `Director.denyHealing` becomes per-player

`Director.denyHealing` (`src/systems/Director.js:340`) writes a single global
`healDenyUntil`, so one withering elite currently denies healing to **everyone on
the map** — including players it has no line of sight to, which is precisely the
counterplay the method's own comment says it is preserving.

The deny moves onto the victim; the caller at `Enemy.js:486` already knows
which player it has LOS to. `Director.healingDenied` becomes a per-player query;
the HUD asks about `roster.local`. `FinalBoss.js` is the other caller and needs
the same treatment.

### P1-6 · Spawn placement

`MIN_SPAWN_DIST` is measured from `ctx.player`. It becomes a measurement from
the **nearest** player, or enemies materialise on top of a guest who has
wandered away from the host.

### P1-7 · Balance pass

Spawn budget and `populationCap` already scale with `playerCount` — but that
scaling has never once been exercised against enemies that actually split their
aggro, because no enemy has ever targeted a pawn. Two players now genuinely
divide attention, which changes effective incoming DPS per player in a way no
static reading predicts.

**This is settled by the hand-play gate, not by a number in a report.**

---

## Testing

There are currently **zero covering tests** for `Enemy`, `Player.applyCommand`,
`NetHost`, `hurtPlayer` or `statusPlayer`. P1 does not fix that in general, but
it does not add to it either.

**Unit / headless (new):**
- `Roster` — registration, removal, `nearest()` with an empty roster, a
  single-entry roster, ties, and a roster where every entry is dead or downed.
- Target acquisition — hysteresis at both ends: two players at equal distance do
  not cause a switch; a player crossing the margin does.
- Single-player equivalence — a fixed-seed headless run against HEAD, asserting
  identical enemy positions and damage totals. **This is the load-bearing test.**

**Integration (probe rigs, following the existing round-4/5 pattern):**
- Two-page and four-page sessions, gated on `paused false` and `_localTick > 60`
  on **every** page before any instrument is installed.
- The N-1 measurement re-run: directed hits on host vs on pawn, over 30 s. HEAD
  reads 78/0. The gate is that both counts are substantial and roughly track
  proximity.
- Every arm run twice: `?netlag=0` and `?netlag=60`.
- Each fix's gate **failed on purpose, one fix at a time**.

**Hand-play gate:** a full co-op run played by hand, two humans, at least one
over a real remote network. Not satisfied by any scripted arm.

---

## Out of scope

Per-player items and gold (P2), downed/revive behaviour (P3, though P1 defines
the `downed` flag), TURN provisioning and `wss://` signalling (P4), and the
audio listening pass.

The remaining "authority simulates one player" reads are deferred to the
sub-project that owns their subsystem, named here so none of them goes
unclaimed:

- **`Interactables.js` (6 reads)** → **P2.** Chest, shrine and orb proximity is
  the same question as chest, shrine and orb *ownership*, and P2 already owns
  that.
- **`Realms.js` (8) and `FinalBoss.js` (1)** → **P3**, except
  `FinalBoss`'s `denyHealing` call, which P1-5 must fix alongside the
  `Director` change or the boss keeps the global behaviour after the elite
  loses it. Realm arenas are authored encounters with their own scripted
  targeting; they need a design pass, not a mechanical substitution, and
  reaching them before revive exists would mean specifying them twice.
- **`Combat.js` (3)** → **nothing. They are already correct and must not be
  touched.** `Combat.js:467`, `:483` and the comment at `:491` gate
  `shieldBroken` and `playerHurt` on `=== ctx.player` rather than `isPlayer`,
  which is a round-5 fix: a remote pawn *is* `isPlayer`, so before it, a
  teammate 40 m away losing health reset this player's "time since hurt"
  (Field Dressing and Siege Battery both key off it), flashed their HUD and
  ducked their music. Any task that "migrates Combat to the roster" is
  reintroducing that bug.

`PROTOCOL_VERSION` does **not** change in P0 or P1. No wire format moves here.
