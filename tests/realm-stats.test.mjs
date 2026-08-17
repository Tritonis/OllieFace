/**
 * Side-realm acceptance statistics (issue #38).
 *
 *   node tests/realm-stats.test.mjs
 *
 * This guards a number that is meant to *drive a balance change*, which makes
 * the usual failure mode here — a computation that returns something plausible
 * for the wrong reason — expensive rather than merely wrong. So the fixture is
 * built so that the naive denominator and the decided one disagree loudly:
 * four offers, two of which the player could not actually take, and both of the
 * two they could take accepted. Naive acceptance is 50%, which sits below the
 * issue's 75% bar and would report tension where there is none; the decided
 * acceptance is 100%, which clears it. A denominator swapped by accident cannot
 * pass this file.
 *
 * The second thing guarded is the refusal. Records written before gold was
 * captured at offer time cannot answer "could they afford it", and the summary
 * must return null rather than a number for those — a rate quietly computed off
 * an approximation is indistinguishable from a real one at the point it is read.
 */
import { annotateOffers, summarise, verdict, buildKey } from '../tools/lib/realm-stats.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };
const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;

// --------------------------------------------------------------- the fixture

/**
 * One run, four detour offers, two visits.
 *
 *   market   stage 0  cost 120  peak purse 60   -> unaffordable, NOT eligible
 *   crucible stage 0  cost   0                  -> eligible, taken
 *   vault    stage 1  cost 100  peak purse 400  -> eligible, taken
 *   crucible stage 2  cost   0  already visited -> repeat, NOT eligible
 */
const run = {
  version: 2,
  survivor: 'skink',
  difficulty: 'monsoon',
  artifacts: ['glass'],
  outcome: { won: true },
  stages: [
    { index: 0, enteredAt: 0, leftAt: 200 },
    { index: 1, enteredAt: 210, leftAt: 400 },
    { index: 2, enteredAt: 420, leftAt: 600 },
  ],
  realmOffers: [
    { t: 10, stage: 0, id: 'market', kind: 'gateway', cost: 120, gold: 50, goldMax: 60, band: 0 },
    { t: 12, stage: 0, id: 'crucible', kind: 'gateway', cost: 0, gold: 50, goldMax: 60, band: 0 },
    { t: 220, stage: 1, id: 'vault', kind: 'gateway', cost: 100, gold: 200, goldMax: 400, band: 1 },
    { t: 430, stage: 2, id: 'crucible', kind: 'gateway', cost: 0, gold: 10, goldMax: 10, band: 2 },
    { t: 590, stage: 2, id: 'fracture', kind: 'finale', cost: 0, gold: 10, goldMax: 10, band: 2 },
  ],
  realmVisits: [
    { id: 'crucible', stage: 0, enteredAt: 20, exitedAt: 150, duration: 130, items: 4, kills: 30 },
    { id: 'vault', stage: 1, enteredAt: 240, exitedAt: 330, duration: 90, items: 3, kills: 5 },
  ],
};

console.log('--- the denominator is offers the player could actually take ---');
const ann = annotateOffers(run).filter((o) => o.kind !== 'finale');
ok(ann.length === 4, `four detour offers annotated (got ${ann.length})`);
ok(ann.find((o) => o.id === 'market').affordable === false, 'a 120g door against a 60g peak purse is unaffordable');
ok(ann.find((o) => o.id === 'market').eligible === false, 'an unaffordable door is not in the denominator');
ok(ann.find((o) => o.t === 220).eligible === true, 'a 100g door against a 400g peak purse is eligible');
ok(ann.find((o) => o.t === 430).repeat === true, 'a second crucible offer after a crucible visit is a repeat');
ok(ann.find((o) => o.t === 430).eligible === false, 'an already-used realm is not in the denominator');
ok(ann.find((o) => o.t === 12).accepted === true, 'the crucible offer is matched to the crucible visit');

