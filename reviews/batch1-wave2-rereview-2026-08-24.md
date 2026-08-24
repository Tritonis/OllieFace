# Scoped re-review — batch-1 wave-2 (the ONLY re-review for this fix wave)

Date: 2026-08-24
Scope: two commits fixing `reviews/merged-integration-170-172-174-2026-08-24-review.md`
- `25acc6b` on branch `fix/174-integration` (worktree `.claude/worktrees/agent-a25e0be1a701e93c1`, branched off `f14540b`)
- `7e9eeda` on `master` (main tree)

## Verdicts

- **SPEC — CONFIRMED.** Both reproducible failures from the integration review (M1 salvage
  commitment, m3 altar placement drift) are fixed, verified independently, and the fixes hold
  under mutation (reverting the gate makes the permanent tests fail).
- **QUALITY — READY.**

Counts: **0 Critical, 0 Major, 0 minor.**

## M1 — salvage pure commitment gated on `warded > 0` — CONFIRMED FIXED

`src/systems/Corruption.js:212`: `else if (outcome === 'salvage' && warded > 0) this.commit('salvaged');`
`src/world/itemTransaction.js:172/339`: quote's `commitment` is `salvageTaken > 0 ? commitmentOf('salvaged') : commitmentOf(null)`; `resolve()` result carries `warded: outcome === 'salvage' ? -corruption : 0`.

Independent repro (standalone script, not the shipped tests), pre-corrupted run
(`bargainSynergy` + `ruin`, ledger `{corrupt:28}`, `alignment: corrupt`, `corruptCapstone: true`):
- 8 consecutive no-op salvages at world 0: every quote's `salvage.commitment` reads
  `{class:null, amount:0}`; ledger unchanged after all 8; `alignment` stays `corrupt`;
  `corruptCapstone` stays `true` throughout. The review's exploit (2 presses -> mixed, 8 -> free
  pure capstone) does not reproduce.
- A genuine warding salvage (world fed to 50) still commits: quote shows
  `{source:"salvaged", class:"pure", amount:3}`, `warded:4` on resolve, ledger gains
  `salvaged` (3) + `warded` (0.2) = pure 3.2. Warding salvage is not over-corrected into
  committing nothing.

**Mutation check (reproduced the executor's claimed mutation):** reverted the guard to
`outcome === 'salvage'` (dropping `&& warded > 0`) in the worktree, ran the two affected test
files, restored the file. Result: `item-transaction.test.mjs` 106 passed / **4 failed**,
`alignment-ledger.test.mjs` 134 passed / **2 failed** — confirms the tests actually exercise
the gate rather than passing vacuously. The permanent regression guard
(`item-transaction.test.mjs`, "that gate CAN fail: bill the decline regardless and it goes red",
via an in-process `UngatedCorruption` subclass) also passes on the real code and independently
demonstrates the inverse (flips to `mixed`, drops the capstone) when ungated.

## m1 — corrupt reward carries live grace + description — CONFIRMED

`outcomes.corrupt.reward.grace = blightGrace(ctx)` and `.description = describeBlight(blightDef, 1)`
(`itemTransaction.js` ~192-206). Test "the corrupt quote says what the card is actually worth
right now" confirms grace differs by world state (Pristine: floored <1 and equals
`blightGrace(ctx)`; world 200: `1`) and the line embeds a `%` figure. `describeBlight` was
exported from `Items.js` (previously local) rather than reimplemented — same catalogue path
`Items._openMutationChoice` uses.

## m2 — no-counterpart items offer only safe+salvage — CONFIRMED

