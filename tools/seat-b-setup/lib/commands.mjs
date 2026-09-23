// Command-line builders. Kept pure (string in, string out) so the exact
// contract-D line can be pinned in a test without shelling out.

const TASK_NAME = 'OllieFace-TwoSeat';

/**
 * Contract D: scheduled task registration.
 *   Name OllieFace-TwoSeat; action `node <repoPath>\tools\twoseat-launch.mjs`;
 *   working dir <repoPath>; runs only when the user is logged on (/it).
 *
 * `schtasks /create` has no "start in" flag, so the working directory is set
 * by wrapping the action in `cmd.exe /c "cd /d <repoPath> && node ..."` --
 * this is our implementation choice for a requirement the contract states
 * but does not spell out as a literal command line (see DEVIATIONS in the
 * lane return).
 */
export function buildScheduledTaskCommand(repoPath) {
  if (!repoPath) throw new Error('buildScheduledTaskCommand: repoPath is required');
  const action = `cmd.exe /c "cd /d ${repoPath} && node tools\\twoseat-launch.mjs"`;
  return `schtasks /create /tn ${TASK_NAME} /tr "${action}" /sc onlogon /it /f`;
}

export function buildScheduledTaskQueryCommand() {
  return `schtasks /query /tn ${TASK_NAME}`;
}

export function buildScheduledTaskDeleteCommand() {
  return `schtasks /delete /tn ${TASK_NAME} /f`;
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

export function buildAuthorizedKeysInstruction(publicKey, remoteUser) {
  const home = remoteUser === 'Administrators' ? 'C:\\ProgramData\\ssh' : `C:\\Users\\${remoteUser}\\.ssh`;
  return `Append the following line to ${home}\\authorized_keys on machine B:\n${publicKey}`;
}

export { TASK_NAME };
