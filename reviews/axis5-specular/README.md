# Axis 5 specular investigation — issue #102 REFUTED (2026-08-17)

Three full capture runs plus one diagnostic probe, kept for their numbers. **The PNGs are not
committed** (100 MB); the manifests and the measurement scripts are, so the numbers are checkable
and the method is reproducible.

No code shipped. Three candidate fixes were implemented, measured, and refuted.

## The premise error: #102 is off by one biome

`tools/capture.mjs:137` names the shot `13-biomes-${i+1}` while passing `index: i` to `biomeVista`
(`src/core/Harness.js:4971`). **Shot _n_ is `BIOMES[n-1]`.**

| shot | actual biome | what #102 assumed |
|---|---|---|
| `13-biomes-1` | Cindergrass Flats (`Materials.js:1174`) — `matTune` declares **no `wetStone`, no `metalRuin`** | the `wetStone 0.045` near-mirror rung |
| `13-biomes-4` | Ferrous Muster (`:1458`) — containers (`Props.js:1454`) already at roughness **0.15** / metalness 0.86 / env 3.4, and its `DETAIL` row (`:351`) already carries the anisotropic 2.30 m seam break (`aniso 4.5`, `joint [0.90, 2.30, 1.55, 0.095]`) | `metalRuin 0.34 / 0.56`, needing a roughness drop and a seam break |

The cited `0.045` and `0.34/0.56` belong to `BIOMES[1]`, Drowned Aqueduct (`:1331-1332`) — which is
**`13-biomes-2`**, a shot that neither #102 nor #100 ever measured.

## What was measured

Baseline `before/` is a full run on unmodified `f3edf7f`. It reproduces `reviews/axis5-rescore/SCORE.md`:
b1 mesa-top clip255 **1.580%** vs its 1.601%; `02-vista` right cliff **0.364%** vs 0.364%. So the two
runs agree and the instrument is stable. `clip255` counts pixels with **any channel** at 255.

| intervention | b1 mesa clip255 | verdict |
|---|---|---|
| baseline | 1.580% | — |
| indirect-specular ceiling (`radMax`) | 1.576% | noise |
| specular-AA variance cap (`alphaMax`) | 1.576% | noise |
| roughness floor 0.03 → 0.12 (`rMin`) | 1.618% | noise, and the wrong way |

Nothing exceeds run noise. The harness is not bit-exact; sub-percent per-shot deltas are noise.

## The knob works — the pixels are simply not where the ticket says

`probe-rmin90/` is a plumbing check, **not an acceptance number** (partial runs are a different
regime). Forcing terrain `rMin` to 0.90 — the entire ground rung fully matte — moved mesa-top
clip255 by 0.014 pp while mean luma went 82.2 → 80.2. The knob demonstrably bites, so the clipping
pixels in that ROI are **not on the terrain material and not on `wetStone`**.

Those pixels average RGB **255/234/183** — the key light's own hue, red channel only, luma ~236.
That is a warm **direct** highlight on some prop rung, not a blown environment reflection.

## What #102 needs before anyone spends on it again

Re-specify against the correct biomes, then answer the one open question: **which material owns the
255/234/183 pixels?** That is answerable with a single `overrideMaterial`-per-rung diagnostic, not
with more parameter guesses — all three tried here were guesses against the wrong frame.

## What this does NOT overturn

Axis 5's score is unchanged at 4-6 against a bar of 7 (`RUBRIC.md:16`). #100's headline finding also
stands: it rests on the `07-interactables` chest ROI (67 → 220 unique luma), which is not a biome
shot and is unaffected by the off-by-one. **The ~$500 envelope still has no live justification.**
What the off-by-one invalidates is the *attribution* of the remaining failure to specific materials,
not the measurement that axis 5 still fails.
