# Re-review: integration wave 1 (loaded-hud merge + harness cherry-picks)

Scoped re-review, master HEAD `82508a7`. Not re-reviewing what the per-branch
first reviews already confirmed (`reviews/round7/task-loaded-hud-review.md`,
`reviews/round7/task-harness-review.md`) — verifying only that the
INTEGRATION itself is faithful to what those reviews approved, and that the
one commit those reviews required be dropped (`c49b730`) actually was.

All commands below were run directly against the main repo working tree
(already has `node_modules`; no worktree created, no `npx`).

---

## Verdict

**SPEC: CONFIRMED** — the wave as integrated matches what the two first
reviews approved: the loaded-hud pin/kill fix (with its post-review citation
and `crit:false` revision) merged intact, exactly three of the four harness
commits cherry-picked byte-identically (content-wise) onto master, and
`c49b730` (the dead-horde re-seat the harness review found Critical and
REFUTED) left no trace anywhere in the integrated tree.

**c49b730 remnant: NONE.** Confirmed three independent ways — see §2.

**QUALITY: READY** for the wave itself. One **major**, non-blocking finding
surfaced during integration verification: `10-inventory`'s own monster-ring
check (`monsters standing in it`) is now failing 0/8 on a full run, which
appears to be exactly the RNG-draw-count fragility the first loaded-hud
review flagged as its own Major finding — triggered by an unrelated commit
(the item/enemy id migration, `c9b12bb`) that landed on master between the
branches' common base and this integration, not by anything in this wave's
own diff. See §4b.

- **0 Critical**
- **1 Major** (informational — not caused by this wave, not blocking)
- **0 Minor**

Tests: **47/47** test files passed (`node tests/run.mjs`).

---

## 1. `12d2437`'s revision — is the stated mechanism accurate?

Read the current comment at the `lateRun` kill site
(`src/core/Harness.js:3095-3135`, `3180-3236`) and checked every load-bearing
claim in it against code and the on-disk diagnostic manifest, not against the
report's prose.

**Mechanism claim ("644 RNG draws, not bodies leaking"):** the comment now
correctly attributes the change in `10-inventory`'s placement between the
three tested endings (walk-away / despawn / kill) to RNG-draw-count
displacement, not to bodies surviving into the next scenario — and backs this
with the same trace the first review did independently (`begin()` calls
`ctx.director.clear(ctx)` at `Harness.js:114`, unconditional on `alive`,
before any next-scenario spawn). This directly incorporates the first
review's Major finding #1 rather than ignoring it.

**Citation fix (burrower `ret` value):** the first review's minor finding #2
was that the pre-revision comment and report both misattributed
`ret: 86,648.9` to the burrower kill, when the burrower's actual line was
`ret: 37,673.5`. Re-checked directly against
`reviews/round7/captures/fix-loaded-hud/diag7-head/manifest.json`'s `DIAG
kill` entry:

```
"id": "burrower", "amt": 46.2, "ret": 37673.5, "hp0": 14280, "hp1": 0, "crit": false
```

The current comment (`Harness.js:3111`) now reads "the burrower's own line is
`hp0 14280 -> hp1 0` on a `ret` of 37,673.5", and attributes the 86,648.9
figure to "eight of the ten" generically (`Harness.js:3105,3110`) rather than
to the burrower specifically. **Fixed correctly, matches the manifest to the
digit.**

**`crit: false` — is it actually passed, and does it do what the comment
claims?** Confirmed both.

- The call site (`Harness.js:3232-3235`):
  ```js
  ctx.combat?.applyDamage?.(p.e, p.maxHealth * 2, {
    source: ctx.player, position: p.e.position, type: 'lightning',
    procCoefficient: 0, procDepth: 1, crit: false,
  });
  ```
- `Combat.applyDamage` (`src/systems/Combat.js:464-468`):
  ```js
  let crit = info.crit === true;
  if (info.crit === undefined && stats && !info.isDot) {
    const chance = stats.critChance || 0;
    if (chance > 0 && ctx.rng.next() < chance) crit = true;
  }
  ```
  `info.crit` is `false`, not `undefined`, so the `ctx.rng.next()` roll is
  skipped entirely — exactly the comment's claim ("`Combat.applyDamage` only
  skips its crit roll when `info.crit` is defined").
- Verified empirically too: every one of the 10 kill entries in
  `diag7-head/manifest.json`'s `DIAG kill.kills[]` array shows `"crit":
  false"`, confirming the flag is both passed and honored at runtime.
