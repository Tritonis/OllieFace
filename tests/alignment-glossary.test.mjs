/**
 * The alignment economy's glossary (issue #180) — `GLOSSARY` in
 * `systems/Tutorial.js`, the event-driven half of the first-run scenario.
 *
 * Same defect this file is written against as `first-run-scenario.test.mjs`:
 * every claim is against the one string the HUD sink actually shows, and
 * every riskiest guard carries a control (the wrong pawn, the wrong event
 * shape, a curriculum beat still on screen) that must NOT trigger it.
 *
 * The number-provenance claim gets its own proof, not an assertion of faith:
 * each quoted table is mutated in place and the rendered line is checked
 * against the MUTATED value, off the same import Tutorial.js uses. A line
 * that had the number typed in rather than read from the table would still
 * show the OLD number and fail these — that failure mode is exercised
 * directly, not just described.
 */
import { Tutorial, BEATS, SKILL_SLOTS, MOVE_DISTANCE, GLOSSARY, GLOSSARY_HOLD } from '../src/systems/Tutorial.js';
import { BOON, MOTE, RELIQUARY } from '../src/data/bandBoons.js';
import { TOLERANCE, CAPSTONE } from '../src/data/alignment.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/* -- stubs, copied from first-run-scenario.test.mjs's rig ---------------- */

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

function rig() {
  const events = bus();
  const player = { position: { x: 0, y: 0, z: 0 } };
  const ctx = { events, player, settings: {}, input: { padActive: false }, tutorialArmed: true };
  const line = lineEl();
  const tut = new Tutorial(ctx, { line }, events);
  return { ctx, events, tut, line, player };
}

function walk(r, d, step = 1) {
  for (let i = 0; i < Math.ceil(d / step); i++) {
    r.player.position.x += step;
    r.tut.update(1 / 60);
  }
}

/**
 * A rig whose numbered curriculum (`BEATS`) has already finished through the
 * real event sequence — not by poking `active` — leaving `glossaryOn` true
 * and the line free. Mirrors `atLoot()` + a finishing bargain in
 * `first-run-scenario.test.mjs`.
 */
function armed() {
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  r.events.emit('itemPickup', { owner: r.ctx.player });
  r.events.emit('teleporterComplete', {});
  r.events.emit('voidBargain', { kind: 'reroll', owner: r.ctx.player });
  ok(r.line.textContent === '' && !r.tut.active,
    'CONTROL: the curriculum is finished and the line is clear before any glossary test begins');
  ok(r.tut.glossaryOn === true, 'CONTROL: the glossary stays armed once the numbered curriculum ends');
  return r;
}

/* -- the table of entries matches the concepts issue #180 names ---------- */

ok(GLOSSARY.map((g) => g.id).sort().join(',')
  === 'commitment,consecration,grace,marks,motes,route,sanctuary,warding'.split(',').sort().join(','),
  `glossary covers marks, warding, motes, sanctuary, consecration, grace, commitment and route (got ${GLOSSARY.map((g) => g.id).join(',')})`);

/* -- marks: minted, not spent; and the number comes off BOON.markPer ----- */

{
  const r = armed();
  r.events.emit('voidMarksChanged', { marks: 1, spent: 2 });
  ok(r.line.textContent === '', 'CONTROL: spending marks is not the same event as minting one');
  r.events.emit('voidMarksChanged', { marks: 1, spent: 0 });
  ok(new RegExp(String(BOON.markPer)).test(r.line.textContent) && r.line.lit,
    `a mint shows the mark beat quoting BOON.markPer=${BOON.markPer} (got "${r.line.textContent}")`);
  r.events.emit('voidMarksChanged', { marks: 2, spent: 0 });
  ok(r.line.textContent !== '', 'a second mint does not re-fire (already seen) but leaves the first line up');
}

{
  const r = armed();
  const was = BOON.markPer;
  BOON.markPer = 777;
  r.events.emit('voidMarksChanged', { marks: 1, spent: 0 });
  ok(new RegExp('777').test(r.line.textContent),
    `RED-PROOF: the mark line quotes whatever BOON.markPer holds at fire time, not a frozen copy (got "${r.line.textContent}")`);
  BOON.markPer = was;
}

/* -- warding: owner-filtered, first ward only ----------------------------- */

{
  const r = armed();
  const teammate = { position: { x: 0, y: 0, z: 0 } };
  r.events.emit('corruptionWarded', { player: teammate, amount: 5, warded: 5, progress: 0.1, motes: 0, minted: false });
  ok(r.line.textContent === '', 'CONTROL: a teammate\'s ward does not teach this seat anything');
  r.events.emit('corruptionWarded', { player: r.ctx.player, amount: 5, warded: 5, progress: 0.1, motes: 0, minted: false });
  ok(new RegExp(String(MOTE.per)).test(r.line.textContent),
    `the local pawn's ward shows the warding beat quoting MOTE.per=${MOTE.per} (got "${r.line.textContent}")`);
}

