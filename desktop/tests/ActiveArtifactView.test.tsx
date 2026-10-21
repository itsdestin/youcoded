// @vitest-environment jsdom
// ActiveArtifactView — the file pane's viewer and editor: what may be edited and
// saved, how a read's phases (loading / ready / missing / error) render through
// useArtifactContent, and the conflict check that guards every save. Each section
// keeps its own window.claude bridge fake and hooks, so they stay inside it.
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { render, act, fireEvent, cleanup, renderHook, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { setConnectionMode } from '../src/renderer/platform';
import { useArtifactContent, contentPathFor } from '../src/renderer/components/artifact-views/useArtifactContent';
import { addComment, __resetDocCommentsStoreForTest } from '../src/renderer/state/doc-comments-store';
import { flushRecoveryDrafts, readRecoveryDraft, writeRecoveryDraft } from '../src/renderer/state/draft-recovery';

// WHY: CodeMirror schedules range measurements, but jsdom supplies no range
// geometry. Keep real editor behavior without asynchronous measurement errors.
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
});
afterAll(() => {
  for (const [key, descriptor] of [['getClientRects', rangeRects], ['getBoundingClientRect', rangeBounds]] as const) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
    else Reflect.deleteProperty(Range.prototype, key);
  }
});

beforeEach(() => { flushRecoveryDrafts(); sessionStorage.clear(); });

const commentLayout = vi.hoisted(() => ({
  narrow: false, expanded: undefined as boolean | undefined,
  dispatch: undefined as ReturnType<typeof vi.fn> | undefined,
}));
vi.mock('../src/renderer/hooks/use-container-narrow', async (original) => ({
  ...await original<typeof import('../src/renderer/hooks/use-container-narrow')>(),
  useNarrowByRef: () => commentLayout.narrow,
}));
vi.mock('../src/renderer/state/ArtifactContext', async (original) => ({
  ...await original<typeof import('../src/renderer/state/ArtifactContext')>(),
  useArtifactDispatchOptional: () => commentLayout.dispatch,
  useArtifactSelectorOptional: () => commentLayout.expanded,
}));