- `procCoefficient: 0` claim ("does not gate `modifyOutgoing`, which is where
  most of the 644 live") checked against `Combat.js:472-474`
  (`ctx.items.modifyOutgoing` runs unconditionally for any
  `source?.isPlayer` hit, no `procCoefficient` guard) and `Combat.js:588-593`
  (the `onHit` proc-chain dispatch *is* gated on `coeff > 0`) — both claims
  hold exactly as stated.

**Verdict: CONFIRMED.** The revision is sound on every checked claim: the
mechanism, the citation fix, and the `crit: false` behavior all match code
and manifest evidence, not just the comment's own prose.

---

## 2. No remnant of `c49b730`

`c49b730` ("lateRun composes the ground its horde stands on") inserted, after
`spawnRing(10, SPAWN_CARDS, 14, 3); await frames(settleFrames);`, an
unconditional re-seat:

```js
const cast = (ctx.director?.enemies ?? []).filter((e) => e?.rig?.root?.parent);
cast.forEach((e, i) => {
  const sx = 0.12 + (i / Math.max(1, cast.length - 1)) * 0.76;
  const g = groundAtScreen(sx, 0.50 + (i % 3) * 0.03, { minDist: 10, maxDist: 30 });
  if (g) _seat(e, g);
});
```

The harness review found this Critical: it re-seats a horde already dead by
that point in the frame (no `alive` filter, unlike `declutter`'s
`.filter((e) => e?.alive && ...)` three screens down), turning the gate green
over composed corpses rather than fixing or disclosing that the horde is
dead.

Checked for a remnant three independent ways:

1. **Ancestry.** `git merge-base --is-ancestor c49b730 HEAD` → not an
   ancestor. `c49b730` is simply not in master's history.
2. **The exact insertion point.** Read `src/core/Harness.js:3130-3145`
   directly (current file): the code goes straight from
   `spawnRing(10, SPAWN_CARDS, 14, 3);` / the pin-health loop /
   `await frames(settleFrames);` to the `declutter(12, { maxDist: 28 })`
   comment block — nothing between them touches `ctx.director.enemies`,
   `groundAtScreen`, or `_seat`.
3. **Signature grep across the whole file**, not just the diff: searched for
   `e?.rig?.root?.parent` (the cast filter) and the `0.12 + (i / Math.max(1,
   cast.length` sx formula (the fan placement) anywhere in
   `src/core/Harness.js`. The filter string appears twice, both unrelated to
   `lateRun`: once in `ff9f7ce`'s legitimate `nearer` helper detail block
   (`Harness.js:2825`, the `survivor unoccluded` DIAG, confirmed part of the
   cherry-picked `8f20f0d`) and once in an unrelated `placed.filter(...)` at
   `Harness.js:5173` (a different scenario). The sx-formula string does not
   appear anywhere. `groundAtScreen`/`_seat` calls that do exist in the file
   (e.g. `Harness.js:405-432`) predate `1911d79` and belong to `overkill`'s
   own hulk re-seat — the precedent `c49b730`'s commit message cites, not
   something it added; confirmed unchanged by diffing that exact hunk against
   `1911d79` (only a `beetle`→`scarab` comment-word rename from the unrelated
   id-migration merge touches it).

**`git diff 1911d79..HEAD -- src/core/Harness.js` note:** the task's
expectation that this diff shows "only the pin/kill/comment changes from the
loaded-hud branch plus `ff9f7ce`'s screen-gap additions" is close but not
exact — the diff also carries unrelated content from two other commits that
landed on master between `1911d79` and this wave (`c9b12bb`, the item/enemy
id migration renaming `golem`→`sentinel`, `wisp`→`mote`, `beetle`→`scarab`,
`Titan`→`Colossus`, etc. throughout comment prose and in one real
non-comment reference at `Harness.js:5716` (`blightEdge`'s card list), and
`ba17c90`, the spire/octave fix, which does not appear to touch
`Harness.js` directly). This is expected repo history, not an integration
defect — `1911d79` is the branches' shared base, not master's immediate
parent at merge time — but it means a literal reading of the diff needs this
context to avoid a false alarm. Confirmed none of that unrelated content is
`c49b730`-shaped.

**Verdict: NO REMNANT. Confirmed dropped, cleanly, three ways.**

---

## 3. `tools/capture.mjs` integration faithfulness

`b497be6`, `07533e6`, `8f20f0d` are presented as cherry-picks of the harness
branch's `ce36333` (only-path), `67999b0` (carried stamps), `ff9f7ce`
(vis/nearer). Diffed each pair directly (`git show <old> -- <path>` vs.
`git show <new> -- <path>`, ignoring only the commit-hash/date header lines):
content is identical in all three pairs — same additions, same removals,
just shifted line numbers from being applied in sequence on top of each
other rather than independently on `1911d79`. Confirmed via `diff` on the
`git show` output; the only differences were the `commit`/`index` header
lines and `@@` hunk-position numbers, not the code.

**Only-path enforcement**, both scenarios:
- `tools/capture.mjs:220` — `19-overkill`, `onlyPath: true`
- `tools/capture.mjs:243` — `20-blight-edge`, `onlyPath: true`
- `tools/capture.mjs:443-451` — a full run pushes a `skipped:
  'only-path-enforced'` entry with `why` instead of running `setup`, for
  either flagged scenario.

**Carried stamps reach every consumer view**, read directly at their call
sites, single occurrence each (no duplicate/half-merged assignment blocks):
- `tools/capture.mjs:396-398` — `carried`/`carriedFrom` stamped at merge.
- `:492` — folded into `manifest.shots`.
- `:501` — `subjectFailures` entries carry the flag.
- `:512-517` — `skippedShots`, `carriedShots`, `freshShots`,
  `subjectsOkFresh` each defined exactly once (grepped the whole file for
  each of these five assignment targets — one hit apiece, no doubles).
- `:538` — `toleratedAbsences` entries carry the flag too.
- `:774-789` — console `shots` line and top-level JSON summary both surface
  `carried`/`skippedShots`/`subjectsOkFresh`.

**No conflict artifacts.** Grepped both `tools/capture.mjs` and
`src/core/Harness.js` for `<<<<<<<`/`=======`/`>>>>>>>` — none found. Read
the full `onlyPath` scenario-declaration block (`capture.mjs:160-247`) and
the full merge/stamp block (`capture.mjs:355-545`) top to bottom — coherent,
single-pass logic, no dead variables, no doubled comments from a half-applied
cherry-pick.

**Verdict: CONFIRMED**, integration is faithful — content-identical
cherry-picks, cleanly merged, no half-merged artifacts.

---

## 4. Re-running the evidence

**Tests:** `node tests/run.mjs` → **47/47 test files passed**, ran fresh
myself, no failures.

### 4a. `reviews/round7/captures/integration-full/manifest.json`

Read and re-extracted every field directly, not from prose:

- `subjectFailures`: `["10-inventory"]` — exactly one entry, matching the
  task's expectation. (See §4b for what this is and isn't.)
- `skippedShots`: `["19-overkill: only-path-enforced",
  "20-blight-edge: only-path-enforced"]` — exactly the two expected,
  `only-path-enforced` reason on both.
- `06-loaded-hud` subject: `ok: true`. Its `monsters under load` check:
  `px: 2093, objects: 10, visibleObjects: 10, objectFailures: []` — the
  pinned-alive-horde numbers exactly as expected (2093 px, 10/10).
- `partial: false`, `carriedShots: []`, `freshShots.length === 23 ===
  shots.length` — confirmed this is a genuine full, fresh run, not one
  reading stale carried data.

### 4b. The `10-inventory` failure — what it is

`10-inventory`'s own `monsters standing in it` check (a *different*,
independently pinned 8-monster ring from `lateRun`'s — its own
`spawnRing(8, SPAWN_CARDS, 12)`) is failing completely: `visibleObjects: 0`
of 8, every `perPx` entry `0`. This is a real, reproducible failure on a
fresh full run (not carried, not flaky-looking — all 8 objects are
uniformly absent, not borderline).

