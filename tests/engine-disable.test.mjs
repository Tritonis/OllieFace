/**
 * A noncritical system that is wedged stops being called, and the player is told.
 *
 *   node tests/engine-disable.test.mjs
 *
 * The Engine's answer to a noncritical throw used to be "name it once, then go
 * quiet". That fixed the console and nothing else: a system throwing in `update`
 * went on being called sixty times a second for the rest of the run, doing
 * nothing but building and unwinding a stack. Issue #72 is the other half —
 * after `DISABLE_AFTER` failed calls IN A ROW the system is dropped from the
 * update list, and a strip on screen names it.
 *
 * Three claims, and the middle one is what keeps the first honest:
 *
 *   1. a system that throws every frame is DROPPED — asserted on whether its
 *      `update` is still being CALLED, not on a flag having flipped. A disable
 *      that sets a boolean and keeps calling the system has fixed nothing;
 *   2. a system that throws INTERMITTENTLY is never dropped. The rule is
 *      consecutive failures, so a successful call clears the streak, and a
 *      system that throws once per stage transition is explicitly not the
 *      target. Make the counter non-resetting and this block goes red;
 *   3. the player hears about it. A silently disabled `Audio` is a game that
 *      has quietly gone mute with no explanation, which is not an improvement
 *      on one that was throwing. The Engine owns no DOM, so it emits
 *      `systemDisabled` and `ui/SystemNotice.js` is what draws.
 *
 * There is no jsdom in this repo, so `document` is the same hand-built stub
 * `tests/save-failure-ui.test.mjs` uses.
 */
import { Engine, DISABLE_AFTER } from '../src/core/Engine.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** An engine with the loop flag set but no rAF — frames are driven by hand. */
function fresh() {
  const engine = new Engine({ canvas: null, seed: 1 });
  engine.running = true;
  return engine;
}

/** Run `fn` with the console's error channel captured. */
function quietly(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { fn(); } finally { console.error = real; }
  return lines;
}

class Wedged {
  static critical = false;
  constructor() { this.calls = 0; }
  update() { this.calls++; throw new Error('wedged every frame'); }
}

/** Throws on the first call of every `period`-th frame, and works otherwise. */
class Intermittent {
  static critical = false;
  constructor(period) { this.period = period; this.calls = 0; }
  update() {
    this.calls++;
    if (this.calls % this.period === 1) throw new Error('boom on a stage transition');
  }
}

class Witness {
  static critical = false;
  constructor() { this.updates = 0; }
  update() { this.updates++; }
}

console.log('a system wedged every frame is dropped from the update list');
{
  const engine = fresh();
  const bad = engine.add(new Wedged());
  const w = engine.add(new Witness());

  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  ok(bad.calls === DISABLE_AFTER, `it was called on every frame up to the limit (${bad.calls})`);
  ok(!engine.systems.includes(bad), 'and is no longer registered');

  const at = bad.calls;
  quietly(() => { for (let i = 0; i < 20; i++) engine._frame(); });
  // The claim that matters, and the one a flag cannot satisfy: the method is
  // not being entered any more.
  ok(bad.calls === at, `its update is never called again (${bad.calls} calls after 20 more frames)`);
  ok(w.updates === DISABLE_AFTER + 20, 'while a healthy system beside it kept running every frame');
  ok(engine.fatal === null && engine.ctx.authority === true, 'nothing was halted or surrendered');
}

