# Readability, Then Juice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The roster becomes measurable instead of arguable — a readability gate that renders every enemy family, tier and elite affix and fails on a unit that cannot be read as friend/foe/tier at 40 m — and then the three juice deltas the launch design names and the codebase does not yet have: corpse launch on overkill, ability-specific kill VFX, and damage-type-coloured hit sparks. Phase 3 slice 2 of the launch design (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md` §3 workstream 2).

**Phase 3 slice split** (this plan is slice 2): 1. blight ceiling (`2026-08-08-blight-ceiling.md`, shipped) · 2. readability gate + combat juice (this plan) · 3. diegetic UI treatment · 4. shot library / trailer pipeline formalization. Slices 3–4 get their own plans.

**Hitstop is already shipped and is NOT in this plan.** `src/systems/VFX.js:39-49` carries the whole `HITSTOP` table (`hit / crit / kill / elite / explosion / boss / playerHurt`), the `HITSTOP_GATE` rate limiter and `HITSTOP_MAX` clamp; `_onKill` already spends `HITSTOP.boss / HITSTOP.elite / HITSTOP.kill` per victim class. The spec line "hitstop on heavy kills" is satisfied by code in the tree. Nothing below re-plans it, re-tunes it, or touches those constants.

**Architecture:** The readability gate splits `tools/silhouette.mjs` into a pure, node-importable metrics module (`tools/silhouette-metrics.mjs`) and a renderer. The module is what `npm test` can reach — thresholds, mask measurement and grading are pinned by a node-only suite against synthetic bitmaps; the tool adds a real GPU, the enemy roster, a second perspective pass at 40 m, and an exit code. The gate ratchets: the shipped roster's measured worst cases become named exemptions carrying their measured value, so the gate is green on what exists and red on anything new or anything that gets worse. The juice deltas ride two payload additions on events that already exist — `damage` gains `type`, `kill` gains `type` and `overkill` — and every consumer of both lives in `src/systems/VFX.js`. The corpse launch is a VFX-owned per-frame offset applied *after* `Enemy.updateRig` writes `rig.root.position`: no entity state, no Combat state, no physics, nothing `tests/sp-equivalence.mjs` can see.

**Tech Stack:** Playwright + Vite dev server for the render passes (following `tools/silhouette.mjs` and `tools/capture.mjs`), three.js `OrthographicCamera` / `PerspectiveCamera` render targets read back with `readRenderTargetPixels`, `src/entities/EnemyMeshes.js`'s `acquireRig` / `setAffix` / `makeAnim` rig API, the existing `ParticleSystem` emit prototype (`VFX._ep()`), node-only `tests/*.test.mjs` with `ok()` + exit code.

## Global Constraints

- **sp-equivalence, zero fields moved.** `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` is a per-task gate on every task that touches `src/` (Tasks 3, 4, 5), not just the closing formality. The fingerprint carries `finalEnemyPositions` among its 31 accumulators, and the instrument is a chaotic amplifier — a one-centimetre offset on enemy target selection moved total damage 4.4% and rewrote all thirteen position entries. **Never regenerate `baseline-HEAD.json` to make a diff pass.** A moved field is a bug in the slice.
- **Zero `ctx.rng` draws anywhere in this plan.** Every line below is presentation. Cosmetic variation uses `ctx.fxRng` or nothing at all (`NETCODE.md`: cosmetic draws must never advance the shared stream). Tests probe this with a throwing `ctx.rng`.
- **Additive-only event payloads.** `damage` and `kill` gain fields; no existing field changes name, type or value. `NetHost._forward` runs `sanitise()`, which is generic over plain scalars (`src/net/NetHost.js:622-652`) — a new number and a new string cross the wire with no whitelist edit. `damage`'s new field must resolve to the *same* value the untyped path produces today when no type is supplied.
- **Corpse launch is cosmetic by construction.** It never writes `Enemy.position`, `Enemy.velocity`, the FSM, or anything Combat reads. It is a per-frame offset applied to `rig.root.position` from `VFX.update`, which runs after `Director` in the system order (`src/main.js:67` then `:72`, and `Engine._frame` runs every `fixedUpdate` before any `update` — `src/core/Engine.js:256,262`). `Enemy.updateRig` re-copies `this.position` into `rig.root.position` every frame (`src/entities/Enemy.js:1377`), so the offset is re-applied on top each frame and leaves no residue when it stops.
- **Headless-testable.** Every mechanic gets a deterministic node-only test in `tests/<name>.test.mjs` — self-running, `ok()` + exit code, no browser, under a second. Visual work gets tool/probe coverage with a committed on-disk record, exactly as slice 1 did.
- **Gate thresholds are exported constants in one place** (`READABILITY` in `tools/silhouette-metrics.mjs`) so the test pins them and a designer turns them.
- **New evidence lands under `reviews/round9/`** with a README, following `reviews/round8/README.md`'s convention: any before/after number claimed anywhere must have a committed on-disk source and the command that produced it.
- Bash tool is ASCII-only in this environment; any file content with non-ASCII goes through Write/Edit, never heredocs.
- Commit messages follow the house lowercase-poetic one-line style (`git log --oneline -20`): a clause about what the world now does, not a changelog verb.

---

### Task 1: The measurement leaves the renderer

**Files:**
- Create: `tools/silhouette-metrics.mjs`
- Modify: `tools/silhouette.mjs` (import the module, delete the inlined math)
- Test: `tests/readability-gate.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module, no three.js, no playwright, node-importable).
- Produces (Task 2 and the test rely on these exact names):
  - `maskReader(b64, w) -> (x, y) => 0|1` — unpacks the tool's row-major 1-bit-per-pixel base64 payload. Width alone indexes it; the height is implied by the buffer.
  - `measureMask(b64, w, h) -> { x0, y0, bw, bh, area, fill, aspect, cx, cy, holes, bands, sig }` where `bands` is ten `{ w, fill, runs }` records crown-to-feet and `sig` is a `Uint8Array(64*64)` bbox-normalised signature. Empty mask (`area === 0`) returns the same shape with `bw = bh = 0`, `sig` all zeros, and `bands` ten zeroed records — it must not throw or return null.
  - `shapeIoU(sigA, sigB) -> number` in `[0, 1]`; `0` when the union is empty.
  - `READABILITY` — the threshold constants (values in Step 3).
  - `gradeRoster(record) -> { ok, checks }` (defined in Task 2; this task only creates the module and the three functions above).

- [ ] **Step 1: Write the failing test**

```js
// tests/readability-gate.test.mjs
//
// The node-only half of the readability gate. `tools/silhouette.mjs` needs a
// GPU, a browser and about a minute; the arithmetic it runs on the masks it
// gets back needs none of those, and that arithmetic is where a gate silently
// stops measuring. So the math lives in tools/silhouette-metrics.mjs and is
// pinned here against masks this file draws itself.
import { maskReader, measureMask, shapeIoU, READABILITY } from '../tools/silhouette-metrics.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const W = 32, H = 32;

/** Draw a mask with a predicate and pack it exactly as the in-page code does. */
function synth(fn, w = W, h = H) {
  const bits = new Uint8Array(Math.ceil(w * h / 8));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (fn(x, y)) { const i = y * w + x; bits[i >> 3] |= 1 << (i & 7); }
  }
  return Buffer.from(bits).toString('base64');
}

console.log('mask reader round-trips the packing the renderer uses');
{
  const b64 = synth((x, y) => x === 3 && y === 7);
  const get = maskReader(b64, W);
  ok(get(3, 7) === 1, 'the set pixel reads back set');
  ok(get(7, 3) === 0, 'its transpose does not — row-major, not column-major');
  ok(get(0, 0) === 0 && get(W - 1, H - 1) === 0, 'corners clear');
}

console.log('measureMask on a solid 8x16 block');
{
  const m = measureMask(synth((x, y) => x >= 8 && x < 16 && y >= 4 && y < 20), W, H);
  ok(m.x0 === 8 && m.y0 === 4, 'bbox origin');
  ok(m.bw === 8 && m.bh === 16, 'bbox extent');
  ok(m.area === 128, 'area');
  ok(Math.abs(m.fill - 1) < 1e-9, 'a solid block fills its own bbox');
  ok(Math.abs(m.aspect - 0.5) < 1e-9, 'aspect is width over height');
  ok(Math.abs(m.cx - 0.5) < 0.05 && Math.abs(m.cy - 0.5) < 0.05, 'centroid at the middle');
  ok(m.holes === 0, 'no negative space');
  ok(m.bands.length === 10, 'ten bands');
  ok(m.bands.every((b) => Math.abs(b.w - 1) < 1e-9), 'every band spans the full width');
  ok(m.bands.every((b) => Math.abs(b.runs - 1) < 1e-9), 'every scanline is one solid run');
}

console.log('measureMask sees daylight through an outline');
{
  // A ring: 16x16 outer, 8x8 hole. The hole is the thing a blob does not have.
  const outer = (x, y) => x >= 8 && x < 24 && y >= 8 && y < 24;
  const hole = (x, y) => x >= 12 && x < 20 && y >= 12 && y < 20;
  const m = measureMask(synth((x, y) => outer(x, y) && !hole(x, y)), W, H);
  ok(m.holes === 64, 'the enclosed 8x8 counts as negative space');
  ok(m.bands.some((b) => b.runs > 1.5), 'the waist scanlines read as two separate runs');
  ok(m.fill < 0.8, 'fill is below solid');
}

console.log('measureMask survives an empty mask without throwing');
{
  const m = measureMask(synth(() => false), W, H);
  ok(m.area === 0 && m.bw === 0 && m.bh === 0, 'zeroed bbox');
  ok(m.bands.length === 10 && m.bands.every((b) => b.w === 0), 'ten zeroed bands');
  ok(m.sig.length === 64 * 64 && m.sig.every((v) => v === 0), 'zeroed signature');
  ok(m.holes === 0 && m.fill === 0 && m.aspect === 0, 'no NaN anywhere');
}

console.log('shapeIoU is scale-blind, which is the whole point of the signature');
{
  const small = measureMask(synth((x, y) => x >= 14 && x < 18 && y >= 14 && y < 18), W, H);
  const big = measureMask(synth((x, y) => x >= 4 && x < 28 && y >= 4 && y < 28), W, H);
  ok(shapeIoU(small.sig, big.sig) > 0.99, 'a square is a square at any size');
  const bar = measureMask(synth((x, y) => y >= 14 && y < 18 && x >= 2 && x < 30), W, H);
  ok(shapeIoU(small.sig, bar.sig) > 0.99, 'bbox normalisation also flattens aspect — IoU alone cannot see it');
  const cross = measureMask((() => {
    const f = (x, y) => (x >= 14 && x < 18) || (y >= 14 && y < 18);
    return synth(f);
  })(), W, H);
  ok(shapeIoU(small.sig, cross.sig) < 0.6, 'a plus is not a square');
  ok(shapeIoU(new Uint8Array(4096), new Uint8Array(4096)) === 0, 'empty against empty is zero, not NaN');
}

console.log('thresholds are exported and ordered');
{
  ok(typeof READABILITY === 'object' && READABILITY !== null, 'READABILITY exported');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/readability-gate.test.mjs`
Expected: FAIL — cannot find module `../tools/silhouette-metrics.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// tools/silhouette-metrics.mjs
/**
 * The arithmetic half of the readability gate.
 *
 * `tools/silhouette.mjs` needs playwright, vite and a real GPU to produce a
 * mask. It needs none of them to *measure* one, and a gate whose measurement
 * can only be exercised by a minute of browser is a gate nobody runs and
 * nobody can prove still measures anything. So everything downstream of the
 * pixels lives here: pure, node-importable, and pinned by
 * `tests/readability-gate.test.mjs` against masks that file draws itself.
 *
 * The mask format is the one the in-page packer produces: one bit per pixel,
 * row-major, top row first, LSB-first within each byte, base64'd.
 */

/** Unpack a base64 mask into a bit reader. */
export function maskReader(b64, w) {
  const bits = Buffer.from(b64, 'base64');
  return (x, y) => {
    const i = y * w + x;
    return (bits[i >> 3] >> (i & 7)) & 1;
  };
}

const EMPTY_BANDS = () => Array.from({ length: 10 }, () => ({ w: 0, fill: 0, runs: 0 }));

/**
 * Everything one silhouette is worth, from its mask.
 *
 * `bands` is the shape of the shape — ten width/fill/run samples from the
 * crown down. `runs` is the mean number of separate solid segments per
 * scanline, which is the direct measure of daylight through the outline: a
 * band at 1.00 is a solid bar, i.e. arms welded to a torso or legs fused into
 * one column. `holes` is background inside the bbox the border flood cannot
 * reach — zero of it is the "solid lump" failure. `sig` is a bbox-normalised
 * 64x64 signature, so scale is removed on purpose and it answers "is this the
 * same shape at a different size".
 */
export function measureMask(b64, w, h) {
  const get = maskReader(b64, w);
  let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!get(x, y)) continue;
    area++; sx += x; sy += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // An empty mask is a real answer — a rig that rendered nothing — and it must
  // reach the grader as a zero rather than as a crash or a NaN that compares
  // false against every threshold and reads as a pass.
  if (area === 0) {
    return {
      x0: 0, y0: 0, bw: 0, bh: 0, area: 0, fill: 0, aspect: 0, cx: 0, cy: 0,
      holes: 0, bands: EMPTY_BANDS(), sig: new Uint8Array(64 * 64),
    };
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  const bands = [];
  for (let b = 0; b < 10; b++) {
    const ya = y0 + Math.floor(bh * b / 10), yb = y0 + Math.floor(bh * (b + 1) / 10);
    let lo = w, hi = -1, fill = 0, runs = 0, scan = 0;
    for (let y = ya; y < yb; y++) {
      scan++;
      let prev = 0;
      for (let x = x0; x <= x1; x++) {
        const v = get(x, y);
        if (v && !prev) runs++;
        prev = v;
        if (!v) continue;
        fill++;
        if (x < lo) lo = x; if (x > hi) hi = x;
      }
    }
    bands.push({
      w: hi < 0 ? 0 : (hi - lo + 1) / bw,
      fill: fill / (((yb - ya) * bw) || 1),
      runs: runs / (scan || 1),
    });
  }

  const seen = new Uint8Array(bw * bh);
  const stack = [];
  for (let x = 0; x < bw; x++) { stack.push([x, 0], [x, bh - 1]); }
  for (let y = 0; y < bh; y++) { stack.push([0, y], [bw - 1, y]); }
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
    if (seen[y * bw + x] || get(x0 + x, y0 + y)) continue;
    seen[y * bw + x] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  let holes = 0;
  for (let i = 0; i < bw * bh; i++) if (!seen[i] && !get(x0 + (i % bw), y0 + ((i / bw) | 0))) holes++;

  const sig = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    sig[y * 64 + x] = get(x0 + Math.floor(x * bw / 64), y0 + Math.floor(y * bh / 64));
  }

  return {
    x0, y0, bw, bh, area,
    fill: +(area / (bw * bh)).toFixed(4),
    aspect: +(bw / bh).toFixed(4),
    cx: +(((sx / area) - x0) / bw).toFixed(4),
    cy: +(((sy / area) - y0) / bh).toFixed(4),
    holes,
    bands, sig,
  };
}

