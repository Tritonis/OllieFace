/**
 * The save writer is a single writer, it coalesces, and it is crash-atomic.
 *
 *   node tests/desktop-save-writer.test.mjs
 *
 * Every assertion here is written against a specific way of getting this
 * wrong, because the naive implementations all *look* correct in a manual
 * playtest:
 *
 *   - Fire-and-forget `fs.promises.writeFile` per request. Three flushes in
 *     one tick become three overlapping writes to one path; the bytes that
 *     survive are whichever call the OS finished last, which is not the newest
 *     snapshot. Caught by `max concurrent handles` and `final content`.
 *   - A real FIFO queue. Correct, but wasteful and slow in the way that
 *     matters: two of the three writes produce a file nobody will ever read,
 *     and the one that matters lands two disk round-trips late. Caught by the
 *     commit count.
 *   - `writeFile(tmp)` then `rename`, no fsync. Survives a process crash and
 *     not a power loss: the directory entry can be durable while the data is
 *     still in the page cache. Caught by the op-order assertion.
 *   - Writing the target directly. Caught by "the target never holds partial
 *     content".
 *
 * The fs is injected, so none of this touches a disk and all of it is
 * deterministic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSaveWriter, checkSnapshot, MAX_SNAPSHOT_BYTES } from '../desktop/save-writer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const TARGET = '/userdata/save.json';
const TMP = `${TARGET}.tmp`;
const BAK = `${TARGET}.bak`;
const snap = (v) => JSON.stringify({ 'telluric.profile': v });

/**
 * A fake fs with a real asynchronous gap in the middle of every write, which
 * is what makes overlap observable at all. `ops` is the full ordered log;
 * `maxOpen` is the high-water mark of simultaneously open handles.
 */
function fakeFs({ files = {}, onWrite = null } = {}) {
  const store = new Map(Object.entries(files));
  const ops = [];
  let open = 0, maxOpen = 0;
  const gap = () => new Promise((resolve) => { setTimeout(resolve, 1); });
  return {
    ops,
    store,
    get maxOpen() { return maxOpen; },
    async stat(p) {
      if (!store.has(p)) { const e = new Error(`ENOENT ${p}`); e.code = 'ENOENT'; throw e; }
      return { size: Buffer.byteLength(store.get(p), 'utf8') };
    },
    async mkdir() {},
    async copyFile(a, b) { ops.push(`copy ${a} -> ${b}`); store.set(b, store.get(a)); },
    async open(p) {
      ops.push(`open ${p}`);
      open++; maxOpen = Math.max(maxOpen, open);
      let closed = false;
      return {
        async writeFile(data) {
          await gap();
          if (onWrite) await onWrite({ store, ops });
          ops.push(`write ${p}`);
          store.set(p, data);
        },
        async sync() { ops.push(`sync ${p}`); },
        async close() { ops.push(`close ${p}`); if (!closed) { closed = true; open--; } },
      };
    },
    async rename(a, b) {
      await gap();
      ops.push(`rename ${a} -> ${b}`);
      store.set(b, store.get(a)); store.delete(a);
    },
  };
}

const quiet = () => {};

console.log('\n-- three requests during one write coalesce to two commits, newest wins');
{
  const fs = fakeFs();
  const w = createSaveWriter({ savePath: () => TARGET, fs, log: quiet, sleep: quiet });
  w.save(snap('a'));
  w.save(snap('b'));
  w.save(snap('c'));
  await w.idle();

  const commits = fs.ops.filter((o) => o.startsWith('rename')).length;
  ok(commits === 2, `two commits, not three or one (got ${commits})`);
  ok(fs.maxOpen === 1, `never more than one handle open at a time (peak ${fs.maxOpen})`);
  ok(fs.store.get(TARGET) === snap('c'), 'the file holds the newest snapshot, not the last one to finish');
  ok(!fs.store.has(TMP), 'no temp file is left behind');
}