Traced why this is not an integration-fidelity problem with this wave:

- None of the wave's own diff (the loaded-hud pin/kill/comment changes, or
  `ff9f7ce`'s `nearestNearer`/DIAG additions) touches `10-inventory`'s own
  scenario code — confirmed by reading the diff hunks list and the
  `inventory()`/`10-inventory` region of `Harness.js` directly; the only
  hunk anywhere near it belongs to `blightEdge`'s own health-pin (a
  different scenario, further down the file).
- `git log --oneline 1911d79..2d808f3 -- src/data/items.js
  src/data/enemies.js` shows the item/enemy **id migration** (`c9b12bb`,
  plus `04421d2`, `e3efe97`) landed on master *between* the branches'
  shared base and this wave's merge point — an unrelated piece of work,
  not part of either reviewed branch.
- This is precisely the shape of risk the first loaded-hud review's own
  Major finding #1 predicted: `10-inventory`'s continued pass is
  "contingent on the exact count of RNG draws [the bookkeeping kill]
  happens to consume, which depends on the current item roster's
  `critChance` sources and `modifyOutgoing` hook count" — and a roster
  change (the id migration touching `src/data/items.js`) is exactly the
  kind of "future, unrelated item addition or reorder" that review warned
  would flip `10-inventory` red for a reason nobody would think to look at
  `lateRun` for.

