# round8 — single-player equivalence baselines, and the co-op targeting captures

This file covers two instruments. `tests/sp-equivalence.mjs` and its baselines
are first; the co-op N-1 captures written by `reviews/round8/probe-targeting.mjs`
are in **"N-1: who do enemies actually attack"** at the bottom.

## Part 1 — single-player equivalence

`tests/sp-equivalence.mjs` runs a fixed-seed headless single-player session and
writes a fingerprint of 31 accumulators (damage, kills, gold, level, health
floor, player kinematics, enemy states and positions, frame errors) plus a
`diagnostics` block that the comparator excludes because it carries wall-clock
timings.

Downstream tasks use `--compare`, never a hand-rolled JSON equality check: the
comparator knows which fields are wall-clock diagnostics and which are real.

## The two baselines

| File | What it captures | Command that produced it |
|---|---|---|
| `baseline-precoop.json` | The tree **before** Wave C — i.e. before any enemy read the roster. Kept for audit; do not compare new work against it. | `node tests/sp-equivalence.mjs --out reviews/round8/baseline-HEAD.json` at commit `e4d25b6`, the commit that last wrote the blob; untouched through `8e33e63`, then copied to this name before the re-baseline. |
| `baseline-HEAD.json` | **The current baseline. Cite this one.** The tree with both Wave C halves in: Task 7 (`8e33e63`, Director/FinalBoss/HUD) and Task 6 (`394d727`, Enemy targeting). | `node tests/sp-equivalence.mjs --out reviews/round8/baseline-HEAD.json` at commit `394d727`. |

The pre-Wave-C baseline stays committed on purpose. A re-baseline with no
on-disk record of what it absorbed is how a real regression hides inside an
accepted one.

Per-task captures — `roster-after.json` (Task 5), `director-after.json`
(Task 7), `targeting-after.json` (Task 6) — are the snapshots each task took at
its own gate and are not baselines.

## What the re-baseline absorbed: 5 fields, all `deadTarget.*`

```
$ node tests/sp-equivalence.mjs --compare reviews/round8/baseline-precoop.json
SINGLE-PLAYER MOVED vs reviews/round8/baseline-precoop.json — 5 field(s):

  deadTarget.enemiesOnFallbackTarget
    baseline: 0
    now:      5
  deadTarget.enemyStates.chase
    baseline: 4
    now:      undefined
  deadTarget.enemyStates.idle
    baseline: undefined
    now:      5
  deadTarget.enemyStates.reposition
    baseline: 1
    now:      undefined
  deadTarget.finalEnemyPositions
    baseline: [[-7.332426,5.863605,6.84182],[-6.073376,-2.631792,-8.612903],[27.889487,12.000682,-12.916989],[28.385315,12.000682,-12.482046],[29.032342,-3.695244,-44.342811]]
    now:      [[-25.230632,-3.705427,-33.964315],[3.350688,6.092747,30.173527],[27.424016,-2.491181,-64.122227],[32.792206,4.093132,-38.548531],[54.897282,2.492748,-19.448022]]
```

Exactly five, all under `deadTarget`, which is the second window — the one
sampled after the player has died. **Every field in the primary window is
unchanged**, including the top-level `enemyStates` and `finalEnemyPositions`,
which are distinct fields from the `deadTarget.*` entries of the same name.
`damageToPlayer`, `kills`, `goldTotal`, `playerHealthMin`, `playerPosition` and
`frameErrors` all held.

**Why.** `ctx.player` outlives the local player's death — `alive` goes false and
nothing clears the reference (`src/systems/Roster.js:92-97`). Before Wave C,
`Enemy.fixedUpdate` read `ctx.player` with no liveness test, so after the
survivor died the pack kept tracking the corpse's position and stayed in
`chase`/`reposition`; the null-target arm of that branch was unreachable in
single-player, which is why `enemiesOnFallbackTarget` read 0 — the fallback was
never entered, not working. Enemies now acquire through
`acquireTarget`/`Roster.targetable`, which reject a dead player, so `targetPlayer`
goes null, `distToPlayer` goes to 999, and all five units fall to IDLE and their
spawn-anchor patrol. The changed states and coordinates are consequences of that
one transition, not independent movements.

This was ruled intended behaviour arriving rather than a regression: enemies
mobbing a corpse forever was a latent defect, and the same mechanism is what
makes co-op work — a dead player stops drawing aggro so the pack moves to the
living teammate. It cannot be removed without special-casing single-player in
the targeting hot path.

Attribution was established two ways. Task 6 halted at its gate and reported the
five fields; Task 7 independently built a clean `git archive HEAD` tree with only
its own two source files copied in and got `no fields moved`, exit 0 — so
HEAD + Task 7 alone is clean and all five belong to the Enemy targeting change.

## Using it

```
node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json
```

Exit 0 and `no fields moved` is the pass. Any field moving is a finding: do not
adjust the harness, do not re-capture the baseline, and do not explain the
difference away. Re-baselining is a decision for the human partner, and when it
happens the old baseline is preserved and this file records what it absorbed.

---

# Part 2 — N-1: who do enemies actually attack

