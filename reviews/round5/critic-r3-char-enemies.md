# Round 5 / critic round 3 — Character read, bestiary, readability

Domain: rubric axes **4** (silhouette & form), **6** (VFX quality), **8** (readability
under load). Shots judged: `03-thirdperson`, `09-survivors`, `14-survivor-select`,
`04-combat`, `05-boss`, `11-bestiary`, `12-boss-phases`, `08-explosion`.
**Round 3 of a maximum 4.**

Everything below was measured this session on the shipped PNGs in
`C:\Users\tpzap\source\repos\OllieFace\shots\` at native 1600×900. Nothing is
credited from round 1, round 2, `FIX-vfx2.md` or `FIX-harness2.md`. Where a
round-2 number is quoted it is labelled as such and is being *tested*, not reused.

## Manifest check

`shots/manifest.json`: `ready: true`, `partial: false`, `errors: []`,
`subjectsOk: true`, `subjectFailures: []`, `clockPinned: true`,
`determinism.frameTimeouts: 0`, every shot `frameErrors: 0`. No capture defect to
report as #1. Three numbers inside that file are load-bearing evidence against the
shots and are quoted below (`04-combat` `perPx`, `04-combat` `vis: 0.583`,
`09-survivors` `footY`).

---

## AXIS SCORES

```
AXIS SCORES 03-thirdperson:     1:4 2:4 3:6 4:7 5:4 6:5 7:7 8:6 9:5 10:6   mean 5.4
AXIS SCORES 09-survivors:       1:6 2:4 3:6 4:7 5:4 6:5 7:6 8:6 9:4 10:6   mean 5.4
AXIS SCORES 14-survivor-select: 1:3 2:4 3:6 4:4 5:4 6:5 7:7 8:7 9:6 10:5   mean 5.1
AXIS SCORES 04-combat:          1:4 2:3 3:4 4:4 5:4 6:5 7:7 8:4 9:4 10:6   mean 4.5
AXIS SCORES 05-boss:            1:4 2:2 3:4 4:2 5:4 6:4 7:6 8:3 9:5 10:6   mean 4.0
AXIS SCORES 11-bestiary:        1:5 2:3 3:6 4:7 5:4 6:6 7:7 8:6 9:5 10:7   mean 5.6
AXIS SCORES 12-boss-phases:     1:6 2:6 3:7 4:5 5:4 6:4 7:7 8:5 9:6 10:7   mean 5.7
AXIS SCORES 08-explosion:       1:5 2:5 3:4 4:5 5:4 6:5 7:7 8:6 9:4 10:6   mean 5.1

