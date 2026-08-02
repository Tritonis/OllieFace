# Round 6 — stages: the detail pass aliases, and the cause is specular, not amplitude

Scope: `src/world/Materials.js` only. Every number names the PNG it was decoded
from. The instrument is calibrated in §0b before it is pointed at a real frame.

**Isolation verdict up front: YES, the detail pass is the salt source** (§1), but
**not for the reason the code was being changed for.** It is not the field's
amplitude going unfiltered at distance — it is that the perturbed normal's
sub-pixel variance was never converted into roughness, so the specular lobe
point-sampled facets narrower than a pixel (§2). That is why the amplitude gates
already in the tree "barely moved the needle".

**b1 far mountain, ROI x 300–425 y 422–456: 2.000 % → 0.471 %**
(`reviews/round6/detON/13-biomes-1.png` → `reviews/round6/stages/13-biomes-1.png`),
against a detail-pass-off floor of 0.400 % (`reviews/round6/base/13-biomes-1.png`).
5.0× above the floor becomes 1.18×.

---

## 0. Step 0 — what was already on disk, and what the baseline actually is

**The detail pass was switched off in the committed code, and the round-6
baseline was captured that way.**

`f9b47c4` carried `#define DET_KILL 0.0` in `DETAIL_PARS` and
`gradW *= DET_KILL; hOut *= DET_KILL;` as the last line of `detField` — a
predecessor's isolation harness left latched. `BASELINE.md` states
`reviews/round6/base/` was captured "from a clean tree at `fba0a91` (code
identical to `f9b47c4`)". Therefore **`reviews/round6/base/` is the
detail-pass-OFF arm**, not a picture of the intended build.

This is visible in the pixels, not inferred from the source.
`reviews/round6/crops/arch-base.png` (from `reviews/round6/base/13-biomes-1.png`,
x 690–810 y 180–300 at 4×) shows the hero arch as **bare undifferentiated rock
with no mortar courses at all**. `reviews/round6/crops/arch-fixD.png`, the same
window after this change, shows the running-bond masonry that round 3 measured
as the axis-5 win. Shipping `base/`'s code as-is would have silently deleted the
hewn-stone material identity from the build.

Two consequences that govern how to read everything below:

1. **Frame-wide salt in `base/` is not a fair ceiling**, because `base/` renders
   no surface detail anywhere. It is quoted throughout as a **floor** — what a
   featureless build scores — never as a target.
2. The `DET_KILL` latch is removed by this change. The detail pass is on again.

### Arms captured

All seed 1337, 1600×900, `--port 5202`, never into `shots/`.

| arm | on-disk dir | code |
|---|---|---|
| **OFF** | `reviews/round6/base/` | `fba0a91` = `f9b47c4` — detail pass killed |
| **PRE** | `reviews/round6/detPRE/` | `2a782a0` `Materials.js` — detail on, before any gate |
| **ON** | `reviews/round6/detON/` | `f9b47c4` with `DET_KILL 1.0` — detail on, predecessor's gates live |
| **dbg1–6** | `reviews/round6/dbg{1..6}/` | single-term shader bisection, §2 |
| **fixA–D** | `reviews/round6/fix{A..D}/` | fix iterations, §3 |
| **FIX** | `reviews/round6/stages/` | this change, full 21-shot run |
| **CTRL** | `reviews/round6/ctrl/` | current tree with **only my file reverted** |

`CTRL` exists because three other agents have in-flight edits in this tree. It is
captured from the identical working tree as `FIX` with `src/world/Materials.js`
alone rolled back, so `CTRL → FIX` attributes changes to this file and nothing
else. (Since HEAD has the pass killed, `CTRL` is also a fresh detail-OFF arm; it
reproduces `base/` to within 0.006 pp on `13-biomes-1`, which independently
confirms `base/` is still a valid floor.)

---

## 0b. The instrument, calibrated before use

Round 2's stages critic retracted a root cause after finding it was an artefact
of its own filter's bandwidth. So `reviews/round6/tools-stages/salt.mjs` ships a
`--selftest` over seven inputs whose answer is known by construction, and it is
run before every measurement session:

