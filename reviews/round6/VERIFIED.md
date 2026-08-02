# Round 6 — main-session verification ledger

Every agent claim I checked myself, against the on-disk file the agent named.
Claims are not accepted here because a report asserts them.

## Realms agent (`FIX-realms.md`) — claims CONFIRMED

Checked `reviews/round6/base/realms/manifest.json` → `reviews/round6/realms/manifest.json`:

| claim | verdict |
|---|---|
| realms failing shots 3 → 1 | **confirmed** — base fails `23-realm-crucible`, `24-realm-vault`, `26-finale-phase2`; after fails only `23-realm-crucible` |
| `24-realm-vault` survivor 0 px → passing | **confirmed** — base records `px=0`, after does not appear in the failure list |
| anchors `perPx [2020,466,284]` / `perSep [0.31,0.31,0.13]` → passing | **confirmed** — exact match in base; check absent from after |
| `23-realm-crucible` trial wave still failing | **confirmed** — `perPx [995,84,522] → [2184,116,1026]`, improved but object 2 still short |

The agent reported that **2 of its 5 assigned defects did not reproduce** (hub-vs-pit
photometric identity; identical ending headlines) and that it therefore changed
nothing for them. That is the correct behaviour and matches the round-5 pattern of
critics withdrawing findings — the realms critic had already withdrawn four of its own.

## The realms capture tool was never clock-pinned — found during that verification

`clockPinned` reads `undefined` in **both** realms manifests. Cause, in
`tools/capture-realms.mjs`:

- `page.goto` omitted `&pinclock=1`. `Harness.js:1936` reads that param inside
  `installHarness`, which runs **before the engine's first frame**; without it every
  frame from page load to stage-ready is timed by the wall clock. The
  `Harness.js` comment records the measured cost of pinning late: shots agree "to
  within ~1-2% instead of exactly".
- The tool's own comment claimed it pins "exactly as `capture.mjs` does". It did not.
- The manifest recorded no pinning state at all, so `pinClock` silently doing nothing
  was indistinguishable from it working.

**This is the round-5 core lesson for the third time: an aggregate hiding an absence.**
The handoff said "assume it recurs". It recurred.

Fixed in `tools/capture-realms.mjs`: added `&pinclock=1`, passed the explicit `1/60`
timestep, and recorded `clockPinned` in the manifest with a warning on false — so a
future zero is visible rather than absent.

**Consequence, and it is not small:** every realms colour measurement in this repo,
including the realms agent's own dE76 numbers, was taken through an unpinned clock.
This independently explains that agent's caveat (a) — `bazaar` mean L of 31.4 / 46.1 /
64.2 across baseline runs at an identical seed. **The realms dE numbers must be
re-measured after merge** before they are quoted anywhere. The *harness gate* results
above are unaffected: they are pass/fail on object pixel counts, confirmed in both
manifests.

## Corruption-tier agent (`C2-corruption-tier.md`) — attribution CONFIRMED

Tier shipped as **Blight**, 9 items, no RoR2 vocabulary (the tier's own test greps its
whole text surface for all twelve banned strings — a good pattern, keep it).

The agent reported it **could not confirm the 4-failure bar** and showed its working
rather than asserting a clean result. Its `10-inventory` attribution checks out across
three on-disk manifests:

| capture | strip check | verdict |
|---|---|---|
| `base/manifest.json` | `{"shown":83,"items":83}` | passes |
| `items/manifest.json` | `{"shown":83,"items":92}` | fails |
| `items-control/manifest.json` (Blight present, settle stubbed) | `{"shown":92,"items":92}` | passes |

The strip renders **83 tiles in both base and Blight** — only the comparison target
moved. `Harness.js:2911` compares against `ITEMS.length`; corrupted items consume their
paired ordinary item, so the catalogue count is unreachable by construction. **Wrong
assertion, not a defect.** Routed to the harness agent (who owns the file) with a
requirement that the replacement cannot certify an empty strip — a live-inventory
comparison passes trivially at `0 === 0`, which is the same aggregate-hiding-an-absence
shape yet again.

