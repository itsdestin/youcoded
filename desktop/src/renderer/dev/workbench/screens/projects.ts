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
  pr('projects/add', 'dialog'),
];
