# C3 — the Edict chooser, shrine variety, and the shrine rename

Files touched, and nothing else: `src/systems/Artifacts.js`, `src/ui/Menus.js`,
`src/world/Interactables.js`, `src/systems/Progression.js`.

**Headline:** Artifact of the Edict is playable. Six shrine types ship, four of
them new. `Shrine of Chance` and `Shrine of Blood` are gone from every string a
player can read. `capture.mjs` shows the same four failing shots as the
baseline and no fifth — measured in an isolated worktree, because the shared
tree currently carries twelve files of other agents' in-flight work and cannot
attribute anything.

---

## 0. Where every number below comes from

The shared working tree has **16 modified files** from six parallel agents. A
capture of it is uninterpretable, so every claim here was measured in a
throwaway `git worktree` at `fba0a91` — the exact commit `BASELINE.md` names —
with **only my four files** copied in on top (`git status` in that worktree
showed exactly those four as `M`, and nothing else).

Three captures are on disk. All three are seed 1337, 1600x900, clock pinned.

| directory | tree | purpose |
|---|---|---|
| `reviews/round6/ui/iso-base/` | clean `fba0a91` | the control, captured on this machine |
| `reviews/round6/ui/iso-final/` | `fba0a91` + my four files | the claim |
| `reviews/round6/ui/mixed-tree/` | the shared working tree | recorded, **not** cited |

`reviews/round6/ui/probe-edict-shrines.mjs` is the functional probe every
mechanic number below was printed by. It was run inside the worktree and is
kept here rather than in `tools/` because `tools/` is not my file to add to.

**Port note:** the brief specified `--port 5207`; that port was already in use
by another agent's `artifactprobe`. Captures ran on 5261/5262 and the probe on
5263. The port is not an input to any measurement.

### The control reproduces the documented baseline exactly

`reviews/round6/ui/iso-base/manifest.json`: `ready: true`, `partial: false`,
`clockPinned: true`, `subjectsOk: false`, failing shots
**`04-combat`, `08-explosion`, `09-survivors`, `11-bestiary`** — the four in
`BASELINE.md`, with the same subjects. That is what makes the comparison
below worth anything.

### The result

`reviews/round6/ui/iso-final/manifest.json`: `ready: true`, `partial: false`,
`clockPinned: true`, summed `frameErrors` across all 21 shots **0**, failing
shots **`04-combat`, `08-explosion`, `09-survivors`, `11-bestiary`**.

**Identical shot set. 4 -> 4. No fifth failure.** One subject moved in my
favour and I am not claiming it as a win: `08-explosion` fails on
`monsters standing in it` in both runs, and additionally on `damage numbers` in
the control but not in mine. That is a downstream shift, not a fix, and the
shot still fails.

---

## 1. What the shared tree shows, and why it is not my number

For completeness, since anyone re-running `capture.mjs` in the working
directory today will see it: `reviews/round6/ui/mixed-tree/manifest.json` fails
**five** shots — `04-combat`, `06-loaded-hud`, `08-explosion`, `10-inventory`,
`11-bestiary` — and `09-survivors` passes. Neither addition is mine:

- `10-inventory` fails a **DOM** check, `{"shown": 83, "items": 92}`. The build
  has grown from 83 items to 92 in `src/data/items.js` — another agent's file,
  explicitly listed as such in my brief — and the HUD strip renders 83 of them.
  Nothing in my four files creates or renders an item.
- `06-loaded-hud` fails `monsters under load` on separation, in a frame whose
  measured `lum` is 143.7 against `bgLum` 110.3. My four files add no light, no
  post, and no monster material.

I did not chase either. They belong to the agents who own those files.

---

## 2. Job 1 — the Edict

### 2.1 The shape of the problem

`Items.rollItem` is **synchronous** and is the single funnel every random item
id in the game comes out of: chests, multishop terminals, the Auric Cairn, the
boss drop, Tithe's corpses, the hidden realms' props. `Artifacts.commandPick`
is called from inside it and must return an id on the same tick.

A picker that resolves asynchronously cannot answer that. A per-drop modal
would therefore mean either blocking the simulation inside a roll, or teaching
six call sites to defer — and the deferred ones have no screen to raise anyway,
because "a mite died and paid an item under Tithe" is not a moment you can
interrupt someone at. On top of that, `src/systems/Items.js` is another agent's
file this wave, so the deferral could not be written even if it were right.

