import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Keep the in-app installer request and push surface in parity across bridges.
// Add a channel here first to prove that missing plumbing is detected.
const CHANNELS = [
  'update:download',
  'update:cancel',
  'update:launch',
  'update:progress',
  'update:install-progress',
  'update:get-cached-download',
  'update:get-beta-channel',
  'update:set-beta-channel',
];

const ROOT = path.join(__dirname, '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('in-app update installer IPC parity', () => {
  const preload = read('src/main/preload.ts');
  const shim    = read('src/renderer/remote-shim.ts');
  // WHY (2026-09-30 one-core R3-2): the handlers are channel-table entries (main/ipc/update.ts,
  // by IPC constant); the progress push is sent by update-service.ts.
  const handler = read('src/main/ipc/update.ts') + read('src/main/update-service.ts');
  const constFor = (ch: string) => 'IPC.' + ch.toUpperCase().replace(/[:-]/g, '_');

  for (const channel of CHANNELS) {
    it(`preload.ts references "${channel}"`, () => {
      expect(preload).toContain(channel);
    });
    it(`remote-shim.ts references "${channel}"`, () => {
      expect(shim).toContain(channel);
    });
    it(`the host references "${channel}"`, () => {
      expect(handler).toContain(channel === 'update:progress' || channel === 'update:install-progress' ? channel : constFor(channel));
    });
  }
});
