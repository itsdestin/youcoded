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

function mount(onDeleteProject = vi.fn(), activeId = '/p/app') {
  render(
    <ProjectSwitcher
      projects={projects}
      activeId={activeId}
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

  it('has no marker for the project you are in: the highlight rests on it and follows the pointer', () => {
    mount(vi.fn(), '/p/notes'); // not the first row, so resting there is a real choice
    const box = (n: string) => rowOf(n).parentElement!;
    expect(rowOf('notes').getAttribute('aria-current')).toBe('true'); // screen readers still know
    expect(screen.queryByLabelText('Current project')).toBeNull();
    expect(box('notes').className).toMatch(/border-accent/);
    fireEvent.mouseEnter(box('themes'));
    expect(box('themes').className).toMatch(/border-accent/);
    expect(box('notes').className).not.toMatch(/border-accent/);
    fireEvent.mouseLeave(box('themes').parentElement!);
    expect(box('notes').className).toMatch(/border-accent/);
  });

  it('only one row ever looks highlighted: the highlight and the bin come from one state, never CSS hover', () => {
    // Found with explore: pointer resting on "recipes", then ArrowUp — the keys moved the
    // highlight to the row above while CSS :hover kept "recipes" tinted with its bin, so two
    // rows were lit. Any hover-driven class on a row or a bin brings that back.
    mount();
    const box = (n: string) => rowOf(n).parentElement!;
    const bin = (n: string) => screen.getByRole('button', { name: `Remove ${n} from your projects`, hidden: true });
    for (const n of ['app', 'themes', 'notes', 'thesis']) {
      expect(box(n).className).not.toMatch(/(^|\s)hover:/);
      expect(bin(n).className).not.toMatch(/group-hover:/);
    }
    fireEvent.mouseEnter(box('themes'));
    fireEvent.mouseEnter(box('notes'));
    const lit = ['app', 'themes', 'notes', 'thesis'].filter((n) => /border-accent/.test(box(n).className));
    const bins = ['app', 'themes', 'notes', 'thesis'].filter((n) => /(^|\s)inline-flex(\s|$)/.test(bin(n).className));
    expect(lit).toEqual(['notes']);
    expect(bins).toEqual(['notes']);
    fireEvent.mouseLeave(box('notes').parentElement!);
    expect(['app', 'themes', 'notes', 'thesis'].filter((n) => /border-accent/.test(box(n).className))).toEqual(['app']);
    expect(['app', 'themes', 'notes', 'thesis'].filter((n) => /(^|\s)inline-flex(\s|$)/.test(bin(n).className))).toEqual([]);
  });

  it('says when a folder is missing', () => {
    mount();
    expect(within(rowOf('thesis')).getByText('Folder missing')).toBeTruthy();
  });

  it('every row has a Remove — synced projects included — shown only where the pointer is', () => {
    const onDelete = mount();
    const bin = (n: string) => screen.getByRole('button', { name: `Remove ${n} from your projects`, hidden: true });
    for (const n of ['app', 'themes', 'notes', 'thesis']) expect(bin(n)).toBeTruthy();
    // Resting on the project you are in, the bin stays hidden there (display:none, no space).
    expect(bin('app').className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.mouseEnter(rowOf('themes').parentElement!);
    expect(bin('themes').className).toMatch(/(^|\s)inline-flex(\s|$)/);
    fireEvent.click(bin('themes'));
    expect(onDelete).toHaveBeenCalledWith(projects[1]);
  });

  it('shows the counts as a summary: bold number, grey word', () => {
    mount();
    const counts = within(rowOf('notes')).getByText((_, el) => el?.getAttribute('data-counts') === '' && /21\s*files\s*·\s*5\s*chats/.test(el.textContent ?? ''));
    expect(counts.querySelector('b')?.textContent).toBe('21');
  });
});