So the chooser is a **standing order**, not a modal: the player says in advance
what they want out of each tier, and every funnel resolves to it instantly and
identically. `Artifacts.commandPick` consults, in order, the edict -> the
pre-existing `_chooser` hook -> the original "whatever you hold most of"
policy. The ordered id is validated against the live pool on every call, so an
order restored from `localStorage` naming an item a later build removed
degrades to the policy rather than to a null drop.

### 2.2 Authority model — why a client cannot desync the item stream

Three independent reasons, in order of how much I trust them:

1. **The read is behind the authority gate already.** `commandPick` is
   reachable only through `Items.rollItem`, whose first line is
   `if (!this.ctx.authority) return null;`. A client never executes a single
   line of the edict's read path.
2. **The write consumes nothing.** `setEdict` is one `Map.set` plus a
   `localStorage` write. It touches no system, emits one cosmetic event, and
   draws from neither `ctx.rng` nor `ctx.fxRng`.
3. **Measured.** The probe recorded `ctx.rng.s` (the xorshift state word), ran
   **25** `rollItem('common')` calls under an active edict, and re-read it:
   `rngUnmoved: true`. Command's pick advances the shared gameplay stream by
   zero steps, which is exactly the property `ctx.rng.pick(pool)` does not
   have. All 25 returned the ordered id (`distinct: ["predatory"]`).

`setEdict` is deliberately **not** gated on `live`, unlike `setActive`. An
artifact set that changes mid-run makes the run unreadable; an edict is not a
rule, it is an instruction to a rule that is already running, and re-aiming it
as the run teaches you what you need is the whole artifact.

**The gap, stated plainly.** In co-op a client's edict has **no effect** — the
host's edict decides for the whole party. There is no client->host channel to
carry it: `src/net/Protocol.js:36-44` is seven button bits and movement, and
`src/net/` is not my file this wave. Rather than let a guest believe otherwise,
the screen says so in words. Probe output, verbatim:

> "You are a guest. The host's edict decides what the whole party finds; yours
> is kept but not consulted this session."

### 2.3 Pause, or not

**It pauses.** `Menus.open()` sets `ctx.paused` and releases pointer lock for
every screen in the build, and the Edict goes through that same path rather
than inventing a second modal regime.

The reason it is allowed to is that **it is not an interrupt**. Nothing raises
this screen — drops resolve instantly from the order already on file, so the
player opens it deliberately, between fights, the way they open the pause menu.
A panel carrying a five-tier rail and 28 tiles cannot be read while dodging, so
the alternative was not "don't obscure the action", it was "a corner picker for
83 items", which is the *invent a second visual language* failure the brief
warns against.

Consistency caveat I am not hiding: pausing on a client freezes that client's
own prediction while the host keeps simulating. That is true of the existing
pause and settings screens too — I inherited the behaviour, I did not introduce
it — and it is one more reason the guest note above matters.

### 2.4 Getting to it

- **`C`** from the world. Bound only while Command is active, so the key stays
  free in every other run.
- **Pause menu**, second entry.
- **Artifacts screen** footer, so the order can be filed before the drop.

All three are hidden *and* `disabled` when Command is off (`disabled` because
`navTargets()` filters on it, and a hidden-but-focusable button is a dead stop
in the keyboard ring). The artifacts screen re-syncs them on every render, so
toggling Command on reveals the entry immediately — that was a real defect the
probe caught, fixed in `renderArtifacts`.

### 2.5 Axis 7

Against `reviews/round5/critic-r3-ui-vfx.md`, which has now rejected UI three
times:

