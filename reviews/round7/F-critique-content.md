# Round 7 content critique — items, CINDER, enemies, meta progression

Reviewer: independent critique pass, harsh/specific, RoR2-shipped-quality bar.
Scope: `cf7e63e` (16 items + 2 equipment, CINDER, shriver/lasher/redoubt) and
`2a0cf30` (UnlockRegistry, challenges 15→38, Profile v2, run-summary readout).
Excluded per dispatch: the `09-survivors` / `11-bestiary` per-object pixel gate
failures (owned by another agent, framing not content).

Methodology: read every new line in `src/data/items.js`, `abilities.js`,
`enemies.js`, `survivors.js`, `equipment.js`, `CharacterMesh.js` (CINDER rig),
`EnemyMeshes.js` (shriver/lasher/redoubt rigs), `UnlockRegistry.js`,
`challenges.js`. Captured the full screenshot suite twice with
`node tools/capture.mjs` (deterministic, pinned clock/seed — both runs
produced byte-identical stats), plus targeted isolated `--only` captures to
test hypotheses. Cropped sub-regions of the PNGs with a throwaway Playwright
script (`tools/_crop.mjs`, deleted before finishing) to inspect individual
rigs and UI regions at native resolution rather than judging thumbnails.
Programmatically cross-checked every item's `glyph` id against the icon
switch statement and checked for duplicate glyphs within a tier. Attempted a
custom headless Playwright probe to directly spawn `shriver`/`lasher`/
`redoubt` and fire CINDER's kit via `ctx.director.spawnOne` /
`ability.fire(ctx, player)` — this did not complete: headless Chromium here
has no GPU path without the software-rendering flags `capture.mjs` itself
uses (`--use-gl=angle --use-angle=swiftshader`), which my throwaway script
omitted, and the run hung/timed out. That specific direct probe is therefore
inconclusive and I'm not citing it as evidence either way. Instead I rely on
the two full, **non-headless** `capture.mjs` runs (the same rendering path
production capture uses), which exercise the new enemies live in the normal
combat spawn pool across six combat-bearing scenarios and reported zero
page/console errors in both runs.

---

## Blocks calling this AAA

### 1. The run-summary screen overflows and clips its own primary UI when run through the standard capture pipeline — directly contradicting the commit's "re-captured clean" claim

**Where:** `src/ui/Logbook.js:946` (`renderRunReport`), `src/ui/Menus.js:1219`
(`showDeath`), `src/ui/hud.css:1159` (`.screen`, no `overflow`/`max-height`),
`src/ui/hud.css:1334` (`.panel--wide`, width-only).

**What happens:** Run `node tools/capture.mjs --out <dir>` — the exact
invocation this review was dispatched with — and open `16-run-summary.png`.
The "Closing in" section's second row ("THE LONG HAUL 4/5") is cut off
mid-progress-bar at the literal bottom pixel of the 1600×900 frame, and the
**Logbook and Restart Run buttons are entirely off-screen**. Reproduced twice
in independent invocations, byte-for-byte identical (44,130,237 damage, 42
kills, 1271 pickups — the capture clock is pinned and seeded, so this is not
a flake).

**Root cause:** `tools/capture.mjs`'s scenario order runs `10-inventory`
(which deliberately gives the player one of every item across all six tiers,
by design, to test icon rendering — see `Harness.js:3521`) immediately before
`16-run-summary`, in the same page session, with no inventory reset between
scenarios (confirmed by isolating each scenario with `--only`: `10-inventory`
alone shows the full one-of-everything grid exactly as expected, and it does
not get cleared before `runSummary()`'s own `begin()`). `runSummary()`
(`Harness.js:4841`) then layers its own "believable ~22-item haul" on top of
the already-full inventory, and the death screen renders the *combined*
haul: 6 tiers, ~90+ distinct items, stacks up to x39.

The 2a0cf30 commit message explicitly claims this exact failure mode was
already found and fixed: *"the first run readout listed all six beaten
records and pushed the summary panel's Logbook and Restart buttons off a
1600x900 frame. Capped to four records and three advanced stats, re-captured
clean."* That fix (`Profile.js:946-947`, `records.slice(0,4)` /
`advanced.slice(0,3)`) works on its own — but it only caps two of the panel's
four variable-height sections. The other two — the "Earned this run"
challenge/unlock chip row and the "Items collected" icon grid — are **still
fully unbounded**, and neither `.screen` nor `.panel--wide` has a
`max-height` or `overflow-y` anywhere in `hud.css`. The verification in the
commit message evidently tested the records-count regression it had just
found, and stopped there, rather than re-testing the panel against the
pipeline's actual scenario order or against a large, multi-tier inventory —
an isolated `--only 16-run-summary` capture *is* clean, which is almost
certainly how "re-captured clean" was produced.