/** Intersection over union of two 64x64 signatures. Empty over empty is 0. */
export function shapeIoU(a, b) {
  let inter = 0, uni = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] & b[k]) inter++; if (a[k] | b[k]) uni++; }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * The gate's thresholds. Task 2 defines what each one is measured against;
 * every value here is either sourced from an existing measurement in this
 * repo or is a design intent the first recorded run ratchets against.
 */
export const READABILITY = {
  // Silhouette pixels a unit must cover at 40 m, at the capture harness's
  // 1600x900 and the live camera's own FOV. 219 is not invented: it is the
  // per-object floor `11-bestiary` already sets for itself (minPixels 3500
  // over sixteen cards, src/core/Harness.js) and the number that shot was
  // re-framed three times to clear. A unit that cannot make the bestiary
  // shot's floor at 40 m cannot be read at 40 m in a fight either.
  minPx40: 219,
  // Two enemy families whose bbox-normalised silhouettes overlap more than
  // this are the same monster wearing two names.
  maxFamilyIoU: 0.78,
  // An enemy that reads as a survivor is the friend/foe failure. Held tighter
  // than the family bar: mistaking a monster for a monster costs a beat,
  // mistaking one for a teammate costs the fight.
  maxFoeFriendIoU: 0.72,
  // Median silhouette area at 40 m, tier n+1 against tier n. Area, not height:
  // it is what the eye integrates. 1.6 is comfortably under the roster's own
  // spread (tier-1 median height 1.1 m, tier-2 2.6 m, tier-3 3.4 m) and well
  // over the 1.0 that would mean tiers are indistinguishable by size.
  minTierAreaRatio: 1.6,
  // An affix must change the outline it is painted on: 1 - IoU(plain, elite).
  // Every affix in ELITE spends bands, bits or a ward on exactly this.
  minEliteDelta: 0.10,
  // And it must change the colour too, since the tint is what carries the
  // affix's identity: mean per-channel distance between the plain and elite
  // colour renders over the union of their masks, 0-1.
  minEliteChroma: 0.06,
  // Daylight: no unit may be a solid lump. A silhouette with no enclosed
  // negative space at all, as a fraction of its own bbox.
  minHoles: 0.004,
  /**
   * The ratchet. Each entry is a check the roster fails *as shipped*, with the
   * value measured at the time it was admitted and the run that measured it.
   * The gate passes an exempted check only while it is no worse than the
   * recorded value — a new failure is red, and an exempted one that degrades
   * is red. Adding an entry here is a content decision and belongs in a
   * commit of its own, with the record it came from.
   */
  exemptions: [],
};
```

- [ ] **Step 4: Point `tools/silhouette.mjs` at the module**

In `tools/silhouette.mjs`, add the import next to the playwright/vite imports:

```js
import { measureMask, shapeIoU } from './silhouette-metrics.mjs';
```

Then delete the inlined measurement block (the `const M = {}` loop that spans the bbox scan, the band loop, the flood fill and the signature build — currently lines 99-170) and replace it with:

```js
const M = {};
for (const [id, b64] of Object.entries(masks)) M[id] = measureMask(b64, W, H);
```

and replace the pairwise IoU body (currently the inner `inter`/`uni` loop, lines 191-193) with `const iou = shapeIoU(M[ids[i]].sig, M[ids[j]].sig);`. Everything else in the file — the render block, the tables, the contact sheet — is untouched. The printed columns still resolve: `measureMask` returns `bw`/`bh` where the old code had them as locals, so the `bbox` column becomes `` `${m.bw}x${m.bh}` `` and `holes` is now a raw count, so the holes column becomes `(m.holes / (m.bw * m.bh) * 100).toFixed(2)`. Verify the survivor table prints the same numbers it did before the refactor by running the tool once each side of the change if a GPU is available; if it is not, say so in the report rather than claiming equivalence.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/readability-gate.test.mjs`
Expected: PASS, exit 0.

Run: `npm test`
Expected: green — the new suite joins the run and nothing else is touched.

- [ ] **Step 6: Commit**

```bash
git add tools/silhouette-metrics.mjs tools/silhouette.mjs tests/readability-gate.test.mjs
git commit -m "The measurement leaves the darkroom: what the masks are worth is arithmetic node can run"
```

---

### Task 2: Every monster stands in the same box, and the gate has an exit code

**Files:**
- Modify: `tools/silhouette-metrics.mjs` (add `gradeRoster`)
- Modify: `tools/silhouette.mjs` (enemy roster pass, 40 m perspective pass, grading, exit code, JSON record)
- Test: extend `tests/readability-gate.test.mjs`
- Create: `reviews/round9/readability-gate.json`, `reviews/round9/README.md`

**Interfaces:**
- Consumes: `measureMask`, `shapeIoU`, `READABILITY` (Task 1); `SPAWN_CARDS`, `BOSS_CARDS`, `ELITE_STATS` from `src/data/enemies.js` (`:1305`, `:1308`, `:1349` — cards carry `id`, `name`, `tier`, `height`, `radius`, `eliteEligible`, `meshFactory`); `ELITE`, `acquireRig(id)`, `makeAnim()` from `src/entities/EnemyMeshes.js` (`:188`, `:4383`, `:4419`) and the rig's own `setAffix(affix)` / `resetRig()` / `animate(rig, anim, dt)`; `SURVIVORS` + `CharacterMesh` as the existing survivor pass already uses them.
- Produces:
  - `gradeRoster(record) -> { ok, checks }` where each check is `{ id, kind, value, floor|ceiling, ok, exempt }` and `kind` is one of `'px40' | 'familyIoU' | 'foeFriendIoU' | 'tierArea' | 'eliteDelta' | 'eliteChroma' | 'holes'`.
  - `tools/silhouette.mjs` CLI: `node tools/silhouette.mjs [--seed 1337] [--enemies] [--json <path>]`. Without `--enemies` it behaves exactly as today (survivors only, exit 0). With `--enemies` it renders the full roster, grades it, writes the JSON record if `--json` is given, and **exits 1 on any failed non-exempt check**.
  - `reviews/round9/readability-gate.json` — the recorded roster state, and the on-disk source of every readability number this slice claims.

- [ ] **Step 0: GPU canary — do this before writing a line of this task**

`tools/silhouette.mjs` launches Chromium with `headless: false` and `--use-angle=d3d11` (`:27-32`). It needs a real GPU **and a live desktop session**, which is not something an executor can fix by editing files — so find out in ten seconds rather than at Step 6, after the tool has been rewritten.

Run the survivor-only path, unchanged, as the canary:

```bash
node tools/silhouette.mjs
```

Expected: the four survivor tables and an ASCII contact sheet with recognisable figures in it. **Two failure modes, and they look different:**

- **It throws or hangs** (no browser, no display, `chromium.launch` timeout) — the environment has no GPU path at all.
- **It completes and every silhouette is empty or solid** — `area` at or near 0, or `fill` at 1.000 with `holes` 0.00, and a contact sheet that is all `.` or all `#`. This is the dangerous one: the tool exits 0 and prints a table of numbers that mean nothing. A black render is not an art problem here, it is a dead GL context, and `capture.mjs`'s own header (`:5-7`) says exactly this about its own shots.

Either way, fall back to software rendering. `tools/silhouette.mjs` has no `--software` switch today — add one now, mirroring `tools/capture.mjs:35` and `:231-234` verbatim, as part of this step:

```js
// SwiftShader instead of the real adapter. Slow — capture.mjs measures a full
// post-stack frame at ~0.1fps under it — but these are flat-shaded rigs
// against a white background with no post stack at all, so the cost lands in
// seconds rather than minutes. Kept as an explicit opt-in for exactly the
// same reason capture.mjs keeps it: a machine with no GPU session must be
// able to produce the evidence, and must not do it by accident on one that has.
const SOFTWARE = 'software' in args;

const browser = await chromium.launch({
  timeout: 120000,
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl']
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--force_high_performance_gpu',
       '--window-position=-2400,-2400', '--window-size=800,600'],
});
```

(The argv parser this reads `args` from is written in Step 4; if Step 0 runs first, add the parser here and Step 4 inherits it. Order the two however is convenient — the parser is the same code either way.)

Re-run `node tools/silhouette.mjs --software` and confirm real figures. **Record in the task's report which mode was used**, and carry `--software` through every later invocation in Steps 6, and through Task 6 Steps 2 and 4-5, if that is the mode that worked. A record produced under SwiftShader is still a valid record — the masks are flat-shaded geometry, not a lit frame — but which renderer produced it belongs in `reviews/round9/readability-gate.json` and in the README, because the next person to diff two records needs to know whether they were produced the same way. Add `renderer: SOFTWARE ? 'swiftshader' : 'd3d11'` to the record object in Step 5.

If **neither** mode produces figures, stop and report. Do not proceed to Step 6, do not hand-write a `readability-gate.json`, and do not weaken the roster-coverage test to tolerate a missing record — Task 2's whole deliverable is a measurement, and a plan that lets an executor fabricate one has no gate in it at all.

- [ ] **Step 1: Write the failing test** — append to `tests/readability-gate.test.mjs`, before the `console.log(\`\n${pass} passed...\`)` lines:

```js
console.log('the gate grades a record and ratchets against its exemptions');
{
  const { gradeRoster } = await import('../tools/silhouette-metrics.mjs');
  // A minimal record in the shape the tool writes. Two families, one elite
  // pair, three tiers, all deliberately just over the floors.
  const good = {
    units: [
      { id: 'mite',   tier: 1, px40: 260, holesFrac: 0.02, sig: null },
      { id: 'golem',  tier: 2, px40: 900, holesFrac: 0.03, sig: null },
      { id: 'hulk',   tier: 3, px40: 1800, holesFrac: 0.03, sig: null },
    ],
    familyPairs: [{ a: 'mite', b: 'golem', iou: 0.41 }],
    foeFriendPairs: [{ a: 'mite', b: 'ranger', iou: 0.38 }],
    tierMedianPx: { 1: 260, 2: 900, 3: 1800 },
    elites: [{ id: 'golem', affix: 'blazing', delta: 0.21, chroma: 0.19 }],
  };
  // Every call here passes its exemption list explicitly, including the empty
  // one. Defaulting to READABILITY.exemptions would couple this fixture to
  // whatever the shipped roster needed admitted, which is the one thing a unit
  // test of the ratchet must not depend on.
  const g = gradeRoster(good, []);
  ok(g.ok === true, 'a clean roster passes');
  ok(g.checks.length > 0 && g.checks.every((c) => c.ok), 'and every check in it is green');
  ok(g.checks.some((c) => c.kind === 'px40') && g.checks.some((c) => c.kind === 'tierArea')
     && g.checks.some((c) => c.kind === 'eliteDelta') && g.checks.some((c) => c.kind === 'familyIoU')
     && g.checks.some((c) => c.kind === 'foeFriendIoU') && g.checks.some((c) => c.kind === 'holes')
     && g.checks.some((c) => c.kind === 'eliteChroma'), 'all seven kinds are graded');

  // One unit falls under the 40 m floor.
  const dim = structuredClone(good);
  dim.units[0].px40 = 140;
  dim.tierMedianPx[1] = 140;
  const gd = gradeRoster(dim, []);
  ok(gd.ok === false, 'a unit under the 40 m floor fails the gate');
  ok(gd.checks.some((c) => c.kind === 'px40' && c.id === 'mite' && !c.ok), 'and the failure names the unit');

  // The same failure, exempted at its measured value, passes.
  const exempt = [{ id: 'mite', kind: 'px40', value: 140, note: 'test fixture' }];
  const ge = gradeRoster(dim, exempt);
  ok(ge.ok === true, 'an exemption at the measured value passes the gate');
  ok(ge.checks.some((c) => c.kind === 'px40' && c.id === 'mite' && c.exempt), 'and the check is flagged exempt');

  // ...but only while it does not get worse.
  const worse = structuredClone(dim);
  worse.units[0].px40 = 120;
  worse.tierMedianPx[1] = 120;
  ok(gradeRoster(worse, exempt).ok === false, 'an exempted check that degrades goes red again');

  // ...and an exemption never covers a different unit.
  const other = structuredClone(good);
  other.units[1].px40 = 140;
  ok(gradeRoster(other, exempt).ok === false, 'an exemption is per unit, not per kind');

  // Ceiling checks ratchet the other way round.
  const collide = structuredClone(good);
  collide.familyPairs[0].iou = 0.91;
  ok(gradeRoster(collide, []).ok === false, 'two families that overlap too much fail');
  ok(gradeRoster(collide, [{ id: 'mite/golem', kind: 'familyIoU', value: 0.91 }]).ok === true,
     'exempted at 0.91 it passes');
  collide.familyPairs[0].iou = 0.93;
  ok(gradeRoster(collide, [{ id: 'mite/golem', kind: 'familyIoU', value: 0.91 }]).ok === false,
     'and 0.93 against a 0.91 exemption is a regression');
}

console.log('the recorded roster covers every card the director can spawn');
{
  const { readFileSync, existsSync } = await import('node:fs');
  const { SPAWN_CARDS, BOSS_CARDS } = await import('../src/data/enemies.js');
  const path = new URL('../reviews/round9/readability-gate.json', import.meta.url);
  ok(existsSync(path), 'the gate record is committed');
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const seen = new Set(rec.units.map((u) => u.id));
  for (const c of [...SPAWN_CARDS, ...BOSS_CARDS]) ok(seen.has(c.id), `${c.id} was measured`);
  // The record is the on-disk source for every readability claim in this
  // slice, so it has to say which tree produced it.
  ok(typeof rec.commit === 'string' && rec.commit.length >= 7, 'the record names the commit it measured');
  ok(rec.seed === 1337 && rec.range === 40, 'and the seed and the range it measured at');
}
```

- [ ] **Step 2: Run to verify the new blocks fail**

Run: `node tests/readability-gate.test.mjs`
Expected: the new assertions FAIL (`gradeRoster` is not a function; the record file does not exist); Task 1's blocks still pass.

- [ ] **Step 3: Implement `gradeRoster` in `tools/silhouette-metrics.mjs`**

Append to the module:

```js
/**
 * Grade a recorded roster against READABILITY.
 *
 * Two directions of threshold, and they ratchet in opposite directions:
 * `px40`, `tierArea`, `eliteDelta`, `eliteChroma` and `holes` are floors (more
 * is better, an exemption caps how far *under* the floor a unit may sit);
 * `familyIoU` and `foeFriendIoU` are ceilings (less is better, an exemption
 * caps how far *over* it a pair may sit).
 *
 * The exemption list is the honest half of this. A gate authored against a
 * roster it has never measured is a gate that goes red on arrival and gets
 * switched off within a week. This one is allowed to admit what the roster
 * already is — once, in writing, with the measured value and the record it
 * came from — and is then absolute about anything new or anything worse.
 */
export function gradeRoster(record, exemptions = READABILITY.exemptions) {
  const checks = [];
  const ex = (id, kind) => exemptions.find((e) => e.id === id && e.kind === kind) || null;

  const floor = (id, kind, value, limit) => {
    const e = ex(id, kind);
    const bar = e ? Math.min(limit, e.value) : limit;
    checks.push({ id, kind, value, floor: bar, ok: value >= bar, exempt: !!e });
  };
  const ceiling = (id, kind, value, limit) => {
    const e = ex(id, kind);
    const bar = e ? Math.max(limit, e.value) : limit;
    checks.push({ id, kind, value, ceiling: bar, ok: value <= bar, exempt: !!e });
  };

  for (const u of record.units || []) {
    floor(u.id, 'px40', u.px40, READABILITY.minPx40);
    floor(u.id, 'holes', u.holesFrac, READABILITY.minHoles);
  }
  for (const p of record.familyPairs || []) {
    ceiling(`${p.a}/${p.b}`, 'familyIoU', p.iou, READABILITY.maxFamilyIoU);
  }
  for (const p of record.foeFriendPairs || []) {
    ceiling(`${p.a}/${p.b}`, 'foeFriendIoU', p.iou, READABILITY.maxFoeFriendIoU);
  }
  // Tier separation is a property of consecutive tiers, so it is graded on the
  // pairs that exist in the record rather than on a fixed 1..4.
  const tiers = Object.keys(record.tierMedianPx || {}).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < tiers.length; i++) {
    const lo = record.tierMedianPx[tiers[i - 1]], hi = record.tierMedianPx[tiers[i]];
    floor(`tier${tiers[i - 1]}->${tiers[i]}`, 'tierArea', lo > 0 ? hi / lo : 0,
          READABILITY.minTierAreaRatio);
  }
  for (const e of record.elites || []) {
    floor(`${e.id}:${e.affix}`, 'eliteDelta', e.delta, READABILITY.minEliteDelta);
    floor(`${e.id}:${e.affix}`, 'eliteChroma', e.chroma, READABILITY.minEliteChroma);
  }

  return { ok: checks.every((c) => c.ok), checks };
}
```

- [ ] **Step 4: Add the CLI and the enemy render passes to `tools/silhouette.mjs`**