```
$ node reviews/round6/tools-stages/salt.mjs --selftest
PASS  flat 128                 got 0.000%  want ~0.000%
PASS  ramp                     got 0.000%  want ~0.000%
PASS  1-in-100 specks +60      got 1.020%  want ~1.000%
PASS  1-in-100 specks +20      got 0.000%  want ~0.000%
PASS  step edge                got 0.000%  want ~0.000%
PASS  1px lines every 10       got 10.101%  want ~10.000%
PASS  3x3 blocks every 12      got 2.778%  want ~2.778%
```

The definition is the round-3 critic's, unchanged: a pixel whose luma exceeds the
median of its 8 neighbours by more than 25, as a percentage of pixels considered.

Two calibration results govern the argument below:

- **A smooth ramp and a hard step edge both score 0.000 %.** The statistic counts
  isolation, not gradients or silhouettes.
- **A *resolved* 3×3 bright feature scores 2.778 %, not 0 %.** Only its four
  corners are isolated — but they are. So the statistic has a floor on any
  surface carrying genuine relief at a few pixels per feature: **it cannot
  separate "aliasing" from "detail" on a near surface, only on a far one.** My
  first expected value for this case was wrong (I predicted 5.556 %, assuming
  eight rim pixels); the filter was right and I corrected the test, not the
  filter. This is exactly why the verdict is argued on **distant** ROIs and why
  §4 refuses to claim the frame-wide number.

---

## 1. ISOLATION VERDICT — **YES**

Frame-wide isolated-bright fraction, identical bearings, the *only* difference
being whether the detail pass runs:

| shot | OFF `base/` | ON `detON/` | ratio |
|---|---|---|---|
| `13-biomes-1` | 0.752 % | **1.881 %** | 2.50× |
| `13-biomes-2` | 1.603 % | **4.721 %** | 2.94× |
| `13-biomes-3` | 1.270 % | **2.759 %** | 2.17× |
| `13-biomes-4` | 0.498 % | **0.745 %** | 1.50× |
| `02-vista` | 0.527 % | **0.881 %** | 1.67× |
| `07-interactables` | 1.057 % | **0.630 %** | **0.60×** |

Decoded from `reviews/round6/base/<shot>.png` → `reviews/round6/detON/<shot>.png`.

Five of six terrain shots rise 1.5–2.9×. **`07-interactables` falls** — its salt
is not from this pass, and future work should stop attributing it here.

**b1 far mountain**, ROI x 300–425 y 422–456, 4 250 px — the distant ridge left
of the arch, above the treeline and clear of the beacon beam. Crops:
`reviews/round6/crops/roi-b1far.png` (ON) and `roi-b1far-OFF.png` (OFF).

| arm | file | salt |
|---|---|---|
| OFF | `reviews/round6/base/13-biomes-1.png` | **0.400 %** (17/4250) |
| PRE — no gates | `reviews/round6/detPRE/13-biomes-1.png` | **3.176 %** (135/4250) — 7.9× |
| ON — predecessor's gates | `reviews/round6/detON/13-biomes-1.png` | **2.000 %** (85/4250) — 5.0× |

**5.0× independently reproduces the round-3 critic's 5.3×** on the same named
surface, from a filter written from scratch and calibrated separately.

The gates already in the tree were real but small: **3.176 % → 2.000 %**, a 37 %
cut on a defect needing a 5× one. "Barely moved the needle" was accurate.

---

## 2. Which part of the pass — six shader arms

Bisection by `#define`, one shot each, same bearing, `13-biomes-1`, same ROI.
Reference points: OFF 0.400 %, full pass ON 2.000 %.

| arm | what was cut | file | ROI salt | frame salt |
|---|---|---|---|---|
| 1 | `gradW = 0` — keep height/cavity/roughness, **no normal** | `reviews/round6/dbg1/13-biomes-1.png` | **0.424 %** | 0.773 % |
| 2 | `hOut = 0` — keep normal, no cavity/roughness | `reviews/round6/dbg2/13-biomes-1.png` | 1.929 % | 1.933 % |
| 3 | coarse/ridge octave amplitude → 0 | `reviews/round6/dbg3/13-biomes-1.png` | 1.647 % | 1.966 % |
| 4 | fine octave amplitude → 0 | `reviews/round6/dbg4/13-biomes-1.png` | 1.388 % | 1.032 % |
| 5 | sky-visibility weight `skyD` → 0 | `reviews/round6/dbg5/13-biomes-1.png` | 2.047 % | 1.878 % |
| 6 | `roughnessFactor = 1.0`, **normal still fully perturbed** | `reviews/round6/dbg6/13-biomes-1.png` | **0.094 %** | 0.710 % |

