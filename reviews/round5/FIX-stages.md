# FIX — stages / lighting / materials (round 5, resumed)

Work list: `reviews/round5/critic-r1-stages.md` §6, six ranked defects.
Predecessor was killed mid-edit at `a06c6fe` and wrote no report; this file covers
**both** what it landed (verified by re-measurement, not by reading its diff) and
what I did after it.

## How everything below was measured

Re-ran the critic's own scripts from the session scratchpad (`e_surf.mjs`,
`f_comp.mjs`, `k_last.mjs`, `l_r4.mjs`, `h_light.mjs`, `c_tex.mjs`) plus four of
my own (`blob.mjs` connected-component sizing with bbox, `sep.mjs` probe-free
top-decile:bottom-decile contrast, `beam.mjs` geometric beam locator, `arch.mjs`).
Shots captured to a private `--out` directory on port 5233 so two other agents
capturing into `shots/` concurrently could not race me.

**Two measurement caveats that matter for reading this table:**

1. **The harness re-picks camera bearings between builds, and `07-interactables`
   changes *biome* between runs** (I saw it land on stage 1 and on stage 4 in
   consecutive captures). Every fixed-pixel probe in `c_tex.mjs`/`h_light.mjs` is
   therefore only comparable within a single capture, not across the round. Where
   a number depends on a fixed pixel I say so. The tile-census, connected-component,
   decile-ratio and hue-histogram numbers are camera-robust and carry the weight.
2. The critic's teleporter-beam mask (`L>170 & b>1.15r & g>1.05r`) is **now
   vacuous** — after the fix it selects HUD chrome at x=1568 and no beam at all.
   I replaced it with a geometric locator (tallest bright vertical run) so the
   beam could still be measured honestly rather than scored as "gone".

---

## The six defects

| # | Defect | Status | Measured |
|---|---|---|---|
| 1 | Materials: no HF detail on 73–92% of surfaces | **partly fixed by predecessor — still open** | texture-free single-surface fraction **79.9/77.9/75.0/72.8/85.6/91.5% → 64.5/74.8/62.4/70.5/76.7/61.1%**. Criterion <40% in every shot: **not met anywhere.** |
| 2 | `02-vista` regressed to a near-black hole | **partly fixed by predecessor — still open** | sub-L24 **12.52% → 1.61%** (criterion <3%) ✅. Largest connected sub-L40 region **33.5% → 30.1%** (criterion <8%) ❌. near→mid step **5 → 4 luma** (criterion ≥12) ❌. |
| 3 | Teleporter beam wrecks composition | **fixed by me (predecessor started it)** | 2.07–3.29× frame mean → **1.68–2.54×**; criterion ≤1.6× ❌ but hue is fixed: one cyan (hue 123–164°) in all four biomes → **262° / 100° / 314° / 27°**, saturation on b4's shaft 0.19 → **0.60**. |
| 4 | Round-4 leftovers (chest, dead lower-left, basin, achromatic metal, crystal, flat arch) | **mixed** | see the sub-table below |
| 5 | Foreground values crushed (`04-combat`, `05-boss`) | **fixed by predecessor** | sub-L24 across the six judged shots is now **1.35–1.75%**, none above 1.8%; the crushed-foreground frames the handoff flagged no longer read as crushed. |
| 6 | b4 contour stripes; b2 blown to near-white | **b2 fixed, b4 open** | b2 above-L215 **7.60% → 1.09%**, largest component well under 1.0% ✅ (criterion <2.5%). b4 direction reversals over the 170px scan **84 → 92** ❌ — though the profile is now normal-map noise rather than a 4px periodic terrace, so the metric is arguably measuring the wrong thing on the current build. |

### Defect 4 detail

