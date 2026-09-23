// Step definitions for machine B (issue #243 steps 1-6). Detect functions
// call ctx.exec(cmd) -> string (stdout), so tests can inject a fake exec.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSteamPath, isSteamRunning, parseWindowsCapabilityState,
  parseServiceStatus, parseScheduledTaskExists, parseIsAdminGroupMember, parseWhoamiUsername,
} from './detect.mjs';
import {
  buildScheduledTaskCommand, buildScheduledTaskQueryCommand,
  buildFirewallRuleCommand, buildOpenSshInstallCommand, buildSshdStartCommand,
  authorizedKeysPathForUser,
} from './commands.mjs';

/** B's checkout, from this file's own location -- never the shell's cwd, which
 *  would register a task pointing wherever the wizard happened to be run from. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const safeExec = (ctx, cmd) => {
  try { return ctx.exec(cmd); } catch { return ''; }
};

export function buildStepsB(repoPath) {
  return [
    {
      id: 'steam-installed-signed-in',
      title: 'Step 1: Steam installed and signed in as account 2',
      detect: (ctx) => {
        const path = parseSteamPath(safeExec(ctx, 'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath'));
        const running = isSteamRunning(safeExec(ctx, 'reg query "HKCU\\Software\\Valve\\Steam\\ActiveProcess" /v ActiveUser'));
        if (!path) return { done: false, detail: 'Steam not installed for this user' };
        if (!running) return { done: false, detail: 'Steam installed but not signed in' };
        return { done: true, detail: `Steam at ${path}, signed in` };
      },
      explain: () => 'Install Steam, sign in with account 2 (NOT the account used on machine A), '
        + 'and tick "Remember my password" so Steam Guard does not prompt after a reboot.',
    },
    {
      id: 'app-owned',
      title: 'Step 2: account 2 owns app 5150570',
      detect: (ctx) => ({ done: ctx.answers && ctx.answers.appOwned === true, detail: 'human-confirmed (cannot be read offline)' }),
      explain: () => 'Ownership cannot be checked offline. Generate a developer key at '
        + 'https://partner.steamgames.com/ and redeem it on this machine, or grant account 2 access '
        + 'to app 5150570, then confirm it shows in the Steam library.',
    },
    {
      id: 'auto-login',
      title: 'Step 3: Steam auto-starts and Windows signs the user in (or a recorded manual-login choice)',
      detect: (ctx) => ({
        done: ctx.answers && (ctx.answers.autoLogin === true || ctx.answers.manualLoginAccepted === true),
        detail: ctx.answers?.manualLoginAccepted ? 'manual login after reboot accepted' : 'auto-login confirmed',
      }),
      explain: () => 'Set Steam to start with Windows (Settings > Interface), and either configure '
        + 'Windows auto-logon for this account, or accept that B needs one manual login after each reboot.',
    },
    {
      id: 'ssh-login-user',
      title: 'Identify the SSH login account (must be the Windows user signed in at B\'s desktop)',
      detect: (ctx) => ({ done: !!(ctx.answers && ctx.answers.sshUserConfirmed), detail: ctx.answers?.sshUser || '' }),
      explain: (ctx) => {
        const username = parseWhoamiUsername(safeExec(ctx, 'whoami'));
        const isAdmin = parseIsAdminGroupMember(safeExec(ctx, 'whoami /groups'));
        const keysPath = username ? authorizedKeysPathForUser(username, isAdmin) : '(run whoami to find out)';
        ctx.answers.sshUser = username;
        ctx.answers.sshUserIsAdmin = isAdmin;
        return `Lane B's preflight reads B's Steam state (HKCU ActiveProcess ActiveUser) over SSH, `
          + 'so the SSH login user MUST be the same account signed in at B\'s interactive desktop -- '
          + `not a different service or admin account.\nCurrent user: ${username || '(unknown)'}`
          + (isAdmin ? ' (member of Administrators)' : '') + `\nauthorized_keys file for this account: ${keysPath}\n`
          + 'Enter this exact account name as `user` when running seat-a.mjs on machine A.';
      },
    },
    {
      id: 'openssh-server',
      title: 'Step 4: OpenSSH Server installed, running, key authorized, firewall scoped to LAN',
      needsElevation: true,
      detect: (ctx) => {
        const cap = parseWindowsCapabilityState(safeExec(ctx, 'powershell -NoProfile -Command "Get-WindowsCapability -Online -Name OpenSSH.Server*"'));
        const status = parseServiceStatus(safeExec(ctx, 'powershell -NoProfile -Command "Get-Service sshd"'));
        if (cap !== 'Installed') return { done: false, detail: `OpenSSH.Server capability state: ${cap}` };
        if (status !== 'Running') return { done: false, detail: `sshd service: ${status || 'not found'}` };
        return { done: true, detail: 'sshd installed and running' };
      },
      explain: () => `Run:\n  ${buildOpenSshInstallCommand()}\n  ${buildSshdStartCommand()}\n  ${buildFirewallRuleCommand()}\n`
        + 'then append machine A\'s public key to authorized_keys.',
      action: (ctx) => {
        ctx.exec(buildOpenSshInstallCommand());
        ctx.exec(buildSshdStartCommand());
        ctx.exec(buildFirewallRuleCommand());
      },
    },
    {
      id: 'repo-installed',
      title: 'Step 5: repo cloned and installed on B',
      detect: (ctx) => ({ done: ctx.answers && ctx.answers.repoInstalled === true, detail: 'human-confirmed' }),
      explain: () => `Clone the repo to ${repoPath || 'a known path'} and run npm install. `
        + 'If the install breaks, use the install-repair skill -- never hand-write a .bin shim.',
    },
    {
      id: 'scheduled-task',
      title: 'Step 6: scheduled task for the responder, on-demand only',
      needsElevation: true,
      detect: (ctx) => ({ done: parseScheduledTaskExists(safeExec(ctx, buildScheduledTaskQueryCommand())), detail: 'task query' }),
      explain: (ctx) => {
        const spec = buildScheduledTaskCommand(ctx.repoPath || repoPath, ctx.nodeExePath || process.execPath);
        return `Run: ${spec.file} ${spec.args.join(' ')}\n`
          + '(a lapsed one-time trigger, so it never fires on its own -- only `schtasks /run` starts it)';
      },
      action: (ctx) => {
        const spec = buildScheduledTaskCommand(ctx.repoPath || repoPath, ctx.nodeExePath || process.execPath);
        ctx.exec(spec);
      },
    },
  ];
}
