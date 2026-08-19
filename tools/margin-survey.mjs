/**
 * Margin survey (issue #114).
 *
 * Reads a capture manifest already on disk and prints, for every graded
 * separation measurement in it, how much headroom the shot has against its
 * own threshold — cheaply, without a capture run. A "graded measurement" is
 * a `kind: 'pixels'` check that carries a separation threshold: either the
 * crowd/object-set pair (`worstGatedSep` vs `marginPerSep`) or the
 * single-subject pair (`sepP50` vs `marginSep`). A pixels check gated on
 * `carriedPx` alone (VFX aggregates like "the blast") carries no separation
 * threshold and is not a graded measurement here.
 *
 * A measurement whose keys match neither known pair is never dropped: it is
 * printed as UNRECOGNISED with its keys, so a shape this script doesn't know
 * about is visible rather than silently absent from the table.
 *
 *   node tools/margin-survey.mjs <manifest.json>
 */
import { readFile } from 'node:fs/promises';

export function surveyManifest(manifest) {
  const rows = [];
  const skipped = [];
  for (const shot of manifest.shots ?? []) {
    if (shot.skipped) {
      skipped.push({ name: shot.name, skipped: shot.skipped, why: shot.why });
      continue;
    }
    for (const c of shot.subject?.checks ?? []) {
      if (c.kind !== 'pixels') continue;
      // A check can carry BOTH gates at once: the sepP50 >= marginSep gate is
      // set unconditionally for every non-minCarriedPx subject (Harness.js
      // :2594-2609), and worstGatedSep/marginPerSep is set in addition
      // whenever the subject is per-object (:2717-2725). Both independently
      // gate marginOk, so both are surveyed as their own row here — this is
      // not an either/or. Collapsing it to one silently drops whichever gate
      // is checked second, which in a manifest where the two statistics
      // invert would drop the row holding the true floor.
      let matched = false;
      if ('worstGatedSep' in c && 'marginPerSep' in c) {
        matched = true;
        rows.push({
          shot: shot.name, subject: c.subject,
          statName: 'worstGatedSep', stat: c.worstGatedSep,
          thresholdName: 'marginPerSep', threshold: c.marginPerSep,
          headroom: c.worstGatedSep - c.marginPerSep,
        });
      }
      if ('sepP50' in c && 'marginSep' in c) {
        matched = true;
        rows.push({
          shot: shot.name, subject: c.subject,
          statName: 'sepP50', stat: c.sepP50,
          thresholdName: 'marginSep', threshold: c.marginSep,
          headroom: c.sepP50 - c.marginSep,
        });
      }
      if (matched) continue;
      if ('sepP50' in c) {
        // Has a separation statistic but no threshold paired with it (e.g.
        // VFX aggregates gated on carriedPx instead) — not a graded
        // measurement, and not unrecognised either; just not in scope here.
        continue;
      }
      rows.push({
        shot: shot.name, subject: c.subject,
        unrecognised: true, keys: Object.keys(c),
      });
    }
  }
  rows.sort((a, b) => {
    const ha = a.unrecognised ? -Infinity : a.headroom;
    const hb = b.unrecognised ? -Infinity : b.headroom;
    return ha - hb;
  });
  return { rows, skipped };
}

function formatRow(r) {
  if (r.unrecognised) {
    return `${r.shot} — ${r.subject} — UNRECOGNISED — keys=[${r.keys.join(', ')}]`;
  }
  return `${r.shot} — ${r.subject} — ${r.statName}=${r.stat} — `
    + `${r.thresholdName}=${r.threshold} — headroom=${r.headroom.toFixed(4)}`;
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('usage: node tools/margin-survey.mjs <manifest.json>');
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { rows, skipped } = surveyManifest(manifest);
  for (const r of rows) console.log(formatRow(r));
  for (const s of skipped) console.log(`${s.name} — SKIPPED (${s.skipped}): ${s.why}`);
  console.log(`\n${rows.length} graded measurements, ${skipped.length} skipped shots`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
