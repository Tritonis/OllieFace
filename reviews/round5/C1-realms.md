# C1 — Hidden realms, the finale, and endings

The run had no destination: stages looped forever and the only way out was dying.
It now has a shape — ordinary stages, three optional places that break the rhythm
and are not combat stages, and a final confrontation with two real endings.

Everything below is verified by output, not by assertion. Evidence is at the end.

---

## What was built

### New files

| File | What |
|---|---|
| `src/data/realms.js` | The realm table, gateway table, `FINALE_STAGE`, `FINALE_PHASES`, `ENDINGS` |
| `src/world/realms/RealmStage.js` | A `ctx.stage`-contract implementation over an authored arena |
| `src/world/realms/RealmArena.js` | The four arenas' geometry, materials and light |
| `src/world/realms/RealmProps.js` | Gateways, portals, market stalls, refinery, obelisk, plinth, vault chest |
| `src/world/realms/Realms.js` | The system: gateway placement, entry/exit, the three realm controllers |
| `src/world/realms/FinalBoss.js` | The Fracture's phase controller — collapse, ward, heal-deny, victory |
| `src/world/realms/RealmHarness.js` | Nine screenshot scenarios with pixel-measured subjects |
| `tools/capture-realms.mjs` | Their capture driver |
| `tools/realmprobe.mjs` | End-to-end probe of the *organic* flow (no screenshots, only facts) |

### Files edited

`src/systems/Progression.js` (gateway hook, finale portal, `finishRun`), `src/data/enemies.js`
(`special` cards: `anchor`, `warden_vault`, `herald`), `src/entities/EnemyMeshes.js`
(`buildHerald` + palette entry), `src/systems/Items.js` (`take`, for the refinery),
`src/net/NetHost.js` (forward `realmEnter`/`realmExit`), `src/main.js` (register the
system, install the realm harness).

### The central design decision

**Realms are built 4096 m out on +X and the world stage is left standing.**
Entering swaps `ctx.stage` for a `RealmStage`, hides the world's terrain and prop
groups, and moves the player. Leaving swaps back and puts the player where they
were. Nothing is regenerated and **no gameplay RNG is consumed either way**, so
the chests you had not opened are still shut and the teleporter is the same
object. A realm that tore the stage down would have to rebuild it, and rebuilding
it would re-roll it — see `realmprobe` step 5, which measures exactly this.

`RealmStage` satisfies the frozen contract (`raycast`, `sampleHeight`,
`capsuleResolve`, `randomWalkablePoint`, plus `raycastDistance`, `isWalkable`,
`sampleNormal`, `spawnPoint`, `landmarks`, `bound`, `platforms`, `propTargets`)
with an analytic disc floor rather than a heightfield. Its one extra power is
`setFloorRadius`, which the finale uses to take the arena away — the drawn disc,
the collision test and the walkable sampler all read that one number.

---

## 1. The three realms

### The Hollow Market (`bazaar`) — the safe hub

* **Entry**: a **Newt Altar** in an ordinary stage (42%, once per run, from stage
  1). Pressing E costs `50 × 1.3^stage` gold and **arms** the realm; when the
  stage's loot window ends, a second portal opens beside the ordinary one.
  Paying early and travelling late is what makes it a decision made *during* the
  stage rather than after it.
* **Rules**: no director at all (`director.enabled = false`), no clock pressure,
  nothing hostile. The only place in the run where the brightest things in frame
  are stationary and safe.
* **Deterministic spending** — the point of the room. Three **market stalls**
  stocked one per tier band, rolled once on entry, each *named in the prompt
  before you pay*, each independently buyable (unlike the stage multishop, where
  buying one closes the others). Plus a **Refinery**: pay gold, consume one
  common/uncommon you own, receive a guaranteed item one tier up, three uses at a
  climbing price.
* **Exit**: `advance` — the portal moves the run to the next stage.
* **Environment**: a vaulted undercroft. Dark polished stone, brass inlay rings,
  a ten-bay column arcade with lintels, hung lanterns, two warm point lights, a
  cone ceiling, and no sun.

### The Crucible (`crucible`) — the wave trial

