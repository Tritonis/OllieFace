# Round 5 — Critic R1: Enemies, Bosses, Combat Readability

Domain: rubric axis 4 (silhouette & form), axis 6 (VFX quality), axis 8 (readability under load).
Shots judged: `11-bestiary`, `12-boss-phases`, `05-boss`, `04-combat`.

## Manifest check

`shots/manifest.json` is clean: `ready: true`, `partial: false`, top-level `errors: []`, and all 19 shots
report `frameErrors: 0`, `lastFrameError: null`, `newErrors: []`. **No engine defect.** The failures below
are visual, not crashes — which makes them worse, because the harness reported success on four shots that
do not contain their subject.

---

## AXIS SCORES

```
AXIS SCORES 11-bestiary:    1:5 2:3 3:5 4:3 5:4 6:4 7:7 8:4 9:6 10:6   mean 4.7
AXIS SCORES 12-boss-phases: 1:4 2:2 3:6 4:4 5:4 6:2 7:6 8:3 9:6 10:6   mean 4.3
AXIS SCORES 05-boss:        1:4 2:2 3:5 4:1 5:4 6:2 7:6 8:2 9:5 10:6   mean 3.7
AXIS SCORES 04-combat:      1:4 2:3 3:4 4:3 5:3 6:4 7:7 8:1 9:5 10:6   mean 4.0

VERDICT: FAIL
```

Pass bar is 7+ on every axis, nothing below 6. Every shot in this domain misses on at least six axes.
Two of the four shots do not contain the subject they exist to photograph.

---

## Answers to the five questions

**1. Are the 16 enemies distinguishable as pure black silhouettes? No.**

I keyed the enemy band (`11-bestiary`, y 330–630) to hard black/white against the ground plane reference
`RGB(69,53,102)`. The result is in the evidence section. Collapse pairs:

| Pair | Why it collapses |
|---|---|
| `beetle` ↔ `mite` (`enemies.js:75`, `:45`) | Identical dome-with-legs shape. Differs *only* by scale (r 0.55 vs 0.34). At silhouette this is one enemy at two distances — the worst possible ambiguity, because scale is how the player reads distance. |
| `golem` ↔ `hulk` (`enemies.js:460`, `:525`) | Both are a chunky rectangular torso mass on two stubby legs. On screen (green vs red, x 1000–1290) they are two adjacent rounded humps of near-identical outline. Colour is doing 100% of the work. |
| `charger` ↔ `burrower` ↔ `harrier` (`enemies.js:260`, `:299`, `:227`) | Three tan quadrupeds of similar mass. In the keyed pass the two at bottom-centre-right are indistinguishable low lumps, and both read as terrain rocks rather than as threats. |
| `warden`+`warded` ↔ *any sphere* | See defect 6 — the ward geometry erases the host silhouette entirely. |

What *does* survive thresholding: `acolyte`/`stalker` (the spiky-limbed pale biped — genuine limb read),
`brood` (mushroom cap + stalk, the single best silhouette in the roster), and the ward sphere (distinct,
but for the wrong reason). That is roughly 3 of 16 that pass a silhouette test.

Also: only ~11–13 of the 16 are visible at all — see defect 3.

**2. `04-combat` — can you tell threats apart mid-fight? There is nothing to tell apart.**

The frame contains **zero enemies**. Not "hard to read" — absent. I gamma-boosted the frame (γ 0.32) to rule
out enemies hidden in shadow; the lift reveals ground, rock pillars, grass tufts, distant cliffs, the player
mech, a muzzle tracer and spark particles. No enemy bodies anywhere. A single cyan off-screen indicator arrow
at (775, 530) confirms enemies *exist* but are outside the frustum. Axis 8 cannot be scored above 1: the
readability stress test shipped with no load. The manifest doc for this shot ("Mid-fight with a horde") and
the claim of a 24-enemy fight are both refuted by the pixels.

**3. Do the bosses read at 3x enemy scale with a different silhouette family? No, on both counts.**

Measured `IRON VIZIER` in `12-boss-phases` by keying its pale-blue body: bounding box **283 × 297 px**, i.e.
33% of the 900px frame height. That is respectable framing, but the *relative* scale is not there. From
`enemies.js`: boss heights are 5.0–7.6 (`thunderhead` 5.0 … `titan` 7.6) against the largest common enemy
`hulk` at 4.2 and `golem` at 3.6. **`vizier` (6.4) is 1.52× a hulk and 1.78× a golem — not 3×.** And the
silhouette family is the same: `vizier` is a blocky biped with a torso slab, side arms and two legs, exactly
the `golem`/`hulk` template scaled up and recoloured. It reads as a big enemy, not as a boss.

