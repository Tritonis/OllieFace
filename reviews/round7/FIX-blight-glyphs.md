# FIX — Blight glyph polarity

Closes `reviews/round6/HANDOFF.md` "Open" item 4, the escalation that was awaiting
a decision. The decision (user, 2026-08-11) took the handoff's own recommendation:
route Blight through the ordinary `itemArt` path so its tiles are no longer
inverted, and let the magenta tier rule carry findability on its own.

## What the defect was

The corruption tier drew its tiles as the photographic negative of every other
tile in the build: the tier colour as a solid field with the glyph punched out of
it in the plate's own black, and a black keyline instead of a coloured one. That
was deliberate — a corrupted item had to be findable in a strip of eighty tiles
without adding an element to the strip, and `10-inventory` is the project's
worst-scoring shot precisely because it is already dense.

The round-4 UI critic scored it as an axis-4 silhouette failure. It was right for
the reason the author was right: the build's rule is "bright emblem on a dark
plate, tier carried by hue", and the one tier that reversed the relationship read
as a hole in the row rather than as an item. The half of the escalation that was
never in dispute — a missing `--t-blight` drawing the tier's rule white — had
already been fixed; that fix is untouched and is now the whole of the mechanism.

## The change — first commit

Four files, and only the first is behaviour. (A second commit follows, removing
the tooltip inversion as well; see below.)

| file:line | change |
|---|---|
| `src/ui/Icons.js:574` (`itemArt`) | **the fix.** Deleted the `if (resolved === 'blight') { drawInverted(...); return; }` branch that stood at the head of the cache callback, so Blight falls through to the same plate/glyph/`color`-composite path as every other tier. |
| `src/ui/Icons.js:612` | deleted `drawInverted` (46 lines, now unreachable); left a comment in its place recording what it did and why it went, so it is not re-derived. |
| `src/ui/Icons.js:36` | `TIERS.blight`'s comment claimed the hue "has to work as a *field* rather than as a stroke". It is now a stroke; comment corrected. The hex is unchanged. |
| `src/data/items.js:2866` | the blight glyph set's authoring note asserted the tile "inverts figure and ground for this tier". Corrected; the note that these glyphs are drawn chunkier survives on its own merits (see residual below). |
| `src/ui/Tooltip.js:49` | the tooltip's comment cited `Icons.drawInverted` as its justification. Rewritten — and superseded by the second commit below, which removes the chip it was justifying. |

No `id` value was touched, so save data, `UNLOCK_BINDINGS` and the golden hashes
are unaffected. `43/43` test files, `41 passed, 0 failed`, unchanged from before
the edit. `node node_modules/vite/bin/vite.js build` is green.

### The tooltip name chip — raised as a scope question, then closed

The first commit deliberately left `Tooltip.js` drawing a blight item's *name* as
dark text on a magenta chip, and flagged it: the decision covered tiles, and a
name chip is not a tile, is not in a strip of eighty, and has no silhouette to
fail. The user ruled the other way — **no inverted element remains anywhere** —
and the second commit removes it. Recorded below.

## Surface enumeration

The brief asked for every surface that draws an item tile, not the one the critic
photographed. There are **nine call sites across five files**, and all nine go
through `Icons.itemArt` — which is why a ~1-line deletion reaches all of them:

| # | surface | site |
|---|---|---|
| 1 | HUD inventory strip (the shot the critic scored) | `src/ui/HUD.js:329` |
| 2 | pickup / mutation toast icon | `src/ui/HUD.js:461` |
| 3 | pause run-summary tile | `src/ui/Menus.js:990` |
| 4 | Edict tier-tab seal | `src/ui/Menus.js:1055` |
| 5 | Edict item grid | `src/ui/Menus.js:1079` |
| 6 | death / run-summary tile grid | `src/ui/Menus.js:1563` |
| 7 | centre-screen pickup banner | `src/ui/Menus.js:1600` |
| 8 | logbook detail art | `src/ui/Logbook.js:684` |
| 9 | logbook grid tile | `src/ui/Logbook.js:785` |

Plus `Icons.equipmentArt` (`Icons.js:533`), which forwards to `itemArt` with a
hard `'equipment'` tier and so can never be blight.

This is a claim about completeness, so it is gated rather than asserted: the probe
below proves surfaces 1 and 3 emit the **byte-identical** data URL, which is the
observable consequence of there being one renderer behind a shared cache.

## Probe evidence

`tools/menuprobe.mjs` gained a blight-polarity arm (the existing picker and pause
assertions are untouched and still pass). It grants a blight card plus common and
uncommon controls, opens the real pause summary, and measures the **composited,
shipped** tiles — not a fresh canvas in isolation, which is the mistake
`glyphdist.mjs` was twice caught making.

Polarity is read off each plate interior's own luma distribution, so no tier's hue
enters it: `median` is the ground and the marks are whatever sits furthest from
it. `(p95 - median) - (median - p5)` is positive for a bright emblem on a dark
plate and negative for the old inversion.

