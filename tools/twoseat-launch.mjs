/**
 * Machine B's half of `npm run twoseat` (#242, contract C). Not run by hand:
 * the OllieFace-TwoSeat scheduled task (registered by tools/seat-b-setup/,
 * #243) runs it inside B's interactive desktop session, because Steam and
 * Electron do not work from the non-interactive SSH session that triggers it.
 *
 * It reads <repo>/.twoseat/next-run.json (written over scp by A), spawns the
 * joiner seat with the contract-A flags and OLLIE_TWOSEAT=1, waits for it
 * under a hard cap, and exits with the seat's code.  It renames the run file to
 * last-run.json before spawning, so a second trigger of the task finds nothing
 * to replay and exits 1. It writes no record of its
 * own: the seat does, and A treats a missing record as a failure.
 */
import { dirname, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSeat, seatCommand } from './lib/twoseat-seat.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readRunFile(path) {
  const run = JSON.parse(readFileSync(path, 'utf8'));
  const bad = [];
  if (typeof run.runId !== 'string' || !/^[\w.-]+$/.test(run.runId)) bad.push('runId');
  if (run.seat !== 'joiner') bad.push('seat (must be joiner)');
  if (typeof run.record !== 'string' || !isAbsolute(run.record)) bad.push('record (absolute path)');
  if (!(run.playS > 0)) bad.push('playS');
  if (!(run.capS > 0)) bad.push('capS');
  if (run.launch !== 'dev' && run.launch !== 'packed') bad.push('launch');
  if (run.launch === 'packed' && typeof run.exe !== 'string') bad.push('exe');
  if (bad.length) throw new Error(`twoseat-launch: ${path} is malformed: ${bad.join(', ')}`);
  return run;
}

export async function main({ runFile = join(repo, '.twoseat', 'next-run.json'), spawnFn, buildFn } = {}) {
  if (!existsSync(runFile)) {
    throw new Error(`twoseat-launch: no ${runFile} -- nothing to run. It is written by 'npm run twoseat' on machine A immediately before it triggers this task; a second run of the task finds it already consumed.`);
  }
  const run = readRunFile(runFile);
  // Consume it before spawning, so a second trigger can never replay this run.
  renameSync(runFile, join(dirname(runFile), 'last-run.json'));
  mkdirSync(dirname(run.record), { recursive: true });
  const cmd = seatCommand({ ...run, repoPath: repo });
  const res = await runSeat(cmd, { cwd: repo, capMs: (run.capS + 60) * 1000, spawnFn, buildFn });
  console.log(`twoseat-launch: joiner ${run.runId} ${res.why}`);
  return res.code === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
