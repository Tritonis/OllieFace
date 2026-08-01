# Round 5 / critic round 2 — Character read & survivor identity

Domain: rubric axis 4 (silhouette & form) primary, axes 7 and 8 as they bear on
the player. Shots judged: `03-thirdperson`, `09-survivors`, `14-survivor-select`,
`04-combat`. Round 2 of a maximum 4.

`shots/manifest.json`: `ready: true`, `partial: false`, `errors: []`,
`subjectsOk: true`, `subjectFailures: []`, every shot `frameErrors: 0`. No
capture defect to report as #1. Two harness numbers in that file are themselves
evidence and appear below.

Everything in this file was measured this session off the shipped PNGs at native
1600×900. Nothing is credited from round 1 or from `FIX-character.md`.

---

## AXIS SCORES

```
AXIS SCORES 03-thirdperson:    1:4 2:4 3:6 4:6 5:4 6:5 7:7 8:6 9:5 10:6   mean 5.3
AXIS SCORES 09-survivors:      1:6 2:3 3:6 4:5 5:4 6:5 7:6 8:5 9:5 10:6   mean 5.1
AXIS SCORES 14-survivor-select:1:3 2:3 3:6 4:4 5:4 6:5 7:6 8:6 9:6 10:5   mean 4.8
AXIS SCORES 04-combat:         1:5 2:5 3:4 4:5 5:4 6:6 7:7 8:4 9:5 10:5   mean 5.0
```

**VERDICT: FAIL** — the bar is 7+ on every axis with nothing below 6. Axis 4 is
now 4–6 (was 3 everywhere), which is real movement, but no shot clears the bar
and axes 1, 2, 5 and 8 all sit at 3–5.

### Round 1 → round 2

| shot | r1 mean | r2 mean | Δ | axis 4 r1 → r2 |
|---|---|---|---|---|
| 03-thirdperson | 4.9 | 5.3 | +0.4 | 3 → **6** |
| 09-survivors | 4.9 | 5.1 | +0.2 | 3 → **5** |
| 14-survivor-select | 4.6 | 4.8 | +0.2 | 3 → **4** |
| 04-combat | 3.5 | 5.0 | **+1.5** | 3 → **5** |

Per-axis, across the four shots (mean of the four scores):

| axis | r1 | r2 | note |
|---|---|---|---|
| 1 lighting | 4.25 | 4.50 | rim work landed on the body; the stages did not change |
| 2 composition | 3.75 | 3.75 | `04` gained a subject, `09` and `14` lost ground on framing |
| 3 colour | 5.50 | 5.50 | `04` down to 4 — six competing accents in one frame |
| **4 silhouette** | **3.00** | **5.00** | the round's real gain |
| 5 material | 3.75 | 4.00 | untouched |
| 6 VFX | 4.50 | 5.25 | `04` now has layered effects to judge |
| 7 UI/HUD | 5.75 | 6.50 | `14` CTA and stat bars fixed |
| 8 readability | 3.75 | 5.25 | `04` has a fight in it now; the player is still the dimmest thing in it |
| 9 post | 5.00 | 5.25 | — |
| 10 cohesion | 5.50 | 5.50 | menu chrome vs HUD chrome still two languages |

---

## Fix claims, independently re-measured

