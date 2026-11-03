// Floating menus and popovers opened by click steps (`open:`) rather than by a switch in the app:
// the filter lists inside the Resume browser. Added for the "what changed since
// the last release" comparison, which needs every visible part photographed.
import type { ScreenEntry } from './types';

const chat = (name: string, ...tags: string[]): ScreenEntry => ({ name, tags: ['chat', ...tags] });

export const FLOATING: readonly ScreenEntry[] = [
  // The Resume browser's "all projects" and "tags" pick-any lists.
  { ...chat('chat/resume#projects-filter', 'dialog', 'popover'), open: [{ do: 'click', target: { role: 'button', label: 'Projects' } }] },
  { ...chat('chat/resume#tags-filter', 'dialog', 'popover'), open: [{ do: 'click', target: { role: 'button', label: 'Tags' } }] },

  // Dropdown lists (Select / TypeableSelect): the marketplace "Show" filter and Settings -> General's Step guard.
  { name: 'marketplace/skills#show-menu', tags: ['marketplace', 'view', 'popover'], open: [{ do: 'click', target: { role: 'button', label: 'Show' } }] },
  { name: 'settings/assistant/general#step-guard-open', tags: ['settings', 'dialog', 'popover'], open: [{ do: 'click', target: { role: 'combobox', label: 'Step guard' } }] },
  // NOT listed: the project header's sync menu and phone cog menu. Escape there closes the menu AND the whole Project panel, so
  // `shoot --check`'s "Escape closes only the top layer" fails (an app behaviour, a user-visible change to fix first).
  // Spreadsheet right-click menu, and a hover tip.
  { name: 'chat/files/open/a-q3-sales-comments#cell-menu', tags: ['chat', 'pane', 'viewer', 'menu'], open: [{ do: 'right-click', target: { role: 'clickable', labelStarts: 'A B C D E F G H I J K L', nth: 1 } }] },
  { name: 'chat#gear-tooltip', tags: ['chat', 'popover'], open: [{ do: 'hover', target: { role: 'button', label: 'Settings' } }] },
  // Comments: the hover card over a highlighted passage, and the open comments list over a sheet.
  { name: 'chat/files/open/a-launch-brief#highlight-card', tags: ['chat', 'pane', 'viewer', 'popover'], open: [{ do: 'hover', target: { role: 'clickable', labelStarts: 'Beta opens to 500 customers' } }] },
  { name: 'chat/files/open/a-q3-sales-comments#comments-open', tags: ['chat', 'pane', 'viewer'], open: [{ do: 'click', target: { role: 'button', label: 'Comments 3' } }] },
  // (The browser page's right-click menu is skipped: the practice browser draws no page picture to click.)
  // Another hover tip: the status bar's tags chip.
  { name: 'chat#tags-chip-tooltip', tags: ['chat', 'popover'], open: [{ do: 'hover', target: { role: 'button', labelStarts: 'Tags & note' } }] },
];