VERDICT: FAIL
```

Pass is 7+ on every axis with nothing below 6. **Axis 4 cleared 7 for the first time
in this project — on three shots (`03`, `09`, `11`).** That is the single largest
real movement in five rounds and it is measured, not asserted. Nothing else cleared.
Axes 5 (material) and 2 (composition) have not moved in three rounds, and `05-boss`
is unchanged from round 2 in every respect I can measure.

### Per-shot means across rounds

| shot | r1 | r2 | **r3** | Δ r2→r3 | axis 4 r2 → r3 |
|---|---|---|---|---|---|
| 03-thirdperson | 4.9 | 5.3 | **5.4** | +0.1 | 6 → **7** |
| 09-survivors | 4.9 | 5.1 | **5.4** | +0.3 | 5 → **7** |
| 14-survivor-select | 4.6 | 4.8 | **5.1** | +0.3 | 4 → 4 |
| 04-combat | 3.5 / — | 5.0 / 4.7 | **4.5** | **−0.5 / −0.2** | 5 / 4 → **4** |
| 05-boss | — | 3.8 | **4.0** | +0.2 | 2 → 2 |
| 11-bestiary | — | 4.7 | **5.6** | **+0.9** | 5 → **7** |
| 12-boss-phases | — | 5.7 | **5.7** | 0.0 | 5 → 5 |
| 08-explosion | — | (not in domain) | **5.1** | — | — |

`04-combat` carries two round-2 scores because two critics scored it independently.
**It is the only shot in the domain that went backwards.** Its survivor separation
genuinely improved; its composition, occlusion and enemy census got worse, and the
net is negative.

Per-axis, mean across the eight shots:

| axis | r2 (shots then scored) | **r3 (all eight)** | note |
|---|---|---|---|
| 1 lighting | 4.4 | 4.6 | rims real, stages still keyless |
| 2 composition | 3.8 | **3.9** | three rounds flat; `04` and `05` are the anchors |
| 3 colour | 5.2 | 5.4 | — |
| **4 silhouette** | **4.4** | **5.1** | the round's win, concentrated in `09`/`11` |
| 5 material | 4.0 | **4.0** | untouched for three rounds |
| 6 VFX | 5.1 | 4.9 | affixes up, telegraph and blast core flat/down |
| 7 UI/HUD | 6.6 | 6.8 | — |
| 8 readability | 4.4 | **5.4** | player now findable in every shot |
| 9 post | 5.3 | 4.9 | new specular speckle costs this |
| 10 cohesion | 6.1 | 6.1 | — |

---

## Instrument, and its validation

Round 1's silhouette IoU was garbage (its border sampler read neighbouring enemies
as background). Round 2 rebuilt it and calibrated on a disc vs a square at **0.777**.
I rebuilt it again from scratch and calibrated the same way before trusting a number:

| calibration shape pair | round 2 | **this round** |
|---|---|---|
| perfect disc vs perfect square | 0.777 | **0.787** |
| perfect disc vs a 1:4 tall bar | — | 0.320 |
| perfect square vs a 1:4 tall bar | — | 0.255 |

Reproducing round 2's calibration to within 0.010 on an independently written
implementation is the reason I am willing to compare my numbers to its numbers.
**Collapse threshold = 0.787**: at or above it, two silhouettes are no more
distinguishable than a circle from a square.

Method, and where it differs from round 2:

1. **Local background model per subject.** For each hand-placed subject box, the
   background is a 12 px cell-median taken **only from the ring outside the box**,
   nearest-filled and bilinearly upsampled. Residual `D = ‖I − B‖₂`, threshold `TH`.
2. **A new opening step, and why it was needed.** A global 16×16 background model —
   round 2's approach — no longer works on these frames. Whole-frame residual on
   `11-bestiary` is median 6.8 / **p90 92.5** / p99 269, against round 2's median 4.2
   / p90 28.4. The terrain is now covered in 1–3 px specular sparkle that the model
   cannot represent, so a threshold at 30 sits *below* the 90th percentile of
   non-subject pixels. A 2×2 binary opening after the 3×3 closing removes it. That
   the instrument had to change is itself a finding — see defect 3.
3. **Component selection**, keeping only components that touch the central 50% of
   the box and are ≥8% of the largest such.
4. **Uniform scale normalisation** (longest side → 102 px, aspect preserved),
   centroid-centred on 128×128, IoU maximised over ±6 px translation.
5. **Threshold sensitivity.** Every bestiary verdict was recomputed at
   `TH` = 18, 30, 45, 60. No verdict flips at any threshold.
6. **Visual validation.** A 16-cell `crop | mask` contact sheet was rendered and
   inspected. Mask fill fractions run 0.44–0.68 — not degenerate. Two adjacent boxes
   (pink jellyfish / teal biped) overlap and each mask carries a little of the other;
   stated, not hidden. Neither is in any pair near threshold.
7. **Known bias, unchanged from round 2.** Thin limbs under ~2 px are under-detected,
   which makes shapes *more* alike. The bias runs **toward** finding collapse, so a
   "no collapse" verdict is the conservative one.

For survivors in `09` I used a border flood at Manhattan RGB tolerance 12 with
component merging at ≥6% of the largest, matching round 2's protocol so its numbers
and mine are comparable.

---

## Claim table

| # | Claim under test | Measured on shipped pixels | Verdict |
|---|---|---|---|
| 1 | Root cause of affix collapse was a filled `ico(1,2)` additive shell; removing it also explains why zero orbiting bits ever rendered | I cannot read a root cause out of a PNG. I can read its two predicted consequences and both hold. **No filled shell exists in either affix frame** — `warded` is a white wireframe icosahedron with the host's purple body legible through it, `withering` is a bare tinted host. **Bits render.** `11-bestiary` withering: 5+ green diamond/spike bits countable around the golem at 4× (`withering.png`). `04-combat` overloading: two glowing cyan spheres, 85 px and 50 px, on the host's chest/shoulder. Round 2's "zero of 5 declared bits visible in either" is dead. | **VERIFIED** (consequences) |
| 2 | Worst pairwise affix IoU 0.966 → 0.756; six of ten pairs were ≥0.88, now none | Before-state not derivable from PNGs (no before-PNG, I did not run `affixprobe.mjs`). The after-state is verified far more strongly than claimed: in `11-bestiary`, **0 of 120 pairs reach the 0.787 threshold at TH 18, 30, 45 or 60**, worst pair over the whole 16-subject roster is **0.704** (withering golem ↔ red hulk). Round 2's own shipped-pixel before-state — 8 collapsed pairs of 105, worst 0.88 — is the honest baseline, and every one of those 8 is gone. | **VERIFIED** (after-state; baseline unverifiable) |
| 3 | `glacial` near-white inside its own host's mask 40.5% → 4.4% | **Unverifiable and moot.** `glacial` is spawn index 12 in `04-combat` (`spawnRing(24, …, eliteEvery 6)` × `ELITE_AFFIXES`), and `manifest.json` `04-combat` `perPx[12] = **0**`. The glacial elite renders **zero pixels** in the only shot that spawns it. It appears in no other shot in my domain. | **UNVERIFIABLE — the subject is absent** |
| 4 | `warded` disc IoU 0.790 → 0.744 | Different instrument, same direction, larger margin: I read `warded` at **discIoU 0.642** against a 0.787 threshold (round 2 read the same subject at 0.91 with a global background model). `withering` 0.722 (round 2: 0.91). warded ↔ withering **0.672** (round 2: 0.88). | **VERIFIED directionally** |
| 5 | Do the five affixes read as five distinct threats with hosts intact? | **Two of five do. Three are not legibly photographed anywhere in this domain.** See §2. | **PARTIAL / REFUTED as stated** |
| 6 | `09` footlines equalised to 557/557/557/557, spread 0.000 m, visibility 1.00 including ankles | Mask footlines **558 / 558 / 559 / 557** (RANGER/ANVIL/KESTREL/ROOK; ROOK's tol-12 mask runs to 579 on cast shadow, its boot sole is at y≈557 by eye at 5×). All four have visible boots, toe caps and ground contact. | **VERIFIED** |
| 7 | ROOK's legs read 1.03 in shipped pixels — re-measure now staging is fixed | ROOK is **no longer buried**: full figure, two legs, two boots, ground contact (`rook.png`, 5×). Its bottom-band run counts are **1.06 / 1.31 / 1.37**, still not 2.00 — but a 5× crop shows two unambiguously separate legs with a 20 px gap. The gap fails threshold because the shadow in it matches the leg's own dark panels, exactly the reason round 2 withdrew the identical finding against ANVIL. **The rig is fine; the run count is a value-match artefact.** | **Burial REFUTED (fixed). Leg-run figure PARTIAL — artefact, not a defect** |
| 8 | `08` blast 5,126 → 20,635 px, 14,444 carrying an edge; monsters in blast 1,195 → 7,742 px; centre moved out of the sky | Pixel counts are the harness's own hide-and-diff and I cannot re-derive them, but they are corroborated: my independent L>200 blob is **65,889 px, bbox x389–707 y92–429, centroid (0.352, 0.314)** against the manifest's (0.355, 0.341). The blast is unambiguously larger and lower than round 2's (0.469, 0.26). **"Out of the sky" is PARTIAL** — the centroid is still above the horizon and the top half of the blob is still against sky; what changed is that it now overlaps midground trees and terrain instead of sitting beside the sun. | **VERIFIED (size/position) / PARTIAL ("out of the sky")** |
| 9 | Still open: `04-combat` survivor at 0.053 Michelson | **REFUTED as still open.** The shot was re-staged. `manifest.json` now records the survivor at `lum 45.5 / bgLum 117.7 / contrast **0.442** / sepP50 **0.59** / legible 0.915`. My own census agrees the player is no longer the dimmest thing in frame — player bbox p50 L **148.9** against pink cap 68.0, orange golem 130.2, foreground terrain 47.8. **The defect it was replaced by is worse for the shot's stated job** — see defect 2. | **REFUTED (the metric). The shot still fails axis 8** |
| 10 | Still open: `FIX-vfx2` — the residual near-white in `04` is enemy body material, not affix VFX | **VERIFIED, and independently strengthened.** 26,514 near-white px (L>195, chroma<40) remain, in four blobs of 6,969 / 6,201 / 3,533 / 2,672 px at mean L 202–230, chroma 0.13–0.20. At 6× they are **low-poly matte spheres and plates with hard polygonal silhouettes** — geometry, not billboards. And the affix that round 2 blamed cannot be responsible: glacial renders 0 px (claim 3). | **VERIFIED** |
| 11 | Still open: boss scale 2.55× the survivor against a 3× target | **CONFIRMED still open, and worse.** `05-boss`, both feet on y480 (matched depth): Titan mask **175 × 286 px**, survivor mask **125 px** tall → **2.29×**. Excluding the survivor's antenna spike gives 2.78×; the Titan's head is cut flat by the canopy at y195, so neither figure is whole. RoR2's Stone Titan reads ~5× a survivor. | **CONFIRMED OPEN** |
| 12 | *(untested, checked anyway)* r2 defect 4 — RANGER's head detaches in `03` | **FIXED.** Neck band now L **66.4** against a cliff at 35.9 = **1.85:1** (was 0.97:1). The subject returns as **one** connected component at TH 24 (11,663 px, next 89) and TH 34 (9,126 px, next 45). It only splits at TH 48. | **FIXED — closing r2 defect 4** |
| 13 | *(untested, checked anyway)* r2 defect 3 — survivors have no coherent value mass in `09` | **Substantially improved, not closed.** Median inside/outside outline contrast, upper 62%: RANGER **1.76:1** (r2 1.25), ANVIL **1.70** (1.28), KESTREL **1.59** (1.31), ROOK **1.48** (1.83). Fraction of outline below 1.5:1: 31.8 / 31.2 / 38.7 / **51.4** %. Three improved sharply; **ROOK regressed** — the staging fix moved it off dark rock onto bright speckled ground. | **PARTIAL** |

---

## 1. Silhouette collapse — validated tables

### 1a. `11-bestiary`, all 16 subjects, TH = 30

All sixteen manifest objects were individually resolvable this round; round 2 could
only isolate 15 of 16.

| subject | area px | w×h | aspect | complexity | max IoU | its partner | disc IoU | verdict |
|---|---|---|---|---|---|---|---|---|
| mite | 979 | 51×44 | 0.86 | 3.93 | 0.681 | beetle A | 0.473 | distinct |
| beetle A | 4123 | 97×64 | 0.66 | 3.47 | 0.681 | mite | 0.544 | distinct |
| beetle B | 3319 | 79×86 | 1.09 | 4.68 | 0.621 | pink jellyfish | 0.507 | distinct |
| red quadruped | 2996 | 78×84 | 1.08 | 11.22 | 0.587 | warded | 0.492 | distinct |
| purple flyer | 5332 | 80×107 | 1.34 | 11.45 | 0.599 | red hulk | 0.536 | distinct |
| pink jellyfish | 7338 | 112×122 | 1.09 | 14.27 | 0.621 | beetle B | 0.559 | distinct |
| teal biped | 5937 | 92×98 | 1.07 | 9.50 | 0.634 | red hulk | 0.682 | distinct |
| green biped | 4311 | 70×103 | 1.47 | 4.18 | 0.599 | warded | 0.506 | distinct |
| wisp (flyer) | 4425 | 125×73 | 0.58 | 8.41 | 0.552 | beetle A | 0.349 | distinct |
| stalker cluster | 4640 | 92×97 | 1.05 | 9.49 | 0.637 | withering | 0.589 | distinct |
| **warded (warden)** | 16146 | 148×178 | 1.20 | 7.20 | **0.678** | red hulk | **0.642** | **distinct** |
| spitling wedge | 9881 | 120×143 | 1.19 | 14.48 | 0.621 | teal biped | 0.584 | distinct |
| **withering (golem)** | 16989 | 170×146 | 0.86 | 8.64 | **0.704** | red hulk | **0.722** | **distinct** |
| red hulk | 16232 | 162×167 | 1.03 | 7.20 | 0.704 | withering | 0.694 | distinct |
| tan quadruped A | 6415 | 135×93 | 0.69 | 6.15 | 0.604 | mite | 0.437 | distinct |
| tan quadruped B | 10991 | 166×113 | 0.68 | 13.73 | 0.642 | beetle A | 0.501 | distinct |

**0 of 120 pairs collapse (0.0%), at TH 18, 30, 45 and 60.** Round 2: 8 of 105 (7.6%).

### 1b. Round 2's collapsed cluster, re-measured

| round-2 collapsed pair | r2 IoU | **r3 IoU** | Δ |
|---|---|---|---|
| ward shell ↔ withering shell | 0.88 | **0.672** | −0.21 |
| green-cored dome ↔ withering shell | 0.87 | — | *the dome no longer exists as a subject* |
| green-cored dome ↔ ward shell | 0.87 | — | *ditto* |
| beetle ↔ green-cored dome | 0.85 | — | *ditto* |
| beetle ↔ ward shell | 0.81 | **0.541** | −0.27 |
| beetle ↔ withering shell | 0.80 | **0.572** | −0.23 |
| green-cored dome ↔ red blocky biped | 0.79 | — | *ditto* |
| ward shell ↔ red blocky biped | 0.79 | **0.678** | −0.11 |
| *ward shell vs a perfect disc* | 0.91 | **0.642** | −0.27 |
| *withering shell vs a perfect disc* | 0.91 | **0.722** | −0.19 |

Round 2's "green-cored dome" was a bloom halo that had eaten its host's outline. It
is not present in the shipped frame — every one of the sixteen resolves as a body.
**Axis 4 for the bestiary is the one place in this project where a fix agent's claim
survives independent re-measurement in full.**

### 1c. `09-survivors`, four survivors

Border flood, Manhattan RGB tol 12, components ≥6% of largest merged.

| survivor | bbox | area | fill | aspect | mask foot y | harness `footY` |
|---|---|---|---|---|---|---|
| RANGER | 130 × 239 | 15531 | 0.500 | 0.544 | 558 | 557 |
| ANVIL | 169 × 208 | 21477 | 0.611 | 0.812 | 558 | 557 |
| KESTREL | 108 × 313 | 12657 | 0.374 | 0.345 | 559 | 557 |
| ROOK | 140 × 230 | 18873 | 0.586 | 0.609 | 557 (boot, by eye) | 557 |

```
RANGER/ANVIL   0.398    ANVIL/KESTREL  0.203
RANGER/KESTREL 0.388    ANVIL/ROOK     0.444
RANGER/ROOK    0.559    KESTREL/ROOK   0.326
```

**Worst pair 0.559** against a 0.787 calibration — no collision, and the spread is
wider than round 2's (worst 0.487 on a narrower crop set). Four rigs, four stances,
four colour identities (steel-blue/orange, warm brown/tan, navy/white with a conical
helm, olive/green). **Answer to "are the four distinguishable as pure black
silhouettes": yes, unambiguously, for the first time.**

---

## 2. The affix design question, answered honestly

> *Do the five affixes now read as five distinct threats while leaving their hosts'
> silhouettes intact?*

**No — but not for the reason round 2 gave. The silhouette half is solved. The
"five distinct threats" half fails because three of the five are not photographed.**

What the eight shots in my domain actually contain:

| affix | where it is spawned | shipped size | reads as |
|---|---|---|---|
| `warded` | `11-bestiary` (`warden`) | 16,146 px | **a white wireframe icosahedron cage** over a purple host. Host's arms, legs and head are legible through it at 4×. discIoU 0.642. **A distinct threat.** |
| `withering` | `11-bestiary` (`golem`) | 16,989 px | **a green-tinted host with 5+ orbiting diamond/spike bits and no shell.** Host silhouette fully intact. discIoU 0.722. **A distinct threat.** |
| `overloading` | `04-combat` idx 6 | 1,067 buffer px (≈11,900 full-res) | host readable, but its two bits render as **85 px and 50 px glowing spheres at mean L 237, chroma 0.13** pasted across the host's chest. The blue identity is bleached out. **Legible as "an elite", not as "overloading".** |
| `blazing` | `04-combat` idx 0 | **70 buffer px (≈780 full-res, ~28×28)** | not readable as anything |
| `glacial` | `04-combat` idx 12 | **0 px** | **absent from the frame** |

So `04-combat` — the only combat shot that spawns the tier-1 set — photographs one
of its three tier-1 affixes at a size you could grade, one at 28×28 px, and one not
at all. The bestiary photographs both tier-2 affixes well.

Two residual VFX defects the fix did not close, both visible at 4–6×:

- **`11-bestiary`, withering host:** a horizontal bloom band blows out the golem's
  entire left shoulder to near-white, removing ~15% of the host's own outline on that
  flank. The shell is gone; a bloom is doing the same job.
- **`04-combat`, x1147–1207 y488–551:** a 61×64 px emissive at peak RGB **(255,255,218)
  — two channels hard-clipped** replaces the head and upper torso of a ~60 px enemy.
  1,728 px above L200 on a creature whose whole body mask is 136×108. Frame-wide,
  `04-combat` runs **1.92% any-channel clipping** (no all-channel clipping in any of
  the eight shots, so the FIX's "no white-out" is true in the narrow sense and false
  in the perceptual one — a channel clipping to 255 shifts hue, it does not stop).

---

## 3. Readability under load — the state of `04-combat`

The survivor's separation is genuinely fixed and the frame is genuinely worse.

```
region                     mean L   p50 L   >L150
pale-blue biped (mid)       155.3   159.1   59.8%
white blob 2 (C)            153.2   154.7   52.4%
PLAYER bbox                 133.3   148.9   46.6%
orange golem R              130.6   130.2   39.4%
pink cap enemy               84.4    68.0   13.1%
foreground terrain           48.9    47.8    0.1%
```

The player is now mid-frame in value rather than bottom. What replaced the old
defect:

1. **The harness's own probe records the player 42% occluded and passes it as
   informational.** `manifest.json`, `04-combat`, subject `"survivor unoccluded by
   the final lens"`: `{ "vis": 0.583, "boom": 5.25 }`, `kind: "info"`, `ok: true`.
   In the pixels: a foreground terrain mound tops out at **y536–556 across the
   player's own x-range (620–680)** while the player's head is at y≈415 — **the
   character is cut off at the waist.** No legs, no boots, no ground contact, in the
   one shot whose job is "can you find the player mid-fight".
