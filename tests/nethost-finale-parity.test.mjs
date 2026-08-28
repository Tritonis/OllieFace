/**
 * A guest's finale agrees with the host's (issue #220).
 *
 *   node tests/nethost-finale-parity.test.mjs
 *
 * One real host-side `Progression` + `Corruption`, one real guest-side pair,
 * and the real `NetHost` / `NetClient` message paths between them — the wire
 * is encoded and decoded, not handed across as an object. Two gaps this
 * closes, each with its own claim below:
 *
 *   1. `Realms.victory()`/`obliterate()` run authority-gated and call
 *      `Progression.finishRun` only on the host — before this, a guest's own
 *      run simply never resolved on a win. `runEnding` (broadcast by
 *      `NetHost`, applied by `Progression`'s own listener) closes that: the
 *      guest's `finishRun` runs the SAME `ENDINGS` object the host resolved,
 *      so its end screen and its committed profile record agree with the
 *      host's for every ending id, not just death (which was already
 *      forwarded via `playerDead`).
 *   2. A guest's own alignment ledger never accrues (`commit` is
 *      authority-gated) and used to read 'neutral' forever, so the HUD's
 *      barred-gate line could disagree with the host's for the entire run.
 *      `Corruption.netState`/`applyNetState` now carry the ledger's resolved
 *      CLASS, and `cleanRouteEligibleFor` is what the guest's route line
 *      reads it through — proven here by walking the exact (band, ending)
 *      combinations the ticket names: clean-eligible, redeemed (barred), and
 *      void.
 */
import { Progression } from '../src/systems/Progression.js';
import { Corruption } from '../src/systems/Corruption.js';
import { NetHost } from '../src/net/NetHost.js';
import { NetClient } from '../src/net/NetClient.js';
import { ENDINGS } from '../src/data/realms.js';
import { cleanRouteEligibleFor } from '../src/data/realms.js';
import { sealTextFor } from '../src/ui/Menus.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx(authority) {
  const listeners = new Map();
  const ctx = {
    authority, time: 0, seed: 4242, paused: false, netRole: authority ? 'host' : 'client',
    events: {
      emit(name, p) { for (const fn of (listeners.get(name) || []).slice()) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return () => {}; },
    },
    scene: { add() {} },
    progression: { stageIndex: 4, corruptionPeakBand: 0 },
  };
  ctx.player = { isPlayer: true, alive: true, survivorId: null };
  return ctx;
}

/** A host + one guest, wired through the real NetHost/NetClient message path. */
function makePair() {
  const sent = [];
  const host = new NetHost({ maxPlayers: 4 });
  host.transport = {
    onPeer: null, onPeerLeave: null,
    broadcastEvent: (b) => sent.push(b),
    broadcastState() {}, close() {},
  };
  const hostCtx = makeCtx(true);
  const hostCor = new Corruption();
  hostCor.init(hostCtx);
  const hostProg = new Progression();
  hostProg.init(hostCtx);
  host.init(hostCtx);
  host.clients.set(1, {
    peer: { id: 1, sendEvent: () => {}, sendState() {}, pumpSim() {}, close() {} },
    pawn: null, inputs: [], lastTick: 0, name: 'Player 2',
    joinTick: 0, joinedAt: 0, helloSeen: true, survivorId: null,
  });

  const client = new NetClient();
  const clientCtx = makeCtx(false);
  const clientCor = new Corruption();
  clientCor.init(clientCtx);
  const clientProg = new Progression();
  clientProg.init(clientCtx);
  client.ctx = clientCtx;

  // `commitRun` no-ops without an open run — both machines need one open,
  // exactly as a real session would have by the time any ending resolves.
  // Called directly on `Profile` rather than via a `stageStart` emit, which
  // would also drive `Progression`'s full stage-transition machinery — no
  // part of that is under test here.
  hostProg.profile.beginRun();
  clientProg.profile.beginRun();

  const settle = () => {
    host.update(hostCtx, 1 / 60);
    while (sent.length) client._handleMessage(sent.shift());
  };
  return { hostCtx, hostCor, hostProg, clientCtx, clientCor, clientProg, settle };
}

