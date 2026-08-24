# Independent review: corruption/purity audit

Date: 2026-08-23  
Reviewed artifact: `reviews/corruption-purity-audit-2026-08-23.md`  
Repository checked: `master` at `9aafaf3`

## Verdicts

- SPEC: **CONFIRMED**. The audit's claims are consistent with the current repository and independently reproduced below.
- QUALITY: **READY**. No reproducible gameplay, formula, route, altar-precedence, co-op-state, or test-result defect was found.

## Independently verified claims

- `BANDS` are 0/20/55/110/190; marks are `floor(peak/25)` and persist after `bleed`; motes are `floor(warded/40)` and are minted only by actual `bleed` amount (`src/data/corruption.js`, `src/data/bandBoons.js`, `src/systems/Corruption.js`).
- Ordinary item pickup feeds corruption through the `itemPickup` listener, while refusal has no corresponding purity/salvage/Vow reward. Chest tithes and post-teleporter greed are separate feeds and greed doubles the priced feed (`src/systems/Corruption.js:63-105`, `src/world/Interactables.js:366-415`).
- Argent grace is live-world based: `1 - world/110`, clamped to 0..1. Blight cards and the permanent synergy buffs do not use that grace curve, so cleansing restores Argent payoffs while retained Blight effects remain available (`src/data/items.js:68-89`, `src/data/items.js:484-557`, `src/systems/Items.js:674-805`).
- The 120-warded-points cost for a three-mote Consecration, the 190-world geometric refund estimate, and the table's grace/cleanse checkpoints all reproduce from the shipped constants. For example, `cleanseCost(0,0,20)=90`, `cleanseAmount(190)=42`, and `cleanseAmount(400)=88`.
- Finale routing is a live-band check: `routesFor(0/1)` is clean-only, `routesFor(2)` exposes both, and `routesFor(3/4)` is void-only (`src/data/realms.js:525-553`). Peak state is separate, supporting the audit's laundering/history inference.
- `VoidBargain.offer()` checks ruin, then pact, then synergy/reroll, and only falls back to Argent when that higher-band offer cannot resolve. Three motes therefore replace Sanctuary with Consecration when an Argent card is stocked; the card is drawn on press, not preview (`src/world/Interactables.js:1887-1968`, `2116-2163`).
- Void Bargains are dynamically guaranteed only when the stage is populated at Seeded or above; the stage-population code does not retroactively add one after a clean stage crosses upward (`src/world/Interactables.js:2755-2778`). The audit's altar-spawn warning is accurate.
- Corruption, marks, motes, warding, and Sanctuary are not among the host-forwarded events/snapshots. `Corruption` is explicitly host-authoritative and the client defaults to its own local state, while mutation choice is local HUD/input state (`src/systems/Corruption.js:10-14`, `src/net/NetHost.js:112-151`, `src/world/Interactables.js:1593-1596`, `src/systems/Items.js:748-805`). The co-op visibility and remote-choice concerns are therefore valid.
- The repository's full test runner independently completed **143/143 test files passed**, and `npm run gates:cheap -- --quiet` independently completed **3/3 arms passed** (test, build, audit). The revised report now records both results and cites the current `9aafaf3` checkout.

## Important omissions checked

I found no material omission that overturns the audit's strategic conclusions. Existing Vow-named items are unrelated Lunar item content, not a purity-alignment commitment system; no `Tempered`/`Tempering` mechanic exists in the gameplay data/systems. The audit appropriately labels its mixed-build conclusion as a design inference rather than a measured win-rate result and correctly notes the absence of representative blind-run data.

## Commands run

```text
git rev-parse --short HEAD
git branch --show-current
git log --oneline -5
rg -n "...corruption/Argent/route/mutation/network symbols..." src tests
npm test
npm run gates:cheap -- --quiet
```

Observed results:

- HEAD: `9aafaf3`; branch: `master`; this matches the revised audit header.
- `npm test`: `143/143 test files passed`.
- `npm run gates:cheap -- --quiet`: `GATES CHEAP: PASSED (3/3 arms)`.
