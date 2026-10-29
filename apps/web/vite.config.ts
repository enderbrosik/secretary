import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.VITE_DEV_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom' },
});
