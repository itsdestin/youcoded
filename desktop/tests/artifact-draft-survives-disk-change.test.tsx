// @vitest-environment jsdom
// Unsaved typing survives the file changing on disk (2026-09-11).
//
// With the real host wiring (useArtifactContent + onDiskRead, as SessionDrawer
// and FilesTab use it), a watcher refetch swapped the disk text into `content`;
// ActiveArtifactView's draft-reset effect then replaced the draft with it and
// cleared the conflict banner the watcher had just raised. The user's typing
// vanished while the editor stayed open on the other version. The existing
// active-artifact-view tests stub onDiskRead, so `content` never changed there.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor, fireEvent } from '@testing-library/react';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { useArtifactContent } from '../src/renderer/components/artifact-views/useArtifactContent';

const save = vi.fn();
const get = vi.fn();
let changed: ((evt: any) => void) | null = null;

const ARTIFACT = { id: 'a1', kind: 'internal', path: 'notes.md' } as any;

function Host({ viewRef }: { viewRef: React.RefObject<ActiveArtifactHandle | null> }) {
  const { content, setContent, contentInfo, contentState, retryRead, applyDiskRead } =
    useArtifactContent('/proj', ARTIFACT.id, ARTIFACT.path);
  return (
    <ActiveArtifactView
      ref={viewRef}
      artifact={ARTIFACT}
      content={content}
      contentInfo={contentInfo}
      contentState={contentState}
      onRetryRead={retryRead}
      onDiskRead={applyDiskRead}
      projectRoot="/proj"
      projectId="p1"
      projectName="Proj"
      sessionId="s1"
      onContentChange={setContent}
    />
  );
}

async function openAndType(typed: string) {
  const ref = React.createRef<ActiveArtifactHandle>();
  const utils = render(<Host viewRef={ref} />);
  await waitFor(() => expect(ref.current?.isEditable).toBe(true));
  await act(async () => { ref.current!.startEdit(); });
  const textarea = await waitFor(() => {
    const el = utils.container.querySelector('textarea');
    expect(el).toBeTruthy();
    return el!;
  });
  await act(async () => { fireEvent.change(textarea, { target: { value: typed } }); });
  expect(ref.current!.dirty).toBe(true);
  return { ref, utils };
}

beforeEach(() => {
  changed = null;
  save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 200 });
  get.mockReset().mockResolvedValue({ ok: true, content: 'hello', orphan: false, binary: false, truncated: false, sizeBytes: 5, mtimeMs: 42 });
  (window as any).claude = {
    artifacts: {
      save,
      get,
      onChanged: (cb: any) => { changed = cb; return () => { if (changed === cb) changed = null; }; },
    },
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ActiveArtifactView — unsaved typing survives a change on disk', () => {
  it('keeps the draft and shows the "changed on disk" banner when the file changes mid-edit', async () => {
    const { ref, utils } = await openAndType('my unsaved typing');

    get.mockResolvedValue({ ok: true, content: 'the assistant version', orphan: false, binary: false, truncated: false, sizeBytes: 21, mtimeMs: 99 });
    await act(async () => { changed!({ projectRoot: '/proj', artifactId: 'a1', kind: 'edit', by: 'agent' }); });

    await waitFor(() => expect(utils.getByText(/changed on disk while you were editing/i)).toBeTruthy());
    expect(ref.current!.editing).toBe(true);
    expect(utils.container.querySelector('textarea')!.value).toBe('my unsaved typing');
  });

  it('a plain Save cannot silently pick a side while the banner is up; "Keep mine" writes the draft', async () => {
    const { ref, utils } = await openAndType('my unsaved typing');
    get.mockResolvedValue({ ok: true, content: 'the assistant version', orphan: false, binary: false, truncated: false, sizeBytes: 21, mtimeMs: 99 });
    await act(async () => { changed!({ projectRoot: '/proj', artifactId: 'a1', kind: 'edit', by: 'agent' }); });
    await waitFor(() => expect(utils.getByText(/changed on disk while you were editing/i)).toBeTruthy());

    let ok: boolean | undefined;
    await act(async () => { ok = await ref.current!.saveEdit(); });
    expect(ok).toBe(false);
    expect(save).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(utils.getByText('Keep mine')); });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][4]).toBe('my unsaved typing');
  });

  it("keeps typing done before edit mode's own refresh read lands", async () => {
    const ref = React.createRef<ActiveArtifactHandle>();
    const utils = render(<Host viewRef={ref} />);
    await waitFor(() => expect(ref.current?.isEditable).toBe(true));

    let landRefresh: (v: any) => void = () => {};
    get.mockImplementationOnce(() => new Promise((r) => { landRefresh = r; }));
    await act(async () => { ref.current!.startEdit(); });
    const textarea = utils.container.querySelector('textarea')!;
    await act(async () => { fireEvent.change(textarea, { target: { value: 'typed fast' } }); });

    await act(async () => {
      landRefresh({ ok: true, content: 'hello', orphan: false, binary: false, truncated: false, sizeBytes: 5, mtimeMs: 42 });
    });
    expect(utils.container.querySelector('textarea')!.value).toBe('typed fast');
    expect(utils.queryByText(/changed on disk while you were editing/i)).toBeNull();
  });
});
