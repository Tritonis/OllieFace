// tests/gh-queue.test.mjs
//
// #240: tools/gh-queue.mjs wraps the off-PATH `gh` for queue bookkeeping.
// Formatting (tools/lib/gh-queue-format.mjs) is pure and tested directly;
// the command layer (tools/gh-queue.mjs) takes an injectable `run(args)`
// so `park`/`close-batch` can be exercised without touching a real repo.
// Every assertion below is on a concrete string or call shape, not on
// "did not throw".

import { capLines, bucketBlocked, formatView } from '../tools/lib/gh-queue-format.mjs';
import { cmdPark, cmdCloseBatch, cmdTriage, resolveConfig } from '../tools/gh-queue.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('capLines: truncation marker appears only when over the cap');
{
  const short = capLines('a\nb\nc', 5);
  ok(short === 'a\nb\nc', 'under the cap: text is unchanged, no marker');
  const long = capLines(Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'), 4);
  ok(long.startsWith('line0\nline1\nline2\nline3\n'), 'long text is capped to the first N lines');
  ok(long.endsWith('... (+6 more lines)'), 'the marker reports the exact overflow count');
}

console.log('bucketBlocked: keyboard/decision/unsplit, including label omission upstream in formatIssueRow');
{
  const issues = [
    { number: 1, title: 'needs hands', labels: [{ name: 'blocked:user:keyboard' }] },
    { number: 2, title: 'needs a call', labels: [{ name: 'blocked:user:decision' }] },
    { number: 3, title: 'bare only', labels: [{ name: 'blocked:user' }] },
    { number: 4, title: 'not blocked at all', labels: [{ name: 'ready' }] },
  ];
  const b = bucketBlocked(issues, 'blocked:user');
  ok(b.keyboard.length === 1 && b.keyboard[0].number === 1, 'issue #1 goes to keyboard');
  ok(b.decision.length === 1 && b.decision[0].number === 2, 'issue #2 goes to decision');
  ok(b.unsplit.length === 1 && b.unsplit[0].number === 3, 'bare blocked:user with no sub-label goes to unsplit');
  ok(!b.keyboard.some((i) => i.number === 4) && !b.decision.some((i) => i.number === 4) && !b.unsplit.some((i) => i.number === 4), 'an unrelated issue lands in no bucket');
}

console.log('formatView: header with and without milestone; last-k comment selection');
{
  const comments = [
    { author: { login: 'a' }, createdAt: '2026-01-01T00:00:00Z', body: 'first' },
    { author: { login: 'b' }, createdAt: '2026-01-02T00:00:00Z', body: 'second' },
    { author: { login: 'c' }, createdAt: '2026-01-03T00:00:00Z', body: 'third' },
    { author: { login: 'd' }, createdAt: '2026-01-04T00:00:00Z', body: 'fourth' },
  ];
  const withMilestone = formatView(
    { number: 42, title: 'Thing', state: 'OPEN', labels: [{ name: 'ready' }], milestone: { title: 'v1' }, body: 'body text', comments },
    { comments: 2 },
  );
  ok(withMilestone.startsWith('#42 Thing — OPEN — labels: ready — milestone: v1'), 'header includes the milestone segment');
  ok(withMilestone.includes('(4 comments total, showing last 2)'), 'summary line reports total vs shown');
  ok(withMilestone.includes('--- @c 2026-01-03 ---') && withMilestone.includes('--- @d 2026-01-04 ---'), 'the LAST two comments are shown');
  ok(!withMilestone.includes('--- @a ') && !withMilestone.includes('--- @b '), 'earlier comments are excluded');

  const withoutMilestone = formatView(
    { number: 7, title: 'Other', state: 'CLOSED', labels: [], milestone: null, body: 'x', comments: [] },
    {},
  );
  ok(withoutMilestone.startsWith('#7 Other — CLOSED — labels: '), 'header omits the milestone segment when null');
  ok(!withoutMilestone.includes('milestone:'), 'no stray "milestone:" text when there is none');
}

console.log('resolveConfig: precedence CLI flag > env > file > default, and 0 means "skip"');
{
  delete process.env.GH_QUEUE_STATE_ISSUE;
  delete process.env.GH_QUEUE_READY_LABEL;
  delete process.env.GH_QUEUE_BLOCKED_PREFIX;
  const def = resolveConfig({}, {});
  ok(def.stateIssue === 16 && def.readyLabel === 'ready' && def.blockedPrefix === 'blocked:user', 'built-in defaults match this repo');

  const fromFile = resolveConfig({}, { stateIssue: 99, readyLabel: 'go', blockedPrefix: 'held' });
  ok(fromFile.stateIssue === 99 && fromFile.readyLabel === 'go' && fromFile.blockedPrefix === 'held', '.gh-queue.json overrides built-in defaults');

  process.env.GH_QUEUE_STATE_ISSUE = '5';
  const fromEnv = resolveConfig({}, { stateIssue: 99 });
  ok(fromEnv.stateIssue === 5, 'env var overrides the file');
  const fromFlag = resolveConfig({ stateIssue: '3' }, { stateIssue: 99 });
  ok(fromFlag.stateIssue === 3, 'a CLI flag overrides env and file');
  delete process.env.GH_QUEUE_STATE_ISSUE;

  const skipped = resolveConfig({ stateIssue: '0' }, {});
  ok(skipped.stateIssue === 0, '--state-issue 0 resolves to 0 (skip)');
}

console.log('triage formatting works with a different label set (not this repo\'s names)');
{
  const calls = [];
  const otherRun = (args) => {
    calls.push(args);
    if (args.includes('view') && args[2] === '9') {
      return { status: 0, stdout: JSON.stringify({ number: 9, title: 'Roadmap', body: 'plan text' }), stderr: '' };
    }
    const label = args[args.indexOf('--label') + 1];
    if (label === 'go') {
      return { status: 0, stdout: JSON.stringify([{ number: 11, title: 'Do it', labels: [{ name: 'go' }] }]), stderr: '' };
    }
    return { status: 0, stdout: '[]', stderr: '' };
  };
  const cfg = { stateIssue: 9, readyLabel: 'go', blockedPrefix: 'held', repo: undefined };
  const logs = [];
  const origLog = console.log;
  console.log = (s) => logs.push(s);
  try {
    cmdTriage(otherRun, cfg, {});
  } finally {
    console.log = origLog;
  }
  const out = logs.join('\n');
  ok(out.includes('#9 Roadmap'), 'state issue block uses the configured issue and its own title');
  ok(out.includes('READY (go)') && out.includes('#11  Do it'), 'ready block uses the configured label name, not "ready"');
  ok(out.includes('HELD:KEYBOARD') && out.includes('HELD:DECISION') && out.includes('HELD (unsplit)'), 'blocked buckets use the configured prefix, not "blocked:user"');
}

console.log('park: exactly two gh calls, right args, no URL printed');
{
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'edit') return { status: 0, stdout: 'https://github.com/x/y/issues/42\n', stderr: '' };
    if (args[0] === 'issue' && args[1] === 'comment') return { status: 0, stdout: 'https://github.com/x/y/issues/42#issuecomment-1\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const cfg = { stateIssue: 16, readyLabel: 'ready', blockedPrefix: 'blocked:user', repo: undefined };
  const logs = [];
  const origLog = console.log;
  console.log = (s) => logs.push(s);
  let rc;
  try {
    rc = cmdPark(run, cfg, ['42', 'because reasons'], {});
  } finally {
    console.log = origLog;
  }
  ok(rc === 0, 'park exits 0');
  ok(calls.length === 2, 'exactly two gh invocations');
  ok(calls[0].join(' ') === 'issue edit 42 --remove-label ready --add-label blocked:user:decision', 'first call removes ready, adds the decision sub-label');
  ok(calls[1].join(' ') === 'issue comment 42 --body because reasons', 'second call comments the decision text');
  const out = logs.join('\n');
  ok(out === 'parked #42 (ready -> blocked:user:decision)', 'prints exactly one line, no gh URL');

  const kbCalls = [];
  const kbRun = (args) => { kbCalls.push(args); return { status: 0, stdout: 'https://x\n', stderr: '' }; };
  cmdPark(kbRun, cfg, ['7', 'txt'], { keyboard: true });
  ok(kbCalls[0].includes('blocked:user:keyboard'), '--keyboard parks under the keyboard sub-label instead');
}

console.log('close-batch --dry-run: prints commands, runs nothing');
{
  const calls = [];
  const run = (args) => { calls.push(args); return { status: 0, stdout: '[]', stderr: '' }; };
  const cfg = { stateIssue: 16, readyLabel: 'ready', blockedPrefix: 'blocked:user', repo: undefined };
  const logs = [];
  const origLog = console.log;
  console.log = (s) => logs.push(s);
  try {
    cmdCloseBatch(run, cfg, { issues: '1,2', note: 'batch done', dryRun: true });
  } finally {
    console.log = origLog;
  }
  ok(calls.length === 0, 'dry-run invokes run() zero times');
  ok(logs.some((l) => l.includes('gh issue close 1')) && logs.some((l) => l.includes('gh issue close 2')), 'dry-run prints the close commands it would have run');
}

console.log('close-batch: a lingering ready label on an otherwise-closed issue is removed and reported');
{
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.join(' ') === 'issue comment 16 --body batch done') return { status: 0, stdout: 'https://x\n', stderr: '' };
    if (args[0] === 'issue' && args[1] === 'close') return { status: 0, stdout: 'https://x\n', stderr: '' };
    if (args[0] === 'issue' && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify({ number: 3, state: 'CLOSED', labels: [{ name: 'ready' }] }), stderr: '' };
    }
    if (args[0] === 'issue' && args[1] === 'edit') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const cfg = { stateIssue: 16, readyLabel: 'ready', blockedPrefix: 'blocked:user', repo: undefined };
  const logs = [];
  const origLog = console.log;
  console.log = (s) => logs.push(s);
  try {
    cmdCloseBatch(run, cfg, { issues: '3', note: 'batch done' });
  } finally {
    console.log = origLog;
  }
  const out = logs.join('\n');
  ok(out.includes('removed lingering ready label'), 'reports the lingering label was removed');
  ok(calls.some((c) => c.join(' ') === 'issue edit 3 --remove-label ready'), 'issues the remove-label call');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