* **Entry**: a **Trial Obelisk** (34% per stage, repeatable, free). Direct entry:
  the price is the fight, not gold.
* **Rules**: a 25 m walled pit with the wall *at the floor's edge* — there is
  nowhere to kite to. Five waves on a budget of
  `(18 + 14·wave) × difficultyCoefficient`, so it is worth the same trouble at
  minute four and minute twenty-four. The last two waves roll elites at 45%.
  Waves are placed by the controller, never bought by the director.
* **Reward**: one legendary + two uncommons + `220 × 1.3^stage` gold.
* **Exit**: `return` — the portal is present from arrival, deliberately. A realm
  you cannot leave without winning is a trap, not a gamble.
* **Environment**: iron pit, under-lit through a glowing seam band, six braziers,
  four cover blocks, cone roof.

### The Gilded Vault (`vault`) — the guarded treasure

* **Entry**: a **Gilded Beacon** (26%, once per run, from stage 2), costing
  `120 × 1.32^stage`.
* **Rules**: one room, one **Vault Warden** — a new `special` card with a
  shielded front arc (`frontArmor 0.7`), a committed dash and a quake, forced to
  a tier-appropriate elite affix and scaled off the run's own coefficient. The
  chest is **sealed** until the warden is down, which is why the warden is a
  fight rather than an obstacle to run past.
* **Reward**: two legendaries + one uncommon.
* **Exit**: `return`.
* **Environment**: black marble, gold inlay, eight gilded pillars, bullion heaps,
  the prize lit on a dais at the centre of the composition.

---

## 2. The final stage and the Herald of the Rift

**Progression**: from `FINALE_STAGE = 5` (the sixth stage), the loot window opens
**two** portals — the ordinary one *and* the rift. Taking the ordinary one loops
the run exactly as before with the difficulty ramp untouched; the finale is a
choice, not a wall. (`realmprobe` step 6 measures both portals present.)

**The Herald** (`herald`, `src/data/enemies.js`): 5400 base health, a hovering
flyer with no legs — the one silhouette none of the six teleporter bosses can
make — with its own rig (`buildHerald`) and its own palette rung (violet, a hue
no other card owns). Attack table: a tracking rift lance, an eight-shell
telegraphed shardfall, riftling summons (P2), a pull and an arena-wide nova (P3).

**The phases change the arena and the rules, not the attack table:**

| Phase | Health | What changes |
|---|---|---|
| 1 | 100–70% | Full 34 m arena. Ordinary rules. |
| 2 | 70–40% | **The rim collapses to 22 m** over 2.2 s (eased so it creeps then goes), and **the Herald cannot be hurt at all** until three warded **Rift Anchors** are destroyed. For that stretch "shoot the boss" — the only answer the other six bosses ever have — is the wrong one. |
| 3 | 40–0% | **Floor cut to a 14 m core**, three islands raised as the only other ground, and **healing suppressed for the rest of the fight** through the director's existing heal-deny lock. Every regen item in the inventory stops meaning anything at the moment the arena stops having room in it. |

Implementation notes worth keeping:

* The ward is **absurd armour (1e6), not `invuln`**. A hit that reports nothing
  reads as a broken hitbox; armour puts a visible `1` on screen, which is the
  universal "immune" read, and it keeps the hit feedback honest.
* Anchors carry a fixed **10% of the Herald's own max health**, so the gate is
  the same length of fight whether the finale is reached at minute eighteen or
  minute fifty. They wear `warded`, which repaints them violet (they read as
  pieces of the boss) and whose reflect makes breaking their barrier a decision.
* Beyond `floorRadius` there is void. Falling costs 34% max health and a shove
  back to the middle — a real cost, not a two-hour run lost to one dodge.
* The Herald is pulled back inside the shrinking floor each step; a hovering boss
  has nothing else to bring it in.

---

## 3. Endings

Both go through `Progression.finishRun(ending)` → `_endRun` →
`ctx.profile.commitRun(won, stats)` → `runEnd` → the **existing** run-summary
screen. `runStats()` gained three additive keys (`ending`, `endingTitle`,
`endingLine`); every existing reader is unaffected.

