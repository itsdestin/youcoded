// @vitest-environment jsdom
// ActiveArtifactView — the file pane's viewer and editor: what may be edited and
// saved, how a read's phases (loading / ready / missing / error) render through
// useArtifactContent, and the conflict check that guards every save. Each section
// keeps its own window.claude bridge fake and hooks, so they stay inside it.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup, renderHook, waitFor, within } from '@testing-library/react';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { useArtifactContent } from '../src/renderer/components/artifact-views/useArtifactContent';

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
  function Host({ artifact }: { artifact: any }) {
    const { content, setContent, contentInfo, contentState, retryRead } =
      useArtifactContent('/proj', artifact.id, artifact.path);
    return (
      <ActiveArtifactView
        artifact={artifact}
        content={content}
        contentInfo={contentInfo}
        contentState={contentState}
        onRetryRead={retryRead}
        projectRoot="/proj"
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

    it('surfaces a failed read as the real error with Retry — never as "no longer on disk"', async () => {
      const utils = render(<Host artifact={mdArtifact} />);
      await settle(() => pending[0].resolve({ ok: false, error: 'protected-path' }));
      expect(utils.queryByText(MISSING_MSG)).toBeNull();
      expect(utils.getByText(/protected location/i)).toBeTruthy();
      // Retry re-runs the read; a successful second read shows the content.
      await settle(() => { fireEvent.click(utils.getByText('Retry')); });
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
      expect(utils.queryByText(/Large File/)).toBeNull();
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
