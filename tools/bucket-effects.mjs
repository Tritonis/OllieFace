/**
 * The audit's §2.1 bucketing rules, re-run over the re-authored surface.
 *
 * `.superpowers/sdd/legible-effects/audit.md` §2.1 defines a Collision
 * mechanically: two effects sharing **all four** of colour family, frame
 * family, motion character and audio envelope family occupy the same point in
 * the Effect Language and are, by construction, indistinguishable by the
 * dimensions that are supposed to separate them. `NONE`/`NONE` counts as a
 * shared audio family — that is the worst kind of match, not an exemption.
 *
 * The colour family is recomputed here from the hex, by the audit's own HSL
 * rules, rather than trusted from the table. That is the point: it means an
 * element hue cannot drift out of its band without this saying so, and it means
 * the check is comparable to the audit's baseline instead of being a new
 * measurement that happens to agree with itself.
 *
 * Usage:
 *   node tools/bucket-effects.mjs          list every collision group
 *   node tools/bucket-effects.mjs --check  exit non-zero if a named group re-forms
 *
 * `--check` is the arm that can fail. It asserts that the five collision groups
 * this wave was written to resolve — C1, C7, C8, C9, C10 — have separated: no
 * two members of a group may still share all four dimensions.
 */

import { allEffects, ELEMENTS } from '../src/data/effects.js';
import { SAMPLES_BY_ID } from '../src/data/samples.js';

// The bucketing rules themselves live in `src/data/colourFamily.js`, so that
// `effects.js`'s load-time `assertLanguage()` can run them over the enemy-side
// tables too without importing a tool (and without a cycle back through this
// file). Re-exported here because the rules are still this tool's subject.
export { familyOf } from '../src/data/colourFamily.js';
import { familyOf } from '../src/data/colourFamily.js';

// -------------------------------------------------------------- the re-run

/** The groups this wave was written to resolve, by their audit names. */
const GROUPS = {
  C1: ['copper-wire', 'cracked-zither', 'arc-capacitor', 'spark-plug',
       'arc-rot', 'quicksilver-vein', 'squall-charm'],
  C7: ['leaking-jerrycan', 'warlock-ember', 'emberwake'],
  C8: ['frostbite-canister', 'aegis-emitter'],
  C9: ['prism-splinter', 'hive-gland', 'mourners-dagger'],
  C10: ['bile-shell', 'missile-rack'],
};

function point(row) {
  const declared = ELEMENTS[row.element].family;
  const measured = familyOf(ELEMENTS[row.element].hue);
  return {
    id: row.id,
    colour: measured,
    drift: measured !== declared ? declared : null,
    frame: row.frame,
    motion: row.motion,
    envelope: row.envelope,
    key: [measured, row.frame, row.motion, row.envelope].join(' · '),
    // The same point with the timbre axis struck out — what is left of an
    // effect when #148's recording is absent. See §4.2's Degraded Point rule.
    degraded: [measured, row.frame, row.motion].join(' · '),
    sampled: SAMPLES_BY_ID.has(row.id),
  };
}

export function buckets() {
  const rows = allEffects().map(point);
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  return { rows, byKey };
}

function main() {
  const check = process.argv.includes('--check');
  const { rows, byKey } = buckets();
  let failed = 0;

  // An element hue that no longer lands in its own §1.1 family is a language
  // defect on its own, before any grouping question.
  for (const r of rows) {
    if (r.drift) {
      console.error(`DRIFT  ${r.id}: hue buckets as ${r.colour}, table declares ${r.drift}`);
      failed++;
    }
  }

  const groups = [...byKey.entries()].filter(([, m]) => m.length > 1);
  console.log(`${rows.length} rows, ${byKey.size} distinct points, ${groups.length} shared points.\n`);
  for (const [key, members] of groups.sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  [${members.length}] ${key}`);
    console.log(`        ${members.map((m) => m.id).join(', ')}`);
  }

  console.log('\nNamed groups:');
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [name, ids] of Object.entries(GROUPS)) {
    const present = ids.map((id) => byId.get(id)).filter(Boolean);
    const seen = new Map();
    const clashes = [];
    for (const r of present) {
      if (seen.has(r.key)) clashes.push(`${seen.get(r.key)} = ${r.id} (${r.key})`);
      else seen.set(r.key, r.id);
    }
    const missing = ids.filter((id) => !byId.has(id));
    if (clashes.length) {
      console.log(`  ${name}: STILL COLLIDING — ${clashes.join('; ')}`);
      failed++;
    } else {
      console.log(`  ${name}: separated — ${present.length}/${ids.length} rows on ${seen.size} distinct points`
        + (missing.length ? ` (not on this surface: ${missing.join(', ')})` : ''));
    }
  }

  // §4.2's Degraded Point rule. A sampled entry whose only separation is its
  // recording has no separation at all in the mode where #148 declines, so the
  // sampled rows are re-bucketed with the timbre axis removed.
  console.log('\nG1 degraded points (sample declined or absent):');
  const degraded = new Map();
  for (const r of rows.filter((x) => x.sampled)) {
    if (degraded.has(r.degraded)) {
      console.log(`  COLLIDING — ${degraded.get(r.degraded)} = ${r.id} (${r.degraded})`);
      failed++;
    } else {
      degraded.set(r.degraded, r.id);
      console.log(`  ${r.id.padEnd(20)} ${r.degraded}`);
    }
  }

  if (check && failed) {
    console.error(`\n${failed} failure(s).`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('bucket-effects.mjs')) main();
