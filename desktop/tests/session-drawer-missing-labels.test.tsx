// @vitest-environment jsdom
// The Files drawer never claims a file was deleted when all it knows is that
// nothing is at the saved location (2026-09-11). A record whose last event IS
// a delete still reads "deleted"; a file the on-disk check cannot find reads
// "not found". And a chat whose files are all hidden as missing says so,
// instead of "Nothing here yet".
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { __resetMissingArtifactsCache } from '../src/renderer/hooks/useMissingArtifacts';
import type { ArtifactRecord } from '../src/shared/artifacts/types';

const theme = vi.hoisted(() => ({ showDeleted: false, setShowDeleted: null as any }));
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({
    hideCodeAndConfigs: false,
    setHideCodeAndConfigs: () => {},
    showDeletedArtifacts: theme.showDeleted,
    setShowDeletedArtifacts: theme.setShowDeleted,
    drawerWidth: 420,
    setDrawerWidth: () => {},
    resetDrawerWidth: () => {},
  }),
}));

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

const SESSION = 's1';
const ROOT = '/home/u/proj';

(window as any).matchMedia = (window as any).matchMedia || ((q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
  addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
}));

afterEach(() => { cleanup(); __resetMissingArtifactsCache(); });

function rec(id: string, name: string, extra: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id, path: name, kind: 'internal', absolutePath: null,
    lastModified: new Date().toISOString(), status: 'active',
    versions: [{ id: `v-${id}`, ts: new Date().toISOString(), sessionId: SESSION, type: 'edit', author: 'agent' }],
    comments: [], tags: [], ...extra,
  };
}

function mount(artifacts: ArtifactRecord[], missingIds: string[]) {
  (window as any).claude = {
    artifacts: {
      get: vi.fn(),
      listSession: vi.fn().mockResolvedValue({ ok: true, artifacts }),
      checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds }),
    },
    tags: { list: vi.fn().mockResolvedValue([]) },
  };
  const state = {
    ...initialArtifactState,
    sessionArtifacts: { [SESSION]: artifacts },
    drawerOpenBySession: { [SESSION]: true },
    activeArtifactBySession: {},
  };
  return render(
    <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <SessionDrawer sessionId={SESSION} projectRoot={ROOT} cwd={ROOT} projectId="p" projectName="proj" />
    </ArtifactContext.Provider>,
  );
}

describe('SessionDrawer — missing files are described honestly', () => {
  it('labels a file the check cannot find "not found", and keeps "deleted" for a real delete', async () => {
    theme.showDeleted = true;
    theme.setShowDeleted = vi.fn();
    const { container } = mount(
      [rec('a', 'moved.md'), rec('b', 'removed.md', { status: 'deleted' })],
      ['a'],
    );
    await waitFor(() => expect(container.querySelectorAll('.text-3xs').length).toBe(2));
    const labels = [...container.querySelectorAll('.text-3xs')].map((el) => el.textContent ?? '');
    expect(labels.some((l) => /^not found · /.test(l))).toBe(true);
    expect(labels.some((l) => /^deleted · /.test(l))).toBe(true);
  });

  it('says how many files are not where they were saved — not "Nothing here yet" — and offers to show them', async () => {
    theme.showDeleted = false;
    theme.setShowDeleted = vi.fn();
    const { findByText, queryByText } = mount([rec('a', 'one.md'), rec('b', 'two.md')], ['a', 'b']);
    expect(await findByText(/2 files from this chat aren.t where they were saved/)).toBeTruthy();
    expect(queryByText(/Nothing here yet/)).toBeNull();
    fireEvent.click(await findByText('Show them'));
    expect(theme.setShowDeleted).toHaveBeenCalledWith(true);
  });
});
