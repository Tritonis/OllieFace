# Review: FIX 06-loaded-hud (branch `fix/loaded-hud-horde`, commit `b4f1c59`)

Independent first review. Worktree reviewed:
`.claude/worktrees/agent-ae0a7e8f826a693e4` (branch `fix/loaded-hud-horde`, HEAD
`b4f1c59`, based on `1911d79`). Implementer report:
`reviews/round7/FIX-loaded-hud.md`.

All verification below was reproduced independently — either by recomputing
from the committed manifests directly, or by running fresh captures myself
(new browser sessions, my own ports, in one case a second, throwaway git
worktree at the pre-fix commit). No code was modified; `node_modules` was
junctioned in and removed afterward per the run mechanics.

---

## Verdict

**SPEC: CONFIRMED.** Every load-bearing claim in the report — the culprit
commit, the kill mechanism, the `declutter`/`e.alive` interaction, the
before/after numbers, the blightEdge false-comment finding, and the
reproducibility of the fix — checks out against independently generated
evidence, including a live capture I ran on a separate worktree at the
pre-fix commit that reproduces the exact red failure the report describes.

**QUALITY: READY**, with one **major** documentation/robustness finding the
implementer (or a fast follow) should address, and two **minor** citation
slips in the report/comments that don't affect correctness. See findings
below. None of these block the merge; none contradict the SPEC claim.

**Alive-at-shutter:** YES, confirmed directly from the `after` manifest — the
mask is drawn from live rigs (10/10 visible, `objectFailures: []`), not
corpses; `declutter` moved bodies (it can only move `e.alive` entities, see
`src/core/Harness.js:831-832`), and the DIAG data shows exactly the pinned
"alive: true" state producing the moved/green result versus the dead
"alive: false" state producing the stuck/red one.

**Sabotage check:** YES — disabling the fix (i.e. running the pre-fix commit)
reproduces the red gate. I did this myself, live, not just by re-reading the
implementer's committed manifest (see §3).

---

## 1. The culprit claim

Verified independently against `git log`/`git show`, not taken on faith:

- `cf7e63e` ("Sixteen items, a fifth survivor, and three enemies that change
  the fight", 2026-08-02 13:12:31 -0500) is the direct child of `ddb1246`
  ("A techno bed that answers the fight, not just the clock", 13:12:11
  -0500) — confirmed via `git log --oneline -1 cf7e63e^` = `ddb1246`.
- `6157ccb` (13:49:36, same day) contains the line "`06-loaded-hud` still
  fails and is untouched: a separation miss, not a size miss... and it
  alternates pass/fail across the round-6 captures with the same code" —
  confirmed via `git show -s --format=%B 6157ccb`. This corroborates the
  report's four-commit-wide window claim, though note the same message
  admits the shot was already flaky pass/fail *before* `cf7e63e` on
  round-6 code — a nuance the report doesn't surface, but it doesn't
  contradict the bisect (see below, the bisect discriminates cleanly on
  full runs at this seed regardless).

Bisect arms recomputed directly from the committed manifests
(`reviews/round7/captures/fix-loaded-hud/{ddb1246,cf7e63e,head}/manifest.json`),
not just read as prose:

| tree | px | visible | objectFailures |
|---|---|---|---|
| `ddb1246` | 2624 | 10/10 | `[]` |
| `cf7e63e` | 766 | 9/10 | `[{"i":6,"px":147,"sepP50":0.23}]` |
| `1911d79` (HEAD before fix) | 815 | 8/10 | `[{"i":6,"px":179,"sepP50":0.11}]` |

All match the report to the digit. The HEAD row also matches
`[main repo] reviews/round7/captures/diag-full/manifest.json`'s `perPx`
(`[7,3,24,206,51,35,179,109,86,115]`) exactly — I re-extracted this from the
main-repo file myself rather than trusting the report's claim of a match.

**Verdict: CONFIRMED**, discriminating and evidenced, not asserted.

## 2. The mechanism

`fix-loaded-hud/diag7-head/manifest.json`'s `DIAG kill` entry: all ten spawn
at full health (`burrower 14280/14280` etc.), all ten are dead five frames
later, and the kill log shows `type: "lightning", amt: 46.2` landing as
`ret: 86648.9` on eight of the ten (harrier, wisp, spitling, mite, beetle,
pest, charger, lemurian all show exactly `86648.9`). Confirmed directly from
the manifest, not the report's prose.

**Minor citation slip (both in the report and in the shipped code comment,
`Harness.js:3046`):** both attribute `ret: 86648.9` specifically to the
*burrower* kill ("`hp0 14280 -> hp1 0` on the burrower, `ret 86648.9`"). The
manifest's actual burrower entry reads `ret: 37673.5`, not `86648.9` — the
burrower is the *only* one of the eight full-health kills with a different
`ret` value (presumably a different armor/multiplier interaction at its much
higher max HP). The `86648.9` figure is real and is the dominant value in the
kill log, but it belongs to lemurian/harrier/wisp/etc., not the burrower it's
paired with in both places. Doesn't affect the mechanism conclusion (which
holds regardless of which entity carries which exact ret value) but is worth
a one-line fix in the comment since it's now permanent.