const r = summarise([run]);
ok(r.overall.offers === 4, `all four detour offers counted (got ${r.overall.offers})`);
ok(r.overall.eligibleOffers === 2, `two offers were actually takeable (got ${r.overall.eligibleOffers})`);
ok(r.overall.visits === 2, `both were taken (got ${r.overall.visits})`);
// The load-bearing assertion. Naive visits/offers is 0.5 here and would read as
// tension; the decided denominator is 1.0 and reads as none.
ok(near(r.overall.acceptance, 1), `acceptance is visits/takeable = 1.0 (got ${r.overall.acceptance})`);
ok(!near(r.overall.acceptance, 0.5), 'acceptance is NOT visits/all-offers');

console.log('--- the other numbers the issue asks for ---');
// Four detour offers over three stages. The finale door is excluded here too:
// it is not a detour anyone can be offered twice.
ok(near(r.offerRate, 4 / 3), `offer rate is detour offers per stage (got ${r.offerRate})`);
ok(near(r.overall.meanDuration, 110), `mean realm duration (got ${r.overall.meanDuration})`);
ok(near(r.overall.meanItems, 3.5), `mean items gained inside a realm (got ${r.overall.meanItems})`);
// crucible exits at 150, stage 1 opens at 210 -> 60; vault exits at 330, stage 2 opens at 420 -> 90.
ok(near(r.overall.meanTimeToNextStage, 75), `mean time from realm exit to next stage (got ${r.overall.meanTimeToNextStage})`);
ok(near(r.overall.postRealmWinRate, 1), `post-realm win rate (got ${r.overall.postRealmWinRate})`);
ok(buildKey(run) === 'skink +glass', `build key names survivor and artifacts (got ${buildKey(run)})`);
ok(near(r.byBuild['skink +glass'].acceptance, 1), 'broken down by build');
ok(near(r.byBand['band 0'].acceptance, 1), 'broken down by corruption band at offer time');
ok(r.byRealm.market.eligibleOffers === 0, 'a realm only ever offered unaffordably has an empty denominator');
ok(r.byRealm.market.acceptance === null, 'and no acceptance rate, rather than zero');
ok(r.finale.offers === 1, 'finale doors are counted apart from detours');

console.log('--- a record that cannot answer the question refuses to ---');
const old = {
  ...run, version: 1,
  realmOffers: run.realmOffers.map(({ gold, goldMax, band, ...rest }) => rest),
};
const ro = summarise([old]);
ok(ro.overall.unclassifiableOffers === 2, `priced offers with no purse recorded are unclassifiable (got ${ro.overall.unclassifiableOffers})`);
ok(ro.overall.acceptance === null, 'and the acceptance rate is null, not a guess');
ok(verdict(ro).verdict === 'NO VERDICT', 'the verdict refuses on unclassifiable offers');
ok(/fresh runs/i.test(verdict(ro).why), 'and says what would fix it');

console.log('--- the verdict rule is the issue`s own ---');
// Sixty offers, all takeable, all taken: no tension anywhere.
const hot = { ...run, realmOffers: [], realmVisits: [], stages: run.stages };
for (let i = 0; i < 30; i++) {
  hot.realmOffers.push({ t: i * 2, stage: 0, id: `r${i}`, kind: 'gateway', cost: 0, gold: 0, goldMax: 0, band: 0 });
  hot.realmVisits.push({ id: `r${i}`, stage: 0, enteredAt: i * 2 + 1, exitedAt: i * 2 + 1.5, duration: 0.5, items: 1 });
}
ok(verdict(summarise([hot])).verdict === 'NO TENSION', 'every bucket above 75% reads as no tension');
const cold = { ...hot, realmVisits: hot.realmVisits.slice(0, 10) };
ok(verdict(summarise([cold])).verdict === 'HAS TENSION', 'a bucket at 33% reads as tension');
ok(verdict(summarise([])).verdict === 'NO VERDICT', 'no data is no verdict');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