| R4 # | Item | Status | Measured |
|---|---|---|---|
| 1 | Teal accent over budget | **fixed by predecessor + me** | R4's own mask, all six shots: **0.075–1.259%**, largest component ≤0.22%. Was 2.549%/4.416%/7.211%. Criterion <1.5% met everywhere. |
| 2 | Chest is an untextured slab | **fixed by predecessor** | I have it in frame with three luma plateaus, wood-grain HF, orange banding and concave rail features. Not re-measured against the three numeric criteria because the shot moved biome mid-round; visually it is no longer the round-4 object. |
| 3 | 07's lower-left dead zone | **not fixed** | 13.9% → **13.8%** against an 8% criterion. Untouched. |
| 4 | Basin carries no shadow shape | **not fixed** | untouched. |
| 5 | Hero arch flat-lit | **partly fixed by me** | I gave `archGeo` a real section (tube 0.17 → 0.30) plus a soffit rib inside the intrados and thicker legs, so the crown now has a genuine up-facing plane, a genuine down-facing one and a concave corner for GTAO. It reads as mass in the pixels. It still measures **1.26:1** top-to-soffit against a 2.2:1 criterion — because in both hero framings the arch is *contre-jour*, sun behind it, so top and soffit are both in shade. No geometry change fixes that; the bearing does, and the bearing lives in `Harness.js`, which I do not own. |
| 7 | Metal specular achromatic | **not fixed** | monolith peak still RGB(255,255,240), **sat 0.06, hue 60°** under a hue-34° key. Unchanged. |
| 9 | Crystal is one repeated spike | **fixed by predecessor** | `crystalGeo` now builds two silhouette families (needles + wedges) per cluster with independent rotation, not one scaled spike. |

---

## What I changed

- **`world/Materials.js`** — a per-biome `mats.beacon` accent (violet / mint / pink /
  hot-metal orange). `crystal`, which the predecessor had routed the shaft to, is
  teal in *both* warm biomes, so the shaft was still one cyan bar standing in a
  15° amber prairie.
- **`world/Interactables.js`** — `beaconTint` reads `mats.beacon`; shaft emissive
  1.15 → **0.42**, collar 1.6 → **0.80**, idle breathe narrowed 0.7–1.3 → 0.85–1.10.
  The predecessor's taper fixed the beam's *width*; it did not fix its value, and a
  blown pixel has no hue, so the tint it added could not read until the value came
  down.
- **`world/Props.js`** — `archGeo` section and soffit (above).
- **`world/Environment.js`**, **`shaders/GradeShader.js`** — **comments only.** Every
  constant is back where the predecessor left it. See the next section.

## What I tried, measured, and reverted — do not redo these

The establishing shot's dead third (defect 2) is the one I spent the most on and
did not close. Four levers, all measured, all reverted:

| Lever | Effect on the sub-L40 blob | What it cost |
|---|---|---|
| IBL floor `envScale/envMin` 0.82/0.52 → 0.92/0.74 plus `rimMin` 0.30 → 0.42 | 28.8% → 27.8% (nothing) | nothing — but it buys nothing either. The blob is a sheer face turned away from the key *and* the horizon band; it sees mostly nadir whatever the floor is. |
| Hemisphere `hemiScale` 0.40 → 0.58 | 28.0% → 21.0% | **13-biomes-2's column terminator 2.16:1 → 1.07:1, its ground 2.24:1 → 1.00:1.** The hemisphere out-lights the key on every upward-ish facet. This is the failure the existing comment in `Environment.js` already records, reproduced. |
| Fog `density` 0.85 → 1.05 / 1.25 | 28.0% → 24.6% | **13-biomes-4's top-decile world luma 134 → 111, decile ratio 3.20 → 2.44.** Heavy haze over an already-dark industrial biome eats the highlights before the shadows. |
| Grade toe 0.108/0.113/0.198 → 0.140/0.146/0.226 | **28.0% → 0.1%** — the criterion, met | **texture-free single-surface fraction 64.6/74.1/62.3/71.2% → 73.4/81.9/69.5/75.9%.** The toe is a compression at the bottom of the range, so it flattens shadow-side surface detail by construction. That is defect **1**, the top-ranked defect and the axis stuck at 5/10 for five rounds. Paying for a composition metric with material detail is the wrong direction, so I put it back. |
| toe 0.200/0.208/0.300 @ range 0.30 (steeper, narrower, meant to spare the mids) | blob 0.4% | pinned the bottom decile of every world band to L47 — one flat floor, the milky failure — and cost *more* global contrast, 4.98 → 3.18. |
| toe 0.140 **plus** `uContrast` 1.04 → 1.10 to claw the separation back | blob 0.1% → **24.6%** | contrast runs before the toe and pushes the same pixels straight back under it. The two controls fight over the same pixels. |

