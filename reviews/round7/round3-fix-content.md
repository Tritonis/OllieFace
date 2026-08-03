# Round 7 — round-3 content fixes

Answering `reviews/round7/round2-content.md` (critic B2) at HEAD `75f87d6` on
`round7/content-and-polish`.

Files touched, all of them owned by this fixer:
`src/data/items.js`, `src/data/enemies.js`, `src/data/abilities.js`,
`src/data/equipment.js`, `src/systems/Items.js`, `src/entities/EnemyMeshes.js`,
`src/entities/CharacterMesh.js`. Nothing else was edited.

---

## How this was verified

Round 2's lesson was that *a fix verified against the one arm it was reported in
closes that arm and nothing else*. So: every number below was measured in a
running game, none of it was read off source, and the arms that were **not**
tested are named in their own section at the bottom rather than left implicit.

Four throwaway Playwright drivers (`tools/_r3probe[1-4].mjs` plus a shared
`tools/_r3boot.mjs`) were written, run, and **deleted before finishing**. Their
raw JSON output is on disk and every figure quoted here can be read there:

| file | contents |
|---|---|
| `reviews/round7/r3-content/probe1-enemies.json` | thorn volley at four ranges; the whole Lasher card at 12 m; tier-1 roster comparison |
| `reviews/round7/r3-content/probe2-items.json` | Grapnel Tether at 1/2/10 stacks on a ground unit **and** a flyer, plus breadth across a pack; the quickfoot collision in all four combinations; Whetstone vs DoT and vs a pooled body; Aegis armour; Scrapfly Hive at 1/2/10; the stat-cache churn |
| `reviews/round7/r3-content/probe3-cinder.json` | Pyre Flask ignition and cloud channel; Emberwake's cloud; Conflagration payout and order-independence |
| `reviews/round7/r3-content/probe4-redoubt.json` | Ferrite Redoubt traverse counterplay, stationary vs circling, at two radii |

Launch config copied from `tools/capture.mjs` — headed Chromium on
`--use-angle=d3d11`, parked off-screen, one vite server per probe on its own
port (5351-5354). Each probe drives `__HARNESS__.gameplay()` into a real run,
restarts the engine loop, sets `ctx.director.enabled = false`, and then places
cards with `ctx.director.spawnOne`, fires abilities with
`ABILITIES[id].fire(ctx, player)`, and measures every damage figure through
`Combat.applyDamage` so armour, crit, i-frames and the proc chain are all live.

**All four probes finished with `ctx.frameErrors === 0`, `lastFrameError: null`,
zero console errors and zero page errors.**

### Two measurement corrections made mid-run, recorded so they are not mistaken for findings

- The first pass of probes 2 and 3 used punchbag dummies built with
  `attacks: []`, which throws every frame at `Enemy.js:1297`
  (`def.attacks[0].kind` is unguarded when the list is empty). 6448 and 752
  frame errors respectively — **entirely the probe's fault, nothing to do with
  these changes.** Re-run with one unreachable melee attack instead; both then
  reported zero. *This is a real pre-existing engine gap and `Enemy.js` is not
  mine to fix, so it is flagged here and nowhere else.*
- Probe 1's circling arm for the Redoubt was invalid: it recomputed the orbit
  radius from the live distance each frame, so the player drifted outward and
  the run ended at a mean radius of 108 m with the unit out of range. That arm
  is superseded by `probe4-redoubt.json`, which holds a fixed radius. Probe 1's
  *stationary* arm is valid and agrees with probe 4's to within 0.3 dps.

### What I assumed about the two engine fixes I do not own

Two of B2's findings are the combat fixer's:

1. **`slow` is inert on the player** (`Combat.speedMultiplier` has no callers).
2. **No `pull` can move a grounded player.**

I have assumed **both land**. Concretely:

