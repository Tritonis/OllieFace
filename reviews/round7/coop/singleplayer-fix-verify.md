# Single-player fix verification — Content C1 and Physics F-3

**Branch** `round7/content-and-polish`, working tree (uncommitted), on top of `a43cc70` plus five co-op fix rounds.
**Date** 2026-08-04. **Verifier** independent; no `src/` file was modified.

| Fix | Verdict |
|---|---|
| **C1** — `PLAYER_DOT_STACK_CAP = 3` in `Combat.applyStatus` | **CONFIRMED** |
| **F-3** — `addScaledVector(this.velocity, h * slow)` in the `diving` branch | **CONFIRMED** |
| Quality | **READY** — 0 critical, 0 major, 4 minor |

**Build:** `node node_modules/vite/bin/vite.js build` → **exit 0**, built in 761 ms, no errors
(only the pre-existing >500 kB chunk-size advisory).

---

## 1. Method, and why the comparison is against the tree and not against HEAD

Three arms, each a separate browser session, run one at a time (the user was
playtesting). Ports 5901–5908; 5199 never touched; no foreign node process
killed.

Sabotage is **named in-memory source substitution** through a vite `transform`
that counts its anchor and **throws unless it matches exactly once**. Nothing on
disk changed — `git status` shows the same 19 modified files before and after.
This is what makes "before" mean *the tree without this one edit* rather than
`a43cc70`, which lacks five rounds of co-op work.

| Arm | Substitution | Anchor matches |
|---|---|---|
| `fixed` | none — the tree as it stands | — |
| `noCap` | the C1 guard block deleted from `Combat.applyStatus` | 1 |
| `noDiveSlow` | `h * slow` → `h` in the `diving` branch | 1 |

**The abort guard was itself failed on purpose.** Arm `_abortTest` carries an
anchor that cannot match (`h * NOT_A_REAL_SYMBOL`). Result
(`sp-verify/_abortTest.json`):

```
[vite] Internal server error: SABOTAGE ABORT: anchor "deliberately unmatchable
anchor" matched 0 times in src/entities/Enemy.js; expected exactly 1
ERROR: page.waitForFunction: Timeout 90000ms exceeded.
```

The module never loads, the game never boots, and the arm dies at the gate
producing no numbers. A missed substitution cannot masquerade as a passing gate.

**Running-game gate, every arm.** `paused: false`, `player._localTick` 174–178
after settle (bar: >60), `netRole: "single"`, `authority: true`,
`maxHealth: 110`, `director.enemies: 0` after clear, ambient spawning off
(`settings.spawnRate = 0`), `foreignDamage: 0` in every damage arm, **zero page
errors in all three arms**. Clock pinned at 1/60 (`pinClock`), so every arm
steps the same simulation at the same rate.

**Two fixtures per damage measurement**, because one would have been the
punchbag trap:

- *free-roam* — elite spawned at 11 m along camera forward, stationary survivor
  topped to `maxHealth` every fixed step, ~27 s. This reproduces the round-4
  arm's shape (`unitDamageStat: 42`, `baseDamage: 21` match exactly).
- *in-contact* — elite **pinned at 2.5 m** every fixed step, inside the 3.2 m
  aura, `inAuraFraction: 1.000`. The free-roam arm is at the mercy of whether
  the reel lands; this one removes AI variance entirely, so the before/after
  delta is the cap and nothing else.

Raw JSON: `reviews/round7/coop/sp-verify/{fixed,noCap,noDiveSlow,_abortTest}.json`.
Driver deleted per instruction.

---

## 2. C1 — the player DoT stack cap

### 2.1 Stacks: both ends of the range

`applyStatus` called directly on the live player, source damage 42
(`fixed.json` → `unit`, `noCap.json` → `unit`):

| call | uncapped (`noCap`) | capped (`fixed`) |
|---|---|---|
| `burn` ×1, eight times | **8** | **3** |
| `burn` count=8, one call | **8** | **3** |
| `burn` count=2 then count=8 | 2 → **10** | 2 → **3** |
| `bleed` ×1, eight times | **8** | **3** |
| `shock` ×1, eight times | **8** | **3** |

Every status with `stackDamage > 0` is capped; the batch path
(`count = Math.min(count, CAP - live)`) is capped as tightly as the one-at-a-time
path, including the partial top-up case.

**Live steady state under a 0.5 s re-application, 12 s trace** (`lapse`):

| | uncapped | capped |
|---|---|---|
| peak stacks | **9** | **3** |
| mean stacks, 3.0–6.0 s window | **7.862** | **2.519** |
| min stacks in that window | 7 | 2 |

