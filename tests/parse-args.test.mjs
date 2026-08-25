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
}

console.log('parseArgs / argValue: an empty = value fails closed, not Number(\'\') === 0');
{
  // Confirmed defect: parseArgs(['--port=']) used to yield {port: ''}, and
  // every caller does Number(args.port ?? default) — Number('') is 0, not
  // NaN, so it sailed past every "?? default" fallback and silently bound a
  // server on an OS-assigned random port. Pre-fix, --port= was ignored
  // entirely (neither form matched, so it fell through to the clean
  // default) — this failure mode is new to the = spelling, not a
  // regression of a pre-existing one.
  let threw = null;
  try { parseArgs(['--port=']); } catch (e) { threw = e; }
  ok(threw !== null, 'parseArgs throws on --port= (empty value) rather than returning {port: \'\'}');
  ok(/--port=/.test(threw?.message ?? ''), 'the thrown message names the flag');

  let threw2 = null;
  try { argValue(['--port='], '--port'); } catch (e) { threw2 = e; }
  ok(threw2 !== null, 'argValue throws on --port= (empty value) rather than returning \'\'');
  ok(/--port=/.test(threw2?.message ?? ''), 'the thrown message names the flag');

  // A boolean flag with no '=' at all is unaffected — only an explicit,
  // empty '=' is rejected.
  const bareBoolean = parseArgs(['--no-signal']);
  ok(bareBoolean.noSignal === true, 'a bare boolean flag (no =) is still true, not rejected');
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

console.log('parseArgs / argValue: capitalized flags are not silently swallowed (#200)');
{
  const args = parseArgs(['--Lane=C']);
  ok(args.lane === 'C', '--Lane=C lands in args.lane, not dropped');
  ok(argValue(['--Port', '5'], '--port') === '5', 'argValue matches --Port against a lowercase query');
  // Values keep their case — only the flag name is normalized.
  const preserved = parseArgs(['--lane=C']);
  ok(preserved.lane === 'C', 'a value\'s own case survives untouched');
}

console.log('hasArg: capitalized flags are not silently swallowed (#200)');
{
  ok(hasArg(['--Lane=B'], '--lane') === true, '--Lane=B counts as present for --lane');
  ok(hasArg(['--LANE', 'B'], '--lane') === true, '--LANE bare form counts as present for --lane');
}

console.log('parseArgs: camelCase flag names decamelize to the same key as hyphenated (#200 follow-up)');
{
  // Confirmed defect: camel(name.toLowerCase()) lowercased before splitting
  // on case, so `--portBase` collapsed to the single word `portbase` while
  // `--port-base` correctly camelCased to `portBase` — two spellings of the
  // same flag landed under two different keys.
  const camelForm = parseArgs(['--portBase', '5240']);
  const hyphenForm = parseArgs(['--port-base', '5240']);
  const mixedForm = parseArgs(['--Port-Base', '5240']);
  ok(camelForm.portBase === '5240', '--portBase lands in args.portBase, not args.portbase');
  ok(hyphenForm.portBase === '5240', '--port-base still lands in args.portBase');
  ok(mixedForm.portBase === '5240', '--Port-Base (capitalized + hyphenated) lands in args.portBase');

  const camelEq = parseArgs(['--portBase=5240']);
  ok(camelEq.portBase === '5240', '--portBase=5240 (= form) lands in args.portBase');
}

console.log('parseArgs: ALL-CAPS and mixed-run flag names do not get split per letter (#200 re-review)');
{
  // Confirmed defect: decamelize()'s original ([a-zA-Z0-9])([A-Z]) boundary
  // matched upper->upper too, so an all-caps run got a hyphen inserted
  // before every letter: --LANE -> l-a-n-e -> {lAnE: 'B'}, --PORT -> pOrT.
  // Only a lower/digit -> upper boundary should split.
  const allCapsSpace = parseArgs(['--LANE', 'B']);
  ok(allCapsSpace.lane === 'B', '--LANE B lands in args.lane, not args.lAnE');
  ok(!('lAnE' in allCapsSpace), '--LANE does not produce a per-letter-split key');

  const allCapsHyphen = parseArgs(['--PORT-BASE', '5240']);
  ok(allCapsHyphen.portBase === '5240', '--PORT-BASE lands in args.portBase, not args.pOrTBAsE');

  const allCapsEq = parseArgs(['--PORT=5261']);
  ok(allCapsEq.port === '5261', '--PORT=5261 lands in args.port, not args.pOrT');

  // The required-outcomes set from the re-review, in one place.
  ok(parseArgs(['--LANE', 'B']).lane === 'B', 'LANE -> lane');
  ok(parseArgs(['--PORT-BASE', '5240']).portBase === '5240', 'PORT-BASE -> portBase');
  ok(parseArgs(['--portBase', '5240']).portBase === '5240', 'portBase -> portBase');
  ok(parseArgs(['--Port-Base', '5240']).portBase === '5240', 'Port-Base -> portBase');
  ok(parseArgs(['--lane', 'C']).lane === 'C', 'lane -> lane');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
