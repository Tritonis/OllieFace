# Corruption Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two artifacts that modify the corruption economy — one accelerates it for players who want the chaos, one restructures the counterplay trade — completing the Phase 2 artifact clause of the launch design (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md` §1 counterplay: "Artifacts modify the economy; at least one accelerates it").

**Architecture:** Two cards in `src/data/artifacts.js` following the established rule that artifacts have no behaviour of their own — the other systems ask. `Artifacts` gains one gameplay question, `corruptionMods() -> { feed, refund }` (the `runMods()` idiom), and `Corruption` consults it at its two economy points: `feed` multiplies the amount, and the Voidtouched-kill refund handler multiplies the refund fraction. Both cards are always-on unlocks (`unlock: null`), so no challenge plumbing.

**Tech Stack:** Existing `ARTIFACTS`/`ARTIFACT_BY_ID` data (`src/data/artifacts.js`), `Artifacts` system (`src/systems/Artifacts.js`), `Corruption` (`src/systems/Corruption.js`), `MARKS` in `src/ui/Icons.js`, headless self-running tests per repo convention.

## Global Constraints

- Artifacts never reach into other systems; systems ask (`data/artifacts.js` docblock). The only new coupling is `Corruption` reading `ctx.artifacts?.corruptionMods?.()` — optional-chained, so every existing headless fixture without an artifacts stub keeps its exact behaviour (multiplier 1).
- **Zero shared-stream displacement:** neither card rolls anything; `corruptionMods` is pure arithmetic over `this.set`.
- Card ids are code and wire values (`has('maw')` reads at every consultation point; ids are persisted): `maw` and `atonement`, never renamed once shipped.
- `mark` must be a key into `ui/Icons.js` `MARKS` — an authored vector, never a text codepoint (the docblock's hard rule). Both new marks are added to `MARKS` in the same task as the cards.
- `unlock: null` = always-on; the `Artifacts.init` unlock/challenge cross-check must not warn for null-unlock cards (verify — the existing check is about drift between `unlock` ids and `UNLOCK_BINDINGS`).
- The consultation table in `data/artifacts.js`'s docblock gains one row per card — that table is the file's contract and it must not drift.
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code — fixture shape as `tests/corruption-system.test.mjs`.
- `npm test` and `npm run gate:elite` must stay green with no baseline regeneration.

---

### Task 1: The cards and the question — data, marks, `corruptionMods`

**Files:**
- Modify: `src/data/artifacts.js` (two cards + docblock table rows)
- Modify: `src/ui/Icons.js` (two `MARKS` entries)
- Modify: `src/systems/Artifacts.js` (`corruptionMods()`)
- Test: `tests/corruption-artifacts.test.mjs`

**Interfaces:**
- Consumes: existing `ARTIFACTS` card shape, `Artifacts.set` (the active-id `Set`), the `runMods()` cached-object idiom (`Artifacts.js:232-240`).
- Produces (Task 2 relies on these exact names):
  - Cards `maw` and `atonement` in `ARTIFACTS` (and thus `ARTIFACT_BY_ID`).
  - `Artifacts.corruptionMods() -> { feed, refund }` — `feed` 2 with `maw`, ×1.25 with `atonement` (composing to 2.5 with both); `refund` 5 with `atonement`, else 1.

- [ ] **Step 1: Write the failing test**

```js
// tests/corruption-artifacts.test.mjs
// Artifacts modify the corruption economy (launch spec §1): the Maw
// accelerates every feed, Atonement makes the refund generous and the feeds
// worse — and the cards obey the file's own rules (real marks, valid ids).
import { ARTIFACTS, ARTIFACT_BY_ID } from '../src/data/artifacts.js';
import { Artifacts } from '../src/systems/Artifacts.js';
import { MARKS } from '../src/ui/Icons.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the cards exist and obey the card rules');
{
  const maw = ARTIFACT_BY_ID.get('maw');
  const atone = ARTIFACT_BY_ID.get('atonement');
  ok(!!maw && !!atone, 'both cards registered');
  ok(maw.unlock === null && atone.unlock === null, 'always-on: no challenge plumbing');
  for (const c of [maw, atone]) {
    ok(typeof c.name === 'string' && typeof c.description === 'string' && typeof c.flavour === 'string', `${c.id} has its words`);
    ok(!!MARKS[c.mark], `${c.id}'s mark is an authored vector in Icons.js`);
  }
  const ids = ARTIFACTS.map((a) => a.id);
  ok(new Set(ids).size === ids.length, 'no id collisions');
}