The uncapped arm reproduces the predicted **~8-stack steady state** exactly
(8 applications alive at once, 4.0 s duration ÷ 0.5 s cadence), which is the
mechanism the original C1 finding named.

### 2.2 At the cap, applications are dropped — the timer is not refreshed

Requested check, and it passes. Last accepted application at t = 5.50 s (capped)
/ 6.00 s (uncapped); stacks first reach zero at **+4.017 s after the last
accepted application in both arms** — exactly `burn.duration` (4.0 s) plus one
fixed step. A refresh-on-reapply implementation would have held the capped arm's
stacks alive until 4 s after the *last attempt* (t≈10.0 s); it cleared at 9.52 s,
4.02 s after the last *accepted* one. Stacks lapse; they do not renew.

### 2.3 The cap did not leak onto monsters

Identical in both arms — the cap is invisible on the monster side
(`unit.enemy*`, source = `ctx.player`, the exact call shape
`src/data/items.js:506` and `:586` use):

| player-applied DoT on a monster | `noCap` | `fixed` |
|---|---|---|
| `burn` ×1, eight times | 8 | **8** |
| `burn` count=12, one call | 12 | **12** |
| `bleed` ×1, eight times | 8 | **8** |
| `enemyIsPlayer` | false | false |

`items.js:506` (Conflagration) applies `api.count` stacks in a single call —
the count=12 row is that path. Ashen Pact, Conflagration and Afflictor's Index
are unaffected. Note for the record: no item in `src/` calls `statusStacks` —
their dependence on stacking is through DoT magnitude, which is what these rows
measure.

### 2.4 `slow` and `freeze` on the player are untouched

Identical in both arms:

| | `noCap` | `fixed` |
|---|---|---|
| `slow` ×8 on player | 8 stacks, `speedMultiplier` **0.25** | 8 stacks, **0.25** |
| `freeze` ×8 on player | 8 stacks, `speedMultiplier` **0.15** | 8 stacks, **0.15** |
| one `burn` on a player already carrying 8 `slow` | 1 burn, 8 slow intact | 1 burn, **8 slow intact** |

The 0.25 slow floor and the 0.15 player freeze carve-out both survive. Neither
has `stackDamage`, so `(def.stackDamage ?? 0) > 0` excludes them — confirmed at
runtime, not just read.

### 2.5 The dps, before and after, on one fixture

**Held in contact at 2.5 m, aura on 100 % of steps, topped survivor, ~19.5 s:**

| | uncapped | capped | change |
|---|---|---|---|
| **total dps** | **249.92** | **97.99** | **−60.8 % (2.55×)** |
| burn DoT dps | 210.35 | 58.40 | −72.2 % (3.60×) |
| aura direct dps | 29.16 | 28.77 | unchanged |
| peak burn stacks | 12 | **3** | |
| mean burn stacks | 10.102 | **2.848** | |
| damage in window | 5 040.0 | 1 902.6 | |