| # | Claim in `FIX-character.md` | What I measure on the shipped PNGs | Verdict |
|---|---|---|---|
| 1 | Worst-pair silhouette IoU **0.796 → 0.593** (offline ortho tool) | Not derivable from PNGs — there is no before-PNG and I did not run the offline tool. On the shipped `09` I get all six pairs between **0.345 and 0.487**, worst = KESTREL/ROOK 0.487. No colliding pair exists. | **PARTIAL** — after-state VERIFIED (in fact better than claimed); the 0.796 baseline is unverifiable from pixels |
| 2 | ROOK leg-runs **1.31 → 2.00** | Shipped `09`: ROOK's bottom-three-band mean run count is **1.03**. Zero feet, zero boots, zero ground contact anywhere in the frame. Green-body pixels stop at y≈515 with a 2 px width in the last 15 rows. | **REFUTED in shipped pixels.** True only on the offline rig; false in the only shot that shows the roster |
| 3 | Stat bars unpegged | 187 px track at x 1173–1359. HEALTH 44 px (24%), DAMAGE 113 px (60%), SPEED 113 px (60%), ARMOR 6 px (3%), CRIT 66 px (35%). Nothing at 0, nothing at 100. | **VERIFIED** (with a caveat — see Notes) |
| 4 | CTA contrast **1.29:1 → 3.61:1** | `BEGIN RUN` fill mean L **159.0**, `BACK` fill **23.4**, panel background **11.5**. 7.07:1 over the panel, 4.75:1 over the secondary. It is unambiguously the brightest object on the screen and the cyan second accent is gone. | **VERIFIED** |
| 5 | Player no longer merges with terrain in `03` | Subject holds as its own connected component at tol 12, 20 and 34. Median outline contrast 2.19 / 2.62 / 2.60 :1. Navy coat panel 62.8 vs ground right of legs 46.5 — r1's "the coat is darker than the ground" no longer holds. | **VERIFIED**, with one exception (defect 4) |
| 6 | RANGER/ANVIL plate albedos pushed apart | Modal facet colours in `09`: RANGER chest **RGB(44,58,101)** cool navy; ANVIL shoulder **RGB(117,82,64)** warm brown. r1's "(124,94,98) vs (129,99,84), same warm mid-grey" is gone. | **VERIFIED** |
| 7 | Per-rig rest poses replace the shared one | Four visibly different stances in `09` and four different ten-band width profiles (RANGER `0.08 0.23 0.78 0.60 0.71 0.73 0.57 0.57 0.61 0.59`, ANVIL `0.51 0.64 0.61 0.48 0.55 0.90 0.65 0.30 0.41 0.51`, KESTREL `0.05 0.36 0.60 0.64 0.53 0.37 0.56 0.35 0.36 0.37`, ROOK `0.03 0.09 0.54 0.64 0.61 0.50 0.56 0.65 0.39 0.24`). | **VERIFIED** |
| 8 | `04-combat` and `05-boss` now contain their subjects | `04` carries a real fight — beetles, a golem, a pale-blue biped, a pink cap, wisps, tracers, damage numbers; manifest counts 24 objects / 22 visible. `05` shows the Stone Titan (bisected by a tree trunk, but present). | **VERIFIED** — r1 defect 2 is closed |
| 9 | RANGER/ANVIL aspect **0.502 vs 0.852** | RANGER 0.502 (exact match). ANVIL 0.92–1.19 depending on crop, because its mask bleeds into its own cast shadow. KESTREL 0.44, ROOK 0.76. The spread is real and larger than claimed. | **VERIFIED** directionally |

### Findings I withdraw

- I initially read ANVIL's legs as fused in `09`: its tol-12 mask gives a solid
  trapezoid from hip to ground with a leg-band run count of 1.00. **That is
  wrong.** A 5× crop of `shots/09-survivors.png` at (620,470)–(760,580) shows a
  clean 10–15 px gap between two separate legs, boots included. The mask fails
  because the ground *between* the legs reads L 60.7 against a thigh at L 81.5 —
  1.28:1 — so a tolerance-12 flood walks straight through the gap. The rig is
  fine; the value match with the stage is what destroys it. Recorded as part of
  defect 3, not as a rig defect.
- Round 1's "`04-combat` contains 0 of its 24 enemies / the tracer terminates on
  an undrawn entity" is dead. Confirmed independently: the frame is full.

---

## The four questions, re-answered

### 1. Are the four survivors distinguishable as pure black silhouettes?

