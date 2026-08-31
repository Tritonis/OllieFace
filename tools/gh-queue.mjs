#!/usr/bin/env node
// tools/gh-queue.mjs — a thin wrapper over the off-PATH `gh` CLI for queue
// bookkeeping (#240).
//
// WHY THIS EXISTS. The controller's session-start ritual — read the state
// issue, list `ready`, list the blocked buckets, sometimes park or close a
// batch — was three-plus raw `gh` invocations glued together with `jq`,
// each one re-typed by hand and each one echoing gh's own noise (bare
// URLs from `edit`/`comment`/`close`, a literal backtick-n where a `jq`
// join was meant to be a newline). This collapses that into one call per
// operation with compact, jq-free output: JSON is parsed in Node
// (`tools/lib/gh-queue-format.mjs` does the pure formatting) rather than
// shelled through `-q`.
//
// PORTABLE BY DESIGN. Nothing below hardcodes this repo: the state-issue
// number, the "ready" label, and the "blocked:user" prefix are the
// defaults, overridable via CLI flag, env var, or a `.gh-queue.json` at the
// repo root (see `resolveConfig` below) — so the same script works
// unmodified against a different project's queue.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, strArg } from './lib/parse-args.mjs';
import { formatTriage, formatView, bucketBlocked } from './lib/gh-queue-format.mjs';

const FALLBACK_GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';

/** Resolve the `gh` binary: `GH_QUEUE_GH` env var, else `gh` on PATH (probed
 * via `where`/`which`), else the fixed Windows install path. `null` if none
 * of those exist. */
export function resolveGh() {
  if (process.env.GH_QUEUE_GH) return process.env.GH_QUEUE_GH;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, ['gh'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].trim();
  if (existsSync(FALLBACK_GH)) return FALLBACK_GH;
  return null;
}

/** Build the default `run(args) -> {status, stdout, stderr}` against a
 * resolved gh path. Argument arrays only — no shell string interpolation,
 * since issue bodies routinely carry quotes and backticks. */
