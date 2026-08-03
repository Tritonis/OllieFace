# Round 7 — round-2 content critique (items, CINDER, the three enemies)

Reviewer: independent second-pass critic. Not involved in building any of this.
Scope: `cf7e63e` content — `src/data/items.js`, `abilities.js`, `survivors.js`,
`enemies.js`, `equipment.js`, `entities/CharacterMesh.js` (CINDER rig),
`entities/EnemyMeshes.js` (the three new rigs), and how they land through
`systems/Combat.js`, `systems/Items.js` and `core/Harness.js`.
Bar: would this ship in a AAA roguelike. Default answer is no.

Inputs read first: `reviews/round7/F-critique-content.md` (round 1) and
`reviews/round7/B-content.md` (the author's own writeup, treated throughout as a
set of claims to test rather than as evidence).

---

## Methodology

Everything below that is marked **CONFIRMED** was reproduced in a live browser
session against the real GPU path. Everything marked **PLAUSIBLE** is reasoned
from source only and says so.

Round 1 could not complete a direct spawn/fire probe. That gap is closed. Seven
throwaway Playwright drivers were written into `tools/_r2probe[A-G].mjs`, run,
and **deleted before finishing**; their raw JSON output is on disk at
`reviews/round7/r2-content/probe[A-G].json` and every number quoted below can be
read there.

