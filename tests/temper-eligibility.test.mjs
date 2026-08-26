/**
 * Tempered recipe eligibility and parent-item progress (issue #221).
 *
 * Tempering was legible only by accident: `TemperingAnvil._eligible()`
 * (Interactables.js) already knew which recipes could forge *right now*, but
 * nothing surfaced a recipe the player half-holds ("known, one parent short")
 * or protected a recipe nobody has met at all from leaking into the prompt.
 * `temperRecipeStates` is the pure state model this ticket adds: given a way
 * to count items and a way to ask what has been discovered, it classifies
 * every Tempered recipe into exactly one of three states —
 *
 *   - 'hidden'   neither parent nor the tempered result has ever been met.
 *                Never returned: an undiscovered recipe must not appear in
 *                the output at all, or the array itself is a spoiler.
 *   - 'known'    at least one has been met, but the parents are not both in
 *                hand right now.
 *   - 'eligible' both parents are held right now — the forge is a real,
 *                immediate choice.
 *
 * A recipe that is eligible is known by construction (you cannot be holding
 * both parents of something you have never met), so 'eligible' subsumes
 * 'known' rather than requiring separate discovery bookkeeping.
 */
import { temperRecipeStates, TEMPERED_ITEMS, TEMPER_BY_ID, ITEM_BY_ID } from '../src/data/items.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const recipe = (n) => TEMPERED_ITEMS[n];
const parentsOf = (n) => TEMPER_BY_ID.get(recipe(n).id);

// A stub inventory: a plain id -> count map, read the same way `Items.count` reads it.
function counts(map = {}) {
  return (id) => map[id] || 0;
}
// A stub discovery ledger: a set of `kind:id` strings, read the same way
// `Profile.isDiscovered` reads it.
function discovery(...seen) {
  const set = new Set(seen);
  return (kind, id) => set.has(`${kind}:${id}`);
}

console.log('an undiscovered recipe never appears — no parent, no result, ever met');
{
  const states = temperRecipeStates(counts(), discovery());
  ok(states.length === 0, `nothing surfaces with an empty inventory and a blank ledger (got ${states.length})`);
  ok(TEMPERED_ITEMS.length > 0, 'sanity: there are recipes to hide in the first place');
}

console.log('meeting one parent surfaces the recipe as known, not eligible');
{
  const { argent } = parentsOf(0);
  const states = temperRecipeStates(counts(), discovery(`item:${argent}`));
  const row = states.find((r) => r.id === recipe(0).id);
  ok(!!row, 'the recipe with a discovered parent is in the list');
  ok(row.state === 'known', `state is 'known' (got ${row.state})`);
  ok(row.argent.discovered === true, 'the discovered parent is flagged discovered');
  ok(row.blight.discovered === false, 'the untouched parent is not');
  // Other recipes stay hidden — discovering one recipe's parent must not leak
  // every other recipe onto the anvil's readout.
  ok(states.length === 1, `only the one recipe surfaces (got ${states.length})`);
}

console.log('meeting the tempered result itself also surfaces it as known');
{
  const id = recipe(1).id;
  const states = temperRecipeStates(counts(), discovery(`item:${id}`));
  const row = states.find((r) => r.id === id);
  ok(!!row, 'a discovered result surfaces its own recipe');
  ok(row.state === 'known', `state is 'known' with no parent owned (got ${row.state})`);
}

console.log('owning one parent and not the other is known, with progress on both sides');
{
  const { argent, blight } = parentsOf(0);
  const states = temperRecipeStates(counts({ [argent]: 1 }), discovery());
  // Owning a parent, even without a discovery record, is itself proof the
  // player has met it — inventory presence implies discovery.
  const row = states.find((r) => r.id === recipe(0).id);
  ok(!!row, 'holding a parent surfaces the recipe even with a blank ledger');
  ok(row.state === 'known', `not yet eligible with only one parent (got ${row.state})`);
  ok(row.argent.owned === true, 'the held parent reads owned');
  ok(row.blight.owned === false, 'the missing parent reads not owned');
}

console.log('holding both parents is eligible');
{
  const { argent, blight } = parentsOf(1);
  const states = temperRecipeStates(counts({ [argent]: 1, [blight]: 2 }), discovery());
  const row = states.find((r) => r.id === recipe(1).id);
  ok(!!row, 'a fully-stocked recipe surfaces');
  ok(row.state === 'eligible', `state is 'eligible' with both parents held (got ${row.state})`);
  ok(row.argent.owned === true && row.blight.owned === true, 'both sides read owned');
}

console.log('every returned row names real items and never invents one');
{
  const states = temperRecipeStates(
    counts(Object.fromEntries(TEMPERED_ITEMS.map((t) => [TEMPER_BY_ID.get(t.id).argent, 1]))),
    discovery(),
  );
  ok(states.length === TEMPERED_ITEMS.length, 'every recipe with an owned argent parent surfaces');
  for (const row of states) {
    ok(ITEM_BY_ID.has(row.id), `${row.id} is a real item id`);
    ok(row.name === ITEM_BY_ID.get(row.id).name, `${row.id} carries its real name`);
    ok(row.argent.name === ITEM_BY_ID.get(row.argent.id).name, `${row.id}'s argent parent carries its real name`);
    ok(row.blight.name === ITEM_BY_ID.get(row.blight.id).name, `${row.id}'s blight parent carries its real name`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