| what it rejected | what this screen does |
|---|---|
| Unicode codepoints rendering from OS fallback fonts, putting four sibling titles on three baselines (defect at `.art-mark`) | every glyph is an `itemArt` `<img>` in a **fixed 34px box**; the icon is `grid-row: 1 / span 2` so nothing about it can move the title's baseline |
| `<button>` UA vertical centring pushing cards off each other's baselines | `.eitem` and `.etab` are `display: grid` with explicit rows — the UA never centres |
| "the one browser default in the product": the logbook's bare UA scrollbar, 6px at L65 on an invisible L13 track, flagged in **rounds 1, 2 and 3** | `.edict-grid` styles `scrollbar-width`/`scrollbar-color` **and** the four `::-webkit-scrollbar` pseudos |
| `15-logbook`'s model viewer 92.7% empty | the pane is a five-row rail plus a `minmax(15em, 1fr)` auto-fill grid; there is no fixed box to leave empty |
| `16-run-summary` abandoning tier grouping while the HUD keeps it | the rail **is** the tier grouping — one tier at a time, each tab and its tiles carrying that tier's own accent |

Everything is drawn from tokens `hud.css` already declares — `--u`, `--ink`,
`--ink-dim`, `--ink-faint`, `--line`, the six `--t-*` tier colours — plus the
same `clip-path` corner notch, the same `border-left` accent rule, and the same
corner chip idiom `.art.is-locked::after` uses, inverted from LOCKED to
ORDERED. Hierarchy is one large line (`.estand-v`, 1.7em, tier-accented, the
only sentence on the screen) over a dense uniform grid.

**Deviation, flagged for whoever owns `hud.css`:** the stylesheet is injected
from `Menus.js` as a `<style id="petrichor-edict-style">`, because `hud.css` is
not in my file list this wave and a screen shipping without rules renders as UA
boxes. It is idempotent and it is a verbatim cut-and-paste into `hud.css` with
no rewriting. Two rules are two classes deep (`.panel.panel--edict`) precisely
because a runtime-appended sheet may land either side of `hud.css` in the
cascade and must not tie on specificity.

### 2.6 Measured, from `probe-edict-shrines.mjs`

| | |
|---|---|
| screen opens, `ctx.paused` | `true`, `true` |
| tier tabs / tiles for `common` | `5` / `28`, against `ITEMS_BY_TIER.common.length` = `28` |
| injected sheet actually applied | `styleInjected: true`; computed `.panel--edict` width **880px** (not the UA default) |
| ordered tile carries the tier accent | computed `border-left-color` **`rgb(230,236,244)`** = `#e6ecf4`, the common tier colour |
| click a tile through the real delegated handler | files `ukulele`, expected `ukulele` |
| click the same tile again | revokes — `edictFor('uncommon') === null` |
| survives the reload that starts a run | `petrichor.run.v1` -> `{"edict":{"common":"predatory"}}` |
| a stale/removed id | falls back to the policy, drop is non-null |
| Back from a `C` press | returns to the run: `screen === null`, `ctx.paused === false` |
| page errors across the whole probe | `[]` |

---

## 3. Job 2 — shrines

Two shipped. Both were a purchase: the Cairn buys a lottery ticket with gold,
the Font buys gold with health. A third purchase would be a reskin, so each new
one commits a **different resource on a different timeline**, and only the
inherited Cairn is a coin flip.

| shrine | you spend | you get | when the risk lands |
|---|---|---|---|
| **Auric Cairn** *(renamed)* | gold, +40% per use, 3 uses | 1-in-4 an item | at the press |
| **Ichor Font** *(renamed)* | 40% of your health, 2 uses | gold | at the press |
| **Hollow Chime** *(new)* | nothing | **2 guaranteed** drops | **up front** — a bounded ambush arrives and you clear it first |
| **Gilded Snare** *(new)* | nothing | 1 good drop, immediately | **later** — an elite spawns pointed at you and follows you off the site |
| **Fallow Vault** *(new)* | your **whole purse** | 2.2x of it | **next stage**, and only if you reach it |
| **Marrow Kiln** *(new)* | one item, permanently | a large purse | **never** — it is certain, named in advance, and irreversible |

The Chime and the Snare are deliberately the same ledger in opposite order.
"Clear it and collect" and "collect and then live with it" are different
decisions even when they balance identically, and the pair is what stops the
combat shrine from being one idea.

Design notes on the two that could have gone wrong:

- The **Kiln** always burns the *lowest tier you hold most of*, resolved by a
  total order (tier rank, then count, then id) so the prompt names the item
  before you press E. A shrine that eats something you did not expect to lose
  is not a risk, it is an invisible bug. Probe:
  `"Marrow Kiln (burn 1x Soldier's Syringe for $94)"`, and it took exactly that.