| Ending | How | Record |
|---|---|---|
| **The Herald Falls** | Kill the Herald; a 6 s outro clears the arena and holds. | `outcome: 'victory'`, `ending: 'victory'` |
| **Obliterated** | The **Obelisk of Departure** on the market's dais. Two presses — the first arms, the second commits — because an irreversible run-ender behind one E press next to three shops is a way to lose a run to a mis-click. | `outcome: 'victory'`, `ending: 'obliterated'` |

The summary screen is raised by the HUD's `playerDead` handler, which is the only
way it has ever been reached. A deliberate ending emits no such event, so
`finishRun` calls the public `ctx.hud.onDeath()` directly rather than faking a
death on the bus (which would fire the death VFX, the death sound and every
`playerDead` listener in the build). It then rewrites two text nodes on that
panel — the headline reads "You Died" in authored markup, which is wrong for both
new endings. Screenshots `28` and `29` show "THE HERALD FALLS" and "OBLITERATED".

---

## 4. Co-op

Every decision is the host's: which gateways exist, what the market stocks, when
a wave spawns, when the floor collapses, when the run ends. All rolls are
`ctx.rng` behind `ctx.authority`; cosmetic randomness is untouched.
`realmEnter`/`realmExit` were added to `NetHost`'s forwarded-event list — a
client cannot derive "we are all somewhere else" from a snapshot, and since the
arenas are *authored* the realm id is the whole of the state it needs. Realm
props carry the **existing** interactable wire type ids, so a client that has
never heard of a realm still renders a portal where a gateway is and a chest
where the vault's prize is.

**Not tested with two live peers** — no two-peer co-op test has ever been run in
this project (see HANDOFF known debts). This is code review only.

---

## 5. Harness scenarios added

Nine, in `tools/capture-realms.mjs` / `src/world/realms/RealmHarness.js`, each
declaring subjects checked against **rendered pixels**:

| Shot | Subject assertions |
|---|---|
| `21-realm-gateways` | all three gateways present per-object, plus the survivor |
| `22-realm-bazaar` | stalls, the obelisk, **zero monsters**, the survivor |
| `23-realm-crucible` | a live wave, wall == floor radius, the survivor |
| `24-realm-vault` | the chest, the warden, chest still sealed |
| `25-finale-phase1` | the Herald ≥2000 px, floor == 34, the boss bar live |
| `26-finale-phase2` | anchors, floor ≤23, `warded === true && armour > 1000` |
| `27-finale-phase3` | floor ≤15, `platforms.length === 3`, ward broken, `healingDenied` |
| `28-finale-victory` | summary screen, `record.outcome === 'victory'`, ending named |
| `29-ending-obliterate` | summary screen, committed record, ending named |

They are a **separate tool** rather than more entries in `tools/capture.mjs`,
deliberately: that file's twenty scenarios are one long stateful sequence whose
late shots hand the player every item in the game and never take them away, and
these nine need a clean run they can end *twice*. `capture.mjs` is also on the
do-not-touch list for this task.

---

## 6. Verification evidence

**Build** — `npx vite build`: clean.

**Realm captures** — `node tools/capture-realms.mjs`:
```
ready: true   errorCount: 0   subjectsOk: true   subjectFailures: []
9/9 shots, all subjects measured present
perf: programs 96, geometries 371, textures 52, sceneObjects 386
```
Sample results the manifest carries: `26-finale-phase2 {phase:2, floor:22,
anchors:3}`, `27-finale-phase3 {phase:3, floor:14, platforms:3}`,
`28-finale-victory {record.outcome:'victory', ending:'victory'}`,
`29-ending-obliterate {record.outcome:'victory', ending:'obliterated'}`.

**Existing captures — no regression** — `node tools/capture.mjs`:
```
ready: true   errorCount: 0   subjectsOk: true   subjectFailures: []
21 shots, programs 67
```

**Perf** — `node tools/perf.mjs`:
```
combat-24  median 21.0 ms   avg 21.08   p95 25.4   (band is 17-26)
Realms.fixedUpdate 0.001 ms, Realms.update 0.000 ms
```

