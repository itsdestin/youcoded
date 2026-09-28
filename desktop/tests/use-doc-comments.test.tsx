// @vitest-environment jsdom
// T5 of the doc-comments build (docs/active/specs/2026-09-26-doc-comments-
// build-design.md §7): the renderer's `useDocComments` hook against a FAKE
// `window.claude.docComments` bridge — pins that the rewrite onto real IPC
// (list/watch/mutate/reconcile/refuse/roll back) behaves as designed, while
// `tests/ReadingHighlights.test.tsx` (unmodified by this task) is the proof
// that the public hook API itself didn't move.
//
// T5 IMPLEMENTATION REVIEW additions (2026-09-27): F3 (two projects sharing a
// relative path must never merge), F5 (a pending debounced persist must not
// fire after the viewer unmounts), F6 (a hidden-but-mounted viewer pauses its
// watch), F7 (a failure lands on the COMMENT, not a page-level toast), F8
// (an unused (project,path) entry is pruned), F9 (a stale rollback never
// clobbers a newer server-truth refresh).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  __resetDocCommentsStoreForTest,
  addComment,
  resolveComment,
  useDocComments,
} from '../src/renderer/state/doc-comments-store';
import { OnScreenContext } from '../src/renderer/state/on-screen-context';

type ListResult = { ok: true; comments: any[] } | { ok: false; error?: string };
type MutationResult = { ok: true; id?: string; reply?: any } | { ok: false; error?: string; field?: string };

function makeFakeIpc() {
  const listeners = new Set<(evt: { path: string; projectRoot?: string }) => void>();
  const ipc = {
    list: vi.fn(async (_path: string, _projectRoot?: string): Promise<ListResult> => ({ ok: true, comments: [] })),
    // F4 (T5 review): the real server now echoes the CALLER's id back — the
    // default fake mirrors that (a specific test below overrides this to
    // exercise the docx/xlsx-style "server mints its own, different, id"
    // reconciliation path, which is still a real, supported case).
    add: vi.fn(async (_path: string, _selector: unknown, _text: string, _author: string, _projectRoot?: string, id?: string): Promise<MutationResult> => ({ ok: true, id })),
    reply: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    resolve: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    reopen: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    move: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    watch: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    unwatch: vi.fn(async (): Promise<MutationResult> => ({ ok: true })),
    onChanged: vi.fn((cb: (evt: { path: string; projectRoot?: string }) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
  };
  return { ipc, emitChanged: (path: string, projectRoot?: string) => listeners.forEach((cb) => cb({ path, projectRoot })) };
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
    act(() => emitChanged('watched.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.comments.some((c) => c.id === 'c-2')).toBe(true));
  });

  it('a docComments:changed push for a path nobody has open is ignored', async () => {
    const { ipc, emitChanged } = installIpc();
    renderHook(() => useDocComments('open.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(1));
    act(() => emitChanged('closed.md', '/proj'));
    // No second list() call for a file nothing is watching.
    expect(ipc.list).toHaveBeenCalledTimes(1);
  });

  // F3 (T5 implementation review): every store map is keyed by (projectRoot,
  // path), not bare path — two projects with the same relative filename must
  // never merge comments, misroute a write, or share a watch refcount.
  describe('two projects sharing a relative path never merge (F3)', () => {
    it('keeps each project\'s comments in its own list', async () => {
      const { ipc } = installIpc();
      ipc.list.mockImplementation(async (path: string, projectRoot?: string) => {
        if (path !== 'README.md') return { ok: true, comments: [] };
        if (projectRoot === '/proj-a') {
          return { ok: true, comments: [{ id: 'c-a', path: 'README.md', selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'a', prefix: '', suffix: '', occurrence: 0 } }, text: 'from A', author: 'user', createdAt: 1, replies: [], resolved: false, history: [] }] };
        }
        return { ok: true, comments: [{ id: 'c-b', path: 'README.md', selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'b', prefix: '', suffix: '', occurrence: 0 } }, text: 'from B', author: 'user', createdAt: 1, replies: [], resolved: false, history: [] }] };
      });
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await waitFor(() => expect(a.result.current.comments).toHaveLength(1));
      await waitFor(() => expect(b.result.current.comments).toHaveLength(1));
      expect(a.result.current.comments[0].text).toBe('from A');
      expect(b.result.current.comments[0].text).toBe('from B');
    });

    it('a docComments:changed push for one project\'s copy does not re-list the other\'s', async () => {
      const { ipc, emitChanged } = installIpc();
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(2));
      act(() => emitChanged('README.md', '/proj-a'));
      // Only project A's key re-lists — project B, watching the SAME bare
      // path under a DIFFERENT project, must not see a third list() call.
      await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(3));
      expect(ipc.list).toHaveBeenLastCalledWith('README.md', '/proj-a');
      a.unmount();
      b.unmount();
    });

    it('unwatching one project\'s viewer does not unwatch the other\'s (separate refcounts)', async () => {
      const { ipc } = installIpc();
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await waitFor(() => expect(ipc.watch).toHaveBeenCalledTimes(2));
      a.unmount();
      await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));
      expect(ipc.unwatch).toHaveBeenCalledWith('README.md', '/proj-a');
      // Project B's own subscription is untouched.
      b.unmount();
      await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(2));
      expect(ipc.unwatch).toHaveBeenCalledWith('README.md', '/proj-b');
    });

    it('adding a comment in one project sends the RIGHT projectRoot and never lands in the other\'s list', async () => {
      const { ipc } = installIpc();
      vi.useFakeTimers();
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      let id = '';
      act(() => { id = a.result.current.addComment('quote', 'README.md'); });
      act(() => { a.result.current.setCommentText(id, 'hello from A'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(ipc.add).toHaveBeenCalledWith('README.md', expect.anything(), 'hello from A', 'user', '/proj-a', id);
      expect(a.result.current.comments.map((c) => c.id)).toContain(id);
      expect(b.result.current.comments.map((c) => c.id)).not.toContain(id);
    });
  });
});