// Pins the D4-unlock safety behavior of ActiveArtifactView (plan step 4):
// 1. THE §2.2 EMPTY-FILE GUARANTEE — while content is null (fetch transient /
//    orphan / binary) a save must be hard-blocked: both hosts setContent(null)
//    before the get resolves, and a save in that window would truncate the
//    file to an empty draft. This is the highest-risk regression in the
//    workstream; if this test starts failing, do not ship.
// 2. The renderer's D5 mirror hides editability for denied paths.
// 3. dirty only when edit mode holds real divergence from resolved content.
// 4. The concurrency token from startEdit's refresh rides into the save.
describe('edit and save guards', () => {
  const save = vi.fn();
  const get = vi.fn();
  let changedCb: any = null;

  function mountView(overrides: Partial<React.ComponentProps<typeof ActiveArtifactView>> = {}) {
    const ref = React.createRef<ActiveArtifactHandle>();
    const props = {
      artifact: { id: 'a1', kind: 'internal', path: 'notes.md' } as any,
      content: 'hello',
      projectRoot: '/proj',
      projectId: 'p1',
      projectName: 'Proj',
      sessionId: 's1',
      onContentChange: vi.fn(),
      ...overrides,
    };
    const utils = render(<ActiveArtifactView ref={ref} {...(props as any)} />);
    return { ref, utils, props };
  }

  beforeEach(() => {
    save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 100 });
    get.mockReset().mockResolvedValue({ ok: true, content: 'hello', orphan: false, mtimeMs: 42 });
    (window as any).claude = {
      artifacts: {
        save,
        get,
        // Capture the watcher callback so a test can fire an on-disk change.
        onChanged: (cb: any) => { changedCb = cb; return () => { changedCb = null; }; },
      },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  describe('ActiveArtifactView save safety', () => {
    it('NEVER saves while content is null (the truncation guard)', async () => {
      const { ref } = mountView({ content: null });
      let ok: boolean | undefined;
      await act(async () => { ok = await ref.current!.saveEdit(); });
      expect(ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
    });

    it('is not editable while content is null, and not dirty either', () => {
      const { ref } = mountView({ content: null });
      expect(ref.current!.isEditable).toBe(false);
      expect(ref.current!.dirty).toBe(false);
    });

    it('denied-tier paths (D5 mirror) are not editable', () => {
      const { ref } = mountView({
        artifact: { id: 'a2', kind: 'internal', path: '.git/config' } as any,
        content: '[core]',
      });
      expect(ref.current!.isEditable).toBe(false);
    });

    it('binary / too-large content is not editable', () => {
      const bin = mountView({ content: null, contentInfo: { binary: true } });
      expect(bin.ref.current!.isEditable).toBe(false);
      const big = mountView({ content: null, contentInfo: { sizeBytes: 5e6 } });
      expect(big.ref.current!.isEditable).toBe(false);
    });

    // Found in Workbench review 2026-08-25: a file served as a PREFIX still
    // offered Edit, directly under a banner saying "Read-only". Saving would have
    // written the 2 MB prefix over the whole 8.4 MB file.
    it('a file served as a prefix offers no Edit and refuses to save', async () => {
      const { ref } = mountView({
        artifact: { id: 'a9', kind: 'internal', path: 'logs/server.log' } as any,
        content: 'first chunk\n',
        contentInfo: { binary: false, truncated: true, sizeBytes: 8.4 * 1024 * 1024 },
      });
      expect(ref.current!.isEditable).toBe(false);
      // Even reaching save directly through the host ref must not write.
      expect(await ref.current!.saveEdit()).toBe(false);
      expect(save).not.toHaveBeenCalled();
    });

    // The other half: a file that is over the cap but NOT truncated (the user
    // clicked "Load the whole file") stays read-only too — the cap exists because
    // the editor blocks the renderer on a multi-MB string.
    it('a fully loaded over-cap file is still not editable', () => {
      const { ref } = mountView({
        artifact: { id: 'a9', kind: 'internal', path: 'logs/server.log' } as any,
        content: 'the whole thing',
        contentInfo: { binary: false, truncated: false, sizeBytes: 8.4 * 1024 * 1024 },
      });
      expect(ref.current!.isEditable).toBe(false);
    });

    it('any text file is editable now (D4) — a .ts file, not just md/txt', () => {
      const { ref } = mountView({
        artifact: { id: 'a3', kind: 'internal', path: 'src/app.ts' } as any,
        content: 'export {};',
      });
      expect(ref.current!.isEditable).toBe(true);
    });

    it('journals live edits before unmount and clears recovery only after saving', async () => {
      const { ref, utils } = mountView({ artifact: { id: 'live-recovery', kind: 'internal', path: 'notes.md' } as any });
      await act(async () => { ref.current!.startEdit(); });
      fireEvent.change(utils.container.querySelector('textarea')!, { target: { value: 'unsaved live edit' } });
      flushRecoveryDrafts();
      expect(readRecoveryDraft('file:/proj|live-recovery')).toMatchObject({ text: 'unsaved live edit', mtimeMs: 42 });
      await act(async () => { await ref.current!.saveEdit(); });
      flushRecoveryDrafts();
      expect(readRecoveryDraft('file:/proj|live-recovery')).toBeNull();
    });

    it('recovers a previous renderer draft with its original concurrency token', async () => {
      writeRecoveryDraft('file:/proj|crashed-edit', { text: 'recovered edit', mtimeMs: 7, name: 'notes.md' });
      flushRecoveryDrafts();
      const { ref, utils } = mountView({ artifact: { id: 'crashed-edit', kind: 'internal', path: 'notes.md' } as any });
      await waitFor(() => expect(ref.current!.editing).toBe(true));
      expect(utils.container.querySelector('textarea')!.value).toBe('recovered edit');
      // Restoring is not saving: another crash must still recover it.
      expect(readRecoveryDraft('file:/proj|crashed-edit')).toMatchObject({ text: 'recovered edit', mtimeMs: 7 });
      await act(async () => { await ref.current!.saveEdit(); });
      expect(save.mock.calls[0][6]).toMatchObject({ baseMtimeMs: 7 });
    });

    it('round-trips the mtime token captured at startEdit into the save', async () => {
      const { ref } = mountView();
      await act(async () => { ref.current!.startEdit(); });
      await waitFor(() => expect(get).toHaveBeenCalled());
      await act(async () => { await ref.current!.saveEdit(); });
      expect(save).toHaveBeenCalledTimes(1);
      const opts = save.mock.calls[0][6];
      expect(opts).toMatchObject({ baseMtimeMs: 42 });
    });

    it('stashes a dirty draft on unmount and restores it on remount (unguarded-discard safety net)', async () => {
      // Any layout change that unmounts the drawer (games panel, terminal
      // toggle, Project View, pill click) must degrade to draft-survives — the
      // review found three such paths in one pass, so the net, not the
      // enumeration, is what gets pinned.
      const first = mountView();
      await act(async () => { first.ref.current!.startEdit(); });
      await waitFor(() => expect(get).toHaveBeenCalled());
      const textarea = first.utils.container.querySelector('textarea')!;
      await act(async () => {
        const { fireEvent } = await import('@testing-library/react');
        fireEvent.change(textarea, { target: { value: 'edited but not saved' } });
      });
      expect(first.ref.current!.dirty).toBe(true);
      first.utils.unmount(); // NO guard ran — simulates the games-panel case

      const second = mountView();
      await waitFor(() => expect(second.ref.current!.editing).toBe(true));
      expect(second.utils.container.querySelector('textarea')!.value).toBe('edited but not saved');
      // The restored draft still carries the concurrency token from startEdit.
      await act(async () => { await second.ref.current!.saveEdit(); });
      expect(save.mock.calls[0][6]).toMatchObject({ baseMtimeMs: 42 });
    });

    it('does NOT restore a draft that was saved before unmount', async () => {
      const first = mountView();
      await act(async () => { first.ref.current!.startEdit(); });
      await waitFor(() => expect(get).toHaveBeenCalled());
      const textarea = first.utils.container.querySelector('textarea')!;
      await act(async () => {
        const { fireEvent } = await import('@testing-library/react');
        fireEvent.change(textarea, { target: { value: 'about to be saved' } });
      });
      await act(async () => { await first.ref.current!.saveEdit(); });
      first.utils.unmount();
      const second = mountView();
      await act(async () => {});
      expect(second.ref.current!.editing).toBe(false);
    });

    it('surfaces a conflict save as the conflict banner, not a silent overwrite', async () => {
      save.mockResolvedValue({ ok: false, error: 'conflict' });
      get.mockResolvedValue({ ok: true, content: 'disk version', orphan: false, mtimeMs: 99 });
      const { ref, utils } = mountView();
      await act(async () => { ref.current!.startEdit(); });
      let ok: boolean | undefined;
      await act(async () => { ok = await ref.current!.saveEdit(); });
      expect(ok).toBe(false);
      expect(utils.getByText(/changed on disk while you were editing/i)).toBeTruthy();
    });

    // Typing in the editor used to unsubscribe and resubscribe the on-disk watcher
    // on every keystroke. It now subscribes once per file — and an external change
    // that lands after typing still compares against the LATEST draft.
    it('keeps one change-watcher subscription while typing, and still flags an external change against the latest draft', async () => {
      let subscribes = 0;
      const onChanged = (window as any).claude.artifacts.onChanged;
      (window as any).claude.artifacts.onChanged = (cb: any) => { subscribes++; return onChanged(cb); };
      const { ref, utils } = mountView();
      await act(async () => { ref.current!.startEdit(); });
      await waitFor(() => expect(ref.current!.editing).toBe(true));
      const before = subscribes;
      const textarea = utils.container.querySelector('textarea')!;
      for (const value of ['h', 'he', 'hel', 'hell', 'hello!']) {
        await act(async () => { fireEvent.change(textarea, { target: { value } }); });
      }
      expect(ref.current!.dirty).toBe(true);
      expect(subscribes).toBe(before);

      // Disk now equals the latest draft: no conflict (a stale closure would compare
      // against an older draft and raise one).
      get.mockResolvedValue({ ok: true, content: 'hello!', orphan: false, mtimeMs: 50 });
      await act(async () => { changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'change' }); });
      await waitFor(() => expect(get).toHaveBeenLastCalledWith('/proj', 'a1'));
      await act(async () => {});
      expect(utils.queryByText(/changed on disk while you were editing/i)).toBeNull();

      // Disk differs from the draft: the conflict banner appears.
      get.mockResolvedValue({ ok: true, content: 'someone else', orphan: false, mtimeMs: 60 });
      await act(async () => { changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'change' }); });
      await waitFor(() => expect(utils.getByText(/changed on disk while you were editing/i)).toBeTruthy());
    });

    // WHY: the conflict banner's "View diff" wraps UnifiedDiff in its own scroll
    // box (overflow-auto max-h-[40%]) — it must pass `fill` so that box stays the
    // ONLY scroller. A 20-line draft vs a one-line disk version produces >15 diff
    // rows, enough for UnifiedDiff's own 15-line cap + "Show … more lines" button
    // to appear if `fill` regressed away.
    it('the conflict diff has no "Show more lines" button — the banner box is the only scroller', async () => {
      save.mockResolvedValue({ ok: false, error: 'conflict' });
      get.mockResolvedValue({ ok: true, content: 'disk version', orphan: false, mtimeMs: 99 });
      const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
      const { ref, utils } = mountView({ content: longContent });
      await act(async () => { ref.current!.startEdit(); });
      await act(async () => { await ref.current!.saveEdit(); });
      await act(async () => { fireEvent.click(utils.getByText('View diff')); });
      expect(utils.queryByText(/more lines/i)).toBeNull();
    });
  });

  // Content and the FACTS about content must travel together. Every editability
  // guard reads contentInfo; the watcher can swap the pane's text underneath it.
  // If the size does not ride along, a file that grew past the cap while open
  // keeps its Edit button and saving writes the prefix over the whole file.
  describe('content updates always carry their metadata', () => {
    it('hands the whole read to onDiskRead when the file grows past the cap while open', async () => {
      const onDiskRead = vi.fn();
      const view = mountView({
        content: 'small',
        contentInfo: { sizeBytes: 100, binary: false },
        onDiskRead,
      });
      get.mockResolvedValue({ ok: true, content: 'PREFIX', binary: false,
                              truncated: true, sizeBytes: 9_000_000, mtimeMs: 2 });
      await act(async () => {
        changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'change' });
      });
      await waitFor(() => expect(onDiskRead).toHaveBeenCalled());
      const res = onDiskRead.mock.calls[0][0];
      expect(res.sizeBytes).toBe(9_000_000);
      expect(res.truncated).toBe(true);
      view.utils.unmount();
    });

    // The watcher's `disk !== content` guard used to wrap the metadata update
    // too, so an append past the cap left the visible prefix byte-identical and
    // the size stale — the exact shape that fails OPEN.
    it('updates metadata even when the visible text is unchanged', async () => {
      const onDiskRead = vi.fn();
      const view = mountView({ content: 'same', contentInfo: { sizeBytes: 100 }, onDiskRead });
      get.mockResolvedValue({ ok: true, content: 'same', binary: false,
                              truncated: true, sizeBytes: 9_000_000, mtimeMs: 2 });
      await act(async () => {
        changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'change' });
      });
      await waitFor(() => expect(onDiskRead).toHaveBeenCalled());
      expect(onDiskRead.mock.calls[0][0].sizeBytes).toBe(9_000_000);
      view.utils.unmount();
    });

    // A blocked save must never be a silent no-op — the button would appear dead.
    it('refuses an over-cap save and says why instead of doing nothing', async () => {
      const { ref, utils } = mountView({
        content: 'PREFIX',
        contentInfo: { sizeBytes: 9_000_000, truncated: true },
      });
      let ok: boolean | undefined;
      await act(async () => { ok = await ref.current!.saveEdit(); });
      expect(ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
      // Scoped to THIS view's container — renders from earlier tests in the file
      // are never unmounted, and RTL's queries default to the whole document.
      expect(within(utils.container).getAllByText(/only showing part of this file/i)).toHaveLength(1);
    });

    // Entering edit mode refreshes from disk. If THAT read reveals the file is
    // now a prefix, the editor must close rather than hold a truncated buffer.
    it('backs out of edit mode when the entry refresh reveals a prefix', async () => {
      const onDiskRead = vi.fn();
      const { ref } = mountView({
        content: 'small', contentInfo: { sizeBytes: 100, binary: false }, onDiskRead,
      });
      get.mockResolvedValue({ ok: true, content: 'PREFIX', binary: false,
                              truncated: true, sizeBytes: 9_000_000, mtimeMs: 2 });
      await act(async () => { ref.current!.startEdit(); });
      await waitFor(() => expect(ref.current!.editing).toBe(false));
      expect(onDiskRead).toHaveBeenCalled();
    });
  });
});