console.log('it takes more than one frame of trouble, however many substeps that frame ran');
{
  // A `fixedUpdate` can be called MAX_SUBSTEPS (5) times in a single frame, so a
  // threshold at or below five would disable a system over one bad frame. This
  // is why DISABLE_AFTER is six.
  class WedgedFixed {
    static critical = false;
    constructor() { this.calls = 0; }
    fixedUpdate() { this.calls++; throw new Error('wedged in the fixed step'); }
  }
  const engine = fresh();
  const bad = engine.add(new WedgedFixed());
  engine.accumulator = 1;              // enough debt to saturate the substep loop
  quietly(() => engine._frame());
  ok(bad.calls === 5, 'one saturated frame called it five times');
  ok(engine.systems.includes(bad), 'and did not disable it');

  // The trap that a per-SYSTEM counter fell into: one frame calls fixedUpdate
  // up to five times and *then* update and lateUpdate on the same system, so a
  // system with two throwing phases reached six inside a single frame. Counting
  // per phase is what makes "more than one frame" true of every system shape
  // rather than only of the single-phase ones.
  class WedgedBoth {
    static critical = false;
    constructor() { this.fixed = 0; this.updates = 0; }
    fixedUpdate() { this.fixed++; throw new Error('wedged in the fixed step'); }
    update() { this.updates++; throw new Error('wedged in update'); }
  }
  const two = fresh();
  const both = two.add(new WedgedBoth());
  two.accumulator = 1;
  quietly(() => two._frame());
  ok(both.fixed + both.updates === 6, 'a two-phase system took six failed calls in that one frame');
  ok(two.systems.includes(both), 'and is still registered, because no single phase failed six times');
}

console.log('a phase that is wedged is not rescued by a phase that works');
{
  // The other half of per-phase counting, and a defect in its own right: with
  // one counter per system, a system whose `fixedUpdate` threw on every substep
  // of every frame was resurrected by its own `update` returning normally
  // moments later, and so ran wedged forever.
  class HalfWedged {
    static critical = false;
    constructor() { this.fixed = 0; this.updates = 0; }
    fixedUpdate() { this.fixed++; throw new Error('wedged in the fixed step'); }
    update() { this.updates++; }
  }
  const engine = fresh();
  const s = engine.add(new HalfWedged());
  quietly(() => {
    for (let i = 0; i < 10 && engine.systems.includes(s); i++) {
      engine.accumulator = 0.02;       // one substep per frame
      engine._frame();
    }
  });
  ok(!engine.systems.includes(s), 'the wedged fixed step disabled it despite a healthy update');
  ok(s.fixed === DISABLE_AFTER, `it took exactly ${DISABLE_AFTER} failed fixed steps (${s.fixed})`);
}

console.log('a system that throws intermittently is never disabled');
{
  const engine = fresh();
  // Throws on frame 1, 5, 9, ... — far more failures than the threshold, but
  // never DISABLE_AFTER of them in a row.
  const flaky = engine.add(new Intermittent(4));
  quietly(() => { for (let i = 0; i < 200; i++) engine._frame(); });

  const failures = Math.ceil(200 / 4);
  ok(engine.ctx.frameErrors === failures, `it failed ${engine.ctx.frameErrors} times, well past the threshold of ${DISABLE_AFTER}`);
  ok(engine.systems.includes(flaky), 'and is still registered, because they were never consecutive');
  ok(flaky.calls === 200, 'it was called on all 200 frames');
  ok(engine.fatal === null, 'nothing was halted');
}

console.log('a streak that is broken starts again from zero');
{
  const engine = fresh();
  class Recovering {
    static critical = false;
    constructor() { this.calls = 0; this.throws = true; }
    update() { this.calls++; if (this.throws) throw new Error('boom'); }
  }
  const s = engine.add(new Recovering());
  quietly(() => { for (let i = 0; i < DISABLE_AFTER - 1; i++) engine._frame(); });
  ok(engine.systems.includes(s), 'one short of the limit, still registered');
  s.throws = false;
  engine._frame();
  s.throws = true;
  quietly(() => { for (let i = 0; i < DISABLE_AFTER - 1; i++) engine._frame(); });
  ok(engine.systems.includes(s), 'one good frame reset the count, so the next run of failures is short too');
  quietly(() => engine._frame());
  ok(!engine.systems.includes(s), 'and the frame that completes the new run of six does disable it');
}