2. **Six of 24 enemies render zero pixels.** `perPx` =
   `[70,503,234,168,237,352,1067,643,612,43,482,**0**,**0**,2692,**0**,1212,**0**,40,22,26,299,613,**0**,**0**]`,
   `visibleObjects: 18`. Round 2 measured two nulls; there are now six, and
   `minObjects: 8` passes over all of them. One of the six is the glacial elite.
3. **26,514 near-white px** in four blobs, all enemy body geometry (claim 10).
   Bodies of the pale hulk, the orange golem and the survivor sit inside one
   ~60-level value band with no dark break between them.

Axis 8 = 4. Findable player, unreadable fight.

---

## 4. Things confirmed still open, unchanged

- **`05-boss` is still photographed through a slot between two tree trunks.** Column
  profile, frac L<45 over y180–520: x900–950 **35.2%**, x950–1000 **85.3%**,
  x1000–1050 44.8%, x700–750 33.0%, x650–700 28.1%. Round 2 measured x960–1010 at
  89.5%. Visible Titan silhouette **175 × 286 px at 0.58 fill** with its head cut
  flat by the canopy at y195 and its right shoulder cut by the trunk at x925. The
  boss's shape in this frame is a rectangle. Round 2 defect 1 is untouched.
- **`12-boss-phases`'s telegraph is unchanged in every measured respect.** Four
  vertical scans: peak RGB (211–224, 229–234, 223–229), **chroma 0.04–0.08**,
  thickness 12–29 px, ground L 45 px *inside* the ring 41–58 against 42–78 *outside*
  — statistically identical, therefore **no fill and no "which side is lethal"
  information**. Still off the bottom and both sides of the frame. Round 2 defect 4
  is untouched.
