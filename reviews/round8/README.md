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
| `baseline-HEAD.json` | **The current baseline. Cite this one.** The tree with both Wave C halves in: Task 7 (`8e33e63`, Director/FinalBoss) and Task 6 (`394d727`, Enemy targeting). Task 7 was *planned* as Director/FinalBoss/HUD; `git show 8e33e63 --stat` lists no HUD file and `git log 2f11823..HEAD -- src/ui/HUD.js` is empty, so HUD.js is untouched anywhere on this branch. See `deferred-rollup.md`. | `node tests/sp-equivalence.mjs --out reviews/round8/baseline-HEAD.json` at commit `394d727`. |

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
nothing clears the reference — the `get local` docblock in `src/systems/Roster.js`
says so; find it by name rather than by line, because two fix waves have now
moved it. Before Wave C,
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

## The control every arm is compared against

**The control is `n1/scratch-sabotage-2p-lag0.json`: 124 directed hits on the
host, 0 on the pawn.** It is on disk, in this repo, taken with *this*
instrument, on *this* tree, from a single substitution in `acquireTarget`
(details below). Every "N-1 closed" claim in this directory is the pair
**124 / 0 → 51 / 43**, and both halves of it are files listed on this page.

**The 78 / 0 figure is not that control.** "78 directed enemy hits on the host
and 0 on a pawn standing 3 m away over 30 s, with an enemy 6.3 m from the pawn
still holding the host's position" is an **inherited prior-round figure with no
raw capture anywhere in this repository**. It reaches this document as prose,
from `.superpowers/sdd/2026-08-04-coop-roster-targeting/task-8-brief.md:11` and
`task-6-brief.md:55`, and it is quoted in a source comment at
`src/entities/Enemy.js:66-71`. `grep -rln "directedHits" reviews/` returns only
the Task-8 captures; Task 6's own review already recorded the figure as "not in
this diff or in the repo… not disputed, not reproduced". It is kept here because
it names the defect and it agrees with what the sabotage arm measures — but it
is **not traceable to a file**, and nothing downstream should cite it as if it
were. Cite 124 / 0.

## The four arms

| File | Command | Directed hits (host / pawns) | Census target counts (host / pawns) |
|---|---|---|---|
| `n1/2p-lag0.json` | `node reviews/round8/probe-targeting.mjs --players 2 --netlag 0 --out reviews/round8/n1/2p-lag0.json` | **51 / 43** (54.3% / 45.7%), 94 total | 115 / 130 |
| `n1/2p-lag60.json` | `node reviews/round8/probe-targeting.mjs --players 2 --netlag 60 --out reviews/round8/n1/2p-lag60.json` | **51 / 43** (54.3% / 45.7%), 94 total | 115 / 130 |
| `n1/4p-lag0.json` | `node reviews/round8/probe-targeting.mjs --players 4 --netlag 0 --out reviews/round8/n1/4p-lag0.json` | **48 / 19 / 16 / 99** (26.4% / 10.4% / 8.8% / 54.4%), 182 total | 62 / 20 / 50 / 233 |
| `n1/4p-lag60.json` | `node reviews/round8/probe-targeting.mjs --players 4 --netlag 60 --out reviews/round8/n1/4p-lag60.json` | **46 / 15 / 2 / 106** (27.2% / 8.9% / 1.2% / 62.7%), 169 total | 62 / 63 / 8 / 220 |
| **control** — `n1/scratch-sabotage-2p-lag0.json` | as `2p-lag0`, with `acquireTarget` sabotaged | **124 / 0** (100% / 0%), 124 total | **336 / 0** |

Every arm compares against the control in the last row. The host column is the
same order of magnitude it is under sabotage; the pawn columns are the numbers
that are 0 under sabotage.

### Running the gate

`node reviews/round8/n1-gate.mjs` reads the four committed arms above and exits
non-zero if any of them violates the acceptance criterion. No browser, no
session — it reads the captures. `probe-targeting.mjs` applies the same check
to its own output before it exits, so a live arm that re-breaks targeting now
writes `<out>.FAILED.json` and exits 1 instead of a normal-looking capture.

**It has been failed on purpose**, which is the only evidence that a gate is
one:

```
$ node reviews/round8/n1-gate.mjs reviews/round8/n1/scratch-sabotage-2p-lag0.json
FAIL  reviews/round8/n1/scratch-sabotage-2p-lag0.json — 2p
        [zero-census] no enemy ever held pawn1 as its target in any sample (enemiesTargetingMax 0)
        [directed-share] pawn1 took 0 of 124 directed hits (share 0), under the 0.15 floor

4 checks over 1 capture(s), 2 violation(s)
N-1 GATE FAILED — an enemy population that never attacks a guest is the defect this branch exists to close.
exit 1
```

Until that file existed the word "gate" on this page was wrong. The probe
computed `directedShare`, wrote it into the JSON and never compared it to
anything; the sabotage arm — every enemy locked onto the host, 336 of 336
census rows, `directedShare: 0` for the pawn — **exited 0 and wrote to the
normal output path**. The verdict was a human reading the table above. The
`scratch-` prefix and the `.FAILED` suffix are excluded from the default set
precisely so the sabotage control can stay committed as evidence while the
default run stays green; name it on the command line to see it rejected.

