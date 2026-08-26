/**
 * The Tempering guarantee (issue #222): once any pack holds both parents of a
 * recipe, eligibility must not be denied by stage or by the shrine bag's own
 * RNG — the *chance* of finding a forge is gone, only the cost of using one
 * (both parents, `Items.temper()`) remains.
 *
 * `_populateShrines`'s bag draws the Tempering Anvil at weight 16 against a
 * gated, without-replacement pull (`src/world/Interactables.js`), so most
 * seeds place nothing. Seed 1 at stage 1 is one such seed — the discriminating
 * case below — and is the red arm this file stands in for: before the
 * guarantee existed, an eligible pack could stand on that stage and find no
 * anvil anywhere on it.
 */
import * as THREE from 'three';
import { Interactables, TemperingAnvil, Chest, MultishopTerminal } from '../src/world/Interactables.js';
import { Corruption } from '../src/systems/Corruption.js';
import { Items } from '../src/systems/Items.js';
import { RNG } from '../src/core/MathUtil.js';
import { TEMPERED_ITEMS, TEMPER_BY_ID } from '../src/data/items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// The populate-level harness from purity-altar-spawn.test.mjs / corruption-
// counterplay.test.mjs: real landmarks and a rejecting `isWalkable`.
const STAGE = () => ({
  bound: 44,
  landmarks: [{ x: -14, z: 6, r: 5 }, { x: 12, z: -9, r: 7 }, { x: 2, z: 18, r: 4 }],
  isWalkable: (x, z) => x * x + z * z > 36 && Math.sin(x * 0.31) + Math.cos(z * 0.27) > -1.2,
  sampleHeight: (x, z) => Math.sin(x * 0.11) * 0.7 + Math.cos(z * 0.09) * 0.5,
});

function populated(stageIndex, { seed = 1, eligible = false } = {}) {
  const ctx = {
    seed, authority: true, rng: new RNG(seed), stage: STAGE(), time: 0,
    scene: { add() {}, remove() {} },
    player: { isPlayer: true, alive: true, position: new THREE.Vector3() },
    events: { emit() {}, on() {} },
  };
  const items = new Items();
  items.init(ctx);
  const corruption = new Corruption();
  corruption.init(ctx);
  if (eligible) {
    const { argent, blight } = TEMPER_BY_ID.get(TEMPERED_ITEMS[0].id);
    items.give(argent, 1);
    items.give(blight, 1);
  }
  const inter = new Interactables();
  inter.init(ctx);
  inter.populate(stageIndex);
  return { ctx, inter, items };
}

const anvils = (p) => p.inter.list.filter((i) => i instanceof TemperingAnvil);
const typeNames = (p) => p.inter.list.map((i) => i.constructor.name);

console.log('an eligible pack is guaranteed an anvil on a seed that would not naturally place one');
{
  // Ground truth for "would not naturally place one": the same seed, same
  // stage, with nothing eligible — so any anvil that shows up with an
  // eligible pack is the guarantee acting, not the bag's own luck.
  const bare = populated(1, { seed: 1, eligible: false });
  ok(anvils(bare).length === 0, 'seed 1 / stage 1 places no anvil on its own (the discriminating case)');

  const withElig = populated(1, { seed: 1, eligible: true });
  ok(anvils(withElig).length === 1, `an eligible pack on the same seed/stage is guaranteed exactly one anvil (saw ${anvils(withElig).length})`);
}

console.log('the guarantee costs nothing else: an ineligible pack sees an identical stage, unaffected by the fix');
{
  const before = populated(1, { seed: 1, eligible: false });
  const again = populated(1, { seed: 1, eligible: false });
  ok(JSON.stringify(typeNames(before)) === JSON.stringify(typeNames(again)),
    'two ineligible runs on one seed place the identical bag, in the identical order');
  ok(anvils(before).length === 0, 'and still no anvil — the guarantee never fires without eligibility');
}

console.log('the cost survives: the forced anvil still consumes both parents on press');
{
  const p = populated(1, { seed: 1, eligible: true });
  const anvil = anvils(p)[0];
  const pawn = p.ctx.player;
  const { argent, blight } = TEMPER_BY_ID.get(TEMPERED_ITEMS[0].id);
  ok(p.items.count(argent) === 1 && p.items.count(blight) === 1, 'both parents held before the press');
  ok(anvil.interact(pawn) === true, 'the forced anvil presses like any other');
  ok(p.items.chooseMutation(TEMPERED_ITEMS[0].id) === true, 'the forge card is chosen');
  ok(p.items.count(argent) === 0 && p.items.count(blight) === 0, 'both parents are consumed — the guarantee places the shrine, never the card for free');
  ok(p.items.count(TEMPERED_ITEMS[0].id) === 1, 'the tempered card is granted');
}

console.log('stage 0 stays exempt even with an eligible pack');
{
  const p = populated(0, { seed: 1, eligible: true });
  ok(anvils(p).length === 0, 'no forced anvil on stage 0 — a fresh pack has never had time to earn a named pair');
}

console.log('eligibility gained mid-stage does not retroactively conjure one');
{
  // The guarantee is a populate-time contract: it is asked once, at
  // populate(), and eligibility gained afterward takes effect at the *next*
  // populate — this run's stage does not repaint itself.
  const p = populated(1, { seed: 1, eligible: false });
  ok(anvils(p).length === 0, 'the stage begins with no anvil');
  const { argent, blight } = TEMPER_BY_ID.get(TEMPERED_ITEMS[0].id);
  p.items.give(argent, 1);
  p.items.give(blight, 1);
  ok(anvils(p).length === 0, 'becoming eligible mid-stage does not retroactively place one on this stage');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
