// Contract-E config shape + validation. Pure: no fs here so it's testable
// without touching disk.

/** Contract E: <repo>/.twoseat.local.json (gitignored by #242). */
export const CONTRACT_E_REQUIRED_FIELDS = ['host', 'user', 'repoPath', 'accountBSteamId'];
export const CONTRACT_E_OPTIONAL_FIELDS = ['identityFile'];

export function buildConfig({ host, user, repoPath, accountBSteamId, identityFile }) {
  const config = { host, user, repoPath, accountBSteamId };
  if (identityFile) config.identityFile = identityFile;
  return config;
}

/** Returns { valid, errors }. Checks required keys exist, are non-empty
 * strings, and that no key outside the contract's shape is present. */
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }
  for (const field of CONTRACT_E_REQUIRED_FIELDS) {
    const v = config[field];
    if (typeof v !== 'string' || v.length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if ('identityFile' in config && typeof config.identityFile !== 'string') {
    errors.push('identityFile must be a string when present');
  }
  const allowed = new Set([...CONTRACT_E_REQUIRED_FIELDS, ...CONTRACT_E_OPTIONAL_FIELDS]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) errors.push(`unexpected field: ${key}`);
  }
  return { valid: errors.length === 0, errors };
}