**4. Is the boss telegraph legible as a wind-up? No.**

The shot is documented as "frozen at 85% of a wind-up". At 85% there is **no telegraph VFX in the frame at
all**: no ground-projected decal, no charge ring, no expanding AoE footprint, no radial sweep, no emissive
ramp, no colour shift, no particle convergence. The only candidate signal is a static white disc on the
boss's chest, which is present as a body feature rather than as a state change — a player cannot tell it
from the idle pose, and has no information about *where* the attack lands. There is nothing to dodge away
from. This is the single largest axis-6 loss in the domain.

**5. Do the 5 elite affixes have distinct signatures? Cannot be fully judged — and the two shown do not.**

Only **2 of 5** affixes appear in any shot in my domain (`Harness.js:1578-1580` spawns `golem`→`withering`
and `warden`→`warded`; the manifest doc confirms "two tier-2 elites"). `blazing`, `overloading` and `glacial`
— the entire tier 1 — are absent from the shipped pixels and are therefore ungradeable. That is itself a
coverage defect: a content wave added 5 affixes and the capture set photographs 2.

Of the two visible: `withering` reads as "the enemy, tinted green and glowing". `warded` reads as "the enemy,
inside a bubble". Neither adds silhouette information; one actively destroys it. Both fit the "glowing enemy"
failure mode the brief asked about.

---

## TOP DEFECTS (ranked)

1. **`src/core/Harness.js:719-740` (`combat()`) — `04-combat.png` contains zero enemies; the 24-enemy
   readability stress test shipped empty.** Line 723 spawns 24 via `spawnRing(enemies, SPAWN_CARDS, 13, 6)`,
   then line 727 runs `declutter(12)` — a minimum-separation pass with spacing 12 against a spawn radius of
   13, which pushes the ring outward past the frustum edge. The camera (line 726) is never reconciled with
   the post-declutter positions. **Fix:** after `declutter`, project every enemy to NDC and relocate any
   outside x,y ∈ [-0.9, 0.9] to a free interior cell; then hard-assert ≥ 8 enemies project inside the frame
   before the capture is written, and fail the shot loudly if not. An empty combat frame must not report
   `frameErrors: 0`.

2. **`src/core/Harness.js:761-915` (`boss()`) — `05-boss.png` renders a full "STONE TITAN" boss health bar
   over a frame with no boss in it.** Confirmed by gamma boost: the frame holds tree trunks, ground, rocks,
   the player mech at (1170, 390) and one small tan quadruped at (330, 745). No titan. `clearCam()`
   (`:798-860`) found a camera it considered valid and line 899 committed it, but "unoccluded" was satisfied
   without the subject being framed. **Fix:** make `clearCam` acceptance require *framing*, not just line of
   sight — subject centroid inside NDC [-0.6, 0.6] **and** projected subject height ≥ 25% of frame height —
   and re-search or widen FOV when unsatisfied.

3. **`src/core/Harness.js:1514-1611` (`bestiary()`) — a near-black tree trunk bisects the enemy rank; the
   silhouette-grading shot cannot grade silhouettes.** Measured column darkness (lum < 45) across the rank
   band y 150–650: x 450–500 = 22.5%, 500–550 = 34.6%, 550–600 = 43.0%, 600–650 = 60.9%, **650–700 = 67.8%**,
   700–750 = 38.6%, 750–800 = 28.6%. A ~350px-wide opaque column sits across the middle of the roster, fully
   hiding at least one enemy (a mint/teal body is visible clipped at x ≈ 603–620) and clipping others. Unlike
   `boss()` and `bossPhases()`, `bestiary()` never calls `clearCam()` — there is no occlusion pass at all.
   **Fix:** run `clearCam()` here, and additionally cull or alpha-fade any prop whose bounds intersect the
   camera→subject frustum volume for the capture frame.

4. **`src/core/Harness.js:1645-1657` (`bossPhases()`) + `:170-175` (`seesTarget()`) — 31% of the boss frame
   is an opaque black occluder despite the occlusion check passing.** Column profile (lum < 45, y 0–760):
   x 200–300 = 93.9%, **x 300–400 = 100.0%**, x 400–500 = 97.9%, x 500–600 = 89.3%, x 600–700 = 72.5%.
   53.3% of the whole frame is below luminance 45. `seesTarget()` raycasts to the subject's centre point (and
   a couple of probe heights at `:239`, `:244`), so a trunk sitting *beside* the boss passes the test while
   eating a third of the composition. **Fix:** raycast to the 8 corners of the subject's bounding box and
   require ≥ 7 clear, and reject camera candidates where > 15% of the frame's non-sky area is a prop nearer
   than the subject.