The census target counts are the sum over every one-second census of how many
living enemies held each player as `targetPlayer`. Both columns are counted
directly from `raw.damage` and `raw.samples`; neither is read off `derived`.

Each arm also leaves a `.log.txt` beside its JSON — the extension is `.txt`
because `*.log` is gitignored repo-wide and these are evidence, not scratch —
carrying the probe's phase lines
(page loads, per-player join times, both liveness gates, and sim-vs-wall
progress during the measured window).

`?netlag=60` is verified in the file rather than assumed: `raw.diagnostics.rosterCheck.peerSim`
records `_sim` off each live `Peer`, which is only non-null when
`netSim().on` — `{"lagMs": 60, "jitterMs": 0, "lossPct": 0}` on every peer in
both lag arms, `null` in both zero arms.

## "Proximity, not identity" — read the census target counts, not the fraction

The column that settles it is **census target counts**, above. Under sabotage
every one of 336 enemy-census rows holds the host and the pawn is held **zero**
times; in the four real arms the counts distribute across whoever is nearby, and
in the two-player arms the *pawn* is held more often than the host (130 against
115). That is a statistic that goes to a corner when targeting is broken.

**`derived.targetIsNearestFraction` is not a test, and must not be read as one.**
It reads 0.971-0.995 in the four arms and **0.952 in the sabotage arm** — the
number barely moves when targeting is completely broken. The reason is
structural: an enemy walks toward whatever it is targeting, so its target tends
to *become* the nearest player whether it was chosen by proximity or by identity.
The field is kept because the per-row disagreements are useful to read, but it is
published here with its sabotage value beside it precisely so no later reader
mistakes it for a gate.

Where the fraction does disagree with the nearest player, two mechanisms
account for it and one alone does not: `SWITCH_MARGIN` (0.8, multiplicative —
`src/systems/Roster.js:194`) explains most rows, and `RETARGET_INTERVAL` (0.5 s,
`src/entities/Enemy.js:43`) accounts for the rest — a census sampled at 1 s can
catch a target chosen up to half a second ago, after the geometry has moved.
Classified row by row: `2p-lag0` 4 of 6 explained by the margin, `2p-lag60` 5 of
7, `4p-lag0` 2 of 2, `4p-lag60` 5 of 6; the remainder need the staleness.

**A note on the `type !== 'blast'` filter:** it never excluded anything.
`totalHits === totalDirectedHits` in all five captures — the recorded types are
`melee` throughout plus four `projectile` events in `4p-lag60`, and not one
blast was recorded in any arm. "Directed hits" is therefore currently a synonym
for "hits". The filter is still correct (a blast is a place, not a person, so it
is not evidence of who was targeted) but no committed arm exercises it.

## The sabotage arm — the gate failed on purpose

One substitution, in `src/systems/Roster.js`, inside `acquireTarget`:
`return roster.local;` before the `nearest` query, so every enemy targets the
host's own survivor whatever the geometry. Re-ran the `2p-lag0` arm to a scratch
path and reverted.

| File | Command | Result |
|---|---|---|
| `n1/scratch-sabotage-2p-lag0.json` | `node reviews/round8/probe-targeting.mjs --players 2 --netlag 0 --out reviews/round8/n1/scratch-sabotage-2p-lag0.json` (with the substitution in place) | **124 / 0** — every directed hit on the host, none on the pawn; 336 of 336 census rows hold the host, 0 hold the pawn |

That is N-1 reproduced on demand from the instrument that had just measured a
54/46 split on the same fixture, and it is why this file — not the inherited
78/0 — is the control. `git status` shows `src/` clean afterwards.

The sabotage run was a healthy session, not a broken one: both liveness gates
fired on both pages, roster 2 / pawn 1, the pawn parked at exactly 3.000 m and
alive at 110/110 in every census, `deathsTotal` 0, `frameErrors` 0, and all 336
census rows carry a **non-null** `targetPlayer` — which is also the evidence
that this was one substitution and not a revert of Task 6, since a revert would
leave `targetPlayer` absent and every row would read `null`.

**It is not population-matched, and that makes it conservative.** The sabotage
arm ran with a mean of 10.84 living enemies per census against 7.90 in
`2p-lag0` (+2 at both ends of the range), and took 124 hits against 94. More
enemies is more chances for the pawn to be hit, and it still took zero.

## Failures kept on purpose

`n1/4p-lag60.FAILED-attempt2.json` and `n1/4p-lag60.attempt2.log.txt` are a real
failed arm, not noise: with three peers and 60 ms of one-way delay, the **second
joiner never produced a pawn on the host** inside `JOIN_TIMEOUT_MS` (45 s), so
the arm refused to measure and exited non-zero. The third attempt of the same
command succeeded and is the committed `4p-lag60.json`. Join latency across the
successful arms spans 531 ms to 8,972 ms, with no correlation to lag — the
slowest successful join is in the *zero*-lag four-player arm.

