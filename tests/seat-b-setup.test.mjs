import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSteamPath, isSteamRunning, parseWindowsCapabilityState,
  parseServiceStatus, parseScheduledTaskExists, parseElevation,
  parseIsAdminGroupMember, parseWhoamiUsername,
} from '../tools/seat-b-setup/lib/detect.mjs';
import {
  buildScheduledTaskCommand, buildScheduledTaskQueryCommand,
  authorizedKeysPathForUser, buildAuthorizedKeysInstruction,
} from '../tools/seat-b-setup/lib/commands.mjs';
import { validateConfig, buildConfig } from '../tools/seat-b-setup/lib/config.mjs';
import { runStep, runSteps } from '../tools/seat-b-setup/lib/steps.mjs';
import { buildStepsB } from '../tools/seat-b-setup/lib/steps-b.mjs';
import { writeConfig, readConfig, configPath, buildStepsA } from '../tools/seat-b-setup/lib/steps-a.mjs';
import { detectElevation } from '../tools/seat-b-setup/lib/elevation.mjs';

// ---------- contract D: exact scheduled task command line ----------

const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';

test('contract D: scheduled task argv is exact', () => {
  const spec = buildScheduledTaskCommand('C:\\Users\\accountB\\OllieFace', NODE_EXE);
  assert.equal(spec.file, 'schtasks');
  assert.deepEqual(spec.args, [
    '/create', '/tn', 'OllieFace-TwoSeat', '/tr',
    'cmd.exe /c "cd /d C:\\Users\\accountB\\OllieFace && "C:\\Program Files\\nodejs\\node.exe" tools\\twoseat-launch.mjs"',
    '/sc', 'once', '/sd', '01/01/2020', '/st', '00:00', '/it', '/f',
  ]);
});

test('contract D: trigger never fires on its own -- a lapsed /sc once, not /sc onlogon', () => {
  const spec = buildScheduledTaskCommand('C:\\repo', NODE_EXE);
  assert.equal(spec.args.includes('once'), true);
  assert.equal(spec.args.includes('onlogon'), false);
});

test('contract D RED: mutated task name is caught', () => {
  const mutated = { ...buildScheduledTaskCommand('C:\\repo', NODE_EXE) };
  mutated.args = mutated.args.map((a) => (a === 'OllieFace-TwoSeat' ? 'OllieFaceTwoSeat' : a));
  assert.notDeepEqual(mutated.args, buildScheduledTaskCommand('C:\\repo', NODE_EXE).args);
});

test('buildScheduledTaskCommand requires a repoPath and a nodeExePath', () => {
  assert.throws(() => buildScheduledTaskCommand(), /repoPath is required/);
  assert.throws(() => buildScheduledTaskCommand('C:\\repo'), /nodeExePath is required/);
});

test('argv parses as a single /tr value for a spaced repoPath -- RED against the old shell-string builder', () => {
  // The fixed builder returns argv; execFileSync-style argv has exactly one
  // /tr element regardless of spaces in repoPath, because no shell re-tokenizes it.
  const spec = buildScheduledTaskCommand('C:\\Users\\Test User\\OllieFace', NODE_EXE);
  const trIndex = spec.args.indexOf('/tr');
  assert.equal(trIndex >= 0, true);
  assert.equal(typeof spec.args[trIndex + 1], 'string');
  assert.ok(spec.args[trIndex + 1].includes('Test User'));
  // exactly one /tr in the whole argv (old bug: a broken shell string let
  // the space split the action into extra top-level "arguments" once fed
  // through a shell, which this argv shape makes structurally impossible)
  assert.equal(spec.args.filter((a) => a === '/tr').length, 1);
});

// ---------- contract E: local config shape ----------

test('contract E: valid config passes validation', () => {
  const config = buildConfig({ host: '192.168.1.50', user: 'accountB', repoPath: 'C:\\repo', accountBSteamId: '765611...' });
  const { valid, errors } = validateConfig(config);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(config).sort(), ['accountBSteamId', 'host', 'repoPath', 'user']);
});