- The **Gloomshriver** is repriced on the assumption that its `slow` will
  actually tax movement. If fix 1 does not land, the card still has no mechanic
  and my repricing makes it a slightly tougher card with no mechanic. Nothing I
  changed depends on the slow *magnitude*; I could not change it anyway, because
  `Director.js:885` hardcodes `count: 1` for a projectile's status rider and
  `Director.js` is not mine.
- **Grapnel Tether** keeps its `applyStatus(t, 'slow', ...)` untouched, on the
  same assumption.
- The **Bramble Lasher's** `reel` numbers are **untouched**. Its `pull: 19` was
  tuned against an assumption that was never true, and B2 is right that it needs
  re-tuning from scratch once the pull works — but that re-tune has to be done
  by whoever makes the pull work, against a live measurement of it. Tuning it
  blind here would be exactly the mistake round 2 called out. **This is left
  open and is the one thing in my scope I deliberately did not finish.** What I
  did fix is the *other* half of that card, the thorn volley, which was
  independent of the pull.

---

## Fixes

### 1. BLOCKING — Bramble Lasher dealt zero damage at its own preferred range

**Change.** `src/data/enemies.js` — `thorns.volley` 4 → 5, with a comment
stating the invariant (`volley` must be odd, because
`Enemy.launchProjectile` fans a volley symmetrically about zero and an even
count straddles the aim line).

**Before / after.** Source: `reviews/round7/r2-content/probe[B].json`
`results.thornVolley` and `attackCensus[1]` for the before; this round's
`reviews/round7/r3-content/probe1-enemies.json` `results.thornVolley` and
`results.lasherCard` for the after. Nine volleys at each range, player
stationary, thorns-only:

| range | hurt events before | damage before | hurt events after | damage after |
|---|---|---|---|---|
| 8 m | 1 | 13.9 HP | 8 | 92.4 HP |
| 12 m | 1 | 13.9 HP | 16 | 184.8 HP |
| **18 m** (`preferredRange`) | **0** | **0.0 HP** | **24** | **277.2 HP** |
| 22 m | **0** | **0.0 HP** | **34** | **392.7 HP** |

And the whole card unrestricted at a 12 m standoff:

| | before | after |
|---|---|---|
| duration | 45 s | 42 s |
| `playerHurtEvents` | **0** | **42** |
| damage | **0.0 HP** | **485.1 HP** |
| dps | **0** | **11.54** |

For scale, the Ferrite Redoubt measures 12.58 dps against a stationary player in
the same probe set, so the Lasher now sits just below the tier's turret rather
than at zero. The counterplay is unchanged and trivial — the thorns are a slow
gravity-arc volley with a 0.75 s windup.

### 2. MAJOR — CINDER's Pyre Flask applied no burn and rendered as a Spore Sac cloud

**Change.** `Items.addCloud` gained an options bag, which is the fix B2 asked
for and the right shape: it is the one shared hazard primitive, and every later
caller had been inheriting Spore Sac's hardcoded `type: 'spore'` and hardcoded
`0x9fdc6a` ring.

- `src/systems/Items.js` — `addCloud(position, radius, duration, dps, opts)`
  now carries `{ status, colour, type }` onto the cloud record, and
  `_tickClouds` passes all three through: `type` into the damage info, `colour`
  into the ring, and `status` onto anything standing in it.
- The status is **topped up, not stacked**: `if (!combat.hasStatus(t, status))`.
  An 8 s pyre ticking every 0.5 s would otherwise pile sixteen independent burn
  stacks onto one body and turn a setup tool into the largest DoT in the game.
  "Everything in the fire is burning" is the contract the ability describes, and
  one live stack satisfies it.
- `src/data/abilities.js` — Pyre Flask passes
  `{ status: 'burn', colour: 0xff7a2a, type: 'fire' }`.
- `src/data/items.js` — Emberwake Cleats passes `{ colour: 0xff7a2a, type:
  'fire' }` and **no status**: that card never claimed to ignite, and giving it
  burn would quietly promote an uncommon into an ailment engine. This closes the
  cosmetic collision B2 noted without inventing a mechanic.

