/**
 * Branding — no Risk of Rain 2 proper noun reaches the player.
 *
 *   node tests/branding-display.test.mjs
 *
 * The round-6 ledger (reviews/round6/BRANDING-LEDGER.md) renamed ~50 verbatim
 * RoR2 display names but ruled internal ids out of scope, and a later sweep
 * found the strings it missed: the elite affixes render raw through
 * `prettify(enemy.affix)` in the HUD boss label, the item tier strip says
 * "Lunar", and the obelisk ending titles itself "Obliterated". This file pins
 * the display layer: ids stay (save data), display strings must be original.
 * It fails if a new elite ships without a label, or if any pinned string
 * regresses to the RoR2 vocabulary.
 */
import { ELITE_STATS } from '../src/data/enemies.js';
import { TIERS } from '../src/data/items.js';
import { ENDINGS } from '../src/data/realms.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

// RoR2's elite prefixes and tier vocabulary. Lower-cased for the comparison;
// the ids on the left of each entry are ours and deliberately stay.
const ROR2_DISPLAY = new Set(['blazing', 'glacial', 'overloading', 'malachite',
  'celestine', 'perfected', 'voidtouched', 'gilded', 'lunar', 'obliterated']);

{
  console.log('every elite affix carries a display label of its own');
  for (const [key, stats] of Object.entries(ELITE_STATS)) {
    ok(typeof stats.label === 'string' && stats.label.length > 0, `${key} has a label`);
    ok(!ROR2_DISPLAY.has(stats.label?.toLowerCase()), `${key} label "${stats.label}" is not RoR2 vocabulary`);
    // A key that is itself RoR2 vocabulary must not leak through a label that
    // merely re-capitalises it; an original key may share its label's spelling.
    if (ROR2_DISPLAY.has(key)) {
      ok(stats.label?.toLowerCase() !== key, `${key} label is a rename, not the RoR2 key re-capitalised`);
    }
  }
}

{
  console.log('tier display names are original');
  for (const [key, tier] of Object.entries(TIERS)) {
    ok(!ROR2_DISPLAY.has(tier.name?.toLowerCase()), `tier ${key} displays "${tier.name}"`);
  }
}

{
  console.log('ending titles are original');
  for (const [key, ending] of Object.entries(ENDINGS)) {
    ok(!ROR2_DISPLAY.has(ending.title?.toLowerCase()), `ending ${key} titles "${ending.title}"`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
