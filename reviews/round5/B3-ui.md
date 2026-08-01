# B3 — UI: making Wave A reachable

Everything Wave A landed is now reachable from the interface: four survivors are
selectable and boot with their own loadouts, the equipment slot is on the HUD on
`F`, the four skill tiles carry the *current* survivor's abilities, and there is
a logbook, a difficulty screen, an artifact screen and a run summary.

Status: **complete.** Build clean, capture clean (20 shots, `ready: true`,
`errorCount: 0`, every shot `frameErrors: 0` / `newErrors: []`), `combat-24`
median 22.6 / 22.8 / 23.9 ms across three runs — inside the 21–26 ms band.

---

## 1. Screens built

### Survivor select (`14-survivor-select.png`)

Three columns: **roster** (four cards, accent rule, subtitle, lock chip),
**portrait** (live 3D `CharacterMesh` rotating over a raking floor rule, with the
name plate and lore under it), **loadout + stats** (four ability rows with their
own icons, key chip, description and cooldown; five stat bars). Footer carries
the difficulty and artifact chips and Begin Run.

Two deliberate calls:

- **Stat bars are roster-relative, not absolute.** `170 armor` means nothing to a
  new player; a bar that is longer than the other three's does. The scale is the
  roster maximum per stat, computed once in `buildSelect`.
- **The screen sits over the live orbiting stage**, on the title screen's
  directional scrim rather than the pause screen's near-opaque radial. Round 4
  scored the title's composition partly on that scrim; erasing the world behind
  the roster would have left a panel in a black box.

### Equipment slot (`06-loaded-hud.png`, `10-inventory.png`)

Fifth tile in the bottom-right cluster, **hidden entirely until something is
held**. Styled apart from the four skills — equipment-tier orange plate, chamfer
mirrored to the opposite diagonal, separated by a rule — so the row reads "one
active, four skills" rather than "five buttons". Key chip prints
`EQUIPMENT_KEY_LABEL`, not a hardcoded letter. Sweep comes from
`equipmentFraction()`, charge pips from the snapshot, and `equipmentUsed` pulses
the tile.

### Per-survivor skill icons

`Icons.js` gained `ABILITY_ART`: **sixteen** glyphs keyed by `ability.id`, drawn
in the survivor's accent colour, with the old four slot glyphs as the fallback
for anything unknown. `HUD.buildSlots()` repaints on `survivorChanged`. Before
this the M1 tile drew the same three-round burst whether the button fired a
carbine, a hammer, a rifle or a rivet gun — i.e. the icon carried the slot, which
the key chip underneath already said.

### Logbook (`src/ui/Logbook.js`, `15-logbook.png`)

Six tabs (Survivors / Items / Equipment / Monsters / Bosses / Challenges), a
scrolling index and a detail pane. Survivors and monsters get the 3D viewer;
items and equipment get their plate art, description and flavour; challenges get
a progress bar and their reward.

- Unlock state is read **only** through `ctx.profile.isUnlocked(type, id)` and
  `ctx.profile.isDiscovered(kind, id)`. Challenge rows come from
  `challengeState()` / `challengeStates()`; `CHALLENGE_BY_ID` is never imported,
  so hidden challenges stay masked.
- **Locked and undiscovered are two states, not one.** Locked shows `???` with
  the challenge that opens it; undiscovered keeps its name legible and hollows
  its tier mark. The header counter (`0 / 16 recorded`) carries the progress.
- Bestiary flavour lines live in this file, not in `data/enemies.js` (not mine to
  edit, and it carries no lore field). Every *number* on a monster entry is read
  live off the card, so a rebalance can never leave this file lying.

### Difficulty and artifacts (`17-artifacts.png`)

Built against B2's contract exactly as specified; `reviews/round5/B2-API-CHANGE.md`
does not exist and the shipped API matches. Every call is guarded
(`ctx.artifacts?.list?.() ?? []`) and there is a fallback difficulty table used
only when `ctx.difficulty` is absent — and it is not decoration: it writes
`ctx.settings.spawnRate`, which `Director` already reads and which `Menus` owns,
plus `ctx.difficultyId` for B1's run record. With B2 present the fallback is
never consulted.

The artifact grid renders three states: **active**, **earned but off**, and
**locked with its challenge named**. Locked is a treatment, not an opacity pass —
a blanket half-opacity over already-low-contrast cards made a fresh profile's
grid read as broken UI rather than as seven things to go and earn.

