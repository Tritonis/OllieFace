# E — Framing for a growing roster

**Nothing was loosened.** Both gates touched in this track were *raised*, and the
framing was changed to pay for them.

- `09-survivors`: per-member floor **800 -> 1000**, aggregate **4000 -> 5000**.
- `11-bestiary`: per-member floor **184 -> 220**, aggregate **3500 -> 4180**.

---

## 1. What was actually failing

The brief's account of the failures did not match the branch. The authoritative
measurement is a full-suite run (`node tools/capture.mjs --out <dir>`, no
`--only`), landed at `reviews/round7/E-baseline/manifest.json`:

| shot | brief says | full-suite baseline |
|---|---|---|
| `09-survivors` | fails, ranger 785 vs 800 | **fails**, ranger 785 vs 800 — confirmed |
| `11-bestiary` | fails, mite 146 vs 184 | **passes**, mite 247 vs 184 |
| `04-combat` | fails per-object | **passes** (`crowd: 8`, floor 113, `ok: true`) |
| `10-inventory` | fails per-object | **passes** (both subjects) |
| `06-loaded-hud` | not mentioned | **fails** — `monsters under load`, object 6 |

Baseline: 21 shots, **2 failing checks** (`09-survivors`, `06-loaded-hud`).

`--only` runs are not comparable to full runs for these shots and this is
documented in the file itself: `bestiary`'s candidate centres are derived from
`ahead(...)`, and the scenario that runs before it relocates the survivor. Run
under `--only 09-survivors,11-bestiary`, bestiary passes with different numbers
again. Every figure below is from a full run.

## 2. The root cause, verified rather than assumed

Both roster shots solve their lens from the *width* of the line-up, so the frame
is exactly as many metres wide as the roster demands. A member's on-screen width
is his own metres over that, so

```
px  ∝ 1 / halfW        area ∝ 1 / halfW²
```

and with a fixed inter-member gap, `halfW` is **linear in the cast size**. Every
existing member therefore loses area as the *square* of the roster.

Checked against the on-disk captures rather than asserted:

- `09-survivors`, 4 at 2.35 m: `halfW` 6.03, weakest predicted ~1240.
  5 at 2.35 m: `halfW` 7.50. `(6.03/7.50)² = 0.647`; `1240 × 0.647 = 802`
  against the **785** measured. The model is the whole explanation.
- `11-bestiary`, 16 cards: ranks of six, `halfW` 6.0. 19 cards: ranks of seven,
  `halfW` 7.2, `tan(hHalf) = 0.719`.

Meanwhile the per-object floor is `minPixels / N`, which relaxes as `1/N`. **The
gate weakens in the same direction the render does, just more slowly.** Adding
content shrinks the cast and lowers the bar the cast has to clear. That is the
structural finding.

### The defect the pixel gate could not see

`11-bestiary` was *passing*, and it was passing while cropping its own roster.
From `E-baseline`, `DIAG roster`: the front rank (7 cards at d = 10–12.3 m)
spans `sx` 0.048–0.975, the **mite's mask box starts at x 0.024 and the
harrier's ends at x 0.999**. Both outer members are clipped at the frame edges.
Meanwhile the back rank held only 5 and used a third of the width
(`ceil(19/3) = 7` puts the overflow in the rank that projects widest).

Clipping removes *some* of a member's pixels, not all, so `perPx` still cleared
a floor that had itself dropped 219 -> 184 for the same reason. Three cards
arrived and the shot quietly started cropping the ends of its roster.

