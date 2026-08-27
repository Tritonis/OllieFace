/**
 * Interim fix for issue #239: the balance matrix (`tools/balance-matrix.mjs`)
 * cannot yet see the alignment axis it varies — pure/mixed/corrupt cells come
 * back byte-identical on every measured metric in the 10s stage-0 smoke
 * window. Until the harness can discriminate, this check makes that fact
 * explicit and computed, rather than trusting the matrix to speak for
 * itself.
 *
 * Split into its own module (not left inline in `balance-matrix.mjs`) so it
 * can be imported and unit-tested without pulling in that file's top-level
 * side effects (it boots a Vite server and launches a browser at import
 * time — importing it from a test would do both).
 */

/**
 * Fields a cell measures as an *outcome* of the alignment recipe it
 * committed — everything that should move if the alignment axis actually
 * discriminates. Excludes the intent inputs (`survivor`, `path`) and every
 * steered field: `alignment.achieved`/`alignment.matchesIntent` (true by
 * construction whenever `ok` is true), and `alignment.corrupt`/`pure`/
 * `mixed`/`pureCapstone`/`corruptCapstone` — all five are read straight off
 * `ctx.corruption.ledger`/`.pureCapstone`/`.corruptCapstone`
 * (`src/systems/Corruption.js:261-262`), which the harness itself just
 * filled by committing that path's fixed `RECIPES` entry
 * (`balance-matrix.mjs:132-136`). Those always differ across the triple by
 * construction — a pure cell commits `sanctuary`/`consecration`/etc, a
 * corrupt cell commits disjoint sources — so including them would report
 * `discriminates:true` even when every *combat/world* outcome is
 * byte-identical, which is exactly the scenario #239 describes. Comparing
 * them would always show "difference" without proving the harness measured
 * anything.
 */
export const DISCRIMINATION_FIELDS = [
  'corruption.peakWorld', 'corruption.marksInHand', 'corruption.motesInHand', 'corruption.warded',
  'combat.kills', 'combat.damageToEnemies', 'combat.damageToPlayer', 'combat.dps',
  'combat.crits', 'combat.damageEvents',
  'survivorState.level', 'survivorState.maxHealth', 'survivorState.healthRestored', 'survivorState.alive',
];

function getPath(obj, path) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
}

/**
 * Groups `cells` by survivor and checks whether, per survivor, every
 * measured (non-steered) metric is byte-identical across its pure/mixed/
 * corrupt triple. Returns per-survivor detail plus an overall verdict; pure
 * function over plain cell objects (each `{ survivor, path, alignment,
 * corruption, combat, survivorState, ... }`), no browser/page dependency,
 * so it is testable directly against synthetic data.
 *
 * `paths` defaults to the matrix's three alignment paths but is accepted as
 * a parameter so tests don't need to import the harness's PATHS constant.
 *
 * Filters out `ok === false` cells first: a hard-failed cell carries no
 * combat/corruption/survivorState, so `getPath` reads undefined for every
 * field on it, which would score its survivor `identical:false` and flip
 * the whole matrix's `discriminates` on an otherwise byte-identical run —
 * a gate failure masquerading as evidence the axis discriminates. The
 * filter lives here, not at the call site, so the production call
 * (`balance-matrix.mjs`, unfiltered) and this function's own unit tests
 * exercise the identical code path. A cell with no `ok` field at all
 * counts as ok, so synthetic test fixtures that omit it keep working.
 */
export function checkAlignmentDiscrimination(cells, paths = ['pure', 'mixed', 'corrupt']) {
  const bySurvivor = new Map();
  for (const c of cells) {
    if (c.ok === false) continue;
    if (!bySurvivor.has(c.survivor)) bySurvivor.set(c.survivor, {});
    bySurvivor.get(c.survivor)[c.path] = c;
  }

  const survivors = [];
  let anyDiscriminates = false;
  for (const [survivor, byPath] of bySurvivor) {
    const triple = paths.map((p) => byPath[p]).filter(Boolean);
    let identical = true;
    if (triple.length >= 2) {
      const [first, ...rest] = triple;
      outer:
      for (const field of DISCRIMINATION_FIELDS) {
        const baseline = JSON.stringify(getPath(first, field));
        for (const other of rest) {
          if (JSON.stringify(getPath(other, field)) !== baseline) { identical = false; break outer; }
        }
      }
    }
    if (!identical) anyDiscriminates = true;
    survivors.push({ survivor, identical });
  }

  const identicalSurvivors = survivors.filter((s) => s.identical).map((s) => s.survivor);
  const discriminates = anyDiscriminates;
  const result = { discriminates, survivors };
  if (!discriminates) {
    result.caveat = 'alignment axis not yet discriminating: measured outcomes identical across '
      + 'pure/mixed/corrupt; do not read this matrix as evidence of alignment balance';
  } else if (identicalSurvivors.length) {
    result.caveat = 'alignment axis partially discriminating: identical measured outcomes across '
      + `pure/mixed/corrupt for ${identicalSurvivors.join(', ')}; treat those survivors' rows with caution`;
  }
  return result;
}
