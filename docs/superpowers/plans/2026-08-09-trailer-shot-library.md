# Trailer Shot Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 3 workstream 4 becomes real: one committed, catalogued shot library (`shotlib/`) that collects every money shot the project has already earned, plus the two artifacts it is still owed — the trailer thesis *still* (the party fighting at a blight edge as it spreads toward camera) and the first 10-second *clip*, captured by a new `tools/clipshot.mjs` that can film any harness scenario.

**Origin:** Launch design spec §3.4 (`docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md:142-145`): *"Trailer-first development. Every feature milestone ends with its money shot captured via `tools/capture.mjs` into a running shot library. Trailer thesis shot: the party fighting at a blight edge as it spreads toward camera."* Plus workstream 2's sales unit (`:136-137`): *"Ten-second clips are the sales unit."* Nothing in the repo today is a library: money shots exist but are scattered across `reviews/round8/` and gitignored `shots-*/` directories, and no tool can capture motion at all.

**Architecture:** One new harness arm (`__HARNESS__.blightEdge()`) composes the thesis scene using only seams that already exist — `ctx.corruption.feed`/`.seed` (`src/systems/Corruption.js:81,190`), the blight patch growth that `src/systems/Blight.js:510-521` already drives from `radiusOf(strength, world)` (`Blight.js:84`), the harness's own `spawnRing` (`src/core/Harness.js:712-753`) and `freeCam` (`Harness.js:5450-5454`). `tools/capture.mjs` gains one scenario entry (`20-blight-edge`) that calls it — the spec names `capture.mjs` as the shutter, and its manifest/subject-gate machinery is exactly what makes a money shot arguable. `tools/clipshot.mjs` is a new sibling of `tools/gaugeshot.mjs` (same vite+playwright skeleton, same record-JSON-with-checks discipline) that films N seconds of a live harness scenario via Playwright's `recordVideo` — zero new dependencies, playwright is already the capture stack. The library itself is a `shotlib/` directory: a committed `MANIFEST.md` cataloguing every entry (SHA, exact command, renderer, what the frame argues), committed PNG stills (nothing in the live `.gitignore` matches `shotlib/` — the patterns are `shots-*/` and `reviews/**/*.png` — so a plain `git add` suffices; the UI-BASELINE precedent is cited for the *decision* to commit curated frames, not for a force flag), and clips left on disk with their regeneration command in the manifest (webm at 1600x900x60s does not belong in git history).

**Tech Stack:** Playwright (existing devDep) incl. `recordVideo`; vite dev server per capture tool convention; `__HARNESS__`/`__GAME__` page seams; node-only record JSONs.

## Global Constraints

