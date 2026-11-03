// Floating menus and popovers opened by click steps (`open:`) rather than by a switch in the app:
// the filter lists inside the Resume browser. Added for the "what changed since
// the last release" comparison, which needs every visible part photographed.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const FLOATING: readonly ScreenEntry[] = [
  // The Resume browser's "all projects" and "tags" pick-any lists.
  { ...chat('chat/resume#projects-filter', 'dialog', 'popover'), open: [{ do: 'click', target: { role: 'button', label: 'Projects' } }] },
  { ...chat('chat/resume#tags-filter', 'dialog', 'popover'), open: [{ do: 'click', target: { role: 'button', label: 'Tags' } }] },
];
