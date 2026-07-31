# Visual quality rubric

The critic scores each screenshot 1–10 on every axis. **Pass = 7+ on every axis
with no axis below 6.** Below that, the critic returns specific, actionable
defects — not adjectives.

Reference target: Risk of Rain 2 (Hopoo/Gearbox, current build), stages Titanic
Plains / Abandoned Aqueduct / Rallypoint Delta.

| # | Axis | What a 9 looks like | What a 4 looks like |
|---|---|---|---|
| 1 | **Lighting & shadow** | One committed key direction, long raking shadows, real ambient occlusion in crevices, bounce colour in shadow | Flat uniform ambient, shadows absent or uniformly grey, everything equally lit |
| 2 | **Composition & depth** | Foreground/midground/background separated by fog and value; a clear focal point; framing has intent | Everything at one depth, no fog gradient, subject centred in dead space |
| 3 | **Colour & grade** | A limited harmonious palette with one accent; complementary shadow/light hues; filmic rolloff, no clipping | Muddy desaturated greys, or oversaturated rainbow with no hierarchy |
| 4 | **Silhouette & form** | Shapes readable as pure black silhouettes; varied scale; characters distinguishable at a glance | Blobby primitives, everything the same size, player indistinguishable from enemies |
| 5 | **Material believability** | Surface variation, roughness contrast between rock/metal/organic, real specular response | Uniform matte plastic on every surface |
| 6 | **VFX quality** | Layered (flash + particles + distortion + light), soft-particle depth fade, motion arcs, not stickers | Flat billboard puffs, hard-clipped particle edges, single-layer effects |
| 7 | **UI/HUD craft** | Dense angular sci-fi identity, clear hierarchy, deliberate typography, never obscures action | Rounded default boxes, default sans stack, inconsistent spacing, no hierarchy |
| 8 | **Readability under load** | Player, enemies, threats, and pickups all legible mid-fight; VFX never bury the action | Screen is undifferentiated noise; can't find the player |
| 9 | **Post-processing** | Bloom on emissives only, subtle grain/vignette/aberration serving mood, clean AA | Blown-out bloom on everything, jaggies, banding, or over-processed mush |
| 10 | **Cohesion** | Every element reads as one authored world | Assets from visibly different styles/eras jammed together |

## Verdict format the critic must return

```
AXIS SCORES: 1:_ 2:_ 3:_ 4:_ 5:_ 6:_ 7:_ 8:_ 9:_ 10:_
VERDICT: PASS | FAIL
TOP DEFECTS (ranked, only if FAIL):
  1. <file:line or subsystem> — <the specific visual defect> — <the concrete change that fixes it>
```

## Rules for the critic

- **Be harsh.** The default answer is FAIL. Do not award points for effort or for
  code that looks correct — score only what is visible in the image.
- **No vague notes.** "Needs more polish" is a rejected review. Every defect must
  name what is wrong in the pixels and what specific change fixes it.
- **Check `manifest.json` first.** If `ready` is false or a shot has errors, the
  visual score is irrelevant — report the crash as defect #1.
- **A black, empty, or single-colour frame is an automatic FAIL** regardless of
  what the code claims to do.
- Judge against the real game's *look*, not its asset budget. Missing hand-authored
  detail is expected; flat lighting, muddy colour, and weak composition are not.

## Stopping condition

Max **4** critic rounds per subsystem. After round 4, stop and report honestly
which axes still fall short and why, rather than looping forever.
