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
import { initSteam, getClient, getStatus, enableOverlay } from '../desktop/steam.mjs';

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

// ---------------------------------------------------------------------------
// The fake SDK, in the shape `steamworks-ffi-node` actually has.
//
// ADAPTED 2026-08-21 with the Binding swap, and the adaptation is not cosmetic:
// the old fakes were `{ init: () => client }`, because `steamworks.js` handed a
// client BACK from init. This Binding is a singleton whose `init()` answers a
// bare BOOLEAN, and every call goes through the instance. So "init worked" is a
// strictly stronger question now — `true` AND the two interrogations — and the
// fakes have to be able to answer it wrongly for the assertions to mean
// anything. Nothing was weakened: the half-live-client case below is the same
// case it always was, and one arm was ADDED for `init()` returning false, which
// had no equivalent under a factory that could only return a client or throw.
// ---------------------------------------------------------------------------
const fakeSdk = (over = {}) => ({
  init: () => true,
  friends: { getPersonaName: () => 'Ollie' },
  utils: { getAppID: () => 480 },
  ...over,
});

console.log('\n-- a module with no init() at all is a failure, not a half-live client');
{
  let threw = null, status = null;
  try { status = initSteam(480, { load: () => ({}) }); }
  catch (err) { threw = err; }

  ok(threw === null, 'a loader that hands over no init() does not throw');
  ok(status?.available === false, 'available is false when there is nothing to initialise');
  ok(typeof status?.reason === 'string' && status.reason.length > 0, 'that path still names a reason');
  ok(getClient() === null, 'getClient() stays null');
}

console.log('\n-- init() answering false is a refusal, and must not read as success');
{
  // The trap this Binding brings and the old one did not: `init()` returns a
  // boolean, so a truthiness check on the SDK object would pass even when Steam
  // said no. Asserted rather than assumed.
  const status = initSteam(480, { load: () => fakeSdk({ init: () => false }) });
  ok(status.available === false, 'a false init() is unavailable');
  ok(status.reason?.includes('reported failure'), `and says so (${JSON.stringify(status.reason)})`);
  ok(getClient() === null, 'the refused SDK is not retained');
}

console.log('\n-- a working client reports what Steam actually says, not what we asked for');
{
  const sdk = fakeSdk();
  // Wrapped in the CJS module shape, and reached through getInstance(), which
  // is how the real module hands its singleton over.
  const status = initSteam(9999, { load: () => ({ SteamworksSDK: { getInstance: () => sdk } }) });

  ok(status.available === true, 'available is true');
  ok(status.appId === 480, `appId comes from utils.getAppID(), not the argument (${status.appId})`);
  ok(status.personaName === 'Ollie', `personaName from friends.getPersonaName() (${JSON.stringify(status.personaName)})`);
  ok(status.reason === null, 'no reason on success');
  ok(getClient() === sdk, 'getClient() hands back the live SDK instance');
  ok(getStatus() !== status, 'getStatus() returns a copy, so a caller cannot mutate the record');
  ok(getStatus().available === true, 'the copy carries the same values');
}

console.log('\n-- a client that survives init but cannot be interrogated still degrades');
{
  // This matters MORE under Koffi than it did under N-API: symbols resolve
  // lazily, so `init()` succeeding proves one symbol exists and nothing else.
  // The two read-backs are the first real proof the Binding works.
  const status = initSteam(480, {
    load: () => fakeSdk({ friends: { getPersonaName() { throw new Error('nope'); } } }),
  });
  ok(status.available === false, 'a throwing getPersonaName() is a failed init, not a client with a null name');
  ok(typeof status.reason === 'string' && status.reason.length > 0, 'and it names a reason');
  ok(getClient() === null, 'the half-live client is not retained');

  const lazy = initSteam(480, { load: () => fakeSdk({ utils: { getAppID() { throw new Error('symbol not found'); } } }) });
  ok(lazy.available === false, 'so is an appid read that dies at the first FFI call');
  ok(lazy.reason?.includes('symbol not found'), 'with the lazy-resolution failure carried into the reason');
}

console.log('\n-- the overlay is enabled only when Steam actually answered');
{
  // The binding constraint that outlives the overlay itself: a Steam-absent
  // player gets ZERO appended command-line switches and zero repaint timers.
  // `enableOverlay` is the only place that can breach it, so the guard is
  // asserted here rather than trusted — including now that the shipping Binding
  // has no overlay entry point at all (REFUTED 2026-08-21, #127).
  initSteam(480, { load: () => { throw new Error('Steam is not running'); } });
  let called = 0;
  const result = enableOverlay();
  ok(result.ok === false, 'a failed init leaves the overlay off');
  ok(result.reason === 'steam-unavailable', `and says why (${JSON.stringify(result.reason)})`);
  ok(called === 0, 'electronEnableSteamOverlay was never reached -- no switches appended');

  // The shipping shape: a module that binds no overlay entry point says so,
  // rather than reporting an overlay that is not there.
  initSteam(480, { load: () => fakeSdk() });
  const bare = enableOverlay();
  ok(bare.ok === false, 'a Binding with no overlay export does not claim one');
  ok(bare.reason === 'overlay-not-bound-by-this-binding', `and names the shape, not a crash (${JSON.stringify(bare.reason)})`);

  const mod = {
    ...fakeSdk(),
    electronEnableSteamOverlay: (arg) => { called++; ok(arg === undefined, 'called with the default arg (keeps the 60 Hz invalidator)'); },
  };
  initSteam(480, { load: () => mod });
  const on = enableOverlay();
  ok(on.ok === true, 'a module that DOES carry one is still honoured');
  ok(called === 1, 'exactly once');

  // A module whose overlay call explodes must not take the boot with it.
  initSteam(480, { load: () => ({ ...mod, electronEnableSteamOverlay: () => { throw new Error('no BrowserWindow'); } }) });
  let threw = null, fell = null;
  try { fell = enableOverlay(); } catch (err) { threw = err; }
  ok(threw === null, 'a throwing overlay call does not throw out of enableOverlay');
  ok(fell?.ok === false && fell.reason?.includes('no BrowserWindow'), 'it degrades to { ok: false } with the reason');
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
