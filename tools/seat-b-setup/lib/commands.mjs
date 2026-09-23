// Command-line builders. Kept pure (repoPath/nodeExePath in, argv out) so
// the exact contract-D argv can be pinned in a test without shelling out.

const TASK_NAME = 'OllieFace-TwoSeat';

// A past date/time for /sd /st: `once` triggers that have already elapsed
// never fire on their own (Windows will not "catch up" a missed one-time
// trigger), so the task only ever starts via `schtasks /run` (contract C).
const NEVER_FIRES_SD = '01/01/2020';
const NEVER_FIRES_ST = '00:00';

/**
 * Contract D: scheduled task registration.
 *   Name OllieFace-TwoSeat; action `node <repoPath>\tools\twoseat-launch.mjs`;
 *   working dir <repoPath>; runs only when the user is logged on (/it).
 *
 * Returns { file, args } for execFileSync(file, args) -- NOT a shell string.
 * `schtasks /create` has no "start in" flag, so the working directory is set
 * by wrapping the action in `cmd.exe /c "cd /d <repoPath> && "<node.exe>" ..."`.
 * Building this as an argv array (rather than a single shell string) and
 * running it via execFileSync lets Node's own Windows argument quoting do
 * the escaping for a repoPath or node.exe path containing spaces -- a hand
 * -built shell string with manually doubled quotes was tried and breaks
 * (schtasks' own /tr parser stops at the first embedded space once quotes
 * are nested three deep). Verified empirically: `schtasks /query /tn ...`
 * echoes the "Task To Run" field back byte-for-byte correct only via the
 * argv route.
 *
 * `nodeExePath` should be `process.execPath`, captured on the machine that
 * runs the wizard: the scheduled task's own environment may not have node
 * on PATH.
 */
export function buildScheduledTaskCommand(repoPath, nodeExePath) {
  if (!repoPath) throw new Error('buildScheduledTaskCommand: repoPath is required');
  if (!nodeExePath) throw new Error('buildScheduledTaskCommand: nodeExePath is required');
  const inner = `cd /d ${repoPath} && "${nodeExePath}" tools\\twoseat-launch.mjs`;
  const action = `cmd.exe /c "${inner}"`;
  return {
    file: 'schtasks',
    args: [
      '/create', '/tn', TASK_NAME, '/tr', action,
      '/sc', 'once', '/sd', NEVER_FIRES_SD, '/st', NEVER_FIRES_ST,
      '/it', '/f',
    ],
  };
}

export function buildScheduledTaskQueryCommand() {
  return { file: 'schtasks', args: ['/query', '/tn', TASK_NAME] };
}

export function buildScheduledTaskDeleteCommand() {
  return { file: 'schtasks', args: ['/delete', '/tn', TASK_NAME, '/f'] };
}

export function buildScheduledTaskRunCommand() {
  return { file: 'schtasks', args: ['/run', '/tn', TASK_NAME] };
}

/** Firewall rule scoped to the LAN only, per issue step 4. */
export function buildFirewallRuleCommand() {
  return 'New-NetFirewallRule -DisplayName "OllieFace TwoSeat SSH" '
    + '-Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -RemoteAddress LocalSubnet';
}

export function buildOpenSshInstallCommand() {
  return 'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0';
}

export function buildSshdStartCommand() {
  return 'Start-Service sshd; Set-Service -Name sshd -StartupType Automatic';
}

/**
 * Windows OpenSSH's well-known trap: sshd_config has a `Match Group
 * administrators` block that redirects authorized_keys lookup to a single
 * machine-wide file for any user in the local Administrators group --
 * per-user `~\.ssh\authorized_keys` is silently ignored for those accounts.
 */
export function authorizedKeysPathForUser(username, isAdmin) {
  return isAdmin
    ? 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
    : `C:\\Users\\${username}\\.ssh\\authorized_keys`;
}

export function buildAuthorizedKeysInstruction(publicKey, username, isAdmin) {
  const home = authorizedKeysPathForUser(username, isAdmin);
  const trap = isAdmin
    ? ` (${username} is in the local Administrators group: OpenSSH's sshd_config redirects admin `
      + 'logins to this single machine-wide file via "Match Group administrators" -- a per-user '
      + '.ssh\\authorized_keys is silently ignored for this account.)'
    : '';
  return `Append the following line to ${home} on machine B:${trap}\n${publicKey}`;
}

export { TASK_NAME };