`reviews/round8/probe-targeting.mjs` drives a **real co-op session** — two or
four Chromium pages, one hosting and the rest joining through the manual invite
path (`Lobby.createInvite` / `joinManual` / `acceptAnswer`, the same calls the
co-op screen's buttons make) — parks every player on a 3 m ring, holds them
alive, and records for 30 s of simulation time: every damage event with its
target, type, source and distance, plus a per-second census of every player and
every living enemy with that enemy's `targetPlayer` and its distance to each
player. It writes raw JSON; the `derived` block in each file is computed from
those arrays and is recomputable from them.

**The figure every arm is compared against.** HEAD before this branch measured
**78 directed enemy hits on the host and 0 on a pawn standing 3 m away over
30 s**, with an enemy 6.3 m from the pawn still holding the host's position as
its target. That is defect N-1, and it is quoted in
`src/entities/Enemy.js:66-71` (`hurtPlayer`) as the reason the victim is now
passed in rather than read from `ctx.player`.

## The four arms

| File | Command | Directed hits (host / pawns) | Enemy-census rows whose target was the nearest targetable player |
|---|---|---|---|
| `n1/2p-lag0.json` | `node reviews/round8/probe-targeting.mjs --players 2 --netlag 0 --out reviews/round8/n1/2p-lag0.json` | **51 / 43** (54.3% / 45.7%), 94 total | 239/245 = 0.976 |
| `n1/2p-lag60.json` | `node reviews/round8/probe-targeting.mjs --players 2 --netlag 60 --out reviews/round8/n1/2p-lag60.json` | **51 / 43** (54.3% / 45.7%), 94 total | 238/245 = 0.971 |
| `n1/4p-lag0.json` | `node reviews/round8/probe-targeting.mjs --players 4 --netlag 0 --out reviews/round8/n1/4p-lag0.json` | **48 / 19 / 16 / 99** (26.4% / 10.4% / 8.8% / 54.4%), 182 total | 363/365 = 0.995 |
| `n1/4p-lag60.json` | `node reviews/round8/probe-targeting.mjs --players 4 --netlag 60 --out reviews/round8/n1/4p-lag60.json` | **46 / 15 / 2 / 106** (27.2% / 8.9% / 1.2% / 62.7%), 169 total | 347/353 = 0.983 |

Every arm compares against the same HEAD figure of **78 / 0**. The host column is
the same order of magnitude it always was; the pawn columns are the numbers that
were 0.

Each arm also leaves a `.log` beside its JSON with the probe's phase lines
(page loads, per-player join times, both liveness gates, and sim-vs-wall
progress during the measured window).

`?netlag=60` is verified in the file rather than assumed: `raw.diagnostics.rosterCheck.peerSim`
records `_sim` off each live `Peer`, which is only non-null when
`netSim().on` — `{"lagMs": 60, "jitterMs": 0, "lossPct": 0}` on every peer in
both lag arms, `null` in both zero arms.

## The sabotage arm — the gate failed on purpose

One substitution, in `src/systems/Roster.js`, inside `acquireTarget`:
`return roster.local;` before the `nearest` query, so every enemy targets the
host's own survivor whatever the geometry. Re-ran the `2p-lag0` arm to a scratch
path and reverted.

| File | Command | Result |
|---|---|---|
| `n1/scratch-sabotage-2p-lag0.json` | `node reviews/round8/probe-targeting.mjs --players 2 --netlag 0 --out reviews/round8/n1/scratch-sabotage-2p-lag0.json` (with the substitution in place) | **124 / 0** — every directed hit on the host, none on the pawn, mean 10.8 enemies holding the host per census and 0 holding the pawn |

That is HEAD's shape reproduced on demand: the instrument can see the defect it
claims is fixed. `git status` shows `src/` clean afterwards.

## Failures kept on purpose

`n1/4p-lag60.FAILED-attempt2.json` and `n1/4p-lag60.attempt2.log` are a real
failed arm, not noise: with three peers and 60 ms of one-way delay, the **second
joiner never produced a pawn on the host** inside `JOIN_TIMEOUT_MS` (45 s), so
the arm refused to measure and exited non-zero. The third attempt of the same
command succeeded and is the committed `4p-lag60.json`. Four-peer sessions under
latency are the least-exercised path in this codebase and this is the first time
anything has driven one; the join is not reliably forming.

## What the numbers do and do not say

  * **Latency does not move host-side targeting when nobody is moving.** The two
    2-player arms are hit-for-hit identical (51/43 in both). That is expected
    rather than suspicious: enemies, damage and targeting are all simulated on
    the host from a seeded RNG, the clients send no input under this fixture,
    and the pawns are pinned — so `?netlag=` changes when packets arrive and
    nothing the host decides. The lag arms prove the session *forms and stays
    up* at 60 ms and that the split survives it, not that latency perturbs it.
  * **Four players is lopsided, and it tracks proximity.** In both 4-player arms
    one pawn takes 54-63% of the directed hits with 7-9 of the ~9 living enemies
    holding it, because that is where the Director's pack is. The per-sample
    counts in `derived.perPlayer.*.enemiesTargetingPerSample` show the pack
    migrating between players across the window rather than sitting on an
    identity.
  * **A run is a sample, not a fingerprint.** Unlike `sp-equivalence`, this probe
    cannot pin the clock — a networked session has to run in real time — so
    small differences between runs of the same arm are expected. The gate is
    written against effects (0 vs. 43, a 15% share) far larger than that spread.