Not yet attributable: `06-loaded-hud` (new failure) and `08-explosion`'s changed
subject. The corruption agent's control capture shows `04-combat`, `09-survivors` and
`11-bestiary` all **passing**, which is other agents' in-flight work landing — and it
shows `10-inventory` failing on a subject named "monsters standing in it", which in the
baseline belonged to `08-explosion`. Scenario subjects are being restructured under
everyone. **No failure count is trustworthy until a single post-merge capture.**

Known limitation carried forward: `HUD.onItemPickup` is append-only and cannot retire a
tile, so an item driven to zero leaves a blank. Pre-existing (`take()` already does this
via the Hollow Market refinery) but corruption makes it routine. Patch is written out in
that report's §7; not applied, because `HUD.js` was unowned but the fix wants pairing
with the `--t-blight` style line.

## Stages agent (`FIX-stages.md`) — step-0 finding CONFIRMED, fix numbers ACCEPTED-UNVERIFIED

**The finding that mattered most this round came from step 0, not from the fix.**
`f9b47c4` latched `#define DET_KILL 0.0` in `Materials.js:358`, applied at :486 as
`gradW *= DET_KILL; hOut *= DET_KILL;` — the terrain detail pass was switched off
entirely. I confirmed this directly:

```
git show fba0a91:src/world/Materials.js | grep DET_KILL
  358:#define DET_KILL 0.0
  486:  gradW *= DET_KILL; hOut *= DET_KILL;
```

and traced its introduction — absent in `619e417`, `811fbef`, `2a782a0`; present in
`f9b47c4`. It is a debug kill-switch left latched by one of the four agents killed
mid-edit, then committed. The handoff's own warning covered this exactly: *"No `FIX-*`
report was written for any of them — re-verify, don't trust the diff."*

Consequences, both recorded in `BASELINE.md`:
- `reviews/round6/base/` is the **detail-pass-OFF arm**. Any material or surface
  measurement against it is measured against a build with no detail.
- A round-4 stages critique run against `f9b47c4` would have scored a build with its
  hewn-stone identity deleted — `crops/arch-base.png` shows the hero arch as bare rock
  with no mortar courses.
- Axis 5 was *not* flat for six rounds because of this; the switch is one commit old.

**Isolation verdict (what I asked for): YES, the detail pass is the salt source — but
not by the suspected mechanism.** The suspected cause was missing distance/filter-width
gating on the ridge octave. The agent's six-arm shader bisection refutes that: killing
either octave outright still leaves 1.388 % / 1.647 %, so *no amplitude gate could ever
have worked* — which explains why the predecessor's gates moved 3.176 % → 2.000 % and
stalled. Forcing `roughnessFactor = 1.0` with the normal fully perturbed collapses it
to 0.094 %. Root cause is **specular aliasing**: sub-pixel normal variance was never
converted to roughness, because three.js's `geometryRoughness` only sees
`nonPerturbedNormal` and was blind to this pass.

That is a materially better answer than the brief's hypothesis, and the agent
demonstrated the brief was wrong rather than fitting the fix to it. It also
independently reproduced round 3's 5.3× as 5.0× from a separately calibrated filter —
the cross-instrument agreement round 2 lacked when it had to retract its root cause.

**Numbers accepted but NOT independently re-measured by me:** b1 far mountain ROI
2.000 % (`detON/13-biomes-1.png`) → 0.471 % (`stages/13-biomes-1.png`) against a
0.400 % detail-off floor (`base/13-biomes-1.png`). Verifying these requires
reimplementing the agent's filter; I confirmed the named files exist and that the
step-0 claim underpinning them is true. **Flag for the round-4 stages critic: measure
this independently.**

Creditable restraint: the agent explicitly does **not** claim frame-wide salt returns
to `base/` levels, and states its filter cannot separate detail from aliasing on near
surfaces (a resolved 3×3 feature scores 2.778 %). Near-field raking contrast and
`07-interactables` are named as outside the fix.

Its `reviews/round6/ctrl/` arm (identical tree, its file alone reverted) fails **the
same five shots**, so this change moves zero subject verdicts.

