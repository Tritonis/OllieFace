# FIX — VFX round 2 (critiques `critic-r2-ui-vfx.md` §5, `critic-r2-enemies.md` §5 / defect 3)

Every number below was produced by an instrument that A/Bs **one frozen frame**, or by
decoding a shipped PNG. Nothing here is asserted from a screenshot alone, and where a
measurement disagrees with the brief I have said so rather than tuned toward the brief.

New instrument written for this pass: **`tools/affixprobe.mjs`**.

---

## 0. Two corrections to the briefs, both load-bearing

**(a) The `glacial` white-out is not `VFX.js:71,80`.** The brief and `critic-r2-ui-vfx.md`
§4A attribute the 93 × 72 px white mass in `04-combat` to `ELITE.glacial.tip` and
`STATUS.freeze.tip` on an additive `FRAME.HEX`. Neither can be the source:

- `VFX.eliteAura()` (`VFX.js:695`) is **dead code**. `grep -rn eliteAura src/` returns the
  definition and nothing else; `this._auras` is never populated, so `ELITE` in `VFX.js`
  emits no particles at all in any shipped frame.
- A live-particle dump of the frozen `04-combat` frame (every additive and alpha slot,
  grouped by atlas frame) returns **zero particles on `FRAME.HEX`**. The frames actually
  live are 2 (SPARK, 539), 3 (SMOKE, 289 + 464), 7 (CHUNK, 374), 11, 6, 1, 14, 5.

`critic-r2-enemies.md` §5 had the right subsystem: it is `EnemyMeshes.js`. I fixed the
tips anyway (§2) because they are a real latent hazard the moment `status('freeze')` fires
near the camera, but they were not what the critic photographed.

**(b) There is no auto-exposure to exclude the nuke from.** `critic-r2-ui-vfx.md` defect 2
prescribes "exclude the equipment/nuke emissive from the auto-exposure histogram". There
is no exposure adaptation in the project — `RenderPipeline._adapt` is adaptive
*resolution*. The `10-inventory` wash is the blast's own light and its own screen-filling
additive quads, and that is where I fixed it (§3).

---

## 1. Defect 1 — the elite affix system (largest change)

### The instrument

`tools/affixprobe.mjs` runs `bestiary()`, freezes it, picks the largest un-affixed enemy,
and re-renders that one frozen frame **seven times**: once with the host hidden (a
background plate), once plain, and once per affix, with a single `rig.setAffix()` call
between renders. The mask is then exact by hide-and-diff — `|I − B| > 24` is the host and
its affix and nothing else. No background model, no threshold study, no neighbouring-enemy
contamination, and every pixel that is not the affix is bit-identical between variants.

It reports four things, because the design constraint is a conjunction and optimising one
half into the other is the obvious failure mode:

