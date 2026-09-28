// The Resume list remembers each conversation file's answer across restarts,
// keyed by the file's size and modified time (scan-cache.ts). These pin the
// promises that make that safe: a changed file is never served from memory,
// and a damaged or foreign cache file is ignored rather than trusted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createScanCache } from '../src/main/scan-cache';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cache-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('createScanCache', () => {
  const stat = { size: 10, mtimeMs: 1000.5 };

  it('an answer saved by one app run is served to the next', async () => {
    const file = path.join(dir, 'c.json');
    const a = createScanCache<string>(file, 1);
    await a.get('k', stat);                  // loads (empty)
    a.set('k', stat, 'remembered');
    await a.flush();
    const b = createScanCache<string>(file, 1);
    expect(await b.get('k', stat)).toBe('remembered');
  });

  it('a file whose size or modified time changed is not served from memory', async () => {
    const file = path.join(dir, 'c.json');
    const a = createScanCache<string>(file, 1);
    await a.get('k', stat);
    a.set('k', stat, 'old');
    expect(await a.get('k', { ...stat, size: 11 })).toBeUndefined();
    expect(await a.get('k', { ...stat, mtimeMs: 1000.6 })).toBeUndefined();
    expect(await a.get('k', stat)).toBe('old');
  });

  it('a damaged cache file, or one written by a different version, is ignored', async () => {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, '{ not json');
    expect(await createScanCache<string>(file, 1).get('k', stat)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ schema: 2, entries: { k: { ...stat, v: 'from v2' } } }));
    expect(await createScanCache<string>(file, 1).get('k', stat)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: { k: { ...stat, v: 'from v1' } } }));
    expect(await createScanCache<string>(file, 1).get('k', stat)).toBe('from v1');
  });

  it('prune forgets files a scan no longer found', async () => {
    const file = path.join(dir, 'c.json');
    const a = createScanCache<string>(file, 1);
    await a.get('x', stat);
    a.set('gone', stat, 'g'); a.set('kept', stat, 'k');
    a.prune(new Set(['kept']));
    await a.flush();
    const b = createScanCache<string>(file, 1);
    expect(await b.get('gone', stat)).toBeUndefined();
    expect(await b.get('kept', stat)).toBe('k');
  });
});

describe('native Resume list across an app restart', () => {
  const header = (id: string, extra: Partial<NativeSessionHeader> = {}): NativeSessionHeader => ({
    v: 1, sessionId: id, harnessId: 'chat', binding: { providerId: 'p', modelId: 'm' },
    cwd: '/home/u/proj', createdAt: 1720600000000, ...extra,
  });

  it('a restarted app lists the same rows without re-reading unchanged files, and re-reads a changed one', async () => {
    const home = new NativeHome(dir);
    const first = new SessionStore(home);
    await first.create(header('s-1', { title: 'One' }));
    await first.create(header('s-2', { title: 'Two' }));
    await first.create(header('child', { parentSessionId: 's-1', sessionKind: 'specialist' } as Partial<NativeSessionHeader>));
    const before = await first.listAsync();
    expect(before.map((r) => r.sessionId).sort()).toEqual(['s-1', 's-2']);
    expect((await first.listAsync({ includeChildren: true })).length).toBe(3);
    await (first as unknown as { listCache(): { flush(): Promise<void> } }).listCache().flush();

    // "Restart": a new store over the same home. Unchanged files must come from the cache.
    const second = new SessionStore(home);
    const reads = vi.spyOn(home, 'readSessionHeadAsync');
    expect((await second.listAsync()).map((r) => [r.sessionId, r.title])).toEqual(before.map((r) => [r.sessionId, r.title]));
    expect(reads).not.toHaveBeenCalled();

    // A changed file is read again, and the new answer shows.
    const file = home.sessionFilePath('-home-u-proj', 's-2');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), title: 'Renamed two' });
    fs.writeFileSync(file, lines.join('\n'));
    const after = await second.listAsync();
    expect(after.find((r) => r.sessionId === 's-2')?.title).toBe('Renamed two');
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
