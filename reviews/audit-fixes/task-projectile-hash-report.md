# Projectile hit query — route through Combat's spatial hash

Status: **DONE**, gates green, not committed.

## The characterized selection rule

`ProjectilePool._entityAt` was a linear scan of the whole combat registry. Its
exact semantics, established by reading the code and then pinned by tests
against the *old* implementation before anything was changed:

- **Iteration order** — `enemyList(ctx)`, which resolves to `combat.entities`
  (registration order, with swap-removal on `unregister`), else
  `combat.enemies`, else `combat.all()`, else null.
- **Winner** — the **first** entity in that order that passes the accept test.
  Not the nearest. With several enemies overlapping the same shot, the earliest
  registered one wins, and it wins even when a nearer one exists.
- **Accept test** —
  - skip falsy entries, `!e.alive`, and `e === p.owner`;
  - skip `e.team === p.owner.team` when the projectile *has* an owner (an
    ownerless projectile filters no team at all);
  - horizontal: `dx² + dz² < r²` where `r = (e.radius || 0.5) + p.radius`,
    **XZ only**;
  - vertical: `|(e.position.y + hh) - p.position.y| < hh + p.radius` where
    `hh = (e.height || 1.6) * 0.5`. Note the `1.6` default — `sphereOverlap`
    uses `1.8`, so the two tests are *not* interchangeable and the projectile
    one had to be carried over verbatim.
- **Ties** — there is no tie. List position is a total order, so "first that
  passes" is fully determined; the replacement reproduces it exactly rather
  than approximating it.

Hash buckets are in insertion order with swap-removal, which is *not*
`entities` order, so the replacement collects candidates from the hash and
re-selects the winner by `_combatIndex` — the registry position the old loop
was walking. That is the rule the comment at the site documents.

## What changed

`src/systems/Combat.js`

- `candidatesNear(point, radius)` / `candidateAt(i)` — a broadphase that fills a
  reused 256-slot buffer with every entity bucketed near a point, **unfiltered**
  (no liveness, team or distance test), because the caller's accept test is the
  one that must stay bit-identical and a second, subtly different one is exactly
  how this kind of refactor moves gameplay. Returns `-1` on buffer overflow:
  there is no correct truncation of an exhaustive query, so the caller falls
  back to the registry scan.
- Cells are widened by one on each side, matching what `raycast`/the hitscan
  queries already do. See "the margin" below.
- `maxEntityRadius` — the largest radius in the registry, recomputed over all
  entities in the `fixedUpdate` reindex loop (which already walks them) and
  bumped in `register` so a unit spawned after that loop widens the search
  immediately. The query's reach is the *enemy's* radius, not the projectile's,
  and radii come from spawn cards (0.34 … 3.0), so this is measured rather than
  assumed by a constant.

`src/entities/Projectile.js`

- The accept test is lifted out whole into a module-level `hits(p, e)`, used by
  both the hash path and the fallback scan, so they cannot drift apart.
- `_entityAt` uses the hash only when `list === ctx.combat.entities` *and*
  `candidatesNear` exists. `enemyList` also accepts `combat.enemies` and
  `combat.all()`, which the hash knows nothing about; those still scan.
- It falls back to the full scan, silently and correctly, on buffer overflow
  and on any candidate whose `_combatIndex` does not round-trip
  (`list[idx] !== e`) — without a live index there is no registry order to pick
  by, and guessing is the one thing this must not do.

## The margin, and the perf it costs

The hash is reindexed once per fixed step, at the top of `Combat.fixedUpdate`;
projectiles tick from `Player.fixedUpdate`. An entity can therefore sit under a
stale key by up to a step or two of its own travel. The widening by one cell
(8 m) covers that without assuming anything about entity speed, and matches the
precedent already in the file.

It is also where most of the available win goes. Measured with a throwaway
benchmark (enemies clustered around a survivor at the origin, queries taken
along the flight path to each target):