- **`03-thirdperson`'s dynamic range is unchanged.** Every 2nd pixel, rows 0–760:
  **p05 31 / p50 36 / p95 63** against round 2's 31 / 35 / 64. 90% of the frame in a
  32-level band, 0.001% all-channel clipping. The survivor (helm L 98.5, coat 78.3)
  is still the only thing above the frame's own p95, and it is carrying the picture
  alone. Round 2 defect 6 is untouched.
- **`14`'s DAMAGE and SPEED bars are still pixel-identical** — both x1174→1286,
  113 px of a 220 px track (HEALTH 44, ARMOR 6, CRIT 66). Flagged in round 2 below
  the cut, not touched.
- **`09-survivors` still ships the live HUD, the crosshair and a cyan pickup arrow**
  over a roster comparison shot.

---

## 5. Strengths (not scored, but real and hard-won)

- **The affix silhouette collapse is closed.** 8 collapsed pairs → 0, at four
  thresholds, on an instrument calibrated to within 0.010 of round 2's. This is the
  first fix in five rounds that survived independent re-measurement without a caveat.
- **`09-survivors` staging is fixed exactly as claimed.** Four survivors, one ground
  plane, four footlines within 2 px, four visible pairs of boots. ROOK's burial —
  which two rounds called the worst staging defect in the set — is gone.
