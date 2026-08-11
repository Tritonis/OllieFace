# FIX — axis 6: the opacity layer gets a depth relationship with the fireball

Implements the change decided in `reviews/round7/DIAG-axis6-vfx.md` §5: the alpha
particle layer writes depth, draw order untouched, and the fragment discard
threshold becomes a per-layer uniform.

Branch `worktree-agent-afbbfb82e51f43255`, based on `39bf2bc`. Build green,
47/47 test files green (41 assertions in the last file, 0 failed).

**Headline, at the pinned 0.09 s phase the diagnosis requires:** largest radial
luminance step about the blast centre **7.4 L → 14.6 L**, inside the 12-18 L
landing zone §5 predicted. The artifact class §4 flagged — 979 core px at a mean
−101.6 L from near-transparent fragments writing depth — is **gone**: 300 px
remain at −93.9 L and they are opaque-dust occlusion rather than the artifact
(proof in §3 below).

**And one finding that was not in the diagnosis, which is why this report
recommends against merging as-is.** The threshold §5 specifies is a *discard*,
so on the alpha layer it is a visibility cut as well as a depth cut. At 0.35 it
deletes three emitters outright — they can never reach it — and takes the soft
outline off every alpha sprite in the game. A variant that separates the two
jobs was armed on the same frozen frame and **buys the same radial step (14.4 L)
with none of that cost**. See §6.

---

## 1. What shipped in the commit

`src/shaders/ParticleShader.js`, one file:

1. `depthWrite: !additive` on the material. The alpha layer writes depth; the
   additive layer does not. `mesh.renderOrder` (`ParticleSystem.js:136`,
   additive 12 / alpha 10) is **unchanged**, per §5 — the reorder was armed in
   the diagnosis and rejected on its own measurement.
2. `uAlphaCut`, a per-layer uniform replacing the fixed `c.a < 0.004`, following
   the `uLensFloor` / `uIntensity` / `uMaxIntensity` pattern. Values in the new
   `ALPHA_CUT` export: `{ add: 0.004, alpha: 0.35 }`.

Confirmed live on the frozen frame before any arm rendered
(`reviews/round7/diag-axis6/layerarms5.mjs` prints it):

```
add   { renderOrder 12, depthWrite false, alphaCut 0.004, alive 1176 }
alpha { renderOrder 10, depthWrite true,  alphaCut 0.35,  alive 510  }
```

Nothing in `src/fx/ParticleSystem.js` changed: `createParticleMaterial` already
defaults per-layer constants off `additive`, so the layer construction at
`_makeLayer` picks both new values up without a call-site edit.

## 2. The instrument, and the one way it is weaker than the diagnosis'

`reviews/round7/diag-axis6/layerarms5.mjs` is pass 4's method unchanged — freeze
the shot, emit a controlled `explosion(pos, 6)` at the harness blast's world
position, advance particle time by exactly 0.09 s, re-render that one frame per
arm. It runs against the **fixed** tree, so the un-toggled arm is the shipped fix
and the `p5-pre` arm restores `depthWrite false` + cut `0.004`. Both therefore
come out of one boot, one emission and one phase: the shutter lottery in DIAG
§0.2 cannot enter this comparison, and neither can a re-jittered particle field.

PNGs: `reviews/round7/captures/fix-axis6-arms/arm-p5-*.png`. Analyser:
`reviews/round7/diag-axis6/analyse5.mjs`, run at centre `568,326` — the centre
the diagnosis' own numbers use, so the two tables are read against the same
origin.

**Calibration A, and its limitation stated rather than buried.** `p5-pre` and
`p5-pre2` are the same frozen frame rendered twice with the same toggle applied.
Result: **7,851 unstable px, dilated mask 159,215 px (13.6% of frame), residual
after the mask max |dL| 0.497 on 0 px.** That mask is far larger than pass 4's
(269 unstable, 543 px masked) because every arm here re-applies a material
toggle and recompiles the program between renders. The residual is clean, so no
number below is reading render noise — but 13.6% of the frame is excluded from
every count, and the counts in §3 are therefore lower bounds, not totals.

**Absolute means are not comparable to the diagnosis'**, only to each other:
this boot's frame carries the harness scenario's own blast as well as the
controlled one, so `p5-pre` reads core 206.04 where DIAG §4's `p4-full` read
193.81. Every comparison in this report is pre-vs-post *within* one boot.

## 3. The decisive statistic, before and after

