/**
 * The callback-333 pump's decision rule, in plain node.
 *
 *   node tests/desktop-steam-callbacks.test.mjs
 *
 * What this CAN prove: the payload decode, the id filter, the free/next
 * pairing, the drain bound, and that a throwing FFI call degrades to a pump
 * that is off rather than a boot that failed.
 *
 * What it CANNOT prove, and does not claim: that live Steam delivers 333
 * through Valve's manual dispatch loop inside Electron. Nothing in plain node
 * can. That half is the user's sitting, and `docs/STEAM.md` section 7 says so.
 *
 * The dispatch is injected throughout, because a test whose answer depends on
 * whether Steam happens to be running on this box is not a test.
 */
import {
  decodeJoinRequested, drainCallbacks, startCallbackPump,
  GAME_LOBBY_JOIN_REQUESTED, MAX_CALLBACKS_PER_TICK,
} from '../desktop/steam-callbacks.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

/** A GameLobbyJoinRequested_t: lobby CSteamID, then friend CSteamID. */
const payload = (lobby, friend = 76561190000000000n) => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(BigInt(lobby), 0);
  b.writeBigUInt64LE(BigInt(friend), 8);
  return b;
};

/** A dispatch over a scripted queue, counting its own free() calls. */
const fakeDispatch = (queue) => {
  let taken = null, frames = 0, frees = 0;
  return {
    runFrame() { frames++; },
    next() { taken = queue.shift() ?? null; return taken; },
    free() { frees++; },
    get counts() { return { frames, frees }; },
  };
};

console.log('\n-- the id is 333 and nothing else');
{
  // Asserted as a LITERAL on purpose. Every other case in this file writes the
  // exported constant into its fake queue and reads it back, so all of them
  // pass just as happily against 334 — a guard that agrees with whatever the
  // module says is a guard that cannot fail. `k_iSteamFriendsCallbacks` is 300
  // and `GameLobbyJoinRequested_t` is the 33rd; get this wrong and the pump
  // hears something else, or nothing, forever.
  ok(GAME_LOBBY_JOIN_REQUESTED === 333, `k_iSteamFriendsCallbacks + 33 (${GAME_LOBBY_JOIN_REQUESTED})`);

  const seen = [];
  drainCallbacks(fakeDispatch([{ id: 333, data: payload(1234n) }]), (id) => seen.push(id));
  ok(seen.join(',') === '1234', 'a literal 333 off the wire is delivered');

  const ignored = [];
  drainCallbacks(fakeDispatch([{ id: 334, data: payload(1234n) }]), (id) => ignored.push(id));
  ok(ignored.length === 0, 'and its neighbour 334 is not');
}

console.log('\n-- the payload decode reads the lobby, not the friend');
{
  ok(decodeJoinRequested(payload(109775241000000001n)) === '109775241000000001',
    'the first CSteamID is the lobby id, little-endian');
  ok(decodeJoinRequested(payload(0n)) === null, 'a zero lobby id is not a lobby, it is Steam saying none');
  ok(decodeJoinRequested(Buffer.alloc(4)) === null, 'a short buffer decodes to null rather than throwing');
  ok(decodeJoinRequested(null) === null, 'so does nothing at all');
  ok(decodeJoinRequested(new Uint8Array(payload(4242n))) === '4242', 'a Uint8Array decodes the same as a Buffer');
}

console.log('\n-- a drain delivers every 333 and drops everything else, freeing both');
{
  const seen = [];
  const d = fakeDispatch([
    { id: 501, data: Buffer.alloc(8) },                       // LobbyChatUpdate: not ours
    { id: GAME_LOBBY_JOIN_REQUESTED, data: payload(777n) },
    { id: 1221, data: Buffer.alloc(8) },                      // a sockets callback: not ours
    { id: GAME_LOBBY_JOIN_REQUESTED, data: payload(888n) },
  ]);
  const delivered = drainCallbacks(d, (id) => seen.push(id));

  ok(delivered === 2, `two 333s delivered (${delivered})`);
  ok(seen.join(',') === '777,888', `and only the lobby ids, in order (${seen.join(',')})`);
  ok(d.counts.frames === 1, 'runFrame ran exactly once for the tick');
  ok(d.counts.frees === 4, `every callback taken off the queue was freed, ours or not (${d.counts.frees})`);
}