- **RANGER's detached head in `03` is fixed** (neck 0.97:1 → 1.85:1; one connected
  component at TH 24 and 34).
- **Three survivor outlines improved by 0.3–0.4 in median contrast ratio** and the
  fraction of outline below 1.5:1 halved on RANGER and ANVIL.
- **The determinism work is visible in the record.** `clockPinned: true`,
  `frameTimeouts: 0`, `08-explosion` shutter published as `age 0.1167 / sim 0.1167 /
  exact: true`. I did not re-run the capture, but every number I took off these PNGs
  now has a stated provenance, which is more than any earlier round had.
- **`11-bestiary` resolved 16 of 16 subjects.** Round 2 lost one to the frame.

---

## TOP DEFECTS (ranked, capped at 6)

1. **`src/core/Harness.js` `boss()` — `05-boss` still photographs the Stone Titan
   through a slot between two trunks, and the boss is 2.29× the survivor.**
   Unchanged from round 2 on every measurement: dark-column fraction x950–1000
   **85.3%**, x700–750 33.0%; Titan visible silhouette **175 × 286 px at 0.58 fill**,
   head cut flat by canopy at y195. At matched footline (both y480) Titan 286 px
   vs survivor 125 px = **2.29×**, against a 3× design target and RoR2's ~5×. The
   scale problem and the framing problem compound: the one boss shot in the set
   photographs the boss smaller *and* boxed. **Fix:** give `boss()` the
   `bestCam(...)` + `frameOccluders` search `bossPhases()` already uses
   (`Harness.js:2396-2412`) with the extra acceptance term round 2 specified —
   reject any camera where props nearer than the subject cover >10% of the
   subject's *projected bounding box*, which is a different test from frame
   occlusion and is the one this shot fails. Separately, raise the Titan's
   `height` so it reads ≥3× a survivor at matched depth, and assert that ratio in
   the shot rather than asserting pixel count.

