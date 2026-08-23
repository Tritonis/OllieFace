// tests/stage-transition.test.mjs
//
// The stage change, now that it is spread over frames instead of eaten in one
// (#182). Three claims, and the interesting one is the middle:
//
//  1. An incremental build produces the identical stage. `build()` and
//     `buildSteps()` are the same statements in the same order, so this is a
//     regression net rather than a discovery — but stage generation is
//     seed-deterministic by contract and that contract is now split across a
//     generator, which is exactly the kind of change that quietly breaks it.
//
//  2. **No half-built stage is ever observable.** This is the claim the whole
//     design rests on: everything is generated into locals and installed in one
//     block, so a query landing mid-build reads the *old* stage, complete. The
//     arm below asks the stage every question the camera, the enemies and the
//     interactables ask, after every single step, and demands the answers stay
//     exactly the old stage's until the commit step and exactly the new one's
//     after it. It is a guard that can fail: install the new terrain one step
//     early and the pre-commit equality breaks; delay it and the post-commit
//     equality does. Either way it reports a FAIL line rather than an uncaught
//     throw — the mid-build `fingerprint` calls are wrapped, so a partial
//     commit that leaves a null `grid` is caught and named as `brokeEarly`
//     instead of taking the process down.
//
//  3. Progression drives the thing to completion, gives the controls back, and
//     announces the stage once, after the world it names exists.
import * as THREE from 'three';
import { Stage } from '../src/world/Stage.js';
import { Progression } from '../src/systems/Progression.js';
import { RNG } from '../src/core/MathUtil.js';
import { Engine, runsDuringStageChange } from '../src/core/Engine.js';
import { Combat } from '../src/systems/Combat.js';
import { Director } from '../src/systems/Director.js';
import { Items } from '../src/systems/Items.js';
import { Revive } from '../src/systems/Revive.js';
import { Player } from '../src/entities/Player.js';
import { PlaceablePool } from '../src/entities/Placeables.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { Coop } from '../src/net/Coop.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const SEED = 1234;

function freshStage(index = 0) {
  const ctx = {
    scene: new THREE.Scene(), seed: SEED, settings: {},
    camera: new THREE.PerspectiveCamera(), input: null,
  };
  const stage = new Stage();
  stage.init(ctx);
  if (index) stage.build(index);
  return { ctx, stage };
}

/**
 * A stage's whole observable surface, flattened to something comparable. Not a
 * hash: a mismatch has to say *what* moved, or the arm is a bare boolean.
 */
function fingerprint(stage) {
  const rays = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const o = new THREE.Vector3(Math.cos(a) * 30, 40, Math.sin(a) * 30);
    const d = new THREE.Vector3(Math.cos(a) * 0.3, -1, Math.sin(a) * 0.3).normalize();
    rays.push(+stage.raycastDistance(o, d, 200).toFixed(6));
  }
  const heights = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    heights.push(+stage.sampleHeight(Math.cos(a) * 55, Math.sin(a) * 55).toFixed(6));
  }
  const spawn = stage.spawnPoint();
  return JSON.stringify({
    stageIndex: stage.stageIndex,
    stageName: stage.stageName,
    biome: stage.biome?.id ?? stage.biome?.name ?? null,
    minY: +stage.minY.toFixed(6),
    maxY: +stage.maxY.toFixed(6),
    heights,
    rays,
    spawn: [+spawn.x.toFixed(6), +spawn.y.toFixed(6), +spawn.z.toFixed(6)],
    props: stage.propTargets.length,
    platforms: stage.platforms.length,
    landmarks: stage.landmarks.map((l) => [l.kind, +l.x.toFixed(4), +l.z.toFixed(4), l.r]),
    center: +stage.center.y.toFixed(6),
  });
}

