/**
 * The guarded-degradation contract for `desktop/steam.mjs`.
 *
 *   node tests/desktop-steam.test.mjs
 *
 * Steam-absent desktop must degrade SILENTLY: init failure returns
 * `available: false` with a non-empty reason, never throws, and leaves
 * `getClient()` null so no later task can call into a dead handle.
 *
 * The native module's behaviour depends on whether Steam happens to be running
 * on the box, so the polarity assertions inject a loader instead: a real test
 * needs a known answer, not the answer this machine felt like giving. The
 * uninjected arm still runs, and asserts only what is true either way — that it
 * returns the documented shape and does not throw.
 *
 * Main-process module, but it imports nothing from Electron, which is exactly
 * why it can be tested in plain node at all.
 */
import { initSteam, getClient, getStatus } from '../desktop/steam.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const SHAPE = ['available', 'appId', 'personaName', 'reason'];
const hasShape = (s) => s !== null && typeof s === 'object' && SHAPE.every((k) => k in s);

console.log('\n-- a throwing loader (Steam not running) degrades, it does not explode');
{
  let threw = null, status = null;
  try {
    status = initSteam(480, { load: () => { throw new Error('Steam is not running'); } });
  } catch (err) { threw = err; }

  ok(threw === null, `initSteam did not throw (${threw ? threw.message : 'clean'})`);
  ok(hasShape(status), 'returns the documented { available, appId, personaName, reason } shape');
  ok(status?.available === false, 'available is false');
  ok(typeof status?.reason === 'string' && status.reason.length > 0, `reason is a non-empty string (${JSON.stringify(status?.reason)})`);
  ok(status?.reason?.includes('Steam is not running'), 'the reason carries the underlying failure, so the log is diagnosable');
  ok(status?.personaName === null, 'no persona name is invented');
  ok(getClient() === null, 'getClient() stays null after a failed init');
}

console.log('\n-- a loader that returns nothing is a failure too, not a half-live client');
{
  let threw = null, status = null;
  try { status = initSteam(480, { load: () => ({ init: () => undefined }) }); }
  catch (err) { threw = err; }

  ok(threw === null, 'a loader whose init() returns undefined does not throw');
  ok(status?.available === false, 'available is false when init() yields no client');
  ok(typeof status?.reason === 'string' && status.reason.length > 0, 'that path still names a reason');
  ok(getClient() === null, 'getClient() stays null');
}

console.log('\n-- a working client reports what Steam actually says, not what we asked for');
{
  const fakeClient = {
    localplayer: { getName: () => 'Ollie' },
    utils: { getAppId: () => 480 },
  };
  const status = initSteam(9999, { load: () => ({ init: () => fakeClient }) });

  ok(status.available === true, 'available is true');
  ok(status.appId === 480, `appId comes from utils.getAppId(), not the argument (${status.appId})`);
  ok(status.personaName === 'Ollie', `personaName from localplayer.getName() (${JSON.stringify(status.personaName)})`);
  ok(status.reason === null, 'no reason on success');
  ok(getClient() === fakeClient, 'getClient() hands back the live client');
  ok(getStatus() !== status, 'getStatus() returns a copy, so a caller cannot mutate the record');
  ok(getStatus().available === true, 'the copy carries the same values');
}

console.log('\n-- a client that survives init but cannot be interrogated still degrades');
{
  const status = initSteam(480, {
    load: () => ({ init: () => ({ localplayer: { getName() { throw new Error('nope'); } }, utils: { getAppId: () => 480 } }) }),
  });
  ok(status.available === false, 'a throwing getName() is a failed init, not a client with a null name');
  ok(typeof status.reason === 'string' && status.reason.length > 0, 'and it names a reason');
  ok(getClient() === null, 'the half-live client is not retained');
}

console.log('\n-- the real module: whatever this box is doing, the contract holds');
{
  let threw = null, status = null;
  try { status = initSteam(480); } catch (err) { threw = err; }

  ok(threw === null, `initSteam against the real native module did not throw (${threw ? threw.message : 'clean'})`);
  ok(hasShape(status), 'still the documented shape');
  ok(typeof status?.available === 'boolean', 'available is a boolean either way');
  // Only one of the two arms can be true on any given box; assert the invariant
  // that binds both: false implies a reason, true implies no reason.
  ok(status?.available ? status.reason === null : (typeof status?.reason === 'string' && status.reason.length > 0),
    `unavailable implies a reason, available implies none (available=${status?.available}, reason=${JSON.stringify(status?.reason)})`);
  console.log(`  NOTE  this box reports available=${status?.available}` + (status?.available ? ` appId=${status.appId} personaName=${JSON.stringify(status.personaName)}` : ` reason=${JSON.stringify(status?.reason)}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
