// atomic-write.ts — a reader sees the old whole file or the new whole file, never half; a failed write leaves
// no temp file behind; two overlapping writes to one target do not collide on a temp name.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../src/main/atomic-write';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-atomic-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

describe('atomicWrite', () => {
  it('creates the folder and writes the whole file', async () => {
    const target = path.join(dir, 'deep', 'er', 'file.json');
    await atomicWrite(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['file.json']);
  });

  it('two overlapping writes to one file both succeed and leave one of the two contents whole, with no temp file', async () => {
    const target = path.join(dir, 'file.json');
    await Promise.all([atomicWrite(target, 'first'), atomicWrite(target, 'second')]);
    expect(['first', 'second']).toContain(fs.readFileSync(target, 'utf8'));
    expect(fs.readdirSync(dir)).toEqual(['file.json']);
  });

  it('a failed write rethrows, keeps the old file and removes its temp file', async () => {
    const target = path.join(dir, 'file.json');
    await atomicWrite(target, 'old');
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk trouble'));
    await expect(atomicWrite(target, 'new')).rejects.toThrow('disk trouble');
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['file.json']);
  });
});
