/**
 * Sticky nearest-target acquisition and its hysteresis.
 *
 *   node tests/targeting.test.mjs
 *
 * Exercises the acquisition rule directly rather than standing up an Enemy:
 * the rule is the fix, and isolating it is what lets both ends of the
 * hysteresis range be stated as assertions.
 */
import { Roster, acquireTarget, SWITCH_MARGIN } from '../src/systems/Roster.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const P = (x, z, extra = {}) => ({ isPlayer: true, alive: true, position: { x, y: 0, z }, ...extra });

function rosterOf(...players) {
  const r = new Roster();
  r.init({ player: players[0] ?? null });
  players.forEach((p) => r.add(p));
  return r;
}

console.log('acquisition with no current target');
{
  const a = P(10, 0), b = P(3, 0);
  const r = rosterOf(a, b);
  ok(acquireTarget(r, { x: 0, z: 0 }, null) === b, 'takes the nearest when it has none');
  ok(acquireTarget(r, { x: 0, z: 0 }, undefined) === b, 'undefined behaves as none');
}

console.log('stickiness — a marginally nearer player does NOT steal the target');
{
  const held = P(10, 0);
  const rival = P(9, 0);       // 10% nearer; margin is 20%
  const r = rosterOf(held, rival);
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === held, 'keeps the held target at 90% distance');
}

console.log('stickiness — a decisively nearer player DOES steal it');
{
  const held = P(10, 0);
  const rival = P(5, 0);       // 50% nearer; well inside the margin
  const r = rosterOf(held, rival);
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === rival, 'switches at 50% distance');
}

console.log('the margin boundary, from both sides');
{
  const held = P(10, 0);
  const r0 = rosterOf(held, P(10 * SWITCH_MARGIN + 0.01, 0));
  ok(acquireTarget(r0, { x: 0, z: 0 }, held) === held, 'just outside the margin: holds');
  const inner = P(10 * SWITCH_MARGIN - 0.01, 0);
  const r1 = rosterOf(held, inner);
  ok(acquireTarget(r1, { x: 0, z: 0 }, held) === inner, 'just inside the margin: switches');
}

console.log('two players standing together do not cause oscillation');
{
  // The failure this margin exists to prevent: with SWITCH_MARGIN at 1.0 the
  // enemy flips every evaluation. Alternate which is imperceptibly nearer and
  // assert the target never moves.
  const a = P(10.00, 0), b = P(10.01, 0);
  const r = rosterOf(a, b);
  let held = acquireTarget(r, { x: 0, z: 0 }, null);
  const firstPick = held;
  let switches = 0;
  for (let i = 0; i < 100; i++) {
    a.position.x = 10 + (i % 2 ? 0.01 : -0.01);
    b.position.x = 10 + (i % 2 ? -0.01 : 0.01);
    const next = acquireTarget(r, { x: 0, z: 0 }, held);
    if (next !== held) switches++;
    held = next;
  }
  ok(switches === 0, `no switches over 100 jittered evaluations (got ${switches})`);
  ok(held === firstPick, 'still on the original pick');
}

console.log('a dead or downed target is dropped immediately, margin or not');
{
  const held = P(1, 0);
  const other = P(40, 0);
  const r = rosterOf(held, other);
  held.alive = false;
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === other, 'dead target released for a far one');
  held.alive = true; held.downed = true;
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === other, 'downed target released too');
}

console.log('an empty roster yields null, not a stale target');
{
  const held = P(1, 0);
  const r = rosterOf(held);
  r.remove(held);
  ok(acquireTarget(r, { x: 0, z: 0 }, held) === null, 'target that left the roster is dropped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