// --- 1. same seed, same stage, whichever way it is built -------------------
console.log('\n-- generation equivalence --');
for (const index of [1, 3, 5]) {
  const a = freshStage(index);
  const b = freshStage();
  // Drained by hand, one yield at a time, which is what the game does.
  let steps = 0;
  for (const _ of b.stage.buildSteps(index)) steps++;
  ok(steps === 6, `stage ${index}: the build reports its six steps (got ${steps})`);
  const fa = fingerprint(a.stage), fb = fingerprint(b.stage);
  ok(fa === fb, `stage ${index}: incremental build is the same stage as build()`);
  if (fa !== fb) console.log(`    sync: ${fa}\n    incr: ${fb}`);
}

// --- 2. nothing ever sees a half-built stage -------------------------------
console.log('\n-- no observable half-built stage --');
{
  const { stage } = freshStage(2);
  const before = fingerprint(stage);
  const after = fingerprint(freshStage(4).stage);
  ok(before !== after, 'the two stages are actually different (the arm can fail)');

  const seen = [];
  let committed = false, brokeEarly = null, brokeLate = null;
  for (const step of stage.buildSteps(4)) {
    seen.push(step);
    let f;
    try {
      f = fingerprint(stage);
    } catch (e) {
      brokeEarly = brokeEarly || `${step}: query threw — ${e.message}`;
      continue;
    }
    if (step === 'commit') committed = true;
    if (!committed) {
      if (f !== before && !brokeEarly) brokeEarly = `after step "${step}" the stage was no longer the old one`;
    } else if (f !== after && !brokeLate) {
      brokeLate = `after step "${step}" the stage was not yet the new one`;
    }
  }
  ok(brokeEarly === null, `every pre-commit query still reads the outgoing stage (${brokeEarly || 'clean'})`);
  ok(brokeLate === null, `every post-commit query reads the incoming stage (${brokeLate || 'clean'})`);
  ok(seen.indexOf('commit') > seen.indexOf('props'),
     `the swap happens after the new world is generated (${seen.join(' -> ')})`);
  ok(fingerprint(stage) === after, 'the finished stage is stage 4');
}

// --- 3. the driver ---------------------------------------------------------
console.log('\n-- Progression drives the transition --');

function harness({ stretch }) {
  const listeners = new Map();
  const events = {
    on(n, fn) { (listeners.get(n) ?? listeners.set(n, []).get(n)).push(fn); return () => {}; },
    emit(n, p) { for (const fn of listeners.get(n) ?? []) fn(p); },
  };
  const stage = new Stage();
  const input = { enabled: true };
  const ctx = {
    scene: new THREE.Scene(), seed: SEED, settings: {}, time: 0,
    camera: new THREE.PerspectiveCamera(), input, events, authority: true,
    rng: new RNG(SEED),
    player: { position: new THREE.Vector3(), velocity: new THREE.Vector3(), alive: true },
  };
  stage.init(ctx);
  const p = new Progression();
  p.stretchTransitions = stretch;
  p.init(ctx);
  // Populating a stage needs the item economy, the shop tables and half the
  // run; none of that is what this file is about. What it *is* about is when
  // populate runs relative to the swap, so the stub records the stage that was
  // standing underneath it.
  const populated = [];
  p.interactables.populate = (index) => {
    populated.push({ index, stageIndex: ctx.stage.stageIndex });
    return { position: new THREE.Vector3(1, 0, 2) };
  };
  p.interactables.clear = () => {};
  const starts = [];
  events.on('stageStart', (e) => starts.push({ index: e.index, stageIndex: ctx.stage.stageIndex }));
  const veil = [];
  events.on('stageVeil', (e) => veil.push(e.alpha));
  return { ctx, p, input, starts, populated, veil };
}

