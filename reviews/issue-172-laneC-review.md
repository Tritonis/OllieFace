# Issue #172 — Lane C verification review

Worktree: `.claude\worktrees\agent-af4ee71c7519b2f9d` (branch `worktree-agent-af4ee71c7519b2f9d`, commit `db5e450`)
Files under test: `src/world/Interactables.js`, `tests/purity-altar-spawn.test.mjs`

## Verdict

**SPEC: CONFIRMED** — every claim in the dispatch was independently reproduced against the real population/update path, not a synthetic reconstruction.
**QUALITY: READY** — clean implementation, tests exercise real seams, no regressions found; one coverage gap (Minor) noted below.

## What was checked and how

1. **Real path, not synthetic** — `tests/purity-altar-spawn.test.mjs` imports `Interactables`/`VoidBargain` directly and drives `inter.init(ctx)` → `inter.populate(stageIndex)` → `inter.update(ctx, dt)`, using a real `landmarks`/`isWalkable`/`sampleHeight` stage stub (shared with `corruption-counterplay.test.mjs`'s harness style) rather than stubbing `_placeBargain`/`_surfaceBargain` themselves. Confirmed by reading the harness (`populated()`, `tick()`) — genuine population/update path.

2. **Draw-count/teleporter-position pin, and mutation test of the guard** — ran `npm test` on `tests/purity-altar-spawn.test.mjs` directly: 19/19 pass, including the 20-case (5 stages × 4 seeds) draw-count/teleporter-position parity check. To confirm the guard actually *can* fail (not blind), I wrote a scratch script that monkey-patches `Interactables.prototype._placeBargain` at runtime (no repo file touched — worktree left `git status --porcelain` clean throughout) to inject one extra `ctx.rng.next()` call into the placement path, then reran the same 20-case comparison used by the shipped test: **all 20/20 cases drifted** (`cases=20 drift=20`). The guard is not blind.

3. **Dedup / no unbounded per-frame work** — `_surfaceBargain` is O(1) per frame once `_bargainSite` is nulled by the first successful `_placeBargain()` call (Interactables.js:2810 area), and `_placeBargain` itself guards with `this.list.some(i => i instanceof VoidBargain)` as a backstop even if `_bargainSite` were somehow live twice. Test exercises band and motes crossing repeatedly across 90 ticks post-placement; confirmed exactly one altar, unmoved.

4. **Authority** — `_surfaceBargain` gates on `this.ctx.authority` (Interactables.js:2834); test confirms a guest (`authority:false`) surfaces zero altars while an identically-driven host surfaces one. The "existing prop replication" claim is real, not asserted: `NetHost.js:787` streams `ctx.interactables.replicable()` every state snapshot, and `Interactables.replicable()` (line 2947) returns `this.list` directly, and `add()` (line 2546) pushes onto that same list — so a host-side `_placeBargain()` mid-stage is picked up by the very next snapshot with no new wiring required. Verified by reading, not merely trusting the comment.

5. **`signal()` afford/short correctness, red-then-green** — read `offer()`/`shortfall()`/`signal()` in full. Before this diff, `signal()` had no early-return for the motes-priced case, so a band-short/motes-affordable altar fell through to the tail branch and returned `'short'` — this is exactly the bug being fixed (confirmed by diff inspection of the removed/added lines, not just the commit message). New test's final block pins `'short'` with no motes, then `'afford'` once motes reach `MOTE.motes`, plus the violet-emissive material check (`0x7a2fae`) at 200 ticks. Ran clean: pass.

6. **Ran independently**: `npm test` → 159/159 test files passed. `npm run gates:cheap -- --quiet --lane C` → PASS (test/build/audit, 3/3 arms).

7. **gate:sp argument** — assessed and then *empirically* checked rather than taken on reasoning alone: ran `node tests/sp-equivalence.mjs --compare reviews/round7/baseline-6676066.json --lane C` and the `--coop-host` variant. Both report "no fields moved." Combined with the mutation-test result in (2), I found no path where a moteless/bandless baseline run's `ctx.rng` draws change — the executor's argument holds, though `gates.mjs advise` still (correctly, mechanically) flags gate:sp as RUN-recommended since the file changed; running it cost ~30s and removed all doubt.

## Findings

**Minor** — `tests/purity-altar-spawn.test.mjs` has no test that isolates a **band-only** mid-stage crossing (motes staying at 0 throughout) surfacing the altar via `_surfaceBargain`. The existing "mid-stage" test only exercises band crossing *after* motes already placed the altar (so `_placeBargain`'s dedup guard is what's actually being tested at that point, not the band branch of `_surfaceBargain` in isolation). This is genuinely new behavior — prior to this commit, a band crossing mid-stage never surfaced the guaranteed altar at all (it was populate-time-only). I verified by hand (scratch script, no repo file modified, worktree left clean) that band-only mid-stage crossing does correctly surface exactly one altar: `band=0/motes=0` → 0 altars after ticking → set `band=BOON.reroll.band` only → 1 altar. Behavior is correct; test coverage for this specific path is absent. Not release-blocking.

## Commands run

```
node <scratch: monkey-patch _placeBargain to inject ctx.rng.next(), rerun 20-case parity>   -> cases=20 drift=20
node <scratch: band-only mid-stage crossing check>                                          -> confirms 1 altar surfaced
npm test                                                                                     -> 159/159 test files passed
npm run gates:cheap -- --quiet --lane C                                                      -> PASSED (3/3 arms)
node tests/sp-equivalence.mjs --compare reviews/round7/baseline-6676066.json --lane C        -> no fields moved
node tests/sp-equivalence.mjs --coop-host --compare reviews/round7/baseline-6676066.json --lane C -> no fields moved
node tools/gates.mjs advise --since 2f723ad                                                  -> RUN test/build/gate:sp/gate:mp1/gate:elite; SKIP audit/trickle
```

No repository file was modified during this review; `git status --porcelain` in the worktree was empty at both the start and end of the session.
