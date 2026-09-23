// Step definitions for machine A: contract-E local config + SSH key.

import fs from 'node:fs';
import path from 'node:path';
import { validateConfig, buildConfig } from './config.mjs';
import { buildAuthorizedKeysInstruction } from './commands.mjs';

const CONFIG_FILENAME = '.twoseat.local.json';
const DEFAULT_KEY_NAME = 'id_ollieface_twoseat';

export function configPath(repoRoot) {
  return path.join(repoRoot, CONFIG_FILENAME);
}

export function readConfig(repoRoot) {
  const p = configPath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeConfig(repoRoot, values) {
  const config = buildConfig(values);
  const { valid, errors } = validateConfig(config);
  if (!valid) throw new Error(`refusing to write invalid .twoseat.local.json: ${errors.join('; ')}`);
  fs.writeFileSync(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n');
  return config;
}

export function defaultKeyPaths(homeDir) {
  const dir = path.join(homeDir, '.ssh');
  return { dir, priv: path.join(dir, DEFAULT_KEY_NAME), pub: path.join(dir, `${DEFAULT_KEY_NAME}.pub`) };
}

/**
 * The wizard's own config write: always names the key the ssh-key step makes,
 * as an absolute path. Without identityFile, ssh only offers its default key
 * names, never id_ollieface_twoseat, and preflight's reachable fails on
 * publickey.
 */
export function writeWizardConfig(repoRoot, homeDir, values) {
  return writeConfig(repoRoot, { ...values, identityFile: defaultKeyPaths(homeDir).priv });
}

export function buildStepsA({ repoRoot, homeDir }) {
  const { dir, priv, pub } = defaultKeyPaths(homeDir);
  return [
    {
      id: 'local-config',
      title: 'Write .twoseat.local.json (host, user, repoPath, accountBSteamId)',
      detect: () => {
        const existing = readConfig(repoRoot);
        if (!existing) return { done: false, detail: 'no config yet' };
        const { valid, errors } = validateConfig(existing);
        if (!valid) return { done: false, detail: errors.join('; ') };
        if (!existing.identityFile) return { done: false, detail: `no identityFile: ssh would never offer ${priv}` };
        return { done: true, detail: 'config present and valid' };
      },
      explain: () => 'Answer the prompts for machine B\'s hostname/IP, SSH user, repo path on B, '
        + 'and account 2\'s SteamID64.',
    },
    {
      id: 'ssh-key',
      title: 'Create or locate an SSH key for connecting to machine B',
      detect: (ctx) => {
        const exists = ctx.fsExists ? ctx.fsExists(priv) && ctx.fsExists(pub) : (fs.existsSync(priv) && fs.existsSync(pub));
        return exists ? { done: true, detail: priv } : { done: false, detail: 'no key at ' + priv };
      },
      explain: () => `Run:\n  ssh-keygen -t ed25519 -f "${priv}" -N ""`,
      action: (ctx) => {
        ctx.exec(`ssh-keygen -t ed25519 -f "${priv}" -N ""`);
      },
    },
    {
      id: 'print-authorized-keys-command',
      title: 'Copy the public key to machine B',
      detect: (ctx) => ({ done: ctx.answers && ctx.answers.keyCopied === true, detail: 'human-confirmed' }),
      explain: (ctx) => {
        const pubKey = ctx.readPub ? ctx.readPub(pub) : (fs.existsSync(pub) ? fs.readFileSync(pub, 'utf8').trim() : '<generate the key first>');
        if (!ctx.answers || !ctx.answers.user) {
          throw new Error('print-authorized-keys-command: no SSH user recorded -- run the local-config step first');
        }
        return buildAuthorizedKeysInstruction(pubKey, ctx.answers.user, ctx.answers.userIsAdmin === true);
      },
    },
    {
      id: 'preflight',
      title: 'Run the #242 preflight from machine A',
      detect: (ctx) => ({ done: ctx.answers && ctx.answers.preflightGreen === true, detail: 'human-confirmed' }),
      explain: () => 'Run: npm run twoseat -- --preflight-only',
    },
  ];
}

export { CONFIG_FILENAME, DEFAULT_KEY_NAME };
