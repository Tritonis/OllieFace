# Round 5 — Critic R2: Enemies, Bosses, Combat Readability

Domain: rubric axis 4 (silhouette & form), axis 6 (VFX quality), axis 8 (readability under load).
Shots judged: `11-bestiary`, `12-boss-phases`, `05-boss`, `04-combat`.
Round 2 of a maximum 4. **This is the first round in which axis 8 could be scored at all** — round 1's
`04-combat` contained no enemies and its `05-boss` contained no boss, so those two round-1 scores are void.

---

## Manifest check

`shots/manifest.json`: `ready: true`, `partial: false`, `errors: []`, **`subjectsOk: true`,
`subjectFailures: []`**. The new subject assertions pass on all 19 shots. Every shot in this domain
contains its subject. No engine defect; everything below is visual.

Two numbers from the manifest are load-bearing evidence and are quoted throughout, because they are
ground-truth measurements the harness makes by hide-and-diff (`Harness.js:948-1023`) rather than by
my segmentation:

- `contrast` is Michelson `|Ls − Lb| / (Ls + Lb)` over exactly the subject's pixels against exactly
  what is behind them (`Harness.js:1018`).
- `px` / `perPx` are counted in a 480×270 buffer (`Harness.js:945`), i.e. ×11.11 in area to reach the
  1600×900 PNG.

---

## AXIS SCORES

```
AXIS SCORES 11-bestiary:    1:4 2:3 3:4 4:5 5:4 6:3 7:7 8:5 9:5 10:7   mean 4.7
AXIS SCORES 12-boss-phases: 1:5 2:6 3:7 4:5 5:4 6:5 7:7 8:5 9:6 10:7   mean 5.7
AXIS SCORES 05-boss:        1:3 2:2 3:4 4:2 5:4 6:3 7:6 8:3 9:5 10:6   mean 3.8
AXIS SCORES 04-combat:      1:4 2:4 3:4 4:4 5:4 6:5 7:7 8:3 9:5 10:7   mean 4.7

VERDICT: FAIL
```

Pass bar is 7+ on every axis with nothing below 6. `12-boss-phases` is the only shot in the domain that
is close to being a real photograph; `05-boss` is the worst frame I have looked at in this project that
was not empty.

The domain has genuinely moved. The bestiary occluder is gone, the combat shot has a horde, the boss
shots have bosses, and a wind-up telegraph now exists. What has *not* moved is that the elite VFX
system is actively subtracting silhouette information, and that enemy albedo is not authored against
the terrain grade.

---

## 1. The silhouette question, settled

Round 1's automated pairwise IoU was discarded as garbage (its border-ring background sampler picked up
neighbouring enemies). **I built a different instrument, validated it, and it does not agree with round 1.**

### The instrument

1. **Background model, not border ring.** Every enemy bounding box (dilated 8 px) is *excluded* from the
   background estimate — this is the exact bug that killed round 1's version. The ground is then modelled
   as a 16×16-cell median over the surviving pixels, nearest-filled and bilinearly upsampled to full res.
   Residual `D = ‖I − B‖₂` over the whole frame: median **4.2**, p90 **28.4**, p99 **250.7** — the ground
   model is tight, so a threshold at 30 sits above the 90th percentile of everything that is *not* a subject.
2. **Component selection, not box fill.** Within each box, `D > TH`, 3×3 closing, connected components,
   keep components intersecting the central 50% of the box and ≥8% of the largest such — so an adjacent
   enemy that intrudes into the box corner is dropped.
3. **Shape normalisation.** Each mask is cropped to its bbox, uniformly scaled (aspect preserved) so its
   longest side is 102 px, centroid-centred on a 128×128 canvas. IoU is maximised over a ±6 px translation
   search. Uniform scaling — *not* aspect-stretching — is the correct test for "differs only by scale".

### Instrument validation (this is where round 1 went wrong, so it is shown)

- **Mask fill fractions run 0.41–0.91**, not round 1's degenerate 0.98. The masks are not "everything is
  foreground".
- **Visual check.** A 15-cell contact sheet (crop | mask) was rendered and inspected. Masks track the
  visible bodies; the pink jelly loses part of its four stilts and the mite loses its antenna tip — thin
  limbs below ~2 px are under-detected.