Source: `reviews/round7/captures/fix-axis6-arms/`, analysed by `analyse5.mjs`.

| arm | alpha cut | core r<40 | disc r<120 | largest radial step |
|---|---|---|---|---|
| `p5-pre` (pre-fix) | 0.004, no depth write | 206.04 | 159.66 | **7.4 L @ r=156** |
| **`p5-post` (shipped)** | **0.35** | 199.16 | 155.76 | **14.6 L @ r=28** |
| `p5-cut15` | 0.15 | 197.21 | 154.49 | 17.0 L @ r=28 |
| `p5-cut25` | 0.25 | 198.33 | 155.24 | 15.7 L @ r=28 |
| `p5-cut45` | 0.45 | 200.30 | 156.22 | 14.5 L @ r=28 |
| `p5-prepass` (§6) | 0.004 colour / 0.35 depth | 199.13 | 155.86 | 14.4 L @ r=28 |

The pre-fix arm's largest step sits at r=156, i.e. **nowhere near the fireball** —
which is the round-3 critique's "no edge anywhere on this object", reproduced.
Every post arm puts its largest step at r=28, on the fireball's own rim.

**The artifact class.** Pixels darkened >8 L against `p5-pre`, by radius:

| arm | r<40 | r40-120 | r120-260 | r>260 |
|---|---|---|---|---|
| DIAG §4 `depthWrite`, cut 0.004 | **979 / −101.6 L** | 2733 / −39.7 | 519 / −13.6 | 800 / −32.8 |
| `p5-post` (cut 0.35) | **300 / −93.9 L** | 1820 / −60.5 | 1550 / −20.3 | 1257 / −14.0 |
| `p5-cut15` | 356 / −101.6 | 2113 / −70.3 | 1602 / −22.5 | 471 / −15.3 |
| `p5-cut45` | 268 / −87.7 | 1737 / −56.6 | 1565 / −19.7 | 1516 / −15.1 |
| `p5-prepass` | 300 / −94.3 | 1650 / −65.7 | 1130 / −22.4 | **161 / −13.2** |

Core artifact count **979 → 300**, a 69% cut. And those 300 are not the artifact:
the `prepass` arm draws *every* fragment the pre-fix arm drew and only lets
fragments at ≥0.35 occlude, so it cannot contain a near-transparent-fragment
artifact by construction — and it reports the same 300 px at the same −94 L. The
residual core darkening is opaque dust standing in front of the fireball, which
is the mechanism the fix exists to create.

No arm brightens anything meaningfully (`p5-post`: 18 px >8 L, peak +17.4 L),
which is the tell for a wrong occlusion, and it is absent.

## 4. On the shipped shot, at the shutter the harness actually takes

`tools/vfxmeasure.mjs blast`, auto-centre, on the capture frames:

| | control (pre-fix) | post-fix |
|---|---|---|
| centre found | 1062,500 | 1059,501 |
| core meanL | 95.0 | 95.3 |
| core `rClipFrac` | 0 | **0** |
| disc meanL | 91.7 | 91.9 |
| disc `overL220` | 0.0150 | **0.0148** |
| ray gradient median | 46.5 | **51.2** |
| largest step | 13.3 L @ r=20 | 13.7 L @ r=20 |

Both regression gates §5 names hold: `rClipFrac` stays 0, `overL220` goes down.
The ray gradient steepens 10%, and the step moves +0.4 L — **far less than the
+7.2 L the pinned arm shows**, because `08-explosion`'s own shutter lands late,
with the additive pedestal already decayed and little left to z-reject. This is
the same shutter drift DIAG §0.2 documented; it is the reason the pinned arm is
the instrument of record and this table is context, not the verdict.

## 5. Full-capture comparison, against a same-tree control

Three captures, all seed 1337: **control** (pre-fix tree, port 5319), **control2**
(pre-fix tree again, port 5321 — the noise floor), **post** (fixed tree, port
5317, `--out reviews/round7/captures/fix-axis6`).

**Subject gates: no change at all.** All three runs fail exactly the same three
subjects with the same detail — `06-loaded-hud` (monsters under load),
`19-overkill` (launched corpse / survivor / lift), and `10-inventory` (monsters
standing in it). All three are pre-existing at the base commit; `10-inventory` is
tracked as its own defect and, like the other two, is **byte-identical pre and
post on this branch** (`perPx [6,25,0,0,0,19,6,34]`, same `perSep`, same
`objectFailures`). Nothing here moved it. No gate that was green went red.

