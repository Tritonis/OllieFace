// Contract-E config shape + validation. Pure: no fs here so it's testable
// without touching disk.
import { configErrors } from '../../lib/twoseat-config.mjs';

/** Contract E: <repo>/.twoseat.local.json (gitignored by #242). */
export const CONTRACT_E_REQUIRED_FIELDS = ['host', 'user', 'repoPath', 'accountBSteamId'];
export const CONTRACT_E_OPTIONAL_FIELDS = ['identityFile'];

export function buildConfig({ host, user, repoPath, accountBSteamId, identityFile }) {
  const config = { host, user, repoPath, accountBSteamId };
  if (identityFile) config.identityFile = identityFile;
  return config;
}

/** Returns { valid, errors }. The rule is contract E's single validator,
 * shared with `npm run twoseat` (tools/lib/twoseat-config.mjs), so a config
 * this wizard calls done is one the driver accepts. */
export function validateConfig(config) {
  const errors = configErrors(config);
  return { valid: errors.length === 0, errors };
}
