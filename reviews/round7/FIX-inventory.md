# 10-inventory: "monsters standing in it"

**Verdict: stale gate, not a game bug.** The death dissolve is correct. The
scenario's "pin" never pinned anything, and the dissolve fix is what made that
visible. Fixed harness-side; no game code changed.

Branch: `worktree-agent-a4674aec69529fbe2`, rebased onto master `82508a7`.

---

## 1. What the subject was actually measuring

`10-inventory` fires the survivor's equipment over a pack of eight monsters and
grades `monsters standing in it` — two of the eight individually visible at
>= 200 px and `sepP50 >= 0.25`.

The pack was held with a per-frame refill:

```js
const hold = () => { for (const e of victims) { if (!e.alive) continue; e.health = e.maxHealth; ... } };
```

That is not a pin. `hold` runs at the *top* of the frame and skips anything
already dead; a survivor holding one of every item in the game deals more than a
monster's whole health bar *inside* one frame. So the pack died under the refill
and every later `hold` passed over the corpses. Measured at the shutter, all
eight dead, in
`reviews/round7/captures/fix-inventory/diag-master-nopin/manifest.json`
(`DIAG victims`): `deathT: 0.783` for all eight — forty-seven frames, three
quarters of a second *before* the nova they are documented as standing in.

This defect is old. It photographed as a pass only because the death dissolve
was running on the crumble debris instead of on the body: a corpse held full
opacity for its whole 1.5 s life, so a monster that died early was
pixel-for-pixel a monster that never died. The subject was measuring "eight
rigs are on screen", not "eight monsters are alive in the blast", and those had
been different things for a long time.

## 2. Culprit commit, by bisect

Five commits between the last green (`1911d79`) and the first red (`39bf2bc`).
Full captures at each base (`node tools/capture.mjs`, seed 1337, port 5319):

| base | commit | `monsters standing in it` | on disk |
|---|---|---|---|
| `825c4ce` | blight glyph work, last pre-dissolve | **1077 px pass**, perPx `[33,141,12,101,130,205,68,387]` | `captures/fix-inventory/bisect-825c4ce/manifest.json` |
| `dfc6d11` | rig epoch tokens | **1076 px pass**, perPx `[33,141,12,101,130,205,67,387]` | `captures/fix-inventory/bisect-dfc6d11/manifest.json` |
| `4734ffd` | *the dissolve stops burning the debris and starts burning the body* | **90 px FAIL**, perPx `[6,25,0,0,0,19,6,34]` | `captures/fix-inventory/bisect-4734ffd/manifest.json` |
| `ba17c90` | then-master | **90 px FAIL**, identical perPx | `captures/fix-inventory/head-full/manifest.json` |

`4734ffd` is the culprit, and the epoch commit `dfc6d11` is exonerated: it is
green on the shot, and the rig epochs at the shutter match on the red runs too
(`epoch` field in `diag-master-nopin`, no mismatch, `parented: true`,
`visible: true`). Nothing was dropped by an epoch check and nothing was
recycled. The corpses were simply burned away.

## 3. Reconciling the two reviewer observations

Both are real and they are the same mechanism seen at two draw counts. Since
`4734ffd`, the subject's pixel count is a function of *how long ago the pack
died*, and that is a function of upstream RNG draw count — whichever merge last
touched the item roster or the bookkeeping kill. One mechanism, no game-code
change between the last two rows:

| base | death age at shutter | burn `k` | subject |
|---|---|---|---|
| `825c4ce` | 0.583 s | (dissolve on debris) | 1077 px pass |
| `ba17c90` | 0.583 s | 0.686 | 90 px fail |
| `82508a7` (current master) | 0.783 s | 0.922 | **0 px** fail |

