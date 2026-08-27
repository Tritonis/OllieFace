import { test } from 'node:test';
import assert from 'node:assert/strict';
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
