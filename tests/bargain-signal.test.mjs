/**
 * The altar has to argue before you arrive, and it has to name the number
 * (issue #36, D3 / §2.3-2.4).
 *
 * Two failures, one prop. At range the maw lerped a single emissive intensity
 * between "afforded" and "rock", which says *whether* the pact is reachable and
 * nothing about how far off it is - a player twelve corruption short reads the
 * same dull cone as a player who has spent everything. On the altar the short
 * purse read "Blighted wants more than you hold", which is the vague half of a
 * sentence whose other half is the whole design: how many marks it wants, how
 * many are held, and how much more greed the next one costs.
 *
 * These pin both halves against a real `Corruption`, and each is written so it
 * can fail: the numbers are compared against the purse rather than a literal,
 * and the at-range state is asserted to *flip* across the affordability
 * boundary rather than merely to exist.
 */
import * as THREE from 'three';
import { Corruption } from '../src/systems/Corruption.js';
import { BOON } from '../src/data/bandBoons.js';
import { BANDS } from '../src/data/corruption.js';
import { VoidBargain } from '../src/world/Interactables.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

function makeCtx() {
  const listeners = new Map();
  const ctx = {
    authority: true,
    seed: 12345,
    player: { isPlayer: true, alive: true },
    events: {
      emit(name, p) { for (const fn of listeners.get(name) || []) fn(p); },
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    },
    interactables: { list: [] },
  };
  const corruption = new Corruption();
  corruption.init(ctx);
  return ctx;
}

const altarAt = (world, spend = 0) => {
  const ctx = makeCtx();
  if (world > 0) ctx.corruption.feed(ctx.player, world);
  // Overrun's own depth mints four marks, so the only way to stand in the band
  // one mark short is to have spent - which is exactly the party the line is
  // written for.
  if (spend > 0) ctx.corruption.spendMarks(spend);
  return { ctx, altar: new VoidBargain(ctx, new THREE.Vector3(), 0) };
};

console.log('the shortfall line names both sides of the purse');
{
  // Overrun (band 3) wants three marks, and the band's own depth mints four -
  // so the short purse this line exists for is a party that has already spent.
  const { ctx, altar } = altarAt(BANDS[3].at, 3);
  ok(ctx.corruption.band === 3, `the world is Overrun (${ctx.corruption.band})`);
  const held = ctx.corruption.marks;
  ok(held < BOON.pact.marks, `and the purse is short (${held} of ${BOON.pact.marks})`);

  const line = altar.prompt();
  ok(!/more than you hold/.test(line), `the vague line is gone: ${JSON.stringify(line)}`);
  ok(line.includes(`${BOON.pact.marks} mark`), 'the price is named');
  ok(new RegExp(`hold ${held}\\b`).test(line), `the purse is named (${held})`);

  const toNext = BOON.markPer - (ctx.corruption.peak % BOON.markPer);
  ok(line.includes(`${Math.ceil(toNext)} more corruption`), `and the distance to the next mark (${toNext})`);

  // The line is not a constant: move the purse and every number moves with it.
  ctx.corruption.feed(ctx.player, BOON.markPer);
  const held2 = ctx.corruption.marks;
  const line2 = altar.prompt();
  ok(held2 === held + 1, `a deeper run mints another mark (${held2})`);
  ok(line2 !== line && new RegExp(`hold ${held2}\\b`).test(line2), `and the line follows it: ${JSON.stringify(line2)}`);
}

console.log('the maw reads affordability at range, not merely reachability');
{
  const { ctx, altar } = altarAt(BANDS[3].at, 3);
  const settle = () => { for (let i = 0; i < 200; i++) altar.update(0.1); };

  settle();
  const shortState = altar.signal();
  const shortHex = altar.maw.material.emissive.getHex();
  const shortLit = altar.maw.material.emissiveIntensity;
  ok(shortState.state === 'short', `short of the price reads as short (${shortState.state})`);
  ok(shortState.want === BOON.pact.marks && shortState.held === ctx.corruption.marks,
    `carrying both sides (${shortState.held}/${shortState.want})`);

  // Saving toward the pact has to *look* like progress before it completes.
  const nearer = new VoidBargain(ctx, new THREE.Vector3(), 0);
  ctx.corruption.feed(ctx.player, BOON.markPer * 0.9);
  for (let i = 0; i < 200; i++) nearer.update(0.1);
  ok(nearer.signal().progress > shortState.progress,
    `and closing the gap raises the signal (${shortState.progress.toFixed(2)} -> ${nearer.signal().progress.toFixed(2)})`);

  // Cross the boundary: the state, the colour and the brightness all flip.
  ctx.corruption.feed(ctx.player, BOON.markPer * 2);
  ok(ctx.corruption.marks >= BOON.pact.marks, `the purse now covers the pact (${ctx.corruption.marks})`);
  settle();
  ok(altar.signal().state === 'afford', `the altar reads as afforded (${altar.signal().state})`);
  ok(altar.maw.material.emissive.getHex() !== shortHex, 'the maw changes colour across the boundary');
  ok(altar.maw.material.emissiveIntensity > shortLit + 0.5,
    `and brightens (${shortLit.toFixed(2)} -> ${altar.maw.material.emissiveIntensity.toFixed(2)})`);
}

console.log('a run with nothing to sell is still a rock');
{
  const { altar } = altarAt(0);
  for (let i = 0; i < 200; i++) altar.update(0.1);
  ok(altar.signal().state === 'dormant', `Pristine is dormant (${altar.signal().state})`);
  ok(altar.maw.material.emissiveIntensity < 0.5, 'and unlit');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