test('contract E: identityFile is optional and allowed', () => {
  const config = buildConfig({ host: 'h', user: 'u', repoPath: 'p', accountBSteamId: 's', identityFile: 'C:\\key' });
  assert.equal(validateConfig(config).valid, true);
});

test('contract E RED: missing required field fails, restored passes', () => {
  const good = buildConfig({ host: 'h', user: 'u', repoPath: 'p', accountBSteamId: 's' });
  assert.equal(validateConfig(good).valid, true);

  const mutated = { ...good };
  delete mutated.accountBSteamId; // deliberate mutation
  const bad = validateConfig(mutated);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('accountBSteamId')));

  // restore
  assert.equal(validateConfig(good).valid, true);
});

test('contract E RED: unexpected field is rejected', () => {
  const config = buildConfig({ host: 'h', user: 'u', repoPath: 'p', accountBSteamId: 's' });
  config.secretToken = 'leaked'; // deliberate mutation: something machine/secret-specific
  const { valid, errors } = validateConfig(config);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('secretToken')));
});

test('writeConfig refuses to write an invalid config to disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-b-setup-'));
  assert.throws(() => writeConfig(tmp, { host: 'h', user: 'u' }), /refusing to write invalid/);
  assert.equal(fs.existsSync(configPath(tmp)), false);
});

test('writeConfig then readConfig round-trips', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-b-setup-'));
  const written = writeConfig(tmp, { host: 'h', user: 'u', repoPath: 'p', accountBSteamId: 's' });
  const read = readConfig(tmp);
  assert.deepEqual(read, written);
});

// ---------- detect parsers ----------

test('parseSteamPath extracts value from reg query output', () => {
  const out = '\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\n    SteamPath    REG_SZ    C:/Program Files (x86)/Steam\n';
  assert.equal(parseSteamPath(out), 'C:/Program Files (x86)/Steam');
});

test('parseSteamPath returns null when the key is absent', () => {
  assert.equal(parseSteamPath('ERROR: The system was unable to find the specified registry key.'), null);
});

test('isSteamRunning reads ActiveUser', () => {
  const running = 'ActiveUser    REG_DWORD    0x110cabcd';
  const signedOut = 'ActiveUser    REG_DWORD    0x0';
  assert.equal(isSteamRunning(running), true);
  assert.equal(isSteamRunning(signedOut), false);
});

test('parseWindowsCapabilityState reads State', () => {
  assert.equal(parseWindowsCapabilityState('Path  :\nOnline : True\nState  : Installed\n'), 'Installed');
  assert.equal(parseWindowsCapabilityState('State  : NotPresent\n'), 'NotPresent');
});

test('parseServiceStatus handles running/stopped/missing', () => {
  assert.equal(parseServiceStatus('Status   Name   DisplayName\n------   ----   -----------\nRunning  sshd   OpenSSH SSH Server'), 'Running');
  assert.equal(parseServiceStatus('Stopped  sshd   OpenSSH SSH Server'), 'Stopped');
  assert.equal(parseServiceStatus('Get-Service : Cannot find any service with service name \'sshd\'.'), null);
});

test('parseScheduledTaskExists', () => {
  assert.equal(parseScheduledTaskExists('TaskName: \\OllieFace-TwoSeat\nNext Run Time: N/A'), true);
  assert.equal(parseScheduledTaskExists('ERROR: The system cannot find the file specified.'), false);
});

test('parseElevation', () => {
  assert.equal(parseElevation('BUILTIN\\Administrators ... S-1-16-12288 ... High Mandatory Level'), true);
  assert.equal(parseElevation('Mandatory Label\\Medium Mandatory Level'), false);
});

// ---------- idempotency: already-done steps are skipped ----------