- The **Vault**'s 2.2x has to beat the 1.25x-per-stage price inflation, because
  the real cost is a whole stage of purchases and a whole stage of item
  compounding forgone. A return that merely kept pace would be a strictly worse
  version of standing still. It is also **not** a reskin of banking gold, which
  carries over for free: a run that ends before the next stage begins leaves the
  money in the ground.
- The Kiln is not the hidden realms' **Refinery** (`RealmProps.js:333`). That
  one spends *gold* to upgrade a *random* held item a tier. The Kiln spends no
  gold, picks deterministically, names its victim, and pays currency rather
  than an item. I checked before writing it, having nearly shipped the reskin.

### 3.1 Reading them at 60 metres

The brief's bar: a shrine you cannot identify before walking to it has failed.
So **silhouette carries the identification and hue only confirms it**. Every
one of the six is a different *shape class* — rendered flat black they are still
six objects:

| shrine | shape class | hue |
|---|---|---|
| Auric Cairn | tall spike cluster on a stepped plinth | amber `#ffd23f` |
| Ichor Font | spike standing in an **open basin** | red `#d02f3e` |
| Hollow Chime | **the only outline with a hole in it** — an arch and lintel with a bell hanging in the gap | cold blue `#9fd4ff` |
| Marrow Kiln | **the only solid unbroken mass** — a stout chimney flaring to an ash cowl | ember `#ff5a12` |
| Gilded Snare | **the only sphere** — eight barbed ribs closed over a visible orb | magenta `#ff3fa0` |
| Fallow Vault | **the only one under waist height** — a part-sunk coffer, no lit offering, four short marker posts | dull gold `#b98a2e` |

Six hues spread across the wheel, but the hue is the confirmation, not the
read — that is deliberately the inverse of what `18-difficulty`'s three icons
do, which the round-3 critic scored a 4 on axis 4 for differing "mainly by hue".

The Snare shows the reward through the ribs from any bearing, so the trade is
legible without a tooltip. The Vault's marker posts exist only because a 1.0m
prop disappears into terrain at range; they put a readable vertical tick on the
horizon without pretending the vault is an altar.

Two materials notes, both following the file's existing rules rather than
inventing: the bell is a **smooth-shaded lathe** for the same reason
`bloodSlickGeo` is — a profile that sweeps its normal elevation continuously
contains the half vector for *any* sun/camera pair, so the highlight is a
property of the material rather than a coincidence of which facet lines up. And
the Vault's slot and the Kiln's fire are **per-instance** materials, not
`glowMat()`: that cache is shared stage-wide, and dimming a spent shrine
through it would dim every one of them. `IchorFont` calls out that exact trap.

### 3.2 Per-stage counts — and the RNG-stream trap I walked into

`_populateShrines` draws **without replacement** from a weighted bag: no stage
ever carries the same shrine twice, because a stage whose only shrine is the one
you have already decided about is a stage with no shrine on it. Capped at
**three** however deep the run goes — a field of six altars is a menu, not a
place. The Kiln and Vault are out of the bag on stage 0 (nothing to burn,
nothing to hold); the Snare is too, because leaving an elite alive behind you is
a different proposition in the first ninety seconds than at minute twenty.

**This is where the first attempt broke three shots, and it is worth recording
properly.**

The first version took one `ctx.rng.next()` per shrine. `ctx.rng` is one shared
sequence, so every draw taken in `populate` displaces every draw taken after it
— director spawn points, camera searches, everything, on this stage and every
later one. Measured against `iso-base`, that version failed **seven** shots:
the baseline four plus **`05-boss`, `06-loaded-hud`, `10-inventory`**, none of
which has anything to do with shrines. This is the same class of breakage the
handoff records as *"`archGeo` shifted the shared RNG stream"*.

The fix, and the reason the final number is 4:

- The **type** choice draws from a private `RNG` seeded from
  `(ctx.seed, stageIndex)`. Nothing is lost — `populate` runs on the host only
  (a client's props are replicated, never regenerated; see `Progression`'s
  `stageStart` handler), so this sequence was never something two peers had to
  agree on.