**Shared-RNG hazard: clear, and provably so.** Every per-object subject pixel
array is byte-identical across all three runs — `04-combat`'s 24-strong horde
digit for digit, `06-loaded-hud`'s 10, `10-inventory`'s 8. A change to
`ctx.fxRng` draw counts could not leave those untouched. Draw-order neutrality
holds too: `renderOrder` is unchanged and the uniform is set at material
construction, so no emitter path was touched.

**Gated numbers that moved beyond the noise floor.** The two control runs fix the
floor for these counters at 1-2 px:

| counter | control | control2 | post | movement | gate |
|---|---|---|---|---|---|
| `08-explosion` the blast, carriedPx | 24425 | 24426 | **24229** | **−196 px (−0.80%)** | passes |
| `10-inventory` the equipment blast | 18737 | 18739 | **16181** | **−2556 px (−13.6%)** | passes |
| `19-overkill` the kill burst | 575 | 575 | 573 | −2 px | passes |

Both real movements are **reductions in blast pixel area**, in the direction the
fix predicts: dust that used to be composited under the additive sum now
occludes it. The `10-inventory` figure is the large one, and `10-inventory` is
the shot whose `overload-cell` detonates a 12 m fireball six metres from the lens
— the most alpha-covered blast in the set, so the biggest change. **Reported, not
re-baselined; no gate was touched or tuned.**

**Shot-level pixel diffs do not resolve this change, and the control proves it.**
`tools/shotdiff.mjs`, % of pixels differing >8 L:

| shot | same-tree noise (control vs control2) | fix (control vs post) |
|---|---|---|
| 04-combat | 13.53% | 9.87% |
| 06-loaded-hud | 7.44% | 10.93% |
| 08-explosion | 19.60% | 27.94% |
| 10-inventory | 7.46% | 10.99% |
| 19-overkill | 10.25% | 11.75% |
| every static shot (14-18) | 0.00% | 0.00% |

The harness's particle shots move 7-20% of their pixels between two runs of an
**identical tree**. The brief's ~0.68% figure does not hold for these five; on
`04-combat` the fix's own movement is *below* the same-tree floor. `tools/shotdiff`
cannot attribute anything here, which is precisely why the frozen-frame arms
exist. (`reviews/round7/diag-axis6/signdiff.mjs` confirms the movement is
symmetric — ~47k px darker and ~45k px brighter on `04-combat` — the signature of
run-to-run displacement, not of systematic occlusion.)

Audio is green in all three runs and varies as much between the two controls as
it does to post (`stepsEmitted` 337 / 278 / 242, voices 5 / 11 / 8). `musicPeak`
reads 0.154 on post against 0.006-0.008 on the controls; it is a floor gate, it
passes, and a fragment-shader constant has no path to the music bus. Noted, not
attributed.

## 6. The cost the diagnosis did not price, and the variant that avoids it

DIAG §5 treats raising the cut to 0.35 as paying "some of the gain". It buys back
more than that, because **this test is a `discard`**: a fragment below the
threshold is not drawn dimmer, it is not drawn at all. On the alpha layer the
same constant now decides *both* "may this fragment occlude" and "is this
fragment visible", and those two questions do not have the same right answer.

A sprite's peak alpha is its emitter's `alpha0`: `emit()` writes it straight into
`aCol0.w` (`src/fx/ParticleSystem.js:207`, `:274`), the vertex stage only ever
multiplies it by factors ≤ 1 (fade-in, `(1-u)^alphaPow`, lens floor — 1.0 on this
layer), and the fragment stage multiplies by the atlas alpha, also ≤ 1. So
`c.a ≤ alpha0`, always. Three emitters have `alpha0 < 0.35` and therefore
**cannot produce a single surviving fragment at this cut**:

| emitter | `alpha0` | source |
|---|---|---|
| `teleporterAura` dust | 0.16 | `src/systems/VFX.js:1026` |
| `missile` smoke trail | 0.30 | `src/systems/VFX.js:1249` |
| `muzzleFlash` smoke puff | 0.32 | `src/systems/VFX.js:324` |
| `ring` dust | 0.35 (exactly at it) | `src/systems/VFX.js:1212` |

