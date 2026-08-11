# FIX: 06-loaded-hud, red in every full run since 2026-08-03

Investigation and fix. Worktree `.claude/worktrees/agent-ae0a7e8f826a693e4`, branched
from `1911d79`. Node v24.15.0, playwright 1.62.1, all captures headed d3d11, seed 1337,
`clockPinned: true`. Every number below names the manifest it came from; paths are
relative to the repo root unless marked `[main repo]`.

---

## Verdict

A side effect, not an intended content change, and the gate is measuring exactly what
it says it measures. **Culprit: `cf7e63e` "Sixteen items, a fifth survivor, and three
enemies that change the fight" (2026-08-02 13:12:31).** Fixed in `src/core/Harness.js`;
`06-loaded-hud` goes 815 px red -> 2093 px green with no other shot moved off its
verdict.

The horde is not mis-framed, mis-lit, or mis-sited. **It is dead.**

---

## 1. Bisect

Full runs (never `--only`), each into its own directory, all at seed 1337.

| tree | manifest | `monsters under load` |
|---|---|---|
| `ddb1246` (parent of the culprit) | `reviews/round7/captures/fix-loaded-hud/ddb1246/manifest.json` | **2624 px, 10/10 visible, ok** |
| `cf7e63e` | `reviews/round7/captures/fix-loaded-hud/cf7e63e/manifest.json` | **766 px, 9/10, `objectFailures [{"i":6,"px":147,"sepP50":0.23}]`** |
| `1911d79` (HEAD) | `reviews/round7/captures/fix-loaded-hud/head/manifest.json` | 815 px, 8/10, `[{"i":6,"px":179,"sepP50":0.11}]` |

The HEAD row reproduces `[main repo] reviews/round7/captures/diag-full/manifest.json`
to the digit (`perPx [7,3,24,206,51,35,179,109,86,115]`), so this worktree and the
DIAG report are measuring the same thing. One commit, 2624 -> 766, and it has stayed
in the 760-815 band in every full run since.

`cf7e63e` is also where the collapse *had* to be by dates: `reviews/round6/publish-eq`
(the last green full run, 2860 px) was committed at `e3f160d` 08:21 that morning, and
`6157ccb`'s own commit message at 13:49 already records `06-loaded-hud` as failing.
The window is four commits wide and the bisect closes it on one.

## 2. Mechanism

`lateRun` gives the survivor every item in the game at up to 12 stacks, spawns ten
monsters, settles 60 frames, then calls `declutter(12, { maxDist: 28 })` to pull the
horde into a photographable band. Instrumented at HEAD
(`reviews/round7/captures/fix-loaded-hud/diag7-head/manifest.json`, `DIAG kill`):

```
frame 10..50   all ten at FULL health   (mite 626/626 ... burrower 14280/14280)
frame 60       all ten dead
kill records   type "lightning", card text 46.2 damage, delivered as ret 86648.9
               burrower hp0 14280 -> hp1 0
```

One chain-lightning proc, 46.2 damage of card text arriving as **86,648.9** after the
outgoing multipliers of a 97-item inventory, deletes the entire horde in a single frame
about 0.9 s after it spawns — before the shutter, and before the composition pass.

What that costs the photograph is not that the monsters are dead; corpses still draw.
It is that `declutter` filters its candidate list on `e.alive`
(`src/core/Harness.js:831`), so with the whole cast dead it finds nothing to move, runs
**zero passes**, and the caller's `maxDist: 28` silently stops applying:

| tree | manifest (`DIAG declutter`) | before | after | moved | result |
|---|---|---|---|---|---|
| `ddb1246` | `fix-loaded-hud/diag4-ddb1246/manifest.json` | 21.6-46.5 m | **14.1-26.4 m** | 8 | 2624 px, green |
| `1911d79` | `fix-loaded-hud/diag4-head/manifest.json` | 29.9-41.9 m | 29.9-41.9 m | **0** | 815 px, red |

So the red gate is honest twice over: ten corpses photographed at the far edge of a
band the composition pass was never given the chance to close. The failing slot #6 at
`sepP50` 0.11 is a harrier at 30.9 m read against a lit arch — a real legibility
failure of a frame nobody composed.

The three enemy cards `cf7e63e` added are a red herring here: `shriver` does displace
`brood` out of `spawnRing`'s ten-card prefix (`cards[i % cards.length]`,
`src/core/Harness.js:717`), which is worth its own look, but it accounts for a few
hundred pixels, not for every body in the frame doubling its distance.

## 3. Fix

`src/core/Harness.js`, `lateRun` — pin the horde's health across its own settle, the
same pin `invulnerable()` puts on the survivor and the same one `10-inventory` already
puts on its pack ("the pack is pinned at full health across the settle"), then hand the
horde the death its frame had earned it *after* the shutter.

