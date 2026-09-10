import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard: hot main-process paths never call blocking fs.
// WHY: a blocking fs call on the main thread stalls every window's IPC at once.
// 2026-09-08: the app froze 6+ minutes on a synchronous lease write. Each entry
// here is a path that runs per turn, per timer tick, or per user action.
const MAIN = join(__dirname, '..', 'src', 'main');
const read = (p: string) => readFileSync(join(MAIN, p), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const SYNC_FS = /\bfs\.\w+Sync\s*\(/;

describe('hot main-process paths use fs.promises', () => {
  it('lease client (createLeaseClient body)', () => {
    const src = read('conversations/lease-client.ts');
    const body = src.slice(src.indexOf('export function createLeaseClient'));
    expect(body).not.toMatch(SYNC_FS);
  });
  it('transcript mirror (whole file)', () => {
    expect(read('conversations/transcript-mirror.ts')).not.toMatch(SYNC_FS);
  });
  it('git-transport gitDirSizeBytes', () => {
    const src = read('sync-spaces/git-transport.ts');
    const start = src.indexOf('async gitDirSizeBytes(');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(SYNC_FS);
  });
});
