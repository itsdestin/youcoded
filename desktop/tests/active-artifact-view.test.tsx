// @vitest-environment jsdom
// Pins the D4-unlock safety behavior of ActiveArtifactView (plan step 4):
// 1. THE §2.2 EMPTY-FILE GUARANTEE — while content is null (fetch transient /
//    orphan / binary) a save must be hard-blocked: both hosts setContent(null)
//    before the get resolves, and a save in that window would truncate the
//    file to an empty draft. This is the highest-risk regression in the
//    workstream; if this test starts failing, do not ship.
// 2. The renderer's D5 mirror hides editability for denied paths.
// 3. dirty only when edit mode holds real divergence from resolved content.
// 4. The concurrency token from startEdit's refresh rides into the save.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor, within } from '@testing-library/react';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../src/renderer/components/artifact-views/ActiveArtifactView';

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
