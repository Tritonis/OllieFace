# FIX-vfx — round 6 VFX: `08-explosion` blast body, and frame-wide chromatic aberration

Answering `reviews/round5/critic-r3-ui-vfx.md` defects 1 and 2. Rubric axes 6, 8, 9.

Files changed (all within this agent's ownership):

- `src/systems/VFX.js` — one new emitter in `explosion()`
- `src/shaders/ParticleShader.js` — quad-boundary fade ramp narrowed

New measurement tooling (additive, no existing tool edited):

- `tools/vfxmeasure.mjs` — decodes capture PNGs from disk; `blast` and `aberr` modes
- `tools/vfxcrop.mjs` — magnified crops

---

## 0. Provenance, and what "before" means here

**The round-6 baseline is not the pre-fix state.** `reviews/round6/BASELINE.md` records that
`reviews/round6/base/` was captured at `fba0a91`, and `fba0a91` already contains the partial,
unreported work committed in `f9b47c4`. So this report carries **three** on-disk states, and
every number below names which one it came from:

| label | on-disk directory | code state |
|---|---|---|
| **PRE** | `reviews/round5/base-r4/` | round-5 shipping code — the frames the round-3 critic measured |
| **BASE** | `reviews/round6/base/` | `fba0a91`, i.e. PRE **plus** `f9b47c4`'s unreported partial fix |
| **NOW** | `reviews/round6/vfx/` | BASE plus this report's two changes |

Assessing `f9b47c4` before touching anything was the first thing done, per instruction, and it
mattered: **most of both targets was already fixed in it and unreported.** That work is credited
to it below rather than claimed here.

### Instrument validation

`tools/vfxmeasure.mjs blast --at 568,306` decoded on the PRE frame
`reviews/round5/base-r4/08-explosion.png` returns core RGB **(255.0, 253.6, 237.5)**, R clipped on
**100%** of core pixels, disc `r<120` mean L **229.2** / **72.66%** over L 220, and largest
annulus-to-annulus luminance step **6.6 L at r = 84**. Those are the round-3 critic's published
numbers to the digit. The instrument reproduces the critique it is answering before it is used to
score anything.

The centre is **pinned to (568, 306)** — the critic's own centre — for every frame, not
re-detected per frame. `08-explosion` is the same seed, camera and blast position throughout, so a
per-frame search would let two measurements land on different objects and report the difference as
a fix. (A first pass with automatic centring found (1152, 239) — the sky, not the blast. Pinning is
not a convenience here, it is the difference between a measurement and an artifact.)

### Capture isolation — required, and a correction to a first attempt

The first full capture of NOW was run in the shared working tree and came back with **11 errors**
and `08-explosion`'s "the blast" subject failing outright. That was **not** this change: a parallel
agent's in-flight `src/world/Materials.js` had a fragment shader that would not compile
(`ERROR: 'detField' : no matching overload`), and every terrain-bearing shot was rendering against
a broken material. **That capture was discarded and is not cited anywhere in this report.**

All NOW numbers come from a detached `git worktree` at `fba0a91` carrying **only** this report's
two diffs, captured with `node tools/capture.mjs --port 5207`, then copied to
`reviews/round6/vfx/`. The worktree was given its own `node_modules/.vite` and `.vite-temp` (the
shared ones caused `504 Outdated Optimize Dep` between concurrent vite servers). `npm install` was
never run.

---

## 1. `08-explosion` — the blast reads as a body, not a clipped sticker

### What `f9b47c4` had already fixed (verified, not assumed)

`reviews/round5/base-r4/08-explosion.png` → `reviews/round6/base/08-explosion.png`:

| measure (core = `r < 40 px`, disc = `r < 120 px`) | PRE | BASE |
|---|---|---|
| **core pixels with R clipped** | **100%** | **0%** |
| core mean RGB | 255.0, 253.6, 237.5 | 239.6, 214.5, 176.0 |
| disc mean L | 229.2 | 186.4 |
| disc % over L 220 | 72.66% | 4.91% |
| disc % over L 250 | 12.81% | 0% |

The critic's fix (a) asked for "≤ 8% of the disc at ≥ L 250 instead of the inner 80 px at 100%".
BASE is at **0%**. The mechanism was `f9b47c4`'s change in `ParticleShader.js` from a per-channel
`min(c.rgb, k)` — a whitener, which destroys the very tint it exists to protect — to a
largest-channel scale that preserves the channel ratio. The core is now demonstrably orange
(243/219/181) rather than neutral (255/254/238). That analysis was correct and it holds up.

**The blast light cap was also already in place** and is the instruction's "cap at `08-explosion`'s
own values so only the nuke moves": `VFX.js` `explosion()` ends with
`this.lights.flick(pos, colour, Math.min(20 * s, 30), Math.min(r * 4.2, 25.2), 0.42)`. At
`08-explosion`'s own `r = 6` that is exactly intensity 30 over 25.2 m, so every blast at or below
this shot's size is untouched **by construction** and only larger blasts are pulled back. Nothing
global was darkened. No further change was needed and none was made.

### What was still broken, and what this change does

The critic called the gradient "the decisive number": *"the largest luminance step anywhere in the
falloff is 6.6 L. There is no edge anywhere on this object."* Fixing the clipping did **not** fix
that. BASE is a gaussian that no longer clips:

| | PRE | BASE |
|---|---|---|
| largest 4 px annulus-mean step | 6.6 L @ r 84 | 8.1 L @ r 84 |

Visually confirmed at 2× on `reviews/round6/crops/now-blast.png` (from
`reviews/round6/base/08-explosion.png`): a formless warm haze with embers and debris streaks over
it, and no boundary anywhere.

**Cause.** The two shockwave rings are world-space discs. Whatever `_ringAxis` does to their normal
they still project to an *ellipse*, so they put an edge on two sides of the fireball and nothing on
the other two — and a radial profile averages that away to nearly nothing. Nothing in the effect
was concentric with the fireball on screen.

**Change 1 — `src/systems/VFX.js`, emitter "3b. Fireball rim".** One camera-facing additive
billboard on `FRAME.SHOCK`, sized so the frame's bright band (at 0.93 of the tile radius) lands on
the fireball's own world radius and expands through it across the shutter window. A billboard is
concentric with the fireball in *screen* space by construction, on every side, from every camera.
`soft = 1.0` fades it into terrain so it cannot draw a hard arc across the ground.

**Change 2 — `src/shaders/ParticleShader.js`, quad-boundary fade `0.74 → 0.90`.** Change 1 on its
own did essentially nothing, and measuring that is what found the real bug.
`reviews/round6/vfx-mine/08-explosion.png` is the rim emitter added with `f9b47c4`'s fade ramp
untouched:

| | BASE | rim only, fade at 0.74 |
|---|---|---|
| per-ray gradient, median | 46.2 L | **44.6 L** |
| annulus-mean step | 8.1 L | **7.4 L** |

The rim contributed luminance and *no edge at all*. `f9b47c4` had added
`c.a *= 1.0 - smoothstep(0.74, 1.0, rq)` to guarantee a sprite is transparent at its own polygon
boundary. But `rq` is 1.0 at the middle of every quad edge and 1.414 at the corners, so **every**
point of the polygon boundary is already at `rq >= 1.0`: a ramp that reaches zero at 1.0 is a
complete guarantee, and every unit of ramp below 1.0 is spent eating the atlas instead of the
outline. `shockRing` — the one frame in the atlas with a genuinely sharp edge — puts its bright
band at 0.93, where the 0.74 ramp leaves **18%** of its alpha. The sharp ring was, in effect,
switched off engine-wide. Narrowing the ramp to `0.90 → 1.0` preserves the guarantee exactly (still
zero at every boundary point) and gives back only the 0.74–0.90 band, which is precisely where
sharp-edged frames live. `softRing` (0.78) and the gaussian frames are unaffected either way.

### Result

`reviews/round6/base/08-explosion.png` → `reviews/round6/vfx/08-explosion.png`, and PRE for context:

| measure | PRE | BASE | **NOW** |
|---|---|---|---|
| **core pixels with R clipped** | **100%** | 0% | **0.6%** |
| core mean RGB | 255.0, 253.6, 237.5 | 239.6, 214.5, 176.0 | 243.3, 219.4, 181.4 |
| **per-ray gradient, median** | **21.5 L** | 46.2 L | **57.4 L** |
| per-ray gradient, p75 | 32.9 L | 68.3 L | 81.6 L |
| annulus-mean step | 6.6 L @ r 84 | 8.1 L @ r 84 | 9.2 L @ r 80 |
| disc mean L | 229.2 | 186.4 | 182.4 |
| disc % over L 220 | 72.66% | 4.91% | 9.03% |
| disc % over L 250 | 12.81% | 0% | **0%** |

**On the two gradient instruments.** Both are reported; neither replaces the other, and both are
computed identically on every frame. The **annulus-mean** step is the critic's instrument and it
moves only 6.6 → 9.2 L, because it averages *around* the blast, and an expanding rim photographed
mid-flight is never perfectly concentric or perfectly still — a ring is close to invisible to it by
construction. The **per-ray** measure walks 180 rays out from the centre and asks the question the
eye asks: on a typical ray, is there anywhere the value falls off a cliff? It moves **21.5 → 57.4
L**, and its reading is corroborated by the causal chain above (rim without the shader fix: 44.6;
rim with it: 57.4) and by the crops. It is presented as an additional instrument, not as a
replacement for a number that did not move as far as hoped.

**The 0.6% honestly.** NOW re-clips R on 0.6% of core pixels where BASE was at 0%. The rim's alpha
was already trimmed 0.5 → 0.42 for exactly this reason (at 0.5 it was 0.84%, measured on the
capture that produced `reviews/round6/crops/rim-blast.png`). 0.6% of the core is roughly its
hottest few dozen pixels — a highlight, not the hueless 100% plateau the defect was about — and the
core stays plainly orange at 243/219/181. Buying a 24% larger typical edge for a fraction of a
percent of clipped highlight is the trade this defect asked for, but it is a trade and not a free
win, and it is stated as one.

**Visual:** `reviews/round6/crops/now-blast.png` (BASE) vs `reviews/round6/crops/final-blast.png`
(NOW), both cropped from the named PNGs at (408, 176) 320×260 at 2×. NOW shows a spherical boundary
the eye can find; BASE does not.

### Not done, and why

Critic fix (d) — requiring the harness to place the blast centre against terrain — is in
`src/core/Harness.js`, owned by the harness agent this round. Untouched.

---

## 2. Frame-wide radial chromatic aberration

This was fixed in full by `f9b47c4`, in `src/core/RenderPipeline.js`: the `uAberration` uniform went
from `0.0016 + min(aberration + shake*0.004, 0.004)` (0.0016 at rest, 0.0056 boosted) to a
`base 0.00042 + boost 0.00022` ramp, ~4× down at rest and ~8× down at peak. **Nothing was added
here.** It is verified rather than claimed, because the round-3 critic re-raised this defect after
having wrongly withdrawn it in round 2 on a HUD chamfer — an element composited *after* post, the
one class of edge in the frame that cannot carry the effect.

**Instrument.** Per-channel strongest-gradient position on strong vertical edges, the critic's own
method, with one addition: sampling is confined to the `y ∈ [90, 470]` 3D-only band, so the round-2
error cannot recur, and each edge must show a real gradient in **all three** channels or the
"position" of a channel with no edge is just noise. Reported as R-to-B separation in px, median and
p90 over hundreds of edges per margin window.

`reviews/round5/base-r4/*.png` → `reviews/round6/vfx/*.png`:

| shot | left margin PRE → NOW | right margin PRE → NOW | centre PRE → NOW |
|---|---|---|---|
| `08-explosion` | **+3 px** (p90 8) → **0 px** (p90 2) | **−3 px** (p90 5) → **−1 px** (p90 4) | 0 → 0 |
| `04-combat` | **+3 px** (p90 6) → **+1 px** (p90 1) | **−3 px** (p90 7) → **−1 px** (p90 1) | 0 → 0 |
| `10-inventory` | 0 px (p90 4) → 0 px (p90 1) | **−3 px** (p90 4) → **−1 px** (p90 4) | 0 → 0 |
| `02-vista` | +1 px (p90 4) → +1 px (p90 4) | −1 px → −1 px | 0 → 0 |

Unsigned median separation, the single summary number:

| shot | PRE | NOW |
|---|---|---|
| `08-explosion` | **4 px** left / **4 px** right | **1 px** / **1 px** |
| `04-combat` | **4 px** / **5 px** | **1 px** / **1 px** |
| `10-inventory` | 0 px / **4 px** | 0 px / **1 px** |
| `02-vista` | 2 px / 2 px | 1 px / 1 px |

The critic asked for "≤ 1.5 px at the frame corner (roughly a 6× reduction)". Margin medians are at
**1 px**, the sign flip left-vs-right is gone from the median, and the p90 tail on the two worst
shots drops from 6–8 px to 1–4 px. Confirmed visually: `reviews/round5/base-r4/08-explosion.png`
shows red/cyan fringing on the frame-edge rocks that is absent from
`reviews/round6/vfx/08-explosion.png`.

The critic's other two suggestions (three radial taps instead of a per-channel UV scale; running
the pass before bloom) were **not** implemented. At 1 px of separation the aliasing they address is
below the measurement floor, and reordering the post stack is a larger blast radius than this
defect now justifies.

