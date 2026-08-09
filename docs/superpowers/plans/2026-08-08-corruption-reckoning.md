# Corruption Reckoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corruption gets a real price and a real exit — void pressure outscales its reward, world corruption feeds the Director, staying clean is achievable and pays something greed can't buy — and band changes become announced moments instead of drifts (fixing the playtest's "I didn't notice the voice / the sky" and "the font did nothing").

**Origin:** 2026-08-08 playtest (user ran band 4 from mid-stage-1): void layer inaudible (tones authored two octaves below their own bandpass), sky/fog shift unnoticed (gradual onset, no announced moment), Argent Font negligible (flat 30 bleed vs unbounded world), greed strictly optimal (Voidtouched kills pay gold/XP + refund; mutations are buffs; void route has the best loot). User-chosen direction: void pressure outscales reward + world corruption feeds difficulty + clean-route exclusivity, with a viable path to stay clean. Mutations keep their current upside (explicitly not chosen).

**Architecture:** All tuning lands in `src/data/corruption.js` as exported constants. The Audio system gets a rebuilt void-layer graph (tones routed around the bandpass) plus a `corruptionBand`-driven sting; Blight gets a transition snap (fast blend window + pipeline pulse). The Voidtouched economy changes ride the existing funnels: `Items.killReward` (one multiplier), `Corruption`'s kill-refund listener (one constant), `Director.updateDifficulty` (one additive term). Clean-route exclusivity reuses the Artifacts unlock machinery shipped in the corruption-artifacts slice: a victory ending at band ≤ 1 records a profile fact that unlocks a new artifact, Vigil, whose `corruptionMods` make clean play easier.

**Tech Stack:** WebAudio (follow `src/systems/Audio.js` house idioms), existing events (`corruptionBand`, `runEnded`-equivalent — verify live name), `Artifacts` corruptionMods hooks (`src/systems/Corruption.js` consumes `{ feed, refund }`).

## Global Constraints

- **RNG discipline is the sharpest edge in this slice.** Tasks 3-5 touch gameplay paths. Any new `ctx.rng` draw or skipped draw that occurs at corruption 0 breaks `tests/sp-equivalence.mjs` — that gate must pass with ZERO baseline changes. Corruption-gated logic may add draws **only** on code paths that require band ≥ 1 (the equivalence scenario runs pristine). State this in every touched function's comment.
- All new tuning values are exported constants in `src/data/corruption.js` — tests pin them, designers turn them.
- Host authority: every gameplay change gates on `ctx.authority` exactly as the code it modifies already does; clients learn results from replicated events.
- One-way rule unchanged: presentation reads corruption, never the reverse.
- Tests: `tests/<name>.test.mjs`, self-running, `ok()` + exit code, LCG fixtures — extend the suites that already cover each touched system (`corruption-system`, `corruption-counterplay`, `voidtouched-director`, `corruption-artifacts`, `corruption-audio`, `blight-ceiling`) rather than inventing parallel ones, except where a new file is named below.
- Bash tool is ASCII-only in this environment; non-ASCII content goes through Write/Edit.
- The plan's numbers are playtest dials. Implementers transcribe them exactly; the closing task's probe records the resulting feel-numbers so the next playtest argues against data.

---

### Task 1: The corruption voice becomes audible, and band changes get a sting

**Files:**
- Modify: `src/systems/Audio.js`
- Test: extend `tests/corruption-audio.test.mjs`

**Interfaces:**
- Consumes: `corruptionBand { band, prev }` event; the existing void-layer node block (built in `_buildAmbient`-adjacent init code — find `voidGain` in the live file) and `VOID_LAYER` exports.
- Produces (later tasks / tests rely on): `VOID_LAYER = [0, 0, 0.05, 0.10, 0.16]`; `voidLayerGain(band)` unchanged in shape; `bandSting(band, prev)` method on Audio; `this._stingReady` guard.

- [ ] **Step 1: Write the failing tests** — extend `tests/corruption-audio.test.mjs`:

```js
console.log('void layer curve, re-priced against master with tones in-band');
{
  ok(VOID_LAYER.length === 5, 'five bands');
  ok(voidLayerGain(0) === 0 && voidLayerGain(1) === 0, 'silent through band 1');
  ok(voidLayerGain(2) === 0.05 && voidLayerGain(3) === 0.10 && voidLayerGain(4) === 0.16, 'audible-at-the-mix-floor values');
}
```