| entities | candidates/query | vs. full scan |
|---|---|---|
| 13 | 8.6 | 34% fewer |
| 40 | 24.1 | 40% fewer |
| 80 | 50.9 | 36% fewer |

With the widening removed the same benchmark gives 4.1 / 11.7 / 24.3 — about
70% fewer. So the honest headline is **~37% fewer distance checks, not an order
of magnitude.** The limiting factor is `CELL = 8` against a ~0.72 m query: even
a single cell is far larger than the thing being asked about.

Two ways to reach the ~70% figure, both deliberately **not** taken here because
both trade the task's hard constraint for speed and are not mine to spend:

1. A tighter, speed-derived staleness slack (~1–2 m) instead of a full cell.
   Safe against every mover in the tree today — the fastest is the 20 m/s blink
   dash, 0.33 m/step — but it is a hardcoded assumption that a future faster
   ability breaks silently, dropping hits with no gate to catch it.
2. A smaller `CELL`. That changes bucket contents for `sphereOverlap`,
   `nearestHostile` and the hitscan queries as well, i.e. far outside this
   task's blast radius.

## What was deliberately left alone

The `_explode` fallback (`Projectile.js`, the `else` branch of
`if (ctx.combat?.explode)`) also scans the registry, and the brief named it. It
is **unreachable in the shipped game**: `enemyList` returns null unless
`ctx.combat` exists, and every real `Combat` has `explode`, so the branch runs
only for a combat stub that has an `entities` array but no `explode` — and such
a stub has no spatial hash to consult either. Routing it through the hash would
add an untested path with zero measurable benefit, and worse: that loop calls
`takeDamage` *while iterating*, so reading from a shared pooled buffer would
introduce a re-entrancy hazard the current live-array scan does not have. Left
as-is; its cost is zero because it never executes.

## Verification

All from repo root, against the exact final bytes.

```
node tests/projectile-query.test.mjs      73 passed, 0 failed
node tests/run.mjs                        11/11 test files passed
node node_modules/vite/bin/vite.js build  ✓ built in 953ms   EXIT=0

node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json
  single-player unchanged vs reviews/round8/baseline-HEAD.json — no fields moved
  SP_EXIT=0

npm run gate:elite
  elite damage unchanged vs reviews/round8/elite-baseline-HEAD.json — no fields moved
  ELITE_EXIT=0
```

### TDD, and the watch-it-fail step

`tests/projectile-query.test.mjs` was written first and run against the **old**
linear implementation, where all its assertions passed — that is what makes it a
characterization of existing behavior rather than a description of the new code.
Every case is stated twice against the *same* entity objects, once through a
combat with no hash (the linear fallback) and once through a real `Combat`, and
both routes must return the identical object.

Because the tests pass on both implementations, each was verified to be capable
of failing by breaking the query and watching the specific expected failure:

- **Removed the one-cell widening** → `a full cell of stale key` and
  `a full cell of stale key in z` fail (`spatial hash picks jumper (got null)`),
  4 failures, everything else green.
- **Took the first candidate in bucket order instead of the lowest
  `_combatIndex`** → `straddling x = 8` fails
  (`spatial hash picks highcell (got lowcell)`), 2 failures.

The first break initially failed *nothing* — the original test set did not
actually pin the widening, because `maxEntityRadius` padding happened to pull
the neighbouring cell into range in every case. The two stale-key cases were
added to close that gap, which is the only reason the widening is now tested at
all.

## Note on the working tree

The tree contained uncommitted changes to `src/core/Engine.js`,
`src/net/Lobby.js`, `src/systems/VFX.js`, `src/ui/HUD.js` and
`tests/lobby-lifecycle.test.mjs` that are **not mine** — they appeared during
this task (concurrent work in the same worktree). They were not touched. The
gate runs above therefore certify the tree as a whole, which includes but is not
limited to this change.

Files changed by this task:

- `src/entities/Projectile.js`
- `src/systems/Combat.js`
- `tests/projectile-query.test.mjs` (new)

Nothing committed.
