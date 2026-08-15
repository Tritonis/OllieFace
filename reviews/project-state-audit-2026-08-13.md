# TELLURIC VOID — Project State Audit

**Date:** 2026-08-13  
**Scope:** Read-only review of gameplay, corruption design, content, UX/accessibility, architecture, networking, QA, and release readiness.  
**Verification:** `npm test` passed **55/55 test files** on this checkout. Browser equivalence and multiplayer probes are not part of that default suite.

## Executive assessment

This is already a substantial game, not a thin prototype. It has a complete run loop, five survivors, a large item/enemy pool, artifacts and challenges, side realms, looping and an ending, co-op foundations, strong deterministic tests, bespoke presentation, and an unusually coherent signature system: player greed corrupts the world, changes enemies and inventory, and alters the finale route.

The project’s best product thesis is:

> **How much of the world will you consume to survive?**
Start
That is stronger and more ownable than “Risk of Rain 2 with corruption.” The highest-value work is therefore not adding raw content indiscriminately. It is making corruption feel like an enticing, legible bargain rather than an unavoidable loot tax; making its consequences strategically answerable; and proving the resulting decisions through real playtests and telemetry.

The largest non-design risks are remote co-op readiness, public relay/TURN security, missing release automation, limited onboarding/accessibility, and a handful of very large modules that are becoming expensive to change safely.

## What is already strong

- A recognizable, functioning roguelite loop: escalating director, teleporter event, boss, charge, loot window, stage advance, looping, and stage-five finale (`src/systems/Progression.js`).
- Five authored survivor roles, roughly 100 items, 14 equipment pieces, a broad enemy/boss roster, 10 selectable artifacts, and 34 challenges (`src/data/`).
- Three optional side realms with distinct structures: Market, Crucible, and Vault (`src/world/realms/Realms.js`).
- A real corruption ecosystem rather than a cosmetic meter: loot feed, blight, mutation, Hollowed/Voidtouched enemies, cleansing, co-op attribution/debt transfer, director pressure, and finale routing (`src/systems/Corruption.js`, `src/data/corruption.js`).
- Strong visual and deterministic QA infrastructure: screenshot harnesses, readability gates, performance probes, co-op probes, and 55 passing unit-test files.
- Broad menu/run-state coverage, keyboard/mouse and controller support, settings, logbook, profile/challenge progression, and a desktop shell.

## Priority roadmap

### P0 — Protect the core product thesis

#### 1. Make corruption a tempting bargain, not a tax on genre-standard play

Nearly every item acquisition feeds corruption; paid chests add a tithe; post-teleporter pickups cost more (`src/data/corruption.js:19`, `src/systems/Corruption.js:61`). Because collecting loot is the primary fun and scaling loop, the system can accidentally teach players that engaging with rewards is wrong.

**Recommendation:** Give each corruption band an immediate, visible upside as well as pressure. Examples:

- Seeded: access to a corruption-only vendor currency or reroll.
- Blighted: corrupted item synergies become available, with a preview before conversion.
- Overrun: powerful temporary pact choices or aggressive debt-spending abilities.
- Consumed: a deliberately broken “last chance” power state with irreversible finale consequences.

Avoid generic stat buffs. Rewards should create new decisions and builds. Put the bargain in every interaction prompt: **gain now / debt added / next consequence**.

**Acceptance signal:** In blind tests, players voluntarily choose corruption-positive actions for reasons beyond ignorance, and can explain the expected upside and risk.

#### 2. Stage corruption onboarding instead of teaching the whole economy at once

The current system asks new players to infer chest tithes, tier feed values, threshold bands, doubled late loot, random mutation, Hollowed refunds, pressure scaling, fonts, and ending routes (`src/data/corruption.js:10-171`). The depth is good; the presentation burden is too high.

**Recommendation:** Use progressive disclosure:

1. First feed: freeze only the HUD explanation layer, show the gauge movement and next threshold.
2. Seeded: introduce Hollowed enemies and the kill/refund relationship.
3. Before Blighted: warn that a held stack may mutate and show eligible candidates.
4. First font: preview exact before/after band, price, and avoided consequence.
5. Stage 4: foreshadow how the current band affects the finale route.

Add a concise “Corruption” page to the logbook, unlocked incrementally. Do not front-load a wall of tutorial text.

#### 3. Give players agency over item mutation

Upward crossings from Blighted onward can randomly convert a held stack (`src/data/corruption.js:81`). That supports the horror fantasy but can destroy a carefully assembled synergy without an answer.

**Recommendation:** Preserve the scar while adding one decision lever. Best candidate: at the threshold, offer 2–3 eligible stacks and a short choice window; refusing lets the void choose. Alternatives are a protected-slot consumable, a nominated sacrifice, or a clearly previewed next victim. Mutations should also expose why the transformed item is interesting, not only what was lost.

