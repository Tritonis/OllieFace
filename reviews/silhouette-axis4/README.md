# silhouette-axis4 — the survivor row, enumerated and gated

Issue **#20** / `docs/superpowers/plans/art-detail-and-cohesion-code-fixes.md` Task 3.
`RUBRIC.md` axis 4 scored 3/10 on the claim that RANGER and ANVIL threshold to the same
shape.

## The finding

**RANGER/ANVIL was already fixed, and a different pair had collapsed unnoticed.**

The readability gate grades 425 pairs — 300 enemy-vs-enemy and 125 enemy-vs-survivor — and
constructed **zero** survivor-vs-survivor pairs. `tools/silhouette.mjs` printed them to
stdout and its own header called that pass "a report" rather than a gate. So the one row
Rule 5 exists for was the one row nothing enforced, and the roster's only silhouette
collision sat in it through four rounds of critics.

Measured on the ten survivor pairs:

| pair | before | after |
|---|---|---|
| `anvil/cinder` | **0.7352** (over the bar) | **0.6836** |
| `anvil/rook` | 0.7006 | 0.6874 |
| `rook/cinder` | 0.6904 | 0.6904 (untouched) |
| `ranger/anvil` | 0.6220 | 0.5977 |
| `anvil/kestrel` | 0.5827 | 0.5652 |

`ranger/anvil` — the pair the rubric named — measured **third lowest of ten** before any
work in this slice. The live collision was ANVIL/CINDER: two rigs independently authored as
wide-crowned inverted triangles of the same height (Anvil's crown from pauldrons, Cinder's
from tanks), which normalise to one silhouette.

## What shipped

Anvil's pelvis dropped 0.80 -> 0.60 with its legs shortened by the same 0.20 m
(`buildAnvil`, `src/entities/CharacterMesh.js`), so the boots stay planted and the rig
becomes genuinely squat: bbox **462x602 -> 462x538**, aspect **0.767 -> 0.859**. The feet
deliberately did *not* widen — that would have walked Anvil into Rook, which is the
wide-based rig. The separation is bought on the one axis Cinder cannot follow, and it
delivers a proportion `buildAnvil`'s own comments claimed ("the legs are a third of this
character", "short, thick and splayed") and the geometry did not.

Every Anvil pair improved and no pair anywhere regressed past a bar. One number moved the
wrong way and is named here rather than omitted: `matron/anvil` (foe/friend) rose
**0.586 -> 0.6368**, against a 0.72 ceiling.

The row is now gated: `maxSurvivorSimilarity: 0.72` in `tools/silhouette-metrics.mjs`, with
**no exemptions**.

## The records

All three produced by `node tools/silhouette.mjs --enemies --json <path>`, renderer
**d3d11** (the real adapter, not SwiftShader), seed **1337**, range **40 m**, 1600x900 for
the enemy pass and 512x768 for the survivor pass.

| file | tree | what it is |
|---|---|---|
| `baseline-d54e4ba.json` | `d54e4ba`, unmodified | The roster **as shipped**. 514 checks, all pass. Has no `survivorPairs` key at all — this is the on-disk proof of the gap. |
| `before-d54e4ba-survivorpairs.json` | `d54e4ba` source, survivor metric added | The same rigs re-measured with the new metric. 523/524: `FAIL survivorSimilarity anvil/cinder 0.7352 vs ceiling 0.72`. |
| `after-anvil-squat.json` | this slice | After the Anvil geometry change. **524/524 pass**, 18 exemptions, all inherited and all on the enemy side. |

The `commit` field of the middle record reads `d54e4ba` and is accurate: only `tools/`
changed between it and the baseline, so the rigs it measured are the shipped ones.

`tests/readability-gate.test.mjs` re-grades `after-anvil-squat.json` offline and asserts
that all `5 choose 2 = 10` survivor pairs are present, so the enumeration cannot silently
shrink.

## Calibration, and its honest weakness

Rule 5 step 6 asks for a bar above the worst undisputed pair and below the known-bad one.
That window is **(0.6904, 0.7352)** — 0.045 wide — and the bar sits at 0.72.

Narrow, because of the metric rather than the roster. The ratified `Similarity` is
`0.6 * IoU + 0.4 * ContourSimilarity`, and the contour term measured **0.947 to 0.981**
across all ten pairs: a spread of 0.034 against IoU's 0.26. Forty per cent of the score is
very nearly a constant, so the scale is compressed into its upper half and **no pair on
this roster, including the collision, ever reached 0.75** — well under the `>= 0.85` fail
band the ratified interpretation table names. That answers the first of #61's two open
questions from a record: the contour term earns little. Re-opening the weights belongs to
**#61**.