## Command/shrines agent (`C3-command-shrines.md`) — CONFIRMED, best methodology of the round

Verified its three named manifests myself:

| capture | clockPinned | failing shots |
|---|---|---|
| `ui/iso-base` | true | `04-combat`, `08-explosion`, `09-survivors`, `11-bestiary` — **exactly the documented 4** |
| `ui/iso-final` | true | **the same 4, no fifth** |
| `ui/mixed-tree` | true | 5 — adds `06-loaded-hud`, `10-inventory`; `09-survivors` now passes |

It measured in a throwaway worktree at `fba0a91` with only its four files on top,
*and captured its own control arm there*. That is the only agent this round whose
before/after pair is genuinely isolated from the other five agents' in-flight edits —
and it is why its "no fifth failure" claim actually means something. Adopt this as the
house pattern.

**Self-caught regression worth recording.** Its first shrine implementation broke three
unrelated shots (`05-boss`, `06-loaded-hud`, `10-inventory`) by taking one `ctx.rng`
draw per shrine — **the same shared-stream displacement the handoff documents for
`archGeo`**. It diagnosed and fixed this itself by moving the type choice to a private
stream seeded from `(seed, stageIndex)` while keeping the two inherited gate draws
byte-identical: 7 failures → 4. The shared RNG stream is now a repeat offender and
belongs in the standing-hazards list, not as a one-off note about `archGeo`.

**Command is playable.** Probe evidence: 25 consecutive `rollItem('common')` calls all
returned the ordered id with `ctx.rng`'s state word unchanged — the pick advances the
shared stream by zero steps. Implemented as a standing order rather than a per-drop
modal because `Items.rollItem` is synchronous and is the single funnel for all six drop
sources, some of which have no moment to raise a screen.

**Co-op gap, stated not hidden:** a client's edict has no effect because `Protocol.js`
has no client→host channel for it. The screen tells guests this in words rather than
lying to them. Correct handling of the "no two-peer co-op test has ever been run"
hazard — it did not assert co-op correctness it could not test.

