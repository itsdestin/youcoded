// Projects: the three tabs and every overlay they open.
import type { ScreenEntry } from './types';

const pr = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['projects', ...tags] });

export const PROJECTS: readonly ScreenEntry[] = [
  { ...pr('projects/files', 'view'), sameAs: { name: 'projects', why: 'Projects opens on its Files tab' } },
  pr('projects/files/filter', 'popover'),
  pr('projects/conversations', 'view'),
  pr('projects/conversations/preview', 'dialog'),
  pr('projects/context', 'view'),
  pr('projects/context/editor', 'dialog'),
  pr('projects/context/how', 'dialog'),
  pr('projects/switcher', 'dialog'),
  // Project switcher redesign (backlog row 10): a long list with a missing folder, and one
  // state per open choice (`workbenchSwitcherCurrent` in workbench-mode.ts).
  { ...pr('projects/switcher#many', 'dialog'), params: { projects: 'many' } },
  // `#pointed`: the keyboard highlight moved to the second row, so the project you are in
  // shows its own marking (not the highlight on top of it) and the bin shows on another row.
  { ...pr('projects/switcher#pointed', 'dialog'), open: [{ do: 'key', key: 'ArrowDown' }] },
  { ...pr('projects/switcher#current-edge', 'dialog'), params: { switcherCurrent: 'edge' }, open: [{ do: 'key', key: 'ArrowDown' }] },
  { ...pr('projects/switcher#current-subtext', 'dialog'), params: { switcherCurrent: 'subtext' }, open: [{ do: 'key', key: 'ArrowDown' }] },
  // The Remove confirm, one per wording: a plain folder, a synced project, a missing folder.
  pr('projects/remove', 'dialog'),
  pr('projects/remove/synced', 'dialog'),
  { ...pr('projects/remove/missing', 'dialog'), params: { projects: 'many' } },
  pr('projects/add', 'dialog'),
  // The hero's "Turn on sync" consent modal — shared with `projects/add`'s own
  // move step (AddProjectModal), reached only by clicking through there.
  pr('projects/turn-on-sync', 'dialog'),
  pr('projects/files/folder/docs', 'view'),
  { ...pr('projects/files/folder/Locked', 'view', 'error-state'), params: { filesLocked: '1' } },
];
