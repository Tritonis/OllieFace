# B2 — Artifacts, difficulty, and the artifact unlock path

Status: **complete and verified.** Build clean, capture clean (19/19 shots, `ready: true`,
`frameErrors: 0`, `newErrors: []` on every one), `combat-24` median 18.4–26.2 ms across
seven runs, 86/86 unit assertions, and an A/B probe that shows every artifact and every
difficulty changing a real run.

The API B3 is building against shipped **exactly as specified** — no `B2-API-CHANGE.md`
was needed, and B3's `Menus.js` (which landed in parallel) already consumes it correctly:
`list()`, `active()`, `setActive()`, `card.unlock`/`icon`/`color`/`description`, and
`ctx.difficulty.list()/current()/set()`.

---

## 1. The artifacts

Seven cards in `src/data/artifacts.js`. Ids are the genre's vocabulary because every
consultation point in the codebase is a literal `has('swarms')` and a cute id there costs
a reader a lookup every time; the names, descriptions and flavour are ours.

| id | name | what it changes | consulted in |
|---|---|---|---|
| `command` | Artifact of the Edict | Every item drop is *chosen*, not rolled. Default policy: the item you already hold most of in that tier. `setCommandChooser(fn)` swaps in a real picker. | `Items.rollItem` |
| `sacrifice` | Artifact of the Tithe | No chests, no multishop terminals on any stage. Monsters drop items instead, at a chance scaled by what they cost the director. | `Interactables.populate` + `Items.rewardKill` |
| `swarms` | Artifact of the Spate | Twice the bodies at half the price and half the health. Population ceiling, per-card ceiling, unit price and pack roll all double together. | `Director.populationCap`, `Director.spendCredits`, `Director.spawnOne` |
| `glass` | Artifact of the Filament | ×5 damage, ×0.1 max health. | `Items.stats` via `runMods()` |
| `caprice` | Artifact of Caprice | The drop's *tier* is re-rolled off a flat-ish table, so a wooden chest can pay a legendary or a lunar. | `Items.rollItem` |
| `honour` | Artifact of Regalia | Every eligible monster spawns with an elite affix, at 0.35× the affix's normal credit price and half health. | `Director.spendCredits`, `Director.spawnOne` |
| `evolution` | Artifact of Mimicry | Monsters scale off your inventory: +3.8% health and +2.0% damage per item held, capped at ×4 / ×2.5, baked in at spawn. | `Director.spawnOne` via `monsterScale()` |

`command` and `caprice` compose rather than compete: Caprice decides which shelf the drop
comes off, Command decides what is taken from it.

### The architectural rule, and how it is kept

**`Artifacts` answers questions. It never reaches into another system.** There is no
`ctx.director.populationCap *= 2` anywhere in `systems/Artifacts.js` — grep it. Every
effect above is arithmetic performed by the *consuming* system on a number this one
returned:

```js
// Director.spawnOne
const mod = ctx.artifacts?.monsterScale?.();
healthMult: this.healthMult * (mod?.health ?? 1),

// Items.stats
const mods = this.ctx.artifacts?.runMods?.();
if (mods) { s.damage *= mods.damage; s.maxHealth *= mods.health; s.healthRegen *= mods.regen; }

// Items.rewardKill — Items owns the RNG draw and the drop table; Artifacts owns the odds
const sacChance = this.ctx.artifacts?.sacrificeChance?.(victim) ?? 0;
if (sacChance > 0 && this.ctx.rng.next() < sacChance) { … }
```

That is not tidiness. Seven artifacts each poking three systems is twenty-one places an
effect can be left switched on after a run ends, and "my second run had Glass on and I
never picked it" is invisible until someone plays two runs in a row. A query API cannot
have that bug, because no consultation point ever stored anything.

It is also why the feature is free when it is off: `Artifacts` has no `update` or
`fixedUpdate` at all, and `tools/perf.mjs` shows **no `Artifacts.*` key in `perSystemMs`
in any run** (verified below). With nothing selected every hook is one `Set.has` against
an empty set.