**One integration note for B2** (behaviour, not a bug I could fix from `ui/`):
`Artifacts.setActive` and `setDifficulty` are pre-run only and latch on the first
`stageStart`. That is the right rule, but it means a player who opens the artifact
screen from the pause menu gets a button that silently does nothing. The UI now
verifies the write took (`setActive` then compare `active()`), and if it was
refused it says so in the panel note rather than re-rendering an optimistic state.
A `Artifacts.armForNextRun(ids)` that stores a pending selection would let the
pause-menu path be useful instead of merely honest.

### Run summary (`16-run-summary.png`)

Extends the death screen with a **run identity** row — survivor (in their accent),
difficulty, artifacts by name — above the existing stat grid, the item haul, and
an **Earned this run** row assembled from `challengeComplete` events collected
during the run plus `ctx.profile.drainPendingUnlocks()` (drained, so an unlock is
never announced twice).

### Keyboard and gamepad, on every screen

The menus were mouse-only. Every navigable control now carries `data-nav`;
`Menus.navigate()` walks the open screen's list with arrows/WASD/D-pad, confirms
on Enter/Space/A, and backs out on Escape/B. **The mouse moves the same ring on
hover**, so the two input paths cannot disagree about what "confirm" would press.
Gamepad is polled with a 380 ms/140 ms repeat (the Gamepad API has no press
events, and a held stick at 60 Hz walks a nine-entry menu eight times before a
human notices). Text fields are excluded, or pasting a co-op code would navigate
away mid-word.

Also replaced the single `returnTo` slot with a **stack**: Settings opened from
Difficulty opened from Select used to overwrite the one slot and leave Back
pointing at the screen it had just come from — three levels deep, Back was a loop.

---

## 2. APIs consumed

| From | Used |
|---|---|
| `data/survivors.js` | `SURVIVORS`, `getSurvivor`, `loadoutOf` |
| Player / Engine | `ctx.survivorId`, `ctx.setSurvivor(id)`, `ctx.player.slots[].ability`, `ctx.player.survivor`, `survivorChanged` |
| `systems/Items.js` | `ctx.items.equipment`, `.equipmentFraction()`, `EQUIPMENT_KEY_LABEL`, events `equipmentChanged` / `equipmentUsed` |
| `ui/Icons.js` | `equipmentArt`, `itemArt`, `cardDef`, `tierMeta` |
| `systems/Profile.js` | `isUnlocked`, `isDiscovered`, `challengeState`, `challengeStates`, `drainPendingUnlocks`, `unlock`, `runHistory`; events `challengeComplete` |
| `systems/Artifacts.js` | `ctx.artifacts.list/active/setActive`, `ctx.difficulty.current/set/list` — all optional-chained |
| `entities/CharacterMesh.js`, `entities/EnemyMeshes.js` | dynamic-imported by the viewers only |

`Tooltip.js` now resolves through `cardDef` instead of `ITEM_BY_ID`, so equipment
gets a real tooltip instead of a bare id (A2 §8.3).

`HUD.js` imports one **constant** from `systems/Items.js` (`EQUIPMENT_KEY_LABEL`).
That is a module-level string, not a cross-system reach — the slot itself is read
through `ctx.items` — and A2's report asks for exactly this rather than a
hardcoded `'F'`. Flagging it because CONTRACTS.md's "do not import one system from
another" reads on it.

---

## 3. Disposal strategy for the 3D previews

One class, `ModelPreview` in `src/ui/Logbook.js`, used by both the survivor screen
and the logbook. It owns its **own** `WebGLRenderer` rather than scissoring a
corner of the game's: the frame goes through a five-pass composer with bloom, GTAO
and SMAA, and a menu portrait has no business threading itself into that.

- **Created lazily on first open, destroyed on close.** `Menus.open()` is the
  single place that happens — `if (prev === 'select' && name !== 'select')
  this.unmountPreview()`, same for the logbook — so no exit path can miss it.
  Verified: `previewDisposedAfterLaunch: true` for all four survivors, and
  `bookUp: true` / `bookDown: true` for the logbook (probe output in §4).
- **`dispose()` calls `renderer.dispose()` *and* `forceContextLoss()`** and removes
  the canvas. A dropped renderer keeps its context alive until GC gets round to
  it and browsers cap live contexts at ~16 — open the logbook seventeen times
  without this and the *game's* context is the one that gets evicted.
- **The subject supplies its own release.** A `CharacterMesh` this UI built is
  ours to destroy (`disposeTree` walks the tree disposing geometries and
  materials, single or array). A pooled enemy rig is **returned** via
  `EnemyMeshes.releaseRig`, never disposed — freeing buffers under the pool would
  break the next spawn of that monster. Swapping entries calls `clear()`, which
  runs the release for the outgoing subject before the new one is attached.
- Lights are disposed with the context; the scene and camera are dropped.
- No per-frame allocation: `update()` is a resize check, one rotation write and
  one render, and only the open screen's viewer is stepped.