And a graph-topology block using the stub-AudioContext pattern this file already has from the blight-ceiling fix wave (read the live test first — it builds a recording stub and inspects edges). Assert: (a) the two oscillators' gain nodes connect to `voidGain` **directly**, not through `voidFilter` (the playtest root cause: 523/740 Hz tones through a 2400 Hz Q1.4 bandpass are −25 dB — inaudible by construction); (b) the noise source still routes through `voidFilter`; (c) after constructing Audio and calling `init`, emitting `corruptionBand { band: 2, prev: 1 }` on the ctx events stub calls into a sting (observable as new oscillator starts on the stub within the handler — count node creations before/after the emit).

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `node tests/corruption-audio.test.mjs` — new blocks FAIL (old VOID_LAYER values, tones still filtered, no sting).

- [ ] **Step 3: Rewire the void layer** — in the void-layer block in `Audio.js`:
  - Route each tone's gain node straight to `voidGain` (`g.connect(voidGain)` instead of `g.connect(voidFilter)`); the noise bed keeps its `bandpass -> voidGain` path. Update the block comment: the filter shapes the *noise* only; the tritone pair is the audible identity and must not pass through it.
  - Drop the tone gains slightly since they now bypass the filter: `[[523.25, -14, 0.20], [739.99, 11, 0.15]]`.
  - Update `VOID_LAYER` to `[0, 0, 0.05, 0.10, 0.16]` with a comment: re-priced after the 2026-08-08 playtest — the old master-bus values were below the combat mix floor.

- [ ] **Step 4: Add the sting** — a method following the house one-shot idiom (`stageSting` / `bossHorn` are the models — read one and match its `_ensure`/`_take`/`_tone` usage):

```js
  /**
   * A band crossing is a moment, not a drift (2026-08-08 playtest: the world
   * state changed under the player and nothing announced it). Ascending: a
   * low boom under a tritone pair — the void layer's own interval, so the
   * sting teaches the drone's meaning. Descending: the pair resolves to a
   * fifth, the one consonance in the corruption voice.
   */
  bandSting(band, prev) {
    const ac = this._ensure();
    if (!ac || !this._take(4, true)) return;
    const t = ac.currentTime;
    const up = band > prev;
    if (up) {
      this._tone(t, 0.9, { type: 'sine', f0: 55 + band * 8, gain: 0.5, attack: 0.005 });
      this._tone(t + 0.06, 0.8, { type: 'triangle', f0: 523.25, gain: 0.16, attack: 0.01 });
      this._tone(t + 0.06, 0.8, { type: 'triangle', f0: 739.99, gain: 0.13, attack: 0.01 });
    } else {
      this._tone(t, 0.6, { type: 'sine', f0: 523.25, gain: 0.12, attack: 0.01 });
      this._tone(t + 0.10, 0.7, { type: 'sine', f0: 784.0, gain: 0.12, attack: 0.01 });
    }
  }
```

  (Adapt the `_tone` option names to the live helper's actual signature — the snippet above matches the `heal`/`shieldBreak` usage shown at `Audio.js:971-991`; verify `attack` and `f0` are the real keys.) Wire it in `init` next to the other event subscriptions (find how Audio subscribes to events — if it doesn't yet, subscribe the same way Blight does: `ctx.events.on('corruptionBand', (e) => this.bandSting(e.band, e.prev))`). Band 0↔1 transitions sting too — the sting is the announcement the gauge alone wasn't.

- [ ] **Step 5: Run tests**

Run: `node tests/corruption-audio.test.mjs` and `npm test` — green.

- [ ] **Step 6: Commit**

```bash
git add src/systems/Audio.js tests/corruption-audio.test.mjs
git commit -m "The voice moves out of its own filter's shadow, and every band change announces itself"
```

---

### Task 2: Band changes get a visible moment

**Files:**
- Modify: `src/systems/Blight.js`
- Test: extend `tests/blight-ceiling.test.mjs`

**Interfaces:**
- Consumes: the existing `corruptionBand` handler in `Blight.init`, `_grade`'s settle machinery, `ctx.pipeline.vignetteBoost` / `ctx.pipeline.aberration`.
- Produces: `SNAP = { window: 1.6, rateMult: 5, vignette: 0.45, aberration: 0.0035 }` exported; constructor state `this._snapT = 0`.

