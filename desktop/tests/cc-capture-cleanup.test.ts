// Pins removeTempTree: the drift check's cleanup must never crash the run.
// WHY: on its first CI run (2026-09-24) the daily startup-dialog drift check
// captured everything correctly, then died with ENOTEMPTY removing its temp
// HOME because Claude Code's background marketplace clone was still writing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTempTree } from '../test-conpty/cc-capture-lib.mjs';

afterEach(() => vi.restoreAllMocks());

describe('removeTempTree', () => {
  it('retries while a writer is still busy, then removes the folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cleanup-'));
    const real = fs.rmSync;
    let calls = 0;
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
      return real(p, o);
    }) as typeof fs.rmSync);
    await expect(removeTempTree(dir, { delayMs: 1 })).resolves.toBe(true);
    expect(calls).toBe(3);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('gives up with a warning instead of throwing when the folder never goes', async () => {
    vi.spyOn(fs, 'rmSync').mockImplementation((() => {
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    }) as typeof fs.rmSync);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(removeTempTree('/nonexistent/cc-cleanup', { attempts: 3, delayMs: 1 })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
});
