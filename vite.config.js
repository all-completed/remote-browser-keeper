import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ONE HTML entry, for the ONE Electron window (issue #28). Built to ../renderer-dist;
// loaded by main.js. base: './' so the built assets resolve under file:// (Electron loadFile).
export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../renderer-dist',
    // One bundle for the whole window (rsuite + the shell), loaded from disk: no network
    // to split it for.
    chunkSizeWarningLimit: 1500,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'ui/app.html'),
      },
    },
  },
  server: { port: 5173 },
});