- [ ] **Step 1: Write the failing test** — append to `tests/blight-ceiling.test.mjs`:

```js
console.log('a band crossing snaps instead of drifting');
{
  const { SNAP, GRADE_BLEND } = await import('../src/systems/Blight.js');
  ok(SNAP.window > 0 && SNAP.rateMult > 1, 'snap constants exported');
  const ctx = makeCtx();               // reuse the file's helper (env + fog + grade pass)
  // ...build env/fog exactly as the Task-4 sky suite in this file does...
  const b = new Blight();
  b.init(ctx);
  ctx.events.emit('corruptionBand', { band: 4, prev: 3 });
  ok(ctx.pipeline.vignetteBoost >= SNAP.vignette, 'crossing spikes the vignette floor immediately');
  // Blend speed: within SNAP.window seconds the sky weight must reach what the
  // un-snapped settle would need ~GRADE_BLEND to reach.
  let t = 0;
  while (t < SNAP.window) { b.update(ctx, 1 / 60); t += 1 / 60; }
  ok(b._skyW > 0.90, `sky weight ${b._skyW.toFixed(3)} > 0.90 within the snap window (unsnapped GRADE_BLEND=${GRADE_BLEND}s reaches ~0.97 only at full time)`);
}
```

(Adapt the env/fog scaffold from the existing sky suite in this file — same stubs, band 3 pre-seeded via a first emit + settle if needed so the crossing is 3→4.)

- [ ] **Step 2: Run to verify it fails** — `node tests/blight-ceiling.test.mjs`.

- [ ] **Step 3: Implement** — in `Blight.js`:

```js
/**
 * A band crossing is announced, not discovered (2026-08-08 playtest). For
 * SNAP.window seconds after a crossing the grade/sky settle runs at
 * SNAP.rateMult speed — the world lurches to its new state — and the pipeline
 * takes a one-frame vignette + aberration hit, the same channels VFX speaks.
 */
export const SNAP = { window: 1.6, rateMult: 5, vignette: 0.45, aberration: 0.0035 };
```

Constructor: `this._snapT = 0;`. In the `corruptionBand` handler (after the band assignment): `this._snapT = SNAP.window;` and pulse the pipeline immediately:

```js
      const pipe = this.ctx?.pipeline;
      if (pipe) {
        pipe.vignetteBoost = Math.max(pipe.vignetteBoost || 0, SNAP.vignette);
        pipe.aberration = (pipe.aberration || 0) + SNAP.aberration;
      }
```

In `update`: `if (this._snapT > 0) this._snapT = Math.max(0, this._snapT - dt);`. In `_grade` and the sky tail, replace direct `settle(v, target, dt)` calls with `settle(v, target, this._snapT > 0 ? dt * SNAP.rateMult : dt)` — time-dilating the settle is the one-line way to speed every blended channel (sat, vig, skyW) through one knob without touching the derived-rate math. HUD gauge pulse: check whether `HUD` already pulses `.corruption` on band change (it sets `dataset.band`); if there is a `pulse` helper usable from the existing corruptionBand set-callback, add `this.pulse(this.refs.corruption, 'is-tick')` there — one line in `src/ui/HUD.js`, include it in this task if trivial, note it in the report either way.

- [ ] **Step 4: Run tests** — `node tests/blight-ceiling.test.mjs`, `node tests/blight-system.test.mjs`, `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/systems/Blight.js src/ui/HUD.js tests/blight-ceiling.test.mjs
git commit -m "The world lurches when it crosses a line: band changes stop hiding in the blend"
```

---

### Task 3: The font scales, and cleansing supply meets demand

**Files:**
- Modify: `src/data/corruption.js`, `src/world/Interactables.js`
- Test: extend `tests/corruption-counterplay.test.mjs`

**Interfaces:**
- Consumes: `CLEANSE` (both existing consumers are in `Interactables.js` — the ArgentFont class; read its `interact`/prompt to see how `amount` and `maxUses` are used today), `_populateShrines`'s bag (`Interactables.js:1913-1951`), `ctx.corruption.band` / `.world`.
- Produces: `cleanseAmount(world) -> number` exported from `data/corruption.js`; `CLEANSE.fraction = 0.22`, `CLEANSE.amount = 30` (kept, now the floor), `CLEANSE.maxUses = 3`; `CLEANSE.guaranteeBand = 2`.