**That file is nearly empty, and that is the finding's own defect.** It took the
generic `the arm threw` path, so it carries a Playwright timeout string, a
stack, an empty `pageErrors` and 37 console lines of which none are non-THREE —
and **no host or client state at all**: no lobby status, no peer list, no tick
counters. The report's earlier "no refusal recorded on the host" was therefore
an inference from absent console output rather than a reading of host state, and
the question the finding asks cannot be answered from what was kept.

The probe has been fixed: every failure inside the join sequence now captures
`snapshotOf` on **every** page plus a host-side peer table (per client: whether
a pawn exists, whether HELLO was seen, the survivor id, the last input tick, the
two data-channel `readyState`s and the `?netlag=` queue depth), and names which
of the five join stages failed. Nothing is diagnosed here — the next attempt at
this failure should start by reproducing it against the fixed probe.

## What the numbers do and do not say

  * **The lag arms do not stress targeting, and cannot.** The two 2-player arms
    are identical in **all 94 `raw.damage` entries, including the timestamp** —
    same targets, amounts, sources and distances. They are not copies of one
    file (URL, `peerSim`, join times, `pinFrames` and window timestamps all
    differ, as do 159 of 245 census enemy rows in sampled position). They are
    two runs of a host simulation that is *deterministic and network-independent
    under this fixture*, which is the necessary consequence of pinning pawn
    positions host-side every frame while the clients send no input. Under this
    fixture a lag arm is **arithmetically incapable** of differing from its zero
    arm in any targeting figure, so nothing about targeting should be inferred
    from the fact that it does not.

    **What the lag arms do establish, and it is worth having:** a 2-peer and a
    4-peer session **form, stay connected and keep stepping for ~70 s of
    simulation time with 60 ms of one-way delay armed on every peer** (`peerSim`
    non-null in the file). That is the first time this repository has shown it.
    Nothing more than that.

    Testing whether targeting survives latency needs a fixture in which clients
    move and act, and where the *client-side* picture of who is being attacked
    is compared against the host's. That fixture does not exist yet.
  * **Four players is lopsided, and it tracks proximity.** In both 4-player arms
    one pawn takes 54-63% of the directed hits, drawing a mean of 7.52 / 7.10
    holders out of a living population that averages **11.77 / 11.39** per
    census (min 9, max 14) — about 64% of the pack on one player. At the other
    end, **pawn2 in `4p-lag60` took 2 of 169 directed hits (1.2%)** with a mean
    of 0.26 enemies ever holding it: one of the four players was functionally
    not in the fight for the whole window. It tracks proximity — the pack sits
    where the Director spawned it, and while every pawn is 3 m from the host
    they are ~5.2 m from each other — so it is not an identity defect and P1 is
    not implicated. It is a Director/encounter question, and it is newly
    measurable *because* N-1 closed. The 15% floor is specified for the
    2-player arms only and is deliberately **not** applied here: reading it into
    the 4-player arms after seeing the result would be moving the gate to fit
    the data.
  * **A run is a sample, not a fingerprint.** Unlike `sp-equivalence`, this probe
    cannot pin the clock — a networked session has to run in real time — so
    small differences between runs of the same arm are expected. The gate is
    written against effects (0 vs. 43, a 15% share) far larger than that spread,
    and it is `n1-gate.mjs` — see "Running the gate" above, including the run
    where it is failed on purpose.
  * **How to tell the parking fixture held**, and how not to. Read the census:
    every player sits on its recorded anchor at every sample, and host↔pawn
    separation is **3.000 m at every census in every arm** (recomputed from
    `raw.samples[*].players[*].pos`, min 3.000 max 3.000). Do **not** read
    `raw.fixture.maxDriftMetres` in the five committed captures as knockback
    absorbed: in those files it is the *first pin*, a teleport from where the
    pawn spawned to its ring anchor, which is why it is bit-identical at 2.236
    across `2p-lag0`, `2p-lag60` and the sabotage arm — three runs with entirely
    different combat. The probe has since been corrected to report
    `firstPinDisplacementMetres` and `maxDriftMetres` separately; captures
    written before that carry only the old, misleading field.

    With the corrected probe, `n1/scratch-probefix-2p-lag0.json` reads
    `firstPinDisplacementMetres: 2.236` — the same 2.236, confirming what that
    number always was — and `maxDriftMetres: **0**`. So the fixture does not
    *absorb* knockback frame by frame; it **prevents** it, because the pin also
    zeroes velocity, and a pinned player never has a frame in which to move a
    measurable distance. The honest evidence that the geometry held is the
    census, not a drift figure.
  * **The four-player fixture is looser than the two-player one.** `pinFrames`
    is 4560-4665 over the two-player windows against 1312-1360 over the
    four-player ones — roughly 91 fps against 26 fps, while the simulation runs
    a fixed 60 steps per second either way. The pin therefore ran about once
    every 2.3 fixed steps in the four-player arms. The census still shows every
    player on its exact anchor, so nothing is invalidated, but the four-player
    geometry is held less tightly and later work should not assume otherwise.
