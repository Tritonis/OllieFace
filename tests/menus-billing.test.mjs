/**
 * A menu that throws costs the player the menus, not the whole UI.
 *
 *   node tests/menus-billing.test.mjs
 *
 * Issue #118. `Menus` used to be constructed by `HUD.init` and pumped from the
 * first statement of `HUD.update`, so the Engine — which bills a failure to the
 * system whose phase it escaped — attributed every throw out of a menu, the
 * pause screen, the settings screen or the mutation window to `HUD.update`.
 * Since #72 six consecutive failures in one phase drop a noncritical system for
 * the rest of the run, so a defect anywhere in the menus took down the entire
 * HUD along with them: the health bar, the item strip, the boss bar, and the
 * death screen and settings a player would have used to recover.
 *
 * The billing scope now matches the failure scope: `Menus` is registered in
 * `main.js` in its own right.
 *
 * **This test is written to be red on the old structure**, and that is the
 * point of it — nothing previously asserted WHICH system was billed when Menus
 * threw, which is why the arrangement survived two independent reviews. So the
 * behavioural half does not hard-code either shape. It reads the wiring out of
 * `src/main.js` and `src/ui/HUD.js` and builds the frame that source describes:
 * point it at the old tree and it constructs the HUD-owns-Menus shape, watches
 * the Engine name `HUD`, and fails on the assertion below. Point it at this one
 * and it constructs the registered shape and passes.
 *
 * Real prototypes are used rather than look-alikes so the criticality flags and
 * the `constructor.name` the Engine reports are the shipped ones. Their bodies
 * are stubbed because there is no jsdom here and both classes want a document.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';
import { CameraRig } from '../src/core/CameraRig.js';
import { HUD } from '../src/ui/HUD.js';
import { Menus } from '../src/ui/Menus.js';
import { NetHost } from '../src/net/NetHost.js';
import { Progression } from '../src/systems/Progression.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const mainSrc = readFileSync(join(SRC, 'main.js'), 'utf8');
const hudSrc = readFileSync(join(SRC, 'ui/HUD.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** Run `fn` with the console's error channel captured — a wedge logs once. */
function quietly(fn) {
  const real = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = real; }
}

// ------------------------------------------------------- the wiring, as source