That is arithmetic, not an estimate. Beyond outright deletion, every surviving
alpha sprite — the explosion's smoke column (0.82) and dust skirt (0.55),
`impact` dust (0.40), `bloodHit` mist (0.42), the `bleed`/`slow` status puffs —
now ends at a **hard circle** where `c.a` crosses 0.35 and **pops out** when its
fade takes it under. The quad-boundary fade twenty lines above the discard exists
to guarantee the opposite ("the alpha edge must never be the polygon edge",
against the axis-6 four-marker "hard-clipped particle edges"), and a 0.35 cut
hands that marker back on every alpha sprite in the game.

No value of the constant fixes this, because one switch is doing two jobs: any
cut high enough to stop a 0.4%-opacity fragment from deleting the fireball is
high enough to delete a 30%-opacity smoke puff.

**The variant, armed on the same frozen frame (`p5-prepass`).** Leave the alpha
colour pass exactly as it was — cut 0.004, no depth write, soft edges intact —
and draw the same geometry a second time with `colorWrite: false`,
`depthWrite: true`, cut 0.35, at `renderOrder 11`: after the alpha colour pass,
before the additive layer. Depth is then stamped only where the dust is genuinely
opaque, the additive layer behind it is z-rejected, and no fragment is deleted or
hard-edged. Measured above:

- largest radial step **14.4 L** against the shipped fix's 14.6 L — the same buy;
- the same 300 px / −94 L at the core;
- **161 px darkened at r>260 against the shipped fix's 1,257** — the collateral
  away from the blast is 8x smaller, which is the deletion showing up as numbers;
- cost: one extra draw call on a layer that has one, no colour write.

**Recommendation: take the prepass variant, not the shipped constant.** It is an
architecture change (a second mesh and pass) rather than the two constants §5
decided, so it is not in this commit — that call belongs to the owner. This
branch carries the decided fix, measured, with its cost priced.

## 7. Per-effect verdicts, and the instrument that failed to give them

`reviews/round7/diag-axis6/effectarms.mjs` emits each alpha-emitting effect alone
at a known-visible world position and differences it against a frame with only
the alpha layer hidden. Two runs were discarded and the record is here rather
than the numbers:

- **Run 1 was contaminated** and said so plainly: `healPop`, which emits **0**
  alpha sprites, measured 11,513 px of alpha-layer coverage. The harness's own
  explosion was still alive underneath every effect. Fixed by aging the system
  4 s (past the longest alpha lifetime) before emitting.
- **Run 2 was uncalibrated**: with the emission counts then matching the source
  census exactly (`explosion` 58 additive / 64 alpha, as DIAG §1 counts them),
  the four zero-alpha effects still read 1,836-2,210 px — drift between
  consecutive re-renders.
- **Run 3 added the pass-4 calibration mask.** The three zero-alpha null arms
  then read **0 px**, correctly. But the instrument's floor is ~400 px (`impact`,
  `missile` and `shieldBreak` all read an identical count pre and post at ~8 L,
  i.e. at the floor), which is the same order as the signal for every small
  effect. Above the floor it reads `explosion` 2067 → 1614 px (−22%) and
  `bloodHit` 748 → 617 px (−18%).

**So the per-effect question is answered by §6's arithmetic, not by this probe**,
and I am not reporting per-effect pixel verdicts the instrument cannot carry. By
eye, `08-explosion` control vs post
(`reviews/round7/captures/fix-axis6-cmp-08.png`) shows no visible difference at
that shot's late shutter — consistent with §4's +0.4 L.

## 8. What is not in this change

Coverage — the alpha layer standing on 7.4% of the fireball's disc, DIAG §4's
term 4 — is untouched, as briefed. It remains the ceiling on whatever this
compositing fix returns, and the dust skirt's geometry (`VFX.js:712-723`) is the
owner's decision, unbundled from this one.

## 9. Sources on disk

- Arms: `reviews/round7/captures/fix-axis6-arms/arm-p5-*.png`
- Per-effect arms: `reviews/round7/captures/fix-axis6-effects3/`
- Captures: `.../fix-axis6-control/`, `.../fix-axis6-control2/`, `.../fix-axis6/`
- Diffs: `.../fix-axis6-diff.json` (fix), `.../fix-axis6-noisefloor.json` (control-vs-control)
- Probes and analysers: `reviews/round7/diag-axis6/layerarms5.mjs`,
  `analyse5.mjs`, `effectarms.mjs`, `effectanalyse.mjs`, `signdiff.mjs`,
  `compose.mjs`