The `declutter`/`e.alive` interaction is confirmed at the code level
(`src/core/Harness.js:831-832`, `.filter((e) => e?.alive && e.position && ...)`)
and empirically from `diag4-ddb1246` vs `diag4-head`:

- `ddb1246` (alive): `moved: 8`, before `[21.6..46.5]`, after `[14.1..26.4]`.
- `1911d79`/head (dead): `moved: 0`, before/after identical `[29.9..41.9]`,
  every `state[i].alive === false`.

Both re-extracted directly from the manifests, matching the report exactly.

The `shriver`-displaces-`brood` claim also checks out:
`spawnRing`'s `cards[i % cards.length]` is at `src/core/Harness.js:717`
exactly as cited, and `SPAWN_CARDS = ENEMIES.filter(...)` at
`src/data/enemies.js:1305` derives its order from `ENEMIES`, where `shriver`
(defined at line 307) now sits before `brood` (line 403) — consistent with
`cf7e63e` inserting a new enemy ahead of `brood`'s old position in the
first-ten prefix.

**Verdict: CONFIRMED**, with one minor (burrower/ret-value) citation error
that should be corrected but changes nothing substantive.

## 3. The fix is honest, and the sabotage check

**Alive at shutter, not just present.** `after/manifest.json`'s `monsters
under load` check: `px: 2093, visibleObjects: 10/10, objectFailures: []`.
`declutter` only moves `e.alive` entities (confirmed above), and it clearly
ran (the box and per-object positions differ from the dead-state numbers),
so the horde was genuinely alive — not just undead corpses with `alive`
left `true` by omission — when `declutter` and the composition pass ran.

**Post-shutter kill actually happens, and doesn't leak downstream.**
Traced `ctx.director.clear(ctx)` (`src/systems/Director.js:966-985`), which
runs unconditionally at the top of every scenario's `begin()`
(`src/core/Harness.js:114-117`) and despawns *every* enemy regardless of
alive/dead state before the next scenario spawns its own cast. `10-inventory`
spawns an entirely fresh 8-monster pack of its own
(`spawnRing(8, SPAWN_CARDS, 12)` at `Harness.js:3974`) with its own
independent health-pin ("the pack is pinned at full health across the
settle" — verified verbatim at `Harness.js:3970`), so it never inherits
`lateRun`'s horde by construction, alive or dead. `20-blight-edge` runs its
own `spawnRing(8, ...)` too. So the pin cannot "leak into" a later scenario
as *live entities* under any of the three tested endings — see §5 for what
I believe is the *actual* mechanism behind the ending mattering, which is
narrower than what the report and the shipped comment claim.

**Harness-only, does not leak into gameplay.** `installHarness` is only
imported and called when the URL carries `?harness` (`src/main.js:118-120`,
behind a dynamic `import()`), so none of this pin/kill code ships in, or
executes during, a normal player session. Confirmed by reading the call
site, not assumed.

**Sabotage check — done live, not just re-read.** I created a second,
throwaway git worktree at the pre-fix commit `1911d79`
(`.claude/worktrees/review-sabotage-check`, removed after), junctioned
`node_modules`, and ran a fresh full capture
(`node tools/capture.mjs --out reviews/round7/captures/review-sabotage-full --port 5316 --seed 1337`).
Result, extracted directly from the manifest I generated:

```
subjectFailures: ["06-loaded-hud", "19-overkill"]
06-loaded-hud "monsters under load": px 815, visibleObjects 8/10,
  objectFailures [{"i":6,"px":179,"sepP50":0.11}],
  perPx [7,3,24,206,51,35,179,109,86,115]
