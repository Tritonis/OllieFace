# Review — FIX-blight-glyphs (independent first review)

Worktree: `C:\Users\tpzap\source\repos\OllieFace\.claude\worktrees\agent-ad85d78d99fbfab5e`
Branch: `worktree-agent-ad85d78d99fbfab5e`, reviewed commit: `e3efe97`
Implementer report: `reviews/round7/FIX-blight-glyphs.md` (read, not trusted as evidence)

## Verdicts

**SPEC: CONFIRMED** — the special-case inversion branch is deleted from `itemArt`, the deletion reaches every surface that draws item tiles, item ids and the magenta tier rule are untouched, and independently re-run tests/build/probe reproduce the report's own numbers exactly.

**QUALITY: NOT READY** — one Major finding: the probe's "calibration" gate does not test what its own comment claims it tests (see Claim 4). It is a mathematical tautology, not a proof the instrument can see the historical defect. This doesn't undermine the code fix itself (independently confirmed correct via source review + the probe's substantive, non-tautological gates), but it should not ship framed as the round-6 "instrument calibrated against a known input" requirement, because it isn't one.

## Per-claim verdicts

1. **Diff matches claims (5 files, +320/-82), deletion complete, ids/magenta rule untouched** — CONFIRMED
2. **Deletion reaches all nine `itemArt` call sites** — CONFIRMED
3. **Tests/build/probe re-run independently** — CONFIRMED (exact number reproduction)
4. **Two rewritten gates (hue, chroma floor) would fail on an inverted tile** — PARTIALLY CONFIRMED: hue gate and chroma floor are sound; the separate "calibration" gate is a tautology and proves nothing about detecting the actual historical bug (Major finding)
5. **Tooltip.js:56-58 stays inverted, comment accurate, no other inversion claim remains** — CONFIRMED (at commit `e3efe97`; see environmental note below)

## Findings

### Major

**M1 — The probe's "calibration" gate is a mathematical tautology, not a test of defect-detection.** `tools/menuprobe.mjs` (diff lines around the `stats(px, negate)` helper and the `calibration:` `ok()` call, reviewed via `git diff master...HEAD -- tools/menuprobe.mjs`).

The gate reads:
```js
ok(pol.calib && pol.calib.polarity < 0 && bl.polarity > 0,
  `calibration: the instrument flips sign on an inverted copy of the same tile ...`);
```
and the calibration input is produced by literally negating the RGB channels (`r = 255-r`, etc.) of the *already-shipped, correct* blight tile before computing luma and percentiles — not by reproducing the historical `drawInverted` composite (gradient field + `source-in` black holes + black keyline) that the round-4 critic actually flagged.

Luma is `L = 0.2126r + 0.7152g + 0.0722b`, and these weights sum to exactly `1.0000`. For any pixel, `L(255-r,255-g,255-b) = 255 - L(r,g,b)` exactly. Negation is a strictly decreasing function of luma, so it exactly reverses the percentile ordering of any image's pixels: `p95(negated) = 255 - p5(original)`, `median(negated) = 255 - median(original)`, etc. Substituting into the polarity formula:
```
polarity(negated) = (p95_neg - median_neg) - (median_neg - p5_neg)
                   = (median - p5) - (p95 - median)
                   = -polarity(original)
```
This holds for **any** input image — a correct tile, the historical bug's rendering, a photograph of a cat. It is not contingent on the metric being able to distinguish the real defect from the real fix; it is an algebraic identity of the polarity formula under an involution. The gate is therefore guaranteed to pass regardless of whether the underlying instrument can detect the actual `drawInverted` composite (which is not a pixel negation — it's a different gradient fill plus `source-in`/`destination-over` compositing, so its polarity sign flip, while real, isn't what this gate is measuring).

The report's framing overclaims: "The instrument is calibrated against a known input, per the round-6 standing requirement... An instrument that cannot see the defect it was written to detect is not evidence, and this project has withdrawn three of those." (`reviews/round7/FIX-blight-glyphs.md:88-92`). This specific gate cannot fail, by construction, so it satisfies none of that bar. It should either be removed (the substantive gates below already carry the real evidence) or replaced with a check against a reconstructed/frozen sample of the actual historical `drawInverted` output.

This does **not** invalidate the fix or the rest of the probe. The gates that do carry real evidence — `bl.polarity > 0` compared against three independently-measured, structurally-different control tiers (`equipment 222.4, common 219.7, uncommon 203.1` vs `blight 229.5`), `bl.median < 70` (dark ground, not a field), and the hue/chroma checks against the tier's declared color — are non-tautological and were independently reproduced byte-for-byte by this review (see Verification below). Those stand on their own as evidence the tile is no longer drawn inverted.

### Minor

**m1 — Gate count in the review dispatch ("12 gates green") does not match the diff.** `tools/menuprobe.mjs` diff adds exactly 10 `ok()` assertions for the blight-polarity arm (counted via `git diff master...HEAD -- tools/menuprobe.mjs | grep -c '^+ok('` = 10, and independently by counting the `PASS` lines in both the implementer's report block, `reviews/round7/FIX-blight-glyphs.md:96-108`, and this review's own re-run output below — both show 10). This number originates in the review dispatch text, not in the implementer's own report (which never states a gate count), so it is not attributed to the implementer as a fabrication — but it is inaccurate and worth correcting for anyone relying on it.

**m2 — Pre-existing dead code overlaps the "nine call sites" surface but was correctly excluded.** `src/data/items.js:1869-1915` defines `itemIcon`/`itemIconURL`, a second, wholly separate item-tile renderer (dark plate + radial glow + `tier.css` border + white-stroke glyph with `tier.css` fill — not inverted, and not routed through `Icons.itemArt`). Confirmed via `Grep` for `itemIconURL` and for `from ['"].*data/items` that no file outside `src/data/items.js` imports `itemIcon` or `itemIconURL` — it is unreachable. This function pre-dates this diff and is untouched by it, so it does not undermine the "nine call sites, all through `itemArt`" completeness claim (which is specifically about live draw surfaces), but the report's enumeration doesn't mention it exists. Informational only — no action required unless a future pass wants to delete the dead code.

**m3 — The worktree was concurrently mutated by another process during this review.** After this review's tests/build/probe runs completed with output byte-identical to the implementer's report, `git status --porcelain` unexpectedly showed uncommitted local changes to `src/ui/Tooltip.js` and `tools/menuprobe.mjs` that this review did not make. `git show e3efe97:src/ui/Tooltip.js` confirms the *committed* content still matches the report (the `inverted` branch and its comment are intact at the reviewed commit — Claim 5 is CONFIRMED against that ground truth). The drifted working-tree copy of `Tooltip.js` removes the inversion entirely (`this.refs.name.style.color = meta.color;` with no `inverted` branch), which is not part of commit `e3efe97` and was not present when this review's verification commands ran (confirmed by the exact numeric match in the probe re-run, captured below, before the drift was observed). Flagging this as a process hazard: this specific worktree path is not currently a stable target for further verification runs — another agent appears to be actively iterating in it past the commit under review.

## Verification performed

- `git diff master...HEAD --stat` in the worktree: `5 files changed, 320 insertions(+), 82 deletions(-)` — exact match to report.
- `git diff master...HEAD -- src/ui/Icons.js`: confirmed the `if (resolved === 'blight') { drawInverted(...); return; }` branch is deleted from `itemArt` (was at old `Icons.js:582`), and `drawInverted` (46 lines) is fully deleted, replaced by a comment at `Icons.js:612`.
- Repo-wide `Grep` for `drawInverted|inverted|invert` in `src/`: only comment references remain (`items.js:2871`, `Tooltip.js:53/56`, `Icons.js:612`); no executable code path still inverts a tile.
- `git diff master...HEAD -- src/data/items.js` and `-- src/ui/Tooltip.js`: confirmed comment-only changes; no `id` fields touched; tooltip's inversion logic (`inverted ? ... : ...`) unchanged in code, only its justifying comment rewritten.
- `Grep` for `t-blight` in `src/**/*.css`: rule present and unmodified at `src/ui/hud.css:47` (`--t-blight: #e05aa8;`) and `:622` (`.t-blight { --tc: var(--t-blight); color: var(--tc); }`); `git diff master...HEAD -- src/styles` / `hud.css` shows no changes — magenta rule confirmed untouched.
- `Grep` for `itemArt\(|equipmentArt\(` across `src/`: found exactly the 9 `itemArt(...)` call sites the report lists (`HUD.js:329,461`; `Menus.js:990,1055,1079,1563,1600`; `Logbook.js:684,785`) plus the 2 `equipmentArt(...)` call sites (`Menus.js:948`, `HUD.js:836`) that forward through `itemArt(id, 'equipment')` — matches the report's enumeration exactly, independently derived (`.codegraph/` is not present in the worktree, so this was grep-verified rather than codegraph-verified; `.codegraph/` does exist in the main repo but not the worktree).
- Read `itemArt` source (`Icons.js:574-610`): confirmed `resolved = item.tier || tier`, so tier is item-intrinsic-first; `equipmentArt`'s hard `'equipment'` default is only ever overridden by an item's own `.tier`, which equipment entries don't carry as `'blight'` — the "can never be blight" claim holds for legitimate equipment ids.
- Environment: worktree had no `node_modules`; created `New-Item -ItemType Junction` to the main checkout's `node_modules`, ran verification, then removed the junction (`Remove-Item -Force`) — confirmed removed (`Test-Path` → `False`) before finishing.
- `node tests/run.mjs`: **41 passed, 0 failed / 43/43 test files passed** — exact match to report.
- `node node_modules/vite/bin/vite.js build`: **succeeded** (`built in 768ms`, no errors) — matches report's "build is green" claim (bare `npx` was not used).
- `node tools/menuprobe.mjs --port 5308 --out reviews/round7/captures-review/fix-blight-glyphs`: all gates passed, **10** `PASS` lines for the blight-polarity arm, numbers byte-identical to the report's own re-run:
  ```
  PASS  the blight tile was sampled (2398 px inside the plate)
  PASS  control tiers sampled for comparison (equipment, common, uncommon)
  PASS  calibration: the instrument flips sign on an inverted copy of the same tile (shipped 229.5 -> negated -229.5)
  PASS  the blight tile is a bright emblem on a dark plate (polarity 229.5)
  PASS  every control tier has the same polarity (equipment 222.4, common 219.7, uncommon 203.1)
  PASS  the blight plate is dark ground, not a magenta field (median luma 16.8)
  PASS  the blight glyph carries the tier magenta (hue rgb 215,81,159)
  PASS  and it is the declared tier colour, saturated (chroma 134, off #e05aa8 by 9)
  PASS  the magenta tier rule survives (.t-blight color rgb(224, 90, 168))
  PASS  the HUD strip and the pause summary draw the identical blight art (6162 chars)
  ```
  (used port 5308 per instructions, distinct from the report's 5306; captures + the temporary output directory were deleted after the run, along with the build's `dist/` output, to leave the worktree clean of this review's artifacts).

## Severity counts

Critical: 0, Major: 1, Minor: 3

Tests: 41/41 passed (43/43 test files) — independently reproduced, matches claim.

---

# Re-review — commits `aaa5bdd` and `825c4ce`

Scope of this section only. `e3efe97` was reviewed above and is not re-reviewed here. Branch now: `e3efe97` -> `aaa5bdd` -> `825c4ce` (HEAD, worktree clean at time of writing).

## Verdict for the whole branch

**CONFIRMED — merge-ready.** Both new commits do exactly what they claim, independently re-verified. `aaa5bdd` closes the tooltip inversion by deletion, which structurally closes the element-reuse hazard (not just handles it). `825c4ce` correctly replaces the M1 tautology with a byte-exact reconstruction of the actual deleted `drawInverted` composite, verified against that function's real source rather than the report's description of it. Tests, build, and the extended probe all reproduce the report's numbers exactly, including the shipped-tile numbers staying bit-identical across all three commits. No new findings above Minor.

## Per-claim verdicts (the two new commits)

1. **`aaa5bdd`: the `inverted` branch and its three inline styles are fully deleted from `Tooltip.js:49-60`, no stale comment or styling survives** — CONFIRMED
2. **`aaa5bdd`: the element-reuse hazard (stale background/padding leaking onto a later card) is actually closed** — CONFIRMED, and closed more strongly than "handled": the fix removes the only two lines in the entire file that ever touched `.style.background` / `.style.padding` on the tooltip, so there is no longer any code path, in any tier or hover order, that can set them
3. **`aaa5bdd`: extended probe's 4 new tooltip gates are real and pass** — CONFIRMED, independently re-run
4. **`825c4ce`: the reconstruction faithfully rebuilds what `drawInverted` produced** — CONFIRMED, checked against the deleted function's actual source, not the report's paraphrase of it
5. **`825c4ce`: the new gates would fail on the tautology this review caught (M1)** — CONFIRMED by inspection of the diff (the negation code path no longer exists at all)
6. **`825c4ce`: 16 arm gates green, shipped-tile numbers bit-identical across all three commits, 43/43 test files, build green** — CONFIRMED, independently re-run
7. **The report's self-corrected per-commit gate counts (10 / 14 / 16) are now accurate** — CONFIRMED

## Verification performed

### `aaa5bdd` — tooltip chip deletion

- `git diff aaa5bdd^..aaa5bdd -- src/ui/Tooltip.js`: confirmed the `const inverted = (def?.tier || tier) === 'blight';` line and both ternaries on `background`/`padding` are deleted; `this.refs.name.style.color = meta.color;` is now unconditional. Comment rewritten to describe the deletion, not the old inversion.
- `Grep` for `refs.name.style|refs.tier.style|tip-name|background|padding` in `src/ui/Tooltip.js` (current, `825c4ce`): only `this.refs.name.style.color` and `this.refs.tier.style.color` remain — no code path anywhere in the file sets `background` or `padding` on any tooltip ref, for any tier. This is the actual mechanism that closes the reuse hazard: it isn't that the old branches now correctly clear to empty string (fragile, order-dependent), it's that the property is never touched, so there is nothing to leak regardless of what tier was hovered previously.
- `Grep` for `tip-name` in `src/ui/hud.css`: `.tip-name { font-size: 1.25em; font-weight: 700; letter-spacing: 0.1em; }` (line 1354) — no CSS `background`/`padding` rule on `.tip-name` either, so the element's computed background is transparent by default, consistent with the probe's `getComputedStyle` gate expecting `rgba(0, 0, 0, 0)`.
- One coverage gap, not a defect: the probe hovers a common tile, then later hovers only the blight tile — it doesn't hover a *third*, non-blight tile immediately after blight to empirically confirm no leak in that direction. Given the structural finding above (no code path sets these properties under any tier), this is unnecessary to prove correctness, but it would be a slightly stronger regression guard if `background`/`padding` logic were ever reintroduced for some other tier in the future. Not blocking (see m4 below).

### `825c4ce` — real calibration

- Pulled the actual deleted `drawInverted` source via `git show e3efe97^:src/ui/Icons.js` and the `mix()` helper it depends on (`export function mix(a, b, t) { ... return rgb(A + (B-A)*t) ... }`, same file).
- Computed the two field-gradient stops and the hole colour by hand from that source and the real tier constants (`blight.color = '#e05aa8'` = rgb(224,90,168), `blight.plate = '#26101c'` = rgb(38,16,28)):
  - `mix('#e05aa8', '#ffffff', 0.10)` = rgb(227, 106.5 rounds to 107, 176.7 rounds to 177) → rgb(227,107,177)
  - `mix('#e05aa8', '#26101c', 0.45)` = rgb(140.3 rounds to 140, 56.7 rounds to 57, 105) → rgb(140,57,105)
  - hole = `#05070a` → rgb(5,7,10)
  - All three are **byte-exact matches** to the reconstruction's hardcoded `HIST = { hole: [5,7,10], top: [227,107,177], bot: [140,57,105] }` in `tools/menuprobe.mjs`. This is not an approximation — the reconstruction uses the real, hand-verified output colours of the deleted function.
- Read the reconstruction logic (`tools/menuprobe.mjs`, `reconstruct()`): it takes the *shipped* tile's own rendered pixels, uses the same `luma > ground + 20` threshold the rest of the arm already uses to classify "marked" (glyph) vs "unmarked" (background) pixels — a faithful proxy for the glyph mask, since `drawGlyph` draws the identical stroke geometry in both the historical and corrected renderers, only the composite differs — then paints marked pixels flat `HIST.hole` (matching `source-in` flooding every glyph pixel to plate black) and unmarked pixels the vertical `HIST.top` to `HIST.bot` gradient by `y/S` (matching `destination-over`'s linear gradient fill). This correctly reconstructs the spatial structure of the historical composite from real geometry, not a synthetic transform.
- Confirmed the negation code (`if (negate) { r = 255-r; ... }`) is **entirely gone** from the current `stats()`/`read()` functions — the tautology this review caught cannot recur by accident; the diff also adds a third gate (`Math.abs(pol.calib.polarity + bl.polarity) > 1`) whose explicit purpose is to fail if a negation is ever reintroduced (a negation would force `calib.polarity === -bl.polarity`, i.e. the sum to 0, which this gate rejects).
- Re-ran the full probe against `825c4ce` (junctioned `node_modules`, port `5308`, confirmed free via `netstat -ano | grep ":5308"` before running, removed the junction afterward) and reproduced every number exactly:
  ```
  PASS  calibration: the instrument scores the historical drawInverted composite as inverted (polarity -43.6 vs shipped 229.5)
  PASS  calibration: and scores its field as bright ground, failing the dark-plate gate (median luma 88.6 vs shipped 16.8, gate is < 70)
  PASS  calibration is a rebuilt composite, not a negation of the shipped tile (|-43.6 + 229.5| = 185.9, a negation would give 0)
  ```
  Sanity-checked the sign and rough magnitude by hand: the field-gradient luma runs roughly 78 (bottom stop) to 138 (top stop), the hole luma is roughly 6.8 — with the field dominating tile area and the holes dragging the low percentile down hard, `(p95-median)` stays small (bounded by the field's own gradient range) while `(median-p5)` is large (median sits well above the near-black holes), giving a negative polarity of plausible small-to-moderate magnitude — consistent with the observed -43.6 and clearly not a coincidental negation of 229.5.
- Full probe run (all arms) on `825c4ce`: **27 total PASS lines** — 11 pre-existing (picker/pause, untouched by round 7), 12 in the blight-tile arm (10 original + 2 net new from the calibration rewrite: one old gate replaced by three new ones), 4 in the tooltip arm — **16 blight-related gates**, matching the coordinator's and the report's own corrected count exactly.
- `node tests/run.mjs`: **41 passed, 0 failed / 43/43 test files passed** — exact match, re-run against `825c4ce`.
- `node node_modules/vite/bin/vite.js build`: succeeded (`built in 9.31s`, only the pre-existing chunk-size warning, no errors).
- Confirmed shipped-tile numbers are bit-identical across three independent full-probe runs spanning `e3efe97`, `aaa5bdd`, and `825c4ce` (this review ran the probe at each stage): blight polarity 229.5, median 16.8, hue rgb(215,81,159), chroma 134 — unchanged throughout, corroborating the report's "did not disturb the first fix" claim.
- Report self-correction (`reviews/round7/FIX-blight-glyphs.md`, "Third commit" section): confirmed the report now states "The arm carried ten gates after the first commit and fourteen after the second. It carries sixteen now, after the third," replacing the earlier inaccurate "16/16" — this matches this review's independent count at every stage (10 / 14 / 16).

## Process note (carried forward from the first pass, now resolved)

The first pass of this review flagged (m3) that the worktree was being concurrently mutated mid-review by another agent. That mutation is what became `aaa5bdd` and then `825c4ce`, landed as proper commits with an updated report rather than left as drifting uncommitted state. The coordinator's scoped re-review dispatch confirms this was intentional handoff, not an uncontrolled collision — no outstanding hazard. The worktree was clean (`git status --porcelain` empty) both before and after this section's verification commands.

## Findings (this section)

No new Critical or Major findings. One informational note carried over: m3 from the first pass is superseded/resolved as described above — not counted again here.

**Minor (new): m4 — probe doesn't test the hover-order direction that would empirically catch a future regression of the reuse hazard.** `tools/menuprobe.mjs`'s tooltip arm hovers a common tile, then independently hovers the blight tile; it never hovers a non-blight tile immediately after blight to assert no residual `background`/`padding` on the following card. Not a defect today (the structural fix removes the property-setting code entirely, so no order can leak anything), but if `background`/`padding` logic is ever reintroduced on this element for an unrelated reason, this specific ordering wouldn't be caught by the current arm. Optional strengthening, not blocking.

## Severity counts (cumulative, whole branch)

- First pass (`e3efe97`): Critical 0, Major 1 (M1, resolved by `825c4ce`), Minor 3
- This re-review (`aaa5bdd`, `825c4ce`): Critical 0, Major 0, Minor 1 (m4, new)
- **Outstanding at HEAD (`825c4ce`): Critical 0, Major 0, Minor 4** (m1 dispatch-text gate-count note and m2 dead-code note from the first pass are historical/informational and don't block; m3 is resolved; m4 is new and optional)

Tests: 41/41 passed (43/43 test files) at `825c4ce` — independently reproduced, matches claim.
