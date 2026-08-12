# Acolyte Silhouette Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close round-9 readability Finding 3 (`reviews/round9/README.md`): `brood/acolyte` familyIoU reads 0.7966 against the 0.78 ceiling — the two tier-2 casters are nearly the same shape when flattened — and rides an exemption in `tools/silhouette-metrics.mjs:215`. Give the acolyte a distinguishing silhouette feature, remove the exemption, and prove it with the gate.

**Architecture:** The change goes on the **acolyte**, not the brood — `buildBrood` is shared with the Rift Anchor finale unit (`src/data/enemies.js:1168`, `meshFactory: 'brood'`), a blast radius this slice refuses. The acolyte (`buildAcolyte`, `src/entities/EnemyMeshes.js:2724-2783`) is a robed support healer; it gains a tall thin **crook-staff** held off its right shoulder — a vertical spike above the hood plus lateral asymmetric mass, which is precisely what survives bbox-normalised flattening (the brood is radially symmetric; the staff breaks both the shared aspect and the shared mass distribution). The staff merges into the existing `'aco.robe'` dark merge — zero new draw calls, no new materials, animates with the robe group. This is measurement-driven content work: the committed gate (`tools/silhouette.mjs` → `reviews/round9/readability-gate.json`, re-graded on every `npm test` by `tests/readability-gate.test.mjs`) is the acceptance instrument, and the plan specifies the iteration protocol rather than pretending the first geometry numbers are final.

**Tech Stack:** THREE geometry via the file's own primitive helpers (`P`, `cyl`, `ring`, `box`, `merged`); `tools/silhouette.mjs --enemies` on d3d11; `tools/capture.mjs` + `tools/shotdiff.mjs` for scene-level evidence.

## Global Constraints

- **Gameplay untouched:** no change to `src/data/enemies.js` cards, no collision/height/radius fields, no animation logic (`animAcolyte` untouched — the staff lives in the static robe merge). `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` must show **exactly** the pre-existing two-field lemurian→skink rename set (adjudicated 2026-08-11, see the overkill-retune slice ledger) and `npm run gate:elite` must be clean.
- **The gate's thresholds are the design intent and no threshold moves** (`READABILITY` in `tools/silhouette-metrics.mjs`). The brood/acolyte exemption is REMOVED, not retuned. No other exemption may be added, removed, or edited.
- **The record protocol** (`reviews/round9/README.md` is the spec for it): silhouette runs on **d3d11** (never `--software`), seed 1337, the committed `readability-gate.json` is regenerated in place and `tests/readability-gate.test.mjs` re-grades it in `npm test`.
- **Bash tool is ASCII-only** — file content via Write/Edit only. **Never bare `npx`.** `tools/silhouette.mjs` has NO `--port` flag (it hardcodes 5201 and manages its own server — make sure nothing else is on 5201); capture uses `--port 5219`.
- **Commit style:** single evocative sentence + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` as a second `-m`.

---

### Task 1: The staff, the gate, and the exemption's removal

**Files:**
- Modify: `src/entities/EnemyMeshes.js:2724-2783` (`buildAcolyte` — additions to the `'aco.robe'` merged list only)
- Modify: `tools/silhouette-metrics.mjs:215` (delete the one exemption line)
- Regenerate: `reviews/round9/readability-gate.json` (via the tool, never by hand)

**Interfaces:**
- Consumes: the file's own helpers exactly as `buildAcolyte` already uses them: `P(geom, x, y, z, rx, ry, rz, sx, sy, sz)`, `cyl(rTop, rBottom, h, seg)`, `ring(r, tube, segA, segB)`, `box(w, h, d)`, `merged(key, parts)`.
- Produces: an acolyte whose mask familyIoU vs brood measures **< 0.78**, all other 513 checks no worse than the committed record's values.

- [ ] **Step 1: Baseline the record's current state**

Run `git log -1 --format=%H reviews/round9/readability-gate.json` and `node -e` to print the committed `brood/acolyte` familyIoU value (0.7966 expected) and the full check-count summary (514/514 with 19 exemptions). This is the before; the round-9 README already documents it.

- [ ] **Step 2: Add the staff geometry (starting values — the gate iterates them)**

In `buildAcolyte`, append to the `'aco.robe'` merged array (the `dark` material — the robe's own):

```javascript
    // The crook-staff is the acolyte's silhouette signature (round-9 Finding 3:
    // at bbox-normalised scale the acolyte and the brood sac flattened to the
    // same hunched mass, 0.7966 IoU against a 0.78 ceiling). A tall thin spike
    // off one shoulder plus a hooked head is asymmetric mass the brood's radial
    // body cannot mimic. Static in the robe merge: no new draw call, no new
    // material, sways with the body.
    P(cyl(0.05, 0.07, 2.6, 5), 0.66, 1.3, 0.12, 0, 0, -0.06),
    P(ring(0.17, 0.05, 4, 10), 0.74, 2.62, 0.12, 0, 0, -0.4),
    P(box(0.16, 0.1, 0.1), 0.6, 2.4, 0.12),
```

(Staff shaft ~2.6 m rising well above the 2.0 m hood; hooked ring head; a small collar where hand-height would be.)

- [ ] **Step 3: Remove the exemption**

Delete the single line at `tools/silhouette-metrics.mjs:215`:
```javascript
  { id: 'brood/acolyte', kind: 'familyIoU', value: 0.7966, note: 'two hunched tier-2 casters at near-identical normalised posture' },
