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
  // state per open choice (components/project-view/switcher-variants.ts).
  { ...pr('projects/switcher#many', 'dialog'), params: { projects: 'many' } },
  { ...pr('projects/switcher#counts-chips', 'dialog'), params: { switcherCounts: 'chips' } },
  { ...pr('projects/switcher#counts-none', 'dialog'), params: { switcherCounts: 'none' } },
  { ...pr('projects/switcher#current-fill', 'dialog'), params: { switcherCurrent: 'fill' } },
  { ...pr('projects/switcher#current-top', 'dialog'), params: { switcherCurrent: 'top' } },
  { ...pr('projects/switcher#remove-hover', 'dialog'), params: { switcherRemove: 'hover' } },
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
