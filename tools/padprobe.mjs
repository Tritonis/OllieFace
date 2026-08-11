/**
 * Gamepad probe: every claim the gamepad-play slice makes, under the real
 * renderer.
 *
 *   node tools/padprobe.mjs [--port 5210] [--seed 1337] [--out shots-pad]
 *                           [--record reviews/round9/padprobe-record.json]
 *
 * Drives the game with a synthetic gamepad under the real renderer and gates
 * every claim the gamepad-play slice makes. Fake pad, real everything else:
 * navigator.getGamepads is patched before the game boots, then each scenario
 * mutates window.__PAD__ and asserts on __GAME__.ctx state.
 *
 * Same launch recipe as tools/menuprobe.mjs (headed d3d11, offscreen window),
 * on a different default port so the two can never fight over one listener.
 * Every check lands in the record JSON with a measured detail — metres, radians,
 * frames, bitmasks — not a bare boolean. Exit 1 unless every check passes.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--(\w+)$/);
  if (m) args[m[1]] = process.argv[++i];
}
const SEED = Number(args.seed ?? 1337);
const PORT = Number(args.port ?? 5210);
const OUT = path.resolve(args.out ?? 'shots-pad');
const RECORD = path.resolve(args.record ?? 'reviews/round9/padprobe-record.json');
const W = 1600, H = 900;

// A pre-slice settings blob: every key the game shipped with before this slice,
// and deliberately no `padSensitivity`. Check 10 proves the default merges in.
const LEGACY_SETTINGS = {
  quality: 2, fov: 95, sensitivity: 1.4, master: 0.5, sfx: 0.8, music: 0.6,
  shake: 1, spawnRate: 1,
};

const BUTTONS = 17;
/** A standard-mapping gamepad snapshot: four axes, seventeen buttons. */
const pad = (axes = [0, 0, 0, 0], pressed = []) => ({
  connected: true, index: 0, id: 'padprobe synthetic (STANDARD GAMEPAD)',
  mapping: 'standard', timestamp: 0, axes: axes.slice(),
  buttons: Array.from({ length: BUTTONS }, (_, i) => {
    const down = pressed.includes(i);
    return { pressed: down, touched: down, value: down ? 1 : 0 };
  }),
});

await mkdir(OUT, { recursive: true });
const checks = [];
const ok = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS ' : 'FAIL '} ${name} — ${detail}`);
  checks.push({ name, pass: !!cond, detail: String(detail) });
};

const server = await createServer({
  server: { port: PORT, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  timeout: 120000,
  headless: false,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force_high_performance_gpu',
    '--window-position=-2400,-2400', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); pageErrors.push(e.message); });

// The fake pad, installed before a line of game code runs.
await page.addInitScript(() => {
  window.__PAD__ = null;
  navigator.getGamepads = () => [window.__PAD__];
});
// ...and the legacy settings blob, likewise before boot (check 10).
await page.addInitScript((blob) => {
  try { localStorage.setItem('telluric.settings', JSON.stringify(blob)); } catch { /* private mode */ }
}, LEGACY_SETTINGS);

// The record is invalidated before the first check runs. A probe that throws
// part way — a timed-out waitForFunction is the normal shape of a real
// regression here — must never leave the previous green record on disk looking
// like it describes this HEAD.
await mkdir(path.dirname(RECORD), { recursive: true });
await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(), probe: 'tools/padprobe.mjs',
  aborted: 'run in progress — this file is rewritten when the probe finishes',
  checks: [], allPass: false,
}, null, 2)}\n`);

// ----------------------------------------------------------------- utilities

const setPad = (p) => page.evaluate((v) => { window.__PAD__ = v; }, p);
const idlePad = () => setPad(pad());

/** Wait for `n` real engine frames. `Engine.frame` advances while paused too. */
const frames = async (n) => {
  const at = await page.evaluate(() => __GAME__.engine.frame);
  await page.waitForFunction((t) => __GAME__.engine.frame >= t, at + n, { timeout: 30000 });
};

const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

/** The [data-nav] element the focus ring is on right now. */
const focused = () => page.evaluate(() => {
  const m = __GAME__.ctx.hud.menus;
  const el = m.navTargets()[m.navIndex];
  if (!el) return null;
  return {
    index: m.navIndex, tag: el.tagName, type: el.type ?? null,
    act: el.dataset.act ?? null, key: el.dataset.key ?? null,
    label: (el.textContent || '').trim().slice(0, 24),
  };
});

/**
 * One menu step on the stick. readPad rate-limits a held stick (380 ms to the
 * first repeat), so a step is: deflect, let one poll see it, return to centre,
 * and wait for the repeat gate to re-arm — `_padHeld` false is that signal.
 */
const navPulse = async (dx, dy) => {
  await setPad(pad([dx, dy, 0, 0]));
  await frames(3);
  await idlePad();
  await page.waitForFunction(() => !__GAME__.ctx.hud.menus._padHeld, null, { timeout: 5000 });
  await frames(2);
};

/** Walk the ring down until `pred(focusInfo)` holds. Returns steps, or -1. */
const navUntil = async (pred, max = 24) => {
  for (let i = 0; i <= max; i++) {
    if (pred(await focused())) return i;
    await navPulse(0, 1);
  }
  return -1;
};

/** Tap a pad button for `hold` frames, then release. */
const tap = async (btn, hold = 4) => {
  await setPad(pad([0, 0, 0, 0], [btn]));
  await frames(hold);
  await idlePad();
  await frames(2);
};

const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

// ------------------------------------------------------------------- check 1
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/?seed=${SEED}&quality=${2}&harness=1`, { waitUntil: 'load' });
await page.waitForFunction(() => globalThis.__GAME__?.ctx?.hud?.menus?.screen === 'title', null, { timeout: 60000 });
const bootMs = Date.now() - t0;
const bootFrames = await page.evaluate(() => __GAME__.engine.frame);
ok('1 boot', bootMs > 0 && bootFrames > 0,
  `title screen up in ${bootMs} ms, ${bootFrames} frames rendered, seed ${SEED}, harness=1`);

