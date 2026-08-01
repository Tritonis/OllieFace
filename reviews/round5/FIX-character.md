# FIX — character read & survivor identity (round 5, resumed)

Against `reviews/round5/critic-r1-character.md`. Rubric axis 4 was 3/10 on all
four judged shots — the worst score in the project.

**This session wrote no code.** The predecessor agent, killed mid-edit by the
usage limit, had already landed all six fixes in `a06c6fe`/`7f32fc5`; its work
was undocumented, not unfinished. What follows is the verification it never got
to write, measured from scratch, plus one defect that is genuinely still open
and is not in this agent's file ownership.

Files the predecessor changed in this domain: `src/entities/CharacterMesh.js`
(+547/-202), `src/ui/Menus.js` (STAT_BARS), `src/ui/hud.css` (`.sel-foot
.mbtn--go`). `src/data/survivors.js` is byte-identical to `f9d85cf` — gameplay
numbers untouched, as required.

---

## Method

Three instruments, all re-run this session:

1. **`tools/silhouette.mjs`** (written by the predecessor, 221 lines). Renders
   every rig alone, idle, flat black on white, through one shared orthographic
   box (1.6 m × 2.4 m, square pixels) — so the four masks come back at true
   relative scale with no lighting, palette, terrain or staging in the way.
   Reports bbox, fill, aspect, centroid, negative-space fraction, a ten-band
   width/segment/fill profile, and pairwise IoU on a bbox-normalised 64×64
   signature (scale removed on purpose — "is it the same shape at a different
   size" is exactly what the roster was failing).
2. **A `git worktree` at `f9d85cf`** with the same tool copied in, so every
   silhouette number below is a real before/after on one instrument rather than
   a comparison against the critic's differently-derived figures.
3. **The critic's own method on the shipped PNGs** — 4-connected border flood,
   Manhattan RGB tolerance 12 (and 20, 34), largest connected component,
   `0.2126R + 0.7152G + 0.0722B` on 8-bit sRGB. Python + Pillow 12.3.0.

`node tools/capture.mjs` re-run: 20/20 shots, `errorCount: 0`, `subjectsOk:
true`, `subjectFailures: []`. **All PNGs cited below were opened and looked at,
not inferred from the manifest** — that is the exact failure this round exposed.

---

## Defect 1 — RANGER and ANVIL threshold to the same silhouette

**Status: already fixed by predecessor. Verified.**

Root cause, from the predecessor's own comment at `CharacterMesh.js` `POSE`:
the *shared* rest pose was destroying the silhouettes. `armL.rotation.z = +0.16`
swung a down-hanging left arm toward +X — i.e. **into** the torso — and the
right arm's `-0.16` did the same from the other side; `hipL.rotation.z = +0.04`
converged the legs. Every rig on the roster therefore stood with both arms
welded flat to the body and both legs fused into one column. The fix is a
per-rig `POSE` table (abduction magnitudes, signs inverted from the originals,
negated per side by the animator) plus per-rig head primitives and plate
albedos.

### Clean ortho masks — before (`f9d85cf`) vs after (`HEAD`)

```
                 BEFORE                                    AFTER
id       bbox      area   fill  aspect  holes%   bbox      area   fill  aspect  holes%
ranger   327x654   87519  0.409  0.500   1.39    343x699   82385  0.344  0.491   0.00
anvil    393x575  108668  0.481  0.683   1.15    462x602  128967  0.464  0.767   0.00
kestrel  245x768   84123  0.447  0.319   1.11    235x768   87218  0.483  0.306   0.52
rook     283x576   87990  0.540  0.491   1.29    322x553   90460  0.508  0.582   0.01
```

Ranger/Anvil aspect separation **0.500 vs 0.683 (+37%) → 0.491 vs 0.767 (+56%)**.

### Segment profile — daylight through the outline

Mean solid runs per scanline, crown → feet in ten bands. A band at 1.00 is a
solid bar: arms welded to the torso, or legs fused into one column. This is the
direct measure of the critic's "not one pixel of negative space".

```
BEFORE                                          AFTER
ranger 1.71 2.02 1.97 1.45 1.50 1.54 1.00 1.65 2.00 1.67 | 1.16 1.97 2.44 1.30 1.00 2.00 1.94 2.00 2.00 2.00
anvil  2.75 2.16 1.00 1.24 1.00 1.00 1.75 1.81 2.00 1.45 | 1.48 2.62 1.03 1.80 2.00 1.23 1.67 2.00 2.00 2.00
kestre 1.22 3.05 2.45 2.84 1.66 1.00 1.00 1.00 1.91 1.61 | 1.12 3.03 2.32 2.56 1.58 1.00 1.08 1.00 1.97 2.00
rook   1.86 3.22 1.07 1.00 1.00 1.00 1.00 1.63 2.00 1.31 | 1.93 2.62 1.02 1.00 1.02 1.18 1.07 2.02 2.00 2.00
```

Bottom three bands (the legs) go from `2.00 1.67` / `2.00 1.45` / `2.00 1.31`
to a clean **2.00 2.00 2.00 on all four rigs**. The inner-leg gap now survives
thresholding for every survivor. Anvil's mid-body bands go 1.00→2.00 and
Ranger's 1.00→2.00/1.94 — the arm/torso gaps are real.

### Pairwise shape IoU (scale removed)

```
BEFORE                     AFTER
ranger/anvil    0.578      0.477   (-0.101)
ranger/kestrel  0.421      0.570
ranger/rook     0.608      0.477
anvil/kestrel   0.569      0.581
anvil/rook      0.796      0.516   (-0.280)
kestrel/rook    0.621      0.593
WORST anvil/rook 0.796  ->  WORST kestrel/rook 0.593  (-0.203)
```

The worst colliding pair in the project drops **0.796 → 0.593**, and no pair is
above 0.60.

### Threshold test on the shipped roster shot, `09-survivors.png`

Critic's method exactly — crop, border flood tol 12, largest component:

```
name     bbox      area    fill  aspect  >L200%  leg-runs
RANGER   107x213   10975   0.482  0.502   5.02    1.67
ANVIL    208x244   21730   0.428  0.852   5.96    1.44
KESTREL  128x279   14302   0.400  0.459   4.73    1.10
ROOK     138x204   11453   0.407  0.676   8.16    1.00

pairwise IoU: RANGER/ANVIL 0.460  RANGER/KESTREL 0.466  RANGER/ROOK 0.486
              ANVIL/KESTREL 0.457 ANVIL/ROOK 0.364    KESTREL/ROOK 0.559
WORST PAIR: KESTREL/ROOK at 0.559
```

Critic measured RANGER 0.54 / ANVIL 0.67 aspect — a 24% spread it correctly
called "a size slider". Now **0.502 vs 0.852, a 70% spread**, and the two shapes
share less than half their normalised area.

Plate albedo, the critic's second half of this defect (RANGER (124,94,98) vs
ANVIL (129,99,84) — "same warm mid-grey"): the palettes are now pushed apart to
cool steel/navy and warm tan/brown. Visible directly in `09-survivors.png`;
Ranger's torso reads blue-grey with an orange sash, Anvil's reads tan/ochre.