**Acceptance signal:** Players describe mutation losses as a decision they owned, even when the outcome hurts.

### P1 — Improve run decisions, balance, and endings

#### 4. Make cleansing readable as an investment

Fonts have robust scaling and fairness guarantees, but “pay gold to undo fun” is a likely surface interpretation (`src/data/corruption.js:105-155`, `src/world/Interactables.js:2035`).

Show the exact projected outcome in the interaction: cost, corruption removed, destination band, bank/pressure change, and whether a pending mutation is avoided. Consider a small positive cleansing reward—such as stabilizing one corrupted item—so the action is strategically productive rather than purely restorative.

#### 5. Differentiate the clean and void finales mechanically

Finale routing already responds elegantly to corruption, but the void path is largely the same boss with less forgiveness and better void loot (`src/data/realms.js:207-216`, `:342`).

Make the routes express different verbs:

- **Clean route:** containment, precision, protecting anchors, cleansing hazards.
- **Void route:** spend accumulated debt for power, consume adds, weaponize spreading blight, accept permanent arena loss.

A route-specific second phase or objective would create more value than another standalone boss.

#### 6. Validate side-realm opportunity cost

Market, Crucible, and Vault appear often and can pay heavily; recurring Crucible rewards may make detouring the obvious choice while slowing the main time-pressure loop (`src/data/realms.js:249`, `src/world/realms/Realms.js:584`).

Instrument realm offer rate, acceptance, duration, items gained, post-realm win rate, and time-to-next-stage. If acceptance exceeds roughly 75% regardless of build/state, the choice lacks tension. Potential fixes: corruption-specific costs, forfeited teleporter rewards, route locks, or reduced repeat frequency.

#### 7. Replace interim automatic equipment seeding

Equipment is seeded automatically because its intended acquisition source is absent (`src/systems/Items.js:237`). Add a sparse equipment barrel/shrine or a choice-based swap station. Equipment should read as a strategic commitment and discovery event, not automatic stage-start churn.

#### 8. Deepen horizontal mastery, not permanent stats

All survivors are initially available and meta progression is broad but flat (`src/data/survivors.js:35`). Keep the friendly full-roster start, but add survivor-specific alternate skills, cosmetic mastery, corruption-route feats, and challenge modifiers. Avoid grind-based permanent power.

### P1 — First-session UX and accessibility

#### 9. Add a short, playable onboarding path

There is no clear tutorial/how-to-play flow; the title gives only short menu subtitles (`src/ui/Menus.js:205`). Add an optional 3–5 minute first-run scenario teaching movement, the four skills, loot, teleporter pressure, and the first corruption choice. It should use normal game spaces and be skippable/replayable.

#### 10. Expand accessibility beyond controller navigation

The project has keyboard/gamepad navigation and reduced-motion CSS, but lacks evidence of input rebinding, color-vision modes, captions, robust text scaling, screen-reader live regions, and dialog focus management (`src/core/Input.js:14`, `src/ui/Menus.js:1830`, `index.html:13`).

Recommended order:

1. Full keyboard/controller rebinding and controller layout glyph selection.
2. Separate camera shake, hit flash, chromatic aberration, bloom, and motion reduction toggles.
3. Threat/item rarity color palettes with shape/icon redundancy.
4. Subtitle/caption treatment for important audio cues.
5. Canvas label/instructions, menu dialog semantics, focus trapping, and live status regions.

### P0 before public multiplayer — Harden the network edge

#### 11. Protect the signaling relay

The signaling server has no authentication, Origin checks, per-IP/message rate limits, payload schema/length limits, room/client caps, expiry, or heartbeat cleanup (`tools/signal-server.mjs:62-153`). Four-character `Math.random` room codes are enumerable and rooms have no TTL (`:157`).

Before exposing it publicly:

- Use cryptographically random 8+ character codes.
- Validate message schemas and strict byte limits.
- Add max clients per room, connection/message rate limits, heartbeat/idle eviction, and room TTL.
- Enforce an allowlisted Origin policy or deployment-appropriate authentication.
- Add abuse metrics and structured logs without secrets.

#### 12. Stop treating TURN credentials as URL-configurable persistent values

TURN usernames/credentials can arrive via query string and persist to localStorage (`src/net/NetConfig.js:26-32`, `:75-81`, `:124-130`). URLs leak through history, screenshots, logs, and referrers; long-lived static credentials invite relay abuse.

Use short-lived TURN REST credentials issued by a trusted service, never persist them, redact diagnostics, and retain query overrides only for non-secret endpoint selection in development builds.

#### 13. Complete actual remote co-op validation

The shipping menu calls co-op beta, and project notes say remote end-to-end hand-play and four-peer joining remain open (`src/ui/Menus.js:207`). Treat this as a release blocker for multiplayer marketing claims.