console.log('\n1. a clean-eligible victory resolves identically on both machines');
{
  const p = makePair();
  // A spotless ledger: `alignmentOf` reads 'neutral', which is clean-eligible
  // at every band `cleanRouteEligible`'s ceiling allows.
  p.hostProg.finishRun(ENDINGS.victory);
  p.settle();

  ok(p.clientProg.ending?.id === 'victory', `the guest resolved 'victory' (${p.clientProg.ending?.id})`);
  ok(sealTextFor(p.clientProg.ending?.id) === sealTextFor(p.hostProg.ending?.id),
     'the seal text the death screen would print agrees');
  ok(p.clientProg.profile.data.runs[0]?.endingId === 'victory' && p.hostProg.profile.data.runs[0]?.endingId === 'victory',
     'both machines committed endingId "victory" to their own profile');
  const band = 0;
  ok(cleanRouteEligibleFor(band, p.clientCor.alignment) === cleanRouteEligibleFor(band, p.hostCor.alignment),
     'the guest HUD route line reads the same barred/open verdict as the host');
  ok(p.clientCor.alignment === 'neutral', `the guest read the host's neutral class (${p.clientCor.alignment})`);
}

console.log('\n2. a redeemed (barred) victory resolves identically on both machines');
{
  const p = makePair();
  // Two corrupt chests: 6 > TOLERANCE.corrupt (3), so `alignmentOf` reads
  // 'corrupt' — the history that bars the clean gate even though the route
  // taken (band-sited) is the one `ENDINGS.redeemed` is walked through.
  p.hostCor.commit('corruptChest');
  p.hostCor.commit('corruptChest');
  ok(p.hostCor.alignment === 'corrupt', 'the host ledger is corrupt-classed before the ending resolves');
  p.hostProg.finishRun(ENDINGS.redeemed);
  p.settle();

  ok(p.clientProg.ending?.id === 'redeemed', `the guest resolved 'redeemed' (${p.clientProg.ending?.id})`);
  ok(sealTextFor(p.clientProg.ending?.id) === sealTextFor(p.hostProg.ending?.id),
     'the seal text agrees ("Unabsolved, but finished" on both)');
  ok(p.clientProg.profile.data.runs[0]?.endingId === 'redeemed' && p.hostProg.profile.data.runs[0]?.endingId === 'redeemed',
     'both committed endingId "redeemed"');
  const band = 0;
  ok(cleanRouteEligibleFor(band, p.hostCor.alignment) === false, 'the host reads the clean gate barred');
  ok(cleanRouteEligibleFor(band, p.clientCor.alignment) === cleanRouteEligibleFor(band, p.hostCor.alignment),
     'the guest reads the SAME barred verdict — not its own permanently-neutral ledger');
  ok(p.clientCor.alignment === 'corrupt', `the guest read the host's corrupt class (${p.clientCor.alignment})`);
}

console.log('\n3. a void victory resolves identically on both machines');
{
  const p = makePair();
  p.hostProg.finishRun(ENDINGS.victoryVoid);
  p.settle();

  ok(p.clientProg.ending?.id === 'victory-void', `the guest resolved 'victory-void' (${p.clientProg.ending?.id})`);
  ok(p.clientProg.ending?.title === p.hostProg.ending?.title, 'the death-screen title agrees');
  ok(p.clientProg.profile.data.runs[0]?.endingId === 'victory-void' && p.hostProg.profile.data.runs[0]?.endingId === 'victory-void',
     'both committed endingId "victory-void"');
}

console.log('\n4. the parity guard actually distinguishes agreement from disagreement');
{
  // A guard that always reported "agrees" would still pass 1-3. This proves
  // the comparison is live: an out-of-sync guest (one that never received the
  // broadcast) genuinely reads differently from the host.
  const p = makePair();
  p.hostCor.commit('corruptChest');
  p.hostCor.commit('corruptChest');
  p.hostProg.finishRun(ENDINGS.redeemed);
  // Deliberately no `p.settle()` — the guest never hears about any of it.
  ok(p.clientProg.ending === null, 'an un-synced guest never resolved an ending at all');
  ok(p.clientCor.alignment === 'neutral' && p.hostCor.alignment === 'corrupt',
     'and its route line disagrees with the host — the exact defect #220 closes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
