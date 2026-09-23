// tests/twoseat.test.mjs -- `npm run twoseat` (#242) against a fake world.
//
// No sshd, no Steam: `exec` is replaced by a fake runner that plays machine B
// (ssh commands answered from a scripted state, scp as real file copies into a
// temp "B" checkout, schtasks /run as a real run of tools/twoseat-launch.mjs),
// and both seats are tests/twoseat-stub-seat.mjs, which obeys contract A/B.
// Every guard is paired with a negative control that must read RED.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, parseActiveUser, runTwoseat } from '../tools/twoseat.mjs';
import { main as launchMain, readRunFile } from '../tools/twoseat-launch.mjs';
import { makeSsh, resolveSshBins } from '../tools/lib/ssh.mjs';
import { isListening, judgeRecord, runSeat } from '../tools/lib/twoseat-seat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'twoseat-stub-seat.mjs');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const ID_A = '76561197960265729'; // account id 1
const ID_B = '76561197960265730'; // account id 2
const regOut = (hex) => `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\ActiveProcess\r\n    ActiveUser    REG_DWORD    0x${hex}\r\n`;

// Runs the stub instead of Electron / the exe: keeps only the contract-A flags.
const stubSpawn = (_cmd, args, opts) => spawn(process.execPath, [STUB, ...args.slice(args.findIndex((a) => a.startsWith('--twoseat=')))], { ...opts, stdio: 'ignore' });
const stubRunSeat = (cmd, o) => runSeat(cmd, { ...o, spawnFn: stubSpawn, buildFn: () => 0 });

function world(over = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'twoseat-'));
  const a = join(tmp, 'A'), b = join(tmp, 'B');
  mkdirSync(a); mkdirSync(b);
  const cfg = { host: 'b-pc', user: 'ollie', repoPath: b, accountBSteamId: ID_B, ...over.cfg };
  writeFileSync(join(a, '.twoseat.local.json'), JSON.stringify(cfg));
  const s = { headA: 'abc123', headB: 'abc123', regA: '1', regB: '2', steamB: true, unreachable: false, taskOk: true, dirtyA: '', dirtyB: '', ...over };
  const calls = [];
  const strip = (p) => p.replace(/^[^@\s]+@[^:]+:/, '');
  s.typePolls = 0;
  const exec = (binPath, args) => {
    const bin = binPath.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''); // the resolved System32 path plays as ssh/scp
    calls.push([bin, ...args]);
    if (bin === 'ssh' && args[0] === '-V') return { status: 0, stdout: '', stderr: 'OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2\r\n' };
    if (bin === 'git') return args[0] === 'status' ? { status: 0, stdout: s.dirtyA } : { status: 0, stdout: `${s.headA}\n` };
    if (bin === 'reg') return { status: 0, stdout: regOut(s.regA) };
    if (s.unreachable) return { status: 255, stdout: '', stderr: 'ssh: connect to host b-pc port 22: Connection timed out' };
    if (bin === 'scp') {
      const [src, dst] = args.slice(-2).map(strip);
      if (!existsSync(src)) return { status: 1, stdout: '', stderr: `scp: ${src}: No such file or directory` };
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return { status: 0, stdout: '' };
    }
    const cmd = args.at(-1);
    if (cmd === 'echo twoseat-ok') return { status: 0, stdout: 'twoseat-ok\r\n' };
    if (cmd.startsWith('git -C') && cmd.includes(' status ')) return { status: 0, stdout: s.dirtyB };
    if (cmd.startsWith('git -C')) return { status: 0, stdout: `${s.headB}\n` };
    if (cmd.startsWith('tasklist')) return { status: 0, stdout: s.steamB ? 'steam.exe   4242 Console  1  100,000 K\r\n' : 'INFO: No tasks are running which match the specified criteria.\r\n' };
    if (cmd.startsWith('reg query')) return { status: 0, stdout: regOut(s.regB) };
    if (cmd.startsWith('schtasks /query')) {
      if (s.taskMissing) return { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      return { status: 0, stdout: `\r\nTaskName:   \\OllieFace-TwoSeat\r\nTask To Run:   cmd.exe /c "cd /d ${typeof s.taskRepo === 'function' ? s.taskRepo(b) : (s.taskRepo ?? b)} && "C:\\Program Files\\nodejs\\node.exe" tools\\twoseat-launch.mjs"\r\nStart In:   N/A\r\n` };
    }
    if (cmd.startsWith('type ')) {
      // B's joiner record as the readiness poll sees it: listening only from poll readyAfter on.
      s.typePolls++;
      const runId = s.readyRunId ?? /twoseat[\\/]([^\\/]+)[\\/]joiner\.json/.exec(cmd)?.[1];
      const listening = !s.neverReady && s.typePolls >= (s.readyAfter ?? 1);
      return { status: 0, stdout: JSON.stringify({ schema: 'twoseat/1', runId, seat: 'joiner', aborted: 'run in progress', checks: [], allPass: false, ...(listening ? { listening: true, listeningAt: new Date().toISOString() } : {}) }) };
    }
    if (cmd.startsWith('if not exist')) { mkdirSync(join(b, '.twoseat'), { recursive: true }); return { status: 0, stdout: '' }; }
    if (cmd.startsWith('schtasks /run')) {
      if (!s.taskOk) return { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      launchMain({ runFile: join(b, '.twoseat', 'next-run.json'), spawnFn: stubSpawn, buildFn: () => 0 });
      return { status: 0, stdout: 'SUCCESS: Attempted to run the scheduled task "OllieFace-TwoSeat".' };
    }
    return { status: 1, stdout: '', stderr: `fake B: unknown command ${cmd}` };
  };
  return { tmp, a, b, cfg, exec, calls, s };
}

