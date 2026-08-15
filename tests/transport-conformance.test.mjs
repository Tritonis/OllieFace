/**
 * Arm A of `docs/adr/0002-networking-coverage-after-webrtc.md`: the transport
 * conformance suite, run against the transport this build ships.
 *
 *   node tests/transport-conformance.test.mjs
 *
 * The assertions live in `tests/transport-contract.mjs` and know nothing about
 * WebRTC. This file supplies the arm. When the Steam transport lands (#55) it
 * gets a second adapter and a second line below — and if any assertion has to be
 * edited to make that pass, the contract was not portable and that is the news.
 *
 * **This suite passing against WebRTC is the precondition for #56**, the
 * deletion of the WebRTC era. Deleting the old coverage and introducing its
 * replacement in one commit puts the parachute and the altimeter in the same
 * place.
 */
import { runTransportContract } from './transport-contract.mjs';
import { loopbackAdapter } from './transport-loopback.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

runTransportContract(loopbackAdapter, ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
