import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the built game also loads under the desktop
  // shell's app:// origin, not just from a server root.
  base: './',
  // `dist-desktop/` is electron-builder's output. Chromium's watcher holds an
  // open handle on every directory it watches, and on Windows an open
  // directory handle makes `rename()` fail EPERM -- electron-builder extracts
  // the Electron runtime to `win-unpacked.tmp` and renames it into place, so a
  // dev server running anywhere in this tree breaks `npm run desktop:pack`.
  // Not watching the build output costs nothing; it is never a dev source.
  server: {
    port: 5173,
    host: '127.0.0.1',
    watch: { ignored: ['**/dist-desktop/**'] },
  },
  build: { target: 'es2022', sourcemap: true },
});
