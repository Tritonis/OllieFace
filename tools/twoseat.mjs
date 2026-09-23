/**
 * `npm run twoseat` -- one command on machine A runs a full two-seat Steam
 * check against machine B and leaves both records in reviews/twoseat/<run-id>/
 * (#242). A manual arm in tools/gates.mjs: it needs two machines and two Steam
 * accounts, so no tier can assume it.
 *
 *   npm run twoseat                       dev launch: both checkouts at the same commit
 *   npm run twoseat -- --preflight-only   only the preflight; exits 0/1 (the #243 wizard's last step)
 *   npm run twoseat -- --launch packed --exe "<A's exe>" --remote-exe "<B's exe>"
 *   options: --allow-dirty (run despite tracked edits; recorded in verdict.json)
 *            --play-s <n> (60)  --cap-s <n> (300)  --quiet  --config <path>
 *
 * Steps: preflight B over SSH -> write B's .twoseat/next-run.json (scp) ->
 * `schtasks /run /tn OllieFace-TwoSeat` (B's interactive session runs
 * tools/twoseat-launch.mjs) -> run A's host seat here -> fetch B's record
 * (scp, polled under a cap) -> judge both -> one verdict line. Exit 1 on any
 * preflight fail, seat fail, or missing record. A missing record is a failure,
 * never a skip.
 *
 * Operator notes
 * - Config: <repo>/.twoseat.local.json (gitignored), written by the setup
 *   wizard in tools/seat-b-setup/:
 *     { "host": "b-pc", "user": "you", "repoPath": "C:\\...\\OllieFace",
 *       "accountBSteamId": "7656119...", "identityFile": "C:\\...\\id_ed25519" }
 *   identityFile is optional (ssh's defaults apply without it).
 * - SSH is the system OpenSSH client with BatchMode=yes and a ConnectTimeout:
 *   key auth must already work, since a password prompt is a failure, not a hang.
 *   B's default OpenSSH shell is assumed to be cmd.exe (the Windows default).
 * - Steam state on either machine is read from the registry,
 *   HKCU\Software\Valve\Steam\ActiveProcess ActiveUser (the 32-bit account id;
 *   0 = not logged in). CAVEAT: over SSH, HKCU is the hive of the SSH login
 *   user. If `user` is not the account that runs Steam on B's desktop, the
 *   check reads the wrong hive and fails as "not logged in" -- SSH in as the
 *   same Windows user that sits at B's desktop.
 * - Dev launch runs `npm run build` then Electron from each checkout; packed
 *   launch compares the SHA-256 of A's --exe with B's --remote-exe first.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from './lib/parse-args.mjs';
import { fwd, makeSsh } from './lib/ssh.mjs';
import { configErrors } from './lib/twoseat-config.mjs';
import { judgeRecord, readRecord, runSeat, seatCommand } from './lib/twoseat-seat.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TASK_NAME = 'OllieFace-TwoSeat';
const STEAM_KEY = 'HKCU\\Software\\Valve\\Steam\\ActiveProcess';
const STEAMID64_BASE = 76561197960265728n;
const WIZARD = 'tools/seat-b-setup/';

// ---------------------------------------------------------------------------
// Config (contract E)

export function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`twoseat: no ${path}.\n  Run the machine-B setup wizard (${WIZARD}) -- it writes this file.`);
  }
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw new Error(`twoseat: ${path} is not valid JSON (${e.message}). Re-run the setup wizard (${WIZARD}).`);
  }
  const bad = configErrors(cfg);
  if (bad.length) throw new Error(`twoseat: ${path} is invalid: ${bad.join('; ')}. Re-run the setup wizard (${WIZARD}).`);
  return cfg;
}

// ---------------------------------------------------------------------------
// Preflight

/** `reg query` output -> SteamID64 string, or null when absent / logged out. */
export function parseActiveUser(stdout) {
  const m = /ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout ?? '');
  if (!m) return null;
  const id = BigInt(`0x${m[1]}`);
  return id === 0n ? null : String(STEAMID64_BASE + id);
}

const q = (s) => `"${s}"`;