Minimum matrix: two real networks behind NAT, forced TURN, host loss, reconnect/late join policy, 2/3/4 players, 60–150 ms latency, packet loss/jitter, down/revive during stage transitions, simultaneous purchases, and a full run through both finale routes.

### P1 — Engineering and release confidence

#### 14. Add CI and promote critical probes into gates

There are build/test scripts but no CI workflow, lint/typecheck/security-audit scripts, and browser equivalence is deliberately excluded from `npm test` (`package.json:5`, `tests/run.mjs:10`).

Add a CI pipeline for `npm ci`, unit tests, production build, dependency audit, a small Playwright smoke, host-with-zero-peers equivalence, and an Electron packaging/launch smoke. Run heavier visual and four-client probes nightly or before release rather than on every commit.

#### 15. Define a fatal-system error policy

The engine catches system exceptions and continues (`src/core/Engine.js:86-113`). That is resilient for presentation failures but dangerous when an authoritative simulation system partially updates.

Classify systems as critical/noncritical. A critical failure should pause the run, show a recoverable error code, stop authoritative snapshots, and offer safe exit/report. Repeated noncritical failures should disable that subsystem rather than log every frame.

#### 16. Split change-risk hotspots at ownership boundaries

Several files are extremely large: `src/core/Harness.js` (~5,900 LOC), `src/entities/EnemyMeshes.js` (~4,450), `src/data/items.js` (~3,300), `src/ui/hud.css` (~3,250), and `src/systems/VFX.js` (~3,000). Do not refactor them wholesale. Extract only when touching a feature:

- Harness scenarios by domain.
- Enemy mesh families by biome/faction.
- Items by tier/archetype with one registry boundary.
- HUD CSS by screen/component while keeping shared tokens central.
- VFX by combat/status/world channels with explicit budgets.

Add import-boundary tests so extraction does not violate the existing `ctx`/event contracts.

#### 17. Make desktop saves asynchronous and observable

Desktop persistence serializes matching localStorage keys and performs synchronous main-process writes (`src/core/DesktopStore.js:67-84`, `desktop/main.mjs:56-78`). Move to an async, single-writer queue with atomic rename, bounded retries, schema/version size limits, and a player-visible “save failed” indicator. Keep the current corruption-safe behavior for malformed existing saves.

### P2 — Presentation and launch completeness

- Replace placeholder downed/revive audio and evaluate authored samples for the few most important cues; the current procedural audio identity is coherent, but critical gameplay cues deserve unmistakable signatures (`src/systems/Audio.js:1017-1035`).
- Resolve remaining Steam launch work: Steamworks/lobbies, Steam Input validation, achievements/cloud saves/overlay if promised, icon/version metadata, multi-machine and Proton validation, depot/store QA (`desktop/README.md:75`, `docs/STEAM.md:270`).
- Decide whether production web source maps should ship (`vite.config.js:18`); Electron excludes them, web builds do not necessarily do so.
- Add lightweight opt-in telemetry or local run export. At minimum capture survivor/difficulty, stage times, corruption at each stage, threshold crossings, mutation choices, fonts used, side-realm choices, death cause, and ending route. Balance this game with distributions, not anecdotes.

## Suggested next three slices

### Slice A — Corruption comprehension and agency

Add threshold previews, exact font outcome prompts, staged logbook entries, and a choice among mutation candidates. Run five blind first-run sessions. This directly improves the unique selling proposition without needing new content.

### Slice B — Corruption route differentiation

Prototype one route-specific finale phase and one band-specific upside per mid/high band. Use cheap geometry and existing effects first; validate decisions before polishing assets.

### Slice C — Multiplayer/release hardening

Harden relay/TURN handling, add CI smoke gates, and complete the real-network 2–4 player matrix. Do this before expanding public playtesting.

## Playtest questions that matter

Ask players to answer without prompting:

1. What caused corruption to rise?
2. What benefit did you receive for accepting it?
3. What will happen at the next threshold?
4. What could you do to reduce or redirect it?
5. Why did you enter or skip each side realm?
6. Did a mutation feel surprising, unfair, or strategically interesting—and why?
7. How did corruption change the ending beyond making numbers larger?

If players cannot answer questions 1–4 after one run, add clarity before adding more corruption mechanics. If they can answer but consistently avoid corruption, improve the upside. If they always embrace it, increase or diversify the opportunity cost.

## Final judgment

The project’s content volume and test discipline are ahead of its product communication and release operations. Its most defensible identity already exists: loot is ecological debt, and the party collectively decides how far to let that debt reshape the run. Focus the next work on making that bargain **desirable, understandable, controllable, and climactically different**. Then harden the multiplayer perimeter and automate the release gates. That path will create more value than simply adding more items, enemies, or visual effects.
