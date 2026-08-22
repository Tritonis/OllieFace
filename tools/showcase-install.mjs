#!/usr/bin/env node
/**
 * Put the effects showcase into a packed build for an evaluation session.
 *
 * The tension issue #144 leaves for whoever implements it: the showcase must
 * "run in the packaged build", and the showcase file must be "excluded from
 * the pack list the same way, with the guard proving it". Both, at once, only
 * make sense if the exclusion governs what *players* receive and the
 * evaluation build is assembled by hand afterwards. That is this script: pack
 * normally, then copy the one refused chunk into the artifact.
 *
 *   npm run build && npm run desktop:pack
 *   node tools/showcase-install.mjs
 *
 * It fails loudly rather than half-installing, because an evaluation session
 * that quietly ran against a showcase-less build would look exactly like a
 * session where Shift+F9 is broken.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = join('dist', 'assets', 'showcase.js');
const src = join(root, CHUNK);
const app = join(root, 'dist-desktop', 'win-unpacked', 'resources', 'app');

const die = (msg) => { console.error(`showcase-install: ${msg}`); process.exit(1); };

if (!existsSync(src)) die(`${CHUNK} is missing — run \`npm run build\` first.`);
if (!existsSync(app)) die('dist-desktop/win-unpacked/resources/app is missing — run `npm run desktop:pack` first.');

const dest = join(app, CHUNK);
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`showcase-install: installed -> ${dest}`);
console.log('Launch the packed exe and press Shift+F9.');