- [ ] **Step 1: Write the failing tests** — extend `tests/corruption-counterplay.test.mjs`:

```js
console.log('cleanse scales with the debt');
{
  const { cleanseAmount, CLEANSE } = await import('../src/data/corruption.js');
  ok(cleanseAmount(0) === CLEANSE.amount, 'floor holds at zero world');
  ok(cleanseAmount(100) === CLEANSE.amount, '22% of 100 is under the 30 floor');
  ok(cleanseAmount(200) === 44, '22% of 200');
  ok(cleanseAmount(400) === 88, 'deep red bleeds proportionally — the playtest font could never move a Consumed party');
  ok(CLEANSE.maxUses === 3, 'three uses per font');
  ok(CLEANSE.guaranteeBand === 2, 'guaranteed font from Blighted up');
}
```

Plus a populate-level test only if this suite already constructs an `Interactables` headless (read it first). If it does: at a ctx stub with `corruption: { band: 3, world: 150 }`, `populate(1)` must place at least one ArgentFont; at band 0 the shrine outcome for the same seed must be byte-identical to the pre-change code (assert by running the old expectation the suite already pins — the guarantee path must be **additive after** the existing bag loop, drawing from a corruption-salted local RNG, never from `ctx.rng`, so band 0 draws nothing new). If the suite cannot construct Interactables headless, pin the constants only and record the populate check as a live-probe item for Task 7.

- [ ] **Step 2: Run to verify failure** — `node tests/corruption-counterplay.test.mjs`.

- [ ] **Step 3: Implement in `data/corruption.js`** — replace the CLEANSE block:

```js
/**
 * The cleansing font (Argent Font) — counterplay, costly, never free. One use
 * bleeds `cleanseAmount(world)` — a fraction of the current debt with a flat
 * floor — for gold that climbs per use and per stage. Re-priced after the
 * 2026-08-08 playtest: a flat 30 against an unbounded world meant a Consumed
 * party's font was a rounding error; the fraction mirrors how the Voidtouched
 * refund already scales, worth most exactly when the party is deepest in.
 * `guaranteeBand`: from this band up, every stage places at least one font —
 * the user-set requirement that staying clean be *achievable*, not just priced.
 */
export const CLEANSE = {
  gold: 60,          // base cost on stage 0
  goldGrowth: 1.25,  // per-stage cost multiplier (the populate scale curve)
  amount: 30,        // floor: world corruption bled per use, minimum
  fraction: 0.22,    // of current world corruption, when above the floor
  maxUses: 3,
  costClimb: 1.4,    // per-use multiplier, same curve as the Auric Cairn
  guaranteeBand: 2,
};

export function cleanseAmount(world) {
  return Math.max(CLEANSE.amount, Math.round(Math.max(0, world) * CLEANSE.fraction));
}
```

- [ ] **Step 4: Wire the font and the guarantee** — in `Interactables.js`:
  - ArgentFont's bleed call switches from `CLEANSE.amount` to `cleanseAmount(ctx.corruption?.world ?? 0)` (import the function alongside `CLEANSE`); its prompt shows the live number so the player sees what a use is worth *now*.
  - In `_populateShrines`, raise the font's bag weight with the band: `{ w: stageIndex >= 1 ? 14 + (ctx.corruption?.band ?? 0) * 8 : 0, build: ... }`.
  - After the existing gates loop, append the guarantee — **additive, after all existing draws, no `ctx.rng` involvement**:

```js
    // The clean path must be walkable (2026-08-08 direction): from Blighted
    // up, a stage always carries a font. Placed after the bag so every
    // existing draw is byte-identical at any band; the extra placement rolls
    // on a corruption-salted local RNG, and a pristine run reaches this line
    // and draws nothing.
    const band = ctx.corruption?.band ?? 0;
    if (band >= CLEANSE.guaranteeBand && stageIndex >= 1
        && !this.list.some((i) => i instanceof ArgentFont)) {
      const grng = new RNG(((ctx.seed >>> 0) ^ (0x51f0ab8d * (stageIndex + 1))) >>> 0 || 1);
      const m = mark(1 + (grng.int ? grng.int(0, 2) : Math.floor(grng.next() * 3)));
      this.add(new ArgentFont(ctx, this._sited(m, (m?.r ?? 0) + 3.5, (m?.r ?? 0) + 11, spawn), stageIndex));
    }
```

  Verify `_sited`'s RNG source in the live file first — if `_sited` draws from `ctx.rng`, the guarantee must pass it the local `grng` instead (add an optional rng parameter defaulting to `ctx.rng` so existing callers are untouched); the sp-equivalence constraint is absolute.

