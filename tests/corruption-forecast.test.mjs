/**
 * The corruption gauge says what it is moving *towards*.
 *
 *   node tests/corruption-forecast.test.mjs
 *
 * The gauge shipped as a beautiful ammeter with no scale legend: it moved, and
 * a player had to have already crossed a line to know where the lines were
 * (issue #31). The forecast line is the legend — next band, how far, and what
 * crossing it does — and every word of it is derived from `data/corruption.js`
 * rather than authored twice, so a re-tune moves the sentence with the number.
 *
 * The second half of the file pins the *hold*: on the first feed of a run the
 * sentence latches for a few seconds so it can be read while the fill, the pen
 * and the band label carry on live underneath. Nothing pauses; a band crossing
 * ends the hold early, because a frozen sentence about a line already crossed
 * is simply false.
 *
 * The HUD half drives the method through the prototype on a hand-built `this`,
 * the idiom from tests/ui-instruments.test.mjs.
 */
import { nextThresholdLine, CORRUPTION_PRIMER_S } from '../src/ui/HUD.js';
import { BANDS, MUTATION, PRESSURE } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const H = 1 / 60;

console.log('the line names the next band, the distance to it, and what it costs');
{
  ok(nextThresholdLine(0, 0) === `Next: Seeded in 20 - enemy scale +${(PRESSURE.perWorld * 20).toFixed(2)}`,
     `a pristine world reads "${nextThresholdLine(0, 0)}"`);
  ok(nextThresholdLine(14, 0) === nextThresholdLine(0, 0).replace('in 20', 'in 6'),
     'the distance counts down as the world rots');
  ok(nextThresholdLine(19.2, 0).includes('in 1'),
     'a fractional remainder rounds up, so the line never promises a threshold it has not reached');
  ok(nextThresholdLine(30, 1) === 'Next: Blighted in 25 - one held item blights',
     `Seeded looks up at the band where the world starts taking ("${nextThresholdLine(30, 1)}")`);
  ok(nextThresholdLine(120, 3) === 'Next: Consumed in 70 - one held item blights',
     `Overrun looks up at Consumed ("${nextThresholdLine(120, 3)}")`);
}

console.log('the consequence is read off MUTATION.minBand, not written out beside it');
{
  const blights = BANDS.map((_, i) => nextThresholdLine(0, i)).map((s) => s.includes('blights'));
  // The line for band i describes crossing into band i+1, so the first `true`
  // sits one index below the band mutation begins at.
  const first = blights.indexOf(true);
  ok(first + 1 === MUTATION.minBand,
     `the blight warning first appears on the approach to band ${MUTATION.minBand} (found ${first + 1})`);
  ok(blights.slice(first, BANDS.length - 1).every(Boolean),
     'and it stays for every crossing above it — mutation fires on each upward crossing, not once');
}

console.log('the top band has no next threshold and says so rather than inventing one');
{
  const top = nextThresholdLine(400, BANDS.length - 1);
  ok(!top.includes('Next:'), `Consumed promises no next band ("${top}")`);
  ok(top.startsWith(BANDS[BANDS.length - 1].name), 'it names the band the party is actually in');
  ok(!/NaN|undefined|Infinity/.test(top), 'and no arithmetic leaks through it');
}

console.log('it survives a re-tune, and a band that ran ahead of the world');
{
  const bands = [{ id: 0, name: 'Clean', at: 0 }, { id: 1, name: 'Filthy', at: 40 }];
  ok(nextThresholdLine(0, 0, bands) === `Next: Filthy in 40 - enemy scale +${(PRESSURE.perWorld * 40).toFixed(2)}`,
     'the function reads whatever BANDS it is handed');
  ok(nextThresholdLine(999, 1, bands).startsWith('Filthy'), 'the last band of a two-band table is still the last band');
  ok(nextThresholdLine(9999, 0).includes('in 1'),
     'a world that has outrun its own band label still counts at least one point, never a negative one');
  ok(nextThresholdLine(NaN, 0) === nextThresholdLine(0, 0), 'a non-finite world reads as pristine, the corruption.js idiom');
  // The band argument used to be defended with `?? 0`, which lets NaN straight
  // through to index off the end of the table. `Corruption.band` can never be
  // NaN, so nothing shipped was ever going to hit it — but this is exported as
  // a pure function, and a pure function that crashes on one of its two
  // arguments while degrading on the other has an inconsistent contract.
  ok(nextThresholdLine(0, NaN) === nextThresholdLine(0, 0), 'a non-finite band degrades the same way, rather than throwing');
  ok(nextThresholdLine(0, undefined) === nextThresholdLine(0, 0), 'and the missing-band case it always handled still holds');
}

