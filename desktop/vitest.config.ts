import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Fix: include the React plugin so TSX test files (JSX transform) compile correctly
  plugins: [react()],
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    // Fix: use jsdom for .tsx test files (React components) so DOM APIs are available;
    // plain .ts files (main-process logic) stay in 'node' via environmentMatchGlobs.
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/**/*.tsx', 'jsdom'],
    ],
    alias: {
      // Stub Electron APIs so main-process imports don't crash in Node.js
      electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
    },
  },
});
