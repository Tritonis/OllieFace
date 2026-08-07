/**
 * Item ids that changed name, and the translation every save read goes through.
 *
 * The round-6 branding pass (`reviews/round6/BRANDING-LEDGER.md`) renamed the
 * *display* names of every borrowed Risk of Rain 2 item and deliberately left
 * the ids alone, because an id is written into save data and a rename without a
 * migration is a save wipe. Two ids were themselves the borrowed vocabulary
 * rather than merely attached to it — `hopoo-feather` names RoR2's developer
 * and `shatterspleen` is a verbatim RoR2 item name — so the display rename left
 * the actual infringement in the file. This is the migration that lets them go.
 *
 * A file of its own, holding no more than the table: `Profile` and `Artifacts`
 * both need it and neither may import the item catalogue. `Artifacts`
 * especially — it stores a Command edict without ever validating it against the
 * item table, and pulling in `data/items.js` to translate two strings would put
 * the whole catalogue in a module that has managed without it.
 *
 * Entries are permanent. A save written five years ago is still a save, and the
 * cost of an entry is one property on an object read at boot.
 */
export const RENAMED_ITEM_IDS = {
  'hopoo-feather': 'hollow-plume',
  shatterspleen: 'hoarfrost-band',
};

/**
 * The current id for whatever a save calls it.
 *
 * Unknown ids pass through untouched rather than being dropped: an id this
 * build does not recognise may belong to a newer build, or to content a
 * downstream fork added, and the reader that consumes it already validates
 * against the live table.
 */
export function renameItemId(id) {
  return (typeof id === 'string' && RENAMED_ITEM_IDS[id]) || id;
}
