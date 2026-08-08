/**
 * Corruption tuning. One number drives the run's second economy: corruption is
 * the price tag on greed, and the player always chose it (see
 * docs/superpowers/specs/2026-08-07-hungry-void-launch-design.md).
 *
 * Every value here is a playtest dial, not a law. The Phase-1 gate is "does
 * 'should we open that chest' become a real decision" — tune toward that.
 */

/** World-corruption thresholds. A band is entered at `at` and holds until the next. */
export const BANDS = [
  { id: 0, name: 'Pristine', at: 0 },
  { id: 1, name: 'Seeded', at: 20 },
  { id: 2, name: 'Blighted', at: 55 },
  { id: 3, name: 'Overrun', at: 110 },
  { id: 4, name: 'Consumed', at: 190 },
];

export const SOURCES = {
  // Paid chest opens: gold price unchanged, plus this tithe.
  chestTithe: { small: 2, large: 5, legendary: 12 },
  // Forced opens with no gold: the void extends credit, at a steep multiple.
  voidCredit: { small: 10, large: 22, legendary: 45 },
  // Per item that lands in an inventory, by tier. Unknown tiers fall back to 1.
  itemFeed: { common: 1, uncommon: 2, legendary: 5, boss: 5, lunar: 8, blight: 8, equipment: 2 },
  // Feeds after the teleporter event completes are multiplied by this.
  greedMult: 2.0,
};

export function bandOf(world) {
  let band = 0;
  for (let i = 0; i < BANDS.length; i++) if (world >= BANDS[i].at) band = i;
  return band;
}
