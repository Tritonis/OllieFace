# Corruption and Purity System Audit

Date: 2026-08-23  
Repository state: `9aafaf3` (`master`)  
Scope: player decisions, reward economy, corruption/purity/mixed builds, world feedback, endings, multiplayer, onboarding, and telemetry.

## Executive verdict

The system is substantially better than it was on 2026-08-17. Corruption now has visible prices, forecast consequences, Void Marks, band bargains, targeted mutation choices, route consequences, and an irreversible Consumed payoff. Purity now has an active verb (warding), Argent Motes, Sanctuary, five permanent Argent items, a visible purse/progress bar, and distinct VFX/audio. The simulation, disclosure, and instrumentation work is thoughtful and well tested.

The original design problem is not solved, however. Ordinary progression still feeds corruption automatically, and declining an item still earns nothing. Because corruption now mints useful currency, taking everything is at least as attractive as before. The strongest strategic line appears to be:

1. take ordinary loot and corruption freely;
2. collect permanent Blight effects and peak-based Void Marks;
3. ward/cleanse the live gauge to mint Argent Motes;
4. buy Argent items;
5. finish with low live corruption, full-strength Argent effects, retained Blight effects, retained corrupted synergies, and access to the clean route.

This is not a true pure/corrupt/mixed triangle. It is an arbitrage loop in which mixed can retain most of both sides.

The next milestone should focus on alignment commitment and explicit reward choices, not more presentation polish or more item content.

## Current player loop

1. Open a chest by paying gold plus a corruption tithe, or force it with larger void credit (`src/world/Interactables.js:376-415`).
2. Claiming the resulting item feeds additional tier-based corruption; post-teleporter greed doubles all feeds (`src/systems/Corruption.js:63-105`, `src/data/corruption.js:18-24`). Prompt ranges correctly include both the chest charge and possible item tier (`src/world/Interactables.js:366-386`, `src/world/corruptionPrice.js:174-211`).
3. Live corruption increases Director pressure, expands the Voidtouched economy, changes the world grade/audio, and eventually controls finale routes (`src/systems/Director.js:281-295`, `src/data/corruption.js:40-69`, `src/systems/Blight.js:435-450`, `src/data/realms.js:525-553`).
4. Upward crossings from Blighted onward convert a held ordinary stack into its Blight counterpart. The local player gets a six-second choice among up to three eligible stacks; refusal or timeout lets the void choose (`src/data/corruption.js:115-126`, `src/systems/Items.js:667-714`).
5. Peak corruption mints one Void Mark per 25 peak points. Marks survive cleansing and buy the current band's bargain (`src/data/bandBoons.js:23-38`, `src/systems/Corruption.js:117-125`).
6. Voidtouched kills and Argent Fonts remove corruption. Every 40 points removed mints an Argent Mote (`src/systems/Corruption.js:277-318`, `src/data/bandBoons.js:43-74`).
7. One mote buys 12 seconds of Sanctuary, during which corruption feeds are zero. Three motes buy a random permanent Argent card (`src/world/Interactables.js:1914-1930`, `src/world/Interactables.js:2113-2163`).
8. Argent card strength fades linearly with live corruption: 100% at 0, 50% at 55, and 0% at 110. Blight cards do not have the inverse dependency (`src/data/items.js:77-89`, `src/data/items.js:319-557`).
9. At the finale gate, live band determines the offered route: Pristine/Seeded clean only, Blighted both, Overrun/Consumed void only (`src/data/realms.js:525-553`).

## What is working

### 1. Costs are finally disclosed before the press

Chest prompts quote the combined chest-plus-item corruption range, greed multiplier, mark mint, next threshold, mutation toll, and route consequence. This directly addresses the earlier hidden-debt problem and is one of the strongest parts of the implementation.

### 2. Corruption has immediate upsides

Void Marks, terminal rerolls, named Blight synergies, pacts, and RUIN make corruption more than a delayed enemy-stat tax. The system previews exact synergy conversions and pact consequences instead of hiding them behind category labels.

### 3. Purity now has verbs and permanent rewards