console.log('\n-- an undecodable 333 is still freed, and still not delivered');
{
  const seen = [], errors = [];
  const d = fakeDispatch([{ id: GAME_LOBBY_JOIN_REQUESTED, data: Buffer.alloc(2) }]);
  const delivered = drainCallbacks(d, (id) => seen.push(id), (m) => errors.push(m));

  ok(delivered === 0 && seen.length === 0, 'nothing was offered to the join delivery');
  ok(d.counts.frees === 1, 'the queue was not left wedged behind it');
  ok(errors.length === 1, 'and it was worth one log line');
}

console.log('\n-- a delivery that throws does not wedge the queue either');
{
  const d = fakeDispatch([{ id: GAME_LOBBY_JOIN_REQUESTED, data: payload(5n) }]);
  let threw = null;
  try { drainCallbacks(d, () => { throw new Error('renderer exploded'); }, () => {}); }
  catch (err) { threw = err; }

  ok(threw === null, 'drainCallbacks did not throw');
  ok(d.counts.frees === 1, 'the callback was freed in the finally');
}

console.log('\n-- the drain is bounded, so a flood cannot starve the main loop');
{
  const flood = Array.from({ length: MAX_CALLBACKS_PER_TICK + 25 },
    (_, i) => ({ id: GAME_LOBBY_JOIN_REQUESTED, data: payload(BigInt(i + 1)) }));
  const offered = flood.length;   // read before the drain: the fake shifts the array
  const d = fakeDispatch(flood);
  const delivered = drainCallbacks(d, () => {});

  ok(delivered === MAX_CALLBACKS_PER_TICK, `one tick stops at the cap (${delivered} of ${offered})`);
  ok(d.counts.frees === MAX_CALLBACKS_PER_TICK, 'and freed exactly what it took');
}

console.log('\n-- a throwing FFI call is a pump that is off, not a boot that failed');
{
  const errors = [];
  const boom = { runFrame() { throw new Error('pipe is gone'); }, next() { throw new Error('unreachable'); }, free() {} };
  const delivered = drainCallbacks(boom, () => {}, (m) => errors.push(m));
  ok(delivered === 0, 'a failed runFrame delivers nothing');
  ok(errors.length === 1 && errors[0].includes('pipe is gone'), 'and names the underlying failure');

  const halfway = fakeDispatch([]);
  halfway.next = () => { throw new Error('getNextCallback exploded'); };
  ok(drainCallbacks(halfway, () => {}, () => {}) === 0, 'a failed next() ends the tick rather than the process');
}

console.log('\n-- startCallbackPump reports a reason instead of throwing when it cannot arm');
{
  const off = startCallbackPump({ library: () => null, onJoinRequested: () => {} });
  ok(off.ok === false, 'no library handle means no pump');
  ok(typeof off.reason === 'string' && off.reason.length > 0, `and a named reason (${JSON.stringify(off.reason)})`);
  ok(typeof off.stop === 'function' && off.stop() === undefined, 'stop() is still safe to call');

  const angry = startCallbackPump({
    library: () => ({ func: () => { throw new Error('SteamAPI_ManualDispatch_Init missing'); } }),
    onJoinRequested: () => {},
  });
  ok(angry.ok === false && angry.reason.includes('ManualDispatch_Init'),
    'a missing symbol degrades with the symbol named, which is the lazy-resolution trap made visible');
}

console.log('\n-- an armed pump ticks, and stops when told');
{
  const seen = [];
  const d = fakeDispatch([{ id: GAME_LOBBY_JOIN_REQUESTED, data: payload(31337n) }]);
  const pump = startCallbackPump({ dispatch: d, onJoinRequested: (id) => seen.push(id), intervalMs: 1000 });
  ok(pump.ok === true, 'an injected dispatch arms without any FFI at all');
  ok(pump.tick() === 1 && seen[0] === '31337', 'one tick drains one invite');
  pump.stop();
  ok(true, 'stop() ran clean');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