{
  const r = armed();
  const was = MOTE.per;
  MOTE.per = 12345;
  r.events.emit('corruptionWarded', { player: r.ctx.player, amount: 1, warded: 1, progress: 0.01, motes: 0, minted: false });
  ok(new RegExp('12345').test(r.line.textContent),
    `RED-PROOF: the warding line tracks a live MOTE.per (got "${r.line.textContent}")`);
  MOTE.per = was;
}

/* -- motes: minted, not spent --------------------------------------------- */

{
  const r = armed();
  r.events.emit('argentMotesChanged', { motes: 0, spent: 1 });
  ok(r.line.textContent === '', 'CONTROL: spending a mote is not the same event as minting one');
  r.events.emit('argentMotesChanged', { motes: 1, spent: 0 });
  ok(/argent mote/i.test(r.line.textContent), `a mint shows the motes beat (got "${r.line.textContent}")`);
}

/* -- sanctuary: owner-filtered, quotes MOTE.sanctuarySeconds -------------- */

{
  const r = armed();
  const teammate = { position: { x: 0, y: 0, z: 0 } };
  r.events.emit('voidBargain', { kind: 'sanctuary', motes: 1, marks: 0, owner: teammate });
  ok(r.line.textContent === '', 'CONTROL: a teammate buying Sanctuary does not teach this seat');
  r.events.emit('voidBargain', { kind: 'sanctuary', motes: 1, marks: 0, owner: r.ctx.player });
  ok(new RegExp(String(MOTE.sanctuarySeconds)).test(r.line.textContent),
    `Sanctuary quotes MOTE.sanctuarySeconds=${MOTE.sanctuarySeconds} (got "${r.line.textContent}")`);
}

{
  const r = armed();
  const was = MOTE.sanctuarySeconds;
  MOTE.sanctuarySeconds = 999;
  r.events.emit('voidBargain', { kind: 'sanctuary', motes: 1, marks: 0, owner: r.ctx.player });
  ok(new RegExp('999').test(r.line.textContent),
    `RED-PROOF: Sanctuary's line tracks a live MOTE.sanctuarySeconds (got "${r.line.textContent}")`);
  MOTE.sanctuarySeconds = was;
}

/* -- consecration: owner-filtered, quotes RELIQUARY.motes ----------------- */

{
  const r = armed();
  r.events.emit('voidBargain', { kind: 'consecrate', id: 'x', marks: 0, motes: 3, owner: r.ctx.player });
  ok(new RegExp(String(RELIQUARY.motes)).test(r.line.textContent),
    `Consecration quotes RELIQUARY.motes=${RELIQUARY.motes} (got "${r.line.textContent}")`);
}

{
  const r = armed();
  const was = RELIQUARY.motes;
  RELIQUARY.motes = 42;
  r.events.emit('voidBargain', { kind: 'consecrate', id: 'x', marks: 0, motes: 3, owner: r.ctx.player });
  ok(new RegExp('42').test(r.line.textContent),
    `RED-PROOF: Consecration's line tracks a live RELIQUARY.motes (got "${r.line.textContent}")`);
  RELIQUARY.motes = was;
}

/* -- grace: world-level (not owner-filtered), quotes RELIQUARY.fadeAt ----- */

{
  const r = armed();
  r.events.emit('corruptionBand', { band: 0, prev: 0 });
  ok(r.line.textContent === '', 'CONTROL: a non-crossing band event (still Pristine) teaches nothing');
  r.events.emit('corruptionBand', { band: 1, prev: 0 });
  ok(new RegExp(String(RELIQUARY.fadeAt)).test(r.line.textContent),
    `leaving Pristine shows the grace beat quoting RELIQUARY.fadeAt=${RELIQUARY.fadeAt} (got "${r.line.textContent}")`);
}

/* -- commitment: any alignmentCommitted, quotes TOLERANCE.corrupt -------- */

{
  const r = armed();
  r.events.emit('alignmentCommitted', {
    source: 'corruptChest', class: 'corrupt', amount: 3, corrupt: 3, pure: 0, mixed: 0, alignment: 'neutral',
  });
  ok(new RegExp(String(TOLERANCE.corrupt)).test(r.line.textContent),
    `a first commit quotes TOLERANCE.corrupt=${TOLERANCE.corrupt} (got "${r.line.textContent}")`);
}

/* -- route: only once the ledger actually leaves neutral ----------------- */