Warding, mote progress, Sanctuary timing, and Argent cards give the clean side actions and accumulation. The player can see marks, motes, partial warding progress, Sanctuary time, and Argent fade state in the HUD (`src/ui/HUD.js:620-686`, `src/ui/HUD.js:1017-1132`).

### 4. Mutation is meaningfully interactive

The mutation offer converts an arbitrary loss into a constrained sacrifice decision. The existing six-second, three-card window is a good lightweight interaction and the fallback preserves danger.

### 5. World and presentation feedback are much stronger

Band grades, sky/audio pressure, character corruption, warding sparks, Sanctuary dome, Consecration, mint stings, purse indicators, and greying Argent inventory tiles produce a coherent visual language. Presentation is no longer the main blocker.

### 6. Telemetry is unusually good

The run record captures fed/removed corruption, crossings, marks, motes, bargains, Sanctuary use, Consecrations, mutations, stabilisations, fonts, routes, ruin, and isolated hook failures (`src/systems/Telemetry.js:207-229`, `src/systems/Telemetry.js:330-429`, `src/systems/Telemetry.js:508-594`). The implementation contains explicit refutation conditions, which is excellent practice.

## Findings

### Critical — Mixed currently retains the strongest parts of both alignments

Argent items scale down with **live** world corruption. Cleansing restores them immediately. Blight items, permanent Blight synergy buffs, historical Void Marks, and mutation history remain fully effective after cleansing. The finale route also reads the live band.

Therefore a player can descend for Blight/marks, ward back down for motes, then hold full-strength Blight and Argent effects while entering the clean route. The design comment that “Blight cards do the opposite” of Argent fade is not implemented: Blight effects are fixed and have no live-corruption activation curve.

This is the central balance defect because it makes mixed a superset rather than a high-skill compromise.

### High — The original “always take the item” decision remains

Every positive item pickup still feeds corruption automatically (`src/systems/Corruption.js:75-97`). Walking away loses an item and earns no purity progress, Resolve, Vow credit, salvage, or alternative reward. Corruption now also advances the mark economy, making item acceptance even more economically productive.

Threshold danger and Argent fade can occasionally make an item unattractive, but the baseline transaction remains “gain permanent power now; receive currencies and manageable future costs.” The system has made corruption more fun without making the pickup decision substantially less automatic.

### High — Purity is a redemption/oscillation economy, not a restraint path

Argent Motes are earned only by first creating and then removing corruption. One Argent card costs 120 cumulative corruption removed. A single descent from Blighted (55) cannot produce even two motes; a descent from just below Overrun cannot produce three. At 190 corruption, approximately 12 base-refund Voidtouched kills are required to remove 120 and mint three motes.

This makes the optimal “pure” behavior repeated gauge cycling. It can be a good redemption fantasy, but it does not implement the previously discussed Vow/discipline fantasy and does not reward consistently pure conduct.

### High — Historical benefits can be laundered through a live-state route check

Void Marks are based on monotonic peak corruption and survive cleansing. Blight inventory and synergy buffs survive. Argent Motes are based on cumulative removal. Finale availability is based on the live band when portals are opened. A player can therefore extract historical benefits from deep corruption and buy back the route later.

The Vigil unlock correctly uses peak band, but the main run economy and ending access do not share that honesty. This inconsistency makes “clean ending” mean “clean at checkout,” not “pure run.”

### High — Corruption state is not replicated to clients

The code explicitly documents corruption replication as future work (`src/systems/Corruption.js:10-13`, `src/world/Interactables.js:1826-1835`, `src/systems/Codex.js:36-38`). Clients can therefore display stale Pristine state, zero marks/motes, dormant altar prompts, wrong Argent grace, and incorrect route forecasts while the host resolves authoritative transactions.

This is not only presentation debt: it prevents non-host players from understanding the risk/reward system and blocks remote mutation choice input. A multiplayer game cannot treat its signature economy as host-only readable state.

### Medium — The altar often dictates the offer instead of presenting a strategic choice

Each band exposes only its deepest available Void offer, and the Argent economy is a fallback only when that offer cannot resolve. Three motes automatically replace Sanctuary with Consecration. At Overrun, an affordable pact blocks Argent offers; at Consumed, RUIN blocks them entirely (`src/world/Interactables.js:1885-1930`).

