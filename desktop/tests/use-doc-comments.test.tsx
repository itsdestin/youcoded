// @vitest-environment jsdom
// The renderer's useDocComments hook against a FAKE window.claude.docComments bridge: list / watch /
// mutate / reconcile / refuse / roll back. (tests/ReadingHighlights.test.tsx proves the public hook API itself.)
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
  const ok = async (): Promise<MutationResult> => ({ ok: true });
  const ipc = {
    list: vi.fn(async (_path: string, _projectRoot?: string): Promise<ListResult> => ({ ok: true, comments: [] })),
    // Like the real server, echoes the CALLER's id back (a test overrides this for the docx/xlsx "server mints its own id" case).
    add: vi.fn(async (_path: string, _selector: unknown, _text: string, _author: string, _projectRoot?: string, id?: string): Promise<MutationResult> => ({ ok: true, id })),
    reply: vi.fn(ok), resolve: vi.fn(ok), reopen: vi.fn(ok), move: vi.fn(ok),
    edit: vi.fn(ok), editReply: vi.fn(ok), delete: vi.fn(ok), deleteReply: vi.fn(ok),
    watch: vi.fn(ok), unwatch: vi.fn(ok),
    onChanged: vi.fn((cb: (evt: { path: string; projectRoot?: string }) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
  };
  return { ipc, emitChanged: (path: string, projectRoot?: string) => listeners.forEach((cb) => cb({ path, projectRoot })) };
}
type Ipc = ReturnType<typeof makeFakeIpc>['ipc'];

function installIpc() {
  const fake = makeFakeIpc();
  (window as any).claude = { docComments: fake.ipc };
  return fake;
}

/** A server-side comment record (what docComments:list returns). */
const rec = (id: string, path: string, o: Record<string, unknown> = {}) => ({
  id, path,
  selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'x', prefix: '', suffix: '', occurrence: 0 } },
  text: 'note', author: 'user', createdAt: 1, replies: [], resolved: false, history: [], ...o,
});
const listOnce = (ipc: Ipc, ...comments: any[]) => ipc.list.mockResolvedValueOnce({ ok: true, comments });
/** Mount the hook on `path` (with `comments` as the first list) and wait for them to show. */
async function mountSeeded(path: string, comments: any[] = [rec('c-1', path)], root = '/proj') {
  const fake = installIpc();
  listOnce(fake.ipc, ...comments);
  const hook = renderHook(() => useDocComments(path, root));
  await waitFor(() => expect(hook.result.current.comments).toHaveLength(comments.length));
  return { ...fake, ...hook };
}
/** Flush a list() promise chain under fake timers (waitFor's real polling cannot progress there). */
const flushList = (emit: () => void) => act(async () => { emit(); await Promise.resolve(); await Promise.resolve(); });
const pendingPromise = <T,>() => { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; };
const draftWithText = (result: any, quote: string, path: string, text: string) => {
  let id = '';
  act(() => { id = result.current.addComment(quote, path); });
  act(() => { result.current.setCommentText(id, text); });
  return id;
};

afterEach(() => {
  __resetDocCommentsStoreForTest();
  delete (window as any).claude;
  vi.useRealTimers();
});