/** Does `main.js` register Menus as a system of its own? */
const registered = /engine\.add\(\s*new Menus\(/.test(mainSrc);
/** Does the HUD still pump Menus from one of its own frame phases? */
const hudPumps = /this\.menus\??\.(update|orbit)\(/.test(hudSrc);

console.log('the wiring says who owns the menus');
{
  ok(registered, 'main.js registers Menus with engine.add()');
  ok(!hudPumps, 'HUD does not also pump Menus from its own frame phases (that would tick it twice and bill HUD)');
  ok(Menus.critical === false, 'Menus declares static critical = false — a broken menu degrades, it does not end the run');
  ok(typeof Menus.prototype.update === 'function', 'Menus has an update phase of its own');
  ok(typeof Menus.prototype.lateUpdate === 'function', 'and a lateUpdate, which is where the title orbit went');
  ok(HUD.prototype.lateUpdate === undefined, 'and the HUD no longer carries the lateUpdate that used to run that orbit');
  ok(mainSrc.indexOf('engine.add(new Menus(') < mainSrc.indexOf('engine.add(new HUD())'),
    'Menus is registered before HUD, which needs the ctx.settings its constructor publishes');
  // Pinned because deleting `HUD.lateUpdate` made `main.js`'s line order the
  // only thing keeping the title orbit after the rig — the rig used to be the
  // reason that call sat in a *late* phase at all, and nothing but this line
  // now records it. Cheap to state, and an ordering nobody can see is an
  // ordering somebody reshuffles.
  ok(mainSrc.indexOf('engine.add(new CameraRig())') < mainSrc.indexOf('engine.add(new Menus('),
    'CameraRig is registered before Menus, so the title orbit still writes last');
}

// -------------------------------------------------- what a wedged menu costs

/**
 * Build a frame in the shape the source above describes, and wedge the menus.
 *
 * Returns the engine, the two systems, and every `systemDisabled` entry.
 */
function wedgeTheMenus() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;

  const menus = Object.create(Menus.prototype);
  menus.update = () => { throw new Error('the pause screen threw'); };

  const hud = Object.create(HUD.prototype);
  hud.updates = 0;
  // The HUD's real update does a great deal more; what matters here is only
  // whether it reaches into Menus, which is the fact read off the source.
  hud.update = function () { this.updates++; if (hudPumps) menus.update(); };
  // The real `init` builds the whole overlay out of `document`, which is not
  // here. It publishes `ctx.hud` and caches `ctx`; those are the parts the rest
  // of this test needs.
  hud.ctx = engine.ctx;
  hud.init = (ctx) => { ctx.hud = hud; };

  if (registered) engine.add(menus);
  engine.add(hud);

  const disabled = [];
  engine.ctx.events.on('systemDisabled', (e) => disabled.push(e));
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  return { engine, menus, hud, disabled };
}

console.log('a wedged menu is billed to Menus, and the HUD outlives it');
{
  const { engine, menus, hud, disabled } = wedgeTheMenus();

  ok(disabled.length === 1, `exactly one system was given up on (${disabled.length})`);
  ok(disabled[0]?.name === 'Menus',
    `the systemDisabled event names Menus, not HUD (named ${disabled[0]?.name})`);
  ok(!engine.systems.includes(menus), 'Menus is out of the update list');
  ok(engine.systems.includes(hud), 'the HUD is still in the update list');

  const before = hud.updates;
  quietly(() => engine._frame());
  ok(hud.updates === before + 1, 'and it is still being updated after the menus are gone');
  ok(engine.running === true && engine.ctx.fatalError === null, 'the run continues');
}

console.log('the HUD stops reaching for a system nobody is running');
{
  const { engine, hud } = wedgeTheMenus();
  // `remove()` blanks what the dead system's `init` published, and the HUD
  // reads its menus back off `ctx` for exactly this reason: it must not go on
  // calling into a Menus the Engine has given up on. Every `this.menus` use in
  // HUD.js is `?.`-guarded against this window.
  ok(engine.ctx.menus === null, 'ctx.menus was blanked when Menus was dropped');
  ok(hud.menus === null, 'so the HUD sees no menus rather than a dead one');
  ok(!/this\.menus\.[a-zA-Z]/.test(hudSrc), 'and no unguarded `this.menus.` call survives in HUD.js');
}

// ------------------------------------------- the other half of the new state

/**
 * Splitting the two systems created a state that could not exist before: the
 * HUD dead and the menus alive. They used to die together — the menus were
 * pumped from `HUD.update`, so `remove()` blanking `ctx.hud` stopped them being
 * run at all and "no menu is open" was true by construction. Now six *HUD*
 * throws blank `ctx.hud` while Menus goes on running its own `update`, so
 * anything that asked `ctx.hud?.menus?.screen` began answering "no menu open"
 * with the pause screen up and taking input.
 *
 * Every reader in `src/` therefore asks the owner. That is not merely a
 * fallback ordering: since `HUD.menus` is itself `ctx.menus`, going through the
 * HUD is `ctx.menus` behind a liveness test on an unrelated system, and can
 * only ever answer with less.
 */
console.log('nothing in src/ asks the HUD about the menus');
{
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      // HUD.js is the one file allowed to say it: `hud.menus` is its own
      // accessor, and what that accessor reads is `ctx.menus`.
      if (p.endsWith(join('ui', 'HUD.js'))) continue;
      const src = readFileSync(p, 'utf8');
      for (const [i, line] of src.split(/\r?\n/).entries()) {
        // Comments talk about the old path — that is what the comments are
        // for. Only code counts.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/\bhud\s*\??\.\s*menus/.test(line)) offenders.push(`${p}:${i + 1}`);
      }
    }
  };
  walk(SRC);
  ok(offenders.length === 0, `no src/ file routes menu state through ctx.hud (${offenders.join(', ') || 'none'})`);
}

/**
 * Kill the HUD and leave the menus running — the state the split created.
 *
 * Six HUD throws blank `ctx.hud` while Menus goes on running its own `update`.
 * Every arm below starts here, because each hazard it guards is a reader that
 * must ask `ctx.menus` rather than the corpse at `ctx.hud`.
 */
function deadHudLiveMenus() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;

  const menus = Object.create(Menus.prototype);
  menus.screen = null;
  menus.update = () => {};
  menus.lateUpdate = () => {};
  menus.init = (ctx) => { ctx.menus = menus; };

  const hud = Object.create(HUD.prototype);
  hud.init = (ctx) => { ctx.hud = hud; };
  hud.update = () => { throw new Error('the item strip threw'); };

  engine.add(menus);
  engine.add(hud);
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  return { engine, menus, ctx: engine.ctx };
}