- [ ] **Step 5: Run tests** — `node tests/corruption-counterplay.test.mjs`, `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` (zero fields moved), `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/data/corruption.js src/world/Interactables.js tests/corruption-counterplay.test.mjs
git commit -m "Absolution scales with the sin, and the deep-red stage always sells it"
```

---

### Task 4: The void stops paying its victims

**Files:**
- Modify: `src/data/corruption.js`, `src/systems/Items.js`, `src/systems/Corruption.js` (constant only), `src/systems/Director.js` (bank cap), and the XP grant site (locate: the system that grants XP on enemy death — likely `Progression`; find with a grep for the enemy-death event name `killReward`/`goldReward` consumers or `xp`ancement in `src/systems/Progression.js`).
- Test: extend `tests/voidtouched-director.test.mjs` and `tests/corruption-system.test.mjs`.

**Interfaces:**
- Consumes: `victim.elite` (the elite record set at `Director.spawnOne` via `Enemy.spawn` — verify the field that carries the affix id; `tests/voidtouched-affix.test.mjs` shows the shape), `VOIDTOUCHED` constants, `Items.killReward` (`src/systems/Items.js:477-490`), the Voidtouched kill-refund listener in `Corruption` (`src/systems/Corruption.js:61-68`).
- Produces: `VOIDTOUCHED.rewardMult = 0.25`, `VOIDTOUCHED.refund = 0.08`, `VOIDTOUCHED.ratePerWorld = 0.02`, `VOIDTOUCHED.bankPerWorld = 0.5`, `VOIDTOUCHED.maxBank = 240` (now the cap of a scaling bank; the old flat 90 becomes `bankBase: 90`); exported `voidBankCap(world) = Math.min(VOIDTOUCHED.maxBank, VOIDTOUCHED.bankBase + world * VOIDTOUCHED.bankPerWorld)`; exported `isVoidtouched(victim)` helper in `data/corruption.js` (pure: checks the affix id against `VOIDTOUCHED.affix`, tolerant of missing fields).

- [ ] **Step 1: Write the failing tests**:

```js
// tests/voidtouched-director.test.mjs additions (match the file's fixtures)
console.log('the void pressures harder and banks deeper as the world rots');
{
  const { VOIDTOUCHED, voidCreditRate, voidBankCap } = await import('../src/data/corruption.js');
  ok(VOIDTOUCHED.ratePerWorld === 0.02, 'rate re-priced');
  ok(Math.abs(voidCreditRate(400) - 8.0) < 1e-9, 'world 400 pays 8 credits/s');
  ok(voidBankCap(0) === 90, 'pristine bank cap unchanged');
  ok(voidBankCap(300) === 240, 'deep-red bank caps at 240 (90 + 150 capped)');
}
console.log('a Voidtouched kill is cleansing, not farming');
{
  const { isVoidtouched, VOIDTOUCHED } = await import('../src/data/corruption.js');
  ok(VOIDTOUCHED.rewardMult === 0.25 && VOIDTOUCHED.refund === 0.08, 'reward down, refund up');
  ok(isVoidtouched({ elite: { affix: 'voidtouched' } }) || isVoidtouched({ elite: { id: 'voidtouched' } }),
     'helper recognises the live elite-record shape (implementer: assert on the REAL field, not both)');
  ok(!isVoidtouched({ elite: { affix: 'warded' } }) && !isVoidtouched({}) && !isVoidtouched(null), 'everything else is not');
}
```

Plus a `killReward` test (in whichever suite already stubs `Items` with a ctx — `reviews/round5/B2-artifacts.test.mjs` had one; find the current pattern): a victim with the voidtouched elite record pays exactly `rewardMult` times the same victim with a plain elite record of equal `cost` multiplier. And in `corruption-system`: the kill-refund listener at refund 0.08 bleeds `world * 0.08 * artifactRefundMod`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the data** — `data/corruption.js` VOIDTOUCHED block becomes:

