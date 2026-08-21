// tests/corruption-upside-preview.test.mjs
// Issue #36, second pass. The upsides existed in the simulation and were
// missing from every surface read *before* a press: `pricedPrompt` quoted three
// clauses and all three were costs, so a player who read every word never
// learned that corruption buys anything. These pin the disclosure.
import { mintForecast, BOON } from '../src/data/bandBoons.js';
import { pricedPrompt } from '../src/world/corruptionPrice.js';
import { SOURCES } from '../src/data/corruption.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// --------------------------------------------------------- mintForecast, pure

console.log('mintForecast');
{
  const per = BOON.markPer;
  // A press that carries the peak across a multiple of `markPer` mints.
  const crossing = mintForecast(per - 1, 3);
  ok(crossing.mints === 1, `a press over the boundary mints one (got ${crossing.mints})`);

  const far = mintForecast(0, 1);
  ok(far.mints === 0, 'a press well short of the boundary mints nothing');
  ok(far.toNext === per - 1, `and names the distance left (${far.toNext} of ${per})`);

  // Two boundaries in one press is possible at legendary void credit rates.
  ok(mintForecast(0, per * 2 + 1).mints === 2, 'a press spanning two boundaries mints two');

  // The mint rides the *peak*, so a bled-back world does not re-mint what the
  // descent already paid for. Callers pass peak; a zero press moves nothing.
  ok(mintForecast(per * 3, 0).mints === 0, 'a zero press mints nothing');
  ok(mintForecast(NaN, 5).mints === 0, 'a non-finite peak reads as pristine rather than throwing');
  ok(mintForecast(-10, 5).mints === 0, 'a negative peak reads as pristine');
}

// ---------------------------------------------------- the clause in the prompt

console.log('pricedPrompt says what the debt buys');

/** Minimal corruption stub with the two fields the prompt reads. */
const cor = (world, peak = world, greed = false) => ({
  world, peak, greed,
  priceOf: (n) => (greed ? n * SOURCES.greedMult : n),
});

{
  const onBoundary = pricedPrompt({ corruption: cor(BOON.markPer - 2, BOON.markPer - 2) }, 'Chest ($120)', 12);
  ok(/void mark/.test(onBoundary), `a minting press names the mark: ${onBoundary}`);
  ok(/mints/.test(onBoundary), 'and says it mints one');

  const short = pricedPrompt({ corruption: cor(2, 2) }, 'Chest ($40)', 2);
  ok(/to the next void mark/.test(short), `a non-minting press names the distance: ${short}`);
  ok(!/mints/.test(short), 'and does not promise a mark it will not deliver');

  // The forecast has to ride the same multiplied number `feed` charges, or the
  // prompt promises a mark that greed time already earned twice over.
  const greedy = pricedPrompt({ corruption: cor(BOON.markPer - 6, BOON.markPer - 6, true) }, 'Chest ($40)', 4);
  ok(/mints a void mark/.test(greedy),
    `greed time is folded into the forecast, not the face value: ${greedy}`);

  // A world with no corruption system is still the bare gain line.
  ok(pricedPrompt({}, 'Chest ($40)', 4) === 'Chest ($40)', 'a stub context is untouched');

  // A corruption stub with no `peak` (older fixtures) degrades to no clause
  // rather than quoting a mark off `undefined`.
  const noPeak = pricedPrompt({ corruption: { world: 10, priceOf: (n) => n } }, 'Chest ($40)', 4);
  ok(!/NaN/.test(noPeak), `a peak-less stub quotes no NaN: ${noPeak}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