Evidence: `captures/fix-inventory/diag-victims/manifest.json` (ba17c90) and
`captures/fix-inventory/diag-master-nopin/manifest.json` (82508a7). The
spire branch's three captures (90 px) and the wave re-review's 0/8 are these two
rows. Chasing the commit that last moved the number is chasing the wrong thing:
any draw-count change slides it again, in either direction.

## 4. The fix

Harness-side, inside `10-inventory` only. `lateRun` is untouched, so this does
not collide with `fix/loaded-hud-horde`. No threshold moved. No RNG is drawn.

1. **Raise the ceiling instead of refilling under it** —
   `for (const e of victims) e.maxHealth = 1e6;`, the same instrument
   `invulnerable()` (Harness.js:1341) applies to the player. Nothing the
   inventory does can take the pack off the board before the trigger, so the
   earliest any of them can die is the nova and the burn at the shutter is
   bounded by the shutter rather than by the draw count: measured `k` 0.137 for
   five and 0.294 for three, against 0.686 and 0.922 above.
   `1e6` and not `Infinity` deliberately — the nova is still allowed to finish
   them, which is the picture the shot is documented as taking. Pinned at `1e12`
   they survive it and the frame measures *worse*: live monsters are knocked out
   of the composition by the blast they are meant to be standing in — five of
   eight visible, 2,256 px (`captures/fix-inventory/master-after2`).
2. **The refill runs once more on the frame the equipment fires.** With the
   ceiling raised but the refill still stopping at `declutter`, three of the
   eight went down before the shutter opened
   (`captures/fix-inventory/diag-master`).
3. **The seating ring widened, 0.16 x 0.07 -> 0.26 x 0.11 of frame.** The old
   ring was drawn when the blast measured 17,954 px of particles and one pixel
   of everything else; it now carries a 52,129 px beam pool as well
   (`master-before` -> `the equipment blast` perPx), and the old ring seated the
   pack inside the core of it. With (1) and (2) alone the bodies were *there* —
   577 px on the second-largest — and unreadable against it at `sepP50` 0.15
   under a 0.25 floor, i.e. failing as a separation defect rather than as an
   absence (`captures/fix-inventory/master-after`). Still inside the nova; its
   own radius grew with the effect.
4. **`DIAG victims (age at shutter)`**, an `info` check, so every future
   manifest publishes each body's `alive`/`deathT`/`k`. A pixel count cannot
   tell "eight monsters alive in a blast" from "eight corpses most of the way
   through a 0.85 s burn", and this shot has now been wrong about that twice.

## 5. Before / after

All full runs, seed 1337, `--port 5319`, this branch, current master base.

| | manifest | `monsters standing in it` |
|---|---|---|
| before | `reviews/round7/captures/fix-inventory/master-before/manifest.json` | **FAIL** 0 px, perPx `[0,0,0,0,0,0,0,0]` |
| after (1) | `reviews/round7/captures/fix-inventory/after-A/manifest.json` | **PASS** 4257 px, perPx `[147,615,257,1003,95,809,157,1172]`, `sepP50` 0.33, 8/8 visible |
| after (2) | `reviews/round7/captures/fix-inventory/after-B/manifest.json` | **PASS**, byte-identical to A |

`master-before` reproduces the coordinator's `captures/integration-full`
snapshot (0 px; blast 62,468 vs 62,466) so the two runs are the same failure.
Both after-runs report `subjectsOk: true` for the whole capture — `06-loaded-hud`
and `19-overkill` are green on this base, fixed upstream.

`node tests/run.mjs`: 47/47 files, 41 assertions in the last file, 0 failed.

### One caveat, recorded rather than fixed

`audio.musicPeak` swings three orders of magnitude between otherwise identical
runs on this base — 0.0085 (`master-before`), 0.1247 (`master-after`), 0.0054
(`master-after2`), 0.0007 (`master-after3`, the one run that tripped
`musicAudible`). Both final after-runs pass it. It is unrelated to this change
and is a live flake in the audio probe, not a verdict this fix should be read as
having moved.
