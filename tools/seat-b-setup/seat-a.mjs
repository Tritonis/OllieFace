#!/usr/bin/env node
// Run on machine A. Writes .twoseat.local.json (contract E) and the SSH key,
// then walks the human through copying the public key to B.
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import process from 'node:process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildStepsA, writeConfig, readConfig } from './lib/steps-a.mjs';
import { runSteps } from './lib/steps.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const exec = (cmd) => execSync(cmd, { encoding: 'utf8', windowsHide: true });
  const confirm = async (prompt) => {
    const a = (await rl.question(prompt)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };
  const answers = {};

  const ctx = {
    exec, confirm, elevated: true, log: (s) => console.log(s), answers,
    fsExists: (p) => fs.existsSync(p), readPub: (p) => fs.readFileSync(p, 'utf8').trim(),
    remoteUser: process.env.TWOSEAT_B_USER || 'accountB',
  };

  const steps = buildStepsA({ repoRoot, homeDir: os.homedir() }).map((step) => {
    if (step.id === 'local-config') {
      return {
        ...step,
        action: async () => {
          if (readConfig(repoRoot)) return; // already valid, nothing to do
          const host = (await rl.question('Machine B hostname or LAN IP: ')).trim();
          const user = (await rl.question('SSH user on B: ')).trim();
          const repoPath = (await rl.question('Repo path on B (e.g. C:\\Users\\accountB\\OllieFace): ')).trim();
          const accountBSteamId = (await rl.question('Account 2 SteamID64: ')).trim();
          writeConfig(repoRoot, { host, user, repoPath, accountBSteamId });
        },
      };
    }
    if (step.id === 'print-authorized-keys-command') {
      return {
        ...step,
        explain: (c) => { console.log(step.explain(c)); return ''; },
        action: async () => { await rl.question('Press enter once the key is appended on B: '); answers.keyCopied = true; },
      };
    }
    if (step.id === 'preflight') {
      return {
        ...step,
        action: async () => {
          console.log(step.explain());
          const ok = (await rl.question('Did the preflight print green? [y/N] ')).trim().toLowerCase();
          answers.preflightGreen = ok === 'y' || ok === 'yes';
        },
      };
    }
    return step;
  });

  const results = await runSteps(steps, ctx);
  rl.close();

  console.log('\n--- seat-a-setup summary ---');
  for (const r of results) console.log(`${r.status.padEnd(9)} ${r.id}`);
  const allDone = results.every((r) => r.status === 'done' || r.status === 'skipped');
  process.exit(allDone ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