**Real run end to end** — `node tools/realmprobe.mjs`, which drives the *organic*
path with no `forceEnter` anywhere. `frameErrors: 0`, `pageErrors: []`:

```
gateways roll .............. 12 attempts, all 3 kinds seen (vault 2, crucible 4, bazaar 1)
newt altar ................. cost 110, gold 120 -> 10, armedRealm 'bazaar'
loot window (stage 3) ...... 2 portals: "Enter Portal", "Enter The Hollow Market"
entered the Crucible ....... stageIsRealm true, floorRadius 25, world terrain hidden,
                             director buying false, all four contract methods answer
left the Crucible .......... 4 monsters had spawned; back on the world stage,
                             terrain visible again, player returned (<3 m),
                             SAME teleporter object, 6/6 chests still unopened,
                             0 realm props left behind, director buying again
loot window (stage 6) ...... "Enter Portal" AND "Enter The Fracture - this ends the run"
                             loopStillOffered true, finaleOffered true
```

**I looked at the PNGs.** Every visual defect below was found by eye, not by the
manifest, and fixed:

1. All three walled realms photographed as an **open-air field under the world's
   sunset sky** with a blown sun disc mirrored off the floor. Root cause: no
   ceiling, plus grazing suns on smooth floors. Fixed with cone roofs, realm suns
   raised to 60–70°, and rougher / lower-`envMapIntensity` floors.
2. The Fracture's floor veins were **baked at the phase-1 radius**, so after the
   collapse nine bright bars hung out over the void and read as floor still being
   there. They now scale with `floorRadius`, and are far thinner.
3. The Herald had a **blown white bar across its middle** — a short wide cylinder
   seen edge-on is all fresnel through the rim term. Removed.
4. `23-realm-crucible` was captioned **"WAVE 1 INCOMING" over a fourth-wave
   field**. The harness now writes the objective line it forced.
5. `28-finale-victory` said **"YOU DIED"** over a victory record.
6. Subjects were measurably too small in four shots (86 px per market stall,
   899 px for a 6.8 m boss); all four reframed and re-measured.

---

## 7. Left undone / known gaps

* **Two-peer co-op is unverified.** Code follows the authority rules and the
  events are forwarded, but nothing has been run against a real client — and
  nothing in this project ever has.
* **The market is dim.** The arcade columns read as thin dark poles against a
  dark wall and the lanterns read as floating diamonds without fixtures. It is
  coherent and clearly a different place, but it is the weakest of the four
  frames and would not score well on axis 2.
* **The Crucible's field is sparse** at low difficulty: the wave budget buys few
  units early, and the shot shows one beetle plus cover. It fills out later in a
  run but the scenario photographs an early one.
* **The Herald's rig is new and simple** — mantle, shell, crown, two arms. It
  reads as distinct from the six bosses and as top-heavy, but it has no legwork
  and less detail than the titan or the vizier.
* **`Items.take` leaves a stale icon** in the HUD inventory when a stack reaches
  zero (the HUD adds tiles but never removes them). Cosmetic; the stat block and
  the count are correct. Only the refinery can trigger it.
* Two DOM reach-ins from gameplay code into HUD internals, both guarded with
  `?.` and both because `src/ui/*` was out of scope: the boss sub-line
  (`FinalBoss.js` and the vault controller) and the summary headline
  (`Progression.finishRun`). If UI ownership frees up, `HUD.setBoss` should take
  a sub-line and `Menus.showDeath` should take an outcome.
* **The finale's `bossDead` reaches Progression**, which sets `bossCleared` and
  drops a boss item. Harmless (the run is ending, and the drop is nice), but it
  is a coupling worth knowing about.

## 8. One thing outside my scope that I fixed anyway

`src/shaders/ParticleShader.js` (another agent's file) had **four backticks
inside a GLSL template literal** at lines 106/112/116/121, which was a hard parse
error — `npx vite build` failed and no agent could verify anything. Replaced with
single quotes, comment text otherwise untouched. Flagging it because the file is
theirs and they may still be mid-edit.