export function preflight(cfg, { ssh, exec, launch = 'dev', exe, remoteExe, allowDirty = false }) {
  const checks = [];
  const add = (id, pass, detail, fix) => { checks.push({ id, pass, detail, fix }); return pass; };

  const echo = ssh.ssh('echo twoseat-ok');
  if (!add('reachable', echo.ok && echo.stdout.includes('twoseat-ok'),
    echo.ok ? `${ssh.dest} answered` : `ssh exited ${echo.code}: ${echo.stderr.trim().split('\n').pop()}`,
    `check B is on, sshd is running there, ${ssh.dest} resolves, and key auth works: ssh -o BatchMode=yes ${ssh.dest} echo ok`)) {
    return checks; // nothing else can be asked of a host that does not answer
  }

  if (launch === 'packed') {
    const local = exe && existsSync(exe) ? createHash('sha256').update(readFileSync(exe)).digest('hex').toUpperCase() : null;
    const r = ssh.ssh(`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '${remoteExe}').Hash"`);
    const remote = r.ok ? r.stdout.trim().toUpperCase() : null;
    add('same-build', !!local && !!remote && local === remote,
      `A ${local ?? `(no exe at ${exe})`} / B ${remote ?? `(hash failed, exit ${r.code})`}`,
      'copy the same packed build (npm run desktop:pack) to both machines and pass both paths');
  } else {
    const here = exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const local = here.status === 0 ? String(here.stdout).trim() : null;
    const r = ssh.ssh(`git -C ${q(cfg.repoPath)} rev-parse HEAD`);
    const remote = r.ok ? r.stdout.trim() : null;
    add('same-build', !!local && !!remote && local === remote,
      `A ${local ?? '(git failed)'} / B ${remote ?? `(git failed, exit ${r.code})`}`,
      `on B: cd ${q(cfg.repoPath)} && git fetch && git checkout ${local ?? '<A\'s HEAD>'} (and push A's commits first)`);

    // Same HEAD is not the same build if either tree has tracked edits.
    // Untracked and ignored files (.twoseat/, reviews/twoseat/) do not count.
    const stA = exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' });
    const stB = ssh.ssh(`git -C ${q(cfg.repoPath)} status --porcelain --untracked-files=no`);
    const dirty = (ok, out) => (ok ? String(out ?? '').split(/\r?\n/).map((l) => l.slice(3)).filter(Boolean) : null);
    const dA = dirty(stA.status === 0, stA.stdout), dB = dirty(stB.ok, stB.stdout);
    const parts = [['A', dA], ['B', dB]].map(([side, d]) => (d === null ? `${side} git status failed` : d.length ? `${side} dirty: ${d.join(', ')}` : `${side} clean`));
    const statusOk = dA !== null && dB !== null;
    const clean = statusOk && !dA.length && !dB.length;
    add('clean-trees', clean || (statusOk && allowDirty),
      `${parts.join('; ')}${!clean && statusOk && allowDirty ? ' -- OVERRIDDEN by --allow-dirty' : ''}`,
      'commit or stash the tracked edits on the dirty side (or pass --allow-dirty, which is recorded in the run)');
  }

  const t = ssh.ssh('tasklist /FI "IMAGENAME eq steam.exe" /NH');
  add('steam-running-b', t.ok && /steam\.exe/i.test(t.stdout),
    t.ok ? (/steam\.exe/i.test(t.stdout) ? 'steam.exe is running on B' : 'steam.exe is not running on B') : `tasklist exited ${t.code}`,
    'start Steam on B and log in as account B (the setup wizard can set it to start at logon)');

  const rb = ssh.ssh(`reg query ${STEAM_KEY} /v ActiveUser`);
  const idB = rb.ok ? parseActiveUser(rb.stdout) : null;
  add('account-b', idB === String(cfg.accountBSteamId),
    `B is logged in as ${idB ?? '(nobody readable)'}, config expects ${cfg.accountBSteamId}`,
    `log B's Steam into ${cfg.accountBSteamId}, or correct accountBSteamId via the setup wizard. If Steam IS logged in, SSH may be reading another user's HKCU -- ssh in as the desktop user`);

  const ra = exec('reg', ['query', STEAM_KEY, '/v', 'ActiveUser'], { encoding: 'utf8' });
  const idA = ra.status === 0 ? parseActiveUser(String(ra.stdout)) : null;
  add('accounts-differ', !!idA && !!idB && idA !== idB,
    `A ${idA ?? '(not logged in)'} / B ${idB ?? '(unknown)'}`,
    idA ? 'A and B must be two different Steam accounts: log one of them into the other account' : 'start Steam on A and log in');

  return checks;
}

