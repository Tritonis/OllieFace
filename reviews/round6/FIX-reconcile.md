# FIX-reconcile — the two gate rules, made one rule

Owned files touched: `src/core/Harness.js`, `tools/capture.mjs`. Nothing else
was written.

Commit: `a61bf6d`. Build green (`node node_modules/vite/bin/vite.js build`),
tree clean, **0 failing shots**, down from 1.

## The new rule, in one sentence

**Absence is fatal inside the gated set, and the subject declares what the gated
set is:** a subject that says nothing about `crowd` gates every object it
declares, so every zero it carries fails the shot; a `crowd: N` subject gates its
best N against every floor including the 12 px absence floor, and absences beyond
those N are published four ways and not gated.

## Why the old pair could not both be right, and why this is not a loophole

`04-combat`'s `horde` declared `crowd: 8` over 24 spawned members with
`crowdWhy: 'director horde: an unbounded population, not a fixed cast'`, while
`absentObjects` failed the shot for **any** of the 24 under 12 px, ranked or not.
The second rule read, on a crowd, as "all 24 must be individually photographed" —
the exact contradiction of the contract the same subject signs two lines above it
in its own scenario.

The reconciliation is not a `crowd` exemption bolted onto the absence check. It is
that the absence check was asking the wrong question: it asked *is any declared
object absent*, when what the rest of the gate asks is *does every object the
subject put up for judgement clear its floors*. `rank`/`gated` already encodes
"put up for judgement". Pointing the absence floor at `gated` makes the two halves
of the check consult the same set.

**This cannot be turned into a hiding place, structurally, and not by convention.**
For a subject with no `crowd`, `need === n`, so `rank` is every index and `gated`
is the whole cast — a fixed-cast zero is *inside* the gated set, and there is no
branch for it to escape through. There is no `if (s.crowd)` anywhere in the
failure path; opening the gate requires writing `crowd: N` and a `crowdWhy` into
the scenario, in the diff, where a reviewer sees it.

For the gated set the change is **strictly stricter than what shipped**:
`ABSENT_PX` is now tested on ranked objects as well, which matters wherever
`minPerPx` falls below 12 (`minPixels / crowd < 12`) — previously such an object
could be ranked, clear `minPerPx`, and still be a zero. No shot passes under the
new rule that failed under the old one, except by the declared crowd contract.

**No threshold moved.** 12, `minPixels`, `minObjects`, `minSep`, `minCarriedPx`,
`minPerPx`, `need`, `MIN_SEPARATION`, `OPEN_GROUND_NEED` are all unchanged;
`git diff 3b7c96b -- src/core/Harness.js` filtered to those identifiers shows only
comment lines, the added `rep.perPx[i] < ABSENT_PX` term (a tightening), and the
`c.crowd.need` interpolation in `gatedOn`. The literal 12 was lifted to a local
`const ABSENT_PX = 12` purely so the one number is written once now that two
call sites read it.

## What a zero looks like now — stated in source, and on disk

Written out in the comment at the check (`src/core/Harness.js`, the block above
`const ABSENT_PX = 12`), and reproduced here because it is the whole deliverable:

- **A gated object at 0 px** — fixed cast always, or one of a crowd's best N — is
  an entry in `objectFailures` *and* in `absentObjects`, sets `perObjectOk: false`,
  and the shot is red.
- **A non-gated object at 0 px on a `crowd` subject** is an entry in
  `absentObjects`, an entry in `crowd.absentBeyondCrowd`, sets
  `crowd.carriesAbsence: true`, is named in `notGated`, raises a `console.warn`
  at capture time, and is hoisted by `tools/capture.mjs` to
  `manifest.toleratedAbsences` beside `subjectFailures` and echoed in the capture's
  stdout summary. Four places in the manifest, one of them the top of the file.

`subjectsOk: true` with a non-empty `toleratedAbsences` is a manifest asking to be
read, not a clean bill of health. That is the round's rule — publish, don't just
gate — applied to the one case the gate now declines to fail on.

## Property 1, demonstrated rather than asserted

A zero was **injected into a fixed cast** and the capture re-run. Two temporary
lines, marked `ZERO-INJECTION ARM A/B`, reverted before the build that ships
(`git checkout -- src/core/Harness.js`; `grep ZERO-INJECTION src/core/Harness.js`
is empty at HEAD):

- **Arm A**, `09-survivors` (4 named survivors, **no `crowd`**):
  `rigs[2].group.visible = false` before `mustContain`.
- **Arm B**, `08-explosion` → `monsters standing in it` (`crowd: 2` of 7):
  all victim rigs but the first hidden, to drive a zero *into the gated pair*.

On-disk evidence: **`reviews/round6/inject-zero/manifest.json`** (seed 1337,
`ready: true`, `clockPinned: true`, `--only 09-survivors,08-explosion`).

```
subjectsOk  false
failures    08-explosion: monsters standing in it
            09-survivors: the four survivors
```

`09-survivors` → `the four survivors`, from that file:

```
perPx           [1229, 1683, 0, 1350]
absentObjects   [{i:2, px:0, sepP50:0}]
objectFailures  [{i:2, px:0, sepP50:0}]
perObjectOk     false      ok  false
gatedOn         [..., "perPx/perSep/absence over every declared object"]
```

The fixed cast still fails on a single zero, and `gatedOn` says in words that the
absence floor was applied to every declared object. `crowd` is `undefined` on this
check; there is nothing for it to opt out of.

`08-explosion` → `monsters standing in it` — the crowd arm, from the same file:

```
perPx           [17, 0, 0, 0, 0, 0, 0]
crowd           {need: 2, of 7, absentBeyondCrowd: [i2,i3,i4,i5,i6 @ 0px],
                 carriesAbsence: true}
objectFailures  [{i:0, px:17, sepP50:0.85}, {i:1, px:0, sepP50:0}]
ok              false
gatedOn         [..., "perPx/perSep/absence over the 2 gated of 7"]
```