- The **gate** draws are byte-identical to the code they replace: the same two
  `ctx.rng.next()` calls, same order, same 0.7 / 0.5 thresholds, with `_sited`
  called in exactly the same places. For stages 0-2 this method's consumption
  of the shared stream is unchanged. Only the third shrine, from stage 3 on,
  adds a draw.

Probe evidence over stages 0-9, seed 1337:

```
0 [AuricCairn]                     5 [FallowVault, HollowChime]
1 [GildedSnare]                    6 [FallowVault]
2 [FallowVault, MarrowKiln]        7 [GildedSnare, AuricCairn]
3 [IchorFont]                      8 [AuricCairn]
4 [MarrowKiln]                     9 [GildedSnare, AuricCairn, MarrowKiln]
```

`maxOnAStage: 3` · `anyDuplicateOnAStage: false` · all six types appear ·
`deterministic: true` (populating stage 5 twice yields the identical set).

### 3.3 Mechanics, measured

| shrine | probe |
|---|---|
| Kiln | prompt named `Soldier's Syringe`; took exactly 1 of that stack; paid **$94** |
| Vault | `commit $400 -> returns $880`; gold 400 -> **0**; `progression.vault = {payout: 880, dueStage: 1}`; after `advanceStage()` gold **880** and the vault cleared |
| Chime | summoned **6**, state `ringing`, prompt flips to `Hollow Chime — answer it`, **0** orbs while ringing; on clearing all six, **2** orbs and state back to `ready` |
| Snare | **1** orb immediately, **1** elite added to the field |

The Chime tracks its ambush by `(Enemy, Enemy.id)` pairs, not bare references.
`Enemy` instances are pooled and recycled, so a corpse can come back as
something else and start reading `alive` again; `Enemy.id` is stamped fresh
from a monotonic counter on every `spawn`, so the pair is the only honest
identity. It also refuses the press outright if the director can place nothing,
rather than consuming a use and paying nothing.

### 3.4 Co-op wiring

All four new shrines get `TYPE_ID` values (9-12, appended, never renumbered)
and `VIEW_BUILDERS` entries, so a client renders them. `AuricCairn` and
`IchorFont` keep wire values **3 and 4** — only the *keys* were renamed, and the
comment in `Interactables.js` says why. Every payout path is host-only, either
because `requestInteract` gates on `ctx.authority` or, for the Chime's deferred
payout inside `update`, because I gate it explicitly. The Vault's carry lives on
`Progression` and settles in `_beginStage`, which is host-only, and reaches
clients as the `goldChanged` event `NetHost` already forwards.

---

## 4. Job 3 — branding

Renamed in `src/world/Interactables.js`:

| was | is | why |
|---|---|---|
| `Shrine of Chance` (`:578`, the string on the branding ledger) | **Auric Cairn** | verbatim RoR2 |
| `Shrine of Blood` (`:674`) | **Ichor Font** | verbatim RoR2, and on the brief's do-not-use list |
| class `ShrineOfChance` / `ShrineOfBlood` | `AuricCairn` / `IchorFont` | |
| `TYPE_ID.shrineChance` / `.shrineBlood` | `.auricCairn` / `.ichorFont` (values 3, 4 unchanged) | |

The brief only mandated the Cairn. The Font was renamed too because
`Shrine of Blood` is on the brief's own banned list and I was already in the
file; leaving it would have shipped one renamed shrine standing next to an
un-renamed one.

None of the four new names uses `Shrine of ...`, and none is on the banned
list. The register target was the project's own original work — Chitter Mite,
Cinder Harrier, Silt Burrower, Aegis Warden, Grave Acolyte, Pyre Matron,
Verdant Maw — so all six are two-word, concrete, faintly archaic, and none uses
a possessive or a preposition: Auric Cairn, Ichor Font, Hollow Chime, Gilded
Snare, Fallow Vault, Marrow Kiln. Second nouns are all distinct, and no word is
reused from the enemy roster (`Ossuary`, `Pyre`, `Cinder`, `Silt`, `Verdant`,
`Aegis`, `Grave` were all checked and avoided).

Verified by grep over `src/`, `tools/`, `docs/` and the root `*.md`: **no
player-facing `Shrine of ...` string remains anywhere in the build.**

### References I could not reach

