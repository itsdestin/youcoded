import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// These five strings are the entire in-app-update IPC surface. If you add a
// sixth, add it here first and the test will tell you which files haven't
// been updated yet.
const CHANNELS = [
  'update:download',
  'update:cancel',
  'update:launch',
  'update:progress',
  'update:get-cached-download',
];

const ROOT = path.join(__dirname, '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('in-app update installer IPC parity', () => {
  const preload = read('src/main/preload.ts');
  const shim    = read('src/renderer/remote-shim.ts');
  const handler = read('src/main/ipc-handlers.ts');
  const android = read('../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');

  for (const channel of CHANNELS) {
    it(`preload.ts references "${channel}"`, () => {
      expect(preload).toContain(channel);
    });
    it(`remote-shim.ts references "${channel}"`, () => {
      expect(shim).toContain(channel);
    });
    it(`ipc-handlers.ts references "${channel}"`, () => {
      expect(handler).toContain(channel);
    });
    it(`SessionService.kt references "${channel}"`, () => {
      expect(android).toContain(channel);
    });
  }
});