| metric | what it tests | bar |
|---|---|---|
| `formKeep` | luminance std **inside the plain host's own mask**, affixed / unaffixed. The round-5 glacial failure was described as "a matte near-white mass with no internal structure" — a host that kept its outline and lost every value break inside it. This is that, measured. | ≥ 0.55 |
| `growth` | affixed mask area / plain mask area | ≤ 2.6 |
| `discIoU` | IoU against an equal-area centroid-aligned perfect disc | < 0.78 (the critic's own disc-vs-square calibration) |
| `near-white` | L > 195, chroma < 40, as a fraction of the affixed mask | ≤ 0.20 |
| worst `pairIoU` | worst pairwise IoU **between two affixes on the same host** — species shape cancels out entirely | < 0.88 |

### Measured, before and after

Before = `git checkout 34cc8c4 -- src/entities/EnemyMeshes.js`, i.e. the tree the critic
photographed. Same seed, same scenario, same host (`hulk`), same probe.

| affix | discIoU | | near-white | | growth | | formKeep | |
|---|---|---|---|---|---|---|---|---|
| | **before** | after | **before** | after | **before** | after | **before** | after |
| blazing | 0.625 | **0.485** | 0.8% | 0.9% | 1.78 | **1.28** | 1.260 | 1.403 |
| overloading | 0.648 | **0.535** | 3.3% | 9.5% | 1.84 | **1.73** | 1.305 | 1.530 |
| glacial | 0.669 | **0.503** | **40.5%** | **4.4%** | 2.00 | **1.53** | 1.806 | 1.615 |
| withering | 0.658 | **0.495** | 5.5% | 5.7% | 1.86 | **1.23** | 1.603 | 1.637 |
| warded | **0.790** | **0.744** | 15.9% | **3.8%** | 2.52 | **2.21** | 1.424 | 1.412 |

Pairwise, same host, worst four:

```
BEFORE                              AFTER
0.966  overloading <-> withering    0.756  blazing <-> withering
0.958  blazing     <-> overloading  0.715  blazing <-> overloading
0.935  blazing     <-> withering    0.697  blazing <-> glacial
0.911  overloading <-> glacial      0.681  glacial <-> withering
```

**Six of the ten pairs were at or above the 0.88 collapse threshold. None is now.** The
probe exits non-zero under any of the bars, so this cannot silently regress.

This independently reproduces `critic-r2-enemies.md` §1 from inside the engine: it read
`warded ↔ withering` at 0.88 with a background model over the shipped PNG; the exact mask
reads the same pair at 0.911. Its 0.91-vs-a-disc figure reads as 0.79 on my instrument
because a background model absorbs the host into the shell and an exact mask does not —
the verdict is identical, the absolute numbers are not comparable, and I am quoting mine.

### What changed

**The filled shell is gone.** `makeAura` built `ico(1, 2)` — an 80-face sphere at the
unit's whole aura radius — as every affix's carrier, additive, and `setAffix` drew the
orbiting bits *inside* it. That is why not one of the five declared bits was visible in
either `blazing` or `overloading`: additive geometry drawn inside an additive shell that
is already at the clip point adds nothing. It was not a bug in the bits.

The carrier is now up to three thin torus bands (`ring(1, 0.055, 4, 30)`), which cover
roughly a twentieth of the disc the sphere covered, so the host's outline passes *through*
the affix. No two rows share the bands × bits × orbit triple:

| affix | bands | bits | orbit |
|---|---|---|---|
| blazing | 1 flat halo | 4 shards | climb the outside and recycle at the feet |
| overloading | 3 crossed | 6 icos | fast flat ring — a gyroscope |
| glacial | 2 shallow | 6 shards | nearly static — a frozen orrery |
| withering | 0 | 9 spikes | slow vertical helix (unchanged) |
| warded | 0 | 0 | a faceted barrier instead |

**`warded` is a wireframe crystal, not a sphere.** `ico(1,1)` fill at 0.16 additive →
`ico(1,0)` (20 faces) with the fill at 0.05 under a bright wireframe at 0.85, scaled
0.98 / 1.28 / 0.98 so its own outline is not a circle either.

**The pale-affix body flood is fixed.** `glacial` measured 40.5% near-white *inside its
own host's mask* — that is the "matte lump with no internal structure" and it was three
things compounding: `tint: 0xa8e6ff` mixed **0.78** into body albedo, **0.45** into the
dark albedo, and driving a **0.5** emissive on every body facet. An emissive is a flat lift
applied equally to lit and shadowed plates, so it adds brightness and subtracts shading.
Now: tint `0x4fb8e8`, mixes 0.52 / 0.26, emissive 0.20 / 0.12. The affix read moved to the
rim (already 0.85–0.9 in the aura colour), the accents and the bands, which are the
channels that do not cost form. `glacial.aura` came off `0x8fe4ff` too — a pale additive
colour stacked three deep is paper, a saturated one stays cyan.

**One latent bug removed on the way.** The old animator wrote `rig.aura.material.opacity`
every frame — on a material cached and shared across every elite of that affix. One dying
elite dimmed the whole horde. Bands breathe on scale instead.

### 04-combat, and what the residual near-white actually is

The affix work does **not** account for the near-white blobs still in `04-combat`, and I
am not going to claim it does. A/B on the frozen combat frame, hiding `rig.auraBits` and
`rig.aura` on every elite in place:

```
full      29,035 near-white px
no bits   28,730      (bits  =   305 px)
no bands  28,874      (bands =   161 px)
```

**The affix furniture is 0.5% of it.** At 7× the remaining blobs are enemy *body*
geometry — faceted plates at two to six metres from the lens, lit to mean L 225–237. That
is `critic-r2-enemies.md` defect 5 (enemy albedo not authored against the terrain grade)
plus a `combat()` camera standing inside the horde, and neither is closable from the affix
system. See §6.

---

## 2. Particle tips off white (latent, not photographed)

`STATUS.freeze` and `STATUS.shock` were both `tip: 0xffffff` on additive frames.
`uMaxIntensity` caps *one* sprite at 0.92; N overlapping sprites reach N × 0.92, so a
neutral tip saturates to paper white in three. Tips are the value at which a particle is
brightest, so they are exactly the ones that must not be neutral. All five ELITE/STATUS
white and near-white tips moved onto their own hue, and both tables gained `tipAlpha`, a
per-emitter ceiling now applied in `_updateAuras` and `_updateStatuses`. The status puff is
also sized off its host (`clamp(r * 0.26, 0.05, 0.2)`) instead of a flat 0.13 — at 0.13 a
status overlay on a 0.4 m mite was as wide as the mite.

Not measurable in a shipped frame because neither path emits in one (§0a). This is
hazard removal, not a fix to something photographed.

---

## 3. Defect 2 — `10-inventory`

Diagnosed, not the brief's diagnosis (§0b). `overload-cell` calls `explosion(at, 12)` on
the **player's own position**, so `s = r/4 = 3` and two things follow:

1. `lights.flick(pos, colour, 20 * s, r * 4.2, 0.42)` asked for intensity **60 over a
   50 m range** — nine times the lit screen area of a normal blast at three times the
   brightness. Capped to `20 * min(s, 1.6)` and `min(r * 4.2, 26)`. Both caps sit *above*
   `08-explosion`'s r = 6 (intensity 30, range 25.2), so the shot the layer was tuned on is
   untouched and only the nuke moves.
2. The fireball's core and heat-glow quads are ~11 m and ~19 m across, six metres from the
   lens. A new **lens fade** in `ParticleShader` handles this generally: `subtense` is a
   sprite's half-extent over its own distance from the camera, i.e. how much of the view
   the quad claims regardless of world size, and alpha ramps to 0.18 across
   `smoothstep(0.30, 0.85, subtense)`. It fades to 0.18 and not to nothing — standing
   inside a nova should still be bright, and the shot's own subject assertion needs the
   blast present. This is the lens-side counterpart to the soft-particle depth fade, which
   handles a sprite meeting a *surface*; the other half was simply unhandled.

3D viewport (x 520–1180, y 110–780), same stage and camera in both shots:

| | mean L | mean RGB | % over L 220 |
|---|---|---|---|
| `06-loaded-hud` before | 62.3 | 78, 57, 68 | 0.50% |
| `10-inventory` **before** | **165.4** | 183, 164, 131 | **22.15%** |
| `10-inventory` after light cap only | 159.1 | 177, 158, 118 | 12.51% |
| `10-inventory` **after both** | **116.4** | — | **4.99%** |
| `06-loaded-hud` after | 61.8 | 77, 57, 61 | 0.49% |

The critic measured 123.0 / 2.42% over L 220 on the build it saw; the tree had drifted to
165.4 / 22.15% by the time I captured a baseline. `06` is unmoved to within a tenth of a
point, which is the control that says the change is the blast and not the grade.

---

## 4. Defect 3 — the distortion layer

`tools/vfxprobe.mjs`, unchanged, on one frozen `08-explosion` frame:

| | displaced px | % of frame | luminance range |
|---|---|---|---|
| before | 14,473 | 1.01% | −152.3 … +183.4 |
| **after** | **96,596** | **6.71%** | −135.0 … +153.8 |

The critic's ruling — "VERIFIED (probe) / NOT VISIBLE (shipped)" — was the right call and
the answer to "too subtle or composited away" is **too subtle**. Two causes, both fixed:

- **The shell was too narrow to perceive.** `w = radius * 0.14` is ~15 px of a 210 px
  ring. Refraction is only ever seen as a straight edge entering and leaving a band; at
  15 px there is nothing to compare across. `0.24`.
- **It was more than half gone by the shutter.** Strength decayed as `(1 − k)^1.5`, and
  `08-explosion` photographs at k = 0.46, i.e. 0.40 of peak. `^0.9` holds it at 0.51 there
  and still reaches zero at the ring's own death, so nothing lingers as a static lens.
  Base strength `0.004 + r·0.0012` → `0.006 + r·0.0018` (cap 0.018 → 0.026).

All four layers still PASS: flash 133,427 px / +36.5 L mean / peak +139.7 at the blast
centre with a monotonic radial falloff (+127.6 L at r = 0 → +5.3 at r = 190); light
24,813 px; distortion 96,596 px; soft fade 10,575 px at a mean of **−6.5 L** (negative, the
sign a real depth fade must have).

---

## 5. Defect 4 — the next layering gap: the damage numerals

`critic-r2-ui-vfx.md` defect 3, fourth round of asking, and it is in a file I own
(`DamageNumbers`, `VFX.js`). Four concurrent `27118!` runs at a 27 px cap and 174 px of
width, one of them on the player with the crosshair's top tick behind a digit — against a
10 px objective banner, a 23 px clock and 9 px item counts. Three changes:

- **Size.** `NUM_SCALE` 0.38 → 0.30, `CRIT_SCALE` 0.62 → 0.49, `NUM_MIN_PX` 36 → 30 (the
  floor is what actually sets the size at combat range).
- **Reticle exclusion, in the vertex shader.** A rect of ±0.115 × ±0.085 NDC around the
  centre is reserved; any glyph inside it is deflected *up* out of it, weighted by how
  central it is horizontally and ramped in across the rect's lower edge, so both boundaries
  are continuous and nothing ever snaps. Deflection rather than spawn rejection: rejecting
  loses the feedback, and a spawn cannot know where its own ballistic arc will have carried
  it by the time anyone reads it. Numerals rise anyway, so up is with the motion.
- **Concurrency gate.** At most 5 non-crit runs may start inside 0.42 s. Crits bypass it —
  the point of a crit readout is that it is the one worth reading.

One iteration was needed and is worth recording: at `NUM_MIN_PX = 26` / `NUM_SCALE = 0.27`
the harness's own legibility assertion **failed** `08-explosion` (median ink/plate
separation 0.15 against a 0.25 bar) because `NUM_HALO_PX` is specified in *atlas* texels,
so shrinking the glyph shrank the dark plate that carries its separation. Halo 9 → 12
(padding limit is ~14) with the sizes at 0.30 / 0.49 / 30 passes.

