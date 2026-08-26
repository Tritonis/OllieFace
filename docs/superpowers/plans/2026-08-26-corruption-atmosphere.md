# Corruption atmosphere and status legibility (2026-08-26)

User directive (verbatim intent): additional VFX/SFX that reads how corrupted
or pure the world is, plus status-effect legibility wherever it makes sense.
Four asks: (a) cosmetic blight lightning at high corruption, (b) some normal
mobs take on a corrupted appearance scaling with corruption, (c) very high
corruption could give a real, more-dangerous variant (explicitly allowed as a
gameplay change), (d) status legibility (burning looks like burning, insect
procs look like a swarm). Judged by eye in a playtest.

Extends `docs/superpowers/plans/2026-08-26-vfx-inventory.md` (last night's
inventory + gap list) and keys everything off the signal in
`src/data/corruption.js` / `src/systems/Corruption.js`.

## The signal

`ctx.corruption.world` (a float) and `ctx.corruption.band` (0-4, via
`bandOf(world)`) are the only numbers that exist. Band names, from
`BANDS` in `src/data/corruption.js`: Pristine(0) / Seeded(1) / Blighted(2) /
Overrun(3) / Consumed(4).

Every mechanism below reuses the convention `MUTATION.minBand = 2` already
sets ("Band 1 is exempt for the same reason band 1 has no screen grade:
Seeded is the warning, Blighted is when the world starts taking"). Nothing
here fires below Blighted (band 2).

Co-op caveat, inherited from `corruptionPrice.js`'s own header: `Corruption`
is not replicated, so a non-host client reads `world = 0` and never sees these
effects. That is stale *display*, exactly like the HUD gauge and the altar's
emissive pulse already are — not a new problem this pass introduces, and not
worth solving here (it is a net-layer change, out of scope).

## (d) Status legibility — smallest surface, done first

**Burn is already fully legible.** `src/systems/VFX.js`'s `STATUS` table
(`burn`, `bleed`, `slow`, `freeze`, `shock`) already drives a *persistent*
per-entity particle overlay (`_updateStatuses`, VFX.js:2483) for the whole
life of the status, not just a one-shot spark at application — an entity on
fire already streams embers (`FRAME.EMBER`, rising, 22/s) for the full 4.0s
burn duration. Confirmed by reading the tick loop, not assumed. Nothing to add
there; the gap-list request is already shipped and this doc records that so
nobody re-implements it.

**The gap is the insect/swarm read.** `carrion-flies`, `hive-gland` and
`scrapfly-hive` (`src/data/items.js`) all deal periodic `type: 'swarm'`
damage but tag no visual onto the victim beyond the strike's own beam/spark —
there is no "this thing is being swarmed" read the way burn has "this thing is
on fire". Mechanism: add a `swarm` entry to `VFX.js`'s `STATUS` table (same
`FRAME.SPECK`, low rise so it reads as buzzing rather than rising smoke, the
insect-family hue `0xc8d86a` all three items already use) and call
`ctx.vfx.status(target, 'swarm', 0xc8d86a)` from each of the three sites,
reusing the exact mechanism burn already has. `seekingStrike()`
(`items.js:211`) is shared by five callers; only `hive-gland` passes
`type: 'swarm'`, so gating the new call on `type === 'swarm'` inside
`seekingStrike` covers that one caller for free without touching the other
four (rebar-launcher, etc).

`carrion-flies`' `onInterval` has no cooldown gate — it gets a per-target
throttle (`api.items.cooldownReady('carrion-swarm-vfx-' + target.id, 1.5)`)
before calling `vfx.status`, because `vfx.status()` unconditionally plays a
status voice on every call (VFX.js:1797) and carrion-flies would otherwise
fire that every fixed step for every target in its 7m aura — a voice-budget
violation the other two items don't have (both already cooldown-gated at
10s/14s at the caller).

Cosmetic-only: no new `ctx.rng` draw, no damage change, no table restructure
(the three items keep their existing `hooks`).

## (a) Cosmetic blight lightning

Ambient bolts crackling through the air once the world is Blighted or worse,
purely decorative — no collision, no damage, nothing read by simulation.

Mechanism: a small timer inside `VFX.update(ctx, dt)`
(`src/systems/VFX.js:2278`), gated on `ctx.corruption?.band >= 2`. On
expiry, draws one `chainBolt()` (the existing G-4 jagged-path primitive,
already used for chain lightning) between 3 random points suspended above and
around the player — never touching the ground, never an entity — in a fixed
violet-black hue distinct from any gameplay element colour, then re-arms the
timer.

Interval scales with band (denser air the deeper the world is):

| Band | Interval (s) |
|---|---|
| 2 Blighted | 6-9 (random) |
| 3 Overrun | 3.5-5.5 |
| 4 Consumed | 1.5-3 |

The jitter inside each band's range, and the three points' positions, are
drawn from `Math.random()`, not `ctx.rng` — this is the load-bearing choice
that keeps it cosmetic. `ctx.rng` is the seeded stream `gate:sp` fingerprints;
anything read by simulation (aim, spawn rolls, drop tables) draws from it, and
a new draw inserted into that stream on every frame the world is Blighted+
would desync every later roll the instant a real playthrough crosses band 2 —
which the baseline run does. `Math.random()` has existing precedent in this
codebase for pure-cosmetic variance (`Audio.js`, `Music.js` pitch jitter).

