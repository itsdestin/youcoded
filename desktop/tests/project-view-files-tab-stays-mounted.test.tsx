// @vitest-environment jsdom
// Pins the tab-thrash fix (perf-lab 2026-09-09): clicking Files → Conversations
// → Files in Project View must NOT rebuild the Files tab.
//
// Before this, ProjectView rendered `tab === 'files' && <FilesTab …>`, so every
// switch away unmounted the tab and every switch back re-ran the file list AND
// dropped the main-process project watcher — whose rebuild re-walks the whole
// project tree on the main thread. Eight rapid clicks cost 7.2-8.0 s of
// main-process stall on a workspace-sized folder, worst single freeze 338 ms.
//
// Two halves, because one alone would pass while the bug is back:
//   1. FilesTab honours `hidden` by hiding, not by unmounting or refetching.
//   2. ProjectView actually passes it, instead of conditionally mounting.
import React from 'react';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';

const listAllFiles = vi.fn();

const FILES = [
  { id: 'f1', kind: 'internal', path: 'notes.md', lastModified: new Date().toISOString() },
];
const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;

function renderTab(hidden: boolean) {
  return render(
    <ArtifactProvider value={{ state: { activeArtifactBySession: {} } as any, dispatch: vi.fn() }}>
      <FilesTab
        project={project}
        search=""
        types={new Set()}
        sortBy="name"
        view="list"
        onViewChange={vi.fn()}
        refreshKey={0}
        hidden={hidden}
      />
    </ArtifactProvider>,
  );
}

beforeEach(() => {
  (globalThis as any).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  listAllFiles.mockResolvedValue({ ok: true, files: FILES });
  (window as any).claude = {
    artifacts: {
      listAllFiles,
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
    },
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Files tab survives a tab switch', () => {
  it('hides on `hidden` without refetching the file list', async () => {
    const { container, rerender, findByTitle } = renderTab(false);
    await findByTitle('notes.md');
    expect(listAllFiles).toHaveBeenCalledTimes(1);

    const shown = (h: boolean) => (
      <ArtifactProvider value={{ state: { activeArtifactBySession: {} } as any, dispatch: vi.fn() }}>
        <FilesTab project={project} search="" types={new Set()} sortBy="name" view="list"
          onViewChange={vi.fn()} refreshKey={0} hidden={h} />
      </ArtifactProvider>
    );
    rerender(shown(true));    // → Conversations
    // Hidden means display:none, NOT gone: the rows are still in the DOM, so the
    // watcher subscription and the loaded list are still alive.
    expect(container.firstElementChild?.className).toBe('hidden');
    expect(container.querySelector('button[title="notes.md"]')).not.toBeNull();

    rerender(shown(false));   // → back to Files
    await waitFor(() => expect(container.firstElementChild?.className).not.toBe('hidden'));
    // The one call from the first mount, and no more.
    expect(listAllFiles).toHaveBeenCalledTimes(1);
  });

  it('ProjectView mounts FilesTab unconditionally and hands it `hidden`', () => {
    // A rendering test for ProjectView would need the whole app shell mocked;
    // the invariant that matters is one line at the call site, so read it. If
    // FilesTab goes back behind `tab === 'files' &&`, the hook above still
    // passes while the stall is fully restored.
    const src = fs.readFileSync(
      path.join(__dirname, '../src/renderer/components/project-view/ProjectView.tsx'), 'utf8',
    );
    const call = src.match(/<FilesTab[\s\S]*?\/>/);
    expect(call, '<FilesTab> not found in ProjectView.tsx').toBeTruthy();
    expect(call![0]).toContain("hidden={tab !== 'files'}");
    // The conditional-mount form, in any spacing.
    expect(src).not.toMatch(/tab\s*===\s*'files'\s*&&\s*\(?\s*<FilesTab/);
  });
});
