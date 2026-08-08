# The Hungry Void — Hook, Presentation, and Launch Design

Approved 2026-08-07. Successor to the Round-5 content expansion: that round
filled the game; this design gives it an identity and a commercial arc.

## Goals and constraints (user-set)

- **Success bar:** a real commercial result — meaningful revenue ($20k+ scale),
  sustained players, a foundation to keep building on.
- **Timeline:** no calendar pressure; quality gates decide when phases ship.
- **Hook:** one signature idea expressed across mechanic, run structure, co-op,
  and theme — not four separate hooks.
- **Art capacity:** everything in-game stays code-driven (shaders, materials,
  VFX, post). Outside spend is limited to capsule/key art and trailer polish.

## The pitch

> A co-op roguelike where your power poisons the world — every item you take
> feeds a corruption that visibly consumes the stage under your feet.

Corruption is the price tag on greed, and the player always chose it. It is
never a fun-tax: corrupted items and Voidtouched fights are content you unlock
by sinning, not punishment for playing.

---

## 1. The corruption economy

**One number drives everything: World Corruption**, the sum of per-player
corruption. It rises only through choices, never passively:

| Source | Notes |
|---|---|
| Opening chests | Gold price unchanged, plus a corruption tithe scaled by chest tier |
| **Void credit** | Force a chest open with no gold at all: a steep corruption lump, and a blight seed planted on the spot |
| Taking items | Higher tiers feed more; corrupted-tier items feed most |
| Using shrines | Per use |
| Greed time | Looting after the teleporter event has completed |

A cautious speedrunner ends a stage near zero; a vacuum-everything party ends
deep in the red.

**Gold is not replaced.** Gold remains the budget — it rations how much a party
can take per stage and preserves the kill→earn→spend pacing the Director's
economy is tuned around. Corruption is the shadow price on the same
transaction: gold answers "can we afford it?", corruption answers "should we?"
Void credit is the desperation valve where the two meet — the void will always
extend credit, and taking it is the most deliberate corruption choice in the
game. Chests therefore have two open paths: paid (gold + tithe) and forced
(no gold, large corruption). Both are Phase 1 — the forced path is a second
branch on the existing chest interactable.

### Expressions (all host-authoritative, replicated as events)

1. **Blight fields.** Every greed act plants a seed at the spot where it
   happened. Blight grows radially from seeds as World Corruption rises.
   Materials and props inside the radius swap to void-corrupted variants with a
   crawling-edge VFX. No terrain deformation — mesh/material work only. The map
   remembers where you were greedy.
2. **Voidtouched spawns.** A fourth elite family that only emerges from blight,
   spawn budget scaled by World Corruption. Rides the existing Director elite
   affix machinery.
3. **Item mutation.** At corruption thresholds, a random item stack mutates
   into its corrupted counterpart — the existing corruption tier promoted from
   side content to the game's central bargain. Mutations are stronger, with
   teeth.
4. **World state.** Five readable bands — T0 Pristine, T1 Seeded, T2 Blighted,
   T3 Overrun, T4 Consumed — each with a skybox/fog/grade shift, an audio
   layer, and a HUD gauge state, so the band is legible at a glance.

### Counterplay (costly, never free)

- **Cleansing fonts:** interactables that bleed corruption for gold or max
  health.
- **Voidtouched kills** return a fraction of corruption.
- **Artifacts** modify the economy; at least one accelerates it for players who
  want the chaos.

### Code

- New system `src/systems/Corruption.js` — gauge, seeds, thresholds, band
  events. Class with `init(ctx)` + fixed-update hook per `CONTRACTS.md`; all
  state changes gated on `ctx.authority`; gameplay rolls on `ctx.rng`, cosmetic
  jitter on `ctx.fxRng`.
- Data additions in `src/data/` (corruption tuning table, Voidtouched affix
  card, cleansing font card, pact shrine card).
- Headless-testable the same way Combat/Enemy already are; sp-equivalence
  gates must stay green (corruption draws must not displace existing `ctx.rng`
  streams — use a derived stream, as the shrine-type roll already does).

---

## 2. Run structure and co-op

### Corruption is the router

At the finale-gate stage, gateway eligibility depends on the party's corruption
band: Pristine bands open the clean route; Consumed bands open void-saturated
realms with the richest corrupted loot; middle bands see both and must commit.
Endings key off final band plus route taken. Existing `GATEWAYS` / `ENDINGS` /
`FINALE_PHASES` data gains a corruption predicate; no new engine machinery.