**The instrument is calibrated against a known input**, per the round-6 standing
requirement — but the first version of this gate did not meet that bar, and the
correction is recorded in its own section below. As it now stands, the calibration
input is a **rebuild of the historical `drawInverted` composite**, and both gates
the shipped tile passes must fail on it.

Run: `node tools/menuprobe.mjs --port 5306 --out reviews/round7/captures/fix-blight-glyphs`

```
PASS  the blight tile was sampled (2398 px inside the plate)
PASS  control tiers sampled for comparison (equipment, common, uncommon)
PASS  calibration: the instrument scores the historical drawInverted composite as
        inverted (polarity -43.6 vs shipped 229.5)
PASS  calibration: and scores its field as bright ground, failing the dark-plate
        gate (median luma 88.6 vs shipped 16.8, gate is < 70)
PASS  calibration is a rebuilt composite, not a negation of the shipped tile
        (|-43.6 + 229.5| = 185.9, a negation would give 0)
PASS  the blight tile is a bright emblem on a dark plate (polarity 229.5)
PASS  every control tier has the same polarity
        (equipment 222.4, common 219.7, uncommon 203.1)
PASS  the blight plate is dark ground, not a magenta field (median luma 16.8)
PASS  the blight glyph carries the tier magenta (hue rgb 215,81,159)
PASS  and it is the declared tier colour, saturated (chroma 134, off #e05aa8 by 9)
PASS  the magenta tier rule survives (.t-blight color rgb(224, 90, 168))
PASS  the HUD strip and the pause summary draw the identical blight art (6162 chars)

polarity:  equipment 222.4 (median 22.1) | common 219.7 (median 24.3)
           | uncommon 203.1 (median 33.8) | blight 229.5 (median 16.8)
glyph hue: equipment rgb(222,121,27) chroma 195 | common rgb(148,154,162) chroma 14
           | uncommon rgb(62,187,69) chroma 125 | blight rgb(215,81,159) chroma 134
```

Blight's polarity (229.5) now sits inside the controls' band, its plate median
(16.8) is the darkest of the four rather than a bright field, and its glyph
measures rgb(215,81,159) against a declared `#e05aa8` = rgb(224,90,168) — off by
9 on the worst channel. Capture: `reviews/round7/captures/fix-blight-glyphs/06-pause-blight.png`
(the magenta tile is last in `CARRYING`), confirmed by eye as well as by number.

### Two gates were rewritten mid-run rather than tuned

Recorded because both are the failure mode this repo keeps re-learning.

1. The first hue gate read the glyph's **brightest** pixels and got
   `rgb(255,255,255)` — a false red. `itemArt`'s `color` composite takes hue and
   saturation from the tier but keeps the glyph's luminosity, and a pixel at L=1
   is white in *any* hue, so the stroke core is neutral on every tier. Narrowing
   to a percentile band did not fix it either: blight's glyphs are authored with
   chunkier masses (they were drawn for the inverted tile), so more of the glyph
   is blown core and the band tracked the glyph's weight rather than its colour.
   The gate now ranks marks by chroma, which asks "is the tier hue in this tile"
   without assuming what share of a glyph carries it.
2. The first chroma floor was derived from the control tiers — but `common` is
   deliberately near-neutral at chroma 14, so the floor computed to ~8 and would
   have passed a tile with no tier colour in it at all. It now measures against
   `TIERS.blight.color` directly. This is aggregate-hiding-an-absence #6.

## Second commit — the name chip goes too

User decision after the first commit: remove the tooltip inversion as well, so
nothing in the build reverses figure and ground for this tier.

| file:line | change |
|---|---|
| `src/ui/Tooltip.js:49` (`show`) | deleted the `inverted` branch and the three inline styles it drove (`color` to near-black, `background` to the tier colour, `padding` for the chip). The name is now written in `meta.color` unconditionally, which is exactly what the other six tiers already did. Comment replaced. |

The tier still reads as itself on the card without the chip: the magenta is unique
to blight and now appears three times on the same card — the name, the `BLIGHT`
label, and the card's own `--tier` left edge.

One thing worth naming, because it is the failure this shape usually ships: the
tooltip element is **reused across hovers**. Setting `background` and `padding`
inline only on the blight branch and clearing them with `''` on every other
branch was correct but fragile — drop the clear and a magenta chip follows the
player onto the next card they open. Deleting the branch removes the hazard
rather than re-implementing it, and the probe now gates on the inline `style`
attribute containing no `background` or `padding` at all, not merely on the
computed colour looking right.

### Evidence

The probe already covered tooltips (it hovers a tile and asserts the card opens),
so the arm was extended rather than replaced — it now hovers the **blight** tile
specifically. Four new gates, all green:

```
PASS  hovering the blight tile opens its card
PASS  the blight name is written in the tier magenta (rgb(224, 90, 168))
PASS  and sits on no chip of its own (background rgba(0, 0, 0, 0))
PASS  no inverted chip styling survives inline (style="color: rgb(224, 90, 168);")
```

