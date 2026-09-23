/**
 * Contract E: the one validator for <repo>/.twoseat.local.json. `npm run
 * twoseat` (tools/twoseat.mjs loadConfig) and the setup wizard
 * (tools/seat-b-setup/lib/config.mjs) both judge a config here, so a file the
 * wizard calls done is a file the driver accepts.
 */
import { win32 } from 'node:path';

export const CONFIG_KEYS = Object.freeze(['host', 'user', 'repoPath', 'accountBSteamId', 'identityFile']);

/** Every reason `cfg` is not a usable contract-E config; empty when it is. */
export function configErrors(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['config must be a JSON object'];
  const bad = [];
  const str = (k) => typeof cfg[k] === 'string' && cfg[k].trim() !== '';
  if (!str('host') || /\s/.test(cfg.host)) bad.push('host (a hostname or address)');
  if (!str('user') || /[\s@]/.test(cfg.user)) bad.push('user (the Windows user on B)');
  if (!str('repoPath') || !win32.isAbsolute(cfg.repoPath)) bad.push('repoPath (absolute Windows path on B)');
  if (!/^7656119\d{10}$/.test(String(cfg.accountBSteamId ?? '')) || typeof cfg.accountBSteamId !== 'string') bad.push('accountBSteamId (a SteamID64 string)');
  if ('identityFile' in cfg && !str('identityFile')) bad.push('identityFile (omit it, or a key path)');
  const extra = Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k));
  if (extra.length) bad.push(`unknown keys: ${extra.join(', ')}`);
  return bad;
}