Read together, decisive:

- **Arm 1 lands on the detail-off value** (0.424 vs 0.400). The height output —
  cavity, roughness modulation, the ambient re-weighting — contributes **none**
  of the salt. It is entirely the **normal**.
- **Arm 5 clears the sky-visibility weight**, which round 3 suspected by name
  ("a per-pixel blue/red chroma checker … the new sky-visibility weight"). Not
  the cause: 2.047 % is indistinguishable from the 2.000 % full pass.
- **Arms 3 and 4 are why amplitude gating failed.** Deleting either octave
  *outright* still leaves 3.5–4.1× the OFF level. No amplitude gate on any one
  octave could have worked, because no one octave carries it.
- **Arm 6 takes it to 0.094 %** — a quarter of the detail-off floor — while the
  normal field is untouched and at full strength.

**Root cause: specular aliasing.** The pass perturbs the shading normal; the
specular lobe is a sharply nonlinear function of that normal; nothing converted
sub-pixel normal *variance* into roughness, so the BRDF point-sampled a facet
narrower than a pixel and returned a highlight. Amplitude is not the quantity
the lobe resolves — which is exactly why gating amplitude bought 37 % and
removing specular bought 95 %.

three.js already implements this correction:
`node_modules/three/src/renderers/shaders/ShaderChunk/lights_physical_fragment.glsl.js:7`
takes `dFdx`/`dFdy` of `nonPerturbedNormal` into `geometryRoughness`. It is fed
the **geometric** normal, so it has never seen anything this pass writes.

---

## 3. The fix

`src/world/Materials.js`, in the `normal_fragment_maps` injection, after the
horizon clamp. Variance folded into `alpha = roughness²`, from two sources:

```glsl
vec3 detDNx = dFdx( normal ), detDNy = dFdy( normal );
float detVarS = 0.5 * ( dot( detDNx, detDNx ) + dot( detDNy, detDNy ) );
float detAlpha = min( 2.0 * detVarS, 0.45 ) + min( detVarW, 0.60 );
roughnessFactor = sqrt( min( 1.0, roughnessFactor * roughnessFactor + detAlpha ) );
```

`detVarS` is the standard screen-space construction. **On its own it is not
enough, and the measurement says why rather than the theory:**

| variant | file | b1 far mountain |
|---|---|---|
| screen-space term only, clamp 0.18 | `reviews/round6/fixA/13-biomes-1.png` | 1.412 % |
| screen-space term only, clamp 0.60 | `reviews/round6/fixB/13-biomes-1.png` | 1.341 % |

A 0.07 pp response to a 3.3× clamp increase means the **variance estimate is
saturated, not the clamp** — the known blind spot of a 2×2 quad derivative:
content alternating every pixel differences to nearly zero, and per-pixel
alternation is precisely the failure being fixed.

`detVarW` is the world-space half, accumulated inside `detField`. Each octave
knows its own feature size in metres and the pixel footprint `fw`, so it knows
what fraction of itself the footprint hid — `1 - res²`, where `res` is the
existing `detRes()` gate — and it knows its own slope statistics, because the
noise field is baked on the CPU in this same file. `detailNoiseTexture()` now
measures the RMS of the stored gradient channels **on the shipped bytes, decoded
the way `detNoise()` decodes them**, so quantisation and the ±4 clip are inside
the constant; it reaches the shader as `uDetE.w`. The joint octave contributes
analytically, without that constant, since its slope is arithmetic.

| variant | file | b1 far mountain |
|---|---|---|
| + world-space term, screen clamp 0.18 | `reviews/round6/fixC/13-biomes-1.png` | 0.494 % |
| + world-space term, screen clamp 0.45 (shipped) | `reviews/round6/fixD/13-biomes-1.png` | 0.447 % |

### Measured effect — distant surfaces

**b1 far mountain**, ROI x 300–425 y 422–456:

