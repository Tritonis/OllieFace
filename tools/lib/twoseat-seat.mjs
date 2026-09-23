/**
 * The two-seat seat: how either machine starts one (contract A) and how its
 * record is judged (contract B). Shared by tools/twoseat.mjs (A's host seat,
 * and the verdict on both records) and tools/twoseat-launch.mjs (B's joiner).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRED_CHECKS = Object.freeze({
  host: ['friends-listed', 'lobby-created', 'invite-sent', 'peer-joined', 'conversation-formed', 'play-window'],
  joiner: ['invite-heard', 'lobby-joined', 'conversation-formed', 'play-window'],
});

/** Contract A: the flags every seat gets, plus the env var that arms them. */
export function seatFlags({ seat, runId, record, playS, capS, peer }) {
  const flags = [
    `--twoseat=${seat}`,
    '--twoseat-run-id', runId,
    '--twoseat-record', record,
    '--twoseat-play-s', String(playS),
    '--twoseat-cap-s', String(capS),
  ];
  if (seat === 'host') flags.push('--twoseat-peer', peer);
  return flags;
}

/**
 * `{ cmd, args, build }`: dev launches Electron from the checkout (after the
 * same `npm run build` that `npm run desktop` does first); packed launches the exe.
 */
export function seatCommand({ launch, exe, repoPath, ...rest }) {
  const flags = seatFlags(rest);
  if (launch === 'packed') {
    if (!exe) throw new Error('twoseat: a packed launch needs the exe path');
    return { cmd: exe, args: flags, build: false };
  }
  if (launch !== 'dev') throw new Error(`twoseat: launch must be dev|packed, got ${JSON.stringify(launch)}`);
  return { cmd: process.execPath, args: [join(repoPath, 'node_modules', 'electron', 'cli.js'), '.', ...flags], build: true };
}

/**
 * Runs a seat to completion under a hard cap. Resolves the exit code, or
 * null if it had to be killed (a seat past its own cap is a failure too).
 */
export function runSeat({ cmd, args, build }, { cwd, capMs, spawnFn = spawn, buildFn = defaultBuild }) {
  if (build) {
    const code = buildFn(cwd);
    if (code !== 0) return Promise.resolve({ code: null, why: `npm run build exited ${code}` });
  }
  return new Promise((resolve) => {
    const child = spawnFn(cmd, args, { cwd, env: { ...process.env, OLLIE_TWOSEAT: '1' }, stdio: 'inherit', windowsHide: false });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, why: `killed at the ${capMs / 1000}s outer cap` }); }, capMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, why: `spawn failed: ${e.message}` }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, why: `exited ${code}` }); });
  });
}

function defaultBuild(cwd) {
  const r = spawnSync('npm', ['run', 'build'], { cwd, stdio: 'inherit', shell: true });
  return r.status;
}

export function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The verdict on one record, independent of the seat's own allPass: a missing
 * record, a placeholder, a wrong run id or seat, or a missing required check
 * each fail here even if the seat claimed success.
 */
export function judgeRecord(rec, { seat, runId }) {
  if (!rec) return { pass: false, why: `${seat}: record missing` };
  if (rec.schema !== 'twoseat/1') return { pass: false, why: `${seat}: schema ${JSON.stringify(rec.schema)} is not twoseat/1` };
  if (rec.aborted) return { pass: false, why: `${seat}: placeholder only (${rec.aborted}) -- the seat never finished` };
  if (rec.runId !== runId) return { pass: false, why: `${seat}: record is for run ${rec.runId}, not ${runId} (stale)` };
  if (rec.seat !== seat) return { pass: false, why: `${seat}: record says seat ${rec.seat}` };
  const checks = Array.isArray(rec.checks) ? rec.checks : [];
  const missing = REQUIRED_CHECKS[seat].filter((id) => !checks.some((c) => c.id === id));
  if (missing.length) return { pass: false, why: `${seat}: required checks missing: ${missing.join(', ')}` };
  const failed = checks.filter((c) => c.pass !== true).map((c) => c.id);
  if (failed.length) return { pass: false, why: `${seat}: failed ${failed.join(', ')}${rec.fatal ? ` (fatal: ${rec.fatal})` : ''}` };
  if (rec.allPass !== true) return { pass: false, why: `${seat}: allPass=${rec.allPass}${rec.fatal ? ` (fatal: ${rec.fatal})` : ''}` };
  return { pass: true, why: `${seat}: ${checks.length} checks pass` };
}