Looked at `09-survivors.png` and a 2× contact sheet of the four crops. RANGER:
tall narrow head with antenna clearing the shoulder line, pauldrons, arms out
with visible background either side, split legs, orange sash. ANVIL: wide flat
wedge head, huge boxy gauntlet/shoulder mass, hunched (`lean: 0.17`). KESTREL:
cone head, rifle raised at ~50°. ROOK: round head, shoulder backpack,
deployable held away from the body. Four different characters.

---

## Defect 2 — ROOK is a formless amoeba with occluded legs

**Status: rig fixed by predecessor and verified. Staging half STILL OPEN, and
it is not mine to fix.**

Rig, from the clean ortho render: ROOK's segment profile bottom bands went
`2.00 1.31` → **`2.02 2.00 2.00`**, aspect 0.491 → 0.582, and its worst IoU
against any other survivor is now 0.593 (was 0.796 against Anvil). It is no
longer an amoeba — the ortho contact sheet shows a distinct head, a shoulder
pack breaking the outline to one side, and two separate legs.

Green emissive wash — critic measured 3.42% of ROOK's bbox above L=200 against
KESTREL's 0.75%, a **4.6×** flattening. Now 8.16% vs 4.73%, a **1.7×** ratio.
Absolute numbers are up on all four because the grade and the rim work landed;
what mattered was the relative flattening, and it is down by 2.7×.

**Still open:** in `09-survivors.png` ROOK stands on a pink rock terrace that
occludes it from the knee down — leg-runs measures **1.00** for ROOK in that
shot (against 2.00 in the clean ortho render). I opened a 3× crop of ROOK and
confirmed it by eye: upper body reads well, lower legs are behind rock. The
critic's fix (c) for this is a Harness change — `Harness.js:1889 survivors()`
already runs a `seesTarget` probe at `y+0.3` and `y+1.9` and passes, so the
occluder test needs to be a full-body one, not two rays. **`src/core/Harness.js`
is explicitly outside this agent's ownership**, so it is left for whoever owns
the harness. Nothing in `CharacterMesh.js`, `survivors.js`, `Menus.js` or
`hud.css` can fix it.

---

## Defect 3 — only KESTREL reads as distinct

