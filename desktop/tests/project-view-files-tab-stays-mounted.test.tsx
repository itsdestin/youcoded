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
// WHY half 2 is not in this file (Plan B, 2026-09-16): it read ProjectView.tsx as
// text; it is the ast-grep rule filestab-mounted-with-hidden-prop now
// (youcoded-dev scripts/ast-grep/rules/). Half 1 is the case below.
//
// The redraw cases below (render-cost consolidation, 2026-09-18) pin the other
// half of keeping it mounted: a HIDDEN tab must not redraw. It holds up to
// 2,000 cards, and two things used to redraw all of them — every Project View
// render (each tab click) handing it fresh inline callbacks, and its own read
// of the app-wide file state, which changes on every file any session writes.
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';
import { folderPageFromRecords } from '../src/shared/artifacts/folder-page';
import { ProjectView } from '../src/renderer/components/project-view/ProjectView';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';

// WHY the counter lives on useProjectWatch: FilesTab calls it unconditionally
// at the top of its body, so every call is one render of the REAL component.
// A counter wrapped around FilesTab from outside would sit outside its memo
// boundary and never see a render driven by a context FilesTab reads itself —
// the exact regression the second case guards. Nothing else Project View
// renders calls this hook.
const probe = vi.hoisted(() => ({ filesTabRenders: 0 }));
vi.mock('../src/renderer/hooks/useProjectWatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/hooks/useProjectWatch')>();
  return {
    useProjectWatch: (...args: Parameters<typeof actual.useProjectWatch>) => {
      probe.filesTabRenders++;
      return actual.useProjectWatch(...args);
    },
  };
});
// The band across the top is the app's shared header (settings gear, pinned
// pages); it has nothing to do with the Files tab and needs app-level state.
vi.mock('../src/renderer/components/ScreenBand', () => ({ ScreenBand: () => null }));

const listAllFiles = vi.fn();
// Folder browsing reads one folder at a time (artifacts:list-folder, Stage 1
// 2026-09-18); the whole-project list is only fetched for a search.
const listFolder = vi.fn();

const FILES = [
  { id: 'f1', kind: 'internal', path: 'notes.md', lastModified: new Date().toISOString() },
];
const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;

function renderTab(hidden: boolean) {
  return render(
    <FilesTab
      project={project}
      search=""
      types={new Set()}
      sortBy="name"
      view="list"
      onViewChange={vi.fn()}
      refreshKey={0}
      hidden={hidden}
      pvActiveId={null}
      artifactDispatch={vi.fn()}
    />,
  );
}

