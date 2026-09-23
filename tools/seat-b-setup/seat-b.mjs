#!/usr/bin/env node
// Run on machine B. Walks steps 1-6 of issue #243, idempotently.
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import process from 'node:process';
import { buildStepsB } from './lib/steps-b.mjs';
import { runSteps } from './lib/steps.mjs';
import { detectElevation } from './lib/elevation.mjs';

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const exec = (cmd) => execSync(cmd, { encoding: 'utf8', windowsHide: true });
  const answers = {};

  const confirm = async (prompt) => {
    const a = (await rl.question(prompt)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };
  const answerQuestion = async (prompt, key) => {
    const a = (await rl.question(prompt)).trim().toLowerCase();
    answers[key] = a === 'y' || a === 'yes';
    return answers[key];
  };

  const elevated = detectElevation(exec);
  console.log(elevated ? 'Running elevated.' : 'Not running elevated (some steps will be refused).');

  const ctx = { exec, confirm, elevated, log: (s) => console.log(s), answers, repoPath: process.cwd() };

  // Human-judgment steps ask their own yes/no before detect re-checks.
  const steps = buildStepsB(process.cwd()).map((step) => {
    if (step.id === 'app-owned') return { ...step, explain: async (c) => { console.log(step.explain(c)); await answerQuestion('Does account 2 own app 5150570 now? [y/N] ', 'appOwned'); return ''; } };
    if (step.id === 'auto-login') return { ...step, explain: async (c) => { console.log(step.explain(c)); await answerQuestion('Auto-login working? [y/N] ', 'autoLogin'); if (!answers.autoLogin) await answerQuestion('Accept one manual login after each reboot instead? [y/N] ', 'manualLoginAccepted'); return ''; } };
    if (step.id === 'repo-installed') return { ...step, explain: async (c) => { console.log(step.explain(c)); await answerQuestion('Repo cloned and npm install clean? [y/N] ', 'repoInstalled'); return ''; } };
    return step;
  });

  const results = await runSteps(steps, ctx);
  rl.close();

  console.log('\n--- seat-b-setup summary ---');
  for (const r of results) console.log(`${r.status.padEnd(9)} ${r.id}`);
  const allDone = results.every((r) => r.status === 'done' || r.status === 'skipped');
  console.log(allDone
    ? '\nMachine B is ready. On machine A, run seat-a.mjs then `npm run twoseat -- --preflight-only`.'
    : '\nNot finished -- re-run this script after handling the steps above.');
  process.exit(allDone ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