**Before / after.** Source: `r2-content/probeE.json` `results.cinderIgnition`
and `probeC.json` `results.cloudSemantics` for the before;
`r3-content/probe3-cinder.json` `results.pyreFlask` / `results.emberwakeCloud`
for the after.

| | before | after |
|---|---|---|
| burn stacks on a body in the pyre | **0** | **1** |
| burn still live 6 s later | **0** | yes — 454 of the pyre's 480 frames had a live stack |
| peak burn stacks (stack-pile check) | n/a | **1** — bounded, as intended |
| cloud ring colour | `0x9fdc6a` (Spore Sac green) | `0xff7a2a` |
| cloud damage type | `spore` | `fire` |
| Emberwake cloud colour / type | `0x9fdc6a` / `spore` | `0xff7a2a` / `fire`, status `null` |

### 3. MAJOR — Grapnel Tether welded the horde into the player and grounded flyers

B2 proposed three lines at the call site. Two of the three are right and are
here; I treated the third as the stacking-curve problem the brief asked for
rather than as a clamp.

**Change** (`src/data/items.js`, plus a shared `onceEvery` helper):

- **Horizontal only.** The old `Vector3.lerp` interpolated `y`, which hauled a
  6.4 m flyer onto the floor. Altitude belongs to the mover, which is the only
  thing that knows `hoverHeight` and terrain.
- **A hard floor, `TETHER_FLOOR = 6`.** Not a bail-out below the floor but a
  clamp *on the destination*: `max(FLOOR, d * 0.66)`, so a reel from 20 m still
  takes a third and a reel from 8 m stops at 6. 6 m rather than contact because
  it is outside the melee reach of every ordinary spawn — a reel drags a shooter
  into the kill zone without stacking a pack inside the player's own hitbox.
- **The stacking curve moved from depth to breadth**, `TETHER_RECOVER = 1.5`.
  Stacks buy proc chance and nothing else; each *body* may only be reeled once
  every 1.5 s. Ten stacks reel far more of the field, and no longer reel one
  body sixteen times in four seconds. The per-body cooldown is keyed on
  `Enemy.id`, so a pooled body does not inherit the previous monster's timer.
- Velocity is zeroed on x/z only, for the same reason as the position.

**Before / after.** Source: `r2-content/probeC.json` `results.harpoon` for the
before (10 stacks, 30 hits, ~4 s of Ranger primary fire);
`r3-content/probe2-items.json` `results.tether` for the after, same window, run
at 1, 2 **and** 10 stacks and against a ground unit **and** a flyer:

| stacks | unit | distance before | distance after | y before | y after |
|---|---|---|---|---|---|
| 10 | ground (mite) | 19.92 → **0.02 m** | 20.03 → **6.02 m** | 4.41 → 3.38 | 4.41 → 3.11 (terrain; untouched by the reel) |
| 10 | Gloomshriver (`hoverHeight` 6.4) | 21.24 → **0.02 m** | 21.14 → **8.87 m** | 10.55 → **3.39 (floor)** | 10.23 → **9.91** |
| 2 | ground | — | 20.03 → 13.30 m | — | — |
| 2 | Gloomshriver | — | 21.18 → 10.39 m | 10.35 → 9.04 | |
| 1 | ground | — | 20.03 → 8.79 m | — | — |
| 1 | Gloomshriver | — | 21.49 → 21.16 m (no proc landed in the window) | — | — |

The flyer's residual y drift (0.3-1.3 m) is the hover mover's own oscillation
over the measurement window, not the tether: the reel never writes `y`.

Breadth check, 10 stacks, 8 bodies, 240 hits over 20 s: **8 of 8 bodies moved**,
mean distance 22.12 → 6.18 m, **minimum 6.01 m**. The floor holds exactly and
the item is still a strong crowd tool at full stack — it just cannot put
anything inside the player.

### 4. MAJOR — Conflagration's order-dependent 4-6x overpay