- **One renderer per run, chosen once, by the canary.** Same rule as the diegetic-ui slice (`docs/superpowers/plans/2026-08-08-diegetic-ui.md` Global Constraints): capture defaults to **headed d3d11** (`tools/capture.mjs:35,244-261`); `--software` is the explicit fallback. Task 1 Step 0 runs the canary once; every capture command in this plan then carries the same flag (empty or `--software`), and the choice is recorded in `shotlib/MANIFEST.md`. Environment fact from the last two slices: headed d3d11 capture works unattended on this box (memory: capture-works-unattended-d3d11); expect `$CAPFLAG` empty.
- **Port stagger.** Existing tools own 5199 (capture), 5207 (capture-realms), 5214 (gaugeshot). `clipshot.mjs` takes **5221**. Never share a port between concurrently running tools.
- **Determinism per house rule:** seed 1337, viewport 1600x900, deviceScaleFactor 1, `pinClock(1/60)` before the first scenario, no wall-clock waits (`tools/capture.mjs:38-50`).
- **sp-equivalence must show zero fields moved** (`node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json`). The harness arm runs only under `?harness=1`; no file this plan touches executes in a normal run. A moved field is a bug in the work, never a baseline to regenerate.
- **No renames, no changes to existing scenarios.** `20-blight-edge` is appended dead last; the 22 existing scenario entries (13-biomes is a x4 spread) and their subject gates are untouched. Existing shot baselines stay bit-identical — the shared-RNG-stream rule at `capture.mjs:191-198` is why only a dead-last append is safe.
- **No new runtime dependencies.** Playwright records webm natively; no ffmpeg, no encoder package.
- **Committed binary budget:** the PNGs committed to `shotlib/` in Task 3 must total under 10 MB (the UI-BASELINE precedent committed ~16 MB and flagged it; this library is smaller and curated). Clips (`.webm`) are **never** committed; `.gitignore` gets a `shotlib/clips/` line (the clip tool's output directory, record JSONs included — the manifest records the exact regeneration command instead).
- **Bash tool is ASCII-only** in this environment; any non-ASCII content goes through Write/Edit, never a heredoc. No report prose through a heredoc (memory: no-report-prose-through-heredoc).
- **Line citations are signposts, not addresses** — verified at authoring time; the live file wins. Read a cited range before editing it.

---

### Task 1: The blight-edge harness arm and the thesis still

The scene the spec names: survivors mid-fight at the crawling edge of a blight patch, the patch spreading toward camera. Composed entirely from public seams, gated like every other money shot.

**Files:**
- Modify: `src/core/Harness.js` — add one scenario method `blightEdge` to the `H` object (the escape-hatch block ends at `Harness.js:5439-5455`; insert the method above `pinClock` at `:5434`, alongside the other full scenarios)
- Modify: `tools/capture.mjs:51-204` — append scenario entry `20-blight-edge` to `SCENARIOS`
- Test: the scenario's own `mustContain` subject gates plus the capture manifest (`subjectsOk`) — this is the file's existing test convention; there is no headless-node path to a GPU frame

**Interfaces:**
- Consumes: `ctx.corruption.feed(player, amount)` (`Corruption.js:81`), `ctx.corruption.seed(position, strength)` (`Corruption.js:190`), `spawnRing(count, cards, radiusBase, eliteEvery)` (`Harness.js:712`), `freeCam(x,y,z,tx,ty,tz)` (`Harness.js:5450`), `frames(n, timeoutMs)`, `freeze()`/`thaw()`, `SPAWN_CARDS` (`Harness.js:2`), `radiusOf(strength, world)` (`src/systems/Blight.js:84`) — import it in Harness.js the way the file already imports data modules at `:2-3`.
- Produces: `globalThis.__HARNESS__.blightEdge(opts?) -> Promise<record>` where `record` is `{ world, band, patchRadius, enemiesAlive, cameraDistToEdge }`; capture scenario `20-blight-edge` (PNG + manifest entry). Task 2 films this same arm; Task 3 catalogues its output.

- [ ] **Step 0: Canary.** Run the smallest existing capture under the default renderer to pick the run's flag:

```bash
node tools/capture.mjs --out shots-canary --only 01-title
```

Expected: exit 0, `shots-canary/manifest.json` has `ready: true`. If it fails on renderer grounds, re-run with `--software`; whichever passes sets `$CAPFLAG` for **every** capture command in this plan. Record the choice; delete `shots-canary/` after.

- [ ] **Step 1: Read the neighbours.** Read `Harness.js` around `spawnRing` (`:700-800`), one full fight-composing scenario (the one registered as `04-combat` — find it via `grep -n "04-combat" tools/capture.mjs` then the harness method it calls), and `lateRun` (`:2991`). The new arm follows their idiom exactly: async, owns its settle, composes its frame, calls `freeze()` before resolving, runs `mustContain` last.

- [ ] **Step 2: Write the arm.** Add to the `H` object in `Harness.js` (above the `pinClock` line, `:5431`):

```javascript
/**
 * The trailer thesis (launch design section 3.4): the party fighting at a
 * blight edge as it spreads toward camera. Composed from public seams only:
 * corruption is driven through feed(), the patch through seed() + the growth
 * Blight.update already runs, the fight through spawnRing. The camera sits
 * low on the far side of the patch edge, shooting across it at the fight,
 * so the crawling edge advances toward the lens.
 */
async blightEdge({ world = 150, seedStrength = 3, settleFrames = 150 } = {}) {
  thaw();
  await begin();
  await frames(2);
  // Plant the seed FIRST, while the world is still near zero. Blight builds
  // a patch at full formula radius for the CURRENT world (Blight.js:502) --
  // seeding after the feed would spawn the rim pre-grown at ~12.5 m and the
  // spec's "spreads toward camera" motion would never happen on camera.
  // Seeded now, the patch builds at radiusOf(3, ~0) ~= 6.5 m and GROWS at
  // 1.2 m/s (Blight.js:19) as the feeds below raise the world -- the growth
  // itself is the thesis, and Task 2 films this same arm.
  const p = playerPos();
  const f = forward();
  const seedAt = new THREE.Vector3(p.x + f.x * 14, p.y, p.z + f.z * 14);
  ctx.corruption.seed(seedAt, seedStrength);
  // The loaded late-run STATE, inlined from lateRun's state half
  // (Harness.js:2996-3000) without its shot half: lateRun is a complete
  // shot -- its own 10-monster ring, declutter, freeze() and the
  // 06-loaded-hud subject gates whose "monsters under load" check is a
  // documented open regression -- and nesting it would bill another shot's
  // marginal gates to this scenario's frameErrors, plus paint its
  // inventory panel over a quarter of the landscape.
  attach();
  invulnerable();
  ctx.time = 22 * 60;
  // -- transcribe the item give-loop + addGold(4200) verbatim from the
  // live lateRun body at Harness.js:2996-3000 here --
  seedLevel(20, 0.42);
  // Drive the world to the target band through the two real levers, AFTER
  // the item grant so its tithes are inside the correction.
  const delta = world - (ctx.corruption?.world ?? 0);
  if (delta > 0) ctx.corruption.feed(ctx.player, delta);
  else if (delta < 0) ctx.corruption.bleed(ctx.player, -delta);
  // The fight: a ring of the roster's video-friendly bodies, one elite.
  spawnRing(8, SPAWN_CARDS.slice(0, 4), 10, 4);
  // Let the patch grow into frame and the fight close distance.
  await frames(settleFrames);
  // Low camera on the far side of the seed, shooting back across the edge
  // toward the player: patch in the foreground, fight behind its rim. The
  // standoff is read off the LIVE patch uniform, not recomputed arithmetic,
  // so the lens sits relative to what actually rendered.
  const patch = ctx.blight?.patches?.at?.(-1) ?? null;
  const liveR = patch?.mesh?.material?.uniforms?.uRadius?.value ?? 0;
  H.freeCam(
    seedAt.x + f.x * (liveR + 8), p.y + 2.2, seedAt.z + f.z * (liveR + 8),
    p.x, p.y + 1.2, p.z,
  );
  await frames(12);
  freeze();
  const enemiesAlive = (ctx.director?.enemies ?? []).filter((e) => e.alive).length;
  const camDistToEdge = Math.hypot(camera.position.x - seedAt.x, camera.position.z - seedAt.z) - liveR;
  const record = {
    world: +(ctx.corruption?.world ?? 0).toFixed(1),
    band: ctx.corruption?.band ?? 0,
    patchRadius: +liveR.toFixed(2),
    enemiesAlive,
    cameraDistToEdge: +camDistToEdge.toFixed(2),
  };
  mustContain('20-blight-edge', [
    { subject: 'a deep-band world', dom: () => (ctx.corruption?.band ?? 0) >= 3, detail: () => record.band },
    { subject: 'a blight patch in the world', dom: () => (ctx.blight?.patches?.length ?? 0) >= 1, detail: () => ctx.blight?.patches?.length ?? 0 },
    { subject: 'a grown patch rim, measured off the live uniform', dom: () => liveR >= 6, detail: () => record.patchRadius },
    { subject: 'a live fight', dom: () => enemiesAlive >= 4, detail: () => enemiesAlive },
  ]);
  return record;
},
```

**Transcribe the shape, not the letters:** the exact local helper names (`thaw`, `begin`, `attach`, `invulnerable`, `seedLevel`, `frames`, `playerPos`, `forward`, `mustContain`, `camera`, `spawnRing`) are all in scope inside `installHarness` — verify each against the live file (`begin:86`, `seedLevel:128`, `attach:136`, `invulnerable:1341`; the rest are used by the existing scenarios at `:5256-5429`). The `-- transcribe --` marker is the one deliberate fill-from-live-source point: copy the give-loop and `addGold(4200)` exactly as `lateRun` does them at `Harness.js:2996-3000`. The item grant is itself a dial — if the inventory panel wrecks the photograph, shrinking or skipping the grant is in-scope iteration. If the fight ring reads better with different cards, choosing them is Task 1's judgment call; the subject gates are not negotiable. `radiusOf` is cited for the radius reasoning but the arm reads the live uniform instead — no new import is required unless the implementer wants the comment's numbers checked; if imported, it comes from `../systems/Blight.js` (imports at `:1-10`). Verify `ctx.blight.patches` is the real container (`Blight.js:427` puts the system on ctx, `:480` pushes patches) and adjust the property path to the live shape if it differs.

- [ ] **Step 3: Register the shutter.** Append `20-blight-edge` **dead last** in `SCENARIOS` in `tools/capture.mjs` — AFTER `19-overkill`, which itself sits after `16-run-summary`. The comment at `capture.mjs:191-198` is the governing rule: every scenario draws from the shared RNG stream, so a new entry anywhere but dead last displaces every shot below it and breaks the bit-identical baseline constraint. Mirror `19-overkill`'s caveat in the new entry's comment: on a full run this scenario begins from a dead run (`16-run-summary` latches the death); it is captured with `--only 20-blight-edge` against a fresh page, which is the supported path:

```javascript
{
  name: '20-blight-edge',
  doc: 'The trailer thesis: the party fighting at a blight edge as it spreads toward camera. Judges whether the hook is photographable — blight foreground, fight midground, deep-band sky.',
  setup: (page) => page.evaluate(() => globalThis.__HARNESS__?.blightEdge?.()),
},
```

- [ ] **Step 4: Shoot it.**

```bash
node tools/capture.mjs $CAPFLAG --out shots-trailer --only 20-blight-edge
```

Expected: exit 0; `shots-trailer/manifest.json` shows `20-blight-edge` with `subjectsOk: true`, zero `frameErrors`. **Look at the PNG.** The frame must actually read as the pitch: blight edge in the lower third, survivors and enemies engaged behind it. If the composition fails as a photograph (fight occluded, edge out of frame, camera in the ground), tune the numeric dials in `blightEdge` (bearing distance 14, ring radius 10, camera height 2.2, standoff liveR+8, the item grant) — dial changes are in-scope iteration, seam changes are not.

- [ ] **Step 5: Gates.**

```bash
node tests/run.mjs
node tests/sp-equivalence.mjs --compare reviews/round8/baseline-HEAD.json
node tools/capture.mjs $CAPFLAG --out shots-regress --only 01-title,02-vista,04-combat
```

Expected: all tests pass; sp-equivalence zero fields moved; the three regression scenarios still `subjectsOk: true` (proves the appended scenario and new import broke nothing upstream). Delete `shots-regress/` after.

- [ ] **Step 6: Commit.**

```bash
git add src/core/Harness.js tools/capture.mjs
git commit -m "The thesis becomes photographable: a blight edge, a fight behind it, a lens that knows the pitch"
```

---

### Task 2: `tools/clipshot.mjs` — the sales unit learns to move

Ten-second clips are the sales unit and no tool in the repo can produce one. `clipshot.mjs` films any harness arm: same skeleton as `gaugeshot.mjs` (vite server, playwright, pinned clock, record JSON with named checks), plus a recording context.

**Files:**
- Create: `tools/clipshot.mjs`
- Test: the tool's own check block (exit 1 on any failed check) — same convention as `gaugeshot.mjs:68-72,209-226`

**Interfaces:**
- Consumes: `__HARNESS__.blightEdge()` from Task 1 (or any arm named via `--arm`); `__HARNESS__.pinClock/thaw/frames/freeze`; `__GAME__.ctx`.
- Produces: `node tools/clipshot.mjs [--arm blightEdge] [--secs 10] [--seed 1337] [--port 5221] [--out shotlib/clips] [--software]` writing `<out>/<arm>-<seed>.webm` + `<out>/<arm>-<seed>.json`. Task 3 records its command line in the manifest.

- [ ] **Step 1: Write the tool.** Create `tools/clipshot.mjs`. Skeleton is `gaugeshot.mjs:37-96` transcribed (argv walk, vite server, chromium launch flags for both renderers, page error capture) with these deltas:

```javascript
/**
 * The sales unit: a ten-second clip of a live harness arm.
 *
 * Same discipline as tools/gaugeshot.mjs: real vite server, real page, the
 * real game through __GAME__/__HARNESS__, a record JSON whose checks gate the
 * exit code. The one addition is motion: the page runs inside a context with
 * recordVideo, the arm composes its scene, and instead of freezing for a
 * shutter the engine free-runs `--secs` of pinned simulation before the
 * context closes and playwright finalises the webm.
 *
 * The clock is pinned at 1/60, so N seconds of simulation is 60N engine
 * frames -- but the *video* records at wall-clock rate. That is correct for a
 * sales clip: the capture GPU runs the real frame rate, and pinning only
 * guarantees the simulation's timeline is the same every take.
 *
 *   node tools/clipshot.mjs [--arm blightEdge] [--secs 10] [--seed 1337]
 *                           [--port 5221] [--out shotlib/clips] [--software]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const t = process.argv[i];
  if (!t.startsWith('--')) continue;
  const n = process.argv[i + 1];
  args[t.slice(2)] = n && !n.startsWith('--') ? (i++, n) : true;
}
const ARM = String(args.arm ?? 'blightEdge');
const SECS = Number(args.secs ?? 10);
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5221);
const OUTDIR = path.resolve(String(args.out ?? 'shotlib/clips'));
const SOFTWARE = 'software' in args;
const W = 1600, H = 900;
mkdirSync(OUTDIR, { recursive: true });

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? 'PASS ' : 'FAIL '} ${name}${detail === undefined ? '' : `  -- ${JSON.stringify(detail)}`}`);
};

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: SOFTWARE,
  args: SOFTWARE
    ? ['--use-gl=swiftshader', `--window-size=${W},${H}`]
    : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--force_high_performance_gpu',
      '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
