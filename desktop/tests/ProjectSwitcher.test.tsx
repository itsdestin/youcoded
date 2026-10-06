// @vitest-environment jsdom
// Redesign backlog row 10 — Destin on the project switcher: "the checkmarks and such are odd
// here, and there's no way to delete some projects currently", then "want to change how the
// file/chat numbers are displayed. and how sync appears. should probably be a status like the
// working/inactive/etc chips in session swithcer. and a remove icon somewhere."
// These pin the shipped draft: sync is a named pill (not a bare dot), the project you are in
// is a "Current" pill (no check mark), every row — synced ones too — has a visible Remove, and
// a project whose folder is gone says so.
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSwitcher } from '../src/renderer/components/project-view/ProjectSwitcher';
import type { CentralIndexProject } from '../src/shared/artifacts/types';
import type { SyncStatusData } from '../src/renderer/components/sync-dot-state';

const proj = (name: string, path: string, extra: Partial<CentralIndexProject> = {}): CentralIndexProject => ({
  id: path, name, path, lastIndexed: '', lastSession: null, contentTypes: [], stats: { artifactCount: 0 },
  fileCount: 21, conversationCount: 5, ...extra,
});

const projects = [
  proj('app', '/p/app'),
  proj('themes', '/p/themes'),
  proj('notes', '/p/notes'),
  proj('thesis', '/p/thesis', { missing: true }),
];

const sync: SyncStatusData = {
  enabled: true,
  spaces: [
    { id: 'project:app', root: '/p/app', state: 'active', kind: 'project', remote: 'r', lastSyncAt: 1 },
    { id: 'project:themes', root: '/p/themes', state: 'active', kind: 'project', remote: 'r', lastSyncAt: 1 },
  ],
  recentEvents: [{ type: 'error', spaceId: 'project:themes', message: 'nope' }],
};

function mount(onDeleteProject = vi.fn()) {
  render(
    <ProjectSwitcher
      projects={projects}
      activeId="/p/app"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onAddProject={vi.fn()}
      onDeleteProject={onDeleteProject}
      syncStatus={sync}
    />,
  );
  return onDeleteProject;
}

const rowOf = (name: string) => screen.getByText(name, { selector: 'span' }).closest('button') as HTMLElement;

describe('project switcher rows', () => {
  it('shows sync as a named status pill on each row', () => {
    mount();
    expect(within(rowOf('app')).getByText('Synced')).toBeTruthy();
    expect(within(rowOf('themes')).getByText('Sync problem')).toBeTruthy();
    expect(within(rowOf('notes')).getByText('Not synced')).toBeTruthy();
  });

  it('marks the project you are in beside its name, without tinting its row', () => {
    mount();
    expect(within(rowOf('app')).getByLabelText('Current project')).toBeTruthy();
    expect(within(rowOf('themes')).queryByLabelText('Current project')).toBeNull();
    expect(rowOf('app').parentElement!.className).not.toMatch(/bg-accent/);
  });

  it('says when a folder is missing', () => {
    mount();
    expect(within(rowOf('thesis')).getByText('Folder missing')).toBeTruthy();
  });

  it('every row has a Remove — synced projects included — shown only on the pointed row', () => {
    const onDelete = mount();
    for (const n of ['app', 'themes', 'notes', 'thesis']) {
      expect(screen.getByRole('button', { name: `Remove ${n} from your projects`, hidden: true })).toBeTruthy();
    }
    // Hidden rows take no space (display:none, not transparent) so the pills sit flush right.
    expect(screen.getByRole('button', { name: 'Remove themes from your projects', hidden: true }).className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole('button', { name: 'Remove app from your projects' }).className).toMatch(/(^|\s)inline-flex(\s|$)/); // the highlighted row
    fireEvent.click(screen.getByRole('button', { name: 'Remove themes from your projects', hidden: true }));
    expect(onDelete).toHaveBeenCalledWith(projects[1]);
  });

  it('shows the counts as a summary: bold number, grey word', () => {
    mount();
    const counts = within(rowOf('notes')).getByText((_, el) => el?.getAttribute('data-counts') === '' && /21\s*files\s*·\s*5\s*chats/.test(el.textContent ?? ''));
    expect(counts.querySelector('b')?.textContent).toBe('21');
  });
});
