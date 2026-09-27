// @vitest-environment jsdom
// T5 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §7): the renderer's `useDocComments` hook against a FAKE
// `window.claude.docComments` bridge — pins that the rewrite onto real IPC
// (list/watch/mutate/reconcile/refuse/roll back) behaves as designed, while
// `tests/ReadingHighlights.test.tsx` (unmodified by this task) is the proof
// that the public hook API itself didn't move.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  __resetDocCommentsStoreForTest,
  addComment,
  resolveComment,
  useDocComments,
} from '../src/renderer/state/doc-comments-store';

type ListResult = { ok: true; comments: any[] } | { ok: false; error?: string };
type MutationResult = { ok: true; id?: string } | { ok: false; error?: string; field?: string };

function makeFakeIpc() {
  const listeners = new Set<(evt: { path: string }) => void>();
  const ipc = {
    list: vi.fn(async (_path: string, _projectRoot?: string): Promise<ListResult> => ({ ok: true, comments: [] })),
    add: vi.fn(async (_path: string, _selector: unknown, _text: string, _author: string, _projectRoot?: string): Promise<MutationResult> => ({ ok: true, id: `server-${Math.random().toString(36).slice(2, 8)}` })),
    reply: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    resolve: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    reopen: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    move: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    watch: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    unwatch: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    onChanged: vi.fn((cb: (evt: { path: string }) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
  };
  return { ipc, emitChanged: (path: string) => listeners.forEach((cb) => cb({ path })) };
}

function installIpc() {
  const { ipc, emitChanged } = makeFakeIpc();
  (window as any).claude = { docComments: ipc };
  return { ipc, emitChanged };
}

afterEach(() => {
  __resetDocCommentsStoreForTest();
  delete (window as any).claude;
  vi.useRealTimers();
});

describe('useDocComments — list on open, watch while mounted', () => {
  it('calls docComments:list on mount and hydrates from the response', async () => {
    const { ipc } = installIpc();
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-1', path: 'a.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'hello', prefix: '', suffix: '', occurrence: 0 } },
        text: 'note', author: 'user', createdAt: 1, replies: [], resolved: false, history: [],
      }],
    });
    const { result } = renderHook(() => useDocComments('a.md', '/proj'));
    expect(ipc.list).toHaveBeenCalledWith('a.md', '/proj');
    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0]).toMatchObject({ id: 'c-1', quote: 'hello', text: 'note' });
  });

  it('subscribes once per path (refcounted) and unwatches only once the last viewer unmounts', async () => {
    const { ipc } = installIpc();
    const first = renderHook(() => useDocComments('shared.md', '/proj'));
    await waitFor(() => expect(ipc.watch).toHaveBeenCalledTimes(1));
    const second = renderHook(() => useDocComments('shared.md', '/proj'));
    // A second viewer on the SAME path does not re-subscribe.
    expect(ipc.watch).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(ipc.unwatch).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));
  });

  it('a docComments:changed push for a path with a live viewer re-lists it', async () => {
    const { ipc, emitChanged } = installIpc();
    const { result } = renderHook(() => useDocComments('watched.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(1));
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-2', path: 'watched.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'new', prefix: '', suffix: '', occurrence: 0 } },
        text: 'from elsewhere', author: 'assistant', createdAt: 2, replies: [], resolved: false, history: [],
      }],
    });
    act(() => emitChanged('watched.md'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.comments.some((c) => c.id === 'c-2')).toBe(true));
  });

  it('a docComments:changed push for a path nobody has open is ignored', async () => {
    const { ipc, emitChanged } = installIpc();
    renderHook(() => useDocComments('open.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(1));
    act(() => emitChanged('closed.md'));
    // No second list() call for a file nothing is watching.
    expect(ipc.list).toHaveBeenCalledTimes(1);
  });
});

