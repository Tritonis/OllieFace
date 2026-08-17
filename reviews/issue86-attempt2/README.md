# Issue #86, attempt 2 — the straddle does not reproduce

Attempt 1 tuned the declutter band 30 -> 25 m on partial (`--only 04-combat`) evidence and was
refuted at integration (merge `d095573`, revert `959bee4`): in the full-run regime that change moved
the weakest gated horde member 0.29 -> 0.25, i.e. onto the floor it was meant to lift it off.

Attempt 2 therefore began by testing the premise rather than the fix.

## Method

Four consecutive **full** `npm run shots` runs (`node tools/capture.mjs --out ... --port 5241`) on an
unchanged tree at `959bee4`. No `--only`. Manifests are committed here; the PNGs were deleted before
committing, so nothing in this directory is an image — cite the numbers, not a picture.

| run | `04-combat::horde` `worstGatedSep` | `sepP50` | horde px |
|---|---|---|---|
| `pre1` | 0.29 | 0.41 | 10420 |
| `pre2` | 0.29 | 0.41 | 10420 |
| `pre3` | 0.29 | 0.41 | 10459 |
| `pre4` | 0.29 | 0.41 | 10420 |

The gated set's separations were byte-identical across all four:
`[0.35, 0.33, 0.31, 0.29, 0.51, 0.65, 0.31, 0.45]`.

## Finding

The exemption's note claims the value is *boundary-flaky* — "0.25 / 0.29 on two unchanged runs" —
and that flakiness is the whole argument for the entry existing. On this box it is not flaky. Ten
full runs are now on record at 0.29 (these four, plus the six the integration review of attempt 1
found) against a single 0.25.

That one 0.25 is real but old: `reviews/gate-margin/baseline/manifest.json` predates the
`worstGatedSep` field entirely (it has no such key; the 0.25 is recoverable only by re-deriving the
top-8-by-pixel-count slice by hand, which this attempt did to confirm it). It is a 23-shot run from
a tree on which `19-overkill` and `20-blight-edge` still executed rather than being only-path
skipped. It is not evidence about the tree as it stands.

## Recommendation (not applied here)

Retire `04-combat::horde` from `SEP_MARGIN_EXEMPTIONS` (`src/core/Harness.js`). At 0.29 the subject
clears the 0.27 margin bar by exactly the 0.02 that #81 requires, so the exemption is currently
admitting a value that does not need admitting — and an exemption around a subject that clears its
own margin is, in the words of the neighbouring #85 note, "a silence, not a record".

Retiring it is a decision about the exemption table, so it is left to the controller. Deleting the
entry would also require updating `tests/sep-exemptions.test.mjs`, which guards the table.

The residual risk is the one the note names: if the 0.25 regime is a property of some machine or
driver state this box is not currently in, retiring the entry moves the horde from exempt to red on
that machine rather than to a warning. Four runs at one sitting cannot distinguish "stable" from
"stable today". A cross-boot run is the cheap way to buy that.
