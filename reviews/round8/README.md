# round8 — single-player equivalence baselines

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
| `baseline-precoop.json` | The tree **before** Wave C — i.e. before any enemy read the roster. Kept for audit; do not compare new work against it. | `node tests/sp-equivalence.mjs --out reviews/round8/baseline-HEAD.json` at commit `00b0bf6`, then copied to this name before the re-baseline. |
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