```js
export const VOIDTOUCHED = {
  affix: 'voidtouched',
  // Re-priced 2026-08-08: the void must outscale what it feeds (user-set
  // direction). Rate up 0.012 -> 0.02; the bank now deepens with the world so
  // a Consumed party faces waves, not a metronome.
  ratePerWorld: 0.02,
  bankBase: 90,
  bankPerWorld: 0.5,
  maxBank: 240,
  interval: 4,
  telegraph: 1.1,
  spawnRing: { min: 2.5, max: 6.5 },
  minPlayerDist: 12,
  // A Voidtouched kill is counterplay, not income: it pays a quarter of a
  // normal elite's gold/XP and returns more than double the old refund.
  refund: 0.08,
  rewardMult: 0.25,
};

export function voidBankCap(world) {
  return Math.min(VOIDTOUCHED.maxBank, VOIDTOUCHED.bankBase + Math.max(0, world) * VOIDTOUCHED.bankPerWorld);
}

/** Is this victim a Voidtouched elite? Pure and null-tolerant — callers pass
 *  whatever the death event carries. (Implementer: bind to the live elite
 *  record's actual affix-id field, discovered from Enemy.spawn / ELITE_STATS.) */
export function isVoidtouched(victim) {
  const e = victim?.elite;
  return !!e && (e.affix === VOIDTOUCHED.affix || e.id === VOIDTOUCHED.affix);
}
```

  (Resolve the field question and keep ONE comparison — the `||` in the sketch is the question, not the answer; the test then asserts the real shape.)

- [ ] **Step 4: Wire the three funnels**:
  - `Items.killReward`: after `bossMult`, add `const voidMult = isVoidtouched(victim) ? VOIDTOUCHED.rewardMult : 1;` and fold into the product. Import `isVoidtouched, VOIDTOUCHED` from the data module. Pure function — no RNG implications.
  - XP: find the XP-on-death grant site (likely `Progression`); apply the same `rewardMult` through `isVoidtouched`. If XP derives from the same reward funnel, one change covers both — say which in the report.
  - `Director`: wherever the void bank clamps against `VOIDTOUCHED.maxBank` (the void credit accrual — find `maxBank` in the live file), clamp against `voidBankCap(world)` instead.
  - `Corruption`'s kill-refund listener: no code change (it already reads `VOIDTOUCHED.refund`), but verify and cover with the updated test.