| file:line | what | why not |
|---|---|---|
| `src/systems/Items.js:61` | code comment, `// Small chest / shrine of chance: the default ladder.` | another agent's file this wave. Comment only, invisible to players. One-word edit for whoever lands next. |
| `src/systems/Combat.js:330` | doc comment, `true for true-damage effects like Shrine of Blood` | outside my four files. Comment only. |
| `src/world/realms/RealmProps.js:26,313,379,444` | `TYPE.shrineChance` / `TYPE.shrineBlood` | realms is another agent's area. These are **internal identifier keys in a separate TYPE table**, not display strings — the realm props' own prompts read `Refinery`, etc. No player-facing text. |
| `'shrineBlood'` / `'shrineWin'` / `'shrineFail'` audio keys | audio cue ids, several files | internal ids, never displayed. The new shrines reuse them rather than adding cues, since `Audio.js` is not mine. |

I did **not** touch the wider branding job — the ~40 RoR2 item names,
`Hopoo Feather`, the three difficulty rungs, `Newt Altar`, `Rallypoint`. Those
are sequenced in `BRANDING-LEDGER.md` behind agents who own those files, and the
difficulty rungs in particular are asserted by a harness shot another agent is
mid-fix on.

---

## 5. What I did NOT verify

Stated plainly, because five fix claims died in round 5 on exactly this.

1. **No two-peer co-op test was run.** None has ever been run under
   `PROTOCOL_VERSION 2`. Everything I say about co-op above is read off
   `NETCODE.md` and the authority gates in source — I have *reasoned* that a
   client cannot desync the item stream and I have *measured* that the pick
   consumes no RNG, but I have not put two peers on a wire. The four new
   `TYPE_ID` values and their `VIEW_BUILDERS` are untested against a real
   snapshot; a client has never rendered one of these shrines.
2. **No visual measurement of the new shrines.** I claim six distinct
   silhouettes and six separated hues from the geometry and the material
   values. I did **not** decode a pixel of any shrine — none of the 21 harness
   shots frames one, and adding a scenario means editing `Harness.js`, which is
   another agent's file this wave. The "readable at 60m" requirement is
   therefore *designed for and argued*, not *demonstrated*. It needs a shot.
3. **No visual measurement of the Edict screen either.** Its numbers above are
   DOM and `getComputedStyle` reads, which prove the sheet applied and the
   layout is what I wrote — they do not prove it looks good. Axis 7 needs a
   critic on a PNG, and `capture.mjs` has no scenario that opens it.
4. **Balance is untuned.** The Vault's 2.2x, the Kiln's tier values, the
   Chime's `4 + min(5, stage) + 2*uses` ambush size and the Snare's elite count
   are first-pass numbers reasoned from the existing curves. Nobody has played
   a run with them.
5. **The mixed working tree was never made green.** My isolation proves my four
   files add nothing; it does not tell anyone what the tree will read once the
   other six agents land. Somebody has to re-run `capture.mjs` on the merged
   result, and the `10-inventory` `83 of 92` gap is waiting there for whoever
   owns the HUD strip.
6. **Environment incident, for the next agent.** Part-way through this session
   `node_modules/rolldown/dist/shared/rolldown-binding.win32-x64-msvc.node`
   went missing and every build died with *"Cannot find native binding"* — the
   failure mode `HANDOFF.md` attributes to `npm install`. **No `npm install`
   was run.** The package copy under
   `node_modules/@rolldown/binding-win32-x64-msvc/` was intact, so the recovery
   was a one-file copy into `rolldown/dist/shared/`, not a reinstall, and the
   lockfile was never touched. Build is green at the time of writing. Worth
   trying that copy before reaching for `npx -y --package=npm@11 -- npm install`.
   (One `npx vite build` was attempted early on, before I switched to
   `node node_modules/vite/bin/vite.js build`; it failed with `EPERM` inside the
   **npx cache**, not the project. I cannot rule it out as the cause and I am
   recording it rather than guessing. Use the local binary.)
7. **`_defaultPick` behaviour under an empty inventory** is unchanged and
   untested by me: it returns `pool[0]`, which for `common` means the same item
   every time until you hold something. That is inherited, deterministic and
   documented, but it does mean a fresh Command run with no edict filed pays
   the same white four times before the policy has anything to work with.