{
  const { ctx, p, input, starts, populated, veil } = harness({ stretch: true });
  p.advanceStage();
  ok(p.transition !== null, 'advanceStage opens a transition instead of building inline');
  ok(input.enabled === false, 'the controls are taken away for the length of it');
  ok(ctx.stage.stageIndex === 0, 'the world is still the old one while the veil closes');
  ok(starts.length === 0, 'nothing is announced yet');

  // A second press of the portal during the fade.
  const cleared = p.stats.stagesCleared;
  p.advanceStage();
  ok(p.stats.stagesCleared === cleared, 'a second portal press during the transition is ignored');

  let frames = 0;
  while (p.transition && frames < 600) { p.update(ctx, 1 / 60); frames++; }
  ok(p.transition === null, `the transition finishes on its own (${frames} frames)`);
  ok(frames > 30, `and it takes real time rather than snapping (${frames} frames)`);
  ok(ctx.stage.stageIndex === 1, 'the world is stage 1 at the end');
  ok(p.stageIndex === 1, 'and so is Progression');
  ok(input.enabled === true, 'the controls come back');
  ok(starts.length === 1, `stageStart is announced exactly once (${starts.length})`);
  ok(starts[0]?.stageIndex === 1, 'and only once the world it names is standing');
  ok(populated.length === 1 && populated[0].stageIndex === 1,
     'the stage is populated onto the new ground, not the old');

  // The veil is the masking half of the fix, and the swap has to happen behind
  // it: if the build began before full black the player would watch the old
  // biome retint and the sky change.
  ok(Math.max(...veil) === 1, 'the veil reaches full black');
  ok(veil[veil.length - 1] === 0, 'and lifts completely at the end');
  ok(veil.length > 20, `it is animated rather than snapped (${veil.length} changes)`);
}

{
  // Headless is the old behaviour, exactly: no renderer, no frames to protect,
  // and every probe and tool that calls advanceStage() still gets a stage back
  // before the call returns.
  const { ctx, p, input, starts } = harness({ stretch: false });
  p.advanceStage();
  ok(p.transition === null, 'without a renderer the stage change completes inside the call');
  ok(ctx.stage.stageIndex === 1, 'the world is stage 1 immediately');
  ok(starts.length === 1, 'and it was announced');
  ok(input.enabled === true, 'the controls were never left switched off');
}

{
  // The teleporter must not tick against the stage it is leaving.
  const { ctx, p } = harness({ stretch: true });
  let bosses = 0;
  ctx.director = { spawnBoss: () => { bosses++; }, reset: () => {} };
  p.interactables.teleporter = {
    state: 'charging', position: new THREE.Vector3(), chargeRadius: 10,
    setProgress: () => {},
  };
  p.advanceStage();
  for (let i = 0; i < 20; i++) p.fixedUpdate(ctx, 1 / 60);
  ok(bosses === 0, 'no boss is spawned around the outgoing stage teleporter');
  ok(p.state === 'idle', 'the charge machinery stays down through the transition');
}

// --- 4. nothing simulates while the player has no controls ----------------
//
// The regression this arm exists for: the old `Stage.build()` blocked the whole
// event loop, so a player who could not act also could not be acted upon.
// Spreading the build over real frames handed the enemies a free second against
// a survivor with the controls taken away — including a fatal one. The fix is
// the `ctx.stageChanging` gate in `Engine._runFrame`, and this is the arm that
// holds it open. Mutation-checked: delete the `runsDuringStageChange` skip in
// Engine.js and `no damage lands during the transition` goes red.
console.log('\n-- the simulation stops for the transition --');

/** A stand-in for every hostile thing on the fixed step. */
class Hostile {
  static critical = false;
  constructor(victim) { this.victim = victim; this.hits = 0; }
  fixedUpdate() { this.hits++; this.victim.health -= 10; }
}
/** A stand-in for the net layer, which is exempt and must keep going. */
class Wire {
  static critical = false;
  static runsDuringStageChange = true;
  constructor() { this.ticks = 0; }
  fixedUpdate() { this.ticks++; }
}