This is flagged as a **Major, non-blocking** finding for this re-review: it
is real, it is reproducible, and it validates a risk the first review
already surfaced and asked to be tracked — but it is not caused by anything
in this wave's own commits, and fixing it is out of this wave's scope (it
would mean either re-deriving `10-inventory`'s own composition against the
post-migration RNG stream, or making the `lateRun` bookkeeping kill
draw-count-stable some other way — neither of which this wave touches).
Flagging it here so it does not get silently absorbed into "the wave is
CONFIRMED" and lost.

### 4c. `integration-only19` / `integration-only20`

Both re-extracted directly:

```
integration-only19: partial=true subjectsOk=true subjectsOkFresh=true
  freshShots=["19-overkill"] subjectFailures=[]
integration-only20: partial=true subjectsOk=true subjectsOkFresh=true
  freshShots=["20-blight-edge"] subjectFailures=[]
```

Both green, both `subjectsOkFresh: true` — matches expectation exactly.

### 4d. Live re-capture, `--only 19-overkill`, port 5323

Ran fresh (not the implementer's committed manifest): `node tools/capture.mjs
--only 19-overkill --out <scratch dir> --port 5323 --seed 1337`.

```
shots: ["19-overkill"], skippedShots: [], subjectsOk: true,
subjectsOkFresh: true, subjectFailures: [], errorCount: 0
```

Reproduces cleanly on an independent run, own port, own output directory
(deleted after use, outside the repo).

**Verdict: CONFIRMED** on every sub-claim in §4 except the one flagged above,
which is real but out of scope for this wave (§4b).

---

## 5. Menuprobe merge (`cbef706`)

Out of scope per the dispatch — already ran green post-merge. Not
re-reviewed here.

---

## Commands run

```
git log --oneline -15 / git status / git rev-parse HEAD
git diff 1911d79..HEAD -- src/core/Harness.js   (555 lines, read in full)
git show 2d808f3 --stat ; git rev-parse 2d808f3^2 ; git log --oneline 1911d79..2d808f3^2
git show b497be6 --stat / git show 07533e6 --stat / git show 8f20f0d --stat
diff <(git show ce36333 -- tools/capture.mjs) <(git show b497be6 -- tools/capture.mjs)
diff <(git show 67999b0 -- tools/capture.mjs) <(git show 07533e6 -- tools/capture.mjs)
diff <(git show ff9f7ce -- src/core/Harness.js) <(git show 8f20f0d -- src/core/Harness.js)
git merge-base --is-ancestor c49b730 HEAD   (not an ancestor)
git show c49b730 -- src/core/Harness.js     (full diff read)
grep -n "e?.rig?.root?.parent" / "0.12 + (i / Math.max(1, cast.length" /
  "Re-seat on ground this scenario chose" src/core/Harness.js
grep -n "<<<<<<<\|=======\|>>>>>>>" tools/capture.mjs src/core/Harness.js
grep -n "manifest.subjectsOkFresh =" / "manifest.skippedShots =" /
  "manifest.carriedShots =" / "manifest.freshShots =" /
  "manifest.toleratedAbsences =" / "const carried =" /
  "const prevManifest =" tools/capture.mjs
sed -n '440-520p' src/systems/Combat.js ; sed -n '580,600p' src/systems/Combat.js
grep -n "37,673\|37673\|86,648\|86648\|burrower" src/core/Harness.js
node -e "... inspect reviews/round7/captures/fix-loaded-hud/diag7-head/manifest.json DIAG kill ..."
node tests/run.mjs                          (47/47 passed)
node -e "... inspect reviews/round7/captures/integration-full/manifest.json ..."
node -e "... inspect integration-only19 / integration-only20 manifests ..."
node tools/capture.mjs --only 19-overkill --out <scratch> --port 5323 --seed 1337
git log --oneline 1911d79..2d808f3 -- src/data/items.js src/data/enemies.js
```

No code was modified. No worktree was created (main repo already has
`node_modules`); no `npx` used anywhere.