console.log('\n-- writes never interleave: each commit is a complete open/write/sync/close/rename block');
{
  const fs = fakeFs();
  const w = createSaveWriter({ savePath: () => TARGET, fs, log: quiet, sleep: quiet });
  w.save(snap('one'));
  await w.idle();
  w.save(snap('two'));
  await w.idle();

  const expected = [
    `open ${TMP}`, `write ${TMP}`, `sync ${TMP}`, `close ${TMP}`, `rename ${TMP} -> ${TARGET}`,
  ];
  const block = (n) => fs.ops.filter((o) => o.includes(TMP)).slice(n * 5, n * 5 + 5);
  ok(JSON.stringify(block(0)) === JSON.stringify(expected), `first commit is ${expected.join(', ')}`);
  ok(JSON.stringify(block(1)) === JSON.stringify(expected), 'second commit is the same block, not spliced into the first');
  const syncAt = fs.ops.indexOf(`sync ${TMP}`);
  const renameAt = fs.ops.indexOf(`rename ${TMP} -> ${TARGET}`);
  ok(syncAt >= 0 && syncAt < renameAt, 'the fsync happens before the rename, so the rename cannot outrun the data');
}

console.log('\n-- the target never holds partial content: a kill mid-write leaves the old save whole');
{
  let sampled = null;
  const fs = fakeFs({
    files: { [TARGET]: snap('old') },
    // Sampled at the exact moment the new bytes are being written. If the
    // writer touched the target directly, this is where the file is a
    // half-written mixture of the two snapshots.
    onWrite: ({ store }) => { sampled = store.get(TARGET); },
  });
  const w = createSaveWriter({ savePath: () => TARGET, fs, log: quiet, sleep: quiet });
  await w.save(snap('new'));

  ok(sampled === snap('old'), 'mid-write, the target still holds the previous complete save');
  ok(fs.store.get(TARGET) === snap('new'), 'and afterwards it holds the new one');
  const writes = fs.ops.filter((o) => o === `write ${TARGET}`);
  ok(writes.length === 0, 'nothing was ever written to the target path itself');
}

console.log('\n-- a failure reaches the player, and the next success takes it back');
{
  const statuses = [];
  const fs = fakeFs();
  let broken = true;
  const brittle = { ...fs, open: async (p) => { if (broken) { const e = new Error('The process cannot access the file'); e.code = 'EBUSY'; throw e; } return fs.open(p); } };
  const w = createSaveWriter({
    savePath: () => TARGET, fs: brittle, log: quiet, sleep: quiet,
    onStatus: (s) => statuses.push(s),
  });

  await w.save(snap('a'));
  ok(statuses.length === 1 && statuses[0].ok === false, 'a failed write reports ok:false exactly once');
  ok(typeof statuses[0].reason === 'string' && statuses[0].reason.includes('EBUSY'),
    `the reason names the errno (${JSON.stringify(statuses[0]?.reason)})`);

  await w.save(snap('b'));
  ok(statuses.length === 1, 'a second identical failure does not re-report; the indicator is already up');

  broken = false;
  await w.save(snap('c'));
  ok(statuses.length === 2 && statuses[1].ok === true && statuses[1].reason === null,
    'the next success reports ok:true, which is what clears the indicator');
  ok(fs.store.get(TARGET) === snap('c'), 'and the file recovered');
}

console.log('\n-- transient failures are retried before the player is told anything');
{
  const statuses = [];
  const fs = fakeFs();
  let attempts = 0;
  const flaky = { ...fs, open: async (p) => { attempts++; if (attempts <= 2) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } return fs.open(p); } };
  const w = createSaveWriter({
    savePath: () => TARGET, fs: flaky, log: quiet, sleep: quiet, maxRetries: 2,
    onStatus: (s) => statuses.push(s),
  });
  await w.save(snap('a'));
  ok(attempts === 3, `two retries then success (${attempts} attempts)`);
  ok(statuses.length === 1 && statuses[0].ok === true, 'a cleared transient lock is never surfaced as a failure');
}

