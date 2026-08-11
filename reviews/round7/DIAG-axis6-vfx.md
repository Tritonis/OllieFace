# Axis 6 (VFX) re-diagnosis: what is actually swamping the opacity layer

Written 2026-08-11 against HEAD `1911d79`, tree clean apart from this diagnosis'
own probe scripts. **Diagnosis only — no source file was changed.**

Answering `reviews/round6/HANDOFF.md` open item 3: the round-4 critique's #1
recommendation ("add the opacity layer") is refuted — `VFX.explosion` emits three
`layer: 'alpha'` emitters (`src/systems/VFX.js:652`, `:688`, `:712`) — and the
residual was believed to be "the additive sum swamping it".

**That premise is confirmed and quantified, and it is not the whole cause.** The
one-line fix it implies — reorder the layers so the opacity composites over the
fireball — was built as an arm and **measured to buy almost nothing** (largest
radial luminance step 7.6 L -> 8.9 L). The binding constraint is a second,
independent deficit that no round has named: at the shutter the opacity layer
**covers 7.4% of the fireball's own disc**.

---

## 0. Instruments, and their calibration

Three instruments were refuted in round 6, so nothing below is reported without
its calibration.

### 0.1 The calibrated reference tool

`tools/vfxmeasure.mjs` was used as the anchor, per the brief. On the shipping
baseline `reviews/round6/resume/08-explosion.png` it returns core RGB
`217.8 / 184.6 / 137.4`, core mean L `188.3`, R clipped on `41.07%` of the core,
disc mean L `137.1`, largest radial step **`15.3 L` at r=24**, centre `(255,433)`.

**One limitation found and respected.** `vfxmeasure`'s automatic centre search
(centroid of the brightest 0.2% of the upper 2/3, `tools/vfxmeasure.mjs:60-79`)
is valid on capture frames but **not** on this diagnosis' probe frames: on
`reviews/round7/captures/diag-axis6/arm-full.png` it lands at `(850,194)`, which
is sky, because the probe's camera frames differently from the shipped shot. It
was therefore used only on the shipped baseline above, never to centre a probe
measurement. Probe centres are derived instead from the centroid of the
brightest 0.2% of `full - bare` — a difference in which, *by construction*, only
the two particle layers can be non-zero.

### 0.2 The instrument built here, and its two calibrations

Method is `tools/vfxprobe.mjs`'s, unchanged: compose the shot once, freeze it,
re-render that single frame N times with exactly one thing toggled. The toggle
here is `layer.mesh.visible` / `renderOrder` / `depthWrite` / `uIntensity` —
**no RNG stream is touched.** Emission has already happened, identically, in
every arm, so the standing shared-RNG hazard in `HANDOFF.md` does not apply:
there is no draw downstream of anything changed. `ParticleSystem.update`
(`src/fx/ParticleSystem.js:290`) integrates analytic trajectories and takes no
draw either.

Arms: `full`, `full2` (identical re-render), `noadd`, `noalpha`, `bare`, `half`
(additive `uIntensity` 1.35 -> 0.675), `alphaLast`, `depthWrite`, `both`.

**Calibration A — determinism, against a known input of "no change at all".**
`full` and `full2` are the same frame rendered twice with nothing toggled, so
every pixel must agree. On the first pass it did not: **6,419 px** differed
(0.446% of frame), 5,472 of them isolated single pixels with no unstable
8-neighbour, mean L 98.1, scattered over the whole frame — render speckle, plus
sub-pixel spark motion. Rather than average it into the signal, those pixels
plus a 2 px dilation are **excluded from every statistic in this report**. After
masking, the residual is `max |dL| = 0.285 L on 0 px` (pass 1) and
`max |dL| = 0.000 L on 0 px` (pass 4, 269 unstable px, 543 px masked).

The mask is not doing the work: re-running pass 1 with `--nomask` changes the
headline ratio from 27.3:1 to 26.0:1 and contrast retention from 26.9% to 27.2%.
Both runs are in the record.

**Calibration B — known input.** Halving the additive layer's `uIntensity`
must move the additive contribution and must move nothing where that layer does
not draw. Result: 253,882 px moved by >1 L, of which **125 (0.05%)** sit where
the additive layer contributes under 1 L. The instrument attributes light to the
layer that emitted it.

**One instrument built here is withdrawn.** A `muzzleFlash` was emitted in front
of the camera as the "second effect" arm and returned a null in both placements
tried: additive deposit `+0.22 L` and `+0.58 L` at its own projected centre,
against `+142.93 L` for the blast. 23 sprites were confirmed emitted (alive
count 1515 -> 1538), so the emitters fired; whether the sprites were occluded by
terrain, expired, or soft-faded was not established. **No ratio is reported from
it.** The second data point in this report is the same frame away from the blast
(section 3), which needed no new instrument.