console.log("every band's line is plain ASCII - this project renders no glyphs");
{
  const all = BANDS.map((_, i) => nextThresholdLine(0, i));
  ok(all.every((s) => /^[\x20-\x7e]+$/.test(s)), 'no dash, arrow or emoji that the shot harness cannot draw');
}

// ------------------------------------------------------------------ the hold

const { HUD } = await import('../src/ui/HUD.js');

function classSet() {
  const s = new Set();
  return { toggle: (c, v) => { if (v) s.add(c); else s.delete(c); }, add: (c) => s.add(c), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c) };
}

function fakeHUD() {
  const self = Object.create(HUD.prototype);
  self.c = {};
  self.moneyShown = 0;
  const noop = { toggle() {}, add() {}, remove() {} };
  self.refs = {
    money: { classList: noop }, moneyVal: { textContent: '' },
    corruption: { dataset: {}, classList: classSet() },
    corruptionFill: { style: {} },
    corruptionBand: { textContent: '' },
    corruptionNext: { textContent: '' },
    corruptionRoute: { textContent: '', classList: noop },
    corruptionTrace: { setAttribute() {} },
  };
  return self;
}

const world = (w, band) => ({
  items: { gold: 0 },
  corruption: { world: w, band: band ?? BANDS.reduce((b, x, i) => (w >= x.at ? i : b), 0) },
  progression: { stageIndex: 0 },
});

const run = (self, ctx, seconds) => { for (let i = 0; i < Math.round(seconds / H); i++) self.updateMoney(ctx, H); };

console.log('a pristine gauge already carries the legend, before anything has been fed');
{
  const self = fakeHUD();
  run(self, world(0), 1);
  ok(self.refs.corruptionNext.textContent === nextThresholdLine(0, 0), 'the line is up from the first frame');
  ok(!self.refs.corruption.classList.contains('is-primer'), 'and it is not shouting: nothing has been fed yet');
}

console.log('the first feed of a run holds the explanation still — and only the explanation');
{
  const self = fakeHUD();
  run(self, world(0), 1);
  self.updateMoney(world(5), H);
  const held = self.refs.corruptionNext.textContent;
  ok(self.refs.corruption.classList.contains('is-primer'), 'the first feed lights the explanation up');

  // Half the hold later the world has rotted further. The sentence is the one
  // thing that must not have moved.
  const width = self.refs.corruptionFill.style.width;
  run(self, world(15), CORRUPTION_PRIMER_S / 2);
  ok(self.refs.corruptionNext.textContent === held, `the sentence holds still ("${held}")`);
  ok(self.refs.corruptionFill.style.width !== width, 'while the fill underneath keeps moving — nothing is paused');
  ok(self.refs.corruptionBand.textContent === 'Pristine', 'and the band label is live, not frozen with it');

  run(self, world(15), CORRUPTION_PRIMER_S);
  ok(self.refs.corruptionNext.textContent === nextThresholdLine(15, 0), 'the hold expires and the line resumes tracking');
  ok(!self.refs.corruption.classList.contains('is-primer'), 'and it stops shouting');
}

console.log('...and it is a first-feed affordance, not a per-feed one');
{
  const self = fakeHUD();
  run(self, world(0), 1);
  run(self, world(5), CORRUPTION_PRIMER_S * 2);
  self.updateMoney(world(9), H);
  ok(!self.refs.corruption.classList.contains('is-primer'), 'the second feed of a run explains nothing again');
}

console.log('a crossing during the hold ends it: a frozen sentence about a line already crossed is false');
{
  const self = fakeHUD();
  run(self, world(0), 1);
  self.updateMoney(world(5), H);
  ok(self.refs.corruption.classList.contains('is-primer'), 'the hold is running');

  self.updateMoney(world(20), H);
  ok(self.refs.corruptionBand.textContent === 'Seeded', 'the party crossed into Seeded mid-hold');
  ok(self.refs.corruptionNext.textContent === nextThresholdLine(20, 1),
     `the line re-points at the band above ("${self.refs.corruptionNext.textContent}")`);
  ok(!self.refs.corruption.classList.contains('is-primer'), 'and the hold is over');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