// ---------------------------------------------------------------------------
// The run

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTwoseat(argv, deps = {}) {
  const {
    exec = spawnSync, runSeatFn = runSeat, sleep = sleepMs, root = ROOT,
    log = console.log, pollMs = 5000, graceS = 120,
  } = deps;
  const args = parseArgs(argv);
  const quiet = !!args.quiet;
  const say = (s) => { if (!quiet) log(s); };
  const launch = args.launch ?? 'dev';
  const playS = Number(args.playS ?? 60);
  const capS = Number(args.capS ?? 300);
  if (launch !== 'dev' && launch !== 'packed') throw new Error('twoseat: --launch must be dev or packed');
  if (launch === 'packed' && (!args.exe || !args.remoteExe)) throw new Error('twoseat: --launch packed needs --exe and --remote-exe');
  if (!(playS > 0) || !(capS > playS)) throw new Error('twoseat: need 0 < --play-s < --cap-s');

  const cfg = loadConfig(args.config ?? join(root, '.twoseat.local.json'));
  const ssh = makeSsh(cfg, { exec });

  const allowDirty = !!args.allowDirty;
  const checks = preflight(cfg, { ssh, exec, launch, exe: args.exe, remoteExe: args.remoteExe, allowDirty });
  const pfOk = checks.every((c) => c.pass);
  for (const c of checks) {
    const line = `  ${c.pass ? 'ok  ' : 'FAIL'} ${c.id.padEnd(16)} ${c.detail}${c.pass ? '' : `\n         fix: ${c.fix}`}`;
    if (!c.pass || !quiet) log(line);
  }
  if (!pfOk || args.preflightOnly) {
    log(`twoseat: ${pfOk ? 'PASS' : 'FAIL'} preflight${args.preflightOnly ? '-only' : ''} -- ${checks.filter((c) => c.pass).length}/${checks.length} checks`);
    return pfOk ? 0 : 1;
  }

  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomBytes(3).toString('hex')}`;
  const outDir = join(root, 'reviews', 'twoseat', runId);
  mkdirSync(outDir, { recursive: true });
  const hostRecord = join(outDir, 'host.json');
  const joinerLocal = join(outDir, 'joiner.json');
  const remoteRecord = `${fwd(cfg.repoPath)}/reviews/twoseat/${runId}/joiner.json`;
  const fail = (why) => { log(`twoseat: FAIL run ${runId} -- ${why}`); return 1; };

  // Contract C: the run file, then the task trigger. Every hop checked.
  const runFile = { runId, seat: 'joiner', record: remoteRecord, playS, capS, launch, ...(launch === 'packed' ? { exe: args.remoteExe } : {}) };
  const localRunFile = join(outDir, 'next-run.json');
  writeFileSync(localRunFile, `${JSON.stringify(runFile, null, 2)}\n`);
  const mk = ssh.ssh(`if not exist ${q(`${cfg.repoPath}\\.twoseat`)} mkdir ${q(`${cfg.repoPath}\\.twoseat`)}`);
  if (!mk.ok) return fail(`could not create .twoseat on B (ssh exited ${mk.code})`);
  const put = ssh.put(localRunFile, `${fwd(cfg.repoPath)}/.twoseat/next-run.json`);
  if (!put.ok) return fail(`could not copy next-run.json to B (scp exited ${put.code}): ${put.stderr.trim()}`);
  const trig = ssh.ssh(`schtasks /run /tn ${TASK_NAME}`);
  if (!trig.ok) return fail(`schtasks /run /tn ${TASK_NAME} exited ${trig.code} -- is the task registered? run the setup wizard (${WIZARD})`);
  const triggeredAt = Date.now();
  say(`twoseat: run ${runId} -- joiner triggered on B, starting host seat here`);

  const hostCmd = seatCommand({ launch, exe: args.exe, repoPath: root, seat: 'host', runId, record: hostRecord, playS, capS, peer: cfg.accountBSteamId });
  const hostRes = await runSeatFn(hostCmd, { cwd: root, capMs: (capS + 60) * 1000 });
  say(`twoseat: host seat ${hostRes.why}`);

  // B's record: polled until a final (non-placeholder) record arrives or the cap.
  const deadline = triggeredAt + (capS + graceS) * 1000;
  let joiner = null;
  for (;;) {
    const got = ssh.get(remoteRecord, joinerLocal);
    joiner = got.ok ? readRecord(joinerLocal) : null;
    if ((joiner && !joiner.aborted) || Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  const host = judgeRecord(readRecord(hostRecord), { seat: 'host', runId });
  const join_ = judgeRecord(joiner, { seat: 'joiner', runId });
  const pass = host.pass && join_.pass && hostRes.code === 0;
  const hostWhy = host.pass && hostRes.code !== 0 ? `host: seat ${hostRes.why}` : host.why;
  writeFileSync(join(outDir, 'verdict.json'), `${JSON.stringify({ runId, pass, allowDirty, preflight: checks, host: hostWhy, joiner: join_.why }, null, 2)}\n`);
  log(`twoseat: ${pass ? 'PASS' : 'FAIL'} run ${runId} -- ${hostWhy}; ${join_.why} (reviews/twoseat/${runId}/)`);
  return pass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runTwoseat(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
