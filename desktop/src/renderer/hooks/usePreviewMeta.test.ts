// @vitest-environment jsdom
//
// usePreviewMeta backs the preview header's tag/note sheet (spec
// 2026-08-26-conversation-preview-header-design.md, A1). Component-level
// coverage of the sheet itself lives in
// tests/SessionDrawer.test.tsx; this file pins the hook's own
// contract in isolation — load, optimistic apply, and rollback on a refused
// write, mirroring ResumeBrowser.tsx's toggleTag/saveNote.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { usePreviewMeta } from './usePreviewMeta';

afterEach(() => { cleanup(); delete (window as any).claude; });

describe('usePreviewMeta', () => {
  it('loads tags and note via session:get-meta for the given id', async () => {
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: ['tag_a'], note: 'hello', supported: true, flags: {} }) },
    };
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toEqual(['tag_a']);
    expect(result.current.note).toBe('hello');
  });

  it('is a no-op (no IPC call, empty state) when id is null', async () => {
    const getMeta = vi.fn();
    (window as any).claude = { session: { getMeta } };
    const { result } = renderHook(() => usePreviewMeta(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.tags).toEqual([]);
    expect(result.current.note).toBe('');
    expect(getMeta).not.toHaveBeenCalled();
  });

  it('degrades to the empty state instead of throwing when window.claude.session is absent', async () => {
    (window as any).claude = {};
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tags).toEqual([]);
    expect(result.current.note).toBe('');
  });

  it('applies a tag optimistically and keeps it applied once setTag confirms — positive control', async () => {
    const setTag = vi.fn().mockResolvedValue({ ok: true });
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }), setTag },
    };
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.toggleTag('tag_a', true); });
    expect(result.current.tags).toEqual(['tag_a']);
    expect(setTag).toHaveBeenCalledWith('conv-1', 'tag_a', true);
  });

  it('rolls back an optimistic tag apply when setTag reports {ok:false} — negative case for the test above', async () => {
    const setTag = vi.fn().mockResolvedValue({ ok: false });
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }), setTag },
    };
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.toggleTag('tag_a', true); });
    // A refused write must not look like it succeeded.
    expect(result.current.tags).toEqual([]);
  });

  it('rolls back a tag apply when setTag throws', async () => {
    const setTag = vi.fn().mockRejectedValue(new Error('offline'));
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', supported: true, flags: {} }), setTag },
    };
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.toggleTag('tag_a', true); });
    expect(result.current.tags).toEqual([]);
  });

  it('saves a note optimistically and keeps it once setNote confirms — positive control', async () => {
    const setNote = vi.fn().mockResolvedValue({ ok: true });
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: 'old', supported: true, flags: {} }), setNote },
    };
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.saveNote('new'); });
    expect(result.current.note).toBe('new');
    expect(setNote).toHaveBeenCalledWith('conv-1', 'new');
  });

  it('rolls back a note edit when setNote reports {ok:false}', async () => {
    const setNote = vi.fn().mockResolvedValue({ ok: false });
    (window as any).claude = {
      session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: 'old', supported: true, flags: {} }), setNote },
    };
    const { result } = renderHook(() => usePreviewMeta('conv-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.saveNote('new'); });
    expect(result.current.note).toBe('old');
  });
});
