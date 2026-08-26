# Co-op netcode — host-authoritative over WebRTC

Up to 4 players. One player is the **host** and runs the real simulation; the
others are **clients** that predict only their own movement and render everything
else from the host's snapshots.

This is not rollback netcode. Hit registration is host-authoritative and arrives
one round-trip late. That is a deliberate trade — see "Why not predict combat".

## Roles

| | Host | Client |
|---|---|---|
| `ctx.authority` | `true` | `false` |
| `ctx.netRole` | `'host'` | `'client'` |
| Runs Director, spawns enemies | yes | **no** |
| Resolves damage / death | yes | **no** |
| Rolls loot, opens chests | yes | **no** |
| Advances stage / teleporter | yes | **no** |
| Simulates own player | yes | yes (predicted) |
| Simulates other players | yes | interpolated |
| Plays VFX / audio / HUD | yes | yes |

Single-player is the host path with zero peers, so `ctx.authority === true`
always holds offline and nothing needs a separate code path.

## The one rule

> **If it changes game state, gate it on `ctx.authority`.
> If it only changes what you see or hear, never gate it.**

```js
// wrong — client rolls its own loot, desyncs instantly
const item = ctx.rng.weighted(table);

// right
if (!ctx.authority) return;          // host decides; client learns via `itemPickup`
const item = ctx.rng.weighted(table);
```

## The seam

`src/net/` knows nothing about the gameplay systems: NetHost asks for a pawn
when someone joins, NetClient asks for a view when an entity appears, and
neither knows what those are. `src/net/Coop.js` is the one module that imports
both halves and answers all three questions. It is a normal engine system, added
in `main.js`, and costs one no-op `update` in single-player.

| hook | answered by | with |
|---|---|---|
| `ctx.spawnRemotePlayer(peerId)` | Coop | a `new Player({ local: false })` — same class, same simulation, but it never claims `ctx.player` and is stepped by NetHost off the wire rather than by the engine |
| `ctx.despawnRemotePlayer(pawn)` | Coop | unregister from Combat, drop the rig |
| `registerViewFactory(kind, …)` | `src/net/NetViews.js` | enemy / player / interactable views over the same pooled rigs the host uses, including the same distance LOD |
| `netWelcome` | Coop | adopt the host's seed and stage via `Progression.syncStage` |

`ctx.lobby` is the UI's entry point and is not a system — it owns no frame time.
`src/ui/Menus.js` drives it from the co-op screen and renders `onStatus` as one
line of plain language per state.

Snapshots identify entity *type* through the one-byte `typeId`: enemies carry
their index in `ENEMIES` (see `ENEMY_BY_TYPE`), interactables a `TYPE_ID` that
encodes chest size, since a client that only learned "chest" would render every
legendary as a small one.

## Integration checklist per system

These are the rules the gameplay systems follow. All of them are in place.

- **`Combat.applyDamage`** — early-return unless `ctx.authority`. Clients apply
  health purely from snapshot `healthFrac`. Damage numbers/hit sparks are
  cosmetic and fire on both from the `damage` event. One exception, and it is
  the only one: while a pawn's state is `ESTATE.DOWNED` its `healthFrac` is not
  health at all but its bleed-out clock as a fraction of `REVIVE.BLEEDOUT_S`
  (`NetHost._downedRecord`). A downed pawn's health is 0 for the whole state,
  so the field is spent on the number the rest of the party actually needs. The
  other clock, `revive`, is host-side only and crosses the wire nowhere at all.
  A client's revive ring (`HUD.reviveFraction`) is therefore an avowed
  approximation: it mirrors the host's eligibility test locally
  (`Roster.targetable(viewer)` plus the body's replicated position inside
  `REVIVE.REVIVE_RADIUS`), integrates the local `BTN.INTERACT` hold on
  `Revive`'s own timing, drains when the viewer is ineligible, and is capped
  below full so it can never render a completed revive the host did not grant.
  The authoritative "done" is the pawn standing up — `downed` clearing in the
  snapshot — which takes the whole prompt down with it.
- **`Director`** — `fixedUpdate` early-returns unless `ctx.authority`. Clients
  create enemies only as snapshot views.
- **`Items.roll` / `give` / drop tables** — host only. `give` is replicated via
  the `itemPickup` event, and clients apply it to their local inventory mirror
  so the HUD and stat block stay right.
- **`Progression`** — teleporter charge, boss gating, stage transitions: host
  only. Clients rebuild the stage on the `stageStart` event using the host seed.
- **`Interactables`** — interaction requests travel as the `INTERACT` button
  bit; the host decides and broadcasts the result.
- **`Player`** — must expose the four methods below.

## Required `Player` interface

`NetClient` and `NetHost` drive players exclusively through these. Movement code
must be a pure function of (state, command, dt) — no reads of `ctx.input` inside
the step, or replay during reconciliation will produce different results than
the original prediction.

```js
applyCommand(cmd, dt)   // cmd = { moveX, moveZ, buttons, yaw, pitch }; runs one 60Hz movement+ability step
getNetState()           // -> { x, y, z, vx, vy, vz, yaw, grounded, ... } — cheap, called every tick
setNetState(s)          // hard-set position/velocity during reconciliation
setRenderOffset(x,y,z)  // visual-only offset that hides small corrections; never affects simulation
```

`cmd.buttons` is the `BTN` bitfield from `Protocol.js`.

## Randomness

`ctx.rng` is the **gameplay** stream and is consumed only on the host. Clients
use it during stage generation (same seed, same calls, same terrain) and then
never again for gameplay.

Cosmetic randomness must use a **separate** stream, `ctx.fxRng`, or a client's
particle jitter would advance the shared stream and desync every subsequent
loot roll. VFX, audio variation, and animation noise all belong on `ctx.fxRng`.