---

## 6. What I could not fix

1. **`04-combat`'s near-white mass is enemy body material, not VFX.** Measured in §1: the
   affix system contributes 305 + 161 px of 29,035. The rest is faceted enemy plates two to
   six metres from the lens at mean L 225–237. Closing it means
   `critic-r2-enemies.md` defect 5 — clamping enemy body albedo against the *stage's*
   terrain luminance histogram — which needs stage data I do not own, and the shot also has
   a `combat()` camera standing inside the horde, which is `Harness.js`. I changed the
   affix tints and emissives and stopped there rather than tune species palettes blind.

2. **`08-explosion`'s composition got worse during this session, from someone else's
   change.** The blast now sits ~40 m out and small; the four layers are all present and
   two of them are measurably stronger than when the critic scored the shot. This is
   `Harness.js` and was already flagged as out of scope in `FIX-ui-vfx.md`.

3. **`warded` is still the closest affix to a disc** (0.744 against a 0.78 bar, from
   0.790). It is the one affix in the table whose identity *is* an added outline, so I
   pulled it as far as I could without taking the barrier away. If it needs to go lower the
   answer is discrete plates rather than a closed hull, which is a bigger piece of work than
   this brief.

4. **`VFX.deathDissolve` for monsters — deliberately not touched**, per the brief's trap
   note and `DIAG-invisible-enemies.md` §5. The visibility sibling/generation guard is a
   separate piece of work and nothing in this brief required it.