**Pass 3 is withdrawn.** The harness scenario's shutter is not fixed across
boots: the same seed froze at sim `0.083`, `0.117` and `0.333` s on three
consecutive runs, and at 0.333 s the harness itself reports the blast absent
(777 px against a 1200 px floor). Pass 3's fix arms were measuring fixes to a
fireball that had already gone out. **Pass 4 removes the lottery**: it ignores
the scenario's blast, emits its own `explosion(pos, 6)` at the same world
position after the freeze, and advances particle time by exactly **0.09 s**, so
the phase is a constant of the measurement. All pass-4 arms see identical
particle state.

Sources on disk: `reviews/round7/captures/diag-axis6/arm-*.png`; probes and
analysers in `reviews/round7/diag-axis6/`. Port 5303 was occupied by another
session's node (PID 12924, listening since 12:18); ports 5343/5361 were used
instead. Out dir is as briefed.

---

## 1. The measured additive:alpha ratio

Pass 4, seed 1337, blast r=6 at controlled phase 0.09 s, centre (568,326),
calibration-masked. Display luminance, Rec.709.
Source: `reviews/round7/captures/diag-axis6/arm-p4-*.png`.

| region | full | noadd | noalpha | bare | half |
|---|---|---|---|---|---|
| core r<40 (n=5013) | 193.81 | 50.88 | 192.25 | 43.18 | 175.50 |
| disc r<120 (n=45213) | 133.47 | 72.66 | 131.77 | 69.70 | 121.19 |

Read off that table:

| statistic | core r<40 | disc r<120 |
|---|---|---|
| additive deposit (`full - noadd`) | **+142.93 L** | **+60.81 L** |
| alpha layer's effect on the finished frame (`\|full - noalpha\|`) | **1.56 L** | **1.70 L** |
| **additive : alpha, in the finished pixel** | **92 : 1** | **36 : 1** |
| alpha layer's effect on the bare scene (`\|noadd - bare\|`) | 7.70 L | 2.96 L |
| fraction of its own effect that survives | **20%** | **57%** |

