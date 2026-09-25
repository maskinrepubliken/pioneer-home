import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Relative asset paths so the engine can serve dist/ from `/` (or any prefix).
export default defineConfig(() => ({
  base: './',
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
}));
