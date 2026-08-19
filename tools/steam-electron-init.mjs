/**
 * Prove `steamworks-ffi-node` loads, resolves EVERY declared symbol, and
 * initialises — under Electron, the runtime the shipping product actually uses.
 *
 *   npx electron tools/steam-electron-init.mjs [--json <path>]
 *
 * ## Why this is not the same check as `npm run steamsdk`
 *
 * `tools/steamsdk.mjs` reads names out of the DLL's bytes with plain node. That
 * catches a missing export, which is the failure SDK 1.65 had, but it proves
 * nothing about the loader: koffi has to open the DLL in *this* process, with
 * Electron's ABI and Electron's bundled V8, and `dlsym` each name. The Binding
 * defers `koffi.func()` to first call (its own comment: eager binding of ~200
 * functions costs "hundreds of ms"), so under normal use a bad symbol surfaces
 * at the first Conversation, long after `init()` said everything was fine.
 *
 * So this tool forces every deferred lookup immediately. `lib.func(name, ...)`
 * is exactly what the lazy wrapper would eventually call; doing it for all 377
 * declared names turns a latent first-call crash into a load-time verdict.
 *
 * The declared list is parsed out of the installed loader's own source, the same
 * source `steamsdk.mjs` reads, so the two checks cannot drift apart.
 *
 * `SteamAPI_InitSafe` returning false is NOT a failure of this tool — it means
 * no Steam client is logged in. That is reported separately from the symbol
 * verdict, because the symbol question is answerable without one and is the
 * question this tool exists for.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOADER_REL = 'node_modules/steamworks-ffi-node/dist/internal/SteamLibraryLoader.js';

const argIndex = process.argv.indexOf('--json');
const jsonOut = argIndex >= 0 ? process.argv[argIndex + 1] : null;

const say = (s) => process.stdout.write(`${s}\n`);

let code = 0;
const record = { runtime: 'electron', versions: {}, declared: 0, resolved: 0, unresolved: [] };

try {
  record.versions = {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    chrome: process.versions.chrome ?? null,
  };
  if (!record.versions.electron) {
    say('[electron-init] FAIL  not running under Electron — run with `npx electron`.');
    process.exit(2);
  }

  say(`[electron-init] electron ${record.versions.electron}, node ${record.versions.node}, chrome ${record.versions.chrome}`);

  // The declared surface, read from the installed loader rather than a copy.
  const src = readFileSync(path.join(root, LOADER_REL), 'utf8');
  const declared = [...new Set([...src.matchAll(/lf\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].sort();
  record.declared = declared.length;
  if (!declared.length) throw new Error(`no lf('...') declarations found in ${LOADER_REL}`);

  const { SteamLibraryLoader } = require(path.join(root, LOADER_REL));
  const loader = new SteamLibraryLoader();
  loader.load();
  const lib = loader.getLibrary();
  if (!lib) throw new Error('loader.load() produced no library — the vendored DLL was not found');
  say(`[electron-init] koffi opened the vendored DLL`);

  // Force every deferred lookup. Signature is irrelevant to dlsym; only the
  // name has to be found, and a wrong arity here is never called.
  for (const name of declared) {
    try {
      lib.func(name, 'void', []);
      record.resolved++;
    } catch (err) {
      record.unresolved.push({ name, error: String(err && err.message ? err.message : err) });
    }
  }

  if (record.unresolved.length) {
    code = 1;
    say(`\n[electron-init] FAIL  ${record.unresolved.length}/${declared.length} declared symbols did NOT resolve:`);
    for (const u of record.unresolved) say(`  - ${u.name}: ${u.error}`);
  } else {
    say(`[electron-init] PASS  all ${declared.length} declared symbols resolved under Electron`);
  }

  // Initialisation. Reported separately: no logged-in client is an environment
  // fact, not a symbol fault, and conflating them is how "it loaded" got
  // mistaken for evidence in the first place.
  const running = loader.SteamAPI_IsSteamRunning();
  const inited = loader.SteamAPI_Init();
  record.steamRunning = running;
  record.initSafe = inited;
  say(`[electron-init] SteamAPI_IsSteamRunning() -> ${running}`);
  say(`[electron-init] SteamAPI_InitSafe()       -> ${inited}`);
  if (inited) {
    loader.SteamAPI_RunCallbacks();
    say('[electron-init] SteamAPI_RunCallbacks()    -> returned');
    loader.SteamAPI_Shutdown();
    say('[electron-init] SteamAPI_Shutdown()       -> returned');
  } else {
    say('[electron-init] NOTE  no logged-in Steam client; symbol verdict above stands on its own.');
  }
} catch (err) {
  code = 1;
  record.error = String(err && err.stack ? err.stack : err);
  say(`[electron-init] FAIL  ${record.error}`);
}

if (jsonOut) {
  const out = path.resolve(root, jsonOut);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  say(`[electron-init] record -> ${path.relative(root, out)}`);
}

process.exit(code);