// Pins the artifact-pane read lifecycle (the "no longer on disk" flash fix).
// content === null used to be ONE signal meaning both "read in flight" and
// "file is gone", so EVERY artifact open flashed the alarming missing-file
// message until the read resolved. useArtifactContent + ArtifactContentState
// now keep loading / ready / missing / error apart. Pinned here:
//   1. While the read is pending: NO missing-file message — a quiet
//      loading placeholder instead.
//   2. A read that resolves orphan:true (the handler's genuine not-found
//      signal) shows "This file is no longer on disk."
//   3. A read that resolves with content shows the content.
//   4. A read ERROR is surfaced as the real error with Retry — never mapped
//      to "no longer on disk" (a permissions failure is not a deleted file).
describe('read lifecycle through useArtifactContent', () => {
  const get = vi.fn();
  const save = vi.fn();

  const MISSING_MSG = /no longer on disk/i;
  const LOADING_MSG = /Loading file/i;

  // Minimal real host: the same wiring SessionDrawer and FilesTab use —
  // useArtifactContent owns the read, ActiveArtifactView renders the phases.
  function Host({ artifact, root = '/proj', viewerRef, onSnapshot, onDelivery }: { artifact: any; root?: string; viewerRef?: React.Ref<ActiveArtifactHandle>; onSnapshot?: (value: unknown) => void; onDelivery?: (res: any) => void }) {
    const { content, setContent, contentInfo, contentState, retryRead, applyDiskRead } =
      useArtifactContent(root, artifact.id, artifact.path);
    React.useLayoutEffect(() => { onSnapshot?.({ content, contentInfo, contentState, retryRead }); });
    const deliver = React.useCallback((res: any) => { onDelivery?.(res); applyDiskRead(res); }, [applyDiskRead, onDelivery]);
    return (
      <ActiveArtifactView
        artifact={artifact}
        content={content}
        contentInfo={contentInfo}
        contentState={contentState}
        onRetryRead={retryRead}
        ref={viewerRef}
        onDiskRead={deliver}
        projectRoot={root}
        projectId="p1"
        projectName="Proj"
        sessionId="s1"
        onContentChange={setContent}
      />
    );
  }

  const mdArtifact = { id: 'a1', kind: 'internal', path: 'notes.md' } as any;

  // Controllable read: each get() call parks until the test resolves/rejects it.
  let pending: Array<{ resolve: (v: any) => void; reject: (e: any) => void }>;
  // Latest watcher subscription (ActiveArtifactView's onChanged effect) so tests
  // can simulate an external write / file-reappears event.
  let changedCb: ((evt: any) => void) | null;

  beforeEach(() => {
    pending = [];
    changedCb = null;
    get.mockReset().mockImplementation(
      () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); })
    );
    save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 1 });
    (window as any).claude = {
      artifacts: {
        get, save,
        onChanged: (cb: (evt: any) => void) => { changedCb = cb; return () => {}; },
      },
    };
  });

  // Queries bind to document.body — without cleanup, renders leak across tests
  // and getByText trips on the previous test's tree.
  afterEach(cleanup);

  async function settle(fn: () => void) {
    await act(async () => { fn(); });
  }

  describe('artifact pane read lifecycle', () => {
    it.each([['before event', false], ['while pending', false], ['while pending', true]] as const)('keeps typed edits and the original token when a watcher resolves after typing %s with truncated=%s', async (timing, truncated) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const snapshot = vi.fn();
      const artifact = { ...mdArtifact, id: `dirty-watch-${timing}-${truncated}` };
      const view = render(<Host artifact={artifact} viewerRef={ref} onSnapshot={snapshot} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'original', sizeBytes: 8 }));
      await settle(() => ref.current!.startEdit());
      await settle(() => pending[1].resolve({ ok: true, content: 'original', mtimeMs: 42 }));
      const type = () => fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'my unsaved typing' } });
      if (timing === 'before event') type();
      await settle(() => changedCb!({ projectRoot: '/proj', artifactId: artifact.id, kind: 'change' }));
      if (timing === 'while pending') type();
      const sizeBytes = truncated ? 9_000_000 : 13;
      await settle(() => pending[2].resolve({ ok: true, content: 'external edit', sizeBytes, truncated, mtimeMs: 99 }));
      expect(view.container.querySelector('textarea')!.value).toBe('my unsaved typing');
      expect(view.getByRole('button', { name: 'Use disk version' })).toBeTruthy();
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'original', contentInfo: { sizeBytes, truncated } });
      await act(async () => { expect(await ref.current!.saveEdit()).toBe(false); });
      expect(save).not.toHaveBeenCalled();
      view.unmount();
      flushRecoveryDrafts();
      expect(readRecoveryDraft(`file:/proj|${artifact.id}`)).toMatchObject({ text: 'my unsaved typing', mtimeMs: 42 });
    });

    it.each(['full', 'disk'] as const)('rejects obsolete %s action reads across selection, return, retry and unmount', async (source) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const snapshot = vi.fn();
      const delivery = vi.fn();
      const a = { ...mdArtifact, id: `action-${source}` };
      const props = { artifact: a, viewerRef: ref, onSnapshot: snapshot, onDelivery: delivery };
      const view = render(<Host {...props} />);
      const ready = { ok: true, content: 'original', mtimeMs: 42, truncated: source === 'full', sizeBytes: source === 'full' ? 9_000_000 : 8 };
      await settle(() => pending[0].resolve(ready));
      const startAction = async () => {
        if (source === 'disk') {
          await settle(() => ref.current!.startEdit());
          await settle(() => pending.at(-1)!.resolve({ ok: true, content: 'original', mtimeMs: 42 }));
          fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'my edit' } });
          await settle(() => changedCb!({ projectRoot: '/proj', artifactId: a.id, kind: 'change' }));
          await settle(() => pending.at(-1)!.resolve({ ok: true, content: 'external edit', mtimeMs: 99 }));
          fireEvent.click(view.getByRole('button', { name: 'Use disk version' }));
        } else fireEvent.click(view.getByRole('button', { name: /Load the whole file/i }));
        return pending.at(-1)!;
      };
      for (const field of ['id', 'root', 'path', 'return', 'retry', 'unmount'] as const) {
        const old = await startAction();
        if (field === 'retry') await settle(() => snapshot.mock.calls.at(-1)![0].retryRead());
        else if (field === 'unmount') view.unmount();
        else {
          view.rerender(<Host {...props} artifact={field === 'id' || field === 'return' ? { ...a, id: `${a.id}-b` } : field === 'path' ? { ...a, path: 'b.md' } : a} root={field === 'root' ? '/other' : '/proj'} />);
          if (field === 'return') view.rerender(<Host {...props} />);
        }
        if (field !== 'unmount') await settle(() => pending.at(-1)!.resolve({ ...ready, content: 'current' }));
        const deliveries = delivery.mock.calls.length;
        const commits = snapshot.mock.calls.length;
        await settle(() => old.resolve({ ok: true, content: 'STALE ACTION', truncated: true, resolvedPath: '/old/path' }));
        expect(delivery).toHaveBeenCalledTimes(deliveries);
        expect(snapshot).toHaveBeenCalledTimes(commits);
        if (field !== 'unmount') {
          expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'current' });
          // Reopen A to prepare the next independently invalidated action.
          view.rerender(<Host {...props} />);
          if (pending.at(-1) !== old) await settle(() => pending.at(-1)!.resolve(ready));
        }
      }
    });

    it.each(['id', 'root', 'path'] as const)('recovers an edited draft after an unguarded selection %s switch', async (field) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const a = { id: `draft-${field}`, kind: 'internal', path: 'draft.md' };
      const b = field === 'id' ? { ...a, id: `${a.id}-b`, path: 'b.md' }
        : field === 'path' ? { ...a, path: 'renamed.md' } : a;
      const view = render(<Host artifact={a} viewerRef={ref} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'A original' }));
      await settle(() => ref.current!.startEdit());
      await settle(() => pending[1].resolve({ ok: true, content: 'A original', mtimeMs: 42 }));
      fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'A unsaved' } });
      expect(ref.current!.dirty).toBe(true);
      view.rerender(<Host artifact={b} root={field === 'root' ? '/other' : '/proj'} viewerRef={ref} />);
      await settle(() => pending[2].resolve({ ok: true, content: field === 'path' ? 'A original' : 'B original', resolvedPath: field === 'path' ? '/proj/renamed.md' : '/other/b.md' }));
      if (field === 'path') {
        // Same record, renamed: recover at the new path without discarding the draft.
        expect(view.container.querySelector('textarea')!.value).toBe('A unsaved');
      } else {
        expect(ref.current!.editing).toBe(false);
        expect(view.container.querySelector('textarea')).toBeNull();
      }
      view.rerender(<Host artifact={a} viewerRef={ref} />);
      await settle(() => pending[3].resolve({ ok: true, content: 'A original' }));
      expect(ref.current!.editing).toBe(true);
      expect(view.container.querySelector('textarea')!.value).toBe('A unsaved');
      await settle(() => { void ref.current!.saveEdit(); });
      expect(save.mock.calls.at(-1)![6]).toMatchObject({ baseMtimeMs: 42 });
    });

    it.each(['rejected', 'error', 'missing', 'binary', 'truncated'] as const)('keeps a renamed draft recoverable after a %s read', async (failure) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const a = { id: `rename-${failure}`, kind: 'internal', path: 'original.md' };
      const renamed = { ...a, path: 'renamed.md' };
      const snapshot = vi.fn();
      const view = render(<Host artifact={a} viewerRef={ref} onSnapshot={snapshot} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'original text', resolvedPath: '/proj/original.md' }));
      await settle(() => ref.current!.startEdit());
      await settle(() => pending[1].resolve({ ok: true, content: 'original text', mtimeMs: 42 }));
      fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'unsaved rename draft' } });
      view.rerender(<Host artifact={renamed} viewerRef={ref} onSnapshot={snapshot} />);
      expect(ref.current!.editing).toBe(false);
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: null, contentInfo: null });
      await settle(() => {
        if (failure === 'rejected') pending[2].reject(new Error('read denied'));
        else pending[2].resolve(failure === 'error' ? { ok: false, error: 'read denied' }
          : failure === 'missing' ? { ok: true, orphan: true, content: null }
          : failure === 'binary' ? { ok: true, binary: true, content: null }
          : { ok: true, content: 'prefix', truncated: true, sizeBytes: 9_000_000 });
      });
      expect(ref.current!.editing).toBe(false);
      expect(view.container.querySelector('textarea')).toBeNull();
      // A failed read must not claim deletion; a genuine orphan still does.
      if (failure === 'missing') expect(view.queryByText(MISSING_MSG)).not.toBeNull();
      else expect(view.queryByText(MISSING_MSG)).toBeNull();
      if (failure === 'rejected' || failure === 'error' || failure === 'missing') {
        await settle(() => snapshot.mock.calls.at(-1)![0].retryRead());
      } else {
        // Non-editable content leaves the draft parked, recoverable on reopening.
        view.unmount();
        render(<Host artifact={renamed} viewerRef={ref} onSnapshot={snapshot} />);
      }
      await settle(() => pending[3].resolve({ ok: true, content: 'original text', resolvedPath: '/proj/renamed.md' }));
      expect(ref.current!.editing).toBe(true);
      expect(document.querySelector('textarea')!.value).toBe('unsaved rename draft');
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'original text', contentInfo: { resolvedPath: '/proj/renamed.md' } });
      await act(async () => { await ref.current!.saveEdit(); });
      expect(save.mock.calls.at(-1)![3]).toBe(a.id);
      expect(save.mock.calls.at(-1)![4]).toBe('unsaved rename draft');
      expect(save.mock.calls.at(-1)![6]).toMatchObject({ baseMtimeMs: 42 });
    });

    it.each([
      ['watcher', 'root'], ['watcher', 'path'], ['edit', 'root'], ['edit', 'path'],
    ] as const)('ignores a pending %s read after switching selection %s', async (source, field) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const a = { id: `late-${source}-${field}`, kind: 'internal', path: 'a.md' };
      const view = render(<Host artifact={a} viewerRef={ref} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'A original' }));
      await settle(() => {
        if (source === 'edit') ref.current!.startEdit();
        else changedCb!({ projectRoot: '/proj', artifactId: a.id, kind: 'change' });
      });
      // Same id: independently changing either root or path invalidates A.
      const b = field === 'path' ? { ...a, path: 'b.md' } : a;
      const snapshot = vi.fn();
      view.rerender(<Host artifact={b} root={field === 'root' ? '/other' : '/proj'} viewerRef={ref} onSnapshot={snapshot} />);
      await settle(() => pending[2].resolve({ ok: true, content: 'B original', resolvedPath: '/other/b.md' }));
      await settle(() => ref.current!.startEdit());
      await settle(() => pending[3].resolve({ ok: true, content: 'B original', mtimeMs: 77, resolvedPath: '/other/b.md' }));
      await settle(() => pending[1].resolve({ ok: true, content: 'LATE A', mtimeMs: 999, resolvedPath: '/proj/a.md', truncated: true }));
      expect(ref.current!.editing).toBe(true);
      expect(view.container.querySelector('textarea')!.value).toBe('B original');
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'B original', contentInfo: { resolvedPath: '/other/b.md' } });
      await act(async () => { await ref.current!.saveEdit(); });
      expect(save.mock.calls.at(-1)![6]).toMatchObject({ baseMtimeMs: 77 });
    });
    it.each(['watcher', 'edit'] as const)('invalidates a pending %s read on return, retry, and unmount', async (source) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const a = { id: `scope-${source}`, kind: 'internal', path: 'a.md' };
      const snapshot = vi.fn();
      const delivery = vi.fn();
      const view = render(<Host artifact={a} viewerRef={ref} onSnapshot={snapshot} onDelivery={delivery} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'A current' }));
      const startRead = () => source === 'edit' ? ref.current!.startEdit()
        : changedCb!({ projectRoot: '/proj', artifactId: a.id, kind: 'change' });
      await settle(startRead); // pending[1] belongs to the first visit to A
      view.rerender(<Host artifact={{ ...a, id: `${a.id}-b` }} viewerRef={ref} onSnapshot={snapshot} />);
      view.rerender(<Host artifact={a} viewerRef={ref} onSnapshot={snapshot} onDelivery={delivery} />);
      await settle(() => pending[3].resolve({ ok: true, content: 'A returned' }));
      await settle(() => pending[1].resolve({ ok: true, content: 'STALE first visit', truncated: true, mtimeMs: 999 }));
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'A returned' });
      await settle(startRead); // pending[4]
      await settle(() => snapshot.mock.calls.at(-1)![0].retryRead());
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: null, contentInfo: null, contentState: { phase: 'loading' } });
      await settle(() => pending[5].resolve({ ok: true, content: 'A retried' }));
      await settle(() => pending[4].resolve({ ok: true, content: 'STALE before retry', mtimeMs: 999 }));
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'A retried' });
      await settle(startRead); // pending[6]
      view.unmount();
      const commits = snapshot.mock.calls.length;
      const deliveries = delivery.mock.calls.length;
      await settle(() => pending[6].resolve({ ok: true, content: 'STALE after unmount' }));
      expect(snapshot).toHaveBeenCalledTimes(commits);
      expect(delivery).toHaveBeenCalledTimes(deliveries);
    });

    it.each(['id', 'root', 'path', 'return', 'retry', 'unmount'] as const)('rejects a captured raw disk delivery after %s', async (change) => {
      const initial = { root: '/proj', id: `raw-${change}`, path: 'a.md' };
      const hook = renderHook(({ root, id, path }) => useArtifactContent(root, id, path), { initialProps: initial });
      await settle(() => pending[0].resolve({ ok: true, content: 'initial' }));
      const stale = hook.result.current.applyDiskRead;
      if (change === 'retry') await settle(hook.result.current.retryRead);
      else if (change === 'unmount') hook.unmount();
      else {
        hook.rerender({ ...initial, ...(change === 'root' ? { root: '/other' } : change === 'path' ? { path: 'b.md' } : { id: 'other' }) });
        if (change === 'return') hook.rerender(initial);
      }
      if (change !== 'unmount') await settle(() => pending.at(-1)!.resolve({ ok: true, content: 'current' }));
      await settle(() => stale({ ok: true, content: 'STALE RAW', resolvedPath: '/old', truncated: true }));
      if (change !== 'unmount') {
        expect(hook.result.current.content).toBe('current');
        await settle(() => hook.result.current.applyDiskRead({ ok: true, content: 'explicit current', sizeBytes: 16 }));
        expect(hook.result.current.content).toBe('explicit current');
      }
    });

    it.each(['full', 'disk'] as const)('applies a current explicit %s action read', async (source) => {
      const ref = React.createRef<ActiveArtifactHandle>();
      const snapshot = vi.fn();
      const artifact = { ...mdArtifact, id: `current-action-${source}` };
      const view = render(<Host artifact={artifact} viewerRef={ref} onSnapshot={snapshot} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'original', truncated: source === 'full', sizeBytes: source === 'full' ? 9_000_000 : 8 }));
      if (source === 'disk') {
        await settle(() => ref.current!.startEdit());
        await settle(() => pending.at(-1)!.resolve({ ok: true, content: 'original', mtimeMs: 42 }));
        fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'my edit' } });
        await settle(() => changedCb!({ projectRoot: '/proj', artifactId: artifact.id, kind: 'change' }));
        await settle(() => pending.at(-1)!.resolve({ ok: true, content: 'external', mtimeMs: 99 }));
        fireEvent.click(view.getByRole('button', { name: 'Use disk version' }));
      } else fireEvent.click(view.getByRole('button', { name: /Load the whole file/i }));
      await settle(() => pending.at(-1)!.resolve({ ok: true, content: 'explicit disk', truncated: false, sizeBytes: 13 }));
      expect(snapshot.mock.calls.at(-1)![0]).toMatchObject({ content: 'explicit disk', contentInfo: { truncated: false, sizeBytes: 13 } });
    });

    it('commits loading with cleared metadata on retry from an error', async () => {
      const commits: Array<{ content: string | null; info: unknown; phase: string }> = [];
      let retry!: () => void;
      function Probe() {
        const r = useArtifactContent('/proj', 'retry-error', 'a.md');
        retry = r.retryRead;
        React.useLayoutEffect(() => { commits.push({ content: r.content, info: r.contentInfo, phase: r.contentState.phase }); });
        return null;
      }
      render(<Probe />);
      await settle(() => pending[0].resolve({ ok: false, error: 'read-failed', resolvedPath: '/proj/a.md' }));
      expect(commits.at(-1)!.phase).toBe('error');
      commits.length = 0;
      await settle(retry);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every((r) => r.content === null && r.info === null && r.phase === 'loading')).toBe(true);
    });

    it('never commits the previous missing state when switching to an image', async () => {
      const commits: string[] = [];
      function Probe({ id, path }: { id: string; path: string }) {
        const r = useArtifactContent('/proj', id, path);
        React.useLayoutEffect(() => { commits.push(r.contentState.phase); });
        return null;
      }
      const view = render(<Probe id="missing" path="missing.md" />);
      await settle(() => pending[0].resolve({ ok: true, orphan: true, content: null }));
      expect(commits.at(-1)).toBe('missing');
      commits.length = 0;
      view.rerender(<Probe id="image" path="wealth-game.jpg" />);
      expect(commits).not.toContain('missing');
      expect(commits.at(-1)).toBe('ready');
    });

    it.each(['id', 'root', 'path'] as const)('never commits stale content when the selection %s changes', async (field) => {
      const commits: Array<{ content: string | null; info: unknown; phase: string }> = [];
      function Probe({ root, id, path }: { root: string; id: string; path: string }) {
        const r = useArtifactContent(root, id, path);
        React.useLayoutEffect(() => { commits.push({ content: r.content, info: r.contentInfo, phase: r.contentState.phase }); });
        return null;
      }
      const initial = { root: '/proj', id: 'a1', path: 'a.md' };
      const view = render(<Probe {...initial} />);
      await settle(() => pending[0].resolve({ ok: true, content: 'previous file', sizeBytes: 13, resolvedPath: '/proj/a.md' }));
      commits.length = 0;
      view.rerender(<Probe {...initial} {...{ [field]: field === 'root' ? '/other' : 'b.md' }} />);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every((r) => r.content === null && r.info === null && r.phase === 'loading')).toBe(true);
    });
    it('shows a loading placeholder, NOT the missing-file message, while the read is pending', () => {
      const utils = render(<Host artifact={mdArtifact} />);
      expect(get).toHaveBeenCalledTimes(1);
      // The bug this whole change exists to fix:
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.getByText(LOADING_MSG)).toBeTruthy();
    });

    it('shows "no longer on disk" ONLY once the read genuinely resolved orphan:true', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
      expect(utils.getByText(MISSING_MSG)).toBeTruthy();
      expect(utils.queryByText(LOADING_MSG)).toBeNull();
    });

    it('shows the content once the read resolves with it', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({
        ok: true, content: '# Hello world', orphan: false, binary: false, mtimeMs: 1,
      }));
      expect(await utils.findByText('Hello world')).toBeTruthy();
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.queryByText(LOADING_MSG)).toBeNull();
    });

    it('says a file outside the project folders is refused for exactly that — no location, no promise', async () => {
      // A file the assistant wrote through `../`: it exists, so "no longer on
      // disk" would be false. The host sends no location (it reaches remote
      // browsers too), so the pane names none.
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'outside-projects' }));
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.getByText('YouCoded won’t open this file because it’s outside your project folders.')).toBeTruthy();
      expect(utils.getByText('Try again')).toBeTruthy();
    });

    it('hands an image recorded through ../ to the viewer at the location the host judged', async () => {
      // The record still holds `../notes/shot.png`; reading that by path would
      // resolve against the app's own folder (F3, review 2026-09-23).
      const readBinary = vi.fn(() => new Promise(() => {}));
      (window as any).claude.artifacts.readBinary = readBinary;
      const shot = { id: 'img', kind: 'external', path: 'shot.png', absolutePath: '../notes/shot.png' } as any;
      function ImgHost() {
        const r = useArtifactContent('/proj', shot.id, contentPathFor(shot));
        return <ActiveArtifactView artifact={shot} content={r.content} contentInfo={r.contentInfo} contentState={r.contentState}
          onRetryRead={r.retryRead} projectRoot="/proj" projectId="p1" projectName="Proj" sessionId="s1" onContentChange={r.setContent} />;
      }
      render(<ImgHost />);
      await settle(() => pending[0].resolve({ ok: true, content: null, orphan: false, binary: true, sizeBytes: 3, resolvedPath: '/home/u/notes/shot.png' }));
      await waitFor(() => expect(readBinary).toHaveBeenCalledWith('/home/u/notes/shot.png'));
    });

    it('offers a phone Download of a too-large ../ file at the location the host judged', async () => {
      // Re-review C5: the Download used the record's relative location.
      setConnectionMode('remote');
      try {
        const download = vi.fn().mockResolvedValue({ ok: true });
        (window as any).claude.artifacts.download = download;
        const big = { id: 'big', kind: 'external', path: 'report.pdf', absolutePath: '../notes/report.pdf' } as any;
        function BigHost() {
          const r = useArtifactContent('/proj', big.id, contentPathFor(big));
          return <ActiveArtifactView artifact={big} content={r.content} contentInfo={r.contentInfo} contentState={r.contentState}
            onRetryRead={r.retryRead} projectRoot="/proj" projectId="p1" projectName="Proj" sessionId="s1" onContentChange={r.setContent} />;
        }
        const utils = render(<BigHost />);
        await settle(() => pending[0].resolve({ ok: false, error: 'too-large', sizeBytes: 24e6, limitBytes: 10e6, resolvedPath: '/home/u/notes/report.pdf' }));
        await settle(() => { fireEvent.click(utils.getByText('Download')); });
        expect(download).toHaveBeenCalledWith('/home/u/notes/report.pdf', { projectRoot: '/proj', artifactId: 'big' });
      } finally { setConnectionMode('local'); }
    });

    it('says a file in a project outside the home folder is refused by the rule, not as "outside"', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'not-in-home-project' }));
      expect(utils.getByText('YouCoded only opens files like this when they’re inside a project folder in your home folder.')).toBeTruthy();
    });

    it('says the check failed, with the filesystem’s own reason', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'record-unreadable', code: 'EACCES' }));
      expect(utils.getByText('YouCoded couldn’t check this file (permission denied).')).toBeTruthy();
    });

    it('words a protected location plainly', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'protected-path' }));
      expect(utils.getByText('YouCoded won’t open this file because it’s in a protected location (like saved passwords, keys or settings folders).')).toBeTruthy();
    });

    it('surfaces a failed read as the real error with Retry — never as "no longer on disk"', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'protected-path' }));
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.getByText(/protected location/i)).toBeTruthy();
      // Retry re-runs the read; a successful second read shows the content.
      await settle(() => { fireEvent.click(utils.getByText('Try again')); });
      expect(get).toHaveBeenCalledTimes(2);
      await settle(() => pending[1].resolve({
        ok: true, content: '# Back now', orphan: false, binary: false, mtimeMs: 2,
      }));
      expect(await utils.findByText('Back now')).toBeTruthy();
    });

    it('surfaces a rejected invoke (thrown handler error) as an error, not a deleted file', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].reject(new Error('EACCES: permission denied')));
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.getByText(/EACCES: permission denied/)).toBeTruthy();
    });

    it('unknown error codes surface verbatim (never a guessed cause)', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'weird-new-code' }));
      expect(utils.getByText(/weird-new-code/)).toBeTruthy();
    });

    it('legacy callers without contentState keep the old semantics (null = missing)', () => {
      // Back-compat pin: a caller that has not adopted the tri-state must not
      // silently lose the missing-file notice.
      const utils = render(
        <ActiveArtifactView
          artifact={mdArtifact}
          content={null}
          projectRoot="/proj"
          projectId="p1"
          projectName="Proj"
          sessionId="s1"
          onContentChange={() => {}}
        />
      );
      expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    });

    it('switching artifacts returns to loading (no stale missing message from the previous file)', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
      expect(utils.getByText(MISSING_MSG)).toBeTruthy();
      // Switch to another file: the pane must drop back to loading, not keep
      // claiming the NEW file is gone while its read is in flight.
      await settle(() => {
        utils.rerender(<Host artifact={{ id: 'a2', kind: 'internal', path: 'other.md' } as any} />);
      });
      expect(get).toHaveBeenCalledTimes(2);
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.getByText(LOADING_MSG)).toBeTruthy();
    });

    it('ignores a stale resolve from a switched-away artifact (cancelled guard)', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      // Switch to a2 while a1's read is STILL pending — a1's late resolve must
      // not paint a1's content (or any resolved phase) into a2's pane.
      await settle(() => {
        utils.rerender(<Host artifact={{ id: 'a2', kind: 'internal', path: 'other.md' } as any} />);
      });
      expect(get).toHaveBeenCalledTimes(2);
      await settle(() => pending[0].resolve({
        ok: true, content: '# Hello from a1', orphan: false, binary: false, mtimeMs: 1,
      }));
      expect(utils.queryByText('Hello from a1')).toBeNull();
      expect(utils.getByText(LOADING_MSG)).toBeTruthy();
    });

    it('routes a text-extension file that sniffed BINARY to BinaryFallback, not a blank text viewer', async () => {
      // PR #303 follow-up bug: a .md (or .ts, …) containing NUL bytes resolves
      // with content:null + binary:true. The pane routed by EXTENSION to
      // MarkdownView/CodeEditorView, which rendered an empty pane from the null
      // content — a quiet blank instead of an honest "can't preview".
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({
        ok: true, content: null, orphan: false, binary: true, sizeBytes: 128,
      }));
      expect(utils.getByText(/contains data that isn.t text/i)).toBeTruthy();
      // Not the pre-#303 false claim, and not the loading placeholder either.
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.queryByText(LOADING_MSG)).toBeNull();
    });

    it('routes a sniffed-binary .html to BinaryFallback, not a perpetual "Loading…"', async () => {
      // Review gap on the same bug class: HtmlView also renders from the text
      // content prop (srcDoc) and with content:null shows "Loading…" FOREVER —
      // an unresolvable claim, worse than blank. Fallback + "Open in default
      // app" (→ browser) is the honest treatment.
      const utils = render(<Host artifact={{ id: 'a4', kind: 'internal', path: 'page.html' } as any} />);
      await settle(() => pending[0].resolve({
        ok: true, content: null, orphan: false, binary: true, sizeBytes: 128,
      }));
      expect(utils.getByText(/contains data that isn.t text/i)).toBeTruthy();
      expect(utils.queryByText(/^Loading…$/)).toBeNull();
    });

    it('a real binary-viewer extension (.png) routes to its viewer with no text read at all', async () => {
      // Control for the test above: files whose registered viewer already handles
      // bytes (Image/Pdf/…) must NOT land in the fallback. Since 2026-08-25 they
      // also never request text — the hook settles synchronously into
      // binary:true/ready, so there is no pending read to resolve here.
      const utils = render(<Host artifact={{ id: 'a3', kind: 'internal', path: 'shot.png' } as any} />);
      await settle(() => {});
      expect(pending).toHaveLength(0);
      expect(utils.queryByText(/contains data that isn.t text/i)).toBeNull();
      // Proof ImageView mounted: its byte-read path reports 'unavailable'
      // because this test's mock exposes no artifacts.readBinary.
      expect(utils.getByText(/Preview isn.t available/i)).toBeTruthy();
    });

    it('recovers from missing when the file reappears on disk (watcher refetch → onContentChange)', async () => {
      // PR #303 review regression: ActiveArtifactView's onChanged effect hands
      // refetched bytes back via onContentChange WITHOUT re-running the hook's
      // read — the phase must reconcile to ready, not stay stuck on "missing"
      // until reselect. Pre-tri-state this auto-recovered.
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
      expect(utils.getByText(MISSING_MSG)).toBeTruthy();
      // Agent recreates the file → watcher 'add'/'change' → subscribed handler
      // refetches (the REAL production path, not a synthetic setContent call).
      expect(changedCb).toBeTruthy();
      await settle(() => changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'add' }));
      expect(get).toHaveBeenCalledTimes(2);
      await settle(() => pending[1].resolve({
        ok: true, content: '# Recovered', orphan: false, binary: false, mtimeMs: 2,
      }));
      expect(await utils.findByText('Recovered')).toBeTruthy();
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
    });
  });

  // ── Byte-only routing: images/PDFs/Office docs never take the text path ──
  // THE REPORTED BUG (2026-08-25): a 2.3 MB PNG was refused by the TEXT editor's
  // 2 MB cap, even though images are governed by the 50 MB byte ceiling and never
  // use the text at all.
  describe('byte-only files never take the text path', () => {
    it('does not call artifacts.get for a png', async () => {
      const { result } = renderHook(() => useArtifactContent('/proj', 'a1', 'shot.png'));
      await waitFor(() => expect(result.current.contentState.phase).toBe('ready'));
      expect(get).not.toHaveBeenCalled();
      expect(result.current.content).toBeNull();
      // binary:true is what holds the edit affordance shut downstream.
      expect(result.current.contentInfo?.binary).toBe(true);
    });

    it('still calls artifacts.get for svg, which is editable', async () => {
      renderHook(() => useArtifactContent('/proj', 'a2', 'logo.svg'));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    });

    it('asks the host about an image recorded through ../ instead of reading it by a relative path', async () => {
      // Unrepaired `../` record: the byte viewer would resolve it against the
      // app's own folder and say "no longer exists on disk" for a file that is
      // there. contentPathFor withholds the path so get() gives the real answer.
      const rec = { kind: 'external', path: 'shot.png', absolutePath: '../elsewhere/shot.png' };
      expect(contentPathFor(rec)).toBeNull();
      expect(contentPathFor({ ...rec, absolutePath: '/home/u/elsewhere/shot.png' })).toBe('shot.png');
      expect(contentPathFor({ ...rec, absolutePath: 'C:\\u\\shot.png' })).toBe('shot.png');
      expect(contentPathFor({ kind: 'internal', path: 'a/shot.png', absolutePath: null })).toBe('a/shot.png');
      renderHook(() => useArtifactContent('/proj', 'a4', contentPathFor(rec)));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    });

    it('still calls artifacts.get when no path is supplied', async () => {
      renderHook(() => useArtifactContent('/proj', 'a3'));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    });

    // The back door: the watcher re-requests text on EVERY on-disk change for
    // EVERY file type. Its `res.content ?? \'\'` would set an IMAGE's content to
    // the empty string, which downstream reads as an ordinary editable text file.
    it('does not call artifacts.get when an image changes on disk', () => {
      render(
        <ActiveArtifactView
          artifact={{ id: 'a1', kind: 'internal', path: 'shot.png' } as any}
          content={null}
          contentInfo={{ binary: true }}
          contentState={{ phase: 'ready' }}
          projectRoot="/proj"
          projectId="p1"
          projectName="Proj"
          sessionId="s1"
          onContentChange={vi.fn()}
        />
      );
      get.mockClear();
      changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'change' });
      expect(get).not.toHaveBeenCalled();
    });
  });

  // ── Partial-view metadata must survive the trip from response to banner ──
  // Caught in Workbench review 2026-08-25: useArtifactContent copied the get()
  // response into contentInfo field by field and silently dropped `truncated`,
  // so the banner never rendered for ANY over-cap file. Nothing failed; the
  // notice was simply absent.
  describe('over-cap text reaches the partial-view banner', () => {
    it('carries truncated and sizeBytes from the response into contentInfo', async () => {
      const { result } = renderHook(() => useArtifactContent('/proj', 'a9', 'server.log'));
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => {
        pending[0].resolve({
          ok: true, content: 'first chunk\n', orphan: false, binary: false,
          truncated: true, sizeBytes: 8.4 * 1024 * 1024, mtimeMs: 1,
        });
      });
      await waitFor(() => expect(result.current.contentInfo?.truncated).toBe(true));
      expect(result.current.contentInfo?.sizeBytes).toBe(8.4 * 1024 * 1024);
    });

    it('renders the banner end to end, stating the real size not the prefix size', async () => {
      const utils = render(<Host artifact={{ id: 'a9', kind: 'internal', path: 'logs/server.log' } as any} />);
      await settle(() => pending[0].resolve({
        ok: true, content: 'first chunk\n', orphan: false, binary: false,
        truncated: true, sizeBytes: 8.4 * 1024 * 1024, mtimeMs: 1,
      }));
      expect(utils.getByText(/Showing 3\.0\/8\.4 MB/)).toBeTruthy();
    });

    // A complete file must NOT wear the notice.
    it('shows no banner for a file served whole', async () => {
      const utils = render(<Host artifact={{ id: 'a10', kind: 'internal', path: 'logs/small.log' } as any} />);
      await settle(() => pending[0].resolve({
        ok: true, content: 'all of it\n', orphan: false, binary: false,
        truncated: false, sizeBytes: 10, mtimeMs: 1,
      }));
      expect(utils.queryByText(/Large file/)).toBeNull();
    });
  });
});