**Status: already fixed by predecessor. Verified.**

Subsumed by 1 and 2. Every pair on the clean ortho instrument sits between 0.477
and 0.593 IoU with no outlier; on the shipped roster shot every pair sits
between 0.364 and 0.559. There is no longer a colliding pair, and the four
width profiles are four different curves:

```
ranger 0.22 0.53 0.83 0.84 0.57 0.68 0.69 0.47 0.49 0.58   narrow crown, mid flare, taper
anvil  0.88 0.94 0.93 0.85 0.67 0.61 0.39 0.41 0.42 0.50   top-heavy wedge
kestrel 0.93 0.94 0.92 0.93 0.93 0.69 0.58 0.55 0.54 0.66  needle with a raised weapon
rook   0.65 0.79 0.86 0.73 0.64 0.68 0.74 0.72 0.74 0.91   even column, wide base
```

---

## Defect 4 — the player merges with the terrain in `03-thirdperson`

**Status: already fixed by predecessor. Verified.**

Critic's baseline: player coat/legs **20–64**, terrain immediately left **33.7
(12.7–63.0)** — the coat was *darker* than the ground behind it, the ranges
overlapped completely, and a border-flood threshold merged the head and upper
body into the cliff face.

The predecessor bought the separation from the two view-space terms the
character material already owns, rather than brightening the albedo: rim
strength `0.85 → 1.6` on `coat` and `0.95 → 1.75` on `coatDark`, `rimPower`
2.6 → 2.0 (a wider band that reaches further in from the outline),
`hemiStrength` 0.40 (lifts up-facing facets toward the sky, drops down-facing
ones), and a new `shell` material so that open-ended jacket geometry stops being
built from the rig's darkest value. That is a value *structure* on the body, not
a flat lift — nothing clips, and being view-space it travels to all four biomes
by construction rather than by tuning.

### Region means, `03-thirdperson.png` (mean [min–max])

```
player                              adjacent terrain
head plate         114.9 [32-231]   terrain L of head   39.6 [32-196]
shoulder pauldron   98.5 [31-203]   terrain L of torso  42.2 [32- 65]
coat light panel    92.3 [47-178]   terrain R of torso  54.8 [36- 67]
coat navy panel     63.4 [39-206]   terrain R of legs   47.0 [41- 55]
hem / skirt         83.6 [45-222]   ground below-left   52.1 [45- 63]
leg lower L        123.2 [40-172]
leg lower R        130.4 [45-170]
```

The coat is no longer darker than the ground: every player region is above
every adjacent terrain region, and the light panel's range (47–178) has left
the terrain range (32–65) almost entirely.

### Outline separation — the measure that actually decides the defect