Framing is solved from the subject's own **visible** bounds. `Box3.setFromObject`
measures every child regardless of `visible`, and an enemy rig parks its telegraph
decals, beam segments and shockwave discs in the tree invisible — measuring those
framed the Stone Golem at a little over half the panel it was supposed to fill.
`visibleBounds()` walks `traverseVisible` instead.

---

## 4. Verification (real output)

### `npm run build`

```
vite v8.2.0 building client environment for production...
transforming...✓ 83 modules transformed.
dist/assets/index-WlcCmW8d.css           45.22 kB │ gzip:  10.20 kB
dist/assets/CharacterMesh-XP11LUMH.js    25.40 kB │ gzip:   8.22 kB
dist/assets/EnemyMeshes-D5pPuqE5.js      69.85 kB │ gzip:  21.92 kB
dist/assets/index-20flU8Dy.js           896.88 kB │ gzip: 277.08 kB
✓ built in 1.01s
```

Clean. (The >500 kB advisory is pre-existing. `CharacterMesh` and `EnemyMeshes`
are now separate chunks because the viewers import them dynamically — a player
who never opens the logbook does not pay for the bestiary rigs at boot.)

### `node tools/capture.mjs`

```
{
  "ready": true,
  "shots": ["01-title","02-vista","03-thirdperson","04-combat","05-boss",
            "06-loaded-hud","07-interactables","08-explosion","09-survivors",
            "10-inventory","11-bestiary","12-boss-phases",
            "13-biomes-1","13-biomes-2","13-biomes-3","13-biomes-4",
            "14-survivor-select","15-logbook","16-run-summary","17-artifacts"],
  "errorCount": 0,
  "perf": { "programs": 64, "geometries": 571, "textures": 50, "sceneObjects": 671 }
}
```

Per-shot from `shots/manifest.json`, checked individually rather than in aggregate:

```
ready true partial false errors []
shots 20 bad 0        # bad = any shot with frameErrors != 0, newErrors != [], or an error key
```

### `node tools/perf.mjs` — `combat-24`

```
run 1   frames 21   avg 46.59   median 22.6   p95 34.5
run 2               median 22.8
run 3               median 23.9
```

21–26 ms band, three for three. `HUD.update` is **0.117 ms** in the same run —
the new equipment section is a diffed read of one snapshot per frame and the
menus' viewers are not stepped while a run is live.

### All four survivors boot with their own loadout

Driven through the real UI — `menus.pickSurvivor(id)` then `menus.act('launch')`,
i.e. the Begin Run button — and read back off the live `ctx.player`:

```
ranger   ctx=ranger  player=ranger  mesh=ranger  hp=110 dmg=12
         slots [rangerDoubleTap, rangerPhaseRound, rangerTacticalDive, rangerSalvo]  == expected
anvil    ctx=anvil   player=anvil   mesh=anvil   hp=170 dmg=15
         slots [anvilSweep, anvilSlam, anvilBreach, anvilBulwark]                    == expected
kestrel  ctx=kestrel player=kestrel mesh=kestrel hp=90  dmg=17
         slots [kestrelMark, kestrelLance, kestrelVault, kestrelEclipse]             == expected
rook     ctx=rook    player=rook    mesh=rook    hp=135 dmg=11
         slots [rookRivet, rookMines, rookWard, rookTurret]                          == expected

previewMountedWhileOpen: true  (all four)
previewDisposedAfterLaunch: true  (all four)
logbook viewer up while open: true    disposed on Back: true
frameErrors: 0   lastFrameError: null

ALL FOUR SPAWN WITH THEIR OWN LOADOUT: true
CONSOLE ERRORS: 0
```

(Probe was `tools/_b3probe.mjs`, run twice and deleted afterwards; `git status
tools/` shows only `capture.mjs` modified.)

### The PNGs were looked at, and three framings were fixed by looking

1. **First `14`**: the portrait was ~9 % of the viewer height. The standoff solve
   multiplied where it should have divided. Rewritten as a proper vertical/
   horizontal half-angle solve with the aspect folded into the width term.
2. **First `15`**: shot on the Survivors tab — four rows in a thirty-two-em index,
   so three quarters of the column was empty, and the selected row was scrolled
   out of sight. Moved to the Monsters tab, added `scrollIntoView` on select, and
   fixed the invisible-children bounds that had the Golem at half size.
