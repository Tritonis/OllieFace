/**
 * The system OpenSSH client (ssh.exe / scp.exe), wrapped so a dead
 * connection can never read as success (#242).
 *
 * Every call is BatchMode (no password prompt can hang it), has a
 * ConnectTimeout, and a spawn timeout on top. The result is `{ ok, code,
 * stdout, stderr }`, where `ok` is true ONLY for a real exit code 0: a spawn
 * error, a timeout (status null), a signal, or ssh's own 255 all read false.
 *
 * `exec` is injectable (spawnSync's signature) so the layer is tested with a
 * fake runner rather than a live sshd.
 */
import { spawnSync } from 'node:child_process';

export function sshOptions(cfg, connectTimeoutS = 8) {
  const opts = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutS}`];
  if (cfg.identityFile) opts.push('-i', cfg.identityFile);
  return opts;
}

function settle(r) {
  const code = typeof r?.status === 'number' ? r.status : null;
  return {
    ok: !r?.error && code === 0,
    code,
    stdout: String(r?.stdout ?? ''),
    stderr: String(r?.stderr ?? '') + (r?.error ? `\n${r.error.message}` : '') + (code === null ? `\n(no exit code: ${r?.signal ?? 'timeout or spawn failure'})` : ''),
  };
}

/** Forward slashes, which Windows OpenSSH's scp and cmd both accept for a drive path. */
export const fwd = (p) => String(p).replace(/\\/g, '/');

export function makeSsh(cfg, { exec = spawnSync, timeoutMs = 60_000 } = {}) {
  const dest = `${cfg.user}@${cfg.host}`;
  const run = (bin, args) => settle(exec(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }));
  return {
    dest,
    /** Runs one command line in B's default (cmd.exe) shell. */
    ssh: (command) => run('ssh', [...sshOptions(cfg), dest, command]),
    /** Copies a local file to B. */
    put: (local, remote) => run('scp', [...sshOptions(cfg), local, `${dest}:${fwd(remote)}`]),
    /** Copies a file from B. */
    get: (remote, local) => run('scp', [...sshOptions(cfg), `${dest}:${fwd(remote)}`, local]),
  };
}