async function drive(w, argv = [], env = {}) {
  process.env.TWOSEAT_STUB_HOST = env.host ?? 'pass';
  process.env.TWOSEAT_STUB_JOINER = env.joiner ?? 'pass';
  const lines = [];
  const code = await runTwoseat(['--play-s', '1', '--cap-s', '2', ...argv], {
    exec: w.exec, runSeatFn: (cmd, o) => { if (cmd.args.includes('--twoseat=host')) w.calls.push(['HOST-START']); return stubRunSeat(cmd, o); },
    root: w.a, log: (l) => lines.push(l), pollMs: 50, graceS: 1, readyPollMs: 10,
  });
  const out = lines.join('\n');
  const verdict = lines.at(-1) ?? '';
  return { code, out, verdict };
}

const cleanup = [];

console.log('green loopback: both stub seats pass, both records land in reviews/twoseat/<run-id>/');
{
  const w = world(); cleanup.push(w.tmp);
  const r = await drive(w);
  ok(r.code === 0, `exit 0 (${r.verdict})`);
  ok(/^twoseat: PASS run \S+ --/.test(r.verdict), 'one PASS verdict line');
  const runId = /run (\S+)/.exec(r.verdict)?.[1];
  const dir = join(w.a, 'reviews', 'twoseat', runId ?? 'none');
  ok(existsSync(join(dir, 'host.json')) && existsSync(join(dir, 'joiner.json')), 'host.json and joiner.json side by side');
  ok(!existsSync(join(w.b, '.twoseat', 'next-run.json')), 'twoseat-launch consumed next-run.json before spawning');
  const nr = readRunFile(join(w.b, '.twoseat', 'last-run.json'));
  let replay = '';
  try { await launchMain({ runFile: join(w.b, '.twoseat', 'next-run.json'), spawnFn: stubSpawn, buildFn: () => 0 }); } catch (e) { replay = e.message; }
  ok(/no .*next-run.json -- nothing to run/.test(replay), 'a second trigger of the task refuses to replay the run');
  ok(nr.runId === runId && nr.seat === 'joiner' && nr.launch === 'dev', 'B\'s next-run.json carries the run (contract C)');
  const sshCalls = w.calls.filter((c) => (c[0] === 'ssh' || c[0] === 'scp') && c[1] !== '-V');
  ok(sshCalls.every((c) => c.includes('BatchMode=yes') && c.some((x) => /^ConnectTimeout=\d+$/.test(x))), 'every ssh/scp hop is BatchMode with a ConnectTimeout');
  ok(w.calls.some((c) => c.at(-1) === 'schtasks /run /tn OllieFace-TwoSeat'), 'the OllieFace-TwoSeat task is triggered');
}