---

## 3. Gate status

`reviews/round6/vfx/manifest.json` — `ready: true`, `clockPinned: true`, `partial: false`,
`subjectsOk: false`, **`errorCount: 4`**.

Failing shots are **exactly** `BASELINE.md`'s four, with the same subjects:

| shot | baseline failing subjects | NOW |
|---|---|---|
| `04-combat` | horde, open arena, survivor unoccluded | same three |
| `08-explosion` | monsters standing in it, **damage numbers** | monsters standing in it — **damage numbers now passes** |
| `09-survivors` | the four survivors | same |
| `11-bestiary` | the whole spawn roster | same |

Not worse than baseline on any shot, one subject better. `08-explosion`'s "the blast" subject
passes. Production build green in the isolated tree (`npx vite build`, `✓ built in 1.86s`).

> The main working tree's `vite build` currently fails in
> `builtin:vite-dynamic-import-vars`, from another agent's in-flight realms edit. Not from these
> files; the same two diffs build clean in isolation.

## 4. The dissolve trap — not touched

`VFX.js:1424`'s `resolveObject` still does not know about `Enemy.rig.root`, so `deathDissolve`
still does not fire for monsters. **Deliberately left alone.** It is optional work, it was ranked
below the two targets, and per `reviews/round5/DIAG-invisible-enemies.md` §5 the obvious one-line
fix arms a live invisible-enemy bug via the `visible = false` at `VFX.js:1269` on a rig
`Director.clear()` may have recycled. Shipping invisible enemies is far worse than shipping a
dissolve that does not run. No visibility sibling guard was added and no half-fix was left behind.

## 5. Reproducing every number here

```
node tools/vfxmeasure.mjs blast --at 568,306 \
  reviews/round5/base-r4/08-explosion.png \
  reviews/round6/base/08-explosion.png \
  reviews/round6/vfx/08-explosion.png

node tools/vfxmeasure.mjs aberr \
  reviews/round5/base-r4/04-combat.png reviews/round6/vfx/04-combat.png
```

Every input is a PNG committed on disk. No number in this report comes from `tools/vfxprobe.mjs`,
and no number comes from a live re-render.
