// @vitest-environment jsdom
// Card #134 round 4: in "+ Add file" a file whose import call REJECTS becomes its own line in the result dialog, and the other
// files in the batch still show their outcome (before, one rejection aborted the whole batch and said nothing).
// The real ProjectView is rendered (same harness as project-lists-load-failure.test.tsx).
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { folderPageFromRecords } from '../src/shared/artifacts/folder-page';
import { ProjectView } from '../src/renderer/components/project-view/ProjectView';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { DESKTOP_WINDOW_CAPABILITIES } from '../src/shared/capabilities';

vi.mock('../src/renderer/components/ScreenBand', () => ({ ScreenBand: () => null }));

const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;

function setup(paths: string[], importFile: (root: string, src: string) => Promise<unknown>) {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  (window as any).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); // wide viewport: the toolbar shows "+ Add file" inline
  (window as any).claude = {
    capabilities: DESKTOP_WINDOW_CAPABILITIES,
    dialog: { openFile: vi.fn().mockResolvedValue(paths) },
    artifacts: {
      listAllFiles: () => Promise.resolve({ ok: true, files: [] }),
      listFolder: (_id: string, dir: string, opts: any) => Promise.resolve(folderPageFromRecords([] as any, dir, opts)),
      listProjectsIndex: () => Promise.resolve({ ok: true, projects: [project] }),
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
      importFile: vi.fn(importFile),
    },
    project: { listConversations: () => Promise.resolve({ ok: true, conversations: [] }), listContext: () => Promise.resolve({ ok: true, groups: [] }), repoInfo: () => Promise.resolve(null) },
    syncSpaces: { status: () => Promise.reject(new Error('no sync in tests')), onEvent: () => () => {} },
    tags: { list: () => Promise.resolve([]) },
    on: {},
  };
}

function Harness() {
  const [state] = useState<any>({ projectViewOpen: true, activeArtifactBySession: {} });
  const [dispatch] = useState(() => vi.fn());
  const value = React.useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return (
    <ArtifactProvider value={value}>
      <ProjectView onNewConversation={vi.fn()} onResumeConversation={vi.fn() as any} settingsOpen={false} onToggleSettings={vi.fn()} />
    </ArtifactProvider>
  );
}

afterEach(() => { cleanup(); delete (window as any).claude; vi.restoreAllMocks(); });

async function runImport() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: '+ Add file' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
}

describe('Add file: result dialog', () => {
  it('a rejected file is its own line, and the other files still show their outcome', async () => {
    setup(['/home/u/a.txt', '/home/u/b.txt', '/home/u/c.txt'], async (_root, src) => {
      if (src.endsWith('b.txt')) throw new Error('disk full');
      if (src.endsWith('c.txt')) return { ok: false, error: 'EACCES', detail: 'permission denied' };
      return { ok: true };
    });
    await runImport();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Import failed');
    expect(dialog).toHaveTextContent('b.txt — disk full');
    expect(dialog).toHaveTextContent('c.txt — EACCES: permission denied');
    expect(dialog).not.toHaveTextContent('a.txt'); // the file that worked adds no line
    expect((window as any).claude.artifacts.importFile).toHaveBeenCalledTimes(3); // the rejection did not stop the batch
  });
  it('a batch where every file works shows no result dialog', async () => {
    setup(['/home/u/a.txt', '/home/u/b.txt'], async () => ({ ok: true }));
    await runImport();
    await vi.waitFor(() => expect((window as any).claude.artifacts.importFile).toHaveBeenCalledTimes(2));
    // The pick dialog closing is the signal the batch finished.
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
