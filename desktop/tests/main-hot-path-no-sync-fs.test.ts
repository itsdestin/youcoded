import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { readStripped } from './helpers/guard-scope';

// Guard: hot main-process paths never call blocking fs.
// WHY: a blocking fs call on the main thread stalls every window's IPC at once.
// 2026-09-08: the app froze 6+ minutes on a synchronous lease write. Each entry
// here is a path that runs per turn, per timer tick, or per user action.
const MAIN = join(__dirname, '..', 'src', 'main');
// WHY readStripped: the shared comment stripper every source-text guard uses
// (test-suite-hygiene.md) — WHY comments quoting the old `fs.*Sync` calls must not
// trip this guard, and a private copy of the stripper is how guards drift apart.
// CRLF is still normalized so the '\n  }\n' body-end search works on a Windows checkout.
const read = (p: string) => readStripped(join(MAIN, p)).replace(/\r\n/g, '\n');
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