Independently replicated on a different frame at a different phase (pass 1, the
harness's own shutter, masked): additive deposit **+111.71 L** core /
**+68.33 L** disc, alpha in the composite **1.70 L** / **1.60 L** — **66:1** and
**43:1**. Two frames, two phases, same order of magnitude.

**The ratio is not a sprite-count problem.** Source census: the explosion emits
**58 additive sprites** (`VFX.js:507`, `:551`, `:565`, `:579` x24, `:638`,
`:676` x30) against **64 alpha sprites** (`:652` x20, `:688` x26, `:712` x18).
The opacity layer has *more* particles than the additive one and still moves the
finished fireball by 1.7 L.

---

## 2. The mechanism, in three terms

### Term 1 — the additive layer is composited after the alpha layer and is never depth-tested against it

`src/fx/ParticleSystem.js:136`

```
mesh.renderOrder = additive ? 12 : 10;
```

with, for both layers, `depthTest: true, depthWrite: false`
(`src/shaders/ParticleShader.js:351-352`) — confirmed live on the frozen frame:
`add {renderOrder 12, depthWrite false}`, `alpha {renderOrder 10, depthWrite
false}`.

Neither layer writes depth, so there is no depth relationship between them at
all: ordering is decided entirely by `renderOrder`, and the additive layer
always wins it. Whatever the alpha layer composites, the additive sum is then
**added on top of it**, regardless of which is physically in front. The dust
skirt at `VFX.js:712` — added, in its own comment, "so the fireball has
something dark to be read *against*" — is drawn *behind* the fireball by
construction, on every pixel, from every camera.

The depth prepass cannot rescue this: `renderDepth`
(`src/fx/ParticleSystem.js:339-366`) hides every VFX root before rendering
(`hiddenRoots`, built at `VFX.js:237-240`, includes `particles.root`), so the
soft-particle depth texture contains scene geometry only and no particle can
soft-fade against another particle.

### Term 2 — the per-sprite ceiling does not bound a sum, and the intensity knob is saturated

`src/shaders/ParticleShader.js:244-245` ceilings **one sprite**
(`uMaxIntensity` 0.92 additive, `ParticleSystem.js:81`). At the core roughly two
dozen additive sprites overlap, so the deposit is +142.93 L that no per-sprite
clamp sees.

The obvious lever is refuted by measurement. **Halving the additive layer's
`uIntensity` (1.35 -> 0.675) removes 18.30 L of the 142.93 L core deposit — 13%
— and 12.28 L of the 60.81 L disc deposit — 20%.** A 50% cut in the constant
buys a 13% cut in the pixel. Between the per-sprite ceiling and the ACES
shoulder the knob is saturated; turning the additive layer down is not a
route to a readable silhouette.

### Term 3 — ACES compresses what is left, in proportion to the pedestal

`renderer.toneMapping = ACESFilmicToneMapping` at exposure 1.10
(`src/core/RenderPipeline.js:135`, `:142`), applied to the composited HDR buffer
by the `OutputPass` at `:279`. Particles are `toneMapped: false` in their own
material but the output pass tonemaps the composite, so the higher the additive
pedestal beneath a dust sprite, the further into the shoulder that pixel sits
and the less of the dust's linear decrement reaches the display.

**This is measurable as a dose-response across one frame.** Cutting on the
pixels the alpha layer actually covers (|its change to the bare scene| > 4 L):

| region | coverage | its change to the bare scene | ...surviving in the composite | additive pedestal beneath it |
|---|---|---|---|---|
| core r<40 | 715/5013 px (14.3%) | 53.53 L | **10.83 L (20%)** | **+149.87 L** |
| disc r<120 | 3351/45213 px (7.4%) | 43.69 L | **24.92 L (57%)** | **+78.73 L** |
| skirt r120-260 | 3254/166912 px (1.9%) | 28.92 L | **28.32 L (98%)** | **+4.87 L** |
| whole frame | 10616/1167797 px (0.9%) | 34.78 L | **28.45 L (82%)** | **+28.80 L** |

Survival falls monotonically with the pedestal beneath it: 98% at +4.9 L, 57% at
+78.7 L, 20% at +149.9 L. Pass 2 supplies a fourth point on the same curve from
a different frame — the same explosion 0.12 s later, pedestal decayed to
+11.84 L, survival 79.9%. **The pedestal is the causal variable, and the
swamping is confirmed.**

### Term 4 — and the one nobody has named: coverage

The table's second column is the finding this diagnosis did not expect. At the
shutter the opacity layer **covers 14.3% of the core and 7.4% of the fireball's
disc**. Even with perfect compositing it can only modulate the pixels it is
standing on.

At 0.09 s the dust skirt (`VFX.js:712-723`) is a ring of 18 sprites about 2 m
across sitting ~2 m from the centre — *inside* a fireball whose blobs are
`r * 0.6 = 3.6 m` each (`VFX.js:590`). It is not at the fireball's rim, which is
where its own comment says it needs to be ("at its own radius rather than only
at its column").

---

## 3. The control: the same layers, in the same frame, read fine

Away from the blast the alpha layer retains 82% of its effect (whole-frame row
above) and 98% in the r120-260 skirt. The defect is not "the alpha layer is
broken" and not "alpha blending is misconfigured". It is specifically **opacity
underneath a high additive pedestal, in the 260 px around a blast centre.**

---

## 4. Candidate fixes, armed on the same frozen frame

All three were rendered as arms rather than argued. Pass 4, controlled phase.

| arm | core r<40 mean L | px darkened >8 L | mean removed | peak removed | largest radial step |
|---|---|---|---|---|---|
| `full` (shipped) | 193.81 | — | — | — | **7.6 L @ r=32** |
| `alphaLast` (renderOrder swap) | 188.65 | 3454 | 23.99 L | 67.3 L | **8.9 L @ r=20** |
| `depthWrite` (alpha layer writes depth) | 173.96 | 5031 | 47.94 L | 161.1 L | **21.6 L @ r=16** |
| `both` | 188.69 | 3382 | 24.05 L | 67.3 L | 8.7 L @ r=20 |

Where each removes light (px / mean L removed):

| arm | r<40 | r40-120 | r120-260 | r>260 |
|---|---|---|---|---|
| `alphaLast` | 667 / 37.4 | 2219 / 21.6 | 58 / 9.9 | 510 / 18.3 |
| `depthWrite` | 979 / **101.6** | 2733 / 39.7 | 519 / 13.6 | 800 / 32.8 |
| `both` | 663 / 37.3 | 2189 / 21.4 | 72 / 15.7 | 458 / 18.9 |

**`alphaLast` — the fix the round-4 premise implies — is rejected on its own
measurement.** It buys 1.3 L of radial step (7.6 -> 8.9) against the round-3
critique's "no edge anywhere on this object", and it pays for that by darkening
667 core pixels by a mean 37.4 L with dust that is *behind* the fireball: with
`depthWrite` off, drawing the alpha layer last occludes unconditionally. It is
the wrong pixels, and not many of them.

**`depthWrite` triples the decisive statistic (7.6 -> 21.6 L) and is depth-correct
in principle** — additive fragments *behind* an alpha sprite are z-rejected,
fragments in front are not — **but is not shippable as-is.** It removes a mean
101.6 L from 979 core pixels, peak 161.1 L. The cause is one line:
`src/shaders/ParticleShader.js:287` discards only below `c.a < 0.004`, so a
0.4%-opacity dust fragment writes depth and deletes the fireball behind it.

---

## 5. Proposed minimal change

**Two constants and one uniform, in one file, plus one material flag.**

1. `src/shaders/ParticleShader.js:353` — `depthWrite: additive ? false : true`.
   The alpha layer writes depth; draw order is left exactly as it is
   (`ParticleSystem.js:136` unchanged), so additive fragments behind opaque dust
   are z-rejected and fragments in front of it are untouched. Depth-correct by
   construction; no ordering artifact.
2. `src/shaders/ParticleShader.js:287` — replace the fixed `c.a < 0.004` with a
   per-layer uniform `uAlphaCut`, following the pattern this shader already uses
   for `uLensFloor` / `uIntensity` / `uMaxIntensity` (per-layer values set at
   `ParticleSystem.js:81-82`). Additive keeps `0.004`. The alpha layer takes
   **~0.35**: only a fragment that is genuinely opaque is allowed to write depth
   and occlude.

**Predicted effect.** The `depthWrite` arm bounds the upside with the cut still
at 0.004: largest radial step **7.6 -> 21.6 L**, i.e. past the 15.3 L the
shipping baseline scores and well past the 8.1 L the round-6 record calls "no
edge". Raising the cut to 0.35 removes the arm's artifact — the 979 core pixels
at a mean -101.6 L, which are exactly the near-transparent fragments the cut
excludes — at the price of some of the gain. Predicted landing zone: **largest
radial step 12-18 L, core mean within ~5 L of the current 193.81**, and the
fireball gains a boundary where dust actually stands in front of it rather than
a hole where it does not.

**Verify with, and only with:** the arm harness in
`reviews/round7/diag-axis6/layerarms4.mjs` at the same controlled 0.09 s phase
(so the shutter lottery in section 0.2 cannot be mistaken for the fix), plus
`tools/vfxmeasure.mjs blast` on a fresh `08-explosion` capture against
`reviews/round6/resume/08-explosion.png`. The gate to watch for regression is
core `rClipFrac` and `disc.overL220`: this change can only remove light from the
core, so a rise in either would mean something else moved.

**Do not pair it with an additive-intensity reduction.** Measured above: the
knob returns 13%.

### Second-order, and a separate decision

Coverage (term 4) caps whatever the compositing fix returns: at 7.4% disc
coverage the opacity layer cannot silhouette what it is not standing on. The
change that addresses it is the dust skirt's geometry at `VFX.js:712-723` —
it is a 2 m ring at 2 m radius inside a 6 m fireball at the shutter, not a torus
at the fireball's rim. **That is a re-tune of an emitter's speed/size against a
documented shutter, it re-frames the shot, and it should not be bundled with the
compositing fix**: two changes landing together on one capture is how the last
three rounds lost the ability to attribute a movement.

---

## 6. What this closes and what it withdraws

- **Closed:** "add the opacity layer" (round-4 #1) — already present, three
  emitters, 64 sprites, more than the additive layer has.
- **Closed:** "the additive sum swamps it" (round-6 open item 3) — **confirmed
  and quantified**, 92:1 at the core / 36:1 on the disc in the finished pixel,
  with a four-point dose-response between the additive pedestal and the opacity
  layer's survival (98% at +4.9 L to 20% at +149.9 L).
- **Refuted:** that the implied one-line reorder is the fix. Measured: +1.3 L of
  radial step, and it occludes with dust that is behind the fireball.
- **Refuted:** turning the additive layer down. Measured: a 50% cut in
  `uIntensity` returns 13% of the core deposit.
- **New:** coverage. The opacity layer covers 7.4% of the fireball's disc at the
  shutter, and no compositing fix can raise that.
- **Withdrawn:** the `muzzleFlash` second-effect arm (null, twice) and all of
  pass 3 (blast expired at sim 0.333 s; the harness said so).
