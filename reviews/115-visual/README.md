# #115 visual before/after — camera framing (SOFT_HOLD_TAU)

Produced because the capture gate's pass/fail verdict is not stable across boots for this change
(same code, same tau, different failing sets on different runs), and `worstGatedSep` is a minimum
over a subject set whose membership moves with framing. A human is judging these images directly.

Both sets are **FULL** `npm run shots` runs (no `--only`) — partial runs are a different regime
and are not comparable to full-run failure sets.

Date captured: 2026-08-18/19.

## AFTER — `src/core/CameraRig.js` as of `b4a60fa` (SOFT_HOLD_TAU = 0.55)

- Source: pre-existing `shots/` output from a full run at `b4a60fa`, copied before any new capture.
- Manifest `commit` field: `b4a60fa18d07b628d02332b089789669e0bce255`
- `subjectFailures`: `04-combat`, `06-loaded-hud`, `08-explosion`

## BEFORE — `src/core/CameraRig.js` as of `1afdada` (pre-#115, `SOFT_HOLD_TAU` did not exist)

- Source: `git checkout 1afdada -- src/core/CameraRig.js`, then a fresh full `npm run shots` run
  against the rest of the tree at `b4a60fa` (only `CameraRig.js` was swapped).
- `subjectFailures`: `11-bestiary`

## Files

- `after/*.png`, `after/manifest.json` — AFTER set (21 PNGs + manifest)
- `before/*.png`, `before/manifest.json` — BEFORE set (21 PNGs + manifest)

## Note on the shot count

21 PNG files per full run (`13-biomes` yields 4 frames `13-biomes-1..4` instead of one), covering
all 23 configured shot subjects. This matches the shipped `tools/capture.mjs` shot list at `b4a60fa`.

## Working tree afterward

`src/core/CameraRig.js` was restored to `HEAD` (`git checkout HEAD -- src/core/CameraRig.js`) and
`git status --porcelain -- src/` was confirmed empty; `SOFT_HOLD_TAU = 0.55` is back in place.