Launch config was copied verbatim from `tools/capture.mjs`'s default — headed
Chromium parked off-screen with `--use-angle=d3d11`, which is the path this
machine actually renders on. (Round 1's note about `--use-angle=swiftshader` is
correct for a headless run; headed off-screen is faster here and is what the
project's own capture pipeline uses.) Each probe booted its own vite server on
its own port (5311-5317), navigated to
`?seed=1337&quality=1&harness=1&pinclock=1`, drove `__HARNESS__.gameplay()` to
start a real run, then took over: `ctx.director.enabled = false`,
`ctx.director.spawnOne(ctx, def, at, null)` to place cards,
`ABILITIES[id].fire(ctx, player)` to fire the kit, `ctx.input.keys` to drive
movement, and `Combat.applyDamage` for every damage measurement so armour,
crit, i-frames, the proc chain and the kill dispatch were all exercised.

| probe | what it measured |
|---|---|
| A | `slow`/`freeze` on the player and on a monster; shriver/lasher/redoubt spawn→attack→die→retire; first pass at the pull |
| B | attack-state census per unit; the pull measured off `anim.beamOn` across five configurations; thorn-volley hit rate at four ranges; tier-1 roster comparison |
| C | stacking maths at 0/1/2/10 stacks; the `quickfoot` collision; Whetstone vs DoT; cloud semantics; CINDER's four abilities; Grapnel Tether; `onInterval` cost; 60 000 drop rolls |
| D | `Enemy.pullPlayer` driven directly against the player controller; arc-capacitor / scrapfly-hive / tectonic-heart / temporal-echo / ashen-pact / blight corruption; both new equipment cards; all five rigs |
| E | CINDER's ignition sampled the frame after each cast; Whetstone vs the Director's enemy pool; primary DPS across the roster; the shield / `timeSinceHurt` question |
| F | Stoke's per-cast hit rate — **retracted, see below** |
| G | Stoke with the body placed exactly on the fire ray; the Redoubt's armour split; the Redoubt's traverse counterplay |

Also run: a static glyph/icon integrity cross-check (`tools/_r2glyph.mjs`,
deleted) over every `glyph:` reference in `items.js` and `equipment.js` against
every `case` in `drawGlyph`.

**Reported inconclusive, not cited as evidence either way:**

- **Probe F is retracted.** It measured Stoke landing 2-5 casts in 20 against a
  target the camera was pointed at, and looked like a serious defect. Probe G
  placed the body exactly on `player.fireRay()` instead and got **20/20 at 2 m,
  4 m and 6 m for exactly the expected 247 damage**. The probe-F shortfall was
  camera-to-muzzle parallax *in my test rig* (measured: 0.339 rad against a
  0.42 rad cone half-angle — right on the edge), not a bug. Stoke's cone is
  correct. `probeF.json` is left on disk labelled as such.
- `probeD.results.remainingHooks.gorgeTooth.maxHealth` reads 125 where the
  stat block should have shrunk. That is my probe reading `player.stats` before
  a fixed step rebuilt it, not a defect. Ignored.
- `probeD.results.rigs` reports `nodes: 0, tris: 0` for all five survivors — I
  traversed `mesh.root`, which does not exist. The `frameErrorsAdded: 0` column
  in that same table is valid and is cited; the geometry counts are not.
- `probeA.results.slowOnMonster` shows a 17% difference in distance travelled
  that I cannot attribute. Not cited. The player-side measurement in the same
  probe is unambiguous and is what finding #1 rests on.
- The first `--only 09-survivors,11-bestiary` capture into
  `reviews/round7/r2-content/shots` timed out on `page.goto` while another
  probe held the GPU. The retry succeeded and is reported just below. No
  *visual* claim in this report rests on it: round 1 already did the cropped
  native-resolution rig inspection, I have no reason to dispute its
  conclusions, and a 1600x900 thumbnail is not evidence about silhouette read.

**Capture result.** `node tools/capture.mjs --out reviews/round7/r2-content/shots --port 5322 --only 09-survivors,11-bestiary` returned `subjectsOk: true`,
`subjectFailures: []`, `errorCount: 0`, `toleratedAbsences: []`,
`frameTimeouts: 0`, clock pinned. Both of the two shots `B-content.md` §4
reports as failing **pass when captured in isolation**, which corroborates that
writeup's own account that the misses are site-dependent framing rather than
runtime defects. I did not re-run the full ordered suite — round 1 did that
twice, and I had no hypothesis it could test that the probes could not test
better.

---

## Blocks calling this AAA

### 1. `slow` does nothing to the player. The Gloomshriver's entire reason for existing is inert.

**Where:** `src/systems/Combat.js:578` (`speedMultiplier`, defined, **zero
callers anywhere in `src/`**); `src/systems/Combat.js:529-535` (`armorOf`
returns early for the player, before the `-15` slow branch);
`src/data/enemies.js:341` (`knell`, `status: 'slow'`);
`src/data/enemies.js:305-315` and `:330-334` (the card comments that make this
the unit's whole identity).

**What happens.** The Gloomshriver is priced at 15 credits — above the Spitling,
the Wisp and the Lemurian — and given only 8 base damage, explicitly because
"what it takes from the player is not health… a slowed player in a horde is a
player who cannot leave". The slow it applies has no mechanical effect of any
kind.

**Reproduction** (`probeA.json` → `results.slowOnPlayer`). Player sprinting
forward on flat ground for 3 s, with the status re-applied every frame so it is
live for the whole window:

| condition | mean stacks held | `speedMultiplier` says | peak speed | distance in 3 s |
|---|---|---|---|---|
| clean | 0 | 1.000 | **10.150** | **13.34 m** |
| slow x1 | 0.99 | 0.604 | **10.150** | **13.34 m** |
| slow x5 | 4.94 | 0.258 | **10.150** | **13.32 m** |
| freeze x1 | 0.99 | 0.011 | **10.150** | **13.32 m** |

A held freeze — which `Combat.speedMultiplier` correctly reports as a near-total
stop — costs the player 0.02 m over three seconds. `armorOf(player)` with a slow
live returns 0, the same as clean: the player does not even take the armour
penalty a slowed monster takes.

**Root cause.** `Combat.speedMultiplier` computes the right answer and nobody
asks it. `git grep -n speedMultiplier master -- src/` returns exactly one line —
the definition — so this is **inherited from master, not introduced this
round**. That does not make it someone else's problem here: round 7 shipped a
spawn card, an equipment card and an item whose stated value is this effect, and
verified none of them against it.

**Blast radius inside this round:** Gloomshriver's `knell`
(`enemies.js:341`); Grapnel Tether's "reel an enemy… and slow it"
(`items.js:1038`); Aegis Emitter's "enemies inside it are slowed"
(`equipment.js:377` — the dome does apply the status, measured at 3 stacks, and
the status does nothing to their movement). Pre-existing casualties: Frost
Lattice, Hoarfrost Band, Concussion Charge, the Spitling.

**Fix.** Two lines, in files this round does not own:
`src/entities/Player.js:477` — `const speed = stats.moveSpeed * (sprinting ?
SPRINT_MULT : 1) * (ctx.combat?.speedMultiplier?.(this) ?? 1);` and the
equivalent at `src/entities/Enemy.js:548`. Until one of them lands, the
Gloomshriver should not ship: it is a 15-credit tier-1 card with 8 damage, a
3.4 s cooldown and no mechanic, measured at **2.31-3.23 dps** against a
stationary player over 45 s (`probeB.json` → `attackCensus[0]`,
`shriverValue`).

---

### 2. No `pull` attack in this game can move a grounded player. The Bramble Lasher is built entirely on one.

**Where:** `src/entities/Enemy.js:988-1006` (`pullPlayer` adds to
`player.velocity.x/z`); `src/entities/Player.js:495-513` (`_accelerate`
re-steers the horizontal velocity toward `wish * speed` at `GROUND_ACCEL = 68` /
`GROUND_DECEL = 86` m/s² on the same fixed step); `src/data/enemies.js:621-624`
(`reel`, `pull: 19`).

**Reproduction A — the mechanism** (`probeD.json` → `results.pullPhysics`).
`Enemy.pullPlayer` driven directly for 1.5 s at a fixed distance, exactly as the
ATTACK state drives it:

| attack | `pull` | distance | resulting acceleration | net ground closed |
|---|---|---|---|---|
| Lasher `reel` | 19 | 10 m | 11.69 m/s² | **0.000 m** |
| Lasher `reel` | 19 | 5 m | 15.35 m/s² | **0.081 m** |
| Maw `draw` | 26 | 10 m | 16.00 m/s² | **0.002 m** |
| Herald `collapse` | 30 | 10 m | 18.46 m/s² | **0.000 m** |

**Reproduction B — in a real fight** (`probeB.json` → `results.pull`). Five
40-second configurations, each with 4-5 complete reel windows and 180-272 frames
of live suction:

| configuration | reel windows | ground lost during the pull | net |
|---|---|---|---|
| stand/walk, 1 lasher | 5 | **0.00 m** | player gained 8.01 m |
| sprint, 1 lasher | 4 | **0.00 m** | gained 8.00 m |
| sprint, slow x3 held (the shriver composition round 1 worried about) | 4 | **0.00 m** | gained 8.00 m |
| sprint, 3 lashers (`maxAlive`) | 5 | **0.03 m** | gained 37.93 m |

**Root cause, arithmetic.** The maximum pull acceleration in the game is
30 m/s² (Herald, at contact). The player's horizontal correction rate is 68 m/s²
while steering and 86 m/s² while stopping. `_accelerate` computes
`need = |wish*speed - v|` and applies `min(need, rate*h)` — so whenever the pull's
per-step velocity injection is smaller than `rate * h`, the correction snaps the
velocity **exactly** back to the target and the injected component never reaches
the position integrator. It is not a weak pull; it is a pull that is discarded
before it is ever used.

**This is the adjudication of round 1's finding #2** — see the section below.

**Fix.** Move the suction out of the velocity channel: either apply it to
`player.position` directly (a displacement, which is what a reel is), or route
it through a pending-impulse channel applied *after* `_accelerate`, the way
`Items.applyImpulse`/`consumeImpulse` already does for Tectonic Heart. Then
re-tune from scratch — the current numbers were chosen against an assumption
that was never true, so "never beats a full sprint" is not a claim anyone has
tested.

---

### 3. A Bramble Lasher cannot damage a stationary player at its own preferred range.

**Where:** `src/data/enemies.js:629-632` (`thorns`: `volley: 4`,
`volleySpread: 0.34`).

**Reproduction** (`probeB.json` → `results.thornVolley`). The unit forced onto
`thorns` only, player stationary, 9 volleys (36 rounds) at each range:

| range | volleys fired | player hurt events | damage |
|---|---|---|---|
| 8 m | 9 | 1 | 13.9 HP |
| 12 m | 9 | 1 | 13.9 HP |
| **18 m** (`preferredRange`) | 9 | **0** | **0.0 HP** |
| 22 m | 9 | **0** | **0.0 HP** |

And the whole card, unrestricted, at a 12 m standoff for 45 s with 6 reels and
6 thorn volleys fired (`probeB.json` → `attackCensus[1]`):
`playerHurtEvents: 0`, `playerDamageHP: 0`, `dps: 0`.

**Root cause.** `Enemy.launchProjectile` fans a volley as
`t = (i/(n-1) - 0.5) * 2` — symmetric about zero. With an **even** `n`, no round
is fired on the aim line. At `n = 4, spread = 0.34` the innermost pair sits at
±0.113 rad; at 18 m that is ±2.05 m of lateral offset, against a combined
player+projectile hit radius of ~0.75 m for a direct hit. The Acolyte
(`enemies.js:723`) uses 5 rounds and the Herald (`:816`) uses 7 — odd counts,
which put one round down the middle — and the Matron (`:985`) compensates with
`scatter: 5.0`. The Lasher does neither.

Compose this with finding #2 and the card's own comment ("the reason standing at
mid range and ignoring it is not free either") is precisely inverted: standing
at mid range and ignoring a Bramble Lasher is free, for 45 seconds, measured.

**Fix.** `volley: 5` (or add `scatter`), matching the pattern every other
non-boss volley in the file already uses.

---

## Major — would block a content sign-off, not a build

### 4. CINDER's secondary applies no burn at all, and renders as a Spore Sac cloud

**Where:** `src/data/abilities.js` `cinderPyreFlask` →
`ctx.items?.addCloud?.(_origin, 6, 8, 0.9)`; `src/systems/Items.js:626`
(`addCloud(position, radius, duration, dps)` — no status, no colour parameter);
`src/systems/Items.js:1012-1039` (`_tickClouds`: `type: 'spore'`, **no
`applyStatus` call anywhere**, and a hardcoded ring colour `0x9fdc6a`).

**Reproduction** (`probeE.json` → `results.cinderIgnition`). Ability fired at a
registered dummy, statuses sampled the frame after the pyre lands and again 6 s
later:

| cast | pyre distance from body | damage the pyre dealt | burn stacks | burn after 6 s |
|---|---|---|---|---|
| Stoke (primary) | — | 12.4 direct | **1** | 0 (expired) |
| Backdraft (utility) | — | 12.7 direct | **1** | 0 (expired) |
| Pyre Flask, aimed down at 8 m | 2.1 m (inside the 6 m radius) | 87.9 | **0** | **0** |
| Pyre Flask, point blank at 3 m | 2.6 m | 100.7 | **0** | **0** |

And `probeC.json` → `results.cloudSemantics`: an 8-second pyre on a body dealt
43.2 damage, applied `burnStacksApplied: 0`, `anyStatus: []`, and the only ring
colour drawn for its entire life was **`0x9fdc6a` at r6** — Spore Sac green.

**Why it matters.** The description says "leaves a 6m pyre **burning** for 8s"
and `B-content.md` §2 states explicitly: *"the flask does **not** claim [a
status] — the ignition comes from the pyre it leaves."* It does not. For a kit
whose Special pays per burning body and whose loop is stated as *apply → spread
→ detonate*, the only ranged setup tool contributes nothing to the count. The
primary and the utility both ignite correctly; the flask you throw into a pack
before you close does not.

Emberwake Cleats (`items.js:1058`) shares the same primitive, so its "cinder
patch" is also a green spore ring — a cosmetic collision rather than a
mechanical one, since that item never claimed to ignite.

**Fix.** `Items.addCloud` is the one shared hazard primitive and already takes
four positional arguments; extend it to `addCloud(position, radius, duration,
dps, { status, colour, type } = {})` and have `_tickClouds` pass them through.
Pyre Flask then asks for `{ status: 'burn', colour: 0xff7a2a, type: 'fire' }`.
If `systems/Items.js` stays unowned, the fallback is for Pyre Flask to schedule
its own repeating overlap and apply the burn itself — worse, because it
duplicates the bounded-cloud accounting.

---

### 5. Grapnel Tether has no floor: at 10 stacks it welds the horde into the player and grounds every flyer

**Where:** `src/data/items.js:1036` — `t.position.lerp(api.player.position, 0.34)`.

**Reproduction** (`probeC.json` → `results.harpoon`). 10 stacks (a 50% proc
rate by `hyperbolic(0.10, 10)`), 30 hits — about four seconds of Ranger primary
fire:

| target | start distance | end distance | procs | start y | end y | ground y |
|---|---|---|---|---|---|---|
| ground unit | 19.92 m | **0.02 m** | 16 | 4.41 | 3.38 | 3.38 |
| Gloomshriver (`hoverHeight: 6.4`) | 21.24 m | **0.02 m** | 16 | 10.55 | **3.39** | 3.38 |

The lerp has no minimum stand-off, no terrain test, and interpolates **y** as
well as x/z — so it drags a flyer designed to hold 6.4 m of altitude onto the
floor and leaves it there. 0.66¹⁶ × 20 m = 0.0025 m; the measured 0.02 m is the
arithmetic working exactly as written.

The item's own comment excludes bosses "because a boss whose position the player
controls has no fight left in it". That argument applies to the rest of the
field and is not applied to it.

**Fix.** Three lines at the same site: bail below a minimum stand-off
(`if (t.position.distanceTo(api.player.position) < 4) return;`), lerp x and z
only (leave `y` to the mover, which is what respects `hoverHeight`), and gate
repeat procs on the same body with `api.items.cooldownReady('harpoon:' + id, 1)`.

---

### 6. Conflagration pays 4-6× its stated damage through an undocumented cascade whose size depends on buffer order

**Where:** `src/data/abilities.js` `cinderConflagration` — the detonation loop
calls `c.explode(_a, 5.5, damage * 6.0, player, { status: 'burn', falloff:
false })` while re-testing `c.hasStatus(e, 'burn')` against a snapshot taken
*before* any damage.

**Reproduction** (`probeE.json` → `results.cinderIgnition.loop`). Four mites in
a tight cluster; Stoke lit three of them; Conflagration cast one frame later:

```
litByStoke:      3
conflagDamage:   [332, 332, 332, 325]     <- the 4th was never burning
statedPerBody:   78                       (13 damage x 600%)
```

Total 1321 against a documented 234. And (`probeC.json` →
`results.cinder.conflagOneLitTight`) 8 bodies at 3 m spacing with exactly **one**
lit: 2 bodies detonated for **332** total against a stated 78. The same 8 bodies
at 9 m spacing with one lit: 7 damage (burn ticks only — nothing detonated).

**Two compounding causes.** Each detonation re-applies `burn` inside its 5.5 m
radius, so a body that was *not* burning at cast time gets lit and then passes
the `hasStatus` test when the loop reaches it. And `falloff: false` on
overlapping 5.5 m blasts stacks full damage on clustered bodies. Because
propagation can only travel *forward* through the overlap-buffer ordering, the
same formation pays a different amount depending on spatial-hash iteration
order — the outcome is not just bigger than documented, it is non-deterministic
with respect to anything the player can see.

**Fix.** Either capture the burning set before the loop and iterate that
(`const lit = _group.filter((e) => c.hasStatus(e, 'burn'))`, then drop `status:
'burn'` from the detonation) — which makes "600% per burning body" true — or
keep the cascade deliberately and rewrite the description to say so. The current
state is the worst of the three.

---

### 7. Two items write one buff slot: Prey Instinct silently downgrades Bloodied Spurs

**Where:** `src/data/items.js:685-689` (Prey Instinct: `addBuff('quickfoot',
0.5, 1, linear(0.18, n))`, every fixed step while below 40% health) against
`src/data/items.js:532` (Bloodied Spurs: `addBuff('quickfoot', linear(3, n), 1,
0.2)`); `src/systems/Items.js:560-567` — `addBuff` **overwrites** both
`magnitude` and `remaining`.

**Reproduction** (`probeC.json` → `results.quickfootCollision`):

| inventory | state | magnitude | remaining | player move speed |
|---|---|---|---|---|
| 5x Spurs | after a kill | 0.200 | 14.8 s | **8.40** |
| 1x Prey Instinct | at 20% health | 0.180 | 0.5 s | 8.26 |
| 5x Spurs + 1x Prey, 20% health | 0.5 s after the same kill | **0.180** | **0.50 s** | **8.26** |
| 10x Prey + 5x Spurs, 20% health | a kill lands | collapses 1.800 → **0.200** | 15 s | — |

Picking up a second movement common makes the player **slower** (8.26 vs 8.40),
and truncates Spurs' fifteen-second window to half a second for as long as
health stays low. With Prey stacked, every kill momentarily craters a +180%
movement bonus to +20%.

`B-content.md` §1 argues at length that Whetstone deliberately avoided writing
into `Items.mark` because "two items writing one shared set of marks would mean
picking up either silently powers the other". The identical care was not taken
one card earlier, in the same tier, in the same commit.

**Fix.** Give Prey Instinct its own buff name and read it alongside `quickfoot`
in `Items.stats` (`s.moveSpeed *= 1 + preyfoot.magnitude`) — or, better and one
line, make `addBuff` take `Math.max(b.magnitude, magnitude)` and
`Math.max(b.remaining, duration)`, which fixes every future collision of this
shape at once.

---

### 8. Chipped Whetstone is switched off by the player's own damage-over-time — and by the Director's enemy pool

**Where:** `src/data/items.js:665-671` — the `outgoing` hook stamps
`_lastStruck.set(target, now)` on **every** damage instance;
`src/systems/Combat.js:398-400` calls `modifyOutgoing` for DoT ticks as well as
for hits (`isDot` is not excluded).

**Reproduction A — any DoT kills it** (`probeC.json` →
`results.whetstoneVsDot`):

| condition | first hit | after 5 s |
|---|---|---|
| control (nothing on the target) | 100 | **170** |
| a player-applied burn on the target | 100 | **100** |
| the target standing in a player-owned cloud (CINDER's pyre / Emberwake) | 100 | **100** |

A burn ticks every 0.5 s for 4 s and each tick re-stamps the target, so the
4-second opener window can never elapse. On CINDER, whose primary ignites
everything it touches, Whetstone is a dead common. Ashen Pact ("all of your hits
ignite") does the same to it, as do Warm Coals and the Leaking Jerrycan on a
proc.

**Reproduction B — recycled monsters inherit the stamp** (`probeE.json` →
`results.whetstonePooling`):

```
brandNewBody:         170      <- bonus fires
sameObjectReused:     true
recycledBody:         100      <- a *fresh spawn* denied the opener
recycledAfterWindow:  170
pooledObjectsTotal:   3
```

`Director.clear` (`Director.js:730-737`) and the corpse reaper
(`Director.js:275-287`) push dead `Enemy` instances into `Director.pool`, and
`spawnOne` (`:530`) pops them back out. A newly spawned monster is literally the
previous one's object, carrying its `_lastStruck` timestamp.

Those same strong pool references also falsify the comment at
`items.js:150-152` — *"Weak keys also mean a horde that dies mid-stage is
collected without anyone having to sweep this"*. The Director holds every Enemy
object for the life of the run, so nothing in `_lastStruck` is ever collectable.

**Fix.** At `items.js:665`, return early for DoT (`if (info.isDot) return
amount;`) before the WeakMap write. For the pooling half, clear the entry when a
body respawns — the cheapest correct form is to stop keying on the pooled
instance and key on a per-spawn token the Enemy already has to mint anyway.

---

### 9. The Aegis Emitter grants double the armour it advertises

**Where:** `src/data/equipment.js:379` — `a.player.grantBuff?.({ armor:
AEGIS_ARMOR }, 0.7)` inside an `addEffect(..., 0.5, ...)` tick;
`src/entities/Player.js:661-663` — `grantBuff` **pushes** an entry onto
`_buffs`, and live entries are additive.

**Reproduction** (`probeD.json` → `results.equipment.aegisEmitter`):

```
armorBefore:        4
armorInsideDome:    64        <- declared +30
armorAfterLeaving:  4
```

A 0.7-second buff granted every 0.5 seconds always has two live entries. The
description at `equipment.js:344` promises `+30 armor`; the card delivers +60.

The comment at `equipment.js:374-377` claims this pattern is a refresh — *"a
short buff refreshed while inside expires on its own with no enter/exit
bookkeeping to get wrong"*. `grantBuff` has no refresh semantics; it only
accumulates. The lapse-on-exit half does work correctly (armor returns to 4).

**Fix.** Add an optional replace-key to `Player.grantBuff` and use it here.
Halving the constant would produce the right number today and silently break the
moment either the interval or the duration moves.

---

### 10. The Combat.js change fixes two of the three defects its own comment claims

**Where:** `src/systems/Combat.js:460-473` emits `playerHurt` even when
`dealt === 0` (deliberately, so the HUD still flashes) —
and `src/systems/Items.js:203-205` listens unconditionally:
`ctx.events.on('playerHurt', () => { this._lastHurt = ctx.time; })`.

The comment added this round at `Combat.js:428-439` lists three things the old
`dealt` bug caused, the third being *"It also reset 'time since last hurt' for
the items keyed on that, on hits that cost nothing."*

**Reproduction** (`probeE.json` → `results.shieldAndLastHurt`). A 50-damage hit
against a 55-point barrier:

```
shieldBefore: 55   shieldAfter: 5   healthLost: 0
onDamagedHooksFired:            0      <- fixed, correctly
timeSinceHurtBeforeAbsorbedHit: 7.42
timeSinceHurtAfterAbsorbedHit:  0.00   <- NOT fixed
```

Field Dressing, Siege Battery and Mineral Lick all key off
`Items.timeSinceHurt()` and are all still reset by a hit a barrier ate whole.

**Fix.** One line at `Items.js:205`:
`ctx.events.on('playerHurt', (e) => { if ((e?.amount ?? 1) > 0) this._lastHurt = ctx.time; })`.

---

### 11. The Ferrite Redoubt's stated counterplay is geometrically unavailable, and the field that would have implemented its beam tracking is dead

**Where:** `src/data/enemies.js:679` (`trackDuring: 0.9` — **no consumer
anywhere in `src/`**; also dead at `:543` and `:1122`, both pre-existing);
`src/data/enemies.js:583-597` (the card comment); `src/entities/Enemy.js:1080-1090`
(`fireBeam` derives its horizontal direction from `this.yaw` alone).

The card's design rationale is that *"the beam can follow you, the **body**
cannot"* and that the fight is *"circling faster than it can traverse… a player
who keeps circling eventually arrives at the open back"*. Neither half holds.

There is no separate beam tracking: `fireBeam` corrects only `dir.y` toward the
player and takes x/z straight from the enemy's yaw, so the beam traverses at
exactly the body's `turnRate` of 1.1 rad/s. `trackDuring` is the field that
names the mechanic and nothing reads it.

And the circling cannot win. To out-rotate 1.1 rad/s at the player's sprint
speed of 10.15 m/s you must be inside r = 10.15 / 1.1 = **9.2 m**. The unit's
`preferredRange` is 20 and its beam reaches 38, and inside 6 m the `backblast`
nova punishes you for being there.

**Reproduction** (`probeG.json` → `results.redoubtTraverse`), 40 s each:

| player | damage taken | dps | enemy yaw travel | fraction of frames player was outside the front arc |
|---|---|---|---|---|
| stationary | 492.7 | 12.32 | 2.19 rad | **0.08** |
| sprint-strafing | 328.4 | 8.21 | 1.82 rad | **0.01** |

Circling does cut damage by a third — but by making the beam *miss*, not by
reaching the back. The player spent **less** time outside the front arc while
circling than while standing still. The exposed rear core is decoration at the
range the unit holds.

**Fix.** Either implement `trackDuring` (let the beam's aim lead the body for
that many seconds, which is what the design describes and what would make the
slow traverse meaningful), or drop `preferredRange` to ~12 m so the geometry the
card is written around is actually reachable. Do not ship the comment as-is —
it documents a fight that cannot happen.

---

## Adjudication of round 1's two open items

### Round 1 #2 — "Bramble Lasher's `pull` on an ordinary tier-2 card is a design risk not stress-tested against the horde" — **REFUTED, and for a worse reason than round 1 feared**

Round 1 was right to want the directed playtest and right that it hadn't been
done. The result is the opposite of the worry. Both halves of the feared CC
chain are inert:

- The `slow` half cannot tax movement speed at all (finding #1: identical peak
  speed and distance with 0, 1 and 5 stacks, and with a freeze held).
- The `pull` half cannot move a grounded player at all (finding #2: net closure
  0.000-0.081 m across six direct measurements and five 40-second live
  configurations, including the exact composition round 1 named — sprinting away
  with three slow stacks continuously re-applied).

Three Bramble Lashers at `maxAlive`, all reeling, against a sprinting player,
cost the player **0.03 m** of ground across 5 reel windows while he gained
37.93 m. There is no unanswerable CC chain because there is no CC. Round 1's
concern is dismissed on evidence, but the card it was worried about is worse off
than if the concern had been correct.

### Round 1 #3 — "Scrapfly Hive sits very close to three existing periodic-strike items" — **UPHELD, and the writeup's stated differentiator does not exist**

Round 1 declined to call it padding on the grounds that "the 5-second
DoT-follower shape is genuinely different from an instant burst", echoing
`B-content.md`'s claim that it is "the only one with a persisting DoT-follower
entity, not just an instant strike". Read the code:

- `scrapfly-hive` (`items.js:1087-1096`): `onInterval` → `cooldownReady(14)` →
  `addEffect(5, 1.0, () => seekingStrike(a, **a.player.position**, ..., 1, ...))`.
- `queens-gland` (`items.js:1402-1405`): `onInterval` → `cooldownReady(10)` →
  `seekingStrike(api, **api.player.position**, ..., linear(3, n), ...)`.

There is no entity and no DoT. `addEffect` is a timer; the "scrapfly" is five
**instantaneous** `seekingStrike` calls originating from the player's own
position, one second apart, drawn with the same `ctx.vfx.beam` in a different
colour. Hive Gland is three of the same call at once, from the same origin. The
only real difference is temporal spread and rate: 650% per 14 s (46%/s) against
600% per 10 s (60%/s).

So Scrapfly Hive is a lower-tier, lower-rate Hive Gland using the identical
primitive from the identical origin. Round 1's read ("a tooltip-only comparison
will read it as another Spark Plug") is correct and understated — it is not
merely thematically close, it is mechanically the same call. Its description
("release a scrapfly that strikes a nearby enemy") also promises a visual the
game does not draw.

I would still not call it padding — it is one card among sixteen, and the pool
can carry it. But the round-1 recommendation to lean into what is mechanically
distinct cannot be followed, because nothing mechanically distinct is there to
lean into. Either give it a real persisting entity, or give it a real DoT
(`applyStatus(target, 'bleed')` on each strike would do it and would tie it to
Afflictor's Index), or accept it as a rate variant and stop claiming otherwise.

---

## What round 1 missed

Listed here because the brief asked for it, with pointers to the findings above.

- **Silently dead numbers.** `trackDuring: 0.9` on the Redoubt's `enfilade`
  (finding #11) and `const LSH_CROWN = 2.05` at `EnemyMeshes.js:4104`, declared
  and never referenced. `status: 'slow'` on the Gloomshriver's `knell` is not
  dead data — the shell does apply it (`Director.js:884`) — but the status it
  applies is (finding #1).
- **Glyph and icon integrity is better than round 1 measured, and clean.** Round
  1 checked for duplicates *within a tier*. I checked across the whole set:
  **122 cards, 122 `drawGlyph` cases, zero duplicate glyphs anywhere, zero
  orphan cases, zero glyphs falling through to `default`.** Nothing to fix.
- **Tier weighting is not distorted by the sixteen additions.** 60 000 rolls
  through `Items.rollItem(null, 'small')` (`probeC.json` → `results.dropTable`):
  common 76.09%, uncommon 19.10%, legendary 0.89%, blight **3.92%** against a
  designed `BLIGHT_SHARE` of 4%. Every new common lands at 0.0236-0.0247 against
  a uniform expectation of 0.761/31 = 0.02455, and every new legendary at
  0.0005-0.0006 against 0.00049. The additions dilute each existing card in a
  tier proportionally (common 28→31, uncommon 26→31, legendary 15→18) and
  nothing else moves.
- **Per-frame cost of the new `onInterval` hooks is real but small**
  (`probeC.json` → `results.intervalCost`): 0.83 µs/step empty, 3.03 µs/step
  holding one of every non-blight item, and **5.50 µs/step** (+82%) with the
  same inventory once health drops below 40%. The mechanism is that Prey
  Instinct calls `addBuff` every fixed step, which sets `Items._dirty`
  unconditionally, so `Items.stats` rebuilds the whole block 60 times a second
  instead of returning the cache. Absolute cost at 60 Hz is 0.15 ms/s — not a
  frame problem today. Flagged only because it scales with inventory size and
  the cache exists precisely to stop that.
- **Rig documentation drift.** The CINDER palette comment
  (`CharacterMesh.js:195-198`) and `B-content.md` §2 both justify `cellGain:
  0.66` by "six lamps in a 0.4 m strip across the chest and shoulders".
  `buildCinder` creates **three** chest lamps at 0.09 m spacing — a 0.18 m strip
  — plus one pilot light on a tank cap (`CharacterMesh.js:1683-1687`, `:1719`).
  The value may still be right; the reason given for it is not.
- **Tooltip drift.** Emberwake Cleats says "a 3m cinder patch"
  (`items.js:1047`) and passes `3.2` (`items.js:1058`).
- **Tier-1 roster overlap.** The Gloomshriver is not the tier's first
  slow-applying projectile card. The Spitling (`probeB.json` →
  `shriverValue.tier1Roster`) costs **9** and carries
  `spit(projectile, cd 2.6, dmg 1.1, slow)`; the Gloomshriver costs **15** and
  carries `knell(projectile, cd 3.4, dmg 1.0, slow)` with less health (95 vs
  105). Longer cooldown, lower damage, less health, 67% more expensive, same
  kind, same rider. Its only real differentiators are `hoverHeight: 6.4` and
  `behavior: 'kiter'`.
- **Animator state machines** were checked for stuck states and are clean —
  `anim.swing` and `anim.beamOn` are reset on both the RECOVER enter
  (`Enemy.js:1550`) and the state exit paths (`:1345`, `:1539`, `:1560`), and
  `animLasher`'s deliberate read off the *active* phase rather than the recovery
  snap (`EnemyMeshes.js:4174-4179`) is correct for a 1.5 s hold. No rig was
  observed mid-blink or stuck across 7 probe sessions.

---

## What is genuinely good

Said plainly, because it is true and a lot of it is verified rather than
asserted.

- **The stacking maths is exactly right on every new item, at every stack
  count.** `probeC.json` → `results.stacking`, damage measured through
  `Combat.applyDamage` against a registered dummy at 0/1/2/10 stacks and
  cross-checked against each card's own `description(n)` string:

  | item | x1 | x2 | x10 |
  |---|---|---|---|
  | Folding Bipod (still) | 1.40 | 1.80 | 5.00 |
  | Vow of Momentum (moving) | 2.10 | 3.20 | 12.00 |
  | Vow of Momentum (still) | 0.526 | 0.357 | 0.100 |
  | Entropy Ledger (at 20% health) | 1.80 | 2.60 | 9.00 |
  | Gilded Reliquary (4000 gold, capped) | 1.40 | 1.80 | 5.00 |
  | Afflictor's Index (burning target) | 1.25 | 1.50 | 3.50 |
  | Splinter Bar (full-health target) | 2.30 | 3.60 | 14.00 |

  Not one off-by-one, not one cap missed, not one description that lies about
  its own number. That is unusual and it deserves saying.
- **The Ferrite Redoubt's armour split is implemented and exact.**
  `probeG.json` → `results.redoubtArmour`: an identical 1000-damage hit deals
  **120** into the front arc and **1000** into the rear — a measured 0.880
  reduction against a declared `frontArmor: 0.88`, with `facingPlayer(1.3)`
  returning true and false correctly. (Round 1 praised this; it is one of the
  few design claims in the round that survives measurement intact. The problem
  is that finding #11 means the player can never get there.)
- **CINDER's Stoke cone is correct and her direct damage is priced as
  claimed.** With a body on the fire ray, 20/20 casts land at 2 m, 4 m and 6 m
  for exactly the expected 247 damage, and 0/20 at 7.5 m against a stated 7.0 m
  reach. Per-second direct output as a multiple of the damage stat
  (`probeE.json` → `primaryDps.roster`): Ranger 8.46, Rook 5.00, Anvil 4.77,
  Kestrel 4.03, **Cinder 3.17** — genuinely the weakest primary on the roster,
  exactly as the design argues, and both her other igniting abilities work.
- **Temporal Echo is exactly what it says.** `probeD.json`: 40 casts at 10
  stacks — secondary **30** replays (predicted `hyperbolic(0.35,10)` = 0.778),
  utility **0**, primary **0**. Both stated exclusions hold and the curve is on
  the number.
- **Blight corruption is order-independent, as the tier's rules require.**
  3 Marrow Teeth then a Gorging Tooth → 4 blight stacks, 0 teeth. A Splinter Bar
  first, then 2 Pry Bars arriving after → 3 stacks, 0 bars.
- **Scrapfly Hive's stack capture works** — the exact bug its code comment was
  written to avoid. 93.6 damage at 1 stack, **936.0** at 10: perfectly linear,
  so the closure did not price every hive at one.
- **Arc Capacitor's rhythm is intact**: a primary cast leaves the charge at 0, a
  secondary raises it to 1, the next hit consumes it back to 0 and spills 26.4
  to each of two bystanders.
- **Tectonic Heart fires on jumps 3 and 6, and nowhere else** — a countable
  beat, as designed.
- **Ashen Pact's floor holds.** 10 stacks took the survivor 125 → 38.5 against a
  floor of 37.5 over 12 seconds and never went lethal, and every hit ignited.
- **Recall Beacon is the cleanest new card in the round.** Plant returns `false`
  and refunds the charge (1 → 1); recall returns `true`, spends one charge,
  lands **0.10 m** from the anchor and heals 31.3 (25% of 125). The two-state
  design works exactly as written.
- **Zero errors, everywhere.** Across seven independent probe sessions:
  0 page errors, 0 console errors, `ctx.frameErrors === 0`, `lastFrameError:
  null`. All three new cards spawn, move, select attacks, take damage through
  `Combat.applyDamage`, die, dissolve and retire from `director.enemies`. All
  four CINDER abilities fire without throwing. All five survivor rigs build with
  zero frame errors added.
- **The `dealt`-after-shield fix in `Combat.js` is a real bug fix**, correctly
  verified for the `onDamaged` half (0 hooks fired on a fully-absorbed hit).
  Two of three; see finding #10 for the third.

---

## Checked and clean

Things I went looking for and did not find. Recorded so the next reviewer does
not spend the time twice.

- **Glyph/icon collisions** — 122 cards, 122 cases, zero duplicates across the
  *whole* set (not merely within a tier), zero orphan cases, none falling
  through to `default`.
- **Drop-table distortion from +16 items** — none; dilution is uniform and the
  blight share measures 3.92% against a designed 4% over 60 000 rolls.
- **Shared-scratch corruption** — `_group` is genuinely shared between
  `gatherCone`, `damageGroup` and Conflagration's snapshot, and no item hook or
  ability re-enters `gatherCone` from inside a `damageGroup` loop. Conflagration
  correctly snapshots before its first `explode`. No aliasing bug found.
- **`frontArmor` / `frontArc` / `frontArmorPhase`** — live and consumed at
  `Enemy.js:313-315`, measured exact (see above). I initially suspected these
  were dead data and they are not.
- **`maxAlive` and `selectionWeight`** on the three new cards — both consumed by
  the Director (`Director.js:386`, `:405`, `:432`, `:439`, `:456`) and by
  `Realms.js:503`.
- **Runtime lights** — no new `THREE` light is created anywhere in this round's
  content; every glow is emissive material or the pooled `VFX.lights.flick`.
- **Attack-phase state machines** — no stuck animator state observed; reset
  paths verified by reading and by a 45-second-per-unit state census
  (`probeB.json` → `attackCensus`, which shows every unit cycling
  windup → attack → recover → chase cleanly).
- **`Items.addCloud`'s `MAX_CLOUDS` bound** — holds; Emberwake and Pyre Flask
  cannot grow the per-step overlap cost.
- **Equipment tier growth** — 14 equipment cards, all with bespoke glyphs, none
  colliding.

---

## Verdict

**No — this does not clear a AAA content bar as it stands, and the gap is
larger than round 1 found.**

Round 1 concluded "provisionally yes on content, no on the meta-progression
surface", on the basis of a reading pass plus two full non-headless captures
that reported no thrown errors. That verification could not have found any of
this: every one of the three blocking findings above is a mechanic that is
*silently absent* rather than a thing that throws, and the capture pipeline —
which is the only verification the round actually ran on this content — cannot
see the difference between a status that slows the player and a status that does
nothing at all.

The specific state of the three new enemies:

- **Ferrite Redoubt** — works. 12.3 dps at range, exact 88% frontal reduction,
  clean beam, clean death. Its stated *counterplay* is unavailable (finding
  #11), but it is a real fight.
- **Gloomshriver** — has no mechanic. Its slow is inert (finding #1), leaving a
  15-credit card that deals 2.3-3.2 dps and is dominated on every axis by a
  9-credit card that already exists.
- **Bramble Lasher** — cannot damage or displace a stationary player at its own
  preferred range for 45 seconds (findings #2 and #3). It is not a hard enemy or
  an unfair one; it is not an enemy.

CINDER is the strongest thing in the round and is close: identity, silhouette,
stat pricing and three of four abilities all hold up under measurement. The
secondary does not do the one thing the whole kit is organised around (finding
#4), and the special pays 4-6× what it says through a cascade nobody documented
(finding #6).

The sixteen items are, as round 1 said, genuinely not padding, and their
arithmetic is immaculate. Three of them have interaction defects that a
directed test would have caught — one that welds the horde into the player
(#5), one that makes an existing item worse (#7), one that switches itself off
in the presence of the very survivor shipped alongside it (#8).

Findings #1, #2 and #11's dead field are inherited from `master`. That is
mitigation for the engineering, not for the content: this round's design
documents lean on all three, and shipping three cards whose stated identities
depend on unimplemented engine behaviour is a content decision, not an engine
one.

**Recommended gate:** #1, #2 and #3 before this content ships at all — the first
two are one-line engine fixes and the third is a single digit. #4 through #10
before a content sign-off. #11 and the minors can ride to round 8.

---

### Artifacts

- `reviews/round7/r2-content/probeA.json` … `probeG.json` — raw probe output.
  `probeF.json` is the retracted measurement and is labelled above.
- `reviews/round7/r2-content/shots/` — targeted capture of `09-survivors` and
  `11-bestiary`; see the note in Methodology. No claim in this report depends on
  it.
- All seven probe drivers (`tools/_r2probe[A-G].mjs`) and the glyph checker
  (`tools/_r2glyph.mjs`) were deleted before finishing, per the round's
  convention for throwaway tooling.