`corruptRewardFor` returns `null` for the 91/102 non-blight-countered items instead of
self-referencing; `offeredOutcomes()` drops `corrupt` from the list; `quoteItemOffer` sets
`outcomes.corrupt = null`; `resolve()` checks `offeredOutcomes(itemId).includes(outcome)`.
Verified `BLIGHT_BY_BASE.size === 11` against `ITEM_BY_ID.size === 113` directly (matches the
review's "11 of 102" — remaining 2 items are the blight cards themselves, not eligible bases).
Test confirms `resolve('corrupt')` on a no-counterpart item returns `null`, offer stays
unresolved, nothing charged, and `safe` still resolves normally.

## m4 — `thresholdOf` reads owner's Items — CONFIRMED

`thresholdOf(ctx, added, owner)` now calls `Items.of(ctx, owner)?.nextTollBand?.()` instead of
the viewer singleton `ctx.items`. Test "a remote owner is quoted against their OWN toll
history" sets up a teammate with `_mutePeak = 3` distinct from the local viewer, confirms
`ctx.items.nextTollBand() !== mate.items.nextTollBand()`, and that a quote passed
`{owner: mate}` reads the teammate's band while an unowned quote still reads the viewer's.

## m3 — `_placeBargain` spawn position cloned (commit `7e9eeda`, master) — CONFIRMED

`src/world/Interactables.js:2609`: `const spawn = (ctx.player?.position || new THREE.Vector3()).clone();`
with a comment explaining why (late `_bargainSite` resolution must not depend on live player
position). `tests/purity-altar-spawn.test.mjs` "placement is the seed's answer, whenever it is
asked" — including "and it stands where population would have put it" — passes (19/19 in that
file). This is the exact regression guard for the review's drift repro; did not re-run the
review's ad hoc inline probe since the committed test already covers the same claim precisely.

## m5 — doc comment fix (commit `7e9eeda`, master) — CONFIRMED

`src/data/items.js:113`: now says `Items.fixedUpdate` (was `Items.update`, which doesn't exist).
Matches `Items.js:1986-1987`.

## The 159-vs-161 anomaly — explained, not a Major

Test-file counts by commit (`git ls-tree -r --name-only <rev> -- tests | grep -c '\.test\.mjs$'`):

| commit | test files |
|---|---|
| `33cd5e4` (#174) | 159 |
| `9ee3cd5` (#172) | 160 |
| `cf2aed1` | 159 |
| `f14540b` (#170, branch point) | 161 |
| `25acc6b` (fix commit, branch HEAD) | 161 |
| `7e9eeda` (master HEAD) | 161 |

`fix/174-integration` branched off `f14540b`, which already has 161 test files, and `25acc6b`
adds no new test files (only edits two existing ones). `git diff` of the two trees' `tests/*.test.mjs`
basenames is empty — the branch and master have byte-identical test file *sets* right now. I ran
`npm test` fresh in the worktree myself: **161/161 passed**, matching the integration review's
merged-tree count exactly. The executor's "159/159" almost certainly reflects a test run taken
before their branch had actually landed on `f14540b` (159 matches `cf2aed1`/`33cd5e4`, two
commits upstream of the branch point) — a stale pre-rebase report, not a missing file. No test
file is missing from the branch today; this is not a Major.

## Commands run

| Command | Where | Result |
|---|---|---|
| `npm test` | worktree `fix/174-integration` @ `25acc6b` | 161/161 passed |
| `node tests/item-transaction.test.mjs` | worktree | 110/110 passed |
| `node tests/alignment-ledger.test.mjs` | worktree | 136/136 passed |
| mutated `Corruption.js` (dropped `&& warded > 0`), reran, restored | worktree | 4 + 2 failures (confirms guard is live) |
| `npm run gates:cheap -- --quiet --lane A` | worktree | PASSED 3/3 (test 90.1s, build 2.1s, audit 1.7s, 1 allowlisted) |
| `node tests/purity-altar-spawn.test.mjs` | main tree, master @ `7e9eeda` | 19/19 passed |
| standalone M1 exploit repro (pre-corrupted run, 8x no-op salvage; separately a genuine warding salvage) | worktree | matches expected — no flip, genuine salvage still commits |
| `git ls-tree` test-file counts across history + `diff` of basenames | both trees | explains 159 vs 161 |

Node modules made available to the worktree via a directory junction to the main tree's
`node_modules` (standard lane practice per `CLAUDE.md`); no code was edited, no `gh` used, no
push performed.

## Clean

M1, m1, m2, m3, m4, m5, test-count-anomaly, gates:cheap, purity-altar-spawn