beforeEach(() => {
  probe.filesTabRenders = 0;
  (globalThis as any).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  listAllFiles.mockResolvedValue({ ok: true, files: FILES });
  listFolder.mockImplementation((_id: string, dir: string, opts: any) => Promise.resolve(folderPageFromRecords(FILES as any, dir, opts)));
  (window as any).claude = {
    artifacts: {
      listAllFiles,
      listFolder,
      listProjectsIndex: () => Promise.resolve({ ok: true, projects: [project] }),
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
    },
    project: {
      listConversations: () => Promise.resolve({ ok: true, conversations: [] }),
      listContext: () => Promise.resolve({ ok: true, groups: [] }),
      repoInfo: () => Promise.resolve(null),
    },
    syncSpaces: {
      status: () => Promise.reject(new Error('no sync in tests')),
      onEvent: () => () => {},
    },
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// A REAL ArtifactProvider whose value the test controls, the way App's reducer
// would: `dispatch` is stable (useReducer's is), `state` is replaced wholesale.
let setArtifactState: (s: any) => void = () => {};
let harnessDispatch: ReturnType<typeof vi.fn> = vi.fn();
function Harness() {
  const [state, setState] = useState<any>({ projectViewOpen: true, activeArtifactBySession: {} });
  setArtifactState = setState;
  const [dispatch] = useState(() => vi.fn());
  harnessDispatch = dispatch;
  const value = React.useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return (
    <ArtifactProvider value={value}>
      <ProjectView
        onNewConversation={vi.fn()}
        onResumeConversation={vi.fn() as any}
        settingsOpen={false}
        onToggleSettings={vi.fn()}
      />
    </ArtifactProvider>
  );
}

describe('hidden FilesTab does not re-render', () => {
  it('stays still while other tabs are clicked', async () => {
    const view = render(<Harness />);
    await view.findByTitle('notes.md');
    fireEvent.click(view.getByRole('button', { name: 'Conversations' }));
    // Switching away flips `hidden`, which is a real prop change — one render
    // is expected there. Measure from after that commit.
    const afterSwitch = probe.filesTabRenders;
    fireEvent.click(view.getByRole('button', { name: 'Instructions & Memories' }));
    fireEvent.click(view.getByRole('button', { name: 'Conversations' }));
    expect(probe.filesTabRenders).toBe(afterSwitch);
  });

  it('stays still when another session writes a file', async () => {
    const view = render(<Harness />);
    await view.findByTitle('notes.md');
    fireEvent.click(view.getByRole('button', { name: 'Conversations' }));
    const before = probe.filesTabRenders;
    // What another session's file write looks like from here: a new state
    // object, a new per-session map, and Project View's own entry unchanged.
    act(() => {
      setArtifactState((s: any) => ({
        ...s,
        activeArtifactBySession: { ...s.activeArtifactBySession, 'some-other-session': 'x1' },
      }));
    });
    expect(probe.filesTabRenders).toBe(before);
  });
});

describe('Files tab survives a tab switch', () => {
  it('hides on `hidden` without refetching the file list', async () => {
    const { container, rerender, findByTitle } = renderTab(false);
    await findByTitle('notes.md');
    expect(listFolder).toHaveBeenCalledTimes(1);
    // Browsing never waits on the whole-project walk.
    expect(listAllFiles).not.toHaveBeenCalled();

    // Stable callbacks, as ProjectView passes them.
    const onViewChange = vi.fn();
    const artifactDispatch = vi.fn();
    const shown = (h: boolean) => (
      <FilesTab project={project} search="" types={new Set()} sortBy="name" view="list"
        onViewChange={onViewChange} refreshKey={0} hidden={h}
        pvActiveId={null} artifactDispatch={artifactDispatch} />
    );
    rerender(shown(true));    // → Conversations
    // Hidden means display:none, NOT gone: the rows are still in the DOM, so the
    // watcher subscription and the loaded list are still alive.
    expect(container.firstElementChild?.className).toBe('hidden');
    expect(container.querySelector('button[title="notes.md"]')).not.toBeNull();

    rerender(shown(false));   // → back to Files
    await waitFor(() => expect(container.firstElementChild?.className).not.toBe('hidden'));
    // The one call from the first mount, and no more.
    expect(listFolder).toHaveBeenCalledTimes(1);
  });
});

describe('opening a file from the Files tab', () => {
  it('asks the app to open it, and shows it once the app has', async () => {
    // FilesTab no longer reads the app-wide file state itself: Project View hands
    // it the open file's id and the dispatch. Both ends of that hand-off, together.
    const view = render(<Harness />);
    fireEvent.click(await view.findByTitle('notes.md'));
    expect(harnessDispatch).toHaveBeenCalledWith({ type: 'ACTIVE_ARTIFACT_SET', sessionId: 'project-view', artifactId: 'f1' });
    expect(view.queryByTitle('Open with the default app')).toBeNull();
    // What App's reducer does with that action.
    act(() => {
      setArtifactState((st: any) => ({ ...st, activeArtifactBySession: { ...st.activeArtifactBySession, 'project-view': 'f1' } }));
    });
    expect(await view.findByTitle('Open with the default app')).toBeTruthy();
  });
});

// "+ Add file" over remote access uploaded the picked file to the computer, then the import
// failed (the host has no import channel for a phone). The button is not offered there until
// uploads are their own approved batch; the desktop keeps it.
describe('"+ Add file" is offered on the computer only', () => {
  it('shows on the desktop and is absent over remote access', async () => {
    const { setConnectionMode } = await import('../src/renderer/platform');
    const desk = render(<Harness />);
    await desk.findByTitle('notes.md');
    expect(desk.queryByRole('button', { name: '+ Add file' })).not.toBeNull();
    desk.unmount();
    setConnectionMode('remote');
    try {
      const phone = render(<Harness />);
      await phone.findByTitle('notes.md');
      expect(phone.queryByRole('button', { name: '+ Add file' })).toBeNull();
    } finally {
      setConnectionMode('local');
    }
  });
});
