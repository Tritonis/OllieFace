// tests/charge-time-pin.test.mjs
//
// #165: CHARGE_TIME was dropped 45 -> 5 as a dev convenience and nearly rode
// out in a build. A 5-second charge deletes the boss fight as content — the
// boss spawns on charge start and the teleporter ring is the timer on the
// fight. CHARGE_TIME is a private module constant, not an export, so this pin
// reads the source the way audio-gate-window.test.mjs does and holds it to the
// shipping value. A deliberate rebalance edits this file in the same commit; a
// dev tweak does not.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const SHIPPING_CHARGE_TIME = 45;

/** Anchored on the declaration, not a bare number elsewhere in the file. */
const chargeTimeIn = (src) => {
  const m = src.match(/\bconst CHARGE_TIME = (-?[\d.]+)\s*;/);
  return m ? Number(m[1]) : null;
};

console.log('charge-time pin (#165)');

const progressionSrc = readFileSync(join(root, 'src/systems/Progression.js'), 'utf8');
const shipped = chargeTimeIn(progressionSrc);
ok(shipped !== null, 'CHARGE_TIME declaration found in Progression.js');
ok(shipped === SHIPPING_CHARGE_TIME, `CHARGE_TIME is ${SHIPPING_CHARGE_TIME} (found ${shipped})`);

// The check must be able to fail: feed it the dev value that motivated #165.
const devTweaked = 'const CHARGE_TIME = 5;       // DEV ONLY';
ok(chargeTimeIn(devTweaked) === 5, 'extractor reads the dev-tweaked value');
ok(chargeTimeIn(devTweaked) !== SHIPPING_CHARGE_TIME, 'pin rejects the 45 -> 5 dev tweak');

console.log(`charge-time pin: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
