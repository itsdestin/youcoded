/**
 * The hosts answer a failed tag read as a failure, not as an empty registry.
 *
 * Error inventory 2026-09-10, false message 16 — the host half. Main's `tags:list`
 * handler did `if (!reg) return []; try { return await reg.list(); } catch { return []; }`
 * and remote-server's did `reg ? await reg.list().catch(() => []) : []`, so an unreadable
 * or absent registry reached every screen as "this person has no tags". Both now go
 * through listTagsForHost, which answers `{ ok: false, error }` for either failure; the
 * renderer half (tests/tag-list-honest.test.tsx) turns that into "Couldn't load your tags".
 *
 * That both hosts still go through it, with no empty-list fallback, is the workspace
 * ast-grep rules tags-list-no-empty-fallback (+ -remote) — they replaced two source-text
 * cases here (Plan B, 2026-09-16).
 */
import { describe, it, expect, vi } from 'vitest';

const { listImpl } = vi.hoisted(() => ({ listImpl: vi.fn() }));
// No managed roots, so startTagRegistry() without a tagsRoot leaves the registry off —
// the real "tag storage is not available" case.
vi.mock('../src/main/sync-spaces/service', () => ({ getManagedRoots: () => null }));
vi.mock('../src/main/conversations/tag-registry', () => ({
  createTagRegistry: () => ({ list: () => listImpl() }),
}));

import { listTagsForHost, startTagRegistry } from '../src/main/conversations/tag-registry-service';

const TAG = { id: 't1', label: 'Research', color: 'tag-gray', archived: false, createdAt: '2026-09-01T00:00:00.000Z' };

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