All fourteen of the arm's gates green at this commit, including every one from
the first commit unchanged — the tile polarity numbers are bit-identical (blight
229.5, median 16.8, hue rgb(215,81,159)), so this change did not disturb the
first fix. (An earlier draft of this section said "16/16" here; that was a
miscount of my own and is corrected. The arm carried ten gates after the first
commit and fourteen after the second. It carries sixteen now, after the third.)

Capture: `reviews/round7/captures/fix-blight-glyphs/07-tooltip-blight.png` —
`SPASM GLAND` in magenta over the dark card, structurally identical to the
`AMBER CLASP` common card in `05-tooltip.png`. Confirmed by eye.

`43/43` test files (`41 passed, 0 failed`) and the vite build both still green.

## Third commit — the calibration gate was a tautology, and is now a real one

Round-7 independent review (`reviews/round7/task-blight-review.md`, M1, Major)
found that the calibration gate this report leaned on **could not fail**. The
finding is correct. I verified the algebra rather than taking it on faith:

`polarity = (p95 - median) - (median - p5) = p95 + p5 - 2·median`, and the luma
weights `0.2126 + 0.7152 + 0.0722` sum to exactly 1, so negating every channel
maps `L -> 255 - L`. That is a strictly decreasing affine map, so it reverses the
percentile ordering of *any* image: `p95' = 255 - p5`, `p5' = 255 - p95`,
`median' = 255 - median`. Substituting:

```
polarity' = (255-p5) + (255-p95) - 2(255-median) = -(p95 + p5 - 2·median) = -polarity
```

An identity for any input whatsoever. The gate reduced to `bl.polarity > 0`,
which the very next line already asserted independently — so it added nothing and
tested nothing. The exact `229.5 -> -229.5` symmetry was the tell, and I read it
as a clean result instead of as the signature of an identity. **This is the fourth
instrument this project has had to withdraw, and the first one where the report
claimed the round-6 calibration bar while failing it.**

Fixed by reconstruction rather than deletion, per the review's preferred option
(the review offered deletion as the fallback; the rebuild came to ~30 lines of
probe code, so the stronger option was affordable). The calibration input is now
the **actual historical `drawInverted` composite**, rebuilt in the probe from the
shipped tile's own glyph mask: every marked pixel flooded to the plate black
`#05070a` as `source-in` did, everything else filled with the vertical field
`mix('#e05aa8','#ffffff',0.10)` to `mix('#e05aa8', TIERS.blight.plate, 0.45)` as
`destination-over` did. Those are the real colours, read out of
`git show e3efe97^:src/ui/Icons.js` — the deleted function's own source — not
re-derived from the description in this report.

Both gates the shipped tile passes must now fail on that reconstruction, and do:

```
PASS  calibration: the instrument scores the historical drawInverted composite as
        inverted (polarity -43.6 vs shipped 229.5)
PASS  calibration: and scores its field as bright ground, failing the dark-plate
        gate (median luma 88.6 vs shipped 16.8, gate is < 70)
PASS  calibration is a rebuilt composite, not a negation of the shipped tile
        (|-43.6 + 229.5| = 185.9, a negation would give 0)
```

The reconstruction scores **-43.6**, not -229.5. That asymmetry is the whole
point: an identity would have forced the magnitudes to match exactly, and they do
not. The third gate exists solely to pin that down — it fails if anyone ever
reintroduces a negation here, which is the specific regression this section is
about. The historical composite also fails the dark-plate gate at median 88.6
against a threshold of 70, so two independent gates are shown to catch the real
defect rather than one.

Nothing about the fix itself changed, and no shipped-tile number moved: blight
polarity 229.5, median 16.8, hue rgb(215,81,159), all bit-identical across all
three commits. The scope of this commit is the instrument, not the code it
measures.

### The lesson worth keeping

The round-6 handoff's rule was "calibrate against a known input before
measuring". I followed the letter of it and missed the substance: I calibrated
against *an* input with a known expected answer, but the transform producing that
input was an involution on the metric, so the expected answer was guaranteed by
algebra rather than by the instrument working. The sharper rule this earns:

> A calibration input must be a reconstruction of the **defect**, not a
> transform of the **fix**. If you can prove the expected result without
> reference to what the instrument does, it is not a calibration.

## Residual

The blight glyph set in `src/data/items.js` is still authored for the inverted
tile: chunkier masses, fewer hairlines, on the reasoning that a dark hole in a
solid plate needs more mass to survive 33px. Those glyphs now sit on a dark plate
like everyone else's, where the constraint is different. They measure fine
(polarity 229.5, chroma 134, both inside the controls' band) and nothing here
needs to change to close this item — but if a later critic scores blight glyphs as
heavy or muddy relative to their neighbours, this is the cause, and it is an
authoring pass over eleven glyphs rather than a code fix.