test('runStep skips an already-done step without calling action or confirm', async () => {
  let actionCalled = false;
  let confirmCalled = false;
  const step = {
    id: 'x', title: 'x',
    detect: () => ({ done: true, detail: 'already there' }),
    action: () => { actionCalled = true; },
  };
  const ctx = { confirm: async () => { confirmCalled = true; return true; }, log: () => {}, exec: () => '' };
  const result = await runStep(step, ctx);
  assert.equal(result.status, 'skipped');
  assert.equal(actionCalled, false);
  assert.equal(confirmCalled, false);
});

test('runStep RED: a step wrongly reporting done=false when work is already done would re-run action', async () => {
  // Mutation: detect ignores the already-done state.
  let actionCalled = false;
  const brokenStep = {
    id: 'x', title: 'x',
    detect: () => ({ done: false, detail: 'broken detector' }), // mutated: should be true
    action: () => { actionCalled = true; },
  };
  const ctx = { confirm: async () => true, log: () => {}, exec: () => '' };
  await runStep(brokenStep, ctx);
  assert.equal(actionCalled, true); // demonstrates the guard catching non-idempotent behaviour

  // restored: correct detector reports done and skips
  const fixedStep = { ...brokenStep, detect: () => ({ done: true, detail: 'ok' }) };
  actionCalled = false;
  const result = await runStep(fixedStep, ctx);
  assert.equal(result.status, 'skipped');
  assert.equal(actionCalled, false);
});

test('buildStepsB: openssh-server step is already-done aware (idempotent) given a fake exec', async () => {
  const fakeExecDone = (cmd) => {
    if (cmd.includes('WindowsCapability')) return 'State  : Installed';
    if (cmd.includes('Get-Service sshd')) return 'Running  sshd   OpenSSH SSH Server';
    return '';
  };
  const steps = buildStepsB('C:\\repo');
  const sshStep = steps.find((s) => s.id === 'openssh-server');
  const result = await sshStep.detect({ exec: fakeExecDone });
  assert.equal(result.done, true);
});

// ---------- elevation refusal for admin-only steps ----------

test('runStep refuses an elevation-required step when not elevated, without running action', async () => {
  let actionCalled = false;
  const step = {
    id: 'admin-step', title: 'needs admin', needsElevation: true,
    detect: () => ({ done: false, detail: 'not done' }),
    action: () => { actionCalled = true; },
  };
  const ctx = { elevated: false, confirm: async () => true, log: () => {}, exec: () => '' };
  const result = await runStep(step, ctx);
  assert.equal(result.status, 'refused');
  assert.equal(actionCalled, false);
});

test('runStep RED: an elevation-required step wrongly proceeding when not elevated', async () => {
  // Mutation: needsElevation omitted (as if someone forgot to mark the step).
  let actionCalled = false;
  const unguardedStep = {
    id: 'admin-step', title: 'needs admin', // needsElevation: true -- deliberately removed
    detect: () => ({ done: false, detail: 'not done' }),
    action: () => { actionCalled = true; },
  };
  const ctx = { elevated: false, confirm: async () => true, log: () => {}, exec: () => '' };
  await runStep(unguardedStep, ctx);
  assert.equal(actionCalled, true); // shows the guard is load-bearing: without it, action runs unelevated

  // restored
  actionCalled = false;
  const guardedStep = { ...unguardedStep, needsElevation: true };
  const result = await runStep(guardedStep, ctx);
  assert.equal(result.status, 'refused');
  assert.equal(actionCalled, false);
});

test('detectElevation parses a real-shaped whoami /groups exec result', () => {
  const elevated = detectElevation(() => 'Mandatory Label\\High Mandatory Level  Label  S-1-16-12288');
  const notElevated = detectElevation(() => 'Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192');
  assert.equal(elevated, true);
  assert.equal(notElevated, false);
});

// ---------- item 4: SSH login user must match B's interactive desktop user ----------

test('parseIsAdminGroupMember detects the well-known Administrators SID', () => {
  assert.equal(parseIsAdminGroupMember('BUILTIN\\Administrators  Group  S-1-5-32-544  Enabled by default, Enabled group'), true);
  assert.equal(parseIsAdminGroupMember('BUILTIN\\Users  Group  S-1-5-32-545  Mandatory group'), false);
});

