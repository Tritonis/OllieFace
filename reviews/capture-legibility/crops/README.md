# Failing-object crops

Annotated crops of the four currently-red `npm run shots` subjects on master `a562d26`,
showing exactly which object in each frame fails to separate from its background.
Source manifest: `reviews/capture-legibility/detail-run.json`, from one full capture run
with a `detail: () => lastPerObject()` opt-in added to each of these subjects
(`src/core/Harness.js`), publishing each object's `at`/`box` alongside its existing
`sepP50`. This is diagnostic only — no staging, threshold, or measured value changed;
see `UNCHANGED` in the task report for the comparison against
`reviews/capture-legibility/baseline-master-a562d26.json`.

Ring colour is cyan (`#00FFFF`), chosen because it does not occur in any of the four
shots. Each crop is padded to roughly 3.5x the object's own box, clamped to the frame,
and upscaled 2x with a caption strip burned in at the bottom.

| Crop | Shot / subject | Object | sepP50 | Bar it missed |
|---|---|---|---|---|
| `08-explosion-object-3.png` | 08-explosion / "monsters standing in it" | i=3 (`skink`, 374 px) | 0.15 | 0.25 floor / 0.27 margin |
| `10-inventory-object-6.png` | 10-inventory / "monsters standing in it" | i=6 (`harrier`, 2058 px) | 0.19 | 0.25 floor / 0.27 margin |
| `04-combat-object-15.png` | 04-combat / "horde" | i=15 (`mortar`, 1200 px) | 0.25 | 0.27 margin only (floor 0.25 met) |
| `11-bestiary-object-13.png` | 11-bestiary / "the whole spawn roster" | i=13 (`warden`, 2233 px) | 0.25 | 0.27 margin only (floor 0.25 met) |
| `11-bestiary-object-17.png` | 11-bestiary / "the whole spawn roster" | i=17 (`hulk`, 2549 px) | 0.25 | 0.27 margin only (floor 0.25 met) |

What each crop shows, in words:

- **08-explosion i3**: the orange `skink` sits almost fully inside the blast's own bright
  white/grey particle wash — same tonal range as what is behind it, which is exactly what
  a low separation number means.
- **10-inventory i6**: the `harrier` is dimmed and back-lit directly behind the equipment
  blast's light core, partly hidden by the floating damage-number readouts in front of it.
- **04-combat i15**: the green/orange `mortar` stands against a similarly green-and-orange
  rock formation at matching brightness.
- **11-bestiary i13 / i17**: the `warden` (purple) and `hulk` (red) both sit against
  mid-tone busy neighbours and terrain in a crowded roster line, close enough in luminance
  to their surroundings to miss the stricter margin bar even though they clear the base
  floor.
