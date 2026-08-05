/**
 * The N-1 gate, as something that can fail.
 *
 *   node reviews/round8/n1-gate.mjs                       # the committed evidence set
 *   node reviews/round8/n1-gate.mjs <capture.json> [...]  # named captures
 *
 * `probe-targeting.mjs` measures whether an enemy in a real co-op session ever
 * attacks anyone but the host, and its docblock and `README.md` both call the
 * "15% share" a *gate*. It was not one. The probe computed `directedShare`,
 * serialised it, and never compared it to anything; every non-zero exit in that
 * file is about session health — bad arguments, a page that stopped ticking, a
 * join that failed, a roster with the wrong number of members. The branch
 * proved the hole itself: the sabotage arm locked every enemy onto the host,
 * recorded `directedShare: 0` for the pawn and 336 of 336 census rows on the
 * host, and **exited 0 into the normal output path**. The instrument that
 * measures the headline defect of seven review rounds returned success while
 * the headline defect was fully present, and its actual verdict was a human
 * reading a markdown table.
 *
 * This file is that verdict, executable. It reads committed captures — it does
 * not run a session — so it is cheap enough to run on any tree, and it can be
 * pointed at the sabotage capture to prove it fails. A gate that has never been
 * failed on purpose is not a gate.
 *
 * `probe-targeting.mjs` imports `checkCapture` and applies it to its own output
 * before exiting, so a live arm now fails here too.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const N1_DIR = join('reviews', 'round8', 'n1');

/**
 * The share of directed hits below which a player is not in the fight.
 *
 * Two players parked 3 m apart with identical fixtures split directed hits
 * 54/46 in `2p-lag0`; the defect this branch closed reads 100/0. A floor of
 * 0.15 sits an order of magnitude away from both. Lower (0.02) and the gate
 * stops distinguishing "barely targeted" from "never targeted" — `4p-lag60`
 * has a real pawn at 0.012, so a floor near there would pass an arm in which
 * a player was functionally absent. Higher (0.35) and it starts failing on
 * ordinary run-to-run spread: this probe cannot pin the clock, so a healthy
 * two-player arm legitimately lands anywhere in roughly 0.40-0.60 and one
 * unlucky elite sitting on the host would trip it.
 */
export const DIRECTED_SHARE_FLOOR = 0.15;

/**
 * Arms the share floor applies to.
 *
 * Two-player only, and deliberately. `README.md:270-281` records that in
 * `4p-lag60` one pawn took 2 of 169 directed hits because the pack sits where
 * the Director spawned it — a Director/encounter question, not an identity
 * defect. Reading the 15% floor into the four-player arms after seeing that
 * result would be moving the gate to fit the data. The zero-census check below
 * still applies to every arm: "no enemy ever held this player, in any sample"
 * is the defect itself, at any player count.
 */
const SHARE_GATED_PLAYERS = 2;

/**
 * Check one capture. Returns `{ players, checked, violations }`.
 *
 * `violations` is empty when the arm passes. Nothing here reads anything the
 * probe did not derive from `raw.damage` and `raw.samples`, so a reader who
 * distrusts the verdict can recompute it from the same file.
 */
export function checkCapture(capture, label = '<capture>') {
  const violations = [];
  const players = capture?.arm?.players ?? null;
  const perPlayer = capture?.derived?.perPlayer ?? null;

  if (!perPlayer) {
    // A capture with no derived block is a `.FAILED.json` or a truncated run.
    // It is not a pass: the arm never produced the numbers the gate is about.
    violations.push({
      check: 'capture', label,
      why: 'no derived.perPlayer block — the arm never produced targeting numbers',
    });
    return { players, checked: 0, violations };
  }

  const keys = Object.keys(perPlayer);
  let checked = 0;

  // The census below can only speak about players the file contains, so a
  // capture missing one passed with fewer checks and no complaint — and "the
  // player is not in the file at all" is a stronger form of this gate's own
  // defect than "nobody targets them". On the live probe path the
  // `rosterCheck.rosterCount !== players` clause catches it first, but standalone
  // replay of a committed capture is what this file is for, and there nothing did.
  checked++;
  if (typeof players === 'number' && keys.length !== players) {
    violations.push({
      check: 'roster-census', label,
      why: `derived.perPlayer holds ${keys.length} player(s) but the arm ran ${players} — `
        + 'a player absent from the capture cannot be checked at all',
    });
  }

  for (const k of keys) {
    const p = perPlayer[k];

    // Zero census: over every enemy in every sample of the window, not one ever
    // held this player as its target. This is the defect verbatim, and it is
    // gated at every player count.
    checked++;
    if (!(p.enemiesTargetingMax > 0)) {
      violations.push({
        check: 'zero-census', label, player: k,
        why: `no enemy ever held ${k} as its target in any sample (enemiesTargetingMax ${p.enemiesTargetingMax})`,
      });
    }

    if (players === SHARE_GATED_PLAYERS) {
      checked++;
      const share = p.directedShare;
      if (typeof share !== 'number' || share < DIRECTED_SHARE_FLOOR) {
        violations.push({
          check: 'directed-share', label, player: k,
          why: `${k} took ${p.directedHits} of ${capture.derived.totalDirectedHits} directed hits `
            + `(share ${share}), under the ${DIRECTED_SHARE_FLOOR} floor`,
        });
      }
    }
  }

  return { players, checked, violations };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

// `pathToFileURL` and not a hand-built `file://` string: on Windows the drive
// letter needs `file:///C:/...`, and the naive form silently never matches, so
// the CLI would exit 0 having run no checks at all — the exact failure this
// file exists to stop.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let paths = process.argv.slice(2);

  if (paths.length === 0) {
    // The committed evidence set. `scratch-*` is the branch's own name for an
    // experiment rather than evidence — one of them is the deliberately
    // sabotaged control, which must fail — and `*.FAILED*` arms already failed
    // their health gate and are kept as diagnostics. Both are still checkable
    // by naming them on the command line, which is exactly how this gate gets
    // failed on purpose.
    paths = readdirSync(N1_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('scratch-') && !f.includes('.FAILED'))
      .map((f) => join(N1_DIR, f));
    if (paths.length === 0) {
      console.error(`no captures found in ${N1_DIR}`);
      process.exit(2);
    }
  }

  let violations = 0;
  let checks = 0;
  for (const path of paths) {
    let capture;
    try {
      capture = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      console.log(`FAIL  ${path} — unreadable: ${e.message}`);
      violations++;
      continue;
    }
    const r = checkCapture(capture, path);
    checks += r.checked;
    if (r.violations.length === 0) {
      console.log(`ok    ${path} — ${r.players}p, ${r.checked} checks`);
    } else {
      violations += r.violations.length;
      console.log(`FAIL  ${path} — ${r.players}p`);
      for (const v of r.violations) console.log(`        [${v.check}] ${v.why}`);
    }
  }

  console.log(`\n${checks} checks over ${paths.length} capture(s), ${violations} violation(s)`);
  if (violations) {
    console.error('N-1 GATE FAILED — an enemy population that never attacks a guest is the defect this branch exists to close.');
  }
  process.exit(violations ? 1 : 0);
}