`Director` does not import a constant from `Artifacts` either — Honour's elite discount
is `ctx.artifacts.eliteCostMult()`, not an import, because a system importing another
system is exactly what `CONTRACTS.md` forbids.

## 2. Difficulty

Three cards, also in `src/data/artifacts.js`. `coeff` **multiplies the Director's existing
time term** — it does not replace the curve — so `playerFactor` and `stageFactor` keep
their tuned meaning, Rainstorm at 1.0 is bit-for-bit the curve A3 measured the spawn
pacing on, and every existing pacing number remains the Rainstorm number.

| | coeff | enemy hp | enemy dmg | gold | your regen |
|---|---:|---:|---:|---:|---:|
| Drizzle | 0.5 | 0.80 | 0.60 | 1.20 | 2.0 |
| Rainstorm | 1.0 | 1.00 | 1.00 | 1.00 | 1.0 |
| Monsoon | 1.5 | 1.20 | 1.40 | 0.90 | 0.5 |

`coeff` → `Director.updateDifficulty`; enemy hp/dmg → `Director.spawnOne` via
`monsterScale()`; gold → `Items.killReward`; regen → `Items.stats` via `runMods()`.

The other four numbers are the half that makes an easy mode a different *game* rather than
the same game later — a slower clock alone is only "the same fight, postponed".

### One collision, resolved

`ctx.difficulty` was already taken: `Progression.fixedUpdate` published its own difficulty
as a **number** there. The mandated API is `ctx.difficulty.current()`, so the number had to
move. It had exactly one external reader — `Items.killReward`, as a fallback *behind*
`ctx.director.difficultyCoefficient`, which is never absent — so the fix was to delete the
fallback and delete the publish. `progression.difficulty` (the name its own
`_tickTeleporter` and `runStats` already used) is unchanged. Nothing else in `src/` or
`tools/` read it; verified by grep.

`ctx.difficultyId` is now published too, which is the field B1's run record documented as
"arrives when B2/B3 land". It lands here.

## 3. UNLOCK_BINDINGS (added to `src/data/challenges.js`)

```js
export const UNLOCK_BINDINGS = {
  hoarder:          { type: 'artifact', id: 'command' },
  richBeyondReason: { type: 'artifact', id: 'sacrifice' },
  thousandCuts:     { type: 'artifact', id: 'swarms' },
  oneShot:          { type: 'artifact', id: 'glass' },
  theLongHaul:      { type: 'artifact', id: 'caprice' },
  eliteHunter:      { type: 'artifact', id: 'honour' },
  bossSlayer:       { type: 'artifact', id: 'evolution' },
};
```

Chosen so the condition reads as the artifact's own premise: `glass` behind the challenge
literally named *Glass Cannon*; `honour` behind 100 elites and `evolution` behind 10
bosses; `command` and `sacrifice` behind the two loot-economy challenges they then
replace; `caprice` (stage 5) and `swarms` (1,000 kills) as the two reachable-in-an-evening
slots. `looper`, `untouchable`, `veteran`, `noSurvivors` and the three tutorial beats are
left unbound — gating an artifact behind stage 13 means most players never see one.

Nothing else in that file was touched, and no survivor or equipment id was bound (nobody
owns those catalogues this round; a typo there deletes content).

**The two halves are cross-checked at boot.** Each card carries `unlock: '<challengeId>'`
and `Artifacts._auditUnlocks` warns if a card names a challenge that does not exist, or
one that `UNLOCK_BINDINGS` binds to something else. Two files stating one fact will drift,
and neither direction of drift is visible in a screenshot — a mis-bound artifact is either
permanently locked or advertises the wrong condition.

## 4. Protocol change — read this

`PROTOCOL_VERSION` **bumped 1 → 2**, and `WELCOME` gained two trailing fields:

```
… existing WELCOME …          (unchanged, byte for byte)
u32  artifact bitmask         (bit i = ARTIFACTS[i].id is active)
u8   difficulty index         (0 Drizzle, 1 Rainstorm, 2 Monsoon)
```

- Written in `NetHost._onPeer` from `ctx.artifacts.netPack()`.
- Read in `NetClient` **defensively** — `r.remaining >= 5` / `>= 1` — so a 1.x host that
  sends no trailing bytes degrades to vanilla rules instead of throwing out of the one
  message that tells a client who it is.