console.log('negative controls: each must read RED');
const red = async (label, over, argv, env, pattern) => {
  const w = world(over); cleanup.push(w.tmp);
  const r = await drive(w, argv, env);
  ok(r.code === 1 && /FAIL/.test(r.verdict) && pattern.test(r.out), `${label} -> exit ${r.code}: ${r.verdict}`);
  return r;
};
{
  const r = await red('unreachable host', { unreachable: true }, [], {}, /FAIL reachable[\s\S]*fix: /);
  ok(!/same-build/.test(r.out), 'an unreachable host asks nothing further of B');
  await red('B logged into the wrong account', { regB: '3' }, [], {}, /FAIL account-b/);
  await red('B logged into A\'s account', { regB: '1', cfg: { accountBSteamId: ID_A } }, [], {}, /FAIL accounts-differ/);
  await red('B not logged in', { regB: '0' }, [], {}, /FAIL account-b/);
  await red('Steam not running on B', { steamB: false }, [], {}, /FAIL steam-running-b/);
  await red('B at a different commit', { headB: 'def456' }, [], {}, /FAIL same-build[\s\S]*git checkout abc123/);
  await red('A has a tracked edit', { dirtyA: ' M src/main.js\n' }, [], {}, /FAIL clean-trees\s+A dirty: src\/main\.js; B clean/);
  await red('B has a tracked edit', { dirtyB: 'M  tools/x.mjs\r\n' }, [], {}, /FAIL clean-trees\s+A clean; B dirty: tools\/x\.mjs/);
  await red('scheduled task missing', { taskOk: false }, [], {}, /schtasks .* exited 1/);
  await red('missing B record (stub exits without writing)', {}, [], { joiner: 'norecord' }, /joiner: record missing/);
  await red('B seat writes allPass=false', {}, [], { joiner: 'fail' }, /joiner: allPass=false/);
  await red('B seat fails a check', {}, [], { joiner: 'check-fail' }, /joiner: failed play-window/);
  await red('host seat leaves only its placeholder', {}, [], { host: 'placeholder' }, /host: placeholder only/);
  await red('host seat omits a required check but claims allPass', {}, [], { host: 'missing-check' }, /host: required checks missing: friends-listed/);
}

console.log('--allow-dirty is an explicit, recorded override');
{
  const w = world({ dirtyB: ' M src/a.js\n' }); cleanup.push(w.tmp);
  const r = await drive(w, ['--allow-dirty']);
  const runId = /run (\S+)/.exec(r.verdict)?.[1];
  const v = JSON.parse(readFileSync(join(w.a, 'reviews', 'twoseat', runId ?? 'none', 'verdict.json'), 'utf8'));
  ok(r.code === 0 && v.allowDirty === true && /B dirty: src\/a\.js -- OVERRIDDEN/.test(v.preflight.find((c) => c.id === 'clean-trees').detail), 'the run proceeds and verdict.json records the override and the dirty files');
}

console.log('--preflight-only');
{
  const w = world(); cleanup.push(w.tmp);
  const r = await drive(w, ['--preflight-only']);
  ok(r.code === 0 && /PASS preflight-only -- 7\/7/.test(r.verdict), `green preflight exits 0 (${r.verdict})`);
  ok(!w.calls.some((c) => /schtasks \/run/.test(c.at(-1))) && !existsSync(join(w.a, 'reviews')), 'it triggers nothing and writes no run');
  await red('preflight-only, account mismatch', { regB: '3' }, ['--preflight-only'], {}, /FAIL account-b[\s\S]*FAIL preflight-only/);
  await red('preflight-only, unreachable', { unreachable: true }, ['--preflight-only'], {}, /FAIL preflight-only -- 0\/1/);
}

console.log('config (contract E)');
{
  let msg = '';
  try { loadConfig(join(tmpdir(), 'no-such-twoseat.json')); } catch (e) { msg = e.message; }
  ok(/^twoseat: no .*\n.*setup wizard \(tools\/seat-b-setup\/\)/.test(msg),'a missing config names the setup wizard');
  const tmp = mkdtempSync(join(tmpdir(), 'twoseat-cfg-')); cleanup.push(tmp);
  const p = join(tmp, 'c.json');
  const good = { host: 'b-pc', user: 'ollie', repoPath: 'C:\\repo', accountBSteamId: ID_B };
  writeFileSync(p, JSON.stringify(good));
  ok(loadConfig(p).host === 'b-pc', 'a well-formed config loads');
  for (const [label, bad] of [
    ['relative repoPath', { repoPath: 'repo' }], ['numeric steam id', { accountBSteamId: 2 }],
    ['short steam id', { accountBSteamId: '7656119' }], ['user@ in user', { user: 'a@b' }],
    ['empty identityFile', { identityFile: '' }], ['unknown key', { port: 22 }], ['no host', { host: '' }],
  ]) {
    writeFileSync(p, JSON.stringify({ ...good, ...bad }));
    let threw = false;
    try { loadConfig(p); } catch (e) { threw = /seat-b-setup/.test(e.message); }
    ok(threw, `rejects ${label}`);
  }
}