5. **`src/data/enemies.js:740-783` (`vizier` attacks) / boss wind-up VFX — a wind-up frozen at 85% has no
   telegraph.** No ground decal, no charge ring, no AoE footprint, no emissive ramp, no particle convergence.
   Nothing in the frame communicates "an attack is coming" or "it lands here". **Fix:** during any boss
   attack with a windup, project a ground decal matching the attack's actual AoE footprint (expanding ring
   for radial, cone for directional) that fills from 0→1 over the windup, and drive the boss's emissive
   colour up the same curve. The decal is the dodge information; the emissive is the timing information.

6. **`src/data/enemies.js:564-827` (boss heights) vs `:525-558` (`hulk`) — bosses are ~1.5× the largest
   enemy and share its silhouette family.** Boss heights 5.0–7.6 against `hulk` 4.2 / `golem` 3.6. `vizier`
   at 6.4 is 1.52× a hulk. All read as blocky bipeds. **Fix:** raise boss height to ≥ 3× the largest common
   enemy (i.e. ≥ 12 against `hulk` 4.2), and give each boss a silhouette anchor no common enemy uses —
   serpentine/limbless for `wyrm`, floating-with-no-ground-contact for `thunderhead`, multi-limbed or
   asymmetric for `matron` — so the boss is identifiable before its colour resolves.

**Also, below the cap but real:**

- **`src/entities/EnemyMeshes.js:615-626` (`warded` barrier, `IcosahedronGeometry(1, 1)`)** — the ward shell
  is an opaque-enough additive sphere that the host enemy's silhouette becomes a **perfect circle**, visible
  in the keyed pass at x ≈ 775–930. An elite affix must never subtract identity information. Fix: replace the
  full shell with an equatorial band, shoulder plates, or a wireframe-only cage at low alpha, so the host's
  outline still reads through it.
- **Affix coverage** — `blazing`, `overloading`, `glacial` (`enemies.js:864`) appear in no shot in this
  domain. Add an affix-row shot, or spawn one of each tier-1 affix in `bestiary()`.
- **Enemy palette has no threat hierarchy** — green, red, orange, tan, pink, mint, yellow and purple all
  appear at similar saturation in `11-bestiary`. Colour is currently the only channel separating collapsed
  silhouettes (defect 1), and it is spent on variety rather than on danger. Costs axis 3 and axis 8.

---

## Evidence and commands

All measurements on the shipped PNGs in `C:\Users\tpzap\source\repos\OllieFace\shots\` (1600×900, RGB).
Luminance = `0.2126R + 0.7152G + 0.0722B`.

- **Shadow-content check** (proves `04-combat` / `05-boss` emptiness is not underexposure):
  gamma LUT `(i/255)**0.32` applied via `PIL.Image.point`. Outputs
  `<scratchpad>/04-combat_boost.png`, `<scratchpad>/05-boss_boost.png`.
- **Occluder column profiles**: dark-pixel fraction (lum < 45) sampled every 4px, per 100px column band
  (`12-boss-phases`, y 0–760) and per 50px band (`11-bestiary`, y 150–650). Numbers quoted in defects 3 and 4.
- **Boss scale**: `IRON VIZIER` keyed by `b > 120 and b > r+12 and lum > 95` over x 690–980, y 300–660 →
  bbox x 690–973, y 307–604 = 283 × 297 px = 33.0% of frame height.
- **Silhouette pass**: `11-bestiary` band (x 120–1560, y 330–630) hard-keyed to black where
  `|Δ| > 85` (Manhattan) from ground reference `RGB(69,53,102)`. Output `<scratchpad>/sil.png`.
- **Zoomed roster tiles**: 4 crops of the rank at 3× nearest-neighbour, `<scratchpad>/best_0..3.png`.

**Method note — a measurement I ran and discarded.** I first attempted an automated pairwise
silhouette-IoU across 11 hand-placed enemy bounding boxes, masking each by colour distance from its own
border-ring median. Validation by dumping the ASCII masks showed the method was broken: the boxes sit close
enough that the border ring sampled *neighbouring enemies*, so the inferred background for `golem_red` came
back as `RGB(108,162,118)` (the green golem's body colour) and for `biped_spiky` as `RGB(228,150,77)` (the
orange quadruped). Mask fill hit 0.98 — everything flagged as foreground — making the resulting IoU figures
(0.77–0.96) meaningless. **Those numbers are not reported and should not be quoted.** The silhouette-collapse
conclusions in this review rest on the keyed pass and the zoomed tiles, read visually.