Interior panel value against distant ground is the wrong question; what merges
under a threshold is the **outline**. Border-flood the crop, then compare a 3 px
band just inside the mask edge against a 3 px band just outside, on every
outline row. Crop trimmed to exclude the rock ledge the player stands beside
(the ledge is a genuine adjacent object and its own edge is not the player's).

```
tol   subject   inside  outside   median    p25     mean    % of outline <1.5:1
12    38.5%      114.9    43.0    2.37:1   1.40:1  2.28:1   26.6%
20    36.5%      130.7    43.4    2.67:1   2.24:1  2.57:1   15.0%
34    25.2%      141.0    46.9    2.74:1   1.57:1  2.72:1    8.7%
```

The subject holds as its own connected component at **all three** of the
critic's tolerances — the flood never leaks into the body, which is the precise
failure it reported. Median outline contrast **2.37–2.74:1** against the
critic's stated ≥2.5:1 bar; met at tol 20 and 34, 0.13 short at tol 12.

Looked at a 3× crop of the player in `03-thirdperson.png`: cool steel/navy body
with an orange sash against warm orange-brown terrain, rifle crossing the torso,
a clear gap between the free arm and the body, two separate legs.

**Caveat I will not paper over:** I could not measure this across all four
biomes from shipped shots, because `13-biomes-1..4` are establishing landscape
frames with no player in them (`Harness.biomeVista`), and adding a shot means
touching `tools/capture.mjs`, which is outside my ownership. The
biome-independence claim rests on the terms being view-space (fresnel + hemi
tilt, neither of which reads the stage key), not on four measurements. Someone
should confirm it directly.

---

## Defect 5 — survivor-select stat bars pegged at 184/184 px

**Status: already fixed by predecessor. Verified.**

`STAT_BARS` went from roster-relative (`frac = value / max(across roster)`,
which pegs whichever survivor tops a stat by construction — Kestrel tops three)
to an explicit per-stat design range, floored at 0.03 and clamped at 0.96 so
nothing ever reaches either end of the track:

```
maxHealth [50, 220]   damage [6, 24]   moveSpeed [5.2, 8.8]
armor     [0,  22]    critChance [0, 0.14]
```

Measured off `14-survivor-select.png` (Kestrel selected), track x=1172..1360,
189 px:

```
            BEFORE (critic)        AFTER (measured)
HEALTH       97 px  (53%)           46 px  (24%)
DAMAGE      184 px (100%)  PEG     115 px  (61%)
SPEED       184 px (100%)  PEG     115 px  (61%)
ARMOR         0 px   (0%)            8 px   (4%)
CRIT        184 px (100%)  PEG      68 px  (36%)
```

Three pegged bars → zero. Zero-length bar → a 8 px stub, so a genuinely zero
stat reads as "no armour" and not as "the bar failed to render".

All four survivors' profiles, computed from `survivors.js` base stats against
the shipped ranges — no bar pegs for anyone, and four distinct profiles:

```
survivor  Health  Damage  Speed  Armor  Crit      (px of 189)
ranger      35%     33%    50%     3%     7%      67  63  94   6  14
anvil       71%     50%    36%    36%     7%     133  94  68  69  14
kestrel     24%     61%    61%     3%    36%      44 116 115   6  68
rook        50%     28%    31%     3%     7%      94  52  58   6  14
```

Minor, not worth an edit: Kestrel's Damage and Speed land on 61% each by
coincidence (17 in [6,24] and 7.4 in [5.2,8.8] are both 0.611). Different stats
on different rows; it does not read as a peg.

---

## Defect 6 — survivor-select CTA has no contrast

**Status: already fixed by predecessor. Verified.**

`.sel-foot .mbtn--go` is now a filled plate in `var(--accent)` — the *selected
survivor's* accent, set per-selection at `Menus.js:472` — with dark `#05080d`
text, a white leading edge, and an accent glow. `.mbtn--quiet` (Back) was
dropped to `rgba(6,10,16,0.55)` so the pair reads as one action and one exit.
This also removes the critic's second complaint here: the cyan the CTA used to
introduce against the screen's purple is gone, so there is one accent, not two.

Mean luminance measured on `14-survivor-select.png`:

```
                BEFORE (critic)   AFTER (measured)
"BEGIN RUN" fill     26.5             156.5
"BACK" fill          17.5              28.5
panel background     10.9              12.0

CTA above panel:  +15.6  ->  +144.5     (contrast 1.29:1 -> 3.61:1)
CTA above BACK:    +9.0  ->  +128.0
```

The CTA is now the brightest object on the screen by a wide margin, and I
confirmed that by looking at the shot — nothing else on the frame competes.

---

## Verification run this session

- `node tools/capture.mjs` — 20/20 shots, `errorCount: 0`, `subjectsOk: true`,
  `subjectFailures: []`. `04-combat` and `05-boss` are populated and usable.
- `node tools/silhouette.mjs` on `HEAD` and on a `f9d85cf` worktree.
- `npm run build` — clean, 4.44 s, `dist/assets/index-Cha4BBt6.js` 908.52 kB.
- `node tools/perf.mjs` — `combat-24` medianFrameMs **20.5** and **21.8** on two
  runs, p95 26.7. The required band is 21–26 ms; the two samples straddle its
  lower edge, i.e. this is at or slightly faster than the band, not a
  regression. Flagging it rather than rounding it into range.
- PNGs opened with the Read tool: `03-thirdperson`, `09-survivors`,
  `14-survivor-select`, plus 3× crops of the `03` player and of ROOK in `09`.
- `src/data/survivors.js` is byte-identical to `f9d85cf` — no balance change.
- This agent made **no source edits**. `git status` shows only other agents'
  in-flight work in `src/world/*`.

## Still open

1. **ROOK's legs are occluded in `09-survivors`** (leg-runs 1.00 in the shot vs
   2.00 on the rig). Cause is roster staging in `Harness.js:1889 survivors()`,
   which is outside this agent's ownership. The two-ray `seesTarget` probe needs
   to become a full-body occluder test, the same class of fix that
   `visibleFraction()` already applies elsewhere.
2. **Biome-independence of the rim separation is argued, not measured** — see
   the caveat under defect 4. Needs a player-bearing shot per biome, which is a
   `tools/capture.mjs` change.
3. **The `14` portrait staging** (critic's defect 5: 232×318 subject in a
   652×388 landscape viewport, flat frontal fill, 1 px line for a floor) is
   *not* in the six-defect list I was given and is only partly mine — the model
   viewer is `src/ui/Logbook.js` (`ModelPreview`), which another agent is
   currently editing. Deliberately not touched. The rim work does now give the
   portrait some form, but the viewport is still ~60% empty gradient.