console.log('a disabled system stops speaking for itself through the context');
{
  const engine = fresh();
  class Publisher {
    static critical = false;
    init(ctx) { ctx.audio = this; }
    update() { throw new Error('wedged'); }
  }
  const p = engine.add(new Publisher());
  ok(engine.ctx.audio === p, 'init published it');
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  ok(engine.ctx.audio === null, 'and disabling it took it back off the context, as a failed init would');
}

console.log('Input is not disabled — it was never in the update list');
{
  // `Input.pollPad` runs through `_call` without ever being `add`ed. Removing it
  // would blank `ctx.input`, which the renderer calls `endFrame()` on unguarded,
  // so a starved pad poll would take the renderer down with it.
  const engine = fresh();
  const input = { critical: false, calls: 0, pollPad() { this.calls++; throw new Error('no pad'); } };
  engine.ctx.input = input;
  quietly(() => { for (let i = 0; i < DISABLE_AFTER + 5; i++) engine._frame(); });
  ok(engine.ctx.input === input, 'the context still holds it');
  ok(input.calls === DISABLE_AFTER + 5, 'and it is still being polled every frame');
}

console.log('the failure is announced once, by name, with a count');
{
  const engine = fresh();
  const seen = [];
  engine.ctx.events.on('systemDisabled', (e) => seen.push(e));
  engine.add(new Wedged());
  const lines = quietly(() => { for (let i = 0; i < DISABLE_AFTER + 10; i++) engine._frame(); });

  ok(seen.length === 1, 'systemDisabled was emitted exactly once, not once per later frame');
  ok(seen[0]?.name === 'Wedged', 'the payload names the system');
  ok(seen[0]?.who === 'Wedged.update', 'and the phase it died in');
  ok(seen[0]?.failures === DISABLE_AFTER, 'and how many calls in a row failed');
  ok(/wedged every frame/.test(seen[0]?.message ?? ''), 'and carries the exception message');
  ok(lines.some((l) => /disabling it/.test(l)), 'the console says so too');
}

/* ---------------------------------------------------------------------------
 * The player-facing half. Stubbed document, exactly as save-failure-ui does.
 * ------------------------------------------------------------------------ */
function stubNode(tagName) {
  const node = {
    tagName, className: '', textContent: '', children: [], parent: null,
    appendChild(child) { child.parent = node; node.children.push(child); return child; },
    remove() {
      const p = node.parent;
      if (p) { p.children = p.children.filter((c) => c !== node); node.parent = null; }
    },
  };
  return node;
}
globalThis.document = {
  head: stubNode('head'),
  body: stubNode('body'),
  createElement: (tag) => stubNode(tag),
};

const { installSystemNotice, systemNoticeElement, clearSystemNotices } =
  await import('../src/ui/SystemNotice.js');

const text = (node) => [node.textContent, ...node.children.map(text)].join(' ');

console.log('the player is told, through the bus and never through the DOM');
{
  const engine = fresh();
  installSystemNotice(engine.ctx);
  ok(systemNoticeElement() === null, 'nothing on screen before anything fails');

  class Audio {
    static critical = false;
    update() { throw new Error('AudioContext is closed'); }
  }
  engine.add(new Audio());
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });

  const el = systemNoticeElement();
  ok(el !== null, 'a strip appeared when the system was disabled');
  const body = text(el);
  ok(body.includes('Audio'), 'it names the system that is gone');
  ok(/AudioContext is closed/.test(body), 'and carries the reason');
  ok(/run continues/i.test(body), 'and says the run carries on, so the player knows this is not a crash');

  class VFX {
    static critical = false;
    update() { throw new Error('shader would not compile'); }
  }
  engine.add(new VFX());
  quietly(() => { for (let i = 0; i < DISABLE_AFTER; i++) engine._frame(); });
  const strips = document.body.children.filter((c) => c.className === 'system-notice');
  ok(strips.length === 1, 'a second disabled system adds a line rather than a second strip');
  ok(text(systemNoticeElement()).includes('VFX'), 'and that line names it');

  clearSystemNotices();
  ok(systemNoticeElement() === null, 'and the strip can be taken down again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