test('parseWhoamiUsername strips the DOMAIN\\ / COMPUTER\\ prefix', () => {
  assert.equal(parseWhoamiUsername('DESKTOP-B\\accountb\n'), 'accountb');
  assert.equal(parseWhoamiUsername('plainuser'), 'plainuser');
});

test('authorizedKeysPathForUser: admin group members use the machine-wide file, others use per-user', () => {
  assert.equal(authorizedKeysPathForUser('accountb', true), 'C:\\ProgramData\\ssh\\administrators_authorized_keys');
  assert.equal(authorizedKeysPathForUser('accountb', false), 'C:\\Users\\accountb\\.ssh\\authorized_keys');
});

test('contract-4 RED: an admin-user instruction that points at the per-user file is caught', () => {
  const wrongPath = authorizedKeysPathForUser('accountb', false); // mutation: computed with isAdmin=false for an admin account
  assert.notEqual(wrongPath, authorizedKeysPathForUser('accountb', true));
  const instruction = buildAuthorizedKeysInstruction('ssh-ed25519 AAAA...', 'accountb', true);
  assert.ok(instruction.includes('administrators_authorized_keys'));
  assert.ok(!instruction.includes(wrongPath));
  assert.ok(instruction.toLowerCase().includes('match group administrators'));
});

test('re-review fix: the real print-authorized-keys-command step passes isAdmin through to the instruction', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-b-setup-'));
  const steps = buildStepsA({ repoRoot: tmp, homeDir: tmp });
  const step = steps.find((s) => s.id === 'print-authorized-keys-command');
  const ctx = {
    answers: { user: 'accountb', userIsAdmin: true },
    readPub: () => 'ssh-ed25519 AAAA...',
  };
  const instruction = step.explain(ctx);
  assert.ok(instruction.includes('administrators_authorized_keys'));
  assert.ok(instruction.toLowerCase().includes('match group administrators'));
  assert.ok(!instruction.includes('C:\\Users\\accountb\\.ssh\\authorized_keys'));
});

test('re-review RED: dropping isAdmin at the call site (the reviewed defect) loses the admin guidance', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-b-setup-'));
  const steps = buildStepsA({ repoRoot: tmp, homeDir: tmp });
  const step = steps.find((s) => s.id === 'print-authorized-keys-command');
  // Mutation: reproduce the exact defect the reviewer found -- call the
  // builder without isAdmin, the way the old call site did.
  const { readPub } = { readPub: () => 'ssh-ed25519 AAAA...' };
  const buggyExplain = (ctx) => {
    const pubKey = readPub();
    return buildAuthorizedKeysInstruction(pubKey, ctx.answers.user || 'accountA');
  };
  const ctx = { answers: { user: 'accountb', userIsAdmin: true } };
  const buggyInstruction = buggyExplain(ctx);
  assert.ok(!buggyInstruction.includes('administrators_authorized_keys')); // demonstrates the loss
  // restored: the real step includes it
  const fixedInstruction = step.explain(ctx);
  assert.ok(fixedInstruction.includes('administrators_authorized_keys'));
});

test('print-authorized-keys-command step refuses to fabricate a user when none was recorded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-b-setup-'));
  const steps = buildStepsA({ repoRoot: tmp, homeDir: tmp });
  const step = steps.find((s) => s.id === 'print-authorized-keys-command');
  assert.throws(() => step.explain({ answers: {}, readPub: () => 'key' }), /no SSH user recorded/);
});

test('runSteps runs a mixed batch and reports each status', async () => {
  const ctx = { elevated: false, confirm: async () => true, log: () => {}, exec: () => '' };
  const results = await runSteps([
    { id: 'a', title: 'a', detect: () => ({ done: true }) },
    { id: 'b', title: 'b', needsElevation: true, detect: () => ({ done: false }), action: () => {} },
  ], ctx);
  assert.deepEqual(results.map((r) => r.status), ['skipped', 'refused']);
});