/**
 * A save never writes blind over a file that may have changed.
 *
 * The "this file changed on disk" check
 * rides on a modification-time token, and the ONLY place a first edit gets that token is
 * the artifacts:get that startEdit fires. If that read failed (or had not landed yet),
 * the editor opened anyway with no token, the save sent no `baseMtimeMs`, and main's
 * write-authorization skips the conflict check when none arrives — so another writer's
 * newer version was silently overwritten while the user saw a normal, successful save.
 *
 * Now a save with no token reads the file first: unchanged since the editor loaded it →
 * save WITH that read's token; changed → the existing conflict banner; unreadable →
 * refuse, and say the check could not be made.
 *
 * Same harness as the "edit and save guards" section above, which pins the token when
 * startEdit's read DOES work.
 */
describe('first save without a conflict token', () => {
  const save = vi.fn();
  const get = vi.fn();

  function mountView() {
    const ref = React.createRef<ActiveArtifactHandle>();
    const utils = render(
      <ActiveArtifactView
        ref={ref}
        {...({
          artifact: { id: 'a1', kind: 'internal', path: 'notes.md' },
          content: 'hello',
          projectRoot: '/proj',
          projectId: 'p1',
          projectName: 'Proj',
          sessionId: 's1',
          onContentChange: vi.fn(),
        } as any)}
      />,
    );
    return { ref, utils };
  }

  /** Enter edit mode with startEdit's own read FAILING, so no token is captured. */
  async function editWithoutToken(ref: React.RefObject<ActiveArtifactHandle | null>) {
    await act(async () => { ref.current!.startEdit(); });
    expect(ref.current!.editing).toBe(true);
  }

  beforeEach(() => {
    save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 100 });
    get.mockReset();
    (window as any).claude = { artifacts: { save, get, onChanged: () => () => {} } };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  describe('ActiveArtifactView — a save with no conflict token is never unguarded', () => {
    it('when the file is unchanged, saves WITH the token from a fresh read', async () => {
      get
        .mockRejectedValueOnce(new Error('bridge closed'))
        .mockResolvedValue({ ok: true, content: 'hello', orphan: false, mtimeMs: 77 });
      const { ref } = mountView();
      await editWithoutToken(ref);

      await act(async () => { await ref.current!.saveEdit(); });

      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][6]).toMatchObject({ baseMtimeMs: 77 });
    });

    it('when the file changed since it was loaded, raises the conflict banner and does not save', async () => {
      get
        .mockRejectedValueOnce(new Error('bridge closed'))
        .mockResolvedValue({ ok: true, content: 'someone else wrote this', orphan: false, mtimeMs: 88 });
      const { ref, utils } = mountView();
      await editWithoutToken(ref);

      let ok: boolean | undefined;
      await act(async () => { ok = await ref.current!.saveEdit(); });

      expect(ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(utils.getByText(/changed on disk while you were editing/i)).toBeTruthy();
    });

    it('when the check itself fails, refuses to save and says the check could not be made', async () => {
      get.mockRejectedValue(new Error('bridge closed'));
      const { ref, utils } = mountView();
      await editWithoutToken(ref);

      let ok: boolean | undefined;
      await act(async () => { ok = await ref.current!.saveEdit(); });

      expect(ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
      expect(utils.getByText(/couldn.t check/i)).toBeTruthy();
    });
  });
});