```
Touch nothing else in the exemptions list or `READABILITY`.

- [ ] **Step 4: Run the gate; iterate the staff if needed (max 3 iterations, all disclosed)**

Run: `node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json`

Acceptance, read from the tool's own output and the regenerated JSON:
- `familyIoU brood/acolyte` **< 0.78** (exemption gone, so the tool itself goes red otherwise);
- exit 0 overall — i.e. **no other check regressed past its bar**: watch specifically acolyte's own `px40` (grows — good), `holes`, and every `acolyte/*` and `*/acolyte` familyIoU pair (a staff must not collide the acolyte into `vizier`, `warden`, or another caster) and `foeFriendIoU` vs the five survivors;
- **514/514 checks with 18 exemptions** expected in the summary (removing an exemption removes no check — the brood/acolyte check remains and must now clear the raw 0.78 bar).

If brood/acolyte lands ≥ 0.78: scale the staff (longer shaft, larger hook, or move it further off-axis — lateral offset does more than length at normalised scale) and re-run. **Maximum 3 geometry iterations; record every iteration's measured IoU in the report.** If 3 iterations cannot clear 0.78, STOP and report BLOCKED with the numbers — the fallback (a brood-side change) has a blast radius that needs the controller's decision, not an improvisation.

If any OTHER pair goes red: reshape rather than shrink (the failure mode is the staff reading as another unit's signature), and disclose.

- [ ] **Step 5: The suite re-grades the committed record**

Run: `node tests/run.mjs`
Expected: all pass — `tests/readability-gate.test.mjs` re-grades the regenerated JSON against the live `READABILITY` (18 exemptions) and must agree with the stored checks.

- [ ] **Step 6: Simulation gates**

- `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` → exactly the adjudicated two-field lemurian→skink set, nothing more.
- `npm run gate:elite` → `no fields moved`.
(A mesh factory cannot move either — this is the proof, not an assumption.)

- [ ] **Step 7: Commit**

```bash
git add src/entities/EnemyMeshes.js tools/silhouette-metrics.mjs reviews/round9/readability-gate.json
git commit -m "The acolyte takes up its crook, and stops being mistaken for a sac"
```

---

### Task 2: Scene-level evidence and the record

**Files:**
- Create: `reviews/acolyte-silhouette/README.md`
- Modify: `reviews/round9/README.md` (close Finding 3 with a pointer, in the same idiom as Finding (a)'s closure)

**Interfaces:**
- Consumes: Task 1's regenerated gate record and its measured IoU numbers.

- [ ] **Step 1: Full-library capture pair + noise control**

Three full runs, all d3d11, all into the scratchpad (PNG trees are ~40 MB, not committed; manifests are kept):

```
# after (this tree)
node tools/capture.mjs --out <scratchpad>/shots-aco-after --port 5219
# before: a throwaway git worktree at the slice base commit (the commit BEFORE Task 1's)
node tools/capture.mjs --out <scratchpad>/shots-aco-before --port 5219
# noise floor: a SECOND capture of this tree
node tools/capture.mjs --out <scratchpad>/shots-aco-after2 --port 5219
```

(Before-tree route — checkout-restore, the primary route (a worktree has no `node_modules` and installing one is forbidden here): `git checkout <base> -- src/entities/EnemyMeshes.js`, run the before-capture from the main checkout, then `git checkout <head> -- src/entities/EnemyMeshes.js` to restore; verify restoration with `git status --short` (clean) before the after-runs. Only `EnemyMeshes.js` differs at the base for capture purposes — `silhouette-metrics.mjs` and the JSON record do not affect capture. NEVER run npm install/npx anywhere in this flow.)

Gates:
- **Subject-failure sets identical across all three runs.** Pre-registered expectation on a FULL run: exactly `{19-overkill}` (red by construction on full runs — it begins from a dead run; documented in `reviews/round9/README.md`). `06-loaded-hud` was fixed by the horde merge earlier on 2026-08-11 — if it appears red, that is a REGRESSION to stop and report, not baseline. The acolyte is a gated subject in no scenario (recon-verified); any other difference in the failure set is a real regression, stop and report.
- `node tools/shotdiff.mjs <after> <before>` vs `node tools/shotdiff.mjs <after> <after2>`: every cross-tree per-shot figure attributable to the acolyte's presence must be called out; shots with no acolyte on screen must sit within the same-tree noise envelope. Save both shotdiff outputs and all three manifests under `reviews/acolyte-silhouette/`.

- [ ] **Step 2: Write the record**

`reviews/acolyte-silhouette/README.md`, in the round-9 idiom: commands, ports, commit measured, renderer; the before/after IoU (0.7966 exempted → measured value, exemption removed, 18 remain); every staff iteration's numbers if Task 1 iterated; the capture-pair table (cross-tree vs same-tree noise per shot); what did NOT change (gameplay card, animation, draw calls — one merged geometry grew) with the covering evidence (sp-equivalence/gate:elite lines, merged-geometry argument); honest limitations (one pose, one angle — the gate's own caveat; the staff is unmeasured during attack windup).

In `reviews/round9/README.md`, under Finding 3, append the closure sentence pointing at the slice and record.

- [ ] **Step 3: End-of-slice gate re-run (record provenance)**

Task 1's regenerated record stamped `commit` at the pre-staff tree (the tool ran before the commit existed). Re-run `node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json` at the final HEAD and verify with `git diff --stat reviews/round9/readability-gate.json` that **only the `commit` field moved** — every measured value and every check verdict byte-identical (the round-9 README's own precedent for this exact situation). Include that diff summary in the record README. If anything beyond `commit` moves, the run is nondeterministic or the tree changed — stop and report.

- [ ] **Step 4: Final battery + commit**

`node tests/run.mjs` green, then:

```bash
git add reviews/acolyte-silhouette/ reviews/round9/README.md
git commit -m "The record shows the crook doing its work at forty metres"
```