console.log('the SSH layer: a dead connection never reads as success');
{
  const cfg = { host: 'h', user: 'u', identityFile: 'C:\\k' };
  const mk = (r) => makeSsh(cfg, { exec: () => r }).ssh('echo');
  ok(mk({ status: 0, stdout: 'x' }).ok === true, 'exit 0 is ok');
  ok(mk({ status: 255, stdout: '' }).ok === false, 'ssh 255 is not ok');
  ok(mk({ status: null, signal: 'SIGTERM' }).ok === false, 'a timeout (status null) is not ok');
  ok(mk({ status: 0, error: new Error('ENOENT') }).ok === false, 'a spawn error is not ok, whatever the status says');
  ok(mk(undefined).ok === false, 'no result at all is not ok');
  let seen;
  makeSsh(cfg, { exec: (bin, args) => { seen = [bin, ...args]; return { status: 0 }; } }).put('C:\\x', 'C:\\r\\f');
  ok(/scp(.exe)?$/.test(seen[0]) && seen.includes('-i') && seen.at(-1) === 'u@h:C:/r/f', `scp target form: ${seen.at(-1)}`);
}

console.log('record judge and registry parse');
{
  ok(parseActiveUser(regOut('2')) === ID_B && parseActiveUser(regOut('0')) === null && parseActiveUser('') === null, 'ActiveUser -> SteamID64, 0/absent -> null');
  const rec = { schema: 'twoseat/1', runId: 'r1', seat: 'joiner', checks: ['invite-heard', 'lobby-joined', 'conversation-formed', 'play-window'].map((id) => ({ id, pass: true })), allPass: true, fatal: null };
  ok(judgeRecord(rec, { seat: 'joiner', runId: 'r1' }).pass, 'a complete record passes');
  ok(!judgeRecord(rec, { seat: 'joiner', runId: 'r0' }).pass, 'a stale record (other run id) fails');
  ok(!judgeRecord({ ...rec, schema: 'twoseat/0' }, { seat: 'joiner', runId: 'r1' }).pass, 'a wrong schema fails');
  ok(!judgeRecord(rec, { seat: 'host', runId: 'r1' }).pass, 'a record for the other seat fails');
}

console.log('twoseat-launch refuses a malformed run file');
{
  const tmp = mkdtempSync(join(tmpdir(), 'twoseat-run-')); cleanup.push(tmp);
  const p = join(tmp, 'next-run.json');
  writeFileSync(p, JSON.stringify({ runId: 'r', seat: 'host', record: 'rel.json', playS: 1, capS: 2, launch: 'dev' }));
  let threw = false;
  try { readRunFile(p); } catch (e) { threw = /seat.*record/.test(e.message); }
  ok(threw, 'wrong seat and relative record path are refused');
}

