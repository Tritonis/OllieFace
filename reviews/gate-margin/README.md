# Provenance for `reviews/gate-margin/`

Evidence for the ratified margin rule (`SEP_MARGIN`, `src/core/Harness.js`). Lane B, port 5251,
d3d11, 2026-08-16. **Two of these five runs were produced with a fault deliberately injected into
the harness and are not measurements of the game.** They are here because a gate observed only
green is not evidence of anything.

| Directory | Command | Tree |
|---|---|---|
| `baseline/` | `node tools/capture.mjs --out reviews/gate-margin/baseline --port 5251` | clean `master` (4d8c619), before the rule |
| `rule-on/` | `node tools/capture.mjs --out reviews/gate-margin/rule-on --port 5251` | with the rule and its two exemptions |
| `plant-a/` | `node tools/capture.mjs --out reviews/gate-margin/plant-a --port 5251 --only 03-thirdperson` | **FAULT INJECTED** — per-pixel separation clamped to 0.15 |
| `plant-b/` | `node tools/capture.mjs --out reviews/gate-margin/plant-b --port 5251 --only 03-thirdperson` | **FAULT INJECTED** — per-pixel separation clamped to 0.25 |
| `plant-b-exempt/` | `node tools/capture.mjs --out reviews/gate-margin/plant-b-exempt --port 5251 --only 08-explosion` | **FAULT INJECTED** — same 0.25 clamp |

The injection was one line, in the histogram accumulation of `subjectReport`'s `count()`:
`const c = Math.min(Math.abs(a - b) / (a + b + 8), LIMIT)`. It was reverted before this commit;
`grep PLANT src/core/Harness.js` returns nothing.

What each plant demonstrates:

- **`plant-a`** — a real regression: `03-thirdperson` -> `survivor` drops under the floor itself,
  the run goes red and names the subject (`why: "illegible"`, `sepP50 0.15`, `needSep 0.25`).
- **`plant-b`** — a *margin* violation and nothing else: the same subject reads `sepP50 0.25`
  against `needSep 0.25` — the floor is met — and the run is red on `needSepWithMargin 0.27`,
  with `why: "no margin: over the floor but not clear of it by SEP_MARGIN"`. This is the
  issue-#69 shape, caught.
- **`plant-b-exempt`** — the exemption is scoped, not a switch. Under the same clamp, in the same
  frame, `08-explosion` -> `monsters standing in it` goes red on margin (`thinObjects` names the
  two gated members) while its exempted sibling `damage numbers` stays green.

`baseline/` and `rule-on/` carry the same single pre-existing failure — `11-bestiary` -> `the
whole spawn roster`, declared object 13 at `sepP50 0.17` against the 0.25 floor. That is on
`master` before this branch touched anything and is not a margin failure.