2. **`src/core/Harness.js` `combat()` — the survivor is cut off at the waist by a
   foreground mound and six of 24 enemies render zero pixels.** The harness's own
   probe writes `"survivor unoccluded by the final lens": { vis: 0.583, boom: 5.25 }`
   as `kind: "info"`, `ok: true` — it measures the player **42% occluded** and passes
   it. In the pixels the occluder tops out at y536–556 across the player's own x-range
   while the head is at y≈415: no legs, no boots, no ground contact. `perPx` carries
   **six zeros** (indices 11, 12, 14, 16, 22, 23) with `visibleObjects: 18` and
   `minObjects: 8` passing; index 12 is the `glacial` elite, so the shot certifies an
   elite affix that is not in the photograph. **Fix, two parts.** (a) Promote the
   `vis` probe from `info` to a gate — fail the shot below ~0.85, and extend
   `clearSurvivorFromLens` to reject bearings where *terrain* crosses the survivor's
   lower half, not only where the boom intersects rock. (b) Replace `minObjects` with
   `visibleObjects >= 0.9 * objects` **and** a per-object floor of ~30 buffer px, so a
   spawned elite that draws nothing fails the capture instead of shipping green.

3. **A new terrain specular speckle is now the highest-frequency thing in three
   frames, and it sits directly behind the subjects.** `09-survivors`, hillside band
   x560–1350 y120–470: **18.37% of the band above L140**, in **767 connected
   components of median 2 px** (696 under 30 px); high-frequency residual against a
   7 px median has std 16.7 and p99 **88 luminance levels**. `11-bestiary` band
   x100–700 y120–500: 7.19% above L140, 597 components, median 2 px. Whole-frame
   residual against a 16×16 background model went from round 2's p90 = 28.4 to
   **p90 = 92.5** on `11-bestiary` — I had to add a morphological opening to my
   segmenter purely to survive it. This is a shimmering white confetti field behind
   every silhouette in the roster shot and the bestiary shot, and it is what costs
   axis 9 its two points this round. **Fix:** this is specular aliasing on the
   terrain's normals — the highlight lobe is narrower than a pixel at this distance.
   Clamp terrain roughness to a floor that grows with screen-space depth (a
   Toksvig/normal-variance term, or simply `roughness = max(roughness, k * ddx(N))`),
   or drop terrain specular intensity to near zero beyond ~20 m and carry the sun on
   albedo alone. Assert it: count connected components above L140 in a ground band
   and fail above ~100.