No table entry, no Showcase entry: this isn't an item/ability/attack row, it's
an ambient background tick the same way `teleporterAura` is — driven from
`VFX.update` on a live signal, not fired on demand. `tests/showcase-surface`
only re-derives table-driven counts, so this doesn't move it.

## (b) Corrupted appearance on normal mobs

Mechanism: extend the *existing* species+affix tint system
(`src/entities/EnemyMeshes.js`'s `matsFor`/`rigMats`, the same machinery that
mixes an elite's `tint` 52%/26% into a unit's body/dark palette) with a third,
orthogonal axis: `corrupted` (boolean), independent of `affix`. A normal
(non-elite, non-boss) unit rolled corrupted gets the same `mixHex` treatment
at a gentler ratio (30%/16% vs the elite's 52%/26%, so a corrupted scarab
still reads as a scarab first) toward a fixed blight-violet
(`0x6d3bb8` — the same family `CharacterBlight.js`'s ground-patch pass
already uses for its fill/vein palette, so a corrupted mob's *permanent* tint
and a mob standing in a blight *patch*'s temporary claim read as the same
phenomenon at two different scales, not two unrelated purple effects).

The roll happens once, in `Enemy.spawn()` (`src/entities/Enemy.js`), for
non-elite non-boss units only, off `Math.random()` — same rationale as (a):
this is a per-instance cosmetic choice, not a simulation input, and it must
never touch `ctx.rng`.

| Band | Chance a normal spawn is corrupted |
|---|---|
| 0-1 Pristine/Seeded | 0% |
| 2 Blighted | 15% |
| 3 Overrun | 35% |
| 4 Consumed | 60% |

"Some, not all" per the user's own phrasing — even at Consumed, 40% of the
horde stays clean, so a corrupted unit reads as a corrupted *individual*
rather than a reskin of the whole enemy roster.

`rig.setAffix(affix)` gains a second, optional `corrupted` parameter
(default `false`, so every existing call site — `Prewarm.js`, `resetRig`,
`NetViews.js`'s affix-stripped client view — is unaffected); `Enemy.spawn`
calls `this.rig.setAffix(this.affix, this.corrupted)`.

Cache keys (`matsFor`'s `MATS` map, `rigMats`'s per-rig `matCache`) grow a
third component so a corrupted scarab and a plain scarab never share a
material object — the same reason the map is already keyed by affix and not
just by species.

## (c) A more dangerous high-corruption variant — PARKED, open question

The brief allows this explicitly as a real gameplay change, but "which stats,
which enemies, how much" is a balance call this pass will not guess at, per
the brief's own instruction to stop and write the question down rather than
invent numbers.

What exists already and is close in spirit: `VOIDTOUCHED` (`data/corruption.js`)
is *already* "a more dangerous variant that exists because the world is
corrupted" — an elite affix whose spawn rate is `ratePerWorld * world`. The
open question is whether (c) means:

1. **Reuse Voidtouched** — raise its rate or its own stat multiplier further
   at Consumed specifically, no new content; cheapest, but it's an existing
   mechanic getting louder, not a new "distinct model" the user asked for.
2. **A new affix/variant reserved for Consumed alone** — genuinely new
   stats and a new tint, gated so it never appears before band 4. Closer to
   the letter of the ask, but is a full balance-authoring pass (which base
   enemy(s) host it, what the stat multiplier is, whether it drops
   differently) that this session has no numbers for.
3. **A world-level buff at Consumed applied to all normal mobs**, not a new
   named variant — every mob gets meaningfully harder once the world is
   fully consumed, which is closest to "the world itself has gotten more
   dangerous" but risks double-counting `PRESSURE`
   (`data/corruption.js:204`), which already feeds the Director's global
   enemy scaling off world corruption and was specifically tuned
   (2026-08-08) as *the* mechanism for "world corruption buys everyone's
   health and damage." A second, uncoordinated buff stacked on top risks
   restating a number that already exists under a different name.

Recommendation for whoever picks this up: (3) is very likely already what the
game does, entirely by design — re-read `PRESSURE`'s own comment before
adding anything, and confirm with a stats pull whether Consumed already
"feels" meaningfully harder before authoring new content. If it doesn't, (2)
is the right shape but needs a design session, not a guess, on which enemy
family gets it and what it costs elsewhere (a new tier's numbers have to come
from somewhere in the loot/difficulty budget or the pass is pure power
creep). Left unimplemented.

## What this pass chose not to do

- **No new SFX for (a)/(c) beyond what already exists.** Lightning inherits
  whatever ambient sound the arena already carries; adding a bespoke crackle
  sample is real audio-pipeline work (`docs/superpowers/plans/`'s audio
  sample recipe) and wasn't in the smallest-surface-first ordering the brief
  set. If the playtest wants sound on the bolts, that's a `SAMPLES` addition,
  not a VFX one.
- **No status overlay for `type: 'scrapfly'` or `type: 'nail'` etc.** — only
  the three items whose description explicitly promises "a swarm"/"flies"
  get the swarm read; a generic DoT tag on every damage `type` string would
  be scope creep past what the user asked for (which was insect items
  specifically).
- **No client-side corruption approximation for co-op.** (a) and (b) are both
  silently absent for a non-host client exactly as the HUD gauge already is.
  Fixing that is a net-replication change, explicitly out of scope for a
  cosmetic pass.
- **(c) is unimplemented**, per above — this is the expected outcome for a
  balance question the brief said not to guess at.
