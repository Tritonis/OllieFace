# Round 6 baseline capture — the ONE artifact every number cites

> ## CORRECTION, added after the stages agent's step-0 finding
>
> **This baseline is the detail-pass-OFF arm.** `fba0a91` (and `f9b47c4` before it)
> carried `#define DET_KILL 0.0` at `Materials.js:358`, applied at :486 as
> `gradW *= DET_KILL; hOut *= DET_KILL;` — zeroing the terrain detail pass outright.
> Verified with `git show fba0a91:src/world/Materials.js`.
>
> It was introduced in **`f9b47c4`**, the "in progress" commit from the four agents
> killed mid-edit, and does not exist in `2a782a0` or earlier. A debug kill-switch was
> latched at zero and committed. `reviews/round6/crops/arch-base.png` shows the
> consequence: the hero arch renders as bare rock with **no mortar courses at all**.
>
> **What this invalidates:** any *material or detail* measurement taken against
> `reviews/round6/base/` is measured against a build with no detail pass. Treat
> `base/` as the detail-OFF reference, not as "the shipped look". The stages agent
> captured a detail-ON arm at `reviews/round6/detON/` for that purpose.
>
> **What it does NOT invalidate:** the four failing-shot verdicts below. Those are
> pass/fail on object pixel counts and separation, and they reproduce independently.
>
> It also means axis 5 was **not** flat for six rounds because of this — the kill
> switch is one commit old. But it does mean a round-4 stages critic run against
> `f9b47c4` would have scored a build with its hewn-stone identity deleted.


Captured 2026-08-01 from a clean tree at `fba0a91` (code identical to `f9b47c4`)
with `node tools/capture.mjs` (seed 1337, 1600×900, clock pinned).

**On-disk location: `reviews/round6/base/`** — 21 PNGs + `manifest.json`.
This directory is immutable. Do not overwrite it. If you need a fresh
capture of unmodified code, copy it; do not re-run into it.

Every before/after number in any `reviews/round6/FIX-*.md` MUST name the file
it was measured from. A "before" number that cannot be reproduced by decoding a
PNG in this directory is not a baseline — it is a memory. Five fix claims died
on exactly that in round 5.

## Baseline state (from `reviews/round6/base/manifest.json`)

`ready: true` · `clockPinned: true` · `partial: false` · **`subjectsOk: false`** · 4 failing shots.

| shot | failing subject | measured |
|---|---|---|
| `04-combat` | horde | 18/24 objects visible; objects 11,12,14,16,22,23 render **0 px**; object 10 sepP50 0.11 |
| `04-combat` | open arena | openness 0.44, need 0.85 |
| `04-combat` | survivor unoccluded by final lens | vis 0.583, need 0.60 |
| `08-explosion` | monsters standing in it | 6/7; object 2 renders **0 px** |
| `08-explosion` | damage numbers | sepP50 0.23, need 0.25 |
| `09-survivors` | the four survivors | perPx [897, 1199, 992, 986] vs needPerPx 1000 — 3 of 4 short |
| `11-bestiary` | the whole spawn roster | 16/16 present but 6 fail: i15 sep 0.19, i13 0.23, i4 0.11, i9 0.41/173px, i8 0.25/154px, i0 63px |

`errorCount: 4` is the **stricter per-object gate working correctly**. It is not a
regression and must never be "fixed" by loosening a threshold.

~~`shots/17-artifacts.png` and `shots/18-difficulty.png` are written by a different
tool than `capture.mjs` and are not in this manifest.~~

**WRONG — corrected by the harness agent.** Both **are** `capture.mjs` scenarios and
both **are** in this manifest; the full shot list runs `01-title` … `18-difficulty`.
I inferred their absence from a script that only printed shots with failures, which is
the same mistake this whole round is about: reading an absence out of a filtered
aggregate. Verified with
`node -e "require('./reviews/round6/base/manifest.json').shots.map(s=>s.name)"`.

## How to verify without colliding

`shots/` is shared. Never capture into it. Use your own out dir and port:

```
node tools/capture.mjs --out reviews/round6/<your-slug> --port <your-port>
```

`--only 04-combat,08-explosion` limits the run. `--seed 1337` is the default and
the only seed any number should be quoted at.