{
  const engine = new Engine({ canvas: null, seed: SEED });
  engine.running = true;
  // A real clock in a tight loop hands back deltas of nearly zero, and the
  // veil is a wall-clock animation — without this the transition never ages.
  engine.clock = { getDelta: () => 1 / 60 };
  const ctx = engine.ctx;
  const victim = { health: 1000 };
  const hostile = engine.add(new Hostile(victim));
  const wire = engine.add(new Wire());

  engine.accumulator = 0.05;
  engine._frame();
  ok(hostile.hits > 0, `the hostile ticks in an ordinary frame (${hostile.hits})`);
  const wireBefore = wire.ticks;
  const hitsBefore = hostile.hits;

  ctx.stageChanging = true;
  for (let i = 0; i < 10; i++) { engine.accumulator = 0.05; engine._frame(); }
  ok(hostile.hits === hitsBefore, `nothing hostile ticks while the world is changing (${hostile.hits - hitsBefore} extra)`);
  ok(victim.health === 1000 - hitsBefore * 10, 'and no damage was dealt');
  ok(wire.ticks > wireBefore, `but the net layer keeps its step (${wire.ticks - wireBefore} ticks)`);

  ctx.stageChanging = false;
  engine.accumulator = 0.05;
  engine._frame();
  ok(hostile.hits > hitsBefore, 'and it comes straight back afterwards');
}

{
  // The same claim end to end, driven by a real transition rather than by a
  // hand-set flag: the enemy is adjacent and swinging for the whole window.
  const engine = new Engine({ canvas: null, seed: SEED });
  engine.running = true;
  // A real clock in a tight loop hands back deltas of nearly zero, and the
  // veil is a wall-clock animation — without this the transition never ages.
  engine.clock = { getDelta: () => 1 / 60 };
  const ctx = engine.ctx;
  ctx.authority = true;

  const stage = new Stage();
  stage.init(ctx);
  const player = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), alive: true, health: 100 };
  ctx.player = player;
  const hostile = engine.add(new Hostile(player));

  const p = new Progression();
  p.stretchTransitions = true;
  engine.add(p);
  p.interactables.populate = () => ({ position: new THREE.Vector3() });
  p.interactables.clear = () => {};
  p.interactables.fixedUpdate = () => {};
  p.interactables.update = () => {};

  engine.accumulator = 0.05;
  engine._frame();
  ok(player.health < 100, 'the enemy is genuinely landing hits before the portal');

  const healthAtPortal = player.health;
  p.advanceStage();
  let frames = 0;
  while (p.transition && frames < 600) { engine.accumulator = 0.02; engine._frame(); frames++; }

  ok(frames > 30, `the transition ran for real frames (${frames})`);
  ok(ctx.stage.stageIndex === 1, 'and it finished the stage change');
  ok(player.health === healthAtPortal,
     `no damage lands during the transition (took ${healthAtPortal - player.health} over ${frames} frames)`);
  ok(player.alive === true, 'the player cannot be killed while it has no controls');
  ok(ctx.stageChanging === false, 'the freeze is released at the end');

  const after = player.health;
  engine.accumulator = 0.05;
  engine._frame();
  ok(player.health < after, 'and the world resumes once the veil lifts');
}

{
  // Which systems are exempt is a decision, not an accident. The Director in
  // particular must NOT be — `Progression._settle` reseats the player before it
  // resets, and the only thing that makes that window safe is the Director not
  // getting a step during it.
  const frozen = [
    ['Combat', Combat], ['Director', Director], ['Items', Items],
    ['Revive', Revive], ['Player', Player], ['PlaceablePool', PlaceablePool],
    ['Progression', Progression],
  ];
  // Bare prototypes: the flag is a static, and several of these constructors
  // want a live ctx that this arm has no business standing up.
  for (const [name, C] of frozen) {
    ok(runsDuringStageChange(Object.create(C.prototype)) === false, `${name} is frozen by a stage change`);
  }
  for (const [name, C] of [['NetHost', NetHost], ['NetClient', NetClient], ['Coop', Coop]]) {
    ok(runsDuringStageChange(Object.create(C.prototype)) === true, `${name} is exempt`);
  }
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
