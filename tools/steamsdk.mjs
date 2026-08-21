/**
 * Steamworks SDK: unpack the one file we use, and check the Binding can reach it.
 *
 *   node tools/steamsdk.mjs                    verify what is vendored today
 *   node tools/steamsdk.mjs --zip <path>       adopt an SDK zip, then verify
 *   node tools/steamsdk.mjs --json <path>      also write the record as JSON
 *
 * ## Why this exists
 *
 * `steamworks-ffi-node` ships no Steam redistributable — it is Koffi FFI over
 * `steam_api64.dll`, which Valve licenses separately and which its loader expects
 * to find at `steamworks_sdk/redistributable_bin/win64/steam_api64.dll`. So the
 * DLL is vendored by hand, and "by hand" is exactly the kind of step that rots.
 *
 * It rots in a way that is hard to see. The Binding resolves symbols **lazily**
 * (its own comment: deferring `koffi.func()` to first call saves "hundreds of ms"
 * across ~200 functions), so a DLL missing an export it declares does not fail at
 * `init()`. Steam reports available, the Introduction works, and the first
 * Conversation is where it dies. That is what happened with SDK 1.65: four of the
 * 377 declared symbols were absent, one of them
 * `SteamAPI_SteamNetworkingSockets_SteamAPI_v012`, the accessor every
 * `NetworkingSockets` call goes through.
 *
 * So this tool forces the question the lazy loader defers: does every symbol the
 * Binding declares actually exist in the DLL we vendored? Exit code is 0 only if
 * it does.
 *
 * ## What it reads
 *
 * Declared symbols come from the installed Binding's own loader
 * (`node_modules/steamworks-ffi-node/dist/internal/SteamLibraryLoader.js`), so the
 * check tracks the real dependency rather than a copy of it that can drift.
 *
 * `steamworks-ffi-node` is a pinned dependency, so its absence is a broken install
 * and this tool now FAILS on it. It used to fall back to the four
 * `REQUIRED_SYMBOLS` below and print PASS, which is a guard reporting success on a
 * question it never asked — the same shape as the lazy-binding hazard it exists to
 * catch. Those four are still checked, on every run, in addition to the declared
 * set: they are flat-API entry points the Binding does not bind at all, so nothing
 * else would notice them going missing.
 *
 * This tool answers the DLL-export question in plain node. It deliberately does not
 * answer the loader question — whether koffi can resolve those names inside the
 * Electron process that actually ships. `tools/steam-electron-init.mjs` does that,
 * and `npm run steamsdk:electron` runs it.
 *
 * Exported names are read out of the DLL's bytes rather than its PE export table.
 * Export names are stored as plain ASCII, `SteamAPI_*` is an unambiguous prefix,
 * and the alternative is a PE parser this repo would then own. A false *positive*
 * would need the literal symbol name to appear in the binary without being
 * exported; the failure mode we care about — a name that is simply not there —
 * cannot hide from it.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The path `steamworks-ffi-node`'s loader searches for, relative to the project root. */
const VENDOR_REL = 'steamworks_sdk/redistributable_bin/win64/steam_api64.dll';
/** The entry inside Valve's zip that becomes it. The zip roots everything at `sdk/`. */
const ZIP_ENTRY = 'sdk/redistributable_bin/win64/steam_api64.dll';

const BINDING_LOADER =
  'node_modules/steamworks-ffi-node/dist/internal/SteamLibraryLoader.js';

/**
 * Checked on every run, on top of the Binding's declared set. These are the
 * flat-API entry points the single-box socket-pair gate needs and the Binding does
 * not bind, so they are worth asserting on their own: they are the reason an SDK
 * swap could quietly remove the only automated Conversation coverage we have.
 */
const REQUIRED_SYMBOLS = [
  'SteamAPI_ISteamNetworkingSockets_CreateSocketPair',
  'SteamAPI_ISteamNetworkingUtils_SetGlobalConfigValueInt32',
  'SteamAPI_ISteamNetworkingSockets_CreateListenSocketIP',
  'SteamAPI_ISteamNetworkingSockets_ConnectByIPAddress',
  // The manual dispatch loop `desktop/steam-callbacks.mjs` declares for itself,
  // because the Binding declares no broadcast-callback path and callback 333 is
  // the running joiner's only way to hear an accepted invite. Same reasoning as
  // the four above: nothing else in the repo would notice these going missing,
  // and they would go missing at the first invite rather than at init.
  'SteamAPI_ManualDispatch_Init',
  'SteamAPI_ManualDispatch_RunFrame',
  'SteamAPI_ManualDispatch_GetNextCallback',
  'SteamAPI_ManualDispatch_FreeLastCallback',
  'SteamAPI_GetHSteamPipe',
];

// ------------------------------------------------------------------ arguments
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(/^--([\w-]+)$/);
  if (!m) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[m[1]] = true;
  else { args[m[1]] = next; i++; }
}

// ------------------------------------------------------------------- zip read
/**
 * Pull one entry out of a zip. Walks the central directory backwards from the
 * end-of-central-directory record, which is the only way to read a zip correctly
 * — local headers alone can lie about compressed size when a data descriptor is
 * used. Store (0) and deflate (8) are the only methods Valve's zip uses.
 */