| arm | file | salt |
|---|---|---|
| OFF — floor, no detail pass at all | `reviews/round6/base/13-biomes-1.png` | 0.400 % (17/4250) |
| PRE — detail on, no gates | `reviews/round6/detPRE/13-biomes-1.png` | 3.176 % (135/4250) |
| ON — detail on, predecessor's gates | `reviews/round6/detON/13-biomes-1.png` | 2.000 % (85/4250) |
| **FIX** | `reviews/round6/stages/13-biomes-1.png` | **0.471 % (20/4250)** |

**2.000 % → 0.471 %**, a 4.2× reduction; **5.0× above the detail-off floor
becomes 1.18×**. The 20 remaining isolated pixels are 3 more than the
featureless build's 17.

**b2 far spires**, ROI x 1090–1250 y 45–145 — round 3's "distant spires are a
field of near-white specks at 2–3 px". Crops `reviews/round6/crops/b2far-on.png`
→ `b2far-fix.png` show the central far peak going from stippled to clean:

| arm | file | salt |
|---|---|---|
| OFF | `reviews/round6/base/13-biomes-2.png` | 0.094 % (15/16000) |
| PRE | `reviews/round6/detPRE/13-biomes-2.png` | 1.531 % (245/16000) |
| ON | `reviews/round6/detON/13-biomes-2.png` | 1.387 % (222/16000) |
| **FIX** | `reviews/round6/stages/13-biomes-2.png` | **0.550 % (88/16000)** |

2.5× better, and **not fully closed** — 0.550 % is still 5.9× the OFF floor. The
residue is on the near-left spire inside the ROI, which is close enough that its
relief is resolved; the far central peak is visually clean. Reported rather than
hidden.

