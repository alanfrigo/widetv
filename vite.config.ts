import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // A barra final e obrigatoria: com '/api' o proxy casa por prefixo e
      // sequestra o proprio modulo '/api.ts' do frontend.
      '/api/': 'http://localhost:8080',
    },
  },
});