console.log('a dead HUD does not hand the world to a stick behind the pause screen');
{
  const { engine, menus, ctx } = deadHudLiveMenus();
  ok(ctx.hud === null, 'the HUD was given up on and ctx.hud is blank');
  ok(ctx.menus === menus && engine.systems.includes(menus),
    'the menus survived it — the state this whole block exists for');

  // The player pauses a run whose HUD is already gone, and rests a thumb on
  // the right stick. Real CameraRig: the gate under test is its own line.
  const rig = new CameraRig();
  rig.init(ctx);
  ctx.player = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(),
    horizontalSpeed: 0, sprintBlend: 0, dashT: 0, dashRoll: 0,
  };
  ctx.input = { locked: false, enabled: true, mouse: { dx: 0, dy: 0 }, pad: { active: true, lookX: 1, lookY: 0 } };

  menus.screen = 'pause';
  const yawPaused = rig.yaw;
  rig.lateUpdate(ctx, 1 / 60);
  ok(rig.yaw === yawPaused, 'the stick does not rotate the world behind the pause screen');

  // And the guard can fail: with no screen open the same stick does turn, so a
  // pass above is the gate working rather than the pad being ignored outright.
  menus.screen = null;
  rig.lateUpdate(ctx, 1 / 60);
  ok(rig.yaw !== yawPaused, 'and the same stick does turn it once the screen is closed');
}

// -------------------------------------------------- NetHost.js:532 — the mute

/**
 * A networked host's pause-menu keystrokes must not drive its survivor.
 *
 * `_holdSession` releases `ctx.paused` while a peer is still playing, so the
 * host's own frame keeps running behind its overlay, and the mute at :568 is
 * the only thing stopping those keystrokes reaching `Player._sampleCommand`.
 * The comment at :562-567 records that as a fixed regression; until now the
 * only thing holding it was the source scan above, which any spelling of
 * `ctx.menus.screen` satisfies whatever the method then does with it. So run
 * the real method, against the state the scan cannot see.
 */
console.log('a networked host behind a pause screen does not drive its survivor');
{
  const { ctx } = deadHudLiveMenus();
  ctx.input = { enabled: true };

  const host = new NetHost({ maxPlayers: 4 });
  let clock = 0;
  host._now = () => clock;
  // A peer still playing. The real `hasLivePeer()` reads this map.
  host.clients.set(1, { peer: { id: 1 }, pawn: { alive: true }, inputs: [], lastTick: 0 });

  ctx.menus.screen = 'pause';
  host._holdSession(ctx);
  ok(ctx.paused === false, 'the world is not paused — somebody else is still playing in it');
  ok(ctx.input.enabled === false,
    'and the host’s own input is muted while its own pause screen is up');

  // Not a blanket mute: same host, same live peer, screen closed, and the
  // stick comes back. So a pass above is the screen being seen rather than
  // input being off for some unrelated reason.
  ctx.menus.screen = null;
  host._holdSession(ctx);
  ok(ctx.input.enabled === true, 'and it comes back the moment the screen closes');

  // The peer dies inside the grace window with the screen still up: no pause
  // yet (the dying peer is owed one more snapshot), and still no input,
  // because the host is standing in a menu.
  ctx.menus.screen = 'pause';
  host._holdSession(ctx);
  host.clients.get(1).pawn.alive = false;
  clock += 0.5;
  host._holdSession(ctx);
  ok(ctx.paused === false && ctx.input.enabled === false,
    'a peer dying inside the grace window does not hand the stick back mid-menu');
}

// -------------------------------------------- Progression.js:525 — the headline

/**
 * The victory headline must not read "You Died".
 *
 * `finishRun` rewrites the death panel's authored markup, and it can only
 * reach that markup through `ctx.menus.root`. With the HUD dropped, a reader
 * routed via `ctx.hud` finds nothing, writes nothing, and the winning player
 * is told they died. The DOM here is two nodes and a `querySelector` because
 * there is no jsdom; the method under test is the shipped one.
 */
console.log('a winning player is not told they died by a HUD that is already gone');
{
  const { ctx } = deadHudLiveMenus();

  const word = { textContent: 'You Died' };
  const sub = { textContent: 'The void keeps what it takes.' };
  ctx.menus.root = {
    querySelector: (sel) => (sel.includes('death-word') ? word
      : sel.includes('data-death-sub') ? sub : null),
  };

  const prog = Object.create(Progression.prototype);
  prog.ctx = ctx;
  prog._ended = false;
  // `_endRun` commits a profile record and raises `runEnd`; neither is what
  // this arm is about, and both want the whole run's accumulated state.
  let committed = null;
  prog._endRun = (won) => { committed = won; };

  prog.finishRun({ won: true, title: 'You Left', line: 'The Obelisk closes behind you.' });

  ok(committed === true, 'the run was committed as won');
  ok(word.textContent === 'You Left',
    `the headline names the ending rather than a death (${word.textContent})`);
  ok(sub.textContent === 'The Obelisk closes behind you.',
    'and the sub-line is the ending’s own');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