{
  const r = armed();
  r.events.emit('alignmentCommitted', {
    source: 'corruptChest', class: 'corrupt', amount: 3, corrupt: 3, pure: 0, mixed: 0, alignment: 'neutral',
  });
  const afterCommitment = r.line.textContent;
  ok(!/side now/.test(afterCommitment), 'CONTROL: a still-neutral ledger does not claim the run has a side');
  r.tut.glossaryT = 0;
  r.tut.update(1 / 60);
  r.events.emit('alignmentCommitted', {
    source: 'bargainSynergy', class: 'corrupt', amount: 4, corrupt: 7, pure: 0, mixed: 0, alignment: 'corrupt',
  });
  ok(new RegExp(String(CAPSTONE.corrupt)).test(r.line.textContent) && /corrupt/.test(r.line.textContent),
    `a corrupt-leaning ledger names CAPSTONE.corrupt=${CAPSTONE.corrupt} (got "${r.line.textContent}")`);
}

{
  const r = armed();
  const was = CAPSTONE.corrupt;
  CAPSTONE.corrupt = 55;
  // A first-ever commit that is also non-neutral queues BOTH `commitment` and
  // `route` off the one event; `commitment` (earlier in the table) shows
  // first, so its dwell has to be spent before `route` is the visible line.
  r.events.emit('alignmentCommitted', {
    source: 'bargainSynergy', class: 'corrupt', amount: 4, corrupt: 4, pure: 0, mixed: 0, alignment: 'corrupt',
  });
  r.tut.glossaryT = 0;
  r.tut.update(1 / 60);
  ok(new RegExp('55').test(r.line.textContent),
    `RED-PROOF: the route line tracks a live CAPSTONE.corrupt (got "${r.line.textContent}")`);
  CAPSTONE.corrupt = was;
}

/* -- timing: never steals the line an active curriculum beat owns -------- */

{
  const r = rig();
  r.events.emit('stageStart', { index: 0 });
  ok(/Move with/.test(r.line.textContent), 'the curriculum opens on the movement beat as before');
  r.events.emit('voidMarksChanged', { marks: 1, spent: 0 });
  ok(/Move with/.test(r.line.textContent),
    'CONTROL: a glossary event firing mid-curriculum does not overwrite the active beat');
  walk(r, MOVE_DISTANCE + 1);
  for (const slot of SKILL_SLOTS) r.events.emit('abilityUsed', { slot, player: r.ctx.player });
  r.events.emit('itemPickup', { owner: r.ctx.player });
  r.events.emit('teleporterComplete', {});
  r.events.emit('voidBargain', { kind: 'reroll', owner: r.ctx.player });
  ok(new RegExp(String(BOON.markPer)).test(r.line.textContent),
    `the queued mark beat surfaces the instant the curriculum finishes (got "${r.line.textContent}")`);
}

/* -- timing: deferred while the local pawn is in a choice window --------- */

{
  const r = armed();
  r.ctx.items = { hasChoiceWindow: () => true };
  r.events.emit('argentMotesChanged', { motes: 1, spent: 0 });
  ok(r.line.textContent === '', 'CONTROL: a choice window open on the local pawn defers the glossary line');
  r.ctx.items.hasChoiceWindow = () => false;
  r.tut.update(1 / 60);
  ok(/argent mote/i.test(r.line.textContent), 'the deferred line surfaces once the window closes');
}

/* -- the line holds for GLOSSARY_HOLD and then yields to the queue -------- */

{
  const r = armed();
  r.events.emit('argentMotesChanged', { motes: 1, spent: 0 });
  r.events.emit('corruptionBand', { band: 1, prev: 0 });
  const first = r.line.textContent;
  ok(/argent mote/i.test(first), 'the first-fired entry shows; the second queues behind it');
  r.tut.update(GLOSSARY_HOLD - 0.1);
  ok(r.line.textContent === first, 'the line holds for the full dwell');
  r.tut.update(0.2);
  ok(new RegExp(String(RELIQUARY.fadeAt)).test(r.line.textContent),
    `the queued grace entry surfaces once the dwell expires (got "${r.line.textContent}")`);
}

/* -- skip and runEnd take the glossary down with the curriculum ---------- */

{
  const r = armed();
  r.tut.skip();
  ok(r.tut.glossaryOn === false, 'skip disarms the glossary, not just the curriculum');
  r.events.emit('voidMarksChanged', { marks: 1, spent: 0 });
  ok(r.line.textContent === '', 'a skip stays skipped for glossary events too');
}

{
  const r = armed();
  r.events.emit('runEnd', { won: false });
  ok(r.tut.glossaryOn === false, 'a run ending disarms the glossary');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