- Applied in `Coop._onWelcome` via `ctx.artifacts.adoptHost(mask, difficulty)`, **before**
  the world is rebuilt: `Interactables.populate` reads `has('sacrifice')` the moment the
  stage below it is regenerated, and a client that adopted Sacrifice one frame late would
  already have spawned the chests.

A bitmask rather than a string list because `WELCOME` is a fixed-layout binary message and
seven booleans do not deserve a length prefix; both ends are the same build, which is the
same argument `typeId` already makes for enemies in NETCODE.md.

`adoptHost` deliberately bypasses two things: the pre-run lock (a client's run is already
live when `WELCOME` lands) and the unlock gate (a guest is entitled to play the host's
Glass run without having earned Glass — an unlock check there would make the host's rules
silently differ from the client's, which is a desync, not a fairness measure). It is also
deliberately **not persisted**: joining one Glass game must not change what your next solo
run boots with.

Nothing else in `src/net/` was modified and no snapshot field was added — artifacts are
run configuration, fixed for the session, so they belong on the reliable channel exactly
once.

## 5. Files touched

**Owned / new**

| file | |
|---|---|
| `src/data/artifacts.js` | **new** — 7 artifact cards, 3 difficulty cards, Caprice's tier table |
| `src/systems/Artifacts.js` | **new** — the query API, persistence, the co-op handshake, the unlock audit |
| `src/data/challenges.js` | `UNLOCK_BINDINGS` filled in (the marked extension point) — nothing else |
| `reviews/round5/B2-artifacts.test.mjs` | **new** — 86 assertions, `node reviews/round5/B2-artifacts.test.mjs` |
| `tools/artifactprobe.mjs` | **new** — the A/B evidence below |

**Surgical hooks** (`git diff --stat`: 155 insertions, 25 deletions across all ten)

| file | + / − | what |
|---|---|---|
| `src/systems/Director.js` | +55/−15 | difficulty coeff in `updateDifficulty`; swarms in `populationCap`; `swarm`/`roomFor` + honour in `spendCredits`; `monsterScale()` in `spawnOne` |
| `src/systems/Items.js` | +43/−4 | `runMods()` in `stats` and `killReward`; sacrifice drop in `rewardKill`; caprice + command in `rollItem` |
| `src/world/Interactables.js` | +10/−2 | `bought` gate on chest and shop counts in `populate` |
| `src/systems/Progression.js` | +7/−1 | removed the `ctx.difficulty = <number>` publish |
| `src/main.js` | +5/−0 | `import { Artifacts }` + `engine.add(new Artifacts())`, first |
| `src/net/NetHost.js` | +7/−0 | two fields on `WELCOME` |
| `src/net/NetClient.js` | +10/−1 | read them defensively, forward on `netWelcome` |
| `src/net/Coop.js` | +8/−2 | `adoptHost` before the world rebuild |
| `src/net/Protocol.js` | +7/−1 | `PROTOCOL_VERSION` 1 → 2 with the reason |

**Not touched:** `src/ui/*` (all of it — `Menus.js`, `HUD.js`, `hud.css`, `Logbook.js`,
`Icons.js`, `Tooltip.js` are B3's and are B3's in the diff above too),
`src/core/Engine.js`, `src/core/Harness.js`, `src/data/items.js`, `src/data/enemies.js`,
`src/systems/Profile.js`, `src/entities/*`.

### The one file outside the allowed list: `src/main.js`

Two lines — an import and `engine.add(new Artifacts())`. `Artifacts` is a real system with
`init(ctx)` and registration lives in `main.js`; B1 avoided that file because four agents
were editing it mid-round, but Wave A has landed and B3 owns only `ui/`, so the conflict
risk is a two-line append against a 93-line file. Placed **first**, before `Environment`,
because `Director.init` derives its first coefficient and `Items`, `Interactables` and the
UI all consult `ctx.artifacts`. Hiding the registration inside another system (B1's
`Profile` pattern) would have worked, but it would have been dishonest about what this is.

One consequence, handled: `Artifacts.init` runs *before* `Progression` constructs
`Profile`, so the localStorage-restored selection cannot be unlock-checked at load. It is
re-checked on the first `stageStart` (`_enforceUnlocks`), which is the last moment before
it could have an effect. Covered by test §4.

---

## 6. Verification — real output

### 6.1 `npm run build` — clean

```
> vite build
transforming...✓ 84 modules transformed.
dist/assets/index-BJMk7_aJ.js           894.99 kB │ gzip: 276.52 kB │ map: 2,669.52 kB
✓ built in 1.19s
```
(Only the pre-existing >500 kB chunk-size advisory.)

### 6.2 `node tools/capture.mjs` — clean, 19/19

Run against the live shared tree, i.e. *with* B3's in-flight `Menus.js`/`HUD.js` work
present. Written to `--out shots-b2` and then removed, so a concurrent capture run in the
same tree could not clobber it or be clobbered by it.

```
{ "ready": true,
  "shots": ["01-title","02-vista","03-thirdperson","04-combat","05-boss","06-loaded-hud",
            "07-interactables","08-explosion","09-survivors","10-inventory","11-bestiary",
            "12-boss-phases","13-biomes-1","13-biomes-2","13-biomes-3","13-biomes-4",
            "14-survivor-select","15-logbook","16-run-summary"],
  "errorCount": 0,
  "perf": { "programs": 63, "geometries": 571, "textures": 50, "sceneObjects": 343 } }
```

Per shot, from `manifest.json` (note: `frameErrors`/`lastFrameError` live under
`shot.engine`, and `newErrors` on the shot — both are per-shot, not top level):

```
ready true partial false errors []
01-title           frameErrors=0 lastFrameError=null newErrors=[]
02-vista           frameErrors=0 lastFrameError=null newErrors=[]
03-thirdperson     frameErrors=0 lastFrameError=null newErrors=[]
04-combat          frameErrors=0 lastFrameError=null newErrors=[]
05-boss            frameErrors=0 lastFrameError=null newErrors=[]
06-loaded-hud      frameErrors=0 lastFrameError=null newErrors=[]
07-interactables   frameErrors=0 lastFrameError=null newErrors=[]
08-explosion       frameErrors=0 lastFrameError=null newErrors=[]
09-survivors       frameErrors=0 lastFrameError=null newErrors=[]
10-inventory       frameErrors=0 lastFrameError=null newErrors=[]
11-bestiary        frameErrors=0 lastFrameError=null newErrors=[]
12-boss-phases     frameErrors=0 lastFrameError=null newErrors=[]
13-biomes-1        frameErrors=0 lastFrameError=null newErrors=[]
13-biomes-2        frameErrors=0 lastFrameError=null newErrors=[]
13-biomes-3        frameErrors=0 lastFrameError=null newErrors=[]
13-biomes-4        frameErrors=0 lastFrameError=null newErrors=[]
14-survivor-select frameErrors=0 lastFrameError=null newErrors=[]
15-logbook         frameErrors=0 lastFrameError=null newErrors=[]
16-run-summary     frameErrors=0 lastFrameError=null newErrors=[]
```

### 6.3 `node tools/perf.mjs` — `combat-24` inside the band, no frame cost

Seven runs, same machine, other agents' builds and headless Chromiums running alongside:

| run | median | p95 | frames | `Artifacts.*` entries in `perSystemMs` |
|---|---:|---:|---:|---:|
| 1 | 22.0 | — | — | 0 |
| 2 | 23.9 | — | — | 0 |
| 3 | 22.0 | — | — | 0 |
| 4 | 26.2 | 38.4 | 26 | **0** |
| 5 | 20.8 | 32.3 | 21 | **0** |
| 6 | 20.3 | 30.6 | 21 | **0** |
| 7 | 18.4 | 22.6 | 23 | **0** |

Median of medians 22.0, range 18.4–26.2 — inside the 21–26 band bar run 7 (below it) and
run 4 (at its top edge, on a 26-frame sample). Top systems in run 4 are unchanged from the
baseline shape: `Object.lateUpdate 35.977, VFX.lateUpdate 5.785, Director.fixedUpdate 2.600`.

The number that is actually attributable is the last column: **`Artifacts` has no key in
`perSystemMs` in any run**, because it has no `update`/`fixedUpdate` and is not in the
engine's per-phase loop at all. That is a structural argument, and it is stronger than the
timing one on a machine this noisy.

### 6.4 `node reviews/round5/B2-artifacts.test.mjs` — 86/86

Self-contained (fakes `localStorage`, the bus and the profile; imports the real system and
the real data). Covers: catalogue integrity and icon uniqueness; **every card's `unlock`
agreeing with `UNLOCK_BINDINGS` in both directions**; the exact B3 API shape; the pre-run
lock; unlock gating including the stale-selection-after-profile-reset path; persistence,
blocked storage and eight corrupt payloads; the co-op mask round trip over sampled
subsets and a client with a *different* selection adopting the host's; and every gameplay
answer including multiplicative composition of Swarms × Honour × Evolution.

```
ALL PASS: 86 passed, 0 failed
```

Selected lines:

```
[2] the API B3 builds against
  PASS  current() -> { id, name, coeff, index }
  PASS  list() hands out a copy
[3] selection is pre-run only
  PASS  setActive is ignored once the run is live  (["swarms"] vs ["swarms"])
  PASS  difficulty.set is ignored once the run is live  ("monsoon" vs "monsoon")
[4] unlock gating through ctx.profile
  PASS  only unlocked ids are accepted  (["glass"] vs ["glass"])
  PASS  restored before the profile exists (registration order)
  PASS  and swept at run start once the profile can be asked  ([] vs [])
[6] co-op: a client runs the host's rules
  PASS  mask packs to an integer (74)
  PASS  client adopts the host set exactly  (["evolution","glass","sacrifice"] vs …)
  PASS  mask round-trips for every sampled subset (4)
[7] the numbers other systems ask for
  PASS  Swarms x Honour x Evolution compose multiplicatively  (0.44 vs 0.44)
  PASS  a chooser returning nonsense falls back to the policy, never to a roll
```

### 6.5 `node tools/artifactprobe.mjs` — every artifact changes a real run

Each case is a **fresh page load** (artifacts are pre-run state), a rule selection, then
the same measurement taken with the artifact on and off. Real engine, real Director, real
`Items.rollItem`, real `Interactables.populate`. Seed 4242 throughout. `frameErrors: 0`
and zero page errors in every case.

**Swarms** — one card, one bank (600 credits at minute 10), buy until the field is full:

```
OFF   placed 24   populationCap 24   sampleMaxHealth 171
ON    placed 48   populationCap 48   sampleMaxHealth  86
```

**Honour** — same batch:

```
OFF   placed 24   elites  1/24   sampleMaxHealth 171
ON    placed 16   elites 16/16   sampleMaxHealth 342
```

Every unit elite; health 2× rather than the 3.2–5.0× the affix alone would give, which is
the `HONOUR_HEALTH 0.5` cut doing its job.

**Evolution** — 24 items held, then spawn:

```
OFF   scale { health: 1.000, damage: 1.00 }   sampleMaxHealth 171
ON    scale { health: 1.912, damage: 1.48 }   sampleMaxHealth 327
```

**Glass** — the player's live stat block:

```
OFF   damage 12   maxHealth 110
ON    damage 60   maxHealth  20
```

(20, not 11, because `Items.stats`' pre-existing 20 HP floor catches it — the same floor
A2 added so a Lunar stack cannot reduce the survivor to a rounding error. Still a one-hit
kill; deliberately not removed.)

**Command** — hold 3 Crowbars, then roll 60 common drops:

```
OFF   distinctIds 25   top: kevlar-weave 7, glasses 5, medkit 5
ON    distinctIds  1   top: crowbar 60
```

**Caprice** — 800 rolls of a *small* (wooden) chest:

```
OFF   common 648   uncommon 144   legendary   8
ON    common 239   uncommon 241   legendary 184   boss 96   lunar 40
```

**Sacrifice** — what is on the stage, and 400 kill payouts through the real path:

```
OFF   interactables { Chest: 6, MultishopTerminal: 3, ShrineOfChance: 1, Teleporter: 1 }
      orbsFromCorpses 0    gold 16064
ON    interactables { ShrineOfChance: 1, Teleporter: 1 }
      orbsFromCorpses 54   gold 14770
```

Shrines and the teleporter survive on purpose: a shrine costs health or risk, not gold,
and the teleporter is the run rather than loot.

**Difficulty** — the same clock, three rules. Coefficient, monster level, population cap
and elite chance across a 30-minute run:

| minute | Drizzle coeff / lvl / popCap | Rainstorm | Monsoon |
|---:|---|---|---|
| 0 | 1.000 / 1 / 18 | 1.000 / 1 / 18 | 1.000 / 1 / 18 |
| 5 | 1.253 / 1 / 20 | 1.506 / 2 / 21 | 1.759 / 3 / 23 |
| 10 | 1.506 / 2 / 21 | 2.012 / 4 / 24 | 2.518 / 5 / 27 |
| 20 | 2.012 / 4 / 24 | 3.024 / 7 / 30 | 4.036 / 10 / 36 |
| 30 | 2.518 / 5 / 27 | 4.036 / 10 / 36 | 5.554 / 14 / 45 |

Same species, same clock (a Beetle bought at minute 10), so the health figure is not
confounded by the three difficulties buying different cards — and a real 60-second window
of the untouched Director at minute 10 with `spawnOne` wrapped, so attrition cannot
flatter either side:

| | Beetle maxHealth @10min | spawned in 60s | creditRate |
|---|---:|---:|---:|
| Drizzle | 94 | 13–17 | 1.479 |
| Rainstorm | 171 | 14–15 | 2.008 |
| Monsoon | 238 | 16–19 | 2.536 |

Elite chance at 30 minutes runs 0.083 / 0.159 / 0.235. Monsoon reaches Rainstorm's
20-minute state at 13 minutes and its 30-minute state at 20.

---

## 7. Left undone / notes for whoever picks this up

1. **Command has no picker UI, by design of the split.** The mechanism ships complete and
   `ctx.artifacts.setCommandChooser((tier, ids) => id)` is one call away from being a real
   screen. Until someone installs one, the policy is "stack what you already hold most
   of", which is what a Command player does with the picker anyway and is what makes the
   probe above show `distinctIds: 1`. A chooser that returns nonsense falls back to the
   policy and never back to a roll — a mis-wired UI must not silently turn Command off.
2. **Evolution is a stat scale, not a shared inventory.** RoR2 hands monsters your actual
   items; the enemy stat block has nowhere to put them, and building one was well outside
   this brief. Tuned so a 30-item run is a little over double health, which is roughly
   what a shared inventory would be worth. It is honest about being an approximation in
   both the card's description and the constant's comment.
3. **Bosses ignore Honour's forced affix.** `spawnBoss` / `beginTeleporterEvent` keep their
   own affix roll (up to 0.6). A guaranteed elite affix stacked on top of a boss's
   phase-gated attack tables is a different balance conversation from "every spawn card is
   elite", and the artifact's text says *monster*, not *boss*.
4. **The unlock audit warns; it does not throw.** Same posture `applyUnlockBindings` takes,
   and the same reason: a mis-bound artifact should cost that artifact, not the boot.
5. **No two-peer co-op test was run.** The handshake is covered by a unit round trip
   (test §6) and by reading `NetHost`/`NetClient`/`Coop`, but nobody has actually joined a
   Monsoon Sacrifice host from a second browser. That is the one claim here backed by
   construction rather than by observation, and it is the first thing to try if co-op is
   exercised.
6. **`tools/artifactprobe.mjs` is not wired into any npm script** — this repo has no test
   runner. Run it directly; `node tools/artifactprobe.mjs swarms difficulty` filters to
   named cases.
7. **A2's `spawnOrb` guard.** Sacrifice drops go through `rollItem`, which only ever
   returns item ids, so the `ITEM_BY_ID` guard A2 flagged is not a problem here. It still
   is for the equipment barrel A2 described.