console.log('B2 readiness: the host starts only once B reports listening');
{
  const w = world({ readyAfter: 4 }); cleanup.push(w.tmp);
  const r = await drive(w);
  const types = w.calls.map((c, i) => [c, i]).filter(([c]) => String(c.at(-1)).startsWith('type '));
  const hostAt = w.calls.findIndex((c) => c[0] === 'HOST-START');
  const trigAt = w.calls.findIndex((c) => c.at(-1) === 'schtasks /run /tn OllieFace-TwoSeat');
  ok(r.code === 0 && types.length === 4, `B polled 4 times before it was ready (${types.length}); ${r.verdict}`);
  ok(trigAt >= 0 && types[0][1] > trigAt && hostAt > types.at(-1)[1], `order: trigger ${trigAt} < polls ${types[0][1]}..${types.at(-1)[1]} < host start ${hostAt}`);
  const runId = /run (\S+)/.exec(r.verdict)?.[1];
  const v = JSON.parse(readFileSync(join(w.a, 'reviews', 'twoseat', runId ?? 'none', 'verdict.json'), 'utf8'));
  ok(v.readyCapS === 180 && v.readyPolls === 4, `verdict.json records the readiness cap and polls (${v.readyCapS}, ${v.readyPolls})`);
  ok(v.sshClient && /ssh(\.exe)?$/.test(v.sshClient.bin) && /OpenSSH_for_Windows_9\.5/.test(v.sshClient.version), `verdict.json records the ssh client (${JSON.stringify(v.sshClient)})`);
}
{
  const w = world({ neverReady: true }); cleanup.push(w.tmp);
  const r = await drive(w, ['--ready-cap-s', '0.2']);
  ok(r.code === 1 && /FAIL run \S+ -- b-ready: .*0\.2 s readiness cap/.test(r.verdict) && !/record missing/.test(r.out), `a B that never listens fails b-ready, not record missing: ${r.verdict}`);
  ok(!w.calls.some((c) => c[0] === 'HOST-START'), 'and the host is never started');
  const runId = /run (\S+)/.exec(r.verdict)?.[1];
  const v = JSON.parse(readFileSync(join(w.a, 'reviews', 'twoseat', runId ?? 'none', 'verdict.json'), 'utf8'));
  ok(v.failed === 'b-ready' && v.readyCapS === 0.2 && v.pass === false, 'verdict.json says b-ready with its cap');
}
{
  const w = world({ readyRunId: 'someone-elses-run' }); cleanup.push(w.tmp);
  const r = await drive(w, ['--ready-cap-s', '0.2']);
  ok(r.code === 1 && /b-ready/.test(r.verdict) && !w.calls.some((c) => c[0] === 'HOST-START'), 'a listening record for another run is not ready');
}

console.log('task-target: the task must launch the configured checkout');
{
  await red('task points at another checkout', { taskRepo: 'C:\\old\\OllieFace' }, ['--preflight-only'], {}, /FAIL task-target\s+Task To Run: .*C:\\old\\OllieFace[\s\S]*fix: re-run tools\/seat-b-setup\/seat-b\.mjs/);
  await red('task missing', { taskMissing: true }, ['--preflight-only'], {}, /FAIL task-target\s+task OllieFace-TwoSeat not found/);
  await red('task at a sibling whose name extends repoPath', { taskRepo: (b) => `${b}2` }, ['--preflight-only'], {}, /FAIL task-target/);
}

console.log('the ssh client: Windows OpenSSH first, PATH only as a fallback');
{
  const sys = 'C:\\Windows\\System32\\OpenSSH';
  const b1 = resolveSshBins({ env: { SystemRoot: 'C:\\Windows' }, exists: (p) => p.startsWith(sys) });
  ok(b1.ssh === `${sys}\\ssh.exe` && b1.scp === `${sys}\\scp.exe` && b1.system, `System32 OpenSSH wins when present (${b1.ssh})`);
  const b2 = resolveSshBins({ env: { SystemRoot: 'C:\\Windows' }, exists: () => false });
  ok(b2.ssh === 'ssh' && b2.scp === 'scp' && !b2.system, 'absent -> PATH');
  const b3 = resolveSshBins({ env: { SystemRoot: 'C:\\Windows' }, exists: (p) => p.endsWith('ssh.exe') });
  ok(b3.ssh === 'ssh', 'ssh.exe without scp.exe -> PATH for both, never a mixed pair');
  let seen;
  makeSsh({ host: 'h', user: 'u' }, { exec: (bin) => { seen = bin; return { status: 0 }; }, bins: b1 }).get('C:\\r', 'C:\\l');
  ok(seen === b1.scp, 'makeSsh spawns the resolved binary');
}

console.log('judge: the listening intermediate is not final');
{
  const listening = { schema: 'twoseat/1', runId: 'r1', seat: 'joiner', aborted: 'run in progress', checks: [], allPass: false, listening: true, listeningAt: '2026-09-23T00:00:00Z' };
  const j = judgeRecord(listening, { seat: 'joiner', runId: 'r1' });
  ok(!j.pass && /listening since 2026-09-23T00:00:00Z but never finished/.test(j.why), j.why);
  ok(isListening(listening, 'r1') && !isListening(listening, 'r2') && !isListening({ ...listening, listening: undefined }, 'r1'), 'isListening needs this run and the flag');
  ok(!isListening({ ...listening, aborted: undefined, allPass: true }, 'r1'), 'a final record is not the listening state');
}

for (const d of cleanup) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
