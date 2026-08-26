/**
 * Transition telemetry counters (issue #230): `Engine` tracks the worst
 * single-frame wall time and the simulation time the MAX_SUBSTEPS clamp
 * discards, both purely observational and both drained (never sampled) by
 * `drainFrameStats()` — see `Engine.js:826-847` for where each is measured
 * and `Telemetry.closeStage` for the one place they are read.
 *
 *   node tests/engine-frame-stats.test.mjs
 *
 * Three things are guarded:
 *
 *  1. A single overlong frame (`getDelta` forced to the 0.1s clamp) both
 *     records a peak and forces the MAX_SUBSTEPS clamp, which must show up as
 *     nonzero `droppedSimMs` — the red case a silent regression here would
 *     produce is *both* fields reading zero forever, so each is asserted
 *     nonzero independently rather than only "truthy".
 *  2. Draining resets both counters, so a quiet frame after a spike reports a
 *     clean window rather than carrying the old peak forward.
 *  3. Instrumentation cannot feed back into the sim: the accumulator,
 *     `ctx.time` and the fixed-step count a driven sequence produces are
 *     identical whether or not `drainFrameStats()` is ever called.
 */
import { Engine } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function fresh() {
  const engine = new Engine({ canvas: null, seed: 11 });
  engine.running = true;
  return engine;
}

console.log('a fresh engine reports a clean window');
{
  const engine = fresh();
  const fs = engine.drainFrameStats();
  ok(fs.peakFrameMs === 0 && fs.droppedSimMs === 0, 'nothing to report before a frame has run');
}

console.log('an overlong frame is both a peak and a discard');
{
  const engine = fresh();
  // getDelta forced past the 0.1s clamp so the clamp itself, not the fake
  // clock, is what caps dt — matching a real backgrounded-tab frame.
  engine.clock = { getDelta: () => 5 };
  engine.accumulator = 0;
  engine._frame();

  const fs = engine.drainFrameStats();
  // dt clamps to 0.1s = 100ms, which is what the frame's own peak must read.
  ok(fs.peakFrameMs === 100, `the clamped 100ms frame is the recorded peak (got ${fs.peakFrameMs})`);
  // 0.1s of accumulator drains 5 fixed steps (5/60 ~= 0.0833s) before
  // MAX_SUBSTEPS stops the loop; the ~0.0167s left over is what gets thrown
  // away, and it must not be zero.
  ok(fs.droppedSimMs > 0, `discarded sim time is nonzero (got ${fs.droppedSimMs})`);
  ok(Math.abs(fs.droppedSimMs - 16.67) < 1, `discarded sim time matches the leftover accumulator (got ${fs.droppedSimMs})`);
}

console.log('an ordinary frame never trips the clamp');
{
  const engine = fresh();
  engine.clock = { getDelta: () => 1 / 60 };
  engine.accumulator = 0;
  engine._frame();
  const fs = engine.drainFrameStats();
  ok(fs.droppedSimMs === 0, `a single fixed-rate frame drops nothing (got ${fs.droppedSimMs})`);
  ok(fs.peakFrameMs > 0 && fs.peakFrameMs < 100, `the peak reflects the real frame time (got ${fs.peakFrameMs})`);
}

console.log('draining resets the window, so a spike does not haunt the next one');
{
  const engine = fresh();
  engine.clock = { getDelta: () => 5 };
  engine.accumulator = 0;
  engine._frame();
  const first = engine.drainFrameStats();
  ok(first.peakFrameMs === 100 && first.droppedSimMs > 0, 'the spike was recorded');

  engine.clock = { getDelta: () => 1 / 60 };
  engine.accumulator = 0;
  engine._frame();
  const second = engine.drainFrameStats();
  ok(second.peakFrameMs < 100 && second.droppedSimMs === 0, `the next window starts clean (got ${JSON.stringify(second)})`);
}

console.log('behaviour is unchanged whether or not the counters are ever drained');
{
  // Two engines driven through byte-identical sequences of forced deltas,
  // including several that trip MAX_SUBSTEPS. One drains the new counters
  // after every frame — the way `Telemetry.closeStage` does — the other
  // never touches them at all. If instrumentation reached back into the sim,
  // this is where it would show up: as a difference in `ctx.time`, in
  // `accumulator`, or in what a fixedUpdate system counted.
  const deltas = [1 / 60, 1 / 60, 5, 1 / 60, 0.09, 1 / 60, 5, 5, 1 / 60];

  class Counter {
    fixedUpdate() { this.ticks = (this.ticks || 0) + 1; }
  }

  function run(drain) {
    const engine = fresh();
    const counter = engine.add(new Counter());
    let i = 0;
    engine.clock = { getDelta: () => deltas[i++ % deltas.length] };
    for (let f = 0; f < deltas.length; f++) {
      engine.accumulator = engine.accumulator; // no-op, mirrors real driving
      engine._frame();
      if (drain) engine.drainFrameStats();
    }
    return { time: engine.ctx.time, accumulator: engine.accumulator, ticks: counter.ticks || 0, frame: engine.frame };
  }

  const withDrain = run(true);
  const withoutDrain = run(false);
  ok(withDrain.time === withoutDrain.time, `ctx.time matches (${withDrain.time} vs ${withoutDrain.time})`);
  ok(Math.abs(withDrain.accumulator - withoutDrain.accumulator) < 1e-9,
    `accumulator matches (${withDrain.accumulator} vs ${withoutDrain.accumulator})`);
  ok(withDrain.ticks === withoutDrain.ticks, `fixed-step count matches (${withDrain.ticks} vs ${withoutDrain.ticks})`);
  ok(withDrain.frame === withoutDrain.frame, 'frame count matches');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
