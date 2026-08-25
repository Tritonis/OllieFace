/**
 * The movement-speed knee's card copy (#196).
 *
 * `softenMove` (`src/systems/Items.js`, #188) bends every movement-speed gain
 * past `MOVE_KNEE`, so a card that still reads as flat arithmetic — "+14%
 * movement speed", full stop — promises stacking the knee no longer pays.
 * Four cards carry a flat movement-speed clause: Cloven Hoof, Runner's Chalk,
 * Bloodied Spurs and Mercury Anklet. Each must say, in its own words, that the
 * gain diminishes once a build is already fast — no numbers, just the shape.
 *
 * This does not re-derive the curve (`tests/move-speed-knee.test.mjs` already
 * holds that); it only holds the copy to naming the shape it describes.
 */
import { ITEM_BY_ID } from '../src/data/items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// A word from the diminishing-returns family. Loose on purpose: the point is
// that *some* acknowledgement survives, not a fixed sentence.
const NAMES_THE_KNEE = /diminish|thin(s|ning)? out|harder to find|worth less|less generous/i;

const CARDS = ['cloven-hoof', 'runners-chalk', 'spurs', 'mercury-anklet'];

console.log('Every movement-speed card names its own diminishing returns');
{
  for (const id of CARDS) {
    const item = ITEM_BY_ID.get(id);
    const text = item.description(3);
    ok(NAMES_THE_KNEE.test(text), `${id} names the knee in its copy ("${text}")`);
  }

  // RED arm: a card copy reverted to flat arithmetic must fail the same check.
  const stripped = `+14% movement speed.`;
  ok(!NAMES_THE_KNEE.test(stripped),
    'MUTATION: a bare flat-arithmetic clause does not pass the check');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