- **Calibration.** Two shapes any human calls obviously different — a perfect disc and a perfect square —
  score **IoU 0.777** on this metric. IoU on filled blobs has a compressed dynamic range; a raw threshold
  of 0.7 would be meaningless. **I therefore use 0.78 (the disc-vs-square figure) as the collapse
  threshold**: at or above it, two silhouettes are no more distinguishable than a circle from a square.
- **Threshold sensitivity.** Every conclusion below was recomputed at `TH` = 18, 30, 45, 60. No verdict
  flips. The largest swing on any watched pair is 0.11.
- **Known bias, stated.** Under-detecting thin limbs makes shapes *more* alike, so this instrument is
  biased **toward** finding collapse. That means the "distinct" verdicts are conservative and robust; the
  "collapsed" verdicts are the ones to distrust — except that all three of the worst offenders are
  limbless shells and halos, where the bias cannot apply.

15 of the 16 subjects the manifest counts were individually resolvable. The 16th (~740 full-res px by the
manifest's `perPx`) could not be isolated and is excluded — noted as a shot defect, not hidden.

### The real pairwise collapse table

*Uniform-scale-normalised silhouette IoU, `11-bestiary`, TH = 30. Collapse threshold = 0.78 = the
disc-vs-square calibration. Names are inferred from shape/colour; where inference is uncertain the label
is descriptive.*

| subject | max IoU vs any other | its partner | IoU vs a perfect disc | verdict |
|---|---|---|---|---|
| ward shell (`warden` + `warded`) | **0.88** | withering shell | **0.91** | COLLAPSED / reads as a CIRCLE |
| withering shell (`golem` + `withering`) | **0.88** | ward shell | **0.91** | COLLAPSED / reads as a CIRCLE |
| green-cored dome (bloom halo) | **0.87** | withering shell | **0.91** | COLLAPSED / reads as a CIRCLE |
| beetle | **0.85** | green-cored dome | 0.83 | COLLAPSED |
| red blocky biped (`hulk`) | **0.79** | green-cored dome | 0.77 | COLLAPSED |
| brown spiky cluster (`stalker`) | 0.78 | red blocky biped | 0.76 | borderline |
| teal crystalline biped (`acolyte`) | 0.77 | green-cored dome | 0.74 | borderline |
| tan quadruped B | 0.74 | teal biped | 0.61 | distinct |
| orange crab-golem | 0.69 | beetle | 0.66 | distinct |
| green cactus biped (`brood`) | 0.69 | brown spiky cluster | 0.58 | distinct |
| tan quadruped A | 0.61 | tan quadruped B | 0.54 | distinct |
| orange wedge (`spitling`) | 0.59 | mite | 0.37 | distinct |
| mite | 0.59 | orange wedge | 0.46 | distinct |
| pink jellyfish | 0.59 | tan quadruped A | 0.42 | distinct |
| purple flyer (`wisp`) | 0.59 | tan quadruped B | 0.44 | distinct |

**8 of 105 pairs (7.6%) collapse**, and all 8 sit inside one 5-member cluster:

```
0.88  ward shell        <-> withering shell
0.87  green-cored dome  <-> withering shell
0.87  green-cored dome  <-> ward shell
0.85  beetle            <-> green-cored dome
0.81  beetle            <-> ward shell
0.80  beetle            <-> withering shell
0.79  green-cored dome  <-> red blocky biped
0.79  ward shell        <-> red blocky biped
```

**Nine of the fifteen have no collapse partner at all.** The base roster's silhouette variety is real.
What destroys it is VFX: two of the three circles are *elite affix shells*, and the third is a bloom halo
that has eaten its host's outline. The single most damaging thing this project could do to its enemy read
is exactly what its elite system currently does.

Supporting shape descriptors (aspect = h/w, complexity = perimeter²/4πA, i.e. 1.0 for a circle):

| subject | area px | w×h px | aspect | complexity |
|---|---|---|---|---|
| purple flyer | 393 | 32×30 | 0.94 | 3.11 |
| mite | 622 | 29×41 | 1.41 | 2.03 |
| orange wedge | 817 | 38×52 | 1.37 | 1.78 |
| teal biped | 2381 | 56×62 | 1.11 | 1.40 |
| pink jellyfish | 2881 | 66×92 | 1.39 | 3.40 |
| green cactus biped | 3165 | 56×82 | 1.46 | 2.91 |
| brown spiky cluster | 3509 | 52×74 | 1.42 | 1.38 |
| beetle | 3520 | 73×69 | 0.95 | 1.22 |
| tan quadruped A | 3893 | 91×86 | 0.95 | 2.07 |
| green-cored dome | 4148 | 75×73 | 0.97 | 1.22 |
| tan quadruped B | 5932 | 97×106 | 1.09 | 1.76 |
| orange crab-golem | 7706 | 98×114 | 1.16 | 2.14 |
| red blocky biped | 11150 | 112×132 | 1.18 | 1.48 |
| ward shell | 13255 | 130×132 | 1.02 | 1.24 |
| withering shell | 18066 | 144×151 | 1.05 | 1.72 |

---

## 2. Round-1 claim ledger

| # | Round-1 claim | Status | Evidence |
|---|---|---|---|
| 1 | `beetle` ↔ `mite` differ only by scale | **REFUTED** | IoU 0.47 / 0.48 / 0.56 / 0.58 at TH 18/30/45/60 — below the 0.78 baseline at every threshold. Descriptors differ hard: mite aspect 1.41, complexity 2.03; beetle 0.95 / 1.22. |
| 2 | `golem` ↔ `hulk` are the same blocky biped | **REFUTED as measurable** | Orange crab-golem vs red blocky biped: 0.73 / 0.68 / 0.66 / 0.64 — below baseline at every threshold. Caveat stated: the green golem in this shot is inside a `withering` shell, so the literal pair round 1 named cannot be re-measured on these pixels. |
| 3 | Three tan quadrupeds collapse into terrain-rock lumps | **PARTIAL** | Shape refuted (quad A vs quad B 0.59–0.64). Value confirmed: in `04-combat` two of them overlap into a single 8-legged mass (mask intersection 3,441 px = 39% of the smaller), and the third clears its slope by only ΔRGB 49 / Weber 0.21. |
| 4 | Roughly 3 of 16 survive a silhouette threshold | **REFUTED** | 9 of 15 measured subjects have no partner at or above calibration; only 8 of 105 pairs collapse. |
| 5 | `warded` reduces the host to a circle | **VERIFIED** | 0.90 / 0.91 / 0.91 / 0.87 vs a perfect disc across thresholds. **Escalated:** `withering` does the same (0.93 / 0.91 / 0.90 / 0.90) and the two shells are 0.91 / 0.88 / 0.88 / 0.84 from *each other*. |
| 6 | Bosses are ~1.5× the largest enemy, not 3× | **VERIFIED, and worse in the pixels** | Data unchanged (`titan` 7.6 vs `hulk` 4.2 = 1.81×; `vizier` 6.4 = 1.52×). Pixels: see §3. |
| 7 | The 85% wind-up frame has no telegraph VFX at all | **REFUTED** | A ground telegraph ring is present, at the attack's true 16 m blast radius. See §4 — it is present and it is weak, which is a different defect. |
| 8 | Only 2 of 5 affixes appear in any shot | **REFUTED** | `Harness.js:1267` `spawnRing(24, SPAWN_CARDS, 13, 6)` + `:465-467` puts `blazing`, `overloading`, `glacial`, `withering` in `04-combat`; `:2320-2321` adds `warded` in `11-bestiary`. All five are photographed. |
| 9 | A ~350 px black trunk bisects the bestiary rank | **FIXED** | Column profile (frac lum < 45, y 280–660): worst column is x300–370 at 17.5%; every column from x440 to x1350 is under 10%. Round 1's 60.9% / 67.8% columns are gone. |
| 10 | `04-combat` has zero enemies; `05-boss` has no boss | **VOID (scored against broken shots) — now resolved** | Both frames contain their subjects; `subjectsOk: true`. |
| 11 | The tracer terminates on an undrawn entity | **REFUTED** (by `DIAG-invisible-enemies.md`, not re-litigated here) | — |

Three round-1 claims in my own domain are withdrawn. Round 1's silhouette section was written from a
keyed pass read by eye, and the eye was wrong.

---

## 3. Boss scale, in the pixels

**Measured, `05-boss`, at matched ground depth** (survivor's feet y≈473, titan's feet y≈480 — same
ground plane, so the ratio is close to a true scale ratio and not a depth artefact):

| subject | visible bbox | height px | area px |
|---|---|---|---|
| STONE TITAN | x760–925, y189–480 | **301** | 43,834 |
| survivor | — | **118** | 3,108 |
| tan quadruped (same slope, x1149) | — | 84 | 2,888 |

**Titan / survivor = 2.55×. Titan / common enemy = 3.58×.**

And 2.55× is generous: the survivor mask includes a raised weapon, and the titan's head is cut off by
the canopy (see §5, defect 1). RoR2's Stone Titan reads at roughly 5× a survivor at gameplay distance;
this reads at two and a half, through a letterbox.

The `12-boss-phases` figure of vizier/survivor = **4.77×** (348 px vs 73 px) is **not usable** — that
survivor is standing far behind the boss near the telegraph rim, so the ratio is inflated by perspective.
I am not quoting it as evidence. The vizier does frame well in absolute terms: 348 px = **38.7% of frame
height**, up from round 1's 33%.

Silhouette family: the vizier is still the `golem`/`hulk` template scaled up — torso slab, two arms, two
legs — but it now carries a shoulder tower and a blade plane that no common enemy has, so it is not a
pure duplicate. It reads as "the biggest biped", not as "a different kind of thing". Round 1's fix
recommendation (give each boss a silhouette anchor no common enemy uses) stands unimplemented.

---

## 4. Boss telegraph — round 1 was wrong, and it is still not good

**The telegraph exists.** `Enemy.js:1350-1353` spawns a ground ring for any `nova`/`slam`/`stomp`/`pull`
at the attack's real `blast` radius, and it is in the frame: an enormous pale ring across the plateau at
86% wind-up (manifest: `mid wind-up: 0.86`). Vertical scans at six x positions:

| x | ring peak y | peak L | RGB at peak | thickness >60% peak | L 40 px inside | L 40 px outside |
|---|---|---|---|---|---|---|
| 320 | 527 | 229 | (215,233,230) | 21 px | 37 | 44 |
| 520 | 495 | 230 | (215,234,230) | 14 px | 43 | 65 |
| 1050 | 498 | 230 | (215,234,230) | 8 px | 57 | 49 |
| 1450 | 591 | 232 | (221,235,231) | 42 px | 45 | 53 |

What the pixels say:

1. **It is an outline, not a footprint.** Ground inside the ring measures L 37–75; outside, L 44–95.
   Identical. There is no fill, so nothing in the frame says *which side is lethal* — only where the
   boundary is. `EnemyMeshes.js:3676` builds it as `ring(1, 0.028, 3, 40)`, a thin additive torus.
2. **It is achromatic.** RGB ≈ (215,234,230) → chroma (max−min)/max = **0.08**. The attack's declared
   colour is `0x9fe8ff`; additive blending plus bloom has bleached it to white. In a frame whose sun,
   rock highlights and the boss's own body are all near-white, the one element the player must read is
   the least-separated thing on screen.
3. **It is bigger than the frame.** The 16 m blast at this camera puts the rim off the bottom and both
   sides. The player cannot see the far edge of the zone they are being asked to leave.
4. **The ring lies for two-thirds of the wind-up.** `Director.js:1029`:
   `t.mesh.scale.setScalar(t.r * (0.55 + 0.45 * k))`. The drawn radius starts at 55% of the true blast and
   only reaches 100% at the instant of the hit. A player standing at 0.7 r sees themselves *outside* the
   ring for the first third of the tell and inside it at the end. (Code-derived; at k = 0.86 the shipped
   frame is at 0.94 r, so this specific frame does not show it — but it is the mechanism behind a ring
   that has no honest fill.)

Round 1's claim that the boss's chest disc is a body feature rather than a state change **cannot be
settled from one frame** — there is no non-wind-up frame of the same boss in the shot set to compare
against. Marked unresolved, not confirmed.

---

## 5. Elite affixes — a coloured ball glued on the host

All five affixes are photographed. In shipped pixels, here is what each one contributes:

| affix | shipped signature | silhouette effect |
|---|---|---|
| `blazing` (`04-combat`, x1230–1400) | ~150×140 px opaque orange sphere with a white core covering half the golem's torso. **Zero of its 5 declared orbiting bits are visible.** | destroyed |
| `overloading` (`04-combat`, x1130–1260) | the identical ball in cyan, white-cored. Zero bits visible. | destroyed |
| `glacial` (`04-combat`, x690–800) | a 108×81 px matte near-white mass, mean RGB (193,181,172), chroma 0.18, 40.6% of it above L 230, no internal structure. Only a tan foot protrudes at the bottom. | destroyed |
| `withering` (`11-bestiary`) | translucent green sphere shell. IoU 0.91 vs a perfect disc. | destroyed |
| `warded` (`11-bestiary`) | purple icosahedron shell with white wireframe. IoU 0.91 vs a perfect disc. | destroyed |

`EnemyMeshes.js:137-141` states the design intent exactly right: *"at a distance a tint is the first
thing tone mapping takes away"*, so each affix is supposed to carry bit count, bit shape and orbit style.
The shipped frames deliver **tint and nothing else**. And two of the five are duplicates by construction:
`EnemyMeshes.js:143-144` gives `blazing` and `overloading` the identical `bits: 5, shape: 'ico',
bitScale: 0.11` — the only difference in the table is the hex colour.

On the escalated claim about `glacial` in `04-combat`: **erasure CONFIRMED, description PARTIAL.** The
mass does erase its host completely. But it is not clipped white — frame-wide all-channel clipping is
0.016%, identical across all four shots and attributable to HUD text — it is a high-value, low-chroma
matte lump (Weber 0.58 against its surround). And it is not hexagonal; `glacial`'s bit shape is
`cone(r*0.7, r*2.0, 3)`, a triangular shard. Attribution to `glacial` is inference: it is the only affix
spawned into that frame otherwise unaccounted for.

---

## 6. Axis 8 under load — the first honest scoring

**Can you find the player?** Barely, and the harness's own ground truth says so louder than I can.
`04-combat`, survivor: `contrast: 0.053`. The same survivor measures **0.758** in `03-thirdperson`,
**0.771** in `05-boss`, **0.780** in `06-loaded-hud`. In the single shot that exists to answer "can you
find the player mid-fight", the player is **14× less separated from its own background than in every
other shot in the set.** Point sample confirms: player torso (53,61,80) vs the ground directly beneath
(57,41,73) = **ΔRGB 21.6**. What actually finds the player in that frame is the green ability ring on the
floor, not the character.

**Can you tell threats apart?** Not on the right half. Point samples of enemy body vs the rock directly
behind it:

| pair | subject RGB | background RGB | ΔRGB | Weber |
|---|---|---|---|---|
| orange golem vs rock behind | (242,129,81) | (222,116,76) | **24.4** | 0.10 |
| red hulk vs rock behind | (214,123,80) | (209,127,111) | **31.7** | 0.03 |
| pale hulk vs rock behind | (172,178,175) | (255,172,109) | 106.2 | 0.05 |
| tan quadruped (BR) vs slope | (205,146,75) | (215,109,45) | 48.7 | 0.21 |
| — left half, same frame — | | | | |
| khaki beetle vs ground | (224,194,126) | (67,42,67) | **226.3** | 2.98 |
| tan quadruped (L) vs ground | (255,228,176) | (50,37,65) | **301.4** | 4.50 |

Separation varies **~12×** across one frame, decided entirely by which side of the sunset an enemy
happens to be standing on. The three largest and most dangerous enemies in the shot are the three least
separated. My own segmenter, which cleanly isolated every left-hand enemy, could not cleanly isolate the
right-hand cluster — because there is no colour boundary there to find.

Bodies also merge into each other: pale hulk ∩ orange golem = 7,350 px; orange golem ∩ red hulk = 3,584 px;
the two left tan quadrupeds = 3,441 px (39% of the smaller), reading as one 8-legged animal.

**Can you distinguish elites at a glance?** You can see that *something* is an elite — the balls are
unmissable. You cannot tell *which* elite: blazing and overloading are the same ball in two hues, and
neither shows the bits that were supposed to carry the identity.

**How much load is actually in the shot?** Manifest `perPx` for the 24-enemy horde (480×270 buffer):
`[67,170,1,153,83,211,739,681,0,83,244,98,186,2632,342,4031,23,389,50,13,133,314,352,985]`. Two enemies
render **0 and 1 pixel** (`visibleObjects: 22` of 24 admits it); nine render under 100 buffer-px
(≈ 33×33 in the PNG); four carry the frame. That is a legitimate horde silhouette for a distance-graded
fight, but the two null entries are a real miss the assertion does not catch — `minObjects: 8` passes
happily with two invisible monsters.

---

## TOP DEFECTS (ranked, capped at 6)

1. **`src/core/Harness.js` `boss()` — `05-boss.png` photographs the Stone Titan through a slot between
   two black tree trunks; the boss's silhouette in the shipped frame is a rectangle.** Column profile
   (frac lum < 45, y 180–520): x910–960 = 46.2%, **x960–1010 = 89.5%**, x1010–1060 = 40.4%, and x710–760
   = 22.1% on the other flank. Row-by-row, the titan's mask left edge is pinned at x760–778 and its right
   edge at x903–925 for 14 of 16 sampled rows — those are trunk edges, not creature edges — and the top
   is cut flat at y189 by the canopy. Visible silhouette: 184×301 px at 0.79 fill, i.e. a filled box.
   `mustContain` passed at 2,673 buffer-px because it counts *pixels*, not *outline*. **Fix:** give
   `boss()` the `bestCam(...)` + `frameOccluders` search that `bossPhases()` already uses
   (`Harness.js:2396-2412`), and add an acceptance term the frame-level one does not cover — reject any
   camera where props nearer than the subject cover more than 10% of the subject's *projected bounding
   box*. Frame occlusion and subject-outline occlusion are different tests and this shot fails the second.

2. **`04-combat.png` — the survivor has 0.053 Michelson contrast against exactly what is behind it, in
   the one shot that exists to test finding the player.** The same survivor scores 0.758 / 0.771 / 0.780
   in the three other shots that contain it. Torso-vs-ground point sample: ΔRGB 21.6. The only thing that
   locates the player is the green ability ring on the floor. **Fix:** the character needs a
   separation channel that does not depend on the stage grade — a camera-relative rim term on the player
   material only (not on enemies, or it stops being a player cue), plus a hard contact-shadow band at the
   feet. Then add a `contrast >= 0.35` assertion on the survivor subject in every gameplay scenario so a
   frame like this fails the capture instead of shipping green.

3. **`src/entities/EnemyMeshes.js:142-152` + `:594-613` — every elite affix reduces its host to a
   featureless ball, and two affixes are geometrically identical.** Measured: `warded` 0.91 and
   `withering` 0.91 IoU against a perfect disc, and 0.88 against each other; `blazing` and `overloading`
   in `04-combat` are two opaque spheres with blown white cores and **not one of their 5 declared orbiting
   bits is visible in either**. `:143-144` declares both with the same `bits: 5, shape: 'ico',
   bitScale: 0.11` — the tint is the entire difference, which is precisely what the comment at `:140`
   says will not survive tone mapping. **Fix, three parts:** (a) replace the full aura shell
   (`makeAura`, `ico(1,2)` at `glow` 2.2–3.0) with an equatorial band, shoulder cage or wireframe-only
   hull at low alpha, so the host's outline reads *through* it; (b) give every affix a distinct
   `bits` × `shape` × orbit-plane triple — `blazing` and `overloading` must not share a row — and raise
   `bitScale` so a bit subtends ≥6 px at 25 m instead of 0.11 × auraR; (c) clamp the aura's additive
   contribution so the core does not white out at close range.

4. **`src/entities/EnemyMeshes.js:3676` + `src/systems/Director.js:1023-1034` — the boss telegraph is an
   achromatic unfilled outline that is larger than the frame and under-draws the kill zone for most of
   the wind-up.** Measured at 86% wind-up: RGB (215,234,230), chroma 0.08, thickness 8–42 px, ground
   luminance inside the ring (37–75) statistically identical to outside (44–95) — no fill, therefore no
   "which side is lethal" information. `Director.js:1029` scales the drawn radius `0.55 → 1.0 × r` across
   the wind-up, so the ring is a moving boundary rather than a fixed danger zone. **Fix:** hold the
   *radius* at the true blast from frame one and animate a low-alpha *fill* 0→1 across the wind-up
   instead — the disc is the "where", the fill is the "when". Drive the fill in the attack's declared hue
   at ~0.6× the frame's highlight luminance so it separates from the sun and from the boss's own
   near-white body.

5. **Enemy albedo is not authored against the terrain grade — `04-combat`'s three largest threats are
   ΔRGB 24–32 from the rock directly behind them.** Orange golem vs backing rock ΔRGB 24.4 / Weber 0.10;
   red hulk ΔRGB 31.7 / Weber 0.03; pale hulk Weber 0.05. On the *left* of the same frame, enemies clear
   their ground by ΔRGB 226–301. A ~12× separation swing inside one image, decided by accident of
   placement. Bodies consequently merge: pale hulk ∩ orange golem 7,350 px, the two left quadrupeds
   3,441 px (39% of the smaller) reading as one animal. **Fix:** clamp enemy body albedo out of the top
   decile of the stage's terrain luminance histogram (the same way the HUD reserves its value range), and
   add a per-enemy dark contact/AO rim at the silhouette edge so two overlapping bodies always have a
   value break between them. Colour variety is currently spent on species identity; it needs to be spent
   on figure-ground first and species second.

6. **`src/core/Harness.js` `bestiary()` — `11-bestiary` is not a rank and cannot grade scale spread,
   which is the one thing its doc claims it grades.** The doc says "the whole spawn roster in one rank,
   small to large". Measured ground-contact points span **y 405–622 — 217 px of depth** on a camera where
   subjects are 30–151 px tall, so apparent size is confounded with distance; and pixel area is
   non-monotonic in x (purple flyer 393 px at x601 sits between beetle 3,520 px at x452 and teal biped
   2,381 px at x675). One of the 16 manifest objects (~740 full-res px) could not be isolated in the frame
   at all. **Fix:** place the roster on a single arc equidistant from the lens, sorted by `card.height`,
   against a flat backdrop, and assert monotonically increasing projected height left-to-right before the
   PNG is written. The occluder problem here is genuinely fixed (worst column now 17.5%); the composition
   problem underneath it was never addressed.

**Below the cap but real:**

- **No enemy in any of the four shots casts a directional shadow.** Every one has a soft contact blob
  directly beneath it and nothing else. With a committed low sun in three of the four frames, that is the
  single cheapest missing lighting cue and it costs axis 1 and axis 2 in all four shots.
- **`04-combat`: 2 of 24 spawned enemies render 0 and 1 buffer-px** (manifest `perPx`, `visibleObjects: 22`).
  `minObjects: 8` passes over them. Raise the per-object floor or assert `visibleObjects >= 0.9 * objects`.
- **`12-boss-phases` is the strongest frame in the domain** and should be the template for `05-boss`:
  committed sunset key, real complementary grade (pale-blue boss against orange sky), boss at 38.7% of
  frame height, readable midground and background. `05-boss` shares none of it.

---

## Commands and artefacts

All measurements on the shipped PNGs in `C:\Users\tpzap\source\repos\OllieFace\shots\` (1600×900, RGB).
Luminance = `0.2126R + 0.7152G + 0.0722B`. Python 3 + Pillow 12.3.0 + numpy + scipy.ndimage.

Scratchpad scripts (in
`C:\Users\tpzap\AppData\Local\Temp\claude\C--Users-tpzap-source-repos-OllieFace\a0777b2c-a69c-47c1-967b-7714daef7023\scratchpad\`):

- `seg.py` — background model + residual map for `11-bestiary` (`bg.png`, `dist.png`, `D.npy`).
- `masks.py` — per-subject segmentation + the `sheet.png` crop|mask validation contact sheet.
- `iou.py` — normalisation, translation-searched IoU, calibration shapes (`~disc`, `~square`, `~tallbar`).
- `table.py` — full 15×15 matrix and shape descriptors.
- `sens.py` — threshold sensitivity at TH 18/30/45/60.
- `seg2.py` — boss/player extents in `05-boss` and `12-boss-phases` (`sheet_05.png`, `sheet_12.png`).
- `combat.py` / `combat_overlay.png` — `04-combat` masks, local contrast, mask-merge check.
- `boss.py` — clipping stats, column profiles, luminance keys.

Zoomed tiles inspected by eye: `best_0..3.png` (bestiary rank at 3×), `bp_0.png` (vizier at 3×),
`bs_0.png` (titan at 3×), `cb_0..3.png` (combat regions), `aff_0..1.png` (blazing/overloading at 6×),
`glac.png` (the white mass at 7×).

**Measurements I ran and am not reporting as evidence:** the `12-boss-phases` vizier/survivor height
ratio of 4.77× — that survivor stands far behind the boss and the ratio is a perspective artefact, not a
scale reading. Aspect-stretched IoU was also computed and is not quoted; stretching each mask to a square
canvas discards proportion, which is real silhouette information, and it inflates every pair
(`stalker` ↔ `withering shell` goes 0.73 → 0.87 under it). Only the uniform-scale figures are used above.