// NB: capture.mjs's headed profile also passes --disable-frame-rate-limit,
// because stills want speed. A CLIP must not: with rAF uncapped and the sim
// pinned at 1/60, ten sim-seconds would fast-forward through however little
// wall time the GPU allows. Vsync capping rAF at the display refresh is what
// makes the recorded motion real; the wall-clock check below enforces it.
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
  recordVideo: { dir: OUTDIR, size: { width: W, height: H } },
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.error('PAGE ERROR', e.message); });

let record = null, videoPath = null;
try {
  // pinclock=1 in the URL, the capture.mjs way (capture.mjs:283-286, honored
  // at Harness.js:2475): the clock is pinned before the FIRST frame, so no
  // boot frame is ever wall-timed. No pinClock evaluate needed.
  await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=3&harness=1&pinclock=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__GAME__?.ctx?.stage != null, null, { timeout: 60000 });
  // The arm composes its scene and freezes; we thaw and let it play.
  const armRecord = await page.evaluate((arm) => globalThis.__HARNESS__?.[arm]?.(), ARM);
  check('the arm exists and composed a scene', armRecord != null, { arm: ARM });
  const wall0 = Date.now();
  await page.evaluate(async (frames) => {
    const Hz = globalThis.__HARNESS__;
    Hz.thaw();
    await Hz.frames(frames, 300000);
    Hz.freeze();
  }, Math.round(SECS * 60));
  const wallSecs = (Date.now() - wall0) / 1000;
  record = await page.evaluate(() => ({
    simTime: +(globalThis.__GAME__.ctx.time ?? 0).toFixed(3),
    frameErrors: globalThis.__GAME__.ctx.frameErrors ?? 0,
    determinism: globalThis.__HARNESS__.determinism(),
  }));
  record.wallSecs = +wallSecs.toFixed(2);
  videoPath = await page.video().path();
} finally {
  await context.close();   // finalises the webm before browser.close
  await browser.close();
  await server.close();
}

