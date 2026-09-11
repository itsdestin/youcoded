// @vitest-environment jsdom
// A save that cannot happen says so (2026-09-11).
//
// main threw on a failed write (EACCES, a read-only disk, a full disk) and the
// editor had no catch around artifacts.save, so the Save button did nothing at
// all: no banner, no log the user could see, and the draft still unsaved. The
// answer is now a coded result the renderer maps to copy — naming a cause only
// where the code is unambiguous, and staying non-committal otherwise.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ActiveArtifactView, type ActiveArtifactHandle } from '../src/renderer/components/artifact-views/ActiveArtifactView';

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
        contentInfo: { binary: false, truncated: false, sizeBytes: 5 },
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

beforeEach(() => {
  save.mockReset();
  get.mockReset().mockResolvedValue({ ok: true, content: 'hello', orphan: false, mtimeMs: 42 });
  (window as any).claude = { artifacts: { save, get, onChanged: () => () => {} } };
});

describe('ActiveArtifactView — a failed save is never silent', () => {
  it('shows the failure when the save call itself rejects', async () => {
    save.mockRejectedValue(new Error('bridge closed'));
    const { ref, utils } = mountView();
    await act(async () => { ref.current!.startEdit(); });
    let ok: boolean | undefined;
    await act(async () => { ok = await ref.current!.saveEdit(); });
    expect(ok).toBe(false);
    expect(utils.getByText(/couldn.t save this file/i)).toBeTruthy();
  });

  it('names the cause when the code is unambiguous', async () => {
    save.mockResolvedValue({ ok: false, error: 'write-failed', code: 'EACCES' });
    const { ref, utils } = mountView();
    await act(async () => { ref.current!.startEdit(); });
    await act(async () => { await ref.current!.saveEdit(); });
    expect(utils.getByText(/doesn.t have permission to change this file/i)).toBeTruthy();
  });

  it('stays non-committal for a write failure it cannot explain', async () => {
    save.mockResolvedValue({ ok: false, error: 'write-failed', code: 'EWHATEVER' });
    const { ref, utils } = mountView();
    await act(async () => { ref.current!.startEdit(); });
    await act(async () => { await ref.current!.saveEdit(); });
    const banner = utils.getByText(/couldn.t save this file/i).textContent ?? '';
    expect(banner).toMatch(/changes are still here/i);
    expect(banner).not.toMatch(/permission|read-only|space|another program/i);
  });
});