Health rather than `invuln`: `invuln` belongs to the burrower's SUBMERGED state, which
clears it on exit (`src/entities/Enemy.js:1638,1666`), and pinning health is blind to
which damage path arrives.

The post-shutter ending is load-bearing, because this scenario is sixteenth of twenty.
Three endings were captured full:

| ending | manifest | cost |
|---|---|---|
| release the pin, walk away | `fix-loaded-hud/after-alive/manifest.json` | `10-inventory` -> `monsters standing in it` 1078 -> **623 px, red** (object 4, `sepP50` 0.09) |
| retire into the director's pools | `fix-loaded-hud/after-despawn/manifest.json` | the same 623 px red |
| **kill them through `applyDamage`** | `fix-loaded-hud/after/manifest.json` | `10-inventory` 565 px, green |

### The second pin, and why it is not scope creep

Every variant above also left `20-blight-edge` -> `a live fight` red (0, 0 and 1 of the
8 it spawns, against a floor of 4). That shot's own comment says it drops the 37-item
haul precisely because "the passive item damage ... wiped the ring down to one survivor
before the shutter -- `a live fight` failed at 1 of 8". Measured
(`fix-loaded-hud/diag-blight-fixed/manifest.json`, `DIAG blight`): **the survivor
arrives holding 97 items and all eight of the ring are dead at the shutter.** `begin()`
does not empty the inventory, so that defence is a comment rather than a mechanism, and
the shot has been passing on the timing of a proc. The upstream change re-rolled that
timing; it did not create the fragility.

So `blightEdge` gets the same pin across its `closeFrames`, released at the shutter.
Nothing runs after it, so the release hands nothing on. `a live fight` now reads 9,
deterministically, instead of 10-by-luck.

No threshold was moved anywhere. `minPixels` is still 300 across ten objects, `minSep`
is still 0.25, `a live fight` is still `>= 4`.

## 4. Before / after (full runs, same box, same day, seed 1337)

| | before: `fix-loaded-hud/head/manifest.json` | after: `fix-loaded-hud/after/manifest.json` |
|---|---|---|
| `06-loaded-hud` / `monsters under load` | **815 px, 8/10 visible, `objectFailures [{"i":6,"px":179,"sepP50":0.11}]`, 2 absent** | **2093 px, 10/10 visible, `objectFailures []`, absent []** |
| `perPx` | `[7,3,24,206,51,35,179,109,86,115]` | `[29,222,106,153,401,258,59,379,230,256]` |
| `perSep` | `[0.87,0.09,0.29,0.45,0.73,0.85,0.11,0.93,0.87,0.95]` | `[0.95,0.91,0.95,0.79,0.55,0.67,0.29,0.93,0.87,0.95]` |
| `10-inventory` / `monsters standing in it` | 1078 px ok | 565 px ok |
| `20-blight-edge` / `a live fight` | 10 ok (luck) | 9 ok (pinned) |
| `subjectFailures` | `06-loaded-hud`, `19-overkill` | `19-overkill` only |

Confirmed on a second full run at the fixed tree:
`reviews/round7/captures/fix-loaded-hud/after-repeat/manifest.json`.

`19-overkill` is untouched and still red. It is a different defect (the hulk is
launched into the lake the full run's accumulated stage leaves under
`groundAtScreen`), it is documented as such in `[main repo]
reviews/round7/DIAG-red-gates.md`, and another agent owns the siting work. Nothing
here touches `faceOpenGround`, `groundAtScreen` or where anything is placed.

## 5. Left alone, deliberately, and worth someone's attention

1. **A 46.2-damage proc arriving as 86,648.9.** That is a ~1875x outgoing multiplier
   from 97 items, measured, and it is a balance question rather than a camera one. It
   is why three separate capture scenarios now need a pin to photograph a live monster
   at all. Evidence: `fix-loaded-hud/diag7-head/manifest.json`, `DIAG kill`.
2. **`begin()` does not clear the inventory.** `20-blight-edge`'s "drops the haul"
   comment is false, and any future scenario that assumes a clean survivor after
   `begin()` will be wrong in the same way.
3. **`spawnRing` deals the roster's first N cards.** `cards[i % cards.length]` means
   any insertion into `ENEMIES` before index 10 silently re-casts four scenarios'
   hordes — which is how `shriver` evicted `brood` here without anyone choosing it.
4. **The memory note `capture-gates-red-since-2026-08-11` is still wrong** about
   `06-loaded-hud` in the way the DIAG report says: the shot has been red in full runs
   since 2026-08-03, and the cause was neither environmental nor the render-scale
   slice. It was `cf7e63e`.
