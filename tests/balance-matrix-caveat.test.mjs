import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkAlignmentDiscrimination } from '../tools/lib/alignment-discrimination.mjs';

function makeCell(survivor, path, overrides = {}) {
  return {
    survivor,
    path,
    ok: true,
    alignment: {
      achieved: path,
      matchesIntent: true,
      corrupt: 0,
      pure: 0,
      mixed: 0,
      pureCapstone: false,
      corruptCapstone: false,
    },
    corruption: { peakWorld: 0, marksInHand: 0, motesInHand: 0, warded: 0 },
    combat: { kills: 5, damageToEnemies: 100, damageToPlayer: 10, dps: 20, crits: 1, damageEvents: 6 },
    survivorState: { level: 3, maxHealth: 100, healthRestored: 0, alive: true },
    ...overrides,
  };
}

test('identical triples across all survivors -> discriminates:false with a caveat', () => {
  const cells = [];
  for (const survivor of ['ranger', 'anvil']) {
    for (const path of ['pure', 'mixed', 'corrupt']) {
      cells.push(makeCell(survivor, path));
    }
  }
  const result = checkAlignmentDiscrimination(cells);
  assert.equal(result.discriminates, false);
  assert.ok(result.caveat && result.caveat.includes('not yet discriminating'));
  assert.ok(result.survivors.every((s) => s.identical));
});

test('one differing measured metric on one survivor -> discriminates:true', () => {
  const cells = [
    makeCell('ranger', 'pure'),
    makeCell('ranger', 'mixed'),
    makeCell('ranger', 'corrupt', { combat: { kills: 5, damageToEnemies: 999, damageToPlayer: 10, dps: 20, crits: 1, damageEvents: 6 } }),
    makeCell('anvil', 'pure'),
    makeCell('anvil', 'mixed'),
    makeCell('anvil', 'corrupt'),
  ];
  const result = checkAlignmentDiscrimination(cells);
  assert.equal(result.discriminates, true);
  assert.equal(result.caveat.includes('anvil'), true);
  const ranger = result.survivors.find((s) => s.survivor === 'ranger');
  const anvil = result.survivors.find((s) => s.survivor === 'anvil');
  assert.equal(ranger.identical, false);
  assert.equal(anvil.identical, true);
});

// Recipe-realistic: RECIPES commits disjoint sources per path, so
// alignment.corrupt/pure/mixed/pureCapstone/corruptCapstone (all read off
// ctx.corruption.ledger — Corruption.js:261-262) always differ across the
// triple by construction, exactly like the real matrix-f4214c3.json below.
// Those fields must NOT drive the verdict — only corruption/combat/
// survivorState (the actual measured outcomes) may.
test('recipe-realistic alignment.* differences with identical measured outcomes -> discriminates:false', () => {
  const cells = [
    makeCell('ranger', 'pure', {
      alignment: { achieved: 'pure', matchesIntent: true, corrupt: 0, pure: 24, mixed: 0, pureCapstone: true, corruptCapstone: false },
    }),
    makeCell('ranger', 'mixed', {
      alignment: { achieved: 'mixed', matchesIntent: true, corrupt: 12, pure: 12, mixed: 24, pureCapstone: false, corruptCapstone: false },
    }),
    makeCell('ranger', 'corrupt', {
      alignment: { achieved: 'corrupt', matchesIntent: true, corrupt: 24, pure: 0, mixed: 0, pureCapstone: false, corruptCapstone: true },
    }),
  ];
  const result = checkAlignmentDiscrimination(cells);
  assert.equal(result.discriminates, false);
  assert.ok(result.caveat && result.caveat.includes('not yet discriminating'));
  assert.equal(result.survivors[0].identical, true);
});

test('demonstration: a blinded check (ignoring all fields) would wrongly report discriminates:false', () => {
  // This mirrors what the check would look like if DISCRIMINATION_FIELDS were
  // emptied out — a regression that would silently always report "identical".
  const blindCheck = () => ({ discriminates: false });
  const cells = [
    makeCell('ranger', 'pure'),
    makeCell('ranger', 'mixed'),
    makeCell('ranger', 'corrupt', { combat: { kills: 5, damageToEnemies: 999, damageToPlayer: 10, dps: 20, crits: 1, damageEvents: 6 } }),
  ];
  const real = checkAlignmentDiscrimination(cells);
  const blind = blindCheck(cells);
  assert.equal(real.discriminates, true);
  assert.equal(blind.discriminates, false);
  assert.notEqual(real.discriminates, blind.discriminates);
});

// Guard against the refuted defect directly: alignment.* fields (steered by
// RECIPES) must never move the verdict on their own.
test('alignment.* differences alone (recipe steering) never flip discriminates', () => {
  const cells = [
    makeCell('ranger', 'pure', { alignment: { achieved: 'pure', matchesIntent: true, corrupt: 0, pure: 24, mixed: 0, pureCapstone: true, corruptCapstone: false } }),
    makeCell('ranger', 'corrupt', { alignment: { achieved: 'corrupt', matchesIntent: true, corrupt: 24, pure: 0, mixed: 0, pureCapstone: false, corruptCapstone: true } }),
  ];
  const result = checkAlignmentDiscrimination(cells);
  assert.equal(result.discriminates, false);
});

const artifactPath = fileURLToPath(new URL('../reviews/balance-matrix/matrix-f4214c3.json', import.meta.url));
test('the real captured artifact (matrix-f4214c3.json), fed through the fixed checker, is discriminates:false', { skip: !existsSync(artifactPath) && 'artifact not present in this worktree' }, () => {
  const matrix = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const result = checkAlignmentDiscrimination(matrix.cells, matrix.paths);
  assert.equal(result.discriminates, false);
  assert.ok(result.caveat && result.caveat.includes('not yet discriminating'));
});
