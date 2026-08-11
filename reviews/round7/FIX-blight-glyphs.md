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

## The change

Four files, and only the first is behaviour.

| file:line | change |
|---|---|
| `src/ui/Icons.js:574` (`itemArt`) | **the fix.** Deleted the `if (resolved === 'blight') { drawInverted(...); return; }` branch that stood at the head of the cache callback, so Blight falls through to the same plate/glyph/`color`-composite path as every other tier. |
| `src/ui/Icons.js:612` | deleted `drawInverted` (46 lines, now unreachable); left a comment in its place recording what it did and why it went, so it is not re-derived. |
| `src/ui/Icons.js:36` | `TIERS.blight`'s comment claimed the hue "has to work as a *field* rather than as a stroke". It is now a stroke; comment corrected. The hex is unchanged. |
| `src/data/items.js:2866` | the blight glyph set's authoring note asserted the tile "inverts figure and ground for this tier". Corrected; the note that these glyphs are drawn chunkier survives on its own merits (see residual below). |
| `src/ui/Tooltip.js:49` | the tooltip's comment cited `Icons.drawInverted` as its justification. Rewritten — see the scope note below. |

No `id` value was touched, so save data, `UNLOCK_BINDINGS` and the golden hashes
are unaffected. `43/43` test files, `41 passed, 0 failed`, unchanged from before
the edit. `node node_modules/vite/bin/vite.js build` is green.

### Scope note: the tooltip name chip stays inverted

`Tooltip.js:56-58` still draws a blight item's *name* as dark text on a magenta
chip. It is kept deliberately and is now the only place in the build where the
tier reverses figure and ground. The decision covered tiles; a name chip is not a
tile, it is not in a strip of eighty, and it has no silhouette to fail. Its
comment no longer justifies itself by pointing at the tile, because that argument
is now false. Flagging it so a later reviewer sees a choice rather than an
oversight.

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
requirement: the same function is run over a photographic negative of the very
same blight tile and must report the opposite sign. It does, exactly
(`229.5 -> -229.5`). An instrument that cannot see the defect it was written to
detect is not evidence, and this project has withdrawn three of those.

Run: `node tools/menuprobe.mjs --port 5306 --out reviews/round7/captures/fix-blight-glyphs`

```
PASS  the blight tile was sampled (2398 px inside the plate)
PASS  control tiers sampled for comparison (equipment, common, uncommon)
PASS  calibration: the instrument flips sign on an inverted copy of the same tile
        (shipped 229.5 -> negated -229.5)
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

## Residual

The blight glyph set in `src/data/items.js` is still authored for the inverted
tile: chunkier masses, fewer hairlines, on the reasoning that a dark hole in a
solid plate needs more mass to survive 33px. Those glyphs now sit on a dark plate
like everyone else's, where the constraint is different. They measure fine
(polarity 229.5, chroma 134, both inside the controls' band) and nothing here
needs to change to close this item — but if a later critic scores blight glyphs as
heavy or muddy relative to their neighbours, this is the cause, and it is an
authoring pass over eleven glyphs rather than a code fix.