## Wire format

Two DataChannels, chosen for opposite guarantees:

| channel | config | carries |
|---|---|---|
| `state` | unordered, `maxRetransmits: 0` | `INPUT` (client→host), `SNAPSHOT` (host→client), ping |
| `events` | ordered, reliable | `WELCOME`, `WORLD`, `MUTATE` (client→host), and one-shot facts: kills, item pickups, stage transitions, boss spawn |

`MUTATE` (issue #168) is the only *request* a client makes of the host, and the
only client→host message besides `INPUT` and `HELLO`. It answers the blight
toll's three cards: `u8` kind, `u32` offer id, `str` base id — an empty id being
a refusal. The offer it answers was minted on the host (`Items._openMutationChoice`)
and addressed to one peer as `mutationChoiceOffered`; the reply names no pawn,
because whose pack it touches is re-derived from the peer the bytes arrived on
(`NetHost._onMutate`), which is the one fact a sender cannot forge. Everything
else is checked against the live window in `Items.answerMutation` — a forged or
stale offer id, a card that was never offered, the second copy of a duplicated
reply — and a rejection is silent and changes nothing, so the toll still
resolves on the host's clock. A remote player who never answers, disconnects
mid-offer, or runs a build with no `MUTATE` in it pays exactly the void's own
band-seeded pick, which is what a remote toll always cost before the lever
reached it.

`WORLD` (issue #167) is the run's signature economy — corruption, band, peak,
void marks, argent motes, warded progress, the sanctuary clock, ruin and the
route's high-water band. It is *state*, not a delta stream, which is what makes
a late joiner correct: it is sent immediately after `WELCOME` and thereafter
only when something in it moves, at most once per frame. **27 bytes** (`u8`
kind, `f32` world, `u8` band, `f32` peak, `u16` marks spent, `f32` warded,
`u16` motes spent, `f32` sanctuary seconds, `u16` sanctuary epoch, `u8` ruined,
`u8` greed, `u8` peak band), a handful of times a run. The two spend counters
are cumulative, so the client derives each charge as the difference across an
applied block and can tell a purse that *minted* from one that *paid* — the
distinction `HUD.isMint` and `Audio`'s purse stings classify on. The sanctuary
epoch is what lets a replica whose own clock ran out a frame early accept the
host's surviving fraction of a second without re-announcing an ended window. The client writes it into its own `Corruption` through
`applyNetState`, which refuses to run on a host — so a client's instance is a
replica nothing but the wire writes, the host's is one the wire cannot write,
and the HUD, prompt prices, Argent grace, Codex gates and route forecast all
keep reading the one accessor they already read.

Snapshots run at **20Hz**. Positions are `i16` at 1/64 unit, angles `i16` over
±π, health a `u16` fraction of max. An entity record is 18 bytes (protocol 13
added a trailing affix byte — see below), so 60 entities is ~1.1KB/snapshot ≈
21.6KB/s down per client. Input is 13 bytes at 60Hz ≈ 780B/s up.

An enemy's affix and its cosmetic corrupted tint replicate from the host as
part of that record (issue #228): the trailing byte packs a 1-based index into
`AFFIX_IDS` (`data/enemies.js`) in its low 7 bits — `0` is "no affix" — and the
corrupted flag in the high bit. Both are decided once on the host at spawn
(`Enemy.js`) and never re-derived on a client; `NetViews.EnemyView` only reads
the wire and calls `setAffix` on it, including the transition back to `0` when
an affix is removed. Players and interactables always write `0` here.

The world is never streamed — clients regenerate it from the host's seed, which
is why `WELCOME` carries a seed instead of geometry.

`PROTOCOL_VERSION` (`src/net/Protocol.js`) is bumped by a change in **either**
the layout or the vocabulary. Layout is the obvious half. The vocabulary half is
the content ids that ride the events channel as JSON — `itemPickup`'s item id,
`realmEnter`'s realm id — because two peers that read every byte correctly and
then disagree about what a name means produce a silently wrong session, which is
worse than a garbled one. Ids that cross as an *index* (`typeId` for enemies,
`WELCOME`'s difficulty) are exempt: renaming one moves nothing on the wire.

## Timing model

- Client sends one input per 60Hz tick, tagged with a tick number.
- Host consumes **exactly one** command per pawn per tick (no action-rate
  advantage from flooding), repeating the last command if starved.
- Host stamps each client's last-processed tick into that client's snapshot.
- Client rewinds to the acked state, then **replays** every unacked command.
  Corrections under 2m are absorbed into a decaying render offset so the camera
  never jolts; larger ones snap.
- Remote entities render at `now - 100ms`, interpolated between the two
  snapshots straddling that time. Never extrapolated — extrapolation
  rubber-bands on every direction change, which looks far worse than a
  consistent, invisible 100ms.

## Signalling

`ManualSignaller` is the default and needs **zero infrastructure**: the host
generates an invite blob, the joiner pastes it and returns an answer blob. ICE is
gathered non-trickle so each side is a single copy/paste.

`tools/signal-server.mjs` (a small WebSocket relay) enables a normal room-code
flow when somewhere to host it exists. Both produce the same connected `Peer`.

STUN only — there is no TURN server, so two players both behind symmetric NAT
will fail to connect. That is the known gap; TURN costs money and is the only
real fix.

## Why not predict combat

Predicting hits means predicting damage, death, item procs and loot. Every
misprediction then has to be visibly rolled back: enemies un-dying, item pickups
retracted, procs unfiring. RoR2's own netcode does not predict these either.
Delayed-but-truthful reads better than immediate-but-retracted, and it keeps the
proc-chain logic — which is recursive and order-dependent — running in exactly
one place.