Rules that keep routing honest:

- **Route preview, not surprise:** from stage 3 the HUD shows the current route
  band, so parties argue about it during the run — the argument is the
  gameplay.
- **No dead ends:** every band reaches an ending. Corruption changes which game
  you are playing, never whether you finish.

### Co-op: attribution creates drama, pacts resolve it

- Corruption is tracked per player; the HUD shows each player's contribution.
- **Pact shrines:** a player may voluntarily take a share of a teammate's
  corruption (or their next stage's corruption). The social friction becomes a
  mechanic: greed can be sponsored, accidents can be offloaded before a route
  lock.
- Solo loses nothing — the economy is fully playable alone.
- Netcode cost is deliberately low: a handful of scalars plus seed-placement
  events, host-decided, on the existing reliable `events` channel.

---

## 3. The presentation ceiling

Principle: **the hook is the art direction** — every visual investment carries
gameplay meaning. Five workstreams, ordered by sales impact per hour:

1. **The blight looks incredible or the hook doesn't exist.** Crawling
   corruption edge (animated shader: refraction, emissive veins, particulate),
   corrupted material variants per biome palette, void-warped prop swaps,
   per-band skybox/fog/grade. Carried by the existing `RenderPipeline`.
2. **Readability, then juice.** Formalize `tools/silhouette.mjs` + the shot
   harness into a gate: every enemy readable as friend/foe/tier at 40 m in one
   frame. Then: hitstop on heavy kills, corpse launch on overkill,
   ability-specific kill VFX, damage-type-coloured hit sparks. Ten-second
   clips are the sales unit.
3. **UI stops looking like a web page.** One diegetic treatment across menus,
   HUD, logbook, survivor select: instrument-panel-reading-the-planet —
   seismograph lines, core-sample bars, the corruption gauge as the centrepiece
   instrument.
4. **Trailer-first development.** Every feature milestone ends with its money
   shot captured via `tools/capture.mjs` into a running shot library. Trailer
   thesis shot: the party fighting at a blight edge as it spreads toward
   camera.
5. **Hired art, narrow scope:** one commission covering the Steam capsule set
   and key art (the blight-edge image), optionally logo/wordmark. Nothing
   in-game is outsourced.

---

## 4. Roadmap and launch arc

Each phase ends with a gate that uses the zero-cost web build with real
players before the next investment.

| Phase | Builds | Gate |
|---|---|---|
| **1. Prove the hook** | `Corruption.js` gauge/seeds/thresholds, chest tithe + void credit, first-pass blight visuals, Voidtouched family, item mutation, HUD gauge | Web playtest: testers talk about corruption unprompted; "should we open that chest" is a real decision. Iterate here until yes. |
| **2. Corruption owns the run** | Route gating, ending predicates, cleansing fonts, pact shrines, corruption artifacts, greed-time rule | Testers replay to chase a different route, not just to win. |
| **3. Presentation ceiling** | The five workstreams, blight shader first | Cold-audience screenshot test: described as "the one where the world corrupts," not "a Risk of Rain-like." |
| **4. Steam arc** | $100 fee + page live immediately (wishlists accrue), Electron port per `docs/STEAM.md`, hired capsule art, trailer from shot library, demo, Next Fest | **Early Access launch** at $9.99 introductory once gates 1–3 have passed, with a public roadmap to 1.0. |

Content breadth (more survivors, realms, enemies) is deliberately unscheduled —
those are Early Access-era updates, which is what keeps an EA game alive. The
pre-launch feature set is the hook plus what serves it.

### Explicitly out of scope for this design

- Terrain heightfield deformation (rejected: engine + netcode risk; blight is
  material/prop/VFX work).
- Co-op-required mechanics (pacts are optional; solo is first-class).
- The Electron/Steamworks port details — already specified in `docs/STEAM.md`.

### Testing expectations

- Corruption gauge math, band thresholds, seed placement, mutation rolls:
  headless unit tests in `tests/`, deterministic LCG fixtures.
- Netcode: corruption events replicate host→client (extend the existing
  net test patterns); clients never mutate corruption state.
- sp-equivalence and shot-harness baselines regenerated once per phase, named
  and committed per the repo's baseline-capture convention.