3. **First `16`**: the survivor would not die and the shot came back as gameplay
   with a full health bar. Measured rather than guessed —
   `ctx.combat.applyDamage` returned `dealt: 1000000` while `player.health`
   stayed at 307.2 and `player.shield` *rose* to its cap. `applyDamage`
   dispatches the `onDamaged` item hooks before it tests `health <= 0`, and with
   one of every item held something in that set restores the player inside the
   same call. The scenario now takes the real lethal-damage path first and falls
   back to the two bus events `Combat._kill` emits for a player only when a full
   inventory refuses it. Both branches produce a real committed run record.
4. **First `17`**: `0 ACTIVE`, because the scenario called `begin()` first and
   `Artifacts.setActive` had already latched. It now runs second in the capture,
   before any scenario dismisses the title — which is the same window a *player*
   has — and clears the selection after `freeze()` so the Tithe does not delete
   every chest out of `07-interactables`.

---

## 5. Round-4 critique defects closed

The round-4 critic left seven defects in area **E** (HUD/menus/CSS). All are fixed:

| ID | Defect | Fix |
|---|---|---|
| N1 | `.money` at 1.94:1 over a bright sky — translucent plate | Opaque plate + black keyline, like `.slot-name` |
| N2 | M1 slot 6 px out of register with its three siblings | `.abilities { align-items: flex-start }` — bottom-alignment was the cause |
| N3 | `PHASE ROU…` permanently truncated | Dropped `max-width: 100%` and `text-overflow`, stepped `.slot-name` to 0.62em. Reads `PHASE ROUND` in `06` |
| N5 | `HARD` at 2.09:1 — translucent clock plate | Opaque, same treatment |
| N6 | `+N` chip collides with the fifth pip | `margin-left: 4px`, `flex-wrap: nowrap` |
| N7 | Stack counts sit on their glyphs | `ART_CENTRE_Y` 0.41 → 0.38, `ART_RADIUS` 0.30 → 0.27, exactly as specified |
| N11 | Tougher Times / Repulsion Armor Plate near-collision | **Not fixed** — `data/items.js` is A2's, and the fix is a rivet row on the shield glyph |

---

## 6. Files touched

| file | status |
|---|---|
| `src/ui/Logbook.js` | **new** — `ModelPreview`, `visibleBounds`, `disposeTree`, `Logbook` |
| `src/ui/Menus.js` | survivor select, difficulty, artifacts, run summary, screen stack, keyboard/gamepad navigator |
| `src/ui/HUD.js` | equipment slot, per-survivor skill icons, `survivorChanged`, full-screen hide set |
| `src/ui/hud.css` | equipment slot, select/difficulty/artifact/logbook/summary styling, focus ring, six round-4 fixes |
| `src/ui/Tooltip.js` | `cardDef` instead of `ITEM_BY_ID` |
| `src/ui/Icons.js` | **additive** — `ABILITY_ART` (16 glyphs), `abilityArt`, `hexOf`, two art constants retuned. Nothing restructured; A2's 95 glyphs untouched |
| `src/core/Harness.js` | appended `survivorSelect`, `logbook`, `artifacts`, `runSummary`, `pinPreview` |
| `tools/capture.mjs` | +4 SCENARIOS entries |
| `shots/*.png` | 20 shots re-captured |

Nothing in `src/systems/`, `src/data/`, `src/entities/` or `src/world/` was
modified.

---

## 7. Left undone

1. **Artifact/difficulty selection is unusable from the pause menu** — B2's
   pre-run latch. The UI reports the refusal honestly; making it *work* needs an
   `armForNextRun` on `systems/Artifacts.js`. See §1.
2. **No "quit to menu" run commit.** B1 (§4) notes abandoning a run discards it
   and asks for `Progression.abandonRun()`. Quit still reloads the page, so a
   quit run is never recorded. Not mine to add.
3. **The logbook has no run-history tab.** `ctx.profile.runHistory()` is read for
   nothing today; the last 25 runs would make a natural seventh tab and were cut
   for scope.
4. **Item and equipment logbook entries have no 3D.** Orbs use a shared tinted
   icosahedron (A2 §8.5), so a per-item model viewer would show 83 identical
   shapes. They get their plate art instead.
5. **`survivors.js:isUnlocked(card, profile)` calls `profile.hasUnlock`, which
   B1's `Profile` does not have** — so it always returns `true`. Nothing broke,
   because the select screen calls `ctx.profile.isUnlocked('survivor', id)`
   directly. Someone who owns `data/survivors.js` should change that one line to
   `profile.isUnlocked('survivor', card.id)`.
6. **Typo in `data/abilities.js`**: Eclipse Round reads "**Seat** a heavy round"
   — visible in `14-survivor-select.png`. A1's file.
7. **N11 unfixed** (see §5) — `data/items.js` is A2's.
8. **Gamepad rumble and stick-scroll in the logbook index** are not implemented;
   navigation is D-pad/stick stepping only.
