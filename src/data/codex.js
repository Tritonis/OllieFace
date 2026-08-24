/**
 * The corruption codex — the logbook's Corruption page.
 *
 * Everything a player knows about the second economy is currently inferred in
 * the moment: the gauge moves, a stack turns, a door opens, and none of it is
 * ever written down. This is where it gets written down — but only *after* the
 * run has taught it. Five entries, each one authored against a moment the
 * player has already lived through, so the page fills in as a record of their
 * own run rather than opening as a tutorial wall on a mechanic they have not
 * met (issue #34, reviews/project-state-audit-2026-08-13.md P0 item 2).
 *
 * ## Why the copy lives here and the numbers do not
 *
 * Every number an entry quotes is read live off `data/corruption.js` and
 * `data/realms.js` at render time, exactly as `BESTIARY_LORE` quotes a
 * monster's health off its card. A tuning pass that moves the Blighted
 * threshold from 55 to 70 must not leave a paragraph here claiming 55 — and
 * the only way to guarantee that is to never write the number down.
 *
 * The exception is `facts`: what a *particular* moment was worth. The band the
 * player's first font press bought back, and what it cost, are not derivable
 * from the tuning table — they are history, and the profile stores them beside
 * the unlock (`Profile.noteCodex`). An entry renders whatever facts it was
 * given and falls back to the general shape when there are none, so a codex
 * carried forward from a build that recorded fewer of them still reads.
 *
 * A data module, so it may not import a system (CONTRACTS.md). It imports three
 * other data modules and nothing else. `bandBoons.js` is the purity purse's
 * table — the mote price, the sanctuary window and the reliquary's rung — and it
 * is imported for the same reason the tuning table is: The Argent Font quotes
 * all three and none of them may be typed into the copy.
 */

import {
  BANDS, SOURCES, VOIDTOUCHED, MUTATION, CLEANSE, PRESSURE, bandOf,
} from './corruption.js';
import { MOTE, RELIQUARY } from './bandBoons.js';
import { FINALE_ROUTES, FINALE_STAGE } from './realms.js';

/** The displayed stage number the finale briefing is written at. */
export const ROUTE_BRIEF_STAGE = 4;

const bandName = (i) => BANDS[Math.max(0, Math.min(BANDS.length - 1, i | 0))].name;
const n = (v, fallback = null) => (Number.isFinite(v) ? v : fallback);
const round = (v) => Math.round(v);

/**
 * The entries, in the order a run teaches them.
 *
 * `hint` is what the page says while the entry is still sealed. It names the
 * moment rather than the mechanic on purpose: "the first time you feed it" is
 * an instruction to go and play, whereas "corruption rises when you take loot"
 * would be the tutorial wall this whole feature exists to avoid.
 *
 * `lines` returns paragraphs. Plain strings — the logbook escapes them.
 */
