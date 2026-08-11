# REVIEW: round-7 harness fixes (4 commits), independent first review

Branch `worktree-agent-a4f21b33fa0ad51af`, commits `ce36333`, `c49b730`, `67999b0`,
`ff9f7ce`, based on `1911d79`. Implementer report: `reviews/round7/FIX-harness.md`
(in the worktree). Cross-referenced against the sibling investigation on
`worktree-agent-ae0a7e8f826a693e4` (`reviews/round7/FIX-loaded-hud.md`).

All numbers below either reproduce an on-disk manifest the implementer already
captured, or come from a capture I ran myself in this session
(`reviews/round7/captures/review-harness/manifest.json`, seed 1337, same box,
same day). Where I ran my own capture I say so explicitly.

**Node v24.15.0, playwright (junctioned `node_modules`, removed after — see
Mechanics at the end), build via `node node_modules/vite/bin/vite.js build`,
capture via `node tools/capture.mjs --out reviews/round7/captures/review-harness
--port 5314`.**

---

## Verdicts

| # | commit | claim | verdict |
|---|---|---|---|
| 1 | `ce36333` — only-path enforcement | 19-overkill + 20-blight-edge skipped and marked loud | **CONFIRMED** |
| 2 | `c49b730` — `lateRun()` ground re-seat | "fixes" 06-loaded-hud, 815→3023 px green | **REFUTED** — the numeric claims are accurate but the fix does not do what it is presented as doing |
| 3 | `67999b0` — partial-manifest carry stamps | reaches all six consumer views, `subjectsOkFresh` honest | **CONFIRMED** |
| 4 | `ff9f7ce` — `vis`/`nearer` alongside stage-blind occlusion | verdict-neutral, reproduces hand arithmetic | **CONFIRMED** |

**SPEC: REFUTED** (commit 2 fails) / **QUALITY: NOT READY**

---

## THE CRITICAL QUESTION — is the horde alive or dead at the shutter after `c49b730`?

**Dead. The gate is green over well-composed corpses.** This is exactly this
project's "aggregate hiding an absence" failure class, and it should be named
as such, not filed as an incidental "scope collision."

### The chain of evidence

**1. Static: nothing in any of the four harness commits touches the code that
kills the horde.**