- [ ] **Step 5: Run tests** — the three suites named above, then `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` (the equivalence scenario is pristine: no Voidtouched exist at corruption 0, `killReward`'s new branch is false, the bank cap at world 0 is byte-identical 90 — zero fields may move), then `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/data/corruption.js src/systems/Items.js src/systems/Director.js src/systems/Progression.js tests/voidtouched-director.test.mjs tests/corruption-system.test.mjs
git commit -m "The void stops tipping its executioners: a quarter of the gold, double the absolution"
```

---

### Task 5: World corruption feeds the Director

**Files:**
- Modify: `src/data/corruption.js`, `src/systems/Director.js:265-285` (`updateDifficulty`)
- Test: extend `tests/voidtouched-director.test.mjs` (it already stubs a Director ctx)

**Interfaces:**
- Consumes: `Director.updateDifficulty`'s formula: `this.difficultyCoefficient = (pf + timeFactor) * stageFactor`.
- Produces: `PRESSURE = { perWorld: 0.004 }` exported from `data/corruption.js`.

- [ ] **Step 1: Write the failing test**:

```js
console.log('the world itself turns hostile as it rots');
{
  const { PRESSURE } = await import('../src/data/corruption.js');
  ok(PRESSURE.perWorld === 0.004, 'pressure constant pinned');
  // Two identical Directors, one at world 0 and one at world 400, same time:
  // the corrupted one's coefficient is higher by exactly 400 * perWorld * stageFactor.
  // (Build with the suite's existing Director fixture; set ctx.corruption stubs.)
}
```

Flesh the comparison out against the suite's real fixture: call `updateDifficulty(ctx)` on both, assert `coefB - coefA === 400 * PRESSURE.perWorld * Math.pow(1.15, stagesCompleted)` to float tolerance, and assert world 0 is byte-identical to the pre-change formula (regression pin for sp-equivalence).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — `data/corruption.js`:

```js
/**
 * World corruption feeds the Director (2026-08-08 direction): the same number
 * that buys blight and Voidtouched now buys everyone's health and damage.
 * 0.004/world means Consumed-at-400 adds ~1.6 coefficient before the stage
 * multiplier — about five Director levels at minute ten. A pristine run adds
 * exactly zero, which is what keeps sp-equivalence and the "never a fun-tax
 * for the cautious" promise intact.
 */
export const PRESSURE = { perWorld: 0.004 };
```

`Director.updateDifficulty` — one term:

```js
    const corFactor = (ctx.corruption?.world ?? 0) * PRESSURE.perWorld;
    this.difficultyCoefficient = (pf + timeFactor + corFactor) * stageFactor;
```

(Import `PRESSURE` next to the existing `VOIDTOUCHED, voidCreditRate` import at `Director.js:29`. Pure read of a host-authoritative scalar every tick — no RNG, no event, replicated implicitly through the difficulty-derived values clients already receive.)

- [ ] **Step 4: Run tests** — suite, sp-equivalence (world 0 → `corFactor` 0 → formula byte-identical), `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/data/corruption.js src/systems/Director.js tests/voidtouched-director.test.mjs
git commit -m "The Director reads the second ledger: a rotten world raises everything against you"
```

---

### Task 6: Restraint pays — the clean ending unlocks the Vigil

**Files:**
- Modify: `src/data/artifacts.js` (or wherever the artifact cards live — the Maw and Atonement from the corruption-artifacts slice are the models), `src/ui/Icons.js` (mark), `src/systems/Progression.js` or the ending-recording site (find where victory endings are committed with their band — `Progression.js:512` snapshots `corruptionBand`), `src/systems/Profile.js` (only if a new fact/unlock key is needed — follow the existing unlock machinery).
- Test: extend `tests/corruption-artifacts.test.mjs`.

**Interfaces:**
- Consumes: the artifact card schema with `corruptionMods() -> { feed, refund }` (shipped in the corruption-artifacts slice; `maw`/`atonement` are the reference cards), the ending-record path that already stores `corruptionBand`, the Profile unlock/fact machinery (`Profile.discover`/unlock cross-check — read how existing artifact `unlock` fields are declared and satisfied).
- Produces: artifact `vigil` — name **Vigil of the Unbroken Seal**, unlock: any victory ending reached at band ≤ 1; effect: `corruptionMods -> { feed: 0.65, refund: 1.0 }` (all corruption feeds reduced 35%) and nothing else — an artifact that makes the clean path easier for players who have proven it walkable, which is the exclusivity loop: greed can never buy it, because buying is what disqualifies you.

- [ ] **Step 1: Write the failing tests** — extend `tests/corruption-artifacts.test.mjs` following its existing per-card blocks:

```js
console.log('Vigil of the Unbroken Seal — restraint pays forward');
{
  // Card exists, has a mark, declares an unlock (not null), and its
  // corruptionMods reduce feed by 35% while leaving refunds alone.
  // Follow this suite's existing maw/atonement assertions for the exact
  // access pattern (ARTIFACTS lookup, corruptionMods composition through
  // the Artifacts system fixture).
}
console.log('the clean ending records the fact the unlock keys on');
{
  // Drive the ending-record path the suite (or tests/corruption-routing.test.mjs)
  // already exercises with corruptionBand <= 1 and a victory ending id; assert
  // the profile fact/unlock flips. If no existing suite drives endings headless,
  // test the recording function directly with a stubbed profile.
}
```

These blocks are deliberately schematic in the plan because the artifact/unlock schemas live in files this plan's recon did not fully read — the implementer's first step is reading `data/artifacts.js`'s maw/atonement entries, `Icons.js`'s MARKS, and one existing unlock end-to-end, then writing these tests concretely against the real shapes. The requirements they must pin: (a) card `vigil` with non-null unlock; (b) `feed: 0.65, refund: 1.0` mods; (c) a band ≤ 1 victory sets the unlock fact; (d) a band ≥ 2 victory does NOT.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — card (matching maw/atonement's structure verbatim in shape), mark in Icons, unlock fact recorded at the ending-commit site:

```js
    // Restraint's proof: a victory carried home at Seeded or cleaner. The
    // fact is the unlock key for the Vigil (data/artifacts.js) — the one
    // reward greed cannot buy, because buying is what disqualifies you.
    if (won && (record.corruptionBand ?? 0) <= 1) profile.discover('facts', 'clean-ending');
```

  (Adapt: `discover`'s kind must be one the profile schema carries — read `Profile.data.encounters` kinds; if 'facts' is not a kind, use the mechanism the existing artifact unlocks actually key on. The unlock condition on the card references the same key. This is the task's judgment core — wire it through the REAL machinery, not a parallel one.)

- [ ] **Step 4: Run tests** — `node tests/corruption-artifacts.test.mjs`, `npm test`, sp-equivalence (unlock recording happens at run end, outside the equivalence scenario's frame; verify).

- [ ] **Step 5: Commit**

```bash
git add src/data/artifacts.js src/ui/Icons.js src/systems/Progression.js tests/corruption-artifacts.test.mjs
git commit -m "The one reward greed cannot buy: a clean victory seals the Vigil"
```

---

### Task 7: Gates and the reckoning probe

**Files:**
- Create/extend: `tools/blightprobe.mjs` gains a reckoning arm (or a sibling `tools/reckoningprobe.mjs` following its conventions — implementer's call, stated in the report).
- Baselines: committed evidence under `reviews/round8/` per the repo convention.

- [ ] **Step 1: Full suite** — `npm test` green; `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` with **zero fields moved** (every gameplay change in this slice is corruption-gated or pure-multiplier; a pristine scenario must be byte-identical — a diff is a bug in the slice, never a baseline to regenerate).

- [ ] **Step 2: Live probe** (real GPU, following `tools/blightprobe.mjs`): drive a run to band 4 via void-credit opens, then assert with committed-record evidence: (a) `bandSting` fired on each crossing (count audio node creations or expose a counter); (b) the snap window ran (`_snapT` observed > 0 after a crossing; sky weight reached 0.9 within SNAP.window); (c) `difficultyCoefficient` includes the corruption term (compare against a computed expectation from the dumped `ctx.time`/stage/world); (d) an Argent Font exists on a band ≥ 2 stage and one use bleeds `cleanseAmount(world)`; (e) a Voidtouched kill pays reduced gold (read the goldReward event amount) and refunds 8%; (f) void bank cap reads `voidBankCap(world)`. Record all numbers to a JSON committed under `reviews/round8/` (e.g. `reckoning-probe-record.json`).

- [ ] **Step 3: The feel numbers** — the probe also records the loop-closure metrics the next playtest argues against: at world 400, credits/s (8.0), bank cap (240), Voidtouched kill gold vs normal elite gold, cleanse per font visit (3 uses x 88 = 264 — a deep-red party that fights for a font can now actually climb out), corruption-added difficulty (+1.6 coef pre-stage-mult). Print them as a table in the report.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "The reckoning holds under instruments: pressure, price, and the way back out"
```

---

## Self-review notes

- **Direction coverage:** void pressure outscales reward ✓ (Task 4: rate x1.67, scaling bank, kills pay 25%); world corruption feeds difficulty ✓ (Task 5); clean-route exclusivity ✓ (Task 6: Vigil, unbuyable by construction); staying clean is achievable ✓ (Task 3: scaling bleed — 3 uses at world 400 remove ~264, guaranteed supply from band 2; plus the doubled refund making Voidtouched-hunting a real cleansing loop); band legibility ✓ (Tasks 1-2: audible layer, sting, visual snap — the playtest's "didn't notice" items). Mutations untouched per the user's explicit non-choice.
- **Type consistency:** `cleanseAmount`/`voidBankCap`/`isVoidtouched`/`PRESSURE`/`VOID_LAYER`/`SNAP` names identical across data, systems, and tests; `VOIDTOUCHED.maxBank` re-reads as the cap of the scaling bank with `bankBase` carrying the old 90 — both consumers (Director clamp, tests) updated in the same task.
- **Known execution-time checks (deliberate):** the elite record's affix-id field (Task 4 — bind `isVoidtouched` to the real one and collapse the `||`); the XP grant site (Task 4); `_sited`'s RNG source (Task 3 — the guarantee must not touch `ctx.rng`); `_tone`'s option keys and Audio's event-subscription idiom (Task 1); the artifact card / unlock / Icons.MARKS schemas (Task 6 — read maw/atonement end-to-end first); whether `tests/corruption-counterplay.test.mjs` constructs Interactables headless (Task 3). Implementers verify against live files.
- **The sharp edge, restated:** sp-equivalence with zero baseline changes is a per-task gate (Tasks 3, 4, 5 name it in their own steps), not just a closing formality — every new behavior is gated on corruption > 0 or is a pure multiplier that resolves to 1/identity at pristine.