The accept/walk-away decision remains, but the player rarely chooses *which* economy or payoff to pursue at the altar. This weakens the intended “keep the goal or say fuck it” pivot.

### Medium — Consecration is random and unpreviewed

Three motes represent 120 corruption warded, yet Consecration names only “one warded card.” The card is rolled after the press from a five-item pool (`src/world/Interactables.js:1979-2001`, `src/world/Interactables.js:2140-2163`). This avoids frame-rate-dependent RNG, but it also makes purity's permanent build reward another blind chest.

Corruption's best synergy offer previews the exact build outcome; purity's most expensive reward does not. That asymmetry undermines purity as a goal-directed build.

### Medium — The purity vendor can be absent exactly when the player is pure

Void Bargains are guaranteed during stage population only when the run starts that stage at Seeded or above (`src/world/Interactables.js:2764-2776`). A player who enters a stage Pristine with banked motes may have no altar on which to spend them. Crossing to Seeded later does not dynamically place one.

The player can work around this by carrying corruption into a stage and cleansing after the altar has spawned, but that is an opaque routing trick rather than an expressive purity decision.

### Medium — The two sides are uneven in timing and content

Blight effects can arrive early through item rolls/mutation and immediately rewrite ordinary stacks. Argent requires substantial prior corruption removal and has only five random cards. Three Blight synergies exist; only one lightweight Argent pair synergy exists. There are no Tempered/mixed items or mechanics.

The current system therefore has “corrupted build,” “late redemption cards,” and “everything together,” rather than three equally intentional identities.

### Medium — Purity barely changes the world

Corruption changes ground, props, characters, sky, fog, audio, enemies, pressure, routes, and finale behavior. Purity has excellent event VFX and a temporary Sanctuary dome, but warding does not permanently heal a Wound, create a sanctuary, change stage ecology, or alter encounters.

The world remembers where greed happened but not where purity won. This leaves purity feeling like a HUD economy rather than a world state.

### Medium — Instrumentation exists, but the decisive playtest evidence is absent

The repository contains strong telemetry schema and synthetic tests, but no representative blind-run dataset demonstrating bargain acceptance, Sanctuary timing, Argent acquisition rate, alignment win rate, or item-refusal behavior. The first-guess values remain largely defended by reasoning rather than observed play.

Telemetry also omits whether a mutation was explicitly chosen versus timed out/refused, despite `itemMutated.chosen` existing, and it does not record item offers declined or corruption avoided. This limits diagnosis of the original dominant strategy.

### Low — Onboarding and Codex content lag the implemented economy

The tutorial teaches that the void trades for corruption, but not marks, warding, motes, Sanctuary timing, Consecration, or Argent fade (`src/systems/Tutorial.js:100-165`). The corruption Codex covers the older bands, mutations, fonts, and routing but does not explain the new purity economy (`src/data/codex.js`).

## Balance observations

Current formulas produce these checkpoints:

| World | Band | Void marks minted from peak | Argent grace | First stage-0 font cost | One cleanse |
|---:|---|---:|---:|---:|---:|
| 20 | Seeded | 0 | 82% | 90 | 30 |
| 25 | Seeded | 1 | 77% | 98 | 30 |
| 55 | Blighted | 2 | 50% | 143 | 30 |
| 75 | Blighted | 3 | 32% | 173 | 30 |
| 110 | Overrun | 4 | 0% | 225 | 30 |
| 190 | Consumed | 7 | 0% | 345 | 42 |
| 400 | Consumed | 16 | 0% | 660 | 88 |

Consequences:

- Argent items are already substantially weakened at the first mutation threshold.
- One Consecration requires more warding than an entire single descent to Overrun contains.
- Deeper corruption is the fastest way to finance purity, reinforcing oscillation.
- Gold and percentage-based refunds make the exact efficiency highly stage/build dependent; this needs run telemetry, not static tuning alone.

## Recommended direction

### Priority 1 — Define and enforce alignment commitment

Introduce an explicit alignment state derived from meaningful actions, not just the live gauge:

- corruption commitment: corrupted bargains, Blight conversions, peak bands, RUIN;
- purity commitment: completed Vows, sealed Wounds, corruption actively warded;
- mixed commitment: deliberate Tempering that replaces parent effects.

The strongest capstones should read commitment/history. Live corruption should still control immediate danger and grace, but cleansing must not restore every pure benefit while preserving every corrupt benefit.

A minimal first fix is to make Blight strength rise with live corruption while Argent strength falls, and make permanent synergy/capstone eligibility mutually exclusive or replaceable. A more durable fix adds separate commitment counters and route requirements.

### Priority 2 — Move corruption from baseline loot tax to explicit premium choice

Ordinary loot should be safe baseline progression. Corruption should come from visible transactions that grant extra power:

- take the normal item;
- corrupt it for a stronger/targeted Blight outcome plus debt;
- preserve or salvage it toward a Vow/purity objective.

Void credit and post-teleporter greed remain natural corrupt sources. Removing automatic corruption from all ordinary pickups is the direct fix for “always take every item.”

### Priority 3 — Give purity a restraint goal in addition to redemption

Keep warding/motes as the redemption loop, but add stage Vows or Wound sealing as the proactive purity loop. Examples include ending below a threshold, refusing corrupt upgrades, sealing a Wound under combat pressure, or completing the teleporter without void credit.

This allows a genuinely pure player to build purity without repeatedly polluting the world first.

### Priority 4 — Make permanent rewards build-directed

Consecration should offer two or three previewed Argent choices from a derived/non-shared stream. Corrupted premium offers should likewise show the exact Blight outcome. Build goals need visible targets, especially when purchases represent an entire stage of economy.

### Priority 5 — Give mixed a replacement mechanic, not additive access

Add a small Tempered prototype set. Tempering consumes one Argent and one compatible Blight effect and replaces them with a tension mechanic. It must not preserve both parent bonuses. Mixed then becomes adaptable and skill-intensive without becoming the sum of both capstones.

### Priority 6 — Make purity alter the stage

Turn Blight seeds/patches into Wounds that can be sealed or fed:

- seal: combat objective, purity progress, suppresses local Voidtouched pressure, visibly restores terrain;
- feed: immediate targeted corrupted reward, expands the patch and local danger;
- ignore: hazard remains, no reward.

This uses existing seeds, Blight rendering, interactables, and telemetry seams while making alignment visible in the world.

### Priority 7 — Fix multiplayer truth before expanding content

Replicate world, band, peak/route state, marks, motes, warding progress, Sanctuary time, and per-player ledgers. Add a request/response path for remote mutation choices. Test host/client prompts and HUD values against the same authoritative snapshot.

### Priority 8 — Run measured playtests before broad item expansion

Extend telemetry with:

- mutation choice/timeout/refusal;
- item offers taken, corrupted, purified/salvaged, or left;
- time spent in each alignment state;
- live and historical alignment at route selection;
- Argent/Blight/Tempered inventory at stage and run boundaries.

Then run seeded blind cohorts comparing pure, corrupted, and mixed intent. Tune mote cost, Sanctuary duration, grace curve, mark mint rate, and cleanse efficiency only after observing behavior.

## Suggested success criteria

The redesign is working when:

1. ordinary item acceptance remains high, but corrupted-upgrade acceptance varies meaningfully by build and stage;
2. pure-intent players earn permanent power without needing to cross Overrun;
3. corrupted-intent players willingly remain at dangerous live corruption because their build power depends on it;
4. mixed builds trade peak power for flexibility and do not lead both win rate and item value;
5. a player can explain marks, motes, Argent fade, and route consequences after one run;
6. host and clients see the same gauge, prompt, offer, and mutation choice;
7. route choice correlates with accumulated alignment decisions, not last-minute laundering.

## Verification performed

- Fresh static audit of current corruption, item, interactable, HUD, world, route, tutorial, telemetry, and networking code.
- Focused corruption/purity/Argent suite: 18/18 test files passed.
- Independent full suite: 143/143 test files passed.
- `npm run gates:cheap -- --quiet`: all 3 arms passed (tests, build, audit; no unallowlisted high/critical advisories).
- No gameplay code was modified during this audit.