**Yes, now — as shapes.** Border flood, Manhattan RGB tol 12, largest connected
component, on `shots/09-survivors.png`:

| survivor | bbox | area | fill | aspect | abs footline |
|---|---|---|---|---|---|
| RANGER | 107 × 213 | 10940 | 0.480 | 0.502 | y 558 |
| ANVIL | 242 × 224 | 20726 | 0.441 | 1.080 | y 569 |
| KESTREL | 125 × 284 | 12813 | 0.361 | 0.440 | y 559 |
| ROOK | 155 × 204 | 11934 | 0.377 | 0.760 | y 534 (rock edge, not a foot) |

Pairwise IoU on a bbox-normalised 64×64 signature, scale removed:

```
RANGER/ANVIL   0.430    ANVIL/KESTREL  0.345
RANGER/KESTREL 0.463    ANVIL/ROOK     0.356
RANGER/ROOK    0.459    KESTREL/ROOK   0.487
```

Worst pair 0.487. Round 1's headline finding — RANGER and ANVIL threshold to the
same lump-on-a-brick-on-a-column, differing only by a width slider — is dead.
RANGER now has an antenna and a helm clearing the shoulder plane, pauldrons, a
rifle at ~55° breaking the outline and split legs. ANVIL is a top-heavy wedge
with two enormous gauntlet blocks. The four are four characters.

**What still fails is not the shape, it is the edge.** Sampling a 3 px band
inside the mask against a 3 px band outside it, over the upper 62% of each
figure (excluding the ground shadow):

| survivor | median outline contrast | p25 | % of outline below 1.5:1 |
|---|---|---|---|
| RANGER | 1.25:1 | 1.12:1 | 56.4% |
| ANVIL | 1.28:1 | 1.17:1 | 66.3% |
| KESTREL | 1.31:1 | 1.17:1 | 58.5% |
| ROOK | 1.83:1 | 1.47:1 | 28.2% |

Raw pixels tell you why. At `09` y=450 across RANGER: background L 51–53, then
the character's shadow side at **L 37–41 — darker than the background** — then a
plate spike at L 201. At y=440 across KESTREL: background L 51, coat L 34–36,
then a rim spike at L 164, then background L 42. The survivors do not read as
value masses with an outline; they read as scattered bright chips floating in a
field the same value as their own dark facets. That is what keeps axis 4 at 5
rather than 7.

### 2. Is the player instantly findable in `04-combat.png`?

The shot is now a real test — 22 visible enemies, layered VFX, damage numbers —
and the player **fails it on measurement**.

```
region                    mean L   p50 L   % of region above L150
PLAYER bbox                108.5    84.7    29.7
pink cap enemy             166.5   172.3    78.2
big pale-blue biped, R     142.9   146.1    48.1
white VFX plume            136.2   124.2    43.8
orange golem, R            130.0   132.4    26.6
beetle, far L              124.7   115.8    32.5
```

The player has the **lowest median luminance of every named object in the
frame**. Its outline contrast is median 1.42:1 (tol 12) / 1.71:1 (tol 20), with
40–52% of the outline below 1.5:1 — against 2.19–2.62:1 for the same character
in `03`.

The harness says so itself. `manifest.json`, shot `04-combat`, subject
`survivor`: `"lum": 42.7, "bgLum": 47.5, "contrast": 0.053` — the engine's own
probe reports the player as *darker than its own background* with 5% contrast,
and passes the check anyway because the only gate is `minPx: 400`. The
equivalent line for `03` is `contrast: 0.758`.

The one thing that does work is the lime `GRAV. SNARE` ground ring, which is the
single strongest player locator in the frame — and it is a temporary ability
effect, not a permanent affordance.

### 3. Does each silhouette communicate its role?