// The pre-slice blob is on disk and the merged default is live — measured now,
// asserted at check 10 where the spec puts it.
const padSensAtBoot = await page.evaluate(() => __GAME__.ctx.settings.padSensitivity);

// ------------------------------------------------------------------- check 2
// Title [data-nav] order is Play, Logbook, Co-op, Settings, Quit; open() reset
// navIndex to 0. The pad has to walk it and confirm through the shipped path.
await setPad(pad());
await frames(2);
await navPulse(0, 1);
const navDown = await page.evaluate(() => __GAME__.ctx.hud.menus.navIndex);
await navPulse(0, -1);
const navUp = await page.evaluate(() => __GAME__.ctx.hud.menus.navIndex);
ok('2a menu nav', navDown === 1 && navUp === 0,
  `stick down -> navIndex ${navDown} (want 1), stick up -> navIndex ${navUp} (want 0)`);

const focusBeforeConfirm = await focused();
await tap(0);
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'select', null, { timeout: 10000 })
  .catch(() => {});
const screenAfterA = await page.evaluate(() => __GAME__.ctx.hud.menus.screen);
ok('2b menu confirm', screenAfterA === 'select',
  `A on "${focusBeforeConfirm?.label}" (index ${focusBeforeConfirm?.index}) -> screen "${screenAfterA}"`);

// ------------------------------------------------------------------- check 3
// Into a run the way menuprobe does — clicks are fine for ground check 2 covers.
await page.click('[data-act="launch"]');
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === null, null, { timeout: 30000 });
await page.waitForFunction(() => __GAME__.ctx.player?.alive === true, null, { timeout: 30000 });
await frames(20);
const spawn = await page.evaluate(() => {
  const p = __GAME__.ctx.player.position;
  return { x: p.x, y: p.y, z: p.z };
});
ok('3 in a run', Number.isFinite(spawn.x),
  `player alive at (${num(spawn.x, 2)}, ${num(spawn.y, 2)}, ${num(spawn.z, 2)})`);

// ------------------------------------------------------------------- check 4
// MOVE: hold the left stick forward, then let go and watch the speed bleed off.
const before = await page.evaluate(() => {
  const p = __GAME__.ctx.player.position;
  return { x: p.x, y: p.y, z: p.z };
});
await setPad(pad([0, -1, 0, 0]));
await frames(40);
const moving = await page.evaluate(() => ({
  x: __GAME__.ctx.player.position.x, z: __GAME__.ctx.player.position.z,
  speed: __GAME__.ctx.player.horizontalSpeed,
}));
const moved = Math.hypot(moving.x - before.x, moving.z - before.z);
ok('4a pad move', moved > 1,
  `left stick forward for 40 frames moved ${num(moved, 3)} m (want > 1), speed ${num(moving.speed, 2)} m/s`);

await idlePad();
await frames(30);
const restSpeed = await page.evaluate(() => __GAME__.ctx.player.horizontalSpeed);
ok('4b release decays', restSpeed < Math.max(0.5, moving.speed * 0.25),
  `speed ${num(moving.speed, 2)} -> ${num(restSpeed, 3)} m/s 30 frames after release`);