/**
 * CHANGE (Destin, testing the dev instance): a fresh code-file comment used
 * to force a switch into the whole Comments panel (the old bug fix this
 * block used to pin — selecting text, right-clicking "Add comment", typing
 * a note only worked once ActiveArtifactView auto-flipped commentsMode).
 * Code now matches markdown/text files exactly: the draft gets the SAME
 * small floating box (CodeCommentPopover, anchored through CM6's own
 * `coordsAtPos`) right over the selection, in Reading mode, with no mode
 * switch at all — see CodeCommentPopover.tsx and ActiveArtifactView.tsx's
 * own WHY at the old effect's former call site.
 */
describe('shrinking the comments panel', () => {
  afterEach(() => {
    commentLayout.narrow = false;
    commentLayout.expanded = undefined;
    commentLayout.dispatch = undefined;
  });

  it('returns to reading without re-expanding, and Comments can open the panel again', async () => {
    (window as any).claude = { artifacts: { onChanged: () => () => {} } };
    commentLayout.narrow = true;
    commentLayout.expanded = false;
    commentLayout.dispatch = vi.fn();
    const ref = React.createRef<ActiveArtifactHandle>();
    const onCommentsStateChange = vi.fn();
    const props = {
      artifact: { id: 'md-collapse', kind: 'internal', path: 'notes.md' } as any,
      content: 'A document to discuss.', projectRoot: '/proj', projectId: 'p1',
      projectName: 'Proj', sessionId: 's1', onContentChange: vi.fn(), onCommentsStateChange,
    };
    const { rerender } = render(<ActiveArtifactView ref={ref} {...props} />);
    await waitFor(() => expect(ref.current).toBeTruthy());
    act(() => { ref.current!.toggleComments(); });
    expect(commentLayout.dispatch).toHaveBeenCalledTimes(1);

    commentLayout.expanded = true;
    commentLayout.narrow = false;
    rerender(<ActiveArtifactView ref={ref} {...props} />);
    commentLayout.expanded = false;
    commentLayout.narrow = true;
    rerender(<ActiveArtifactView ref={ref} {...props} />);

    expect(onCommentsStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ active: false, paneVisible: false }));
    expect(commentLayout.dispatch).toHaveBeenCalledTimes(1);
    act(() => { ref.current!.toggleComments(); });
    expect(commentLayout.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('code files show the small popover for a fresh draft, not the panel', () => {
  const get = vi.fn();
  const PATH = 'total.py';

  beforeAll(() => {
    // jsdom never lays out real geometry — CodeCommentPopover's own
    // `visibleEditorFor` needs `getClientRects().length > 0` (same
    // precedent as use-code-comment-anchors.test.tsx), and CM6's
    // `coordsAtPos` needs real layout to answer at all.
    Element.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
    vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 30 } as any);
  });

  beforeEach(() => {
    __resetDocCommentsStoreForTest();
    get.mockReset().mockResolvedValue({ ok: true, content: 'result += price\n', orphan: false, mtimeMs: 1 });
    (window as any).claude = {
      artifacts: { save: vi.fn(), get, onChanged: () => () => {} },
    };
  });
  afterEach(() => { __resetDocCommentsStoreForTest(); });

  it('renders the popover above the viewer, and commentsMode never switches to comments', async () => {
    // The same call build-menu.ts's "Add comment" makes from the right-click
    // menu on a code file's selection.
    addComment(PATH, 'result += p', 'line 3 · total.py', {
      startLine: 3, endLine: 3, prefix: '', suffix: '', occurrence: 0, projectRoot: '/proj',
    });
    const onCommentsStateChange = vi.fn();
    const { container } = render(
      <ActiveArtifactView
        artifact={{ id: 'py1', kind: 'internal', path: PATH } as any}
        content="result += price\n"
        projectRoot="/proj"
        projectId="p1"
        projectName="Proj"
        sessionId="s1"
        onContentChange={vi.fn()}
        onCommentsStateChange={onCommentsStateChange}
      />,
    );
    // CodeCommentPopover renders the draft's own auto-focused note box — the
    // same "Add a comment…" textarea a text file's popover shows.
    // WHY body: the composer escapes the viewer's backdrop/mask roots so its glass can frost.
    await waitFor(() => expect(within(document.body).getByRole('textbox', { name: 'New comment' })).toBeTruthy());
    // Never switched into the full panel — no auto-open-panel effect exists
    // anymore, and the panel's own chrome (Show Resolved) is absent.
    expect(onCommentsStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    expect(container.querySelector('[data-comments-list]')).toBeNull();
  });
});
