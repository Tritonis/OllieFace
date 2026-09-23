// A stand-in for the #241 seat that obeys contract A/B exactly, for
// tests/twoseat.test.mjs. Behaviour per seat from TWOSEAT_STUB_HOST /
// TWOSEAT_STUB_JOINER: pass | fail (allPass=false, checks green) | check-fail | norecord | placeholder | missing-check.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { REQUIRED_CHECKS } from '../tools/lib/twoseat-seat.mjs';

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i < 0 ? undefined : argv[i + 1]; };
const seat = (argv.find((a) => a.startsWith('--twoseat=')) ?? '').slice('--twoseat='.length);

// Flags without the env var: ignored, the app behaves as for a player.
if (process.env.OLLIE_TWOSEAT !== '1' || !seat) process.exit(0);

const runId = val('--twoseat-run-id');
const record = val('--twoseat-record');
const mode = process.env[`TWOSEAT_STUB_${seat.toUpperCase()}`] ?? 'pass';
if (mode === 'norecord') process.exit(1);

mkdirSync(dirname(record), { recursive: true });
const write = (o) => writeFileSync(record, JSON.stringify(o, null, 2));
write({ schema: 'twoseat/1', runId, seat, aborted: 'run in progress', checks: [], allPass: false });
if (mode === 'placeholder') process.exit(1);

let ids = REQUIRED_CHECKS[seat];
if (mode === 'missing-check') ids = ids.slice(1);
const checks = ids.map((id) => ({ id, pass: mode !== 'check-fail' || id !== 'play-window', detail: 'stub' }));
const allPass = mode !== 'fail' && mode !== 'check-fail'; // missing-check lies: allPass true, so A's own judge must catch it
write({
  schema: 'twoseat/1', runId, seat, appId: 480, steamId: '76561197960265729', peerSteamId: val('--twoseat-peer') ?? null,
  when: new Date().toISOString(), flags: argv, bounded: { capS: Number(val('--twoseat-cap-s')), playS: Number(val('--twoseat-play-s')) },
  checks, fatal: null, allPass,
});
process.exit(allPass ? 0 : 1);