**Branding job 3 done and verified.** `Shrine of Chance` is gone from live code; the two
remaining occurrences are comments, one of which documents the rename. Six shrines
confirmed present in source (`Auric Cairn`, `Ichor Font`, `Hollow Chime`, `Gilded
Snare`, `Fallow Vault`, `Marrow Kiln`). One incidental lowercase mention survives in
`src/systems/Items.js:61` (another agent's file) — folded into the branding pass.

## VFX agent (`FIX-vfx.md`) — CONFIRMED, and the most disciplined attribution of the round

Verified `reviews/round6/vfx/manifest.json`: `clockPinned: true`, failing shots exactly
`04-combat`, `08-explosion`, `09-survivors`, `11-bestiary` — the baseline four, no
fifth. `08-explosion`'s **"damage numbers" subject now passes** (sepP50 0.23 → 0.25).
`08`'s only remaining failure is "monsters standing in it", which is the harness
agent's framing job, not VFX. All named evidence files exist on disk.

**It refused to claim its predecessor's work.** It established that
`reviews/round6/base/` — my baseline — is *not* the pre-fix state, because `fba0a91`
already contains `f9b47c4`'s unreported partial work. So it carried **three** on-disk
states (PRE = `reviews/round5/base-r4/`, BASE = `reviews/round6/base/`, NOW =
`reviews/round6/vfx/`) and credited the commit rather than itself:

- core-clipped-R fraction **100% → 0% → 0.6%**. The 100% → 0% was `f9b47c4`'s work.
  Its own rim emitter puts **0.6% back**, and it reports that as a trade it introduced
  rather than burying it.
- aberration `08-explosion` **4 px → 1 px**, `04-combat` 4/5 → 1/1, `10-inventory`
  4 → 1. **Entirely `f9b47c4`'s `RenderPipeline.js` change; it verified and added
  nothing.** Measured on a 3D-only band `y ∈ [90,470]` specifically so the round-2
  critic's HUD-chamfer error cannot recur.

This is the exact failure mode that killed five claims in round 5 — measuring a
different artifact than ships, and crediting the delta to oneself — and it is the
second agent this round to independently discover that `fba0a91` carries unreported
work. Converging findings from two agents that did not share evidence.

**It calibrated its instrument before using it.** `tools/vfxmeasure.mjs` reproduces the
round-3 critic's published numbers *to the digit* on the PRE frame before scoring
anything. That is the discipline round 2's stages critic lacked when it had to retract
a root cause as an artefact of its own filter.

**It found a real bug in `f9b47c4` by measurement, not inspection.** Adding its rim
emitter alone *worsened* the per-ray gradient (44.6 vs BASE 46.2), and chasing that
revealed `f9b47c4`'s quad-boundary fade `smoothstep(0.74, 1.0, rq)` was leaving only
**18%** of `shockRing`'s alpha — switching the atlas's one sharp-edged frame off
engine-wide. Narrowing to `0.90 → 1.0` preserves the `rq ≥ 1.0` boundary guarantee
exactly and yields 57.4.

**It added a second instrument for a stated reason:** an annulus mean averages a ring
away by construction, so it reported both annulus-mean (6.6 → 8.1 → 9.2 L) and per-ray
median (21.5 → 46.2 → 57.4 L). Reporting the critic's own weaker instrument alongside
its better one is the right call.

> **CORRECTION, from the round-4 UI/VFX critic.** Two of that agent's instruments are
> now refuted, and I had accepted both above:
> - **The per-ray median does not discriminate.** Plain scenery in `06-loaded-hud`
>   scores **113.3** at the same coordinate where `08-explosion`'s blast scores **54.0**.
>   A statistic that ranks empty terrain above the explosion it was built to measure
>   cannot support the 21.5 → 46.2 → 57.4 claim. **Treat that number as withdrawn.**
> - **Its `y ∈ [90,470]` "3D-only" band does not exclude the inventory strip.** Its
>   `10-inventory` aberration figure was therefore measured across ~9,000 HUD tile
>   edges. This one cuts in its favour — it *understates* its own win — but the band
>   was chosen specifically to avoid the round-2 HUD-chamfer error, and it did not.
>
> What survives unchallenged: **chromatic aberration is genuinely fixed**, and the
> round-4 critic explicitly *withdrew* its predecessor's finding after verifying on
> 3D-only water and sky windows, 6 px → 1 px. The fix was real; two of the instruments
> used to measure it were not.

**Dissolve trap: not touched**, as instructed — no sibling guard, no half-fix,
`resolveObject` unchanged. Shipping an invisible-enemy bug would have been far worse
than leaving dissolve broken.

`ParticleShader.js` parses and builds clean — the failure that blocked an agent last
round did not recur.

## Second `capture.mjs` defect — CONFIRMED in source

`tools/capture.mjs:275-276` clears the `--out` directory *before* navigating and before
the boot check. A transient syntax error from any parallel agent therefore destroys the
previous good capture and leaves nothing. The stages agent lost two completed captures
to this. Routed to the harness agent: gate the delete on `ready`, and make a failed run
visibly distinguishable on disk rather than merely absent.

## Toolchain incident (my own, logged for honesty)

I ran `npx vite build` to check the tree. npm 6.13.6 on PATH resolved it through the
npx cache and its rimraf deleted
`node_modules/@rolldown/binding-win32-x64-msvc/package.json`, leaving the `.node`
binary. Build failed with "Cannot find native binding".

Repaired by recreating that one `package.json` at version 1.2.1 from
`package-lock.json`. `lockfileVersion` stayed 3; no reinstall was needed and no agent
was disturbed. **Use `node node_modules/vite/bin/vite.js build`, never `npx`.**
This is a distinct hazard from the `npm install` one in the handoff and is now in
project memory.

## Build state at time of writing

Red, transiently and expectedly: `src/ui/Menus.js` and `src/shaders/ParticleShader.js`
are mid-edit by two live agents. Not touched — editing under a running agent is what
broke `ParticleShader.js` last round.
