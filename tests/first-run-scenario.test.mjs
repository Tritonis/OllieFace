/**
 * The first-run scenario (#41).
 *
 *   node tests/first-run-scenario.test.mjs
 *
 * The defect this file is written against is the one this repo keeps shipping:
 * a guard that certifies a flag was SET rather than that behaviour CHANGED. So
 * nothing below asserts `active === true` as a result. Every claim is made
 * against the only thing the player can see — the string in the sink the HUD
 * owns — and against the beat that a real gameplay event does or does not
 * advance. Each riskiest guard carries its own control: the same event fired in
 * the wrong beat, or by the wrong pawn, must NOT move it.
 *
 * `Tutorial` is driven through the real event bus contract (`events.on`) and
 * the real payload shapes emitted by `systems/Items.js`, `entities/Player.js`
 * and `systems/Progression.js` — the names are copied from those emit sites,
 * not invented here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Tutorial, BEATS, SKILL_SLOTS, MOVE_DISTANCE, shouldArmTutorial } from '../src/systems/Tutorial.js';
import { bindings } from '../src/core/Bindings.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

/* -- stubs ------------------------------------------------------------- */

function bus() {
  const map = new Map();
  return {
    on(n, fn) { (map.get(n) || map.set(n, []).get(n)).push(fn); },
    emit(n, e) { for (const fn of map.get(n) || []) fn(e); },
  };
}

function lineEl() {
  const on = new Set();
  return {
    textContent: '',
    classList: { toggle: (c, v) => { if (v) on.add(c); else on.delete(c); }, has: (c) => on.has(c) },
    get lit() { return on.has('is-on'); },
  };
}

/** A ctx with just the surface Tutorial reads. */
function rig({ pad = false, glyphs = 'xbox', armed = true } = {}) {
  const events = bus();
  const player = { position: { x: 0, y: 0, z: 0 } };
  const ctx = { events, player, settings: { controllerGlyphs: glyphs }, input: { padActive: pad }, tutorialArmed: armed };
  const line = lineEl();
  const tut = new Tutorial(ctx, { line }, events);
  return { ctx, events, tut, line, player };
}

/** Walk the local pawn `d` metres, in the steps the frame loop would. */
function walk(rig_, d, step = 1) {
  for (let i = 0; i < Math.ceil(d / step); i++) {
    rig_.player.position.x += step;
    rig_.tut.update(1 / 60);
  }
}

/* -- the curriculum, in the order the issue asks for -------------------- */

ok(BEATS.map((b) => b.id).join(',') === 'move,skills,loot,teleporter,corruption',
  `beats run movement -> skills -> loot -> teleporter -> corruption (got ${BEATS.map((b) => b.id).join(',')})`);

/* -- reachable on a first run, and only then ---------------------------- */

ok(shouldArmTutorial({ firstRunSeen: 0 }, false) === true,
  'a player who has never launched a run gets the scenario unasked');
ok(shouldArmTutorial({ firstRunSeen: 1 }, false) === false,
  'a player who has launched before does not get it again unasked');
ok(shouldArmTutorial({ firstRunSeen: 1 }, true) === true,
  'How to play re-arms it for a player who has already played (replayable)');

/* -- it starts, and the control: it does not start unarmed --------------- */

{
  const r = rig({ armed: false });
  r.events.emit('stageStart', { index: 0 });
  ok(r.line.textContent === '' && !r.line.lit,
    'CONTROL: an unarmed run says nothing at stage start');
}
{
  const r = rig();
  r.events.emit('stageStart', { index: 3 });
  ok(r.line.textContent === '',
    'CONTROL: an armed scenario does not open on a later stage');
  r.events.emit('stageStart', { index: 0 });
  ok(/Move with WASD/.test(r.line.textContent) && r.line.lit,
    `stage 0 of an armed run opens on the movement prompt (got "${r.line.textContent}")`);
}

/* -- movement: covering ground advances it; anything else does not ------- */

{
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  r.events.emit('abilityUsed', { slot: 'primary', player: r.ctx.player });
  r.events.emit('itemPickup', { owner: r.ctx.player });
  ok(/Move with/.test(r.line.textContent),
    'CONTROL: casting and looting while the movement beat is up does not skip it');
  walk(r, MOVE_DISTANCE - 3);
  ok(/Move with/.test(r.line.textContent),
    `standing near the pawn's start keeps the movement prompt up (${MOVE_DISTANCE - 3}m of ${MOVE_DISTANCE})`);
  walk(r, 4);
  ok(/four skills/.test(r.line.textContent),
    `covering ${MOVE_DISTANCE}m hands over to the skills prompt (got "${r.line.textContent}")`);
}

