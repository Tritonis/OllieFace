// tests/parse-args.test.mjs
//
// Unit coverage of tools/lib/parse-args.mjs (#162): every lane-aware tool's
// argv handling now goes through this one helper, so the `--flag value` /
// `--flag=value` equivalence only needs proving here rather than once per
// tool.
import { parseArgs, argValue, hasArg } from '../tools/lib/parse-args.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

console.log('parseArgs: space and = forms agree');
{
  const space = parseArgs(['--lane', 'C', '--port', '5261']);
  const eq = parseArgs(['--lane=C', '--port=5261']);
  ok(space.lane === 'C' && space.port === '5261', 'space form parses --lane and --port');
  ok(eq.lane === 'C' && eq.port === '5261', '= form parses --lane and --port identically');
}

console.log('parseArgs: hyphenated names camelCase in both forms');
{
  const space = parseArgs(['--signal-port', '5262', '--run-s', '30']);
  const eq = parseArgs(['--signal-port=5262', '--run-s=30']);
  ok(space.signalPort === '5262' && space.runS === '30', 'space form camelCases hyphenated flags');
  ok(eq.signalPort === '5262' && eq.runS === '30', '= form camelCases hyphenated flags identically');
}

console.log('parseArgs: boolean flags');
{
  const trailing = parseArgs(['--no-signal']);
  ok(trailing.noSignal === true, 'a flag at the end of argv is boolean true');
  const beforeAnother = parseArgs(['--no-signal', '--lane', 'C']);
  ok(beforeAnother.noSignal === true && beforeAnother.lane === 'C',
    'a flag immediately followed by another --flag is boolean, and does not eat it as a value');
  // = form still short-circuits a boolean flag written with an explicit value.
  const eqEmpty = parseArgs(['--no-signal=']);
  ok(eqEmpty.noSignal === '', '--flag= (empty value) parses as an empty string, not true — distinct case, not a bug');
}

console.log('parseArgs: an = value can itself contain =');
{
  const args = parseArgs(['--record=reviews/round9/coopprobe-a=b.json']);
  ok(args.record === 'reviews/round9/coopprobe-a=b.json', 'only the first = splits flag from value');
}

console.log('argValue: space and = forms agree, absent flag is undefined');
{
  ok(argValue(['--lane', 'C'], '--lane') === 'C', 'space form');
  ok(argValue(['--lane=C'], '--lane') === 'C', '= form');
  ok(argValue(['--port', '5261'], '--lane') === undefined, 'absent flag is undefined');
  // A prefix collision must not false-match: --lane-extra=X should not answer for --lane.
  ok(argValue(['--lane-extra=X'], '--lane') === undefined,
    'a longer flag sharing a prefix does not answer for the shorter one');
}

console.log('hasArg: space, =, and boolean forms all count as present');
{
  ok(hasArg(['--no-signal'], '--no-signal') === true, 'bare flag present');
  ok(hasArg(['--no-signal=true'], '--no-signal') === true, '= form present');
  ok(hasArg(['--port', '5261'], '--no-signal') === false, 'absent flag is false');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