console.log('\n-- the accepted snapshot is bounded by size and by shape');
{
  ok(checkSnapshot(snap('a')) === null, 'a real snapshot is accepted');
  ok(checkSnapshot('x'.repeat(MAX_SNAPSHOT_BYTES + 1)) !== null, 'an oversized snapshot is refused');
  ok(checkSnapshot('[1,2,3]') !== null, 'an array is not a snapshot');
  ok(checkSnapshot('"just a string"') !== null, 'a bare JSON string is not a snapshot');
  ok(checkSnapshot('{"telluric.x": 42}') !== null, 'a non-string value is refused');
  ok(checkSnapshot('{oops') !== null, 'unparseable JSON is refused');

  const statuses = [];
  const fs = fakeFs();
  const w = createSaveWriter({ savePath: () => TARGET, fs, log: quiet, sleep: quiet, onStatus: (s) => statuses.push(s) });
  await w.save('{"telluric.x": 42}');
  ok(fs.ops.length === 0, 'a refused snapshot touches the disk not at all');
  ok(statuses.length === 1 && statuses[0].ok === false, 'and the player is told the save did not land');
}

console.log('\n-- an empty snapshot still cannot erase a non-empty save');
{
  const statuses = [];
  const fs = fakeFs({ files: { [TARGET]: snap('precious') } });
  const w = createSaveWriter({ savePath: () => TARGET, fs, log: quiet, sleep: quiet, onStatus: (s) => statuses.push(s) });
  await w.save('{}');
  ok(fs.store.get(TARGET) === snap('precious'), 'the file is untouched');
  ok(statuses.length === 1 && statuses[0].ok === false, 'a refusal is a failed save from the player\'s side, and says so');
  ok(!fs.ops.some((o) => o.startsWith('rename')), 'no commit was attempted');

  // ...but an empty snapshot onto nothing is a legitimate first-boot write.
  const fs2 = fakeFs();
  const w2 = createSaveWriter({ savePath: () => TARGET, fs: fs2, log: quiet, sleep: quiet });
  await w2.save('{}');
  ok(fs2.store.get(TARGET) === '{}', 'with no file to lose, an empty snapshot writes normally');
}

console.log('\n-- one backup generation per session, and it never shrinks');
{
  const fs = fakeFs({ files: { [TARGET]: snap('launch') } });
  const w = createSaveWriter({ savePath: () => TARGET, fs, log: quiet, sleep: quiet });
  await w.save(snap('second'));
  await w.save(snap('third'));
  ok(fs.store.get(BAK) === snap('launch'), 'the backup is the file the player launched with');
  ok(fs.ops.filter((o) => o.startsWith('copy')).length === 1, 'later writes do not churn over it');

  const fs2 = fakeFs({ files: { [TARGET]: '{}', [BAK]: snap('a much longer previous save') } });
  const w2 = createSaveWriter({ savePath: () => TARGET, fs: fs2, log: quiet, sleep: quiet });
  await w2.save(snap('x'));
  ok(fs2.store.get(BAK) === snap('a much longer previous save'), 'a smaller current file does not spend the backup generation');
}

console.log('\n-- no synchronous filesystem write is left anywhere on the save path');
{
  const writer = readFileSync(join(here, '..', 'desktop', 'save-writer.mjs'), 'utf8');
  ok(!/Sync\(/.test(writer), 'save-writer.mjs makes no *Sync call at all');

  // `main.mjs` keeps two deliberate sync calls that are NOT on the save path:
  // `readFileSync` for `store:load` (synchronous by IPC contract -- the
  // renderer hydrates before its first system boots) and one `writeFileSync`
  // for the Optimus `gpu-info.json` diagnostic at startup. The four below are
  // the ones the old save handler used, and none of them has any other caller.
  const main = readFileSync(join(here, '..', 'desktop', 'main.mjs'), 'utf8');
  for (const call of ['renameSync', 'copyFileSync', 'statSync', 'existsSync']) {
    ok(!main.includes(call), `main.mjs no longer calls ${call}`);
  }
  ok(/ipcMain\.on\('store:save',[^\n]*saveWriter\.save/.test(main),
    'the store:save handler delegates to the writer and does nothing else');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
