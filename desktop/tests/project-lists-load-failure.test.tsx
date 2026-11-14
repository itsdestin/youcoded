// @vitest-environment jsdom
// WHY (error inventory 2026-09-10, Projects row 8): a failed read of a project's conversations or
// context files used to be turned into an empty list, so the tabs said "No conversations in this
// project yet." / "No context files found for this project." - false. They now say it could not load.
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { folderPageFromRecords } from '../src/shared/artifacts/folder-page';
import { ProjectView } from '../src/renderer/components/project-view/ProjectView';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { isRemoteMode } from '../src/renderer/platform';
import { DESKTOP_WINDOW_CAPABILITIES, REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';


vi.mock('../src/renderer/components/ScreenBand', () => ({ ScreenBand: () => null }));

const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;

function setup(listConversations: any, listContext: any) {
  (globalThis as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  (window as any).claude = {
    get capabilities() { return isRemoteMode() ? REMOTE_SCREEN_CAPABILITIES : DESKTOP_WINDOW_CAPABILITIES; },
    artifacts: {
      listAllFiles: () => Promise.resolve({ ok: true, files: [] }),
      listFolder: (_id: string, dir: string, opts: any) => Promise.resolve(folderPageFromRecords([] as any, dir, opts)),
      listProjectsIndex: () => Promise.resolve({ ok: true, projects: [project] }),
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
      searchContent: () => Promise.resolve({ ok: true, hits: [] }),
    },
    project: { listConversations, listContext, repoInfo: () => Promise.resolve(null) },
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Project View when a list will not load', () => {
  it('Conversations: says it could not load, with the reason and Try again, which re-reads', async () => {
    const listConversations = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'transcripts folder unreadable' })
      .mockResolvedValue({ ok: true, conversations: [] });
    setup(listConversations, () => Promise.resolve({ ok: true, groups: [] }));
    const view = render(<Harness />);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    fireEvent.click(await view.findByRole('button', { name: 'Conversations' }));
    expect(await view.findByText(/Couldn.t load this project.s conversations: transcripts folder unreadable/)).toBeTruthy();
    expect(view.queryByText('No conversations in this project yet.')).toBeNull();
    await act(async () => { fireEvent.click(view.getByText('Try again')); });
    await waitFor(() => expect(view.getByText('No conversations in this project yet.')).toBeTruthy());
    expect(listConversations).toHaveBeenCalledTimes(2);
  });

  it('Instructions & memories: says it could not load instead of "No context files found"', async () => {
    const listContext = vi.fn()
      .mockRejectedValueOnce(new Error('context read failed'))
      .mockResolvedValue({ ok: true, groups: [] });
    setup(() => Promise.resolve({ ok: true, conversations: [] }), listContext);
    const view = render(<Harness />);
    await waitFor(() => expect(listContext).toHaveBeenCalled());
    fireEvent.click(await view.findByRole('button', { name: 'Instructions & memories' }));
    expect(await view.findByText(/Couldn.t load this project.s context files: context read failed/)).toBeTruthy();
    expect(view.queryByText('No context files found for this project.')).toBeNull();
    await act(async () => { fireEvent.click(view.getByText('Try again')); });
    await waitFor(() => expect(view.getByText('No context files found for this project.')).toBeTruthy());
  });

  // Card #134 round 4: the project list itself failing used to leave "Select a project to view its artifacts." with no hint.
  it('Project list: says it could not load with Try again, which re-reads and clears the notice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setup(() => Promise.resolve({ ok: true, conversations: [] }), () => Promise.resolve({ ok: true, groups: [] }));
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('index unreadable'))
      .mockResolvedValue({ ok: true, projects: [project] });
    (window as any).claude.artifacts.listProjectsIndex = list;
    const view = render(<Harness />);
    expect(await view.findByText("Couldn't load your projects.")).toBeTruthy();
    expect(view.queryByText('Select a project to view its artifacts.')).toBeNull();
    await act(async () => { fireEvent.click(view.getByText('Try again')); });
    await waitFor(() => expect(view.queryByText("Couldn't load your projects.")).toBeNull());
    expect(list).toHaveBeenCalled();
  });

  it('Project list: a list that loads shows no notice', async () => {
    setup(() => Promise.resolve({ ok: true, conversations: [] }), () => Promise.resolve({ ok: true, groups: [] }));
    const view = render(<Harness />);
    await waitFor(() => expect(view.getAllByText('Proj').length).toBeGreaterThan(0));
    expect(view.queryByText("Couldn't load your projects.")).toBeNull();
  });
});