**3 of 4, up from 1 of 4.** RANGER now reads Line Infantry — steel plate, sash,
slung rifle, no robe. ANVIL reads Breach Crew — a hunched wedge with gauntlets
wider than its own hips. KESTREL reads Long Watch. ROOK is billed Field
Engineer, has the backpack mass and the deployable held away from the body, and
communicates none of it in the shipped frame because it is buried to the thigh
in rock (defect 2).

### 4. Does survivor-select read as AAA?

Better in the chrome, worse in the character content.

Fixed and verified: the CTA is now the brightest object on the screen by 7:1
over the panel; the second cyan accent is gone; the stat bars carry information
and none of them pegs; the loadout tiles remain the cleanest thing in the
product.

Not fixed: **the roster is still four text rows with no imagery**, and the one
piece of character content on the screen has got worse to look at. Measured in
the 645 × 384 portrait viewport: subject bbox **122 × 313**, area 12308 px —
**19% of the viewport's width and 5.0% of its area. 95% of the box is empty
gradient.** Key/fill split across the subject is 111.1 (left half) vs 100.7
(right half), a **10% delta** — there is no directional key at all. And there is
no contact shadow: the row immediately below the feet reads L 15.9 against a
viewport corner at L 12.4, and four rows down there is a **brighter** full-width
1 px rule at L 105.8. The model is lit like a product photo on white and floats
on a hairline.

---

## Strengths (not scored, but real)

- The pose fix is the correct fix and it worked. Four rigs, four stances, four
  width profiles, worst-pair IoU 0.487. This was the worst axis in the project
  and it moved on measurement, not on adjectives.
- `04-combat` and `05-boss` now photograph what they claim to. That was a
  capture-integrity failure and it is closed.
- The in-game HUD remains the best-crafted surface in the set and it never
  covers the action in any of the four shots.
- The `14` footer is now correct: one filled accent plate at L 159 for the
  action, one recessed L 23 plate for the exit, in the selected survivor's
  accent.
- RANGER at gameplay distance in `03` is a genuinely readable survivor: helm
  above the shoulder plane, daylight between the free arm and the torso, a rifle
  crossing the back at 55°, two separate legs with ground visible between them.

---

## TOP DEFECTS (ranked)

1. **`shots/04-combat.png` — the player is the dimmest, lowest-contrast object
   in its own combat frame.** Player bbox median L **84.7**; the pink cap enemy
   172.3, the pale-blue biped 146.1, the white plume 124.2, the orange golem
   132.4. Player outline contrast median **1.42:1** with 52% of the outline
   below 1.5:1, against 2.19:1 for the same rig in `03`. The engine's own probe
   in `manifest.json` records `lum 42.7 / bgLum 47.5 / contrast 0.053` and
   passes it, because the only gate on a `pixels` subject check is `minPx`.
   **Fix, two parts.** (a) Give the survivor a camera-attached key that does not
   participate in the stage grade — a directional light parented to the camera
   rig, culled to the player layer, at +0.8 EV over the stage's ambient — so the
   player's median luminance is pinned near the top decile of the frame in every
   biome instead of tracking whatever the stage happens to be. (b) In the
   harness subject check (`tools/capture.mjs` / `Harness`), add a
   `minContrast` alongside `minPx` and fail `04-combat` if the survivor check
   returns below ~0.35; a 0.053 result should never write `ok: true`.

2. **`shots/09-survivors.png` staging — ROOK is buried to the thigh and is not
   on the roster's ground plane. CONFIRMED still open.** Green-body pixels run
   y 368→~515 and the last 15 rows are 2 px wide; there is no boot, no foot and
   no ground contact anywhere. Bottom-three-band run count **1.03** against
   2.00 on the offline rig. Its bbox footline is y **534** against 558 / 569 /
   559 for the other three — it is staged further back *and* higher, so the
   line-up does not even compare like for like. In a shot whose stated job is
   "how distinguishable the four survivors are", one quarter of the sample is
   cropped by scenery. **Fix:** in `src/core/Harness.js:1889 survivors()`,
   replace the two-ray `seesTarget` probe at `y+0.3` / `y+1.9` with the
   `visibleFraction()` full-body test already used elsewhere, require ≥0.95 for
   every roster member, and pick the line-up transform by solving for a single
   flat ground segment wide enough for four figures at one depth — then assert
   the four footlines fall within ±6 px of each other and push a `newErrors`
   entry if they do not.