export const CODEX = [
  {
    id: 'first-feed',
    name: 'The Gauge',
    sub: 'The run has a second number',
    hint: 'Recorded the first time the world takes something from you.',
    lines: (f) => {
      const world = n(f.world);
      const band = n(f.band, 0);
      const next = BANDS[band + 1] || null;
      const out = [
        'There is a second number under the run, and it only ever moves because '
        + 'you moved it. Opening a chest, taking an item, standing in the loot after '
        + 'the teleporter has finished — every one of those is a price, and the gauge '
        + 'is the bill. Nothing passive feeds it. Walk away and it does not climb.',
      ];
      if (world !== null) {
        out.push(`It read ${round(world)} when this was written, which is ${bandName(band)}.`);
      }
      out.push(next
        ? `The next threshold is ${next.name}, at ${next.at}. Bands are the whole point of the `
          + 'number: the gauge itself changes nothing, and crossing a line changes several things at once.'
        : 'There is no threshold above this one. The gauge keeps climbing and keeps charging.');
      out.push(`Everything it has bought is already on the bill: every point adds `
        + `${PRESSURE.perWorld} to the Director's coefficient, so the monsters you are `
        + 'about to fight are the ones your looting paid for.');
      return out;
    },
  },
  {
    id: 'seeded',
    name: 'Seeded',
    sub: 'The void starts spending',
    hint: `Recorded when the world first reaches ${BANDS[1].name}.`,
    lines: (f) => {
      const out = [
        `Past ${BANDS[1].at} the void has a budget and begins spending it. What it buys are `
        + 'Hollowed: ordinary monsters surfacing out of the ground you were greedy on, '
        + 'announced by a ring about a second before they arrive.',
        'They are worth almost nothing to kill — a quarter of an elite\'s gold and '
        + 'experience — and that is not the reason to kill them.',
        `The reason is the refund. Every Hollowed kill bleeds ${Math.round(VOIDTOUCHED.refund * 100)}% of the `
        + 'current world corruption straight back off the gauge. It is a fraction, not a '
        + 'flat sum, so it is worth most exactly when you are deepest in the red — a '
        + 'Hollowed killed at 400 pays back more than eleven killed at 30.',
        'This is the only counterplay that pays no gold. The void funds its own undoing '
        + 'and the rate it funds it at is a function of how far in you already are.',
        `And what it pays back it also banks. Every point taken off the gauge by your own `
        + `hand is warded, counted for the rest of the run, and every ${MOTE.per} of it `
        + 'condenses into an argent mote — so the Hollowed are not merely the way down, they '
        + 'are the way the clean line is funded at all.',
      ];
      if (n(f.world) !== null) out.push(`The world stood at ${round(f.world)} when this was written.`);
      return out;
    },
  },
  {
    id: 'blight-toll',
    name: 'The Blight Toll',
    sub: 'What the next band will take',
    hint: `Recorded while the world sits in ${BANDS[1].name} and you are carrying something it wants.`,
    lines: (f) => {
      const eligible = Array.isArray(f.eligible) ? f.eligible : [];
      const out = [
        `${BANDS[1].name} is the warning. ${BANDS[MUTATION.minBand].name} is where the world starts taking.`,
        `From ${BANDS[MUTATION.minBand].name} up, every upward crossing collects a toll from your `
        + 'pack: one held stack, converted whole into its blight counterpart. Not some of the '
        + 'stack — all of it. A threshold is charged once and never re-arms, so spiking into a '
        + 'band and bleeding back down does not buy the toll twice.',
        `You are not simply told which. At the crossing the void names ${MUTATION.choiceOffers} `
        + `of your stacks and gives you ${MUTATION.choiceSeconds} seconds to say which one `
        + 'festers. Say nothing and it chooses — the toll is collected either way, and the only '
        + 'thing hesitation costs you is the say in it.',
        'Not everything is eligible. Only stacks with a blight counterpart can be taken, '
        + 'and a blight card you already hold cannot be taken again.',
      ];
      if (eligible.length) {
        out.push(`You were carrying ${eligible.length} eligible `
          + `stack${eligible.length === 1 ? '' : 's'} when this was written: ${eligible.join(', ')}.`);
      }
      out.push('The counterplay is on both sides of the line. Bleed below the threshold before '
        + 'you cross it and nothing is taken; cross it and an Argent Font can hand one stack back.');
      return out;
    },
  },
  {
    id: 'argent-font',
    name: 'The Argent Font',
    sub: 'What the bleeding is worth',
    hint: 'Recorded the first time you pay one.',
    lines: (f) => {
      const before = n(f.worldBefore);
      const after = n(f.worldAfter);
      const cost = n(f.cost);
      const removed = n(f.removed);
      const out = [];
      if (before !== null && after !== null && cost !== null) {
        const from = bandName(n(f.bandBefore, 0));
        const to = bandName(n(f.bandAfter, 0));
        out.push(`The first press: ${round(before)} down to ${round(after)} — `
          + `${round(removed ?? before - after)} bled — for ${round(cost)} gold. `
          + (from === to ? `${to} held.` : `${from} became ${to}.`));
        out.push(`What that bought is not the number. It is ${round((before - after) * PRESSURE.perWorld * 1000) / 1000} `
          + 'off the Director coefficient for the rest of the run, a smaller war chest for the '
          + 'void to spend on Hollowed, and distance back to the next unpaid blight toll — '
          + `the stack that crossing would have taken is a stack you still have.`);
      } else {
        out.push('A font sells you your own gauge back, and the price is the point.');
      }
      out.push(`One use bleeds ${CLEANSE.fraction * 100}% of the current world, with a floor of `
        + `${CLEANSE.amount}, so a font is worth most when you are worst. A font takes `
        + `${CLEANSE.maxUses} presses and the price climbs ${CLEANSE.costClimb}x per press, `
        + 'per stage, and with the debt being retired — corrupting all run and laundering at '
        + 'the door was never going to be free. A press also hands one blight stack back as '
        + 'its base item.');
      out.push('And then the gold stops being the interesting half. Nothing here rots away on '
        + 'its own: every point that has ever left the gauge left because a hand reached in and '
        + 'took it — this press, a Hollowed put down, a bell rung in consecrated air. The world '
        + 'keeps that tally under the name of warding, and unlike the gauge it never falls. '
        + 'Feeding the void again does not un-do work you already did.');
      out.push(`Every ${MOTE.per} points warded condenses into an argent mote. No chest holds `
        + 'one and no price list sells one; the only way to have a mote is to have gone in and '
        + 'carried something back out. Abstinence mints nothing, because a world you never '
        + 'darkened has nothing to bring back.');
      out.push(`Carry a mote to an altar and it opens a sanctuary: ${MOTE.sanctuarySeconds} `
        + 'seconds in which every chest, every item and every second of greed time is free. '
        + 'Opening a second window replaces the first rather than lengthening it, so the '
        + 'question is never how many — it is when, and greed time is exactly the hour worth '
        + 'waiving.');
      out.push(`Hold ${RELIQUARY.motes} instead and the altar stops offering the window and `
        + 'offers Consecration: one argent card, yours for the rest of the run. Both rungs eat '
        + 'the same purse. Every sanctuary spent is a card not bought, and that is the whole '
        + 'decision the clean line has to make.');
      out.push('Argent is the one tier that keeps reading the gauge after you have it. A card '
        + `pays in full at ${BANDS[0].name} and nothing at all from `
        + `${bandName(bandOf(RELIQUARY.fadeAt))} up, dimming the whole way between. So a font `
        + 'is not only distance from the next toll — it is the strength of everything argent '
        + 'in your pack, bought back point by point.');
      out.push(`From ${BANDS[CLEANSE.guaranteeBand].name} up, every stage places at least one `
        + `font. Staying clean has to be achievable, not merely priced. But go all the way to `
        + `${BANDS[BANDS.length - 1].name} and take what it offers, and the fonts stop `
        + 'answering for good: the clean exit is not priced out of reach, it is gone.');
      return out;
    },
  },
  {
    id: 'finale-route',
    name: 'The Fracture',
    sub: 'Corruption is the router',
    hint: `Recorded on stage ${ROUTE_BRIEF_STAGE}, with the finale in reach.`,
    lines: (f) => {
      const band = n(f.band, 0);
      const out = [
        `From stage ${FINALE_STAGE + 1} a door stands beside the ordinary portal, and which door `
        + 'it is depends on nothing but the gauge. Corruption is not scored at the end of the '
        + 'run; it decides which end of the run you are allowed to walk into.',
      ];
      for (const r of FINALE_ROUTES) {
        const lo = bandName(r.bands.min);
        const hi = bandName(r.bands.max);
        out.push(`${r.name} — ${lo === hi ? lo : `${lo} through ${hi}`}.`);
      }
      out.push(`The middle band sees both and has to commit. Every band matches at least one `
        + 'route: corruption changes which game you are finishing, never whether you finish.');
      if (n(f.world) !== null) {
        out.push(`The world read ${round(f.world)} — ${bandName(band)} — when this was written, `
          + 'and there is a whole stage left in which to move it either way.');
      }
      return out;
    },
  },
];

export const CODEX_BY_ID = new Map(CODEX.map((c) => [c.id, c]));

/** Every codex id, in teaching order. Read by the trigger system and by tests. */
export const CODEX_IDS = CODEX.map((c) => c.id);

/**
 * The per-tier item-feed base rates. Since #176 retired the automatic pickup
 * listener, NO pickup is priced from this table directly — a corrupt claim
 * charges `tierFeed + premiumFor` (see `world/corruptionPrice.js`), which is
 * what a codex entry explaining prices must quote. Exported only as the base
 * component of that sum; do not present it alone as "the price list".
 */
export const FEED_TABLE = SOURCES.itemFeed;