4. **`src/entities/EnemyMeshes.js:3676` + `src/systems/Director.js:1023-1034` — the
   boss telegraph is unchanged from round 2, measurement for measurement.** Four
   scans of `12-boss-phases` at 86–89% wind-up: peak RGB (211–224, 229–234, 223–229),
   **chroma 0.04–0.08**, thickness 12–29 px, ground luminance 45 px inside the ring
   **41–58** against 42–78 outside — no fill, therefore nothing in the frame says
   which side is lethal. Still larger than the frame on three sides. **Fix (round
   2's, restated because it was not attempted):** hold the *radius* at the true blast
   from frame one and animate a low-alpha *fill* 0→1 across the wind-up — the disc is
   the "where", the fill is the "when" — in the attack's declared hue at ~0.6× the
   frame's highlight luminance so it separates from the sun and from the boss's own
   near-white body.

5. **`src/entities/CharacterMesh.js` — KESTREL's raised forearm is a detached
   floating block and its coat is held together by two ~2 px hairline struts, in two
   shipped shots.** At 4× in `shots/09-survivors.png` (crop 875,240–1005,580) and 4×
   in `shots/14-survivor-select.png` (crop 680,215–840,555) the same two faults are
   visible: (a) the raised left arm has a clear gap between the upper-arm block and
   the shoulder — it is not connected to the body; (b) two 2 px light lines run from
   the shoulder past the hip to the knee with no surface between them, and the left
   leg below the coat is a 2 px line rather than a limb. This is the rig, not the
   preview — it reproduces in-game. It is the reason KESTREL's mask fill is **0.374**
   against 0.500–0.611 for the other three. **Fix:** weld the forearm to the shoulder
   in the KESTREL rig and give the coat's side seams and the lower legs real box
   geometry with a minimum world thickness, then assert it — flood the rig at tol 12
   in `09` and require **one** connected component per survivor, the same test that
   caught RANGER's head in `03`.

6. **`src/ui/Logbook.js` `ModelPreview` — the survivor portrait now has literally no
   key light, and the roster is still four text rows.** Measured in the 646 × 388
   viewport: subject 187 × 312 px = **28.9% of viewport width, 80.4% of height, 8.5%
   of area** — the framing half of round 2 defect 5 landed. The lighting half went
   backwards: **key/fill delta across the subject is 2.2 L on a mean of 74.9 — a 3%
   split**, against round 2's already-failing 10%. There is one flat ambient and
   nothing else, which is why the loose rig geometry in defect 5 is so visible here.
   Contact shadow is still absent — one row below the feet reads L 15.4 against an
   empty-corner 5.0, i.e. the ground under the model is *brighter* than the backdrop,
   and it is a 1 px rule. And the four roster rows still carry no character imagery,
   raised in round 1, round 2 and untouched. **Fix:** three-point rig — key 45°
   camera-left and above, cool rim behind camera-right, weak ambient — targeted at a
   left/right delta ≥40 L; a real elliptical contact shadow at ~0.35× backdrop
   luminance on a visible plinth; and a silhouette thumbnail in each roster row.

**Below the cap but real:**

- **`08-explosion` is bigger and still has no fireball.** The blast is a single
  formless 318 × 337 px bloom, **65,889 px above L200**, mean RGB (245,236,206),
  **chroma 0.16** — there is no core edge, no ring, no flame colour, only debris
  shards and a radial white gradient. It reads as a lens flare. Compare the
  `12-boss-phases` sunset, which proves the renderer can hold warm colour at high
  luminance. Layer *count* is not the problem; the core's colour and edge are.
- **`11-bestiary` is still not a rank.** Ground-contact y spans **304 → 597**
  (293 px) on a camera where subjects are 44–178 px tall, and area is non-monotonic
  in x (wisp 4,425 px at x980 sits between spitling 9,881 px at x966 and withering
  16,989 px at x1052). Round 2 defect 6, untouched.
- **No enemy in any of the eight shots casts a directional shadow.** Round 2 said
  this; it is still true, and it is the cheapest missing lighting cue in the project.
- **`04-combat` runs 1.92% any-channel clipping** (highest in the domain) with heavy
  chromatic aberration at the frame edges; `08-explosion` 1.58%.

---

## Commands / method

- Python 3.14 + Pillow 12.3.0 + numpy 2.5.1 + scipy 1.18.0. All measurements on the
  shipped PNGs at native 1600×900, mode `RGB`. Working files in the session
  scratchpad, not the repo. **No code was edited and no capture was run.**
- Luminance `0.2126R + 0.7152G + 0.0722B` on 8-bit sRGB, reported 0–255.
  Chroma `(max−min)/max`.
- Silhouette instrument: `r3lib.py` (background model, uniform-scale normalisation,
  translation-searched IoU, calibration shapes), `s11.py` (bestiary boxes,
  segmentation, 16×16 IoU matrix, threshold sweep, contact sheet `sheet11.png`),
  `s09.py` (survivor flood, footlines, leg-run bands, pairwise IoU, outline contrast),
  `s05.py` (Titan/survivor extents, trunk column profile), `s0812.py` (blast blob,
  telegraph scans, frame DR, speckle census), `s14.py` (portrait metrics, stat bars,
  CTA contrast), `s04.py` (near-white census, region luminance).
- Calibration run before any verdict: disc vs square **0.787**, disc vs 1:4 bar
  0.320, square vs 1:4 bar 0.255. Collapse threshold set at 0.787.
- Threshold sensitivity: every bestiary verdict recomputed at TH 18 / 30 / 45 / 60;
  zero collapsed pairs at all four.
- Visual confirmation at 2×–6× nearest-neighbour on: the bestiary left and right
  halves, the `warded` host, the `withering` host, ROOK, RANGER and KESTREL in `09`,
  the `04` survivor at two crops, the `04` overloading elite, the `04` white blobs,
  the `04` right-hand elites, the Titan and its survivor in `05`, the `08` blast core,
  and the `14` portrait.
- Repo cross-checks (read-only): `Harness.js:578-581` and `:2914-2916` for affix
  assignment; `enemies.js:1022-1027` for `ELITE_AFFIXES` order (`blazing`,
  `overloading`, `glacial`, `withering`, `warded`), which is what maps `perPx[12] = 0`
  onto `glacial`; `EnemyMeshes.js:169-189` for the current `ELITE` table.

**Measurements I ran and am not reporting as evidence:** a residual-model outline
contrast for the `04-combat` survivor. Its mask over-grew to 144 × 165 px because the
survivor and the enemies touching it share a value family, and a boundary that
arbitrary cannot carry a contrast number. The harness's own hide-and-diff
(`sepP50 0.59`, `legible 0.915`) is the honest figure for that subject and is what I
used. Aspect-stretched IoU was also computed and is not quoted, for round 2's reason.