// ------------------------------------------------------------------- check 5
// LOOK: the right stick is a rate, not pixels. Yaw first, then the pitch clamp.
const yaw0 = await page.evaluate(() => __GAME__.ctx.cameraRig.yaw);
await setPad(pad([0, 0, 1, 0]));
await frames(30);
await idlePad();
const yaw1 = await page.evaluate(() => __GAME__.ctx.cameraRig.yaw);
let dYaw = yaw1 - yaw0;
if (dYaw > Math.PI) dYaw -= Math.PI * 2;
else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
ok('5a pad look yaw', dYaw < -0.3,
  `right stick +x for 30 frames turned yaw by ${num(dYaw, 4)} rad (want < -0.3)`);

await setPad(pad([0, 0, 0, 1]));
await frames(120);
await idlePad();
const pitch = await page.evaluate(() => __GAME__.ctx.cameraRig.pitch);
ok('5b pitch clamp', Number.isFinite(pitch) && pitch >= -1.15,
  `stick full down for 120 frames left pitch at ${num(pitch, 4)} rad (PITCH_MIN -1.15)`);
await frames(2);

// ------------------------------------------------------------------- check 6
// FIRE: RT rides the mouse-left flag, so the sampled command carries BTN.FIRE.
await setPad(pad([0, 0, 0, 0], [7]));
await frames(20);
const firing = await page.evaluate(() => ({
  buttons: __GAME__.ctx.player.lastCommand?.buttons ?? 0,
  mouseLeft: !!__GAME__.ctx.input.mouse.left,
}));
await idlePad();
await frames(6);
const afterFire = await page.evaluate(() => ({
  buttons: __GAME__.ctx.player.lastCommand?.buttons ?? 0,
  mouseLeft: !!__GAME__.ctx.input.mouse.left,
}));
ok('6 RT fires', (firing.buttons & 4) === 4 && (afterFire.buttons & 4) === 0,
  `lastCommand.buttons ${firing.buttons} (BTN.FIRE=4 set, mouse.left ${firing.mouseLeft}) -> ${afterFire.buttons} on release`);

// ------------------------------------------------------------------- check 7
await setPad(pad([0, 0, 0, 0], [0]));
await frames(6);
const jumping = await page.evaluate(() => __GAME__.ctx.player.lastCommand?.buttons ?? 0);
await idlePad();
await frames(4);
ok('7 A jumps', (jumping & 1) === 1,
  `A held 6 frames -> lastCommand.buttons ${jumping} (BTN.JUMP=1 set)`);

// ------------------------------------------------------------------- check 8
// START opens pause; A confirms Resume, which proves the pad is still polled
// while the fixed loop is frozen.
await setPad(pad([0, 0, 0, 0], [9]));
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'pause', null, { timeout: 10000 })
  .catch(() => {});
const paused = await page.evaluate(() => ({
  screen: __GAME__.ctx.hud.menus.screen, paused: !!__GAME__.ctx.paused,
  focus: __GAME__.ctx.hud.menus.navTargets()[__GAME__.ctx.hud.menus.navIndex]?.dataset.act ?? null,
}));
await idlePad();
await frames(4);
ok('8 Start pauses', paused.screen === 'pause' && paused.paused,
  `screen "${paused.screen}", ctx.paused ${paused.paused}, ring on "${paused.focus}"`);

const pausedFrame = await page.evaluate(() => __GAME__.engine.frame);
await tap(0);
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === null, null, { timeout: 10000 })
  .catch(() => {});
const resumed = await page.evaluate(() => ({
  screen: __GAME__.ctx.hud.menus.screen, paused: !!__GAME__.ctx.paused,
  frame: __GAME__.engine.frame,
}));
ok('8 A resumes (pad polls while paused)', resumed.screen === null && resumed.paused === false,
  `A on Resume after ${resumed.frame - pausedFrame} paused frames -> screen ${resumed.screen}, ctx.paused ${resumed.paused}`);

// ------------------------------------------------------------------ check 8b
// START-WHILE-HELD (pre-flight review I3): sprint held when Start is pressed
// must not read as a fresh A/B edge on the menu's first frame.
await frames(6);
await setPad(pad([0, 0, 0, 0], [1]));           // B = sprint, held
await frames(10);
await setPad(pad([0, 0, 0, 0], [1, 9]));        // ...and Start, B still down
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'pause', null, { timeout: 10000 })
  .catch(() => {});