describe('useDocComments — list on open, watch while mounted', () => {
  it('calls docComments:list on mount and hydrates from the response', async () => {
    const { ipc, result } = await mountSeeded('a.md', [rec('c-1', 'a.md', { selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'hello', prefix: '', suffix: '', occurrence: 0 } } })]);
    expect(ipc.list).toHaveBeenCalledWith('a.md', '/proj');
    expect(result.current.comments[0]).toMatchObject({ id: 'c-1', quote: 'hello', text: 'note' });
  });

  it('subscribes once per path (refcounted) and unwatches only once the last viewer unmounts', async () => {
    const { ipc } = installIpc();
    const first = renderHook(() => useDocComments('shared.md', '/proj'));
    await waitFor(() => expect(ipc.watch).toHaveBeenCalledTimes(1));
    const second = renderHook(() => useDocComments('shared.md', '/proj'));
    expect(ipc.watch).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(ipc.unwatch).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));
  });

  it('a docComments:changed push re-lists a path with a live viewer, and ignores one nobody has open', async () => {
    const { ipc, emitChanged } = installIpc();
    const { result } = renderHook(() => useDocComments('watched.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(1));
    act(() => emitChanged('closed.md', '/proj'));
    expect(ipc.list).toHaveBeenCalledTimes(1);
    listOnce(ipc, rec('c-2', 'watched.md', { text: 'from elsewhere', author: 'assistant', createdAt: 2 }));
    act(() => emitChanged('watched.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.comments.some((c) => c.id === 'c-2')).toBe(true));
  });

  // WHY: every store map is keyed by (projectRoot, path), so two projects with the same relative filename must never merge.
  describe('two projects sharing a relative path never merge', () => {
    it("keeps each project's comments in its own list", async () => {
      const { ipc } = installIpc();
      ipc.list.mockImplementation(async (path: string, projectRoot?: string) => ({
        ok: true,
        comments: path !== 'README.md' ? [] : [projectRoot === '/proj-a' ? rec('c-a', path, { text: 'from A' }) : rec('c-b', path, { text: 'from B' })],
      }));
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await waitFor(() => expect(a.result.current.comments).toHaveLength(1));
      await waitFor(() => expect(b.result.current.comments).toHaveLength(1));
      expect(a.result.current.comments[0].text).toBe('from A');
      expect(b.result.current.comments[0].text).toBe('from B');
    });

    it("a changed push for one project's copy re-lists only that one", async () => {
      const { ipc, emitChanged } = installIpc();
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(2));
      act(() => emitChanged('README.md', '/proj-a'));
      await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(3));
      expect(ipc.list).toHaveBeenLastCalledWith('README.md', '/proj-a');
      a.unmount();
      b.unmount();
    });

    it("unwatching one project's viewer does not unwatch the other's (separate refcounts)", async () => {
      const { ipc } = installIpc();
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await waitFor(() => expect(ipc.watch).toHaveBeenCalledTimes(2));
      a.unmount();
      await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));
      expect(ipc.unwatch).toHaveBeenCalledWith('README.md', '/proj-a');
      b.unmount();
      await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(2));
      expect(ipc.unwatch).toHaveBeenCalledWith('README.md', '/proj-b');
    });

    it("adding a comment in one project sends the RIGHT projectRoot and never lands in the other's list", async () => {
      const { ipc } = installIpc();
      vi.useFakeTimers();
      const a = renderHook(() => useDocComments('README.md', '/proj-a'));
      const b = renderHook(() => useDocComments('README.md', '/proj-b'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const id = draftWithText(a.result, 'quote', 'README.md', 'hello from A');
      act(() => { a.result.current.commitDraft(id); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(ipc.add).toHaveBeenCalledWith('README.md', expect.anything(), 'hello from A', 'user', '/proj-a', id);
      expect(a.result.current.comments.map((c) => c.id)).toContain(id);
      expect(b.result.current.comments.map((c) => c.id)).not.toContain(id);
    });
  });
});

describe('useDocComments — adding: drafts, id minting, commit', () => {
  it('addComment is optimistic and synchronous even with no IPC bridge at all', () => {
    delete (window as any).claude;
    expect(addComment('no-bridge.md', 'quote', 'no-bridge.md')).toBeTruthy();
  });

  // WHY: typing once re-armed a 400ms debounced add per keystroke, so a mid-sentence pause persisted a truncated prefix
  // ('h', 'cur', ...) and later keystrokes were lost. Typing is now local-only; an explicit commit sends it.
  it('typing never calls docComments:add by itself, however long the pause between keystrokes', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('draft.md', '/proj'));
    const id = draftWithText(result, 'the quote', 'draft.md', 'h');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    act(() => { result.current.setCommentText(id, 'he'); });
    act(() => { result.current.setCommentText(id, 'hello'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(ipc.add).not.toHaveBeenCalled();
  });

  it('mints the comment id itself and committing after a mid-typing pause persists the FULL text', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('draft.md', '/proj'));
    const id = draftWithText(result, 'the quote', 'draft.md', 'h');
    expect(id).toMatch(/^c-/);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => { result.current.setCommentText(id, 'hello'); });
    act(() => { result.current.commitDraft(id); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(ipc.add).toHaveBeenCalledTimes(1);
    expect(ipc.add).toHaveBeenCalledWith('draft.md', expect.objectContaining({ kind: 'text' }), 'hello', 'user', '/proj', id);
    expect(result.current.comments).toHaveLength(1); // the renderer's id IS the persisted id: no swap
    expect(result.current.comments[0]).toMatchObject({ id, text: 'hello' });
  });

  it('still reconciles onto a DIFFERENT server-minted id (docx/xlsx mint their own)', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    ipc.add.mockResolvedValueOnce({ ok: true, id: 'w-42' });
    const { result } = renderHook(() => useDocComments('brief.docx', '/proj'));
    const id = draftWithText(result, 'the quote', 'brief.docx', 'hello');
    act(() => { result.current.commitDraft(id); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0].id).toBe('w-42');
  });

  // WHY: a changed-push refresh can land the server copy (under its REAL id) before this window's own add() resolves;
  // renaming the placeholder unconditionally then created a second element with the same id (React duplicate-key crash).
  it('a refresh that lands its own server copy WHILE add() is in flight never leaves a duplicate', async () => {
    vi.useFakeTimers();
    const { ipc, emitChanged } = installIpc();
    const { result } = renderHook(() => useDocComments('race.md', '/proj'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const id = draftWithText(result, 'the quote', 'race.md', 'racing');
    const add = pendingPromise<{ ok: true; id: string }>();
    ipc.add.mockReturnValueOnce(add.p);
    act(() => { result.current.commitDraft(id); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(ipc.add).toHaveBeenCalledTimes(1);

    listOnce(ipc, rec('server-won-the-race', 'race.md', {
      selector: { kind: 'text', selector: { type: 'TextQuoteSelector', exact: 'the quote', prefix: '', suffix: '', occurrence: 0 } },
      text: 'racing', createdAt: 5,
    }));
    await flushList(() => emitChanged('race.md', '/proj'));
    expect(result.current.comments.some((c) => c.id === 'server-won-the-race')).toBe(true);
    await act(async () => { add.resolve({ ok: true, id: 'server-won-the-race' }); await Promise.resolve(); });
    expect(result.current.comments.map((c) => c.id)).toEqual(['server-won-the-race']);
  });

  it('never calls docComments:add while the draft text is still empty', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('empty-draft.md', '/proj'));
    act(() => { result.current.addComment('quote', 'empty-draft.md'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(ipc.add).not.toHaveBeenCalled();
  });

  it('cancelling a draft (removeComment / deleteComment) sends no IPC at all, typed text or not', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('cancelled.md', '/proj'));
    const id = draftWithText(result, 'the quote', 'cancelled.md', 'never mind');
    act(() => { result.current.removeComment(id); });
    const id2 = draftWithText(result, 'the quote', 'cancelled.md', 'never sent');
    act(() => { result.current.deleteComment(id2); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(ipc.add).not.toHaveBeenCalled();
    expect(ipc.delete).not.toHaveBeenCalled();
    expect(result.current.comments).toHaveLength(0);
  });

  it("a changed push arriving mid-draft never alters the draft's own text (the server has never heard of it)", async () => {
    const { ipc, emitChanged } = installIpc();
    const { result } = renderHook(() => useDocComments('mid-draft.md', '/proj'));
    const id = draftWithText(result, 'the quote', 'mid-draft.md', 'still typing this');
    listOnce(ipc, rec('c-unrelated', 'mid-draft.md', { text: "someone else's comment", author: 'assistant', createdAt: 2 }));
    await flushList(() => emitChanged('mid-draft.md', '/proj'));
    expect(result.current.comments.find((c) => c.id === id)?.text).toBe('still typing this');
    expect(result.current.comments.map((c) => c.id).sort()).toEqual([id, 'c-unrelated'].sort());
    expect(ipc.add).not.toHaveBeenCalled();
  });

  it('a failed add keeps the draft with the error attached to it, and Retry replays the same call', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const { result } = renderHook(() => useDocComments('failed-add.md', '/proj'));
    let id = '';
    act(() => { id = result.current.addComment('the quote', 'failed-add.md'); });
    ipc.add.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { result.current.setCommentText(id, 'hello'); });
    act(() => { result.current.commitDraft(id); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(ipc.add).toHaveBeenCalledTimes(1);
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.comments[0]).toMatchObject({ id, text: 'hello' });
    expect(result.current.comments[0].error).toBeDefined();

    ipc.add.mockResolvedValueOnce({ ok: true, id });
    await act(async () => { result.current.comments[0].error!.onRetry(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.comments[0].error).toBeUndefined();
    expect(ipc.add).toHaveBeenCalledTimes(2);
  });

  it('clearFocus commits a still-uncommitted draft immediately (Enter / "Comment" / click-away)', async () => {
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

describe('useDocComments — replies, resolve, rollback', () => {
  it('addReply is optimistic, calls docComments:reply with the comment path, and rolls back with an inline error on refusal', async () => {
    const { ipc, result } = await mountSeeded('thread.md');
    ipc.reply.mockResolvedValueOnce({ ok: false, error: 'comment-not-found' });
    act(() => { result.current.addReply('c-1', 'user', 'a reply'); });
    expect(result.current.comments[0].replies).toHaveLength(1);
    expect(ipc.reply).toHaveBeenCalledWith('thread.md', 'c-1', 'a reply', 'user', '/proj');
    await waitFor(() => expect(result.current.comments[0].replies).toHaveLength(0));
    expect(result.current.comments[0].error).toBeDefined();
  });

  // The reconcile rule is format-agnostic: it only reads `res.reply`, so docx (`w-`) and xlsx (`xt-`) persisted ids both swap in.
  it.each([
    ['w-3-r1', 'thread.md'],
    ['xt-1-A1-04C1C54B-2744-A647-93D1-A99C27C7EFDC-r1', 'sheet.xlsx'],
  ])('swaps the optimistic local reply id for the persisted one (%s)', async (persistedId, path) => {
    const { ipc, result } = await mountSeeded(path);
    const reply = pendingPromise<MutationResult>();
    ipc.reply.mockReturnValueOnce(reply.p);
    act(() => { result.current.addReply('c-1', 'user', 'a reply'); });
    expect(result.current.comments[0].replies[0].id).toMatch(/^r-/);
    await act(async () => { reply.resolve({ ok: true, reply: { id: persistedId, author: 'user', text: 'a reply', createdAt: 999 } }); await Promise.resolve(); });
    expect(result.current.comments[0].replies).toHaveLength(1);
    expect(result.current.comments[0].replies[0].id).toBe(persistedId);
  });

  it('a push landing BEFORE the reply response never duplicates or loses the reply', async () => {
    const { ipc, emitChanged, result } = await mountSeeded('race.md');
    const reply = pendingPromise<MutationResult>();
    ipc.reply.mockReturnValueOnce(reply.p);
    act(() => { result.current.addReply('c-1', 'user', 'hello there'); });
    expect(result.current.comments[0].replies).toHaveLength(1);
    // The write succeeded; the watcher push simply arrived first.
    listOnce(ipc, rec('c-1', 'race.md', { replies: [{ id: 'w-1-r1', author: 'user', text: 'hello there', createdAt: 500 }] }));
    await flushList(() => emitChanged('race.md', '/proj'));
    expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1']); // not re-appended
    await act(async () => { reply.resolve({ ok: true, reply: { id: 'w-1-r1', author: 'user', text: 'hello there', createdAt: 500 } }); await Promise.resolve(); });
    expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1']); // a no-op replace
  });

  it('a push for an UNRELATED change while a reply is in flight keeps the in-flight reply visible', async () => {
    const { ipc, emitChanged, result } = await mountSeeded('busy.md');
    ipc.reply.mockReturnValueOnce(new Promise(() => {}));
    act(() => { result.current.addReply('c-1', 'user', 'still typing this one'); });
    listOnce(ipc, rec('c-1', 'busy.md', { text: 'note (edited by someone else)' }));
    await flushList(() => emitChanged('busy.md', '/proj'));
    expect(result.current.comments[0].text).toBe('note (edited by someone else)');
    expect(result.current.comments[0].replies.map((r: any) => r.text)).toEqual(['still typing this one']);
  });

  it('two back-to-back identical replies with a push between them each resolve to their OWN id (tie-break)', async () => {
    const { ipc, emitChanged, result } = await mountSeeded('dup.md');
    const first = pendingPromise<MutationResult>();
    const second = pendingPromise<MutationResult>();
    ipc.reply.mockReturnValueOnce(first.p);
    act(() => { result.current.addReply('c-1', 'user', 'thanks'); });
    const firstLocalId = result.current.comments[0].replies[0].id;
    ipc.reply.mockReturnValueOnce(second.p);
    act(() => { result.current.addReply('c-1', 'user', 'thanks'); });
    expect(result.current.comments[0].replies).toHaveLength(2);
    expect(result.current.comments[0].replies[1].id).not.toBe(firstLocalId);

    // A real reply carries no client correlation token, so the fresh read pairs by order (first in-flight <-> earliest dT).
    const r1 = { id: 'w-1-r1', author: 'user', text: 'thanks', createdAt: 100 };
    const r2 = { id: 'w-1-r2', author: 'user', text: 'thanks', createdAt: 200 };
    listOnce(ipc, rec('c-1', 'dup.md', { replies: [r1, r2] }));
    await flushList(() => emitChanged('dup.md', '/proj'));
    expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1', 'w-1-r2']);
    // Responses resolve in ARRIVAL order, yet never swap ids.
    await act(async () => { second.resolve({ ok: true, reply: r2 }); await Promise.resolve(); });
    await act(async () => { first.resolve({ ok: true, reply: r1 }); await Promise.resolve(); });
    expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1', 'w-1-r2']);
  });

  it('a reply response with no persisted reply attached is reconciled once the next push lands', async () => {
    const { ipc, emitChanged, result } = await mountSeeded('unenriched.md');
    await act(async () => { result.current.addReply('c-1', 'user', 'hi'); await Promise.resolve(); }); // default fake resolves {ok:true}, no `reply`
    expect(result.current.comments[0].replies).toHaveLength(1);
    expect(result.current.comments[0].replies[0].id).toMatch(/^r-/);
    listOnce(ipc, rec('c-1', 'unenriched.md', { replies: [{ id: 'w-1-r1', author: 'user', text: 'hi', createdAt: 500 }] }));
    await flushList(() => emitChanged('unenriched.md', '/proj'));
    expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['w-1-r1']);
  });

  it('resolveComment round-trips through the real channel and honors Retry via the comment inline error', async () => {
    const { ipc, result } = await mountSeeded('resolve.md');
    ipc.resolve.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { resolveComment('c-1', 'user'); });
    expect(result.current.comments[0].resolved).toBe(true); // optimistic
    await waitFor(() => expect(result.current.comments[0].resolved).toBe(false)); // rolled back
    expect(result.current.comments[0].error?.onRetry).toBeTypeOf('function');
    act(() => { result.current.comments[0].error!.onRetry(); });
    await waitFor(() => expect(result.current.comments[0].resolved).toBe(true));
    expect(ipc.resolve).toHaveBeenCalledTimes(2);
  });

  // WHY: a refresh landing mid-flight must not have the failure branch reapply a stale pre-mutation snapshot over newer server truth.
  it('a mutation failure re-lists instead of rolling back to a stale snapshot when a refresh landed mid-flight', async () => {
    const { ipc, emitChanged, result } = await mountSeeded('stale.md', [rec('c-1', 'stale.md', { text: 'original' })]);
    const resolving = pendingPromise<{ ok: false; error: string }>();
    ipc.resolve.mockReturnValueOnce(resolving.p);
    act(() => { resolveComment('c-1', 'user'); });
    expect(result.current.comments[0].resolved).toBe(true);
    const newer = rec('c-1', 'stale.md', { text: 'edited elsewhere', resolved: true });
    listOnce(ipc, newer);
    await flushList(() => emitChanged('stale.md', '/proj'));
    await waitFor(() => expect(result.current.comments[0].text).toBe('edited elsewhere'));
    listOnce(ipc, newer);
    await act(async () => { resolving.resolve({ ok: false, error: 'lock-timeout' }); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.comments[0].text).toBe('edited elsewhere'));
    expect(result.current.comments[0].error?.message).toBeTruthy();
  });
});

describe('useDocComments — edit / delete', () => {
  const seedThread = (path: string, replies: any[] = []) =>
    mountSeeded(path, [rec('c-1', path, { text: 'original text', replies })]);

  it('editComment updates optimistically and calls docComments:edit with the trimmed text; blank text does nothing', async () => {
    const { ipc, result } = await seedThread('edit.md');
    act(() => { result.current.editComment('c-1', '   '); });
    expect(result.current.comments[0].text).toBe('original text');
    expect(ipc.edit).not.toHaveBeenCalled();
    act(() => { result.current.editComment('c-1', '  a better note  '); });
    expect(result.current.comments[0].text).toBe('a better note');
    await waitFor(() => expect(ipc.edit).toHaveBeenCalledWith('edit.md', 'c-1', 'a better note', '/proj'));
  });

  it('a failed editComment rolls back to the pre-edit text with a retryable error', async () => {
    const { ipc, result } = await seedThread('edit-fail.md');
    ipc.edit.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { result.current.editComment('c-1', 'a doomed edit'); });
    expect(result.current.comments[0].text).toBe('a doomed edit');
    await waitFor(() => expect(result.current.comments[0].text).toBe('original text'));
    expect(result.current.comments[0].error?.onRetry).toBeTypeOf('function');
    act(() => { result.current.comments[0].error!.onRetry(); });
    await waitFor(() => expect(result.current.comments[0].text).toBe('a doomed edit'));
    expect(ipc.edit).toHaveBeenCalledTimes(2);
  });

  it('deleteComment removes the WHOLE thread (replies nested inside) optimistically; a failure restores it intact with Retry', async () => {
    const { ipc, result } = await seedThread('delete.md', [{ id: 'c-1-r1', author: 'user', text: 'a reply', createdAt: 2 }]);
    ipc.delete.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { result.current.deleteComment('c-1'); });
    expect(result.current.comments).toHaveLength(0);
    expect(ipc.delete).toHaveBeenCalledWith('delete.md', 'c-1', '/proj');
    await waitFor(() => expect(result.current.comments).toHaveLength(1));
    expect(result.current.comments[0].replies).toHaveLength(1);
    act(() => { result.current.comments[0].error!.onRetry(); });
    await waitFor(() => expect(result.current.comments).toHaveLength(0));
  });

  it('editReply updates one reply and calls docComments:edit-reply, leaving the others and the comment text alone', async () => {
    const { ipc, result } = await seedThread('edit-reply.md', [
      { id: 'c-1-r1', author: 'user', text: 'first reply', createdAt: 2 },
      { id: 'c-1-r2', author: 'assistant', text: 'second reply', createdAt: 3 },
    ]);
    act(() => { result.current.editReply('c-1', 'c-1-r1', 'edited first reply'); });
    expect(result.current.comments[0].replies.map((r: any) => r.text)).toEqual(['edited first reply', 'second reply']);
    expect(result.current.comments[0].text).toBe('original text');
    await waitFor(() => expect(ipc.editReply).toHaveBeenCalledWith('edit-reply.md', 'c-1', 'c-1-r1', 'edited first reply', '/proj'));
  });

  it('deleteReply removes only that reply; a failure restores it and Retry replays the call', async () => {
    const { ipc, result } = await seedThread('delete-reply.md', [
      { id: 'c-1-r1', author: 'user', text: 'keep me', createdAt: 2 },
      { id: 'c-1-r2', author: 'user', text: 'delete me', createdAt: 3 },
    ]);
    ipc.deleteReply.mockResolvedValueOnce({ ok: false, error: 'lock-timeout' });
    act(() => { result.current.deleteReply('c-1', 'c-1-r2'); });
    expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['c-1-r1']);
    expect(ipc.deleteReply).toHaveBeenCalledWith('delete-reply.md', 'c-1', 'c-1-r2', '/proj');
    await waitFor(() => expect(result.current.comments[0].replies).toHaveLength(2)); // rolled back
    expect(result.current.comments[0].error?.onRetry).toBeTypeOf('function');
    act(() => { result.current.comments[0].error!.onRetry(); });
    await waitFor(() => expect(result.current.comments[0].replies.map((r: any) => r.id)).toEqual(['c-1-r1']));
  });

  // WHY: a reply still in flight from addReply has no server id, so edit/delete act locally with no IPC call.
  it('editing or deleting a reply still in flight from addReply never calls the server', async () => {
    const { ipc, result } = await seedThread('in-flight.md');
    ipc.reply.mockReturnValueOnce(new Promise(() => {}));
    act(() => { result.current.addReply('c-1', 'user', 'still in flight'); });
    const localReplyId = result.current.comments[0].replies[0].id;
    expect(localReplyId).toMatch(/^r-/);
    act(() => { result.current.editReply('c-1', localReplyId, 'edited while in flight'); });
    expect(result.current.comments[0].replies[0].text).toBe('edited while in flight');
    expect(ipc.editReply).not.toHaveBeenCalled();
    act(() => { result.current.deleteReply('c-1', localReplyId); });
    expect(result.current.comments[0].replies).toHaveLength(0);
    expect(ipc.deleteReply).not.toHaveBeenCalled();
  });
});

// WHY: since typing no longer auto-persists, closing the file used to throw away real typed text; closing now COMMITS a
// non-empty draft (like Enter / "Comment" / click-away) and only discards an empty one.
describe('useDocComments — the last viewer closing commits a non-empty draft instead of losing it', () => {
  it('commits a draft with real typed text when the last viewer unmounts', async () => {
    const { ipc } = installIpc();
    const { result, unmount } = renderHook(() => useDocComments('unmounted.md', '/proj'));
    const id = draftWithText(result, 'q', 'unmounted.md', 'typed then closed');
    unmount();
    await waitFor(() => expect(ipc.add).toHaveBeenCalledTimes(1));
    expect(ipc.add).toHaveBeenCalledWith('unmounted.md', expect.anything(), 'typed then closed', 'user', '/proj', id);
  });

  it('discards (no IPC) a draft that is still empty when the last viewer unmounts', async () => {
    const { ipc } = installIpc();
    const { result, unmount } = renderHook(() => useDocComments('empty-unmount.md', '/proj'));
    act(() => { result.current.addComment('q', 'empty-unmount.md'); });
    unmount();
    await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));
    expect(ipc.add).not.toHaveBeenCalled();
  });

  it('a non-last viewer unmounting neither commits nor discards a shared draft', async () => {
    vi.useFakeTimers();
    const { ipc } = installIpc();
    const first = renderHook(() => useDocComments('shared-draft.md', '/proj'));
    const second = renderHook(() => useDocComments('shared-draft.md', '/proj'));
    const id = draftWithText(first.result, 'q', 'shared-draft.md', 'typed');
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(ipc.add).not.toHaveBeenCalled();
    expect(second.result.current.comments.find((c) => c.id === id)?.text).toBe('typed');
    second.unmount();
  });
});

describe('useDocComments — off screen, pruning, re-render isolation', () => {
  // WHY: a hidden-but-mounted viewer (a background session's ChatView) must not keep a live watch running.
  it('unwatches when OnScreenContext flips to false, and re-lists/re-watches on returning', async () => {
    const { ipc } = installIpc();
    // renderHook's wrapper only receives children, so the context value comes from a closure variable read on each rerender().
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

  // Observed through showResolved, which resets to its default once an entry (no subscriber, no comments) is pruned.
  it('forgets a toggled showResolved flag once the file has zero comments and no viewers', async () => {
    const { ipc } = installIpc();
    const first = renderHook(() => useDocComments('prune-me.md', '/proj'));
    await waitFor(() => expect(ipc.list).toHaveBeenCalledTimes(1));
    act(() => { first.result.current.setShowResolved(true); });
    expect(first.result.current.showResolved).toBe(true);
    first.unmount();
    await waitFor(() => expect(ipc.unwatch).toHaveBeenCalledTimes(1));
    expect(renderHook(() => useDocComments('prune-me.md', '/proj')).result.current.showResolved).toBe(false);
  });

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
    expect(rendersB).toBe(rendersAfterMount);
    expect(hookB.result.current.comments).toHaveLength(0);
  });
});