const finalPath = path.join(OUTDIR, `${ARM}-${SEED}.webm`);
renameSync(videoPath, finalPath);
const bytes = statSync(finalPath).size;
check('the clip exists and has substance', bytes > 200000, { bytes, path: finalPath });
check('the clock stayed pinned', record?.determinism?.clockPinned === true, record?.determinism);
check('no frame errors (subject gates held)', record?.frameErrors === 0, record?.frameErrors);
// mustContain never throws (Harness.js:2104-2107) -- it raises
// ctx.frameErrors and returns. Without this check the tool is blind to the
// one failure mode the arm was built to detect.
check('the take ran at wall-clock rate (~60 Hz display assumed)',
  record?.wallSecs >= SECS * 0.8 && record?.wallSecs <= SECS * 1.4,
  { wallSecs: record?.wallSecs, secs: SECS });
check('no page errors', pageErrors.length === 0, pageErrors);

const failed = checks.filter((c) => !c.pass).length;
writeFileSync(path.join(OUTDIR, `${ARM}-${SEED}.json`), `${JSON.stringify({
  tool: 'tools/clipshot.mjs',
  command: `node tools/clipshot.mjs --arm ${ARM} --secs ${SECS} --seed ${SEED}${SOFTWARE ? ' --software' : ''}`,
  renderer: SOFTWARE ? 'swiftshader (headless)' : 'd3d11 (headed)',
  viewport: { w: W, h: H },
  secs: SECS, seed: SEED,
  clip: finalPath, bytes,
  sim: record, checks, pageErrors,
  ok: failed === 0,
}, null, 2)}\n`);
console.log(`\nwrote ${finalPath}`);
console.log(`${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

Two facts to verify against the live tree while writing (signposts, not gospel): (a) `page.video()` is available only when the page came from a `recordVideo` context — it did; (b) the arm freezes before resolving (Task 1 wrote it that way), so the thaw/frames/freeze sandwich is what turns the still into a take. Composition failures surface through `ctx.frameErrors` (`mustContain` raises the counter and returns, `Harness.js:2104-2107`), which is exactly what the `no frame errors` check reads — do not add a try/catch around the arm call expecting a throw.

- [ ] **Step 2: Film the thesis.**

```bash
node tools/clipshot.mjs $CAPFLAG --arm blightEdge --secs 10
```

(`$CAPFLAG` empty means headed d3d11; pass `--software` only if the Task 1 canary chose it.) Expected: exit 0, `shotlib/clips/blightEdge-1337.webm` over 200 KB, record JSON `ok: true`. **Watch the clip** (open it; a webm plays in any Chromium). It must show motion that sells: the fight animating, the blight edge alive. A static or black clip fails the slice even with green checks — say so in the task report if it happens.

- [ ] **Step 3: Gates.** `node tests/run.mjs` all pass (the tool is node-side only; this guards against accidental src/ edits). `git status --short` shows only the intended new files.

- [ ] **Step 4: Commit.**

```bash
git add tools/clipshot.mjs
git commit -m "The sales unit learns to move: ten pinned seconds of any arm, filmed and gated"
```

(`shotlib/clips/` output is deliberately not added; Task 3 owns the library's git story.)

---

### Task 3: `shotlib/` — the running library

The spec's noun. One directory, one manifest, every money shot the project has earned, each entry regenerable from its recorded command.

**Files:**
- Create: `shotlib/MANIFEST.md`
- Create: `shotlib/` PNG entries (copied from their current homes, force-added)
- Modify: `.gitignore` — add `shotlib/clips/` (the clip output directory, `.webm` and record JSONs both; a bare `shotlib/*.webm` would miss `shotlib/clips/blightEdge-1337.webm`, which is where clipshot actually writes). Confirm `shotlib/` itself is NOT matched by the existing `shots-*/` pattern — `shotlib` does not match `shots-*`, verify with `git check-ignore -v shotlib/MANIFEST.md`, expect no match

**Interfaces:**
- Consumes: Task 1's `shots-trailer/20-blight-edge.png`, Task 2's clip record, plus the existing money shots: `reviews/round8/ui-money-shot.png` (+ its record `reviews/round8/ui-gauge-probe-record.json`), the blight-ceiling money shots in `shots-blight/` (pick the one the blight-ceiling slice named its money shot — check `docs/superpowers/plans/2026-08-08-blight-ceiling.md` and `reviews/round8/` records for which frame was published), and the juice slice's overkill/death shots if its plan published one (check `docs/superpowers/plans/2026-08-08-readability-juice.md` closing task).
- Produces: the committed library. Every later slice appends here; the morning report links it.

- [ ] **Step 1: Curate.** For each candidate money shot, find its provenance (the plan/record that published it, its SHA, its exact command). Copy the PNG into `shotlib/` with a self-describing name (`thesis-blight-edge.png`, `instrument-panel.png`, `blight-ceiling.png`, ...). Keep the total committed PNG bytes under 10 MB — curate, do not hoard; the library is the trailer's contact sheet, not an archive. `reviews/round8/` keeps its own copies untouched (baselines are immutable, memory: name-the-baseline-capture).

- [ ] **Step 2: Write `shotlib/MANIFEST.md`.** One entry per shot, table + a paragraph each:

```markdown
# Shot Library

The running money-shot library the launch design (section 3.4) requires. Every
feature milestone lands its money shot here; the trailer is cut from this
directory. Stills are committed (curated frames belong in the tree, the
reviews/round8/UI-BASELINE.md decision); clips are regenerated from their
recorded commands and never committed (shotlib/clips/ is gitignored).

Renderer for every entry below: <headed d3d11 | swiftshader>, chosen by the
Task 1 canary of docs/superpowers/plans/2026-08-09-trailer-shot-library.md.

| Entry | File | Captured at | Command |
|---|---|---|---|
| The trailer thesis | thesis-blight-edge.png | <SHA> | node tools/capture.mjs --out shots-trailer --only 20-blight-edge |
| The thesis, moving | clips/blightEdge-1337.webm (regenerate) | <SHA> | node tools/clipshot.mjs --arm blightEdge --secs 10 |
| The instrument panel | instrument-panel.png | <SHA> | node tools/gaugeshot.mjs --seed 1337 --secs 75 --target 150 |
| ... one row per curated entry ... |
```

Each entry's paragraph states what the frame argues (the thesis it photographs) and what would invalidate it (the "re-shoot when" condition). Fill `<SHA>` with the commit each capture was actually taken at — `git log -1 --format=%h` at capture time for the new ones, the recorded SHA from the source record for inherited ones. For inherited shots whose source file is gitignored-local-only (e.g. `reviews/round8/ui-money-shot.png`, `shots-blight/09-money-shot.png`), the entry must say the committed `shotlib/` copy is now the only tracked instance of that frame.

- [ ] **Step 3: Land the git story.**

```bash
git check-ignore -v shotlib/MANIFEST.md
```

Expected: no output (not ignored). Then append to `.gitignore` the line `shotlib/clips/`, and:

```bash
git add .gitignore shotlib/MANIFEST.md shotlib/*.png
git status --short
```

(No `-f` needed — nothing in the live `.gitignore` matches `shotlib/*.png`; if `git add` reports an ignore, stop and find which pattern grew, do not reach for `-f`.) Verify the status shows exactly the intended files, nothing from `shotlib/clips/`, nothing from `shots-trailer/`.

- [ ] **Step 4: Gates.** `node tests/run.mjs` passes (nothing in src/ changed this task); total added bytes under 10 MB (`git diff --cached --stat`).

- [ ] **Step 5: Commit.**

```bash
git commit -m "The library exists: every money shot in one place, each frame arguing from its own receipt"
```

---

## Self-Review

- **Spec coverage:** §3.4's three nouns — running shot library (Task 3), money shot per milestone (Task 3 backfills, Task 1 adds the thesis), trailer thesis shot (Task 1); §3.2's sales-unit clip (Task 2). The trailer itself (editing) is Phase 4 non-engineering and out of scope.
- **Placeholders:** the `<SHA>`/`<...>` tokens in Task 3's manifest template are deliberate fill-at-capture-time values, instructed as such; no TBDs elsewhere.
- **Type consistency:** `blightEdge` is the name Task 1 defines, Task 2 defaults `--arm` to, and Task 3's manifest rows quote. `20-blight-edge` matches between the capture scenario and the `mustContain` label.