The cause is arithmetic: `halfExtent / (standoff × fill)` measures a 12 m-deep
block's width at its **middle** depth, while the front rank stands 6 m nearer
and subtends more. Predicted screen x **1.001**; measured **0.999**. This is the
same defect the scenario had already fixed on the *vertical* axis ("the vertical
extent is checked rather than hoped for") and left unfixed on the horizontal.

## 3. What changed

All framing, plus two gate **raises**. `src/core/Harness.js` only (and one stale
caption in `tools/capture.mjs`). Every new constant reproduces the shipped,
tuned value at the roster size it was tuned for — these are generalisations of
existing numbers, not new ones.

### `09-survivors`

1. **The row's width is the constant, not the gap.**
   `SPACING = max(MIN_GAP, ROW_SPAN / (N - 1))`, `ROW_SPAN = 7.05`.
   Returns **2.35 exactly at N = 4** — the shipped constant. `MIN_GAP = 1.55` is
   where it stops (two rigs at `radius: 0.75` turned 0.24 rad off-axis need ~1 m
   of air, or the per-object masks start occluding each other). Past the clamp
   the shot goes red rather than quietly shrinking the cast — the floor is
   per-member and does not move to meet it.
2. **Floor authored per member.** `minPixels: PER_SURVIVOR_PX × N`,
   `PER_SURVIVOR_PX = 1000`. Identical at four (`4000/4 = 1000`), stricter above.
3. Stale `the four survivors` label -> `every survivor in the roster`;
   `all four on one footline` -> `the whole roster on one footline`; the doc
   caption in `tools/capture.mjs`; and the live prose in the scenario. Historical
   measurements that say "four" are left alone — they record what was measured.

### `11-bestiary`

4. **Ranks counted from the roster, depth held constant.**
   `rows = ceil(N / 6)`, `rankGap = 12 / (rows - 1)`. Returns **3 and 6 at 16
   cards** — the shipped values. At 19 it gives 4 ranks of 5/5/5/4 instead of
   7/7/5. Holding `BLOCK_DEPTH` is the specific mitigation for the failure a bare
   `rows: 4` was known to cause: at a 6 m gap a fourth rank sits at 25 m, which
   the file records as where members come back fog-washed at `sepP50` 0.15–0.23.
   At 12 m the near rank stays at 10 m and the far at 22 m, so the existing
   separation measurements still describe the frame and the vertical solve is
   untouched.
5. **Composition and correctness separated in the lens solve.** `fill` is a
   preference (share of frame the roster occupies); not cropping is a
   requirement. The composition term is unchanged; a new term asks *each rank at
   its own depth* what half-angle it needs, and the wider wins. It uses the
   card's declared `radius × 1.25` rather than the composition margin's `+1.5` —
   grounded, not guessed: on `E-baseline` the harrier (`radius` 0.55) projected a
   half-width of **0.42 m** at 12.3 m, so the collision radius over-states the
   silhouette. *Applying `fill` and `+1.5` at the near rank was tried first and
   is refuted: it widened the frame 34% and cost every member a third of its
   area (`E-step-ranks`, total 19279 -> 12722).*
6. **End slots go to cards that stand on the ground.** The two ends of a rank are
   the two worst backdrops in the block — everything else has a rank behind it.
   That compounds with the flyer problem the scenario already spends a staging
   decision on. Re-dividing 19 cards moved the wisp (a near-black shell) to an
   end slot and it read `sepP50` **0.13** (`E-step-ranks`) against 0.59 at
   baseline; back inside its rank it is restored exactly, **0.59** (`E-after`).
   Cost, stated:
   left-to-right order *within* a rank is no longer height order. Across ranks it
   still is, and a rank spans a narrow band (front rank 0.5–1.1 m).
7. **Every rank on its own lateral phase.** `row % 2 ? spacing * 0.5 : 0` is
   right for two ranks and degenerates above: at three it re-aligns ranks 0 and
   2, at four it makes two aligned pairs. `stagger(r) = (r / rows) * spacing`
   returns the shipped rule exactly at two ranks. Measured on `E-step-slots`, the
   warden — row 2, in line with row 0, with row 3 four metres behind — read
   `bgLumP50` **36** against 10 at baseline and `sepP50` **0.17** against 0.41:
   photographed against the back rank's bodies instead of ground, and losing
   pixels to the rank in front (3674 -> 2980 in a frame 1.7× tighter). With
   distinct phases it reads **0.29**.
8. **Floor authored per card.** `minPixels: PER_CARD_PX × N`, `PER_CARD_PX = 220`
   — the figure the block above it was already reasoning in ("3500 / 16 = 219").
   Identical at sixteen, stricter above.

## 4. Before / after, per object (full suite)

`reviews/round7/E-baseline` -> `reviews/round7/E-after`.

### `09-survivors` — FAIL -> **PASS**

| | baseline | after |
|---|---|---|
| floor per member | 800 | **1000** (raised) |
| `perPx` | `[785, 1208, 892, 876, 953]` | `[1229, 1685, 1391, 1355, 1340]` |
| weakest | **785** (fail) | **1229** (+57%, 23% over a raised floor) |
| aggregate | 4714 / 4000 | 7000 / **5000** |
| roster box | `0.157–0.864` | `0.170–0.853` |

The weakest member clears by ~a quarter, which is the standard the scenario's own
fill note sets ("clear the floor by a quarter, not by a pixel").

### `11-bestiary` — PASS (cropping) -> **PASS (not cropping, on a raised floor)**

| | baseline | after |
|---|---|---|
| floor per card | 184 | **220** (raised) |
| weakest (`mite`) | **247** | **389** (+57%) |
| aggregate | 19279 / 3500 | 26215 / **4180** |
| min `sepP50` | 0.35 | 0.29 (`warden`) |
| roster box x | `0.024 – 0.999` (clipped both ends) | `0.078 – 0.999` |
| outermost **bodies** | mite 0.024, harrier 0.999 | mite 0.078, beetle 0.964 |

Per-card `perPx` after: `[389, 1435, 1437, 1642, 2167, 1279, 884, 860, 447,
2300, 618, 1393, 711, 3329, 722, 1277, 2727, 2928, 1028]` — all 19 clear 220,
the weakest by 77%.

The residual `0.999` is the **redoubt's translucent shield effect**, not a body;
that unit had a similarly wide box at baseline (`0.393–0.724`). No member's body
is cropped.

### Suite totals

| | baseline | after |
|---|---|---|
| shots | 21 | 21 |
| failing checks | **2** | **1** |
| failing shots | `09-survivors`, `06-loaded-hud` | `06-loaded-hud` |

`04-combat` and `10-inventory` pass in both runs, byte-identical on their gated
numbers. No other shot moved.

## 5. `06-loaded-hud` — separate root cause, pre-existing, not fixed

`monsters under load`: `crowd: 3`, `minPixels: 300`, floor 100. Object 6 reads
`px: 137` (clears the floor) and `sepP50: 0.17` against 0.25. **It is a
separation failure, not a size failure**, so the `1/N²` framing mechanism above
does not apply — and it cannot: `crowd: 3` pins `need` at 3, so this floor does
*not* move when the roster grows.

It also predates the content addition. Across the round-6 captures on disk, with
the same code:

| capture | `06-loaded-hud` |
|---|---|
| `reviews/round6/SHIP` | pass |
| `reviews/round6/reconcile` | pass |
| `reviews/round6/FINAL` | **fail** (object 0, `px: 6`) |
| `reviews/round6/audfix` | **fail** (object 0, `px: 6`) |

A live director population whose members stand wherever the stage puts them,
alternating pass/fail run to run. Diagnosing it means asking why monsters are
failing to stand off their backdrop under a loaded HUD — a contrast question,
not a framing-scale one — and it is a different investigation. **I did not touch
it, and it fails identically before and after this track.**

### One thing I deliberately did not change

The `crowd` ranking selects the best `need` objects **by pixels alone**
(`rank = perPx.map(...).sort(...)`), then gates those on *both* `perPx` and
`perSep`. So a shot can fail while three other members would have satisfied both
claims. Object 6 here is exactly that case: it is 3rd by size and 8th by
separation.

Ranking by both would make this shot green. **That is a relaxation and I did not
do it** — it would let shots pass that fail today, which is the one thing the
file repeatedly forbids. Flagging it as a design question for the owner: if a
crowd's contract is "N of these are individually legible", legibility is two
claims and the selection currently uses one. Resolving that is a decision about
what the contract means, not a fix, and it should be made deliberately.

## 6. Residual risk

- **`warden` at `sepP50` 0.29** (floor 0.25) is the thinnest margin in
  `11-bestiary`. It is one of the two deliberately affixed elites, and its ward
  aura is translucent — a large share of its mask is the effect's own light over
  the background, which drags a *median* separation down by construction. This
  is the same statistic the file already documents for `08-explosion` ("a median
  over that mask reports 0.17 for an explosion a human cannot miss") and solved
  there with `minCarriedPx`. Pixel margin is not the issue (3329 px against 220).
  If this shot goes red again on the warden, the affix is the place to look, not
  the frame.
- **`MIN_GAP` / `PER_RANK_MAX` are cliffs by design.** A sixth survivor hits the
  1.55 m clamp and the row widens again; a 25th card makes a fifth rank and the
  block deepens past 22 m into the fog-wash band. Both fail loudly rather than
  degrade quietly, which is the intent — but they are the next thing to
  re-derive, not to override.

## 7. Verification

- `npm run build` — passes.
- Full suite, no `--only`, three iterations, each landed on disk:
  `E-baseline` (pre), `E-step-ranks`, `E-step-slots`, `E-after` (final).
- The final run (`E-after`) was produced by the exact committed code; only
  comments changed after it.
- The suite is deterministic at seed 1337: `09-survivors` returns
  `[1229, 1685, 1391, 1355, 1340]` identically across all three post-change runs.
