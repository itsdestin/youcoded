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

  // 2026-09-16 smoothness sweep, Batch C. Each runs per turn or per click.
  it('accepted-history publish() and its incremental reader (per turn boundary)', () => {
    const src = read('harness/accepted-history-store.ts');
    const reader = src.indexOf('class IncrementalTranscriptReader');
    expect(reader).toBeGreaterThan(0);
    expect(src.slice(reader, src.indexOf('\n}\n', reader))).not.toMatch(SYNC_FS);
    const publish = src.indexOf('async publish(');
    expect(publish).toBeGreaterThan(0);
    expect(src.slice(publish, src.indexOf('\n  }\n', publish))).not.toMatch(SYNC_FS);
    const write = src.indexOf('private async atomicWrite(');
    expect(write).toBeGreaterThan(0);
    expect(src.slice(write, src.indexOf('\n  }\n', write))).not.toMatch(SYNC_FS);
  });

  function methodBody(src: string, signature: string): string {
    const start = src.indexOf(signature);
    expect(start, `${signature} not found`).toBeGreaterThan(0);
    return src.slice(start, src.indexOf('\n  }\n', start));
  }

  it('native history reads the IPC handlers use (per scroll-up page, per tear-off)', () => {
    expect(methodBody(read('native-home.ts'), 'async readSessionLinesAsync(')).not.toMatch(SYNC_FS);
    expect(methodBody(read('harness/session-store.ts'), 'async readEventsAsync(')).not.toMatch(SYNC_FS);
    const host = read('harness/native-session-host.ts');
    expect(methodBody(host, 'async getHistoryAsync(')).not.toMatch(SYNC_FS);
    expect(methodBody(host, 'async getHistoryPageAsync(')).not.toMatch(SYNC_FS);
    expect(methodBody(host, 'isLive(')).not.toMatch(/readEvents|getHistory/);
  });

  it('the Resume list (per click: every native session file listed and head-read)', () => {
    const home = read('native-home.ts');
    expect(methodBody(home, 'async listSessionFilesAsync(')).not.toMatch(SYNC_FS);
    expect(methodBody(home, 'async readSessionHeadAsync(')).not.toMatch(SYNC_FS);
    const store = read('harness/session-store.ts');
    expect(methodBody(store, 'async listAsync(')).not.toMatch(/readSessionHead\(|listSessionFiles\(/);
    // The IPC and remote list handlers must use the async form.
    expect(read('ipc-handlers.ts')).not.toMatch(/nativeHost\.list\(\)/);
    expect(read('remote-server.ts')).not.toMatch(/nativeHost\.list\(\)/);
  });

  it('the three per-session polls: status push (10 s), topic name (2 s), transcript safety poll (2 s)', () => {
    const ipc = read('ipc-handlers.ts');
    expect(methodBody(ipc, 'async function buildStatusData(')).not.toMatch(SYNC_FS);
    expect(methodBody(ipc, 'async function readTopicFile(')).not.toMatch(SYNC_FS);
    expect(methodBody(ipc, 'function startPolling(')).not.toMatch(SYNC_FS);
    expect(methodBody(ipc, 'function attachTopicWatch(')).not.toMatch(SYNC_FS);
    const watcher = read('transcript-watcher.ts');
    expect(methodBody(watcher, 'private ensureGlobalPoll(')).not.toMatch(SYNC_FS);
  });

  it("the model's file tools — Glob's walk, Read, Edit, Write (several times per turn)", () => {
    const glob = read('harness/tools/glob.ts');
    const walk = glob.indexOf('const walk = async (');
    expect(walk).toBeGreaterThan(0);
    expect(glob.slice(walk, glob.indexOf('\n    };\n', walk))).not.toMatch(SYNC_FS);
    // The root probe just above the walk is async too; the one sync stat left
    // in the file is inside the missing-root hint (error path, one stat).
    expect(glob).toMatch(/await fs\.promises\.stat\(root\)/);
    expect(read('harness/tools/read.ts')).not.toMatch(/\bfs\.readFileSync\s*\(/);
    expect(read('harness/tools/edit.ts')).not.toMatch(SYNC_FS);
    expect(read('harness/tools/write.ts')).not.toMatch(SYNC_FS);
    expect(read('harness/tools/file-fingerprint.ts')).not.toMatch(SYNC_FS);
  });
});
