// tests/combat-budget-metrics.test.mjs
//
// Issue #224's capture baseline needs to say how close a dense fight comes to
// the two combat ceilings `tests/voice-budget-headroom.test.mjs` never looks
// at: the per-step proc-dispatch circuit breaker (`PROC_BUDGET`, 512) and how
// many statuses are stacked on how many bodies at once. Both readers are
// write-only from the game's perspective — `procBudgetSnapshot()` and
// `statusOverlapStats()` never change what `_dispatch` allows or what a status
// does, which the "still gates identically" assertions below exist to prove.
import { Combat } from '../src/systems/Combat.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(combat) {
  return { combat, items: { onKill() {}, onHit() {}, onDamaged() {} } };
}

console.log('procBudgetSnapshot: peak usage and rejections, without changing the gate');
{
  const c = new Combat();
  const ctx = makeCtx(c);
  c.init(ctx);
  c.fixedUpdate(ctx, 1 / 60);
  ok(typeof c.procBudgetSnapshot === 'function', 'Combat exposes procBudgetSnapshot()');
  const before = c.procBudgetSnapshot();
  ok(before.budget === 512, 'reports the real circuit-breaker size');
  ok(before.peakUsed === 0, 'a fresh step has spent nothing yet');
  ok(before.rejections === 0, 'and rejected nothing yet');

  for (let i = 0; i < 10; i++) c._dispatch('onHit', {});
  const mid = c.procBudgetSnapshot();
  ok(mid.peakUsed === 10, `ten dispatches move the peak to 10 (${mid.peakUsed})`);

  // Exhaust the remainder of the step's budget, then ask for more than is left.
  for (let i = 0; i < 502; i++) c._dispatch('onHit', {});
  ok(c._procBudget === 0, 'the real breaker is now closed for this step');
  for (let i = 0; i < 5; i++) c._dispatch('onHit', {});
  const after = c.procBudgetSnapshot();
  ok(after.peakUsed === 512, `peak caps at the budget itself (${after.peakUsed})`);
  ok(after.rejections === 5, `every dispatch past the breaker is counted, not silently dropped (${after.rejections})`);

  // A fresh fixedUpdate step must still reset the real gate exactly as before —
  // the new counters ride alongside it, they do not touch it.
  c.fixedUpdate(ctx, 1 / 60);
  ok(c._procBudget === 512, 'fixedUpdate still refills the real per-step breaker');
  ok(c.procBudgetSnapshot().peakUsed === 512, 'peak is a run-lifetime high-water mark, not reset per step');
}

console.log('statusOverlapStats: reads live status stacks without mutating them');
{
  const c = new Combat();
  const a = { alive: true };
  const b = { alive: true };
  ok(typeof c.statusOverlapStats === 'function', 'Combat exposes statusOverlapStats()');
  ok(JSON.stringify(c.statusOverlapStats()) === JSON.stringify({ entities: 0, totalStacks: 0, maxStacksOnOne: 0, multiStatusEntities: 0 }),
    'an empty combat reports all zeros');

  c.statuses.set(a, [{ type: 'burn' }, { type: 'shock' }, { type: 'slow' }]);
  c.statuses.set(b, [{ type: 'freeze' }]);
  const stats = c.statusOverlapStats();
  ok(stats.entities === 2, `two entities are carrying statuses (${stats.entities})`);
  ok(stats.totalStacks === 4, `four stacks total across both (${stats.totalStacks})`);
  ok(stats.maxStacksOnOne === 3, `the busiest entity carries three (${stats.maxStacksOnOne})`);
  ok(stats.multiStatusEntities === 1, `exactly one entity has 2+ distinct status types (${stats.multiStatusEntities})`);
  ok(c.statuses.get(a).length === 3, 'reading the stats did not mutate the underlying map');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
