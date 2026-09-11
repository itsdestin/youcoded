/**
 * The hosts answer a failed tag read as a failure, not as an empty registry.
 *
 * Error inventory 2026-09-10, false message 16 — the host half. Main's `tags:list`
 * handler did `if (!reg) return []; try { return await reg.list(); } catch { return []; }`
 * and remote-server's did `reg ? await reg.list().catch(() => []) : []`, so an unreadable
 * or absent registry reached every screen as "this person has no tags". Both now go
 * through listTagsForHost, which answers `{ ok: false, error }` for either failure; the
 * renderer half (tests/tag-list-honest.test.tsx) turns that into "Couldn't load your tags".
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { readStripped } from './helpers/guard-scope';

const { listImpl } = vi.hoisted(() => ({ listImpl: vi.fn() }));
// No managed roots, so startTagRegistry() without a tagsRoot leaves the registry off —
// the real "tag storage is not available" case.
vi.mock('../src/main/sync-spaces/service', () => ({ getManagedRoots: () => null }));
vi.mock('../src/main/conversations/tag-registry', () => ({
  createTagRegistry: () => ({ list: () => listImpl() }),
}));

import { listTagsForHost, startTagRegistry } from '../src/main/conversations/tag-registry-service';

const TAG = { id: 't1', label: 'Research', color: 'tag-gray', archived: false, createdAt: '2026-09-01T00:00:00.000Z' };
const MAIN = join(__dirname, '..', 'src', 'main');

/** The source of one handler: from its opening marker to the next sibling marker. */
function handlerSource(file: string, open: string, next: RegExp): string {
  const src = readStripped(join(MAIN, file));
  const start = src.indexOf(open);
  expect(start, `${open} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + open.length);
  const end = rest.search(next);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('listTagsForHost', () => {
  it('answers a failure, not [], when tag storage is not available', async () => {
    startTagRegistry();
    const answer = await listTagsForHost();
    expect(Array.isArray(answer)).toBe(false);
    expect(answer).toEqual({ ok: false, error: expect.any(String) });
  });

  it('answers the registry\'s own error, not [], when the read throws', async () => {
    startTagRegistry({ tagsRoot: '/tmp/youcoded-test-tags' });
    listImpl.mockRejectedValueOnce(new Error("EACCES: permission denied, open '/tmp/youcoded-test-tags/tags.json'"));
    expect(await listTagsForHost()).toEqual({ ok: false, error: "EACCES: permission denied, open '/tmp/youcoded-test-tags/tags.json'" });
  });

  it('answers the list itself when the read works', async () => {
    startTagRegistry({ tagsRoot: '/tmp/youcoded-test-tags' });
    listImpl.mockResolvedValueOnce([TAG]);
    expect(await listTagsForHost()).toEqual([TAG]);
  });
});

describe('both hosts use it', () => {
  it('main\'s tags:list handler answers through listTagsForHost, with no empty-list fallback', () => {
    const body = handlerSource('ipc-handlers.ts', 'ipcMain.handle(IPC.TAGS_LIST', /ipcMain\.handle\(/);
    expect(body).toContain('listTagsForHost(');
    expect(body).not.toMatch(/return\s*\[\s*\]/);
  });

  it('remote-server\'s tags:list case answers through listTagsForHost, with no empty-list fallback', () => {
    const body = handlerSource('remote-server.ts', "case 'tags:list':", /case '/);
    expect(body).toContain('listTagsForHost(');
    expect(body).not.toMatch(/catch\(\s*\(\)\s*=>\s*\[\s*\]\s*\)/);
    expect(body).not.toMatch(/:\s*\[\s*\]\s*;/);
  });
});