Three changes in `src/data/abilities.js`, addressing determinism and payout
separately as the brief required:

- **The burning set is captured before the first detonation** (into a new
  `_lit` scratch buffer, so the filter and its source are not the same array).
  The cascade — a body lit by an earlier blast passing the `hasStatus` test when
  the loop reached it — is gone, and with it the dependence on `_group`'s
  spatial-hash ordering.
- **`falloff: false` removed.** Overlapping 5.5 m blasts each paying full damage
  to every body in range was the second half of the overpay. `Combat.explode`'s
  falloff bottoms out at 0.35, so a cluster still pays more than a lone target —
  it just no longer scales in the square of the pack size.
- **The blast is centred on the body, not on the raised VFX point.** With
  falloff live those stopped being the same thing: an epicentre lifted 0.4 of
  the target's height put the detonating body a metre off its own explosion and
  paid it 93% of the printed 600%. The fire still *draws* from the chest.
- The description now names the blast: *"Detonate every burning enemy within
  34m: each one bursts for 600% damage in 5.5m."*

**Before / after.** Source: `r2-content/probeE.json`
`results.cinderIgnition.loop` and `probeC.json`
`results.cinder.conflagOneLitTight` for the before;
`r3-content/probe3-cinder.json` `results.conflagration` for the after. Stated
per-body damage was 72 in this run (13 damage stat differs slightly from the
reviewer's 78; the ratios are what matter):

| formation | before | after |
|---|---|---|
| 8 bodies @3 m, **1** lit | 2 bodies detonated, **332** total vs 78 stated (**4.3x**) | 2 bodies damaged, **103** total vs 72 stated (**1.4x** — 72 on the lit body, 31 of splash on its neighbour) |
| 4 bodies tight, **3** lit | **1321** vs 234 stated (**5.6x**) | 8 bodies @3 m, 3 lit: **369** vs 216 stated (**1.7x**) |
| isolated body, 1 lit | — | **72**, i.e. *exactly* the printed number |
| 8 bodies @9 m, **0** lit | 7 (burn ticks only) | **0** |

**Determinism.** Each formation was cast twice with the bodies created in
opposite order — which is what decides insertion order into Combat's spatial
hash, and therefore `_group`'s iteration order, and therefore the old cascade's
size. Both pairs returned **byte-identical per-body damage arrays**
(`[72,31,0,…]` and `[103,135,104,27,0,…]`).

### 5. MAJOR — Prey Instinct silently downgraded Bloodied Spurs

**Change.** Prey Instinct writes its own buff slot, `preyfoot`
(`src/data/items.js`), and `Items.stats` multiplies it alongside `quickfoot`
(`src/systems/Items.js`).

**I rejected B2's "better and one line" alternative** — making `addBuff` take
`Math.max` of both `magnitude` and `remaining`. It looks like the general fix
and is not: with 10x Prey Instinct held, a kill would take the 1.8 magnitude
from Prey and the 15 s timer from Spurs and hand the player +180% movement for
fifteen seconds *after* they healed out of the condition. That is a bigger lie
than the collision it repairs. `addBuff`'s overwrite semantics are documented in
place instead, with the rule stated: a buff name is a shared slot, pick one
nobody else uses.

**Before / after.** Source: `r2-content/probeC.json`
`results.quickfootCollision`; `r3-content/probe2-items.json`
`results.movementBuffs`.

| inventory (at 20% health where relevant) | move speed before | move speed after |
|---|---|---|
| 5x Spurs, after a kill | 8.40 | 8.40 |
| 1x Prey Instinct | 8.26 | 8.26 |
| **5x Spurs + 1x Prey, 0.5 s after a kill** | **8.26** (a downgrade) | **9.91** |
| 5x Spurs + 10x Prey, at a kill | Prey's 1.800 collapsed to **0.200** | `quickfoot` 0.200 / 14.57 s **and** `preyfoot` 1.800 / 0.50 s, both live — 23.52 |

Spurs' window is no longer truncated: `quickfoot.remaining` reads **14.55 s**
where it read **0.50 s**.

### 6. MAJOR — Chipped Whetstone switched off by DoT, and by the enemy pool

Two distinct causes, both fixed at `src/data/items.js`.

- **DoT.** `outgoing` now returns early on `info.isDot` *before* the stamp is
  written. `Combat.modifyOutgoing` runs for DoT ticks as well as hits, and a
  burn ticks every 0.5 s for 4 s, so any burn the player applied kept its own
  target permanently inside the four-second opener window. An opener is a hit; a
  tick of something already alight is not one, and should neither be paid the
  bonus nor reset the clock.
- **Pooling.** The `_lastStruck` entry now carries `Enemy.id` — the counter the
  entity already mints fresh on every `spawn` — alongside the timestamp, and a
  mismatched id reads as "never struck". No `Enemy.js` change was needed; the
  token was already there. The stale comment claiming the WeakMap's weak keys
  buy collection is corrected in place: the Director's pool holds every Enemy
  for the life of the run, so nothing in it is ever collected.

**Before / after.** Source: `r2-content/probeC.json` `results.whetstoneVsDot`
and `probeE.json` `results.whetstonePooling`; `r3-content/probe2-items.json`
`results.whetstone`.

| condition | first hit | after 5 s, before | after 5 s, after |
|---|---|---|---|
| control | 100 → 170 | **170** | **170** |
| player-applied burn on the target | 100 | **100** | **170** |
| target standing in a player-owned pyre/Emberwake cloud | 100 | **100** | **170** |

Pooling, driven by re-`spawn`ing the same `Enemy` instance — literally what
`Director.spawnOne` does when it pops one off `this.pool`:

```
brandNewBody:        170     <- bonus fires
sameBodyImmediate:   100     <- correctly denied, still inside the window
sameObjectReused:    true
idBefore: 21   idAfter: 22
recycledBody:        170     <- was 100 (r2 probeE); a fresh spawn now gets its opener
```

The `sameBodyImmediate: 100` line is the control that matters: the fix restores
the pooled case *without* also handing the bonus to a target the player is
already shooting.

### 7. MAJOR — Aegis Emitter granted +60 against a declared +30

**Change.** The dome grants through `Items.addBuff('aegis', 0.7, 1,
AEGIS_ARMOR)` (`src/data/equipment.js`) and `Items.stats` adds
`aegis.magnitude` into `s.armor` (`src/systems/Items.js`).
`Combat.armorOf(player)` reads `entity.stats.armor`, so this is the same channel
the number was always meant to arrive on.

`Player.grantBuff` only ever **pushes**; it has no refresh semantics, so a 0.7 s
grant on a 0.5 s tick always had two live entries. `Items.addBuff` refreshes the
one named slot, which is what the card's comment always claimed it was doing.
`Player.js` is not mine and did not need touching. Halving the constant was
rejected as B2 rejected it: it produces the right number today and breaks
silently the moment either the interval or the duration moves.

**Before / after.** Source: `r2-content/probeD.json`
`results.equipment.aegisEmitter`; `r3-content/probe2-items.json`
`results.aegis`. Declared: `+30 armor`.

| | before | after |
|---|---|---|
| armour before entering | 4 | 0 (this probe's survivor has no armour items) |
| armour inside the dome | **64** (+60) | **30** at every one of 12 samples across 3 s |
| armour after leaving | 4 | 0 |

The lapse-on-exit half, which already worked, still works.

### 8. MAJOR — the Ferrite Redoubt's stated counterplay was geometrically impossible

`trackDuring` names a beam-tracking rate the engine does not have, and
implementing it would mean editing `Enemy.js`, which is not mine. So I took B2's
second option and **made the geometry reachable instead**, which is the honest
fix: the card's stated identity is now what it actually does.

**Change** (`src/data/enemies.js`):

- `turnRate` 1.1 → **0.6**, `preferredRange` 20 → **13**. These are one number,
  not two. A player circling at radius *r* sweeps `sprintSpeed / r` rad/s, so
  out-turning the unit needs `r < 10.15 / turnRate`. At 1.1 that ceiling was
  9.2 m while the unit held 20 m. At 0.6 the ceiling is **16.9 m**, so a 13 m
  stand-off sits inside it with room for a real circle rather than a perfect
  one. The `backblast` nova (6 m) is the inner wall, leaving a 6-13 m band where
  the stated play is the play.
- `trackDuring` **removed** from all three cards that carried it (redoubt,
  golem, and the tier-4 beam at `:1145`). `git grep` confirms zero consumers
  anywhere in `src/`. Leaving two of three in after being told the field is dead
  would have been worse than removing none.
- The card comment is rewritten to state the arithmetic rather than assert the
  fight.

**Before / after.** Source: `r2-content/probeG.json` `results.redoubtTraverse`;
`r3-content/probe4-redoubt.json`. 40 s per run, sprint-speed circle held at a
fixed radius about the unit:

| | before (`preferredRange` 20, `turnRate` 1.1) | after (13 / 0.6) |
|---|---|---|
| stationary — dps | 12.32 | 12.58 |
| stationary — fraction of frames outside the front arc | 0.08 | 0.12 |
| circling — dps | 8.21 | 0 |
| **circling — fraction of frames outside the front arc** | **0.01** | **0.567** |
| circling at the *old* 20 m radius, for comparison | — | 0.397 |
| enemy yaw travelled while circling | 1.82 rad | 16.66 rad |

That 0.01 → 0.567 is the finding closed. B2's exact observation was that *"the
player spent **less** time outside the front arc while circling than while
standing still"* — 0.01 against 0.08. It is now 0.567 against 0.12: circling
reaches the exposed rear for more than half the fight, and standing still does
not.

**Honest caveat on the 0 dps.** My circle is a machine circle at exactly sprint
speed with no reaction time, so it is an upper bound on the counterplay, not a
typical outcome. What the run establishes is the *geometry* — that the back is
reachable — not that a human takes zero damage.

### 9. MINOR, judgment call — Scrapfly Hive

**Decision: keep it, and give it the mechanic its own description already
promised.** Cutting was the alternative and I think it is wrong here: the
description ("release a scrapfly that strikes a nearby enemy") describes a
distinct card, and what was missing was the implementation, not the idea. A
16-item round cannot afford a duplicate; it can afford to build the card it
already wrote down.

Two of the three things the description promised are now real:

- **The fly is a position.** It is released at the survivor and closes on its
  quarry, and it re-acquires from *where it is* rather than from
  `player.position`. So it works while the player retreats, it follows a pack
  the player has disengaged from, and its reach is measured from the front line
  instead of from the survivor. That is the concrete difference from Hive Gland,
  which is `seekingStrike` from `player.position` and nothing else.
- **It commits to one body until that body dies, applying `bleed` on every
  strike.** Hive Gland sprays N distinct targets for burst; this picks one and
  takes it apart. That also ties the card to Afflictor's Index and the ailment
  half of the pool, which was round 1's suggestion and could not previously be
  followed because there was nothing to lean into.

The third promise — a rendered entity — is still not kept, and I have not
claimed it is. Drawing one would mean an `Enemy`-shaped object or a new VFX
primitive, neither of which is in my files.

**Verification.** Source: `r3-content/probe2-items.json` `results.scrapfly`, two
bodies 3 m apart, one release each at 1, 2 and 10 stacks:

| stacks | per-body damage | focused one body | frames with `bleed` live (of 480) |
|---|---|---|---|
| 1 | `[0, 262]` | yes | 479 |
| 2 | `[355, 0]` | yes | 479 |
| 10 | `[1104, 0]` | yes | 479 |

Solving `D + B = 262` and `10D + B = 1104` gives **D = 93.6** and B = 168.4 —
i.e. the strike component is still *exactly* linear in stacks, and 93.6 at one
stack is the identical figure `r2-content/probeC.json` measured for the old
implementation. The stack-capture closure the card's comment was written to
protect still holds; the 168 of extra damage is the new bleed.

### 10. MINORS

| finding | change | evidence |
|---|---|---|
| **Gloomshriver dominated by the 9-credit Spitling** | `baseHealth` 95 → **130** and `knell.cooldown` 3.4 → **3.0** (`enemies.js`), with the comment rewritten to pay for the 15 credits on axes the Spitling lacks rather than assert them | `probe1-enemies.json` `results.tier1Roster`: shriver now 130 HP / 3.0 s cd / 2 homing shells / 24 m / hover 6.4 against spitling 105 HP / 2.6 s / 1 lobbed arc / 20 m / grounded, at `maxAlive` 3 and `packMax` 2 against 6 and 4. It is no longer dominated on any axis |
| **dead `LSH_CROWN`** | removed (`EnemyMeshes.js`). The lasher's six arms are real, so only the unused constant went | build passes; capture unchanged |
| **CINDER rig comment claims six lamps, three are built** | comment corrected (`CharacterMesh.js`): three lamps at 0.09 m spacing — a 0.18 m strip — plus the pilot light on a tank cap, and the narrower strip is now stated as *why* `cellGain: 0.66` is needed rather than in spite of it | `buildCinder` at `CharacterMesh.js:1682-1687` and `:1719` |
| **Emberwake 3 m vs 3.2 m** | description now says 3.2 m, matching the call | `probe3-cinder.json` `results.emberwakeCloud.radius: 3.2` |
| **Prey Instinct defeats the stat cache** | `Items.addBuff` no longer dirties the cache when only `remaining` changed. `remaining` is not an input to `stats`, so a pure timer refresh must not force a rebuild | `probe2-items.json` `results.statCache`: **1** rebuild per 180 frames below 40% health, against 180 before (the mechanism B2 measured as +82% per-step cost). Zero rebuilds when healthy, zero with no items |

---

## Arms I did **not** test

Named explicitly, because this is the failure mode round 2 identified.

1. **Multiplayer / client.** Every measurement is host-authoritative
   (`ctx.authority` true). The tether's displacement, the cloud status and the
   Whetstone stamp all sit behind authority guards that I did not exercise from
   the client side.
2. **The Lasher's `reel` after the pull fix lands.** Deliberately untouched (see
   the assumptions section). Nobody has measured `pull: 19` against a pull that
   works, including me.
3. **The Gloomshriver's `slow` after the speed fix lands.** I verified its stat
   line, not its mechanic, because its mechanic does not exist yet.
4. **Elite affixes.** Every spawn in every probe used `affix: null`. The
   Redoubt's re-tuned traverse against a `swift` elite is unmeasured, and so is
   an elite's `wardArmor` interacting with the front-arc arithmetic.
5. **Conflagration against bosses.** All Conflagration runs were mites. A boss
   inside the blast radius, and the phase-gated `frontArmorPhase` path, are
   untested.
6. **Tether against a boss.** The `isBoss` exclusion is unchanged and was read,
   not run.
7. **Whetstone x Hunter's Tag.** B2 raised the two as deliberately paired; I
   tested Whetstone against DoT and against pooling, not against the Tag.
8. **The Aegis dome's slow half.** I measured the armour. The `applyStatus(t,
   'slow', ...)` on enemies inside the dome is the combat fixer's arm and I did
   not re-measure it.
9. **Scrapfly Hive with the quarry dying mid-window.** The re-acquire path
   (`if (!quarry?.alive)`) executed in code but every probe body had 10 M health,
   so it never actually re-acquired. This is the weakest verification in the
   report.
10. **Two Pyre Flasks overlapping.** `MAX_CLOUDS` bounding was checked by B2 and
    not re-checked here; two burn-applying clouds on one body were not measured
    (the top-up guard makes it a no-op by construction, but by construction is
    not a measurement).
11. **Real gameplay input.** Every probe drove `player.position` directly rather
    than through `ctx.input`. Nothing here depends on the input path, but no
    number below came from a human playing.

---

## Not fixed, with reasons

- **`slow` inert on the player** and **`pull` cannot move a grounded player** —
  the combat fixer's, by assignment.
- **Bramble Lasher `pull: 19` re-tune** — see assumptions above. Needs to be
  done against a working pull, by whoever makes it work.
- **`Enemy.js:1297` throws every frame for a unit with an empty `attacks` array**
  (`def.attacks[0].kind` unguarded). Found by my own probe tooling. Not a
  shipping defect — no card has an empty attack list — but it is a live
  landmine for anyone writing a spawn card or a test dummy. `Enemy.js` is not
  mine.
- **`Items.timeSinceHurt` reset by fully-absorbed hits** (B2 #10) — `Items.js`
  is mine but `Combat.js` is not, and the combat fixer appears to have already
  changed the emit site: the comment at `Combat.js:449` now reads *"a
  fully-absorbed hit does not emit `playerHurt` at all"*. Adding a second guard
  in `Items.js` on top of that would be belt-and-braces on a contract I cannot
  see the final shape of. **Flagged for whoever integrates: confirm exactly one
  of the two guards exists.**
- **Scrapfly Hive's rendered entity** — see #9. Would need a VFX or entity file.
- **`Director.js:885` hardcodes `count: 1`** for a projectile's status rider, so
  no spawn card can apply a heavier slow than any other. This is why the
  Gloomshriver had to be differentiated on stats rather than on the strength of
  its signature effect. `Director.js` is not mine.

---

## Build and capture

- `node node_modules/vite/bin/vite.js build` — **passes** (only the pre-existing
  chunk-size advisory).
- One interruption worth recording: mid-session the build broke with
  `SyntaxError: Unexpected identifier 'paintFocus'` from a concurrent fixer's
  in-progress edit to `src/ui/Menus.js` (a backtick inside a template literal).
  It was theirs and it resolved on its own within minutes. No file of mine was
  involved and I did not touch it.
- Full 21-shot capture:
  `node tools/capture.mjs --out reviews/round7/r3-content/shots --port 5361`.
  Source for every figure below: `reviews/round7/r3-content/shots/manifest.json`.

| | |
|---|---|
| shots written | **21 / 21**, `partial: false` |
| `subjectsOk` | **false** — one failing check |
| `subjectFailures` | **`06-loaded-hud` / `monsters under load`** and nothing else |
| `frameTimeouts` | **0** |
| `clockPinned` | true, `frameDt` 1/60 |
| `errors` | **1 entry**, which *is* the `06-loaded-hud` harness assertion. Zero page errors, zero other console errors |
| `audioOk` | true — context `running`, `stepsEmitted: 354` |

**The one failing check is the known pre-existing one and I did not make it
worse.** `E-framing.md` §5 records it as object 6 failing on *separation*, not
size: `px: 137` (clearing the 100 floor) with `sepP50: 0.17` against a 0.25
requirement, from a live director population that alternates pass/fail run to
run. This capture reports **object 6, `px: 145`, `sepP50: 0.17`** — the same
object, the same margin, the same cause. `09-survivors`, which was the *other*
failure in `E-framing.md`'s baseline, passes here.

The three `toleratedAbsences` (`04-combat`, `08-explosion`, `10-inventory`) all
carry `checkOk: true` and are the documented VFX-pool and crowd-gate tolerances,
unchanged.

---

## Artifacts

- `reviews/round7/r3-content/probe1-enemies.json` … `probe4-redoubt.json` —
  raw probe output, kept.
- `reviews/round7/r3-content/shots/` — the full 21-shot capture and its
  manifest.
- `tools/_r3boot.mjs` and `tools/_r3probe[1-4].mjs` — deleted before finishing,
  per the round's convention for throwaway tooling.
- Nothing committed. The work is left in the tree.
