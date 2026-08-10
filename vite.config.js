import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the built game also loads under the desktop
  // shell's app:// origin, not just from a server root.
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true },
});