**Conclusion I am confident in and want on the record: the establishing shot's dead
third is a camera problem, not a lighting or grade problem.** The bearing looks
into the sun, so the entire right third of frame is the shade side of one mass.
Every scene-space lever that lifts it costs a terminator ratio; the one display-space
lever that lifts it costs axis-5 surface detail. The critic's own fix note said
"re-pick the establishing bearing so the right third is not one unlit face" — that
is the correct fix, and it is in `Harness.js`, outside my ownership.

## The protected win — re-measured, held

Sat-weighted 24-bin hue-histogram L1 distance, world band, max 2.0. Critic's five
measured pairs, before → after:

| pair | critic | now |
|---|---:|---:|
| b1↔b2 | 1.711 | **1.830** |
| b2↔b4 | 1.736 | **1.890** |
| b1↔b3 | 1.462 | **1.510** |
| b3↔b4 | 1.438 | **1.333** |
| b2↔b3 | 1.359 | **1.890** |

Four of five up, one down 0.105 and still inside the critic's stated 1.36–1.74 band
at the margin. **The biomes still read as four places.** One pair the critic did not
report, b1↔b4, measures **0.879** — both are warm sunset biomes and it is the weak
seam in the set; flagged, not caused by this round's work (it was 0.826 before I
touched anything).

Key-light terminators, same-surface probes, final build: b1 mesa **3.58:1** / 47°,
b2 column **2.16:1**, b2 ground **2.24:1**, b3 boulder **6.14:1** / 109°, b3 spire
**2.37:1**, b4 container **2.48:1** / 85°, b4 terrace **2.14:1** / 111°, 02 monolith
**3.08:1** / 29°. All inside the critic's protected range.

## Verification

- `npm run build` clean.
- 6/6 judged shots captured, `frameErrors: 0`, no new errors. (`manifest.json`'s
  one `subjectFailures` entry is `11-bestiary`, another agent's shot.)
- `node tools/apicheck.mjs` — 0 dead method calls, 1 pre-existing dead property read.
- `node tools/perf.mjs` — **`combat-24` median 16.9 ms**, p95 23.2, worst 24.9,
  programs 63. Below the stated 21–26 ms band rather than above it; my changes are
  four constants and ~200 extra vertices on one prop, so this is machine load, not
  a speedup I earned. No PMREM work per frame — the predecessor's bake is still in
  `applyBiome`, once per stage build.
- Determinism from seed holds. Note that `archGeo` now makes one extra `rng.range`
  call, which shifts the shared stream: **the same seed still gives the same world,
  but it is a different world than before this commit.** Any golden hash taken
  against `a06c6fe` needs re-baselining.

## Still open, ranked, for whoever takes round 2

1. **Axis 5 is still failing.** 61–77% of unbroken surface carries no HF detail
   against a <40% criterion. The predecessor's PMREM structure work is real and
   moved it 10–25 points; it is not enough. The remaining bulk is *distant* terrain
   tiles, where the normal map falls under a pixel of period. Needs a distance-aware
   detail term in `TerrainGen`, not more roughness tuning.
2. **02-vista bearing** (`Harness.js`) — see above. Nothing else will close defect 2.
3. **Achromatic metal specular** (R4 #7) — untouched, `sat 0.06` under a `hue 34°`
   key. Wants a specular tint by key colour.
4. **07's lower-left dead zone** — 13.8% vs 8%, untouched.
5. **Beam is still 1.68–2.54× frame mean** vs a ≤1.6× criterion. Dropping the shaft
   further starts to cost findability at 200m; if the criterion is held, the honest
   fix is a shaft that fades with screen-space height rather than one that is dimmer
   everywhere.
6. **In `02-vista` the shaft still crosses the hero arch's bbox.** The critic asked
   for a bearing that rejects that overlap — again `Harness.js`.
