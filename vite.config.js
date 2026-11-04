import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two HTML entries, one per Electron window: the main window (issue #28) and the small
// approval window (issue #34). Built to ../renderer-dist; loaded by main.js. base: './' so the built assets resolve under file:// (Electron loadFile).
export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../renderer-dist',
    // Loaded from disk: no network to split the bundles for.
    chunkSizeWarningLimit: 1500,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'ui/app.html'),
        approval: resolve(__dirname, 'ui/approval.html'),
      },
    },
  },
  server: { port: 5173 },
});