**Why this matters beyond the test fixture:** the specific trigger
(10-inventory's state leaking forward) is a capture-pipeline artifact, but
the underlying defect is not — a real player who has a strong, long run
(items across several tiers plus several achievements landing in the same
run are both ordinary outcomes of a good run, not edge cases) will hit the
same unbounded growth and the same missing scroll. A results screen where the
restart button can be pushed off-frame is the kind of bug that blocks a
certification pass, not a nice-to-have.

**Fix:** give `.panel--wide` (or a wrapper around everything below the stat
grid) a `max-height` and `overflow-y: auto`, matching what `Logbook.js`'s own
`.book-list` already does at `hud.css:2573` (`max-height: 14em`). Then
re-verify against the *standard* capture invocation, not an isolated
`--only 16-run-summary` run.

---

## Would raise it further

### 2. `Bramble Lasher`'s `pull` on an ordinary tier-2 spawn card is a design risk that hasn't visibly been stress-tested against the rest of the horde

**Where:** `src/data/enemies.js:582-635`.

The lasher's own code comment is candid that `pull` "was previously
boss-only" and argues the counterplay is real (sprint out, kill it, or accept
the pull). That's true in isolation. What the comment doesn't address is
*composition*: `shriver` (same round, same tier band) applies `slow` on
every hit of its projectile, and a horde director can field a lasher and a
shriver at the same difficulty coefficient. A player pulled by the lasher
while already slowed by a shriver, arriving inside a mite swarm, is losing
agency across simultaneous sources with no single counterplay — the lasher's
own "sprint out of the cone" answer stops working the moment movement speed
is already being taxed by something else in the field. This isn't a
confirmed bug — I did not run a live horde-density playtest with both cards
active simultaneously at a tuned difficulty — but it's exactly the kind of
interaction RoR2 is careful about (pull effects are traditionally
boss/environment-scoped specifically to avoid unanswerable CC chains), and
it deserves a directed playtest pass before calling the tier-2 roster final.

### 3. `Scrapfly Hive` sits very close to three existing "periodic autonomous strike" items thematically

**Where:** `src/data/items.js:1082-1098` (`scrapfly-hive`) vs. `spark-plug`
(`:621`, on-kill seeking strike), `squall-charm` (`:860`, on-hit seeking
strike to 4), and the boss item `queens-gland` (`:1398`, interval-gated
seeking swarm). Mechanically these are distinguishable (different triggers,
different tiers, different targeting), and I'm not calling this padding — the
5-second DoT-follower shape is genuinely different from an instant burst. But
four items converging on "an autonomous minor projectile fires itself at a
nearby target periodically" is a lot of the same *verb* for one update, and a
tooltip-only read (which is how most players will actually compare items
mid-run) will read Scrapfly Hive as "another Spark Plug." Leaning harder into
what's mechanically distinct about it (right now it's the only one with a
persisting DoT-follower entity, not just an instant strike) rather than only
in the flavour text would help it read as its own thing at a glance.

---

## What's genuinely good — said briefly, because it's true

