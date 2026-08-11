# Review: RoR2 id-layer removal (round 7)

Reviewer: independent first review (verifier).
Worktree: `C:\Users\tpzap\source\repos\OllieFace\.claude\worktrees\agent-ad29ac6a5a4473b9b`
Branch: `worktree-agent-ad29ac6a5a4473b9b`, commits `04421d2`, `21b1033`, `00f8900`, `06bc81b`.
Implementer report read: `reviews/round7/FIX-ror2-ids.md` (335 lines) — treated as claims to verify, not evidence.

## Merge-base finding (not stale, but not conflict-free either)

`git merge-base master worktree-agent-ad29ac6a5a4473b9b` = `1911d79` — this **is** master's HEAD
at the time this worktree was created (checked against the session's opening `gitStatus`). This
worktree is **not** on the stale `f2f9f16` base other worktrees this session used; it branched
from a current point.

However, master has since advanced 7 commits (`git log --oneline 1911d79..master`): `39bf2bc`,
`cbef706`, `4734ffd`, `825c4ce`, `dfc6d11`, `aaa5bdd`, `e3efe97` — the Blight-glyph/dissolve work
the dispatch warned about, touching `src/data/items.js`, `src/entities/EnemyMeshes.js`,
`src/entities/Enemy.js`, `src/systems/VFX.js`, `src/ui/Icons.js`, `src/ui/Tooltip.js`, and adding
`tests/dissolve-recycle.test.mjs`.

A trial merge (`git merge --no-commit --no-ff master`, then reverted with `git merge --abort`)
**produces no textual conflicts** — auto-merge succeeds cleanly on all four overlapping files.
But it is **not functionally clean**: running the full suite on the merged tree drops from 46/46
to **46/47**, because master's new `tests/dissolve-recycle.test.mjs` calls `acquireRig('beetle')`,
`acquireRig('lemurian')`, `acquireRig('wisp')` (old RoR2 enemy ids) directly, and this branch's
rename removed those keys from `EnemyMeshes.js`'s `BUILDERS` map:

```
TypeError: BUILDERS[id] is not a function
    at acquireRig (src/entities/EnemyMeshes.js:4397:54)
    at tests/dissolve-recycle.test.mjs:83:15
```
(`tests/dissolve-recycle.test.mjs:83,114,125,152,158,226` all pass an old id literal.)

The merged build itself still succeeds (`node node_modules/vite/bin/vite.js build` green on the
merged tree). This is not a defect in this branch's own commits — the branch predates that test
file and could not have known about it — but it is a real, reproducible integration hazard: **this
branch cannot land on current master without a follow-up edit to
`tests/dissolve-recycle.test.mjs`** (6 call sites: `beetle`→`scarab`, `lemurian`→`skink`,
`wisp`→`mote`). No other master-side file added/changed since the merge-base references an old
id (checked `Icons.js`, `Tooltip.js`, `menuprobe.mjs`, `corpse-launch.test.mjs` — clean).

---

## Per-claim verdicts

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | 50 ids renamed (37 items this round + 6 enemies + 3 elites + 3 difficulty + 1 realm), 39 total entries in `RENAMED_ITEM_IDS` (37 + 2 already done in `3a86486`) | CONFIRMED | `src/data/renamedIds.js:43-104` counted by hand: 39 item entries, 6 enemy, 3 difficulty. `git show 3a86486 --stat` confirms that commit exists and pre-dates this branch. |
| 2 | Completeness — every remaining RoR2-vocabulary occurrence in `src/` is a migration-table key/value or a comment | CONFIRMED | Independent scout enumeration (haiku) + my own `grep -rn` for every old id literal (`'beetle'`, `'lemurian'`, `'wisp'`, `'pest'`, `'golem'`, `'titan'`, `'blazing'`, `'overloading'`, `'glacial'`, `'drizzle'`, `'rainstorm'`, `'monsoon'`, `'bazaar'`) across `src/` returned **zero** live hits outside `renamedIds.js`. |
| 3 | Deliberately-left list is correctly rationalized (`molten-core`, `rebar-launcher`, `sentry-drone`, `glyph:'clover'`, `teleporter`, `dustWisp`, `ROR2_DISPLAY`) | CONFIRMED | Scout verified each is present, unrenamed, and matches its stated rationale. Spot-checked `ROR2_DISPLAY` myself: `tests/branding-display.test.mjs:27-28` = `{blazing, glacial, overloading, malachite, celestine, perfected, voidtouched, gilded, lunar, obliterated}`, matches claim exactly. `dustWisp` in `src/fx/ParticleSystem.js:388,500` is a generic "cloud" particle fn, no relation to the renamed `wisp`→`mote` enemy. |
| 4 | Migration correctness — old-id fixtures hydrate with nothing dropped, both localStorage and desktop-shell paths route through one hydrate point | CONFIRMED | `node tests/item-id-migration.test.mjs` → **189 passed, 0 failed** (my own run, matches claim exactly). `src/core/DesktopStore.js:8-22,46-58` confirmed: desktop shell copies `save.json` into `localStorage` at boot; the six call sites (incl. `Profile`, `Artifacts`) all read `localStorage` after that, so migration logic in `Profile._migrate`/`Artifacts._load` covers both paths with no separate desktop code needed. |
| 5 | 4 negative controls, exact failure counts (12/1/1/23), run against file copies, tree never mutated | CONFIRMED | `node reviews/round7/migration-negative-controls.mjs` reproduced byte-for-byte: `CAUGHT 12 / 1 / 1 / 23`. `git status --short` before and after: clean both times. |
| 6 | Difficulty-rung silent-substitution bug found and fixed — translate before validate | CONFIRMED | `src/systems/Artifacts.js:522-523`: `renameDifficultyId(data.difficulty)` called, *then* `DIFFICULTY_BY_ID.has(difficulty)` checked. Comment at line 517-521 states the bug accurately. |
| 7 | Golden-hash re-baseline is a pure rename, 251 fields, 0 unexplained | CONFIRMED | `node reviews/round7/rebaseline-proof.mjs` reproduced exactly: `fingerprint gate: 52 fields, 0 moved`, `elite gate: 199 fields, 0 moved` → 251 total, matches `rebaseline-proof.txt` on disk and the report. |
| 8 | Baseline files carry in-file provenance naming commit `00f8900`, `dirty: false` | **PARTIALLY REFUTED** — see finding F1 below | `reviews/round7/baseline-00f8900.json`'s `source` block: `commit: 00f89006620aa17bba4c09cecb1537bea96fc67f, dirty: false` — matches. `reviews/round7/elite-baseline-00f8900.json`'s `source` block: same commit, but **`dirty: true`**, contradicting the report's "dirty: false" claim for "both" files. |
| 9 | `PROTOCOL_VERSION` 4→5 justified: item/realm ids cross as JSON, enemy typeId and difficulty cross as indices | CONFIRMED | `src/net/Protocol.js:82` = 5. `src/systems/Items.js:356` emits `itemPickup` with `{id, ...}` (string item id); `src/world/realms/Realms.js:323,365` emit `realmEnter{id: def.id}` / `realmExit`; `src/net/NetHost.js:92-94` forwards both event names verbatim over the events channel. `src/entities/Enemy.js:257` + `src/net/Protocol.js:261,280` confirm `typeId` is a `u8` array index, not a string. `src/systems/Artifacts.js:462-483` confirms difficulty crosses `WELCOME` as `difficultyIndex`, not the rung id. |
| 10 | `NETCODE.md` states the new layout-or-vocabulary rule | CONFIRMED | `NETCODE.md:125-126`: "`PROTOCOL_VERSION`... is bumped by a change in **either** the layout or the vocabulary." |
| 11 | Tests 46/46, both determinism gates green | CONFIRMED (on the branch's own base) | `node tests/run.mjs` → `46/46 test files passed` (my own run). `node node_modules/vite/bin/vite.js build` → green. Both gates (`rebaseline-proof.mjs`, migration test) independently reproduced above. See merge-base finding above for the caveat that **46/47** on a merge with current master. |
| 12 | "47 files touched in the rename commit" | **MINOR DISCREPANCY** — see F2 | `git diff-tree --no-commit-id --name-only -r 04421d2 \| wc -l` = **48**. |
| 13 | Realm rename (`bazaar`→`market`), two comments citing the existing `22-realm-bazaar.png` correctly kept old name | CONFIRMED | `grep` across the tree: only `src/core/Harness.js:2365` and `src/world/realms/RealmArena.js:94` still say `22-realm-bazaar`, both citing the on-disk PNG filename as claimed. Capture scenario itself renamed: `tools/capture-realms.mjs:50` = `'22-realm-market'`. No live `'bazaar'`/`realmBazaar`/`buildBazaar` identifiers remain. |
| 14 | `damageTypes.js`'s unquoted `behemoth:` key was the one codemod-missed spot, now fixed | CONFIRMED | `src/data/damageTypes.js:70`: `'shrapnel-heart': 'blast'`, correctly quoted and renamed. |

---

## Findings

**F1 (Minor).** `reviews/round7/elite-baseline-00f8900.json`'s `source.dirty` field is `true`, not
`false` as the report states for "both" baseline files (`FIX-ror2-ids.md:247-250`). Root cause is
almost certainly benign: `tests/sp-equivalence.mjs:262` computes `dirty` from `git status
--porcelain`, and the two baseline captures ran ~51 seconds apart (`capturedAt`
`17:58:37`/`17:59:28`); the first capture wrote `baseline-00f8900.json` to disk as a new
**untracked** file, which would make the second capture's `git status --porcelain` non-empty
(hence `dirty: true`) with no actual source-code change involved. The independent
`rebaseline-proof.mjs` run (251 fields, 0 unexplained) is strong corroborating evidence the elite
baseline's *numbers* are sound regardless. But the report's specific claim ("dirty: false…alongside
the tool, the mode, the seed…and the capture time") is factually wrong for one of the two files it
describes, and this file's own purpose is precisely to make provenance claims independently
checkable — worth a one-line correction.

**F2 (Minor).** Report claims "47 files touched in the rename commit" (`FIX-ror2-ids.md:136`);
`git diff-tree --no-commit-id --name-only -r 04421d2` lists **48** files. Off-by-one, does not
affect the substance of the rename (I independently confirmed completeness by direct grep, not by
trusting this count).

**F3 (Major, merge-readiness only, not a defect in this branch).** Merging current master into
this branch (or vice versa) is textually conflict-free but **not** functionally clean: it drops
the test suite from 46/46 to 46/47. `tests/dissolve-recycle.test.mjs`, added by master after this
branch's merge-base, calls `acquireRig('beetle' | 'lemurian' | 'wisp')` — ids this branch renamed
out of `EnemyMeshes.js`'s `BUILDERS` map — and crashes with `TypeError: BUILDERS[id] is not a
function`. Fix is mechanical (6 call sites, `beetle`→`scarab`, `lemurian`→`skink`, `wisp`→`mote`)
but is a real precondition for landing this branch, not optional cleanup. See the merge-base
section above for full repro.

No Critical findings.

---

## Verification commands run (all in the worktree unless noted)

```
git merge-base master worktree-agent-ad29ac6a5a4473b9b        # -> 1911d79
git log --oneline 1911d79..master                              # 7 commits ahead
node tests/run.mjs                                              # 46/46 (branch's own base)
node tests/item-id-migration.test.mjs                           # 189 passed, 0 failed
node reviews/round7/migration-negative-controls.mjs             # CAUGHT 12/1/1/23, tree clean before/after
node reviews/round7/rebaseline-proof.mjs                        # 52 + 199 = 251 fields, 0 moved
node node_modules/vite/bin/vite.js build                        # green (branch's own base)
git merge --no-commit --no-ff master                            # 0 textual conflicts
node tests/run.mjs                                               # 46/47 on the merged tree (dissolve-recycle fails)
node node_modules/vite/bin/vite.js build                        # green on the merged tree
git merge --abort                                                # tree restored, verified clean
```

node_modules was already present in the worktree (no junction needed). No cold-cache
`sp-equivalence` timeout encountered — did not need a retry.

---

## Verdict

**SPEC: CONFIRMED.** Every load-bearing technical claim — rename completeness, migration
correctness across both persistence paths, the difficulty-rung silent-substitution fix, the
protocol-version justification, and the golden-hash re-baseline being a pure id rekey — was
independently reproduced, not just read. Two claims in the report's prose are numerically
inaccurate (F1, F2) but neither one undermines the substantive result; I verified the underlying
facts directly rather than through the report's counts.

**QUALITY: NOT READY**, solely on the merge-readiness axis (F3): this branch will not drop into
current master cleanly — a real test crash results, requiring a small, mechanical follow-up edit
to `tests/dissolve-recycle.test.mjs`. The branch's own code, on its own base, is high quality (46/46
tests, clean build, real negative controls, a genuine bug caught and fixed, sound protocol
reasoning). Recommend: land the id-literal fix to `dissolve-recycle.test.mjs` as part of the merge,
then this is mergeable.

Severity counts: 0 Critical, 1 Major (F3, merge hazard), 2 Minor (F1, F2).
Tests: 46/46 on the branch's own base; 189/189 migration assertions; 4/4 negative controls behave
as claimed; 251/251 rebaseline fields explained; 46/47 after a trial merge with current master
(F3).