/* -- the four skills: all four, and only the local pawn's ---------------- */

{
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  walk(r, MOVE_DISTANCE + 1);
  const teammate = { position: { x: 0, y: 0, z: 0 } };
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: teammate });
  ok(/four skills/.test(r.line.textContent),
    'CONTROL: a teammate casting all four does not clear the local player\'s beat');
  for (const slot of SKILL_SLOTS.slice(0, 3)) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  ok(/four skills/.test(r.line.textContent) && !/Primary/.test(r.line.textContent),
    'three of four leaves the beat up and drops the used slots from the prompt');
  r.events.emit('abilityUsed', { slot: SKILL_SLOTS[3], player: r.ctx.player });
  ok(/chest/.test(r.line.textContent),
    `the fourth skill hands over to the loot prompt (got "${r.line.textContent}")`);
}

/* -- loot, teleporter, corruption --------------------------------------- */

function atLoot() {
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  return r;
}

{
  const r = atLoot();
  r.events.emit('itemPickup', { id: 'x', owner: { name: 'someone else' } });
  ok(/chest/.test(r.line.textContent),
    'CONTROL: a teammate\'s pickup does not clear the loot beat');
  r.events.emit('teleporterComplete', {});
  ok(/chest/.test(r.line.textContent),
    'CONTROL: a teleporter finishing early does not skip the loot beat');
  r.events.emit('itemPickup', { id: 'x', owner: r.ctx.player });
  ok(/teleporter/i.test(r.line.textContent),
    `the local pickup hands over to the teleporter prompt (got "${r.line.textContent}")`);
  r.events.emit('teleporterComplete', {});
  ok(/void will trade/.test(r.line.textContent),
    `a charged teleporter hands over to the corruption prompt (got "${r.line.textContent}")`);
  r.events.emit('voidBargain', { kind: 'reroll' });
  ok(r.line.textContent === '' && !r.line.lit,
    'taking the first bargain ends the scenario and clears the line');
  ok(r.ctx.tutorialArmed === false,
    'a finished scenario disarms itself, so the next run is unguided');
}

{
  const r = atLoot();
  r.events.emit('itemPickup', { owner: r.ctx.player });
  r.events.emit('teleporterComplete', {});
  r.events.emit('corruptionPact', { from: r.ctx.player, to: { isPlayer: true } });
  ok(r.line.textContent === '',
    'a pact counts as the first corruption choice too');
}

/* -- skippable at any point --------------------------------------------- */

for (const stopAt of ['open', 'skills', 'loot']) {
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  if (stopAt !== 'open') walk(r, MOVE_DISTANCE + 1);
  if (stopAt === 'loot') for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  r.tut.skip();
  ok(r.line.textContent === '' && !r.line.lit, `skip at the ${stopAt} beat clears the line`);
  // The behaviour, not the flag: after a skip the events that used to drive the
  // scenario must drive nothing at all.
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  r.events.emit('itemPickup', { owner: r.ctx.player });
  r.events.emit('teleporterComplete', {});
  ok(r.line.textContent === '', `skip at the ${stopAt} beat stays skipped as the run goes on`);
}

{
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  r.events.emit('runEnd', { won: false });
  ok(r.line.textContent === '', 'a run that ends takes the scenario off screen with it');
}

/* -- prompts name the player's own buttons (#42 must not regress) -------- */