```

This is an exact digit-for-digit match to the report's claimed "before"
state and to the main-repo's independently-existing `diag-full/manifest.json`
— produced by a completely independent run, on a completely separate
worktree, that I built and executed myself. **Disabling the fix reproduces
the red gate.** This directly answers the sabotage question and rules out
the "verified only by the gate it greens" failure mode.

I then ran the *current* (fixed) tree's full suite myself as well (separate
port, separate browser session, not the implementer's committed manifest):

```
06-loaded-hud: px 2093, visibleObjects 10/10, objectFailures []
10-inventory:  px 565, ok
20-blight-edge "a live fight": 9, ok
subjectFailures: ["19-overkill"]   (only)
```

Matches the report's claimed "after" numbers to the digit, on my own fresh
run.

**Verdict: CONFIRMED** on all three sub-claims (alive at shutter, kill
actually happens without leaking, harness-only). Sabotage check: gate goes
red without the fix, confirmed live.

## 4. blightEdge's pin and the false-comment claim

`diag-blight-fixed/manifest.json`'s `DIAG blight` entry (re-extracted
myself): `items: 97`, and the roster array shows all eight ring members at
`X<name> 0/<max>` — dead at the shutter, holding a 97-item haul. This
directly falsifies the old "drops the haul" comment `begin()` was assumed to
back up: `begin()` (`Harness.js:86-118`) calls `ctx.director.clear(ctx)`,
which despawns enemies, but never touches `ctx.items`/inventory state.
**Verdict: CONFIRMED**, the false-comment finding is real and the fix's pin
addresses a genuine, now-measured defect rather than masking one — the ring
was dying to the same proc-timing fragility `06-loaded-hud` had, not to
anything the shot's own mechanics were supposed to test.

## 5. RNG neutrality, side effects, and the one major finding

**Reproducibility across runs:** confirmed directly. `after/manifest.json`
and `after-repeat/manifest.json` are identical on every measured field
(`06-loaded-hud` 2093px/10-10/`[]`, `10-inventory` 565px/ok,
`20-blight-edge` 9/ok). My own independent full run (§3) reproduces the same
three numbers again, from a third, completely separate execution. Not
in dispute.

**Major finding — the report's explanation for *why* the ending matters is
almost certainly wrong, even though the measured outcome is real.**

The report and the shipped code comment (`Harness.js:3123-3131`) both claim
that releasing the pin without killing lets "the ten follow the survivor
into `10-inventory` and crowd the pack it is graded on." I traced this and
do not believe it is mechanically possible: `10-inventory`'s own `begin()`
call (`Harness.js:3932`) runs `ctx.director.clear(ctx)`
(`Harness.js:114-117`) *before* `10-inventory` spawns anything, and `clear()`
unconditionally despawns every enemy regardless of alive/dead state
(`Director.js:966-974` — no `e.alive` check). Between `lateRun`'s `freeze()`
(which stops the engine's `running` flag, `Harness.js:152`) and the next
scenario's `begin()`, no further frames render (`begin()`'s frame-wait loop
is gated on `!stageStarted`, which is already `false` by this point in a
full run, so it runs zero iterations). So the old horde cannot physically be
present in `10-inventory`'s frame under *any* of the three tested endings —
it is always wiped before `10-inventory` places its own, independently
pinned, 8-monster pack.

What I believe actually explains the measured 565px (kill) vs. 623px
(walk-away / despawn, byte-identical to each other) split: the post-shutter
`ctx.combat.applyDamage` call (`Harness.js:3141-3145`) rolls a crit check per
kill. In `Combat.applyDamage` (`src/systems/Combat.js:464-468`), `crit` is
only skipped when `info.crit !== undefined`; the Harness call never sets
`info.crit`, so for each of the ten kills, if `source.stats.critChance > 0`
(near-certain for a 97-item late-run inventory — at least three items modify
`critChance`, `src/data/items.js:286,476,1747`), `ctx.rng.next()` fires.
`applyDamage` also unconditionally runs the amount through
`ctx.items.modifyOutgoing` (`Combat.js:472-474`) for *any* player-sourced
hit, `procCoefficient` notwithstanding — the same per-item hook chain
responsible for the original 1875x blowup, some of whose ~37 hooks may
themselves roll RNG for their own trigger chance. The "walk away" and
"despawn" endings never call `applyDamage` at all, so they consume *zero*
extra `ctx.rng` draws at this boundary — which is exactly why they come back
byte-identical (623px, same `objectFailures`) to each other, while "kill"
(the only ending that draws RNG here) lands on a different, and coincidentally
better, downstream `10-inventory` placement.

If this reading is right, `10-inventory`'s continued pass is not structurally
guaranteed by "the ending is load-bearing" — it is contingent on the *exact
count* of RNG draws this bookkeeping kill happens to consume, which depends
on the current item roster's `critChance` sources and `modifyOutgoing` hook
count. A future, unrelated item addition or reorder that changes how many of
those ten kills roll a crit, or how many outgoing hooks fire, would shift
`10-inventory`'s object-4 separation (currently passing at a value close to
its 0.25 floor in the `after` data, and failing at 0.09 in the untested
endings) with no connection to whatever that future change actually touches
— reproducing, in miniature, exactly the "passing on the timing of a proc
rather than on anything it does" fragility this same report calls out and
fixes in `blightEdge`. I'd flag this as worth either (a) correcting the
comment's stated mechanism, and/or (b) passing `crit: false` explicitly on
the bookkeeping kill to make it deterministic-by-intent rather than
coincidentally-lucky, so a future change to the item roster can't silently
flip `10-inventory` red again for a reason nobody will think to look at
`lateRun` for. This is a quality/robustness finding, not a correctness
defect — the current code passes, reproducibly, today.

**Side effects / gameplay leakage:** none found. Confirmed harness-only
(§3). `procCoefficient: 0` does correctly suppress the `onHit` proc-chain
dispatch (`Combat.js:589`, gated on `coeff > 0`), so the report's "must not
start a proc chain" claim is accurate for that specific channel — it just
doesn't cover the `modifyOutgoing` and crit-roll channels discussed above,
which are outside `procCoefficient`'s gate.

## 6. Tests, build

- `node tests/run.mjs`: **46/46 test files passed, 41/41 assertions in the
  printed suite, 0 failed.** Ran myself in the review worktree.
- `node node_modules/vite/bin/vite.js build`: **succeeded**, `built in
  857ms`, only the pre-existing chunk-size warning (unrelated, cosmetic).
- No new automated test was added for this fix specifically (verification is
  via the capture-gate manifests, consistent with how this project verifies
  other "shot" scenarios). Not a defect given the project's conventions, but
  noting it since the task asked about tests broadly.

---

## Findings summary

| # | Severity | Location | Finding |
|---|---|---|---|
| 1 | Major | `Harness.js:3123-3131` (comment) + `FIX-loaded-hud.md` §3 | The stated mechanism for why the pin's ending matters ("the ten follow the survivor into 10-inventory and crowd the pack") is not mechanically possible — `begin()`'s `ctx.director.clear()` wipes the old horde regardless of alive/dead state before `10-inventory` spawns its own pack. The real driver is very likely RNG-draw-count displacement from the post-shutter `applyDamage`'s crit roll and `modifyOutgoing` hooks, which is a materially different (and more fragile) claim than the one documented. See §5. |
| 2 | Minor | `Harness.js:3046` + `FIX-loaded-hud.md` §2 | `ret: 86648.9` is cited as the burrower's kill value; the manifest shows the burrower's actual `ret` is `37673.5`. `86648.9` belongs to the other eight full-health kills. Mechanism conclusion unaffected. |
| 3 | Minor | `Harness.js:3044` vs. `FIX-loaded-hud.md` (top) | Code comment says "37 items," report says "97-item inventory" / "97 items" for the same inventory. Plausibly two different counts (distinct item types vs. total displayed tiles/stacks) rather than a contradiction, but neither document says which, and it reads as inconsistent on a skim. |

No critical findings. No threshold changes anywhere in the diff (confirmed
via `git diff` grep for `minPixels`/`minSep`/`minObjects`/numeric comparison
changes — none found outside comment prose).

---

## Commands run (for reproducibility)

```
git log --oneline -10 / git show -s --format=... cf7e63e / ddb1246 / 6157ccb / e3f160d
node -e "...manifest inspection..." for every manifest cited above
grep -n "e.alive" / "const declutter" / "const spawnRing" / "const invulnerable" / "const begin" src/core/Harness.js
grep -n "SPAWN_CARDS" src/core/Harness.js src/data/enemies.js
grep -n "critChance" src/data/items.js
node tests/run.mjs
node node_modules/vite/bin/vite.js build
node tools/capture.mjs --only 06-loaded-hud,10-inventory,20-blight-edge --out reviews/round7/captures/review-loaded-hud --port 5315 --seed 1337
node tools/capture.mjs --out reviews/round7/captures/review-loaded-hud-full --port 5315 --seed 1337
git worktree add .claude/worktrees/review-sabotage-check 1911d79
node tools/capture.mjs --out reviews/round7/captures/review-sabotage-full --port 5316 --seed 1337   # pre-fix tree, live sabotage check
git worktree remove --force .claude/worktrees/review-sabotage-check
```

(My own capture output directories inside the reviewed worktree were deleted
after use; the `node_modules` junction was removed after use, per mechanics.)

---

## Note for combining with the parallel branch

Not reviewed here (out of scope), but worth flagging for whoever integrates
both: this branch's fix lives entirely in `src/core/Harness.js` (`lateRun`
and `blightEdge`), touching only pin/kill logic around an existing
`spawnRing` call and leaving `spawnRing`/`declutter`/placement code itself
untouched. If the parallel branch (`worktree-agent-a4f21b33fa0ad51af`,
`c49b730`) re-seats the same scenario's horde by editing placement/siting
code in the same functions, the two diffs likely touch adjacent but
non-overlapping regions of `lateRun`/`blightEdge` — worth a straight 3-way
diff read before merging both, since this branch's post-shutter kill block
assumes it runs immediately after `mustContain` with no intervening
re-seating logic, and the RNG-fragility described in finding #1 above means
*any* change that alters how many RNG draws happen between the two shutters
could move `10-inventory`'s pass/fail independent of either branch's stated
intent.