`lateRun`'s body up to and including `spawnRing(10, SPAWN_CARDS, 14, 3);
await frames(settleFrames);` (`src/core/Harness.js:3096-3098`, `settleFrames`
defaults to 60) is byte-identical before and after all four commits — `ce36333`
and `67999b0` touch only `tools/capture.mjs`, and `ff9f7ce`'s only touches to
`Harness.js` are a new `nearestNearer` helper (`Harness.js:603-645`) and the
`04-combat` `DIAG horde` / `survivor unoccluded` blocks (`Harness.js:2758-2828`)
— nowhere near `lateRun`. `c49b730` inserts its re-seat *after*
`frames(settleFrames)`, at `Harness.js:3142-3148`, and touches nothing before
that line.

The sibling investigation (`FIX-loaded-hud.md`, section 2, "Mechanism")
instrumented this exact unmodified span and found: all ten monsters at full
health through frame 50, **all ten dead at frame 60** — one chain-lightning
proc, 46.2 damage of card text delivered as 86,648.9 after a 97-item
inventory's outgoing multipliers, one frame before the settle ends. Since none
of the four commits touch anything before `c49b730`'s insertion point, this
finding transfers unchanged: **the horde is already dead by the time
`c49b730`'s re-seat code runs.**

**2. Static: the re-seat itself has no alive filter, unlike the pattern
already in the same file.**

```js
// Harness.js:3142-3148 (c49b730)
camera.updateMatrixWorld(true);
const cast = (ctx.director?.enemies ?? []).filter((e) => e?.rig?.root?.parent);
cast.forEach((e, i) => {
  const sx = 0.12 + (i / Math.max(1, cast.length - 1)) * 0.76;
  const g = groundAtScreen(sx, 0.50 + (i % 3) * 0.03, { minDist: 10, maxDist: 30 });
  if (g) _seat(e, g);
});
```

`cast` is filtered on `e?.rig?.root?.parent` only. `_seat` itself
(`Harness.js:810-814`) unconditionally sets `e.position`, `e.home` and
`e.velocity` — no `alive` check anywhere in the call path. Contrast this with
`declutter`'s candidate filter three screens down in the same file:
`.filter((e) => e?.alive && e.position && e !== keep && !seated?.has(e))`
(`Harness.js:871`) — the file already has the idiom for "only move the living"
and `c49b730`'s new loop does not use it. Dead enemies keep `rig.root.parent`
truthy (corpses render — that is the entire premise of the sibling
investigation's "it costs nothing that the monsters are dead; corpses still
draw" finding), so `cast` includes them, and `_seat` repositions them exactly
as it would a live body.

**3. Code-level confirmation of what "corpse" looks like on screen.**
`Enemy.onDeath()` (`src/entities/Enemy.js:483-515`) sets `this.alive = false`
and calls `this.rig?.beginDeath(ctx.rng)`. `beginDeath`
(`src/entities/EnemyMeshes.js:789-794`) scatters the rig's `crumble` pieces
with randomized tumbling directions/spins — a break-apart death animation, not
a standing pose.

**4. Visual, independently reproduced.** I ran my own full capture this
session (`reviews/round7/captures/review-harness/manifest.json` and
`.../06-loaded-hud.png`) and compared it against the existing on-disk
screenshots:

| capture | tree | survivor HP | damage numbers on screen | monster shapes |
|---|---|---|---|---|
| `fix-harness-base` (worktree) | `1911d79` unmodified | 20/20 | **86649 / 86649!** | pale, flattened, some floating |
| `fix-harness-f13` (worktree) | fixes 1+3 | 20/20 | **86649 / 86649!** | same |
| `fix-harness-f2` (worktree) | fix 1+2+3 | 20/20 | **86649 / 86649!** | same, now well-separated |
| `fix-harness` / my `review-harness` (worktree, HEAD) | all 4 fixes | 20/20 | **86649 / 86649!** | same, well-separated, green |
| `fix-loaded-hud/head` (sibling worktree) | `1911d79`, confirmed dead by their own instrumentation | 20/20 | 86649 / 86649! | same pale shapes |
| `fix-loaded-hud/ddb1246` (sibling worktree) | pre-regression, confirmed alive | 44/44 | none (idle) | natural creature silhouettes: a standing tusked beast, a hovering drone, etc. |
| `fix-loaded-hud/after` (sibling worktree, their fix applied, horde genuinely alive to the shutter) | fixed | **15/20** | **57767! / 31207!** (different, fresh) | upright, legible, mid-combat poses |

The damage numbers `86649` / `86649!` are identical to the digit across every
worktree capture I have that predates or postdates `c49b730`, including my own
independent re-run — that is the same one-time chain-lightning kill event,
not a coincidence, and it means every one of these captures is photographing
the aftermath of the same death, just from different camera/body positions.
Survivor HP is pinned at 20/20 in every harness-worktree capture (no incoming
damage — consistent with an already-dead horde that cannot attack back), while
the sibling branch's genuinely-alive ending shows the survivor took damage
(15/20) and a completely different pair of damage numbers, because combat was
still live at the shutter. The monster shapes in every harness-worktree
capture are pale, flattened, sometimes airborne debris — consistent with the
`crumble` death animation — never the upright, colored, legible poses seen in
either alive reference.

**5. The check's own contract.** The subject is named `monsters under load`
(`Harness.js:3172`) with `crowdWhy: 'director horde: an unbounded population,
not a fixed cast'` (implied by the identical idiom at `04-combat`,
`Harness.js:2740`) — a live-population claim, not a debris-field claim. A dead,
crumbling ring re-seated into a photogenic band satisfies `minPixels`,
`minObjects` and `sepP50` without satisfying what the subject name promises.

### Conclusion on `c49b730`

The implementer's own commit message says, correctly, "NOT a fix for the pixel
collapse" and that the 2860→~815 px budget drop "is a separate, live defect."
That caveat is honest as far as it goes, but it undersells what actually
happened: the re-seat does not just fail to fix the pixel budget, it **turns a
red gate green by composing a photograph of ten corpses**, and nothing in the
commit, the report, or the manifest says so. `objectFailures: []` and
`subjectsOk: true` now read as "ten monsters, individually legible, under
load" when the true state is "ten crumbling ragdolls, individually legible."
That is the aggregate-hiding-an-absence pattern this project has hit
repeatedly (it is why `toleratedAbsences` exists at all) — except here it is
not an aggregate hiding a few absent objects, it is a liveness gate silently
not gating liveness at all, because nothing in `06-loaded-hud`'s `mustContain`
block ever asked.

The report's own "Scope collision" section notices something is off (fix 2
unexpectedly closed a gate scoped to a parallel agent) but frames the risk as
possible redundancy or a double-move of an already-good number. That
undersells the actual risk: merging `c49b730` as-is ships a gate that will
stay green through any future regression that kills the horde before the
shutter, because it no longer needs the horde alive to pass.

### Recommendation

**Do not merge `c49b730` alone as a fix for 06-loaded-hud.** Two defensible
paths:

- **Merge the sibling branch's health-pin fix first** (it makes the horde
  genuinely alive at the shutter, 2093 px green, 10/10 visible, and it is the
  fix that addresses the actual defect the gate is named for), then decide
  whether `c49b730`'s re-seat is still needed for composition against a
  *live, moving* horde — its `groundAtScreen` band (10–30 m, `sy` rows tuned
  in the report's sweep table) was tuned entirely against a stationary corpse
  pile, and a live horde that keeps walking after being seated may not stay
  where `_seat` put it. That has to be re-measured, not assumed to transfer.
- **Or drop `c49b730` outright** if the pin fix alone reaches an acceptable
  composition, since the re-seat's only demonstrated purpose so far is making
  a dead cast photogenic.

Either way, the harness report's own instinct — "these two branches should not
be merged without re-running the full/`--only` pair together" — is correct and
should be followed, but the re-run needs to check `alive` state at the
shutter, not just pixel/separation numbers, or it will reproduce this same
blind spot.

---

## Fix 1 — only-path enforcement (`ce36333`) — CONFIRMED

- `tools/capture.mjs:220` / `:243` — `onlyPath: true` on `19-overkill` and
  `20-blight-edge`.
- `tools/capture.mjs:443-452` — a full run pushes a `{ skipped:
  'only-path-enforced', why }` entry instead of running `setup`/`mustContain`.
- `tools/capture.mjs:319,324` — `named()` / `WANTED` correctly exclude
  skipped-on-full-run scenarios from the stale-PNG survivors, so an old PNG
  from a previous run does not sit next to a manifest that says the shot was
  skipped. Verified empirically: `ls reviews/round7/captures/fix-harness | grep
  -i "overkill\|blight"` returns nothing.
- **Loud in every consumer view I could find**, verified on my own capture
  (`review-harness/manifest.json`) and the implementer's `fix-harness`:
  - `manifest.shots[].skipped` + `.why` on the shot entry itself
  - `manifest.skippedShots` (top-level array)
  - console `shots` line: `"19-overkill (only-path-enforced)"`
  - console `skippedShots` line: `"19-overkill: only-path-enforced"`
  - **Correctly excluded** from `subjectFailures` (filter requires `s.subject`,
    a skipped shot never gets one — `tools/capture.mjs:497-498`) and from
    `subjectsOkFresh` (same guard, `:516-517`) — so a skip cannot silently read
    as a pass through either of those fields, and cannot silently read as a
    failure either. It is a genuine third state, visible only through
    `skippedShots`/the annotated `shots` line — a reader who only checks
    `subjectsOk`/`subjectsOkFresh` will not know a shot was skipped at all,
    which is a minor readability gap (see Minor findings) but not a
    "skip reads as pass" defect.

**20-blight-edge's own `--only` path is green**, reproduced from
`reviews/round7/captures/only-20/manifest.json`: `subjectsOk: true`, `partial:
true`, `audioOk: true`, `subjectFailures: []`, all four of its checks
(`a deep-band world`, `a blight patch in the world`, `a grown patch rim...`,
`a live fight`) `ok: true`.

**Full run reproduced independently** (`review-harness/manifest.json`):
`subjectsOk: true`, `subjectsOkFresh: true`, `partial: false`, `audioOk: true`,
`subjectFailures: []`, 23 shots, both `19-overkill` and `20-blight-edge`
present only as skipped entries with `only-path-enforced` reasons.

## Fix 2 — see the critical question above. REFUTED.

## Fix 3 — carried stamps (`67999b0`) — CONFIRMED

`tools/capture.mjs:396-398` stamps `carried: true, carriedFrom: prevAt` at the
merge. Reached and verified in all six claimed consumer views, using my own
run of `--only 19-overkill` against the `fix-harness` output directory
(`reviews/round7/captures/fix-harness-partial19/manifest.json`, already on
disk, cross-checked with a script rather than eyeballed):

1. **Shot entry** — `shots.find(s=>s.name==='01-title').carried === true`,
   `.carriedFrom === '2026-08-11T18:26:02.336Z'` ✓ (`:501`)
2. **`subjectFailures`** — carries the flag when a carried shot also fails
   (`:501`); none of the 22 carried entries in this manifest are failing, so I
   additionally confirmed the *field is wired* by reading the code path rather
   than by an example with a red carried shot in this run — the mechanism is
   identical to `toleratedAbsences` below, which I did confirm with live data.
3. **`toleratedAbsences`** — confirmed live:
   `{"name":"04-combat","carried":true,"carriedFrom":"2026-08-11T18:26:02.336Z",...}`
   (`:538`)
4. **`carriedShots`/`freshShots`** — `freshShots: ["19-overkill"]`,
   `carriedShots.length === 22` ✓ (`:514-515`)
5. **Console `shots` line** — `"01-title (carried 2026-08-11T18:26:02.336Z)"`
   confirmed in `f3test.log:17-18` and in the manifest's own `shots` array
   (`:774`)
6. **`subjectsOkFresh`** — `true` in this manifest, honestly describing that
   the one shot actually taken (`19-overkill`) passed, independent of
   `subjectsOk` which (correctly) stays computed over the full merged set.

`subjectsOk` keeps merged-set meaning — confirmed by code
(`tools/capture.mjs:497-505`, no `carried` exclusion in the failure filter)
and by the f3test manifest cited in the report (`subjectsOk: false` off
carried reds, `subjectsOkFresh: true` off the one fresh shot) — I did not
re-run f3test myself but the code path is unambiguous and matches.

## Fix 4 — `vis` travels with `nearer` (`ff9f7ce`) — CONFIRMED

Reproduced independently in `review-harness/manifest.json`:

- `04-combat` `DIAG horde`, object 1 (beetle): `vis: 0, px: 0, nearer:
  {i:13, id:"acolyte", d:12.2, gap:0.038}` — matches the claimed 0.038 exactly.
- object 2 (spitling): `vis: 1, px: 1, nearer: {i:15, id:"mortar", d:22.2,
  gap:0.012}` — matches the claimed 0.012 exactly.
- The gated `survivor unoccluded by the final lens` check carries the same
  fields: `{"vis":1,"boom":7.1,"need":0.6,"visWhat":"ctx.stage only; blind to
  the horde","nearer":null}` — present and correctly `null` when nothing is
  nearer.
- `nearestNearer` (`Harness.js:603-645`) is pure position arithmetic — no
  `ctx.rng`, no `fxRng`, no raycast — confirmed by reading the function.

**Verdict-neutral, worst 4 px, reproduced independently**: diffed
`fix-harness-base/manifest.json` against `fix-harness-f4/manifest.json`
myself (script-based px/verdict diff, not the implementer's numbers copied):
worst movement `04-combat/survivor` 970→966 (**4 px**), no `ok` field flipped
on any check in either manifest, `subjectsOk` stays `false` in both arms.

**RNG-neutrality claim checked against the stated floor, not against zero**:
diffed the identical-tree control pair `fix-harness-f4` vs `fix-harness-f4b`
myself: `04-combat/horde` 10,308→10,378 (**70 px, 0.68%**) — this reproduces
the report's stated same-tree floor exactly. Fix 4's own arm-to-arm movement
(4 px on `04-combat/survivor`, 1 px on any `perPx` member per the report) is
well inside that floor, so the neutrality claim is sound and — per the task's
explicit instruction — I did not certify it on a number *inside* the floor as
if it were proof; the floor itself is what I reproduced and compared against,
using the implementer's own named same-tree pair rather than trusting the
percentage claim on its face.

---

## Test suite

Ran `node tests/run.mjs` myself in the worktree after junctioning
`node_modules`: **43/43 test files passed**, last file's own summary line `41
passed, 0 failed`. Matches the report's claim.

---

## Severity tally

- **1 Critical** — `c49b730` turns `06-loaded-hud` green by re-seating a dead,
  crumbling horde rather than fixing (or disclosing) that the horde is dead;
  the gate's own subject name (`monsters under load`) is no longer true of
  what it certifies, and no check anywhere in `lateRun`'s `mustContain` block
  would catch a regression that kills the horde earlier or later. Merge-
  blocking as submitted.
- **0 Major**
- **1 Minor** — a reader who checks only `subjectsOk`/`subjectsOkFresh` (not
  `skippedShots`) on a full run cannot tell an only-path scenario was skipped
  versus simply absent from the roster; the information exists and is loud in
  the fields designed to carry it, but there is no single boolean a hurried
  caller can gate on that also reflects "N shots were skipped." Not blocking —
  the task's stated bar ("a skipped shot must never read as passing") is met.

---

## Mechanics notes

- `node_modules` junctioned from the main repo into the worktree for the
  session (`New-Item -ItemType Junction`), left in place only for the duration
  of this review's commands — flagging here per instructions so it is
  removable; no bare `npx` was used anywhere in this review.
- Build: `node node_modules/vite/bin/vite.js build`, succeeded, 104 modules.
- Capture: `node tools/capture.mjs --out reviews/round7/captures/review-harness
  --port 5314`, exit 0, matches headline claims.
- All manifests/paths cited above are on-disk and named explicitly; none of
  the numbers in this review were taken from the implementer's prose without
  independently reading the manifest or screenshot they came from.