function readZipEntry(zipPath, wanted) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`not a zip (no end-of-central-directory): ${zipPath}`);

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === wanted) {
      // The local header's own name/extra lengths are authoritative for where the
      // payload starts; they are allowed to differ from the central directory's.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported compression method ${method} for ${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip has no entry ${wanted}`);
}

// --------------------------------------------------------------- symbol reads
const exportedSymbols = (dll) =>
  new Set(String(dll.toString('latin1')).match(/SteamAPI_[A-Za-z0-9_]+/g) ?? []);

const declaredSymbols = (loaderSrc) =>
  [...new Set([...loaderSrc.matchAll(/lf\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].sort();

const sha256 = (b) => createHash('sha256').update(b).digest('hex').toUpperCase();

// --------------------------------------------------------------------- adopt
const vendorAbs = path.join(root, VENDOR_REL);

if (args.zip) {
  const zipPath = path.resolve(root, args.zip);
  if (!existsSync(zipPath)) {
    console.error(`[steamsdk] no such zip: ${zipPath}`);
    process.exit(2);
  }
  const dll = readZipEntry(zipPath, ZIP_ENTRY);
  mkdirSync(path.dirname(vendorAbs), { recursive: true });
  writeFileSync(vendorAbs, dll);
  console.log(`[steamsdk] adopted ${ZIP_ENTRY} from ${path.basename(zipPath)}`);
  console.log(`[steamsdk]   -> ${VENDOR_REL} (${dll.length} bytes)`);
  console.log(`[steamsdk]   sha256 ${sha256(dll)}`);
  console.log('[steamsdk]   update steamworks_sdk/README.md with that hash and the SDK version.');
}

// -------------------------------------------------------------------- verify
if (!existsSync(vendorAbs)) {
  console.error(`[steamsdk] FAIL  nothing vendored at ${VENDOR_REL}`);
  console.error('[steamsdk]       run with --zip <steamworks_sdk_NNN.zip> to adopt one.');
  process.exit(1);
}

const dll = readFileSync(vendorAbs);
const exports = exportedSymbols(dll);

const loaderAbs = path.join(root, BINDING_LOADER);
if (!existsSync(loaderAbs)) {
  console.error(`\n[steamsdk] FAIL  the Binding is not installed at ${BINDING_LOADER}.`);
  console.error("[steamsdk]       'steamworks-ffi-node' is a pinned dependency, so this is a broken");
  console.error("[steamsdk]       install, not a supported mode. Run 'npm ci'. This tool will NOT");
  console.error('[steamsdk]       substitute a weaker check and print PASS.');
  process.exit(3);
}

const bindingDeclared = declaredSymbols(readFileSync(loaderAbs, 'utf8'));
const declared = [...new Set([...bindingDeclared, ...REQUIRED_SYMBOLS])].sort();

console.log(`\n[steamsdk] ${VENDOR_REL}`);
console.log(`[steamsdk]   ${dll.length} bytes, sha256 ${sha256(dll)}`);
console.log(`[steamsdk]   ${exports.size} SteamAPI_* names present`);
console.log(`[steamsdk]   FULL CHECK: ${bindingDeclared.length} symbols declared by ${BINDING_LOADER},`);
console.log(`[steamsdk]   plus the ${REQUIRED_SYMBOLS.length} flat-API symbols the socket-pair gate needs`);
console.log(`[steamsdk]   -> ${declared.length} distinct symbols checked`);

const missing = declared.filter((s) => !exports.has(s));

// An interface accessor that is merely a version behind is the failure that cost
// us a plan assumption, so name the version the DLL *does* carry rather than
// reporting a bare absence and making the reader go looking.
const explain = (sym) => {
  const m = sym.match(/^(.*)_v\d+$/);
  if (!m) return '';
  const alts = [...exports].filter((e) => e.startsWith(`${m[1]}_v`)).sort();
  return alts.length ? `   (DLL has ${alts.join(', ')})` : '';
};

if (missing.length) {
  console.error(`\n[steamsdk] FAIL  ${missing.length} declared symbol(s) absent from this DLL:`);
  for (const s of missing) console.error(`  - ${s}${explain(s)}`);
  console.error('\n[steamsdk] The Binding resolves symbols lazily, so this does NOT fail at');
  console.error('[steamsdk] init(). It fails the first time the affected call is made.');
} else {
  console.log(`\n[steamsdk] PASS  FULL CHECK — all ${declared.length} symbols present`
    + ` (${bindingDeclared.length} declared by the Binding).`);
  console.log('[steamsdk]       That is the DLL-export question only. For the loader question —');
  console.log('[steamsdk]       koffi resolving these names inside Electron — run');
  console.log('[steamsdk]       `npm run steamsdk:electron`.');
}

if (args.json) {
  const out = path.resolve(root, args.json);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({
    vendored: VENDOR_REL,
    bytes: dll.length,
    sha256: sha256(dll),
    bindingDeclared: bindingDeclared.length,
    checked: declared.length,
    missing,
  }, null, 2)}\n`);
  console.log(`[steamsdk] record -> ${path.relative(root, out)}`);
}

process.exit(missing.length ? 1 : 0);