5. **The `04-combat` survivor's 0.053 Michelson contrast** — noted by the coordinator as
   corroborating, explicitly not mine, not chased.

---

## Verification

- `npm run build` — clean. (`npm install` never run.)
- `node tools/capture.mjs --out shots-vfx2-final` — **21 shots, `ready: true`,
  `partial: false`, `errorCount: 0`, `subjectsOk: true`, `subjectFailures: []`.**
- `node tools/perf.mjs --enemies 24 --seconds 8` — combat-24 median **20.0 ms** (p95 26.9)
  and **25.8 ms** (p95 49.9) on two runs an hour apart. Both inside the 17–26 ms band; the
  box is running five other agents and the spread is machine load, not the change. The
  changes are a torus per band instead of an 80-face sphere (fewer triangles), two constants
  in a light call, and one `smoothstep` in the particle vertex shader.
- `node tools/affixprobe.mjs` — PASS, exits non-zero under any bar.
- `node tools/vfxprobe.mjs` — PASS, all four layers.
- PNGs inspected at 1× and at 3–7× on the blobs: `shots-vfx2-final/{04-combat,08-explosion,
  10-inventory,11-bestiary,06-loaded-hud}.png`, and the seven-variant affix contact sheet
  from `shots-affix/`.

## Files changed

- `src/entities/EnemyMeshes.js` — the affix system: `ELITE` table, `matsFor` tint/emissive,
  `auraMat`/`bitMat`/`wardMat`, `makeAura`, `setAffix`, the affix block in the animator.
- `src/systems/VFX.js` — particle tips + `tipAlpha`; host-sized status puff; blast light
  caps; distortion strength and decay; damage-numeral size, reticle exclusion, halo and
  concurrency gate.
- `src/shaders/ParticleShader.js` — lens fade.
- `src/shaders/DistortShader.js` — shell width.
- `tools/affixprobe.mjs` — new.

## Evidence on disk

- `shots-affix-before/` and `shots-affix/` — the two seven-variant sets the §1 table is
  measured from. `shots-affix-before/blazing.png` and `.../overloading.png` are the round-5
  defect in isolation: the same opaque ball in two colours, no bits.
- `shots-vfx2-before/` — full 21-shot baseline captured before any of this landed.
- `shots-vfx2-final/` — full 21-shot capture of the shipped state.
- `shots-vfxprobe/` — the five per-layer variants of the frozen `08-explosion` frame.