**b1 near mesa**, ROI x 520–880 y 620–760 (round 3's 1.87 → 6.47, 3.5×):

| arm | file | salt |
|---|---|---|
| OFF | `reviews/round6/base/13-biomes-1.png` | 2.425 % |
| ON | `reviews/round6/detON/13-biomes-1.png` | 6.881 % |
| **FIX** | `reviews/round6/stages/13-biomes-1.png` | **3.008 %** |

### Measured effect — frame-wide

| shot | OFF `base/` | ON `detON/` | **FIX `stages/`** |
|---|---|---|---|
| `13-biomes-1` | 0.752 % | 1.881 % | **1.210 %** |
| `13-biomes-2` | 1.603 % | 4.721 % | **2.153 %** |
| `13-biomes-3` | 1.270 % | 2.759 % | **2.465 %** |
| `13-biomes-4` | 0.498 % | 0.745 % | **0.629 %** |
| `02-vista` | 0.527 % | 0.881 % | **0.737 %** |
| `07-interactables` | 1.057 % | 0.630 % | **0.493 %** |

Every shot improves on `detON/`. **Caveat, stated because it is load-bearing:**
`stages/` was captured from the current working tree, which contains three other
agents' in-flight edits. Frame-wide totals are therefore not attributable to this
file alone — see `CTRL` below for what is.

### Material identity was not paid for it

`reviews/round6/crops/arch-on.png` (from `detON/`) and
`reviews/round6/crops/arch-fixD.png` (after the fix), same window x 690–810
y 180–300 at 4×: the running-bond mortar courses are equally legible in both.
The roughness increase does not wash out the hewn stone.

Numerically, on my own ROIs with a Hann-windowed 4–40 px vertical power spectrum
(`reviews/round6/tools-stages/spec.mjs`, selftest passes: 12 px stripe recovered
at 12.0 px / 100 % concentration, white noise 17 %), the fix costs about 5–6 pp
of spectral concentration and costs it *uniformly*, not selectively: arch leg
(x 940–1035 y 470–660) 41.7 % → 35.9 %, natural mesa face (x 560–820 y 630–780)
75.1 % → 70.1 %, both `detON/13-biomes-1.png` → `fixD/13-biomes-1.png`.
**These ROIs are mine, not round 3's**, and they do not reproduce round 3's
12.0 px arch peak, so they must not be compared against round 3's 59.7 % / 52.5 %
figures. They are usable only for the before/after delta on identical windows,
which is what they are quoted for.

---

## 4. What this fix does **not** do

**Frame-wide salt does not return to `base/`, and should not be expected to.**
`base/` renders no surface detail anywhere (§0), and the statistic has a known
floor on resolved relief (§0b: a 3×3 feature scores 2.778 %). A frame that is
mostly near rock scores high whether or not anything aliases. `13-biomes-2` is
exactly that frame — wall-to-wall rock at 3–20 screen px with almost no sky.

Per-tile attribution (`reviews/round6/tools-stages/where.mjs`, `base/` → fix,
50 px tiles, `13-biomes-1`) puts the largest residual tiles at x 1150–1250
y 800–900 and x 690–810 y 180–300: the **foreground** rock at bottom-right, and
the **hero arch**. The arch tile goes 0.00 % → 3.48 % — `arch-base.png` vs
`arch-fixD.png` shows why: `base/` scores zero because there is no masonry in
`base/` at all. That is the statistic counting the feature, not a defect.

Two things are consequently **not** fixed and are not claimed to be:

1. **Near-field contrast.** `reviews/round6/crops/fg-fixD.png` (x 1140–1260
   y 820–900 at 5×) is near foreground rock under a raking key, rendering close
   to binary lit/unlit at 3–6 px — the round-3 `07-interactables` complaint in a
   different frame. That is *resolved* detail, not aliasing; specular AA
   correctly leaves it alone. It belongs to the horizon-limit term.
2. **`07-interactables`.** Its salt is *lower* with the detail pass on
   (1.057 % → 0.630 % → 0.493 %). Whatever drives that shot is outside this pass.

---

## 5. Harness state

- `npx vite build` — green.
- Full 21-shot `capture.mjs` run: `reviews/round6/stages/manifest.json` —
  `ready: true`, `clockPinned: true`, `partial: false`, `subjectsOk: false`,
  **5 failing shots**: `04-combat`, `06-loaded-hud`, `08-explosion`,
  `10-inventory`, `11-bestiary`.
- The baseline has 4: `04-combat`, `08-explosion`, `09-survivors`,
  `11-bestiary` (`reviews/round6/base/manifest.json`).

**That difference is not caused by this change, and it was measured, not
assumed.** `reviews/round6/ctrl/manifest.json` is a full run of the *identical
working tree* with `src/world/Materials.js` alone reverted to `HEAD`. It fails
**the same five shots**: `04-combat`, `06-loaded-hud`, `08-explosion`,
`10-inventory`, `11-bestiary`. The two new failures (`06-loaded-hud`,
`10-inventory` — both UI shots) and the newly-passing `09-survivors` come from
other agents' in-flight edits. **`CTRL → FIX` changes zero subject verdicts.**

`CTRL → FIX` frame-wide, the clean attribution of this file on this tree (note
`HEAD` has the pass killed, so `CTRL` is a detail-OFF arm and this delta is the
price of *having* the detail pass at all, post-fix):

| shot | `ctrl/` | `stages/` |
|---|---|---|
| `13-biomes-1` | 0.747 % | 1.210 % |
| `13-biomes-2` | 0.998 % | 2.153 % |
| `13-biomes-3` | 1.234 % | 2.465 % |
| `13-biomes-4` | 0.513 % | 0.629 % |
| `02-vista` | 0.525 % | 0.737 % |
| `07-interactables` | 0.411 % | 0.493 % |

---

## 6. Reproduction

```
node reviews/round6/tools-stages/salt.mjs --selftest
node reviews/round6/tools-stages/spec.mjs --selftest
node reviews/round6/tools-stages/salt.mjs <A.png> <B.png> [x0 y0 x1 y1]
node reviews/round6/tools-stages/report.mjs reviews/round6/stages
node reviews/round6/tools-stages/where.mjs <dirA> <dirB> <shot> [tile] [top]
node reviews/round6/tools-stages/crop.mjs <in.png> <out.png> x0 y0 x1 y1 [zoom]
node tools/capture.mjs --out reviews/round6/stages --port 5202
```

`png.mjs` is a dependency-free PNG decoder (8-bit, non-interlaced, colour type
2/6) — the repo has no image library and `npm install` is documented to break
this tree.

## 7. Note for whoever owns the harness

Two full capture runs of mine were destroyed mid-flight by other agents' in-flight
syntax errors (`src/shaders/ParticleShader.js:248`, a backtick inside a GLSL
template literal, then `src/systems/Artifacts.js`). `capture.mjs` deletes its
`--out` directory *before* it knows whether the app boots, so a broken tree costs
the previous capture as well as the new one. Writing to a temp dir and swapping
on success would make parallel work on this repo a great deal cheaper.