export function makeRun(ghPath) {
  return (args) => {
    const r = spawnSync(ghPath, args, { encoding: 'utf8' });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** Load `.gh-queue.json` at `cwd`, if present. Malformed or absent -> `{}`. */
export function loadFileConfig(cwd) {
  const p = join(cwd, '.gh-queue.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** Precedence: CLI flags > env vars > `.gh-queue.json` > built-in defaults
 * (this repo's own values: state issue #16, `ready`, `blocked:user`). A
 * resolved `stateIssue` of 0 means "not configured" — callers skip the
 * state-issue step rather than failing. */
export function resolveConfig(flags, fileCfg = {}) {
  const stateIssueRaw =
    strArg(flags.stateIssue, undefined) ??
    process.env.GH_QUEUE_STATE_ISSUE ??
    (fileCfg.stateIssue !== undefined ? String(fileCfg.stateIssue) : undefined) ??
    '16';
  const stateIssue = Number(stateIssueRaw) || 0;
  const readyLabel =
    strArg(flags.readyLabel, undefined) ?? process.env.GH_QUEUE_READY_LABEL ?? fileCfg.readyLabel ?? 'ready';
  const blockedPrefix =
    strArg(flags.blockedPrefix, undefined) ??
    process.env.GH_QUEUE_BLOCKED_PREFIX ??
    fileCfg.blockedPrefix ??
    'blocked:user';
  const repo = strArg(flags.repo, undefined);
  return { stateIssue, readyLabel, blockedPrefix, repo };
}

function withRepo(cfg, args) {
  return cfg.repo ? ['-R', cfg.repo, ...args] : args;
}

function formatCmd(args) {
  return ['gh', ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** Collect leftover non-flag tokens from a subcommand's argv. `valueFlags`
 * lists (hyphenated) flag names that consume the following token as a
 * value, so that value is not mistaken for a positional. */
function extractPositional(argv, valueFlags) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (/^--[\w-]+=/.test(tok)) continue;
    const bare = tok.match(/^--([\w-]+)$/);
    if (bare) {
      if (valueFlags.includes(bare[1])) i++;
      continue;
    }
    positional.push(tok);
  }
  return positional;
}

const CONFIG_VALUE_FLAGS = ['state-issue', 'ready-label', 'blocked-prefix', 'repo'];

export function cmdTriage(run, cfg, flags) {
  const lines = Number(strArg(flags.lines, '120'));
  const fields = 'number,title,state,body,labels,milestone';

  let stateIssue = null;
  if (cfg.stateIssue) {
    const r = run(withRepo(cfg, ['issue', 'view', String(cfg.stateIssue), '--json', fields]));
    if (r.status === 0) stateIssue = JSON.parse(r.stdout);
  }

  const readyRes = run(
    withRepo(cfg, ['issue', 'list', '--state', 'open', '--label', cfg.readyLabel, '--json', fields, '--limit', '200']),
  );
  const readyIssues = readyRes.status === 0 ? JSON.parse(readyRes.stdout) : [];

  const blockedLabels = [cfg.blockedPrefix, `${cfg.blockedPrefix}:keyboard`, `${cfg.blockedPrefix}:decision`];
  const seen = new Map();
  for (const label of blockedLabels) {
    const r = run(withRepo(cfg, ['issue', 'list', '--state', 'open', '--label', label, '--json', fields, '--limit', '200']));
    if (r.status !== 0) continue;
    for (const issue of JSON.parse(r.stdout)) seen.set(issue.number, issue);
  }
  const buckets = bucketBlocked([...seen.values()], cfg.blockedPrefix);

  console.log(formatTriage(stateIssue, readyIssues, buckets, { lines, readyLabel: cfg.readyLabel, blockedPrefix: cfg.blockedPrefix }));
  return 0;
}

export function cmdView(run, cfg, positional, flags) {
  const n = positional[0];
  if (!n) {
    console.log('usage: view <n> [--comments k] [--lines N]');
    return 2;
  }
  const lines = Number(strArg(flags.lines, '120'));
  const comments = Number(strArg(flags.comments, '3'));
  const fields = 'number,title,state,body,labels,milestone,comments';
  const r = run(withRepo(cfg, ['issue', 'view', String(n), '--json', fields]));
  if (r.status !== 0) {
    console.log(r.stderr.trim() || `gh issue view ${n} failed`);
    return 1;
  }
  const issue = JSON.parse(r.stdout);
  console.log(formatView(issue, { lines, comments }));
  return 0;
}

export function cmdPark(run, cfg, positional, flags) {
  const [n, decisionText] = positional;
  if (!n || decisionText === undefined) {
    console.log('usage: park <n> "<decision text>" [--keyboard]');
    return 2;
  }
  const targetLabel = flags.keyboard ? `${cfg.blockedPrefix}:keyboard` : `${cfg.blockedPrefix}:decision`;
  const editRes = run(withRepo(cfg, ['issue', 'edit', String(n), '--remove-label', cfg.readyLabel, '--add-label', targetLabel]));
  if (editRes.status !== 0) {
    console.log(editRes.stderr.trim() || `gh issue edit ${n} failed`);
    return 1;
  }
  const commentRes = run(withRepo(cfg, ['issue', 'comment', String(n), '--body', decisionText]));
  if (commentRes.status !== 0) {
    console.log(commentRes.stderr.trim() || `gh issue comment ${n} failed`);
    return 1;
  }
  console.log(`parked #${n} (${cfg.readyLabel} -> ${targetLabel})`);
  return 0;
}

export function cmdCloseBatch(run, cfg, flags) {
  const issuesRaw = strArg(flags.issues, '');
  const issueNumbers = issuesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const note = strArg(flags.note, '');
  const dryRun = flags.dryRun === true;

  if (!issueNumbers.length) {
    console.log('usage: close-batch --issues 1,2,3 --note "<text>" [--dry-run]');
    return 2;
  }

  if (dryRun) {
    if (cfg.stateIssue) console.log(formatCmd(withRepo(cfg, ['issue', 'comment', String(cfg.stateIssue), '--body', note])));
    for (const n of issueNumbers) console.log(formatCmd(withRepo(cfg, ['issue', 'close', String(n)])));
    for (const n of issueNumbers) console.log(formatCmd(withRepo(cfg, ['issue', 'view', String(n), '--json', 'number,state,labels'])));
    return 0;
  }

  if (cfg.stateIssue) {
    const r = run(withRepo(cfg, ['issue', 'comment', String(cfg.stateIssue), '--body', note]));
    if (r.status !== 0) console.log(`#${cfg.stateIssue}: note comment failed — ${r.stderr.trim()}`);
  }

  let closed = 0;
  for (const n of issueNumbers) {
    const closeRes = run(withRepo(cfg, ['issue', 'close', String(n)]));
    if (closeRes.status !== 0) {
      console.log(`#${n}: close failed — ${closeRes.stderr.trim()}`);
      continue;
    }
    const verifyRes = run(withRepo(cfg, ['issue', 'view', String(n), '--json', 'number,state,labels']));
    if (verifyRes.status !== 0) {
      console.log(`#${n}: closed, but verification failed — ${verifyRes.stderr.trim()}`);
      continue;
    }
    const issue = JSON.parse(verifyRes.stdout);
    let line = `#${n}: `;
    if (issue.state !== 'CLOSED') {
      line += `NOT CLOSED (state=${issue.state})`;
    } else {
      line += 'closed';
      closed++;
    }
    const names = (issue.labels ?? []).map((l) => l.name);
    if (names.includes(cfg.readyLabel)) {
      run(withRepo(cfg, ['issue', 'edit', String(n), '--remove-label', cfg.readyLabel]));
      line += `; removed lingering ${cfg.readyLabel} label`;
    }
    console.log(line);
  }
  console.log(`closed ${closed}/${issueNumbers.length}`);
  return 0;
}

export function main(argv, run) {
  const [command, ...rest] = argv;
  const fileCfg = loadFileConfig(process.cwd());

  if (command === 'triage') {
    const flags = parseArgs(rest);
    return cmdTriage(run, resolveConfig(flags, fileCfg), flags);
  }
  if (command === 'view') {
    const flags = parseArgs(rest);
    const positional = extractPositional(rest, [...CONFIG_VALUE_FLAGS, 'comments', 'lines']);
    return cmdView(run, resolveConfig(flags, fileCfg), positional, flags);
  }
  if (command === 'park') {
    const flags = parseArgs(rest);
    const positional = extractPositional(rest, CONFIG_VALUE_FLAGS);
    return cmdPark(run, resolveConfig(flags, fileCfg), positional, flags);
  }
  if (command === 'close-batch') {
    const flags = parseArgs(rest);
    return cmdCloseBatch(run, resolveConfig(flags, fileCfg), flags);
  }

  console.log('usage: gh-queue.mjs <triage|view|park|close-batch> ...');
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ghPath = resolveGh();
  if (!ghPath) {
    console.log(`gh not found (looked on PATH and at ${FALLBACK_GH})`);
    process.exit(2);
  }
  process.exit(main(process.argv.slice(2), makeRun(ghPath)));
}
