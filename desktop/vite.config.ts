import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// Keep Vite's port in sync with the main process via DESTINCODE_PORT_OFFSET.
// Duplicated (not imported from src/shared/ports.ts) because vite.config runs
// outside the main-process tsconfig.
const portOffset = Number(process.env.DESTINCODE_PORT_OFFSET ?? 0);
const viteDevPort = 5173 + (Number.isFinite(portOffset) ? portOffset : 0);

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  server: {
    port: viteDevPort,
    strictPort: true,
  },
  base: './',
  build: {
    outDir: '../../dist/renderer',
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __PARTYKIT_HOST__: JSON.stringify(process.env.VITE_PARTYKIT_HOST ?? null),
  },
});
