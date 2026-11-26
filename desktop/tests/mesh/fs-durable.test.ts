import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncDir } from '../../src/main/mesh/fs-durable';

// A failed directory fsync means a rename or a new file may not survive a crash, so outside Windows it must fail loudly
// (the old catch swallowed every error, including a real one). Windows cannot open a directory at all; there it is ignored.
describe('mesh syncDir', () => {
  it.skipIf(process.platform === 'win32')('syncs a folder that exists', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-syncdir-'));
    try { await expect(syncDir(d)).resolves.toBeUndefined(); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform === 'win32')('fails loudly when the folder cannot be opened (not swallowed)', async () => {
    await expect(syncDir(path.join(os.tmpdir(), 'mesh-syncdir-does-not-exist-' + process.pid))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