3. **`shots/09-survivors.png` — the survivors have no coherent value mass
   against the stage; the outline holds on well under half its length.**
   Median inside/outside contrast over the upper 62% of each figure: RANGER
   1.25:1, ANVIL 1.28:1, KESTREL 1.31:1, ROOK 1.83:1, with **56% / 66% / 59% /
   28%** of the outline below 1.5:1. At y=450 RANGER's shadow side reads L 37–41
   against a background at L 51–53 — the character is *darker than the stage*
   for a long run of its own edge, then spikes to L 201 two pixels later. Same
   story for ANVIL's legs: a real 10–15 px gap between them is destroyed under
   threshold because the ground in the gap is L 60.7 against a thigh at L 81.5
   (1.28:1). **Fix:** the rim work that earned `03` its 2.4:1 was tuned against a
   dark cliff and does not survive a bright warm backlight. Drive `uRimStrength`
   from measured background luminance rather than a constant — sample the
   depth-resolved background luminance behind the character (or approximate it
   from the stage's key intensity) and scale rim so the outline band always sits
   ≥2.5:1 above it, both when the background is darker and when it is brighter
   (i.e. allow a dark rim, not only a bright one). Secondarily, lift the floor of
   the character palette: no survivor facet should sit below L 55, which is where
   the stage's shadowed ground lives.

4. **`shots/03-thirdperson.png` — RANGER's head detaches from its body at
   gameplay distance.** Measured on the shipped frame: helm top L **142.6**
   (2.80:1 over the cliff at 42.7) — good; the navy visor block beneath it
   median L **52.5** (1.56:1); and the neck band at x 663–673, y 464–470 reads
   L **40.9 [39–42] against a cliff at 42.7 — 0.97:1, i.e. exactly background.**
   Consequence: at tol 12, 20 *and* 34 the head comes back as a **separate
   connected component** of 1220 / 1093 / 976 px — 11% of the subject — floating
   above the torso. Half the head plus the whole neck are simply absent from the
   character's black shape. **Fix:** in `src/entities/CharacterMesh.js`, the neck
   and the lower head panel are built from the rig's darkest value. Move both to
   the `shell`/plate material (the same one that gets the head's L 140) and keep
   the dark navy for interior detail only — nothing that sits on the outline
   between two bright masses should be allowed below L 60. Then re-run the flood
   at tol 12/20/34 and require the subject to return as **one** component.

5. **`shots/14-survivor-select.png` — the portrait is 95% empty and unlit.**
   Subject 122 × 313 (12308 px) in a 645 × 384 viewport: **19% of the width,
   5.0% of the area**. Key/fill delta across the subject 10.5 L on a mean of
   107.8 — a 10% split, which is no key at all. No contact shadow: L 15.9 one
   row below the feet against an empty-corner L 12.4, then a *brighter*
   full-width 1 px rule at L 105.8 four rows down. At 3× the rig also shows loose
   geometry — a detached forearm block above the left shoulder and two ~2 px
   struts running shoulder-to-knee with no surface between them. **Fix, in
   `src/ui/Logbook.js` `ModelPreview`:** (a) frame the camera to the rig bounds
   with a fixed 12% margin so the subject is ≥60% of the viewport width whatever
   the survivor's proportions, and narrow the viewport toward 3:4; (b) add a
   three-point rig — key 45° camera-left and above, cool rim behind
   camera-right, weak ambient — so the left/right delta is ≥40 L not 10;
   (c) replace the 1 px rule with a real elliptical contact shadow at ~0.35×
   background luminance under the feet, on a visible plinth. And put character
   imagery in the roster rows: four text lines is the single largest gap between
   this screen and RoR2's front door, and it was raised in round 1 and not
   touched.

6. **`shots/03-thirdperson.png` — the default gameplay frame has 33 levels of
   dynamic range and the survivor is carrying all of the contrast alone.**
   Sampled every 2nd pixel above the HUD: **p05 L 31, p50 L 35, p95 L 64** —
   90% of the frame lies inside a 33-level band, with 0.11% clipping and no
   near-black. There is no key direction, no fog gradient, no value separation
   between foreground ledge, midground ground and background cliff; the sky is a
   ~5% sliver at the top. The character reads only because it is the one thing
   in the picture above L 100. Compare `09` (p05 40 / p50 52 / p95 181) from the
   same stage, which proves the renderer can do it. **Fix:** this is a framing
   and key problem, not a grade problem — `03` is being shot inside a shadowed
   canyon. Choose the third-person camera anchor by scoring candidate positions
   on background luminance spread (require p95 − p05 ≥ 90 over the frame) the
   same way `12-boss-phases` already scores framing, and re-shoot. If the stage
   genuinely has no such position at spawn, that is a stage defect worth
   reporting upward.

---

## Notes below the cut (not scored as defects)

- `14`: DAMAGE and SPEED render at **pixel-identical** length — both x 1174→1286,
  113 px. `FIX-character.md` calls this "coincidence, not worth an edit". Two
  adjacent bars of exactly equal length is precisely the read that made round 1
  call the widget broken; nudge one design range (e.g. `moveSpeed [5.0, 9.0]`)
  and the collision disappears.
- `09` carries the live HUD, the crosshair (parked between ANVIL and KESTREL) and
  a stray cyan pickup arrow over a roster comparison shot. It costs nothing to
  hide the HUD for this capture.
- `05-boss`: the Stone Titan is present, and bisected head-to-toe by a tree
  trunk. Outside my four shots; flagging it for whoever owns boss framing.
- Cohesion is unchanged from round 1: the `14` menu frame is orthogonal (square
  corners, 2 px top rule) while the HUD is all shears and chamfers. The new CTA
  plate has a sheared right edge, which is a step toward the HUD's language and
  the only one on the screen.

---

## Commands / method

- Python 3.14.4 + Pillow 12.3.0. All measurements on the shipped PNGs at native
  1600×900, mode `RGB`. Working images in the session scratchpad, not the repo.
- Silhouettes: 4-connected border flood, Manhattan RGB tolerance 12 (and 20, 34),
  largest connected component; bbox / area / fill / aspect / ten-band run and
  width profiles; pairwise IoU on a bbox-normalised 64×64 signature.
- Component census: full 4-connected labelling of the subject mask, all
  components reported by size (this is what exposed the detached head in `03`).
- Outline contrast: 3 px band just inside the mask edge vs 3 px band just
  outside, on every outline row; ratio `(hi+12.75)/(lo+12.75)`; median, p25 and
  the fraction below 1.5:1.
- Luminance: `0.2126R + 0.7152G + 0.0722B` on 8-bit sRGB, reported 0–255.
- Modal facet colour: `collections.Counter` over explicit pixel boxes, top 3
  reported, to avoid box-mean contamination from sun streaks.
- Frame dynamic range: every 2nd pixel, rows 0–760 (HUD excluded), percentiles.
- Visual confirmation at 2×/3×/5×/7× nearest-neighbour on: the four roster crops,
  ROOK alone, ANVIL's legs, the `03` player and its head/neck, the `04` player,
  and the `14` portrait.
- Repo cross-checks only (no edits, no captures): `git log` confirms `a06c6fe`
  and `7f32fc5` exist; `tools/silhouette.mjs` exists; `src/entities/CharacterMesh.js:206`
  carries a per-rig `POSE` table applied at `:477`.