describe('useDocComments — mutations, optimistic id reconciliation, refusal + rollback', () => {
  it('addComment is optimistic and synchronous even with no IPC bridge at all', () => {
    // No window.claude installed — this is exactly what
    // tests/ReadingHighlights.test.tsx already relies on; pinned again here
    // directly against the free function.
    delete (window as any).claude;
    const id = addComment('no-bridge.md', 'quote', 'no-bridge.md');
    expect(id).toBeTruthy();
  });

  it('setCommentText debounces a single docComments:add with the final text, and swaps the id on success', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('draft.md', '/proj'));
    let id = '';
    act(() => { id = result.current.addComment('the quote', 'draft.md'); });
    expect(result.current.comments.map((c) => c.id)).toEqual([id]);
    act(() => { result.current.setCommentText(id, 'h'); });
    act(() => { result.current.setCommentText(id, 'he'); });
    act(() => { result.current.setCommentText(id, 'hello'); });
    // Still nothing sent — every keystroke reschedules the debounce rather
    // than firing docComments:add per character (performance.md rule 5).
    expect(ipc.add).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.add).toHaveBeenCalledTimes(1);
    expect(ipc.add).toHaveBeenCalledWith('draft.md', expect.objectContaining({ kind: 'text' }), 'hello', 'user', '/proj');
    // The server mints its own id (doc-comments-store.ts's addComment) — the
    // renderer's temporary id is swapped for it, never duplicated.
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0].id).not.toBe(id);
    expect(result.current.comments[0].text).toBe('hello');
  });

  it('a docComments:changed refresh that lands its own server copy WHILE add() is still in flight never leaves a duplicate', async () => {
    // Pins an end-to-end bug found reviewing this against the real workbench
    // (2026-09-27): the mock's own `add()` fires `docComments:changed`
    // SYNCHRONOUSLY before it resolves, so this window's own `list()`
    // refresh can pick up the just-added comment (under its REAL server id)
    // before this window's own `add()` promise — and this store's id-swap —
    // ever resolves. Renaming the local placeholder unconditionally at that
    // point created a SECOND element with the same id (a React duplicate-key
    // crash). See `persistNewComment`'s own WHY.
    vi.useFakeTimers();
    const { ipc, emitChanged } = installIpc();
    const { result } = renderHook(() => useDocComments('race.md', '/proj'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let id = '';
    act(() => { id = result.current.addComment('the quote', 'race.md'); });
    act(() => { result.current.setCommentText(id, 'racing'); });

    // `ipc.add` is held open (a manually-resolved promise) so the test can
    // land the `docComments:changed` refresh BEFORE it resolves — the exact
    // ordering that produced the duplicate.
    let resolveAdd!: (v: { ok: true; id: string }) => void;
    ipc.add.mockReturnValueOnce(new Promise((resolve) => { resolveAdd = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); }); // fires the debounce -> ipc.add() (still pending)
    expect(ipc.add).toHaveBeenCalledTimes(1);

    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'server-won-the-race', path: 'race.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'the quote', prefix: '', suffix: '', occurrence: 0 } },
        text: 'racing', author: 'user', createdAt: 5, replies: [], resolved: false, history: [],
      }],
    });
    // Fake timers are active, so `waitFor`'s own real-timer polling can't
    // make progress here — flush the `list()` promise chain directly instead.
    await act(async () => { emitChanged('race.md'); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.comments.some((c) => c.id === 'server-won-the-race')).toBe(true);

    // NOW let the in-flight add() resolve with the SAME server id.
    await act(async () => { resolveAdd({ ok: true, id: 'server-won-the-race' }); await Promise.resolve(); });
    const ids = result.current.comments.map((c) => c.id);
    expect(ids).toEqual(['server-won-the-race']); // never duplicated
  });

  it('never calls docComments:add while the draft text is still empty', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('empty-draft.md', '/proj'));
    act(() => { result.current.addComment('quote', 'empty-draft.md'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(ipc.add).not.toHaveBeenCalled();
  });

  it('addReply calls docComments:reply with the comment’s own path, and rolls back with a toast on refusal', async () => {
    const { ipc } = installIpc();
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-1', path: 'thread.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
        text: 'note', author: 'user', createdAt: 1, replies: [], resolved: false, history: [],
      }],
    });
    const { result } = renderHook(() => useDocComments('thread.md', '/proj'));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    ipc.reply.mockResolvedValueOnce({ ok: false, error: 'comment-not-found' });
    act(() => { result.current.addReply('c-1', 'user', 'a reply'); });
    // Optimistic: the reply is visible immediately.
    expect(result.current.comments[0].replies).toHaveLength(1);
    expect(ipc.reply).toHaveBeenCalledWith('thread.md', 'c-1', 'a reply', 'user', '/proj');
    await waitFor(() => expect(result.current.comments[0].replies).toHaveLength(0));
    expect(result.current.lastError?.message).toBe("This comment couldn't be found anymore.");
  });

  it('resolveComment / reopenComment round-trip through the real channels and honor Retry', async () => {
    const { ipc } = installIpc();
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-1', path: 'resolve.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
        text: 'note', author: 'user', createdAt: 1, replies: [], resolved: false, history: [],
      }],
    });
    const { result } = renderHook(() => useDocComments('resolve.md', '/proj'));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    ipc.resolve.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { resolveComment('c-1', 'user'); });
    expect(result.current.comments[0].resolved).toBe(true); // optimistic
    await waitFor(() => expect(result.current.comments[0].resolved).toBe(false)); // rolled back
    expect(result.current.lastError?.onRetry).toBeTypeOf('function');
    ipc.resolve.mockResolvedValueOnce({ ok: true });
    act(() => { result.current.lastError!.onRetry(); });
    await waitFor(() => expect(result.current.comments[0].resolved).toBe(true));
    expect(ipc.resolve).toHaveBeenCalledTimes(2);
  });

  it('clearFocus flushes a pending debounced persist immediately instead of waiting it out', async () => {
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('flush.md', '/proj'));
    act(() => { result.current.addComment('q', 'flush.md'); });
    act(() => { result.current.setCommentText(result.current.comments[0].id, 'typed fast'); });
    act(() => { result.current.clearFocus(); });
    await waitFor(() => expect(ipc.add).toHaveBeenCalledTimes(1));
    expect(ipc.add).toHaveBeenCalledWith('flush.md', expect.anything(), 'typed fast', 'user', '/proj');
  });
});

describe('useDocComments — no re-render storms (performance.md rule 3)', () => {
  it('a mutation on one path does not re-render a hook mounted on a different path', async () => {
    const { ipc } = installIpc();
    let rendersB = 0;
    const hookB = renderHook(() => { rendersB += 1; return useDocComments('path-b.md', '/proj'); });
    await waitFor(() => expect(ipc.list).toHaveBeenCalledWith('path-b.md', '/proj'));
    const rendersAfterMount = rendersB;

    const hookA = renderHook(() => useDocComments('path-a.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledWith('path-a.md', '/proj'));

    act(() => { hookA.result.current.addComment('quote', 'path-a.md'); });
    act(() => { resolveComment(hookA.result.current.comments[0]?.id ?? 'missing', 'user'); });

    // path-b's hook never re-rendered from path-a's own changes.
    expect(rendersB).toBe(rendersAfterMount);
    expect(hookB.result.current.comments).toHaveLength(0);
  });
});