Argument parsing at the top, replacing the hardcoded `const SEED = 1337;` (the file's own doc comment already advertises `--seed` and the code never read it — that is fixed here):

```js
// Walk argv token by token, same shape as tools/capture.mjs's parser.
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const tok = process.argv[i];
  if (!tok.startsWith('--')) continue;
  const eq = tok.indexOf('=');
  if (eq !== -1) { args[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
  const next = process.argv[i + 1];
  args[tok.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const SEED = Number(args.seed ?? 1337);
const ENEMIES = 'enemies' in args;
const JSON_OUT = typeof args.json === 'string' ? args.json : null;
const RANGE = Number(args.range ?? 40);   // metres, the spec's read distance
```

Then, after the existing survivor `masks` evaluate and **before** `await browser.close()`, add the enemy pass. It runs in the same page, on the same stopped engine, reusing `ctx.pipeline.renderer`:

```js
const roster = ENEMIES ? await page.evaluate(async ([w, h, range]) => {
  const THREE = globalThis.__GAME__.THREE;
  const ctx = globalThis.__GAME__.ctx;
  const renderer = ctx.pipeline.renderer;
  const { SPAWN_CARDS, BOSS_CARDS } = await import('/src/data/enemies.js');
  const { acquireRig, releaseRig, makeAnim, ELITE } = await import('/src/entities/EnemyMeshes.js');

  const cards = [...SPAWN_CARDS, ...BOSS_CARDS];
  // Elite reads are graded on one representative per tier rather than on the
  // whole cross product: the affix decoration is built from the same ELITE
  // table for every host, so nineteen hosts times six affixes measures the
  // table nineteen times and the roster once.
  const ELITE_HOSTS = ['beetle', 'golem', 'hulk'];
  const AFFIXES = Object.keys(ELITE);

  // One box for every unit, sized to the tallest thing in the roster so the
  // masks come back at true relative scale — the same contract the survivor
  // box has, at monster scale. `radius` is the card's own, doubled, because a
  // maw is wider than it is tall and a box solved on height alone clips it.
  const maxH = Math.max(...cards.map((c) => c.height));
  const maxR = Math.max(...cards.map((c) => c.radius));
  const halfH = maxH * 0.62;
  const halfW = halfH * (w / h);
  const box = { halfW: Math.max(halfW, maxR * 1.4), halfH, cy: maxH * 0.5 };

  const rt = new THREE.WebGLRenderTarget(w, h);
  const buf = new Uint8Array(w * h * 4);
  const ortho = new THREE.OrthographicCamera(-box.halfW, box.halfW, box.halfH, -box.halfH, 0.1, 200);
  ortho.position.set(0, box.cy, 60);
  ortho.lookAt(0, box.cy, 0);

  // The 40 m read. FOV and buffer size come off the live camera and the live
  // pipeline rather than being written down here: the question the spec asks
  // is whether the unit reads at 40 m *in this game*, and a hardcoded lens
  // would answer it about a different one.
  const persp = new THREE.PerspectiveCamera(ctx.camera.fov, w / h, 0.1, 400);
  persp.position.set(0, 1.6, range);
  persp.lookAt(0, 1.2, 0);

  const pack = () => {
    const bits = new Uint8Array(Math.ceil(w * h / 8));
    let lit = 0;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;       // readRenderTargetPixels is bottom-up
      for (let x = 0; x < w; x++) {
        if (buf[(src + x) * 4] < 128) {
          const i = y * w + x;
          bits[i >> 3] |= 1 << (i & 7);
          lit++;
        }
      }
    }
    return { b64: btoa(String.fromCharCode(...bits)), lit };
  };

  // Colour readback for the affix chroma check: mean per-channel value over
  // the pixels that are not background. A silhouette cannot see a tint, and
  // the tint is half of what an affix is.
  const meanColour = () => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (buf[o] > 246 && buf[o + 1] > 246 && buf[o + 2] > 246) continue;  // background
      r += buf[o]; g += buf[o + 1]; b += buf[o + 2]; n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : [0, 0, 0];
  };

  const shoot = (cam, scene) => {
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(null);
  };

  /** One rig, posed at its idle, in a scene of its own. */
  const stand = (card, affix, silhouette) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    if (silhouette) scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    else {
      // Flat, frontal, and identical for every unit: the chroma read must
      // measure the affix's tint, not where the sun happens to be.
      scene.add(new THREE.AmbientLight(0xffffff, 1.6));
      const key = new THREE.DirectionalLight(0xffffff, 1.4);
      key.position.set(0.4, 1, 1);
      scene.add(key);
    }
    const rig = acquireRig(card.meshFactory);
    rig.setAffix(affix || null);
    const anim = makeAnim();
    // `makeAnim()` starts `state` at '' and the animators branch on it.
    // Before writing this line, grep `a.state ===` / `anim.state ===` in
    // src/entities/EnemyMeshes.js and use whatever string the idle branch
    // actually tests for; '' may already *be* the idle path, in which case
    // this assignment is wrong and should be deleted rather than guessed at.
    anim.state = 'idle';
    // Same settle the survivor pass uses: 150 steps of 1/60 lands every rig
    // at the same phase of its own idle, which is what makes two runs of this
    // tool comparable at all.
    for (let i = 0; i < 150; i++) { anim.t += 1 / 60; rig.animate(rig, anim, 1 / 60); }
    rig.root.position.set(0, 0, 0);
    rig.root.rotation.y = 0.24;         // the roster shot's off-axis idle
    scene.add(rig.root);
    return { scene, rig };
  };

  const units = [], elites = [];
  for (const card of cards) {
    const s = stand(card, null, true);
    shoot(ortho, s.scene);
    const o = pack();
    shoot(persp, s.scene);
    const p = pack();
    units.push({ id: card.id, name: card.name, tier: card.tier, height: card.height,
                 mask: o.b64, px40: p.lit });
    releaseRig(s.rig);
  }
  for (const id of ELITE_HOSTS) {
    const card = cards.find((c) => c.id === id);
    if (!card) continue;
    const plainS = stand(card, null, true);
    shoot(ortho, plainS.scene);
    const plainMask = pack().b64;
    releaseRig(plainS.rig);
    const plainC = stand(card, null, false);
    shoot(persp, plainC.scene);
    const plainCol = meanColour();
    releaseRig(plainC.rig);
    for (const affix of AFFIXES) {
      const eS = stand(card, affix, true);
      shoot(ortho, eS.scene);
      const eMask = pack().b64;
      releaseRig(eS.rig);
      const eC = stand(card, affix, false);
      shoot(persp, eC.scene);
      const eCol = meanColour();
      releaseRig(eC.rig);
      elites.push({ id, affix, plainMask, eliteMask: eMask, plainCol, eliteCol: eCol });
    }
  }
  rt.dispose();
  return { units, elites, fov: ctx.camera.fov };
}, [W, H, RANGE]) : null;
```

- [ ] **Step 5: Measure, grade, record and exit** — after `await server.close()` and after the existing survivor tables print, add:

```js
if (roster) {
  const { execSync } = await import('node:child_process');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');

  const measured = roster.units.map((u) => {
    const m = measureMask(u.mask, W, H);
    return { ...u, m, holesFrac: m.bw ? +(m.holes / (m.bw * m.bh)).toFixed(4) : 0 };
  });

  const familyPairs = [];
  for (let i = 0; i < measured.length; i++) for (let j = i + 1; j < measured.length; j++) {
    familyPairs.push({ a: measured[i].id, b: measured[j].id,
                       iou: +shapeIoU(measured[i].m.sig, measured[j].m.sig).toFixed(4) });
  }
  // The survivor masks are already in `M` from the pass above — friend/foe is
  // the cross product of the two rosters, which is the only place in this tool
  // where a monster and a survivor are compared at all.
  const foeFriendPairs = [];
  for (const e of measured) for (const sid of Object.keys(M)) {
    foeFriendPairs.push({ a: e.id, b: sid, iou: +shapeIoU(e.m.sig, M[sid].sig).toFixed(4) });
  }

  const tierMedianPx = {};
  for (const t of [...new Set(measured.map((u) => u.tier))].sort((a, b) => a - b)) {
    const px = measured.filter((u) => u.tier === t).map((u) => u.px40).sort((a, b) => a - b);
    tierMedianPx[t] = px[(px.length - 1) >> 1];
  }

  const elites = roster.elites.map((e) => {
    const a = measureMask(e.plainMask, W, H), b = measureMask(e.eliteMask, W, H);
    const chroma = Math.max(
      Math.abs(e.plainCol[0] - e.eliteCol[0]),
      Math.abs(e.plainCol[1] - e.eliteCol[1]),
      Math.abs(e.plainCol[2] - e.eliteCol[2]),
    );
    return { id: e.id, affix: e.affix,
             delta: +(1 - shapeIoU(a.sig, b.sig)).toFixed(4), chroma: +chroma.toFixed(4) };
  });

  const record = {
    tool: 'tools/silhouette.mjs --enemies',
    commit: execSync('git rev-parse HEAD').toString().trim(),
    seed: SEED, range: RANGE, width: W, height: H, fov: roster.fov,
    // Which adapter drew this. Two records produced under different renderers
    // are not directly comparable, and a reader diffing them needs to know
    // that before concluding the roster moved. See Step 0.
    renderer: SOFTWARE ? 'swiftshader' : 'd3d11',
    units: measured.map(({ id, name, tier, height, px40, holesFrac, m }) => ({
      id, name, tier, height, px40, holesFrac,
      bbox: `${m.bw}x${m.bh}`, fill: m.fill, aspect: m.aspect, bands: m.bands.map((b) => +b.w.toFixed(3)),
    })),
    familyPairs, foeFriendPairs, tierMedianPx, elites,
  };
  const graded = gradeRoster(record);
  record.ok = graded.ok;
  record.checks = graded.checks;

  console.log('\n=== READABILITY GATE ===');
  console.log('id            tier  px@40m  holes%  worst-family-IoU');
  for (const u of measured) {
    const worst = familyPairs.filter((p) => p.a === u.id || p.b === u.id)
      .reduce((w, p) => (p.iou > w.iou ? p : w), { iou: 0, a: '', b: '' });
    console.log(`${u.id.padEnd(13)} ${String(u.tier).padStart(2)}   ${String(u.px40).padStart(6)}`
      + `  ${(u.holesFrac * 100).toFixed(2).padStart(6)}  ${worst.iou.toFixed(3)} (${worst.a}/${worst.b})`);
  }
  const bad = graded.checks.filter((c) => !c.ok);
  console.log(`\n${graded.checks.length - bad.length}/${graded.checks.length} checks passed`);
  for (const c of bad) {
    console.log(`  FAIL ${c.kind} ${c.id}: ${c.value} vs `
      + (c.floor !== undefined ? `floor ${c.floor}` : `ceiling ${c.ceiling}`));
  }
  for (const c of graded.checks.filter((c2) => c2.exempt)) {
    console.log(`  EXEMPT ${c.kind} ${c.id}: ${c.value}`);
  }

  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(record, null, 2));
    console.log(`\nrecord -> ${JSON_OUT}`);
  }
  // The exit code is the gate. A tool that prints a failure and exits 0 is a
  // report, and this slice's job is to turn the report into a gate.
  process.exit(graded.ok ? 0 : 1);
}
```

Add `gradeRoster` to the import line written in Task 1: `import { measureMask, shapeIoU, gradeRoster } from './silhouette-metrics.mjs';`.

- [ ] **Step 6: Run the gate and record what the roster actually is**

Run: `node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json`

Read the printed table and the FAIL list. Then, for each failure, make exactly one decision and write it down:

- **A wrong measurement** (a rig that rendered empty, a box that clipped a boss, a card whose `meshFactory` is shared so two ids measure the same rig — `anchor` reuses `brood` and `warden_vault` reuses `warden`, so those two pairs will read at IoU ~1.0 and are *expected*): fix the tool, or — for the shared-rig pairs specifically — record them as exemptions with the note `shared meshFactory: <factory>`, because they are one silhouette by design and the gate must say so out loud rather than be quietly loosened.
- **A real content failure**: record it as an exemption at its measured value with a note naming what is wrong, and list it in the task's report as slice-3 or content work. **Do not retune `READABILITY` to make it pass** — the thresholds are the design intent and the exemptions are the debt; collapsing the two loses the distinction the ratchet is made of.

Write the surviving exemptions into `READABILITY.exemptions` in `tools/silhouette-metrics.mjs`, each as `{ id, kind, value, note }` with the value copied from the record. Re-run the command; it must now exit 0. Re-run it a second time and confirm the record is byte-identical apart from `commit` — a gate that moves between two runs of the same tree is measuring the wall clock, and if it does, say so in the report and stop rather than committing a noisy baseline.

(Append `--software` to every invocation in this step if that is the mode Step 0 established. A record whose `renderer` field disagrees with the mode actually used is worse than no record.)

- [ ] **Step 7: Write `reviews/round9/README.md`**

```markdown
# round9 — readability gate and combat-juice evidence

## `readability-gate.json`

Produced by:

    node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json

Every enemy card the director can spawn (`SPAWN_CARDS` + `BOSS_CARDS`) rendered
twice: once flat black in a shared orthographic box at true relative scale, and
once at `range` metres through the live camera's own FOV at the capture
harness's 1600x900. The first pass answers "is this a different shape from
everything else"; the second answers "is there enough of it on screen at 40 m
to read at all". Six affixes on three representative hosts add the elite pass,
graded on both outline delta and mean colour delta, since a silhouette cannot
see a tint and the tint is half of what an affix is.

`checks` is the graded result. `ok: false` on any non-exempt check exits the
tool non-zero. Exemptions live in `READABILITY.exemptions`
(`tools/silhouette-metrics.mjs`), each carrying the value measured when it was
admitted; the gate passes an exempted check only while it is no worse than
that. Anything new, and anything that degrades, is red.

Re-run the command after any change to `src/entities/EnemyMeshes.js`,
`src/data/enemies.js` or the elite table.
```

- [ ] **Step 8: Run tests**

Run: `node tests/readability-gate.test.mjs` — PASS (the roster-coverage block now finds the record).
Run: `npm test` — green.

sp-equivalence is **not** a gate for this task: nothing under `src/` changed. Say so in the report rather than running it and reporting a green that means nothing.

- [ ] **Step 9: Commit**

```bash
git add tools/silhouette.mjs tools/silhouette-metrics.mjs tests/readability-gate.test.mjs reviews/round9/
git commit -m "Every monster stands in the same box: the roster stops being a matter of opinion"
```

---

### Task 3: A hit says what killed you in colour

**Files:**
- Create: `src/data/damageTypes.js`
- Modify: `src/systems/Combat.js` (one field on the `damage` payload at `:537-540`; `explode`'s `applyDamage` info at `:414`; the DOT-tick info at `:717-720`)
- Modify: `src/data/abilities.js` (`damageGroup`'s `applyDamage` info at `:224-231`)
- Modify: `src/systems/VFX.js` (`_onDamage`, the `hitSpark` call at `:1169`)
- Test: `tests/damage-elements.test.mjs`

**Interfaces:**
- Consumes: `info.type` as it already exists on the damage info (`'projectile'`, `'hitscan'`, `'melee'`, `'blast'`, `'fire'`, `'frost'`, `'lightning'`, `'overload'`, `'meteor'`, `'missile'`, `'spore'`, `'thorns'`, `'swarm'`, `'razor'`, `'rebar'`, `'sticky'`, `'gall'`, `'behemoth'`, `'resonance'`, `'gravity'`, `'kinetic'`, `'scrapfly'`, `'reflect'`, `'void'`, and whatever the next item adds — the vocabulary is open and this module must never assume it is closed); the status vocabulary `'burn'`, `'slow'`, `'shock'`, `'bleed'`, `'freeze'` (`STATUS_DEFS`, `src/systems/Combat.js:25-31`), of which only the first three are applied by any live call site.
- **`info.status` does not currently exist on any `applyDamage` info object.** Step 4b creates it. Both live status-applying call sites destructure `status` out of their options and route it to `applyStatus` *separately*, never forwarding it into the object handed to `applyDamage`: `Combat.explode` (`:401` destructure, `:414` the `applyDamage` call, `:415` the `applyStatus` call) and `damageGroup` (`src/data/abilities.js:224` destructure, `:230` / `:231` the same split). And the DOT-tick site (`:717-720`) sets `type: s.type` — the *status name*, e.g. `'burn'` — which is not a `TYPE_ELEMENT` key, so without Step 4b every burn tick, every shock tick, every repeated and highly visible tick of damage in the game renders as a generic kinetic spark. Step 4b is what makes the status fallback this module builds actually fire.
- Produces:
  - `ELEMENTS` — the closed set of read families: `['kinetic', 'fire', 'ice', 'shock', 'nature', 'void', 'blast']`.
  - `elementOf(type, status) -> string` — always one of `ELEMENTS`, never undefined, `'kinetic'` for anything unrecognised including `null`/`undefined`.
  - `sparkColour(element, crit) -> number` — one hex, for `VFX.hitSpark`'s single-colour parameter. **`sparkColour('kinetic', true) === 0xffd24a` and `sparkColour('kinetic', false) === 0xffe9b0`**, i.e. byte-identical to the values shipping today, so an untyped hit renders exactly as it does now.
  - `ELEMENT_HUE` — `{ core, tail, critTail, ring }` per element. Task 5 adds `killCore` / `killTail` to the `kinetic` entry only, and reads `killCore ?? core` / `killTail ?? tail` for the other six.
  - `damage` event gains `type: string` (always present, `'hit'` when the info carried none — the same default `_dispatch('onHit')` already uses at `Combat.js:570`).

- [ ] **Step 1: Write the failing test**

```js
// tests/damage-elements.test.mjs
//
// The damage vocabulary is open — every item that deals damage may invent a
// type string — and the read families are closed. This file pins the mapping
// between them, and pins hardest on the one property that keeps the change
// invisible where it should be: an untyped hit must render exactly as it did
// before elements existed.
import { ELEMENTS, ELEMENT_HUE, elementOf, sparkColour } from '../src/data/damageTypes.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('the read families are closed and every one has a hue');
{
  ok(ELEMENTS.length === 7, 'seven families');
  ok(ELEMENTS[0] === 'kinetic', 'kinetic is the default and comes first');
  for (const e of ELEMENTS) {
    const h = ELEMENT_HUE[e];
    ok(h && Number.isInteger(h.core) && Number.isInteger(h.tail) && Number.isInteger(h.ring),
       `${e} carries core/tail/ring hexes`);
  }
}

console.log('an open vocabulary lands in a closed set');
{
  ok(elementOf('fire') === 'fire' && elementOf('meteor') === 'fire', 'the fire family');
  ok(elementOf('frost') === 'ice', 'the ice family');
  ok(elementOf('lightning') === 'shock' && elementOf('overload') === 'shock'
     && elementOf('resonance') === 'shock', 'the shock family');
  ok(elementOf('spore') === 'nature' && elementOf('swarm') === 'nature'
     && elementOf('thorns') === 'nature', 'the nature family');
  ok(elementOf('void') === 'void', 'the void family');
  ok(elementOf('blast') === 'blast' && elementOf('missile') === 'blast'
     && elementOf('behemoth') === 'blast', 'the blast family');
  ok(elementOf('melee') === 'kinetic' && elementOf('hitscan') === 'kinetic'
     && elementOf('projectile') === 'kinetic' && elementOf('hit') === 'kinetic',
     'the ordinary hit is kinetic');
}

console.log('anything unmapped is kinetic, and nothing throws');
{
  ok(elementOf('a-type-no-one-has-written-yet') === 'kinetic', 'an unknown type is kinetic');
  ok(elementOf(undefined) === 'kinetic' && elementOf(null) === 'kinetic', 'so is nothing at all');
  ok(elementOf(7) === 'kinetic' && elementOf({}) === 'kinetic', 'so is a non-string');
  ok(ELEMENTS.includes(elementOf('reflect')), 'every answer is in the closed set');
}

console.log('a status names the element when the type does not');
{
  ok(elementOf('hit', 'burn') === 'fire', 'a burning ordinary hit reads as fire');
  ok(elementOf('hit', 'slow') === 'ice', 'a chilling one reads as ice');
  ok(elementOf('hit', 'shock') === 'shock', 'and a shocking one as shock');
  ok(elementOf('frost', 'burn') === 'ice', 'but an explicit type outranks the status it also applies');
  ok(elementOf(null, 'burn') === 'fire', 'the status alone is enough');
  ok(elementOf('hit', 'nonsense') === 'kinetic', 'an unknown status changes nothing');
}

console.log('the default spark is the spark that ships today');
{
  // src/systems/VFX.js:1169 — `p.crit ? 0xffd24a : 0xffe9b0`. Every untyped hit
  // in the game goes through this pair, and if either moves, sp-equivalence is
  // not what catches it — nothing is.
  ok(sparkColour('kinetic', false) === 0xffe9b0, 'plain kinetic is the shipped 0xffe9b0');
  ok(sparkColour('kinetic', true) === 0xffd24a, 'crit kinetic is the shipped 0xffd24a');
  ok(sparkColour('nope', false) === 0xffe9b0, 'an unknown element falls back to kinetic, not to black');
}

console.log('every other element is a different colour, and crits are hotter');
{
  const seen = new Set();
  for (const e of ELEMENTS) {
    const c = sparkColour(e, false);
    ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `${e} spark is a hex`);
    ok(!seen.has(c), `${e} spark is distinct from every element before it`);
    seen.add(c);
    ok(sparkColour(e, true) !== c, `${e} crit differs from its plain spark`);
  }
}

/* -------------------------------------------------------------------------
 * The end-to-end arm.
 *
 * Everything above tests `elementOf` in isolation, and `elementOf` in
 * isolation was already going to pass before any of the forwarding in Step 4b
 * existed. That is exactly the shape of a green test over a feature that does
 * not fire: the status fallback has no live caller until `explode`,
 * `damageGroup` and the DOT tick actually put `status` on the info object.
 * So this block drives the real `Combat` and reads the real `damage` event.
 * ---------------------------------------------------------------------- */
console.log('a burn tick reaches the damage event as fire, through real Combat');
{
  const THREE = await import('three');
  const { Combat } = await import('../src/systems/Combat.js');

  // The headless world fixture tests/shrike-detonate.test.mjs establishes.
  const events = [];
  const ctx = {
    time: 0, authority: true,
    rng: { next: () => 0.5, range: (a, b) => (a + b) * 0.5 },
    scene: new THREE.Scene(),
    events: { emit(name, p) { events.push({ name, p }); }, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);

  const source = { isPlayer: true, alive: true, team: 'player', stats: { damage: 20 },
                   position: new THREE.Vector3(0, 0, 0) };
  const victim = { alive: true, team: 'monster', health: 5000, maxHealth: 5000, shield: 0,
                   radius: 0.5, position: new THREE.Vector3(3, 0, 0) };

  // STATUS_DEFS.burn is { duration: 4.0, tick: 0.5, ... } (Combat.js:26), and
  // a fresh stack starts with `timer` at `tick`, so exactly one 0.5 s step
  // fires exactly one tick.
  combat.applyStatus(victim, 'burn', source, 1);
  events.length = 0;
  combat._tickStatuses(ctx, 0.5);

  const dmg = events.filter((e) => e.name === 'damage').map((e) => e.p);
  ok(dmg.length === 1, `the burn ticked once (got ${dmg.length} damage events)`);
  ok(dmg[0]?.status === 'burn', 'and the event carries the status that dealt it');
  ok(elementOf(dmg[0]?.type, dmg[0]?.status) === 'fire',
     'so the spark that ticks off a burning monster is a fire spark, not a kinetic one');
  ok(sparkColour(elementOf(dmg[0]?.type, dmg[0]?.status), false) === ELEMENT_HUE.fire.tail,
     'and it draws the fire tail colour');
}

console.log('an explosion forwards the status it also applies');
{
  const THREE = await import('three');
  const { Combat } = await import('../src/systems/Combat.js');
  const events = [];
  const ctx = {
    time: 0, authority: true,
    rng: { next: () => 0.5, range: (a, b) => (a + b) * 0.5 },
    scene: new THREE.Scene(),
    events: { emit(name, p) { events.push({ name, p }); }, on() {} },
  };
  const combat = new Combat();
  combat.init(ctx);
  const source = { isPlayer: true, alive: true, team: 'player', stats: { damage: 20 },
                   position: new THREE.Vector3(0, 0, 0) };
  const victim = { alive: true, team: 'monster', health: 5000, maxHealth: 5000, shield: 0,
                   radius: 0.5, position: new THREE.Vector3(1, 0, 0) };
  combat.add?.(victim);
  events.length = 0;
  combat.explode(new THREE.Vector3(0, 0, 0), 6, 50, source, { proc: 0, type: 'fire', status: 'burn' });
  const dmg = events.filter((e) => e.name === 'damage').map((e) => e.p);
  ok(dmg.length >= 1, 'the blast damaged the victim');
  ok(dmg[0]?.status === 'burn', 'and told presentation what it lit');
  ok(elementOf(dmg[0]?.type, dmg[0]?.status) === 'fire', 'which reads as fire either way here');
}
```

**Implementer note on the two blocks above:** they call `combat.add?.(victim)` and `combat._tickStatuses(ctx, h)` against the live class. Read `tests/shrike-detonate.test.mjs`'s `makeWorld()` first and match whatever it actually does to register an entity with the spatial hash — if the registration method is named something other than `add`, use the real one, and if `explode`'s `sphereOverlap` needs a `fixedUpdate` pass to index the victim, drive one. The assertions are the contract; the fixture is the file's existing idiom, not a new one.

```js
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/damage-elements.test.mjs`
Expected: FAIL — cannot find module `../src/data/damageTypes.js`. After Step 3 alone it still fails: the two end-to-end blocks go red on `dmg[0].status === 'burn'` because nothing puts `status` on the event yet. That second failure is the one Step 4b exists to fix, and seeing it is the point of running the suite between Step 3 and Step 4b.

- [ ] **Step 3: Write `src/data/damageTypes.js`**

```js
/**
 * Damage types, and the seven ways a hit is allowed to look.
 *
 * `info.type` is an open vocabulary: it is written by hand at ~30 call sites
 * across abilities, items and equipment, and every new item may invent
 * another. It is a *provenance* string ("this came from the missile rack"),
 * not a taxonomy, and presentation cannot key off it directly without
 * silently rendering every future item as whatever the fallback happens to be.
 *
 * So there are two vocabularies. The open one stays where it is; this module
 * owns the closed one — seven read families — and the projection between them.
 * An unmapped type is `kinetic`, which is the family whose colours are exactly
 * the ones the game shipped before any of this existed. That is the property
 * that makes the change safe: an item nobody remapped looks the way it always
 * did, rather than looking wrong.
 *
 * The hues are not new paint. Each family borrows the colour its own affix
 * already owns in `EnemyMeshes.ELITE` — blazing's 0xff6a10, glacial's
 * 0x46c4f0, overloading's 0x2f5cff, withering's 0x2fbf6a, voidtouched's
 * 0x8a2fd0 — so a fire hit and a Blazing elite are the same fire, and the
 * game keeps one palette instead of growing a second one for damage.
 */

/** The closed set. `kinetic` is first because it is the default. */
export const ELEMENTS = ['kinetic', 'fire', 'ice', 'shock', 'nature', 'void', 'blast'];

/**
 * core  — the hot centre of a spark or a kill burst
 * tail  — what it cools to; this is the hex `VFX.hitSpark` takes
 * ring  — the expanding ring / shockwave colour (Task 5's kill VFX)
 */
export const ELEMENT_HUE = {
  // The shipped values, unchanged. `tail` here is the exact literal that was
  // hardcoded at VFX.js:1169 and `critTail` the exact crit literal beside it.
  // `killCore` / `killTail` / `killFlick` exist on this entry alone. The kill
  // burst, the kill ring and the kill light each carry their own literal in
  // the shipped `_onKill`, and they are not the same literal — the ring is
  // 0xff7030 and the light is 0xff8030. Task 5 reads `killX ?? X`, so the six
  // other families fall back to their own hues and the default death stays
  // byte-identical down to the single channel that differs between those two.
  kinetic: {
    core: 0xfff0c8, tail: 0xffe9b0, critTail: 0xffd24a, ring: 0xff7030,
    killCore: 0xffffff, killTail: 0xff5a20, killFlick: 0xff8030,
  },
  fire:    { core: 0xffe0a8, tail: 0xff6a10, critTail: 0xff3a08, ring: 0xff4a10 },
  ice:     { core: 0xe4f8ff, tail: 0x46c4f0, critTail: 0x8ae8ff, ring: 0x4fb8e8 },
  shock:   { core: 0xe0e8ff, tail: 0x2f5cff, critTail: 0x74a6ff, ring: 0x4a78ff },
  nature:  { core: 0xe4ffe8, tail: 0x2fbf6a, critTail: 0x86ffb4, ring: 0x3fd07a },
  void:    { core: 0xffd0f0, tail: 0x8a2fd0, critTail: 0xff2fb0, ring: 0xb64ad0 },
  blast:   { core: 0xfff4d0, tail: 0xff9a30, critTail: 0xffc450, ring: 0xffb040 },
};

/**
 * Provenance string -> read family. Anything absent is kinetic; the map is
 * deliberately not exhaustive over the live vocabulary, because it cannot be:
 * the point is that it does not need to be.
 */
const TYPE_ELEMENT = {
  fire: 'fire', meteor: 'fire',
  frost: 'ice',
  lightning: 'shock', overload: 'shock', resonance: 'shock',
  spore: 'nature', swarm: 'nature', thorns: 'nature',
  void: 'void',
  blast: 'blast', missile: 'blast', behemoth: 'blast', sticky: 'blast', gravity: 'blast',
};

/**
 * Status -> read family, used only when the type says nothing. A hit that
 * lights a burn is a fire hit even when it arrived as a plain bullet, which
 * is the case for most of the on-hit item procs.
 */
const STATUS_ELEMENT = { burn: 'fire', slow: 'ice', shock: 'shock' };

/** Always one of ELEMENTS. Never throws, never returns undefined. */
export function elementOf(type, status) {
  if (typeof type === 'string') {
    const e = TYPE_ELEMENT[type];
    if (e) return e;
  }
  if (typeof status === 'string') {
    const s = STATUS_ELEMENT[status];
    if (s) return s;
  }
  return 'kinetic';
}

/** The single hex `VFX.hitSpark(pos, colour, scale)` wants. */
export function sparkColour(element, crit) {
  const h = ELEMENT_HUE[element] || ELEMENT_HUE.kinetic;
  return crit ? h.critTail : h.tail;
}
```

- [ ] **Step 4: Carry the type on the `damage` event**

In `src/systems/Combat.js`, the `damage` emit (currently `:537-540`) gains one field:

```js
    ctx.events.emit('damage', {
      target, source, amount: incoming, toHealth: dealt, absorbed: incoming - dealt,
      crit, position: pos, proc: info.procCoefficient || 0,
      // What the hit was, for presentation only. `'hit'` is the same default
      // the proc dispatch below already uses, so an info with no type reads
      // identically on both channels. Nothing in gameplay may key off this:
      // the authority for what a hit *does* is `info`, and this is what it
      // looks like. `status` rides along because most on-hit procs are plain
      // bullets that light something — the colour is the status, not the gun.
      type: info.type || 'hit', status: info.status || null,
    });
```

No other line in `applyDamage` changes. No RNG is drawn, no branch is added, no value is recomputed — this is two reads of an object the function already holds. `NetHost.sanitise` (`src/net/NetHost.js:622-652`) passes strings through unchanged and drops `null`s, so the field crosses the wire on the forwarded path with no whitelist edit.

- [ ] **Step 4b: Make `info.status` actually exist**

The field Step 4 forwards is read off `info`, and **no live call site puts it there.** Three edits close that, and all three are the same shape: add one key to an object literal that is already being built. No branch, no draw, no reordering, nothing gameplay reads.

`src/systems/Combat.js`, `explode`'s inner `applyDamage` call (`:414`). `status` is already destructured at `:401` and already spent on `applyStatus` at `:415`; it simply never travelled on the damage info:

```js
      // `status` rides along for presentation only — `applyStatus` below is
      // still the thing that applies it. Without this the blast that lights a
      // burn colours its own spark correctly (its `type` is real) but has no
      // way to tell the tick sparks that follow what family they belong to.
      this.applyDamage(e, amount, { source, procCoefficient: proc, procDepth, position: point, type, status });
      if (status) this.applyStatus(e, status, source, 1);
```

`src/data/abilities.js`, `damageGroup` (`:230`), which splits the same way (`status` destructured at `:224`, applied at `:231`):

```js
      c.applyDamage(e, damage, { source: player, procCoefficient: proc, position: e.position, type, status });
      if (status) c.applyStatus?.(e, status, player, 1);
```

`src/systems/Combat.js`, the DOT tick in `_tickStatuses` (`:717-720`). This one is the important one — it is the path that fires every 0.5 s on every burning monster in the game — and it needs a *new* key rather than a forwarded one, because `type: s.type` is already carrying the status name (`'burn'`) and **must keep doing so**: items key off `info.type` (Afflictor's Index, per the comment at `src/data/abilities.js:1145`), so changing it would be a gameplay change. Adding `status` beside it is not:

```js
            this.applyDamage(entity, s.damage, {
              source: s.source, isDot: true, crit: false,
              // `type` stays the status name because items key off it. `status`
              // is the same string on a channel only presentation reads, which
              // is what lets `elementOf` resolve a burn tick to fire instead of
              // falling through to kinetic. Two keys, one value, two audiences.
              procCoefficient: 0, procDepth: MAX_PROC_DEPTH, type: s.type, status: s.type,
            });
```

sp-equivalence exposure: none. Three object literals gain one key each; `applyDamage` reads `info.status` only where Step 4 puts it on a presentation event. The damage numbers, the crit roll, the armour curve, the proc chain and the kill decision are untouched, and no code path branches on the new key.

- [ ] **Step 5: Spend it in `src/systems/VFX.js`**

Import at the top, next to the other data imports:

```js
import { elementOf, sparkColour, ELEMENT_HUE } from '../data/damageTypes.js';
```

In `_onDamage`, replace the single `hitSpark` line (`:1169`) with:

```js
    // The colour is the damage's own family, not the weapon's. A frost round
    // and a fire round out of the same barrel have to look like two different
    // things or the elemental items are invisible in the one place the player
    // is actually looking. Untyped hits resolve to `kinetic`, whose hexes are
    // the two literals this line used to carry.
    const element = elementOf(p.type, p.status);
    this.hitSpark(_h1, sparkColour(element, p.crit), p.crit ? 1.35 : 1);
```

and give the flash the same family, replacing the `hitFlash` line below it:

```js
    this.hitFlash(target, p.crit ? ELEMENT_HUE[element].critTail : ELEMENT_HUE[element].core,
                  p.crit ? 0.09 : 0.06);
```

(`hitFlash`'s shipped literals are `p.crit ? 0xffe0a0 : 0xffffff`. `kinetic.core` is `0xfff0c8` and `kinetic.critTail` is `0xffd24a`, so this line *does* move for an ordinary hit — deliberately, and it is a flash tint on the victim's own material, not a spark. If the report wants strict invisibility at default here too, add `flash: 0xffffff` / `critFlash: 0xffe0a0` to `kinetic` and read those instead; the plan's judgment is that the spark is the identity and the flash should follow it, but either is defensible and the choice belongs in the report.)

- [ ] **Step 6: Run tests**

Run: `node tests/damage-elements.test.mjs` — PASS, **including the two end-to-end blocks**. If those two are the only failures, Step 4b was skipped or landed on the wrong call sites; the isolated `elementOf` blocks passing is not evidence the feature fires.
Run: `npm test` — green.
Run: `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` — **zero fields moved.** Two new keys on a presentation event and one new key on three info literals, no branch and no draw anywhere in the damage path; a moved field is a bug in this task. Do not regenerate the baseline.

- [ ] **Step 7: Commit**

```bash
git add src/data/damageTypes.js src/systems/Combat.js src/data/abilities.js src/systems/VFX.js tests/damage-elements.test.mjs
git commit -m "A hit stops being one colour: fire burns orange, frost bites blue, and every tick of a burn finally says so"
```

---

### Task 4: Overkill throws the body

**Files:**
- Modify: `src/systems/Combat.js` (`applyDamage` captures health before the hit; `_kill` signature and payload, `:574-587`)
- Modify: `src/systems/VFX.js` (`_onKill`, a `corpseLaunch` method, `_updateLaunches`, constructor state, `update` tail)
- Test: `tests/corpse-launch.test.mjs`

**Interfaces:**
- Consumes: `Combat._kill(victim, source, position, depth)` as it stands at `src/systems/Combat.js:579`, called from exactly one site (`:574`); `resolveObject(entity)` (`src/systems/VFX.js:1668`) which already resolves an `Enemy` to its `rig.root`; `this._dissolving` and `_updateDissolves` as the pattern to follow (`:131`, `:717`, `:1419`).
- Produces:
  - `Combat._kill(victim, source, position, depth, info, overkill)` — two new trailing parameters, both optional.
  - `kill` event gains `overkill: number` (>= 0, damage past the victim's remaining health) **and** `type: string` (the killing blow's provenance, `'hit'` when it carried none) and `status: string|null`. Task 5 consumes `type`/`status`; this task consumes `overkill`.
  - `VFX.LAUNCH = { minOverkillFrac: 0.35, maxSpeed: 11, spin: 7, gravity: 22, dur: 1.5 }` exported from `src/systems/VFX.js`.
  - `VFX.corpseLaunch(obj, dirX, dirZ, power)` — `power` in `[0, 1]`; registers a cosmetic offset. `VFX._launches` is the list; `_updateLaunches(dt)` integrates it from `update`.

- [ ] **Step 1: Write the failing test**

```js
// tests/corpse-launch.test.mjs
//
// A corpse launch is the one piece of juice in this slice that moves
// something the player can see moving, which makes it the one most likely to
// be mistaken for physics. It is not: it is an offset VFX writes on top of a
// transform Enemy rewrites from `this.position` every frame, so it touches no
// entity state, no FSM, and nothing `tests/sp-equivalence.mjs` fingerprints.
// These assertions exist mostly to keep it that way.
import * as THREE from 'three';
import { VFX, LAUNCH } from '../src/systems/VFX.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A stand-in for the rig root: the only thing a launch is allowed to touch. */
function makeCorpse() {
  const o = new THREE.Object3D();
  o.position.set(4, 0, -3);
  return o;
}

/** The bare ctx a launch needs. `rng` throws: a cosmetic launch may never
 *  draw from the shared stream. */
function makeCtx() {
  return {
    time: 0,
    rng: { next() { throw new Error('ctx.rng drawn from presentation'); },
           range() { throw new Error('ctx.rng drawn from presentation'); } },
    fxRng: { next: () => 0.5, range: (a, b) => (a + b) * 0.5 },
  };
}

console.log('the launch constants are exported and sane');
{
  ok(LAUNCH.minOverkillFrac > 0 && LAUNCH.minOverkillFrac < 1, 'a threshold, not a certainty');
  ok(LAUNCH.maxSpeed > 0 && LAUNCH.gravity > 0 && LAUNCH.dur > 0, 'speed, gravity, life');
  // Corpses are reaped at DEATH_TIME = 1.5s (src/entities/Enemy.js:25). A
  // launch that outlives its corpse is animating an object that is gone.
  ok(LAUNCH.dur <= 1.5, 'the launch cannot outlive the corpse');
}

console.log('a launch offsets the rig root and never accumulates into it');
{
  const vfx = new VFX();
  const ctx = makeCtx();
  const corpse = makeCorpse();
  const home = corpse.position.clone();

  vfx.corpseLaunch(corpse, 1, 0, 1);
  ok(vfx._launches.length === 1, 'the launch is registered');

  // Each frame the owner rewrites the transform from its own position, exactly
  // as Enemy.updateRig does, and VFX re-applies the offset on top.
  const step = (dt) => { corpse.position.copy(home); vfx._updateLaunches(dt); };

  step(1 / 60);
  const first = corpse.position.clone();
  ok(first.x > home.x, 'the body has moved along the launch direction');
  ok(first.y > home.y, 'and off the ground');

  for (let i = 0; i < 20; i++) step(1 / 60);
  ok(corpse.position.x > first.x, 'it keeps travelling');
  ok(corpse.rotation.x !== 0 || corpse.rotation.z !== 0, 'and tumbles');

  // The property that makes this cosmetic: stop re-applying and the object is
  // exactly where its owner put it, with no residue at all.
  for (let i = 0; i < 200; i++) step(1 / 60);
  ok(vfx._launches.length === 0, 'the launch retires itself');
  ok(corpse.rotation.x === 0 && corpse.rotation.z === 0,
     'and hands the tumble back — no residue on a transform nobody else rewrites');
  corpse.position.copy(home);
  vfx._updateLaunches(1 / 60);
  ok(corpse.position.equals(home), 'a retired launch writes nothing');
}

console.log('the arc rises then falls, and lands');
{
  const vfx = new VFX();
  const corpse = makeCorpse();
  const home = corpse.position.clone();
  const step = (dt) => { corpse.position.copy(home); vfx._updateLaunches(dt); return corpse.position.y - home.y; };
  vfx.corpseLaunch(corpse, 0, 1, 1);
  let peak = 0, ys = [];
  for (let i = 0; i < 90; i++) { const y = step(1 / 60); ys.push(y); if (y > peak) peak = y; }
  ok(peak > 0.5, `the body actually leaves the ground (peak ${peak.toFixed(2)}m)`);
  ok(ys[ys.length - 1] <= peak, 'and comes back down');
  ok(ys.every((y) => y >= -0.001), 'it never sinks through the floor it started on');
}

console.log('power scales the throw, and zero power throws nothing');
{
  const vfx = new VFX();
  const weak = makeCorpse(), strong = makeCorpse();
  const hw = weak.position.clone(), hs = strong.position.clone();
  vfx.corpseLaunch(weak, 1, 0, 0.2);
  vfx.corpseLaunch(strong, 1, 0, 1);
  // Six frames, not twelve: a 0.2-power launch lands at t = 2*vy/g = 0.124s,
  // i.e. frame 8. Compared after it had already retired, this block would
  // pass by measuring an offset of zero against a real one, which is a test
  // that goes green for the wrong reason.
  for (let i = 0; i < 6; i++) {
    weak.position.copy(hw); strong.position.copy(hs);
    vfx._updateLaunches(1 / 60);
  }
  ok(strong.position.x - hs.x > weak.position.x - hw.x, 'more overkill throws further');

  const still = makeCorpse();
  const h = still.position.clone();
  const before = vfx._launches.length;
  vfx.corpseLaunch(still, 1, 0, 0);
  ok(vfx._launches.length === before, 'zero power registers nothing');
  vfx.corpseLaunch(null, 1, 0, 1);
  ok(vfx._launches.length === before, 'and neither does a missing object');
  void h;
}

console.log('the same corpse is never launched twice');
{
  const vfx = new VFX();
  const corpse = makeCorpse();
  vfx.corpseLaunch(corpse, 1, 0, 1);
  vfx.corpseLaunch(corpse, -1, 0, 1);
  ok(vfx._launches.length === 1, 'a second kill event on the same body is ignored');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

**Implementer check before writing this test:** confirm `src/systems/VFX.js` imports cleanly in node and that `new VFX()` constructs without a ctx. The constructor allocates pools (`ParticleSystem`, `Trails`, `Decals`) whose `init(ctx)` is separate (`VFX.init` at `:156` is where ctx-bound work happens), so it should. Run `node -e "import('./src/systems/VFX.js').then((m) => new m.VFX())"` first. If the constructor needs a document or a GL context, move `LAUNCH`, `corpseLaunch` and `_updateLaunches` into a small pure module `src/fx/CorpseLaunch.js` that VFX composes (`this._corpses = new CorpseLaunches()`), keep every exported name identical, and point the test at that module instead. Decide this in Step 1, not after the implementation is written.

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/corpse-launch.test.mjs`
Expected: FAIL — `LAUNCH` is not exported, `corpseLaunch` is not a function.

- [ ] **Step 3: Compute overkill in `src/systems/Combat.js`**

Immediately above the health-application block (currently `const pos = info.position || target.position;` followed by `if (amount > 0) { ... }`), capture the pre-hit pool:

```js
    const pos = info.position || target.position;

    // Overkill: how much of this hit landed on a corpse. Read *before* the
    // damage is applied, because after it `target.health` is already negative
    // and the same subtraction reads as zero. `dealt` is the post-barrier
    // figure on purpose — damage a shield ate did not overkill anything.
    const hpBefore = target.health;

    if (amount > 0) {
```

Then at the kill call (`:574`):

```js
    if (target.health <= 0 && target.alive) {
      this._kill(target, source, pos, depth, info, Math.max(0, dealt - Math.max(0, hpBefore)));
    }
```

And `_kill` takes the two new parameters and puts them on the payload:

```js
  _kill(victim, source, position, depth, info = null, overkill = 0) {
    const ctx = this.ctx;
    victim.alive = false;
    victim.health = 0;
    this.statuses.delete(victim);
    if (victim.onDeath) victim.onDeath();

    ctx.events.emit('kill', {
      victim, source, position, isElite: !!victim.isElite, isBoss: !!victim.isBoss,
      // Presentation only, all three. `overkill` is damage past the victim's
      // remaining health, which is the whole of what makes a death read as
      // *emphatic* rather than as arithmetic; `type`/`status` are the killing
      // blow's provenance, so a kill can look like what killed it. Nothing in
      // gameplay may key off any of them — this event already crosses the wire
      // through `sanitise`, and a number and two strings ride it unchanged.
      overkill, type: info?.type || 'hit', status: info?.status || null,
    });
```

The rest of `_kill` is untouched. Both new parameters default, so a future caller that does not pass them behaves exactly as today — and today there is exactly one caller, the line above.

- [ ] **Step 4: Implement the launch in `src/systems/VFX.js`**

Exported constants, next to the `HITSTOP` block:

```js
/* --- corpse launch ---------------------------------------------------- *
 * A kill that lands with damage to spare throws the body. This is
 * *cosmetic by construction* and the construction is the load-bearing part:
 * the launch never writes `Enemy.position`, `Enemy.velocity` or anything the
 * FSM reads. `Enemy.updateRig` copies `this.position` into `rig.root.position`
 * every frame (`src/entities/Enemy.js:1377`) from `Director`'s update, and
 * `VFX.update` runs after it in the system order (`src/main.js:67` then `:72`;
 * `Engine._frame` drains every `fixedUpdate` before any `update`). So this
 * re-applies an offset on top of a transform its owner has just rewritten,
 * every frame, and the instant it stops the corpse is exactly where the
 * simulation always thought it was. Nothing here is visible to
 * `tests/sp-equivalence.mjs`, and that is not an accident.
 *
 * `minOverkillFrac` is a fraction of the victim's max health: a mite finished
 * by a rounding error stays where it fell, and a hit that doubled what was
 * left of it goes flying.
 * -------------------------------------------------------------------- */
export const LAUNCH = { minOverkillFrac: 0.35, maxSpeed: 11, spin: 7, gravity: 22, dur: 1.5 };
```

Constructor state, next to `this._dissolving = [];` (`:131`):

```js
    this._launches = [];
```

The two methods, after `deathDissolve`:

```js
  /**
   * Throw a corpse. `dirX`/`dirZ` is the horizontal direction (away from
   * whatever killed it); `power` in [0,1] scales speed, lift and spin.
   *
   * The record holds elapsed time and the launch's own kinematics, never a
   * position — position is recomputed from t every frame and *added* to
   * whatever the owner wrote, so two systems writing the same transform
   * compose instead of fighting.
   */
  corpseLaunch(obj, dirX, dirZ, power) {
    if (!obj?.isObject3D || !(power > 0)) return;
    for (const l of this._launches) if (l.obj === obj) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    const k = clamp(power, 0, 1);
    const speed = LAUNCH.maxSpeed * k;
    this._launches.push({
      obj, t: 0, dur: LAUNCH.dur,
      // The base rotation, captured once. `Enemy.updateRig` rewrites only
      // `rotation.y` each frame, so x and z are ours alone and must be *set*
      // from t rather than accumulated — a `+=` here would spin the corpse
      // faster every frame and leave it at an arbitrary angle when the launch
      // retired, which is residue, and residue is what makes a cosmetic
      // effect stop being cosmetic.
      rx: obj.rotation.x, rz: obj.rotation.z,
      vx: (dirX / len) * speed,
      vz: (dirZ / len) * speed,
      // Lift is a fixed fraction of the horizontal throw: a body that goes
      // twice as far also goes twice as high, which is what keeps a weak
      // launch a stumble and a strong one an event.
      vy: speed * 0.62,
      // Tumble axis derived from the throw so the body rotates around the
      // direction it is travelling, not around an arbitrary one.
      sx: (dirZ / len) * LAUNCH.spin * k,
      sz: -(dirX / len) * LAUNCH.spin * k,
    });
  }

  /**
   * Integrate every live launch and stamp the offset. Runs from `update`, so
   * it keeps animating while `ctx.hitstop` freezes gameplay — a frozen frame
   * with a corpse hanging mid-arc reads as impact, which is the whole point of
   * spending the hitstop next to it.
   */
  _updateLaunches(dt) {
    for (let i = this._launches.length - 1; i >= 0; i--) {
      const l = this._launches[i];
      l.t += dt;
      const t = l.t;
      // Closed form rather than an accumulator: the offset is a pure function
      // of elapsed time, so a dropped frame changes nothing and re-applying it
      // on top of the owner's transform can never drift.
      const y = l.vy * t - 0.5 * LAUNCH.gravity * t * t;
      const o = l.obj;
      if (t >= l.dur || y < 0) {
        // Hand the rotation back exactly as it was found, then let go.
        o.rotation.x = l.rx;
        o.rotation.z = l.rz;
        this._launches.splice(i, 1);
        continue;
      }
      // Position is added, because the owner rewrites it from `this.position`
      // every frame and we are composing on top of that. Rotation is assigned,
      // because nobody else writes x or z and we own them for the launch's
      // life. Both are pure functions of t, so a dropped frame changes nothing.
      o.position.x += l.vx * t;
      o.position.z += l.vz * t;
      o.position.y += y;
      o.rotation.x = l.rx + l.sx * t;
      o.rotation.z = l.rz + l.sz * t;
    }
  }
```

In `update`, next to `this._updateDissolves(dt);` (`:1307`):

```js
    this._updateLaunches(dt);
```

- [ ] **Step 5: Fire it from the kill handler**

In `_onKill`, after the `deathDissolve` call (`:1187-1188`):

```js
    // Overkill throws the body away from the blow. Scaled against the
    // victim's own pool, so "a hit with a lot left over" means the same thing
    // on a mite as on a hulk.
    const pool = Math.max(1, p.victim?.maxHealth ?? 0);
    const over = (p.overkill ?? 0) / pool;
    if (obj && over >= LAUNCH.minOverkillFrac) {
      const src = p.source?.position;
      let dx = 0, dz = 1;
      if (src) {
        dx = _h1.x - src.x; dz = _h1.z - src.z;
        if (dx * dx + dz * dz < 1e-6) { dx = 0; dz = 1; }
      }
      this.corpseLaunch(obj, dx, dz,
        clamp((over - LAUNCH.minOverkillFrac) / (1 - LAUNCH.minOverkillFrac), 0, 1));
    }
```

(`_h1` already holds the death position at this point in `_onKill`; `clamp` is already imported at `:7`.)

- [ ] **Step 6: Run tests**

Run: `node tests/corpse-launch.test.mjs` — PASS.
Run: `npm test` — green, `tests/fsm-die-reentrancy.test.mjs` included (the death path is touched by two new `_kill` parameters and it is the suite that would notice).
Run: `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` — **zero fields moved.** `hpBefore` is one read of a field the function already holds; `_kill` gains two defaulted parameters and three presentation keys; the launch writes only a `rig.root` transform, which the fingerprint does not sample (it samples `finalEnemyPositions`, i.e. `Enemy.position`). A moved field is a bug in this task.

- [ ] **Step 7: Commit**

```bash
git add src/systems/Combat.js src/systems/VFX.js tests/corpse-launch.test.mjs
git commit -m "What is left over goes into the body: a kill with damage to spare throws it, and the simulation never notices"
```

---

### Task 5: A death looks like what killed it

**Files:**
- Modify: `src/systems/VFX.js` (`_onKill`'s burst, ring and light)
- Test: `tests/kill-signature.test.mjs`

**Interfaces:**
- Consumes: `kill` payload's `type` / `status` (added in Task 4); `elementOf`, `ELEMENT_HUE` from `src/data/damageTypes.js` (Task 3); `this.particles.emit(e)`, `this.rings.spawn(pos, UP, colour, r0, r1, life, alpha)`, `this.lights.flick(pos, colour, intensity, range, dur)`, `this.explosion(pos, radius, colour)`, `this.shockwave(pos, radius, life, strength)` — all as `_onKill` already calls them (`:1189-1209`).
- Produces: `KILL_SIGNATURE` exported from `src/systems/VFX.js` — one record per element in `ELEMENTS`, `{ frame, gravity, drag, stretch, speed, life, spin, ring, shock }`. `VFX.killSignature(element) -> record`, falling back to `kinetic` for anything unknown.

- [ ] **Step 1: Write the failing test**

```js
// tests/kill-signature.test.mjs
//
// Every kill in this game currently emits the same white-to-orange spark
// shower, so a death by frostbite and a death by shotgun are the same frame.
// This pins the table that separates them — and pins that the default is
// still the shower that shipped, so a kill by an unmapped item is not a
// visual regression.
import { KILL_SIGNATURE, VFX } from '../src/systems/VFX.js';
import { ELEMENTS, ELEMENT_HUE } from '../src/data/damageTypes.js';
import { FRAME } from '../src/fx/ParticleSystem.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('every read family has a death of its own');
{
  for (const e of ELEMENTS) {
    const s = KILL_SIGNATURE[e];
    ok(!!s, `${e} has a signature`);
    ok(Number.isInteger(s.frame) && s.frame >= 0 && s.frame <= 15, `${e} names a real atlas frame`);
    ok(typeof s.speed === 'number' && s.speed > 0, `${e} bursts at a speed`);
    ok(typeof s.life === 'number' && s.life > 0, `${e} bursts for a duration`);
    ok(typeof s.ring === 'boolean' && typeof s.shock === 'boolean', `${e} declares ring and shockwave`);
  }
}

console.log('the default death is the death that ships today');
{
  const k = KILL_SIGNATURE.kinetic;
  // src/systems/VFX.js:1195-1200 as shipped: FRAME.SPARK, speed 8, life 0.6,
  // gravity 10, drag 1.6, stretch 1.2.
  ok(k.frame === FRAME.SPARK, 'sparks');
  ok(k.speed === 8 && k.life === 0.6, 'at the shipped speed and life');
  ok(k.gravity === 10 && k.drag === 1.6 && k.stretch === 1.2, 'with the shipped physics');
  ok(k.ring === true && k.shock === false, 'a ring, no shockwave');
}

console.log('the families are actually different deaths, not one recoloured');
{
  const frames = new Set(ELEMENTS.map((e) => KILL_SIGNATURE[e].frame));
  ok(frames.size >= 4, `at least four distinct atlas frames across seven families (got ${frames.size})`);
  ok(KILL_SIGNATURE.ice.gravity > KILL_SIGNATURE.fire.gravity, 'shards fall, embers rise');
  ok(KILL_SIGNATURE.fire.gravity < 0, 'a fire death actually rises');
  ok(KILL_SIGNATURE.blast.shock === true, 'a blast death pushes a shockwave');
  ok(KILL_SIGNATURE.void.spin !== 0, 'the void death spins');
}

console.log('the ring narrative and the ring values are the same statement');
{
  // These four exist because the table shipped once with its `ring` values
  // swapped against the comments that justify them: `void`'s docstring said
  // "the one death with no outward ring" while its value said `ring: true`,
  // and `nature` carried `ring: false` with no explanation at all. Nothing
  // caught it — the families block above asserts `void.spin` and never
  // touched `void.ring`. A comment cannot be asserted, so the assertion has
  // to be the thing the comment claims.
  ok(KILL_SIGNATURE.void.ring === false,
     'the void takes it inward: no outward ring, because nothing is being pushed away');
  ok(KILL_SIGNATURE.nature.ring === true,
     'a spore burst disperses outward, so it keeps the generic kill ring');
  const ringless = ELEMENTS.filter((e) => !KILL_SIGNATURE[e].ring);
  ok(ringless.length === 1 && ringless[0] === 'void',
     `exactly one family omits the ring and it is the void (got [${ringless.join(', ')}])`);
  // The ring is the generic "something died here" read. Six of seven carrying
  // it is the design; a second omission is a decision that needs its own
  // comment and its own line here, not a silent edit.
  ok(KILL_SIGNATURE.kinetic.ring === true, 'the default death keeps its ring');
}

console.log('lookup is total');
{
  const vfx = new VFX();
  for (const e of ELEMENTS) ok(vfx.killSignature(e) === KILL_SIGNATURE[e], `${e} resolves`);
  ok(vfx.killSignature('nothing-like-this') === KILL_SIGNATURE.kinetic, 'unknown falls back to kinetic');
  ok(vfx.killSignature(undefined) === KILL_SIGNATURE.kinetic, 'so does nothing');
}

console.log('the colours come from the shared palette, not a second one');
{
  for (const e of ELEMENTS) {
    ok(!!ELEMENT_HUE[e], `${e} draws its kill colours from ELEMENT_HUE`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

This suite constructs `new VFX()` headless for the `killSignature` lookup, so it inherits Task 4 Step 1's decision: if `VFX` does not construct in node, `KILL_SIGNATURE` and `killSignature` move to the same `src/fx/CorpseLaunch.js`-style module that `LAUNCH` did, under identical exported names, and this file imports from there. Do not discover this halfway through Step 4.

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/kill-signature.test.mjs`
Expected: FAIL — `KILL_SIGNATURE` is not exported.

- [ ] **Step 3: Add the table to `src/systems/VFX.js`**

Next to `LAUNCH`:

```js
/**
 * How each read family dies.
 *
 * Every kill in this game used to be the same white-to-orange spark shower,
 * which meant the whole elemental half of the item pool was invisible at the
 * exact moment it paid off. The table is deliberately about *motion* first
 * and colour second — the colour comes from `ELEMENT_HUE`, which the hit
 * sparks already speak, so this adds a verb to a vocabulary rather than a
 * second vocabulary. Frames, gravity and drag are what make an ember death
 * and a shatter death read differently in peripheral vision, which is where
 * kills are actually seen.
 *
 * `kinetic` is the shipped burst, value for value (VFX.js:1195-1200 before
 * this table existed): a kill by an item nobody has mapped looks exactly as
 * it always did.
 */
export const KILL_SIGNATURE = {
  kinetic: { frame: FRAME.SPARK, speed: 8,  life: 0.60, gravity: 10,  drag: 1.6, stretch: 1.2, spin: 0,   ring: true,  shock: false },
  // Embers rise and hang: negative gravity, long life, heavy drag.
  fire:    { frame: FRAME.EMBER, speed: 6,  life: 1.10, gravity: -3,  drag: 2.4, stretch: 0,   spin: 0,   ring: true,  shock: false },
  // Shards fall hard and tumble: the read is "it broke", not "it burned".
  ice:     { frame: FRAME.HEX,   speed: 7,  life: 0.75, gravity: 26,  drag: 0.8, stretch: 0,   spin: 9,   ring: true,  shock: false },
  // Bolts, fast and nearly weightless, gone before the eye settles.
  shock:   { frame: FRAME.BOLT,  speed: 15, life: 0.32, gravity: 2,   drag: 3.2, stretch: 2.0, spin: 0,   ring: true,  shock: false },
  // Spores drift: slow, floaty, and they linger the longest of the seven. It
  // keeps the ring — a spore burst disperses outward, and the ring is the
  // generic "something died here" read that six of the seven families share.
  // Dropping it needs a reason, and drifting does not qualify as one.
  nature:  { frame: FRAME.SPECK, speed: 4,  life: 1.40, gravity: 1.5, drag: 3.0, stretch: 0,   spin: 1.2, ring: true,  shock: false },
  // The void takes it inward — slow, spinning, and the one death with no
  // outward ring, because nothing is being pushed away. It is not left
  // unreadable by that: FRAME.SHOCK is a thin sharp ring sprite that stays
  // where the body was and rotates, so the void's ring is a standing one
  // instead of an expanding one, which is the whole distinction.
  void:    { frame: FRAME.SHOCK, speed: 5,  life: 0.90, gravity: 0,   drag: 2.0, stretch: 0,   spin: 4,   ring: false, shock: false },
  // Debris and a real front.
  blast:   { frame: FRAME.CHUNK, speed: 11, life: 0.70, gravity: 16,  drag: 1.1, stretch: 0,   spin: 6,   ring: true,  shock: true },
};
```

- [ ] **Step 4: Spend it in `_onKill`**

Add the lookup method **after the whole `corpseLaunch` method**, not between `corpseLaunch`'s JSDoc block and its body — a doc comment separated from the function it documents by an unrelated method is a reader's trap, and "next to `corpseLaunch`" was loose enough to produce exactly that once:

```js
  /** The death this element dies. Total: anything unknown is kinetic. */
  killSignature(element) {
    return KILL_SIGNATURE[element] || KILL_SIGNATURE.kinetic;
  }
```

Then rewrite the burst / ring / light block of `_onKill` (currently `:1190-1203`, from `const big = ...` down to and including the `lights.flick` line) as:

```js
    const big = p.isBoss ? 2.2 : p.isElite ? 1.4 : 1;
    const element = elementOf(p.type, p.status);
    const sig = this.killSignature(element);
    const hue = ELEMENT_HUE[element] || ELEMENT_HUE.kinetic;

    let e = this._ep();
    e.count = Math.round(18 * big); e.position.copy(_h1); e.shell = 0.35 * big;
    e.dir.set(0, 1, 0); e.spread = Math.PI;
    e.speed = sig.speed * big; e.speedVar = 0.8;
    e.life = sig.life; e.lifeVar = 0.5;
    e.size0 = 0.14 * big; e.size1 = 0.02;
    // `killX ?? X`: the kinetic entry overrides all three so an untyped kill
    // is byte-identical to the one that ships, and the other six families
    // simply use their own hues.
    e.color0.set(hue.killCore ?? hue.core); e.color1.set(hue.killTail ?? hue.tail);
    e.frame = sig.frame; e.stretch = sig.stretch; e.gravity = sig.gravity;
    e.drag = sig.drag; e.spin = sig.spin;
    this.particles.emit(e);

    // Elites keep their hotter ring regardless of element — the affix read has
    // to survive the damage type that finished it, or a Blazing kill by a
    // frost round stops looking like an elite kill. `p.isElite ||` is what
    // makes that sentence true: `void` is the one family that omits the ring,
    // and it is also the family most likely to be doing the killing when the
    // victim is a Hollowed elite. Gating on `sig.ring` alone would delete the
    // elite ring in exactly that case — the comment above would be a lie about
    // the line below it.
    if (p.isElite || sig.ring) {
      this.rings.spawn(_h1, UP, p.isElite ? 0xffa040 : hue.ring, 0.3 * big, 3.2 * big, 0.45, 0.8);
    }
    this.lights.flick(_h1, hue.killFlick ?? hue.ring, 24 * big, 6 * big, 0.22);
    if (sig.shock) this.shockwave(_h1, 4 * big, 0.34, 0.020);
```

The `_shakeAt`, `_hitstop` and boss-`explosion` lines below it are untouched — the hitstop table is shipped code and stays exactly as it is.

**Three default values pass through this block and all three must land byte-identical for an untyped kill.** The shipped `_onKill` carries them as three separate literals that are *not* the same value, which is exactly how a rewrite loses one of them without noticing:

| what | shipped literal | source line | resolves through |
|---|---|---|---|
| burst `color0` | `0xffffff` | `VFX.js:1198` | `hue.killCore` |
| burst `color1` | `0xff5a20` | `VFX.js:1198` | `hue.killTail` |
| ring colour (non-elite) | `0xff7030` | `VFX.js:1202` | `hue.ring` |
| light flick | `0xff8030` | `VFX.js:1203` | `hue.killFlick` |

The ring and the flick differ by one channel (`0x70` vs `0x80`) and reusing `ring` for both is the specific slip this table exists to prevent. All four are pinned in `ELEMENT_HUE.kinetic` (Task 3), so extend `tests/damage-elements.test.mjs` with:

```js
console.log('the default kill is the kill that ships today, all four values');
{
  const k = ELEMENT_HUE.kinetic;
  ok(k.killCore === 0xffffff && k.killTail === 0xff5a20, 'the shipped burst pair');
  ok(k.ring === 0xff7030, 'the shipped ring colour');
  ok(k.killFlick === 0xff8030, 'the shipped light-flick colour, which is NOT the ring colour');
  ok(k.killFlick !== k.ring, 'and the two are held apart on purpose');
  for (const e of ELEMENTS.filter((x) => x !== 'kinetic')) {
    ok(ELEMENT_HUE[e].killFlick === undefined, `${e} has no kill override and falls back to its own ring`);
  }
}
```

`hitFlash`'s tint (Task 3 Step 5) remains the one deliberate default shift in this slice, and it is a decision recorded there, not an oversight here.

- [ ] **Step 5: Run tests**

Run: `node tests/kill-signature.test.mjs` — PASS.
Run: `node tests/damage-elements.test.mjs` — PASS with the added assertion.
Run: `npm test` — green.
Run: `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` — **zero fields moved.** Nothing in this task leaves `_onKill`; no draw, no branch in any gameplay path.

- [ ] **Step 6: Commit**

```bash
git add src/systems/VFX.js src/data/damageTypes.js tests/kill-signature.test.mjs tests/damage-elements.test.mjs
git commit -m "A death looks like what killed it: embers rise, shards fall, and the void takes its own inward"
```

---

### Task 6: Gates, money shot, baselines

**Files:**
- Modify: `src/core/Harness.js` (one new scenario, `overkill`)
- Modify: `tools/capture.mjs` (one new entry, appended last in `SCENARIOS`)
- Create: `reviews/round9/money-shot/` (PNG + manifest), `reviews/round9/juice-probe.json`
- Modify: `reviews/round9/README.md` (the money shot and the probe get their own sections)

- [ ] **Step 1: Full suite**

Run: `npm test` — every suite green, the three new files (`readability-gate`, `damage-elements`, `corpse-launch`, `kill-signature`) among them.

Run: `node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json` — **zero fields moved.** Every change in this slice is presentation: two additive payload fields, a colour lookup, a transform offset written after the owner writes it, and a tool. A diff here is a bug in the slice, not a baseline to regenerate. If one appears, read `tests/sp-equivalence.mjs`'s own header on interpreting it — the magnitude of a diff carries no information about the magnitude of the regression — and bisect the three source tasks rather than reasoning about which fields "look harmless".

Run: `npm run gate:elite` — the affix baseline (`reviews/round8/elite-baseline-HEAD.json`), which is the instrument that is *not* structurally blind to `ELITE_STATS`. Nothing in this slice touches the elite stat table, so it must be clean.

**Renderer note for Steps 2, 4 and 5.** Both `tools/silhouette.mjs` and `tools/capture.mjs` launch headed Chromium against a real adapter and need a live desktop session. Task 2 Step 0 established which mode works on this machine; use the same one here. `capture.mjs` already has the `--software` switch (`:35`, `:231-234`) and `silhouette.mjs` gained one in Task 2 Step 0. Under SwiftShader `capture.mjs` defaults `shotTimeout` to 180 s per shot rather than 30 s, which it does automatically — do not fight it, and expect a full-library run to take a long time. Record the mode used alongside every artifact this task commits: a shot captured under SwiftShader and a shot captured on d3d11 are not pixel-comparable, which matters enormously for Step 5's diff and not at all for Step 4's single frame.

- [ ] **Step 2: The readability gate as a gate**

Run: `node tools/silhouette.mjs --enemies --json reviews/round9/readability-gate.json` (plus `--software` if that is the established mode) — exit 0, and `git diff --stat reviews/round9/readability-gate.json` shows only `commit` moving. If any check went red between Task 2 and here, something in Tasks 3-5 changed a rig or a mesh, which nothing in them should have — find it before proceeding.

- [ ] **Step 3: The juice probe**

Following `tools/blightprobe.mjs` / `tools/reckoningprobe.mjs` conventions, write `tools/juiceprobe.mjs`: boot the game under `?harness=1&pinclock=1&seed=1337`, drive a fight, and record — to `reviews/round9/juice-probe.json` — the numbers the next playtest argues against:

  (a) **Overkill rate.** Over 200 monster kills: the fraction whose `overkill / maxHealth` cleared `LAUNCH.minOverkillFrac`, the median and p90 of that fraction, and the resulting launch distance in metres. If the fraction is under ~10% the threshold is too high to ever be felt and if it is over ~70% the launch is the default rather than the reward; either way the number belongs in the record and the retune belongs in the next slice, not in a quiet edit here.
  (b) **Element coverage.** A histogram of `elementOf(type, status)` across those 200 kills. A family that never appears is a table entry with no consumer; a run that is 95% `kinetic` means the projection map in `src/data/damageTypes.js` is missing the types that actually fire.
  (c) **Cost.** `ctx.pipeline.renderer.info` programs/geometries/textures and the particle system's live count at the peak of the fight, against the same reading on the commit before this slice. The kill signatures add frames from the existing atlas and no new material, so both should be flat; a moved program count means something forked a shader.
  (d) **No shared-stream draw.** Assert `ctx.rng`'s call count is identical across two runs with and without a launch-heavy fight (or, more simply, that the sp-equivalence fingerprint above is clean — cite the file, do not restate the claim).

Commit the record and the probe. Print the table in the task's report.

- [ ] **Step 4: The money shot**

Add `overkill()` to `src/core/Harness.js`. **Read `__HARNESS__.explosion` end to end first** — it is the closest existing analogue (a VFX-peak frame with a declared subject) and this scenario must match its idiom for `begin()` / `invulnerable()` / `detach()` / `frames()` / `freeze()` / `mustContain()`. The frame: a heavy monster killed by a massive overkill blow at close range, photographed with the corpse mid-arc and the element's kill burst live. Concretely — spawn one `hulk` and four `beetle` at ~9 m, give the player enough damage to overkill the hulk in one blow, fire, and freeze **6 frames** after the killing blow so the launch is near the top of its arc (`LAUNCH.maxSpeed` 11 m/s, `LAUNCH.gravity` 22 → apex at ~0.31 s; 6 frames at the pinned 1/60 is 0.1 s, which is early-rise and reads as *thrown* rather than as *floating* — tune against the captured frame and record the value chosen).

Its `mustContain` declares three subjects: the launched corpse (its rig root, at a projected position above the ground plane it died on), the kill burst (a `minCarriedPx` aggregate — declare `aggregateWhy` honestly, per the manifest's `toleratedAbsences` contract), and the survivor. A shot whose subject is absent is a failure here even when nothing throws.

Append the scenario to `tools/capture.mjs`'s `SCENARIOS` array **dead last**, after `16-run-summary`, with a comment saying why:

```js
  // Appended after `16-run-summary` on purpose, and it is the placement that
  // matters rather than the number. Every scenario draws from the shared RNG
  // stream, so a new one inserted anywhere in the middle displaces every shot
  // below it — measured on this harness at 19,488 -> 57,049 px for a change
  // that only re-seated `04-combat`'s monsters. Last costs nothing. The
  // trade-off is that `16-run-summary` has already killed the player, so on a
  // full run this scenario begins from a dead run; it is captured with
  // `--only 19-overkill` against a fresh page, which is the supported path.
  {
    name: '19-overkill',
    doc: 'A heavy monster killed with damage to spare, photographed with the corpse mid-launch and its element\'s kill burst live. Judges whether a kill reads as an event.',
    setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.overkill?.()),
  },
```

Capture it:

```bash
node tools/capture.mjs --out reviews/round9/money-shot --only 19-overkill --port 5203
```

Exit code 0 with `subjectsOk: true` is the gate; a plausible-looking image with an absent subject is the specific failure this harness's whole manifest design exists to prevent. Commit the PNG and its `manifest.json`.

- [ ] **Step 5: The full-library control**

Run a full capture into a scratch directory and diff it against the tree's current shots to prove the appended scenario displaced nothing:

```bash
node tools/capture.mjs --out reviews/round9/shots-after --port 5204
node tools/shotdiff.mjs reviews/round9/shots-after <the current shot library path> > reviews/round9/shot-diff-control.txt
```

Every pre-existing shot must be under `shotdiff`'s threshold of 8. **The fallback is the path that will actually be taken:** there is no single committed shot-library directory at the repo root yet (slice 4's job — only per-slice scratch directories from prior rounds exist), so capture the control from `HEAD~` into a second scratch directory and diff the two captures instead, and say in the README exactly which two trees were compared. Both captures must use the same renderer mode — a d3d11 capture diffed against a SwiftShader one will fail every shot and tell you nothing about the scenario you appended. **Do not skip this step and assert the appended scenario is safe — the assertion is the failure mode this harness has shipped six times.**

- [ ] **Step 6: Baselines named and committed**

Extend `reviews/round9/README.md` with a section per artifact: the file, the exact command that produced it, the commit it measured, and what a reader should conclude from it. Cross-reference `reviews/round8/README.md`'s rule: a re-baseline with no on-disk record of what it absorbed is how a real regression hides inside an accepted one. `reviews/round8/baseline-HEAD.json` is **not** touched by this slice and the README says so explicitly.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "The slice holds under instruments: the roster is measured, the deaths are distinct, and the body goes where the damage sent it"
```

---

## Self-review notes

- **Spec coverage (§3.2):** formalize `tools/silhouette.mjs` + the shot harness into a readability gate ✓ (Tasks 1-2 — the metrics module makes the gate node-runnable, `--enemies` extends it past survivors to families, tiers and all six affixes, the 40 m perspective pass answers the spec's actual question, and the exit code is what makes it a gate rather than a report); every enemy readable as friend/foe/tier ✓ (Task 2's `foeFriendIoU` cross-product against the survivor roster, `familyIoU` within the enemy roster, `tierArea` on median 40 m footprint); hitstop on heavy kills — **already shipped**, deliberately not re-planned (`VFX.js:39-49`, `_onKill:1206`); corpse launch on overkill ✓ (Task 4); ability-specific kill VFX ✓ (Task 5 — keyed on the killing blow's own type, which is the closest thing to "ability" the damage path carries; there is no per-ability VFX key anywhere in the damage pipeline to key off); damage-type-coloured hit sparks ✓ (Task 3, **including the DOT ticks** — Step 4b creates the `info.status` channel the colouring reads, which no live call site provided before this slice); money shot into the shot library ✓ (Task 6 — with the library formalization itself left to slice 4, and the appended-last placement measured rather than assumed). Deferred deliberately: diegetic UI (slice 3), the shot library and trailer pipeline (slice 4), any retune of `READABILITY`'s thresholds or `LAUNCH.minOverkillFrac` (Task 6's probe records the numbers; the retune argues against data in the next slice).
- **Type consistency:** `measureMask` returns `bw`/`bh`/`sig`/`bands`/`holes` and Task 2's grader, the refactored tool's tables and the tests all read those exact names; `READABILITY` / `gradeRoster` / `exemptions` spelled identically in module, tool and test; `ELEMENTS` / `ELEMENT_HUE` / `elementOf` / `sparkColour` (Task 3) are the same identifiers Task 5's `KILL_SIGNATURE` block imports; `LAUNCH` / `corpseLaunch` / `_launches` / `_updateLaunches` (Task 4) match between implementation, `_onKill` and `tests/corpse-launch.test.mjs`; the `kill` payload's `overkill` / `type` / `status` are added once, in Task 4, and consumed in Tasks 4 and 5 under those names.
- **The sharp edge, restated:** this whole slice is presentation, so sp-equivalence should be trivially clean — which is exactly why a diff here would be worth stopping for. Three tasks name it in their own steps (3, 4, 5). Four shipped default colours pass through the rewritten `_onKill` and all four are pinned byte-identical via `ELEMENT_HUE.kinetic`'s `killCore` / `killTail` / `ring` / `killFlick` (Task 5 Step 4's table names each with its source line; the ring and the flick differ by one channel and reusing one for both was the exact slip the table prevents). `hitFlash`'s tint (Task 3 Step 5) is the one deliberate default shift in the slice and is recorded as a decision, not allowed to drift.
- **A green unit test is not evidence the feature fires.** Task 3's `elementOf` blocks passed before any of Step 4b's forwarding existed, because `elementOf` was never the broken part — the status channel it reads had no live writer. That is why Task 3 carries two end-to-end blocks that drive the real `Combat` and read the real `damage` event, and why Step 2's expected output names the second failure explicitly. The same shape of gap is worth looking for anywhere else this slice tests a projection in isolation.
- **Known execution-time checks (deliberate):** whether `src/systems/VFX.js` constructs headless in node (Task 4 Step 1 names the fallback — a `src/fx/CorpseLaunch.js` module with identical exported names — and requires the decision before the test is written; **pre-flight review executed `node -e "import('./src/systems/VFX.js').then(m => new m.VFX())"` directly and it constructs cleanly with no ctx, so the primary path holds and the fallback is expected to stay unused — verify once, then move on**); whether the survivor table's printed numbers survive the Task 1 refactor byte for byte on a machine with a GPU (Task 1 Step 4 requires saying so rather than assuming it); the live `ctx.camera.fov` and the rig's `animate(rig, anim, dt)` / `setAffix` signatures inside the page (Task 2 Step 4 reads them from the running game rather than hardcoding); the exact frame delay that photographs the launch at the right point in its arc (Task 6 Step 4 gives the arithmetic and requires the chosen value be recorded); whether a committed shot library directory exists yet for the control diff (Task 6 Step 5 names both paths).
- **The ratchet, and why it is not a loophole:** `READABILITY.exemptions` lets the gate ship green against a roster it has never measured, which is the only way a gate like this survives its first week. It is bounded in three ways that a loosened threshold is not: an exemption names one unit and one check, it carries the value measured when it was admitted so any degradation is red, and it is a line of committed code with a note attached rather than a number quietly moved. The instruction in Task 2 Step 6 is explicit that a real content failure gets an exemption and a report line, never a threshold edit — collapsing design intent into measured debt is what would make this gate stop measuring.

---

## Post-review amendments (pre-flight, 2026-08-08)

Pre-flight review returned **CONFIRMED**, 0 blocker / 1 major / 4 minor (`.superpowers/sdd/2026-08-08-readability-juice/plan-review.md`). One finding was a real hole in what the plan delivered rather than a citation slip, and this is what changed under it.

- **Task 3 was going to ship a colour channel with no signal on it.** The plan built a `status` fallback in `elementOf`, tested it in isolation, and cited `Combat.js:717-721` as the source of `info.status`. That citation was wrong and the field does not exist: **no live call site puts `status` on an `applyDamage` info object at all.** `Combat.explode` destructures it at `:401` and routes it to `applyStatus` at `:415` while passing only `type` at `:414`; `damageGroup` (`src/data/abilities.js:224-231`) splits the same way; and the DOT tick at `:717-720` sets `type: s.type`, i.e. the *status name* (`'burn'`), which is not a `TYPE_ELEMENT` key and falls straight through to kinetic. Net effect as written: the blast that lights a burn coloured correctly, and then every tick of that burn — repeated, visible, the most common damage event in the game — rendered as a generic white spark. New **Step 4b** closes it with one added key on each of the three literals, keeping `type: s.type` untouched on the DOT path because items key off it (Afflictor's Index, `abilities.js:1145`), so the fix is presentation-only and sp-equivalence-inert. `src/data/abilities.js` joins Task 3's Files list and its commit.
- **Task 3's test suite gained an end-to-end arm, because its unit tests could not have caught the above.** `elementOf('hit', 'burn') === 'fire'` passed before Step 4b existed and would have passed after shipping the gap — the projection was never the broken part, the channel it reads had no writer. Two new blocks drive a real `Combat` (the `tests/shrike-detonate.test.mjs` headless fixture), tick a real burn and read the real `damage` event, asserting the status actually arrives. Step 2's expected output now names the second failure explicitly, so an implementer who skips 4b sees it rather than shipping green.
- **A third default-value drift was found and pinned.** The plan called out two shifts requiring a decision (`hitFlash`'s tint, the kill burst's `color0`/`color1`) and missed a third of exactly the kind it prides itself on catching: `_onKill`'s light flick ships as `0xff8030` (`VFX.js:1203`) while the ring beside it is `0xff7030` (`:1202`), and Task 5's rewrite read `hue.ring` for both — a silent one-channel change to every untyped kill. `ELEMENT_HUE.kinetic` now carries `killFlick: 0xff8030` alongside `killCore`/`killTail`, Task 5 reads `killX ?? X`, and a four-row table in Step 4 names each shipped literal with its source line so the next rewrite cannot lose one either. The four values are pinned by a new assertion block in `tests/damage-elements.test.mjs`.
- **Unattended-run hardening.** `tools/silhouette.mjs` launches headed Chromium against `--use-angle=d3d11` and needs a live GPU desktop session, which an executor cannot fix by editing files — and its failure mode is not only a crash but a clean exit over black renders, which would have produced a plausible table of meaningless numbers and a committed record asserting it measured something. New **Task 2 Step 0** runs the survivor-only path as a canary before any work begins, names both failure shapes, adds a `--software` switch mirroring `capture.mjs:35,231-234`, stamps `renderer` into the gate record, and forbids fabricating a record or weakening the roster-coverage test if neither mode works. Task 6 gains the matching renderer note across Steps 2, 4 and 5, including the warning that a cross-renderer shotdiff fails every shot and proves nothing about the scenario it exists to check.
- **Citation drift, corrected throughout:** `HITSTOP` `VFX.js:38-49` to `:39-49`; the `hitSpark` call `:1168` to `:1169`; the `_onKill` burst/ring/light block `:1191-1206` to `:1190-1203`; the `damage` emit `Combat.js:530-533` to `:537-540`; and the bogus `:717-721` status citation replaced by an explicit statement of what that line actually is.
- **One contingency retired as unnecessary.** Review executed `node -e "import('./src/systems/VFX.js').then(m => new m.VFX())"` directly: `VFX` constructs cleanly headless with no ctx, so Task 4/5's primary path (constants living in `VFX.js`) holds and the `src/fx/CorpseLaunch.js` fallback is expected to stay unused. The fallback stays documented; the self-review note now records that it was tested rather than merely hedged.

- **Task 5's `KILL_SIGNATURE` ring values were swapped against their own comments; the narrative governs and the values move to match it** (Task 5 reviewer, Important — `.superpowers/sdd/2026-08-08-readability-juice/task-5-review.md`). `void` is now `ring: false` and `nature` `ring: true`. The narrative wins because it is the half that was reasoned about: the void's identity across this codebase is inward and consuming (`ELITE.voidtouched` — "the read is 'eaten', not 'empowered'"), an outward ground ring contradicts it, and the void row already owns a distinct standing read in `FRAME.SHOCK` + `spin: 4` + `gravity: 0`; `nature`'s `ring: false` had no justification anywhere, which is the tell that the value landed there by a swap rather than a decision. `nature` gains the comment it never had. Two consequences ride along: (a) the ruling would have created a real bug, since `if (sig.ring)` also gated the *elite* ring — a void weapon finishing a Hollowed elite would have deleted the amber affix ring the comment directly above promises survives every damage type, so the gate becomes `if (p.isElite || sig.ring)`; (b) `tests/kill-signature.test.mjs` gains four assertions pinning `void.ring === false`, `nature.ring === true`, `kinetic.ring === true` and "exactly one family omits the ring, and it is the void", because a comment cannot be asserted and the old suite checked `void.spin` while never touching `void.ring`. The reviewer's Minor doc-placement nit rides along as a tightened instruction: `killSignature` goes *after* the whole `corpseLaunch` method, never between its JSDoc and its body.

Not changed, and deliberately: the "ability-specific kill VFX" reading. Review agreed there is no per-ability VFX key anywhere in the damage pipeline to key off, and that keying on the killing blow's damage type is the reasonable interpretation rather than a gap. The spec-coverage note now says so in the same words review used.