Object 1 is a **zero inside the gated pair** and it is in `objectFailures` — the
crowd contract buys nothing for an absence the crowd itself put up for judgement.
The five zeros outside the pair are published, named, and not gated, exactly as
designed — and note they are hoisted to `toleratedAbsences` *even though the check
is red*, because that list is about what the gate declined to read, not about the
verdict.

## Property 3, on a passing crowd — the shipping capture

**`reviews/round6/reconcile/manifest.json`** (full 21 shots, seed 1337,
`ready: true`, `clockPinned: true`, `partial: false`, `--port 5292`).

```
subjectsOk        true
subjectFailures   []
toleratedAbsences 04-combat: horde passed on 8/24 with 4 absent —
                  #0@2px #7@0px #9@3px #14@1px
```

That line is printed by `tools/capture.mjs` to stdout on every run and stored at
the top of the manifest. The check itself, in the same file:

```
04-combat | horde | ok: true
  absentObjects            [{0,2px},{7,0px},{9,3px},{14,1px}]
  crowd.absentBeyondCrowd  [{0,2px},{7,0px},{9,3px},{14,1px}]
  crowd.carriesAbsence     true
  notGated                 [contrast, sep, sepP25, legible, crowd.absentBeyondCrowd]
  gatedOn                  [..., "perPx/perSep/absence over the 8 gated of 24"]
```

`perPx` and `perSep` are unchanged and complete for all 24 objects. The four
absences the previous agent diagnosed — object 7 the off-frame charger, object 9
the brood standing behind the warden, objects 0 and 14 at 27-30 m — are all still
in the manifest, by index, with their pixel counts. Nothing was deleted; a rule
was pointed at the right set.

The three other crowd subjects (`06-loaded-hud` 3/10, `08-explosion` 2/7,
`10-inventory` 2/8) all publish `absentBeyondCrowd: []`, `carriesAbsence: false` —
the fields are emitted on every crowd, carrying or not, so a reader learns the rule
from a green check as well as a red one.

## Baseline and displacement — the change is gate-only, and it is measured

Baseline **`reviews/round6/final2/manifest.json`** (the shipping capture at
`3b7c96b`) against `reviews/round6/reconcile/manifest.json`, all 16 pixel checks
compared on `px`, `carriedPx`, `sepP50`, `perPx` and `ok`:

| check | `final2` | `reconcile` | |
|---|---|---|---|
| `04-combat` → `horde` | `ok false`, 8,550 px | `ok true`, 8,550 px | **perPx array byte-identical**, verdict flipped |
| `03-thirdperson` → `survivor` | 975 px / 0.51 | 977 px / 0.53 | known jitter, documented in `FIX-combat.md` |
| `04-combat` → `survivor` | 842 / 622 / 0.45 | 842 / 621 / 0.43 | 1 px |
| `06-loaded-hud` → `survivor` | 866 / 760 | 866 / 759 | 1 px |
| `08-explosion` → `damage numbers` | 286 / 188 | 286 / 189 | 1 px |
| other 11 checks | — | — | identical |

`04-combat`'s 24-element `perPx` came back
`[2,13,15,347,67,73,187,0,287,3,2109,210,314,324,1,2495,14,69,87,693,114,578,85,462]`
in both captures. **The same pixels, judged differently** — which is the proof
that this touched the gate and not the scene. No draw from the shared RNG stream
sits downstream of anything I changed: `mustContain` runs after `freeze()`, reads
the framebuffer, and returns. The scope warning about `screenSlots`/`declutter`
de-dup versus `avoid` therefore did not apply — I never went near either, and
`06-loaded-hud` and `11-bestiary` are bit-identical to baseline.

## Left alone deliberately

- **`declutter`, `screenSlots`, `avoid`/`avoidFit`, `_declutterPass`.** Untouched.
  The starvation the previous agent documented (pass 1's own placements rejecting
  34 of 36 cells in pass 2) is real and unfixed; it is now a *composition* debt on
  `04-combat` rather than a red shot. If it is ever worked, it still needs its own
  baseline and session.
- **Every refuted approach** — `worstFirst`, `nearFirst`, `supply`,
  `placeForOpenArena`, even-stride `screenSlots`, repainting `wisp`. Not re-tried.
- **`deathDissolve` / `VFX.js`.** Not touched, not read.
- **`04-combat`'s spawn count and its `crowd: 8`.** The owner's decision was to fix
  the gate, not cut the horde, so 24 still spawn and 8 is still the contract.
- **One thing I want to name rather than fix.** The brief described
  `08-explosion`'s victims as a fixed cast requiring per-object accounting; on disk
  they declare `crowd: 2` of 7 with `crowdWhy: 'blast victims: knockback removes
  members from frame by design'` (`Harness.js:3427`, and the same at `:3607` for
  `10-inventory`). Under the new rule they are judged as crowds. Both currently
  carry **zero** absences, so no verdict moved and nothing is being hidden today —
  but if the intent is that all seven blast victims be individually accounted for,
  that is a one-word scenario edit (drop `crowd`) and it is a spec decision, not
  mine.
- **`08-explosion` → `the blast`.** It publishes `perPx: [21164, 0, 6, 26304]` and
  is gated on `carriedPx` alone — the `minCarriedPx` aggregate opt-out for shared
  particle pools, which skips the per-object branch entirely and always has. That
  is a pre-existing published zero inside an aggregate, documented at
  `aggregateWhy`, and outside the scope of this reconciliation. Flagging it because
  it is the closest thing left in the file to the defect class this gate exists to
  catch.