{
  const r = rig({ pad: true, glyphs: 'playstation' });
  r.events.emit('stageStart', { index: 0 });
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  const text = r.line.textContent;
  ok(/Square/.test(text) && !/\bX\b/.test(text),
    `a PlayStation player is told Square, not X (got "${text}")`);
  ok(/Options/.test(text), `the skip hint names the pad's own pause button (got "${text}")`);
}
{
  const r = rig({ pad: true, glyphs: 'switch' });
  r.events.emit('stageStart', { index: 0 });
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  ok(/Y/.test(r.line.textContent) && !/\bX\b/.test(r.line.textContent),
    `a Switch player is told Y for the button Xbox calls X (got "${r.line.textContent}")`);
}
{
  // The prompt is live, not a snapshot: rebinding mid-scenario renames it.
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  const before = r.line.textContent;
  bindings.bindKey('interact', 'KeyG');
  r.tut.update(1 / 60);
  const after = r.line.textContent;
  bindings.reset();
  ok(/ E$/.test(before.replace(/\s+\(.*$/, '')) || / E /.test(before),
    `the loot prompt names the bound interact key (got "${before}")`);
  ok(/ G/.test(after), `rebinding interact mid-scenario renames the prompt (got "${after}")`);
}

/* -- the corruption beat belongs to the local player too ----------------- */

function atCorruption() {
  const r = atLoot();
  r.events.emit('itemPickup', { owner: r.ctx.player });
  r.events.emit('teleporterComplete', {});
  return r;
}

{
  const r = atCorruption();
  r.events.emit('voidBargain', { kind: 'reroll', marks: 2, count: 1, owner: { name: 'a teammate' } });
  ok(/void will trade/.test(r.line.textContent),
    'CONTROL: a teammate taking a bargain does not end the local scenario');
  r.events.emit('corruptionPact', { from: { isPlayer: true }, to: { isPlayer: true }, amount: 3 });
  ok(/void will trade/.test(r.line.textContent),
    'CONTROL: a pact between two other players does not end the local scenario');
  r.events.emit('voidBargain', { kind: 'reroll', marks: 2, count: 1, owner: r.ctx.player });
  ok(r.line.textContent === '', 'the local player takes the bargain and it does end');
}
{
  const r = atCorruption();
  r.events.emit('corruptionPact', { from: { isPlayer: true }, to: r.ctx.player, amount: 3 });
  ok(r.line.textContent === '',
    'a pact that moves attribution ONTO the local player is their corruption choice too');
}
{
  // The teleporter is a shared objective with no actor on its payload
  // (Progression.js emits `teleporterComplete` bare), so it stays unfiltered on
  // purpose. Asserted so a later owner-filter sweep cannot quietly break co-op.
  const r = atLoot();
  r.events.emit('itemPickup', { owner: r.ctx.player });
  r.events.emit('teleporterComplete', {});
  ok(/void will trade/.test(r.line.textContent),
    'a teammate charging the teleporter still advances the shared objective beat');
}

/* -- a store written before this feature is not a first run -------------- */

{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const { loadSettings } = await import('../src/ui/Menus.js');

  store.clear();
  ok(shouldArmTutorial(loadSettings(), false) === true,
    'no settings store at all is a genuine first run and arms the scenario');

  // A blob in exactly the shape this repo shipped before #41: real settings,
  // no `firstRunSeen` key anywhere in it.
  store.clear();
  store.set('telluric.settings', JSON.stringify({ quality: 2, master: 0.8, captions: 0, controllerGlyphs: 'xbox' }));
  const legacy = loadSettings();
  ok(legacy.firstRunSeen === 1,
    `a settings blob predating this feature reads as already played (got ${legacy.firstRunSeen})`);
  ok(shouldArmTutorial(legacy, false) === false,
    'an existing player is not ambushed with a tutorial by upgrading');
  ok(shouldArmTutorial(legacy, true) === true,
    'and they can still ask for it from the title');

  store.clear();
  store.set('telluric.settings', JSON.stringify({ quality: 2, firstRunSeen: 0 }));
  ok(shouldArmTutorial(loadSettings(), false) === true,
    'a stored explicit 0 still means never played');
  delete globalThis.localStorage;
}

/* -- the wiring, which no unit test above can see ------------------------ */

{
  const hud = read('src/ui/HUD.js');
  ok(/new Tutorial\(ctx, \{ line: this\.refs\.tutorial \}\)/.test(hud) && /ctx\.tutorial = this\.tutorial/.test(hud),
    'HUD builds the Tutorial and publishes it on ctx for the pause screen');
  ok(/this\.tutorial\.update\(dt\)/.test(hud), 'HUD pumps the Tutorial every frame');
  ok(/class="tutorial-line"/.test(hud), 'the HUD template carries the sink element');

  const menus = read('src/ui/Menus.js');
  ok(/data-act="tutorial"/.test(menus), 'the title screen offers the scenario (replayable from the menu)');
  ok(/data-act="tutorial-skip"/.test(menus), 'the pause screen offers the skip');
  ok(/ctx\.tutorial\?\.skip\(\)/.test(menus), 'the pause skip calls into the live scenario');
  ok(/shouldArmTutorial\(this\.settings, this\.tutorialNext\)/.test(menus), 'launch arms from the shared rule');
  ok(/firstRunSeen: 0,/.test(menus) && /out\.firstRunSeen = parsed\.firstRunSeen === 0 \? 0 : 1;/.test(menus),
    'firstRunSeen rides the existing settings store, and a missing key means already played');
  ok(/DEFAULTS, \{ firstRunSeen: this\.settings\.firstRunSeen \}/.test(menus),
    'restoring Defaults does not re-arm a tutorial at a player who has played');
  ok(/this\.tutorialNext = false;\s*this\.push\('select'\);/.test(menus),
    'Play clears an arming left behind by a How to play the player backed out of');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
