import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// One HTML entry per Electron window. Built to ../renderer-dist; loaded by main.js.
// base: './' so the built assets resolve under file:// (Electron loadFile).
export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        prompt: resolve(__dirname, 'ui/prompt.html'),
        history: resolve(__dirname, 'ui/history.html'),
        cards: resolve(__dirname, 'ui/cards.html'),
        image: resolve(__dirname, 'ui/image.html'),
        savedfields: resolve(__dirname, 'ui/savedfields.html'),
      },
    },
  },
  server: { port: 5173 },
});