const openedFrame = await page.evaluate(() => __GAME__.engine.frame);
await setPad(pad([0, 0, 0, 0], [1]));           // Start released, B still held
await frames(14);
const heldOpen = await page.evaluate(() => ({
  screen: __GAME__.ctx.hud.menus.screen, frame: __GAME__.engine.frame,
  sprint: !!__GAME__.ctx.input.down('ShiftLeft'),
}));
ok('8b Start with sprint held', heldOpen.screen === 'pause' && heldOpen.frame - openedFrame >= 10,
  `pause stayed open ${heldOpen.frame - openedFrame} frames (want >= 10) with B held (sprint ${heldOpen.sprint})`);

// ------------------------------------------------------------------ check 11
// The pause screen with the pad's focus ring on it — photographed here, while
// it is genuinely up, rather than reopened for the camera.
await shot('01-pause-focus.png');
const ring = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.screen--pause [data-nav].is-focus')];
  return { count: els.length, label: (els[0]?.textContent || '').trim().slice(0, 24) };
});
ok('11 focus ring photographed', ring.count === 1,
  `${ring.count} focus ring on the pause screen ("${ring.label}"), shots-pad/01-pause-focus.png`);

// ----------------------------------------------------------------- check 10b
// SLIDER (pre-flight review I2): ring onto Gamepad look, then one right step.
await idlePad();
await frames(4);
const toSettings = await navUntil((f) => f?.act === 'settings');
await tap(0);
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'settings', null, { timeout: 10000 })
  .catch(() => {});
const onSettings = await page.evaluate(() => __GAME__.ctx.hud.menus.screen);
const toSlider = onSettings === 'settings' ? await navUntil((f) => f?.key === 'padSensitivity') : -1;
const sliderFocus = await focused();
const sensBefore = await page.evaluate(() => __GAME__.ctx.settings.padSensitivity);
await navPulse(1, 0);
const sensAfter = await page.evaluate(() => __GAME__.ctx.settings.padSensitivity);
const savedAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('telluric.settings')).padSensitivity);
ok('10b pad adjusts the slider', toSettings >= 0 && toSlider >= 0 && sensAfter > sensBefore,
  `${toSettings} steps to Settings, ${toSlider} steps to "${sliderFocus?.key}"; dx right ${num(sensBefore)} -> ${num(sensAfter)} (saved ${num(savedAfter)})`);

// ------------------------------------------------------------------ check 10
// The pre-slice blob had no padSensitivity; the default merged in at 1.
ok('10 legacy settings merge', padSensAtBoot === 1,
  `telluric.settings seeded with ${Object.keys(LEGACY_SETTINGS).length} pre-slice keys and no padSensitivity -> ctx.settings.padSensitivity ${num(padSensAtBoot)} at boot`);

// Back out of settings and out of the pause screen, with the pad.
await tap(1);
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === 'pause', null, { timeout: 10000 })
  .catch(() => {});
await tap(1);
await page.waitForFunction(() => __GAME__.ctx.hud.menus.screen === null, null, { timeout: 10000 })
  .catch(() => {});
await frames(6);

// ------------------------------------------------------------------- check 9
// GLYPH: the prompt badge names the device that spoke last.
await idlePad();
await frames(6);
const glyphPad = await page.evaluate(() => ({
  key: document.querySelector('.prompt-key')?.textContent,
  active: !!__GAME__.ctx.input.padActive,
}));
await page.keyboard.press('KeyW');
await frames(6);
const glyphKb = await page.evaluate(() => ({
  key: document.querySelector('.prompt-key')?.textContent,
  active: !!__GAME__.ctx.input.padActive,
}));
ok('9 prompt glyph follows the device', glyphPad.key === 'X' && glyphKb.key === 'E',
  `pad active ${glyphPad.active} -> ".prompt-key" "${glyphPad.key}"; after KeyW active ${glyphKb.active} -> "${glyphKb.key}"`);

// ------------------------------------------------------------------------ end
ok('no page errors', pageErrors.length === 0,
  pageErrors.length ? pageErrors.join(' | ') : '0 uncaught page errors across the run');

await browser.close();
await server.close();

const allPass = checks.every((c) => c.pass);
await mkdir(path.dirname(RECORD), { recursive: true });
await writeFile(RECORD, `${JSON.stringify({
  when: new Date().toISOString(),
  probe: 'tools/padprobe.mjs',
  url: `/?seed=${SEED}&quality=2&harness=1`,
  checks,
  allPass,
}, null, 2)}\n`);

const failed = checks.filter((c) => !c.pass);
console.log(failed.length
  ? `\nFAIL - ${failed.length}/${checks.length}: ${failed.map((c) => c.name).join('; ')}`
  : `\nPASS - ${checks.length} pad checks verified under the real renderer`);
console.log(`record: ${RECORD}`);
console.log(`PNGs in ${OUT}`);
process.exit(allPass ? 0 : 1);
