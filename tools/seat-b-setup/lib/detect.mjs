// Pure parsers for Windows tool output. No child_process calls live here so
// every function can be exercised with canned strings in tests.

/** Extract the SteamPath value from `reg query HKCU\Software\Valve\Steam` output. */
export function parseSteamPath(regOutput) {
  const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(regOutput || '');
  return m ? m[1].trim() : null;
}

/** Extract ActiveUser (steamId3, 0 when signed out) from the ActiveProcess key. */
export function parseActiveUser(regOutput) {
  const m = /ActiveUser\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(regOutput || '');
  return m ? parseInt(m[1], 16) : 0;
}

export function isSteamRunning(regOutput) {
  return parseActiveUser(regOutput) !== 0;
}

/** Parse `Get-WindowsCapability -Online -Name OpenSSH.Server*` -> State line. */
export function parseWindowsCapabilityState(psOutput) {
  const m = /State\s*:\s*(\w+)/.exec(psOutput || '');
  return m ? m[1] : 'Unknown';
}

/** Parse `Get-Service sshd` -> Status column (Running/Stopped), or null if absent. */
export function parseServiceStatus(psOutput) {
  if (!psOutput || /cannot find any service/i.test(psOutput)) return null;
  const m = /\b(Running|Stopped)\b/.exec(psOutput);
  return m ? m[1] : null;
}

/** True when `schtasks /query /tn OllieFace-TwoSeat` found the task. */
export function parseScheduledTaskExists(schtasksOutput) {
  if (!schtasksOutput) return false;
  if (/ERROR/i.test(schtasksOutput) || /cannot find/i.test(schtasksOutput)) return false;
  return /OllieFace-TwoSeat/i.test(schtasksOutput);
}

/** True when `whoami /groups` shows the High Mandatory Level SID (elevated). */
export function parseElevation(whoamiGroupsOutput) {
  return /S-1-16-12288/.test(whoamiGroupsOutput || '')
    || /High Mandatory Level/i.test(whoamiGroupsOutput || '');
}

/**
 * True when `whoami /groups` lists membership in the local Administrators
 * group (SID S-1-5-32-544) -- group MEMBERSHIP, distinct from parseElevation
 * (current token's integrity level). A UAC-split admin is a member even in
 * a non-elevated shell, and OpenSSH's authorized_keys routing keys off
 * membership, not the current token.
 */
export function parseIsAdminGroupMember(whoamiGroupsOutput) {
  return /S-1-5-32-544/.test(whoamiGroupsOutput || '')
    || /BUILTIN\\Administrators/i.test(whoamiGroupsOutput || '');
}

/** Extract the bare account name (no DOMAIN\ / COMPUTER\ prefix) from `whoami`. */
export function parseWhoamiUsername(whoamiOutput) {
  const trimmed = (whoamiOutput || '').trim();
  const parts = trimmed.split('\\');
  return parts.length > 1 ? parts[1] : (trimmed || null);
}
