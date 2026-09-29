// @vitest-environment jsdom
// "Open it" for a parked draft: its live session's drawer when that session works in the draft's
// folder; otherwise Project View → Files for the draft's folder. A dead session is never selected.
// And "Open it" is only offered when the editor could take the draft back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearProjectViewRequest, openParkedDraft, routeParkedDraft, useParkedDraftOpener, useProjectViewRequest } from '../src/renderer/state/parked-draft-opener';
import { draftFileEditable } from '../src/renderer/components/artifact-views/edit-permission';
import type { ArtifactRecord } from '../src/shared/artifacts/types';

const artifact = { id: 'notes.md', path: 'notes.md', kind: 'internal', absolutePath: null } as unknown as ArtifactRecord;
afterEach(() => { clearProjectViewRequest(); delete (window as unknown as { claude?: unknown }).claude; });

describe('where "Open it" opens a parked draft', () => {
  it('routes to the live session only when it works in the draft folder', () => {
    const live = [{ id: 's1', cwd: '/home/you/proj' }, { id: 's2', cwd: '/home/you/other' }];
    expect(routeParkedDraft({ sessionId: 's1', artifact, projectRoot: '/home/you/proj' }, live)).toBe('s1');
    expect(routeParkedDraft({ sessionId: 's2', artifact, projectRoot: '/home/you/proj' }, live)).toBeNull(); // another folder
    expect(routeParkedDraft({ sessionId: 'gone', artifact, projectRoot: '/home/you/proj' }, live)).toBeNull(); // not live here
    expect(routeParkedDraft({ sessionId: 'project-view', artifact, projectRoot: '/home/you/proj' }, live)).toBeNull();
  });

  it("opens the live session's drawer on the file", () => {
    const dispatch = vi.fn();
    const select = vi.fn();
    renderHook(() => useParkedDraftOpener(dispatch, select, 's2', [{ id: 's1', cwd: '/p' }, { id: 's2', cwd: '/q' }]));
    act(() => openParkedDraft({ sessionId: 's1', artifact, projectRoot: '/p' }));
    expect(select).toHaveBeenCalledWith('s1');
    expect(dispatch).toHaveBeenCalledWith({ type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'notes.md' });
  });

  it('opens Project View on the draft folder when its session has ended — never selecting it', () => {
    const dispatch = vi.fn();
    const select = vi.fn();
    const request = renderHook(() => useProjectViewRequest());
    renderHook(() => useParkedDraftOpener(dispatch, select, 's2', [{ id: 's2', cwd: '/q' }]));
    act(() => openParkedDraft({ sessionId: 'ended', artifact, projectRoot: '/p' }));
    expect(select).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({ type: 'PROJECT_VIEW_OPENED' });
    expect(request.result.current).toEqual({ projectPath: '/p', artifact });
  });
});

describe('whether a parked draft can be put back', () => {
  const answer = (res: unknown) => { (window as unknown as { claude: unknown }).claude = { artifacts: { get: vi.fn(async () => res) } }; };
  it('only for an editable text file: not missing, binary, too large, drawn from bytes, or protected', async () => {
    answer({ ok: true, content: 'hi', sizeBytes: 2 });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(true);
    answer({ ok: true, content: null, orphan: true });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
    answer({ ok: true, content: 'x', binary: true });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
    answer({ ok: true, content: 'x', sizeBytes: 50 * 1024 * 1024 });
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
    answer({ ok: true, content: 'x', sizeBytes: 1 });
    await expect(draftFileEditable('/p', { ...artifact, id: 'a.png', path: 'a.png' })).resolves.toBe(false);
    await expect(draftFileEditable('/p', { ...artifact, id: '.git/config', path: '.git/config' })).resolves.toBe(false);
    (window as unknown as { claude: unknown }).claude = { artifacts: { get: vi.fn(async () => { throw new Error('x'); }) } };
    await expect(draftFileEditable('/p', artifact)).resolves.toBe(false);
  });
});
