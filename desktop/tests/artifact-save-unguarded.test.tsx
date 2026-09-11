// @vitest-environment jsdom
/**
 * A save never writes blind over a file that may have changed.
 *
 * Error inventory 2026-09-10, false message 11. The "this file changed on disk" check
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
 * Same harness as active-artifact-view.test.tsx, which pins the token when startEdit's
 * read DOES work.
 */
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
async function editWithoutToken(ref: React.RefObject<ActiveArtifactHandle>) {
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
