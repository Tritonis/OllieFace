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
//     equality does.
//
//  3. Progression drives the thing to completion, gives the controls back, and
//     announces the stage once, after the world it names exists.
import * as THREE from 'three';
import { Stage } from '../src/world/Stage.js';
import { Progression } from '../src/systems/Progression.js';
import { RNG } from '../src/core/MathUtil.js';

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

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