describe('useDocComments — mutations, id minting, refusal + inline error (F4/F7)', () => {
  it('addComment is optimistic and synchronous even with no IPC bridge at all', () => {
    // No window.claude installed — this is exactly what
    // tests/ReadingHighlights.test.tsx already relies on; pinned again here
    // directly against the free function.
    delete (window as any).claude;
    const id = addComment('no-bridge.md', 'quote', 'no-bridge.md');
    expect(id).toBeTruthy();
  });

  it('mints the comment id itself (F4) and setCommentText debounces a single docComments:add with the final text and that SAME id', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('draft.md', '/proj'));
    let id = '';
    act(() => { id = result.current.addComment('the quote', 'draft.md'); });
    expect(id).toMatch(/^c-/);
    expect(result.current.comments.map((c) => c.id)).toEqual([id]);
    act(() => { result.current.setCommentText(id, 'h'); });
    act(() => { result.current.setCommentText(id, 'he'); });
    act(() => { result.current.setCommentText(id, 'hello'); });
    // Still nothing sent — every keystroke reschedules the debounce rather
    // than firing docComments:add per character (performance.md rule 5).
    expect(ipc.add).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.add).toHaveBeenCalledTimes(1);
    expect(ipc.add).toHaveBeenCalledWith('draft.md', expect.objectContaining({ kind: 'text' }), 'hello', 'user', '/proj', id);
    // F4: the renderer's own id IS the persisted id from the start — no swap.
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0].id).toBe(id);
    expect(result.current.comments[0].text).toBe('hello');
  });

  it('still reconciles onto a DIFFERENT server-minted id (the docx/xlsx safety net)', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    // A .docx/.xlsx target mints its own id server-side regardless of what
    // the caller sent — this is the one case `res.id !== id` still fires.
    ipc.add.mockResolvedValueOnce({ ok: true, id: 'w-42' });
    const { result } = renderHook(() => useDocComments('brief.docx', '/proj'));
    let id = '';
    act(() => { id = result.current.addComment('the quote', 'brief.docx'); });
    act(() => { result.current.setCommentText(id, 'hello'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0].id).toBe('w-42');
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
    await act(async () => { emitChanged('race.md', '/proj'); await Promise.resolve(); await Promise.resolve(); });
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

  // F7 (T5 implementation review): a failed add KEEPS the draft (so Retry can
  // replay it) and attaches the error to THAT comment, not a page-level toast.
  it('a failed add keeps the draft and attaches the error to it, and Retry replays the same call', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('failed-add.md', '/proj'));
    let id = '';
    act(() => { id = result.current.addComment('the quote', 'failed-add.md'); });
    ipc.add.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { result.current.setCommentText(id, 'hello'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.add).toHaveBeenCalledTimes(1);
    // The draft is STILL there (not silently discarded) with its typed text.
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0].id).toBe(id);
    expect(result.current.comments[0].text).toBe('hello');
    expect(result.current.comments[0].error?.message).toBe('Another change is being saved to this file right now.');

    ipc.add.mockResolvedValueOnce({ ok: true, id });
    // Fake timers are active, so `waitFor`'s own real-timer polling can't
    // make progress here (see the race test above) — flush the promise
    // chain directly instead.
    await act(async () => { result.current.comments[0].error!.onRetry(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.comments[0].error).toBeUndefined();
    expect(ipc.add).toHaveBeenCalledTimes(2);
  });

  it('addReply calls docComments:reply with the comment’s own path, and rolls back with an inline error on refusal', async () => {
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
    expect(result.current.comments[0].error?.message).toBe("This comment couldn't be found anymore.");
  });

  // §7's reconcile rule (design review round 2, F1) — the SAME race
  // `persistNewComment`'s own id-swap guards against, now closed for `reply`
  // too (design review round 3, F2 — the built `addReply` used to be a bare
  // `if (res.ok) return;`).
  describe('addReply reconciles an in-flight optimistic reply against a docComments:changed push', () => {
    function seedOneComment(ipc: ReturnType<typeof makeFakeIpc>['ipc'], path: string) {
      ipc.list.mockResolvedValueOnce({
        ok: true,
        comments: [{
          id: 'c-1', path,
          selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
          text: 'note', author: 'user', createdAt: 1, replies: [], resolved: false, history: [],
        }],
      });
    }

    it('swaps the optimistic local reply id for the real persisted one on success (F2)', async () => {
      const { ipc } = installIpc();
      seedOneComment(ipc, 'thread.md');
      const { result } = renderHook(() => useDocComments('thread.md', '/proj'));
      await waitFor(() => expect(result.current.comments).toHaveLength(1));
      let resolveReply!: (v: MutationResult) => void;
      ipc.reply.mockReturnValueOnce(new Promise((resolve) => { resolveReply = resolve; }));
      act(() => { result.current.addReply('c-1', 'user', 'a reply'); });
      const localId = result.current.comments[0].replies[0].id;
      expect(localId).toMatch(/^r-/);
      await act(async () => {
        resolveReply({ ok: true, reply: { id: 'w-3-r1', author: 'user', text: 'a reply', createdAt: 999 } });
        await Promise.resolve();
      });
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].id).toBe('w-3-r1');
    });

    it('a push landing BEFORE the reply\'s own response resolves never duplicates or loses the reply (interleaving)', async () => {
      const { ipc, emitChanged } = installIpc();
      seedOneComment(ipc, 'race.md');
      const { result } = renderHook(() => useDocComments('race.md', '/proj'));
      await waitFor(() => expect(result.current.comments).toHaveLength(1));

      let resolveReply!: (v: MutationResult) => void;
      ipc.reply.mockReturnValueOnce(new Promise((resolve) => { resolveReply = resolve; }));
      act(() => { result.current.addReply('c-1', 'user', 'hello there'); });
      expect(result.current.comments[0].replies).toHaveLength(1); // optimistic

      // The push's own `list()` refresh already reflects the write (the write
      // succeeded; the watcher's push simply arrived first — a genuine race,
      // not a bug, per §7's own framing).
      ipc.list.mockResolvedValueOnce({
        ok: true,
        comments: [{
          id: 'c-1', path: 'race.md',
          selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
          text: 'note', author: 'user', createdAt: 1, resolved: false, history: [],
          replies: [{ id: 'w-1-r1', author: 'user', text: 'hello there', createdAt: 500 }],
        }],
      });
      await act(async () => { emitChanged('race.md', '/proj'); await Promise.resolve(); await Promise.resolve(); });
      // Rule 2: the fresh read's own content already reflects this in-flight
      // reply — it is NOT re-appended a second time.
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].id).toBe('w-1-r1');

      // The reply's own response finally resolves — a no-op replace, not a
      // second entry (rule 3's own wording).
      await act(async () => {
        resolveReply({ ok: true, reply: { id: 'w-1-r1', author: 'user', text: 'hello there', createdAt: 500 } });
        await Promise.resolve();
      });
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].id).toBe('w-1-r1');
    });

    it('a push for an UNRELATED change while a reply is still in flight leaves the in-flight one visible, not dropped', async () => {
      const { ipc, emitChanged } = installIpc();
      seedOneComment(ipc, 'busy.md');
      const { result } = renderHook(() => useDocComments('busy.md', '/proj'));
      await waitFor(() => expect(result.current.comments).toHaveLength(1));

      // Held open — this reply never resolves during this test.
      ipc.reply.mockReturnValueOnce(new Promise(() => {}));
      act(() => { result.current.addReply('c-1', 'user', 'still typing this one'); });
      expect(result.current.comments[0].replies).toHaveLength(1);

      // An unrelated change lands — the fresh read has NO knowledge of the
      // in-flight reply (it hasn't settled on disk yet).
      ipc.list.mockResolvedValueOnce({
        ok: true,
        comments: [{
          id: 'c-1', path: 'busy.md',
          selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
          text: 'note (edited by someone else)', author: 'user', createdAt: 1, resolved: false, history: [], replies: [],
        }],
      });
      await act(async () => { emitChanged('busy.md', '/proj'); await Promise.resolve(); await Promise.resolve(); });
      // The unrelated change's own fields land...
      expect(result.current.comments[0].text).toBe('note (edited by someone else)');
      // ...but the still-in-flight reply is re-appended, never dropped.
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].text).toBe('still typing this one');
    });

    it('two back-to-back identical replies with a push landing between them each resolve to their OWN correct id (F3 tie-break)', async () => {
      const { ipc, emitChanged } = installIpc();
      seedOneComment(ipc, 'dup.md');
      const { result } = renderHook(() => useDocComments('dup.md', '/proj'));
      await waitFor(() => expect(result.current.comments).toHaveLength(1));

      let resolveFirst!: (v: MutationResult) => void;
      let resolveSecond!: (v: MutationResult) => void;
      ipc.reply.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
      act(() => { result.current.addReply('c-1', 'user', 'thanks'); });
      const firstLocalId = result.current.comments[0].replies[0].id;

      ipc.reply.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
      act(() => { result.current.addReply('c-1', 'user', 'thanks'); });
      expect(result.current.comments[0].replies).toHaveLength(2);
      const secondLocalId = result.current.comments[0].replies[1].id;
      expect(secondLocalId).not.toBe(firstLocalId);

      // A push lands with BOTH real replies already settled, ordered by dT —
      // the fresh read's own only signal, since a real reply carries no
      // client-generated correlation token (§7 rule 2's own limitation, F3).
      ipc.list.mockResolvedValueOnce({
        ok: true,
        comments: [{
          id: 'c-1', path: 'dup.md',
          selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
          text: 'note', author: 'user', createdAt: 1, resolved: false, history: [],
          replies: [
            { id: 'w-1-r1', author: 'user', text: 'thanks', createdAt: 100 },
            { id: 'w-1-r2', author: 'user', text: 'thanks', createdAt: 200 },
          ],
        }],
      });
      await act(async () => { emitChanged('dup.md', '/proj'); await Promise.resolve(); await Promise.resolve(); });
      // Paired by order (first in-flight <-> earliest dT), never duplicated —
      // exactly two entries, not four.
      expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1', 'w-1-r2']);

      // Each call's OWN response, resolved in ARRIVAL order (not necessarily
      // issue order), still lands on its OWN correct persisted id — never
      // swapped between the two.
      await act(async () => { resolveSecond({ ok: true, reply: { id: 'w-1-r2', author: 'user', text: 'thanks', createdAt: 200 } }); await Promise.resolve(); });
      await act(async () => { resolveFirst({ ok: true, reply: { id: 'w-1-r1', author: 'user', text: 'thanks', createdAt: 100 } }); await Promise.resolve(); });
      expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1', 'w-1-r2']);
    });

    // Live-refresh review (docs/active/reviews/2026-09-27-doc-comments-live-
    // refresh-review.md, finding #2): the reconcile rule is format-agnostic —
    // it only ever reads `res.reply`, never a format-specific id shape — but
    // every existing test above only ever exercised a docx-shaped (`w-`) id.
    // Now that xlsx's own reply path is enriched too (§4.3), this proves the
    // SAME swap works for an xlsx-shaped (`xt-`) persisted id.
    it('swaps the optimistic local reply id for the real persisted one on success, given an xlsx-shaped id', async () => {
      const { ipc } = installIpc();
      seedOneComment(ipc, 'sheet.xlsx');
      const { result } = renderHook(() => useDocComments('sheet.xlsx', '/proj'));
      await waitFor(() => expect(result.current.comments).toHaveLength(1));
      let resolveReply!: (v: MutationResult) => void;
      ipc.reply.mockReturnValueOnce(new Promise((resolve) => { resolveReply = resolve; }));
      act(() => { result.current.addReply('c-1', 'user', 'a reply'); });
      const localId = result.current.comments[0].replies[0].id;
      expect(localId).toMatch(/^r-/);
      await act(async () => {
        resolveReply({ ok: true, reply: { id: 'xt-1-A1-04C1C54B-2744-A647-93D1-A99C27C7EFDC-r1', author: 'user', text: 'a reply', createdAt: 999 } });
        await Promise.resolve();
      });
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].id).toBe('xt-1-A1-04C1C54B-2744-A647-93D1-A99C27C7EFDC-r1');
    });

    // Live-refresh review, finding #2's own "untested combination worth
    // closing": a reply response with NO enrichment at all (the plain
    // `{ok:true}` shape the default fake IPC already returns, above) — a
    // backwards-compatible fallback for any caller that never enriches
    // (e.g. a future pending-mutation-queue applier). The reconcile rule
    // must still land correctly once the NEXT push carries the real reply,
    // with no duplicate and no stuck-forever placeholder.
    it('a reply response with no persisted reply attached is still correctly reconciled once the next push lands', async () => {
      const { ipc, emitChanged } = installIpc();
      seedOneComment(ipc, 'unenriched.md');
      const { result } = renderHook(() => useDocComments('unenriched.md', '/proj'));
      await waitFor(() => expect(result.current.comments).toHaveLength(1));

      // The default fake `ipc.reply` (installIpc's own `makeFakeIpc`) already
      // resolves `{ ok: true }` with no `reply` field — used as-is here,
      // never overridden, to prove this exact shape.
      await act(async () => { result.current.addReply('c-1', 'user', 'hi'); await Promise.resolve(); });
      expect(result.current.comments[0].replies).toHaveLength(1);
      const localId = result.current.comments[0].replies[0].id;
      expect(localId).toMatch(/^r-/);

      // The write already committed to disk before the (unenriched) response
      // resolved — the next push's own fresh `list()` read already contains
      // the real, persisted reply.
      ipc.list.mockResolvedValueOnce({
        ok: true,
        comments: [{
          id: 'c-1', path: 'unenriched.md',
          selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
          text: 'note', author: 'user', createdAt: 1, resolved: false, history: [],
          replies: [{ id: 'w-1-r1', author: 'user', text: 'hi', createdAt: 500 }],
        }],
      });
      await act(async () => { emitChanged('unenriched.md', '/proj'); await Promise.resolve(); await Promise.resolve(); });
      expect(result.current.comments[0].replies).toHaveLength(1);
      expect(result.current.comments[0].replies[0].id).toBe('w-1-r1');
    });
  });

  it('resolveComment / reopenComment round-trip through the real channels and honor Retry, via the comment\'s own inline error', async () => {
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
    expect(result.current.comments[0].error?.onRetry).toBeTypeOf('function');
    ipc.resolve.mockResolvedValueOnce({ ok: true });
    act(() => { result.current.comments[0].error!.onRetry(); });
    await waitFor(() => expect(result.current.comments[0].resolved).toBe(true));
    expect(ipc.resolve).toHaveBeenCalledTimes(2);
  });

  // F9 (T5 implementation review): a `docComments:changed` refresh landing
  // WHILE a reply/resolve/reopen mutation is in flight must not have its
  // failure branch reapply a now-stale pre-mutation snapshot over the newer
  // server truth — it re-lists instead.
  it('a mutation failure re-lists instead of rolling back to a stale snapshot when a refresh landed mid-flight (F9)', async () => {
    const { ipc, emitChanged } = installIpc();
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-1', path: 'stale.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
        text: 'original', author: 'user', createdAt: 1, replies: [], resolved: false, history: [],
      }],
    });
    const { result } = renderHook(() => useDocComments('stale.md', '/proj'));
    await waitFor(() => expect(result.current.comments).toHaveLength(1));

    // Hold resolve() open so a refresh can land while it's still in flight.
    let resolveResolve!: (v: { ok: false; error: string }) => void;
    ipc.resolve.mockReturnValueOnce(new Promise((resolve) => { resolveResolve = resolve; }));
    act(() => { resolveComment('c-1', 'user'); });
    expect(result.current.comments[0].resolved).toBe(true); // optimistic

    // A refresh lands mid-flight with NEWER server truth (someone else edited
    // the text too) — the eventual failure must not stomp this with `before`.
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-1', path: 'stale.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
        text: 'edited elsewhere', author: 'user', createdAt: 1, replies: [], resolved: true, history: [],
      }],
    });
    await act(async () => { emitChanged('stale.md', '/proj'); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.comments[0].text).toBe('edited elsewhere'));

    // NOW the resolve() call fails — a naive rollback to the captured
    // `before` (text: 'original', resolved: false) would silently discard
    // the refresh that just landed. Instead it re-lists.
    ipc.list.mockResolvedValueOnce({
      ok: true,
      comments: [{
        id: 'c-1', path: 'stale.md',
        selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
        text: 'edited elsewhere', author: 'user', createdAt: 1, replies: [], resolved: true, history: [],
      }],
    });
    await act(async () => { resolveResolve({ ok: false, error: 'lock-timeout' }); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.comments[0].text).toBe('edited elsewhere'));
    expect(result.current.comments[0].error?.message).toBeTruthy();
  });

  it('clearFocus flushes a pending debounced persist immediately instead of waiting it out', async () => {
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('flush.md', '/proj'));
    act(() => { result.current.addComment('q', 'flush.md'); });
    const id = result.current.comments[0].id;
    act(() => { result.current.setCommentText(id, 'typed fast'); });
    act(() => { result.current.clearFocus(); });
    await waitFor(() => expect(ipc.add).toHaveBeenCalledTimes(1));
    expect(ipc.add).toHaveBeenCalledWith('flush.md', expect.anything(), 'typed fast', 'user', '/proj', id);
  });
});