console.log('corruptionMods answers the economy question');
{
  // Constructed, never init()ed: corruptionMods reads only `this.set`, and
  // init drags storage/profile that a headless test has no business building.
  const art = new Artifacts();
  const mods = (ids) => { art.set.clear(); for (const id of ids) art.set.add(id); return { ...art.corruptionMods() }; };
  const base = mods([]);
  ok(base.feed === 1 && base.refund === 1, 'no cards, no change');
  const maw = mods(['maw']);
  ok(maw.feed === 2 && maw.refund === 1, 'the Maw doubles every feed');
  const atone = mods(['atonement']);
  ok(atone.feed === 1.25 && atone.refund === 5, 'Atonement: generous refund, worse feeds');
  const both = mods(['maw', 'atonement']);
  ok(Math.abs(both.feed - 2.5) < 1e-9 && both.refund === 5, 'the two compose');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/corruption-artifacts.test.mjs`
Expected: FAIL — `maw`/`atonement` absent from `ARTIFACT_BY_ID`, `corruptionMods` undefined. (If `MARKS` is not the export name in `src/ui/Icons.js`, check the live file first and adjust the import — the artifact docblock names "`ui/Icons.js`'s MARKS".)

- [ ] **Step 3: Implement**

(a) In `src/data/artifacts.js`, append to `ARTIFACTS` after `evolution`:

```js
  {
    id: 'maw',
    name: 'Artifact of the Maw',
    description: 'The world corrupts twice as fast. Every greed act — every '
      + 'chest, item, shrine and credit — feeds the gauge double.',
    flavour: 'It was always hungry. You just started shovelling.',
    mark: 'maw',
    color: '#c72fd6',
    unlock: null,
  },
  {
    id: 'atonement',
    name: 'Artifact of Atonement',
    description: 'Hollowed kills return five times the corruption, but every '
      + 'greed act feeds a quarter more. The debt can be worked off; the '
      + 'interest cannot.',
    flavour: 'The void keeps a ledger, and it accepts payment in kind.',
    mark: 'atonement',
    color: '#9fd4ff',
    unlock: null,
  },
```

and extend the docblock's consultation table with:

```
 * | `maw`       | `Corruption.feed` via `corruptionMods()` |
 * | `atonement` | `Corruption.feed` + the Voidtouched-kill refund, via `corruptionMods()` |
```

(b) In `src/ui/Icons.js`, add two entries to `MARKS`, matching the existing entries' vector format exactly (open the file; each mark is an authored path/polyline set — author in the same style and viewbox):
- `maw`: an open jagged ring — a mouth of inward-pointing teeth (six to eight short wedges around a circle, gap at the top).
- `atonement`: a two-pan balance — one horizontal beam, a center post, two short pans hung by angled lines.

Keep both to the stroke/fill conventions the neighbouring marks use; no text codepoints.

(c) In `src/systems/Artifacts.js`, next to `runMods()` (same cached-object idiom — verify how `_mods` is initialised in the constructor and mirror it for `_corMods`):

```js
  /**
   * Multipliers on the corruption economy. `Corruption.feed` applies `feed`;
   * the Voidtouched-kill refund applies `refund`. Cached object, same reason
   * as `runMods`.
   */
  corruptionMods() {
    const m = this._corMods || (this._corMods = { feed: 1, refund: 1 });
    m.feed = (this.set.has('maw') ? 2 : 1) * (this.set.has('atonement') ? 1.25 : 1);
    m.refund = this.set.has('atonement') ? 5 : 1;
    return m;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/corruption-artifacts.test.mjs` — all arms PASS.
Run: `node reviews/round5/B2-artifacts.test.mjs` if it is part of `npm test` (check `package.json`); otherwise run `npm test` and confirm the artifacts-adjacent suites stay green.

- [ ] **Step 5: Commit**

```bash
git add src/data/artifacts.js src/ui/Icons.js src/systems/Artifacts.js tests/corruption-artifacts.test.mjs
git commit -m "Two new rules for the run: the Maw feeds the world, Atonement restructures the debt"
```

---

### Task 2: The consultation points — Corruption asks

**Files:**
- Modify: `src/systems/Corruption.js` (`feed` and the `kill` refund handler)
- Test: extend `tests/corruption-artifacts.test.mjs`

**Interfaces:**
- Consumes: `ctx.artifacts?.corruptionMods?.()` (Task 1) — optional-chained; absent artifacts system means multiplier 1 everywhere.
- Produces: `feed(player, amount)` returns and accrues `amount × mods.feed` (greed multiplier still applies on top, unchanged); a Voidtouched kill bleeds `world × VOIDTOUCHED.refund × mods.refund`.

- [ ] **Step 1: Write the failing test**

Append to `tests/corruption-artifacts.test.mjs` (before the exit-code footer):

```js
console.log('— consultation points —');
const { Corruption } = await import('../src/systems/Corruption.js');
const { VOIDTOUCHED } = await import('../src/data/corruption.js');

function makeCtx({ mods = null } = {}) {
  const listeners = new Map();
  const ctx = {
    authority: true,
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
  };
  if (mods) ctx.artifacts = { corruptionMods: () => mods };
  const c = new Corruption();
  c.init(ctx);
  return { ctx, c };
}
const P = () => ({ isPlayer: true, alive: true });

console.log('the Maw doubles every feed');
{
  const { c } = makeCtx({ mods: { feed: 2, refund: 1 } });
  const p = P();
  ok(c.feed(p, 10) === 20, 'feed returns the accelerated amount');
  ok(c.world === 20 && c.corruptionOf(p) === 20, 'and the ledgers carry it');
}

console.log('no artifacts system, no change — the fixture proves the default');
{
  const { c } = makeCtx();
  ok(c.feed(P(), 10) === 10, 'multiplier 1 when ctx.artifacts is absent');
}

console.log('Atonement multiplies the Voidtouched refund');
{
  const { ctx, c } = makeCtx({ mods: { feed: 1, refund: 5 } });
  const p = P();
  c.feed(p, 100);
  ctx.events.emit('kill', { victim: { affix: VOIDTOUCHED.affix }, source: p });
  const expected = 100 - 100 * VOIDTOUCHED.refund * 5;
  ok(Math.abs(c.world - expected) < 1e-9, 'five times the refund came back');
}

console.log('an ordinary kill still refunds nothing');
{
  const { ctx, c } = makeCtx({ mods: { feed: 1, refund: 5 } });
  const p = P();
  c.feed(p, 100);
  ctx.events.emit('kill', { victim: { affix: 'overloading' }, source: p });
  ok(c.world === 100, 'the multiplier gates on the Voidtouched affix as before');
}
```

- [ ] **Step 2: Run to verify the new arms fail**

Run: `node tests/corruption-artifacts.test.mjs`
Expected: FAIL — feed returns 10 under the Maw stub; refund unchanged by the mods stub.

- [ ] **Step 3: Implement**

In `src/systems/Corruption.js`:

(a) In `feed` (`Corruption.js:80`), apply the artifact multiplier before the greed multiplier line:

```js
    // The artifact economy question (data/artifacts.js: the Maw, Atonement).
    // Optional-chained: a fixture without an artifacts system pays face value.
    const mult = this.ctx.artifacts?.corruptionMods?.().feed ?? 1;
    const added = (this._greed ? amount * SOURCES.greedMult : amount) * mult;
```

(replacing the existing `const added = this._greed ? amount * SOURCES.greedMult : amount;` — the greed multiplier and every other line stay as they are).

(b) In the `kill` listener in `init` (`Corruption.js:64-68`), multiply the refund:

```js
    ctx.events.on('kill', ({ victim, source }) => {
      if (!victim || victim.affix !== VOIDTOUCHED.affix) return;
      const player = source && source.isPlayer ? source : ctx.player;
      const refund = this.ctx.artifacts?.corruptionMods?.().refund ?? 1;
      this.bleed(player, this._world * VOIDTOUCHED.refund * refund);
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/corruption-artifacts.test.mjs` — all arms PASS.
Run: `node tests/corruption-system.test.mjs && node tests/chest-void-credit.test.mjs && node tests/greed-marks.test.mjs && node tests/item-mutation.test.mjs` — every corruption-economy suite stays green (they build no artifacts stub, so the default-1 path covers them).
Run: `npm test` — full suite green.
Run: `npm run gate:elite` — green, no baseline regeneration (any diff is a real regression: stop).

- [ ] **Step 5: Verify live and commit**

Live (headless-probe if interactive play is impossible, following `tools/voidprobe.mjs` conventions): toggle the Maw in the artifact select, open one chest → the gauge moves double the tithe table's value. Record exactly which checks were performed and how. Verify the two cards render in the artifact select grid with their marks (no fallback glyphs, no baseline drift in the card grid).

```bash
git add src/systems/Corruption.js tests/corruption-artifacts.test.mjs
git commit -m "The economy takes the cards' answer: feeds and refunds ask the artifacts first"
```

---

## Self-review notes

- **Spec coverage (this slice):** "Artifacts modify the economy" ✓ (two cards, both touching only the corruption economy); "at least one accelerates it for players who want the chaos" ✓ (the Maw — more feeds means more blight, more Hollowed, more mutations, which IS the chaos); counterplay stays costly ✓ (Atonement buys its refund with a permanent feed surcharge). Deferred deliberately: an artifact that changes seed placement/blight growth (presentation-economy coupling belongs to the Phase 3 visual pass).
- **Type consistency:** `corruptionMods() -> { feed, refund }` produced in Task 1, consumed in Task 2 with the same field names; card ids `maw`/`atonement` identical across data, marks, and tests.
- **Known execution-time checks (deliberate):** the exact `MARKS` export name and entry format in `src/ui/Icons.js` (Task 1b — author to the live file's conventions); how `_mods` is initialised in `Artifacts`' constructor (mirror for `_corMods`, Task 1c); whether `Artifacts.init`'s unlock cross-check tolerates `unlock: null` (it must — verify, and if it warns, gate the check on `a.unlock` truthiness as part of Task 1); whether `reviews/round5/B2-artifacts.test.mjs` is in the `npm test` glob. The implementer verifies against live files.
