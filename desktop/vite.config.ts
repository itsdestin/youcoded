import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  server: {
    port: 5173,
    strictPort: true,
  },
  base: './',
  build: {
    outDir: '../../dist/renderer',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
