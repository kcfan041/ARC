import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 8732,
    proxy: {
      '/api': 'http://127.0.0.1:8730',
      '/ws': { target: 'ws://127.0.0.1:8730', ws: true },
    },
  },
});