The 12-stack peak (above the aura's own 8) is the blazing **melee rider** at
`Enemy.js:870`, `statusPlayer(ctx, this, 'burn', 2)` — a second, separate burn
source the original finding did not name. It is capped too.

**Free-roam, 11 m standoff, topped survivor, ~27 s** — the closest analogue to
the round-4 arm:

| | uncapped | capped | round-4 original |
|---|---|---|---|
| total dps | **88.03** | **50.77** | 73.95 / 74.63 |
| burn DoT damage | 1 806.0 | 787.5 | 1 837.5 (burn total) |
| peak burn stacks | 11 | **3** | — |
| meanDist / minDist | 4.99 / 0.005 | 5.07 / 0.005 | 4.35 / 0.01 |
| `unitDamageStat` | 42 | 42 | 42 |

My stand is not the round-4 stand — engagement differs (meanDist 4.99 vs 4.35),
so 88.03 is *my* before-number, not a reproduction of 73.95. It is the same
mechanism at the same unit stats and the same order of magnitude, and the
before/after pair is taken on one fixture, which is what the comparison needs.

### 2.6 What the cap does **not** do

A full-health 110-HP survivor standing in the aura dies in **~1.5–2 s either
way**:

| | uncapped | capped |
|---|---|---|
| time to death, in contact, from 110 HP | 2.02 s | **1.55 s** |
| peak stacks reached before death | 4 | 3 |
| damage taken | 117.6 | 121.8 |

The capped arm died *sooner*. That is not the cap making things worse — over
1.5 s the aura has fired only 3–4 beats and stacks have not yet passed 4, so
the two arms are behaviourally identical in that window; the 0.47 s gap is
aura-beat phase (4 beats × 14.7 vs 3 × 14.7). **The cap changes sustained and
partial exposure, not the first two seconds of contact.** State that plainly:
this fix removes the runaway, it does not make standing next to a blazing elite
survivable, and it was never going to.

---

## 3. F-3 — the diving flyer

Blind Shrike (`pest`, `diveSpeed: 17`), `diving` forced true, position and
velocity re-forced to a fixed `P0` and `(0, 0, 17)` before every fixed step, so
the measured delta is exactly one step's dive integration. 22 settled steps per
cell; **min = max = mean in every cell**, i.e. zero variance.

| status | `speedMultiplier(e)` | **`fixed`** m/step | **`noDiveSlow`** m/step | analytic |
|---|---|---|---|---|
| none | 1.0 | **0.283333** | 0.283333 | 17 × 1/60 = 0.283333 |
| `slow` ×1 | 0.6 | **0.170000** | 0.283333 | 0.283333 × 0.6 = 0.17 |
| `freeze` ×1 | 0.0 | **0.000000** | 0.283333 | 0 |

Both ends of the range, and the gate failed on purpose: with the fix
substituted away the diver moves **0.283333 m/step under all three conditions** —
it ignores `slow` *and* `freeze` outright, exactly as F-3 described. With the
fix, `slow` costs it 40 % of its reach and **freeze stops the dive dead**.

`speedMultiplier` returns a hard `0` here because the diver is a monster; the
`isPlayer ? 0.15 : 0` carve-out at `Combat.js:635` is what keeps that from ever
becoming a player movement lock.

**A frozen diver does not hang.** Read from source and reasoned, not measured
(named untested, §5): the dive's ATTACK window is bounded by `fsm.t >= dur`, and
`exit()` calls `detonate(ctx)` unconditionally for a dive attack
(`Enemy.js:1555–1561`). A frozen Shrike detonates at its own position when the
window closes rather than at the player's — the correct outcome — and nothing in
`Enemy.js` reads `isStunned`, so freeze cannot stall the FSM.

### Paths that must not move, and did not

| arm | `fixed` | `noDiveSlow` | `noCap` |
|---|---|---|---|
| non-diving flyer, no status | 0.022663 | 0.022663 | 0.022663 |
| non-diving flyer, `slow` | 0.022746 | 0.022746 | 0.022746 |
| non-diving flyer, `freeze` | **0.021861** (x = z = 0 exactly) | 0.021861 | 0.021861 |
| grounded mover, none/`slow`/`freeze` | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| dying-flyer drop, none | 3.189 m | 3.187 m | 3.187 m |
| dying-flyer drop, `freeze` | 3.180 m | 3.183 m | 3.183 m |

The frozen hover flyer's residual 0.021861 is its vertical hover bob with x and
z **exactly zero** — `moveFlying` already pays the status tax through
`d.x *= slow; d.z *= slow` at `Enemy.js:763`, untouched by this edit. The dying
drop is identical under freeze because `slow` is forced to 1 when dying
(`const slow = dying ? 1 : …`, `Enemy.js:679`) and the dying branch at
`Enemy.js:778` is not in the diff.

---

## 4. Regression surface — did anything else move?

**Cross-arm equality is the instrument.** The `noCap` arm edits only
`Combat.js`; the `noDiveSlow` arm edits only `Enemy.js`. Each therefore acts as
a control for the other fix.

- `noCap` produces **byte-identical dive numbers** to `fixed` (0.283333 / 0.170 /
  0.000). The C1 edit does not reach the dive path.
- `noDiveSlow` produces **byte-identical C1 numbers** to `fixed`: unit rows all
  3/3/3/8/8/8/12/8, `lapse` max 3 / meanSteady 2.519 / cleared +4.017,
  free-roam damage 1 377.6 with identical `byType`
  (`projectile 69.3, pull 189, melee 126, burn:dot 787.5, burn 205.8`),
  in-contact damage 1 902.6, contactLethal 121.8 at t = 1.55 s. The F-3 edit does
  not reach `applyStatus`.

**`Progression.damageTaken` is not double-counted in single player.** The co-op
round added a second listener (`ctx.events.on('playerHurt', …)` guarded by
`if (ctx.authority) return`). Measured as a delta across each arm window against
the damage Combat actually dealt:

| arm | Combat dealt to player | `stats.damageTaken` delta |
|---|---|---|
| in-contact blazing | 1 902.6 | **1 902.6** |
| in-contact glacial | 336.0 | **336.0** |
| in-contact plain | 168.0 | **168.0** |
| in-contact lethal | 121.8 | **121.8** |

Exact in all four. The `authority` guard holds (`gate.authority: true`).

**The other co-op damage guards are transparent solo** (`playerDealt`):
`damageDealt` delta **37.0** for a 37-damage player hit (the new
`e.source === ctx.player` test passes), `kills` delta **1** for a player kill
(`isLocalKill` passes), enemy dead after lethal.

**The `playerDead` payload change is live and correct solo.** `Combat.js:529`
now emits `{ victim }`. Measured in `contactLethal`: `deadPayloadHadVictim:
true`, `deadVictimWasLocalPlayer: true`, and downstream
`runEnded: true`, `menuScreen: "death"`, `paused: true`. `isLocalVictim` does not
swallow the solo death. (This is not one of the two fixes under review, but it
sits three lines from the C1 edit in the same function, so it was gated.)

---

## 5. Findings

No critical or major. Four minor.

**MINOR-1 — the cap suppresses its own status VFX.** `Combat.js:582`, the
`if (live >= PLAYER_DOT_STACK_CAP) return;` early-return sits **above**
`this.ctx.vfx?.status?.(entity, type, def.colour)`. A dropped application fires
no burn flash. In the in-contact arm the player is at 3 stacks for **1 019 of
1 165 sampled steps (87 %)**, and roughly 14 of ~40+ aura beats were accepted —
so about two thirds of the visual pulses the player used to get while burning
are now skipped, at exactly the moment the burn is heaviest. The comment argues
the debuff must stay "survivable and legible"; this trades a little legibility
away. Moving the `vfx` call above the guard, or firing it on a dropped
application too, costs one line.

**MINOR-2 — the cap tests `def.stackDamage`, not `overrides.stackDamage`.**
`applyStatus(entity, type, source, count, overrides)` lets a caller override
`stackDamage`. The guard reads `def.stackDamage ?? 0`, so a `slow` applied with
an overriding `stackDamage > 0` would be uncapped on the player, and a `burn`
overridden to `stackDamage: 0` would still be capped. **No caller in `src/`
passes `overrides`** (verified by grep — all 18 call sites pass at most 4
arguments), so this is unreachable today. It is a trap for the next caller.

**MINOR-3 — the cap is global per status type, so DoT no longer adds across
sources on the player.** Two blazing elites now park the same 3 stacks one does.
This is a real design consequence of a flat cap rather than a bug, and it is
probably what you want from an anti-spiral change, but it means burn-heavy
encounters flatten rather than escalate. Worth being deliberate about.

**MINOR-4 — latent co-op reach.** `NetViews.js:150` sets `isPlayer = true` on
remote pawn views, so the cap would apply to them. Nothing in shipping code ever
applies a DoT to a pawn view (`statusPlayer` targets `ctx.player` only,
`Enemy.js:63`; no `applyStatus` call exists in `NetHost.js` or `NetViews.js`), so
this is latent, not live. Not exercised at runtime — see §6.

---

## 6. Named untested

- **Co-op at runtime.** Single-player scope by dispatch. No two-page session was
  run. MINOR-4 is source-read only.
- **The `overrides` parameter path** (MINOR-2) — unreachable today, so
  unexercised.
- **A real Shrike committing a real dive and then being frozen by an item**
  (`items.js:822`). I forced `diving` and the status rather than letting the FSM
  drive it. The dive-window/`detonate` interaction under a full-duration freeze
  is reasoned from source (§3), not measured.
- **The grounded-mover arm proves nothing on its own.** It measured 0.000000
  displacement under all three statuses in all three arms — a beetle 12 m from a
  stationary player has no desired direction, so there was no motion for `slow`
  to tax. It is valid as a cross-arm equality check and worthless as a
  slow-response measurement. Disqualifying it rather than reporting "identical
  under slow and freeze" as if that meant something.
- **`bleed` and `shock` on the player from a shipping enemy.** Capped at 3 by
  direct `applyStatus` call, but no in-game source was exercised.
- **Runs with items equipped.** Every arm ran an empty inventory. Player-side
  interactions between the cap and defensive items are unmeasured.
- **The `noCap` arm lacks the glacial/plain comparators** (they were added after
  it ran). Both are burn-free — `slow` is uncapped in both arms (§2.4) — so the
  cap cannot move them, and §2.5's ratios use the `fixed` arm's values for both
  columns. Stated so the number is not read as something it is not.

---

## 7. Opinion — is `PLAYER_DOT_STACK_CAP = 3` defensible?

**As a ceiling: yes. As the whole answer to C1: no, and the arithmetic says it
never could have been.**

What 3 buys, measured: the in-contact rider falls from 210.35 to 58.40 burn dps,
peak stacks from 12 to 3, total from 249.92 to 97.99. The runaway is gone and
the worst case is now a number you can compute — 3 × `damage` × 0.25 ÷ 0.5 =
1.5 × `damage`, i.e. 63 dps at `damage` 42, against a measured 58.40 (the gap is
the sawtooth: mean stacks settle at 2.848, not 3.0, because dropped applications
do not refresh). Three is also the right *kind* of number: small enough to read
off a HUD, large enough that the debuff still means something.

**A blazing elite's dps now, held in contact on a 110-HP survivor: 97.99** —
against **17.04 for glacial and 8.52 for the plain card at the same stand,
same standoff, same 42/21 damage stat**. That is **5.75× glacial at an identical
4.5-credit cost, and 11.5× the plain card**. The round-4 critique called 5.32×
glacial indefensible. The fix lands blazing's worst case on essentially that
same ratio.

And the cap cannot close the rest, because more than half of what survives is
not stacks. At cap 3 the rider splits **58.40 burn dps + 28.77 aura-direct dps**.
The aura's direct tick (`hurtPlayer(this.damage * 0.35)`, `Enemy.js:472`) is
untouched by any stack cap. Even a cap of **1** would leave 21 + 28.77 ≈ 50 dps
of rider — still ~3.5× glacial. Glacial's rider deals **zero** damage: its
`slow` is pure control. The asymmetry is in `ELITE_STATS` (`enemies.js:1350`:
`burn: 0.35, auraDps: 0.35` versus glacial's damage-free `slow: 0.5`), plus the
undocumented +2-stack melee rider at `Enemy.js:870` — not in `applyStatus`.

**Ship the 3.** It is correct, it is cheap, it is player-only, it does not touch
monsters, and it converts an unbounded spiral into a bounded one. Then follow it
with the affix table: the critique's own second suggestion — stop the aura
applying a status on top of its direct tick (`Enemy.js:473`) — or a cut to
`auraDps`, is what actually brings blazing to its cost. Do not let this fix close
C1 as "balanced"; it closes C1 as "bounded".

One thing the cap is honestly not sold as, and should not be: it does not save a
full-health survivor who stands in the aura. Death arrives at ~1.5–2 s with the
cap and without it (§2.6), because stacks have not ramped by then. If the design
intent was "a blazing elite should no longer one-shot you through the rider",
that intent is unmet and needs a different lever.

---

## 8. Commands run

```
git diff src/systems/Combat.js src/entities/Enemy.js
node tools/_spv.mjs --arm fixed      --port 5901 --out reviews/round7/coop/sp-verify
node tools/_spv.mjs --arm noCap      --port 5902 --out reviews/round7/coop/sp-verify
node tools/_spv.mjs --arm noDiveSlow --port 5903 --out reviews/round7/coop/sp-verify
node tools/_spv.mjs --arm fixed      --port 5904 --out reviews/round7/coop/sp-verify   # + affix comparators
node tools/_spv.mjs --arm fixed      --port 5905 --out reviews/round7/coop/sp-verify   # + progression accounting
node tools/_spv.mjs --arm fixed      --port 5906 --out reviews/round7/coop/sp-verify   # DISQUALIFIED, see below
node tools/_spv.mjs --arm fixed      --port 5907 --out reviews/round7/coop/sp-verify   # canonical
node tools/_spv.mjs --arm _abortTest --port 5908 --out reviews/round7/coop/sp-verify   # guard proof
node node_modules/vite/bin/vite.js build                                               # exit 0
```

**Evidence disqualified by me, and why.** The port-5906 `fixed` run placed the
`playerDealt` probe *before* the measurement arms. Its kill granted XP, the
survivor levelled, and `maxHealth` went 110 → 143 mid-fixture — so its
`contactGlacial` (14.87) and `contactPlain` (7.43) were taken on a different
survivor from the `noCap` arm's (110 HP), and its `contactLethal` death time
(2.05 s) was a 143-HP death being compared against 110-HP deaths. The probe was
moved to the end of the run and the arm re-taken on port 5907. **Every number in
this report comes from the 5907 `fixed`, 5902 `noCap` and 5903 `noDiveSlow`
files on disk**, all three at `maxHealth: 110`. The 5906 numbers appear nowhere
above.

Working tree untouched: no commit, no stage, no revert, no `src/` edit. The
driver `tools/_spv.mjs` has been deleted; `reviews/round7/coop/sp-verify/*.json`
is kept.