- **The sixteen items are not padding.** Every one of them changes a
  *decision*, not just a number: `bipod`/`whetstone`/`prey-instinct` buy
  position rather than stats (explicitly, and correctly, framed that way in
  the file's own comments), `gilded-reliquary` turns the shop into a live
  argument with your own DPS, `entropy-ledger` inverts every existing
  defensive item's logic, and the lunar pair (`vow-of-momentum` vs. `bipod`)
  is a real, legible tension rather than two items that happen to share a
  stat. I checked every new item against the existing 109-entry pool for
  functional overlap and found none that are strictly redundant.
- **Icon integrity holds.** I extracted every `glyph:` reference against the
  icon switch statement programmatically: all 109 glyphs resolve to a drawn
  case (none fall through to the default diamond), and no two items in the
  same tier share a glyph — which the file's own commentary calls out as the
  one mistake that would matter (`items.js:1359`, the `gildedcup` vs
  `reliquary` note). The new icons use the same procedural-canvas language
  and the same "different primitive family per item in a tier" discipline,
  and render coherently alongside the originals at the actual 33px
  inventory-strip size — they do not read as bolted on.
- **CINDER has a real identity, not a reskin.** The kit is legitimately an
  attrition/DoT archetype: primary damage is deliberately the weakest on the
  roster (95% vs. Ranger's 220%) because the payout is deferred into burn
  stacks and a special that scales per burning body rather than a fixed hit
  count. The utility is the only escape on the roster that damages the thing
  it's escaping from. Crit is intentionally bad on her (burn/explosions
  can't crit), which reads as a real build decision rather than an
  oversight. The rig (`CharacterMesh.js:1628`) is a deliberate
  inverted-triangle silhouette — wide twin tanks worn high, narrow bare
  hips, forward snouted mask — built explicitly not to reuse the shape
  language of any of the other four. Cropped out of the `09-survivors`
  frame at native resolution, it reads as clearly distinct at a glance
  despite sharing an orange accent hue with Ranger.
- **The three enemies are distinct threat profiles at the design level, not
  stat-block variants**, and the intent survives contact with the renderer:
  Shriver punishes disengagement (a kiter that holds *high* range and
  slows), Lasher is the roster's first non-boss pull unit built around a
  stated counterplay tradeoff, and Redoubt's front/back armor split (0.88
  frontal reduction, exposed rear core) makes the fight legible by which
  face you're looking at. All three are registered in `BUILDERS`/
  `SPAWN_CARDS` and were live, on-screen, and fighting across six
  combat-bearing capture scenarios (`04-combat`, `05-boss`, `06-loaded-hud`,
  `07-interactables`, `08-explosion`, `12-boss-phases`) in two independent
  full non-headless runs, both reporting zero page/console errors.
- **`UnlockRegistry.js` is a real architecture win, not just more content.**
  Inverting the challenge→content binding so content cards declare their own
  `unlock` id and the registry discovers them at module evaluation is
  correctly identified in its own doc comment as solving a real drift
  problem (`Artifacts._auditUnlocks` existed specifically to catch the old
  scheme's failure mode). It's the kind of decision that keeps round 8's
  content from silently breaking round 7's progression — a real engineering
  property, not just prose.
- **Challenge copy and the "closing in" readout are the right shape.**
  Names (`Boss Slayer`, `Glass Cannon`, `Mint Condition`) match the
  existing terse, evocative voice. The post-run "closing in" list correctly
  surfaces near-complete challenges (97/108, 4/5 in my capture) rather than
  an arbitrary subset — that's the right thing to be showing a player who is
  deciding whether to run it back, when the panel isn't clipping it off the
  bottom of the screen (see finding #1).

---

## Verdict

**Does this content round read as shipped-quality? Provisionally yes on
content, no on the meta-progression surface as shipped.** The items,
CINDER, and the three enemies are genuinely well-crafted and hit the RoR2
bar — this is not padding dressed up with flavour text. But the run-summary
screen — the single screen every player sees at the end of every run, and
the one this round's own commit specifically claims to have already fixed
this exact failure mode on — is reproducibly broken via the project's own
standard verification command. A AAA cert pass fails on "the restart button
is unreachable" regardless of how good the items are.
