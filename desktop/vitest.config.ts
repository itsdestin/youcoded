import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    alias: {
      // Stub Electron APIs so main-process imports don't crash in Node.js
      electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
    },
  },
});