// F5 (T5 implementation review): a pending draft persist must not fire once
// the last viewer of a file has gone away — it is cancelled on unmount
// (or going off-screen, F6), the same as every other exit path.
describe('useDocComments — cancel pending persists on unmount (F5)', () => {
  it('never calls docComments:add for a draft still mid-debounce when the last viewer unmounts', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result, unmount } = renderHook(() => useDocComments('unmounted.md', '/proj'));
    let id = '';
    act(() => { id = result.current.addComment('q', 'unmounted.md'); });
    act(() => { result.current.setCommentText(id, 'typed then closed'); });
    unmount(); // before the 400ms debounce fires
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(ipc.add).not.toHaveBeenCalled();
  });

  it('does NOT cancel a still-mounted SECOND viewer\'s pending persist on the same file', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const first = renderHook(() => useDocComments('shared-draft.md', '/proj'));
    const second = renderHook(() => useDocComments('shared-draft.md', '/proj'));
    let id = '';
    act(() => { id = first.result.current.addComment('q', 'shared-draft.md'); });
    act(() => { first.result.current.setCommentText(id, 'typed'); });
    first.unmount(); // NOT the last viewer — second is still mounted
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.add).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});

// F6 (T5 implementation review, performance.md rule 2): a hidden-but-mounted
// viewer (a background session's ChatView, kept alive per performance.md
// rule 2) must not keep a live docComments:watch running.
describe('useDocComments — pauses the watch while off screen (F6)', () => {
  it('unwatches when OnScreenContext flips to false, and re-lists/re-watches on returning', async () => {
    const { ipc } = installIpc();
    // `renderHook`'s `wrapper` option only ever receives `children` (never the
    // hook's own render props), so the context value it provides is driven by
    // a closure variable read fresh on every `rerender()`, not by a prop.
    let onScreen = true;
    function Wrapper({ children }: { children?: unknown }) {
      return <OnScreenContext.Provider value={onScreen}>{children as any}</OnScreenContext.Provider>;
    }
    const { rerender } = renderHook(() => useDocComments('bg.md', '/proj'), { wrapper: Wrapper as any });
    await waitFor(() => expect(ipc.watch).toHaveBeenCalledTimes(1));
    expect(ipc.list).toHaveBeenCalledTimes(1);

    onScreen = false;
    rerender();
    await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));

    onScreen = true;
    rerender();
    await waitFor(() => expect(ipc.watch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(2));
  });
});

// F8 (T5 implementation review): an unused (project, path) entry — no live
// subscriber AND no comments left — is pruned, not kept forever. Observed
// through `showResolved`, which resets to its default once the entry is
// pruned rather than "remembering" a toggle nobody can see anymore.
describe('useDocComments — prunes an unused (project, path) entry (F8)', () => {
  it('forgets a toggled showResolved flag once the file has zero comments and no viewers', async () => {
    const { ipc } = installIpc();
    const first = renderHook(() => useDocComments('prune-me.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(1));
    act(() => { first.result.current.setShowResolved(true); });
    expect(first.result.current.showResolved).toBe(true);
    first.unmount();
    await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));

    // Re-mount the SAME key — with zero comments, the entry should have been
    // pruned on unmount, so this is a fresh default, not the old `true`.
    const second = renderHook(() => useDocComments('prune-me.md', '/proj'));
    expect(second.result.current.showResolved).toBe(false);
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
