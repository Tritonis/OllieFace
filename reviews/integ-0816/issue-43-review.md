# Independent verification — commit 7d08957 (issue #43, four accessibility sliders)

Worktree: `.claude/worktrees/agent-a5d04c22728dd0392`, diff against merge-base `e702ba4`.

## VERDICT
SPEC: REFUTED
QUALITY: NOT READY

## Summary

Three of the four knobs (aberration, bloom, motion) are wired exactly as claimed, following
the `shake` idiom, single producer, defaults reproduce prior behaviour bit-for-computed-value.
The fourth, `flash`, is **not** actually honored at runtime: `VFX.hitFlash` (VFX.js:1317-1363)
correctly scales `emissiveIntensity` by the `flash` setting at spawn time, but the per-frame
decay loop `VFX._updateFlashes` (VFX.js:1678-1699, called every frame from `update()` at
VFX.js:1587) unconditionally lerps `emissiveIntensity` toward the **hardcoded** `3.2` (or the
duplicate literal at VFX.js:1696, ignoring the new `FLASH_INTENSITY` const entirely), discarding
the setting-scaled value within one frame of being set. This is exactly the anti-pattern named
in the issue: one producer honors the control, a second producer for the same effect ignores it.

## Reproduction (VFX.js:1358 vs 1678-1699)

Script run in the worktree (junctioned `node_modules`, deleted after):
```
self = { ctx: { settings: { flash: 0.1 } }, _flashes: [] }
VFX.prototype.hitFlash.call(self, mesh, 0xffffff, 0.06)
  -> intensity = 1.22   (correct: rest 1 + (3.2-1)*0.1)
VFX.prototype._updateFlashes.call(self, 1/60)
  -> intensity = 3.03   (WRONG: nearly full unscaled 3.2, `flash` setting has ~no effect)
VFX.prototype._updateFlashes.call(self, 1/60)
  -> intensity = 2.52   (decays toward rest=1, curve entirely independent of `strength`)
```
At `flash: 0.1` a player should see almost no flash; instead they see ~95% of full brightness
for nearly the whole 60ms duration. The test suite never calls `_updateFlashes`, so this is
invisible to `tests/effect-accessibility.test.mjs` — a guard that is blind to the exact bug the
feature was written to prevent.

## Adversarial checklist results

1. **Diff/idiom check** — `aberration`, `bloom`, `motion` follow the `shake` idiom cleanly, one
   producer each (RenderPipeline.js:485-508, addShake:467-471). `flash` follows it at the write
   site but is overridden by a second, unmodified producer (`_updateFlashes`). REFUTED for flash,
   CONFIRMED for aberration/bloom/motion.
2. **Defaults** — `DEFAULTS` all 1.0 (Menus.js:65-80); `load()` (Menus.js:2400-2424) seeds
   `motion: 0` only when `prefersReducedMotion()` is true AND no stored `motion` key exists;
   `save()` only fires on user interaction (Menus.js:727/736/955/1408), so a returning user is
   re-seeded from the live OS preference on every load until they touch any slider — functionally
   correct accessibility behaviour, matches "stored value wins," but is not literally gated to a
   one-time "first run" flag as the claim's phrasing implies. Minor / documentation nit only.
3. **Test run + mutation** — `node tests/effect-accessibility.test.mjs`: 28/28 pass as claimed.
   Mutation: hardcoded `st?.bloom ?? 1` to `1` in RenderPipeline.js:493 -> exactly the 2 named
   bloom assertions went red (26/28), rest stayed green; reverted, clean 28/28, no working-tree
   diff left. Guard is real for bloom/aberration/motion; **guard is blind for flash's actual
   producer** (see above).
4. **"Bit-for-bit" equivalence claim** — compares computed uniform values (`uAberration`,
   `uVignette`, `bloom.strength`, `shakeAfterKick`), not a rendered frame; not literally
   bit-for-bit pixels, but a legitimate and non-tautological check of the `?? 1` fallback path
   against explicit `1` values across all four keys. Acceptable characterization.
5. **gate:sp** — `npm run gate:sp -- --port 5253` (foreground, worktree): "single-player unchanged
   vs reviews/round7/baseline-00f8900.json — no fields moved." Confirmed.
6. **UI sanity** — sliders rendered generically from the `SLIDERS` array (Menus.js:695-701,
   742-750), so the four new rows are style-consistent by construction. `shake` and `motion` do
   compound (`addShake`: `shakeScale * shake * motion`, RenderPipeline.js:467-471) — this is
   explicit and commented at both the producer and the SLIDERS array (Menus.js:118-121) as
   intentional ("Reduces the *reactive* camera motion — shake, the aberration kick and the
   vignette pulse"), not a silent surprise. Not flagged as a defect.

## Full suite / gates run

- `npm test` in worktree: 79/79 test files passed.
- `npm run gate:sp -- --port 5253`: no fields moved.
- No GPU capture run (excluded per task scope).

## Findings

- **CRITICAL** `src/systems/VFX.js:1696` (and interaction with `:1358`) — `_updateFlashes`'s
  per-frame decay targets the hardcoded `3.2` literal (not `FLASH_INTENSITY`, not scaled by the
  `flash` setting), overwriting the value `hitFlash` correctly computed within ~1 frame. The
  `flash` slider has negligible effect on the actual on-screen hit flash for the ~59ms of its
  60ms duration that isn't the initiating frame.

## Worktree hygiene

`node_modules` junctioned to main install for the mutation/reproduction runs, then unlinked
(`cmd /c rmdir node_modules`, non-recursive). `git status --short` clean at end; no stray files
left in the worktree. Main checkout was never touched.
